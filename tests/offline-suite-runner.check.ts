import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
const sentinel = new URL(".offline-suite-sentinel", dist);
const buildParent = new URL("../.offline-build/", import.meta.url);

function checkFixture(fixture: string, expectedStatus: number): void {
  const createdDist = mkdirSync(dist, { recursive: true }) !== undefined;
  try {
    writeFileSync(sentinel, "offline suite sentinel", { flag: "wx" });
    try {
      const run = spawnSync(process.execPath, [
        "scripts/offline-suite.mjs",
        `tests/fixtures/offline-suite/${fixture}.fixture.ts`,
      ], { cwd: workspace, encoding: "utf8" });
      const output = run.stdout + run.stderr;
      assert.ok(existsSync(sentinel), "The runner must preserve dist");
      const builds = existsSync(buildParent) ? readdirSync(buildParent) : [];
      assert.deepEqual(builds.filter((name) => name.startsWith("run-")), []);
      assert.ifError(run.error);
      assert.equal(run.status, expectedStatus, output);
      assert.match(output, new RegExp(`${fixture} fixture`));
      if (expectedStatus !== 0) assert.match(output, /intentional offline suite fixture failure/);
    } finally {
      if (existsSync(sentinel)) unlinkSync(sentinel);
    }
  } finally {
    if (createdDist) rmdirSync(dist);
  }
}

test("the offline runner propagates success and cleans its build", () => {
  checkFixture("passing", 0);
});

test("the offline runner propagates failure and cleans its build", () => {
  checkFixture("failing", 1);
});
