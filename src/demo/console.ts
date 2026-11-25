// Compose the real console on an in-memory replica and a fictional org. Nothing here opens a database or a CRM connection.
import { createConsoleHandler } from "../console/handler.js";
import { listenForConsole } from "../console/listener.js";
import { createConsoleRuns } from "../console/runs.js";
import { buildStatus } from "../console/status.js";
import { createConsoleWriteback } from "../console/writeback.js";
import type { ScheduleService } from "../cli-schedule.js";
import type { ReplicationConfig } from "../core/config.js";
import { describeEntities, runMetadataStage, runRecordsStage, runReplication, runUsersStage, runWithSource, type OrchestratorDeps } from "../core/orchestrator.js";
import type { FileLock } from "../locks/file-lock.js";
import { editedSettings, defaults, projectedCalls, scheduleUnits, type Settings } from "../scheduler/schedule.js";
import type { ScheduleStatus } from "../stores/postgres/schedule.js";
import { InMemoryReplicaStore } from "../stores/memory/index.js";
import { ChangeRequestProcessor } from "../writeback/processor.js";
import { processBatch } from "../writeback/queue.js";
import type { ChangeTransition } from "../writeback/requests.js";
import { FakeOrg, demoEntities } from "./fake-org.js";

export const demoDeployment = "demo";
export const demoBanner = "Demo data: a fictional Salesforce org held in memory. Nothing is saved, nothing leaves this computer, and the scheduler does not run.";
const setupUnavailable = "Adding a replica and signing in to Salesforce are turned off in the demo. Stop the demo and run npm run console to connect a real org.";

export interface Demo {
  url: string;
  org: FakeOrg;
  store: InMemoryReplicaStore;
  close(): Promise<void>;
}

const keys = demoEntities.map(({ key }) => key);
const config: ReplicationConfig = { deploymentId: demoDeployment, batchSize: 50, entityKeys: keys, entityDenyKeys: [], buildWideViews: true };
const noLock = async (): Promise<FileLock> => ({ release: async () => {} });

async function seedChanges(store: InMemoryReplicaStore, org: FakeOrg): Promise<void> {
  for (const key of ["Opportunity", "Contact"]) await store.editWritebackPolicy(demoDeployment, key, { action: "enable" });
  const replicaId = async (entityKey: string, sourceId: string): Promise<string> => {
    const record = await store.findWritebackRecord(demoDeployment, entityKey, sourceId);
    if (!record) throw new Error(`Demo record ${sourceId} is missing`);
    return record.recordId;
  };
  const submit = async (entityKey: string, sourceId: string | null, fields: Record<string, { base?: unknown; value: unknown }>,
    author: ["person" | "app" | "agent", string], reason: string | null, outcome?: ChangeTransition) => {
    const request = await store.createChangeRequest({
      deploymentId: demoDeployment, entityKey, operation: sourceId ? "update" : "create",
      targetRecordId: sourceId ? await replicaId(entityKey, sourceId) : null, targetSourceId: sourceId,
      fields: fields as never, authorKind: author[0], authorLabel: author[1], reason, idempotencyKey: null,
    });
    if (!outcome) return;
    await store.transitionChangeRequest(demoDeployment, request.id, "pending", { status: "sending" });
    await store.transitionChangeRequest(demoDeployment, request.id, "sending", outcome);
  };
  // Simulated activity only touches Prospecting opportunities, so these outcomes stay predictable.
  const open = org.firstId("Opportunity", (fields) => fields.StageName === "Qualification");
  const other = org.firstId("Opportunity", (fields) => fields.StageName === "Negotiation");
  const contact = org.firstId("Contact");
  const amount = org.field("Opportunity", open, "Amount") as number;
  // Waiting in the queue: one that applies cleanly, one whose base is stale, one that breaks a validation rule.
  await submit("Opportunity", open, { Amount: { base: amount, value: amount + 12_000 } }, ["agent", "pricing-agent"], "Applied the 2027 price uplift");
  await submit("Opportunity", other, { StageName: { base: "Prospecting", value: "Closed Won" } }, ["person", "Dana (sales)"], "Signed contract received");
  await submit("Opportunity", open, { CloseDate: { base: org.field("Opportunity", open, "CloseDate") as string, value: "2025-01-15" } },
    ["app", "forecast-tool"], null);
  await submit("Contact", null, { FirstName: { value: "Priya" }, LastName: { value: "Shah" }, Email: { value: "priya.shah@example.com" } },
    ["agent", "lead-agent"], "New contact from the webinar list");
  // History that needs a person: a failure waiting to retry and an unknown outcome.
  await submit("Contact", contact, { Title: { base: org.field("Contact", contact, "Title") as string, value: "Chief Operating Officer" } },
    ["agent", "enrichment-agent"], "Title found in email signature",
    { status: "failed", statusDetail: "Salesforce REQUEST_LIMIT_EXCEEDED (simulated)", retryAfter: new Date(Date.now() + 5 * 60_000).toISOString() });
  await submit("Opportunity", other, { Amount: { base: org.field("Opportunity", other, "Amount") as number, value: 99_000 } },
    ["person", "Dana (sales)"], null,
    { status: "unknown", statusDetail: "The update was sent but the response was lost (simulated). Check the record before resubmitting." });
}

