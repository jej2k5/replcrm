import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writePrivateJson } from "../src/cli-config-dir.js";
import { verifyDeployment } from "../src/cli-verify.js";
import { runCli, type CliDeps } from "../src/cli.js";
import type { CanonicalEntity } from "../src/core/source.js";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { database } from "./helpers/database.js";
import { describe, field } from "./helpers/salesforce-fixture.js";

const deployment = "fixture-deployment";
const identity = {
  organizationId: "fixture-org", userId: "fixture-user", username: "fixture-name",
  instanceUrl: "https://fixture.invalid",
};
const epoch = Date.parse("2026-01-01T00:00:00Z");
const account = { key: "Account", label: "Account", pluralLabel: "Accounts", attributes: [] };
const contact = { ...account, key: "Contact" };
const ids = ["first", "second", "purged"];
type Store = InMemoryReplicaStore | PostgresReplicaStore;

async function seed(store: Store, id: string, entity: CanonicalEntity, sourceIds = ids) {
  await store.ensureDeployment(id, id);
  await store.persistMetadata(id, [entity]);
  await store.persistRecords(id, entity, {
    records: sourceIds.map((sourceId) => ({ sourceId, fields: {} })), nextCheckpoint: null,
  });
}

async function withFixture<T extends Store>(
  t: TestContext, store: T, action: (context: Awaited<ReturnType<typeof fixture<T>>>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-reconcile-"));
  try {
    await action(await fixture(t, store, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fixture<T extends Store>(t: TestContext, store: T, dir: string) {
  await seed(store, deployment, account);
  const state = { identity: { ...identity }, live: ids.slice(0, 2), now: epoch, failPage: false, selected: ["Account"], deny: [] as string[] };
  const source = new SourceClient(
    { mode: "oauth", instanceUrl: identity.instanceUrl, accessToken: "fixture-access" },
    { identity: async () => state.identity },
  );
  await verifyDeployment(deployment, {}, { configDir: () => dir, createSource: () => source, writeOutput: () => {} });
  const identityCall = t.mock.method(source, "identity");
  const list = t.mock.method(source, "listSourceIds", async function* (_key: string) {
    yield state.live.slice(0, 1);
    if (state.failPage) throw new Error("Fixture paging error");
    yield state.live.slice(1);
  });
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});
  const runStore: Store = store;
  const begin = t.mock.method(runStore, "beginRun");
  const complete = t.mock.method(runStore, "completeRuns");
  const fail = t.mock.method(runStore, "failRun");
  const unexpected = (): never => assert.fail("Unexpected replication operation");
  const deps: CliDeps = {
    loadConfig: () => ({
      deploymentId: deployment, batchSize: 1, buildWideViews: true,
      entityKeys: state.selected, entityDenyKeys: state.deny,
    }),
    createSource: unexpected, createStore: unexpected, ensureDeployment: unexpected,
    deploymentExists: (id) => store.deploymentExists(id),
    hasEntityMetadata: (id, keys) => store.hasEntityMetadata(id, keys),
    reconcile: { configDir: () => dir, now: () => new Date(state.now), createSource: () => source, createStore: () => store },
  };
  const path = join(dir, "reconcile", `${deployment}.json`);
  const run = (...args: string[]) => runCli(["reconcile", ...args], deps);
  return {
    dir, path, run, store, state, identityCall, list, begin, complete, fail, stdout,
    plan: async () => JSON.parse(await readFile(path, "utf8")),
    active: () => store.listActiveSourceIds(deployment, account.key),
    output: () => String(stdout.mock.calls.at(-1)?.arguments[0]),
    async refuses(pattern: RegExp, ...args: string[]) {
      assert.equal(await run(...args), 1);
      assert.match(String(stderr.mock.calls.at(-1)?.arguments[0]), pattern);
    },
  };
}

test("preview saves candidates and reports a sample without mutation or a run", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run("--entities", "Account,Account,Contact"), 1);
    f.state.deny = ["Contact"];
    assert.equal(await f.run("--entities", "Account,Account,Contact"), 0);
    assert.deepEqual((await f.plan()).entities, { Account: { liveCount: 2, storeActiveCount: 3, candidates: ["purged"] } });
    assert.match(f.output(), /Account: 1 candidates purged[\s\S]*Review, then run reconcile --apply/);
    assert.deepEqual(await f.active(), new Set(ids));
    assert.equal(f.begin.mock.callCount(), 0);
    assert.equal(f.list.mock.callCount(), 1);
  });
});

