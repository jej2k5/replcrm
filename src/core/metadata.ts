import type { CanonicalAttribute, CanonicalEntity } from "./source.js";

// Discovery is additive: absence is not deletion. Changing a stable key's meaning
// requires an explicit upgrade/replay policy outside ordinary discovery.
export function mergeEntity(current: CanonicalEntity | null, incoming: CanonicalEntity): CanonicalEntity {
  if (current && current.key !== incoming.key) throw new Error("Entity identity mismatch");
  const attrs: Map<string, CanonicalAttribute> = new Map(current?.attributes.map((attr): [string, CanonicalAttribute] => [attr.key, attr]) ?? []);
  validateMetadata([incoming]);
  for (const attr of incoming.attributes) {
    const old: CanonicalAttribute | undefined = attrs.get(attr.key);
    if ((attr.dataType === "Reference" || attr.dataType === "Composition") !== Boolean(attr.relationship)) throw new Error(`Relationship metadata mismatch: ${incoming.key}/${attr.key}`);
    if (old && old.dataType !== attr.dataType) throw new Error(`Incompatible attribute type change: ${incoming.key}/${attr.key}`);
    if (old?.relationship && attr.relationship && (JSON.stringify([...old.relationship.targetEntityKeys].sort()) !== JSON.stringify([...attr.relationship.targetEntityKeys].sort()))) throw new Error(`Incompatible relationship change: ${incoming.key}/${attr.key}`);
    attrs.set(attr.key, structuredClone(attr));
  }
  return { ...structuredClone(incoming), attributes: [...attrs.values()].sort((a, b): number => a.key.localeCompare(b.key)) };
}

export function validateMetadata(entities: CanonicalEntity[]): void {
  if (new Set(entities.map((entity): string => entity.key)).size !== entities.length) throw new Error("Duplicate entity key");
  for (const entity of entities) {
    if (new Set(entity.attributes.map((attr): string => attr.key)).size !== entity.attributes.length) throw new Error("Duplicate attribute key");
    for (const attr of entity.attributes) {
      if ((attr.dataType === "Reference" || attr.dataType === "Composition") !== Boolean(attr.relationship)) throw new Error(`Relationship metadata mismatch: ${entity.key}/${attr.key}`);
      if (new Set(attr.enumOptions?.map((option): string => option.value)).size !== (attr.enumOptions?.length ?? 0)) throw new Error("Duplicate enum option");
    }
  }
}
