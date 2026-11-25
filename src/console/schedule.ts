import { formatDuration } from "../scheduler/schedule.js";
import type { ScheduleStatus } from "../stores/postgres/schedule.js";

function timeLabel(iso: string, now: number): string {
  const difference = Date.parse(iso) - now;
  const minutes = Math.round(Math.abs(difference) / 60_000);
  if (minutes < 1) return difference > 0 ? "soon" : "just now";
  const hours = Math.round(minutes / 60);
  const distance = minutes < 60 ? minutes + " min" : hours < 48 ? hours + " h" : Math.round(hours / 24) + " days";
  return difference > 0 ? "in " + distance : distance + " ago";
}

export function renderSchedule(status: ScheduleStatus, escapeHtml: (value: string) => string, now = Date.now()): string {
  const { settings } = status;
  const time = (iso: string | null, fallback = "Never", showUtc = false) => {
    if (!iso) return fallback;
    const utc = escapeHtml(iso.slice(0, 16).replace("T", " ") + " UTC");
    return `<time datetime="${escapeHtml(iso)}" title="${utc}">${timeLabel(iso, now)}${showUtc ? `<small>${utc}</small>` : ""}</time>`;
  };
  const input = (name: string, label: string, value: string, hint: string) =>
    `<label>${label}<input name="${name}" value="${escapeHtml(value)}" required><small>${hint}</small></label>`;
  const objects = status.events.map((event) => {
    const key = escapeHtml(event.objectKey);
    const interval = Object.hasOwn(settings.overrides, event.objectKey) ? formatDuration(settings.overrides[event.objectKey]!) : "";
    return `<tr data-object="${key}">
      <th scope="row">${key}</th>
      <td><input data-interval aria-label="${key} interval" placeholder="Default" value="${interval}"></td>
      <td><label><input type="checkbox" role="switch" data-events aria-label="Live updates for ${key}"${event.enabled ? " checked" : ""}>
        <span data-connection>${event.enabled ? event.connected ? "Connected" : "Disconnected" : "Off"}</span></label>
        <small>Last event <span data-event-time>${time(event.lastEventAt)}</span> · <span data-catch-up>${event.catchUpPolls} catch-up polls${event.catchUpPending ? " · pending" : ""}</span></small></td>
      <td><button type="button" data-clear="${key}" aria-label="Clear ${key} interval">Clear</button></td>
    </tr>`;
  }).join("");
  const activity = status.active ? status.runningUnit ? "Scheduler working" : "Scheduler active" : "Scheduler inactive";
  const usage = status.usage ? `${status.usage.used} / ${status.usage.dailyLimit} API calls used` : "API usage unavailable";
  const over = status.projectedCalls > status.budgetCalls;
  const rows = status.units.map((unit) => {
    const name = unit.kind === "inbound" ? "Salesforce → replica" :
      unit.kind === "outbound" ? "Replica → Salesforce (write-back)" : "Field definitions";
    return `<tr><th scope="row">${name}<small>${unit.keys.length ? escapeHtml(unit.keys.join(", ")) + " · " : ""}Every ${formatDuration(unit.intervalMs)}</small></th>
      <td data-last>${time(unit.last, "Never", true)}</td><td data-next>${time(unit.next, "Paused", true)}</td></tr>`;
  }).join("");
  return `<section class="detail" aria-labelledby="schedule-title">
    <div class="detail-head"><h2 id="schedule-title">Schedule</h2></div>
    <p id="schedule-activity" role="status"><span>${activity}</span><span id="schedule-heartbeat">${status.heartbeatAt ? " · Heartbeat " + time(status.heartbeatAt) : ""}</span></p>
    <p id="schedule-budget" class="${over ? "tone-warn" : ""}">
      <meter aria-label="Projected use of daily API budget" min="0" max="${Math.max(1, status.budgetCalls)}" value="${Math.min(status.projectedCalls, status.budgetCalls)}"></meter>
      <span>${usage} · ${status.projectedCalls} projected / ${status.budgetCalls} calls per day budgeted (${settings.budget}%)${over ? " · Over budget" : ""}</span></p>
    <p id="schedule-limit">${status.inboundPausedUntil ? "Inbound API limit pause until " + time(status.inboundPausedUntil) : ""}</p>
    <form id="schedule-form">
      <div class="schedule-fields">
        ${input("inbound", "Inbound interval", formatDuration(settings.inboundMs), "Min 1m · default 5m")}
        ${input("outbound", "Write-back interval", formatDuration(settings.outboundMs), "Min 1s · default 10s")}
        ${input("metadata", "Field definition interval", formatDuration(settings.metadataMs), "Min 1s · default 24h")}
        ${input("budget", "API budget (%)", String(settings.budget), "Min 1% · default 50%")}
      </div>
      ${objects ? `<div class="schedule-table"><table aria-label="Object schedule"><thead><tr><th scope="col">Object</th><th scope="col">Interval</th><th scope="col">Live updates</th><th scope="col">Reset interval</th></tr></thead><tbody id="schedule-objects">${objects}</tbody></table></div>
        <p><small>Blank intervals use the inbound default. Select objects in Salesforce Setup → Change Data Capture to enable live updates. Your org limits how many you can select.</small></p>` : ""}
      <button type="submit">Save schedule</button>
      <label><input id="schedule-paused" type="checkbox" role="switch"${settings.paused ? " checked" : ""}> Pause schedule</label>
    </form>
    <div class="schedule-table"><table aria-label="Scheduled units"><thead><tr><th scope="col">Unit</th><th scope="col">Last run</th><th scope="col">Next run</th></tr></thead>
      <tbody id="schedule-units">${rows}</tbody></table></div>
    <p id="schedule-feedback" class="feedback" role="alert"></p>
  </section>`;
}

