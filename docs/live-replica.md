# Live replica

ReplCRM publishes one PostgreSQL table per selected object in the `wide` schema. Find its physical table name and source-to-column mapping in `wide.__replcrm_projections`. Each table is keyed by `record_id`, the stable replica record ID. It also exposes `source_id` and `is_deleted` for source identity and deletion status.

## Refreshing flat tables

Apply the PostgreSQL migrations before refreshing projections. With `BUILD_WIDE_VIEWS=true` (the default), both `full` and `records` refresh the selected objects after records and references are committed. This includes runs started in the console. Run `npm start -- projections --entities Account,Contact` to refresh those objects independently, including when automatic projection refresh is disabled. Run the metadata stage first when source metadata changes.

A refresh uses the object's durable watermark to find changed records. It updates existing rows in place, inserts new rows, and sets `is_deleted` for tombstones. Reconcile records source purges as tombstones under the existing reconcile policy. When a row is physically removed from the replica store, the next refresh removes its projected row. Projection updates and watermarks commit together. If refresh fails after a records run, retry `projections` to publish the committed records.

## Schema changes and rebuilds

A new attribute adds a column and backfills that column from stored values. A removed attribute drops its projected column. Historical values remain in the record store. A PostgreSQL-castable type change alters the column in place. Source patches populate the new typed storage slots as they arrive. The projection can use historical values that cast cleanly until those patches arrive.

The first publication, first refresh of a legacy table, an uncastable type change, and an explicit `npm start -- projections --rebuild` build a replacement table. CLI output and the console run log identify the object and reason. During a rebuild, readers can query the published table while the replacement is populated and indexed. The final swap and dependent view rebind run in one transaction.

Rebuilds copy valid indexes, table and column grants, and table, column, and index comments for objects that still exist in the new schema. They reinstall the write-back triggers when policy enables them and leave pending requests in `writeback.pending_edits`. Ordinary dependent views keep their names, permissions, and downstream views when their definitions still work against the new table. An incompatible dependent view or materialized view stops the rebuild and is named in the error. Rebuilds need permission to create staging schemas and manage the affected tables and views.

## Readable views

Each projection refresh publishes a view such as `replica.opportunity` over its wide table. Start with `SELECT * FROM replica.opportunity LIMIT 10`. Set `REPLICA_VIEW_SCHEMA` before the first refresh to choose a dedicated lowercase name. Each deployment claims one schema in its database and shared databases require distinct schema names. To assign a schema to an additional console deployment, run its first projection refresh from the CLI with that deployment ID and schema. The console uses the stored claim on later refreshes.

`npm start -- objects list --json` reports published views and their assigned aliases for the selected scope. Use `npm start -- objects columns Opportunity` to look up source fields and view columns. The console's Objects page shows the view and a copyable query. Names use lowercase snake case, shorten long identifiers with a stable hash, and append numeric suffixes for conflicts. Housekeeping columns retain their wide-table names. A field keeps its alias while it remains in the projection, with one upgrade exception. The first projection refresh with the upgraded source adapter recreates readable views that had duplicate owner, creator, last modifier or deletion flag attributes. It removes the old suffixed aliases from the registry. Use `owner_id`, `created_by_id`, `last_modified_by_id` and `is_deleted` for those values. The hashed wide tables keep their existing columns. Genuine naming conflicts retain their numeric suffixes.

With write-back enabled for an object, inserts and updates through the view follow the existing SQL write-back policy and request pipeline. The change processor applies eligible requests to Salesforce. Deletes through the view fail with the write-back delete message. Give readers schema `USAGE` and view `SELECT`. Grant edit privileges to SQL editors only for objects with write-back enabled.

A rebuild with a compatible shape rebinds the view in place. A removed field or changed type can require replacing the view. That preserves its owner and grants on the view and surviving columns. If a downstream database object prevents replacement, the refresh rolls back. Migrate the dependent object before retrying.

## Scheduling and change events

