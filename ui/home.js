/* Home: the page the mark opens, at `/`. The doorway to an evening's work.
 *
 * Four questions, in the order a maker asks them. Which project tonight, and
 * where was I? -- the Pick up card: the desk touched last (or the one the
 * reader keeps there), where it was left, what is open, what git says, one
 * button with Enter on it, and the other desks beside it with their age. Does
 * anything need me? -- one status line under the title, which the rail and
 * the sidebar answer too, so it is a line and not three boxes. Did I leave a
 * trail? -- Your days: what was ticked, sent, left off and committed, day by
 * day, and a week of it as a document on a button. Is this project alive? --
 * Projects: eight weeks of each desk, quietly, and "Park it?" for one that has
 * gone quiet. No streaks, no red, no scores: a hobby is not a KPI.
 *
 * One call (`GET /api/home`), drawn whole, and drawn again when the daemon
 * says something it shows has moved -- panes, a panel's context, the desks, a
 * desk's notes, a document, the update. Debounced, so a burst of events is
 * one read.
 *
 * A chunk: a reader who goes straight to a document never fetches it. The
 * Inbox moved to `/inbox`, and `i` still opens it; its foot, "N removed ·
 * Show", is drawn from here too (`removedLine`), as the other page that lists.
 *
 * The side widgets can be hidden and shown again ("2 hidden · Show"): the list
 * is this viewer's, in localStorage, since it is a preference about a page
 * and not a thing in the library, and so is the desk kept in Pick up. Nothing
 * here moves when something arrives: the status line is one line whatever it
 * says, and a widget with nothing to say says so rather than going away.
 */

