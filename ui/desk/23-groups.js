/* ui/desk/23-groups.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- tabs (1.57, #217) ----------

/* A tab is a group of panels inside one desk: its own name, folder, four in
 * the grid and four in the back, dividers, full view and focused panel. The
 * desk keeps one name, one rail, one left-off, one set of keys. The page says
 * tab; the code says group (`groups`, `.dk-groups`, `grp`), because the `[n]`
 * panel tabs already own `tabs()` and `.dk-tabs` in 05-desk.js.
 *
 * The page sees a desk with tabs through `inTab`: the desk as it is in the
 * tab shown, its `panes` that tab's, its `col`, `row`, `full_slot` and `root`
 * the tab's, and every pane of every tab in `all`. Everything that meant
 * "the visible desk" before goes on meaning it, unchanged; a desk with no
 * tabs is passed through as it is, so nothing changes for it.
 *
 * The shown tab is this window's (`shownBy`), not the daemon's: two windows
 * on one desk would otherwise switch each other. The daemon keeps only where
 * the desk reopens (`/show`), read when no tab has been shown here yet.
 *
 * Panels in a tab out of sight keep running, mounted in a hidden box laid out
 * like the grid, one box per tab, so each has a real size from the first
 * layout and starts the way a shown one does, as the back's do (18-back.js).
 * The tab's `!` can light only because they run. */

/** desk id → the tab this window shows on it. */
const shownBy = new Map();
/** The last `inTab` made, kept while the desks list and the tab are the same,
 *  so what a drag writes into `col` is still there on the next `current()`. */
let tabView = { src: null, grp: 0, view: null };

/** The tab shown on `d`: this window's, else where the desk reopens, else its first. */
function shownGrp(d) {
  const gs = d && d.groups;
  if (!gs || !gs.length) return 0;
  let g = shownBy.get(d.id);
  if (!gs.some(x => x.id === g)) {
    g = gs.some(x => x.id === d.grp_shown) ? d.grp_shown : gs[0].id;
    shownBy.set(d.id, g);
  }
  return g;
}

/** The desk as its shown tab sees it; a desk with no tabs as it is. */
function inTab(d) {
  const grp = shownGrp(d);
  if (!grp) return d;
  if (tabView.src === d && tabView.grp === grp) return tabView.view;
  const g = d.groups.find(x => x.id === grp);
  const view = { ...d, panes: d.panes.filter(p => p.grp === grp), all: d.panes, col: g.col, row: g.row, full_slot: g.full_slot, root: g.root, grp, group: g };
  tabView = { src: d, grp, view };
  return view;
}

/** Every pane of the desk, every tab's: what views are kept for. */
const allPanes = d => (d && (d.all || d.panes)) || [];

/** A layout body for the daemon, with the tab it is the layout of; what the
 *  page changed in the tab's view is put on the tab too, so a switch away
 *  and back finds it. */
function layoutBody(d, extra = {}) {
  if (d.group) Object.assign(d.group, { col: d.col, row: d.row, full_slot: d.full_slot });
  return { col: d.col, row: d.row, ...(d.grp ? { grp: d.grp } : {}), ...extra };
}

/** Whether a panel in this tab's views needs the reader: the `[n]!` mark's test. */
const needsYou = v => v && (v.status.blocked || v.status.agent === "needs_you");

/** The tab row in the head: `Tab 1 | insta! ✕ | bot  +`. A desk with no
 *  tabs, or one left, has the + alone, and its first press makes two: one
 *  for the panels already there and the new one. A tab's `!` and its ✕ have their room
 *  whether or not they are drawn, so nothing coming and going moves the row;
 *  the last tab has no ✕, a desk keeps one. */
