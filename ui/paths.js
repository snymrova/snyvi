/* A path the reader Ctrl-clicks: in a desk's panel, and in what is being
 * read -- a document, or a file in the folder reader. A file opens here in
 * the reader, at its line; a folder opens here on its folder page.
 *
 * Fetched the first time Ctrl is held in a window that holds the desk's
 * capability: a browser tab without one cannot ask, so it never loads this.
 * Nothing in a document is rewritten to find a path -- the word under the
 * pointer is read from the text while Ctrl is down, and the daemon says
 * whether it names anything (`/api/resolve`). What it names is never run. */

/** A path in a line of text, at a character: the word that covers `i`, cut
 *  at spaces, quotes and brackets, with the punctuation a sentence puts after
 *  it trimmed off. A word is a path when it starts at `/`, `~/`, `./` or
 *  `../`, holds a `/`, or is a name with an extension; a `:120` or `:120:5`
 *  after it stays on, for the line. A URL is not one: the caller asks
 *  `urlAt` first. Whether the path is there is the daemon's to say. */
export function pathAt(text, i) {
  if (i < 0 || i >= text.length) return null;
  const stop = /[\s"'`<>|()[\]{}]/;
  if (stop.test(text[i])) return null;
  let from = i, to = i + 1;
  while (from > 0 && !stop.test(text[from - 1])) from--;
  while (to < text.length && !stop.test(text[to])) to++;
  let w = text.slice(from, to);
  // A sentence's end, a list's comma, a label's colon; `⎿` and bullets.
  while (w && /[.,;:!?*]$/.test(w) && !/^\.{1,2}\/?$/.test(w)) { w = w.slice(0, -1); to--; }
  while (w && /^[*•⎿-]/.test(w) && w.length > 1) { w = w.slice(1); from++; }
  if (!w || i < from || i >= to) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) || w.length > 1024) return null;
  const bare = w.replace(/(:\d+){1,2}$/, "");
  const rooted = /^(\/|~\/|\.{1,2}\/)/.test(bare);
  const named = /^[\w@+-][\w.@+-]*\.[A-Za-z][\w-]{0,9}$/.test(bare.split("/").pop()) && /[A-Za-z]/.test(bare);
  if (!rooted && !bare.includes("/") && !named) return null;
  // Two slashes at the end of nothing, a date, a fraction: not paths.
  if (/^\/+$/.test(bare) || /^[\d/.:-]+$/.test(bare)) return null;
  return { path: w, from, to };
}

/** The daemon's answer for a word, asked once per word while Ctrl is held:
 *  `{kind, path, line}`, or null for a word that names nothing. `forget` is
 *  the end of the hold -- a file made since is found on the next one. */
function resolver(api) {
  let known = new Map();
  const key = (from, word) => JSON.stringify([from, word]);
  return {
    known(from, word) { return known.get(key(from, word)); },
    check(from, word) {
      const k = key(from, word);
      if (!known.has(k)) known.set(k, api("/api/resolve", { ...from, word }).then(j => (known.set(k, j), j), () => (known.set(k, null), null)));
      return Promise.resolve(known.get(k));
    },
    forget() { known = new Map(); },
  };
}

let ctx = null, R = null;

/** Wire the reader, once, and hand back what a desk's panels share with it.
 *  `c` is the page's: `api` (the capability's route), `state`, `docEl`,
 *  `browse(root, rel)`, `landLine(n)`, `toast`. */
export function init(c) {
  if (R) return R;
  ctx = c;
  const res = resolver(c.api);
  R = { pathAt, check: res.check, known: res.known, forget: res.forget, open };
  reader();
  return R;
}

/** Open what a word names: a file here in the reader, at its line, a folder
 *  on its folder page (`sub/`). `from` is where it was clicked, as
 *  `/api/resolve` takes it. */
async function open(from, word) {
  let j;
  try { j = await ctx.api("/api/resolve", { ...from, word, open: true }); }
  catch (e) { ctx.toast(`Could not open ${word}`, { sub: e }); return; }
  if (j.kind === "dir") return ctx.browse(j.root, j.rel && j.rel + "/");
  await ctx.browse(j.root, j.rel);
  if (j.line) ctx.landLine(j.line);
}

// ---------- the reader ----------

/** Where the page is reading, as `/api/resolve` takes it, or null when it is
 *  not reading anything a path could be relative to. */
