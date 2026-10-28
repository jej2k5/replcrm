import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { PGlite } from "@electric-sql/pglite";
import { database } from "./helpers/database.js";
import { runReplication } from "../src/core/orchestrator.js";
import type { CanonicalAttribute, CanonicalEntity, CanonicalValue, ChangeBatch, CrmSource, SourceRecord, SourceUser } from "../src/core/source.js";
import { readTypedValue, toTypedValue } from "../src/core/type-mapper.js";
import { projectionLayout, quoteIdentifier } from "../src/stores/postgres/wide-view-sync.js";

let db: PGlite;
let prisma: PrismaClient;
before(async (): Promise<void> => { ({ db, prisma } = await database()); });
after(async (): Promise<void> => { await db?.close(); });
function definition(key: string, attributes: CanonicalAttribute[] = []): CanonicalEntity { return { key, label: key, pluralLabel: key, attributes }; }
function canonicalSource(definitions: CanonicalEntity[], changes: (entity: CanonicalEntity, checkpoint: string | null) => AsyncGenerator<ChangeBatch>): CrmSource {
  return {
    connect: async (): Promise<void> => {}, logout: async (): Promise<void> => {},
    listEntities: async (): Promise<string[]> => definitions.map((entity: CanonicalEntity): string => entity.key),
    describeEntity: async (key: string): Promise<CanonicalEntity> => definitions.find((entity: CanonicalEntity): boolean => entity.key === key)!,
    fetchChanges: changes,
    streamUsers: async function* (): AsyncGenerator<SourceUser[]> {},
  };
}
async function seed(id: string): Promise<void> { await prisma.deployment.create({ data: { id, name: id } }); }
async function replicate(id: string, source: CrmSource, project: boolean = true): Promise<void> {
  await runReplication({ store: new PostgresReplicaStore(prisma), sourceClient: source, config: { deploymentId: id, entityKeys: ["*"], entityDenyKeys: [], batchSize: 2, buildWideViews: project } });
}

