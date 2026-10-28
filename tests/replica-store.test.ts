import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { runReplication } from "../src/core/orchestrator.js";
import type { CanonicalEntity, ChangeBatch, CrmSource, SourceUser } from "../src/core/source.js";

const definitions: CanonicalEntity[] = [
  { key: "customer.profile", label: "Customer", pluralLabel: "Customers", attributes: [{ key: "tags", label: "Tags", dataType: "MultiEnum" }, { key: "parent", label: "Parent", dataType: "Reference", relationship: { targetEntityKeys: ["namespace/entity"], kind: "Reference", name: "parent", cascadeDelete: false } }] },
  ...["namespace/entity", "foo.bar", "foo-bar", "foo_bar"].map((key): CanonicalEntity => ({ key, label: key, pluralLabel: key, attributes: [] })),
];
class FakeSource implements CrmSource {
  checkpoints: Array<string | null> = [];
  closed: boolean = false;
  async connect(): Promise<void> {}
  async logout(): Promise<void> { this.closed = true; }
  async listEntities(): Promise<string[]> { return definitions.map((entity): string => entity.key); }
  async describeEntity(key: string): Promise<CanonicalEntity> { return definitions.find((entity): boolean => entity.key === key)!; }
  async *streamUsers(): AsyncGenerator<SourceUser[]> {}
  async *fetchChanges(entity: CanonicalEntity, checkpoint: string | null): AsyncGenerator<ChangeBatch> {
    this.checkpoints.push(checkpoint);
    yield { records: [{ sourceId: "123", fields: entity.key === "customer.profile" ? { tags: ["enterprise", "strategic"], parent: { kind: "reference", entityKey: "namespace/entity", sourceId: "123" } } : {} }], nextCheckpoint: "page-token::abc123" };
  }
}
const config = { deploymentId: "test", entityKeys: ["*"], entityDenyKeys: [], batchSize: 2, buildWideViews: true };

test("FakeSource → core → memory preserves identities, values, references, keys, projections and replay", async (): Promise<void> => {
  const store: InMemoryReplicaStore = new InMemoryReplicaStore();
  const source: FakeSource = new FakeSource();
  await runReplication({ store, sourceClient: source, config });
  const first = store.readRecords("test", "customer.profile")[0]!;
  const parent = store.readRecords("test", "namespace/entity")[0]!;
  assert.notEqual(first.id, parent.id);
  assert.equal(first.resolvedReferences.parent, parent.id);
  assert.deepEqual(store.readProjection("test", "customer.profile")[0]?.fields.tags, ["enterprise", "strategic"]);
  await runReplication({ store, sourceClient: source, config });
  assert.deepEqual(source.checkpoints.slice(definitions.length), definitions.map((): string => "page-token::abc123"));
  for (const entity of definitions) assert.equal(store.readRecords("test", entity.key).length, 1);
  assert.equal(store.readRecords("test", "customer.profile")[0]?.id, first.id);
  await runReplication({ store, sourceClient: source, config: { ...config, deploymentId: "other" } });
  assert.notEqual(store.readRecords("other", "customer.profile")[0]?.id, first.id);
  assert.ok(source.closed);
});

test("failed batch or reference persistence leaves previous successful checkpoints intact", async (): Promise<void> => {
  const store: InMemoryReplicaStore = new InMemoryReplicaStore();
  const source: FakeSource = new FakeSource();
  await runReplication({ store, sourceClient: source, config });
  source.fetchChanges = async function* (): AsyncGenerator<ChangeBatch> {
    yield { records: [{ sourceId: "new", fields: { tags: ["persisted"] } }], nextCheckpoint: "uncommitted" };
    yield { records: [{ sourceId: "invalid", fields: { tags: "native;format" } }], nextCheckpoint: "invalid" };
  };
  await assert.rejects(runReplication({ store, sourceClient: source, config }), /Canonical collection/);
  assert.equal(store.getCheckpoint("test", "customer.profile"), "page-token::abc123");
  assert.equal(store.readRecords("test", "customer.profile").length, 2);
  class BrokenReferences extends InMemoryReplicaStore {
    override async resolveReferences(): Promise<number> { throw new Error("reference failure"); }
  }
  const broken: BrokenReferences = new BrokenReferences();
  await assert.rejects(runReplication({ store: broken, sourceClient: new FakeSource(), config }), /reference failure/);
  assert.equal(broken.getCheckpoint("test", "customer.profile"), null);
});

