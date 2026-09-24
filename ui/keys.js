/* The key mode's pill: the one thing on the screen that says whether the
 * single letters are awake.
 *
 * A chunk, like find and the menu. The page keeps the gate itself -- whether
 * a `j` acts is a question it answers on every key, and ⌃B has to work the
 * first time -- but the pill, its timers and its look are only wanted once
 * a reader has pressed ⌃B, or pressed a letter and wondered why nothing
 * happened. Until then none of this is on the wire.
 *
 * The pill sits at the bottom centre, clear of the toasts in the corner, and
 * takes no clicks: a click is one of the things that puts the keys back to
 * sleep, and a pill that caught one would be a pill in the way.
 */

const IDLE = 10000, DIM = 8000, HINT = 1500, HINT_EVERY = 30000;

let pill = null, sleep = null, dimT = 0, offT = 0, hinted = 0;

const CSS = `
#keymode { position: fixed; left: 50%; bottom: 20px; z-index: 30; transform: translateX(-50%); pointer-events: none;
  padding: 4px 11px; border-radius: 999px; font-size: 12px; color: var(--fg-2); background: var(--bg-raise);
  border: 1px solid var(--rule); box-shadow: var(--shadow); opacity: 0; transition: opacity .2s; }
#keymode.show { opacity: 1; transition-duration: .12s; }
#keymode.on::before { content: "●"; color: var(--accent); margin-right: 6px; }
#keymode.dim { opacity: .45; transition-duration: 2s; }
#keymode.hit { animation: key-hit .2s; }
@keyframes key-hit { 50% { border-color: var(--accent); } }
body.keys #main #chrome { box-shadow: 0 1px 0 var(--accent); }
`;

/** The pill and its sheet, made the first time either is wanted. It is a
 *  status region, so a screen reader hears "Keys on" and "Keys off" without
 *  the focus moving. */
function mount() {
  if (pill) return;
  const s = document.createElement("style");
  s.id = "keys-drawn";
  s.textContent = CSS;
  document.head.append(s);
  pill = Object.assign(document.createElement("div"), { id: "keymode" });
  pill.setAttribute("role", "status");
  document.body.append(pill);
}

/** The ten quiet seconds, from now. Two seconds before the end the pill dims,
 *  so the keys going to sleep is something the reader saw coming. */
function idle() {
  clearTimeout(dimT); clearTimeout(offT);
  pill.classList.remove("dim");
  dimT = setTimeout(() => pill.classList.add("dim"), DIM);
  offT = setTimeout(() => sleep && sleep(), IDLE);
}

/* What puts the keys to sleep besides Esc and ⌃B, which the page hears
 * itself: a click anywhere, and the focus going somewhere a letter is typed
 * -- a field, or a panel. Listened for only while the keys are awake. */
const click = () => sleep && sleep();
const focus = e => {
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest?.(".pn-body")) click();
};

/** Awake. `done` is how this chunk puts them back to sleep -- the page owns
 *  the flag, so the page has to hear it. */
export function on(done) {
  mount();
  sleep = done;
  addEventListener("pointerdown", click, true);
  addEventListener("focusin", focus);
  pill.className = "show on";
  pill.textContent = "Keys on · esc";
  idle();
}

/** Asleep again, however it happened. */
export function off() {
  if (!pill) return;
  clearTimeout(dimT); clearTimeout(offT);
  removeEventListener("pointerdown", click, true);
  removeEventListener("focusin", focus);
  sleep = null;
  pill.className = "";
  pill.textContent = "Keys off";
}

/** A key acted: one blink, so it is plain the key landed, and the quiet
 *  seconds start over. */
export function hit() {
  if (!pill || !sleep) return;
  pill.classList.remove("hit");
  void pill.offsetWidth;   // restart the animation on a second key in a row
  pill.classList.add("hit");
  idle();
}

/** A letter pressed asleep says why it did nothing -- once in a while, not
 *  on every key, because a reader typing into the wrong place does not need
 *  telling eleven times. */
export function hint() {
  mount();
  const now = Date.now();
  if (sleep || now - hinted < HINT_EVERY) return;
  hinted = now;
  pill.className = "show";
  pill.textContent = "⌃B for keys";
  clearTimeout(offT);
  offT = setTimeout(() => { if (!sleep) pill.className = ""; }, HINT);
}
