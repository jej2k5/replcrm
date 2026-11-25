# Changelog

Changes will be recorded here for future releases. This file does not assert that a tagged or published release exists.

## 0.4.1 (2026-11-25)

### Try it without Salesforce

- `npm run demo` opens the console on a fictional Salesforce org held in memory, with no credentials, database or network access. Syncs and write-back run against the fictional org; setup and sign-in are disabled; every page is labeled as demo data. Calls to the fictional org are paced so a sync's pipeline stages are visible.
- The README opens with a recording of the demo console (`docs/assets/console-demo.gif`).

### Container image

- The runtime image no longer ships build-only packages (TypeScript, tsx, esbuild, PGlite). The Prisma CLI used by console setup is kept. Size on linux/arm64 dropped from 377 MB to 317 MB.

### Documentation

- The README leads with what ReplCRM does today and gives write-back and Change Data Capture their own section. Links to files outside this distribution were fixed or removed, Node 22 is stated consistently, and wording left over from before publication was removed.

## 0.4.0 (2026-11-25)

### Live replica

- Flat tables in the `wide` schema update in place from a durable per-object watermark: changed rows are upserted and tombstones set `is_deleted`. A new attribute adds a column and backfills it; a PostgreSQL-castable type change alters the column in place.
- Rebuilds happen only on first publication, the first refresh of a legacy table, an uncastable type change or `projections --rebuild`. They build a replacement table and swap it in one transaction, keeping valid indexes, grants, comments, compatible dependent views and write-back triggers. The CLI and console run log name the object and the reason.
- Readable views per object, such as `replica.opportunity`, with snake_case column names. `REPLICA_VIEW_SCHEMA` sets the schema; `objects columns <Object>` maps source fields to view columns; the console Objects page shows each view with a copyable query. Inserts and updates through a view follow the write-back policy.
- The first refresh after upgrading removes duplicate owner, creator, last-modifier and deletion-flag aliases from readable views.

### Scheduling

- `npm start -- run` runs scheduled inbound record sync (default every 5 minutes), write-back (10 seconds) and metadata refresh (24 hours) for one deployment, with per-object inbound overrides. It shares the deployment run lock with manual runs; Ctrl+C or SIGTERM finishes the active unit and exits with code 130.
- `schedule show|set|clear|pause|resume`, schedule details in `deployment status`, and a Schedule section in the console.
- API budget guard, defaulting to 50% of the org's reported daily limit. Settings whose projected daily calls exceed the budget are rejected, and due inbound work waits when reported usage reaches it or Salesforce reports a limit error.

### Change Data Capture

- Opt-in live updates per object with `schedule set --events` or a switch per object in the console. Objects must be selected under Salesforce Setup → Change Data Capture and the deployment must use OAuth sign-in.
- Uses the Salesforce Streaming API (CometD) over the existing HTTP client, with no new dependencies. Notifications for an object are coalesced for two seconds and then trigger an incremental records sync under the same run lock and API budget.
- Replay position and pending refresh work are stored in PostgreSQL. An expired replay position, gap or overflow queues a catch-up poll. Scheduled polling continues, and a failed subscription retries with back-off up to one minute.

### Upgrade

- New migrations: `20261128_projection_watermarks`, `20261129_readable_replica_views`, `20261130_deployment_schedule` and `20261201_change_events`. See [Live replica](docs/live-replica.md).

## 0.3.0 (2026-11-24)

### Write-back

- Change requests for updates and creates, stored in the replica database and sent to Salesforce by a processor. Salesforce remains the system of record. Deletes are refused.
- Write-back is disabled per object until enabled. `writeback status|enable|disable|exclude|include` manage objects and excluded fields. Each submitted field must have the matching create or update capability in Salesforce metadata; computed, system and replica housekeeping fields are always excluded.
- Submission paths: the `submitChange` API with `person`, `app` or `agent` authors and optional idempotency keys; inserts into `writeback.submissions` in SQL; direct SQL edits on wide projection tables; and `changes submit|list|show` in the CLI.
- `changes process` sends one batch, and `--watch --interval N` polls (default 10 seconds) under the shared deployment lock. An update is sent only when Salesforce still holds the editor's base values; otherwise the request becomes a `conflict` with the base, proposed and current values. `changes override`, `changes retry` and `changes resolve` handle conflicts, failures and unknown outcomes.
- Optional attribution: a configured custom text field records the author kind and label on each write.

