# ReplCRM configuration

After applying the database migrations and building the CLI, run `npm start -- deployment init --id <id> --name <name>` with `DATABASE_URL` set. You can add `--source-url <url>` when creating the row. Init requires only the database URL and the ID and name flags, so it can run before the Salesforce variables are set. Replication requires an existing deployment and uses `DEPLOYMENT_ID` to select it.

After setting `DATABASE_URL`, `DEPLOYMENT_ID` and the Salesforce login variables, run `npm start -- deployment verify [--rebind] [--json]`. Verification prints the live identity and writes a version 1 binding with the organization ID, user ID, username, instance host and UTC verification time. The file is per machine at `<config dir>/bindings/<DEPLOYMENT_ID>.json` and is written with owner-only permissions. The config directory defaults to `~/.config/replcrm`. Rerunning with the same org and user refreshes the timestamp. Changing either ID requires `--rebind`. Use `--json` for machine-readable output.

Run `npm run replicate:reconcile -- --entities Account,Task` to preview purged deletions. Preview uses the selection precedence below and requires explicit names. If the saved selection is `*`, pass `--entities a,b` with the names to review. The deny list still applies. It writes an owner-only plan to `<config dir>/reconcile/<DEPLOYMENT_ID>.json`.

Use `npm run replicate:reconcile -- --apply` within 60 minutes to apply the reviewed plan. The plan and live session must match the deployment's verified organization and user. Apply takes its selection from the plan and rejects `--entities`. Both modes support `--json`. Apply supports explicit `--allow-empty` and `--allow-large` overrides for an empty live listing with active store records and proposed deletions exceeding half the active store records, respectively.

CLI scripts consume exported environment variables. They do not load `.env` automatically. After building, `node --env-file=.env dist/cli.js` loads a file explicitly. Prisma commands may load `.env` themselves. Never commit local credentials.

Run `npm run replicate` for the full pipeline. Use `npm run replicate:metadata`, `npm run replicate:users`, `npm run replicate:records`, and `npm run replicate:projections` to run individual stages. Entity selection and exclusions apply to metadata, records, projections, and full runs. Standalone records and projections require persisted metadata for every selected entity in the deployment and describe those entities again from the source. User replication uses the source and deployment settings and the configured batch size. After building, `npm start -- help` shows all commands. The legacy `migrate:metadata` and `migrate:records` scripts run their corresponding stages and print deprecation warnings to stderr.

After building, run `node dist/cli.js counts [--entities a,b] [--json] [--store-only]`. The command uses `DATABASE_URL` and `DEPLOYMENT_ID`. Counts follows the selection precedence below and applies `SYNC_ENTITY_DENY`. The wildcard `*` expands through Salesforce discovery, or through persisted entity metadata with `--store-only`. Store-only mode needs no `SF_*` variables and prints active store counts. Source-backed mode adds Salesforce counts and MATCH or DIFF for each entity. Salesforce counts include archived activities and filter deleted rows on objects with an `IsDeleted` field. A DIFF alone leaves the exit code at 0. The table or JSON array is written to stdout. JSON rows contain `entityKey` and `storeCount`, with `sourceCount` and `status` included for source-backed runs.

## Salesforce object selection

Pass `--entities a,b` to metadata, records, projections, full, counts, or reconcile preview to choose objects for one invocation. For example, run `npm run replicate:records -- --entities Account,Task`. The CLI uses the first configured selection in this order:

1. The `--entities` flag
2. The deployment's saved selection
3. `SYNC_ENTITIES`
4. The built-in default of `Account,Contact,Lead,Opportunity,Case`

After building, use these commands to browse and save Salesforce API names. Quote `'*'` in the shell to save a wildcard.

| Command | Behavior |
| --- | --- |
| `npm start -- objects available [--json]` | Lists wildcard-eligible objects by name, with label and custom status. Requires Salesforce credentials. |
| `npm start -- objects list [--entities a,b] [--json]` | Shows the selected names or wildcard and which setting supplied them. Requires only `DEPLOYMENT_ID`. |
| `npm start -- objects set Account,Contact,Task,Event,Invoice__c` | Replaces the deployment's saved selection. |
| `npm start -- objects add Lead` | Adds API names to the current selection and saves it. |
| `npm start -- objects remove Contact` | Removes API names from the current selection and saves it. |
| `npm start -- objects clear` | Deletes the saved selection, restoring the environment or default fallback. |

Edits require only `DEPLOYMENT_ID`. ReplCRM stores selections with owner-only permissions at `<config dir>/selections/<DEPLOYMENT_ID>.json`. Set `REPLCRM_CONFIG_DIR` to change the config directory from `~/.config/replcrm`. Use `objects set` to replace a wildcard with explicit names. Removing the last name leaves an empty saved selection, so clear it to restore the fallback.

A single `*` discovers objects Salesforce marks queryable and replicateable. Discovery excludes objects marked deprecated and hidden and names ending in `History`, `Share`, `Feed`, `ChangeEvent`, or `__Tag`. `SYNC_ENTITY_DENY` applies to wildcard and explicit selections during replication, counts, and reconcile preview. An explicitly selected object requires `SystemModstamp` for incremental replication. Metadata sync reports the object by name when the field is absent. References to unselected targets can remain unresolved until their target records are replicated.

