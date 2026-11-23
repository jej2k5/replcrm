import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const buildParent = join(workspace, ".offline-build");
const buildRoot = join(buildParent, `run-${process.pid}`);
const tsc = "node_modules/typescript/bin/tsc";
const testEnv = { ...process.env, REPLCRM_COMPILED_DIR: buildRoot };
// A runner invoked by a test file must start a fresh node:test session.
delete testEnv.NODE_TEST_CONTEXT;
const requested = process.argv.slice(2);
const files = requested.length > 0 ? requested : readdirSync(join(workspace, "tests"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => `tests/${entry.name}`)
  .sort();

function run(args, env = process.env) {
  const child = spawnSync(process.execPath, args, { cwd: workspace, env, stdio: "inherit" });
  if (child.error) console.error(child.error);
  return child.status ?? 1;
}

try {
  process.exitCode = run([tsc, "--project", "tsconfig.tests.json"])
    || run([tsc, "--outDir", buildRoot])
    || run(["--import", "tsx", "--test", ...files], testEnv);
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
  try {
    rmdirSync(buildParent);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  }
}
