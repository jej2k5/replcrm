import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLockPath } from "../src/cli-config-dir.js";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import type { SourceChangeResult, ValidatedChange } from "../src/core/source.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { submitChange, type ChangeSubmission } from "../src/writeback/index.js";
import { recoverSending } from "../src/writeback/queue.js";
import { config, FakeSource } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { account, deployment } from "./helpers/writeback.js";

const sourceId = "fixture-record";
const update: ChangeSubmission = {
  deploymentId: deployment, entityKey: account.key, operation: "update", targetRecordId: sourceId,
  fields: { Name: { base: "old", value: "new" } }, authorKind: "app", authorLabel: "fixture",
};
const create: ChangeSubmission = {
  deploymentId: deployment, entityKey: account.key, operation: "create",
  fields: { Name: { value: "new" } }, authorKind: "app", authorLabel: "fixture",
};

async function seed(store: InMemoryReplicaStore | PostgresReplicaStore) {
  await store.ensureDeployment(deployment, deployment);
  await store.persistMetadata(deployment, [account]);
  await store.editWritebackPolicy(deployment, account.key, { action: "enable" });
  await store.persistRecords(deployment, account, { records: [{ sourceId, fields: { Name: "old" } }], nextCheckpoint: null });
}

async function sqlFixture(action: (db: Awaited<ReturnType<typeof database>>["db"], store: PostgresReplicaStore) => Promise<void>) {
  const { db, prisma } = await database();
  try {
    const store = new PostgresReplicaStore(prisma);
    await seed(store);
    await action(db, store);
  } finally {
    await db.close();
  }
}

type Outcome = { status: string; change_request_id: string | null; messages: string[] };
async function insert(db: Awaited<ReturnType<typeof database>>["db"], input: ChangeSubmission) {
  const { rows } = await db.query<Outcome>(`
    INSERT INTO writeback.submissions (deployment_id, entity_key, operation, record_id, fields, author_kind, author_label, idempotency_key)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
    RETURNING status, change_request_id, messages
  `, [input.deploymentId, input.entityKey, input.operation, input.targetRecordId ?? null,
    JSON.stringify(input.fields), input.authorKind, input.authorLabel, input.idempotencyKey ?? null]);
  return rows[0]!;
}

test("SQL accepts either record identifier and protects stored submissions", () => sqlFixture(async (db, store) => {
  const [{ id }] = (await db.query<{ id: string }>('SELECT id FROM "Record"')).rows as [{ id: string }];
  for (const targetRecordId of [sourceId, id]) {
    const row = await insert(db, { ...update, targetRecordId });
    assert.equal(row.status, "accepted");
    assert.deepEqual(row.messages, []);
    const request = await store.getChangeRequest(deployment, row.change_request_id!);
    assert.equal(request?.targetSourceId, sourceId);
    assert.equal(request?.targetRecordId, id);
    assert.deepEqual(request?.fields, update.fields);
  }
  await assert.rejects(db.exec("UPDATE writeback.submissions SET status = 'refused'"), /insert-only/);
  await assert.rejects(db.exec("DELETE FROM writeback.submissions"), /insert-only/);
}));

test("SQL refuses bad fields and records the same validation messages as embedded PostgreSQL submissions", () => sqlFixture(async (db, store) => {
  const bad = { ...update, fields: { Name: { value: 9 }, Total: { base: null, value: "x" } } };
  const row = await insert(db, bad);
  assert.equal(row.status, "refused");
  assert.equal(row.change_request_id, null);
  assert.deepEqual(row.messages, ["Name has an invalid value (Canonical string required for Text)", "Name requires a base value", "Total is not writable on update"]);
  await assert.rejects(submitChange(store, bad), { message: row.messages.join("\n") });
  assert.deepEqual(await store.listChangeRequests(deployment), []);
}));