const CSS = `
.hm { max-width: 1120px; margin: 0 auto; padding: 8px 0 48px; container-type: inline-size; }
.hm-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 4px; }
.hm-head h1 { margin: 0; font-size: var(--fs-h2); font-weight: 650; letter-spacing: -.02em; }
.hm-head .hm-v { color: var(--fg-3); font-size: var(--fs-small); }
.hm-status { margin: 0 0 24px; height: 20px; line-height: 20px; font-size: var(--fs-body-s); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hm-status a { color: var(--fg-2); text-decoration: none; }
.hm-status a:hover { color: var(--fg); text-decoration: underline; }
.hm-status.ring .hm-ring { color: var(--warn); font-weight: 600; }
.hm .fact { font-family: var(--mono); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
/* Pick up and the log on the left, the side column beside both. */
.hm-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 320px); grid-template-rows: auto 1fr; grid-template-areas: "pick side" "days side"; gap: 32px 48px; align-items: start; }
.hm-grid.no-days { grid-template-rows: auto; grid-template-areas: "pick side"; }
.hm-grid.no-side { grid-template-columns: minmax(0, 1fr); grid-template-areas: "pick" "days"; }
@container (max-width: 760px) {
  .hm-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; grid-template-areas: "pick" "days" "side"; }
  .hm-grid.no-days { grid-template-areas: "pick" "side"; }
  .hm-grid.no-side { grid-template-areas: "pick" "days"; }
}
.hm-grid > [data-w=days] { grid-area: days; }
.hm-side { grid-area: side; display: grid; gap: 32px; min-width: 0; }
/* A section: a label on a hairline, and space doing the rest. */
.hm-w { min-width: 0; }
.hm-wh { display: flex; align-items: center; gap: 8px; height: 28px; margin: 0 0 8px; border-bottom: 1px solid var(--rule); }
.hm-wh h2 { margin: 0; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
.hm-wh h2 .n { margin-left: 6px; font-weight: 500; font-variant-numeric: tabular-nums; }
.hm-wh .hm-act { margin-left: auto; }
.hm-hide { flex: none; width: 20px; height: 20px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; opacity: 0; font-size: var(--fs-micro); }
.hm-wh .hm-act + .hm-hide { margin-left: 0; }
.hm-wh h2 + .hm-hide { margin-left: auto; }
.hm-w:is(:hover, :focus-within) .hm-hide { opacity: 1; }
.hm-hide:hover { background: var(--rule-2); color: var(--fg); }
.hm-quiet { margin: 0; color: var(--fg-3); font-size: var(--fs-small); line-height: 1.6; }
.hm-s { flex: none; color: var(--fg-3); font-size: var(--fs-small); }
.hm-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-list { list-style: none; margin: 0; padding: 0; }
.hm-link { padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); cursor: pointer; }
.hm-link:hover { color: var(--fg); text-decoration: underline; }
.hm-link.hm-undo { color: var(--accent); }
.hm-dots { display: inline-flex; gap: 3px; }
.hm-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-3); flex: none; }
.hm-dot.run, .hm-dot.work { background: var(--ok); }
.hm-dot.work { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok), transparent 75%); }
.hm-dot.need { background: var(--warn); }
/* Pick up: the one card on the page. */
.hm-pick { grid-area: pick; padding: 18px 20px 16px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); box-shadow: var(--shadow-1); min-width: 0; }
.hm-pick > h2 { margin: 0 0 4px; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
.hm-pk-top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
.hm-pk-name { font-size: var(--fs-h3); font-weight: 650; letter-spacing: -.01em; color: var(--fg); text-decoration: none; }
.hm-pk-name:hover { text-decoration: underline; }
.hm-pk-top .fact { color: var(--fg-3); }
.hm-pk-left { margin: 0 0 12px; font-size: var(--fs-body-s); line-height: 1.55; color: var(--fg); }
.hm-pk-left b { font-weight: 500; color: var(--fg-3); margin-right: 6px; }
.hm-pk-left.hm-derived { color: var(--fg-2); }
.hm-pk-left a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--rule-2); text-underline-offset: 3px; }
.hm-pk-left a:hover { text-decoration-color: currentColor; }
.hm-pk-left .fact { color: var(--fg-3); margin-left: 4px; }
.hm-pk-left code, .hm-log code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--fg-3); }
.hm-next { list-style: none; margin: 0 0 12px; padding: 0; font-size: var(--fs-ui); }
.hm-next li { display: flex; gap: 8px; padding: 2px 0; min-width: 0; }
.hm-next li::before { content: "○"; flex: none; color: var(--fg-3); }
.hm-next li span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; margin: 0; font-size: var(--fs-small); color: var(--fg-2); }
.hm-facts .fact { color: var(--fg); }
.hm-git { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.hm-git svg { flex: none; color: var(--fg-3); }
a.hm-panels { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); text-decoration: none; }
a.hm-panels:hover { color: var(--fg); }
.hm-pk-go { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 16px; }
.hm-pk-go .btn kbd { min-width: 0; margin-left: 2px; padding: 0; border: 0; background: none; color: inherit; opacity: .75; }
.hm-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); }
.hm-chips > .hm-s { margin-right: 4px; }
.hm-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--rule); border-radius: var(--r-pill); font-size: var(--fs-small); color: var(--fg); text-decoration: none; }
.hm-chip:hover { border-color: var(--rule-2); background: var(--rule); }
.hm-chip .fact { color: var(--fg-3); }
/* Your days: a day, then a desk in the gutter and what happened on it. */
.hm-day { margin: 0 0 20px; }
.hm-day h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 4px; font-size: var(--fs-small); font-weight: 600; color: var(--fg); }
.hm-day h3 .fact { font-weight: 400; color: var(--fg-3); }
.hm-entry { display: grid; grid-template-columns: 9em minmax(0, 1fr); gap: 0 16px; padding: 2px 0; }
.hm-en { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 24px; font-size: var(--fs-small); color: var(--fg-2); text-decoration: none; }
.hm-en:hover { color: var(--fg); }
@container (max-width: 520px) { .hm-entry { grid-template-columns: minmax(0, 1fr); } }
.hm-log { list-style: none; margin: 0; padding: 0; min-width: 0; }
.hm-log li { display: flex; gap: 8px; align-items: baseline; line-height: 24px; font-size: var(--fs-ui); min-width: 0; }
.hm-g { flex: none; width: 1em; text-align: center; color: var(--fg-3); font-size: var(--fs-small); }
.hm-g.ok { color: var(--ok); }
.hm-log a { flex: none; color: var(--fg-2); text-decoration: none; font-size: var(--fs-small); }
.hm-log a.hm-t { flex: 1; color: var(--fg); font-size: inherit; }
.hm-log a:hover { text-decoration: underline; }
.hm-log .hm-c { color: var(--fg-2); }
.hm-log .fact { flex: none; color: var(--fg-3); }
.hm-log .hm-more { padding-left: calc(1em + 8px); }
.hm-earlier { margin: 4px 0 0; }
/* Projects: a name, eight weeks, how long since. */
.hm-pj { display: flex; align-items: center; gap: 12px; min-height: 28px; font-size: var(--fs-ui); min-width: 0; }
.hm-pw { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.hm-pn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-weight: 500; text-decoration: none; }
.hm-pn:hover { text-decoration: underline; }
.hm-spark { flex: none; display: inline-flex; align-items: flex-end; gap: 2px; height: 16px; }
.hm-spark i { width: 5px; border-radius: 1px; background: var(--fg-3); }
.hm-spark i.now { background: var(--accent); }
.hm-spark i.z { height: 2px; background: var(--rule-2); }
.hm-age { flex: none; width: 4.5em; text-align: right; color: var(--fg-3); }
.hm-shelf .hm-t { color: var(--fg-3); font-size: var(--fs-small); }
.hm-park { display: flex; align-items: center; gap: 10px; padding: 2px 0 8px; }
.hm-park input { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-small); padding: 4px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg); color: var(--fg); }
.hm-sub { margin: 16px 0 2px; font-size: var(--fs-micro); font-weight: 600; color: var(--fg-3); }
/* Claude. */
.hm-q { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.hm-bar { height: 4px; border-radius: 2px; background: var(--rule); overflow: hidden; margin: 6px 0 4px; }
.hm-bar i { display: block; height: 100%; background: var(--fg-2); }
.hm-bar.hot i { background: var(--warn); }
.hm-k { font-size: var(--fs-small); color: var(--fg-2); }
.hm-q .fact { color: var(--fg-3); }
.hm-meta { margin: 10px 0 0; font-size: var(--fs-small); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-meta a { color: inherit; text-decoration: none; }
.hm-meta a:hover { color: var(--fg); text-decoration: underline; }
.hm-foot { margin-top: 32px; font-size: var(--fs-small); color: var(--fg-3); }
.hm-foot button { padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); cursor: pointer; }
.hm-foot button:hover { color: var(--fg); text-decoration: underline; }
/* The Inbox's foot: what was removed, and the way back. */
.inbox-removed { margin: 32px 0 0; }
.inbox-removed > .t-away { width: auto; padding-left: 14px; }
.inbox .rm { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title act" "sub act"; gap: 2px 16px; padding: 12px 14px; }
.inbox .rm > .t-undo { grid-area: act; align-self: center; }
`;

/** The widgets that can be hidden, in the order they stand. Pick up cannot:
 *  it is what the page is for. */
const WIDGETS = [
  ["days", "Your days"],
  ["projects", "Projects"],
  ["claude", "Claude"],
  ["snyvi", "snyvi"],
];

const DAY = 86400;
/** A desk this long without anything happening on it is asked, quietly,
 *  whether it is parked. */
const QUIET_DAYS = 10;

let c = null, last = null, soon = 0, reading = 0, sheet = null;
/** Parking in progress: the desk whose row holds the form, what is typed in
 *  it (kept across the redraws an event brings), and the one just parked,
 *  which keeps its row, with an Undo, for a moment. */