function place() {
  const s = ctx.state;
  if (s.view === "doc" && s.doc) return { doc: s.doc.id };
  if (s.view === "browse" && s.browseRoot) return { root: s.browseRoot.id, path: s.browsePath || "" };
  return null;
}

/** The block a word is read in: a code line, or a paragraph's worth of text
 *  -- so a path the highlighter split into three spans is still one word. */
const BLOCK = ".ln, p, li, td, th, h1, h2, h3, h4, h5, h6, dt, dd, figcaption, pre, blockquote";

/** The path under the pointer in the reader, with its rectangles on screen. */
function wordAt(e) {
  const t = e.target;
  if (!t.closest || !ctx.docEl.contains(t) || t.closest("a[href], button, input, textarea, svg, .mermaid, .copy")) return null;
  let node, off;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) { node = p.offsetNode; off = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) { node = r.startContainer; off = r.startOffset; }
  }
  if (!node || node.nodeType !== 3) return null;
  const block = node.parentElement.closest(BLOCK) || node.parentElement;
  if (!ctx.docEl.contains(block)) return null;
  // The character under the pointer, counted through the block's text.
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let at = -1, k = 0;
  for (let n; (n = w.nextNode());) { if (n === node) { at = k + off; break; } k += n.length; }
  if (at < 0) return null;
  const text = block.textContent;
  // The caret lands between characters: the one it is before, or at a line's
  // end the one it is after.
  const p = pathAt(text, at) || (at > 0 ? pathAt(text, at - 1) : null);
  if (!p) return null;
  const rects = [];
  k = 0;
  const w2 = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n; (n = w2.nextNode());) {
    const a = Math.max(p.from - k, 0), b = Math.min(p.to - k, n.length);
    if (a < b) { const rg = document.createRange(); rg.setStart(n, a); rg.setEnd(n, b); rects.push(...rg.getClientRects()); }
    k += n.length;
  }
  return { word: p.path, rects };
}

let ul = null, last = null, frame = 0;

function underline(l, title) {
  if (!l) { ul?.remove(); ul = null; document.documentElement.classList.remove("on-path"); return; }
  if (!ul) { ul = document.createElement("div"); ul.className = "path-ul"; document.body.append(ul); }
  ul.innerHTML = [...l.rects].map(q => `<i style="left:${q.left}px;top:${q.top + q.height - 2}px;width:${q.width}px"></i>`).join("");
  ul.title = title || "";
  document.documentElement.classList.add("on-path");
}

/** The pointer at `e`, with Ctrl held: underline the word under it once the
 *  daemon has said it names something. At most once a frame. */
function hover(e) {
  last = e;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const ev = last, from = ev && ev.ctrlKey && place(), l = from && wordAt(ev);
    if (!l) return underline(null);
    const j = R.known(from, l.word);
    if (j && typeof j.then !== "function") return underline(l, j.path);
    underline(null);
    // Asked already and not answered yet, or not asked: either way, look
    // again once it is, if the pointer has not moved on.
    if (j !== null) R.check(from, l.word).then(() => { if (last === ev) hover(ev); });
  });
}

function reader() {
  const s = document.createElement("style");
  s.textContent = ".path-ul { position: fixed; inset: 0; pointer-events: none; z-index: 30; } .path-ul i { position: absolute; height: 1px; background: var(--accent); } .on-path .prose, .on-path .prose * { cursor: pointer; }";
  document.head.append(s);
  const d = ctx.docEl;
  d.addEventListener("mousemove", e => { if (e.ctrlKey) hover(e); else if (ul) { last = null; underline(null); } });
  d.addEventListener("mouseleave", () => { last = null; underline(null); });
  addEventListener("keyup", e => { if (e.key === "Control") { last = null; underline(null); R.forget(); } });
  addEventListener("scroll", () => { if (ul) { last = null; underline(null); } }, { capture: true, passive: true });
  addEventListener("blur", () => { last = null; underline(null); R.forget(); });
  // On the press, before a selection starts or a link opens a window.
  d.addEventListener("mousedown", e => {
    if (e.button !== 0 || !e.ctrlKey) return;
    const from = place(), l = from && wordAt(e);
    const j = l && R.known(from, l.word);
    if (!j || typeof j.then === "function") return;
    e.preventDefault();
    underline(null);
    open(from, l.word);
  });
}
