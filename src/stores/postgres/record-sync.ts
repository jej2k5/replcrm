import { Prisma, type AttributeDefinition, type EntityDefinition, type PrismaClient } from "@prisma/client";
import type { CanonicalEntity, SourceRecord, RecordReference } from "../../core/source.js";
import { isReference, toTypedValue, type TypedValue } from "../../core/type-mapper.js";
import { loadUserIdMap, resolveOwnershipFks } from "./user-sync.js";

export interface RecordSyncResult { processed: number; created: number; updated: number; deleted: number; checkpoint: string | null }
export function referenceKey(ref: RecordReference): string { return JSON.stringify([ref.entityKey, ref.sourceId]); }

async function resolveReferences(prisma: PrismaClient, deploymentId: string, refs: RecordReference[]): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  const unique: RecordReference[] = [...new Map(refs.map((ref: RecordReference): [string, RecordReference] => [referenceKey(ref), ref])).values()];
  const result: Map<string, string> = new Map();
  for (let offset: number = 0; offset < unique.length; offset += 500) {
    const rows = await prisma.record.findMany({
      where: { deploymentId, OR: unique.slice(offset, offset + 500).map((ref: RecordReference) => ({ sourceId: ref.sourceId, entityDefinition: { key: ref.entityKey } })) },
      select: { id: true, sourceId: true, entityDefinition: { select: { key: true } } },
    });
    for (const row of rows) result.set(referenceKey({ kind: "reference", entityKey: row.entityDefinition.key, sourceId: row.sourceId! }), row.id);
  }
  return result;
}
function storageData(value: TypedValue): Omit<TypedValue, "jsonValue"> & { jsonValue: Prisma.InputJsonValue | typeof Prisma.DbNull } {
  return { ...value, jsonValue: value.jsonValue === null ? Prisma.DbNull : value.jsonValue };
}

export async function syncRecords(prisma: PrismaClient, deploymentId: string, entity: EntityDefinition, definition: CanonicalEntity, attributes: AttributeDefinition[], checkpoint: string | null, batch: import("../../core/source.js").ChangeBatch): Promise<RecordSyncResult> {
  const result: RecordSyncResult = { processed: 0, created: 0, updated: 0, deleted: 0, checkpoint };
  const users: Map<string, string> = await loadUserIdMap(prisma, deploymentId);
  const declared: Set<string> = new Set(definition.attributes.map((attr): string => attr.key));
  const referenceAttributes: AttributeDefinition[] = attributes.filter((attr: AttributeDefinition): boolean => attr.dataType === "Reference" || attr.dataType === "Composition");
  {
    if (batch.nextCheckpoint !== null && typeof batch.nextCheckpoint !== "string") throw new Error("Opaque checkpoint must be a string or null");
    const refs: RecordReference[] = batch.records.flatMap((row: SourceRecord): RecordReference[] => referenceAttributes.flatMap((attr: AttributeDefinition): RecordReference[] => {
      const value = row.fields[attr.key];
      return isReference(value) ? [value] : [];
    }));
    const resolved: Map<string, string> = await resolveReferences(prisma, deploymentId, refs);
    await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
      for (const row of batch.records) {
        for (const key of Object.keys(row.fields)) if (!declared.has(key)) throw new Error(`Undeclared canonical attribute: ${entity.key}/${key}`);
        if (typeof row.sourceId !== "string" || !row.sourceId) throw new Error("Nonempty source record ID required");
        if (row.isDeleted !== undefined && typeof row.isDeleted !== "boolean") throw new Error("Canonical deletion boolean required");
        if (row.modifiedAt != null && (!(row.modifiedAt instanceof Date) || !Number.isFinite(row.modifiedAt.getTime()))) throw new Error("Canonical modification date required");
        const identity = { deploymentId, entityDefinitionId: entity.id, sourceId: row.sourceId };
        const existing = await tx.record.findUnique({ where: { deploymentId_entityDefinitionId_sourceId: identity } });
        const data = { sourceModifiedAt: row.modifiedAt ?? null, lastSyncedAt: new Date(), isDeleted: row.isDeleted ?? false, deletedAt: row.isDeleted ? new Date() : null, ...resolveOwnershipFks(row, users) };
        const record = await tx.record.upsert({ where: { deploymentId_entityDefinitionId_sourceId: identity }, create: { ...identity, ...data }, update: data });
        resolved.set(referenceKey({ kind: "reference", entityKey: entity.key, sourceId: row.sourceId }), record.id);
        for (const attr of attributes) {
          // Missing fields are unchanged; explicit null clears a value. Tombstones need no payload.
          if (!Object.prototype.hasOwnProperty.call(row.fields, attr.key)) continue;
          const input = row.fields[attr.key]!;
          if (isReference(input) && attr.referenceEntityKeys.length && !attr.referenceEntityKeys.includes(input.entityKey)) throw new Error(`Reference target outside declared relationship: ${entity.key}/${attr.key}`);
          const value: TypedValue = toTypedValue(attr.dataType, input, (ref: RecordReference): string | null => resolved.get(referenceKey(ref)) ?? null);
          const stored = storageData(value);
          await tx.attributeValue.upsert({ where: { recordId_attributeDefinitionId: { recordId: record.id, attributeDefinitionId: attr.id } }, create: { recordId: record.id, attributeDefinitionId: attr.id, ...stored }, update: stored });
        }
        result.processed += 1;
        if (row.isDeleted) result.deleted += 1;
        else if (existing) result.updated += 1;
        else result.created += 1;
      }
    }, { timeout: 300000, maxWait: 10000 });
    // Never derive, parse or compare this token. The caller commits it only after the entire entity run succeeds.
    result.checkpoint = batch.nextCheckpoint;
  }
  return result;
}

// Resolve persisted qualified references, including forward references. No source re-query or source ID interpretation.
export async function backfillReferences(prisma: PrismaClient, deploymentId: string, batchSize: number): Promise<number> {
  let after: string | undefined;
  let updated: number = 0;
  while (true) {
    const rows = await prisma.attributeValue.findMany({
      where: { record: { deploymentId }, attributeDefinition: { dataType: { in: ["Reference", "Composition"] } }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: batchSize,
    });
    if (!rows.length) return updated;
    const refs: RecordReference[] = rows.flatMap((row): RecordReference[] => isReference(row.jsonValue) ? [row.jsonValue] : []);
    const resolved: Map<string, string> = await resolveReferences(prisma, deploymentId, refs);
    await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
      for (const row of rows) {
        if (!isReference(row.jsonValue)) continue;
        const target: string | null = resolved.get(referenceKey(row.jsonValue)) ?? null;
        if (target !== row.referenceValue) {
          await tx.attributeValue.update({ where: { id: row.id }, data: { referenceValue: target } });
          if (target) updated += 1;
        }
      }
    });
    after = rows[rows.length - 1]!.id;
  }
}
