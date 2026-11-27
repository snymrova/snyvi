/* ui/desk/33-switch.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the view switcher and the boards list (1.68, plan d2db60758c) ----------
/*
 * The views had one way in, the desk's ⋯, a row per board, and the way back
 * was a ✕ on a chip whose place and words changed with the view -- and the
 * same ✕ on the new-sections chip meant "not now". The reader got lost
 * coming back from a board and missed the boards an agent made.
 *
 * So the head has a switcher, after the tabs, always the same four segments
 * in the same order: Panels, Folder, Page, Boards. The one on screen says its
 * name; the others are icons with a tip and their key. Its width is fixed --
 * Boards takes what the others leave -- so opening a view moves nothing,
 * and coming back is always the same press: Panels (Esc, ⌃⌥D, ⌃⌥F too).
 * This reverses 1.60's views-in-⋯-only, on the reader's word.
 *
 * Boards names the board on screen and opens the boards list: the one place
 * a board is made, renamed, moved and removed. A dot on it says a board has
 * sections drawn since the reader looked (32-ways.js counts them), whichever
 * view is up, in room the segment keeps for it. A board an agent made that
 * the reader never had open gets a card under the segment once: "Claude made
 * a board · pricing · Open". It stays until opened, put away, or the desk
 * left; it is never a corner toast, it is where the way in is.
 *
 * Removing a board is a mark in design/boards.json (src/board.rs `Shelf`):
 * its folder, files and versions stay. The row says "Removed · Undo" for
 * BACK_MS where it was; Removed (n) at the list's foot, and ⋯ → Recently
 * closed, bring it back. Removing the board on screen goes to the next one,
 * or the panels, and the Undo is under the Boards segment.
 */

/** Who drew a board, by its folder name, as the `board` event said it. */
const swBy = new Map();
/** The card under Boards: `{desk, kind: "made"|"removed", id, name, t}`, or null. */
let swTip = null;
const POINT_KEY = "snyvi.board.pointed";

/** The card under the pill (1.70: the segments went into the path's desk
 *  menu, 36-path.js), drawn in place on every layout (`viewsSlot`). */
function switchSlot(d) {
  const el = ctx.docEl.querySelector(".dk-head .dk-path > .dk-sw");
  if (!el) return;
  const on = viewNow(d), bid = on.startsWith("board:") ? on.slice(6) : "";
  const html = swTipHtml(d, boardHeads(d), bid);
  if (el.$html !== html) {
    const k = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.swTip : null;
    el.innerHTML = html; el.$html = html;
    if (k) el.querySelector(`[data-sw-tip="${k}"]`)?.focus();
  }
  ctx.docEl.querySelector(".dk-head .dk-pp-d")?.setAttribute("aria-expanded", String(!!bl && bl.kind === "sw"));
}

/** The card under Boards: the new board an agent made, once, or the Undo of
 *  the board just removed from the screen. */
function swTipHtml(d, heads, bid) {
  const { esc } = ctx;
  if (swTip && swTip.desk !== d.id) swTip = null;
  if (!swTip) {
    // A board this window never had open, with sections in it, never
    // pointed at before: an agent's. One card at a time, the newest.
    const seen = waysStore(SEEN_KEY), pointed = waysStore(POINT_KEY);
    const b = heads.filter(b => b.id !== bid && !seen[`${d.id}/${b.id}`] && !pointed[`${d.id}/${b.id}`] && boardNew(d, b) > 0)
      .sort((a, c) => Math.max(0, ...(c.marks || [])) - Math.max(0, ...(a.marks || [])))[0];
    if (!b) return "";
    swTip = { desk: d.id, kind: "made", id: b.id, name: b.name || b.id };
    waysKeep(POINT_KEY, `${d.id}/${b.id}`, Math.floor(Date.now() / 1000));
  }
  if (swTip.kind === "made" && (bid === swTip.id || !heads.some(b => b.id === swTip.id))) { swTip = null; return ""; }
  if (swTip.kind === "removed") {
    return `<span class="dk-sw-tip" role="status"><span>Removed · <b>${esc(swTip.name)}</b></span>` +
      `<button type="button" class="dk-sw-tb" data-sw-tip="undo">Undo</button></span>`;
  }
  const by = swBy.get(swTip.id);
  return `<span class="dk-sw-tip" role="status"><span>Claude made a board · <b>${esc(swTip.name)}</b>${by ? `<small> · ${esc(by)}</small>` : ""}</span>` +
    `<button type="button" class="dk-sw-tb" data-sw-tip="open">Open</button><button type="button" class="dk-sw-tx" data-sw-tip="away" aria-label="Put this away" data-tip="Put this away" data-tip-sub="the board stays in Boards">${ctx.glyph("x", 10)}</button></span>`;
}

