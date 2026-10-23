/* Copy all (#165) and Save as PDF (#182): the page, to take somewhere else.
 *
 * A chunk since 1.44, so first paint does not carry it (bench/bytes.mjs).
 * The page fetches it once it is idle, as it fetches nav.js: by the time a
 * hand reaches the button beside Width, or presses y, it is here, and the
 * click reaches the clipboard with nothing awaited before it, which WebKit
 * asks. A click before it came waits for it, and WebKit may refuse that one.
 *
 * Two kinds at once, and what it is pasted into takes the one it reads: the
 * source as it was sent (its raw route, the same bytes Open source shows)
 * for an agent, a terminal, GitHub; and, for Markdown, the page as drawn,
 * for a mail or a document. The source is fetched inside the click's
 * ClipboardItem, as a promise: WebKit forgets the click once a fetch has
 * been awaited, and writeText after it is refused there.
 */

const NO_TEXT = /^(image|video|audio|binary)$/;
let c = null;

export function init(ctx) { c = ctx; return { copyAll, printDoc }; }

/* Save as PDF (#182): the page as it reads, through the system's print
 * dialog, which is where every desktop keeps Save as PDF (macOS), Print to
 * File (GTK) and Microsoft Print to PDF. No PDF is made here and nothing
 * leaves the page; the file is named by the dialog from the page's title,
 * which is the document's already.
 *
 * Only the article goes to paper: the sheet keeps #doc and drops every
 * sibling on the way down to it, rather than naming the chrome, so a part
 * added to the page later is out of the print without anyone remembering
 * this sheet (1.8's named eleven, and missed every part since). The header
 * keeps its title only where the article does not open with one of its own.
 * #main scrolls inside a grid of the window's height; printed so, the PDF
 * would be one screen. The 1.8 rules were in look.js, which is idle-loaded
 * as this is, and Ctrl+P in a browser before then prints the page whole. */
const CSS = `
@media print {
  @page { margin: 16mm; }
  body > :not(#app), #app > :not(#main), #main > :not(#doc) { display: none !important; }
  html, body, #app, #main { display: block !important; height: auto !important; overflow: visible !important; }
  #doc { max-width: none !important; margin: 0 !important; padding: 0 !important; animation: none !important; }
  #doc > :not(.doc-head, article), #doc .doc-sub, #doc:has(> article > h1:first-child) .doc-head { display: none !important; }
  #doc article :is(button, .copy, .mmd-why) { display: none !important; }
  .prose { font-size: 11pt; line-height: 1.5; }
  .prose a { color: inherit; text-decoration: underline; }
  :is(h1, h2, h3, h4) { break-after: avoid; }
  #doc article :is(figure, img, blockquote, .mmd, tr) { break-inside: avoid; }
  #doc pre, #doc pre * { white-space: pre-wrap !important; overflow-wrap: anywhere; }
  #doc pre { overflow: visible !important; max-height: none !important; }
  #doc pre code { min-width: 0 !important; }
  #doc .mmd { margin-inline: 0 !important; }
  #doc .mmd-frame { display: flex !important; justify-content: center; height: auto !important; max-height: none !important; overflow: visible !important; }
  #doc .mmd svg { max-width: 100% !important; }
}
`;
{ const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); }

/** Print the page open now. Paper first, whatever the theme: a diagram is
 *  drawn in the theme's own colours (mmd.js), and an Ink one is pale ink on
 *  white paper. Then every diagram drawn and every picture in, since both
 *  wait to come near the screen and a long page printed from its top would
 *  be holes. The theme goes back when the dialog does: `afterprint`, or,
 *  where the dialog is a sheet that leaves the page running (macOS, through
 *  Tauri's own `window.print`), the reader's first move once it is gone. */
