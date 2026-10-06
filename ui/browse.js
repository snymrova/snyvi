/* A folder's page and a file read from disk (`snyvi browse`, the sidebar's
 * Folders): what it shows, how it is refreshed when the file changes on disk,
 * and the rail's rows for it. Fetched the first time a folder or a file is
 * opened; out of first paint since 1.8. */

function browseHtml(c, f, root) {
  const { esc, fmtSize, rel } = c;
  const sub = `${esc(root.name)} · ${esc(f.path)} · ${fmtSize(f.size)} · ${rel(f.modified)}`;
  return `<header class="doc-head"><h1 class="doc-title">${esc(f.name)}</h1><p class="doc-sub">${sub}</p></header><article class="prose kind-${f.kind}">${f.html}</article>`;
}


export async function show(c, rootId, path, push = true, fromHistory = false) {
  const { state, docEl, main, esc, fmtSize, toast, leave, offDesk, setPreview, swapIn, applyPreview, afterRender, placeAt, kept, cameFrom, jumpToHash, lineHash } = c;
  path = path || "";
  if (!path || path.endsWith("/")) {
    // A folder's contents: the root's when no file was asked for and there is
    // no README, or a folder inside it, asked for as `sub/` -- a Ctrl-clicked
    // folder, a ▸ row here. `browsePath` stays "" on every folder page, so
    // nothing reads one as a file; `browseIn` is the folder listed.
    const dir = path.slice(0, -1), root = state.browse.find(r => r.id === rootId);
    let entries = [];
    try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=${encodeURIComponent(dir)}`)).json(); } catch {}
    if (!Array.isArray(entries)) { toast("Could not open the folder", { sub: entries?.error }); return; }
    if (push) leave();
    offDesk();
    state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
    state.browseRoot = root || state.browseRoot; state.browsePath = ""; state.browseIn = dir;
    setPreview(null, null, `b:${rootId}:${path}`);
    const name = dir ? dir.split("/").pop() : root ? root.name : "Folder";
    document.title = root || dir ? name : "snyvi";
    if (push) history.pushState({ browse: rootId, path }, "", `/b/${rootId}${dir ? `/${dir}/` : ""}`);
    const row = (to, label, size = "") => `<li><a href="/b/${rootId}${to ? `/${to}` : ""}" data-browse="${rootId}" data-path="${esc(to)}"><span class="title">${esc(label)}</span><span class="time">${size}</span></a></li>`;
    const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/") + 1) : "";
    docEl.innerHTML = `<div class="inbox-head"><h1>${esc(name)}</h1><p>${esc(root ? root.path + (dir ? "/" + dir : "") : "")}</p></div><ul class="inbox">` +
      (dir ? row(up, "▴ ..") : "") +
      entries.map(e => e.dir ? row(e.path + "/", "▸ " + e.name) : row(e.path, e.name, fmtSize(e.size))).join("") + `</ul>`;
    swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
    return;
  }
  let j;
  try {
    const r = await fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) { toast("Could not open file", { sub: e }); return; }
  const back = push ? cameFrom() : null;
  if (push) leave();
  offDesk();
  state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
  state.browseRoot = j.root; state.browsePath = path;
  setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
  docEl.innerHTML = browseHtml(c, j.file, j.root);
  swapIn();
  applyPreview();
  document.title = j.file.name;
  if (push) history.pushState({ browse: rootId, path, back }, "", `/b/${rootId}/${path}`);
  const restored = fromHistory && history.state.browse === rootId && kept("path", path);
  if (restored) placeAt(history.state.place); else main.scrollTo({ top: 0, behavior: "instant" });
  afterRender();
  // A link into a file: `#L120` is marked and landed by afterRender, and a
  // section is landed here -- the same two the document path lands, which
  // this one did not. The browser's own fragment scroll is no use in either:
  // it aims at blocks that are still placeholders. Nothing to land when the
  // reader's own place has just been put back, or on a navigation inside the
  // page, which carries no fragment.
  if (!restored && location.hash.length > 1 && !lineHash()) jumpToHash();
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
    `<button data-act="closebrowse">Close folder</button>` +
    `</div>`;
}

/* ---------- the sidebar's folder rows ----------
 * One level of a folder, fetched the first time it is unfolded, and
 * re-listed in place when it changes on disk. In app.js until 1.17, when the
 * first-paint budget asked for 0.5 KB and these were what a reader with no
 * folder open never used. */

const entryHtml = (c, rootId, e) => e.dir
  ? `<li class="b-dir"><details data-root="${rootId}" data-path="${c.esc(e.path)}"><summary>${c.icon("folder", 14)}<span class="nm">${c.esc(e.name)}</span>${c.chev}${c.plusDesk()}</summary><ul class="b-tree" data-root="${rootId}" data-path="${c.esc(e.path)}"></ul></details></li>`
  : `<li class="b-file"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${c.esc(e.path)}" data-tip="${c.esc(e.path)}" data-tip-mono>${c.docIco()}<span class="title">${c.esc(e.name)}</span><span class="k">${c.fmtSize(e.size)}</span></a></li>`;

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
  c.markActive();
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
  c.markActive();
}
