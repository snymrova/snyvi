/* ui/desk/25-views.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- views over a desk (1.58, plan 6ff79c55a7) ----------
/*
 * A desk has views, not kinds: Panels (the grid, as ever), Folder (the desk's
 * folder read over it, #214), and a Board for each `design/<board>/` its
 * folder holds (docs/BOARD.md). The switcher sits in the head at a fixed
 * place, Panels and Folder always there, so a board appearing adds a button
 * at the end, into the head's free middle, and moves nothing.
 *
 * A board opens over the grid, inside it, and docks one panel beside it --
 * the one the reader last had focused, else the first -- so the agent they
 * talk to is in reach while they look. The pane's own element is moved into
 * the dock, socket, scrollback and keys untouched, and `layout` leaves it
 * out of the grid while it is there; Panels puts it back. The board itself
 * is ui/board, fetched the first time one opens.
 *
 * Opening a view sets the reader's focus (`/api/desks/{id}/focus`); Panels
 * clears it. The board sets it again on every selection.
 */

/** The board open on this desk, or null on the panels. */
let viewOn = null;
/** The pane docked beside it, by id. */
let docked = null;
let boardMod = null, boardLoading = null;

const viewsOf = d => (ctx.desks && ctx.desks.views && ctx.desks.views[d.id]) || ["folder"];
const boardsOf = d => viewsOf(d).filter(v => v.startsWith("board:")).map(v => v.slice(6));

function tellFocus(f) {
  if (deskId == null) return;
  ctx.api(`/api/desks/${deskId}/focus`, f).catch(() => {});
}

/* 1.60 (plan 586c0491b6): the views live in the desk's ⋯ menu, not in a
 * switcher in the head -- the head stays quiet, and the place of nothing in
 * it depends on which boards a folder holds. What the head keeps is the way
 * back: while a view other than the panels is open, one chip, `Folder ✕`,
 * at the start of the left-off line's room. That line takes the head's free
 * middle and cuts its own text, so the chip coming and going takes from
 * that text and moves no control. ✕ on the chip, Esc on the view, ⌃⌥F for
 * Folder, or Panels in ⋯ go back. */

/** The views this desk has, in the menu's order: `[view, label]`. */
// Each with a line on what it is, for the menu: a view is a way of looking
// at the same desk, and "Page" or "Board" alone does not say which way.
const viewList = d => [["panels", "Panels", "your shells and Claude, side by side"],
  ["folder", "Folder", "this desk's files, a panel with them"],
  ["page", "Page", "the desk's landing page, to show people"],
  ...boardsOf(d).map(n => [`board:${n}`, `Board · ${n}`, "frames Claude draws, a panel with them"])];

/** The view open on desk `d`: "panels", "folder", "page" or "board:<name>". */
const viewNow = d => fdock && fdock.desk === d.id ? "folder" : viewOn && viewOn.desk === d.id ? (viewOn.page ? "page" : `board:${viewOn.board}`) : "panels";

/** Who opened the view on screen, when it was an agent (`open_view`): its tip says so. */
let viewBy = "";

/** The chip, drawn in place on every layout: in the left-off line's box,
 *  before the line, there only while a view is open. */
function viewsSlot(d) {
  const hd = ctx.docEl.querySelector(".dk-head"), { esc } = ctx;
  if (!hd) return;
  const on = viewNow(d);
  // A board by the name its board.json gives, once read (V3); its folder's until then.
  let name = (viewList(d).find(([v]) => v === on) || [, ""])[1];
  if (on.startsWith("board:") && boardMod && boardMod.name()) name = `Board · ${boardMod.name()}`;
  let el = hd.querySelector(".dk-vchip:not(.dk-vboard)");
  if (on === "panels") { el?.remove(); boardHint(d, hd, on); return; }
  if (!el) {
    el = Object.assign(document.createElement("button"), { type: "button", className: "dk-vchip" });
    // In the left-off box, before its line (05-desk.js `leftBox`, #227).
    const c = hd.querySelector(".dk-left-c");
    if (c) c.before(el); else hd.querySelector(".dk-groups").after(el);
  }
  const html = `<span>${esc(name)}</span><i aria-hidden="true">✕</i>`;
  if (el.$html !== html) { el.innerHTML = html; el.$html = html; }
  el.setAttribute("aria-label", `${name}: back to the panels`);
  el.dataset.tip = "Back to the panels";
  el.dataset.tipSub = (viewBy ? `opened by ${viewBy} · ` : "") + "Esc or ⋯ → Panels too";
  if (on === "folder") el.dataset.key = "ctrl+alt+f"; else delete el.dataset.key;
  boardHint(d, hd, on);
}

/* Over the folder, inside a board's own folder (`design/<board>/`): the board
 * is one click away, after the chip (V8). A folder of frames read as files
 * is half of what it is. */
