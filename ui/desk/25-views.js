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

/** The switcher, in its slot before the keys: drawn in place on every
 *  layout, its buttons the same while nothing changed. */
function viewsSlot(d) {
  const hd = ctx.docEl.querySelector(".dk-head"), { esc } = ctx;
  if (!hd) return;
  let el = hd.querySelector(".dk-views");
  if (!el) {
    el = Object.assign(document.createElement("span"), { className: "dk-views" });
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Views of this desk");
    // The left group's last, against the head's free middle: a board's
    // button grows into it, and moves nothing on either side.
    hd.querySelector(".dk-tabs").before(el);
  }
  const on = viewOn && viewOn.desk === d.id ? `board:${viewOn.board}` : "panels";
  const b = (v, label, tip) => `<button type="button" class="dk-vbtn${on === v ? " on" : ""}" data-view="${esc(v)}" aria-pressed="${on === v}" data-tip="${esc(tip)}">${esc(label)}</button>`;
  const html = b("panels", "Panels", "The desk's panels") + b("folder", "Folder", "The desk's folder, read over it") +
    boardsOf(d).map(n => b(`board:${n}`, n, `The board design/${n}/, with a panel beside it`)).join("");
  if (el.dataset.drawn !== html) { el.dataset.drawn = html; el.innerHTML = html; }
}

/** A click in the switcher, the dock's head or the rail's board section.
 *  True when it was one of theirs. */
function viewClick(e) {
  const v = e.target.closest(".dk-views [data-view]");
  if (v) { e.preventDefault(); openView(v.dataset.view); return true; }
  const dk = e.target.closest("[data-dock]");
  if (dk) { e.preventDefault(); dockTo(dk.dataset.dock); return true; }
  return !!(boardMod && viewOn && e.target.closest(".bd-rail") && boardMod.railClick(e));
}

function openView(v) {
  const d = current();
  if (!d) return;
  if (v === "panels") { closeView(); return; }
  // The folder reader of #214, over the desk as its head's path opens it,
  // with a panel docked beside it (folderOn below).
  if (v === "folder") {
    closeView();
    const pane = focused || (gridPanes(d)[0] || {}).id || null;
    ctx.api(`/api/desks/${d.id}/folder`, {})
      .then(j => { folderOn(d.id, pane); ctx.browse(j.root.id, "", { over: d.id, root: j.root }); })
      .catch(e => ctx.toast("Could not open its folder", e));
    return;
  }
  const board = v.slice(6);
  if (viewOn && viewOn.desk === d.id && viewOn.board === board) return;
  if (viewOn) boardMod?.close();
  viewOn = { desk: d.id, board };
  docked = docked && d.panes.some(p => p.id === docked) ? docked : (focused || (gridPanes(d)[0] || {}).id || null);
  tellFocus({ view: `board:${board}`, path: `design/${board}`, items: [] });
  layout();
}

/** Back to the panels: the board closed, the docked pane back in its slot. */
function closeView() {
  if (!viewOn) return;
  boardMod?.close();
  viewOn = null;
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
  if (!viewOn || viewOn.desk !== d.id) { grid.querySelector(".dk-view")?.remove(); return; }
  let el = grid.querySelector(":scope > .dk-view");
  if (!el) {
    el = document.createElement("div");
    el.className = "dk-view";
    el.innerHTML = `<div class="dk-vsurf"></div><div class="dk-dock"><header class="dk-dock-h"></header><div class="dk-dock-b"></div></div>`;
    grid.append(el);
  }
  const { esc } = ctx;
  const others = gridPanes(d).filter(p => p.id !== docked);
  el.querySelector(".dk-dock-h").innerHTML = `<span class="dk-dock-k">Beside the board</span>` +
    others.map(p => `<button type="button" class="dk-vbtn" data-dock="${esc(p.id)}" data-tip="Dock panel ${p.slot} instead">${p.slot}</button>`).join("");
  const v = views.get(docked), body = el.querySelector(".dk-dock-b");
  if (v && v.el.parentElement !== body) { body.replaceChildren(v.el); v.el.style.gridColumn = ""; v.behind = true; catchUp(v); }
  if (!v) body.innerHTML = `<p class="dk-none">No panel to dock. <button type="button" data-a="new">New panel</button></p>`;
  const surf = el.querySelector(".dk-vsurf");
  if (surf.dataset.board === viewOn.board && surf.childElementCount) return;
  surf.dataset.board = viewOn.board;
  const want = viewOn;
  boardUse().then(m => {
    if (viewOn !== want || !surf.isConnected) return;
    m.open({ host: surf, desk: d.id, board: want.board, api: ctx.api, esc: ctx.esc, focus: tellFocus, rail: () => { if (current()) rail(); }, dir: "design" });
  }, () => { surf.innerHTML = `<p class="dk-none">Could not load the board.</p>`; });
}

function boardUse() {
  if (boardMod) return Promise.resolve(boardMod);
  let v = "";
  try { v = JSON.parse(document.getElementById("boot").textContent || "{}").v || ""; } catch { /* unversioned */ }
  return boardLoading ||= import(`/assets/board.js${v ? `?v=${v}` : ""}`).then(m => (boardMod = m), e => { boardLoading = null; throw e; });
}

/** The rail's board section, at the rail's head while a board is open. */
const viewRail = () => (viewOn && boardMod && viewOn.desk === deskId ? boardMod.railHtml() : "");

/** A `board` or `focus` event (app.js): a board on this desk moved, or a new
 *  one appeared, which the desks list does not know of yet. */
