/* Home: the page the mark opens, at `/`.
 *
 * What needs the reader, then the desks and where each was left, then what is
 * waiting to be read and what came lately, then Claude's account and snyvi
 * itself. One call (`GET /api/home`), drawn whole, and drawn again when the
 * daemon says something it shows has moved -- panes, a panel's context, the
 * desks, a desk's notes, a document, the update. Debounced, so a burst of
 * events is one read.
 *
 * A chunk: a reader who goes straight to a document never fetches it. The
 * Inbox moved to `/inbox`, and `i` still opens it; its foot, "N removed ·
 * Show", is drawn from here too (`removedLine`), as the other page that lists.
 *
 * A widget can be hidden and shown again ("2 hidden · Show"): the list is
 * this viewer's, in localStorage, since it is a preference about a page and
 * not a thing in the library. Nothing here moves when something arrives:
 * every widget keeps its place, and one with nothing to say says so
 * ("Nothing needs you") rather than going away.
 */

const CSS = `
.hm { max-width: 980px; margin: 0 auto; padding: 8px 0 40px; }
.hm-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 18px; }
.hm-head h1 { margin: 0; font-size: var(--fs-h1, 26px); letter-spacing: -.01em; }
.hm-head .hm-v { color: var(--fg-3); font-size: var(--fs-small); }
.hm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; align-items: start; }
.hm-w { position: relative; padding: 12px 14px 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg-raise, var(--bg)); min-width: 0; }
.hm-w.wide { grid-column: 1 / -1; }
.hm-w h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: var(--fs-ui); font-weight: 600; color: var(--fg-2); }
.hm-w h2 .n { font-weight: 500; color: var(--fg-3); }
.hm-hide { position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; opacity: 0; }
.hm-w:is(:hover, :focus-within) .hm-hide { opacity: 1; }
.hm-hide:hover { background: var(--rule-2); color: var(--fg); }
.hm-quiet { margin: 0; color: var(--fg-3); font-size: var(--fs-small); }
.hm-list { list-style: none; margin: 0; padding: 0; }
.hm-list li { min-width: 0; }
.hm-list a, .hm-list button.hm-row { display: flex; gap: 8px; align-items: baseline; width: 100%; padding: 4px 6px; margin: 0 -6px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; font-size: var(--fs-small); color: var(--fg); text-align: left; text-decoration: none; cursor: pointer; }
.hm-list a:hover, .hm-list button.hm-row:hover { background: var(--rule); }
.hm-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-s { flex: none; color: var(--fg-3); font-size: var(--fs-micro); }
.hm-list a.new .hm-t { font-weight: 600; }
.hm-desks { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.hm-desk { display: block; padding: 10px 12px; border: 1px solid var(--rule); border-radius: var(--r-md); background: var(--bg); color: var(--fg); text-decoration: none; min-width: 0; }
.hm-desk:hover { border-color: var(--accent); text-decoration: none; }
.hm-desk .hm-dn { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.hm-dots { display: inline-flex; gap: 3px; }
.hm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rule-2); }
.hm-dot.run { background: var(--ok); }
.hm-dot.work { background: var(--accent); }
.hm-dot.need { background: var(--warn); }
.hm-left { margin: 6px 0 0; font-size: var(--fs-small); color: var(--fg-2); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.hm-left b { font-weight: 500; color: var(--fg-3); }
.hm-meta { margin: 6px 0 0; font-size: var(--fs-micro); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-q { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.hm-bar { height: 5px; border-radius: 3px; background: var(--rule); overflow: hidden; margin: 4px 0 2px; }
.hm-bar i { display: block; height: 100%; background: var(--accent); }
.hm-bar.hot i { background: var(--warn); }
.hm-k { font-size: var(--fs-micro); color: var(--fg-3); }
.hm-big { font-size: var(--fs-ui); color: var(--fg); }
.hm-foot { margin-top: 16px; font-size: var(--fs-small); color: var(--fg-3); }
.hm-foot button { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer; }
.hm-act { margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
.hm-act button, .hm-act a { padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-small); color: var(--accent); cursor: pointer; text-decoration: none; }
.hm-act button:hover, .hm-act a:hover { text-decoration: underline; }
/* The Inbox's foot: what was removed, and the way back. */
.inbox-removed { margin: 32px 0 0; }
.inbox-removed > .t-away { width: auto; padding-left: 14px; }
.inbox .rm { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title act" "sub act"; gap: 2px 16px; padding: 12px 14px; }
.inbox .rm > .t-undo { grid-area: act; align-self: center; }
`;

/** The widgets, in the order they stand. */
const WIDGETS = [
  ["needs", "Needs you"],
  ["desks", "Desks"],
  ["waiting", "Waiting to read"],
  ["left", "What's left"],
  ["claude", "Claude"],
  ["recent", "Recent"],
  ["snyvi", "snyvi"],
];

let c = null, last = null, soon = 0, reading = 0, sheet = null;

