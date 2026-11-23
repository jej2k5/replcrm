---
name: ReplCRM Console
description: The HONA watch floor, carrying ReplCRM's pipeline. Warm graphite and stone paper at parity, mono-first, status-honest, ReplCRM blue as the single accent.
colors:
  accent-dark: "oklch(0.72 0.12 245)"
  accent-hi-dark: "oklch(0.80 0.11 240)"
  accent-ink-dark: "oklch(0.14 0.006 250)"
  accent-wash-dark: "oklch(0.72 0.12 245 / .14)"
  accent-light: "oklch(0.47 0.13 250)"
  accent-hi-light: "oklch(0.40 0.13 250)"
  accent-ink-light: "oklch(0.98 0.005 250)"
  accent-wash-light: "oklch(0.47 0.13 250 / .10)"
  mark-dark: "#36cbfd"
  mark-light: "#1e88e5"
  hona-blue: "#00A0CA"
  hona-grey: "#8e9597"
  graphite-950: "oklch(0.13 0.006 70)"
  graphite-900: "oklch(0.17 0.006 70)"
  graphite-800: "oklch(0.22 0.007 70)"
  graphite-700: "oklch(0.27 0.008 70)"
  graphite-600: "oklch(0.34 0.009 70)"
  filament-100: "oklch(0.94 0.006 80)"
  filament-200: "oklch(0.86 0.007 80)"
  filament-300: "oklch(0.78 0.008 80)"
  filament-400: "oklch(0.70 0.009 75)"
  filament-500: "oklch(0.58 0.009 75)"
  paper-950: "oklch(0.985 0.004 75)"
  paper-900: "oklch(0.96 0.005 75)"
  paper-800: "oklch(0.93 0.006 75)"
  paper-700: "oklch(0.88 0.007 75)"
  paper-600: "oklch(0.82 0.009 75)"
  ink-100: "oklch(0.22 0.008 75)"
  ink-200: "oklch(0.30 0.008 75)"
  ink-300: "oklch(0.40 0.009 75)"
  ink-400: "oklch(0.48 0.009 75)"
  ink-500: "oklch(0.55 0.009 75)"
  ok-dark: "oklch(0.72 0.13 145)"
  warn-dark: "oklch(0.80 0.15 80)"
  err-dark: "oklch(0.70 0.16 28)"
  denied-dark: "oklch(0.68 0.15 310)"
  ok-light: "oklch(0.48 0.14 145)"
  warn-light: "oklch(0.52 0.15 70)"
  err-light: "oklch(0.50 0.18 28)"
  denied-light: "oklch(0.48 0.16 310)"
typography:
  display:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "21px"
    fontWeight: 500
    letterSpacing: "-.01em"
  headline:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "15px"
    fontWeight: 600
  title:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 600
  body:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tnum"
  prose:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: ".6875rem"
    fontWeight: 500
    letterSpacing: ".06em"
  caption:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
rounded:
  control: "3px"
  panel: "4px"
  round: "50%"
spacing:
  sidebar: "232px"
  page-x: "clamp(16px, 3vw, 40px)"
  section-gap: "30px"
components:
  button-primary-dark:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.accent-ink-dark}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-primary-hover-dark:
    backgroundColor: "{colors.accent-hi-dark}"
  button-primary-light:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.accent-ink-light}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-primary-hover-light:
    backgroundColor: "{colors.accent-hi-light}"
  button-secondary:
    textColor: "{colors.filament-100}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-change:
    rounded: "{rounded.control}"
    padding: "6px 10px"
  input-dark:
    backgroundColor: "{colors.graphite-950}"
    textColor: "{colors.filament-100}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  nav-item-active-dark:
    backgroundColor: "{colors.accent-wash-dark}"
    textColor: "{colors.accent-hi-dark}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  stage-cell-dark:
    backgroundColor: "{colors.graphite-900}"
    textColor: "{colors.filament-100}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  stage-cell-active-dark:
    backgroundColor: "{colors.accent-wash-dark}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  stage-node-compact:
    rounded: "{rounded.control}"
    size: "36px"
  step-number-current-dark:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.accent-ink-dark}"
    rounded: "{rounded.round}"
    size: "24px"
  panel-dark:
    backgroundColor: "{colors.graphite-950}"
    rounded: "{rounded.panel}"
---

# Design System: ReplCRM Console

## Overview

**Creative North Star: "The Watch Floor, Pipeline Schematic"**

