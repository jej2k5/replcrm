import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { SchemaProbe } from "./core.js";

// Schema checks and the one schema change setup may make. It never resets or drops anything:
// it only runs `prisma migrate deploy`, and it refuses databases holding tables ReplCRM didn't create.

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../prisma/migrations/", import.meta.url));

export async function shippedMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function probeSchema(prisma: PrismaClient): Promise<SchemaProbe> {
  const shipped = await shippedMigrations();
  const table = (await prisma.$queryRaw<{ table: string | null }[]>`SELECT to_regclass('public._prisma_migrations')::text AS "table"`)[0]?.table;
  if (!table) {
    const count = (await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = 'public'`)[0]?.count ?? 0n;
    if (Number(count) === 0) return { state: "empty", pending: shipped };
    return { state: "foreign", reason: `${Number(count)} table${Number(count) === 1 ? "" : "s"} already in the public schema` };
  }
  const applied = new Set((await prisma.$queryRaw<{ name: string }[]>`
    SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
    .map((row) => row.name));
  const pending = shipped.filter((name) => !applied.has(name));
  if (!pending.length) return { state: "current" };
  let populated = false;
  try {
    const count = (await prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM "Deployment"`)[0]?.count ?? 0n;
    populated = Number(count) > 0;
  } catch {
    populated = false;
  }
  return { state: "pending", pending, populated };
}

/** Runs the project's own Prisma CLI against the given database. Output never echoes the URL. */
export function applyMigrations(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)), "migrate", "deploy"], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120_000,
    }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const reason = String(stderr).split("\n").find((line) => /error/i.test(line))?.replace(databaseUrl, "[database]") ?? "migrate deploy failed";
      reject(new Error(reason.slice(0, 300)));
    });
  });
}
