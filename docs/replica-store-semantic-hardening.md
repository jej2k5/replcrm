# ReplicaStore semantic hardening

**Final decision: V1_READY for the documented ReplicaStore contract.** This is not a product release or operational upgrade certification.

## 1. Problems addressed

The [Snowflake adversarial review](snowflake-replica-store-adversarial-review.md) found that the persistence boundary was structurally correct but under-specified. This change makes durable completion, retry/progress ordering, metadata evolution and projection readiness/discovery explicit and runs one shared suite against both stores. Historical review observations remain in the review; its resolution appendix records the changes.

## 2. Final durable-completion definition

A successful mutating operation means its requested logical application is complete and visible to dependent operations. Persistent implementations retain that result across restart; memory explicitly has an instance lifetime and is not a durable production backend. Queued, submitted, uploaded or scheduled work alone cannot satisfy success. Mechanisms are private to the implementation.

## 3. Retry model

At-least-once invocation plus idempotent ordered application and successful-progress discipline yields a convergent replica. Calls remain serialized per deployment. Retry unknown work before later input, or restart the ordered source suffix from successful progress. Arbitrarily interleaving old patches into newer input is outside this ordered protocol, not something the API can silently distinguish from a new source event.

Canonical records/references/metadata converge; invocation audit counts and timestamps may differ across retries. There is no exactly-once guarantee, new auto-retry loop or distributed transaction framework.

## 4. Lost-acknowledgement behavior

An error can occur after application. Record retry uses existing qualified identities and patch order, retaining local IDs without duplicate values/relationships. Metadata replay retains definitions/options; projection replay republishes the same logical identity without name aliasing.

For completion, persisted successful SyncRun state is authoritative. Retrying a successful handle/token is a no-op. `failRun` cannot demote Succeeded; repeated failure marking is safe. A changed token for a completed handle is rejected. A Failed attempt cannot be resurrected; start a new attempt from successful progress.

The shared PostgreSQL tests close/reopen disposable database files and create new client/store wrappers between application and retry. No process-local completion cache is involved. Memory exercises the same logical rules within its explicitly ephemeral lifetime.

## 5. Checkpoint semantics

Tokens remain opaque strings/null, never ranked. Completion publishes the supplied pending set together only after record and required reference work. Local persisted attempt order distinguishes newer progress. An incomplete attempt older than successful progress is rejected; retrying an already successful older attempt cannot replace newer progress. Group validation/application failure publishes none of the proposed new progress. Null-key stage attempts cannot publish entity tokens.

PostgreSQL allocates increasing local attempt timestamps from existing SyncRuns and checks the same persisted ordering used to select successful progress (including legacy tie-breaking). These are local audit order, not source modification cursors. Memory assigns local order inside the instance and derives progress from successful runs, eliminating its formerly divergent checkpoint map.

## 6. Batch/attempt identity decision

**No new batch identity or ledger is required for the existing ordered, single-writer pipeline.** Existing durable run handles, status, entity/deployment scope and local order are sufficient for completion retries. Record and attribute/value identities already provide idempotent patch application. Core already awaits batches in order, and recovery replays the source suffix rather than dispatching stale background batches.

A lost `beginRun` response can leave an incomplete audit attempt; another attempt can replay from the same successful token safely. No new schema column, table, overloaded error field or process-local success cache was introduced. Unordered multi-writer ingestion would require a different, separately designed protocol; it is not claimed here.

## 7. Metadata removal semantics

Discovery retains omitted metadata and historical values. Scope omission does not mean deletion. No active/inactive state or cleanup system was added. A renamed key is a new key; retained attributes remain in logical projections. Record input is restricted to its current supplied canonical definition, so an omitted historical key is not silently accepted as a current source field.

Memory now merges definitions additively, matching PostgreSQL retention. All requested metadata is validated before publication; duplicate keys/options and incompatible evolution leave prior metadata intact.

## 8. Metadata type-change semantics

