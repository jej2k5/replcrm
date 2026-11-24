ALTER TABLE "AttributeDefinition"
  ADD COLUMN "isUpdatable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isCreatable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isNullable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasCreateDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WritebackPolicy" (
  "deploymentId" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "excludedAttributeKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  PRIMARY KEY ("deploymentId", "entityKey"),
  CONSTRAINT "WritebackPolicy_deploymentId_entityKey_fkey"
    FOREIGN KEY ("deploymentId", "entityKey") REFERENCES "EntityDefinition"("deploymentId", "key") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TYPE "ChangeOperation" AS ENUM ('update', 'create');
CREATE TYPE "ChangeAuthorKind" AS ENUM ('person', 'app', 'agent');
CREATE TYPE "ChangeStatus" AS ENUM ('pending', 'sending', 'applied', 'conflict', 'overridden', 'rejected', 'failed', 'unknown');

CREATE TABLE "ChangeRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deploymentId" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "operation" "ChangeOperation" NOT NULL,
  "targetRecordId" TEXT,
  "targetSourceId" TEXT,
  "fields" JSONB NOT NULL,
  "authorKind" "ChangeAuthorKind" NOT NULL,
  "authorLabel" TEXT NOT NULL,
  "reason" TEXT,
  "idempotencyKey" TEXT,
  "status" "ChangeStatus" NOT NULL DEFAULT 'pending',
  "statusDetail" TEXT,
  "conflictValues" JSONB,
  "resultingSourceId" TEXT,
  "overrideDecision" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChangeRequest_deploymentId_entityKey_fkey"
    FOREIGN KEY ("deploymentId", "entityKey") REFERENCES "EntityDefinition"("deploymentId", "key") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChangeRequest_deploymentId_idempotencyKey_key" ON "ChangeRequest"("deploymentId", "idempotencyKey");
CREATE INDEX "ChangeRequest_deploymentId_entityKey_status_idx" ON "ChangeRequest"("deploymentId", "entityKey", "status");