function boardHint(d, hd, on) {
  const m = on === "folder" && /^design\/([a-z0-9][a-z0-9-]{0,63})(\/|$)/.exec(folderPath());
  const b = m && boardsOf(d).includes(m[1]) ? m[1] : "";
  let el = hd.querySelector(".dk-vboard");
  if (!b) { el?.remove(); return; }
  if (!el) {
    el = Object.assign(document.createElement("button"), { type: "button", className: "dk-vchip dk-vboard" });
    hd.querySelector(".dk-vchip:not(.dk-vboard)")?.after(el);
  }
  el.dataset.viewOpen = `board:${b}`;
  el.textContent = `Open as board`;
  el.dataset.tip = `Board · ${b}`;
  el.dataset.tipSub = "its frames, with the panel";
}

/** The folder page's place, from its address: `/b/<root>/<path>`. */
function folderPath() {
  try { return decodeURIComponent(location.pathname.replace(/^\/b\/[^/]+\/?/, "")); } catch { return ""; }
}

/** A click in the chip or the dock's controls. True when it was one of theirs. */
function viewClick(e) {
  if (pageClick(e)) return true;
  const vo = e.target.closest("[data-view-open]");
  if (vo) { e.preventDefault(); openView(vo.dataset.viewOpen); return true; }
  if (e.target.closest(".dk-vchip")) { e.preventDefault(); openView("panels"); return true; }
  return dockClick(e);
}

/** ⌃⌥F: Folder open, or the panels again from it. From the desk's keys. */
function viewKey(e) {
  const d = current();
  if (!d || e.metaKey || e.shiftKey || !(e.ctrlKey && e.altKey) || e.code !== "KeyF") return false;
  e.preventDefault(); e.stopPropagation();
  openView(viewNow(d) === "folder" ? "panels" : "folder");
  return true;
}

/* Esc on a board or the page: back to the panels. Heard as it bubbles, after
 * the board has had it (Esc there drops the frames picked first) and only
 * with nothing over the page -- a menu, a sheet, a dialog. A panel's Esc is
 * its shell's and a field's is its own. Over the folder the page's own Esc
 * already goes back, as its ✕ did (app.js). */
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!ctx || !viewOn || viewOn.desk !== deskId || reading != null) return;
  if (e.target.closest?.(".pn, .dk-dock, input, textarea, select, [contenteditable]")) return;
  const r = document.documentElement;
  if (r.dataset.sheet || r.dataset.pop || document.querySelector("#ctx:not([hidden]), dialog[open]")) return;
  e.preventDefault();
  openView("panels");
});

/** For the ⋯ menu (menu.js): the desk's views, the one on screen marked. */
export function viewsHere() {
  const d = current();
  if (!d) return null;
  const on = viewNow(d);
  return viewList(d).map(([v, label, about]) => ({ v, label, about, on: v === on }));
}
export const viewHere = v => openView(v);

/** `seed`: a card's words, for the page's moment form (27-page.js). */
function openView(v, seed, by = "", path = "", pane = null) {
  const d = current();
  if (!d) return;
  viewBy = by;
  // From the folder, the panels are the desk itself: the page is the folder's.
  if (v === "panels") { if (fdock && fdock.desk === d.id) { ctx.go(d.id, true); return; } closeView(); return; }
  // The folder reader of #214, over the desk as its head's path opens it,
  // with a panel docked beside it (folderOn below).
  // `path`: a file in the desk's folder to open on, an agent's (`open_view`).
  if (v === "folder") {
    if (fdock && fdock.desk === d.id && !path && !pane) return;
    closeView();
    // The panel that asked, when an agent opened it: the one to talk to beside it.
    const asked = views.has(pane) && gridPanes(d).some(p => p.id === pane) ? pane : null;
    pane = asked || (fdock && fdock.desk === d.id && fdock.pane) || focused || (gridPanes(d)[0] || {}).id || null;
    ctx.api(`/api/desks/${d.id}/folder`, {})
      .then(j => { folderOn(d.id, pane); viewBy = by; return ctx.browse(j.root.id, path, { over: d.id, root: j.root }); })
      .catch(e => ctx.toast("Could not open its folder", e));
    return;
  }
  // Any other view from the folder: the desk first, then the view over it.
  if (fdock && fdock.desk === d.id) { Promise.resolve(ctx.go(d.id, true)).then(() => openView(v, seed, by, "", pane)); return; }
  // The desk's page (1.59, 27-page.js): opened the way a board is.
  if (v === "page") {
    if (viewOn && viewOn.desk === d.id && viewOn.page) { if (seed) pageMod?.take(seed); return; }
    if (viewOn) { boardMod?.close(); pageMod?.close(); }
    viewOn = { desk: d.id, board: "", page: true, seed: seed || null };
    docked = views.has(pane) ? pane : docked && d.panes.some(p => p.id === docked) ? docked : (focused || (gridPanes(d)[0] || {}).id || null);
    tellFocus({ view: "page", path: "", items: [] });
    layout();
    return;
  }
  const board = v.slice(6);
  if (viewOn && viewOn.desk === d.id && viewOn.board === board) return;
  if (viewOn) { boardMod?.close(); pageMod?.close(); }
  viewOn = { desk: d.id, board };
  docked = views.has(pane) ? pane : docked && d.panes.some(p => p.id === docked) ? docked : (focused || (gridPanes(d)[0] || {}).id || null);
  tellFocus({ view: `board:${board}`, path: `design/${board}`, items: [] });
  layout();
}