function groupsHead(d) {
  const el = ctx.docEl.querySelector(".dk-groups");
  if (!el) return;
  const gs = d && d.groups || [], { esc } = ctx, at = gs.findIndex(x => x.id === d.grp);
  // The key that reaches a tab from the one shown: the next ], the one before [.
  const key = i => i === (at + 1) % gs.length ? "ctrl+alt+shift+]" : i === (at + gs.length - 1) % gs.length ? "ctrl+alt+shift+[" : "";
  // A tab just closed keeps its place for BACK_MS, in its own width, with
  // Undo where its ✕ was: the eye stays where the click was, and nothing
  // after it in the row moves until the offer is gone.
  const gone = tabGone && tabGone.desk === d.id ? tabGone : null, many = gs.length + (gone ? 1 : 0) > 1;
  // One tab left reads as none: the + alone, as on a desk that never had two.
  const tabs = (many ? gs : []).map((g, i) => {
    const on = g.id === d.grp, need = !on && allPanes(d).some(p => p.grp === g.id && needsYou(views.get(p.id)));
    return `<span class="dk-gt${on ? " on" : ""}"><button type="button" class="dk-group${on ? " on" : ""}${need ? " blk" : ""}" data-grp="${g.id}" role="tab" aria-selected="${on}" ` +
      `data-tip="${esc(g.name)}${need ? " · needs you" : ""}" data-tip-sub="${on ? "double-click to rename" : "show it"}"${on ? "" : ` data-key="${key(i)}"`}>` +
      `${esc(g.name)}<i class="dk-group-mark" aria-hidden="true">${need ? "!" : ""}</i></button>` +
      (gs.length > 1 ? `<button type="button" class="dk-group-x" data-grp-x="${g.id}" data-tip="Close ${esc(g.name)}" data-tip-sub="its panels are kept, stopped" aria-label="Close tab ${esc(g.name)}">×</button>` : many ? `<i class="dk-group-x" aria-hidden="true"></i>` : "") + `</span>`;
  });
  if (gone) tabs.splice(Math.min(gone.at, tabs.length), 0,
    `<span class="dk-gt gone"><button type="button" class="dk-group" data-grp-back data-tip="Closed · its panels are kept, stopped" data-tip-sub="Undo brings it back" aria-label="Undo closing tab ${esc(gone.name)}">${esc(gone.name)}<i class="dk-group-mark" aria-hidden="true"></i></button>` +
    `<button type="button" class="dk-group-x" data-grp-back data-tip="Undo" aria-label="Undo closing tab ${esc(gone.name)}">↶</button></span>`);
  const html = tabs.join("") + `<button type="button" class="dk-group-new" data-tip="New tab" data-tip-sub="more panels, in this desk's folder" aria-label="New tab">+</button>`;
  if (el.dataset.drawn === html) return;
  el.dataset.drawn = html;
  el.innerHTML = html;
  el.setAttribute("role", gs.length > 1 ? "tablist" : "presentation");
}

/** The panes of the tabs out of sight, each tab in a box of its own laid out
 *  as the grid would lay it out, hidden; the back's of that tab stacked
 *  over it. Called by `layout`, after the grid and the drawer took theirs. */
function groupsMount(d) {
  const host = ctx.docEl.querySelector(".dk");
  if (!host) return;
  const gs = d && d.groups || [];
  const want = new Set(gs.filter(g => g.id !== d.grp).map(g => String(g.id)));
  for (const box of host.querySelectorAll(":scope > .dk-gbox")) if (!want.has(box.dataset.grp)) box.remove();
  for (const g of gs) {
    if (g.id === d.grp) continue;
    let box = host.querySelector(`:scope > .dk-gbox[data-grp="${g.id}"]`);
    if (!box) { box = Object.assign(document.createElement("div"), { className: "dk-gbox" }); box.dataset.grp = g.id; box.setAttribute("aria-hidden", "true"); host.append(box); }
    const ps = d.all.filter(p => p.grp === g.id), grid = ps.filter(p => !isBack(p)).slice(0, room());
    const vs = [...grid, ...ps.filter(p => !grid.includes(p))].map(p => views.get(p.id)).filter(Boolean);
    const cols = grid.length > 1 ? 2 : 1, rows = grid.length > 2 ? 2 : 1;
    box.style.gridTemplateColumns = cols === 2 ? `${g.col}fr ${1 - g.col}fr` : "1fr";
    box.style.gridTemplateRows = rows === 2 ? `${g.row}fr ${1 - g.row}fr` : "1fr";
    vs.forEach((v, i) => {
      const inGrid = i < grid.length;
      v.el.classList.toggle("dk-gback", !inGrid);
      v.el.style.gridColumn = inGrid && grid.length % 2 && i === grid.length - 1 && cols === 2 ? "1 / -1" : "";
    });
    // The grid's own place and size, so each panel is the size it will be
    // when its tab is shown, and starts at it.
    const gr = ctx.docEl.querySelector(".dk-grid");
    if (gr) Object.assign(box.style, { top: gr.offsetTop + "px", left: gr.offsetLeft + "px", width: gr.offsetWidth + "px", height: gr.offsetHeight + "px", gap: getComputedStyle(gr).gap });
    if (vs.length !== box.children.length || vs.some((v, i) => box.children[i] !== v.el)) {
      box.replaceChildren(...vs.map(v => v.el));
      for (const v of vs) v.behind = true;
    }
  }
  // A panel shown again leaves the class the hidden box gave it; and the
  // daemon hears which are out of sight now, at one frame a second.
  for (const p of d.panes) views.get(p.id)?.el.classList.remove("dk-gback");
  pace();
}

