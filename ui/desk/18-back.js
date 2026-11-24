/* ui/desk/18-back.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the back (1.49) ----------

/* A panel in the back keeps running out of the grid: the dev server nobody
 * reads until it breaks. Its slot is past the grid's (src/desk.rs `BACK`),
 * so the daemon's slot is all this page goes by. It is a chip in the head's
 * `.dk-tabs` span, which already comes and goes -- one chip for all of them
 * (1.69) -- and a drawer over the bottom of the grid when the reader looks.
 *
 * The drawer is always laid out, hidden: every panel in the back is mounted
 * in it, stacked in one box, so each has a real size from the first layout
 * and starts the way a visible panel does (`fit` → `resume`). Opening it only
 * flips visibility: no reflow, and the program's columns never change under
 * it. It lies over the grid and never pushes it: nothing shifts. */

/** In the back: past the grid's four. */
const isBack = p => p.slot > (ctx.desks?.per_desk || 4);
const gridPanes = d => d.panes.filter(p => !isBack(p));
const backViews = d => d.panes.filter(isBack).map(p => views.get(p.id)).filter(Boolean);

/** The panel in the back the drawer is open on, or null while it is shut. */
let drawerOn = null;

/** The last line a panel printed, for its chip's tip: the error, when it died. */
function lastLine(v) {
  for (let y = v.cells.length - 1; y >= 0; y--) {
    const t = v.cells[y].map(c => (c ? c[0] : "")).join("").trim();
    if (t) return t.length > 120 ? t.slice(0, 119) + "…" : t;
  }
  return "";
}

/** How long, short: "6 min", "2 h", "3 d". */
function backAge(at) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

/** What a panel in the back is doing, for its chip, and the chip's class
 *  (1.67, plan f586a9fe09). An agent's own word comes first: one that asked
 *  rang its bell, and until 1.67 the chip read that as "a command failed",
 *  the words for a dead dev server, on an agent that only had a question.
 *  Asks you, working and finished say since when; a shell says running, or
 *  how it ended. */
