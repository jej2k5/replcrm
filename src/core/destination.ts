// The operations used by an export run. Entity and payload semantics belong
// to each destination adapter; the core does not prescribe a typed CRM schema.
export interface ExternalRecordLink<Entity extends string = string> {
  sourceSystem: string;
  externalId: string;
  entityType: Entity;
  internalId: string;
  externalModifiedAt?: string | null;
}

export interface CrmDestination<Entity extends string = string> {
  createEntity(entity: Entity, payload: Record<string, unknown>): Promise<{ id: string }>;
  updateEntity(entity: Entity, id: string, payload: Record<string, unknown>): Promise<{ id: string }>;
  bulkLookupExternal(keys: Array<{ sourceSystem: string; externalId: string }>): Promise<Array<{ internalId: string; entityType: string } | null>>;
  bulkLinkExternal(records: ExternalRecordLink<Entity>[]): Promise<Array<{ internalId: string; entityType: string }>>;
  listUsers(): Promise<Array<{ id: string; email: string }>>;
}
