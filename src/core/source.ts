import type { AttributeDataType, RelationType } from "./model.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface RecordReference {
  kind: "reference";
  entityKey: string;
  sourceId: string;
}
export interface UnresolvedReference {
  kind: "unresolved-reference";
  sourceId: string;
  candidateEntityKeys: string[];
}
export type CanonicalValue = JsonValue | Date | RecordReference | UnresolvedReference;
export interface CanonicalAttribute {
  key: string;
  displayKey?: string;
  label: string;
  dataType: AttributeDataType;
  isCustom?: boolean;
  isRequired?: boolean;
  isUnique?: boolean;
  isExternalKey?: boolean;
  isComputed?: boolean;
  isUpdatable?: boolean;
  isCreatable?: boolean;
  isNullable?: boolean;
  hasCreateDefault?: boolean;
  isSystem?: boolean;
  isNameField?: boolean;
  recordRole?: "owner" | "creator" | "lastModifier" | "deletionFlag";
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  expression?: string | null;
  helpText?: string | null;
  enumOptions?: Array<{ value: string; label: string; isActive: boolean; isDefault: boolean; sortOrder: number }>;
  relationship?: { targetEntityKeys: string[]; kind: RelationType; name: string; cascadeDelete: boolean };
}
export interface CanonicalEntity {
  key: string;
  displayKey?: string;
  label: string;
  pluralLabel: string;
  isCustom?: boolean;
  attributes: CanonicalAttribute[];
}
export interface SourceRecord {
  sourceId: string;
  modifiedAt?: Date | null;
  isDeleted?: boolean;
  ownerSourceId?: string | null;
  createdBySourceId?: string | null;
  lastModifiedBySourceId?: string | null;
  fields: Record<string, CanonicalValue>;
}
export interface ChangeBatch {
  records: SourceRecord[];
  nextCheckpoint: string | null;
}
export interface SourceUser {
  sourceId: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string;
  role: string | null;
  isActive: boolean;
}
export interface ValidatedChange {
  entity: CanonicalEntity;
  operation: "update" | "create";
  targetSourceId: string | null;
  fields: Record<string, { base?: JsonValue; value: JsonValue }>;
  authorKind: "person" | "app" | "agent";
  authorLabel: string;
  overrideConflict?: boolean;
}
export interface SourceChangeError {
  code: string;
  message: string;
  fields?: string[];
}
export type SourceChangeResult =
  | { status: "applied"; sourceId: string; modifiedAt: Date | null; record?: SourceRecord; detail?: string }
  | { status: "conflict"; conflictValues: Record<string, { base: JsonValue; replicaValue: JsonValue; sourceValue: JsonValue }> }
  | { status: "rejected"; error: SourceChangeError }
  | { status: "failed"; detail: string; retryAfter?: string; error?: SourceChangeError }
  | { status: "unknown"; detail: string };
export interface SourceApiUsage {
  calls: number;
  used?: number;
  dailyLimit?: number;
  limitExceeded?: boolean;
}

export interface CrmSource {
  availableChangeEvents?(keys: string[]): Promise<string[]>;
  subscribeToChanges?(subscription: ChangeSubscription): AsyncIterable<ChangeNotification>;
  apiUsage?(): SourceApiUsage;
  connect(): Promise<void>;
  logout(): Promise<void>;
  listEntities(): Promise<string[]>;
  describeEntity(entityKey: string): Promise<CanonicalEntity>;
  fetchChanges(entity: CanonicalEntity, checkpoint: string | null, batchSize: number): AsyncGenerator<ChangeBatch>;
  streamUsers(batchSize: number): AsyncGenerator<SourceUser[]>;
  applyChange?(change: ValidatedChange): Promise<SourceChangeResult>;
  readRecord?(entity: CanonicalEntity, sourceId: string): Promise<SourceRecord | null>;
  listSourceIds?(entityKey: string, batchSize: number): AsyncGenerator<string[]>;
}

export interface ChangeNotification {
  objectKey: string;
  recordIds: string[];
  kind: "create" | "update" | "delete" | "restore" | "catch-up" | "resume-unavailable";
  position: string | null;
}

export interface ChangeSubscription {
  positions: ReadonlyMap<string, string | null>;
  signal: AbortSignal;
  connectionChanged(connected: boolean): Promise<void>;
}
