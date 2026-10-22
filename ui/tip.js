/* The snyvi tip (docs/DESIGN.md §8.1): what a control is, beside it, drawn
 * by snyvi rather than the OS.
 *
 * It replaces two things. `title`, which the engine draws where and when it
 * likes -- over the thing being read, in the toolkit's colours, and never for
 * a keyboard -- and the foot column's and rail's `data-label`, which only ever
 * showed to the right, and only for those few buttons. Now every control
 * names itself one way: `data-tip` (a name, at most four words), optionally
 * `data-tip-sub` (one line, when it changes what you would do) and
 * `data-key` (a shortcut, written by keyHint for this machine). `aria-label`
 * stays what a screen reader hears; the tip is what a sighted reader reads,
 * linked by `aria-describedby` while it shows.
 *
 * A chunk. First paint carries one listener (app.js) that fetches this on the
 * first pointer resting on a `[data-tip]`, or the first Tab; the first tip
 * waits 450 ms anyway, which is longer than a local fetch.
 *
 * The rules, from the hover audit:
 *   - 450 ms the first time; then, for 600 ms after one hides, the next shows
 *     at once, so running the pointer along a row of icons reads them all.
 *   - At once on :focus-visible. Never on touch.
 *   - A press, a scroll, a key, or Esc hides it: the hand has moved on.
 *   - It gives way to an answer: a toast anchored to the same control (the
 *     control carries `.said` while it does) hides it.
 *   - `data-tip-overflow` is a tip only while its text is cut off.
 *   - Beside the sidebar, the rail and the foot it goes right; in the desk's
 *     right-hand rail and the contents rail, left; in the top chrome and a
 *     panel's head, below. It flips and clamps at the window's edges.
 *
 * It looks like a tooltip, not a card (#177): the page's ink as its fill and
 * the page as its text, so it is dark on a light theme and light on a dark
 * one and never reads as one more panel; no border, no shadow; one short
 * line, the name and the key; a small arrow at the control. The sub-line is
 * not drawn -- a second, wrapped line is what made it a card -- but stays in
 * the tip, clipped (`.vh`), so `aria-describedby` still reads it aloud. Two
 * kinds wrap, as they must: `data-tip-overflow`, the whole of a cut-off row,
 * which a tip that cut it again would not say; and a tip whose sub-line is
 * what it is for, drawn under the name -- `data-tip-full` ("What it said",
 * an error's own words) and an armed button's ("Ends 3 panels · click
 * again", `armed` in app.js, whose bytes are first paint's).
 */

const CSS = `
#tip { position: fixed; z-index: var(--z-tip); max-width: 320px; padding: 3px 7px; pointer-events: none; white-space: nowrap;
  background: var(--fg); color: var(--bg); border-radius: var(--r-sm);
  font: 500 var(--fs-micro)/1.35 var(--sans); opacity: 0; transform: translate(var(--dx, 0), var(--dy, 0));
  transition: opacity var(--dur-instant) var(--ease-out), transform var(--dur-instant) var(--ease-out); }
#tip.on { opacity: 1; transform: none; }
#tip .tip-n { display: flex; align-items: baseline; gap: 8px; }
#tip .tip-n > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#tip[data-wrap] { white-space: normal; }
#tip[data-wrap] .tip-n > span { overflow-wrap: anywhere; }
#tip kbd { margin-left: auto; flex: none; min-width: 0; line-height: inherit; color: color-mix(in srgb, var(--bg) 60%, var(--fg)); background: none; border: 0; padding: 0; }
#tip[data-mono] .tip-n > span { font-family: var(--mono); }
#tip[data-full] .tip-s { position: static; width: auto; height: auto; overflow: visible; clip-path: none; white-space: normal;
  margin-top: 1px; font-weight: 400; color: color-mix(in srgb, var(--bg) 75%, var(--fg)); overflow-wrap: anywhere; }
#tip::after { content: ""; position: absolute; border: 4px solid transparent; }
#tip[data-side="right"]::after { left: -8px; top: calc(var(--ay) - 4px); border-right-color: var(--fg); }
#tip[data-side="left"]::after { right: -8px; top: calc(var(--ay) - 4px); border-left-color: var(--fg); }
#tip[data-side="below"]::after { top: -8px; left: calc(var(--ax) - 4px); border-bottom-color: var(--fg); }
#tip[data-side="above"]::after { bottom: -8px; left: calc(var(--ax) - 4px); border-top-color: var(--fg); }
#tip[data-side="right"] { --dx: -2px; } #tip[data-side="left"] { --dx: 2px; } #tip[data-side="below"] { --dy: -2px; } #tip[data-side="above"] { --dy: 2px; }
@media (prefers-reduced-motion: reduce) { #tip { transform: none !important; } }
`;

// GAP is the tip's edge from the control; its 4 px arrow leaves 2 between.
const FIRST_MS = 450, WARM_MS = 600, GAP = 6;

/** Beside, on the side the control's place in the page gives it; flipped
 *  when there is no room there, and kept on the window. The arrow points
 *  at the control's middle even when the edge has pushed the tip along,
 *  held off the tip's rounded corners. */
