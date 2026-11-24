import type { FileLock } from "../locks/file-lock.js";
import { writableAttributes, type PolicyEdit } from "../writeback/policy.js";
import type { ChangeRequestProcessor } from "../writeback/processor.js";
import { recoverSending } from "../writeback/queue.js";
import { retryDelayElapsed, type ChangeRequest, type ChangeStatus, type WritebackStore } from "../writeback/requests.js";
import { processToken } from "./runs.js";

export const changeStatuses = ["pending", "sending", "applied", "conflict", "overridden", "rejected", "failed", "unknown"] as const;

function counts(requests: ChangeRequest[], now: Date) {
  return {
    pending: requests.filter(({ status }) => status === "pending").length,
    needsReview: requests.filter(({ status }) => status === "conflict" || status === "unknown").length,
    failed: requests.filter(({ status, updatedAt }) => status === "failed" && updatedAt.getTime() >= now.getTime() - 86_400_000).length,
  };
}

function personName(first: unknown, last: unknown): string | null {
  const parts = [first, last].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  return parts.length ? parts.join(" ") : null;
}

function safeMessage(message: string) {
  return message.replaceAll(processToken, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|security[_-]?token|password)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database]");
}

export class WritebackInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function createConsoleWriteback({ deploymentId, store, acquire, session, now }: {
  deploymentId: string;
  store: WritebackStore;
  acquire: () => Promise<FileLock>;
  session: () => { processor(needsSource: boolean): Promise<ChangeRequestProcessor>; close(): Promise<void> };
  now: () => Date;
}) {
  const list = () => store.listChangeRequests(deploymentId);
  return {
    counts: async () => counts(await list(), now()),
    objects: async () => {
      const keys = await store.listPersistedEntityKeys(deploymentId);
      return Promise.all(keys.sort().map(async (entityKey) => {
        const [entity, policy] = await Promise.all([store.readEntity(deploymentId, entityKey), store.getWritebackPolicy(deploymentId, entityKey)]);
        const available = { ...policy, excludedAttributeKeys: [] };
        const update = new Set(entity ? writableAttributes(entity, available, "update") : []);
        const create = new Set(entity ? writableAttributes(entity, available, "create") : []);
        const excluded = new Set(policy.excludedAttributeKeys);
        return {
          entityKey, enabled: policy.enabled,
          fields: policy.enabled ? (entity?.attributes ?? []).filter(({ key }) => update.has(key) || create.has(key) || excluded.has(key))
            .map(({ key }) => ({
              key, excluded: excluded.has(key), update: update.has(key) && !excluded.has(key), create: create.has(key) && !excluded.has(key),
            })) : [],
        };
      }));
    },
    edit: async ({ action, entityKey, field }: Record<string, unknown>) => {
      if (typeof entityKey !== "string" || !(await store.listPersistedEntityKeys(deploymentId)).includes(entityKey)) {
        throw new WritebackInputError("Unknown object", 404);
      }
      let edit: PolicyEdit;
      if (action === "enable" || action === "disable") edit = { action };
      else if ((action === "exclude" || action === "include") && typeof field === "string") {
        const entity = await store.readEntity(deploymentId, entityKey);
        if (!entity?.attributes.some(({ key }) => key === field)) throw new WritebackInputError("Unknown field", 404);
        edit = { action, keys: [field] };
      } else throw new WritebackInputError("Invalid policy action");
      return store.editWritebackPolicy(deploymentId, entityKey, edit);
    },
    changes: async (status?: ChangeStatus, id?: string) => {
      const all = await list();
      if (id && !all.some((request) => request.id === id)) throw new WritebackInputError("Unknown change request", 404);
      const matching = all.filter((request) => !status || request.status === status)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
      const entities = new Map(await Promise.all([...new Set(matching.map(({ entityKey }) => entityKey))]
        .map(async (key) => {
          const entity = await store.readEntity(deploymentId, key);
          return [key, entity] as const;
        })));
      const changes = await Promise.all(matching.map(async (request) => {
        const sourceId = request.resultingSourceId ?? request.targetSourceId;
        const unlinkedCreate = request.operation === "create" && !sourceId;
        const recordId = unlinkedCreate ? null : sourceId ?? request.targetRecordId;
        const values = recordId ? await store.readWritebackValues?.(deploymentId, request.entityKey, recordId) : null;
        const entity = entities.get(request.entityKey);
        const nameField = entity?.attributes.find(({ isNameField }) => isNameField)?.key;
        const name = (nameField && (values?.[nameField] ?? request.fields[nameField]?.value))
          ?? values?.Name ?? values?.name ?? request.fields.Name?.value ?? request.fields.name?.value
          ?? personName(values?.FirstName ?? request.fields.FirstName?.value, values?.LastName ?? request.fields.LastName?.value);
        const displayName = typeof name === "string" && name.trim() ? name : null;
        const newRecord = "New " + (entity?.label || request.entityKey);
        return {
          id: request.id, entityKey: request.entityKey, operation: request.operation, status: request.status,
          authorKind: request.authorKind, authorLabel: request.authorLabel, createdAt: request.createdAt,
          unlinkedCreate,
          record: unlinkedCreate ? newRecord + (displayName ? ": " + displayName : "") : displayName ?? recordId,
          ...(id === request.id && {
            conflictValues: request.conflictValues, resultingSourceId: request.resultingSourceId,
            appliedAt: request.status === "applied" ? request.updatedAt : null,
            statusDetail: request.statusDetail === null ? null : safeMessage(request.statusDetail),
            sourceError: request.sourceError && { ...request.sourceError, message: safeMessage(request.sourceError.message) },
          }),
        };
      }));
      const statusCounts = { all: all.length, pending: 0, sending: 0, applied: 0, conflict: 0, overridden: 0, rejected: 0, failed: 0, unknown: 0 };
      for (const { status } of all) statusCounts[status]++;
      return { counts: counts(all, now()), statusCounts, changes };
    },
    review: async ({ action, id, operator, recordId }: Record<string, unknown>) => {
      if (typeof id !== "string" || !id) throw new WritebackInputError("A change request ID is required");
      if (action !== "retry" && action !== "replica" && action !== "salesforce" && action !== "link" && action !== "resubmit" && action !== "abandon") {
        throw new WritebackInputError("Invalid review action");
      }
      const label = typeof operator === "string" ? operator.trim() : "";
      if (action !== "retry" && !label) throw new WritebackInputError("An operator label is required");
      const sourceId = typeof recordId === "string" ? recordId.trim() : "";
      if (action === "link" && !sourceId) throw new WritebackInputError("A Salesforce record ID is required");
      const lock = await acquire();
      try {
        const request = await store.getChangeRequest(deploymentId, id);
        if (!request) throw new WritebackInputError("Unknown change request", 404);
        const overriding = action === "replica" || action === "salesforce";
        const expected = action === "retry" ? "failed" : overriding ? "conflict" : "unknown";
        if (request.status !== expected) throw new WritebackInputError(`This action requires status ${expected}`, 409);
        if (action === "retry") {
          if (!retryDelayElapsed(request)) throw new WritebackInputError("The Retry-After delay has not elapsed", 409);
          await store.transitionChangeRequest(deploymentId, id, "failed", { status: "pending", retryAfter: null }, request.updatedAt);
          return;
        }
        const worker = session();
        try {
          const processor = await worker.processor(action === "replica" || action === "link");
          if (overriding) {
            await processor.overrideConflict(request, { operatorLabel: label, side: action === "replica" ? "replica" : "source", time: now().toISOString() });
          } else {
            await processor.resolveUnknown(request, action === "link" ? { linkSourceId: sourceId }
              : action === "resubmit" ? { resubmit: true } : { abandon: true }, label);
          }
        } catch (error) {
          if (overriding) await recoverSending(store, deploymentId);
          throw error;
        } finally {
          await worker.close();
        }
      } finally {
        await lock.release();
      }
    },
  };
}

export type ConsoleWriteback = ReturnType<typeof createConsoleWriteback>;
