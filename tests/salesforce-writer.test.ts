import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { normalizeMetadata } from "../src/sources/salesforce/metadata.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { database } from "./helpers/database.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { ChangeRequestProcessor, submitChange } from "../src/writeback/index.js";
import type { OverrideDecision } from "../src/writeback/requests.js";
import { accountDescribe, deployment } from "./helpers/writeback.js";

const oldId = "fixture-record";
const newId = "fixture-created";
const stamp = "2026-11-23T12:00:00.000Z";
const attribution = "WritebackAuthor__c";
const decision: OverrideDecision = { operatorLabel: "Fixture operator", time: stamp, side: "replica" };
const json = (value: unknown, status = 200, headers?: Record<string, string>) => Response.json(value, { status, ...(headers && { headers }) });

async function fixture(options: ConstructorParameters<typeof SourceClient>[1] = {}) {
  const state = {
    base: "Before", score: 3, empty: false, writable: true,
    outcome: undefined as Response | Error | undefined, readOutcome: undefined as Response | undefined,
    created: false, refreshError: false,
  };
  const attributes = () => [...accountDescribe.fields, {
    ...accountDescribe.fields[0]!, name: attribution, custom: true, nillable: true, updateable: state.writable,
  }];
  const entity = normalizeMetadata({ ...accountDescribe, fields: attributes() });
  const calls: Array<{ method: string; query: string | null; body: unknown; authorization: string | null }> = [];
  const source = new SourceClient({
    mode: "oauth", instanceUrl: "https://example.invalid", accessToken: "fixture-access",
  }, {
    ...options,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("q");
      const method = init?.method ?? "GET";
      calls.push({
        method, query, body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (query && url.pathname.endsWith("/query")) {
        return state.readOutcome ?? json({ done: true, records: state.empty ? [] : [{ Name: state.base, Score: state.score }] });
      }
      if (query) {
        if (state.refreshError) return json([], 503);
        const id = query.includes(newId) || (!query.includes(oldId) && state.created) ? newId : oldId;
        return json({ done: true, records: [{ Id: id, Name: "Automation", Score: state.score, SystemModstamp: stamp }] });
      }
      if (state.outcome instanceof Error) throw state.outcome;
      if (state.outcome) return state.outcome;
      if (method === "POST") {
        state.created = true;
        return json({ id: newId, success: true }, 201);
      }
      assert.equal(method, "PATCH");
      return new Response(null, { status: 204 });
    },
    connectionFactory: () => ({
      instanceUrl: "https://example.invalid", accessToken: "fixture-access",
      describeGlobal: async () => ({ sobjects: [] }),
      sobject: () => ({ describe: async () => ({ ...accountDescribe, fields: attributes() }) }),
      identity: async () => { throw new Error("Unexpected identity"); },
      query: async () => { throw new Error("Use the fetch fixture"); },
      queryMore: async () => { throw new Error("Use the fetch fixture"); },
    }),
  });
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(deployment, [entity]);
  await store.editWritebackPolicy(deployment, entity.key, { action: "enable" });
  await store.persistRecords(deployment, entity, { records: [{ sourceId: oldId, fields: { Name: "Before" } }], nextCheckpoint: null });
  const processor = new ChangeRequestProcessor(store, source);
  const common = { deploymentId: deployment, entityKey: entity.key, authorKind: "person", authorLabel: "Fixture operator" } as const;
  const create = () => submitChange(store, { ...common, operation: "create", fields: { Name: { value: "Proposed" } } });
  const update = (fields = { Name: { base: "Before", value: "Proposed" } } as Parameters<typeof submitChange>[1]["fields"]) =>
    submitChange(store, { ...common, operation: "update", targetRecordId: store.readRecords(deployment, entity.key)[0]!.id, fields });
  const conflicted = async () => {
    state.base = "Upstream";
    return processor.processChange(await update());
  };
  const unknown = async () => {
    state.outcome = new TypeError("Connection reset");
    return processor.processChange(await create());
  };
  return { calls, store, source, processor, state, entity, create, update, conflicted, unknown };
}

test("matching base writes only edited fields and refreshes automation values and modification time", async () => {
  const f = await fixture();
  const result = await f.processor.processChange(await f.update());
  assert.equal(result.status, "applied");
  assert.equal(result.sourceModifiedAt?.toISOString(), stamp);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET", "PATCH", "GET"]);
  assert.equal(f.calls[0]?.query, "SELECT Name FROM Account WHERE Id = 'fixture-record'");
  assert.deepEqual(f.calls[1]?.body, { Name: "Proposed" });
  assert.equal(f.store.readRecords(deployment, "Account")[0]?.fields.Name, "Automation");
});

test("changed base stores all three values and makes no write", async () => {
  const f = await fixture();
  const result = await f.conflicted();
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflictValues, { Name: { base: "Before", replicaValue: "Proposed", sourceValue: "Upstream" } });
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
});

