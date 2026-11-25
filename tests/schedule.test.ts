import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import { runScheduledDeployment } from "../src/cli-run.js";
import { runLockPath, schedulerLockPath } from "../src/cli-config-dir.js";
import { createConsoleHandler } from "../src/console/handler.js";
import { processToken } from "../src/console/runs.js";
import type { ConsoleStatus } from "../src/console/status.js";
import { LockHeldError } from "../src/locks/file-lock.js";
import { runScheduler, type SchedulerDeps } from "../src/scheduler/run.js";
import { day, defaults, duration, editedSettings, scheduleUnits } from "../src/scheduler/schedule.js";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { FakeSource, config, entity } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";
import { account } from "./helpers/writeback.js";
import { submitChange } from "../src/writeback/index.js";
import type { SourceChangeResult, ValidatedChange } from "../src/core/source.js";

const { deploymentId } = config;
const keys = ["Opportunity", "Task"];
const epoch = Date.UTC(2026, 10, 24, 12);

async function fixture(t: TestContext, start = epoch) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const replica = new PostgresReplicaStore(prisma);
  await replica.ensureDeployment(deploymentId, deploymentId);
  const store = replica.schedule(deploymentId);
  let now = start;
  const stop = new AbortController();
  const events: string[] = [];
  const logs: string[] = [];
  const deps: SchedulerDeps = {
    store, signal: stop.signal, random: () => 0, now: () => now, keys: async () => keys,
    wait: async () => { stop.abort(); },
    log: (message) => logs.push(message),
    acquire: async (unit) => {
      events.push("lock " + unit.kind);
      return { release: async () => { events.push("release " + unit.kind); } };
    },
    perform: async (unit) => { events.push(unit.kind); },
  };
  const status = () => store.status(keys, now, true, false);
  return {
    db, prisma, replica, store, deps, stop, events, logs, status,
    advance: (ms: number) => { now += ms; },
    edit: (action: "set" | "clear" | "pause" | "resume", fields?: Record<string, unknown>) =>
      store.edit({ action, ...(fields && { fields }) }, keys, now),
  };
}

test("durations accept seconds, minutes and hours and enforce integer ranges", () => {
  assert.equal(duration("60s", 60_000), 60_000);
  assert.equal(duration("5m", 60_000), 300_000);
  assert.equal(duration("24h", 1_000), day);
  for (const input of ["59s", "0m", "2d", "1.5m", "999999h", "-1h", "10"]) {
    assert.throws(() => duration(input, 60_000), /Enter a duration/);
  }
  assert.throws(() => editedSettings(defaults, { action: "set", fields: { outbound: "0s" } }));
  assert.throws(() => editedSettings(defaults, { action: "set", fields: { object: "Task=5s" } }));
  assert.throws(() => editedSettings(defaults, { action: "set", fields: { budget: "101" } }));
});

test("defaults, edits and clears round-trip through deployment-scoped storage", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.status()).settings, defaults);
  await f.edit("set", { object: ["Opportunity=1m", "Task=30m"], metadata: "12h", budget: "90" });
  const saved = await f.replica.schedule(deploymentId).read();
  assert.deepEqual(saved.overrides, { Opportunity: 60_000, Task: 1_800_000 });
  assert.equal(saved.metadataMs, day / 2);
  await f.edit("clear", { object: "Opportunity" });
  assert.deepEqual((await f.status()).settings.overrides, { Task: 1_800_000 });
  await f.replica.ensureDeployment("separate", "separate");
  assert.deepEqual((await f.replica.schedule("separate").read()).overrides, {});
});

test("objects sharing an interval form one deterministic inbound unit", () => {
  const units = scheduleUnits({ ...defaults, overrides: { Task: 60_000, Contact: 60_000 } }, ["Task", "Opportunity", "Contact", "Task"]);
  assert.deepEqual(units.map(({ kind, keys, intervalMs }) => [kind, keys, intervalMs]), [
    ["inbound", ["Contact", "Task"], 60_000], ["inbound", ["Opportunity"], 300_000],
    ["outbound", [], 10_000], ["metadata", [], day],
  ]);
});

