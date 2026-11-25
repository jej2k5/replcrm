import type { CanonicalEntity, CanonicalValue, JsonValue, SourceChangeError } from "../core/source.js";
import type { PolicyEdit, WritebackPolicy } from "./policy.js";

export type ChangeOperation = "update" | "create";
export type ChangeAuthorKind = "person" | "app" | "agent";
export type ChangeStatus = "pending" | "sending" | "applied" | "conflict" | "overridden" | "rejected" | "failed" | "unknown";
export type ChangeFields = Record<string, { base?: JsonValue; value: JsonValue }>;
export type ConflictValues = Record<string, { base: JsonValue; replicaValue: JsonValue; sourceValue: JsonValue }>;
export interface OverrideDecision {
  operatorLabel: string;
  /** UTC ISO 8601 timestamp. */
  time: string;
  side: "replica" | "source";
}

export interface NewChangeRequest {
  deploymentId: string;
  entityKey: string;
  operation: ChangeOperation;
  targetRecordId: string | null;
  targetSourceId: string | null;
  fields: ChangeFields;
  authorKind: ChangeAuthorKind;
  authorLabel: string;
  reason: string | null;
  idempotencyKey: string | null;
}

export interface ChangeRequest extends NewChangeRequest {
  id: string;
  status: ChangeStatus;
  statusDetail: string | null;
  conflictValues: ConflictValues | null;
  resultingSourceId: string | null;
  overrideDecision: OverrideDecision | null;
  sourceError: SourceChangeError | null;
  sourceModifiedAt: Date | null;
  retryAfter: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChangeFilters {
  status?: ChangeStatus;
  entityKey?: string;
}

export interface ChangeTransition {
  status: ChangeStatus;
  statusDetail?: string | null;
  conflictValues?: ConflictValues;
  resultingSourceId?: string;
  overrideDecision?: OverrideDecision;
  sourceError?: SourceChangeError | null;
  sourceModifiedAt?: Date | null;
  retryAfter?: string | null;
  targetRecordId?: string;
  targetSourceId?: string;
  operatorResubmission?: true;
}

export interface WritebackStore {
  listReplicaViews?(deploymentId: string): Promise<import("../core/replica-store.js").ReplicaView[]>;
  submitWritebackChange?(input: import("./index.js").ChangeSubmission): Promise<ChangeRequest>;
  listPersistedEntityKeys(deploymentId: string): Promise<string[]> | string[];
  readEntity(deploymentId: string, entityKey: string): Promise<CanonicalEntity | null> | CanonicalEntity | null;
  findWritebackRecord(deploymentId: string, entityKey: string, recordId: string): Promise<{ recordId?: string; sourceId: string | null; isDeleted: boolean } | null>;
  readWritebackValues?(deploymentId: string, entityKey: string, recordId: string): Promise<Record<string, CanonicalValue> | null>;
  ensureWritebackRecord?(deploymentId: string, entityKey: string, sourceId: string): Promise<void>;
  getWritebackPolicy(deploymentId: string, entityKey: string): Promise<WritebackPolicy>;
  editWritebackPolicy(deploymentId: string, entityKey: string, edit: PolicyEdit): Promise<WritebackPolicy>;
  createChangeRequest(input: NewChangeRequest): Promise<ChangeRequest>;
  getChangeRequest(deploymentId: string, id: string): Promise<ChangeRequest | null>;
  findChangeRequestByIdempotencyKey(deploymentId: string, key: string): Promise<ChangeRequest | null>;
  listChangeRequests(deploymentId: string, filters?: ChangeFilters): Promise<ChangeRequest[]>;
  transitionChangeRequest(deploymentId: string, id: string, expected: ChangeStatus, transition: ChangeTransition, expectedUpdatedAt?: Date): Promise<ChangeRequest>;
}

export function newChangeRequest(input: NewChangeRequest, id: string): ChangeRequest {
  const now = new Date();
  return {
    ...structuredClone(input), id, status: "pending", statusDetail: null, conflictValues: null,
    resultingSourceId: null, overrideDecision: null, sourceError: null, sourceModifiedAt: null, retryAfter: null, createdAt: now, updatedAt: now,
  };
}

const transitions: Record<ChangeStatus, readonly ChangeStatus[]> = {
  pending: ["sending", "rejected"],
  sending: ["pending", "applied", "conflict", "rejected", "failed", "unknown"],
  applied: [],
  conflict: ["overridden", "rejected"],
  overridden: ["sending", "applied", "rejected"],
  rejected: [],
  failed: ["pending"],
  unknown: ["applied", "rejected", "pending"],
};

export function advanceChangeRequest(request: ChangeRequest | null, expected: ChangeStatus, transition: ChangeTransition): ChangeRequest {
  if (!request) throw new Error("Unknown change request");
  if (request.status !== expected || !transitions[request.status].includes(transition.status)) {
    throw new Error(`Illegal change request transition from ${request.status} to ${transition.status} (expected ${expected})`);
  }
  if (transition.status === "overridden" && !transition.overrideDecision) {
    throw new Error("An override requires an operator decision");
  }
  if (request.status === "unknown" && transition.status === "pending" && !transition.operatorResubmission) {
    throw new Error("Resubmission requires an explicit operator decision");
  }
  if (request.status === "sending" && transition.status === "pending" && request.operation !== "update") {
    throw new Error("An interrupted create requires investigation");
  }
  const now = Date.now();
  if (request.status === "failed" && !retryDelayElapsed(request, now)) {
    throw new Error("The Retry-After delay has not elapsed");
  }
  const { operatorResubmission: _operatorResubmission, ...changes } = transition;
  return {
    ...request, ...structuredClone(changes), statusDetail: transition.statusDetail ?? null,
    updatedAt: new Date(Math.max(now, request.updatedAt.getTime() + 1)),
  };
}

export function retryDelayElapsed(request: ChangeRequest, now = Date.now()): boolean {
  if (request.retryAfter === null) return true;
  const retryAfter = request.retryAfter.trim();
  const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const retryAt = seconds === null ? Date.parse(retryAfter) : request.updatedAt.getTime() + seconds * 1000;
  return seconds === 0 || !(now < retryAt);
}
