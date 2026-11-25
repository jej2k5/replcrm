import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { runCli } from "../src/cli.js";
import type { CanonicalAttribute, CanonicalEntity, ChangeBatch, SourceRecord } from "../src/core/source.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { projectionLayout, quoteIdentifier } from "../src/stores/postgres/wide-view-sync.js";
import { FakeSource, config } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { account, deployment } from "./helpers/writeback.js";

const first: SourceRecord = { sourceId: "fixture-first", fields: { Name: "Original", Score: 5 } };
const second: SourceRecord = { sourceId: "fixture-second", fields: { Name: "Unchanged", Score: 8 } };
const tableFor = (entity: CanonicalEntity) => "wide." + quoteIdentifier(projectionLayout(deployment, entity.key, []).tableName);
const added: CanonicalAttribute = { key: "Region", label: "Region", dataType: "Text" };
const extended = { ...account, attributes: [...account.attributes, added] };
const changeType = (key: string, dataType: CanonicalAttribute["dataType"]): CanonicalEntity => ({
  ...account, attributes: account.attributes.map((attr) => attr.key === key ? { ...attr, dataType } : attr),
});

async function fixture(t: TestContext, writeback = false, legacy = false) {
  const layout = projectionLayout(deployment, account.key, account.attributes.map(({ key }) => key));
  const table = tableFor(account);
  const { db, prisma } = await database(legacy ? async (db) => {
    await db.exec(`
      CREATE SCHEMA wide;
      CREATE TABLE wide.__replcrm_projections (
        deployment_id text NOT NULL, entity_key text NOT NULL, table_name text NOT NULL UNIQUE,
        column_map jsonb NOT NULL, PRIMARY KEY (deployment_id, entity_key)
      );
      CREATE TABLE ${table} (record_id text PRIMARY KEY, "Name" text, "Score" numeric);
    `);
    await db.query("INSERT INTO wide.__replcrm_projections VALUES ($1, $2, $3, $4::jsonb)",
      [deployment, account.key, layout.tableName, JSON.stringify(layout.attributeColumns)]);
  } : undefined);
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  const persist = (records: SourceRecord[], entity = account) => store.persistRecords(deployment, entity, { records, nextCheckpoint: null });
  const sync = async (entity = account, rebuild = false) => (await store.ensureProjections(deployment, [entity], { rebuild }))[0]!;
  const query = <T extends Record<string, unknown>>(sql: string) => db.query<T>(sql.replaceAll("WIDE_TABLE", table));
  const rows = async () => (await query<{ source_id: string; name: string; version: string; is_deleted: boolean }>(
    'SELECT source_id, "Name"::text AS name, xmin::text || ctid::text AS version, is_deleted FROM WIDE_TABLE ORDER BY source_id',
  )).rows;
  const oid = async () => (await db.query<{ oid: string }>("SELECT $1::regclass::oid::text AS oid", [table])).rows[0]!.oid;
  const watermark = async () => (await query<{ watermark: string | null }>(
    "SELECT watermark::text FROM wide.__replcrm_projections WHERE entity_key = 'Account'",
  )).rows[0]!.watermark;
  const attachments = async () => {
    await query("CREATE ROLE fixture_reader");
    await query('CREATE INDEX fixture_score ON WIDE_TABLE ("Score") WHERE "Score" IS NOT NULL');
    await query("GRANT SELECT ON WIDE_TABLE TO fixture_reader WITH GRANT OPTION");
    await query('GRANT UPDATE ("Name") ON WIDE_TABLE TO fixture_reader');
    await query("COMMENT ON TABLE WIDE_TABLE IS 'fixture table comment'");
    await query('COMMENT ON COLUMN WIDE_TABLE."Score" IS \'fixture column comment\'');
    await query("COMMENT ON INDEX wide.fixture_score IS 'fixture index comment'");
  };
  const assertAttachments = async () => {
    const result = await db.query(`
      SELECT has_table_privilege('fixture_reader', $1, 'SELECT WITH GRANT OPTION') AS readable,
        has_column_privilege('fixture_reader', $1, 'Name', 'UPDATE') AS writable,
        obj_description($1::regclass, 'pg_class') AS table_comment,
        (SELECT col_description(attrelid, attnum) FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'Score') AS column_comment,
        obj_description('wide.fixture_score'::regclass, 'pg_class') AS index_comment,
        pg_get_expr(indpred, indrelid) AS predicate
      FROM pg_index WHERE indexrelid = 'wide.fixture_score'::regclass AND indrelid = $1::regclass`, [table]);
    assert.deepEqual(result.rows, [{
      readable: true, writable: true, table_comment: "fixture table comment", column_comment: "fixture column comment",
      index_comment: "fixture index comment", predicate: '("Score" IS NOT NULL)',
    }]);
  };
  await store.ensureDeployment(deployment, deployment);
  await store.persistMetadata(deployment, [account]);
  await persist([first, second]);
  if (writeback) await store.editWritebackPolicy(deployment, account.key, { action: "enable" });
  if (!legacy) assert.equal((await sync()).rebuildReason, "first build");
  return { db, store, table, persist, sync, query, rows, oid, watermark, attachments, assertAttachments };
}

