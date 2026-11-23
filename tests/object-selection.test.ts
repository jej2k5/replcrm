import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { writePrivateJson } from "../src/cli-config-dir.js";
import type { CanonicalEntity, CrmSource } from "../src/core/source.js";
import { SourceClient, type SourceObjectListing } from "../src/sources/salesforce/client.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";

const deploymentId = "fixture-deployment";
const identity = {
  organizationId: "fixture-org", userId: "fixture-user", username: "fixture-name", instanceUrl: "https://fixture.invalid",
};
const defaults = ["Account", "Contact", "Lead", "Opportunity", "Case"];
const definition = (key: string): CanonicalEntity => ({ key, label: key, pluralLabel: key, attributes: [] });

async function withFixture(t: TestContext, action: (fixture: ReturnType<typeof fixtureFor>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-selection-"));
  try {
    await action(fixtureFor(t, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fixtureFor(t: TestContext, dir: string) {
  const env: NodeJS.ProcessEnv = { DEPLOYMENT_ID: deploymentId, REPLCRM_CONFIG_DIR: dir };
  const production = createProductionDeps(env, { prisma: () => assert.fail("Unexpected database access") });
  const store = new InMemoryReplicaStore();
  const ran: string[] = [];
  const source: CrmSource = {
    async connect() {},
    async logout() {},
    async listEntities() { return ["Account", "Contact", "Contact"]; },
    async describeEntity(key) { return definition(key); },
    async *fetchChanges(entity) {
      ran.push(entity.key);
      yield { records: [], nextCheckpoint: null };
    },
    async *streamUsers() {},
  };
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});
  const selectionDir = join(dir, "selections");
  const path = join(selectionDir, `${deploymentId}.json`);
  const identityCall = t.mock.fn(async () => identity);
  const listIds = t.mock.fn(async function* (_key: string) { yield ["first", "second"]; });
  const createReconcileSource = t.mock.fn(() => ({ identity: identityCall, listSourceIds: listIds, logout: source.logout }));
  const deps: CliDeps = {
    ...production,
    createSource: () => source,
    validateSourceCredentials: () => {},
    deploymentExists: (id) => store.deploymentExists(id),
    hasEntityMetadata: (id, keys) => store.hasEntityMetadata(id, keys),
    createStore: () => store,
    counts: { createStore: () => store, createSource: () => ({ ...source, countRecords: async () => 2 }) },
    reconcile: { ...production.reconcile!, createSource: createReconcileSource, createStore: () => store },
  };
  return {
    env, deps, dir, store, ran, path, selectionDir, identityCall, listIds, createReconcileSource,
    run: (...args: string[]) => runCli(args, deps),
    output: () => JSON.parse(String(stdout.mock.calls.at(-1)?.arguments[0])),
    error: () => String(stderr.mock.calls.at(-1)?.arguments[0]),
    async seed(keys = defaults) {
      store.ensureDeployment(deploymentId, deploymentId);
      await store.persistMetadata(deploymentId, keys.map(definition));
      for (const key of keys) {
        await store.persistRecords(deploymentId, definition(key), {
          records: ["first", "second", "purged"].map((sourceId) => ({ sourceId, fields: {} })), nextCheckpoint: null,
        });
      }
    },
    async bind() {
      await writePrivateJson(join(dir, "bindings", `${deploymentId}.json`), {
        ...identity, version: 1, instanceHost: "fixture.invalid", verifiedAt: new Date().toISOString(),
      });
    },
  };
}

test("records runs for flag, saved, environment and default keys in precedence order", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed();
    assert.equal(await f.run("objects", "set", "Contact"), 0);
    f.env.SYNC_ENTITIES = "Lead";
    for (const [args, expected] of [[["--entities", "Account"], ["Account"]], [[], ["Contact"]]] as const) {
      assert.equal(await f.run("records", ...args), 0);
      assert.deepEqual(f.ran.splice(0), expected);
    }
    assert.equal(await f.run("objects", "clear"), 0);
    assert.equal(await f.run("records"), 0);
    assert.deepEqual(f.ran.splice(0), ["Lead"]);
    delete f.env.SYNC_ENTITIES;
    assert.equal(await f.run("records"), 0);
    assert.deepEqual(f.ran, defaults);
  });
});

