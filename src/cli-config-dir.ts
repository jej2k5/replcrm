import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export function resolveConfigDir(env: NodeJS.ProcessEnv, homedir: string): string {
  return env.REPLCRM_CONFIG_DIR || join(homedir, ".config", "replcrm");
}

export function safeDeploymentFileName(id: string): string {
  if (!id || id.startsWith(".") || /[^A-Za-z0-9._-]/.test(id)) {
    throw new Error(`Unsafe deployment ID ${JSON.stringify(id)} for a config file.`);
  }
  return id;
}

export function runLockPath(configDir: string, deploymentId: string): string {
  return join(configDir, "locks", `${safeDeploymentFileName(deploymentId)}.run.lock`);
}

export function refreshLockPath(configDir: string, deploymentId: string): string {
  return join(configDir, "locks", `${safeDeploymentFileName(deploymentId)}.refresh.lock`);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value, null, 2);
  if (contents === undefined) throw new Error(`Cannot encode JSON for ${path}.`);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = join(parent, `.${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    try {
      await file.writeFile(contents + "\n", "utf8");
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o044) !== 0) {
      throw new Error(`Expected a private JSON file at ${path}.`);
    }
    const contents = await file.readFile("utf8");
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new Error(`Malformed JSON in ${path}.`);
    }
  } finally {
    await file.close();
  }
}
