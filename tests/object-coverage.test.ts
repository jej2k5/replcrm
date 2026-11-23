import assert from "node:assert/strict";
import { test } from "node:test";
import { runMetadataStage, runRecordsStage, selectEntityKeys } from "../src/core/orchestrator.js";
import { SourceClient, type SourceObjectListing } from "../src/sources/salesforce/client.js";
import type { SourceRecord } from "../src/sources/salesforce/types.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { config } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { describe, field } from "./helpers/salesforce-fixture.js";

const whoTargets = ["Contact", "Lead"];
const whatTargets = ["Account", "Opportunity", "Invoice__c"];
const who = field("WhoId", "reference", { referenceTo: whoTargets });
const what = field("WhatId", "reference", { referenceTo: whatTargets });
const id = field("Id", "id");
const stamp = field("SystemModstamp", "datetime");
const system = [
  id, stamp, field("IsDeleted", "boolean"),
  field("CreatedById", "reference", { referenceTo: ["User"] }),
  field("LastModifiedById", "reference", { referenceTo: ["User"] }),
];
const owned = [...system, field("OwnerId", "reference", { referenceTo: ["User", "Group"] })];

const descriptions = new Map([
  ["Account", describe("Account", [...owned, field("Name", "string")])],
  ["Contact", describe("Contact", [...owned, field("LastName", "string")])],
  ["Task", describe("Task", [
    ...owned, field("Subject", "string"), field("Status", "picklist", {
      picklistValues: [{ value: "Completed", label: "Completed", defaultValue: false, active: true }],
    }), field("ActivityDate", "date"), who, what, field("IsArchived", "boolean"),
  ])],
  ["Event", describe("Event", [
    ...owned, field("Subject", "string"), field("StartDateTime", "datetime"),
    field("EndDateTime", "datetime"), who, what, field("IsArchived", "boolean"),
  ])],
  ["Invoice__c", describe("Invoice__c", [
    ...owned, field("Amount__c", "currency", { custom: true, precision: 12, scale: 2 }),
    field("Account__c", "reference", { custom: true, referenceTo: ["Account"] }),
  ])],
  ["Invoice_Line__c", describe("Invoice_Line__c", [
    ...system, field("Invoice__c", "reference", { custom: true, referenceTo: ["Invoice__c"], cascadeDelete: true }),
  ])],
  ["NoStamp__c", describe("NoStamp__c", [id])],
  ["NoDeletion__c", describe("NoDeletion__c", [id, stamp])],
]);

const modified = "2026-01-01T00:00:00Z";
const records = new Map<string, SourceRecord[]>([
  ["Account", [{ Id: "001-account", Name: "Example" }]],
  ["Contact", [{ Id: "003-contact", LastName: "Example" }]],
  ["Task", [
    { Id: "00T-task", Subject: "Follow up", Status: "Completed", ActivityDate: "2026-01-01",
      WhoId: "003-contact", WhatId: "a01-invoice", IsArchived: true },
    { Id: "00T-lead", Subject: "Qualify", WhoId: "00Q-lead", WhatId: "001-account" },
  ]],
  ["Event", [{ Id: "00U-event", Subject: "Review", WhoId: "003-contact", WhatId: "001-account",
    StartDateTime: "2026-01-01T09:00:00Z", EndDateTime: "2026-01-01T10:00:00Z" }]],
  ["Invoice__c", [{ Id: "a01-invoice", Amount__c: 12.5, Account__c: "001-account" }]],
  ["Invoice_Line__c", [{ Id: "a02-line", Invoice__c: "a01-invoice" }]],
  ["NoDeletion__c", [{ Id: "a03-record" }]],
]);

function listing(name: string, keyPrefix?: string, overrides: Partial<SourceObjectListing> = {}) {
  return { name, keyPrefix, label: name, custom: name.endsWith("__c"), queryable: true,
    replicateable: true, deprecatedAndHidden: false, layoutable: true, ...overrides };
}

