import type { ScheduleService } from "../cli-schedule.js";
import { ScheduleInputError } from "../scheduler/schedule.js";
import { LockHeldError } from "../locks/file-lock.js";
import { changeStatuses, WritebackInputError, type ConsoleWriteback } from "./writeback.js";
import type { ChangeStatus } from "../writeback/requests.js";
import { processToken, type ConsoleRuns } from "./runs.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { consoleFontWoff2 } from "./assets/font.js";
import { renderConsolePage, renderSetupPage, renderWritebackPage } from "./page.js";
import type { SetupService } from "../setup/core.js";
import type { ConsoleStatus } from "./status.js";

export interface ReplicaSummary {
  id: string;
  name: string;
  sourceUrl: string | null;
  isActive: boolean;
}

export interface ConsoleHandlerDeps {
  port: number;
  /** Status for one deployment; called without an id for the console's default deployment. */
  buildStatus(deploymentId?: string): Promise<ConsoleStatus>;
  /** Every deployment the store knows about. Without it the console shows only the default. */
  listReplicas?(): Promise<ReplicaSummary[]>;
  now?: () => Date;
  defaultDeployment?(): Promise<string | undefined>;
  schedule?(deploymentId: string): Promise<ScheduleService>;
  writeback?(deploymentId: string): Promise<ConsoleWriteback>;
  /** Runs for the default deployment. */
  runs?: ConsoleRuns | undefined;
  /** Runs for any deployment; falls back to `runs` for the default. */
  runsFor?: ((deploymentId: string) => ConsoleRuns | undefined) | undefined;
  interruptedRuns?(deploymentId?: string): Promise<{ entityKey: string | null; startedAt: Date }[]>;
  /** The setup engine; enables the Add replica flow and lets the console start before anything is configured. */
  setup?: SetupService;
}

interface ConsoleResponse {
  status: number;
  headers: Record<string, string> & { "Content-Type": string };
  body: string;
  /** Binary payload (the console font); written instead of `body` when present. */
  bytes?: Buffer;
}

const tokenBytes = Buffer.from(processToken);

function setupMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[database]").slice(0, 300) || "Setup step failed";
}
const idlePlaceholder = { state: "idle", stage: null, startedAt: null, lines: [] };
const deploymentPattern = /^[A-Za-z0-9._-]{1,128}$/;

