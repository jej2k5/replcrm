# ReplicaStore persistence boundary

ReplCRM stays on TypeScript. The ReplCRM-owned `ReplicaStore` is the portability boundary. Prisma and PostgreSQL projection SQL remain inside `src/stores/postgres/`. `src/stores/memory/` executes without a database, generated client, SQL or driver.

```
CrmSource → ReplCRM Core → ReplicaStore
                             ├─ PostgresReplicaStore → Prisma → PostgreSQL
                             └─ InMemoryReplicaStore → JavaScript collections
```

## ReplicaStore semantic guarantees

### Durable completion

When a mutating operation resolves successfully, its requested logical state is applied and visible to dependent operations in the store's lifetime. A persistent store retains that state across connection and process lifetimes; the explicitly ephemeral memory store retains it for its instance lifetime only. It is not a restart-durable production store. Database recovery, not a process-local success cache, establishes PostgreSQL outcomes.

Accepted, queued, buffered, submitted, scheduled or uploaded work is insufficient. An implementation using asynchronous transport must await verified logical application before returning. `completeRuns` may publish progress only after records and required reference repair have finished. No physical mechanism is prescribed by this rule.

### Idempotent replay and attempt identity

Invocation is **at least once**, not exactly once. Qualified record/value identity and ordered patch application provide convergence. Replaying a logical batch before proceeding to newer work preserves record IDs and final values; replaying a source suffix from the last successful checkpoint reconstructs the same final replica without duplicate logical records or relationships. Metadata upserts and projection publication are replay-safe too.

The caller must serialize work per deployment and preserve source/batch order. Retry an unknown batch before advancing to the next batch, or restart the ordered source suffix from successful progress. An arbitrary delayed old patch interleaved into newer work is not a retry protocol: the API cannot distinguish it from a new source change. Do not dispatch unsupervised background writes after a persistence promise settles. External single-writer ownership remains a runtime responsibility.

Existing durable run handles distinguish completion retries from new progress. No batch ledger or new schema is needed for this ordered model. `beginRun` creates a fresh attempt, not an exactly-once invocation receipt; an acknowledgement lost before its handle reaches the caller may leave a harmless incomplete audit attempt. On recovery, begin a new attempt from successful progress and replay the source suffix. Reusing a known successful handle/token is a no-op; a different token for that successful handle is rejected.

Counts describe the current invocation's actual processing, not exactly-once business events. Replayed inserts may report updates. Audit timestamps, failed/running attempts and physical projection objects are not promised to be byte-identical after replay; canonical state and successful progress converge. Original successful completion counts are not overwritten by later completion retries.

### Checkpoint discipline and opaque checkpoints

A checkpoint is a source-defined `string | null`, including `page-token::abc123`, `cursor:v7:xyz`, `opaque-value` and empty strings. Neither store nor core derives, parses, compares or sorts tokens.

Core awaits all record batches and qualified reference repair before completing the pending entity runs together. The supplied completion set is all-or-none. A later known failure leaves earlier successful progress available for replay. Successful attempts cannot be demoted by `failRun`; repeated failure marking is safe. A Failed attempt cannot later complete: start a new attempt instead.

Monotonicity means **no older local attempt can replace newer successful progress**, not that one token is greater than another. Local attempt order is implementation-owned. PostgreSQL uses persisted SyncRun ordering, allocating a strictly increasing local start order; memory uses its instance run order. Successful old-attempt completion retries are no-ops even after newer progress. Incomplete stale-attempt completion is rejected. Stage runs use a null entity key and cannot publish an entity checkpoint.

### Failure semantics

| Operation | Success guarantee / failure boundary |
| --- | --- |
| `persistMetadata` | Complete request validated/applied as a unit. Rejection does not partially change metadata |
| `persistUsers` | Complete directory batch applied as a unit; username conflicts are rejected without partial application |
| `persistRecords` | All ordered patches in the batch applied as a unit; invalid input leaves that batch unapplied |
| `resolveReferences` | Qualified-reference repair finished; a failed repair may leave already-applied repair work, but retry converges and core publishes no new progress |
| `beginRun` | Attempt exists and returns prior successful token; a lost response may leave an incomplete audit row |
| `completeRuns` | Supplied successful progress set published together; known failure publishes none; an unknown outcome is recovered using durable attempt state |
| `failRun` | Running attempt marked Failed; successful/failed terminal state is preserved on repeat calls |
| `ensureProjections` | Requested logical projections are published and discoverable before success; failure may leave earlier entity publications or the previous usable projection |
| `resolveProjection` | Returns the last successfully published consumer descriptor, null if never published, or an error if published representation is unavailable |

A caller-observed error does not prove non-application: the acknowledgement may have been lost after application. Replay under the ordered protocol is safe. A successful checkpoint is never rolled back because its completion response or a subsequent projection publication failed.

### Ordered patches and batching

Source batches are consumed sequentially. Record patches within a batch apply in array order. Missing fields remain unchanged, explicit null clears a value, and [] remains a collection. Repeated identities in one batch compose patches; selecting only the last row would lose earlier present fields. Identity remains `(deploymentId, entityKey, sourceId)`.

