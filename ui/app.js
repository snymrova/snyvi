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
    opening: null,              // the id of a document asked for and not here yet
    deskBehind: null,           // the desk whose rail stays while a document is read over it
    previous: boot.previous || null,
    versions: [],               // ids of every snapshot of the open document, newest first

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
    online: boot.online || {},  // agent name -> how many of it hold a stream on the daemon now
    notes: boot.notes || [],    // the last few lines agents left, newest first
    desks: null,                // what /api/desks said, for a window; a tab never has any
    deskId: null,               // the desk on screen, or null for the list of them
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
  /** `rel` in the width a 264px sidebar has. The tree fits one fact at the
   *  end of a row, and age is worth more than kind: `md` sat on eighteen
   *  rows of twenty and told a reader nothing that told them apart. */
  const relShort = ts => {
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "now";
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    if (d < 7 * 86400) return `${Math.round(d / 86400)}d`;
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  /* A title's budget is pixels, not characters: "S23 · The Desk — session
   * plan" and "snyvi launch post" are 29 and 17 characters, 192 and 109
   * pixels. A canvas measures text without touching layout. */
  const ctx2d = () => { try { return document.createElement("canvas").getContext("2d"); } catch { return null; } };
  const fitCtx = ctx2d(), timeCtx = ctx2d();
  let fitFont = "", titleRoom = 154, recut = false;
  /* 12px of session indent, 20 + 8 of the row's padding, 6 of gap. */
  const roomIn = w => Math.max(60, w - 60);
  // Titles are measured at 550, the weight an unread row is set in
  // (`.t-doc a.new .title`), so a row does not change length when it is read.
  const wide = t => fitCtx.measureText(t).width;
  /** What is left for the title after the row's indent, padding, gap and the
   *  time at its end -- measured too, because "5m" and "Sep 12" are 24px
   *  apart, which is two words of a title. */
  const roomFor = ts => titleRoom - (timeCtx ? timeCtx.measureText(ts).width : 38);
  /** Cut in the middle, not the end: what tells one agent's document from
   *  the next is usually the end of its title, and four rows reading
   *  "Session panes: the…" tell a reader nothing. The head takes the word
   *  boundary nearest 60% of the budget, the tail as many whole words as the
   *  rest holds. The whole title stays in the row's `title`. */
  const mid = (t, px) => {
    t = String(t);
    if (!fitCtx || wide(t) <= px) return t;
    let head = 0;
    while (head < t.length && wide(t.slice(0, head + 1)) <= px * 0.6) head++;
    const back = t.lastIndexOf(" ", head);
    if (back > 0 && head - back < 8) head = back;
    const out = t.slice(0, head).trimEnd() + "…";
    let from = t.length;
    while (from > head && wide(out + t.slice(from - 1)) <= px) from--;
    const fwd = t.indexOf(" ", from - 1);
    if (fwd > 0 && fwd - from < 8) from = fwd + 1;
    return out + t.slice(from).trimStart();
  };
  // One formatter, made once: `toLocaleString` with options builds a new one
  // per call, and the sidebar calls this for every row it draws.
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fmt = ts => dateFmt.format(new Date(ts * 1000));
  /** After the frame being built now is on screen: the frame callback runs
   *  before the paint, and the task it queues runs after it. */
  const afterPaint = fn => requestAnimationFrame(() => setTimeout(fn, 0));
  const kindTag = k => ({ markdown: "md", code: "code", diff: "diff", text: "txt", image: "img", binary: "bin", table: "csv" }[k] || k);
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
  /** The ids on the queue, for the rows that carry a mark. Rebuilt whenever
   *  the queue is drawn, which is after every change to it. */
  let queueIds = new Set(state.queue.map(d => d.id));

  // ---------- tree ----------
  /* Three of the tree's sets are the reader's rather than the library's --
   * which projects are open, which sections are folded, which projects have
   * been taken out of the list -- and each is a comma-separated line in this
   * reader's own storage. One pair of functions for all three: the dance is
   * easy to write slightly differently the fourth time, and a set that round
   * trips differently from its neighbours loses whatever was in it. */
  const saved = k => new Set((store.get(k) || "").split(",").filter(Boolean));
  const save = (k, set) => store.set(k, [...set].join(","));
  const openProjects = saved("snyvi.open");
  /** Caps a reader has lifted, by project and by workflow, so a refetch does not
   *  put the rest back out of reach while they are still reading it. */
  const liftedCaps = new Set();
  const liftedWorkflows = new Set();
  /** Fills in flight, so a project expanded twice in a second is fetched once,
   *  and fills already attempted, so a fetch that failed is not retried by the
   *  render it would trigger. Expanding the project by hand asks again. */
  const filling = new Set();
  const tried = new Set();

  // ---------- sections ----------
  /* Inbox, Desks and Folders are one kind of thing, so one hand draws their
   * heads: a chevron that folds the section, an icon, the name and a count.
   * What each holds hangs under it on one guide line at one indent. A fold is
   * a class on #trees rather than a redraw, so it survives every render and
   * costs none; it is remembered per reader. */
  const folded = saved("snyvi.fold");
  /* A project the reader has taken out of the sidebar. Nothing is deleted --
   * snyvi deletes nothing on this path -- so the project keeps every document
   * it has, in All documents, in search and at its own URL; what changes is
   * that it stops taking a row here. It comes back the moment anything lands
   * in it, and the row under the tree brings them all back by hand. Per
   * reader, as the folds are: it is a view, not a fact about the library. */
  const away = saved("snyvi.away");
  const saveAway = () => save("snyvi.away", away);
  /** The one just put away, while the offer to undo it is still standing. It
   *  keeps the row's place in the tree so the offer is where the click was --
   *  a toast in the far corner asks the eye to leave the sidebar to find out
   *  what the sidebar just did. Cleared by the timer, by the undo, or by the
   *  next one put away, which is the moment the offer stops being about it. */
  let awayJust = null, awayTimer = 0;
  /** The document just removed, while its row still offers Undo: what it was,
   *  where its row stood (`where` "queue" or "proj", and the place in that
   *  list), and the clock. Captured at the click, because the refetch that
   *  follows no longer has the row to say where it was. One at a time. */
  let gone = null;
  const applyFolds = () => { for (const k of ["inbox", "desks", "folders"]) treesEl.classList.toggle(`fold-${k}`, folded.has(k)); };
  applyFolds();
  function toggleFold(key) {
    if (!folded.delete(key)) folded.add(key);
    save("snyvi.fold", folded);
    applyFolds();
    const open = !folded.has(key);
    for (const b of treesEl.querySelectorAll(`[data-fold="${key}"]`)) b.setAttribute("aria-expanded", open);
  }
  /** Line icons, drawn at 16px on a 24px grid, stroked with the text. */
  const ICONS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    project: '<path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    desk: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
    doc: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M9 13h6M9 16.5h6"/>',
  };
  const icon = (k, px = 16) => `<svg class="r-ico" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
  /** A section's head, as a Mac sidebar has them: a quiet label that folds
   *  what is under it, the same for all three, and nothing else. Whatever
   *  opens a page is a row. The chevron shows on hover, and stays while the
   *  section is folded so a folded one says so. */
  /** A row that folds says so after its name, in the section heads' own
   *  chevron: every row reads icon, name, chevron (app.css, .s-chev). */
  const chev = `<span class="s-chev" aria-hidden="true"></span>`;
  /** Documents and files carry the document glyph, smaller and quieter
   *  than a row that holds things, so the left column is always an icon. */
  const docIco = () => icon("doc", 14);
  function secHead(key, name, tail = "") {
    const open = !folded.has(key);
    return `<div class="s-head" data-sec="${key}"><button type="button" class="s-link" data-fold="${key}" aria-expanded="${open}"><span class="s-nm">${name}</span>${chev}</button>${tail}</div>`;
  }

  /** The browse section keeps its own DOM across navigations so expanded folders stay open.
   *  Its body always ends in a quiet "open a folder" row, so reading a folder is
   *  something the sidebar offers rather than a command a reader has to have heard of. */
  function renderBrowse() {
    const ids = state.browse.map(r => r.id).join(",");
    if (browseEl.dataset.ids === ids) return;
    browseEl.dataset.ids = ids;
    const head = secHead("folders", "Folders");
    browseEl.innerHTML = head + `<div class="b-body s-body">` + state.browse.map(r => {
      const active = state.browseRoot && state.browseRoot.id === r.id;
      return `<details class="b-root" data-root="${r.id}" ${active ? "open" : ""}><summary title="${esc(r.path)}">${icon("folder")}<span class="nm">${esc(r.name)}</span>${chev}${plusDesk()}<button class="b-close" data-close="${r.id}" title="Close folder">✕</button></summary><ul class="b-tree" data-root="${r.id}" data-path=""></ul></details>`;
    }).join("") + `<button type="button" class="b-empty" data-pick>${state.browse.length ? "Open another folder…" : "Read a folder as it is on disk"}</button></div>`;
    for (const ul of browseEl.querySelectorAll(".b-root[open] > .b-tree")) fillTree(ul);
  }

  /** Highlight whatever is on screen, without rebuilding either tree. */
  function markActive() {
    for (const a of treesEl.querySelectorAll("a.active, .t-inbox.active")) { a.classList.remove("active"); a.removeAttribute("aria-current"); }
    const on = state.view === "inbox" ? inboxRowEl.querySelector(".t-inbox")
      : state.view === "desk" && state.deskId != null ? $("#desk-nav").querySelector(`a[data-desk="${state.deskId}"]`)
      // A document read over a desk is still the desk: the desk keeps the
      // mark, and the rail marks the document.
      : state.deskBehind != null ? $("#desk-nav").querySelector(`a[data-desk="${state.deskBehind}"]`)
      : state.view === "browse" && state.browseRoot ? browseEl.querySelector(`.b-file a[data-browse="${state.browseRoot.id}"][data-path="${CSS.escape(state.browsePath)}"]`)
        // The one being opened outranks the one being left: a redraw that lands
        // while a document is on its way must not put the mark back on the row
        // the reader has already moved off.
        : state.opening ? treeEl.querySelector(`a[data-id="${state.opening}"]`)
          : state.doc ? treeEl.querySelector(`a[data-id="${state.doc.id}"]`) : null;
    if (on) { on.classList.add("active"); on.setAttribute("aria-current", "page"); }
  }

  /** Both names are guesses — a directory name and a session's first document — so
   *  each carries the means to correct it, shown when the row is under the cursor. */
  const renameBtn = (what, id) =>
    `<button class="ren" data-rename="${what}" data-id="${id}" title="Rename ${what}" aria-label="Rename ${what}">✎</button>`;

  /** The ✕ on a project's row: the same glyph a folder's row carries, meaning
   *  the same thing -- this list stops showing it. Nothing on disk or in the
   *  library changes; the ghost row it leaves behind holds the Undo, and the
   *  row under the tree is the way back after that. */
  const awayBtn = p =>
    `<button type="button" class="row-x" data-away="${p.id}" title="Remove from the sidebar · the documents stay" aria-label="Remove ${esc(p.name)} from the sidebar">✕</button>`;

  /** A project is drawn expanded when the reader left it that way, when the
   *  document on screen is in it, or when it is the only one there is. Not
   *  for a document read over a desk: it was opened from the desk's own
   *  list, and the sidebar has no reason to move. */
  const projOpen = p => openProjects.has(String(p.id)) || (state.doc && state.deskBehind == null && state.doc.project_id === p.id) || state.tree.length === 1 ||
    // The document on screen was removed and the page went to the inbox: its
    // project stays open while its row offers Undo.
    (gone && gone.where === "proj" && gone.pid === String(p.id));

  const docRow = d => {
    noteKnown(d);
    const ago = relShort(d.received_at);
    // Not "active": markActive puts that on, so the rows a reader moves between
    // draw the same and a move between two of them costs no redraw.
    const cls = waitingRow(d) ? "new" : "";
    return `<li class="t-doc${washCls(d.id)}"${moment(d.id)}><a href="/d/${d.id}" class="${cls}" data-id="${d.id}" title="${esc(d.title)} · ${fmt(d.received_at)}${waitingRow(d) ? " · waiting to be read" : ""}">${docIco()}<span class="title">${esc(mid(d.title, roomFor(ago)))}</span>${d.pinned ? `<span class="pin" title="Pinned">●</span>` : ""}<span class="k">${ago}</span>${removeBtn(d)}</a></li>`;
  };
  /** The ✕ on a document's row takes it out of the inbox. It is said as a
   *  removal because that is what it is: the daemon keeps the document, and
   *  the row stands where it was for GHOST_MS with the Undo in it. */
  function removeBtn(d) {
    return `<button type="button" class="row-x" data-deldoc="${d.id}" title="Remove from inbox · Undo for 4 s" aria-label="Remove ${esc(d.title)} from inbox">✕</button>`;
  }
  /** The row a removed document leaves behind, at its height and in its
   *  place, so nothing below it moves while the offer stands. The bar along
   *  its foot is the time left; resting on it stops the clock. `--t` starts
   *  both where the last draw left them, as `moment` does for a wash. */
  function ghostRow() {
    const g = gone;
    g.drawn = true;
    const t = g.closing ? Date.now() - g.closing : ghostSpent(g);
    return `<li class="t-doc t-gone${g.closing ? " leaving" : ""}${g.back ? " back" : ""}" style="--t:-${t}ms"><div class="t-ghost">${docIco()}<span class="title">${esc(g.d.title)}</span><span class="k">removed</span><button type="button" class="t-undo" data-undoc>Undo</button></div></li>`;
  }

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
  const queueRow = (d, extra = "") => (noteKnown(d), `<li class="t-doc${extra}"${moment(d.id)}><a href="/d/${d.id}" class="new" data-id="${d.id}" title="${esc(d.title)} · ${esc(d.project)} · ${fmt(d.received_at)}">${docIco()}<span class="title">${esc(d.title)}</span><span class="k">${esc(d.project)}</span>${removeBtn(d)}</a></li>`);

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
  let qbWas = 0, qbSettle = 0;   // the bar's count last drawn, and the face's way back to plain
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
    const ghost = gone && gone.where === "queue" && !queueIds.has(gone.id);
    const left = [...leaving.values()].filter(l => !(ghost && l.d.id === gone.id)).sort((a, b) => a.at - b.at);
    for (const l of left) if (!queueIds.has(l.d.id)) rows.splice(Math.min(l.at, rows.length), 0, queueRow(l.d, " leaving"));
    if (ghost) rows.splice(Math.min(gone.at, rows.length), 0, ghostRow());
    // Removed from its project while it was also waiting: its row here stays,
    // quiet, until the ghost down there ends, and then both close together.
    const held = gone && gone.where === "proj" && gone.qDoc && !queueIds.has(gone.id);
    if (held) rows.splice(Math.min(gone.qAt, rows.length), 0, queueRow(gone.qDoc, gone.closing ? " held leaving" : " held"));
    const empty = (!n || !head) && !left.length && !ghost && !held;
    queueEl.innerHTML = empty ? "" : `<div class="t-queue${!n && !ghost && !(held && !gone.closing) ? " leaving" : ""}"><div class="t-label">Waiting<span class="n">${n}</span></div><ul>` +
      rows.join("") +
      (n > shown ? `<li class="t-more"><a href="/" data-nav="inbox">${n - shown} more</a></li>` : "") + `</ul></div>`;
    lastQueue = state.queue.slice(0, QUEUE_ROWS);
    const bar = n > 0 && !!head && state.view !== "inbox";
    queueBar.hidden = !bar;
    if (!bar) { queueBar.innerHTML = ""; qbWas = 0; return; }
    // The bar rises when it appears and stays put after: a count that changes
    // ticks in place. It used to be rebuilt on every render, which re-ran the
    // rise for one more arrival, and twelve arrivals rose twelve times.
    const count = `${n} waiting`, next = `<b>${esc(head.title)}</b> · ${esc(head.project)}`;
    const qb = queueBar.querySelector(".qb");
    // The bar is snyvi holding what came for the reader, so it is snyvi's
    // face at the front of it: the same head that answers a click, at the
    // top of the page. It arrives wide-eyed and settles into a smile.
    if (!qb) {
      queueBar.innerHTML = `<div class="qb"><span class="qb-who"></span><span class="qb-n">${count}</span><span class="qb-next">${next}</span>` +
        `<button type="button" data-q="next">Open<kbd>n</kbd></button><a href="/" class="qb-all" data-nav="inbox">Show all</a>` +
        `<button type="button" class="icon" data-q="clear" title="Mark all read" aria-label="Mark all read">✕</button></div>`;
      qbFeel("whoa");
      qbWas = n;
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
      // One more is a surprise; one fewer is a read, and it is glad of it.
      qbFeel(n > qbWas ? "whoa" : "glad");
    }
    qbWas = n;
  }
  /** The face on the bar: `feel` for the moment, then plain -- the face at
   *  rest holding the count is a smile, not a stare. The moment is a fresh
   *  node, so the same feeling twice running lands twice. */
  function qbFeel(feel) {
    const who = queueBar.querySelector(".qb-who");
    if (!who) return;
    clearTimeout(qbSettle);
    const fresh = who.cloneNode(false);
    fresh.dataset.feel = feel;
    fresh.innerHTML = mascotHead(feel);
    who.replaceWith(fresh);
    qbSettle = setTimeout(() => {
      const w = queueBar.querySelector(".qb-who");
      if (w) { delete w.dataset.feel; w.innerHTML = mascotHead("plain"); }
    }, 2400);
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
    if (!d) { toast("Nothing waiting", "Every document that arrived has been opened.", null, null, { face: "love" }); return; }
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
    toast("Marked read", plural(n, "document"), null, null, { face: "glad" });
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
  /* What a project shows before a reader asks for more: up to five documents
   * a session, and sessions until about eight rows are on screen -- a budget
   * of rows rather than of sessions, since a session of one is one row and
   * three of those would hide the busy session under them. The server sends
   * ten of each, which kept the wire short but drew nine rows under one
   * session and thirty under a project: a list, not a sidebar. The rest sits
   * behind "N more", which shows what the page already holds at once and
   * fetches only past the server's own cap; "less" folds it again. The
   * session the open document is in is always whole, since `[` and `]` step
   * through it. */
  const SHOW_DOCS = 5, SHOW_ROWS = 8;
  const wholeWf = w => liftedWorkflows.has(w.id) || (state.doc && state.doc.workflow_id === w.id);
  function projectRows(p) {
    const pid = String(p.id), wfs = state.sub.get(pid);
    if (!wfs) return `<li class="t-wait">…</li>`;
    const allWfs = liftedCaps.has(pid);
    // A removed document's row stands in its session until the offer goes.
    // Its session may have gone with it, when it was the only document there:
    // then the row stands alone where the session was.
    const g = gone && gone.where === "proj" && gone.pid === pid ? gone : null;
    const lostWf = g && !wfs.some(w => w.id === g.wf);
    const lone = () => `<li class="t-wf solo"><ul>${ghostRow()}</ul></li>`;
    let h = "", shownWfs = 0, rows = 0;
    for (const [wi, w] of wfs.entries()) {
      if (lostWf && wi === g.wfAt) h += lone();
      // Past the budget, only the session being read is drawn.
      if (!allWfs && rows >= SHOW_ROWS && !(state.doc && state.doc.workflow_id === w.id)) continue;
      shownWfs++;
      // A group of one is not a group. `receive.rs` titles a session-keyed
      // workflow with its first document's title, so the header above a lone
      // row is a truncated copy of it -- 4 of 17 sessions in live data. The
      // row stands alone instead, which holds however sessions get named.
      // While a removed row stands in it, a session keeps the shape it had,
      // so its head does not come or go above the row.
      const ghostHere = g && g.wf === w.id && !w.docs.some(d => d.id === g.id);
      const solo = ghostHere ? g.solo : w.total === 1 && w.docs.length === 1;
      const whole = wholeWf(w), docs = whole ? w.docs : w.docs.slice(0, SHOW_DOCS);
      h += `<li class="t-wf${solo ? " solo" : ""}">${solo ? "" : `<div class="wf-name" title="${esc(w.key)}"><span class="nm">${esc(w.title)}</span>${renameBtn("workflow", w.id)}</div>`}<ul>`;
      const drawn = docs.map(docRow);
      if (ghostHere) drawn.splice(Math.min(g.at, drawn.length), 0, ghostRow());
      h += drawn.join("");
      rows += docs.length;
      if (w.total > docs.length) h += `<li class="t-more"><button type="button" data-more-docs="${w.id}">${w.total - docs.length} more</button></li>`;
      else if (liftedWorkflows.has(w.id) && w.total > SHOW_DOCS) h += `<li class="t-more"><button type="button" data-less-docs="${w.id}">less</button></li>`;
      h += `</ul></li>`;
    }
    if (lostWf && g.wfAt >= wfs.length) h += lone();
    if (p.workflows > shownWfs) h += `<li class="t-more"><button type="button" data-more-wf="${p.id}">${p.workflows - shownWfs} more sessions</button></li>`;
    else if (allWfs && wfs.length > 1 && liftedCaps.has(pid)) h += `<li class="t-more"><button type="button" data-less-wf="${p.id}">fewer sessions</button></li>`;
    return h;
  }

  /** The sidebar, which is a list of projects and the rows of the ones that are
   *  open. A closed project contributes nothing to the page: this used to carry
   *  every document in the library on every page open — 13,000 rows and a
   *  718 ms task at 3000 documents — and what is behind a row is now two
   *  numbers until a reader asks for it. */
  let drawnTree = null;
  const treeTouched = new MutationObserver(() => { drawnTree = null; });
  treeTouched.observe(treeEl, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  /** The daemon's projects, and the one whose last document was just removed:
   *  it has left the daemon's tree, but it stands, open, until the ghost in it
   *  ends, so the Undo has a row to be in. */
  function heldTree() {
    const g = gone;
    if (!g || g.where !== "proj" || !g.proj || state.tree.some(p => String(p.id) === g.pid)) return state.tree;
    const t = state.tree.slice();
    t.splice(Math.min(g.projAt, t.length), 0, g.proj);
    return t;
  }
  function renderTree() {
    const projects = heldTree();
    const total = state.tree.reduce((n, p) => n + p.docs, 0);
    // A link, so the keyboard reaches it: a div with a click handler is a row
    // Tab walks straight past.
    inboxRowEl.innerHTML = secHead("inbox", "Inbox") +
      `<a class="t-inbox s-row" href="/" data-nav="inbox">${icon("inbox")}<span class="title">All documents</span><span class="n">${total}</span></a>`;
    renderQueue();
    renderBrowse();
    renderDesks();
    if (!projects.length) {
      treeEl.innerHTML = state.browse.length ? "" : `<div class="t-empty">Nothing here yet. Send something:<br><code>snyvi send README.md</code><br><br>Or read a folder: the row under <b>Folders</b>, below.</div>`;
      return;
    }
    // Measured rather than assumed, because the gutter resizes the sidebar,
    // and once per draw rather than once per row.
    if (fitCtx && treeEl.clientWidth) {
      const cs = getComputedStyle(treeEl);
      const f = `550 ${cs.fontSize} ${cs.fontFamily}`;
      if (f !== fitFont) {
        fitCtx.font = fitFont = f;
        if (timeCtx) timeCtx.font = `10px ${getComputedStyle(document.documentElement).getPropertyValue("--mono")}`;
      }
      titleRoom = roomIn(treeEl.clientWidth);
    }
    // What the page has open, before it is taken apart. `toggle` is queued
    // rather than dispatched where the click happens, so a reader can have a
    // project open in the DOM while `openProjects` has not heard yet -- and a
    // draw that lands in that gap rebuilds the row from the stale answer,
    // closed, and the rows the handler then injects go into a <details> that
    // is no longer in the page. The project stays shut and nothing draws it
    // again. Asking the DOM first costs one query and closes the gap; a
    // project the reader closed is removed by the handler, so this only ever
    // adds what is open on screen right now.
    for (const d of treeEl.querySelectorAll(".t-proj[open]")) {
      if (d.dataset.pid) openProjects.add(d.dataset.pid);
    }
    // No label: the projects hang under Inbox, which is what they are.
    let h = "";
    let put = 0;
    for (const p of projects) {
      if (away.has(String(p.id))) {
        // In its own place, at its own height, so nothing below it moves while
        // the offer stands and nothing moves again when it is taken.
        if (awayJust === String(p.id)) {
          h += `<div class="t-back"><span class="nm">${esc(p.name)} removed</span><button type="button" class="t-undo" data-back="${p.id}">Undo</button></div>`;
          continue;
        }
        put++;
        continue;
      }
      const open = projOpen(p);
      // The one held for a ghost closes with it.
      const out = gone && gone.closing && gone.proj === p && !state.tree.includes(p);
      h += `<details class="t-proj${out ? " leaving" : ""}" data-pid="${p.id}" ${open ? "open" : ""}><summary title="${esc(p.root)}">${icon("project")}<span class="nm">${esc(p.name)}</span>${chev}${awayBtn(p)}</summary><ul>`;
      h += open ? projectRows(p) : "";
      h += `</ul></details>`;
    }
    // Counted from the tree rather than from the set, so a project that is
    // gone for some other reason is not offered back. While this row is here
    // nothing is stranded: whatever was put away is one click from returning.
    if (put) h += `<button type="button" class="t-away" data-back="">${plural(put, "project")} removed · Show</button>`;
    // The same rows as last time are left alone. Every open used to throw the
    // tree away and build it again, and measure it, before the document could
    // paint. Anything else that touches the rows -- a project toggled, a name
    // being edited -- clears `drawnTree`, so what is on screen is always what
    // this string describes when it is skipped.
    if (h !== drawnTree) {
      treeEl.innerHTML = h;
      drawnTree = h;
      treeTouched.takeRecords();
    }
    // The scrollbar exists only once the rows do, and takes width from the
    // column the titles were just cut to -- so a tree that overflows was cut
    // against a width that stopped being true as it was drawn. Once more.
    if (fitCtx && treeEl.clientWidth && !recut && roomIn(treeEl.clientWidth) !== titleRoom) {
      recut = true;
      try { renderTree(); } finally { recut = false; }
      return;
    }
    // A project the reader has open that this tab has never filled: the "…" is
    // on screen, so fetching it now is what turns it into rows.
    for (const p of projects) if (projOpen(p) && !state.sub.has(String(p.id))) fillProject(p.id);
  }

  /* The first draw can land before Inter has, and a fallback font measures
   * narrower -- titles are then cut to a width the real font overflows, and
   * the row ends in two ellipses. Measure again once it is here. */
  try {
    document.fonts.ready.then(() => { fitFont = ""; renderTree(); markActive(); });
  } catch {}

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
    ? `<li class="b-dir"><details data-root="${rootId}" data-path="${esc(e.path)}"><summary>${icon("folder", 14)}<span class="nm">${esc(e.name)}</span>${chev}${plusDesk()}</summary><ul class="b-tree" data-root="${rootId}" data-path="${esc(e.path)}"></ul></details></li>`
    : `<li class="b-file"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}" title="${esc(e.path)}">${docIco()}<span class="title">${esc(e.name)}</span><span class="k">${fmtSize(e.size)}</span></a></li>`;

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
    save("snyvi.open", openProjects);
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
    const more = e.target.closest("[data-more-docs], [data-more-wf], [data-less-docs], [data-less-wf]");
    if (more) {
      e.preventDefault(); e.stopPropagation();
      more.disabled = true;
      const { moreWf, moreDocs, lessWf, lessDocs } = more.dataset;
      if (lessWf != null) { liftedCaps.delete(String(lessWf)); }
      else if (lessDocs != null) { liftedWorkflows.delete(Number(lessDocs)); }
      else if (moreWf != null) {
        const pid = String(moreWf), p = state.tree.find(x => String(x.id) === pid), wfs = state.sub.get(pid) || [];
        liftedCaps.add(pid);
        // What the page holds is shown at once; only past the server's cap
        // is there anything to fetch.
        if (p && p.workflows > wfs.length) { await fillProject(pid, true); return; }
      } else {
        const wid = Number(moreDocs);
        const pid = [...state.sub.keys()].find(k => state.sub.get(k).some(w => w.id === wid));
        const w = (state.sub.get(pid) || []).find(x => x.id === wid);
        liftedWorkflows.add(wid);
        if (w && w.docs.length < w.total) await fillWorkflow(wid, pid);
      }
      renderTree(); markActive();
      return;
    }
    const fold = e.target.closest("[data-fold]");
    if (fold) { e.preventDefault(); toggleFold(fold.dataset.fold); return; }
    if (e.target.closest("[data-pick]")) { e.preventDefault(); e.stopPropagation(); act("pick"); return; }
    const nd = e.target.closest("[data-newdesk]");
    if (nd) {
      // Inside a <summary> too: a click on the + is not a click on the folder.
      e.preventDefault(); e.stopPropagation();
      // In a folder's row, a desk on that folder; in the Desks head, one on no folder.
      act("make", folderOf(nd));
      return;
    }
    const dx = e.target.closest("[data-deldoc]");
    if (dx) {
      // Inside the document's link: a click on the ✕ is not a click on the row.
      e.preventDefault(); e.stopPropagation();
      const id = dx.dataset.deldoc, proj = dx.closest(".t-proj");
      const d = state.queue.find(x => x.id === id) || { id, title: dx.closest("a").title.split(" · ")[0], project_id: proj ? +proj.dataset.pid : null };
      deleteDoc(d, dx);
      return;
    }
    if (e.target.closest("[data-undoc]")) {
      e.preventDefault(); e.stopPropagation();
      // Not in the first moments: the Undo is drawn where the ✕ was, and the
      // second click of a quick double-click is not a change of mind.
      if (gone && Date.now() - gone.made > 350) undoGone(gone);
      return;
    }
    const dd = e.target.closest("[data-dropdesk]");
    if (dd) {
      // Inside the desk's link: a click on the ✕ is not a click on the desk.
      e.preventDefault(); e.stopPropagation();
      act("drop", dd);
      return;
    }
    const ax = e.target.closest("[data-away]");
    if (ax) {
      // Inside a <summary>, the default action is toggling the project open.
      e.preventDefault(); e.stopPropagation();
      putAway(ax.dataset.away);
      return;
    }
    const bk = e.target.closest("[data-back]");
    if (bk) {
      e.preventDefault(); e.stopPropagation();
      bringBack(bk.dataset.back);
      return;
    }
    const r = e.target.closest("[data-rename]");
    if (r) {
      // Inside a <summary>, the default action is toggling the project open.
      e.preventDefault(); e.stopPropagation();
      startRename(r.parentElement, r.dataset.rename, +r.dataset.id);
      return;
    }
    const b = e.target.closest("[data-close]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    closeRoot(b.dataset.close);
  });

  /** A folder off the Folders list: the ✕ on its row, and its menu's Close
   *  folder. Nothing on disk is touched. */
  async function closeRoot(id) {
    try { await fetch(`/api/browse/${id}/close`, { method: "POST" }); } catch {}
    state.browse = state.browse.filter(r => r.id !== id);
    if (state.browseRoot && state.browseRoot.id === id) showInbox(true); else { renderTree(); markActive(); }
  }

  /** Turn a name in the tree into a field, in place (menu.js, `rename`). */
  const startRename = (holder, what, id) => act("rename", holder, what, id);
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
  /** What `[` and `]` step through: the versions of the document on screen,
   *  newest first -- the same list the rail's Versions box shows, held whole
   *  whatever the sidebar's caps are.
   *
   *  The sidebar holds one row per document now, so a workflow's rows are
   *  other documents rather than other snapshots of this one; the keys that
   *  say "the one before this" have to ask the file, not the workflow. A
   *  document with no file behind it has no versions, and falls back to the
   *  workflow it arrived in, which is what these keys have always walked. */
  const siblings = () => {
    if (!state.doc) return [];
    const v = state.versions || [];
    if (v.length > 1 && v.includes(state.doc.id)) return v;
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
  /*  Played through the page's own animation API rather than by taking a
   *  class off and putting it back, which needs `offsetWidth` read in between:
   *  that read laid the whole new document out before the click could paint --
   *  220 ms of a 300 ms open on a long plan. */
  let swapAnim = null;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  function swapIn() {
    if (swapAnim) swapAnim.cancel();
    swapAnim = still.matches ? null : docEl.animate(
      [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
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

  /** What the sidebar already knows about a document, kept by id so a click can
   *  draw its head before the document itself is here. Every row that names a
   *  document records it, which is every path an open comes from except a link
   *  typed in cold -- and that one has nothing to draw from anyway. */
  const knownDocs = new Map();
  function noteKnown(d) {
    if (d && d.id && !knownDocs.has(d.id)) knownDocs.set(d.id, { title: d.title, kind: d.kind, received_at: d.received_at });
    return d;
  }

  /** The click's answer, on screen in the same frame as the click.
   *
   *  An open used to put nothing at all on the page until the whole document
   *  had been fetched and parsed -- 1.5 MB of HTML for a 6,000-line file --
   *  so the gesture a reader makes most had no answer for as long as that
   *  took, and a long file read as a frozen window. The head is real: the
   *  title comes from the row that was clicked, and the document's own head
   *  replaces it with the same words. Under it are bars where the text will
   *  be, and they are invisible for the first fifth of a second (`--sk-wait`
   *  in app.css): an open that lands at once never shows a skeleton at all,
   *  and one that does not says so before a reader can wonder. */
  function pending(id, fromHistory) {
    const k = knownDocs.get(id);
    docEl.innerHTML =
      `<header class="doc-head">${k ? `<h1 class="doc-title">${esc(k.title)}</h1>` : `<h1 class="doc-title sk"><span class="sk-bar" style="width:52%"></span></h1>`}` +
      `<p class="doc-sub sk"><span class="sk-bar" style="width:${k ? "34%" : "44%"}"></span></p></header>` +
      `<article class="prose sk-body" aria-busy="true">` +
      SK_WIDTHS.map(w => w ? `<span class="sk-bar" style="width:${w}%"></span>` : `<span class="sk-gap"></span>`).join("") +
      `</article>`;
    if (k) document.title = k.title;
    // The row answers too, rather than waiting for the document to arrive and
    // `afterRender` to mark it: this is four attribute writes and no redraw.
    markPending(id);
    if (!fromHistory) main.scrollTo({ top: 0, behavior: "instant" });
  }
  /* Lines of a paragraph, ragged, so the shape says "text is coming" rather
   * than "a table is coming". The last is short, as a paragraph's last line is. */
  const SK_WIDTHS = [96, 91, 97, 88, 94, 42, 0, 93, 96, 89, 95, 37];
  /** The clicked row, marked before anything is fetched. `markActive` reads
   *  `state.doc`, which is still the document being left, so this one takes an
   *  id and does the same four writes. */
  function markPending(id) {
    if (state.deskBehind != null) { markActive(); return; }   // the desk keeps its mark
    for (const a of treesEl.querySelectorAll("a.active, .t-inbox.active")) { a.classList.remove("active"); a.removeAttribute("aria-current"); }
    const on = treeEl.querySelector(`a[data-id="${id}"]`);
    if (on) { on.classList.add("active"); on.setAttribute("aria-current", "page"); }
  }

  /** Which open the page is showing. A reader who clicks a second row while the
   *  first is still coming gets the second: the first's answer, whenever it
   *  arrives, is dropped rather than painted over what they asked for next. */
  let opening = 0;

  /** `over`: keep the desk behind the document. True from the desk's own
   *  list; false from the sidebar, the queue or a search, which leave the
   *  desk for the library as they always did; left out, a redraw of the
   *  document already up -- a pin, a preview, the way out of a comparison
   *  -- stays wherever it is. A redraw never pushes history and a click
   *  always does, so that is what tells them apart: the same document
   *  clicked in the sidebar is a move to the library, not a redraw. */
  async function showDoc(id, push = true, fromHistory = false, over) {
    if (over === undefined) over = !push && state.deskBehind != null && !!state.doc && state.doc.id === id;
    const back = push ? cameFrom() : null;
    const turn = ++opening;
    let j = state.cache.get(id), waited = false;
    if (!j) {
      // Only an open that has to wait draws a shell; a document already in hand
      // goes straight up, whole, with no flicker of a skeleton in between.
      waited = true;
      if (push) leave();
      behindDesk(id, over);
      state.view = "doc"; state.opening = id; state.comparing = null;
      pending(id, fromHistory);
      if (push) { history.pushState({ id, over: state.deskBehind, back }, "", `/d/${id}`); push = false; }
      overBar();
      try { j = await fetchDoc(id); } catch (e) { if (turn === opening) { state.opening = null; toast("Could not open document", String(e)); } return; }
      if (turn !== opening) return;
      state.opening = null;
    }
    if (push) leave();
    behindDesk(id, over);
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous; state.comparing = null; state.folder = j.folder;
    // Off the queue once the document is on screen: taking it off redraws the
    // sidebar, and the reader is waiting for the page, not the row.
    afterPaint(() => markRead(id));
    setPreview(j.preview, j.preview_url, `d:${id}`);
    docEl.innerHTML = j.html;
    // The document rising into place is the answer to a click; when a shell
    // answered that click already, the text simply fills the bars in and a
    // second fade would be the page saying the same thing twice.
    if (!waited) swapIn();
    applyPreview();
    if (j.doc.kind === "diff" && state.split) { await applySplit(); }
    document.title = j.doc.title;
    overBar();
    if (push) history.pushState({ id, over: state.deskBehind, back }, "", `/d/${id}`);
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
  // The head's foot is ruled only while there is text under it (app.css, #chrome).
  main.addEventListener("scroll", () => main.classList.toggle("scrolled", main.scrollTop > 0), { passive: true });

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
    } catch (e) { toast("Could not open file", String(e)); return; }
    const back = push ? cameFrom() : null;
    if (push) leave();
    offDesk();
    state.view = "browse"; state.doc = null; state.previous = null; state.comparing = null;
    state.browseRoot = j.root; state.browsePath = path;
    setPreview(j.file.preview, j.file.preview_url, `b:${rootId}:${path}`);
    docEl.innerHTML = browseHtml(j.file, j.root);
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

  async function showInbox(push = true) {
    if (push) leave();
    offDesk();
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
      await connectReady();
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
    const row = d => (noteKnown(d), `<li><a href="/d/${d.id}" class="${waitingRow(d) ? "new" : ""}" data-id="${d.id}"><span class="title">${esc(d.title)}</span><span class="time">${rel(d.received_at)}</span><span class="sub"><b>${esc(d.project)}</b> · ${esc(d.workflow_title)} · ${kindTag(d.kind)}</span></a></li>`);
    if (!items.length) return connectHtml ? connectHtml(agents) : "";
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
  /* The page itself is drawn by ui/about.js, with the app's other pages of
   * its own: an empty library, or `?`, is when it is first fetched. */
  let connectHtml = null, panelLoading = null;
  const panelMod = () => (panelLoading ||= import(`/assets/about.js${boot.v ? `?v=${boot.v}` : ""}`));
  async function connectReady() {
    if (connectHtml) return;
    try { const m = await panelMod(); connectHtml = a => (agentsSeen = JSON.stringify(a ? a.rows : []), m.connect(a, { esc, rel })); }
    catch (e) { panelLoading = null; toast("Could not open that page", String(e)); }
  }
  async function showConnect(push = true) {
    if (push) leave();
    offDesk();
    state.view = "connect"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "Connect an agent · snyvi";
    if (push) history.pushState({ connect: true }, "", "/connect");
    let a = boot.agents; boot.agents = null;
    if (!a) { try { a = await (await fetch("/api/agents")).json(); } catch { a = null; } }
    await connectReady();
    docEl.innerHTML = connectHtml(a);
    if (push) swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
    watchAgents();
  }
  /** Ask again while the page is on screen; redraw only when something changed. */
  function watchAgents() {
    clearInterval(agentsTimer);
    agentsTimer = setInterval(refreshAgents, 2500);
  }
  async function refreshAgents() {
    if (!docEl.querySelector(".connect") || document.hidden) return;
    let a; try { a = await (await fetch("/api/agents")).json(); } catch { return; }
    if (JSON.stringify(a.rows) === agentsSeen) return;
    const open = [...docEl.querySelectorAll(".agent details[open]")].map(d => d.closest(".agent").dataset.agent);
    docEl.innerHTML = connectHtml(a);
    for (const id of open) docEl.querySelector(`.agent[data-agent="${CSS.escape(id)}"] details`)?.setAttribute("open", "");
  }

  /** The count beside the brand mark: how many agents hold a stream on the
   *  daemon now, by the name each gave. Zero is drawn too, dim -- "no agent
   *  is connected" is the answer a reader asks it for most. */
  const liveEl = $("#live");
  function renderLive() {
    const names = Object.entries(state.online).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const n = names.reduce((t, [, k]) => t + k, 0);
    liveEl.textContent = String(n);
    liveEl.classList.toggle("on", n > 0);
    liveEl.title = n ? `${plural(n, "agent")} connected: ${names.map(([k, c]) => c > 1 ? `${k} ×${c}` : k).join(", ")}` : "No agent is connected";
  }
  function setOnline(map) {
    state.online = map && typeof map === "object" ? map : {};
    renderLive();
    refreshAgents();
  }
  renderLive();

  async function showCompare(aId, bId) {
    const cur = state.doc;
    const a = aId || state.previous, b = bId || (cur && cur.id);
    if (!cur || !a) { toast("No previous version", "Nothing has been sent for this one before."); return; }
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
  /** How long a removed document's row stands with its Undo: long enough to
   *  see what went and take it back, short enough that the list is settled
   *  again before the eye has moved on. */
  const GHOST_MS = 4000;
  let undoing = null;

  /** Remove now, ask nothing, and offer the way back.
   *
   *  The question used to be a `window.confirm`, which the native window draws
   *  as the toolkit's own dialog in the toolkit's theme, over a page it has
   *  nothing to do with -- and which had to be answered before anything else
   *  could happen. The daemon keeps the document until `prune` runs, so the
   *  seconds below are a real offer and not a hopeful one. */
  async function deleteCurrent() {
    if (state.doc) deleteDoc(state.doc);
  }

  /** Where a document's row stands, as a place that outlives the row: the
   *  row that was clicked, or -- for the meta pane and Del, which have none --
   *  the tree's row before the queue's. Null when neither is drawn. */
  function rowOf(id, from) {
    const sel = `a[data-id="${id}"]`;
    const inQueue = from ? !!from.closest("#queue") : !treeEl.querySelector(sel) && !!queueEl.querySelector(sel);
    if (inQueue) {
      const at = lastQueue.findIndex(x => x.id === id);
      return at < 0 ? null : { where: "queue", at };
    }
    if (!from && !treeEl.querySelector(sel)) return null;
    for (const [pid, wfs] of state.sub) for (const [wfAt, w] of wfs.entries()) {
      const at = w.docs.findIndex(x => x.id === id);
      if (at >= 0) return { where: "proj", pid, wf: w.id, wfAt, at, solo: w.total === 1 && w.docs.length === 1, doc: w.docs[at] };
    }
    return null;
  }

  /** The clock on a removed row is the bar's own animation: it drains in CSS,
   *  stops there while a pointer or a focus rests on the row -- a reader
   *  deciding is not a reader who has gone -- and its end ends the offer. So
   *  the bar and the offer cannot disagree. A redraw asks the bar how far it
   *  got and starts the new one there. Where nothing animates (reduced
   *  motion, or no row to stand in) a plain timer does it. */
  const stillMotion = matchMedia("(prefers-reduced-motion: reduce)");
  function ghostSpent(g, el = document.querySelector("#trees .t-ghost")) {
    const a = el && el.getAnimations ? el.getAnimations({ subtree: true }).find(x => x.animationName === "drain") : null;
    const at = a && a.effect ? a.effect.getComputedTiming().progress : null;
    if (a) g.spent = at == null ? GHOST_MS : Math.round(at * GHOST_MS);
    return g.spent;
  }
  treesEl.addEventListener("animationend", e => {
    if (e.animationName === "drain" && gone && e.target.closest(".t-ghost")) ghostSettle(gone);
  });
  /** The offer is over: the row closes where it stood, as a read one does. */
  function ghostSettle(g) {
    if (gone !== g || g.closing) return;
    clearTimeout(g.timer);
    if (undoing === g.undo) undoing = null;
    g.closing = Date.now();
    renderTree(); markActive();
    setTimeout(() => { if (gone === g) { gone = null; renderTree(); markActive(); } }, LEAVE_MS + 20);
  }
  async function refetchQueue() {
    try {
      const q = await (await fetch(`/api/queue?limit=${QUEUE_HELD}`)).json();
      if (Array.isArray(q)) { state.queue = q; state.waiting = Math.max(state.waiting, q.length); }
    } catch {}
  }

  /** The same, for any document: the one on screen, or a row's ✕ in the
   *  sidebar, which leaves the reader where they are unless that was it.
   *  The row turns into its ghost under the click, from what the page
   *  already holds, and the daemon is told after. */
  async function deleteDoc(d, from = null) {
    const here = !!state.doc && state.doc.id === d.id;
    const place = rowOf(d.id, from);
    if (place && place.doc) d = { ...place.doc, ...d, title: place.doc.title };
    // Only the newest offer stands: two rows both saying Undo cannot both mean
    // the last thing that happened.
    if (gone) { clearTimeout(gone.timer); if (undoing === gone.undo) undoing = null; gone = null; }
    const g = { ...(place || { where: null }), id: d.id, d, here, waiting: waitingRow(d), spent: 0, timer: 0, drawn: false, made: Date.now() };
    g.undo = () => undoGone(g);
    // What stands around the ghost stands with it until the offer ends, so
    // nothing above it moves the row out from under the pointer either: the
    // project, which leaves the daemon's tree with its last document, and the
    // same document's row in Waiting.
    if (g.where === "proj") {
      g.projAt = state.tree.findIndex(p => String(p.id) === g.pid);
      g.proj = g.projAt >= 0 ? state.tree[g.projAt] : null;
      g.qAt = lastQueue.findIndex(x => x.id === d.id);
      g.qDoc = g.qAt >= 0 ? lastQueue[g.qAt] : null;
    } else if (g.where !== "queue") depart([d.id]);
    state.queue = state.queue.filter(x => x.id !== d.id);
    state.waiting = Math.max(0, state.waiting - (g.waiting ? 1 : 0));
    for (const wfs of state.sub.values()) for (const w of wfs) {
      const n = w.docs.length;
      w.docs = w.docs.filter(x => x.id !== d.id);
      if (w.docs.length < n) w.total = Math.max(0, w.total - 1);
    }
    gone = g;
    undoing = g.undo;
    renderTree(); markActive();
    if (!g.drawn || stillMotion.matches) g.timer = setTimeout(() => ghostSettle(g), GHOST_MS);
    try {
      const r = await fetch(`/api/docs/${d.id}/delete`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      state.cache.delete(d.id);
      g.drawn = false;
      await refreshTree(d.project_id);
      if (here) showInbox(true);
      // No row to stand in -- the meta pane's button or Del, with the row not
      // drawn: the offer goes where the toast goes.
      if (gone === g && !g.drawn) {
        toast("Removed", d.title, null, { label: "Undo", run: g.undo }, { life: GHOST_MS });
        clearTimeout(g.timer);
        g.timer = setTimeout(() => ghostSettle(g), GHOST_MS);
      }
    } catch (e) {
      if (gone === g) { clearTimeout(g.timer); gone = null; if (undoing === g.undo) undoing = null; }
      if (g.waiting) await refetchQueue();
      await refreshTree(d.project_id);
      toast("Could not remove", String(e));
    }
  }

  /** Take the removal back. The ghost holds the place until the row is back
   *  in it -- the renderers stop drawing it as soon as the document is in
   *  their list again -- so the list never closes up and opens again. */
  async function undoGone(g) {
    if (gone !== g || g.closing || g.back) return;
    clearTimeout(g.timer);
    g.back = true;
    if (undoing === g.undo) undoing = null;
    renderTree(); markActive();
    try {
      const r = await fetch(`/api/docs/${g.id}/undelete`, { method: "POST" });
      if (r.status === 410) { g.back = false; ghostSettle(g); return toast("Too late to undo", "it has been pruned"); }
      if (!r.ok) throw new Error(`${r.status}`);
      wash([g.id]);
      if (g.waiting) await refetchQueue();
      await refreshTree(g.d.project_id);
      // The "restored" event puts the row back in every other tab.
      if (g.here) showDoc(g.id);
    } catch (e) { toast("Could not undo", String(e)); }
    if (gone === g) gone = null;
    renderTree(); markActive();
  }

  /** Take a project out of the sidebar. Nothing is asked for and nothing is
   *  sent: the library is not touched, so there is nothing to fail and nothing
   *  to undo on the daemon's side. Whatever is on the page stays on it -- a
   *  document whose project was just put away is still a document. */
  function putAway(id) {
    const key = String(id);
    away.add(key); saveAway();
    openProjects.delete(key);
    // Only the newest offer stands: two rows both saying Undo cannot both mean
    // the last thing that happened.
    clearTimeout(awayTimer);
    awayJust = key;
    awayTimer = setTimeout(() => {
      if (awayJust !== key) return;
      awayJust = null;
      renderTree(); markActive();
    }, UNDO_MS);
    renderTree(); markActive();
  }

  /** Put a project back in the sidebar: one by id, or every one of them when
   *  the row under the tree is the one clicked. */
  function bringBack(id) {
    clearTimeout(awayTimer);
    awayJust = null;
    if (id) away.delete(String(id)); else away.clear();
    saveAway();
    renderTree(); markActive();
  }

  /** What hangs off a new page. The rail and the reader's place are put right
   *  now; the sidebar, the code blocks' controls and the versions wait for the
   *  first paint, so a click shows the document before anything else is done
   *  about it. A page left before its turn came skips the rest. */
  let rendered = 0;
  function afterRender() {
    const turn = ++rendered;
    overBar();
    markActive();
    buildToc();
    renderMeta(false);
    prepareMermaid();
    enhanceCode();
    find?.clear();
    applyLineHash(true);
    // Only what is beside the document waits: the sidebar and the versions.
    // Anything that touches the document itself -- the diagrams' places, the
    // code blocks' buttons -- is done above, before a landing measures it.
    afterPaint(() => {
      if (turn !== rendered) return;
      renderTree();
      markActive();
      if (state.deskBehind == null) ensureWorkflow(state.doc);
      renderHistory();
    });
  }

  /** The body was swapped under the reader: rebuild what hangs off it, keep the sidebar. */
  function afterRefresh() {
    buildToc();
    renderMeta(false);
    enhanceCode();
    prepareMermaid();
    renderHistory();
    find?.refresh();
    applyLineHash(false);   // the scroll position is restored by the caller
  }

  // ---------- the note: a line an agent leaves beside the work ----------
  /** It sits above the theme bar and is nothing at all until an agent says
   *  something. A new note glows until a reader rests on it; after that it is
   *  one quiet line. The ones before it wait in a trail a hover away. Seen is
   *  the daemon's, so a glance in one window puts the glow out in all. */
  const noteEl = $("#note");
  let noteLook = 0, notePeek = 0, noteShown = (state.notes.find(n => !n.dismissed) || {}).id || 0;
  /** The asides on the card: the daemon keeps a closed one, flagged, for Undo. */
  const liveNotes = () => state.notes.filter(n => !n.dismissed);
  /** An aside a reader just closed: the card stands where it was as one line
   *  holding the Undo, on the same drain as a removed document's row, and
   *  only when that ends does the next aside take the card. */
  let noteGone = null;
  /** There is one snyvi on screen, the logo, and the note is its voice: a
   *  waiting note perks it up, a new one makes it hop, and a reader resting on
   *  the note gets a smile and a heart. The card itself carries no face. */
  const markEl = $(".brand-mark");
  /** Behind the note, when a reader comes over: snyvi large and tilted,
   *  peeking up from the corner with a feeling. Each note keeps its own --
   *  glad, a wink, heart eyes -- chosen by its id, so a redraw never
   *  changes its mind. */
  const HEART = (x, y) => `<path class="nb-love" transform="translate(${x} ${y}) scale(.8)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/>`;
  const FEELINGS = [
    `<path class="nb-line" d="M8.6 17.8q2.4-3 4.8 0M18.6 17.8q2.4-3 4.8 0"/><path class="nb-ink" d="M12.6 21.6q3.4 4.6 6.8 0z"/>`,
    `<ellipse class="nb-ink" cx="11" cy="16.5" rx="2.6" ry="3.3"/><circle class="nb-shine" cx="11.9" cy="15.2" r="1"/><path class="nb-line" d="M18.6 17.6q2.4-2.8 4.8 0M13.5 22.6q3 2.8 6 0"/>`,
    HEART(11, 16.5) + HEART(21, 16.5) + `<path class="nb-line" d="M13.5 22.6q2.5 2.4 5 0"/>`,
  ];
  const noteBg = id => `<svg class="note-bg" viewBox="0 0 32 32" aria-hidden="true">` +
    `<rect class="nb-nub" x="14" y="0.5" width="4" height="5" rx="2"/><rect class="nb-body" x="1" y="4" width="30" height="27" rx="9"/>` +
    `<ellipse class="nb-cheek" cx="7.4" cy="21.8" rx="2.4" ry="1.5"/><ellipse class="nb-cheek" cx="24.6" cy="21.8" rx="2.4" ry="1.5"/>` +
    FEELINGS[id % FEELINGS.length] + `</svg>`;
  /** The byline says whose work it came through: "via claude-code on api". */
  function noteBy(n) {
    return [n.sender && `via ${esc(n.sender)}`, n.project && `on ${esc(n.project)}`].filter(Boolean).join(" ");
  }
  function renderNote() {
    const [n, ...trail] = noteGone ? [] : liveNotes();
    // Removed rather than emptied: `html[data-note]` matches an empty value
    // too, so writing "" left the mark blinking on every page from boot, note
    // or no note -- a perpetual animation for a state the page was not in.
    // It blinks while a note waits and stops when the reader rests on it.
    if (n && !n.seen) root.dataset.note = n.lit ? "lit" : "new";
    else delete root.dataset.note;
    if (noteGone) {
      // The daemon's word on the close arrives while the ghost stands; the
      // ghost it would redraw is this one, and redrawing it drops the
      // keyboard off its Undo.
      if (noteEl.querySelector(".note-ghost")?.dataset.ids === noteGone.ids.join(",")) return;
      const g = noteGone, t = ghostSpent(g, noteEl.querySelector(".t-ghost"));
      noteEl.hidden = false; noteEl.dataset.lit = ""; noteEl.dataset.seen = "";
      noteEl.innerHTML = `<div class="t-ghost note-ghost" data-ids="${g.ids.join(",")}" style="--t:-${t}ms"><span class="title">${g.ids.length > 1 ? "Asides closed" : "Aside closed"}</span><button type="button" class="t-undo" data-note-undo>Undo</button></div>`;
      return;
    }
    if (!n) { noteEl.hidden = true; noteEl.innerHTML = ""; return; }
    noteEl.hidden = false;
    noteEl.dataset.lit = n.lit && !n.seen ? "1" : "";
    noteEl.dataset.seen = n.seen ? "1" : "";
    // A note newer than the one on screen makes snyvi hop; a reload or a redraw does not.
    const arrived = n.id !== noteShown && !n.seen;
    if (arrived && markEl) {
      markEl.classList.remove("hop"); void markEl.offsetWidth; markEl.classList.add("hop");
      // Whatever snyvi was saying to a reader on the face, the line that just
      // arrived outranks it: the agent takes the floor, and the hop is the
      // mark's answer rather than the nod. Asked only of a bubble that is
      // open, which is also the only time `closeSay` is in scope: the first
      // render runs before the block below it is reached.
      if ("say" in root.dataset) closeSay();
    }
    noteShown = n.id;
    const by = noteBy(n);
    noteEl.innerHTML =
      (trail.length ? `<ol class="note-trail">${trail.map(t => `<li${t.about ? ` data-about="${esc(t.about)}"` : ""}><p>${esc(t.text)}</p><span class="note-by"><b class="note-snyvi">snyvi</b> · ${relShort(t.at)}${by === noteBy(t) ? "" : " · " + noteBy(t)}</span></li>`).join("")}` +
        `<li class="note-all"><button type="button" data-note-all title="Close every aside · Undo for 4 s">Close all</button></li></ol>` : "") +
      `<div class="note-now" tabindex="0" role="note"${n.about ? ` data-about="${esc(n.about)}" title="Open what this is about"` : ""}>` +
      noteBg(n.id) + `<button type="button" class="note-x" data-note-x title="Close · Undo for 4 s  Esc" aria-label="Close this aside">✕</button><p>${esc(n.text)}</p><span class="note-by note-by-now"><span class="note-who" title="${by}"><b class="note-snyvi">snyvi</b> · ${relShort(n.at)}${by ? " · " + by : ""}</span>${trail.length ? `<span class="note-more">+${trail.length}</span>` : ""}</span></div>`;
    // A new note brings snyvi up from behind it for a moment, as a hover does.
    // A window in the background would play that to nobody, so it waits.
    if (arrived) { if (document.hidden) peekOwed = true; else peekNote(); }
  }
  let peekOwed = false;
  function peekNote() {
    peekOwed = false;
    clearTimeout(notePeek);
    void noteEl.offsetWidth;   // the new card's resting state first, so the rise transitions
    noteEl.classList.add("peek");
    notePeek = setTimeout(() => noteEl.classList.remove("peek"), 4200);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && peekOwed) peekNote(); });
  function seeNotes() {
    if (!liveNotes().some(n => !n.seen)) return;
    state.notes = state.notes.map(n => ({ ...n, seen: true }));
    // Only the card's marks change, not what is in it: a rebuild here, on
    // the focus a press on its ✕ brings, swapped the button out between the
    // press and the release, and the click never happened.
    if (!noteGone) { noteEl.dataset.lit = ""; noteEl.dataset.seen = "1"; delete root.dataset.note; }
    fetch("/api/notes/seen", { method: "POST" }).catch(() => {});
  }
  // Resting on it is reading it; passing over on the way to the theme button is not.
  // The logo looks down at whoever comes over to the note.
  const noteNear = on => { if (on) root.dataset.noteNear = "1"; else delete root.dataset.noteNear; };
  noteEl.addEventListener("mouseenter", () => { noteNear(true); clearTimeout(noteLook); noteLook = setTimeout(seeNotes, 700); });
  noteEl.addEventListener("mouseleave", () => { noteNear(false); clearTimeout(noteLook); });
  noteEl.addEventListener("focusin", () => { noteNear(true); seeNotes(); });
  noteEl.addEventListener("focusout", () => noteNear(false));
  markEl?.addEventListener("animationend", e => { if (e.animationName === "bm-hop") markEl.classList.remove("hop"); });
  noteEl.addEventListener("click", e => {
    if (e.target.closest("[data-note-undo]")) { if (noteGone) noteGone.undo(); return; }
    // `detail` is 0 for a click a key made, and only a keyboard is handed on to Undo.
    if (e.target.closest("[data-note-x]")) { closeNotes(liveNotes().slice(0, 1).map(n => n.id), !e.detail); return; }
    if (e.target.closest("[data-note-all]")) { closeNotes(liveNotes().map(n => n.id), !e.detail); return; }
    seeNotes();
    const a = e.target.closest("[data-about]");
    if (a) showDoc(a.dataset.about, true);
  });
  noteEl.addEventListener("keydown", e => {
    // Esc closes the aside the hand is on, and goes no further: not back a
    // page, which is what it does with nothing over the page.
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (e.target.closest(".note-now")) closeNotes(liveNotes().slice(0, 1).map(n => n.id), true);
      return;
    }
    if (e.target.closest("button")) return;
    const a = e.target.closest(".note-now[data-about]");
    if (a && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showDoc(a.dataset.about, true); }
  });
  noteEl.addEventListener("animationend", e => {
    if (e.animationName === "drain" && noteGone) noteSettle(noteGone);
  });
  /** Close asides: off the card at once, in every page once the daemon has
   *  it, and the card holds the way back for GHOST_MS. Nothing is deleted. */
  function closeNotes(ids, byKey = false) {
    if (!ids.length) return;
    if (noteGone) noteSettle(noteGone);
    const g = { ids, spent: 0, timer: 0 };
    g.undo = () => undoNotes(g);
    state.notes = state.notes.map(n => ids.includes(n.id) ? { ...n, dismissed: true, seen: true } : n);
    noteGone = g; undoing = g.undo;
    renderNote();
    if (stillMotion.matches) g.timer = setTimeout(() => noteSettle(g), GHOST_MS);
    // A keyboard that closed it lands on the Undo, not on the page's start.
    // A pointer does not: a focus resting there would hold the clock.
    if (byKey) noteEl.querySelector("[data-note-undo]")?.focus({ preventScroll: true });
    notesSay("dismiss", ids).catch(e => { if (noteGone === g) undoNotes(g, false); toast("Could not close the aside", String(e)); });
  }
  function noteSettle(g) {
    if (noteGone !== g) return;
    clearTimeout(g.timer);
    if (undoing === g.undo) undoing = null;
    noteGone = null;
    renderNote();
  }
  function undoNotes(g, tell = true) {
    if (noteGone !== g) return;
    clearTimeout(g.timer);
    if (undoing === g.undo) undoing = null;
    noteGone = null;
    state.notes = state.notes.map(n => g.ids.includes(n.id) ? { ...n, dismissed: false } : n);
    renderNote();
    if (tell) notesSay("restore", g.ids).catch(e => toast("Could not bring the aside back", String(e)));
  }
  async function notesSay(what, ids) {
    const r = await fetch(`/api/notes/${what}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!r.ok) throw new Error(`${r.status}`);
  }
  // "3 min ago" stays true without anything arriving.
  setInterval(() => { if (liveNotes().length && !noteGone && !noteEl.matches(":hover")) renderNote(); }, 60000);
  renderNote();

  // ---------- snyvi answers ----------
  /** The note above is what an agent said, and its byline says who. This is
   *  snyvi itself, and the rule that keeps it from being a gimmick is that it
   *  only ever answers: nothing opens on its own, ever. A reader who comes
   *  over to the face and rests there gets one short line back. */
  const brandEl = $(".brand"), sayEl = $("#bm-say");
  /** What it says, the face it says it with, and how often the line comes up.
   *  The weights are the whole character. Most of what it says is "hi"; a
   *  count when there is one worth giving; and "love you" seldom enough that
   *  it still means something when it lands. A line whose text comes back
   *  empty is not true right now -- no one is waiting, an agent is connected,
   *  it is the middle of the afternoon -- and drops out of the draw.
   *  Every one of them is short on purpose: the line is written where the
   *  word "snyvi" is, and it has that much room and no more. */
  const SAYS = [
    { t: "hi", w: 5 },
    { t: "hey you", w: 3 },
    { t: "still here", w: 2 },
    { t: "hello again", w: 2, f: "glad" },
    { t: "good to see you", w: 2, f: "glad" },
    { t: "love you", w: 1, f: "love" },
    { t: "my favourite", w: 1, f: "love" },
    { t: () => state.waiting ? `${state.waiting} waiting` : "", w: 4, f: "glad" },
    { t: () => Object.keys(state.online).length ? "" : "no agents", w: 3 },
    { t: () => { const h = new Date().getHours(); return h < 5 || h >= 23 ? "late one?" : h < 10 ? "morning" : ""; }, w: 3, f: "wink" },
  ];
  /** The last few lines, so the same one does not come up twice running. */
  let saidLast = [], sayIn = 0, sayOut = 0;
  function pickSay() {
    // The page cannot hear the daemon: the eyes are already shut, and this is
    // where a reader who wonders why finds out.
    if (root.dataset.link === "off") return { t: "not connected", f: "" };
    const pool = [];
    for (const s of SAYS) {
      const t = typeof s.t === "function" ? s.t() : s.t;
      if (!t || saidLast.includes(t)) continue;
      for (let i = 0; i < s.w; i++) pool.push({ t, f: s.f || "" });
    }
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : { t: "hi", f: "" };
  }
  function openSay() {
    // A note still glowing is an agent waiting to be read. The agent has the
    // floor until then, and snyvi does not talk over its own messenger.
    if (root.dataset.note) return;
    const s = pickSay();
    saidLast = [s.t, ...saidLast].slice(0, 3);
    sayEl.textContent = s.t;
    sayEl.hidden = false;
    void sayEl.offsetWidth;   // the resting state first, so the rise transitions
    sayEl.classList.add("on");
    // An empty face is still a face here: `html[data-say]` matching on the
    // bare attribute is what stops the waiting blink and nods the head, and
    // a line said with no expression wants both.
    root.dataset.say = s.f;
  }
  function closeSay() {
    sayEl.classList.remove("on");
    delete root.dataset.say;
    clearTimeout(sayOut);
    sayOut = setTimeout(() => { if (!sayEl.classList.contains("on")) sayEl.hidden = true; }, 340);
  }
  brandEl.addEventListener("pointerenter", e => {
    // A finger is not a reader leaning over. Nor is crossing the brand on the
    // way to Search, so it waits for a moment's rest before it says anything.
    if (e.pointerType === "touch") return;
    clearTimeout(sayIn);
    sayIn = setTimeout(openSay, 260);
  });
  brandEl.addEventListener("pointerleave", () => { clearTimeout(sayIn); closeSay(); });
  // Following the brand through to the inbox takes the bubble with it.
  brandEl.addEventListener("click", () => { clearTimeout(sayIn); closeSay(); });

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
    if (swapAnim && swapAnim.playState === "running") swapAnim.finished.then(put, () => {});
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

  // ---------- mermaid (a chunk, fetched with the first diagram) ----------
  /* The driver is ui/mmd.js, and none of it is on the wire until a document
   * holding a diagram is on screen: 820 lines and 11.6 KB gzipped, carried by
   * every page load until bench/bytes.mjs priced it. The library itself has
   * been lazy since 0.2; this is the same move, made at last for the code that
   * drives it.
   *
   * `mmd` is that module once it has arrived, and these four calls are the
   * whole of what this page knows about diagrams. Each does nothing while it is
   * null, which is right rather than merely convenient: there is nothing a
   * diagram key or a theme change can mean on a page that has never held one. */
  let mmd = null, mmdLoading = null;

  const mmdLoad = () => (mmdLoading ||= import(`/assets/mmd.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (mmd = m))
    .catch(e => { mmdLoading = null; throw e; }));

  /** Every render, and the only one of the four that can start the fetch: a
   *  document with no `pre.mermaid` in it asks for nothing, which is most of
   *  them. Once the driver is here it hears about every render including those,
   *  because taking the last document's figures down is its job too. */
  function prepareMermaid() {
    if (mmd) { mmd.prepare(); return; }
    if (docEl.querySelector("pre.mermaid")) mmdLoad().then(m => m.prepare()).catch(() => {});
  }

  // ---------- history (every snapshot of the same file) ----------
  async function renderHistory() {
    const old = $("#history"); if (old) old.remove();
    state.versions = [];
    if (!state.doc || !state.doc.source_path) return;
    let h; try { h = await (await fetch(`/api/docs/${state.doc.id}/history`)).json(); } catch { return; }
    if (!h || h.length < 2) return;
    state.versions = h.map(d => d.id);
    const box = document.createElement("div"); box.id = "history";
    box.innerHTML = `<h4>Versions · ${h.length}</h4>` + h.map(d => `<a href="/d/${d.id}" data-id="${d.id}" class="${d.id === state.doc.id ? "cur" : ""}" title="${esc(d.workflow_title)}">${fmt(d.received_at)}${d.pinned ? " ●" : ""}</a>`).join("");
    metaEl.appendChild(box);
  }

  // ---------- find in document: a chunk, fetched when `/` asks for it ----------
  /* Searching inside a document is asked for, not done on the way to showing
   * one, so the bar and the marks are ui/find.js. The page keeps `#find`,
   * because whether the bar is up is a question it answers before deciding to
   * fetch anything; everything past that is `find?.`, which before the first
   * `/` is a no-op and means exactly what it says -- there is nothing marked. */
  const findBar = $("#find");
  let find = null, findLoading = null;
  async function openFind() {
    // The bar and its input are in the page already; only the searching is a
    // chunk. So the caret lands first and the module follows. Waiting for the
    // fetch before focusing leaves the keys the reader is already typing in
    // the page's own shortcuts, where `p` pins the document and `Delete`
    // deletes it -- a query is not a command, and must never arrive as one.
    findBar.hidden = false;
    const input = $("#find-input");
    input.focus(); input.select();
    try { find = await (findLoading ||= import(`/assets/find.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { findLoading = null; findBar.hidden = true; toast("Could not open find", String(e)); return; }
    find.open({ $, docEl, bring });
  }

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
    // Called on every scrolled frame, and most move nothing: the entries are
    // only touched when the current one changes. Kept in view either way.
    if (links.at !== at) {
      links.at = at;
      links.forEach((a, i) => {
        const on = i === at;
        a.classList.toggle("cur", on);
        if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current");
      });
    }
    if (links[at]) keepCurInView(false);
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
    // The other rail's follower goes here too, and not only where it is built:
    // a code document leaves one behind, and a prose document with three
    // headings takes the branch that never calls `buildOutline`. The scroll
    // and resize listeners then outlive their document -- one more per switch,
    // each measuring a `<pre>` that is no longer in the page and fighting this
    // one for where the rail is scrolled.
    if (outlineSpy) { outlineSpy.disconnect(); outlineSpy = null; }
    // Over a desk, the rail is the desk's: its panes and its documents stay,
    // and the document's own contents are not drawn over them.
    if (state.deskBehind != null) { rail.classList.remove("empty"); return; }
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

  /** Bring something in the document into view, in an engine that may decline to.
   *
   *  `scrollIntoView` does nothing at all in WebKitGTK -- the engine of the
   *  Linux window -- when the target sits inside a subtree the browser has
   *  skipped: a `.prose > *` below the fold, or one of the chunks a long code
   *  file is cut into. Measured there: an outline entry for line 2531 and an
   *  agent's `#L2531` both left the document at scroll 0 with the line 52,525
   *  px away, and a find match 8,879 px down was marked and never reached.
   *  All three work in Chromium, which scrolls into skipped content happily,
   *  so none of it showed in `bench/ui.mjs`.
   *
   *  So the scroller is moved rather than asked, the way placeAt() already
   *  corrects itself. One move is not enough in either engine: the blocks
   *  that come on screen are laid out at their real heights only after the
   *  frame that reveals them, so the target slides -- the fault jumpTo()
   *  describes, measured here as five corrections in WebKit and one in
   *  Chromium -- and further for prose, whose blocks are guessed at 60 px
   *  each until they are laid out, so a find match eight thousand pixels down
   *  is chased rather than reached in one move. The chase has to be patient:
   *  a move reveals blocks that then grow, which pushes the target further
   *  away, so a pass that loses ground is the normal middle of a jump and not
   *  a reason to give up -- stopping on it left a find match 308 px below the
   *  fold. It stops when the target is where it was asked to be, and after
   *  twenty frames whatever happens, so a target that cannot settle cannot
   *  spin.
   */
  function bring(target, block = "start") {
    let left = 20;
    const put = () => {
      // Resolved every pass, not held: find re-marks the document as the
      // blocks a jump passes through are laid out, and a chase holding the
      // node it started with stopped the moment that node was replaced --
      // 758 px short of a match it had already scrolled 8,439 px towards.
      const el = typeof target === "function" ? target() : target;
      if (!el || !el.isConnected) return true;   // the page moved on
      const box = el.getBoundingClientRect(), port = main.getBoundingClientRect();
      // The resting place is the stylesheet's: `.ln` and the headings each
      // declare the room they want above them.
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      const d = block === "center" ? box.top + box.height / 2 - (port.top + main.clientHeight / 2)
        : block === "nearest" ? (box.top < port.top + margin ? box.top - port.top - margin
          : box.bottom > port.bottom ? box.bottom - port.bottom : 0)
          : box.top - port.top - margin;
      const off = Math.abs(d);
      if (off < 2) return true;
      // Instant, not smooth: the pane scrolls smoothly by stylesheet, and a
      // correction aimed at where the target is now cannot chase an animation.
      main.scrollTo({ top: main.scrollTop + d, behavior: "instant" });
      return false;
    };
    const step = () => { if (!put() && left-- > 0) requestAnimationFrame(step); };
    step();
    /* And again, later. The chase above ends the frame the target is where it
     * was asked to be, but in WebKit the blocks it travelled through are laid
     * out for real after that, and what was centred slides: measured, a find
     * match the chase had just centred sat 758 px low a second afterwards.
     * Two late looks cost two timers and settle it. */
    for (const ms of [150, 450]) setTimeout(() => { left = 8; step(); }, ms);
  }

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
    const pre = docEl.querySelector("pre.code");
    const lines = pre ? pre.getElementsByClassName("ln") : [];
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
      bring(el, "start");
      flash(el);
    }));
    // Mark whichever declaration the reader has scrolled past. The line at the
    // top is found by halving rather than by asking every declaration where it
    // is: 691 of them measured on each scrolled frame was a 170 ms frame.
    outlineSpy = follow(() => {
      const top = lineAt(pre, 140);
      let lo = 0, hi = items.length - 1, cur = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (items[m].line <= top) { cur = m; lo = m + 1; } else hi = m - 1; }
      markCur(links, cur);
    });
  }
  let outlineToken = 0;

  /** The number of the last line whose top is above `y` in the window, or 0.
   *  Two binary searches: over the chunks the renderer cut a long file into,
   *  whose boxes are laid out whether or not their lines are, and then over the
   *  lines of the one chunk that holds `y` -- which is on screen, so asking
   *  where its lines are lays nothing out. */
  function lastAbove(list, y) {
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (list[m].getBoundingClientRect().top < y) { at = m; lo = m + 1; } else hi = m - 1;
    }
    return at;
  }
  function lineAt(pre, y) {
    const chunks = pre.getElementsByClassName("lc");
    if (!chunks.length) return lastAbove(pre.getElementsByClassName("ln"), y) + 1;
    const c = lastAbove(chunks, y);
    if (c < 0) return 0;
    const start = +(/ln (\d+)/.exec(chunks[c].getAttribute("style") || "") || [0, 0])[1];
    return start + lastAbove(chunks[c].getElementsByClassName("ln"), y) + 1;
  }
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
    if (first && scroll) bring(first, "center");
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
    if (state.deskBehind != null) return;   // the desk's meta stays, as its rail does
    if (state.view === "browse") { renderBrowseMeta(); return; }
    const d = state.doc;
    if (!d) { metaEl.innerHTML = ""; return; }
    const rows = [
      ["Project", d.project], ["Workflow", d.workflow_title], d.branch ? ["Branch", d.branch] : null,
      ["Received", fmt(d.received_at)], ["Size", d.size > 1024 * 1024 ? (d.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(d.size / 1024)) + " KB"],
      d.lang ? ["Lang", d.lang] : null,
    ].filter(Boolean);
    metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span title="${esc(v)}">${esc(v)}</span></div>`).join("") +
      // Sent from a pane: which desk and which slot, and a way back to it.
      // A link and not adjacency, because a window can have three desks and
      // `[1]` alone would not say which.
      (d.desk ? `<div class="row"><b>From</b><span><a href="/desk/${d.desk.id}" data-desk="${d.desk.id}" data-slot="${d.desk.slot}">${esc(d.desk.name)} [${d.desk.slot}] ▸</a></span></div>` : "") +
      `<div class="actions">` +
      (state.previous ? (comparing ? `<button data-act="back">← Back to document</button>` : `<button data-act="compare">Compare with previous<kbd>c</kbd></button>`) : "") +
      `<button data-act="pin">${d.pinned ? "Unpin" : "Pin"}<kbd>p</kbd></button>` +
      ((d.kind === "diff" || comparing) ? `<button data-act="split">${state.split ? "Inline view" : "Split view"}<kbd>s</kbd></button>` : "") +
      previewButton() +
      `<button data-act="delete">Delete<kbd>Del</kbd></button>` +
      `<a href="/api/docs/${d.id}/raw" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` +
      (d.source_path ? `<button data-act="copypath" title="${esc(d.source_path)}">Copy path</button>` : "") +
      (state.folder ? `<button data-act="terminal" title="${esc(state.folder)}">Open terminal here</button><button data-act="reveal" title="${esc(state.folder)}">Open in file manager</button>` : "") +
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
      `<button data-act="reveal" title="${esc(r.path + (p ? "/" + p : ""))}">Open in file manager</button>` +
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
    if (b.dataset.act === "reveal") openFolder();
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
  /** Where the terminal and the file manager open when nothing is named:
   *  the folder or the document on the page (menu.js, `terminal`, `reveal`). */
  const here = () => state.view === "browse" ? { root: state.browseRoot.id, path: state.browsePath || "" } : { doc: state.doc.id };
  const openTerminal = (body = here()) => act("terminal", body);
  const openFolder = (body = here()) => act("reveal", body);

  async function togglePin() {
    if (!state.doc) return;
    const pinned = !state.doc.pinned;
    try {
      await fetch(`/api/docs/${state.doc.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned }) });
      state.doc.pinned = pinned; state.cache.delete(state.doc.id);
      await refreshTree(state.doc.project_id);
      renderMeta(false);
      toast(pinned ? "Pinned" : "Unpinned", pinned ? "Kept by prune" : "Prune may remove it", null, null, { face: pinned ? "glad" : "plain" });
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
    const a = e.target.closest("a[data-id], a[data-browse], a[data-desk], [data-nav]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (a.dataset.nav === "inbox") showInbox(true);
    else if (a.dataset.nav === "connect") showConnect(true);
    else if (a.dataset.nav === "desks") showDesk(null, true);
    else if (a.dataset.browse !== undefined) showBrowse(a.dataset.browse, a.dataset.path, true);
    else if (a.dataset.desk !== undefined) showDesk(+a.dataset.desk, true, +a.dataset.slot || 0);
    else showDoc(a.dataset.id, true);
    if (root.dataset.sheet === "side") closeSheet();
  });
  /** A link inside a document, which the renderer has already sorted into the
   *  ones that leave snyvi and the ones that do not.
   *
   *  `data-ext` is the web: it carries `target="_blank"`, so a browser gives it
   *  a tab and the native window hands it to the desktop, and there is nothing
   *  to do here. What is left is same-origin, and falls in three parts. A
   *  document or a browsed file is a place in snyvi, so it is navigated to
   *  without a reload -- which is how a relative link between two files in a
   *  browsed folder comes to work at all. Anything else same-origin is not a
   *  page this viewer has: `[notes](./notes.md)` in a sent document resolves
   *  against `/d/<id>` and used to land on a bare "Not found" with no way back,
   *  inside a window with no Back button. It says so instead, and offers the
   *  browser for the reader who meant it. */
  docEl.addEventListener("click", e => {
    const a = e.target.closest(".prose a[href]");
    if (!a || a.dataset.ext !== undefined || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    // A fragment is the document's own; the browser and the anchor handlers
    // above already do the right thing with it.
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    let u;
    try { u = new URL(a.href); } catch { return; }
    // Cross-origin and unmarked, which is a document rendered before the
    // renderer marked them: the library keeps the HTML it was given at receive
    // time, so every document already in it predates the mark. Sent away from
    // the viewer here instead, which is what the mark would have done.
    if (u.origin !== location.origin) {
      e.preventDefault();
      window.open(a.href, "_blank", "noopener");
      return;
    }
    const d = u.pathname.match(/^\/d\/([a-z0-9]+)$/);
    if (d) { e.preventDefault(); showDoc(d[1], true); return; }
    const b = u.pathname.match(/^\/b\/([a-z0-9]+)(?:\/(.*))?$/);
    if (b) { e.preventDefault(); showBrowse(b[1], decodeURIComponent(b[2] || ""), true); return; }
    if (u.pathname === "/") { e.preventDefault(); showInbox(true); return; }
    if (u.pathname === "/connect") { e.preventDefault(); showConnect(true); return; }
    e.preventDefault();
    toast("Not a page in snyvi", href, null, {
      label: "Open anyway",
      run: () => window.open(a.href, "_blank", "noopener"),
    });
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
    // Back to a document read over a desk keeps the desk, while the desk is
    // still here to keep; back to one read in the library leaves it.
    if (d) return showDoc(d[1], false, true, !!(history.state && history.state.over != null));
    const b = location.pathname.match(/^\/b\/([a-z0-9]+)(?:\/(.*))?$/);
    if (b) return showBrowse(b[1], decodeURIComponent(b[2] || ""), false, true);
    if (location.pathname === "/connect") return showConnect(false);
    const k = location.pathname.match(/^\/desk\/(\d+)$/);
    if (k || location.pathname === "/desks") return showDesk(k ? +k[1] : null, false);
    showInbox(false);
  });

  // ---------- live arrivals ----------

  /** The window's capability: 32 bytes the daemon minted for this launch and
   *  handed over on the first URL's fragment, which is what lets this page open
   *  a desk socket. A tab has none and never will -- that is the whole of the
   *  rule that keeps panes out of a browser.
   *
   *  The fragment, not the query string: a query string is sent to the server
   *  and lands in anything that logs a request path, and a fragment is never
   *  sent at all. It leads the fragment and whatever fragment the URL really
   *  had follows it, so a document opened at a heading or a line range is put
   *  back exactly as it was on the way to being stripped.
   *
   *  Latched in `sessionStorage` for the same reason the window mark below is:
   *  the page reloads itself -- `location.reload()` here, `location.replace`
   *  there -- and anything held only in a variable dies at the first of them. */
  const capability = (() => {
    try {
      const m = /^#cap=([0-9a-f]{64})(?:&(.*))?$/.exec(location.hash);
      if (m) {
        sessionStorage.setItem("snyvi.cap", m[1]);
        // Out of the address bar before anything can read it there, and out of
        // the history entry, so Back never returns to it and a copied link
        // never carries it.
        const rest = m[2] ? "#" + m[2] : "";
        history.replaceState(history.state, "", location.pathname + location.search + rest);
      }
      return sessionStorage.getItem("snyvi.cap") || "";
    } catch { return ""; }
  })();

  /** Open the desk socket, which answers only a page that holds the
   *  capability. Resolves with the socket once the daemon has allowed it, and
   *  null when there is nothing to present or the daemon refuses -- which is
   *  what a browser tab gets, and what the caller draws "not here" from.
   *
   *  The capability goes in the first frame and not in the URL, so it stays out
   *  of the request the handshake makes. */
  async function deskSocket() {
    if (!capability) return null;
    const url = location.origin.replace(/^http/, "ws") + "/api/desk";
    let sock;
    try { sock = new WebSocket(url); } catch { return null; }
    return new Promise(resolve => {
      const give = v => { if (!v && sock.readyState <= 1) sock.close(); resolve(v); };
      sock.onerror = () => give(null);
      sock.onclose = () => give(null);
      sock.onopen = () => sock.send(JSON.stringify({ capability }));
      sock.onmessage = ev => {
        let j; try { j = JSON.parse(ev.data); } catch { return give(null); }
        give(j && j.ok ? sock : null);
      };
    });
  }

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

  // ---------- the window's frame ----------
  /* In the native window the page is the frame: no title bar, the header rows
   * drag, and the page draws the bar's three buttons. That is ui/frame.js,
   * fetched only where there is a window to ask, so a tab never carries it.
   * The chunk asks the window whether the page may -- an older window refuses
   * and keeps its own bar -- and draws nothing until it says yes. */
  if (window.__TAURI_INTERNALS__) import(`/assets/frame.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => m.frame(root, $), () => {});

  // ---------- desks ----------
  /* A desk is a folder and up to four panes, and it exists only in the
   * window: every way in, and every route behind them, needs the capability,
   * so a tab is shown the row with a dash and one sentence and nothing else.
   * The view is ui/desk.js, fetched the first time a desk is opened, so a
   * reader who never opens one pays for this block and no more. */
  const deskNav = $("#desk-nav");
  let desk = null, deskLoading = null, lastDesk = null;
  const plusDesk = () => capability ? `<button class="b-new" data-newdesk title="New desk here" aria-label="New desk here">${icon("desk")}</button>` : "";
  /** A desk route, with the capability in the one place a page can put a
   *  secret on a request it composes: a header. */
  async function deskApi(path, body, type) {
    const headers = { "content-type": type || "application/json", "x-snyvi-capability": capability };
    const r = await fetch(path, body === undefined ? { headers } : { method: "POST", headers, body: type ? body : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  /* Everything a folder or a desk can be *asked* to do waits for a pointer --
   * a right-click, the desk glyph on a row, the row that opens a folder, the
   * ✕ on a desk -- so it is ui/menu.js, fetched on the first such click and
   * never by a reader who only reads. What draws the desks is not in it:
   * `renderDesks` below runs at first paint and stays here.
   *
   * One context object, made once and handed over on every call, so the chunk
   * never keeps a second copy of what this page already knows. The functions
   * are wrappers rather than references because several of them are declared
   * further down this file. */
  let acts = null, actsLoading = null;
  const useActs = () => (actsLoading ||= import(`/assets/menu.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (acts = m)));
  const actsCtx = {
    state, esc, toast, browseEl,
    get capability() { return capability; },
    api: (path, body, type) => deskApi(path, body, type),
    load: () => loadDesks(),
    show: (id, push, slot) => showDesk(id, push, slot),
    browse: (root, path, push) => showBrowse(root, path, push),
    drawBrowse: () => renderBrowse(),
    forget: id => { if (lastDesk === id) lastDesk = null; },
    // What the context menu and the moves out of this file reach for: the
    // page's own functions, so the chunk runs the code a row's button runs.
    get desk() { return desk; },
    folderOf: el => folderOf(el),
    closeRoot: id => closeRoot(id),
    open: id => showDoc(id, true),
    togglePin: () => togglePin(),
    refreshTree: pid => refreshTree(pid),
    deleteDoc: d => deleteDoc(d),
    knownDocs,
    putAway: pid => putAway(String(pid)),
    applyRename: (what, id) => applyRename(what, id),
  };
  /** Wait for the chunk, then do the thing that was clicked. A failure is the
   *  reader's to see: they pressed something and nothing happened otherwise. */
  async function act(what, ...args) {
    try { const m = await useActs(); return m[what](actsCtx, ...args); }
    catch (e) { actsLoading = null; toast("Could not do that", String(e)); }
  }

  async function loadDesks() {
    if (capability) { try { state.desks = await deskApi("/api/desks"); } catch {} }
    renderDesks();
    if (desk && (state.view === "desk" || state.deskBehind != null)) desk.update(state.desks);
  }
  const mark3 = ps => ps.some(p => p.status && p.status.blocked) ? "!" : ps.some(p => p.status && p.status.running) ? "●" : "○";
  function renderDesks() {
    const list = state.desks ? state.desks.desks : [];
    let blocked = 0;
    for (const d of list) for (const p of d.panes) if (p.status && p.status.blocked) blocked++;
    const on = state.view === "desk" || state.deskBehind != null;   // a document read over a desk is still the desk
    // Blocked panes stay said on the head, so folding Desks cannot hide them.
    const head = secHead("desks", "Desks", (blocked ? `<span class="s-blk" title="${plural(blocked, "panel")} waiting on you">!${blocked}</span>` : "") + (capability ? `<button type="button" class="s-add" data-newdesk title="New desk" aria-label="New desk">+</button>` : ""));
    const top = `<ul class="t-desks s-body">` + (!capability ? `<li class="s-empty" title="Desks run in the desktop window">Open the snyvi window to run desks</li>`
        : !list.length ? `<li><button type="button" class="b-empty" data-newdesk>Start a shell on a desk</button></li>` : "");
    const rows = list.map(d => {
      const m = mark3(d.panes), has = d.panes.length > 0;
      const say = m === "!" ? `${plural(d.panes.filter(p => p.status && p.status.blocked).length, "panel")} waiting on you` : m === "●" ? "Running" : "Idle";
      // One row a desk, as the Inbox has one row a document: what the desk
      // holds is said by its mark and its count, and shown by opening it.
      // The mark and the count are one column at the row's end, drawn
      // whether or not there is anything to say, so every row's line up.
      return [`<li class="t-desk"><a href="/desk/${d.id}" data-desk="${d.id}" class="${on && state.deskId === d.id ? "active" : ""}">` +
        `${icon("desk")}<span class="title nm">${esc(d.name)}</span>`,
        `<span class="end"><span class="dot${m === "!" ? " blk" : m === "●" ? " on" : ""}" title="${say}">${m === "!" ? "!" : ""}</span><span class="k">${has ? d.panes.length : ""}</span></span>`,
        `${capability ? `<button type="button" class="row-x" data-dropdesk="${d.id}" title="Close desk" aria-label="Close desk ${esc(d.name)}">✕</button>` : ""}</a></li>`];
    });
    // A pane's dot changes far more often than the list does, and the row
    // under the pointer must not be swapped for a copy of itself: it would
    // lose its hover until the pointer moved, and a click pressed on the old
    // row and let go on the new one would not be a click. So what changed
    // is written, and only that -- the mark column, the head -- and the list
    // is drawn whole only when a row itself is different.
    const lis = deskNav.querySelectorAll(".t-desk"), same = deskNav.$top === top && lis.length === rows.length && rows.every((r, i) => lis[i].$r === r[0] + r[2]);
    if (!same) {
      deskNav.innerHTML = head + top + rows.map(r => r.join("")).join("") + `</ul>`;
      deskNav.$top = top; deskNav.$head = head;
      deskNav.querySelectorAll(".t-desk").forEach((li, i) => { li.$r = rows[i][0] + rows[i][2]; li.$e = rows[i][1]; });
      return;
    }
    if (deskNav.$head !== head) { deskNav.firstElementChild.outerHTML = head; deskNav.$head = head; }
    rows.forEach((r, i) => { if (lis[i].$e !== r[1]) { lis[i].querySelector(".end").outerHTML = r[1]; lis[i].$e = r[1]; } });
  }
  /** The desk view. A tab gets the sentence and not the grid: it could never
   *  start anything, and a grid of dead panes would say it might. */
  async function showDesk(id, push = true, slot = 0) {
    if (push) leave();
    const was = state.view === "desk";
    state.view = "desk"; state.deskId = id; state.deskBehind = null; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    overBar();
    if (id != null) lastDesk = id;
    root.dataset.view = "desk";
    if (push) history.pushState({ desk: id }, "", id == null ? "/desks" : `/desk/${id}`);
    renderTree(); markActive();
    if (!capability) {
      document.title = "Desks · snyvi";
      docEl.innerHTML = `<div class="inbox-head"><h1>Desks</h1><p>Desks run in the snyvi desktop window. This is a browser tab, so it has no capability to start a process. Open the same address in the desktop app.</p></div><p><code>snyvi:/${esc(location.pathname)}</code></p>`;
      tocEl.innerHTML = metaEl.innerHTML = ""; rail.classList.add("empty");
      return;
    }
    try { desk = await (deskLoading ||= import(`/assets/desk.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { deskLoading = null; toast("Could not open the desk", String(e)); return; }
    if (state.view !== "desk") return;
    if (!state.desks) await loadDesks();
    desk.open({ id, slot, was, desks: state.desks, api: deskApi, socket: deskSocket, toast, esc, plural, rel, relShort, fmt, read: id => showDoc(id, true, false, true), reveal: openFolder, sized: sayTermSize, go: showDesk, swap: swapDesk, make: () => newDesk(null), refresh: loadDesks, main, docEl, tocEl, metaEl, rail, root });
  }
  /** Out of the desk view, to wherever the page is going next. */
  function offDesk() {
    if (state.view === "desk") { delete root.dataset.view; if (desk) desk.close(); }
    else if (state.deskBehind != null && desk) desk.close();
    state.deskBehind = null;
    overBar();
  }
  /** A document opened from a desk's own list keeps the desk's rail -- its
   *  panes, its documents with this one marked -- and only the page changes.
   *  Any other open leaves the desk for the library: the reader went to the
   *  sidebar, and the sidebar's document gets the sidebar's rail. A tab,
   *  which has no desk module, and the desks list, which is no desk, leave
   *  as before too. */
  function behindDesk(id, over) {
    if (!over) { offDesk(); return; }
    if (state.view === "desk" && state.deskId != null && desk) { state.deskBehind = state.deskId; delete root.dataset.view; }
    if (state.deskBehind == null) { offDesk(); return; }
    desk.aside(id);
    overBar();
  }
  /** The screen a document or a file was opened from, for its ✕ to go back
   *  to: the Inbox, a folder's contents, the agents page, a desk. Asked just
   *  before the page leaves it. Read on from one document to the next, with
   *  `j`, a link or the palette, and the reader is still on the same visit:
   *  the entry being left already knows where that visit began. */
  function cameFrom() {
    if (state.view === "doc" || (state.view === "browse" && state.browsePath)) return (history.state && history.state.back) || null;
    if (state.view === "inbox") return { inbox: true };
    if (state.view === "browse" && state.browseRoot) return { browse: state.browseRoot.id, path: "" };
    if (state.view === "connect") return { connect: true };
    if (state.view === "desk") return { desk: state.deskId };
    return null;
  }
  /** Where the ✕ leads, and its name for it. A document over a desk goes
   *  back to the panels, with the focus they had, as a second click on the
   *  row does. Otherwise the screen it was opened from, past every document
   *  read in between -- a step to that screen, not a walk back through
   *  history. With none, a file goes to its folder and anything else to the
   *  Inbox: a deep link, a first load and a new window have no screen
   *  behind them. */
  function backTo() {
    if (state.deskBehind != null) return { name: "the panels", go: () => showDesk(state.deskBehind, true) };
    let b = history.state && history.state.back;
    if (!b && state.view === "browse" && state.browseRoot) b = { browse: state.browseRoot.id, path: "" };
    if (b && b.browse) {
      const r = state.browse.find(x => x.id === b.browse);
      return { name: r ? r.name : "the folder", go: () => showBrowse(b.browse, "", true) };
    }
    if (b && b.connect) return { name: "Connect an agent", go: () => showConnect(true) };
    if (b && "desk" in b) {
      const d = b.desk != null && state.desks && state.desks.desks.find(x => x.id === b.desk);
      return { name: d ? d.name : "Desks", go: () => showDesk(b.desk, true) };
    }
    return { name: "Inbox", go: () => showInbox(true) };
  }
  /** Out of what is being read. A comparison is left first, as `c` does. */
  function goBack() {
    if (state.comparing && state.doc) { state.cache.delete(state.doc.id); showDoc(state.doc.id, false); return; }
    backTo().go();
  }
  /** The name of what is being read and a ✕ in the head (app.css, #chrome
   *  .over), on every document and every file -- the way back to where it
   *  was opened from. Not on a list: the Inbox, a folder or a desk is where
   *  the reader goes back to, not something to leave. */
  const overEl = $("#chrome .over"), overX = overEl.lastChild;
  function overBar() {
    const file = state.view === "browse" && state.browseRoot && state.browsePath;
    const on = (state.view === "doc" && (!!state.doc || !!state.opening)) || !!file;
    overEl.hidden = !on;
    overEl.firstChild.textContent = !on || state.opening ? "" : file ? state.browsePath.split("/").pop() : state.doc.title;
    if (!on) return;
    const to = backTo().name, label = `Back to ${to}`;
    overX.title = `${label}  ${state.deskBehind != null ? "⌃`" : "Esc"}`;
    overX.setAttribute("aria-label", label);
  }
  overX.addEventListener("click", goBack);
  /** `⌃\``: between the desk and what was being read. */
  function swapDesk() {
    if (state.view === "desk") { history.length > 1 ? history.back() : showInbox(true); return; }
    const d = lastDesk != null ? lastDesk : state.desks && state.desks.desks[0] ? state.desks.desks[0].id : null;
    showDesk(d, true);
  }
  /** A desk's rail lists what its panes sent, so a document arriving, being
   *  opened, deleted or pinned is its business too. The desk asks again
   *  rather than being told: the events reach tabs, and only a window holds
   *  the capability that answers. */
  const deskDocs = () => { if (desk && ((state.view === "desk" && state.deskId != null) || state.deskBehind != null)) desk.docs(); };
  /** The folder a row in the browse tree is, in the two shapes it is needed:
   *  the root and path every route takes, and the absolute path a desk is
   *  compared by. */
  function folderOf(el) {
    const d = el.closest(".b-dir > details, .b-root");
    const r = d && state.browse.find(x => x.id === d.dataset.root);
    if (!r) return null;
    const path = d.dataset.path || "";
    return { root: r.id, path, abs: r.path + (path ? "/" + path : "") };
  }

  /* The one part of every context menu that cannot be deferred: a page has
   * to be listening for the right-click before it can know one is coming,
   * and has to decide at once whether the browser's own menu shows. What the
   * menus are and do is in the chunk (menu.js, `entries`). A field keeps the
   * browser's menu -- paste, spelling -- and so does a selection in a
   * document, for its Copy. Anywhere else in the window, WebKit's Back,
   * Forward and Reload are not snyvi's, and do not show. */
  const MENU_AT = ".b-root > summary, .b-dir > details > summary, a[data-browse], .t-proj > summary, a[data-id], a[data-desk], " +
    ".dk-pane, .pn-head, .pn-body, .dk-doc, .dk-list > .dk-note:not(.gone)";
  const menuFor = (el, x, y, byKey) => act("open", el, x, y, byKey);
  document.addEventListener("contextmenu", e => {
    if (e.target.closest("input, textarea, [contenteditable]")) return;
    const sel = getSelection();
    if (!sel.isCollapsed && e.target.closest("#doc") && !e.target.closest(".pn-body")) return;
    const at = e.target.closest(MENU_AT);
    if (!at) { if (capability) e.preventDefault(); return; }
    e.preventDefault();
    menuFor(at, e.clientX, e.clientY, false);
  });
  /* And from the keyboard: the menu key or ⇧F10 on whatever has the focus,
   * at its corner; F2 renames the project or desk row that has it. Inside a
   * panel only the menu key: ⇧F10 and F2 are the program's. */
  document.addEventListener("keydown", e => {
    const el = document.activeElement;
    if (!el || el.closest("input, textarea, [contenteditable]")) return;
    const inPane = !!el.closest(".pn-body");
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !inPane)) {
      const at = el.closest(MENU_AT);
      if (!at) return;
      e.preventDefault(); e.stopPropagation();
      const r = at.getBoundingClientRect();
      menuFor(at, r.left + 12, r.top + Math.min(r.height, 28), true);
    } else if (e.key === "F2" && !inPane && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const p = el.closest(".t-proj > summary"), d = el.closest("a[data-desk]");
      if (p) { e.preventDefault(); startRename(p, "project", +p.parentElement.dataset.pid); }
      else if (d && capability) { e.preventDefault(); startRename(d, "desk", +d.dataset.desk); }
    }
  }, true);

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
    try {
      const n = await (await fetch("/api/notes")).json();
      if (Array.isArray(n.notes)) { state.notes = n.notes; renderNote(); }
    } catch {}
    await refreshTree();
    if (state.view === "inbox") showInbox(false);
  }

  /** The brand mark is the state of the stream: solid while the page hears
   *  the daemon, hollow while it does not. The one place a page that has
   *  quietly lost its daemon -- one that stopped, or was replaced by an
   *  upgrade -- shows it, and the reason a reader is not left wondering why
   *  nothing arrives. */
  /* Why it is hollow used to be a `title` on the mark, which meant hovering
     snyvi drew a tooltip over the sidebar and an answer in its own line at
     once, two texts for one gesture. The answer is the line it says. */
  function linked(on) {
    if (on) delete root.dataset.link;
    else root.dataset.link = "off";
  }

  function connect() {
    const es = new EventSource("/api/events" + (inWindow ? "?window=1" : ""));
    stream = es;
    es.onopen = async () => {
      // A first connection is not a return.
      if (root.dataset.link !== "off") return;
      linked(true);
      // The daemon on the port now may be a newer build than the one that
      // served this page: its bundle is the one to run, so start over on it.
      // Otherwise catch up on what arrived while nothing was heard.
      let h = null;
      try { h = await (await fetch("/api/health")).json(); } catch {}
      if (h && h.v && boot.v && h.v !== boot.v) { location.reload(); return; }
      if (h) setOnline(h.agents);
      catchUp();
    };
    // The dev loop, and only the dev loop: a daemon started with SNYVI_UI_DIR
    // serves this file off disk and says so when it changes. A shipped daemon
    // never sends this, so the listener costs a page nothing but its own line.
    es.addEventListener("reload", () => location.reload());

    // An agent arrived or left: its process opened or ended a stream.
    es.addEventListener("agents", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      setOnline(j.online);
    });
    // An agent left a note, or a reader looked at one somewhere.
    es.addEventListener("notes", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(j.notes)) { state.notes = j.notes; renderNote(); }
    });
    es.addEventListener("doc", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      const d = j.doc;
      // A project that was put away and has just been written to is not put
      // away any more: the sidebar never holds back something waiting to be
      // read. Taking it out of the set is enough -- the refresh below draws it.
      if (d && away.delete(String(d.project_id))) saveAway();
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
        deskDocs();
        return;
      }
      // An arrival joins the queue and the page stays where it is. The one
      // place it opens by itself is the inbox with nothing waiting: the empty
      // state exists to be filled, and a reader there has nothing to lose.
      // An inbox with a queue on it is the queue, and the arrival is a row.
      const opens = state.view === "inbox" && !state.waiting;
      // The document on screen has just been sent again. The page stays where
      // it is -- a reader mid-paragraph did not ask to be moved -- and the
      // arrival is offered instead of taken.
      const superseded = !!(j.supersedes && state.doc && state.doc.id === j.supersedes);
      // Held in order only while everything waiting is held: past that the
      // arrival is the newest, and belongs after rows this page never had.
      if (!queueIds.has(d.id) && state.queue.length === state.waiting) state.queue.push(d);
      state.waiting = j.waiting != null ? j.waiting : state.waiting + 1;
      if (!opens) wash([d.id]);
      holdQueue();   // a burst's events carry counts ahead of the rows this page holds
      state.cache.delete(d.id);
      renderTree(); markActive();
      await refreshTree(d.project_id);
      deskDocs();
      if (opens) {
        await showDoc(d.id, true);
        // Nobody pressed anything: this one came in on its own, so it keeps
        // the corner rather than pointing at whatever was last touched.
        toast(d.title, `${d.project} · just now`, null, null, { at: null, face: "whoa" });
      }
      else if (superseded) {
        // The rail picks it up either way, so the offer is free to fade: a
        // reader who misses the button finds the new version at the top of
        // Versions, and `]` steps to it.
        renderHistory();
        toast("A newer version arrived", d.title, null,
          { label: "Read it", run: () => showDoc(d.id, true) }, { at: null, face: "whoa" });
      }
      else if (state.view === "inbox") showInbox(false);
    });
    // A document was opened somewhere -- this tab, another, the window -- and
    // is off the queue everywhere.
    es.addEventListener("read", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(j.ids)) dropFromQueue(j.ids, j.waiting);
      deskDocs();
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
      deskDocs();
      if (state.doc && state.doc.id === j.id) showInbox(true);
      else if (state.view === "inbox") showInbox(false);
    });
    // A delete that was taken back, in every tab and the window: the row is
    // where it was, and so is its place in the queue if it never got read.
    es.addEventListener("restored", async ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.waiting != null) state.waiting = j.waiting;
      if (j.id != null) wash([j.id]);
      await refreshTree(j.doc && j.doc.project_id);
      deskDocs();
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
    es.addEventListener("pinned", async () => { await refreshTree(); deskDocs(); });
    // A desk was made, renamed, closed, or a pane opened or closed. The event
    // is empty on purpose -- it reaches tabs too -- so a window asks again.
    es.addEventListener("desks", () => loadDesks());
    // An agent ticked a line on a desk's list.
    es.addEventListener("desknotes", ev => { try { const j = JSON.parse(ev.data); if (desk && desk.notesChanged) desk.notesChanged(j.desk); } catch {} });
    // A pane started, stopped, or rang for its reader: the dots, at once.
    es.addEventListener("panes", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      for (const d of state.desks ? state.desks.desks : []) for (const p of d.panes) if (p.id === j.id) p.status = { ...p.status, running: j.running, blocked: j.blocked, agent: j.agent };
      renderDesks();
    });
    // Another tab named a project or a workflow.
    es.addEventListener("renamed", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.project != null) applyRename("project", j.project);
      else if (j.workflow != null) applyRename("workflow", j.workflow);
    });
    es.onerror = () => {
      es.close();
      if (stream === es) stream = null;
      linked(false);
      retry = setTimeout(connect, 2000);
    };
  }

  /* ---------- what snyvi says back ----------
   * A toast at the bottom-right corner is a message posted to an address
   * nobody is looking at: the click was on a button in the left rail, or on a
   * mark in the middle of a paragraph, and the eye is still there. The answer
   * moves to the hand instead. Every one of these is snyvi answering -- the
   * same face as the logo, wearing the accent -- and it comes up beside the
   * thing that was just pressed, leaning towards it, with the corner kept for
   * the few that answer nothing in particular: an arrival, a dropped stream.
   *
   * The DOM is what it was -- `#toasts` holding `.toast`, with `.t`, `.s` and
   * `button.act` inside -- so what reads a toast, bench/ui.mjs included,
   * still finds it. What changed is where the box is put and who is in it. */
  /* The six faces, which are the whole of the tone. The box around them is
   * kept as small as it can be read at -- a head, a line, and a line under it
   * when there is more to say -- because the face is what is being looked at.
   * Every one is built from the logo's own geometry: eyes at 11 and 21,
   * mouth at 23, so the head in an answer is the head in the corner of the
   * sidebar and reads as the same creature rather than an illustration of
   * it. What each one does when it lands is in app.css, keyed off data-feel. */
  const EYE = (x, r = 2.6) => `<ellipse class="mk-ink" cx="${x}" cy="16.5" rx="${r}" ry="${+(r * 1.27).toFixed(2)}"/>`;
  const SHUT = `<path class="mk-line" d="M8.6 17q2.4 1.8 4.8 0M18.6 17q2.4 1.8 4.8 0"/>`;
  const UP = (l = 1, r = 1) => `<path class="mk-line" d="${l ? "M8.6 17.8q2.4-3 4.8 0" : ""}${r ? "M18.6 17.8q2.4-3 4.8 0" : ""}"/>`;
  const HEART_EYE = x => `<path class="mk-love" transform="translate(${x} 16.5) scale(.85)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/>`;
  const SMILE = `<path class="mk-line" d="M13.5 23q2.5 2.2 5 0"/>`;
  const FACES = {
    // Open eyes, a small smile: heard you.
    plain: EYE(11) + EYE(21) + SMILE,
    // Eyes up, mouth open: the thing you wanted happened.
    glad: UP() + `<path class="mk-ink" d="M13 22.4q3 4 6 0z"/>`,
    // One eye up: said with a bit of mischief, for the lights and the like.
    wink: UP(1, 0) + EYE(21) + SMILE,
    // Hearts, and they float off. Rare on purpose; it means nothing if not.
    love: HEART_EYE(11) + HEART_EYE(21) + SMILE +
      // The heart that floats off is a group with the placement on the path
      // inside it: a CSS transform on an SVG element replaces the element's
      // own transform attribute outright, so the animation gets a wrapper of
      // its own to move rather than eating the placement.
      `<g class="mk-puff"><path transform="translate(26 8) scale(.5)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/></g>`,
    // Eyes wide, mouth a small o: something arrived.
    whoa: EYE(11, 3.1) + EYE(21, 3.1) + `<ellipse class="mk-ink" cx="16" cy="23.4" rx="1.9" ry="2.2"/>`,
    // Eyes down, mouth flat: it could not, and it is sorry about it.
    oops: SHUT + `<path class="mk-line" d="M13.8 23.4h4.4"/>`,
  };
  /** snyvi's head at any size, in the accent it is wearing. */
  const mascotHead = feel => `<svg class="mk" viewBox="0 0 32 32" aria-hidden="true">` +
    `<rect class="mk-nub" x="14" y="0.5" width="4" height="5" rx="2"/><rect class="mk-body" x="1" y="4" width="30" height="27" rx="9"/>` +
    (FACES[feel] || FACES.plain) + `</svg>`;
  /** Nothing said this way is bad news, except the lines that are. They open
   *  the same handful of ways, and the face should not be smiling at them. */
  const feelFor = t => /^(could not|no |not |nothing|too late|never|failed)\b/i.test(t) || /\bis gone\b/i.test(t) ? "oops" : "plain";

  /* Where the reader last acted, which is where they are looking. A pointer
   * press is the honest signal; Enter or Space on something focused is the
   * keyboard's version of the same. Both go stale quickly, so a reply that
   * arrives long after a click -- an arrival off the stream, say -- is not
   * mistaken for an answer to it and posted at a button nobody pressed. */
  const ACTABLE = "button, a, summary, [role='button'], .ln, .anchor";
  let actEl = null, actAt = -1e9;
  const actNote = el => { if (el) { actEl = el; actAt = performance.now(); } };
  addEventListener("pointerdown", e => actNote(e.target?.closest?.(ACTABLE)), true);
  addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") actNote(document.activeElement?.closest?.(ACTABLE)); }, true);
  /** The anchor only counts while it is recent, still in the page, and on
   *  screen: a button that has scrolled away is no better than the corner. */
  function liveAct() {
    if (!actEl || !actEl.isConnected || performance.now() - actAt > 3000) return null;
    const r = actEl.getBoundingClientRect();
    return r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? actEl : null;
  }

  const toastsEl = $("#toasts");
  let toastAt = null;   // what the stack is currently pointing at
  /** Put the stack beside `el`, on the side with room for it. A control in
   *  the left rail answers to its right, one in the contents rail to its
   *  left, and anything in the middle of the page answers just below itself,
   *  which is the way the eye is already travelling after a click. */
  function placeToasts(el) {
    const s = toastsEl.style, box = 330, gap = 12;
    const r = el && el.isConnected ? el.getBoundingClientRect() : null;
    // A control that is not on screen -- the sidebar folded away, the button
    // scrolled past -- is no better an address than the corner. This catches
    // the ones handed in by name as well: `w` and `z` answer at the rail
    // where the setting lives, but only while the rail is there to point at.
    const shown = r && r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    toastAt = shown ? el : null;
    if (!shown) { s.cssText = ""; delete toastsEl.dataset.side; return; }
    const side = r.right + gap + box < innerWidth - 12 && r.left < innerWidth * 0.55 ? "right"
      : r.left - gap - box > 12 ? "left" : "below";
    s.right = s.left = "auto"; s.bottom = "auto";
    if (side === "right") s.left = Math.round(r.right + gap) + "px";
    else if (side === "left") s.right = Math.round(innerWidth - r.left + gap) + "px";
    else s.left = Math.round(Math.max(12, Math.min(r.left, innerWidth - box - 12))) + "px";
    // Centred on the thing it answers, or under it, by its own measured
    // height; moved only as far as it takes to stay on the window. This held
    // its top 96px off the bottom, a guess at the height, and every button
    // low in the rail -- theme, accent, Aa -- was answered a button too high.
    // The tail follows the button, so a nudged box still points at it.
    const h = toastsEl.offsetHeight || 42, cy = r.top + r.height / 2;
    const want = side === "below" ? r.bottom + gap : cy - h / 2;
    const top = Math.round(Math.max(4, Math.min(want, innerHeight - h - 4)));
    s.top = top + "px";
    s.setProperty("--tail", Math.round(Math.max(8, Math.min(cy - top - 4, h - 16))) + "px");
    toastsEl.dataset.side = side;
  }
  /* A button in the rail names itself on hover, in the very spot its answer
   * comes up in. While the answer is up it is the better label of the two. */
  const saidBy = el => el?.classList?.add("said");
  // The window moving underneath takes the anchor with it.
  let replaceFrame = 0;
  const followAnchor = () => {
    if (!toastAt || !said) return;
    cancelAnimationFrame(replaceFrame);
    replaceFrame = requestAnimationFrame(() => { if (toastAt && said) placeToasts(toastAt); });
  };
  addEventListener("resize", followAnchor);
  addEventListener("scroll", followAnchor, true);

  /* There is one of these at a time. Two of them is a pile of receipts, and
   * a pile is read as a list -- which is the one thing this is not: it is a
   * creature answering, and a creature says the next thing instead of the
   * last one, in the place the next thing was asked. So a new answer takes
   * the old one's place, wherever that was, and the old one is simply gone.
   * Clicking the accent eight times running is eight bobs of the same head
   * in eight colours, which is the setting itself, said. */
  let said = null;
  /** Clear whatever is being said now, without ceremony. */
  function hush() {
    if (!said) return;
    clearTimeout(said.timer);
    said.el.remove();
    said.anchor?.classList?.remove("said");
    said = null;
  }

  /** snyvi's answer, beside whatever was just pressed. `onClick` makes the
   *  whole thing one; `action` ({label, run}) puts a button in it instead,
   *  for the one thing an answer can offer that a reader must be able to
   *  reach deliberately. `opts.at` overrides where it goes -- `null` sends it
   *  to the corner -- and `opts.face` overrides how it is said. */
  function toast(title, sub, onClick, action, opts = {}) {
    const at = "at" in opts ? opts.at : liveAct();
    hush();
    const el = document.createElement("div");
    el.className = "toast";
    el.dataset.feel = opts.face || feelFor(title);
    el.innerHTML = `<span class="who">${mascotHead(el.dataset.feel)}</span>` +
      `<span class="say"><div class="t">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</span>`;
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "act"; b.textContent = action.label;
      b.addEventListener("click", ev => { ev.stopPropagation(); hush(); action.run(); });
      el.appendChild(b);
    } else {
      el.addEventListener("click", () => { hush(); onClick && onClick(); });
    }
    toastsEl.appendChild(el);
    // Placed once it is in, so it is placed by the height it really has.
    placeToasts(at);
    const anchor = toastAt;
    saidBy(anchor);
    const life = opts.life || (action ? UNDO_MS : onClick ? 8000 : 3500);
    // It fades where it stands, and only if it is still the one being said.
    const mine = { el, anchor, timer: 0 };
    mine.timer = setTimeout(() => {
      el.classList.add("out");
      mine.timer = setTimeout(() => { if (said === mine) { hush(); placeToasts(null); } }, 180);
    }, life);
    said = mine;
    return el;
  }

  // ---------- palette ----------
  /* ⌘K is ui/palette.js, fetched the first time it is asked for: the one box
   * a reader summons rather than meets, so first paint does not carry it.
   * The page keeps `#palette` and these two names, so Esc and ⌘K mean the
   * same thing before it is fetched -- a palette never opened has nothing to
   * close. */
  const pal = $("#palette");
  let palMod = null, palLoading = null;
  async function openPalette() {
    // The box goes up now and the chunk fills it when it lands, searching
    // whatever was typed in between -- a ⌘K followed at once by a word
    // would otherwise lose the word to a box that was not there yet.
    const input = $("#palette-input");
    if (pal.hidden) { input.value = ""; openDialog(pal, input); }
    try { palMod = await (palLoading ||= import(`/assets/palette.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { palLoading = null; closeDialog(pal); toast("Could not open search", String(e)); return; }
    palMod.open({ pal, input: $("#palette-input"), list: $("#palette-list"), state, capability, root, esc, rel, mascotHead, browsing, codePre,
      openDialog, closeDialog, THEMES, slot, previewTheme, setTheme, loadThemes, act, gotoLine, showDesk, showBrowse, showDoc });
  }
  const closePalette = () => { if (palMod) palMod.close(); };
  const browsing = () => state.view === "browse" && state.browseRoot;
  $("#btn-search").addEventListener("click", openPalette);

  // ---------- theme / font / panes ----------
  /* One click always changes what you see: the button steps to the next of
   * the eight, as the swatch steps to the next accent. The one it lands on is
   * kept exactly as a palette pick is -- in the slot of its side, and
   * dropped to "the system" when that side is what the system shows, so the
   * OS switching light and dark still moves between your two.
   *
   * Which theme is in each slot, and whether the system or the button picks
   * the slot, are the three `snyvi.theme.*` keys; boot.js owns resolving them
   * into `data-theme` and "is it dark?". */
  const { system: sysDark } = snyviTheme;
  /* The eight, each with the side it is: which slot it lives in, and which
   * side the button lands on when it is kept. Four light and four dark, one
   * of each for every pair of accents. */
  const THEMES = { paper: ["Paper", "light"], snow: ["Snow", "light"], sage: ["Sage", "light"], parchment: ["Parchment", "light"],
    ink: ["Ink", "dark"], midnight: ["Midnight", "dark"], espresso: ["Espresso", "dark"], contrast: ["Contrast", "dark"] };
  const sysSide = () => (sysDark.matches ? "dark" : "light");
  const slot = k => store.get(k === "light" ? "snyvi.theme.light" : "snyvi.theme.dark") || (k === "light" ? "paper" : (matchMedia("(prefers-contrast: more)").matches ? "contrast" : "ink"));
  // The button steps through the eight like the swatch steps through the
  // accents: one click, the next one, the whole window in it.
  const ORDER = Object.keys(THEMES);
  const nextTheme = () => ORDER[(ORDER.indexOf(root.dataset.theme) + 1) % ORDER.length];
  const SUN = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="3.5"/><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06"/></svg>';
  const MOON = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z"/></svg>';
  function paintThemeBtn() {
    const b = $("#btn-theme"), n = nextTheme();
    // The icon is the side a click will land on.
    b.innerHTML = THEMES[n][1] === "dark" ? MOON : SUN;
    b.dataset.label = `Theme: ${(THEMES[root.dataset.theme] || [root.dataset.theme])[0]} · click for ${THEMES[n][0]}`;
  }
  $("#btn-theme").addEventListener("click", async () => { await loadThemes(); setTheme(nextTheme()); });
  paintThemeBtn();
  /* Every theme but Paper and Ink, fetched once the page is idle rather than
   * carried by first paint. The button and ⌘K theme wait on the same promise,
   * so a click that beats it -- a few milliseconds from the local daemon --
   * lands anyway. When it is in, the theme boot.js stood in for is drawn,
   * and the copies it will stand in with next time are brought up to date. */
  let themesP = null;
  const loadThemes = () => themesP ||= new Promise(done => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = `/assets/themes.css${boot.v ? `?v=${boot.v}` : ""}`;
    l.onload = () => {
      const was = root.dataset.theme;
      snyviTheme.ready();
      keepCopies();
      paintThemeBtn();
      if (mmd && root.dataset.theme !== was) mmd.retheme();
      done(true);
    };
    l.onerror = () => { l.remove(); themesP = null; done(false); };
    document.head.append(l);
  });
  (window.requestIdleCallback || setTimeout)(() => loadThemes(), { timeout: 1500 });
  /** The copies boot.js paints the first frame from: the block of the theme
   *  in each slot, as the sheet has it now, so a copy lasts exactly as long
   *  as that theme's colours do. Paper and Ink are in first paint and need
   *  none; a slot naming a theme that no longer exists goes back to its
   *  default. */
  function keepCopies() {
    const sheet = [...document.styleSheets].find(x => /\/assets\/themes\.css/.test(x.href || ""));
    if (!sheet) return;
    for (const side of ["light", "dark"]) {
      const t = slot(side), key = `snyvi.theme.css.${side}`;
      if (t === "paper" || t === "ink") { store.del(key); continue; }
      const rule = [...sheet.cssRules].find(r => r.selectorText === `[data-theme="${t}"]`);
      if (rule) store.set(key, ":root" + rule.cssText);
      else { store.del(key); store.del(`snyvi.theme.${side}`); }
    }
  }
  /** Keep a theme picked in the palette: it goes in the slot of its side, and
   *  the button lands on that side -- dropped to "the system" when that is
   *  what the system shows, the same rule as a click on the button. */
  function setTheme(name) {
    const [label, side] = THEMES[name] || [];
    if (!side) return;
    store.set(side === "light" ? "snyvi.theme.light" : "snyvi.theme.dark", name);
    store.set("snyvi.theme.follow", side === sysSide() ? "" : side);
    keepCopies();
    previewTheme(null);
    paintThemeBtn();
    toast("Theme", label, null, null, { face: "glad", at: $("#btn-theme") });
  }
  /** Draw a theme without keeping it, or, with no name, the one that is
   *  kept. Diagrams already drawn in it come back from their cache. */
  function previewTheme(name) {
    const was = root.dataset.theme;
    name ? (root.dataset.theme = name) : snyviTheme.apply();
    if (mmd && root.dataset.theme !== was) mmd.retheme();
  }
  // The same fault by a different route: following the system, the page
  // moves when the system does, and the diagrams on it were drawn before it
  // moved. boot.js has already re-resolved `data-theme` by the time this runs;
  // applying again is free and keeps this from depending on that order.
  sysDark.addEventListener("change", () => {
    const was = root.dataset.theme;
    snyviTheme.apply();
    paintThemeBtn();
    if (mmd && root.dataset.theme !== was) mmd.retheme();
  });
  /* Which controls mean something where the reader is, in one place: the
   * column paints from it and `w` and `z` ask it, so the two cannot
   * disagree. A control that does nothing here is dimmed, not hidden -- it
   * stays focusable, and its tooltip, a click and its key all say why,
   * instead of the silence it used to answer with. "" is "it works". */
  const onDesk = () => root.dataset.view === "desk" && !!desk && !!docEl.querySelector(".pn");
  function where() {
    if (onDesk()) return "desk";
    const a = docEl.querySelector("article.prose, article.preview");
    return !a ? "list" : a.matches(".kind-markdown") ? "prose" : "code";
  }
  const NAMES = { wide: "Width", wrap: "Wrap", font: "Font" };
  function why(c) {
    const w = where();
    if (c === "wide") return w === "code" ? "already full width" : w === "desk" && desk.panels() < 2 ? "one panel already fills the desk" : "";
    if (c === "wrap") return w === "desk" ? "not for desks, terminals always wrap" : docEl.querySelector("pre.code") ? "" : "no code on this page";
    return w === "code" ? "code is always monospace" : w === "list" ? "for documents" : "";
  }
  const btnOf = c => $(c === "font" ? "#btn-font" : c === "wide" ? "#btn-wide" : "#btn-wrap");
  function paintControls() {
    for (const c of Object.keys(NAMES)) {
      const b = btnOf(c), no = why(c);
      b.classList.toggle("dim", !!no);
      no ? b.setAttribute("aria-disabled", "true") : b.removeAttribute("aria-disabled");
      if (no) b.dataset.label = `${NAMES[c]} · ${no}`;
    }
    if (!why("wide")) $("#btn-wide").dataset.label = onDesk() ? "Focused panel in full view · w" : "Maximise width · w";
    if (!why("wrap")) $("#btn-wrap").dataset.label = "Wrap long lines · z";
    if (!why("font")) paintFontBtn();
  }
  /** Run a control, or say why it does nothing here, beside its button. */
  const control = (c, run) => () => {
    const no = why(c);
    no ? toast(NAMES[c], no, null, null, { at: btnOf(c) }) : run();
    paintControls();
  };
  // It is only seen while the column is open, so that is when it is painted.
  $(".foot-set").addEventListener("pointerenter", paintControls);
  $(".foot-set").addEventListener("focusin", paintControls);
  function toggleWide() {
    if (onDesk()) { const z = desk.zoomOn(); toast("Width", z ? "the focused panel, in full view" : "all panels", null, null, { at: $("#btn-wide") }); return; }
    const on = root.dataset.wide !== "1";
    on ? (root.dataset.wide = "1") : delete root.dataset.wide;
    store.set("snyvi.wide", on ? "1" : "0");
    $("#btn-wide").classList.toggle("on", on);
  }
  $("#btn-wide").addEventListener("click", control("wide", toggleWide));
  $("#btn-wide").classList.toggle("on", root.dataset.wide === "1");

  function toggleWrap() {
    const on = root.dataset.wrap !== "1";
    on ? (root.dataset.wrap = "1") : delete root.dataset.wrap;
    store.set("snyvi.wrap", on ? "1" : "0");
    $("#btn-wrap").classList.toggle("on", on);
  }
  $("#btn-wrap").addEventListener("click", control("wrap", toggleWrap));
  $("#btn-wrap").classList.toggle("on", root.dataset.wrap === "1");

  // The reading faces, in the order Aa steps through them. "" is Inter.
  const FONTS = [["", "Inter"], ["serif", "Source Serif"], ["literata", "Literata"], ["atkinson", "Atkinson Hyperlegible"], ["mono", "JetBrains Mono"]];
  function paintFontBtn() {
    const f = FONTS.find(([k]) => k === (root.dataset.font || "")) || FONTS[0];
    // On a desk, Aa is the terminal's text size; the face there is always mono.
    if (onDesk()) { const t = desk.textSize(); $("#btn-font").dataset.label = `Text size: ${t.name} · click for ${t.next}`; return; }
    $("#btn-font").dataset.label = `Font: ${f[1]} · click for the next`;
  }
  /** The terminal's text size, said beside Aa: after a click, or ⌃= ⌃- ⌃0 in
   *  a panel. */
  const sayTermSize = () => { paintControls(); toast("Text size", desk.textSize().name, null, null, { face: "glad", at: $("#btn-font") }); };
  $("#btn-font").addEventListener("click", control("font", () => {
    if (onDesk()) { const t = desk.textSize(); desk.textSize(t.at === t.of - 1 ? -(t.of - 1) : 1); sayTermSize(); return; }
    const i = FONTS.findIndex(([k]) => k === (root.dataset.font || ""));
    const [next, name] = FONTS[(i + 1) % FONTS.length];
    next ? (root.dataset.font = next) : delete root.dataset.font;
    store.set("snyvi.font", next);
    paintFontBtn();
    toast("Font", name, null, null, { face: "glad", at: $("#btn-font") });
  }));
  paintFontBtn();
  /* The accent colours, in the order a click steps through them. "" is
   * passion, the default: the red the mark itself wears. They were a popover of eight swatches, which is a
   * menu to read for a setting with no wrong answer: every one of them is
   * simply a colour, and the only way to know which you want is to see it on
   * the page. So the button is the setting now -- one click, the next colour,
   * the whole window in it before the finger is off the mouse -- and the
   * swatch on the button is where you are. snyvi wears the accent too, so the
   * face that says which one it is arrives in that colour. */
  const ACCENTS = [["", "Passion"], ["crimson", "Crimson"], ["rose", "Rose"], ["violet", "Violet"], ["blue", "Blue"], ["teal", "Teal"], ["green", "Green"], ["graphite", "Graphite"]];
  const accBtn = $("#btn-accent");
  const accName = k => (ACCENTS.find(([a]) => a === k) || ACCENTS[0])[1];
  function paintAccent() {
    const i = ACCENTS.findIndex(([k]) => k === (root.dataset.accent || ""));
    accBtn.dataset.label = `Accent: ${accName(ACCENTS[i][0])} · click for ${accName(ACCENTS[(i + 1) % ACCENTS.length][0])}`;
  }
  /* The tab's icon wears the accent too: snyvi's face drawn in the mascot
   * colours the stylesheet resolved, each a plain hex the SVG can hold,
   * which is how boot.js hands a token back. */
  function paintFavicon() {
    const [body, nub, ink] = ["--mascot", "--mascot-nub", "--mascot-ink"].map(v => snyviTheme.colour(v));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect x="14" y="0.5" width="4" height="5" rx="2" fill="${nub}"/><rect x="1" y="4" width="30" height="27" rx="9" fill="${body}"/><ellipse cx="11" cy="16.5" rx="2.6" ry="3.3" fill="${ink}"/><ellipse cx="21" cy="16.5" rx="2.6" ry="3.3" fill="${ink}"/><path d="M13.5 23Q16 25.2 18.5 23" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    const link = $("#favicon");
    if (link) link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function setAccent(k) {
    k ? (root.dataset.accent = k) : delete root.dataset.accent;
    store.set("snyvi.accent", k);
    paintAccent();
    paintFavicon();
    if (mmd) mmd.retheme();
  }
  accBtn.addEventListener("click", () => {
    const i = ACCENTS.findIndex(([k]) => k === (root.dataset.accent || ""));
    const [next, name] = ACCENTS[(i + 1) % ACCENTS.length];
    setAccent(next);
    // The swatch is the same shape in every colour, so the change is quiet
    // where the click was. It flicks once, and snyvi says the name beside it.
    accBtn.classList.remove("flick"); void accBtn.offsetWidth; accBtn.classList.add("flick");
    toast("Accent", name, null, null, { face: "glad", at: accBtn });
  });
  accBtn.addEventListener("animationend", () => accBtn.classList.remove("flick"));
  paintAccent();
  paintFavicon();
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
  /* The card opens at once with its title and foot; its rows of keys ride
   * with the about chunk (ui/about.js) and are put in the first time. */
  function openHelp() { openDialog(help, help.firstElementChild); if (!help.querySelector(".hk")) panel("help"); }
  $("#btn-help").addEventListener("click", openHelp);

  // ---------- the rocket: a game, over the sidebar and nowhere else ----------
  /* A chunk on the desk view's terms: fetched on the first press and never on
   * a page that does not press it. It covers the sidebar column and leaves
   * the page beside it alone, so nothing that arrives while it is up is in
   * its way, and it takes the cover down when the rocket is pressed again. */
  let game = null, gameLoading = null;
  const gameBtn = $("#btn-game");
  gameBtn.addEventListener("click", async () => {
    if (game?.isOpen()) { game.close(); return; }
    try { game = await (gameLoading ||= import(`/assets/game.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { gameLoading = null; toast("Could not start the game", String(e)); return; }
    gameBtn.classList.add("on");
    game.open($("#side"), { back: gameBtn, onClose: () => gameBtn.classList.remove("on") });
  });

  // ---------- about and reset: a chunk, fetched when one is asked for ----------
  /* Neither panel is on the way to reading a document: one says which build
   * is answering, the other empties the library. Both go to the daemon the
   * moment they open anyway, so the module that fills them rides with that
   * press instead of being carried by every first paint. ui/about.js. */
  async function panel(which) {
    let m;
    try { m = await panelMod(); }
    catch (e) { panelLoading = null; toast("Could not open that panel", String(e)); return; }
    m.open(which, { $, openDialog, closeDialog, help, aboutDlg, resetDlg, plural });
  }
  $("#btn-about").addEventListener("click", () => panel("about"));
  $("#btn-reset").addEventListener("click", () => panel("reset"));
  $("#btn-connect").addEventListener("click", () => { closeDialog(help); showConnect(); });

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
  /** A pane folded away (`t`, `\`, or the button at its top) at a width
   *  where it is a column, not a sheet. Remembered, so the one visible way
   *  back is the same button that opens the sheet when the window is
   *  narrow: it stays on screen while the pane is folded, and unfolds it.
   *  Without that a rail put away by a stray `t` was gone for good as far
   *  as the reader could see. */
  const fold = which => { const off = root.dataset[which] !== "0"; root.dataset[which] = off ? "0" : "1"; store.set(`snyvi.${which}`, off ? "0" : "1"); };
  $("#btn-rail").addEventListener("click", e => railNarrow.matches ? toggleSheet("rail", e.currentTarget) : fold("rail"));
  $("#btn-side").addEventListener("click", e => sideNarrow.matches ? toggleSheet("side", e.currentTarget) : fold("side"));
  // The button on the pane itself: puts it away, or, when the pane is a
  // sheet, closes the sheet and gives focus back to what opened it.
  $("#btn-rail-hide").addEventListener("click", () => railNarrow.matches ? closeSheet() : fold("rail"));
  $("#btn-side-hide").addEventListener("click", () => sideNarrow.matches ? closeSheet() : fold("side"));
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

  // ---------- the key mode ----------
  // The single letters sleep until ⌃B wakes them. A viewer sits beside the
  // terminals a reader types into all day, and a `j` or a Del meant for one of
  // them that lands here instead moves the page or deletes the document. So a
  // letter only acts once the reader has said so, and the pill says it is on.
  // It stays on while it is used, and goes off the way attention leaves: Esc,
  // ⌃B again, a click, a field or a panel taking the focus, or ten quiet
  // seconds. Inside a panel ⌃B never gets here -- the panel sends it to the
  // program (tmux's prefix, readline's back-a-character) and stops it.
  // The pill that shows all this, and the listeners that notice a click or
  // the focus leaving, are a chunk (ui/keys.js), fetched on the first ⌃B or
  // the first letter pressed asleep.
  let keysOn = false, keyMode = null, keysLoading = null;
  const useKeys = () => (keysLoading ||= import(`/assets/keys.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (keyMode = m)));
  function keys(on) {
    if (on === keysOn) return;
    keysOn = on;
    document.body.classList.toggle("keys", on);
    if (on) useKeys().then(m => { if (keysOn) m.on(() => keys(false)); }, () => {});
    else keyMode?.off();
  }

  document.addEventListener("keydown", e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyB" && !inField) { e.preventDefault(); keys(!keysOn); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); return; }
    if (e.key === "Escape") {
      // Esc takes down whatever is over the page, one press for all of it;
      // only with nothing over it, and the hand in no field and no panel,
      // does it leave the page, the way its ✕ does.
      const over = keysOn || anyDialogOpen() || !!root.dataset.sheet || !findBar.hidden || !!docEl.querySelector(".mmd[data-full]") || !!document.querySelector("#ctx:not([hidden])");
      keys(false);
      if (mmd) mmd.escape();
      closePalette(); closeDialog(help); closeDialog(aboutDlg); closeDialog(resetDlg); closeSheet(); acts?.shut(); if (!findBar.hidden) { if (find) find.close(); else findBar.hidden = true; }
      if (!over && !inField && !e.target.closest(".pn") && !overEl.hidden) { e.preventDefault(); goBack(); }
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
    // Between the desk and the reading view: a key no shell or TUI wants,
    // so it works from inside a pane as well.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`" && capability) {
      e.preventDefault();
      swapDesk();
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
    if (!keysOn) { if (e.key.length === 1 || e.key === "Delete") useKeys().then(m => m.hint(), () => {}); return; }
    if (browsing() && (e.key === "j" || e.key === "k")) {
      keyMode?.hit();
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
      // A second `c` leaves the comparison: over a desk, the meta's Back button
      // is not drawn, and the key that opened it is the natural way out.
      case "c": if (state.comparing) { state.cache.delete(state.doc.id); showDoc(state.doc.id, false); } else showCompare(); break;
      case "p": togglePin(); break;
      case "s": toggleSplit(); break;
      case "v": togglePreview(); break;
      case "/": openFind(); break;
      // Delete and not Backspace: a key a reader leans on while thinking is
      // not a key to lose a document to.
      case "Delete": deleteCurrent(); break;
      case "n": openNext(); break;
      case "i": showInbox(true); break;
      case "w": control("wide", toggleWide)(); break;
      case "z": control("wrap", toggleWrap)(); break;
      case "t":
        if (railNarrow.matches) { if (!rail.classList.contains("empty")) toggleSheet("rail"); }
        else fold("rail");
        break;
      // The diagram under the cursor, or the last one used: fit it, or fill the
      // screen with it. Both are no-ops on a page with no diagram on it.
      case "0": if (mmd) mmd.key("0"); break;
      case "f": if (mmd) mmd.key("f"); break;
      case "\\":
        if (sideNarrow.matches) toggleSheet("side");
        else fold("side");
        break;
      case "o":
        if (state.doc) window.open(`/api/docs/${state.doc.id}/raw`, "_blank");
        else if (browsing() && state.browsePath) window.open(rawUrl(state.browseRoot.id, state.browsePath), "_blank");
        break;
      case "?": help.hidden ? openHelp() : closeDialog(help); break;
      default: return;
    }
    keyMode?.hit();
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
  else if (state.view === "desk") { history.replaceState({ desk: boot.desk }, "", location.pathname); showDesk(boot.desk, false); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", "/"); }
  connect();
  loadDesks();
})();
