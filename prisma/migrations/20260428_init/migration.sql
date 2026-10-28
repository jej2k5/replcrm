-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('Text', 'TextArea', 'LongText', 'RichText', 'Number', 'Currency', 'Percent', 'Boolean', 'Date', 'DateTime', 'Time', 'Email', 'Phone', 'Url', 'Enum', 'MultiEnum', 'Reference', 'Composition', 'Computed', 'Sequence', 'Address', 'Geolocation', 'Identifier');

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('Reference', 'Composition', 'Hierarchy');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('Running', 'Succeeded', 'Failed', 'PartialSuccess');

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceTenantId" TEXT,
    "sourceUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "sourceId" TEXT,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT NOT NULL,
    "role" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityDefinition" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pluralLabel" TEXT NOT NULL,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeDefinition" (
    "id" TEXT NOT NULL,
    "entityDefinitionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dataType" "AttributeDataType" NOT NULL,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isUnique" BOOLEAN NOT NULL DEFAULT false,
    "isExternalKey" BOOLEAN NOT NULL DEFAULT false,
    "isComputed" BOOLEAN NOT NULL DEFAULT false,
    "length" INTEGER,
    "precision" INTEGER,
    "scale" INTEGER,
    "defaultValue" TEXT,
    "expression" TEXT,
    "helpText" TEXT,
    "referenceEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnumOption" (
    "id" TEXT NOT NULL,
    "attributeDefinitionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnumOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationDefinition" (
    "id" TEXT NOT NULL,
    "fromEntityId" TEXT NOT NULL,
    "toEntityId" TEXT NOT NULL,
    "fromAttributeId" TEXT NOT NULL,
    "relationName" TEXT NOT NULL,
    "relationType" "RelationType" NOT NULL,
    "cascadeDelete" BOOLEAN NOT NULL DEFAULT false,
    "reparentable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RelationDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityVariant" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "entityDefinitionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Record" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "entityDefinitionId" TEXT NOT NULL,
    "variantId" TEXT,
    "sourceId" TEXT,
    "externalKey" TEXT,
    "ownerId" TEXT,
    "createdById" TEXT,
    "lastModifiedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sourceModifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeValue" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "attributeDefinitionId" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DECIMAL(38,18),
    "booleanValue" BOOLEAN,
    "dateValue" DATE,
    "dateTimeValue" TIMESTAMP(3),
    "referenceValue" TEXT,
    "jsonValue" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "entityKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL,
    "cursor" TEXT,
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsDeleted" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_sourceTenantId_key" ON "Deployment"("sourceTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_deploymentId_sourceId_key" ON "User"("deploymentId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "User_deploymentId_username_key" ON "User"("deploymentId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "EntityDefinition_deploymentId_key_key" ON "EntityDefinition"("deploymentId", "key");

-- CreateIndex
CREATE INDEX "AttributeDefinition_referenceEntityId_idx" ON "AttributeDefinition"("referenceEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeDefinition_entityDefinitionId_key_key" ON "AttributeDefinition"("entityDefinitionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EnumOption_attributeDefinitionId_value_key" ON "EnumOption"("attributeDefinitionId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "RelationDefinition_fromAttributeId_key" ON "RelationDefinition"("fromAttributeId");

-- CreateIndex
CREATE INDEX "RelationDefinition_toEntityId_idx" ON "RelationDefinition"("toEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityVariant_entityDefinitionId_key_key" ON "EntityVariant"("entityDefinitionId", "key");

-- CreateIndex
CREATE INDEX "Record_deploymentId_entityDefinitionId_isDeleted_idx" ON "Record"("deploymentId", "entityDefinitionId", "isDeleted");

-- CreateIndex
CREATE INDEX "Record_deploymentId_entityDefinitionId_externalKey_idx" ON "Record"("deploymentId", "entityDefinitionId", "externalKey");

-- CreateIndex
CREATE INDEX "Record_deploymentId_entityDefinitionId_sourceModifiedAt_idx" ON "Record"("deploymentId", "entityDefinitionId", "sourceModifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Record_deploymentId_sourceId_key" ON "Record"("deploymentId", "sourceId");

-- CreateIndex
CREATE INDEX "AttributeValue_attributeDefinitionId_textValue_idx" ON "AttributeValue"("attributeDefinitionId", "textValue");

-- CreateIndex
CREATE INDEX "AttributeValue_attributeDefinitionId_numberValue_idx" ON "AttributeValue"("attributeDefinitionId", "numberValue");

-- CreateIndex
CREATE INDEX "AttributeValue_attributeDefinitionId_dateTimeValue_idx" ON "AttributeValue"("attributeDefinitionId", "dateTimeValue");

-- CreateIndex
CREATE INDEX "AttributeValue_attributeDefinitionId_booleanValue_idx" ON "AttributeValue"("attributeDefinitionId", "booleanValue");

-- CreateIndex
CREATE INDEX "AttributeValue_referenceValue_idx" ON "AttributeValue"("referenceValue");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeValue_recordId_attributeDefinitionId_key" ON "AttributeValue"("recordId", "attributeDefinitionId");

-- CreateIndex
CREATE INDEX "SyncRun_deploymentId_entityKey_startedAt_idx" ON "SyncRun"("deploymentId", "entityKey", "startedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDefinition" ADD CONSTRAINT "EntityDefinition_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_entityDefinitionId_fkey" FOREIGN KEY ("entityDefinitionId") REFERENCES "EntityDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_referenceEntityId_fkey" FOREIGN KEY ("referenceEntityId") REFERENCES "EntityDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnumOption" ADD CONSTRAINT "EnumOption_attributeDefinitionId_fkey" FOREIGN KEY ("attributeDefinitionId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationDefinition" ADD CONSTRAINT "RelationDefinition_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "EntityDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationDefinition" ADD CONSTRAINT "RelationDefinition_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "EntityDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationDefinition" ADD CONSTRAINT "RelationDefinition_fromAttributeId_fkey" FOREIGN KEY ("fromAttributeId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityVariant" ADD CONSTRAINT "EntityVariant_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityVariant" ADD CONSTRAINT "EntityVariant_entityDefinitionId_fkey" FOREIGN KEY ("entityDefinitionId") REFERENCES "EntityDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_entityDefinitionId_fkey" FOREIGN KEY ("entityDefinitionId") REFERENCES "EntityDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "EntityVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Record" ADD CONSTRAINT "Record_lastModifiedById_fkey" FOREIGN KEY ("lastModifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeValue" ADD CONSTRAINT "AttributeValue_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "Record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeValue" ADD CONSTRAINT "AttributeValue_attributeDefinitionId_fkey" FOREIGN KEY ("attributeDefinitionId") REFERENCES "AttributeDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeValue" ADD CONSTRAINT "AttributeValue_referenceValue_fkey" FOREIGN KEY ("referenceValue") REFERENCES "Record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

