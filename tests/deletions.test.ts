import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { reportCounts } from "../src/cli-counts.js";
import { runMetadataStage, runRecordsStage } from "../src/core/orchestrator.js";
import type { CanonicalEntity } from "../src/core/source.js";
import { SourceClient, decodeCheckpoint } from "../src/sources/salesforce/client.js";
import type { SourceRecord } from "../src/sources/salesforce/types.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config, entity } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { describe, field } from "./helpers/salesforce-fixture.js";

const oldStamp = "2025-01-01T00:00:00Z";
const checkpointStamp = "2025-02-01T00:00:00Z";
const deletionStamp = "2025-03-01T00:00:00Z";
const restoreStamp = "2025-04-01T00:00:00Z";
const checkpoint = JSON.stringify({ version: 1, systemModstamp: checkpointStamp });
const markedCheckpoint = JSON.stringify({ version: 1, systemModstamp: checkpointStamp, archivedBackfill: true });
const task: CanonicalEntity = {
  key: "Task", label: "Task", pluralLabel: "Tasks",
  attributes: [{ key: "IsArchived", label: "Archived", dataType: "Boolean" }],
};

function client(): SourceClient {
  const source = new SourceClient({ mode: "oauth", instanceUrl: "https://example.invalid", accessToken: "fixture-access" });
  source.describeObject = async (key) => describe(key, [field("IsDeleted", "boolean")]);
  return source;
}

