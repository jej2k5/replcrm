import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ReplicaView, ReplicaViewColumn } from "../../core/replica-store.js";
import { qualified, quoteIdentifier } from "./wide-view-rebuild.js";

const schemas = "wide.__replcrm_view_schemas";
const registry = "wide.__replcrm_readable_views";
type Transaction = Prisma.TransactionClient;
interface ViewScope { deploymentId: string; schema: string; reserved: Set<string> }
interface PublishedView { view_name: string; suffixed: boolean; columns: ReplicaViewColumn[] }

export async function claimViewSchema(tx: Transaction, deploymentId: string, configured?: string): Promise<ViewScope> {
  const keywords = await tx.$queryRawUnsafe<{ word: string }[]>("SELECT word FROM pg_get_keywords() WHERE catcode = 'R'");
  const reserved = new Set(keywords.map(({ word }) => word));
  const requested = configured ?? "replica";
  if (!/^[a-z_][a-z_0-9]{0,62}$/.test(requested) || reserved.has(requested) || requested.startsWith("pg_") ||
      requested.startsWith("replcrm_") || ["public", "wide", "writeback", "information_schema"].includes(requested)) {
    throw new Error("Invalid replica view schema. Choose a dedicated lowercase SQL identifier.");
  }
  await tx.$executeRawUnsafe(`
    INSERT INTO ${schemas} (deployment_id, schema_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, deploymentId, requested);
  // Serialize name allocation and view DDL for this deployment.
  const [claim] = await tx.$queryRawUnsafe<{ schema_name: string }[]>(`
    SELECT schema_name FROM ${schemas} WHERE deployment_id = $1 FOR UPDATE`, deploymentId);
  if (!claim) throw new Error(`Replica view schema ${requested} is already used by another deployment.`);
  if (configured !== undefined && claim.schema_name !== configured) {
    throw new Error(`Deployment ${deploymentId} already uses replica view schema ${claim.schema_name}.`);
  }
  await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(claim.schema_name)}`);
  return { deploymentId, schema: claim.schema_name, reserved };
}

function fold(key: string): string {
  return key.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])([0-9])/g, "$1_$2")
    .replace(/([0-9])([A-Za-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "unnamed";
}

function fit(name: string, suffix = ""): string {
  const max = 63 - suffix.length;
  if (name.length <= max) return name + suffix;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
  return name.slice(0, max - digest.length - 1).replace(/_$/, "") + "_" + digest + suffix;
}

function allocate(key: string, used: Set<string>) {
  const folded = fold(key);
  const base = fit(folded);
  let name = base;
  for (let i = 2; used.has(name); i++) name = fit(folded, "_" + i);
  used.add(name);
  return { name, suffixed: name !== base };
}

interface ViewField { key: string; displayKey: string | undefined; storage: string; type: string }

export async function planReplicaView(
  tx: Transaction, scope: ViewScope, entity: { key: string; displayKey?: string },
  fields: ViewField[], housekeeping: string[],
) {
  const { deploymentId, schema, reserved } = scope;
  const [previous] = await tx.$queryRawUnsafe<PublishedView[]>(`
    SELECT view_name, suffixed, columns FROM ${registry} WHERE deployment_id = $1 AND entity_key = $2`, deploymentId, entity.key);
  let relation;
  if (previous) {
    relation = { name: previous.view_name, suffixed: previous.suffixed };
  } else {
    const names = await tx.$queryRawUnsafe<{ name: string }[]>(`
      SELECT view_name AS name FROM ${registry} WHERE deployment_id = $1
      UNION
      SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $2`, deploymentId, schema);
    relation = allocate(entity.displayKey ?? entity.key, new Set([...reserved, ...names.map(({ name }) => name)]));
  }
  const byKey = new Map(fields.map((field) => [field.key, field]));
  // Preserve the existing order so CREATE OR REPLACE VIEW can append new fields.
  const columns = (previous?.columns ?? []).filter(({ sourceField }) => byKey.has(sourceField));
  const used = new Set([...reserved, ...housekeeping, ...(previous?.columns ?? []).map(({ column }) => column),
    "tableoid", "xmin", "xmax", "cmin", "cmax", "ctid"]);
  const assigned = new Set(columns.map(({ sourceField }) => sourceField));
  for (const key of [...byKey.keys()].sort()) {
    const field = byKey.get(key)!;
    if (assigned.has(field.key)) continue;
    const { name, suffixed } = allocate(field.displayKey ?? field.key, used);
    columns.push({ sourceField: field.key, column: name, suffixed });
  }

  const view = qualified(schema, relation.name);
  const actual = previous ? await tx.$queryRawUnsafe<{ name: string; type: string }[]>(`
    SELECT attname::text AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, view) : [];
  const expected = new Map(columns.map(({ sourceField, column }) => [column, byKey.get(sourceField)!.type]));
  const replace = actual.some(({ name, type }) => !housekeeping.includes(name) && expected.get(name) !== type) ||
    (previous?.columns ?? []).some(({ sourceField }) => !byKey.has(sourceField));
  const aliases = [
    ...housekeeping.map((name) => `${quoteIdentifier(name)} AS ${quoteIdentifier(name)}`),
    ...columns.map(({ sourceField, column }) =>
      `${quoteIdentifier(byKey.get(sourceField)!.storage)} AS ${quoteIdentifier(column)}`),
  ];

  const changed = replace || actual.length !== aliases.length;
  if (changed) {
    // Reserve the name before the deferred table swaps publish new views.
    await tx.$executeRawUnsafe(`
      INSERT INTO ${registry} (deployment_id, entity_key, view_name, suffixed, columns) VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (deployment_id, entity_key) DO UPDATE SET columns = EXCLUDED.columns`,
      deploymentId, entity.key, relation.name, relation.suffixed, JSON.stringify(columns));
  }

  const keepIdentity = actual.length > 0 && !replace;
  return {
    view, schema, name: relation.name, replace: replace && actual.length > 0, changed,
    publish: async (table: string) => {
      const create = keepIdentity ? "CREATE OR REPLACE VIEW" : "CREATE VIEW";
      await tx.$executeRawUnsafe(`${create} ${view} AS SELECT ${aliases.join(", ")} FROM ${table}`);
      if (!keepIdentity) {
        // Inserts and updates use automatic view rewriting.
        await tx.$executeRawUnsafe(`CREATE TRIGGER replcrm_reject_delete INSTEAD OF DELETE ON ${view}
          FOR EACH ROW EXECUTE FUNCTION wide.__replcrm_reject_view_delete()`);
      }
    },
  };
}

export async function listReplicaViews(tx: Transaction, deploymentId: string): Promise<ReplicaView[]> {
  const [registryExists] = await tx.$queryRawUnsafe<{ present: boolean }[]>("SELECT to_regclass($1) IS NOT NULL AS present", registry);
  if (!registryExists?.present) return [];
  const rows = await tx.$queryRawUnsafe<(PublishedView & { entity_key: string; schema_name: string })[]>(`
    SELECT v.entity_key, s.schema_name, v.view_name, v.suffixed, v.columns
    FROM ${registry} v JOIN ${schemas} s USING (deployment_id)
    WHERE v.deployment_id = $1 ORDER BY v.entity_key`, deploymentId);
  return rows.map(({ entity_key, schema_name, view_name, suffixed, columns }) => ({
    entityKey: entity_key,
    view: schema_name + "." + (/^[a-z_]/.test(view_name) ? view_name : quoteIdentifier(view_name)),
    suffixed, columns,
  }));
}

