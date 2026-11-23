import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readPrivateJson } from "../cli-config-dir.js";

export interface LockHolder {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
  ownerToken: string;
}

export interface FileLock {
  release(): Promise<void>;
}

export class LockHeldError extends Error {
  constructor(
    public readonly path: string,
    public readonly holder: LockHolder | undefined,
    message: string,
    public readonly live = false,
  ) {
    super(message);
    this.name = "LockHeldError";
  }
}

interface LockOptions {
  command: string;
  waitMs?: number;
  now?: () => Date;
  hostname?: string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function isHolder(value: unknown): value is LockHolder {
  if (!value || typeof value !== "object") return false;
  const { pid, hostname, command, startedAt, ownerToken } = value as Partial<LockHolder>;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff &&
    typeof hostname === "string" && typeof command === "string" &&
    typeof startedAt === "string" && Number.isFinite(Date.parse(startedAt)) &&
    typeof ownerToken === "string" && ownerToken.length > 0;
}

const unreadable = Symbol("unreadable lock");

async function readHolder(path: string): Promise<LockHolder | typeof unreadable | undefined> {
  try {
    const value = await readPrivateJson(path);
    return value === undefined || isHolder(value) ? value : unreadable;
  } catch (error) {
    if (error instanceof Error && error.message === `Malformed JSON in ${path}.`) return unreadable;
    throw error;
  }
}

function refusal(
  path: string, holder: LockHolder | typeof unreadable, host: string, alive: (pid: number) => boolean,
): LockHeldError {
  if (holder === unreadable) {
    return new LockHeldError(path, undefined, `Cannot read the lock holder at ${path}. Confirm the run is gone, then delete ${path} and retry.`);
  }
  const { command, pid, hostname, startedAt } = holder;
  let message = `${command} (pid ${pid} on ${hostname}, started ${startedAt})`;
  if (hostname !== host) {
    message = `The ${command} run (pid ${pid}, started ${startedAt}) holds the lock on ${hostname}. Check that host first. If the run is gone, delete ${path} and retry.`;
  } else if (!alive(pid)) {
    message = `The ${command} run (pid ${pid}, started ${startedAt}) is no longer running. Delete ${path} and retry.`;
  } else {
    return new LockHeldError(path, holder, message, true);
  }
  return new LockHeldError(path, holder, message);
}

export async function acquireLock(path: string, options: LockOptions): Promise<FileLock> {
  const {
    command, waitMs = 0, now = () => new Date(), hostname: host = hostname(),
    pid = process.pid, isProcessAlive: alive = isProcessAlive, sleep: pause = sleep,
  } = options;
  const deadline = now().getTime() + waitMs;
  const ownerToken = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  while (true) {
    const holder: LockHolder = { pid, hostname: host, command, startedAt: now().toISOString(), ownerToken };
    const file = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return undefined;
      throw error;
    });
    if (file) {
      try {
        await file.writeFile(JSON.stringify(holder) + "\n", "utf8");
      } finally {
        await file.close();
      }
      let release: Promise<void> | undefined;
      return {
        release: () => release ??= removeOwnedLock(path, ownerToken),
      };
    }

    let held = await readHolder(path);
    // Exclusive creation exposes the file before its initial write completes.
    if (held === unreadable) {
      await sleep(10);
      held = await readHolder(path);
    }
    if (held === undefined) continue;
    const remaining = deadline - now().getTime();
    if (waitMs <= 0 || remaining <= 0) throw refusal(path, held, host, alive);
    await pause(Math.min(50, remaining));
    if (now().getTime() > deadline) {
      const current = await readHolder(path);
      throw refusal(path, current ?? held, host, alive);
    }
  }
}

async function removeOwnedLock(path: string, token: string): Promise<void> {
  const holder = await readHolder(path);
  if (!holder || holder === unreadable || holder.ownerToken !== token) return;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
