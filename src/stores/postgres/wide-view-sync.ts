import { createHash, randomUUID } from "node:crypto";
import { type AttributeDefinition, type EntityDefinition, type PrismaClient, type Prisma } from "@prisma/client";

import type { CanonicalEntity } from "../../core/source.js";
import { claimViewSchema, planReplicaView } from "./readable-views.js";
import { prepareProjectionRebuild, qualified, quoteIdentifier, readRelationAccess, restoreRelationAccess, sqlLiteral } from "./wide-view-rebuild.js";

export const WIDE_SCHEMA: string = "wide";
const REGISTRY: string = '"wide"."__replcrm_projections"';
const HOUSEKEEPING: string[] = ["record_id", "source_id", "is_deleted", "source_modified_at", "owner_id", "owner_username", "created_by_id", "last_modified_by_id"];
export interface WideViewResult { entityKey: string; tableName: string; rowsLoaded: number; columns: number; attributeColumns: Record<string, string>; rebuildReason?: string }
interface ProjectionLocation { schema: string; object: string; attributeColumns: Record<string, string> }

// Serialize policy toggles with rebuilds while allowing request foreign-key checks.
export async function lockProjection(tx: Prisma.TransactionClient, entityId: string): Promise<void> {
  await tx.$queryRawUnsafe('SELECT id FROM "EntityDefinition" WHERE id = $1 FOR NO KEY UPDATE', entityId);
}

export async function markSyncTransaction(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL replcrm.sync = 'on'");
}

export async function setProjectionEditTriggers(
  tx: Prisma.TransactionClient, deploymentId: string, entityKey: string, enabled: boolean,
): Promise<void> {
  const location = await projectionLocation(tx, deploymentId, entityKey);
  if (!location) return;
  await configureEditTriggers(tx, deploymentId, entityKey, location, enabled);
}