ReplCRM is a member of the HONA product family and shares MCPxy's design system. The family source is `MCPxy's DESIGN.md (the MCPxy repository)` ("The Watch Floor"). This file does not restate that system; it records which family rules ReplCRM inherits unchanged, and, with values from the shipped code (`src/console/page.ts`), what is ReplCRM's own. Where this file and the family file disagree, this file describes what ReplCRM actually ships.

The family register holds: a calm, expert operator console in the lineage of real control rooms, not the SaaS aesthetic that imitates them. ReplCRM's own idea sits on top of it. Each replica is drawn as the README banner's pipeline (CRM, Discover, Reconstruct, Replicate, Postgres), and the pipeline is alive: during a sync, records visibly travel along it and the stage doing the work lights up. Everything else on the page reads in plain words, so a first-time operator can tell at once which replicas are in step and which need them.

**Inherited from the family, unchanged:**
- Warm graphite (dark, default) and stone paper (light) at parity, each designed end to end. Every neutral tints warm (hue 70 to 80); no cool gray, navy or charcoal-blue surface.
- Mono-first type with JetBrains Mono for every operational word and number; a sans only for explanatory prose.
- Flat surfaces separated by 1px hairlines; depth from tonal layering, never cast shadows.
- The status quartet (moss OK, amber warn, rust err, violet denied), always paired with a glyph or position.
- The Label spec: .6875rem, weight 500, .06em tracking, uppercase.
- Sidebar navigation with small uppercase section labels.
- A health strip of labelled readouts instead of metric tiles.
- No gradient fills, surfaces or text; no glass or backdrop-filter; no navy surfaces.
- "by HONA LLC" with the HONA mark in the sidebar footer.

**ReplCRM's own:** ReplCRM blue replaces Signal Steel as the single accent; the logo mark and the banner's stage icons; the pipeline signature component and its motion; the plain-language state vocabulary; the guided setup components.

**Key Characteristics:**
- Family surfaces, type and status discipline; ReplCRM identity only in mark, icons, accent and pipeline.
- One accent, ReplCRM blue, reserved for what moves, what is active, and what the operator should press.
- The pipeline is the page's signature: five stage cells, live connectors, one row per replica.
- Plain words for every state; the term of art can follow, never lead.
- Motion means data is moving. Idle connectors breathe in place; only a running sync makes dots travel.

## Colors

The family's warm two-theme palette with ReplCRM blue as the one chromatic accent, the family status quartet, and two fixed identity blues that belong to marks, not to the interface.

### Primary
- **ReplCRM Blue** (`accent-dark` / `accent-light`): the single accent, a saturated mid blue drawn from the README banner. Carries the flowing pipeline connectors, the active stage border and wash, focus rings, the primary action, the selection wash, the active nav item, the current step number, the "syncing" glyph and text links. It must not appear on resting stage icons (those stay in the neutral text family) or on object names (those stay in primary text).
- **ReplCRM Blue, high** (`accent-hi-dark` / `accent-hi-light`): primary-button hover, the active nav label, text links, and copyable code values on the setup page. Lighter than the accent in dark, darker in light.
- **Accent Ink** (`accent-ink-dark` / `accent-ink-light`): text set on a solid accent fill (primary button, current step number).
- **Accent Wash** (`accent-wash-dark` at 14% / `accent-wash-light` at 10%): the selected replica row, the active stage cell, the active nav item, and text selection.

### Identity marks (not interface color)
- **Logo Blue** (`mark-dark` `#36cbfd` in dark, `mark-light` `#1e88e5` in light): the ReplCRM logo in the sidebar only. These are the banner's logo highlight and banner blue; they never colour controls, states or text.
- **HONA Blue and HONA Grey** (`hona-blue`, `hona-grey`): the two halves of the HONA mark in the sidebar footer, fixed in both themes.

### Neutral (warm graphite, dark)
- **Watch Floor Black** (`graphite-950`): sidebar, health strip band, panels (pipelines, facts, table, problems, steps), inputs and code wells.
- **Graphite** (`graphite-900`): page background, resting stage cells, the current step row, pipeline row hover.
- **Console Steel** (`graphite-800`): hover fill for nav items and buttons; inner row dividers.
- **Hairline** (`graphite-700`): every 1px structural border and panel outline.
- **Control Edge** (`graphite-600`): button and input borders, idle connector line, step number ring.
- **Filament 100 to 500** (`filament-100` … `filament-500`): primary text, secondary text, tertiary text (resting stage icons use 300), muted states and icons (400), labels and captions (500).

