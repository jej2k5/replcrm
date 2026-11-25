import { parseArgs } from "node:util";
import type { ScheduleStatus } from "./stores/postgres/schedule.js";
import { formatDuration, ScheduleInputError, type ScheduleEdit } from "./scheduler/schedule.js";

export interface ScheduleService {
  status(): Promise<ScheduleStatus>;
  edit(edit: ScheduleEdit): Promise<void>;
}

export const scheduleUsage = "schedule show [--json] | set [--inbound 5m] [--object Opportunity=1m] [--outbound 10s] [--metadata 24h] [--budget 50] [--events Opportunity,Contact] | clear [--object Opportunity] [--events Contact] | pause | resume";

export async function runScheduleCommand(args: string[], service: ScheduleService): Promise<void> {
  const [action = "show", ...rest] = args;
  if (action === "show") {
    const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    await printSchedule(service, values.json);
    return;
  }
  if (action === "set") {
    const { values } = parseArgs({ args: rest, options: {
      inbound: { type: "string" }, outbound: { type: "string" }, metadata: { type: "string" },
      object: { type: "string", multiple: true }, budget: { type: "string" }, events: { type: "string" },
    } });
    await service.edit({ action, fields: values });
  } else if (action === "clear") {
    const { values } = parseArgs({ args: rest, options: { object: { type: "string" }, events: { type: "string" } } });
    await service.edit({ action, fields: values });
  } else if (action === "pause" || action === "resume") {
    parseArgs({ args: rest });
    await service.edit({ action });
  } else {
    throw new ScheduleInputError(scheduleUsage);
  }
  await printSchedule(service);
}

export async function printSchedule(service: ScheduleService, json?: boolean): Promise<void> {
  const status = await service.status();
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  const { settings, usage } = status;
  console.log([
    `Schedule ${settings.paused ? "paused" : "enabled"} · scheduler ${status.active ? "active" : "inactive"}`,
    `Inbound ${formatDuration(settings.inboundMs)} · outbound ${formatDuration(settings.outboundMs)} · metadata ${formatDuration(settings.metadataMs)}`,
    ...Object.entries(settings.overrides).map(([key, ms]) => `  ${key} every ${formatDuration(ms)}`),
    `API budget ${settings.budget}% (${status.budgetCalls} calls/day) · ${usage ? `${usage.used}/${usage.dailyLimit} used` : "usage unavailable"} · ${status.projectedCalls} calls/day projected`,
    ...(status.inboundPausedUntil ? [`Inbound API limit pause until ${status.inboundPausedUntil}`] : []),
    ...status.events.map(({ objectKey, enabled, connected, lastEventAt, catchUpPolls, catchUpPending }) =>
      `  ${objectKey} · events ${enabled ? "on" : "off"} · ${connected ? "connected" : "disconnected"} · last event ${lastEventAt ?? "never"} · ${catchUpPolls} catch-up polls${catchUpPending ? " · catch-up pending" : ""}`),
    ...status.units.map(({ kind, keys, last, next }) =>
      `${keys.length ? keys.join(", ") : kind} · last ${last ?? "never"} · next ${next ?? "paused"}`),
  ].join("\n"));
}