export function scheduleScript(token: string, deploymentId: string): string {
  return `
  {
    const url = ${JSON.stringify("/api/schedule?deployment=" + encodeURIComponent(deploymentId))};
    const form = document.getElementById("schedule-form");
    const paused = document.getElementById("schedule-paused");
    const feedback = document.getElementById("schedule-feedback");
    const timeLabel = ${timeLabel.toString()};
    function time(iso, fallback, showUtc) {
      if (!iso) return fallback;
      const element = document.createElement("time");
      element.dateTime = iso;
      element.title = iso.slice(0, 16).replace("T", " ") + " UTC";
      element.textContent = timeLabel(iso, Date.now());
      if (showUtc) {
        const utc = document.createElement("small");
        utc.textContent = element.title;
        element.append(utc);
      }
      return element;
    }
    function render(schedule) {
      document.querySelector("#schedule-activity > span").textContent =
        schedule.active ? (schedule.runningUnit ? "Scheduler working" : "Scheduler active") : "Scheduler inactive";
      document.getElementById("schedule-heartbeat").replaceChildren(
        ...(schedule.heartbeatAt ? [" · Heartbeat ", time(schedule.heartbeatAt)] : []));
      const over = schedule.projectedCalls > schedule.budgetCalls;
      const budget = document.getElementById("schedule-budget");
      budget.classList.toggle("tone-warn", over);
      const meter = budget.querySelector("meter");
      meter.max = Math.max(1, schedule.budgetCalls);
      meter.value = Math.min(schedule.projectedCalls, schedule.budgetCalls);
      budget.querySelector("span").textContent =
        (schedule.usage ? schedule.usage.used + " / " + schedule.usage.dailyLimit + " API calls used" : "API usage unavailable") +
        " · " + schedule.projectedCalls + " projected / " + schedule.budgetCalls + " calls per day budgeted (" +
        schedule.settings.budget + "%)" + (over ? " · Over budget" : "");
      document.getElementById("schedule-limit").replaceChildren(...(schedule.inboundPausedUntil
        ? ["Inbound API limit pause until ", time(schedule.inboundPausedUntil)] : []));
      document.getElementById("schedule-units").replaceChildren(...schedule.units.map(unit => {
        const row = document.createElement("tr");
        const title = document.createElement("th");
        title.scope = "row";
        const detail = document.createElement("small");
        const ms = unit.intervalMs;
        const interval = ms % 3600000 === 0 ? ms / 3600000 + "h" : ms % 60000 === 0 ? ms / 60000 + "m" : ms / 1000 + "s";
        detail.textContent = (unit.keys.length ? unit.keys.join(", ") + " · " : "") + "Every " + interval;
        title.append(unit.kind === "inbound" ? "Salesforce → replica" :
          unit.kind === "outbound" ? "Replica → Salesforce (write-back)" : "Field definitions", detail);
        row.append(title);
        row.insertCell().append(time(unit.last, "Never", true));
        row.insertCell().append(time(unit.next, "Paused", true));
        return row;
      }));
      for (const row of form.querySelectorAll("[data-object]")) {
        const event = schedule.events.find(event => event.objectKey === row.dataset.object);
        if (!event) continue;
        row.querySelector("[data-connection]").textContent = event.enabled ? event.connected ? "Connected" : "Disconnected" : "Off";
        row.querySelector("[data-event-time]").replaceChildren(time(event.lastEventAt, "Never"));
        row.querySelector("[data-catch-up]").textContent = event.catchUpPolls + " catch-up polls" + (event.catchUpPending ? " · pending" : "");
      }
    }
    window.setInterval(async () => {
      try {
        const response = await fetch(url);
        if (response.ok) render(await response.json());
      } catch {}
    }, 10000);
    async function edit(action, fields) {
      feedback.textContent = "";
      try {
        const response = await fetch(url, { method: "POST",
          headers: { "Content-Type": "application/json", "X-ReplCRM-Token": ${JSON.stringify(token)} },
          body: JSON.stringify({ action, ...fields }),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        return await response.json();
      } catch (error) {
        feedback.textContent = error.message;
      }
    }
    const rows = [...form.querySelectorAll("[data-object]")];
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form));
      fields.object = [];
      fields.clearOverrides = [];
      for (const row of rows) {
        const value = row.querySelector("[data-interval]").value.trim();
        if (value) fields.object.push(row.dataset.object + "=" + value);
        else fields.clearOverrides.push(row.dataset.object);
      }
      const schedule = await edit("set", fields);
      if (schedule) render(schedule);
    });
    paused.addEventListener("change", async () => {
      const requested = paused.checked;
      const schedule = await edit(requested ? "pause" : "resume");
      paused.checked = schedule ? schedule.settings.paused : !requested;
      if (schedule) render(schedule);
    });
    for (const row of rows) {
      const toggle = row.querySelector("[data-events]");
      toggle.addEventListener("change", async () => {
        const requested = toggle.checked;
        toggle.disabled = true;
        const schedule = await edit(requested ? "set" : "clear", { events: row.dataset.object });
        toggle.disabled = false;
        if (schedule) render(schedule);
        else toggle.checked = !requested;
      });
      row.querySelector("[data-clear]").addEventListener("click", async () => {
        const schedule = await edit("clear", { object: row.dataset.object });
        if (schedule) {
          row.querySelector("[data-interval]").value = "";
          render(schedule);
        }
      });
    }
  }
  `;
}
