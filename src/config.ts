import type { ReplicationConfig } from "./core/config.js";
import type { OAuthTokens, TokenStore } from "./sources/salesforce/auth/token-store.js";

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value: string | undefined = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name] ?? fallback;
}

export interface SourceCredentials {
  loginUrl: string;
  username: string;
  password: string;
  securityToken: string;
}

export interface MigrationConfig extends ReplicationConfig {
  source: SourceCredentials;
}

export function loadSourceCredentials(env: NodeJS.ProcessEnv): SourceCredentials {
  return {
    loginUrl: optional(env, "SF_LOGIN_URL", "https://login.salesforce.com"),
    username: required(env, "SF_USERNAME"),
    password: required(env, "SF_PASSWORD"),
    securityToken: required(env, "SF_SECURITY_TOKEN"),
  };
}

export type SourceAuth =
  | ({ mode: "password" } & SourceCredentials)
  | { mode: "oauth"; deploymentId: string; tokens: OAuthTokens; clientId: string; clientSecret: string | undefined };

export function configuredAuthMode(env: NodeJS.ProcessEnv): "auto" | "oauth" | "password" {
  const mode = env.SF_AUTH_MODE || "auto";
  if (mode !== "auto" && mode !== "oauth" && mode !== "password") throw new Error("SF_AUTH_MODE must be auto, oauth or password.");

  return mode;
}

export function loadSourceAuth(env: NodeJS.ProcessEnv, tokenStore: TokenStore): Promise<SourceAuth>;
export function loadSourceAuth(env: NodeJS.ProcessEnv, tokenStore: TokenStore, allowUnconfigured: true): Promise<SourceAuth | undefined>;
export async function loadSourceAuth(
  env: NodeJS.ProcessEnv, tokenStore: TokenStore, allowUnconfigured = false,
): Promise<SourceAuth | undefined> {
  const mode = configuredAuthMode(env);
  if (mode === "password") return { mode, ...loadSourceCredentials(env) };
  const deploymentId = required(env, "DEPLOYMENT_ID");
  const tokens = await tokenStore.load(deploymentId);
  if (tokens) {
    return {
      mode: "oauth", deploymentId, tokens,
      clientId: required(env, "SF_CLIENT_ID"), clientSecret: env.SF_CLIENT_SECRET || undefined,
    };
  }
  if (mode === "oauth") throw new Error(`No stored Salesforce OAuth sign-in for ${deploymentId}. Run auth login.`);
  if (env.SF_USERNAME && env.SF_PASSWORD && env.SF_SECURITY_TOKEN) {
    return { mode: "password", ...loadSourceCredentials(env) };
  }
  if (allowUnconfigured && !env.SF_CLIENT_ID && !env.SF_CLIENT_SECRET &&
    !env.SF_USERNAME && !env.SF_PASSWORD && !env.SF_SECURITY_TOKEN) return undefined;
  throw new Error("Run auth login or set SF_USERNAME, SF_PASSWORD and SF_SECURITY_TOKEN.");
}

export function loadReplicationConfig(env: NodeJS.ProcessEnv): ReplicationConfig {
  return {
    deploymentId: required(env, "DEPLOYMENT_ID"),
    buildWideViews: optional(env, "BUILD_WIDE_VIEWS", "true").toLowerCase() !== "false",
    batchSize: Number.parseInt(optional(env, "SYNC_BATCH_SIZE", "2000"), 10),
    entityKeys: optional(env, "SYNC_ENTITIES", "Account,Contact,Lead,Opportunity,Case")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0),
    entityDenyKeys: optional(env, "SYNC_ENTITY_DENY", "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MigrationConfig {
  return { ...loadReplicationConfig(env), source: loadSourceCredentials(env) };
}
