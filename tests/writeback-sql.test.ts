import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CanonicalEntity, SourceRecord } from "../src/core/source.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { projectionLayout, quoteIdentifier } from "../src/stores/postgres/wide-view-sync.js";
import { ChangeRequestProcessor } from "../src/writeback/processor.js";
import { database } from "./helpers/database.js";
import { account, deployment } from "./helpers/writeback.js";

const original: SourceRecord = { sourceId: "fixture-account", fields: { Name: "Old name", Score: 5 } };
const location = (entity: CanonicalEntity) =>
  "wide." + quoteIdentifier(projectionLayout(deployment, entity.key, entity.attributes.map(({ key }) => key)).tableName);

async function fixture(t: TestContext, { enabled = true, entity = account } = {}) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  await store.ensureDeployment(deployment, deployment);
  await store.persistMetadata(deployment, [entity]);
  const persist = (row: SourceRecord) =>
    store.persistRecords(deployment, entity, { records: [row], nextCheckpoint: null });
  await persist(original);
  const policy = (action: "enable" | "disable") => store.editWritebackPolicy(deployment, entity.key, { action });
  if (enabled) await policy("enable");
  const rebuild = (force = false) => store.ensureProjections(deployment, [entity], { rebuild: force });
  await rebuild();
  const table = location(entity);
  const run = (statement: string) => db.query<Record<string, unknown>>(statement.replaceAll("WIDE_TABLE", table));
  const queue = () => store.listChangeRequests(deployment);
  const triggers = async () => (await db.query<{ tgname: string }>(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname", [table],
  )).rows.map(({ tgname }) => tgname);
  return { db, store, table, run, queue, rebuild, policy, persist, triggers };
}

const editName = 'UPDATE WIDE_TABLE SET "Name" = \'Proposed name\'';
const names = 'SELECT "Name" FROM WIDE_TABLE';

test("UPDATE queues changed fields with their old bases and leaves the row unchanged", async (t) => {
  const f = await fixture(t);
  await f.run('UPDATE WIDE_TABLE SET "Name" = \'Proposed name\', "Score" = 8');
  const [request] = await f.queue();
  const [row] = (await f.run('SELECT * FROM WIDE_TABLE')).rows;
  assert.equal(request?.operation, "update");
  assert.equal(request?.targetRecordId, row?.record_id);
  assert.equal(request?.targetSourceId, original.sourceId);
  assert.deepEqual(request?.fields, { Name: { base: "Old name", value: "Proposed name" }, Score: { base: 5, value: 8 } });
  assert.equal(row?.Name, "Old name");
  assert.equal(Number(row?.Score), 5);
});

test("UPDATE of a blocked attribute rejects the whole edit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(editName + ', "Total" = \'not writable\''), /not writable.*Total/);
  assert.deepEqual(await f.queue(), []);
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Old name" }]);
});

test("UPDATE of housekeeping columns reports each changed column", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("UPDATE WIDE_TABLE SET source_id = 'other', is_deleted = true"), /not writable.*is_deleted, source_id/);
  assert.deepEqual(await f.queue(), []);
});

test("unchanged values are ignored and nullable fields can be cleared", async (t) => {
  const f = await fixture(t);
  await f.run('UPDATE WIDE_TABLE SET "Name" = "Name"');
  assert.deepEqual(await f.queue(), []);
  await f.run('UPDATE WIDE_TABLE SET "Score" = NULL');
  assert.deepEqual((await f.queue())[0]?.fields, { Score: { base: 5, value: null } });
});

test("INSERT queues a create without keeping a projection row", async (t) => {
  const f = await fixture(t);
  await f.run('INSERT INTO WIDE_TABLE ("Name") VALUES (\'New name\')');
  const [request] = await f.queue();
  assert.equal(request?.operation, "create");
  assert.equal(request?.targetRecordId, null);
  assert.equal(request?.targetSourceId, null);
  assert.deepEqual(request?.fields, { Name: { value: "New name" } });
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Old name" }]);
});

