import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { runReplication } from "../src/core/orchestrator.js";
import type { CanonicalEntity, ChangeBatch } from "../src/core/source.js";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config, entity, FakeSource } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { describe, field } from "./helpers/salesforce-fixture.js";

class CountFixtureSource extends FakeSource {
  readonly counted: string[] = [];

  override async listEntities(): Promise<string[]> {
    return ["Account", "Contact", "Lead", "Case", "Account"];
  }

  override async describeEntity(key = entity.key): Promise<CanonicalEntity> {
    return { ...entity, key, label: key, pluralLabel: key };
  }

  override async *fetchChanges(definition = entity): AsyncGenerator<ChangeBatch> {
    if (definition.key === "Lead") return;
    yield {
      records: [{ sourceId: "active", fields: {} }, { sourceId: "deleted", fields: {}, isDeleted: true }],
      nextCheckpoint: "fixture-checkpoint",
    };
  }

  async countRecords(key: string): Promise<number> {
    this.counted.push(key);
    const counts = new Map([["Account", 1], ["Contact", 2], ["Lead", 0]]);
    assert.ok(counts.has(key), `Unexpected count request for ${key}`);
    return counts.get(key)!;
  }
}

const scope = { ...config, entityDenyKeys: ["Case"], buildWideViews: false };

async function seed(store: PostgresReplicaStore | InMemoryReplicaStore): Promise<void> {
  await store.ensureDeployment(scope.deploymentId, "Counts fixture");
  await runReplication({ config: scope, store, sourceClient: new CountFixtureSource() });
  await store.ensureDeployment("other", "Other deployment");
  await runReplication({
    config: { ...scope, deploymentId: "other", entityKeys: ["Account", "Case"], entityDenyKeys: [] },
    store, sourceClient: new CountFixtureSource(),
  });
}

async function seededDatabase(t: TestContext) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  await seed(store);
  return { store, prisma };
}

function depsFor(store: PostgresReplicaStore, source: CountFixtureSource): CliDeps {
  return {
    loadConfig: () => scope,
    createSource: () => source,
    createStore: () => store,
    ensureDeployment: store.ensureDeployment.bind(store),
    deploymentExists: store.deploymentExists.bind(store),
    hasEntityMetadata: store.hasEntityMetadata.bind(store),
    counts: { createStore: () => store, createSource: () => source },
  };
}

test("counts shows MATCH and DIFF in a table and expands wildcard through the source", async (t) => {
  const { store } = await seededDatabase(t);
  const source = new CountFixtureSource();
  const listEntities = t.mock.method(source, "listEntities");
  const logout = t.mock.method(source, "logout");
  const stdout = t.mock.method(console, "log", () => {});
  assert.deepEqual(await store.listPersistedEntityKeys(scope.deploymentId), ["Account", "Contact", "Lead"]);
  assert.deepEqual(await store.countRecords(scope.deploymentId), new Map([["Account", 1], ["Contact", 1], ["Lead", 0]]));
  assert.equal(await runCli(["counts"], depsFor(store, source)), 0);
  assert.equal(stdout.mock.callCount(), 1);
  const table = String(stdout.mock.calls[0]?.arguments[0]);
  assert.match(table, /^Entity\s+Store\s+Salesforce\s+Status/m);
  assert.match(table, /^Account\s+1\s+1\s+MATCH$/m);
  assert.match(table, /^Contact\s+1\s+2\s+DIFF$/m);
  assert.doesNotMatch(table, /Case/);
  assert.equal(listEntities.mock.callCount(), 1);
  assert.equal(logout.mock.callCount(), 1);
  assert.deepEqual(source.counted, ["Account", "Contact", "Lead"]);
});

