import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionDeps, runCli, type CliDeps } from "../src/cli.js";
import { createConsoleHandler } from "../src/console/handler.js";
import type { ConsoleListener } from "../src/console/listener.js";
import { buildStatus, type StatusSource } from "../src/console/status.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { config, entity } from "./helpers/cli-fixture.js";
import { database } from "./helpers/database.js";

const port = 4999;
const headers = { host: `127.0.0.1:${port}` };
const client: StatusSource = {
  listEntities: async () => ["Account", "Contact"],
  countRecords: async () => 1,
};

function pageHandler(store: InMemoryReplicaStore, source = client, entities = ["Account", "Contact"]) {
  return createConsoleHandler({ port, buildStatus: () => buildStatus(config, { entities }, store, source) });
}

async function seededStore() {
  const store = new InMemoryReplicaStore();
  await store.persistMetadata(config.deploymentId, [entity]);
  const run = await store.beginRun(config.deploymentId, entity.key);
  const counts = await store.persistRecords(config.deploymentId, entity, {
    records: [{ sourceId: "active", fields: {} }], nextCheckpoint: null,
  });
  await store.completeRuns([{ id: run.id, result: { ...counts, checkpoint: null } }]);
  return store;
}

test("GET / renders each selected object with sync metrics, counts and comparison", async () => {
  const result = await pageHandler(await seededStore())("GET", "/", headers);
  assert.equal(result.status, 200);
  assert.match(result.headers["Content-Type"] ?? "", /^text\/html/);
  assert.ok(result.body.includes(config.deploymentId));
  const account = result.body.match(/<tr><th scope="row">Account<\/th>[\s\S]*?<\/tr>/)?.[0] ?? "";
  const contact = result.body.match(/<tr><th scope="row">Contact<\/th>[\s\S]*?<\/tr>/)?.[0] ?? "";
  const numbers = (row: string) => [...row.matchAll(/<td class="number">(.*?)<\/td>/g)].map((cell) => cell[1]);
  // In your database, in Salesforce, then the last sync's new, updated and deleted counts.
  assert.deepEqual(numbers(account), ["1", "1", "1", "0", "0"]);
  assert.deepEqual(numbers(contact), ["0", "1", "—", "—", "—"]);
  assert.match(account, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.match(account, />MATCH<[\s\S]*data-status="Succeeded"/);
  assert.match(contact, />Off by 1</);
  assert.match(result.body, /No recent problems/);
});

test("GET / escapes object names and persisted failures", async () => {
  const store = new InMemoryReplicaStore();
  const name = "<script> & \"object\"";
  const run = await store.beginRun(config.deploymentId, name);
  await store.failRun(run.id, "Failure <script>alert('test')</script>");
  const { body } = await pageHandler(store, client, [name])("GET", "/", headers);
  assert.ok(body.includes("&lt;script&gt; &amp; &quot;object&quot;"));
  assert.ok(body.includes("Failure &lt;script&gt;alert(&#39;test&#39;)&lt;/script&gt;"));
  assert.match(body, /data-status="Failed"/);
  assert.doesNotMatch(body, /<script>/);
});

test("the page uses a fresh matching nonce and same-origin polling", async () => {
  const handler = pageHandler(new InMemoryReplicaStore());
  const first = await handler("GET", "/", headers);
  const second = await handler("GET", "/", headers);
  const csp = first.headers["Content-Security-Policy"] ?? "";
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.ok(csp.includes(`style-src 'nonce-${nonce}'`));
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("connect-src 'self'"));
  assert.ok(first.body.includes(`<script nonce="${nonce}">`));
  assert.ok(first.body.includes(`<style nonce="${nonce}">`));
  assert.notEqual(second.headers["Content-Security-Policy"], csp);
  assert.equal(first.headers["X-Frame-Options"], "DENY");
  assert.doesNotMatch(first.body, /https?:\/\/|\b(?:src|href)="\/\//);
  assert.ok(first.body.includes('fetch("/api/status?deployment=" + encodeURIComponent(id) + (refresh ? "&refresh=1" : ""))'));
  assert.ok(first.body.includes("setInterval(() => update(false), 15000)"));
});

test("Salesforce failure leaves store counts visible and shows the reason", async () => {
  const unavailable = { ...client, countRecords: async () => { throw new Error("Count request failed"); } };
  const result = await pageHandler(await seededStore(), unavailable)("GET", "/", headers);
  assert.equal(result.status, 200);
  assert.match(result.body, />Unreachable</);
  assert.match(result.body, /Count request failed/);
  assert.match(result.body, /<td class="number">1<\/td><td class="number">—<\/td>\s*<td><span class="check muted">Not compared</);
});

function fakeListener(t: TestContext, events: string[] = []) {
  const stdout = t.mock.method(console, "log", () => {});
  let ready!: (args: Parameters<ConsoleListener>) => void;
  const started = new Promise<Parameters<ConsoleListener>>((resolve) => { ready = resolve; });
  let interrupt: (() => Promise<void>) | undefined;
  const deps = {
    listenConsole: async (...args: Parameters<ConsoleListener>) => {
      ready(args);
      return { close: async () => { events.push("listener"); } };
    },
    onSignal: (signal, handler) => {
      assert.equal(signal, "SIGINT");
      interrupt = handler;
      return () => { events.push("signal"); };
    },
  } satisfies Partial<CliDeps>;
  return {
    deps, started, stdout,
    stop: async () => {
      assert.ok(interrupt);
      await interrupt();
    },
  };
}

test("console --port wires the loopback listener and the status API", async (t) => {
  const fake = fakeListener(t);
  const production = createProductionDeps({ DEPLOYMENT_ID: config.deploymentId, DATABASE_URL: "fixture-db",
    REPLCRM_CONSOLE_PORT: "5555" });
  const handler = pageHandler(new InMemoryReplicaStore());
  const running = runCli(["console", "--port", String(port)], {
    ...production, ...fake.deps, createConsoleHandler: (selectedPort) => {
      assert.equal(selectedPort, port);
      return handler;
    },
  });
  try {
    const [host, selectedPort, serve] = await fake.started;
    assert.equal(host, "127.0.0.1");
    assert.equal(selectedPort, port);
    const response = await serve("GET", "/api/status", headers);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).deploymentId, config.deploymentId);
    assert.equal(fake.stdout.mock.calls[0]?.arguments[0], "ReplCRM console: http://127.0.0.1:4999");
  } finally {
    await fake.stop();
    assert.equal(await running, 0);
  }
});

