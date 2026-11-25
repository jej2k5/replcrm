import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { runLockPath, writePrivateJson } from "../src/cli-config-dir.js";
import { resolveSelection } from "../src/cli-objects.js";
import { createConsoleHandler } from "../src/console/handler.js";
import { buildStatus, findInterruptedRuns } from "../src/console/status.js";
import type { ConsoleListener } from "../src/console/listener.js";
import { acquireLock } from "../src/locks/file-lock.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { config, entity, FakeSource } from "./helpers/cli-fixture.js";

const { deploymentId } = config;
const contact = { ...entity, key: "Contact" };
const definitions = [entity, contact];
const headers = { host: "127.0.0.1:4780" };
const now = () => new Date("2026-10-01T12:00:00.000Z");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(dir: string) {
  const store = new InMemoryReplicaStore();
  const lockPath = runLockPath(dir, deploymentId);
  const production = createProductionDeps({
    DEPLOYMENT_ID: deploymentId, DATABASE_URL: "fixture-db", REPLCRM_CONFIG_DIR: dir,
    SYNC_ENTITIES: "Lead", REPLCRM_BUILD_WIDE_VIEWS: "false",
  }, { now, runLockIsProcessAlive: (pid) => pid !== 4322 });
  await writePrivateJson(join(dir, "selections", deploymentId + ".json"), {
    version: 1, entities: definitions.map(({ key }) => key),
  });
  let requests = 0;
  let beforeBatch = async () => {};
  const events: string[] = [];
  const timeout = deferred();
  let interrupt!: () => Promise<void>;
  let serve!: ReturnType<typeof createConsoleHandler>;
  const listening = deferred();
  class Source extends FakeSource {
    override async describeEntity(key?: string) {
      const definition = definitions.find((item) => item.key === key);
      assert.ok(definition);
      return definition;
    }
    override async *fetchChanges() {
      await beforeBatch();
      yield* super.fetchChanges();
    }
  }
  const deps: CliDeps = {
    ...production,
    loadConfig: () => ({ ...config, entityKeys: ["Lead"], buildWideViews: false }),
    validateSourceCredentials: () => {},
    deploymentExists: () => true,
    createStore: () => store,
    createSource: () => new Source(),
    hasEntityMetadata: (id, keys) => store.hasEntityMetadata(id, keys),
    close: async () => { events.push("store"); },
    waitForConsoleRun: (ms) => {
      assert.equal(ms, 10_000);
      events.push("wait");
      return timeout.promise;
    },
    createConsoleHandler: (port, runs) => createConsoleHandler({
      port, runs, now,
      interruptedRuns: () => findInterruptedRuns(lockPath, async () => store.runningRuns(deploymentId)),
      buildStatus: async () => {
        const base = await deps.loadConfig();
        const selection = await resolveSelection(base, deps.objects);
        return buildStatus(base, selection, store, {
          listEntities: async () => definitions.map(({ key }) => key),
          countRecords: async () => { requests++; return 0; },
        }, { now });
      },
    }),
    listenConsole: async (...[host, , handler]: Parameters<ConsoleListener>) => {
      assert.equal(host, "127.0.0.1");
      serve = handler;
      listening.resolve();
      return { close: async () => {
        await assert.rejects(stat(lockPath), { code: "ENOENT" });
        events.push("listener");
      } };
    },
    onSignal: (signal, handler) => {
      assert.equal(signal, "SIGINT");
      interrupt = handler;
      return () => { events.push("signal"); };
    },
  };
  const running = runCli(["console"], deps);
  await Promise.race([listening.promise, running.then(() => assert.fail("Console exited before listening"))]);
  const page = () => serve("GET", "/", headers);
  const html = (await page()).body;
  const token = html.match(/"X-ReplCRM-Token": "([a-f0-9]{64})"/)?.[1];
  assert.ok(token);
  const post = (stage: string, supplied: string | null = token) => serve(
    "POST", "/api/runs", supplied === null ? headers : { ...headers, "x-replcrm-token": supplied },
    JSON.stringify({ stage }),
  );
  const status = () => serve("GET", "/api/status", headers);
  const progress = async () => JSON.parse((await serve("GET", "/api/runs/current", headers)).body) as {
    state: string; stage: string; lines: string[]; finishedAt?: string;
  };
  async function finished(state: string) {
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const run = await progress();
      if (run.state !== "running") {
        assert.equal(run.state, state);
        assert.ok(run.finishedAt);
        return run;
      }
      await (attempt < 1000 ? setImmediate() : delay(10));
    }
    assert.fail("Run did not finish");
  }
  const { onSignal: _signal, close: _close, ...cliDeps } = deps;
  return {
    store, lockPath, events, running, timeout, serve, page, status, token, post, progress, finished,
    stop: () => interrupt(), requests: () => requests,
    seed: () => store.persistMetadata(deploymentId, definitions),
    block: (hook: () => Promise<void>) => { beforeBatch = hook; },
    cli: () => runCli(["records"], cliDeps),
  };
}

