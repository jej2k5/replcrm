---
version: 1
slug: "src-console-page-ts"
primary_target: "src/console/page.ts"
related_targets: ["src/console/handler.ts"]
---

Scope: the ReplCRM console (`npm run console`), Operate mode. Home for every replica (deployment) on this machine: health across all of them, one replica's objects, then Add replica (onboarding). Audience: outside operators, often first-time.

Constraints: loopback only, per-process token for actions, CSP with nonce (no external fonts or scripts at runtime; self-host or system stacks). Only Salesforce sources and Postgres stores are real. Operator friendly; not a boring operator dashboard (maintainer, 2026-11-23).

## Direction contract

THESIS: Each replica is the README banner's pipeline, alive: records visibly travel CRM, Discover, Reconstruct, Replicate, Postgres. Refuses the grey table-of-status-pills dashboard and KPI tiles.

OWN-WORLD: The HONA family system shared with MCPxy: warm graphite (dark) and stone paper (light) at parity, JetBrains Mono for every operational word and number, sidebar with uppercase section labels, a health strip, flat panels with 1px hairlines, the status quartet with glyphs. ReplCRM's own marks on top: its logo, the banner's 2px line stage icons, and ReplCRM blue as the single accent, carried by the flowing pipeline connectors, focus and the primary action. No navy surfaces, gradients or glass.

STORY: The operator sees at once which replicas are in step and which need them, watches a sync carry records stage by stage, opens a replica to read store against Salesforce per object in plain words, and adds a new replica through guided setup.

FIRST VIEWPORT: Left sidebar: logo and name, Operate (Replicas, Problems), Setup (Add replica), by HONA LLC and the theme toggle at the foot. Main: title Replicas with one line of explanation and Refresh at right; the health strip (health verdict, replicas, records, needing attention); then one pipeline row per replica, five stage cells joined by live connectors with name and state at left. Below: the selected replica's facts strip, sync controls, and its object table with MATCH or Off by N in words.

FORM: Pipeline Schematic, rank 1 of my grounded list (IMPECCABLE'S PICK, chosen by the maintainer with the steer "more animation on movement of data in addition to metrics"). seed:d94853debde20ea1. Signature interaction: during a sync, data particles stream along each connector at a rate tied to records processed, the active stage glows, counters tick, and Replicate settles on MATCH; idle rows breathe a slow pulse; all motion stops under prefers-reduced-motion and the numbers carry the state.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
