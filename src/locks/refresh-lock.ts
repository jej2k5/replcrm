import { refreshLockPath } from "../cli-config-dir.js";
import { acquireLock } from "./file-lock.js";

export type WithRefreshLock = <T>(operation: () => Promise<T>) => Promise<T>;

const pendingRefreshes = new Map<string, Promise<void>>();

export function createRefreshLock(
  configDir: string,
  deploymentId: string,
  options: { waitMs?: number | undefined; now?: () => Date; mutex?: Map<string, Promise<void>> | undefined } = {},
): WithRefreshLock {
  const path = refreshLockPath(configDir, deploymentId);
  const pending = options.mutex ?? pendingRefreshes;
  return async (operation) => {
    const previous = pending.get(deploymentId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const lock = await acquireLock(path, {
        command: "OAuth refresh", waitMs: options.waitMs ?? 30_000, ...(options.now ? { now: options.now } : {}),
      });
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
    const tail = next.then(() => {}, () => {});
    pending.set(deploymentId, tail);
    try {
      return await next;
    } finally {
      if (pending.get(deploymentId) === tail) pending.delete(deploymentId);
    }
  };
}
