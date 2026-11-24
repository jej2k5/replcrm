import { assertApiName } from "./api-name.js";
import type { CrmSource, CanonicalEntity, ChangeBatch, SourceUser, SourceChangeResult, ValidatedChange, SourceRecord as CanonicalRecord } from "../../core/source.js";
import { normalizeMetadata } from "./metadata.js";
import { normalizeRecord } from "./values.js";
export { normalizeRecord } from "./values.js";
import { failure, recordFilter, responseError, SalesforceResponseError, sendChange } from "./writer.js";
import { streamRawRecords } from "./records.js";

import type { WithRefreshLock } from "../../locks/refresh-lock.js";
import {
  Connection,
  type ConnectionConfig,
  type QueryResult,
} from "jsforce";

// Lightweight describeGlobal() entry, narrower than jsforce's full type.
// We only consume what the metadata-sync filter cares about.
export interface SourceObjectListing {
  name: string;
  label: string;
  custom: boolean;
  queryable: boolean;
  replicateable: boolean;
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
  if (isExpiredSession(err)) return false;
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

export interface SalesforceIdentity {
  organizationId: string;
  userId: string;
  username: string;
  instanceUrl: string;
}

type IdentityConnection = {
  instanceUrl: string;
  identity(): Promise<{ organization_id: string; user_id: string; username: string }>;
};

export async function readSalesforceIdentity(connection: IdentityConnection): Promise<SalesforceIdentity> {
  const result = await connection.identity();
  return {
    organizationId: result.organization_id,
    userId: result.user_id,
    username: result.username,
    instanceUrl: connection.instanceUrl,
  };
}

type RequiredDescribeField = "name" | "label" | "type" | "nillable" | "unique" | "custom";
type DescribeField = Pick<SourceFieldDescribe, RequiredDescribeField> & {
  [K in Exclude<keyof SourceFieldDescribe, RequiredDescribeField | "picklistValues">]?:
    SourceFieldDescribe[K] | null | undefined;
} & { picklistValues?: PicklistEntry[] | null | undefined };

export interface SourceConnection extends IdentityConnection {
  accessToken?: string | null | undefined;
  version?: string;
  describeGlobal(): PromiseLike<{ sobjects: (SourceObjectListing & { keyPrefix?: string | null | undefined })[] }>;
  sobject(name: string): {
    describe(): PromiseLike<Omit<SourceObjectDescribe, "fields"> & { fields: DescribeField[] }>;
  };
  query(soql: string, options?: { scanAll: boolean }): PromiseLike<QueryResult<SourceRecord>>;
  queryMore(locator: string): PromiseLike<QueryResult<SourceRecord>>;
  login?(username: string, password: string): PromiseLike<unknown>;
  logout?(): PromiseLike<unknown>;
}

export type ConnectionFactory = (options: ConnectionConfig) => SourceConnection;

interface SourceClientOptions {
  fetch?: typeof fetch;
  identity?: () => Promise<SalesforceIdentity>;
  connectionFactory?: ConnectionFactory | undefined;
  refresh?: (failedAccessToken: string) => Promise<{ accessToken: string; instanceUrl?: string }>;
  withRefreshLock?: WithRefreshLock;
}

function isExpiredSession(error: unknown): boolean {
  if (error instanceof SalesforceResponseError) return error.expiredSession;
  if (!error || typeof error !== "object") return false;
  const { name, code, errorCode, statusCode, status } = error as Record<string, unknown>;
  return [name, code, errorCode].some((value) => value === "INVALID_SESSION_ID" || value === "ERROR_HTTP_401") ||
    statusCode === 401 || status === 401;
}

export class SourceClient implements CrmSource {
  private attributionFields = new Map<string, string>();
  private readonly targetTypes: Map<string, string> = new Map();
  private readonly objectDescribes = new Map<string, Promise<SourceObjectDescribe>>();
  private objectListings: SourceObjectListing[] | null = null;
  private connection?: SourceConnection;
  private connected: boolean = false;
  private readonly credentials: PasswordCredentials | OAuthCredentials;

  constructor(credentials: AnyCredentials, private readonly seams: SourceClientOptions = {}) {
    this.credentials = normaliseCredentials(credentials);
    if (this.credentials.mode === "oauth" && this.credentials.refreshToken && !this.credentials.oauth2) {
      throw new Error(
        "OAuth credentials include refreshToken but not oauth2 client config. " +
          "Pass { oauth2: { clientId, clientSecret, loginUrl } } so jsforce can refresh.",
      );
    }
  }

