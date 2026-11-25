# Third-party notices

ReplCRM-owned implementation is distributed under Apache-2.0 by rights-holder authorization. Dependencies and standard policy text retain their own copyrights and terms. This file is not a claim that those works are owned by ReplCRM or that they are all Apache-licensed.

## Retained legal material

The [dependency inventory](docs/dependency-license-inventory.json) maps each installed dependency to copies of its packaged license/copyright/notice text in `licenses/`, with SHA-256 and origin. Duplicate legal texts share a content-addressed copy. TypeScript's packaged ThirdPartyNoticeText is included in that mapping in full.

MIT permission/copyright sections embedded in the csprng and sequin README files are retained. The esbuild root MIT text also covers the platform packages' matching upstream copyright/version.

The container image's Node.js runtime is covered by [Node's own license](licenses/NODEJS-22.23.5-LICENSE.txt) for the pinned version, which includes the notices of its bundled components (V8, ICU, libuv and others).

The image's Alpine Linux packages are described in [`licenses/OS-NOTICE.txt`](licenses/OS-NOTICE.txt), with their license texts and source locations; the image also carries a build-time list of the exact installed packages (`licenses/OS-PACKAGES.txt`).

[PostgreSQL/PGlite upstream attribution](licenses/PGLITE-POSTGRES-LICENSE.txt) is retained in addition to PGlite's packaged Apache license. Installed/generated dependency notices remain intact; generated clients and native binaries are not committed as project source.

## Embedded font

The console serves **JetBrains Mono** (latin subset, variable weight), embedded as base64 in `src/console/assets/font.ts` so the loopback console needs no external font host. Copyright 2020 The JetBrains Mono Project Authors. SIL Open Font License 1.1; the full license text is in [`src/console/assets/JetBrainsMono-OFL.txt`](src/console/assets/JetBrainsMono-OFL.txt).

## Standard policy text

CODE_OF_CONDUCT is Contributor Covenant 2.1 with the reporting channel customized, upstream attribution retained, under its referenced CC-BY-4.0 terms. DCO 1.1 is linked unchanged, not rewritten or represented as a project-owned CLA.

## Distribution scope

The clean root commit is a source distribution: no node_modules, dist, native dependency binary, Docker/OS layer, private integration or Python research is vendored. npm installs separately licensed packages according to the lockfile. Retain their legal files if redistributing an installed tree. The Dockerfile copies this notice and the license bundle into the image. The published image (`ghcr.io/jej2k5/replcrm`, from 0.4.1) also contains the Node.js runtime and Alpine Linux packages from the official `node:22-alpine` base image, including GPL-2.0 components such as busybox and apk-tools, under their own terms. Their inventory, source location and open notice items are in the [license audit](docs/dependency-license-audit.md#container-image-041).

Root NOTICE remains a minimal project notice; it is not an automatic list of dependencies. See the [license audit](docs/dependency-license-audit.md) for compatibility and attribution conclusions.

Legal texts retain their upstream bytes/line endings. `.gitattributes` exempts these snapshots from whitespace rewriting; the original initial migration likewise retains its historical final blank line. Project source remains subject to normal whitespace checks.
