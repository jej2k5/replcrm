import { isDeepStrictEqual } from "node:util";
import type { CanonicalAttribute, CanonicalValue, JsonValue, SourceChangeError, SourceChangeResult, ValidatedChange } from "../../core/source.js";
import { readTypedValue, toTypedValue } from "../../core/type-mapper.js";
import { assertApiName } from "./api-name.js";
import { normalizeRecord, toSourceValue } from "./values.js";
import type { SourceRecord } from "./types.js";

export function recordFilter(sourceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sourceId)) throw new Error("Invalid Salesforce record ID");
  return "WHERE Id = '" + sourceId + "'";
}

export class SalesforceResponseError extends Error {
  constructor(readonly response: Response, readonly errors: SourceChangeError[]) {
    super(errors[0]?.message ?? "Salesforce HTTP " + response.status);
  }

  get expiredSession(): boolean {
    return this.response.status === 401 || this.errors.some(({ code }) => code === "INVALID_SESSION_ID");
  }
}

export async function responseError(response: Response): Promise<SalesforceResponseError> {
  const body: unknown = await response.json().catch(() => null);
  const entries: unknown[] = Array.isArray(body) ? body : [body];
  return new SalesforceResponseError(response, entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("errorCode" in entry) || !("message" in entry)
      || typeof entry.errorCode !== "string" || typeof entry.message !== "string") return [];
    return [{
      code: entry.errorCode, message: entry.message,
      ...("fields" in entry && Array.isArray(entry.fields) && { fields: entry.fields as string[] }),
    }];
  }));
}

export function rejection(code: string, message: string): SourceChangeResult {
  return { status: "rejected", error: { code, message } };
}

export function failure(error: unknown, sent: boolean): SourceChangeResult {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SalesforceResponseError) {
    const { response, errors } = error;
    if (error.expiredSession || response.status === 429 || errors.some(({ code }) => code === "REQUEST_LIMIT_EXCEEDED") ||
      (!sent && (response.status >= 500 || response.status === 408))) {
      const retryAfter = response.headers.get("Retry-After");
      return { status: "failed", detail, ...(errors[0] && { error: errors[0] }), ...(retryAfter !== null && { retryAfter }) };
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      return { status: "rejected", error: errors[0] ?? { code: "HTTP_" + response.status, message: detail } };
    }
  }
  return sent
    ? { status: "unknown", detail: "Salesforce may have applied this change. It will never be retried automatically. " + detail }
    : { status: "failed", detail };
}

function comparable(attr: CanonicalAttribute, value: CanonicalValue): unknown {
  const canonical = attr.dataType === "DateTime" && typeof value === "string" ? new Date(value) : value;
  const typed = toTypedValue(attr.dataType, canonical, () => null);
  if ((attr.dataType === "Reference" || attr.dataType === "Composition") && value && typeof value === "object" && "sourceId" in value) {
    return value.sourceId;
  }
  return readTypedValue(attr.dataType, typed);
}

export async function sendChange(
  change: ValidatedChange,
  request: (path: string, init?: RequestInit) => Promise<Response>,
  targetTypes: ReadonlyMap<string, string>,
  attributionField?: string,
): Promise<SourceChangeResult> {
  const { entity, operation, fields, targetSourceId } = change;
  const entries = Object.entries(fields);
  let body: string;
  let path: string;
  let filter: string | undefined;
  const attributes = new Map(entity.attributes.map((attr) => [attr.key, attr]));
  try {
    assertApiName(entity.key);
    const values = Object.fromEntries(entries.map(([key, { value }]) => {
      assertApiName(key);
      const attr = attributes.get(key);
      if (!attr) throw new Error("Missing field metadata for " + key);
      return [key, toSourceValue(attr, value)];
    }));
    if (attributionField) values[attributionField] = change.authorKind + ": " + change.authorLabel;
    path = "/sobjects/" + entity.key;
    if (operation === "update") {
      filter = recordFilter(targetSourceId ?? "");
      path += "/" + encodeURIComponent(targetSourceId!);
    }
    body = JSON.stringify(values);
  } catch (error) {
    return rejection("INVALID_CHANGE", String(error));
  }

  if (filter && !change.overrideConflict) {
    const query = "SELECT " + entries.map(([key]) => key).join(", ") + " FROM " + entity.key + " " + filter;
    try {
      const response = await request("/query?q=" + encodeURIComponent(query));
      const { records } = await response.json() as { records: SourceRecord[] };
      const row = records[0];
      if (!row) return rejection("RECORD_UNAVAILABLE", "Record was deleted or is not visible in Salesforce");
      const { fields: current } = normalizeRecord(row, entity, targetTypes);
      const conflictValues = Object.fromEntries(entries.flatMap(([key, { base, value }]) => {
        if (!Object.hasOwn(current, key)) throw new Error("Salesforce did not return " + key);
        const attr = attributes.get(key)!;
        const sourceValue = current[key]!;
        if (isDeepStrictEqual(comparable(attr, sourceValue), comparable(attr, base!))) return [];
        const serialized = JSON.parse(JSON.stringify(sourceValue)) as JsonValue;
        return [[key, { base: base!, replicaValue: value, sourceValue: serialized }]];
      }));
      if (Object.keys(conflictValues).length) return { status: "conflict", conflictValues };
    } catch (error) {
      return failure(error, false);
    }
  }

  try {
    const response = await request(path, { method: operation === "create" ? "POST" : "PATCH", body });
    if (operation === "update") {
      if (response.status !== 204) throw new Error("Unexpected update response status " + response.status);
      return { status: "applied", sourceId: targetSourceId!, modifiedAt: null };
    }
    const result = await response.json() as { id?: unknown; success?: boolean };
    if (result.success !== true || typeof result.id !== "string" || !result.id) {
      throw new Error("The create response did not confirm a record ID");
    }
    return { status: "applied", sourceId: result.id, modifiedAt: null };
  } catch (error) {
    return failure(error, true);
  }
}
