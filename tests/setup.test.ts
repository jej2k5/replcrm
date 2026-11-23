import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleHandler } from "../src/console/handler.js";
import { processToken } from "../src/console/runs.js";
import {
  displayDatabaseUrl, planSetup, validateApp, validateDatabaseUrl, validateReplica,
  type SetupProbe, type SetupService,
} from "../src/setup/core.js";

function probe(overrides: Partial<SetupProbe> = {}): SetupProbe {
  return {
    database: async () => ({ configured: true, reachable: true, display: "me@localhost:5432/replcrm", source: "saved" }),
    schema: async () => ({ state: "current" }),
    replicas: async () => [{ id: "acme", name: "Acme" }],
    app: async () => ({ clientId: "3MVG9aaaaaaaaaaaaaaaaaaaaaaaa", loginUrl: "https://login.salesforce.com", callbackUrl: "http://localhost:47123/oauth/callback" }),
    signedIn: async () => true,
    selection: async () => ["Account", "Contact"],
    sync: async () => ({ ran: true, succeeded: true, objects: 2, matches: 2 }),
    ...overrides,
  };
}
const states = (plan: Awaited<ReturnType<typeof planSetup>>) => plan.steps.map((step) => `${step.id}:${step.state}`);

test("an unconfigured machine starts at the database and checks nothing after it", async () => {
  let asked = false;
  const plan = await planSetup(probe({ database: async () => ({ configured: false }), schema: async () => { asked = true; return { state: "current" }; } }));
  assert.deepEqual(states(plan), ["database:current", "schema:todo", "replica:todo", "app:todo", "signin:todo", "objects:todo", "sync:todo"]);
  assert.equal(asked, false);
  assert.equal(plan.complete, false);
});

test("an unreachable database says why without revealing the password", async () => {
  const plan = await planSetup(probe({ database: async () => ({ configured: true, reachable: false, display: "me@db:5432/x", source: "env", reason: "connection refused" }) }));
  assert.equal(plan.steps[0]?.state, "current");
  assert.match(plan.steps[0]?.detail ?? "", /me@db:5432\/x: connection refused/);
});

