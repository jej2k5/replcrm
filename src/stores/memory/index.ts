import type { FailedStatusRun, StatusRun } from "../status-runs.js";
import { randomUUID } from "node:crypto";
import type { CanonicalEntity, CanonicalValue, ChangeBatch, SourceRecord, SourceUser } from "../../core/source.js";
import type { Counts, PendingRun, Projection, ProjectionResult, ReplicaStore } from "../../core/replica-store.js";
import { mergeEntity, validateMetadata } from "../../core/metadata.js";
import { isReference, readTypedValue, toTypedValue } from "../../core/type-mapper.js";

export interface MemoryRecord extends SourceRecord { id: string; deletedAt?: Date; resolvedReferences: Record<string, string | null> }
interface MemoryRun { deploymentId: string; entityKey: string | null; status: "Running" | "Succeeded" | "Failed"; checkpoint: string | null; order: number; startedAt: Date; completedAt: Date | null; error?: string; counts?: Counts }
const key = (...parts: string[]): string => JSON.stringify(parts);

// Deliberately independent of database packages, generated clients and physical schemas.
export class InMemoryReplicaStore implements ReplicaStore {
  private deployments = new Map<string, { name: string; sourceUrl?: string }>();
  private entities = new Map<string, CanonicalEntity>();
  private users = new Map<string, SourceUser>();
  private records = new Map<string, MemoryRecord>();
  private runs = new Map<string, MemoryRun>();
  private nextOrder: number = 0;
  private projectionAttributes = new Map<string, string[]>();
  private projections = new Map<string, MemoryRecord[]>();
  ensureDeployment(id: string, name: string, sourceUrl?: string): void {
    if (!this.deployments.has(id)) {
      this.deployments.set(id, { name, ...(sourceUrl === undefined ? {} : { sourceUrl }) });
    }
  }

  deploymentExists(id: string): boolean {
    return this.deployments.has(id);
  }

  countRecords(deploymentId: string): Map<string, number> {
    const counts = new Map(this.listPersistedEntityKeys(deploymentId).map((entityKey) => [entityKey, 0]));
    for (const [identity, record] of this.records) {
      const [scope, entityKey] = JSON.parse(identity) as [string, string, string];
      if (scope === deploymentId && !record.isDeleted) {
        counts.set(entityKey, (counts.get(entityKey) ?? 0) + 1);
      }
    }
    return counts;
  }

