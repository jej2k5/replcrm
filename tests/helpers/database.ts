// Test-only Prisma-shaped port backed by an actual embedded PostgreSQL engine.
// Production continues to use Prisma; no source or destination service is involved.
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Prisma, type PrismaClient } from "@prisma/client";

type Row = Record<string, unknown>;
interface QueryArgs { where?: Row; data?: Row; create?: Row; update?: Row; orderBy?: Row | Row[]; take?: number; select?: Row; include?: Row }
interface Executor { query<T extends Row = Row>(query: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }> }
const TABLES: Record<string, string> = { deployment: "Deployment", entityDefinition: "EntityDefinition", attributeDefinition: "AttributeDefinition", enumOption: "EnumOption", relationDefinition: "RelationDefinition", record: "Record", attributeValue: "AttributeValue", user: "User", syncRun: "SyncRun" };
const UPDATED: Set<string> = new Set(["Deployment", "EntityDefinition", "AttributeDefinition", "Record", "AttributeValue", "User"]);
function quote(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function parameter(value: unknown, column: string): unknown {
  if (value === Prisma.DbNull || value === Prisma.JsonNull) return null;
  if (value instanceof Date) return value.toISOString();
  if (column === "jsonValue") return value === null ? null : JSON.stringify(value);
  if (value instanceof Prisma.Decimal) return value.toString();
  return value;
}
function predicate(table: string, where: Row, parameters: unknown[], alias: string = "t"): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") { parts.push(`(${(value as Row[]).map((child: Row): string => predicate(table, child, parameters, alias)).join(" OR ")})`); continue; }
    if (key === "record" || key === "attributeDefinition" || key === "entityDefinition") {
      const related: string = TABLES[key]!;
      const relatedAlias: string = `${alias}_${key}`;
      parts.push(`EXISTS (SELECT 1 FROM ${quote(related)} ${relatedAlias} WHERE ${relatedAlias}.id = ${alias}.${quote(`${key}Id`)} AND ${predicate(related, value as Row, parameters, relatedAlias)})`);
      continue;
    }
    if (key.includes("_") && value && typeof value === "object" && !(value instanceof Date)) { parts.push(predicate(table, value as Row, parameters, alias)); continue; }
    const column: string = `${alias}.${quote(key)}`;
    if (value === null) { parts.push(`${column} IS NULL`); continue; }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      for (const [operation, operand] of Object.entries(value as Row)) {
        if (operation === "in") {
          const list: unknown[] = operand as unknown[];
          parts.push(list.length ? `${column} IN (${list.map((item: unknown): string => { parameters.push(parameter(item, key)); return `$${parameters.length}`; }).join(", ")})` : "FALSE");
        } else {
          const operator: string | undefined = { gt: ">", gte: ">=", lt: "<", lte: "<=", equals: "=" }[operation];
          if (!operator) throw new Error(`Unsupported test predicate: ${operation}`);
          parameters.push(parameter(operand, key)); parts.push(`${column} ${operator} $${parameters.length}`);
        }
      }
      continue;
    }
    parameters.push(parameter(value, key)); parts.push(`${column} = $${parameters.length}`);
  }
  return parts.join(" AND ") || "TRUE";
}
function port(executor: Executor, transaction: <T>(action: (tx: Executor) => Promise<T>) => Promise<T>): PrismaClient {
  const result: Row = {};
  for (const [model, table] of Object.entries(TABLES)) {
    const findMany = async (args: QueryArgs = {}): Promise<Row[]> => {
      const parameters: unknown[] = [];
      const where: string = predicate(table, args.where ?? {}, parameters);
      const order: Row[] = args.orderBy ? Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy] : [];
      const orderSql: string = order.length ? ` ORDER BY ${order.flatMap((item: Row): string[] => Object.entries(item).map(([key, direction]): string => `t.${quote(key)} ${direction === "desc" ? "DESC" : "ASC"}`)).join(", ")}` : "";
      const limit: string = args.take === undefined ? "" : ` LIMIT ${Number(args.take)}`;
      const rows: Row[] = (await executor.query(`SELECT t.* FROM ${quote(table)} t WHERE ${where}${orderSql}${limit}`, parameters)).rows;
      for (const row of rows) {
        if (table === "Record" && args.select?.entityDefinition) row.entityDefinition = (await executor.query('SELECT * FROM "EntityDefinition" WHERE id = $1', [row.entityDefinitionId])).rows[0];
      }
      return rows;
    };
    const create = async (args: QueryArgs): Promise<Row> => {
      const data: Row = { id: randomUUID(), ...args.data };
      if (UPDATED.has(table)) data.updatedAt = new Date();
      const keys: string[] = Object.keys(data);
      return (await executor.query(`INSERT INTO ${quote(table)} (${keys.map(quote).join(", ")}) VALUES (${keys.map((_key: string, index: number): string => `$${index + 1}`).join(", ")}) RETURNING *`, keys.map((key: string): unknown => parameter(data[key], key)))).rows[0]!;
    };
    const update = async (args: QueryArgs): Promise<Row> => {
      const data: Row = { ...args.data };
      if (UPDATED.has(table)) data.updatedAt = new Date();
      const keys: string[] = Object.keys(data);
      const parameters: unknown[] = keys.map((key: string): unknown => parameter(data[key], key));
      const where: string = predicate(table, args.where ?? {}, parameters);
      return (await executor.query(`UPDATE ${quote(table)} t SET ${keys.map((key: string, index: number): string => `${quote(key)} = $${index + 1}`).join(", ")} WHERE ${where} RETURNING *`, parameters)).rows[0]!;
    };
    result[model] = {
      findMany,
      findUnique: async (args: QueryArgs): Promise<Row | null> => (await findMany(args))[0] ?? null,
      findFirst: async (args: QueryArgs): Promise<Row | null> => (await findMany({ ...args, take: 1 }))[0] ?? null,
      create, update,
      updateMany: async (args: QueryArgs): Promise<{ count: number }> => {
        const data: Row = { ...args.data };
        if (UPDATED.has(table)) data.updatedAt = new Date();
        const keys: string[] = Object.keys(data);
        const parameters: unknown[] = keys.map((key: string): unknown => parameter(data[key], key));
        const where: string = predicate(table, args.where ?? {}, parameters);
        const changed = await executor.query(`UPDATE ${quote(table)} t SET ${keys.map((key: string, index: number): string => `${quote(key)} = $${index + 1}`).join(", ")} WHERE ${where} RETURNING *`, parameters);
        return { count: changed.rows.length };
      },
      upsert: async (args: QueryArgs): Promise<Row> => (await findMany(args)).length ? update({ where: args.where!, data: args.update! }) : create({ data: args.create! }),
      deleteMany: async (args: QueryArgs): Promise<{ count: number }> => {
        const parameters: unknown[] = [];
        const where: string = predicate(table, args.where ?? {}, parameters);
        return { count: (await executor.query(`DELETE FROM ${quote(table)} t WHERE ${where}`, parameters)).affectedRows ?? 0 };
      },
      createMany: async (args: { data: Row[] }): Promise<{ count: number }> => { for (const data of args.data) await create({ data }); return { count: args.data.length }; },
    };
  }
  result.$queryRawUnsafe = async (sql: string, ...parameters: unknown[]): Promise<Row[]> => (await executor.query(sql, parameters)).rows;
  result.$executeRawUnsafe = async (sql: string, ...parameters: unknown[]): Promise<number> => (await executor.query(sql, parameters)).affectedRows ?? 0;
  result.$transaction = async <T>(action: (client: PrismaClient) => Promise<T>): Promise<T> => transaction(async (tx: Executor): Promise<T> => action(port(tx, async <R>(nested: (client: Executor) => Promise<R>): Promise<R> => nested(tx))));
  return result as unknown as PrismaClient;
}
export async function database(beforeIdentityMigration?: (db: PGlite) => Promise<void>, storage?: { dataDir: string; initialize: boolean }): Promise<{ db: PGlite; prisma: PrismaClient }> {
  const db: PGlite = new PGlite({ ...(storage ? { dataDir: storage.dataDir } : {}), parsers: {
    // Prisma reads timestamp-without-time-zone storage as UTC, independent of the host timezone.
    1114: (value: string): Date => new Date(`${value.replace(" ", "T")}Z`),
    1082: (value: string): Date => new Date(`${value}T00:00:00.000Z`),
  } });
  for (const directory of (!storage || storage.initialize) ? readdirSync("prisma/migrations").sort() : []) {
    if (directory === "migration_lock.toml") continue;
    if (directory === "20261026_scoped_record_identity" && beforeIdentityMigration) await beforeIdentityMigration(db);
    await db.exec(readFileSync(`prisma/migrations/${directory}/migration.sql`, "utf8"));
  }
  // Match Prisma's generated Date objects for timestamp columns on result rows.
  const wrap = (executor: Executor): Executor => ({ query: async <T extends Row>(sql: string, params?: unknown[]) => {
    const result = await executor.query<T>(sql, params);
    for (const row of result.rows) for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value === "string" && (key.endsWith("At") || key === "dateValue" || key === "dateTimeValue")) (row as Row)[key] = new Date(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
    }
    return result;
  } });
  const prisma: PrismaClient = port(wrap(db), async <T>(action: (tx: Executor) => Promise<T>): Promise<T> => db.transaction(async (tx): Promise<T> => action(wrap(tx))));
  return { db, prisma };
}
