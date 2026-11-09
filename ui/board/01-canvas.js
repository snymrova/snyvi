/* The Board view: frames an agent draws, in the desk's folder, that the
 * reader watches arrive (plan 6ff79c55a7, docs/BOARD.md).
 *
 * Not on the wire until a board is opened: ui/desk's views part imports this
 * on the first open, the way the desk itself is imported by app.js. The seam
 * is three calls wide -- `open` with everything it needs in one argument,
 * `changed` when a document event names this board, and `close` -- with
 * `name` and `refit` for the views part's chip and dock. The board's frames
 * and tokens are its own bar, top left over the canvas (03-list.js), not a
 * section of the desk's rail: a folded rail took them away.
 *
 * The reader's hands are select, pan and zoom. Nothing here edits a frame:
 * the agent draws, snyvi shows. A frame is a document, shown exactly the way
 * an HTML document is (ui/app/04-doc.js): an iframe sandboxed without
 * allow-same-origin, loaded by `src` from the document's own route, so it
 * gets that route's CSP -- no network, no parent -- and nothing more. Never
 * srcdoc: a srcdoc frame takes on this page's CSP instead.
 *
 * The world is one element under a transform: pan is a translate, zoom a
 * scale about the cursor. Frames are placed in world pixels, at the size the
 * agent gave, so a frame 1200 wide is 1200 CSS pixels wide in its iframe,
 * whatever the zoom.
 */

const ZOOM_MIN = 0.05, ZOOM_MAX = 4;
/** The margin `fit` leaves round what it fits, in screen pixels. */
const FIT_PAD = 48;
let o = null;            // what `open` was handed
let host = null, world = null, bar = null, list = null;
let board = null;        // the last read: {id, name, hash, frames, tokens, focus}
let view = { x: 0, y: 0, k: 1 };
/** What the reader has selected, by frame id, in the order they picked. */
let picked = [];
let fitted = false;

const shown = () => (board ? board.frames.filter(f => !f.hidden) : []);

function applyView() {
  if (world) world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  if (host) host.style.setProperty("--bd-k", String(view.k));
}

/** Zoom by `by` about the point (cx, cy) on screen, so what is under the
 *  cursor stays under it. */
function zoomAt(by, cx, cy) {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.k * by));
  const r = host.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

/** Fit `frames` (all shown ones when none) in the view. */
function fit(frames) {
  const fs = frames && frames.length ? frames : shown();
  if (!fs.length || !host) return;
  const x0 = Math.min(...fs.map(f => f.x)), y0 = Math.min(...fs.map(f => f.y));
  const x1 = Math.max(...fs.map(f => f.x + f.w)), y1 = Math.max(...fs.map(f => f.y + f.h + 28));
  const r = host.getBoundingClientRect();
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
    Math.min((r.width - 2 * FIT_PAD) / Math.max(1, x1 - x0), (r.height - 2 * FIT_PAD) / Math.max(1, y1 - y0))));
  view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0 + 28) * k) / 2 - (y0 - 28) * k };
  applyView();
}

/** Pan by dragging the empty board, zoom with ctrl/cmd and the wheel (a
 *  trackpad's pinch arrives as that), pan with the wheel alone. A drag that
 *  moved is a pan, not a click: it does not clear the selection. */
function wire() {
  let drag = null;
  host.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".bd-bar, .bd-list")) return;
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, on: e.target.closest(".bd-frame") };
    host.setPointerCapture(e.pointerId);
  });
  host.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    host.classList.add("bd-panning");
    view.x = drag.vx + dx; view.y = drag.vy + dy;
    applyView();
  });
  const end = e => {
    if (!drag) return;
    const d = drag; drag = null;
    host.classList.remove("bd-panning");
    if (!d.moved) pick(d.on && d.on.dataset.id, e.shiftKey || e.metaKey || e.ctrlKey);
  };
  host.addEventListener("pointerup", end);
  host.addEventListener("pointercancel", () => { drag = null; host.classList.remove("bd-panning"); });
  host.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
  }, { passive: false });
  host.addEventListener("keydown", e => {
    if (e.target.closest("input, textarea")) return;
    const r = host.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (e.key === "0") fit();
    else if (e.key === "f") fit(shown().filter(f => picked.includes(f.id)));
    else if (e.key === "+" || e.key === "=") zoomAt(1.25, cx, cy);
    else if (e.key === "-") zoomAt(0.8, cx, cy);
    else if (e.key === "Escape" && lookOpen) { lookOpen = false; paintList(); }
    else if (e.key === "Escape" && picked.length) pick(null, false);
    else return;
    e.preventDefault();
  });
}