test("apply records a stage run, consumes the plan and leaves a clean preview", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run("--json"), 0);
    assert.equal(JSON.parse(f.output()).results[0].candidateCount, 1);
    assert.equal(await f.run("--apply", "--json"), 0);
    assert.deepEqual(JSON.parse(f.output()).results, [{ entityKey: "Account", deleted: 1 }]);
    assert.match(JSON.parse(f.output()).reminder, /projections/);
    assert.deepEqual(await f.active(), new Set(["first", "second"]));
    assert.ok(f.store.readRecords(deployment, "Account").find((row) => row.sourceId === "purged")?.deletedAt instanceof Date);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
    assert.equal(f.begin.mock.callCount(), 1);
    assert.deepEqual(f.begin.mock.calls[0]?.arguments, [deployment, null]);
    assert.equal(f.complete.mock.calls[0]?.arguments[0][0]?.result.deleted, 1);
    assert.equal(await f.run(), 0);
    assert.deepEqual((await f.plan()).entities.Account.candidates, []);
  });
});

test("PGlite apply scopes tombstones and preserves the records cursor", async (t) => {
  const { db, prisma } = await database();
  try {
    await withFixture(t, new PostgresReplicaStore(prisma), async (f) => {
      await seed(f.store, "fixture-other", account);
      await seed(f.store, deployment, contact);
      const { id } = await f.store.beginRun(deployment, "Account");
      await f.store.completeRuns([{ id, result: { checkpoint: "fixture-cursor", processed: 0, created: 0, updated: 0, deleted: 0 } }]);
      const before = await prisma.syncRun.findUnique({ where: { id } });
      assert.equal(await f.run(), 0);
      assert.equal(await f.run("--apply"), 0);
      const deleted = await prisma.record.findFirst({ where: { deploymentId: deployment, isDeleted: true } });
      assert.equal(deleted?.sourceId, "purged");
      assert.ok(deleted.deletedAt instanceof Date);
      assert.deepEqual(await f.store.listActiveSourceIds("fixture-other", "Account"), new Set(ids));
      assert.deepEqual(await f.store.listActiveSourceIds(deployment, "Contact"), new Set(ids));
      assert.deepEqual(await prisma.syncRun.findUnique({ where: { id } }), before);
      const stage = await prisma.syncRun.findFirst({ where: { deploymentId: deployment, entityKey: null } });
      assert.equal(stage?.status, "Succeeded");
      assert.equal(stage.recordsDeleted, 1);
      assert.equal(stage.cursor, null);
    });
  } finally {
    await db.close();
  }
});

test("apply only changes reviewed candidates still absent from the live listing", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    await seed(f.store, deployment, account, ["also-purged"]);
    assert.equal(await f.run(), 0);
    f.state.live = ["first", "purged"];
    assert.equal(await f.run("--apply"), 0);
    assert.deepEqual(await f.active(), new Set(ids));
  });
});

test("partial visibility under a different user refuses both modes", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    await seed(f.store, deployment, account, ["fourth", "fifth"]);
    f.state.live = ["first", "second", "fourth"];
    assert.equal(await f.run(), 0);
    const reviewed = await readFile(f.path, "utf8");
    f.state.identity.userId = "fixture-narrow-user";
    await f.refuses(/identity mismatch.*fixture-user.*fixture-narrow-user/, "--apply");
    assert.equal(await readFile(f.path, "utf8"), reviewed);
    await unlink(f.path);
    await f.refuses(/identity mismatch.*fixture-narrow-user/);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
    assert.equal((await f.active()).size, 5);
    assert.equal(f.list.mock.callCount(), 1);
    assert.equal(f.begin.mock.callCount(), 0);
  });
});

test("a different organization refuses preview and apply", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run(), 0);
    f.state.identity.organizationId = "fixture-other-org";
    await f.refuses(/identity mismatch.*fixture-other-org/, "--apply");
    await f.refuses(/identity mismatch.*fixture-other-org/);
    assert.deepEqual(await f.active(), new Set(ids));
  });
});

test("both modes require deployment verification", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run(), 0);
    await unlink(join(f.dir, "bindings", `${deployment}.json`));
    await f.refuses(/deployment verify/, "--apply");
    await f.refuses(/deployment verify/);
    assert.equal(f.identityCall.mock.callCount(), 1);
  });
});