test("SQL idempotency shares requests with the embedded API", () => sqlFixture(async (db, store) => {
  const input = { ...create, idempotencyKey: "fixture-key" };
  const first = await insert(db, input);
  const second = await insert(db, { ...input, fields: {} });
  assert.deepEqual(second, first);
  assert.equal((await submitChange(store, input)).id, first.change_request_id);
  assert.equal((await store.listChangeRequests(deployment)).length, 1);
  assert.match((await insert(db, { ...input, operation: "delete" })).messages[0]!, /deletes are not supported/);
}));

test("a SQL app role can submit without direct request access", () => sqlFixture(async (db) => {
  await db.exec(`
    CREATE ROLE fixture_app;
    GRANT USAGE ON SCHEMA writeback TO fixture_app;
    GRANT INSERT (deployment_id, entity_key, operation, record_id, fields, author_kind, author_label, idempotency_key)
      ON writeback.submissions TO fixture_app;
    GRANT SELECT (status, change_request_id, messages) ON writeback.submissions TO fixture_app;
    SET ROLE fixture_app;
  `);
  assert.equal((await insert(db, create)).status, "accepted");
  await assert.rejects(db.exec('SELECT * FROM "ChangeRequest"'), /permission denied/);
}));

class QueueSource extends FakeSource {
  sent: ValidatedChange[] = [];
  send = async (change: ValidatedChange): Promise<SourceChangeResult> => ({
    status: "applied", sourceId, modifiedAt: null,
    record: { sourceId, fields: { Name: String(change.fields.Name?.value) + " (refreshed)" } },
  });
  async applyChange(change: ValidatedChange) {
    this.sent.push(change);
    return this.send(change);
  }
  async readRecord() {
    return { sourceId, fields: { Name: "linked" } };
  }
}

