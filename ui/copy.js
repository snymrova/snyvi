/* Copy all (#165), Save as PDF (#182) and Download (#183): the page, to
 * take somewhere else.
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
const $ = s => document.querySelector(s);

export function init(ctx) {
  if (!c) { c = ctx; downloads(); asMarkdown(); sections(); }
  return { copyAll, printDoc };
}

/* Download (#183): a picture, a film, a song, a PDF -- the file itself, into
 * the reader's Downloads. Before this the window had no way to keep one: it
 * turns the engine's right-click menu off, and WebKit's film controls have
 * no Download. Each way in is a link with `download` on it, to the bytes the
 * page already shows: the browser's own downloads take it in a tab, and in
 * the window src/bin/app.rs puts it in Downloads and says where it went
 * (`snyvi-downloaded`), which is said here, beside the press.
 *
 *  - A media page: a button in the bar, in Copy all's box, which such a page
 *    keeps empty (app.css), so the bar does not move between a page of text
 *    and a film. `d` from the letter keys presses it (keys.js).
 *  - A picture or a film inside a document: a ↓ over its corner while the
 *    pointer is on it, one button laid over the page, so nothing moves. A
 *    song before Play has it at the pill's empty end; once playing, the pill
 *    has its own (player.js).
 *
 * All of it is here, not in first paint: the page is idle long before a
 * hand reaches any of it. */
const DL = /^(image|video|audio|binary)$/;
const GLYPH = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5v9.5M5.5 8.5 10 13l4.5-4.5M4 16.5h12"/></svg>';
const DL_CSS = `
#chrome .over-d { display: none; flex: none; place-items: center; width: 22px; height: 22px; border-radius: var(--r-xs); color: var(--fg-3); transition: background var(--t), color var(--t); }
#chrome .over-d:hover { background: var(--rule-2); color: var(--fg); }
#chrome .over.dl .over-c { display: none; }
#chrome .over.dl .over-d { display: inline-grid; }
.dl-fl { position: fixed; z-index: var(--z-sticky); display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--r-xs); background: var(--bg-raise); color: var(--fg); box-shadow: var(--shadow-1); opacity: 0; pointer-events: none; transition: opacity var(--dur-move); }
.dl-fl.on { opacity: .92; pointer-events: auto; }
.dl-fl:hover, .dl-fl[data-said] { opacity: 1; }
.dl-fl[data-said] { color: var(--accent); }
`;
const OK = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';

/** The press was heard, on the thing pressed: a ✓ in its place for a
 *  moment, as the heading's `#` says Copied (06-rail.js). */
function heard(el, glyph) {
  el.dataset.said = 1; el.innerHTML = OK;
  clearTimeout(el._said);
  el._said = setTimeout(() => { delete el.dataset.said; el.innerHTML = glyph; }, 1200);
}

/** A path under the home folder as `~/…`, as the rest of the page says it. */
function tilde(p) {
  const home = (c.state.desks?.home || "").replace(/[\\/]+$/, "");
  return home && p.startsWith(home) && /^[\\/]/.test(p.slice(home.length)) ? "~" + p.slice(home.length) : p;
}

/** What the page open now downloads as, or null when it is not a file to
 *  keep: a page of text has Copy all, and a page still coming has nothing. */
function target() {
  const { state, rawUrl } = c, art = $("#doc article");
  if (!art || art.classList.contains("sk-body")) return null;
  const file = state.view === "browse" && state.browseRoot && state.browsePath;
  if (file) {
    const kind = (art.className.match(/kind-(\w+)/) || [])[1], name = state.browsePath.split("/").pop();
    return DL.test(kind || "") || /\.pdf$/i.test(name) ? { url: rawUrl(state.browseRoot.id, state.browsePath), name } : null;
  }
  const d = state.view === "doc" && state.doc;
  if (!d || !DL.test(d.kind)) return null;
  // The file's own name, as it was sent; one sent as content has its title.
  const base = (d.source_path || "").split(/[\\/]/).pop();
  return { url: `/api/docs/${d.id}/blob`, name: base || (d.lang ? `${d.title}.${d.lang}` : d.title) };
}

/** Where a picture, a film or a song in a document is served from, when it
 *  is this daemon's: a picture from the web is the web's to keep. A song or
 *  a film not yet pressed has its player waiting in the template after it. */
