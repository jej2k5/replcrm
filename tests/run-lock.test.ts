import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshLockPath, runLockPath } from "../src/cli-config-dir.js";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { acquireLock, LockHeldError, type LockHolder } from "../src/locks/file-lock.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { config, entity, FakeSource } from "./helpers/cli-fixture.js";

const { deploymentId } = config;
const epoch = Date.parse("2026-01-01T00:00:00Z");
const now = () => new Date(epoch);
const options = { command: "records", now, hostname: "fixture-host", pid: 42, isProcessAlive: () => true };

async function inTemp(action: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-run-lock-"));
  try {
    await action(dir, runLockPath(dir, deploymentId));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function holder(path: string): Promise<LockHolder> {
  return JSON.parse(await readFile(path, "utf8")) as LockHolder;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(dir: string, source = new FakeSource()) {
  const store = new InMemoryReplicaStore();
  store.ensureDeployment(deploymentId, deploymentId);
  await store.persistMetadata(deploymentId, [entity]);
  const { acquireRunLock } = createProductionDeps({ REPLCRM_CONFIG_DIR: dir });
  const deps: CliDeps = {
    acquireRunLock: acquireRunLock!,
    loadConfig: () => config,
    createSource: () => source,
    createStore: () => store,
    ensureDeployment: store.ensureDeployment.bind(store),
    deploymentExists: store.deploymentExists.bind(store),
    hasEntityMetadata: store.hasEntityMetadata.bind(store),
  };
  return { deps, store };
}

test("writes a private holder with deployment-scoped paths and releases twice safely", () => inTemp(async (dir, path) => {
  assert.equal(path, join(dir, "locks", "test.run.lock"));
  assert.equal(refreshLockPath(dir, deploymentId), join(dir, "locks", "test.refresh.lock"));
  const lock = await acquireLock(path, options);
  const { ownerToken, ...info } = await holder(path);
  assert.ok(ownerToken);
  assert.deepEqual(info, { command: "records", hostname: "fixture-host", pid: 42, startedAt: now().toISOString() });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "locks"))).mode & 0o777, 0o700);
  await lock.release();
  await assert.rejects(stat(path), { code: "ENOENT" });
  const next = await acquireLock(path, options);
  assert.notEqual((await holder(path)).ownerToken, ownerToken);
  await lock.release();
  await next.release();
}));

test("release leaves a replacement holder untouched", () => inTemp(async (_dir, path) => {
  const lock = await acquireLock(path, options);
  const replacement = JSON.stringify({ ...await holder(path), ownerToken: "replacement" });
  await writeFile(path, replacement);
  await lock.release();
  assert.equal(await readFile(path, "utf8"), replacement);
}));

test("simultaneous exclusive creates have one winner and one named refusal", () => inTemp(async (_dir, path) => {
  const attempts = await Promise.allSettled([acquireLock(path, options), acquireLock(path, options)]);
  const [winner, ...others] = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.ok(winner);
  assert.equal(others.length, 0);
  const loser = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(loser?.reason instanceof LockHeldError);
  assert.deepEqual(loser.reason.holder, await holder(path));
  await winner.value.release();
}));

test("simultaneous CLI records runs write only the winner's SyncRun", (t) => inTemp(async (dir, path) => {
  const source = new FakeSource();
  const entered = latch();
  const resume = latch();
  t.mock.method(source, "listEntities", async () => {
    entered.resolve();
    await resume.promise;
    return [entity.key];
  });
  const { deps, store } = await fixture(dir, source);
  const begin = t.mock.method(store, "beginRun");
  const complete = t.mock.method(store, "completeRuns");
  const stderr = t.mock.method(console, "error", () => {});
  const first = runCli(["records"], deps);
  const second = runCli(["records"], deps);
  try {
    await entered.promise;
    assert.equal(await Promise.race([first, second]), 1);
    const { startedAt } = await holder(path);
    assert.equal(stderr.mock.calls[0]?.arguments[0],
      `Another sync is running for ${deploymentId}: records (pid ${process.pid} on ${hostname()}, started ${startedAt})`);
  } finally {
    resume.resolve();
  }
  assert.deepEqual((await Promise.all([first, second])).sort(), [0, 1]);
  assert.equal(begin.mock.callCount(), 1);
  assert.equal(complete.mock.callCount(), 1);
  assert.equal(store.readRecords(deploymentId, entity.key).length, 1);
}));