let printing = false;
export async function printDoc() {
  const art = document.querySelector("#doc article");
  const btn = document.querySelector("#btn-pdf-top");
  if (printing || !art || !btn || getComputedStyle(btn).visibility !== "visible") return;
  printing = true;
  const root = document.documentElement, was = root.dataset.theme, mmd = c.mmd?.();
  const swap = was !== "paper";
  if (swap) { root.dataset.theme = "paper"; mmd?.retheme(); }
  let figs = [];
  const done = () => {
    if (!printing) return;
    printing = false;
    for (const t of ["afterprint", "pointermove", "keydown"]) removeEventListener(t, done, true);
    for (const [svg, box, style] of figs) { svg.setAttribute("viewBox", box); style == null ? svg.removeAttribute("style") : svg.setAttribute("style", style); }
    if (swap) { snyviTheme.apply(); mmd?.retheme(); }
  };
  try {
    const imgs = [...art.querySelectorAll("img")];
    for (const i of imgs) i.loading = "eager";
    const wait = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
    await wait(Promise.all([mmd?.drawAll(), ...imgs.map(i => i.decode().catch(() => {}))]), 20000);
    // A diagram on screen is a view into a frame: zoomed to fit its height,
    // and a wide one hung past the column. On paper it is the drawing at its
    // own size, as wide as the page at most (mmd.js keeps that box).
    figs = [...art.querySelectorAll(".mmd svg[data-mmd-base]")].map(svg => [svg, svg.getAttribute("viewBox"), svg.getAttribute("style")]);
    for (const [svg] of figs) {
      const [, , w, h] = svg.dataset.mmdBase.split(" ").map(Number);
      svg.setAttribute("viewBox", svg.dataset.mmdBase);
      svg.style.cssText = `max-width: 100%; width: ${w}px; height: auto; aspect-ratio: ${w} / ${h};`;
    }
    addEventListener("afterprint", done, true);
    await window.print();
    // A dialog that held the page has closed by now, and `afterprint` came
    // first. One that did not hold it has the reader's next move.
    setTimeout(() => { if (printing) for (const t of ["pointermove", "keydown"]) addEventListener(t, done, true); }, 300);
  } catch (e) { done(); c.toast("Could not open the print dialog", { sub: e }); }
}

export async function copyAll(btn) {
  const { state, rawUrl, toast, keyHint } = c, $ = s => document.querySelector(s);
  const file = state.view === "browse" && state.browseRoot && state.browsePath;
  const url = file ? rawUrl(state.browseRoot.id, state.browsePath) : state.view === "doc" && state.doc ? `/api/docs/${state.doc.id}/raw` : "";
  const kind = file ? ($("#doc article")?.className.match(/kind-(\w+)/) || [])[1] : state.doc?.kind;
  if (!url || NO_TEXT.test(kind || "") || btn?.dataset.copied) return;
  const said = file ? state.browsePath.split("/").pop() : state.doc.title;
  const text = fetch(url).then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)));
  const art = $("#doc article.kind-markdown");
  let html = "";
  if (art) {
    // The page as drawn, less what is only the page's: its buttons.
    const cl = art.cloneNode(true);
    cl.querySelectorAll("button, .copy").forEach(x => x.remove());
    html = cl.innerHTML;
  }
  try {
    if (!window.ClipboardItem) throw 0;
    const item = { "text/plain": text.then(t => new Blob([t], { type: "text/plain" })) };
    if (html) item["text/html"] = new Blob([html], { type: "text/html" });
    await navigator.clipboard.write([new ClipboardItem(item)]);
  } catch {
    // No ClipboardItem, or the formatted kind refused: the source alone.
    try { await navigator.clipboard.writeText(await text); }
    catch { return toast("Could not copy", { sub: `select and press ${keyHint("mod+c")}`, at: btn }); }
  }
  if (!btn?.isConnected || btn.offsetParent === null) return toast("Copied", { sub: said });
  btn.dataset.copied = 1; btn.classList.add("did");
  setTimeout(() => { delete btn.dataset.copied; btn.classList.remove("did"); }, 1200);
}
