import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runCli, type CliDeps } from "../src/cli.js";
import { runRecordsStage, selectEntityKeys } from "../src/core/orchestrator.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";

import { config, entity, FakeSource } from "./helpers/cli-fixture.js";

const stageMethods = ["persistMetadata", "persistUsers", "persistRecords", "resolveReferences", "ensureProjections"] as const;

async function runAndInspect(t: TestContext, argv: string[]): Promise<number[]> {
  const store = new InMemoryReplicaStore();
  store.ensureDeployment(config.deploymentId, "Test deployment");
  if (argv[0] === "records") await store.persistMetadata(config.deploymentId, [entity]);
  const source = new FakeSource();
  const spies = stageMethods.map((method) => t.mock.method(store, method));
  const beginRun = t.mock.method(store, "beginRun");
  const completeRuns = t.mock.method(store, "completeRuns");
  const failRun = t.mock.method(store, "failRun");
  const connect = t.mock.method(source, "connect");
  const logout = t.mock.method(source, "logout");

  assert.equal(await runCli(argv, {
    loadConfig: () => config,
    createSource: () => source,
    createStore: () => store,
    deploymentExists: store.deploymentExists.bind(store),
    ensureDeployment: unexpectedDependency,
    hasEntityMetadata: store.hasEntityMetadata.bind(store),
  }), 0);
  const expectedRuns = ["metadata", "users", "records"].includes(argv[0] ?? "") ? 1 : 4;
  assert.equal(beginRun.mock.callCount(), expectedRuns);
  assert.equal(completeRuns.mock.callCount(), expectedRuns);
  assert.equal(failRun.mock.callCount(), 0);
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(logout.mock.callCount(), 1);
  return spies.map((spy) => spy.mock.callCount());
}

test("metadata runs only the metadata stage", async (t) => {
  assert.deepEqual(await runAndInspect(t, ["metadata"]), [1, 0, 0, 0, 0]);
});

test("users runs only the users stage", async (t) => {
  assert.deepEqual(await runAndInspect(t, ["users"]), [0, 1, 0, 0, 0]);
});

test("full and the default run every stage", async (t) => {
  assert.deepEqual(await runAndInspect(t, ["full"]), [1, 1, 1, 1, 1]);
  assert.deepEqual(await runAndInspect(t, []), [1, 1, 1, 1, 1]);
});

test("records runs only the records stage", async (t) => {
  const warning = t.mock.method(console, "warn");
  assert.deepEqual(await runAndInspect(t, ["records"]), [0, 0, 1, 1, 0]);
  assert.equal(warning.mock.callCount(), 0);
});

test("the records stage commits the checkpoint after asynchronous reference repair", async (t) => {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(config.deploymentId, [entity]);
  const repair = store.resolveReferences.bind(store);
  const complete = store.completeRuns.bind(store);
  const order: string[] = [];
  t.mock.method(store, "resolveReferences", async (...args: Parameters<typeof repair>) => {
    await setImmediate();
    const repaired = await repair(...args);
    order.push("repair complete");
    return repaired;
  });
  t.mock.method(store, "completeRuns", async (...args: Parameters<typeof complete>) => {
    order.push("commit");
    await complete(...args);
  });
  await runRecordsStage({ store, config, sourceClient: new FakeSource() });
  assert.deepEqual(order, ["repair complete", "commit"]);
  assert.equal(store.getCheckpoint(config.deploymentId, entity.key), "next-page");
});

test("the records stage leaves the checkpoint uncommitted if repair fails", async (t) => {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(config.deploymentId, [entity]);
  t.mock.method(store, "resolveReferences", async () => {
    throw new Error("repair failed");
  });
  const complete = t.mock.method(store, "completeRuns");
  const fail = t.mock.method(store, "failRun");
  await assert.rejects(runRecordsStage({ store, config, sourceClient: new FakeSource() }), /repair failed/);
  assert.equal(complete.mock.callCount(), 0);
  assert.equal(fail.mock.callCount(), 1);
  assert.equal(store.getCheckpoint(config.deploymentId, entity.key), null);
  assert.equal(store.readRecords(config.deploymentId, entity.key).length, 1);
});

function unexpectedDependency(): never {
  assert.fail("Usage commands must not load config or build adapters");
}

const usageDeps: CliDeps = {
  loadConfig: unexpectedDependency,
  createSource: unexpectedDependency,
  createStore: unexpectedDependency,
  deploymentExists: unexpectedDependency,
  ensureDeployment: unexpectedDependency,
  hasEntityMetadata: unexpectedDependency,
};

test("unknown commands return an error and usage", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  assert.equal(await runCli(["unsupported"], usageDeps), 1);
  assert.match(String(error.mock.calls[0]?.arguments[0]), /Unsupported command: unsupported\nUsage:/);
  assert.equal(await runCli(["constructor"], usageDeps), 1);
});

test("help and --help list every accepted command without building adapters", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  assert.equal(await runCli(["help"], usageDeps), 0);
  assert.equal(await runCli(["--help"], usageDeps), 0);
  const help = String(log.mock.calls[0]?.arguments[0]);
  assert.equal(log.mock.calls[1]?.arguments[0], help);
  assert.match(help, /full.*default/);
  assert.match(help, /console \[--port N\]/);
  assert.match(help, /deployment verify \[--rebind\] \[--json\]/);
  assert.match(help, /reconcile \[--entities a,b\] \[--json\]/);
  assert.match(help, /reconcile --apply \[--allow-empty\] \[--allow-large\] \[--json\]/);
  assert.deepEqual([...new Set(help.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]))],
    ["full", "metadata", "users", "records", "projections", "auth", "objects", "console", "setup", "counts", "reconcile", "deployment", "help", "--help"]);
});

test("selectEntityKeys discovers wildcard keys, filters denied keys, and preserves unique order", async (t) => {
  const lister = { async listEntities() { return ["Contact", "Account", "Contact", "Lead"]; } };
  const list = t.mock.method(lister, "listEntities");
  assert.deepEqual(await selectEntityKeys({ ...config, entityDenyKeys: ["Account"] }, lister), ["Contact", "Lead"]);
  assert.deepEqual(await selectEntityKeys({
    ...config, entityKeys: ["Lead", "Lead", "Account"], entityDenyKeys: ["Account"],
  }, lister), ["Lead"]);
  assert.equal(list.mock.callCount(), 1);
});

test("selectEntityKeys rejects an empty selection", async () => {
  await assert.rejects(selectEntityKeys({ ...config, entityDenyKeys: [entity.key] }, new FakeSource()),
    /No entities selected for replication/);
});

test("importing CLI leaves Prisma, Salesforce and the process exit status untouched", () => {
  const loader = `
    export function resolve(specifier, context, nextResolve) {
      if (specifier === "@prisma/client" || specifier.includes("/sources/salesforce/")) {
        throw new Error("Unexpected runtime dependency: " + specifier);
      }
      return nextResolve(specifier, context);
    }
  `;
  const cli = new URL("../src/cli.ts", import.meta.url);
  const code = `
    import assert from "node:assert/strict";
    const { runCli } = await import(${JSON.stringify(cli.href)});
    assert.equal(typeof runCli, "function");
    assert.equal(process.exitCode, undefined);
    console.log("imported");
  `;
  const output = execFileSync(process.execPath, [
    "--import", "tsx", "--loader", `data:text/javascript,${encodeURIComponent(loader)}`,
    "--input-type=module", "-e", code,
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { TMPDIR: tmpdir() }, encoding: "utf8", stdio: "pipe" });
  assert.equal(output, "imported\n");
});