test("schema states route to the right next action", async () => {
  const empty = await planSetup(probe({ schema: async () => ({ state: "empty", pending: ["a"] }) }));
  assert.equal(empty.steps[1]?.state, "current");
  const populated = await planSetup(probe({ schema: async () => ({ state: "pending", pending: ["a", "b"], populated: true }) }));
  assert.match(populated.steps[1]?.detail ?? "", /2 schema updates.*back it up first/);
  const foreign = await planSetup(probe({ schema: async () => ({ state: "foreign", reason: "3 tables already in the public schema" }) }));
  assert.match(foreign.steps[1]?.detail ?? "", /didn't create.*empty database/);
});

test("adding a replica keeps the replica step open even when others exist", async () => {
  const plan = await planSetup(probe());
  assert.deepEqual(states(plan).slice(0, 3), ["database:done", "schema:done", "replica:current"]);
  assert.equal(plan.deploymentId, undefined);
});

test("continuing a replica walks through app, sign-in, objects and sync", async () => {
  assert.equal((await planSetup(probe({ app: async () => ({ loginUrl: "https://login.salesforce.com", callbackUrl: "x" }) }), "acme")).steps[3]?.state, "current");
  assert.equal((await planSetup(probe({ signedIn: async () => false }), "acme")).steps[4]?.state, "current");
  assert.equal((await planSetup(probe({ selection: async () => undefined }), "acme")).steps[5]?.state, "current");
  const drift = await planSetup(probe({ sync: async () => ({ ran: true, succeeded: true, objects: 3, matches: 2 }) }), "acme");
  assert.match(drift.steps[6]?.detail ?? "", /1 of 3 objects don't match/);
  const complete = await planSetup(probe(), "acme");
  assert.equal(complete.complete, true);
  assert.equal(complete.replicaName, "Acme");
});

test("an unverified sync never counts as done", async () => {
  const unknown = await planSetup(probe({ sync: async () => ({ ran: true, succeeded: true, objects: 2, matches: null }) }), "acme");
  assert.equal(unknown.complete, false);
  const failed = await planSetup(probe({ sync: async () => ({ ran: true, succeeded: false, objects: 2, matches: null }) }), "acme");
  assert.match(failed.steps[6]?.detail ?? "", /failed/);
});

test("password sign-in from the environment satisfies the app step", async () => {
  const plan = await planSetup(probe({ app: async () => ({ loginUrl: "https://login.salesforce.com", callbackUrl: "x", passwordSignIn: true }) }), "acme");
  assert.equal(plan.steps[3]?.state, "done");
});

test("inputs are validated and URLs are shown without passwords", () => {
  assert.equal(displayDatabaseUrl("postgresql://me:s3cret@db.example:5432/replcrm"), "me@db.example:5432/replcrm");
  assert.throws(() => validateDatabaseUrl("mysql://x@y/z"), /PostgreSQL/);
  assert.throws(() => validateDatabaseUrl("postgresql://host"), /database name/);
  assert.equal(validateDatabaseUrl(" postgres://u:p@h/db "), "postgres://u:p@h/db");
  assert.deepEqual(validateReplica(" emea-prod ", " EMEA "), { id: "emea-prod", name: "EMEA" });
  assert.throws(() => validateReplica("../x", "X"), /letters, numbers/);
  assert.throws(() => validateApp("short", ""), /consumer key/);
  assert.throws(() => validateApp("3MVG9aaaaaaaaaaaaaaaaaaaaaaaa", "http://login.salesforce.com"), /https/);
  assert.deepEqual(validateApp("3MVG9aaaaaaaaaaaaaaaaaaaaaaaa", "https://acme.my.salesforce.com/path"),
    { clientId: "3MVG9aaaaaaaaaaaaaaaaaaaaaaaa", loginUrl: "https://acme.my.salesforce.com" });
});

const port = 4999;
const headers = { host: `127.0.0.1:${port}` };

function setupHandler(needsSetup: boolean) {
  const calls: string[] = [];
  const setup: SetupService = {
    plan: async (id) => ({ ...(await planSetup(probe(), id)) }),
    needsSetup: async () => needsSetup,
    saveDatabase: async (url) => { calls.push(`database ${url}`); },
    applySchema: async (confirm) => { calls.push(`schema ${confirm}`); },
    createReplica: async (id, name) => { calls.push(`replica ${id} ${name}`); },
    saveApp: async (id, key) => { calls.push(`app ${id} ${key}`); },
    startSignIn: async (id) => { calls.push(`signin ${id}`); return { url: "https://login.salesforce.com/authorize" }; },
    availableObjects: async () => [{ name: "Account", label: "Account", custom: false }],
    saveObjects: async (id, entities) => { calls.push(`objects ${id} ${entities.join(",")}`); },
  };
  const handle = createConsoleHandler({ port, setup, buildStatus: async () => { throw new Error("no database"); } });
  return { handle, calls };
}

test("the console opens on setup when there is nothing to show", async () => {
  const { handle } = setupHandler(true);
  const page = await handle("GET", "/", headers);
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Add a replica/);
  assert.match(page.headers["Content-Security-Policy"] ?? "", /script-src 'nonce-/);
});

test("setup actions need the console token and reach the engine", async () => {
  const { handle, calls } = setupHandler(false);
  const post = (body: unknown, token = processToken) => handle("POST", "/api/setup", { ...headers, "x-replcrm-token": token }, JSON.stringify(body));
  assert.equal((await post({ action: "database", url: "postgresql://u:p@h/db" }, "wrong")).status, 403);
  assert.equal((await post({ action: "replica", id: "acme", name: "Acme" })).status, 200);
  assert.equal((await post({ action: "objects", deployment: "acme", entities: ["Account", 7, "Lead"] })).status, 200);
  const signin = JSON.parse((await post({ action: "signin", deployment: "acme" })).body);
  assert.equal(signin.url, "https://login.salesforce.com/authorize");
  assert.equal((await post({ action: "app", deployment: "../etc", clientId: "x" })).status, 400);
  assert.equal((await post({ action: "nope" })).status, 400);
  assert.deepEqual(calls, ["replica acme Acme", "objects acme Account,Lead", "signin acme"]);
});

test("setup errors come back as messages with database URLs removed", async () => {
  const { handle } = setupHandler(false);
  const service: SetupService = {
    plan: async () => planSetup(probe()), needsSetup: async () => false,
    saveDatabase: async () => { throw new Error("Couldn't connect to postgresql://u:secret@h/db: refused"); },
    applySchema: async () => {}, createReplica: async () => {}, saveApp: async () => {},
    startSignIn: async () => ({ url: "" }), availableObjects: async () => [], saveObjects: async () => {},
  };
  const failing = createConsoleHandler({ port, buildStatus: async () => { throw new Error("x"); }, setup: service });
  const result = await failing("POST", "/api/setup", { ...headers, "x-replcrm-token": processToken }, JSON.stringify({ action: "database", url: "x" }));
  assert.equal(result.status, 400);
  assert.doesNotMatch(result.body, /secret/);
  assert.match(JSON.parse(result.body).error, /\[database\] refused/);
  assert.equal((await handle("GET", "/api/setup/objects?deployment=acme", headers)).status, 200);
});
