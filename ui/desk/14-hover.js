/* ui/desk/14-hover.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- focus that follows the pointer (#161) ----------
/*
 * Off unless the reader turns it on (the sidebar's foot strip, with the
 * look, since it is the whole app's and not one desk's): every terminal that
 * has it ships it off, and a focus that moves on its own is a change of
 * context the reader must be able to refuse (WCAG 3.2.5). Turned on, the
 * panel the pointer *settles* on takes the keys -- not one it passes over.
 * The rules are each borrowed from a tool that learned them the hard way:
 *
 *  - only a real move counts, more than 3px: never an enter event, which a
 *    browser sends when a panel slides under a pointer that did not move
 *    (a relayout, a panel closing);
 *  - only into another panel (kitty, i3): moving about inside the focused
 *    one never changes anything, and a gap, the rail or the sidebar keeps
 *    the focus where it was ("sloppy" focus);
 *  - settled, with a cap (hoverIntent, Zed): in the new panel 100ms and
 *    slowed under 6px in the last 120ms, or 300ms whatever it does; each
 *    new crossing starts again, so a sweep across a panel takes nothing;
 *  - never while the reader is busy (libinput, Emacs, KDE): within 800ms of
 *    a key that is not a modifier, with a button down (a selection, a head
 *    dragged), with a field that has something typed in it, a menu or the
 *    tray open, or the window not in front;
 *  - never back: a keyboard switch or a click leaves the panel under a
 *    still pointer where it is until the pointer has left it, and the
 *    pointer is never moved (sway users turn warping off).
 *
 * When it does move the focus, a sonar ping goes out from the pointer -- two
 * rings, 420ms, on an overlay outside the layout -- so the reader sees that
 * it moved and where from, at the spot their eye already is. A keyboard
 * switch has no ping: the pointer did not do it.
 */

const HOVER_KEY = "snyvi.hover-focus";
let hoverOn = (() => { try { return localStorage.getItem(HOVER_KEY) === "1"; } catch { return false; } })();
let hvX = -1, hvY = -1, hvPane = null, hvAt = 0, hvTimer = 0, hvKeyAt = 0, hvBlocked = null, hvUnder = null, hvMine = false, sonarEl = null;
/** The panel the pointer last took, and when: the rail's cards wait a
 *  moment before they follow it (15-cards.js `cardsHeld`). */
let hvFocusAt = -1e9, hvFocusId = null;
const hvSamples = [];

/** Whether focus follows the pointer; with an argument, turns it on or off
 *  and keeps that for the next window. The foot strip's button (app.js) is
 *  where the reader sets it; both say so with `snyvi:hover-focus`, so the
 *  button and an open desk agree whichever moved it. */
export function hoverFocus(on) {
  if (on === undefined) return hoverOn;
  hoverOn = !!on;
  try { localStorage.setItem(HOVER_KEY, hoverOn ? "1" : "0"); } catch { /* the setting lasts this window */ }
  dispatchEvent(new CustomEvent("snyvi:hover-focus", { detail: hoverOn }));
  ctx.toast(hoverOn ? "Focus follows the pointer" : "Focus on click", hoverOn ? "rest the pointer on a panel to type in it" : "click a panel to type in it");
  return hoverOn;
}
// The button in the foot strip, here or in another window of this browser.
addEventListener("snyvi:hover-focus", e => { hoverOn = !!e.detail; hoverStop(); });
addEventListener("storage", e => { if (e.key === HOVER_KEY) { hoverOn = e.newValue === "1"; hoverStop(); } });

function hoverStop() {
  clearInterval(hvTimer);
  hvTimer = 0; hvPane = null;
}

/** What says the reader is doing something else with the pointer or the keys. */
function hoverBusy(e) {
  if (!hoverOn || ctx.root.dataset.view !== "desk" || !document.hasFocus()) return true;
  if ((e && e.buttons) || performance.now() - hvKeyAt < 800) return true;
  if ([...views.values()].some(v => v.holding)) return true;
  const a = document.activeElement;
  if (a && !a.closest(".pn-body") && a.matches("input, textarea, select, [contenteditable]") && fieldHolds(a)) return true;
  // A menu or a dialog drawn: one hidden by its own or a parent's `hidden`
  // draws no box.
  return oy.open || [...document.querySelectorAll("#ctx, [role=dialog]")].some(x => !x.classList.contains("oy-tray") && x.getClientRects().length > 0);
}

