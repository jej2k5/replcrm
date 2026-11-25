import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import type { CanonicalAttribute, CanonicalEntity } from "../src/core/source.js";
import { normalizeMetadata } from "../src/sources/salesforce/metadata.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { projectionLayout, quoteIdentifier } from "../src/stores/postgres/wide-view-sync.js";
import { database } from "./helpers/database.js";
import { account, accountDescribe, deployment } from "./helpers/writeback.js";

const attr = (key: string): CanonicalAttribute => ({ key, label: key, dataType: "Text" });
const object = (key: string, ...keys: string[]): CanonicalEntity => ({
  key, label: key, pluralLabel: key, attributes: keys.map(attr),
});
const table = "wide." + quoteIdentifier(projectionLayout(deployment, account.key, []).tableName);

async function fixture(t: TestContext, { enabled = false, entities = [account] } = {}) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  await store.ensureDeployment(deployment, deployment);
  const refresh = async (definitions = entities, rebuild = false) => {
    await store.persistMetadata(deployment, definitions);
    return store.ensureProjections(deployment, definitions, { rebuild });
  };
  if (entities.includes(account)) {
    await store.persistMetadata(deployment, [account]);
    await store.persistRecords(deployment, account, {
      records: [{ sourceId: "fixture-record", fields: { Name: "Original", Score: 5 } }], nextCheckpoint: null,
    });
    if (enabled) await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
  }
  await refresh();
  const views = () => store.listReplicaViews(deployment);
  const queue = () => store.listChangeRequests(deployment);
  return { db, prisma, store, refresh, views, queue };
}

test("object and field aliases split camel case, acronym boundaries and digit groups", async (t) => {
  const f = await fixture(t, { entities: [object("HTTPServer42Status", "CloseDate", "Rate42USD", "___A!?B__")] });
  const [view] = await f.views();
  assert.equal(view?.view, "replica.http_server_42_status");
  assert.deepEqual(Object.fromEntries(view!.columns.map(({ sourceField, column }) => [sourceField, column])),
    { CloseDate: "close_date", Rate42USD: "rate_42_usd", "___A!?B__": "a_b" });
  await f.db.query("SELECT close_date, rate_42_usd, a_b FROM replica.http_server_42_status");
});

test("the source adapter supplies aliases without the custom suffix", async (t) => {
  const custom = normalizeMetadata({
    ...accountDescribe, name: "OrderLine__c", custom: true,
    fields: [{ ...accountDescribe.fields[0]!, name: "DeliveryDate__c", custom: true }],
  });
  const f = await fixture(t, { entities: [custom] });
  const [view] = await f.views();
  assert.equal(view?.view, "replica.order_line");
  assert.deepEqual(view?.columns, [{ sourceField: "DeliveryDate__c", column: "delivery_date", suffixed: false }]);
});

test("long identifiers fit PostgreSQL and retain a distinguishing hash", async (t) => {
  const prefix = "LongName".repeat(12);
  const entity = object(prefix + "A", prefix + "A", prefix + "B");
  const f = await fixture(t, { entities: [entity] });
  const [view] = await f.views();
  const aliases = view!.columns.map(({ column }) => column);
  for (const alias of [view!.view.split(".")[1]!, ...aliases]) {
    assert.equal(Buffer.byteLength(alias), 63);
    assert.match(alias, /_[0-9a-f]{10}$/);
  }
  assert.notEqual(aliases[0], aliases[1]);
  await f.refresh();
  assert.deepEqual(await f.views(), [view]);
});

test("object, reserved word and housekeeping collisions get stable numeric suffixes", async (t) => {
  const entities = [object("CustomThing", "RecordId", "Select", "A_B", "a_b"), object("custom_thing"), object("Select")];
  const f = await fixture(t, { entities });
  const before = await f.views();
  const first = before.find(({ entityKey }) => entityKey === "CustomThing")!;
  assert.equal(first.view, "replica.custom_thing");
  assert.deepEqual(new Map(first.columns.map(({ sourceField, column }) => [sourceField, column])),
    new Map([["A_B", "a_b"], ["a_b", "a_b_2"], ["RecordId", "record_id_2"], ["Select", "select_2"]]));
  assert.ok(before.some(({ view, suffixed }) => view === "replica.custom_thing_2" && suffixed));
  assert.ok(before.some(({ view, suffixed }) => view === "replica.select_2" && suffixed));
  await f.refresh([...entities].reverse());
  assert.deepEqual(await new PostgresReplicaStore(f.prisma).listReplicaViews(deployment), before);
});

test("view rows match the wide projection and preserve housekeeping names", async (t) => {
  const f = await fixture(t);
  const wide = await f.db.query('SELECT record_id, source_id, is_deleted, "Name" AS name, "Score" AS score FROM ' + table);
  const view = await f.db.query("SELECT record_id, source_id, is_deleted, name, score FROM replica.account");
  assert.equal(wide.rows.length, 1);
  assert.deepEqual(view.rows, wide.rows);
});

