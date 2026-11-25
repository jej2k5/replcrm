// A fictional Salesforce org held in memory for `npm run demo`. It never opens a network connection.
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CanonicalAttribute, CanonicalEntity, CanonicalValue, ChangeBatch, CrmSource, JsonValue,
  SourceChangeResult, SourceRecord, SourceUser, ValidatedChange,
} from "../core/source.js";

type Fields = Record<string, CanonicalValue>;
interface FakeRecord { sourceId: string; modifiedAt: Date; fields: Fields }

const text = (key: string, label: string, extra: Partial<CanonicalAttribute> = {}): CanonicalAttribute => ({
  key, label, dataType: "Text", isUpdatable: true, isCreatable: true, isNullable: true, ...extra,
});
const name = (key = "Name"): CanonicalAttribute => text(key, "Name", { isNameField: true, isRequired: true, isNullable: false });
const picklist = (key: string, label: string, values: string[], extra: Partial<CanonicalAttribute> = {}): CanonicalAttribute => text(key, label, {
  dataType: "Enum", ...extra,
  enumOptions: values.map((value, sortOrder) => ({ value, label: value, isActive: true, isDefault: sortOrder === 0, sortOrder })),
});
const reference = (key: string, label: string, target: string, relationship: string): CanonicalAttribute => text(key, label, {
  dataType: "Reference", relationship: { targetEntityKeys: [target], kind: "Reference", name: relationship, cascadeDelete: false },
});
const modstamp: CanonicalAttribute = {
  key: "SystemModstamp", label: "System Modstamp", dataType: "DateTime", isSystem: true, isUpdatable: false, isCreatable: false,
};

