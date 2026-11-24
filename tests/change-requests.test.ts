import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { ChangeValidationError, submitChange, type ChangeSubmission, type WritebackStore } from "../src/writeback/index.js";
import { database } from "./helpers/database.js";
import { account, contact, deployment } from "./helpers/writeback.js";

const create: ChangeSubmission = {
  deploymentId: deployment, entityKey: "Account", operation: "create",
  fields: { Name: { value: "New name" } }, authorKind: "agent", authorLabel: "Fixture editor",
};
const sourceId = "fixture-record";

async function memory() {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(deployment, [account, contact]);
  await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
  await store.persistRecords(deployment, account, {
    records: [{ sourceId, fields: { Name: "Old name" } }], nextCheckpoint: null,
  });
  return { store, update: updateFor(store.readRecords(deployment, "Account")[0]!.id) };
}

function updateFor(recordId: string): ChangeSubmission {
  return { ...create, operation: "update", targetRecordId: recordId, fields: { Name: { base: "Old name", value: "New name" } } };
}

async function refuse(store: WritebackStore, input: ChangeSubmission, ...problems: string[]) {
  await assert.rejects(submitChange(store, input), (error: unknown) => {
    assert.ok(error instanceof ChangeValidationError);
    assert.deepEqual(error.problems, problems);
    return true;
  });
  assert.deepEqual(await store.listChangeRequests(deployment), []);
}

test("valid create records author, reason and values with no target", async () => {
  const { store } = await memory();
  const request = await submitChange(store, { ...create, reason: "Fixture reason", fields: { Name: { value: "New name", base: "ignored" } } });
  assert.equal(request.status, "pending");
  assert.deepEqual(request.fields, { Name: { value: "New name" } });
  assert.equal(request.targetRecordId, null);
  assert.equal(request.targetSourceId, null);
  assert.equal(request.authorKind, "agent");
  assert.equal(request.authorLabel, "Fixture editor");
  assert.equal(request.reason, "Fixture reason");
  assert.ok(request.createdAt instanceof Date);
  assert.deepEqual(await store.getChangeRequest(deployment, request.id), request);
});

test("valid update stores both record identifiers and the supplied base", async () => {
  const { store, update } = await memory();
  const request = await submitChange(store, update);
  assert.equal(request.targetRecordId, update.targetRecordId);
  assert.equal(request.targetSourceId, sourceId);
  assert.deepEqual(request.fields, update.fields);
});

test("disabled objects refuse changes", async () => {
  const { store } = await memory();
  await store.editWritebackPolicy(deployment, "Account", { action: "disable" });
  await refuse(store, create, "Write-back is disabled for Account");
});

test("unknown object keys are rejected", async () => {
  const { store } = await memory();
  await refuse(store, { ...create, entityKey: "Missing" }, "Unknown object Missing");
});

test("unwritable fields produce individual errors", async () => {
  const { store } = await memory();
  await store.editWritebackPolicy(deployment, "Account", { action: "exclude", keys: ["Origin"] });
  await refuse(store, { ...create, fields: {
    ...create.fields, Score: { value: 3 }, Origin: { value: "Import" }, Total: { value: "x" },
    Id: { value: "x" }, record_id: { value: "x" }, missing: { value: "x" },
  } }, ...["Score", "Origin", "Total", "Id", "record_id", "missing"].map((key) => `${key} is not writable on create`));
});

test("type validation refuses incompatible and lossy numeric values", async () => {
  const { store, update } = await memory();
  await assert.rejects(submitChange(store, { ...update, fields: { Score: { base: 2, value: "oops" } } }), /Score has an invalid value/);
  await refuse(store, { ...update, fields: { Score: { base: 2, value: "9999999999999999999" } } },
    "Score has an invalid value (Number cannot be represented without losing precision)");
});

test("nullable fields can be cleared but required fields cannot", async () => {
  const { store, update } = await memory();
  await refuse(store, { ...create, fields: { Name: { value: null } } }, "Name has an invalid value (null is not allowed)");
  assert.deepEqual((await submitChange(store, { ...update, fields: { Score: { base: 2, value: null } } })).fields,
    { Score: { base: 2, value: null } });
});

test("an update needs a base for every supplied field and accepts an explicit null base", async () => {
  const { store, update } = await memory();
  await refuse(store, { ...update, fields: { Name: { value: "new" }, Score: { value: 3 } } },
    "Name requires a base value", "Score requires a base value");
  assert.deepEqual((await submitChange(store, { ...update, fields: { Score: { base: null, value: 3 } } })).fields,
    { Score: { base: null, value: 3 } });
});

test("updates to an absent or out-of-scope target are refused", async () => {
  const { store, update } = await memory();
  await refuse(store, updateFor("missing"), "Update target record does not exist");
  await store.editWritebackPolicy(deployment, "Contact", { action: "enable" });
  await refuse(store, { ...update, entityKey: "Contact" }, "Update target record does not exist");
});

test("updates to tombstones are refused", async () => {
  const { store, update } = await memory();
  await store.markDeleted(deployment, "Account", [sourceId]);
  await refuse(store, update, "Update target record is deleted");
});