async function fixture(action: (f: {
  deps: CliDeps; store: InMemoryReplicaStore; source: QueueSource; path: string;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-queue-"));
  try {
    const source = new QueueSource();
    const store = new InMemoryReplicaStore();
    await seed(store);
    const { acquireRunLock } = createProductionDeps({ REPLCRM_CONFIG_DIR: dir }, { runLockIsProcessAlive: () => true });
    const deps: CliDeps = {
      acquireRunLock: acquireRunLock!, loadConfig: () => ({ ...config, deploymentId: deployment, entityKeys: [account.key] }),
      createSource: () => source, createStore: () => store, createWritebackStore: () => store,
      ensureDeployment: store.ensureDeployment.bind(store), deploymentExists: store.deploymentExists.bind(store),
      hasEntityMetadata: store.hasEntityMetadata.bind(store),
    };
    await action({ deps, store, source, path: runLockPath(dir, deployment) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function state(store: InMemoryReplicaStore, id: string, expected: "pending" | "sending" | "failed", status: "sending" | "conflict" | "unknown" | "failed" | "pending", retryAfter?: string) {
  return store.transitionChangeRequest(deployment, id, expected, { status, ...(retryAfter && { retryAfter }) });
}

test("CLI submits explicit update bases and author", () => fixture(async ({ deps, store }) => {
  assert.equal(await runCli(["changes", "submit", "--object", "Account", "--record", sourceId,
    "--set", "Name=new", "--base", "Name=explicit", "--author", "agent:Fixture bot", "--reason", "fixture", "--json"], deps), 0);
  const [request] = await store.listChangeRequests(deployment);
  assert.equal(request?.authorLabel, "Fixture bot");
  assert.equal(request?.reason, "fixture");
  assert.deepEqual(request?.fields.Name, { base: "explicit", value: "new" });
}));

test("CLI fills bases from the replica and reports that on stderr", (t) => fixture(async ({ deps, store }) => {
  const stderr = t.mock.method(console, "error", () => {});
  assert.equal(await runCli(["changes", "submit", "--object", "Account", "--record", sourceId, "--set", "Name=new"], deps), 0);
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /Base values were read from the replica/);
  assert.deepEqual((await store.listChangeRequests(deployment))[0]?.fields, update.fields);
}));

test("CLI list and show return filtered JSON arrays and a request object", (t) => fixture(async ({ deps, store }) => {
  const stdout = t.mock.method(console, "log", () => {});
  const request = await submitChange(store, update);
  const run = (...args: string[]) => runCli(["changes", ...args, "--json"], deps);
  for (const [args, expected] of [
    [["list", "--status", "pending", "--object", "Account"], [request]],
    [["list", "--status", "applied"], []],
    [["show", request.id], request],
  ] as const) {
    assert.equal(await run(...args), 0);
    assert.deepEqual(JSON.parse(String(stdout.mock.calls.at(-1)?.arguments[0])), JSON.parse(JSON.stringify(expected)));
  }
}));

test("CLI retry only requeues failed requests", () => fixture(async ({ deps, store }) => {
  const { id } = await submitChange(store, update);
  const args = ["changes", "retry", id];
  assert.equal(await runCli(args, deps), 1);
  await state(store, id, "pending", "sending");
  await state(store, id, "sending", "failed");
  assert.equal(await runCli(args, deps), 0);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "pending");
}));

test("CLI override only applies to conflicts and records the decision under the run lock", () => fixture(async ({ deps, store, source, path }) => {
  const { id } = await submitChange(store, update);
  const args = ["changes", "override", id, "--keep", "replica", "--operator", "fixture"];
  assert.equal(await runCli(args, deps), 1);
  await state(store, id, "pending", "sending");
  await state(store, id, "sending", "conflict");
  const send = source.send;
  source.send = async (change) => {
    assert.ok((await stat(path)).isFile());
    assert.equal(change.overrideConflict, true);
    return send(change);
  };
  assert.equal(await runCli(args, deps), 0);
  const request = await store.getChangeRequest(deployment, id);
  assert.equal(request?.status, "applied");
  assert.equal(request?.overrideDecision?.operatorLabel, "fixture");
}));

test("CLI resolve accepts exactly one choice and only from unknown", () => fixture(async ({ deps, store }) => {
  const { id } = await submitChange(store, create);
  const args = ["changes", "resolve", id, "--operator", "fixture"];
  assert.equal(await runCli([...args, "--resubmit"], deps), 1);
  await state(store, id, "pending", "sending");
  await state(store, id, "sending", "unknown");
  assert.equal(await runCli([...args, "--abandon", "--resubmit"], deps), 1);
  assert.equal(await runCli([...args, "--link", sourceId], deps), 0);
  const request = await store.getChangeRequest(deployment, id);
  assert.equal(request?.status, "applied");
  assert.equal(request?.resultingSourceId, sourceId);
  assert.match(request?.statusDetail ?? "", /operator: fixture/);
}));

test("processing sends pending and retry-due requests oldest first", async (t) => fixture(async ({ deps, store, source }) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-23T20:00:00Z") });
  const first = await submitChange(store, { ...create, authorLabel: "first" });
  t.mock.timers.tick(1);
  const second = await submitChange(store, { ...create, authorLabel: "second" });
  t.mock.timers.tick(1);
  const deferred = await submitChange(store, { ...create, authorLabel: "deferred" });
  for (const [id, retry] of [[first.id, "0"], [deferred.id, "3600"]] as const) {
    await state(store, id, "pending", "sending");
    await state(store, id, "sending", "failed", retry);
  }
  assert.equal(await runCli(["changes", "process"], deps), 0);
  assert.deepEqual(source.sent.map(({ authorLabel }) => authorLabel), ["first", "second"]);
  assert.equal((await store.getChangeRequest(deployment, deferred.id))?.status, "failed");
}));

test("a busy lock stops processing without claiming pending work", () => fixture(async ({ deps, store, source }) => {
  const { id } = await submitChange(store, update);
  const lock = await deps.acquireRunLock!(deployment, "records");
  try {
    assert.equal(await runCli(["changes", "process"], deps), 1);
    assert.equal((await store.getChangeRequest(deployment, id))?.status, "pending");
    assert.equal(source.sent.length, 0);
  } finally {
    await lock.release();
  }
}));

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a waiting sync runs between watch batches", () => fixture(async ({ deps, store, source }) => {
  const entered = latch();
  const finishSend = latch();
  const syncWaiting = latch();
  const events: string[] = [];
  const handler = new Map<string, () => Promise<void>>();
  deps.onSignal = (signal, stop) => { handler.set(signal, stop); return () => { handler.delete(signal); }; };
  const send = source.send;
  source.send = async (change) => {
    events.push(change.authorLabel);
    if (change.authorLabel === "first") {
      entered.resolve();
      await finishSend.promise;
    }
    return send(change);
  };
  source.fetchChanges = async function* () {
    events.push("sync");
    yield { records: [], nextCheckpoint: null };
  };
  const acquire = deps.acquireRunLock!;
  deps.acquireRunLock = (id, command) => {
    if (command === "records") syncWaiting.resolve();
    return acquire(id, command);
  };
  await submitChange(store, { ...update, authorLabel: "first" });
  let sync: Promise<number>;
  let batches = 0;
  deps.waitForChangesBatch = async () => {
    if (++batches === 1) {
      assert.equal(await sync, 0);
      await submitChange(store, { ...update, authorLabel: "second" });
    } else await handler.get("SIGINT")!();
  };
  const watch = runCli(["changes", "process", "--watch"], deps);
  await entered.promise;
  sync = runCli(["records"], deps);
  await syncWaiting.promise;
  finishSend.resolve();
  assert.equal(await watch, 130);
  assert.deepEqual(events, ["first", "sync", "second"]);
}));

