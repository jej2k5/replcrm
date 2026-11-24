import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { writableAttributes } from "../src/writeback/index.js";
import { database } from "./helpers/database.js";
import { account, accountDescribe, contact, deployment } from "./helpers/writeback.js";

const attr = (key: string) => account.attributes.find((item) => item.key === key)!;
const enabled = { enabled: true, excludedAttributeKeys: [] };

async function memory() {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(deployment, [account, contact]);
  return store;
}

async function cli(t: TestContext) {
  const store = await memory();
  const deps = createProductionDeps({ DEPLOYMENT_ID: deployment }, {
    prisma: () => assert.fail("Unexpected database access"), homedir: () => assert.fail("Unexpected home directory access"),
  });
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});
  return {
    store, run: (...args: string[]) => runCli(["writeback", ...args], { ...deps, createWritebackStore: () => store }),
    output: () => String(stdout.mock.calls.at(-1)?.arguments[0]),
    error: () => String(stderr.mock.calls.at(-1)?.arguments[0]),
  };
}

test("the source client preserves all capabilities from the connection describe", async () => {
  const client = new SourceClient({ mode: "oauth", instanceUrl: "https://fixture.invalid", accessToken: "fixture-access" }, {
    connectionFactory: () => ({
      instanceUrl: "https://fixture.invalid",
      identity: async () => assert.fail("Unexpected identity lookup"),
      describeGlobal: async () => ({ sobjects: [] }),
      sobject: () => ({ describe: async () => accountDescribe }),
      query: async () => assert.fail("Unexpected query"),
      queryMore: async () => assert.fail("Unexpected query"),
    }),
  });
  const mapped = new Map((await client.describeEntity("Account")).attributes.map((field) => [field.key, field]));
  assert.equal(mapped.get("Score")?.isUpdatable, true);
  assert.equal(mapped.get("Score")?.isCreatable, false);
  assert.equal(mapped.get("Name")?.isNullable, false);
  assert.equal(mapped.get("Origin")?.isUpdatable, false);
  assert.equal(mapped.get("Origin")?.hasCreateDefault, true);
  assert.equal(mapped.get("Total")?.isCreatable, false);
  assert.equal(mapped.get("SystemModstamp")?.isSystem, true);
});

test("describe identifies system fields and disables computed capabilities", () => {
  assert.equal(attr("SystemModstamp").isSystem, true);
  assert.equal(attr("Id").isSystem, true);
  assert.equal(attr("Total").isUpdatable, false);
  assert.equal(attr("Total").isCreatable, false);
});

test("memory persists flags and defaults missing capabilities on older metadata", async () => {
  const store = await memory();
  assert.deepEqual(store.readEntity(deployment, "Account")?.attributes.find(({ key }) => key === "Origin"), attr("Origin"));
  await store.persistMetadata(deployment, [{ ...contact, attributes: [{ key: "Legacy", label: "Legacy", dataType: "Text" }] }]);
  const legacy = store.readEntity(deployment, "Contact")?.attributes.find(({ key }) => key === "Legacy");
  assert.deepEqual([legacy?.isUpdatable, legacy?.isCreatable, legacy?.isNullable, legacy?.hasCreateDefault], [false, false, false, false]);
});

test("migration defaults older fields and PostgreSQL persists refreshed capabilities", async () => {
  const { db, prisma } = await database(async (old) => {
    await old.exec(`
      INSERT INTO "Deployment" (id, name, "updatedAt") VALUES ('legacy', 'Legacy', now());
      INSERT INTO "EntityDefinition" (id, "deploymentId", key, label, "pluralLabel", "updatedAt")
        VALUES ('legacy-entity', 'legacy', 'Account', 'Account', 'Accounts', now());
      INSERT INTO "AttributeDefinition" (id, "entityDefinitionId", key, label, "dataType", "updatedAt")
        VALUES ('legacy-attr', 'legacy-entity', 'Score', 'Score', 'Number', now());
    `);
  });
  try {
    const store = new PostgresReplicaStore(prisma);
    const capabilities = async (key: string) => {
      const field = (await store.readEntity("legacy", "Account"))?.attributes.find((item) => item.key === key);
      return [field?.isUpdatable, field?.isCreatable, field?.isNullable, field?.hasCreateDefault, field?.isSystem];
    };
    assert.deepEqual(await capabilities("Score"), [false, false, false, false, false]);
    await store.persistMetadata("legacy", [account]);
    assert.deepEqual(await capabilities("Score"), [true, false, true, false, false]);
    assert.deepEqual(await capabilities("Origin"), [false, true, false, true, false]);
    assert.deepEqual(await capabilities("SystemModstamp"), [true, true, true, false, true]);
  } finally {
    await db.close();
  }
});

