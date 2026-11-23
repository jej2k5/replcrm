import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { runCli, type CliDeps } from "../src/cli.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config, entity, FakeSource } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";

const { deploymentId } = config;
const { key } = entity;

function fixture(t: TestContext) {
  const store = new InMemoryReplicaStore();
  store.ensureDeployment(deploymentId, "Test deployment");
  const source = new FakeSource();
  const spies = {
    metadata: t.mock.method(store, "persistMetadata"),
    users: t.mock.method(store, "persistUsers"),
    records: t.mock.method(store, "persistRecords"),
    repair: t.mock.method(store, "resolveReferences"),
    projections: t.mock.method(store, "ensureProjections"),
    begin: t.mock.method(store, "beginRun"),
    complete: t.mock.method(store, "completeRuns"),
    describe: t.mock.method(source, "describeEntity"),
    list: t.mock.method(source, "listEntities"),
    probe: t.mock.method(store, "hasEntityMetadata"),
  };
  const deps: CliDeps = {
    loadConfig: () => config,
    createSource: () => source,
    createStore: () => store,
    deploymentExists: store.deploymentExists.bind(store),
    ensureDeployment: store.ensureDeployment.bind(store),
    hasEntityMetadata: store.hasEntityMetadata.bind(store),
  };
  return { store, spies, run: (argv: string[]) => runCli(argv, deps) };
}

function methodCounts({ spies }: ReturnType<typeof fixture>) {
  return Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.callCount()]));
}

test("records and projections describe and run only their own stages", async (t) => {
  for (const stage of ["records", "projections"] as const) {
    const f = fixture(t);
    await InMemoryReplicaStore.prototype.persistMetadata.call(f.store, deploymentId, [entity]);
    assert.equal(await f.run([stage]), 0);
    assert.deepEqual(methodCounts(f), {
      metadata: 0, users: 0, records: Number(stage === "records"), repair: Number(stage === "records"),
      projections: Number(stage === "projections"), begin: 1, complete: 1, describe: 1, list: 1, probe: 1,
    });
    assert.deepEqual(f.spies.probe.mock.calls[0]?.arguments, [deploymentId, [key]]);
    assert.deepEqual(f.spies.describe.mock.calls[0]?.arguments, [key]);
  }
});

test("running all four standalone stages produces the same state as full", async (t) => {
  const standalone = fixture(t);
  const full = fixture(t);
  for (const command of ["metadata", "users", "records", "projections"]) {
    assert.equal(await standalone.run([command]), 0);
  }
  assert.equal(await full.run(["full"]), 0);
  for (const { store } of [standalone, full]) {
    const [record] = store.readRecords(deploymentId, key);
    const [projected] = store.readProjection(deploymentId, key);
    assert.ok(record);
    assert.equal(projected?.id, record.id);
  }
  const snapshot = async ({ store, spies }: ReturnType<typeof fixture>) => ({
    entity: store.readEntity(deploymentId, key),
    records: store.readRecords(deploymentId, key).map(({ id, ...row }) => row),
    projections: store.readProjection(deploymentId, key).map(({ id, ...row }) => row),
    projection: await store.resolveProjection(deploymentId, key),
    checkpoint: store.getCheckpoint(deploymentId, key),
    users: spies.users.mock.calls.map(({ arguments: args }) => args),
    completed: spies.complete.mock.calls.flatMap(({ arguments: [runs] }) => runs.map(({ result }) => result)),
  });
  assert.deepEqual(await snapshot(standalone), await snapshot(full));
});

test("records and projections before metadata fail without opening a stage run", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  for (const stage of ["records", "projections"]) {
    const f = fixture(t);
    assert.equal(await f.run([stage]), 1);
    assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /Run the metadata subcommand first/);
    assert.deepEqual(methodCounts(f), {
      metadata: 0, users: 0, records: 0, repair: 0, projections: 0, begin: 0, complete: 0,
      describe: 0, list: 1, probe: 1,
    });
  }
});

test("legacy npm scripts reach their own stages and warn on stderr", async (t) => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const { run, spies } = fixture(t);
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    stderr.push(chunk);
    return true;
  });
  for (const stage of ["metadata", "records"]) {
    const argv = scripts[`migrate:${stage}`]!.split(/\s+/).slice(2);
    assert.equal(await run(argv), 0);
  }
  assert.deepEqual(stderr, [
    "npm run migrate:metadata is deprecated. Use npm run replicate:metadata.\n",
    "npm run migrate:records is deprecated. Use npm run replicate:records.\n",
  ]);
  assert.equal(spies.metadata.mock.callCount(), 1);
  assert.equal(spies.records.mock.callCount(), 1);
  assert.equal(spies.repair.mock.callCount(), 1);
  assert.equal(spies.users.mock.callCount(), 0);
  assert.equal(spies.projections.mock.callCount(), 0);
});

test("help lists records and projections", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  assert.equal(await fixture(t).run(["help"]), 0);
  const help = String(log.mock.calls[0]?.arguments[0]);
  assert.match(help, /^  records\s+Replicate records/m);
  assert.match(help, /^  projections\s+Build wide-view projections/m);
});

test("Postgres metadata probe requires every selected entity in the deployment", async (t) => {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  await prisma.deployment.create({ data: { id: deploymentId, name: deploymentId } });
  await prisma.deployment.create({ data: { id: "other", name: "other" } });
  const contact = { ...entity, key: "Contact" };
  assert.equal(await store.hasEntityMetadata(deploymentId, [key]), false);
  await store.persistMetadata(deploymentId, [entity]);
  await store.persistMetadata("other", [contact]);
  assert.equal(await store.hasEntityMetadata(deploymentId, [key]), true);
  assert.equal(await store.hasEntityMetadata(deploymentId, [key, contact.key]), false);
  assert.equal(await store.hasEntityMetadata("other", [key]), false);
  await store.persistMetadata(deploymentId, [contact]);
  assert.equal(await store.hasEntityMetadata(deploymentId, [key, contact.key, key]), true);
});
