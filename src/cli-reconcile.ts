import { parseEntityList } from "./cli-objects.js";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readPrivateJson, safeDeploymentFileName, writePrivateJson } from "./cli-config-dir.js";
import { loadBinding, type DeploymentBinding } from "./cli-verify.js";
import type { ReplicationConfig } from "./core/config.js";
import { selectEntityKeys } from "./core/orchestrator.js";
import type { ReplicaStore } from "./core/replica-store.js";
import type { CrmSource } from "./core/source.js";
import type { SalesforceIdentity } from "./sources/salesforce/client.js";
import { acquireLock, LockHeldError, type FileLock } from "./locks/file-lock.js";

interface ReconcileStore extends Pick<ReplicaStore, "beginRun" | "completeRuns" | "failRun"> {
  listActiveSourceIds(deploymentId: string, entityKey: string): Promise<Set<string>>;
  markDeleted(deploymentId: string, entityKey: string, sourceIds: readonly string[]): Promise<number>;
}

interface ReconcileSource extends Pick<CrmSource, "listSourceIds" | "logout"> {
  identity(): Promise<SalesforceIdentity>;
}

export interface ReconcileDeps {
  configDir(): string;
  now(): Date;
  createSource(): ReconcileSource | Promise<ReconcileSource>;
  createStore(): ReconcileStore | Promise<ReconcileStore>;
}

interface EntityPlan {
  liveCount: number;
  storeActiveCount: number;
  candidates: string[];
}

interface Plan {
  version: 1;
  organizationId: string;
  userId: string;
  createdAt: string;
  entities: Record<string, EntityPlan>;
}

const maxAge = 60 * 60 * 1000;

