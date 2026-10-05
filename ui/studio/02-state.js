/* ui/studio/02-state.js: a part of studio.js, one module. build.rs joins
 * ui/studio/*.js in name order (src/strip.rs `source`). */
// ---------- the studio's state, and the seam with desk.js ----------

/** Everything the studio holds, for the studio desk on the page:
 *  - host, c: where it draws, and what desk.js handed it (`studioCtx`)
 *  - desk: the desk's id; rel: the folder open ("" is the studio folder)
 *  - look: the daemon's last answer -- tree, loose, spend, budget, folder
 *  - stamp: the daemon's mark for the folder as last read
 *  - showHidden: hidden ones shown; gone: a hide just done, its Undo in place
 *  - off: why there is nothing to draw ("folder" gone, or no "reach")
 * Null while no studio desk is drawn. */
let S = null;
/** How often the folder is asked about, while the page is showing it. */
const POLL_MS = 1500;
/** How long an Undo stands, as everywhere (docs/DESIGN.md Q2). */
const BACK_MS = 6000;

/** A click's action by its `data-s`, added to by each part, so none of them
 *  edits another. */
const ACTS = {};

/** The folder a desk was left on, kept per desk in this browser. */
const KEEP = id => `snyvi.st.folder-${id}`;
const kept = id => { try { return localStorage.getItem(KEEP(id)); } catch { return null; } };
const keep = (id, rel) => { try { localStorage.setItem(KEEP(id), rel); } catch {} };

/** Draw the studio for desk.js's studio desk in `host`. Called again with a
 *  new host when the desk is drawn again (after a document read over it):
 *  the folder open is kept. */
export function mount(host, c) {
  style();
  const d = c.desk();
  if (!d) return;
  if (S && S.desk === d.id) { S.host = host; S.c = c; }
  else {
    unmount();
    S = { host, c, desk: d.id, rel: kept(d.id), look: null, stamp: "", showHidden: false, gone: null, timer: 0, off: "", root: d.boards };
  }
  host.innerHTML = FRAME;
  host.addEventListener("click", onClick);
  host.addEventListener("keydown", onKey);
  host.addEventListener("dragstart", onDrag);
  drawGallery();
  load();
  clearInterval(S.timer);
  S.timer = setInterval(tick, POLL_MS);
}

/** Off the page: polling stops, the listeners go; nothing is kept but S's
 *  memory of where the reader was, for the next mount of the same desk. */
export function unmount() {
  if (!S) return;
  clearInterval(S.timer);
  const h = S.host;
  if (h) { h.removeEventListener("click", onClick); h.removeEventListener("keydown", onKey); h.removeEventListener("dragstart", onDrag); }
  closeView();
  S = null;
}

/** The list of desks moved (desks.js `update`): the studio folder may have. */
export function update() {
  if (!S) return;
  const d = S.c.desk();
  if (!d || d.id !== S.desk) return;
  if (S.root !== d.boards) { S.root = d.boards; S.stamp = ""; S.rel = ""; S.look = null; keep(d.id, ""); closeView(); load(); }
}

/** One poll, only while the studio is on the page and the page is showing. */
function tick() {
  if (!S || !S.host.isConnected || document.hidden) return;
  load();
}

/** Read the folder -- the tree, the spend, the open folder -- when it
 *  changed, and draw it: the viewer here, the rail's rows in desk.js. With
 *  no folder open yet, the first folder opens, unless the studio folder has
 *  files of its own. */
async function load() {
  if (!S || S.loading) return;
  S.loading = true;
  const id = S.desk, rel = S.rel ?? "";
  try {
    const q = `rel=${encodeURIComponent(rel)}&stamp=${encodeURIComponent(S.stamp)}${S.showHidden ? "&hidden=1" : ""}`;
    const j = await S.c.api(`/api/studio/${id}/look?${q}`);
    if (!S || S.desk !== id || (S.rel ?? "") !== rel) return;
    const was = S.off;
    S.off = "";
    if (j.same && !was) return;
    if (j.same) { drawGallery(); S.c.rail(); return; }
    S.look = j; S.stamp = j.stamp;
    // The folder open went (renamed, moved): the top came instead.
    if (j.folder && S.rel && j.folder.rel !== S.rel) S.rel = "";
    // Nothing open, or the top with nothing in it: the first folder, when
    // there is one. The top is a place of its own only while it holds files.
    const first = !S.rel && !j.loose && firstFull(j.tree || []);
    if (first) { S.rel = first.rel; keep(id, S.rel); S.stamp = ""; S.loading = false; return load(); }
    if (S.rel == null) S.rel = "";
    drawGallery(); redrawView(); S.c.rail();
  } catch (e) {
    if (!S || S.desk !== id) return;
    S.off = e.status === 409 ? "folder" : "reach";
    S.look = null; S.stamp = ""; drawGallery(); S.c.rail();
  } finally { if (S) S.loading = false; }
}

