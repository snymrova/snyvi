/* snyvi's answer, drawn (docs/DESIGN.md §4): the one toast at a time,
 * placed beside what the reader did, with its face, its button and its
 * clock. A chunk since 1.8: a page that is only read says nothing, so first
 * paint no longer carries how it would. app.js keeps `toast()` as a stub
 * that takes where the reader acted at the moment they act and hands it
 * here, and `hush()`, which asks this. */

const CSS = `
#toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; z-index: var(--z-toast);
  align-items: flex-end; pointer-events: none; }
#toasts[data-side="right"], #toasts[data-side="below"] { align-items: flex-start; }
.toast { pointer-events: auto; position: relative;
  background: var(--bg-raise); color: var(--fg); border: 1px solid var(--rule); border-radius: var(--r-md);
  box-shadow: var(--shadow); padding: 6px 12px 6px 7px; font-size: var(--fs-small); line-height: 1.3;
  display: flex; align-items: center; gap: 8px; cursor: pointer; max-width: 288px;
  animation: toast-in var(--dur-move) var(--ease-out); transform-origin: var(--from, 50% 100%); }
.toast.out { opacity: 0; transform: scale(.97); transition: opacity var(--dur-quick) var(--ease-in), transform var(--dur-quick) var(--ease-in); }
@keyframes toast-in { from { opacity: 0; transform: translate(var(--dx, 0), var(--dy, 8px)) scale(.92); } to { opacity: 1; transform: none; } }
#toasts[data-side="right"] .toast { --dx: -12px; --dy: 0; --from: 0 50%; }
#toasts[data-side="left"]  .toast { --dx: 12px;  --dy: 0; --from: 100% 50%; }
#toasts[data-side="below"] .toast { --dx: 0; --dy: -10px; --from: 22px 0; }
#toasts[data-side] .toast::before { content: ""; position: absolute; width: 8px; height: 8px;
  background: var(--bg-raise); border: 1px solid var(--rule); transform: rotate(45deg); }
#toasts[data-side="right"] .toast::before { left: -5px; top: var(--tail, 13px); border-top: 0; border-right: 0; }
#toasts[data-side="left"]  .toast::before { right: -5px; top: var(--tail, 13px); border-bottom: 0; border-left: 0; }
#toasts[data-side="below"] .toast::before { top: -5px; left: var(--tail-x, 16px); border-bottom: 0; border-right: 0; }
.toast .say { min-width: 0; }
.toast .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast.go { cursor: pointer; }
.toast.go:hover .t { text-decoration: underline; }
.toast .s { color: var(--fg-3); font-size: var(--fs-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The one thing an answer offers that has to be reached on purpose. */
.toast .act { font: inherit; font-size: var(--fs-small); font-weight: 500; color: var(--accent); background: transparent; border: 1px solid var(--rule-2); border-radius: var(--r-sm); padding: 3px 9px; margin-left: 4px; cursor: pointer; flex: none; }
.toast .act:hover { background: var(--bg-side); }
.toast .act:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
/* An error has no face and no timer: it stays until its ✕. */
.toast[role=alert] { padding-left: 12px; cursor: auto; }
.toast .tx { border: 0; color: var(--fg-3); padding: 3px 4px; margin-left: 0; }
.toast .who { width: 22px; height: 22px; flex: none; display: block; }
#toasts[data-side="right"] .toast .who { transform: rotate(-7deg); }
#toasts[data-side="left"] .toast .who { transform: rotate(7deg); }
`;

let c = null, toastsEl = null;
const esc = s => c.esc(s), glyph = n => c.glyph(n), mascotHead = f => c.mascotHead(f), quiet = () => c.quiet(), sayErr = e => c.sayErr(e), rectOf = a => c.rectOf(a);

export function init(ctx) {
  c = ctx; toastsEl = ctx.toastsEl;
  document.head.append(Object.assign(document.createElement("style"), { id: "toast-drawn", textContent: CSS }));
  addEventListener("resize", followAnchor);
  addEventListener("scroll", followAnchor, true);
  return { say, hush };
}

let toastAt = null;   // what the stack is currently pointing at
/** Put the stack beside `at`, on the side with room for it. A control in
 *  the left rail answers to its right, one in the contents rail to its
 *  left, and anything in the middle of the page answers just below itself,
 *  which is the way the eye is already travelling after a click. */
function placeToasts(at) {
  const s = toastsEl.style, gap = 12, r = rectOf(at);
  // A control that is not on screen -- the sidebar folded away, the button
  // scrolled past -- is no better an address than the corner.
  const shown = r && r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth && (r.width || !(at instanceof Element));
  toastAt = shown ? at : null;
  s.cssText = "";
  if (!shown) return void delete toastsEl.dataset.side;
  // Measured, not assumed: the box is as wide as what it says, up to its cap.
  const box = toastsEl.offsetWidth, h = toastsEl.offsetHeight, cy = r.top + r.height / 2;
  const side = r.right + gap + box < innerWidth - 12 && r.left < innerWidth * 0.55 ? "right"
    : r.left - gap - box > 12 ? "left" : "below";
  s.right = s.left = s.bottom = "auto";
  if (side === "right") s.left = Math.round(r.right + gap) + "px";
  else if (side === "left") s.right = Math.round(innerWidth - r.left + gap) + "px";
  else {
    const left = Math.round(Math.max(12, Math.min(r.left, innerWidth - box - 12)));
    s.left = left + "px";
    // The tail points at the control's middle, wherever the box was nudged.
    s.setProperty("--tail-x", Math.round(Math.max(10, Math.min(r.left + r.width / 2 - left - 4, box - 18))) + "px");
  }
  // Centred on the thing it answers, or under it, by its own height; moved
  // only as far as it takes to stay on the window, the tail still on it.
  const top = Math.round(Math.max(4, Math.min(side === "below" ? r.bottom + gap : cy - h / 2, innerHeight - h - 4)));
  s.top = top + "px";
  s.setProperty("--tail", Math.round(Math.max(8, Math.min(cy - top - 4, h - 16))) + "px");
  toastsEl.dataset.side = side;
}
/* A control names itself on hover in its tip, often in the very spot its
 * answer comes up in. While the answer is up it is the better label of the
 * two, so the tip gives way (tip.js). */