/** A click on the switcher or its card. True when it was theirs. */
function swClick(e) {
  const t = e.target.closest("[data-sw-tip]");
  if (t) {
    e.preventDefault();
    const tip = swTip, d = current();
    swTip = null;
    if (tip && d && t.dataset.swTip === "open") openView(`board:${tip.id}`);
    else if (tip && d && t.dataset.swTip === "undo") { clearTimeout(tip.t); blBack(d, tip.id, true).then(ok => { if (ok) openView(`board:${tip.id}`); }); }
    if (d) viewsSlot(d);
    return true;
  }
  const s = e.target.closest("[data-sw]");
  if (!s) return false;
  e.preventDefault();
  if (s.dataset.sw === "boards") { blToggle(s, e.detail === 0); return true; }
  blShut();
  openView(s.dataset.sw);
  return true;
}

/* ---------- the boards list ---------- */
/*
 * Under the Boards segment, or under the board's own title (ui/board's
 * `list`): over everything, pushing nothing. Each board a row -- this one
 * ticked, "N new", how many sections -- and a ⋯ for Rename, Move up, Move
 * down and Remove; then + New board…, which asks the name first, and
 * Removed (n). Focus stays on the row acted on, through every repaint: the
 * row's keys are ↑ ↓, Enter to open, F2 to rename, ⌫ to remove, Esc out.
 */
let bl = null;

/** Which anchor a list hangs from: the switcher's Boards, or a board's title. */
const blKind = a => (a.closest(".dk-path") ? "sw" : "title");
/** The anchor now: a redraw of the head or the board's bar replaces it. */
function blAnchor() {
  if (!bl) return null;
  if (!bl.anchor.isConnected) bl.anchor = document.querySelector(bl.kind === "sw" ? "#doc .dk-head .dk-pp-d" : ".dk-view .bd-title") || bl.anchor;
  return bl.anchor;
}

function blToggle(anchor, byKey) {
  if (bl && bl.kind === blKind(anchor)) { blShut(); return; }
  blShut();
  const d = current();
  if (!d) return;
  const el = Object.assign(document.createElement("div"), { className: "dk-bl" });
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "This desk's boards");
  document.body.append(el);
  bl = { desk: d.id, el, anchor, kind: blKind(anchor), acts: null, edit: boardHeads(d).length ? null : "new", gone: new Map(), removed: false, said: "" };
  el.addEventListener("click", blClick);
  el.addEventListener("submit", blSubmit);
  el.addEventListener("keydown", blKey);
  document.addEventListener("pointerdown", blOut, true);
  addEventListener("resize", blPlace);
  blPaint();
  blPlace();
  const on = viewNow(d).slice(6);
  const first = el.querySelector(`.dk-bl-form input`) || [...el.querySelectorAll("[data-bl-go]")].find(b => b.dataset.blGo === on) || el.querySelector("[data-bl-go], [data-bl-new]");
  if (first) first.focus(); else if (byKey) el.querySelector("button")?.focus();
  const d2 = current();
  if (d2) viewsSlot(d2);
}

function blShut(back) {
  if (!bl) return;
  const b = bl;
  bl = null;
  for (const g of b.gone.values()) clearTimeout(g.t);
  b.el.remove();
  document.removeEventListener("pointerdown", blOut, true);
  removeEventListener("resize", blPlace);
  if (back) { bl = b; const a = blAnchor(); bl = null; if (a && a.isConnected) a.focus(); }
  const d = current();
  if (d) viewsSlot(d);
}

function blOut(e) { if (bl && !bl.el.contains(e.target) && !blAnchor().contains(e.target)) blShut(); }