Apply the migrations through `20261201_change_events` and build the CLI. Run `npm start -- run` as a long-running process for the selected deployment. The scheduler uses the saved object selection or CLI configuration, and groups objects with the same inbound interval. Scheduled record runs update wide tables when projection refresh is enabled. Metadata runs discover objects for wildcard selections and refresh published view definitions. Outbound runs process the existing write-back queue.

```sh
npm start -- schedule show --json
npm start -- schedule set --inbound 5m --object Opportunity=1m --object Task=30m --outbound 10s --metadata 24h --budget 50
npm start -- schedule clear --object Opportunity
npm start -- schedule pause
npm start -- schedule resume
npm start -- deployment status
```

Intervals accept integer seconds, minutes and hours with `s`, `m` and `h` suffixes. Defaults are five minutes inbound, ten seconds outbound, and 24 hours for metadata. The minimums are one minute for inbound and its overrides, and one second for outbound and metadata. The CLI and console edit the same database settings. The Schedule section shows the scheduler heartbeat, API usage and the last and next slots for each unit. Pause prevents new scheduled units from starting. An active unit finishes before the pause takes effect.

Keep one scheduler per deployment and use the same config directory for the scheduler, console, and manual syncs on that machine. Each unit acquires the deployment run lock and releases it on completion. A busy unit skips to its next slot. Small jitter spaces the units out. Failed units retry with a delay that starts at one second and doubles up to the unit's interval. A success restores the normal schedule. Ctrl+C or SIGTERM drains the current unit and exits with code 130. After a hard stop, confirm the process has stopped before removing a stale scheduler or run lock. Manual syncs and `changes process --watch` remain available.

The API budget defaults to 50% of the reported org-wide daily limit. The CLI and console reject settings that project more calls per day than the budget. Projections use mean calls per scheduled unit over the previous seven days. Without measurements, the estimate reserves four calls per object per record run, one discovery call plus one call per object for metadata, and five outbound calls per five minutes at the default polling rate. Until the source reports its limit, the projection uses a 15,000-call planning limit. A wildcard projection uses the known objects in the replica until scheduled discovery has run.

When reported usage reaches the budget, due inbound record units wait until the next UTC day or until a refreshed usage reading or budget edit permits them. A source limit error defers inbound records until the next UTC day. A running unit can finish its calls before these checks take effect. Metadata and write-back keep their own intervals.

### Live updates per object

In Salesforce Setup, open Change Data Capture and move the objects you want to Selected Entities. Orgs limit the number of selected entities. Use the deployment’s OAuth sign-in. The user needs access to check Setup configuration and the appropriate permission to receive events for each object. See [Salesforce Change Data Capture permissions](https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-security-perms.html).

```sh
npm start -- schedule set --events Opportunity,Contact
npm start -- schedule clear --events Contact
npm start -- deployment status --json
```

You can also use the Live updates switch on each object row in the console Schedule section. The scheduler coalesces a burst of notifications per object for two seconds and then runs an incremental records sync and, when enabled, an in-place projection refresh. The same deployment run lock protects both scheduled and event-triggered syncs. Write-back echoes follow the same records path. Scheduled polling keeps its existing interval, and both kinds of inbound work honor the daily API budget and limit pause. Additional syncs depend on event volume, so the scheduled call projection is a baseline.

ReplCRM stores the latest replay position and pending records refresh together in PostgreSQL. A rejected or expired position is cleared. The subscription continues from new events and queues a catch-up poll. Gap and overflow notifications also queue catch-up polls. Status shows each object's live updates setting, connection state, last notification, and pending and completed catch-up polls. The scheduler keeps polling and retries a failed subscription with exponential back-off up to one minute. Pausing the schedule also suspends live updates.

The adapter uses Salesforce Streaming API long polling over CometD (Bayeux) with the existing OAuth refresh path. Pub/Sub API would need gRPC and Avro libraries, which this deployment avoids. See [Salesforce streaming and replay](https://developer.salesforce.com/docs/platform/platform-events/guide/platform-events-subscribe-cometd.html).