test("database imports are blocked transitively while FakeSource runs through compiled core and memory", (): void => {
  const code: string = `
    import { runReplication } from './dist/core/orchestrator.js';
    import { InMemoryReplicaStore } from './dist/stores/memory/index.js';
    const store = new InMemoryReplicaStore();
    const source = {
      async connect() {}, async logout() {}, async listEntities() { return ['customer.profile']; },
      async describeEntity(key) { return {key, label:key, pluralLabel:key, attributes:[{key:'tags',label:'Tags',dataType:'MultiEnum'}]}; },
      async *streamUsers() {}, async *fetchChanges() { yield {records:[{sourceId:'123',fields:{tags:['enterprise','strategic']}}],nextCheckpoint:'page-token::abc123'}; }
    };
    await runReplication({store, sourceClient:source, config:${JSON.stringify(config)}});
    if (store.readProjection('test','customer.profile')[0].fields.tags.length !== 2) throw new Error('lost collection');
    if (store.getCheckpoint('test','customer.profile') !== 'page-token::abc123') throw new Error('lost checkpoint');
    for (const name of ['@prisma/client', 'pg', './dist/stores/postgres/index.js']) {
      try { await import(name); throw new Error('guard missed '+name); }
      catch (error) { if (!error.message.includes('Database import blocked')) throw error; }
    }
  `;
  execFileSync(process.execPath, ["--loader", "./tests/helpers/no-db-loader.mjs", "--input-type=module", "-e", code], { env: {}, stdio: "pipe" });
});

test("memory batches are atomic, patch values round-trip and checkpoint completion is atomic", async (): Promise<void> => {
  const store: InMemoryReplicaStore = new InMemoryReplicaStore();
  const entity: CanonicalEntity = { key: "foo.bar", label: "Foo", pluralLabel: "Foos", attributes: [
    { key: "name", label: "Name", dataType: "Text" }, { key: "tags", label: "Tags", dataType: "MultiEnum" },
    { key: "number", label: "Number", dataType: "Number" }, { key: "flag", label: "Flag", dataType: "Boolean" },
    { key: "date", label: "Date", dataType: "Date" }, { key: "instant", label: "Instant", dataType: "DateTime" },
    { key: "object", label: "Object", dataType: "Address" },
  ] };
  await store.persistMetadata("test", [entity]);
  const instant: Date = new Date("2026-10-27T12:00:00Z");
  await store.persistRecords("test", entity, { records: [{ sourceId: "123", fields: { name: "", tags: ["enterprise", "strategic"], number: 42.5, flag: false, date: "2026-10-27", instant, object: { nested: [1, null] } } }], nextCheckpoint: null });
  const fields = store.readRecords("test", entity.key)[0]!.fields;
  assert.deepEqual(fields, { name: "", tags: ["enterprise", "strategic"], number: "42.5", flag: false, date: "2026-10-27", instant, object: { nested: [1, null] } });
  await assert.rejects(store.persistRecords("test", entity, { records: [{ sourceId: "123", fields: { name: "rolled back" } }, { sourceId: "bad", fields: { tags: "native;value" } }], nextCheckpoint: null }), /Canonical collection/);
  assert.equal(store.readRecords("test", entity.key)[0]!.fields.name, "");
  await store.persistRecords("test", entity, { records: [{ sourceId: "123", fields: { tags: [], object: null } }], nextCheckpoint: null });
  assert.deepEqual(store.readRecords("test", entity.key)[0]!.fields.tags, []);
  assert.equal(store.readRecords("test", entity.key)[0]!.fields.object, null);
  assert.equal(store.readRecords("test", entity.key)[0]!.fields.flag, false);
  const run = await store.beginRun("test", entity.key);
  const result = { processed: 1, created: 0, updated: 1, deleted: 0, checkpoint: "page-token::abc123" };
  await assert.rejects(store.completeRuns([{ id: run.id, result }, { id: "missing", result }]), /Unknown run/);
  assert.equal(store.getCheckpoint("test", entity.key), null);
});

test("projection failures occur after durable checkpoint publication", async (): Promise<void> => {
  class BrokenProjection extends InMemoryReplicaStore {
    override async ensureProjections(): Promise<never> { throw new Error("projection failure"); }
  }
  const store: BrokenProjection = new BrokenProjection();
  await assert.rejects(runReplication({ store, sourceClient: new FakeSource(), config }), /projection failure/);
  for (const entity of definitions) assert.equal(store.getCheckpoint("test", entity.key), "page-token::abc123");
});