/** Under its anchor, inside the window. */
function blPlace() {
  if (!bl) return;
  const a = blAnchor();
  if (!a.isConnected) { blShut(); return; }
  const r = a.getBoundingClientRect(), w = bl.el.offsetWidth;
  bl.el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  bl.el.style.top = `${r.bottom + 4}px`;
}

function blPaint() {
  if (!bl) return;
  const d = current();
  if (!d || d.id !== bl.desk) { blShut(); return; }
  const { esc, glyph } = ctx, on = viewNow(d), heads = boardHeads(d);
  const removed = ((ctx.desks && ctx.desks.removed_boards && ctx.desks.removed_boards[d.id]) || []).filter(b => !bl.gone.has(b.id));
  const rows = heads.map(b => ({ b }));
  // A row just removed keeps its place, saying so, for its Undo.
  for (const [id, g] of [...bl.gone].sort((a, c) => a[1].i - c[1].i)) if (!heads.some(b => b.id === id)) rows.splice(Math.min(g.i, rows.length), 0, { gone: id, name: g.name });
  const form = (k, label, val, go) => `<form class="dk-bl-form" data-bl-form="${esc(k)}"><input name="n" maxlength="80" aria-label="${esc(label)}" placeholder="${esc(label)}" value="${esc(val)}" autocomplete="off" data-k="in:${esc(k)}"><button type="submit">${go}</button></form>`;
  const html = rows.map(({ b, gone, name }, i) => {
    if (gone) return `<div class="dk-bl-row gone"><span class="dk-bl-n">Removed · ${esc(name)}</span><button type="button" class="dk-bl-u" data-bl-undo="${esc(gone)}" data-k="undo:${esc(gone)}">Undo</button></div>`;
    if (bl.edit === b.id) return form(b.id, `The name of ${b.name || b.id}`, b.name || b.id, "Rename");
    const here = on === `board:${b.id}`, n = boardNew(d, b), open = bl.acts === b.id;
    const first = heads[0] === b, last = heads[heads.length - 1] === b;
    return `<div class="dk-bl-row${here ? " on" : ""}"><button type="button" class="dk-bl-go" data-bl-go="${esc(b.id)}" data-k="go:${esc(b.id)}" aria-current="${here}">` +
      `<span class="dk-bl-k" aria-hidden="true">${here ? "✓" : ""}</span><span class="dk-bl-n">${esc(b.name || b.id)}</span>${n ? `<span class="dk-bl-new">${n} new</span>` : ""}<span class="dk-bl-c" aria-label="${b.frames || 0} sections">${b.frames || 0}</span></button>` +
      `<button type="button" class="dk-bl-m" data-bl-more="${esc(b.id)}" data-k="more:${esc(b.id)}" aria-expanded="${open}" aria-label="More for ${esc(b.name || b.id)}" data-tip="Rename, move, remove">${glyph("more", 14)}</button></div>` +
      (open ? `<div class="dk-bl-acts" role="group" aria-label="${esc(b.name || b.id)}">` +
        `<button type="button" data-bl-ren="${esc(b.id)}" data-k="ren:${esc(b.id)}" aria-keyshortcuts="F2">Rename</button>` +
        `<button type="button" data-bl-up="${esc(b.id)}" data-k="up:${esc(b.id)}"${first ? " disabled" : ""}>Move up</button>` +
        `<button type="button" data-bl-down="${esc(b.id)}" data-k="down:${esc(b.id)}"${last ? " disabled" : ""}>Move down</button>` +
        `<button type="button" data-bl-rm="${esc(b.id)}" data-k="rm:${esc(b.id)}" data-tip="Remove from view" data-tip-sub="its files and versions stay · Removed brings it back">Remove</button></div>` : "");
  }).join("") || `<p class="dk-bl-none">No boards yet. A board is a canvas Claude draws sections on, with a panel beside it.</p>`;
  const make = bl.edit === "new" ? form("new", "The new board's name", "", "Make")
    : `<button type="button" class="dk-bl-a" data-bl-new data-k="new">+ New board…</button>`;
  const rem = removed.length ? `<button type="button" class="dk-bl-a" data-bl-removed data-k="removed" aria-expanded="${bl.removed}">Removed (${removed.length})<i aria-hidden="true">${bl.removed ? "▾" : "›"}</i></button>` +
    (bl.removed ? removed.map(b => `<div class="dk-bl-row gone"><span class="dk-bl-n">${esc(b.name || b.id)}</span><span class="dk-bl-c">${b.removed ? closedWhen(b.removed) : ""}</span>` +
      `<button type="button" class="dk-bl-u" data-bl-back="${esc(b.id)}" data-k="back:${esc(b.id)}" aria-label="Bring back ${esc(b.name || b.id)}">Bring back</button></div>`).join("") : "") : "";
  const all = `<div class="dk-bl-h">Boards</div>${html}<hr>${make}${rem}<p class="dk-bl-said" role="status">${esc(bl.said)}</p>`;
  if (bl.el.$html === all) return;
  const a = document.activeElement, k = a && bl.el.contains(a) ? (a.closest("[data-k]") || {}).dataset?.k : null;
  bl.el.innerHTML = all; bl.el.$html = all;
  if (k) blFocus(k);
}

