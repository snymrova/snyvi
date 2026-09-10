/* snyvi client. No framework; the server renders documents, this script navigates. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const boot = JSON.parse($("#boot").textContent || "{}");
  const root = document.documentElement;
  const main = $("#main"), docEl = $("#doc"), treeEl = $("#tree"), tocEl = $("#toc"), metaEl = $("#meta"), rail = $("#rail");

  const state = {
    tree: boot.tree || [],
    view: boot.view || "inbox",
    doc: boot.doc || null,
    previous: boot.previous || null,
    unread: new Map(),          // project id -> count
    lastActivity: 0,
    cache: new Map(),           // id -> {doc, html, previous}
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
  const kindTag = k => ({ markdown: "md", code: "code", diff: "diff", text: "txt" }[k] || k);
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const idle = () => Date.now() - state.lastActivity > 2500 && !(window.getSelection() && String(window.getSelection()).length);
  ["scroll", "keydown", "mousedown", "wheel", "touchstart"].forEach(e => window.addEventListener(e, () => { state.lastActivity = Date.now(); }, { passive: true, capture: true }));

  // ---------- tree ----------
  const openProjects = new Set((store.get("snyvi.open") || "").split(",").filter(Boolean));
  function renderTree() {
    const projects = state.tree;
    if (!projects.length) {
      treeEl.innerHTML = `<div class="t-inbox active"><span>Inbox</span></div><div class="t-empty">Nothing here yet. Send something:<br><code>snyvi send README.md</code></div>`;
      return;
    }
    const total = projects.reduce((n, p) => n + p.workflows.reduce((m, w) => m + w.docs.length, 0), 0);
    let h = `<div class="t-inbox ${state.view === "inbox" ? "active" : ""}" data-nav="inbox"><span>Inbox</span><span class="n">${total}</span></div>`;
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
  treeEl.addEventListener("toggle", e => {
    const d = e.target;
    if (!d.classList || !d.classList.contains("t-proj")) return;
    d.open ? openProjects.add(d.dataset.pid) : openProjects.delete(d.dataset.pid);
    store.set("snyvi.open", [...openProjects].join(","));
  }, true);

  /** Flat list of doc ids in sidebar order, for j/k. */
  const order = () => state.tree.flatMap(p => p.workflows.flatMap(w => w.docs.map(d => d.id)));
  const siblings = () => {
    if (!state.doc) return [];
    for (const p of state.tree) for (const w of p.workflows) if (w.id === state.doc.workflow_id) return w.docs.map(d => d.id);
    return [];
  };

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
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous;
    state.unread.delete(j.doc.project_id);
    docEl.innerHTML = j.html;
    document.title = j.doc.title;
    if (push) history.pushState({ id }, "", `/d/${id}`);
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
  }

  async function showInbox(push = true) {
    state.view = "inbox"; state.doc = null; state.previous = null;
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

  async function showCompare() {
    if (!state.doc || !state.previous) { toast("No previous version", "This is the first document in its workflow."); return; }
    const cur = state.doc, prevId = state.previous;
    let j;
    try { j = await (await fetch(`/api/compare/${prevId}/${cur.id}`)).json(); } catch (e) { toast("Compare failed", String(e)); return; }
    docEl.innerHTML = `<header class="doc-head"><h1 class="doc-title">${esc(cur.title)}</h1><p class="doc-sub">changes since ${fmt(j.a.received_at)} → ${fmt(j.b.received_at)}</p></header><article class="prose kind-diff">${j.html}</article>`;
    main.scrollTo({ top: 0, behavior: "instant" });
    buildToc(); renderMeta(true); enhanceCode();
  }

  function afterRender() {
    renderTree();
    buildToc();
    renderMeta(false);
    enhanceCode();
  }

  // ---------- rail: toc + meta ----------
  let spy = null;
  function buildToc() {
    if (spy) { spy.disconnect(); spy = null; }
    const hs = state.view === "doc" ? [...docEl.querySelectorAll(".prose h1, .prose h2, .prose h3, .prose h4")] : [];
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
    rail.classList.toggle("empty", state.view !== "doc");
  }

  function renderMeta(comparing) {
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
      `<a href="/api/docs/${d.id}/raw" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` +
      (d.source_path ? `<button data-act="copypath" title="${esc(d.source_path)}">Copy path</button>` : "") +
      `</div>`;
  }
  metaEl.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "compare") showCompare();
    if (b.dataset.act === "back") showDoc(state.doc.id, false);
    if (b.dataset.act === "copypath") { navigator.clipboard?.writeText(state.doc.source_path); toast("Copied", state.doc.source_path); }
    if (b.dataset.act === "pin") togglePin();
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
    const a = e.target.closest("a[data-id], [data-nav]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (a.dataset.nav === "inbox") showInbox(true);
    else showDoc(a.dataset.id, true);
    if (window.innerWidth <= 760) root.dataset.side = "0";
  });
  document.addEventListener("mouseover", e => {
    const a = e.target.closest("a[data-id]");
    if (a && !state.cache.has(a.dataset.id)) fetchDoc(a.dataset.id).catch(() => {});
  });
  window.addEventListener("popstate", e => {
    const m = location.pathname.match(/^\/d\/([a-z0-9]+)$/);
    m ? showDoc(m[1], false) : showInbox(false);
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
  function openPalette() { pal.hidden = false; palIn.value = ""; palIn.focus(); palSearch(""); }
  function closePalette() { pal.hidden = true; }
  async function palSearch(q) {
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
    } else if (e.key === "Enter" && palItems[palSel]) { closePalette(); showDoc(palItems[palSel].id, true); }
  });
  palList.addEventListener("click", e => { const li = e.target.closest("li"); if (li) { closePalette(); showDoc(palItems[+li.dataset.i].id, true); } });
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
    if (e.key === "Escape") { closePalette(); help.hidden = true; return; }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    const ids = order(), i = state.doc ? ids.indexOf(state.doc.id) : -1;
    const sib = siblings(), si = state.doc ? sib.indexOf(state.doc.id) : -1;
    switch (e.key) {
      case "j": if (ids[i + 1]) showDoc(ids[i + 1], true); else if (i < 0 && ids[0]) showDoc(ids[0], true); break;
      case "k": if (i > 0) showDoc(ids[i - 1], true); break;
      case "[": if (sib[si + 1]) showDoc(sib[si + 1], true); break;   // sidebar is newest-first, so older is +1
      case "]": if (si > 0) showDoc(sib[si - 1], true); break;
      case "c": showCompare(); break;
      case "p": togglePin(); break;
      case "i": showInbox(true); break;
      case "t": root.dataset.rail = root.dataset.rail === "0" ? "1" : "0"; break;
      case "\\": { const off = root.dataset.side !== "0"; root.dataset.side = off ? "0" : "1"; store.set("snyvi.side", off ? "0" : "1"); break; }
      case "o": if (state.doc) window.open(`/api/docs/${state.doc.id}/raw`, "_blank"); break;
      case "?": help.hidden = !help.hidden; break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- boot ----------
  if (state.view === "doc" && state.doc) { document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", "/"); }
  connect();
})();