/** Back to the panels: the board closed, the docked pane back in its slot. */
function closeView() {
  if (!viewOn) return;
  boardMod?.close();
  pageMod?.close();
  viewOn = null; viewBy = "";
  const v = views.get(docked);
  docked = null;
  ctx.docEl.querySelector(".dk-view")?.remove();
  tellFocus({ view: "panels" });
  if (current()) layout();
  if (v && v.el.isConnected) setTimeout(() => v.body.focus(), 0);
}

/** Another panel in the dock: the one there goes back to the grid. */
function dockTo(id) {
  if (!viewOn || id === docked || !views.has(id)) return;
  docked = id;
  layout();
}

/** The board's surface and the dock, inside the grid, over its panes: made
 *  when a board is open and missing (a draw replaced the page), the docked
 *  pane's element moved in, the board opened on the surface when it is not
 *  open on this one. Called by `layout` after the grid has its panes. */
function viewsMount(d) {
  const grid = ctx.docEl.querySelector(".dk-grid");
  if (!grid) return;
  // The page's card, in the grid's corner, on every layout (27-page.js).
  pageOffers(d);
  pageCard();
  if (!viewOn || viewOn.desk !== d.id) { grid.querySelector(".dk-view")?.remove(); return; }
  let el = grid.querySelector(":scope > .dk-view");
  if (!el) {
    el = document.createElement("div");
    el.className = "dk-view";
    el.innerHTML = `<div class="dk-vsurf"></div><div class="dk-dock">${DOCK_HTML}</div>`;
    el.addEventListener("change", e => { const p = e.target.closest(".dk-dock-pick"); if (p) dockTo(p.value); });
    el.querySelector(".dk-grip").addEventListener("pointerdown", dockDrag);
    grid.append(el);
  }
  const st = dockState(d.id, dockKind(), grid.clientWidth, false), was = el.className;
  for (const [k, n] of [["--dock-w", st.w], ["--dock-h", st.h]]) if (n) el.style.setProperty(k, `${n}px`); else el.style.removeProperty(k);
  dockFill(el.querySelector(".dk-dock"), el, d, docked, st, viewOn.page ? "With the page" : "With the board",
    `No panel to dock. <button type="button" data-a="new">New panel</button>`);
  if (was !== el.className) refit();
  const surf = el.querySelector(".dk-vsurf");
  if (viewOn.page) { pageMount(surf, d); return; }
  if (surf.dataset.board === viewOn.board && surf.childElementCount) return;
  surf.dataset.board = viewOn.board;
  const want = viewOn;
  boardUse().then(m => {
    if (viewOn !== want || !surf.isConnected) return;
    m.open({ host: surf, desk: d.id, board: want.board, api: ctx.api, esc: ctx.esc, focus: tellFocus, named: () => { const c = current(); if (c) viewsSlot(c); }, dir: "design" });
  }, () => { surf.innerHTML = `<p class="dk-none">Could not load the board.</p>`; });
}

function boardUse() {
  if (boardMod) return Promise.resolve(boardMod);
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  return boardLoading ||= import(`/assets/board.js${v ? `?v=${v}` : ""}`).then(m => (boardMod = m), e => { boardLoading = null; throw e; });
}

/** A `board` or `focus` event (app.js): a board on this desk moved, or a new
 *  one appeared, which the desks list does not know of yet. */
export function viewSaid(n, j) {
  if (!ctx || !j || j.desk !== deskId) return;
  if (n === "page") { pageSaid(j); return; }
  if (n === "view") { viewAsked(j); return; }
  const d = current();
  if (n === "board" && d && j.board && !boardsOf(d).includes(j.board)) { ctx.refresh(); return; }
  if (n === "board" && boardMod && viewOn && viewOn.board === j.board) boardMod.changed(j);
}

/* A thread moved on this desk (it rides the `desknotes` event): a board open
 * here reads again, so a live frame (1.61, C7) gets the new numbers. The read
 * carries its hash, so a board whose numbers did not move redraws nothing. */
function boardLive(id) {
  if (boardMod && viewOn && viewOn.board && viewOn.desk === id) boardMod.changed({ desk: id, board: viewOn.board });
}

/* An agent's `open_view` (1.60), said by the daemon only for a desk a page
 * shows: opened here, but never under the reader's hands -- a key pressed in
 * the last 2 s holds it until they stop, for 10 s at most. The chip says who
 * opened it. */
let keyAt = 0, viewWait = 0;
document.addEventListener("keydown", () => { keyAt = Date.now(); }, true);
function viewAsked(j) {
  clearTimeout(viewWait);
  const t0 = Date.now();
  const go = () => {
    const idle = Date.now() - keyAt;
    if (idle < 2000 && Date.now() - t0 < 10000) { viewWait = setTimeout(go, 2000 - idle); return; }
    if (ctx && j.desk === deskId) openView(j.view, null, j.by || "Claude", j.path || "", j.pane || null);
  };
  go();
}

/** A desk swapped for another, or left: no view carried over. */
function viewsReset() {
  if (viewOn) { boardMod?.close(); pageMod?.close(); unfocus(viewOn.desk); }
  viewOn = null; docked = null; viewBy = "";
  folderOff();
}