async function configureEditTriggers(
  tx: Prisma.TransactionClient, deploymentId: string, entityKey: string, location: ProjectionLocation, enabled: boolean,
): Promise<void> {
  const table = qualified(location.schema, location.object);
  const args = [deploymentId, entityKey, JSON.stringify(location.attributeColumns)].map(sqlLiteral).join(", ");
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const trigger = quoteIdentifier("replcrm_edit_" + event.toLowerCase());
    if (enabled) {
      await tx.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER ${trigger} BEFORE ${event} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION writeback.capture_projection_edit(${args})`);
    } else {
      await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    }
  }
}

export { quoteIdentifier } from "./wide-view-rebuild.js";

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("base64url"); }
export function projectionLayout(deploymentId: string, entityKey: string, attributeKeys: string[]): { tableName: string; attributeColumns: Record<string, string> } {
  const used: Set<string> = new Set(HOUSEKEEPING);
  const attributeColumns: Record<string, string> = Object.create(null) as Record<string, string>;
  if (new Set(attributeKeys).size !== attributeKeys.length) throw new Error("Duplicate canonical attribute key");
  // Reserve all directly representable keys before allocating encoded names.
  for (const key of [...attributeKeys].sort()) {
    if (key && !key.includes("\0") && Buffer.byteLength(key, "utf8") <= 63 && !used.has(key)) {
      attributeColumns[key] = key; used.add(key);
    }
  }
  for (const key of [...attributeKeys].sort()) {
    if (Object.prototype.hasOwnProperty.call(attributeColumns, key)) continue;
    let suffix: number = 0;
    let name: string;
    do { name = `attr_${digest([key, suffix++])}`; } while (used.has(name));
    attributeColumns[key] = name; used.add(name);
  }
  return { tableName: `entity_${digest([deploymentId, entityKey])}`, attributeColumns };
}

interface PivotShape {
  sqlType: string;     // Postgres type for the wide column
  valueColumn: string; // AttributeValue column to pull values from
}

const typedSlots = ["textValue", "numberValue", "booleanValue", "dateValue", "dateTimeValue", "jsonValue"];

function projectValue({ sqlType, valueColumn }: PivotShape): string {
  const slot = (name: string) => name === "dateTimeValue"
    ? `(av."dateTimeValue" AT TIME ZONE 'UTC')` : `av.${quoteIdentifier(name)}`;
  const current = `${slot(valueColumn)}::text`;
  if (valueColumn === "referenceValue") return current;
  const historical = typedSlots.filter((name) => name !== valueColumn).map((name) =>
    `wide.__replcrm_cast_history(${slot(name)}, '${sqlType}'::regtype)`);
  return `coalesce(${[current, ...historical].join(", ")})`;
}

function pivotShapeFor(attr: AttributeDefinition): PivotShape | null {
  switch (attr.dataType) {
    case "Text":
    case "TextArea":
    case "LongText":
    case "RichText":
    case "Email":
    case "Phone":
    case "Url":
    case "Enum":
    case "Sequence":
    case "Identifier":
    case "Computed":
      return { sqlType: "TEXT", valueColumn: "textValue" };
    case "Number":
    case "Currency":
    case "Percent":
      return { sqlType: "NUMERIC", valueColumn: "numberValue" };
    case "Boolean":
      return { sqlType: "BOOLEAN", valueColumn: "booleanValue" };
    case "Date":
      return { sqlType: "DATE", valueColumn: "dateValue" };
    case "DateTime":
      return { sqlType: "TIMESTAMPTZ", valueColumn: "dateTimeValue" };
    case "Time":
      return { sqlType: "TEXT", valueColumn: "textValue" };
    case "Reference":
    case "Composition":
      return { sqlType: "TEXT", valueColumn: "referenceValue" };
    case "MultiEnum":
    case "Address":
    case "Geolocation":
      return { sqlType: "JSONB", valueColumn: "jsonValue" };
    default:
      return null; // unknown — skip rather than guess
  }
}


interface ProjectionColumn { name: string; type: string; expression: string }
interface PublishedProjection { table_name: string; column_map: Record<string, string>; watermark: string | null }

const housekeeping: ProjectionColumn[] = [
  { name: "record_id", type: "TEXT PRIMARY KEY", expression: "r.id" },
  { name: "source_id", type: "TEXT", expression: 'r."sourceId"' },
  { name: "is_deleted", type: "BOOLEAN", expression: 'r."isDeleted"' },
  { name: "source_modified_at", type: "TIMESTAMPTZ", expression: `r."sourceModifiedAt" AT TIME ZONE 'UTC'` },
  { name: "owner_id", type: "TEXT", expression: 'r."ownerId"' },
  { name: "owner_username", type: "TEXT", expression: "u.username" },
  { name: "created_by_id", type: "TEXT", expression: 'r."createdById"' },
  { name: "last_modified_by_id", type: "TEXT", expression: 'r."lastModifiedById"' },
];

export async function syncWideViews(
  prisma: PrismaClient, deploymentId: string, entities: EntityDefinition[], definitions: CanonicalEntity[], rebuild: boolean, replicaViewSchema?: string,
): Promise<WideViewResult[]> {
  return prisma.$transaction(async (tx) => {
    await markSyncTransaction(tx);
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    for (const id of [...new Set(entities.map(({ id }) => id))].sort()) await lockProjection(tx, id);
    if (!entities.length) return [];
    const scope = await claimViewSchema(tx, deploymentId, replicaViewSchema);
    const results: WideViewResult[] = [];
    const swaps: Array<() => Promise<void>> = [];
    for (const { entity, definition } of entities.map((entity, index) => ({ entity, definition: definitions[index]! }))
      .sort((a, b) => a.entity.key < b.entity.key ? -1 : a.entity.key > b.entity.key ? 1 : 0)) {
      const active = new Map(definition.attributes.map((attr) => [attr.key, attr.dataType]));
      const stored = await tx.attributeDefinition.findMany({ where: { entityDefinitionId: entity.id }, orderBy: { key: "asc" } });
      const attrs = stored.filter((attr) => active.has(attr.key));
      if (attrs.length !== active.size || attrs.some((attr) => active.get(attr.key) !== attr.dataType)) {
        throw new Error(`Projection metadata mismatch for ${entity.key}. Run the metadata stage first.`);
      }
      results.push(await syncProjection(tx, deploymentId, entity, attrs, rebuild, swaps, scope, definition));
    }
    // Finish all preparation before taking exclusive locks on published tables.
    for (const swap of swaps) await swap();
    const byKey = new Map(results.map((result) => [result.entityKey, result]));
    return entities.map(({ key }) => byKey.get(key)!);
  }, { timeout: 300000, maxWait: 10000 });
}

function castError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlError = error as { code?: string; meta?: { code?: string } };
  const code = sqlError.meta?.code ?? sqlError.code ?? "";
  return code.startsWith("22") || code === "42846";
}

async function canCast(tx: Prisma.TransactionClient, table: string, column: string, type: string): Promise<boolean> {
  await tx.$executeRawUnsafe("SAVEPOINT replcrm_cast");
  try {
    await tx.$queryRawUnsafe(`SELECT count(${column}::${type}) FROM ${table}`);
  } catch (error) {
    if (!castError(error)) throw error;
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT replcrm_cast");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT replcrm_cast");
    return false;
  }
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT replcrm_cast");
  return true;
}

const physicalTypes: Record<string, string> = {
  TEXT: "text", NUMERIC: "numeric", BOOLEAN: "boolean", DATE: "date",
  TIMESTAMPTZ: "timestamp with time zone", JSONB: "jsonb",
};

async function syncProjection(
  tx: Prisma.TransactionClient, deploymentId: string, entity: EntityDefinition, attrs: AttributeDefinition[], rebuild: boolean,
  swaps: Array<() => Promise<void>>, scope: Awaited<ReturnType<typeof claimViewSchema>>, definition: CanonicalEntity,
): Promise<WideViewResult> {
  const { tableName, attributeColumns } = projectionLayout(deploymentId, entity.key, attrs.map(({ key }) => key));
  const table = qualified(WIDE_SCHEMA, tableName);
  const [published] = await tx.$queryRawUnsafe<PublishedProjection[]>(`
    SELECT table_name, column_map, watermark::text FROM ${REGISTRY} WHERE deployment_id = $1 AND entity_key = $2`, deploymentId, entity.key);
  if (published && published.table_name !== tableName) throw new Error(`Unexpected projection table for ${entity.key}`);
  const [relation] = await tx.$queryRawUnsafe<{ present: boolean }[]>("SELECT to_regclass($1) IS NOT NULL AS present", table);
  const exists = relation!.present;
  if (exists && !published) throw new Error(`Unregistered projection table ${table}`);

  // Positions are assigned in commit order per object. Any later change stays in the
  // journal, even if it supersedes a row that was in this run's initial range.
  const [position] = await tx.$queryRawUnsafe<{ position: string }[]>(`
    SELECT position::text FROM wide.__replcrm_projection_positions WHERE entity_id = $1`, entity.id);
  const high = position?.position ?? "0";
  const low = published?.watermark ?? "0";
  const params = [entity.id, deploymentId];
  const columns = attrs.map((attr) => {
    const shape = pivotShapeFor(attr);
    if (!shape) throw new Error(`Unsupported canonical projection type: ${attr.dataType}`);
    params.push(attr.id);
    const value = projectValue(shape);
    const expression = `(MAX(${value}) FILTER (WHERE av."attributeDefinitionId" = $${params.length}))::${shape.sqlType}`;
    return { key: attr.key, id: attr.id, name: attributeColumns[attr.key]!, type: shape.sqlType, expression, value };
  });
  const all = [...housekeeping, ...columns];
  const names = all.map(({ name }) => quoteIdentifier(name));
  const journal = "wide.__replcrm_projection_changes";
  const range = (start: number) => `change.position > $${start}::bigint AND change.position <= $${start + 1}::bigint`;
  const pivot = (incremental: boolean) => `
    SELECT ${all.map(({ expression }) => expression).join(", ")}
    FROM public."Record" r
    ${incremental ? `JOIN ${journal} change ON change.entity_id = $1 AND change.record_id = r.id AND ${range(params.length + 1)}` : ""}
    LEFT JOIN public."User" u ON u.id = r."ownerId"
    LEFT JOIN public."AttributeValue" av ON av."recordId" = r.id
    WHERE r."entityDefinitionId" = $1 AND r."deploymentId" = $2
    GROUP BY r.id, u.username`;
  const configure = async (schema: string) => {
    const policy = await tx.writebackPolicy.findUnique({ where: { deploymentId_entityKey: { deploymentId, entityKey: entity.key } } });
    if (policy?.enabled) await configureEditTriggers(tx, deploymentId, entity.key, { schema, object: tableName, attributeColumns }, true);
  };

  let rebuildReason = !exists ? (published ? "projection table missing" : "first build")
    : published?.watermark == null ? "upgrade from legacy projection" : rebuild ? "explicit rebuild requested" : undefined;
  const previous = new Map(Object.entries(published?.column_map ?? {}));
  const removed = [...previous].filter(([key]) => !Object.hasOwn(attributeColumns, key));
  const added: typeof columns = [];
  const renamed: { from: string; to: string; temporary: string }[] = [];
  const altered: typeof columns = [];
  if (!rebuildReason) {
    const actual = await tx.$queryRawUnsafe<{ name: string; type: string }[]>(`
      SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, table);
    const types = new Map(actual.map(({ name, type }) => [name, type]));
    for (const column of columns) {
      const old = previous.get(column.key);
      if (!old || !types.has(old)) {
        added.push(column);
        continue;
      }
      if (old !== column.name) renamed.push({ from: old, to: column.name, temporary: "replcrm_column_" + randomUUID().replaceAll("-", "") });
      if (types.get(old) === physicalTypes[column.type]) continue;
      if (!await canCast(tx, table, quoteIdentifier(old), column.type)) {
        rebuildReason = `cannot cast column ${column.key} from ${types.get(old)} to ${column.type}`;
        break;
      }
      altered.push(column);
    }
  }

  const displayKeys = new Map(definition.attributes.map(({ key, displayKey }) => [key, displayKey]));
  const recordFields = new Set(definition.attributes.filter(({ recordRole }) => recordRole).map(({ key }) => key));
  const readable = await planReplicaView(tx, scope, definition, columns.filter(({ key }) => !recordFields.has(key)).map(({ key, name, type }) => ({
    key, displayKey: displayKeys.get(key), storage: name, type: physicalTypes[type]!,
  })), HOUSEKEEPING);
  let access: Awaited<ReturnType<typeof readRelationAccess>> | undefined;
  const dropReadable = async () => {
    if (!readable.replace) return;
    access = await readRelationAccess(tx, readable.view);
    await tx.$executeRawUnsafe(`DROP VIEW ${readable.view}`);
  };
  const publishReadable = async () => {
    await readable.publish(table);
    if (access) await restoreRelationAccess(tx, readable.view, access);
  };

  let rowsLoaded = 0;
  if (rebuildReason) {
    const prepared = await prepareProjectionRebuild(tx, WIDE_SCHEMA, tableName, exists, async (schema) => {
      const shadow = qualified(schema, tableName);
      await tx.$executeRawUnsafe(`CREATE TABLE ${shadow} (${all.map(({ name, type }) => `${quoteIdentifier(name)} ${type}`).join(", ")})`);
      const count = await tx.$executeRawUnsafe(`INSERT INTO ${shadow} (${names.join(", ")}) ${pivot(false)}`, ...params);
      await configure(schema);
      return count;
    }, readable.replace ? readable : undefined);
    rowsLoaded = prepared.rowsLoaded;
    swaps.push(async () => {
      await dropReadable();
      await prepared.swap();
      if (readable.changed) await publishReadable();
    });
  } else {
    await dropReadable();
    for (const [, column] of removed) await tx.$executeRawUnsafe(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${quoteIdentifier(column)}`);
    for (const { from, temporary } of renamed) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdentifier(from)} TO ${quoteIdentifier(temporary)}`);
    }
    for (const { temporary, to } of renamed) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdentifier(temporary)} TO ${quoteIdentifier(to)}`);
    }
    for (const { name, type } of altered) {
      const column = quoteIdentifier(name);
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`);
    }
    for (const { id, name, type, value } of added) {
      const column = quoteIdentifier(name);
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      await tx.$executeRawUnsafe(`
        UPDATE ${table} target SET ${column} = (${value})::${type}
        FROM public."AttributeValue" av
        WHERE av."recordId" = target.record_id AND av."attributeDefinitionId" = $1 AND ${value} IS NOT NULL`, id);
    }
    if (removed.length || added.length || renamed.length) await configure(WIDE_SCHEMA);
    if (high !== low) {
      const fields = names.slice(1);
      rowsLoaded = await tx.$executeRawUnsafe(`
        INSERT INTO ${table} AS target (${names.join(", ")}) ${pivot(true)}
        ON CONFLICT (record_id) DO UPDATE SET ${fields.map((col) => `${col} = EXCLUDED.${col}`).join(", ")}
        WHERE (${fields.map((col) => `target.${col}`).join(", ")}) IS DISTINCT FROM
              (${fields.map((col) => `EXCLUDED.${col}`).join(", ")})`, ...params, low, high);
      await tx.$executeRawUnsafe(`
        DELETE FROM ${table} target USING ${journal} change
        WHERE change.entity_id = $1 AND ${range(3)} AND target.record_id = change.record_id
          AND NOT EXISTS (SELECT 1 FROM public."Record" r WHERE r.id = change.record_id AND r."entityDefinitionId" = $1 AND r."deploymentId" = $2)`,
        entity.id, deploymentId, low, high);
    }
  }
  if (!rebuildReason && readable.changed) await publishReadable();
  if (rebuildReason || high !== low || added.length || removed.length || renamed.length) {
    await tx.$executeRawUnsafe(`INSERT INTO ${REGISTRY} (deployment_id, entity_key, table_name, column_map, watermark)
      VALUES ($1, $2, $3, $4::jsonb, $5::bigint) ON CONFLICT (deployment_id, entity_key)
      DO UPDATE SET column_map = EXCLUDED.column_map, watermark = EXCLUDED.watermark`, deploymentId, entity.key, tableName, JSON.stringify(attributeColumns), high);
    await tx.$executeRawUnsafe(`DELETE FROM ${journal} WHERE entity_id = $1 AND position <= $2::bigint`, entity.id, high);
  }
  return { entityKey: entity.key, tableName, rowsLoaded, columns: all.length, attributeColumns, ...(rebuildReason ? { rebuildReason } : {}) };
}