test("a live holder that started five hours ago still refuses", () => inTemp(async (_dir, path) => {
  const lock = await acquireLock(path, options);
  await assert.rejects(acquireLock(path, { ...options, now: () => new Date(epoch + 5 * 3600_000) }),
    { message: `records (pid 42 on fixture-host, started ${now().toISOString()})` });
  await lock.release();
}));

test("dead PID recovery is manual even when two starters see it simultaneously", () => inTemp(async (_dir, path) => {
  await acquireLock(path, options);
  const original = await readFile(path);
  const originalHolder = await holder(path);
  const dead = { ...options, isProcessAlive: (pid: number) => {
    assert.equal(pid, options.pid);
    return false;
  } };
  const results = await Promise.allSettled([acquireLock(path, dead), acquireLock(path, dead)]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof LockHeldError);
    assert.deepEqual(result.reason.holder, originalHolder);
    assert.equal(result.reason.message,
      `The records run (pid 42, started ${now().toISOString()}) is no longer running. Delete ${path} and retry.`);
  }
  assert.deepEqual(await readFile(path), original);
  await unlink(path);
  await (await acquireLock(path, options)).release();
}));

test("a remote holder is left untouched and the refusal names the host and file", () => inTemp(async (_dir, path) => {
  const lock = await acquireLock(path, options);
  const original = await readFile(path);
  await assert.rejects(acquireLock(path, {
    ...options, hostname: "different-host", isProcessAlive: () => assert.fail("Checked a remote PID"),
  }), (error: LockHeldError) => error.message.includes("fixture-host") && error.message.includes(path));
  assert.deepEqual(await readFile(path), original);
  await lock.release();
}));

test("only replication commands and reconcile apply take the run lock", () => inTemp(async (dir) => {
  const { deps, store } = await fixture(dir);
  const calls: string[] = [];
  deps.acquireRunLock = async (id, command) => {
    assert.equal(id, deploymentId);
    calls.push(command);
    return { release: async () => { calls.push(`release ${command}`); } };
  };
  const identity = async () => ({
    organizationId: "fixture-org", userId: "fixture-user", username: "fixture-user", instanceUrl: "https://fixture.invalid",
  });
  const source = { identity, logout: async () => {}, listSourceIds: async function* () { yield ["account"]; } };
  deps.counts = { createStore: () => store, createSource: () => assert.fail("Expected store-only counts") };
  deps.objects = { configDir: () => dir, createSource: () => assert.fail("Expected a local object listing"), fallbackSource: () => "default" };
  deps.verify = { configDir: () => dir, validateConfig: () => {}, createSource: () => source };
  deps.reconcile = { configDir: () => dir, now, createSource: () => source, createStore: () => store };

  for (const command of ["metadata", "users", "records", "projections", "full"]) {
    assert.equal(await runCli([command], deps), 0);
  }
  for (const args of [
    ["counts", "--store-only"], ["objects", "list"], ["deployment", "init", "--id", deploymentId, "--name", deploymentId],
    ["deployment", "verify"], ["reconcile", "--entities", entity.key], ["reconcile", "--apply"],
  ]) {
    assert.equal(await runCli(args, deps), 0, args.join(" "));
  }
  assert.deepEqual(calls, ["metadata", "users", "records", "projections", "full", "reconcile --apply"]
    .flatMap((command) => [command, `release ${command}`]));
}));

test("a failed records stage releases its file and a retry succeeds", (t) => inTemp(async (dir, path) => {
  const { deps } = await fixture(dir);
  const source = new FakeSource();
  t.mock.method(source, "fetchChanges", async function* () { throw new Error("Fixture failure"); });
  t.mock.method(console, "error", () => {});
  assert.equal(await runCli(["records"], { ...deps, createSource: () => source }), 1);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.equal(await runCli(["records"], deps), 0);
}));

