ALTER TABLE "DeploymentSchedule" ADD COLUMN "eventKeys" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ObjectChangeState" (
  "deploymentId" TEXT NOT NULL REFERENCES "DeploymentSchedule"("deploymentId") ON DELETE CASCADE,
  "objectKey" TEXT NOT NULL,
  position TEXT,
  connected BOOLEAN NOT NULL DEFAULT false,
  "lastEventAt" TIMESTAMP(3),
  "dueAt" TIMESTAMP(3),
  generation INTEGER NOT NULL DEFAULT 0,
  "catchUp" BOOLEAN NOT NULL DEFAULT false,
  "catchUpPolls" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("deploymentId", "objectKey")
);
