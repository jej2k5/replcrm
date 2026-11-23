import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import { readPrivateJson, resolveConfigDir } from "../src/cli-config-dir.js";
import { loadBinding } from "../src/cli-verify.js";
import { readSalesforceIdentity, SourceClient } from "../src/sources/salesforce/client.js";

const identity = {
  organizationId: "fixture-org", userId: "fixture-user", username: "fixture-username",
  instanceUrl: "https://fixture.example.test",
};
const env = {
  DATABASE_URL: "fixture-db", DEPLOYMENT_ID: "fixture-deployment",
  SF_USERNAME: "fixture-username", SF_PASSWORD: "fixture-password", SF_SECURITY_TOKEN: "fixture-token",
};

async function inTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "replcrm-verify-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function setup(t: TestContext, configDir: string, overrides: NodeJS.ProcessEnv = {}) {
  const deps = createProductionDeps({ ...env, ...overrides }, {
    prisma: () => assert.fail("Unexpected database connection"),
  });
  assert.ok(deps.verify);
  const output: string[] = [];
  let liveIdentity = identity;
  let identityCalls = 0;
  deps.deploymentExists = () => true;
  deps.verify.configDir = () => configDir;
  deps.verify.writeOutput = (message) => output.push(message);
  deps.verify.createSource = () => new SourceClient({
    mode: "oauth", instanceUrl: identity.instanceUrl, accessToken: "fixture-access",
  }, {
    identity: async () => {
      identityCalls++;
      return liveIdentity;
    },
  });
  const errors = t.mock.method(console, "error", () => {});
  return {
    deps, output, errors, identityCalls: () => identityCalls,
    setIdentity: (value: typeof identity) => { liveIdentity = value; },
    run: (...args: string[]) => runCli(["deployment", "verify", ...args], deps),
    path: join(configDir, "bindings", `${env.DEPLOYMENT_ID}.json`),
  };
}

test("writes a private binding and prints the live identity as JSON", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir);
    assert.equal(await cli.run("--json"), 0);
    const binding = await loadBinding(dir, env.DEPLOYMENT_ID);
    assert.ok(binding);
    assert.deepEqual(binding, {
      version: 1, organizationId: identity.organizationId, userId: identity.userId,
      username: identity.username, instanceHost: "fixture.example.test", verifiedAt: binding.verifiedAt,
    });
    assert.equal(new Date(binding.verifiedAt).toISOString(), binding.verifiedAt);
    assert.deepEqual(JSON.parse(cli.output[0]!), binding);
    assert.equal((await stat(join(dir, "bindings"))).mode & 0o777, 0o700);
    assert.equal((await stat(cli.path)).mode & 0o777, 0o600);
    assert.equal(cli.identityCalls(), 1);
  });
});

test("refreshes the same binding and requires --rebind for a different org or user", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir);
    assert.equal(await cli.run(), 0);
    const binding = await loadBinding(dir, env.DEPLOYMENT_ID);
    assert.ok(binding);
    const oldTimestamp = "2000-01-01T00:00:00.000Z";
    await writeFile(cli.path, JSON.stringify({ ...binding, verifiedAt: oldTimestamp }));
    assert.equal(await cli.run(), 0);
    assert.notEqual((await loadBinding(dir, env.DEPLOYMENT_ID))?.verifiedAt, oldTimestamp);
    const refreshed = await readFile(cli.path, "utf8");
    for (const changed of [
      { ...identity, organizationId: "fixture-other-org" },
      { ...identity, userId: "fixture-other-user" },
    ]) {
      cli.setIdentity(changed);
      assert.equal(await cli.run(), 1);
      const error = String(cli.errors.mock.calls.at(-1)?.arguments[0]);
      assert.ok(error.includes(`org ${identity.organizationId}, user ${identity.userId}`));
      assert.ok(error.includes(`org ${changed.organizationId}, user ${changed.userId}`));
      assert.equal(await readFile(cli.path, "utf8"), refreshed);
    }
    assert.equal(await cli.run("--rebind"), 0);
    assert.equal((await loadBinding(dir, env.DEPLOYMENT_ID))?.userId, "fixture-other-user");
    assert.deepEqual(await readdir(join(dir, "bindings")), [`${env.DEPLOYMENT_ID}.json`]);
  });
});

test("rejects an unsafe deployment ID before querying or writing", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir, { DEPLOYMENT_ID: "../x" });
    cli.deps.deploymentExists = () => assert.fail("Unexpected deployment lookup");
    assert.equal(await cli.run(), 1);
    assert.match(String(cli.errors.mock.calls[0]?.arguments[0]), /\.\.\/x/);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(cli.identityCalls(), 0);
  });
});

test("validates the database URL and Salesforce variables before any network call", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir, Object.fromEntries(
      ["DATABASE_URL", "SF_USERNAME", "SF_PASSWORD", "SF_SECURITY_TOKEN"].map((key) => [key, ""]),
    ));
    cli.deps.deploymentExists = () => assert.fail("Unexpected deployment lookup");
    assert.equal(await cli.run(), 1);
    assert.match(String(cli.errors.mock.calls[0]?.arguments[0]), /DATABASE_URL/);
    const missingSf = setup(t, dir, { SF_USERNAME: undefined, SF_PASSWORD: undefined, SF_SECURITY_TOKEN: undefined });
    missingSf.deps.deploymentExists = cli.deps.deploymentExists;
    assert.equal(await missingSf.run(), 1);
    assert.match(String(missingSf.errors.mock.calls.at(-1)?.arguments[0]), /SF_USERNAME/);
    assert.equal(missingSf.identityCalls(), 0);
  });
});

test("requires an existing deployment before requesting the identity", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir);
    cli.deps.deploymentExists = (id) => {
      assert.equal(id, env.DEPLOYMENT_ID);
      return false;
    };
    assert.equal(await cli.run(), 1);
    assert.match(String(cli.errors.mock.calls[0]?.arguments[0]), /deployment init/);
    assert.equal(cli.identityCalls(), 0);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("maps the default jsforce identity response and current instance URL", async () => {
  assert.deepEqual(await readSalesforceIdentity({
    instanceUrl: identity.instanceUrl,
    identity: async () => ({
      organization_id: identity.organizationId, user_id: identity.userId, username: identity.username,
    }),
  }), identity);
});

test("keeps credential fixture values out of terminal output and the binding", async (t) => {
  await inTempDir(async (dir) => {
    const cli = setup(t, dir);
    assert.equal(await cli.run(), 0);
    const contents = cli.output.join("\n") + await readFile(cli.path, "utf8");
    assert.ok(cli.output[0]?.includes(identity.username));
    for (const secret of [env.SF_PASSWORD, env.SF_SECURITY_TOKEN, "fixture-access"]) {
      assert.ok(!contents.includes(secret));
    }
  });
});

test("resolves config overrides and refuses readable or malformed JSON by path", async () => {
  await inTempDir(async (dir) => {
    assert.equal(resolveConfigDir({ REPLCRM_CONFIG_DIR: dir }, "/fixture-home"), dir);
    assert.equal(resolveConfigDir({}, "/fixture-home"), "/fixture-home/.config/replcrm");
    const path = join(dir, "test.json");
    assert.equal(await readPrivateJson(path), undefined);
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(readPrivateJson(path), (error: Error) => error.message.includes(path));
    await chmod(path, 0o600);
    await writeFile(path, "{");
    await assert.rejects(readPrivateJson(path), (error: Error) => error.message.includes(path));
  });
});
