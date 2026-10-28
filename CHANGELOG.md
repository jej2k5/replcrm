# Changelog

Changes will be recorded here for future releases. This file does not assert that a tagged or published release exists.

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