function backState(v) {
  const s = v.status, at = s.agent_since;
  if (s.agent === "needs_you") return ["asks you" + (at ? ` · ${backAge(at)}` : ""), " blk"];
  if (s.agent === "working") return ["working" + (at ? ` ${backAge(at)}` : ""), " run"];
  if (s.agent === "done") return ["finished" + (at ? ` ${new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""), " fin"];
  // The desks list carries no exit code; the panel's own status does.
  const ended = s.exit != null ? `exited ${s.exit}` : "ended";
  if (s.blocked) return [s.running ? "a command failed" : ended, " blk"];
  if (s.running) return ["running", " run"];
  return [s.exit != null ? ended : "stopped", ""];
}

/** Whether the chip's list is open: the back's panels, each with its word,
 *  laid over the head. Only with several in the back; one opens its drawer. */
let backList = false;
const BACK_ICO = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/></svg>`;

/** The head's chip, after the grid's tabs (1.69, plan 520aa866b0): one for
 *  the whole back, the mark and how many, one width whatever the count.
 *  Amber when any panel there asks or died, which is when it needs the
 *  reader. It was a chip a panel, each with its name and its word: three
 *  in the back took a third of the head, and every minute's "working 6
 *  min" redrew it. The words are the tip's now, and the list's: with one
 *  panel a click opens its drawer; with several, a short list of them over
 *  the head, each row opening its own. `backHead` writes it again only when
 *  it differs, at a panel's status. */
function backChips(d) {
  const vs = backViews(d), { esc } = ctx;
  if (!vs.length) { backList = false; return ""; }
  const sts = vs.map(backState), blk = sts.some(s => s[1] === " blk"), many = vs.length > 1;
  const open = many && backList, on = vs.some(v => v.id === drawerOn);
  const tip = many ? `${vs.length} in the back` : `${short(vs[0])} · ${sts[0][0]}`;
  const sub = many ? vs.map((v, i) => `${short(v)} · ${sts[i][0]}`).join(", ") : lastLine(vs[0]) || "in the back";
  const rows = open ? `<span class="dk-back-list" role="menu" aria-label="In the back">` + vs.map((v, i) =>
    `<button type="button" role="menuitem" class="dk-brow${sts[i][1]}${drawerOn === v.id ? " on" : ""}" data-drawer="${v.id}" data-tip="${esc(short(v))} · ${esc(sts[i][0])}" data-tip-sub="${esc(lastLine(v) || "in the back")}">` +
    `<i class="dot" aria-hidden="true"></i><span class="dk-chip-n">${esc(short(v))}</span><span class="dk-chip-s">${esc(sts[i][0])}</span></button>`).join("") + `</span>` : "";
  return `<span class="dk-back" data-part="desk.back" role="group" aria-label="In the back">` +
    `<button type="button" class="dk-chip${blk ? " blk" : ""}${on || open ? " on" : ""}" data-back-all data-ids="${vs.map(v => v.id).join(" ")}" aria-expanded="${many ? open : on}"${many ? ` aria-haspopup="menu"` : ""} ` +
    `aria-label="${vs.length} in the back${blk ? ", one needs you" : ""}" data-tip="${esc(tip)}" data-tip-sub="${esc(sub)}" data-key="ctrl+alt+b">${BACK_ICO}<span class="n">${vs.length}</span></button>${rows}</span>`;
}

/** The chip again, where it stands, when a panel's mark changed: the
 *  head is laid out only when the panes move, and a death moves nothing.
 *  A row of the list the keyboard was on keeps the focus through it. */
function backHead(d) {
  const t = ctx.docEl.querySelector(".dk-tabs");
  if (!t || !d) return;
  if (drawerOn) backLayout(d);
  const html = backChips(d), el = t.querySelector(".dk-back");
  if (el ? el.outerHTML === html : !html) return;
  const at = el && el.contains(document.activeElement) ? document.activeElement : null;
  const sel = at && (at.dataset.drawer ? `[data-drawer="${at.dataset.drawer}"]` : "[data-back-all]");
  if (el) el.remove();
  if (html) t.insertAdjacentHTML("beforeend", html);
  if (sel) t.querySelector(`.dk-back ${sel}`)?.focus({ preventScroll: true });
}
// A press anywhere else shuts the list, as a menu is shut.
document.addEventListener("pointerdown", e => {
  if (!backList || !ctx || e.target.closest?.(".dk-back")) return;
  backList = false;
  const d = current(); if (d) backHead(d);
}, true);

/** The drawer, drawn once with the desk; `backLayout` fills it. */
const DRAWER = `<div class="dk-drawer" data-part="desk.drawer" aria-hidden="true" role="region" aria-label="In the back"><div class="dk-dr-body"></div><p class="dk-dr-foot"></p></div>`;

/** The back's panels into the drawer, the one open on shown, every one
 *  sized: called by `layout`, as the grid's are put in the grid. */
function backLayout(d) {
  const dr = ctx.docEl.querySelector(".dk-drawer");
  if (!dr) return;
  const vs = backViews(d);
  if (drawerOn && !vs.some(v => v.id === drawerOn)) drawerOn = null;
  const body = dr.querySelector(".dk-dr-body"), want = vs.map(v => v.el);
  if (want.length !== body.children.length || want.some((el, i) => body.children[i] !== el)) {
    const had = body.contains(document.activeElement) ? document.activeElement : null;
    body.replaceChildren(...want);
    if (had && had.isConnected) had.focus({ preventScroll: true });
    for (const v of vs) v.behind = true;
  }
  const open = !!drawerOn && reading == null;
  dr.classList.toggle("open", open);
  dr.setAttribute("aria-hidden", String(!open));
  for (const v of vs) v.el.classList.toggle("cur", v.id === drawerOn);
  const v = views.get(drawerOn);
  if (!v) return;
  // The drawer has no head of its own: the panel's head is its head, with
  // Bring forward, ⌄ Hide and the panel's own ✕ Close panel, shown in the
  // drawer only (the style below), and the chips in the desk's head pick between
  // several. It had a head with a ✕ that hid it, over the panel's ✕ that
  // closed it: two crosses five pixels apart meaning two things (#229,
  // 1.60.1), and a row of tabs the chips already were.
  // A shell snyvi does not dress says nothing of the commands in it: only
  // its own end is heard, and the drawer says so rather than pretend.
  dr.querySelector(".dk-dr-foot").textContent = !v.status.cmd && !v.status.accent && !v.pane.cmd ? "This shell’s prompt is its own, so only its end is heard, not a command failing in it." : "";
  catchUp(v);
}

/** The drawer open on a panel in the back, or shut; the reader's focus goes
 *  with it, into the panel or back to the grid. */
function drawer(id) {
  drawerOn = id && views.has(id) ? id : null;
  layout();
  const v = views.get(drawerOn || focused);
  if (v && (drawerOn || !isBack(v.pane))) v.body.focus();
  else { const g = current() && gridPanes(current())[0]; if (g) views.get(g.id)?.body.focus(); }
}

/** ⌃⌥B: the drawer shut if open, open on the last one if not; with nothing
 *  in the back, the focused panel goes there. */
function backKey() {
  const d = current();
  if (!d) return;
  if (drawerOn) return drawer(null);
  const vs = backViews(d), v = views.get(focused);
  if (vs.length) return drawer((vs.find(x => x.status.blocked) || vs.find(x => x.id === focused) || vs[0]).id);
  if (v) sendBack(v, true);
}

/** A panel to the back, or forward into the grid: the menu, ⌃⌥⇧B, Bring
 *  forward, and a head dropped on the chips. Each side's cap says no first. */
async function sendBack(v, back) {
  const d = current(), j = ctx.desks;
  if (!d || isBack(v.pane) === back) return;
  if (back && backViews(d).length >= j.in_back) return ctx.toast("Move to the back", `The back holds ${j.in_back}`);
  if (!back && noNew(d)) return ctx.toast("Bring forward", noNew(d));
  try {
    await ctx.api(`/api/panes/${v.id}/back`, { back });
    if (drawerOn === v.id) drawerOn = null;
    await ctx.refresh();
    if (!back) focusPane(v.id);
    else if (focused === v.id) { const g = gridPanes(current() || d)[0]; if (g) focusPane(g.id); }
  } catch (e) {
    ctx.toast(back ? "Could not move it to the back" : "Could not bring it forward", e);
  }
}

/* "Panel in the back…": a command of its own, so its end is the server's.
 * The row at the Panels' foot opens a one-line field in its place. */
let backField = false, backDraft = "", backCaret = 0;
const backRow = (d, esc) => {
  const full = backViews(d).length >= ctx.desks.in_back;
  // The field says what it is for and where it runs (1.56, audit B7): a
  // bare `npm run dev` was a mini-language in a placeholder.
  if (backField && !full) return `<form class="dk-backnew"><input spellcheck="false" autocomplete="off" placeholder="npm run dev · runs in this desk's folder" aria-label="A command to run in the back, in this desk's folder with its keys" data-tip="A command, run in the back" data-tip-sub="in this desk's folder, with its keys, out of the grid: a dev server, a watcher" value="${esc(backDraft)}"><button type="submit" class="dk-new" data-tip="Start it in the back" data-tip-sub="a shell of its own, in this desk's folder">Start</button><button type="button" class="dk-new" data-a="back-new-x">Cancel</button></form>`;
  return `<button type="button" class="dk-new dk-new-back${full ? ` dim" aria-disabled="true` : ""}" data-a="back-new" data-tip="New panel in the back" data-tip-sub="${esc(full ? `The back holds ${ctx.desks.in_back}` : "a dev server, a watcher: running, out of the grid")}">+ Panel in the back…</button>`;
};
/** Whether the back's field has the foot's line (06-rail.js). */
const backFieldOpen = d => backField && backViews(d).length < ctx.desks.in_back;

/* The rail is drawn again on every status a panel sends: what is typed in
 * the field, and the caret, are kept here and put back after a draw. */
document.addEventListener("input", e => { const i = e.target.closest?.(".dk-backnew input"); if (i) { backDraft = i.value; backCaret = i.selectionStart; } }, true);
const backHeld = () => !!document.activeElement?.closest?.(".dk-backnew");
function backFocus(had) {
  const i = had && ctx.tocEl.querySelector(".dk-backnew input");
  if (i && document.activeElement !== i) { i.focus({ preventScroll: true }); i.setSelectionRange(backCaret, backCaret); }
}

async function backNew(d, cmd) {
  cmd = cmd.trim();
  if (!cmd) return;
  backField = false; backDraft = "";
  try {
    const j = await ctx.api(`/api/desks/${d.id}/panes`, { cmd, back: true, ...(d.grp ? { grp: d.grp } : {}) });
    await ctx.refresh();
    // Its first size is the drawer's, and its first start is this one.
    const nv = views.get(j.pane.id);
    if (nv) await run(nv, cmd, true);
  } catch (e) {
    ctx.toast("Could not open a panel in the back", e);
    rail();
  }
}

/** The page's side of the back: the chips, the drawer's own buttons, the
 *  field. True when it was the back's to handle. */
function backClick(e) {
  const c = e.target.closest("[data-drawer]");
  if (c) { backList = false; drawer(drawerOn === c.dataset.drawer ? null : c.dataset.drawer); return true; }
  if (!e.target.closest("[data-back-all]")) return false;
  const d = current(), vs = d ? backViews(d) : [];
  if (vs.length === 1) drawer(drawerOn ? null : vs[0].id);
  else if (vs.length) {
    backList = !backList;
    backHead(d);
    // A key's press lands in the list; a pointer's leaves the keyboard in its panel.
    if (backList && !e.detail) ctx.docEl.querySelector(".dk-back-list button")?.focus();
  }
  return true;
}

function backAct(a, b, d) {
  const v = views.get(b.dataset.p);
  if (a === "forward" && v) sendBack(v, false);
  else if (a === "to-back" && v) sendBack(v, true);
  else if (a === "drawer-hide") drawer(null);
  else if (a === "back-new") { if (backViews(d).length < ctx.desks.in_back) { backField = true; rail(); ctx.tocEl.querySelector(".dk-backnew input")?.focus(); } else ctx.toast("New panel in the back", `The back holds ${ctx.desks.in_back}`); }
  else if (a === "back-new-x") { backField = false; backDraft = ""; rail(); }
  else return false;
  return true;
}

function backSubmit(e) {
  const f = e.target.closest(".dk-backnew");
  if (!f) return false;
  e.preventDefault();
  const d = current();
  if (d) backNew(d, f.querySelector("input").value);
  return true;
}

/** Esc shuts the drawer -- from its own head, or anywhere but a panel,
 *  where Esc is the program's. */
function backEsc(e) {
  if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey) return false;
  const t = e.target;
  if (t.closest?.(".dk-backnew")) { e.preventDefault(); e.stopPropagation(); backField = false; backDraft = ""; rail(); return true; }
  if (backList && !t.closest?.(".pn-body, input, textarea, [contenteditable]")) {
    e.preventDefault(); e.stopPropagation();
    backList = false;
    const d = current(); if (d) backHead(d);
    ctx.docEl.querySelector(".dk-back [data-back-all]")?.focus();
    return true;
  }
  if (!drawerOn || t.closest?.(".pn-body, input, textarea, [contenteditable]")) return false;
  e.preventDefault(); e.stopPropagation();
  drawer(null);
  return true;
}
document.addEventListener("submit", e => { if (ctx && deskId != null) backSubmit(e); }, true);

const BACK_CSS = `
/* ---------- the back ----------
 * One chip after the grid's tabs, in the head that is already there: the
 * mark and a count, one width for one panel or nine. Amber when a panel in
 * the back asks or died. Its list, with several, lies over the head and the
 * grid's first rows: it takes no room of its own. */
.dk-back { position: relative; display: flex; margin-left: 6px; }
.dk-tabs .dk-chip { display: inline-flex; align-items: center; justify-content: center; gap: 4px; width: 40px; padding: 2px 0; border: 1px solid var(--rule-2); border-radius: var(--r-pill); font-family: var(--mono); font-size: 11px; color: var(--fg-2); white-space: nowrap; }
.dk-chip svg { flex: none; }
.dk-chip .n { min-width: 1ch; font-variant-numeric: tabular-nums; }
.dk-tabs .dk-chip.blk { color: var(--warn); border-color: var(--warn); font-weight: 600; }
.dk-tabs .dk-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
.dk-tabs .dk-back.pn-drop { outline: 2px dashed var(--accent); outline-offset: 2px; border-radius: var(--r-pill); }
.dk-back-list { position: absolute; top: calc(100% + 6px); right: 0; z-index: var(--z-pop, 30); display: grid; gap: 1px; width: max-content; min-width: 200px; max-width: min(360px, calc(100vw - 32px)); padding: 4px; border: 1px solid var(--rule); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); }
.dk-tabs .dk-brow { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 3px 6px; border-radius: var(--r-xs); color: var(--fg-2); text-align: left; }
.dk-tabs .dk-brow:is(:hover, :focus-visible) { background: var(--rule); color: var(--fg); }
.dk-brow .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--fg-3); }
.dk-brow.run .dot { background: var(--ok); }
.dk-brow.fin .dot { background: var(--rule-2); }
.dk-brow.blk .dot { background: var(--warn); }
.dk-brow .dk-chip-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dk-brow .dk-chip-s { flex: none; font-family: var(--sans); color: var(--fg-3); }
.dk-tabs .dk-brow.blk, .dk-brow.blk .dk-chip-s { color: var(--warn); }
.dk-tabs .dk-brow.on { color: var(--accent); }
/* The drawer: over the bottom of the grid, laid out always, seen only open. */
.dk { position: relative; }
.dk-drawer { position: absolute; left: 0; right: 0; bottom: 0; height: 42%; z-index: 5; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); visibility: hidden; pointer-events: none; }
.dk-drawer.open { visibility: visible; pointer-events: auto; animation: dk-fade 120ms ease-out; }
/* The foot keeps its height whatever it says, so the box the panels share
 * is one size, open or shut, on one panel or another. */
.dk-dr-body .pn-fwd { display: block; padding: 0 8px; height: 22px; margin: -4px 4px -4px 0; border: 1px solid var(--rule-2); border-radius: var(--r-xs); color: var(--fg-2); font-size: var(--fs-micro); }
.dk-dr-body .pn-fwd:hover { color: var(--fg); border-color: var(--accent); }
.dk-dr-body .pn-hide { display: grid; }
.dk-dr-body { position: relative; flex: 1; min-height: 0; }
/* Every panel in the back in one box, so each has the drawer's size; only
 * the one open on is seen, and only while the drawer is. */
.dk-dr-body > .pn { position: absolute; inset: 0; visibility: hidden; }
.dk-drawer.open .dk-dr-body > .pn.cur { visibility: visible; }
.dk-dr-body .pn-full { display: none; }
.dk-dr-foot { margin: 0; height: 16px; flex: none; color: var(--fg-3); font-size: var(--fs-micro); line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-backnew { display: flex; gap: 4px; align-items: center; }
/* At the Panels' foot, quiet: the second way to a panel (the first is the head's +). */
.dk-foot .dk-backnew { flex: 1; min-width: 0; }
.dk-foot .dk-new-back { font-size: var(--fs-micro); align-self: center; }
.dk-backnew input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); color: var(--fg); }
#toc .dk-backline { margin: 6px 0 2px; padding-left: 8px; color: var(--fg-3); font-size: var(--fs-micro); list-style: none; }
`;
