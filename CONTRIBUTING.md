# Contributing to ReplCRM

ReplCRM is an independent Apache-2.0 project: **Discover. Reconstruct. Replicate.** Keep the core vendor-neutral and changes small enough to review with executable evidence. HONA LLC is the project steward and copyright holder for ReplCRM-owned source, authorized for Apache-2.0 distribution. Contributions retain their applicable ownership; DCO sign-off is not a copyright assignment. Third-party terms and the [final publication actions](docs/oss-clean-release-readiness.md) remain independent.

## Get started

Use Node 22.x for development and a checkout you are authorized to access. Install with `npm ci`, then run `npm run prisma:generate`. Never put real credentials or customer data in examples, fixtures or issue reports. No live CRM or operator database is needed for the normal suite.

Before a PR:

```sh
npm run typecheck
npm run build
# Supply a syntactically valid dummy DATABASE_URL if none is configured.
npx prisma validate
npm test
npm run smoke-test
git diff --check
```

`npm test` builds first. The fixture suite uses disposable embedded PostgreSQL, including temporary on-disk restart tests. Do not run `prisma migrate dev` against an existing operator database. Integration testing with real services requires a separately authorized disposable environment and separate credentials.

## Issues and pull requests

Start with an issue for broad architecture, a new adapter/store or a breaking contract change. Describe the problem, existing behavior, evidence and the smallest proposed change. Bug reports need a commit/version, source/store, reproduction and redacted logs. Security reports follow [SECURITY.md](SECURITY.md), not public issue templates.

Work on a focused branch and open a PR against `main`. Explain what changes, why, how it was tested, compatibility impact and documentation updates. Maintainer review is required. Prefer normal merges and preserve other contributors' work; do not rewrite shared history casually. See [governance](GOVERNANCE.md).

## Architectural expectations

- Preserve the [canonical core contract](docs/core-contract.md) and [ReplicaStore semantics](docs/replica-store.md).
- Core must not import concrete adapters/stores, Prisma or database drivers. No `store.type` branches or universal SQL abstraction.
- SourceAdapters normalize native metadata, values, identities, relationships, deletions and checkpoints. Test with fake/native fixtures without making core source-aware.
- New ReplicaStores must pass the **same reusable contract suite** in `tests/helpers/replica-store-contract.ts`, including failure/reopen cases and projection discovery. Backend observation fixtures may differ; weakening semantic assertions is not conformance. Compilation or a mocked driver alone is not runtime support.
- Preserve qualified identity, opaque keys/tokens, ordered at-least-once convergence and projection collision protection. Do not claim exactly-once execution.
- Store-specific drivers, schemas, indexes and bulk paths belong inside that implementation. Prisma remains inside the PostgreSQL store.

For a new source/store, propose its scope and evidence plan first. Distinguish implemented, runtime-tested, planned and exploratory behavior. Do not add a connector or dependency just to fill an architecture diagram.

## Style, tests and compatibility

Use TypeScript ESM with `.js` import specifiers, strict types, explicit function argument/return types and the existing two-space style. There is currently no dedicated lint/formatter command; do not claim one ran. Use `npm run typecheck` and `git diff --check`, and avoid unrelated formatting churn.

Add meaningful regressions for changed behavior. Update public docs, configuration examples and CHANGELOG when behavior or setup changes. Keep examples synthetic and license/provenance information intact. Never silently reinterpret an old variable or command. Discuss breaking API, metadata, schema or consumer changes and document an upgrade path; operator migrations require explicit review and authorization.

## Developer Certificate of Origin

Contributions require sign-off under the **[Developer Certificate of Origin 1.1](https://developercertificate.org/)**. Read that standard before certifying. Use your own valid Git identity and add a sign-off to each contribution commit:

```sh
git commit -s
```

The trailer is `Signed-off-by: Your Name <your-address>`. It certifies the standard DCO; it is not a CLA, copyright assignment or an ASF contributor process. Commit identity/sign-offs become part of public history, so review what identity information you submit. Do not sign for someone else or fabricate historical certifications.

Submit only work you have the right to license under the project's Apache-2.0 terms. Identify copied/adapted/generated material, its sources, license and required notices. AI assistance does not remove this responsibility. Maintainers check sign-off during review; no automated DCO enforcement is claimed until configured. No separate CLA is currently required.
