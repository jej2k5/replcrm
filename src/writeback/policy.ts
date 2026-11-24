import type { CanonicalAttribute, CanonicalEntity } from "../core/source.js";
import type { ChangeOperation } from "./requests.js";

export interface WritebackPolicy {
  enabled: boolean;
  excludedAttributeKeys: string[];
}

export type PolicyEdit =
  | { action: "enable" | "disable" }
  | { action: "exclude" | "include"; keys: string[] };

export function defaultWritebackPolicy(): WritebackPolicy {
  return { enabled: false, excludedAttributeKeys: [] };
}

export function attributeCapabilities(attr: CanonicalAttribute) {
  const computed = attr.isComputed || attr.dataType === "Computed";
  return {
    isUpdatable: !computed && attr.isUpdatable === true,
    isCreatable: !computed && attr.isCreatable === true,
    isNullable: attr.isNullable === true,
    hasCreateDefault: attr.hasCreateDefault === true,
    isSystem: attr.isSystem === true,
  };
}

const housekeeping = new Set([
  "record_id", "source_id", "is_deleted", "source_modified_at", "owner_id",
  "owner_username", "created_by_id", "last_modified_by_id",
]);

export function writableAttributes(entity: CanonicalEntity, policy: WritebackPolicy, operation: ChangeOperation): string[] {
  if (!policy.enabled) return [];
  const excluded = new Set(policy.excludedAttributeKeys);
  return entity.attributes.filter((attr) =>
    (operation === "update" ? attr.isUpdatable : attr.isCreatable) === true &&
    !attr.isComputed && !attr.isSystem && attr.dataType !== "Computed" &&
    attr.dataType !== "Identifier" && !housekeeping.has(attr.key.toLowerCase()) &&
    !excluded.has(attr.key),
  ).map(({ key }) => key);
}

export function editWritebackPolicy(policy: WritebackPolicy, edit: PolicyEdit): WritebackPolicy {
  if (!("keys" in edit)) return { ...policy, enabled: edit.action === "enable" };
  const excluded = new Set(policy.excludedAttributeKeys);
  for (const key of edit.keys) {
    if (edit.action === "exclude") excluded.add(key);
    else excluded.delete(key);
  }
  return { ...policy, excludedAttributeKeys: [...excluded].sort() };
}