A store may apply a whole batch using a set-based or bulk mechanism. It need not implement per-record network calls, SQL upserts, an EAV layout or the reference helper's storage columns. It must preserve ordered patch results and the completion barrier. Canonical values and qualified relationships retain their existing contract. Both implementations normalize the established replica decimal domain (38 total digits, 18 fractional digits, half-away-from-zero rounding) before persistence, with out-of-range rejection; no driver's floating-point conversion defines canonical reads.

### Metadata evolution

Discovery is **additive retention**, not deletion. Omitted entity/attribute keys remain known and historical values remain available. Scope exclusion does not signal source deletion. A renamed canonical key adds another attribute; labels are not identity. No active/inactive/removed state or physical cleanup lifecycle is invented here.

A current source definition still controls which fields a record batch may supply. A retained historical field omitted from that definition cannot be supplied as if it were currently declared. Projections include retained attributes, including historical values and null for records with no value.

Changing an existing canonical key's type is rejected **before metadata mutation**, even if it currently has no records. Discovery does not coerce, null out, or reinterpret historical values. Relationship target-set changes are likewise rejected rather than reinterpreting retained references. An incompatible change needs a separately authorized upgrade/replay policy, not an automatic rename or migration. Ordinary labels, flags, option snapshots and compatible metadata updates remain supported. Duplicate entity keys, attribute keys and option values in a request are rejected.

### Projection readiness

Successful `ensureProjections` means all requested logical projections have been materialized/published, and can be discovered through `resolveProjection`. `rowsLoaded` is the published logical row count. A submission receipt or unfinished refresh is not readiness. Core does not prescribe table/view/object technology.

Readiness refers to the **last successful publication**, not continuous freshness against later replica mutations. Subsequent records/metadata do not silently mutate a published memory snapshot; PostgreSQL wide tables likewise need refresh. Projections follow successful record checkpoints. A failed refresh can leave an older usable publication, and multi-entity publication is not atomic as a group. Retry projections directly through the store without replaying source records if source progress already succeeded. No new projection-only CLI command is claimed.

### Projection discovery

`resolveProjection(deploymentId, entityKey)` returns `{deploymentId, entityKey, location, attributeKeys}` or null. A non-null descriptor is ready at lookup time. `location` is an opaque store-supplied JSON value interpreted by that store's consumer integration; core must not parse it or derive a name from a canonical key. This is a discovery contract, not a universal query API.

The PostgreSQL descriptor contains the registry's schema/object/attribute-column mapping; existing consumers may continue querying `wide.__replcrm_projections`. The memory descriptor identifies an in-memory snapshot and is consumed through `readProjection`. Other stores may have different locators/readers. Consumers must refresh discovery after a publication/schema change; a descriptor is not an immutable version or lease on an old schema.

Logical keys remain opaque, including punctuation, case and long keys. Different logical projections cannot alias one physical representation. PostgreSQL retains its collision-protected registry and per-entity atomic registry/object replacement; memory uses exact tuple keys. No new registry columns or schema migration are required.

## What ReplicaStore does not guarantee

- Identical physical schemas, SQL behavior, indexes, transaction mechanisms, driver APIs or bulk-loading paths.
- Exactly-once invocation, exactly-once audit counters, arbitrary unordered redelivery, multiple uncontrolled writers or a distributed lease service.
- Restart persistence for the intentionally ephemeral in-memory store.
- All records, metadata, reference repair, checkpoints and projections changing as one global unit.
- Continuously fresh projections, immutable projection handles, or automatic destructive schema/type migration.
- Automatic repair of pre-existing inconsistent historical data from older versions.
- A universal reader or portability of the existing optional destination's PostgreSQL-specific reader.

## Internal API and compatibility

`runReplication({ store, config, sourceClient })` and its `runMigration` alias are unchanged. Production CLI and worker composition remain PostgreSQL/Prisma. Canonical source interfaces, Salesforce behavior, collection values, qualified identity and optional destination routes remain unchanged.

The port gains only `Projection` and `resolveProjection`. Custom stores/delegates must implement this lookup. Successful completion becomes terminal/idempotent; stale/conflicting completion is rejected. Metadata type/target changes now fail explicitly rather than silently reinterpreting historical data. User creation/update counters become deterministic per invocation. These are intentional semantic hardening changes. No automatic retry loop, new source connector, universal database abstraction or new production store was introduced.

## Verification and reusable contract tests

`tests/helpers/replica-store-contract.ts` registers the same normative cases for either backend using only backend-specific observation fixtures. `tests/replica-store-adversarial.test.ts` supplies memory and PostgreSQL fixtures; all six original adversarial cases are now normative, not characterizations of differing results. The PostgreSQL fixture uses fresh, disposable on-disk PGlite databases and actually closes/reopens them with new persistence clients/wrappers during retry cases. This demonstrates recovery from persisted state rather than a wrapper-local success cache; it is not a production server/Prisma-engine/crash-durability certification.

The database-free core still runs under a transitive database-import blocker. Existing fixture, persistence, source and destination tests remain part of `npm test`; `npm run smoke-test` runs the public credential-free smoke checks. Private destination tests are excluded from this source distribution. See [candidate verification report](oss-clean-release-readiness.md) for executed results and limits.
