import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli } from "../src/cli.js";
import { runLockPath } from "../src/cli-config-dir.js";
import { renderSchedule, scheduleScript } from "../src/console/schedule.js";
import type { CanonicalEntity, ChangeNotification, ChangeSubscription } from "../src/core/source.js";
import { LockHeldError } from "../src/locks/file-lock.js";
import { runScheduler, type SchedulerDeps } from "../src/scheduler/run.js";
import { defaults, scheduleUnits } from "../src/scheduler/schedule.js";
import { FileTokenStore } from "../src/sources/salesforce/auth/token-store.js";
import { SourceClient } from "../src/sources/salesforce/client.js";
import { streamChanges } from "../src/sources/salesforce/change-events.js";
import { PostgresReplicaStore } from "../src/stores/postgres/index.js";
import { FakeSource } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";

const key = "Opportunity";
const channel = "/data/OpportunityChangeEvent";
const epoch = Date.UTC(2026, 10, 24, 20, 48);
const handshake = { channel: "/meta/handshake", successful: true, clientId: "fixture-client", ext: { replay: true } };
const subscribed = { channel: "/meta/subscribe", successful: true };
const connected = { channel: "/meta/connect", successful: true };
const message = (changeType = "UPDATE", replayId = 42) => ({
  channel, data: { event: { replayId }, payload: { ChangeEventHeader: { changeType, recordIds: ["fixture-record"] } } },
});
const notification: ChangeNotification = { objectKey: key, kind: "update", recordIds: ["fixture-record"], position: "42" };
const oauth = { mode: "oauth", instanceUrl: "https://fixture.invalid", accessToken: "fixture-access" } as const;

