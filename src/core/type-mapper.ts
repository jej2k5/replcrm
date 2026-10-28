import { AttributeDataType } from "./model.js";
import { Decimal } from "decimal.js";
import type { CanonicalValue, JsonValue, RecordReference, UnresolvedReference } from "./source.js";

export interface TypedValue {
  textValue: string | null;
  numberValue: Decimal | null;
  booleanValue: boolean | null;
  dateValue: Date | null;
  dateTimeValue: Date | null;
  referenceValue: string | null;
  jsonValue: JsonValue | null;
}
const EMPTY_VALUE: TypedValue = { textValue: null, numberValue: null, booleanValue: null, dateValue: null, dateTimeValue: null, referenceValue: null, jsonValue: null };

export function isReference(value: unknown): value is RecordReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<RecordReference>;
  return ref.kind === "reference" && typeof ref.entityKey === "string" && typeof ref.sourceId === "string";
}
export function isUnresolvedReference(value: unknown): value is UnresolvedReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<UnresolvedReference>;
  return ref.kind === "unresolved-reference" && typeof ref.sourceId === "string" && Array.isArray(ref.candidateEntityKeys) && ref.candidateEntityKeys.every((key: unknown): boolean => typeof key === "string");
}
function assertJson(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(assertJson); return;
  }
  throw new Error("Canonical JSON value required");
}

// This converts canonical values into storage columns; it never decodes a source format.
export function toTypedValue(dataType: AttributeDataType, value: CanonicalValue, resolveReference: (ref: RecordReference) => string | null): TypedValue {
  const out: TypedValue = { ...EMPTY_VALUE };
  if (value === null) return out;
  switch (dataType) {
    case "Number": case "Currency": case "Percent":
      if ((typeof value !== "number" && typeof value !== "string") || value === "") throw new Error("Canonical number or decimal string required");
      out.numberValue = new Decimal(value);
      if (!out.numberValue.isFinite()) throw new Error("Finite canonical number required");
      // Preserve the existing replica decimal domain in both store implementations.
      out.numberValue = out.numberValue.toDecimalPlaces(18, Decimal.ROUND_HALF_UP);
      if (out.numberValue.abs().gte("100000000000000000000")) throw new Error("Canonical decimal exceeds 20 integer digits");
      return out;
    case "Boolean":
      if (typeof value !== "boolean") throw new Error("Canonical boolean required");
      out.booleanValue = value; return out;
    case "Date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Canonical date YYYY-MM-DD required");
      out.dateValue = new Date(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(out.dateValue.getTime()) || out.dateValue.toISOString().slice(0, 10) !== value) throw new Error("Invalid canonical date");
      return out;
    case "DateTime":
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Canonical datetime Date required");
      out.dateTimeValue = value; return out;
    case "Time":
      if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(value)) throw new Error("Canonical time HH:mm:ss[.SSS] required");
      out.textValue = value; return out;
    case "MultiEnum":
      if (!Array.isArray(value) || !value.every((item: unknown): boolean => typeof item === "string")) throw new Error("Canonical collection of strings required");
      out.jsonValue = value; return out;
    case "Address": case "Geolocation":
      assertJson(value); out.jsonValue = value; return out;
    case "Reference": case "Composition":
      if (!isReference(value) && !isUnresolvedReference(value)) throw new Error("Canonical qualified reference required");
      out.referenceValue = isReference(value) ? resolveReference(value) : null;
      out.jsonValue = { ...value }; return out;
    default:
      if (typeof value !== "string") throw new Error(`Canonical string required for ${dataType}`);
      out.textValue = value; return out;
  }
}

export function readTypedValue(dataType: AttributeDataType, value: TypedValue): CanonicalValue {
  switch (dataType) {
    case "Number": case "Currency": case "Percent": return value.numberValue?.toString() ?? null;
    case "Boolean": return value.booleanValue;
    case "Date": return value.dateValue?.toISOString().slice(0, 10) ?? null;
    case "DateTime": return value.dateTimeValue;
    case "Time": return value.textValue;
    case "MultiEnum": case "Address": case "Geolocation": return value.jsonValue;
    case "Reference": case "Composition":
      if (value.jsonValue !== null && !isReference(value.jsonValue) && !isUnresolvedReference(value.jsonValue)) throw new Error("Stored reference requires canonical source replay");
      return value.jsonValue;
    default: return value.textValue;
  }
}