test("due units run in order with separate locks and publish last and next slots", async (t) => {
  const f = await fixture(t);
  await runScheduler(f.deps);
  assert.deepEqual(f.events, ["inbound", "outbound", "metadata"].flatMap((kind) => ["lock " + kind, kind, "release " + kind]));
  const status = await f.status();
  assert.equal(status.active, true);
  assert.equal(status.heartbeatAt, new Date(epoch).toISOString());
  for (const unit of status.units) {
    assert.equal(unit.last, new Date(epoch).toISOString());
    assert.equal(unit.next, new Date(epoch + unit.intervalMs).toISOString());
  }
});

test("held unit lock skips once and retries at its next slot", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  await runScheduler({
    ...f.deps,
    acquire: async (unit) => {
      if (unit.kind === "inbound" && attempts++ === 0) throw new LockHeldError("fixture", undefined, "held");
      return f.deps.acquire(unit);
    },
    wait: async (ms) => {
      f.advance(ms);
      if (f.deps.now!() > epoch + defaults.inboundMs) f.stop.abort();
    },
  });
  assert.equal(attempts, 2);
  assert.equal(f.logs.filter((message) => message.includes("skipped")).length, 1);
  assert.equal((await f.status()).units[0]?.last, new Date(epoch + defaults.inboundMs).toISOString());
});

test("injected signal finishes the current unit, releases locks and exits 130", async (t) => {
  const f = await fixture(t);
  const handlers = new Map<string, () => Promise<void>>();
  const code = await runScheduledDeployment({
    ...f.deps,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => { handlers.delete(signal); };
    },
    acquireScheduler: async () => ({ release: async () => { f.events.push("scheduler released"); } }),
    perform: async (unit) => {
      await handlers.get("SIGTERM")!();
      f.events.push(unit.kind + " finished");
    },
  });
  assert.equal(code, 130);
  assert.deepEqual(f.events, ["lock inbound", "inbound finished", "release inbound", "scheduler released"]);
  assert.equal(handlers.size, 0);
  assert.equal((await f.status()).heartbeatAt, null);
});

test("failed units double their retry delay and a success resets it", async (t) => {
  const f = await fixture(t);
  const attempts: number[] = [];
  await runScheduler({
    ...f.deps,
    perform: async (unit) => {
      if (unit.kind !== "outbound") return;
      attempts.push(f.deps.now!() - epoch);
      if (attempts.length === 5) f.stop.abort();
      if ([1, 2, 4].includes(attempts.length)) throw new Error("failed");
    },
    wait: async (ms) => f.advance(ms),
  });
  assert.deepEqual(attempts, [0, 1_000, 3_000, 13_000, 14_000]);
});

test("schedule edits reject projected API overages using recent measured runs", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(epoch);
  const [inbound] = scheduleUnits(defaults, keys);
  const unit = inbound!;
  const state = { intervalMs: unit.intervalMs, last: epoch, next: epoch, failures: 0 };
  await f.store.record(unit, state, { now: epoch - 8 * day, usage: { calls: 1, used: 1, dailyLimit: 100_000 } });
  await f.store.record(unit, state, { now: epoch, usage: { calls: 100, used: 100, dailyLimit: 100_000 } });
  await assert.rejects(f.edit("set", { inbound: "1m" }), /Projected 145443 API calls\/day exceeds the budget of 50000 calls\/day/);
  assert.equal((await f.status()).settings.inboundMs, defaults.inboundMs);
});

test("the cold-start projection estimates usage before the source reports a limit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.edit("set", { inbound: "1m" }), /Projected 12963 API calls\/day exceeds the budget of 7500 calls\/day/);
});

test("usage at the configured share slows inbound until the next UTC day", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(epoch);
  const outbound = scheduleUnits(defaults, keys).find(({ kind }) => kind === "outbound")!;
  await f.store.record(outbound, { intervalMs: outbound.intervalMs, last: epoch, next: epoch, failures: 0 },
    { now: epoch, usage: { calls: 1, used: 500, dailyLimit: 1000 } });
  await runScheduler(f.deps);
  assert.ok(!f.events.includes("inbound"));
  assert.ok(f.events.includes("outbound"));
  assert.match(f.logs.join(), /slowed until.*500\/1000/);
  assert.equal((await f.status()).units[0]?.next, "2026-11-25T00:00:00.000Z");
});

