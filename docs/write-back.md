# Write-back

Salesforce remains the system of record. ReplCRM stores requests for updates and creates in the replica database. The change-request processor sends stored requests to Salesforce. Deletes are refused with `deletes are not supported by write-back`.

## Choose writable fields

Apply the Prisma migrations and run metadata replication to refresh the source capabilities. Existing metadata starts with every capability off. Each deployment starts with write-back disabled on every object.

```sh
npm start -- writeback status
npm start -- writeback status --json
npm start -- writeback enable Account
npm start -- writeback exclude Account Description Phone
npm start -- writeback include Account Phone
npm start -- writeback disable Account
```

Use the case-sensitive canonical keys shown in metadata. These commands use `DEPLOYMENT_ID` and the configured replica database. The JSON status contains `deploymentId` and an `objects` array whose entries contain `entityKey`, `enabled`, and `excludedAttributeKeys`. Disabling an object preserves its exclusions. Including a field removes the exclusion and leaves its source capabilities in effect.

On an enabled object, each submitted field requires the corresponding create or update capability. Computed, system, and replica housekeeping fields are always excluded. A source-creatable, non-nullable field without a create default must be supplied, even if policy currently excludes it. Explicit null requires a nullable field.

## Submit a change

Call `submitChange(store, input)` from `src/writeback/index.ts` with a store that implements `WritebackStore`. The function returns a pending request or raises `ChangeValidationError` with one entry in `problems` for each issue it found. Submissions with validation errors leave the queue unchanged.

```ts
await submitChange(store, {
  deploymentId,
  entityKey: "Account",
  operation: "update",
  targetRecordId: replicaAccountId,
  fields: { Name: { base: "Old name", value: "New name" } },
  authorKind: "person",
  authorLabel: "CRM operator",
  reason: "Correct account name",
  idempotencyKey: requestKey,
});
```

For an update, use the replica record ID or the source ID of an active record in the same deployment and object. Supply the value the editor originally saw as `base` for every edited field. An explicit null is a valid base. For a create, omit `targetRecordId` and supply `{ value }` for each field. Use canonical values such as a qualified reference, an array of strings for a multi-value field, or a `Date` for a datetime. Datetimes are stored as UTC ISO strings in the JSON payload. Author kind can be `person`, `app`, or `agent`. The author label is required. A supplied idempotency key identifies one request for the entire deployment. Reusing the key returns that request in its current status, even if the policy has since changed. Use a fresh key for a new request.

### Submit with SQL

On a PostgreSQL replica using the default `public` schema, apply the write-back queue migration. Insert into `writeback.submissions` to validate and enqueue a request in the same database transaction. Use `RETURNING` to read the outcome immediately.

```sql
INSERT INTO writeback.submissions (
  deployment_id, entity_key, operation, record_id, fields,
  author_kind, author_label, reason, idempotency_key
) VALUES (
  'my-deployment', 'Account', 'update', 'account-source-id',
  '{"Name": {"base": "Old name", "value": "New name"}}'::jsonb,
  'app', 'account-editor', 'Correct account name', 'account-rename-42'
)
RETURNING id, status, change_request_id, messages;
```

Omit `record_id` for creates and use a `value` for each specified field. Use canonical JSON values, including UTC datetime strings such as `2026-01-01T12:00:00.000Z`. An `accepted` row contains the queued or existing request ID. A `refused` row contains validation messages and leaves the change queue unchanged. Both outcomes persist on commit. Submission rows are insert-only and describe queue admission. Use the request ID to look up subsequent processing status.

A DBA can grant a trusted app role `USAGE` on the `writeback` schema, column-level `INSERT` on the input columns above, and column-level `SELECT` on the returned columns. The trigger has the database privileges needed to validate and enqueue the request. Grant access only to roles allowed to submit to every deployment in that database. The in-memory store supports submissions through `submitChange()`.

### Edit a wide projection

Apply the direct SQL edits migration, enable write-back for the object, and run the `projections` stage to publish its `wide` table. Find the physical table and attribute names in the projection registry.