function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), "replcrm-actions-"));
    try {
      const f = await fixture(dir);
      try {
        await run(f);
      } finally {
        f.timeout.resolve();
        await f.stop();
        assert.equal(await f.running, 0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test("records uses the CLI metadata precondition and saved selection", withFixture(async (f) => {
  assert.equal((await f.progress()).state, "idle");
  assert.equal((await f.post("records")).status, 202);
  assert.match((await f.finished("failed")).lines.join("\n"), /Entity metadata is missing for the selected entities/);
  await f.seed();
  const gate = deferred();
  f.block(() => gate.promise);
  try {
    assert.equal((await f.post("records")).status, 202);
    assert.equal((await f.progress()).state, "running");
    assert.match((await f.page()).body, /data-stage="records" disabled/);
  } finally {
    gate.resolve();
  }
  const run = await f.finished("succeeded");
  assert.match(run.lines.join("\n"), /Replication complete/);
  assert.deepEqual([...f.store.latestEntityRuns(deploymentId).keys()], ["Account", "Contact"]);
  assert.ok([...f.store.latestEntityRuns(deploymentId).values()].every((row) => row.status === "Succeeded"));
  assert.ok(!(await f.status()).body.includes(f.token));
}));

test("the start endpoint requires the page token", withFixture(async (f) => {
  assert.equal((await f.post("records", null)).status, 403);
  assert.equal((await f.post("records", "0".repeat(64))).status, 403);
  assert.equal((await f.progress()).state, "idle");
}));

test("the start endpoint rejects other stages, invalid JSON and invalid Host", withFixture(async (f) => {
  const authorized = { ...headers, "x-replcrm-token": f.token };
  assert.equal((await f.post("metadata")).status, 400);
  assert.equal((await f.serve("POST", "/api/runs", authorized, "{")).status, 400);
  assert.equal((await f.serve("POST", "/api/runs", { ...authorized, host: "example.test" }, { stage: "records" })).status, 400);
  assert.equal((await f.progress()).state, "idle");
}));

test("a second console start identifies the active console holder", withFixture(async (f) => {
  await f.seed();
  const gate = deferred();
  f.block(() => gate.promise);
  try {
    assert.equal((await f.post("records")).status, 202);
    const response = await f.post("full");
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(response.body).holder.command, "console records");
  } finally {
    gate.resolve();
    await f.finished("succeeded");
  }
}));

test("a five-hour-old live CLI holder still blocks a console start", withFixture(async (f) => {
  const startedAt = new Date(now().getTime() - 5 * 60 * 60 * 1000);
  const lock = await acquireLock(f.lockPath, { command: "full", pid: 4321, now: () => startedAt });
  try {
    const response = await f.post("records");
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.body).holder, { command: "full", pid: 4321, startedAt: startedAt.toISOString() });
  } finally {
    await lock.release();
  }
}));

test("a dead CLI holder stays in place and returns manual recovery instructions", withFixture(async (f) => {
  const lock = await acquireLock(f.lockPath, { command: "metadata", pid: 4322, now });
  try {
    const response = await f.post("records");
    assert.equal(response.status, 409);
    assert.ok(JSON.parse(response.body).error.includes("Delete " + f.lockPath + " and retry."));
    assert.ok((await stat(f.lockPath)).isFile());
  } finally {
    await lock.release();
  }
}));

test("CLI records refuses the console lock and succeeds after release", withFixture(async (f) => {
  await f.seed();
  const gate = deferred();
  f.block(() => gate.promise);
  try {
    assert.equal((await f.post("records")).status, 202);
    assert.equal(await f.cli(), 1);
  } finally {
    gate.resolve();
  }
  await f.finished("succeeded");
  await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
  assert.equal(await f.cli(), 0);
}));

test("a failed stage reports its error, releases the lock and allows another run", withFixture(async (f) => {
  await f.seed();
  f.block(async () => { throw new Error("fixture stage failed"); });
  assert.equal((await f.post("records")).status, 202);
  assert.ok((await f.finished("failed")).lines.includes("fixture stage failed"));
  await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
  assert.equal((await f.status()).status, 200);
  f.block(async () => {});
  assert.equal((await f.post("full")).status, 202);
  assert.equal((await f.finished("succeeded")).stage, "full");
}));

test("SIGINT rejects starts and releases the lock before closing the listener and store", withFixture(async (f) => {
  await f.seed();
  const entered = deferred();
  const gate = deferred();
  f.block(() => { entered.resolve(); return gate.promise; });
  assert.equal((await f.post("records")).status, 202);
  await entered.promise;
  try {
    const stopping = f.stop();
    assert.equal((await f.post("full")).status, 503);
    assert.deepEqual(f.events, ["wait"]);
    f.timeout.resolve();
    await stopping;
    assert.equal(await f.running, 0);
    assert.ok((await f.finished("failed")).lines.includes("console stopped"));
    assert.deepEqual(f.events, ["wait", "listener", "signal", "store"]);
    await assert.rejects(stat(f.lockPath), { code: "ENOENT" });
  } finally {
    gate.resolve();
  }
}));

test("interrupted runs warn without blocking and sync invalidates cached counts", withFixture(async (f) => {
  await f.seed();
  await f.store.beginRun(deploymentId, entity.key);
  assert.match((await f.page()).body, /Interrupted sync of Account/);
  const count = f.requests();
  assert.equal((await f.status()).status, 200);
  assert.equal(f.requests(), count);
  assert.equal((await f.post("records")).status, 202);
  await f.finished("succeeded");
  assert.equal((await f.status()).status, 200);
  assert.equal(f.requests(), count + 2);
}));

test("captured stdout and stderr keep the last 200 lines and strip bearer values", withFixture(async (f) => {
  await f.seed();
  let logged = false;
  f.block(async () => {
    if (logged) return;
    logged = true;
    for (let line = 0; line < 210; line++) console.log("line %d", line);
    console.error("request failed: Bearer fixture-access");
  });
  assert.equal((await f.post("records")).status, 202);
  const run = await f.finished("succeeded");
  assert.equal(run.lines.length, 200);
  assert.equal(run.lines[0], "line 13");
  assert.ok(run.lines.includes("request failed:"));
  assert.ok(run.lines.includes("[replication] projections"));
  assert.ok(!run.lines.join("\n").includes("fixture-access"));
}));