test("INSERT checks required fields and refuses blocked fields", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('INSERT INTO WIDE_TABLE DEFAULT VALUES'), /Name is required on create/);
  await assert.rejects(f.run('INSERT INTO WIDE_TABLE ("Name", "Score") VALUES (\'New name\', 10)'), /not writable.*Score/);
  assert.deepEqual(await f.queue(), []);
});

test("DELETE is refused without a request", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("DELETE FROM WIDE_TABLE"), /deletes are not supported by write-back/);
  assert.deepEqual(await f.queue(), []);
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Old name" }]);
});

test("author defaults to the database session user and honors replcrm.author", async (t) => {
  const f = await fixture(t);
  await f.run(editName);
  const [first] = await f.queue();
  assert.equal(first?.authorLabel, (await f.db.query<{ label: string }>("SELECT session_user AS label")).rows[0]?.label);
  assert.equal(first?.authorKind, "person");
  await f.db.transaction(async (tx) => {
    await tx.query("SET LOCAL replcrm.author = 'SQL editor'");
    await tx.query(editName.replace("WIDE_TABLE", f.table));
  });
  assert.equal((await f.queue()).find(({ id }) => id !== first?.id)?.authorLabel, "SQL editor");
});

test("sync bypasses all projection triggers and the setting resets after the transaction", async (t) => {
  const f = await fixture(t);
  await f.db.transaction(async (tx) => {
    await tx.query("SET LOCAL replcrm.sync = 'on'");
    await tx.query(editName.replace("WIDE_TABLE", f.table));
    await tx.query('INSERT INTO ' + f.table + ' (record_id, "Name") VALUES (\'internal\', \'Internal row\')');
    await tx.query("DELETE FROM " + f.table + " WHERE record_id = 'internal'");
  });
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Proposed name" }]);
  assert.deepEqual(await f.queue(), []);
  await f.run(editName.replace("Proposed name", "User edit"));
  assert.equal((await f.queue()).length, 1);
});

test("record sync and projection population never enqueue their writes", async (t) => {
  const f = await fixture(t);
  await f.persist({ ...original, fields: { Name: "Source update" } });
  await f.rebuild();
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Source update" }]);
  assert.deepEqual(await f.queue(), []);
});

test("rebuild preserves the exact pending request and reinstalls all triggers", async (t) => {
  const f = await fixture(t);
  await f.run(editName);
  const before = await f.queue();
  await f.rebuild(true);
  assert.deepEqual(await f.queue(), before);
  assert.deepEqual(await f.triggers(), ["replcrm_edit_delete", "replcrm_edit_insert", "replcrm_edit_update"]);
  await f.run(editName);
  assert.equal((await f.queue()).length, 2);
});

test("disabling removes triggers immediately and keeps the existing queue", async (t) => {
  const f = await fixture(t);
  await f.run(editName);
  const before = await f.queue();
  await f.policy("disable");
  assert.deepEqual(await f.triggers(), []);
  await f.rebuild();
  assert.deepEqual(await f.triggers(), []);
  await f.run(editName);
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Proposed name" }]);
  assert.deepEqual(await f.queue(), before);
});

test("pending_edits exposes pending, conflict and unknown fields for the record", async (t) => {
  const f = await fixture(t);
  for (const status of ["pending", "conflict", "unknown", "applied"] as const) {
    await f.run(editName.replace("Proposed name", status));
    const request = (await f.queue()).find(({ fields }) => fields.Name?.value === status)!;
    if (status !== "pending") {
      await f.store.transitionChangeRequest(deployment, request.id, "pending", { status: "sending" });
      await f.store.transitionChangeRequest(deployment, request.id, "sending", { status });
    }
  }
  const { rows } = await f.db.query<{ status: string }>("SELECT deployment_id, entity_key, record_id, source_id, status, fields FROM writeback.pending_edits ORDER BY status");
  assert.deepEqual(rows.map(({ status }) => status), ["pending", "conflict", "unknown"]);
  const [record] = (await f.run("SELECT record_id FROM WIDE_TABLE")).rows;
  for (const row of rows) {
    assert.deepEqual(row, { deployment_id: deployment, entity_key: account.key, record_id: record?.record_id,
      source_id: original.sourceId, status: row.status, fields: { Name: { base: "Old name", value: row.status } } });
  }
});

