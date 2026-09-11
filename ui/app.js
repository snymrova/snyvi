/* snyvi client. No framework; the server renders documents, this script navigates. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const boot = JSON.parse($("#boot").textContent || "{}");
  const root = document.documentElement;
  const main = $("#main"), docEl = $("#doc"), treeEl = $("#tree"), tocEl = $("#toc"), metaEl = $("#meta"), rail = $("#rail");
  const treesEl = $("#trees"), browseEl = $("#browse-nav"), inboxRowEl = $("#inbox-row");

  const state = {
    tree: boot.tree || [],
    view: boot.view || "inbox",
    doc: boot.doc || null,
    previous: boot.previous || null,
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
  const kindTag = k => ({ markdown: "md", code: "code", diff: "diff", text: "txt", image: "img", binary: "bin" }[k] || k);
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const idle = () => Date.now() - state.lastActivity > 2500 && !(window.getSelection() && String(window.getSelection()).length);
  ["scroll", "keydown", "mousedown", "wheel", "touchstart"].forEach(e => window.addEventListener(e, () => { state.lastActivity = Date.now(); }, { passive: true, capture: true }));

  // ---------- tree ----------
  const openProjects = new Set((store.get("snyvi.open") || "").split(",").filter(Boolean));
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

  function renderTree() {
    const projects = state.tree;
    const total = projects.reduce((n, p) => n + p.workflows.reduce((m, w) => m + w.docs.length, 0), 0);
    inboxRowEl.innerHTML = `<div class="t-inbox ${state.view === "inbox" ? "active" : ""}" data-nav="inbox"><span>Inbox</span><span class="n">${total}</span></div>`;
    renderBrowse();
    if (!projects.length) {
      treeEl.innerHTML = state.browse.length ? "" : `<div class="t-empty">Nothing here yet. Send something:<br><code>snyvi send README.md</code><br><br>Or read a folder:<br><code>snyvi browse .</code></div>`;
      return;
    }
    // Labels only earn their space when both kinds of tree are on screen.
    let h = state.browse.length ? `<div class="t-label">Projects</div>` : "";
    for (const p of projects) {
      const isCur = state.doc && state.doc.project_id === p.id;
      const open = openProjects.has(String(p.id)) || isCur || projects.length === 1;
      const unread = state.unread.get(p.id) || 0;
      h += `<details class="t-proj" data-pid="${p.id}" ${open ? "open" : ""}><summary title="${esc(p.root)}">${esc(p.name)}${unread ? `<span class="badge">${unread}</span>` : ""}</summary><ul>`;
      for (const w of p.workflows) {
        h += `<li class="t-wf"><div class="wf-name" title="${esc(w.key)}">${esc(w.title)}</div><ul>`;
        for (const d of w.docs) {
          const active = state.doc && state.doc.id === d.id ? "active" : "";
          h += `<li class="t-doc"><a href="/d/${d.id}" class="${active}" data-id="${d.id}" title="${esc(d.title)} · ${fmt(d.received_at)}"><span class="title">${esc(d.title)}</span>${d.pinned ? `<span class="pin" title="Pinned">●</span>` : ""}<span class="k">${kindTag(d.kind)}</span></a></li>`;
        }
        h += `</ul></li>`;
      }
      h += `</ul></details>`;
    }
    treeEl.innerHTML = h;
  }

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
    ul.innerHTML = entries.map(e => e.dir
      ? `<li class="b-dir"><details data-root="${rootId}" data-path="${esc(e.path)}"><summary>${esc(e.name)}</summary><ul class="b-tree" data-root="${rootId}" data-path="${esc(e.path)}"></ul></details></li>`
      : `<li class="b-file"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}" title="${esc(e.path)}"><span class="title">${esc(e.name)}</span><span class="k">${fmtSize(e.size)}</span></a></li>`
    ).join("");
    markActive();
  }
  treesEl.addEventListener("toggle", e => {
    const d = e.target;
    if (d.dataset && d.dataset.root && d.open) {
      fillTree(d.querySelector(":scope > .b-tree"));
      return;
    }
    if (!d.classList || !d.classList.contains("t-proj")) return;
    d.open ? openProjects.add(d.dataset.pid) : openProjects.delete(d.dataset.pid);
    store.set("snyvi.open", [...openProjects].join(","));
  }, true);

  treesEl.addEventListener("click", async e => {
    const b = e.target.closest("[data-close]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const id = b.dataset.close;
    try { await fetch(`/api/browse/${id}/close`, { method: "POST" }); } catch {}
    state.browse = state.browse.filter(r => r.id !== id);
    if (state.browseRoot && state.browseRoot.id === id) showInbox(true); else renderTree();
  });

  /** Flat list of doc ids in sidebar order, for j/k. */
  const order = () => state.tree.flatMap(p => p.workflows.flatMap(w => w.docs.map(d => d.id)));
  const siblings = () => {
    if (!state.doc) return [];
    for (const p of state.tree) for (const w of p.workflows) if (w.id === state.doc.workflow_id) return w.docs.map(d => d.id);
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
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous; state.comparing = null;
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
      state.tree = await (await fetch("/api/tree")).json();
      toast("Deleted", d.title);
      const ids = order(); const i = ids.indexOf(d.id);
      showInbox(true);
    } catch (e) { toast("Could not delete", String(e)); }
  }

  function afterRender() {
    renderTree();
    markActive();
    buildToc();
    renderMeta(false);
    enhanceCode();
    renderMermaid();
    renderHistory();
    clearFind();
  }

  // ---------- mermaid (loaded only when a page has a diagram) ----------
  let mermaidReady = null;
  function renderMermaid() {
    const nodes = [...docEl.querySelectorAll("pre.mermaid:not([data-processed])")];
    if (!nodes.length) return;
    if (!mermaidReady) {
      mermaidReady = new Promise((res, rej) => {
        const sc = document.createElement("script");
        sc.src = "/assets/mermaid.js"; sc.onload = res; sc.onerror = rej;
        document.head.appendChild(sc);
      });
    }
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    // mermaid.run reads innerHTML; strip the <code> wrapper so it sees only the source.
    for (const n of nodes) n.textContent = n.textContent.trim();
    mermaidReady.then(() => {
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "Inter, system-ui, sans-serif" });
      return window.mermaid.run({ nodes });
    }).catch(e => { console.warn("mermaid", e); });
  }

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
  function clearFind() {
    for (const m of findMarks) { const p = m.parentNode; if (!p) continue; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
    findMarks = []; findIdx = -1; findCount.textContent = "";
  }
  function runFind(q) {
    clearFind();
    if (!q) return;
    const needle = q.toLowerCase();
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentNode.closest("script,style,.copy") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
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
    if (hs.length < 3) { tocEl.innerHTML = ""; }
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
    if (b.dataset.act === "closebrowse") {
      const id = state.browseRoot.id;
      try { await fetch(`/api/browse/${id}/close`, { method: "POST" }); } catch {}
      state.browse = state.browse.filter(r => r.id !== id);
      showInbox(true);
    }
  });

  async function togglePin() {
    if (!state.doc) return;
    const pinned = !state.doc.pinned;
    try {
      await fetch(`/api/docs/${state.doc.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
      state.doc.pinned = pinned; state.cache.delete(state.doc.id);
      state.tree = await (await fetch("/api/tree")).json();
      renderTree(); renderMeta(false);
      toast(pinned ? "Pinned" : "Unpinned", pinned ? "Kept by prune" : "Prune may remove it");
    } catch (e) { toast("Could not pin", String(e)); }
  }

  function enhanceCode() {
    for (const pre of docEl.querySelectorAll("pre.code")) {
      if (pre.querySelector(".copy")) continue;
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
      try { state.tree = await (await fetch("/api/tree")).json(); } catch {}
      if (state.view === "inbox" || idle()) {
        state.cache.delete(d.id);
        await showDoc(d.id, true);
        toast(d.title, `${d.project} · just now`);
      } else {
        if (!state.doc || state.doc.project_id !== d.project_id) state.unread.set(d.project_id, (state.unread.get(d.project_id) || 0) + 1);
        renderTree();
        toast(d.title, `${d.project} · click to open`, () => showDoc(d.id, true));
      }
    });
    // A large code file finished highlighting in the background: swap the body in place.
    es.addEventListener("rendered", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.cache.delete(j.id);
      if (!state.doc || state.doc.id !== j.id) return;
      const top = main.scrollTop;
      try { const r = await fetchDoc(j.id); docEl.innerHTML = r.html; enhanceCode(); main.scrollTop = top; } catch {}
    });
    es.addEventListener("deleted", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.cache.delete(j.id);
      try { state.tree = await (await fetch("/api/tree")).json(); } catch {}
      if (state.doc && state.doc.id === j.id) showInbox(true); else renderTree();
    });
    es.addEventListener("browse", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.browse = j.roots || [];
      renderBrowse();
    });
    es.addEventListener("pinned", async () => {
      try { state.tree = await (await fetch("/api/tree")).json(); renderTree(); } catch {}
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
    palIn.placeholder = browsing() ? `Find a file in ${state.browseRoot.name}…` : "Search documents…  (p:project  kind:md|code|diff)";
    palIn.focus(); palSearch("");
  }
  const browsing = () => state.view === "browse" && state.browseRoot;
  function closePalette() { pal.hidden = true; }
  async function palSearch(q) {
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
  const openPalItem = it => it.file ? showBrowse(state.browseRoot.id, it.file, true) : showDoc(it.id, true);
  palList.addEventListener("click", e => { const li = e.target.closest("li"); if (li) { closePalette(); openPalItem(palItems[+li.dataset.i]); } });
  pal.addEventListener("click", e => { if (e.target === pal) closePalette(); });
  $("#btn-search").addEventListener("click", openPalette);

  // ---------- theme / font / panes ----------
  $("#btn-theme").addEventListener("click", () => {
    const next = { "": "light", light: "dark", dark: "" }[root.dataset.theme || ""];
    next ? (root.dataset.theme = next) : delete root.dataset.theme;
    store.set("snyvi.theme", next);
    toast("Theme", next || "system");
  });
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
  if (state.view === "doc" && state.doc) { document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname); }
  else if (state.view === "browse" && state.browseRoot) { showBrowse(state.browseRoot.id, state.browsePath, false); history.replaceState({ browse: state.browseRoot.id, path: state.browsePath }, "", location.pathname); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", "/"); }
  connect();
})();