export function createConsoleHandler(deps: ConsoleHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  const caches = new Map<string, { revision: number | undefined; expiresAt: number; pending: Promise<ConsoleStatus> }>();
  const DEFAULT = "";

  function runsFor(id: string | undefined): ConsoleRuns | undefined {
    if (!id) return deps.runs;
    return deps.runsFor?.(id) ?? undefined;
  }

  function getStatus(id: string | undefined, refresh: boolean): Promise<ConsoleStatus> {
    const key = id ?? DEFAULT;
    const revision = runsFor(id)?.revision;
    const cache = caches.get(key);
    if (!refresh && cache && cache.revision === revision && now().getTime() < cache.expiresAt) return cache.pending;
    const entry = {
      revision, expiresAt: Infinity,
      pending: Promise.resolve().then(() => (id ? deps.buildStatus(id) : deps.buildStatus())),
    };
    caches.set(key, entry);
    void entry.pending.then(() => {
      entry.expiresAt = now().getTime() + 60_000;
    }, () => {
      if (caches.get(key) === entry) caches.delete(key);
    });
    return entry.pending;
  }

  function json(status: number, value: unknown, headers?: Record<string, string>): ConsoleResponse {
    return {
      status,
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(value).replaceAll(processToken, "[redacted]"),
    };
  }

  return async (method: string, url: string, headers: IncomingHttpHeaders, body?: unknown): Promise<ConsoleResponse> => {
    const hosts = Object.entries(headers).filter(([name]) => name.toLowerCase() === "host");
    const host = hosts.length === 1 ? hosts[0]?.[1] : undefined;
    if (host !== `127.0.0.1:${deps.port}` && host !== `localhost:${deps.port}`) {
      return json(400, { error: "Invalid Host" });
    }
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const params = new URLSearchParams(queryStart === -1 ? "" : url.slice(queryStart + 1));
    const requested = params.get("deployment") ?? undefined;
    if (requested !== undefined && !deploymentPattern.test(requested)) return json(400, { error: "Invalid deployment" });

    async function isKnown(id: string | undefined): Promise<boolean> {
      if (!id || !deps.listReplicas) return true;
      return (await deps.listReplicas()).some((replica) => replica.id === id);
    }

    if (path === "/assets/console-font.woff2") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      return {
        status: 200,
        headers: { "Cache-Control": "max-age=86400", "Content-Type": "font/woff2" },
        body: "",
        bytes: consoleFontWoff2,
      };
    }
    if (path === "/api/replicas") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      try {
        if (deps.listReplicas) return json(200, { replicas: await deps.listReplicas() });
        const status = await getStatus(undefined, false);
        return json(200, { replicas: [{ id: status.deploymentId, name: status.deploymentId, sourceUrl: null, isActive: true }] });
      } catch {
        return json(500, { error: "Unable to list replicas" });
      }
    }
    if (path === "/api/runs/current") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      return json(200, runsFor(requested)?.current() ?? idlePlaceholder);
    }
    function tokenValid(): boolean {
      const tokens = Object.entries(headers).filter(([name]) => name.toLowerCase() === "x-replcrm-token");
      const token = tokens.length === 1 ? tokens[0]?.[1] : undefined;
      const supplied = typeof token === "string" ? Buffer.from(token) : Buffer.alloc(0);
      return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
    }
    async function readFields(): Promise<Record<string, unknown> | undefined> {
      try {
        let value: unknown = typeof body === "function" ? await body() : body;
        if (typeof value === "string") value = JSON.parse(value);
        return value && typeof value === "object" ? value as Record<string, unknown> : {};
      } catch {
        return undefined;
      }
    }
    function html(render: (nonce: string) => string): ConsoleResponse {
      const nonce = randomBytes(18).toString("base64");
      return {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          "X-Frame-Options": "DENY",
        },
        body: render(nonce),
      };
    }

    if (path === "/api/schedule") {
      if (method !== "GET" && method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "GET, POST" });
      if (method === "POST" && !tokenValid()) return json(403, { error: "Invalid console token" });
      if (!deps.schedule) return json(404, { error: "Schedule is unavailable" });
      try {
        const deployment = requested ?? await deps.defaultDeployment?.();
        if (!deployment || !(await isKnown(deployment))) return json(404, { error: "Unknown deployment" });
        const service = await deps.schedule(deployment);
        if (method === "POST") {
          const fields = await readFields();
          const action = fields?.action;
          if (action !== "set" && action !== "clear" && action !== "pause" && action !== "resume") {
            return json(400, { error: "Invalid schedule action" });
          }
          await service.edit({ action, fields: fields! });
        }
        return json(200, await service.status());
      } catch (error) {
        if (error instanceof ScheduleInputError) return json(400, { error: error.message });
        return json(500, { error: method === "GET" ? "Unable to read schedule" : "Unable to update schedule" });
      }
    }
    const setupPage = () => html((nonce) => renderSetupPage(nonce, processToken, requested));
    const defaultDeployment = async () => deps.defaultDeployment ? deps.defaultDeployment() : (await getStatus(undefined, false)).deploymentId;
    const objectsPage = path === "/objects" || path === "/api/objects";
    const changesPage = path === "/changes" || path === "/api/changes";
    if (objectsPage || changesPage) {
      const api = path.startsWith("/api/");
      if (method !== "GET" && (!api || method !== "POST")) {
        return json(405, { error: "Method not allowed" }, { Allow: api ? "GET, POST" : "GET" });
      }
      if (method === "POST" && !tokenValid()) return json(403, { error: "Invalid console token" });
      if (!deps.writeback) return json(404, { error: "Write-back is unavailable" });
      try {
        const deployment = requested ?? await defaultDeployment();
        if (!deployment || !(await isKnown(requested))) return json(404, { error: "Unknown deployment" });
        const writeback = await deps.writeback(deployment);
        const filter = params.get("status") as ChangeStatus | null;
        if (changesPage && filter && !changeStatuses.includes(filter)) return json(400, { error: "Unknown status" });
        if (method === "POST") {
          const fields = await readFields();
          if (!fields) return json(400, { error: "Invalid JSON body" });
          if (objectsPage) return json(200, await writeback.edit(fields));
          await writeback.review(fields);
          return json(200, { ok: true });
        }
        if (objectsPage) {
          const objects = await writeback.objects();
          if (api) return json(200, { objects });
          const counts = await writeback.counts();
          return html((nonce) => renderWritebackPage({ objects, counts }, deployment, nonce, processToken, false, now()));
        }
        const id = params.get("id") ?? undefined;
        const changes = await writeback.changes(filter ?? undefined, id);
        if (api) return json(200, changes);
        return html((nonce) => renderWritebackPage({ ...changes, filter, id }, deployment, nonce, processToken, Boolean(runsFor(deployment)), now()));
      } catch (error) {
        if (error instanceof WritebackInputError) return json(error.status, { error: error.message });
        if (error instanceof LockHeldError) return json(409, { error: "Another run holds the deployment lock" });
        return json(500, { error: "Unable to complete the write-back request" });
      }
    }

    if (path === "/api/setup" || path === "/api/setup/objects") {
      const setup = deps.setup;
      if (!setup) return json(404, { error: "Setup is unavailable" });
      if (path === "/api/setup/objects") {
        if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
        if (!requested) return json(400, { error: "Choose a replica" });
        try {
          return json(200, { objects: await setup.availableObjects(requested) });
        } catch (error) {
          return json(502, { error: setupMessage(error) });
        }
      }
      if (method === "GET") {
        try {
          return json(200, await setup.plan(requested));
        } catch (error) {
          return json(500, { error: setupMessage(error) });
        }
      }
      if (method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "GET, POST" });
      if (!tokenValid()) return json(403, { error: "Invalid console token" });
      const fields = await readFields();
      if (!fields) return json(400, { error: "Invalid JSON body" });
      const text = (key: string): string => (typeof fields[key] === "string" ? fields[key] as string : "");
      const replica = text("deployment");
      if (replica && !deploymentPattern.test(replica)) return json(400, { error: "Invalid deployment" });
      try {
        let extra: Record<string, unknown> = {};
        switch (fields.action) {
          case "database": await setup.saveDatabase(text("url")); break;
          case "schema": await setup.applySchema(fields.confirm === true); break;
          case "replica": await setup.createReplica(text("id"), text("name")); break;
          case "app": await setup.saveApp(replica, text("clientId"), text("loginUrl")); break;
          case "signin": extra = await setup.startSignIn(replica); break;
          case "objects": {
            const list = Array.isArray(fields.entities) ? fields.entities.filter((item): item is string => typeof item === "string") : [];
            await setup.saveObjects(replica, list);
            break;
          }
          default: return json(400, { error: "Unknown setup action" });
        }
        const next = fields.action === "replica" ? text("id").trim() : replica || undefined;
        return json(200, { ...await setup.plan(next), ...extra });
      } catch (error) {
        return json(400, { error: setupMessage(error) });
      }
    }
    if (path === "/setup") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      if (!deps.setup) return json(404, { error: "Setup is unavailable" });
      return setupPage();
    }

    if (path === "/api/runs") {
      if (method !== "POST") return json(405, { error: "Method not allowed" }, { Allow: "POST" });
      if (!tokenValid()) return json(403, { error: "Invalid console token" });
      const fields = await readFields();
      if (!fields) return json(400, { error: "Invalid JSON body" });
      const stage = fields.stage;
      if (stage !== "records" && stage !== "full" && (stage !== "changes" || !deps.writeback)) {
        return json(400, { error: "Invalid run stage" });
      }
      const target = stage === "changes" ? requested ?? await defaultDeployment().catch(() => undefined) : fields.deployment;
      if (target !== undefined && (typeof target !== "string" || !deploymentPattern.test(target))) {
        return json(400, { error: "Invalid deployment" });
      }
      if (!(await isKnown(target))) return json(404, { error: "Unknown deployment" });
      const runs = runsFor(target) ?? (stage === "changes" && requested === undefined ? deps.runs : undefined);
      if (runs?.stopping) return json(503, { error: "Console is stopping" });
      if (!runs) return json(503, { error: "Console sync is unavailable" });
      const { status, ...result } = await runs.start(stage);
      return json(status, status === 202 ? runs.current() : result);
    }
    async function getStatusWithWarnings(id: string | undefined, refresh: boolean) {
      const status = await getStatus(id, refresh);
      const [interruptedRuns, writeback, schedule] = await Promise.all([
        deps.interruptedRuns ? (id ? deps.interruptedRuns(id) : deps.interruptedRuns()) : undefined,
        deps.writeback ? deps.writeback(status.deploymentId).then((service) => service.counts()) : undefined,
        deps.schedule ? deps.schedule(status.deploymentId).then((service) => service.status()) : undefined,
      ]);
      return { ...status, ...(interruptedRuns && { interruptedRuns }), ...(writeback && { writeback }), ...(schedule && { schedule }) };
    }
    if (path === "/api/status") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      try {
        if (!(await isKnown(requested))) return json(404, { error: "Unknown deployment" });
        return json(200, await getStatusWithWarnings(requested, params.get("refresh") === "1"));
      } catch {
        return json(500, { error: "Unable to read console status" });
      }
    }
    if (path === "/") {
      if (method !== "GET") return json(405, { error: "Method not allowed" }, { Allow: "GET" });
      if (!requested && deps.setup && await deps.setup.needsSetup().catch(() => false)) return setupPage();
      try {
        if (!(await isKnown(requested))) return json(404, { error: "Unknown deployment" });
        const status = await getStatusWithWarnings(requested, false);
        const runs = runsFor(requested);
        return html((nonce) => renderConsolePage(status, nonce, runs && processToken, runs?.current().state === "running", processToken));
      } catch {
        if (deps.setup && !requested) return setupPage();
        return json(500, { error: "Unable to read console status" });
      }
    }
    return json(404, { error: "Not found" });
  };
}