test("processing and then syncing publishes the confirmed source value with no echo", async (t) => {
  const f = await fixture(t);
  await f.run(editName);
  const [request] = await f.queue();
  const confirmed = { ...original, fields: { Name: "Source-normalized name" } };
  const processor = new ChangeRequestProcessor(f.store, {
    applyChange: async ({ fields }) => {
      assert.deepEqual(fields, request?.fields);
      return { status: "applied", sourceId: original.sourceId, modifiedAt: null, record: confirmed };
    },
  });
  assert.equal((await processor.processChange(request!)).status, "applied");
  await f.persist(confirmed);
  await f.rebuild();
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Source-normalized name" }]);
  assert.deepEqual((await f.queue()).map(({ status }) => status), ["applied"]);
});

test("an object without write-back has a plain table until enabled", async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.deepEqual(await f.triggers(), []);
  await f.run(editName);
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Proposed name" }]);
  assert.deepEqual(await f.queue(), []);
  await f.policy("enable");
  await f.run(editName.replace("Proposed name", "Queued edit"));
  assert.equal((await f.queue()).length, 1);
});

test("policy exclusions take effect on a published projection", async (t) => {
  const f = await fixture(t);
  await f.store.editWritebackPolicy(deployment, account.key, { action: "exclude", keys: ["Name"] });
  await assert.rejects(f.run(editName), /not writable.*Name/);
  assert.deepEqual(await f.queue(), []);
  await f.store.editWritebackPolicy(deployment, account.key, { action: "include", keys: ["Name"] });
  await f.run(editName);
  assert.equal((await f.queue()).length, 1);
});

test("SQL edits normalize timestamps and map local IDs for reference fields", async (t) => {
  const entity: CanonicalEntity = { ...account, attributes: [
    ...account.attributes,
    { key: "Appointment", label: "Appointment", dataType: "DateTime", isUpdatable: true, isNullable: true },
    { key: "Related", label: "Related", dataType: "Reference", isUpdatable: true, isNullable: true,
      relationship: { kind: "Hierarchy", targetEntityKeys: [account.key], name: "Related", cascadeDelete: false } },
  ] };
  const f = await fixture(t, { entity });
  const [record] = (await f.run("SELECT record_id FROM WIDE_TABLE")).rows;
  await f.db.query('UPDATE ' + f.table + ' SET "Appointment" = $1, "Related" = $2', ["2026-05-01T12:00:00+02:00", record?.record_id]);
  assert.deepEqual((await f.queue())[0]?.fields, {
    Appointment: { base: null, value: "2026-05-01T10:00:00.000Z" },
    Related: { base: null, value: { kind: "reference", entityKey: account.key, sourceId: original.sourceId } },
  });
});

test("a rejected row rolls back requests from other rows in the statement", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run('INSERT INTO WIDE_TABLE ("Name") VALUES (\'Valid name\'), (NULL)'), /Name is required on create/);
  assert.deepEqual(await f.queue(), []);
  assert.deepEqual((await f.run(names)).rows, [{ Name: "Old name" }]);
});

test("a confirmed create appears in the rebuilt projection once under its linked ID", async (t) => {
  const f = await fixture(t);
  await f.run('INSERT INTO WIDE_TABLE ("Name") VALUES (\'New name\')');
  const [request] = await f.queue();
  const confirmed = { sourceId: "fixture-created", fields: { Name: "Confirmed name" } };
  const processor = new ChangeRequestProcessor(f.store, {
    applyChange: async () => ({ status: "applied", sourceId: confirmed.sourceId, modifiedAt: null, record: confirmed }),
  });
  assert.equal((await processor.processChange(request!)).resultingSourceId, confirmed.sourceId);
  await f.rebuild();
  const { rows } = await f.run('SELECT source_id, "Name" FROM WIDE_TABLE ORDER BY source_id');
  assert.deepEqual(rows, [
    { source_id: original.sourceId, Name: "Old name" },
    { source_id: confirmed.sourceId, Name: "Confirmed name" },
  ]);
  assert.equal((await f.queue()).length, 1);
});
