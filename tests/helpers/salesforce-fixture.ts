import type { SourceFieldDescribe, SourceObjectDescribe } from "../../src/sources/salesforce/types.js";

export function field(name: string, type: string, overrides: Partial<SourceFieldDescribe> = {}): SourceFieldDescribe {
  return { name, label: name, type, length: null, precision: null, scale: null, nillable: true, unique: false, externalId: false, calculated: false, custom: false, defaultValueFormula: null, inlineHelpText: null, referenceTo: [], relationshipName: null, cascadeDelete: false, picklistValues: [], ...overrides };
}

export function describe(name: string, fields: SourceFieldDescribe[]): SourceObjectDescribe {
  return { name, label: name, labelPlural: name, custom: name.endsWith("__c"), fields };
}
