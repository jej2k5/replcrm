import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Connection } from "jsforce";
import { createProductionDeps, runCli } from "../src/cli.js";
import { refreshLockPath } from "../src/cli-config-dir.js";
import { loadSourceAuth } from "../src/config.js";
import { FileTokenStore, type OAuthTokens } from "../src/sources/salesforce/auth/token-store.js";
import type { ConnectionFactory } from "../src/sources/salesforce/client.js";
import { database } from "./helpers/database.js";
import { describe, field } from "./helpers/salesforce-fixture.js";

const deploymentId = "oauth-fixture";
const tokens: OAuthTokens = {
  loginUrl: "https://login.example.invalid",
  instanceUrl: "https://instance.example.invalid",
  clientId: "fixture-client",
  accessToken: "fixture-access",
  refreshToken: "fixture-refresh",
  issuedAt: "100",
};
const passwords = {
  SF_USERNAME: "fixture-user", SF_PASSWORD: "fixture-password", SF_SECURITY_TOKEN: "fixture-security",
};
const nextAccessToken = "fixture-new-access";
const rotatedRefreshToken = "fixture-rotated-refresh";

async function withSignIn(run: (fixture: {
  env: NodeJS.ProcessEnv; store: FileTokenStore; dir: string;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-oauth-mode-"));
  try {
    const store = new FileTokenStore(dir);
    const env = {
      DEPLOYMENT_ID: deploymentId, REPLCRM_CONFIG_DIR: dir, SF_CLIENT_ID: tokens.clientId,
      SYNC_ENTITIES: "Account", BUILD_WIDE_VIEWS: "false",
    };
    await store.save(deploymentId, tokens);
    await run({ env, store, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const expired = () => Object.assign(new Error("Expired fixture session"), { errorCode: "INVALID_SESSION_ID" });
const noFetch: typeof fetch = async () => assert.fail("Unexpected token request");

function fakeFactory(onDescribe: (token: string | null | undefined) => void | Promise<void>): ConnectionFactory {
  return (options) => {
    assert.equal(options.instanceUrl, tokens.instanceUrl);
    assert.ok(options.accessToken);
    assert.equal(options.refreshToken, undefined);
    const connection = {
      instanceUrl: options.instanceUrl,
      accessToken: options.accessToken,
      async describeGlobal() {
        return { sobjects: [{
          name: "Account", label: "Account", keyPrefix: "001", custom: false, queryable: true,
          replicateable: true, deprecatedAndHidden: false, layoutable: true,
        }] };
      },
      sobject(name: string) {
        return {
          async describe() {
            assert.equal(name, "Account");
            await onDescribe(connection.accessToken);
            return describe(name, [field("Id", "id"), field("Name", "string"), field("SystemModstamp", "datetime")]);
          },
        };
      },
      async query(soql: string, options?: { scanAll: boolean }) {
        assert.match(soql, /FROM Account/);
        assert.equal(options?.scanAll, true);
        return {
          done: true, totalSize: 1,
          records: [{ Id: "fixture-account", Name: "Fixture", SystemModstamp: "2026-01-01T00:00:00Z" }],
        };
      },
      async queryMore(): Promise<never> { assert.fail("Unexpected query page"); },
      async identity() {
        return { organization_id: "fixture-org", user_id: "fixture-user", username: "fixture-user" };
      },
      async login(): Promise<never> { assert.fail("Unexpected password login"); },
    };
    return connection;
  };
}

function refreshedResponse(refreshToken?: string): Response {
  return Response.json({
    access_token: nextAccessToken, refresh_token: refreshToken, instance_url: tokens.instanceUrl, issued_at: "200",
  });
}

function refreshForm(input: Parameters<typeof fetch>[0], init?: RequestInit): URLSearchParams {
  assert.equal(String(input), tokens.loginUrl + "/services/oauth2/token");
  assert.equal(init?.method, "POST");
  assert.ok(init.body instanceof URLSearchParams);
  assert.equal(init.body.get("grant_type"), "refresh_token");
  assert.equal(init.body.get("client_id"), tokens.clientId);
  assert.equal(init.body.has("client_secret"), false);
  return init.body;
}

test("SF_AUTH_MODE resolves stored OAuth, password and missing settings", async () => {
  await withSignIn(async ({ env, store }) => {
    assert.equal((await loadSourceAuth({ ...env, ...passwords }, store)).mode, "oauth");
    assert.equal((await loadSourceAuth({ ...env, ...passwords, SF_AUTH_MODE: "password" }, store)).mode, "password");
    await assert.rejects(loadSourceAuth({ DEPLOYMENT_ID: deploymentId, SF_AUTH_MODE: "oauth" }, store), /SF_CLIENT_ID/);
    await store.clear(deploymentId);
    assert.equal((await loadSourceAuth({ ...env, ...passwords }, store)).mode, "password");
    await assert.rejects(loadSourceAuth({ ...env, ...passwords, SF_AUTH_MODE: "oauth" }, store), /No stored.*sign-in/);
    await assert.rejects(loadSourceAuth(env, store), /Run auth login or set SF_USERNAME, SF_PASSWORD and SF_SECURITY_TOKEN/);
    await assert.rejects(loadSourceAuth({ ...env, SF_AUTH_MODE: "other" }, store), /SF_AUTH_MODE/);
  });
});

test("production constructs a real jsforce connection with stored OAuth tokens", async () => {
  await withSignIn(async ({ env, dir }) => {
    const { REPLCRM_CONFIG_DIR: _, ...defaultDirEnv } = env;
    const configDir = join(dir, ".config", "replcrm");
    await new FileTokenStore(configDir).save(deploymentId, tokens);
    const source = await createProductionDeps(defaultDirEnv, { fetch: noFetch, homedir: () => dir }).createSource();
    await source.connect();
    const connection = source["connection"];
    assert.ok(connection instanceof Connection);
    assert.equal(connection.instanceUrl, tokens.instanceUrl);
    assert.equal(connection.accessToken, tokens.accessToken);
  });
});

async function runRecords(
  t: TestContext,
  env: NodeJS.ProcessEnv,
  options: { connectionFactory: ConnectionFactory; fetch: typeof fetch },
  expectedExit = 0,
): Promise<void> {
  const { db, prisma } = await database();
  try {
    const deps = () => createProductionDeps(env, { prisma: () => prisma, ...options });
    await deps().ensureDeployment(deploymentId, "OAuth fixture");
    assert.equal(await runCli(["metadata"], deps()), 0);
    const stderr = t.mock.method(console, "error", () => {});
    assert.equal(await runCli(["records"], deps()), expectedExit,
      stderr.mock.calls.map((call) => String(call.arguments[0])).join("\n"));
    if (expectedExit === 0) {
      const records = await prisma.record.findMany({ where: { deploymentId } });
      assert.deepEqual(records.map((record) => record.sourceId), ["fixture-account"]);
    } else {
      assert.match(String(stderr.mock.calls[0]?.arguments[0]), /Run auth login again/);
      assert.equal((await prisma.record.findMany()).length, 0);
    }
  } finally {
    await db.close();
  }
}

test("metadata and records run through production with OAuth and no password variables", async (t) => {
  await withSignIn(async ({ env }) => {
    const observed: unknown[] = [];
    await runRecords(t, env, { fetch: noFetch, connectionFactory: fakeFactory((token) => { observed.push(token); }) });
    assert.deepEqual(observed, [tokens.accessToken, tokens.accessToken]);
  });
});

test("records retries an expired object describe and persists the kept refresh token", async (t) => {
  await withSignIn(async ({ env, store, dir }) => {
    const observed: unknown[] = [];
    const fetch = t.mock.fn<typeof globalThis.fetch>(async (input, init) => {
      assert.equal(refreshForm(input, init).get("refresh_token"), tokens.refreshToken);
      await stat(refreshLockPath(dir, deploymentId));
      return refreshedResponse();
    });
    await runRecords(t, env, {
      fetch,
      connectionFactory: fakeFactory((token) => {
        observed.push(token);
        if (observed.length === 2) throw expired();
      }),
    });
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(observed, [tokens.accessToken, tokens.accessToken, nextAccessToken]);
    assert.deepEqual(await store.load(deploymentId), { ...tokens, accessToken: nextAccessToken, issuedAt: "200" });
  });
});

test("records reports a revoked grant even with password credentials configured", async (t) => {
  await withSignIn(async ({ env, store }) => {
    let descriptions = 0;
    const fetch = t.mock.fn<typeof globalThis.fetch>(async (input, init) => {
      assert.equal(refreshForm(input, init).get("refresh_token"), tokens.refreshToken);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await runRecords(t, { ...env, ...passwords }, {
      fetch, connectionFactory: fakeFactory(() => { if (++descriptions === 2) throw expired(); }),
    }, 1);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(descriptions, 2);
    assert.deepEqual(await store.load(deploymentId), tokens);
  });
});

async function concurrentRefresh(t: TestContext, separateMutexes: boolean): Promise<void> {
  await withSignIn(async ({ env, store, dir }) => {
    let releaseDescriptions!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseDescriptions = resolve; });
    let releaseFetch!: () => void;
    const fileContender = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let starts = 0;
    let refreshUsed = false;
    const retries: string[] = [];
    const fetch = t.mock.fn<typeof globalThis.fetch>(async (input, init) => {
      if (refreshForm(input, init).get("refresh_token") !== tokens.refreshToken || refreshUsed) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      refreshUsed = true;
      if (separateMutexes) await fileContender;
      return refreshedResponse(rotatedRefreshToken);
    });
    const connectionFactory = fakeFactory(async (token) => {
      if (token === tokens.accessToken) {
        if (++starts === 2) releaseDescriptions();
        await bothStarted;
        throw expired();
      }
      assert.equal(token, nextAccessToken);
      retries.push(token);
    });
    const makeSource = () => createProductionDeps(env, {
      fetch, connectionFactory,
      ...(separateMutexes ? {
        refreshMutex: new Map<string, Promise<void>>(),
        now: () => {
          if (refreshUsed) releaseFetch();
          return new Date();
        },
      } : {}),
    }).createSource();
    const sources = await Promise.all([makeSource(), makeSource()]);
    const results = await Promise.all(sources.map((source) => source.describeObject("Account")));
    assert.deepEqual(results.map(({ name }) => name), ["Account", "Account"]);
    assert.deepEqual(retries, [nextAccessToken, nextAccessToken]);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal((await store.load(deploymentId))?.refreshToken, rotatedRefreshToken);
    await assert.rejects(stat(refreshLockPath(dir, deploymentId)), { code: "ENOENT" });
  });
}

test("concurrent descriptions share one refresh with a rotating grant", { timeout: 5000 }, async (t) => {
  await concurrentRefresh(t, false);
});

test("concurrent descriptions with separate mutexes serialize via the lock file", { timeout: 5000 }, async (t) => {
  await concurrentRefresh(t, true);
});

test("refresh reloads the sign-in under lock and never recreates cleared credentials", async () => {
  await withSignIn(async ({ env, store }) => {
    const seen: unknown[] = [];
    const connectionFactory = fakeFactory((token) => {
      seen.push(token);
      if (token === tokens.accessToken) throw Object.assign(new Error("Expired"), { statusCode: 401 });
    });
    const deps = createProductionDeps(env, { connectionFactory, fetch: noFetch });
    const [stale, cleared] = await Promise.all([deps.createSource(), deps.createSource()]);
    await store.save(deploymentId, { ...tokens, accessToken: nextAccessToken });
    assert.equal((await stale.describeObject("Account")).name, "Account");
    await store.clear(deploymentId);
    await assert.rejects(cleared.describeObject("Account"), /Run auth login again/);
    assert.equal(await store.load(deploymentId), undefined);
    assert.deepEqual(seen, [tokens.accessToken, nextAccessToken, tokens.accessToken]);
  });
});
