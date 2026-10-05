/* ui/studio/04-gallery.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- the grid ----------

/** How many tiles a folder draws before "Show more": a folder of 300 four-K
 *  pictures is 300 decodes, and the first screen needs a dozen. Each tile
 *  is lazy and skips its paint off screen (`content-visibility`), and past
 *  this the reader asks for the rest. */
const SHOWN = 120;

/** The open folder's pictures, videos and sounds as a grid, or why there is
 *  nothing. Its title and note, when folder.json gives them, head it in one
 *  quiet line that scrolls with it. */
function drawGallery() {
  const el = S && S.host.querySelector(".st-gallery");
  if (!el) return;
  const { esc } = S.c, f = S.look && S.look.folder;
  if (S.off) {
    el.innerHTML = S.off === "folder"
      ? `<div class="st-empty"><p><b>The studio folder is not there.</b> It may have moved, or its drive is not mounted.</p><p><button type="button" class="st-b" data-s="folder">Point this desk at another folder…</button></p></div>`
      : `<div class="st-empty"><p>Could not reach snyvi.</p><p><button type="button" class="st-b" data-s="retry">Retry</button></p></div>`;
    return;
  }
  if (!f) { el.innerHTML = ""; return; }
  const head = (f.title || f.note ? `<p class="st-head"><b>${esc(f.title || f.name)}</b>${f.note ? `<span>${esc(f.note)}</span>` : ""}</p>` : "") + subs(f.rel);
  if (!f.items.length && (nodeOf(f.rel)?.folders || []).length) { el.innerHTML = head + hiddenLine(); return; }
  if (!f.items.length) {
    const none = !f.rel && !(S.look.tree || []).length;
    el.innerHTML = head + `<div class="st-empty"><p>${none ? "Your studio is empty." : "Nothing here yet."}</p><p class="st-quiet">${none
      ? "Tell Claude below what you're making. It puts what it makes into folders, and they show in the rail."
      : `Tell Claude below what to make. What it saves in <code>${esc(tilde(absOf(f.rel)))}</code> shows here.`}</p>${none && !(S.c.desk()?.keys || []).length
      ? `<p class="st-quiet">Claude makes them with your own provider keys, and this desk has none yet. <button type="button" class="st-link" data-s="keys">Add a key…</button></p>` : ""}</div>` + hiddenLine();
    return;
  }
  const n = S.more ? f.items.length : Math.min(f.items.length, SHOWN), cut = f.items.length - n;
  el.innerHTML = head + `<div class="st-grid">${f.items.slice(0, n).map(tile).join("")}</div>` +
    (cut ? `<p class="st-more"><button type="button" class="st-b" data-s="more">Show ${cut} more</button></p>` : "") +
    (f.more ? `<p class="st-quiet st-more">This folder has more than 5,000 files; the first 5,000 are shown.</p>` : "") + hiddenLine();
}

/** The folders in the open one, as a row of chips over its grid: the way
 *  down from a folder that holds folders, as the rail's is. */
function subs(rel) {
  const { esc } = S.c, ns = (nodeOf(rel)?.folders || []).filter(n => !(S.gone && S.gone.rel === n.rel));
  if (!ns.length) return "";
  return `<nav class="st-subs" aria-label="Folders in it">${ns.map(n => `<button type="button" class="st-sub" data-s="open" data-rel="${esc(n.rel)}"><span class="nm">${esc(n.title || n.name)}</span>${n.n ? `<span class="n">${n.n}</span>` : ""}</button>`).join("")}</nav>`;
}

/** Under the grid: how many the reader hid here, and a way to see them to
 *  put back. */
function hiddenLine() {
  const f = S.look && S.look.folder;
  if (!f || !f.hidden) return "";
  return `<p class="st-hidden"><button type="button" class="st-link" data-s="hidden" aria-pressed="${S.showHidden}">${S.showHidden ? "Hide them again" : `${f.hidden} hidden · Show`}</button></p>`;
}

/** The picture in a tile: a fixed box, so nothing moves when it arrives. */
function pic(rel, kind) {
  if (kind === "image") return `<img src="${raw(rel)}" alt="" loading="lazy" decoding="async" draggable="false">`;
  if (kind === "video") return `<video src="${raw(rel)}#t=0.1" preload="metadata" muted playsinline tabindex="-1"></video><span class="st-play" aria-hidden="true">▶</span>`;
  return `<span class="st-glyph" aria-hidden="true">♪</span>`;
}

/** What made a file and what it cost, in a few words. */
function caption(it) {
  const i = it.info || {}, bits = [];
  if (i.model) bits.push(String(i.model).split("/").pop());
  if (typeof i.cost_usd === "number") bits.push(`$${i.cost_usd.toFixed(i.cost_usd < 0.1 ? 3 : 2)}`);
  if (it.kind !== "image" && typeof i.duration_seconds === "number") bits.push(`${Math.round(i.duration_seconds)} s`);
  return bits.join(" · ");
}

/** Whether a file carries the reader's ★. */
const picked = it => ((S.look && S.look.folder && S.look.folder.picks) || []).includes(it.name);

/** A tile: the picture, and under the pointer its name and its ★. A ★
 *  stays in view on a kept one. A sound shows its name always: there is no
 *  picture to tell it by. */
function tile(it) {
  const { esc } = S.c;
  if (S.gone && S.gone.rel === it.rel) return `<figure class="st-tile gone" role="status"><div class="st-pic"></div><figcaption><span class="nm">${esc(it.name)} · hidden</span><button type="button" class="st-link" data-s="undo">Undo</button></figcaption></figure>`;
  const on = picked(it), cap = caption(it);
  return `<figure class="st-tile k-${it.kind}${on ? " picked" : ""}${it.hidden ? " hid" : ""}" data-rel="${esc(it.rel)}" tabindex="0" draggable="true" aria-label="${esc(it.name)}${on ? ", kept" : ""}${it.hidden ? ", hidden" : ""}">` +
    `<div class="st-pic">${pic(it.rel, it.kind)}</div>` +
    `<figcaption><span class="nm">${esc(it.name)}</span>${cap ? `<span class="st-meta">${esc(cap)}</span>` : ""}</figcaption>` +
    (it.hidden ? `<button type="button" class="st-undo" data-s="unhide" data-rel="${esc(it.rel)}">Put back</button>`
      : `<button type="button" class="st-star${on ? " on" : ""}" data-s="pick" data-rel="${esc(it.rel)}" aria-pressed="${on}" data-tip="${on ? "Kept" : "Keep"}" data-tip-sub="${on ? "click to take the ★ off" : "Claude reads it in folder.json"}" aria-label="${on ? "Kept" : "Keep"} ${esc(it.name)}">★</button>`) + `</figure>`;
}

/** Everything in the open folder, in drawing order: what the viewer steps
 *  through. */
const flat = () => (S.look && S.look.folder && S.look.folder.items) || [];

/** Find a file in the open folder by rel. */
const itemOf = rel => flat().find(it => it.rel === rel) || null;
