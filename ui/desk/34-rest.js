/* ui/desk/34-rest.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the desk at rest (1.69) ----------

/* One key puts both sides away and one key brings them back as they were
 * (plan 520aa866b0, Round C). The sides already folded, each by a key of
 * its own: `\` and `t`, letters, which a panel's program takes; so from
 * inside a panel, where the reader is, neither could be pressed. Rest is
 * ⌃⌥S, with the desk's other chords, which are taken from the panel before
 * its program sees them.
 *
 * It is not a third state kept beside the two folds. It sets the same two
 * attributes `\` and `t` set (`data-side`, `data-rail`), by the buttons that
 * set them, so the first paint (boot.js) already knows them and nothing
 * flashes on a reload; and it is every desk's, as they are. What Rest adds
 * is a memory of what each side was, in `snyvi.rest`, and a mark on the
 * root while both sides are still away. Unfolding either side by hand ends
 * it: the mark and the memory go, and the sides are simply where the reader
 * put them.
 *
 * At rest the left is its 44 px strip, whose icons already open over the
 * page, and the right is gone: no strip. The right side comes back over the
 * panels, fixed at the window's right edge, when the pointer rests on that
 * edge or ⌃⌥⇧S asks for it. No scrim, and the grid's box does not change,
 * so no program is sent a new size. Opened by the pointer, the keyboard
 * stays in the panel; opened by the key, it goes to the rail and comes back.
 *
 * The pointer's rules are 14-hover.js's: it must rest, 150 ms within 6 px
 * of the edge, never with a button down or within 800 ms of a key, and not
 * at all for a reader who asked for less motion. It closes 300 ms after
 * the pointer has left, held while a field in it has the keyboard or a
 * menu from it is open. */

const REST_KEY = "snyvi.rest";
const REST_EDGE = 6, REST_IN_MS = 150, REST_OUT_MS = 300;
/** Where the right side is a column to fold; under it, it is a sheet. */
const restWide = () => matchMedia("(min-width: 1101px)").matches;
/** What the sides were before Rest, or null when the desk is not at rest. */
function restWas() {
  try { const j = JSON.parse(localStorage.getItem(REST_KEY) || "null"); return j && typeof j === "object" ? j : null; } catch { return null; }
}
const restRoot = document.documentElement;
const restFolded = () => restRoot.dataset.side === "0" && restRoot.dataset.rail === "0";
/** At rest: asked for, and both sides still away. */
const resting = () => !!restWas() && restFolded();

/** How the right side came over the panels (`key`, `pointer`), the focus to
 *  give back after a key's, and the two timers of the pointer's. */
let restBy = "", restBack = null, restIn = 0, restOut = 0, restX = 0;

/** The root's mark follows the truth: there while at rest, gone, with the
 *  memory, once either side was unfolded by hand. */
function restSync() {
  if (resting()) { if (!restRoot.dataset.rest) restRoot.dataset.rest = "1"; return; }
  if (restWas() && !restFolded()) { try { localStorage.removeItem(REST_KEY); } catch { /* the mark alone decides */ } }
  if (restRoot.dataset.rest) { delete restRoot.dataset.rest; restBy = ""; }
  clearTimeout(restIn); clearTimeout(restOut); restIn = restOut = 0;
}
new MutationObserver(restSync).observe(restRoot, { attributes: true, attributeFilter: ["data-side", "data-rail"] });
restSync();

/** A side folded or unfolded by the button that does it (app.js `fold`),
 *  so what the page stores and paints is the page's own. */
function restSide(which, away) {
  if ((restRoot.dataset[which] === "0") === away) return;
  document.getElementById(which === "side" ? "btn-side-hide" : "btn-rail-hide")?.click();
}

/** ⌃⌥S, and the palette's `rest`: both sides away, or back as they were. */
function restToggle() {
  if (!restWide()) { ctx.toast("Rest the desk", "at this width the right side is a sheet already"); return; }
  if (resting()) {
    const was = restWas();
    restOver("");
    try { localStorage.removeItem(REST_KEY); } catch { /* the sides come back all the same */ }
    if (was.side !== "0") restSide("side", false);
    if (was.rail !== "0") restSide("rail", false);
    restSync();
    return;
  }
  const was = { side: restRoot.dataset.side === "0" ? "0" : "1", rail: restRoot.dataset.rail === "0" ? "0" : "1" };
  restSide("side", true);
  restSide("rail", true);
  try { localStorage.setItem(REST_KEY, JSON.stringify(was)); } catch { /* at rest for this page */ }
  restSync();
  ctx.toast("The desk is at rest", `${ctx.keyHint ? ctx.keyHint("ctrl+alt+s") : "Ctrl Alt S"} brings both sides back · the right side comes over at the window's right edge`);
}
export const restHere = () => restToggle();

/** The right side over the panels (`by` a key or the pointer), or put down
 *  (`""`). A key's takes the keyboard into the rail and gives it back. */