let parking = 0, parkDraft = "", parkFailed = false, justParked = 0, parkedT = 0;
/** What the week's button last said, in its own place, for a while. */
let weekSaid = null;
/** The log shows its first few days and a desk's first few lines; these are
 *  what the reader opened past that. */
const DAYS_FIRST = 3, LINES_FIRST = 4;
let allDays = false;
const opened = new Set();

function style() {
  if (!sheet) { sheet = Object.assign(document.createElement("style"), { id: "home-drawn", textContent: CSS }); document.head.append(sheet); }
}

const KNOWN = WIDGETS.map(w => w[0]);
const hidden = () => { try { return JSON.parse(localStorage.getItem("snyvi.home.hidden") || "[]").filter(k => KNOWN.includes(k)); } catch { return []; } };
const setHidden = xs => { try { localStorage.setItem("snyvi.home.hidden", JSON.stringify(xs)); } catch {} };
const kept = () => { try { return +localStorage.getItem("snyvi.home.pick") || 0; } catch { return 0; } };
const keep = id => { try { if (id) localStorage.setItem("snyvi.home.pick", id); else localStorage.removeItem("snyvi.home.pick"); } catch {} };

/** Draw Home into the page. `ctx` is the page's: esc, rel, relShort, plural,
 *  capability, deskApi, docEl, card (about.js's update card, as a promise),
 *  updCtx, checkUpdates, newDesk. */
export async function show(ctx) {
  c = ctx;
  style();
  if (last) draw(last);
  await refresh();
}

/** Read Home again soon: many events in a burst are one read. */
export function soonRefresh() {
  clearTimeout(soon);
  soon = setTimeout(refresh, 250);
}

async function refresh() {
  if (!c || c.view() !== "home") return;
  const turn = ++reading;
  let j;
  try { j = c.capability ? await c.deskApi("/api/home") : await (await fetch("/api/home")).json(); }
  catch { if (!last) c.docEl.innerHTML = `<div class="inbox-head"><h1>Home</h1><p>snyvi did not answer. <button type="button" class="btn" data-hm="retry">Try again</button></p></div>`; return; }
  if (turn !== reading || c.view() !== "home") return;
  last = j;
  draw(j);
}

// ---------- time, in the reader's own days ----------

