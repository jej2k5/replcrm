import type { ConsoleStatus } from "./status.js";

function escapeHtml(value: string | number): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (character) => entities[character]!);
}

const numberFormat = new Intl.NumberFormat("en-US");
const formatCount = (value: number | null | undefined): string => value === null || value === undefined ? "—" : numberFormat.format(value);

/** Plain-language check for one object: MATCH, "Off by N", or why it can't be compared. */
function checkLabel(status: string | null | undefined, store: number | null | undefined, source: number | null | undefined): string {
  if (status === "MATCH") return "MATCH";
  if (status === "DIFF" && store != null && source != null) return `Off by ${formatCount(Math.abs(source - store))}`;
  return "Not compared";
}

function checkTone(status: string | null | undefined): string {
  return status === "MATCH" ? "ok" : status === "DIFF" ? "warn" : "muted";
}

// Line icons redrawn from the README banner: database with rising arrow (logo), document with
// magnifier (Discover), gears (Reconstruct), database with gear (Replicate), cloud (CRM source).
const icons = `<svg width="0" height="0" class="sprite" aria-hidden="true"><defs>
<symbol id="i-logo" viewBox="0 0 32 32"><ellipse cx="14" cy="7" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 7v17c0 2.2 4.5 4 10 4M24 7v6M4 15.5c0 2.2 4.5 4 10 4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15 25l7-7 3 3 5-6M26 15h4v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-source" viewBox="0 0 24 24"><path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.6A3.5 3.5 0 0 0 7 18.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-discover" viewBox="0 0 24 24"><path d="M14 2H5v20h7M14 2l5 5v4M14 2v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 11h5M8 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="17" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.6 19.6L22 22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-reconstruct" viewBox="0 0 24 24"><circle cx="9" cy="10" r="2.8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 3.5v2M9 14.5v2M2.5 10h2M13.5 10h2M4.4 5.4l1.4 1.4M12.2 13.2l1.4 1.4M4.4 14.6l1.4-1.4M12.2 6.8l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17.5" cy="17.5" r="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M17.5 13.5v1.2M17.5 20.3v1.2M13.5 17.5h1.2M20.3 17.5h1.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-replicate" viewBox="0 0 24 24"><ellipse cx="11" cy="5" rx="7.5" ry="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 5v13c0 1.7 3.4 3 7.5 3M18.5 5v5M3.5 11.5c0 1.7 3.4 3 7.5 3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="17.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M18 13.3v1.4M18 20.3v1.4M13.8 17.5h1.4M20.8 17.5h1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-store" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3M5 3v5h5M19 21v-5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3l9.5 17h-19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-theme" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
<symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></symbol>
</defs></svg>`;

// The HONA LLC mark, as drawn in MCPxy's sidebar footer.
const honaMark = `<svg viewBox="0 0 78 104" width="11" height="15" aria-hidden="true"><path fill="var(--hona-grey)" d="M0 0 H47 V44 H31 V16 H16 V88 H0 Z"/><path fill="#00A0CA" d="M78 16 H62 V88 H47 V60 H31 V104 H78 Z"/></svg>`;


function sidebar(current: "replicas" | "setup"): string {
  const here = (name: string) => (current === name ? ' aria-current="page"' : "");
  return `<aside class="side">
  <a class="side-brand" href="/"><svg aria-hidden="true"><use href="#i-logo"/></svg><span><b>ReplCRM</b><small>console</small></span></a>
  <nav aria-label="Console">
    <span class="label">Operate</span>
    <a href="/"${here("replicas")}><svg class="icon" aria-hidden="true"><use href="#i-store"/></svg>Replicas</a>
    <a href="/#problems"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg>Problems <span class="muted" id="nav-problems-count"></span></a>
    <span class="label">Setup</span>
    <a href="/setup"${here("setup")}><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>Add replica</a>
  </nav>
  <div class="side-foot">
    <p class="hona" aria-label="Owned by HONA LLC">by ${honaMark} <b>HONA</b> LLC</p>
    <div class="side-tools"><button class="icon-btn" id="theme" type="button" aria-label="Switch light or dark theme"><svg class="icon" aria-hidden="true"><use href="#i-theme"/></svg></button></div>
  </div>
</aside>`;
}

const themeBoot = `try { const saved = localStorage.getItem("replcrm-theme"); if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved; } catch {}`;
const themeToggle = `
  document.getElementById("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("replcrm-theme", next); } catch {}
  });
`;

