import type { CanonicalEntity, CanonicalValue, SourceRecord as CanonicalRecord, JsonValue } from "../../core/source.js";
import type { SourceRecord } from "./types.js";

export function normalizeRecord(row: SourceRecord, entity: CanonicalEntity, targetTypes: ReadonlyMap<string, string> = new Map()): CanonicalRecord {
  const fields: Record<string, CanonicalValue> = {};
  for (const attr of entity.attributes) {
    if (!Object.prototype.hasOwnProperty.call(row, attr.key)) continue;
    const raw: unknown = row[attr.key];
    if (raw === null || raw === undefined) { fields[attr.key] = null; continue; }
    switch (attr.dataType) {
      case "MultiEnum": fields[attr.key] = Array.isArray(raw) ? raw.map(String) : String(raw).split(";").filter((item: string): boolean => item.length > 0); break;
      case "Number": case "Currency": case "Percent": fields[attr.key] = typeof raw === "number" ? raw : String(raw); break;
      case "Boolean": fields[attr.key] = raw === true || raw === "true"; break;
      case "Date": fields[attr.key] = String(raw).slice(0, 10); break;
      case "DateTime": fields[attr.key] = new Date(String(raw)); break;
      case "Time": fields[attr.key] = String(raw).replace(/Z$/, ""); break;
      case "Address": case "Geolocation": fields[attr.key] = raw as JsonValue; break;
      case "Reference": case "Composition": {
        const sourceId: string = String(raw);
        const candidates: string[] = attr.relationship?.targetEntityKeys ?? [];
        const inferred: string | undefined = targetTypes.get(sourceId.slice(0, 3));
        const entityKey: string | undefined = candidates.length === 1 ? candidates[0] : inferred && candidates.includes(inferred) ? inferred : undefined;
        fields[attr.key] = entityKey ? { kind: "reference", entityKey, sourceId } : { kind: "unresolved-reference", sourceId, candidateEntityKeys: candidates };
        break;
      }
      default: fields[attr.key] = String(raw);
    }
  }
  const userId = (value: unknown): string | null => typeof value === "string" ? value : null;
  return {
    sourceId: row.Id,
    modifiedAt: row.SystemModstamp ? new Date(row.SystemModstamp) : null,
    isDeleted: row.IsDeleted === true,
    ownerSourceId: userId(row.OwnerId), createdBySourceId: userId(row.CreatedById), lastModifiedBySourceId: userId(row.LastModifiedById), fields,
  };
}