### Console

- Objects page for per-object write-back policy and field exclusions, and a Changes page with status tabs and counts per deployment.
- Conflict, rejected, failed and unknown requests can be resolved in the console with an operator label.
- New records are labeled with the object and submitted name, for example **New Contact: Priya Shah**. Contacts and Leads fall back to first and last name.

### Maintenance

- tsx upgraded to 4.23.15 (esbuild 0.28.2), resolving the low esbuild dev-server advisory in the development toolchain.
- A console test now waits by elapsed time instead of event-loop turns, removing a timing failure seen in CI.
- New migrations: `20261123_writeback_foundations`, `20261124_salesforce_writer`, `20261125_writeback_queue`, `20261126_console_record_name` and `20261127_direct_sql_edits`. See [Write-back](docs/write-back.md).

## 0.2.0 (2026-11-23)

### Console and setup

- Multi-replica console: every deployment drawn as a live pipeline (Salesforce, Discover, Reconstruct, Replicate, Postgres) with a health strip, plain-language checks (MATCH, Off by N, Not compared) and a Problems list with next steps.
- Guided setup in the console (Add replica) and the terminal (`npm start -- setup`, `setup status`): database, schema, replica, Salesforce External Client App, sign-in, object selection and a verified first sync. The console starts with nothing configured.
- Shared light/dark design system; self-hosted JetBrains Mono.

### Replication and operations

- Salesforce OAuth sign-in with PKCE (`auth login|status|refresh|logout`), per-deployment stored sign-ins, refresh-token rotation; password mode retained.
- Saved object selection per deployment (`objects available|list|set|add|remove|clear`), custom objects, Task and Event.
- Deletions reach the store from the recycle bin; `reconcile` preview and `--apply` for purged records; `counts` comparison; `deployment verify` org binding; per-deployment run lock shared by console and CLI.

### Distribution

- Same public scope as 0.1.0: the optional application destination, its worker and compatibility shims, and the Python research prototype remain excluded.
- Security: compatible (non-major) updates resolve the critical websocket-driver, high form-data and moderate csv-parse advisories reached through jsforce. One low esbuild advisory remains in the tsx dev toolchain (Windows dev server only, not shipped). The license inventory and `licenses/` bundle were regenerated for the updated tree (148 packages, all permissive).

## Unreleased

### Available baseline

- Source-neutral TypeScript core with the implemented Salesforce adapter.
- Canonical metadata/values, qualified record identity, opaque checkpoints and ordered replay.
- ReplicaStore v1 semantic contract; PostgreSQL/Prisma and in-memory reference implementations.
- Durable completion, idempotent terminal progress, retained metadata and explicit incompatible-change rejection.
- Projection readiness/discovery and shared normative/failure-injection tests.

### Public-release preparation

- Apache License 2.0 text, project notice, contribution/DCO and community policies.
- Public capability/roadmap documentation, issue/PR templates and credential-free PR CI checks.
- Provenance, history and dependency/attribution review with unresolved human gates recorded explicitly.

ReplicaStore v1 denotes the persistence contract. It is not a ReplCRM v1 release. Planned stores are not implemented capabilities.

### Candidate scope

- Exclude private destination/worker integrations and Python research.
- Support Node 22.x across package engines, CI and Docker; no dependency version modernization.
- Preserve all included runtime/contract code and existing tests byte-for-byte from the authorized checkpoint.
- Report 46 public tests (the private baseline had one additional destination test), plus five new public smoke checks replacing the excluded 17 private-import checks.