test("set, add, remove and clear use an owner-only deployment file", async (t) => {
  await withFixture(t, async (f) => {
    f.env.SYNC_ENTITIES = "Lead";
    assert.equal(await f.run("objects", "set", "Account,Contact"), 0);
    assert.equal(await f.run("objects", "add", "Contact,Invoice__c"), 0);
    assert.equal(await f.run("objects", "remove", "Contact"), 0);
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { version: 1, entities: ["Account", "Invoice__c"] });
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    assert.equal((await stat(f.selectionDir)).mode & 0o777, 0o700);
    assert.equal(await f.run("objects", "list", "--json"), 0);
    assert.deepEqual(f.output(), { source: "saved", entities: ["Account", "Invoice__c"] });
    assert.equal(await f.run("objects", "list", "--entities", "Case", "--json"), 0);
    assert.deepEqual(f.output(), { source: "flag", entities: ["Case"] });
    assert.equal(await f.run("objects", "clear"), 0);
    assert.equal(await f.run("objects", "clear"), 0);
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    assert.equal(await f.run("objects", "list", "--json"), 0);
    assert.deepEqual(f.output(), { source: "SYNC_ENTITIES", entities: ["Lead"] });
  });
});

test("invalid saved JSON and invalid selection schema report the file path", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed();
    assert.equal(await f.run("objects", "set", "Account"), 0);
    for (const contents of ["{", '{"version":2,"entities":["Account"]}', '{"version":1,"entities":["Account.Name"]}']) {
      await writeFile(f.path, contents);
      assert.equal(await f.run("objects", "list"), 1);
      assert.ok(f.error().includes(f.path));
      assert.equal(await f.run("records"), 1);
      assert.ok(f.error().includes(f.path));
    }
    assert.equal(await f.run("records", "--entities", "Account"), 0);
    assert.deepEqual(f.ran, ["Account"]);
  });
});

test("saved wildcard applies the deny list and deduplicates at replication time", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed();
    f.env.SYNC_ENTITY_DENY = "Account";
    assert.equal(await f.run("objects", "set", "*"), 0);
    assert.equal(await f.run("records"), 0);
    assert.deepEqual(f.ran, ["Contact"]);
  });
});

test("list only needs deployment ID while available requires Salesforce credentials", async (t) => {
  await withFixture(t, async (f) => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected network access"));
    assert.equal(await f.run("objects", "list", "--json"), 0);
    assert.deepEqual(f.output(), { source: "default", entities: defaults });
    assert.equal(await f.run("objects", "available"), 1);
    assert.match(f.error(), /Run auth login or set SF_USERNAME, SF_PASSWORD and SF_SECURITY_TOKEN/);
    assert.equal(fetch.mock.callCount(), 0);
  });
});

test("unsafe deployment IDs and invalid object names are refused", async (t) => {
  await withFixture(t, async (f) => {
    for (const invalid of ["Account.Name", "*,Contact"]) {
      assert.equal(await f.run("objects", "set", invalid), 1);
      assert.match(f.error(), /Invalid Salesforce API name/);
    }
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    f.env.DEPLOYMENT_ID = "../x";
    assert.equal(await f.run("objects", "set", "Account"), 1);
    assert.match(f.error(), /Unsafe deployment ID/);
    assert.equal(await f.run("objects", "list"), 1);
    assert.match(f.error(), /Unsafe deployment ID/);
  });
});

