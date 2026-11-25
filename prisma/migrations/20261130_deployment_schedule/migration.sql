CREATE TABLE "DeploymentSchedule" (
  "deploymentId" text PRIMARY KEY REFERENCES "Deployment"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "inboundMs" integer NOT NULL DEFAULT 300000 CHECK ("inboundMs" >= 60000),
  "outboundMs" integer NOT NULL DEFAULT 10000 CHECK ("outboundMs" >= 1000),
  "metadataMs" integer NOT NULL DEFAULT 86400000 CHECK ("metadataMs" >= 1000),
  overrides jsonb NOT NULL DEFAULT '{}',
  paused boolean NOT NULL DEFAULT false,
  budget integer NOT NULL DEFAULT 50 CHECK (budget BETWEEN 1 AND 100),
  "heartbeatAt" timestamp(3),
  "inboundPausedUntil" timestamp(3),
  units jsonb NOT NULL DEFAULT '{}',
  "discoveredKeys" jsonb
);

CREATE TABLE "ScheduledRun" (
  id bigserial PRIMARY KEY,
  "deploymentId" text NOT NULL REFERENCES "DeploymentSchedule"("deploymentId") ON DELETE CASCADE ON UPDATE CASCADE,
  unit text NOT NULL,
  "finishedAt" timestamp(3) NOT NULL,
  calls integer,
  used integer,
  "dailyLimit" integer
);

CREATE INDEX "ScheduledRun_deploymentId_finishedAt_idx" ON "ScheduledRun"("deploymentId", "finishedAt");

CREATE INDEX "ScheduledRun_latest_usage_idx" ON "ScheduledRun"("deploymentId", "finishedAt" DESC, id DESC)
  WHERE "dailyLimit" IS NOT NULL;
