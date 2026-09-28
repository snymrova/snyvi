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
  if (!path) {
    // No file asked for and no README: show the folder's contents.
    let entries = [], root = state.browse.find(r => r.id === rootId);
    try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=`)).json(); } catch {}
    if (push) leave();
    offDesk();
    state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
    state.browseRoot = root || state.browseRoot; state.browsePath = "";
    setPreview(null, null, `b:${rootId}:`);
    document.title = root ? root.name : "snyvi";
    if (push) history.pushState({ browse: rootId, path: "" }, "", `/b/${rootId}`);
    docEl.innerHTML = `<div class="inbox-head"><h1>${esc(root ? root.name : "Folder")}</h1><p>${esc(root ? root.path : "")}</p></div><ul class="inbox">` +
      entries.map(e => `<li><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}"><span class="title">${e.dir ? "▸ " : ""}${esc(e.name)}</span><span class="time">${e.dir ? "" : fmtSize(e.size)}</span></a></li>`).join("") + `</ul>`;
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
  const p = state.browsePath;
  const rows = [["Folder", r.name], p ? ["Path", p] : null].filter(Boolean);
  metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span data-tip="${esc(v)}" data-tip-overflow data-tip-cut>${esc(v)}</span></div>`).join("") +
    `<div class="actions">` +
    previewButton() +
    (p ? `<a href="${rawUrl(r.id, p)}" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` : "") +
    `<button data-act="copybrowse">Copy path</button>` +
    `<button data-act="terminal" data-tip="${esc(r.path + (p ? "/" + p : ""))}" data-tip-mono>Open terminal here</button>` +
    `<button data-act="reveal" data-tip="${esc(r.path + (p ? "/" + p : ""))}" data-tip-mono>Open in file manager</button>` +
    `<a href="/b/${r.id}" data-browse="${r.id}" data-path="">Folder contents</a>` +
    `<button data-act="closebrowse">Close folder</button>` +
    `</div>`;
}
