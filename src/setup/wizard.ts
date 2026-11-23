import { createInterface } from "node:readline";
import type { SetupPlan, SetupService } from "./core.js";

// The CLI front end of setup. It asks the same questions as the console wizard and calls the same
// engine, so the two can never disagree about what is done or what comes next.

export interface WizardIO {
  ask(question: string, options?: { secret?: boolean; fallback?: string }): Promise<string>;
  say(line: string): void;
}

export interface WizardDeps {
  setup: SetupService;
  runFirstSync(deploymentId: string): Promise<void>;
  wait?(ms: number): Promise<void>;
  signInTimeoutMs?: number;
}

const quitWords = new Set(["q", "quit", "exit"]);

class Quit extends Error {}

export async function runSetupWizard(io: WizardIO, deps: WizardDeps, deploymentId?: string): Promise<number> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let id = deploymentId;
  let lastShown = "";
  io.say("ReplCRM setup. Each step is checked before the next one; type q to stop and pick up later.");

  async function ask(question: string, options?: { secret?: boolean; fallback?: string }): Promise<string> {
    let raw: string;
    try {
      raw = await io.ask(question, options);
    } catch (error) {
      if (error instanceof Error && error.name === "InputClosed") throw new Quit();
      throw error;
    }
    const answer = raw.trim();
    if (quitWords.has(answer.toLowerCase())) throw new Quit();
    return answer || options?.fallback || "";
  }

  try {
    for (let rounds = 0; rounds < 60; rounds++) {
      const plan = await deps.setup.plan(id);
      if (plan.deploymentId) id = plan.deploymentId;
      const current = plan.steps.find((step) => step.state === "current");
      const progress = plan.steps.map((step) => (step.state === "done" ? "x" : step.state === "current" ? ">" : " ")).join("");
      if (progress !== lastShown) {
        plan.steps.forEach((step, index) => {
          const mark = step.state === "done" ? "[x]" : step.state === "current" ? "[>]" : "[ ]";
          io.say(`${mark} ${index + 1}. ${step.title}${step.state !== "todo" && step.detail ? ` - ${step.detail}` : ""}`);
        });
        lastShown = progress;
      }
      if (!current) {
        io.say(`Setup is complete. Open the console with: npm run console`);
        return 0;
      }
      try {
        await runStep(current.id, plan);
      } catch (error) {
        if (error instanceof Quit) throw error;
        io.say(`! ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    io.say("Setup stopped after too many attempts. Run it again to continue.");
    return 1;
  } catch (error) {
    if (!(error instanceof Quit)) throw error;
    io.say(`Stopped. Run \`npm start -- setup${id ? ` --deployment ${id}` : ""}\` to pick up where you left off.`);
    return 0;
  }

  async function runStep(step: string, plan: SetupPlan & { notice?: string }): Promise<void> {
    if (step === "database") {
      const url = await ask("PostgreSQL connection URL (hidden): ", { secret: true });
      await deps.setup.saveDatabase(url);
      return;
    }
    if (step === "schema") {
      const schema = plan.schema;
      if (schema?.state === "foreign") throw new Error("This database has tables ReplCRM didn't create. Point setup at an empty database.");
      const pending = schema && "pending" in schema ? schema.pending : [];
      if (pending.length) io.say(`  Updates to apply: ${pending.join(", ")}`);
      let confirm = false;
      if (schema?.state === "pending" && schema.populated) {
        confirm = (await ask("  This database holds replicated data. Do you have a recent backup? [y/N] ")).toLowerCase().startsWith("y");
        if (!confirm) throw new Error("Back up the database first, then run setup again.");
      } else if (!(await ask(`  ${schema?.state === "empty" ? "Create ReplCRM's tables" : "Apply the updates"} now? [Y/n] `, { fallback: "y" })).toLowerCase().startsWith("y")) {
        throw new Quit();
      }
      await deps.setup.applySchema(confirm);
      return;
    }
    if (step === "replica") {
      const name = await ask("Replica name (like EMEA production): ");
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
      const chosen = await ask(`Replica ID [${slug}]: `, { fallback: slug });
      await deps.setup.createReplica(chosen, name);
      id = chosen.trim();
      return;
    }
    if (!id) throw new Error("Choose a replica first.");
    if (step === "app") {
      const app = plan.app;
      io.say("  In Salesforce Setup, open External Client App Manager and create a new app:");
      io.say(`  - Enable OAuth with the callback URL ${app?.callbackUrl ?? "http://localhost:47123/oauth/callback"}`);
      io.say("  - Scopes: api, and refresh_token, offline_access. Leave every Flow Enablement box unticked.");
      io.say("  - Security: keep PKCE on and untick both Require secret boxes.");
      io.say("  - Then open Consumer Key and Secret and copy the consumer key (not the secret).");
      const key = await ask("Consumer key: ");
      const login = await ask(`Login URL [${app?.loginUrl ?? "https://login.salesforce.com"}]: `, { fallback: app?.loginUrl ?? "https://login.salesforce.com" });
      await deps.setup.saveApp(id, key, login);
      return;
    }
    if (step === "signin") {
      if (plan.notice) io.say(`  ${plan.notice}`);
      await ask("Press Enter to open Salesforce sign-in in your browser. ");
      const { url } = await deps.setup.startSignIn(id);
      io.say(`  If your browser didn't open, visit: ${url}`);
      io.say("  Waiting for Salesforce to confirm…");
      const deadline = Date.now() + (deps.signInTimeoutMs ?? 300_000);
      while (Date.now() < deadline) {
        await wait(2000);
        const next = await deps.setup.plan(id);
        if (next.steps.find((item) => item.id === "signin")?.state === "done") return;
        if (next.notice) throw new Error(next.notice);
      }
      throw new Error("Sign-in timed out. Try again.");
    }
    if (step === "objects") {
      const available = await deps.setup.availableObjects(id);
      const defaults = plan.selection?.length ? plan.selection : ["Account", "Contact", "Lead", "Opportunity", "Case"].filter((name) => available.some((item) => item.name === name));
      io.say(`  Salesforce lets ReplCRM copy ${available.length} objects${available.some((item) => item.custom) ? `, including custom ones: ${available.filter((item) => item.custom).map((item) => item.name).slice(0, 8).join(", ")}` : ""}.`);
      const answer = await ask(`Objects to copy, comma-separated, or * for all [${defaults.join(",")}]: `, { fallback: defaults.join(",") });
      const entities = answer.split(",").map((item) => item.trim()).filter(Boolean);
      const unknown = entities.filter((name) => name !== "*" && !available.some((item) => item.name === name));
      if (unknown.length) throw new Error(`Salesforce doesn't offer ${unknown.join(", ")} to this user. Check the spelling.`);
      await deps.setup.saveObjects(id, entities);
      return;
    }
    if (step === "sync") {
      if (!(await ask("Run the first sync now? It copies every chosen object and checks counts. [Y/n] ", { fallback: "y" })).toLowerCase().startsWith("y")) throw new Quit();
      io.say("  Syncing…");
      await deps.runFirstSync(id);
    }
  }
}

/** Raised when input ends (Ctrl-D, or a script runs out of lines); the wizard stops cleanly. */
export class InputClosed extends Error {
  constructor() { super("Input closed"); this.name = "InputClosed"; }
}

/** Terminal prompts. Lines typed or piped early are queued, and secret answers are not echoed. */
export function terminalIO(): WizardIO & { close(): void } {
  const interactive = Boolean(process.stdin.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
  const lines: string[] = [];
  const waiting: { resolve(line: string): void; reject(error: Error): void }[] = [];
  let closed = false;
  let muted = false;
  rl.on("line", (line) => {
    muted = false;
    const next = waiting.shift();
    if (next) next.resolve(line); else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next.reject(new InputClosed());
  });
  if (interactive) {
    const writer = rl as unknown as { _writeToOutput(text: string): void };
    const original = writer._writeToOutput.bind(rl);
    writer._writeToOutput = (text: string) => {
      if (muted && !text.includes("\n")) return;
      original(text);
    };
  }
  return {
    say: (line) => console.log(line),
    ask: (question, options) => new Promise((resolve, reject) => {
      process.stdout.write(question);
      const queued = lines.shift();
      if (queued !== undefined) {
        if (!interactive) process.stdout.write("\n");
        return resolve(queued);
      }
      if (closed) {
        process.stdout.write("\n");
        return reject(new InputClosed());
      }
      muted = Boolean(options?.secret);
      waiting.push({ resolve: (line) => { if (!interactive) process.stdout.write("\n"); resolve(line); }, reject });
    }),
    close: () => rl.close(),
  };
}