const styles = `
  @font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400 700; font-display: swap; src: url("/assets/console-font.woff2") format("woff2"); }
  /* The HONA family system, shared with MCPxy (see PRODUCT.md): warm graphite and stone paper at parity,
     mono for operations, flat hairline surfaces. ReplCRM blue is the single accent. */
  :root, :root[data-theme="dark"] {
    color-scheme: dark;
    --s950: oklch(0.13 0.006 70); --s900: oklch(0.17 0.006 70); --s800: oklch(0.22 0.007 70); --s700: oklch(0.27 0.008 70); --s600: oklch(0.34 0.009 70);
    --t100: oklch(0.94 0.006 80); --t200: oklch(0.86 0.007 80); --t300: oklch(0.78 0.008 80); --t400: oklch(0.70 0.009 75); --t500: oklch(0.58 0.009 75);
    --accent: oklch(0.72 0.12 245); --accent-hi: oklch(0.80 0.11 240); --accent-ink: oklch(0.14 0.006 250); --accent-wash: oklch(0.72 0.12 245 / .14);
    --ok: oklch(0.72 0.13 145); --warn: oklch(0.80 0.15 80); --err: oklch(0.70 0.16 28); --denied: oklch(0.68 0.15 310);
    --mark: #36cbfd; --hona-grey: #8e9597;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
      --s950: oklch(0.985 0.004 75); --s900: oklch(0.96 0.005 75); --s800: oklch(0.93 0.006 75); --s700: oklch(0.88 0.007 75); --s600: oklch(0.82 0.009 75);
      --t100: oklch(0.22 0.008 75); --t200: oklch(0.30 0.008 75); --t300: oklch(0.40 0.009 75); --t400: oklch(0.48 0.009 75); --t500: oklch(0.55 0.009 75);
      --accent: oklch(0.47 0.13 250); --accent-hi: oklch(0.40 0.13 250); --accent-ink: oklch(0.98 0.005 250); --accent-wash: oklch(0.47 0.13 250 / .10);
      --ok: oklch(0.48 0.14 145); --warn: oklch(0.52 0.15 70); --err: oklch(0.50 0.18 28); --denied: oklch(0.48 0.16 310);
      --mark: #1e88e5;
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --s950: oklch(0.985 0.004 75); --s900: oklch(0.96 0.005 75); --s800: oklch(0.93 0.006 75); --s700: oklch(0.88 0.007 75); --s600: oklch(0.82 0.009 75);
    --t100: oklch(0.22 0.008 75); --t200: oklch(0.30 0.008 75); --t300: oklch(0.40 0.009 75); --t400: oklch(0.48 0.009 75); --t500: oklch(0.55 0.009 75);
    --accent: oklch(0.47 0.13 250); --accent-hi: oklch(0.40 0.13 250); --accent-ink: oklch(0.98 0.005 250); --accent-wash: oklch(0.47 0.13 250 / .10);
    --ok: oklch(0.48 0.14 145); --warn: oklch(0.52 0.15 70); --err: oklch(0.50 0.18 28); --denied: oklch(0.48 0.16 310);
    --mark: #1e88e5;
  }
  :root { --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --ease: cubic-bezier(.25, 1, .5, 1); }
  * { box-sizing: border-box; }
  html { background: var(--s900); scrollbar-color: var(--s600) var(--s900); }
  body { margin: 0; min-height: 100vh; color: var(--t100); background: var(--s900); font: 13.5px/1.55 var(--mono); font-variant-numeric: tabular-nums; caret-color: var(--accent); }
  ::selection { background: var(--accent-wash); color: var(--t100); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  h1, h2, h3, p { margin: 0; overflow-wrap: anywhere; }
  a { color: inherit; }
  .sprite { position: absolute; }
  .icon { width: 18px; height: 18px; flex: none; }
  .prose { font-family: var(--sans); font-size: 14px; color: var(--t300); max-width: 72ch; }
  .label { font-size: .6875rem; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--t500); }

  .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
  .side { background: var(--s950); border-right: 1px solid var(--s700); display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
  .side-brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 14px; border-bottom: 1px solid var(--s700); text-decoration: none; }
  .side-brand svg { width: 26px; height: 26px; color: var(--mark); }
  .side-brand b { display: block; font-weight: 600; font-size: 14px; }
  .side-brand small { display: block; font-size: 11px; color: var(--t500); }
  .side nav { padding: 14px 8px; display: grid; gap: 2px; }
  .side nav .label { padding: 12px 10px 4px; }
  .side nav .label:first-child { padding-top: 2px; }
  .side nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; text-decoration: none; color: var(--t200); border-radius: 3px; }
  .side nav a:hover { background: var(--s800); }
  .side nav a[aria-current="page"] { background: var(--accent-wash); color: var(--accent-hi); }
  .side nav a .icon { width: 15px; height: 15px; color: var(--t400); }
  .side nav a[aria-current="page"] .icon { color: var(--accent); }
  .side-foot { margin-top: auto; border-top: 1px solid var(--s700); }
  .hona { margin: 0; display: flex; justify-content: center; align-items: center; gap: 6px; padding: 12px; font-size: 11px; color: var(--t500); text-decoration: none; border-bottom: 1px solid var(--s700); }
  .hona b { color: var(--t300); font-weight: 600; letter-spacing: .15em; }
  .side-tools { display: flex; justify-content: flex-end; gap: 4px; padding: 8px 10px; }
  .icon-btn { background: transparent; border: 0; color: var(--t400); padding: 6px; border-radius: 3px; cursor: pointer; display: inline-flex; }
  .icon-btn:hover { background: var(--s800); color: var(--t100); }

  main { padding: 26px clamp(16px, 3vw, 40px) 56px; display: grid; gap: 30px; align-content: start; min-width: 0; }
  main > * { min-width: 0; }
  .page-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .page-head > div { flex: 1 1 320px; display: grid; gap: 4px; }
  h1 { font-size: 21px; font-weight: 500; letter-spacing: -.01em; }
  h2 { font-size: 15px; font-weight: 600; }
  button { font: 500 13px/1 var(--mono); color: var(--t100); background: transparent; border: 1px solid var(--s600); border-radius: 3px;
    padding: 9px 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; transition: background .12s var(--ease), border-color .12s var(--ease); }
  button:hover { background: var(--s800); border-color: var(--t500); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.primary:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
  button:disabled { opacity: .5; cursor: progress; }
  button .icon { width: 14px; height: 14px; }

  /* Health strip: one row of labelled readouts, never metric tiles. */
  .strip { display: flex; flex-wrap: wrap; border-top: 1px solid var(--s700); border-bottom: 1px solid var(--s700); background: var(--s950); margin: 0 calc(-1 * clamp(16px, 3vw, 40px)); padding: 14px clamp(16px, 3vw, 40px); gap: 12px 0; }
  .strip > div { display: grid; gap: 4px; padding-right: 36px; margin-right: 36px; border-right: 1px solid var(--s700); }
  .strip > div:last-child { border-right: 0; }
  .strip dd { margin: 0; font-size: 14px; font-weight: 500; display: inline-flex; align-items: center; gap: 7px; }
  .strip dd small { color: var(--t500); font-weight: 400; font-size: 12px; }
  .glyph { width: 13px; height: 13px; flex: none; }
  .tone-ok { color: var(--ok); } .tone-warn { color: var(--warn); } .tone-bad { color: var(--err); } .tone-live { color: var(--accent); } .tone-muted { color: var(--t400); }

  /* Pipelines: one per replica, drawn like the banner. */
  .pipes { display: grid; border: 1px solid var(--s700); border-radius: 4px; background: var(--s950); }
  .pipe { display: grid; grid-template-columns: minmax(180px, 1fr) 5fr; gap: 18px; align-items: center; padding: 14px 16px; color: inherit; text-decoration: none; border-bottom: 1px solid var(--s700); position: relative; }
  .pipe:last-child { border-bottom: 0; }
  .pipe:hover { background: var(--s900); }
  .pipe[aria-current="true"] { background: var(--accent-wash); }
  .pipe[aria-current="true"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--accent); }
  .pipe-name b { display: block; font-size: 14px; font-weight: 600; }
  .pipe-name small { display: block; color: var(--t500); font-size: 11.5px; margin-top: 1px; }
  .pipe-name .state { display: inline-flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; }
  .stages { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 28px 1fr 28px 1fr 28px 1fr 28px 1fr; align-items: center; }
  .stage { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 1px solid var(--s700); border-radius: 3px; background: var(--s900); min-width: 0; transition: border-color .3s var(--ease), background .3s var(--ease); }
  .stage .icon { color: var(--t300); }
  .stage.is-active .icon { color: var(--accent); }
  .pipe:not(.is-running) .stage[data-stage="replicate"].is-ok .icon { color: var(--ok); }
  .stage b { display: block; font-size: 12px; font-weight: 600; }
  .stage small { display: block; color: var(--t400); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stage.is-active { border-color: var(--accent); background: var(--accent-wash); }
  .stage.is-warn { border-color: var(--warn); } .stage.is-warn .icon, .stage.is-warn small { color: var(--warn); }
  .stage.is-bad { border-color: var(--err); } .stage.is-bad .icon, .stage.is-bad small { color: var(--err); }
  .stage.settled { animation: settle 1.4s var(--ease); }
  @keyframes settle { 0% { border-color: var(--ok); background: color-mix(in oklch, var(--ok) 18%, transparent); } 100% { border-color: var(--s700); } }

  /* Connectors carry the data: dots stream along them, fast while a sync moves records. */
  .wire { height: 1px; position: relative; background: var(--s600); }
  .wire::after { content: ""; position: absolute; inset: -3px 0; background: radial-gradient(circle, var(--accent) 0 1.6px, transparent 2.2px) 0 50% / 12px 7px repeat-x;
    opacity: .3; animation: breathe 3s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: .2; } 50% { opacity: .5; } }
  .pipe.unreachable .wire::after, .pipe.unsigned .wire::after { opacity: 0; animation: none; }
  .pipe.is-running .wire::after { opacity: .35; animation: breathe 1.6s ease-in-out infinite; }
  .pipe.is-running .wire.is-hot { background: var(--accent); }
  .pipe.is-running .wire.is-hot::after { opacity: 1; animation: stream var(--flow, .8s) linear infinite; background-size: 9px 7px; }
  @keyframes stream { from { background-position-x: 0; } to { background-position-x: 48px; } }
  .pipe.paused { opacity: .55; }

  .detail { display: grid; gap: 16px; }
  .detail-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .text-link { color: var(--accent-hi); font-size: 12.5px; text-underline-offset: 3px; }
  .facts { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px 0; border: 1px solid var(--s700); border-radius: 4px; padding: 12px 0; background: var(--s950); }
  .facts > div { display: grid; gap: 4px; align-content: start; padding: 0 16px; border-left: 1px solid var(--s700); }
  .facts > div:first-child { border-left: 0; }
  .facts dd { margin: 0; font-size: 14px; font-weight: 500; }
  .facts dd small { color: var(--t500); font-weight: 400; font-size: 11.5px; }
  .counter { display: inline-block; min-width: 1ch; }

  .sync { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
  .sync .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .sync-state { display: flex; align-items: center; gap: 8px; color: var(--t200); }
  .sync details { flex-basis: 100%; }
  .sync summary { cursor: pointer; color: var(--t400); font-size: 12px; width: max-content; }
  #run-lines { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow-y: auto; font: 12px/1.6 var(--mono);
    color: var(--t300); background: var(--s950); border: 1px solid var(--s700); border-radius: 3px; padding: 10px 12px; }
  .feedback { color: var(--warn); flex-basis: 100%; }
  .feedback:empty { display: none; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }

  .table-scroll { overflow-x: auto; border: 1px solid var(--s700); border-radius: 4px; background: var(--s950); }
  table { border-collapse: collapse; width: 100%; white-space: nowrap; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--s800); }
  thead th { font-size: .6875rem; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--t500); border-bottom-color: var(--s700); }
  tbody tr:nth-child(even) { background: color-mix(in oklch, var(--s900) 60%, transparent); }
  tbody tr:last-child > * { border-bottom: 0; }
  tbody th { font-weight: 500; color: var(--t100); }
  .number { text-align: right; }
  .check { font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  .check.ok { color: var(--ok); } .check.warn { color: var(--warn); } .check.muted { color: var(--t400); font-weight: 400; }
  .run-status { color: var(--t400); font-size: 12px; }
  .run-status[data-status="Failed"] { color: var(--err); }
  .empty { color: var(--t400); padding: 20px 14px; }

  .problems ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--s700); border-radius: 4px; background: var(--s950); }
  .problems li { display: grid; grid-template-columns: 150px 1fr; gap: 4px 16px; padding: 10px 14px; border-bottom: 1px solid var(--s800); }
  .problems li:last-child { border-bottom: 0; }
  .problems time { color: var(--t500); font-size: 12px; }
  .problems .what { color: var(--err); font-weight: 500; }
  .problems .interrupted { color: var(--warn); }
  .problems ul:empty { display: none; }
  .attention { margin-bottom: 10px !important; }
  .problems li.needs { grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; color: var(--t200); }
  .problems li.needs .glyph { color: var(--warn); }
  .problems li.needs b { font-weight: 600; color: var(--t100); }
  .problems li.resolved .what, .problems li.resolved { color: var(--t400); }
  .problems li small { color: var(--t500); font-size: 12px; }
  .muted { color: var(--t400); }

  @media (max-width: 1100px) { .pipe { grid-template-columns: 1fr; gap: 10px; } }
  @media (max-width: 860px) {
    .shell { grid-template-columns: 1fr; }
    .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; border-right: 0; border-bottom: 1px solid var(--s700); }
    .side-brand { border-bottom: 0; }
    .side nav { display: flex; flex-wrap: wrap; padding: 6px 8px; gap: 4px; }
    .side nav .label { display: none; }
    .side-foot { margin: 0 0 0 auto; border-top: 0; display: flex; }
    .hona { border-bottom: 0; }
  }
  @media (max-width: 640px) {
    .stages { grid-template-columns: 36px 1fr 36px 1fr 36px 1fr 36px 1fr 36px; }
    .stage { width: 36px; height: 36px; padding: 0; justify-content: center; position: relative; }
    .stage > div { display: none; }
    .stage.is-active > div, .stage.is-warn > div, .stage.is-bad > div { display: block; position: absolute; top: 40px; left: 50%; transform: translateX(-50%); white-space: nowrap; text-align: center; }
    .stage.is-active > div small, .stage.is-warn > div small, .stage.is-bad > div small { display: none; }
    .pipe:has(.stage.is-active, .stage.is-warn, .stage.is-bad) .stages { margin-bottom: 18px; }
    .detail .table-scroll th:nth-child(n+5), .detail .table-scroll td:nth-child(n+5) { display: none; }
    .detail .table-scroll table { white-space: normal; }
    .detail .table-scroll th, .detail .table-scroll td { padding: 9px 10px; }
    .detail .table-scroll tbody th { overflow-wrap: anywhere; }
    .strip > div { border-right: 0; margin-right: 0; padding-right: 22px; }
    .facts > div { border-left: 0; }
    .problems li { grid-template-columns: 1fr; }
    .side-foot { flex-direction: row; align-items: center; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
`;


