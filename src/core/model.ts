// ReplCRM-owned canonical vocabulary. Storage adapters map these values to their schema.
export const AttributeDataType = {
  Text: "Text",
  TextArea: "TextArea",
  LongText: "LongText",
  RichText: "RichText",
  Number: "Number",
  Currency: "Currency",
  Percent: "Percent",
  Boolean: "Boolean",
  Date: "Date",
  DateTime: "DateTime",
  Time: "Time",
  Email: "Email",
  Phone: "Phone",
  Url: "Url",
  Enum: "Enum",
  MultiEnum: "MultiEnum",
  Reference: "Reference",
  Composition: "Composition",
  Computed: "Computed",
  Sequence: "Sequence",
  Address: "Address",
  Geolocation: "Geolocation",
  Identifier: "Identifier",
} as const;
export type AttributeDataType = typeof AttributeDataType[keyof typeof AttributeDataType];
export const RelationType = {
  Reference: "Reference",
  Composition: "Composition",
  Hierarchy: "Hierarchy",
} as const;
export type RelationType = typeof RelationType[keyof typeof RelationType];
