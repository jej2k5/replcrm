import { parseEntityList } from "./cli-objects.js";
import { parseArgs } from "node:util";
import type { ReplicationConfig } from "./core/config.js";
import { selectEntityKeys } from "./core/orchestrator.js";

export interface CountingSource {
  listEntities(): Promise<string[]>;
  countRecords(entityKey: string): Promise<number>;
  logout(): Promise<void>;
}

export interface CountingStore {
  countRecords(deploymentId: string): Map<string, number> | Promise<Map<string, number>>;
  listPersistedEntityKeys(deploymentId: string): string[] | Promise<string[]>;
}

interface CountsOptions {
  json: boolean;
  storeOnly: boolean;
}

export interface CountRow {
  entityKey: string;
  storeCount: number;
  sourceCount?: number;
  status?: "MATCH" | "DIFF";
}

export function parseCountsArgs(args: string[]): CountsOptions & { entityKeys?: string[] } {
  const { values } = parseArgs({
    args,
    options: { entities: { type: "string" }, json: { type: "boolean" }, "store-only": { type: "boolean" } },
  });
  return {
    ...(values.entities === undefined ? {} : {
      entityKeys: parseEntityList(values.entities),
    }),
    json: values.json ?? false,
    storeOnly: values["store-only"] ?? false,
  };
}

export async function reportCounts(
  config: ReplicationConfig, options: CountsOptions, store: CountingStore, source?: CountingSource,
): Promise<void> {
  const { deploymentId } = config;
  const lister = source ?? { listEntities: async () => store.listPersistedEntityKeys(deploymentId) };
  let rows: CountRow[];
  try {
    const keys = await selectEntityKeys(config, lister);
    const counts = await store.countRecords(deploymentId);
    rows = await collectCountRows(keys, counts, source);
  } finally {
    await source?.logout();
  }

  if (options.json) {
    console.log(JSON.stringify(rows));
    return;
  }
  const columns = source ? ["Entity", "Store", "Salesforce", "Status"] : ["Entity", "Store"];
  const table = [
    columns,
    ...rows.map(({ entityKey, storeCount, sourceCount, status }) => status === undefined
      ? [entityKey, String(storeCount)]
      : [entityKey, String(storeCount), String(sourceCount), status]),
  ];
  const widths = columns.map((_, index) => table.reduce((width, row) => Math.max(width, row[index]!.length), 0));
  console.log(table.map((row) => row.map((cell, index) =>
    index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"));
}

export async function collectCountRows(
  keys: string[], counts: Map<string, number>, source?: Pick<CountingSource, "countRecords">,
): Promise<CountRow[]> {
  const rows: CountRow[] = [];
  for (const entityKey of keys) {
    const storeCount = counts.get(entityKey) ?? 0;
    if (source) {
      const sourceCount = await source.countRecords(entityKey);
      rows.push({ entityKey, storeCount, sourceCount, status: storeCount === sourceCount ? "MATCH" : "DIFF" });
    } else {
      rows.push({ entityKey, storeCount });
    }
  }
  return rows;
}