const setupStyles = `
  .build { border: 1px solid var(--s700); border-radius: 4px; background: var(--s950); }
  .build .pipe { border-bottom: 0; }
  .stage.is-todo { border-style: dashed; background: transparent; }
  .stage.is-todo .icon, .stage.is-todo b, .stage.is-todo small { color: var(--t500); }
  .stage.is-done .icon { color: var(--ok); }
  .pipe.building .wire::after { opacity: 0; animation: none; }
  .pipe.building .wire.is-lit { background: var(--accent); }
  .pipe.building .wire.is-lit::after { opacity: .3; animation: breathe 3s ease-in-out infinite; }
  .pipe.building.is-running .wire::after { opacity: 1; animation: stream var(--flow, .8s) linear infinite; }
  .steps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--s700); border-radius: 4px; background: var(--s950); counter-reset: step; }
  .step { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 4px 14px; padding: 14px 16px; border-bottom: 1px solid var(--s800); }
  .step:last-child { border-bottom: 0; }
  .num { width: 24px; height: 24px; border: 1px solid var(--s600); border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; color: var(--t400); }
  .step[data-state="done"] .num { border-color: var(--ok); color: var(--ok); }
  .step[data-state="current"] { background: var(--s900); }
  .step[data-state="current"] .num { border-color: var(--accent); color: var(--accent-ink); background: var(--accent); }
  .step[data-state="todo"] h3 { color: var(--t500); }
  .step h3 { font-size: 14px; font-weight: 600; padding-top: 2px; }
  .step .detail { grid-column: 2; color: var(--t400); font-size: 12.5px; }
  .step[data-state="current"] .detail { color: var(--t200); }
  .form { grid-column: 2; display: grid; gap: 12px; margin-top: 10px; max-width: 640px; }
  .field { display: grid; gap: 5px; }
  .field span { font-size: .6875rem; letter-spacing: .06em; text-transform: uppercase; color: var(--t500); }
  .field small { color: var(--t400); font-family: var(--sans); font-size: 12.5px; }
  input[type="text"], input[type="password"], input[type="url"] { font: 13px var(--mono); color: var(--t100); background: var(--s950); border: 1px solid var(--s600); border-radius: 3px; padding: 9px 11px; width: 100%; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .check-line { display: flex; gap: 9px; align-items: flex-start; font-family: var(--sans); font-size: 13.5px; color: var(--t200); }
  .check-line input { margin-top: 3px; accent-color: var(--accent); }
  .howto { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-family: var(--sans); font-size: 13.5px; color: var(--t200); }
  .howto b { font-weight: 600; color: var(--t100); }
  .copy { display: flex; gap: 6px; align-items: center; }
  .copy code { font: 12.5px var(--mono); background: var(--s950); border: 1px solid var(--s700); border-radius: 3px; padding: 6px 9px; color: var(--accent-hi); overflow-wrap: anywhere; }
  .objects { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); grid-auto-rows: max-content; align-content: start; gap: 4px 14px; max-height: 320px; overflow-y: auto; border: 1px solid var(--s700); border-radius: 3px; padding: 10px 12px; background: var(--s950); }
  .objects label { display: flex; gap: 8px; align-items: center; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .objects input { accent-color: var(--accent); }
  .objects small { color: var(--t500); }
  .step .change { grid-column: 2; justify-self: start; margin-top: 8px; padding: 6px 10px; font-size: 12px; }
  .step[data-editing] { background: var(--s900); }
  .step { scroll-margin-top: 16px; }
  .objects label[hidden] { display: none; }
  .row input[type="text"] { flex: 1 1 260px; width: auto; }
  .error { color: var(--err); font-family: var(--sans); font-size: 13px; }
  .error:empty { display: none; }
  .notice { color: var(--warn); font-family: var(--sans); font-size: 13px; }
  .finished[hidden] { display: none; }
  .finished { display: grid; gap: 10px; padding: 18px; border: 1px solid var(--ok); border-radius: 4px; background: color-mix(in oklch, var(--ok) 8%, var(--s950)); }
  .finished h2 { color: var(--ok); display: flex; align-items: center; gap: 8px; }
  a.button { display: inline-flex; align-items: center; gap: 8px; font: 500 13px/1 var(--mono); padding: 9px 13px; border-radius: 3px; text-decoration: none; background: var(--accent); color: var(--accent-ink); width: max-content; }
`;