test("apply refuses a missing, expired or differently bound plan", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    await f.refuses(/No reviewed reconcile plan/, "--apply");
    assert.equal(await f.run(), 0);
    const plan = await f.plan();
    f.state.now += 3_600_001;
    await f.refuses(/expired/, "--apply");
    f.state.now = epoch;
    await writePrivateJson(f.path, { ...plan, userId: "fixture-other-user" });
    await f.refuses(/plan identity mismatch.*fixture-other-user/, "--apply");
    assert.deepEqual(await f.active(), new Set(ids));
  });
});

test("a late paging failure fails the stage run without marking records", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run(), 0);
    f.state.failPage = true;
    await f.refuses(/Account.*Fixture paging error/, "--apply");
    assert.match(f.fail.mock.calls[0]?.arguments[1] ?? "", /Account/);
    assert.equal(f.complete.mock.callCount(), 0);
    assert.deepEqual(await f.active(), new Set(ids));
    assert.deepEqual((await f.plan()).entities.Account.candidates, ["purged"]);
  });
});

test("empty re-listing with active records requires --allow-empty", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    assert.equal(await f.run(), 0);
    f.state.live = [];
    await f.refuses(/Account.*--allow-empty/, "--apply");
    assert.deepEqual(await f.active(), new Set(ids));
    assert.equal(await f.run("--apply", "--allow-empty"), 0);
    assert.deepEqual(await f.active(), new Set(["first", "second"]));
  });
});

test("deleting more than half of active records requires --allow-large", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    f.state.live = ["first"];
    assert.equal(await f.run(), 0);
    await f.refuses(/Account.*--allow-large/, "--apply");
    assert.deepEqual(await f.active(), new Set(ids));
    assert.equal(await f.run("--apply", "--allow-large"), 0);
    assert.deepEqual(await f.active(), new Set(["first"]));
  });
});

test("missing metadata fails before calling the source", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    await f.refuses(/replicate:metadata/, "--entities", "Account,Contact");
    assert.equal(f.identityCall.mock.callCount(), 0);
    assert.equal(f.list.mock.callCount(), 0);
  });
});

test("Salesforce listing uses include-deleted visibility and follows the query locator", async (t) => {
  const source = new SourceClient({ mode: "oauth", instanceUrl: identity.instanceUrl, accessToken: "fixture-access" });
  source.describeObject = async (key) => describe(key, [field("IsDeleted", "boolean")]);
  const query = t.mock.method(source, "queryPage", async (_query: string, _includeDeleted: boolean, cursor?: string) => cursor
    ? { records: [{ Id: "second" }], totalSize: 2, done: true }
    : { records: [{ Id: "first" }], totalSize: 2, done: false, nextRecordsUrl: "fixture-next" });
  const listed = [];
  for await (const batch of source.listSourceIds("Task", 1)) listed.push(...batch);
  assert.deepEqual(listed, ["first", "second"]);
  const statement = "SELECT Id FROM Task WHERE IsDeleted = false";
  assert.deepEqual(query.mock.calls.map(({ arguments: args }) => args), [[statement, true], [statement, true, "fixture-next"]]);
});

test("wildcards are refused in preview and apply uses only the reviewed keys", async (t) => {
  await withFixture(t, new InMemoryReplicaStore(), async (f) => {
    await f.refuses(/--entities a,b/, "--entities", "*");
    f.state.selected = ["*"];
    await f.refuses(/--entities a,b/);
    assert.equal(f.identityCall.mock.callCount(), 0);
    assert.equal(f.list.mock.callCount(), 0);
    await assert.rejects(readFile(f.path), { code: "ENOENT" });
    assert.equal(await f.run("--entities", "Account"), 0);
    await f.refuses(/uses the reviewed plan/, "--apply", "--entities", "Contact");
    const plan = await f.plan();
    await writePrivateJson(f.path, { ...plan, entities: { "*": plan.entities.Account } });
    await f.refuses(/contains \*/, "--apply");
    assert.deepEqual(await f.active(), new Set(ids));
    await writePrivateJson(f.path, plan);
    assert.equal(await f.run("--apply"), 0);
    assert.deepEqual(f.list.mock.calls.map((call) => call.arguments[0]), ["Account", "Account"]);
  });
});
