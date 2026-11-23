# Changelog

Changes will be recorded here for future releases. This file does not assert that a tagged or published release exists.

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

- Same public scope as 0.1.0: the optional application destination, its worker and compatibility shims, and the Python research prototype remain excluded. Dependencies are unchanged from 0.1.0.

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