function adapter(replies: Array<object[] | number>, position: string | null = null) {
  const wire: Record<string, unknown>[] = [];
  const tokens: Array<string | null> = [];
  const cookies: Array<string | null> = [];
  const connections: boolean[] = [];
  let refreshes = 0;
  const source = new SourceClient(oauth, {
    fetch: async (url, init) => {
      assert.match(String(url), /^https:\/\/fixture\.invalid\/cometd\//);
      wire.push(JSON.parse(String(init?.body))[0]);
      const headers = new Headers(init?.headers);
      tokens.push(headers.get("Authorization"));
      cookies.push(headers.get("Cookie"));
      const reply = replies.shift();
      assert.ok(reply);
      if (typeof reply === "number") return new Response(null, { status: reply });
      const response = Response.json(reply);
      if (reply.includes(handshake)) {
        response.headers.append("Set-Cookie", "BAYEUX_BROWSER=fixture-session; Path=/cometd; Secure");
        response.headers.append("Set-Cookie", "unused=fixture-private; Path=/other; Secure");
      }
      return response;
    },
    refresh: async (access) => {
      assert.equal(access, "fixture-access");
      refreshes++;
      return { accessToken: "fixture-refreshed" };
    },
  });
  const changes = source.subscribeToChanges({ positions: new Map([[key, position]]), signal: new AbortController().signal,
    connectionChanged: async (state) => { connections.push(state); } });
  return { changes, wire, tokens, cookies, connections, refreshes: () => refreshes };
}

async function fixture(t: TestContext, selected = [key]) {
  const { db, prisma } = await database();
  t.after(() => db.close());
  const replica = new PostgresReplicaStore(prisma);
  await replica.ensureDeployment("fixture", "Fixture");
  const store = replica.schedule("fixture");
  await store.edit({ action: "set", fields: { events: selected.join(",") } }, selected, epoch);
  const stop = new AbortController();
  let now = epoch;
  const logs: string[] = [];
  const deps: SchedulerDeps = {
    signal: stop.signal, now: () => now, store, keys: async () => selected, random: () => 0,
    acquire: async () => ({ release: async () => {} }), perform: async () => {},
    log: (message) => logs.push(message),
    wait: async (ms) => {
      now += ms;
      if (now > epoch + 180_000) throw new Error("Fixture clock exceeded the test window: " + logs.join("\n"));
    },
    changes: { store, subscribe: async function* ({ signal, connectionChanged }) {
      await connectionChanged(true);
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } },
  };
  return { store, db, prisma, deps, stop, logs, advance: (ms: number) => { now += ms; },
    status: () => store.status(selected, now, true, false) };
}

test("handshake, subscribe and connect yield neutral records", async () => {
  const a = adapter([[handshake], [subscribed], [connected, message()]]);
  try {
    assert.deepEqual((await a.changes.next()).value, notification);
    assert.deepEqual(a.wire.map((frame) => frame.channel), ["/meta/handshake", "/meta/subscribe", "/meta/connect"]);
    assert.equal(a.wire[1]?.subscription, channel);
    assert.deepEqual(a.wire[1]?.ext, { replay: { [channel]: -1 } });
    assert.deepEqual(a.connections, [true]);
    assert.deepEqual(a.cookies, [null, "BAYEUX_BROWSER=fixture-session", "BAYEUX_BROWSER=fixture-session"]);
  } finally {
    await a.changes.return(undefined);
  }
});

test("position and pending work survive storage and are used for replay", async (t) => {
  const f = await fixture(t);
  await f.store.rememberChange(notification, epoch, 2_000);
  const state = (await f.store.changeStates())[0]!;
  assert.equal(state.position, "42");
  assert.equal(state.dueAt?.getTime(), epoch + 2_000);
  const a = adapter([[handshake], [subscribed], [connected, message("CREATE", 43)]], state.position);
  try {
    assert.equal((await a.changes.next()).value?.kind, "create");
    assert.deepEqual(a.wire[1]?.ext, { replay: { [channel]: 42 } });
  } finally {
    await a.changes.return(undefined);
  }
});

test("a rejected position resumes from new events and stores catch-up work", async (t) => {
  const f = await fixture(t);
  await f.store.rememberChange(notification, epoch, 2_000);
  const a = adapter([[handshake], [{ successful: false, error: "400::Invalid replay id" }], [subscribed]], "42");
  try {
    const result = await a.changes.next();
    assert.equal(result.done, false);
    const value = result.value;
    assert.deepEqual(value, { objectKey: key, recordIds: [], kind: "resume-unavailable", position: null });
    assert.deepEqual(a.wire[2]?.ext, { replay: { [channel]: -1 } });
    await f.store.rememberChange(value!, epoch + 10, 2_000);
    const state = (await f.store.changeStates())[0]!;
    assert.equal(state.position, null);
    assert.equal(state.catchUp, true);
    assert.equal(state.lastEventAt?.getTime(), epoch);
  } finally {
    await a.changes.return(undefined);
  }
});

test("gap events mark catch-up and keep their position", async (t) => {
  const f = await fixture(t);
  const a = adapter([[handshake], [subscribed], [connected, message("GAP_UPDATE")]]);
  try {
    const result = await a.changes.next();
    assert.equal(result.value?.kind, "catch-up");
    await f.store.rememberChange(result.value!, epoch, 2_000);
    assert.equal((await f.status()).events[0]?.catchUpPending, true);
    assert.equal((await f.store.changeStates())[0]?.position, "42");
  } finally {
    await a.changes.return(undefined);
  }
});

test("overflow events without record IDs still mark catch-up", async () => {
  const overflow = { channel, data: { event: { replayId: 43 }, payload: { ChangeEventHeader: { changeType: "OVERFLOW" } } } };
  const a = adapter([[handshake], [subscribed], [connected, overflow]]);
  try {
    assert.deepEqual((await a.changes.next()).value, { objectKey: key, recordIds: [], kind: "catch-up", position: "43" });
  } finally {
    await a.changes.return(undefined);
  }
});

test("unknown client triggers a new handshake and resumes the last position", async () => {
  const a = adapter([[handshake], [subscribed], [connected, message()],
    [{ channel: "/meta/connect", successful: false, error: "403::Unknown client" }],
    [handshake], [subscribed], [connected, message("DELETE", 43)]]);
  try {
    await a.changes.next();
    assert.equal((await a.changes.next()).value?.kind, "delete");
    assert.deepEqual(a.wire[5]?.ext, { replay: { [channel]: 42 } });
    assert.deepEqual(a.connections, [true, false, true]);
  } finally {
    await a.changes.return(undefined);
  }
});

test("401 refreshes once and retries with the refreshed OAuth token", async () => {
  const a = adapter([401, [handshake], [subscribed], [connected, message()]]);
  try {
    assert.equal((await a.changes.next()).value?.position, "42");
    assert.equal(a.refreshes(), 1);
    assert.deepEqual(a.tokens, ["Bearer fixture-access", ...Array(3).fill("Bearer fixture-refreshed")]);
  } finally {
    await a.changes.return(undefined);
  }
  const expired = { channel: "/meta/connect", successful: false, error: "401::Authentication invalid" };
  const session = adapter([[handshake], [subscribed], [expired], [connected, message()]]);
  try {
    assert.equal((await session.changes.next()).value?.position, "42");
    assert.equal(session.refreshes(), 1);
  } finally {
    await session.changes.return(undefined);
  }
  const denied = adapter([401, 401]);
  await assert.rejects(denied.changes.next(), /Change event request failed/);
  assert.equal(denied.refreshes(), 1);
});

test("server advice controls reconnect delay and connects to a custom object channel", async () => {
  const waits: number[] = [];
  const wire: Array<Record<string, unknown>> = [];
  const replies = [[{ ...handshake, advice: { interval: 25 } }], [subscribed],
    [{ ...connected, advice: { reconnect: "none" as const } }, { ...message(), channel: "/data/ns__Invoice__ChangeEvent" }]];
  const changes = streamChanges({ positions: new Map([["ns__Invoice__c", null]]), signal: new AbortController().signal,
    connectionChanged: async () => {} }, async (request) => {
    wire.push(request as Record<string, unknown>);
    return replies.shift()!;
  }, async (ms) => { waits.push(ms); });
  assert.equal((await changes.next()).value?.objectKey, "ns__Invoice__c");
  assert.equal(wire[1]?.subscription, "/data/ns__Invoice__ChangeEvent");
  assert.deepEqual(waits, [25]);
  await assert.rejects(changes.next(), /connection was closed/);
});

test("several notifications debounce into one inbound sync per object and preserve scheduled polling", async (t) => {
  const f = await fixture(t, ["Contact", key]);
  await f.store.rememberChange(notification, epoch, 2_000);
  await f.store.rememberChange({ ...notification, position: "43" }, epoch + 500, 2_000);
  await f.store.rememberChange({ ...notification, objectKey: "Contact" }, epoch + 1_000, 2_000);
  const applied: Array<[string, number]> = [];
  await runScheduler({ ...f.deps, perform: async (unit) => {
    applied.push([unit.id, f.deps.now!() - epoch]);
    if (unit.id === "event:Contact") f.stop.abort();
  } });
  assert.deepEqual(applied.filter(([id]) => id.startsWith("event:")), [["event:Opportunity", 2500], ["event:Contact", 3000]]);
  assert.ok(applied.some(([id]) => id.startsWith("inbound:")));
  assert.ok((await f.store.changeStates()).every((state) => state.dueAt === null));
});

test("event catch-up skips a held run lock and retries under the lock", async (t) => {
  const f = await fixture(t);
  await f.store.rememberChange({ ...notification, kind: "catch-up" }, epoch, 2_000);
  let attempts = 0;
  let locked = false;
  let ranAt = -1;
  let lockedAtRun = false;
  await runScheduler({ ...f.deps,
    acquire: async (unit) => {
      if (unit.id.startsWith("event:") && ++attempts === 1) throw new LockHeldError("fixture", undefined, "held");
      locked = true;
      return { release: async () => { locked = false; } };
    },
    perform: async (unit) => {
      if (unit.id.startsWith("event:")) {
        lockedAtRun = locked;
        ranAt = f.deps.now!() - epoch;
        f.stop.abort();
      }
    },
  });
  assert.equal(attempts, 2);
  assert.equal(ranAt, 4_000);
  assert.equal(lockedAtRun, true);
  assert.equal(locked, false);
  assert.equal((await f.status()).events[0]?.catchUpPolls, 1);
});

test("work completing an older generation does not clear a newly arrived notification", async (t) => {
  const f = await fixture(t);
  await f.store.rememberChange(notification, epoch, 2_000);
  const first = (await f.store.changeStates())[0]!;
  await f.store.rememberChange({ ...notification, kind: "catch-up", position: "43" }, epoch + 2_000, 2_000);
  await f.store.finishChange(first);
  const latest = (await f.store.changeStates())[0]!;
  assert.equal(latest.position, "43");
  assert.equal(latest.catchUp, true);
  assert.equal(latest.dueAt?.getTime(), epoch + 4_000);
});

test("schedule refuses an object missing from Salesforce Setup and supports setting and clearing events", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "replcrm-events-"));
  try {
    const tokens = new FileTokenStore(dir);
    await tokens.save("fixture", { ...oauth, refreshToken: "fixture-refresh", loginUrl: "https://login.salesforce.com",
      clientId: "fixture-client", issuedAt: new Date(epoch).toISOString() });
    let records: Array<{ SelectedEntity: string }> = [];
    const deps = createProductionDeps({ DEPLOYMENT_ID: "fixture", SYNC_ENTITIES: key, SF_CLIENT_ID: "fixture-client",
      REPLCRM_CONFIG_DIR: dir, SF_AUTH_MODE: "oauth" }, { prisma: () => f.prisma, now: () => new Date(epoch),
      fetch: async (url) => {
        assert.match(decodeURIComponent(String(url)), /SelectedEntity IN \('OpportunityChangeEvent'\)/);
        return Response.json({ records });
      } });
    const service = await deps.scheduleService!({ ...await deps.loadConfig(), entityKeys: [key] });
    await service.edit({ action: "clear", fields: { events: key } });
    await assert.rejects(service.edit({ action: "set", fields: { events: key } }), /Opportunity.*Salesforce Setup → Change Data Capture/);
    assert.equal((await service.status()).events[0]?.enabled, false);
    const out = t.mock.method(console, "log", () => {});
    records = [{ SelectedEntity: "OpportunityChangeEvent" }];
    assert.equal(await runCli(["schedule", "set", "--events", key], deps), 0);
    assert.equal((await service.status()).events[0]?.enabled, true);
    assert.equal(await runCli(["schedule", "clear", "--events", key], deps), 0);
    assert.equal((await service.status()).events[0]?.enabled, false);
    assert.equal(out.mock.callCount(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscription failure backs off and continues scheduled polling without exposing errors", async (t) => {
  const f = await fixture(t);
  await f.store.edit({ action: "set", fields: { budget: "100" } }, [key], epoch);
  await f.store.edit({ action: "set", fields: { inbound: "1m" } }, [key], epoch);
  const attempts: number[] = [];
  const polls: number[] = [];
  await runScheduler({ ...f.deps, changes: { store: f.store, subscribe: async function* () {
    attempts.push(f.deps.now!() - epoch);
    if (attempts.length === 8) f.stop.abort();
    throw new Error("fixture-access");
  } }, perform: async (unit) => {
    if (unit.kind === "inbound") polls.push(f.deps.now!() - epoch);
  } });
  assert.equal(attempts.length, 8);
  const delays = [1, 2, 4, 8, 16, 32, 60];
  assert.deepEqual(f.logs.map((log) => Number(/Retrying in (\d+)s/.exec(log)?.[1])), delays);
  for (const [index, delay] of delays.entries()) {
    assert.ok(attempts[index + 1]! - attempts[index]! >= delay * 1_000);
  }
  assert.deepEqual(polls, [0, 60000, 120000]);
  assert.match(f.logs.join(), /Scheduled polls continue/);
  assert.doesNotMatch(f.logs.join() + JSON.stringify(await f.status()), /fixture-access|fixture-refresh/);
});

test("the scheduler ingests notifications and restores the persisted position on retry", async (t) => {
  const f = await fixture(t);
  const positions: Array<string | null | undefined> = [];
  await runScheduler({ ...f.deps, changes: { store: f.store, subscribe: async function* (request) {
    positions.push(request.positions.get(key));
    if (positions.length === 2) {
      f.stop.abort();
      return;
    }
    await request.connectionChanged(true);
    yield notification;
  } } });
  assert.deepEqual(positions, [null, "42"]);
  assert.equal((await f.status()).events[0]?.lastEventAt, new Date(epoch).toISOString());
});

test("schedule shows friendly time, unit names, object rows and a warning meter", async (t) => {
  const f = await fixture(t, ["Contact", key]);
  const unit = scheduleUnits(defaults, ["Contact", key])[0]!;
  await f.store.heartbeat(epoch);
  await f.store.record(unit, { intervalMs: unit.intervalMs, last: epoch - 120_000, next: epoch + 240_000, failures: 0 },
    { now: epoch, usage: { calls: 350, used: 650, dailyLimit: 1_000 } });
  const html = renderSchedule(await f.status(), (value) => value, epoch);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ""), /\d{4}-\d\d-\d\dT\d\d:/);
  assert.match(html, /<time datetime="[^"]+" title="2026-11-24 20:46 UTC">2 min ago<small>2026-11-24 20:46 UTC<\/small><\/time>/);
  assert.match(html, /Salesforce → replica/);
  assert.match(html, /Replica → Salesforce \(write-back\)/);
  assert.match(html, /Field definitions/);
  for (const object of ["Contact", key]) assert.match(html, new RegExp('data-object="' + object + '"'));
  assert.match(html, /id="schedule-budget" class="tone-warn"/);
  assert.match(html, /650 \/ 1000 API calls used.*Over budget/);
  assert.doesNotThrow(() => new Function(scheduleScript("fixture-console", "fixture")));
});

