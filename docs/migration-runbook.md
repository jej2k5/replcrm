# ReplCRM Migration Runbook: Salesforce Org → CRM-Neutral Database

Operator-facing runbook for replicating a Salesforce org into a fresh database
using ReplCRM. Read this end-to-end before starting; the pipeline is
idempotent, but the prep steps are not.

---

## 0. Audience and assumptions

- You have admin access to the target Salesforce org (or a dedicated integration user with API access on every object in scope).
- You can provision a Postgres 14+ database and reach it from the host that will run the migration.
- You have Node 20+ and `npm` installed.
- The migration host has outbound HTTPS to `*.salesforce.com` (or your org's My Domain).

---

## 1. Pre-flight checks

Run all of these before touching anything else. If any fails, **stop** and resolve before continuing.

| Check | Command / action | Expected |
| --- | --- | --- |
| Node version | `node --version` | `v20.x` or higher |
| Postgres reachable | `psql "$DATABASE_URL" -c 'select 1'` | `1` |
| Postgres has `CREATE` permission | `psql "$DATABASE_URL" -c 'create table _probe(); drop table _probe;'` | no error |
| Disk headroom | `df -h` on the DB host | ≥ 3× the est. size of source data (EAV expands row count) |
| Salesforce login | log into the org via browser as the integration user | success |
| Security token | check email for "Your new Salesforce security token" | token in hand |
| API enabled on profile | Setup → Profiles → integration profile → "API Enabled" | checked |

> **Sizing rule of thumb:** every Salesforce row becomes 1 `Record` + N `AttributeValue` rows where N is the number of populated fields. Budget ~1.5–2 KB per `AttributeValue`.

---

## 2. Provision the database

```bash
# Pick a name; the runbook uses crm_prod.
createdb crm_prod
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/crm_prod"
```

Apply the schema, including `20261026_scoped_record_identity` and `20261123_writeback_foundations` on existing databases.

```bash
git clone https://github.com/jej2k5/replcrm.git
cd replcrm
npm install
npm run prisma:generate
npx prisma migrate deploy   # use migrate dev only on a throwaway DB
```

Confirm the tables landed:

```bash
psql "$DATABASE_URL" -c '\dt'
# expect: Deployment, EntityDefinition, AttributeDefinition, EnumOption,
#         RelationDefinition, EntityVariant, Record, AttributeValue,
#         User, SyncRun, WritebackPolicy, ChangeRequest
```

Refresh object metadata after applying the write-back migration. See [Write-back](write-back.md) for policy and queue setup.

---

## 3. Initialize the `Deployment` row

Build the CLI and run the init command with `DATABASE_URL` exported. This is the only environment variable the command needs, so you can run it before setting the Salesforce variables.

```bash
npm run build
npm start -- deployment init --id dep_acme_prod --name "Acme Production" \
  --source-url https://acme.my.salesforce.com
```

The source URL is optional. Repeating the command preserves the existing row. Replication requires that `DEPLOYMENT_ID` point to an existing deployment.

Alternatively, use SQL to provision the row, including a source tenant ID if needed.

```bash
psql "$DATABASE_URL" <<'SQL'
INSERT INTO "Deployment" (id, name, "sourceTenantId", "sourceUrl", "isActive", "createdAt", "updatedAt")
VALUES (
  'dep_acme_prod',                    -- pick a stable id; you'll use it for DEPLOYMENT_ID
  'Acme Production',
  '00D5f000000ABCDxxx',               -- the Salesforce Org Id (15- or 18-char)
  'https://acme.my.salesforce.com',
  true,
  now(), now()
);
SQL
```

Record the chosen `id` — it goes into `.env` next.

---

## 4. Configure credentials

The example below uses password login. With `SF_AUTH_MODE=auto` (the default), an existing OAuth sign-in for the deployment takes precedence. See [Salesforce sign-in](configuration.md#salesforce-sign-in) for External Client App variables and the token location.

```bash
cp .env.example .env
```

Fill in `.env` (the runtime does not automatically load it; export these values, or build and use `node --env-file=.env dist/cli.js`):

```ini
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/crm_prod

SF_AUTH_MODE=password
SF_LOGIN_URL=https://login.salesforce.com   # or test.salesforce.com for sandbox
SF_USERNAME=integration@acme.com
SF_PASSWORD=<password>
SF_SECURITY_TOKEN=<token from email>

DEPLOYMENT_ID=dep_acme_prod
SYNC_BATCH_SIZE=2000
SYNC_ENTITIES=Account,Contact,Lead,Opportunity,Case
```

> **Sandbox:** use `https://test.salesforce.com` and the sandbox-specific token.
> **My Domain SSO orgs:** the integration user must have a password set; SSO-only users cannot use SOAP login.

---

## 5. Choose migration scope

`SYNC_ENTITIES` accepts a comma-separated list of Salesforce object API names or `*` for discovery. Wildcard discovery includes queryable, replicateable objects and applies the exclusions documented in [configuration](configuration.md#salesforce-object-selection). References outside the selected scope retain canonical target identity, with a null local `referenceValue` until the target is replicated.

Common starting scopes:

- **Sales Cloud:** `Account,Contact,Lead,Opportunity,OpportunityLineItem,Product2,Pricebook2,PricebookEntry,Campaign,CampaignMember,Task,Event`
- **Service Cloud:** add `Case,CaseComment,Solution,Contract,Entitlement`
- **Custom objects:** include each `MyObject__c` API name

Plan the order: include parents before children if you care about reference attributes being populated on the **first** record-sync pass. (The reference-backfill stage will fix them either way, but it's cheaper to get it right the first time.)

---

## 6. Smoke test

Before kicking off the full migration, prove the pieces work end-to-end against a tiny scope.

```bash
npm run replicate -- --entities Account
```

Verify:

```bash
psql "$DATABASE_URL" <<'SQL'
SELECT status, "entityKey", "recordsCreated", "recordsUpdated", "recordsDeleted", "errorMessage"
FROM "SyncRun"
ORDER BY "startedAt" DESC LIMIT 5;
SQL
```

You should see successful non-record stage runs (`entityKey` null) and an Account record run; non-record stages cover metadata, users and projections unless projections are disabled. Spot-check a record:

```sql
SELECT r."sourceId", av."textValue"
FROM "Record" r
JOIN "AttributeValue" av ON av."recordId" = r.id
JOIN "AttributeDefinition" ad ON ad.id = av."attributeDefinitionId"
WHERE ad.key = 'Name' AND r."deploymentId" = 'dep_acme_prod'
LIMIT 5;
```

If the smoke test passes, proceed to the full run.

---

## 7. Full migration

Run with your full selection. To inspect or save it, use `npm start -- objects list` or `npm start -- objects set Account,Contact,Task` with your chosen names:

```bash
npm run replicate 2>&1 | tee migration-$(date +%Y%m%d-%H%M%S).log
```

### Running individual stages

Use the same deployment and entity selection for each command.

```bash
npm run replicate:metadata
npm run replicate:users
npm run replicate:records
npm run replicate:projections
```

Run metadata before standalone records or projections. Both commands verify that every selected entity has metadata in the deployment and then fetch current definitions from the source. Records repairs references before committing checkpoints. If only wide-view creation failed, use `npm run replicate:projections` to retry that stage. The legacy `migrate:metadata` and `migrate:records` scripts run their corresponding stages and print deprecation warnings to stderr.

### Sync lock

Metadata, users, records, projections, full, reconcile apply, console-started syncs, and write-back processing share one lock per deployment at `<config dir>/locks/<DEPLOYMENT_ID>.run.lock`. A sync waits when a live local change-processing batch holds the lock. Other competing starts get a refusal with the holder’s command, PID, and start time. The CLI exits 1 and the console shows the refusal on the page.

Use **Run records sync** or **Run full sync** in the console to start a sync with the saved selection and follow its progress. Running entries without a lock appear as interrupted run warnings. Ctrl+C stops the console from accepting starts and gives an active sync up to ten seconds to finish before marking it failed and releasing the lock.

In the CLI, Ctrl+C and SIGTERM release the run lock and exit 130. The change processor finishes the active request before releasing its batch lock. A hard kill or crash can leave the file behind. Confirm the run has stopped, checking the named host first if it differs from yours, then delete the named lock file and retry. The start time alone does not determine whether a run has stopped.

The lock coordinates processes sharing the same configuration directory. A container with a separate config directory has its own lock, even when it uses the same deployment ID and database.

### Monitoring while it runs

In a second terminal:

```bash
watch -n 10 'psql "$DATABASE_URL" -c "
  SELECT \"entityKey\", status, \"recordsCreated\", \"recordsUpdated\", \"recordsProcessed\"
  FROM \"SyncRun\"
  WHERE \"deploymentId\" = '\''dep_acme_prod'\''
  ORDER BY \"startedAt\" DESC LIMIT 20;"'
```

Counts are persisted at stage completion, so a Running row alone does not show per-batch progress. Inspect logs and source/database activity before treating a long stage as stuck (see §10).

---

## Checkpoint run

On your Mac, choose a Salesforce Developer Edition or sandbox org and configure username, password, and security token login as described in §4. After applying the database schema and building the CLI, export `DATABASE_URL`, choose a deployment ID, and run the following in order. Set the Salesforce and replication environment variables before running replication.

```sh
export DEPLOYMENT_ID=dep_checkpoint
node dist/cli.js deployment init --id "$DEPLOYMENT_ID" --name "Checkpoint"
npm run replicate
node dist/cli.js counts
```

Review the counts for each object yourself. **MATCH** means the store and Salesforce report the same number of active records, including archived activities. **DIFF** means the active counts differ and still returns exit code 0. Changes in Salesforce during the run can cause expected DIFFs. Run `npm run replicate:records` and then `node dist/cli.js counts` to pick up those changes.

The next records run catches a Salesforce deletion while the record is still in the Recycle Bin and marks it deleted in the store. A subsequent undelete reactivates it on sync. A record purged before the next sync can still leave a DIFF with the store count higher than Salesforce. A store count below Salesforce that survives a rerun indicates a replication gap.

The first successful records run after upgrading backfills archived Task and Event rows once for entities with existing checkpoints.

Use `node dist/cli.js counts --store-only` to inspect active store counts without setting any `SF_*` variables. With a wildcard selection, this mode lists entities with persisted metadata and applies the same deny list.

### Reconcile

If the store count stays above Salesforce after another records run, verify the deployment once with `npm start -- deployment verify`. Then preview with `npm start -- reconcile --entities <obj>`, using explicit object names such as `Account,Task`. If your saved selection is `*`, pass `--entities a,b` with the explicit names to review. Every selected object requires persisted metadata.

Review the sample IDs in the preview and the full candidate list in the saved plan. Within 60 minutes, run `npm start -- reconcile --apply` using the verified org and user. Apply uses the reviewed plan's object keys and rechecks which candidates are still absent. Investigate unexpected counts before using `--allow-empty` or `--allow-large`.

Run `counts` again and rerun projections for the affected objects if wide views are enabled.

---

## 8. Verification

After the run reports success, run these checks.

### 8.1 Per-entity row counts

Run `node dist/cli.js counts` with the same deployment and entity scope used for replication. Review every DIFF as described in [Checkpoint run](#checkpoint-run). Use `--json` for machine-readable output or `--entities Account,Contact` to override the saved selection and environment fallback. The deny list still applies.

### 8.2 Reference linkage

```sql
SELECT ed.key AS entity, ad.key AS attribute,
       count(*) FILTER (WHERE av."referenceValue" IS NOT NULL) AS linked,
       count(*) FILTER (WHERE av."referenceValue" IS NULL)     AS unlinked
FROM "AttributeDefinition" ad
JOIN "AttributeValue" av ON av."attributeDefinitionId" = ad.id
JOIN "EntityDefinition" ed ON ed.id = ad."entityDefinitionId"
WHERE ad."dataType" IN ('Reference', 'Composition')
  AND ed."deploymentId" = 'dep_acme_prod'
GROUP BY ed.key, ad.key
ORDER BY unlinked DESC;
```

Non-zero `unlinked` is expected for references whose target entity is **outside** the selected objects. If a reference target IS in scope and still shows unlinked, something went wrong with the backfill stage — re-run the migration.

### 8.3 Spot-check a known record

Pick a familiar Account in Salesforce by Id. Then:

```sql
SELECT ad.key, av."textValue", av."numberValue", av."dateTimeValue", av."referenceValue"
FROM "Record" r
JOIN "AttributeValue" av ON av."recordId" = r.id
JOIN "AttributeDefinition" ad ON ad.id = av."attributeDefinitionId"
WHERE r."sourceId" = '0015f00000XXXXXAAA';
```

Confirm field-by-field against the Salesforce UI.

---

## 9. Incremental re-runs

Re-running `npm run replicate` is **safe and incremental**:

- The metadata stage upserts canonical definitions and refreshes enum-option snapshots.
- The record stage passes the last successful `SyncRun.cursor` per entity back to the source unchanged. The Salesforce adapter interprets its own checkpoint, which currently encodes a SystemModstamp watermark; core does not derive it.
- Salesforce record queries include archived rows and rows still in the Recycle Bin. The store marks deleted rows with `isDeleted=true` and reactivates undeleted rows on sync.

A typical cadence: full first run, then `npm run replicate` on a cron every 15–60 minutes.

> **Caveat:** Purging a record before records sync sees the deletion can leave the store with a higher active count than Salesforce.

---

## 10. Failure recovery

### Run failed mid-stage

Just re-run `npm run replicate`. The failed `SyncRun` row stays as `Failed` for audit. Record checkpoints commit after record persistence and reference repair; failures before that point replay from the previous successful checkpoint. Projections run afterward, so a projection failure retains the successfully persisted source checkpoint.

### "INVALID_LOGIN: Invalid username, password, security token"

The security token rotated (it does on every password change). Reset it: Setup → My Personal Information → Reset My Security Token. Update `.env`. Re-run.

### "REQUEST_LIMIT_EXCEEDED"

Daily API call limit hit. Stop, wait for the 24-hour window to roll over, narrow the object selection, or raise `SYNC_BATCH_SIZE` (fewer round-trips per record).

### Single entity stuck `Running`

Find the orphan run and mark it failed so the next attempt can start cleanly:

```sql
UPDATE "SyncRun"
SET status = 'Failed', "completedAt" = now(), "errorMessage" = 'Manual reset by operator'
WHERE id = '<id>';
```

Then re-run the migration.

### Need to re-process an entity from scratch

Delete its successful `SyncRun` rows so the cursor resets to null:

```sql
DELETE FROM "SyncRun"
WHERE "deploymentId" = 'dep_acme_prod' AND "entityKey" = 'Opportunity';
```

The next run will do a full pull of that entity.

---

## 11. Rollback

### Soft rollback (keep the database, drop one deployment)

```sql
DELETE FROM "Deployment" WHERE id = 'dep_acme_prod';
```

`onDelete: Cascade` on `EntityDefinition`, `Record`, `User`, `SyncRun`, etc., wipes everything for that deployment in one statement.

### Hard rollback (start over)

```bash
dropdb crm_prod && createdb crm_prod
npx prisma migrate deploy
# then go back to §3
```

---

## 12. Sign-off checklist

Before declaring the migration complete:

- [ ] Every selected entity has a `Succeeded` `SyncRun` row.
- [ ] Run `node dist/cli.js counts` and account for each DIFF using the [checkpoint guidance](#checkpoint-run).
- [ ] Reference linkage report (§8.2) shows no in-scope unlinked references.
- [ ] At least three spot-checked records match field-by-field.
- [ ] Cron / scheduled re-run is configured (if applicable).
- [ ] Operator log file (`migration-*.log`) is archived.
- [ ] `.env` is removed from any shared host or rotated to a vault.
