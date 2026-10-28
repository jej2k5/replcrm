# Roadmap

Direction, not a delivery commitment. No dates are promised. Status means code/evidence in this repository, not that a production deployment has been validated.

## AVAILABLE

- Salesforce SourceAdapter, the only implemented CRM connector.
- Canonical CRM metadata/value model and metadata discovery.
- ReplicaStore v1: V1_READY persistence contract for serialized, ordered at-least-once replication. This is not a ReplCRM v1 release.
- PostgreSQL ReplicaStore using Prisma, the only production persistence implementation.
- InMemoryReplicaStore, an ephemeral reference/testing implementation.
- Incremental record replication, qualified relationship repair, opaque checkpoints and convergent replay.
- Projection publication/discovery and the PostgreSQL projection registry.
- Shared PostgreSQL/memory semantic tests, persisted-state reopen/failure injection, and database-free core execution tests.
- Credential-free public smoke coverage; private application destination integrations are excluded from this distribution.

## IN PROGRESS

- Final private release review: source/attribution approval is documented; private reporting contacts and historical credential-use confirmation remain human publication actions.
- Operational readiness remains pending: populated-database upgrade, record/reference preservation, live source replication, repeated-run behavior and external projection-consumer validation.

## PLANNED

- Snowflake ReplicaStore as the first non-PostgreSQL challenge to the contract. Reviewed/planned only; no implementation or production driver is installed.
- Microsoft SQL Server / Azure SQL ReplicaStore.
- Oracle ReplicaStore.

Each new store needs real runtime evidence and the shared contract suite. The common boundary remains ReplCRM semantics; drivers, physical schemas, indexes and bulk ingestion may differ.

## EXPLORATORY

- Store-private bulk replication optimizations, selected only after measurement.
- Additional source-adapter proposals where there is demand and a concrete neutrality/test plan. No additional CRM connector is committed here.
- Historical Python feasibility research remains in the private archive and is not part of this distribution or the selected portability architecture.