test("canonical source round-trips values, qualified identities, opaque checkpoints and opaque keys through PostgreSQL", async (): Promise<void> => {
  const id: string = "contract/tenant.with-punctuation";
  await seed(id);
  await db.exec("SET TIME ZONE 'America/Chicago'");
  const attributes: CanonicalAttribute[] = [
    { key: "display.name", label: "Name", dataType: "Text" },
    { key: "segment", label: "Segment", dataType: "Enum", enumOptions: [{ value: "enterprise", label: "Enterprise", isActive: true, isDefault: false, sortOrder: 0 }] },
    { key: "empty", label: "Empty", dataType: "Text" },
    { key: "amount", label: "Amount", dataType: "Number" },
    { key: "active", label: "Active", dataType: "Boolean" },
    { key: "day", label: "Day", dataType: "Date" },
    { key: "instant", label: "Instant", dataType: "DateTime" },
    { key: "time", label: "Time", dataType: "Time" },
    { key: "nothing", label: "Nothing", dataType: "Text" },
    { key: "tags", label: "Tags", dataType: "MultiEnum" },
    { key: "address", label: "Object", dataType: "Address" },
    { key: "customer", label: "Customer", dataType: "Reference", relationship: { targetEntityKeys: ["customer"], kind: "Reference", name: "customer", cascadeDelete: false } },
    { key: "polymorphic", label: "Qualified multi-target", dataType: "Reference", relationship: { targetEntityKeys: ["customer", "order"], kind: "Reference", name: "polymorphic", cascadeDelete: false } },
    { key: "ambiguous", label: "Unresolved", dataType: "Reference", relationship: { targetEntityKeys: ["customer", "order"], kind: "Reference", name: "ambiguous", cascadeDelete: false } },
    { key: "record_id", label: "Collision with housekeeping", dataType: "Text" },
    { key: 'quote"and\'space', label: "Quoted", dataType: "Text" },
    { key: "x".repeat(100), label: "Long", dataType: "Text" },
  ];
  const definitions: CanonicalEntity[] = [definition("customer.profile", attributes), ...["customer", "order", "foo.bar", "foo-bar", "foo_bar", "namespace/entity", "User", "WideViews"].map((key: string): CanonicalEntity => definition(key))];
  const values: Record<string, CanonicalValue> = {
    "display.name": "Acme", segment: "enterprise", empty: "", amount: 42.5, active: false, day: "2026-10-26", instant: new Date("2026-10-26T12:34:56.789Z"), time: "12:34:56.789", nothing: null,
    tags: ["enterprise", "strategic"], address: { street: "Main", coordinates: [1, 2], optional: null },
    customer: { kind: "reference", entityKey: "customer", sourceId: "123" },
    polymorphic: { kind: "reference", entityKey: "order", sourceId: "123" },
    ambiguous: { kind: "unresolved-reference", sourceId: "123", candidateEntityKeys: ["customer", "order"] },
    record_id: "attribute value", 'quote"and\'space': "safe", ["x".repeat(100)]: "long value",
  };
  const checkpoints: Array<string | null> = [];
  const source: CrmSource = canonicalSource(definitions, async function* (entity: CanonicalEntity, checkpoint: string | null): AsyncGenerator<ChangeBatch> {
    checkpoints.push(checkpoint);
    yield { records: [{ sourceId: "123", fields: entity.key === "customer.profile" ? values : {} }], nextCheckpoint: checkpoint === null ? "page-token::abc123" : "final::opaque" };
  });
  await replicate(id, source);
  const records = (await db.query<{ id: string; key: string; sourceModifiedAt: null }>('SELECT r.id, e.key, r."sourceModifiedAt" FROM "Record" r JOIN "EntityDefinition" e ON e.id = r."entityDefinitionId" WHERE r."deploymentId" = $1', [id])).rows;
  assert.equal(records.length, definitions.length);
  assert.notEqual(records.find((row) => row.key === "customer")!.id, records.find((row) => row.key === "order")!.id);
  assert.ok(records.every((row): boolean => row.sourceModifiedAt === null));
  const profileId: string = records.find((row) => row.key === "customer.profile")!.id;
  const stored = await prisma.attributeValue.findMany({ where: { recordId: profileId }, include: { attributeDefinition: true } });
  // Select attribute definitions explicitly because the test port returns storage columns.
  for (const attr of attributes) {
    const metadata = await prisma.attributeDefinition.findFirst({ where: { key: attr.key, entityDefinition: { deploymentId: id, key: "customer.profile" } } });
    const row = stored.find((item) => item.attributeDefinitionId === metadata!.id)!;
    const typed = { ...row, numberValue: row.numberValue === null ? null : new Prisma.Decimal(String(row.numberValue)), jsonValue: row.jsonValue } as Parameters<typeof readTypedValue>[1];
    const expected: CanonicalValue = attr.key === "amount" ? "42.5" : values[attr.key]!;
    assert.deepEqual(readTypedValue(attr.dataType, typed), expected, attr.key);
    if (attr.key === "customer") assert.equal(row.referenceValue, records.find((item) => item.key === "customer")!.id);
    if (attr.key === "polymorphic") assert.equal(row.referenceValue, records.find((item) => item.key === "order")!.id);
    if (attr.key === "ambiguous") assert.equal(row.referenceValue, null);
  }
  const layout = projectionLayout(id, "customer.profile", attributes.map((attr): string => attr.key));
  const projected = (await db.query<Record<string, unknown>>(`SELECT * FROM "wide".${quoteIdentifier(layout.tableName)}`)).rows[0]!;
  assert.deepEqual(projected.tags, ["enterprise", "strategic"]);
  assert.deepEqual(projected.address, values.address);
  assert.equal(projected.empty, "");
  assert.equal(projected.active, false);
  assert.equal(projected.nothing, null);
  assert.equal(projected.customer, records.find((row) => row.key === "customer")!.id);
  assert.equal(projected.polymorphic, records.find((row) => row.key === "order")!.id);
  assert.equal(projected.ambiguous, null);
  assert.deepEqual(projected.instant, values.instant);
  assert.equal(projected[layout.attributeColumns.record_id!], "attribute value");
  assert.equal(projected[layout.attributeColumns['quote"and\'space']!], "safe");
  const registry = (await db.query<{ table_name: string; entity_key: string }>('SELECT table_name, entity_key FROM "wide"."__replcrm_projections" WHERE deployment_id = $1', [id])).rows;
  assert.equal(new Set(registry.map((row): string => row.table_name)).size, definitions.length);
  await replicate(id, source, false);
  assert.deepEqual(checkpoints.slice(0, definitions.length), definitions.map((): null => null));
  assert.deepEqual(checkpoints.slice(definitions.length), definitions.map((): string => "page-token::abc123"));
  await replicate(id, source, false);
  assert.deepEqual(checkpoints.slice(definitions.length * 2), definitions.map((): string => "final::opaque"));
  assert.equal((await prisma.record.findMany({ where: { deploymentId: id } })).length, definitions.length);
  const customer = await prisma.entityDefinition.findUnique({ where: { deploymentId_key: { deploymentId: id, key: "customer" } } });
  await assert.rejects(prisma.record.create({ data: { deploymentId: id, entityDefinitionId: customer!.id, sourceId: "123" } }), /unique constraint/i);
});

