ALTER TABLE "ChangeRequest"
  ADD COLUMN "sourceError" JSONB,
  ADD COLUMN "sourceModifiedAt" TIMESTAMP(3),
  ADD COLUMN "retryAfter" TEXT;
