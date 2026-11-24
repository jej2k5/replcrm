import { parseArgs } from "node:util";
import type { PolicyEdit } from "./writeback/policy.js";
import type { CanonicalValue } from "./core/source.js";
import type { FileLock } from "./locks/file-lock.js";
import { ChangeRequestProcessor, submitChange } from "./writeback/index.js";
import { processQueue, recoverSending } from "./writeback/queue.js";
import type { ChangeAuthorKind, ChangeStatus, WritebackStore } from "./writeback/requests.js";

export const writebackUsage = [
  "writeback status [--json]",
  "writeback enable <object> | writeback disable <object>",
  "writeback exclude <object> <field...> | writeback include <object> <field...>",
].join("\n  ");

function requireKnownKeys(requested: string[], valid: string[], kind: string): void {
  const known = new Set(valid);
  const unknown = [...new Set(requested.filter((key) => !known.has(key)))];
  if (unknown.length) {
    throw new Error(`Unknown ${kind}: ${unknown.join(", ")}. Valid keys: ${[...valid].sort().join(", ") || "(none)"}.`);
  }
}

export async function runWriteback(args: string[], deploymentId: string, store: WritebackStore): Promise<void> {
  const [command, ...rest] = args;
  if (command === "status") {
    const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    const keys = (await store.listPersistedEntityKeys(deploymentId)).sort();
    const objects = await Promise.all(keys.map(async (entityKey) => ({
      entityKey, ...await store.getWritebackPolicy(deploymentId, entityKey),
    })));
    console.log(values.json ? JSON.stringify({ deploymentId, objects }) : [
      "Object\tWrite-back\tExcluded fields",
      ...objects.map(({ entityKey, enabled, excludedAttributeKeys }) =>
        `${entityKey}\t${enabled ? "enabled" : "disabled"}\t${excludedAttributeKeys.join(", ") || "(none)"}`),
    ].join("\n"));
    return;
  }

  const [entityKey, ...keys] = rest;
  let edit: PolicyEdit;
  if ((command === "enable" || command === "disable") && entityKey && !keys.length) {
    edit = { action: command };
  } else if ((command === "exclude" || command === "include") && entityKey && keys.length) {
    edit = { action: command, keys };
  } else {
    throw new Error(`Usage: replcrm ${writebackUsage}`);
  }

  requireKnownKeys([entityKey], await store.listPersistedEntityKeys(deploymentId), "object");
  if ("keys" in edit) {
    const entity = await store.readEntity(deploymentId, entityKey);
    if (!entity) throw new Error(`Object ${entityKey} no longer has persisted metadata`);
    requireKnownKeys(edit.keys, entity.attributes.map(({ key }) => key), "field");
  }
  const policy = await store.editWritebackPolicy(deploymentId, entityKey, edit);
  console.log(`${entityKey}: ${policy.enabled ? "enabled" : "disabled"}. Excluded fields: ${policy.excludedAttributeKeys.join(", ") || "(none)"}.`);
}

export const changesUsage = [
  "changes submit --object <object> (--record <id> | --create) --set field=value ... [--base field=value ...] [--author agent:<label>] [--reason <text>] [--json]",
  "changes list [--status <status>] [--object <object>] [--json] | changes show <id> [--json]",
  "changes retry <id> | changes override <id> --keep replica|salesforce --operator <label>",
  "changes resolve <id> (--link <sourceId> | --resubmit | --abandon) --operator <label>",
  "changes process [--watch] [--interval 10]",
].join("\n  ");

const statuses: readonly ChangeStatus[] = [
  "pending", "sending", "applied", "conflict", "overridden", "rejected", "failed", "unknown",
];

const json = { type: "boolean" } as const;
const string = { type: "string" } as const;
const repeated = { type: "string", multiple: true } as const;

function assignments(items: string[] = []): Map<string, string> {
  const fields = new Map<string, string>();
  for (const item of items) {
    const index = item.indexOf("=");
    if (index < 1) throw new Error(`Expected field=value, got ${item}`);
    const key = item.slice(0, index);
    if (fields.has(key)) throw new Error(`Duplicate field ${key}`);
    fields.set(key, item.slice(index + 1));
  }
  return fields;
}

function cliValue(raw: string, type?: string): CanonicalValue {
  if (raw === "null") return null;
  if (raw.startsWith('"') || ["Boolean", "MultiEnum", "Address", "Geolocation", "Reference", "Composition"].includes(type ?? "")) {
    return JSON.parse(raw) as CanonicalValue;
  }
  return raw;
}

