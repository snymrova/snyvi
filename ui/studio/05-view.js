/* ui/studio/05-view.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- one file, large ----------

/** The file open large, and its element, while one is. */
let viewing = null, viewEl = null;

/** The fields Info shows by name, in this order; any other key in the JSON
 *  beside the file follows, as text. */
const INFO = [["model", "Model"], ["provider", "Provider"], ["seed", "Seed"], ["cost_usd", "Cost"], ["duration_seconds", "Length"],
  ["resolution", "Size"], ["params", "Params"], ["source", "From"], ["parent", "Parent"], ["license", "Licence"], ["original_url", "Source"],
  ["made_by", "Made by"], ["made_at", "Made"], ["note", "Note"]];

/** Open `rel` large in the viewer's own space: a picture fitted, a video or
 *  a sound with its controls. Under it one thin bar: its name, ★ Keep,
 *  Tell Claude…, Info (folded: the prompt and the rest of its JSON), and
 *  where it is in the folder. ← → step, Esc goes back to the grid. */
function openView(rel) {
  const it = itemOf(rel), main = S && S.host.querySelector(".st-main");
  if (!it || !main) return;
  const again = viewing === rel && viewEl;
  viewing = rel;
  selected(rel);
  if (!viewEl) {
    viewEl = Object.assign(document.createElement("div"), { className: "st-view" });
    viewEl.setAttribute("role", "dialog"); viewEl.setAttribute("aria-modal", "false");
    viewEl.addEventListener("click", e => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      const v = b.dataset.v;
      if (v === "close") closeView();
      else if (v === "keep") pick(viewing);
      else if (v === "tell") tellClaude(viewing);
      else if (v === "copy") { const p = (itemOf(viewing) || {}).info?.prompt || ""; navigator.clipboard?.writeText(p); S.c.toast("Copied the prompt", { sub: p.slice(0, 80) }); }
      else step(+v);
    });
    document.addEventListener("keydown", viewKey, true);
  }
  main.append(viewEl);
  const all = flat(), i = all.findIndex(x => x.rel === rel), { esc } = S.c, info = it.info || {}, on = picked(it);
  // The same file drawn again (a ★, a poll): the picture stays, so a video
  // keeps playing; only the bar is written.
  const bar = `<span class="nm" data-tip="${esc(it.name)}" data-tip-overflow>${esc(it.name)}</span>` +
    `<button type="button" class="st-b st-keep${on ? " on" : ""}" data-v="keep" aria-pressed="${on}" data-key="k" data-tip="${on ? "Kept" : "Keep"}" data-tip-sub="${on ? "click to take the ★ off" : "Claude reads it in folder.json"}">${on ? "★ Kept" : "★ Keep"}</button>` +
    `<button type="button" class="st-b" data-v="tell" data-tip="Tell Claude about it" data-tip-sub="puts its path in the panel, for you to finish">Tell Claude…</button>` +
    infoBox(info) + `<span class="st-gap"></span>` +
    `<span class="st-view-n">${i + 1} / ${all.length}</span>` +
    `<button type="button" class="st-icon" data-v="-1" aria-label="Previous" data-tip="Previous" data-key="←" ${i > 0 ? "" : "disabled"}>‹</button>` +
    `<button type="button" class="st-icon" data-v="1" aria-label="Next" data-tip="Next" data-key="→" ${i < all.length - 1 ? "" : "disabled"}>›</button>` +
    `<button type="button" class="st-icon" data-v="close" aria-label="Back to the folder" data-tip="Back to the folder" data-key="esc">${S.c.glyph("x")}</button>`;
  viewEl.setAttribute("aria-label", it.name);
  if (again && viewEl.querySelector(".st-view-bar")) {
    const b = viewEl.querySelector(".st-view-bar"), open = b.querySelector(".st-info")?.open;
    b.innerHTML = bar;
    if (open) b.querySelector(".st-info")?.setAttribute("open", "");
    return;
  }
  const body = it.kind === "image" ? `<img src="${raw(rel)}" alt="${esc(info.prompt || it.name)}">`
    : it.kind === "video" ? `<video src="${raw(rel)}" controls autoplay playsinline></video>`
    : `<div class="st-view-audio"><span class="st-glyph" aria-hidden="true">♪</span><audio src="${raw(rel)}" controls autoplay></audio></div>`;
  viewEl.innerHTML = `<div class="st-view-body">${body}</div><div class="st-view-bar">${bar}</div>`;
  viewEl.querySelector("[data-v=close]").focus({ preventScroll: true });
}

/** Info, folded: the prompt, with its Copy, and what else the JSON beside
 *  the file says; nothing at all when there is none. */
function infoBox(i) {
  const { esc } = S.c, rows = [];
  const val = (k, v) => k === "cost_usd" && typeof v === "number" ? `$${v.toFixed(3)}`
    : k === "duration_seconds" && typeof v === "number" ? `${v.toFixed(1)} s`
    : k === "original_url" && /^https?:\/\//.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(String(v).replace(/^https?:\/\//, "").slice(0, 40))} ↗</a>`
    : esc(typeof v === "object" ? JSON.stringify(v) : v);
  for (const [k, label] of INFO) if (i[k] != null && i[k] !== "") rows.push(`<dt>${label}</dt><dd>${val(k, i[k])}</dd>`);
  const named = new Set(["prompt", ...INFO.map(([k]) => k)]);
  for (const [k, v] of Object.entries(i)) if (!named.has(k)) rows.push(`<dt>${esc(k)}</dt><dd>${val(k, v)}</dd>`);
  if (!rows.length && !i.prompt) return "";
  const prompt = i.prompt ? `<p class="st-info-p">${esc(i.prompt)}</p><button type="button" class="st-link" data-v="copy">Copy prompt</button>` : "";
  return `<details class="st-info"><summary class="st-b">Info</summary><div class="st-info-box">${prompt}${rows.length ? `<dl>${rows.join("")}</dl>` : ""}</div></details>`;
}

/** The next or the previous file in the folder; false when there is none. */
function step(by) {
  const all = flat(), i = all.findIndex(x => x.rel === viewing), to = all[i + by];
  if (!to) return false;
  openView(to.rel);
  return true;
}

/** The folder changed under the viewer (a ★, a poll): its bar again, or
 *  back to the grid when the file went. */
function redrawView() {
  if (!viewEl || !viewing) return;
  if (itemOf(viewing)) openView(viewing);
  else closeView();
}

function viewKey(e) {
  if (!viewEl || !viewEl.isConnected || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, textarea, select, .dk-grid")) return;
  if (e.key === "Escape") {
    const inf = viewEl.querySelector(".st-info[open]");
    e.preventDefault(); e.stopPropagation();
    if (inf) inf.open = false; else closeView();
  }
  else if (e.key === "k") { e.preventDefault(); e.stopPropagation(); pick(viewing); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); const r = viewing; closeView(); hide(r); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (e.target.closest && e.target.closest("video, audio")) return;
    e.preventDefault(); e.stopPropagation(); step(e.key === "ArrowLeft" ? -1 : 1);
  }
}

/** Back to the grid, the file that was open focused in it. */
function closeView() {
  if (!viewEl) return;
  const was = viewing;
  document.removeEventListener("keydown", viewKey, true);
  viewEl.remove(); viewEl = null; viewing = null;
  if (S) selected("");
  const t = was && S && S.host.querySelector(`.st-tile[data-rel="${window.CSS.escape(was)}"]`);
  if (t) t.focus({ preventScroll: false });
}