const saidBy = el => { if (el?.classList) { el.classList.add("said"); c.tipGone(el); } };

// The window moving underneath takes the anchor with it.
let replaceFrame = 0;
const followAnchor = () => {
  if (!toastAt || !said) return;
  cancelAnimationFrame(replaceFrame);
  replaceFrame = requestAnimationFrame(() => { if (toastAt && said) placeToasts(toastAt); });
};

/* There is one of these at a time. Two of them is a pile of receipts, and
 * a pile is read as a list -- which is the one thing this is not: it is a
 * creature answering, and a creature says the next thing instead of the
 * last one, in the place the next thing was asked. So a new answer takes
 * the old one's place, wherever that was, and the old one is simply gone.
 * Clicking the accent eight times running is eight bobs of the same head
 * in eight colours, which is the setting itself, said. */
let said = null, held = null;
/** Clear whatever is being said now, without ceremony. */
function hush() {
  if (!said) return;
  clearTimeout(said.timer);
  said.el.remove();
  said.anchor?.classList?.remove("said");
  said = null;
}
/** The answer has gone: the news it held back can be said now. */
function unsay() {
  hush(); placeToasts(null);
  const h = held; held = null;
  if (h) say(h[0], h[1], null);
}

/** snyvi's answer (docs/DESIGN.md §4): toast(title, { sub, at, kind,
 *  action, retry, face, life, go }).
 *  - `sub`: the line under it. An error object is said through sayErr.
 *  - `at`: an Element, a DOMRect or a point {x, y} to answer beside, or
 *    `null` for the corner. Left out, it is where the reader last acted.
 *  - `kind`: "answer", the default; "error", which a "Could not…" title is
 *    on its own -- it stays until its ✕, with `retry` as its button;
 *    "undo", an offer, which `action` makes on its own; "news", from the
 *    background, which goes to the corner and never takes the place of an
 *    error or an offer still standing: it waits for them to go.
 *  - `action` ({label, run}) is a button in it; `go` makes it one.
 *  - `face`: the mascot's, from the kind unless given; `null` for none. It
 *    is never read off the title's words. */
function say(title, o, acted) {
  let { sub, action, face } = o, raw = "";
  if (sub && typeof sub === "object") ({ why: sub, raw } = sayErr(sub));
  const kind = o.kind || (/^Could not /.test(title) ? "error" : o.at === null ? "news" : action ? "undo" : "answer");
  const err = kind === "error", news = kind === "news";
  if (news && said?.keep) return void (held = [title, o]);
  const at = news ? null : acted;
  hush();
  if (o.retry) action = { label: "Retry", run: o.retry };
  if (!("face" in o)) face = err ? null : news ? "whoa" : "rest";
  if (face && quiet()) face = "rest";
  // One expressive face at a time: while this one speaks, the bar's rests.
  if (face && face !== "rest") c.rest();
  const el = document.createElement("div");
  el.className = "toast";
  if (err) el.setAttribute("role", "alert");
  // The words snyvi or the browser really used, for whoever needs them.
  if (raw) { el.dataset.tip = "What it said"; el.dataset.tipSub = raw; }
  if (face) el.dataset.feel = face;
  el.innerHTML = (face ? `<span class="who">${mascotHead(face)}</span>` : "") +
    `<span class="say"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "act"; b.textContent = action.label;
    b.addEventListener("click", ev => { ev.stopPropagation(); unsay(); action.run(); });
    el.appendChild(b);
  }
  // `go` is the whole toast, beside a button or without one: news about a
  // document is a way to it (#66).
  if (o.go || (!action && !err)) el.addEventListener("click", () => { hush(); o.go?.(); });
  if (o.go) el.classList.add("go");
  if (err) {
    const x = document.createElement("button");
    x.type = "button"; x.className = "act tx"; x.innerHTML = glyph("x"); x.ariaLabel = "Dismiss";
    x.onclick = unsay;
    el.appendChild(x);
  }
  toastsEl.appendChild(el);
  // Placed once it is in, so it is placed by the size it really has.
  placeToasts(at);
  const anchor = toastAt;
  saidBy(anchor);
  const life = o.life || (action ? c.UNDO_MS : o.go ? 8000 : 3500);
  // It fades where it stands, and only if it is still the one being said.
  const mine = { el, anchor, timer: 0, keep: err || !!action };
  if (!err) mine.timer = setTimeout(() => {
    el.classList.add("out");
    mine.timer = setTimeout(() => { if (said === mine) unsay(); }, 180);
  }, life);
  said = mine;
  return el;
}