/** A view left with the desk, not by Panels: its focus said gone all the
 *  same, or the panel would be told of a place the reader has left. */
const unfocus = desk => ctx.api(`/api/desks/${desk}/focus`, { view: "panels" }).catch(() => {});

/*
 * The Folder view's dock. The folder's pages are ui/browse.js's, read over
 * the desk the way any page is (`aside`), and each one is drawn into the doc
 * whole -- a file, the folder it is in, Find's hits. So the dock is not drawn
 * with them: a watcher on the doc puts it back after every draw that left a
 * folder page without it, with the pane's own element moved in, as the
 * board's dock moves it. A document read over the desk from there is no
 * folder page and gets no dock; the pane waits, paced, until it is back.
 *
 * It lasts while the reader stays over this desk from the Folder button:
 * back to the panels (`open`), another desk or leaving (`close`) ends it.
 * Only the switcher's Folder docks: the desk row's folder button (#214)
 * reads the folder as it always did.
 *
 * The focus is the page's place: the file (or folder) open, relative to the
 * desk's folder, and the lines marked in it (`#L4-L9`), sent when either
 * changes. A line is marked by a click and written with replaceState, which
 * fires nothing, so a click in the doc looks again a moment after.
 */
let fdock = null;

function folderOn(desk, pane) {
  folderOff();
  const obs = new MutationObserver(folderDraw);
  obs.observe(ctx.docEl, { childList: true });
  const look = () => setTimeout(folderFocus, 0);
  ctx.docEl.addEventListener("click", look);
  addEventListener("popstate", look);
  // A window made narrower or wider: below or beside again, as the room says.
  const ro = new ResizeObserver(() => { const el = ctx.docEl.querySelector(":scope > .dk-fdock"); if (el) folderFill(el); });
  ro.observe(ctx.docEl);
  fdock = { desk, pane, obs, look, ro, said: null };
}

function folderOff() {
  if (!fdock) return;
  const f = fdock;
  fdock = null;
  f.obs.disconnect();
  f.ro.disconnect();
  ctx.docEl.removeEventListener("click", f.look);
  removeEventListener("popstate", f.look);
  ctx.docEl.querySelector(":scope > .dk-fdock")?.remove();
  ctx.docEl.style.removeProperty("--fdock-w");
  ctx.docEl.style.removeProperty("--fdock-h");
  if (f.said != null) unfocus(f.desk);
}

/** After a draw of the doc: the dock in, when the page is a folder page over
 *  this desk and it is not there yet. */
function folderDraw() {
  const f = fdock, doc = ctx && ctx.docEl;
  if (!f || !doc) return;
  if (deskId !== f.desk) { folderOff(); return; }
  if (!doc.querySelector(":scope > .fp-split")) return;
  folderHead();
  let el = doc.querySelector(":scope > .dk-fdock");
  if (!el) {
    el = Object.assign(document.createElement("aside"), { className: "dk-dock dk-fdock" });
    el.setAttribute("aria-label", "The panel with the folder");
    el.innerHTML = DOCK_HTML;
    // `aside` took the desk's own click off the doc: the dock's controls are its.
    el.addEventListener("click", dockClick);
    el.addEventListener("change", e => { const s = e.target.closest(".dk-dock-pick"); if (s) { f.pane = s.value; folderFill(el); } });
    el.querySelector(".dk-grip").addEventListener("pointerdown", dockDrag);
    doc.append(el);
  }
  folderFill(el);
  folderFocus();
}

/* The desk's head over its folder (1.60, C9; views audit V1). The folder's
 * pages are ui/browse.js's, drawn into the whole doc at `/b/…`, which is what
 * keeps a file's place, its lines and Back working. So the folder is not
 * redrawn inside the desk: the desk's frame is drawn round it. The head is
 * put back at the top of every folder page, sticky, where the desk has it --
 * the same row, the same parts (‹ ›, the tabs, the left-off box and its
 * chip, the keys, + panel, ⋯), drawn by the functions that draw them on the
 * desk -- and the page's own bar (its title, Print, Copy, the waiting pill)
 * steps aside for it, as it does on the desk. Its clicks are its own: the
 * desk's listener is off the doc while a page is read over it. A tab goes
 * back to the panels on that tab; + panel goes back and makes one. */
function folderHead() {
  const doc = ctx.docEl, d = current();
  if (!d || !fdock || !doc.querySelector(":scope > .fp-split")) return;
  let hd = doc.querySelector(":scope > .dk-head");
  if (!hd) {
    hd = Object.assign(document.createElement("header"), { className: "dk-head dk-fhead" });
    hd.innerHTML = `${document.querySelector("#chrome .nv")?.outerHTML || ""}<b class="dk-name"></b><span class="dk-groups"></span>` +
      `<button type="button" class="icon dk-plus" data-a="new" data-tip="New panel" data-tip-sub="back to the panels, with one more" aria-label="New panel">+ panel</button>` +
      `<button type="button" class="icon dk-menu" data-desk-menu="${d.id}" data-tip="What this desk can do" aria-label="Desk actions" aria-haspopup="menu">⋯</button>`;
    hd.addEventListener("click", folderHeadClick);
    doc.prepend(hd);
  }
  hd.querySelector(".dk-name").textContent = d.name;
  groupsHead(d);
  leftOffSlot(d);
  keysSlot(d);
  viewsSlot(d);
}