test("failed later batch and failed relationship repair cannot advance successful checkpoints", async (): Promise<void> => {
  const id: string = "failures";
  await seed(id);
  const entity: CanonicalEntity = definition("customer.profile", [{ key: "tags", label: "Tags", dataType: "MultiEnum" }]);
  const good: CrmSource = canonicalSource([entity], async function* (): AsyncGenerator<ChangeBatch> { yield { records: [{ sourceId: "123", fields: { tags: ["original"] } }], nextCheckpoint: "page-token::abc123" }; });
  await replicate(id, good, false);
  const broken: CrmSource = canonicalSource([entity], async function* (_entity: CanonicalEntity, checkpoint: string | null): AsyncGenerator<ChangeBatch> {
    assert.equal(checkpoint, "page-token::abc123");
    yield { records: [{ sourceId: "124", fields: { tags: ["persisted-before-error"] } }], nextCheckpoint: "page-token::uncommitted" };
    yield { records: [{ sourceId: "125", fields: { tags: "native;encoding" as CanonicalValue } }], nextCheckpoint: "page-token::invalid" };
  });
  await assert.rejects(replicate(id, broken, false), /Canonical collection/);
  const successful = await prisma.syncRun.findMany({ where: { deploymentId: id, entityKey: entity.key, status: "Succeeded" } });
  assert.deepEqual(successful.map((row): string | null => row.cursor), ["page-token::abc123"]);
  assert.equal((await prisma.record.findMany({ where: { deploymentId: id } })).length, 2);
  const relatedId: string = "repair-failure";
  await seed(relatedId);
  const definitions: CanonicalEntity[] = [definition("child", [{ key: "parent", label: "Parent", dataType: "Reference", relationship: { targetEntityKeys: ["parent"], kind: "Reference", name: "parent", cascadeDelete: false } }]), definition("parent")];
  const source: CrmSource = canonicalSource(definitions, async function* (item: CanonicalEntity): AsyncGenerator<ChangeBatch> {
    yield { records: [{ sourceId: "123", fields: item.key === "child" ? { parent: { kind: "reference", entityKey: "parent", sourceId: "123" } } : {} }], nextCheckpoint: "page-token::not-committed" };
  });
  await db.exec(`CREATE FUNCTION reject_reference_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD."referenceValue" IS NULL AND NEW."referenceValue" IS NOT NULL THEN RAISE EXCEPTION 'repair failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_reference_repair BEFORE UPDATE ON "AttributeValue" FOR EACH ROW EXECUTE FUNCTION reject_reference_update()`);
  try { await assert.rejects(replicate(relatedId, source, false), /repair failed/); }
  finally { await db.exec('DROP TRIGGER fail_reference_repair ON "AttributeValue"; DROP FUNCTION reject_reference_update()'); }
  assert.equal((await prisma.syncRun.findMany({ where: { deploymentId: relatedId, entityKey: "child", status: "Succeeded" } })).length, 0);
});

test("canonical tombstones and empty change batches need no source timestamp", async (): Promise<void> => {
  const id: string = "tombstones"; await seed(id);
  const entity: CanonicalEntity = definition("namespace/entity");
  const source: CrmSource = canonicalSource([entity], async function* (): AsyncGenerator<ChangeBatch> {
    yield { records: [{ sourceId: "123", isDeleted: true, fields: {} }], nextCheckpoint: "delete::1" };
    yield { records: [], nextCheckpoint: "page-token::empty-page" };
  });
  await replicate(id, source, false);
  const rows = await prisma.record.findMany({ where: { deploymentId: id } });
  assert.equal(rows[0]?.isDeleted, true); assert.equal(rows[0]?.sourceModifiedAt, null);
  const run = await prisma.syncRun.findFirst({ where: { deploymentId: id, entityKey: entity.key, status: "Succeeded" } });
  assert.equal(run?.cursor, "page-token::empty-page");
});

test("canonical value validation rejects native representations and preserves nulls", (): void => {
  assert.deepEqual(readTypedValue("MultiEnum", toTypedValue("MultiEnum", [], (): null => null)), []);
  assert.throws(() => toTypedValue("MultiEnum", "enterprise;strategic", (): null => null), /Canonical collection/);
  assert.throws(() => toTypedValue("Boolean", "false", (): null => null), /Canonical boolean/);
  assert.throws(() => toTypedValue("Reference", "123", (): null => null), /qualified reference/);
  for (const type of ["Text", "Number", "Boolean", "Date", "DateTime", "Reference", "Address", "MultiEnum"] as const) assert.equal(readTypedValue(type, toTypedValue(type, null, (): null => null)), null);
});


