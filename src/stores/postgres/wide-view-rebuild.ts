import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 63) throw new Error("Invalid physical SQL identifier");
  return '"' + value.replaceAll('"', '""') + '"';
}

const ident = quoteIdentifier;
export const sqlLiteral = (value: string): string => "E'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
export const qualified = (schema: string, name: string): string => ident(schema) + "." + ident(name);

interface DependentView { schema: string; name: string; oid: string; kind: string; definition: string }
interface Index { name: string; definition: string; constraint_name: string | null; constraint_definition: string | null; primary: boolean; comment: string | null }
interface Grant { grantee: string | null; privilege: string; grantable: boolean; column_name: string | null }

// Deparse with all identifiers quoted and the table schema outside the search path.
// Match the relation reference as SQL tokens, leaving literals and other identifiers intact.
function redirectView(definition: string, table: string, shadow: string): string {
  const pattern = /[eE]'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|"(?:[^"]|"")*"(?:\s*\.\s*"(?:[^"]|"")*")?/g;
  return definition.replace(pattern, (token) => token === table ? shadow : token);
}

async function copyAttachments(tx: Prisma.TransactionClient, table: string, shadow: string, shadowSchema: string): Promise<void> {
  const indexes = await tx.$queryRawUnsafe<Index[]>(`
    SELECT i.relname::text AS name, pg_get_indexdef(i.oid) AS definition, x.conname::text AS constraint_name,
      pg_get_constraintdef(x.oid) AS constraint_definition, p.indisprimary AS primary, obj_description(i.oid) AS comment
    FROM pg_index p JOIN pg_class i ON i.oid = p.indexrelid
    LEFT JOIN pg_constraint x ON x.conindid = i.oid AND x.conrelid = p.indrelid AND x.contype IN ('p', 'u', 'x')
    WHERE p.indrelid = $1::regclass AND p.indisvalid ORDER BY i.relname`, table);
  for (const index of indexes) {
    if (index.primary) {
      const [existing] = await tx.$queryRawUnsafe<{ name: string }[]>(`
        SELECT c.relname::text AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = $1::regclass AND i.indisprimary`, shadow);
      if (existing?.name !== index.name && existing) {
        await tx.$executeRawUnsafe(`ALTER INDEX ${qualified(shadowSchema, existing.name)} RENAME TO ${ident(index.name)}`);
      }
    } else if (index.constraint_name) {
      await tx.$executeRawUnsafe(`ALTER TABLE ${shadow} ADD CONSTRAINT ${ident(index.constraint_name)} ${index.constraint_definition}`);
    } else {
      const target = ` ON ${table} USING `;
      if (!index.definition.includes(target)) throw new Error(`Cannot recreate index ${index.name}`);
      await tx.$executeRawUnsafe(index.definition.replace(target, ` ON ${shadow} USING `));
    }
    if (index.comment !== null) await tx.$executeRawUnsafe(`COMMENT ON INDEX ${qualified(shadowSchema, index.name)} IS ${sqlLiteral(index.comment)}`);
  }

  const [metadata] = await tx.$queryRawUnsafe<{ comment: string | null }[]>(`
    SELECT obj_description(oid) AS comment FROM pg_class WHERE oid = $1::regclass`, table);
  if (metadata?.comment != null) await tx.$executeRawUnsafe(`COMMENT ON TABLE ${shadow} IS ${sqlLiteral(metadata.comment)}`);

  const columns = await tx.$queryRawUnsafe<{ name: string; comment: string }[]>(`
    SELECT a.attname::text AS name, col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a JOIN pg_attribute b ON b.attrelid = $2::regclass AND b.attname = a.attname
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND NOT b.attisdropped
      AND col_description(a.attrelid, a.attnum) IS NOT NULL`, table, shadow);
  for (const column of columns) {
    await tx.$executeRawUnsafe(`COMMENT ON COLUMN ${shadow}.${ident(column.name)} IS ${sqlLiteral(column.comment)}`);
  }

  await restoreRelationAccess(tx, shadow, await readRelationAccess(tx, table));
}

export async function readRelationAccess(tx: Prisma.TransactionClient, relation: string) {
  const [owner] = await tx.$queryRawUnsafe<{ name: string }[]>(`
    SELECT pg_get_userbyid(relowner)::text AS name FROM pg_class WHERE oid = $1::regclass`, relation);
  const grants = await tx.$queryRawUnsafe<Grant[]>(`
    SELECT CASE WHEN acl.grantee = 0 THEN NULL ELSE pg_get_userbyid(acl.grantee)::text END AS grantee,
      acl.privilege_type AS privilege, acl.is_grantable AS grantable, NULL::text AS column_name
    FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid = $1::regclass
    UNION ALL
    SELECT CASE WHEN acl.grantee = 0 THEN NULL ELSE pg_get_userbyid(acl.grantee)::text END,
      acl.privilege_type, acl.is_grantable, a.attname::text
    FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, relation);
  return { owner: owner!.name, grants };
}

export async function restoreRelationAccess(
  tx: Prisma.TransactionClient, relation: string, access: Awaited<ReturnType<typeof readRelationAccess>>,
): Promise<void> {
  const current = await readRelationAccess(tx, relation);
  const grantee = (name: string | null) => name === null ? "PUBLIC" : ident(name);
  await tx.$executeRawUnsafe(`ALTER TABLE ${relation} OWNER TO ${ident(access.owner)}`);
  for (const role of new Set([...current.grants.map((grant) => grant.grantee), access.owner])) {
    await tx.$executeRawUnsafe(`REVOKE ALL PRIVILEGES ON TABLE ${relation} FROM ${grantee(role)}`);
  }
  const columns = await tx.$queryRawUnsafe<{ name: string }[]>(`
    SELECT attname::text AS name FROM pg_attribute
    WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, relation);
  const names = new Set(columns.map(({ name }) => name));
  for (const grant of access.grants) {
    if (grant.column_name !== null && !names.has(grant.column_name)) continue;
    const privilege = grant.column_name === null ? grant.privilege : `${grant.privilege} (${ident(grant.column_name)})`;
    await tx.$executeRawUnsafe(`GRANT ${privilege} ON TABLE ${relation} TO ${grantee(grant.grantee)}${grant.grantable ? " WITH GRANT OPTION" : ""}`);
  }
}

