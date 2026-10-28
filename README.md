# ReplCRM

**Discover. Reconstruct. Replicate.**

Metadata-driven CRM replication engine with source-neutral adapters and pluggable replica stores.

ReplCRM discovers CRM metadata, reconstructs a canonical model, and incrementally replicates records and relationships into an independent replica store. This source candidate is prepared for private review, not public release. See the [publication manifest](docs/oss-publication-manifest.md) and [readiness report](docs/oss-clean-release-readiness.md).

## Architecture

```text
CRM Source → SourceAdapter → ReplCRM Core → ReplicaStore
                                              ├─ PostgreSQL (Prisma)
                                              └─ InMemory (reference/testing)
```

Source adapters own native CRM semantics. Core consumes canonical metadata/values/relationships and depends on ReplCRM's persistence contract, not a SQL library or database driver. Stores choose their own drivers, schemas, indexes, bulk loading and projections while preserving the same logical guarantees.

| Component | Status |
| --- | --- |
| Salesforce SourceAdapter | Implemented; only implemented source |
| Canonical/core replication | Implemented |
| ReplicaStore v1 | Implemented, V1_READY persistence contract |
| PostgreSQL ReplicaStore | Implemented; only production persistence store |
| InMemoryReplicaStore | Reference/testing, ephemeral |
| Snowflake ReplicaStore | Planned, not implemented |
| Azure SQL / SQL Server ReplicaStore | Planned, not implemented |
| Oracle ReplicaStore | Planned, not implemented |

ReplicaStore v1 is a contract version, **not a ReplCRM v1 release**. The guarantee is ordered at-least-once invocation plus idempotent application and checkpoint discipline, not exactly-once delivery. Runs must be serialized per deployment.

Private application destination/worker integrations and Python research are intentionally absent. No private repository, application server, Redis service or research environment is needed to build or test this project. Replication covers CRM metadata/data, not complete org configuration such as Apex or Flow.

## Development setup

Use **Node 22.x** and its bundled npm. The candidate is verified on Node 22.23.4; `.nvmrc`, package engines, CI and all Docker stages use major 22. Other majors are not certified by this candidate.

From this directory (which may simply be named `replcrm/`):

```sh
npm ci
npm run prisma:generate
npm run typecheck
npm run build
DATABASE_URL=postgresql://user:password@127.0.0.1:5432/replcrm_validation npx prisma validate
npm test
npm run smoke-test
```

The URL above is a syntax-only dummy for Prisma validation, not a service credential. Verification uses fake sources and disposable embedded PostgreSQL; it needs no external database or Salesforce account. `npm test` builds before running. There is no formatter/lint command beyond TypeScript checks and whitespace review.

The public suite has 46 tests, including 30 shared store-contract executions and 16 failure-injection executions. Five additional public smoke checks verify CLI help, blocked database imports, canonical values, projection discovery and disposable PostgreSQL replay. The private baseline's destination test and 17 application-import smoke checks are excluded, not relabelled as public tests.

## Configuration and replication

For actual replication, provision an independent PostgreSQL database and an authorized Salesforce integration account. Copy `.env.example` to a local `.env`, fill in actual values, and follow the [operator setup guide](docs/operator-setup.md) to apply the checked-in schema and create the `Deployment` row. This preparation does not run those operator commands.

```sh
cp .env.example .env
# Configure and provision the independent database; see the operator guide.
node --env-file=.env dist/cli.js
# Alternatively, with settings already exported into the shell:
npm run replicate
```

The current CLI composes Salesforce with PostgreSQL. It does not have a working selector for planned stores. It discovers metadata, applies records, repairs qualified references, publishes opaque checkpoints and optionally refreshes projections. Repeat for incremental synchronization, one writer per deployment.

| Domain | Configuration |
| --- | --- |
| Core | DEPLOYMENT_ID, SYNC_BATCH_SIZE, SYNC_ENTITIES, SYNC_ENTITY_DENY, BUILD_WIDE_VIEWS |
| Salesforce source | SF_LOGIN_URL, SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN |
| PostgreSQL store | DATABASE_URL |

`SYNC_ENTITIES=*` enables discovery; `BUILD_WIDE_VIEWS=false` skips projection refresh. npm CLI scripts use exported variables; the compiled Node command explicitly loads `.env`. Prisma commands may load `.env` themselves. No `.env` or real credentials are included in this candidate.

There are no discover-only/metadata-only/records-only CLI stages. Legacy `migrate:*` commands still execute the full pipeline and warn. Private destination/worker/export commands and their dependencies are intentionally not distributed here.

## Persistence and projections

Logical identity is deployment + entity + source record ID. Values preserve collections, explicit null and partial patches. Checkpoints are source-defined opaque tokens; local attempt order protects successful progress, and late failure cannot demote success. Consumers discover the last ready projection through `ReplicaStore.resolveProjection` or the PostgreSQL registry, never by deriving physical names.

Read the [core contract](docs/core-contract.md), [ReplicaStore guarantees](docs/replica-store.md) and [architecture principles](docs/architecture-principles.md). Existing databases need the checked-in scoped-identity upgrade; external wide-table consumers must use the projection registry. No populated-operator upgrade, live CRM replication or production image publication has been validated by this candidate.

## Containers

The Dockerfile targets Node 22 in each stage and retains project/dependency legal material. A container build requires public npm/image access. The Docker image itself is not built or published by this preparation; review its final platform/OS-package inventory before distributing a binary image. No release/publishing workflow or remote registry is configured here.

## Community and licensing

See [CONTRIBUTING](CONTRIBUTING.md) for DCO and verification expectations, [governance](GOVERNANCE.md), [roadmap](ROADMAP.md), [changelog](CHANGELOG.md), [security policy](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md). Verified private reporting contacts remain final human publication actions; do not post sensitive reports publicly.

HONA LLC is the project steward and copyright holder for ReplCRM-owned source. **Copyright 2026 HONA LLC.** Project-owned source is licensed under the **Apache License, Version 2.0**: [LICENSE](LICENSE), [NOTICE](NOTICE). Third-party licenses remain independent: [notices](THIRD_PARTY_NOTICES.md), [dependency audit](docs/dependency-license-audit.md). Contributor Covenant retains its upstream attribution/license. `private: true` prevents accidental npm publishing.

ReplCRM is an independent project, not an Apache Software Foundation project or affiliate. Technology names describe capabilities/plans, not sponsorship or endorsement. No vendor logos or external banners are included.