/** The first folder with files in it, depth first, or the first folder. */
function firstFull(tree) {
  const walk = ns => { for (const n of ns) { if (n.n) return n; const k = walk(n.folders || []); if (k) return k; } return null; };
  return walk(tree) || tree[0] || null;
}

/** The folder `rel` in the tree, as the daemon last read it; the studio
 *  folder itself for "". */
function nodeOf(rel) {
  const tree = (S.look && S.look.tree) || [];
  if (!rel) return { rel: "", folders: tree };
  const walk = ns => { for (const n of ns) { if (n.rel === rel) return n; if (rel.startsWith(n.rel + "/")) { const k = walk(n.folders || []); if (k) return k; } } return null; };
  return walk(tree);
}

/** Open folder `rel`: kept as the desk's, read, drawn. */
function openFolder(rel) {
  if (!S) return;
  closeView();
  if (S.rel === rel && S.look) return;
  S.rel = rel; S.stamp = ""; S.showHidden = false; S.more = false;
  if (S.look) S.look = { ...S.look, folder: null };
  keep(S.desk, rel);
  drawGallery(); S.c.rail();
  load();
}

/** The frame: the viewer, which takes all of the space over the panel.
 *  desk.js keeps the panel under it and the rail beside it. */
const FRAME = `<div class="st"><section class="st-main" aria-label="Viewer" data-part="studio.viewer"><div class="st-gallery"></div></section></div>`;

/** The studio folder: pick another with the desktop's dialog (the desk's
 *  ⋯ menu, Studio folder…). */
export async function studioFolder() {
  if (!S) return;
  const c = S.c, d = c.desk();
  try {
    const j = await c.api("/api/studio/pick", {});
    if (!j.path) return;
    await c.api(`/api/desks/${d.id}/studio-folder`, { path: j.path });
    await c.refresh();
    // The desk moved whole (its path, its menus); Claude follows on its next start.
    c.toast("Studio folder changed", { sub: `${tilde(j.path)} · Claude moves there when its panel starts again · the old folder's files stay where they are` });
  } catch (e) { c.toast("Could not change the studio folder", { sub: e }); }
}

/** A path with the home folder as ~. */
function tilde(p) {
  const h = S && S.c.home();
  return p && h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p || "";
}

/** A studio-relative name as a URL for the media route: each part encoded,
 *  the slashes kept. */
const raw = rel => `/api/studio/${S.desk}/raw/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** What the reader has open, told to the daemon a moment after it settles,
 *  for the agent's next prompt ("The reader is looking at …"). Stepping
 *  through the viewer sends the one it stopped on, not every one on the way. */
function selected(rel) {
  clearTimeout(S.lookTimer);
  const id = S.desk;
  S.lookTimer = setTimeout(() => { S && S.c.api(`/api/studio/${id}/selection`, { rel: rel || "" }).catch(() => {}); }, 400);
}

/** Text into the panel as a paste, for the reader to finish and send.
 *  Nothing is sent: the reader's Enter is what sends. */
function say(text) {
  if (!S.c.type(text)) S.c.toast("Claude is not running", { sub: "Start it, then try again" });
}

/** A path for the panel: quoted when it has a space or a quote. */
const shq = abs => /[\s'"]/.test(abs) ? `'${abs.replace(/'/g, "'\\''")}'` : abs;

/** What the reader means by a file or a folder, for the panel: its full path. */
const absOf = rel => rel ? `${S.c.desk().boards}/${rel}` : S.c.desk().boards;
