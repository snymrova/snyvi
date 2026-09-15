/* snyvi client. No framework; the server renders documents, this script navigates. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const boot = JSON.parse($("#boot").textContent || "{}");
  const root = document.documentElement;
  const main = $("#main"), docEl = $("#doc"), treeEl = $("#tree"), tocEl = $("#toc"), metaEl = $("#meta"), rail = $("#rail");
  const treesEl = $("#trees"), browseEl = $("#browse-nav"), inboxRowEl = $("#inbox-row"), queueEl = $("#queue"), queueBar = $("#queue-bar");

  const state = {
    tree: boot.tree || [],          // one row per project; what it holds is fetched when it is expanded
    sub: new Map(Object.entries(boot.sub || {})),   // project id -> its workflows, once filled
    view: boot.view || "inbox",
    doc: boot.doc || null,
    previous: boot.previous || null,
    folder: boot.folder || null,   // where "Open terminal here" would open, if anywhere
    queue: boot.queue || [],    // the oldest of what arrived and has not been opened, in order
    waiting: boot.waiting != null ? boot.waiting : (boot.queue || []).length,   // how many in all
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
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
  /** The ids on the queue, for the rows that carry a mark. Rebuilt whenever
   *  the queue is drawn, which is after every change to it. */
  let queueIds = new Set(state.queue.map(d => d.id));

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
    for (const a of treesEl.querySelectorAll("a.active, .t-inbox.active")) { a.classList.remove("active"); a.removeAttribute("aria-current"); }
    const on = state.view === "inbox" ? inboxRowEl.querySelector(".t-inbox")
      : state.view === "browse" && state.browseRoot ? browseEl.querySelector(`.b-file a[data-browse="${state.browseRoot.id}"][data-path="${CSS.escape(state.browsePath)}"]`)
        : state.doc ? treeEl.querySelector(`a[data-id="${state.doc.id}"]`) : null;
    if (on) { on.classList.add("active"); on.setAttribute("aria-current", "page"); }
  }

  /** Both names are guesses — a directory name and a session's first document — so
   *  each carries the means to correct it, shown when the row is under the cursor. */
  const renameBtn = (what, id) =>
    `<button class="ren" data-rename="${what}" data-id="${id}" title="Rename ${what}" aria-label="Rename ${what}">✎</button>`;

  /** A project is drawn expanded when the reader left it that way, when the
   *  document on screen is in it, or when it is the only one there is. */
  const projOpen = p => openProjects.has(String(p.id)) || (state.doc && state.doc.project_id === p.id) || state.tree.length === 1;

  const docRow = d => {
    const cls = [state.doc && state.doc.id === d.id ? "active" : "", waitingRow(d) ? "new" : ""].join(" ").trim();
    return `<li class="t-doc${washCls(d.id)}"${moment(d.id)}><a href="/d/${d.id}" class="${cls}" data-id="${d.id}" title="${esc(d.title)} · ${fmt(d.received_at)}${waitingRow(d) ? " · waiting to be read" : ""}"><span class="title">${esc(d.title)}</span>${d.pinned ? `<span class="pin" title="Pinned">●</span>` : ""}<span class="k">${kindTag(d.kind)}</span></a></li>`;
  };

  // ---------- the queue ----------
  /* What arrived and has not been opened, in the order it came. An arrival
   * joins it and an open leaves it, wherever the open came from: it is the
   * unread set with an order, not a second list to keep. It never takes the
   * page away from a reader. Before 0.14 an arrival opened itself whenever
   * the reader had gone 2.5 s without touching anything -- which is what
   * reading a paragraph looks like -- and with several agents sending, the
   * document changed under them many times an hour. Now it is a row at the
   * top of the sidebar, a bar above the document, and `n`. */
  const QUEUE_ROWS = 6;    // in the sidebar; the inbox lists the rest
  const QUEUE_HELD = 24;   // what a page opens with and keeps; the count is the daemon's, whatever is held
  /** Whether a row is on the queue: held here, or marked by the daemon on a
   *  row fetched with its project. */
  const waitingRow = d => queueIds.has(d.id) || !!d.unread;
  /** Rows fetched with their projects carry the daemon's mark; when a read
   *  happens here, the mark comes off here too, rather than a refetch. */
  function unmarkRows(ids) {
    for (const wfs of state.sub.values()) for (const w of wfs) for (const d of w.docs) if (d.unread && (!ids || ids.has(d.id))) d.unread = false;
  }
  /** Fewer held than are waiting, and room to hold more: ask for the oldest
   *  again. A moment later, so a burst of twelve is one ask and not twelve. */
  let holdTimer = 0;
  function holdQueue() {
    if (state.queue.length >= QUEUE_HELD || state.waiting <= state.queue.length) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(async () => {
      try {
        const q = await (await fetch(`/api/queue?limit=${QUEUE_HELD}`)).json();
        if (Array.isArray(q)) { state.queue = q; renderTree(); markActive(); if (state.view === "inbox") showInbox(false); }
      } catch {}
    }, 150);
  }
  const queueRow = (d, extra = "") => `<li class="t-doc${extra}"${moment(d.id)}><a href="/d/${d.id}" class="new" data-id="${d.id}" title="${esc(d.title)} · ${esc(d.project)} · ${fmt(d.received_at)}"><span class="title">${esc(d.title)}</span><span class="k">${esc(d.project)}</span></a></li>`;

  /* ---------- what moved, and when ----------
   * The sidebar is rebuilt from state whenever the library moves, so a row
   * has no life of its own to animate: an arrival is a row that was not there
   * a render ago, a read is one that is gone. Both are kept here for as long
   * as their motion lasts, with the moment they happened, and a row that is
   * rebuilt mid-wash starts its animation at a negative delay -- where the
   * last one was -- rather than from the top. So an arrival washes once,
   * whatever the tree does underneath, and a row that has left is drawn a
   * little longer, closing, in the place it had. */
  const WASH_MS = 700, LEAVE_MS = 140;
  const washes = new Map();   // id -> when it arrived, or came back
  const leaving = new Map();  // id -> { d, at, when it left }
  let lastQueue = [];          // the rows of the last render, for where a leaver was
  let sweep = 0;
  /** A style that starts this row's animation where the last render left it. */
  function moment(id) {
    const w = washes.get(id), l = leaving.get(id);
    const t = l ? l.when : w;
    if (t == null) return "";
    const age = Date.now() - t;
    return ` style="animation-delay:-${age}ms"`;
  }
  const washCls = id => (washes.has(id) ? " wash" : "");
  /** Mark rows to be washed, once, on the next render. */
  function wash(ids) {
    const now = Date.now();
    for (const id of ids) washes.set(id, now);
    schedule();
  }
  /** Rows on their way out of the queue, closing where they were. */
  function depart(ids) {
    const now = Date.now();
    for (const id of ids) {
      const at = lastQueue.findIndex(d => d.id === id);
      if (at >= 0 && !leaving.has(id)) leaving.set(id, { d: lastQueue[at], at, when: now });
    }
    schedule();
  }
  /** A re-render when the next motion is over, to draw what state says and
   *  nothing more -- the render drops what has finished -- and then the one
   *  after. The earliest deadline, not the last: a row that closed in 140 ms
   *  must not sit there, closed, while an arrival's 700 ms wash runs on. */
  function schedule() {
    clearTimeout(sweep);
    const now = Date.now();
    const due = [...washes.values()].map(t => WASH_MS - (now - t))
      .concat([...leaving.values()].map(l => LEAVE_MS - (now - l.when)));
    if (!due.length) return;
    sweep = setTimeout(() => { renderTree(); markActive(); schedule(); }, Math.max(0, Math.min(...due)) + 40);
  }
  const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

  /** The section at the top of the sidebar and the bar above the document,
   *  both from the same rows. The bar is not drawn on the inbox, which lists
   *  the queue itself. */
  function renderQueue() {
    queueIds = new Set(state.queue.map(d => d.id));
    // What has finished moving is dropped here, at the render, and not only
    // at the sweep: a sweep is put off by every arrival, and a row that had
    // closed was otherwise drawn again, closed, until one ran.
    const now = Date.now();
    for (const [id, t] of washes) if (now - t >= WASH_MS) washes.delete(id);
    for (const [id, l] of leaving) if (now - l.when >= LEAVE_MS) leaving.delete(id);
    const n = state.waiting, head = state.queue[0], shown = Math.min(n, QUEUE_ROWS);
    // The rows state says, with the ones still closing put back where they
    // were, so a read takes its row out rather than the list snapping up.
    const rows = state.queue.slice(0, QUEUE_ROWS).map(d => queueRow(d, washCls(d.id)));
    const gone = [...leaving.values()].sort((a, b) => a.at - b.at);
    for (const l of gone) if (!queueIds.has(l.d.id)) rows.splice(Math.min(l.at, rows.length), 0, queueRow(l.d, " leaving"));
    const empty = (!n || !head) && !gone.length;
    queueEl.innerHTML = empty ? "" : `<div class="t-queue${!n ? " leaving" : ""}"><div class="t-label">Waiting<span class="n">${n}</span></div><ul>` +
      rows.join("") +
      (n > shown ? `<li class="t-more"><a href="/" data-nav="inbox">${n - shown} more</a></li>` : "") + `</ul></div>`;
    lastQueue = state.queue.slice(0, QUEUE_ROWS);
    const bar = n > 0 && !!head && state.view !== "inbox";
    queueBar.hidden = !bar;
    if (!bar) { queueBar.innerHTML = ""; return; }
    // The bar rises when it appears and stays put after: a count that changes
    // ticks in place. It used to be rebuilt on every render, which re-ran the
    // rise for one more arrival, and twelve arrivals rose twelve times.
    const count = `${n} waiting`, next = `<b>${esc(head.title)}</b> · ${esc(head.project)}`;
    const qb = queueBar.querySelector(".qb");
    if (!qb) {
      queueBar.innerHTML = `<div class="qb"><span class="qb-n">${count}</span><span class="qb-next">${next}</span>` +
        `<button type="button" data-q="next">Open<kbd>n</kbd></button><a href="/" class="qb-all" data-nav="inbox">Show all</a>` +
        `<button type="button" class="icon" data-q="clear" title="Mark all read" aria-label="Mark all read">✕</button></div>`;
      return;
    }
    const num = qb.querySelector(".qb-n"), nx = qb.querySelector(".qb-next");
    if (nx.innerHTML !== next) nx.innerHTML = next;
    if (num.textContent !== count) {
      num.textContent = count;
      // Restarted by replacing the node: a class taken off and put back in
      // one task runs nothing, and reading layout in between costs a reflow.
      const fresh = num.cloneNode(true);
      fresh.classList.add("tick");
      num.replaceWith(fresh);
    }
  }

  /** The reader opened a document: off the queue here at once, and on the
   *  server so every other tab hears. */
  function markRead(id) {
    const held = queueIds.has(id);
    let marked = false;
    for (const wfs of state.sub.values()) for (const w of wfs) for (const d of w.docs) if (d.id === id && d.unread) marked = true;
    if (!held && !marked) return;
    if (held) { state.queue = state.queue.filter(d => d.id !== id); queueIds.delete(id); depart([id]); }
    unmarkRows(new Set([id]));
    state.waiting = Math.max(0, state.waiting - 1);
    renderTree(); markActive();   // now, so the row is drawn closing rather than found gone
    fetch(`/api/docs/${id}/read`, { method: "POST" }).catch(() => {});
  }

  /** `n`: the oldest waiting document. Opening it takes it off, so the next
   *  `n` is the one after; a reader drains the queue with one key. */
  function openNext() {
    const d = state.queue[0];
    if (!d) { toast("Nothing waiting", "Every document that arrived has been opened."); return; }
    showDoc(d.id, true);
  }

  /** Everything waiting, read without being opened: for the day an agent
   *  sent thirty and the reader wants the sidebar back. */
  async function clearQueue() {
    const n = state.waiting;
    if (!n) return;
    depart(state.queue.map(d => d.id));
    state.queue = []; state.waiting = 0;
    unmarkRows(null);
    renderTree(); markActive();
    if (state.view === "inbox") showInbox(false);
    try { await fetch("/api/queue/clear", { method: "POST" }); } catch {}
    toast("Marked read", plural(n, "document"));
  }

  /** Rows leaving the queue, told by the server: this tab's own opens come
   *  back this way too, and are already gone. */
  function dropFromQueue(ids, waiting) {
    const gone = new Set(ids);
    const known = state.queue.some(d => gone.has(d.id)) || (waiting != null && waiting !== state.waiting);
    depart(gone);
    state.queue = state.queue.filter(d => !gone.has(d.id));
    unmarkRows(gone);
    if (waiting != null) state.waiting = waiting;
    if (!known) return;
    renderTree(); markActive();
    if (state.view === "inbox") showInbox(false);
    holdQueue();
  }

  document.addEventListener("click", e => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.q === "next") openNext();
    else if (b.dataset.q === "clear") clearQueue();
  });

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
    // A link, so the keyboard reaches it: a div with a click handler is a row
    // Tab walks straight past.
    inboxRowEl.innerHTML = `<a class="t-inbox ${state.view === "inbox" ? "active" : ""}" href="/" data-nav="inbox"><span>Inbox</span><span class="n">${total}</span></a>`;
    renderQueue();
    renderBrowse();
    if (!projects.length) {
      treeEl.innerHTML = state.browse.length ? "" : `<div class="t-empty">Nothing here yet. Send something:<br><code>snyvi send README.md</code><br><br>Or read a folder:<br><code>snyvi browse .</code></div>`;
      return;
    }
    // Labels only earn their space when both kinds of tree are on screen.
    let h = state.browse.length ? `<div class="t-label">Projects</div>` : "";
    for (const p of projects) {
      const open = projOpen(p);
      h += `<details class="t-proj" data-pid="${p.id}" ${open ? "open" : ""}><summary title="${esc(p.root)}"><span class="nm">${esc(p.name)}</span>${renameBtn("project", p.id)}</summary><ul>`;
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
  /** The body was replaced by a navigation: let it arrive. Restarted from the
   *  beginning each time, since the class is already there after the first. */
  function swapIn() {
    docEl.classList.remove("swap");
    void docEl.offsetWidth;
    docEl.classList.add("swap");
  }

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

  async function showDoc(id, push = true, fromHistory = false) {
    let j;
    try { j = await fetchDoc(id); } catch (e) { toast("Could not open document", String(e)); return; }
    if (push) leave();
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous; state.comparing = null; state.folder = j.folder;
    markRead(id);
    setPreview(j.preview, j.preview_url, `d:${id}`);
    docEl.innerHTML = j.html;
    swapIn();
    applyPreview();
    if (j.doc.kind === "diff" && state.split) { await applySplit(); }
    document.title = j.doc.title;
    if (push) history.pushState({ id }, "", `/d/${id}`);
    if (fromHistory && kept("id", id)) placeAt(history.state.place); else main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
  }

  /** Where the reader is, written into the page's history entry so that Back
   *  (or Forward) opens it there rather than at the top -- the way a save
   *  already keeps the place. A block and an offset into it, not a pixel
   *  count, since the page may be laid out afresh by then. Written as they
   *  leave, and a moment after each scroll for the departures the page never
   *  sees: the browser's own Back and Forward. */
  function leave() {
    const reading = (state.view === "doc" && state.doc && !state.comparing) || (browsing() && state.browsePath);
    if (reading) history.replaceState({ ...(history.state || {}), place: placeOf() }, "", location.pathname + location.hash);
  }
  let leaveTimer = 0;
  main.addEventListener("scroll", () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(leave, 400); }, { passive: true });

  /** Whether the entry history landed on is the page asked for, with a place
   *  in it. Only a move through history asks: a re-render of the same page --
   *  a preview toggled, a split view -- starts at the top as it always did. */
  const kept = (key, value) => !!(history.state && history.state[key] === value && history.state.place);

  function browseHtml(f, root) {
    const sub = `${esc(root.name)} · ${esc(f.path)} · ${fmtSize(f.size)} · ${rel(f.modified)}`;
    return `<header class="doc-head"><h1 class="doc-title">${esc(f.name)}</h1><p class="doc-sub">${sub}</p></header><article class="prose kind-${f.kind}">${f.html}</article>`;
  }

  async function showBrowse(rootId, path, push = true, fromHistory = false) {
    path = path || "";
    if (!path) {
      // No file asked for and no README: show the folder's contents.
      let entries = [], root = state.browse.find(r => r.id === rootId);
      try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=`)).json(); } catch {}
      if (push) leave();
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
    } catch (e) { toast("Could not open file", String(e)); return; }
    if (push) leave();
    state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
    state.browseRoot = j.root; state.browsePath = path;
    setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
    docEl.innerHTML = browseHtml(j.file, j.root);
    swapIn();
    applyPreview();
    document.title = j.file.name;
    if (push) history.pushState({ browse: rootId, path }, "", `/b/${rootId}/${path}`);
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

  async function showInbox(push = true) {
    if (push) leave();
    state.view = "inbox"; state.doc = null; state.previous = null; state.browseRoot = null;
    let items = boot.inbox;
    if (!items || push) {
      try { items = await (await fetch("/api/inbox?limit=60")).json(); } catch { items = []; }
    }
    boot.inbox = null;
    // Nothing to read: the page is the connect page, with the rows the shell
    // came with or, on a later visit, fetched now.
    let agents = null;
    if (!items.length) {
      agents = boot.agents; boot.agents = null;
      if (!agents) { try { agents = await (await fetch("/api/agents")).json(); } catch {} }
    }
    document.title = "snyvi";
    if (push) history.pushState({ inbox: true }, "", "/");
    docEl.innerHTML = inboxHtml(items, agents);
    if (push) swapIn();
    afterRender();
    if (!items.length) watchAgents();
    // The inbox lists every waiting row, and the page opened with the oldest
    // few: the rest come after the page is on screen, not before the sidebar is.
    if (state.waiting > state.queue.length) {
      try {
        const q = await (await fetch("/api/queue")).json();
        if (Array.isArray(q) && state.view === "inbox") { state.queue = q; docEl.innerHTML = inboxHtml(items); renderTree(); markActive(); }
      } catch {}
    }
  }

  function inboxHtml(items, agents) {
    const row = d => `<li><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`;
    if (!items.length) return connectHtml(agents);
    // What is waiting comes first, oldest first, so the landing page answers
    // "what is new" before "what is there".
    const n = state.waiting;
    return `<div class="inbox-head"><h1>Inbox</h1><p>${n ? `${plural(n, "document")} waiting to be read, then everything else, newest first.` : "Newest first, across every project."}</p></div>` +
      (n ? `<h2 class="inbox-sec">Waiting<span class="n">${n}</span><button type="button" data-q="next">Open the first<kbd>n</kbd></button><button type="button" data-q="clear">Mark all read</button></h2><ul class="inbox waiting">${state.queue.map(row).join("")}</ul><h2 class="inbox-sec">Recent</h2>` : "") +
      `<ul class="inbox">${items.map(row).join("")}</ul>`;
  }

  // ---------- connect an agent ----------
  /* The page the empty library is, and the page `?` reaches once it is not:
   * one row per agent, saying what its own config file has of snyvi, what
   * fixes it, the line for its instructions file, and when it last sent
   * something. Every fact comes from /api/agents, read by the daemon from the
   * agent's file; the page asks again every few seconds while it is on
   * screen, so `snyvi init codex` in the terminal beside it turns the row
   * without a reload. It is not a tour: it appears to exactly the person who
   * needs it, and the first document to arrive replaces it. */
  let agentsSeen = "", agentsTimer = 0;
  function connectHtml(a) {
    const rows = a ? a.rows : [];
    agentsSeen = JSON.stringify(rows);
    const cmd = (text, cls) => `<pre class="cmd ${cls || ""}"><code>${esc(text)}</code><button type="button" class="copy" title="Copy">Copy</button></pre>`;
    const row = r => {
      const other = r.id.startsWith("sender:");
      const when = r.last_sent != null ? ` · sent ${rel(r.last_sent)}` : "";
      let say, state;
      if (other) { state = "connected"; say = `Calls itself <code>${esc(r.name)}</code>, and has sent: connected.`; }
      else if (r.state === "connected") { state = "connected"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)} ${esc(r.args.join(" "))}</code>.${r.last_sent == null ? " Nothing has arrived from it yet." : ""}`; }
      else if (r.state === "stale") { state = "stale"; say = `Registered in <code>${esc(r.file)}</code> as <code>${esc(r.command)}</code>, which no longer exists — every send fails.`; }
      else if (r.state === "unreadable") { state = "stale"; say = `<code>${esc(r.file)}</code> could not be read (${esc(r.error)}), so it is not edited. Put the entry in by hand.`; }
      else { state = "off"; say = r.file ? `Nothing in <code>${esc(r.file)}</code>.` : `Not set up.`; }
      const word = { connected: "connected", stale: "needs fixing", off: "not set up" }[state];
      const fix = other || r.state === "connected" ? "" :
        `<div class="agent-fix">${r.state === "unreadable" ? "" : cmd(r.fix.command)}<details><summary>${r.state === "unreadable" ? "In" : "Or by hand, in"} <code>${esc(r.fix.place)}</code></summary>${cmd(r.fix.snippet, "snippet")}</details></div>`;
      const i = r.instructions;
      const line = other || !i ? "" : `<p class="agent-instr">${
        i.present ? `Asked to send what it writes, in <code>${esc(i.place)}</code>.`
        : state === "connected" ? `Not yet asked to send what it writes: the line below goes in <code>${esc(i.place)}</code>.`
        : `Then the line below, in <code>${esc(i.place)}</code>.`}</p>`;
      return `<li class="agent is-${state}" data-agent="${esc(r.id)}"><div class="agent-head"><span class="agent-dot"></span><b class="agent-name">${esc(r.name)}</b><span class="agent-state">${word}${when}</span></div><p class="agent-say">${say}</p>${fix}${line}</li>`;
    };
    const line = rows.find(r => r.instructions)?.instructions.line || "";
    return `<div class="connect"><header class="doc-head"><h1 class="doc-title">Connect an agent</h1><p class="doc-sub">Any agent that speaks MCP can send documents here. Each row is what that agent's own settings say about snyvi, right now.</p></header>` +
      `<ul class="agents">${rows.map(row).join("")}</ul>` +
      (line ? `<div class="connect-line"><p>The line that makes an agent send what it writes, for its instructions file or its rules setting:</p>${cmd(line)}</div>` : "") +
      `<p class="connect-foot">From a terminal, <code>${esc(a ? a.program : "snyvi")} send PLAN.md</code> sends a file by hand.</p></div>`;
  }
  async function showConnect(push = true) {
    if (push) leave();
    state.view = "connect"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "Connect an agent · snyvi";
    if (push) history.pushState({ connect: true }, "", "/connect");
    let a = boot.agents; boot.agents = null;
    if (!a) { try { a = await (await fetch("/api/agents")).json(); } catch { a = null; } }
    docEl.innerHTML = connectHtml(a);
    if (push) swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
    watchAgents();
  }
  /** Ask again while the page is on screen; redraw only when something changed. */
  function watchAgents() {
    clearInterval(agentsTimer);
    agentsTimer = setInterval(async () => {
      if (!docEl.querySelector(".connect") || document.hidden) return;
      let a; try { a = await (await fetch("/api/agents")).json(); } catch { return; }
      if (JSON.stringify(a.rows) === agentsSeen) return;
      const open = [...docEl.querySelectorAll(".agent details[open]")].map(d => d.closest(".agent").dataset.agent);
      docEl.innerHTML = connectHtml(a);
      for (const id of open) docEl.querySelector(`.agent[data-agent="${CSS.escape(id)}"] details`)?.setAttribute("open", "");
    }, 2500);
  }
  docEl.addEventListener("click", e => {
    const b = e.target.closest(".connect pre.cmd .copy");
    if (!b) return;
    navigator.clipboard?.writeText(b.parentElement.querySelector("code").textContent);
    b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200);
  });

  async function showCompare(aId, bId) {
    const cur = state.doc;
    const a = aId || state.previous, b = bId || (cur && cur.id);
    if (!cur || !a) { toast("No previous version", "This is the first document in its workflow."); return; }
    let j;
    try { j = await (await fetch(`/api/compare/${a}/${b}${state.split ? "?view=split" : ""}`)).json(); } catch (e) { toast("Compare failed", String(e)); return; }
    state.comparing = { a, b };
    docEl.innerHTML = `<header class="doc-head"><h1 class="doc-title">${esc(cur.title)}</h1><p class="doc-sub">changes ${fmt(j.a.received_at)} → ${fmt(j.b.received_at)}${state.split ? " · split" : " · inline"}</p></header><article class="prose kind-diff">${j.html}</article>`;
    swapIn();
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

  /** How long Undo is on the screen, and how long it answers to ⌘Z. */
  const UNDO_MS = 8000;
  let undoing = null;

  /** Delete now, ask nothing, and offer the way back.
   *
   *  The question used to be a `window.confirm`, which the native window draws
   *  as the toolkit's own dialog in the toolkit's theme, over a page it has
   *  nothing to do with -- and which had to be answered before anything else
   *  could happen. The daemon keeps the document until `prune` runs, so the
   *  eight seconds below are a real offer and not a hopeful one. */
  async function deleteCurrent() {
    if (!state.doc) return;
    const d = state.doc;
    try {
      const r = await fetch(`/api/docs/${d.id}/delete`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      state.cache.delete(d.id);
      depart([d.id]);
      state.queue = state.queue.filter(x => x.id !== d.id);
      state.waiting = Math.max(0, state.waiting - (waitingRow(d) ? 1 : 0));
      await refreshTree(d.project_id);
      showInbox(true);
      offerUndo(d);
    } catch (e) { toast("Could not delete", String(e)); }
  }

  /** The other half of a delete: a button in the toast, and ⌘Z for as long as
   *  it is there, which is where a reader's hand goes first. */
  function offerUndo(d) {
    const run = async () => {
      if (undoing !== run) return;
      undoing = null;
      try {
        const r = await fetch(`/api/docs/${d.id}/undelete`, { method: "POST" });
        if (r.status === 410) return toast("Too late to undo", "it has been pruned");
        if (!r.ok) throw new Error(`${r.status}`);
        wash([d.id]);
        await refreshTree(d.project_id);
        showDoc(d.id);
      } catch (e) { toast("Could not undo", String(e)); }
    };
    undoing = run;
    setTimeout(() => { if (undoing === run) undoing = null; }, UNDO_MS);
    toast("Deleted", d.title, null, { label: "Undo", run });
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
  /** Where the reader is, as a block and an offset into it rather than a
   *  pixel count. A block below the fold is a placeholder of a guessed height
   *  until it comes near the screen -- `content-visibility` in app.css -- so
   *  the same scrollTop in a freshly swapped body is a different paragraph.
   *  Measured: a refresh at 12,000 px put the reader at block 125 of the
   *  document they had been reading at block 68. The block is what stays put. */
  function placeOf() {
    const top = main.scrollTop, edge = main.getBoundingClientRect().top + 1;
    const blocks = docEl.querySelectorAll(".prose > *");
    let i = -1, delta = 0;
    for (let n = 0; n < blocks.length; n++) {
      const r = blocks[n].getBoundingClientRect();
      if (r.bottom > edge) { i = n; delta = r.top - edge + 1; break; }
    }
    return { top, i, delta };
  }

  /** Put the reader back. Named instant throughout: the pane scrolls smoothly
   *  by stylesheet, and a bare assignment to scrollTop honours that -- so every
   *  save of a watched file used to glide the reader from the top back to
   *  where they were. */
  function placeAt(p) {
    const el = p.i >= 0 ? docEl.querySelectorAll(".prose > *")[p.i] : null;
    if (!el) { main.scrollTo({ top: p.top, behavior: "instant" }); return; }
    const put = () => {
      if (!el.isConnected) return;   // the page moved on before a late put
      el.scrollIntoView({ block: "start", behavior: "instant" });
      main.scrollBy({ top: el.getBoundingClientRect().top - main.getBoundingClientRect().top - p.delta, behavior: "instant" });
    };
    put();
    // Once more after the blocks around it have been laid out for real.
    requestAnimationFrame(() => requestAnimationFrame(put));
    // And once the swap-in has finished, when there is one: it translates the
    // body 4 px while it runs, and a put measured during it lands 4 px off.
    if (docEl.classList.contains("swap")) docEl.addEventListener("animationend", put, { once: true });
  }

  /** A stored document was overwritten (a hook or `snyvi watch` send) or finished
   *  highlighting: fetch it again and swap the body in place, keeping the place. */
  async function refreshDoc(id) {
    state.cache.delete(id);
    if (!state.doc || state.doc.id !== id || state.comparing) return;
    const place = placeOf();
    let j; try { j = await fetchDoc(id); } catch { return; }
    if (!state.doc || state.doc.id !== id) return;
    state.doc = j.doc; state.previous = j.previous; state.folder = j.folder;
    setPreview(j.preview, j.preview_url, `d:${id}`);
    docEl.innerHTML = j.html;
    applyPreview();
    if (j.doc.kind === "diff" && state.split) await applySplit();
    placeAt(place);
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
    const place = placeOf();
    setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
    docEl.innerHTML = browseHtml(j.file, j.root);
    applyPreview();
    placeAt(place);
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
    // A new document under a filled figure: the figure goes with the old one,
    // and the browser's fullscreen, if it was granted, goes with it.
    if (document.fullscreenElement) quiet(document.exitFullscreen());
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
    mmdViewport(fig);
    // Named, so the browser budget can find it. A cache hit measures what it
    // actually costs, which is the assignment above.
    performance.measure("snyvi:diagram", { start: t0, end: performance.now() });
  }

  // ---------- a diagram in a viewport: pan, zoom, fullscreen ----------
  /* Mermaid hands back an SVG with a viewBox, and everything a reader needs is
   * a viewport around it. The viewBox is what this drives, rather than a CSS
   * transform: the browser redraws the same vectors into a different box, so
   * strokes stay crisp at any zoom and a frame costs nothing.
   *
   * Measured before it existed (docs/DIAGRAMS.md section 8): the 220-node
   * flowchart is 4738 px wide and was drawn 30 px tall, because `max-width:
   * 100%` fitted its width into the reading column and `height: auto` took the
   * height down with it. The one diagram big enough to be worth drawing was the
   * one that could not be read.
   *
   * A diagram that has to be shrunk to fit the column is the one that gets a
   * bounded frame; one that already fits keeps the height it drew itself at,
   * because for a long sequence diagram the page's own scroll is the right
   * viewport and always was. Both can be zoomed, panned and filled to the
   * screen. */
  const mmdViews = new WeakMap();
  const MMD_MAX_ZOOM = 40;          // 4738 px of flowchart, read at 120 px of it
  const MMD_MIN_FIT = 0.15;         // a fit smaller than this is a smudge, not a diagram
  let mmdTouched = null;            // the last diagram the reader used, for the keys

  /** The tallest a fitted diagram may be: most of a screen and never more than
   *  one, so the text after it is still something the reader can see. */
  const mmdCap = () => Math.max(260, Math.min(680, Math.round(innerHeight * 0.7)));

  /** Give a drawn diagram its frame and its fit. Called on every paint, cache
   *  hit included, because the SVG is new each time and the frame's width may
   *  not be. */
  function mmdViewport(fig) {
    const svg = fig.querySelector("svg");
    const frame = fig.querySelector(".mmd-frame");
    if (!svg || !frame) {
      mmdViews.delete(fig);
      return;
    }
    const full = fig.dataset.full === "1";
    // The window's width when the figure fills it, rather than the frame's:
    // the frame is the window then, but measured before the browser has laid
    // that out it still says what it was. A figure that is not laid out at
    // all cannot be fitted; left as it is, it is fitted on the next pass.
    const width = full ? Math.round(innerWidth) : frame.clientWidth;
    if (!width) return;
    mmdViews.delete(fig);
    // The graph's own bounds, kept on the element: the live viewBox is wherever
    // the reader has panned to, so a second pass -- a resize, or coming back
    // from fullscreen -- would otherwise take the view for the whole diagram
    // and never find its way out again.
    const vb = (svg.dataset.mmdBase || svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    // No usable viewBox is not a failure: the diagram is shown as Mermaid sized
    // it, and it simply has no viewport. Nothing below assumes one exists.
    if (vb.length !== 4 || vb.some(n => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) return;
    const base = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    svg.dataset.mmdBase = `${base.x} ${base.y} ${base.w} ${base.h}`;
    // Mermaid sizes the SVG itself, in the units it drew in. The frame decides
    // how big it is on the page from here on.
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.style.maxWidth = "none";
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    /* A graph far wider than the column has a fit nobody can read: the 220-node
     * flowchart measures 20023 units across and fits at 4% of itself, which is
     * a smudge rather than a shape. Past that point the diagram opens where a
     * label can be read instead -- at its own size, at the corner it starts in
     * -- and "Fit" is the button that offers the bird's-eye. Under it, fitted
     * is what a reader wants and what they get. */
    const fitScale = width / base.w;
    const smudge = fitScale < MMD_MIN_FIT;
    const height = full ? Math.round(innerHeight)
      : smudge ? mmdCap()
        : base.w > width ? Math.max(220, Math.min(mmdCap(), Math.round(base.h * fitScale)))
          : Math.round(base.h);
    frame.style.height = `${height}px`;
    mmdViews.set(fig, { base, svg, frame, view: { ...base }, fit: null });
    mmdFit(fig);
    if (smudge && !full) mmdStart(fig);
    mmdTools(fig);
  }

  /** The whole graph, in a box shaped like the frame it is shown in.
   *
   *  Matching the frame's aspect ratio is what makes the arithmetic below exact:
   *  with the two in step there is no letterboxing, so one pixel of frame is one
   *  known distance in the diagram and a point under the cursor can be held
   *  still while the view shrinks around it. */
  function mmdFit(fig) {
    const v = mmdViews.get(fig);
    if (!v) return;
    const r = v.frame.getBoundingClientRect();
    const shape = (r.width || 1) / (r.height || 1);
    const { base } = v;
    const w = base.w / base.h > shape ? base.w : base.h * shape;
    const h = w / shape;
    v.fit = { x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h };
    v.view = { ...v.fit };
    // A diagram small enough to be shown whole at its own size is already at
    // full size, so "100%" would be a button that does nothing. Zoom in and out
    // still say what they mean, and the toggle comes back the moment there is a
    // difference between the two states.
    v.shrunk = (r.width || 1) / w < 0.995;
    mmdApply(fig);
  }

  /** Where a diagram too wide to fit opens: its own size, at the corner it
   *  starts in, which for every graph Mermaid lays out is where the beginning
   *  of it is. */
  function mmdStart(fig) {
    const v = mmdViews.get(fig);
    if (!v) return;
    const r = v.frame.getBoundingClientRect();
    const w = Math.min(v.fit.w, r.width || v.fit.w);
    const h = w * v.fit.h / v.fit.w;
    v.view = { x: v.base.x, y: v.base.y, w, h };
    mmdClamp(fig);
    mmdApply(fig);
  }

  /** Pixels per diagram unit, as the SVG is actually drawn right now. */
  function mmdScale(fig) {
    const v = mmdViews.get(fig);
    if (!v) return 1;
    const r = v.svg.getBoundingClientRect();
    return Math.min(r.width / v.view.w, r.height / v.view.h) || 1;
  }

  /** Where in the diagram a point on the screen is. */
  function mmdPoint(fig, cx, cy) {
    const v = mmdViews.get(fig);
    if (!v || cx == null) return null;
    const r = v.svg.getBoundingClientRect();
    const s = Math.min(r.width / v.view.w, r.height / v.view.h);
    if (!(s > 0)) return null;
    const ox = (r.width - v.view.w * s) / 2, oy = (r.height - v.view.h * s) / 2;
    return { x: v.view.x + (cx - r.left - ox) / s, y: v.view.y + (cy - r.top - oy) / s };
  }

  /** The reader cannot lose the diagram: wherever the view goes, its middle
   *  stays over the graph. Forgiving rather than strict, so a flick of the
   *  wrist never has to be undone. */
  function mmdClamp(fig) {
    const { base, view } = mmdViews.get(fig);
    const cx = Math.min(Math.max(view.x + view.w / 2, base.x), base.x + base.w);
    const cy = Math.min(Math.max(view.y + view.h / 2, base.y), base.y + base.h);
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
  }

  function mmdApply(fig) {
    const v = mmdViews.get(fig);
    if (!v) return;
    const { view, fit } = v;
    v.svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    const zoomed = !!fit && view.w < fit.w - 0.5;
    fig.dataset.zoom = zoomed ? "in" : "fit";
    const toggle = fig.querySelector("[data-mmd=zoom]");
    if (toggle) {
      toggle.hidden = !v.shrunk && !zoomed;
      toggle.textContent = zoomed ? "Fit" : "100%";
      toggle.title = zoomed ? "Fit the whole diagram  0" : "Show it at full size";
    }
  }

  /** Zoom by `k` about a point on the screen, or about the middle of the frame.
   *  Out is bounded by the fit -- there is nothing past the whole diagram -- and
   *  in by MMD_MAX_ZOOM, which is where the largest diagram measured becomes a
   *  screenful of readable labels. */
  function mmdZoom(fig, k, cx, cy) {
    const v = mmdViews.get(fig);
    if (!v || !v.fit) return;
    const w = Math.max(v.fit.w / MMD_MAX_ZOOM, Math.min(v.fit.w, v.view.w / k));
    if (Math.abs(w - v.view.w) < 0.01) return;
    const h = w * v.view.h / v.view.w;
    const p = mmdPoint(fig, cx, cy) || { x: v.view.x + v.view.w / 2, y: v.view.y + v.view.h / 2 };
    v.view.x = p.x - (p.x - v.view.x) * (w / v.view.w);
    v.view.y = p.y - (p.y - v.view.y) * (h / v.view.h);
    v.view.w = w;
    v.view.h = h;
    mmdClamp(fig);
    mmdApply(fig);
    mmdTouched = fig;
  }

  /** One diagram unit per pixel: the "let me read that label" half of the
   *  toggle, from wherever the reader is looking. */
  function mmdActual(fig) {
    const v = mmdViews.get(fig);
    if (!v || !v.fit) return;
    const r = v.frame.getBoundingClientRect();
    mmdZoom(fig, v.view.w / Math.max(1, r.width), null, null);
  }

  /** Fill the window with one diagram; the same key or button, or Escape,
   *  gives the page back.
   *
   *  The figure is laid over the page from where it is (`.mmd[data-full]` in
   *  app.css), and the document, not the figure, asks the browser for
   *  fullscreen -- a courtesy that hides the browser's own chrome where it is
   *  granted, and nothing here depends on the answer. 0.9 put the figure
   *  itself in the top layer, and in WebKitGTK, the engine of the Linux
   *  window, two things came of that: every glyph inside the fullscreen
   *  element drew as nothing -- the boxes and arrows stayed; the labels, the
   *  tool bar and an SVG's own <text> went -- and on the way back the figure,
   *  a content-visibility placeholder again, kept the placeholder's size
   *  until the next scroll laid it out. A fixed box in the page has neither
   *  fault in any engine, and the figure is marked visible for good, since it
   *  is the one the reader is looking at. bench/webkit.py is where both were
   *  seen. */
  let mmdFullFrom = 0;   // where the document was, to put it back there
  function quiet(p) { if (p && p.catch) p.catch(() => {}); }   // a promise whose refusal is no news
  function mmdFull(fig) {
    const open = docEl.querySelector(".mmd[data-full]");
    if (open) { mmdUnfill(open); return; }
    mmdFullFrom = main.scrollTop;
    fig.style.contentVisibility = "visible";
    fig.dataset.full = "1";
    mmdRefit();
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) quiet(document.documentElement.requestFullscreen());
  }
  function mmdUnfill(fig) {
    delete fig.dataset.full;
    main.scrollTo({ top: mmdFullFrom, behavior: "instant" });
    mmdRefit();
    if (document.fullscreenElement) quiet(document.exitFullscreen());
  }
  /** After the browser has laid the change out, not during: measured
   *  mid-transition, a frame reports the width it is leaving and the diagram
   *  comes back fitted to a column that is no longer there. */
  function mmdRefit() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) mmdViewport(fig);
    }));
  }
  // The browser's own way out -- Escape, or whatever it binds -- ends the
  // fill too; a window that changed size around it is measured again.
  document.addEventListener("fullscreenchange", () => {
    const open = docEl.querySelector(".mmd[data-full]");
    if (open && !document.fullscreenElement) mmdUnfill(open);
    else mmdRefit();
  });

  /** The controls, added once per figure and shown when it is under the cursor
   *  or holds the focus -- the same bargain the rename pencils in the tree make:
   *  present when wanted, absent from a page being read. */
  function mmdTools(fig) {
    if (fig.querySelector(".mmd-tools")) return;
    const bar = document.createElement("div");
    bar.className = "mmd-tools";
    bar.innerHTML =
      `<button type="button" data-mmd="out" title="Zoom out" aria-label="Zoom out">−</button>` +
      `<button type="button" data-mmd="in" title="Zoom in  (double-click, or ⌘/ctrl + scroll)" aria-label="Zoom in">+</button>` +
      `<button type="button" data-mmd="zoom" title="Show it at full size">100%</button>` +
      `<button type="button" data-mmd="full" title="Fill the screen  f" aria-label="Fill the screen">⛶</button>`;
    fig.appendChild(bar);
    mmdApply(fig);
  }

  /** Which diagram a key means: the one under the cursor, else whichever one is
   *  most on screen, else the last one the reader used.
   *
   *  "The first one on the page" was the obvious fallback and the wrong one --
   *  a reader pressing a key is looking at something, and on a page of eight
   *  diagrams it is rarely the first. */
  function mmdKeyed() {
    const hovered = docEl.querySelector('.mmd[data-state="done"]:hover');
    if (hovered && mmdViews.has(hovered)) return hovered;
    const middle = innerHeight / 2;
    let best = null, nearest = Infinity;
    for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) {
      if (!mmdViews.has(fig)) continue;
      const r = fig.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - middle);
      if (d < nearest) { nearest = d; best = fig; }
    }
    if (best) return best;
    return mmdTouched && mmdTouched.isConnected && mmdViews.has(mmdTouched) ? mmdTouched : null;
  }

  docEl.addEventListener("click", e => {
    const b = e.target.closest("[data-mmd]");
    if (!b) return;
    const fig = b.closest(".mmd");
    if (!fig) return;
    mmdTouched = fig;
    const what = b.dataset.mmd;
    if (what === "in") mmdZoom(fig, 1.6, null, null);
    else if (what === "out") mmdZoom(fig, 1 / 1.6, null, null);
    else if (what === "full") mmdFull(fig);
    else if (what === "zoom") fig.dataset.zoom === "in" ? mmdFit(fig) : mmdActual(fig);
  });

  /* Zoom on ⌘/ctrl + scroll, which is the web's own convention and the reason a
   * cursor crossing a diagram never traps the page. A trackpad pinch arrives
   * here as exactly this event, so pinching works without a second path. */
  docEl.addEventListener("wheel", e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const fig = e.target.closest('.mmd[data-state="done"]');
    if (!fig || !mmdViews.has(fig)) return;
    e.preventDefault();
    mmdZoom(fig, Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  }, { passive: false });

  /* Drag to pan, but only once there is something to pan to: a fitted diagram
   * holds the whole graph already, and a drag across it is a reader selecting a
   * label, not moving a map. */
  docEl.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const fig = e.target.closest('.mmd[data-state="done"]');
    if (!fig || fig.dataset.zoom !== "in" || !mmdViews.has(fig) || e.target.closest("[data-mmd]")) return;
    const v = mmdViews.get(fig);
    let last = { x: e.clientX, y: e.clientY };
    fig.dataset.grab = "1";
    mmdTouched = fig;
    const move = ev => {
      const s = mmdScale(fig);
      v.view.x -= (ev.clientX - last.x) / s;
      v.view.y -= (ev.clientY - last.y) / s;
      last = { x: ev.clientX, y: ev.clientY };
      mmdClamp(fig);
      mmdApply(fig);
    };
    const up = () => {
      delete fig.dataset.grab;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    e.preventDefault();
  });

  docEl.addEventListener("dblclick", e => {
    const fig = e.target.closest('.mmd[data-state="done"]');
    if (!fig || !mmdViews.has(fig)) return;
    e.preventDefault();
    mmdZoom(fig, 2, e.clientX, e.clientY);
  });

  /* The frame's width decides the fit, so a window that changes size has
   * changed the fit. Re-measured rather than rescaled, which also puts a
   * diagram back where the reader can see all of it. */
  let mmdResize = null;
  addEventListener("resize", () => {
    clearTimeout(mmdResize);
    mmdResize = setTimeout(() => {
      for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) mmdViewport(fig);
    }, 150);
  });

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
    if (findMarks.length) gotoFind(0); else findCount.textContent = "No matches";
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
  /** Mark one entry as where the reader is, and keep it where they can see it.
   *
   *  The contents used to be marked and never moved: on a plan with 46
   *  headings the marker left the visible part of the rail at section 4 and
   *  the rail showed sections 0-4 for the rest of the read. It follows now,
   *  the way an editor's outline does -- except while the pointer is over it,
   *  because a list that scrolls under a hand about to click is worse than
   *  one that lags a heading. */
  function markCur(links, at) {
    let cur = null;
    links.forEach((a, i) => {
      const on = i === at;
      a.classList.toggle("cur", on);
      if (on) { a.setAttribute("aria-current", "location"); cur = a; } else a.removeAttribute("aria-current");
    });
    if (cur) keepCurInView(false);
  }
  /** Scroll the contents so the current entry is in view. `now` skips the
   *  hover exemption and the smooth scroll: a sheet that has just opened has
   *  no pointer over it yet and no place it is scrolling from. */
  function keepCurInView(now) {
    const cur = tocEl.querySelector("a.cur");
    if (!cur || (!now && tocEl.matches(":hover"))) return;
    const top = cur.offsetTop, bottom = top + cur.offsetHeight;
    const seen = tocEl.scrollTop, h = tocEl.clientHeight;
    if (top >= seen + 24 && bottom <= seen + h - 24) return;
    tocEl.scrollTo({ top: Math.max(0, top - h / 2), behavior: now ? "instant" : "smooth" });
  }

  /** Call `track` on the frame after every scroll or resize, and once now.
   *  An IntersectionObserver did this before, firing when a heading crossed
   *  a band below the top edge -- and a jump of a page or more can land with
   *  no heading in the band, on which nothing fired and the marker stayed on
   *  the section the reader had left. Reading every heading's position on a
   *  scroll frame is cheap: headings opt out of content-visibility, so none
   *  is a placeholder that has to be laid out to be asked. */
  function follow(track) {
    let queued = false;
    const tick = () => { queued = false; track(); };
    const poke = () => { if (!queued) { queued = true; requestAnimationFrame(tick); } };
    main.addEventListener("scroll", poke, { passive: true });
    addEventListener("resize", poke);
    poke();
    return { disconnect() { main.removeEventListener("scroll", poke); removeEventListener("resize", poke); } };
  }

  let spy = null;
  function buildToc() {
    if (spy) { spy.disconnect(); spy = null; }
    tocEl.scrollTop = 0;   // a new document starts at its beginning, and so does its contents
    const reading = state.view === "doc" || state.view === "browse";
    const hs = reading ? [...docEl.querySelectorAll(".prose h1, .prose h2, .prose h3, .prose h4")] : [];
    if (hs.length < 3) { tocEl.innerHTML = ""; buildOutline(); }
    else {
      tocEl.innerHTML = `<ul>` + hs.map((h, i) => {
        // The renderer's own slug where there is one, so the URL the contents
        // write is the one the `#` beside the heading writes; a counter where
        // there is not, as in a rendered notebook or a browsed page.
        const id = h.querySelector("a.anchor[id]")?.id || h.id || (h.id = `h-${i}`);
        return `<li class="d${h.tagName[1]}"><a href="#${esc(id)}" data-i="${i}">${esc(h.textContent.replace(/^#\s*/, ""))}</a></li>`;
      }).join("") + `</ul>`;
      const links = [...tocEl.querySelectorAll("a")];
      spy = follow(() => {
        let cur = -1;
        hs.forEach((h, i) => { if (h.getBoundingClientRect().top < 120) cur = i; });
        // At the very end the last section is the one being read, even when
        // it is shorter than the fold and its heading never reaches the top.
        if (main.scrollTop + main.clientHeight >= main.scrollHeight - 2) cur = hs.length - 1;
        markCur(links, cur);
      });
    }
    rail.classList.toggle("empty", state.view === "inbox" || state.view === "connect");
  }

  /* A contents entry is a hash link, and the browser's own handling of one
   * does two things wrong here. It pushes a history entry per click, so Back
   * after reading three sections walks back through them -- and each step
   * landed in popstate, which rebuilt the document and put the reader at the
   * top. And it puts the heading flush against the pane's edge. The URL still
   * gets the hash, so a link to a section can be copied; the entry is replaced
   * rather than added, and the heading's scroll margin gives it room. */
  tocEl.addEventListener("click", e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    const h = headingFor(a.getAttribute("href").slice(1));
    if (!h) return;
    e.preventDefault();
    history.replaceState(history.state, "", location.pathname + a.getAttribute("href"));
    jumpTo(h);
    if (root.dataset.sheet === "rail") closeSheet();
  });

  /** Go to a block of the document. Instant, not smooth, and on purpose: a
   *  smooth scroll aims at where the target is when it starts, and in a long
   *  document the blocks between here and there are placeholders that grow
   *  as the scroll passes them. Measured: a smooth jump of 5000 px stopped
   *  1658 px short of its heading. An instant one lands, the two frames
   *  after it put right what the blocks around the target did to it on
   *  arrival, and the flash says where it went. */
  function jumpTo(el) {
    const put = () => el.scrollIntoView({ block: "start", behavior: "instant" });
    put();
    requestAnimationFrame(() => requestAnimationFrame(put));
    flash(el);
  }

  /** The heading a fragment names. The renderer puts the id on the anchor
   *  inside the heading, and the heading is what carries the scroll margin. */
  function headingFor(id) {
    const el = document.getElementById(decodeURIComponent(id));
    return el && (el.closest("h1, h2, h3, h4, h5, h6") || el);
  }

  /** Where a hash on the document already on screen points, without a rebuild. */
  function jumpToHash() {
    if (lineHash()) { applyLineHash(true); return; }
    const h = location.hash.length > 1 && headingFor(location.hash.slice(1));
    if (h) jumpTo(h);
  }

  /* The `#` beside a heading: a link to the section, written into the URL and
   * onto the clipboard, the way a click on a line number is. It does not
   * scroll -- the reader is looking at the heading already. */
  docEl.addEventListener("click", e => {
    const a = e.target.closest("a.anchor[href^='#']");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    history.replaceState(history.state, "", location.pathname + a.getAttribute("href"));
    navigator.clipboard?.writeText(location.href);
    // Confirmed on the mark itself, which is where the eye is: a toast at the
    // corner for a click at the heading is the wrong distance away.
    a.dataset.said = "Copied";
    clearTimeout(a._said);
    a._said = setTimeout(() => delete a.dataset.said, 1200);
  });

  /* Tab into a code block below the fold and the browser focuses the copy
   * button without bringing it on screen -- the block is a placeholder, see
   * content-visibility in app.css -- and the next Tab, asked to go on from
   * inside a placeholder, gives up and lands on the body; the rail's entries
   * after it are never reached. Bring whatever takes focus on screen, which
   * is what a keyboard reader wants anyway, and which makes the block real. */
  docEl.addEventListener("focusin", e => {
    const block = e.target.closest(".prose > *");
    if (!block) return;
    // A block with focus in it is never a placeholder again: the scroll
    // below is aimed through placeholders and can overshoot by a screen,
    // and a focused element that ends up inside a skipped block is blurred
    // by the browser -- which is how Tab was reaching the body.
    block.style.contentVisibility = "visible";
    const put = () => e.target.scrollIntoView({ block: "nearest", behavior: "instant" });
    put();
    requestAnimationFrame(() => requestAnimationFrame(put));
  });

  /* Scroll chaining, restored. The document pane is a sibling of the two side
   * panes rather than their ancestor, so a wheel over the contents that the
   * contents could not use went nowhere: measured, 5600 px of wheel over the
   * rail moved the document 0 px, and any amount over the sidebar moved
   * nothing at all. The browser chains a scroll to the nearest ancestor that
   * can take it; the pane that should take it here is the one beside it. */
  for (const pane of [$("#side"), rail]) pane.addEventListener("wheel", e => {
    if (e.ctrlKey || e.metaKey || !e.deltaY) return;
    const box = e.target.closest("#trees, #toc, #meta");
    if (box && (e.deltaY < 0 ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1)) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * main.clientHeight : e.deltaY;
    main.scrollBy({ top: dy, behavior: "instant" });
    e.preventDefault();
  }, { passive: false });

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
    outlineSpy = follow(() => {
      let cur = -1;
      items.forEach((o, i) => { const el = lines[o.line - 1]; if (el && el.getBoundingClientRect().top < 140) cur = i; });
      markCur(links, cur);
    });
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
      `<button data-act="delete">Delete<kbd>Del</kbd></button>` +
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
    if (root.dataset.sheet === "side") closeSheet();
  });
  document.addEventListener("mouseover", e => {
    const a = e.target.closest("a[data-id]");
    if (a && !state.cache.has(a.dataset.id)) fetchDoc(a.dataset.id).catch(() => {});
  });
  window.addEventListener("popstate", () => {
    const d = location.pathname.match(/^\/d\/([a-z0-9]+)$/);
    // Back or forward to a hash on the document already on screen -- the `#`
    // beside a heading pushes one -- is a move within it, not a rebuild.
    if (d && state.view === "doc" && state.doc && state.doc.id === d[1] && !state.comparing) return jumpToHash();
    if (d) return showDoc(d[1], false, true);
    const b = location.pathname.match(/^\/b\/([a-z0-9]+)(?:\/(.*))?$/);
    if (b) return showBrowse(b[1], decodeURIComponent(b[2] || ""), false, true);
    if (location.pathname === "/connect") return showConnect(false);
    showInbox(false);
  });

  // ---------- live arrivals ----------

  /** Whether this page is the native window's, which decides where the daemon
   *  sends a link that is opened from outside it -- `snyvi open`, a terminal, a
   *  click on a notification.
   *
   *  `snyvi app` puts the mark on the first URL it hands the window, and the
   *  page keeps it for the session rather than in the address: the window
   *  navigates all day, and a mark in a URL would be lost by the first of
   *  those and copied into every link the reader shares. Storage that belongs
   *  to this one page and dies with it is exactly the lifetime wanted. */
  const inWindow = (() => {
    try {
      if (new URLSearchParams(location.search).has("window")) {
        sessionStorage.setItem("snyvi.window", "1");
        // Out of the address bar at once, and out of the history entry, so
        // Back never returns to a marked URL and no copied link carries it.
        history.replaceState(history.state, "", location.pathname + location.hash);
      }
      return sessionStorage.getItem("snyvi.window") === "1";
    } catch { return false; }
  })();

  /** The daemon's event stream, and the one socket this page holds open for
   *  as long as it lives.
   *
   *  It is given back on the way out. A browser allows six connections to one
   *  host over HTTP/1.1, a stream that never ends holds one of them for good,
   *  and a document on its way out -- to the back/forward cache, or simply
   *  being replaced -- keeps its own until it is destroyed. So six page loads
   *  in a row left six streams behind, the pool ran out, and the seventh page
   *  did not load for 25 seconds: measured at 6 sockets by bench/ui.mjs, which
   *  is how this was found. A page restored from the cache connects again and
   *  catches up on what it missed while it was away. */
  let stream = null, retry = null;

  addEventListener("pagehide", () => {
    clearTimeout(retry);
    if (stream) { stream.close(); stream = null; }
  });
  addEventListener("pageshow", e => { if (e.persisted && !stream) { connect(); catchUp(); } });

  /** What a page that was away has to ask for, since it heard no events. */
  async function catchUp() {
    try {
      const q = await (await fetch(`/api/queue?limit=${QUEUE_HELD}`)).json();
      if (Array.isArray(q)) {
        state.queue = q;
        // Fewer than the page ever holds means these are all there are.
        state.waiting = q.length < QUEUE_HELD ? q.length : Math.max(state.waiting, q.length);
      }
    } catch {}
    await refreshTree();
    if (state.view === "inbox") showInbox(false);
  }

  function connect() {
    const es = new EventSource("/api/events" + (inWindow ? "?window=1" : ""));
    stream = es;
    es.addEventListener("doc", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      const d = j.doc;
      // One project moved, so one project's rows are what is refetched. This
      // used to pull the whole library back down and rebuild the sidebar on
      // every arrival -- a file saved every few seconds paid it every few
      // seconds.
      // An overwrite of a document already here is not an arrival: refresh it where
      // it is if it is on screen, never navigate to it, and never toast — a file
      // being watched changes on every save.
      if (j.existing) {
        if (state.doc && state.doc.id === d.id) await refreshDoc(d.id);
        else state.cache.delete(d.id);
        await refreshTree(d.project_id);
        return;
      }
      // An arrival joins the queue and the page stays where it is. The one
      // place it opens by itself is the inbox with nothing waiting: the empty
      // state exists to be filled, and a reader there has nothing to lose.
      // An inbox with a queue on it is the queue, and the arrival is a row.
      const opens = state.view === "inbox" && !state.waiting;
      // Held in order only while everything waiting is held: past that the
      // arrival is the newest, and belongs after rows this page never had.
      if (!queueIds.has(d.id) && state.queue.length === state.waiting) state.queue.push(d);
      state.waiting = j.waiting != null ? j.waiting : state.waiting + 1;
      if (!opens) wash([d.id]);
      holdQueue();   // a burst's events carry counts ahead of the rows this page holds
      state.cache.delete(d.id);
      renderTree(); markActive();
      await refreshTree(d.project_id);
      if (opens) { await showDoc(d.id, true); toast(d.title, `${d.project} · just now`); }
      else if (state.view === "inbox") showInbox(false);
    });
    // A document was opened somewhere -- this tab, another, the window -- and
    // is off the queue everywhere.
    es.addEventListener("read", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(j.ids)) dropFromQueue(j.ids, j.waiting);
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
      depart([j.id]);
      state.queue = state.queue.filter(d => d.id !== j.id);
      if (j.waiting != null) state.waiting = j.waiting;
      await refreshTree();
      if (state.doc && state.doc.id === j.id) showInbox(true);
    });
    // A delete that was taken back, in every tab and the window: the row is
    // where it was, and so is its place in the queue if it never got read.
    es.addEventListener("restored", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.waiting != null) state.waiting = j.waiting;
      if (j.id != null) wash([j.id]);
      await refreshTree(j.doc && j.doc.project_id);
      holdQueue();
      if (state.view === "inbox") showInbox(false);
    });
    // The library is gone, from this tab or another: every page starts over.
    es.addEventListener("reset", () => afterReset());
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
    es.onerror = () => {
      es.close();
      if (stream === es) stream = null;
      retry = setTimeout(connect, 2000);
    };
  }

  /** A line at the corner. `onClick` makes the whole toast one; `action`
   *  ({label, run}) puts a button in it instead, for the one thing a toast
   *  can offer that a reader must be able to reach deliberately. */
  function toast(title, sub, onClick, action) {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<span class="dot"></span><span><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "act"; b.textContent = action.label;
      b.addEventListener("click", ev => { ev.stopPropagation(); el.remove(); action.run(); });
      el.appendChild(b);
    } else {
      el.addEventListener("click", () => { el.remove(); onClick && onClick(); });
    }
    $("#toasts").appendChild(el);
    const life = action ? UNDO_MS : onClick ? 8000 : 3500;
    setTimeout(() => { el.style.transition = "opacity 160ms"; el.style.opacity = "0"; setTimeout(() => el.remove(), 180); }, life);
    return el;
  }

  // ---------- palette ----------
  const pal = $("#palette"), palIn = $("#palette-input"), palList = $("#palette-list");
  let palSel = 0, palItems = [], palTimer = null;
  function openPalette() {
    palIn.value = "";
    palIn.placeholder = browsing() ? `Find a file in ${state.browseRoot.name}…  (:120 for a line)`
      : codePre() ? "Search documents…  (:120 for a line)" : "Search documents…  (p:project  kind:md|code|diff)";
    openDialog(pal, palIn); palSearch("");
  }
  const browsing = () => state.view === "browse" && state.browseRoot;
  function closePalette() { closeDialog(pal); }
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
  // ---------- dialogs: focus goes in, stays in, and comes back ----------
  const appEl = $("#app"), help = $("#help"), aboutDlg = $("#about"), resetDlg = $("#reset");
  const dialogs = [pal, help, aboutDlg, resetDlg];
  const anyDialogOpen = () => dialogs.some(d => !d.hidden);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  let dialogOpener = null;
  /** Show a dialog. The page behind it goes inert, so Tab and a screen
   *  reader stay inside it, and whatever had focus gets it back on close. */
  function openDialog(el, focusEl) {
    if (!el.hidden) { (focusEl || el).focus(); return; }
    if (!anyDialogOpen()) dialogOpener = document.activeElement;
    el.hidden = false;
    appEl.inert = true;
    (focusEl || el.querySelector(FOCUSABLE) || el.firstElementChild).focus();
  }
  function closeDialog(el) {
    if (el.hidden) return;
    el.hidden = true;
    if (anyDialogOpen()) return;
    appEl.inert = false;
    const back = dialogOpener; dialogOpener = null;
    if (back && back.isConnected && back !== document.body) back.focus();
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const box = dialogs.find(d => !d.hidden)?.firstElementChild;
    if (!box) return;
    const f = [...box.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const at = document.activeElement, first = f[0], last = f[f.length - 1];
    if (e.shiftKey ? (at === first || !box.contains(at)) : (at === last || !box.contains(at))) {
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }, true);
  help.addEventListener("click", e => { if (e.target === help) closeDialog(help); });
  $("#help-close").addEventListener("click", () => closeDialog(help));
  $("#btn-help").addEventListener("click", () => openDialog(help, help.firstElementChild));

  // ---------- about: what this is, from the daemon ----------
  /* Every number here is read from the daemon when the panel opens, not
   * baked into this bundle, so the version it names is the one answering
   * and the one `snyvi --version` prints. */
  const aboutFacts = $("#about-facts");
  async function openAbout() {
    closeDialog(help);
    aboutFacts.replaceChildren();
    openDialog(aboutDlg, aboutDlg.firstElementChild);
    let a;
    try { a = await (await fetch("/api/about")).json(); } catch { $("#about-say").textContent = "The daemon did not answer."; return; }
    $("#about-say").textContent = `${a.description}.`;
    const fact = (k, v, cls) => {
      if (v == null || v === "") return;
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); if (cls) dd.className = cls;
      if (v instanceof Node) dd.append(v); else dd.textContent = v;
      aboutFacts.append(dt, dd);
    };
    const ver = document.createDocumentFragment();
    ver.append(a.version);
    const build = [a.commit, a.target].filter(Boolean).join(", ");
    if (build) { const m = document.createElement("span"); m.className = "muted"; m.textContent = ` (${build})`; ver.append(m); }
    fact("Version", ver);
    fact("Binary", a.binary, "path");
    fact("Documents", a.data_dir, "path");
    fact("Settings", a.config_dir, "path");
    fact("Agents", a.agents, "pre");
    fact("License", a.license);
    if (a.repository) {
      const link = document.createElement("a"); link.href = a.repository; link.target = "_blank"; link.rel = "noopener";
      link.textContent = a.repository.replace(/^https?:\/\//, "");
      fact("Source", link);
    }
  }
  $("#btn-about").addEventListener("click", openAbout);
  $("#btn-connect").addEventListener("click", () => { closeDialog(help); showConnect(); });
  $("#about-close").addEventListener("click", () => closeDialog(aboutDlg));
  aboutDlg.addEventListener("click", e => { if (e.target === aboutDlg) closeDialog(aboutDlg); });

  // ---------- reset: the one thing that cannot be undone ----------
  /* A delete has Undo; this has a number. The dialog says what goes and what
   * stays, and the button stays dead until the number of documents is typed
   * back -- the number, not "yes", because the number means the sentence was
   * read. The daemon is sent that number and refuses if it is no longer
   * true, so a document that arrived while the dialog was open is not reset
   * unseen. Every open tab hears the event and comes back to the empty
   * library with its preferences dropped; the agents stay registered. */
  const resetSay = $("#reset-say"), resetN = $("#reset-n"), resetGo = $("#reset-go"), resetErr = $("#reset-err");
  const resetPinRow = $("#reset-pinned-row"), resetPin = $("#reset-pinned");
  let resetCensus = null;
  function resetArm() {
    resetGo.disabled = !resetCensus || resetN.value.trim() !== String(resetCensus.documents) || (resetCensus.pinned > 0 && !resetPin.checked);
  }
  async function openReset() {
    closeDialog(help);
    resetCensus = null; resetN.value = ""; resetErr.hidden = true; resetPin.checked = false; resetPinRow.hidden = true;
    resetSay.textContent = "Reading what there is…";
    resetArm();
    openDialog(resetDlg, resetN);
    try { resetCensus = await (await fetch("/api/reset")).json(); } catch { resetSay.textContent = "The daemon did not answer."; return; }
    resetSay.textContent = `This removes ${plural(resetCensus.documents, "document")} in ${plural(resetCensus.projects, "project")}, the index, the token and this page's preferences. Agents stay connected: the next document they send lands in an empty library. Nothing can be undone.`;
    if (resetCensus.pinned > 0) {
      $("#reset-pinned-say").textContent = `Also the ${plural(resetCensus.pinned, "pinned document")} — a pin means keep`;
      resetPinRow.hidden = false;
    }
    resetArm();
  }
  /** What every tab does when the library is gone: forget what it kept for
   *  the reader, and start over where a newcomer does. The window keeps its
   *  mark -- it is a fact about the window, not a preference. */
  function afterReset() {
    try { Object.keys(localStorage).filter(k => k.startsWith("snyvi.")).forEach(k => localStorage.removeItem(k)); } catch {}
    location.replace("/");
  }
  $("#btn-reset").addEventListener("click", openReset);
  $("#reset-close").addEventListener("click", () => closeDialog(resetDlg));
  $("#reset-cancel").addEventListener("click", () => closeDialog(resetDlg));
  resetDlg.addEventListener("click", e => { if (e.target === resetDlg) closeDialog(resetDlg); });
  resetN.addEventListener("input", resetArm);
  resetPin.addEventListener("change", resetArm);
  resetDlg.firstElementChild.addEventListener("submit", async e => {
    e.preventDefault();
    if (resetGo.disabled) return;
    resetGo.disabled = true;
    let r;
    try {
      r = await fetch("/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documents: resetCensus.documents, pinned: resetPin.checked }) });
    } catch { resetErr.textContent = "The daemon did not answer."; resetErr.hidden = false; return; }
    if (r.ok) { afterReset(); return; }
    let j = {}; try { j = await r.json(); } catch {}
    resetErr.textContent = j.error || `The daemon refused (${r.status}).`;
    resetErr.hidden = false;
    // The number has moved: say the new sentence and ask for the new number.
    if (j.census) { resetCensus = j.census; resetN.value = ""; resetSay.textContent = resetSay.textContent.replace(/^This removes [^,]+,/, `This removes ${plural(j.census.documents, "document")} in ${plural(j.census.projects, "project")},`); }
    resetArm();
  });

  // ---------- the panes on a narrow window ----------
  /* Past the widths in app.css the rail and then the sidebar stop fitting
   * beside the document, and each becomes a sheet over it: `t` and `\`
   * open the sheet rather than changing the setting the wide layout keeps,
   * the two buttons in #chrome do the same for a finger, and Escape or a
   * tap on the scrim closes it. The contents inside the sheet open on the
   * current section, which the hidden pane could not scroll to. */
  const railNarrow = matchMedia("(max-width: 1100px)"), sideNarrow = matchMedia("(max-width: 760px)");
  const sideEl = $("#side");
  let sheetOpener = null;
  function openSheet(which, opener) {
    if (root.dataset.sheet === which) return;
    sheetOpener = opener || document.activeElement;
    root.dataset.sheet = which;
    if (which === "rail") keepCurInView(true);
    const first = which === "rail"
      ? tocEl.querySelector("a.cur") || tocEl.querySelector("a") || metaEl.querySelector("button, a")
      : sideEl.querySelector("#trees a[aria-current], #trees a, #trees summary");
    (first || (which === "rail" ? rail : sideEl)).focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!root.dataset.sheet) return false;
    delete root.dataset.sheet;
    const back = sheetOpener; sheetOpener = null;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
    return true;
  }
  const toggleSheet = (which, opener) => root.dataset.sheet === which ? closeSheet() : openSheet(which, opener);
  $("#scrim").addEventListener("click", closeSheet);
  $("#btn-rail").addEventListener("click", e => toggleSheet("rail", e.currentTarget));
  $("#btn-side").addEventListener("click", e => toggleSheet("side", e.currentTarget));
  // The window grew past the width that made it a sheet: it is a pane again.
  const sheetFits = () => root.dataset.sheet === "rail" ? railNarrow.matches : root.dataset.sheet === "side" ? sideNarrow.matches : true;
  for (const mq of [railNarrow, sideNarrow]) mq.addEventListener("change", () => { if (!sheetFits()) closeSheet(); });

  // ---------- the panes' widths ----------
  /* Each pane's edge drags, between a floor where its rows stop being
   * readable and a ceiling past which the document would be the pane that
   * does not fit. The width goes into the custom property the grid already
   * reads, so every rule that knows the pane's width follows, and into
   * storage, which boot.js applies before first paint. Double-click puts the
   * default back; for a keyboard the arrow keys move it and Home and End
   * take it to either limit. */
  const PANES = [
    { el: sideEl, prop: "--side-w", key: "snyvi.side-w", min: 200, max: 440, dflt: 264, sign: 1 },
    { el: rail, prop: "--rail-w", key: "snyvi.rail-w", min: 180, max: 400, dflt: 232, sign: -1 },
  ];
  for (const pane of PANES) {
    const g = pane.el.querySelector(".gutter");
    const width = () => parseFloat(getComputedStyle(root).getPropertyValue(pane.prop)) || pane.dflt;
    const set = w => {
      w = Math.round(Math.max(pane.min, Math.min(pane.max, w)));
      root.style.setProperty(pane.prop, `${w}px`);
      g.setAttribute("aria-valuenow", w);
      return w;
    };
    g.setAttribute("aria-valuenow", width());
    g.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const x0 = e.clientX, w0 = width();
      let w = w0;
      g.setPointerCapture(e.pointerId);
      root.dataset.resizing = "1";
      const move = ev => { w = set(w0 + pane.sign * (ev.clientX - x0)); };
      const up = () => {
        delete root.dataset.resizing;
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        store.set(pane.key, String(w));
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
      e.preventDefault();
    });
    g.addEventListener("dblclick", () => {
      root.style.removeProperty(pane.prop);
      store.del(pane.key);
      g.setAttribute("aria-valuenow", pane.dflt);
    });
    g.addEventListener("keydown", e => {
      const step = e.shiftKey ? 64 : 16;
      const to = e.key === "ArrowRight" ? width() + pane.sign * step
        : e.key === "ArrowLeft" ? width() - pane.sign * step
          : e.key === "Home" ? pane.min : e.key === "End" ? pane.max : null;
      if (to === null) return;
      store.set(pane.key, String(set(to)));
      e.preventDefault();
      e.stopPropagation();
    });
  }

  document.addEventListener("keydown", e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); return; }
    if (e.key === "Escape") {
      const filled = docEl.querySelector(".mmd[data-full]");
      if (filled) mmdUnfill(filled);
      closePalette(); closeDialog(help); closeDialog(aboutDlg); closeDialog(resetDlg); closeSheet(); if (!findBar.hidden) closeFind();
      return;
    }
    // Back and forward, where the browser does not do it itself: the desktop
    // window has no toolbar and no shortcut of its own for either. A browser
    // that has one yields it to the page's preventDefault, so this is one
    // step there too, not two.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") history.back(); else history.forward();
      return;
    }
    // Undo, for as long as the toast offering it is on the screen. The hand
    // goes here before it goes to the button, and a delete is the only thing
    // in a viewer there is anything to undo.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "z" || e.key === "Z") && undoing) {
      e.preventDefault();
      undoing();
      return;
    }
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
      // Delete and not Backspace: a key a reader leans on while thinking is
      // not a key to lose a document to.
      case "Delete": deleteCurrent(); break;
      case "n": openNext(); break;
      case "i": showInbox(true); break;
      case "w": toggleWide(); break;
      case "z": toggleWrap(); break;
      case "t":
        if (railNarrow.matches) { if (!rail.classList.contains("empty")) toggleSheet("rail"); }
        else { const off = root.dataset.rail !== "0"; root.dataset.rail = off ? "0" : "1"; store.set("snyvi.rail", off ? "0" : "1"); }
        break;
      // The diagram under the cursor, or the last one used: fit it, or fill the
      // screen with it. Both are no-ops on a page with no diagram on it.
      case "0": { const fig = mmdKeyed(); if (fig) { mmdFit(fig); mmdTouched = fig; } break; }
      case "f": { const fig = mmdKeyed(); if (fig) { mmdFull(fig); mmdTouched = fig; } break; }
      case "\\":
        if (sideNarrow.matches) toggleSheet("side");
        else { const off = root.dataset.side !== "0"; root.dataset.side = off ? "0" : "1"; store.set("snyvi.side", off ? "0" : "1"); }
        break;
      case "o":
        if (state.doc) window.open(`/api/docs/${state.doc.id}/raw`, "_blank");
        else if (browsing() && state.browsePath) window.open(rawUrl(state.browseRoot.id, state.browsePath), "_blank");
        break;
      case "?": help.hidden ? openDialog(help, help.firstElementChild) : closeDialog(help); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- boot ----------
  if (state.view === "doc" && state.doc) {
    // Opened from a link -- an agent's, or the notification's -- so it is read.
    markRead(state.doc.id);
    document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname + location.hash);
    // A link to a section: the browser's own fragment scroll aimed at a
    // placeholder, the same way a smooth scroll does. Land it properly.
    if (location.hash && !lineHash()) jumpToHash();
  }
  else if (state.view === "browse" && state.browseRoot) { showBrowse(state.browseRoot.id, state.browsePath, false); history.replaceState({ browse: state.browseRoot.id, path: state.browsePath }, "", location.pathname + location.hash); }
  else if (state.view === "connect") { showConnect(false); history.replaceState({ connect: true }, "", "/connect"); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", "/"); }
  connect();
})();
