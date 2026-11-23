import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAuthorizationUrl, exchangeCode, refreshAccessToken } from "../src/sources/salesforce/auth/oauth.js";
import { generatePkce, generateState } from "../src/sources/salesforce/auth/pkce.js";
import { FileTokenStore } from "../src/sources/salesforce/auth/token-store.js";

const client = { loginUrl: "https://login.example.test/", clientId: "fixture-client" };
const redirectUri = "http://localhost:47123/oauth/callback";
const accessToken = "fixture-access";
const refreshToken = "fixture-refresh";
const clientSecret = "fixture-secret";
const tokens = {
  ...client,
  instanceUrl: "https://instance.example.test",
  accessToken,
  refreshToken,
  issuedAt: "1700000000000",
};
const responseFields = {
  instance_url: tokens.instanceUrl,
  access_token: accessToken,
  issued_at: tokens.issuedAt,
};

async function withStore(run: (store: FileTokenStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "replcrm-oauth-"));
  try {
    await run(new FileTokenStore(directory), join(directory, "credentials"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("PKCE uses URL-safe randomness and an S256 challenge", () => {
  const { verifier, challenge } = generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(verifier, generatePkce().verifier);
  const state = generateState();
  assert.match(state, /^[A-Za-z0-9_-]{43,}$/);
  assert.notEqual(state, generateState());
});

test("authorization URL requests PKCE and offline access", () => {
  const url = buildAuthorizationUrl({ ...client, redirectUri, challenge: "fixture-challenge", state: "fixture-state" });
  assert.equal(url.origin, new URL(client.loginUrl).origin);
  assert.equal(url.pathname, "/services/oauth2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: "fixture-challenge",
    code_challenge_method: "S256",
    state: "fixture-state",
    scope: "api refresh_token",
  });
});

test("code exchange posts form parameters and includes a secret only when supplied", async () => {
  const base = { ...client, code: "fixture-code", verifier: "fixture-verifier", redirectUri };
  for (const secret of [undefined, clientSecret]) {
    const result = await exchangeCode({
      ...base,
      ...(secret === undefined ? {} : { clientSecret: secret }),
      fetch: async (url, init) => {
        assert.equal(String(url), new URL("/services/oauth2/token", client.loginUrl).href);
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.ok(init.body instanceof URLSearchParams);
        assert.deepEqual(Object.fromEntries(init.body), {
          grant_type: "authorization_code",
          code: base.code,
          code_verifier: base.verifier,
          redirect_uri: redirectUri,
          client_id: client.clientId,
          ...(secret === undefined ? {} : { client_secret: secret }),
        });
        return Response.json({ ...responseFields, refresh_token: refreshToken });
      },
    });
    assert.deepEqual(result, tokens);
  }
});

test("refresh posts the current refresh token and preserves it when omitted", async () => {
  const nextAccess = "fixture-next-access";
  const result = await refreshAccessToken({
    ...client,
    refreshToken,
    fetch: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, "/services/oauth2/token");
      assert.equal(init?.method, "POST");
      assert.ok(init.body instanceof URLSearchParams);
      assert.equal(init.body.get("grant_type"), "refresh_token");
      assert.equal(init.body.get("refresh_token"), refreshToken);
      assert.equal(init.body.get("client_id"), client.clientId);
      assert.equal(init.body.has("client_secret"), false);
      return Response.json({ ...responseFields, access_token: nextAccess });
    },
  });
  assert.deepEqual(result, { ...tokens, accessToken: nextAccess });
});

test("invalid grants direct the operator to sign in again without exposing credentials", async () => {
  await assert.rejects(refreshAccessToken({
    ...client,
    refreshToken,
    fetch: async () => Response.json({
      error: "invalid_grant",
      error_description: refreshToken,
      access_token: accessToken,
    }, { status: 400 }),
  }), { message: "Salesforce rejected the OAuth grant. Run auth login again." });
});

test("file store round trips only the allowed fields and clears private credentials", async () => {
  await withStore(async (store, directory) => {
    assert.equal(await store.load("fixture"), undefined);
    await store.clear("fixture");
    const input = { ...tokens, clientSecret };
    await store.save("fixture", input);
    const path = join(directory, "fixture.json");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), tokens);
    assert.deepEqual(await store.load("fixture"), tokens);
    await chmod(path, 0o644);
    await assert.rejects(store.load("fixture"), /private JSON file/);
    await store.clear("fixture");
    assert.equal(await store.load("fixture"), undefined);
    await assert.rejects(store.load("../x"), /Unsafe deployment ID/);
    await assert.rejects(store.save("../x", tokens), /Unsafe deployment ID/);
    await assert.rejects(store.clear("../x"), /Unsafe deployment ID/);
  });
});

test("refresh rotation survives saving and reloading the deployment", async () => {
  await withStore(async (store) => {
    await store.save("fixture", tokens);
    const saved = await store.load("fixture");
    assert.ok(saved);
    const nextRefresh = "fixture-next-refresh";
    const refreshed = await refreshAccessToken({
      ...saved,
      fetch: async () => Response.json({ ...responseFields, refresh_token: nextRefresh }),
    });
    assert.equal(refreshed.refreshToken, nextRefresh);
    await store.save("fixture", refreshed);
    assert.deepEqual(await store.load("fixture"), { ...tokens, refreshToken: nextRefresh });
  });
});