function fixture() {
  const client = new SourceClient({ mode: "oauth", instanceUrl: "https://example.invalid", accessToken: "fixture-access" });
  const sobjects = [
    listing("Account", "001"), listing("Contact", "003"), listing("Lead", "00Q"),
    listing("Opportunity", "006"), listing("Task", "00T"), listing("Event", "00U"),
    listing("Invoice__c", "a01"), listing("Invoice_Line__c", "a02"),
    listing("NonReplicateable", undefined, { replicateable: false }),
    listing("NonQueryable", undefined, { queryable: false }),
    listing("Hidden", undefined, { deprecatedAndHidden: true }),
    ...["History", "Share", "Feed", "ChangeEvent", "__Tag"].map((suffix) => listing("Account" + suffix)),
  ];
  Object.assign(client, { connection: { describeGlobal: async () => ({ sobjects }) } });
  const queries: string[] = [];
  const described: string[] = [];
  client.describeObject = async (key) => {
    described.push(key);
    const definition = descriptions.get(key);
    assert.ok(definition, "Missing fixture describe for " + key);
    return definition;
  };
  client.queryPage = async (query, includeDeleted) => {
    queries.push(query);
    assert.equal(includeDeleted, true);
    const select = /^SELECT (.+?) FROM (\w+)(.*)$/.exec(query);
    assert.ok(select, "Invalid fixture query " + query);
    const [, list, key, tail] = select;
    const definition = descriptions.get(key!);
    assert.ok(definition, "Unknown object " + key);
    const available = new Set(definition.fields.map(({ name }) => name));
    const count = list === "COUNT()";
    const fields = count ? [] : list!.split(/,\s*/);
    for (const name of fields) assert.ok(available.has(name), key + " has no field " + name);
    const activeOnly = tail!.includes("IsDeleted = false");
    if (activeOnly) assert.ok(available.has("IsDeleted"), key + " has no IsDeleted filter field");
    const rows = (records.get(key!) ?? []).map((row): SourceRecord => ({
      SystemModstamp: modified, ...(available.has("IsDeleted") ? { IsDeleted: false } : {}), ...row,
    })).filter((row) => !activeOnly || row.IsDeleted === false);
    return {
      done: true,
      totalSize: rows.length,
      records: count ? [] : rows.map((row) => Object.fromEntries(fields.filter((name) => name in row)
        .map((name) => [name, row[name]])) as SourceRecord),
    };
  };
  return { client, queries, described };
}

test("Task and Event describe polymorphic WhoId and WhatId references", async () => {
  const { client } = fixture();
  for (const key of ["Task", "Event"]) {
    const entity = await client.describeEntity(key);
    for (const [name, targets] of [["WhoId", whoTargets], ["WhatId", whatTargets]] as const) {
      const attr = entity.attributes.find(({ key }) => key === name);
      assert.equal(attr?.dataType, "Reference");
      assert.equal(attr?.relationship?.kind, "Reference");
      assert.deepEqual(attr?.relationship?.targetEntityKeys, targets);
    }
  }
});

test("Task rows qualify polymorphic references using describeGlobal key prefixes", async () => {
  const { client } = fixture();
  const task = await client.describeEntity("Task");
  const qualified = [];
  for await (const batch of client.fetchChanges(task, null, 1)) {
    for (const { fields } of batch.records) qualified.push([fields.WhoId, fields.WhatId]);
  }
  assert.deepEqual(qualified, [
    [{ kind: "reference", entityKey: "Contact", sourceId: "003-contact" },
      { kind: "reference", entityKey: "Invoice__c", sourceId: "a01-invoice" }],
    [{ kind: "reference", entityKey: "Lead", sourceId: "00Q-lead" },
      { kind: "reference", entityKey: "Account", sourceId: "001-account" }],
  ]);
});

test("custom lookup and master-detail attributes normalize as Reference and Composition", async () => {
  const { client } = fixture();
  const invoice = await client.describeEntity("Invoice__c");
  const line = await client.describeEntity("Invoice_Line__c");
  assert.equal(invoice.isCustom, true);
  assert.equal(line.isCustom, true);
  for (const [entity, key, type, target] of [
    [invoice, "Account__c", "Reference", "Account"],
    [line, "Invoice__c", "Composition", "Invoice__c"],
  ] as const) {
    const attr = entity.attributes.find((attr) => attr.key === key);
    assert.equal(attr?.dataType, type);
    assert.equal(attr?.relationship?.kind, type);
    assert.deepEqual(attr?.relationship?.targetEntityKeys, [target]);
    assert.equal(attr?.relationship?.cascadeDelete, type === "Composition");
  }
});

