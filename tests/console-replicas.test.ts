import assert from "node:assert/strict";
import { test } from "node:test";
import { createConsoleHandler } from "../src/console/handler.js";
import { createConsoleRuns, processToken } from "../src/console/runs.js";
import { buildStatus, type StatusSource } from "../src/console/status.js";
import { InMemoryReplicaStore } from "../src/stores/memory/index.js";
import { config } from "./helpers/cli-fixture.js";

const port = 4999;
const headers = { host: `127.0.0.1:${port}` };
const source: StatusSource = { listEntities: async () => ["Account"], countRecords: async () => 0 };
const replicas = [
  { id: config.deploymentId, name: "Primary", sourceUrl: null, isActive: true },
  { id: "emea-sandbox", name: "EMEA sandbox", sourceUrl: "https://emea.example", isActive: true },
];

function fakeRuns() {
  const started: string[] = [];
  return {
    started,
    runs: createConsoleRuns({
      acquire: async () => ({ release: async () => {} }) as never,
      run: async (stage) => { started.push(stage); },
    }),
  };
}

function handler(overrides: Partial<Parameters<typeof createConsoleHandler>[0]> = {}, list = true) {
  const store = new InMemoryReplicaStore();
  const asked: (string | undefined)[] = [];
  const primary = fakeRuns();
  const emea = fakeRuns();
  const handle = createConsoleHandler({
    port,
    ...(list && { listReplicas: async () => replicas }),
    buildStatus: async (deploymentId) => {
      asked.push(deploymentId);
      return buildStatus({ ...config, deploymentId: deploymentId ?? config.deploymentId }, { entities: ["Account"] }, store, source);
    },
    runs: primary.runs,
    runsFor: (id) => (id === "emea-sandbox" ? emea.runs : id === config.deploymentId ? primary.runs : undefined),
    ...overrides,
  });
  return { handle, asked, primary, emea };
}

test("GET /api/replicas lists every deployment", async () => {
  const { handle } = handler();
  const result = await handle("GET", "/api/replicas", headers);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body).replicas.map((replica: { id: string }) => replica.id), [config.deploymentId, "emea-sandbox"]);
});

test("GET /api/replicas falls back to the default deployment without a store listing", async () => {
  const { handle } = handler({}, false);
  const result = await handle("GET", "/api/replicas", headers);
  assert.deepEqual(JSON.parse(result.body).replicas.map((replica: { id: string }) => replica.id), [config.deploymentId]);
});

test("status is read per deployment and cached separately", async () => {
  const { handle, asked } = handler();
  const emea = JSON.parse((await handle("GET", "/api/status?deployment=emea-sandbox", headers)).body);
  const primary = JSON.parse((await handle("GET", "/api/status", headers)).body);
  assert.equal(emea.deploymentId, "emea-sandbox");
  assert.equal(primary.deploymentId, config.deploymentId);
  await handle("GET", "/api/status?deployment=emea-sandbox", headers);
  assert.deepEqual(asked, ["emea-sandbox", undefined]);
});

test("unknown or malformed deployments are refused", async () => {
  const { handle, asked } = handler();
  assert.equal((await handle("GET", "/api/status?deployment=missing", headers)).status, 404);
  assert.equal((await handle("GET", "/api/status?deployment=../etc", headers)).status, 400);
  assert.equal((await handle("GET", "/?deployment=missing", headers)).status, 404);
  assert.deepEqual(asked, []);
});

test("a sync starts on the deployment named in the request", async () => {
  const { handle, primary, emea } = handler();
  const post = (body: unknown) => handle("POST", "/api/runs", { ...headers, "x-replcrm-token": processToken }, JSON.stringify(body));
  assert.equal((await post({ stage: "records", deployment: "emea-sandbox" })).status, 202);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(emea.started, ["records"]);
  assert.deepEqual(primary.started, []);
  assert.equal((await post({ stage: "records", deployment: "missing" })).status, 404);
  assert.equal((await post({ stage: "records", deployment: 7 })).status, 400);
  const progress = JSON.parse((await handle("GET", "/api/runs/current?deployment=emea-sandbox", headers)).body);
  assert.equal(progress.stage, "records");
});

test("the console serves its own font for the page's font-src 'self' policy", async () => {
  const { handle } = handler();
  const font = await handle("GET", "/assets/console-font.woff2", headers);
  assert.equal(font.status, 200);
  assert.equal(font.headers["Content-Type"], "font/woff2");
  assert.equal(font.bytes?.subarray(0, 4).toString("latin1"), "wOF2");
  const page = await handle("GET", "/", headers);
  assert.match(page.headers["Content-Security-Policy"] ?? "", /font-src 'self'/);
});
