/** Read the board from the daemon and draw it. `since` is the last read's
 *  hash: when nothing changed the daemon says so and nothing redraws. */
async function load() {
  if (!o) return;
  const at = o;
  let j;
  try {
    j = await o.api(`/api/desks/${o.desk}/board/${encodeURIComponent(o.board)}${board ? `?since=${encodeURIComponent(board.hash)}` : ""}`);
  } catch (e) {
    if (at === o && host) host.querySelector(".bd-off").hidden = false;
    return;
  }
  if (at !== o || !host) return;
  host.querySelector(".bd-off").hidden = true;
  if (j.unchanged) return;
  board = j;
  picked = picked.filter(id => shown().some(f => f.id === id));
  paintFrames();
  paintBar();
  if (!fitted && shown().length) { fit(); fitted = true; }
  if (o.rail) o.rail();
}

/** A `board` event ({desk, board}): a frame of a board was written, hidden
 *  or placed. Redraw only what changed, which `load` and `paintFrame`
 *  already limit to the frame whose hash moved. Another desk's, or another
 *  board's, is not this one's. */
export function changed(ev) {
  if (!o || !ev || ev.desk !== o.desk || ev.board !== o.board) return;
  load();
}

/** Open a board in `opts.host`: everything it needs is in `opts`
 *  ({host, desk, board, api, esc, focus, rail}). Opening another board, or
 *  the same one again, starts clean. */
export function open(opts) {
  close();
  o = opts;
  host = opts.host;
  host.classList.add("bd");
  host.tabIndex = 0;
  host.innerHTML = `<div class="bd-world"></div><div class="bd-bar" aria-live="polite"></div>` +
    `<p class="bd-off" role="alert" hidden>Could not reach snyvi.</p>` +
    `<p class="bd-hint">Nothing on this board yet. Ask the panel beside it to draw a frame.</p>`;
  world = host.querySelector(".bd-world");
  bar = host.querySelector(".bd-bar");
  view = { x: 0, y: 0, k: 1 };
  picked = [];
  fitted = false;
  board = null;
  style();
  wire();
  applyView();
  paintBar();
  return load();
}

/** Leave the board. The host element is the views part's; it is emptied,
 *  not removed. */
export function close() {
  if (host) { host.classList.remove("bd", "bd-none", "bd-panning"); host.replaceChildren(); }
  o = null; host = null; world = null; bar = null; board = null; picked = [];
}

/** What is picked now, for the views part to carry when the dock changes. */
export const selected = () => picked.slice();