test("a one-record delta changes exactly one physical row version", async (t) => {
  const f = await fixture(t);
  const before = await f.rows();
  await f.persist([{ ...first, fields: { Name: "Updated" } }, second]);
  assert.equal((await f.sync()).rowsLoaded, 1);
  const [changed, unchanged] = await f.rows();
  assert.equal(changed?.name, "Updated");
  assert.notEqual(changed?.version, before[0]?.version);
  assert.deepEqual(unchanged, before[1]);
  assert.equal((await f.sync()).rowsLoaded, 0);
});

test("tombstones keep their flag and a purged store record disappears", async (t) => {
  const f = await fixture(t);
  await f.persist([{ ...first, fields: {}, isDeleted: true }]);
  await f.store.markDeleted(deployment, account.key, [second.sourceId]);
  await f.sync();
  assert.deepEqual((await f.rows()).map(({ is_deleted }) => is_deleted), [true, true]);
  await f.db.query('DELETE FROM "Record" WHERE "sourceId" = $1', [second.sourceId]);
  await f.sync();
  assert.deepEqual((await f.rows()).map(({ source_id, is_deleted }) => [source_id, is_deleted]), [[first.sourceId, true]]);
});

test("a user index, grants and comments survive ten incremental runs", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  await f.attachments();
  for (let i = 0; i < 10; i++) {
    await f.persist([{ ...first, fields: { Score: i } }]);
    assert.equal((await f.sync()).rowsLoaded, 1);
  }
  assert.equal(await f.oid(), before);
  await f.assertAttachments();
});

test("adding an attribute backfills only its values and keeps unrelated row versions", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  const other = (await f.rows())[1]!;
  await f.store.persistMetadata(deployment, [extended]);
  await f.persist([{ ...first, fields: { Region: "North" } }], extended);
  assert.equal((await f.sync(extended)).rowsLoaded, 0);
  assert.equal(await f.oid(), before);
  assert.deepEqual((await f.rows())[1], other);
  assert.deepEqual((await f.query('SELECT "Region" FROM WIDE_TABLE ORDER BY source_id')).rows, [{ Region: "North" }, { Region: null }]);
});

test("dropping an attribute leaves the table and historical store data intact", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  const definition = { ...account, attributes: account.attributes.filter(({ key }) => key !== "Score") };
  await f.store.persistMetadata(deployment, [definition]);
  await f.sync(definition);
  assert.equal(await f.oid(), before);
  await assert.rejects(f.query('SELECT "Score" FROM WIDE_TABLE'), /does not exist/);
  assert.equal((await f.store.readWritebackValues(deployment, account.key, first.sourceId))?.Score, "5");
});

