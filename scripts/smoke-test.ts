// Public smoke checks use only fake sources and disposable embedded storage.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { CanonicalEntity, CanonicalValue } from "../src/core/source.js";
import type { AttributeDataType } from "../src/core/model.js";
import { toTypedValue, readTypedValue } from "../src/core/type-mapper.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { database } from "../tests/helpers/database.js";

let passed: number = 0;
async function check(name: string, action: () => Promise<void>): Promise<void> {
  await action(); passed += 1; console.log(`PASS ${name}`);
}
await check("compiled CLI help needs no configuration or service", async (): Promise<void> => {
  const text: string = execFileSync(process.execPath, ["dist/cli.js", "--help"], { env: {}, encoding: "utf8" });
  assert.match(text, /ReplCRM/);
});
await check("fake-source core runs with transitive database imports blocked", async (): Promise<void> => {
  const code: string = `
    import assert from 'node:assert/strict';
    import { runReplication } from './dist/core/orchestrator.js';
    import { InMemoryReplicaStore } from './dist/stores/memory/index.js';
    const store = new InMemoryReplicaStore();
    const definition = {key:'customer.profile',label:'Customer',pluralLabel:'Customers',attributes:[{key:'tags',label:'Tags',dataType:'MultiEnum'}]};
    const source = {async connect(){},async logout(){},async listEntities(){return [definition.key]},async describeEntity(){return definition},async *streamUsers(){},async *fetchChanges(){yield {records:[{sourceId:'123',fields:{tags:['enterprise','strategic']}}],nextCheckpoint:'page-token::abc123'}}};
    const config = {deploymentId:'smoke',entityKeys:['*'],entityDenyKeys:[],batchSize:2};
    await runReplication({store,sourceClient:source,config});
    await runReplication({store,sourceClient:source,config});
    assert.equal(store.readRecords('smoke',definition.key).length,1);
    assert.deepEqual(store.readProjection('smoke',definition.key)[0].fields.tags,['enterprise','strategic']);
    assert.equal(store.getCheckpoint('smoke',definition.key),'page-token::abc123');
    await assert.rejects(import('@prisma/client'),/Database import blocked/);
  `;
  execFileSync(process.execPath, ["--loader", "./tests/helpers/no-db-loader.mjs", "--input-type=module", "-e", code], { env: {}, stdio: "pipe" });
});
await check("canonical value round-trips preserve arrays, dates, false and nested null", async (): Promise<void> => {
  const cases: Array<[AttributeDataType, CanonicalValue]> = [["Text", ""], ["Boolean", false], ["Date", "2026-10-28"], ["DateTime", new Date("2026-10-28T12:00:00Z")], ["MultiEnum", ["enterprise", "strategic"]], ["Address", { nested: [1, null] }], ["Text", null]];
  for (const [type, value] of cases) assert.deepEqual(readTypedValue(type, toTypedValue(type, value, (): null => null)), value);
  assert.equal(readTypedValue("Number", toTypedValue("Number", "42.5", (): null => null)), "42.5");
});
await check("memory projections are discovered using opaque logical identity", async (): Promise<void> => {
  const store: InMemoryReplicaStore = new InMemoryReplicaStore();
  const definitions: CanonicalEntity[] = ["foo.bar", "foo_bar", "namespace/entity"].map((key): CanonicalEntity => ({ key, label: key, pluralLabel: key, attributes: [] }));
  await store.persistMetadata("smoke", definitions);
  await store.ensureProjections("smoke", definitions);
  const locations = await Promise.all(definitions.map(async (definition): Promise<string> => JSON.stringify((await store.resolveProjection("smoke", definition.key))!.location)));
  assert.equal(new Set(locations).size, definitions.length);
});
await check("PostgreSQL store preserves collections, replay and successful progress", async (): Promise<void> => {
  const { db, prisma } = await database();
  try {
    await prisma.deployment.create({ data: { id: "smoke", name: "Smoke" } });
    const store: PostgresReplicaStore = new PostgresReplicaStore(prisma);
    const entity: CanonicalEntity = { key: "customer.profile", label: "Customer", pluralLabel: "Customers", attributes: [{ key: "tags", label: "Tags", dataType: "MultiEnum" }] };
    await store.persistMetadata("smoke", [entity]);
    const batch = { records: [{ sourceId: "123", fields: { tags: ["enterprise", "strategic"] } }], nextCheckpoint: "page-token::abc123" };
    const run = await store.beginRun("smoke", entity.key);
    const counts = await store.persistRecords("smoke", entity, batch);
    await store.persistRecords("smoke", entity, batch);
    await store.resolveReferences("smoke", 2);
    const completion = [{ id: run.id, result: { ...counts, checkpoint: batch.nextCheckpoint } }];
    await store.completeRuns(completion); await store.failRun(run.id, "late acknowledgement"); await store.completeRuns(completion);
    assert.equal((await store.beginRun("smoke", entity.key)).checkpoint, batch.nextCheckpoint);
    assert.equal((await prisma.record.findMany({ where: { deploymentId: "smoke" } })).length, 1);
    const values = await prisma.attributeValue.findMany({ where: { record: { deploymentId: "smoke" } } });
    assert.deepEqual(values[0]!.jsonValue, batch.records[0]!.fields.tags);
    await store.ensureProjections("smoke", [entity]);
    assert.ok(await store.resolveProjection("smoke", entity.key));
  } finally { await db.close(); }
});
console.log(`${passed} public smoke checks passed`);
