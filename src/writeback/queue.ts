import { setTimeout as sleep } from "node:timers/promises";
import type { FileLock } from "../locks/file-lock.js";
import type { ChangeRequestProcessor } from "./processor.js";
import { retryDelayElapsed, type WritebackStore } from "./requests.js";

export async function recoverSending(store: WritebackStore, deploymentId: string): Promise<void> {
  for (const request of await store.listChangeRequests(deploymentId, { status: "sending" })) {
    await store.transitionChangeRequest(deploymentId, request.id, "sending", {
      status: request.operation === "create" ? "unknown" : "pending",
      statusDetail: "Processing stopped before the write outcome was recorded",
    }, request.updatedAt);
  }
}

export async function processQueue(options: {
  store: WritebackStore;
  deploymentId: string;
  processor: () => Promise<ChangeRequestProcessor>;
  acquire: () => Promise<FileLock>;
  signal: AbortSignal;
  intervalMs?: number | undefined;
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}): Promise<void> {
  const { store, deploymentId, signal, intervalMs } = options;
  const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  let processor: ChangeRequestProcessor | undefined;
  while (!signal.aborted) {
    const lock = await options.acquire();
    try {
      await processBatch({ store, deploymentId, signal, processor: async () => processor ??= await options.processor() });
    } finally {
      await lock.release();
    }
    if (intervalMs === undefined || signal.aborted) return;
    try {
      await wait(intervalMs, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

/** Run one batch while the caller holds the deployment run lock. */
export async function processBatch({ store, deploymentId, signal, processor }: {
  store: WritebackStore;
  deploymentId: string;
  signal: AbortSignal;
  processor: () => Promise<ChangeRequestProcessor>;
}): Promise<void> {
  if (signal.aborted) return;
  await recoverSending(store, deploymentId);
  for (const request of await store.listChangeRequests(deploymentId)) {
    if (signal.aborted) break;
    const due = request.status === "failed" && request.retryAfter !== null && retryDelayElapsed(request);
    if (request.status !== "pending" && request.status !== "overridden" && !due) continue;
    const worker = await processor();
    if (signal.aborted) break;
    try {
      await worker.processChange(request);
    } catch (error) {
      await recoverSending(store, deploymentId);
      throw error;
    }
  }
}