  async listActiveSourceIds(deploymentId: string, entityKey: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const [identity, record] of this.records) {
      const [scope, entity] = JSON.parse(identity) as [string, string, string];
      if (scope === deploymentId && entity === entityKey && !record.isDeleted) ids.add(record.sourceId);
    }
    return ids;
  }

  async markDeleted(deploymentId: string, entityKey: string, sourceIds: readonly string[]): Promise<number> {
    const deletedAt = new Date();
    let count = 0;
    for (const sourceId of sourceIds) {
      const record = this.records.get(key(deploymentId, entityKey, sourceId));
      if (record && !record.isDeleted) {
        record.isDeleted = true;
        record.deletedAt = deletedAt;
        count++;
      }
    }
    return count;
  }

  listPersistedEntityKeys(deploymentId: string): string[] {
    const keys: string[] = [];
    for (const identity of this.entities.keys()) {
      const [scope, entityKey] = JSON.parse(identity) as [string, string];
      if (scope === deploymentId) keys.push(entityKey);
    }
    return keys.sort();
  }

  persistedEntityKeys(deploymentId: string): string[] {
    return this.listPersistedEntityKeys(deploymentId);
  }

  latestEntityRuns(deploymentId: string): Map<string, StatusRun> {
    const latest = new Map<string, StatusRun>();
    for (const run of this.runs.values()) {
      if (run.deploymentId !== deploymentId || run.entityKey === null) continue;
      latest.set(run.entityKey, {
        processed: 0, created: 0, updated: 0, deleted: 0, ...run.counts,
        startedAt: new Date(run.startedAt),
        completedAt: run.completedAt && new Date(run.completedAt),
        status: run.status, errorMessage: run.error ?? null,
      });
    }
    return latest;
  }

  runningRuns(deploymentId: string): { entityKey: string | null; startedAt: Date }[] {
    return [...this.runs.values()]
      .filter((run) => run.deploymentId === deploymentId && run.status === "Running")
      .reverse()
      .map(({ entityKey, startedAt }) => ({ entityKey, startedAt: new Date(startedAt) }));
  }

  recentFailedRuns(deploymentId: string, limit: number): FailedStatusRun[] {
    return [...this.runs.values()]
      .filter((run) => run.deploymentId === deploymentId && run.status === "Failed")
      .reverse().slice(0, limit)
      .map((run) => ({
        entityKey: run.entityKey, startedAt: new Date(run.startedAt),
        completedAt: run.completedAt && new Date(run.completedAt), errorMessage: run.error ?? null,
      }));
  }

  hasEntityMetadata(deploymentId: string, entityKeys: string[]): boolean {
    return entityKeys.every((entityKey) => this.entities.has(key(deploymentId, entityKey)));
  }

  async persistMetadata(deploymentId: string, entities: CanonicalEntity[]): Promise<void> {
    validateMetadata(entities);
    const next: Map<string, CanonicalEntity> = structuredClone(this.entities);
    for (const entity of entities) next.set(key(deploymentId, entity.key), mergeEntity(next.get(key(deploymentId, entity.key)) ?? null, entity));
    this.entities = next;
  }
  async persistUsers(deploymentId: string, users: SourceUser[]): Promise<Counts> {
    const counts: Counts = { processed: 0, created: 0, updated: 0, deleted: 0 };
    const next: Map<string, SourceUser> = structuredClone(this.users);
    for (const user of users) {
      const identity: string = key(deploymentId, user.sourceId);
      if (next.has(identity)) counts.updated += 1; else counts.created += 1;
      if ([...next].some(([id, stored]): boolean => id !== identity && JSON.parse(id)[0] === deploymentId && stored.username === user.username)) throw new Error("Duplicate deployment username");
      next.set(identity, structuredClone(user)); counts.processed += 1;
    }
    this.users = next;
    return counts;
  }
  async persistRecords(deploymentId: string, entity: CanonicalEntity, batch: ChangeBatch): Promise<Counts> {
    if (!this.entities.has(key(deploymentId, entity.key))) throw new Error("Metadata must be persisted first");
    const storedDefinition: CanonicalEntity = this.entities.get(key(deploymentId, entity.key))!;
    for (const attr of entity.attributes) {
      const stored = storedDefinition.attributes.find((item): boolean => item.key === attr.key);
      if (!stored || stored.dataType !== attr.dataType || JSON.stringify([...(stored.relationship?.targetEntityKeys ?? [])].sort()) !== JSON.stringify([...(attr.relationship?.targetEntityKeys ?? [])].sort())) throw new Error(`Metadata mismatch: ${entity.key}/${attr.key}`);
    }
    if (batch.nextCheckpoint !== null && typeof batch.nextCheckpoint !== "string") throw new Error("Opaque checkpoint must be a string or null");
    const next: Map<string, MemoryRecord> = structuredClone(this.records);
    const counts: Counts = { processed: 0, created: 0, updated: 0, deleted: 0 };
    for (const row of batch.records) {
      if (!row.sourceId || typeof row.sourceId !== "string") throw new Error("Nonempty source record ID required");
      if (row.isDeleted !== undefined && typeof row.isDeleted !== "boolean") throw new Error("Canonical deletion boolean required");
      if (row.modifiedAt != null && (!(row.modifiedAt instanceof Date) || !Number.isFinite(row.modifiedAt.getTime()))) throw new Error("Canonical modification date required");
      const identity: string = key(deploymentId, entity.key, row.sourceId);
      const previous: MemoryRecord | undefined = next.get(identity);
      const fields: Record<string, CanonicalValue> = { ...previous?.fields };
      for (const [name, value] of Object.entries(row.fields)) {
        const attr = entity.attributes.find((item): boolean => item.key === name);
        if (!attr) throw new Error(`Undeclared canonical attribute: ${entity.key}/${name}`);
        if (isReference(value) && attr.relationship?.targetEntityKeys.length && !attr.relationship.targetEntityKeys.includes(value.entityKey)) throw new Error(`Reference target outside declared relationship: ${entity.key}/${name}`);
        fields[name] = readTypedValue(attr.dataType, toTypedValue(attr.dataType, value, (): null => null));
      }
      const id: string = previous?.id ?? randomUUID();
      const resolvedReferences: Record<string, string | null> = { ...previous?.resolvedReferences };
      for (const [name, value] of Object.entries(row.fields)) {
        const attr = entity.attributes.find((item): boolean => item.key === name)!;
        if (attr.dataType === "Reference" || attr.dataType === "Composition") resolvedReferences[name] = isReference(value) ? (key(deploymentId, value.entityKey, value.sourceId) === identity ? id : next.get(key(deploymentId, value.entityKey, value.sourceId))?.id ?? null) : null;
      }
      next.set(identity, structuredClone({ ...row, isDeleted: row.isDeleted ?? false, modifiedAt: row.modifiedAt ?? null, fields, id, resolvedReferences }));
      counts.processed += 1;
      if (row.isDeleted) counts.deleted += 1; else if (previous) counts.updated += 1; else counts.created += 1;
    }
    this.records = next;
    return counts;
  }
  async resolveReferences(deploymentId: string, _batchSize: number): Promise<number> {
    let changed: number = 0;
    for (const [identity, row] of this.records) {
      const scope: string[] = JSON.parse(identity) as string[];
      if (scope[0] !== deploymentId) continue;
      for (const [name, value] of Object.entries(row.fields)) {
        if (!isReference(value)) continue;
        const target: string | null = this.records.get(key(deploymentId, value.entityKey, value.sourceId))?.id ?? null;
        if (target && target !== row.resolvedReferences[name]) changed += 1;
        row.resolvedReferences[name] = target;
      }
    }
    return changed;
  }
  async beginRun(deploymentId: string, entityKey: string | null): Promise<{ id: string; checkpoint: string | null }> {
    const checkpoint: string | null = entityKey === null ? null : this.getCheckpoint(deploymentId, entityKey);
    const id: string = randomUUID();
    this.runs.set(id, { deploymentId, entityKey, checkpoint, status: "Running", order: this.nextOrder++, startedAt: new Date(), completedAt: null });
    return { id, checkpoint };
  }
  async completeRuns(runs: PendingRun[]): Promise<void> {
    if (new Set(runs.map((item): string => item.id)).size !== runs.length) throw new Error("Duplicate run handle");
    const next: Map<string, MemoryRun> = structuredClone(this.runs);
    // Stage the entire proposal before publishing any successful progress.
    for (const item of runs) {
      const run: MemoryRun | undefined = next.get(item.id);
      if (!run) throw new Error("Unknown run");
      if (item.result.checkpoint !== null && typeof item.result.checkpoint !== "string") throw new Error("Opaque checkpoint must be a string or null");
      if (run.entityKey === null && item.result.checkpoint !== null) throw new Error("Stage run cannot publish checkpoint");
      if (run.status === "Succeeded") {
        if (run.checkpoint !== item.result.checkpoint) throw new Error("Conflicting completed checkpoint");
        continue;
      }
      if (run.status !== "Running") throw new Error("Run is not running");
      if (run.entityKey !== null && [...next.values()].some((other): boolean => other.deploymentId === run.deploymentId && other.entityKey === run.entityKey && other.status === "Succeeded" && other.order > run.order)) throw new Error("Stale replication attempt");
      run.status = "Succeeded"; run.checkpoint = item.result.checkpoint;
      const { processed, created, updated, deleted } = item.result;
      run.counts = { processed, created, updated, deleted };
      run.completedAt = new Date();
    }
    this.runs = next;
  }
  async failRun(id: string, message: string): Promise<void> {
    const run: MemoryRun | undefined = this.runs.get(id);
    if (!run) throw new Error("Unknown run");
    if (run.status === "Succeeded" || run.status === "Failed") return;
    run.status = "Failed"; run.error = message;
    run.completedAt = new Date();
  }
  async ensureProjections(deploymentId: string, entities: CanonicalEntity[]): Promise<ProjectionResult[]> {
    return entities.map((entity): ProjectionResult => {
      const definition: CanonicalEntity | undefined = this.entities.get(key(deploymentId, entity.key));
      if (!definition) throw new Error(`Missing persisted entity: ${entity.key}`);
      const records: MemoryRecord[] = this.readRecords(deploymentId, entity.key).map((row): MemoryRecord => ({ ...row, fields: Object.fromEntries(definition.attributes.map((attr): [string, CanonicalValue] => [attr.key, row.fields[attr.key] ?? null])) }));
      this.projections.set(key(deploymentId, entity.key), records);
      this.projectionAttributes.set(key(deploymentId, entity.key), definition.attributes.map((attr): string => attr.key).sort());
      return { entityKey: entity.key, rowsLoaded: records.length };
    });
  }
  getCheckpoint(deploymentId: string, entityKey: string): string | null {
    const successful: MemoryRun[] = [...this.runs.values()].filter((run): boolean => run.deploymentId === deploymentId && run.entityKey === entityKey && run.status === "Succeeded");
    successful.sort((a, b): number => b.order - a.order);
    return successful[0]?.checkpoint ?? null;
  }
  async resolveProjection(deploymentId: string, entityKey: string): Promise<Projection | null> {
    if (!this.projections.has(key(deploymentId, entityKey))) return null;
    const attributes: string[] = this.projectionAttributes.get(key(deploymentId, entityKey))!;
    return { deploymentId, entityKey, location: key(deploymentId, entityKey), attributeKeys: [...attributes] };
  }
  readEntity(deploymentId: string, entityKey: string): CanonicalEntity | null { return structuredClone(this.entities.get(key(deploymentId, entityKey)) ?? null); }
  readRecords(deploymentId: string, entityKey: string): MemoryRecord[] {
    return structuredClone([...this.records].filter(([identity]): boolean => {
      const scope: string[] = JSON.parse(identity) as string[];
      return scope[0] === deploymentId && scope[1] === entityKey;
    }).map(([, row]): MemoryRecord => row));
  }
  readProjection(deploymentId: string, entityKey: string): MemoryRecord[] { return structuredClone(this.projections.get(key(deploymentId, entityKey)) ?? []); }
}
