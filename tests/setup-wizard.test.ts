import assert from "node:assert/strict";
import { test } from "node:test";
import { planSetup, type SchemaProbe, type SetupProbe, type SetupService } from "../src/setup/core.js";
import { runSetupWizard, type WizardIO } from "../src/setup/wizard.js";

// A fake installation that becomes "done" step by step as the wizard acts on it.
function world(overrides: { schema?: SchemaProbe; signInFails?: boolean } = {}) {
  const state = {
    url: "", schema: overrides.schema ?? ({ state: "empty", pending: ["init"] } as SchemaProbe),
    replicas: [] as { id: string; name: string }[], key: "", signedIn: false, selection: undefined as string[] | undefined, synced: false,
  };
  const calls: string[] = [];
  const probe: SetupProbe = {
    database: async () => state.url ? { configured: true, reachable: true, display: "me@h/db", source: "saved" } : { configured: false },
    schema: async () => state.schema,
    replicas: async () => state.replicas,
    app: async () => ({ clientId: state.key || undefined, loginUrl: "https://login.salesforce.com", callbackUrl: "http://localhost:47123/oauth/callback" }),
    signedIn: async () => state.signedIn,
    selection: async () => state.selection,
    sync: async () => ({ ran: state.synced, succeeded: state.synced, objects: state.selection?.length ?? 0, matches: state.synced ? state.selection?.length ?? 0 : null }),
  };
  let notice: string | undefined;
  const setup: SetupService = {
    plan: async (id) => ({ ...(await planSetup(probe, id)), ...(notice && { notice }) }),
    needsSetup: async () => true,
    saveDatabase: async (url) => {
      if (!url.startsWith("postgresql://")) throw new Error("Use a postgresql:// URL.");
      calls.push("database"); state.url = url;
    },
    applySchema: async (confirm) => { calls.push(`schema ${confirm}`); state.schema = { state: "current" }; },
    createReplica: async (id, name) => { calls.push(`replica ${id} ${name}`); state.replicas.push({ id, name }); },
    saveApp: async (id, key) => { calls.push(`app ${id}`); state.key = key; },
    startSignIn: async (id) => {
      calls.push(`signin ${id}`);
      if (overrides.signInFails) notice = "Salesforce sign-in was declined or failed.";
      else state.signedIn = true;
      return { url: "https://login.salesforce.com/authorize" };
    },
    availableObjects: async () => [{ name: "Account", label: "Account", custom: false }, { name: "Task", label: "Task", custom: false }, { name: "Gap__c", label: "Gap", custom: true }],
    saveObjects: async (id, entities) => { calls.push(`objects ${id} ${entities.join(",")}`); state.selection = entities; },
  };
  return { setup, calls, runFirstSync: async (id: string) => { calls.push(`sync ${id}`); state.synced = true; } };
}

function script(answers: string[]) {
  const said: string[] = [];
  const asked: { question: string; secret: boolean }[] = [];
  const io: WizardIO = {
    say: (line) => { said.push(line); },
    ask: async (question, options) => {
      asked.push({ question, secret: Boolean(options?.secret) });
      if (!answers.length) throw new Error(`No scripted answer for: ${question}`);
      return answers.shift()!;
    },
  };
  return { io, said, asked };
}

const noWait = async () => {};

test("the wizard walks every step to a verified first sync", async () => {
  const w = world();
  const { io, said, asked } = script(["postgresql://me:pw@h/db", "", "Acme dev", "", "3MVG9aaaaaaaaaaaaaaaaaaaaa", "", "", "Account,Task", ""]);
  assert.equal(await runSetupWizard(io, { ...w, wait: noWait }), 0);
  assert.deepEqual(w.calls, ["database", "schema false", "replica acme-dev Acme dev", "app acme-dev", "signin acme-dev", "objects acme-dev Account,Task", "sync acme-dev"]);
  assert.equal(asked[0]?.secret, true, "the database URL is asked without echo");
  assert.ok(said.some((line) => line.includes("http://localhost:47123/oauth/callback")));
  assert.ok(said.some((line) => /custom ones: Gap__c/.test(line)));
  assert.match(said.at(-1) ?? "", /Setup is complete/);
});

test("a bad answer is explained and the same step is asked again", async () => {
  const w = world();
  const { io, said } = script(["mysql://nope", "postgresql://me:pw@h/db", "q"]);
  assert.equal(await runSetupWizard(io, { ...w, wait: noWait }), 0);
  assert.ok(said.includes("! Use a postgresql:// URL."));
  assert.deepEqual(w.calls, ["database"]);
  assert.match(said.at(-1) ?? "", /pick up where you left off/);
});

test("a populated database needs a backup confirmation before updates", async () => {
  const declined = world({ schema: { state: "pending", pending: ["b"], populated: true } });
  const first = script(["postgresql://me:pw@h/db", "n", "q"]);
  await runSetupWizard(first.io, { ...declined, wait: noWait });
  assert.ok(first.said.some((line) => /Back up the database first/.test(line)));
  assert.deepEqual(declined.calls, ["database"]);

  const confirmed = world({ schema: { state: "pending", pending: ["b"], populated: true } });
  const second = script(["postgresql://me:pw@h/db", "y", "q"]);
  await runSetupWizard(second.io, { ...confirmed, wait: noWait });
  assert.deepEqual(confirmed.calls, ["database", "schema true"]);
});

test("unknown objects are refused before anything is saved", async () => {
  const w = world();
  const { io, said } = script(["postgresql://me:pw@h/db", "", "Acme", "", "3MVG9aaaaaaaaaaaaaaaaaaaaa", "", "", "Acount", "q"]);
  await runSetupWizard(io, { ...w, wait: noWait });
  assert.ok(said.some((line) => /doesn't offer Acount/.test(line)));
  assert.ok(!w.calls.some((call) => call.startsWith("objects")));
});

test("a failed sign-in reports the reason", async () => {
  const w = world({ signInFails: true });
  const { io, said } = script(["postgresql://me:pw@h/db", "", "Acme", "", "3MVG9aaaaaaaaaaaaaaaaaaaaa", "", "", "q"]);
  await runSetupWizard(io, { ...w, wait: noWait });
  assert.ok(said.some((line) => /declined or failed/.test(line)));
});

test("input ending mid-setup stops cleanly instead of retrying", async () => {
  const w = world();
  const { InputClosed } = await import("../src/setup/wizard.js");
  const said: string[] = [];
  let asks = 0;
  const io: WizardIO = { say: (line) => { said.push(line); }, ask: async () => { asks++; throw new InputClosed(); } };
  assert.equal(await runSetupWizard(io, { ...w, wait: noWait }), 0);
  assert.equal(asks, 1);
  assert.match(said.at(-1) ?? "", /pick up where you left off/);
});