  private getConnection(): SourceConnection {
    if (this.connection) return this.connection;
    const create: ConnectionFactory = this.seams.connectionFactory ?? ((options) => new Connection(options));
    const credentials = this.credentials;
    this.connection = credentials.mode === "password"
      ? create({ loginUrl: credentials.loginUrl })
      : create({
          instanceUrl: credentials.instanceUrl,
          accessToken: credentials.accessToken,
          // Keep compatibility for callers supplying their own OAuth client config.
          ...(this.seams.refresh ? {} : { refreshToken: credentials.refreshToken, oauth2: credentials.oauth2 }),
        });
    return this.connection;
  }

  private async call<T>(
    operation: (connection: SourceConnection) => PromiseLike<T>, retryLabel?: string,
  ): Promise<T> {
    const connection = this.getConnection();
    const { refresh, withRefreshLock } = this.seams;
    let failedAccessToken: string | null | undefined;
    const invoke = async () => {
      failedAccessToken = connection.accessToken;
      return operation(connection);
    };
    try {
      return await (retryLabel ? withRetry(invoke, retryLabel) : invoke());
    } catch (error) {
      if (this.credentials.mode !== "oauth" || !refresh || !failedAccessToken || !isExpiredSession(error)) throw error;
    }
    const token = failedAccessToken;
    const update = async () => {
      const session = await refresh(token);
      connection.accessToken = session.accessToken;
      if (session.instanceUrl) connection.instanceUrl = session.instanceUrl;
    };
    await (withRefreshLock ? withRefreshLock(update) : update());
    return operation(connection);
  }

  async identity(): Promise<SalesforceIdentity> {
    if (this.seams.identity) return this.seams.identity();
    await this.connect();
    return this.call(readSalesforceIdentity);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.credentials.mode !== "password") {
      this.getConnection();
      this.connected = true;
      return;
    }
    const connection = this.getConnection();
    if (!connection.login) throw new Error("Password login is unavailable on this connection.");
    await connection.login(
      this.credentials.username,
      this.credentials.password + this.credentials.securityToken,
    );
    this.connected = true;
  }

