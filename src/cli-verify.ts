import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readPrivateJson, safeDeploymentFileName, writePrivateJson } from "./cli-config-dir.js";
import type { SalesforceIdentity } from "./sources/salesforce/client.js";

export interface DeploymentBinding {
  version: 1;
  organizationId: string;
  userId: string;
  username: string;
  instanceHost: string;
  verifiedAt: string;
}

interface IdentitySource {
  identity(): Promise<SalesforceIdentity>;
  logout?(): Promise<void>;
}

export interface VerifyDeps {
  configDir(): string;
  createSource(): IdentitySource | Promise<IdentitySource>;
  writeJson?: typeof writePrivateJson;
  writeOutput?: (message: string) => void;
}

function bindingPath(configDir: string, deploymentId: string): string {
  return join(configDir, "bindings", `${safeDeploymentFileName(deploymentId)}.json`);
}

function isBinding(value: unknown): value is DeploymentBinding {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return ["organizationId", "userId", "username", "instanceHost", "verifiedAt"]
    .every((key) => typeof fields[key] === "string" && fields[key].length > 0);
}

export async function loadBinding(configDir: string, deploymentId: string): Promise<DeploymentBinding | undefined> {
  const path = bindingPath(configDir, deploymentId);
  const binding = await readPrivateJson(path);
  if (binding === undefined) return undefined;
  if (!isBinding(binding)) throw new Error(`Invalid deployment binding in ${path}.`);
  return binding;
}

export async function verifyDeployment(
  deploymentId: string, options: { rebind?: boolean; json?: boolean }, deps: VerifyDeps,
): Promise<void> {
  const configDir = deps.configDir();
  const path = bindingPath(configDir, deploymentId);
  let binding: DeploymentBinding;
  try {
    const source = await deps.createSource();
    const identity = await source.identity().finally(() => source.logout?.());
    binding = {
      version: 1,
      organizationId: identity.organizationId,
      userId: identity.userId,
      username: identity.username,
      instanceHost: new URL(identity.instanceUrl).host,
      verifiedAt: new Date().toISOString(),
    };
    if (!isBinding(binding)) throw new Error("Incomplete identity");
  } catch (error) {
    const { OAuthSignInRequiredError } = await import("./sources/salesforce/auth/oauth.js");
    if (error instanceof OAuthSignInRequiredError) throw error;
    throw new Error("Could not read the live Salesforce identity. Check the Salesforce login settings and try again.");
  }
  // Serialize the read and rename so simultaneous first verifications cannot overwrite each other.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Verification lock exists at ${lockPath}. If no verification is running, remove it and retry.`);
  });
  try {
    const existing = await loadBinding(configDir, deploymentId);
    if (existing && !options.rebind &&
        (existing.organizationId !== binding.organizationId || existing.userId !== binding.userId)) {
      throw new Error(
        `Deployment "${deploymentId}" is bound to org ${existing.organizationId}, user ${existing.userId}. ` +
        `Live identity is org ${binding.organizationId}, user ${binding.userId}. Use --rebind to replace the binding.`,
      );
    }
    await (deps.writeJson ?? writePrivateJson)(path, binding);
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
  (deps.writeOutput ?? console.log)(options.json ? JSON.stringify(binding) :
    `Verified Salesforce org ${binding.organizationId}, user ${binding.userId} (${binding.username}) at ${binding.instanceHost}. Saved binding to ${path}.`);
}
