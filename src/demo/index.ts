// `npm run demo`: the console on fictional data, with no credentials and no database.
// The environment is scrubbed before any console module loads, so nothing can reach a real database or org.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, "no-open": { type: "boolean" } } });
const input = values.port ?? "4790";
const port = Number(input);
if (!/^\d+$/.test(input) || port < 1 || port > 65535) {
  console.error("Demo port (--port) must be an integer from 1 to 65535.");
  process.exit(1);
}

for (const name of Object.keys(process.env)) {
  if (name === "DATABASE_URL" || name === "DEPLOYMENT_ID" || name.startsWith("SF_") || name.startsWith("REPLCRM_")) delete process.env[name];
}
const configDir = mkdtempSync(join(tmpdir(), "replcrm-demo-"));
process.env.REPLCRM_CONFIG_DIR = configDir;
const cleanup = () => rmSync(configDir, { recursive: true, force: true });
process.on("exit", cleanup);

function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed either way.
  }
}

try {
  const { startDemo } = await import("./console.js");
  const demo = await startDemo({ port });
  console.log(`ReplCRM demo console: ${demo.url}`);
  console.log("Fictional data in memory. No database, no Salesforce sign-in, nothing leaves this computer.");
  console.log("Press Ctrl+C to stop.");
  if (!values["no-open"] && process.stdout.isTTY && !process.env.CI) openBrowser(demo.url);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void demo.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === "EADDRINUSE" ? `Port ${port} is in use. Try npm run demo -- --port 4791.` : error);
  process.exit(1);
}
