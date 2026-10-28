import type { CrmSource, CanonicalEntity, ChangeBatch, SourceUser } from "../../core/source.js";
import { normalizeMetadata } from "./metadata.js";
import { normalizeRecord } from "./values.js";
export { normalizeRecord } from "./values.js";
import { streamRawRecords } from "./records.js";

import {
  Connection,
  type DescribeSObjectResult,
  type Field,
  type QueryResult,
} from "jsforce";

// Lightweight describeGlobal() entry, narrower than jsforce's full type.
// We only consume what the metadata-sync filter cares about.
export interface SourceObjectListing {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  deprecatedAndHidden: boolean;
  layoutable: boolean;
}

// PicklistEntry isn't re-exported from jsforce's root index in 3.x. Define
// the shape we actually consume — narrower than the metadata schema's full
// definition but enough for our mapper.
interface PicklistEntry {
  value: string;
  label?: string | null;
  active: boolean;
  defaultValue: boolean;
}
import type { SourceFieldDescribe, SourceObjectDescribe, SourcePicklistEntry, SourceRecord } from "./types.js";

// Two ways to authenticate against Salesforce:
//   - "password": legacy username + password + security token. Used by the
//     CLI runner for one-off migrations from a developer's laptop.
//   - "oauth":    OAuth Connected App tokens. Used by the worker container
//     supplied directly by a caller. Refresh tokens require matching OAuth
//     client credentials. Token storage is the caller's responsibility.
export interface PasswordCredentials {
  mode: "password";
  loginUrl: string;
  username: string;
  password: string;
  securityToken: string;
}

export interface OAuthCredentials {
  mode: "oauth";
  instanceUrl: string;       // https://acme.my.salesforce.com — returned by SF post-OAuth
  accessToken: string;
  refreshToken?: string;     // Lets jsforce auto-refresh on 401
  // OAuth client credentials. REQUIRED when refreshToken is set —
  // otherwise jsforce throws:
  //   "Refresh token is specified without oauth2 client information or refresh function"
  // Optional when only an access token is supplied (no auto-refresh).
  // loginUrl is the SF authorize host (login.salesforce.com or test.salesforce.com).
  oauth2?: {
    clientId: string;
    clientSecret: string;
    loginUrl: string;
  };
}

// The original SourceCredentials interface (no `mode`) — kept accepted so
// the CLI runner (which loads config via env) doesn't need to change.
export interface LegacyCredentials {
  loginUrl: string;
  username: string;
  password: string;
  securityToken: string;
}

export type AnyCredentials = PasswordCredentials | OAuthCredentials | LegacyCredentials;

function normaliseCredentials(creds: AnyCredentials): PasswordCredentials | OAuthCredentials {
  if ("mode" in creds) return creds;
  return { ...creds, mode: "password" };
}

// Salesforce errors worth retrying. Surface jsforce error shapes are
// inconsistent (string code, HTTP status, or thrown Error w/ name); we
// match liberally on common signals.
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errorCode?: string; statusCode?: number; status?: number; code?: string; name?: string; message?: string };
  const code: string | undefined = e.errorCode ?? e.code ?? e.name;
  const status: number | undefined = e.statusCode ?? e.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  if (code === "REQUEST_LIMIT_EXCEEDED") return false; // daily quota — DON'T spin
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  if (typeof e.message === "string" && /timeout|temporarily unavailable/i.test(e.message)) {
    return true;
  }
  return false;
}

const RETRY_MAX_ATTEMPTS: number = 5;
const RETRY_BASE_MS: number = 500;
const RETRY_MAX_MS: number = 15_000;

