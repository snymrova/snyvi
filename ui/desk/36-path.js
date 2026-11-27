/* ui/desk/36-path.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the path pill (plan 94e0a0f735, P1) ----------
/*
 * 1.69's head said where you were four ways -- the desk's name, its tabs as
 * chips, `[n]` chips for the panels the grid had no room for, and a
 * four-segment switcher of views -- in thirteen controls. The reader found it
 * "damn confusing" (audit e6364ec354). Head A says it once, as a path:
 *
 *   Home › breeds-of-dogs ▾ › Tab 2 ▾ › photos ▾
 *
 * A part is drawn only once there is a second thing at its level: Home with
 * two desks open, the tab with two tabs, the last part with two panels on
 * the tab (or a view up: Folder, Page, Board · name). The desk's name is
 * always there. Each part with a ▾ is a menu, drawn by menu.js from the
 * entries here (`pathMenu`) or, for the desk part, with the other desks
 * (menu.js `deskItems`), so Home's pill lists them the same way.
 *
 * The board dot -- something drawn since the reader looked -- rides on the
 * desk part, and "Claude made a board · Open" hangs under the pill
 * (33-switch.js), where the way in now is.
 */

/** The pill's slots, in the head's markup: drawn once, filled on every layout. */
const pathHtml = () => `<nav class="dk-path" aria-label="Where you are" data-part="desk.path"><span class="dk-pp-home"></span><span class="dk-pp-desk"></span>` +
  `<span class="dk-groups" data-part="desk.groups"></span><span class="dk-pp-last"></span><span class="dk-sw"></span></nav>`;

/** Desks open, the shelf's left out: two or more and the path starts at Home. */
const openDesks = () => ((ctx.desks && ctx.desks.desks) || []).filter(x => !x.parked);
/** Another desk with a panel that asks, for the warn dot on Home. */
const elseAsks = d => !!ctx.corner?.()?.asks?.(d.id)?.length || openDesks().some(x => x.id !== d.id && (x.panes || []).some(p => p.status && (p.status.agent === "needs_you" || p.status.blocked)));

function pathSlot(d) {
  const hd = ctx.docEl.querySelector(".dk-head"), { esc } = ctx;
  if (!hd) return;
  const on = viewNow(d), heads = boardHeads(d), bid = on.startsWith("board:") ? on.slice(6) : "";
  const fresh = heads.filter(b => b.id !== bid && boardNew(d, b) > 0);
  const sep = `<i class="dk-pp-s" aria-hidden="true">›</i>`;
  const home = openDesks().length > 1
    ? `<button type="button" class="dk-pp" data-path="home" data-tip="Home" data-tip-sub="every desk${elseAsks(d) ? " · another desk asks you" : ""}" data-key="ctrl+alt+h">Home${elseAsks(d) ? `<i class="dk-pp-dot on warn" aria-hidden="true"></i>` : ""}</button>${sep}` : "";
  const desk = `<button type="button" class="dk-pp dk-pp-d" data-path="desk" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(d.name)}: its views and the other desks${fresh.length ? ", a board has something new" : ""}" ` +
    `data-tip="${esc(d.name)}" data-tip-sub="${esc(fresh.length ? fresh.map(b => `${b.name || b.id}: ${boardNew(d, b)} new`).join(" · ") : "Panels, Folder, boards · the other desks")}"><b class="dk-name">${esc(d.name)}</b>` +
    `<i class="dk-pp-dot${fresh.length ? " on" : ""}" aria-hidden="true"></i><i class="dk-pp-v" aria-hidden="true">▾</i></button>`;
  fill(hd.querySelector(".dk-pp-home"), home);
  fill(hd.querySelector(".dk-pp-desk"), desk);
  fill(hd.querySelector(".dk-pp-last"), lastPart(d, on, bid, sep));
}

/** Written only when it changed, and the part the keyboard was on keeps it. */
function fill(el, html) {
  if (!el || el.$html === html || el.querySelector("input")) return;
  const k = el.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  el.innerHTML = html; el.$html = html;
  if (k) el.querySelector(`[data-path="${k}"]`)?.focus({ preventScroll: true });
}

/** The last part: the view when one is up, else the focused panel when
 *  the tab has two or more. */