function requireFreshPlan(plan: Plan, now: Date): void {
  const age = now.getTime() - Date.parse(plan.createdAt);
  if (!(age >= 0 && age <= maxAge)) throw new Error("Reconcile plan is expired or future-dated. Preview again.");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlan(value: unknown): value is Plan {
  return object(value) && value.version === 1 &&
    typeof value.organizationId === "string" && typeof value.userId === "string" &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    object(value.entities) && Object.keys(value.entities).length > 0 &&
    Object.entries(value.entities).every(([key, row]) => key.trim() && object(row) &&
      count(row.liveCount) && count(row.storeActiveCount) &&
      Array.isArray(row.candidates) && row.candidates.every((id) => typeof id === "string" && id.length > 0));
}

function sameIdentity(a: Pick<DeploymentBinding, "organizationId" | "userId">, b: typeof a): boolean {
  return a.organizationId === b.organizationId && a.userId === b.userId;
}

async function withPlanLock<T>(
  action: () => Promise<T>, acquire: () => Promise<FileLock>,
): Promise<T> {
  const lock = await acquire();
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

async function listLiveIds(source: ReconcileSource, key: string, batchSize: number): Promise<Set<string>> {
  if (!source.listSourceIds) throw new Error("Source ID listing is unavailable");
  const ids = new Set<string>();
  for await (const batch of source.listSourceIds(key, batchSize)) {
    for (const id of batch) ids.add(id);
  }
  return ids;
}

async function applyEntity(
  store: ReconcileStore, source: ReconcileSource, config: ReplicationConfig, key: string, row: EntityPlan,
  allowEmpty: boolean, allowLarge: boolean,
): Promise<number> {
  const { deploymentId, batchSize } = config;
  const { id } = await store.beginRun(deploymentId, null);
  try {
    const live = await listLiveIds(source, key, batchSize);
    const active = await store.listActiveSourceIds(deploymentId, key);
    const candidates = [...new Set(row.candidates)].filter((id) => active.has(id) && !live.has(id));
    if (!live.size && active.size && !allowEmpty) {
      throw new Error("Live listing is empty with active store records. Review and retry with --allow-empty.");
    }
    if (candidates.length > active.size / 2 && !allowLarge) {
      throw new Error("Candidates exceed half the active store records. Review and retry with --allow-large.");
    }
    const deleted = await store.markDeleted(deploymentId, key, candidates);
    await store.completeRuns([{ id, result: { checkpoint: null, processed: deleted, created: 0, updated: 0, deleted } }]);
    return deleted;
  } catch (error) {
    const message = `Reconcile failed for ${key}: ${error instanceof Error ? error.message : String(error)}`;
    await store.failRun(id, message);
    throw new Error(message);
  }
}

export function parseReconcileArgs(args: string[]) {
  return parseArgs({ args, options: {
    entities: { type: "string" }, apply: { type: "boolean" }, json: { type: "boolean" },
    "allow-empty": { type: "boolean" }, "allow-large": { type: "boolean" },
  } }).values;
}

export async function reconcile(
  values: ReturnType<typeof parseReconcileArgs>, config: ReplicationConfig, deps: ReconcileDeps,
  resolveEntities: (flag?: string[]) => Promise<string[]>,
  requireDeployment: (id: string) => Promise<void>,
  hasEntityMetadata: (id: string, keys: string[]) => boolean | Promise<boolean>,
  acquireApplyPlanLock?: (acquire: () => Promise<FileLock>) => Promise<FileLock>,
): Promise<void> {
  const { deploymentId, batchSize, buildWideViews } = config;
  let keys: string[];
  if (values.apply) {
    if (values.entities !== undefined) throw new Error("Reconcile apply uses the reviewed plan. Omit --entities.");
    keys = [];
  } else {
    const requested = await resolveEntities(values.entities === undefined ? undefined : parseEntityList(values.entities));
    if (requested.includes("*")) throw new Error("Reconcile requires explicit object keys. Use --entities a,b.");
    if (values["allow-empty"] || values["allow-large"]) throw new Error("Safety overrides require --apply.");
    keys = await selectEntityKeys({ ...config, entityKeys: requested }, {
      listEntities: async () => { throw new Error("Reconcile requires --entities a,b."); },
    });
  }

  const configDir = deps.configDir();
  const path = join(configDir, "reconcile", `${safeDeploymentFileName(deploymentId)}.json`);
  const lockPath = `${path}.lock`;
  const acquirePlanLock = () => acquireLock(lockPath, { command: "reconcile" }).catch((error: unknown) => {
    if (!(error instanceof LockHeldError)) throw error;
    throw new Error(`Reconcile lock exists at ${lockPath}. If no reconcile is running, remove it and retry.`);
  });
  let plan: Plan | undefined;
  if (values.apply) {
    const stored = await readPrivateJson(path);
    if (stored === undefined) throw new Error("No reviewed reconcile plan. Run reconcile --entities a,b first.");
    if (!isPlan(stored)) throw new Error(`Invalid reconcile plan at ${path}.`);
    plan = stored;
    keys = Object.keys(plan.entities);
    if (keys.includes("*")) throw new Error("Reconcile plan contains *. Preview again with --entities a,b.");
    requireFreshPlan(plan, deps.now());
  }

  await requireDeployment(deploymentId);
  if (!(await hasEntityMetadata(deploymentId, keys))) {
    throw new Error("Entity metadata is missing for the selected entities. Run npm run replicate:metadata first.");
  }
  const binding = await loadBinding(configDir, deploymentId);
  if (!binding) throw new Error("Deployment binding is missing. Run deployment verify first.");
  if (plan && !sameIdentity(plan, binding)) {
    throw new Error(`Reconcile plan identity mismatch. Plan org ${plan.organizationId}, user ${plan.userId}. Binding org ${binding.organizationId}, user ${binding.userId}.`);
  }

  const source = await deps.createSource();
  try {
    const liveIdentity = await source.identity();
    if (!sameIdentity(liveIdentity, binding)) {
      throw new Error(`Live identity mismatch. Binding org ${binding.organizationId}, user ${binding.userId}. Live org ${liveIdentity.organizationId}, user ${liveIdentity.userId}.`);
    }
    const store = await deps.createStore();
    if (plan) {
      const reviewed = plan;
      const results = await withPlanLock(async () => {
        if (JSON.stringify(await readPrivateJson(path)) !== JSON.stringify(reviewed)) {
          throw new Error("Reconcile plan changed. Review the current plan before applying.");
        }
        requireFreshPlan(reviewed, deps.now());
        const rows = [];
        for (const key of keys) {
          const deleted = await applyEntity(store, source, config, key, reviewed.entities[key]!,
            values["allow-empty"] ?? false, values["allow-large"] ?? false);
          rows.push({ entityKey: key, deleted });
        }
        await unlink(path);
        return rows;
      }, acquireApplyPlanLock ? () => acquireApplyPlanLock(acquirePlanLock) : acquirePlanLock);
      const reminder = buildWideViews ? "Rerun projections to refresh wide views." : undefined;
      console.log(values.json ? JSON.stringify({ results, reminder }) :
        [...results.map(({ entityKey, deleted }) => `${entityKey}: ${deleted} marked deleted`), reminder].filter(Boolean).join("\n"));
    } else {
      const entities: Record<string, EntityPlan> = Object.create(null);
      for (const key of keys) {
        const live = await listLiveIds(source, key, batchSize);
        const active = await store.listActiveSourceIds(deploymentId, key);
        entities[key] = {
          liveCount: live.size, storeActiveCount: active.size,
          candidates: [...active].filter((id) => !live.has(id)).sort(),
        };
      }
      const preview: Plan = {
        version: 1, organizationId: binding.organizationId, userId: binding.userId,
        createdAt: deps.now().toISOString(), entities,
      };
      await withPlanLock(() => writePrivateJson(path, preview), acquirePlanLock);
      const message = "Review, then run reconcile --apply";
      const results = Object.entries(entities).map(([entityKey, row]) => ({
        entityKey, liveCount: row.liveCount, storeActiveCount: row.storeActiveCount,
        candidateCount: row.candidates.length, sampleSourceIds: row.candidates.slice(0, 10),
      }));
      console.log(values.json ? JSON.stringify({ path, results, message }) :
        [...results.map((row) => `${row.entityKey}: ${row.candidateCount} candidates ${row.sampleSourceIds.join(", ")}`.trimEnd()),
          `Plan saved to ${path}.`, message].join("\n"));
    }
  } finally {
    await source.logout();
  }
}
