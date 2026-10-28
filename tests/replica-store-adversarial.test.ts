import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decimal } from "decimal.js";
import type { CanonicalValue } from "../src/core/source.js";
import { readTypedValue, type TypedValue } from "../src/core/type-mapper.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { quoteIdentifier } from "../src/stores/postgres/wide-view-sync.js";
import { database } from "./helpers/database.js";
import { replicaStoreContractTests, type ContractRecord, type ContractFixture } from "./helpers/replica-store-contract.js";

replicaStoreContractTests("memory", async (): Promise<ContractFixture> => {
  const store: InMemoryReplicaStore = new InMemoryReplicaStore();
  return { store, reopen: async (): Promise<InMemoryReplicaStore> => store, records: async (scope: string, entity: string): Promise<ContractRecord[]> => store.readRecords(scope, entity),
    projectionRows: async (projection): Promise<number> => store.readProjection(projection.deploymentId, projection.entityKey).length,
    metadataOptions: async (scope, entityKey, attributeKey) => store.readEntity(scope, entityKey)?.attributes.find((attr): boolean => attr.key === attributeKey)?.enumOptions ?? [],
    close: async (): Promise<void> => {},
  };
});
replicaStoreContractTests("postgres", async (): Promise<ContractFixture> => {
  const dataDir: string = await mkdtemp(join(tmpdir(), "replcrm-contract-"));
  let { db, prisma } = await database(undefined, { dataDir, initialize: true });
  await prisma.deployment.create({ data: { id: "contract", name: "Contract" } });
  const fixture: ContractFixture = { store: new PostgresReplicaStore(prisma), reopen: async (): Promise<PostgresReplicaStore> => {
      await db.close();
      ({ db, prisma } = await database(undefined, { dataDir, initialize: false }));
      const store: PostgresReplicaStore = new PostgresReplicaStore(prisma);
      fixture.store = store;
      return store;
    },
    records: async (scope: string, entity: string): Promise<ContractRecord[]> => {
      const records = await prisma.record.findMany({ where: { deploymentId: scope, entityDefinition: { key: entity } } });
      const result: ContractRecord[] = [];
      for (const record of records) {
        const fields: Record<string, CanonicalValue> = {};
        const resolvedReferences: Record<string, string | null> = {};
        const values = await prisma.attributeValue.findMany({ where: { recordId: record.id } });
        for (const value of values) {
          const attr = await prisma.attributeDefinition.findUnique({ where: { id: value.attributeDefinitionId } });
          if (!attr) throw new Error("Missing attribute");
          const typed = { ...value, numberValue: value.numberValue === null ? null : new Decimal(String(value.numberValue)) } as TypedValue;
          fields[attr.key] = readTypedValue(attr.dataType, typed);
          if (attr.dataType === "Reference" || attr.dataType === "Composition") resolvedReferences[attr.key] = value.referenceValue;
        }
        result.push({ id: record.id, sourceId: record.sourceId!, fields, resolvedReferences });
      }
      return result;
    },
    metadataOptions: async (scope, entityKey, attributeKey) => {
      const attr = await prisma.attributeDefinition.findFirst({ where: { key: attributeKey, entityDefinition: { deploymentId: scope, key: entityKey } } });
      if (!attr) return [];
      const options = await prisma.enumOption.findMany({ where: { attributeDefinitionId: attr.id }, orderBy: { sortOrder: "asc" } });
      return options.map((option) => ({ value: option.value, label: option.label, isActive: option.isActive, isDefault: option.isDefault, sortOrder: option.sortOrder }));
    },
    projectionRows: async (projection): Promise<number> => {
      const location = projection.location as { schema: string; object: string };
      return (await db.query(`SELECT * FROM ${quoteIdentifier(location.schema)}.${quoteIdentifier(location.object)}`)).rows.length;
    }, close: async (): Promise<void> => { await db.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
  return fixture;
});
