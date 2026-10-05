/* ui/studio/03-rail.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- the rail's studio rows ----------

/** What the desk's rail draws for the studio, under its Claude row: what it
 *  all cost, and Assets -- the folders, as the daemon read them. desk.js puts them in
 *  its own sections (and folds them as it folds its others); a click on one
 *  comes back here (`railAct`). Null while the studio is not drawn. */
export function railRows() {
  if (!S) return null;
  const { esc } = S.c, L = S.look;
  if (S.off === "folder") return { n: 0, spent: "", folders: `<p class="dk-empty">The studio folder is not there. <button type="button" class="dk-link" data-a="st-folder">Point it somewhere…</button></p>` };
  if (!L) return { n: 0, spent: "", folders: `<p class="dk-empty">${S.off ? "Could not reach snyvi." : "Reading…"}</p>` };
  const money = v => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`;
  const over = L.budget && L.spend > L.budget;
  const spent = L.spend > 0 || L.budget
    ? `<p class="dk-spent${over ? " over" : ""}" data-part="rail.spent" data-tip="What it cost" data-tip-sub="added up from the cost_usd beside each file${L.budget ? `; the budget is in the top folder.json` : ""}">${money(L.spend || 0)}${L.budget ? ` of ${money(L.budget)}` : ""} spent</p>` : "";
  const open = S.rel ?? "";
  const row = (n, depth) => {
    if (S.gone && S.gone.rel === n.rel) return `<li class="dk-note gone" role="status"><span class="nm">${esc(n.title || n.name)} · hidden</span><button type="button" class="dk-undo" data-a="st-undo">Undo</button></li>`;
    const on = n.rel === open, path = open === n.rel || open.startsWith(n.rel + "/");
    const kids = n.folders && n.folders.length;
    return `<li><button type="button" class="dk-sf${on ? " on" : ""}" data-a="st-open" data-rel="${esc(n.rel)}" style="--d:${depth}"${on ? ` aria-current="true"` : ""} data-tip="${esc(n.title ? `${n.title} · ${n.rel}` : n.rel)}" data-tip-overflow>` +
      `<span class="dk-sf-c${kids ? "" : " none"}${path && kids ? " open" : ""}" aria-hidden="true"></span><span class="nm">${esc(n.title || n.name)}</span>${n.n ? `<span class="n">${n.n}</span>` : ""}</button></li>` +
      (path && kids ? n.folders.map(k => row(k, depth + 1)).join("") : "");
  };
  const top = L.loose ? `<li><button type="button" class="dk-sf${open === "" ? " on" : ""}" data-a="st-open" data-rel="" style="--d:0" data-tip="The studio folder itself" data-tip-sub="${esc(tilde(L.root || S.root))}"><span class="dk-sf-c none" aria-hidden="true"></span><span class="nm">${esc(baseName(L.root || S.root))}</span><span class="n">${L.loose}</span></button></li>` : "";
  const list = (L.tree || []).map(n => row(n, 0)).join("");
  const folders = top || list ? `<ul class="dk-sfs">${top}${list}</ul>`
    : `<p class="dk-empty">Nothing yet. What Claude makes shows here, in the folders it puts it in.</p>`;
  return { n: (L.tree || []).length, spent, folders };
}

/** A click on one of the studio's rows in the rail: open a folder, Undo a
 *  hide, point the desk at another folder. */
export function railAct(b) {
  if (!S) return;
  const a = b.dataset.a;
  if (a === "st-open") openFolder(b.dataset.rel);
  else if (a === "st-undo") { if (S.gone) unhide(S.gone.rel); }
  else if (a === "st-folder") studioFolder();
}

/** The last part of a path. */
const baseName = p => String(p || "").replace(/\/+$/, "").split("/").pop() || p;
