import { lstat } from "node:fs/promises";
import { collectCountRows, type CountingSource, type CountingStore, type CountRow } from "../cli-counts.js";
import type { resolveSelection } from "../cli-objects.js";
import type { ReplicationConfig } from "../core/config.js";
import { selectEntityKeys } from "../core/orchestrator.js";
import type { FailedStatusRun, StatusRun } from "../stores/status-runs.js";

type Awaitable<T> = T | Promise<T>;

export interface StatusStore extends Pick<CountingStore, "countRecords"> {
  latestEntityRuns(deploymentId: string): Awaitable<Map<string, StatusRun>>;
  recentFailedRuns(deploymentId: string, limit: number): Awaitable<FailedStatusRun[]>;
  persistedEntityKeys(deploymentId: string): Awaitable<string[]>;
}

export type StatusSource = Pick<CountingSource, "listEntities" | "countRecords"> &
  Partial<Pick<CountingSource, "logout">>;
export type StatusSourceInput = StatusSource | (() => Awaitable<StatusSource | undefined>);
export type StatusSelection = Pick<Awaited<ReturnType<typeof resolveSelection>>, "entities">;

export async function findInterruptedRuns(
  lockPath: string, readRuns: () => Promise<{ entityKey: string | null; startedAt: Date }[]>,
) {
  const running = await readRuns();
  if (!running.length) return running;
  try {
    await lstat(lockPath);
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return running;
    throw error;
  }
}

export interface StatusOptions {
  timeoutMs?: number;
  now?: () => Date;
}

export interface ConsoleStatus {
  interruptedRuns?: { entityKey: string | null; startedAt: Date }[];
  deploymentId: string;
  generatedAt: string;
  salesforce: { state: "ok" | "unavailable" | "not-configured"; reason?: string };
  objects: (CountRow & { lastRun: StatusRun | null })[];
  errors: { at: Date; entityKey: string | null; message: string }[];
}

export function redactMessage(message: string): string {
  return message.split(/\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|security[_-]?token|password)["']?\s*[:=]|\bBearer\s/i, 1)[0]!.trim();
}

function safeMessage(message: string): string {
  return redactMessage(message).slice(0, 200);
}

async function selectedKeys(config: ReplicationConfig, candidates: string[]): Promise<string[]> {
  if (!candidates.some((key) => !config.entityDenyKeys.includes(key))) return [];
  return selectEntityKeys(config, { listEntities: async () => candidates });
}

export async function buildStatus(
  config: ReplicationConfig, selection: StatusSelection, store: StatusStore,
  source?: StatusSourceInput, options: StatusOptions = {},
): Promise<ConsoleStatus> {
  const { deploymentId } = config;
  const selectionConfig = { ...config, entityKeys: selection.entities };
  const wildcard = selection.entities.length === 1 && selection.entities[0] === "*";
  let keys = wildcard ? undefined : await selectedKeys(selectionConfig, selection.entities);

  const [counts, latest, failures] = await Promise.all([
    store.countRecords(deploymentId),
    store.latestEntityRuns(deploymentId),
    store.recentFailedRuns(deploymentId, 10),
  ]);

  let salesforce: ConsoleStatus["salesforce"] = { state: "not-configured" };
  let rows: CountRow[] | undefined;
  if (source) {
    const deadline = new AbortController();
    const timedOut = new Error("Salesforce status timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadline.abort(timedOut);
        reject(timedOut);
      }, options.timeoutMs ?? 15_000);
    });

    const compare = async () => {
      const client = typeof source === "function" ? await source() : source;
      try {
        deadline.signal.throwIfAborted();
        if (!client) return undefined;
        if (keys === undefined) {
          const candidates = await client.listEntities();
          deadline.signal.throwIfAborted();
          keys = await selectedKeys(selectionConfig, candidates);
        }
        return await collectCountRows(keys, counts, {
          countRecords: (key) => {
            deadline.signal.throwIfAborted();
            return client.countRecords(key);
          },
        });
      } finally {
        // Cleanup may outlive the response deadline.
        void Promise.resolve().then(() => client?.logout?.()).catch(() => {});
      }
    };

    try {
      rows = await Promise.race([timeout, compare()]);
      if (rows) salesforce = { state: "ok" };
    } catch (error) {
      const reason = error instanceof Error ? safeMessage(error.message) : "";
      salesforce = { state: "unavailable", reason: reason || "Salesforce request failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  if (!rows) {
    keys ??= await selectedKeys(selectionConfig, await store.persistedEntityKeys(deploymentId));
    rows = await collectCountRows(keys, counts);
  }

  return {
    deploymentId,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    salesforce,
    objects: rows.map((row) => {
      const run = latest.get(row.entityKey);
      return {
        ...row,
        lastRun: run ? { ...run, errorMessage: run.errorMessage && safeMessage(run.errorMessage) } : null,
      };
    }),
    errors: failures.map((run) => ({
      at: run.completedAt ?? run.startedAt,
      entityKey: run.entityKey,
      message: (run.errorMessage && safeMessage(run.errorMessage)) || "Run failed",
    })),
  };
}
