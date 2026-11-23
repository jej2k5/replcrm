import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps } from "../src/cli.js";
import { writePrivateJson } from "../src/cli-config-dir.js";
import { createConsoleHandler } from "../src/console/handler.js";
import { buildStatus, type StatusSource, type StatusStore } from "../src/console/status.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config, entity } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";

const { deploymentId } = config;
const explicit = { entities: ["Account", "Contact"] };
const wildcard = { entities: ["*"] };
const port = 47090;
const host = { host: `127.0.0.1:${port}` };
const contact = { ...entity, key: "Contact", label: "Contact", pluralLabel: "Contacts" };
const never = <T>() => new Promise<T>(() => {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function source(overrides: Partial<StatusSource> = {}): StatusSource {
  return {
    listEntities: async () => explicit.entities,
    countRecords: async (key) => key === entity.key ? 1 : 2,
    ...overrides,
  };
}

async function seededMemory() {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(deploymentId, [entity, contact]);
  for (const definition of [entity, contact]) {
    const run = await store.beginRun(deploymentId, definition.key);
    const result = await store.persistRecords(deploymentId, definition, {
      records: [{ sourceId: "active", fields: {} }], nextCheckpoint: null,
    });
    await store.completeRuns([{ id: run.id, result: { ...result, checkpoint: null } }]);
  }
  return store;
}

async function postgres(t: TestContext) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  await store.ensureDeployment(deploymentId, "Console fixture");
  return { store, prisma };
}

function handler(store: StatusStore, client?: StatusSource) {
  return createConsoleHandler({ port, buildStatus: () => buildStatus(config, wildcard, store, client) });
}

test("reports the latest records run and compares active counts for two objects", async () => {
  const result = await buildStatus(config, explicit, await seededMemory(), source());
  assert.equal(result.salesforce.state, "ok");
  assert.deepEqual(result.objects.map(({ lastRun, ...counts }) => {
    assert.ok(lastRun?.startedAt instanceof Date);
    assert.ok(lastRun.completedAt instanceof Date);
    assert.equal(lastRun.status, "Succeeded");
    assert.deepEqual([lastRun.processed, lastRun.created, lastRun.updated, lastRun.deleted], [1, 1, 0, 0]);
    return counts;
  }), [
    { entityKey: "Account", storeCount: 1, sourceCount: 1, status: "MATCH" },
    { entityKey: "Contact", storeCount: 1, sourceCount: 2, status: "DIFF" },
  ]);
});

test("Postgres reads latest records and orders failed attempts across entity and stage runs", async (t) => {
  const { store } = await postgres(t);
  const older = await store.beginRun(deploymentId, "Account");
  await store.failRun(older.id, "Old failure");
  const newer = await store.beginRun(deploymentId, "Account");
  await store.completeRuns([{ id: newer.id, result: { processed: 5, created: 1, updated: 3, deleted: 1, checkpoint: null } }]);
  await store.beginRun(deploymentId, "Contact");
  const stage = await store.beginRun(deploymentId, null);
  await store.failRun(stage.id, "Stage failure");

  const latest = await store.latestEntityRuns(deploymentId);
  assert.deepEqual([...latest.keys()].sort(), ["Account", "Contact"]);
  assert.equal(latest.get("Account")?.processed, 5);
  assert.equal(latest.get("Account")?.status, "Succeeded");
  assert.equal(latest.get("Contact")?.status, "Running");
  const failed = await store.recentFailedRuns(deploymentId, 10);
  assert.deepEqual(failed.map(({ entityKey, errorMessage }) => [entityKey, errorMessage]), [
    [null, "Stage failure"], ["Account", "Old failure"],
  ]);
  assert.deepEqual(await store.recentFailedRuns(deploymentId, 1), failed.slice(0, 1));
});

test("a failed count discards all Salesforce counts and preserves store counts", async () => {
  const client = source({ countRecords: async (key) => {
    if (key === "Contact") throw new Error("Count failed");
    return 1;
  } });
  const result = await buildStatus(config, explicit, await seededMemory(), client);
  assert.deepEqual(result.salesforce, { state: "unavailable", reason: "Count failed" });
  assert.deepEqual(result.objects.map(({ lastRun, ...row }) => row), [
    { entityKey: "Account", storeCount: 1 }, { entityKey: "Contact", storeCount: 1 },
  ]);
});

test("an unconfigured wildcard uses persisted keys and respects the deny list", async () => {
  const result = await buildStatus({ ...config, entityDenyKeys: ["Contact"] }, wildcard, await seededMemory());
  assert.equal(result.salesforce.state, "not-configured");
  assert.deepEqual(result.objects.map(({ entityKey, storeCount }) => [entityKey, storeCount]), [["Account", 1]]);
});

test("status cache expires after 60 seconds and refresh bypasses it", async () => {
  const store = await seededMemory();
  let reads = 0;
  let time = 0;
  const client = source({ countRecords: async () => ++reads });
  const handle = createConsoleHandler({
    port, now: () => new Date(time),
    buildStatus: () => buildStatus(config, { entities: ["Account"] }, store, client),
  });
  const first = await handle("GET", "/api/status", host);
  time = 59_999;
  assert.equal((await handle("GET", "/api/status", host)).body, first.body);
  assert.equal(reads, 1);
  assert.equal((await handle("GET", "/api/status?refresh=1", host)).status, 200);
  assert.equal(reads, 2);
  time += 60_000;
  await handle("GET", "/api/status", host);
  assert.equal(reads, 3);
});

test("a count timeout leaves store counts available", async () => {
  const result = await buildStatus(config, explicit, await seededMemory(),
    source({ countRecords: never }), { timeoutMs: 5 });
  assert.match(result.salesforce.reason ?? "", /timed out/);
  assert.equal(result.salesforce.state, "unavailable");
  assert.equal(result.objects[0]?.storeCount, 1);
  assert.equal(result.objects[0]?.status, undefined);
});

test("the handler validates Host before routing and sends JSON with no-store", async () => {
  const handle = handler(new InMemoryReplicaStore());
  for (const headers of [{}, { host: "example.invalid" }, { host: "localhost" }, { host: `localhost:${port},evil` }]) {
    assert.equal((await handle("GET", "/api/status", headers)).status, 400);
  }
  assert.equal((await handle("POST", "/api/runs", host)).status, 403);
  assert.equal((await handle("GET", "/missing", host)).status, 404);
  assert.equal((await handle("POST", "/api/status", host)).status, 405);
  const response = await handle("GET", "/api/status", { Host: `localhost:${port}` });
  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.match(response.headers["Content-Type"], /^application\/json/);
  assert.ok(Object.keys(response.headers).every((key) => !/^access-control-/i.test(key)));
  assert.equal(JSON.parse(response.body).deploymentId, deploymentId);
});

test("source and persisted run errors omit credentials", async () => {
  const store = await seededMemory();
  const run = await store.beginRun(deploymentId, "Account");
  await store.failRun(run.id, "Query failed: Bearer fixture-access");
  const response = await handler(store, source({
    countRecords: async () => { throw new Error("Request failed: access_token=fixture-secret&extra=value"); },
  }))("GET", "/api/status", host);
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.body, /fixture-access|fixture-secret|extra=value/);
  const body = JSON.parse(response.body);
  assert.equal(body.salesforce.reason, "Request failed:");
  assert.equal(body.errors[0].message, "Query failed:");
  assert.equal(body.objects[0].lastRun.errorMessage, "Query failed:");
});

