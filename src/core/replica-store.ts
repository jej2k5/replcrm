import type { CanonicalEntity, ChangeBatch, SourceUser, JsonValue } from "./source.js";

export interface Counts { processed: number; created: number; updated: number; deleted: number }
export interface RecordSyncResult extends Counts { checkpoint: string | null }
export interface PendingRun { id: string; result: RecordSyncResult }
export interface ProjectionResult { entityKey: string; rowsLoaded: number }

export interface Projection {
  deploymentId: string;
  entityKey: string;
  // Store-supplied opaque consumer locator. Never derive it from canonical keys.
  location: JsonValue;
  attributeKeys: string[];
}

/**
 * Successful mutation means logical application is complete and dependent reads
 * observe it. Persistent stores retain it across reconnect/restart; memory has an
 * explicit instance lifetime. Acceptance, upload or scheduling is not success.
 * Calls are serialized per deployment. Retry failed/unknown work in original
 * order before newer work, or replay the source suffix from successful progress.
 * Record patches apply in array order, atomically per batch; missing != null.
 * Completion is idempotent for the same attempt/token; successful attempts cannot
 * be demoted. Older attempts cannot supersede newer successful progress. Tokens
 * are opaque: only local attempt order determines stale work, never token order.
 * See docs/replica-store.md for recovery, evolution and publication guarantees.
 */
export interface ReplicaStore {
  resolveProjection(deploymentId: string, entityKey: string): Promise<Projection | null>;
  persistMetadata(deploymentId: string, entities: CanonicalEntity[]): Promise<void>;
  persistUsers(deploymentId: string, users: SourceUser[]): Promise<Counts>;
  persistRecords(deploymentId: string, entity: CanonicalEntity, batch: ChangeBatch): Promise<Counts>;
  resolveReferences(deploymentId: string, batchSize: number): Promise<number>;
  beginRun(deploymentId: string, entityKey: string | null): Promise<{ id: string; checkpoint: string | null }>;
  completeRuns(runs: PendingRun[]): Promise<void>;
  failRun(id: string, message: string): Promise<void>;
  ensureProjections(deploymentId: string, entities: CanonicalEntity[]): Promise<ProjectionResult[]>;
}