function style() {
  if (!sheet) { sheet = Object.assign(document.createElement("style"), { id: "home-drawn", textContent: CSS }); document.head.append(sheet); }
}

const hidden = () => { try { return JSON.parse(localStorage.getItem("snyvi.home.hidden") || "[]"); } catch { return []; } };
const setHidden = xs => { try { localStorage.setItem("snyvi.home.hidden", JSON.stringify(xs)); } catch {} };

/** Draw Home into the page. `ctx` is the page's: esc, rel, relShort, plural,
 *  capability, deskApi, docEl, card (about.js's update card, as a promise),
 *  updCtx, notes (the asides). */
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

function draw(j) {
  const { esc, plural } = c, hid = hidden();
  const w = (key, title, body, extra = "") => hid.includes(key) ? "" :
    `<section class="hm-w${key === "desks" ? " wide" : ""}" data-w="${key}" aria-label="${esc(title)}"><h2>${esc(title)}${extra}</h2>` +
    `<button type="button" class="hm-hide" data-hm="hide" data-k="${key}" data-tip="Hide ${esc(title)}" data-tip-sub="Show brings it back" aria-label="Hide ${esc(title)}">✕</button>${body}</section>`;
  const parts = {
    needs: () => w("needs", "Needs you", needs(j)),
    desks: () => w("desks", "Desks", desks(j), j.desks ? ` <span class="n">${j.desks.length}</span>` : ""),
    waiting: () => w("waiting", "Waiting to read", waiting(j), j.waiting ? ` <span class="n">${j.waiting}</span>` : ""),
    left: () => w("left", "What's left", left(j)),
    claude: () => w("claude", "Claude", claude(j)),
    recent: () => w("recent", "Recent", recent(j)),
    snyvi: () => w("snyvi", "snyvi", `<div class="hm-upd"></div>` + `<p class="hm-quiet hm-uptodate">snyvi ${esc(j.version || "")} · <button type="button" class="uc-link" data-hm="check">Check for updates</button></p>`),
  };
  const n = hid.length;
  const html = `<div class="hm"><header class="hm-head"><h1>Home</h1><span class="hm-v">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</span></header>` +
    `<div class="hm-grid">${WIDGETS.map(([k]) => parts[k]()).join("")}</div>` +
    (n ? `<p class="hm-foot">${plural(n, "widget")} hidden · <button type="button" data-hm="unhide">Show</button></p>` : "") + `</div>`;
  const had = c.docEl.contains(document.activeElement) && document.activeElement.dataset.hm ? document.activeElement.dataset.hm + (document.activeElement.dataset.k || "") : null;
  c.docEl.innerHTML = html;
  if (had) [...c.docEl.querySelectorAll("[data-hm]")].find(b => b.dataset.hm + (b.dataset.k || "") === had)?.focus({ preventScroll: true });
  wire();
  const up = c.docEl.querySelector(".hm-upd");
  if (up) c.card().then(m => { if (m.card(up, j.update, c.updCtx())) { const q = c.docEl.querySelector(".hm-uptodate"); if (q) q.hidden = true; } }, () => {});
}

/** Panels waiting on the reader, across every desk: the slot stays, and says
 *  so quietly when there are none. */
function needs(j) {
  const { esc } = c;
  if (!j.desks) return `<p class="hm-quiet">Desks are in the snyvi window; a browser tab cannot see them.</p>`;
  const rows = [];
  for (const d of j.desks) for (const p of d.panes) if (p.blocked || p.agent === "needs_you")
    rows.push(`<li><a href="/desk/${d.id}" data-desk="${d.id}" data-slot="${p.slot}"><span class="hm-t">${esc(d.name)} · panel ${p.slot}${p.name ? ` · ${esc(p.name)}` : ""}</span><span class="hm-s">${p.agent === "needs_you" ? "Claude is asking" : "rang"}${p.blocked_since || p.agent_since ? ` · ${c.relShort(p.blocked_since || p.agent_since)}` : ""}</span></a></li>`);
  return rows.length ? `<ul class="hm-list">${rows.join("")}</ul>` : `<p class="hm-quiet">Nothing needs you.</p>`;
}

function dot(p) {
  const cls = p.blocked || p.agent === "needs_you" ? "need" : p.agent === "working" ? "work" : p.running ? "run" : "";
  return `<i class="hm-dot ${cls}"></i>`;
}

function desks(j) {
  const { esc, plural } = c;
  if (!j.desks) return `<p class="hm-quiet">Open the window to see desks.</p>`;
  if (!j.desks.length) return `<p class="hm-quiet">No desks yet. A desk is one project: its folder, and up to four panels in it.</p><div class="hm-act"><button type="button" data-hm="newdesk">+ New desk</button></div>`;
  return `<div class="hm-desks">${j.desks.map(d => {
    const l = d.left_off;
    const meta = [d.open ? `${plural(d.open, "note")} open` : "no open notes", d.suggested ? `${d.suggested} suggested` : "", d.last_doc ? `last: ${esc(d.last_doc.title)}` : ""].filter(Boolean).join(" · ");
    return `<a class="hm-desk" href="/desk/${d.id}" data-desk="${d.id}"><span class="hm-dn">${esc(d.name)}<span class="hm-dots">${d.panes.map(dot).join("")}</span></span>` +
      (l ? `<p class="hm-left"><b>Left off</b> ${esc(l.text)} <span class="hm-s">· ${c.relShort(l.at)}</span></p>` : `<p class="hm-left"><b>Left off</b> not said yet</p>`) +
      `<p class="hm-meta">${meta}</p></a>`;
  }).join("")}</div>`;
}

