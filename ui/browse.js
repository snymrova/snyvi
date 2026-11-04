/* A folder's page and a file read from disk (`snyvi browse`, a desk's
 * folder button, a path Ctrl-clicked in a panel): what it shows, how it is
 * refreshed when the file changes on disk, and the tree it reads the folder
 * as. Fetched the first time a folder or a file is opened; out of first
 * paint since 1.8.
 *
 * Since 1.56 (#214) the sidebar has no Folders: a folder is read through
 * its desk, over the desk, with the desk's rail kept and the ✕ going back to
 * the panels -- or to the panel whose path was clicked. The page is one tree
 * that unfolds in place, with Find, and it remembers how it was left. */

/* A folder's entries were the Inbox's rows until 1.56; that look stays for
   the pages that still draw one (`.inbox`), and the tree's is here, off
   first paint, now that the sidebar no longer draws one. */
{ const st = document.createElement("style"); st.textContent = `
.inbox { list-style: none; margin: 0; padding: 0; }
.inbox li a { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title time" "sub sub"; gap: 2px 16px; padding: 12px 14px; margin: 0 -14px; border-radius: var(--r-md); color: inherit; border-bottom: 1px solid var(--rule); transition: background var(--t); }
.inbox li a:hover { background: var(--bg-side); text-decoration: none; }
.inbox .title { grid-area: title; font-weight: 600; font-size: var(--fs-body-s); letter-spacing: -.005em; }
.inbox .time { grid-area: time; font-size: var(--fs-small); color: var(--fg-3); font-variant-numeric: tabular-nums; }
.fp-crumb { margin: 0 0 6px; font-size: var(--fs-small); color: var(--fg-3); }
.fp-crumb b { color: var(--fg-2); font-weight: 600; }
.fp-head h1 { margin: 0; }
.fp-top { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.fp-top:hover { color: var(--accent); }
.fp-path { font-family: var(--mono); font-size: var(--fs-small); color: var(--fg-3); overflow-wrap: anywhere; }
.fp-out { margin-left: 8px; padding: 0 6px; border-radius: var(--r-xs); background: var(--rule); color: var(--fg-2); font-family: var(--sans, inherit); font-size: var(--fs-micro); }
.fp-find { display: flex; align-items: center; gap: 8px; margin: 14px 0 10px; padding: 0 10px; height: 32px; border: 1px solid var(--rule-2); border-radius: var(--r-sm); color: var(--fg-3); }
.fp-find:focus-within { border-color: var(--accent); }
.fp-find input { flex: 1; min-width: 0; border: 0; background: none; font: inherit; font-size: var(--fs-small); color: var(--fg); outline: none; }
.fp-find input:disabled { cursor: not-allowed; }
.fp-says { margin: 4px 0; font-size: var(--fs-small); color: var(--fg-3); }
.fp .b-tree { list-style: none; margin: 0; padding: 0 0 0 20px; }
.fp > .b-tree, .fp > .fp-hits { padding-left: 0; }
.fp .b-empty { padding: 3px 10px; color: var(--fg-3); font-size: var(--fs-small); font-style: italic; }
.fp .b-dir > details > summary { list-style: none; cursor: pointer; padding: 4px 8px; border-radius: var(--r-sm); color: var(--fg-2); display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.fp .b-dir > details > summary::-webkit-details-marker { display: none; }
.fp .b-dir > details > summary:hover { background: var(--rule); color: var(--fg); }
.fp .b-dir > details > summary > .nm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fp .b-dir.fp-here > details > summary { background: var(--accent-bg); color: var(--fg); }
.fp .b-file a { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px; border-radius: var(--r-sm); color: var(--fg-2); white-space: nowrap; overflow: hidden; transition: background var(--t), color var(--t); }
.fp .b-file a > .r-ico { align-self: center; opacity: .75; flex: none; }
.fp .b-file a:hover { background: var(--rule); color: var(--fg); text-decoration: none; }
.fp .b-file .title { overflow: hidden; text-overflow: ellipsis; }
.fp .b-file .k { margin-left: auto; font-size: var(--fs-micro); color: var(--fg-3); font-family: var(--mono); flex: none; }
.fp .fp-last { flex: none; font-size: var(--fs-micro); color: var(--accent); }
.fp .b-file.fp-was a { color: var(--fg); }
.fp .b-file.fp-was a > .r-ico { color: var(--accent); opacity: 1; }`; document.head.append(st); }

