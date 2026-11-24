import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleHandler } from "../src/console/handler.js";
import { createConsoleRuns, processToken, type ConsoleStage } from "../src/console/runs.js";
import { buildStatus } from "../src/console/status.js";
import { createConsoleWriteback } from "../src/console/writeback.js";
import { LockHeldError } from "../src/locks/file-lock.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { ChangeRequestProcessor } from "../src/writeback/processor.js";
import { processBatch } from "../src/writeback/queue.js";
import type { ChangeTransition } from "../src/writeback/requests.js";
import { config } from "./helpers/cli-fixture.js";
import { account, deployment } from "./helpers/writeback.js";

const port = 4999;
const headers = { host: `127.0.0.1:${port}` };
const other = "fixture-other";
const recordId = "fixture-record";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const store = new InMemoryReplicaStore();
  for (const id of [deployment, other]) {
    await store.ensureDeployment(id, id);
    await store.persistMetadata(id, [account]);
    await store.persistRecords(id, account, { records: [{ sourceId: recordId, fields: { Name: "Stored name" } }], nextCheckpoint: null });
  }

  const now = () => new Date();
  const holders = new Map<string, string>();
  const acquire = async (id: string, command: string) => {
    const holder = holders.get(id);
    if (holder) throw new LockHeldError("fixture", {
      command: holder, pid: 1, hostname: "fixture", startedAt: now().toISOString(), ownerToken: "fixture-owner",
    }, "Deployment lock held");
    holders.set(id, command);
    return { release: async () => { holders.delete(id); } };
  };
  const writes: string[] = [];
  const lookups: string[] = [];
  const session = () => ({
    processor: async (needsSource: boolean) => new ChangeRequestProcessor(store, needsSource ? {
      applyChange: async ({ entity }) => {
        writes.push(entity.key);
        return { status: "applied", sourceId: recordId, modifiedAt: null };
      },
      readRecord: async (_entity, sourceId) => {
        lookups.push(sourceId);
        return { sourceId, fields: { Name: "Linked record" } };
      },
    } : {}),
    close: async () => {},
  });
  const sync = deferred();
  const processed = deferred();
  const buildRuns = (id: string) => createConsoleRuns({
    acquire: (stage: ConsoleStage) => acquire(id, `console ${stage}`),
    run: async (stage, signal) => {
      if (stage !== "changes") return sync.promise;
      await processBatch({ store, deploymentId: id, signal, processor: () => session().processor(true) });
      processed.resolve();
    },
  });
  const runs = buildRuns(deployment);
  const secondaryRuns = buildRuns(other);
  const handle = createConsoleHandler({
    port, now, runs, runsFor: (id) => id === deployment ? runs : secondaryRuns,
    defaultDeployment: async () => deployment,
    listReplicas: async () => [deployment, other].map((id) => ({ id, name: id, sourceUrl: null, isActive: true })),
    buildStatus: (id = deployment) => buildStatus({ ...config, deploymentId: id }, { entities: [account.key] }, store, undefined),
    writeback: async (id) => createConsoleWriteback({ deploymentId: id, store, acquire: () => acquire(id, "changes review"), session, now }),
  });

  const seed = async (transition?: ChangeTransition, operation: "create" | "update" = "update", id = deployment, author = "Fixture author") => {
    const request = await store.createChangeRequest({
      deploymentId: id, entityKey: account.key, operation,
      targetRecordId: operation === "update" ? recordId : null, targetSourceId: operation === "update" ? recordId : null,
      fields: { Name: operation === "update" ? { base: "Started", value: "Replica" } : { value: "New record" } },
      authorKind: "person", authorLabel: author, reason: null, idempotencyKey: null,
    });
    if (!transition) return request;
    await store.transitionChangeRequest(id, request.id, "pending", { status: "sending" });
    return store.transitionChangeRequest(id, request.id, "sending", transition);
  };
  const get = (path: string) => handle("GET", path, headers);
  const post = (path: string, payload: unknown, authorized = true) => handle("POST", path,
    { ...headers, ...(authorized && { "x-replcrm-token": processToken }) }, payload);
  const policy = (action: string, field?: string, id = deployment) => post(`/api/objects?deployment=${id}`, { action, entityKey: account.key, field });
  const review = (id: string, action: string, operator?: string, authorized = true, sourceId?: string) =>
    post("/api/changes", { id, action, operator, recordId: sourceId }, authorized);
  const read = (id: string) => store.getChangeRequest(deployment, id);
  return { store, handle, get, post, policy, review, seed, read, writes, lookups, sync, processed, runs, secondaryRuns };
}

