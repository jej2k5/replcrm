import { createConsoleRuns, type ConsoleRuns } from "./console/runs.js";
import { authUsage, listenForAuth, openAuthBrowser, runAuth, scheduleAuthTimeout, type AuthDeps } from "./cli-auth.js";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { PrismaClient } from "@prisma/client";
import { buildStatus, findInterruptedRuns, type StatusStore } from "./console/status.js";
import { createConsoleHandler } from "./console/handler.js";
import { listenForConsole, type ConsoleListener } from "./console/listener.js";
import { loadReplicationConfig, loadSourceAuth, required, type SourceAuth } from "./config.js";
import type { ReplicationConfig } from "./core/config.js";
import type { ConnectionFactory, SourceClient } from "./sources/salesforce/client.js";
import type { PostgresReplicaStore } from "./stores/postgres/index.js";
import {
  describeEntities, runMetadataStage, runProjectionsStage, runRecordsStage, runReplication,
  runUsersStage, runWithSource, selectEntityKeys, type OrchestratorDeps,
} from "./core/orchestrator.js";
import type { ReplicaStore } from "./core/replica-store.js";
import { parseCountsArgs, reportCounts, type CountingSource, type CountingStore } from "./cli-counts.js";
import type { TokenStore } from "./sources/salesforce/auth/token-store.js";
import type { CrmSource } from "./core/source.js";

import { resolveConfigDir, runLockPath, safeDeploymentFileName } from "./cli-config-dir.js";
import { acquireLock, LockHeldError, type FileLock } from "./locks/file-lock.js";
import { createRefreshLock } from "./locks/refresh-lock.js";
import { verifyDeployment, type VerifyDeps } from "./cli-verify.js";
import { parseReconcileArgs, reconcile, type ReconcileDeps } from "./cli-reconcile.js";

import { loadSavedSelection, objectsUsage, parseEntityList, resolveSelection, runObjects, saveSelection, type ObjectsDeps } from "./cli-objects.js";
import { displayDatabaseUrl, planSetup, validateApp, validateDatabaseUrl, validateReplica, type SetupProbe, type SetupService } from "./setup/core.js";
import { loadSavedApp, loadSavedDatabaseUrl, saveApp, saveDatabaseUrl } from "./setup/store.js";


export interface CliDeps {
  acquireRunLock?(deploymentId: string, command: string): Promise<FileLock>;
  onSignal?(signal: "SIGINT" | "SIGTERM", handler: () => Promise<void>): () => void;
  exit?(code: number): void;
  auth?: AuthDeps;
  listenConsole?: ConsoleListener;
  consoleNow?: () => Date;
  waitForConsoleRun?: (ms: number, signal: AbortSignal) => Promise<void>;
  consolePort?: string | undefined;
  validateConsoleConfig?(): void;
  createConsoleHandler?(port: number, runs?: ConsoleRuns, runsFor?: (deploymentId: string) => ConsoleRuns | undefined, setup?: SetupService): ReturnType<typeof createConsoleHandler>;
  objects?: ObjectsDeps;
  setup?: SetupService;
  /** Terminal prompts for the setup wizard; tests inject scripted answers. */
  wizardIO?(): import("./setup/wizard.js").WizardIO & { close?(): void };
  /** Console configuration that tolerates a missing DEPLOYMENT_ID (setup mode). */
  loadConsoleConfig?(): Promise<ReplicationConfig>;
  reconcile?: ReconcileDeps;
  verify?: VerifyDeps & { validateConfig(): void | Promise<void> };
  loadConfig(): ReplicationConfig | Promise<ReplicationConfig>;
  createSource(config: ReplicationConfig): CrmSource | Promise<CrmSource>;
  createStore(config: ReplicationConfig): ReplicaStore | Promise<ReplicaStore>;
  ensureDeployment(id: string, name: string, sourceUrl?: string): void | Promise<void>;
  deploymentExists(id: string): boolean | Promise<boolean>;
  validateSourceCredentials?(deploymentId?: string): void | Promise<void>;
  counts?: {
    createSource(): CountingSource | Promise<CountingSource>;
    createStore(): CountingStore | Promise<CountingStore>;
  };
  close?(): Promise<void>;
  hasEntityMetadata(deploymentId: string, entityKeys: string[]): boolean | Promise<boolean>;
}

const deploymentCommand = "deployment init --id <id> --name <name> [--source-url <url>]";

