import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceClient, normalizeRecord, decodeCheckpoint } from "../src/sources/salesforce/client.js";
import { normalizeMetadata } from "../src/sources/salesforce/metadata.js";
import type { SourceRecord } from "../src/sources/salesforce/types.js";
import type { CanonicalEntity, ChangeBatch } from "../src/core/source.js";
import { field } from "./helpers/salesforce-fixture.js";

function source(): SourceClient { return new SourceClient({ mode: "oauth", instanceUrl: "https://example.salesforce.com", accessToken: "fixture" }); }

test("Salesforce adapter normalizes metadata, native values, qualified references and ownership", (): void => {
  const entity: CanonicalEntity = normalizeMetadata({ name: "Account", label: "Account", labelPlural: "Accounts", custom: false, fields: [
    field("Name", "string"), field("Tags__c", "multipicklist"), field("When__c", "datetime"),
    field("ParentId", "reference", { referenceTo: ["Account"] }), field("WhoId", "reference", { referenceTo: ["Contact", "Lead"] }),
  ] });
  const row: SourceRecord = { Id: "001", SystemModstamp: "2026-01-01T00:00:00Z", IsDeleted: true, OwnerId: "u1", CreatedById: "u2", LastModifiedById: "u3", Name: "Example", Tags__c: "enterprise;strategic", When__c: "2026-01-01T00:00:00Z", ParentId: "001-parent", WhoId: "003-person" };
  const normalized = normalizeRecord(row, entity, new Map([["003", "Contact"]]));
  assert.equal(normalized.sourceId, "001");
  assert.deepEqual(normalized.modifiedAt, new Date(row.SystemModstamp!));
  assert.equal(normalized.isDeleted, true); assert.equal(normalized.ownerSourceId, "u1");
  assert.equal(normalized.fields.Name, "Example");
  assert.deepEqual(normalized.fields.Tags__c, ["enterprise", "strategic"]);
  assert.deepEqual(normalized.fields.When__c, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(normalized.fields.ParentId, { kind: "reference", entityKey: "Account", sourceId: "001-parent" });
  assert.deepEqual(normalized.fields.WhoId, { kind: "reference", entityKey: "Contact", sourceId: "003-person" });
  assert.deepEqual(normalizeRecord({ Id: "1", WhoId: "unknown" }, entity).fields.WhoId, { kind: "unresolved-reference", sourceId: "unknown", candidateEntityKeys: ["Contact", "Lead"] });
  assert.equal(entity.attributes[1]?.dataType, "MultiEnum");
});

test("Salesforce adapter preserves query sharding and owns checkpoint interpretation", async (): Promise<void> => {
  const client: SourceClient = source();
  const queries: string[] = [];
  client.queryPage = async (query, includeDeleted) => {
    assert.equal(includeDeleted, true);
    queries.push(query);
    const records: SourceRecord[] = queries.length === 1 ? [{ Id: "001", SystemModstamp: "2026-01-01T00:00:00Z", OwnerId: "owner", f0: "first" }] : [{ Id: "001", f199: "last" }];
    return { records, totalSize: records.length, done: true };
  };
  const entity: CanonicalEntity = { key: "Account", label: "Account", pluralLabel: "Accounts", attributes: [
    { key: "SystemModstamp", label: "System Modstamp", dataType: "DateTime" },
    { key: "OwnerId", label: "Owner", dataType: "Text" },
    ...Array.from({ length: 200 }, (_value: unknown, index: number) => ({ key: `f${index}`, label: `f${index}`, dataType: "Text" as const })),
  ] };
  const batches: ChangeBatch[] = [];
  for await (const batch of client.fetchChanges(entity, "2025-01-01T00:00:00Z", 2)) batches.push(batch);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.match(query, /WHERE SystemModstamp > 2025-01-01T00:00:00Z/);
    const columns: string[] = query.split(" FROM ")[0]!.replace("SELECT ", "").split(", ");
    assert.equal(columns.filter((column: string): boolean => column === "Id").length, 1);
  }
  assert.equal(batches[0]?.records[0]?.fields.f0, "first");
  assert.equal(batches[0]?.records[0]?.fields.f199, "last");
  assert.equal(batches[0]?.records[0]?.ownerSourceId, "owner");
  assert.equal(decodeCheckpoint(batches[0]!.nextCheckpoint), "2026-01-01T00:00:00Z");
  assert.throws(() => decodeCheckpoint("page-token::abc123"), /Invalid Salesforce checkpoint/);
  // Real Salesforce SystemModstamp values carry a numeric offset, not "Z".
  assert.equal(decodeCheckpoint(JSON.stringify({ version: 1, systemModstamp: "2026-03-09T22:28:17.000+0000" })), "2026-03-09T22:28:17.000Z");
  assert.equal(decodeCheckpoint("2026-03-09T16:28:17.000-0600"), "2026-03-09T22:28:17.000Z");
  assert.throws(() => decodeCheckpoint("2026-03-09T22:28:17.000+99"), /Invalid Salesforce checkpoint/);
});

test("Salesforce adapter alone filters system objects and validates native API names", async (): Promise<void> => {
  const client: SourceClient = source();
  client.describeGlobal = async () => ["AccountHistory", "Custom__c"].map((name: string) => ({ name, label: name, custom: false, queryable: true, replicateable: true, deprecatedAndHidden: false, layoutable: true }));
  assert.deepEqual(await client.listEntities(), ["Custom__c"]);
  await assert.rejects(client.describeEntity("foo.bar"), /Invalid Salesforce API name/);
});