function page(records: SourceRecord[], totalSize = records.length) {
  return { records, totalSize, done: true };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

async function setup(store: InMemoryReplicaStore | PostgresReplicaStore, definition = entity) {
  const sourceClient = client();
  sourceClient.describeEntity = async () => definition;
  const deps = { store, sourceClient, config: { ...config, entityKeys: [definition.key] } };
  await store.ensureDeployment(config.deploymentId, "Deletion fixture");
  await runMetadataStage(deps);
  return deps;
}

test("record reads and active counts include deleted visibility while user reads stay plain", async () => {
  const source = client();
  const calls: Array<[string, boolean]> = [];
  source.queryPage = async (soql, includeDeleted) => {
    calls.push([soql, includeDeleted]);
    return page([], 2);
  };
  await collect(source.fetchChanges(entity, null, 2));
  await collect(source.streamUsers(2));
  assert.equal(await source.countRecords(entity.key), 2);
  assert.equal(calls.length, 3);
  assert.match(calls[0]![0], /FROM Account\s+ORDER BY SystemModstamp ASC$/);
  assert.equal(calls[0]![1], true);
  assert.match(calls[1]![0], /FROM User$/);
  assert.equal(calls[1]![1], false);
  assert.deepEqual(calls[2], ["SELECT COUNT() FROM Account WHERE IsDeleted = false", true]);
});

test("a deleted row is normalized and advances the incremental checkpoint", async () => {
  const source = client();
  source.queryPage = async () => page([{ Id: "removed", IsDeleted: true, SystemModstamp: deletionStamp }]);
  const [batch] = await collect(source.fetchChanges(entity, checkpoint, 2));
  assert.equal(batch?.records[0]?.isDeleted, true);
  assert.equal(decodeCheckpoint(batch!.nextCheckpoint), deletionStamp);
  assert.deepEqual(JSON.parse(batch!.nextCheckpoint!), { version: 1, systemModstamp: deletionStamp });
});

async function verifyDeleteAndRestore(
  t: TestContext,
  store: InMemoryReplicaStore | PostgresReplicaStore,
  checkRecord: (deleted: boolean) => Promise<void>,
) {
  const deps = await setup(store);
  const { sourceClient } = deps;
  let rows: SourceRecord[] = ["first", "second", "third"].map((Id) => ({ Id, SystemModstamp: checkpointStamp, IsDeleted: false }));
  sourceClient.queryPage = async (soql) => {
    const since = /WHERE SystemModstamp > (\S+)/.exec(soql)?.[1];
    return page(rows.filter((row) => !since || row.SystemModstamp! > since));
  };
  await runRecordsStage(deps);
  assert.equal((await store.countRecords(config.deploymentId)).get(entity.key), 3);

  rows = [{ Id: "second", SystemModstamp: deletionStamp, IsDeleted: true }];
  await runRecordsStage(deps);
  await checkRecord(true);
  const stdout = t.mock.method(console, "log", () => {});
  await reportCounts(deps.config, { json: true, storeOnly: false }, store, {
    listEntities: async () => [entity.key], countRecords: async () => 2, logout: async () => {},
  });
  assert.deepEqual(JSON.parse(String(stdout.mock.calls[0]?.arguments[0])), [
    { entityKey: entity.key, storeCount: 2, sourceCount: 2, status: "MATCH" },
  ]);

  rows = [{ Id: "second", SystemModstamp: restoreStamp, IsDeleted: false }];
  await runRecordsStage(deps);
  await checkRecord(false);
  assert.equal((await store.countRecords(config.deploymentId)).get(entity.key), 3);
}

test("the memory records stage deletes and reactivates a record", async (t) => {
  const store = new InMemoryReplicaStore();
  await verifyDeleteAndRestore(t, store, async (deleted) => {
    assert.equal(store.readRecords(config.deploymentId, entity.key).find((row) => row.sourceId === "second")?.isDeleted, deleted);
  });
});

test("the Postgres records stage deletes and reactivates a record and clears deletedAt", async (t) => {
  const { db, prisma } = await database();
  t.after(() => db.close());
  await verifyDeleteAndRestore(t, new PostgresReplicaStore(prisma), async (deleted) => {
    const row = await prisma.record.findFirst({ where: { deploymentId: config.deploymentId, sourceId: "second" } });
    assert.ok(row);
    assert.equal(row.isDeleted, deleted);
    if (deleted) assert.ok(row.deletedAt instanceof Date);
    else assert.equal(row.deletedAt, null);
  });
});

test("a previously unseen deleted row never contributes to the active count", async () => {
  const store = new InMemoryReplicaStore();
  const deps = await setup(store);
  deps.sourceClient.queryPage = async () => page([{ Id: "unknown", IsDeleted: true, SystemModstamp: deletionStamp }]);
  await runRecordsStage(deps);
  assert.equal(store.countRecords(config.deploymentId).get(entity.key), 0);
  assert.ok(store.readRecords(config.deploymentId, entity.key).every((row) => row.isDeleted));
});

test("default query dispatch uses scanAll, follows queryMore and keeps user queries plain", async (t) => {
  const source = client();
  const nextRecordsUrl = "/services/data/v62.0/query/fixture-page";
  const query = t.mock.fn(async (soql: string, _options?: { scanAll: boolean }) => {
    if (soql.includes("COUNT()")) return page([], 7);
    if (soql.endsWith("FROM User")) return page([{ Id: "user", Username: "fixture-user" }]);
    return { ...page([{ Id: "first", SystemModstamp: oldStamp }], 2), done: false, nextRecordsUrl };
  });
  const queryMore = t.mock.fn(async (_url: string) => page([{ Id: "second", SystemModstamp: checkpointStamp }], 2));
  Object.assign(source, { connection: { query, queryMore } });

  const batches = await collect(source.fetchChanges(entity, null, 2));
  assert.deepEqual(batches.flatMap((batch) => batch.records.map((row) => row.sourceId)), ["first", "second"]);
  assert.deepEqual(queryMore.mock.calls.map((call) => call.arguments), [[nextRecordsUrl]]);
  assert.equal((await collect(source.streamUsers(2)))[0]?.[0]?.sourceId, "user");
  assert.equal(await source.countRecords(entity.key), 7);
  assert.equal(query.mock.callCount(), 3);
  assert.deepEqual(query.mock.calls[0]?.arguments[1], { scanAll: true });
  assert.equal(query.mock.calls[1]?.arguments.length, 1);
  assert.deepEqual(query.mock.calls[2]?.arguments, ["SELECT COUNT() FROM Account WHERE IsDeleted = false", { scanAll: true }]);
});

async function archivedFixture(initialCheckpoint: string) {
  const store = new InMemoryReplicaStore();
  const deps = await setup(store, task);
  const seed = await store.beginRun(config.deploymentId, task.key);
  await store.completeRuns([{ id: seed.id, result: { processed: 0, created: 0, updated: 0, deleted: 0, checkpoint: initialCheckpoint } }]);
  const queries: string[] = [];
  deps.sourceClient.queryPage = async (soql, includeDeleted) => {
    assert.equal(includeDeleted, true);
    queries.push(soql);
    return page(soql.includes("WHERE IsArchived = true")
      ? [{ Id: "archived", IsArchived: true, IsDeleted: false, SystemModstamp: oldStamp }]
      : []);
  };
  return { store, deps, queries };
}

function assertBackfillThenIncremental(queries: string[]) {
  assert.equal(queries.length, 2);
  assert.ok(queries[0]?.endsWith(`WHERE IsArchived = true AND SystemModstamp <= ${checkpointStamp} ORDER BY SystemModstamp ASC`));
  assert.ok(queries[1]?.endsWith(`WHERE SystemModstamp > ${checkpointStamp} ORDER BY SystemModstamp ASC`));
  assert.equal(queries[0]?.split(" WHERE ")[0], queries[1]?.split(" WHERE ")[0]);
}

test("an old version-1 checkpoint backfills archived rows once and commits the marker", async () => {
  const { store, deps, queries } = await archivedFixture(checkpoint);
  await runRecordsStage(deps);
  assertBackfillThenIncremental(queries);
  assert.equal(store.readRecords(config.deploymentId, task.key)[0]?.sourceId, "archived");
  assert.equal(store.getCheckpoint(config.deploymentId, task.key), markedCheckpoint);

  queries.length = 0;
  await runRecordsStage(deps);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0]!, /WHERE IsArchived/);
});