test("unrelated upstream edits do not conflict", async () => {
  const f = await fixture();
  f.state.score = 9;
  assert.equal((await f.processor.processChange(await f.update())).status, "applied");
  assert.deepEqual(f.calls[1]?.body, { Name: "Proposed" });
  assert.equal(f.store.readRecords(deployment, "Account")[0]?.fields.Score, "9");
});

test("decimal strings and numbers use the same replica comparison", async () => {
  const f = await fixture();
  assert.equal((await f.processor.processChange(await f.update({ Score: { base: "3.00", value: 5 } }))).status, "applied");
});

test("replica override records decision and skips conflict read", async () => {
  const f = await fixture();
  const result = await f.processor.overrideConflict(await f.conflicted(), decision);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.overrideDecision, decision);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET", "PATCH", "GET"]);
});

test("source override records decision and keeps source values", async () => {
  const f = await fixture();
  const sourceDecision = { ...decision, side: "source" } as const;
  const result = await f.processor.overrideConflict(await f.conflicted(), sourceDecision);
  assert.equal(result.status, "rejected");
  assert.equal(result.statusDetail, "kept Salesforce values");
  assert.deepEqual(result.overrideDecision, sourceDecision);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
});

test("create captures and links its ID so subsequent sync updates the same replica row", async () => {
  const f = await fixture();
  const result = await f.processor.processChange(await f.create());
  assert.equal(result.status, "applied");
  assert.equal(result.resultingSourceId, newId);
  assert.deepEqual(f.calls.map((call) => call.method), ["POST", "GET"]);
  const linked = f.store.readRecords(deployment, "Account").find((row) => row.sourceId === newId);
  assert.ok(linked);
  for await (const batch of f.source.fetchChanges(f.entity, null, 20)) {
    await f.store.persistRecords(deployment, f.entity, batch);
  }
  const rows = f.store.readRecords(deployment, "Account").filter((row) => row.sourceId === newId);
  assert.deepEqual(rows.map(({ id }) => id), [linked.id]);
});

test("lost create acknowledgment becomes unknown and refuses automatic processing", async () => {
  const f = await fixture();
  const result = await f.unknown();
  assert.equal(result.status, "unknown");
  assert.match(result.statusDetail!, /never be retried automatically/);
  await assert.rejects(f.processor.processChange(result), /not ready/);
  assert.deepEqual(f.calls.map((call) => call.method), ["POST"]);
});

test("unknown create can be linked to a confirmed source record", async () => {
  const f = await fixture();
  const result = await f.processor.resolveUnknown(await f.unknown(), { linkSourceId: newId });
  assert.equal(result.status, "applied");
  assert.equal(result.resultingSourceId, newId);
  assert.ok(f.store.readRecords(deployment, "Account").some((row) => row.sourceId === newId));
  assert.deepEqual(f.calls.map((call) => call.method), ["POST", "GET"]);
});

test("explicit resubmission requeues an unknown create and invalidates stale requests", async () => {
  const f = await fixture();
  const pending = await f.create();
  f.state.outcome = new TypeError("Connection reset");
  const unknown = await f.processor.processChange(pending);
  const queued = await f.processor.resolveUnknown(unknown, { resubmit: true });
  assert.equal(queued.status, "pending");
  await assert.rejects(f.processor.processChange(pending), /concurrently/);
  assert.equal(f.calls.length, 1);
  f.state.outcome = undefined;
  assert.equal((await f.processor.processChange(queued)).status, "applied");
  assert.deepEqual(f.calls.map((call) => call.method), ["POST", "POST", "GET"]);
});