function folderHeadClick(e) {
  const d = current();
  if (!d) return;
  if (viewClick(e)) return;
  const tg = e.target.closest(".dk-group[data-grp]");
  if (tg) { shownBy.set(d.id, +tg.dataset.grp); ctx.go(d.id, true); return; }
  const m = e.target.closest("[data-desk-menu]");
  if (m) { const r = m.getBoundingClientRect(); ctx.menu?.(m, r.left, r.bottom + 4, e.detail === 0); return; }
  const b = e.target.closest("[data-a]");
  if (b && b.dataset.a === "new") { const why = noNew(d); if (why) { ctx.toast("New panel", why); return; } Promise.resolve(ctx.go(d.id, true)).then(() => act({ dataset: { a: "new" } })); return; }
  if (b && /^(left-|keys)/.test(b.dataset.a)) act(b, !e.detail);
}

/** The Folder view's dock, filled as the board's is (`dockFill`). Beside a
 *  code file, and only beside, it folds by itself until the reader says:
 *  a line of code is 80 columns, and the dock's width is what it is short of. */
function folderFill(el) {
  const f = fdock, d = current();
  if (!f || !d) return;
  if (!views.has(f.pane)) f.pane = (gridPanes(d)[0] || {}).id || null;
  const doc = ctx.docEl, st = dockState(d.id, "folder", doc.clientWidth, !!doc.querySelector(".fp-r article.kind-code"));
  for (const [k, n] of [["--fdock-w", st.w], ["--fdock-h", st.h]]) if (n) doc.style.setProperty(k, `${n}px`); else doc.style.removeProperty(k);
  dockFill(el, el, d, f.pane, st, "With the folder", "No panel on this desk to dock.");
}

/* ---------- the dock (1.60, views audit a5057fcd18) ---------- */
/*
 * One panel docked with a view, the same in Board, Page and Folder: below it
 * by default -- frames and files get the width, and a wide, short terminal
 * still holds the prompt and the last reply -- or beside it on the reader's
 * word. Its edge drags. Its fold leaves the panel's own head, state and all
 * (below), or a strip with its name (beside), and a click on either brings
 * it back. Each desk keeps its own, per view, in this window. Beside needs
 * room: under 900 px of view the dock is below whatever was asked.
 */
const DOCK_KEY = "snyvi.dock", DOCK_ROOM = 900;
const DOCK_HTML = `<span class="dk-grip" role="separator" data-tip="Drag to resize"></span><div class="dk-dctl"></div><div class="dk-dock-b"></div><button type="button" class="dk-dstrip"></button>`;
let dockAll = null;
function dockPrefs() {
  if (dockAll) return dockAll;
  try { dockAll = JSON.parse(localStorage.getItem(DOCK_KEY) || "{}") || {}; } catch { dockAll = {}; }
  return dockAll;
}
/** What the reader set for this desk's `kind` of view ("board", "page",
 *  "folder"): `o` below or side, `w` and `h` in px (0: the default), `fold`
 *  true, false, or null when they never said. */
function dockOf(desk, kind) {
  const p = dockPrefs()[`${desk}:${kind}`] || {};
  return { o: p.o === "side" ? "side" : "below", w: +p.w || 0, h: +p.h || 0, fold: typeof p.fold === "boolean" ? p.fold : null };
}
function dockSave(desk, kind, ch) {
  const all = dockPrefs();
  all[`${desk}:${kind}`] = { ...dockOf(desk, kind), ...ch };
  try { localStorage.setItem(DOCK_KEY, JSON.stringify(all)); } catch { /* kept for this page */ }
}
const dockKind = () => (fdock ? "folder" : viewOn && viewOn.page ? "page" : "board");

/** The dock as it is drawn now, in a view `room` px wide. */
function dockState(desk, kind, room, codeFile) {
  const p = dockOf(desk, kind), narrow = room > 0 && room < DOCK_ROOM, o = narrow ? "below" : p.o;
  return { ...p, o, narrow, fold: p.fold ?? (kind === "folder" && o === "side" && codeFile) };
}

/** The dock's controls, over the right end of the docked panel's head, where
 *  its ⛶ and ✕ were (full view and close are the grid's): another panel when
 *  there are two or more, beside or below, fold. */
function dockCtl(d, on, st, label) {
  const { esc, glyph } = ctx, ps = gridPanes(d).filter(p => views.has(p.id)), side = st.o === "side";
  const pick = ps.length < 2 ? "" : `<label class="dk-dpick" data-tip="${esc(label)}" data-tip-sub="another panel here">${glyph("swap")}<select class="dk-dock-pick" aria-label="${esc(label)}: which panel">` +
    ps.map(p => `<option value="${esc(p.id)}"${p.id === on ? " selected" : ""}>${p.slot} · ${esc(paneName(views.get(p.id)))}</option>`).join("") + `</select></label>`;
  const where = `<button type="button" class="dk-dbtn" data-dock-o${st.narrow ? " disabled" : ""} aria-label="${side ? "Put the panel below" : "Put the panel beside"}" ` +
    `data-tip="${side ? "Panel below" : "Panel beside"}" data-tip-sub="${st.narrow ? "the window is too narrow for beside" : side ? "the view gets the width" : "the view gets the height"}">${glyph(side ? "dockbelow" : "dockside")}</button>`;
  const fold = st.fold
    ? `<button type="button" class="dk-dbtn" data-dock-fold aria-label="Bring the panel back" data-tip="Bring the panel back">${glyph(side ? "prev" : "up")}</button>`
    : `<button type="button" class="dk-dbtn" data-dock-fold aria-label="Fold the panel away" data-tip="Fold the panel away" data-tip-sub="${side ? "a strip with its name stays" : "its head stays"} · a click brings it back">${glyph(side ? "next" : "down")}</button>`;
  return pick + where + fold;
}