test("creates require writable non-nullable source fields that lack a default", async () => {
  const { store } = await memory();
  await refuse(store, { ...create, fields: {} }, "Name is required on create");
  await refuse(store, { ...create, targetRecordId: "fixture-target" }, "A create cannot have a target record");
  await store.editWritebackPolicy(deployment, "Account", { action: "exclude", keys: ["Name"] });
  await refuse(store, create, "Name is not writable on create");
});

test("delete is refused explicitly even with an existing idempotency key", async () => {
  const { store } = await memory();
  const input = { ...create, idempotencyKey: "retry" };
  await refuse(store, { ...input, operation: "delete" }, "deletes are not supported by write-back");
  await submitChange(store, input);
  await assert.rejects(submitChange(store, { ...input, operation: "delete" }), /^ChangeValidationError: deletes are not supported by write-back$/);
  assert.equal((await store.listChangeRequests(deployment)).length, 1);
});

async function requestContract(store: WritebackStore) {
  const input = { ...create, idempotencyKey: "fixture-retry" };
  const [initial, duplicate] = await Promise.all([submitChange(store, input), submitChange(store, input)]);
  assert.deepEqual(duplicate, initial);
  const other = await submitChange(store, { ...input, entityKey: "Contact", idempotencyKey: "another" });
  await assert.rejects(store.transitionChangeRequest(deployment, initial.id, "pending", { status: "applied" }), /Illegal change request transition/);
  const claims = await Promise.allSettled([1, 2].map(() =>
    store.transitionChangeRequest(deployment, initial.id, "pending", { status: "sending" })));
  assert.equal(claims.filter(({ status }) => status === "fulfilled").length, 1);
  const conflictValues = { Name: { base: "old", replicaValue: "new", sourceValue: "changed" } };
  await store.transitionChangeRequest(deployment, initial.id, "sending", { status: "conflict", conflictValues });
  await assert.rejects(store.transitionChangeRequest(deployment, initial.id, "conflict", { status: "overridden" }), /operator decision/);
  const overrideDecision = { operatorLabel: "Fixture operator", time: new Date().toISOString(), side: "replica" as const };
  await store.transitionChangeRequest(deployment, initial.id, "conflict", { status: "overridden", overrideDecision });
  await store.transitionChangeRequest(deployment, initial.id, "overridden", { status: "sending" });
  const applied = await store.transitionChangeRequest(deployment, initial.id, "sending", { status: "applied", resultingSourceId: sourceId });
  assert.deepEqual(await store.getChangeRequest(deployment, initial.id), applied);
  assert.deepEqual(applied.conflictValues, conflictValues);
  assert.deepEqual(applied.overrideDecision, overrideDecision);
  assert.equal(applied.resultingSourceId, sourceId);
  assert.ok(applied.updatedAt > initial.updatedAt);
  assert.deepEqual(await submitChange(store, { ...input, fields: {} }), applied);
  await assert.rejects(store.transitionChangeRequest(deployment, initial.id, "applied", { status: "pending" }), /Illegal change request transition/);
  assert.deepEqual(await store.listChangeRequests(deployment, { status: "pending", entityKey: "Contact" }), [other]);
  assert.deepEqual(await store.listChangeRequests(deployment, { status: "applied" }), [applied]);
  assert.deepEqual(await store.listChangeRequests(deployment, { entityKey: "Account" }), [applied]);
  assert.deepEqual(await store.listChangeRequests("other"), []);
  assert.equal(await store.getChangeRequest("other", applied.id), null);
}

test("memory change store shares idempotency, transition and filtering rules", async () => {
  const { store } = await memory();
  await store.editWritebackPolicy(deployment, "Contact", { action: "enable" });
  await requestContract(store);
});

test("PostgreSQL change store shares idempotency, transition and filtering rules", async () => {
  const { db, prisma } = await database();
  try {
    const store = new PostgresReplicaStore(prisma);
    await store.ensureDeployment(deployment, deployment);
    await store.persistMetadata(deployment, [account, contact]);
    await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
    await store.editWritebackPolicy(deployment, "Contact", { action: "enable" });
    await requestContract(store);
    await store.persistRecords(deployment, account, { records: [{ sourceId, fields: { Name: "old" } }], nextCheckpoint: null });
    const row = await prisma.record.findFirst({ where: { deploymentId: deployment, sourceId } });
    assert.equal((await submitChange(store, updateFor(row!.id))).targetSourceId, sourceId);
  } finally {
    await db.close();
  }
});

test("an unknown outcome cannot be requeued", async () => {
  const { store } = await memory();
  const request = await submitChange(store, create);
  await store.transitionChangeRequest(deployment, request.id, "pending", { status: "sending" });
  await store.transitionChangeRequest(deployment, request.id, "sending", { status: "unknown", statusDetail: "Lost acknowledgement" });
  await assert.rejects(store.transitionChangeRequest(deployment, request.id, "unknown", { status: "sending" }), /Illegal change request transition/);
  const linked = await store.transitionChangeRequest(deployment, request.id, "unknown", {
    status: "applied", resultingSourceId: sourceId, targetSourceId: sourceId, targetRecordId: "fixture-target",
  });
  assert.equal(linked.targetRecordId, "fixture-target");
});
