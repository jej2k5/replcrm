import assert from "node:assert/strict";
import { test } from "node:test";
import { runReplication } from "../../src/core/orchestrator.js";
import type { CanonicalAttribute, CanonicalEntity, CanonicalValue, ChangeBatch, CrmSource, SourceUser } from "../../src/core/source.js";
import type { Counts, PendingRun, Projection, ReplicaStore } from "../../src/core/replica-store.js";

export interface ContractRecord { id: string; sourceId: string; fields: Record<string, CanonicalValue>; resolvedReferences: Record<string, string | null> }
export interface ContractFixture {
  store: ReplicaStore;
  reopen(): Promise<ReplicaStore>;
  records(scope: string, entity: string): Promise<ContractRecord[]>;
  projectionRows(projection: Projection): Promise<number>;
  metadataOptions(scope: string, entityKey: string, attributeKey: string): Promise<NonNullable<CanonicalAttribute["enumOptions"]>>;
  close(): Promise<void>;
}
export const CONTRACT_CASES: number = 15;
export const FAILURE_INJECTION_CASES: number = 8;
const config = { deploymentId: "contract", entityKeys: ["*"], entityDenyKeys: [], batchSize: 20, buildWideViews: true };
function entity(key: string): CanonicalEntity {
  return { key, label: key, pluralLabel: key, attributes: [{ key: "name", label: "Name", dataType: "Text" }, { key: "tags", label: "Tags", dataType: "MultiEnum" }] };
}
function source(entities: CanonicalEntity[], changes: (entity: CanonicalEntity) => ChangeBatch): CrmSource {
  return {
    async connect(): Promise<void> {}, async logout(): Promise<void> {},
    async listEntities(): Promise<string[]> { return entities.map((item): string => item.key); },
    async describeEntity(key: string): Promise<CanonicalEntity> { return entities.find((item): boolean => item.key === key)!; },
    async *streamUsers(): AsyncGenerator<SourceUser[]> {},
    async *fetchChanges(item: CanonicalEntity): AsyncGenerator<ChangeBatch> { yield changes(item); },
  };
}
function delegate(inner: ReplicaStore): ReplicaStore {
  return { resolveProjection: inner.resolveProjection.bind(inner), persistMetadata: inner.persistMetadata.bind(inner), persistUsers: inner.persistUsers.bind(inner), persistRecords: inner.persistRecords.bind(inner), resolveReferences: inner.resolveReferences.bind(inner), beginRun: inner.beginRun.bind(inner), completeRuns: inner.completeRuns.bind(inner), failRun: inner.failRun.bind(inner), ensureProjections: inner.ensureProjections.bind(inner) };
}
const result = (checkpoint: string | null): PendingRun["result"] => ({ processed: 0, created: 0, updated: 0, deleted: 0, checkpoint });
const batch = (fields: Record<string, CanonicalValue> = {}): ChangeBatch => ({ records: [{ sourceId: "123", fields }], nextCheckpoint: "page-token::abc123" });

