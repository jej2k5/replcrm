# Architecture principles

The core boundary is `SourceAdapter → canonical ReplCRM model → core → ReplicaStore`. Read [the canonical contract](core-contract.md) and [ReplicaStore guarantees](replica-store.md) before proposing extensions.

## Source neutrality

Source adapters interpret native metadata, field representations, IDs, relationships, deletion signals and continuation state. Core must not understand SOQL, Salesforce types or source-specific API-name/ID grammar. Salesforce is the sole implemented source; future connectors do not justify weakening this rule.

## ReplicaStore neutrality

Core depends on ReplCRM operations, not Prisma, PostgreSQL, SQL, a driver or a universal database library. Prisma belongs inside PostgresReplicaStore. A fake source and the in-memory store execute with database imports blocked transitively.

Implementations may choose different drivers, SQL, physical schemas, indexing, bulk loading and projection mechanisms. They must pass the same semantic assertions. Do not add store-type branches in core.

## Canonical values and identity

Normalize source semantics before core. Logical record identity is `(deploymentId, entityKey, sourceId)`; deployment identifies the source dataset. Same source ID in two entities is valid. Keys are opaque and case-sensitive. Preserve arrays, nested values, explicit null, missing-field patches and qualified/unresolved relationships. Physical names must not become canonical identity.

## Checkpoints and convergence

Source checkpoints are opaque strings/null. They advance only after the corresponding records and references are applied. Attempts are locally ordered; tokens are not ranked.

```text
at-least-once invocation
  + idempotent durable application
  + checkpoint discipline
  = convergent replica
```

Runs remain serialized per deployment. Retry in original order or replay from successful progress. This is not exactly-once execution or a guarantee for arbitrary delayed/out-of-order writers. Memory has an explicit ephemeral lifetime; persistent stores must retain applied state across restart.

## Evolution and projections

Metadata omission is non-destructive retention, not source deletion or DROP COLUMN. Incompatible type/target changes are rejected pending an explicit upgrade policy.

Projection success means the promised publication is usable, not merely queued. Consumers resolve logical projections through ReplicaStore and interpret the store's supplied locator; they must not construct physical names. Readiness is the last successful publication, not perpetual freshness or a lease on an immutable schema. Projection failure after successful source progress does not rewind checkpoints.

## Evidence and scope

Passing fixture or compilation checks does not prove live-driver behavior, a populated-database upgrade or production readiness. Document what ran and what remains unverified. New stores/sources require concrete runtime/normalization evidence and explicit compatibility notes. Private application destinations and their authentication/job models are excluded from this distribution.