function srcOf(m) {
  const s = m.localName === "button" ? m.nextElementSibling?.content?.firstElementChild?.getAttribute("src") : m.currentSrc || m.getAttribute("src");
  if (!s) return "";
  try { const u = new URL(s, location.href); return u.origin === location.origin ? u.href : ""; } catch { return ""; }
}

let asked = null;
function downloads() {
  { const s = document.createElement("style"); s.textContent = DL_CSS; document.head.append(s); }
  const docEl = $("#doc"), over = $("#chrome .over");
  const bar = document.createElement("a");
  bar.className = "over-d"; bar.id = "btn-dl-top"; bar.innerHTML = GLYPH;
  bar.dataset.tip = "Download"; bar.dataset.tipSub = "the file, into your Downloads"; bar.dataset.key = "d";
  bar.setAttribute("aria-label", "Download");
  $("#btn-copy-top")?.after(bar);
  const sync = () => {
    const t = target();
    over?.classList.toggle("dl", !!t);
    if (t) { bar.href = t.url; bar.download = t.name; } else bar.removeAttribute("href");
  };
  bar.addEventListener("click", e => {
    const t = target();
    if (!t) return e.preventDefault();
    bar.href = t.url; bar.download = t.name; asked = { name: t.name, at: bar };
    heard(bar, GLYPH);
  });

  const fl = document.createElement("a");
  fl.className = "dl-fl"; fl.tabIndex = -1; fl.innerHTML = GLYPH;
  fl.dataset.tip = "Download"; fl.setAttribute("aria-label", "Download");
  document.body.append(fl);
  let on = null;
  const off = () => { on = null; fl.classList.remove("on"); };
  docEl.addEventListener("pointerover", e => {
    const m = e.target.closest?.("article.kind-markdown :is(img, video, .doc-play)");
    if (!m || m === on) return;
    const src = srcOf(m), r = m.getBoundingClientRect();
    // A badge or an icon in the prose is not a file anyone is after.
    if (!src || r.width < 64 || r.height < 40) return off();
    on = m;
    fl.href = src; fl.download = decodeURIComponent(new URL(src).pathname.split("/").pop());
    const song = m.localName === "button" && r.height < 80, head = $("#chrome")?.getBoundingClientRect().bottom || 0;
    fl.style.top = `${song ? r.top + (r.height - 28) / 2 : Math.max(r.top, head) + 8}px`;
    fl.style.left = `${r.right - (song ? 14 : 8) - 28}px`;
    fl.classList.add("on");
  });
  docEl.addEventListener("pointerout", e => { if (on && !on.contains(e.relatedTarget) && !fl.contains(e.relatedTarget)) off(); });
  fl.addEventListener("pointerleave", e => { if (!on?.contains(e.relatedTarget)) off(); });
  // #195: the answer is where the press was. It used to hide the ↓ and say
  // "Downloaded" beside the picture's middle -- for a tall one, the window's
  // far corner, where nobody was looking. Now the ↓ stays and turns to a ✓,
  // and the word comes beside the place it stood, kept as a rect: the ↓ may
  // be gone by the time the file is.
  fl.addEventListener("click", () => { asked = { name: fl.download, at: fl.getBoundingClientRect() }; heard(fl, GLYPH); });
  // Any other ↓ -- a song's pill (player.js) -- is answered beside itself
  // too. Capture, so the ones above, which say more, still have the last word.
  addEventListener("click", e => {
    const a = e.target.closest?.("a[download]");
    if (a && a !== fl && a !== bar) asked = { name: a.download, at: a.getBoundingClientRect() };
  }, true);
  // A press puts a player where its button was, and a song's pill has its
  // own ↓ from then on.
  docEl.addEventListener("click", e => { if (e.target.closest(".doc-play")) off(); });
  $("#main")?.addEventListener("scroll", off, { passive: true });
  new MutationObserver(() => { off(); sync(); }).observe(docEl, { childList: true });
  sync();

  // The window's word on where it went (src/bin/app.rs). A tab never hears
  // this: the browser shows its own downloads.
  addEventListener("snyvi-downloaded", e => {
    const { ok, path } = e.detail || {}, name = path ? path.split(/[\\/]/).pop() : asked?.name || "";
    const a = asked?.at, at = a instanceof Element ? (a.isConnected ? a : null) : a || null;
    asked = null;
    if (ok) c.toast("Downloaded", { sub: path ? tilde(path) : name, at });
    else c.toast("Could not download", { sub: name, at });
  });
}

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
  const { state, rawUrl, toast, keyHint } = c;
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