test("identity migration preserves existing records and legacy checkpoints while widening scope", async (): Promise<void> => {
  const upgrade = await database(async (old: PGlite): Promise<void> => {
    await old.exec(`INSERT INTO "Deployment" (id, name, "updatedAt") VALUES ('legacy', 'Legacy', now());
      INSERT INTO "EntityDefinition" (id, "deploymentId", key, label, "pluralLabel", "updatedAt") VALUES ('old-entity', 'legacy', 'customer', 'Customer', 'Customers', now());
      INSERT INTO "Record" (id, "deploymentId", "entityDefinitionId", "sourceId", "updatedAt") VALUES ('preserved-record', 'legacy', 'old-entity', '123', now());
      INSERT INTO "SyncRun" (id, "deploymentId", "entityKey", status, cursor) VALUES
        ('old-user-stage', 'legacy', 'User', 'Succeeded', NULL),
        ('old-record-run', 'legacy', 'customer', 'Succeeded', 'legacy-token::untouched')`);
  });
  try {
    const record = await upgrade.prisma.record.findUnique({ where: { id: "preserved-record" } });
    assert.equal(record?.sourceId, "123"); assert.equal(record?.entityDefinitionId, "old-entity");
    const run = await upgrade.prisma.syncRun.findUnique({ where: { id: "old-record-run" } });
    assert.equal(run?.cursor, "legacy-token::untouched");
    assert.equal((await upgrade.prisma.syncRun.findUnique({ where: { id: "old-user-stage" } }))?.entityKey, null);
    await upgrade.prisma.entityDefinition.create({ data: { id: "new-entity", deploymentId: "legacy", key: "order", label: "Order", pluralLabel: "Orders" } });
    const other = await upgrade.prisma.record.create({ data: { deploymentId: "legacy", entityDefinitionId: "new-entity", sourceId: "123" } });
    assert.notEqual(other.id, record!.id); assert.equal(other.sourceModifiedAt, null);
  } finally { await upgrade.db.close(); }
});


test("core lifecycle works with no environment configuration and disconnects after scope failure", async (): Promise<void> => {
  const id: string = "environment-free"; await seed(id);
  const entity: CanonicalEntity = definition("independent.profile");
  const source: CrmSource = canonicalSource([entity], async function* (): AsyncGenerator<ChangeBatch> { yield { records: [], nextCheckpoint: "opaque::state" }; });
  let disconnects: number = 0;
  source.logout = async (): Promise<void> => { disconnects += 1; };
  const previous: NodeJS.ProcessEnv = process.env;
  try {
    process.env = {};
    await replicate(id, source, false);
    await assert.rejects(runReplication({ store: new PostgresReplicaStore(prisma), sourceClient: source, config: { deploymentId: id, batchSize: 2, entityKeys: [], entityDenyKeys: [], buildWideViews: false } }), /No entities/);
    assert.equal(disconnects, 2);
  } finally { process.env = previous; }
});

test("empty collections and explicit null patches survive storage without clearing absent fields", async (): Promise<void> => {
  const id: string = "collection-patches"; await seed(id);
  const entity: CanonicalEntity = definition("customer.profile", [{ key: "tags", label: "Tags", dataType: "MultiEnum" }, { key: "name", label: "Name", dataType: "Text" }]);
  const source: CrmSource = canonicalSource([entity], async function* (): AsyncGenerator<ChangeBatch> {
    yield { records: [{ sourceId: "123", fields: { tags: ["enterprise", "strategic"], name: "retained" } }], nextCheckpoint: "a" };
    yield { records: [{ sourceId: "123", fields: { tags: [] } }], nextCheckpoint: "b" };
  });
  await replicate(id, source, false);
  const rows = (await db.query<{ key: string; jsonValue: unknown; textValue: string | null }>('SELECT a.key, v."jsonValue", v."textValue" FROM "AttributeValue" v JOIN "AttributeDefinition" a ON a.id = v."attributeDefinitionId" JOIN "Record" r ON r.id = v."recordId" WHERE r."deploymentId" = $1', [id])).rows;
  assert.deepEqual(rows.find((row) => row.key === "tags")!.jsonValue, []);
  assert.equal(rows.find((row) => row.key === "name")!.textValue, "retained");
  const clear: CrmSource = canonicalSource([entity], async function* (): AsyncGenerator<ChangeBatch> { yield { records: [{ sourceId: "123", fields: { tags: null } }], nextCheckpoint: "clear::done" }; });
  await replicate(id, clear, false);
  const cleared = (await db.query<{ value: unknown }>('SELECT v."jsonValue" AS value FROM "AttributeValue" v JOIN "AttributeDefinition" a ON a.id = v."attributeDefinitionId" JOIN "Record" r ON r.id = v."recordId" WHERE r."deploymentId" = $1 AND a.key = $2', [id, "tags"])).rows[0]!;
  assert.equal(cleared.value, null);
});