const verifyCommand = "deployment verify [--rebind] [--json]";

const commands = {
  full: "Run the full replication pipeline (default) [--entities a,b]",
  metadata: "Replicate entity metadata [--entities a,b]",
  users: "Replicate users",
  records: "Replicate records and repair references [--entities a,b]",
  projections: "Build wide-view projections [--entities a,b]",
  auth: authUsage,
  objects: objectsUsage,
  console: "console [--port N]",
  setup: "setup [--deployment <id>]\n  setup status [--deployment <id>] [--json]",
  counts: "counts [--entities a,b] [--json] [--store-only]",
  reconcile: "reconcile [--entities a,b] [--json]\n  reconcile --apply [--allow-empty] [--allow-large] [--json]",
  deployment: `${deploymentCommand}\n  ${verifyCommand}`,
  help: "Show this help (also --help)",
  "--help": "Show this help",
} as const;

function isCommand(command: string): command is keyof typeof commands {
  return Object.hasOwn(commands, command);
}

const deploymentUsage = `Usage: replcrm ${deploymentCommand}\n       replcrm ${verifyCommand}`;

function usage(): string {
  return [
    `Usage: replcrm [${Object.keys(commands).join("|")}]`,
    ...Object.entries(commands).map(([command, description]) =>
      (command === "deployment" || description.startsWith(command + " ")) ? `  ${description}` : `  ${command.padEnd(13)}${description}`),
  ].join("\n");
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const command = argv[0] ?? "full";
  if (!isCommand(command)) {
    console.error(`Unsupported command: ${command}\n${usage()}`);
    return 1;
  }
  if (command === "help" || command === "--help") {
    console.log(usage());
    return 0;
  }
  if (command === "auth") {
    if (deps.auth) return runAuth(argv.slice(1), deps.auth);
    console.error("Auth commands are unavailable.");
    return 1;
  }
  let runLock: Promise<FileLock> | undefined;
  let planLock: Promise<FileLock> | undefined;
  let interrupted = false;
  let deploymentId: string | undefined;
  const removeHandlers: (() => void)[] = [];
  const signalHandler = async () => {
    if (interrupted) return;
    interrupted = true;
    try {
      try {
        await releaseLock(planLock);
      } finally {
        await releaseLock(runLock);
      }
    } catch (error) {
      console.error(error);
    } finally {
      for (const remove of removeHandlers.splice(0)) remove();
      deps.exit?.(130);
    }
  };
  async function lockRun(id: string, label: string): Promise<boolean> {
    safeDeploymentFileName(id);
    deploymentId = id;
    if (deps.acquireRunLock) {
      if (deps.onSignal && deps.exit) {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          removeHandlers.push(deps.onSignal(signal, signalHandler));
        }
      }
      runLock = deps.acquireRunLock(id, label);
      await runLock;
    }
    return !interrupted;
  }
  try {
    if (command === "deployment" && argv[1] === "verify") {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { rebind: { type: "boolean" }, json: { type: "boolean" } },
      });
      if (!deps.verify) throw new Error("Deployment verification dependencies are unavailable");
      const { deploymentId } = await deps.loadConfig();
      safeDeploymentFileName(deploymentId);
      await deps.verify.validateConfig();
      await requireDeployment(deps, deploymentId);
      await verifyDeployment(deploymentId, values, deps.verify);
      return 0;
    }
    if (command === "deployment") {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { id: { type: "string" }, name: { type: "string" }, "source-url": { type: "string" } },
      });
      if (argv[1] !== "init" || !values.id?.trim() || !values.name?.trim()) {
        console.error(deploymentUsage);
        return 1;
      }
      await deps.ensureDeployment(values.id, values.name, values["source-url"]);
      return 0;
    }

    if (command === "setup") {
      return await runSetupCommand(argv.slice(1), deps);
    }
    if (command === "console") {
      return await runConsole(argv.slice(1), deps, deps.loadConsoleConfig ? await deps.loadConsoleConfig() : await deps.loadConfig());
    }
    const countsOptions = command === "counts" ? parseCountsArgs(argv.slice(1)) : undefined;
    const baseConfig = await deps.loadConfig();
    if (command === "objects") {
      if (!deps.objects) throw new Error("Object selection dependencies are unavailable");
      await runObjects(argv.slice(1), baseConfig, deps.objects);
      return 0;
    }
    if (command === "reconcile") {
      if (!deps.reconcile) throw new Error("Reconcile dependencies are unavailable");
      const options = parseReconcileArgs(argv.slice(1));
      if (options.apply && !await lockRun(baseConfig.deploymentId, "reconcile --apply")) return 130;
      await reconcile(options, baseConfig, deps.reconcile,
        async (flag) => (await resolveSelection(baseConfig, deps.objects, flag)).entities,
        async (id) => {
          await deps.validateSourceCredentials?.();
          await requireDeployment(deps, id);
        }, (id, keys) => deps.hasEntityMetadata(id, keys),
        async (acquire) => {
          if (interrupted) throw new Error("Reconcile interrupted");
          planLock = acquire();
          const lock = await planLock;
          if (interrupted) throw new Error("Reconcile interrupted");
          return lock;
        });
      return interrupted ? 130 : 0;
    }
    let config = baseConfig;
    if (command !== "users") {
      let flag = countsOptions?.entityKeys;
      if (!countsOptions) {
        const { values } = parseArgs({
          args: argv.slice(1),
          options: {
            entities: { type: "string" },
            ...(command === "metadata" || command === "records" ? { "legacy-migrate": { type: "boolean" } } : {}),
          },
        });
        if (values["legacy-migrate"]) {
          console.warn(`npm run migrate:${command} is deprecated. Use npm run replicate:${command}.`);
        }
        if (values.entities !== undefined) flag = parseEntityList(values.entities);
      }
      const { entities } = await resolveSelection(baseConfig, deps.objects, flag);
      config = { ...baseConfig, entityKeys: entities };
    }
    // Fail before the deployment lookup opens a database connection.
    if (!countsOptions?.storeOnly) await deps.validateSourceCredentials?.();
    if (!countsOptions && !await lockRun(config.deploymentId, command)) return 130;
    await requireDeployment(deps, config.deploymentId);
    if (countsOptions) {
      if (!deps.counts) throw new Error("Counts dependencies are unavailable");
      const store = await deps.counts.createStore();
      const source = countsOptions.storeOnly ? undefined : await deps.counts.createSource();
      await reportCounts(config, countsOptions, store, source);
      return 0;
    }
    if (command !== "counts") await executeReplication(command, config, deps);
    return interrupted ? 130 : 0;
  } catch (error: unknown) {
    if (interrupted) return 130;
    if (error instanceof LockHeldError) {
      console.error(error.live ? `Another sync is running for ${deploymentId}: ${error.message}` : error.message);
    } else {
      console.error(error);
    }
    if (command === "deployment" && error instanceof TypeError && "code" in error
      && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_")) {
      console.error(deploymentUsage);
    }
    return 1;
  } finally {
    try {
      await deps.close?.();
    } finally {
      try {
        await releaseLock(runLock);
      } finally {
        for (const remove of removeHandlers.splice(0)) remove();
      }
    }
  }
}