const script = `
  const byId = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const selected = document.body.dataset.deployment;
  const button = byId("refresh");
  const statuses = new Map();
  const runStates = new Map();
  const fmt = new Intl.NumberFormat("en-US");
  const count = (value) => value === null || value === undefined ? "—" : fmt.format(value);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value; else if (key === "class") node.className = value; else node.setAttribute(key, value);
    }
    for (const child of children || []) node.append(child);
    return node;
  }
  function icon(name) {
    const template = document.createElement("template");
    template.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
    return template.content.firstChild;
  }

  function glyph(kind) {
    const paths = { ok: "M3 8.5l3 3 7-7", warn: "M8 2.5l6.5 11h-13zM8 7v3M8 12v.5", live: "M8 3a5 5 0 1 0 5 5", bad: "M4 4l8 8M12 4l-8 8", idle: "M4 8h8" };
    const template = document.createElement("template");
    template.innerHTML = '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="' + paths[kind] + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return template.content.firstChild;
  }

  // Counters tick toward their new value instead of jumping, so a sync's effect is visible.
  function tick(node, value) {
    const target = Number(value);
    const start = Number(node.dataset.value ?? target);
    node.dataset.value = String(target);
    if (reduceMotion || !Number.isFinite(start) || start === target) { node.textContent = count(value); return; }
    const began = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - began) / 900);
      const eased = 1 - Math.pow(2, -10 * t);
      node.textContent = fmt.format(Math.round(start + (target - start) * eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function totals(status) {
    let store = 0, diffs = 0, matches = 0, unknown = 0, last = null, created = 0, updated = 0, deleted = 0, failed = 0;
    for (const object of status.objects) {
      store += object.storeCount ?? 0;
      if (object.status === "MATCH") matches++; else if (object.status === "DIFF") diffs++; else unknown++;
      const run = object.lastRun;
      if (run) {
        if (!last || run.startedAt > last) last = run.startedAt;
        created += run.created ?? 0; updated += run.updated ?? 0; deleted += run.deleted ?? 0;
        if (run.status === "Failed") failed++;
      }
    }
    return { store, diffs, matches, unknown, last, created, updated, deleted, failed, objects: status.objects.length };
  }

  function stageOf(run) {
    if (!run || run.state !== "running") return null;
    for (let i = run.lines.length - 1; i >= 0; i--) {
      const match = /\\[replication\\] (?:Starting )?(metadata|users|records|projections|full)/.exec(run.lines[i]);
      if (match) return match[1];
    }
    return "metadata";
  }
  const hotStage = { metadata: "discover", full: "discover", users: "reconstruct", records: "replicate", projections: "store" };
  const order = ["source", "discover", "reconstruct", "replicate", "store"];

  function relative(iso) {
    if (!iso) return "never";
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    const hours = Math.round(minutes / 60);
    if (hours < 48) return hours + " h ago";
    return Math.round(hours / 24) + " days ago";
  }
  function utc(iso) { return iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "—"; }

  function verdict(status, run) {
    const t = totals(status);
    if (run && run.state === "running") return { tone: "live", text: "Syncing now" };
    if (status.salesforce.state === "unavailable") return { tone: "bad", text: "Salesforce unreachable" };
    if (t.diffs) return { tone: "warn", text: t.diffs === 1 ? "1 object off" : t.diffs + " objects off" };
    if (status.salesforce.state === "not-configured") return { tone: "warn", text: "Not signed in to Salesforce" };
    if (!t.objects) return { tone: "muted", text: "No objects yet" };
    if (t.unknown) return { tone: "muted", text: t.matches + " of " + t.objects + " objects compared" };
    return { tone: "ok", text: "All " + t.objects + " objects match" };
  }

  function pipeline(replica, status, run) {
    const t = totals(status);
    const v = verdict(status, run);
    const active = hotStage[stageOf(run)] ?? null;
    const sf = status.salesforce.state;
    const stages = [
      { key: "source", label: "Salesforce", sub: sf === "ok" ? "connected" : sf === "unavailable" ? "unreachable" : "not signed in", tone: sf === "unavailable" ? "bad" : sf === "not-configured" ? "warn" : null },
      { key: "discover", label: "Discover", sub: t.objects + (t.objects === 1 ? " object" : " objects") },
      { key: "reconstruct", label: "Reconstruct", sub: t.failed ? t.failed + " failed run" + (t.failed === 1 ? "" : "s") : "model ready", tone: t.failed ? "bad" : null },
      { key: "replicate", label: "Replicate", sub: t.diffs ? (t.diffs === 1 ? "1 object off" : t.diffs + " objects off") : !t.objects ? "waiting" : t.unknown ? "not compared" : "all match", tone: t.diffs ? "warn" : null },
      { key: "store", label: "Postgres", sub: count(t.store) + " records" },
    ];
    const list = el("ol", { class: "stages", "aria-label": "Pipeline for " + replica.name });
    stages.forEach((stage, index) => {
      if (index) {
        // Records flow from Salesforce through every stage up to the one being written, and on into the store.
        const reach = active === "replicate" ? order.length - 1 : order.indexOf(active);
        const hot = active && reach >= index;
        list.append(el("li", { class: "wire" + (hot ? " is-hot" : ""), "aria-hidden": "true" }));
      }
      const classes = ["stage"];
      if (active === stage.key) classes.push("is-active");
      if (stage.tone === "warn") classes.push("is-warn");
      if (stage.tone === "bad") classes.push("is-bad");
      if (stage.key === "replicate" && !t.diffs && t.objects && !t.unknown) classes.push("is-ok");
      list.append(el("li", { class: classes.join(" "), "data-stage": stage.key }, [icon(stage.key), el("div", {}, [el("b", { text: stage.label }), el("small", { text: stage.sub })])]));
    });
    const classes = ["pipe"];
    if (run && run.state === "running") classes.push("is-running");
    if (v.tone === "warn") classes.push("attention");
    if (v.tone === "bad") classes.push("unreachable");
    if (status.salesforce.state === "not-configured") classes.push("unsigned");
    if (!replica.isActive) classes.push("paused");
    const name = el("div", { class: "pipe-name" }, [
      el("b", { text: replica.name }),
      el("small", { text: replica.id === replica.name ? (replica.sourceUrl ?? "Salesforce to Postgres") : replica.id }),
      el("span", { class: "state tone-" + v.tone }, [glyph(v.tone === "muted" ? "idle" : v.tone), v.text]),
    ]);
    const node = el("a", { class: classes.join(" "), href: "/?deployment=" + encodeURIComponent(replica.id), "aria-current": replica.id === selected ? "true" : null,
      "data-id": replica.id, "aria-label": replica.name + ": " + v.text }, [name, list]);
    if (run && run.state === "running") node.style.setProperty("--flow", flowFor(replica.id, run) + "s");
    return node;
  }

  // Connector speed follows sync activity: the more progress lines a sync writes per poll, the faster the dots.
  const activity = new Map();
  function flowFor(id, run) {
    const seen = activity.get(id) || { lines: run.lines.length, at: Date.now(), flow: 1.2 };
    const now = Date.now();
    if (now - seen.at >= 1500) {
      const perSecond = Math.max(0, run.lines.length - seen.lines) / ((now - seen.at) / 1000);
      seen.flow = Math.max(0.3, Math.min(1.6, 1.6 - perSecond * 0.6));
      seen.lines = run.lines.length;
      seen.at = now;
    }
    activity.set(id, seen);
    return seen.flow.toFixed(2);
  }

  let replicas = [];
  function renderPipes() {
    const nodes = replicas.map((replica) => {
      const status = statuses.get(replica.id);
      if (!status) return el("div", { class: "pipe" }, [el("div", { class: "pipe-name" }, [el("b", { text: replica.name }), el("small", { text: "Reading counts…" })])]);
      return pipeline(replica, status, runStates.get(replica.id));
    });
    byId("pipes").replaceChildren(...nodes);
    const known = replicas.map((replica) => statuses.get(replica.id)).filter(Boolean);
    const off = known.filter((status) => totals(status).diffs || status.salesforce.state !== "ok").length;
    const running = replicas.filter((replica) => runStates.get(replica.id)?.state === "running").length;
    const records = known.reduce((sum, status) => sum + totals(status).store, 0);
    const verdictNode = byId("health-verdict");
    if (running) verdictNode.replaceChildren(glyph("live"), "SYNCING");
    else if (off) verdictNode.replaceChildren(glyph("warn"), "NEEDS ATTENTION");
    else verdictNode.replaceChildren(glyph("ok"), "IN STEP");
    verdictNode.className = running ? "tone-live" : off ? "tone-warn" : "tone-ok";
    byId("health-replicas").textContent = String(replicas.length);
    tick(byId("health-records"), records);
    byId("health-attention").textContent = String(off);
    byId("nav-problems-count").textContent = off ? String(off) : "";
    const needs = [];
    for (const replica of replicas) {
      const status = statuses.get(replica.id);
      if (!status) continue;
      const t = totals(status);
      const name = replica.name === replica.id ? replica.id : replica.name + " (" + replica.id + ")";
      if (status.salesforce.state === "not-configured") {
        needs.push([name, "isn't signed in to Salesforce, so its counts can't be checked.", "Sign in", "/setup?deployment=" + encodeURIComponent(replica.id) + "&step=signin"]);
      } else if (status.salesforce.state === "unavailable") {
        needs.push([name, "can't reach Salesforce" + (status.salesforce.reason ? ": " + status.salesforce.reason : "") + ".", "Sign in again", "/setup?deployment=" + encodeURIComponent(replica.id) + "&step=signin"]);
      } else if (t.diffs) {
        needs.push([name, "has " + (t.diffs === 1 ? "1 object" : t.diffs + " objects") + " that don't match Salesforce.", "Open and sync", "/?deployment=" + encodeURIComponent(replica.id)]);
      }
    }
    byId("attention").replaceChildren(...needs.map(([name, what, label, href]) => el("li", { class: "needs" }, [
      glyph("warn"), el("span", {}, [el("b", { text: name }), " " + what]), el("a", { class: "text-link", href, text: label })])));
  }

  function renderDetail(status) {
    const t = totals(status);
    tick(byId("fact-records"), t.store);
    byId("fact-match").textContent = t.objects ? t.matches + " of " + t.objects + " objects match" : "No objects yet";
    byId("fact-last").textContent = relative(t.last);
    byId("fact-last-utc").textContent = utc(t.last);
    byId("fact-changes").textContent = "+" + count(t.created) + " new · " + count(t.updated) + " updated · " + count(t.deleted) + " deleted";
    byId("fact-salesforce").textContent = status.salesforce.state === "ok" ? "Connected" : status.salesforce.state === "unavailable" ? "Unreachable" : "Not signed in";
    byId("salesforce-reason").textContent = status.salesforce.reason ?? "";
    const rows = status.objects.map((object) => {
      const run = object.lastRun;
      const label = object.status === "MATCH" ? "MATCH" : object.status === "DIFF" && object.storeCount !== null && object.sourceCount !== null
        ? "Off by " + count(Math.abs(object.sourceCount - object.storeCount)) : "Not compared";
      const tone = object.status === "MATCH" ? "ok" : object.status === "DIFF" ? "warn" : "muted";
      const row = el("tr", {}, [el("th", { scope: "row", text: object.entityKey })]);
      for (const value of [object.storeCount, object.sourceCount]) row.append(el("td", { class: "number", text: count(value) }));
      row.append(el("td", {}, [el("span", { class: "check " + tone, text: label })]));
      row.append(el("td", {}, [el("span", { class: "run-status", "data-status": run?.status ?? "None", text: run ? run.status + " · " + utc(run.startedAt) : "No sync yet" })]));
      for (const value of [run?.created, run?.updated, run?.deleted]) row.append(el("td", { class: "number", text: count(value) }));
      return row;
    });
    if (!rows.length) rows.push(el("tr", {}, [el("td", { colspan: "8", class: "empty", text: "No objects to display. Choose objects, then run a full sync." })]));
    byId("objects").replaceChildren(...rows);
    const lastGood = new Map(status.objects.filter((object) => object.lastRun && object.lastRun.status === "Succeeded").map((object) => [object.entityKey, object.lastRun.startedAt]));
    const plain = (key, message) => /checkpoint/i.test(message)
      ? "The saved sync position for " + (key ?? "this sync") + " was unreadable. Run a full sync to start " + (key ?? "it") + " again."
      : message;
    const groups = new Map();
    for (const error of status.errors) {
      const id = (error.entityKey ?? "") + "\u0000" + error.message;
      const group = groups.get(id) || { key: error.entityKey, message: error.message, times: 0, last: error.at };
      group.times++;
      if (error.at > group.last) group.last = error.at;
      groups.set(id, group);
    }
    const problems = (status.interruptedRuns ?? []).map((run) => el("li", {}, [el("time", { text: utc(run.startedAt) }),
      el("span", { class: "interrupted", text: "Interrupted sync" + (run.entityKey ? " of " + run.entityKey : "") + ". It stopped without finishing; run a sync again." })]))
      .concat([...groups.values()].map((group) => {
        const resolved = group.key && lastGood.has(group.key) && lastGood.get(group.key) > group.last;
        return el("li", { class: resolved ? "resolved" : null }, [el("time", { text: utc(group.last) }),
          el("span", {}, [el("span", { class: "what", text: (group.key ?? "Sync") + (group.times > 1 ? ", " + group.times + " times" : "") + ": " }),
            plain(group.key, group.message), resolved ? el("small", { text: " Resolved by a later successful sync." }) : null])]);
      }));
    byId("errors").replaceChildren(...problems);
    byId("no-errors").hidden = problems.length > 0;
  }

  async function loadStatus(id, refresh) {
    const response = await fetch("/api/status?deployment=" + encodeURIComponent(id) + (refresh ? "&refresh=1" : ""));
    if (!response.ok) throw new Error("Status request failed");
    const status = await response.json();
    statuses.set(id, status);
    return status;
  }

  async function update(refresh) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const listing = await fetch("/api/replicas");
      if (listing.ok) replicas = (await listing.json()).replicas;
      if (!replicas.some((replica) => replica.id === selected)) replicas.unshift({ id: selected, name: selected, sourceUrl: null, isActive: true });
      renderPipes();
      await Promise.all(replicas.map((replica) => loadStatus(replica.id, refresh && replica.id === selected).then(renderPipes, () => {})));
      const mine = statuses.get(selected);
      if (mine) renderDetail(mine);
      byId("feedback").textContent = "";
    } catch {
      byId("feedback").textContent = "Couldn't refresh the counts. The console will try again shortly.";
    } finally {
      button.disabled = false;
    }
  }

  async function pollOthers() {
    await Promise.all(replicas.filter((replica) => replica.id !== selected).map(async (replica) => {
      try {
        const response = await fetch("/api/runs/current?deployment=" + encodeURIComponent(replica.id));
        if (response.ok) runStates.set(replica.id, await response.json());
      } catch {}
    }));
    renderPipes();
  }

  button.addEventListener("click", () => update(true));
  void update(false);
  setInterval(() => update(false), 15000);
  setInterval(pollOthers, 4000);
`;