### Neutral (stone paper, light)
- **Paper 950 to 600** (`paper-950` … `paper-600`): the same five roles as the graphite ramp, in the same order.
- **Ledger Ink 100 to 500** (`ink-100` … `ink-500`): the same five text roles. Never `#000`.

### Status quartet
- **OK Moss** (`ok-dark` / `ok-light`): MATCH, finished steps, done setup stages, the Replicate icon when every object matches, the finished panel.
- **Warn Amber** (`warn-dark` / `warn-light`): "Off by N", "Not signed in to Salesforce", interrupted syncs, feedback messages, warn stage borders.
- **Err Rust** (`err-dark` / `err-light`): unreachable Salesforce, failed runs, problem headings, setup errors.
- **Denied Violet** (`denied-dark` / `denied-light`): defined for family parity; the console has no denied state today and does not use it.

### Named Rules
**The One Blue Rule.** ReplCRM blue is the only accent. It belongs to the connectors (breathing dots at rest, solid and streaming in a sync), the active stage, focus, the primary action, selection, the current nav item and current step, live states ("Syncing now", "Setting up") and links. A resting stage icon, an object name or a body label in blue is wrong. Its chroma (0.12 dark, 0.13 light) is deliberately higher than Signal Steel's and replaces the family's ≤0.10 cap for ReplCRM only; the warm surfaces still carry the temperature contrast.

**The Marks Are Not Accent Rule.** The logo blues and the HONA blue are identity artwork. They live in the sidebar brand and footer and nowhere else.

**The Status-Honest Rule (inherited).** Every status colour pairs with a glyph (check, warning triangle, cross, arc, dash) or a word. On the Replicas pipeline, green on Replicate is earned only by every object matching; on the setup pipeline, green marks a step that has been verified as done.

## Typography

