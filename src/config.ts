import type { ReplicationConfig } from "./core/config.js";

function required(name: string): string {
  const value: string | undefined = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
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

export function loadConfig(): MigrationConfig {
  return {
    deploymentId: required("DEPLOYMENT_ID"),
    source: {
      loginUrl: optional("SF_LOGIN_URL", "https://login.salesforce.com"),
      username: required("SF_USERNAME"),
      password: required("SF_PASSWORD"),
      securityToken: required("SF_SECURITY_TOKEN"),
    },
    buildWideViews: optional("BUILD_WIDE_VIEWS", "true").toLowerCase() !== "false",
    batchSize: Number.parseInt(optional("SYNC_BATCH_SIZE", "2000"), 10),
    entityKeys: optional("SYNC_ENTITIES", "Account,Contact,Lead,Opportunity,Case")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0),
    entityDenyKeys: optional("SYNC_ENTITY_DENY", "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0),
  };
}