test("PGlite replicates activities and custom objects and repairs forward references", async () => {
  const { client, described } = fixture();
  const { db, prisma } = await database();
  const store = new PostgresReplicaStore(prisma);
  // Children and activities precede their targets so the store must repair forward references.
  const entityKeys = ["Invoice_Line__c", "Event", "Task", "Invoice__c", "Contact", "Account"];
  const deps = { config: { ...config, entityKeys }, store, sourceClient: client };
  try {
    await store.ensureDeployment(config.deploymentId, "Object coverage");
    const definitions = await runMetadataStage(deps);
    await runRecordsStage(deps, definitions);
    const counts = await store.countRecords(config.deploymentId);
    for (const key of entityKeys) {
      assert.equal(counts.get(key), records.get(key)!.length);
      assert.equal(await client.countRecords(key), counts.get(key));
    }
    assert.deepEqual(described, entityKeys);
    const line = await prisma.record.findFirst({ where: { deploymentId: config.deploymentId, sourceId: "a02-line" } });
    assert.ok(line);
    assert.equal(line.ownerId, null);
    const values = (await db.query<{
      source: string;
      key: string;
      target: string | null;
      jsonValue: unknown;
      textValue: string | null;
      numberValue: string | null;
    }>(`
      SELECT r."sourceId" AS source, a.key, target."sourceId" AS target,
             v."jsonValue", v."textValue", v."numberValue"
      FROM "AttributeValue" v
      JOIN "Record" r ON r.id = v."recordId"
      JOIN "AttributeDefinition" a ON a.id = v."attributeDefinitionId"
      LEFT JOIN "Record" target ON target.id = v."referenceValue"
      ORDER BY r."sourceId" COLLATE "C", a.key COLLATE "C"
    `)).rows;
    const refs = values.filter((row) => ["WhoId", "WhatId", "Account__c", "Invoice__c"].includes(String(row.key)));
    assert.deepEqual(refs.map(({ source, key, target }) => [source, key, target]), [
      ["00T-lead", "WhatId", "001-account"],
      ["00T-lead", "WhoId", null],
      ["00T-task", "WhatId", "a01-invoice"],
      ["00T-task", "WhoId", "003-contact"],
      ["00U-event", "WhatId", "001-account"],
      ["00U-event", "WhoId", "003-contact"],
      ["a01-invoice", "Account__c", "001-account"],
      ["a02-line", "Invoice__c", "a01-invoice"],
    ]);
    assert.deepEqual(refs.find(({ source, key }) => source === "00T-lead" && key === "WhoId")?.jsonValue,
      { kind: "reference", entityKey: "Lead", sourceId: "00Q-lead" });
    const relations = await prisma.relationDefinition.findMany({ orderBy: { relationName: "asc" } });
    assert.deepEqual(relations.map(({ relationName, relationType, cascadeDelete }) =>
      [relationName, relationType, cascadeDelete]), [
      ["Account__c", "Reference", false], ["Invoice__c", "Composition", true],
    ]);
    assert.equal(values.find(({ key }) => key === "Status")?.textValue, "Completed");
    assert.equal(Number(values.find(({ key }) => key === "Amount__c")?.numberValue), 12.5);
  } finally {
    await db.close();
  }
});

test("master-detail child omits OwnerId in record queries and persists without an owner", async () => {
  const { client, queries } = fixture();
  const store = new InMemoryReplicaStore();
  const deps = { config: { ...config, entityKeys: ["Invoice_Line__c"] }, store, sourceClient: client };
  await store.ensureDeployment(config.deploymentId, "Ownerless child");
  const definitions = await runMetadataStage(deps);
  await runRecordsStage(deps, definitions);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0]!, /\bOwnerId\b/);
  const record = store.readRecords(config.deploymentId, "Invoice_Line__c")[0];
  assert.ok(record);
  assert.equal(record.ownerSourceId, null);
  assert.equal(record.resolvedReferences.Invoice__c, null);
});

test("wildcard expansion requires queryable and replicateable objects and applies exclusions", async () => {
  const { client } = fixture();
  assert.deepEqual(await client.listEntities(),
    ["Account", "Contact", "Lead", "Opportunity", "Task", "Event", "Invoice__c", "Invoice_Line__c"]);
  assert.deepEqual(await selectEntityKeys({
    ...config, entityKeys: ["*"], entityDenyKeys: ["Lead", "Opportunity"],
  }, client), ["Account", "Contact", "Task", "Event", "Invoice__c", "Invoice_Line__c"]);
});

test("explicit objects without SystemModstamp fail in metadata before a record query", async () => {
  const { client, queries } = fixture();
  const store = new InMemoryReplicaStore();
  await store.ensureDeployment(config.deploymentId, "No incremental cursor");
  await assert.rejects(runMetadataStage({
    config: { ...config, entityKeys: ["NoStamp__c"] }, store, sourceClient: client,
  }), { message: "Object NoStamp__c cannot be synced incrementally: it has no SystemModstamp field" });
  assert.deepEqual(queries, []);
});

test("count and live-ID reads share a cached describe and omit unavailable IsDeleted", async () => {
  const { client, queries, described } = fixture();
  assert.equal(await client.countRecords("NoDeletion__c"), 1);
  const ids = [];
  for await (const batch of client.listSourceIds("NoDeletion__c", 1)) ids.push(...batch);
  assert.deepEqual(ids, ["a03-record"]);
  assert.deepEqual(queries, ["SELECT COUNT() FROM NoDeletion__c", "SELECT Id FROM NoDeletion__c"]);
  assert.deepEqual(described, ["NoDeletion__c"]);
});