test("a later null-key stage run does not change any object's last run", async () => {
  const store = await seededMemory();
  const before = await buildStatus(config, explicit, store);
  const run = await store.beginRun(deploymentId, null);
  await store.failRun(run.id, "Projection failure");
  const after = await buildStatus(config, explicit, store);
  assert.deepEqual(after.objects, before.objects);
  assert.equal(after.errors[0]?.entityKey, null);
});

async function assertFallback(listEntities: StatusSource["listEntities"], reason: string) {
  let countCalls = 0;
  const result = await buildStatus(config, wildcard, await seededMemory(), source({
    listEntities,
    countRecords: async () => ++countCalls,
  }), { timeoutMs: 5 });
  assert.deepEqual(result.salesforce, { state: "unavailable", reason });
  assert.deepEqual(result.objects.map(({ lastRun, ...row }) => row), [
    { entityKey: "Account", storeCount: 1 }, { entityKey: "Contact", storeCount: 1 },
  ]);
  assert.equal(countCalls, 0);
}

test("a discovery failure falls back to persisted objects without counting Salesforce", async () => {
  await assertFallback(async () => { throw new Error("Discovery failed"); }, "Discovery failed");
});

test("a discovery timeout falls back to persisted objects without counting Salesforce", async () => {
  await assertFallback(never, "Salesforce status timed out");
});

