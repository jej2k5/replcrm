import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { runCli } from "../src/cli.js";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const runtimeScripts = Object.entries(scripts)
  .map(([name, script]) => ({ name, tokens: script.trim().split(/\s+/) }))
  .filter(({ tokens }) => tokens[0] === "tsx" || tokens[0] === "node");

function targetIndex(tokens: string[]): number {
  return tokens.findIndex((token) => /^(?:\.\/)?(?:src|scripts|tests|dist)\//.test(token));
}

test("each Node or tsx script reaches a checked-in target or the source of its dist target", () => {
  assert.ok(runtimeScripts.length > 0);
  for (const { name, tokens } of runtimeScripts) {
    const target = tokens[targetIndex(tokens)]?.replace(/^\.\//, "");
    assert.ok(target, `${name} has no repository target`);
    const source = target.replace(/^dist\/(.+)\.js$/, "src/$1.ts");
    assert.ok(!source.startsWith("dist/"), `${name} has an unmapped build target: ${target}`);
    assert.ok(statSync(new URL(source, new URL("../", import.meta.url)), { throwIfNoEntry: false })?.isFile(),
      `${name} points to missing file ${source}`);
  }
});

test("CLI scripts use subcommands advertised by runCli", async (t) => {
  const stdout = t.mock.method(console, "log", () => {});
  const unexpected = (): never => assert.fail("Help must not start replication");
  assert.equal(await runCli(["help"], {
    loadConfig: unexpected, createSource: unexpected, createStore: unexpected, hasEntityMetadata: unexpected,
    deploymentExists: unexpected, ensureDeployment: unexpected,
  }), 0);
  const help = String(stdout.mock.calls[0]?.arguments[0]);
  const commands = new Set(help.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]));
  for (const { name, tokens } of runtimeScripts) {
    const index = targetIndex(tokens);
    const target = tokens[index]?.replace(/^\.\//, "");
    if (target !== "src/cli.ts" && target !== "dist/cli.js") continue;
    const command = tokens[index + 1] ?? "full";
    assert.ok(commands.has(command), `${name} invokes an unsupported CLI command: ${command}`);
  }
});
