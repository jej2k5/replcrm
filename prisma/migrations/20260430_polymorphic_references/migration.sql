-- AlterTable
ALTER TABLE "AttributeDefinition" ADD COLUMN "referenceEntityKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
