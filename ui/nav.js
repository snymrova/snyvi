/* Back and forward: what each step was, said where it is asked.
 *
 * The page keeps the steps themselves (ui/app/07-nav.js): the step `n` on
 * each history entry, the highest one, the buttons' ends and their clicks.
 * This is what can wait for the page to be idle: what each step is called
 * and when it was (`places`, in sessionStorage so a reload keeps them), the
 * buttons' tips ("Back to design-notes.md"), the list a right-click or a
 * long press opens, and a link to a heading, which is the browser's own
 * push and comes with no step.
 */

let c = null;
let places = {};

const save = () => { try { sessionStorage.setItem("snyvi.nav.places", JSON.stringify(places)); } catch {} };

/** What the step on screen is called: a desk is its panels. */
function name() {
  const p = location.pathname;
  if (p === "/") return "Home";
  if (p === "/inbox") return "Inbox";
  if (p === "/desks") return "Desks";
  const t = document.title.replace(/ · snyvi$/, "");
  return p.startsWith("/desk/") ? t.replace(/ · desk$/, " · panels") : t;
}

/** The step on screen, written down; then each button's tip names where it goes. */
function step() {
  const n = c.stepAt(), top = c.top(), was = places[n], t = name();
  places[n] = { t, at: was && was.t === t ? was.at : Math.floor(Date.now() / 1000) };
  for (const k in places) if (+k > top || +k < n - 60) delete places[k];
  save();
  for (const b of document.querySelectorAll(".nv-b")) {
    const back = b.dataset.step === "-1", on = back ? n > 0 : n < top, to = places[n + (back ? -1 : 1)];
    const tip = on && to ? `${back ? "Back" : "Forward"} to ${to.t}` : back ? "Back" : "Forward";
    b.dataset.tip = tip; b.dataset.tipSub = "hold or right-click: where you have been"; b.setAttribute("aria-label", tip);
  }
}

/** The last places, newest first, for the menu: one row for steps in a row
 *  on the same page (a heading jump is its document's), the one on screen
 *  marked. */
function list() {
  const n = c.stepAt(), rows = [];
  for (let k = c.top(); k >= 0 && rows.length < 10; k--) {
    const p = places[k];
    if (!p) continue;
    const last = rows[rows.length - 1];
    // The row the reader is on already goes nowhere, whichever of its steps is k.
    if (last && last.label === p.t) { if (k === n) { last.hint = "here"; last.run = () => {}; } continue; }
    rows.push({ label: p.t, hint: k === n ? "here" : c.relShort(p.at), run: k === n ? () => {} : () => { const d = k - c.stepAt(); if (d) history.go(d); } });
  }
  return rows;
}

export function init(ctx) {
  c = ctx;
  try { if (history.state && history.state.n != null) places = JSON.parse(sessionStorage.getItem("snyvi.nav.places")) || {}; } catch {}
  // A title set after the push -- a document arrives a moment after its
  // step -- names the step again.
  new MutationObserver(step).observe(document.querySelector("title"), { childList: true, characterData: true, subtree: true });
  // A link to a heading is the browser's own push, with no step: given the
  // next one, as the same page.
  let cur = c.stepAt();
  addEventListener("hashchange", () => {
    if (history.state && history.state.n != null) { cur = c.stepAt(); return; }
    const n = cur + 1;
    c.rep0({ ...history.state, n }, "", location.href);
    for (const k in places) if (+k > n) delete places[k];
    places[n] = places[cur];
    cur = n;
    c.setTop(n);
  });
  addEventListener("popstate", () => { if (history.state && history.state.n != null) cur = c.stepAt(); });
  // A long press is the right-click a touchpad or a pen does not have.
  // The release that ends the press is not also a step: the click that
  // follows it is eaten, and only that one -- the next press clears it,
  // wherever the release landed.
  let hold = 0, held = false;
  document.addEventListener("click", ev => { if (held && ev.target.closest(".nv-b")) { held = false; ev.stopImmediatePropagation(); } }, true);
  document.addEventListener("pointerdown", e => {
    held = false;
    const b = e.button === 0 && e.target.closest(".nv-b");
    if (!b) return;
    hold = setTimeout(() => {
      hold = 0; held = true;
      const r = b.getBoundingClientRect();
      c.menuFor(b, r.left, r.bottom + 4);
    }, 500);
  });
  const off = () => { clearTimeout(hold); hold = 0; };
  document.addEventListener("pointerup", off, true);
  document.addEventListener("pointercancel", off, true);
  // Off the button, not off the arrow inside it.
  document.addEventListener("pointerout", e => { const b = e.target.closest?.(".nv-b"); if (b && !b.contains(e.relatedTarget)) off(); }, true);
  step();
  return {
    step: () => { cur = c.stepAt(); step(); },
    list,
  };
}
