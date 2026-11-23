// The setup engine shared by the console wizard and the CLI. It never assumes a step is done:
// every step is checked against reality (the database, the stored sign-in, the saved selection,
// the latest sync), and the first unfinished one is the operator's next action.

export type StepId = "database" | "schema" | "replica" | "app" | "signin" | "objects" | "sync";
export type StepState = "done" | "current" | "todo";

export interface SetupStep {
  id: StepId;
  title: string;
  state: StepState;
  /** One plain sentence about what is true now, or what to do. Never contains a secret. */
  detail: string;
}

export type DatabaseProbe =
  | { configured: false }
  | { configured: true; reachable: true; display: string; source: "env" | "saved" }
  | { configured: true; reachable: false; display: string; source: "env" | "saved"; reason: string };

export type SchemaProbe =
  | { state: "current" }
  | { state: "empty"; pending: string[] }
  | { state: "pending"; pending: string[]; populated: boolean }
  | { state: "foreign"; reason: string };

export interface ReplicaProbe { id: string; name: string }
export interface AppProbe { clientId?: string | undefined; loginUrl: string; callbackUrl: string; passwordSignIn?: boolean }
export interface SyncProbe { ran: boolean; succeeded: boolean; objects: number; matches: number | null }

/** Read-only checks. Each is called only when every earlier step is done. */
export interface SetupProbe {
  database(): Promise<DatabaseProbe>;
  schema(): Promise<SchemaProbe>;
  replicas(): Promise<ReplicaProbe[]>;
  app(deploymentId: string): Promise<AppProbe>;
  signedIn(deploymentId: string): Promise<boolean>;
  selection(deploymentId: string): Promise<string[] | undefined>;
  sync(deploymentId: string): Promise<SyncProbe>;
}

export interface SetupPlan {
  steps: SetupStep[];
  /** The replica this plan is for, once one exists. */
  deploymentId?: string;
  replicaName?: string;
  /** The saved object selection, once there is one. */
  selection?: string[];
  database?: DatabaseProbe;
  schema?: SchemaProbe;
  app?: AppProbe;
  complete: boolean;
}

export const stepTitles: Record<StepId, string> = {
  database: "Connect your database",
  schema: "Prepare the database",
  replica: "Name this replica",
  app: "Connect your Salesforce app",
  signin: "Sign in to Salesforce",
  objects: "Choose what to copy",
  sync: "Run the first sync",
};

const order: StepId[] = ["database", "schema", "replica", "app", "signin", "objects", "sync"];

/**
 * Plans setup for one replica. `deploymentId` continues an existing replica; without it the plan
 * covers adding a new one, so the replica step stays open even when other replicas exist.
 */