const actionsScript = (token: string) => `
  const runButtons = [...document.querySelectorAll("button[data-stage]")];
  let submitting = false;
  let polling = false;
  let lastFinished;
  let submission = 0;
  const disableRuns = (disabled) => runButtons.forEach((control) => { control.disabled = disabled; });
  const stageWords = { metadata: "Discovering objects", users: "Reconstructing users", records: "Copying records", projections: "Building views", full: "Starting" };

  function renderRun(run) {
    runStates.set(selected, run);
    disableRuns(submitting || run.state === "running");
    const state = byId("run-state");
    if (run.state === "running") {
      const stage = stageOf(run);
      state.replaceChildren(el("span", { class: "tone-live" }, [glyph("live")]), (stageWords[stage] ?? "Syncing") + "…");
    } else if (run.state === "succeeded") {
      state.replaceChildren(el("span", { class: "tone-ok" }, [glyph("ok")]), "Last sync finished " + relative(run.finishedAt));
    } else if (run.state === "failed") {
      state.replaceChildren(el("span", { class: "tone-bad" }, [glyph("bad")]), "Last sync failed. See the log below.");
    } else {
      state.replaceChildren("Ready to sync");
    }
    byId("run-lines").textContent = run.lines.length ? run.lines.join("\\n") : "No sync has run since the console started.";
    const log = byId("sync-log");
    if (run.state === "running" && !log.open) { log.open = true; log.dataset.auto = "1"; }
    if (run.state !== "running" && log.dataset.auto) { delete log.dataset.auto; if (run.state === "succeeded") log.open = false; }
    const lines = byId("run-lines");
    lines.scrollTop = lines.scrollHeight;
    renderPipes();
    if (run.finishedAt && run.finishedAt !== lastFinished) {
      const first = lastFinished === undefined;
      lastFinished = run.finishedAt;
      if (!first) void update(false).then(() => {
        const node = document.querySelector('.pipe[data-id="' + CSS.escape(selected) + '"] [data-stage="replicate"]');
        const after = statuses.get(selected);
        const settled = after && totals(after).objects > 0 && totals(after).matches === totals(after).objects;
        if (node && run.state === "succeeded" && settled) node.classList.add("settled");
      });
    }
  }

  async function pollRun() {
    if (submitting || polling) return;
    polling = true;
    const requestedBefore = submission;
    try {
      const response = await fetch("/api/runs/current?deployment=" + encodeURIComponent(selected));
      if (!response.ok) throw new Error("Progress request failed");
      const run = await response.json();
      if (!submitting && requestedBefore === submission) renderRun(run);
      byId("run-poll-feedback").textContent = "";
    } catch {
      byId("run-poll-feedback").textContent = "Couldn't read sync progress.";
    } finally {
      polling = false;
    }
  }

  for (const control of runButtons) control.addEventListener("click", async () => {
    submitting = true;
    submission++;
    disableRuns(true);
    byId("run-feedback").textContent = "";
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ReplCRM-Token": ${JSON.stringify(token)} },
        body: JSON.stringify({ stage: control.dataset.stage, deployment: selected }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Couldn't start the sync.");
      renderRun(result);
    } catch (error) {
      byId("run-feedback").textContent = error.message;
    } finally {
      submitting = false;
      void pollRun();
    }
  });

  void pollRun();
  setInterval(pollRun, 2000);
`;

