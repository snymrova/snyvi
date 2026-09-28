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

/* `.keymode-sample` is the pill as the first-ten-minutes page shows it: the
 * same look, in the page's flow rather than fixed at the bottom. Only the
 * real pill is placed: `:is()` counts as its ID, so a class rule after it
 * could never have put the sample back in the flow. */
const CSS = `
#keymode { position: fixed; left: 50%; bottom: 20px; z-index: var(--z-toast); transform: translateX(-50%); }
:is(#keymode, .keymode-sample) { pointer-events: none;
  padding: 4px 11px; border-radius: var(--r-pill); font-size: var(--fs-small); color: var(--fg-2); background: var(--bg-raise);
  border: 1px solid var(--rule); box-shadow: var(--shadow); opacity: 0; transition: opacity var(--dur-move); }
.keymode-sample { display: inline-block; }
:is(#keymode, .keymode-sample).show { opacity: 1; transition-duration: var(--dur-quick); }
:is(#keymode, .keymode-sample).on::before { content: "●"; color: var(--accent); margin-right: 6px; }
#keymode.dim { opacity: .45; transition-duration: 2s; }
#keymode.hit { animation: key-hit var(--dur-move); }
@keyframes key-hit { 50% { border-color: var(--accent); } }
body.keys #main #chrome { box-shadow: 0 1px 0 var(--accent); }
`;

/** The pill and its sheet, made the first time either is wanted. It is a
 *  status region, so a screen reader hears "Keys on" and "Keys off" without
 *  the focus moving. */
/** The pill's look, once, for the pill and for the sample of it. */
export function sheet() {
  if (document.getElementById("keys-drawn")) return;
  const s = document.createElement("style");
  s.id = "keys-drawn";
  s.textContent = CSS;
  document.head.append(s);
}

function mount() {
  if (pill) return;
  sheet();
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
  pill.textContent = "Keys on · Esc";
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
  pill.textContent = `${/Mac/.test(navigator.platform) ? "⌃B" : "Ctrl B"} for keys`;
  clearTimeout(offT);
  offT = setTimeout(() => { if (!sleep) pill.className = ""; }, HINT);
}

/** A single letter, once ⌃B has woken them: what it does, through what the
 *  page hands over. False for a key that is not one of them, so the page
 *  leaves it alone. They were a switch in app.js, carried by every first
 *  paint for a reader who may never press ⌃B; since 1.7.1 they come with
 *  the pill, which ⌃B fetches before any letter can act. */
export function letter(e, c) {
  const { state } = c;
  if (c.browsing() && (e.key === "j" || e.key === "k")) {
    const links = [...c.browseEl.querySelectorAll(".b-file a")];
    const at = links.findIndex(a => a.dataset.path === state.browsePath);
    const next = links[at + (e.key === "j" ? 1 : -1)] || (at < 0 ? links[0] : null);
    if (next) c.showBrowse(next.dataset.browse, next.dataset.path, true);
    return true;
  }
  const ids = c.order(), i = state.doc ? ids.indexOf(state.doc.id) : -1;
  const sib = c.siblings(), si = state.doc ? sib.indexOf(state.doc.id) : -1;
  switch (e.key) {
    case "j": if (ids[i + 1]) c.showDoc(ids[i + 1], true); else if (i < 0 && ids[0]) c.showDoc(ids[0], true); break;
    case "k": if (i > 0) c.showDoc(ids[i - 1], true); break;
    case "[": if (sib[si + 1]) c.showDoc(sib[si + 1], true); break;   // sidebar is newest-first, so older is +1
    case "]": if (si > 0) c.showDoc(sib[si - 1], true); break;
    // A second `c` leaves the comparison: over a desk, the meta's Back button
    // is not drawn, and the key that opened it is the natural way out.
    case "c": if (state.comparing) { state.cache.delete(state.doc.id); c.showDoc(state.doc.id, false); } else c.showCompare(); break;
    case "p": c.togglePin(); break;
    case "s": c.toggleSplit(); break;
    case "v": c.togglePreview(); break;
    case "/": c.openFind(); break;
    // Delete and not Backspace: a key a reader leans on while thinking is
    // not a key to lose a document to.
    case "Delete": c.deleteCurrent(true); break;
    case "n": c.openNext(); break;
    case "i": c.showInbox(true); break;
    case "w": c.wide(); break;
    case "z": c.wrap(); break;
    case "t": c.rail(); break;
    // The diagram under the cursor, or the last one used: fit it, or fill the
    // screen with it. Both are no-ops on a page with no diagram on it.
    case "0": case "f": c.mmd()?.key(e.key); break;
    case "\\": c.side(); break;
    case "o":
      if (state.doc) window.open(`/api/docs/${state.doc.id}/raw`, "_blank");
      else if (c.browsing() && state.browsePath) window.open(c.rawUrl(state.browseRoot.id, state.browsePath), "_blank");
      break;
    default: return false;
  }
  return true;
}
