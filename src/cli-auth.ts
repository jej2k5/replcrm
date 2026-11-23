import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { configuredAuthMode, required } from "./config.js";
import { safeDeploymentFileName } from "./cli-config-dir.js";
import { LockHeldError } from "./locks/file-lock.js";
import type { WithRefreshLock } from "./locks/refresh-lock.js";
import type { TokenStore } from "./sources/salesforce/auth/token-store.js";

export const authUsage = [
  "auth login [--login-url <url>]", "auth status [--json]", "auth refresh [--json]",
  "auth logout [--revoke]", "auth callback-url",
].join("\n  ");

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Handler = (method: string, url: string, headers: Record<string, string | string[] | undefined>) => Promise<Reply>;
interface Listener { close(): void | Promise<void> }

export interface AuthDeps {
  env: NodeJS.ProcessEnv;
  listen(options: { host: "127.0.0.1" | "::1"; port: number; handler: Handler }): Listener | Promise<Listener>;
  openBrowser(url: string): void | Promise<void>;
  now(): Date;
  scheduleTimeout(callback: () => void, ms: number): () => void;
  fetch: typeof globalThis.fetch;
  tokenStore(): TokenStore | Promise<TokenStore>;
  withRefreshLock(deploymentId: string): WithRefreshLock;
  stdout(message: string): void;
  stderr(message: string): void;
}

export const listenForAuth: AuthDeps["listen"] = async ({ host, port, handler }) => {
  const server = createServer(async (request, response) => {
    const { status, headers, body } = await handler(request.method ?? "", request.url ?? "", request.headers);
    response.writeHead(status, headers).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }) };
};

export function openAuthBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [url], (error) => error ? reject(error) : resolve());
  });
}