test("UPDATE through the view queues original bases and leaves live values unchanged", async (t) => {
  const f = await fixture(t, { enabled: true });
  await f.db.query("UPDATE replica.account SET name = 'Proposed', score = 9");
  const [request] = await f.queue();
  assert.equal(request?.operation, "update");
  assert.equal(request?.targetSourceId, "fixture-record");
  assert.deepEqual(request?.fields, { Name: { base: "Original", value: "Proposed" }, Score: { base: 5, value: 9 } });
  assert.deepEqual((await f.db.query("SELECT name FROM replica.account")).rows, [{ name: "Original" }]);
});

test("INSERT through the view queues a create without storing a row", async (t) => {
  const f = await fixture(t, { enabled: true });
  await f.db.query("INSERT INTO replica.account (name) VALUES ('Proposed')");
  const [request] = await f.queue();
  assert.equal(request?.operation, "create");
  assert.deepEqual(request?.fields, { Name: { value: "Proposed" } });
  assert.deepEqual((await f.db.query("SELECT name FROM replica.account")).rows, [{ name: "Original" }]);
});

test("DELETE fails with the write-back message and queues nothing", async (t) => {
  const f = await fixture(t, { enabled: true });
  await assert.rejects(f.db.query("DELETE FROM replica.account"), /deletes are not supported by write-back/);
  await f.store.editWritebackPolicy(deployment, "Account", { action: "disable" });
  await assert.rejects(f.db.query("DELETE FROM replica.account"), /deletes are not supported by write-back/);
  assert.deepEqual(await f.queue(), []);
});

test("blocked fields fail through the view", async (t) => {
  const f = await fixture(t, { enabled: true });
  await assert.rejects(f.db.query("UPDATE replica.account SET total = 'blocked'"), /not writable.*Total/);
  assert.deepEqual(await f.queue(), []);
});

test("adding an attribute appends its alias without invalidating dependent views", async (t) => {
  const f = await fixture(t);
  await f.db.exec("CREATE VIEW public.fixture_account AS SELECT name FROM replica.account");
  await f.refresh([{ ...account, attributes: [attr("ARegion"), ...account.attributes] }]);
  assert.deepEqual((await f.db.query("SELECT a_region FROM replica.account")).rows, [{ a_region: null }]);
  assert.deepEqual((await f.db.query("SELECT * FROM fixture_account")).rows, [{ name: "Original" }]);
});

test("dropping an attribute removes its alias and preserves grants on retained columns", async (t) => {
  const f = await fixture(t);
  await f.db.exec("CREATE ROLE fixture_reader; GRANT SELECT (name) ON replica.account TO fixture_reader");
  await f.refresh([{ ...account, attributes: account.attributes.filter(({ key }) => key !== "Total") }]);
  await assert.rejects(f.db.query("SELECT total FROM replica.account"), /does not exist/);
  assert.equal((await f.views())[0]?.columns.some(({ sourceField }) => sourceField === "Total"), false);
  assert.deepEqual((await f.db.query("SELECT has_column_privilege('fixture_reader', 'replica.account', 'name', 'SELECT') AS readable")).rows,
    [{ readable: true }]);
});

test("explicit rebuild rebinds the view and preserves its grant and pending requests", async (t) => {
  const f = await fixture(t, { enabled: true });
  await f.db.exec("CREATE ROLE fixture_reader; GRANT SELECT ON replica.account TO fixture_reader WITH GRANT OPTION");
  await f.db.query("UPDATE replica.account SET name = 'Pending'");
  const pending = await f.queue();
  await f.refresh([account], true);
  assert.deepEqual(await f.queue(), pending);
  assert.deepEqual((await f.db.query("SELECT has_table_privilege('fixture_reader', 'replica.account', 'SELECT WITH GRANT OPTION') AS readable, name FROM replica.account")).rows,
    [{ readable: true, name: "Original" }]);
  await f.db.query("UPDATE replica.account SET name = 'Another proposal'");
  assert.equal((await f.queue()).length, 2);
});

test("objects list and objects columns report registered aliases", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "replcrm-view-cli-"));
  try {
    const deps = createProductionDeps({
      DEPLOYMENT_ID: deployment, REPLCRM_CONFIG_DIR: dir, DATABASE_URL: "postgresql://fixture.invalid/fixture",
    }, { prisma: () => f.prisma });
    const stdout = t.mock.method(console, "log", () => {});
    const output = () => String(stdout.mock.calls.at(-1)?.arguments[0]);
    assert.equal(await runCli(["objects", "list", "--json"], deps), 0);
    assert.deepEqual(JSON.parse(output()).views, await f.views());
    assert.equal(await runCli(["objects", "columns", "Account"], deps), 0);
    assert.match(output(), /replica\.account[\s\S]*record_id\trecord_id_2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two deployments cannot claim the same schema and can publish in separate schemas", async (t) => {
  const f = await fixture(t);
  const other = "fixture-other";
  await f.store.ensureDeployment(other, other);
  await f.store.persistMetadata(other, [account]);
  await assert.rejects(f.store.ensureProjections(other, [account]), /already used by another deployment/);
  await f.store.ensureProjections(other, [account], { replicaViewSchema: "other_replica" });
  await f.store.ensureProjections(other, [account]);
  assert.equal((await f.store.listReplicaViews(other))[0]?.view, "other_replica.account");
  assert.equal((await f.views())[0]?.view, "replica.account");
});


