import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function filesAt(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry): string[] => {
    const name: string = resolve(path, entry.name);
    return entry.isDirectory() ? filesAt(name) : [name];
  });
}
test("core cannot import adapters or interpret native metadata, IDs or serialization", (): void => {
  for (const path of filesAt(resolve("src/core"))) {
    const text: string = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /moat|companyId|JWT_SECRET|TOKEN_ENCRYPTION_KEY|ImportJob|SalesforceConnection|SystemModstamp|Salesforce|SOQL|picklist|multipicklist|__c\b|__r\b|\bIsDeleted\b|\.Id\b/, path);
    assert.doesNotMatch(text, /(?:from\s*|import\s*\()["'][^"']*(?:destinations|sources|stores|compat|jsforce|ioredis|jose|prisma|postgres|pg|sql)/, path);
    assert.doesNotMatch(text, /queryAll\(|maxModstamp|SAFE_SF_IDENT/, path);
  }
});
