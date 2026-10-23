/* ui/desk/18-back.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the back (1.49) ----------

/* A panel in the back keeps running out of the grid: the dev server nobody
 * reads until it breaks. Its slot is past the grid's (src/desk.rs `BACK`),
 * so the daemon's slot is all this page goes by. It is a chip in the head's
 * `.dk-tabs` span, which already comes and goes, and a drawer over the bottom
 * of the grid when the reader looks.
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

/** What a panel in the back is doing, in a word or two, for its chip. */
function backSays(v) {
  const s = v.status;
  // The desks list carries no exit code; the panel's own status does.
  const ended = s.exit != null ? `exited ${s.exit}` : "ended";
  if (s.blocked) return s.running ? "a command failed" : ended;
  if (s.running) return "running";
  return s.exit != null ? ended : "stopped";
}

/** The head's chips, after the grid's tabs: one a panel in the back, amber
 *  when it died, which is when it needs the reader. */
function backChips(d) {
  const vs = backViews(d), { esc } = ctx;
  if (!vs.length) return "";
  return `<span class="dk-back" data-part="desk.back" role="group" aria-label="In the back">` + vs.map(v => {
    const s = v.status, cls = s.blocked ? " blk" : s.running ? " run" : "";
    return `<button type="button" class="dk-chip${cls}${drawerOn === v.id ? " on" : ""}" data-drawer="${v.id}" aria-expanded="${drawerOn === v.id}" ` +
      `data-tip="${esc(short(v))} · ${esc(backSays(v))}" data-tip-sub="${esc(lastLine(v) || "in the back")}" data-key="ctrl+alt+b">` +
      `<i class="dot" aria-hidden="true"></i>${esc(short(v))}${s.blocked ? "!" : ""}</button>`;
  }).join("") + `</span>`;
}

/** The chips again, where they stand, when a panel's mark changed: the
 *  head is laid out only when the panes move, and a death moves nothing. */
function backHead(d) {
  const t = ctx.docEl.querySelector(".dk-tabs");
  if (!t || !d) return;
  if (drawerOn) backLayout(d);
  const html = backChips(d), el = t.querySelector(".dk-back");
  if (el ? el.outerHTML === html : !html) return;
  if (el) el.remove();
  if (html) t.insertAdjacentHTML("beforeend", html);
}

/** The drawer, drawn once with the desk; `backLayout` fills it. */
const DRAWER = `<div class="dk-drawer" data-part="desk.drawer" aria-hidden="true" role="region" aria-label="In the back"><div class="dk-dr-head"></div><div class="dk-dr-body"></div><p class="dk-dr-foot"></p></div>`;

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
  const v = views.get(drawerOn), { esc } = ctx;
  if (!v) return;
  // With several in the back the drawer's head picks between them.
  dr.querySelector(".dk-dr-head").innerHTML = (vs.length > 1 ? vs.map(x => `<button type="button" class="dk-dr-tab${x === v ? " on" : ""}${x.status.blocked ? " blk" : ""}" data-drawer-to="${x.id}">${x.pane.slot} ${esc(short(x))}</button>`).join("") : `<b class="dk-dr-name">${esc(short(v))}</b>`) +
    `<span class="dk-dr-say">${esc(backSays(v))}</span>` +
    `<button type="button" class="dk-dr-fwd" data-a="forward" data-p="${v.id}" data-tip="Bring forward" data-tip-sub="into the grid" data-key="ctrl+alt+shift+b">Bring forward</button>` +
    `<button type="button" class="dk-dr-x" data-a="drawer-x" data-tip="Close the drawer" data-key="ctrl+alt+b" aria-label="Close the drawer">${ctx.glyph("x")}</button>`;
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

/* "New panel in the back…": a command of its own, so its end is the
 * server's. A row under + New panel opens a one-line field in its place. */