test("abandon closes an unknown create without another source request", async () => {
  const f = await fixture();
  const result = await f.processor.resolveUnknown(await f.unknown(), { abandon: true });
  assert.equal(result.status, "rejected");
  assert.deepEqual(f.calls.map((call) => call.method), ["POST"]);
});

const errors = [
  "FIELD_CUSTOM_VALIDATION_EXCEPTION", "REQUIRED_FIELD_MISSING", "INVALID_FIELD_FOR_INSERT_UPDATE",
  "INSUFFICIENT_ACCESS_OR_READONLY", "DUPLICATES_DETECTED", "ENTITY_IS_DELETED",
];
async function rejectsVerbatim(code: string) {
  const f = await fixture();
  const message = "  Fixture source message\nsecond line.  ";
  const fields = ["Name"];
  f.state.outcome = json([{ errorCode: code, message, fields }], 400);
  const result = await f.processor.processChange(await f.update());
  assert.equal(result.status, "rejected");
  assert.equal(result.statusDetail, message);
  assert.deepEqual(result.sourceError, { code, message, fields });
}
test("validation rule error is verbatim", () => rejectsVerbatim(errors[0]!));
test("required field error is verbatim", () => rejectsVerbatim(errors[1]!));
test("field writability error is verbatim", () => rejectsVerbatim(errors[2]!));
test("insufficient access error is verbatim", () => rejectsVerbatim(errors[3]!));
test("duplicate rule error is verbatim", () => rejectsVerbatim(errors[4]!));
test("entity deleted error is verbatim", () => rejectsVerbatim(errors[5]!));

test("rate limit preserves Retry-After", async () => {
  const f = await fixture();
  f.state.outcome = json([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "Try later" }], 429, { "Retry-After": "120" });
  const result = await f.processor.processChange(await f.create());
  assert.equal(result.status, "failed");
  assert.equal(result.retryAfter, "120");
  await assert.rejects(f.processor.processChange(result), /Retry-After delay has not elapsed/);
  assert.equal(f.calls.length, 1);
});

test("a failed request can be retried on the same row once its delay has elapsed", async () => {
  const f = await fixture();
  f.state.outcome = json([], 429, { "Retry-After": "0" });
  const failed = await f.processor.processChange(await f.create());
  assert.equal(failed.status, "failed");
  f.state.outcome = undefined;
  const applied = await f.processor.processChange(failed);
  assert.equal(applied.status, "applied");
  assert.equal(applied.id, failed.id);
  assert.equal(applied.retryAfter, null);
  await assert.rejects(f.processor.processChange(failed), /concurrently/);
  assert.deepEqual(f.calls.map(({ method }) => method), ["POST", "POST", "GET"]);
});

test("an expired create session refreshes under the lock and replays once", async () => {
  const events: string[] = [];
  const f = await fixture({
    withRefreshLock: async (task) => {
      events.push("lock");
      const result = await task();
      events.push("unlock");
      return result;
    },
    refresh: async (token) => {
      assert.equal(token, "fixture-access");
      events.push("refresh");
      f.state.outcome = undefined;
      return { accessToken: "fixture-refreshed" };
    },
  });
  f.state.outcome = json([{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }], 401);
  const result = await f.processor.processChange(await f.create());
  assert.equal(result.status, "applied");
  assert.deepEqual(events, ["lock", "refresh", "unlock"]);
  assert.deepEqual(f.calls.map(({ method, authorization }) => [method, authorization]), [
    ["POST", "Bearer fixture-access"], ["POST", "Bearer fixture-refreshed"], ["GET", "Bearer fixture-refreshed"],
  ]);
  assert.deepEqual(f.calls[0]?.body, f.calls[1]?.body);
});

test("an expired session without refresh leaves the change failed", async () => {
  const f = await fixture();
  f.state.outcome = json([{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }], 401);
  const result = await f.processor.processChange(await f.update());
  assert.equal(result.status, "failed");
  assert.equal(result.statusDetail, "Session expired");
  assert.deepEqual(f.calls.map(({ method }) => method), ["GET", "PATCH"]);
});