export function renderConsolePage(status: ConsoleStatus, nonce: string, token?: string, running = false): string {
  let store = 0;
  let matches = 0;
  let last: Date | null = null;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  for (const object of status.objects) {
    store += object.storeCount ?? 0;
    if (object.status === "MATCH") matches++;
    const run = object.lastRun;
    if (run) {
      if (!last || run.startedAt > last) last = run.startedAt;
      created += run.created ?? 0;
      updated += run.updated ?? 0;
      deleted += run.deleted ?? 0;
    }
  }
  const lastIso = last?.toISOString();
  const rows = status.objects.map(({ entityKey, lastRun, storeCount, sourceCount, status: check }) => `<tr><th scope="row">${escapeHtml(entityKey)}</th>
      <td class="number">${formatCount(storeCount)}</td><td class="number">${formatCount(sourceCount)}</td>
      <td><span class="check ${checkTone(check)}">${escapeHtml(checkLabel(check, storeCount, sourceCount))}</span></td>
      <td><span class="run-status" data-status="${escapeHtml(lastRun?.status ?? "None")}">${lastRun
        ? `${escapeHtml(lastRun.status)} · ${escapeHtml(lastRun.startedAt.toISOString().slice(0, 16).replace("T", " "))} UTC` : "No sync yet"}</span></td>
      ${[lastRun?.created, lastRun?.updated, lastRun?.deleted].map((count) => `<td class="number">${formatCount(count)}</td>`).join("")}</tr>`).join("")
    || '<tr><td colspan="8" class="empty">No objects to display. Choose objects, then run a full sync.</td></tr>';
  const errors = status.errors.map(({ at, entityKey, message }) =>
    `<li><time>${escapeHtml(at.toISOString().slice(0, 16).replace("T", " "))} UTC</time><span><span class="what">${escapeHtml(entityKey ?? "Sync")}: </span>${escapeHtml(message)}</span></li>`).join("");
  const interrupted = status.interruptedRuns?.map(({ entityKey, startedAt }) =>
    `<li><time>${escapeHtml(startedAt.toISOString().slice(0, 16).replace("T", " "))} UTC</time><span class="interrupted">Interrupted sync${entityKey ? ` of ${escapeHtml(entityKey)}` : ""}. It stopped without finishing; run a sync again.</span></li>`).join("") ?? "";
  const salesforce = status.salesforce.state === "ok" ? "Connected" : status.salesforce.state === "unavailable" ? "Unreachable" : "Not signed in";
  const id = escapeHtml(status.deploymentId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ReplCRM Console</title>
<script nonce="${nonce}">${themeBoot}</script>
<style nonce="${nonce}">${styles}</style>
</head>
<body data-deployment="${id}">
${icons}
<div class="shell">
${sidebar("replicas")}
<main>
  <div class="page-head">
    <div><h1>Replicas</h1><p class="prose">Each replica copies one CRM org into its own database. Open one to see its objects.</p></div>
    <button id="refresh" type="button"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg>Refresh counts</button>
  </div>
  <dl class="strip" aria-label="Health">
    <div><dt class="label">Health</dt><dd id="health-verdict" class="tone-muted">READING</dd></div>
    <div><dt class="label">Replicas</dt><dd id="health-replicas">—</dd></div>
    <div><dt class="label">Records</dt><dd><span class="counter" id="health-records">—</span></dd></div>
    <div><dt class="label">Need attention</dt><dd id="health-attention">—</dd></div>
  </dl>
  <section aria-label="Replica pipelines">
    <div class="pipes" id="pipes"><div class="pipe" aria-current="true"><div class="pipe-name"><b>${id}</b><small>Reading counts…</small></div></div></div>
    <p id="feedback" class="feedback" role="alert"></p>
  </section>

  <section class="detail" aria-labelledby="detail-title">
    <div class="detail-head"><h2 id="detail-title">${id}</h2><p class="prose">Your database against the live Salesforce org. They should match.</p><a class="text-link" href="/setup?deployment=${encodeURIComponent(status.deploymentId)}&amp;step=objects">Change objects</a></div>
    <dl class="facts">
      <div><dt class="label">Records in your database</dt><dd><span class="counter" id="fact-records" data-value="${store}">${formatCount(store)}</span></dd></div>
      <div><dt class="label">Agreement</dt><dd id="fact-match">${status.objects.length ? `${matches} of ${status.objects.length} objects match` : "No objects yet"}</dd></div>
      <div><dt class="label">Last sync</dt><dd><span id="fact-last">${lastIso ? escapeHtml(lastIso.slice(0, 16).replace("T", " ")) + " UTC" : "never"}</span> <small id="fact-last-utc"></small></dd></div>
      <div><dt class="label">Last sync changed</dt><dd id="fact-changes">+${formatCount(created)} new · ${formatCount(updated)} updated · ${formatCount(deleted)} deleted</dd></div>
      <div><dt class="label">Salesforce</dt><dd><span id="fact-salesforce">${salesforce}</span> <small id="salesforce-reason">${escapeHtml(status.salesforce.reason ?? "")}</small></dd></div>
    </dl>
    ${token ? `<div class="sync" role="group" aria-label="Sync">
      <div class="controls">
        <button class="primary" type="button" data-stage="records"${running ? " disabled" : ""}><svg class="icon" aria-hidden="true"><use href="#i-play"/></svg>Run records sync</button>
        <button type="button" data-stage="full"${running ? " disabled" : ""}>Run full sync</button>
      </div>
      <p class="sync-state" id="run-state" role="status">${running ? "Syncing…" : "Ready to sync"}</p>
      <p id="run-feedback" class="feedback" role="alert"></p>
      <p id="run-poll-feedback" class="feedback" role="status"></p>
      <details id="sync-log"><summary>Sync log</summary><pre id="run-lines" aria-live="polite"></pre></details>
    </div>` : ""}
    <div class="table-scroll" role="region" aria-label="Objects in ${id}" tabindex="0">
      <table aria-label="Objects in ${id}">
        <thead><tr>
          <th scope="col">Object</th><th scope="col" class="number">In your database</th><th scope="col" class="number">In Salesforce</th>
          <th scope="col">Check</th><th scope="col">Last sync</th>
          <th scope="col" class="number">New</th><th scope="col" class="number">Updated</th><th scope="col" class="number">Deleted</th>
        </tr></thead>
        <tbody id="objects">${rows}</tbody>
      </table>
    </div>
  </section>

  <section class="problems" id="problems" aria-labelledby="errors-title">
    <div class="detail-head"><h2 id="errors-title">Problems</h2></div>
    <ul class="attention" id="attention" aria-label="Replicas that need you"></ul>
    <p id="no-errors" class="prose"${errors || interrupted ? " hidden" : ""}>No recent problems with this replica.</p>
    <ul id="errors">${interrupted}${errors}</ul>
  </section>
</main>
</div>
<script nonce="${nonce}">${themeToggle}${script}${token ? actionsScript(token) : ""}</script>
</body>
</html>`;
}

const setupScript = (token: string) => `
  const byId = (id) => document.getElementById(id);
  const token = ${JSON.stringify(token)};
  let deployment = document.body.dataset.deployment || "";
  let plan;
  let busy = false;
  let pollTimer;
  let available;
  let editing = null;
  let lastOpen = null;
  const changeable = new Set(["app", "signin", "objects"]);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value; else if (key === "class") node.className = value; else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children || []) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function icon(name, cls) {
    const template = document.createElement("template");
    template.innerHTML = '<svg class="' + (cls || "icon") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
    return template.content.firstChild;
  }
  const done = (id) => plan && plan.steps.some((step) => step.id === id && step.state === "done");

  function pipeline(running) {
    const stages = [
      { key: "source", label: "Salesforce", lit: done("signin"), sub: done("signin") ? "signed in" : done("app") ? "app connected" : "not connected" },
      { key: "discover", label: "Discover", lit: done("objects"), sub: done("objects") ? "objects chosen" : "not chosen yet" },
      { key: "reconstruct", label: "Reconstruct", lit: done("sync"), sub: done("sync") ? "model built" : "after first sync" },
      { key: "replicate", label: "Replicate", lit: done("sync"), sub: done("sync") ? "all match" : "after first sync" },
      { key: "store", label: "Postgres", lit: done("schema"), sub: done("schema") ? "ready" : done("database") ? "needs tables" : "not connected" },
    ];
    const list = el("ol", { class: "stages", "aria-label": "Pipeline being built" });
    stages.forEach((stage, index) => {
      if (index) list.append(el("li", { class: "wire" + (stage.lit && stages[index - 1].lit ? " is-lit" : ""), "aria-hidden": "true" }));
      list.append(el("li", { class: "stage " + (stage.lit ? "is-done" : "is-todo") }, [icon(stage.key), el("div", {}, [el("b", { text: stage.label }), el("small", { text: stage.sub })])]));
    });
    const name = el("div", { class: "pipe-name" }, [el("b", { text: (plan && plan.replicaName) || "New replica" }),
      el("small", { text: deployment || "Salesforce to PostgreSQL" }),
      el("span", { class: "state " + (plan && plan.complete ? "tone-ok" : "tone-live") }, [el("span", { class: "dot", "aria-hidden": "true" }),
        plan && plan.complete ? "Ready" : running ? "First sync running" : "Setting up"])]);
    byId("build").replaceChildren(el("div", { class: "pipe building" + (running ? " is-running" : "") }, [name, list]));
  }

  async function post(body) {
    const response = await fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json", "X-ReplCRM-Token": token }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "That step didn't work.");
    return result;
  }

  function action(button, run) {
    return async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      const error = byId("step-error");
      if (error) error.textContent = "";
      try {
        await run();
      } catch (problem) {
        const target = byId("step-error");
        if (target) target.textContent = problem.message;
      } finally {
        busy = false;
        button.disabled = false;
      }
    };
  }

  function apply(next) {
    plan = next;
    editing = null;
    if (next.deploymentId && next.deploymentId !== deployment) {
      deployment = next.deploymentId;
      history.replaceState(null, "", "/setup?deployment=" + encodeURIComponent(deployment));
    }
    render();
  }

  function field(label, input, hint) {
    return el("label", { class: "field" }, [el("span", { text: label }), input, hint ? el("small", { text: hint }) : null]);
  }

  function form(step) {
    const error = el("p", { class: "error", id: "step-error", role: "alert" });
    if (step.id === "database") {
      const url = el("input", { type: "password", id: "db-url", autocomplete: "off", spellcheck: "false", placeholder: "postgresql://user:password@localhost:5432/replcrm" });
      const save = el("button", { class: "primary", type: "button", text: "Test and save" });
      save.addEventListener("click", action(save, async () => apply(await post({ action: "database", url: url.value }))));
      return el("div", { class: "form" }, [field("Connection URL", url, "ReplCRM tests the connection before saving. It's stored only on this machine, readable by you alone."), el("div", { class: "row" }, [save]), error]);
    }
    if (step.id === "schema") {
      const schema = plan.schema || {};
      const parts = [];
      if (schema.pending) parts.push(el("p", { class: "field" }, [el("small", { text: "Updates to apply: " + schema.pending.join(", ") })]));
      let confirm;
      if (schema.state === "pending" && schema.populated) {
        confirm = el("input", { type: "checkbox", id: "schema-confirm" });
        parts.push(el("label", { class: "check-line" }, [confirm, "I have a recent backup of this database."]));
      }
      if (schema.state !== "foreign") {
        const run = el("button", { class: "primary", type: "button", text: schema.state === "empty" ? "Create tables" : "Apply updates" });
        run.addEventListener("click", action(run, async () => apply(await post({ action: "schema", confirm: Boolean(confirm && confirm.checked) }))));
        parts.push(el("div", { class: "row" }, [run]));
      }
      return el("div", { class: "form" }, [...parts, error]);
    }
    if (step.id === "replica") {
      const name = el("input", { type: "text", id: "replica-name", placeholder: "EMEA production" });
      const id = el("input", { type: "text", id: "replica-id", placeholder: "emea-prod", spellcheck: "false" });
      let edited = false;
      id.addEventListener("input", () => { edited = true; });
      name.addEventListener("input", () => { if (!edited) id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); });
      const save = el("button", { class: "primary", type: "button", text: "Create replica" });
      save.addEventListener("click", action(save, async () => apply(await post({ action: "replica", id: id.value, name: name.value }))));
      return el("div", { class: "form" }, [field("Name", name, "What you call this org, like EMEA production."), field("ID", id, "Short and permanent. Used in commands and file names."), el("div", { class: "row" }, [save]), error]);
    }
    if (step.id === "app") {
      const app = plan.app || { callbackUrl: "http://localhost:47123/oauth/callback", loginUrl: "https://login.salesforce.com" };
      const copyButton = el("button", { type: "button", class: "icon-btn", "aria-label": "Copy callback URL" }, [icon("copy")]);
      copyButton.addEventListener("click", () => navigator.clipboard.writeText(app.callbackUrl).then(() => { copyButton.replaceChildren(icon("check")); }, () => {}));
      const steps = el("ol", { class: "howto" }, [
        el("li", {}, ["In Salesforce Setup, open ", el("b", { text: "External Client App Manager" }), " and click ", el("b", { text: "New External Client App" }), "."]),
        el("li", {}, ["Turn on ", el("b", { text: "Enable OAuth" }), " and set the callback URL:", el("div", { class: "copy" }, [el("code", { text: app.callbackUrl }), copyButton])]),
        el("li", {}, ["Add the scopes ", el("b", { text: "api" }), " and ", el("b", { text: "refresh_token, offline_access" }), ". Leave every Flow Enablement box unticked."]),
        el("li", {}, ["Under Security, keep ", el("b", { text: "PKCE" }), " on and untick both ", el("b", { text: "Require secret" }), " boxes. Create the app."]),
        el("li", {}, ["Open the app's Settings, click ", el("b", { text: "Consumer Key and Secret" }), ", and copy the consumer key. You don't need the secret."]),
      ]);
      const key = el("input", { type: "text", id: "client-id", spellcheck: "false", autocomplete: "off", placeholder: "3MVG9..." });
      const login = el("input", { type: "url", id: "login-url", value: app.loginUrl });
      const save = el("button", { class: "primary", type: "button", text: "Save app" });
      save.addEventListener("click", action(save, async () => apply(await post({ action: "app", deployment, clientId: key.value, loginUrl: login.value }))));
      return el("div", { class: "form" }, [steps, field("Consumer key", key), field("Login URL", login, "Use your My Domain or test.salesforce.com for a sandbox."), el("div", { class: "row" }, [save, cancelButton(step)]), error]);
    }
    if (step.id === "signin") {
      const parts = [];
      if (plan.notice) parts.push(el("p", { class: "notice", text: plan.notice }));
      const start = el("button", { class: "primary", type: "button" }, [icon("external"), "Sign in to Salesforce"]);
      const link = el("p", { class: "field", id: "signin-link" });
      start.addEventListener("click", action(start, async () => {
        const result = await post({ action: "signin", deployment });
        link.replaceChildren(el("small", { text: "Your browser should open. If it didn't, open this link: " }), el("a", { href: result.url, target: "_blank", rel: "noreferrer", text: "Salesforce sign-in" }));
        watch();
      }));
      parts.push(el("div", { class: "row" }, [start, cancelButton(step)]), link, el("p", { class: "field" }, [el("small", { text: "Approve access in the browser. This page moves on by itself once Salesforce confirms." })]));
      return el("div", { class: "form" }, [...parts, error]);
    }
    if (step.id === "objects") {
      const box = el("div", { class: "objects", id: "objects-list" }, [el("small", { text: "Reading objects from Salesforce…" })]);
      const filter = el("input", { type: "text", id: "objects-filter", placeholder: "Filter objects, like Opportunity or __c", spellcheck: "false", autocomplete: "off" });
      const count = el("span", { class: "muted", id: "objects-count" });
      filter.addEventListener("input", () => {
        const term = filter.value.trim().toLowerCase();
        for (const label of box.querySelectorAll("label")) label.hidden = Boolean(term) && !label.textContent.toLowerCase().includes(term) && !(label.title || "").toLowerCase().includes(term);
      });
      box.addEventListener("change", () => { count.textContent = box.querySelectorAll("input:checked").length + " selected"; });
      const save = el("button", { class: "primary", type: "button", text: "Save selection" });
      save.addEventListener("click", action(save, async () => {
        const chosen = [...box.querySelectorAll("input:checked")].map((input) => input.value);
        apply(await post({ action: "objects", deployment, entities: chosen }));
      }));
      void loadObjects(box).then(() => { count.textContent = box.querySelectorAll("input:checked").length + " selected"; });
      return el("div", { class: "form" }, [el("div", { class: "row" }, [filter, count]), box, el("div", { class: "row" }, [save, cancelButton(step)]), error]);
    }
    if (step.id === "sync") {
      const run = el("button", { class: "primary", type: "button" }, [icon("play"), "Run first sync"]);
      const state = el("p", { class: "field", id: "sync-progress" });
      run.addEventListener("click", action(run, async () => {
        const response = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json", "X-ReplCRM-Token": token }, body: JSON.stringify({ stage: "full", deployment }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Couldn't start the sync.");
        followSync();
      }));
      return el("div", { class: "form" }, [el("div", { class: "row" }, [run]), state, error]);
    }
    return null;
  }

  function cancelButton(step) {
    if (step.state !== "done") return null;
    const cancel = el("button", { type: "button", text: "Cancel" });
    cancel.addEventListener("click", () => { editing = null; render(); });
    return cancel;
  }

  async function loadObjects(box) {
    try {
      if (!available) {
        const response = await fetch("/api/setup/objects?deployment=" + encodeURIComponent(deployment));
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Couldn't read objects from Salesforce.");
        available = result.objects;
      }
      const defaults = new Set(plan.selection && plan.selection.length ? plan.selection : ["Account", "Contact", "Lead", "Opportunity", "Case"]);
      const ordered = [...available].sort((a, b) => Number(defaults.has(b.name)) - Number(defaults.has(a.name)) || a.name.localeCompare(b.name));
      box.replaceChildren(...ordered.map((object) => el("label", { title: object.label }, [
        el("input", { type: "checkbox", value: object.name, checked: defaults.has(object.name) }),
        object.name, object.custom ? el("small", { text: "custom" }) : null])));
    } catch (problem) {
      box.replaceChildren(el("p", { class: "error", text: problem.message }));
    }
  }

  function watch() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const next = await load();
      if (next && (done("signin") || next.notice)) clearInterval(pollTimer);
    }, 2000);
  }

  function followSync() {
    clearInterval(pollTimer);
    pipeline(true);
    pollTimer = setInterval(async () => {
      const response = await fetch("/api/runs/current?deployment=" + encodeURIComponent(deployment));
      const run = await response.json();
      const progress = byId("sync-progress");
      const last = run.lines && run.lines.length ? run.lines[run.lines.length - 1] : "";
      if (progress) progress.replaceChildren(el("small", { text: run.state === "running" ? "Running: " + last : run.state === "failed" ? "The sync failed: " + last : "Checking counts against Salesforce…" }));
      if (run.state !== "running") { clearInterval(pollTimer); await load(); }
    }, 1500);
  }

  function changeButton(step) {
    const labels = { app: "Change app", signin: "Sign in again", objects: "Change objects" };
    const change = el("button", { type: "button", class: "change", text: labels[step.id] });
    change.addEventListener("click", () => { editing = step.id; render(); const first = document.querySelector(".step[data-editing] input"); if (first) first.focus(); });
    return change;
  }

  function render() {
    pipeline(false);
    const items = plan.steps.map((step, index) => el("li", { class: "step", "data-state": step.state, "data-editing": editing === step.id || null, "aria-current": step.state === "current" ? "step" : null }, [
      el("span", { class: "num", "aria-hidden": "true" }, [step.state === "done" ? icon("check", "glyph") : String(index + 1)]),
      el("h3", { text: step.title }),
      step.detail ? el("p", { class: "detail", text: step.detail }) : null,
      step.state === "current" || editing === step.id ? form(step) : null,
      step.state === "done" && changeable.has(step.id) && editing !== step.id ? changeButton(step) : null,
    ]));
    byId("steps").replaceChildren(...items);
    // Bring the step that needs the operator into view when it changes; finished steps above it
    // can push it below the fold on a laptop screen.
    const open = editing || (plan.steps.find((step) => step.state === "current") || {}).id || null;
    if (open && open !== lastOpen) {
      const target = document.querySelector('.step[data-editing], .step[data-state="current"]');
      if (target) {
        target.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        const first = target.querySelector("input, button.primary");
        if (first) first.focus({ preventScroll: true });
      }
    }
    lastOpen = open;
    const finished = byId("finished");
    finished.hidden = !plan.complete;
    if (plan.complete) byId("open-replica").setAttribute("href", "/?deployment=" + encodeURIComponent(deployment));
  }

  async function load() {
    try {
      const response = await fetch("/api/setup" + (deployment ? "?deployment=" + encodeURIComponent(deployment) : ""));
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || "Couldn't read setup.");
      apply(next);
      byId("load-error").textContent = "";
      return next;
    } catch (problem) {
      byId("load-error").textContent = problem.message;
      return undefined;
    }
  }

  const wanted = new URLSearchParams(location.search).get("step");
  void load().then(() => { if (wanted && changeable.has(wanted) && plan && plan.steps.some((step) => step.id === wanted && step.state === "done")) { editing = wanted; render(); } });
