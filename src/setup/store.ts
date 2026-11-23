import { join } from "node:path";
import { readPrivateJson, safeDeploymentFileName, writePrivateJson } from "../cli-config-dir.js";

// Setup answers saved by the console or CLI wizard. Files are written owner-only (0600), next to the
// stored sign-ins and object selections. Environment variables always win over saved values.

export interface SavedApp { clientId: string; loginUrl: string }

function databasePath(configDir: string): string {
  return join(configDir, "setup", "database.json");
}

function appPath(configDir: string, deploymentId: string): string {
  return join(configDir, "setup", "apps", `${safeDeploymentFileName(deploymentId)}.json`);
}

export async function loadSavedDatabaseUrl(configDir: string): Promise<string | undefined> {
  const value = await readPrivateJson(databasePath(configDir));
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    !("url" in value) || typeof value.url !== "string") {
    throw new Error(`Invalid saved database setting at ${databasePath(configDir)}.`);
  }
  return value.url;
}

export async function saveDatabaseUrl(configDir: string, url: string): Promise<void> {
  await writePrivateJson(databasePath(configDir), { version: 1, url });
}

export async function loadSavedApp(configDir: string, deploymentId: string): Promise<SavedApp | undefined> {
  const path = appPath(configDir, deploymentId);
  const value = await readPrivateJson(path);
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    !("clientId" in value) || typeof value.clientId !== "string" ||
    !("loginUrl" in value) || typeof value.loginUrl !== "string") {
    throw new Error(`Invalid saved Salesforce app setting at ${path}.`);
  }
  return { clientId: value.clientId, loginUrl: value.loginUrl };
}

export async function saveApp(configDir: string, deploymentId: string, app: SavedApp): Promise<void> {
  await writePrivateJson(appPath(configDir, deploymentId), { version: 1, ...app });
}
