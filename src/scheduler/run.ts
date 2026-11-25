import { watchChanges, type ChangeRuntime } from "./change-events.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { SourceApiUsage } from "../core/source.js";
import { redactMessage } from "../console/status.js";
import { LockHeldError, type FileLock } from "../locks/file-lock.js";
import type { ScheduleStore } from "../stores/postgres/schedule.js";
import { budgetReached, nextDay, scheduleUnits, unitState, type Unit } from "./schedule.js";

export interface SchedulerDeps {
  store: Pick<ScheduleStore, "read" | "usage" | "record" | "heartbeat">;
  keys(): Promise<string[]>;
  acquire(unit: Unit): Promise<FileLock>;
  perform(unit: Unit, observe: (usage: SourceApiUsage) => void): Promise<void>;
  signal: AbortSignal;
  changes?: ChangeRuntime;
  now?: (() => number) | undefined;
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
}

export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  const { store, signal, now = Date.now, random = Math.random, log = console.log } = deps;
  const wait = deps.wait ?? ((ms, abort) => sleep(ms, undefined, { signal: abort }));
  const jitter = (interval: number) => Math.floor(random() * Math.min(interval * 0.05, 1_000));
  let heartbeatDue = -Infinity;

  let wakeController = new AbortController();
  const watcher = deps.changes && watchChanges(deps.changes, signal, now, () => wakeController.abort(), log);
  const retryEvents = new Map<string, number>();
  try {
    while (!signal.aborted) {
      wakeController = new AbortController();
      const tick = now();
      if (tick >= heartbeatDue) {
        await store.heartbeat(tick);
        heartbeatDue = tick + 5_000;
      }
      const settings = await store.read();
      const keys = settings.paused ? [] : await deps.keys();
      const live = keys.filter((key) => settings.eventKeys.includes(key)).sort();
      const changes = deps.changes ? await deps.changes.store.changeStates() : [];
      const reconnect = await watcher?.update(live, changes) ?? Infinity;
      const units = settings.paused ? [] : scheduleUnits(settings, keys);
      const due = units.map((unit) => ({ unit, state: unitState(unit, settings.units, tick),
        change: undefined as (typeof changes)[number] | undefined }));
      for (const change of changes) {
        if (!change.dueAt || !live.includes(change.objectKey)) continue;
        const unit: Unit = { id: `event:${change.objectKey}`, kind: "inbound", keys: [change.objectKey], intervalMs: 2_000 };
        const state = unitState(unit, settings.units, tick);
        due.push({ unit, change, state: { ...state,
          next: Math.max(change.dueAt.getTime(), retryEvents.get(change.objectKey) ?? 0) } });
      }
      due.sort((a, b) => a.state.next - b.state.next);

      let wake = Math.min(heartbeatDue, reconnect);
      for (const { unit, state, change: pending } of due) {
        let change = pending;
        if (signal.aborted) break;
        if (state.next > now()) {
          wake = Math.min(wake, state.next);
          continue;
        }
        // Honor edits received while an earlier unit was running.
        const current = await store.read();
        if (current.paused) break;
        const currentKeys = await deps.keys();
        if (change) {
          if (!currentKeys.includes(change.objectKey) || !current.eventKeys.includes(change.objectKey)) continue;
          const key = change.objectKey;
          const latest = (await deps.changes!.store.changeStates()).find(({ objectKey }) => objectKey === key);
          if (!latest?.dueAt || latest.dueAt.getTime() > now()) continue;
          change = latest;
        } else if (!scheduleUnits(current, currentKeys).some((candidate) =>
          candidate.id === unit.id && candidate.intervalMs === unit.intervalMs)) continue;

        const stamp = now();
        if (unit.kind === "inbound") {
          const limitPause = current.inboundPausedUntil?.getTime() ?? 0;
          if (limitPause > stamp) {
            wake = Math.min(wake, limitPause);
            continue;
          }
          const usage = await store.usage(stamp);
          if (budgetReached(usage, current)) {
            const next = state.budgetDeferredUntil && state.budgetDeferredUntil > stamp
              ? state.budgetDeferredUntil : nextDay(stamp) + jitter(unit.intervalMs);
            if (next !== state.budgetDeferredUntil) {
              log(`[schedule] ${unit.id} slowed until ${new Date(next).toISOString()} (API usage ${usage.used}/${usage.dailyLimit}, budget ${current.budget}%).`);
              await store.record(unit, { ...state, budgetDeferredUntil: next });
            }
            wake = Math.min(wake, next);
            continue;
          }
        }

        let lock: FileLock;
        try {
          lock = await deps.acquire(unit);
        } catch (error) {
          if (!(error instanceof LockHeldError)) throw error;
          const next = now() + unit.intervalMs + jitter(unit.intervalMs);
          log(`[schedule] ${unit.id} skipped because the deployment run lock is held.`);
          if (change) retryEvents.set(change.objectKey, next);
          else await store.record(unit, { ...state, next });
          wake = Math.min(wake, next);
          continue;
        }
        try {
          if (signal.aborted) break;
          let usage: SourceApiUsage | undefined;
          let failures = 0;
          try {
            await deps.perform(unit, (observation) => { usage = observation; });
          } catch (error) {
            failures = state.failures + 1;
            const message = error instanceof Error ? error.message : String(error);
            const reason = redactMessage(message.replace(/postgres(?:ql)?:\/\/[^\s"'\x60]+/gi, "[database]"))
              .split(/\r?\n/, 1)[0]!.slice(0, 200);
            log(`[schedule] ${unit.id} failed${reason ? ": " + reason : "."}`);
          }
          const finished = now();
          const pause = usage?.limitExceeded ? nextDay(finished) : undefined;
          if (pause) log(`[schedule] Source API limit reached. Inbound work resumes at ${new Date(pause).toISOString()}.`);
          const delay = failures ? Math.min(change ? 60_000 : unit.intervalMs, 1_000 * 2 ** Math.min(failures - 1, 30)) : unit.intervalMs;
          const next = finished + delay + (failures ? 0 : jitter(unit.intervalMs));
          await store.record(unit, { intervalMs: unit.intervalMs, last: finished, next, failures },
            { now: finished, usage, pausedUntil: pause });
          if (change) {
            if (failures) {
              retryEvents.set(change.objectKey, next);
              wake = Math.min(wake, next);
            } else {
              await deps.changes!.store.finishChange(change);
              retryEvents.delete(change.objectKey);
            }
          } else {
            wake = Math.min(wake, next);
          }
        } finally {
          await lock.release();
        }
      }
      if (!signal.aborted) {
        const sleeping = watcher ? AbortSignal.any([signal, wakeController.signal]) : signal;
        if (sleeping.aborted) continue;
        try {
          await wait(Math.max(0, wake - now()), sleeping);
        } catch (error) {
          if (!sleeping.aborted) throw error;
        }
      }
    }
  } finally {
    await watcher?.close();
  }
}