test("production console starts in setup mode without DATABASE_URL", async (t) => {
  t.mock.method(console, "error", () => {});
  const dir = await mkdtemp(join(tmpdir(), "replcrm-setup-"));
  try {
    const deps = createProductionDeps({ REPLCRM_CONFIG_DIR: dir });
    let served = "";
    const code = await runCli(["console"], {
      ...deps,
      listenConsole: async (_host, port, handler) => {
        served = (await handler("GET", "/", { host: `127.0.0.1:${port}` })).body;
        throw new Error("stop after the first page");
      },
    });
    assert.equal(code, 1);
    assert.match(served, /<title>Add a replica/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production console can serve status without Salesforce and uses the configured port", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "replcrm-page-"));
  try {
    const { db, prisma } = await database();
    try {
      const production = createProductionDeps({
        DEPLOYMENT_ID: config.deploymentId, DATABASE_URL: "fixture-db", REPLCRM_CONFIG_DIR: dir,
        REPLCRM_CONSOLE_PORT: String(port), SYNC_ENTITIES: "Account",
      }, { prisma: () => prisma });
      const fake = fakeListener(t);
      const running = runCli(["console"], { ...production, ...fake.deps });
      try {
        const [, selectedPort, serve] = await fake.started;
        assert.equal(selectedPort, port);
        const response = await serve("GET", "/api/status", headers);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).salesforce.state, "not-configured");
      } finally {
        await fake.stop();
        assert.equal(await running, 0);
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGINT closes the listener and store and returns 0", async (t) => {
  const events: string[] = [];
  const fake = fakeListener(t, events);
  const running = runCli(["console"], {
    ...createProductionDeps({ DEPLOYMENT_ID: config.deploymentId, DATABASE_URL: "fixture-db" }),
    ...fake.deps,
    close: async () => { events.push("store"); },
  });
  const [, selectedPort] = await fake.started;
  assert.equal(selectedPort, 4780);
  assert.deepEqual(events, []);
  await fake.stop();
  assert.equal(await running, 0);
  assert.deepEqual(events, ["listener", "signal", "store"]);
});