function lastPart(d, on, bid, sep) {
  const { esc } = ctx;
  if (on !== "panels") {
    const name = on === "folder" ? "Folder" : on === "page" ? "Page" : `Board · ${(boardMod && boardMod.name()) || (boardHeads(d).find(b => b.id === bid) || {}).name || bid}`;
    return `${sep}<button type="button" class="dk-pp dk-pp-v1" data-path="desk" aria-haspopup="menu" aria-expanded="false" data-tip="${esc(name)}${viewBy ? ` · opened by ${esc(viewBy)}` : ""}" data-tip-sub="Esc goes back to the panels">${esc(name)}<i class="dk-pp-v" aria-hidden="true">▾</i></button>`;
  }
  const ps = gridPanes(d).map(p => views.get(p.id)).filter(Boolean);
  if (ps.length < 2) return "";
  const v = views.get(focused) || ps[0], [word, cls] = backState(v);
  return `${sep}<button type="button" class="dk-pp dk-pp-p${cls}" data-path="panel" aria-haspopup="menu" aria-expanded="false" aria-label="Panel ${v.pane.slot}, ${esc(short(v))}: the panels of this ${d.grp ? "tab" : "desk"}" ` +
    `data-tip="Panel ${v.pane.slot} · ${esc(word)}" data-tip-sub="the panels, and which are in sight">${esc(short(v))}<i class="dk-pp-v" aria-hidden="true">▾</i></button>`;
}

/** The tab part, for `groupsHead` (23-groups.js): the tab shown, as a
 *  `.dk-group` so its right-click menu and its rename are the tab's own;
 *  a click opens the tabs' menu. A tab just closed is its Undo there. */
function pathTab(d, gs, gone) {
  const { esc } = ctx, sep = `<i class="dk-pp-s" aria-hidden="true">›</i>`;
  if (gone) return `${sep}<button type="button" class="dk-pp dk-group" data-grp-back data-tip="Closed · its panels are kept, stopped" data-tip-sub="Undo brings it back" aria-label="Undo closing tab ${esc(gone.name)}">${esc(gone.name)} · Undo</button>`;
  if (gs.length < 2) return "";
  const g = gs.find(x => x.id === d.grp) || gs[0];
  const need = allPanes(d).some(p => p.grp !== g.id && needsYou(views.get(p.id)));
  return `${sep}<button type="button" class="dk-pp dk-group on${need ? " blk" : ""}" data-grp="${g.id}" data-path="tab" aria-haspopup="menu" aria-expanded="false" ` +
    `data-tip="${esc(g.name)}${need ? " · another tab needs you" : ""}" data-tip-sub="the tabs · ⌃⌥⇧[ ] steps through them">${esc(g.name)}<i class="dk-group-mark" aria-hidden="true">${need ? "!" : ""}</i><i class="dk-pp-v" aria-hidden="true">▾</i></button>`;
}

/** A click on a part: Home goes there; the rest open their menu. True when it was one. */
function pathClick(e) {
  const b = e.target.closest("[data-path]");
  if (!b || !b.closest(".dk-path")) return false;
  e.preventDefault();
  if (b.dataset.path === "home") { ctx.home?.(); return true; }
  const r = b.getBoundingClientRect();
  ctx.menu?.(b, r.left, r.bottom + 4, e.detail === 0);
  return true;
}

/** The tab part's and the panel part's menus, for `actions` (07-actions.js);
 *  the desk part's is menu.js's own, with the desks in it. */
function pathMenu(el) {
  const d = current(), k = el.dataset.path;
  if (!d) return null;
  if (k === "tab") {
    const gs = d.groups || [], v = views.get(focused), here = gs.find(g => g.id === d.grp);
    return { head: "Tabs", items: [
      ...gs.map(g => ({ label: g.name, on: g.id === d.grp, hint: allPanes(d).some(p => p.grp === g.id && needsYou(views.get(p.id))) ? "needs you" : "", run: () => showGroup(g.id) })),
      "rule",
      { label: "New tab", run: () => newGroup() },
      here && { label: "Rename this tab…", moves: 1, run: () => renameGroup(here) },
      ...(v ? gs.filter(g => g.id !== v.pane.grp).map(g => ({ label: `Move panel ${v.pane.slot} to ${g.name}`, run: () => regroup(v, g.id) })) : []),
      here && { label: "Close this tab", about: "its panels are kept, stopped", run: () => closeGroup(here) },
    ].filter(Boolean) };
  }
  if (k === "panel") {
    const ps = gridPanes(d).map(p => views.get(p.id)).filter(Boolean), back = backViews(d);
    const inSight = v => !!ctx.docEl.querySelector(`.dk-grid > .pn[data-id="${v.id}"]`);
    return { head: `Panels of this ${d.grp ? "tab" : "desk"}`, items: [
      ...ps.map(v => ({ label: `${v.pane.slot} · ${short(v)}`, hint: backState(v)[0], on: inSight(v), key: ctx.keyHint(`ctrl+alt+${v.pane.slot}`), run: () => focusPane(v.id) })),
      back.length && "rule",
      back.length && { label: `In the back · ${back.length}`, key: ctx.keyHint("ctrl+alt+b"), run: () => backKey() },
    ].filter(Boolean) };
  }
  return null;
}

