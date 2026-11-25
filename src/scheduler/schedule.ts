export interface Settings {
  inboundMs: number;
  outboundMs: number;
  metadataMs: number;
  overrides: Record<string, number>;
  paused: boolean;
  budget: number;
  eventKeys: string[];
}

export const defaults: Settings = {
  inboundMs: 300_000, outboundMs: 10_000, metadataMs: 86_400_000, overrides: {}, paused: false, budget: 50, eventKeys: [],
};

export const day = 86_400_000;
export const nextDay = (now: number) => (Math.floor(now / day) + 1) * day;

export class ScheduleInputError extends Error {}

export function duration(value: unknown, minimumMs: number): number {
  const match = typeof value === "string" && /^(\d+)([smh])$/.exec(value);
  const scale = { s: 1_000, m: 60_000, h: 3_600_000 };
  const ms = match ? Number(match[1]) * scale[match[2] as keyof typeof scale] : NaN;
  if (!Number.isSafeInteger(ms) || ms < minimumMs || ms > 2_147_483_647) {
    throw new ScheduleInputError(`Enter a duration in s, m or h between ${minimumMs / 1000}s and 2147483s.`);
  }
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms / 1_000}s`;
}

function objectKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,254}$/.test(value)) {
    throw new ScheduleInputError("Enter a valid object key.");
  }
  return value;
}

export interface ScheduleEdit {
  action: "set" | "clear" | "pause" | "resume";
  fields?: Record<string, unknown>;
}

export function eventKeys(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new ScheduleInputError("Enter a comma-separated list of objects.");
  return [...new Set(value.split(",").map((key) => objectKey(key.trim())))];
}

export function editedSettings(current: Settings, { action, fields = {} }: ScheduleEdit): Settings {
  const settings = { ...current, overrides: { ...current.overrides } };
  if (action === "pause" || action === "resume") {
    settings.paused = action === "pause";
  } else if (action === "clear") {
    if (fields.object !== undefined) delete settings.overrides[objectKey(fields.object)];
    if (fields.object === undefined && fields.events === undefined) throw new ScheduleInputError("Choose an object or live updates to clear.");
    const removed = eventKeys(fields.events);
    settings.eventKeys = settings.eventKeys.filter((key) => !removed.includes(key));
  } else {
    if (fields.inbound !== undefined) settings.inboundMs = duration(fields.inbound, 60_000);
    if (fields.outbound !== undefined) settings.outboundMs = duration(fields.outbound, 1_000);
    if (fields.metadata !== undefined) settings.metadataMs = duration(fields.metadata, 1_000);
    if (fields.budget !== undefined) {
      if (typeof fields.budget !== "string" || !/^\d+$/.test(fields.budget) || Number(fields.budget) < 1 || Number(fields.budget) > 100) {
        throw new ScheduleInputError("Enter an API budget from 1 to 100 percent.");
      }
      settings.budget = Number(fields.budget);
    }
    settings.eventKeys = [...new Set([...settings.eventKeys, ...eventKeys(fields.events)])].sort();
    if (fields.clearOverrides !== undefined) {
      if (!Array.isArray(fields.clearOverrides)) throw new ScheduleInputError("Choose object intervals to clear.");
      for (const key of fields.clearOverrides) delete settings.overrides[objectKey(key)];
    }
    const input = fields.object;
    if (input !== undefined) {
      for (const entry of Array.isArray(input) ? input : [input]) {
        if (typeof entry !== "string" || entry.split("=").length !== 2) {
          throw new ScheduleInputError("Use Object=duration for each object override.");
        }
        const [key, interval] = entry.split("=");
        settings.overrides[objectKey(key)] = duration(interval, 60_000);
      }
    }
  }
  return settings;
}

export interface Unit {
  id: string;
  kind: "inbound" | "outbound" | "metadata";
  keys: string[];
  intervalMs: number;
}

export interface UnitState {
  intervalMs: number;
  last: number | null;
  next: number;
  failures: number;
  budgetDeferredUntil?: number;
}

export function scheduleUnits(settings: Settings, keys: string[]): Unit[] {
  const groups = new Map<number, string[]>();
  for (const key of [...new Set(keys)].sort()) {
    const interval = Object.hasOwn(settings.overrides, key) ? settings.overrides[key]! : settings.inboundMs;
    const group = groups.get(interval) ?? [];
    group.push(key);
    groups.set(interval, group);
  }
  return [
    ...[...groups].sort(([a], [b]) => a - b).map(([intervalMs, members]): Unit => ({
      id: `inbound:${JSON.stringify(members)}`, kind: "inbound", keys: members, intervalMs,
    })),
    { id: "outbound", kind: "outbound", keys: [], intervalMs: settings.outboundMs },
    { id: "metadata", kind: "metadata", keys: [], intervalMs: settings.metadataMs },
  ];
}

export function unitState(unit: Unit, states: Record<string, UnitState>, now: number): UnitState {
  const previous = states[unit.id];
  if (previous?.intervalMs === unit.intervalMs) return previous;
  const last = previous?.last ?? null;
  return { intervalMs: unit.intervalMs, last, next: last === null ? now : last + unit.intervalMs, failures: 0 };
}

export interface UsageSnapshot { used: number; dailyLimit: number }

export function budgetReached(usage: UsageSnapshot | null, settings: Settings): usage is UsageSnapshot {
  return usage !== null && usage.used >= Math.floor(usage.dailyLimit * settings.budget / 100);
}

export function projectedCalls(units: Unit[], costs: ReadonlyMap<string, number>, objectCount: number): number {
  return Math.ceil(units.reduce((total, unit) => {
    // An idle poll uses no source calls. Reserve one five-call write per five minutes at the default polling rate.
    const estimate = unit.kind === "outbound" ? 5 * defaults.outboundMs / 300_000
      : unit.kind === "metadata" ? objectCount + 1 : unit.keys.length * 4;
    return total + Math.ceil(day / unit.intervalMs) * (costs.get(unit.id) ?? estimate);
  }, 0));
}