/* Copy keeps the Markdown (#194). A selection that crosses blocks in a
 * Markdown page used to reach the clipboard as the engine reads the page:
 * no `-` before a list's lines, no `##` before a heading, a table as tabs
 * in the CSS's capitals, code with its fence gone. Pasted into Claude, a
 * terminal or GitHub, the shape was lost. Now the plain kind is the
 * selection written back as Markdown, and the rich kind is still the page as
 * drawn, for a mail or a document. A phrase inside one block is left to the
 * engine: it is only words, and the engine's are right.
 *
 * Written back from the page, not cut from the source: a selection is a
 * range of the drawn page, and only the page knows where it starts. */
const BLOCK = /^(p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|pre|blockquote|hr|figure|section|div|details|video|audio)$/;
const NOT_TEXT = "button:not(.doc-play), .copy, .mmd-tools, .mmd-why, .mmd-ask, a.anchor, .footnote-backref, template, svg, input, script, style";
const isBlock = n => n.nodeType === 1 && BLOCK.test(n.localName);

/** A file this daemon serves for a document by the name it was written
 *  with: `/files/<doc>/pic.png` is `pic.png` in the Markdown. */
function local(src) {
  if (!src) return "";
  let p = src;
  try { const u = new URL(src, location.href); if (u.origin === location.origin) p = u.pathname; } catch {}
  const m = /^\/files\/[^/]+\/(.+)$/.exec(p);
  return m ? decodeURIComponent(m[1]) : src;
}

/** `**`, `*`, `~~` round words, outside the spaces at their ends, which
 *  Markdown will not take inside them. */