// Discovery reads the published registry, never reconstructs physical names.
async function projectionLocation(prisma: Prisma.TransactionClient, deploymentId: string, entityKey: string): Promise<ProjectionLocation | null> {
  const registry = await prisma.$queryRawUnsafe<Array<{ present: string | null }>>('SELECT to_regclass($1)::text AS present', 'wide.__replcrm_projections');
  if (!registry[0]?.present) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_map: Record<string, string> }>>(`SELECT table_name, column_map FROM ${REGISTRY} WHERE deployment_id = $1 AND entity_key = $2`, deploymentId, entityKey);
  const row = rows[0];
  if (!row) return null;
  const object = await prisma.$queryRawUnsafe<Array<{ present: string | null }>>('SELECT to_regclass($1)::text AS present', `${quoteIdentifier(WIDE_SCHEMA)}.${quoteIdentifier(row.table_name)}`);
  if (!object[0]?.present) throw new Error("Published projection is unavailable");
  return { schema: WIDE_SCHEMA, object: row.table_name, attributeColumns: row.column_map };
}

export async function resolveProjection(prisma: PrismaClient, deploymentId: string, entityKey: string): Promise<import("../../core/replica-store.js").Projection | null> {
  const location = await projectionLocation(prisma, deploymentId, entityKey);
  return location && { deploymentId, entityKey, location: { ...location }, attributeKeys: Object.keys(location.attributeColumns).sort() };
}
