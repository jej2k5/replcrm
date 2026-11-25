import type { ReplicationConfig } from "./config.js";
import type { CanonicalEntity, CrmSource } from "./source.js";
import type { Counts, PendingRun, ProjectionResult, ReplicaStore } from "./replica-store.js";

export interface OrchestratorDeps { store: ReplicaStore; config: ReplicationConfig; sourceClient: CrmSource }
const emptyCounts = (): Counts => ({ processed: 0, created: 0, updated: 0, deleted: 0 });
async function stage<T>(store: ReplicaStore, deploymentId: string, name: string, action: () => Promise<T>, summarize: (result: T) => Counts = (): Counts => emptyCounts()): Promise<T> {
  console.log(`[replication] ${name}`);
  const run = await store.beginRun(deploymentId, null);
  try {
    const result: T = await action();
    await store.completeRuns([{ id: run.id, result: { ...summarize(result), checkpoint: null } }]);
    return result;
  } catch (error: unknown) {
    await store.failRun(run.id, `${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export async function selectEntityKeys(
  config: ReplicationConfig,
  lister: { listEntities(): Promise<string[]> },
): Promise<string[]> {
  const requested: string[] = config.entityKeys.length === 1 && config.entityKeys[0] === "*" ? await lister.listEntities() : config.entityKeys;
  const keys: string[] = [...new Set(requested)].filter((key: string): boolean => !config.entityDenyKeys.includes(key));
  if (!keys.length) throw new Error("No entities selected for replication");
  return keys;
}

export async function describeEntities(source: CrmSource, keys: string[]): Promise<CanonicalEntity[]> {
  const definitions: CanonicalEntity[] = [];
  for (const key of keys) {
    const entity: CanonicalEntity = await source.describeEntity(key);
    if (entity.key !== key) throw new Error(`Entity definition key mismatch: ${key}`);
    if (new Set(entity.attributes.map((attr): string => attr.key)).size !== entity.attributes.length) throw new Error(`Duplicate attribute key: ${key}`);
    for (const attr of entity.attributes) if ((attr.dataType === "Reference" || attr.dataType === "Composition") !== Boolean(attr.relationship)) throw new Error(`Relationship metadata mismatch: ${key}/${attr.key}`);
    definitions.push(entity);
  }
  return definitions;
}

export async function runWithSource<T>(
  { config, sourceClient: source }: OrchestratorDeps,
  action: () => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1) throw new Error("Positive integer batch size required");
  await source.connect();
  try {
    return await action();
  } finally {
    await source.logout();
  }
}

// Stage functions use an already connected source. Full replication shares its metadata snapshot.
export async function runMetadataStage(
  { store, config, sourceClient: source }: OrchestratorDeps,
): Promise<CanonicalEntity[]> {
  const keys = await selectEntityKeys(config, source);
  return stage(store, config.deploymentId, "metadata", async (): Promise<CanonicalEntity[]> => {
    const definitions = await describeEntities(source, keys);
    await store.persistMetadata(config.deploymentId, definitions);
    return definitions;
  });
}

export async function runUsersStage({ store, config, sourceClient: source }: OrchestratorDeps): Promise<void> {
  await stage(store, config.deploymentId, "users", async (): Promise<Counts> => {
    const total: Counts = emptyCounts();
    for await (const users of source.streamUsers(config.batchSize)) {
      const counts: Counts = await store.persistUsers(config.deploymentId, users);
      for (const key of ["processed", "created", "updated", "deleted"] as const) total[key] += counts[key];
    }
    return total;
  }, (counts: Counts): Counts => counts);
}

export async function runRecordsStage(
  deps: OrchestratorDeps,
  definitions?: CanonicalEntity[],
): Promise<void> {
  const entities = await syncRecordsStage(deps, definitions);
  if (deps.config.buildWideViews) await runProjectionsStage(deps, entities);
}

async function syncRecordsStage(
  { store, config, sourceClient: source }: OrchestratorDeps,
  definitions?: CanonicalEntity[],
): Promise<CanonicalEntity[]> {
  const entities = definitions ?? await describeEntities(source, await selectEntityKeys(config, source));
  const pending: PendingRun[] = [];
  try {
    for (const entity of entities) {
      const run = await store.beginRun(config.deploymentId, entity.key);
      const item: PendingRun = { id: run.id, result: { ...emptyCounts(), checkpoint: run.checkpoint } };
      pending.push(item);
      for await (const batch of source.fetchChanges(entity, run.checkpoint, config.batchSize)) {
        if (batch.nextCheckpoint !== null && typeof batch.nextCheckpoint !== "string") throw new Error("Opaque checkpoint must be a string or null");
        const counts: Counts = await store.persistRecords(config.deploymentId, entity, batch);
        for (const key of ["processed", "created", "updated", "deleted"] as const) item.result[key] += counts[key];
        item.result.checkpoint = batch.nextCheckpoint;
      }
    }
    await store.resolveReferences(config.deploymentId, config.batchSize);
    await store.completeRuns(pending);
  } catch (error: unknown) {
    for (const item of pending) await store.failRun(item.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
  return entities;
}

export async function runProjectionsStage(
  { store, config, sourceClient: source }: OrchestratorDeps,
  definitions?: CanonicalEntity[],
  options?: { rebuild?: boolean },
): Promise<void> {
  const entities = definitions ?? await describeEntities(source, await selectEntityKeys(config, source));
  await stage(
    store,
    config.deploymentId,
    "projections",
    async () => {
      const projectionOptions = config.replicaViewSchema === undefined
        ? options : { ...options, replicaViewSchema: config.replicaViewSchema };
      const results = await store.ensureProjections(config.deploymentId, entities, projectionOptions);
      for (const result of results) {
        if (result.rebuildReason) console.log(`[replication] Rebuilt projection for ${result.entityKey} (${result.rebuildReason})`);
      }
      return results;
    },
    (results: ProjectionResult[]): Counts => ({
      ...emptyCounts(),
      processed: results.reduce((sum, item) => sum + item.rowsLoaded, 0),
    }),
  );
}

export async function runReplication(deps: OrchestratorDeps): Promise<void> {
  await runWithSource(deps, async () => {
    const definitions = await runMetadataStage(deps);
    await runUsersStage(deps);
    await syncRecordsStage(deps, definitions);
    if (deps.config.buildWideViews ?? true) await runProjectionsStage(deps, definitions);
  });
}

export const runMigration: typeof runReplication = runReplication;
