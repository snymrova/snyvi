/* ui/fill.js: a page that fills the screen (#199).
 *
 * An HTML document is read as the page it was made to be (04-doc.js,
 * `applyPreview`), in a frame in the column, with the sidebars, the corner
 * and the page's own bar around it. A page made to be looked at -- a mockup,
 * a deck, a chart -- wants the whole screen, and until this only a diagram
 * could have it (ui/mmd.js, `mmdFull`).
 *
 * A chunk, fetched when a page is first shown as a page: no document of
 * prose ever pays for it, and by the time a hand reaches for the button or
 * the key it is here. It brings its own button, its look and its keys; first
 * paint carries one `chunk("fill")` and nothing else.
 *
 * The same bargain as the diagram's. The page is laid over everything from
 * where it is -- a fixed box, `fill` on `article.preview` -- and the
 * document, not the page, asks the engine for full screen, a courtesy that
 * hides the browser's own chrome where it is granted; nothing here depends
 * on the answer. Asked of the element itself, WebKitGTK, the engine of the
 * Linux window, drew every glyph inside it as nothing (mmd.js says how that
 * was found). The frame is never moved in the tree, so the page in it is not
 * loaded again and keeps where it was; its sandbox stays as it was made.
 */

const $ = s => document.querySelector(s);
const main = $("#main"), docEl = $("#doc");

/* The button sits in the page's bar where Save as PDF sits, and takes that
 * place only where Save as PDF is not shown anyway -- a page drawn in its
 * own frame -- so the bar has as many places on every page and nothing in it
 * moves from one page to the next. Over everything while it fills: the
 * sidebars, the corner, the bar. Its own way out is in its top corner, since
 * the bar it was pressed in is under it. */
const CSS = `
#chrome .over-f { display: none; flex: none; place-items: center; width: 22px; height: 22px; border-radius: var(--r-xs); color: var(--fg-3); transition: background var(--t), color var(--t); }
#chrome .over-f:hover { background: var(--rule-2); color: var(--fg); }
:root:has(#doc article.preview > iframe[sandbox]) #chrome .over-f { display: inline-grid; }
:root:has(#doc article.preview > iframe[sandbox]) #chrome .over-p { display: none; }
#doc article.preview.fill { position: fixed; inset: 0; z-index: var(--z-over); margin: 0; min-height: 0; background: var(--bg); }
#doc article.preview.fill iframe { border: 0; border-radius: 0; }
.fill-x { position: absolute; top: 12px; right: 12px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--r-xs); background: var(--bg-raise); color: var(--fg); box-shadow: var(--shadow-1); opacity: .7; transition: opacity var(--dur-move); }
.fill-x:hover, .fill-x:focus-visible { opacity: 1; }
`;
const ico = d => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const OUT = ico("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"), IN = ico("M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5");

{ const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); }

const btn = document.createElement("button");
btn.type = "button"; btn.className = "over-f"; btn.id = "btn-fill-top"; btn.innerHTML = OUT;
btn.dataset.tipSub = "the page, over everything; Esc gives it back"; btn.dataset.key = "f";
pressed(false);
$("#btn-pdf-top")?.after(btn);
btn.addEventListener("click", () => toggle());

/** A page shown as itself, and not a PDF: a PDF's frame has no sandbox, and
 *  its viewer has a full screen of its own. */
function page() {
  const a = docEl.querySelector("article.preview");
  return a?.querySelector(":scope > iframe[sandbox]") ? a : null;
}
const filled = () => docEl.querySelector("article.preview.fill");

/** The button says which way it goes, to the eye and to a screen reader. */
function pressed(on) {
  btn.setAttribute("aria-pressed", String(on));
  btn.dataset.tip = on ? "Exit full screen" : "Fill the screen";
  btn.ariaLabel = btn.dataset.tip;
}
/** The rest of the page while one fills it: not there for the keyboard or a
 *  screen reader either (docs/DESIGN.md §8, dialogs), as with a diagram. */
const around = on => { for (const s of ["#side", "#rail", "#chrome"]) { const el = $(s); if (el) el.inert = on; } };
const quiet = p => { if (p && p.catch) p.catch(() => {}); };   // a refusal is no news

let from = 0, opener = null, watch = null;   // where the column was, and who asked, to put both back

/** Fill the screen with the page on show, or give the column back. */
export function toggle() {
  const open = filled();
  if (open) return unfill(open);
  const a = page();
  if (!a) return;
  from = main.scrollTop;
  opener = document.activeElement;
  a.classList.add("fill");
  const x = document.createElement("button");
  x.type = "button"; x.className = "fill-x"; x.innerHTML = IN;
  x.dataset.tip = "Exit full screen"; x.dataset.key = "esc"; x.ariaLabel = "Exit full screen";
  x.addEventListener("click", () => unfill(a));
  a.append(x);
  around(true);
  pressed(true);
  // The focus goes with it, onto its way out: a key after this is the
  // page's, and Esc reaches this document rather than the frame's.
  x.focus({ preventScroll: true });
  // A new version arriving, or a move to another document, takes this
  // page away from under the fill; the rest of the page is given back too.
  watch = new MutationObserver(() => { if (!a.isConnected) unfill(a); });
  watch.observe(docEl, { childList: true, subtree: true });
  if (document.documentElement.requestFullscreen && !document.fullscreenElement) quiet(document.documentElement.requestFullscreen());
}

function unfill(a) {
  watch?.disconnect(); watch = null;
  a.classList.remove("fill");
  a.querySelector(".fill-x")?.remove();
  around(false);
  pressed(false);
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  opener = null;
  if (a.isConnected) main.scrollTo({ top: from, behavior: "instant" });
  if (document.fullscreenElement) quiet(document.exitFullscreen());
}

// The engine's own way out -- Escape, or whatever it binds -- ends the fill too.
document.addEventListener("fullscreenchange", () => {
  const a = filled();
  if (a && !document.fullscreenElement) unfill(a);
});

/* Esc, and `f` while the letter keys are awake, as `f` fills a diagram.
 * Taken before the page's own handler (09-answers.js), which would read an
 * Esc with nothing it knows over the page as "leave this document". An `f`
 * goes on to it as well: the diagram's half finds no diagram here and does
 * nothing, and the key pill still sees the key. */
addEventListener("keydown", e => {
  const open = filled();
  if (e.key === "Escape" && open) { e.preventDefault(); e.stopImmediatePropagation(); unfill(open); return; }
  if (e.key !== "f" || e.ctrlKey || e.metaKey || e.altKey || !document.body.classList.contains("keys")) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest?.(".pn")) return;
  if (open || page()) { e.preventDefault(); toggle(); }
}, true);