function restOver(by) {
  clearTimeout(restIn); clearTimeout(restOut); restIn = restOut = 0;
  const on = restRoot.dataset.rest === "over";
  if (by && (!resting() || restRoot.dataset.view !== "desk")) return;
  if (!!by === on) { if (by) restBy = by; return; }
  if (by) {
    restBy = by;
    restBack = by === "key" ? document.activeElement : null;
    restRoot.dataset.rest = "over";
    // The foot's links were measured against a rail with no width.
    if (current()) rail();
    if (by === "key") ctx.tocEl.querySelector("button, a[href], input")?.focus({ preventScroll: true });
    return;
  }
  restBy = "";
  if (restRoot.dataset.rest) restRoot.dataset.rest = "1";
  const back = restBack; restBack = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
  else if (ctx.rail.contains(document.activeElement)) views.get(focused)?.body.focus({ preventScroll: true });
}

/** The desk's chord (07-actions.js `keys`): ⌃⌥S rests or wakes the desk;
 *  with ⇧, at rest, the right side comes over or is put down. */
function restKey(e) {
  if (e.code !== "KeyS") return false;
  e.preventDefault(); e.stopPropagation();
  if (e.shiftKey && resting()) restOver(restRoot.dataset.rest === "over" ? "" : "key");
  else restToggle();
  return true;
}

/** Esc puts the right side down, from anywhere but a panel or a field,
 *  where Esc is the program's or the field's. */
function restEsc(e) {
  if (e.key !== "Escape" || e.ctrlKey || e.altKey || e.metaKey || restRoot.dataset.rest !== "over") return false;
  if (e.target.closest?.(".pn-body, input, textarea, [contenteditable]")) return false;
  e.preventDefault(); e.stopPropagation();
  restOver("");
  return true;
}

/** What keeps a side the pointer opened from closing under the reader: a
 *  field of the rail's with the keyboard, a menu drawn, a button held. */
function restHeld(e) {
  if (e && e.buttons) return true;
  const a = document.activeElement;
  if (a && ctx.rail.contains(a) && a.matches("input, textarea, select, [contenteditable]")) return true;
  return [...document.querySelectorAll("#ctx, .rt-comp")].some(x => x.getClientRects().length > 0);
}

function restMove(e) {
  if (!restRoot.dataset.rest || e.pointerType === "touch") return;
  restX = e.clientX;
  const edge = innerWidth - e.clientX <= REST_EDGE;
  if (restRoot.dataset.rest !== "over") {
    if (!edge || e.buttons || stillPlease() || !restWide()) { clearTimeout(restIn); restIn = 0; return; }
    if (!restIn) restIn = setTimeout(() => {
      restIn = 0;
      if (innerWidth - restX > REST_EDGE || performance.now() - hvKeyAt < 800 || !document.hasFocus()) return;
      restOver("pointer");
    }, REST_IN_MS);
    return;
  }
  if (restBy !== "pointer") return;
  if (edge || e.target.closest?.("#rail")) { clearTimeout(restOut); restOut = 0; return; }
  if (!restOut) restOut = setTimeout(restLeft, REST_OUT_MS);
}
function restLeft() {
  restOut = 0;
  if (restRoot.dataset.rest !== "over" || restBy !== "pointer") return;
  if (restHeld()) { restOut = setTimeout(restLeft, REST_OUT_MS); return; }
  restOver("");
}
/** The pointer out of the window: it is not resting on the edge, and a
 *  side it opened is left. */
function restGone() {
  clearTimeout(restIn); restIn = 0;
  if (restRoot.dataset.rest === "over" && restBy === "pointer" && !restOut) restOut = setTimeout(restLeft, REST_OUT_MS);
}
/** A press anywhere else puts it down, as a menu is put down. */
function restPress(e) {
  if (restRoot.dataset.rest !== "over" || e.target.closest?.("#rail, #ctx, #onyou, .rt-comp, #chrome")) return;
  restOver("");
}

function restAttach() {
  restSync();
  document.addEventListener("pointermove", restMove, { passive: true });
  document.addEventListener("pointerdown", restPress, true);
  restRoot.addEventListener("mouseleave", restGone);
}
function restDetach() {
  if (restRoot.dataset.rest === "over") restRoot.dataset.rest = "1";
  restBy = ""; restBack = null;
  clearTimeout(restIn); clearTimeout(restOut); restIn = restOut = 0;
  document.removeEventListener("pointermove", restMove);
  document.removeEventListener("pointerdown", restPress, true);
  restRoot.removeEventListener("mouseleave", restGone);
}

const REST_CSS = `
/* ---------- the desk at rest ----------
 * The right side over the panels: fixed at the window's right edge, at the
 * width it has docked, over the grid and taking nothing from it. No scrim.
 * At rest and not over, it is not drawn at all (app.css, data-rail="0"):
 * the strip's rules in the desk's style step aside for Rest. */
@media (min-width: 1101px) {
  :root[data-view="desk"][data-rest="over"][data-rail="0"] #rail:not(.empty) { display: flex; position: fixed; inset: 0 0 0 auto; width: var(--rail-w); z-index: var(--z-rail); box-shadow: var(--shadow); animation: sheet-r var(--dur-quick) var(--ease-out); }
}
@media (prefers-reduced-motion: reduce) { :root[data-rest="over"] #rail { animation: none; } }
`;