test("an explicit rebuild after dropping an attribute restores the view and surviving grants", async (t) => {
  const f = await fixture(t);
  await f.db.exec("CREATE ROLE fixture_reader; GRANT SELECT ON replica.account TO fixture_reader");
  await f.refresh([{ ...account, attributes: account.attributes.filter(({ key }) => key !== "Total") }], true);
  await assert.rejects(f.db.query("SELECT total FROM replica.account"), /does not exist/);
  assert.deepEqual((await f.db.query("SELECT has_table_privilege('fixture_reader', 'replica.account', 'SELECT') AS readable, name FROM replica.account")).rows,
    [{ readable: true, name: "Original" }]);
});

test("the console Objects page renders the registered view and copyable SQL", async (t) => {
  const f = await fixture(t);
  const deps = createProductionDeps({ DEPLOYMENT_ID: deployment }, { prisma: () => f.prisma });
  const handle = deps.createConsoleHandler!(4780);
  const page = await handle("GET", "/objects", { host: "127.0.0.1:4780" });
  assert.equal(page.status, 200);
  assert.match(page.body, /<code>replica\.account<\/code>/);
  assert.match(page.body, /<code data-replica-query>SELECT \* FROM replica\.account LIMIT 10<\/code>/);
  assert.match(page.body, /data-copy-query>Copy SQL/);
  await deps.close?.();
});

test("record roles remove duplicate aliases on upgrade and preserve housekeeping and genuine clashes", async (t) => {
  const system = ["OwnerId", "CreatedById", "LastModifiedById", "IsDeleted"];
  const normalized = normalizeMetadata({
    ...accountDescribe, name: "Audit",
    fields: system.map((name) => ({ ...accountDescribe.fields[0]!, name, type: name === "IsDeleted" ? "boolean" : "string" })),
  });
  assert.deepEqual(normalized.attributes.map(({ recordRole }) => recordRole),
    ["owner", "creator", "lastModifier", "deletionFlag"]);
  const upgraded = { ...normalized, attributes: [...normalized.attributes, attr("RecordId")] };
  const legacy = { ...upgraded, attributes: upgraded.attributes.map(({ recordRole: _ignored, ...attribute }) => attribute) };
  const f = await fixture(t, { entities: [legacy] });

  const users = ["owner", "creator", "modifier"].map((sourceId) => ({
    sourceId, username: sourceId, email: sourceId + "@example.test", firstName: null, lastName: sourceId, role: null, isActive: true,
  }));
  await f.store.persistUsers(deployment, users);
  await f.store.persistRecords(deployment, legacy, { records: [{
    sourceId: "fixture-audit", isDeleted: true, ownerSourceId: "owner", createdBySourceId: "creator",
    lastModifiedBySourceId: "modifier", fields: { RecordId: "a genuine clash", IsDeleted: true },
  }], nextCheckpoint: null });
  const aliases = ["owner_id_2", "created_by_id_2", "last_modified_by_id_2", "is_deleted_2"];
  const before = (await f.views())[0]!.columns.map(({ column }) => column);
  for (const alias of aliases) assert.ok(before.includes(alias));

  const [refresh] = await f.refresh([upgraded]);
  assert.equal(refresh?.rebuildReason, undefined);
  const [view] = await f.views();
  assert.deepEqual(view?.columns, [{ column: "record_id_2", sourceField: "RecordId", suffixed: true }]);
  const physical = await f.db.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'replica' AND table_name = 'audit'");
  for (const alias of aliases) assert.ok(!physical.rows.some(({ column_name }) => column_name === alias));

  const house = "owner_id, created_by_id, last_modified_by_id, is_deleted";
  const [row] = (await f.db.query(`SELECT ${house}, record_id_2 FROM replica.audit`)).rows;
  const ids = new Map((await f.db.query<{ id: string; sourceId: string }>('SELECT id, "sourceId" FROM "User"')).rows
    .map(({ id, sourceId }) => [sourceId, id]));
  assert.deepEqual(row, {
    owner_id: ids.get("owner"), created_by_id: ids.get("creator"), last_modified_by_id: ids.get("modifier"),
    is_deleted: true, record_id_2: "a genuine clash",
  });
  const wide = "wide." + quoteIdentifier(projectionLayout(deployment, "Audit", []).tableName);
  const physicalBefore = await f.db.query(`SELECT "OwnerId", "CreatedById", "LastModifiedById", "IsDeleted" FROM ${wide}`);
  assert.equal(physicalBefore.rows.length, 1);
  const oid = () => f.db.query("SELECT 'replica.audit'::regclass::oid AS oid");
  const established = await oid();
  await f.refresh([upgraded]);
  assert.deepEqual((await oid()).rows, established.rows);
});