| Domain | Variable | Requirement / behavior |
| --- | --- | --- |
| replica store (PostgreSQL) | DATABASE_URL | Independent PostgreSQL database; required by Prisma inside the selected store |
| core | DEPLOYMENT_ID | Existing local Deployment row required by verification, replication, counts, and export |
| core | REPLCRM_CONFIG_DIR | Per-user config directory override (default `~/.config/replcrm`) |
| core | SYNC_BATCH_SIZE | Page size, default 2000 |
| core | SYNC_ENTITIES | Fallback object selection when no flag or saved selection is present. A single `*` enables discovery. |
| core | SYNC_ENTITY_DENY | Always-applied exclusion list, default empty |
| core | BUILD_WIDE_VIEWS | Default true. Set false to skip wide projections during full replication. The explicit projections command builds wide views. |
| source | SF_LOGIN_URL | Default https://login.salesforce.com; use test host for sandbox |
| source | SF_AUTH_MODE | `auto` (default), `oauth`, or `password` |
| source | SF_CLIENT_ID | External Client App client ID, required in OAuth mode |
| source | SF_CLIENT_SECRET | Leave unset for the External Client App setup below |
| source | SF_OAUTH_CALLBACK_PORT | Loopback port for browser sign-in and callback URL, default 47123 |
| source | SF_USERNAME | Required for password mode |
| source | SF_PASSWORD | Required for password mode |
| source | SF_SECURITY_TOKEN | Required for password mode |
| console | REPLCRM_CONSOLE_PORT | Loopback console port, default 4780. Overridden by `console --port N`. |
| runtime | NODE_ENV | Conventional runtime setting, production in image |
| runtime | NODE_EXTRA_CA_CERTS | Optional Node trust-store extension for configured endpoints |

The default runtime is one complete replication run; scheduling is external.

## Salesforce sign-in

1. Run `npm run --silent auth -- callback-url`. Copy the exact URL it prints into your Salesforce **External Client App** as its OAuth callback URL. The default is `http://localhost:47123/oauth/callback`. Set `SF_OAUTH_CALLBACK_PORT` before running the command if you need a different port.
2. Enable OAuth scopes `api` and `refresh_token/offline_access`. Require PKCE and turn off both secret requirements (web server flow and refresh token flow). Leave `SF_CLIENT_SECRET` unset. Salesforce restricts creation of new Connected Apps. This setup does not use a Connected App.
3. Export the app's consumer key as `SF_CLIENT_ID` and set `DEPLOYMENT_ID` to the deployment you want to sign in. Run `npm run --silent auth -- login` and complete sign-in in the browser. For a sandbox or My Domain, set `SF_LOGIN_URL` or pass `--login-url <url>`.
4. Run `npm run --silent auth -- status` to see the resolved mode and saved sign-in, then `npm run --silent auth -- refresh` to verify that Salesforce accepts the refresh grant. Both support `--json` and omit token values.

Set `SF_AUTH_MODE=password` and export `SF_USERNAME`, `SF_PASSWORD`, and `SF_SECURITY_TOKEN` to use password login. The default `auto` uses the stored OAuth sign-in when present and password credentials otherwise. Use `SF_AUTH_MODE=oauth` to require a stored sign-in. If Salesforce revokes the refresh grant, run `auth login` again.

Use `npm run --silent auth -- logout` to clear the local sign-in. Add `--revoke` to also ask Salesforce to revoke the refresh token. The auth commands run without `DATABASE_URL`.

OAuth tokens live outside the repository at `<configDir>/credentials/<DEPLOYMENT_ID>.json` with file mode 0600 and directory mode 0700. Set `REPLCRM_CONFIG_DIR` to override the default `~/.config/replcrm`. Refreshes are serialized per deployment across processes sharing that directory, using a separate lock from the replication run lock.


## Console status JSON

The loopback console handler serves `GET /api/status`. The response includes
`deploymentId`, `generatedAt` and a `salesforce` object with state `ok`,
`unavailable` or `not-configured` and an optional reason.

- Each `objects` entry includes `entityKey`, the active `storeCount` and `lastRun`.
  The latest records run includes start and completion times, run status, processed,
  created, updated and deleted totals, and any error message. `lastRun` is null
  before an object has run. Successful comparisons include `sourceCount` and a
  `status` of `MATCH` or `DIFF`.
- `errors` contains up to ten recent failed runs, newest first, with `at`,
  `entityKey` and `message`. For a stage-level failure, `entityKey` is null.

Salesforce discovery and counts share a 15-second deadline. When Salesforce is
unconfigured or wildcard discovery fails or times out, the wildcard uses
persisted object keys and reports store counts alone. A fresh store with no
persisted objects returns `objects: []` in this case. Empty run history returns
`errors: []`. Status is cached for 60 seconds. Use `?refresh=1` to bypass the
cache.