const stages = ["Prospecting", "Qualification", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
const industries = ["Manufacturing", "Healthcare", "Financial Services", "Retail", "Energy", "Technology", "Logistics"];

export const demoEntities: CanonicalEntity[] = [
  { key: "Account", label: "Account", pluralLabel: "Accounts", attributes: [
    name(), picklist("Industry", "Industry", industries), text("BillingCity", "Billing City"),
    text("AnnualRevenue", "Annual Revenue", { dataType: "Currency" }), text("Phone", "Phone", { dataType: "Phone" }), modstamp,
  ] },
  { key: "Contact", label: "Contact", pluralLabel: "Contacts", attributes: [
    text("FirstName", "First Name"), text("LastName", "Last Name", { isRequired: true, isNullable: false }),
    name("Name"), text("Email", "Email", { dataType: "Email" }), text("Title", "Title"),
    reference("AccountId", "Account", "Account", "Account"), modstamp,
  ].map((attr) => attr.key === "Name" ? { ...attr, isRequired: false, isUpdatable: false, isCreatable: false, isComputed: true } : attr) },
  { key: "Opportunity", label: "Opportunity", pluralLabel: "Opportunities", attributes: [
    name(), text("Amount", "Amount", { dataType: "Currency" }), picklist("StageName", "Stage", stages, { isRequired: true, isNullable: false }),
    text("CloseDate", "Close Date", { dataType: "Date", isRequired: true, isNullable: false }),
    reference("AccountId", "Account", "Account", "Account"), modstamp,
  ] },
  { key: "Case", label: "Case", pluralLabel: "Cases", attributes: [
    text("Subject", "Subject", { isNameField: true }), picklist("Status", "Status", ["New", "Working", "Escalated", "Closed"]),
    picklist("Priority", "Priority", ["Low", "Medium", "High"]),
    reference("AccountId", "Account", "Account", "Account"), reference("ContactId", "Contact", "Contact", "Contact"), modstamp,
  ] },
];

const companies = ["Northgate Traders", "Blue Heron Foods", "Copperline Steel", "Lakeshore Health", "Meridian Freight",
  "Quarry Hill Energy", "Pinecrest Retail", "Harbor Point Bank", "Tallgrass Robotics", "Summit Ridge Clinics",
  "Ironwood Logistics", "Fieldstone Mills", "Brightwater Labs", "Oak & Anchor Outfitters", "Redwing Analytics",
  "Stonebridge Insurance", "Cedar Valley Farms", "Lumen Grid", "Granite Peak Software", "Willow Creek Pharma",
  "Bay Street Capital", "Kestrel Aerospace", "Marigold Markets", "Silverline Transit", "Prairie Wind Power"];
const cities = ["Chicago", "Denver", "Austin", "Portland", "Atlanta", "Minneapolis", "Columbus", "Raleigh", "Boise", "Madison"];
const firstNames = ["Avery", "Jordan", "Priya", "Mateo", "Hana", "Samuel", "Leila", "Marcus", "Ingrid", "Tomás", "Noor",
  "Grace", "Daniel", "Yuki", "Olivia", "Ravi", "Elena", "Kofi", "Maya", "Felix"];
const lastNames = ["Okafor", "Lindqvist", "Ramirez", "Chen", "Patel", "Nakamura", "Brennan", "Haddad", "Novak", "Moreau",
  "Adeyemi", "Kowalski", "Silva", "Fischer", "Iqbal", "Duarte", "Larsen", "Mensah", "Sato", "Quinn"];
const titles = ["VP Operations", "Director of IT", "Procurement Manager", "CFO", "Head of Sales Ops", "Controller", "COO"];
const subjects = ["Invoice does not match PO", "Login fails after password reset", "Shipment arrived damaged",
  "Request for SSO setup", "API rate limit questions", "Renewal quote needed", "Data export is incomplete"];

/** Deterministic pseudo-random numbers so every demo starts from the same org. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const ref = (entityKey: string, sourceId: string): CanonicalValue => ({ kind: "reference", entityKey, sourceId });

export class FakeOrg implements CrmSource {
  private readonly records = new Map<string, Map<string, FakeRecord>>();
  private readonly random = generator(20261123);
  private readonly counters = new Map<string, number>();
  private clock: number;
  apiCalls = 0;
  /** Simulated API latency per call, so a sync takes long enough to watch. */
  latencyMs = 0;

  constructor(now = Date.now()) {
    this.clock = now - 30 * 86_400_000;
    for (const entity of demoEntities) this.records.set(entity.key, new Map());
    this.seed();
  }

  private pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.random() * values.length)]!;
  }

  // Strictly increasing modification times keep the timestamp checkpoints exact.
  private tick(): Date {
    this.clock += 1_000 + Math.floor(this.random() * 60_000);
    return new Date(this.clock);
  }

  private nextId(entityKey: string): string {
    const prefix = { Account: "001", Contact: "003", Opportunity: "006", Case: "500" }[entityKey] ?? "a00";
    const count = (this.counters.get(entityKey) ?? 0) + 1;
    this.counters.set(entityKey, count);
    return `${prefix}DEMO${String(count).padStart(8, "0")}`;
  }

  private put(entityKey: string, fields: Fields, sourceId = this.nextId(entityKey)): FakeRecord {
    const record = { sourceId, modifiedAt: this.tick(), fields };
    this.records.get(entityKey)!.set(sourceId, record);
    return record;
  }

  private ids(entityKey: string): string[] {
    return [...this.records.get(entityKey)!.keys()];
  }

  private date(daysFromToday: number): string {
    return new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
  }

  private seed(): void {
    for (const [index, company] of companies.entries()) {
      this.put("Account", {
        Name: company, Industry: this.pick(industries), BillingCity: this.pick(cities),
        AnnualRevenue: Math.round(5 + this.random() * 495) * 100_000, Phone: `+1 312 555 ${String(1_000 + index * 37).slice(-4)}`,
      });
    }
    const accounts = this.ids("Account");
    for (let index = 0; index < 80; index++) this.addContact(this.pick(accounts));
    for (let index = 0; index < 40; index++) {
      const account = this.pick(accounts);
      this.put("Opportunity", {
        Name: `${this.records.get("Account")!.get(account)!.fields.Name as string} ${this.pick(["renewal", "expansion", "pilot", "upgrade"])}`,
        Amount: Math.round(10 + this.random() * 240) * 1_000, StageName: this.pick(stages),
        CloseDate: this.date(Math.floor(this.random() * 120) - 20), AccountId: ref("Account", account),
      });
    }
    const contacts = this.ids("Contact");
    for (let index = 0; index < 40; index++) this.addCase(this.pick(accounts), this.pick(contacts));
  }

  private addContact(account: string): FakeRecord {
    const first = this.pick(firstNames), last = this.pick(lastNames);
    const domain = (this.records.get("Account")!.get(account)!.fields.Name as string).toLowerCase().replace(/[^a-z]+/g, "");
    return this.put("Contact", {
      FirstName: first, LastName: last, Name: `${first} ${last}`,
      Email: `${first.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")}.${last.toLowerCase()}@${domain}.example.com`,
      Title: this.pick(titles), AccountId: ref("Account", account),
    });
  }

  private addCase(account: string, contact: string): FakeRecord {
    return this.put("Case", {
      Subject: this.pick(subjects), Status: this.pick(["New", "Working", "Escalated"]), Priority: this.pick(["Low", "Medium", "High"]),
      AccountId: ref("Account", account), ContactId: ref("Contact", contact),
    });
  }

  /** New activity in the org, as if people were working in Salesforce between syncs. */
  simulateActivity(): void {
    this.clock = Math.max(this.clock, Date.now() - 10_000);
    const accounts = this.ids("Account");
    const prospects = this.ids("Opportunity").filter((id) => this.field("Opportunity", id, "StageName") === "Prospecting");
    const opportunity = this.records.get("Opportunity")!.get(this.pick(prospects))!;
    opportunity.fields = { ...opportunity.fields, Amount: (opportunity.fields.Amount as number) + 5_000 };
    opportunity.modifiedAt = this.tick();
    const support = this.records.get("Case")!.get(this.pick(this.ids("Case")))!;
    support.fields = { ...support.fields, Status: this.pick(["Working", "Escalated", "Closed"]) };
    support.modifiedAt = this.tick();
    this.addCase(this.pick(accounts), this.pick(this.ids("Contact")));
  }

  count(entityKey: string): number {
    return this.records.get(entityKey)?.size ?? 0;
  }

  field(entityKey: string, sourceId: string, key: string): CanonicalValue | undefined {
    return this.records.get(entityKey)?.get(sourceId)?.fields[key];
  }

  firstId(entityKey: string, matches: (fields: Fields) => boolean = () => true): string {
    const found = [...this.records.get(entityKey)!.values()].find((record) => matches(record.fields));
    if (!found) throw new Error(`No demo ${entityKey} matches`);
    return found.sourceId;
  }

  async connect(): Promise<void> {}
  async logout(): Promise<void> {}

  async listEntities(): Promise<string[]> {
    this.apiCalls++;
    return demoEntities.map(({ key }) => key);
  }

  async describeEntity(entityKey: string): Promise<CanonicalEntity> {
    this.apiCalls++;
    await sleep(this.latencyMs);
    const entity = demoEntities.find(({ key }) => key === entityKey);
    if (!entity) throw new Error(`Unknown demo object ${entityKey}`);
    return structuredClone(entity);
  }

  async countRecords(entityKey: string): Promise<number> {
    this.apiCalls++;
    return this.count(entityKey);
  }

  async *fetchChanges(entity: CanonicalEntity, checkpoint: string | null, batchSize: number): AsyncGenerator<ChangeBatch> {
    const since = checkpoint ? Date.parse(checkpoint) : -Infinity;
    const changed = [...this.records.get(entity.key)!.values()]
      .filter((record) => record.modifiedAt.getTime() > since)
      .sort((left, right) => left.modifiedAt.getTime() - right.modifiedAt.getTime());
    const latest = changed.at(-1)?.modifiedAt.toISOString() ?? checkpoint;
    for (let start = 0; start < changed.length || start === 0; start += batchSize) {
      this.apiCalls++;
      await sleep(this.latencyMs);
      const page = changed.slice(start, start + batchSize);
      yield { records: page.map((record) => this.toSource(entity, record)), nextCheckpoint: start + batchSize >= changed.length ? latest : checkpoint };
      if (!changed.length) break;
    }
  }

  async *streamUsers(): AsyncGenerator<SourceUser[]> {
    await sleep(this.latencyMs);
    yield [{ sourceId: "005DEMO00000001", username: "demo.admin@example.com", email: "demo.admin@example.com",
      firstName: "Demo", lastName: "Admin", role: "System Administrator", isActive: true }];
  }

  async readRecord(entity: CanonicalEntity, sourceId: string): Promise<SourceRecord | null> {
    this.apiCalls++;
    const record = this.records.get(entity.key)?.get(sourceId);
    return record ? this.toSource(entity, record) : null;
  }

  async applyChange(change: ValidatedChange): Promise<SourceChangeResult> {
    this.apiCalls++;
    const { entity, operation, fields } = change;
    const values = Object.fromEntries(Object.entries(fields).map(([key, { value }]) => [key, value]));
    const closeDate = values.CloseDate;
    if (typeof closeDate === "string" && closeDate < this.date(0)) {
      return { status: "rejected", error: { code: "FIELD_CUSTOM_VALIDATION_EXCEPTION", message: "Close Date cannot be in the past.", fields: ["CloseDate"] } };
    }
    this.clock = Math.max(this.clock, Date.now() - 10_000);
    if (operation === "create") {
      const record = this.put(entity.key, this.withName(entity.key, values));
      return { status: "applied", sourceId: record.sourceId, modifiedAt: record.modifiedAt, record: this.toSource(entity, record) };
    }
    const record = change.targetSourceId ? this.records.get(entity.key)?.get(change.targetSourceId) : undefined;
    if (!record) return { status: "rejected", error: { code: "ENTITY_IS_DELETED", message: "The record no longer exists." } };
    if (!change.overrideConflict) {
      const conflicts: Record<string, { base: JsonValue; replicaValue: JsonValue; sourceValue: JsonValue }> = {};
      for (const [key, { base, value }] of Object.entries(fields)) {
        const current = (record.fields[key] ?? null) as JsonValue;
        if (base !== undefined && JSON.stringify(base) !== JSON.stringify(current)) conflicts[key] = { base, replicaValue: value, sourceValue: current };
      }
      if (Object.keys(conflicts).length) return { status: "conflict", conflictValues: conflicts };
    }
    record.fields = this.withName(entity.key, { ...record.fields, ...values });
    record.modifiedAt = this.tick();
    return { status: "applied", sourceId: record.sourceId, modifiedAt: record.modifiedAt, record: this.toSource(entity, record) };
  }

  private withName(entityKey: string, fields: Fields): Fields {
    if (entityKey !== "Contact") return fields;
    const parts = [fields.FirstName, fields.LastName].filter((part) => typeof part === "string" && part !== "");
    return { ...fields, Name: parts.join(" ") };
  }

  private toSource(entity: CanonicalEntity, record: FakeRecord): SourceRecord {
    const keys = new Set(entity.attributes.map(({ key }) => key));
    const fields: Fields = { SystemModstamp: record.modifiedAt };
    for (const [key, value] of Object.entries(record.fields)) if (keys.has(key)) fields[key] = value;
    return { sourceId: record.sourceId, modifiedAt: record.modifiedAt, fields };
  }

  /** Hide the newest records from the replica's first sync so the console opens with something to reconcile. */
  holdBack(entityKey: string, count: number): () => void {
    const map = this.records.get(entityKey)!;
    const held = [...map.values()].slice(-count);
    for (const record of held) map.delete(record.sourceId);
    return () => {
      this.clock = Math.max(this.clock, Date.now() - 60_000);
      for (const record of held) {
        record.modifiedAt = this.tick();
        map.set(record.sourceId, record);
      }
    };
  }
}