test("counts and reconcile preview use the same saved explicit object selection", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed();
    await f.bind();
    f.env.SYNC_ENTITIES = "Lead";
    assert.equal(await f.run("objects", "set", "Account,Contact"), 0);
    assert.equal(await f.run("counts", "--json"), 0);
    assert.deepEqual(f.output().map((row: { entityKey: string }) => row.entityKey), ["Account", "Contact"]);
    assert.equal(await f.run("reconcile", "--json"), 0);
    assert.deepEqual(f.listIds.mock.calls.map((call) => call.arguments[0]), ["Account", "Contact"]);
  });
});

test("reconcile rejects saved wildcard before source creation and applies reviewed keys only", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed();
    await f.bind();
    assert.equal(await f.run("objects", "set", "*"), 0);
    assert.equal(await f.run("reconcile"), 1);
    assert.match(f.error(), /--entities a,b/);
    assert.equal(f.createReconcileSource.mock.callCount(), 0);
    assert.equal(f.identityCall.mock.callCount(), 0);
    assert.equal(f.listIds.mock.callCount(), 0);
    assert.equal(await f.run("reconcile", "--entities", "Account"), 0);
    assert.equal(f.identityCall.mock.callCount(), 1);
    assert.equal(await f.run("objects", "set", "Contact"), 0);
    t.mock.method(f.deps.objects!, "configDir", () => assert.fail("Apply must bypass saved selection resolution"));
    f.env.SYNC_ENTITIES = "*";
    assert.equal(await f.run("reconcile", "--apply"), 0);
    assert.deepEqual(f.listIds.mock.calls.map((call) => call.arguments[0]), ["Account", "Account"]);
    assert.deepEqual(await f.store.listActiveSourceIds(deploymentId, "Account"), new Set(["first", "second"]));
    assert.deepEqual(await f.store.listActiveSourceIds(deploymentId, "Contact"), new Set(["first", "second", "purged"]));
  });
});

test("available uses the adapter's wildcard eligibility and reports sorted names and labels", async (t) => {
  await withFixture(t, async (f) => {
    const source = new SourceClient({ mode: "oauth", instanceUrl: identity.instanceUrl, accessToken: "fixture-access" });
    const listing = (name: string, overrides: Partial<SourceObjectListing> = {}): SourceObjectListing => ({
      name, label: `Label for ${name}`, custom: name.endsWith("__c"), queryable: true,
      replicateable: true, deprecatedAndHidden: false, layoutable: true, ...overrides,
    });
    source.describeGlobal = async () => [
      listing("Invoice__c"), listing("Account"), listing("Contact"), listing("AccountHistory"),
      listing("Hidden", { deprecatedAndHidden: true }), listing("NoQuery", { queryable: false }),
      listing("NoReplication", { replicateable: false }),
    ];
    f.deps.objects!.createSource = () => source;
    f.env.SYNC_ENTITY_DENY = "Contact";
    assert.equal(await f.run("objects", "available", "--json"), 0);
    assert.deepEqual(f.output(), [
      { name: "Account", label: "Label for Account", custom: false },
      { name: "Invoice__c", label: "Label for Invoice__c", custom: true },
    ]);
  });
});

test("metadata, projections and full accept per-run keys and legacy migration still warns", async (t) => {
  await withFixture(t, async (f) => {
    await f.seed(["Account"]);
    const warn = t.mock.method(console, "warn", () => {});
    assert.equal(await f.run("objects", "set", "Contact"), 0);
    assert.equal(await f.run("metadata", "--legacy-migrate", "--entities", "Account"), 0);
    assert.equal(await f.run("projections", "--entities", "Account"), 0);
    assert.equal(await f.run("full", "--entities", "Account"), 0);
    assert.equal(await f.run("records", "--entities", "Account", "--legacy-migrate"), 0);
    assert.deepEqual(f.ran, ["Account", "Account"]);
    assert.deepEqual(f.store.listPersistedEntityKeys(deploymentId), ["Account"]);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /migrate:metadata is deprecated/);
    assert.match(String(warn.mock.calls[1]?.arguments[0]), /migrate:records is deprecated/);
  });
});