// Stop issuing store operations if the console releases the lock at its shutdown deadline.
function guardStore(store: ReplicaStore, signal: AbortSignal): ReplicaStore {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        signal.throwIfAborted();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

async function executeReplication(
  command: "metadata" | "users" | "records" | "projections" | "full",
  config: ReplicationConfig, deps: CliDeps, signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const store = await deps.createStore(config);
  signal?.throwIfAborted();
  const sourceClient = await deps.createSource(config);
  signal?.throwIfAborted();
  const replication: OrchestratorDeps = {
    store: signal ? guardStore(store, signal) : store,
    config,
    sourceClient,
  };
  switch (command) {
    case "metadata":
      await runWithSource(replication, () => runMetadataStage(replication));
      break;
    case "users":
      await runWithSource(replication, () => runUsersStage(replication));
      break;
    case "records":
    case "projections":
      await runWithSource(replication, async () => {
        const keys = await selectEntityKeys(config, replication.sourceClient);
        signal?.throwIfAborted();
        if (!(await deps.hasEntityMetadata(config.deploymentId, keys))) {
          throw new Error("Entity metadata is missing for the selected entities. Run the metadata subcommand first (npm run replicate:metadata).");
        }
        signal?.throwIfAborted();
        const definitions = await describeEntities(replication.sourceClient, keys);
        const runStage = command === "records" ? runRecordsStage : runProjectionsStage;
        await runStage(replication, definitions);
      });
      break;
    case "full":
      await runReplication(replication);
      break;
  }
  console.log(`Replication complete for deployment ${config.deploymentId}.`);
}

async function runConsole(args: string[], deps: CliDeps, baseConfig: ReplicationConfig): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" } } });
  const input = values.port ?? deps.consolePort ?? "4780";
  const port = Number(input);
  if (!/^\d+$/.test(input) || port < 1 || port > 65535) {
    throw new Error("Console port (--port or REPLCRM_CONSOLE_PORT) must be an integer from 1 to 65535.");
  }
  deps.validateConsoleConfig?.();
  if (!deps.createConsoleHandler || !deps.listenConsole || !deps.onSignal) {
    throw new Error("Console dependencies are unavailable");
  }
  const host = "127.0.0.1";
  const allRuns = new Map<string, ConsoleRuns>();
  const runsFor = (deploymentId: string): ConsoleRuns => {
    let existing = allRuns.get(deploymentId);
    if (existing) return existing;
    safeDeploymentFileName(deploymentId);
    existing = createConsoleRuns({
      now: deps.consoleNow,
      wait: deps.waitForConsoleRun,
      acquire: async (stage) => {
        if (!deps.acquireRunLock) throw new Error("Console run lock is unavailable");
        return deps.acquireRunLock(deploymentId, `console ${stage}`);
      },
      run: async (stage, signal) => {
        console.log(`[replication] Starting ${stage}`);
        const scoped = { ...baseConfig, deploymentId };
        const { entities } = await resolveSelection(scoped, deps.objects);
        const config = { ...scoped, entityKeys: entities };
        signal.throwIfAborted();
        await deps.validateSourceCredentials?.(deploymentId);
        signal.throwIfAborted();
        await requireDeployment(deps, config.deploymentId);
        await executeReplication(stage, config, deps, signal);
      },
    });
    allRuns.set(deploymentId, existing);
    return existing;
  };
  // Without a default deployment (setup mode) there are no default runs; replicas get theirs on first use.
  const runs = baseConfig.deploymentId ? runsFor(baseConfig.deploymentId) : undefined;
  const handler = deps.createConsoleHandler(port, runs, runsFor, deps.setup);
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  let shutdown: Promise<void> | undefined;
  const removeSignal = deps.onSignal("SIGINT", async () => {
    shutdown ??= Promise.allSettled([...allRuns.values()].map((each) => each.shutdown())).then(() => undefined).finally(stop);
    await stopped;
  });
  try {
    const listener = await deps.listenConsole(host, port, handler);
    try {
      console.log(`ReplCRM console: http://${host}:${port}`);
      await stopped;
      await shutdown;
    } finally {
      await listener.close();
    }
  } finally {
    removeSignal();
  }
  return 0;
}