// Exponential backoff with full-jitter for transient SF errors. Wraps any
// async operation against the connection. Non-retryable errors throw on
// the first attempt so we never paper over a permanent failure.
async function withRetry<T>(op: () => Promise<T>, label: string): Promise<T> {
  let attempt: number = 0;
  while (true) {
    try {
      return await op();
    } catch (err) {
      attempt += 1;
      if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryable(err)) throw err;
      const ceiling: number = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      const sleepMs: number = Math.floor(Math.random() * ceiling);
      console.warn(
        `[source-retry] ${label} attempt ${attempt}/${RETRY_MAX_ATTEMPTS - 1} failed; sleeping ${sleepMs}ms (${(err as Error).message ?? String(err)})`,
      );
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
}

export class SourceClient implements CrmSource {
  private readonly targetTypes: Map<string, string> = new Map();
  private objectListings: SourceObjectListing[] | null = null;
  private connection: Connection;
  private connected: boolean = false;
  private credentials: PasswordCredentials | OAuthCredentials;

  constructor(credentials: AnyCredentials) {
    this.credentials = normaliseCredentials(credentials);

    if (this.credentials.mode === "oauth") {
      // jsforce builds the connection from { instanceUrl, accessToken } and
      // talks to /services/data/* under that instance. No login() call needed.
      //
      // refreshToken (if present) wires up automatic re-auth on 401 — but
      // jsforce requires the matching oauth2 { clientId, clientSecret,
      // loginUrl } to know which Connected App's /services/oauth2/token to
      // hit. Passing refreshToken without oauth2 throws at construction.
      if (this.credentials.refreshToken && !this.credentials.oauth2) {
        throw new Error(
          "OAuth credentials include refreshToken but not oauth2 client config. " +
            "Pass { oauth2: { clientId, clientSecret, loginUrl } } so jsforce can refresh.",
        );
      }
      this.connection = new Connection({
        instanceUrl: this.credentials.instanceUrl,
        accessToken: this.credentials.accessToken,
        ...(this.credentials.refreshToken
          ? { refreshToken: this.credentials.refreshToken }
          : {}),
        ...(this.credentials.oauth2
          ? {
              oauth2: {
                clientId: this.credentials.oauth2.clientId,
                clientSecret: this.credentials.oauth2.clientSecret,
                loginUrl: this.credentials.oauth2.loginUrl,
              },
            }
          : {}),
      });
      this.connected = true;
    } else {
      this.connection = new Connection({ loginUrl: this.credentials.loginUrl });
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.credentials.mode !== "password") {
      // OAuth connections start "connected" because the constructor already
      // set the access token. We never reach this branch for them.
      return;
    }
    await this.connection.login(
      this.credentials.username,
      this.credentials.password + this.credentials.securityToken,
    );
    this.connected = true;
  }

  // Enumerate every SObject visible to the integration user. Used by the
  // orchestrator when SYNC_ENTITIES=*. Returns a narrow shape; callers
  // filter to queryable && !deprecated && !system-suffix in metadata-sync.
  async describeGlobal(): Promise<SourceObjectListing[]> {
    if (this.objectListings) return this.objectListings;
    await this.connect();
    const result = await withRetry(
      () => this.connection.describeGlobal(),
      "describeGlobal",
    );
    for (const item of result.sobjects) {
      if (item.keyPrefix) this.targetTypes.set(item.keyPrefix, item.name);
    }
    this.objectListings = result.sobjects.map((s): SourceObjectListing => ({
      name: s.name,
      label: s.label,
      custom: Boolean(s.custom),
      queryable: Boolean(s.queryable),
      deprecatedAndHidden: Boolean(s.deprecatedAndHidden),
      layoutable: Boolean(s.layoutable),
    }));
    return this.objectListings;
  }

  async describeObject(objectName: string): Promise<SourceObjectDescribe> {
    await this.connect();
    const raw: DescribeSObjectResult = await withRetry(
      () => this.connection.sobject(objectName).describe(),
      `describe(${objectName})`,
    );

    const fields: SourceFieldDescribe[] = raw.fields.map(
      (f: Field): SourceFieldDescribe => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length ?? null,
        precision: f.precision ?? null,
        scale: f.scale ?? null,
        nillable: f.nillable,
        unique: f.unique,
        externalId: f.externalId ?? false,
        calculated: f.calculated ?? false,
        custom: f.custom,
        defaultValueFormula: f.defaultValueFormula ?? null,
        inlineHelpText: f.inlineHelpText ?? null,
        referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === "string"),
        relationshipName: f.relationshipName ?? null,
        cascadeDelete: f.cascadeDelete ?? false,
        picklistValues: (f.picklistValues ?? []).map(
          (p: PicklistEntry): SourcePicklistEntry => ({
            value: p.value,
            label: p.label ?? p.value,
            active: p.active,
            defaultValue: p.defaultValue,
          }),
        ),
      }),
    );

    return {
      name: raw.name,
      label: raw.label,
      labelPlural: raw.labelPlural,
      custom: raw.custom,
      fields,
    };
  }

  async *queryAll(soql: string, batchSize: number): AsyncGenerator<SourceRecord[]> {
    await this.connect();
    let result: QueryResult<SourceRecord> = await withRetry(
      () => Promise.resolve(this.connection.query<SourceRecord>(soql)),
      "query",
    );
    let batch: SourceRecord[] = result.records;

    while (batch.length > 0) {
      for (let i: number = 0; i < batch.length; i += batchSize) {
        yield batch.slice(i, i + batchSize);
      }

      if (result.done || !result.nextRecordsUrl) break;
      const nextUrl: string = result.nextRecordsUrl;
      result = await withRetry(
        () => Promise.resolve(this.connection.queryMore<SourceRecord>(nextUrl)),
        "queryMore",
      );
      batch = result.records;
    }
  }

  async listEntities(): Promise<string[]> {
    return (await this.describeGlobal()).filter((item: SourceObjectListing): boolean => item.queryable && !item.deprecatedAndHidden && !/(History|Share|Feed|ChangeEvent|__Tag)$/.test(item.name)).map((item: SourceObjectListing): string => item.name);
  }

  async describeEntity(entityKey: string): Promise<CanonicalEntity> {
    assertApiName(entityKey);
    await this.describeGlobal();
    return normalizeMetadata(await this.describeObject(entityKey));
  }

  async *fetchChanges(entity: CanonicalEntity, checkpoint: string | null, batchSize: number): AsyncGenerator<ChangeBatch> {
    assertApiName(entity.key);
    entity.attributes.forEach((attr): void => assertApiName(attr.key));
    const since: string | null = decodeCheckpoint(checkpoint);
    let watermark: string | null = since;
    const systemColumns: readonly string[] = ["SystemModstamp", "IsDeleted", "OwnerId", "CreatedById", "LastModifiedById"];
    const userFields: string[] = entity.attributes.map((attr): string => attr.key).filter((key: string): boolean => !systemColumns.includes(key) && key !== "Id");
    // Identity is always selected, even when metadata omitted its attribute.
    for await (const batch of streamRawRecords(this, entity.key, ["Id", ...userFields], systemColumns, since, batchSize)) {
      for (const row of batch) if (row.SystemModstamp && (!watermark || row.SystemModstamp > watermark)) watermark = row.SystemModstamp;
      yield { records: batch.map((row: SourceRecord) => normalizeRecord(row, entity, this.targetTypes)), nextCheckpoint: watermark ? JSON.stringify({ version: 1, systemModstamp: watermark }) : checkpoint };
    }
  }

  async *streamUsers(batchSize: number): AsyncGenerator<SourceUser[]> {
    const soql: string = "SELECT Id, Username, Email, FirstName, LastName, UserType, IsActive FROM User";
    for await (const batch of this.queryAll(soql, batchSize)) {
      yield batch.map((row: SourceRecord): SourceUser => ({
        sourceId: row.Id,
        username: String(row.Username ?? ""),
        email: String(row.Email ?? ""),
        firstName: row.FirstName ? String(row.FirstName) : null,
        lastName: String(row.LastName ?? ""),
        role: row.UserType ? String(row.UserType) : null,
        isActive: row.IsActive === true || row.IsActive === "true",
      }));
    }
  }

  async logout(): Promise<void> {
    if (!this.connected) return;
    if (this.credentials.mode === "password") {
      await this.connection.logout();
    }
    this.connected = false;
  }
}

function assertApiName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid Salesforce API name: ${name}`);
}
export function decodeCheckpoint(checkpoint: string | null): string | null {
  if (checkpoint === null) return null;
  let value: unknown = checkpoint;
  if (checkpoint.startsWith("{")) {
    const parsed = JSON.parse(checkpoint) as { version?: unknown; systemModstamp?: unknown };
    if (parsed.version !== 1) throw new Error("Unsupported Salesforce checkpoint version");
    value = parsed.systemModstamp;
  }
  // Legacy bare timestamp cursors remain readable only in this adapter.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid Salesforce checkpoint");
  return value;
}