const conflict = {
  status: "conflict",
  conflictValues: { Name: { base: "Started", replicaValue: "Replica", sourceValue: "Salesforce current" } },
} as const;

test("object write-back is off by default and the switch writes through the policy store", async () => {
  const f = await fixture();
  assert.equal(JSON.parse((await f.get("/api/objects")).body).objects[0].enabled, false);
  assert.doesNotMatch((await f.get("/objects")).body, /as the signed-in user/);
  assert.equal((await f.policy("enable")).status, 200);
  assert.equal((await f.store.getWritebackPolicy(deployment, account.key)).enabled, true);
  assert.match((await f.get("/objects")).body, /as the signed-in user/);
  assert.equal((await f.policy("disable")).status, 200);
  assert.equal((await f.store.getWritebackPolicy(deployment, account.key)).enabled, false);
});

test("exclude and include round-trip through the shared policy store", async () => {
  const f = await fixture();
  await f.policy("enable");
  assert.equal((await f.policy("exclude", "Name")).status, 200);
  assert.deepEqual(await f.store.getWritebackPolicy(deployment, account.key), { enabled: true, excludedAttributeKeys: ["Name"] });
  const { objects } = JSON.parse((await f.get("/api/objects")).body);
  assert.deepEqual(objects[0].fields.find(({ key }: { key: string }) => key === "Name"), { key: "Name", excluded: true, update: false, create: false });
  assert.equal((await f.policy("include", "Name")).status, 200);
  assert.deepEqual((await f.store.getWritebackPolicy(deployment, account.key)).excludedAttributeKeys, []);
});

test("object fields show effective create and update capabilities", async () => {
  const f = await fixture();
  await f.policy("enable");
  assert.deepEqual(JSON.parse((await f.get("/api/objects")).body).objects[0].fields, [
    { key: "Name", excluded: false, update: true, create: true },
    { key: "Origin", excluded: false, update: false, create: true },
    { key: "Score", excluded: false, update: true, create: false },
  ]);
});

test("objects validate token, metadata and deployment", async () => {
  const f = await fixture();
  assert.equal((await f.post("/api/objects", { action: "enable", entityKey: account.key }, false)).status, 403);
  assert.equal((await f.policy("exclude", "missing")).status, 404);
  assert.equal((await f.policy("enable", undefined, "missing")).status, 404);
  assert.equal((await f.policy("enable", undefined, other)).status, 200);
  assert.equal((await f.store.getWritebackPolicy(deployment, account.key)).enabled, false);
  assert.equal((await f.store.getWritebackPolicy(other, account.key)).enabled, true);
});

test("Changes filters newest first and preserves the deployment review badge", async () => {
  const f = await fixture();
  await f.seed(conflict);
  await f.seed({ status: "unknown" }, "create");
  await f.seed(conflict, "update", other);
  await f.seed();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const latest = await f.seed();
  const response = JSON.parse((await f.get("/api/changes?status=pending")).body);
  assert.equal(response.changes[0].id, latest.id);
  assert.ok(response.changes.every(({ status }: { status: string }) => status === "pending"));
  assert.equal(response.changes[0].record, "Stored name");
  assert.equal(response.counts.needsReview, 2);
  assert.match((await f.get("/changes?status=pending")).body, /id="nav-changes-count"[^>]*>2</);
  assert.equal(JSON.parse((await f.get(`/api/changes?deployment=${other}`)).body).counts.needsReview, 1);
  assert.equal((await f.get("/api/changes?status=bogus")).status, 400);
});

