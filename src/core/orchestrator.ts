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

export async function runReplication({ store, config, sourceClient: source }: OrchestratorDeps): Promise<void> {
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1) throw new Error("Positive integer batch size required");
  await source.connect();
  const pending: PendingRun[] = [];
  try {
    const requested: string[] = config.entityKeys.length === 1 && config.entityKeys[0] === "*" ? await source.listEntities() : config.entityKeys;
    const keys: string[] = [...new Set(requested)].filter((key: string): boolean => !config.entityDenyKeys.includes(key));
    if (!keys.length) throw new Error("No entities selected for replication");
    const definitions: CanonicalEntity[] = [];
    await stage(store, config.deploymentId, "metadata", async (): Promise<void> => {
      for (const key of keys) {
        const entity: CanonicalEntity = await source.describeEntity(key);
        if (entity.key !== key) throw new Error(`Entity definition key mismatch: ${key}`);
        if (new Set(entity.attributes.map((attr): string => attr.key)).size !== entity.attributes.length) throw new Error(`Duplicate attribute key: ${key}`);
        for (const attr of entity.attributes) if ((attr.dataType === "Reference" || attr.dataType === "Composition") !== Boolean(attr.relationship)) throw new Error(`Relationship metadata mismatch: ${key}/${attr.key}`);
        definitions.push(entity);
      }
      await store.persistMetadata(config.deploymentId, definitions);
    });
    await stage(store, config.deploymentId, "users", async (): Promise<Counts> => {
      const total: Counts = emptyCounts();
      for await (const users of source.streamUsers(config.batchSize)) {
        const counts: Counts = await store.persistUsers(config.deploymentId, users);
        for (const key of ["processed", "created", "updated", "deleted"] as const) total[key] += counts[key];
      }
      return total;
    }, (counts: Counts): Counts => counts);
    for (const entity of definitions) {
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
    pending.length = 0;
    if (config.buildWideViews ?? true) await stage(store, config.deploymentId, "projections", async (): Promise<ProjectionResult[]> => store.ensureProjections(config.deploymentId, definitions), (results: ProjectionResult[]): Counts => ({ ...emptyCounts(), processed: results.reduce((sum: number, item: ProjectionResult): number => sum + item.rowsLoaded, 0) }));
  } catch (error: unknown) {
    for (const item of pending) await store.failRun(item.id, error instanceof Error ? error.message : String(error));
    throw error;
  } finally { await source.logout(); }
}
export const runMigration: typeof runReplication = runReplication;
