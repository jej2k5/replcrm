import { createHash } from "node:crypto";
import { type AttributeDefinition, type EntityDefinition, type PrismaClient, type Prisma } from "@prisma/client";

export const WIDE_SCHEMA: string = "wide";
const REGISTRY: string = '"wide"."__replcrm_projections"';
const HOUSEKEEPING: string[] = ["record_id", "source_id", "is_deleted", "source_modified_at", "owner_id", "owner_username", "created_by_id", "last_modified_by_id"];
export interface WideViewResult { entityKey: string; tableName: string; rowsLoaded: number; columns: number; attributeColumns: Record<string, string> }

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 63) throw new Error("Invalid physical SQL identifier");
  return `"${value.replace(/"/g, '\"\"')}"`;
}
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

export async function syncWideViews(prisma: PrismaClient, deploymentId: string, entities: EntityDefinition[]): Promise<WideViewResult[]> {
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wide"');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${REGISTRY} (
    deployment_id TEXT NOT NULL, entity_key TEXT NOT NULL, table_name TEXT NOT NULL UNIQUE,
    column_map JSONB NOT NULL, PRIMARY KEY (deployment_id, entity_key))`);
  const results: WideViewResult[] = [];
  for (const entity of entities) {
    const attrs: AttributeDefinition[] = await prisma.attributeDefinition.findMany({ where: { entityDefinitionId: entity.id }, orderBy: { key: "asc" } });
    results.push(await rebuildWideTable(prisma, deploymentId, entity, attrs));
  }
  return results;
}

interface PivotShape {
  sqlType: string;     // Postgres type for the wide column
  valueColumn: string; // AttributeValue column to pull values from
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

async function rebuildWideTable(prisma: PrismaClient, deploymentId: string, entity: EntityDefinition, attrs: AttributeDefinition[]): Promise<WideViewResult> {
  const { tableName, attributeColumns } = projectionLayout(deploymentId, entity.key, attrs.map((attr: AttributeDefinition): string => attr.key));
  const fqTable: string = `${quoteIdentifier(WIDE_SCHEMA)}.${quoteIdentifier(tableName)}`;
  const housekeeping: Array<{ col: string; type: string; expr: string }> = [
    { col: "record_id", type: "TEXT PRIMARY KEY", expr: "r.id" },
    { col: "source_id", type: "TEXT", expr: 'r."sourceId"' },
    { col: "is_deleted", type: "BOOLEAN", expr: 'r."isDeleted"' },
    { col: "source_modified_at", type: "TIMESTAMPTZ", expr: `r."sourceModifiedAt" AT TIME ZONE 'UTC'` },
    { col: "owner_id", type: "TEXT", expr: 'r."ownerId"' },
    { col: "owner_username", type: "TEXT", expr: "u.username" },
    { col: "created_by_id", type: "TEXT", expr: 'r."createdById"' },
    { col: "last_modified_by_id", type: "TEXT", expr: 'r."lastModifiedById"' },
  ];
  const columnDefs: string[] = housekeeping.map((item): string => `${quoteIdentifier(item.col)} ${item.type}`);
  const names: string[] = housekeeping.map((item): string => quoteIdentifier(item.col));
  const selects: string[] = housekeeping.map((item): string => `${item.expr} AS ${quoteIdentifier(item.col)}`);
  const parameters: string[] = [];
  for (const attr of attrs) {
    const shape: PivotShape | null = pivotShapeFor(attr);
    if (!shape) throw new Error(`Unsupported canonical projection type: ${attr.dataType}`);
    const column: string = quoteIdentifier(attributeColumns[attr.key]!);
    columnDefs.push(`${column} ${shape.sqlType}`); names.push(column);
    parameters.push(attr.key);
    const aggregate: string = `MAX(av.${quoteIdentifier(shape.valueColumn)}::TEXT) FILTER (WHERE ad.key = $${parameters.length})`;
    const expression: string = shape.sqlType === "TIMESTAMPTZ" ? `(${aggregate})::TIMESTAMP AT TIME ZONE 'UTC'` : `(${aggregate})::${shape.sqlType}`;
    selects.push(`${expression} AS ${column}`);
  }
  parameters.push(entity.id, deploymentId);
  const sql: string = `INSERT INTO ${fqTable} (${names.join(", ")})
    SELECT ${selects.join(", ")}
    FROM "Record" r
    LEFT JOIN "User" u ON u.id = r."ownerId"
    LEFT JOIN "AttributeValue" av ON av."recordId" = r.id
    LEFT JOIN "AttributeDefinition" ad ON ad.id = av."attributeDefinitionId"
    WHERE r."entityDefinitionId" = $${parameters.length - 1} AND r."deploymentId" = $${parameters.length}
    GROUP BY r.id, r."sourceId", r."isDeleted", r."sourceModifiedAt", r."ownerId", u.username, r."createdById", r."lastModifiedById"`;
  const rowsLoaded: number = await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<number> => {
    // The unique physical-name registry rejects a digest collision instead of aliasing two identities.
    await tx.$executeRawUnsafe(`INSERT INTO ${REGISTRY} (deployment_id, entity_key, table_name, column_map)
      VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (deployment_id, entity_key)
      DO UPDATE SET table_name = EXCLUDED.table_name, column_map = EXCLUDED.column_map`, deploymentId, entity.key, tableName, JSON.stringify(attributeColumns));
    await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS ${fqTable}`);
    await tx.$executeRawUnsafe(`CREATE TABLE ${fqTable} (${columnDefs.join(", ")})`);
    return tx.$executeRawUnsafe(sql, ...parameters);
  }, { timeout: 300000, maxWait: 10000 });
  return { entityKey: entity.key, tableName, rowsLoaded, columns: columnDefs.length, attributeColumns };
}

// Discovery reads the published registry, never reconstructs physical names.
export async function resolveProjection(prisma: PrismaClient, deploymentId: string, entityKey: string): Promise<import("../../core/replica-store.js").Projection | null> {
  const registry = await prisma.$queryRawUnsafe<Array<{ present: string | null }>>('SELECT to_regclass($1)::text AS present', 'wide.__replcrm_projections');
  if (!registry[0]?.present) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_map: Record<string, string> }>>(`SELECT table_name, column_map FROM ${REGISTRY} WHERE deployment_id = $1 AND entity_key = $2`, deploymentId, entityKey);
  const row = rows[0];
  if (!row) return null;
  const object = await prisma.$queryRawUnsafe<Array<{ present: string | null }>>('SELECT to_regclass($1)::text AS present', `${quoteIdentifier(WIDE_SCHEMA)}.${quoteIdentifier(row.table_name)}`);
  if (!object[0]?.present) throw new Error("Published projection is unavailable");
  return { deploymentId, entityKey, location: { schema: WIDE_SCHEMA, object: row.table_name, attributeColumns: row.column_map }, attributeKeys: Object.keys(row.column_map).sort() };
}
