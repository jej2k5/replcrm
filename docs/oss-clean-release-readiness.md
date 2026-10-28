# Clean release-candidate readiness

**Status: READY_FOR_PRIVATE_REVIEW.** This is a source candidate for private review, not permission to publish or a ReplCRM v1 release. ReplicaStore v1 names the persistence contract only.

## Source and inclusion

The authoritative private archive is `jej2k5/replcrm`; the source checkpoint is `67be373d5afb16091f617898ee466acdf1dd3d78`. Explicit rights-holder Apache-2.0 authorization was applied to project-owned source. Third-party terms were reviewed separately. [Publication decisions](oss-publication-manifest.md) and [input hashes](source-selection.json) make selection explicit.

Included: canonical core, Salesforce adapter, ReplicaStore contract, PostgreSQL/Prisma store, in-memory store, CLI/configuration, original schema/migrations, public tests/helpers, independent smoke suite, build/package/container configuration, community/legal files and public documentation. Production source and retained baseline tests match the checkpoint byte-for-byte.

Excluded: optional private Moat/application destination and worker, compatibility exports, their test and 17 original smoke checks, Python research/observer, internal/historical audits/skills, vendor artwork, private history, local configuration/credentials, caches and generated dependencies/build output. No excluded component is needed by the retained build or tests. Dependencies were installed cleanly inside the candidate; none were copied from the archive.

## Licensing and provenance

Project-owned source is authorized for Apache-2.0 distribution. LICENSE contains the canonical Apache 2.0 text (SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`). The project owner has confirmed HONA LLC as copyright holder and project steward. NOTICE records `Copyright 2026 HONA LLC` for ReplCRM-owned source; third-party ownership and attribution are unchanged.

**Dependency compatibility PASS; source-distribution attribution completeness PASS.** Eight direct packages and the 150-entry lock closure have reviewed permissive declarations; 125 packages were installed on the tested platform. Required packaged/upstream legal texts and TypeScript/PostgreSQL third-party notices are retained in licenses/ with origin/hash inventory. No dependency software, native engine or OS image is committed. See [audit](dependency-license-audit.md) and [notices](../THIRD_PARTY_NOTICES.md). Exact future binary/container artifacts need a separate inventory; no such artifact was published or certified here.

## Credentials and historical review

The source archive's prior redacted history review found two distinct password literals across six blob locations in localhost development connection examples and repeated historical audit material. Their documented context is **LOCAL_DEVELOPMENT_ONLY**. Whether either value was reused elsewhere remains **HUMAN_REVIEW_REQUIRED**; no evidence reviewed demonstrates a live reusable credential. No value is reproduced here or copied as an example. No confirmed ROTATION_REQUIRED credential was established. This is not proof the values were never live: the owner must confirm use/reuse, and rotate any still-valid or reused value before publication. No rotation or credential-connection attempt was performed.

The clean root history excludes the old blobs, but does not remediate credential reuse. Candidate examples use unmistakably synthetic placeholders and localhost dummy URLs. No customer data, private endpoints or known live credentials were found. The full publication-tree Gitleaks scan and targeted checks are recorded in [verification evidence](verification-evidence.json). Scanning is evidence, not a guarantee against every unknown secret.

## Security contacts and public infrastructure

SECURITY.md and CODE_OF_CONDUCT.md explicitly require the maintainer to configure/test private reporting/enforcement mechanisms before publication. No invented address, personal contact or response SLA was added. These are final human publication actions allowed at the private-review gate.

PR CI is credential-free: pull_request/push only, read-only contents permission, immutable action pins, checkout credential persistence disabled, no secret references or publishing/deployment steps, fake sources and disposable embedded databases. No pull_request_target or credentialed integration path is included. Static configuration review and local commands passed; a hosted fork PR run has not been observed.

Node 22.x is the selected supported baseline across engines, .nvmrc, CI, docs and all Docker stages. The official Node 22.23.4 archive was checksum-verified and used for verification. [Node release policy](https://nodejs.org/en/about/previous-releases) identifies this supported LTS line; Node 20 is no longer the candidate baseline. Native macOS arm64 execution is verified. Linux CI execution and Docker build/publication are not verified here.

## Actual executable verification

| Check | Result |
| --- | --- |
| Independent clean npm ci | PASS, 125 packages installed |
| npm run prisma:generate | PASS, client 5.22.0 |
| npm run typecheck | PASS |
| npm run build | PASS |
| npx prisma validate | PASS, syntax-only dummy URL |
| npm test | PASS, 46 passed, 0 failed, 0 skipped |
| Shared ReplicaStore contract executions | 30 passed across PostgreSQL/PGlite and memory |
| Failure-injection executions | 16 passed, included in total/contract counts |
| npm run smoke-test | PASS, 5 public checks |
| Private original smoke suite | NOT RUN; 17 integration-specific checks intentionally excluded |
| Characterization-only tests | 0 retained |

Existing regression/contract tests prove collection persistence/projection, qualified identity, opaque entity keys/checkpoints, idempotent replay, failure discipline and ready-projection discovery. The blocked-import test proves fake-source → core → memory without transitive Prisma/SQL/database driver imports. PostgreSQL behavior was tested with disposable embedded PGlite, not a live operator server. No operator migration or live Salesforce replication was performed. A contributor needs only this directory, Node 22/npm and public dependency downloads for the README verification path. Actual replication additionally needs an independently provisioned database and authorized source credentials, documented in [operator setup](operator-setup.md).

## Capabilities and final human publication actions

Salesforce and PostgreSQL are implemented; memory is reference/testing. Snowflake, Azure SQL/SQL Server and Oracle are planned, not implemented. No new database framework or store was introduced, and existing ReplicaStore semantics/schema were preserved. ReplCRM is independent and implies no Apache Software Foundation or vendor affiliation.

Before public repository creation: review this candidate and its clean root commit; configure/test private security and conduct contacts; confirm historical development-value reuse/remediation; select the public repository URL and update future About/package links; authorize publication separately. Before binary distribution, review/build/test that exact container/artifact and its notices. Populated-database upgrades, live Salesforce replication and external consumer compatibility remain separate operational validations.

The candidate starts with no private .git. The reviewed candidate has one initial root commit on main, followed by a separate ownership-attribution commit, with no remote. Commit identity/count are verified externally after committing, avoiding a self-referential recorded SHA. No private history is imported.

## Ownership-attribution follow-up verification

HONA LLC attribution was finalized without source headers or runtime changes. Typecheck, build, Prisma validation, all 46 tests (30 shared contract executions, including 16 failure-injection executions) and all five public smoke checks passed again under Node 22.23.4. The initial sandbox test invocation could not create the runner IPC socket; the authorized rerun completed successfully. Canonical LICENSE, all retained third-party notices and license texts are byte-identical to the root commit. Package metadata and local Markdown links validate. The publication-tree Gitleaks scan was repeated with zero findings. Project identity remains ReplCRM, Discover. Reconstruct. Replicate.; no ASF affiliation is implied.