test("a source limit error pauses inbound and the UTC boundary releases it", async (t) => {
  const midnight = Date.UTC(2026, 10, 25);
  const f = await fixture(t, midnight - 2_000);
  const attempts: number[] = [];
  await runScheduler({
    ...f.deps,
    perform: async (unit, observe) => {
      if (unit.kind !== "inbound") return;
      attempts.push(f.deps.now!());
      if (attempts.length === 2) { f.stop.abort(); return; }
      observe({ calls: 1, limitExceeded: true });
      throw new Error("request limit");
    },
    wait: async (ms) => f.advance(ms),
  });
  assert.deepEqual(attempts, [midnight - 2_000, midnight]);
  assert.match(f.logs.join(), /Source API limit reached.*2026-11-25T00:00:00.000Z/);
});

test("pause leaves the heartbeat running and resume restores due work", async (t) => {
  const f = await fixture(t);
  await f.edit("pause");
  await runScheduler({
    ...f.deps,
    wait: async (ms) => {
      assert.deepEqual(f.events, []);
      assert.ok((await f.status()).units.every(({ next }) => next === null));
      f.advance(ms);
      await f.edit("resume");
    },
    perform: async (unit) => { f.events.push(unit.kind); f.stop.abort(); },
  });
  assert.deepEqual(f.events, ["lock inbound", "inbound", "release inbound"]);
});

test("console shows schedule and heartbeat and protects edits with Host and token checks", async (t) => {
  const f = await fixture(t);
  await f.store.heartbeat(epoch);
  const handler = createConsoleHandler({
    port: 4780, defaultDeployment: async () => deploymentId,
    buildStatus: async (): Promise<ConsoleStatus> => ({
      deploymentId, generatedAt: new Date(epoch).toISOString(), objects: [], errors: [],
      salesforce: { state: "not-configured" },
    }),
    schedule: async () => ({ status: f.status, edit: ({ action, fields }) => f.edit(action, fields) }),
  });
  const headers = { host: "localhost:4780" };
  const body = { action: "pause" };
  assert.equal((await handler("GET", "/", headers)).status, 200);
  const html = (await handler("GET", "/", headers)).body;
  assert.match(html, /<h2 id="schedule-title">Schedule<\/h2>/);
  assert.match(html, /2026-11-24T12:00:00.000Z/);
  assert.equal((await handler("POST", "/api/schedule", headers, body)).status, 403);
  assert.equal((await handler("POST", "/api/schedule", { host: "fixture.invalid" }, body)).status, 400);
  assert.equal((await handler("POST", "/api/schedule", { ...headers, "x-replcrm-token": processToken }, body)).status, 200);
  const status = await handler("GET", "/api/status", headers);
  assert.equal(JSON.parse(status.body).schedule.settings.paused, true);
  assert.ok(!status.body.includes(processToken));
});

test("the adapter reports header usage, request counts and source limit errors", async () => {
  let calls = 0;
  const source = new SourceClient({ mode: "oauth", instanceUrl: "https://fixture.invalid", accessToken: "fixture-access" }, {
    fetch: async () => {
      const headers = { "sforce-limit-info": "api-usage=" + (31 + calls) + "/100", "content-type": "application/json" };
      if (calls++ === 0) return new Response(JSON.stringify({ done: true, records: [], totalSize: 0 }), { headers });
      return new Response(JSON.stringify([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "Daily limit reached" }]), { status: 403, headers });
    },
  });
  await source.queryPage("fixture query", false);
  assert.deepEqual(source.apiUsage(), { calls: 1, used: 31, dailyLimit: 100 });
  await assert.rejects(source.queryPage("fixture query", false), /Daily limit reached/);
  assert.deepEqual(source.apiUsage(), { calls: 2, used: 32, dailyLimit: 100, limitExceeded: true });
});

test("scheduled failures redact credentials in logs and persist only usage numbers in schedule JSON", async (t) => {
  const f = await fixture(t);
  await runScheduler({
    ...f.deps,
    perform: async () => { throw new Error("failed Authorization: Bearer fixture-access\npassword=fixture-secret"); },
  });
  const output = f.logs.join() + JSON.stringify(await f.status());
  assert.match(output, /failed/);
  assert.doesNotMatch(output, /fixture-access|fixture-secret/);
});

