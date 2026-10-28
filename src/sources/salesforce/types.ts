export interface SourcePicklistEntry {
  value: string;
  label: string;
  active: boolean;
  defaultValue: boolean;
}

export interface SourceFieldDescribe {
  name: string;
  label: string;
  type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nillable: boolean;
  unique: boolean;
  externalId: boolean;
  calculated: boolean;
  custom: boolean;
  defaultValueFormula: string | null;
  inlineHelpText: string | null;
  referenceTo: string[];
  relationshipName: string | null;
  cascadeDelete: boolean;
  picklistValues: SourcePicklistEntry[];
}

export interface SourceObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  fields: SourceFieldDescribe[];
}


export interface SourceRecord {
  Id: string;
  SystemModstamp?: string;
  IsDeleted?: boolean;
  [field: string]: unknown;
}