/** Focus the list's control `k` ("go:home", "undo:home"…), else the same
 *  row's next control that can take it, else the first row. A board moved to
 *  the end has its Move down disabled, which no focus reaches: Move up
 *  takes it then, still on the row acted on. */
function blFocus(k) {
  if (!bl) return;
  const all = [...bl.el.querySelectorAll("[data-k]")].filter(b => !b.disabled), id = k.split(":")[1];
  const el = all.find(b => b.dataset.k === k) || all.find(b => /^(up|down):/.test(k) && b.dataset.k === `${k.startsWith("up") ? "down" : "up"}:${id}`) ||
    all.find(b => b.dataset.k.endsWith(`:${id}`)) || all.find(b => b.dataset.k.startsWith("go:")) || all[0];
  el?.focus();
}

function blSay(t) { if (bl) { bl.said = t; blPaint(); } }

function blClick(e) {
  const d = current(), t = e.target;
  if (!bl || !d) return;
  let b;
  if ((b = t.closest("[data-bl-go]"))) { const id = b.dataset.blGo; blShut(); if (viewNow(d) !== `board:${id}`) openView(`board:${id}`); return; }
  if ((b = t.closest("[data-bl-more]"))) { bl.acts = bl.acts === b.dataset.blMore ? null : b.dataset.blMore; blPaint(); return; }
  if ((b = t.closest("[data-bl-ren]"))) { blEdit(b.dataset.blRen); return; }
  if ((b = t.closest("[data-bl-up], [data-bl-down]"))) { blMove(d, b.dataset.blUp || b.dataset.blDown, b.dataset.blUp ? -1 : 1); return; }
  if ((b = t.closest("[data-bl-rm]"))) { blRemove(d, b.dataset.blRm); return; }
  if ((b = t.closest("[data-bl-undo]"))) { blBack(d, b.dataset.blUndo, true); return; }
  if ((b = t.closest("[data-bl-back]"))) { blBack(d, b.dataset.blBack, false); return; }
  if (t.closest("[data-bl-new]")) { blEdit("new"); return; }
  if (t.closest("[data-bl-removed]")) { bl.removed = !bl.removed; blPaint(); }
}

function blEdit(k) {
  if (!bl) return;
  bl.edit = k; bl.acts = null; bl.said = "";
  blPaint();
  bl.el.querySelector(".dk-bl-form input")?.select();
}

function blKey(e) {
  if (!bl) return;
  const t = e.target, row = t.closest("[data-bl-go]");
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    // A field put away; with no board to show, the list itself.
    if (bl.edit) {
      const k = bl.edit, d = current();
      if (k === "new" && d && !boardHeads(d).length) { blShut(true); return; }
      bl.edit = null; blPaint(); blFocus(k === "new" ? "new" : `go:${k}`);
      return;
    }
    if (bl.acts) { const k = bl.acts; bl.acts = null; blPaint(); blFocus(`more:${k}`); return; }
    blShut(true);
    return;
  }
  if (t.matches("input")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const all = [...bl.el.querySelectorAll("button:not(:disabled), input")], i = all.indexOf(t);
    all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    return;
  }
  if (row && e.key === "F2") { e.preventDefault(); blEdit(row.dataset.blGo); return; }
  if (row && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); const d = current(); if (d) blRemove(d, row.dataset.blGo); }
}