test("a castable type change alters the existing table and keeps the cast value across deltas", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  const definition = changeType("Score", "Text");
  await f.store.persistMetadata(deployment, [definition]);
  assert.equal((await f.sync(definition)).rebuildReason, undefined);
  await f.persist([{ ...first, fields: { Name: "Changed" } }], definition);
  await f.sync(definition);
  assert.equal(await f.oid(), before);
  const [row] = (await f.query<{ type: string; score: string }>(
    'SELECT pg_typeof("Score")::text AS type, "Score" AS score FROM WIDE_TABLE ORDER BY source_id',
  )).rows;
  assert.equal(row?.type, "text");
  assert.equal(Number(row?.score), 5);
});

test("a failed cast swaps in a shadow with attachments, write-back triggers and the pending request", async (t) => {
  const f = await fixture(t, true);
  const before = await f.oid();
  await f.attachments();
  await f.query('UPDATE WIDE_TABLE SET "Name" = \'Queued\' WHERE source_id = \'fixture-first\'');
  const pending = await f.store.listChangeRequests(deployment);
  const definition = changeType("Name", "Number");
  await f.store.persistMetadata(deployment, [definition]);
  await f.persist([{ ...first, fields: { Name: 27 } }], definition);
  assert.match((await f.sync(definition)).rebuildReason ?? "", /cannot cast column Name/);
  assert.notEqual(await f.oid(), before);
  assert.deepEqual((await f.rows()).map(({ name }) => name === null ? null : Number(name)), [27, null]);
  await f.assertAttachments();
  assert.deepEqual(await f.store.listChangeRequests(deployment), pending);
  await f.query('UPDATE WIDE_TABLE SET "Name" = 29 WHERE source_id = \'fixture-first\'');
  assert.equal((await f.store.listChangeRequests(deployment)).length, 2);
  const triggers = await f.db.query<{ name: string }>(
    "SELECT tgname AS name FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname", [f.table],
  );
  assert.deepEqual(triggers.rows.map(({ name }) => name), ["replcrm_edit_delete", "replcrm_edit_insert", "replcrm_edit_update"]);
});

test("a dependent view and its downstream view survive and read the new table", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  await f.query(`CREATE VIEW fixture_view AS SELECT WIDE_TABLE."Name", 'WIDE_TABLE' AS literal FROM WIDE_TABLE`);
  await f.query('CREATE VIEW fixture_downstream AS SELECT "Name", literal FROM fixture_view');
  await f.persist([{ ...first, fields: { Name: "New source value" } }]);
  assert.equal((await f.sync(account, true)).rebuildReason, "explicit rebuild requested");
  assert.notEqual(await f.oid(), before);
  const data = (await f.query<{ Name: string; literal: string }>('SELECT * FROM fixture_downstream ORDER BY "Name"')).rows;
  assert.deepEqual(data, [{ Name: "New source value", literal: f.table }, { Name: "Unchanged", literal: f.table }]);
});

test("an incompatible dependent view names the blocker and leaves the old projection published", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  const watermark = await f.watermark();
  await f.query('CREATE VIEW fixture_blocker AS SELECT "Name" FROM WIDE_TABLE');
  const definition = changeType("Name", "Number");
  await f.store.persistMetadata(deployment, [definition]);
  await f.persist([{ ...first, fields: { Name: 12 } }], definition);
  await assert.rejects(f.sync(definition), /Cannot recreate dependent view "public"."fixture_blocker".*output columns would change/);
  assert.equal(await f.oid(), before);
  assert.equal(await f.watermark(), watermark);
  assert.deepEqual((await f.query('SELECT "Name" FROM fixture_blocker ORDER BY "Name"')).rows, [{ Name: "Original" }, { Name: "Unchanged" }]);
});