`;

export function renderSetupPage(nonce: string, token: string, deploymentId?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add a replica · ReplCRM</title>
<script nonce="${nonce}">${themeBoot}</script>
<style nonce="${nonce}">${styles}${setupStyles}</style>
</head>
<body data-deployment="${escapeHtml(deploymentId ?? "")}">
${icons}
<div class="shell">
${sidebar("setup")}
<main>
  <div class="page-head">
    <div><h1>Add a replica</h1><p class="prose">Seven steps from an empty database to a verified copy of your Salesforce org. Each step is checked for real before the next one opens, and you can leave and come back at any point.</p></div>
  </div>
  <section class="build" id="build" aria-label="Pipeline being built"></section>
  <p class="error" id="load-error" role="alert"></p>
  <section class="finished" id="finished" hidden>
    <h2><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>Your replica is live</h2>
    <p class="prose">Every object matches Salesforce. Run a records sync whenever you want the latest changes; the console shows if anything drifts.</p>
    <a class="button" id="open-replica" href="/">Open the replica</a>
  </section>
  <ol class="steps" id="steps"><li class="step"><span class="num">…</span><h3>Checking what's already set up</h3></li></ol>
</main>
</div>
<script nonce="${nonce}">${themeToggle}${setupScript(token)}</script>
</body>
</html>`;
}