export function scheduleAuthTimeout(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

const callbackPath = "/oauth/callback";
const timeoutMs = 300_000;
const defaultLoginUrl = "https://login.salesforce.com";

function parseLoginUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function callbackPort(env: NodeJS.ProcessEnv): number {
  const raw = env.SF_OAUTH_CALLBACK_PORT ?? "47123";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error("SF_OAUTH_CALLBACK_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function callbackUrl(port: number): string {
  return `http://localhost:${port}${callbackPath}`;
}

function page(status: number, message: string): Reply {
  const escaped = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer", connection: "close",
    },
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>ReplCRM sign-in</title><p>${escaped}</p></html>`,
  };
}

function readCallback(method: string, target: string, host: unknown, port: number, state: string):
  Reply | { code: string } | { error: string } {
  const queryStart = target.indexOf("?");
  const path = queryStart === -1 ? target : target.slice(0, queryStart);
  if (path !== callbackPath) return page(404, "Not found.");
  if (typeof host !== "string" || ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host)) {
    return page(400, "Invalid Host header.");
  }
  if (method !== "GET") return page(405, "Use GET.");
  const params = new URLSearchParams(queryStart === -1 ? "" : target.slice(queryStart + 1));
  if (params.get("state") !== state) return page(400, "Invalid OAuth state.");
  if (params.has("error")) return { error: params.get("error") || "unknown error" };
  const code = params.get("code");
  return code ? { code } : page(400, "Missing OAuth code.");
}

async function login(deps: AuthDeps, deploymentId: string, loginUrl: string): Promise<number> {
  const clientId = required(deps.env, "SF_CLIENT_ID");
  const port = callbackPort(deps.env);
  const redirectUri = callbackUrl(port);
  const [{ generatePkce, generateState }, { buildAuthorizationUrl, exchangeCode }] = await Promise.all([
    import("./sources/salesforce/auth/pkce.js"),
    import("./sources/salesforce/auth/oauth.js"),
  ]);
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const endpoint = parseLoginUrl(loginUrl);
  if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("Salesforce login URL must be an HTTPS URL without credentials.");
  }
  const authorization = buildAuthorizationUrl({ loginUrl, clientId, redirectUri, challenge, state });
  const store = await deps.tokenStore();
  const listeners: Listener[] = [];
  const abort = new AbortController();
  let claimed = false;
  let saving = false;
  let finished = false;
  let resolve!: (code: number) => void;
  const completion = new Promise<number>((done) => { resolve = done; });
  const deadline = deps.now().getTime() + timeoutMs;
  function finish(code: number): void {
    finished = true;
    resolve(code);
  }
  function timeout(): void {
    if (finished || saving) return;
    abort.abort();
    deps.stderr("Salesforce sign-in timed out.");
    finish(1);
  }

  const handler: Handler = async (method, url, headers) => {
    const callback = readCallback(method, url, headers.host, port, state);
    if ("status" in callback) return callback;
    if (deps.now().getTime() >= deadline) timeout();
    if (claimed || finished) return page(409, "This sign-in callback is no longer available.");
    claimed = true;
    if ("error" in callback) {
      deps.stderr("Salesforce sign-in was declined or failed.");
      finish(1);
      return page(400, `Salesforce sign-in failed: ${callback.error}.`);
    }
    try {
      const tokens = await exchangeCode({
        loginUrl, clientId, redirectUri, verifier, code: callback.code,
        fetch: deps.fetch, signal: abort.signal,
      });
      const host = new URL(tokens.instanceUrl).host;
      if (deps.now().getTime() >= deadline) timeout();
      if (finished) return page(408, "Salesforce sign-in timed out.");
      saving = true;
      await store.save(deploymentId, tokens);
      finish(0);
      return page(200, `Signed in to ${host}. You can close this tab.`);
    } catch {
      if (!finished) deps.stderr("Could not exchange or save the Salesforce sign-in. Run auth login again.");
      finish(1);
      return page(502, "Could not complete Salesforce sign-in. You can close this tab.");
    }
  };

  let cancelTimeout: (() => void) | undefined;
  try {
    listeners.push(await deps.listen({ host: "127.0.0.1", port, handler }));
    try {
      listeners.push(await deps.listen({ host: "::1", port, handler }));
    } catch {
      deps.stderr("IPv6 loopback unavailable. Listening on IPv4 loopback.");
    }
    cancelTimeout = deps.scheduleTimeout(timeout, Math.max(0, deadline - deps.now().getTime()));
    if (!finished) {
      const url = authorization.toString();
      deps.stdout(url);
      void Promise.resolve().then(() => deps.openBrowser(url)).catch(() => {
        if (!finished) deps.stderr("Could not open the browser. Open the printed URL.");
      });
    }
    return await completion;
  } finally {
    cancelTimeout?.();
    await Promise.all(listeners.map(async (listener) => listener.close()));
  }
}

export async function runAuth(args: string[], deps: AuthDeps): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "callback-url" && command !== "login" && command !== "status" &&
      command !== "refresh" && command !== "logout") {
    deps.stderr(`Usage: replcrm ${authUsage}`);
    return 1;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: command === "login" ? { "login-url": { type: "string" } } :
        command === "logout" ? { revoke: { type: "boolean" } } :
        command === "callback-url" ? {} : { json: { type: "boolean" } },
    });
    if (command === "callback-url") {
      deps.stdout(callbackUrl(callbackPort(deps.env)));
      return 0;
    }

    const deploymentId = safeDeploymentFileName(required(deps.env, "DEPLOYMENT_ID"));
    const loginUrl = deps.env.SF_LOGIN_URL || defaultLoginUrl;
    if (command === "login") return await login(deps, deploymentId, String(values["login-url"] ?? loginUrl));

    const store = await deps.tokenStore();
    if (command === "status") {
      const configuredMode = configuredAuthMode(deps.env);
      const saved = await store.load(deploymentId);
      const mode = configuredMode === "auto" ? (saved ? "oauth" : "password") : configuredMode;
      const status = {
        configuredMode, mode, instanceHost: saved ? new URL(saved.instanceUrl).host : null,
        loginUrl: new URL(mode === "oauth" && saved ? saved.loginUrl : loginUrl).origin,
        issuedAt: saved?.issuedAt ?? null, hasRefreshToken: Boolean(saved?.refreshToken),
      };
      deps.stdout(values.json ? JSON.stringify(status) : [
        `Mode: ${mode} (SF_AUTH_MODE=${configuredMode})`, `Instance host: ${status.instanceHost ?? "none"}`,
        `Login URL: ${status.loginUrl}`, `Issued time: ${status.issuedAt ?? "none"}`,
        `Refresh token stored: ${status.hasRefreshToken ? "yes" : "no"}`,
      ].join("\n"));
      return 0;
    }

    return await deps.withRefreshLock(deploymentId)(async () => {
      if (command === "refresh") {
        const { refreshStoredSignIn } = await import("./sources/salesforce/auth/refresh.js");
        const { tokens, rotated } = await refreshStoredSignIn(store, deploymentId, {
          clientId: deps.env.SF_CLIENT_ID || undefined,
          clientSecret: deps.env.SF_CLIENT_SECRET, fetch: deps.fetch,
        });
        const result = { success: true, issuedAt: tokens.issuedAt, rotated };
        deps.stdout(values.json ? JSON.stringify(result) :
          `Salesforce sign-in refreshed. Issued time: ${result.issuedAt}. Refresh token ${rotated ? "rotated" : "retained"}.`);
        return 0;
      }
      if (values.revoke) {
        const saved = await store.load(deploymentId);
        if (saved) {
          try {
            const response = await deps.fetch(new URL("/services/oauth2/revoke", saved.loginUrl), {
              method: "POST", body: new URLSearchParams({ token: saved.refreshToken }), redirect: "error",
            });
            if (!response.ok) throw new Error("Revocation rejected.");
          } catch {
            deps.stderr("Salesforce revocation failed. Clearing the local sign-in.");
          }
        }
      }
      await store.clear(deploymentId);
      deps.stdout("Local Salesforce sign-in cleared.");
      return 0;
    });
  } catch (error) {
    if (error instanceof LockHeldError && error.live) {
      deps.stderr(`${error.message} holds the lock at ${error.path}.`);
    } else {
      deps.stderr(error instanceof Error ? error.message : "Salesforce auth command failed.");
    }
    return 1;
  }
}
