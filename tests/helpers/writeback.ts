import { normalizeMetadata } from "../../src/sources/salesforce/metadata.js";
import type { SourceFieldDescribe } from "../../src/sources/salesforce/types.js";

export const deployment = "fixture-writeback";

function field(name: string, overrides: Partial<SourceFieldDescribe> = {}): SourceFieldDescribe {
  return {
    name, label: name, type: "string", length: null, precision: null, scale: null,
    nillable: true, unique: false, externalId: false, calculated: false, custom: false,
    updateable: true, createable: true, defaultedOnCreate: false, defaultValueFormula: null,
    inlineHelpText: null, referenceTo: [], relationshipName: null, cascadeDelete: false,
    picklistValues: [], ...overrides,
  };
}

export const accountDescribe = {
  name: "Account", label: "Account", labelPlural: "Accounts", custom: false,
  fields: [
    field("Name", { nillable: false }), field("Score", { createable: false, type: "double" }),
    field("Origin", { updateable: false, nillable: false, defaultedOnCreate: true }),
    field("Total", { calculated: true }), field("Id", { type: "id" }),
    field("SystemModstamp", { type: "datetime" }), field("record_id"),
  ],
};

export const account = normalizeMetadata(accountDescribe);
export const contact = { ...account, key: "Contact" };