/** Show tab `grp` in this window: its panels, dividers, full view and focus
 *  come back as they were left. The daemon is told only where the desk
 *  reopens, silently. */
function showGroup(grp, focus = true) {
  const raw = ctx.desks && ctx.desks.desks.find(x => x.id === deskId);
  if (!raw || !raw.groups || !raw.groups.some(g => g.id === grp)) return;
  const was = current();
  if (was && was.group && focused && was.panes.some(p => p.id === focused)) was.group.focused = focused;
  if (was && was.grp && was.grp !== grp && focused) ctx.api(`/api/desks/${deskId}/layout`, layoutBody(was, { focused })).catch(() => {});
  shownBy.set(deskId, grp);
  drawerOn = null;
  const d = current();
  const fp = d.full_slot && d.panes.find(p => p.slot === d.full_slot);
  full = !!fp;
  focused = fp ? fp.id : d.panes.some(p => p.id === d.group.focused) ? d.group.focused : (gridPanes(d)[0] || d.panes[0] || {}).id || null;
  ctx.api(`/api/desks/${deskId}/groups/${grp}/show`, {}).catch(() => {});
  layout();
  rail();
  const v = views.get(focused);
  if (focus && v) v.body.focus({ preventScroll: true });
}

/** The tab Home asked for, once: a card's chip or the ring on a panel in
 *  a tab writes `desk:grp` before the desk opens (home.js). */
function tabNext(id) {
  let v = null;
  try { v = sessionStorage.getItem("snyvi.tabNext"); sessionStorage.removeItem("snyvi.tabNext"); } catch {}
  const [d, g] = (v || "").split(":").map(Number);
  if (d === id && g) shownBy.set(id, g);
}

/** ⌃⌥⇧[ and ⌃⌥⇧]: the tab before or after, round. By `e.code`: with Shift
 *  a US layout sends `{` and `}`, and other layouts other characters again. */
function groupStep(by) {
  const d = current();
  if (!d || !d.groups || d.groups.length < 2) return false;
  const i = d.groups.findIndex(g => g.id === d.grp), n = d.groups.length;
  showGroup(d.groups[(i + by + n) % n].id);
  return true;
}

/** A click in the tab row: a tab's name shows it, a second click on the shown
 *  one renames it there; its ✕ closes it; the + makes the next. */
function groupClick(e) {
  if (e.target.closest("[data-grp-back]")) { tabGone?.undo(); return true; }
  const x = e.target.closest(".dk-group-x[data-grp-x]");
  if (x) { const g = current()?.groups?.find(t => t.id === +x.dataset.grpX); if (g) closeGroup(g); return true; }
  if (e.target.closest(".dk-group-new")) { newGroup(); return true; }
  const tg = e.target.closest(".dk-group[data-grp]");
  if (!tg) return false;
  if (tg.dataset.dragged) return true;
  const grp = +tg.dataset.grp, d = current();
  if (e.detail === 2 && d && d.grp === grp) { const g = d.groups.find(t => t.id === grp); if (g) renameGroup(g); }
  else showGroup(grp);
  return true;
}

/** A tab's menu from a right click, the menu key or ⇧F10 on it. The window's
 *  own list of what has a menu is first paint's, so a tab, which only a desk
 *  has, asks from here; the window's listener after this one finds nothing
 *  there and only keeps the webview's own menu away. */
function tabMenu(e) {
  const t = e.target.closest?.(".dk-group[data-grp]");
  if (!t || (e.type === "keydown" && !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)))) return;
  e.preventDefault();
  const r = t.getBoundingClientRect(), key = e.type === "keydown";
  ctx.menu?.(t, key ? r.left : e.clientX, key ? r.bottom + 4 : e.clientY, key);
}

/** A panel shown wherever it is: its own tab first, when that is another. */
function toGroupOf(v) {
  const d = current();
  if (d && d.grp && v && v.pane.grp && v.pane.grp !== d.grp) showGroup(v.pane.grp, false);
}

