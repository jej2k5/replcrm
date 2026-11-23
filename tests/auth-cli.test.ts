import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import type { AuthDeps } from "../src/cli-auth.js";
import { refreshLockPath } from "../src/cli-config-dir.js";
import { acquireLock } from "../src/locks/file-lock.js";
import { FileTokenStore, type OAuthTokens } from "../src/sources/salesforce/auth/token-store.js";

const saved: OAuthTokens = {
  loginUrl: "https://login.example.test", instanceUrl: "https://instance.example.test",
  clientId: "fixture-client", accessToken: "fixture-access", refreshToken: "fixture-refresh", issuedAt: "100",
};
const rotated = { ...saved, accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh", issuedAt: "200" };
function tokenResponse() {
  return Response.json({
    access_token: rotated.accessToken, refresh_token: rotated.refreshToken,
    instance_url: rotated.instanceUrl, issued_at: rotated.issuedAt,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(directory: string) {
  const store = new FileTokenStore(directory);
  const env = { DEPLOYMENT_ID: "example", SF_CLIENT_ID: saved.clientId, SF_LOGIN_URL: saved.loginUrl,
    SF_OAUTH_CALLBACK_PORT: "48231", REPLCRM_CONFIG_DIR: directory };
  const out: string[] = [];
  const err: string[] = [];
  const binds: Parameters<AuthDeps["listen"]>[0][] = [];
  const closed: string[] = [];
  const opened = deferred<URL>();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let time = 0;
  const ctx = {
    ipv6: true, ipv4: true, respond: (): Response | Promise<Response> => tokenResponse(),
    expire: () => assert.fail("Missing timeout") as void, store, env, out, err, binds, closed, opened, requests,
    run: (...args: string[]) => runCli(["auth", ...args], deps),
    async callback(params: Record<string, string> = { code: "fixture-code" }, host = "localhost:48231", path = "/oauth/callback") {
      const url = await opened.promise;
      const query = new URLSearchParams({ state: url.searchParams.get("state")!, ...params });
      return binds[0]!.handler("GET", path + "?" + query, { host });
    },
  };
  const deps = createProductionDeps(env, {
    prisma: () => assert.fail("Auth must not open the database"),
    now: () => new Date(Date.now() + time), refreshWaitMs: 20, refreshMutex: new Map(),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return ctx.respond();
    },
    auth: {
      listen: (options) => {
        binds.push(options);
        if (options.host === "::1" ? !ctx.ipv6 : !ctx.ipv4) throw new Error("Bind failed.");
        return { close: () => { closed.push(options.host); } };
      },
      openBrowser: (url) => opened.resolve(new URL(url)),
      scheduleTimeout: (callback, ms) => {
        assert.ok(ms > 0 && ms <= 300_000);
        ctx.expire = () => { time += ms; callback(); };
        return () => {};
      },
      stdout: (message) => { out.push(message); },
      stderr: (message) => { err.push(message); },
    },
  });
  return ctx;
}

function withFixture(run: (ctx: ReturnType<typeof fixture>) => Promise<void>) {
  return async () => {
    const directory = await mkdtemp(join(tmpdir(), "replcrm-auth-test-"));
    try {
      await run(fixture(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test("callback URL and both loopback listeners use the same redirect", withFixture(async (ctx) => {
  assert.equal(await ctx.run("callback-url"), 0);
  const redirect = ctx.out[0];
  assert.equal(redirect, "http://localhost:48231/oauth/callback");
  const login = ctx.run("login", "--login-url", "https://sandbox.example.test");
  const authorization = await ctx.opened.promise;
  assert.equal(authorization.origin, "https://sandbox.example.test");
  assert.equal(authorization.searchParams.get("redirect_uri"), redirect);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(ctx.binds.map(({ host, port }) => [host, port]), [["127.0.0.1", 48231], ["::1", 48231]]);
  assert.equal(ctx.binds[0]?.handler, ctx.binds[1]?.handler);
  const page = await ctx.callback();
  assert.equal(page.status, 200);
  assert.match(page.body, /Signed in to instance\.example\.test\. You can close this tab\./);
  assert.doesNotMatch(page.body, /fixture-/);
  assert.equal(await login, 0);
  assert.deepEqual(ctx.closed, ["127.0.0.1", "::1"]);
  assert.deepEqual(await ctx.store.load("example"), { ...rotated, loginUrl: authorization.origin });
  const request = ctx.requests[0]!;
  assert.equal(request.url, "https://sandbox.example.test/services/oauth2/token");
  const body = request.init?.body as URLSearchParams;
  assert.equal(body.get("redirect_uri"), redirect);
  assert.equal(body.get("grant_type"), "authorization_code");
}));

test("IPv6 failure leaves IPv4 available", withFixture(async (ctx) => {
  ctx.ipv6 = false;
  const login = ctx.run("login");
  assert.equal((await ctx.callback()).status, 200);
  assert.equal(await login, 0);
  assert.deepEqual(ctx.closed, ["127.0.0.1"]);
  assert.match(ctx.err.join(), /IPv6/);
}));

test("IPv4 failure stops login before a second bind", withFixture(async (ctx) => {
  ctx.ipv4 = false;
  assert.equal(await ctx.run("login"), 1);
  assert.equal(ctx.binds.length, 1);
  assert.equal(ctx.out.length, 0);
}));

test("wrong or missing state leaves the callback waiting", withFixture(async (ctx) => {
  const login = ctx.run("login");
  assert.equal((await ctx.callback({ state: "wrong", code: "fixture-code" })).status, 400);
  assert.equal((await ctx.binds[0]!.handler("GET", "/oauth/callback?code=fixture-code", {host: "localhost:48231"})).status, 400);
  assert.equal(ctx.requests.length, 0);
  assert.equal(await ctx.store.load("example"), undefined);
  assert.equal((await ctx.callback()).status, 200);
  assert.equal(await login, 0);
}));

function checkCallbackHost(host: string) {
  return withFixture(async (ctx) => {
    const login = ctx.run("login");
    assert.equal((await ctx.callback(undefined, "other.example.test:48231")).status, 400);
    assert.equal((await ctx.callback(undefined, host, "/other")).status, 404);
    assert.equal((await ctx.callback(undefined, host)).status, 200);
    assert.equal(await login, 0);
  });
}

test("callback host and path validation with localhost", checkCallbackHost("localhost:48231"));
test("callback host and path validation with IPv4 loopback", checkCallbackHost("127.0.0.1:48231"));
test("callback host and path validation with IPv6 loopback", checkCallbackHost("[::1]:48231"));

test("denied authorization returns an error page and saves nothing", withFixture(async (ctx) => {
  const login = ctx.run("login");
  const page = await ctx.callback({ error: "access_denied" });
  assert.match(page.body, /access_denied/);
  assert.equal(await login, 1);
  assert.equal(await ctx.store.load("example"), undefined);
  assert.equal(ctx.requests.length, 0);
}));

test("timeout closes both listeners", withFixture(async (ctx) => {
  const login = ctx.run("login");
  await ctx.opened.promise;
  ctx.expire();
  assert.equal(await login, 1);
  assert.deepEqual(ctx.closed, ["127.0.0.1", "::1"]);
  assert.match(ctx.err.join(), /timed out/);
}));

test("status reports auto resolution and sign-in metadata without token values", withFixture(async (ctx) => {
  await ctx.store.save("example", saved);
  assert.equal(await ctx.run("status"), 0);
  assert.match(ctx.out.join(), /Mode: oauth.*\nInstance host: instance\.example\.test/);
  assert.doesNotMatch(ctx.out.join(), /fixture-/);
  assert.equal(await ctx.run("status", "--json"), 0);
  assert.deepEqual(JSON.parse(ctx.out[1]!), {
    configuredMode: "auto", mode: "oauth", instanceHost: "instance.example.test",
    loginUrl: saved.loginUrl, issuedAt: saved.issuedAt, hasRefreshToken: true,
  });
}));

function checkRevocation(succeeds: boolean) {
  return withFixture(async (ctx) => {
    await ctx.store.save("example", saved);
    ctx.respond = () => new Response(null, { status: succeeds ? 200 : 503 });
    assert.equal(await ctx.run("logout", "--revoke"), 0);
    const request = ctx.requests[0]!;
    assert.equal(request.url, saved.loginUrl + "/services/oauth2/revoke");
    assert.equal(request.init?.method, "POST");
    assert.equal((request.init?.body as URLSearchParams).get("token"), saved.refreshToken);
    assert.equal(await ctx.store.load("example"), undefined);
    assert.equal(ctx.err.some((line) => line.includes("revocation failed")), !succeeds);
    assert.doesNotMatch([...ctx.out, ...ctx.err].join(), /fixture-/);
  });
}

test("logout deletes local credentials when revocation succeeds", checkRevocation(true));
test("logout deletes local credentials when revocation fails", checkRevocation(false));

test("missing client ID prevents either listener from starting", withFixture(async (ctx) => {
  ctx.env.SF_CLIENT_ID = "";
  assert.equal(await ctx.run("login"), 1);
  assert.match(ctx.err.join(), /SF_CLIENT_ID/);
  assert.equal(ctx.binds.length, 0);
}));

test("refresh sends one refresh grant and reports rotation and issue time", withFixture(async (ctx) => {
  await ctx.store.save("example", saved);
  assert.equal(await ctx.run("refresh"), 0);
  assert.equal(ctx.requests.length, 1);
  const request = ctx.requests[0]!;
  assert.equal(request.init?.method, "POST");
  assert.equal((request.init?.body as URLSearchParams).get("grant_type"), "refresh_token");
  assert.deepEqual(await ctx.store.load("example"), rotated);
  assert.match(ctx.out.join(), /200.*rotated/);
  assert.doesNotMatch(ctx.out.join(), /fixture-/);
}));

test("invalid grant requires a new sign-in", withFixture(async (ctx) => {
  await ctx.store.save("example", saved);
  ctx.respond = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  assert.equal(await ctx.run("refresh"), 1);
  assert.match(ctx.err.join(), /Run auth login again/);
  assert.deepEqual(await ctx.store.load("example"), saved);
}));

function checkHeldLock(command: "refresh" | "logout") {
  return withFixture(async (ctx) => {
    await ctx.store.save("example", saved);
    const path = refreshLockPath(ctx.env.REPLCRM_CONFIG_DIR, "example");
    const lock = await acquireLock(path, { command: "holder" });
    try {
      assert.equal(await ctx.run(command), 1);
      assert.ok(ctx.err.join().includes(path));
      assert.equal(ctx.requests.length, 0);
      assert.deepEqual(await ctx.store.load("example"), saved);
    } finally {
      await lock.release();
    }
  });
}

test("refresh fails with the lock path if a live holder blocks it", checkHeldLock("refresh"));
test("logout fails with the lock path if a live holder blocks it", checkHeldLock("logout"));

test("logout follows an in-flight refresh and a queued refresh cannot restore the sign-in", withFixture(async (ctx) => {
  await ctx.store.save("example", saved);
  const requested = deferred<void>();
  const response = deferred<Response>();
  ctx.respond = () => {
    requested.resolve();
    return response.promise;
  };
  const refresh = ctx.run("refresh");
  await requested.promise;
  const logout = ctx.run("logout", "--revoke");
  const secondRefresh = ctx.run("refresh");
  assert.deepEqual(await ctx.store.load("example"), saved);
  ctx.respond = () => new Response(null, { status: 200 });
  response.resolve(tokenResponse());
  assert.deepEqual(await Promise.all([refresh, logout, secondRefresh]), [0, 0, 1]);
  assert.equal(await ctx.store.load("example"), undefined);
  assert.equal(ctx.requests.length, 2);
  assert.equal((ctx.requests[1]?.init?.body as URLSearchParams).get("token"), rotated.refreshToken);
  assert.equal(await ctx.run("refresh"), 1);
  assert.equal(ctx.requests.length, 2);
  assert.match(ctx.err.join(), /Run auth login/);
}));
