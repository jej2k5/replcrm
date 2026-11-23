# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Outside operators who just cloned the open-source repository: a Salesforce admin, RevOps engineer or data engineer who wants an independent, queryable copy of their Salesforce data in their own PostgreSQL database. They are technical enough to run `npm` and own a database, but they are setting up ReplCRM for the first time and don't know its terms (deployment, metadata sync, reconcile). Confirmed by the maintainer, 2026-11-23.

After setup, the same operator returns to check that replication is healthy and to start a sync.

## Product Purpose
ReplCRM discovers CRM metadata, reconstructs a canonical model and incrementally replicates records and relationships into a replica store the operator owns. Success for an operator: every selected object shows MATCH between the store count and the Salesforce count, deletions included, and they can see when that stops being true.

The console is the operator's local home for every replica they run: first-time setup, adding more replicas, then status and sync across all of them.

## Positioning
Metadata-driven, not a fixed schema per customer: ReplCRM discovers objects and fields, custom objects included, and keeps up as they change. The replica is independent of any downstream application. Verification is built in: every object is counted on both sides and shown as MATCH or DIFF.

## Operating Context
- Runs on the operator's own machine. The console binds to 127.0.0.1 only and authorizes actions with a per-process token.
- Started with `npm run console`. The CLI (`npm start -- …`, `npm run replicate:*`) remains a first-class interface; console and CLI share one run lock per deployment.
- Setup today, all by hand: Node and npm install, a PostgreSQL database and `DATABASE_URL`, Prisma migrations, `deployment init`, a Salesforce External Client App (PKCE, no secret) and `auth login`, object selection (`objects set`), metadata sync, records sync, `counts`.
- Salesforce orgs may enforce refresh token rotation and a 30-day idle refresh token expiry; an expired sign-in means running sign-in again.

## Capabilities and Constraints
- Only Salesforce is implemented as a source. Only PostgreSQL is a production store. Snowflake, SQL Server and Oracle are planned, not implemented; never present them as available.
- The console manages multiple ReplCRM instances (deployments) from one place, each replicating one CRM org into a store, potentially across several CRMs. Confirmed by the maintainer, 2026-11-23. Only Salesforce can be connected today; the design leaves room for other CRM sources and stores without presenting any unimplemented one as available.
- Onboarding is required in two front ends sharing one setup core: a console (browser) wizard and a CLI wizard. The console wizard ships first. Confirmed by the maintainer, 2026-11-23.
- The console must be able to start before `DATABASE_URL` and `DEPLOYMENT_ID` are set, so onboarding can collect them.
- Never print or store secrets in places they could leak: tokens are never shown; database passwords are masked; `.env` files are never committed.
- Never reset or migrate a populated database without explicit operator confirmation.
- One writer per deployment; syncs are serialized by the run lock.
- No exactly-once guarantee. Replicates data and metadata, not org configuration (Apex, Flow, layouts).
- First public source release: 2026-11-23. Container images are not yet published.

## Brand Commitments
Name: ReplCRM. Tagline: "Discover. Reconstruct. Replicate."

ReplCRM is part of the HONA product family and shares MCPxy's design system (maintainer, 2026-11-23: "take a look at the style from MCPxy's UI", then chose the family look): warm-graphite and paper-light themes at parity, JetBrains Mono for operational content, sidebar navigation with small uppercase section labels, a health strip instead of metric tiles, flat surfaces with 1px hairline borders, the status quartet (moss green, amber, rust, violet), and "by HONA LLC" in the sidebar footer. The reference is MCPxy's DESIGN.md ("The Watch Floor"). ReplCRM differs only where its identity lives: its own logo mark, the README banner's stage icons, the animated pipeline, and ReplCRM blue as its single accent in place of MCPxy's Signal Steel.

The README banner remains the source for ReplCRM's identity (maintainer, 2026-11-23: use the repo's colors and icons): logo (a database stack with a rising arrow), stage icons (document with magnifier for Discover, gears for Reconstruct, database with gear for Replicate), the left-to-right pipeline, and the blue (banner `#1e88e5`, logo highlight `#36cbfd`). The banner's navy surfaces are not used in the console; the family's warm surfaces replace them.

The banner shows Snowflake and "Future Stores"; those are planned, not implemented, and the console must not present them as available.

The console must be operator friendly (maintainer, 2026-11-23).

## Evidence on Hand
- Live verification against a Salesforce Developer Edition org on 2026-11-22: OAuth sign-in, refresh with rotation, records sync and counts MATCH for Account, Contact, Lead, Opportunity, Task, Event and a custom object.
- No customers, testimonials, benchmarks or production deployments exist. Do not invent any.

## Product Principles
1. Prove it, don't claim it: every object shows both counts and MATCH or DIFF; never hide a mismatch.
2. Setup is part of the product: an operator who has never seen ReplCRM should reach a first MATCH without reading the runbook.
3. One core, two front ends: console and CLI do the same things through the same code, so neither drifts.
4. Safe by default: loopback only, secrets never shown, destructive steps need explicit confirmation.
5. Say exactly what's wrong and the next step: errors name the cause and the command or button that fixes it.

## Anti-references
- A SaaS analytics dashboard: KPI tiles, cards everywhere, gradients. This is a local operator tool. (maintainer, 2026-11-23)
- Dense or cryptic screens that assume ReplCRM vocabulary (checkpoint, metadata stage, projection). Plain words first; the term of art can follow. (maintainer, 2026-11-23)

## Accessibility & Inclusion
No product-specific requirement established. Meet WCAG 2.2 AA as the baseline for the console.