function wrap(mark, s) {
  const [, a, b, z] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return b ? a + mark + b + mark + z : s;
}
function tick(s) {
  const n = Math.max(0, ...(s.match(/`+/g) || []).map(r => r.length)) + 1, f = "`".repeat(n);
  return /^`|`$/.test(s) ? `${f} ${s} ${f}` : f + s + f;
}

function inline(nodes) {
  let s = "";
  for (const k of nodes) {
    if (k.nodeType === 3) { s += k.data.replace(/\s+/g, " "); continue; }
    if (k.nodeType !== 1) continue;
    if (k.matches(".doc-play, video, audio")) { const src = srcOf(k); if (src) s += `![](${local(src)})`; continue; }
    if (k.matches(NOT_TEXT)) continue;
    const t = k.localName, inner = () => inline(k.childNodes);
    if (t === "strong" || t === "b") s += wrap("**", inner());
    else if (t === "em" || t === "i") s += wrap("*", inner());
    else if (t === "del" || t === "s") s += wrap("~~", inner());
    else if (t === "code") s += tick(k.textContent);
    else if (t === "br") s += "  \n";
    else if (t === "img") s += `![${k.getAttribute("alt") || ""}](${local(k.getAttribute("src"))})`;
    else if (t === "a") {
      const href = k.getAttribute("href") || "", x = inner();
      s += k.hasAttribute("data-footnote-ref") ? `[^${x}]` : href && !href.startsWith("#") && x.trim() ? `[${x}](${href})` : x;
    } else s += inner();
  }
  return s;
}

/** A code block with its fence, and the language the renderer named it by:
 *  `data-lang` is the highlighter's name for it, "Rust" or "Bourne Again
 *  Shell (bash)", of which the fence wants the short one. */
function fence(pre) {
  if (pre.matches(".mermaid")) return "```mermaid\n" + pre.textContent.replace(/\n$/, "") + "\n```";
  const lines = [...pre.querySelectorAll(".ln")];
  const code = (lines.length ? lines.map(l => l.textContent).join("\n") : pre.querySelector("code")?.textContent || "").replace(/\n$/, "");
  const name = pre.dataset.lang || "", lang = /\(([^)]+)\)/.exec(name)?.[1] || (/^(text|plain text)$/i.test(name) ? "" : name.toLowerCase().replace(/\s+/g, ""));
  const f = "`".repeat(Math.max(3, ...(code.match(/`{3,}/g) || []).map(r => r.length + 1)));
  return `${f}${lang}\n${code}\n${f}`;
}

function table(t) {
  const rows = t.localName === "tr" ? [t] : [...t.querySelectorAll("tr")];
  if (!rows.length) return "";
  const cell = c => inline(c.childNodes).trim().replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  const row = r => `| ${[...r.children].map(cell).join(" | ")} |`;
  const rule = [...rows[0].children].map(c => ({ left: ":--", right: "--:", center: ":-:" })[c.getAttribute("align")] || "---");
  return [row(rows[0]), `| ${rule.join(" | ")} |`, ...rows.slice(1).map(row)].join("\n");
}

/** A list's items, each under its mark, what is inside it indented under
 *  the mark's width so a nested list stays nested. A tight list -- no
 *  paragraphs in its items -- stays tight. */
function list(l) {
  const ol = l.localName === "ol";
  let i = +(l.getAttribute("start") || 1);
  return [...l.children].filter(li => li.localName === "li").map(li => item(li, ol ? `${i++}. ` : "- ")).join("\n");
}
function item(li, mark) {
  const box = li.querySelector(":scope > input[type=checkbox]");
  const head = mark + (box ? (box.hasAttribute("checked") ? "[x] " : "[ ] ") : "");
  const pad = " ".repeat(head.length);
  return md(li, li.querySelector(":scope > p") ? "\n\n" : "\n").split("\n").map((l, j) => j ? (l && pad + l) : head + l).join("\n");
}

function block(k) {
  const t = k.localName;
  if (/^h[1-6]$/.test(t)) return `${"#".repeat(+t[1])} ${inline(k.childNodes).trim()}`;
  if (t === "p") return tidy(inline(k.childNodes));
  if (t === "hr") return "---";
  if (t === "pre") return fence(k);
  if (t === "figure" && k.dataset.src) return "```mermaid\n" + k.dataset.src + "\n```";
  if (t === "ul" || t === "ol") return list(k);
  if (t === "li") return item(k, "- ");
  if (t === "blockquote") return md(k).split("\n").map(l => l ? `> ${l}` : ">").join("\n");
  if (/^(table|thead|tbody|tfoot|tr)$/.test(t)) return table(k);
  if (t === "section" && k.matches(".footnotes")) return [...k.querySelectorAll("li[id]")].map(li => `[^${li.id.replace(/^fn-/, "")}]: ${md(li).trim()}`).join("\n");
  if (t === "video" || t === "audio") return inline([k]);
  return md(k);
}
const tidy = s => s.replace(/[ \t]*\n[ \t]*/g, m => (/^  \n/.test(m) ? "  \n" : "\n")).trim();

/** A node's children as Markdown: its blocks one after another with a
 *  blank line between, and the words between them as a paragraph of their
 *  own. */
function md(n, sep = "\n\n") {
  const out = [];
  let run = [];
  const flush = () => { const s = tidy(inline(run)); if (s) out.push(s); run = []; };
  for (const k of n.childNodes) {
    if (!isBlock(k)) { run.push(k); continue; }
    flush();
    const b = block(k);
    if (b) out.push(b);
  }
  flush();
  return out.join(sep);
}

/** What is selected, inside the ancestors it was cut from: a range across
 *  two items of a list clones as two bare items, and they are a list's
 *  only inside one. Cut to the article: a drag from the title down takes
 *  the article's part, and the title is the document's own. */
function picked(sel, art) {
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0).cloneRange();
  if (!r.intersectsNode(art)) return null;
  if (!art.contains(r.startContainer)) r.setStart(art, 0);
  if (!art.contains(r.endContainer)) r.setEnd(art, art.childNodes.length);
  let n = r.commonAncestorContainer;
  if (n.nodeType !== 1) n = n.parentNode;
  if (n.closest("pre, code")) return null;
  const frag = r.cloneContents();
  if (![...frag.querySelectorAll("*")].some(isBlock)) return null;
  let top = frag;
  for (; n && n !== art; n = n.parentNode) { const w = n.cloneNode(false); w.append(top); top = w; }
  return top;
}

/** The drawn kind, less what is only the page's: its buttons. */
function drawn(node) {
  const box = document.createElement("div");
  box.append(node.cloneNode(true));
  box.querySelectorAll("button, .copy, .mmd-tools, template").forEach(x => x.remove());
  return box.innerHTML;
}

function asMarkdown() {
  document.addEventListener("copy", e => {
    const art = $("#doc article.kind-markdown");
    if (!art || !e.clipboardData || e.target.closest?.("input, textarea, [contenteditable]")) return;
    const top = picked(getSelection(), art);
    if (!top) return;
    const text = md(top).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
    e.clipboardData.setData("text/html", drawn(top));
  });
}

/* Copy one section (#194): a heading and all under it, to the next heading
 * as high or higher, in the same two kinds as a selection. The glyph comes
 * in the gutter just before the `#`, on a hover of the heading, laid over
 * the page as the ↓ is, so nothing moves; it says ✓ on itself. */
const SEC_CSS = `
.sec-fl { position: fixed; z-index: var(--z-sticky); display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-xs); color: var(--fg-3); opacity: 0; pointer-events: none; transition: opacity var(--t), color var(--t), background var(--t); }
.sec-fl.on { opacity: .7; pointer-events: auto; }
.sec-fl:hover, .sec-fl:focus-visible { opacity: 1; color: var(--fg); background: var(--rule); }
.sec-fl[data-said] { opacity: 1; color: var(--accent); background: none; }
@media print { .sec-fl { display: none; } }
`;
const COPY = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13"/></svg>';

/** The heading and what follows it, up to the next heading as high. */
function section(h) {
  const level = +h.localName[1], box = document.createElement("div");
  box.append(h.cloneNode(true));
  for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
    if ((/^h[1-6]$/.test(n.localName) && +n.localName[1] <= level) || n.matches("section.footnotes")) break;
    box.append(n.cloneNode(true));
  }
  // The footnotes it points at, which live at the article's end.
  const ids = [...box.querySelectorAll("a[data-footnote-ref]")].map(a => a.getAttribute("href")?.slice(1)).filter(Boolean);
  // By id, not a selector: this file's `CSS` is its print sheet, not CSS.escape's.
  const notes = ids.map(id => document.getElementById(id)).filter(li => li?.closest("section.footnotes"));
  if (notes.length) {
    const s = document.createElement("section"), ol = document.createElement("ol");
    s.className = "footnotes"; ol.append(...notes.map(li => li.cloneNode(true))); s.append(ol); box.append(s);
  }
  return box;
}

function sections() {
  { const s = document.createElement("style"); s.textContent = SEC_CSS; document.head.append(s); }
  const docEl = $("#doc"), b = document.createElement("button");
  b.type = "button"; b.className = "sec-fl"; b.tabIndex = -1; b.innerHTML = COPY;
  b.dataset.tip = "Copy section"; b.dataset.tipSub = "as Markdown, to paste anywhere";
  b.setAttribute("aria-label", "Copy section");
  document.body.append(b);
  let on = null;
  const off = () => { on = null; b.classList.remove("on"); };
  docEl.addEventListener("pointerover", e => {
    const h = e.target.closest?.("article.kind-markdown > :is(h1, h2, h3, h4)");
    if (!h || h === on) return;
    on = h;
    // Against the `#`, which sits 1.2em into the gutter: the pointer goes
    // from the words over the `#` onto this without leaving the heading.
    const a = h.querySelector("a.anchor")?.getBoundingClientRect(), r = h.getBoundingClientRect();
    const left = a && a.width ? a.left : r.left - 20, mid = a && a.height ? a.top + a.height / 2 : r.top + 16;
    b.style.left = `${left - 24}px`; b.style.top = `${mid - 12}px`;
    b.classList.add("on");
  });
  docEl.addEventListener("pointerout", e => { if (on && !on.contains(e.relatedTarget) && e.relatedTarget !== b && !b.contains(e.relatedTarget)) off(); });
  b.addEventListener("pointerleave", e => { if (!on?.contains(e.relatedTarget)) off(); });
  b.addEventListener("click", async () => {
    if (!on) return;
    const box = section(on), text = md(box).replace(/\n{3,}/g, "\n\n").trim(), html = drawn(box);
    heard(b, COPY);
    try {
      if (!window.ClipboardItem) throw 0;
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
    } catch {
      try { await navigator.clipboard.writeText(text); }
      catch { c.toast("Could not copy", { sub: `select and press ${c.keyHint("mod+c")}`, at: b }); }
    }
  });
  $("#main")?.addEventListener("scroll", off, { passive: true });
  new MutationObserver(off).observe(docEl, { childList: true });
}