test("run CLI drives the existing record stage and drains held locks on injected interruption", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "replcrm-schedule-"));
  try {
    const signals = new Map<string, () => Promise<void>>();
    class Source extends FakeSource {
      override async *fetchChanges() {
        await stat(runLockPath(dir, deploymentId));
        await stat(schedulerLockPath(dir, deploymentId));
        await signals.get("SIGINT")!();
        yield* super.fetchChanges();
      }
    }
    const deps = createProductionDeps({
      DEPLOYMENT_ID: deploymentId, REPLCRM_CONFIG_DIR: dir, SYNC_ENTITIES: entity.key,
    }, { prisma: () => f.prisma, now: () => new Date(epoch) });
    const code = await runCli(["run"], {
      ...deps,
      loadConfig: () => ({ ...config, entityKeys: [entity.key], buildWideViews: true }),
      createSource: () => new Source(),
      close: async () => {},
      onSignal: (signal, handler) => { signals.set(signal, handler); return () => { signals.delete(signal); }; },
    });
    assert.equal(code, 130);
    assert.equal(signals.size, 0);
    assert.equal((await f.replica.listReplicaViews(deploymentId)).length, 1);
    await assert.rejects(stat(runLockPath(dir, deploymentId)), { code: "ENOENT" });
    await assert.rejects(stat(schedulerLockPath(dir, deploymentId)), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a change queue watch retries after contention with an active scheduler unit", async (t) => {
  const f = await fixture(t);
  const { processQueue } = await import("../src/writeback/queue.js");
  let attempts = 0;
  await processQueue({
    store: f.replica, deploymentId, signal: f.stop.signal, intervalMs: 10_000,
    acquire: async () => {
      if (++attempts === 1) throw new LockHeldError("fixture", {
        pid: 1, hostname: "fixture", command: "run inbound", startedAt: new Date(epoch).toISOString(), ownerToken: "fixture-owner",
      }, "held", true);
      return { release: async () => { f.events.push("released"); } };
    },
    processor: async () => assert.fail("Empty polls need no source"),
    wait: async (ms) => {
      assert.equal(ms, 10_000);
      if (attempts === 2) f.stop.abort();
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(f.events, ["released"]);
});

test("scheduled outbound dispatches queued changes through write-back and records usage", async (t) => {
  const f = await fixture(t);
  await f.replica.persistMetadata(deploymentId, [account]);
  await f.replica.editWritebackPolicy(deploymentId, account.key, { action: "enable" });
  const request = await submitChange(f.replica, {
    deploymentId, entityKey: account.key, operation: "create", fields: { Name: { value: "Scheduled" } },
    authorKind: "person", authorLabel: "Fixture",
  });
  const dir = await mkdtemp(join(tmpdir(), "replcrm-outbound-"));
  try {
    const configForRun = { ...config, entityKeys: [account.key], buildWideViews: false };
    const deps = createProductionDeps({
      DEPLOYMENT_ID: deploymentId, REPLCRM_CONFIG_DIR: dir, SYNC_ENTITIES: account.key,
    }, { prisma: () => f.prisma, now: () => new Date(epoch) });
    let stop!: () => Promise<void>;
    let sent = 0;
    class Writer extends FakeSource {
      override async describeEntity() { return account; }
      apiUsage() { return { calls: sent, used: 28, dailyLimit: 10_000 }; }
      async applyChange(change: ValidatedChange): Promise<SourceChangeResult> {
        assert.equal(change.fields.Name?.value, "Scheduled");
        assert.equal(change.operation, "create");
        sent++;
        await stop();
        return { status: "applied", sourceId: "fixture-created", modifiedAt: null,
          record: { sourceId: "fixture-created", fields: { Name: "Scheduled" } } };
      }
    }
    const code = await runCli(["run"], {
      ...deps, loadConfig: () => configForRun, createSource: () => new Writer(), close: async () => {},
      onSignal: (signal, handler) => {
        if (signal === "SIGTERM") stop = handler;
        return () => {};
      },
    });
    assert.equal(code, 130);
    assert.equal(sent, 1);
    assert.equal((await f.replica.getChangeRequest(deploymentId, request.id))?.status, "applied");
    assert.deepEqual((await f.db.query('SELECT calls, used FROM "ScheduledRun" WHERE unit = \'outbound\'')).rows,
      [{ calls: 1, used: 28 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
