import type { Prisma, PrismaClient } from "@prisma/client";
import type { ChangeNotification, SourceApiUsage } from "../../core/source.js";
import {
  budgetReached, day, defaults, editedSettings, nextDay, projectedCalls, scheduleUnits, ScheduleInputError, unitState,
  type ScheduleEdit, type Settings, type Unit, type UnitState, type UsageSnapshot,
} from "../../scheduler/schedule.js";

interface ScheduleRow extends Settings {
  heartbeatAt: Date | null;
  inboundPausedUntil: Date | null;
  units: Record<string, UnitState>;
  discoveredKeys: string[] | null;
}

export interface ObjectChangeState {
  objectKey: string;
  position: string | null;
  connected: boolean;
  lastEventAt: Date | null;
  dueAt: Date | null;
  generation: number;
  catchUp: boolean;
  catchUpPolls: number;
}

export interface ScheduleStatus {
  settings: Settings;
  heartbeatAt: string | null;
  active: boolean;
  runningUnit: boolean;
  usage: UsageSnapshot | null;
  budgetCalls: number;
  projectedCalls: number;
  inboundPausedUntil: string | null;
  events: Array<{ objectKey: string; enabled: boolean; connected: boolean; lastEventAt: string | null;
    catchUpPending: boolean; catchUpPolls: number }>;
  units: Array<Unit & { last: string | null; next: string | null }>;
}

export class ScheduleStore {
  constructor(private readonly db: PrismaClient, private readonly deploymentId: string) {}

  async read(db: Prisma.TransactionClient = this.db, lock = false): Promise<ScheduleRow> {
    const [row] = await db.$queryRawUnsafe<ScheduleRow[]>(`
      SELECT "inboundMs", "outboundMs", "metadataMs", overrides, paused, budget, "eventKeys", "heartbeatAt", "inboundPausedUntil", units, "discoveredKeys"
      FROM "DeploymentSchedule" WHERE "deploymentId" = $1 ${lock ? "FOR UPDATE" : ""}`, this.deploymentId);
    return row ?? { ...defaults, overrides: {}, heartbeatAt: null, inboundPausedUntil: null, units: {}, discoveredKeys: null };
  }

  private async limit(db: Prisma.TransactionClient = this.db) {
    const [usage] = await db.$queryRawUnsafe<(UsageSnapshot & { finishedAt: Date })[]>(`
      SELECT used, "dailyLimit", "finishedAt" FROM "ScheduledRun"
      WHERE "deploymentId" = $1 AND "dailyLimit" IS NOT NULL
      ORDER BY "finishedAt" DESC, id DESC LIMIT 1`, this.deploymentId);
    return usage;
  }

  async usage(now: number): Promise<UsageSnapshot | null> {
    const usage = await this.limit();
    if (!usage || now >= nextDay(usage.finishedAt.getTime())) return null;
    return { used: usage.used, dailyLimit: usage.dailyLimit };
  }

  private async budget(settings: Settings, keys: string[], now: number, db: Prisma.TransactionClient = this.db) {
    const rows = await db.$queryRawUnsafe<{ unit: string; calls: number }[]>(`
      SELECT unit, avg(calls)::float8 AS calls FROM "ScheduledRun"
      WHERE "deploymentId" = $1 AND "finishedAt" >= $2 AND calls IS NOT NULL GROUP BY unit`,
      this.deploymentId, new Date(now - 7 * day));
    const latest = await this.limit(db);
    const limit = latest?.dailyLimit ?? 15_000;
    return {
      budgetCalls: Math.floor(limit * settings.budget / 100),
      projectedCalls: projectedCalls(scheduleUnits(settings, keys), new Map(rows.map(({ unit, calls }) => [unit, calls])), keys.length),
    };
  }

