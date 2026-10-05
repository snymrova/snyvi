/* ui/studio/06-act.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- what the reader does: ★, hide, Tell Claude ----------

/** ★: keep a file, or take the ★ off it. At once on the page, then told to
 *  the daemon, which writes it into the folder's folder.json; a refusal
 *  puts it back as it was and says why. */
async function pick(rel) {
  const it = itemOf(rel), f = S.look && S.look.folder;
  if (!it || !f) return;
  const was = f.picks || [], now = was.includes(it.name) ? was.filter(n => n !== it.name) : [...was, it.name];
  const set = v => { if (S.look && S.look.folder === f) { f.picks = v; drawGallery(); redrawView(); } };
  set(now);
  try { await S.c.api(`/api/studio/${S.desk}/keep`, { rel }); }
  catch (e) { set(was); S.c.toast("Could not keep it", { sub: e }); }
}

/** Hide a file or a folder: out of view at once, its place kept with Undo;
 *  the daemon is told after the page has changed. Never off the disk. */
async function hide(rel) {
  const c = S.c, id = S.desk;
  if (S.gone) clearTimeout(S.gone.timer);
  S.gone = { rel, timer: setTimeout(() => {
    if (!S || !S.gone || S.gone.rel !== rel) return;
    S.gone = null; S.stamp = "";
    // The folder open, or one it is in, hidden: off it, once its Undo went.
    if (S.rel && (S.rel === rel || S.rel.startsWith(rel + "/"))) { S.rel = ""; keep(id, ""); }
    drawGallery(); c.rail(); load();
  }, BACK_MS) };
  drawGallery(); c.rail();
  try { await c.api(`/api/studio/${id}/hide`, { rel }); }
  catch (e) { if (S && S.gone && S.gone.rel === rel) { clearTimeout(S.gone.timer); S.gone = null; drawGallery(); c.rail(); } c.toast("Could not hide it", { sub: e }); }
}

/** Undo a hide, or put back something hidden earlier. */
async function unhide(rel) {
  const c = S.c, id = S.desk;
  if (S.gone && S.gone.rel === rel) { clearTimeout(S.gone.timer); S.gone = null; }
  try { await c.api(`/api/studio/${id}/unhide`, { rel }); }
  catch (e) { c.toast("Could not put it back", { sub: e }); }
  if (S) { S.stamp = ""; drawGallery(); c.rail(); load(); }
}

/** A line about a file or a folder into the panel, for the reader to finish. */
function tellClaude(rel) {
  say(`About ${shq(absOf(rel))}${itemOf(rel) ? "" : "/"}: `);
}

Object.assign(ACTS, {
  open: b => openFolder(b.dataset.rel),
  pick: b => pick(b.dataset.rel),
  unhide: b => unhide(b.dataset.rel),
  undo: () => S.gone && unhide(S.gone.rel),
  more: () => { S.more = true; drawGallery(); },
  hidden: () => { S.showHidden = !S.showHidden; S.stamp = ""; load(); },
  retry: () => { S.off = ""; S.stamp = ""; drawGallery(); load(); },
  folder: () => studioFolder(),
  keys: () => S.c.keys(),
});

/** A click in the viewer: the `data-s` it was on says what; on a tile,
 *  anywhere else, it opens the tile large. */
function onClick(e) {
  if (!S) return;
  const b = e.target.closest("[data-s]");
  if (b) { const f = ACTS[b.dataset.s]; if (f) f(b, e); return; }
  const t = e.target.closest(".st-tile[data-rel]");
  if (t) openView(t.dataset.rel);
}

/** Keys on a tile: Enter opens, ⌫ hides, K keeps, arrows move. */
function onKey(e) {
  if (!S) return;
  const t = e.target.closest && e.target.closest(".st-tile[data-rel]");
  if (!t || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter") { e.preventDefault(); openView(t.dataset.rel); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); hide(t.dataset.rel); }
  else if (e.key === "k") { e.preventDefault(); pick(t.dataset.rel); }
  else if (/^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    const all = [...S.host.querySelectorAll(".st-tile[data-rel]")], i = all.indexOf(t);
    const per = Math.max(1, Math.round(t.parentElement.clientWidth / Math.max(1, t.offsetWidth)));
    const j = i + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -per, ArrowDown: per })[e.key];
    if (all[j]) { e.preventDefault(); all[j].focus(); }
  }
}

/** A tile dragged: its path goes with it, for the panel to take as a paste
 *  (desk.js takes a drop of the studio's own type as typing). */
function onDrag(e) {
  const t = e.target.closest && e.target.closest(".st-tile[data-rel]");
  if (!t || !S) return;
  e.dataTransfer.setData("text/plain", shq(absOf(t.dataset.rel)));
  e.dataTransfer.setData("application/x-snyvi-board", t.dataset.rel);
  e.dataTransfer.effectAllowed = "copy";
}
