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
  label: string;
  dataType: AttributeDataType;
  isCustom?: boolean;
  isRequired?: boolean;
  isUnique?: boolean;
  isExternalKey?: boolean;
  isComputed?: boolean;
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
export interface CrmSource {
  connect(): Promise<void>;
  logout(): Promise<void>;
  listEntities(): Promise<string[]>;
  describeEntity(entityKey: string): Promise<CanonicalEntity>;
  fetchChanges(entity: CanonicalEntity, checkpoint: string | null, batchSize: number): AsyncGenerator<ChangeBatch>;
  streamUsers(batchSize: number): AsyncGenerator<SourceUser[]>;
}