export function viewSaid(n, j) {
  if (!ctx || !j || j.desk !== deskId) return;
  const d = current();
  if (n === "board" && d && j.board && !boardsOf(d).includes(j.board)) { ctx.refresh(); return; }
  if (n === "board" && boardMod && viewOn && viewOn.board === j.board) boardMod.changed(j);
}

/** A desk swapped for another, or left: no view carried over. */
function viewsReset() {
  if (viewOn) { boardMod?.close(); unfocus(viewOn.desk); }
  viewOn = null; docked = null;
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
  fdock = { desk, pane, obs, look, said: null };
}

function folderOff() {
  if (!fdock) return;
  const f = fdock;
  fdock = null;
  f.obs.disconnect();
  ctx.docEl.removeEventListener("click", f.look);
  removeEventListener("popstate", f.look);
  ctx.docEl.querySelector(":scope > .dk-fdock")?.remove();
  if (f.said != null) unfocus(f.desk);
}

/** After a draw of the doc: the dock in, when the page is a folder page over
 *  this desk and it is not there yet. */
function folderDraw() {
  const f = fdock, doc = ctx && ctx.docEl;
  if (!f || !doc) return;
  if (deskId !== f.desk) { folderOff(); return; }
  if (!doc.querySelector(":scope > .fp-split")) return;
  let el = doc.querySelector(":scope > .dk-fdock");
  if (!el) {
    el = Object.assign(document.createElement("aside"), { className: "dk-fdock" });
    el.setAttribute("aria-label", "The panel beside the folder");
    el.innerHTML = `<header class="dk-dock-h"></header><div class="dk-dock-b"></div>`;
    // `aside` took the desk's own click off the doc: the dock's buttons are its.
    el.addEventListener("click", e => {
      const b = e.target.closest("[data-dock]");
      if (b) { e.preventDefault(); f.pane = b.dataset.dock; folderFill(el); }
    });
    doc.append(el);
  }
  folderFill(el);
  folderFocus();
}

/** The dock's head and its pane, as `viewsMount` fills the board's. */
function folderFill(el) {
  const f = fdock, d = current();
  if (!f || !d) return;
  if (!views.has(f.pane)) f.pane = (gridPanes(d)[0] || {}).id || null;
  const { esc } = ctx;
  el.querySelector(".dk-dock-h").innerHTML = `<span class="dk-dock-k">Beside the folder</span>` +
    gridPanes(d).filter(p => p.id !== f.pane).map(p => `<button type="button" class="dk-vbtn" data-dock="${esc(p.id)}" data-tip="Dock panel ${p.slot} instead">${p.slot}</button>`).join("");
  const v = views.get(f.pane), body = el.querySelector(".dk-dock-b");
  if (v && v.el.parentElement !== body) { body.replaceChildren(v.el); v.el.style.gridColumn = ""; v.behind = true; }
  if (!v) body.innerHTML = `<p class="dk-none">No panel on this desk to dock.</p>`;
  pace();
  if (v) catchUp(v);
}

/** The page's place, from its address: `/b/<root>/<path>` and `#L…`. */
function folderFocus() {
  const f = fdock;
  if (!f || deskId !== f.desk || !ctx.docEl.querySelector(":scope > .fp-split")) return;
  let path = "";
  try { path = decodeURIComponent(location.pathname.replace(/^\/b\/[^/]+\/?/, "")); } catch { /* a bad escape: no path */ }
  const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(location.hash);
  const items = m ? [m[2] && m[2] !== m[1] ? `${Math.min(m[1], m[2])}-${Math.max(m[1], m[2])}` : m[1]] : [];
  const said = path + "#" + items.join();
  if (said === f.said) return;
  f.said = said;
  tellFocus({ view: "folder", path, items });
}

const VIEWS_CSS = `
.dk-views { display: inline-flex; gap: 2px; flex: none; margin: 0 var(--sp-2); padding: 2px; border-radius: var(--r-pill); background: var(--wash); }
.dk-vbtn { padding: 2px var(--sp-3); border: 0; border-radius: var(--r-pill); background: none; color: var(--fg-2); font: inherit; font-size: var(--fs-small); cursor: pointer; white-space: nowrap; }
.dk-vbtn:hover { color: var(--fg); }
.dk-vbtn.on { background: var(--bg-raise); color: var(--fg); box-shadow: var(--shadow-1); }
.dk-view { position: absolute; inset: 0; z-index: var(--z-sticky); display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 38%); gap: 8px; background: var(--bg); }
.dk-vsurf { position: relative; min-width: 0; border-radius: var(--r-md); overflow: hidden; }
.dk-dock { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.dk-dock-h { display: flex; gap: var(--sp-2); align-items: center; height: 28px; flex: none; font-size: var(--fs-small); color: var(--fg-3); }
.dk-dock-k { margin-right: auto; }
.dk-dock-b { flex: 1; min-height: 0; display: grid; }
.dk-dock-b > * { min-height: 0; }
#doc:has(> .fp-split):has(> .dk-fdock) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 36%); gap: 0 24px; align-items: start; padding-right: 16px; }
.dk-fdock { position: sticky; top: calc(var(--head-h) + 8px); height: calc(100vh - var(--head-h) - 24px); display: flex; flex-direction: column; min-width: 0; }
#doc:has(> .dk-fdock):has(article.preview) { display: flex; flex-direction: row; align-items: stretch; }
#doc:has(> .dk-fdock):has(article.preview) > .fp-split { flex: 1 1 auto; min-width: 0; }
#doc:has(> .dk-fdock):has(article.preview) > .dk-fdock { position: static; height: auto; flex: none; width: max(320px, 36%); }
`;