test("update filters system, computed, housekeeping and excluded fields", () => {
  const entity = { ...account, attributes: account.attributes.map((item) => item.key === "Total" ? { ...item, isUpdatable: true } : item) };
  assert.deepEqual(writableAttributes(entity, enabled, "update"), ["Name", "Score"]);
  assert.deepEqual(writableAttributes(entity, { ...enabled, excludedAttributeKeys: ["Score"] }, "update"), ["Name"]);
});

test("create uses its own flags and disabled objects expose no fields", () => {
  assert.deepEqual(writableAttributes(account, enabled, "create"), ["Name", "Origin"]);
  assert.deepEqual(writableAttributes(account, { ...enabled, enabled: false }, "create"), []);
});

test("memory defaults to off and policy edits are deployment and object scoped", async () => {
  const store = await memory();
  await store.persistMetadata("other", [account]);
  const off = { enabled: false, excludedAttributeKeys: [] };
  assert.deepEqual(await store.getWritebackPolicy(deployment, "Account"), off);
  await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
  assert.deepEqual(await store.editWritebackPolicy(deployment, "Account", { action: "exclude", keys: ["Score", "Score"] }), {
    ...enabled, excludedAttributeKeys: ["Score"],
  });
  assert.deepEqual(await store.getWritebackPolicy("other", "Account"), off);
  assert.deepEqual(await store.getWritebackPolicy(deployment, "Contact"), off);
  await store.editWritebackPolicy(deployment, "Account", { action: "disable" });
  assert.deepEqual(await store.editWritebackPolicy(deployment, "Account", { action: "include", keys: ["Score"] }), off);
});

test("PostgreSQL round-trips policy edits and concurrent exclusions", async () => {
  const { db, prisma } = await database();
  try {
    const store = new PostgresReplicaStore(prisma);
    await store.ensureDeployment(deployment, deployment);
    await store.persistMetadata(deployment, [account, contact]);
    assert.equal((await store.getWritebackPolicy(deployment, "Account")).enabled, false);
    await store.editWritebackPolicy(deployment, "Account", { action: "enable" });
    await Promise.all(["Name", "Score"].map((key) => store.editWritebackPolicy(deployment, "Account", { action: "exclude", keys: [key] })));
    assert.deepEqual(await new PostgresReplicaStore(prisma).getWritebackPolicy(deployment, "Account"), {
      enabled: true, excludedAttributeKeys: ["Name", "Score"],
    });
    assert.deepEqual(await store.editWritebackPolicy(deployment, "Account", { action: "disable" }), { enabled: false, excludedAttributeKeys: ["Name", "Score"] });
    await store.editWritebackPolicy(deployment, "Account", { action: "include", keys: ["Name", "Score"] });
    assert.deepEqual(await store.getWritebackPolicy(deployment, "Account"), await store.getWritebackPolicy(deployment, "Contact"));
  } finally {
    await db.close();
  }
});

test("CLI edits and prints the current policy", async (t) => {
  const f = await cli(t);
  assert.equal(await f.run("enable", "Account"), 0);
  assert.match(f.output(), /Account: enabled/);
  assert.equal(await f.run("exclude", "Account", "Score", "Origin"), 0);
  assert.match(f.output(), /Origin, Score/);
  assert.equal(await f.run("include", "Account", "Score"), 0);
  assert.equal(await f.run("disable", "Account"), 0);
  assert.equal(await f.run("status"), 0);
  assert.match(f.output(), /Account\tdisabled\tOrigin/);
});

test("CLI refuses unknown canonical keys without partially altering policy", async (t) => {
  const f = await cli(t);
  assert.equal(await f.run("enable", "account"), 1);
  assert.match(f.error(), /Unknown object: account.*Account, Contact/);
  assert.equal(await f.run("exclude", "Account", "Name", "bogus"), 1);
  assert.match(f.error(), /Unknown field: bogus.*Name/);
  assert.deepEqual((await f.store.getWritebackPolicy(deployment, "Account")).excludedAttributeKeys, []);
});

test("CLI status JSON identifies the deployment and lists every persisted object", async (t) => {
  const f = await cli(t);
  assert.equal(await f.run("enable", "Contact"), 0);
  assert.equal(await f.run("status", "--json"), 0);
  assert.deepEqual(JSON.parse(f.output()), {
    deploymentId: deployment,
    objects: [
      { entityKey: "Account", enabled: false, excludedAttributeKeys: [] },
      { entityKey: "Contact", enabled: true, excludedAttributeKeys: [] },
    ],
  });
});