Changing a stable key's canonical type is rejected without metadata/value/projection reinterpretation. The original value remains readable under its original type. Relationship target-set changes are rejected for the same reason. Authorized incompatible evolution will need a separate explicit policy, not implicit coercion, source timestamp guesses, inferred renames or physical ALTER COLUMN mechanics.

This intentionally changes the previous PostgreSQL behavior that accepted a type update and projected historical values as null. Existing installations that already made incompatible changes need an operator audit/replay plan; this task performs no automatic repair or migration of that historical state.

## 9. Projection readiness definition

Successful publication means requested projections are materialized and resolvable before return. Readiness is the last successful materialization, not an asynchronous submission and not continuous freshness. Later record/metadata mutations require another publication. Failure can leave earlier entity publications or older usable snapshots. Record checkpoints, which precede projections, remain successful after a projection failure.

A descriptor is valid at discovery time and until its publication changes; it is not an immutable-version lease. Multi-entity publication is not an atomic group. Physical implementation choice remains private.

## 10. Projection discovery guarantee

New `resolveProjection(deploymentId, entityKey)` returns a ready `Projection` descriptor, null before publication, or an error if an allegedly published representation is unavailable. The descriptor includes logical identity, sorted canonical attribute keys and an opaque JSON `location`. Core does not interpret physical names, namespaces, mappings or object types.

PostgreSQL reads its existing registry and verifies the published object is available. Its locator supplies the actual schema/object/column mapping, preserving existing SQL consumer compatibility and collision protection. Memory returns an exact logical tuple locator for its stored snapshot. Each store's consumer integration interprets the locator; there is no universal SQL/query API. Consumers refresh discovery after publication changes.

## 11. Ordered patch/batching guarantee

Core remains batch-oriented. Record arrays compose in order, including repeated IDs, missing fields, explicit null and empty collections. A bulk store may fold/apply the whole batch provided it preserves those results and completes application before returning. No per-record transport is required. A failed record batch publishes none of that batch; prior successful batches can survive a later failure and are replayable.

## 12. Contract changes

- Add `Projection` and one method, `resolveProjection`.
- Document durable completion, ordered replay, terminal/idempotent completion and stale-attempt rejection.
- Specify additive metadata retention, incompatible-change rejection and publication/discovery guarantees.
- Keep source interfaces and orchestration signatures unchanged; add no SQL, connection, index, transaction or capability API.

See [the contract](../src/core/replica-store.ts) and [semantic guarantees](replica-store.md). A custom store/delegate must implement the new lookup.

## 13. PostgreSQL implementation changes

- Preserve Prisma and existing tables. Metadata and user batches now publish atomically; incompatible metadata is checked before changes.
- Allocate local attempt order using persisted rows; make successful completion idempotent and immutable, reject stale/conflicting completions, and preserve terminal status with conditional updates on late failure marking.
- Keep complete-run-set publication atomic using existing backend mechanisms.
- Retain projection registry naming/collision protection and publication code; add registry-based discovery and availability verification.
- Return deterministic directory created/updated counts based on scoped existence, replacing timestamp heuristics.
- Validate supplied record metadata against persisted types/targets before writing.

## 14. In-memory implementation changes

- Retain metadata and historical attributes additively; stage metadata/user/batch changes before publishing them.
- Match terminal/run-order semantics and derive successful tokens from runs, rather than maintaining a divergent checkpoint map.
- Preserve/immediately resolve already-known reference targets during replay, matching reference repair's observable count behavior.
- Publish retained-metadata projection snapshots and store their attribute inventory independently from later metadata updates.
- Add opaque snapshot discovery. No database package or generated client is imported.

The shared canonical converter now normalizes the already-established replica decimal precision/range before either store writes, so memory does not accept/round numbers differently from PostgreSQL. This preserves the production value domain while making validation and reads consistent.

## 15. Tests added/converted

