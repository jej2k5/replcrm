-- Preserve original source IDs and local record IDs; widen only identity scope.
DROP INDEX "Record_deploymentId_sourceId_key";
CREATE UNIQUE INDEX "Record_deploymentId_entityDefinitionId_sourceId_key"
  ON "Record"("deploymentId", "entityDefinitionId", "sourceId");
-- An absent source modification time is not a synchronization checkpoint.
ALTER TABLE "Record" ALTER COLUMN "sourceModifiedAt" DROP NOT NULL;
ALTER TABLE "Record" ALTER COLUMN "sourceModifiedAt" DROP DEFAULT;

-- Historical non-record stage rows used these entity names with no checkpoint.
-- New stages use NULL and cannot shadow an entity checkpoint.
UPDATE "SyncRun" SET "entityKey" = NULL
  WHERE "entityKey" IN ('User', 'WideViews') AND cursor IS NULL;
