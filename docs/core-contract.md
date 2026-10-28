# ReplCRM core contract

The source adapter translates native metadata, values, identity, relationships, deletion signals and continuation state. Core consumes canonical source types from `src/core/source.ts` and persists through the ReplCRM-owned `ReplicaStore` semantic contract. Salesforce is the sole implemented connector; the contract does not claim additional connector support.

## Allowed core assumptions

- A deployment identifies one source dataset. Entity keys and attribute keys are stable, case-sensitive opaque strings. Attribute keys are unique within an entity. Keys do not need to resemble SQL identifiers.
- `listEntities()` returns eligible canonical entity keys. `describeEntity(key)` returns the same key, canonical attributes, enum options and explicit relationship metadata. Core does not interpret native type strings or expressions.
- A record is identified by `(deploymentId, entityKey, sourceId)`; the PostgreSQL adapter maps entity keys to `entityDefinitionId`. The original source ID is preserved and must be a nonempty string. Reusing an ID in another entity is valid.
- Relationships name canonical entity keys. A resolved reference is `{kind: "reference", entityKey, sourceId}` within the same deployment. An unresolvable source target is explicitly `{kind: "unresolved-reference", sourceId, candidateEntityKeys}`. Core never chooses a target by examining an ID. A declared multi-target attribute does not imply the actual target is ambiguous.
- A change batch contains record patches and `nextCheckpoint: string | null`. The source owns pagination and token meaning. A missing field is unchanged; explicit null clears it. `isDeleted: true` is a canonical tombstone and requires no value payload or source modification time. Normal changes default to active records.
- A supplied `modifiedAt` is a valid Date representing the source modification instant; missing means unknown and persists as NULL. It never determines progress.
- Core passes the last successful checkpoint back unchanged. Replication runs must be serialized per deployment. It never parses, compares or derives checkpoints. Empty batches may advance them. Entity checkpoints commit together after all record batches and qualified-reference repair succeed. A failed batch or repair leaves the prior successful checkpoints available for replay. Projections run afterward and can be retried independently of source progress.
- Canonical source users form a deployment-scoped directory with stable IDs and unique canonical usernames. A source without directory entries yields an empty stream. This is separate from arbitrary record entities, including entities named User or WideViews.

## Canonical values

| Attribute types | Canonical input | Storage / canonical read |
| --- | --- | --- |
| Text variants, Email, Phone, Url, Enum, Sequence, Identifier, Computed | string | text; empty string preserved |
| Number, Currency, Percent | finite number or finite decimal string | Decimal(38,18); read as decimal string to retain precision |
| Boolean | boolean | boolean, including false |
| Date | valid YYYY-MM-DD string | DATE; read as YYYY-MM-DD |
| DateTime | valid JavaScript Date | UTC timestamp; read as Date |
| Time | HH:mm:ss with optional 1–3 fractional digits | text; no artificial calendar date |
| MultiEnum | string[] | JSON array, including [] |
| Address, Geolocation | finite JSON-compatible value, object or collection | JSON, including nested nulls |
| Reference, Composition | qualified or explicit unresolved reference | local FK when resolvable plus canonical identity JSON retained for repair/read |
| Every type | null | SQL NULL; read as null |

Undefined, native multi-select strings, truthy string booleans and unqualified reference strings are not canonical values. JSON values cannot contain Dates, undefined, non-finite numbers or class instances. Field-type interpretation and native compound-field representation belong to the adapter. Expressions may be stored as opaque metadata; core does not execute them.

## Persistence and projection boundaries

Core depends on the ReplCRM-owned `ReplicaStore` interface, never Prisma, SQL or database drivers. PostgreSQL/Prisma storage types, transactions, foreign keys and scoped uniqueness belong to `src/stores/postgres/`. They do not determine source semantics. The in-memory implementation runs independently of database packages. `readTypedValue()` reverses canonical storage conversion. Reference JSON is retained even when its local FK resolves; this is intentional identity metadata, not a second value interpretation.

Consumers discover the last ready logical projection through `ReplicaStore.resolveProjection`; its locator is store-owned and opaque to core. Readiness, additive metadata retention, incompatible-change rejection and ordered retry rules are defined in [the persistence contract](replica-store.md).

For PostgreSQL, projection SQL binds canonical keys as data and quotes physical identifiers. Tables use deterministic names registered in `wide.__replcrm_projections` by full deployment/entity identity. The registry's unique physical-name constraint rejects a digest collision instead of aliasing identities. Its `column_map` maps full attribute keys to physical columns; reserved, long or otherwise unrepresentable SQL column names receive collision-checked encoded names. PostgreSQL consumers must consult the supplied discovery descriptor or this registry instead of deriving table names from keys. Projections do not define canonical entity identity.

## Forbidden assumptions

Core must not depend on native metadata vocabulary, source API-name grammar, ID prefixes, globally unique record IDs, semicolon multi-select serialization, native deletion fields, timestamp ordering as a checkpoint model, or source-specific query language. Sources need not provide modification timestamps, and tokens need not resemble dates. No concrete adapter, store implementation, Prisma or database driver imports are allowed in core.
