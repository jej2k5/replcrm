import { setTimeout as sleep } from "node:timers/promises";
import type { ChangeNotification, ChangeSubscription } from "../../core/source.js";

export interface Frame {
  channel?: string;
  successful?: boolean;
  clientId?: string;
  error?: string;
  ext?: { replay?: boolean };
  advice?: { reconnect?: "retry" | "handshake" | "none"; interval?: number; timeout?: number };
  data?: { event?: { replayId?: number }; payload?: { ChangeEventHeader?: { changeType?: string; recordIds?: string[] } } };
}

export function eventName(key: string): string {
  return key.endsWith("__c") ? key.slice(0, -1) + "ChangeEvent" : key + "ChangeEvent";
}

const kinds = new Map<string, ChangeNotification["kind"]>([
  ["CREATE", "create"], ["UPDATE", "update"], ["DELETE", "delete"], ["UNDELETE", "restore"],
]);
const unknown = (frame?: Frame) => frame?.error?.startsWith("403::Unknown client") === true;
// The transport only sends cookies back to the exact endpoint that set them.
export class StreamCookies {
  private endpoint = "";
  private readonly values = new Map<string, { pair: string; expires: number }>();

  header(endpoint: string, now: number): string {
    if (endpoint !== this.endpoint) {
      this.values.clear();
      this.endpoint = endpoint;
    }
    return [...this.values.values()].filter(({ expires }) => expires > now).map(({ pair }) => pair).join("; ");
  }

  remember(endpoint: string, headers: Headers, now: number): void {
    const url = new URL(endpoint);
    for (const cookie of headers.getSetCookie()) {
      const [pair, ...directives] = cookie.split(";").map((part) => part.trim());
      const equals = pair?.indexOf("=") ?? -1;
      if (!pair || equals <= 0) continue;
      const attributes = new Map(directives.map((directive) => {
        const index = directive.indexOf("=");
        return index < 0 ? [directive.toLowerCase(), ""] : [directive.slice(0, index).toLowerCase(), directive.slice(index + 1)];
      }));
      const path = attributes.get("path") ?? url.pathname.slice(0, url.pathname.lastIndexOf("/"));
      if (url.pathname !== path && !url.pathname.startsWith(path.endsWith("/") ? path : path + "/")) continue;
      const domain = attributes.get("domain")?.toLowerCase().replace(/^\./, "");
      if (domain && url.hostname !== domain && !url.hostname.endsWith("." + domain)) continue;
      if (attributes.has("secure") && url.protocol !== "https:") continue;
      const maxAge = attributes.get("max-age");
      const expiry = Date.parse(attributes.get("expires") ?? "");
      const expires = maxAge && /^-?\d+$/.test(maxAge) ? now + Number(maxAge) * 1_000
        : Number.isFinite(expiry) ? expiry : Infinity;
      const key = pair.slice(0, equals) + ";" + path + ";" + (domain ?? "");
      this.values.delete(key);
      if (expires > now) this.values.set(key, { pair, expires });
    }
  }
}

const interval = (advice: Frame["advice"]) => Math.min(300_000, Math.max(0, advice?.interval ?? 0));

export async function* streamChanges(
  { positions, signal, connectionChanged }: ChangeSubscription,
  send: (message: object, signal: AbortSignal) => Promise<Frame[]>,
  wait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }),
): AsyncGenerator<ChangeNotification> {
  const channels = new Map([...positions].map(([objectKey, position]): [string, { objectKey: string; position: string | null }] =>
    ["/data/" + eventName(objectKey), { objectKey, position }]));
  const request = (channel: string, fields: object, timeout = 30_000) =>
    send({ channel, ...fields }, AbortSignal.any([signal, AbortSignal.timeout(timeout)]));
  let restarted = false;
  let delay = 0;
  while (!signal.aborted && channels.size) {
    if (delay) await wait(delay, signal);
    const [handshake] = await request("/meta/handshake", {
      version: "1.0", supportedConnectionTypes: ["long-polling"], ext: { replay: true },
    });
    if (!handshake?.successful || !handshake.clientId || handshake.ext?.replay !== true) {
      throw new Error("Change event handshake failed or resume support is unavailable.");
    }
    const clientId = handshake.clientId;
    let reconnect = false;
    for (const [subscription, object] of channels) {
      const subscribe = async (replay: number) => (await request("/meta/subscribe", {
        clientId, subscription, ext: { replay: { [subscription]: replay } },
      }))[0];
      const replay = object.position === null ? -1 : Number(object.position);
      const valid = Number.isSafeInteger(replay) && replay >= 0;
      let response = await subscribe(valid ? replay : -1);
      if (unknown(response)) { reconnect = true; break; }
      if (object.position !== null && (!valid || (!response?.successful && /replay|retention/i.test(response?.error ?? "")))) {
        if (valid) response = await subscribe(-1);
        if (response?.successful) {
          object.position = null;
          yield { objectKey: object.objectKey, recordIds: [], kind: "resume-unavailable", position: null };
        }
      }
      if (unknown(response)) { reconnect = true; break; }
      if (!response?.successful) throw new Error("Change event subscription was refused.");
    }
    let advice = handshake.advice;
    let connected = false;
    let firstConnect = true;
    while (!signal.aborted && !reconnect) {
      if (advice?.reconnect === "none") throw new Error("Change event connection was closed.");
      if (interval(advice)) await wait(interval(advice), signal);
      const timeout = Math.min(300_000, Math.max(30_000, (advice?.timeout ?? 120_000) + 10_000));
      const messages = await request("/meta/connect", {
        clientId, connectionType: "long-polling", ...(firstConnect && { advice: { timeout: 0 } }),
      }, timeout);
      firstConnect = false;
      const reply = messages.find((message) => message.channel === "/meta/connect");
      advice = reply?.advice ?? advice;
      reconnect = unknown(reply) || advice?.reconnect === "handshake";
      if (reply?.successful && !reconnect) {
        restarted = false;
        if (!connected) await connectionChanged(true);
        connected = true;
      }
      for (const message of messages) {
        const object = channels.get(message.channel ?? "");
        const header = message.data?.payload?.ChangeEventHeader;
        if (!object || typeof header?.changeType !== "string") continue;
        const id = message.data?.event?.replayId;
        if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) object.position = String(id);
        yield { ...object, kind: kinds.get(header.changeType) ?? "catch-up",
          recordIds: Array.isArray(header.recordIds) ? header.recordIds.filter((value) => typeof value === "string") : [] };
      }
      if (!reply?.successful && !reconnect) {
        if (advice?.reconnect !== "retry" || !connected) throw new Error("Change event connection failed.");
        await connectionChanged(false);
        connected = false;
        if (!interval(advice)) await wait(1_000, signal);
      }
    }
    if (!reconnect || signal.aborted) return;
    await connectionChanged(false);
    if (restarted) throw new Error("Change event session could not be restored.");
    restarted = true;
    delay = interval(advice);
  }
}
