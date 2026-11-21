/* ui/desk/32-ways.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- ways to a board, and back (1.67, boards audit ef7024c7dc) ----------
/*
 * A board had one way in, the desk's ⋯ menu, and no address: a reload, a
 * desk switch or Back put the reader on the panels, and nothing said a board
 * had been drawn on while they were elsewhere. Four things here:
 *
 * An address. A board or the page open over the desk is in the URL, as
 * `/desk/<id>#view=board:<name>`: a reload, Back, Forward and a link land
 * on it. The hash, so the daemon's `/desk/{id}` page serves it as it is.
 * Folder has its own address already (`/b/...`).
 *
 * A count. The desks list carries when each board's sections last changed
 * (`marks`, src/board.rs); this window keeps when the reader last had each
 * board on screen. What changed since is "N new": a dot on the switcher's
 * Boards segment, in whatever view, and the count on the board's row in the
 * boards list (33-switch.js, 1.68). Until 1.68 it was a chip in the head
 * whose ✕ meant "not now"; it is gone, with that second meaning of ✕.
 *
 * A key. ⌃⌥D goes to the board with something new, else the last one open,
 * and back to the panels from a board.
 *
 * A picture. An agent's `frame_look` is said to every window as a `look`
 * event; a window on that desk draws the section out of sight (ui/board's
 * `shoot`) and posts the PNG back. Nothing on screen changes.
 */

const SEEN_KEY = "snyvi.board.seen", LAST_KEY = "snyvi.board.last";
/** A board this window never had open counts what was drawn in its last
 *  three days: an old board is not all "new" the day this arrives. */
const SEEN_BACK = 3 * 86400;

function waysStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; }
}
function waysKeep(key, k, v) {
  try { const all = waysStore(key); all[k] = v; localStorage.setItem(key, JSON.stringify(all)); } catch { /* counted from three days back */ }
}

/** The reader has board `b` of desk `desk` on screen now, or said not now. */
function boardSeen(desk, b) { waysKeep(SEEN_KEY, `${desk}/${b}`, Math.floor(Date.now() / 1000)); }

/** How many of a board's sections changed since the reader last looked. */
function boardNew(d, b) {
  const seen = waysStore(SEEN_KEY)[`${d.id}/${b.id}`] || Math.floor(Date.now() / 1000) - SEEN_BACK;
  return (b.marks || []).filter(m => m > seen).length;
}

/** The board of desk `d` with the most new on it: `{b, n}`, or null. */
function boardFresh(d) {
  let best = null;
  for (const b of boardHeads(d)) {
    const n = boardNew(d, b);
    if (n && (!best || n > best.n)) best = { b, n };
  }
  return best;
}

/** ⌃⌥D: to the board with something new, else the last one open here, and
 *  from a board back to the panels. A desk without a board has no such key. */
function boardKey(e) {
  const d = current();
  if (!d || e.metaKey || e.shiftKey || !(e.ctrlKey && e.altKey) || e.code !== "KeyD") return false;
  let to = "panels";
  if (!viewNow(d).startsWith("board:")) {
    const heads = boardHeads(d);
    if (!heads.length) return false;
    const fresh = boardFresh(d), last = waysStore(LAST_KEY)[d.id];
    to = `board:${(fresh ? fresh.b : heads.find(b => b.id === last) || heads[0]).id}`;
  }
  e.preventDefault(); e.stopPropagation();
  openView(to);
  return true;
}

/** A board on this desk moved while it was not on screen: the desks list is
 *  read again, once for a burst, so the dot and the list count what is new. */
let waysT = 0;
function waysMoved() {
  clearTimeout(waysT);
  waysT = setTimeout(() => { if (ctx) ctx.refresh(); }, 2500);
}

/** True while the address is being followed, not set: a view opened from
 *  the URL does not write the URL. */
let addrQuiet = false;

/** The view in the address: pushed when the reader opened or left one,
 *  replaced when the address only catches up with what is on screen. */
function addrSet(v, push) {
  const d = current();
  if (addrQuiet || !d || reading != null || location.pathname !== `/desk/${d.id}`) return;
  // The name alone is encoded: the address reads `board:pricing`, as typed.
  const hash = v === "panels" ? "" : `#view=${v.startsWith("board:") ? "board:" + encodeURIComponent(v.slice(6)) : encodeURIComponent(v)}`;
  if (location.hash === hash) return;
  const url = `/desk/${d.id}${hash}`;
  if (push) history.pushState({ desk: d.id }, "", url);
  else history.replaceState({ ...(history.state || {}), desk: d.id }, "", url);
}

/** The desk was opened (07-actions.js `open`). By a press, the address
 *  catches up with a view still open over it. By the address -- a reload,
 *  Back, Forward, a link -- the view it names is opened, or the one it no
 *  longer names is left. A board the folder does not have is the panels. */
function addrOpened(push) {
  const d = current();
  if (!d) return;
  const now = viewNow(d);
  if (now === "folder") return;
  if (push) { if (now !== "panels") addrSet(now, false); return; }
  let v = "panels";
  try { const m = /^#view=(.+)$/.exec(location.hash); if (m) v = decodeURIComponent(m[1]); } catch { /* panels */ }
  if (v !== "page" && !(v.startsWith("board:") && boardsOf(d).includes(v.slice(6)))) v = "panels";
  if (v === "panels" && location.hash.startsWith("#view=")) addrSet("panels", false);
  if (v === now) return;
  addrQuiet = true;
  try { openView(v); } finally { addrQuiet = false; }
}

/** An agent's `frame_look` on this desk: the section drawn out of sight and
 *  its picture posted back, empty when none could be made, so the agent is
 *  told at once what to do instead. */
async function lookAsked(j) {
  if (!ctx || !j || j.n == null) return;
  const api = ctx.api;
  let png = "";
  try { png = await (await boardUse()).shoot({ api, desk: j.desk, board: j.board, frame: j.frame }); } catch { png = ""; }
  api(`/api/desks/${j.desk}/board/${encodeURIComponent(j.board)}/look/${j.n}`, { png: png.replace(/^data:image\/png;base64,/, "") }).catch(() => {});
}

const WAYS_CSS = "";