function scheduleService(org: FakeOrg): ScheduleService {
  let settings: Settings = { ...defaults, overrides: {} };
  return {
    async status(): Promise<ScheduleStatus> {
      const units = scheduleUnits(settings, keys);
      const dailyLimit = 15_000;
      return {
        settings, heartbeatAt: null, active: false, runningUnit: false,
        usage: { used: Math.min(org.apiCalls, dailyLimit), dailyLimit },
        budgetCalls: Math.floor(dailyLimit * settings.budget / 100),
        projectedCalls: projectedCalls(units, new Map(), keys.length), inboundPausedUntil: null,
        events: keys.map((objectKey) => ({ objectKey, enabled: settings.eventKeys.includes(objectKey), connected: false,
          lastEventAt: null, catchUpPending: false, catchUpPolls: 0 })),
        units: units.map((unit) => ({ ...unit, last: null, next: null })),
      };
    },
    async edit(edit) {
      settings = editedSettings(settings, edit);
    },
  };
}

/** `latencyMs` paces calls to the fictional org so the console's stage animation is visible during a sync. */
export async function startDemo({ port, now = () => new Date(), latencyMs = 350 }: { port: number; now?: () => Date; latencyMs?: number }): Promise<Demo> {
  const org = new FakeOrg(now().getTime());
  const store = new InMemoryReplicaStore();
  store.ensureDeployment(demoDeployment, "Demo org (fictional data)");
  const release = org.holdBack("Case", 3);
  const log = console.log;
  console.log = () => {};
  try {
    await runReplication({ store, config, sourceClient: org });
  } finally {
    console.log = log;
  }
  release();
  await seedChanges(store, org);
  org.latencyMs = latencyMs;

  const processor = async () => new ChangeRequestProcessor(store, org);
  const runs = createConsoleRuns({
    now,
    acquire: noLock,
    run: async (stage, signal) => {
      if (stage === "changes") {
        await processBatch({ store, deploymentId: demoDeployment, signal, processor });
        return;
      }
      console.log(`[replication] Starting ${stage} (demo org)`);
      org.simulateActivity();
      const replication: OrchestratorDeps = { store, config, sourceClient: org };
      await runWithSource(replication, async () => {
        if (stage === "full") {
          const definitions = await runMetadataStage(replication);
          await runUsersStage(replication);
          console.log("[replication] records");
          await runRecordsStage(replication, definitions);
        } else {
          const definitions = await describeEntities(org, keys);
          console.log("[replication] records");
          await runRecordsStage(replication, definitions);
        }
      });
      console.log(`Replication complete for deployment ${demoDeployment}.`);
    },
  });
  const writeback = createConsoleWriteback({
    deploymentId: demoDeployment, store, acquire: noLock, now,
    session: () => ({ processor, close: async () => {} }),
  });
  const schedule = scheduleService(org);
  const handler = createConsoleHandler({
    port, now, runs, runsFor: (id) => id === demoDeployment ? runs : undefined,
    defaultDeployment: async () => demoDeployment,
    listReplicas: async () => [{ id: demoDeployment, name: "Demo org (fictional data)", sourceUrl: null, isActive: true }],
    buildStatus: () => buildStatus(config, { entities: keys }, store, org),
    writeback: async () => writeback,
    schedule: async () => schedule,
    notice: { banner: demoBanner, setupUnavailable },
  });
  const listener = await listenForConsole("127.0.0.1", port, handler);
  return {
    url: `http://127.0.0.1:${port}`,
    org,
    store,
    close: async () => {
      await runs.shutdown();
      await listener.close();
    },
  };
}