test("a failure after another object's upsert rolls back its rows and watermark", async (t) => {
  const f = await fixture(t);
  const other = { ...account, key: "Contact" };
  const otherTable = tableFor(other);
  await f.store.persistMetadata(deployment, [other]);
  await f.persist([first], other);
  await f.sync(other);
  await f.db.query(`ALTER TABLE ${otherTable} ADD CHECK ("Name" <> 'Invalid')`);
  const before = await f.rows();
  const watermark = await f.watermark();
  await f.persist([{ ...first, fields: { Name: "Updated" } }]);
  await f.persist([{ ...first, fields: { Name: "Invalid" } }], other);
  await assert.rejects(f.store.ensureProjections(deployment, [account, other]), /violates check constraint/);
  assert.deepEqual(await f.rows(), before);
  assert.equal(await f.watermark(), watermark);
  assert.equal((await f.sync()).rowsLoaded, 1);
  assert.notEqual(await f.watermark(), watermark);
});

test("CLI records publishes deltas when enabled and projections --rebuild reports its reason", async (t) => {
  const f = await fixture(t);
  const before = await f.oid();
  const source = new class extends FakeSource {
    override async describeEntity() { return account; }
    override async *fetchChanges(): AsyncGenerator<ChangeBatch> {
      yield { records: [{ ...first, fields: { Name: "Synced by records" } }], nextCheckpoint: "fixture-checkpoint" };
    }
  }();
  const deps = {
    loadConfig: () => ({ ...config, deploymentId: deployment, entityKeys: [account.key], buildWideViews: true }),
    createSource: () => source,
    createStore: () => f.store,
    deploymentExists: f.store.deploymentExists.bind(f.store),
    ensureDeployment: f.store.ensureDeployment.bind(f.store),
    hasEntityMetadata: f.store.hasEntityMetadata.bind(f.store),
  };
  assert.equal(await runCli(["records"], deps), 0);
  assert.equal((await f.rows())[0]?.name, "Synced by records");
  assert.equal(await f.oid(), before);
  const log = t.mock.method(console, "log", () => {});
  assert.equal(await runCli(["projections", "--rebuild"], deps), 0);
  assert.ok(log.mock.calls.some(({ arguments: [message] }) =>
    String(message).includes("Rebuilt projection for Account (explicit rebuild requested)")));
  assert.notEqual(await f.oid(), before);
});

test("projection inserts, updates, purges and rebuilds create no change requests", async (t) => {
  const f = await fixture(t, true);
  await f.persist([{ ...first, fields: { Name: "Changed" } }, { ...first, sourceId: "fixture-new" }]);
  await f.db.query('DELETE FROM "Record" WHERE "sourceId" = $1', [second.sourceId]);
  await f.sync();
  await f.sync(account, true);
  assert.deepEqual(await f.store.listChangeRequests(deployment), []);
});

test("a legacy projection receives its first watermark and rebuilds just once", async (t) => {
  const f = await fixture(t, false, true);
  assert.equal(await f.watermark(), null);
  await f.attachments();
  const before = await f.oid();
  assert.equal((await f.sync()).rebuildReason, "upgrade from legacy projection");
  const upgraded = await f.oid();
  assert.notEqual(upgraded, before);
  assert.notEqual(await f.watermark(), null);
  await f.assertAttachments();
  await f.persist([{ ...first, fields: { Name: "After upgrade" } }]);
  assert.equal((await f.sync()).rebuildReason, undefined);
  assert.equal(await f.oid(), upgraded);
  assert.equal((await f.rows())[0]?.name, "After upgrade");
});

test("an owner rename refreshes owned records without changing other row versions", async (t) => {
  const f = await fixture(t);
  const user = {
    sourceId: "fixture-owner", username: "Before rename", email: "owner@example.test",
    firstName: null, lastName: "Owner", role: null, isActive: true,
  };
  await f.store.persistUsers(deployment, [user]);
  await f.persist([{ ...first, ownerSourceId: user.sourceId }]);
  await f.sync();
  const other = (await f.rows())[1];
  await f.store.persistUsers(deployment, [{ ...user, username: "After rename" }]);
  assert.equal((await f.sync()).rowsLoaded, 1);
  assert.deepEqual((await f.query("SELECT owner_username FROM WIDE_TABLE ORDER BY source_id")).rows,
    [{ owner_username: "After rename" }, { owner_username: null }]);
  assert.deepEqual((await f.rows())[1], other);
});