/** The name of the tab a pane is in, when the desk has tabs and it is not
 *  the one shown: a document's tip and a working line's words say it. No
 *  row wears it as a chip: every tab is in the desk's folder, and a chip
 *  read "Tab 1" on everything sent before the first tab. */
function otherTab(d, grp) {
  if (!d || !d.grp || !grp || grp === d.grp) return "";
  return (d.groups.find(g => g.id === grp) || {}).name || "";
}

/** A new tab, in the desk's own folder, named "Tab n" until renamed. Made,
 *  it is shown with one panel started, as a new desk opens. */
async function newGroup() {
  const d = current();
  if (!d) return;
  try {
    const j = await ctx.api(`/api/desks/${d.id}/groups`, {});
    shownBy.set(d.id, j.grp);
    const p = await ctx.api(`/api/desks/${d.id}/panes`, { grp: j.grp });
    focused = p.pane.id;
    await ctx.refresh();
    const nv = views.get(p.pane.id);
    if (nv) { await run(nv, ""); nv.body.focus(); }
  } catch (e) { ctx.toast("Could not make a tab", e); }
}

/** A tab's menu: Rename, Move left and right, the focused panel here, and
 *  Close tab, which the last one does not offer -- it says why instead. */
function groupMenu(grp) {
  const d = current(), gs = d && d.groups;
  const g = gs && gs.find(x => x.id === grp);
  if (!g) return null;
  const i = gs.indexOf(g), v = views.get(focused);
  const last = gs.length < 2;
  return { head: g.name, items: [
    grp !== d.grp && { label: "Show", run: () => showGroup(grp) },
    { label: "Rename…", moves: 1, run: () => renameGroup(g) },
    i > 0 && { label: "Move left", run: () => moveGroup(g, i - 1) },
    i < gs.length - 1 && { label: "Move right", run: () => moveGroup(g, i + 1) },
    v && v.pane.grp !== grp && { label: `Move panel ${v.pane.slot} here`, run: () => regroup(v, grp) },
    // The last one stays, and its entry says so under it rather than act.
    { label: "Close tab", hint: last ? "a desk keeps one tab" : "", run: () => last ? ctx.toast("A desk keeps one tab", "Close the desk instead") : closeGroup(g) },
  ].filter(Boolean) };
}

/** Renamed in place, on its own name in the row, as the desk's name is. */
function renameGroup(g, typed, why) {
  const nm = ctx.docEl.querySelector(`.dk-group[data-grp="${g.id}"]`);
  if (!nm) return;
  const input = Object.assign(document.createElement("input"), { className: "ren-in dk-group-in", value: typed ?? g.name, spellcheck: false, maxLength: 40 });
  input.setAttribute("aria-label", "Name of this tab");
  nm.replaceWith(input);
  input.focus(); input.select();
  if (why) fieldErr(input, why);
  let done = false;
  const finish = async keep => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name && name !== g.name) {
      try { await ctx.api(`/api/desks/${deskId}/groups/${g.id}/rename`, { name }); }
      catch (e) { if (input.isConnected) { done = false; fieldErr(input, `Could not rename · ${ctx.sayErr(e).why}`); input.focus(); return; } }
    }
    if (input.isConnected) input.replaceWith(nm);
    const el = ctx.docEl.querySelector(".dk-groups");
    if (el) delete el.dataset.drawn;
    await ctx.refresh();
    ctx.docEl.querySelector(`.dk-group[data-grp="${g.id}"]`)?.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function moveGroup(g, to) {
  try { await ctx.api(`/api/desks/${deskId}/groups/${g.id}/move`, { to }); await ctx.refresh(); }
  catch (e) { ctx.toast("Could not move the tab", e); }
}

/** A panel to another tab, a drag onto its name or the tab's menu. */
async function regroup(v, grp) {
  try { await ctx.api(`/api/panes/${v.id}/group`, { grp }); await ctx.refresh(); }
  catch (e) { ctx.toast("Could not move the panel", e); }
}

/** A tab just closed -- { desk, at: its place in the row, name, undo } --
 *  while its Undo stands, in that place (`groupsHead`). Only the newest. */
let tabGone = null, tabTimer = 0;

/** A tab closed with its panels, stopped and kept, and an Undo for
 *  `BACK_MS` where the click was: the tab's own place in the row. */