let backField = false, backDraft = "", backCaret = 0;
const backRow = (d, esc) => {
  const full = backViews(d).length >= ctx.desks.in_back;
  if (backField && !full) return `<form class="dk-backnew"><input spellcheck="false" autocomplete="off" placeholder="npm run dev" aria-label="Command to run in the back" value="${esc(backDraft)}"><button type="submit" class="dk-new">Start</button><button type="button" class="dk-new" data-a="back-new-x">Cancel</button></form>`;
  return `<button type="button" class="dk-new${full ? ` dim" aria-disabled="true` : ""}" data-a="back-new" data-tip="New panel in the back" data-tip-sub="${esc(full ? `The back holds ${ctx.desks.in_back}` : "a dev server, a watcher: running, out of the grid")}">+ In the back…</button>`;
};

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
    const j = await ctx.api(`/api/desks/${d.id}/panes`, { cmd, back: true });
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
  if (c) { drawer(drawerOn === c.dataset.drawer ? null : c.dataset.drawer); return true; }
  const t = e.target.closest("[data-drawer-to]");
  if (t) { drawer(t.dataset.drawerTo); return true; }
  return false;
}

function backAct(a, b, d) {
  const v = views.get(b.dataset.p);
  if (a === "forward" && v) sendBack(v, false);
  else if (a === "to-back" && v) sendBack(v, true);
  else if (a === "drawer-x") drawer(null);
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
  if (!drawerOn || t.closest?.(".pn-body, input, textarea, [contenteditable]")) return false;
  e.preventDefault(); e.stopPropagation();
  drawer(null);
  return true;
}
document.addEventListener("submit", e => { if (ctx && deskId != null) backSubmit(e); }, true);

const BACK_CSS = `
/* ---------- the back ----------
 * Chips after the grid's tabs, in the head that is already there; the dot is
 * the rail's: green running, amber when it died and needs the reader. */
.dk-back { display: flex; gap: 4px; margin-left: 6px; }
.dk-tabs .dk-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 16ch; padding: 2px 7px; border: 1px solid var(--rule-2); border-radius: var(--r-pill); font-family: var(--mono); font-size: 11px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-chip .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--fg-3); }
.dk-chip.run .dot { background: var(--ok); }
.dk-tabs .dk-chip.blk { color: var(--warn); border-color: var(--warn); font-weight: 600; }
.dk-chip.blk .dot { background: var(--warn); }
.dk-tabs .dk-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
.dk-tabs .dk-back.pn-drop { outline: 2px dashed var(--accent); outline-offset: 2px; border-radius: var(--r-pill); }
/* The drawer: over the bottom of the grid, laid out always, seen only open. */
.dk { position: relative; }
.dk-drawer { position: absolute; left: 0; right: 0; bottom: 0; height: 42%; z-index: 5; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: var(--shadow); visibility: hidden; pointer-events: none; }
.dk-drawer.open { visibility: visible; pointer-events: auto; animation: dk-fade 120ms ease-out; }
/* The head and foot keep their height whatever they say, so the box the
 * panels share is one size, open or shut, on one panel or another. */
.dk-dr-head { display: flex; align-items: center; gap: 6px; min-width: 0; height: 24px; flex: none; font-size: 12px; }
.dk-dr-name { font-family: var(--mono); font-weight: 600; }
.dk-dr-tab { font-family: var(--mono); font-size: 11px; padding: 2px 6px; border-radius: var(--r-xs); color: var(--fg-3); }
.dk-dr-tab.on { color: var(--accent); background: var(--accent-bg); }
.dk-dr-tab.blk { color: var(--warn); font-weight: 600; }
.dk-dr-say { color: var(--fg-3); margin-right: auto; }
.dk-dr-fwd { padding: 2px 8px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); color: var(--fg-2); }
.dk-dr-fwd:hover { color: var(--fg); border-color: var(--accent); }
.dk-dr-x { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--r-xs); color: var(--fg-3); }
.dk-dr-x:hover { background: var(--rule-2); color: var(--fg); }
.dk-dr-body { position: relative; flex: 1; min-height: 0; }
/* Every panel in the back in one box, so each has the drawer's size; only
 * the one open on is seen, and only while the drawer is. */
.dk-dr-body > .pn { position: absolute; inset: 0; visibility: hidden; }
.dk-drawer.open .dk-dr-body > .pn.cur { visibility: visible; }
.dk-dr-body .pn-full { display: none; }
.dk-dr-foot { margin: 0; height: 16px; flex: none; color: var(--fg-3); font-size: var(--fs-micro); line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-backnew { display: flex; gap: 4px; align-items: center; }
.dk-backnew input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; padding: 2px 6px; border: 1px solid var(--rule-2); border-radius: var(--r-xs); background: var(--bg); color: var(--fg); }
#toc .dk-backline { margin: 6px 0 2px; padding-left: 8px; color: var(--fg-3); font-size: var(--fs-micro); list-style: none; }
`;
