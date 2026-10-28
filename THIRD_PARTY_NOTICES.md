# Third-party notices

ReplCRM-owned implementation is distributed under Apache-2.0 by rights-holder authorization. Dependencies and standard policy text retain their own copyrights and terms. This file is not a claim that those works are owned by ReplCRM or that they are all Apache-licensed.

## Retained legal material

The [dependency inventory](docs/dependency-license-inventory.json) maps each installed dependency to copies of its packaged license/copyright/notice text in `licenses/`, with SHA-256 and origin. Duplicate legal texts share a content-addressed copy. TypeScript's packaged ThirdPartyNoticeText is included in that mapping in full.

MIT permission/copyright sections embedded in agent-base, csprng, https-proxy-agent and sequin README files are retained. The esbuild root MIT text also covers the platform packages' matching upstream copyright/version. tr46 0.0.3 declares MIT in its published metadata but omits a separate license file; the retained upstream MIT text explicitly credits Sebastian Mayr. Its provenance is distinguished from a nonexistent version-local file.

[PostgreSQL/PGlite upstream attribution](licenses/PGLITE-POSTGRES-LICENSE.txt) is retained in addition to PGlite's packaged Apache license. Installed/generated dependency notices remain intact; generated clients and native binaries are not committed as project source.

## Standard policy text

CODE_OF_CONDUCT is Contributor Covenant 2.1 with the contact placeholder customized, upstream attribution retained, under its referenced CC-BY-4.0 terms. DCO 1.1 is linked unchanged, not rewritten or represented as a project-owned CLA.

## Distribution scope

The clean root commit is a source distribution: no node_modules, dist, native dependency binary, Docker/OS layer, private integration or Python research is vendored. npm installs separately licensed packages according to the lockfile. Retain their legal files if redistributing an installed tree. The Dockerfile copies this notice and the license bundle, but a binary image must additionally preserve base-image/system notices and undergo platform/security inventory review before publication. No binary image is shipped by this candidate.

Root NOTICE remains a minimal project notice; it is not an automatic list of dependencies. See the [license audit](docs/dependency-license-audit.md) for compatibility and attribution conclusions.

Legal texts retain their upstream bytes/line endings. `.gitattributes` exempts these snapshots from whitespace rewriting; the original initial migration likewise retains its historical final blank line. Project source remains subject to normal whitespace checks.