/** For menu.js: this desk's views, then + New board… and the boards list,
 *  as the desk part's menu begins. */
export function pathViews() {
  const d = current();
  if (!d) return [];
  const on = viewNow(d), heads = boardHeads(d);
  return [
    { label: "Panels", on: on === "panels", hint: "Esc", run: () => openView("panels") },
    { label: "Folder", on: on === "folder", key: ctx.keyHint("ctrl+alt+f"), run: () => openView("folder") },
    ...heads.map(b => ({ label: `Board · ${b.name || b.id}`, on: on === `board:${b.id}`, hint: boardNew(d, b) ? `${boardNew(d, b)} new` : "", run: () => openView(`board:${b.id}`) })),
    { label: heads.length ? "New board…" : "+ New board…", about: "a canvas Claude draws on", run: () => boardsList(true) },
    heads.length > 1 && { label: "Boards…", about: "rename, order, remove", run: () => boardsList(false) },
  ].filter(Boolean);
}

/** The boards list (33-switch.js), hung under the desk part. */
function boardsList(make) {
  const a = ctx.docEl.querySelector(".dk-head .dk-pp-d");
  if (!a) return;
  if (bl) blShut();
  blToggle(a, true);
  if (make) blEdit("new");
}

const PATH_CSS = `
/* The pill: one rounded row of parts. Parts with a choice only; the desk's
   name always. Each part keeps to its words, cut with an ellipsis, so a long
   name never pushes the line out of the head. */
.dk-path { position: relative; flex: 0 1 auto; min-width: 0; display: flex; align-items: center; height: 26px; padding: 0 2px; box-sizing: border-box;
  border-radius: var(--r-pill); background: var(--wash); box-shadow: inset 0 0 0 1px var(--rule); }
.dk-path > span { display: contents; }
.dk-pp { flex: 0 1 auto; min-width: 0; max-width: 220px; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border: 0; border-radius: var(--r-pill);
  background: none; font: inherit; font-size: var(--fs-small); color: var(--fg-2); white-space: nowrap; cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.dk-pp:hover, .dk-pp[aria-expanded="true"] { color: var(--fg); background: var(--rule); }
.dk-pp-d { color: var(--fg); }
.dk-pp-d .dk-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dk-pp-v { flex: none; font-style: normal; font-size: var(--fs-micro); color: var(--fg-3); }
.dk-pp-s { flex: none; font-style: normal; color: var(--fg-3); font-size: var(--fs-small); }
.dk-pp-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); visibility: hidden; }
.dk-pp-dot.on { visibility: visible; }
.dk-pp-dot.warn { background: var(--warn); }
.dk-pp.blk, .dk-pp.blk .dk-group-mark { color: var(--warn); }
.dk-path .dk-group { max-width: 160px; border-radius: var(--r-pill); }
.dk-path .dk-group-in { height: 22px; max-width: 160px; }
/* Narrow: the parts before the last two fold away, the desk's name kept. */
@media (max-width: 860px) { .dk-pp { max-width: 120px; } .dk-path > .dk-pp-home { display: none; } }
/* The card under the pill (33-switch.js): from the desk part, over the panels. */
.dk-path .dk-sw { display: block; position: absolute; left: 0; top: 100%; width: 0; height: 0; }
.dk-path .dk-sw-tip { left: 0; right: auto; }
.dk-path .dk-sw-tip::before { left: 28px; right: auto; }
/* Another desk asking, in the line's box (10-onyou.js, elseLine). */
.dk-ask { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; }
.dk-ask-w { flex: none; font-size: var(--fs-micro); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--warn); }
.dk-ask-m { flex: none; color: var(--fg-3); font-size: var(--fs-micro); }
.dk-ask-go { flex: none; height: 20px; padding: 0 9px; border: 0; border-radius: var(--r-pill); background: var(--accent); color: var(--on-accent); font: inherit; font-size: var(--fs-small); font-weight: 500; cursor: pointer; }
.dk-ask-x { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: var(--r-xs); background: none; color: var(--fg-3); cursor: pointer; }
.dk-ask-x:hover { background: var(--rule); color: var(--fg); }
.dk-lbox { position: relative; }
.dk-ask-opts { position: absolute; left: 0; top: calc(100% + 4px); z-index: var(--z-pop, 30); display: none; flex-wrap: wrap; gap: 4px; max-width: 460px; padding: 6px;
  border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule-2), var(--shadow); }
.dk-lbox:is(:hover, :focus-within) .dk-ask-opts { display: flex; }
/* The keys left the head for ⋯ (head A): their slot stays, empty, as the
   sheet's anchor, against the +. */
.dk-head .dk-keys-b { display: none; }
/* + is one button; what it makes is its menu. */
.dk-head .icon.dk-plus { font-size: 15px; }
`;