test("conflict detail returns the three field values", async () => {
  const f = await fixture();
  const request = await f.seed(conflict);
  const detail = `/changes?status=conflict&id=${request.id}`;
  assert.deepEqual(JSON.parse((await f.get("/api" + detail)).body).changes[0].conflictValues, conflict.conflictValues);
  assert.match((await f.get(detail)).body, />Started<.*>Replica<.*>Salesforce current</);
});

test("Changes renders separate status links with deployment counts and a selected tab", async () => {
  const f = await fixture();
  await f.seed(conflict);
  await f.seed();
  const { body } = await f.get("/changes?status=conflict");
  const tabs = body.match(/<nav class="change-filters" aria-label="Change status">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.deepEqual([...tabs.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((link) => link[1]),
    ["All 2", "Pending 1", "Sending 0", "Applied 0", "Conflict 1", "Overridden 0", "Rejected 0", "Failed 0", "Unknown 0"]);
  assert.match(tabs, /status=conflict" aria-current="page">Conflict 1/);
  assert.equal([...tabs.matchAll(/aria-current="page"/g)].length, 1);
});

test("an unlinked create uses the object label and submitted name in the list and detail", async () => {
  const f = await fixture();
  const contact = { ...account, key: "ContactKey", label: "Contact",
    attributes: account.attributes.map((attr) => ({ ...attr, isNameField: attr.key === "Origin" })) };
  await f.store.persistMetadata(deployment, [contact]);
  const create = (name?: string) => f.store.createChangeRequest({
    deploymentId: deployment, entityKey: contact.key, operation: "create", targetRecordId: null, targetSourceId: null,
    fields: name ? { Origin: { value: name } } : {}, authorKind: "person", authorLabel: "Fixture author",
    reason: null, idempotencyKey: null,
  });
  const named = await create("Priya Shah");
  const unnamed = await create();
  const { body } = await f.get("/changes?id=" + named.id);
  assert.match(body, />New Contact: Priya Shah<\/a>/);
  assert.match(body, /<h2>New Contact: Priya Shah<\/h2>/);
  assert.match(body, />New Contact<\/a>/);
  for (const request of [named, unnamed]) assert.ok(!body.includes(">" + request.id + "<"));
});

test("an unlinked create whose name field is compound uses the submitted first and last names", async () => {
  const f = await fixture();
  const contact = { ...account, key: "ContactKey", label: "Contact",
    attributes: [...account.attributes.map((attr) => ({ ...attr, isNameField: attr.key === "Origin" })),
      { ...account.attributes[0]!, key: "FirstName", label: "First Name", isNameField: false },
      { ...account.attributes[0]!, key: "LastName", label: "Last Name", isNameField: false }] };
  await f.store.persistMetadata(deployment, [contact]);
  const request = await f.store.createChangeRequest({
    deploymentId: deployment, entityKey: contact.key, operation: "create", targetRecordId: null, targetSourceId: null,
    fields: { FirstName: { value: "Priya" }, LastName: { value: "Shah" } }, authorKind: "person", authorLabel: "Fixture author",
    reason: null, idempotencyKey: null,
  });
  const { body } = await f.get("/changes?id=" + request.id);
  assert.match(body, />New Contact: Priya Shah<\/a>/);
  assert.match(body, /<h2>New Contact: Priya Shah<\/h2>/);
});

test("keep-replica refuses a missing operator or token and records a valid override", async () => {
  const f = await fixture();
  const request = await f.seed(conflict);
  await f.policy("enable");
  assert.equal((await f.review(request.id, "replica", " ")).status, 400);
  assert.equal((await f.review(request.id, "replica", "Operator", false)).status, 403);
  assert.equal((await f.read(request.id))?.status, "conflict");
  assert.equal((await f.review(request.id, "replica", "Operator")).status, 200);
  const applied = await f.read(request.id);
  assert.equal(applied?.overrideDecision?.operatorLabel, "Operator");
  assert.equal(applied?.overrideDecision?.side, "replica");
  assert.equal(applied?.status, "applied");
  assert.deepEqual(f.writes, [account.key]);
});

test("keep-Salesforce records the operator without a source lookup or write", async () => {
  const f = await fixture();
  const request = await f.seed(conflict);
  assert.equal((await f.review(request.id, "salesforce", "Operator")).status, 200);
  assert.equal((await f.read(request.id))?.overrideDecision?.side, "source");
  assert.equal((await f.read(request.id))?.overrideDecision?.operatorLabel, "Operator");
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.lookups, []);
});

test("only failed requests can be retried", async () => {
  const f = await fixture();
  const failed = await f.seed({ status: "failed" });
  const rejected = await f.seed({ status: "rejected" });
  assert.equal((await f.review(rejected.id, "retry")).status, 409);
  assert.doesNotMatch((await f.get(`/changes?id=${rejected.id}`)).body, /value="retry"/);
  assert.match((await f.get(`/changes?id=${failed.id}`)).body, /value="retry"/);
  assert.equal((await f.review(failed.id, "retry")).status, 200);
  assert.equal((await f.read(failed.id))?.status, "pending");
});

test("rejected and failed requests show the source message and named fields", async () => {
  const f = await fixture();
  const sourceError = { code: "FIXTURE", message: "Message <exact>\nNext line", fields: ["Name", "Score"] };
  for (const status of ["failed", "rejected"] as const) {
    const request = await f.seed({ status, sourceError });
    const { body } = await f.get(`/changes?id=${request.id}`);
    assert.ok(body.includes("Message &lt;exact&gt;\nNext line"));
    assert.match(body, /Name, Score/);
  }
});

test("unknown creates can link to a confirmed source record with an operator label", async () => {
  const f = await fixture();
  const request = await f.seed({ status: "unknown" }, "create");
  assert.match((await f.get(`/changes?id=${request.id}`)).body, /may or may not have created/);
  assert.equal((await f.review(request.id, "link", "Operator")).status, 400);
  assert.equal((await f.review(request.id, "link", undefined, true, recordId)).status, 400);
  assert.equal((await f.review(request.id, "link", "Operator", true, recordId)).status, 200);
  assert.deepEqual(f.lookups, [recordId]);
  assert.deepEqual(f.writes, []);
  const accepted = await f.read(request.id);
  assert.equal(accepted?.resultingSourceId, recordId);
  assert.match(accepted?.statusDetail ?? "", /operator: Operator/);
  const page = await f.get(`/changes?id=${request.id}`);
  assert.match(page.body, /Salesforce ID <b>fixture-record<\/b> · Applied <time>\d{4}-/);
});

test("unknown resubmit and abandon require labels and transition without writing", async () => {
  const f = await fixture();
  for (const [action, expected] of [["resubmit", "pending"], ["abandon", "rejected"]] as const) {
    const request = await f.seed({ status: "unknown" }, "create");
    assert.equal((await f.review(request.id, action)).status, 400);
    assert.equal((await f.review(request.id, action, "Operator")).status, 200);
    const current = await f.read(request.id);
    assert.equal(current?.status, expected);
    assert.match(current?.statusDetail ?? "", /operator: Operator/);
  }
  assert.deepEqual(f.writes, []);
});

test("Process now returns 409 while a sync holds the same deployment lock", async () => {
  const f = await fixture();
  assert.equal((await f.post("/api/runs", { stage: "records" })).status, 202);
  try {
    const response = await f.post(`/api/runs?deployment=${deployment}`, { stage: "changes" });
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(response.body).holder.command, "console records");
    assert.equal((await f.post(`/api/runs?deployment=${other}`, { stage: "changes" })).status, 202);
    await f.processed.promise;
    await f.secondaryRuns.shutdown();
  } finally {
    f.sync.resolve();
    await f.runs.shutdown();
  }
});

test("Process now processes one batch against the selected deployment", async () => {
  const f = await fixture();
  const request = await f.seed();
  const selected = await f.seed(undefined, "update", other);
  await f.policy("enable", undefined, other);
  assert.equal((await f.post(`/api/runs?deployment=${other}`, { stage: "changes" })).status, 202);
  await f.processed.promise;
  await f.secondaryRuns.shutdown();
  assert.equal((await f.store.getChangeRequest(other, selected.id))?.status, "applied");
  assert.equal((await f.read(request.id))?.status, "pending");
  assert.deepEqual(f.writes, [account.key]);
});

test("health strip shows deployment pending, review and recent failure counts", async () => {
  const f = await fixture();
  await f.seed();
  await f.seed(conflict);
  await f.seed({ status: "unknown" });
  await f.seed({ status: "failed" });
  await f.seed({ status: "failed" }, "update", other);
  const expected = { pending: 1, needsReview: 2, failed: 1 };
  assert.deepEqual(JSON.parse((await f.get("/api/status")).body).writeback, expected);
  const { body } = await f.get("/");
  assert.match(body, /id="writeback-pending">1</);
  assert.match(body, /id="writeback-review">2</);
  assert.match(body, /id="writeback-failed">1</);
});

test("Changes and Objects use a fresh CSP nonce, local resources and the Host check", async () => {
  const f = await fixture();
  const first = await f.get("/changes");
  const second = await f.get("/objects");
  const nonces = [first, second].map(({ headers, body }) => {
    const csp = headers["Content-Security-Policy"] ?? "";
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.ok(csp.includes(`style-src 'nonce-${nonce}'`));
    assert.match(csp, /default-src 'none'.*connect-src 'self'/);
    assert.equal([...body.matchAll(/<(?:script|style) nonce="([^"]+)"/g)].filter(([, value]) => value === nonce).length, 3);
    assert.doesNotMatch(body, /<(?:script|link)[^>]*(?:src|href)="https?:/);
    return nonce;
  });
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal((await f.handle("GET", "/changes", { host: "example.test" })).status, 400);
});

test("write-back JSON redacts console tokens even in persisted fields", async () => {
  const f = await fixture();
  const request = await f.seed({ status: "failed", sourceError: { code: "FIXTURE", message: "Bearer fixture-access" } }, "update", deployment, processToken);
  const changes = await f.get(`/api/changes?id=${request.id}`);
  assert.match(changes.body, /Bearer \[redacted\]/);
  for (const response of [changes, await f.get("/api/status"), await f.get("/api/objects"),
    await f.get("/api/runs/current"), await f.policy("enable"), await f.review(request.id, "retry")]) {
    assert.doesNotMatch(response.body, new RegExp(processToken));
  }
});

test("Changes uses the source-designated name field and falls back to the record ID", async () => {
  const f = await fixture();
  const attributes = account.attributes.map((attr) => attr.key === "Origin" ? { ...attr, isNameField: true } : attr);
  const entity = { ...account, attributes };
  await f.store.persistMetadata(deployment, [entity]);
  await f.store.persistRecords(deployment, entity, {
    records: [{ sourceId: recordId, fields: { Origin: "Designated name" } }], nextCheckpoint: null,
  });
  const named = await f.seed();
  const unnamed = await f.store.createChangeRequest({
    deploymentId: deployment, entityKey: account.key, operation: "update",
    targetRecordId: "fixture-no-name", targetSourceId: "fixture-no-name",
    fields: { Score: { base: "1", value: "2" } }, authorKind: "person", authorLabel: "Fixture author",
    reason: null, idempotencyKey: null,
  });
  const { changes } = JSON.parse((await f.get("/api/changes")).body);
  assert.equal(changes.find(({ id }: { id: string }) => id === named.id).record, "Designated name");
  assert.equal(changes.find(({ id }: { id: string }) => id === unnamed.id).record, "fixture-no-name");
});