function place(tip, t) {
  const r = t.getBoundingClientRect();
  tip.style.left = tip.style.top = "0px";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let side = t.closest("#side, #rail-nav, .foot-set, .side-foot") ? "right"
    : t.closest("#rail, #toc, .dk-rail, #meta") ? "left" : "below";
  if (side === "right" && r.right + GAP + w > innerWidth - 4) side = "left";
  if (side === "left" && r.left - GAP - w < 4) side = r.right + GAP + w < innerWidth - 4 ? "right" : "below";
  if (side === "below" && r.bottom + GAP + h > innerHeight - 4) side = "above";
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let x = side === "right" ? r.right + GAP : side === "left" ? r.left - GAP - w : cx - w / 2;
  let y = side === "below" ? r.bottom + GAP : side === "above" ? r.top - GAP - h : cy - h / 2;
  x = Math.max(4, Math.min(x, innerWidth - w - 4));
  y = Math.max(4, Math.min(y, innerHeight - h - 4));
  tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
  tip.style.setProperty("--ax", Math.round(Math.max(8, Math.min(cx - x, w - 8))) + "px");
  tip.style.setProperty("--ay", Math.round(Math.max(6, Math.min(cy - y, h - 6))) + "px");
  tip.dataset.side = side;
}

export function init({ keyHint, since = performance.now() }) {
  const s = document.createElement("style"); s.textContent = CSS; document.head.append(s);
  const tip = Object.assign(document.createElement("div"), { id: "tip" });
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  const touch = matchMedia("(hover: none)");

  let el = null, timer = 0, warmUntil = 0, byKey = false;

  /** What a control says, or nothing: a truncated-only tip whose text fits
   *  says nothing, and a control being answered lets the answer speak. */
  function words(t) {
    const name = t.dataset.tip;
    if (!name || t.classList.contains("said")) return null;
    if (t.hasAttribute("data-tip-overflow")) {
      const c = t.matches("[data-tip-cut]") ? t : t.querySelector("[data-tip-cut]") || t;
      // Cut short across (an ellipsis) or down (a line clamp).
      if (c.scrollWidth <= c.clientWidth + 1 && c.scrollHeight <= c.clientHeight + 1) return null;
    }
    return name;
  }

  function show(t) {
    const name = words(t);
    if (!name) return hide();
    el = t;
    // A letter, Del or the backslash acts only once ⌃B has turned the letter keys on
    // (app.js `keys`); until then a tip naming one taught a key that did
    // nothing (audit 67d008cb6f). Chords, Esc, Enter and F2 always work.
    const k = t.dataset.key, letter = k && (k.length === 1 || k === "del");
    const key = letter && !document.body.classList.contains("keys") ? "" : k, sub = t.dataset.tipSub;
    tip.innerHTML = `<div class="tip-n"><span></span>${key ? "<kbd></kbd>" : ""}</div>${sub ? `<div class="tip-s vh"></div>` : ""}`;
    tip.querySelector(".tip-n > span").textContent = name;
    if (key) tip.querySelector("kbd").textContent = keyHint(key);
    if (sub) tip.querySelector(".tip-s").textContent = sub;
    tip.toggleAttribute("data-mono", t.hasAttribute("data-tip-mono"));
    const full = !!sub && t.matches("[data-tip-full], [data-armed]");
    tip.toggleAttribute("data-full", full);
    tip.toggleAttribute("data-wrap", full || t.hasAttribute("data-tip-overflow"));
    place(tip, t);
    tip.classList.add("on");
    t.setAttribute("aria-describedby", "tip");
  }

  function hide() {
    clearTimeout(timer);
    if (!el) return;
    el.removeAttribute("aria-describedby");
    el = null;
    tip.classList.remove("on");
    warmUntil = performance.now() + WARM_MS;
  }

  /** Shown at once while warm (one just hid), else after the first wait. */
  function soon(t, wait = FIRST_MS) {
    clearTimeout(timer);
    if (t === el) return;
    if (performance.now() < warmUntil || el) return show(t);
    timer = setTimeout(() => { if (t.isConnected && t.matches(":hover")) show(t); }, wait);
  }

  const target = e => e.target?.closest?.("[data-tip]");
  document.addEventListener("pointerover", e => {
    if (touch.matches || e.pointerType === "touch") return;
    byKey = false;
    const t = target(e);
    if (t) soon(t); else if (el && !el.contains(e.target)) hide();
  }, { passive: true });
  document.addEventListener("pointerout", e => {
    const t = target(e);
    if (t && !t.contains(e.relatedTarget) && !byKey) { clearTimeout(timer); if (el === t) hide(); }
  }, { passive: true });
  document.addEventListener("focusin", e => {
    const t = target(e);
    if (t && t.matches(":focus-visible")) { byKey = true; clearTimeout(timer); show(t); }
    else if (byKey) hide();
  });
  document.addEventListener("focusout", e => { if (byKey && el && el === target(e)) hide(); });
  // A control whose tip names what it is set to (\`data-tip-live\`: theme,
  // accent, Aa, width, wrap) says the new setting at once after a click,
  // under the hand: that is its answer (docs/DESIGN.md §4.1, rung 1).
  document.addEventListener("click", e => {
    const t = target(e);
    if (t?.hasAttribute("data-tip-live") && !touch.matches) requestAnimationFrame(() => { if (t.matches(":hover")) show(t); });
  });
  // The hand has moved on: a press, a scroll anywhere, a key other than Tab
  // (which is what brings the next one), and Esc above all.
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("keydown", e => { if (e.key !== "Tab" && e.key !== "Shift") hide(); }, true);
  addEventListener("blur", hide);
  // An answer anchored to the control takes its place: app.js marks the
  // control `.said` and calls `gone(control)` when a toast stands there.

  // Loaded by the rest that asked for it: that one waits its turn like any other.
  const now = [...document.querySelectorAll(":hover")].pop()?.closest("[data-tip]");
  // Its wait counts from the pointer's arrival, not from this load: the
  // fetch is inside the 450 ms, not added to them.
  if (now) soon(now, Math.max(0, FIRST_MS - (performance.now() - since)));
  const f = document.activeElement?.closest?.("[data-tip]");
  if (f && f.matches(":focus-visible")) { byKey = true; show(f); }
  return { hide, gone: t => { if (!t || t === el) hide(); } };
}