test("SIGINT and SIGTERM release before exiting 130 and success removes both handlers", (t) => inTemp(async (dir, path) => {
  const { deps } = await fixture(dir);
  const handlers = new Map<string, () => Promise<void>>();
  const exits: number[] = [];
  deps.onSignal = (signal, handler) => {
    handlers.set(signal, handler);
    return () => { handlers.delete(signal); };
  };
  deps.exit = (code) => { exits.push(code); };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const entered = latch();
    const resume = latch();
    const source = new FakeSource();
    t.mock.method(source, "fetchChanges", async function* () {
      entered.resolve();
      await resume.promise;
      throw new Error("Fixture interrupted");
    });
    const run = runCli(["records"], { ...deps, createSource: () => source });
    try {
      await entered.promise;
      assert.deepEqual([...handlers.keys()], ["SIGINT", "SIGTERM"]);
      await handlers.get(signal)!();
      await assert.rejects(stat(path), { code: "ENOENT" });
      assert.equal(exits.at(-1), 130);
      assert.equal(handlers.size, 0);
    } finally {
      resume.resolve();
    }
    assert.equal(await run, 130);
  }
  assert.equal(await runCli(["records"], deps), 0);
  assert.equal(handlers.size, 0);
  assert.deepEqual(exits, [130, 130]);
}));

test("interrupting reconcile apply releases the run and plan locks", () => inTemp(async (dir, path) => {
  const { deps, store } = await fixture(dir);
  const entered = latch();
  const resume = latch();
  let applying = false;
  let interrupt: (() => Promise<void>) | undefined;
  let exitCode: number | undefined;
  const source = {
    identity: async () => ({
      organizationId: "fixture-org", userId: "fixture-user", username: "fixture-user", instanceUrl: "https://fixture.invalid",
    }),
    logout: async () => {},
    async *listSourceIds() {
      if (applying) {
        entered.resolve();
        await resume.promise;
        throw new Error("Fixture interrupted");
      }
      yield ["account"];
    },
  };
  deps.verify = { configDir: () => dir, validateConfig: () => {}, createSource: () => source };
  deps.reconcile = { configDir: () => dir, now, createSource: () => source, createStore: () => store };
  deps.onSignal = (signal, handler) => {
    if (signal === "SIGINT") interrupt = handler;
    return () => { if (signal === "SIGINT") interrupt = undefined; };
  };
  deps.exit = (code) => { exitCode = code; };
  assert.equal(await runCli(["deployment", "verify"], deps), 0);
  assert.equal(await runCli(["reconcile", "--entities", entity.key], deps), 0);
  applying = true;
  const run = runCli(["reconcile", "--apply"], deps);
  const plan = join(dir, "reconcile", `${deploymentId}.json`);
  try {
    await entered.promise;
    assert.ok((await stat(`${plan}.lock`)).isFile());
    assert.ok(interrupt);
    await interrupt();
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(`${plan}.lock`), { code: "ENOENT" });
    assert.ok((await stat(plan)).isFile());
    assert.equal(exitCode, 130);
  } finally {
    resume.resolve();
  }
  assert.equal(await run, 130);
}));

test("waiting takes a released lock and times out with the dead-holder message", () => inTemp(async (_dir, path) => {
  let time = epoch;
  const clock = () => new Date(time);
  const first = await acquireLock(path, options);
  const next = await acquireLock(path, {
    ...options, now: clock, waitMs: 100, sleep: async (ms) => { time += ms; await first.release(); },
  });
  await assert.rejects(acquireLock(path, {
    ...options, now: clock, waitMs: 120, isProcessAlive: () => false, sleep: async (ms) => { time += ms; },
  }), /is no longer running/);
  assert.equal(time, epoch + 170);
  await next.release();
}));

test("unsafe deployment IDs are rejected before either lock path can be created", (t) => inTemp(async (dir) => {
  const { deps } = await fixture(dir);
  const stderr = t.mock.method(console, "error", () => {});
  assert.throws(() => runLockPath(dir, "../x"), /Unsafe deployment ID/);
  assert.throws(() => refreshLockPath(dir, "../x"), /Unsafe deployment ID/);
  assert.equal(await runCli(["users"], { ...deps, loadConfig: () => ({ ...config, deploymentId: "../x" }) }), 1);
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /Unsafe deployment ID/);
  assert.deepEqual(await readdir(dir), []);
}));
