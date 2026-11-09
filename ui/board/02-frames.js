/** One frame's element: its label (name, size, version) above, and the
 *  iframe at the size the agent gave. The iframe takes no pointer: the
 *  reader's hands on a board are select, pan and zoom, so a click anywhere on
 *  a frame is the frame's, and the frame's own scripts still run. */
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

/** Draw `f` into `el`: place and size always, the iframe only when what it
 *  shows changed, so a frame that did not change keeps its running page. */
function paintFrame(el, f) {
  el.style.left = `${f.x}px`;
  el.style.top = `${f.y}px`;
  el.style.width = `${f.w}px`;
  el.classList.toggle("bd-on", picked.includes(f.id));
  el.querySelector(".bd-name").textContent = f.name || f.id;
  el.querySelector(".bd-size").textContent = `${f.w} × ${f.h}`;
  el.querySelector(".bd-ver").textContent = f.versions > 1 ? `v${f.versions}` : "";
  const sheet = el.querySelector(".bd-sheet");
  sheet.style.height = `${f.h}px`;
  if (!f.doc) {
    if (sheet.dataset.src !== "") { sheet.dataset.src = ""; sheet.innerHTML = `<p class="bd-empty">${f.missing ? "The file is gone from the folder." : "Not read yet."}</p>`; }
    return;
  }
  const src = frameSrc(f);
  if (sheet.dataset.src === src) { postLive(sheet, f); return; }
  sheet.dataset.src = src;
  sheet.dataset.live = "";
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("aria-label", f.name || f.id);
  frame.tabIndex = -1;
  frame.width = String(f.w);
  frame.height = String(f.h);
  frame.src = src;
  // A live frame gets its numbers once its page has loaded, from the board as
  // read now: a reload may have come in while it was loading.
  frame.addEventListener("load", () => {
    frame.dataset.loaded = "1";
    sheet.dataset.live = "";
    const now = shown().find(x => x.id === f.id);
    if (now) postLive(sheet, now);
  });
  sheet.replaceChildren(frame);
  // A frame that arrives, or is rewritten, says so once; the first paint of
  // a board does not flash every frame.
  if (!fitted) return;
  el.classList.remove("bd-new");
  void el.offsetWidth;
  el.classList.add("bd-new");
}

/** A live frame's numbers (1.61, C7, `source` in board.json): posted into
 *  its iframe after it loads, and again only when they moved. The frame is
 *  sandboxed without allow-same-origin, so its origin is opaque and "*" is
 *  the only target that reaches it; what goes is numbers this page already
 *  holds, and nothing the frame posts back is listened to. */
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
 *  painted in place. */
function paintFrames() {
  if (!world || !board) return;
  const want = new Map(shown().map(f => [f.id, f]));
  for (const el of [...world.children]) if (!want.has(el.dataset.id)) el.remove();
  for (const f of want.values()) {
    let el = world.querySelector(`.bd-frame[data-id="${CSS.escape(f.id)}"]`);
    if (!el) { el = frameEl(f); world.append(el); }
    paintFrame(el, f);
  }
  host.classList.toggle("bd-none", !want.size);
}