**Mono Font:** JetBrains Mono (weights 400 to 700), self-hosted and served by the console itself, falling back to `ui-monospace, "SF Mono", Menlo, monospace`.
**Prose Font:** the system sans stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`), for explanatory sentences only.

**Character:** a technical manual in one voice. Mono carries titles, names, counts, states, labels and buttons; the sans appears only where a sentence explains (page intros, field hints, setup instructions, error and notice text). Numbers are tabular everywhere (`font-variant-numeric: tabular-nums` on the body).

### Hierarchy
- **Display** (mono 500, 21px, -.01em): the page title ("Replicas", "Add a replica"). One per page.
- **Headline** (mono 600, 15px): section titles (the selected replica's ID, "Problems", the finished panel).
- **Title** (mono 600, 14px): replica names in pipeline rows, step titles, the brand name. Stage names use 12px 600.
- **Body** (mono 400, 13.5px, 1.55): the operational default. Buttons and inputs use 13px; readout values in the health strip and facts use 14px 500.
- **Prose** (sans 400, 14px, max 72ch): page and section explanations. Field hints, instructions and errors use the sans at 12.5px to 13.5px.
- **Label** (mono 500, .6875rem, .06em, uppercase, faint text): sidebar section labels, health-strip and fact labels, table headers, form field labels.
- **Caption** (mono 400, 11.5px to 12px, faint text): stage sub-lines, replica IDs under names, timestamps, step numbers.

### Named Rules
**The Mono-First Rule (inherited).** Operational content is mono. A sentence that explains is sans. Default is mono.

**The Tabular Count Rule.** Store and Salesforce counts sit right-aligned in tabular figures so the two columns compare digit by digit.

## Layout

A fixed 232px sidebar and a fluid main column. Main padding is 26px top, `clamp(16px, 3vw, 40px)` at the sides and 56px at the foot; sections stack with a 30px gap. The health strip bleeds edge to edge across main (negative margin equal to the side padding) on the deepest surface, with its readouts separated by 1px rules and 36px of space either side.

Replicas page order: page head (title, one line of explanation, Refresh at right) → health strip (Health, Replicas, Records, Need attention) → one pipeline row per replica → the selected replica's head, facts strip, sync controls and object table → Problems. Setup page order: page head → the building pipeline → the finished panel (when complete) → the numbered step list.

Pipeline rows are a two-column grid: name and state at left (`minmax(180px, 1fr)`), the stage track at right (`5fr`), 18px apart. The stage track is a nine-column grid: five equal stage cells with 28px connector columns between them. Panels pad rows at 14px 16px; table cells at 9px 14px; the facts strip auto-fits columns of at least 170px.

### Responsive
- **Under 1100px:** pipeline rows stack, name above the stage track (10px gap).
- **Under 860px:** the sidebar becomes a top bar: brand, nav items in a wrapping row, footer (HONA line and theme toggle) pushed right. Section labels are hidden in the top bar.
- **Under 640px:** the pipeline stays one line. Each stage collapses to a 36px square icon node; only an active, warn or bad node shows its stage name, centred beneath it (sub-line hidden), and the track gains 18px of bottom space to hold it. The object table keeps Object, both counts and Check, hiding Last sync and the change counts; cells tighten to 9px 10px and object names may wrap. Health and facts lose their dividers; problem rows stack.

**The One Line Pipeline Rule.** At every width the five stages read left to right on one line. The pipeline never wraps or turns vertical.

## Elevation & Depth

Flat by family commitment. Depth comes from tonal layering (the 950 panel surface on the 900 page, the 800 hover) and 1px hairlines in the 700 step. There are no box-shadows anywhere in the console. Focus is a 2px solid accent outline at 2px offset (1px on inputs, which also turn their border accent).

**The Flat-By-Default Rule (inherited).** No surface casts a shadow. A selected or active thing gets a wash and an accent border, not a lift.

## Shapes

Square-shouldered and quiet. Controls, stage cells, nav items, inputs, code wells and the sync log use a 3px corner (`rounded.control`); panels and containers (pipelines, facts, table, problems, steps, finished panel) use 4px (`rounded.panel`). The only round forms are step-number rings (24px) and the 7px status dot. Borders are 1px everywhere. The selected pipeline row carries a 1px accent rule at its left edge, never thicker. Todo setup stages use a dashed 1px border, the one non-solid line in the system.

### Icons
ReplCRM's icons are line drawings redrawn from the README banner, set in `currentColor` on a 24-unit grid with 2px strokes (round caps on open strokes):
- **Logo:** a database stack with a rising arrow (32-unit grid, 2.2px stroke), in Logo Blue at 26px in the sidebar brand.
- **CRM source:** a cloud.
- **Discover:** a document with a magnifier.
- **Reconstruct:** two gears.
- **Replicate:** a database with a gear.
- **Postgres (store):** a database.
Interface icons (refresh, alert, theme, plus, check, copy, external link, play) share the sprite and line style; play is the one filled shape. Gear teeth and small gear rings step down to 1.8px. Status glyphs are a separate 16-unit set at 1.8px, drawn at 13px. Icons render 18px by default, 15px in the nav, 14px in buttons.

## Components

### Buttons
- **Shape:** 3px corner, 1px border, mono 500 13px, padding 9px 13px, icon at 14px with an 8px gap.
- **Primary:** solid ReplCRM blue with Accent Ink; hover moves fill and border to the high step. One per region (Run records sync, Test and save, Create replica, Sign in to Salesforce, Run first sync). The finished panel's "Open the replica" link uses the same treatment.
- **Secondary:** transparent with a Control Edge border; hover fills Console Steel and lifts the border to faint text.
- **Change:** a compact secondary (6px 10px, 12px) under a finished setup step.
- **Icon button:** borderless, 6px padding, muted icon; hover fills Console Steel (theme toggle, copy).
- **Disabled:** 50% opacity, progress cursor. Transitions are background and border at 120ms on the family ease (`cubic-bezier(.25, 1, .5, 1)`).

### Inputs / Fields
- **Style:** Watch Floor Black fill, Control Edge border, 3px corner, mono 13px, 9px 11px padding, full width up to a 640px form.
- **Label:** uppercase field label above (.6875rem, .06em), sans hint below at 12.5px.
- **Focus:** accent border plus the 2px accent outline at 1px offset. Checkboxes take `accent-color` ReplCRM blue.
- **Error / notice:** sans 13px line in Err Rust or Warn Amber under the form; empty messages take no space.

### Navigation (sidebar)
- Watch Floor Black, 1px right hairline, sticky full height. Brand block: logo, "ReplCRM" in 14px 600 with "console" beneath in 11px faint.
- Sections "Operate" (Replicas, Problems with a count of replicas needing attention) and "Setup" (Add replica), each headed by a Label.
- Items: 15px muted icon, secondary text, 7px 10px, 3px corner; hover Console Steel; current page takes the accent wash, high-step label and accent icon.
- Footer: "by [HONA mark] HONA LLC" centred (HONA in 600 with .15em tracking), then the theme toggle at right.

### Health strip
One row of labelled readouts on the deepest surface between hairlines: Health (verdict word in caps with glyph: IN STEP in OK, NEEDS ATTENTION in warn, SYNCING in accent), Replicas, Records (ticks to its new value), Need attention. Never tiles.

### Pipeline (signature component)
One row per replica in a single 4px panel, rows divided by hairlines.
- **Name block:** replica name (14px 600), its ID or source URL beneath, then the verdict with its glyph in plain words ("All 7 objects match", "1 object off", "Not signed in to Salesforce", "Salesforce unreachable", "Syncing now"). The whole row links to that replica; the selected row takes the accent wash and a 1px accent left rule.
- **Stage cells:** Salesforce, Discover, Reconstruct, Replicate, Postgres. Each is icon plus name (12px 600) and a plain sub-line ("connected", "4 objects", "model ready", "all match" / "not compared" / "1 object off", "115 records"), on Graphite with a hairline border. Resting icons sit in tertiary text.
- **Active stage:** the stage a running sync is in takes the accent border, accent wash and an accent icon. Warn stages take an amber border, icon and sub-line; bad stages the same in rust.
- **Replicate settles:** when not syncing and every object matches, the Replicate icon turns OK Moss. When a sync finishes successfully, the Replicate cell plays a 1.4s settle: OK border and an 18% OK wash fading back to the hairline.
- **Connectors, idle:** a 1px Control Edge line overlaid with a row of accent dots that breathe in place (opacity .2 to .5 over 3s). No travel: travelling dots would claim data is moving when it is not. Rows that cannot sync (Salesforce unreachable, not signed in) show no dots.
- **Connectors, syncing:** every connector from Salesforce up to and into the stage being written turns solid accent and streams dots left to right at full opacity; Replicate's connectors run on into Postgres. The stream period is `--flow`, set per row from sync activity between 0.3s (busy) and 1.6s (quiet). Connectors past the active stage keep breathing, faster (1.6s).
- **Counters:** record counts in the health strip and facts tick to their new value over 900ms instead of jumping.
- **Paused replicas** render at 55% opacity.
- **Reduced motion:** under `prefers-reduced-motion: reduce` every animation and transition stops, counters jump straight to the value, and scroll is instant. The numbers and words carry the state.

**The Moving Means Moving Rule.** Dots travel only while a sync is writing records, and only along the path the records take. This is the one deliberate relaxation of the family's "motion is feedback, never theatre" rule, made at the owner's explicit request; it does not license motion anywhere else.

### Facts strip and sync controls
The selected replica's head (ID as headline, one sans line, "Change objects" link), then a bordered facts strip of labelled readouts (Records in your database, Agreement "7 of 7 objects match", Last sync relative with UTC beneath, Last sync changed "+N new · N updated · N deleted", Salesforce). Below it: Run records sync (primary), Run full sync (secondary), a status line with glyph ("Ready to sync", "Copying records…", "Last sync finished 12 min ago", "Last sync failed. See the log below."), and a disclosed Sync log in a 3px well that opens itself while a sync runs.

### Object table
Mono throughout in a 4px scrolling panel. Columns: Object (row header in primary text), In your database, In Salesforce (both right-aligned), Check, Last sync, New, Updated, Deleted. Headers use the Label spec; rows divide on Console Steel hairlines with a faint zebra. Check reads in words: MATCH in OK Moss 600, "Off by N" in Warn Amber 600, muted when no comparison is possible.

### Problems
- **Needs you:** one row per replica that needs the operator, warning glyph, name in 600 and the cause in a plain sentence, with the recovery as a text link at right ("Sign in", "Sign in again", "Open and sync").
- **History:** timestamped rows (UTC) for interrupted syncs (amber: "It stopped without finishing; run a sync again.") and errors grouped by object and message with a repeat count ("Account, 3 times:"), translated into plain words with the next step. An error followed by a later successful sync of the same object stays as history in muted text with "Resolved by a later successful sync."

### Setup: building pipeline
The same pipeline, one row, in its own panel. The name block shows the new replica's name, ID and a dot with "Setting up", "First sync running" (accent) or "Ready" (OK). Stages light as their setup steps complete: done stages show an OK icon on a solid border; stages still to come are dashed, transparent and in faint text, with sub-lines saying what unlocks them ("not chosen yet", "after first sync"). Connectors between two lit stages turn accent.

### Setup: step list
A numbered list in one panel. The numbers are a real sequence (seven steps, done in order). Each step: a 24px ring with its number, title (14px 600) and a one-line detail. Done steps swap the number for a check in OK Moss; the current step's ring fills accent with Accent Ink, its row takes the Graphite fill and it alone is expanded with its form; todo steps dim their title to faint text. Finished steps that can be redone (app, sign-in, objects) carry a Change button ("Change app", "Sign in again", "Change objects") that reopens that step in place with a Cancel. The step needing the operator scrolls into view and takes focus when it changes. Setup content inside forms: numbered sans instructions with bold UI names, a copyable code value with a copy button, a filterable checkbox grid of objects (210px columns, scrolling at 320px), and an explicit backup confirmation before updating a populated database.

### Setup: finished panel
When setup is complete: a panel with a 1px OK border on an 8% OK wash over the deepest surface, a headline with a check in OK ("Your replica is live"), one sans sentence, and the primary "Open the replica" action.

## Do's and Don'ts

### Do:
- **Do** take surfaces, type, status colours, hairlines and the Label spec from the family system unchanged, and name `MCPxy's DESIGN.md (the MCPxy repository)` as the source.
- **Do** keep ReplCRM blue to the connectors, the active stage, focus, the primary action, the selection wash, the active nav item, the current step, live states and links. The One Blue Rule.
- **Do** say every state in plain words: MATCH, "Off by N", "Not signed in to Salesforce", "not compared", "1 object off". Lead with the plain phrase; the term of art can follow.
- **Do** group repeated errors, translate them, and end each with the step that fixes it. Keep resolved errors visible as history, muted.
- **Do** draw new stage or source icons as 2px line drawings on the 24-unit grid in `currentColor`, matching the banner set.
- **Do** stop every animation under `prefers-reduced-motion` and let the numbers carry the state.
- **Do** serve every asset from the console itself. Console pages ship under a CSP of `default-src 'none'` with per-response nonces on its style block and its script blocks (the theme boot and the page script), `font-src 'self'` and `connect-src 'self'`: the font is self-hosted at `/assets/console-font.woff2`, icons come from the inline sprite, and dynamic values (such as `--flow`) are set through the CSSOM, never through `style=""` attributes or inline handlers.

