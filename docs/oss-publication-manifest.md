# OSS publication manifest

## 0.2.0 update (2026-11-23)

Source: private checkpoint `67c4036`, published as one snapshot commit on this repository's own history (no private history). HONA LLC, as copyright holder and project steward, authorized this release on 2026-11-23. The 0.1.0 decisions below still apply; this table records what 0.2.0 adds. Exact inputs and hashes are in [source selection](source-selection.json); results are in [verification evidence](verification-evidence.json).

| Component | Classification | Decision/evidence |
| --- | --- | --- |
| src/console (replicas page, setup page, handler, runs, status) | APPROVED_FOR_PUBLICATION | Project-owned loopback console; no external resources at runtime |
| src/setup (engine, schema, store, CLI wizard) | APPROVED_FOR_PUBLICATION | Project-owned guided setup; only `prisma migrate deploy`, never resets data |
| src/cli*.ts, src/locks, src/sources/salesforce/auth | APPROVED_FOR_PUBLICATION | OAuth sign-in, object selection, reconcile, verify, counts and run locks |
| src/console/assets (JetBrains Mono, OFL text) | APPROVED_FOR_PUBLICATION | OFL-1.1 font embedded with its full license; see THIRD_PARTY_NOTICES |
| PRODUCT.md, DESIGN.md, .impeccable/config.json, design.json, surfaces/ | APPROVED_FOR_PUBLICATION | Product and design records; local paths and personal references removed |
| Tests other than the application destination's | APPROVED_FOR_PUBLICATION | 234 offline tests pass; synthetic data only |
| src/destinations, src/compat, tests/application-crm-* | EXCLUDE_FROM_PUBLICATION | Same decision as 0.1.0: optional private integration |
| Private build governance (build.yaml, prompts/, phase handoffs, discovery logs, operator notes) | EXCLUDE_FROM_PUBLICATION | Internal delivery records, not needed to build or operate ReplCRM |
| Design sketches, review captures, decision-round files | EXCLUDE_FROM_PUBLICATION | Working material |

Direct dependencies are unchanged from 0.1.0. Compatible security updates changed transitive versions; the license inventory and `licenses/` bundle were regenerated from the installed tree (148 packages, every one with a retained license file, all permissive).

## 0.1.0

## Authority and source

Source archive: `jej2k5/replcrm`, checkpoint `67be373d5afb16091f617898ee466acdf1dd3d78`. HONA LLC, confirmed by the project owner as copyright holder and project steward, has explicitly authorized Apache-2.0 distribution of ReplCRM-owned implementation, tests, schema and documentation, including code historically named Moat CRM Pipeline. This resolves the former project-owned provenance review. It does not override third-party terms or authorize credentials, customer material or independently sourced private content.

[Source selection](source-selection.json) records the exact selected checkpoint files and explicitly reviewed working-tree OSS drafts, with input hashes. Public-facing drafts were adapted only in this isolated candidate. Neither newer private integration renames nor arbitrary uncommitted changes were copied. Historical naming alone was not used to reject owned source.

## Publication decisions

| Component | Classification | Decision/evidence |
| --- | --- | --- |
| src/core | APPROVED_FOR_PUBLICATION | Authorized canonical orchestration and ReplicaStore v1 contract; checkpoint bytes preserved |
| src/sources/salesforce | APPROVED_FOR_PUBLICATION | Authorized source implementation; native semantics remain in adapter |
| src/stores/postgres | APPROVED_FOR_PUBLICATION | Authorized Prisma/PostgreSQL implementation, unchanged |
| src/stores/memory | APPROVED_FOR_PUBLICATION | Authorized database-free reference store, unchanged |
| src/cli.ts, src/config.ts | APPROVED_FOR_PUBLICATION | Public Salesforce/PostgreSQL composition, unchanged |
| prisma/schema.prisma and migrations | APPROVED_FOR_PUBLICATION | Authorized project schema/migrations, unchanged; no new migration |
| Tests and helpers other than private destination test | APPROVED_FOR_PUBLICATION | Unchanged baseline contract/neutrality/failure tests, synthetic records |
| scripts/smoke-test.ts | APPROVED_FOR_PUBLICATION | New public-only smoke suite; no private integration/service dependency |
| Package/build/container configuration | APPROVED_FOR_PUBLICATION | Private scripts/dependencies removed; retained locked versions unchanged; Node 22 baseline |
| OSS legal/community/architecture/operator docs | APPROVED_FOR_PUBLICATION | Explicitly reviewed/adapted project-owned OSS drafts and contract documentation |
| Third-party license texts in licenses/ | APPROVED_FOR_PUBLICATION | Independently reviewed grants/attribution; original text retained, not relicensed |
| Contributor Covenant | APPROVED_FOR_PUBLICATION | Recognized standard with upstream CC-BY-4.0 attribution retained |
| Optional Moat destination, worker, exports and compatibility shims | EXCLUDE_FROM_PUBLICATION | Private/unnecessary integration scope; not required by core; ownership authorization is not disputed |
| tests/moat-destination.test.ts and original 17 integration smoke checks | EXCLUDE_FROM_PUBLICATION | Exercise excluded application integration; not represented as executed public checks |
| Newer uncommitted application-crm rename/integration edits | EXCLUDE_FROM_PUBLICATION | Unrelated working-tree work, outside checkpoint and reviewed OSS drafts |
| python/ and Python feasibility documents | EXCLUDE_FROM_PUBLICATION | Research only; no runtime/build dependency; observer edit untouched |
| Historical audits, internal setup skills, private examples and research evidence | EXCLUDE_FROM_PUBLICATION | Not needed for public operation; keep private archive/context out of source distribution |
| Existing .git, local .env, credentials, node_modules, dist, caches | EXCLUDE_FROM_PUBLICATION | No private history or local/generated artifacts tracked |
| Vendor logos, generated banners, screenshots and copied private assets | EXCLUDE_FROM_PUBLICATION | Not required; none bundled in candidate |
| Future binary/container distribution | REQUIRES_LICENSE_REVIEW | Review exact OS/runtime/native-engine inventory before publishing that separate artifact |

No included source component retains an unresolved third-party proprietary/IP finding. Excluded material is not being assigned a new license. The only bundled external material is identified legal/community text; installed dependencies remain independently licensed and are not committed. See the [dependency audit](dependency-license-audit.md).

## Executability and distribution differences

The core build and fake-source → core → memory path work without excluded integrations, private research, credentials or access to the archive. The retained production source and baseline tests are byte-identical to the authorized checkpoint. Public tests total 46 rather than the private baseline's 47 because one private destination test is omitted. Five new public smoke checks replace the need for an application-specific smoke entry point; the original 17 checks are excluded and were not run here.

Private import/export/worker npm commands and ioredis/jose/pg/@types/pg dependencies are absent. Core CLI compatibility aliases remain. No universal database abstraction, new store, source behavior change or ReplicaStore v1 change was introduced. Existing schema/migrations are included for independent setup, not executed against an operator database.
