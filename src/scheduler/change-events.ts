import type { ChangeNotification, ChangeSubscription } from "../core/source.js";
import type { ObjectChangeState, ScheduleStore } from "../stores/postgres/schedule.js";

export interface ChangeRuntime {
  store: Pick<ScheduleStore, "changeStates" | "changeConnection" | "rememberChange" | "finishChange">;
  subscribe(request: ChangeSubscription): AsyncIterable<ChangeNotification>;
  debounceMs?: number;
}

export function watchChanges(
  { store, subscribe, debounceMs = 2_000 }: ChangeRuntime,
  signal: AbortSignal,
  now: () => number,
  wake: () => void,
  log: (message: string) => void,
) {
  let keys: string[] = [];
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  let failures = 0;
  let retryAt = Infinity;
  let initialized = false;

  async function update(selected: string[], states: ObjectChangeState[]): Promise<number> {
    if (!initialized) {
      await store.changeConnection(states.filter(({ connected }) => connected).map(({ objectKey }) => objectKey), false);
      initialized = true;
    }
    if (keys.length !== selected.length || keys.some((key, index) => key !== selected[index])) {
      controller?.abort();
      await running;
      keys = selected;
      failures = 0;
      retryAt = now();
    }
    if (signal.aborted || !keys.length) return Infinity;
    if (running || retryAt > now()) return retryAt;

    controller = new AbortController();
    const attempt = AbortSignal.any([signal, controller.signal]);
    const positions = new Map(keys.map((key) => [key, states.find(({ objectKey }) => objectKey === key)?.position ?? null]));
    retryAt = Infinity;
    running = Promise.resolve().then(async () => {
      try {
        for await (const event of subscribe({
          positions, signal: attempt,
          connectionChanged: async (connected) => {
            if (connected) failures = 0;
            await store.changeConnection(keys, connected && !attempt.aborted);
          },
        })) {
          if (attempt.aborted) break;
          if (!positions.has(event.objectKey)) continue;
          await store.rememberChange(event, now(), debounceMs);
          wake();
        }
      } catch {
        // Subscription errors may include credentials echoed by a server or proxy.
      } finally {
        const finishedAt = now();
        try {
          await store.changeConnection(keys, false);
        } catch {
          log("[schedule] Could not update live connection status.");
        }
        if (!attempt.aborted) {
          const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
          retryAt = finishedAt + delay;
          log(`[schedule] Live updates disconnected for ${keys.join(", ")}. Scheduled polls continue. Retrying in ${delay / 1_000}s.`);
        }
        running = undefined;
        wake();
      }
    });
    return retryAt;
  }

  return {
    update,
    async close() {
      controller?.abort();
      await running;
    },
  };
}
