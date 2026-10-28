import { type PrismaClient, type Prisma } from "@prisma/client";
import type { SourceRecord } from "../../core/source.js";

export interface UserSyncResult {
  processed: number;
  created: number;
  updated: number;
}

// Pulls source users into the local User table so that
// record-sync can resolve Record.ownerId / createdById / lastModifiedById
// against `(deploymentId, sourceId)`. Pulls active AND inactive users
// because old records often reference deactivated owners.
export async function syncUsers(
  prisma: PrismaClient | Prisma.TransactionClient,
  deploymentId: string,
  batch: import("../../core/source.js").SourceUser[],
): Promise<UserSyncResult> {
  const result: UserSyncResult = { processed: 0, created: 0, updated: 0 };

  {
    for (const row of batch) {
      const { sourceId, ...data } = row;

      const existing = await prisma.user.findUnique({ where: { deploymentId_sourceId: { deploymentId, sourceId } } });
      await await prisma.user.upsert({
        where: { deploymentId_sourceId: { deploymentId, sourceId: sourceId } },
        create: { deploymentId, sourceId: sourceId, ...data },
        update: data,
      });
      if (!existing) result.created += 1;
      else result.updated += 1;
      result.processed += 1;
    }
  }

  return result;
}

// Build a one-shot lookup map from source user identifier (sourceId) to the
// local `User.id`. Cheap to call once at the start of each entity's
// record-sync since the User table is small.
export async function loadUserIdMap(
  prisma: PrismaClient | Prisma.TransactionClient,
  deploymentId: string,
): Promise<Map<string, string>> {
  const rows = await prisma.user.findMany({
    where: { deploymentId },
    select: { id: true, sourceId: true },
  });
  return new Map(
    rows
      .filter((r): r is { id: string; sourceId: string } => r.sourceId !== null)
      .map((r) => [r.sourceId, r.id]),
  );
}

// Resolve the owner/createdBy/lastModifiedBy FKs from a raw upstream row
// against a pre-built user-id map. Each may be null when the upstream
// field is missing or the referenced user wasn't synced (e.g. deleted
// long ago and absent from the source user stream).
export interface OwnershipFks {
  ownerId: string | null;
  createdById: string | null;
  lastModifiedById: string | null;
}

export function resolveOwnershipFks(
  row: SourceRecord,
  userIdMap: Map<string, string>,
): OwnershipFks {
  const lookup = (sourceId: unknown): string | null => {
    if (typeof sourceId !== "string" || sourceId.length === 0) return null;
    return userIdMap.get(sourceId) ?? null;
  };
  return {
    ownerId: lookup(row.ownerSourceId),
    createdById: lookup(row.createdBySourceId),
    lastModifiedById: lookup(row.lastModifiedBySourceId),
  };
}
