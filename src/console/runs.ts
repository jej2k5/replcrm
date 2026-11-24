import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { format } from "node:util";
import { LockHeldError, type FileLock } from "../locks/file-lock.js";
import { redactMessage } from "./status.js";

export const processToken = randomBytes(32).toString("hex");

export type ConsoleStage = "records" | "full" | "changes";

interface RunProgress {
  state: "running" | "succeeded" | "failed";
  stage: ConsoleStage;
  startedAt: string;
  finishedAt?: string;
  lines: string[];
}

interface RunDeps {
  acquire(stage: ConsoleStage): Promise<FileLock>;
  run(stage: ConsoleStage, signal: AbortSignal): Promise<void>;
  now?: (() => Date) | undefined;
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

const output = new AsyncLocalStorage<(line: string) => void>();
let captures = 0;
let restoreOutput: () => void;

async function captureOutput(write: (line: string) => void, run: () => Promise<void>) {
  // The core writes to console. Route only this async context to the run buffer.
  if (captures++ === 0) {
    const restore = (["log", "info", "warn", "error"] as const).map((method) => {
      const original = console[method];
      console[method] = (...args: unknown[]) => {
        const writeLine = output.getStore();
        if (writeLine) writeLine(format(...args));
        else original.apply(console, args);
      };
      return () => { console[method] = original; };
    });
    restoreOutput = () => { for (const reset of restore) reset(); };
  }
  try {
    await output.run(write, run);
  } finally {
    if (--captures === 0) restoreOutput();
  }
}

export function createConsoleRuns(deps: RunDeps) {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const starts = new Set<ReturnType<typeof acquire>>();
  let stopping = false;
  let revision = 0;
  let current: RunProgress | undefined;
  let active: { done: Promise<void>; cancel(): void; stop(): Promise<void> } | undefined;

  async function acquire(stage: ConsoleStage) {
    try {
      const lock = await deps.acquire(stage);
      if (stopping) {
        await lock.release();
        return { status: 503, error: "Console is stopping" };
      }
      const progress: RunProgress = { state: "running", stage, startedAt: now().toISOString(), lines: [] };
      current = progress;
      const abort = new AbortController();
      function write(value: string) {
        if (progress.state !== "running") return;
        const safe = redactMessage(value).replaceAll(processToken, "[redacted]");
        if (!safe) return;
        for (const line of safe.split(/\r?\n/)) {
          progress.lines.push(line);
          if (progress.lines.length > 200) progress.lines.shift();
        }
      }
      function finish(state: "succeeded" | "failed") {
        if (progress.state !== "running") return;
        progress.state = state;
        progress.finishedAt = now().toISOString();
        revision++;
      }
      const done = Promise.resolve().then(async () => {
        let state: "succeeded" | "failed" = "succeeded";
        try {
          await captureOutput(write, () => deps.run(stage, abort.signal));
        } catch (error) {
          state = "failed";
          write(error instanceof Error ? error.message : String(error));
        } finally {
          try {
            await lock.release();
          } catch (error) {
            state = "failed";
            write(String(error));
          } finally {
            finish(state);
          }
        }
      });
      const run = {
        done,
        cancel: () => abort.abort(new Error("console stopped")),
        stop: async () => {
          write("console stopped");
          finish("failed");
          abort.abort(new Error("console stopped"));
          await lock.release();
        },
      };
      active = run;
      void done.then(() => { if (active === run) active = undefined; });
      return { status: 202 };
    } catch (error) {
      if (error instanceof LockHeldError) {
        const holder = error.holder;
        return {
          status: 409, error: redactMessage(error.message),
          ...(holder && { holder: { command: redactMessage(holder.command), pid: holder.pid, startedAt: holder.startedAt } }),
        };
      }
      return { status: 500, error: "Unable to acquire or release the run lock" };
    }
  }

  return {
    get stopping() { return stopping; },
    get revision() { return revision; },
    current: () => current ?? { state: "idle", stage: null, startedAt: null, lines: [] },
    start: async (stage: ConsoleStage) => {
      if (stopping) return { status: 503, error: "Console is stopping" };
      const pending = acquire(stage);
      starts.add(pending);
      try {
        return await pending;
      } finally {
        starts.delete(pending);
      }
    },
    shutdown: async () => {
      stopping = true;
      await Promise.allSettled(starts);
      const run = active;
      if (!run) return;
      if (current?.stage === "changes") {
        run.cancel();
        await run.done;
        return;
      }
      const timer = new AbortController();
      try {
        const finished = await Promise.race([run.done.then(() => true), wait(10_000, timer.signal).then(() => false)]);
        if (!finished) await run.stop();
      } finally {
        timer.abort();
      }
    },
  };
}

export type ConsoleRuns = ReturnType<typeof createConsoleRuns>;
