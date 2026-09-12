/* snyvi client. No framework; the server renders documents, this script navigates. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const boot = JSON.parse($("#boot").textContent || "{}");
  const root = document.documentElement;
  const main = $("#main"), docEl = $("#doc"), treeEl = $("#tree"), tocEl = $("#toc"), metaEl = $("#meta"), rail = $("#rail");
  const treesEl = $("#trees"), browseEl = $("#browse-nav"), inboxRowEl = $("#inbox-row");

  const state = {
    tree: boot.tree || [],          // one row per project; what it holds is fetched when it is expanded
    sub: new Map(Object.entries(boot.sub || {})),   // project id -> its workflows, once filled
    view: boot.view || "inbox",
    doc: boot.doc || null,
    previous: boot.previous || null,
    folder: boot.folder || null,   // where "Open terminal here" would open, if anywhere
    unread: new Map(),          // project id -> count
    lastActivity: 0,
    cache: new Map(),           // id -> {doc, html, previous}
    split: (() => { try { return localStorage.getItem("snyvi.split") === "1"; } catch { return false; } })(),
    comparing: null,            // {a, b} while a comparison is shown
    browse: boot.browse || [],  // folders opened with `snyvi browse`
    browseRoot: boot.browseRoot || null,
    browsePath: boot.browsePath || "",
    preview: null,              // "html" | "pdf" when the open file can be shown as a page
    previewUrl: null,
    previewOn: false,
    previewKey: null,           // what previewOn belongs to, so a toggle survives a re-render
  };

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rel = ts => {
    const d = Date.now() / 1000 - ts;
    if (d < 45) return "just now";
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    const dt = new Date(ts * 1000);
    if (d < 7 * 86400) return dt.toLocaleDateString(undefined, { weekday: "short" }) + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const fmt = ts => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const kindTag = k => ({ markdown: "md", code: "code", diff: "diff", text: "txt", image: "img", binary: "bin", table: "csv" }[k] || k);
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const idle = () => Date.now() - state.lastActivity > 2500 && !(window.getSelection() && String(window.getSelection()).length);
  ["scroll", "keydown", "mousedown", "wheel", "touchstart"].forEach(e => window.addEventListener(e, () => { state.lastActivity = Date.now(); }, { passive: true, capture: true }));

  // ---------- tree ----------
  const openProjects = new Set((store.get("snyvi.open") || "").split(",").filter(Boolean));
  /** Caps a reader has lifted, by project and by workflow, so a refetch does not
   *  put the rest back out of reach while they are still reading it. */
  const liftedCaps = new Set();
  const liftedWorkflows = new Set();
  /** Fills in flight, so a project expanded twice in a second is fetched once,
   *  and fills already attempted, so a fetch that failed is not retried by the
   *  render it would trigger. Expanding the project by hand asks again. */
  const filling = new Set();
  const tried = new Set();

  /** The browse section keeps its own DOM across navigations so expanded folders stay open. */
  function renderBrowse() {
    const ids = state.browse.map(r => r.id).join(",");
    if (browseEl.dataset.ids === ids) return;
    browseEl.dataset.ids = ids;
    browseEl.innerHTML = !state.browse.length ? "" : `<div class="b-section"><div class="t-label">Folders</div>` + state.browse.map(r => {
      const active = state.browseRoot && state.browseRoot.id === r.id;
      return `<details class="b-root" data-root="${r.id}" ${active ? "open" : ""}><summary title="${esc(r.path)}">${esc(r.name)}<button class="b-close" data-close="${r.id}" title="Close folder">✕</button></summary><ul class="b-tree" data-root="${r.id}" data-path=""></ul></details>`;
    }).join("") + `</div>`;
    for (const ul of browseEl.querySelectorAll(".b-root[open] > .b-tree")) fillTree(ul);
  }

  /** Highlight whatever is on screen, without rebuilding either tree. */
  function markActive() {
    for (const a of treesEl.querySelectorAll("a.active, .t-inbox.active")) a.classList.remove("active");
    if (state.view === "inbox") inboxRowEl.querySelector(".t-inbox")?.classList.add("active");
    else if (state.view === "browse" && state.browseRoot) browseEl.querySelector(`.b-file a[data-browse="${state.browseRoot.id}"][data-path="${CSS.escape(state.browsePath)}"]`)?.classList.add("active");
    else if (state.doc) treeEl.querySelector(`a[data-id="${state.doc.id}"]`)?.classList.add("active");
  }

  /** Both names are guesses — a directory name and a session's first document — so
   *  each carries the means to correct it, shown when the row is under the cursor. */
  const renameBtn = (what, id) =>
    `<button class="ren" data-rename="${what}" data-id="${id}" title="Rename ${what}" aria-label="Rename ${what}">✎</button>`;

  /** A project is drawn expanded when the reader left it that way, when the
   *  document on screen is in it, or when it is the only one there is. */
  const projOpen = p => openProjects.has(String(p.id)) || (state.doc && state.doc.project_id === p.id) || state.tree.length === 1;

  const docRow = d => {
    const active = state.doc && state.doc.id === d.id ? "active" : "";
    return `<li class="t-doc"><a href="/d/${d.id}" class="${active}" data-id="${d.id}" title="${esc(d.title)} · ${fmt(d.received_at)}"><span class="title">${esc(d.title)}</span>${d.pinned ? `<span class="pin" title="Pinned">●</span>` : ""}<span class="k">${kindTag(d.kind)}</span></a></li>`;
  };

  /** The rows inside one project: its sessions, their documents, and — where a
   *  cap left something out — what it would take to see the rest. A project
   *  this tab has not fetched yet is a single row saying so, which is the only
   *  state this can be in that is neither empty nor complete. */
  function projectRows(p) {
    const wfs = state.sub.get(String(p.id));
    if (!wfs) return `<li class="t-wait">…</li>`;
    let h = "";
    for (const w of wfs) {
      h += `<li class="t-wf"><div class="wf-name" title="${esc(w.key)}"><span class="nm">${esc(w.title)}</span>${renameBtn("workflow", w.id)}</div><ul>`;
      for (const d of w.docs) h += docRow(d);
      if (w.total > w.docs.length) h += `<li class="t-more"><button type="button" data-more-docs="${w.id}">${w.total - w.docs.length} older</button></li>`;
      h += `</ul></li>`;
    }
    if (p.workflows > wfs.length) h += `<li class="t-more"><button type="button" data-more-wf="${p.id}">${p.workflows - wfs.length} older sessions</button></li>`;
    return h;
  }

  /** The sidebar, which is a list of projects and the rows of the ones that are
   *  open. A closed project contributes nothing to the page: this used to carry
   *  every document in the library on every page open — 13,000 rows and a
   *  718 ms task at 3000 documents — and what is behind a row is now two
   *  numbers until a reader asks for it. */
  function renderTree() {
    const projects = state.tree;
    const total = projects.reduce((n, p) => n + p.docs, 0);
    inboxRowEl.innerHTML = `<div class="t-inbox ${state.view === "inbox" ? "active" : ""}" data-nav="inbox"><span>Inbox</span><span class="n">${total}</span></div>`;
    renderBrowse();
    if (!projects.length) {
      treeEl.innerHTML = state.browse.length ? "" : `<div class="t-empty">Nothing here yet. Send something:<br><code>snyvi send README.md</code><br><br>Or read a folder:<br><code>snyvi browse .</code></div>`;
      return;
    }
    // Labels only earn their space when both kinds of tree are on screen.
    let h = state.browse.length ? `<div class="t-label">Projects</div>` : "";
    for (const p of projects) {
      const open = projOpen(p);
      const unread = state.unread.get(p.id) || 0;
      h += `<details class="t-proj" data-pid="${p.id}" ${open ? "open" : ""}><summary title="${esc(p.root)}"><span class="nm">${esc(p.name)}</span>${unread ? `<span class="badge">${unread}</span>` : ""}${renameBtn("project", p.id)}</summary><ul>`;
      h += open ? projectRows(p) : "";
      h += `</ul></details>`;
    }
    treeEl.innerHTML = h;
    // A project the reader has open that this tab has never filled: the "…" is
    // on screen, so fetching it now is what turns it into rows.
    for (const p of projects) if (projOpen(p) && !state.sub.has(String(p.id))) fillProject(p.id);
  }

  /** What one project holds, fetched the first time it is expanded and kept
   *  until the library moves under it. */
  async function fillProject(pid, force) {
    pid = String(pid);
    if (filling.has(pid) || (!force && (state.sub.has(pid) || tried.has(pid)))) return;
    filling.add(pid);
    tried.add(pid);
    // The workflow on screen comes back whole in the same answer, so an arrival
    // cannot re-cap the session a reader is stepping through.
    const q = new URLSearchParams();
    if (liftedCaps.has(pid)) { q.set("workflows", "0"); q.set("docs", "0"); }
    if (state.doc && String(state.doc.project_id) === pid) q.set("whole", state.doc.workflow_id);
    try {
      const wfs = await (await fetch(`/api/projects/${pid}/tree${q.size ? `?${q}` : ""}`)).json();
      if (Array.isArray(wfs)) state.sub.set(pid, wfs);
    } catch {}
    filling.delete(pid);
    // A session a reader had opened out in full, refetched capped: put it back.
    await Promise.all((state.sub.get(pid) || [])
      .filter(w => liftedWorkflows.has(w.id) && w.docs.length < w.total)
      .map(w => fillWorkflow(w.id, pid)));
    renderTree();
    markActive();
  }

  /** One session, whole, dropped into the subtree it belongs to. What "N older"
   *  asks for, and what puts a lifted cap back after a refetch. */
  async function fillWorkflow(wid, pid) {
    let w;
    try { w = await (await fetch(`/api/workflows/${wid}/tree`)).json(); } catch { return; }
    if (!w || !Array.isArray(w.docs)) return;
    const wfs = state.sub.get(String(pid));
    if (!wfs) return;
    const at = wfs.findIndex(x => x.id === wid);
    if (at >= 0) wfs[at] = w; else wfs.unshift(w);
    state.sub.set(String(pid), wfs);
  }

  /** The workflow a reader is in is held whole, because `[` and `]` step through
   *  its documents and a cap would stop them somewhere arbitrary. The server
   *  sends it with the page it is opened from; a navigation inside the tab asks
   *  for it here. */
  async function ensureWorkflow(doc) {
    if (!doc) return;
    const pid = String(doc.project_id);
    if (!state.sub.has(pid)) await fillProject(pid);
    const wfs = state.sub.get(pid);
    if (!wfs) return;
    const at = wfs.findIndex(w => w.id === doc.workflow_id);
    if (at >= 0 && wfs[at].docs.length >= wfs[at].total) return;
    // A document opened out of a search can be in a session older than the few
    // a project shows. `fillWorkflow` puts it at the top: the reader is in it.
    await fillWorkflow(doc.workflow_id, pid);
    renderTree();
    markActive();
  }

  /** The library moved: refetch the project rows, and the subtrees this tab has
   *  already filled. Dropping them instead would collapse an expanded project
   *  to a "…" under the reader. `only` narrows it to one project, which is what
   *  an arrival needs — nothing else in the library moved.  */
  async function refreshTree(only) {
    try { state.tree = await (await fetch("/api/tree")).json(); } catch {}
    const pids = only != null ? [String(only)] : [...state.sub.keys()];
    await Promise.all(pids.filter(pid => state.sub.has(pid)).map(pid => fillProject(pid, true)));
    renderTree();
    markActive();
  }

  const entryHtml = (rootId, e) => e.dir
    ? `<li class="b-dir"><details data-root="${rootId}" data-path="${esc(e.path)}"><summary>${esc(e.name)}</summary><ul class="b-tree" data-root="${rootId}" data-path="${esc(e.path)}"></ul></details></li>`
    : `<li class="b-file"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}" title="${esc(e.path)}"><span class="title">${esc(e.name)}</span><span class="k">${fmtSize(e.size)}</span></a></li>`;

  /** Fetch one directory level the first time its folder is opened. */
  async function fillTree(ul) {
    if (!ul || ul.dataset.loaded) return;
    ul.dataset.loaded = "1";
    ul.innerHTML = `<li class="b-empty">…</li>`;
    const rootId = ul.dataset.root, path = ul.dataset.path || "";
    let entries;
    try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=${encodeURIComponent(path)}`)).json(); } catch { ul.dataset.loaded = ""; return; }
    if (!Array.isArray(entries)) { ul.dataset.loaded = ""; return; }
    if (!entries.length) { ul.innerHTML = `<li class="b-empty">empty</li>`; return; }
    ul.innerHTML = entries.map(e => entryHtml(rootId, e)).join("");
    markActive();
  }

  /** The folder changed on disk: re-list it, keeping the nodes that are still there
   *  so expanded subfolders stay expanded and nothing flickers. */
  async function reloadTree(ul) {
    if (!ul || !ul.dataset.loaded) return;
    const rootId = ul.dataset.root, path = ul.dataset.path || "";
    let entries;
    try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=${encodeURIComponent(path)}`)).json(); } catch { return; }
    if (!Array.isArray(entries) || !ul.isConnected) return;
    const old = new Map([...ul.children].map(li => [li.querySelector("[data-path]")?.dataset.path, li]));
    const tpl = document.createElement("template");
    const nodes = entries.map(e => {
      const li = old.get(e.path);
      if (li && li.classList.contains(e.dir ? "b-dir" : "b-file")) {
        const k = li.querySelector(".k"); if (k) k.textContent = fmtSize(e.size);
        return li;
      }
      tpl.innerHTML = entryHtml(rootId, e);
      return tpl.content.firstElementChild;
    });
    if (!nodes.length) { ul.innerHTML = `<li class="b-empty">empty</li>`; return; }
    ul.replaceChildren(...nodes);
    markActive();
  }
  treesEl.addEventListener("toggle", e => {
    const d = e.target;
    if (d.dataset && d.dataset.root && d.open) {
      fillTree(d.querySelector(":scope > .b-tree"));
      return;
    }
    if (!d.classList || !d.classList.contains("t-proj")) return;
    const pid = d.dataset.pid;
    d.open ? openProjects.add(pid) : openProjects.delete(pid);
    store.set("snyvi.open", [...openProjects].join(","));
    // Opening draws what this tab already holds and fetches what it does not;
    // closing takes the rows back out of the page, which is the bound.
    //
    // The rows go straight into this project's list rather than through
    // renderTree, and that is not a shortcut: an element created with `open`
    // fires `toggle` in Chrome, so rebuilding the whole sidebar from here
    // creates the <details open> that called us and the two render each other
    // for as long as the tab is open. Measured before this was written: the
    // page never fired its load event at all, and the browser bench, which
    // waits for it, hung rather than failed.
    const ul = d.querySelector(":scope > ul");
    if (!ul) return;
    if (!d.open) {
      ul.innerHTML = "";
      return;
    }
    // Already drawn -- this is the event that a render fires at itself.
    if (ul.firstChild) return;
    const p = state.tree.find(x => String(x.id) === pid);
    if (!p) return;
    if (state.sub.has(pid)) {
      ul.innerHTML = projectRows(p);
      markActive();
    } else {
      // Asked for by hand, so a project whose fill failed earlier is tried again.
      fillProject(pid, true);
    }
  }, true);

  treesEl.addEventListener("click", async e => {
    // Past a cap, and the answer to "show me the rest" is the rest: a whole
    // session's documents, or every session in the project.
    const more = e.target.closest("[data-more-docs], [data-more-wf]");
    if (more) {
      e.preventDefault(); e.stopPropagation();
      more.disabled = true;
      if (more.dataset.moreWf != null) {
        liftedCaps.add(String(more.dataset.moreWf));
        await fillProject(more.dataset.moreWf, true);
      } else {
        const wid = Number(more.dataset.moreDocs);
        const pid = [...state.sub.keys()].find(k => state.sub.get(k).some(w => w.id === wid));
        liftedWorkflows.add(wid);
        await fillWorkflow(wid, pid);
        renderTree(); markActive();
      }
      return;
    }
    const r = e.target.closest("[data-rename]");
    if (r) {
      // Inside a <summary>, the default action is toggling the project open.
      e.preventDefault(); e.stopPropagation();
      startRename(r);
      return;
    }
    const b = e.target.closest("[data-close]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const id = b.dataset.close;
    try { await fetch(`/api/browse/${id}/close`, { method: "POST" }); } catch {}
    state.browse = state.browse.filter(r => r.id !== id);
    if (state.browseRoot && state.browseRoot.id === id) showInbox(true); else renderTree();
  });

  /** Turn a name in the tree into a field, in place. Enter and blur keep what was
   *  typed, Escape abandons it; the label goes back the moment either happens, so
   *  the tree is never left holding an input. */
  function startRename(btn) {
    const holder = btn.parentElement;
    const label = holder.querySelector(":scope > .nm");
    if (!label || holder.querySelector("input.ren-in")) return;
    const what = btn.dataset.rename, id = +btn.dataset.id, before = label.textContent;
    const input = document.createElement("input");
    input.className = "ren-in";
    input.value = before;
    input.spellcheck = false;
    input.setAttribute("aria-label", `Name of this ${what}`);
    label.replaceWith(input);
    holder.classList.add("renaming");
    input.focus(); input.select();

    let settled = false;
    const finish = async keep => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      const label = document.createElement("span");
      label.className = "nm";
      label.textContent = before;
      input.replaceWith(label);
      holder.classList.remove("renaming");
      if (!keep || !next || next === before) return;
      label.textContent = next;   // stands in until the tree comes back
      try {
        const where = what === "project" ? "projects" : "workflows";
        const r = await fetch(`/api/${where}/${id}/rename`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: next }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await applyRename(what, id);
      } catch (e) {
        label.textContent = before;
        toast("Could not rename", String(e));
      }
    };
    // The app answers single keys, and Escape closes find and the palette.
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      else e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    // A click in the field must not open the document or fold the project.
    input.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); });
  }

  /** Fold a rename into everything showing it: the tree, and the open document,
   *  whose header and rail name its project and workflow too. */
  async function applyRename(what, id) {
    state.cache.clear();
    await refreshTree();
    const shown = state.doc && (what === "project" ? state.doc.project_id === id : state.doc.workflow_id === id);
    if (shown) await refreshDoc(state.doc.id);
  }

  /** Flat list of doc ids in sidebar order, for j/k. Read off the rows rather
   *  than out of the model, now that the model holds only what a reader has
   *  expanded: "next document" is the next one they can see. */
  const order = () => [...treeEl.querySelectorAll("a[data-id]")].map(a => a.dataset.id);
  /** Every document in the workflow on screen, for `[` and `]`. Exact whatever
   *  the caps are: the workflow a reader is in is the one held whole. */
  const siblings = () => {
    if (!state.doc) return [];
    for (const w of state.sub.get(String(state.doc.project_id)) || []) {
      if (w.id === state.doc.workflow_id) return w.docs.map(d => d.id);
    }
    return [];
  };

  // ---------- preview ----------
  /** Remember the choice per file, and start a PDF in the viewer since its source is bytes. */
  function setPreview(kind, url, key) {
    if (state.previewKey !== key) { state.previewKey = key; state.previewOn = kind === "pdf"; }
    state.preview = kind || null;
    state.previewUrl = url || null;
    if (!state.preview) state.previewOn = false;
  }

  /** Swap the rendered body for the page itself.
   *
   *  An HTML page is sandboxed WITHOUT allow-same-origin on purpose: that pair gives
   *  it an opaque origin, so its scripts run — the preview is faithful — but cannot
   *  read snyvi's DOM, storage or API responses. Adding allow-same-origin here would
   *  hand every HTML file in a browsed folder the run of the library.
   *
   *  A PDF gets no sandbox attribute, because the browser's own viewer refuses to run
   *  inside one and shows a broken page instead. That is safe for a different reason:
   *  the bytes are served as application/pdf with nosniff, so they can only ever reach
   *  the PDF viewer, never be parsed as a page in our origin. */
  function applyPreview() {
    const art = docEl.querySelector("article");
    if (!art || !state.previewOn || !state.previewUrl) return;
    const wrap = document.createElement("article");
    wrap.className = "preview";
    const frame = document.createElement("iframe");
    if (state.preview !== "pdf") frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "Preview");
    frame.src = state.previewUrl;
    wrap.appendChild(frame);
    art.replaceWith(wrap);
  }

  function togglePreview() {
    if (!state.preview) return;
    state.previewOn = !state.previewOn;
    if (state.doc) showDoc(state.doc.id, false);
    else if (browsing()) showBrowse(state.browseRoot.id, state.browsePath, false);
  }

  // ---------- documents ----------
  function docHtml(doc, body) {
    let sub = `${esc(doc.project)} · ${esc(doc.workflow_title)}`;
    if (doc.branch) sub += ` · <span class="branch">${esc(doc.branch)}</span>`;
    sub += ` · ${fmt(doc.received_at)}`;
    return `<header class="doc-head"><h1 class="doc-title">${esc(doc.title)}</h1><p class="doc-sub">${sub}</p></header><article class="prose kind-${doc.kind}">${body}</article>`;
  }

  async function fetchDoc(id) {
    if (state.cache.has(id)) return state.cache.get(id);
    const r = await fetch(`/api/docs/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (state.cache.size > 40) state.cache.delete(state.cache.keys().next().value);
    state.cache.set(id, j);
    return j;
  }

  async function showDoc(id, push = true) {
    let j;
    try { j = await fetchDoc(id); } catch (e) { toast("Could not open document", String(e)); return; }
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous; state.comparing = null; state.folder = j.folder;
    state.unread.delete(j.doc.project_id);
    setPreview(j.preview, j.preview_url, `d:${id}`);
    docEl.innerHTML = j.html;
    applyPreview();
    if (j.doc.kind === "diff" && state.split) { await applySplit(); }
    document.title = j.doc.title;
    if (push) history.pushState({ id }, "", `/d/${id}`);
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
  }

  function browseHtml(f, root) {
    const sub = `${esc(root.name)} · ${esc(f.path)} · ${fmtSize(f.size)} · ${rel(f.modified)}`;
    return `<header class="doc-head"><h1 class="doc-title">${esc(f.name)}</h1><p class="doc-sub">${sub}</p></header><article class="prose kind-${f.kind}">${f.html}</article>`;
  }

  async function showBrowse(rootId, path, push = true) {
    path = path || "";
    if (!path) {
      // No file asked for and no README: show the folder's contents.
      let entries = [], root = state.browse.find(r => r.id === rootId);
      try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=`)).json(); } catch {}
      state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
      state.browseRoot = root || state.browseRoot; state.browsePath = "";
      setPreview(null, null, `b:${rootId}:`);
      document.title = root ? root.name : "snyvi";
      if (push) history.pushState({ browse: rootId, path: "" }, "", `/b/${rootId}`);
      docEl.innerHTML = `<div class="inbox-head"><h1>${esc(root ? root.name : "Folder")}</h1><p>${esc(root ? root.path : "")}</p></div><ul class="inbox">` +
        entries.map(e => `<li><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}"><span class="title">${e.dir ? "▸ " : ""}${esc(e.name)}</span><span class="time">${e.dir ? "" : fmtSize(e.size)}</span></a></li>`).join("") + `</ul>`;
      main.scrollTo({ top: 0, behavior: "instant" });
      afterRender();
      return;
    }
    let j;
    try {
      const r = await fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch (e) { toast("Could not open file", String(e)); return; }
    state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
    state.browseRoot = j.root; state.browsePath = path;
    setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
    docEl.innerHTML = browseHtml(j.file, j.root);
    applyPreview();
    document.title = j.file.name;
    if (push) history.pushState({ browse: rootId, path }, "", `/b/${rootId}/${path}`);
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
  }

  async function showInbox(push = true) {
    state.view = "inbox"; state.doc = null; state.previous = null; state.browseRoot = null;
    let items = boot.inbox;
    if (!items || push) {
      try { items = await (await fetch("/api/inbox?limit=60")).json(); } catch { items = []; }
    }
    boot.inbox = null;
    document.title = "snyvi";
    if (push) history.pushState({ inbox: true }, "", "/");
    if (!items.length) {
      docEl.innerHTML = `<div class="empty-state"><h1>Nothing to read yet</h1><p>Documents your agents send will appear here, filed by project.</p><pre>snyvi send PLAN.md\nsnyvi init-claude</pre></div>`;
    } else {
      docEl.innerHTML = `<div class="inbox-head"><h1>Inbox</h1><p>Newest first, across every project.</p></div><ul class="inbox">` +
        items.map(d => `<li><a href="/d/${d.id}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`).join("") + `</ul>`;
    }
    afterRender();
  }

  async function showCompare(aId, bId) {
    const cur = state.doc;
    const a = aId || state.previous, b = bId || (cur && cur.id);
    if (!cur || !a) { toast("No previous version", "This is the first document in its workflow."); return; }
    let j;
    try { j = await (await fetch(`/api/compare/${a}/${b}${state.split ? "?view=split" : ""}`)).json(); } catch (e) { toast("Compare failed", String(e)); return; }
    state.comparing = { a, b };
    docEl.innerHTML = `<header class="doc-head"><h1 class="doc-title">${esc(cur.title)}</h1><p class="doc-sub">changes ${fmt(j.a.received_at)} → ${fmt(j.b.received_at)}${state.split ? " · split" : " · inline"}</p></header><article class="prose kind-diff">${j.html}</article>`;
    main.scrollTo({ top: 0, behavior: "instant" });
    buildToc(); renderMeta(true); enhanceCode();
  }

  /** Replace the inline diff body of a diff document with the side-by-side rendering. */
  async function applySplit() {
    const art = docEl.querySelector("article.kind-diff");
    if (!art || !state.doc) return;
    try { const j = await (await fetch(`/api/docs/${state.doc.id}/split`)).json(); art.innerHTML = j.html; } catch {}
  }

  async function toggleSplit() {
    state.split = !state.split;
    store.set("snyvi.split", state.split ? "1" : "0");
    if (state.comparing) { await showCompare(state.comparing.a, state.comparing.b); return; }
    if (state.doc && state.doc.kind === "diff") { state.cache.delete(state.doc.id); await showDoc(state.doc.id, false); }
    else toast("Split view", state.split ? "on, for diffs" : "off");
  }

  async function deleteCurrent() {
    if (!state.doc) return;
    const d = state.doc;
    if (!window.confirm(`Delete "${d.title}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/docs/${d.id}/delete`, { method: "POST" });
      state.cache.delete(d.id);
      await refreshTree(d.project_id);
      toast("Deleted", d.title);
      showInbox(true);
    } catch (e) { toast("Could not delete", String(e)); }
  }

  function afterRender() {
    renderTree();
    markActive();
    ensureWorkflow(state.doc);
    buildToc();
    renderMeta(false);
    enhanceCode();
    prepareMermaid();
    renderHistory();
    clearFind();
    applyLineHash(true);
  }

  /** The body was swapped under the reader: rebuild what hangs off it, keep the sidebar. */
  function afterRefresh() {
    buildToc();
    renderMeta(false);
    enhanceCode();
    prepareMermaid();
    renderHistory();
    if (!findBar.hidden && findIn.value) runFind(findIn.value); else clearFind();
    applyLineHash(false);   // the scroll position is restored by the caller
  }

  // ---------- live refresh ----------
  /** A stored document was overwritten (a hook or `snyvi watch` send) or finished
   *  highlighting: fetch it again and swap the body in place, keeping the scroll. */
  async function refreshDoc(id) {
    state.cache.delete(id);
    if (!state.doc || state.doc.id !== id || state.comparing) return;
    const top = main.scrollTop;
    let j; try { j = await fetchDoc(id); } catch { return; }
    if (!state.doc || state.doc.id !== id) return;
    state.doc = j.doc; state.previous = j.previous; state.folder = j.folder;
    setPreview(j.preview, j.preview_url, `d:${id}`);
    docEl.innerHTML = j.html;
    applyPreview();
    if (j.doc.kind === "diff" && state.split) await applySplit();
    main.scrollTop = top;
    afterRefresh();
  }

  /** The browsed file on screen changed on disk. */
  async function refreshBrowsed() {
    if (!browsing() || !state.browsePath) return;
    const rootId = state.browseRoot.id, path = state.browsePath;
    let j;
    try {
      const r = await fetch(`/api/browse/${rootId}/file?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch {
      toast(`${path.split("/").pop()} is gone`, "removed or renamed on disk; showing the last version");
      return;
    }
    // The reader moved on while this was in flight.
    if (!browsing() || state.browseRoot.id !== rootId || state.browsePath !== path) return;
    const top = main.scrollTop;
    setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
    docEl.innerHTML = browseHtml(j.file, j.root);
    applyPreview();
    main.scrollTop = top;
    afterRefresh();
  }

  // ---------- mermaid (loaded only when a diagram is actually wanted) ----------
  /* A diagram is drawn when the reader is near it, one per task, and never as
   * part of the render that puts the document on screen. `mermaid.run` drew
   * every diagram on the page in one unyielding call: a 220-node flowchart
   * froze the tab for 3.1 seconds, during which it neither scrolled nor
   * answered a key. docs/DIAGRAMS.md has the measurements; bench/browser.mjs
   * keeps them honest. */
  let mermaidReady = null;   // the library, once something has asked for it
  let mermaidTheme = null;   // the theme it was last initialised with
  let mmdToken = 0;          // bumped when the body is replaced; queued work checks it
  let mmdQueue = [];
  let mmdDraining = false;
  let mmdSeq = 0;
  let mmdWatcher = null;

  /* A diagram is a pure function of its source and the theme, and a stored
   * document never changes, so no SVG in this tab is worth computing twice.
   * Measured before this existed: revisiting a document drew the 220-node
   * flowchart again for another 2426 ms, and `snyvi watch` paid the same price
   * on every save of the file it was watching.
   *
   * A source that cannot be parsed is remembered as well, so the rule is the
   * whole of it: no source is handed to Mermaid twice in one tab. The failure
   * is a fact about the source in exactly the way the drawing is, and the
   * document holding it is the one a reader re-opens to look at what the agent
   * actually wrote.
   *
   * What is kept is the SVG with the id it was drawn under swapped for a token.
   * That id is the one part of the string that belongs to the figure rather
   * than to the drawing -- Mermaid writes it into the root element, into an
   * id-scoped <style> block, and into the ids of the markers its edges point at
   * -- so a document carrying the same diagram twice would otherwise put two of
   * each into the page and let the second one's arrowheads resolve to the
   * first.
   *
   * Bounded in bytes rather than in entries, because one diagram's SVG is two
   * orders of magnitude larger than another's, and a tab left open all day
   * reading documents is exactly the tab this project promises will stay
   * small. */
  const mmdCache = new Map();          // `theme\nsource` -> {svg} or {err}, least recent first
  const MMD_CACHE_BYTES = 4 << 20;
  const MMD_ID = "__mmd_id__";
  let mmdCacheBytes = 0;

  const mmdRenderId = fig => `${fig.dataset.mmdId}-svg`;
  const mmdKey = src => `${mmdCurrentTheme()}\n${src}`;
  const mmdCached = src => mmdCache.has(mmdKey(src));

  const mmdSize = e => (e.svg || e.err || "").length;

  function mmdTake(key) {
    const entry = mmdCache.get(key);
    if (entry === undefined) return null;
    // Re-inserted, so the Map's own insertion order is least-recent-first and
    // eviction is a walk from the front.
    mmdCache.delete(key);
    mmdCache.set(key, entry);
    return entry;
  }

  function mmdKeep(key, entry) {
    if (mmdCache.has(key)) mmdCacheBytes -= mmdSize(mmdCache.get(key));
    mmdCache.set(key, entry);
    mmdCacheBytes += mmdSize(entry);
    for (const [k, v] of mmdCache) {
      // Never the entry just asked for, even when it is alone and over the
      // budget by itself: evicting it would make the next visit pay again for
      // the one diagram most likely to be wanted.
      if (mmdCacheBytes <= MMD_CACHE_BYTES || k === key) break;
      mmdCache.delete(k);
      mmdCacheBytes -= mmdSize(v);
    }
  }

  /** Past this a diagram is offered rather than drawn. The flowchart that
   *  started all this costs 2.4 s of CPU however it is scheduled, and spending
   *  that on a reader who was scrolling past is not a thing a scheduler can
   *  make polite. */
  const MMD_CAP_LINES = 150, MMD_CAP_BYTES = 20000;

  /** What a diagram will cost, judged from its source: Mermaid draws roughly one
   *  node or edge per line that is neither blank nor a `%%` comment. */
  function mmdWeight(src) {
    let n = 0;
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("%%")) n++;
    }
    return n;
  }

  const yieldToBrowser = () =>
    window.scheduler && window.scheduler.yield
      ? window.scheduler.yield()
      : new Promise(r => setTimeout(r, 0));

  /** Put something in the frame in place of the diagram: a label, a spinner, a
   *  button, an error. Replacing the frame's contents wholesale is what makes
   *  the states exclusive -- there is never a stale spinner under an SVG. */
  function mmdNote(fig, ...nodes) {
    const note = document.createElement("div");
    note.className = "mmd-note";
    note.append(...nodes);
    const frame = fig.querySelector(".mmd-frame");
    frame.textContent = "";
    frame.append(note);
    return note;
  }

  /** Every `<pre class="mermaid">` the server sent becomes a placeholder of about
   *  the right size, watched for coming near the viewport. Called wherever the
   *  body changes, and the bumped token is what stops a diagram queued for the
   *  document the reader just left from being drawn into a detached node. */
  /** Generous, so a diagram is drawn by the time it is scrolled to rather than
   *  after: a screen of margin is roughly a flick of the wheel. */
  function mmdWatch() {
    if (mmdWatcher) mmdWatcher.disconnect();
    mmdWatcher = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        mmdWatcher.unobserve(e.target);
        mmdEnqueue(e.target);
      }
    }, { root: main, rootMargin: "600px 0px" });
  }

  function prepareMermaid() {
    mmdToken++;
    mmdQueue = [];
    if (mmdWatcher) mmdWatcher.disconnect();
    mmdWatcher = null;
    const pres = docEl.querySelectorAll("pre.mermaid");
    if (!pres.length) return;
    mmdWatch();
    for (const pre of pres) {
      const fig = document.createElement("figure");
      fig.className = "mmd";
      fig.dataset.src = pre.textContent.trim();
      fig.dataset.mmdId = `mmd-${++mmdSeq}`;
      const frame = document.createElement("div");
      frame.className = "mmd-frame";
      fig.appendChild(frame);
      pre.replaceWith(fig);
      mmdReserve(fig);
    }
    mmdPrefetch();
  }

  /** The theme moved, so every diagram on the page was drawn in the other one.
   *  Put them all back to placeholders and queue what is near the viewport
   *  again: for anything this tab has already drawn in the theme being returned
   *  to, that costs a string assignment, since the theme is half of the cache
   *  key. Nothing is dropped -- toggling back is free as well, and the byte
   *  bound is what keeps holding both from mattering. */
  function mmdRetheme() {
    const figs = [...docEl.querySelectorAll(".mmd")];
    if (!figs.length) return;
    mmdToken++;
    mmdQueue = [];
    mmdWatch();
    for (const fig of figs) mmdReserve(fig);
  }

  /** A figure, in the state it starts in: a box of about the right size, and
   *  either a place in the queue or an offer to draw it. Shared by the first
   *  pass over a document and by a theme change, which starts them all over. */
  function mmdReserve(fig) {
    const src = fig.dataset.src;
    const weight = mmdWeight(src);
    fig.classList.remove("mmd-slow");
    // An estimate and only that: the source says how much there is to draw,
    // never how tall the drawing will be. Measured on the fixture in
    // bench/fixture.mjs, a small flowchart lands at 258 px and a nine-line
    // sequence diagram at 383, so the floor sits between them rather than
    // under both -- half a screen of settling either way beats a full one in
    // one direction. Phase 3 is what makes this exact: a diagram in a frame of
    // a bounded height is a height that can be reserved rather than guessed.
    fig.style.setProperty("--mmd-reserve", `${Math.min(520, Math.max(240, 170 + weight * 4))}px`);
    // The cap is about cost, and a diagram already drawn in this tab has none:
    // a reader who asked for this one once is not asked again on the way back.
    if ((weight > MMD_CAP_LINES || src.length > MMD_CAP_BYTES) && !mmdCached(src)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mmd-ask";
      btn.dataset.mmdRender = "";
      btn.textContent = "Render diagram";
      const why = document.createElement("span");
      why.className = "mmd-why";
      why.textContent = `${weight} lines — this one takes a moment`;
      // An offer, not a diagram on its way: it reserves room for itself and
      // not for the drawing behind it, which arrives only if asked for.
      fig.style.setProperty("--mmd-reserve", "150px");
      fig.dataset.state = "held";
      mmdNote(fig, btn, why);
    } else {
      fig.dataset.state = "pending";
      mmdNote(fig, document.createTextNode("Diagram"));
      mmdWatcher.observe(fig);
    }
  }

  /** Ask for the library as soon as a page is known to hold a diagram at all,
   *  in idle time, rather than when a diagram comes near the viewport.
   *
   *  Measured: the first diagram on a page lands at ~1170 ms, of which ~490 ms
   *  is one unbreakable task compiling 3.57 MB of JavaScript -- and none of it
   *  used to start until the reader had scrolled to the diagram, which is the
   *  worst possible moment to begin. Spent here it is spent while they are
   *  still reading the first screen, and by the time they arrive only the
   *  drawing is left. A page with no diagram asks for nothing, which is most
   *  pages; a tab that already has the library asks again for nothing at all.
   *
   *  `requestIdleCallback` rather than a timer, so this waits for a gap instead
   *  of making one. The timeout is the floor under a tab that never has a gap:
   *  the compile is coming either way, and sooner is a better moment than the
   *  one the reader chose. */
  function mmdPrefetch() {
    if (mermaidReady) return;
    const go = () => { if (!mermaidReady) mermaidLib().catch(() => {}); };
    if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2000 });
    else setTimeout(go, 400);
  }

  function mmdEnqueue(fig) {
    if (fig.dataset.state === "queued" || fig.dataset.state === "rendering" || fig.dataset.state === "done") return;
    fig.dataset.state = "queued";
    mmdNote(fig, document.createTextNode("Diagram"));
    mmdQueue.push(fig);
    mmdDrain();
  }

  /** The library, fetched the first time a diagram is actually wanted. The marks
   *  are what let bench/browser.mjs tell a long task spent compiling 3.57 MB of
   *  Mermaid from one spent drawing with it -- two different faults with two
   *  different fixes. */
  function mermaidLib() {
    if (!mermaidReady) {
      performance.mark("snyvi:mermaid-load");
      mermaidReady = new Promise((res, rej) => {
        const sc = document.createElement("script");
        // Versioned like every other asset: the bundle is served immutable for
        // a year, so without this a browser would keep the first one it ever
        // saw across every upgrade.
        sc.src = `/assets/mermaid.js${boot.v ? `?v=${boot.v}` : ""}`;
        sc.onload = () => { performance.mark("snyvi:mermaid-ready"); res(); };
        sc.onerror = () => rej(new Error("could not load the diagram library"));
        document.head.appendChild(sc);
      });
    }
    return mermaidReady;
  }

  /** `initialize` decides the theme of the next render and nothing else, so it is
   *  called when the theme has moved rather than once. Diagrams already drawn
   *  keep the theme they were drawn in; re-drawing them belongs with the cache. */
  function mmdCurrentTheme() {
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? "dark" : "light";
  }

  /** The diagram is drawn in the viewer's own palette, read off `:root` rather
   *  than written out again here -- so a token changed in app.css moves the
   *  diagrams with it and the two cannot drift.
   *
   *  `theme: "base"` is the lever: it is the only theme that takes
   *  `themeVariables` at all, which is why `neutral` could never be nudged into
   *  the palette one value at a time. What a colour cannot say goes in
   *  `themeCSS`, which Mermaid emits inside each diagram's own `#id`-scoped
   *  <style> block, after its own rules -- so it wins by order, where the same
   *  rules in app.css would lose on specificity and need `!important` on every
   *  line. */
  function mmdTheme() {
    const cs = getComputedStyle(root);
    const v = n => cs.getPropertyValue(n).trim();
    const bg = v("--bg"), raise = v("--bg-raise"), side = v("--bg-side");
    const fg = v("--fg"), fg2 = v("--fg-2"), fg3 = v("--fg-3");
    const rule = v("--rule"), rule2 = v("--rule-2");
    const accent = v("--accent"), accentBg = v("--accent-bg");
    return {
      fontFamily: v("--sans"),
      themeVariables: {
        background: bg, edgeLabelBackground: bg,
        mainBkg: raise, primaryColor: raise, actorBkg: raise, stateBkg: raise,
        secondaryColor: side, clusterBkg: side, labelBoxBkgColor: side,
        primaryTextColor: fg, textColor: fg, nodeTextColor: fg,
        // Mermaid computes `stateLabelColor = stateLabelColor || stateBkg ||
        // primaryTextColor`, so mapping stateBkg to the box's own fill -- which
        // is right for the box -- paints every state label the colour of the
        // thing behind it. Measured: white on white, labels present in the DOM,
        // correctly positioned, invisible. Named explicitly, it cannot happen.
        stateLabelColor: fg,
        signalColor: fg2, signalTextColor: fg2, titleColor: fg2,
        lineColor: fg3,
        clusterBorder: rule,
        nodeBorder: rule2, primaryBorderColor: rule2, actorBorder: rule2,
        noteBkgColor: accentBg, activationBkgColor: accentBg,
        noteBorderColor: accent, activationBorderColor: accent,
        /* A gantt draws its own everything: bars, section bands, a grid, and
         * text placed inside a bar or beside it depending on how much room
         * there is. None of it derives from the values above, which is how
         * "Scheduler" came to sit at 1.4:1 on its own bar. The text colours are
         * all `--fg` because every bar fill here is within a shade of the page.
         */
        sectionBkgColor: bg, altSectionBkgColor: side, sectionBkgColor2: bg,
        taskBkgColor: raise, taskBorderColor: rule2,
        activeTaskBkgColor: accentBg, activeTaskBorderColor: accent,
        doneTaskBkgColor: side, doneTaskBorderColor: rule2,
        critBkgColor: accentBg, critBorderColor: accent,
        taskTextColor: fg, taskTextDarkColor: fg, taskTextLightColor: fg,
        taskTextOutsideColor: fg2, taskTextClickableColor: accent,
        gridColor: rule, todayLineColor: accent,
      },
      /* Descendant selectors throughout: a `>` comes back HTML-escaped in the
       * SVG string, and while it round-trips correctly through `innerHTML`,
       * anything reading that string as text sees a broken selector. Nothing
       * here needs one.
       *
       * Terse on purpose, and explained here rather than in the string: Mermaid
       * copies themeCSS into every diagram's own <style> block, so a page with
       * eight diagrams carries eight copies of whatever is written below. The
       * rules are measured at ~651 bytes; a paragraph of reasoning would be
       * larger than the rules.
       *
       * The focus label is the paper colour rather than --accent-bg. On paper
       * the accent is a dark orange and --accent-bg a pale wash of it, which
       * reads well; in the dark palette the accent is a *light* orange and
       * --accent-bg is that same orange at 14% alpha, so a label composited
       * onto the fill behind it measured 1.0:1 -- the same colour, twice.
       * --bg is the one token guaranteed to oppose the accent in both
       * palettes, because the accent is chosen to sit on it. */
      themeCSS: `
        .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 1px; }
        .edgePath .path, .flowchart-link { stroke-width: 1.25px; }
        .cluster rect { rx: 8px; ry: 8px; }
        .nodeLabel, .edgeLabel, .label, .messageText, .loopText, .noteText { letter-spacing: .01em; }
        text.title, .titleText { font-family: ${v("--serif")}; font-size: 18px; font-weight: 600; }
        .node.focus rect, .node.focus circle, .node.focus ellipse, .node.focus polygon, .node.focus path { fill: ${accent}; stroke: ${accent}; }
        .node.focus .nodeLabel { color: ${bg}; fill: ${bg}; }
        .node.muted rect, .node.muted circle, .node.muted ellipse, .node.muted polygon, .node.muted path { fill: ${bg}; stroke: ${rule}; }
        .node.muted .nodeLabel { color: ${fg3}; fill: ${fg3}; }
      `,
    };
  }

  function mmdInit() {
    const theme = mmdCurrentTheme();
    if (theme === mermaidTheme) return;
    mermaidTheme = theme;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", ...mmdTheme() });
  }

  /** One diagram per task, yielding between. A 2433 ms diagram is still 2433 ms
   *  of CPU -- but it is one diagram's worth, and every slot boundary hands the
   *  browser back a frame. */
  async function mmdDrain() {
    if (mmdDraining) return;
    mmdDraining = true;
    const token = mmdToken;
    try {
      await mermaidLib();
      if (token !== mmdToken) return;
      mmdInit();
      while (mmdQueue.length && token === mmdToken) {
        const fig = mmdQueue.shift();
        if (!fig.isConnected || fig.dataset.state !== "queued") continue;
        await mmdRender(fig, token);
        if (mmdQueue.length) await yieldToBrowser();
      }
    } catch (e) {
      console.warn("mermaid", e);
      if (token === mmdToken) {
        for (const fig of mmdQueue) if (fig.isConnected) mmdFail(fig, e);
        mmdQueue = [];
      }
    } finally {
      mmdDraining = false;
      // Something may have come near the viewport while the library was loading,
      // or while the diagram before it was drawing. The token is deliberately
      // not consulted here: when the reader navigates mid-render this loop ends
      // on the stale token while the new document's diagrams are already queued,
      // and a restart conditional on the old token would strand them. mmdDrain
      // reads the current token on the way in, so the restart is the new
      // document's, not this one's.
      if (mmdQueue.length) mmdDrain();
    }
  }

  async function mmdRender(fig, token) {
    fig.dataset.state = "rendering";
    const key = mmdKey(fig.dataset.src);
    const hit = mmdTake(key);
    if (hit !== null) {
      // Nothing to wait for, so no spinner and no slow class -- which the
      // on-demand button sets on the way in, before it can know this one is
      // free.
      fig.classList.remove("mmd-slow");
      hit.svg ? mmdPaint(fig, hit.svg, performance.now()) : mmdFail(fig, hit.err);
      return;
    }
    // A spinner only once the wait is long enough to be worth explaining.
    const slow = setTimeout(() => fig.classList.add("mmd-slow"), 150);
    const t0 = performance.now();
    try {
      const id = mmdRenderId(fig);
      const { svg } = await window.mermaid.render(id, fig.dataset.src);
      const kept = svg.split(id).join(MMD_ID);
      // Kept before the token is consulted: the drawing is done and paid for
      // either way, and a reader who navigated away while it was being made is
      // the reader most likely to come straight back to it.
      mmdKeep(key, { svg: kept });
      if (token !== mmdToken || !fig.isConnected) return;
      mmdPaint(fig, kept, t0);
    } catch (e) {
      mmdKeep(key, { err: e && e.message ? e.message : String(e) });
      if (token === mmdToken && fig.isConnected) mmdFail(fig, e);
    } finally {
      clearTimeout(slow);
      fig.classList.remove("mmd-slow");
    }
  }

  /** The cached string carries a token where its id belongs, and the figure it
   *  is painted into supplies one. */
  function mmdPaint(fig, svg, t0) {
    const frame = fig.querySelector(".mmd-frame");
    frame.innerHTML = svg.split(MMD_ID).join(mmdRenderId(fig));
    fig.dataset.state = "done";
    // Named, so the browser budget can find it. A cache hit measures what it
    // actually costs, which is the assignment above.
    performance.measure("snyvi:diagram", { start: t0, end: performance.now() });
  }

  /** Mermaid answers a source it cannot parse with its own error graphic, which
   *  replaces the source -- at exactly the moment the reader wants to see what
   *  the agent wrote. Show what it choked on instead. */
  function mmdFail(fig, e) {
    fig.dataset.state = "error";
    fig.style.removeProperty("--mmd-reserve");
    const msg = document.createElement("p");
    msg.className = "mmd-err";
    msg.textContent = `This diagram could not be drawn — ${e && e.message ? e.message : e}`;
    const pre = document.createElement("pre");
    pre.className = "mmd-src";
    pre.textContent = fig.dataset.src;
    // Not in a .mmd-note: the note is chrome that find skips, and this source is
    // the one thing on the page a reader would most want to search.
    const box = document.createElement("div");
    box.className = "mmd-fail";
    box.append(msg, pre);
    const frame = fig.querySelector(".mmd-frame");
    frame.textContent = "";
    frame.append(box);
  }

  docEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-mmd-render]");
    if (!btn) return;
    const fig = btn.closest(".mmd");
    if (!fig) return;
    fig.dataset.state = "queued";
    mmdNote(fig, document.createTextNode("Drawing…"));
    fig.classList.add("mmd-slow");
    mmdQueue.push(fig);
    mmdDrain();
  });

  // ---------- history (every snapshot of the same file) ----------
  async function renderHistory() {
    const old = $("#history"); if (old) old.remove();
    if (!state.doc || !state.doc.source_path) return;
    let h; try { h = await (await fetch(`/api/docs/${state.doc.id}/history`)).json(); } catch { return; }
    if (!h || h.length < 2) return;
    const box = document.createElement("div"); box.id = "history";
    box.innerHTML = `<h4>Versions · ${h.length}</h4>` + h.map(d => `<a href="/d/${d.id}" data-id="${d.id}" class="${d.id === state.doc.id ? "cur" : ""}" title="${esc(d.workflow_title)}">${fmt(d.received_at)}${d.pinned ? " ●" : ""}</a>`).join("");
    metaEl.appendChild(box);
  }

  // ---------- find in document ----------
  const findBar = $("#find"), findIn = $("#find-input"), findCount = $("#find-count");
  let findMarks = [], findIdx = -1;
  /* An HTML <mark> inside an <svg> lays out at 0x0, so wrapping a diagram's label
   * in one does not highlight it -- it erases it, and counts a match the reader
   * cannot be shown. Diagram text is skipped until there is a way to point at
   * it, which needs the zoom in phase 3 of docs/DIAGRAMS.md. The placeholder
   * label is chrome rather than document text, and would otherwise make every
   * search for "diagram" find one per diagram. */
  const FIND_SKIP = "script,style,.copy,svg,.mmd-note";
  function clearFind() {
    for (const m of findMarks) { const p = m.parentNode; if (!p) continue; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
    findMarks = []; findIdx = -1; findCount.textContent = "";
  }
  function runFind(q) {
    clearFind();
    if (!q) return;
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentNode.closest(FIND_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const texts = []; let n; while ((n = walker.nextNode())) texts.push(n);
    for (const t of texts) {
      let text = t.nodeValue, lower = text.toLowerCase(), pos = lower.indexOf(needle);
      if (pos < 0) continue;
      const frag = document.createDocumentFragment(); let last = 0;
      while (pos >= 0 && findMarks.length < 2000) {
        frag.appendChild(document.createTextNode(text.slice(last, pos)));
        const m = document.createElement("mark"); m.className = "find"; m.textContent = text.slice(pos, pos + q.length);
        frag.appendChild(m); findMarks.push(m);
        last = pos + q.length; pos = lower.indexOf(needle, last);
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      t.parentNode.replaceChild(frag, t);
    }
    if (findMarks.length) gotoFind(0); else findCount.textContent = "0";
  }
  function gotoFind(i) {
    if (!findMarks.length) return;
    if (findIdx >= 0) findMarks[findIdx].classList.remove("cur");
    findIdx = (i + findMarks.length) % findMarks.length;
    const m = findMarks[findIdx]; m.classList.add("cur");
    m.scrollIntoView({ block: "center", behavior: "instant" });
    findCount.textContent = `${findIdx + 1} / ${findMarks.length}`;
  }
  function openFind() { findBar.hidden = false; findIn.focus(); findIn.select(); }
  function closeFind() { findBar.hidden = true; clearFind(); findIn.value = ""; }
  let findTimer = null;
  findIn.addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(findIn.value), 80); });
  findIn.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); gotoFind(findIdx + (e.shiftKey ? -1 : 1)); }
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  $("#find-next").addEventListener("click", () => gotoFind(findIdx + 1));
  $("#find-prev").addEventListener("click", () => gotoFind(findIdx - 1));
  $("#find-close").addEventListener("click", closeFind);

  // ---------- focus beacon for desktop notifications ----------
  const beacon = () => { if (document.hasFocus() && document.visibilityState === "visible") fetch("/api/focus", { method: "POST", keepalive: true }).catch(() => {}); };
  window.addEventListener("focus", beacon); document.addEventListener("visibilitychange", beacon); setInterval(beacon, 3000); beacon();

  // ---------- rail: toc + meta ----------
  let spy = null;
  function buildToc() {
    if (spy) { spy.disconnect(); spy = null; }
    const reading = state.view === "doc" || state.view === "browse";
    const hs = reading ? [...docEl.querySelectorAll(".prose h1, .prose h2, .prose h3, .prose h4")] : [];
    if (hs.length < 3) { tocEl.innerHTML = ""; buildOutline(); }
    else {
      tocEl.innerHTML = `<ul>` + hs.map((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        return `<li class="d${h.tagName[1]}"><a href="#${h.id}" data-i="${i}">${esc(h.textContent.replace(/^#\s*/, ""))}</a></li>`;
      }).join("") + `</ul>`;
      const links = tocEl.querySelectorAll("a");
      const visible = new Set();
      spy = new IntersectionObserver(entries => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
        let cur = null;
        for (const h of hs) { if (h.getBoundingClientRect().top < 120) cur = h; }
        links.forEach(a => a.classList.toggle("cur", cur && a.getAttribute("href") === `#${cur.id}`));
      }, { root: main, rootMargin: "-100px 0px -60% 0px", threshold: 0 });
      hs.forEach(h => spy.observe(h));
    }
    rail.classList.toggle("empty", state.view === "inbox");
  }

  /** Prose has headings; code has declarations. Same rail, fetched after first paint. */
  let outlineSpy = null;
  async function buildOutline() {
    if (outlineSpy) { outlineSpy.disconnect(); outlineSpy = null; }
    const url = state.view === "doc" && state.doc && state.doc.kind === "code"
      ? `/api/docs/${state.doc.id}/outline`
      : (browsing() && state.browsePath ? `/api/browse/${state.browseRoot.id}/outline?path=${encodeURIComponent(state.browsePath)}` : null);
    if (!url) return;
    const token = ++outlineToken;
    let items = [];
    try { items = await (await fetch(url)).json(); } catch { return; }
    // A newer document started loading while this was in flight.
    if (token !== outlineToken || !Array.isArray(items) || !items.length) return;
    const lines = [...docEl.querySelectorAll("pre.code .ln")];
    if (!lines.length) return;
    tocEl.innerHTML = `<ul class="outline">` + items.map((o, i) =>
      `<li class="d${o.depth + 1}"><a href="#" data-line="${o.line}" data-i="${i}" title="${esc(o.kind)} · line ${o.line}"><span class="ok ok-${o.kind}"></span>${esc(o.name)}</a></li>`
    ).join("") + `</ul>`;
    const links = [...tocEl.querySelectorAll("a")];
    links.forEach(a => a.addEventListener("click", e => {
      e.preventDefault();
      const el = lines[+a.dataset.line - 1];
      if (!el) return;
      // Land the declaration near the top with its body below, the way an editor
      // jumps to a symbol. It also keeps the rail's current marker in agreement.
      el.scrollIntoView({ block: "start", behavior: "instant" });
      flash(el);
    }));
    // Mark whichever declaration the reader has scrolled past.
    const tops = items.map(o => lines[o.line - 1]).filter(Boolean);
    outlineSpy = new IntersectionObserver(() => {
      let cur = -1;
      items.forEach((o, i) => { const el = lines[o.line - 1]; if (el && el.getBoundingClientRect().top < 140) cur = i; });
      links.forEach((a, i) => a.classList.toggle("cur", i === cur));
    }, { root: main, rootMargin: "-120px 0px -60% 0px", threshold: 0 });
    tops.forEach(el => outlineSpy.observe(el));
  }
  let outlineToken = 0;
  function flash(el) {
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 700);
  }

  // ---------- line links ----------
  /** `#L120` addresses a line of the document, so it only means something where
   *  the whole document is one block of lines: a code or text file, sent or browsed. */
  const codePre = () => docEl.querySelector("article.kind-code pre.code, article.kind-text pre.code");
  function lineHash() {
    const m = /^#L(\d+)(?:-L?(\d+))?$/.exec(location.hash);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    return a > 0 ? { a: Math.min(a, b), b: Math.max(a, b) } : null;
  }
  const frag = (a, b) => (a === b ? `#L${a}` : `#L${a}-L${b}`);

  /** Mark the lines the URL points at. They stay marked while they are being read,
   *  so a link from an agent lands on something you can see. */
  function applyLineHash(scroll) {
    for (const el of docEl.querySelectorAll("pre.code .ln.at")) el.classList.remove("at");
    const r = lineHash(), pre = codePre();
    if (!r || !pre) return;
    const lines = pre.querySelectorAll(".ln");
    let first = null;
    for (let n = r.a; n <= r.b; n++) {
      const el = lines[n - 1];
      if (!el) break;
      el.classList.add("at");
      first = first || el;
    }
    if (first && scroll) first.scrollIntoView({ block: "center", behavior: "instant" });
  }

  function setLines(a, b, scroll) {
    history.replaceState(history.state, "", location.pathname + frag(a, b));
    applyLineHash(scroll);
  }

  function gotoLine(n) {
    const pre = codePre();
    if (!pre) { toast("No line numbers here", "Line links work on code and text documents."); return; }
    if (n > pre.querySelectorAll(".ln").length) { toast(`No line ${n}`, "The document is shorter than that."); return; }
    setLines(n, n, true);
  }

  /** Width of the number gutter, or 0 where the numbers are hidden (diffs, short blocks). */
  function gutterWidth(ln) {
    const s = getComputedStyle(ln, "::before");
    if (!s || s.display === "none") return 0;
    const w = parseFloat(s.paddingLeft) + parseFloat(s.width) + parseFloat(s.marginRight);
    return isFinite(w) ? w : 0;
  }

  /** Click a line number for a link to that line; shift-click for a range. */
  function wireLines(pre) {
    pre.addEventListener("click", e => {
      const ln = e.target.closest(".ln");
      if (!ln || codePre() !== pre) return;
      const box = ln.getClientRects()[0];
      if (!box || e.clientX - box.left > gutterWidth(ln)) return;   // the code, not the number
      e.preventDefault();
      const n = [...pre.querySelectorAll(".ln")].indexOf(ln) + 1;
      const prev = e.shiftKey && lineHash();
      setLines(prev ? Math.min(prev.a, n) : n, prev ? Math.max(prev.a, n) : n, false);
      navigator.clipboard?.writeText(location.href);
      toast("Link copied", location.pathname + location.hash);
    });
  }
  window.addEventListener("hashchange", () => applyLineHash(true));

  function renderMeta(comparing) {
    if (state.view === "browse") { renderBrowseMeta(); return; }
    const d = state.doc;
    if (!d) { metaEl.innerHTML = ""; return; }
    const rows = [
      ["Project", d.project], ["Workflow", d.workflow_title], d.branch ? ["Branch", d.branch] : null,
      ["Received", fmt(d.received_at)], ["Size", d.size > 1024 * 1024 ? (d.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(d.size / 1024)) + " KB"],
      d.lang ? ["Lang", d.lang] : null,
    ].filter(Boolean);
    metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span title="${esc(v)}">${esc(v)}</span></div>`).join("") +
      `<div class="actions">` +
      (state.previous ? (comparing ? `<button data-act="back">← Back to document</button>` : `<button data-act="compare">Compare with previous<kbd>c</kbd></button>`) : "") +
      `<button data-act="pin">${d.pinned ? "Unpin" : "Pin"}<kbd>p</kbd></button>` +
      ((d.kind === "diff" || comparing) ? `<button data-act="split">${state.split ? "Inline view" : "Split view"}<kbd>s</kbd></button>` : "") +
      previewButton() +
      `<button data-act="delete">Delete…<kbd>⌫</kbd></button>` +
      `<a href="/api/docs/${d.id}/raw" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` +
      (d.source_path ? `<button data-act="copypath" title="${esc(d.source_path)}">Copy path</button>` : "") +
      (state.folder ? `<button data-act="terminal" title="${esc(state.folder)}">Open terminal here</button>` : "") +
      `</div>`;
  }
  const rawUrl = (rootId, path) => `/api/browse/${rootId}/raw/${path.split("/").map(encodeURIComponent).join("/")}`;

  function previewButton() {
    if (!state.preview) return "";
    const label = state.previewOn ? "Source" : (state.preview === "pdf" ? "Open in viewer" : "Preview page");
    return `<button data-act="preview">${label}<kbd>v</kbd></button>`;
  }

  function renderBrowseMeta() {
    const r = state.browseRoot;
    if (!r) { metaEl.innerHTML = ""; return; }
    const p = state.browsePath;
    const rows = [["Folder", r.name], p ? ["Path", p] : null].filter(Boolean);
    metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span title="${esc(v)}">${esc(v)}</span></div>`).join("") +
      `<div class="actions">` +
      previewButton() +
      (p ? `<a href="${rawUrl(r.id, p)}" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` : "") +
      `<button data-act="copybrowse">Copy path</button>` +
      `<button data-act="terminal" title="${esc(r.path + (p ? "/" + p : ""))}">Open terminal here</button>` +
      `<a href="/b/${r.id}" data-browse="${r.id}" data-path="">Folder contents</a>` +
      `<button data-act="closebrowse">Close folder</button>` +
      `</div>`;
  }

  metaEl.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "compare") showCompare();
    if (b.dataset.act === "back") { state.cache.delete(state.doc.id); showDoc(state.doc.id, false); }
    if (b.dataset.act === "copypath") { navigator.clipboard?.writeText(state.doc.source_path); toast("Copied", state.doc.source_path); }
    if (b.dataset.act === "pin") togglePin();
    if (b.dataset.act === "split") toggleSplit();
    if (b.dataset.act === "preview") togglePreview();
    if (b.dataset.act === "delete") deleteCurrent();
    if (b.dataset.act === "copybrowse") {
      const full = state.browseRoot.path + (state.browsePath ? "/" + state.browsePath : "");
      navigator.clipboard?.writeText(full); toast("Copied", full);
    }
    if (b.dataset.act === "terminal") openTerminal();
    if (b.dataset.act === "closebrowse") {
      const id = state.browseRoot.id;
      try { await fetch(`/api/browse/${id}/close`, { method: "POST" }); } catch {}
      state.browse = state.browse.filter(r => r.id !== id);
      showInbox(true);
    }
  });

  /** Open the machine's own terminal where the reader is looking.
   *
   *  What is sent is an id, never a path: the daemon resolves the directory
   *  itself, so nothing typed into a document can reach one. Nothing comes back
   *  either -- the terminal's output is the terminal's. See docs/TERMINAL.md.
   *
   *  The request carries no token because this page has none, and is allowed
   *  through by being same-origin instead; a page on another origin is refused
   *  by the daemon. */
  async function openTerminal() {
    const body = state.view === "browse"
      ? { root: state.browseRoot.id, path: state.browsePath || "" }
      : { doc: state.doc.id };
    try {
      const r = await fetch("/api/terminal", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) toast("Terminal", j.dir || "opened");
      else toast("No terminal", j.error || `${r.status}`);
    } catch (e) { toast("No terminal", String(e)); }
  }

  async function togglePin() {
    if (!state.doc) return;
    const pinned = !state.doc.pinned;
    try {
      await fetch(`/api/docs/${state.doc.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
      state.doc.pinned = pinned; state.cache.delete(state.doc.id);
      await refreshTree(state.doc.project_id);
      renderMeta(false);
      toast(pinned ? "Pinned" : "Unpinned", pinned ? "Kept by prune" : "Prune may remove it");
    } catch (e) { toast("Could not pin", String(e)); }
  }

  function enhanceCode() {
    for (const pre of docEl.querySelectorAll("pre.code")) {
      if (pre.querySelector(".copy")) continue;
      wireLines(pre);
      const b = document.createElement("button");
      b.className = "copy"; b.textContent = "Copy"; b.title = "Copy code";
      b.addEventListener("click", () => {
        const text = [...pre.querySelectorAll(".ln")].map(l => l.textContent).join("\n") || pre.textContent;
        navigator.clipboard?.writeText(text);
        b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200);
      });
      pre.appendChild(b);
    }
  }

  // ---------- navigation ----------
  document.addEventListener("click", e => {
    const a = e.target.closest("a[data-id], a[data-browse], [data-nav]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (a.dataset.nav === "inbox") showInbox(true);
    else if (a.dataset.browse !== undefined) showBrowse(a.dataset.browse, a.dataset.path, true);
    else showDoc(a.dataset.id, true);
    if (window.innerWidth <= 760) root.dataset.side = "0";
  });
  document.addEventListener("mouseover", e => {
    const a = e.target.closest("a[data-id]");
    if (a && !state.cache.has(a.dataset.id)) fetchDoc(a.dataset.id).catch(() => {});
  });
  window.addEventListener("popstate", () => {
    const d = location.pathname.match(/^\/d\/([a-z0-9]+)$/);
    if (d) return showDoc(d[1], false);
    const b = location.pathname.match(/^\/b\/([a-z0-9]+)(?:\/(.*))?$/);
    if (b) return showBrowse(b[1], decodeURIComponent(b[2] || ""), false);
    showInbox(false);
  });

  // ---------- live arrivals ----------
  function connect() {
    const es = new EventSource("/api/events");
    es.addEventListener("doc", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      const d = j.doc;
      const elsewhere = !state.doc || state.doc.project_id !== d.project_id;
      // One project moved, so one project's rows are what is refetched. This
      // used to pull the whole library back down and rebuild the sidebar on
      // every arrival -- a file saved every few seconds paid it every few
      // seconds -- and the unread count is set first so one render serves both.
      // An overwrite of a document already here is not an arrival: refresh it where
      // it is if it is on screen, never navigate to it, and never toast — a file
      // being watched changes on every save.
      if (j.existing) {
        if (state.doc && state.doc.id === d.id) await refreshDoc(d.id);
        else { state.cache.delete(d.id); if (elsewhere) state.unread.set(d.project_id, (state.unread.get(d.project_id) || 0) + 1); }
        await refreshTree(d.project_id);
        return;
      }
      if (state.view === "inbox" || idle()) {
        state.cache.delete(d.id);
        await refreshTree(d.project_id);
        await showDoc(d.id, true);
        toast(d.title, `${d.project} · just now`);
      } else {
        if (elsewhere) state.unread.set(d.project_id, (state.unread.get(d.project_id) || 0) + 1);
        await refreshTree(d.project_id);
        toast(d.title, `${d.project} · click to open`, () => showDoc(d.id, true));
      }
    });
    // A large code file finished highlighting in the background: swap the body in place.
    es.addEventListener("rendered", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      refreshDoc(j.id);
    });
    // Something in a browsed folder changed on disk: the open file, or a listed folder.
    es.addEventListener("changed", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.dir) {
        reloadTree(browseEl.querySelector(`.b-tree[data-root="${j.root}"][data-path="${CSS.escape(j.path)}"]`));
        if (browsing() && state.browseRoot.id === j.root && !state.browsePath && j.path === "") showBrowse(j.root, "", false);
        return;
      }
      if (browsing() && state.browseRoot.id === j.root && state.browsePath === j.path) refreshBrowsed();
    });
    es.addEventListener("deleted", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.cache.delete(j.id);
      await refreshTree();
      if (state.doc && state.doc.id === j.id) showInbox(true);
    });
    es.addEventListener("browse", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.browse = j.roots || [];
      renderBrowse();
    });
    es.addEventListener("pinned", async () => { await refreshTree(); });
    // Another tab named a project or a workflow.
    es.addEventListener("renamed", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.project != null) applyRename("project", j.project);
      else if (j.workflow != null) applyRename("workflow", j.workflow);
    });
    es.onerror = () => { es.close(); setTimeout(connect, 2000); };
  }

  function toast(title, sub, onClick) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span class="dot"></span><span><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</span>`;
    el.addEventListener("click", () => { el.remove(); onClick && onClick(); });
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.transition = "opacity 160ms"; el.style.opacity = "0"; setTimeout(() => el.remove(), 180); }, onClick ? 8000 : 3500);
  }

  // ---------- palette ----------
  const pal = $("#palette"), palIn = $("#palette-input"), palList = $("#palette-list");
  let palSel = 0, palItems = [], palTimer = null;
  function openPalette() {
    pal.hidden = false; palIn.value = "";
    palIn.placeholder = browsing() ? `Find a file in ${state.browseRoot.name}…  (:120 for a line)`
      : codePre() ? "Search documents…  (:120 for a line)" : "Search documents…  (p:project  kind:md|code|diff)";
    palIn.focus(); palSearch("");
  }
  const browsing = () => state.view === "browse" && state.browseRoot;
  function closePalette() { pal.hidden = true; }
  async function palSearch(q) {
    // A line number is not a search term. `:120` and `L120` jump instead.
    const g = /^\s*[:lL]\s*(\d+)\s*$/.exec(q);
    if (g && codePre()) {
      palItems = [{ line: +g[1] }]; palSel = 0;
      palList.innerHTML = `<li class="sel" data-i="0"><span class="t">Go to line ${+g[1]}</span><span class="s">${esc(document.title)}</span></li>`;
      return;
    }
    if (browsing()) {
      let hits = [];
      try { hits = await (await fetch(`/api/browse/${state.browseRoot.id}/find?q=${encodeURIComponent(q)}`)).json(); } catch {}
      palItems = hits.map(p => ({ file: p })); palSel = 0;
      palList.innerHTML = hits.map((p, i) => `<li class="${i === 0 ? "sel" : ""}" data-i="${i}"><span class="t">${esc(p.split("/").pop())}</span><span class="s">${esc(p)}</span></li>`).join("");
      return;
    }
    let items;
    if (!q.trim()) items = (await (await fetch("/api/inbox?limit=12")).json()).map(d => ({ ...d, snippet: "" }));
    else items = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    palItems = items; palSel = 0;
    palList.innerHTML = items.map((d, i) => `<li class="${i === 0 ? "sel" : ""}" data-i="${i}"><span class="t">${esc(d.title)}</span><span class="s">${esc(d.project)} · ${esc(d.workflow_title)} · ${rel(d.received_at)}</span>${d.snippet ? `<span class="snip">${d.snippet}</span>` : ""}</li>`).join("");
  }
  palIn.addEventListener("input", () => { clearTimeout(palTimer); palTimer = setTimeout(() => palSearch(palIn.value), 60); });
  palIn.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      palSel = (palSel + (e.key === "ArrowDown" ? 1 : -1) + palItems.length) % Math.max(1, palItems.length);
      palList.querySelectorAll("li").forEach((li, i) => li.classList.toggle("sel", i === palSel));
      palList.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && palItems[palSel]) { closePalette(); openPalItem(palItems[palSel]); }
  });
  const openPalItem = it => it.line ? gotoLine(it.line) : it.file ? showBrowse(state.browseRoot.id, it.file, true) : showDoc(it.id, true);
  palList.addEventListener("click", e => { const li = e.target.closest("li"); if (li) { closePalette(); openPalItem(palItems[+li.dataset.i]); } });
  pal.addEventListener("click", e => { if (e.target === pal) closePalette(); });
  $("#btn-search").addEventListener("click", openPalette);

  // ---------- theme / font / panes ----------
  $("#btn-theme").addEventListener("click", () => {
    const next = { "": "light", light: "dark", dark: "" }[root.dataset.theme || ""];
    next ? (root.dataset.theme = next) : delete root.dataset.theme;
    store.set("snyvi.theme", next);
    toast("Theme", next || "system");
    mmdRetheme();
  });
  // The same fault by a different route: with no explicit choice stored the page
  // follows the system, and the diagrams on it were drawn before it moved.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!root.dataset.theme) mmdRetheme();
  });
  function toggleWide() {
    const on = root.dataset.wide !== "1";
    on ? (root.dataset.wide = "1") : delete root.dataset.wide;
    store.set("snyvi.wide", on ? "1" : "0");
    $("#btn-wide").classList.toggle("on", on);
  }
  $("#btn-wide").addEventListener("click", toggleWide);
  $("#btn-wide").classList.toggle("on", root.dataset.wide === "1");

  function toggleWrap() {
    const on = root.dataset.wrap !== "1";
    on ? (root.dataset.wrap = "1") : delete root.dataset.wrap;
    store.set("snyvi.wrap", on ? "1" : "0");
    $("#btn-wrap").classList.toggle("on", on);
    // On prose there is nothing to wrap, so say what the setting did instead.
    if (!docEl.querySelector("pre.code")) toast("Line wrap", on ? "on, for code" : "off");
  }
  $("#btn-wrap").addEventListener("click", toggleWrap);
  $("#btn-wrap").classList.toggle("on", root.dataset.wrap === "1");

  $("#btn-font").addEventListener("click", () => {
    const next = root.dataset.font === "serif" ? "" : "serif";
    next ? (root.dataset.font = next) : delete root.dataset.font;
    store.set("snyvi.font", next);
  });
  const help = $("#help");
  help.addEventListener("click", e => { if (e.target === help) help.hidden = true; });

  document.addEventListener("keydown", e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); return; }
    if (e.key === "Escape") { closePalette(); help.hidden = true; if (!findBar.hidden) closeFind(); return; }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (browsing() && (e.key === "j" || e.key === "k")) {
      const links = [...browseEl.querySelectorAll(".b-file a")];
      const at = links.findIndex(a => a.dataset.path === state.browsePath);
      const next = links[at + (e.key === "j" ? 1 : -1)] || (at < 0 ? links[0] : null);
      if (next) showBrowse(next.dataset.browse, next.dataset.path, true);
      e.preventDefault();
      return;
    }
    const ids = order(), i = state.doc ? ids.indexOf(state.doc.id) : -1;
    const sib = siblings(), si = state.doc ? sib.indexOf(state.doc.id) : -1;
    switch (e.key) {
      case "j": if (ids[i + 1]) showDoc(ids[i + 1], true); else if (i < 0 && ids[0]) showDoc(ids[0], true); break;
      case "k": if (i > 0) showDoc(ids[i - 1], true); break;
      case "[": if (sib[si + 1]) showDoc(sib[si + 1], true); break;   // sidebar is newest-first, so older is +1
      case "]": if (si > 0) showDoc(sib[si - 1], true); break;
      case "c": showCompare(); break;
      case "p": togglePin(); break;
      case "s": toggleSplit(); break;
      case "v": togglePreview(); break;
      case "/": openFind(); break;
      case "Backspace": case "Delete": deleteCurrent(); break;
      case "i": showInbox(true); break;
      case "w": toggleWide(); break;
      case "z": toggleWrap(); break;
      case "t": root.dataset.rail = root.dataset.rail === "0" ? "1" : "0"; break;
      case "\\": { const off = root.dataset.side !== "0"; root.dataset.side = off ? "0" : "1"; store.set("snyvi.side", off ? "0" : "1"); break; }
      case "o":
        if (state.doc) window.open(`/api/docs/${state.doc.id}/raw`, "_blank");
        else if (browsing() && state.browsePath) window.open(rawUrl(state.browseRoot.id, state.browsePath), "_blank");
        break;
      case "?": help.hidden = !help.hidden; break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- boot ----------
  if (state.view === "doc" && state.doc) { document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname + location.hash); }
  else if (state.view === "browse" && state.browseRoot) { showBrowse(state.browseRoot.id, state.browsePath, false); history.replaceState({ browse: state.browseRoot.id, path: state.browsePath }, "", location.pathname + location.hash); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", "/"); }
  connect();
})();