test("run CLI sends live work through incremental records and refreshes the existing projection", async (t) => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "replcrm-live-run-"));
  try {
    const stop = new AbortController();
    let onStop: (() => Promise<void>) | undefined;
    const definitions: CanonicalEntity = { key, label: key, pluralLabel: "Opportunities",
      attributes: [{ key: "Name", label: "Name", dataType: "Text" }] };
    const checkpoints: Array<string | null | undefined> = [];
    const inodes: string[] = [];
    class Source extends FakeSource {
      override async describeEntity() { return definitions; }
      override async *fetchChanges(_entity?: CanonicalEntity, checkpoint?: string | null) {
        checkpoints.push(checkpoint);
        try {
          await stat(runLockPath(dir, "fixture"));
          if (checkpoint) {
            const prior = await f.db.query<{ oid: string }>("SELECT 'replica.opportunity'::regclass::oid::text AS oid");
            inodes.push(prior.rows[0]!.oid);
          }
          yield { records: [{ sourceId: "fixture-record", fields: { Name: checkpoint ? "Updated" : "Initial" } }],
            nextCheckpoint: checkpoint ? "second" : "first" };
        } finally {
          if (checkpoint) {
            stop.abort();
            await onStop?.();
          }
        }
      }
      async *subscribeToChanges({ signal, connectionChanged }: ChangeSubscription) {
        await connectionChanged(true);
        yield notification;
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    }
    const deps = createProductionDeps({ DEPLOYMENT_ID: "fixture", SYNC_ENTITIES: key, REPLCRM_CONFIG_DIR: dir },
      { prisma: () => f.prisma, now: () => new Date(f.deps.now!()) });
    const code = await runCli(["run"], {
      ...deps, close: async () => {}, createSource: () => new Source(),
      loadConfig: async () => ({ ...await deps.loadConfig(), buildWideViews: true }),
      scheduleRuntime: async (config) => ({ ...await deps.scheduleRuntime!(config), wait: f.deps.wait }),
      onSignal: (signal, handler) => {
        if (signal === "SIGINT") onStop = handler;
        return () => {};
      },
    });
    assert.equal(code, 130);
    assert.equal(stop.signal.aborted, true);
    assert.deepEqual(checkpoints, [null, "first"]);
    const current = await f.db.query<{ oid: string; name: string }>(
      "SELECT 'replica.opportunity'::regclass::oid::text AS oid, name FROM replica.opportunity");
    assert.deepEqual(current.rows, [{ oid: inodes[0], name: "Updated" }]);
    await assert.rejects(stat(runLockPath(dir, "fixture")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the core source contract contains no adapter protocol or source terminology", async () => {
  for (const name of await readdir("src/core")) {
    const contents = await readFile(join("src/core", name), "utf8");
    assert.doesNotMatch(contents, /\.Id\b|\bIsDeleted\b/);
    assert.doesNotMatch(contents,
      /Salesforce|SOQL|SystemModstamp|queryAll\(|picklist|__c|moat|CometD|Change Data Capture/i);
  }
});