test("5xx before update is failed with Retry-After and makes no write", async () => {
  const f = await fixture();
  f.state.readOutcome = json([], 503, { "Retry-After": "30" });
  const result = await f.processor.processChange(await f.update());
  assert.equal(result.status, "failed");
  assert.equal(result.retryAfter, "30");
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
});

test("5xx on create is unknown", async () => {
  const f = await fixture();
  f.state.outcome = json([], 503);
  assert.equal((await f.processor.processChange(await f.create())).status, "unknown");
  assert.equal(f.calls.length, 1);
});

test("configured attribution is sent on update and create", async () => {
  const f = await fixture();
  await f.source.configureWriteback({ Account: { writeback: { attributionField: attribution } } });
  await f.processor.processChange(await f.update());
  await f.processor.processChange(await f.create());
  assert.deepEqual(f.calls.filter(({ method }) => method !== "GET").map(({ body }) => body), [
    { Name: "Proposed", [attribution]: "person: Fixture operator" },
    { Name: "Proposed", [attribution]: "person: Fixture operator" },
  ]);
});

test("missing and non-updatable attribution fields are refused at configuration time", async () => {
  const f = await fixture();
  f.state.writable = false;
  for (const attributionField of [attribution, "Missing__c"]) {
    await assert.rejects(f.source.configureWriteback({ Account: { writeback: { attributionField } } }), /Cannot enable attribution.*writable/);
  }
  assert.equal(f.calls.length, 0);
});

test("unavailable update target is rejected without a write", async () => {
  const f = await fixture();
  f.state.empty = true;
  const result = await f.processor.processChange(await f.update());
  assert.equal(result.status, "rejected");
  assert.match(result.statusDetail!, /deleted or is not visible/);
  assert.deepEqual(f.calls.map((call) => call.method), ["GET"]);
});

test("confirmed create stays applied and retains its ID when refresh fails", async () => {
  const f = await fixture();
  f.state.refreshError = true;
  const result = await f.processor.processChange(await f.create());
  assert.equal(result.status, "applied");
  assert.equal(result.resultingSourceId, newId);
  assert.match(result.statusDetail!, /refresh failed/);
  assert.ok(f.store.readRecords(deployment, "Account").some((row) => row.sourceId === newId));
  assert.deepEqual(f.calls.map((call) => call.method), ["POST", "GET"]);
});

test("PostgreSQL persists source audit data and links a confirmed create", async () => {
  const f = await fixture();
  const { db, prisma } = await database();
  try {
    const store = new PostgresReplicaStore(prisma);
    await store.ensureDeployment(deployment, deployment);
    await store.persistMetadata(deployment, [f.entity]);
    await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
    const processor = new ChangeRequestProcessor(store, f.source);
    const submit = () => submitChange(store, {
      deploymentId: deployment, entityKey: "Account", operation: "create",
      fields: { Name: { value: "Proposed" } }, authorKind: "app", authorLabel: "Fixture app",
    });
    const applied = await processor.processChange(await submit());
    const stored = await store.getChangeRequest(deployment, applied.id);
    assert.equal(stored?.resultingSourceId, newId);
    assert.equal(stored?.sourceModifiedAt?.toISOString(), stamp);
    const linked = await prisma.record.findFirst({ where: { deploymentId: deployment, sourceId: newId } });
    assert.ok(linked);
    await store.ensureWritebackRecord(deployment, "Account", newId);
    assert.deepEqual(await prisma.record.findFirst({ where: { deploymentId: deployment, sourceId: newId } }), linked);

    const nativeError = { errorCode: errors[0], message: " Fixture validation ", fields: ["Name"] };
    f.state.outcome = json([nativeError], 400);
    const rejected = await processor.processChange(await submit());
    assert.deepEqual((await store.getChangeRequest(deployment, rejected.id))?.sourceError,
      { code: nativeError.errorCode, message: nativeError.message, fields: nativeError.fields });
  } finally {
    await db.close();
  }
});
