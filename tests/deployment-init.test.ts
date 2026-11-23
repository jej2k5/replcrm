import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";

function unexpected(): never {
  assert.fail("Unexpected CLI dependency");
}

function noReplicationDeps(store: InMemoryReplicaStore | PostgresReplicaStore): CliDeps {
  return {
    loadConfig: unexpected,
    createSource: unexpected,
    createStore: unexpected,
    hasEntityMetadata: unexpected,
    ensureDeployment: store.ensureDeployment.bind(store),
    deploymentExists: store.deploymentExists.bind(store),
  };
}

test("deployment init creates the requested deployment in memory and can be repeated", async () => {
  const store = new InMemoryReplicaStore();
  const deps = noReplicationDeps(store);
  assert.equal(store.deploymentExists("x"), false);
  const args = ["deployment", "init", "--id", "x", "--name", "X"];
  assert.equal(await runCli(args, deps), 0);
  assert.equal(await runCli(args, deps), 0);
  assert.equal(store.deploymentExists("x"), true);
  assert.equal(store.deploymentExists("other"), false);
});

test("Postgres deployment init preserves the original row on repeat", async (t) => {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const store = new PostgresReplicaStore(prisma);
  const deps = noReplicationDeps(store);
  assert.equal(await store.deploymentExists("x"), false);
  assert.equal(await runCli([
    "deployment", "init", "--id", "x", "--name", "X", "--source-url", "https://example.invalid",
  ], deps), 0);
  const original = await prisma.deployment.findMany();
  assert.equal(original.length, 1);
  assert.equal(original[0]?.name, "X");
  assert.equal(original[0]?.sourceUrl, "https://example.invalid");
  assert.equal(await store.deploymentExists("x"), true);
  assert.equal(await runCli(["deployment", "init", "--id", "x", "--name", "Different"], deps), 0);
  assert.deepEqual(await prisma.deployment.findMany(), original);
});

test("deployment init rejects missing or incomplete required flags with usage", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const deps = { ...noReplicationDeps(new InMemoryReplicaStore()), ensureDeployment: unexpected };
  for (const flags of [["--id", "x"], ["--name", "X"], ["--id", "x", "--name"]]) {
    assert.equal(await runCli(["deployment", "init", ...flags], deps), 1);
    assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /Usage:.*deployment init --id.*--name/);
  }
});

async function checkMissingDeployment(t: TestContext, store: InMemoryReplicaStore | PostgresReplicaStore): Promise<void> {
  const error = t.mock.method(console, "error", () => {});
  const probe = t.mock.method(store, "deploymentExists");
  const deps = { ...noReplicationDeps(store), loadConfig: () => config, ensureDeployment: unexpected };
  for (const argv of [[], ["full"], ["metadata"], ["users"], ["records"], ["projections"]]) {
    assert.equal(await runCli(argv, deps), 1);
    assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /missing.*deployment init/);
  }
  assert.deepEqual(probe.mock.calls.map(({ arguments: args }) => args), Array.from(
    { length: 6 }, () => [config.deploymentId],
  ));
}

test("replication refuses a missing deployment in memory", async (t) => {
  const store = new InMemoryReplicaStore();
  await checkMissingDeployment(t, store);
  assert.equal(store.deploymentExists(config.deploymentId), false);
});

test("replication refuses a missing deployment in Postgres", async (t) => {
  const { db, prisma } = await database();
  t.after(() => db.close());
  await checkMissingDeployment(t, new PostgresReplicaStore(prisma));
  assert.deepEqual(await prisma.deployment.findMany(), []);
});

test("deployment init works through production deps with only DATABASE_URL", async (t) => {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const env = { DATABASE_URL: "postgresql://unused/offline" };
  const factory = t.mock.fn(() => prisma);
  const error = t.mock.method(console, "error", () => {});
  const deps = createProductionDeps(env, { prisma: factory });
  assert.equal(await runCli(["deployment", "init", "--id", "x", "--name", "X"], deps), 0);
  const rows = await prisma.deployment.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, "x");
  assert.equal(rows[0]?.name, "X");
  assert.equal(await runCli(["full"], deps), 1);
  assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /Missing required env var: DEPLOYMENT_ID/);
  assert.equal(factory.mock.callCount(), 1);

  const replicationDeps = createProductionDeps({ ...env, DEPLOYMENT_ID: "x" }, { prisma: factory });
  assert.equal(await runCli(["full", "--entities", "Account"], replicationDeps), 1);
  assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /Run auth login or set SF_USERNAME, SF_PASSWORD and SF_SECURITY_TOKEN/);
  assert.deepEqual(await prisma.deployment.findMany(), rows);
});