test("counts prints JSON and --entities overrides wildcard while retaining the deny list", async (t) => {
  const { store } = await seededDatabase(t);
  const source = new CountFixtureSource();
  const listEntities = t.mock.method(source, "listEntities");
  const stdout = t.mock.method(console, "log", () => {});
  assert.equal(await runCli(["counts", "--entities", "Account, Contact, Case, Account", "--json"], depsFor(store, source)), 0);
  assert.equal(stdout.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(stdout.mock.calls[0]?.arguments[0])), [
    { entityKey: "Account", storeCount: 1, sourceCount: 1, status: "MATCH" },
    { entityKey: "Contact", storeCount: 1, sourceCount: 2, status: "DIFF" },
  ]);
  assert.equal(listEntities.mock.callCount(), 0);
  assert.deepEqual(source.counted, ["Account", "Contact"]);
});

test("counts --store-only works through production deps without SF variables", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-counts-"));
  try {
    const { prisma } = await seededDatabase(t);
    const env = {
      DATABASE_URL: "postgresql://unused/offline",
      REPLCRM_CONFIG_DIR: dir,
      DEPLOYMENT_ID: scope.deploymentId,
      SYNC_ENTITIES: "*",
      SYNC_ENTITY_DENY: "Contact",
    };
    const factory = t.mock.fn(() => prisma);
    const stdout = t.mock.method(console, "log", () => {});
    const stderr = t.mock.method(console, "error", () => {});
    assert.equal(await runCli(["counts", "--store-only"], createProductionDeps(env, { prisma: factory })), 0);
    const output = String(stdout.mock.calls[0]?.arguments[0]);
    assert.match(output, /^Account\s+1$/m);
    assert.match(output, /^Lead\s+0$/m);
    assert.doesNotMatch(output, /Contact|Case|Salesforce/);
    assert.equal(await runCli(["counts"], createProductionDeps(env, { prisma: factory })), 1);
    assert.match(String(stderr.mock.calls[0]?.arguments[0]), /Run auth login or set SF_USERNAME, SF_PASSWORD and SF_SECURITY_TOKEN/);
    assert.equal(factory.mock.callCount(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("counts --store-only reports an empty selection after applying the deny list", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-counts-"));
  try {
    const { prisma } = await seededDatabase(t);
    const deps = createProductionDeps({
      DATABASE_URL: "postgresql://unused/offline",
      REPLCRM_CONFIG_DIR: dir,
      DEPLOYMENT_ID: scope.deploymentId,
      SYNC_ENTITIES: "*",
      SYNC_ENTITY_DENY: "Account,Contact,Lead",
    }, { prisma: () => prisma });
    const stdout = t.mock.method(console, "log", () => {});
    const stderr = t.mock.method(console, "error", () => {});
    assert.equal(await runCli(["counts", "--store-only"], deps), 1);
    assert.match(String(stderr.mock.calls[0]?.arguments[0]), /No entities selected/);
    assert.equal(stdout.mock.callCount(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Salesforce count validates API names and uses query totalSize", async (t) => {
  const query = t.mock.fn(async (_soql: string, _options: { scanAll: boolean }) => ({ totalSize: 7, records: [] }));
  const source = new SourceClient({ mode: "oauth", instanceUrl: "https://example.invalid", accessToken: "fixture" });
  Object.assign(source, { connection: { query } });
  source.describeObject = async (key) => describe(key, [field("IsDeleted", "boolean")]);
  for (const key of ["*", "Contact.Name", "Account WHERE Name = 'X'"]) {
    await assert.rejects(source.countRecords(key), /Invalid Salesforce API name/);
  }
  assert.equal(query.mock.callCount(), 0);
  assert.equal(await source.countRecords("Custom__c"), 7);
  assert.deepEqual(query.mock.calls[0]?.arguments, ["SELECT COUNT() FROM Custom__c WHERE IsDeleted = false", { scanAll: true }]);
});

test("memory counts include empty entities and exclude deleted and other deployment records", async () => {
  const store = new InMemoryReplicaStore();
  await seed(store);
  assert.deepEqual(store.listPersistedEntityKeys(scope.deploymentId), ["Account", "Contact", "Lead"]);
  assert.deepEqual(store.countRecords(scope.deploymentId), new Map([["Account", 1], ["Contact", 1], ["Lead", 0]]));
  assert.deepEqual(store.countRecords("unknown"), new Map());
});