/** Rename or make, from the list's field. The folder's name never changes,
 *  so nothing that names a board by it is lost. */
async function blSubmit(e) {
  const f = e.target.closest("[data-bl-form]"), d = current();
  if (!f || !bl || !d) return;
  e.preventDefault();
  const name = f.elements.n.value.trim(), k = f.dataset.blForm;
  if (!name) return;
  try {
    if (k === "new") {
      const j = await makeBoard(d.id, name);
      blShut();
      if (j && j.board) openView(`board:${j.board}`);
      return;
    }
    await ctx.api(`/api/desks/${d.id}/board/${encodeURIComponent(k)}/name`, { name });
    bl.edit = null; bl.said = `Renamed ${name}`;
    await ctx.refresh();
    blPaint();
    blFocus(`go:${k}`);
  } catch (err) { blSay(`Could not do that · ${ctx.sayErr(err).why}`); }
}

/** A board one place up or down: the whole order, said again. */
async function blMove(d, id, by) {
  const ids = boardHeads(d).map(b => b.id), i = ids.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await ctx.api(`/api/desks/${d.id}/boards/order`, { order: ids });
    await ctx.refresh();
    if (bl) { bl.said = by < 0 ? "Moved up" : "Moved down"; blPaint(); blFocus(`${by < 0 ? "up" : "down"}:${id}`); }
  } catch (err) { blSay(`Could not move it · ${ctx.sayErr(err).why}`); }
}

/** Remove from view: the row says so, with Undo, for BACK_MS. The board on
 *  screen goes, for the next one or the panels, and its Undo is the card
 *  under the Boards segment. */
async function blRemove(d, id) {
  const heads = boardHeads(d), i = heads.findIndex(b => b.id === id), b = heads[i];
  if (!b) return;
  try { await ctx.api(`/api/desks/${d.id}/board/${encodeURIComponent(id)}/remove`, { removed: true }); }
  catch (err) { blSay(`Could not remove it · ${ctx.sayErr(err).why}`); return; }
  const name = b.name || b.id;
  if (viewNow(d) === `board:${id}`) {
    blShut();
    const next = heads[i + 1] || heads[i - 1];
    clearTimeout(swTip && swTip.t);
    swTip = { desk: d.id, kind: "removed", id, name, t: setTimeout(() => { if (swTip && swTip.id === id && swTip.kind === "removed") { swTip = null; const c = current(); if (c) viewsSlot(c); } }, BACK_MS) };
    await ctx.refresh();
    openView(next ? `board:${next.id}` : "panels");
    ctx.docEl.querySelector(".dk-sw [data-sw-tip]")?.focus();
    return;
  }
  if (!bl) return;
  bl.acts = null; bl.said = "";
  bl.gone.set(id, { name, i, t: setTimeout(() => { if (bl) { bl.gone.delete(id); blPaint(); } }, BACK_MS) });
  await ctx.refresh();
  blPaint();
  blFocus(`undo:${id}`);
}

/** Undo, or Bring back from Removed (n) and Recently closed: the mark off. */
async function blBack(d, id, undo) {
  try { await ctx.api(`/api/desks/${d.id}/board/${encodeURIComponent(id)}/remove`, { removed: false }); }
  catch (err) { if (bl) blSay(`Could not bring it back · ${ctx.sayErr(err).why}`); else ctx.toast("Could not bring the board back", err); return false; }
  if (bl) { const g = bl.gone.get(id); if (g) clearTimeout(g.t); bl.gone.delete(id); bl.said = undo ? "" : "Brought back"; }
  await ctx.refresh();
  if (bl) { blPaint(); blFocus(`go:${id}`); }
  return true;
}

/** For Recently closed (30-closed.js): a removed board back, and opened. */
async function boardBack(d, id) {
  if (await blBack(d, id, false)) openView(`board:${id}`);
}

