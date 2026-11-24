import type { CanonicalValue, JsonValue } from "../core/source.js";
import { writableAttributes } from "./policy.js";
import type { ChangeAuthorKind, ChangeFields, ChangeOperation, ChangeRequest, WritebackStore } from "./requests.js";

export { writableAttributes } from "./policy.js";
export type { PolicyEdit, WritebackPolicy } from "./policy.js";
export type { ChangeRequest, ChangeStatus, ChangeTransition, WritebackStore } from "./requests.js";

export interface ChangeSubmission {
  deploymentId: string;
  entityKey: string;
  operation: ChangeOperation | "delete";
  targetRecordId?: string;
  fields: Record<string, { base?: CanonicalValue; value: CanonicalValue }>;
  authorKind: ChangeAuthorKind;
  authorLabel: string;
  reason?: string;
  idempotencyKey?: string;
}

export class ChangeValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ChangeValidationError";
  }
}

function jsonValue(value: CanonicalValue): JsonValue {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return Array.from(value, jsonValue);
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  throw new Error("Expected a canonical value");
}

export async function submitChange(store: WritebackStore, input: ChangeSubmission): Promise<ChangeRequest> {
  const { deploymentId, entityKey, operation, idempotencyKey } = input;
  if (operation === "delete") throw new ChangeValidationError(["deletes are not supported by write-back"]);
  if (operation !== "update" && operation !== "create") throw new ChangeValidationError(["Unsupported write-back operation"]);
  if (store.submitWritebackChange) return store.submitWritebackChange(input);
  if (idempotencyKey !== undefined) {
    const existing = await store.findChangeRequestByIdempotencyKey(deploymentId, idempotencyKey);
    if (existing) return existing;
  }
  const entity = await store.readEntity(deploymentId, entityKey);
  if (!entity) throw new ChangeValidationError([`Unknown object ${entityKey}`]);

  const { toSourceValue } = await import("../sources/salesforce/values.js");
  const problems: string[] = [];
  const policy = await store.getWritebackPolicy(deploymentId, entityKey);
  if (!policy.enabled) problems.push(`Write-back is disabled for ${entityKey}`);
  const writable = new Set(writableAttributes(entity, { ...policy, enabled: true }, operation));
  const attributes = new Map(entity.attributes.map((attr) => [attr.key, attr]));
  const fields: ChangeFields = Object.create(null);
  if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) problems.push("Fields must be an object");
  const entries = Object.entries(input.fields ?? {});
  if (operation === "update" && !entries.length) problems.push("An update requires at least one field");

  for (const [key, change] of entries) {
    const attr = attributes.get(key);
    if (!attr || !writable.has(key)) problems.push(`${key} is not writable on ${operation}`);
    if (!change || !Object.hasOwn(change, "value") || change.value === undefined) {
      problems.push(`${key} requires a value`);
    } else if (attr) {
      try {
        if (change.value === null && !attr.isNullable) throw new Error("null is not allowed");
        toSourceValue(attr, change.value);
        fields[key] = { value: jsonValue(change.value) };
      } catch (error) {
        problems.push(`${key} has an invalid value (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (operation === "update") {
      if (!change || !Object.hasOwn(change, "base") || change.base === undefined) {
        problems.push(`${key} requires a base value`);
      } else {
        try {
          const base = jsonValue(change.base);
          if (fields[key]) fields[key].base = base;
        } catch (error) {
          problems.push(`${key} has an invalid base value (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }

  let targetRecordId = input.targetRecordId ?? null;
  let targetSourceId: string | null = null;
  if (operation === "update") {
    const target = input.targetRecordId ? await store.findWritebackRecord(deploymentId, entityKey, input.targetRecordId) : null;
    if (!target) problems.push("Update target record does not exist");
    else if (target.isDeleted) problems.push("Update target record is deleted");
    else if (!target.sourceId) problems.push("Update target record has no source ID");
    else {
      targetSourceId = target.sourceId;
      targetRecordId = target.recordId ?? targetRecordId;
    }
  } else {
    if (input.targetRecordId !== undefined) problems.push("A create cannot have a target record");
    const creatable = new Set(writableAttributes(entity, { enabled: true, excludedAttributeKeys: [] }, "create"));
    for (const attr of entity.attributes) {
      if (creatable.has(attr.key) && !attr.isNullable && !attr.hasCreateDefault && !Object.hasOwn(input.fields ?? {}, attr.key)) {
        problems.push(`${attr.key} is required on create`);
      }
    }
  }
  if (!["person", "app", "agent"].includes(input.authorKind)) problems.push("Invalid author kind");
  if (typeof input.authorLabel !== "string" || !input.authorLabel.trim()) problems.push("An author label is required");
  if (problems.length) throw new ChangeValidationError(problems);

  return store.createChangeRequest({
    deploymentId, entityKey, operation, targetRecordId, targetSourceId,
    fields, authorKind: input.authorKind, authorLabel: input.authorLabel,
    reason: input.reason ?? null, idempotencyKey: idempotencyKey ?? null,
  });
}

export { ChangeRequestProcessor } from "./processor.js";
export type { UnknownResolution } from "./processor.js";