```sql
SELECT table_name, column_map
FROM wide.__replcrm_projections
WHERE deployment_id = 'my-deployment' AND entity_key = 'Account';
```

Use the published names in your statements. For example, substitute the returned table name for `<table_name>` below.

```sql
BEGIN;
SET LOCAL replcrm.author = 'CRM operator';
UPDATE wide."<table_name>" SET "Name" = 'New name' WHERE source_id = 'account-source-id';
INSERT INTO wide."<table_name>" ("Name") VALUES ('New account');
COMMIT;

SELECT change_request_id, entity_key, record_id, source_id, operation, status, fields
FROM writeback.pending_edits
WHERE deployment_id = 'my-deployment';
```

An update queues only changed attributes, using each old value as its conflict base. A create uses the supplied non-null values and checks required fields. An omitted column and a SQL `NULL` both leave a create field unspecified. Use `writeback.submissions` if you need to send an explicit null on create or supply an idempotency key. A projection reference column takes a replica `record_id` for a record in the same deployment. Blocked column edits fail the SQL statement, and deletes raise `deletes are not supported by write-back`.

Successful edits queue on commit and report zero rows changed in the projection. An edited row shows its old values, and a pending create has no projection row. The projection reflects confirmed Salesforce data so readers see the accepted values after replication refreshes the projection. Run a full sync with projections enabled, or rebuild projections after refreshing the records. `writeback.pending_edits` lists pending, conflicting, and unknown requests, including the fields that were submitted. The request store retains the queue across projection rebuilds.

Direct edits use author kind `person` and default to the database session user. Set `replcrm.author` to override the label. ReplCRM sets `replcrm.sync` locally in sync transactions so its writes bypass the edit triggers. Give projection write privileges only to trusted roles and use read-only grants for readers. A rebuild recreates the table, so table-specific grants need to be reapplied unless covered by default privileges. Disabling write-back removes the triggers and leaves the table as a plain, rebuildable projection.

### Submit and inspect from the CLI

```sh
npm start -- changes submit --object Account --record account-source-id --set 'Name=New name' --base 'Name=Old name' --author agent:account-editor --json
npm start -- changes submit --object Account --create --set 'Name=New account'
npm start -- changes list --status pending --object Account --json
npm start -- changes show <request-id> --json
```

Repeat `--set` and `--base` for multiple fields. Omit all bases to read the current values from the replica. The CLI reports that choice on stderr. Supply explicit bases when the edit was made against an earlier snapshot. Use JSON for booleans, arrays, qualified references and other structured values. To submit the text `null`, quote it as a JSON string within the argument. Submit and show print one request object with `--json`. List prints an array.

## Status and audit trail

| Status | Meaning |
| --- | --- |
| `pending` | The store accepted the request and it awaits processing. |
| `sending` | A processor has claimed the request. |
| `applied` | The source change was confirmed, or an operator linked a confirmed result. |
| `conflict` | An edited field has changed at the source since the supplied base. |
| `overridden` | An operator recorded which side to use for a conflict. |
| `rejected` | The request was declined or closed without applying it. |
| `failed` | A transient error prevented the write. The request records the source’s `Retry-After` header when available. The queue retries after that delay. A failed request without a retry time requires `changes retry`. |
| `unknown` | Processing could not establish the outcome. |

## Send a stored request

Run one batch with `npm start -- changes process` or poll with `npm start -- changes process --watch --interval 10`. The interval is in seconds and defaults to 10. Processing uses the deployment's Salesforce sign-in. Each batch takes the same deployment lock used by syncs and the console, sends pending and retry-due requests oldest first, and releases the lock before the next poll. A sync waiting on the batch can take the lock at that point. Processing exits on a busy lock, leaving unsent requests queued. Ctrl+C or SIGTERM lets the active request finish, releases the lock, and exits with code 130.

Submitting a change leaves the replica row unchanged until Salesforce accepts the write and the processor refreshes the row. The refresh uses the normal record reader and persists by deployment, object, and source ID. The refresh leaves sync checkpoints alone.

Use `changes retry <request-id>` to requeue a failed request once any recorded delay has elapsed. The ID and idempotency key stay with the request. A rejected request records the Salesforce error code, message, and supplied fields when available.