function waiting(j) {
  const { esc } = c;
  if (!j.queue.length) return `<p class="hm-quiet">Nothing waiting to be read.</p>`;
  return `<ul class="hm-list">${j.queue.map(d => `<li><a href="/d/${d.id}" data-id="${d.id}" class="new"><span class="hm-t">${esc(d.title)}</span><span class="hm-s">${esc(d.project)} · ${c.relShort(d.received_at)}</span></a></li>`).join("")}</ul>` +
    `<div class="hm-act"><button type="button" data-hm="next">Open the first</button><a href="/inbox" data-nav="inbox">All documents</a></div>`;
}

/** The open notes across every desk, the first few of each. */
function left(j) {
  const { esc } = c;
  if (!j.desks) return `<p class="hm-quiet">Desk notes are in the snyvi window.</p>`;
  const rows = [];
  for (const d of j.desks) for (const t of d.next || []) rows.push(`<li><a href="/desk/${d.id}" data-desk="${d.id}"><span class="hm-t">${esc(t)}</span><span class="hm-s">${esc(d.name)}</span></a></li>`);
  return rows.length ? `<ul class="hm-list">${rows.slice(0, 9).join("")}</ul>` : `<p class="hm-quiet">No open notes on any desk.</p>`;
}

/** The account's quota, what the Claudes in panels are doing, and the
 *  fullest context window. */
function claude(j) {
  const { esc, plural } = c;
  const q = j.quota, out = [];
  const bar = (label, l) => l ? `<div><span class="hm-k">${label}</span><div class="hm-bar${l.used >= 80 ? " hot" : ""}"><i style="width:${Math.max(0, Math.min(100, l.used)).toFixed(0)}%"></i></div><span class="hm-k">${Math.round(l.used)}% · resets ${resets(l.resets_at)}</span></div>` : "";
  if (q && (q.five_hour || q.seven_day)) out.push(`<div class="hm-q">${bar("5 hours", q.five_hour)}${bar("7 days", q.seven_day)}</div>`);
  if (j.desks) {
    const ps = j.desks.flatMap(d => d.panes.map(p => ({ ...p, desk: d.name, deskId: d.id })));
    const working = ps.filter(p => p.agent === "working").length, done = ps.filter(p => p.agent === "done").length;
    const hot = ps.filter(p => p.ctx_pct != null).sort((a, b) => b.ctx_pct - a.ctx_pct)[0];
    out.push(`<p class="hm-big">${working ? `${plural(working, "Claude")} working` : "No Claude working"}${done ? ` · ${done} done` : ""}</p>`);
    if (hot) out.push(`<p class="hm-meta"><a href="/desk/${hot.deskId}" data-desk="${hot.deskId}" data-slot="${hot.slot}">Fullest: ${esc(hot.desk)} · panel ${hot.slot} at ${hot.ctx_pct}%${hot.model ? ` (${esc(hot.model)})` : ""}</a></p>`);
  }
  if (!out.length) return `<p class="hm-quiet">Nothing from Claude yet. The quota shows once a Claude in a panel has answered.</p>`;
  return out.join("");
}

function resets(t) {
  const s = t - Date.now() / 1000;
  if (s <= 0) return "now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short" });
}

function recent(j) {
  const { esc } = c;
  if (!j.recent.length) return `<p class="hm-quiet">Nothing yet.</p>`;
  return `<ul class="hm-list">${j.recent.map(d => `<li><a href="/d/${d.id}" data-id="${d.id}"${d.unread ? ` class="new"` : ""}><span class="hm-t">${esc(d.title)}</span><span class="hm-s">${esc(d.project)} · ${c.relShort(d.received_at)}</span></a></li>`).join("")}</ul>`;
}

function wire() {
  const el = c.docEl.querySelector(".hm");
  if (!el || el.dataset.wired) return;
  el.dataset.wired = "1";
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-hm]");
    if (!b) return;
    const k = b.dataset.hm;
    if (k === "hide") { setHidden([...new Set([...hidden(), b.dataset.k])]); draw(last); c.docEl.querySelector("[data-hm=unhide]")?.focus({ preventScroll: true }); }
    else if (k === "unhide") { setHidden([]); draw(last); }
    else if (k === "next") c.next();
    else if (k === "check") c.checkUpdates(b);
    else if (k === "newdesk") c.newDesk(b);
  });
}

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