/** Fill the dock `el` with panel `id` of desk `d`, as `st` says; `box` is
 *  the element whose layout follows it (the board's view, or the dock). */
function dockFill(el, box, d, id, st, label, none) {
  const v = views.get(id);
  for (const b of new Set([el, box])) {
    b.classList.toggle("side", st.o === "side");
    b.classList.toggle("below", st.o !== "side");
    b.classList.toggle("folded", !!st.fold && !!v);
  }
  el.querySelector(".dk-grip").setAttribute("aria-orientation", st.o === "side" ? "vertical" : "horizontal");
  const c = el.querySelector(".dk-dctl"), ch = dockCtl(d, id, st, label);
  if (c.$html !== ch) { c.innerHTML = ch; c.$html = ch; }
  const strip = el.querySelector(".dk-dstrip"), says = v ? `<b>${v.pane.slot}</b><span>${ctx.esc(paneName(v))}</span>` : "";
  if (strip.$html !== says) { strip.innerHTML = says; strip.$html = says; }
  if (v) { strip.setAttribute("aria-label", `Bring panel ${v.pane.slot} back`); strip.dataset.tip = "Bring the panel back"; }
  const body = el.querySelector(".dk-dock-b");
  if (v && v.el.parentElement !== body) { body.replaceChildren(v.el); v.el.style.gridColumn = ""; v.behind = true; }
  if (!v) body.innerHTML = `<p class="dk-none">${none}</p>`;
  pace();
  if (v) catchUp(v);
}

/** The dock's controls, its strip, and a folded panel's head. True when the
 *  click was one of theirs. */
function dockClick(e) {
  const dock = e.target.closest(".dk-dock"), d = current();
  if (!dock || !d) return false;
  const kind = dockKind(), folded = dock.classList.contains("folded");
  let ch = null;
  if (e.target.closest("[data-dock-o]")) ch = { o: dock.classList.contains("side") ? "below" : "side" };
  else if (e.target.closest("[data-dock-fold]")) ch = { fold: !folded };
  else if (e.target.closest(".dk-dstrip") || (folded && e.target.closest(".pn-head") && !e.target.closest("button, a, select, input"))) ch = { fold: false };
  if (!ch) return false;
  e.preventDefault();
  dockSave(d.id, kind, ch);
  dockRedraw();
  if (ch.fold === false) { const v = views.get(fdock ? fdock.pane : docked); if (v) setTimeout(() => v.body.focus(), 0); }
  return true;
}

function dockRedraw() {
  if (fdock) { const el = ctx.docEl.querySelector(":scope > .dk-fdock"); if (el) folderFill(el); return; }
  if (current()) layout();
  refit();
}

/** The board fitted again once the dock has moved: what fitted a tall canvas
 *  is lost in a wide one. After the layout has settled. */
function refit() {
  if (boardMod && viewOn && !viewOn.page) requestAnimationFrame(() => boardMod.refit());
}

/** The dock's edge dragged: its width beside, its height below, kept per desk and view. */
function dockDrag(e) {
  const grip = e.currentTarget, dock = grip.parentElement, d = current();
  if (!d) return;
  const kind = dockKind(), folder = kind === "folder", box = folder ? ctx.docEl : dock.parentElement;
  const side = dock.classList.contains("side"), r = box.getBoundingClientRect();
  const right = folder ? r.right - 16 : r.right, bottom = folder ? innerHeight - 16 : r.bottom, tall = folder ? innerHeight : r.height;
  const prop = folder ? (side ? "--fdock-w" : "--fdock-h") : (side ? "--dock-w" : "--dock-h");
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add("on");
  let n = 0;
  const move = ev => {
    n = side ? Math.round(Math.max(260, Math.min(right - ev.clientX, r.width * 0.7)))
      : Math.round(Math.max(120, Math.min(bottom - ev.clientY, tall * 0.75)));
    box.style.setProperty(prop, `${n}px`);
  };
  const up = () => {
    grip.classList.remove("on");
    grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up);
    if (n) { dockSave(d.id, kind, side ? { w: n } : { h: n }); refit(); }
  };
  grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
}

/** A panel's name as its head says it, without the `[n]`. */
const paneName = v => short(v).replace(/^\[\d+\]\s*/, "");