Embedders can construct a `ChangeRequestProcessor` with the replica store and authenticated source for the deployment. When dispatching directly, hold the shared deployment lock through processing and refresh.

An update checks only its edited fields. The processor sends no update if any current source value differs from its base. The request stores the base, proposed replica value, and current Salesforce value for each conflict. Salesforce can accept another writer’s change between the read and the update. The two operations are separate, and the adapter sends the update immediately after comparing the values.

Run `changes override <request-id> --keep replica|salesforce --operator <label>` for a conflicting request. The processor API accepts the decision through `overrideConflict(request, { operatorLabel, time, side })`, where `time` is an ISO 8601 timestamp and the Salesforce side is named `source`. Choosing `replica` records the decision and sends the proposed values without a conflict read. Choosing `source` records the decision and closes the request as rejected with the detail `kept Salesforce values`.

## Resolve an unknown outcome

After a timeout, reset, or ambiguous server error during a write, the request moves to `unknown`. There is no automatic retry. Investigate the source before deciding how to proceed. Use `changes resolve <request-id> --operator <label>` with one of these choices. The processor API exposes the same actions through `resolveUnknown`.

- `--link <sourceId>` reads and links a verified, visible Salesforce record and marks the request applied.
- `--resubmit` explicitly returns the request to pending for the processor. Resending can create a duplicate if Salesforce applied the first create.
- `--abandon` closes the unresolved request as rejected.

If Salesforce confirms a write and the subsequent read or replica persistence fails, the request remains applied with the confirmed ID and a refresh error in its detail. For creates, the processor attempts to reserve the replica row by source ID so normal replication can fill in the values. After a crash, confirm the old process has stopped and follow the runbook to clear its stale lock. At the next batch, an interrupted create moves from `sending` to `unknown` for investigation. An interrupted update moves back to `pending` and runs the conflict check before any resend, including after an interrupted override.

## Attribute changes in Salesforce

Configure the authenticated client before processing requests when an object has an attribution field.

```ts
await source.configureWriteback({
  Account: { writeback: { attributionField: "WritebackAuthor__c" } },
});
```

Configuration validates the custom text field against live object metadata and refuses fields that are missing, computed, or lack update or create access. On each update or create, the writer sets the configured field to the author kind and label, for example `person: CRM operator`. The configured attribution value takes precedence if the submission also supplies that field.

## Manage write-back in the console

Apply the console metadata migration and refresh metadata to make the source-designated record name available. Start the loopback console with `npm run console`, then open the replica you want to manage. The **Objects** and **Changes** links retain that deployment selection. In **Objects**, turn on write-back for an object to see the effective create and update permissions for each eligible field. Use **Exclude** to remove a field from both operations. The console and CLI share the same policy. Changes sent by the processor use the signed-in Salesforce identity.

In **Changes**, use the status tabs to filter the queue and open a request from its record link. Each tab shows its count for the selected deployment. An unlinked create shows the object label and submitted name when available, such as **New Contact: Priya Shah**. The health strip counts pending requests, conflicts and unknown outcomes that need review, and requests currently failed whose last update was within 24 hours.

- **Conflict** shows the editor's base, the proposed replica value, and the current Salesforce value for each conflicting field. Type an operator label to keep either side. Keeping the replica value sends the proposed change through the processor. Keeping Salesforce values closes the request without a Salesforce write.
- **Rejected** and **Failed** show the saved message and named fields when supplied by Salesforce. **Retry** returns a failed request to pending after its recorded retry delay expires.
- **Unknown** offers **Link to an existing record ID**, **Resubmit**, and **Abandon** after you provide an operator label. Verify the outcome in Salesforce before resubmitting a create, since resubmission can create a duplicate.
- **Applied** shows the Salesforce record ID and when the request moved to applied.

**Process now** runs one batch for the selected deployment. If a sync already holds the deployment lock, the console displays the lock error and leaves the queue untouched. Use the CLI, embedded API, PostgreSQL submissions, or direct projection edits described above to enqueue new requests. The console provides policy, review, and processing controls.
