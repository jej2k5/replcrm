# Dependency license audit: source candidate

## Conclusions

**Dependency license compatibility: PASS** for the selected Node dependency closure. **Source-distribution attribution completeness: PASS** for the proposed root commit. No independently sourced proprietary implementation, unknown Node license declaration or known incompatible dependency is included.

These conclusions apply to this source candidate and retained notices, not to an unbuilt binary image or an arbitrary copy of node_modules. Base-image/system-package and platform-specific binary distributions need their own inventory before publication. Nothing is relicensed merely because the project license is Apache-2.0.

## Selection and evidence

The private destination's ioredis, jose and pg dependencies, plus @types/pg, were removed with the excluded integration. Remaining locked versions were preserved; no modernization or new production framework was introduced. The candidate has 150 Node lock entries, 125 installed on the tested platform, and eight direct dependencies. Foreign-platform optional esbuild artifacts were not executed.

The [inventory](dependency-license-inventory.json) records versions, scopes, SPDX declarations and retained notice-file hashes/origins. Packaged metadata and legal text were inspected after a clean candidate-only npm installation. The [notice bundle](../THIRD_PARTY_NOTICES.md) covers all installed dependency packages using packaged legal files, embedded README license sections, matching esbuild upstream license text, and the upstream tr46 MIT text where its old package omitted a separate file. PostgreSQL attribution is retained alongside PGlite's wrapper license. No copyright holder was inferred from an npm author field.

## Direct dependencies

| Package | Locked version | Role | License | Assessment |
| --- | --- | --- | --- | --- |
| @prisma/client | 5.22.0 | Runtime PostgreSQL store | Apache-2.0 | COMPATIBLE; license/notices retained |
| decimal.js | 10.6.0 | Runtime canonical decimal conversion | MIT | ATTRIBUTION_REQUIRED; retained |
| jsforce | 3.10.14 | Runtime Salesforce source | MIT | ATTRIBUTION_REQUIRED; retained |
| @electric-sql/pglite | 0.5.12 | Development/test embedded PostgreSQL | Apache-2.0 plus PostgreSQL material | COMPATIBLE; both notice scopes retained |
| @types/node | 22.19.17 | Development types | MIT | ATTRIBUTION_REQUIRED; retained |
| prisma | 5.22.0 | Development generator/schema CLI | Apache-2.0 | COMPATIBLE; packaged engine/license material preserved, generated binaries excluded from source commit |
| tsx | 4.21.0 | Development/test/smoke runner | MIT | ATTRIBUTION_REQUIRED; retained with esbuild notices |
| typescript | 5.9.3 | Development compiler | Apache-2.0 | COMPATIBLE; LICENSE and ThirdPartyNoticeText retained |

No package is functionally optional in this core CLI selection; foreign-platform esbuild binaries are optional installer choices. Tests use Node's built-in test framework. No separate CLI framework, Snowflake driver, ADBC or SQL abstraction was added.

## Transitive declarations

| License expression | Locked entries |
| --- | --- |
| MIT | 125 |
| Apache-2.0 | 15 |
| ISC | 4 |
| BSD-3-Clause | 2 |
| BlueOak-1.0.0 | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| BSD-2-Clause | 1 |
| UNKNOWN | 0 |

The MIT option is used for dual MIT/CC0 material. Permissive grants and their notice conditions are retained rather than discarded. Metadata compatibility and presence of notice text were checked separately; neither is treated as ownership proof for unrelated code.

## Non-package material and exclusions

Project-owned source, tests, schema and documentation have explicit rights-holder Apache-2.0 authorization. No private application integration or mirrored helper is needed or included. No vendor logos, banners, customer dataset, third-party proprietary source or generated client is tracked. Standard Contributor Covenant text retains its own CC-BY-4.0 attribution; DCO is referenced under its own standard.

Python research is excluded entirely, including psycopg and its binary/LGPL and research-build dependency surface. No Python dependency review remains necessary for this initial distribution because no Python implementation, manifest, wheel or research documentation is included.

## Remaining artifact/publication actions

Verify final private reporting contacts and public repository metadata before publication. If distributing a Docker image or installed dependency tree later, inventory that exact artifact's bundled engine/OS/runtime notices and preserve the supplied legal files. This candidate does not claim Docker image publication/compliance verification. Root NOTICE records `Copyright 2026 HONA LLC` following explicit project-owner confirmation. This attribution covers ReplCRM-owned source and does not assert ownership of dependencies or other third-party material.