async function validateView(tx: Prisma.TransactionClient, view: DependentView, table: string, shadow: string, shadowSchema: string): Promise<void> {
  const name = qualified(view.schema, view.name);
  try {
    if (view.kind !== "v") throw new Error("dependent materialized views require an explicit migration");
    const probe = qualified(shadowSchema, "replcrm_probe_" + randomUUID().replaceAll("-", ""));
    await tx.$executeRawUnsafe(`CREATE VIEW ${probe} AS ${redirectView(view.definition, table, shadow)}`);
    const [signature] = await tx.$queryRawUnsafe<{ matches: boolean }[]>(`
      SELECT
        (SELECT jsonb_agg(jsonb_build_array(attname, atttypid, atttypmod, attcollation) ORDER BY attnum)
         FROM pg_attribute WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped)
        IS NOT DISTINCT FROM
        (SELECT jsonb_agg(jsonb_build_array(attname, atttypid, atttypmod, attcollation) ORDER BY attnum)
         FROM pg_attribute WHERE attrelid = $2::regclass AND attnum > 0 AND NOT attisdropped) AS matches`, view.oid, probe);
    if (!signature?.matches) throw new Error("the view's output columns would change");
    await tx.$executeRawUnsafe(`DROP VIEW ${probe}`);
  } catch (error) {
    throw new Error(`Cannot recreate dependent view ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function withDeparseSettings<T>(tx: Prisma.TransactionClient, action: () => Promise<T>): Promise<T> {
  const [settings] = await tx.$queryRawUnsafe<{ path: string; quoting: string }[]>(`
    SELECT current_setting('search_path') AS path, current_setting('quote_all_identifiers') AS quoting`);
  await tx.$executeRawUnsafe("SET LOCAL search_path = pg_catalog");
  await tx.$executeRawUnsafe("SET LOCAL quote_all_identifiers = on");
  const result = await action();
  await tx.$queryRawUnsafe("SELECT set_config('search_path', $1, true), set_config('quote_all_identifiers', $2, true)", settings!.path, settings!.quoting);
  return result;
}

export async function prepareProjectionRebuild(
  tx: Prisma.TransactionClient, schema: string, tableName: string, exists: boolean,
  build: (schema: string) => Promise<number>,
  replacingView?: { schema: string; name: string },
): Promise<{ rowsLoaded: number; swap: () => Promise<void> }> {
  const suffix = randomUUID().replaceAll("-", "");
  const shadowSchema = "replcrm_shadow_" + suffix;
  const retiredSchema = "replcrm_retired_" + suffix;
  const table = qualified(schema, tableName);
  const shadow = qualified(shadowSchema, tableName);
  await tx.$executeRawUnsafe(`CREATE SCHEMA ${ident(shadowSchema)}`);
  const rowsLoaded = await build(shadowSchema);
  const views = exists ? await withDeparseSettings(tx, async () => {
    const definitions = await tx.$queryRawUnsafe<DependentView[]>(`
      SELECT DISTINCT n.nspname::text AS schema, v.relname::text AS name, v.oid::text AS oid, v.relkind::text AS kind,
        pg_get_viewdef(v.oid) AS definition
      FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace n ON n.oid = v.relnamespace
      WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
        AND d.refobjid = $1::regclass AND v.relkind IN ('v', 'm')
      ORDER BY schema, name`, table);
    const rebound = definitions.filter(({ schema, name }) => schema !== replacingView?.schema || name !== replacingView.name);
    for (const view of rebound) await validateView(tx, view, table, shadow, shadowSchema);
    await copyAttachments(tx, table, shadow, shadowSchema);
    await tx.$executeRawUnsafe(`CREATE SCHEMA ${ident(retiredSchema)}`);
    return rebound;
  }) : [];

  return {
    rowsLoaded,
    swap: async () => {
      if (exists) {
        await withDeparseSettings(tx, async () => {
          // Moving the tables between schemas swaps their qualified names and keeps index names.
          await tx.$executeRawUnsafe(`ALTER TABLE ${table} SET SCHEMA ${ident(retiredSchema)}`);
          await tx.$executeRawUnsafe(`ALTER TABLE ${shadow} SET SCHEMA ${ident(schema)}`);
          // Keep the view identity so downstream views and permissions survive.
          for (const view of views) {
            const name = qualified(view.schema, view.name);
            try {
              await tx.$executeRawUnsafe(`CREATE OR REPLACE VIEW ${name} AS ${view.definition}`);
            } catch (error) {
              throw new Error(`Cannot recreate dependent view ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
          }
          await tx.$executeRawUnsafe(`DROP TABLE ${qualified(retiredSchema, tableName)}`);
          await tx.$executeRawUnsafe(`DROP SCHEMA ${ident(retiredSchema)}`);
        });
      } else {
        await tx.$executeRawUnsafe(`ALTER TABLE ${shadow} SET SCHEMA ${ident(schema)}`);
      }
      await tx.$executeRawUnsafe(`DROP SCHEMA ${ident(shadowSchema)}`);
    },
  };
}