export async function planSetup(probe: SetupProbe, deploymentId?: string): Promise<SetupPlan> {
  const done = new Map<StepId, string>();
  const open = new Map<StepId, string>();
  const plan: Omit<SetupPlan, "steps" | "complete"> = {};

  const database = await probe.database();
  plan.database = database;
  if (!database.configured) {
    open.set("database", "Paste a PostgreSQL connection URL, or start the console with DATABASE_URL set.");
  } else if (!database.reachable) {
    open.set("database", `Can't reach ${database.display}: ${database.reason}`);
  } else {
    done.set("database", `Connected to ${database.display}.`);
  }

  if (done.has("database")) {
    const schema = await probe.schema();
    plan.schema = schema;
    if (schema.state === "current") done.set("schema", "Tables are up to date.");
    else if (schema.state === "empty") open.set("schema", "This database is empty. Create ReplCRM's tables in it.");
    else if (schema.state === "pending") {
      open.set("schema", `${schema.pending.length} schema update${schema.pending.length === 1 ? "" : "s"} to apply` +
        (schema.populated ? ". This database already holds replicated data, so back it up first." : "."));
    } else open.set("schema", `This database has tables ReplCRM didn't create (${schema.reason}). Use an empty database.`);
  }

  let replica: ReplicaProbe | undefined;
  if (done.has("schema")) {
    const replicas = await probe.replicas();
    replica = deploymentId ? replicas.find((item) => item.id === deploymentId) : undefined;
    if (replica) {
      plan.deploymentId = replica.id;
      plan.replicaName = replica.name;
      done.set("replica", `${replica.name} (${replica.id}).`);
    } else if (deploymentId) {
      open.set("replica", `There is no replica called ${deploymentId} yet. Create it here.`);
    } else {
      open.set("replica", replicas.length
        ? "Give the new replica a short ID and a name you'll recognize."
        : "Give your first replica a short ID and a name you'll recognize.");
    }
  }

  if (replica) {
    const app = await probe.app(replica.id);
    plan.app = app;
    if (app.clientId) done.set("app", `Consumer key saved for ${new URL(app.loginUrl).host}.`);
    else if (app.passwordSignIn) done.set("app", "Using the password sign-in set in the environment.");
    else open.set("app", "Create an External Client App in Salesforce, then paste its consumer key.");

    if (done.has("app")) {
      if (await probe.signedIn(replica.id)) done.set("signin", "Signed in. ReplCRM stores the sign-in, never your password.");
      else open.set("signin", "Sign in through your browser so ReplCRM can read this org.");
    }

    if (done.has("signin")) {
      const selection = await probe.selection(replica.id);
      if (selection?.length) plan.selection = selection;
      if (selection?.length) {
        done.set("objects", selection.length === 1 && selection[0] === "*"
          ? "Every object Salesforce lets ReplCRM copy." : `${selection.length} object${selection.length === 1 ? "" : "s"}: ${selection.slice(0, 6).join(", ")}${selection.length > 6 ? ", …" : ""}.`);
      } else open.set("objects", "Pick the Salesforce objects to copy.");
    }

    if (done.has("objects")) {
      const sync = await probe.sync(replica.id);
      if (sync.ran && sync.succeeded && sync.matches !== null && sync.matches === sync.objects) {
        done.set("sync", `First sync finished. All ${sync.objects} objects match Salesforce.`);
      } else if (sync.ran && sync.succeeded && sync.matches !== null) {
        open.set("sync", `Synced, but ${sync.objects - sync.matches} of ${sync.objects} objects don't match yet. Run the sync again.`);
      } else if (sync.ran && !sync.succeeded) {
        open.set("sync", "The last sync failed. Check the sync log, then run it again.");
      } else open.set("sync", "Copy your data and check it against Salesforce.");
    }
  }

  let current: StepId | undefined;
  const steps = order.map((id): SetupStep => {
    if (done.has(id)) return { id, title: stepTitles[id], state: "done", detail: done.get(id)! };
    if (!current) {
      current = id;
      return { id, title: stepTitles[id], state: "current", detail: open.get(id) ?? "" };
    }
    return { id, title: stepTitles[id], state: "todo", detail: "" };
  });
  return { ...plan, steps, complete: current === undefined };
}

/** Hides the password in a connection URL so it is safe to show and log. */
export function displayDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : "";
    return `${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured database";
  }
}

export function validateDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("That isn't a URL. It should look like postgresql://user:password@host:5432/database.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("ReplCRM stores replicas in PostgreSQL. Use a postgresql:// URL.");
  }
  if (!parsed.hostname || parsed.pathname.length <= 1) {
    throw new Error("Include the host and the database name, like postgresql://user:password@host:5432/database.");
  }
  return url.trim();
}

export function validateReplica(id: string, name: string): { id: string; name: string } {
  const cleanId = id.trim();
  const cleanName = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleanId)) {
    throw new Error("Use letters, numbers, dots, dashes or underscores for the ID, starting with a letter or number.");
  }
  if (!cleanName || cleanName.length > 120) throw new Error("Give the replica a name up to 120 characters.");
  return { id: cleanId, name: cleanName };
}

export function validateApp(clientId: string, loginUrl: string): { clientId: string; loginUrl: string } {
  const key = clientId.trim();
  if (!/^[A-Za-z0-9._-]{20,256}$/.test(key)) {
    throw new Error("That doesn't look like a consumer key. Copy it from the app's Consumer Key and Secret page.");
  }
  let url: URL;
  try {
    url = new URL(loginUrl.trim() || "https://login.salesforce.com");
  } catch {
    throw new Error("The login URL must be an https:// address, like https://login.salesforce.com.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The login URL must be an https:// address, like https://login.salesforce.com.");
  }
  return { clientId: key, loginUrl: url.origin };
}

/** What the console and CLI wizards can ask the engine to do. */
export interface SetupService {
  plan(deploymentId?: string): Promise<SetupPlan & { notice?: string }>;
  /** True when the console has nothing to show yet: no reachable database, no schema, or no replica. */
  needsSetup(): Promise<boolean>;
  saveDatabase(url: string): Promise<void>;
  applySchema(confirmPopulated: boolean): Promise<void>;
  createReplica(id: string, name: string): Promise<void>;
  saveApp(deploymentId: string, clientId: string, loginUrl: string): Promise<void>;
  startSignIn(deploymentId: string): Promise<{ url: string }>;
  availableObjects(deploymentId: string): Promise<{ name: string; label: string; custom: boolean }[]>;
  saveObjects(deploymentId: string, entities: string[]): Promise<void>;
}