  async edit(edit: ScheduleEdit, keys: string[], now: number): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`
        INSERT INTO "DeploymentSchedule" ("deploymentId") VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, this.deploymentId);
      const current = await this.read(tx, true);
      const settings = editedSettings(current, edit);
      if (settings.inboundMs !== current.inboundMs || settings.outboundMs !== current.outboundMs ||
        settings.metadataMs !== current.metadataMs || settings.budget !== current.budget ||
        JSON.stringify(settings.overrides) !== JSON.stringify(current.overrides)) {
        const { projectedCalls, budgetCalls } = await this.budget(settings, keys, now, tx);
        if (projectedCalls > budgetCalls) {
          throw new ScheduleInputError(`Projected ${projectedCalls} API calls/day exceeds the budget of ${budgetCalls} calls/day.`);
        }
      }
      await tx.$queryRawUnsafe(`
        UPDATE "DeploymentSchedule" SET "inboundMs" = $2, "outboundMs" = $3, "metadataMs" = $4,
          overrides = $5::jsonb, paused = $6, budget = $7, "eventKeys" = $8::jsonb WHERE "deploymentId" = $1 RETURNING 1`,
        this.deploymentId, settings.inboundMs, settings.outboundMs, settings.metadataMs,
        JSON.stringify(settings.overrides), settings.paused, settings.budget, JSON.stringify(settings.eventKeys));
    });
  }

  async heartbeat(now: number | null): Promise<void> {
    await this.db.$queryRawUnsafe(`
      INSERT INTO "DeploymentSchedule" ("deploymentId", "heartbeatAt") VALUES ($1, $2)
      ON CONFLICT ("deploymentId") DO UPDATE SET "heartbeatAt" = EXCLUDED."heartbeatAt" RETURNING 1`,
      this.deploymentId, now === null ? null : new Date(now));
  }

  async rememberDiscovery(keys: string[]): Promise<void> {
    await this.db.$queryRawUnsafe(`
      UPDATE "DeploymentSchedule" SET "discoveredKeys" = $2::jsonb WHERE "deploymentId" = $1 RETURNING 1`,
      this.deploymentId, JSON.stringify(keys));
  }

  async record(unit: Unit, state: UnitState, outcome?: {
    now: number; usage?: SourceApiUsage | undefined; pausedUntil?: number | undefined;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (outcome) {
        const { now, usage } = outcome;
        await tx.$queryRawUnsafe(`
          INSERT INTO "ScheduledRun" ("deploymentId", unit, "finishedAt", calls, used, "dailyLimit")
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING 1`, this.deploymentId, unit.id, new Date(now),
          usage?.calls ?? null, usage?.used ?? null, usage?.dailyLimit ?? null);
      }
      await tx.$queryRawUnsafe(`
        UPDATE "DeploymentSchedule" SET units = jsonb_set(units, ARRAY[$2::text], $3::jsonb),
          "inboundPausedUntil" = COALESCE($4, "inboundPausedUntil") WHERE "deploymentId" = $1 RETURNING 1`,
        this.deploymentId, unit.id, JSON.stringify(state), outcome?.pausedUntil ? new Date(outcome.pausedUntil) : null);
    });
  }

  async changeStates(): Promise<ObjectChangeState[]> {
    return this.db.$queryRawUnsafe('SELECT * FROM "ObjectChangeState" WHERE "deploymentId" = $1', this.deploymentId);
  }

  async changeConnection(keys: string[], connected: boolean): Promise<void> {
    if (!keys.length) return;
    await this.db.$executeRawUnsafe(`
      INSERT INTO "ObjectChangeState" ("deploymentId", "objectKey", connected)
      SELECT $1, key, $3 FROM jsonb_array_elements_text($2::jsonb) AS key
      ON CONFLICT ("deploymentId", "objectKey") DO UPDATE SET connected = EXCLUDED.connected`,
      this.deploymentId, JSON.stringify(keys), connected);
  }

  async rememberChange(event: ChangeNotification, now: number, debounceMs: number): Promise<void> {
    await this.db.$executeRawUnsafe(`
      INSERT INTO "ObjectChangeState" ("deploymentId", "objectKey", position, "lastEventAt", "dueAt", generation, "catchUp")
      VALUES ($1, $2, $3, $4, $5, 1, $6)
      ON CONFLICT ("deploymentId", "objectKey") DO UPDATE
      SET position = EXCLUDED.position, "lastEventAt" = COALESCE(EXCLUDED."lastEventAt", "ObjectChangeState"."lastEventAt"),
          "dueAt" = CASE WHEN "ObjectChangeState"."catchUp" THEN "ObjectChangeState"."dueAt" ELSE EXCLUDED."dueAt" END,
          generation = "ObjectChangeState".generation + 1, "catchUp" = "ObjectChangeState"."catchUp" OR EXCLUDED."catchUp"`,
      this.deploymentId, event.objectKey, event.position, event.kind === "resume-unavailable" ? null : new Date(now),
      new Date(now + debounceMs), event.kind === "catch-up" || event.kind === "resume-unavailable");
  }

  async finishChange(state: ObjectChangeState): Promise<void> {
    await this.db.$executeRawUnsafe(`
      UPDATE "ObjectChangeState"
      SET "dueAt" = CASE WHEN generation = $3 THEN NULL ELSE "dueAt" END,
          "catchUp" = CASE WHEN generation = $3 THEN false ELSE "catchUp" END,
          "catchUpPolls" = "catchUpPolls" + $4
      WHERE "deploymentId" = $1 AND "objectKey" = $2`, this.deploymentId, state.objectKey, state.generation, state.catchUp ? 1 : 0);
  }

  async status(keys: string[], now: number, active: boolean, runningUnit: boolean): Promise<ScheduleStatus> {
    const { heartbeatAt, inboundPausedUntil, units, inboundMs, outboundMs, metadataMs, overrides, paused, eventKeys, budget: share } = await this.read();
    const settings = { inboundMs, outboundMs, metadataMs, overrides, paused, eventKeys, budget: share };
    const [usage, budget, changes] = await Promise.all([this.usage(now), this.budget(settings, keys, now), this.changeStates()]);
    const states = new Map(changes.map((state) => [state.objectKey, state]));
    return {
      settings, heartbeatAt: heartbeatAt?.toISOString() ?? null, active: active && heartbeatAt !== null,
      runningUnit, usage, ...budget,
      events: [...new Set(keys)].sort().map((objectKey) => {
        const state = states.get(objectKey);
        const enabled = eventKeys.includes(objectKey);
        return { objectKey, enabled, connected: enabled && !paused && active && heartbeatAt !== null && state?.connected === true,
        lastEventAt: state?.lastEventAt?.toISOString() ?? null, catchUpPending: enabled && state?.catchUp === true,
        catchUpPolls: state?.catchUpPolls ?? 0 };
      }),
      inboundPausedUntil: inboundPausedUntil && inboundPausedUntil.getTime() > now ? inboundPausedUntil.toISOString() : null,
      units: scheduleUnits(settings, keys).map((unit) => {
        const { last, next, budgetDeferredUntil } = unitState(unit, units, now);
        const hardLimit = inboundPausedUntil?.getTime() ?? 0;
        const budgetLimit = budgetReached(usage, settings) ? budgetDeferredUntil ?? nextDay(now) : 0;
        const blockedUntil = unit.kind === "inbound" ? Math.max(hardLimit, budgetLimit) : 0;
        return { ...unit, last: last === null ? null : new Date(last).toISOString(),
          next: settings.paused ? null : new Date(Math.max(now, next, blockedUntil)).toISOString() };
      }),
    };
  }
}
