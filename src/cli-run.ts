import type { FileLock } from "./locks/file-lock.js";
import { runScheduler, type SchedulerDeps } from "./scheduler/run.js";

export async function runScheduledDeployment(deps: Omit<SchedulerDeps, "signal"> & {
  acquireScheduler(): Promise<FileLock>;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => Promise<void>): () => void;
}): Promise<number> {
  const stop = new AbortController();
  const stopOnSignal = async () => { stop.abort(); };
  const removeInt = deps.onSignal("SIGINT", stopOnSignal);
  const removeTerm = deps.onSignal("SIGTERM", stopOnSignal);
  try {
    const lock = await deps.acquireScheduler();
    try {
      await runScheduler({ ...deps, signal: stop.signal });
    } finally {
      try {
        await deps.store.heartbeat(null);
      } finally {
        await lock.release();
      }
    }
    return stop.signal.aborted ? 130 : 0;
  } finally {
    removeInt();
    removeTerm();
  }
}