async function assertFresh(store: StatusStore) {
  const broken = source({ listEntities: async () => { throw new Error("No discovery"); } });
  for (const [client, state] of [[broken, "unavailable"], [undefined, "not-configured"]] as const) {
    const result = await buildStatus(config, wildcard, store, client);
    assert.equal(result.salesforce.state, state);
    if (client) assert.equal(result.salesforce.reason, "No discovery");
    assert.deepEqual(result.objects, []);
    assert.deepEqual(result.errors, []);
    const response = await handler(store, client)("GET", "/api/status", host);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).salesforce, result.salesforce);
    assert.deepEqual(JSON.parse(response.body).objects, []);
    assert.deepEqual(JSON.parse(response.body).errors, []);
  }
}

test("an empty memory store serves empty status", async () => {
  await assertFresh(new InMemoryReplicaStore());
});

test("a Postgres store with only a deployment row serves empty status", async (t) => {
  await assertFresh((await postgres(t)).store);
});

test("discovery resolving after the deadline starts no count calls", async () => {
  const store = await seededMemory();
  const listing = deferred<string[]>();
  const finished = deferred<void>();
  let countCalls = 0;
  const result = await buildStatus(config, wildcard, store, {
    listEntities: () => listing.promise,
    countRecords: async () => ++countCalls,
    logout: async () => finished.resolve(),
  }, { timeoutMs: 5 });
  listing.resolve(["Lead"]);
  await finished.promise;
  assert.equal(countCalls, 0);
  assert.deepEqual(result.objects.map(({ entityKey }) => entityKey), explicit.entities);
});

test("the production handler uses saved selection and distinguishes missing sign-in from absent configuration", async (t) => {
  const { prisma } = await postgres(t);
  const dir = await mkdtemp(join(tmpdir(), "replcrm-console-"));
  try {
    await writePrivateJson(join(dir, "selections", `${deploymentId}.json`), { version: 1, entities: ["Lead"] });
    const env: NodeJS.ProcessEnv = {
      DEPLOYMENT_ID: deploymentId, REPLCRM_CONFIG_DIR: dir, SYNC_ENTITIES: "Account",
    };
    const deps = createProductionDeps(env, { prisma: () => prisma });
    const handle = deps.createConsoleHandler!(port);
    const first = await handle("GET", "/api/status", host);
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body).objects, [{ entityKey: "Lead", storeCount: 0, lastRun: null }]);
    assert.equal(JSON.parse(first.body).salesforce.state, "not-configured");
    env.SF_CLIENT_ID = "fixture-client";
    const second = await handle("GET", "/api/status?refresh=1", host);
    assert.equal(JSON.parse(second.body).salesforce.state, "unavailable");
    assert.match(JSON.parse(second.body).salesforce.reason, /auth login/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
