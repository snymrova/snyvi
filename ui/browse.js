/* A folder's page and a file read from disk (`snyvi browse`, a desk's
 * folder button, a path Ctrl-clicked in a panel): what it shows, how it is
 * refreshed when the file changes on disk, and the tree it reads the folder
 * as. Fetched the first time a folder or a file is opened; out of first
 * paint since 1.8.
 *
 * Since 1.56 (#214) the sidebar has no Folders: a folder is read through
 * its desk, over the desk, with the desk's rail kept and the ✕ going back to
 * the panels -- or to the panel whose path was clicked. The page is one tree
 * that unfolds in place, with Find, and it remembers how it was left.
 *
 * The tree is a column of its own, beside what is read: the folder's README
 * on the folder's page, the file on a file's. Going from file to file keeps
 * the column on the page as it was -- unfolded, scrolled, the Find words in
 * it -- so reading a run of files is a run of clicks, never back and forth.
 * What git says is changed is marked on it: M on a changed file, A on a new
 * one, and a dot on every folder above them, so the work shows folded. */

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
.fp-name { margin: 0; font-size: var(--fs-h3); font-weight: 650; letter-spacing: -.01em; }
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
.fp .b-file.fp-was a > .r-ico { color: var(--accent); opacity: 1; }
#doc:where(:has(.fp-split):not(:has(.kind-code, .kind-text, .kind-diff, .kind-table, .kind-image, article.preview, .hm))) { max-width: calc(var(--measure) + 96px + 292px); }
#doc:has(.fp-split) { container-type: inline-size; }
.fp-split { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 0 32px; align-items: start; }
.fp-l { position: sticky; top: calc(var(--head-h) + 8px); max-height: calc(100vh - var(--head-h) - 24px); overflow: auto; overscroll-behavior: contain; padding: 0 4px 16px 0; scrollbar-width: thin; }
.fp-l .fp-find { margin: 10px 0 8px; }
.fp-r { min-width: 0; }
.fp-pick { margin: 0 0 18px; padding: 8px 12px; border: 1px solid var(--rule); border-radius: var(--r-sm); font-size: var(--fs-small); color: var(--fg-3); }
.fp-pick a { font-weight: 600; }
.fp .b-file.fp-cur a { background: var(--accent-bg); color: var(--fg); }
.fp .b-file.fp-cur a > .r-ico { color: var(--accent); opacity: 1; }
.fp-mk { flex: none; font-family: var(--mono); font-size: var(--fs-micro); font-weight: 700; }
.fp-mk[data-m="M"] { color: var(--warn); }
.fp-mk[data-m="A"] { color: var(--ok); }
.fp-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; }
.fp-dot[data-m="M"] { background: var(--warn); }
.fp-dot[data-m="A"] { background: var(--ok); }
#doc:has(article.preview) .fp-split { flex: 1 1 auto; min-height: 0; grid-template-rows: 100%; align-items: stretch; }
#doc:has(article.preview) .fp-l { max-height: 100%; }
#doc:has(article.preview) .fp-r { display: flex; flex-direction: column; min-height: 0; }
@container (max-width: 720px) {
  .fp-split { display: block; }
  .fp-split > .fp-l { position: static; max-height: none; margin-bottom: 24px; }
  .fp-split.fp-file > .fp-l { display: none; }
}`; document.head.append(st); }

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

/** The folder page on screen, or a file read from it: its root, the file
 *  open (none on the folder's own page), the last file read, the folder
 *  asked for by name, and what git says is changed in it. Null on any other
 *  page. */
let page = null;
/** The column both pages share -- the folder's name, its path, Find and the
 *  tree -- kept while the reader goes from file to file in one folder, so it
 *  does not fold, scroll or flicker under them. */
let held = null;
/** Every unfolded level in `el`, top first, as the memory keeps them. */
const openNow = el => [...el.querySelectorAll(".b-dir > details[open]")].map(d => d.dataset.path);
/** A path's folders, outermost first: `a/b/c` is `a`, `a/b`. */
const ups = p => p.split("/").slice(0, -1).map((_, i, xs) => xs.slice(0, i + 1).join("/"));
const trim = p => (p || "").replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
const depth = (a, b) => a.split("/").length - b.split("/").length;
const column = c => c.docEl.querySelector(".fp-l");

/** Whether this folder's column is on the page now, to be kept for the next. */
const keepable = rootId => !!held && held.rootId === rootId && held.el.isConnected;
/** This folder's column taken off the page, with where it was scrolled, to
 *  be put on the next; null when there is none to keep. */
function take(rootId) {
  if (!keepable(rootId)) return null;
  const el = held.el;
  el._top = el.scrollTop;
  el.remove();
  return el;
}

/* ---------- what git says ----------
 * `/api/browse/{id}/changes`: each changed path, `M` or `A`, relative to the
 * folder; nothing outside a repository. Each folder above a changed path is
 * marked too, M over A, so a folded folder says there is work in it. */
function marksOf(j) {
  const marks = new Map(), dirs = new Map();
  if (j && typeof j === "object" && !Array.isArray(j) && !j.error) {
    for (const [p, m] of Object.entries(j)) {
      marks.set(p, m);
      for (const u of ups(p)) if (dirs.get(u) !== "M") dirs.set(u, m);
    }
  }
  return { marks, dirs };
}
/** A path's mark: its own, or A inside a folder git does not know yet. */
const markOf = p => page.marks.get(p) || (ups(p).some(u => page.marks.get(u) === "A") ? "A" : "");
const TIPS = { M: ["Changed", "not committed yet"], A: ["New", "not in git yet"] };

/** One small span in a row, after `after`, kept in step with `m`. */
function badge(el, cls, after, m, text, tip) {
  if (!el) return;
  let s = el.querySelector(`:scope > .${cls}`);
  if (!m) { s?.remove(); return; }
  if (!s) {
    s = document.createElement("span");
    s.className = cls;
    const at = el.querySelector(`:scope > ${after}`);
    if (at) at.after(s); else el.append(s);
  }
  s.dataset.m = m;
  s.textContent = text;
  s.dataset.tip = tip[0];
  s.dataset.tipSub = tip[1];
}

/** The rows in `scope` as the page says: the file open, the last one read,
 *  and git's marks. Run on every level as it is filled, so a row is drawn
 *  with them rather than given them after. */
function markRows(scope) {
  if (!page || !scope) return;
  for (const a of scope.querySelectorAll(".b-file > a[data-path]")) {
    const p = a.dataset.path, li = a.parentElement;
    const was = !!page.last && p === page.last && p !== page.file;
    li.classList.toggle("fp-cur", p === page.file);
    li.classList.toggle("fp-was", was);
    badge(a, "fp-last", ".title", was ? "last" : "", "last read", ["The last file you read here", ""]);
    const m = markOf(p);
    badge(a, "fp-mk", ".title", m, m, TIPS[m] || []);
  }
  for (const d of scope.querySelectorAll(".b-dir > details[data-path]")) {
    const m = page.dirs.get(d.dataset.path) || markOf(d.dataset.path);
    badge(d.querySelector(":scope > summary"), "fp-dot", ".nm", m, "", ["Changes inside", m === "A" ? "new, not in git yet" : "not committed yet"]);
  }
}

/** Ask git again, and mark the column with what it says now. */
async function remark(c) {
  const turn = page;
  if (!turn) return;
  const j = await c.getJson(`/api/browse/${turn.rootId}/changes`);
  if (page !== turn) return;
  Object.assign(page, marksOf(j));
  markRows(column(c));
}
let remarkT = 0;
const remarkSoon = c => { clearTimeout(remarkT); remarkT = setTimeout(() => remark(c), 800); };

/** Wired once, the first time a folder's page is drawn: the unfold, the
 *  column's scroll, the Find box and the keys, on the page's own element. */
let wired = false;
function wire(c) {
  if (wired) return;
  wired = true;
  c.docEl.addEventListener("toggle", e => {
    const d = e.target;
    if (!page || !d.dataset || d.dataset.root !== page.rootId) return;
    if (d.open) fill(c, d.querySelector(":scope > .b-tree"));
    const col = column(c);
    if (col) keepFolder(page.path, { open: openNow(col) });
  }, true);
  c.docEl.addEventListener("click", e => {
    const col = column(c);
    if (!page || !col || !e.target.closest("[data-fp-top]")) return;
    // The folder's name: back to the top, everything folded.
    for (const d of col.querySelectorAll(".b-dir > details[open]")) d.open = false;
    keepFolder(page.path, { open: [], top: 0 });
    col.scrollTo({ top: 0, behavior: "instant" });
  });
  // The column scrolls on its own; a scroll does not bubble, so it is
  // heard on the way down.
  let t = 0;
  c.docEl.addEventListener("scroll", e => {
    const col = e.target;
    if (!page || !(col instanceof Element) || !col.matches(".fp-l")) return;
    clearTimeout(t);
    t = setTimeout(() => { if (page && col.isConnected) keepFolder(page.path, { top: Math.round(col.scrollTop) }); }, 400);
  }, { capture: true, passive: true });
  let f = 0;
  c.docEl.addEventListener("input", e => {
    if (!page || !e.target.matches(".fp-find input")) return;
    clearTimeout(f);
    f = setTimeout(() => find(c, e.target.value), 150);
  });
  c.docEl.addEventListener("keydown", e => walk(e));
}

/** The arrows in the column, as in any file tree: up and down from row to
 *  row, right unfolds a folder (then steps into it), left folds it (then
 *  steps out to the folder above). Enter opens, as a link does. Down from
 *  Find steps into the rows. */
function walk(e) {
  const col = e.target.closest?.(".fp-l");
  if (!col || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const rows = [...col.querySelectorAll(".b-dir > details > summary, .b-file > a")].filter(r => r.getClientRects().length);
  if (e.target.matches(".fp-find input")) {
    if (e.key !== "ArrowDown" || !rows.length) return;
    rows[0].focus();
  } else {
    const at = e.target.closest("summary, a"), i = rows.indexOf(at);
    if (i < 0) return;
    const d = at.matches("summary") ? at.parentElement : null;
    if (e.key === "ArrowDown") rows[i + 1]?.focus();
    else if (e.key === "ArrowUp") (rows[i - 1] || col.querySelector(".fp-find input:not(:disabled)"))?.focus();
    else if (e.key === "ArrowRight" && d) { if (d.open) rows[i + 1]?.focus(); else d.open = true; }
    else if (e.key === "ArrowLeft") {
      if (d && d.open) d.open = false;
      else at.closest(".b-tree")?.closest("details")?.querySelector(":scope > summary")?.focus();
    } else return;
  }
  e.preventDefault();
  e.stopPropagation();
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
    return `<li class="b-file"><a href="/b/${rootId}/${c.esc(p)}" data-browse="${rootId}" data-path="${c.esc(p)}">${c.docIco()}<span class="title">${c.esc(p.split("/").pop())}</span><span class="k">${c.esc(up)}</span></a></li>`;
  }).join("") : `<li class="b-empty">No file by that name</li>`;
  markRows(hits);
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

/** The column's html: the folder's name (back to the top), its path, Find,
 *  and the tree's first level. */
function columnHtml(c, root, o, top) {
  const { state, esc, tilde } = c;
  const { line, out } = crumb(c, root, o);
  const home = trim(state.desks && state.desks.home), atHome = !!home && trim(root.path) === home;
  return `${line}<div class="fp-head"><p class="fp-name"><button type="button" class="fp-top" data-fp-top data-tip="Back to the top" data-tip-sub="everything folded">${esc(root.name)}</button></p>` +
    `<p class="fp-path">${esc(tilde(root.path))}${out ? `<span class="fp-out">outside this desk</span>` : ""}</p></div>` +
    `<label class="fp-find">${c.icon("find", 14)}<input type="search" spellcheck="false" autocomplete="off" ${atHome ? `disabled placeholder="Find is off in your home folder: snyvi never searches it"` : `placeholder="Find a file in ${esc(root.name)}"`} aria-label="Find a file in ${esc(root.name)}"></label>` +
    `<ul class="fp-hits b-tree" hidden></ul>` +
    `<ul class="b-tree" data-root="${root.id}" data-path="" data-loaded="1">${top.length ? top.map(e => entryHtml(c, root.id, e)).join("") : NONE}</ul>`;
}

/** The column into its place on a page just drawn: the one kept, as it was
 *  scrolled, or a new one from `top`. Null when there is neither. */
function mount(c, root, o, keep, top) {
  const slot = column(c);
  if (!slot) return null;
  if (keep) {
    slot.replaceWith(keep);
    keep.scrollTop = keep._top || 0;
    held = { rootId: root.id, el: keep };
  } else if (Array.isArray(top)) {
    slot.innerHTML = columnHtml(c, root, o, top);
    held = { rootId: root.id, el: slot };
  } else { held = null; return null; }
  markRows(held.el);
  return held.el;
}

/** The column as it was left, once it is on the page: the unfolded levels
 *  (a new column only), the way down to `also` -- the folder asked for, the
 *  file open -- and the scroll; the folder asked for, or the file open,
 *  brought into view when it is out of it. */
async function settle(c, col, fresh, was, also, dir) {
  const turn = page;
  const want = [...new Set([...(fresh ? was.open : []), ...also, ...(fresh && page.last ? ups(page.last) : [])])].sort(depth);
  await unfold(c, want);
  if (page !== turn || !col.isConnected) return;
  markRows(col);
  keepFolder(page.path, { open: openNow(col) });
  for (const h of col.querySelectorAll(".fp-here")) h.classList.remove("fp-here");
  const here = dir && col.querySelector(`.b-dir > details[data-path="${CSS.escape(dir)}"]`);
  if (here) here.parentElement.classList.add("fp-here");
  const to = here || col.querySelector(".b-file.fp-cur");
  if (to) {
    const r = to.getBoundingClientRect(), b = col.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) col.scrollTo({ top: col.scrollTop + r.top - b.top - 80, behavior: "instant" });
  } else if (fresh && was.top) col.scrollTo({ top: was.top, behavior: "instant" });
}

/** The line over the folder's page that goes back to the last file read. */
function pickHtml(c, rootId, last) {
  if (!last) return "";
  const i = last.lastIndexOf("/");
  return `<p class="fp-pick">Pick up where you left off: <a href="/b/${rootId}/${c.esc(last)}" data-browse="${rootId}" data-path="${c.esc(last)}">${c.esc(last.slice(i + 1))}</a>${i > 0 ? ` in ${c.esc(last.slice(0, i))}` : ""}</p>`;
}

/** The folder page's own side: the README of the folder asked for, read as
 *  a file is, or a line saying what the side is for. */
async function readme(c, col, dir) {
  const slot = c.docEl.querySelector(".fp-readme");
  if (!slot) return;
  const lvl = dir ? col.querySelector(`.b-tree[data-path="${CSS.escape(dir)}"]`) : col.querySelector(":scope > .b-tree[data-path='']");
  const a = lvl && [...lvl.querySelectorAll(":scope > .b-file > a[data-path]")].find(x => /^readme(\.|$)/i.test(x.dataset.path.split("/").pop()));
  if (!a) { slot.innerHTML = `<p class="fp-says">Pick a file on the left, and it reads here.</p>`; return; }
  const turn = page;
  const j = await c.getJson(`/api/browse/${turn.rootId}/file?path=${encodeURIComponent(a.dataset.path)}`);
  if (page !== turn || !slot.isConnected || !j || !j.file) return;
  slot.innerHTML = browseHtml(c, j.file, j.root);
  c.afterRefresh();
}

async function showFolder(c, root, dir, push, o) {
  const { state, docEl, main, leave, behindDesk, setPreview, swapIn, afterRender, getJson } = c;
  const rootId = root.id, tree = `/api/browse/${rootId}/tree?path=`;
  let [top, marks] = await Promise.all([keepable(rootId) ? null : getJson(tree), getJson(`/api/browse/${rootId}/changes`)]);
  if (!keepable(rootId) && !Array.isArray(top)) top = await getJson(tree);
  if (!keepable(rootId) && !Array.isArray(top)) { c.toast("Could not open the folder", { sub: top?.error }); return; }
  if (push) leave();
  const keep = take(rootId);
  behindDesk(`b:${rootId}:`, o.over, o.pane);
  state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
  state.browseRoot = root; state.browsePath = ""; state.browseIn = dir;
  setPreview(null, null, `b:${rootId}:${dir && dir + "/"}`);
  document.title = dir ? dir.split("/").pop() : root.name;
  if (push) history.pushState({ browse: rootId, path: dir && dir + "/", over: state.deskBehind }, "", `/b/${rootId}${dir ? `/${dir}/` : ""}`);
  const was = folderState(root.path) || { open: [] };
  page = { rootId, path: root.path, last: was.last || "", here: dir, file: "", ...marksOf(marks) };
  wire(c);
  docEl.innerHTML = `<div class="fp-split"><aside class="fp fp-l"></aside><div class="fp-r">${pickHtml(c, rootId, page.last)}<div class="fp-readme"></div></div></div>`;
  const col = mount(c, root, o, keep, top);
  swapIn();
  main.scrollTo({ top: 0, behavior: "instant" });
  afterRender();
  if (!col) return;
  // As it was left: the unfolded levels, then the way down to the folder
  // asked for and to the last file read, then the column's scroll. A folder
  // asked for by name wins over the scroll: it is what the click was for.
  if (!dir) readme(c, col, "");
  await settle(c, col, !keep, was, dir ? [...ups(dir), dir] : [], dir);
  if (dir && page && page.here === dir) readme(c, col, dir);
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
  // The file, and the tree beside it: kept from the page before when that
  // was this folder's, fetched with the file when it was not. Git's marks
  // come along from this folder's page before; asked for when there was none.
  const tree = `/api/browse/${rootId}/tree?path=`;
  const carry = page && page.rootId === rootId ? { marks: page.marks, dirs: page.dirs } : null;
  let j, top = null;
  try {
    const [r, t] = await Promise.all([fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`), keepable(rootId) ? null : c.getJson(tree)]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
    top = t;
  } catch (e) { toast("Could not open file", { sub: e }); return; }
  if (!keepable(rootId) && !Array.isArray(top)) top = await c.getJson(tree);
  const back = push ? cameFrom() : null;
  if (push) leave();
  const keep = take(rootId);
  behindDesk(`b:${rootId}:${path}`, over, o.pane);
  const was = folderState(j.root.path) || { open: [] };
  page = { rootId, path: j.root.path, last: path, here: "", file: path, ...(carry || marksOf(null)) };
  wire(c);
  state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
  state.browseRoot = j.root; state.browsePath = path;
  keepFolder(j.root.path, { last: path });
  setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
  docEl.innerHTML = `<div class="fp-split fp-file"><aside class="fp fp-l"></aside><div class="fp-r">${browseHtml(c, j.file, j.root)}</div></div>`;
  const col = mount(c, root, o, keep, top);
  swapIn();
  applyPreview();
  document.title = j.file.name;
  if (push) history.pushState({ browse: rootId, path, back, over: state.deskBehind }, "", `/b/${rootId}/${path}`);
  // Back lands where the entry was left; any other way in lands where the
  // file was last left (`keepPlace`, 04-doc.js), unless a line or a section
  // was asked for.
  const restored = fromHistory && history.state.browse === rootId && kept("path", path);
  const left = !fromHistory && !location.hash && places()[`b:${j.root.path}/${path}`];
  if (restored) placeAt(history.state.place);
  else if (left && !left.end && left.i >= 0) placeAt(left);
  else main.scrollTo({ top: 0, behavior: "instant" });
  afterRender();
  // A link into a file: `#L120` is marked and landed by afterRender, and a
  // section is landed here -- the same two the document path lands, which
  // this one did not. The browser's own fragment scroll is no use in either:
  // it aims at blocks that are still placeholders. Nothing to land when the
  // reader's own place has just been put back, or on a navigation inside the
  // page, which carries no fragment.
  if (!restored && !left && location.hash.length > 1 && !lineHash()) jumpToHash();
  if (!col) return;
  settle(c, col, !keep, was, ups(path), "");
  if (!carry) remark(c);
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
  // The reading side only: the tree beside it stays as it is.
  const side = docEl.querySelector(".fp-r");
  (side || docEl).innerHTML = browseHtml(c, j.file, j.root);
  remarkSoon(c);
  applyPreview();
  placeAt(place);
  afterRefresh();
}

/** A folder on the page changed on disk (the `changed` event): its level
 *  is listed again in place, unfolded subfolders and all. */
export function changed(c, j) {
  if (!page || page.rootId !== j.root) return;
  reload(c, c.docEl.querySelector(`.fp .b-tree[data-root="${j.root}"][data-path="${CSS.escape(j.path)}"]`));
  remarkSoon(c);
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
  : `<li class="b-file"><a href="/b/${rootId}/${c.esc(e.path)}" data-browse="${rootId}" data-path="${c.esc(e.path)}">${c.docIco()}<span class="title">${c.esc(e.name)}</span><span class="k">${c.fmtSize(e.size)}</span></a></li>`;

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
  markRows(ul);
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
  markRows(ul);
}