async function runSetupCommand(args: string[], deps: CliDeps): Promise<number> {
  const sub = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const rest = sub ? args.slice(1) : args;
  const { values } = parseArgs({ args: rest, options: { deployment: { type: "string" }, json: { type: "boolean" } } });
  if (sub !== undefined && sub !== "status") {
    console.error(`Usage: replcrm ${commands.setup}`);
    return 1;
  }
  if (!deps.setup) throw new Error("Setup is unavailable");
  if (sub === undefined) {
    const { runSetupWizard, terminalIO } = await import("./setup/wizard.js");
    const io = deps.wizardIO ? deps.wizardIO() : terminalIO();
    try {
      return await runSetupWizard(io, {
        setup: deps.setup,
        runFirstSync: async (deploymentId) => {
          const base = deps.loadConsoleConfig ? await deps.loadConsoleConfig() : await deps.loadConfig();
          const scoped = { ...base, deploymentId };
          const config = { ...scoped, entityKeys: (await resolveSelection(scoped, deps.objects)).entities };
          const lock = deps.acquireRunLock ? await deps.acquireRunLock(deploymentId, "setup full") : undefined;
          try {
            await requireDeployment(deps, deploymentId);
            await executeReplication("full", config, deps);
          } finally {
            await lock?.release();
          }
        },
      }, values.deployment);
    } finally {
      io.close?.();
    }
  }
  const plan = await deps.setup.plan(values.deployment);
  if (values.json) {
    console.log(JSON.stringify({ deploymentId: plan.deploymentId ?? null, complete: plan.complete, steps: plan.steps }));
    return 0;
  }
  const marks = { done: "[x]", current: "[>]", todo: "[ ]" } as const;
  for (const [index, step] of plan.steps.entries()) {
    console.log(`${marks[step.state]} ${index + 1}. ${step.title}${step.detail ? ` - ${step.detail}` : ""}`);
  }
  console.log(plan.complete ? "Setup is complete." : "Run `npm run console` to finish setup in your browser.");
  return 0;
}