  // Enumerate every SObject visible to the integration user. Used by the
  // orchestrator when SYNC_ENTITIES=*. Returns a narrow shape; callers
  // filter to queryable, replicateable objects and exclude hidden and system objects.
  async describeGlobal(): Promise<SourceObjectListing[]> {
    if (this.objectListings) return this.objectListings;
    await this.connect();
    const result = await this.call(
      (connection) => connection.describeGlobal(),
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
      replicateable: Boolean(s.replicateable),
      deprecatedAndHidden: Boolean(s.deprecatedAndHidden),
      layoutable: Boolean(s.layoutable),
    }));
    return this.objectListings;
  }

  async describeObject(objectName: string): Promise<SourceObjectDescribe> {
    await this.connect();
    const raw = await this.call(
      (connection) => connection.sobject(objectName).describe(),
      `describe(${objectName})`,
    );

    const fields: SourceFieldDescribe[] = raw.fields.map(
      (f): SourceFieldDescribe => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length ?? null,
        precision: f.precision ?? null,
        scale: f.scale ?? null,
        nillable: f.nillable,
        ...(f.nameField === true && { nameField: true }),
        updateable: f.updateable === true,
        createable: f.createable === true,
        defaultedOnCreate: f.defaultedOnCreate === true,
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

  async configureWriteback(objects: Readonly<Record<string, { writeback?: { attributionField?: string } }>>): Promise<void> {
    const fields = new Map<string, string>();
    for (const [object, config] of Object.entries(objects)) {
      const name = config.writeback?.attributionField;
      if (name === undefined) continue;
      assertApiName(object);
      assertApiName(name);
      const { fields: attributes } = await this.describeObject(object);
      if (!attributes.some((attr) => attr.name === name && attr.custom && !attr.calculated &&
        ["string", "textarea"].includes(attr.type) && attr.updateable && attr.createable)) {
        throw new Error(`Cannot enable attribution for ${object}.${name}: expected a custom text field writable on update and create`);
      }
      fields.set(object, name);
    }
    this.attributionFields = fields;
  }

  private async restRequest(path: string, init?: RequestInit): Promise<Response> {
    let expiredResponse: SalesforceResponseError | undefined;
    try {
      return await this.call(async (connection) => {
        expiredResponse = undefined;
        const endpoint = connection.instanceUrl + "/services/data/v" + (connection.version ?? "50.0");
        const response = await (this.seams.fetch ?? fetch)(endpoint + path, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" },
        });
        if (response.ok) return response;
        const error = await responseError(response);
        if (error.expiredSession) expiredResponse = error;
        throw error;
      });
    } catch (error) {
      // If refresh failed before replay, the expired session response still establishes that the write was refused.
      throw expiredResponse ?? error;
    }
  }

  async applyChange(change: ValidatedChange): Promise<SourceChangeResult> {
    try {
      await this.connect();
      if (!this.getConnection().accessToken) throw new Error("Salesforce session has no access token");
    } catch (error) {
      return failure(error, false);
    }
    const result = await sendChange(change,
      (path, init) => this.restRequest(path, init),
      this.targetTypes, this.attributionFields.get(change.entity.key));
    if (result.status !== "applied") return result;
    try {
      const record = await this.readRecord(change.entity, result.sourceId);
      if (!record) throw new Error("Record is not visible");
      return { ...result, record, modifiedAt: record.modifiedAt ?? null };
    } catch (error) {
      return { ...result, detail: `Salesforce confirmed the write. Replica refresh failed: ${String(error)}` };
    }
  }

  async readRecord(entity: CanonicalEntity, sourceId: string): Promise<CanonicalRecord | null> {
    const { fields, systemColumns } = recordColumns(entity);
    if (entity.attributes.some((attr) => (attr.relationship?.targetEntityKeys.length ?? 0) > 1)) {
      await this.describeGlobal();
    }
    for await (const rows of streamRawRecords(this, entity.key, fields, systemColumns, recordFilter(sourceId), 1)) {
      if (rows[0]) return normalizeRecord(rows[0], entity, this.targetTypes);
    }
    return null;
  }

  async queryPage(soql: string, includeDeleted: boolean, nextRecordsUrl?: string): Promise<QueryResult<SourceRecord>> {
    await this.connect();
    if (this.seams.fetch) {
      const path = nextRecordsUrl
        ? nextRecordsUrl.replace(/^\/services\/data\/v[\d.]+/, "")
        : `/${includeDeleted ? "queryAll" : "query"}?q=${encodeURIComponent(soql)}`;
      const response = await this.restRequest(path);
      return await response.json() as QueryResult<SourceRecord>;
    }
    if (nextRecordsUrl) {
      return this.call((connection) => connection.queryMore(nextRecordsUrl), "queryMore");
    }
    return this.call(
      (connection) => includeDeleted ? connection.query(soql, { scanAll: true }) : connection.query(soql),
      "query",
    );
  }

  async *streamQuery(soql: string, batchSize: number, includeDeleted: boolean): AsyncGenerator<SourceRecord[]> {
    let result = await this.queryPage(soql, includeDeleted);
    while (true) {
      for (let i = 0; i < result.records.length; i += batchSize) {
        yield result.records.slice(i, i + batchSize);
      }

      if (result.done) break;
      if (!result.nextRecordsUrl) throw new Error("Incomplete query response without a next page");
      result = await this.queryPage(soql, includeDeleted, result.nextRecordsUrl);
    }
  }

  private cachedDescribe(entityKey: string): Promise<SourceObjectDescribe> {
    const cached = this.objectDescribes.get(entityKey);
    if (cached) return cached;
    const pending = this.describeObject(entityKey).catch((error: unknown) => {
      this.objectDescribes.delete(entityKey);
      throw error;
    });
    this.objectDescribes.set(entityKey, pending);
    return pending;
  }

  private async activeRecordFilter(entityKey: string): Promise<string> {
    const { fields } = await this.cachedDescribe(entityKey);
    return fields.some((field) => field.name === "IsDeleted") ? " WHERE IsDeleted = false" : "";
  }

  async countRecords(entityKey: string): Promise<number> {
    assertApiName(entityKey);
    const result = await this.queryPage(`SELECT COUNT() FROM ${entityKey}${await this.activeRecordFilter(entityKey)}`, true);
    return result.totalSize;
  }

  async *listSourceIds(entityKey: string, batchSize: number): AsyncGenerator<string[]> {
    assertApiName(entityKey);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid source ID batch size");
    const filter = await this.activeRecordFilter(entityKey);
    for await (const batch of this.streamQuery(`SELECT Id FROM ${entityKey}${filter}`, batchSize, true)) {
      yield batch.map(({ Id }) => {
        if (typeof Id !== "string" || !Id) throw new Error("Missing source ID in query response");
        return Id;
      });
    }
  }

  async listReplicableObjects(): Promise<SourceObjectListing[]> {
    return (await this.describeGlobal())
      .filter((item) => item.queryable && item.replicateable && !item.deprecatedAndHidden
        && !/(History|Share|Feed|ChangeEvent|__Tag)$/.test(item.name));
  }

  async listEntities(): Promise<string[]> {
    return (await this.listReplicableObjects()).map((item) => item.name);
  }

  async describeEntity(entityKey: string): Promise<CanonicalEntity> {
    assertApiName(entityKey);
    await this.describeGlobal();
    const describe = await this.cachedDescribe(entityKey);
    if (!describe.fields.some((field) => field.name === "SystemModstamp")) {
      throw new Error(`Object ${entityKey} cannot be synced incrementally: it has no SystemModstamp field`);
    }
    return normalizeMetadata(describe);
  }

  async *fetchChanges(entity: CanonicalEntity, checkpoint: string | null, batchSize: number): AsyncGenerator<ChangeBatch> {
    const { fields, systemColumns } = recordColumns(entity);
    const since = decodeCheckpoint(checkpoint);
    const hasArchived = fields.includes("IsArchived");
    let watermark = since;
    const incrementalFilter = since ? `WHERE SystemModstamp > ${since}` : "";
    const filters = hasArchived && since && checkpoint && !hasArchivedBackfill(checkpoint)
      ? [`WHERE IsArchived = true AND SystemModstamp <= ${since}`, incrementalFilter]
      : [incrementalFilter];
    const nextCheckpoint = (): string | null => {
      // An empty first sync still needs a timestamp to publish the marker.
      const systemModstamp = watermark ?? (hasArchived ? "1970-01-01T00:00:00Z" : null);
      return systemModstamp
        ? JSON.stringify({ version: 1, systemModstamp, ...(hasArchived ? { archivedBackfill: true } : {}) })
        : checkpoint;
    };
    for (const filter of filters) {
      let yielded = false;
      for await (const batch of streamRawRecords(this, entity.key, fields, systemColumns, filter, batchSize)) {
        for (const row of batch) if (row.SystemModstamp && (!watermark || row.SystemModstamp > watermark)) watermark = row.SystemModstamp;
        yielded = true;
        yield { records: batch.map((row) => normalizeRecord(row, entity, this.targetTypes)), nextCheckpoint: nextCheckpoint() };
      }
      if (hasArchived && filter === incrementalFilter && !yielded) {
        yield { records: [], nextCheckpoint: nextCheckpoint() };
      }
    }
  }

  async *streamUsers(batchSize: number): AsyncGenerator<SourceUser[]> {
    const soql: string = "SELECT Id, Username, Email, FirstName, LastName, UserType, IsActive FROM User";
    for await (const batch of this.streamQuery(soql, batchSize, false)) {
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
      await this.getConnection().logout?.();
    }
    this.connected = false;
  }
}

