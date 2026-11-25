import { AttributeDataType, RelationType } from "../../core/model.js";
import type { SourceFieldDescribe, SourceObjectDescribe } from "./types.js";
import type { CanonicalEntity, CanonicalAttribute } from "../../core/source.js";

const recordRoles = new Map<string, NonNullable<CanonicalAttribute["recordRole"]>>([
  ["OwnerId", "owner"], ["CreatedById", "creator"], ["LastModifiedById", "lastModifier"], ["IsDeleted", "deletionFlag"],
]);

const systemFields = new Set([
  "Id", "IsDeleted", "IsArchived", "SystemModstamp", "CreatedDate", "CreatedById",
  "LastModifiedDate", "LastModifiedById", "OwnerId", "LastViewedDate", "LastReferencedDate",
]);

// Map an upstream field type string to our normalized AttributeDataType.
export function mapDataType(field: SourceFieldDescribe): AttributeDataType {
  switch (field.type) {
    case "string":
    case "encryptedstring":
      return AttributeDataType.Text;
    case "textarea":
      return field.length && field.length > 255
        ? AttributeDataType.LongText
        : AttributeDataType.TextArea;
    case "richtextarea":
      return AttributeDataType.RichText;
    case "int":
    case "long":
    case "double":
      return AttributeDataType.Number;
    case "currency":
      return AttributeDataType.Currency;
    case "percent":
      return AttributeDataType.Percent;
    case "boolean":
      return AttributeDataType.Boolean;
    case "date":
      return AttributeDataType.Date;
    case "datetime":
      return AttributeDataType.DateTime;
    case "time":
      return AttributeDataType.Time;
    case "email":
      return AttributeDataType.Email;
    case "phone":
      return AttributeDataType.Phone;
    case "url":
      return AttributeDataType.Url;
    case "picklist":
      return AttributeDataType.Enum;
    case "multipicklist":
      return AttributeDataType.MultiEnum;
    case "reference":
      return field.cascadeDelete ? AttributeDataType.Composition : AttributeDataType.Reference;
    case "autonumber":
      return AttributeDataType.Sequence;
    case "address":
      return AttributeDataType.Address;
    case "location":
      return AttributeDataType.Geolocation;
    case "id":
      return AttributeDataType.Identifier;
    default:
      return field.calculated ? AttributeDataType.Computed : AttributeDataType.Text;
  }
}


export function normalizeMetadata(raw: SourceObjectDescribe): CanonicalEntity {
  return {
    key: raw.name, label: raw.label, pluralLabel: raw.labelPlural, isCustom: raw.custom,
    ...(raw.name.endsWith("__c") && { displayKey: raw.name.slice(0, -3) }),
    attributes: raw.fields.map((field: SourceFieldDescribe): CanonicalAttribute => ({
      key: field.name, label: field.label, dataType: mapDataType(field),
      ...(field.name.endsWith("__c") && { displayKey: field.name.slice(0, -3) }),
      isCustom: field.custom, isRequired: !field.nillable, isUnique: field.unique,
      isExternalKey: field.externalId, isComputed: field.calculated,
      isUpdatable: !field.calculated && field.updateable === true,
      isCreatable: !field.calculated && field.createable === true,
      isNullable: field.nillable === true, hasCreateDefault: field.defaultedOnCreate === true,
      ...(recordRoles.has(field.name) && { recordRole: recordRoles.get(field.name)! }),
      isSystem: systemFields.has(field.name) || field.type === "id",
      ...(field.nameField === true && { isNameField: true }),
      length: field.length, precision: field.precision, scale: field.scale,
      expression: field.defaultValueFormula, helpText: field.inlineHelpText,
      enumOptions: field.picklistValues.map((value, index: number) => ({
        value: value.value, label: value.label, isActive: value.active, isDefault: value.defaultValue, sortOrder: index,
      })),
      ...(field.type === "reference" ? { relationship: {
        targetEntityKeys: field.referenceTo,
        kind: raw.name === field.referenceTo[0] && field.referenceTo.length === 1
          ? RelationType.Hierarchy : field.cascadeDelete ? RelationType.Composition : RelationType.Reference,
        name: field.relationshipName ?? field.name, cascadeDelete: field.cascadeDelete,
      } } : {}),
    })),
  };
}
