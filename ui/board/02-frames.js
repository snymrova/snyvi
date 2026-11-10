/* A board's sections and islands (1.62).
 *
 * Every shown frame has a box here, in the world: its label above, and a
 * sheet the reader picks by. A section's sheet is empty -- what it shows is
 * drawn under it, in the board's one document (`doc`, ui/board-frame.js),
 * which sits in the world at the sections' bounding box, so pan and zoom
 * move it with the boxes and nothing is synced on a pan. An island (a frame
 * with a script) keeps an iframe of its own in its sheet, as every frame had
 * before. The documents take no pointer: a click anywhere on a frame is the
 * frame's box's.
 */

let doc = null;           // the board's one iframe, for its sections
let docReady = false;
let syncN = 0;
/** What the board's document holds, by section id: the hash it was sent. */
const sent = new Map();
/** Sections' HTML by hash, fetched from their documents' own route. */
const htmlOf = new Map();
/** The live numbers last posted, by section id. */
const liveSaid = new Map();
let docBox = { ox: 0, oy: 0 };

const sections = () => shown().filter(f => !f.island && f.doc);

/** One frame's element: its label (name, size, version) above, and the
 *  sheet at the size it is drawn. */
function frameEl(f) {
  const el = document.createElement("section");
  el.className = "bd-frame";
  el.dataset.id = f.id;
  el.innerHTML = `<header class="bd-label"><span class="bd-name"></span><span class="bd-size"></span><span class="bd-ver"></span></header>` +
    `<div class="bd-sheet"></div>`;
  return el;
}

/** The document route a frame is loaded from, with its hash: the same id is
 *  rewritten in place inside the 20 s window (src/receive.rs), so the hash
 *  is what tells the browser's cache a burst's last write from its first. */
const frameSrc = f => `/api/docs/${encodeURIComponent(f.doc)}/blob?h=${encodeURIComponent(f.hash)}`;

/** The size a label says: the agent's, or the width and what was measured. */
const sizeSaid = f => f.h ? `${f.w} × ${f.h}` : f.island ? `${f.w} × ${ISLAND_H}` : measured[f.id] ? `${f.w} × ${measured[f.id]}` : `${f.w} wide`;

/** Draw `f` into `el`: place and size always; an island's iframe only when
 *  what it shows changed, so one that did not keeps its running page. */
function paintFrame(el, f) {
  el.style.left = `${f.x}px`;
  el.style.top = `${f.y}px`;
  el.style.width = `${f.w}px`;
  el.classList.toggle("bd-on", picked.includes(f.id));
  el.classList.toggle("bd-sec", !f.island && !!f.doc);
  el.querySelector(".bd-name").textContent = f.name || f.id;
  el.querySelector(".bd-size").textContent = sizeSaid(f);
  el.querySelector(".bd-ver").textContent = f.versions > 1 ? `v${f.versions}` : "";
  const sheet = el.querySelector(".bd-sheet");
  sheet.style.height = `${heightOf(f)}px`;
  if (!f.doc) {
    if (sheet.dataset.src !== "") { sheet.dataset.src = ""; sheet.innerHTML = `<p class="bd-empty">${f.missing ? "The file is gone from the folder." : "Not read yet."}</p>`; }
    return;
  }
  const key = f.island ? frameSrc(f) : `s:${f.hash}`;
  if (sheet.dataset.src === key) { if (f.island) postLive(sheet, f); return; }
  sheet.dataset.src = key;
  sheet.dataset.live = "";
  if (!f.island) sheet.replaceChildren();
  else {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("aria-label", f.name || f.id);
    frame.tabIndex = -1;
    frame.width = String(f.w);
    frame.height = String(heightOf(f));
    frame.src = frameSrc(f);
    // A live island gets its numbers once its page has loaded, from the
    // board as read now: a reload may have come in while it was loading.
    frame.addEventListener("load", () => {
      frame.dataset.loaded = "1";
      sheet.dataset.live = "";
      const now = shown().find(x => x.id === f.id);
      if (now) postLive(sheet, now);
    });
    sheet.replaceChildren(frame);
  }
  // A frame that arrives, or is rewritten, says so once; the first paint of
  // a board does not flash every frame.
  if (!fitted) return;
  el.classList.remove("bd-new");
  void el.offsetWidth;
  el.classList.add("bd-new");
}

/** An island's numbers (1.61, C7, `source` in board.json): posted into its
 *  iframe after it loads, and again only when they moved. Its origin is
 *  opaque, so "*" is the only target that reaches it; what goes is numbers
 *  this page already holds, and nothing it posts back is listened to. */
function postLive(sheet, f) {
  const data = board?.live?.[f.id];
  const frame = sheet.querySelector("iframe");
  if (!data || !frame || !frame.dataset.loaded) return;
  const said = JSON.stringify(data);
  if (sheet.dataset.live === said) return;
  sheet.dataset.live = said;
  frame.contentWindow?.postMessage({ snyvi: "live", source: f.source, data }, "*");
}