const startOfDay = t => { const d = new Date(t * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000; };
const dayKey = t => startOfDay(t);
/** "Today", "Yesterday", "Sunday", then "Mon 14 Sep". */
function dayName(t) {
  const n = Math.round((startOfDay(Date.now() / 1000) - startOfDay(t)) / DAY);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  const d = new Date(t * 1000);
  return n < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const clock = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** How long ago, in one short unit: "40 min", "5 h", "4 d", "6 wk". */
function age(t) {
  const s = Date.now() / 1000 - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < DAY) return `${Math.round(s / 3600)} h`;
  if (s < 14 * DAY) return `${Math.round(s / DAY)} d`;
  return `${Math.round(s / (7 * DAY))} wk`;
}
const ago = t => Date.now() / 1000 - t < 60 ? "just now" : `${age(t)} ago`;
/** "touched 40 min ago", "touched yesterday 23:40", "touched 12 d ago". */
function touched(t) {
  if (!t) return "not opened yet";
  const n = dayName(t);
  if (Date.now() / 1000 - t < 6 * 3600 || n !== "Yesterday") return `touched ${ago(t)}`;
  return `touched yesterday ${clock(t)}`;
}

function resets(t) {
  const s = t - Date.now() / 1000;
  if (s <= 0) return "now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < DAY) return `in ${Math.round(s / 3600)} h`;
  return new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short" });
}

function group(xs, key) {
  const m = new Map();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// ---------- the page ----------

function draw(j) {
  const { esc, plural } = c, hid = hidden();
  const w = (key, title, body, extra = "", act = "") => hid.includes(key) ? "" :
    `<section class="hm-w" data-w="${key}" aria-label="${esc(title)}"><div class="hm-wh"><h2>${esc(title)}${extra}</h2>${act}` +
    `<button type="button" class="hm-hide" data-hm="hide" data-k="${key}" data-tip="Hide ${esc(title)}" data-tip-sub="Show brings it back" aria-label="Hide ${esc(title)}">✕</button></div>${body}</section>`;
  const side = [
    w("projects", "Projects", projects(j), j.desks?.length ? ` <span class="n">${j.desks.length}</span>` : ""),
    w("claude", "Claude", claude(j)),
    w("snyvi", "snyvi", `<div class="hm-upd"></div>` + `<p class="hm-quiet hm-uptodate">snyvi ${esc(j.version || "")} · <button type="button" class="uc-link" data-hm="check">Check for updates</button></p>`),
  ].join("");
  const days = w("days", "Your days", yourDays(j), "", weekButton(j));
  const n = hid.length;
  const html = `<div class="hm"><header class="hm-head"><h1>Home</h1><span class="hm-v">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span></header>` +
    status(j) +
    `<div class="hm-grid${!side ? " no-side" : !days ? " no-days" : ""}">${pick(j)}${days}${side ? `<div class="hm-side">${side}</div>` : ""}</div>` +
    (n ? `<p class="hm-foot">${plural(n, "widget")} hidden · <button type="button" data-hm="unhide">Show</button></p>` : "") + `</div>`;
  const a = document.activeElement;
  const had = c.docEl.contains(a) && a.dataset.hm ? a.dataset.hm + (a.dataset.k || "") : null;
  c.docEl.innerHTML = html;
  if (had) {
    const el = [...c.docEl.querySelectorAll("[data-hm]")].find(b => b.dataset.hm + (b.dataset.k || "") === had);
    el?.focus({ preventScroll: true });
    if (el?.tagName === "INPUT") el.setSelectionRange(el.value.length, el.value.length);
  }
  wire();
  const up = c.docEl.querySelector(".hm-upd");
  if (up) c.card().then(m => { if (m.card(up, j.update, c.updCtx())) { const q = c.docEl.querySelector(".hm-uptodate"); if (q) q.hidden = true; } }, () => {});
}

/** One line under the title, the same height whatever it says: what needs
 *  the reader, what is waiting to be read, what Claude is doing, and what is
 *  left of the account's five-hour window. Amber when a panel rang or Claude
 *  is asking. */
function status(j) {
  const { esc, plural } = c, bits = [];
  let ring = false;
  if (j.desks) {
    const asking = [];
    for (const d of j.desks) for (const p of d.panes) if (p.blocked || p.agent === "needs_you") asking.push([d, p]);
    if (asking.length) {
      ring = true;
      const [d, p] = asking[0];
      bits.push(`<a class="hm-ring" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${esc(d.name)} · ${esc(p.name || `panel ${p.slot}`)} ${p.agent === "needs_you" ? "is asking" : "rang"}${asking.length > 1 ? `, and ${asking.length - 1} more` : ""}</a>`);
    } else bits.push("Nothing needs you");
  }
  bits.push(j.waiting ? `<a href="/inbox" data-nav="inbox">${plural(j.waiting, "document")} to read</a>` : bits.length ? "nothing to read" : "Nothing to read");
  if (j.desks) {
    const n = j.desks.flatMap(d => d.panes).filter(p => p.agent === "working").length;
    bits.push(n ? `${plural(n, "Claude")} working` : "Claude idle");
  }
  const w = windowLeft(j.quota?.five_hour);
  if (w) bits.push(`<span data-tip="Claude's five-hour window" data-tip-sub="${esc(w.text)}">5 h window ${w.fresh ? "full" : `${w.left}% left`}</span>`);
  return `<p class="hm-status${ring ? " ring" : ""}">${bits.join(" · ")}</p>`;
}

/** A branch, drawn as git's own mark: two commits and the line between. */
const BRANCH = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="5.5" r="1.8"/><path d="M4 5.3v5.4M12 7.3c0 3-4 2.5-7.2 4"/></svg>`;

/** The dots of the panels that are doing something; a stopped panel has none. */
const liveDots = d => { const ps = d.panes.filter(p => p.running || p.blocked || p.agent === "working" || p.agent === "needs_you"); return ps.length ? `<span class="hm-dots">${ps.map(dot).join("")}</span>` : ""; };

const paneWord = p => p.blocked ? "rang" : p.agent === "needs_you" ? "Claude is asking" : p.agent === "working" ? "Claude working"
  : p.agent === "done" ? "Claude done" : p.running ? "running" : "stopped";

function dot(p) {
  const cls = p.blocked || p.agent === "needs_you" ? "need" : p.agent === "working" ? "work" : p.running ? "run" : "";
  return `<i class="hm-dot ${cls}" aria-hidden="true"></i>`;
}

/** The desk Pick up offers: the one the reader keeps there, else the one
 *  touched last. Parked desks are on the shelf, not here. */
function pickOf(j) {
  const live = (j.desks || []).filter(d => !d.parked || d.id === justParked).sort((a, b) => b.touched - a.touched || b.id - a.id);
  const k = kept(), hero = live.find(d => d.id === k) || live[0];
  return { hero, rest: live.filter(d => d !== hero), isKept: !!hero && hero.id === k };
}

function pick(j) {
  const { esc, plural } = c;
  const box = body => `<section class="hm-pick" aria-label="Pick up">${body}</section>`;
  if (!j.desks) return box(`<p class="hm-quiet">Desks are in the snyvi window; a browser tab cannot see them. Everything your agents sent is in <a href="/inbox" data-nav="inbox">the Inbox</a>.</p>`);
  if (!j.desks.length) return box(`<h2>Pick up</h2><p class="hm-quiet">No desks yet. A desk is one project: its folder, and up to four panels in it.</p><div class="hm-pk-go"><button type="button" class="btn btn-primary" data-hm="newdesk">+ New desk</button></div>`);
  const { hero: d, rest, isKept } = pickOf(j);
  if (!d) return box(`<h2>Pick up</h2><p class="hm-quiet">Every desk is parked. Take one down in Projects when you are ready for it.</p>`);
  const l = d.left_off, x = d.last;
  const left = l
    ? `<p class="hm-pk-left"><b>Left off</b>${esc(l.text)}<span class="fact">${l.by ? `${esc(l.by)} · ` : ""}${ago(l.at)}</span></p>`
    : x
      ? `<p class="hm-pk-left hm-derived" data-tip="No one said where this was left" data-tip-sub="so this is the last thing that happened on it"><b>Last</b>${x.kind === "tick"
          ? `✓ ${esc(x.text)}${x.commit ? ` <code>${esc(x.commit.slice(0, 7))}</code>` : ""}`
          : `sent <a href="/d/${esc(x.id)}" data-id="${esc(x.id)}">${esc(x.text)}</a>`}<span class="fact">${ago(x.at)}</span></p>`
      : `<p class="hm-pk-left hm-quiet"><b>Left off</b>not said yet. A Claude on this desk says it at the end of a stretch, or write it in the desk's head.</p>`;
  // A list with nothing left open is a milestone said in numbers
  // (docs/DESIGN.md §3.2); a desk with no list yet is not.
  const next = d.next.length
    ? `<ul class="hm-next" aria-label="Open notes">${d.next.map(t => `<li><span>${esc(t)}</span></li>`).join("")}${d.open > d.next.length ? `<li class="hm-s"><span>and ${d.open - d.next.length} more</span></li>` : ""}</ul>`
    : d.done ? `<p class="hm-s hm-done">Notes done · ${d.done} of ${d.done}</p>` : "";
  const g = d.git;
  const git = g ? `<span class="hm-git" data-tip="What git says in ${esc(d.root || "the desk's folder")}" data-tip-sub="${g.last ? `last commit ${ago(g.last.at)}: ${esc(g.last.subject)}` : "no commits yet"}">${BRANCH}<span class="fact">${esc(g.branch || "no branch")}</span>` +
    `<span>${g.changed ? `${plural(g.changed, "file")} changed` : "clean"}${g.ahead ? ` · ${g.ahead} not pushed` : ""}${g.last ? ` · committed ${ago(g.last.at)}` : ""}</span></span>` : "";
  const panels = d.panes.map(p =>
    `<a class="hm-panels" href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}">${dot(p)}${esc(p.name || `panel ${p.slot}`)} <span class="hm-s">${paneWord(p)}</span></a>`).join("");
  const facts = git || panels ? `<p class="hm-facts">${git}${panels}</p>` : "";
  const chips = rest.length ? `<p class="hm-chips"><span class="hm-s">or</span>${rest.map(o =>
    `<a class="hm-chip" href="/desk/${o.id}" data-desk="${o.id}" data-tip="${esc(o.name)} · ${o.touched ? touched(o.touched) : "not opened yet"}" data-tip-sub="${esc(o.panes.map(p => `${p.name || `panel ${p.slot}`} ${paneWord(p)}`).join(" · ") || "no panels")}">` +
    `${esc(o.name)}${liveDots(o)}<span class="fact">${o.touched ? age(o.touched) : "new"}</span></a>`).join("")}</p>` : "";
  return box(`<h2>Pick up</h2><div class="hm-pk-top"><a class="hm-pk-name" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="fact">${touched(d.touched)}</span></div>` +
    left + next + facts +
    `<div class="hm-pk-go"><a class="btn btn-primary" href="/desk/${d.id}" data-desk="${d.id}" data-hm-open>Open desk<kbd>↵</kbd></a>` +
    (rest.length || isKept ? `<button type="button" class="hm-link" data-hm="keep" data-k="${d.id}" data-tip="${isKept ? "Let Pick up follow the desk touched last" : "Keep this desk in Pick up"}" data-tip-sub="${isKept ? "instead of this one" : "instead of whichever was touched last"}">${isKept ? "Kept here · Follow the last touched" : "Keep here"}</button>` : "") +
    `</div>` + chips);
}

/** What happened, day by day and desk by desk: lines ticked (with the commit
 *  and the evidence the agent gave), documents sent, commits in the desk's
 *  folder, and where the work was left. The last three days with anything in
 *  them, and the rest of the week on a button; a desk's day shows its first
 *  few lines and says how many more. */
function yourDays(j) {
  const { esc } = c;
  if (!j.days) return `<p class="hm-quiet">The log of your days is in the snyvi window, beside the desks it comes from.</p>`;
  const names = new Map((j.desks || []).map(d => [d.id, d.name]));
  const rows = j.days.filter(r => names.has(r.desk));
  if (!rows.length) return `<p class="hm-quiet">Nothing yet this week. Notes ticked, documents sent, Left off lines and commits on your desks show up here, day by day.</p>`;
  const days = [...group(rows, r => dayKey(r.at)).values()].reverse();
  const shown = allDays ? days : days.slice(0, DAYS_FIRST);
  return shown.map(rs => {
    const k = dayKey(rs[0].at), n = dayName(rs[0].at);
    // "Mon 14 Sep" says its date already; the near days get it beside them.
    const date = /\d/.test(n) ? "" : new Date(rs[0].at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const desks = [...group(rs, r => r.desk)].sort((a, b) => b[1].at(-1).at - a[1].at(-1).at);
    return `<div class="hm-day"><h3>${n}${date ? `<span class="fact">${esc(date)}</span>` : ""}</h3>${desks.map(([id, xs]) => entry(k, id, names.get(id), xs)).join("")}</div>`;
  }).join("") +
    (days.length > DAYS_FIRST ? `<p class="hm-earlier"><button type="button" class="hm-link" data-hm="days">${allDays ? "Show fewer days" : `${days.length - DAYS_FIRST} earlier ${days.length - DAYS_FIRST === 1 ? "day" : "days"} · Show`}</button></p>` : "");
}

/** The week as a document, on the log's own heading. */
function weekButton(j) {
  const { esc } = c;
  if (!j.days?.length) return "";
  const said = weekSaid && weekSaid.until > Date.now() ? weekSaid.text : "";
  return `<button type="button" class="hm-link hm-act" data-hm="week" data-tip="A document for each desk, in its own project" data-tip-sub="the last seven days, as they are here">${said ? esc(said) : "Send this week as a doc"}</button>`;
}

/** One desk's rows on one day, newest first. A commit the agent named when it
 *  ticked a line is that line's, and is not listed again. */
function entry(day, id, name, rs) {
  const { esc, plural } = c;
  const ticks = rs.filter(r => r.kind === "tick");
  const named = ticks.map(t => t.commit).filter(Boolean);
  const commits = rs.filter(r => r.kind === "commit" && !named.some(h => h.startsWith(r.hash) || r.hash.startsWith(h)));
  const seen = new Set(), docs = rs.filter(r => r.kind === "doc" && !seen.has(r.text) && seen.add(r.text));
  const left = rs.filter(r => r.kind === "left").pop();
  const li = [];
  const at = t => `<span class="fact">${clock(t)}</span>`;
  if (left) li.push([left.at, `<li><span class="hm-g">✎</span><span class="hm-t hm-c" data-tip="Left off" data-tip-sub="${esc(left.text)}">Left off: ${esc(left.text)}</span>${at(left.at)}</li>`]);
  for (const t of ticks) li.push([t.at, `<li><span class="hm-g ok">✓</span><span class="hm-t" data-tip="${esc(t.text)}" data-tip-sub="${t.by ? `ticked by ${esc(t.by)}` : "ticked"}">${esc(t.text)}</span>` +
    `${t.commit ? `<code>${esc(t.commit.slice(0, 7))}</code>` : ""}${t.doc ? `<a href="/d/${esc(t.doc)}" data-id="${esc(t.doc)}">doc</a>` : ""}${t.evidence ? `<a href="${esc(t.evidence)}" target="_blank" rel="noopener" data-tip="${esc(t.evidence)}">see it ↗</a>` : ""}${at(t.at)}</li>`]);
  for (const x of docs) li.push([x.at, `<li><span class="hm-g"></span><a class="hm-t" href="/d/${esc(x.id)}" data-id="${esc(x.id)}">${esc(x.text)}</a>${at(x.at)}</li>`]);
  if (commits.length) {
    const newest = commits.slice(-3).reverse();
    li.push([newest[0].at, `<li><span class="hm-g">${BRANCH}</span><span class="hm-t hm-c" data-tip="${plural(commits.length, "commit")}" data-tip-sub="${esc(newest.map(x => x.text).join(" · "))}">${plural(commits.length, "commit")} · ${esc(newest[0].text)}</span>${at(newest[0].at)}</li>`]);
  }
  li.sort((a, b) => b[0] - a[0]);
  const key = `${day}:${id}`, open = opened.has(key), more = li.length - LINES_FIRST;
  const lines = (open || more <= 1 ? li : li.slice(0, LINES_FIRST)).map(x => x[1]);
  if (more > 1) lines.push(`<li class="hm-more"><button type="button" class="hm-link" data-hm="more" data-k="${esc(key)}">${open ? "Show fewer" : `${more} more`}</button></li>`);
  return `<div class="hm-entry"><a class="hm-en" href="/desk/${id}" data-desk="${id}">${esc(name)}</a><ul class="hm-log">${lines.join("")}</ul></div>`;
}

/** The last seven days of one desk, as markdown, oldest day first. */
function weekMd(name, title, rs) {
  const line = r => r.kind === "tick" ? `- ✓ ${r.text}${r.commit ? ` (\`${r.commit.slice(0, 7)}\`)` : ""}${r.evidence ? ` · [see it](${r.evidence})` : ""}`
    : r.kind === "doc" ? `- Sent [${r.text}](/d/${r.id})`
    : r.kind === "commit" ? `- Commit \`${r.hash}\` ${r.text}`
    : `- Left off: ${r.text}`;
  const out = [`# ${name} · ${title}`, ""];
  for (const day of group(rs, r => dayKey(r.at)).values())
    out.push(`## ${new Date(day[0].at * 1000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`, "", ...day.map(line), "");
  return out.join("\n");
}

async function sendWeek(b) {
  const j = last;
  if (!j?.days || b.disabled) return;
  const names = new Map(j.desks.map(d => [d.id, d.name]));
  const since = startOfDay(Date.now() / 1000) - 6 * DAY;
  const per = group(j.days.filter(r => r.at >= since && names.has(r.desk)), r => r.desk);
  const title = `the week to ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
  b.disabled = true; b.textContent = "Sending…";
  const sent = [];
  for (const [id, rs] of per) {
    try { await c.deskApi(`/api/desks/${id}/week`, { title: `${names.get(id)} · ${title}`, content: weekMd(names.get(id), title, rs) }); sent.push(names.get(id)); } catch {}
  }
  weekSaid = { text: !per.size ? "Nothing this week to send" : sent.length ? `Sent: ${sent.join(", ")}` : "Could not send · Try again", until: Date.now() + 6000 };
  draw(last);
  setTimeout(() => { if (weekSaid && weekSaid.until <= Date.now() && last && c.view() === "home") draw(last); }, 6100);
}

/** Eight weeks of a desk, a bar a week, as tall as the days with anything in
 *  them: a rhythm, not a streak. This week's bar is the current one. */
function spark(pulse = []) {
  const end = startOfDay(Date.now() / 1000) + DAY, weeks = Array.from({ length: 8 }, () => new Set());
  for (const t of pulse) { const w = Math.floor((end - t) / (7 * DAY)); if (w >= 0 && w < 8) weeks[7 - w].add(dayKey(t)); }
  const n = weeks.map(s => s.size);
  return `<span class="hm-spark" role="img" aria-label="Days with work in each of the last eight weeks: ${n.join(", ")}" data-tip="Days with work, a week a bar" data-tip-sub="eight weeks ago to this week: ${n.join(" · ")}">` +
    n.map((v, i) => v ? `<i${i === 7 ? ` class="now"` : ""} style="height:${2 + v * 2}px"></i>` : `<i class="z"></i>`).join("") + `</span>`;
}

function projects(j) {
  const { esc } = c;
  if (!j.desks) return `<p class="hm-quiet">Open the window to see your projects.</p>`;
  if (!j.desks.length) return `<p class="hm-quiet">Each desk shows here with its last eight weeks.</p>`;
  const now = Date.now() / 1000;
  const live = j.desks.filter(d => !d.parked || d.id === justParked).sort((a, b) => b.touched - a.touched || b.id - a.id);
  const shelf = j.desks.filter(d => d.parked && d.id !== justParked).sort((a, b) => b.parked.at - a.parked.at);
  const row = d => {
    const done = (j.days || []).filter(r => r.desk === d.id && r.kind === "tick" && r.at >= now - 7 * DAY).length;
    let say = "", tail;
    if (d.id === justParked) { say = `<span class="hm-s">Parked</span><button type="button" class="hm-link hm-undo" data-hm="unpark" data-k="${d.id}">Undo</button>`; tail = ""; }
    else {
      if (done) say = `<span class="hm-s" data-tip="${done} ${done === 1 ? "note" : "notes"} ticked in the last seven days">${done} done</span>`;
      if (d.touched && now - d.touched > QUIET_DAYS * DAY && parking !== d.id)
        say += `<button type="button" class="hm-link" data-hm="park" data-k="${d.id}" data-tip="Put it on the shelf" data-tip-sub="it leaves Pick up; nothing on it is closed">Park it?</button>`;
      tail = d.touched ? age(d.touched) : "new";
    }
    const form = parking === d.id ? `<li class="hm-park"><input data-hm="next" data-k="${d.id}" maxlength="200" placeholder="The next step, for when you come back" aria-label="The next step on ${esc(d.name)}" value="${esc(parkDraft)}">` +
      `<button type="button" class="hm-link" data-hm="parkgo" data-k="${d.id}">Park</button><button type="button" class="hm-link" data-hm="parkno">Cancel</button>${parkFailed ? `<span class="hm-s">Could not park</span>` : ""}</li>` : "";
    return `<li class="hm-pj"><span class="hm-pw"><a class="hm-pn" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a>${say}</span>${spark(d.pulse)}<span class="hm-age fact">${tail}</span></li>${form}`;
  };
  return `<ul class="hm-list">${live.map(row).join("")}</ul>` +
    (shelf.length ? `<h3 class="hm-sub">Parked</h3><ul class="hm-list hm-shelf">${shelf.map(d =>
      `<li class="hm-pj"><span class="hm-pw"><a class="hm-pn" href="/desk/${d.id}" data-desk="${d.id}">${esc(d.name)}</a><span class="hm-t">${d.parked.next ? `next: ${esc(d.parked.next)}` : ""}</span></span>` +
      `<button type="button" class="hm-link" data-hm="unpark" data-k="${d.id}">Take down</button><span class="hm-age fact">${age(d.parked.at)}</span></li>`).join("")}</ul>` : "");
}

/** What is left of one rate-limit window, as a share from 0 to 100 and a
 *  line of words. Claude Code drops a window once its reset time passes, and
 *  the daemon keeps the last reading it was given, so a window past its reset
 *  is a full one again until a Claude answers and a new reading comes. */
function windowLeft(l) {
  if (!l) return null;
  if (l.resets_at <= Date.now() / 1000) return { left: 100, fresh: true, text: `full · reset ${age(l.resets_at)} ago` };
  const left = Math.round(100 - Math.max(0, Math.min(100, l.used)));
  return { left, hot: left <= 20, text: `${left}% left · resets ${resets(l.resets_at)}` };
}

/** What is left of the account's quota and when that was read, what the
 *  Claudes in panels are doing, and the fullest context window. The bar is
 *  what is left, and turns amber at a fifth. */
function claude(j) {
  const { esc, plural } = c;
  const q = j.quota, out = [];
  const bar = (label, l) => { const w = windowLeft(l); return w ? `<div><span class="hm-k">${label}</span><div class="hm-bar${w.hot ? " hot" : ""}"><i style="width:${w.left}%"></i></div><span class="fact">${w.text}</span></div>` : ""; };
  if (q && (q.five_hour || q.seven_day)) out.push(`<div class="hm-q">${bar("5 hours", q.five_hour)}${bar("7 days", q.seven_day)}</div>${q.at ? `<p class="hm-meta fact">As of ${age(q.at)} ago, from the last Claude that answered.</p>` : ""}`);
  if (j.desks) {
    const ps = j.desks.flatMap(d => d.panes.map(p => ({ ...p, desk: d.name, deskId: d.id })));
    const working = ps.filter(p => p.agent === "working").length, done = ps.filter(p => p.agent === "done").length;
    const hot = ps.filter(p => p.ctx_pct != null).sort((a, b) => b.ctx_pct - a.ctx_pct)[0];
    if (working || done) out.push(`<p class="hm-meta">${working ? `${plural(working, "Claude")} working` : ""}${working && done ? " · " : ""}${done ? `${done} done` : ""}</p>`);
    if (hot) out.push(`<p class="hm-meta"><a href="/desk/${hot.deskId}" data-desk="${hot.deskId}" data-slot="${hot.slot}">Fullest context: ${esc(hot.desk)} · ${esc(hot.name || `panel ${hot.slot}`)} at ${hot.ctx_pct}%${hot.model ? ` (${esc(hot.model)})` : ""}</a></p>`);
  }
  if (!out.length) return `<p class="hm-quiet">No Claude at work. The quota shows here once one in a panel has answered.</p>`;
  return out.join("");
}

async function park(id, next) {
  try { await c.deskApi(`/api/desks/${id}/park`, next == null ? {} : { next }); }
  catch { parkFailed = true; draw(last); return false; }
  return true;
}

function wire() {
  const el = c.docEl.querySelector(".hm");
  if (!el || el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", async e => {
    const b = e.target.closest("button[data-hm]");
    if (!b) return;
    const k = b.dataset.hm, id = +b.dataset.k || 0;
    if (k === "hide") { setHidden([...new Set([...hidden(), b.dataset.k])]); draw(last); c.docEl.querySelector("[data-hm=unhide]")?.focus({ preventScroll: true }); }
    else if (k === "unhide") { setHidden([]); draw(last); }
    else if (k === "check") c.checkUpdates(b);
    else if (k === "newdesk") c.newDesk(b);
    else if (k === "keep") { keep(kept() === id ? 0 : id); draw(last); c.docEl.querySelector("[data-hm=keep]")?.focus({ preventScroll: true }); }
    else if (k === "week") sendWeek(b);
    else if (k === "days") { allDays = !allDays; draw(last); c.docEl.querySelector("[data-hm=days]")?.focus({ preventScroll: true }); }
    else if (k === "more") { const key = b.dataset.k; opened.has(key) ? opened.delete(key) : opened.add(key); draw(last); }
    else if (k === "park") { parking = id; parkDraft = ""; parkFailed = false; draw(last); c.docEl.querySelector("input[data-hm=next]")?.focus(); }
    else if (k === "parkno") { parking = 0; parkFailed = false; draw(last); }
    else if (k === "parkgo") parkNow(id);
    else if (k === "unpark") {
      b.disabled = true;
      if (!(await park(id, null))) return;
      if (justParked === id) { justParked = 0; clearTimeout(parkedT); }
      soonRefresh();
    }
  });
  el.addEventListener("input", e => { if (e.target.dataset?.hm === "next") parkDraft = e.target.value; });
  el.addEventListener("keydown", e => {
    if (e.target.dataset?.hm !== "next") return;
    if (e.key === "Enter") { e.preventDefault(); parkNow(+e.target.dataset.k); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); parking = 0; draw(last); }
  });
}

/** Park the desk with what was typed: the row keeps its place and says so,
 *  with an Undo, for four seconds, and then goes up on the shelf. */
async function parkNow(id) {
  parkFailed = false;
  if (!(await park(id, parkDraft.trim()))) return;
  parking = 0; parkDraft = ""; justParked = id;
  draw(last);
  clearTimeout(parkedT);
  parkedT = setTimeout(() => { justParked = 0; if (last && c.view() === "home") draw(last); }, 4000);
  soonRefresh();
}

// Enter opens the desk Pick up offers, from anywhere on Home that is not
// itself something to type in or press.
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !c || c.view() !== "home") return;
  if (e.target.closest?.("input, textarea, select, button, a, summary, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const a = c.docEl.querySelector("[data-hm-open]");
  if (a) { e.preventDefault(); a.click(); }
});

/* After the Undo has gone: "N removed · Show" at the foot of the Inbox,
 * and the list it opens, an Undo on each row, until prune takes them
 * (docs/DESIGN.md §4.4). Documents, asides and closed desks; a desk's
 * notes and panels are its rail's to show. The list stays open through the redraw its own
 * Undo brings, and closes when the reader leaves the Inbox. */
let removedOpen = false;
export async function removedLine(fresh, { view, capability, deskApi, docEl, esc, rel, post, loadDesks, toast }) {
  if (fresh) removedOpen = false;
  let items;
  try { items = (capability ? await deskApi("/api/removed") : await (await fetch("/api/removed")).json()).items.filter(r => r.kind !== "note" && r.kind !== "panel"); } catch { return; }
  if (!items?.length || view() !== "inbox" || docEl.querySelector(".inbox-removed")) return;
  style();
  const el = document.createElement("div");
  el.className = "inbox-removed";
  const list = () => {
    removedOpen = true;
    el.innerHTML = `<h2 class="inbox-sec">Removed</h2><ul class="inbox">${items.map((r, i) =>
      `<li><div class="rm"><span class="title">${esc(r.title)}</span><span class="sub">${esc(r.from || r.kind)} · removed ${rel(r.at)}${r.versions > 1 ? ` · ${r.versions} versions` : ""}</span><button type="button" class="t-undo" data-i="${i}">Undo</button></div></li>`).join("")}</ul>`;
  };
  el.innerHTML = `<button type="button" class="t-away">${items.length} removed · Show</button>`;
  el.addEventListener("click", async e => {
    if (e.target.closest(".t-away")) { list(); el.querySelector("[data-i]")?.focus({ preventScroll: true }); return; }
    const b = e.target.closest("[data-i]");
    if (!b || b.disabled) return;
    const r = items[b.dataset.i];
    b.disabled = true;
    // Back: the row says so; a document's "restored" redraws the Inbox with it in.
    if (r.kind === "desk") { try { await deskApi(r.restore, {}); await loadDesks(); return void (b.textContent = "Back"); } catch {} }
    else if ((await post(r.restore, r.kind === "aside" ? { ids: [Number(r.id)] } : null))?.ok) return void (b.textContent = "Back");
    b.disabled = false; b.textContent = "Retry";
    toast("Could not bring it back", { sub: r.title, at: b });
  });
  if (removedOpen) list();
  docEl.append(el);
}

/** The Inbox's own page, drawn here beside Home: what is waiting first,
 *  oldest first, then everything, newest first. */
export function inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown }) {
  const row = d => (noteKnown(d), `<li><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`);
  // The one empty state (docs/DESIGN.md §3.4): snyvi at rest, one
  // sentence, one button.
  if (!items.length) return `<div class="empty-state"><span class="hero">${mascotHead("rest")}</span><h1>Nothing in the Inbox yet</h1>` +
    `<p>What your agents write lands here, filed by project.</p><button type="button" class="btn btn-primary" data-nav="start">How snyvi works</button></div>`;
  // What is waiting comes first, oldest first, so the landing page answers
  // "what is new" before "what is there".
  const n = state.waiting;
  return `<div class="inbox-head"><h1>Inbox</h1><p>${n ? `${plural(n, "document")} waiting to be read, then everything else, newest first.` : "Newest first, across every project."}</p></div>` +
    (n ? `<h2 class="inbox-sec">Waiting<span class="n">${n}</span><button type="button" data-q="next">Open the first<kbd>n</kbd></button><button type="button" data-q="clear">Mark all read</button></h2><ul class="inbox waiting">${state.queue.map(row).join("")}</ul><h2 class="inbox-sec">Recent</h2>` : "") +
    `<ul class="inbox">${items.map(row).join("")}</ul>`;
}


// The retry on a Home that could not be read is outside `.hm`.
document.addEventListener("click", e => { if (c && e.target.closest("[data-hm=retry]")) refresh(); });