export async function runChanges(args: string[], deploymentId: string, store: WritebackStore, deps: {
  acquire: (label: string) => Promise<FileLock>;
  processor: (needsSource: boolean) => Promise<ChangeRequestProcessor>;
  onSignal?: ((signal: "SIGINT" | "SIGTERM", handler: () => Promise<void>) => () => void) | undefined;
  wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}): Promise<number> {
  const [command, ...rest] = args;
  if (command === "submit") {
    const { values } = parseArgs({ args: rest, options: {
      object: string, record: string, create: json, set: repeated, base: repeated, author: string, reason: string, json,
    } });
    if (!values.object || Boolean(values.record) === Boolean(values.create)) {
      throw new Error("Supply --object and exactly one of --record or --create");
    }
    const set = assignments(values.set);
    const base = assignments(values.base);
    if (!set.size) throw new Error("Supply at least one --set field=value");
    if (base.size && (values.create || [...base.keys()].some((key) => !set.has(key)))) {
      throw new Error("Supply bases only for fields being updated");
    }
    const entity = await store.readEntity(deploymentId, values.object);
    if (!entity) throw new Error(`Unknown object ${values.object}`);
    const types = new Map(entity.attributes.map(({ key, dataType }) => [key, dataType]));
    let snapshot: Record<string, CanonicalValue> | undefined;
    if (values.record && !base.size) {
      if (!store.readWritebackValues) throw new Error("Replica base values are unavailable");
      const current = await store.readWritebackValues(deploymentId, values.object, values.record);
      if (!current) throw new Error("Update target record does not exist");
      snapshot = current;
    }
    const [kind, ...label] = (values.author ?? "person:CLI").split(":");
    const request = await submitChange(store, {
      deploymentId, entityKey: values.object, operation: values.create ? "create" : "update",
      ...(values.record && { targetRecordId: values.record }),
      fields: Object.fromEntries([...set].map(([key, value]) => {
        const type = types.get(key);
        return [key, {
          value: cliValue(value, type),
          ...(snapshot ? { base: Object.hasOwn(snapshot, key) ? snapshot[key] ?? null : null }
            : base.has(key) ? { base: cliValue(base.get(key)!, type) } : {}),
        }];
      })),
      authorKind: kind as ChangeAuthorKind, authorLabel: label.join(":"),
      ...(values.reason !== undefined && { reason: values.reason }),
    });
    if (snapshot) console.error("Base values were read from the replica.");
    console.log(values.json ? JSON.stringify(request) : `${request.id}\t${request.status}`);
    return 0;
  }

  if (command === "list") {
    const { values } = parseArgs({ args: rest, options: { status: string, object: string, json } });
    const status = values.status as ChangeStatus | undefined;
    if (status !== undefined && !statuses.includes(status)) throw new Error(`Unknown status ${status}`);
    const requests = await store.listChangeRequests(deploymentId, {
      ...(status && { status }), ...(values.object && { entityKey: values.object }),
    });
    console.log(values.json ? JSON.stringify(requests) : [
      "ID\tStatus\tObject", ...requests.map((request) => `${request.id}\t${request.status}\t${request.entityKey}`),
    ].join("\n"));
    return 0;
  }

  if (command === "process") {
    const { values } = parseArgs({ args: rest, options: { watch: json, interval: string } });
    const interval = Number(values.interval ?? 10) * 1000;
    if (!Number.isFinite(interval) || interval < 1 || interval > 2_147_483_647) {
      throw new Error("Supply a positive --interval in seconds within the timer range");
    }
    const stop = new AbortController();
    const removers = (["SIGINT", "SIGTERM"] as const).map((signal) =>
      deps.onSignal?.(signal, async () => { stop.abort(); }));
    try {
      await processQueue({
        store, deploymentId, processor: () => deps.processor(true), acquire: () => deps.acquire("changes process"),
        signal: stop.signal, intervalMs: values.watch ? interval : undefined, wait: deps.wait,
      });
      return stop.signal.aborted ? 130 : 0;
    } finally {
      for (const remove of removers) remove?.();
    }
  }

  if (command !== "show" && command !== "retry" && command !== "override" && command !== "resolve") {
    throw new Error(`Usage: replcrm ${changesUsage}`);
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    ...(command === "show" && { json }),
    ...(command === "override" && { keep: string, operator: string }),
    ...(command === "resolve" && { link: string, resubmit: json, abandon: json, operator: string }),
  } });
  const [id] = positionals;
  if (!id || positionals.length !== 1) throw new Error("Supply one change request ID");
  const read = async () => {
    const request = await store.getChangeRequest(deploymentId, id);
    if (!request) throw new Error(`Unknown change request ${id}`);
    return request;
  };
  if (command === "show") {
    console.log(JSON.stringify(await read(), null, values.json ? undefined : 2));
    return 0;
  }

  const lock = await deps.acquire(`changes ${command}`);
  try {
    const request = await read();
    if (command === "retry") {
      if (request.status !== "failed") throw new Error("Only a failed request can be retried");
      await store.transitionChangeRequest(deploymentId, id, "failed", { status: "pending", retryAfter: null }, request.updatedAt);
    } else {
      if (typeof values.operator !== "string" || !values.operator.trim()) throw new Error("An operator label is required");
      if (command === "override") {
        if (request.status !== "conflict") throw new Error("Only a conflicting request can be overridden");
        if (values.keep !== "replica" && values.keep !== "salesforce") throw new Error("Supply --keep replica or salesforce");
        const replica = values.keep === "replica";
        const processor = await deps.processor(replica);
        await processor.overrideConflict(request, {
          operatorLabel: values.operator, side: replica ? "replica" : "source", time: new Date().toISOString(),
        });
      } else {
        if (request.status !== "unknown") throw new Error("Only an unknown request can be resolved");
        if ([values.link !== undefined, values.resubmit, values.abandon].filter(Boolean).length !== 1) {
          throw new Error("Supply exactly one of --link, --resubmit or --abandon");
        }
        if (values.link === "") throw new Error("A source record ID is required");
        const processor = await deps.processor(Boolean(values.link));
        await processor.resolveUnknown(request, typeof values.link === "string" && values.link ? { linkSourceId: values.link }
          : values.resubmit ? { resubmit: true } : { abandon: true }, values.operator);
      }
    }
    const current = await read();
    console.log(`${id}\t${current.status}`);
    return 0;
  } catch (error) {
    if (command === "override") await recoverSending(store, deploymentId);
    throw error;
  } finally {
    await lock.release();
  }
}