test("legacy checkpoints backfill only archived entities and fresh archived syncs publish the marker", async () => {
  const { store, deps, queries } = await archivedFixture(checkpointStamp);
  await runRecordsStage(deps);
  assertBackfillThenIncremental(queries);
  assert.equal(store.getCheckpoint(config.deploymentId, task.key), markedCheckpoint);

  const source = client();
  const calls: string[] = [];
  source.queryPage = async (soql) => {
    calls.push(soql);
    return page([{ Id: "active", SystemModstamp: checkpointStamp }]);
  };
  const [plainBatch] = await collect(source.fetchChanges(entity, oldStamp, 2));
  assert.equal(plainBatch?.nextCheckpoint, checkpoint);
  const [freshBatch] = await collect(source.fetchChanges(task, null, 2));
  assert.equal(freshBatch?.nextCheckpoint, markedCheckpoint);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls.join("\n"), /WHERE IsArchived/);

  source.queryPage = async () => page([]);
  const [emptyBatch] = await collect(source.fetchChanges(task, null, 2));
  assert.deepEqual(emptyBatch?.records, []);
  assert.equal(JSON.parse(emptyBatch!.nextCheckpoint!).archivedBackfill, true);
});

test("failed reference repair leaves the old checkpoint and retries the archived backfill", async (t) => {
  const { store, deps, queries } = await archivedFixture(checkpoint);
  const repair = store.resolveReferences.bind(store);
  let fail = true;
  t.mock.method(store, "resolveReferences", async (deploymentId: string, batchSize: number) => {
    if (fail) throw new Error("Fixture reference repair failure");
    await repair(deploymentId, batchSize);
  });
  await assert.rejects(runRecordsStage(deps), /Fixture reference repair failure/);
  assertBackfillThenIncremental(queries);
  assert.equal(store.getCheckpoint(config.deploymentId, task.key), checkpoint);
  assert.equal(store.readRecords(config.deploymentId, task.key)[0]?.sourceId, "archived");

  fail = false;
  queries.length = 0;
  await runRecordsStage(deps);
  assertBackfillThenIncremental(queries);
  assert.deepEqual(store.readRecords(config.deploymentId, task.key).map((row) => row.sourceId), ["archived"]);
  assert.equal(store.getCheckpoint(config.deploymentId, task.key), markedCheckpoint);
});