const SWITCH_CSS = `
/* The card under Boards: over the grid, pushing nothing. */
.dk-sw-tip { position: absolute; top: calc(100% + 6px); right: 0; z-index: var(--z-pop, 30); display: flex; align-items: center; gap: 8px; max-width: 420px; padding: 6px 6px 6px 12px;
  border-radius: var(--r-sm); background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--accent), var(--shadow); font-size: var(--fs-small); color: var(--fg); white-space: nowrap; }
.dk-sw-tip::before { content: ""; position: absolute; top: -5px; right: 28px; width: 8px; height: 8px; transform: rotate(45deg); background: var(--bg-raise); box-shadow: -1px -1px 0 var(--accent); }
.dk-sw-tip > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dk-sw-tip small { color: var(--fg-3); font-size: inherit; }
.dk-sw-tb { flex: none; height: 22px; padding: 0 10px; border: 0; border-radius: var(--r-pill); background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 500; cursor: pointer; }
.dk-sw-tx { flex: none; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: var(--r-sm); background: none; color: var(--fg-3); cursor: pointer; }
.dk-sw-tx:hover { background: var(--rule); color: var(--fg); }
/* ---------- the boards list ---------- */
.dk-bl { position: fixed; z-index: var(--z-pop, 30); width: 300px; max-height: min(70vh, 560px); overflow-y: auto; padding: 6px; box-sizing: border-box;
  border-radius: var(--r-md); background: var(--bg-raise); box-shadow: inset 0 0 0 1px var(--rule-2), var(--shadow); font-size: var(--fs-small); color: var(--fg); }
.dk-bl-h { padding: 4px 8px 6px; font-weight: 600; color: var(--fg-2); }
.dk-bl hr { margin: 4px 0; border: 0; border-top: 1px solid var(--rule); }
.dk-bl-row { display: flex; align-items: center; gap: 2px; min-height: 28px; }
.dk-bl-go { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px 0 4px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; color: var(--fg-2); text-align: left; cursor: pointer; }
.dk-bl-go:hover, .dk-bl-go:focus-visible, .dk-bl-row.on .dk-bl-go { color: var(--fg); }
.dk-bl-go:hover, .dk-bl-m:hover, .dk-bl-a:hover, .dk-bl-acts button:hover { background: var(--rule); }
.dk-bl-row.on .dk-bl-go { font-weight: 600; }
.dk-bl-k { flex: none; width: 14px; text-align: center; color: var(--accent); }
.dk-bl-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-bl-new { flex: none; padding: 0 6px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: var(--fs-micro); font-weight: 600; line-height: 16px; }
.dk-bl-c { flex: none; min-width: 2ch; text-align: right; color: var(--fg-3); font-variant-numeric: tabular-nums; font-size: var(--fs-micro); }
.dk-bl-m { flex: none; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--r-sm); background: none; color: var(--fg-3); cursor: pointer; }
.dk-bl-m[aria-expanded="true"] { background: var(--rule); color: var(--fg); }
.dk-bl-acts { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px 0 4px 22px; }
.dk-bl-acts button, .dk-bl-u { height: 24px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: var(--wash); font: inherit; color: var(--fg-2); cursor: pointer; }
.dk-bl-acts button:disabled { opacity: .4; cursor: default; background: var(--wash); }
.dk-bl-acts [data-bl-rm]:hover { color: var(--danger); }
.dk-bl-row.gone { padding: 0 4px 0 22px; color: var(--fg-3); gap: 8px; }
.dk-bl-u { flex: none; color: var(--accent); font-weight: 500; }
.dk-bl-a { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 28px; padding: 0 8px 0 22px; border: 0; border-radius: var(--r-sm); background: none; font: inherit; color: var(--fg-2); text-align: left; cursor: pointer; }
.dk-bl-a i { font-style: normal; color: var(--fg-3); }
.dk-bl-form { display: flex; gap: 4px; margin: 2px 0; padding-left: 18px; }
.dk-bl-form input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--accent); border-radius: var(--r-sm); background: var(--bg); font: inherit; color: var(--fg); outline: none; }
.dk-bl-form button { flex: none; height: 26px; padding: 0 10px; border: 0; border-radius: var(--r-sm); background: var(--accent); color: var(--on-accent); font: inherit; cursor: pointer; }
.dk-bl-none { margin: 4px 8px 6px; color: var(--fg-3); white-space: normal; }
.dk-bl-said { min-height: 16px; margin: 4px 8px 2px; color: var(--fg-3); font-size: var(--fs-micro); }
`;