### Don't:
- **Don't** make connector dots travel when no sync is running. Idle connectors breathe in place. The Moving Means Moving Rule.
- **Don't** colour resting stage icons or object names with the accent.
- **Don't** use the logo blues or the HONA blue as interface colour. The Marks Are Not Accent Rule.
- **Don't** use metric tiles, KPI cards or cards-in-cards; use the health strip and hairline panels.
- **Don't** use gradient fills, surfaces or text, glass, backdrop-filter, shadows or navy surfaces. The connector dot pattern is the only gradient construct and it draws dots, not a fill.
- **Don't** load anything from another origin on a console page: no web fonts, CDNs, images or scripts from outside.
- **Don't** present Snowflake, SQL Server, Oracle or any unimplemented source or store as available in a pipeline or setup step.
- **Don't** wrap the pipeline or turn it vertical on small screens. The One Line Pipeline Rule.

## Recorded drift (not canonical)

The build differs from its direction contract or the family system in these places. They are recorded so they are not mistaken for rules; none of them is a pattern to copy.

- `--flow` follows sync log lines per second (fallback .8s), not records processed as the contract says.
- Error grouping and translation happen only in the browser and only checkpoint errors are translated; the server-rendered first paint lists raw, ungrouped messages.
- Motion exceeds the family's transform/opacity-only and 80 to 150ms rule beyond the pipeline relaxation: stage cells transition border and background over 300ms, connectors animate `background-position`.
- Status quartet lightness and chroma differ slightly from the family file's numbers (hues match); Denied Violet is defined but unused.
- Form field labels set at weight 400, not the Label spec's 500.
- Type sizes (display 21px, headline 15px, body 13.5px, prose 14px) run smaller than the family file's hierarchy (display clamp to 2.25rem, headline 1.375rem, body .875rem, prose .9375rem).
- The family file is itself a seed: it lists JetBrains Mono only as a candidate and does not specify uppercase sidebar section labels, a health strip or the HONA footer. Those inherited items come from PRODUCT.md's Brand Commitments and MCPxy's shipped UI; the decision to share the family system stands.
- An em dash ("—") is the placeholder for a missing count, against the family's no-em-dash copy rule.
- The setup page links out to Salesforce sign-in and pre-fills `https://login.salesforce.com`; these are navigations, not resource loads, so the no-external-load rule holds but "no external URLs" does not.