function browseHtml(c, f, root) {
  const { esc, fmtSize, rel } = c;
  const sub = `${esc(root.name)} · ${esc(f.path)} · ${fmtSize(f.size)} · ${rel(f.modified)}`;
  return `<header class="doc-head"><h1 class="doc-title">${esc(f.name)}</h1><p class="doc-sub">${sub}</p></header><article class="prose kind-${f.kind}">${f.html}</article>`;
}

/* ---------- what a folder remembers ----------
 * Per folder, by its real path -- so the desk's button and a Ctrl-click into
 * the same folder share one memory: which subfolders were unfolded, where
 * the page was scrolled, and the last file read from it. In this window's
 * storage, the newest 50, as a reading place is: it is the reader's, and a
 * convenience; an empty or refused storage draws the page as new. Find's
 * words are never kept. */
const KEY = "snyvi.folders", KEPT = 50;
const all = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } };
export const folderState = path => all()[path] || null;
function keepFolder(path, patch) {
  const m = all();
  m[path] = { open: [], ...(m[path] || {}), ...patch, at: Date.now() };
  const ks = Object.keys(m);
  if (ks.length > KEPT) ks.sort((a, b) => m[a].at - m[b].at).slice(0, ks.length - KEPT).forEach(k => delete m[k]);
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

/** The folder page on screen: its root, the last file marked, the folder
 *  asked for by name. Null on any other page. */
let page = null;
/** Every unfolded level, top first, as the memory keeps them. */
const openNow = el => [...el.querySelectorAll(".b-dir > details[open]")].map(d => d.dataset.path);
/** A path's folders, outermost first: `a/b/c` is `a`, `a/b`. */
const ups = p => p.split("/").slice(0, -1).map((_, i, xs) => xs.slice(0, i + 1).join("/"));
const trim = p => (p || "").replace(/\\/g, "/").replace(/(.)\/+$/, "$1");

/** Wired once, the first time a folder's page is drawn: the unfold, the
 *  scroll and the Find box, on the page's own element. */
let wired = false;
function wire(c) {
  if (wired) return;
  wired = true;
  c.docEl.addEventListener("toggle", e => {
    const d = e.target;
    if (!page || !d.dataset || d.dataset.root !== page.rootId) return;
    if (d.open) fill(c, d.querySelector(":scope > .b-tree"));
    keepFolder(page.path, { open: openNow(c.docEl) });
  }, true);
  c.docEl.addEventListener("click", e => {
    if (!page || !e.target.closest("[data-fp-top]")) return;
    // The folder's name: back to the top, everything folded.
    for (const d of c.docEl.querySelectorAll(".b-dir > details[open]")) d.open = false;
    keepFolder(page.path, { open: [], top: 0 });
    c.main.scrollTo({ top: 0, behavior: "instant" });
  });
  let t = 0;
  c.main.addEventListener("scroll", () => {
    clearTimeout(t);
    t = setTimeout(() => { if (page && c.state.view === "browse" && !c.state.browsePath) keepFolder(page.path, { top: Math.round(c.main.scrollTop) }); }, 400);
  }, { passive: true });
  let f = 0;
  c.docEl.addEventListener("input", e => {
    if (!page || !e.target.matches(".fp-find input")) return;
    clearTimeout(f);
    f = setTimeout(() => find(c, e.target.value), 150);
  });
}

/** Find, by name, through the whole folder (`/api/browse/{id}/find`): the
 *  hits in place of the tree while there are words, the tree again without. */
async function find(c, q) {
  const tree = c.docEl.querySelector(".fp > .b-tree"), hits = c.docEl.querySelector(".fp-hits");
  if (!tree || !hits || !page) return;
  q = q.trim();
  if (!q) { hits.hidden = true; hits.innerHTML = ""; tree.hidden = false; return; }
  const rootId = page.rootId;
  const j = await c.getJson(`/api/browse/${rootId}/find?q=${encodeURIComponent(q)}&limit=60`);
  if (!page || page.rootId !== rootId) return;
  tree.hidden = true; hits.hidden = false;
  if (!Array.isArray(j)) { hits.innerHTML = `<li class="b-empty">${c.esc(j?.error || "Could not search this folder")}</li>`; return; }
  hits.innerHTML = j.length ? j.map(p => {
    const up = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    return `<li class="b-file"><a href="/b/${rootId}/${p}" data-browse="${rootId}" data-path="${c.esc(p)}">${c.docIco()}<span class="title">${c.esc(p.split("/").pop())}</span><span class="k">${c.esc(up)}</span></a></li>`;
  }).join("") : `<li class="b-empty">No file by that name</li>`;
}

/** The desk the page is read over, the line that says so, and whether the
 *  folder is the desk's own or one beside it. */
function crumb(c, root, o) {
  const { state, esc } = c;
  const d = state.deskBehind != null && state.desks && state.desks.desks.find(x => x.id === state.deskBehind);
  if (!d) return { line: "", out: false };
  const p = o.pane && d.panes.find(x => x.id === o.pane);
  const line = `<p class="fp-crumb">${p ? `from <b>panel ${p.slot}</b> on ` : ""}desk <b>${esc(d.name)}</b></p>`;
  const dr = trim(d.root), rp = trim(root.path);
  return { line, out: !(rp === dr || rp.startsWith(dr + "/")) };
}

/** Unfold `paths` in order, each level fetched as its folder opens; one that
 *  is no longer there is passed over, and dropped from the memory by the next
 *  write. */
async function unfold(c, paths) {
  for (const p of paths) {
    const d = c.docEl.querySelector(`.fp .b-dir > details[data-path="${CSS.escape(p)}"]`);
    if (!d) continue;
    d.open = true;
    await fill(c, d.querySelector(":scope > .b-tree"));
  }
}

async function showFolder(c, root, dir, push, o) {
  const { state, docEl, main, esc, leave, behindDesk, setPreview, swapIn, afterRender, getJson, tilde } = c;
  const rootId = root.id;
  const top = await getJson(`/api/browse/${rootId}/tree?path=`);
  if (!Array.isArray(top)) { c.toast("Could not open the folder", { sub: top?.error }); return; }
  if (push) leave();
  behindDesk(`b:${rootId}:`, o.over, o.pane);
  state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
  state.browseRoot = root; state.browsePath = ""; state.browseIn = dir;
  setPreview(null, null, `b:${rootId}:${dir && dir + "/"}`);
  document.title = dir ? dir.split("/").pop() : root.name;
  if (push) history.pushState({ browse: rootId, path: dir && dir + "/", over: state.deskBehind }, "", `/b/${rootId}${dir ? `/${dir}/` : ""}`);
  const was = folderState(root.path) || { open: [] };
  page = { rootId, path: root.path, last: was.last || "", here: dir };
  wire(c);
  const { line, out } = crumb(c, root, o);
  const home = trim(state.desks && state.desks.home), atHome = !!home && trim(root.path) === home;
  docEl.innerHTML = `<div class="fp">${line}<div class="inbox-head fp-head"><h1><button type="button" class="fp-top" data-fp-top data-tip="Back to the top" data-tip-sub="everything folded">${esc(root.name)}</button></h1>` +
    `<p class="fp-path">${esc(tilde(root.path))}${out ? `<span class="fp-out">outside this desk</span>` : ""}</p></div>` +
    `<label class="fp-find">${c.icon("find", 14)}<input type="search" spellcheck="false" autocomplete="off" ${atHome ? `disabled placeholder="Find is off in your home folder: snyvi never searches it"` : `placeholder="Find a file in ${esc(root.name)}"`} aria-label="Find a file in ${esc(root.name)}"></label>` +
    `<ul class="fp-hits b-tree" hidden></ul>` +
    `<ul class="b-tree" data-root="${rootId}" data-path="" data-loaded="1">${top.length ? top.map(e => entryHtml(c, rootId, e)).join("") : NONE}</ul></div>`;
  swapIn();
  main.scrollTo({ top: 0, behavior: "instant" });
  afterRender();
  // As it was left: the unfolded levels, then the way down to the folder
  // asked for and to the last file read, then the scroll. A folder asked for
  // by name wins over the scroll: it is what the click was for.
  const want = [...new Set([...was.open, ...(dir ? [...ups(dir), dir] : []), ...(page.last ? ups(page.last) : [])])].sort((a, b) => a.split("/").length - b.split("/").length);
  const turn = page;
  await unfold(c, want);
  if (page !== turn) return;
  keepFolder(root.path, { open: openNow(docEl) });
  const here = dir && docEl.querySelector(`.fp .b-dir > details[data-path="${CSS.escape(dir)}"]`);
  if (here) {
    here.parentElement.classList.add("fp-here");
    const r = here.getBoundingClientRect(), m = main.getBoundingClientRect();
    main.scrollTo({ top: main.scrollTop + r.top - m.top - 80, behavior: "instant" });
  } else if (was.top) main.scrollTo({ top: was.top, behavior: "instant" });
}

/** `o`: `over`, the desk to read it over, `pane`, the panel it was asked
 *  from, `root`, the root itself when the page has it before the `browse`
 *  event does. A page opened from a page already over a desk -- a file from
 *  its folder, a folder from Find -- stays over it, and so does one opened
 *  from the desk itself. */
export async function show(c, rootId, path, push = true, fromHistory = false, o = {}) {
  const { state, docEl, main, toast, leave, behindDesk, setPreview, swapIn, applyPreview, afterRender, placeAt, kept, cameFrom, jumpToHash, lineHash, places } = c;
  path = path || "";
  if (o.root && !state.browse.some(r => r.id === o.root.id)) state.browse = state.browse.concat(o.root);
  let root = state.browse.find(r => r.id === rootId);
  // Opened by a Ctrl-click a moment ago: the `browse` event may not be in.
  if (!root) { const l = await c.getJson("/api/browse"); if (Array.isArray(l)) { state.browse = l; root = l.find(r => r.id === rootId); } }
  if (!root) { toast("Could not open the folder", { sub: "it is no longer open for reading" }); return; }
  const over = o.over != null ? o.over : fromHistory ? history.state && history.state.over
    : state.deskBehind != null ? state.deskBehind : state.view === "desk" ? state.deskId : null;
  o = { ...o, over };
  if (!path || path.endsWith("/")) return showFolder(c, root, path.slice(0, -1), push, o);
  let j;
  try {
    const r = await fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) { toast("Could not open file", { sub: e }); return; }
  const back = push ? cameFrom() : null;
  if (push) leave();
  behindDesk(`b:${rootId}:${path}`, over, o.pane);
  page = null;
  state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
  state.browseRoot = j.root; state.browsePath = path;
  keepFolder(j.root.path, { last: path });
  setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
  docEl.innerHTML = browseHtml(c, j.file, j.root);
  swapIn();
  applyPreview();
  document.title = j.file.name;
  if (push) history.pushState({ browse: rootId, path, back, over: state.deskBehind }, "", `/b/${rootId}/${path}`);
  // Back lands where the entry was left; any other way in lands where the
  // file was last left (`keepPlace`, 04-doc.js), unless a line or a section
  // was asked for.
  const restored = fromHistory && history.state.browse === rootId && kept("path", path);
  const was = !fromHistory && !location.hash && places()[`b:${j.root.path}/${path}`];
  if (restored) placeAt(history.state.place);
  else if (was && !was.end && was.i >= 0) placeAt(was);
  else main.scrollTo({ top: 0, behavior: "instant" });
  afterRender();
  // A link into a file: `#L120` is marked and landed by afterRender, and a
  // section is landed here -- the same two the document path lands, which
  // this one did not. The browser's own fragment scroll is no use in either:
  // it aims at blocks that are still placeholders. Nothing to land when the
  // reader's own place has just been put back, or on a navigation inside the
  // page, which carries no fragment.
  if (!restored && !was && location.hash.length > 1 && !lineHash()) jumpToHash();
}


export async function refresh(c) {
  const { state, docEl, toast, setPreview, applyPreview, placeAt, placeOf, afterRefresh, browsing } = c;
  if (!browsing() || !state.browsePath) return;
  const rootId = state.browseRoot.id, path = state.browsePath;
  let j;
  try {
    const r = await fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch {
    toast(`${path.split("/").pop()} is gone`, { sub: "removed or renamed on disk · showing the last version", face: null });
    return;
  }
  // The reader moved on while this was in flight.
  if (!browsing() || state.browseRoot.id !== rootId || state.browsePath !== path) return;
  const place = placeOf();
  setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
  docEl.innerHTML = browseHtml(c, j.file, j.root);
  applyPreview();
  placeAt(place);
  afterRefresh();
}

/** A folder on the page changed on disk (the `changed` event): its level
 *  is listed again in place, unfolded subfolders and all. */
export function changed(c, j) {
  if (!page || page.rootId !== j.root) return;
  reload(c, c.docEl.querySelector(`.fp .b-tree[data-root="${j.root}"][data-path="${CSS.escape(j.path)}"]`));
}


export function meta(c) {
  const { state, metaEl, esc, previewButton, rawUrl } = c;
  const r = state.browseRoot;
  if (!r) { metaEl.innerHTML = ""; return; }
  const p = state.browsePath, at = p || state.browseIn;
  const rows = [["Folder", r.name], at ? ["Path", at] : null].filter(Boolean);
  metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span data-tip="${esc(v)}" data-tip-overflow data-tip-cut>${esc(v)}</span></div>`).join("") +
    `<div class="actions">` +
    previewButton() +
    (p ? `<a href="${rawUrl(r.id, p)}" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` : "") +
    `<button data-act="copybrowse">Copy path</button>` +
    `<button data-act="reveal" data-tip="${esc(r.path + (at ? "/" + at : ""))}" data-tip-mono>Open in file manager</button>` +
    `<a href="/b/${r.id}" data-browse="${r.id}" data-path="">Folder contents</a>` +
    `</div>`;
}

/* ---------- the tree's rows ----------
 * One level of a folder, fetched the first time it is unfolded, and
 * re-listed in place when it changes on disk. The sidebar's Folders drew
 * these until 1.56; the folder's page draws them now. */

const entryHtml = (c, rootId, e) => e.dir
  ? `<li class="b-dir"><details data-root="${rootId}" data-path="${c.esc(e.path)}"><summary>${c.icon("folder", 14)}<span class="nm">${c.esc(e.name)}</span>${c.chev}</summary><ul class="b-tree" data-root="${rootId}" data-path="${c.esc(e.path)}"></ul></details></li>`
  : `<li class="b-file${page && page.last === e.path ? " fp-was" : ""}"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${c.esc(e.path)}">${c.docIco()}<span class="title">${c.esc(e.name)}</span>${page && page.last === e.path ? `<span class="fp-last">last read</span>` : ""}<span class="k">${c.fmtSize(e.size)}</span></a></li>`;

const NONE = `<li class="b-empty">No files here</li>`;

/** Fetch one directory level the first time its folder is opened. */
export async function fill(c, ul) {
  if (!ul || ul.dataset.loaded) return;
  ul.dataset.loaded = "1";
  ul.innerHTML = c.skRows;
  const rootId = ul.dataset.root, path = ul.dataset.path || "";
  const entries = await c.getJson(`/api/browse/${rootId}/tree?path=${encodeURIComponent(path)}`);
  if (!Array.isArray(entries)) { ul.dataset.loaded = ""; ul.innerHTML = c.noReach("dir", "li"); return; }
  if (!entries.length) { ul.innerHTML = NONE; return; }
  ul.innerHTML = entries.map(e => entryHtml(c, rootId, e)).join("");
}

/** The folder changed on disk: re-list it, keeping the nodes that are still there
 *  so expanded subfolders stay expanded and nothing flickers. */
export async function reload(c, ul) {
  if (!ul || !ul.dataset.loaded) return;
  const rootId = ul.dataset.root, path = ul.dataset.path || "";
  const entries = await c.getJson(`/api/browse/${rootId}/tree?path=${encodeURIComponent(path)}`);
  if (!Array.isArray(entries) || !ul.isConnected) return;
  const old = new Map([...ul.children].map(li => [li.querySelector("[data-path]")?.dataset.path, li]));
  const tpl = document.createElement("template");
  const nodes = entries.map(e => {
    const li = old.get(e.path);
    if (li && li.classList.contains(e.dir ? "b-dir" : "b-file")) {
      const k = li.querySelector(".k"); if (k) k.textContent = c.fmtSize(e.size);
      return li;
    }
    tpl.innerHTML = entryHtml(c, rootId, e);
    return tpl.content.firstElementChild;
  });
  if (!nodes.length) { ul.innerHTML = NONE; return; }
  ul.replaceChildren(...nodes);
}
