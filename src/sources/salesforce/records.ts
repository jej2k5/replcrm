import type { SourceClient } from "./client.js";
import type { SourceRecord } from "./types.js";

// Salesforce REST rejects SELECT statements with more than 200 fields.
// Practically, we cap below 200 to leave room for the system columns the
// builder always appends and a small safety margin. Objects with more user-
// fields than this trigger a multi-query split (see streamRecords below).
const SOQL_FIELD_THRESHOLD: number = 180;

// Yields per-`batchSize` slices of merged Salesforce rows. When the entity
// has at most SOQL_FIELD_THRESHOLD user-fields, this is a thin wrapper over
// source.queryAll. When it has more, the user-fields are sharded across
// multiple SOQL queries (Id is included in every shard) and shards are
// merged by Id in memory before being yielded.
//
// Memory note: the multi-shard path materialises every record in memory
// before merging, which is fine for incremental syncs but may need
// revisiting (cursor-driven sub-paging) if a single full-pull batch grows
// past the host's RAM. Acceptable for Phase 1 / MVP.
export async function* streamRawRecords(
  source: SourceClient,
  entityKey: string,
  userFields: string[],
  systemColumns: readonly string[],
  sinceCursor: string | null,
  batchSize: number,
): AsyncGenerator<SourceRecord[]> {
  const where: string = sinceCursor ? `WHERE SystemModstamp > ${sinceCursor}` : "";
  const systemFieldList: string = systemColumns.join(", ");
  const totalFields: number = userFields.length + systemColumns.length;

  if (totalFields <= SOQL_FIELD_THRESHOLD) {
    const fieldList: string = userFields.join(", ");
    const soql: string = `SELECT ${fieldList}${userFields.length ? ", " : ""}${systemFieldList} FROM ${entityKey} ${where} ORDER BY SystemModstamp ASC`;
    for await (const batch of source.queryAll(soql, batchSize)) yield batch;
    return;
  }

  // Multi-shard path — split userFields into chunks. `Id` is added to every
  // shard so we can merge results by record id. SystemModstamp / IsDeleted /
  // ownership FKs go in the first shard only (no point duplicating).
  const headroom: number = SOQL_FIELD_THRESHOLD - systemColumns.length - 1; // -1 for Id
  const shards: string[][] = [];
  for (let i = 0; i < userFields.length; i += headroom) {
    shards.push(userFields.slice(i, i + headroom));
  }
  console.warn(
    `[record-sync] ${entityKey} has ${userFields.length} user-fields (> ${SOQL_FIELD_THRESHOLD}); splitting into ${shards.length} SOQL shards.`,
  );

  const merged: Map<string, SourceRecord> = new Map();
  for (let s = 0; s < shards.length; s += 1) {
    const shardFields: string[] = shards[s] ?? [];
    const fieldList: string = [...new Set(["Id", ...shardFields])].join(", ");
    const tail: string = s === 0 ? `, ${systemFieldList}` : "";
    const soql: string = `SELECT ${fieldList}${tail} FROM ${entityKey} ${where} ORDER BY SystemModstamp ASC`;
    for await (const batch of source.queryAll(soql, batchSize)) {
      for (const row of batch) {
        const existing: SourceRecord | undefined = merged.get(row.Id);
        if (existing) Object.assign(existing, row);
        else merged.set(row.Id, { ...row });
      }
    }
  }

  // Yield merged rows in `batchSize`-sized slices preserving SystemModstamp
  // order (the first shard's iteration set the insertion order in the Map).
  let buffer: SourceRecord[] = [];
  for (const row of merged.values()) {
    buffer.push(row);
    if (buffer.length >= batchSize) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer;
}
