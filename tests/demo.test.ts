import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { demoBanner, startDemo, type Demo } from "../src/demo/console.js";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function withDemo(run: (demo: Demo, call: (path: string, init?: RequestInit) => Promise<Response>) => Promise<void>): Promise<void> {
  const demo = await startDemo({ port: await freePort() });
  try {
    await run(demo, (path, init) => fetch(demo.url + path, init));
  } finally {
    await demo.close();
  }
}

async function token(call: (path: string) => Promise<Response>): Promise<string> {
  const page = await (await call("/")).text();
  const match = /"X-ReplCRM-Token": "([0-9a-f]{64})"/.exec(page);
  assert.ok(match, "console page carries its action token");
  return match[1]!;
}

async function runStage(call: (path: string, init?: RequestInit) => Promise<Response>, stage: string): Promise<void> {
  const response = await call("/api/runs?deployment=demo", {
    method: "POST", headers: { "Content-Type": "application/json", "X-ReplCRM-Token": await token(call) },
    body: JSON.stringify({ stage, deployment: "demo" }),
  });
  assert.equal(response.status, 202);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const current = await (await call("/api/runs/current?deployment=demo")).json() as { state: string };
    if (current.state === "succeeded") return;
    assert.notEqual(current.state, "failed", `${stage} run failed`);
    assert.ok(Date.now() < deadline, `${stage} run did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Row = { entityKey: string; storeCount: number; sourceCount: number; status: string };
async function objects(call: (path: string) => Promise<Response>): Promise<Record<string, Row>> {
  const status = await (await call("/api/status?refresh=1")).json() as { salesforce: { state: string }; objects: Row[] };
  assert.equal(status.salesforce.state, "ok");
  return Object.fromEntries(status.objects.map((row) => [row.entityKey, row]));
}

test("the demo opens on labeled fictional data with one object to reconcile", async () => {
  await withDemo(async (_demo, call) => {
    const page = await (await call("/")).text();
    assert.ok(page.includes(`<p class="console-notice" role="status">${demoBanner}</p>`), "every page shows the demo banner");
    const rows = await objects(call);
    assert.deepEqual(Object.keys(rows).sort(), ["Account", "Case", "Contact", "Opportunity"]);
    assert.ok(Object.values(rows).reduce((sum, row) => sum + row.sourceCount, 0) >= 180, "realistic volume");
    assert.equal(rows.Case?.status, "DIFF");
    assert.equal(rows.Case!.sourceCount - rows.Case!.storeCount, 3);
    for (const key of ["Account", "Contact", "Opportunity"]) assert.equal(rows[key]?.status, "MATCH");
  });
});

test("sync buttons run against the fictional org and reconcile the counts", async () => {
  await withDemo(async (_demo, call) => {
    await runStage(call, "records");
    const rows = await objects(call);
    for (const row of Object.values(rows)) assert.equal(row.status, "MATCH", row.entityKey);
    await runStage(call, "full");
    for (const row of Object.values(await objects(call))) assert.equal(row.status, "MATCH", row.entityKey);
  });
});

test("processing write-back applies, conflicts and rejects against the fictional org only", async () => {
  await withDemo(async (demo, call) => {
    await runStage(call, "changes");
    const { changes } = await (await call("/api/changes?deployment=demo")).json() as {
      changes: { entityKey: string; operation: string; status: string; authorLabel: string }[];
    };
    const outcome = (label: string, entityKey: string, operation = "update") =>
      changes.filter((change) => change.authorLabel === label && change.entityKey === entityKey && change.operation === operation)
        .map(({ status }) => status).sort();
    assert.deepEqual(outcome("pricing-agent", "Opportunity"), ["applied"]);
    assert.deepEqual(outcome("forecast-tool", "Opportunity"), ["rejected"]);
    assert.deepEqual(outcome("Dana (sales)", "Opportunity"), ["conflict", "unknown"]);
    assert.deepEqual(outcome("lead-agent", "Contact", "create"), ["applied"]);
    assert.deepEqual(outcome("enrichment-agent", "Contact"), ["failed"]);
    const created = demo.org.firstId("Contact", (fields) => fields.Name === "Priya Shah");
    assert.ok(created.startsWith("003DEMO"));
    assert.ok(demo.store.readRecords("demo", "Contact").some((record) => record.sourceId === created), "the replica refreshed the created record");
  });
});

test("setup and sign-in are explained instead of offered", async () => {
  await withDemo(async (_demo, call) => {
    const response = await call("/setup");
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Not available in the demo/);
    assert.match(page, /npm run console/);
    assert.ok(page.includes(demoBanner));
  });
});

test("the demo listens on loopback only", async () => {
  await withDemo(async (demo) => {
    const port = Number(new URL(demo.url).port);
    const external = Object.values(networkInterfaces()).flat()
      .find((address) => address && address.family === "IPv4" && !address.internal)?.address;
    if (!external) return;
    const socket = createConnection({ host: external, port });
    const [error] = await once(socket, "error") as [NodeJS.ErrnoException];
    assert.equal(error.code, "ECONNREFUSED");
  });
});

test("npm run demo ignores real configuration, loads no database or Salesforce module and cleans up", async () => {
  const buildRoot = process.env.REPLCRM_COMPILED_DIR;
  assert.ok(buildRoot, "Run this test through scripts/offline-suite.mjs");
  const loader = pathToFileURL(fileURLToPath(new URL("./helpers/demo-loader.mjs", import.meta.url))).href;
  const guard = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(loader)});`;
  const control = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", "await import('jsforce')"], { encoding: "utf8" });
  assert.match(control.stderr, /Demo import blocked: jsforce/, "the import guard is active");
  const temp = mkdtempSync(join(tmpdir(), "replcrm-demo-test-"));
  const realConfig = mkdtempSync(join(tmpdir(), "replcrm-demo-config-"));
  try {
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", guard, join(buildRoot, "demo/index.js"), "--port", String(port), "--no-open"], {
      env: {
        PATH: process.env.PATH ?? "", TMPDIR: temp, TEMP: temp, TMP: temp,
        DATABASE_URL: "postgresql://real:secret@db.example.invalid:5432/prod",
        REPLCRM_CONFIG_DIR: realConfig, DEPLOYMENT_ID: "production", SF_CLIENT_ID: "real-client", SF_PASSWORD: "real-password",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 15_000;
    while (!output.includes("ReplCRM demo console:")) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, `demo did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(readdirSync(temp).filter((name) => name.startsWith("replcrm-demo-")).length, 1, "a temporary config directory is in use");
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { deploymentId: string; salesforce: { state: string } };
    assert.deepEqual([status.deploymentId, status.salesforce.state], ["demo", "ok"]);
    child.kill("SIGINT");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /import blocked|secret|real-password|real-client|production/i);
    assert.deepEqual(readdirSync(temp), [], "the temporary config directory is removed");
    assert.deepEqual(readdirSync(realConfig), [], "the configured directory is never touched");
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(realConfig, { recursive: true, force: true });
  }
});