async function releaseLock(pending: Promise<FileLock> | undefined): Promise<void> {
  const lock = await pending?.catch(() => undefined);
  await lock?.release();
}

async function requireDeployment(deps: CliDeps, deploymentId: string): Promise<void> {
  if (!(await deps.deploymentExists(deploymentId))) {
    throw new Error(`Deployment "${deploymentId}" is missing. Run deployment init first.`);
  }
}

export function createProductionDeps(
  env: NodeJS.ProcessEnv,
  overrides?: {
    prisma?: () => PrismaClient | Promise<PrismaClient>;
    fetch?: typeof globalThis.fetch;
    connectionFactory?: ConnectionFactory;
    homedir?: () => string;
    now?: () => Date;
    auth?: Partial<Omit<AuthDeps, "env" | "now" | "fetch" | "withRefreshLock">>;
    runLockIsProcessAlive?: (pid: number) => boolean;
    refreshWaitMs?: number;
    refreshMutex?: Map<string, Promise<void>>;
  },
): Omit<CliDeps, "createSource"> & { createSource(config?: ReplicationConfig): Promise<SourceClient> } {
  let prisma: PrismaClient | undefined;
  let store: Promise<PostgresReplicaStore> | undefined;
  const configDir = () => env.REPLCRM_CONFIG_DIR || resolveConfigDir(env, (overrides?.homedir ?? homedir)());
  const now = overrides?.now ?? (() => new Date());
  const withRefreshLock = (deploymentId: string) => createRefreshLock(configDir(), deploymentId, {
    now, mutex: overrides?.refreshMutex, waitMs: overrides?.refreshWaitMs,
  });
  async function createTokenStore(directory: string) {
    if (overrides?.auth?.tokenStore) return overrides.auth.tokenStore();
    const { FileTokenStore } = await import("./sources/salesforce/auth/token-store.js");
    return new FileTokenStore(directory);
  }

  // Password variables belong to DEPLOYMENT_ID alone; any other deployment must use its own stored sign-in.
  // A replica's saved app (from setup) supplies SF_CLIENT_ID and SF_LOGIN_URL; for DEPLOYMENT_ID,
  // values in the environment win.
  async function envFor(deploymentId?: string): Promise<NodeJS.ProcessEnv> {
    const id = deploymentId ?? env.DEPLOYMENT_ID;
    const saved = id ? await loadSavedApp(configDir(), id) : undefined;
    const isDefault = !deploymentId || deploymentId === env.DEPLOYMENT_ID;
    const base = isDefault ? env
      : { ...env, DEPLOYMENT_ID: deploymentId, SF_USERNAME: undefined, SF_PASSWORD: undefined, SF_SECURITY_TOKEN: undefined };
    if (!saved) return base;
    return isDefault
      ? { ...saved && { SF_CLIENT_ID: saved.clientId, SF_LOGIN_URL: saved.loginUrl }, ...base }
      : { ...base, SF_CLIENT_ID: saved.clientId, SF_LOGIN_URL: saved.loginUrl };
  }

  async function databaseUrl(): Promise<string | undefined> {
    return env.DATABASE_URL || await loadSavedDatabaseUrl(configDir());
  }

  async function validateSourceCredentials(deploymentId?: string): Promise<void> {
    await loadSourceAuth(await envFor(deploymentId), await createTokenStore(configDir()));
  }

  async function openStore(): Promise<PostgresReplicaStore> {
    const { PostgresReplicaStore } = await import("./stores/postgres/index.js");
    if (overrides?.prisma) {
      prisma = await overrides.prisma();
    } else {
      const { PrismaClient } = await import("@prisma/client");
      const url = await databaseUrl();
      prisma = new PrismaClient(url === undefined ? undefined : { datasourceUrl: url });
    }
    return new PostgresReplicaStore(prisma);
  }

  function getStore(): Promise<PostgresReplicaStore> {
    return store ??= openStore().catch((error: unknown) => {
      store = undefined;
      throw error;
    });
  }

  async function createSource(config?: ReplicationConfig): Promise<SourceClient> {
    const directory = configDir();
    const tokenStore = await createTokenStore(directory);
    const auth = await loadSourceAuth(await envFor(config?.deploymentId), tokenStore);
    return sourceFromAuth(auth, tokenStore);
  }

  async function sourceFromAuth(auth: SourceAuth, tokenStore: TokenStore): Promise<SourceClient> {
    const { SourceClient } = await import("./sources/salesforce/client.js");
    const connectionFactory = overrides?.connectionFactory;
    if (auth.mode === "password") return new SourceClient(auth, { connectionFactory });

    const { createStoredRefresh } = await import("./sources/salesforce/auth/refresh.js");
    const { deploymentId, tokens, clientId, clientSecret } = auth;
    return new SourceClient({ mode: "oauth", instanceUrl: tokens.instanceUrl, accessToken: tokens.accessToken }, {
      connectionFactory,
      refresh: createStoredRefresh(tokenStore, deploymentId, { clientId, clientSecret, fetch: overrides?.fetch }),
      withRefreshLock: withRefreshLock(deploymentId),
    });
  }

  const objects: ObjectsDeps = {
    configDir, createSource, fallbackSource: () => env.SYNC_ENTITIES === undefined ? "default" : "SYNC_ENTITIES",
  };


  // Console and CLI setup: every check reads reality; every action is the same code the CLI uses.
  let signIn: { done: Promise<number>; deploymentId: string } | undefined;
  let signInNotice: { deploymentId: string; message: string } | undefined;
  const consoleConfig = (deploymentId: string): ReplicationConfig => loadReplicationConfig({ ...env, DEPLOYMENT_ID: deploymentId });
  const safeReason = (error: unknown): string => {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[database]").split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? "unknown error";
  };
  async function resetStore(): Promise<void> {
    const client = prisma;
    prisma = undefined;
    store = undefined;
    await client?.$disconnect().catch(() => {});
  }

  function createSetup(): SetupService {
    const probe: SetupProbe = {
      database: async () => {
        const url = await databaseUrl();
        if (!url) return { configured: false };
        const display = displayDatabaseUrl(url);
        const source = env.DATABASE_URL ? "env" as const : "saved" as const;
        try {
          await getStore();
          await prisma!.$queryRaw`SELECT 1`;
          return { configured: true, reachable: true, display, source };
        } catch (error) {
          await resetStore();
          return { configured: true, reachable: false, display, source, reason: safeReason(error) };
        }
      },
      schema: async () => {
        await getStore();
        const { probeSchema } = await import("./setup/schema.js");
        return probeSchema(prisma!);
      },
      replicas: async () => (await (await getStore()).listDeployments()).map(({ id, name }) => ({ id, name })),
      app: async (deploymentId) => {
        const saved = await loadSavedApp(configDir(), deploymentId);
        const isDefault = deploymentId === env.DEPLOYMENT_ID;
        const port = env.SF_OAUTH_CALLBACK_PORT ?? "47123";
        return {
          clientId: saved?.clientId ?? (isDefault ? env.SF_CLIENT_ID || undefined : undefined),
          loginUrl: saved?.loginUrl ?? ((isDefault && env.SF_LOGIN_URL) || "https://login.salesforce.com"),
          callbackUrl: `http://localhost:${port}/oauth/callback`,
          passwordSignIn: isDefault && Boolean(env.SF_USERNAME && env.SF_PASSWORD && env.SF_SECURITY_TOKEN),
        };
      },
      signedIn: async (deploymentId) => {
        if (deploymentId === env.DEPLOYMENT_ID && env.SF_USERNAME && env.SF_PASSWORD && env.SF_SECURITY_TOKEN) return true;
        return Boolean(await (await createTokenStore(configDir())).load(deploymentId));
      },
      selection: (deploymentId) => loadSavedSelection(objects, deploymentId),
      sync: async (deploymentId) => {
        const config = consoleConfig(deploymentId);
        const selection = await resolveSelection(config, objects);
        const status = await buildStatus(config, selection, await getStore(), async () => {
          const tokenStore = await createTokenStore(configDir());
          const auth = await loadSourceAuth(await envFor(deploymentId), tokenStore, true);
          return auth && sourceFromAuth(auth, tokenStore);
        }, { now });
        const runs = status.objects.filter((object) => object.lastRun);
        return {
          ran: runs.length > 0,
          succeeded: runs.length > 0 && runs.every((object) => object.lastRun?.status !== "Failed"),
          objects: status.objects.length,
          matches: status.salesforce.state === "ok" ? status.objects.filter((object) => object.status === "MATCH").length : null,
        };
      },
    };

    return {
      plan: async (deploymentId) => {
        const plan = await planSetup(probe, deploymentId);
        const notice = signInNotice && signInNotice.deploymentId === plan.deploymentId ? signInNotice.message : undefined;
        return notice ? { ...plan, notice } : plan;
      },
      needsSetup: async () => {
        const database = await probe.database();
        if (!database.configured || !database.reachable) return true;
        if ((await probe.schema()).state !== "current") return true;
        return (await probe.replicas()).length === 0;
      },
      saveDatabase: async (input) => {
        if (env.DATABASE_URL) throw new Error("DATABASE_URL is set in the environment, so the console uses that. Change it there.");
        const url = validateDatabaseUrl(input);
        const { PrismaClient } = await import("@prisma/client");
        const client = new PrismaClient({ datasourceUrl: url });
        try {
          await client.$queryRaw`SELECT 1`;
        } catch (error) {
          throw new Error(`Couldn't connect to ${displayDatabaseUrl(url)}: ${safeReason(error)}`);
        } finally {
          await client.$disconnect().catch(() => {});
        }
        await saveDatabaseUrl(configDir(), url);
        await resetStore();
      },
      applySchema: async (confirmPopulated) => {
        const url = await databaseUrl();
        if (!url) throw new Error("Connect a database first.");
        const schema = await probe.schema();
        if (schema.state === "current") return;
        if (schema.state === "foreign") throw new Error(`This database has tables ReplCRM didn't create (${schema.reason}). Use an empty database.`);
        if (schema.state === "pending" && schema.populated && !confirmPopulated) {
          throw new Error("This database already holds replicated data. Confirm you have a backup before applying updates.");
        }
        const { applyMigrations } = await import("./setup/schema.js");
        await applyMigrations(url);
        await resetStore();
      },
      createReplica: async (rawId, rawName) => {
        const { id, name } = validateReplica(rawId, rawName);
        const current = await getStore();
        if (await current.deploymentExists(id)) throw new Error(`A replica called ${id} already exists. Choose another ID.`);
        await current.ensureDeployment(id, name);
      },
      saveApp: async (deploymentId, clientId, loginUrl) => {
        safeDeploymentFileName(deploymentId);
        if (!(await (await getStore()).deploymentExists(deploymentId))) throw new Error(`There is no replica called ${deploymentId}.`);
        await saveApp(configDir(), deploymentId, validateApp(clientId, loginUrl));
      },
      startSignIn: async (deploymentId) => {
        safeDeploymentFileName(deploymentId);
        if (signIn) throw new Error("A Salesforce sign-in is already waiting in your browser. Finish or close it first.");
        const app = await probe.app(deploymentId);
        if (!app.clientId) throw new Error("Save the Salesforce app's consumer key first.");
        let reportUrl!: (url: string) => void;
        let failEarly!: (error: Error) => void;
        const opened = new Promise<string>((resolve, reject) => { reportUrl = resolve; failEarly = reject; });
        const errors: string[] = [];
        signInNotice = undefined;
        const done = runAuth(["login", "--login-url", app.loginUrl], {
          env: { ...await envFor(deploymentId), DEPLOYMENT_ID: deploymentId, SF_CLIENT_ID: app.clientId },
          now, withRefreshLock, fetch: overrides?.fetch ?? globalThis.fetch,
          tokenStore: () => createTokenStore(configDir()),
          listen: listenForAuth, openBrowser: openAuthBrowser, scheduleTimeout: scheduleAuthTimeout,
          ...overrides?.auth,
          stdout: (message) => { if (/^https:\/\//.test(message)) reportUrl(message); },
          stderr: (message) => { errors.push(message); },
        });
        signIn = { done, deploymentId };
        void done.then((code) => {
          if (code !== 0) signInNotice = { deploymentId, message: errors.at(-1) ?? "Salesforce sign-in didn't finish. Try again." };
        }, (error: unknown) => {
          signInNotice = { deploymentId, message: safeReason(error) };
          failEarly(new Error(safeReason(error)));
        }).finally(() => { signIn = undefined; });
        void done.then(() => failEarly(new Error(errors.at(-1) ?? "Salesforce sign-in ended before it started.")));
        return { url: await opened };
      },
      availableObjects: async (deploymentId) => {
        const source = await createSource(consoleConfig(deploymentId));
        try {
          const listed = await source.listReplicableObjects();
          const byName = new Map(listed.map((item) => [item.name, item]));
          const allowed = await selectEntityKeys({ ...consoleConfig(deploymentId), entityKeys: ["*"] }, { listEntities: async () => [...byName.keys()] });
          return allowed.sort().map((key) => {
            const { name, label, custom } = byName.get(key)!;
            return { name, label, custom };
          });
        } finally {
          await source.logout().catch(() => {});
        }
      },
      saveObjects: (deploymentId, entities) => saveSelection(objects, deploymentId, entities),
    };
  }

  return {
    consoleNow: now,
    consolePort: env.REPLCRM_CONSOLE_PORT,
    setup: createSetup(),
    listenConsole: listenForConsole,
    loadConsoleConfig: async () => {
      if (env.DEPLOYMENT_ID) return loadReplicationConfig(env);
      let first = "";
      try {
        first = (await (await getStore()).listDeployments())[0]?.id ?? "";
      } catch {
        first = "";
      }
      return { ...consoleConfig("setup"), deploymentId: first };
    },
    createConsoleHandler: (port, runs, runsFor, setup) => createConsoleHandler({
      port, now, runs, runsFor, ...(setup && { setup }),
      listReplicas: async () => (await getStore()).listDeployments(),
      ...(runs && { interruptedRuns: async (deploymentId?: string) => {
        const id = deploymentId || env.DEPLOYMENT_ID || (await (await getStore()).listDeployments())[0]?.id;
        if (!id) return [];
        return findInterruptedRuns(runLockPath(configDir(), safeDeploymentFileName(id)),
          async () => (await getStore()).runningRuns(id));
      } }),
      buildStatus: async (deploymentId?: string) => {
        const id = deploymentId || env.DEPLOYMENT_ID || (await (await getStore()).listDeployments())[0]?.id;
        if (!id) throw new Error("No replica yet. Finish setup first.");
        const config = consoleConfig(id);
        const selection = await resolveSelection(config, objects);
        const statusStore: StatusStore = await getStore();
        return buildStatus(config, selection, statusStore, async () => {
          const tokenStore = await createTokenStore(configDir());
          // A replica other than DEPLOYMENT_ID with no stored sign-in is "not signed in", not unreachable.
          if (config.deploymentId !== env.DEPLOYMENT_ID && !(await tokenStore.load(config.deploymentId))) return undefined;
          const auth = await loadSourceAuth(await envFor(config.deploymentId), tokenStore, true);
          return auth && sourceFromAuth(auth, tokenStore);
        }, { now });
      },
    }),
    auth: {
      env, now, withRefreshLock, fetch: overrides?.fetch ?? globalThis.fetch,
      tokenStore: () => createTokenStore(configDir()),
      listen: listenForAuth, openBrowser: openAuthBrowser, scheduleTimeout: scheduleAuthTimeout,
      stdout: (message) => console.log(message), stderr: (message) => console.error(message),
      ...overrides?.auth,
    },
    acquireRunLock: (deploymentId, command) => acquireLock(runLockPath(configDir(), deploymentId), {
      command, now, ...(overrides?.runLockIsProcessAlive && { isProcessAlive: overrides.runLockIsProcessAlive }),
    }),
    onSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => { process.removeListener(signal, handler); };
    },
    exit: (code) => process.exit(code),
    objects,
    loadConfig: () => loadReplicationConfig(env),
    validateSourceCredentials,
    createSource,
    verify: {
      configDir,
      createSource,
      validateConfig: async () => {
        if (!env.DATABASE_URL) throw new Error("Missing required env var: DATABASE_URL");
        await validateSourceCredentials();
      },
    },
    counts: { createSource, createStore: getStore },
    reconcile: { configDir, now, createSource, createStore: getStore },
    createStore: getStore,
    ensureDeployment: async (id, name, sourceUrl) => (await getStore()).ensureDeployment(id, name, sourceUrl),
    deploymentExists: async (id) => (await getStore()).deploymentExists(id),
    hasEntityMetadata: async (id, keys) => (await getStore()).hasEntityMetadata(id, keys),
    close: async () => {
      const client = prisma;
      prisma = undefined;
      store = undefined;
      await client?.$disconnect();
    },
  };
}

const entry = process.argv[1];
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), createProductionDeps(process.env)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