The six original adversarial cases are now the first six cases of a reusable normative suite, registered for both implementations. Seven more cases cover invalid batch rollback, record acknowledgement loss/reference replay, stale/conflicting checkpoint replay, grouped checkpoint failure, projection acknowledgement loss/discovery, metadata replay/rejection and deterministic directory replay. Additional decimal-fidelity and terminal completion/failure race cases check the established value domain and prevent late status demotion.

Total shared suite: **15 cases × 2 stores = 30 contract tests**. **8 explicitly labelled failure-injection cases × 2 = 16 failure-injection tests**, included in those 30. Type/metadata/range rejection tests add further negative coverage. No characterization assertions of different intended outcomes remain. Backend fixtures differ only in observation and lifecycle handling.

The PostgreSQL fixture uses fresh on-disk PGlite databases, closes/reopens their files for retry checks, constructs new persistence clients/store wrappers and tears down the disposable directories. Tests do not contact an operator database. They exercise real embedded PostgreSQL SQL through the existing Prisma-shaped test port; they are not live Prisma-driver or production durability certification. The database-free transitive-import blocker remains in the unchanged existing suite.

## 16. Migration impact

**NO DATABASE MIGRATION REQUIRED OR CREATED.** Existing SyncRun identity/status/order/cursor fields and the existing projection registry contain the required state. Prisma schema and migrations are unchanged. Test helper support for query reads and disposable file-backed reopen is test-only. No operator database was accessed or migrated.

## 17. Compatibility impact

Salesforce source normalization, canonical source types, entity-qualified identity, opaque keys, collections, references, CLI and worker composition and optional Moat destination are preserved. No additional source/store/driver dependency was added.

Intentional changes: incompatible metadata now fails explicitly; late completion failure cannot demote success; stale/conflicting attempts fail; directory counters no longer use timing heuristics. Custom ReplicaStores must add projection discovery. Earlier Python research and its observer edit were not touched. This work does not repair old inconsistent datasets or certify their operational upgrades.

## 18. Verification results

Executed after implementation:

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0; also rebuilt by the final `npm test` pretest hook |
| `npx prisma validate` | PASS, exit 0; validation only |
| `npm test` | 47 passed, 0 failed, 0 skipped |
| Shared ReplicaStore contract suite | 15 cases per store; 30 passing executions, same assertions for both stores |
| Explicit failure-injection tests | 8 cases per store; 16 passing executions, included above |
| Existing non-adversarial baseline | All 17 existing tests pass unchanged |
| `npm run import-smoke-test` | 17 passed, 0 failed |
| Characterization-only tests remaining | 0 |
| Prisma schema / migrations | Unchanged; no new migration required or created |
| Core database-import blocker | PASS within the existing suite |
| Working-tree whitespace checks | PASS |

PostgreSQL retry verification reopens disposable on-disk PGlite files. No live operator database, Prisma-engine integration, Salesforce replication, production image publication or Snowflake runtime was tested. Existing Node module-registration deprecation warnings did not fail checks.

## 19. Remaining questions and readiness scope

The ordered single-writer contract is explicit. Multiple uncontrolled writers, arbitrary delayed out-of-order patches, immutable projection-version leases and destructive/incompatible metadata upgrades are excluded rather than silently claimed. Future requirements in those areas need separate design and evidence. Memory remains an ephemeral reference store, not a persistence product.

Live CRM replication, a populated operator-database upgrade, production Prisma-driver restart/failure behavior, crash durability, external consumer upgrade and production image publication are not validated by these fixture tests. A contract readiness decision does not release/tag ReplCRM v1 or remove those operational gates.

**V1_READY** applies to this precise ordered, single-writer semantic contract: both stores pass identical normative cases; lost acknowledgements converge; checkpoint monotonicity uses local attempt order; metadata evolution and projection discovery/readiness are explicit; no PostgreSQL mechanics cross the interface. There are no unresolved ambiguities in the four hardening decisions. The excluded future requirements and unperformed operational validations above remain separate gates. No release/tag, commit or push was created.
