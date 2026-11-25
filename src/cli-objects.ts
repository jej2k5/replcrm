import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readPrivateJson, safeDeploymentFileName, writePrivateJson } from "./cli-config-dir.js";
import type { ReplicaView } from "./core/replica-store.js";
import type { ReplicationConfig } from "./core/config.js";
import { selectEntityKeys } from "./core/orchestrator.js";
import type { SourceObjectListing } from "./sources/salesforce/client.js";

type AvailableObject = Pick<SourceObjectListing, "name" | "label" | "custom">;
interface ObjectSource {
  listReplicableObjects(): Promise<AvailableObject[]>;
  logout(): Promise<void>;
}

export interface ObjectsDeps {
  listViews?(deploymentId: string): Promise<ReplicaView[]>;
  configDir(): string;
  fallbackSource(): "SYNC_ENTITIES" | "default";
  createSource(): ObjectSource | Promise<ObjectSource>;
}

export function parseEntityList(value: string): string[] {
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

function selectionPath(deps: ObjectsDeps, deploymentId: string): string {
  const name = safeDeploymentFileName(deploymentId);
  return join(deps.configDir(), "selections", `${name}.json`);
}

async function validateEntities(entities: string[]): Promise<void> {
  if (entities.length === 1 && entities[0] === "*") return;
  const { assertApiName } = await import("./sources/salesforce/api-name.js");
  for (const entity of entities) assertApiName(entity);
}

async function loadSelection(path: string): Promise<string[] | undefined> {
  const value = await readPrivateJson(path);
  if (value === undefined) return undefined;
  const error = new Error(`Invalid object selection at ${path}.`);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    !("entities" in value) || !Array.isArray(value.entities) ||
    !value.entities.every((entity): entity is string => typeof entity === "string")) throw error;
  try {
    await validateEntities(value.entities);
  } catch {
    throw error;
  }
  return value.entities;
}

export async function resolveSelection(config: ReplicationConfig, deps?: ObjectsDeps, flag?: string[]) {
  const path = deps && selectionPath(deps, config.deploymentId);
  if (flag !== undefined) return { entities: flag, source: "flag" };
  const saved = path === undefined ? undefined : await loadSelection(path);
  if (saved !== undefined) return { entities: saved, source: "saved" };
  return { entities: config.entityKeys, source: deps?.fallbackSource() ?? "default" };
}

/** The saved selection for one deployment, without falling back to SYNC_ENTITIES or the default. */
export async function loadSavedSelection(deps: ObjectsDeps, deploymentId: string): Promise<string[] | undefined> {
  return loadSelection(selectionPath(deps, deploymentId));
}

/** Saves an explicit selection for one deployment, as `objects set` does. */
export async function saveSelection(deps: ObjectsDeps, deploymentId: string, entities: string[]): Promise<void> {
  if (!entities.length) throw new Error("Choose at least one object.");
  await validateEntities(entities);
  await writePrivateJson(selectionPath(deps, deploymentId), { version: 1, entities });
}

export const objectsUsage = [
  "objects available [--json]",
  "objects list [--entities a,b] [--json]",
  "objects columns <Object> [--json]",
  "objects set a,b | objects add a[,b] | objects remove a[,b] | objects clear",
].join("\n  ");

export async function runObjects(args: string[], config: ReplicationConfig, deps: ObjectsDeps): Promise<void> {
  const [command, ...rest] = args;
  safeDeploymentFileName(config.deploymentId);
  if (command === "available") {
    const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    const source = await deps.createSource();
    try {
      const objects = await source.listReplicableObjects();
      const byName = new Map(objects.map((item) => [item.name, item]));
      const allowed = await selectEntityKeys({ ...config, entityKeys: ["*"] }, {
        listEntities: async () => [...byName.keys()],
      });
      const rows = allowed.sort().map((key) => {
        const { name, label, custom } = byName.get(key)!;
        return { name, label, custom };
      });
      console.log(values.json ? JSON.stringify(rows) : [
        "Name\tLabel\tCustom", ...rows.map(({ name, label, custom }) => `${name}\t${label}\t${custom}`),
      ].join("\n"));
    } finally {
      await source.logout();
    }
    return;
  }
  if (command === "list") {
    const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" }, entities: { type: "string" } } });
    const selection = await resolveSelection(config, deps,
      values.entities === undefined ? undefined : parseEntityList(values.entities));
    const views = (await deps.listViews?.(config.deploymentId) ?? [])
      .filter(({ entityKey }) => selection.entities.includes("*") || selection.entities.includes(entityKey));
    console.log(values.json ? JSON.stringify({ ...selection, ...(views.length && { views }) }) : [
      `${selection.source}: ${selection.entities.join(",") || "(none)"}`,
      ...views.map(({ entityKey, view, suffixed, columns }) => [
        `${entityKey}\t${view}${suffixed ? " (suffixed)" : ""}`,
        ...columns.filter((column) => column.suffixed).map(({ sourceField, column }) => `  ${sourceField}\t${column}`),
      ].join("\n")),
    ].join("\n"));
    return;
  }
  if (command === "columns") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean" } } });
    if (positionals.length !== 1) throw new Error("Usage: replcrm objects columns <Object> [--json]");
    const [key] = positionals;
    const views = await deps.listViews?.(config.deploymentId) ?? [];
    const view = views.find(({ entityKey }) => entityKey === key);
    if (!view) throw new Error(`No published replica view for ${key}.`);
    console.log(values.json ? JSON.stringify(view) : [
      view.view, "Source field\tColumn", ...view.columns.map(({ sourceField, column }) => `${sourceField}\t${column}`),
    ].join("\n"));
    return;
  }
  const path = selectionPath(deps, config.deploymentId);
  if (command === "clear" && rest.length === 0) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  if ((command === "set" || command === "add" || command === "remove") && rest.length === 1) {
    const requested = parseEntityList(rest[0]!);
    if (!requested.length) throw new Error("Provide at least one Salesforce API name or *.");
    await validateEntities(requested);
    let entities = requested;
    if (command !== "set") {
      const current = (await resolveSelection(config, deps)).entities;
      if (command === "remove" && current.includes("*") && !requested.includes("*")) {
        throw new Error("Use objects set with explicit names to replace a wildcard selection.");
      }
      entities = command === "add"
        ? [...current, ...requested.filter((key) => !current.includes(key))]
        : current.filter((key) => !requested.includes(key));
      await validateEntities(entities);
    }
    await writePrivateJson(path, { version: 1, entities });
    return;
  }
  throw new Error(`Usage: replcrm ${objectsUsage}`);
}
