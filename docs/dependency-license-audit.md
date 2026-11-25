# Dependency license audit: source candidate

## Conclusions

**Dependency license compatibility: PASS** for the selected Node dependency closure. **Source-distribution attribution completeness: PASS** for the proposed root commit. No independently sourced proprietary implementation, unknown Node license declaration or known incompatible dependency is included.

These conclusions apply to the source distribution and retained notices, not to an arbitrary copy of node_modules. The published container image has its own inventory and findings in [Container image (0.4.1)](#container-image-041). Nothing is relicensed merely because the project license is Apache-2.0.

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

## Container image (0.4.1)

`ghcr.io/jej2k5/replcrm:0.4.1` (also tagged `0.4` and `latest`) was published by `release.yml` from tag `v0.4.1` on 2026-11-25 for linux/amd64 and linux/arm64. The inventory below was taken from the published image (arm64 index digest `sha256:3343a04e905473e88b337497d4529e99d58831f84c62bc0642be9ced40f96c8b`); the amd64 image reports the same Alpine release (3.24.4) and the same OS package count (21). The 0.4.1 image was built from the official `node:22-alpine` tag. The Dockerfile now pins that same base by digest (`node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a`), so later builds use the inventoried Node and Alpine releases until the pin is deliberately updated.

**Application packages: COVERED.** The image's `/app/node_modules` holds 115 packages after `npm prune --omit=dev`; every one is in the [dependency inventory](dependency-license-inventory.json), and their legal texts ship in the image under `licenses/` with `THIRD_PARTY_NOTICES.md`, `LICENSE` and `NOTICE`. Declared licenses: MIT 91, Apache-2.0 13, ISC 6, BSD-3-Clause 2, BlueOak-1.0.0 1, 0BSD 1, (MIT OR CC0-1.0) 1.

**Runtime from the base image.** Node.js 22.23.5 (MIT, with bundled V8 12.4, ICU 78.3, libuv and other components under their own permissive terms; it links Alpine's OpenSSL 3.5.9). The base image also carries npm 10.9.9 (Artistic-2.0, 197 bundled packages under permissive or CC terms, with their own license files), corepack 0.36.0 (MIT) and yarn 1.22.22 (BSD-2-Clause); ReplCRM does not use them at runtime.

**OS packages (Alpine 3.24.4).** License expressions are Alpine's package metadata.

| Package | Version | License | Origin |
| --- | --- | --- | --- |
| alpine-baselayout, alpine-baselayout-data | 3.7.2-r1 | GPL-2.0-only | alpine-baselayout |
| alpine-keys | 2.6-r0 | MIT | alpine-keys |
| alpine-release | 3.24.4-r0 | MIT | alpine-base |
| apk-tools, libapk | 3.0.9-r0 | GPL-2.0-only | apk-tools |
| busybox, busybox-binsh, ssl_client | 1.37.0-r31 | GPL-2.0-only | busybox |
| ca-certificates-bundle | 20261020-r0 | MPL-2.0 AND MIT | ca-certificates |
| libatomic, libgcc, libstdc++ | 15.2.0-r5 | GPL-2.0-or-later AND LGPL-2.1-or-later (GCC runtime library exception) | gcc |
| libcrypto3, libssl3, openssl | 3.5.9-r1 | Apache-2.0 | openssl |
| musl | 1.2.6-r3 | MIT | musl |
| musl-utils | 1.2.6-r3 | MIT AND BSD-2-Clause AND GPL-2.0-or-later | musl |
| scanelf | 1.3.9-r1 | GPL-2.0-only | pax-utils |
| tini | 0.19.0-r3 | MIT | tini |
| zlib | 1.3.2-r1 | Zlib | zlib |

`tini` and `openssl` are added by the Dockerfile; the rest come from the base image.

### Findings

- **Copyleft OS components.** busybox, apk-tools, alpine-baselayout, scanelf and parts of musl-utils are GPL-2.0 binaries distributed unmodified inside the image. ReplCRM code does not link them; the GCC runtime libraries carry the runtime library exception. Distributing the image still carries the GPL's source-availability terms for those binaries. Corresponding source for each listed version is published by Alpine in the `aports` repository (branch `3.24-stable`) and its source mirrors. Whether a pointer to that source is sufficient, or a copy or written offer is needed, is a decision for the copyright holder, not something this audit concludes.
- **Node.js notices: resolved after 0.4.1.** The official Node image does not include Node's `LICENSE` file, which reproduces the notices of V8, ICU, libuv and Node's other bundled components. The 0.4.1 image lacks it. Node's `LICENSE` for v22.23.5, taken from the `v22.23.5` tag of the nodejs/node repository, is now retained as [`licenses/NODEJS-22.23.5-LICENSE.txt`](../licenses/NODEJS-22.23.5-LICENSE.txt) and ships in the image with the rest of `licenses/`. The image build fails if the runtime Node version differs from that file's version.
- **OS notices: resolved after 0.4.1.** Alpine does not install license texts with its packages, and its `-doc` packages do not carry them either. The image now ships [`licenses/OS-NOTICE.txt`](../licenses/OS-NOTICE.txt), the standard texts for each license in the table (SPDX License List v3.29.0, including the GCC Runtime Library Exception), and the copyright files of musl 1.2.6, tini 0.19.0 and zlib 1.3.2 from those projects. `licenses/OS-PACKAGES.txt` is generated from the image's package database at build time, so it always matches the installed versions. The build fails if musl, tini or zlib drift from the versions of the retained copyright files. The source locations from the finding above are in the notice. npm and yarn ship their own `LICENSE` files.
- **Still open:** the GPL source approach above. `tini` and `openssl` are installed from the Alpine 3.24 repository at build time, so a rebuild can pick up a newer Alpine patch release of either; the generated package list records what was actually installed.

## Remaining artifact/publication actions

The container image is published (see above) with the findings listed there still open. Root NOTICE records `Copyright 2026 HONA LLC` following explicit project-owner confirmation. This attribution covers ReplCRM-owned source and does not assert ownership of dependencies or other third-party material.
