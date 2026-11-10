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
  syncDoc();
  paintBar();
  if (!fitted && shown().length) { fit(); fitted = true; }
  paintList();
  paintIntro();
  if (o.named) o.named();
}

/* The empty board says what a board is and asks what to draw (1.62, V2):
 * the reader's words, typed into the docked Claude when it is at its prompt
 * (`o.ask`, Send now's guard), else copied for them to paste. Over the
 * canvas, in its middle, so nothing it leaves moves. */
function paintIntro() {
  const el = host && host.querySelector(".bd-intro");
  if (!el || !o) return;
  if (el.dataset.drawn) return;
  el.dataset.drawn = "1";
  const esc = o.esc, dir = `${o.dir || "design"}/${o.board}/`;
  el.innerHTML = `<h3>A board, for Claude to draw on</h3>` +
    `<p>Screens, cards, a page: each a section of HTML, side by side, as tall as it needs. Pick one and the panel beside it knows which you mean. It is kept in <code>${esc(dir)}</code> in this folder, so it goes in git with the work.</p>` +
    `<form class="bd-ask"><input name="what" maxlength="300" autocomplete="off" aria-label="What should Claude draw?" placeholder="What should Claude draw? Three takes on the home screen…">` +
    `<button type="submit">Ask Claude</button></form><p class="bd-ask-said" aria-live="polite"></p>`;
  el.querySelector("form").addEventListener("submit", e => {
    e.preventDefault();
    const what = e.target.elements.what.value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    const name = board ? board.name || board.id : o.board;
    const text = what
      ? `On the snyvi board "${name}" (${dir}), draw: ${what}. board_read it first.`
      : `Look at this project and draw on the snyvi board "${name}" (${dir}) the screens it most needs, as sections. board_read it first.`;
    const why = o.ask ? o.ask(text) : "";
    el.querySelector(".bd-ask-said").textContent = why || "Asked. It draws here as it goes.";
    if (!why) e.target.elements.what.value = "";
  });
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
 *  ({host, desk, board, api, esc, focus, named, dir}, and 1.62's boards,
 *  make, rename, switch and ask: the desk's boards, a new one, a name,
 *  another opened, and words typed into the docked Claude). Opening another board, or
 *  the same one again, starts clean. */
export function open(opts) {
  close();
  o = opts;
  host = opts.host;
  host.classList.add("bd");
  host.tabIndex = 0;
  host.innerHTML = `<div class="bd-world"></div><div class="bd-list" aria-label="Frames on this board"></div><div class="bd-bar" aria-live="polite"></div>` +
    `<p class="bd-off" role="alert" hidden>Could not reach snyvi.</p>` +
    `<div class="bd-intro" role="group" aria-label="An empty board"></div>`;
  world = host.querySelector(".bd-world");
  bar = host.querySelector(".bd-bar");
  list = host.querySelector(".bd-list");
  list.addEventListener("click", listClick);
  list.addEventListener("submit", boardsSubmit);
  addEventListener("message", docSaid);
  lookOpen = false; boardsOpen = false;
  view = { x: 0, y: 0, k: 1 };
  picked = [];
  fitted = false; touched = false; measured = {};
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
  removeEventListener("message", docSaid);
  dropDoc();
  htmlOf.clear();
  if (host) { host.classList.remove("bd", "bd-none", "bd-panning"); host.replaceChildren(); }
  o = null; host = null; world = null; bar = null; list = null; board = null; picked = []; lookOpen = false;
}

/** What is picked now, for the views part to carry when the dock changes. */
export const selected = () => picked.slice();

/** The board's name as `board.json` gives it, for the head's chip: the
 *  folder's name until the board is read. */
export const name = () => (board ? board.name || board.id : "");

/** Fit the frames again: the dock beside the board moved or changed shape,
 *  and what fitted a tall canvas is lost in a wide one. */
export function refit() { if (host && shown().length) fit(); }
