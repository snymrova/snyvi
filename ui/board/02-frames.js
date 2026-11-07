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
  if (sheet.dataset.src === src) return;
  sheet.dataset.src = src;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("aria-label", f.name || f.id);
  frame.tabIndex = -1;
  frame.width = String(f.w);
  frame.height = String(f.h);
  frame.src = src;
  sheet.replaceChildren(frame);
  // A frame that arrives, or is rewritten, says so once; the first paint of
  // a board does not flash every frame.
  if (!fitted) return;
  el.classList.remove("bd-new");
  void el.offsetWidth;
  el.classList.add("bd-new");
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