test("a watch signal finishes the active request and releases the lock", () => fixture(async ({ deps, store, source, path }) => {
  const handlers = new Map<string, () => Promise<void>>();
  deps.onSignal = (signal, stop) => { handlers.set(signal, stop); return () => { handlers.delete(signal); }; };
  const { id } = await submitChange(store, update);
  const send = source.send;
  source.send = async (change) => {
    await handlers.get("SIGINT")!();
    assert.equal((await store.getChangeRequest(deployment, id))?.status, "sending");
    assert.ok((await stat(path)).isFile());
    return send(change);
  };
  assert.equal(await runCli(["changes", "process", "--watch"], deps), 130);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "applied");
  assert.equal(handlers.size, 0);
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("an interrupted update requeues and goes through the conflict check", () => fixture(async ({ deps, store, source }) => {
  const { id } = await submitChange(store, update);
  await state(store, id, "pending", "sending");
  await recoverSending(store, deployment);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "pending");
  await state(store, id, "pending", "sending");
  assert.equal(await runCli(["changes", "process"], deps), 0);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "applied");
  assert.equal(source.sent[0]?.overrideConflict, false);
}));

test("an interrupted create becomes unknown without another send", () => fixture(async ({ deps, store, source }) => {
  const { id } = await submitChange(store, create);
  await state(store, id, "pending", "sending");
  assert.equal(await runCli(["changes", "process"], deps), 0);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "unknown");
  assert.equal(source.sent.length, 0);
}));

test("submission leaves the replica alone until the source returns refreshed values", () => fixture(async ({ deps, store, source }) => {
  await submitChange(store, update);
  const name = () => store.readRecords(deployment, account.key)[0]?.fields.Name;
  assert.equal(name(), "old");
  const send = source.send;
  source.send = async (change) => {
    assert.equal(name(), "old");
    return send(change);
  };
  assert.equal(await runCli(["changes", "process"], deps), 0);
  assert.equal(name(), "new (refreshed)");
}));

test("an unexpected writer exception does not leave a request sending", () => fixture(async ({ deps, store, source, path }) => {
  const { id } = await submitChange(store, create);
  source.send = async () => { throw new Error("fixture writer interrupted"); };
  assert.equal(await runCli(["changes", "process"], deps), 1);
  assert.equal((await store.getChangeRequest(deployment, id))?.status, "unknown");
  await assert.rejects(stat(path), { code: "ENOENT" });
}));

test("PostgreSQL bases use the persisted typed values", () => sqlFixture(async (_db, store) => {
  await store.persistRecords(deployment, account, {
    records: [{ sourceId, fields: { Name: "old", Score: 1.5 } }], nextCheckpoint: null,
  });
  assert.deepEqual(await store.readWritebackValues(deployment, account.key, sourceId), { Name: "old", Score: "1.5" });
}));
