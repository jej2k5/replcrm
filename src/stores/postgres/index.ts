import { type PrismaClient, type Prisma, SyncStatus } from "@prisma/client";
import type { CanonicalEntity, ChangeBatch, SourceUser } from "../../core/source.js";
import type { Counts, PendingRun, Projection, ProjectionResult, ReplicaStore } from "../../core/replica-store.js";
import { validateMetadata } from "../../core/metadata.js";
import { syncMetadata } from "./metadata-sync.js";
import { syncUsers } from "./user-sync.js";
import { syncRecords, backfillReferences } from "./record-sync.js";
import { resolveProjection, syncWideViews } from "./wide-view-sync.js";

export class PostgresReplicaStore implements ReplicaStore {
  constructor(private readonly prisma: PrismaClient) {}
  async persistMetadata(deploymentId: string, entities: CanonicalEntity[]): Promise<void> {
    validateMetadata(entities);
    // Validate every incoming stable key before publishing any metadata changes.
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
      for (const entity of entities) {
        const current = await tx.entityDefinition.findUnique({ where: { deploymentId_key: { deploymentId, key: entity.key } } });
        if (!current) continue;
        const attrs = await tx.attributeDefinition.findMany({ where: { entityDefinitionId: current.id } });
        for (const attr of entity.attributes) {
          const old = attrs.find((item): boolean => item.key === attr.key);
          if (old && old.dataType !== attr.dataType) throw new Error(`Incompatible attribute type change: ${entity.key}/${attr.key}`);
          if (old && JSON.stringify([...old.referenceEntityKeys].sort()) !== JSON.stringify([...(attr.relationship?.targetEntityKeys ?? [])].sort())) throw new Error(`Incompatible relationship change: ${entity.key}/${attr.key}`);
        }
      }
      await syncMetadata(tx, deploymentId, entities);
    }, { timeout: 300000, maxWait: 10000 });
  }
  async persistUsers(deploymentId: string, users: SourceUser[]): Promise<Counts> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<Counts> => ({ ...await syncUsers(tx, deploymentId, users), deleted: 0 }), { timeout: 300000, maxWait: 10000 });
  }
  async persistRecords(deploymentId: string, definition: CanonicalEntity, batch: ChangeBatch): Promise<Counts> {
    const entity = await this.prisma.entityDefinition.findUnique({ where: { deploymentId_key: { deploymentId, key: definition.key } } });
    if (!entity) throw new Error(`Missing persisted entity: ${definition.key}`);
    const attrs = await this.prisma.attributeDefinition.findMany({ where: { entityDefinitionId: entity.id } });
    for (const attr of definition.attributes) {
      const stored = attrs.find((item): boolean => item.key === attr.key);
      if (!stored || stored.dataType !== attr.dataType || JSON.stringify([...stored.referenceEntityKeys].sort()) !== JSON.stringify([...(attr.relationship?.targetEntityKeys ?? [])].sort())) throw new Error(`Metadata mismatch: ${definition.key}/${attr.key}`);
    }
    return syncRecords(this.prisma, deploymentId, entity, definition, attrs, null, batch);
  }
  async resolveReferences(deploymentId: string, batchSize: number): Promise<number> { return backfillReferences(this.prisma, deploymentId, batchSize); }
  async beginRun(deploymentId: string, entityKey: string | null): Promise<{ id: string; checkpoint: string | null }> {
    const last = entityKey === null ? null : await this.prisma.syncRun.findFirst({ where: { deploymentId, entityKey, status: SyncStatus.Succeeded }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    const latest = await this.prisma.syncRun.findFirst({ where: { deploymentId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    const checkpoint: string | null = last?.cursor ?? null;
    // Local attempt order, not source-token order. Deployment runs are serialized.
    const run = await this.prisma.syncRun.create({ data: { deploymentId, entityKey, status: SyncStatus.Running, cursor: checkpoint, startedAt: new Date(Math.max(Date.now(), (latest?.startedAt.getTime() ?? 0) + 1)) } });
    return { id: run.id, checkpoint };
  }
  async completeRuns(runs: PendingRun[]): Promise<void> {
    if (new Set(runs.map((item): string => item.id)).size !== runs.length) throw new Error("Duplicate run handle");
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
      for (const item of runs) {
        const run = await tx.syncRun.findUnique({ where: { id: item.id } });
        if (!run) throw new Error("Unknown run");
        if (item.result.checkpoint !== null && typeof item.result.checkpoint !== "string") throw new Error("Opaque checkpoint must be a string or null");
        if (run.entityKey === null && item.result.checkpoint !== null) throw new Error("Stage run cannot publish checkpoint");
        if (run.status === SyncStatus.Succeeded) {
          if (run.cursor !== item.result.checkpoint) throw new Error("Conflicting completed checkpoint");
          continue; // Lost acknowledgement: same durable result, no timestamp/order mutation.
        }
        if (run.status !== SyncStatus.Running) throw new Error("Run is not running");
        if (run.entityKey !== null) {
          const newer = await tx.syncRun.findFirst({ where: { deploymentId: run.deploymentId, entityKey: run.entityKey, status: SyncStatus.Succeeded, OR: [{ startedAt: { gt: run.startedAt } }, { startedAt: run.startedAt, id: { gt: run.id } }] } });
          if (newer) throw new Error("Stale replication attempt");
        }
        const changed = await tx.syncRun.updateMany({ where: { id: item.id, status: SyncStatus.Running }, data: { status: SyncStatus.Succeeded, completedAt: new Date(), cursor: item.result.checkpoint, recordsProcessed: item.result.processed, recordsCreated: item.result.created, recordsUpdated: item.result.updated, recordsDeleted: item.result.deleted } });
        if (changed.count !== 1) {
          const outcome = await tx.syncRun.findUnique({ where: { id: item.id } });
          if (outcome?.status !== SyncStatus.Succeeded || outcome.cursor !== item.result.checkpoint) throw new Error("Run is no longer running");
        }
      }
    });
  }
  async failRun(id: string, message: string): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
      const run = await tx.syncRun.findUnique({ where: { id } });
      if (!run) throw new Error("Unknown run");
      if (run.status === SyncStatus.Succeeded || run.status === SyncStatus.Failed) return;
      await tx.syncRun.updateMany({ where: { id, status: SyncStatus.Running }, data: { status: SyncStatus.Failed, completedAt: new Date(), errorMessage: message } });
    });
  }
  async ensureProjections(deploymentId: string, definitions: CanonicalEntity[]): Promise<ProjectionResult[]> {
    const entities = [];
    for (const definition of definitions) {
      const entity = await this.prisma.entityDefinition.findUnique({ where: { deploymentId_key: { deploymentId, key: definition.key } } });
      if (!entity) throw new Error(`Missing persisted entity: ${definition.key}`);
      entities.push(entity);
    }
    return syncWideViews(this.prisma, deploymentId, entities);
  }
  async resolveProjection(deploymentId: string, entityKey: string): Promise<Projection | null> { return resolveProjection(this.prisma, deploymentId, entityKey); }
}
