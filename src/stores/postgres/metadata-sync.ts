import { type EntityDefinition, type PrismaClient, type Prisma } from "@prisma/client";
import type { CanonicalEntity, CanonicalAttribute } from "../../core/source.js";

export interface MetadataSyncResult { entities: Map<string, EntityDefinition>; definitions: Map<string, CanonicalEntity> }

export async function syncMetadata(prisma: PrismaClient | Prisma.TransactionClient, deploymentId: string, input: CanonicalEntity[]): Promise<MetadataSyncResult> {
  const definitions: Map<string, CanonicalEntity> = new Map();
  const entities: Map<string, EntityDefinition> = new Map();
  for (const definition of input) {
    const key: string = definition.key;
    if (definition.key !== key) throw new Error(`Entity definition key mismatch: ${key}`);
    if (new Set(definition.attributes.map((attr: CanonicalAttribute): string => attr.key)).size !== definition.attributes.length) throw new Error(`Duplicate attribute key: ${key}`);
    definitions.set(key, definition);
    const data = { label: definition.label, pluralLabel: definition.pluralLabel, isCustom: definition.isCustom ?? false };
    entities.set(key, await prisma.entityDefinition.upsert({ where: { deploymentId_key: { deploymentId, key } }, create: { deploymentId, key, ...data }, update: data }));
  }
  for (const [key, definition] of definitions) {
    const entity: EntityDefinition = entities.get(key)!;
    for (const attr of definition.attributes) await persistAttribute(prisma, entity, attr, entities);
  }
  return { entities, definitions };
}

async function persistAttribute(prisma: PrismaClient | Prisma.TransactionClient, entity: EntityDefinition, attr: CanonicalAttribute, entities: Map<string, EntityDefinition>): Promise<void> {
  const targets: string[] = attr.relationship?.targetEntityKeys ?? [];
  const target: EntityDefinition | undefined = targets.length === 1 ? entities.get(targets[0]!) : undefined;
  const isReference: boolean = attr.dataType === "Reference" || attr.dataType === "Composition";
  if (isReference !== Boolean(attr.relationship)) throw new Error(`Relationship metadata mismatch: ${entity.key}/${attr.key}`);
  const data = {
    label: attr.label, dataType: attr.dataType, isCustom: attr.isCustom ?? false,
    isRequired: attr.isRequired ?? false, isUnique: attr.isUnique ?? false,
    isExternalKey: attr.isExternalKey ?? false, isComputed: attr.isComputed ?? false,
    length: attr.length ?? null, precision: attr.precision ?? null, scale: attr.scale ?? null,
    expression: attr.expression ?? null, helpText: attr.helpText ?? null,
    referenceEntityId: target?.id ?? null, referenceEntityKeys: targets,
  };
  const attribute = await prisma.attributeDefinition.upsert({
    where: { entityDefinitionId_key: { entityDefinitionId: entity.id, key: attr.key } },
    create: { entityDefinitionId: entity.id, key: attr.key, ...data }, update: data,
  });
  // Replace the option snapshot so subsequent discovery reflects changed options.
  await prisma.enumOption.deleteMany({ where: { attributeDefinitionId: attribute.id } });
  if (attr.enumOptions?.length) await prisma.enumOption.createMany({ data: attr.enumOptions.map((option) => ({ attributeDefinitionId: attribute.id, ...option })) });
  if (attr.relationship && target) {
    const relation = { fromEntityId: entity.id, toEntityId: target.id, relationName: attr.relationship.name, relationType: attr.relationship.kind, cascadeDelete: attr.relationship.cascadeDelete };
    await prisma.relationDefinition.upsert({ where: { fromAttributeId: attribute.id }, create: { fromAttributeId: attribute.id, ...relation }, update: relation });
  } else {
    // Multi-target relationships are retained on the attribute rather than choosing an arbitrary parent.
    await prisma.relationDefinition.deleteMany({ where: { fromAttributeId: attribute.id } });
  }
}