/** Whether a field outside the panels keeps the focus from the pointer:
 *  only one with something typed in it (#170). A note's field saves what it
 *  has when it loses the focus, and a rename commits, so a half-written line
 *  is never taken from under the reader; but the empty field Enter leaves
 *  after a note is added holds nothing, and it kept hover focus off until a
 *  click. A list holds while it is focused; a box to tick or a button never. */
function fieldHolds(a) {
  if (a.tagName === "SELECT") return true;
  if (a.isContentEditable) return !!a.textContent.trim();
  if (a.tagName === "INPUT" && /^(checkbox|radio|button|submit|reset|range|color|file)$/.test(a.type)) return false;
  return !!a.value.trim();
}

function hoverMove(e) {
  if (e.pointerType === "touch") return;
  const dx = e.clientX - hvX, dy = e.clientY - hvY;
  if (dx * dx + dy * dy < 9) return;
  hvX = e.clientX; hvY = e.clientY;
  const now = performance.now();
  hvSamples.push([now, hvX, hvY]);
  while (now - hvSamples[0][0] > 120) hvSamples.shift();
  const pn = e.target.closest?.(".pn"), id = pn && ctx.docEl.contains(pn) ? pn.dataset.id : null;
  hvUnder = id;
  // Out of the panel a keyboard switch or a click left under it: free again.
  if (id !== hvBlocked) hvBlocked = null;
  if (!id || id === focused || id === hvBlocked || hoverBusy(e)) { hoverStop(); return; }
  if (id !== hvPane) { hoverStop(); hvPane = id; hvAt = now; hvTimer = setInterval(hoverTick, 25); }
}

function hoverTick() {
  if (hoverBusy()) { hoverStop(); return; }
  const now = performance.now(), age = now - hvAt, first = hvSamples[0];
  const moved = first ? Math.hypot(hvX - first[1], hvY - first[2]) : 0, still = now - (hvSamples.at(-1)?.[0] ?? 0) > 90;
  if (age < 300 && !(age >= 100 && (still || moved < 6))) return;
  const id = hvPane;
  hoverStop();
  if (!views.get(id) || id === focused) return;
  hvMine = true;
  hvFocusAt = now; hvFocusId = id;
  focusPane(id);
  hvMine = false;
  ping(hvX, hvY);
}

/** A key that is not a modifier holds the focus where it is a while. */
function hoverKey(e) {
  if (!["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key)) { hvKeyAt = performance.now(); hoverStop(); }
}

/** Focus moved some other way -- a click, a key, a rail row: the panel
 *  under a still pointer stays where it is until the pointer leaves it. */
function hoverFocused(e) {
  if (!hvMine && e.target.closest?.(".pn-body")) { hvBlocked = hvUnder; hoverStop(); }
}

function hoverAttach() {
  document.addEventListener("pointermove", hoverMove, { passive: true });
  document.addEventListener("keydown", hoverKey, true);
  document.addEventListener("focusin", hoverFocused);
}

function hoverDetach() {
  hoverStop();
  document.removeEventListener("pointermove", hoverMove);
  document.removeEventListener("keydown", hoverKey, true);
  document.removeEventListener("focusin", hoverFocused);
}

/** Two rings out from (`x`, `y`) in the accent, the second a beat behind;
 *  one still ring, fading, for a reader who asked for less motion. The same
 *  two rings each time, so pings never pile up, and nothing runs after. */
function ping(x, y) {
  if (!sonarEl || !sonarEl.isConnected) {
    sonarEl = Object.assign(document.createElement("div"), { id: "dk-sonar", innerHTML: "<i></i><i></i>" });
    sonarEl.setAttribute("aria-hidden", "true");
    document.body.append(sonarEl);
  }
  const still = stillPlease();
  [...sonarEl.children].forEach((r, i) => {
    for (const a of r.getAnimations()) a.cancel();
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    if (still) { if (!i) r.animate([{ opacity: .9, transform: "scale(.43)" }, { opacity: 0, transform: "scale(.43)" }], { duration: 200 }); return; }
    r.animate([{ opacity: .85, transform: "scale(.08)" }, { opacity: 0, transform: "scale(1)" }], { duration: 420, delay: i * 120, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
  });
}

const HOVER_CSS = `
#dk-sonar { position: fixed; inset: 0; pointer-events: none; z-index: var(--z-over); }
#dk-sonar i { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; border: 1.5px solid var(--accent); opacity: 0; }
`;