function recordColumns(entity: CanonicalEntity) {
  assertApiName(entity.key);
  const keys = new Set(entity.attributes.map(({ key }) => key));
  keys.forEach(assertApiName);
  const optionalColumns = ["IsDeleted", "OwnerId", "CreatedById", "LastModifiedById"];
  const systemColumns = ["SystemModstamp", ...optionalColumns.filter((key) => keys.has(key))];
  const fields = ["Id", ...[...keys].filter((key) => key !== "Id" && !systemColumns.includes(key))];
  return { fields, systemColumns };
}

function hasArchivedBackfill(checkpoint: string): boolean {
  return checkpoint.startsWith("{") && JSON.parse(checkpoint).archivedBackfill === true;
}
export function decodeCheckpoint(checkpoint: string | null): string | null {
  if (checkpoint === null) return null;
  let value: unknown = checkpoint;
  if (checkpoint.startsWith("{")) {
    const parsed = JSON.parse(checkpoint) as { version?: unknown; systemModstamp?: unknown };
    if (parsed.version !== 1) throw new Error("Unsupported Salesforce checkpoint version");
    value = parsed.systemModstamp;
  }
  // Legacy bare timestamp cursors remain readable only in this adapter. Salesforce returns
  // SystemModstamp with a numeric offset ("...000+0000"); normalize every accepted form to UTC "Z".
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) throw new Error("Invalid Salesforce checkpoint");
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) throw new Error("Invalid Salesforce checkpoint");
  return value.endsWith("Z") ? value : new Date(time).toISOString();
}