/** The page's place, from its address: `/b/<root>/<path>` and `#L…`. */
function folderFocus() {
  const f = fdock;
  if (!f || deskId !== f.desk || !ctx.docEl.querySelector(":scope > .fp-split")) return;
  const path = folderPath();
  const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(location.hash);
  const items = m ? [m[2] && m[2] !== m[1] ? `${Math.min(m[1], m[2])}-${Math.max(m[1], m[2])}` : m[1]] : [];
  const said = path + "#" + items.join();
  if (said === f.said) return;
  f.said = said;
  tellFocus({ view: "folder", path, items });
}

const VIEWS_CSS = `
/* The chip: the one way back the head keeps, in the left-off line's room. */
.dk-vchip { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 20px; margin: 1px 0; padding: 0 6px 0 10px; border: 0; border-radius: var(--r-pill);
  background: var(--wash); box-shadow: inset 0 0 0 1px var(--rule); font: inherit; font-size: var(--fs-small); color: var(--fg); white-space: nowrap; cursor: pointer; }
.dk-vchip i { font-style: normal; font-size: var(--fs-micro); color: var(--fg-3); }
.dk-vchip:hover { background: var(--rule); }
.dk-vchip:hover i { color: var(--fg); }
/* An open board beside the chip, over a board's own folder (V8). */
.dk-vboard { padding-right: 10px; color: var(--fg-2); }
/* The dock (1.60, views audit a5057fcd18): one panel with a view, below it
   by default, beside it on the reader's word, its edge dragged, folded to
   the panel's head (below) or a strip with its name (beside). */
.dk-view { position: absolute; inset: 0; z-index: var(--z-sticky); display: grid; gap: 8px; background: var(--bg); }
.dk-view.side { grid-template-columns: minmax(0, 1fr) var(--dock-w, minmax(320px, 38%)); }
.dk-view.below { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) var(--dock-h, minmax(220px, 36%)); }
.dk-view.side.folded { grid-template-columns: minmax(0, 1fr) 28px; }
.dk-view.below.folded { grid-template-rows: minmax(0, 1fr) 30px; }
.dk-vsurf { position: relative; min-width: 0; min-height: 0; border-radius: var(--r-md); overflow: hidden; }
/* The board's own host rule fills its positioned parent, which here is the
   whole view, dock and all: in the view it is its cell, and no more. */
.dk-vsurf.bd { position: relative; inset: auto; }
.dk-dock { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dk-dock-b { flex: 1; min-height: 0; display: grid; }
.dk-dock-b > * { min-height: 0; }
.dk-dctl { position: absolute; top: 3px; right: 6px; z-index: 2; display: flex; gap: 2px; align-items: center; }
.dk-dbtn, .dk-dpick { position: relative; display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0;
  border-radius: var(--r-sm); background: none; color: var(--fg-3); font: inherit; cursor: pointer; }
.dk-dbtn:hover, .dk-dpick:hover, .dk-dpick:focus-within { background: var(--rule); color: var(--fg); }
.dk-dbtn:disabled { opacity: .35; cursor: default; background: none; }
.dk-dpick select { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; font: inherit; }
/* The panel says its own name once, in its own head: the dock's controls
   take the end of it, where ⛶ and ✕ stood -- full view and close are the
   grid's. A docked panel is narrow, so its branch goes and its page chip
   gives way first. */
.dk-dock-b .pn-head > :is(.pn-full, .pn-x, .pn-git) { display: none; }
.dk-dock-b .pn-head { padding-right: 60px; }
.dk-dock:has(.dk-dpick) .dk-dock-b .pn-head { padding-right: 84px; }
.dk-dock-b .pn-head > .pn-page { flex: 0 1 auto; min-width: 4ch; }
.dk-dock-b .pn-head > .pn-cmd { flex: 0 1 auto; min-width: 8ch; }
.dk-grip { position: absolute; z-index: 2; touch-action: none; }
.dk-dock.side > .dk-grip { left: -8px; top: 0; bottom: 0; width: 8px; cursor: col-resize; }
.dk-dock.below > .dk-grip { top: -8px; left: 0; right: 0; height: 8px; cursor: row-resize; }
.dk-dock.side > .dk-grip:hover, .dk-dock.side > .dk-grip.on { background: linear-gradient(var(--rule-2), var(--rule-2)) center / 2px 100% no-repeat; }
.dk-dock.below > .dk-grip:hover, .dk-dock.below > .dk-grip.on { background: linear-gradient(var(--rule-2), var(--rule-2)) center / 100% 2px no-repeat; }
.dk-dstrip { display: none; }
/* Folded below: the panel's head alone, its name and state in sight, and a
   click on it brings the panel back. */
.dk-dock.below.folded > .dk-grip { display: none; }
.dk-dock.below.folded .pn > :not(.pn-head) { display: none; }
.dk-dock.below.folded .pn-head { cursor: pointer; }
.dk-dock.below.folded .pn-head:hover { background: var(--wash); }
/* Folded beside: a strip with the panel's number and name, read upwards. */
.dk-dock.side.folded > :not(.dk-dstrip) { display: none; }
.dk-dock.side.folded > .dk-dstrip { display: flex; flex-direction: column; align-items: center; gap: 8px; height: 100%; padding: 8px 0; border: 0; border-radius: var(--r-md);
  background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule); font: inherit; font-size: var(--fs-small); color: var(--fg-2); cursor: pointer; }
.dk-dock.side.folded > .dk-dstrip:hover { color: var(--fg); background: var(--wash); }
.dk-dstrip span { writing-mode: vertical-rl; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 0; }
/* The folder with its desk (1.60, C9; views audit V1): the desk's head where
   the desk has it, sticky over the page; the page's own bar steps aside, as
   it does on the desk; the tree, the file, and the dock below them (or
   beside, dragged by its edge either way). */
:root:has(#doc > .dk-fhead) #chrome { position: absolute; top: 0; left: 0; right: 0; height: auto; background: none; box-shadow: none; pointer-events: none; }
:root:has(#doc > .dk-fhead) #chrome > :is(.nv, .over, .qb) { display: none; }
:root:has(#doc > .dk-fhead) #chrome .icon { pointer-events: auto; }
/* The waiting pill is the reading pages': the desk's left-off box and its
   On you say what waits, as they do on the desk. */
:root:has(#doc > .dk-fhead) #queue-bar { display: none; }
:root #doc:has(> .dk-fhead) { max-width: none; margin: 0; padding: 0 16px 16px; }
#doc > .dk-fhead { grid-column: 1 / -1; position: sticky; top: 0; z-index: var(--z-sticky); box-sizing: border-box; height: var(--head-h); padding: 14px 0 10px; margin: 0; background: var(--bg); }
.dk-fhead .dk-group-new, .dk-fhead .dk-group-x { display: none; }
#doc:has(> .dk-fhead) .fp-crumb { display: none; }
/* The desk's name is in the head: the tree says only where the folder is. */
#doc:has(> .dk-fhead) .fp-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
#doc:has(> .dk-fhead) .fp-name { display: none; }
#doc:has(> .dk-fhead) .fp-path { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
#doc:has(> .dk-fhead) .fp-split { grid-template-columns: 220px minmax(0, 1fr); gap: 0 20px; }
#doc:has(> .dk-fhead) .fp-l { top: var(--head-h); }
#doc:has(> .dk-fhead) .fp-r .doc-head { margin: 0 0 12px; }
#doc:has(> .dk-fhead) .fp-r .doc-head .doc-title { display: none; }
#doc:has(> .dk-fhead) .fp-r .doc-head .doc-sub { margin: 0; font-size: var(--fs-small); }
/* Beside: a column of its own, sticky under the head. */
#doc:has(> .fp-split):has(> .dk-fdock.side) { display: grid; grid-template-columns: minmax(0, 1fr) var(--fdock-w, 320px); gap: 0 16px; align-items: start; }
#doc:has(> .fp-split):has(> .dk-fdock.side.folded) { grid-template-columns: minmax(0, 1fr) 28px; }
.dk-fdock.side { position: sticky; top: calc(var(--head-h) + 8px); height: calc(100vh - var(--head-h) - 24px); }
/* Below: sticky at the foot of the window, the page scrolling above it; the
   page is at least as tall as the room it leaves, so the dock is at the foot
   on a short README too. */
.dk-fdock.below { position: sticky; bottom: 16px; z-index: var(--z-sticky); height: var(--fdock-h, 36vh); margin-top: 12px; background: var(--bg); box-shadow: 0 -12px 0 var(--bg), 0 16px 0 var(--bg); }
.dk-fdock.below.folded { height: 30px; }
/* 28 = the dock's 12 px above it and the doc's 16 below: its foot lands
   16 px over the window's, where a board's does. */
#doc:has(> .dk-fdock.below) > .fp-split { min-height: calc(100vh - var(--head-h) - var(--fdock-h, 36vh) - 28px); }
#doc:has(> .dk-fdock.below.folded) > .fp-split { min-height: calc(100vh - var(--head-h) - 58px); }
#doc:has(> .dk-fdock.below) .fp-l { max-height: calc(100vh - var(--head-h) - var(--fdock-h, 36vh) - 28px); }
#doc:has(> .dk-fdock.below.folded) .fp-l { max-height: calc(100vh - var(--head-h) - 58px); }
/* A preview (a picture, a PDF, a page) fills the room it has, the dock's
   too: the doc is a fixed box, the dock in it. */
#doc:has(> .dk-fdock.side):has(article.preview) { display: flex; flex-direction: row; flex-wrap: wrap; align-items: stretch; }
#doc:has(> .dk-fdock.side):has(article.preview) > .dk-fhead { flex: 1 0 100%; }
#doc:has(> .dk-fdock.side):has(article.preview) > .fp-split { flex: 1 1 0; min-width: 0; }
#doc:has(> .dk-fdock.side):has(article.preview) > .dk-fdock { position: static; height: auto; flex: none; width: var(--fdock-w, 320px); }
#doc:has(> .dk-fdock.side.folded):has(article.preview) > .dk-fdock { width: 28px; }
#doc:has(> .dk-fdock.below):has(article.preview) { display: flex; flex-direction: column; }
#doc:has(> .dk-fdock.below):has(article.preview) > .fp-split { flex: 1 1 0; min-height: 0; }
#doc:has(> .dk-fdock.below):has(article.preview) > .dk-fdock { position: static; flex: none; box-shadow: none; }
`;