// Same assertions, backend-specific observation only; a future store supplies another fixture.
export function replicaStoreContractTests(name: string, create: () => Promise<ContractFixture>): void {
  function contract(title: string, action: (fixture: ContractFixture) => Promise<void>): void {
    test(`${name} contract: ${title}`, async (): Promise<void> => {
      const fixture: ContractFixture = await create();
      try { await action(fixture); } finally { await fixture.close(); }
    });
  }
  contract("ordered batch patches, opaque keys and replay preserve logical identity", async (f): Promise<void> => {
    const store: ReplicaStore = delegate(f.store);
    const calls: number[] = [];
    store.persistRecords = async (scope: string, definition: CanonicalEntity, input: ChangeBatch): Promise<Counts> => { calls.push(input.records.length); return f.store.persistRecords(scope, definition, input); };
    const definitions: CanonicalEntity[] = ["foo.bar", "foo-bar", "foo_bar", "namespace/entity", "Case", "case", "x".repeat(300)].map(entity);
    const input: CrmSource = source(definitions, (): ChangeBatch => ({ records: [{ sourceId: "123", fields: { name: "first", tags: ["enterprise", "strategic"] } }, { sourceId: "123", fields: { tags: [] } }, { sourceId: "123", fields: { name: null } }], nextCheckpoint: "page-token::abc123" }));
    await runReplication({ store, sourceClient: input, config });
    const first = await f.records(config.deploymentId, definitions[0]!.key);
    await runReplication({ store, sourceClient: input, config });
    assert.deepEqual(calls, Array(definitions.length * 2).fill(3));
    for (const definition of definitions) {
      const rows = await f.records(config.deploymentId, definition.key);
      assert.equal(rows.length, 1); assert.deepEqual(rows[0]!.fields, { name: null, tags: [] });
    }
    assert.equal((await f.records(config.deploymentId, definitions[0]!.key))[0]!.id, first[0]!.id);
  });
  contract("failure injection: checkpoint awaits the durable application barrier", async (f): Promise<void> => {
    const store: ReplicaStore = delegate(f.store);
    let release!: () => void; let entered!: () => void;
    const gate: Promise<void> = new Promise((resolve): void => { release = resolve; });
    const started: Promise<void> = new Promise((resolve): void => { entered = resolve; });
    store.persistRecords = async (scope: string, definition: CanonicalEntity, input: ChangeBatch): Promise<Counts> => { entered(); await gate; return f.store.persistRecords(scope, definition, input); };
    const run: Promise<void> = runReplication({ store, sourceClient: source([entity("opaque.key")], (): ChangeBatch => batch()), config });
    await started;
    try { assert.equal((await f.records(config.deploymentId, "opaque.key")).length, 0); }
    finally { release(); }
    await run;
    assert.equal((await (await f.reopen()).beginRun(config.deploymentId, "opaque.key")).checkpoint, "page-token::abc123");
  });
  contract("failure injection: partial projection publication preserves successful progress", async (f): Promise<void> => {
    const store: ReplicaStore = delegate(f.store);
    store.ensureProjections = async (scope: string, definitions: CanonicalEntity[]): Promise<never> => { await f.store.ensureProjections(scope, definitions.slice(0, 1)); throw new Error("publication failure"); };
    await assert.rejects(runReplication({ store, sourceClient: source([entity("first"), entity("second")], (): ChangeBatch => batch()), config }), /publication failure/);
    assert.ok(await f.store.resolveProjection(config.deploymentId, "first"));
    assert.equal(await f.store.resolveProjection(config.deploymentId, "second"), null);
    for (const key of ["first", "second"]) assert.equal((await (await f.reopen()).beginRun(config.deploymentId, key)).checkpoint, "page-token::abc123");
  });
  contract("metadata omission retains history and rename adds a new canonical key", async (f): Promise<void> => {
    const before: CanonicalEntity = entity("customer.profile");
    const after: CanonicalEntity = { ...before, attributes: [{ key: "renamed", label: "Renamed", dataType: "Text" }] };
    await f.store.persistMetadata(config.deploymentId, [before]);
    await f.store.persistRecords(config.deploymentId, before, batch({ name: "retained", tags: ["enterprise", "strategic"] }));
    await f.store.persistMetadata(config.deploymentId, [after]);
    await f.store.persistMetadata(config.deploymentId, [after]);
    await f.store.ensureProjections(config.deploymentId, [after]);
    assert.deepEqual((await f.store.resolveProjection(config.deploymentId, before.key))!.attributeKeys, ["name", "renamed", "tags"]);
    assert.equal((await f.records(config.deploymentId, before.key))[0]!.fields.name, "retained");
    await assert.rejects(f.store.persistRecords(config.deploymentId, after, batch({ name: "not in current source definition" })), /Undeclared/);
  });
  contract("incompatible canonical type change rejects without coercion or metadata mutation", async (f): Promise<void> => {
    const before: CanonicalEntity = entity("type.change");
    await f.store.persistMetadata(config.deploymentId, [before]);
    await f.store.persistRecords(config.deploymentId, before, batch({ name: "42" }));
    const changed: CanonicalEntity = { ...before, attributes: [{ key: "name", label: "Name", dataType: "Number" }, { key: "new", label: "New", dataType: "Text" }] };
    await assert.rejects(f.store.persistMetadata(config.deploymentId, [changed]), /Incompatible attribute type/);
    await f.store.ensureProjections(config.deploymentId, [before]);
    assert.deepEqual((await f.store.resolveProjection(config.deploymentId, before.key))!.attributeKeys, ["name", "tags"]);
    assert.equal((await f.records(config.deploymentId, before.key))[0]!.fields.name, "42");
    await f.store.persistRecords(config.deploymentId, before, batch({ name: "still text" }));
  });
  contract("failure injection: lost completion acknowledgement converges after reopening", async (f): Promise<void> => {
    const store: ReplicaStore = delegate(f.store);
    let proposal: PendingRun[] = [];
    store.completeRuns = async (runs: PendingRun[]): Promise<void> => { await f.store.completeRuns(runs); if (runs.some((run): boolean => run.result.checkpoint !== null)) { proposal = structuredClone(runs); throw new Error("lost acknowledgement"); } };
    await assert.rejects(runReplication({ store, sourceClient: source([entity("customer")], (): ChangeBatch => batch()), config }), /lost acknowledgement/);
    const reopened: ReplicaStore = await f.reopen();
    await reopened.completeRuns(proposal);
    await reopened.failRun(proposal[0]!.id, "late failure cannot demote success");
    assert.equal((await reopened.beginRun(config.deploymentId, "customer")).checkpoint, "page-token::abc123");
  });
  contract("failure injection: invalid batch leaves records and checkpoint unchanged", async (f): Promise<void> => {
    const definition: CanonicalEntity = entity("customer");
    await runReplication({ store: f.store, sourceClient: source([definition], (): ChangeBatch => batch({ name: "original" })), config });
    await assert.rejects(f.store.persistRecords(config.deploymentId, definition, { records: [{ sourceId: "123", fields: { name: "must roll back" } }, { sourceId: "bad", fields: { tags: "native;format" } }], nextCheckpoint: "never" }), /Canonical collection/);
    assert.equal((await f.records(config.deploymentId, definition.key))[0]!.fields.name, "original");
    assert.equal((await (await f.reopen()).beginRun(config.deploymentId, definition.key)).checkpoint, "page-token::abc123");
  });
  contract("failure injection: lost record acknowledgement and relationship replay converge", async (f): Promise<void> => {
    const parent: CanonicalEntity = entity("parent");
    const child: CanonicalEntity = { ...entity("child"), attributes: [{ key: "parent", label: "Parent", dataType: "Reference", relationship: { targetEntityKeys: [parent.key], kind: "Reference", name: "parent", cascadeDelete: false } }] };
    await f.store.persistMetadata(config.deploymentId, [child, parent]);
    const input: ChangeBatch = batch({ parent: { kind: "reference", entityKey: parent.key, sourceId: "123" } });
    async function applyAndLoseAck(): Promise<void> { await f.store.persistRecords(config.deploymentId, child, input); throw new Error("lost acknowledgement"); }
    await assert.rejects(applyAndLoseAck(), /lost acknowledgement/);
    const id: string = (await f.records(config.deploymentId, child.key))[0]!.id;
    const reopened: ReplicaStore = await f.reopen();
    await reopened.persistRecords(config.deploymentId, child, input);
    await reopened.persistRecords(config.deploymentId, parent, batch());
    await reopened.resolveReferences(config.deploymentId, 2);
    await reopened.persistRecords(config.deploymentId, child, input);
    assert.equal(await reopened.resolveReferences(config.deploymentId, 2), 0);
    const children = await f.records(config.deploymentId, child.key);
    assert.equal(children.length, 1); assert.equal(children[0]!.id, id);
    assert.equal(children[0]!.resolvedReferences.parent, (await f.records(config.deploymentId, parent.key))[0]!.id);
  });
  contract("checkpoint retries cannot regress newer progress or reinterpret opaque tokens", async (f): Promise<void> => {
    const old = await f.store.beginRun(config.deploymentId, "customer");
    const newer = await f.store.beginRun(config.deploymentId, "customer");
    await f.store.completeRuns([{ id: newer.id, result: result("opaque-value") }]);
    await assert.rejects(f.store.completeRuns([{ id: old.id, result: result("zzzz::not-newer") }]), /Stale/);
    await (await f.reopen()).completeRuns([{ id: newer.id, result: result("opaque-value") }]);
    await assert.rejects(f.store.completeRuns([{ id: newer.id, result: result("different") }]), /Conflicting/);
    const third = await f.store.beginRun(config.deploymentId, "customer");
    await f.store.completeRuns([{ id: third.id, result: result("cursor:v7:xyz") }]);
    await f.store.completeRuns([{ id: newer.id, result: result("opaque-value") }]);
    assert.equal((await (await f.reopen()).beginRun(config.deploymentId, "customer")).checkpoint, "cursor:v7:xyz");
  });
  contract("failure injection: checkpoint set failure publishes no partial progress", async (f): Promise<void> => {
    const a = await f.store.beginRun(config.deploymentId, "a");
    await assert.rejects(f.store.completeRuns([{ id: a.id, result: result("never") }, { id: "unknown", result: result("never") }]), /Unknown run/);
    assert.equal((await (await f.reopen()).beginRun(config.deploymentId, "a")).checkpoint, null);
    await f.store.completeRuns([{ id: a.id, result: result("after::retry") }]);
    assert.equal((await f.store.beginRun(config.deploymentId, "a")).checkpoint, "after::retry");
  });
  contract("failure injection: projection acknowledgement loss retries without aliasing", async (f): Promise<void> => {
    const definitions: CanonicalEntity[] = [entity("foo.bar"), entity("foo_bar")];
    assert.equal(await f.store.resolveProjection(config.deploymentId, definitions[0]!.key), null);
    await f.store.persistMetadata(config.deploymentId, definitions);
    await f.store.persistRecords(config.deploymentId, definitions[0]!, batch());
    async function publishAndLoseAck(): Promise<void> { await f.store.ensureProjections(config.deploymentId, definitions); throw new Error("lost acknowledgement"); }
    await assert.rejects(publishAndLoseAck(), /lost acknowledgement/);
    const first: Projection = (await f.store.resolveProjection(config.deploymentId, definitions[0]!.key))!;
    await (await f.reopen()).ensureProjections(config.deploymentId, definitions);
    const again: Projection = (await f.store.resolveProjection(config.deploymentId, definitions[0]!.key))!;
    const other: Projection = (await f.store.resolveProjection(config.deploymentId, definitions[1]!.key))!;
    assert.deepEqual(again, first); assert.notDeepEqual(again.location, other.location);
    assert.equal(await f.projectionRows(again), 1);
  });
  contract("metadata replay preserves canonical options and failure-before-application is atomic", async (f): Promise<void> => {
    const options: NonNullable<CanonicalAttribute["enumOptions"]> = [{ value: "enterprise", label: "Enterprise", isActive: true, isDefault: false, sortOrder: 0 }];
    const definition: CanonicalEntity = { ...entity("metadata"), attributes: [...entity("metadata").attributes, { key: "segment", label: "Segment", dataType: "Enum", enumOptions: options }] };
    await f.store.persistMetadata(config.deploymentId, [definition]);
    await (await f.reopen()).persistMetadata(config.deploymentId, [definition]);
    await assert.rejects(f.store.persistMetadata(config.deploymentId, [{ ...definition, attributes: [...definition.attributes, { key: "added", label: "Added", dataType: "Text" }, { key: "tags", label: "Invalid", dataType: "Number" }] }]), /Duplicate|Incompatible/);
    await f.store.ensureProjections(config.deploymentId, [definition]);
    assert.deepEqual((await f.store.resolveProjection(config.deploymentId, definition.key))!.attributeKeys, ["name", "segment", "tags"]);
    assert.deepEqual(await f.metadataOptions(config.deploymentId, definition.key, "segment"), options);
  });
  contract("directory replay returns deterministic per-invocation counts", async (f): Promise<void> => {
    const user: SourceUser = { sourceId: "user", username: "person", email: "person@example.test", firstName: null, lastName: "Person", role: null, isActive: true };
    assert.deepEqual(await f.store.persistUsers(config.deploymentId, [user]), { processed: 1, created: 1, updated: 0, deleted: 0 });
    assert.deepEqual(await (await f.reopen()).persistUsers(config.deploymentId, [user]), { processed: 1, created: 0, updated: 1, deleted: 0 });
  });
  contract("decimal fidelity and rejection preserve the established replica value domain", async (f): Promise<void> => {
    const definition: CanonicalEntity = { ...entity("numbers"), attributes: [{ key: "amount", label: "Amount", dataType: "Number" }] };
    await f.store.persistMetadata(config.deploymentId, [definition]);
    await f.store.persistRecords(config.deploymentId, definition, batch({ amount: "1.1234567891234567896" }));
    assert.equal((await f.records(config.deploymentId, definition.key))[0]!.fields.amount, "1.12345678912345679");
    await assert.rejects(f.store.persistRecords(config.deploymentId, definition, batch({ amount: "100000000000000000000" })), /Canonical decimal/);
    assert.equal((await f.records(config.deploymentId, definition.key))[0]!.fields.amount, "1.12345678912345679");
  });

  contract("failure injection: completion versus late failure preserves a valid terminal outcome", async (f): Promise<void> => {
    const attempt = await f.store.beginRun(config.deploymentId, "race");
    const [completion] = await Promise.allSettled([
      f.store.completeRuns([{ id: attempt.id, result: result("opaque::race") }]),
      f.store.failRun(attempt.id, "connection failed while completion outcome was unknown"),
    ]);
    const reopened: ReplicaStore = await f.reopen();
    const expected: string | null = completion!.status === "fulfilled" ? "opaque::race" : null;
    await reopened.failRun(attempt.id, "late repeated failure");
    assert.equal((await reopened.beginRun(config.deploymentId, "race")).checkpoint, expected);
    if (expected !== null) await reopened.completeRuns([{ id: attempt.id, result: result(expected) }]);
    else await assert.rejects(reopened.completeRuns([{ id: attempt.id, result: result("opaque::race") }]), /not running/);
  });

}