/** Every shown frame, in order: new ones made, gone ones taken out, the rest
 *  painted in place. The board's document is not a frame and stays. */
function paintFrames() {
  if (!world || !board) return;
  const want = new Map(shown().map(f => [f.id, f]));
  for (const el of [...world.querySelectorAll(":scope > .bd-frame")]) if (!want.has(el.dataset.id)) el.remove();
  for (const f of want.values()) {
    let el = world.querySelector(`:scope > .bd-frame[data-id="${CSS.escape(f.id)}"]`);
    if (!el) { el = frameEl(f); world.append(el); }
    paintFrame(el, f);
  }
  host.classList.toggle("bd-none", !want.size);
}

/** The board's one document, made the first time it has a section. */
function ensureDoc() {
  if (doc) return;
  doc = document.createElement("iframe");
  doc.className = "bd-doc";
  doc.setAttribute("sandbox", "allow-scripts");
  doc.setAttribute("referrerpolicy", "no-referrer");
  doc.setAttribute("aria-label", "The board's sections");
  doc.tabIndex = -1;
  doc.src = "/board-frame";
  docReady = false;
  sent.clear();
  liveSaid.clear();
  world.prepend(doc);
}

function dropDoc() {
  doc?.remove();
  doc = null; docReady = false;
  sent.clear(); liveSaid.clear();
}

/** The document at the sections' bounding box, in world pixels. */
function placeDoc(ss) {
  if (!doc || !ss.length) return;
  const ox = Math.min(...ss.map(f => f.x)), oy = Math.min(...ss.map(f => f.y));
  const x1 = Math.max(...ss.map(f => f.x + f.w)), y1 = Math.max(...ss.map(f => f.y + heightOf(f)));
  docBox = { ox, oy };
  Object.assign(doc.style, { left: `${ox}px`, top: `${oy}px`, width: `${x1 - ox}px`, height: `${y1 - oy}px` });
}

const tell = m => doc?.contentWindow?.postMessage({ snyvi: "board", ...m }, "*");

/** The sections into the board's document: each one's HTML fetched once per
 *  hash, sent once per hash, and the rest only placed. */
async function syncDoc() {
  const ss = sections();
  if (!ss.length) { dropDoc(); return; }
  ensureDoc();
  const at = ++syncN;
  await Promise.all(ss.filter(f => !htmlOf.has(f.hash)).map(f =>
    fetch(frameSrc(f)).then(r => (r.ok ? r.text() : "")).then(t => { htmlOf.set(f.hash, t); }, () => {})));
  if (at !== syncN || !doc) return;
  const keep = new Set(ss.map(f => f.hash));
  for (const h of [...htmlOf.keys()]) if (!keep.has(h)) htmlOf.delete(h);
  placeDoc(ss);
  if (!docReady) return;
  const list = ss.map(f => {
    const s = { id: f.id, hash: f.hash, x: f.x, y: f.y, w: f.w, h: f.h };
    if (sent.get(f.id) !== f.hash && htmlOf.has(f.hash)) { s.html = htmlOf.get(f.hash); sent.set(f.id, f.hash); }
    return s;
  });
  for (const id of [...sent.keys()]) if (!ss.some(f => f.id === id)) { sent.delete(id); liveSaid.delete(id); }
  tell({ t: "sections", ox: docBox.ox, oy: docBox.oy, list });
  for (const f of ss) {
    const data = board?.live?.[f.id];
    const said = data ? JSON.stringify(data) : "";
    if (!data || liveSaid.get(f.id) === said) continue;
    liveSaid.set(f.id, said);
    tell({ t: "live", id: f.id, data });
  }
}

/** What the board's document says: it is ready, or its sections' heights
 *  moved. From that document only; a height is a number, and a wild one is
 *  cut to the largest side a frame may have. */
function docSaid(e) {
  if (!doc || e.source !== doc.contentWindow) return;
  const m = e.data;
  if (!m || m.snyvi !== "board") return;
  if (m.t === "ready") {
    docReady = true;
    sent.clear(); liveSaid.clear();
    tell({ t: "tokens", vars: (board?.tokens?.vars || []).slice(0, 200) });
    syncDoc();
  } else if (m.t === "sizes" && m.sizes && typeof m.sizes === "object") {
    let moved = false;
    for (const [id, h] of Object.entries(m.sizes)) {
      const n = Math.max(0, Math.min(4000, Math.round(Number(h) || 0)));
      if (measured[id] !== n) { measured[id] = n; moved = true; }
    }
    if (!moved) return;
    paintFrames();
    placeDoc(sections());
    if (!touched && shown().length) fit();
  }
}