async function closeGroup(g) {
  let j;
  const d = current(), at = d?.groups?.findIndex(t => t.id === g.id) ?? -1;
  try { j = await ctx.api(`/api/desks/${deskId}/groups/${g.id}/close`, {}); }
  catch (e) { ctx.toast("Could not close the tab", e); return; }
  if (shownBy.get(deskId) === g.id) shownBy.delete(deskId);
  clearTimeout(tabTimer);
  const desk = deskId, end = () => { if (tabGone?.desk === desk && tabGone.name === g.name) { tabGone = null; const c = current(); if (c) groupsHead(c); } };
  tabGone = { desk, at: Math.max(at, 0), name: g.name, undo: async () => {
    clearTimeout(tabTimer); tabGone = null;
    try { await ctx.api(j.restore, {}); shownBy.set(desk, g.id); }
    catch (e) { ctx.toast("Could not bring the tab back", e); }
    await ctx.refresh();
  } };
  tabTimer = setTimeout(end, BACK_MS);
  await ctx.refresh();
  views.get(focused)?.body.focus({ preventScroll: true });
}

const GROUPS_CSS = `
/* ---------- tabs (1.57) ----------
 * Named tabs after the desk's name, the navigation kind: a word each, the
 * one shown underlined in the accent. The [n] panel tabs stay where they
 * are, further right, so the two are never one control. A tab's ! has its
 * room whether or not it is drawn, so a mark coming moves nothing. */
.dk-groups { display: flex; align-items: center; gap: 2px; min-width: 0; flex: none; max-width: 40%; overflow: hidden; }
.dk-gt { display: inline-flex; align-items: center; flex: none; border-radius: var(--r-xs) var(--r-xs) 0 0; }
.dk-gt:hover { background: var(--rule); }
.dk-gt.on { box-shadow: inset 0 -2px 0 var(--accent); }
.dk-group-x { flex: none; width: 16px; height: 16px; margin-right: 3px; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); font-size: 13px; line-height: 1; cursor: pointer; visibility: hidden; }
.dk-gt:hover .dk-group-x, .dk-gt.on .dk-group-x, .dk-group-x:focus-visible { visibility: visible; }
.dk-group-x:hover { color: var(--fg); background: var(--rule-2); }
/* A tab just closed: its name struck, dimmed, and ↶ in its ✕'s room, so the
 * row keeps its width while the Undo stands. */
.dk-gt.gone .dk-group { color: var(--fg-3); text-decoration: line-through; opacity: .7; }
.dk-gt.gone .dk-group-x { visibility: visible; color: var(--accent); }
.dk-gt.gone:hover .dk-group { opacity: 1; }
.dk-groups .dk-group { flex: none; padding: 2px 6px 3px 8px; border-radius: var(--r-xs) var(--r-xs) 0 0; font-size: var(--fs-small); color: var(--fg-3); white-space: nowrap; }
.dk-groups .dk-group:hover { color: var(--fg); }
.dk-groups .dk-group.on { color: var(--fg); }
.dk-groups .dk-group.blk { color: var(--warn); font-weight: 600; }
.dk-group-mark { display: inline-block; width: 1ch; font-style: normal; text-align: center; }
.dk-group-new { flex: none; padding: 2px 6px; border-radius: var(--r-xs); color: var(--fg-3); }
.dk-group-new:hover { color: var(--fg); background: var(--rule); }
.dk-group.pn-drop { outline: 2px solid var(--accent); outline-offset: -2px; }
.dk-group-in { width: 14ch; }
/* The tabs out of sight: each laid out as the grid is, over it, unseen,
 * so their panels keep a real size and keep running. */
.dk-gbox { position: absolute; display: grid; visibility: hidden; pointer-events: none; overflow: hidden; }
.dk-gbox > .pn.dk-gback { position: absolute; inset: 0; }
/* The rail: another tab's line under the panels, and its name on a row
 * that came from there. */
#toc .dk-tabline { list-style: none; }
#toc .dk-tabrow { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 8px; border-radius: var(--r-sm); font-size: var(--fs-small); color: var(--fg-2); text-align: left; }
#toc .dk-tabrow:hover { background: var(--rule); color: var(--fg); }
.dk-tl-n { margin-left: auto; color: var(--fg-3); font-size: var(--fs-micro); }
.dk-tabline.blk .dk-tl-n { color: var(--warn); font-weight: 600; }
`;
