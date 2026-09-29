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
  /** A POST, with a JSON body when there is one. Null is the daemon saying
   *  nothing at all, which a refusal (a Response that is not ok) is not. */
  /** A list the daemon did not send, said where the list goes -- never as the
   *  list being empty -- with a Retry that loads it again (`data-retry`). */
  const noReach = (what, tag = "p") => `<${tag} class="no-reach" role="alert">Could not reach snyvi<button type="button" data-retry="${what}">Retry</button></${tag}>`;
  let treeOff = false, desksOff = false;
  const post = (u, b) => fetch(u, b ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : { method: "POST" }).catch(() => null);
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
   *  rest holds. The whole title is the row's tip, which only a cut row has
   *  (`cut`). */
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
  /** A row's tip, only when its name had to be cut to fit (docs/DESIGN.md
   *  §8.1): the whole name, and when it came. */
  const cut = (d, shown) => shown === String(d.title) ? "" : ` data-tip="${esc(d.title)}" data-tip-sub="${fmt(d.received_at)}${waitingRow(d) ? " · waiting" : ""}"`;

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
  /* The Inbox holds the projects in use -- heard from this week, five to
   * eight of them, and never more than the window has room for with Desks
   * and the Folders head still on screen under it -- and says the rest in one
   * "Show N more" row. Projects are newest first, so the cut is the quiet
   * ones and nothing is re-sorted. The Inbox is then the same height whatever
   * arrives: a new project pushes the oldest into "more", not Desks down the
   * page. Shown, the rest take the row's place and "Show less" ends the list;
   * either stays as it was left until it is clicked again, per reader, as
   * the folds are. */
  let moreOpen = store.get("snyvi.more") === "1";
  /** The projects "more" holds right now, for the mark on it (`markActive`). */
  let moreHidden = new Set();
  /** The cap the last draw used, and whether it made room for the removed row,
   *  so a resize that leaves the cap where it was draws nothing. */
  let capSeen = null, awayRowSeen = false;
  /** The one just put away, while the offer to undo it is still standing. It
   *  keeps the row's place in the tree so the offer is where the click was --
   *  a toast in the far corner asks the eye to leave the sidebar to find out
   *  what the sidebar just did. Cleared by the timer, by the undo, or by the
   *  next one put away, which is the moment the offer stops being about it. */
  let awayJust = null, awayClock = null, awayUndo = null;
  /** The document just removed, while its row still offers Undo: what it was,
   *  where its row stood (`where` "queue" or "proj", and the place in that
   *  list), and the clock. Captured at the click, because the refetch that
   *  follows no longer has the row to say where it was. One at a time. */
  let gone = null;
  /** Whether the ghost can be seen: drawn, and not in a folded sidebar. */
  const inView = g => g.drawn && root.dataset.side !== "0";
  /** A folder just closed, whose ghost holds the Undo (`closeRoot`). */
  let shut = null;
  const applyFolds = () => { for (const k of ["inbox", "desks", "folders"]) treesEl.classList.toggle(`fold-${k}`, folded.has(k)); };
  applyFolds();
  function toggleFold(key) {
    if (!folded.delete(key)) folded.add(key);
    save("snyvi.fold", folded);
    applyFolds();
    const open = !folded.has(key);
    for (const b of treesEl.querySelectorAll(`[data-fold="${key}"]`)) b.setAttribute("aria-expanded", open);
    // A folded Desks leaves the Inbox room for more projects; the reader's
    // click is what moves the page, so the cap follows it at once.
    if (capSeen != null) { renderTree(); markActive(); }
  }
  /** Line icons, drawn at 16px on a 24px grid, stroked with the text. */
  const ICONS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    project: '<path d="M12 3 3 7.5l9 4.5 9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
    // A desk is panels, so it is drawn as four of them; the prompt is kept
    // for a real shell, and a desk no longer looks like one.
    desk: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.8"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.8"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.8"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.8"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/>',
    doc: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M9 13h6M9 16.5h6"/>',
    // One glyph per concept (docs/DESIGN.md §8.3), drawn, never typed: a
    // text ✕ or ✎ is drawn by each OS in its own font, at its own weight.
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    pen: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',
    checks: '<path d="m2.5 12.5 4.5 4.5L16 8M11.5 16l1 1L21.5 8"/>',
    // The desk's own (fill, unfill, plus, play, again) come with desk.js.
    pin: '<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5zM12 13v7.5"/>',
    more: '<circle cx="6" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="18" cy="12" r=".8"/>',
  };
  /** An icon at any size with the same 1.5 px line on screen: the drawings
   *  are on a 24 grid, so the stroke is scaled to the size asked for. */
  const icon = (k, px = 16, cls = "r-ico") => `<svg class="${cls}" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="${+(36 / px).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
  const glyph = (k, px = 12) => icon(k, px, "g-ico");
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
  /** Rows on their way: two bars where the rows will be (docs/DESIGN.md
   *  §7.4), never a bare "…". They wait --sk-wait, so a fast answer shows none. */
  const skRows = `<li class="t-wait"><span class="sk-bar" style="width:62%"></span></li><li class="t-wait"><span class="sk-bar" style="width:44%"></span></li>`;
  function secHead(key, name, tail = "") {
    const open = !folded.has(key);
    return `<div class="s-head" data-sec="${key}"><button type="button" class="s-link" data-fold="${key}" aria-expanded="${open}"><span class="s-nm">${name}</span>${chev}</button>${tail}</div>`;
  }

  /** The browse section keeps its own DOM across navigations so expanded folders stay open.
   *  Its body always ends in a quiet "open a folder" row, so reading a folder is
   *  something the sidebar offers rather than a command a reader has to have heard of. */
  function renderBrowse() {
    const ids = state.browse.map(r => r.id).join(",") + (shut ? `|${shut.r.id}${shut.err || ""}` : "");
    if (browseEl.dataset.ids === ids) return;
    browseEl.dataset.ids = ids;
    const head = secHead("folders", "Folders");
    const rows = state.browse.filter(r => r.id !== shut?.r.id).map(r => {
      const active = state.browseRoot && state.browseRoot.id === r.id;
      return `<details class="b-root" data-root="${r.id}" ${active ? "open" : ""}><summary data-tip="${esc(r.path)}" data-tip-mono>${icon("folder")}<span class="nm">${esc(r.name)}</span>${chev}${plusDesk()}<button class="b-close" data-close="${r.id}" data-tip="Close folder" data-tip-sub="nothing on disk is touched" aria-label="Close folder ${esc(r.name)}">${glyph("x")}</button></summary><ul class="b-tree" data-root="${r.id}" data-path=""></ul></details>`;
    });
    // A folder just closed stands where it was, holding its Undo, as a
    // removed document's row does. A refused Undo says so in it.
    if (shut) rows.splice(Math.min(shut.at, rows.length), 0, `<div class="t-gone"><div class="t-ghost b-ghost" role="status" style="--undo-left:${shut.clock.left()}">${icon("folder")}<span class="title">${esc(shut.err || shut.r.name)}</span>${shut.err ? "" : `<span class="k">closed</span>`}${shut.dead ? "" : `<button type="button" class="t-undo" data-reopen>${shut.err ? "Retry" : "Undo"}</button>`}</div></div>`);
    browseEl.innerHTML = head + `<div class="b-body s-body">` + rows.join("") + `<button type="button" class="b-empty" data-pick>${state.browse.length ? "Open another folder…" : "Open a folder to read"}</button></div>`;
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
    // The document on screen is in a project the reader has folded: the
    // project's row says so, quieter than the row itself would, and the
    // project stays folded until they click it.
    for (const s of treeEl.querySelectorAll(".holds-current")) { s.classList.remove("holds-current"); s.removeAttribute("aria-current"); delete s.dataset.tipSub; }
    let held = null;
    if (!on && state.doc && state.deskBehind == null && state.view !== "desk" && state.view !== "inbox") {
      held = treeEl.querySelector(`.t-proj[data-pid="${state.doc.project_id}"]:not([open]) > summary`) ||
        // Past the cap, "more" is the row that holds it, and it stays shut.
        (moreHidden.has(String(state.doc.project_id)) && !moreOpen ? treeEl.querySelector(".t-quiet") : null);
      if (held) { held.classList.add("holds-current"); held.setAttribute("aria-current", "location"); held.dataset.tipSub = `${state.doc.title || "the open document"} is in here · click to show it`; }
    }
    // Brought into the sidebar's view only when it is out of it, and only as
    // far as it takes: moved by hand, since WebKitGTK may decline to scroll.
    const mark = on && treeEl.contains(on) ? on : held;
    if (mark && mark !== lastMark) {
      const port = treesEl.getBoundingClientRect(), box = mark.getBoundingClientRect();
      // The section's head stands over the top of the column (sticky), so a
      // row under it is not in view either.
      const top = port.top + (treeEl.contains(mark) ? inboxRowEl.offsetHeight : 26);
      if (box.height && (box.top < top || box.bottom > port.bottom)) treesEl.scrollTop += box.top < top ? box.top - top - 8 : box.bottom - port.bottom + 8;
    }
    lastMark = mark;
  }
  let lastMark = null;

  /** Both names are guesses — a directory name and a session's first document — so
   *  each carries the means to correct it, shown when the row is under the cursor. */
  const renameBtn = (what, id) =>
    `<button class="ren" data-rename="${what}" data-id="${id}" data-tip="Rename" data-key="F2" aria-label="Rename ${what}">${glyph("pen")}</button>`;

  /** The ✕ on a project's row: the same glyph a folder's row carries, meaning
   *  the same thing -- this list stops showing it. Nothing on disk or in the
   *  library changes; the ghost row it leaves behind holds the Undo, and the
   *  row under the tree is the way back after that. */
  const awayBtn = p =>
    `<button type="button" class="row-x" data-away="${p.id}" data-tip="Remove from the sidebar" data-tip-sub="the documents stay" aria-label="Remove ${esc(p.name)} from the sidebar">${glyph("x")}</button>`;
  /** A project's desk, from its row: the glyph stays lit while the project
   *  has one and goes to it, and waits for the pointer, as a folder's does,
   *  while it has none. The Inbox's project and the desk on its folder are
   *  the same project, and this is where the sidebar says so. */
  /** The desk's live state on its project's row, in the Desks rows' colours:
   *  a panel running, or one waiting on the reader. Idle says nothing. */
  const deskState = d => { const m = mark3(d.panes); return m === "!" ? " blk" : m === "●" ? " on" : ""; };
  /** One folder however it was spelled: a trailing slash is not another place. */
  const sameRoot = (a, b) => !!a && !!b && a.replace(/(.)\/+$/, "$1") === b.replace(/(.)\/+$/, "$1");
  const projDeskBtn = p => {
    if (!capability || !p.root) return "";
    const d = state.desks && state.desks.desks.find(x => sameRoot(x.root, p.root));
    return d ? `<button type="button" class="b-new has${deskState(d)}" data-projdesk="${p.id}" data-deskof="${d.id}" data-tip="Show its desk" aria-label="Show desk ${esc(d.name)}">${icon("desk", 14)}</button>`
      : `<button type="button" class="b-new" data-projdesk="${p.id}" data-tip="New desk" aria-label="New desk for ${esc(p.name)}">${icon("desk", 14)}</button>`;
  };

  /** A project is drawn expanded when the reader left it that way, or when it
   *  is the only one there is. Only the reader's own click unfolds one: a
   *  document opened from anywhere else -- the waiting bar, n, the Inbox,
   *  Ctrl K -- marks its folded project (`markActive`) and moves nothing. */
  const projOpen = p => openProjects.has(String(p.id)) || state.tree.length === 1 ||
    // The document on screen was removed and the page went to the inbox: its
    // project stays open while its row offers Undo.
    (gone && gone.where === "proj" && gone.pid === String(p.id));

  const docRow = d => {
    noteKnown(d);
    const ago = relShort(d.received_at);
    // Not "active": markActive puts that on, so the rows a reader moves between
    // draw the same and a move between two of them costs no redraw.
    const cls = waitingRow(d) ? "new" : "";
    return `<li class="t-doc${washCls(d.id)}"${moment(d.id)}><a href="/d/${d.id}" class="${cls}" data-id="${d.id}"${cut(d, mid(d.title, roomFor(ago)))}>${docIco()}<span class="title">${esc(mid(d.title, roomFor(ago)))}</span>${d.pinned ? `<span class="pin" data-tip="Pinned" data-tip-sub="kept by prune">${glyph("pin", 11)}</span>` : ""}<span class="k">${ago}</span>${removeBtn(d)}</a></li>`;
  };
  /** The ✕ on a document's row takes it out of the inbox. It is said as a
   *  removal because that is what it is: the daemon keeps the document, and
   *  the row stands where it was for UNDO_MS with the Undo in it. */
  function removeBtn(d) {
    return `<button type="button" class="row-x" data-deldoc="${d.id}" data-tip="Remove" data-key="del" data-tip-sub="nothing is deleted" aria-label="Remove ${esc(d.title)}">${glyph("x")}</button>`;
  }
  /** The row a removed document leaves behind, at its height and in its
   *  place, so nothing below it moves while the offer stands. The bar along
   *  its foot is the time left; resting on it stops the clock. `--t` starts
   *  both where the last draw left them, as `moment` does for a wash. */
  function ghostRow() {
    const g = gone;
    g.drawn = true;
    const t = Date.now() - (g.closing || g.made);
    // A refused Undo says so in the row and holds its clock: the button is
    // its Retry. Pruned, there is nothing to retry, and the row just closes.
    return `<li class="t-doc t-gone${g.closing ? " leaving" : ""}${g.back || g.err ? " back" : ""}" style="--t:-${t}ms"><div class="t-ghost" role="status" style="--undo-left:${g.clock.left()}">${docIco()}<span class="title"${g.err ? ` data-tip="${esc(g.d.title)}"` : ""}>${esc(g.err || g.d.title)}</span>${g.err ? "" : `<span class="k">removed${g.versions > 1 ? ` · ${g.versions} versions` : ""}</span>`}${g.dead ? "" : `<button type="button" class="t-undo" data-undoc>${g.err ? "Retry" : "Undo"}</button>`}</div></li>`;
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
  const queueRow = (d, extra = "") => (noteKnown(d), `<li class="t-doc${extra}"${moment(d.id)}><a href="/d/${d.id}" class="new" data-id="${d.id}" data-tip="${esc(d.title)}" data-tip-sub="${esc(d.project)} · ${fmt(d.received_at)}" data-tip-overflow>${docIco()}<span class="title" data-tip-cut>${esc(d.title)}</span><span class="k">${esc(d.project)}</span>${removeBtn(d)}</a></li>`);

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
  let qbGhost = null;   // Mark all read, answered by the bar itself: { n, undo, clock }
  let qbWas = 0, qbSettle = 0, waitedWas = 0;   // the bar's count last drawn, the face's way back to rest, and the count last seen
  // The bar's ✕ hides it, read nothing, until the next arrival.
  let arrivals = 0, qbShut = -1;
  /** The quiet switch (docs/DESIGN.md §2.5): faces at rest, nothing moving. */
  const quiet = () => root.dataset.mascot === "quiet";
  /** The switch itself, from ⌘K and the mark's menu; boot.js puts it back. */
  function toggleQuiet() {
    const on = !quiet();
    on ? (root.dataset.mascot = "quiet") : delete root.dataset.mascot;
    store.set("snyvi.mascot", on ? "quiet" : "");
  }
  function renderQueue() {
    queueIds = new Set(state.queue.map(d => d.id));
    // What has finished moving is dropped here, at the render, and not only
    // at the sweep: a sweep is put off by every arrival, and a row that had
    // closed was otherwise drawn again, closed, until one ran.
    const now = Date.now();
    for (const [id, t] of washes) if (now - t >= WASH_MS) washes.delete(id);
    for (const [id, l] of leaving) if (now - l.when >= LEAVE_MS) leaving.delete(id);
    const n = state.waiting, head = state.queue[0], shown = Math.min(n, QUEUE_ROWS);
    badge('[data-pop="inbox"]', n);
    // The last one waiting was read: the one moment snyvi shows love, on the
    // mark, for as long as a face's moment lasts (§2.2).
    if (!n && waitedWas && !quiet()) { root.dataset.cleared = "1"; setTimeout(() => delete root.dataset.cleared, 2400); }
    waitedWas = n;
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
    const onRow = queueEl.contains(document.activeElement) && document.activeElement.dataset.id;
    queueEl.innerHTML = empty ? "" : `<div class="t-queue${!n && !ghost && !(held && !gone.closing) ? " leaving" : ""}"><div class="t-label">Waiting<span class="n">${n}</span></div><ul>` +
      rows.join("") +
      (n > shown ? `<li class="t-more"><a href="/inbox" data-nav="inbox">${n - shown} more</a></li>` : "") + `</ul></div>`;
    // A keyboard on a row stays on it, as it does in the tree.
    if (onRow) queueEl.querySelector(`a[data-id="${CSS.escape(onRow)}"]`)?.focus({ preventScroll: true });
    lastQueue = state.queue.slice(0, QUEUE_ROWS);
    // Marked read from the bar: the bar says so and holds the Undo, in the
    // same card at the same place, until the drain runs out (DESIGN §4.4).
    if (qbGhost && state.view !== "inbox") {
      queueBar.hidden = false;
      if (!queueBar.querySelector(".qb.ghost")) queueBar.innerHTML = `<div class="qb ghost" role="status" style="--undo-left:${qbGhost.clock.left()}"><span class="qb-next">Marked ${qbGhost.n} read</span><button type="button" class="t-undo" data-q="undo">Undo<kbd>${esc(keyHint("mod+z"))}</kbd></button></div>`;
      qbWas = 0;
      return;
    }
    const bar = n > 0 && !!head && state.view !== "inbox" && qbShut !== arrivals;
    queueBar.hidden = !bar;
    if (!bar) { queueBar.innerHTML = ""; qbWas = 0; return; }
    // The bar rises when it appears and stays put after: a count that changes
    // ticks in place. It used to be rebuilt on every render, which re-ran the
    // rise for one more arrival, and twelve arrivals rose twelve times.
    const count = `${n} waiting`, next = `<b>${esc(head.title)}</b> · ${esc(head.project)}`;
    // The bar, not the Marked-read ghost that stood in its place: a ghost
    // found here was taken for the bar, lost its words to the next title and
    // threw on its missing count -- inside the Undo, before it could ask.
    const qb = queueBar.querySelector(".qb:not(.ghost)");
    // The bar is snyvi holding what came for the reader, so it is snyvi's
    // face at the front of it: the same head that answers a click, at the
    // top of the page. It arrives wide-eyed and settles into a smile.
    if (!qb) {
      queueBar.innerHTML = `<div class="qb"><span class="qb-who"></span><span class="qb-n">${count}</span><span class="qb-next">${next}</span>` +
        `<button type="button" data-q="next" data-tip="Open the next one waiting" data-tip-sub="letter keys: Ctrl B turns them on">Open<kbd>n</kbd></button><a href="/inbox" class="qb-all" data-nav="inbox">Show all</a>` +
        `<button type="button" class="icon" data-q="clear" data-tip="Mark all read" aria-label="Mark all read">${glyph("checks", 14)}</button>` +
        `<button type="button" class="icon" data-q="shut" data-tip="Hide this bar" data-tip-sub="they stay waiting in the sidebar" aria-label="Hide this bar">${glyph("x", 14)}</button></div>`;
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
      // One more is a surprise; one fewer is a read, which happens tens of
      // times a day and moves nothing (docs/DESIGN.md §7.2).
      if (n > qbWas) qbFeel("whoa");
    }
    qbWas = n;
  }
  /** The face on the bar: `feel` for the moment, then plain -- the face at
   *  rest holding the count is a smile, not a stare. The moment is a fresh
   *  node, so the same feeling twice running lands twice. */
  function qbFeel(feel) {
    const who = queueBar.querySelector(".qb-who");
    if (!who || quiet()) return;
    clearTimeout(qbSettle);
    const fresh = who.cloneNode(false);
    fresh.dataset.feel = feel;
    fresh.innerHTML = mascotHead(feel);
    who.replaceWith(fresh);
    qbSettle = setTimeout(() => {
      const w = queueBar.querySelector(".qb-who");
      if (w) { delete w.dataset.feel; w.innerHTML = mascotHead("rest"); }
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
    if (!d) { toast("Nothing waiting", { sub: "every document that arrived has been opened" }); return; }
    showDoc(d.id, true);
  }

  /** Everything waiting, read without being opened: for the day an agent
   *  sent thirty and the reader wants the sidebar back. */
  async function clearQueue() {
    const n = state.waiting;
    if (!n) return;
    // Where the bar stood, before the redraw takes it: the Undo goes there.
    const at = rectOf(actedAt()), inBar = !queueBar.hidden && !!queueBar.querySelector(".qb:not(.ghost)");
    const r = await post("/api/queue/clear");
    const j = r?.ok && await r.json();
    if (!j) return toast("Could not mark them read", { retry: clearQueue });
    depart(state.queue.map(d => d.id));
    state.queue = []; state.waiting = 0;
    unmarkRows(null);
    renderTree(); markActive();
    if (state.view === "inbox") showInbox(false);
    // The rows come back on the daemon's "restored", in every tab.
    let endGhost = () => {};
    const undo = async () => {
      unoffer(undo);
      endGhost();
      if (!(await post("/api/queue/unread", { ids: j.ids }))?.ok) toast("Could not bring them back", { retry: undo });
    };
    // From the bar, the bar answers; from the Inbox page, which has no bar,
    // the answer stands where the button was.
    if (inBar) {
      qbGhost?.clock.stop();
      const g = qbGhost = { n, undo, clock: undoClock("#queue-bar .qb.ghost", () => endGhost()) };
      endGhost = () => { if (qbGhost !== g) return; g.clock.stop(); qbGhost = null; unoffer(undo); renderQueue(); };
      offer(undo, endGhost);
      renderQueue();
      return;
    }
    offer(undo, null);
    toast(`Marked ${n} read`, { action: { label: "Undo", run: undo }, at });
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
    const rt = e.target.closest("[data-retry]");
    if (rt) {
      e.preventDefault(); e.stopPropagation();
      const w = rt.dataset.retry;
      if (w === "dir") fillTree(rt.closest(".b-tree")); else if (w === "inbox") showInbox(false); else if (w === "home") showHome(false); else if (w === "tree") refreshTree(); else if (w === "desks") loadDesks();
      return;
    }
    const b = e.target.closest("[data-q]");
    if (!b) return;
    e.preventDefault();
    if (b.dataset.q === "next") openNext();
    else if (b.dataset.q === "clear") clearQueue();
    else if (b.dataset.q === "undo") qbGhost?.undo();
    else if (b.dataset.q === "shut") { qbShut = arrivals; renderQueue(); }
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
  const wholeWf = w => liftedWorkflows.has(w.id);
  /** The document on screen, when it is in `w` and past the session's cap:
   *  its own row rides under the capped ones, so the mark has a row to be on
   *  without the whole session unfolding around it. */
  const pastCap = (w, docs) => state.doc && state.deskBehind == null && state.doc.workflow_id === w.id && !docs.some(d => d.id === state.doc.id)
    ? w.docs.find(d => d.id === state.doc.id) : null;
  function projectRows(p) {
    const pid = String(p.id);
    let wfs = state.sub.get(pid);
    if (!wfs) return skRows;
    const allWfs = liftedCaps.has(pid);
    // A removed document's row stands in its session until the offer goes.
    // Its session may have gone with it, when it was the only document there:
    // then the row stands alone where the session was.
    const g = gone && gone.where === "proj" && gone.pid === pid ? gone : null;
    // And the sessions keep the order they were drawn in: a session that lost
    // its newest document can sort below another, and move the Undo with it.
    // One that came since goes on top, where it would have anyway.
    let fresh = 0;
    if (g && g.order) {
      const was = new Map(g.order.map((id, i) => [id, i]));
      const kept = wfs.filter(w => was.has(w.id)).sort((a, b) => was.get(a.id) - was.get(b.id));
      fresh = wfs.length - kept.length;
      wfs = [...wfs.filter(w => !was.has(w.id)), ...kept];
    }
    const lostWf = g && !wfs.some(w => w.id === g.wf), lostAt = g ? g.wfAt + fresh : -1;
    const lone = () => `<li class="t-wf solo"><ul>${ghostRow()}</ul></li>`;
    let h = "", shownWfs = 0, rows = 0;
    for (const [wi, w] of wfs.entries()) {
      if (lostWf && wi === lostAt) h += lone();
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
      h += `<li class="t-wf${solo ? " solo" : ""}">${solo ? "" : `<div class="wf-name" data-tip="${esc(w.key)}" data-tip-mono><span class="nm">${esc(w.title)}</span>${renameBtn("workflow", w.id)}</div>`}<ul>`;
      const extra = pastCap(w, docs), drawn = (extra ? [...docs, extra] : docs).map(docRow);
      if (ghostHere) drawn.splice(Math.min(g.at, drawn.length), 0, ghostRow());
      h += drawn.join("");
      rows += docs.length;
      if (w.total > docs.length) h += `<li class="t-more"><button type="button" data-more-docs="${w.id}">${w.total - docs.length} more</button></li>`;
      else if (liftedWorkflows.has(w.id) && w.total > SHOW_DOCS) h += `<li class="t-more"><button type="button" data-less-docs="${w.id}">less</button></li>`;
      h += `</ul></li>`;
    }
    if (lostWf && lostAt >= wfs.length) h += lone();
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
  /** How many projects the Inbox shows before its "more" row: the ones heard
   *  from this week, between USED_MIN and USED_MAX, and no more than fit
   *  between what stands above the projects (the head, All documents, the
   *  waiting list) and what must stay on screen below them (all of Desks,
   *  and the Folders head). Measured, because each of those changes it;
   *  never fewer than three. The whole list while the Inbox is folded or the
   *  sidebar is its rail, where there is no column to fit. */
  const ROW_H = 28, MIN_CAP = 3, QUIET_S = 7 * 86400, USED_MIN = 5, USED_MAX = 8;
  function inboxCap(awayRow) {
    const room = treesEl.clientHeight;
    if (!room || root.dataset.side === "0" || folded.has("inbox")) return Infinity;
    const now = Date.now() / 1000;
    const used = Math.min(USED_MAX, Math.max(USED_MIN, state.tree.filter(p => p.latest && now - p.latest <= QUIET_S).length));
    const port = treesEl.getBoundingClientRect(), at = treeEl.getBoundingClientRect(), fh = browseEl.querySelector(".s-head");
    const above = at.top - port.top + treesEl.scrollTop;
    const below = fh ? fh.getBoundingClientRect().bottom - at.bottom : 0;
    // 8: #trees' own padding at the foot; the "more" row; the removed row.
    const left = room - above - below - 8 - ROW_H - (awayRow ? 26 : 0);
    return Math.min(used, Math.max(MIN_CAP, Math.floor(left / ROW_H)));
  }
  /** The row that holds the projects past the cap. It says how many, and how
   *  long they have been quiet -- or, when one has something waiting, that.
   *  Shown, it is "Show less", at the end of what it let out. */
  function moreRow(hidden) {
    if (moreOpen) return `<button type="button" class="t-quiet" data-quiet aria-expanded="true">${icon("more")}<span class="nm">Show less</span>${chev}</button>`;
    const waiting = state.queue.filter(d => moreHidden.has(String(d.project_id))).length;
    const q = hidden[0].latest ? relShort(hidden[0].latest) : "";
    const say = waiting ? `${waiting} waiting` : !q || q === "now" ? "" : /^\d/.test(q) ? `quiet ${q}` : `quiet since ${q}`;
    const names = hidden.slice(0, 8).map(p => p.name).join(", ") + (hidden.length > 8 ? ` and ${hidden.length - 8} more` : "");
    return `<button type="button" class="t-quiet${waiting ? " new" : ""}" data-quiet aria-expanded="${moreOpen}" data-tip="${esc(names)}">${icon("more")}<span class="nm">Show ${hidden.length} more</span>${chev}${say ? `<span class="k">${say}</span>` : ""}</button>`;
  }
  function renderTree() {
    const projects = heldTree();
    const total = state.tree.reduce((n, p) => n + p.docs, 0);
    // A link, so the keyboard reaches it: a div with a click handler is a row
    // Tab walks straight past.
    inboxRowEl.innerHTML = secHead("inbox", "Inbox") +
      `<a class="t-inbox s-row" href="/inbox" data-nav="inbox">${icon("inbox")}<span class="title">All documents</span><span class="n">${total}</span></a>`;
    renderQueue();
    renderBrowse();
    renderDesks();
    if (!projects.length) {
      treeEl.innerHTML = treeOff ? noReach("tree") : state.browse.length ? "" : `<div class="t-empty">What your agents write lands here, filed by project.</div>`;
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
    let h = treeOff ? noReach("tree") : "";
    const waitingIn = new Set(state.queue.map(d => String(d.project_id)));
    const drawn = projects.filter(p => !away.has(String(p.id)) || awayJust === String(p.id));
    const put = projects.length - drawn.length;
    const row = p => {
      // In its own place, at its own height, so nothing below it moves while
      // the offer stands and nothing moves again when it is taken.
      if (awayJust === String(p.id)) return `<div class="t-back" role="status" style="--undo-left:${awayClock?.left() ?? 1}"><span class="nm">${esc(p.name)} removed</span><button type="button" class="t-undo" data-back="${p.id}">Undo</button></div>`;
      const open = projOpen(p);
      // The one held for a ghost closes with it.
      const out = gone && gone.closing && gone.proj === p && !state.tree.includes(p);
      // A week with nothing from it steps the name back; something waiting
      // in it lights the icon, as a waiting row's does. Colour only.
      const quiet = p.latest && Date.now() / 1000 - p.latest > QUIET_S ? " quiet" : "", lit = waitingIn.has(String(p.id)) ? " new" : "";
      return `<details class="t-proj${out ? " leaving" : ""}${quiet}" data-pid="${p.id}" ${open ? "open" : ""}><summary class="${lit.trim()}" data-tip="${esc(p.root)}" data-tip-mono>${icon("project")}<span class="nm">${esc(p.name)}</span>${chev}${projDeskBtn(p)}${awayBtn(p)}</summary><ul>` +
        (open ? projectRows(p) : "") + `</ul></details>`;
    };
    // Past the cap, "more" holds what the reader is not using. A project they
    // have open, or whose row is offering an Undo, stays in view under it: a
    // row never goes away from under a reading. One project past the cap is
    // drawn rather than said, since "1 more" would take the same room.
    awayRowSeen = put > 0;
    const cap = capSeen = inboxCap(awayRowSeen);
    const upto = drawn.length > cap + 1 ? cap : drawn.length;
    const past = drawn.slice(upto);
    const hidden = past.filter(p => !projOpen(p) && awayJust !== String(p.id) && !(gone && gone.proj === p));
    moreHidden = new Set(hidden.map(p => String(p.id)));
    for (const p of drawn.slice(0, upto)) h += row(p);
    if (hidden.length && !moreOpen) h += moreRow(hidden);
    for (const p of past) if (moreOpen || !moreHidden.has(String(p.id))) h += row(p);
    if (hidden.length && moreOpen) h += moreRow(hidden);
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
      // A keyboard on a ghost's Undo, or on a row, stays on it through the redraw.
      const a = document.activeElement, onUndo = a?.matches(".t-gone .t-undo"), onRow = treeEl.contains(a) && a.dataset.id;
      treeEl.innerHTML = h;
      if (onUndo) toUndo();
      else if (onRow) treeEl.querySelector(`a[data-id="${CSS.escape(onRow)}"]`)?.focus({ preventScroll: true });
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

  /* The cap follows the room: the window's height, the waiting list growing
   * or going, a desk made or closed. Only a change in the cap draws the tree,
   * and what changes then is which quiet projects "more" holds -- Desks stays
   * where it was, which is the point of the cap. */
  try {
    let queued = false;
    const recap = () => { queued = false; if (capSeen != null && inboxCap(awayRowSeen) !== capSeen) { renderTree(); markActive(); } };
    const watch = new ResizeObserver(() => { if (!queued) { queued = true; requestAnimationFrame(recap); } });
    for (const el of [treesEl, inboxRowEl, queueEl, $("#desk-nav")]) watch.observe(el);
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
    const r = await fetch("/api/tree").catch(() => null), j = r?.ok && await r.json().catch(() => null);
    treeOff = !Array.isArray(j);
    if (!treeOff) state.tree = j;
    const pids = only != null ? [String(only)] : [...state.sub.keys()];
    await Promise.all(pids.filter(pid => state.sub.has(pid)).map(pid => fillProject(pid, true)));
    renderTree();
    markActive();
  }

  const entryHtml = (rootId, e) => e.dir
    ? `<li class="b-dir"><details data-root="${rootId}" data-path="${esc(e.path)}"><summary>${icon("folder", 14)}<span class="nm">${esc(e.name)}</span>${chev}${plusDesk()}</summary><ul class="b-tree" data-root="${rootId}" data-path="${esc(e.path)}"></ul></details></li>`
    : `<li class="b-file"><a href="/b/${rootId}/${e.path}" data-browse="${rootId}" data-path="${esc(e.path)}" data-tip="${esc(e.path)}" data-tip-mono>${docIco()}<span class="title">${esc(e.name)}</span><span class="k">${fmtSize(e.size)}</span></a></li>`;

  /** Fetch one directory level the first time its folder is opened. */
  async function fillTree(ul) {
    if (!ul || ul.dataset.loaded) return;
    ul.dataset.loaded = "1";
    ul.innerHTML = skRows;
    const rootId = ul.dataset.root, path = ul.dataset.path || "";
    let entries;
    try { entries = await (await fetch(`/api/browse/${rootId}/tree?path=${encodeURIComponent(path)}`)).json(); } catch {}
    if (!Array.isArray(entries)) { ul.dataset.loaded = ""; ul.innerHTML = noReach("dir", "li"); return; }
    if (!entries.length) { ul.innerHTML = `<li class="b-empty">No files here</li>`; return; }
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
    if (!nodes.length) { ul.innerHTML = `<li class="b-empty">No files here</li>`; return; }
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
      // In a folder's row, a desk on that folder; in the Desks head, the
      // question of where.
      const f = folderOf(nd);
      // With no project known yet the only real answer is a folder: the
      // dialog, at once, rather than a menu of one row.
      if (f) act("make", f); else if (capability && !deskPlaces().length) act("pick", true); else askWhere(nd, e.detail === 0);
      return;
    }
    const pd = e.target.closest("[data-projdesk]");
    if (pd) {
      e.preventDefault(); e.stopPropagation();
      act("projectDesk", +pd.dataset.projdesk);
      return;
    }
    const dx = e.target.closest("[data-deldoc]");
    if (dx) {
      // Inside the document's link: a click on the ✕ is not a click on the row.
      e.preventDefault(); e.stopPropagation();
      const id = dx.dataset.deldoc, proj = dx.closest(".t-proj");
      const d = state.queue.find(x => x.id === id) || { id, title: dx.closest("a").querySelector(".title").textContent, project_id: proj ? +proj.dataset.pid : null };
      deleteDoc(d, dx, !e.detail);
      return;
    }
    if (e.target.closest("[data-reopen]")) {
      e.preventDefault(); e.stopPropagation();
      if (shut && Date.now() - shut.made > 350) shut.undo();
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
    if (e.target.closest("[data-quiet]")) {
      e.preventDefault();
      moreOpen = !moreOpen;
      store.set("snyvi.more", moreOpen ? "1" : "0");
      const kb = document.activeElement?.matches("[data-quiet]");
      renderTree(); markActive();
      // The row moved to the other end of the list: a keyboard goes with it.
      if (kb) treeEl.querySelector("[data-quiet]")?.focus({ preventScroll: true });
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

  /** A folder off the Folders list: the ✕ on its row, its menu's Close
   *  folder, the meta pane's. Nothing on disk is touched. The daemon is
   *  asked first, and a no is said beside the ✕ with a Retry; a yes leaves
   *  the row's ghost with the Undo, which the daemon's reopen takes back. */
  async function closeRoot(id) {
    const at = state.browse.findIndex(r => r.id === id), r = state.browse[at];
    if (!r) return;
    if (!(await post(`/api/browse/${id}/close`))?.ok) return toast(`Could not close ${r.name}`, { retry: () => closeRoot(id) });
    shutSettle();
    const s = shut = { r, at, made: Date.now(), clock: undoClock("#browse-nav .b-ghost", () => shutSettle()) };
    offer(s.undo = () => reopenRoot(s), shutSettle);
    state.browse = state.browse.filter(x => x.id !== id);
    if (state.browseRoot && state.browseRoot.id === id) showInbox(true); else { renderTree(); markActive(); }
  }
  async function reopenRoot(s) {
    if (shut !== s || s.asking) return;
    s.clock.hold = true;
    unoffer(s.undo);
    s.asking = true;
    const r = await post(`/api/browse/${s.r.id}/reopen`);
    s.asking = false;
    if (shut !== s) return;
    if (!r?.ok) {
      // Gone (410): the folder is not there to reopen, and the row closes.
      s.dead = r?.status === 410;
      s.err = s.dead ? "Could not reopen it · it is gone" : "Could not reopen it";
      if (s.dead) { s.clock.hold = false; s.clock.again(); } else offer(s.undo, shutSettle);
      return renderBrowse();
    }
    shut = null; s.clock.stop();
    if (!state.browse.some(x => x.id === s.r.id)) state.browse.splice(s.at, 0, s.r);
    renderBrowse();
  }
  function shutSettle() {
    if (!shut) return;
    shut.clock.stop();
    unoffer(shut.undo);
    shut = null;
    renderBrowse();
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
  const order = () => {
    const drawn = [...treeEl.querySelectorAll("a[data-id]")].map(a => a.dataset.id);
    // The document on screen is in a folded project, so its row is not drawn:
    // j and k step through that project's documents as the page holds them.
    if (!state.doc || drawn.includes(state.doc.id)) return drawn;
    const wfs = state.sub.get(String(state.doc.project_id));
    return wfs ? wfs.flatMap(w => w.docs.map(d => d.id)) : drawn;
  };
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
  /** Remember the choice per file, and start a PDF in the viewer since its source is bytes.
   *  A page an agent sent (`d:`) opens as the page, since that is what it was
   *  made to be seen as; one browsed in Folders (`b:`) opens as its source,
   *  since there the reader is reading code. Either is one click from the other. */
  function setPreview(kind, url, key) {
    if (state.previewKey !== key) { state.previewKey = key; state.previewOn = kind === "pdf" || (kind === "html" && key.startsWith("d:")); }
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
  /** A page coming in: opening documents is done a hundred times a day, so
   *  it is an 80 ms fade and no movement, and nothing at all when a key did
   *  it -- the keyboard's result is simply there (docs/DESIGN.md §7.2). */
  function swapIn() {
    if (swapAnim) swapAnim.cancel();
    const byKey = keyAt > (press?.t ?? -1e9);
    swapAnim = still.matches || byKey ? null : docEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, easing: "ease-out" });
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
      try { j = await fetchDoc(id); } catch (e) { if (turn === opening) { state.opening = null; toast("Could not open document", { sub: e }); } return; }
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
    const was = !fromHistory && !location.hash && places()[placeKey(j.doc)];
    if (fromHistory && kept("id", id)) placeAt(history.state.place);
    else if (was && !was.end && was.i >= 0) placeAt(was);
    else main.scrollTo({ top: 0, behavior: "instant" });
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
    if (!reading) return;
    const place = placeOf();
    history.replaceState({ ...(history.state || {}), place }, "", location.pathname + location.hash);
    if (state.view === "doc") keepPlace(state.doc, place);
  }
  /* Where each document was left, kept past this page: every way of opening
   * one -- the tree, the queue, n, Home, Ctrl K, a restart -- goes back
   * there, not only Back. By its file, so a new version keeps the place while
   * that block is still there; the newest 200, in this viewer's storage,
   * since a reading position is theirs. Read to the end, it opens at the top. */
  const placeKey = d => d.source_path ? `${d.project_id}:${d.source_path}` : d.id;
  const places = () => { try { return JSON.parse(localStorage.getItem("snyvi.place") || "{}"); } catch { return {}; } };
  function keepPlace(d, p) {
    const m = places(), end = main.scrollTop + main.clientHeight >= main.scrollHeight - 40;
    m[placeKey(d)] = end || p.top < 40 ? { at: Date.now(), end: true } : { ...p, at: Date.now() };
    const ks = Object.keys(m);
    if (ks.length > 200) ks.sort((a, b) => m[a].at - m[b].at).slice(0, ks.length - 200).forEach(k => delete m[k]);
    try { localStorage.setItem("snyvi.place", JSON.stringify(m)); } catch {}
  }
  let leaveTimer = 0;
  main.addEventListener("scroll", () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(leave, 400); }, { passive: true });
  // The head's foot is ruled only while there is text under it (app.css, #chrome).
  main.addEventListener("scroll", () => main.classList.toggle("scrolled", main.scrollTop > 0), { passive: true });

  /** Whether the entry history landed on is the page asked for, with a place
   *  in it. Only a move through history asks: a re-render of the same page --
   *  a preview toggled, a split view -- starts at the top as it always did. */
  const kept = (key, value) => !!(history.state && history.state[key] === value && history.state.place);

  /* A folder's page, and a file read from disk, are ui/browse.js's:
   * fetched the first time one is opened, since most readers read what their
   * agents sent. The rows in the sidebar's Folders are this file's. */
  let browseMod = null, browseLoading = null;
  const browseUse = () => (browseLoading ||= import(`/assets/browse.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (browseMod = m), e => { browseLoading = null; throw e; }));
  const browseCtx = () => ({ state, docEl, metaEl, main, esc, rel, fmtSize, toast, leave, offDesk, setPreview, swapIn, applyPreview, afterRender, afterRefresh,
    placeAt, placeOf, kept, cameFrom, jumpToHash, lineHash, browsing, previewButton, rawUrl });
  function showBrowse(rootId, path, push = true, fromHistory = false) {
    return browseUse().then(m => m.show(browseCtx(), rootId, path, push, fromHistory), e => toast("Could not open the folder", { sub: e }));
  }

  async function showInbox(push = true) {
    if (push) leave();
    offDesk();
    state.view = "inbox"; state.doc = null; state.previous = null; state.browseRoot = null;
    const hm = homeUse().catch(() => null);
    let items = boot.inbox;
    if (!items || push) {
      const r = await fetch("/api/inbox?limit=60").catch(() => null);
      items = r?.ok ? await r.json().catch(() => null) : null;
    }
    boot.inbox = null; boot.agents = null;
    // Nothing to read, and no desk yet: the page is Welcome -- which project
    // first -- at the inbox's own address. A window that has desks and no
    // documents yet says where they will land. Nothing *said* is not
    // nothing there: that is its own line, never Welcome.
    let welcomeHtml = items ? null : `<div class="inbox-head"><h1>Inbox</h1>${noReach("inbox")}</div>`;
    if (items && !items.length) {
      if (capability && !state.desks) await loadDesks();
      if (!capability || !(state.desks && state.desks.desks.length)) welcomeHtml = await welcomePage();
    }
    document.title = "snyvi";
    if (push) history.pushState({ inbox: true }, "", "/inbox");
    const m = welcomeHtml == null && await hm;
    if (state.view !== "inbox") return;
    if (welcomeHtml == null && !m) { homeLoading = null; welcomeHtml = `<div class="inbox-head"><h1>Inbox</h1>${noReach("inbox")}</div>`; }
    docEl.innerHTML = welcomeHtml != null ? welcomeHtml : inboxHtml(items, m);
    if (push) swapIn();
    afterRender();
    if (items?.length) removedLine(push);
    // The inbox lists every waiting row, and the page opened with the oldest
    // few: the rest come after the page is on screen, not before the sidebar is.
    if (items && state.waiting > state.queue.length) {
      try {
        const q = await (await fetch("/api/queue")).json();
        if (Array.isArray(q) && state.view === "inbox" && homeMod) { state.queue = q; docEl.innerHTML = inboxHtml(items, homeMod); renderTree(); markActive(); }
      } catch {}
    }
  }

  /** The Inbox's list is home.js's (`inboxHtml`), the chunk for the pages
   *  that list, fetched alongside the list itself. */
  const inboxHtml = (items, m) => m.inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown });

  /* After the Undo has gone: "N removed · Show" at the foot of the Inbox,
   * drawn by home.js (`removedLine`), the chunk for the pages that list. */
  const homeUse = () => (homeLoading ||= import(`/assets/home.js${boot.v ? `?v=${boot.v}` : ""}`)).then(m => (homeMod = m));
  const removedLine = fresh => homeUse().then(m => m.removedLine(fresh, { view: () => state.view, capability, deskApi, docEl, esc, rel, post, loadDesks, toast }), () => { homeLoading = null; });

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
    try { const m = await panelMod(); connectHtml = a => (agentsSeen = JSON.stringify(a ? a.rows : []), m.connect(a, { esc, rel, cap: !!capability })); }
    catch (e) { panelLoading = null; toast("Could not open that page", { sub: e }); }
  }
  async function showConnect(push = true) {
    if (push) leave();
    offDesk();
    state.view = "connect"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "Agents · snyvi";
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
  /** The first ten minutes: a page about.js draws, like the connect page.
   *  `at` is a section to land on (`#desks`), as an aside's link names one. */
  async function showStart(push = true, at = location.hash) {
    if (push) leave();
    offDesk();
    state.view = "start"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "How snyvi works · snyvi";
    if (push) history.pushState({ start: true }, "", "/start" + (at || ""));
    let m;
    try { m = await panelMod(); } catch (e) { panelLoading = null; toast("Could not open that page", { sub: e }); return; }
    // The first fetch of the chunk is a wait, and a click in it went elsewhere.
    if (state.view !== "start") return;
    docEl.innerHTML = m.start({ cap: !!capability });
    m.startReady(boot.v);
    if (push) swapIn();
    const sec = at && document.getElementById(at.slice(1));
    if (sec) sec.scrollIntoView({ block: "start" }); else main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
    if (push) toHead(sec);
  }
  /** A page the reader went to puts the focus on its heading (or the
   *  section it was sent to), so the keyboard starts where the eye does. */
  function toHead(sec) {
    const h = (sec || docEl).querySelector("h1, h2");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
  /** Welcome: what snyvi is, and which project first. Its own address to
   *  come back to from Help; the empty library draws the same page at `/`. */
  let welcomePlaces = [];
  async function welcomePage() {
    let m;
    try { m = await panelMod(); } catch (e) { panelLoading = null; toast("Could not open that page", { sub: e }); return ""; }
    welcomePlaces = capability ? deskPlaces() : [];
    return m.welcome({ cap: !!capability, places: welcomePlaces, home: state.desks && state.desks.home, mascot: mascotHead("glad"), esc });
  }
  async function showWelcome(push = true) {
    if (push) leave();
    offDesk();
    state.view = "welcome"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "Welcome · snyvi";
    if (push) history.pushState({ welcome: true }, "", "/welcome");
    if (capability && !state.desks) await loadDesks();
    const html = await welcomePage();
    if (state.view !== "welcome") return;
    docEl.innerHTML = html;
    if (push) swapIn();
    main.scrollTo({ top: 0, behavior: "instant" });
    afterRender();
    if (push) toHead();
  }
  /** Home, at `/`: the page the mark opens. Drawn by home.js, a chunk, from
   *  one call; the Inbox is at `/inbox`. */
  let homeMod = null, homeLoading = null;
  async function showHome(push = true) {
    if (push) leave();
    offDesk();
    state.view = "home"; state.doc = null; state.previous = null; state.comparing = null; state.browseRoot = null;
    document.title = "snyvi";
    if (push) history.pushState({ home: true }, "", "/");
    // The sidebar now, from what the page came with: Home waits on its chunk
    // and its numbers, and the tree is not Home's to hold up.
    renderTree(); markActive();
    try { await homeUse(); }
    catch { homeLoading = null; if (state.view === "home") docEl.innerHTML = `<div class="inbox-head"><h1>Home</h1>${noReach("home")}</div>`; return; }
    if (state.view !== "home") return;
    if (push) main.scrollTo({ top: 0, behavior: "instant" });
    await homeMod.show({ view: () => state.view, esc, rel, relShort, plural, capability, deskApi, docEl, card: panelMod, updCtx, checkUpdates,
      next: openNext, newDesk: b => act("make", null), notes: () => state.notes });
    if (push) swapIn();
    afterRender();
  }
  /** Something Home shows moved: read it again, soon. */
  const homeTick = () => { if (state.view === "home" && homeMod) homeMod.soonRefresh(); };

  // Welcome's question, and Connect wherever it is offered.
  docEl.addEventListener("click", async e => {
    const b = e.target.closest("[data-w]");
    if (!b || !docEl.contains(b)) return;
    const w = b.dataset.w;
    if (w === "pick") act("pick", true);
    else if (w === "place") { const f = welcomePlaces[+b.dataset.i]; if (f) act("make", f); }
    else if (w === "connect") connectClaude(b);
  });
  /** Connect Claude Code, from the Agents page or a desk's panel: it asks,
   *  in place, then runs `init-claude` in the daemon. */
  async function connectClaude(b, done) {
    const m = await panelMod();
    // "Connected." wears a face once, on the Agents page; a desk's panel is
    // the work and gets the words alone (docs/DESIGN.md §2.3).
    m.connectAsk(b, { sayErr, api: (path, body) => deskApi(path, body), mascotHead: state.view === "desk" ? null : mascotHead, done: (a, ok) => {
      if (a && state.view === "connect" && connectHtml) setTimeout(() => { if (state.view === "connect") docEl.innerHTML = connectHtml(a); }, 1600);
      done && done(a, ok);
    } });
  }
  /** Ask again while the page is on screen; redraw only when something changed. */
  function watchAgents() {
    clearInterval(agentsTimer);
    agentsTimer = setInterval(refreshAgents, 2500);
  }
  async function refreshAgents() {
    if (state.view !== "connect" || !docEl.querySelector(".connect") || document.hidden) return;
    let a; try { a = await (await fetch("/api/agents")).json(); } catch { return; }
    if (JSON.stringify(a.rows) === agentsSeen) return;
    const open = [...docEl.querySelectorAll(".agent details[open]")].map(d => d.closest(".agent").dataset.agent);
    // And the fold of the other agents: a row turning is no reason to shut it.
    const more = !!docEl.querySelector(".agents-more[open]");
    docEl.innerHTML = connectHtml(a);
    for (const id of open) docEl.querySelector(`.agent[data-agent="${CSS.escape(id)}"] details`)?.setAttribute("open", "");
    if (more) docEl.querySelector(".agents-more")?.setAttribute("open", "");
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
    // A status tip: the count as its name, who they are as its sub-line.
    const tip = n ? `${plural(n, "agent")} connected` : "No agent connected", who = names.map(([k, c]) => c > 1 ? `${k} ×${c}` : k).join(", ");
    const rl = $("#rail-live");
    for (const el of [liveEl, rl]) { el.dataset.tip = tip; el.ariaLabel = tip; who ? (el.dataset.tipSub = who) : delete el.dataset.tipSub; }
    rl.classList.toggle("on", n > 0); badge("#rail-live", n, " live");
  }
  function setOnline(map) {
    state.online = map && typeof map === "object" ? map : {};
    renderLive();
    refreshAgents();
  }
  renderLive();

  /** The update pill beside it (#upd). What it says and what a click on it
   *  does are about.js's (`pill`), fetched only when there is something to
   *  say: an update, a restart under way, or one that landed in the last day.
   *  A page with nothing to say about updates never fetches it. */
  const updEl = $("#upd");
  /** Ctrl K, the mark's menu, Home and About: ask for the manifest now
   *  (about.js's `checkUpdates`). */
  const checkUpdates = at => panelMod().then(m => m.checkUpdates(at, { ...updCtx(), setUpd }), () => { panelLoading = null; });
  /** What the update surfaces need from the page: about.js's `pill` and `card`. */
  const updCtx = () => ({ capability, deskApi, toast, plural, esc, copied, version: boot.version, panel, peek: mascotPeek, landed });
  /** An update landed in the last hour (about.js): the hover line answers
   *  with the version for that long (look.js's SAYS), and nothing opens. */
  const landed = (v, at) => { state.landed = { v, at }; };
  /** The version at the sidebar's foot: About, on a click, and the one place
   *  an update waiting shows as a dot. */
  const verEl = $("#foot-ver");
  if (boot.version) { verEl.textContent = `v${boot.version}`; verEl.hidden = false; }
  verEl.addEventListener("click", () => panel("about"));
  function setUpd(u) {
    u = u && typeof u === "object" ? u : null;
    verEl.classList.toggle("upd", !!(u && u.show));
    verEl.dataset.tipSub = u && u.show ? "an update is waiting" : "";
    if (!verEl.dataset.tipSub) delete verEl.dataset.tipSub;
    if ((u && (u.show || u.restart || u.restarting || Date.now() / 1e3 - (u.last_applied || 0) < 86400)) || !updEl.hidden)
      panelMod().then(m => m.pill(updEl, u, updCtx()), () => { panelLoading = null; });
  }

  /* A comparison of two versions, and a diff read split, are ui/diff.js's,
   * fetched the first time either is asked for, with the split's look. */
  let diffLoading = null;
  const diffUse = () => (diffLoading ||= import(`/assets/diff.js${boot.v ? `?v=${boot.v}` : ""}`).catch(e => { diffLoading = null; throw e; }));
  const diffCtx = () => ({ state, docEl, main, esc, fmt, toast, swapIn, buildToc, renderMeta, enhanceCode });
  const showCompare = (a, b) => diffUse().then(m => m.compare(diffCtx(), a, b), e => toast("Could not compare the versions", { sub: e }));
  /** Replace the inline diff body of a diff document with the side-by-side rendering. */
  const applySplit = () => diffUse().then(m => m.split(diffCtx()), () => {});

  async function toggleSplit() {
    state.split = !state.split;
    store.set("snyvi.split", state.split ? "1" : "0");
    if (state.comparing) { await showCompare(state.comparing.a, state.comparing.b); return; }
    if (state.doc && state.doc.kind === "diff") { state.cache.delete(state.doc.id); await showDoc(state.doc.id, false); }
    else toast("Split view", { sub: state.split ? "on, for diffs" : "off" });
  }

  /** How long any Undo stands, and answers to ⌘Z: one window for every kind
   *  (docs/DESIGN.md §4.4), long enough to see what went and take it back,
   *  short enough that the list is settled before the eye has moved on. The
   *  drain bar reads it as --undo-ms. */
  const UNDO_MS = 6000;
  root.style.setProperty("--undo-ms", UNDO_MS + "ms");

  /* The one offer. Every kind of removal -- a document, a folder, a
   * project, an aside, Mark all read, and a desk's notes and panels -- makes
   * its Undo the one standing here, and ⌘Z calls only this. A new offer
   * settles the last, whatever it was: two Undos on screen cannot both mean
   * the last thing that happened. `settle` is how an offer ends early. */
  let undoing = null, settling = null;
  function offer(undo, settle) {
    if (undoing && undoing !== undo) { const s = settling; undoing = settling = null; s?.(); }
    undoing = undo; settling = settle;
  }
  const unoffer = f => { if (undoing === f) undoing = settling = null; };

  /** Remove now, ask nothing, and offer the way back.
   *
   *  The question used to be a `window.confirm`, which the native window draws
   *  as the toolkit's own dialog in the toolkit's theme, over a page it has
   *  nothing to do with -- and which had to be answered before anything else
   *  could happen. The daemon keeps the document until `prune` runs, so the
   *  seconds below are a real offer and not a hopeful one. */
  async function deleteCurrent(byKey) {
    if (state.doc) deleteDoc(state.doc, null, byKey);
  }
  /** A removal a key made leaves the hand on its Undo, as an aside's does. */
  const toUndo = () => treesEl.querySelector(".t-gone .t-undo")?.focus({ preventScroll: true });

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
      if (at >= 0) return { where: "proj", pid, wf: w.id, wfAt, at, solo: w.total === 1 && w.docs.length === 1, doc: w.docs[at], order: wfs.map(x => x.id) };
    }
    return null;
  }

  /** The clock on an Undo, the same in both motion modes. It stops while a
   *  pointer or a focus rests on the offer (the element `sel` finds, wherever
   *  a redraw has put it) -- a reader deciding is not a reader who has gone --
   *  and while `hold` is set, which is an Undo being asked or refused. The
   *  drain bar only draws what it says, through --undo-left, so the two
   *  cannot disagree; under reduced motion the bar is still and still shows
   *  what is left. `left()` is that fraction, for a row drawn again. */
  function undoClock(sel, done, ms = UNDO_MS) {
    let at = performance.now(), rest = ms;
    const c = { hold: false, left: () => Math.max(0, rest / ms), stop: () => clearInterval(t), again() { rest = ms; } };
    const t = setInterval(() => {
      const now = performance.now(), el = document.querySelector(sel);
      if (!c.hold && !el?.matches(":hover, :focus-within")) rest -= now - at;
      at = now;
      el?.style.setProperty("--undo-left", c.left());
      if (rest <= 0) { c.stop(); done(); }
    }, 100);
    return c;
  }
  /** The offer is over: the row closes where it stood, as a read one does. */
  function ghostSettle(g) {
    if (gone !== g || g.closing) return;
    g.clock.stop();
    unoffer(g.undo);
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
  async function deleteDoc(d, from = null, byKey = false) {
    const here = !!state.doc && state.doc.id === d.id;
    const place = rowOf(d.id, from);
    if (place && place.doc) d = { ...place.doc, ...d, title: place.doc.title };
    // Only the newest offer stands: two rows both saying Undo cannot both mean
    // the last thing that happened.
    if (gone) { gone.clock.stop(); unoffer(gone.undo); gone = null; }
    const g = { ...(place || { where: null }), id: d.id, d, here, waiting: waitingRow(d), drawn: false, made: Date.now() };
    g.clock = undoClock("#tree .t-gone .t-ghost, #queue .t-gone .t-ghost", () => ghostSettle(g));
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
    offer(g.undo, () => ghostSettle(g));
    renderTree(); markActive();
    if (byKey) toUndo();
    const turn = opening;
    try {
      const r = await fetch(`/api/docs/${d.id}/delete`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      // A file sent seven times went with its seven versions: the ghost says so.
      g.versions = (await r.json().catch(() => ({}))).versions || 1;
      state.cache.delete(d.id);
      g.drawn = false;
      await refreshTree(d.project_id);
      // Off the page it was on -- unless the Undo came first, or the reader
      // opened something else while the daemon was answering.
      if (here && gone === g && turn === opening) { await showInbox(true); if (byKey) toUndo(); }
      // No row to stand in -- the meta pane's button or Del, with the row not
      // drawn: the offer goes where the toast goes.
      if (gone === g && !inView(g)) {
        toast("Removed", { sub: d.title + (g.versions > 1 ? ` · ${g.versions} versions` : ""), action: { label: "Undo", run: g.undo } });
        g.clock.again();
        if (byKey) $("#toasts .act")?.focus({ preventScroll: true });
      }
    } catch (e) {
      if (gone === g) { g.clock.stop(); gone = null; unoffer(g.undo); }
      if (g.waiting) await refetchQueue();
      await refreshTree(d.project_id);
      toast("Could not remove it", { sub: e });
    }
  }

  /** Take the removal back. The ghost holds the place until the row is back
   *  in it -- the renderers stop drawing it as soon as the document is in
   *  their list again -- so the list never closes up and opens again. */
  async function undoGone(g) {
    if (gone !== g || g.closing || g.back) return;
    g.clock.hold = true;
    g.back = true; g.err = "";
    unoffer(g.undo);
    renderTree(); markActive();
    const r = await post(`/api/docs/${g.id}/undelete`);
    if (!r?.ok) {
      // The offer stands: the ghost says what happened, in its own row, and
      // its button (or ⌘Z) asks again. Only a newer offer takes it away.
      if (gone !== g) return;
      g.back = false;
      g.dead = r?.status === 410;
      g.err = g.dead ? "Could not undo · prune has deleted it" : "Could not bring it back";
      // A refusal holds the clock; pruned, there is nothing to hold it for.
      if (g.dead) { g.clock.hold = false; g.clock.again(); }
      else offer(g.undo, () => ghostSettle(g));
      renderTree(); markActive();
      // No row to say it in: the toast the offer was made in says it instead.
      if (!inView(g)) toast(g.err, { sub: g.d.title, retry: !g.dead && g.undo });
      return;
    }
    try {
      wash([g.id]);
      if (g.waiting) await refetchQueue();
      await refreshTree(g.d.project_id);
      // The "restored" event puts the row back in every other tab.
      if (g.here) showDoc(g.id);
    } finally {
      g.clock.stop();
      if (gone === g) gone = null;
      renderTree(); markActive();
    }
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
    awayClock?.stop();
    awayJust = key;
    const undo = () => bringBack(key), settle = () => { unoffer(undo); if (awayJust !== key) return; awayClock.stop(); awayJust = null; renderTree(); markActive(); };
    offer(awayUndo = undo, settle);
    // The same clock as every ghost: it waits while the hand is on the row.
    awayClock = undoClock("#tree .t-back", settle);
    renderTree(); markActive();
  }

  /** Put a project back in the sidebar: one by id, or every one of them when
   *  the row under the tree is the one clicked. */
  function bringBack(id) {
    awayClock?.stop();
    unoffer(awayUndo);
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
  /* The card is ui/note.js, fetched the first time there is an aside to show.
   * Until then the page keeps only the mark: `data-note` on the root, which
   * makes the logo blink and the rail's aside dot glow. */
  /** A shortcut as this machine writes it (docs/DESIGN.md §3.4): glyphs on
   *  macOS, words everywhere else, key names title-cased. "mod" is ⌘ on a
   *  Mac and Ctrl elsewhere; "ctrl+alt+w" is ⌃⌥W or Ctrl Alt W. Every
   *  shortcut the page shows is written through here. */
  function keyHint(combo) {
    const mac = /Mac/.test(navigator.platform);
    return combo.split("+").map(k => {
      const w = { mod: mac ? "⌘" : "Ctrl", ctrl: mac ? "⌃" : "Ctrl", alt: mac ? "⌥" : "Alt", shift: mac ? "⇧" : "Shift", esc: "Esc", del: "Del" }[k];
      // A letter with a modifier is the key's cap (Ctrl K); alone it is the
      // letter typed (n), as the help card writes it.
      return w || (k.length > 1 ? k[0].toUpperCase() + k.slice(1) : combo.length > 1 ? k.toUpperCase() : k);
    }).join(mac ? "" : " ");
  }

  /** The asides on the card: the daemon keeps a closed one, flagged, for Undo. */
  const liveNotes = () => state.notes.filter(n => !n.dismissed);
  /* snyvi's own asides: five lines at five first moments, each once, each
   * pointing into /start. Not a tour and not a checklist: it waits while an
   * agent's aside is unread, says at most one thing in ten minutes (the
   * daemon's own quiet for agents, aside.rs), and remembers what it said in
   * this browser (`snyvi.seen.*`, which Reset clears). Kept on the card's
   * list with ids `snyvi:*`, which note.js never tells the daemon about.
   * Their words are note.js's (OWN there), the only file that shows them:
   * first paint carries only their names. */
  const OWN = new Set(["first-doc", "two-waiting", "second-desk", "two-desks", "blocked", "version"]);
  const isOwn = n => String(n.id).startsWith("snyvi:");
  // By when each was said, newest first, as the daemon's list is: an agent's
  // aside after snyvi's line is the one the card shows, not a line behind it.
  const withOwn = list => list.concat(state.notes.filter(isOwn)).sort((a, b) => (b.at || 0) - (a.at || 0));
  /* Held, not dropped: a moment that comes while an agent's aside is unread,
   * or inside the ten quiet minutes, waits in `snyvi.own.held` and is said
   * when the way is clear -- once, as ever. */
  let ownTimer = 0;
  const heldOwn = () => { try { return JSON.parse(store.get("snyvi.own.held") || "[]"); } catch { return []; } };
  function snyviSays(key) {
    if (!OWN.has(key) || store.get(`snyvi.seen.${key}`)) return;
    const quiet = 600e3 - (Date.now() - (+store.get("snyvi.seen.at") || 0));
    if (quiet > 0 || state.notes.some(n => !n.dismissed && !n.seen)) {
      const held = heldOwn();
      if (!held.includes(key)) store.set("snyvi.own.held", JSON.stringify(held.concat(key)));
      clearTimeout(ownTimer);
      ownTimer = setTimeout(sayHeld, Math.max(quiet, 30e3));
      return;
    }
    store.set("snyvi.own.held", JSON.stringify(heldOwn().filter(k => k !== key)));
    store.set(`snyvi.seen.${key}`, "1"); store.set("snyvi.seen.at", String(Date.now()));
    state.notes = [{ id: `snyvi:${key}`, text: "", sender: "", at: Date.now() / 1000 }, ...state.notes.filter(n => !isOwn(n))];
    renderNote();
  }
  /** The first held moment, if the way is clear now; the rest keep waiting. */
  function sayHeld() {
    const k = heldOwn().find(k => !store.get(`snyvi.seen.${k}`));
    if (k) snyviSays(k); else store.set("snyvi.own.held", "[]");
  }
  // A moment held when the last page closed is still owed.
  if (heldOwn().length) ownTimer = setTimeout(sayHeld, 30e3);
  let noteMod = null, noteLoading = null;
  function renderNote() {
    if (noteMod) return noteMod.render();
    const n = liveNotes()[0];
    if (n && !n.seen) root.dataset.note = n.lit ? "lit" : "new";
    else delete root.dataset.note;
    if (n) noteLoading ||= import(`/assets/note.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => {
      noteMod = m.init({ root, $, state, liveNotes, esc, relShort, showDoc, showStart, toast, keyHint, closeSay, undoClock,
        holdUndo: offer, dropUndo: unoffer, peek: mascotPeek });
      noteMod.render();
    }, () => { noteLoading = null; });
  }
  renderNote();

  // ---------- snyvi answers ----------
  /** The note above is what an agent said, and its byline says who. This is
   *  snyvi itself, and the rule that keeps it from being a gimmick is that it
   *  only ever answers: nothing opens on its own, ever. A reader who comes
   *  over to the face and rests there gets one short line back. */
  const brandEl = $(".brand"), sayEl = $("#bm-say");
  /** What it says, and when, is look.js's (`openSay`), fetched once the
   *  page is idle: the lines, their weights, and the face each wears. */
  let sayIn = 0, sayOut = 0;
  function closeSay() {
    sayEl.classList.remove("on");
    brandEl.classList.remove("said");
    delete root.dataset.say;
    clearTimeout(sayOut);
    sayOut = setTimeout(() => { if (!sayEl.classList.contains("on")) sayEl.hidden = true; }, 340);
  }
  brandEl.addEventListener("pointerenter", e => {
    // A finger is not a reader leaning over. Nor is crossing the brand on the
    // way to Search, so it waits for a moment's rest before it says anything.
    if (e.pointerType === "touch") return;
    clearTimeout(sayIn);
    // While it speaks, its line is the label: the "Home" tip gives way.
    sayIn = setTimeout(() => useLook().then(l => { if (brandEl.matches(":hover")) { brandEl.classList.add("said"); tipMod?.gone(brandEl); l.openSay({ root, sayEl, state, quiet }); } }, () => {}), 260);
  });
  brandEl.addEventListener("pointerleave", () => { clearTimeout(sayIn); closeSay(); });
  // Following the brand through to the inbox takes the bubble with it.
  brandEl.addEventListener("click", () => { clearTimeout(sayIn); closeSay(); });
  /** A desk's last open note ticked (desk.js): the milestone of docs/DESIGN.md
   *  §2.3, and a desk may carry no face, so it is the mark's -- glad, one
   *  hop, for as long as a face's moment lasts. The hover line answers "all
   *  done" for the next hour, and Home says the count. Rare by nature: it
   *  is the end of a list, not of a line. */
  function markDone() {
    state.doneAt = Date.now();
    if (quiet()) return;
    const mark = $(".brand-mark");
    root.dataset.done = "1";
    mark.classList.remove("hop"); void mark.offsetWidth; mark.classList.add("hop");
    clearTimeout(doneSettle);
    doneSettle = setTimeout(() => { delete root.dataset.done; mark.classList.remove("hop"); }, 2400);
  }
  let doneSettle = 0;

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
  function refreshBrowsed() { if (browseMod) browseMod.refresh(browseCtx()); }

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
    box.innerHTML = `<h4>Versions · ${h.length}</h4>` + h.map(d => `<a href="/d/${d.id}" data-id="${d.id}" class="${d.id === state.doc.id ? "cur" : ""}" data-tip="${esc(d.workflow_title)}">${fmt(d.received_at)}${d.pinned ? " " + glyph("pin", 10) : ""}</a>`).join("");
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
    const from = findBar.hidden ? document.activeElement : null;
    findBar.hidden = false;
    const input = $("#find-input");
    input.focus(); input.select();
    try { find = await (findLoading ||= import(`/assets/find.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { findLoading = null; findBar.hidden = true; toast("Could not open find", { sub: e }); return; }
    find.open({ $, docEl, bring }, from);
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
    tocEl.scrollTo({ top: Math.max(0, top - h / 2), behavior: now || matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
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
    rail.classList.toggle("empty", state.view === "inbox" || state.view === "home" || state.view === "connect" || state.view === "start" || state.view === "welcome");
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
      `<li class="d${o.depth + 1}"><a href="#" data-line="${o.line}" data-i="${i}" data-tip="${esc(o.kind)}" data-tip-sub="line ${o.line}"><span class="ok ok-${o.kind}"></span>${esc(o.name)}</a></li>`
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
    if (!pre) { toast("No line numbers here", { sub: "line links work on code and text documents", face: null }); return; }
    if (n > pre.querySelectorAll(".ln").length) { toast(`No line ${n}`, { sub: "the document is shorter than that", face: null }); return; }
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
      copied(location.href, { x: e.clientX, y: e.clientY });
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
    metaEl.innerHTML = rows.map(([k, v]) => `<div class="row"><b>${k}</b><span data-tip="${esc(v)}" data-tip-overflow data-tip-cut>${esc(v)}</span></div>`).join("") +
      // Sent from a pane: which desk and which slot, and a way back to it.
      // A link and not adjacency, because a window can have three desks and
      // `[1]` alone would not say which.
      (d.desk ? `<div class="row"><b>From</b><span><a href="/desk/${d.desk.id}" data-desk="${d.desk.id}" data-slot="${d.desk.slot}">${esc(d.desk.name)} [${d.desk.slot}] ▸</a></span></div>` : "") +
      `<div class="actions">` +
      (state.previous ? (comparing ? `<button data-act="back">← Back to document</button>` : `<button data-act="compare">Compare with previous<kbd>c</kbd></button>`) : "") +
      `<button data-act="pin">${d.pinned ? "Unpin" : "Pin"}<kbd>p</kbd></button>` +
      ((d.kind === "diff" || comparing) ? `<button data-act="split">${state.split ? "Inline view" : "Split view"}<kbd>s</kbd></button>` : "") +
      previewButton() +
      `<button data-act="delete">Remove<kbd>Del</kbd></button>` +
      `<a href="/api/docs/${d.id}/raw" target="_blank" rel="noopener">Open source<kbd>o</kbd></a>` +
      (d.source_path ? `<button data-act="copypath" data-tip="${esc(d.source_path)}" data-tip-mono>Copy path</button>` : "") +
      (state.folder ? `<button data-act="terminal" data-tip="${esc(state.folder)}" data-tip-mono>Open terminal here</button><button data-act="reveal" data-tip="${esc(state.folder)}" data-tip-mono>Open in file manager</button>` : "") +
      `</div>`;
  }
  const rawUrl = (rootId, path) => `/api/browse/${rootId}/raw/${path.split("/").map(encodeURIComponent).join("/")}`;

  function previewButton() {
    if (!state.preview) return "";
    const label = state.previewOn ? "Source" : (state.preview === "pdf" ? "Open in viewer" : "Preview page");
    return `<button data-act="preview">${label}<kbd>v</kbd></button>`;
  }

  function renderBrowseMeta() { if (browseMod) browseMod.meta(browseCtx()); }

  metaEl.addEventListener("click", async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "compare") showCompare();
    if (b.dataset.act === "back") { state.cache.delete(state.doc.id); showDoc(state.doc.id, false); }
    if (b.dataset.act === "copypath") copied(state.doc.source_path, b);
    if (b.dataset.act === "pin") togglePin();
    if (b.dataset.act === "split") toggleSplit();
    if (b.dataset.act === "preview") togglePreview();
    if (b.dataset.act === "delete") deleteCurrent(!e.detail);
    if (b.dataset.act === "copybrowse") {
      const full = state.browseRoot.path + (state.browsePath ? "/" + state.browsePath : "");
      copied(full, b);
    }
    if (b.dataset.act === "terminal") openTerminal();
    if (b.dataset.act === "reveal") openFolder();
    if (b.dataset.act === "closebrowse") closeRoot(state.browseRoot.id);
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

  /** Pin or unpin a document: the meta pane's button, `p`, a row's menu.
   *  The ● and the button's word are the answer, and only once the daemon
   *  has said yes (rung 0). A refusal answers where it was asked: a menu
   *  hands in where its item stood (`at`). */
  async function pin(d, at) {
    const pinned = !d.pinned;
    const r = await post(`/api/docs/${d.id}/pin`, { pinned });
    if (!r?.ok) return toast(`Could not ${pinned ? "pin" : "unpin"} it`, { sub: d.title, retry: () => pin(d, at), at });
    d.pinned = pinned; state.cache.delete(d.id);
    if (state.doc?.id === d.id) { state.doc.pinned = pinned; renderMeta(false); }
    await refreshTree(d.project_id);
  }
  const togglePin = () => state.doc && pin(state.doc);

  function enhanceCode() {
    for (const pre of docEl.querySelectorAll("pre.code")) {
      if (pre.querySelector(".copy")) continue;
      wireLines(pre);
      const b = document.createElement("button");
      b.className = "copy"; b.textContent = "Copy";
      b.addEventListener("click", () => copied([...pre.querySelectorAll(".ln")].map(l => l.textContent).join("\n") || pre.textContent, b));
      pre.appendChild(b);
    }
  }

  // ---------- navigation ----------
  document.addEventListener("click", e => {
    const a = e.target.closest("a[data-id], a[data-browse], a[data-desk], [data-nav]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    if (a.dataset.nav === "inbox") showInbox(true);
    else if (a.dataset.nav === "home") showHome(true);
    else if (a.dataset.nav === "connect") showConnect(true);
    else if (a.dataset.nav === "start") showStart(true, a.hash || "");
    else if (a.dataset.nav === "welcome") showWelcome(true);
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
    if (u.pathname === "/") { e.preventDefault(); showHome(true); return; }
    if (u.pathname === "/inbox") { e.preventDefault(); showInbox(true); return; }
    if (u.pathname === "/connect") { e.preventDefault(); showConnect(true); return; }
    e.preventDefault();
    toast("Not a page in snyvi", { sub: href, action: {
      label: "Open anyway",
      run: () => window.open(a.href, "_blank", "noopener"),
    } });
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
    if (location.pathname === "/start") return showStart(false);
    if (location.pathname === "/welcome") return showWelcome(false);
    const k = location.pathname.match(/^\/desk\/(\d+)$/);
    if (k || location.pathname === "/desks") return showDesk(k ? +k[1] : null, false);
    if (location.pathname === "/inbox") return showInbox(false);
    showHome(false);
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
  /* The mark's value is the window's version from 1.7 on (`1` from an older
   * window), kept for the session and sent back on the event stream so the
   * daemon knows which window it has. */
  const windowMark = (() => {
    try {
      const p = new URLSearchParams(location.search);
      if (p.has("window")) {
        sessionStorage.setItem("snyvi.window", p.get("window") || "1");
        // Out of the address bar at once, and out of the history entry, so
        // Back never returns to a marked URL and no copied link carries it.
        history.replaceState(history.state, "", location.pathname + location.hash);
      }
      return sessionStorage.getItem("snyvi.window") || "";
    } catch { return ""; }
  })();
  const inWindow = windowMark !== "";

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
  const plusDesk = () => capability ? `<button class="b-new" data-newdesk data-tip="New desk here" aria-label="New desk here">${icon("desk")}</button>` : "";
  /** A desk route, with the capability in the one place a page can put a
   *  secret on a request it composes: a header. */
  async function deskApi(path, body, type) {
    const headers = { "content-type": type || "application/json", "x-snyvi-capability": capability };
    const r = await fetch(path, body === undefined ? { headers } : { method: "POST", headers, body: type ? body : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  /** A desk route's bytes, for what an <img> cannot fetch itself: it has no
   *  header to carry the capability in. A picture on a note, drawn from these. */
  async function deskBlob(path) {
    const r = await fetch(path, { headers: { "x-snyvi-capability": capability } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
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
    state, esc, toast, sayErr, copied, keyHint, armed, toggleQuiet, checkUpdates, browseEl,
    get capability() { return capability; },
    api: (path, body, type) => deskApi(path, body, type),
    load: () => loadDesks(),
    show: (id, push, slot) => showDesk(id, push, slot),
    browse: (root, path, push) => showBrowse(root, path, push),
    drawBrowse: () => renderBrowse(),
    drawTree: () => renderTree(),
    forget: id => { if (lastDesk === id) lastDesk = null; },
    // What the context menu and the moves out of this file reach for: the
    // page's own functions, so the chunk runs the code a row's button runs.
    get desk() { return desk; },
    folderOf: el => folderOf(el),
    closeRoot: id => closeRoot(id),
    open: id => showDoc(id, true),
    togglePin, pin,
    refreshTree: pid => refreshTree(pid),
    deleteDoc: d => deleteDoc(d),
    knownDocs,
    putAway: pid => putAway(String(pid)),
    applyRename: (what, id) => applyRename(what, id),
    places: () => deskPlaces(),
    hold: id => heldPanes.add(id),
  };
  /** Panels made to wait for the reader's Enter: a new project desk's first,
   *  holding `claude`. The desk view takes each once, as it draws it. */
  const heldPanes = new Set();
  /** Where a new desk could go besides the home folder: the folders the
   *  Inbox's projects were written from, then the folders open under Folders,
   *  one row a folder, less any that already has a desk -- that one is a
   *  click on its row away, and a second desk on it is its menu's to offer. */
  function deskPlaces() {
    const trim = p => p && p.replace(/(.)\/+$/, "$1");
    const home = trim(state.desks && state.desks.home), taken = new Set(state.desks ? state.desks.desks.map(d => trim(d.root)) : []), out = [];
    const put = (abs, f) => { const k = trim(abs); if (k && k !== home && !taken.has(k)) { taken.add(k); out.push({ abs, ...f }); } };
    for (const p of state.tree) if (!away.has(String(p.id))) put(p.root, { project: p.id, name: p.name });
    for (const r of state.browse) put(r.path, { root: r.id, path: "", name: r.name });
    return out;
  }
  /** `+ New desk` asks where, under the button that asked. */
  const askWhere = (el, byKey) => { const r = el.getBoundingClientRect(); return menuFor(el, r.left, r.bottom + 4, byKey); };
  /** Wait for the chunk, then do the thing that was clicked. A failure is the
   *  reader's to see: they pressed something and nothing happened otherwise. */
  async function act(what, ...args) {
    try { const m = await useActs(); return m[what](actsCtx, ...args); }
    catch (e) { actsLoading = null; toast("Could not do that", { sub: e }); }
  }

  let deskRoots = "";
  async function loadDesks() {
    if (capability) { try { state.desks = await deskApi("/api/desks"); desksOff = false; } catch { desksOff = true; } }
    // A project's row says whether it has a desk; only a desk made, closed
    // or moved changes that, not the panes' dots, which change all day. The
    // tree draws the desks as it goes.
    const roots = state.desks ? state.desks.desks.map(d => d.root).join("\n") : "";
    if (roots !== deskRoots) { deskRoots = roots; renderTree(); markActive(); } else renderDesks();
    if (desk && (state.view === "desk" || state.deskBehind != null)) desk.update(state.desks);
  }
  const mark3 = ps => ps.some(p => p.status && p.status.blocked) ? "!" : ps.some(p => p.status && p.status.running) ? "●" : "○";
  /** The fullest context window among a desk's panels, as their status lines said. */
  const fullest = d => { const ps = d.panes.map(p => p.status && p.status.ctx_pct).filter(x => x != null); return ps.length ? Math.max(...ps) : null; };
  let desksSeen = null;
  function renderDesks() {
    const list = state.desks ? state.desks.desks : [];
    let blocked = 0;
    for (const d of list) for (const p of d.panes) if (p.status && p.status.blocked) blocked++;
    const on = state.view === "desk" || state.deskBehind != null;   // a document read over a desk is still the desk
    badge('[data-pop="desks"]', blocked, " blk");
    // snyvi's own moments on the way to a second project: one desk, asked
    // for another once an agent has worked in it; two, and what that gives.
    if (list.length === 1 && list[0].panes.some(p => p.status && p.status.agent)) snyviSays("second-desk");
    if (desksSeen === 1 && list.length === 2) snyviSays("two-desks");
    if (state.desks) desksSeen = list.length;
    if (blocked) snyviSays("blocked");
    // Blocked panes stay said on the head, so folding Desks cannot hide them.
    const head = secHead("desks", "Desks", (blocked ? `<span class="s-blk" data-tip="${plural(blocked, "panel")} waiting on you">!${blocked}</span>` : "") + (capability ? `<button type="button" class="s-add" data-newdesk data-tip="New desk" aria-label="New desk">+</button>` : ""));
    const top = `<ul class="t-desks s-body">` + (!capability ? `<li class="s-empty">Open the snyvi window to run desks</li>`
        : desksOff ? noReach("desks", "li") : !list.length ? `<li><button type="button" class="b-empty" data-newdesk>Give a project a desk</button></li>` : "");
    // One desk is one project; the second is when snyvi starts to earn its
    // place, so it is asked for, under the first, until there is one.
    const more = capability && list.length === 1 ? `<li class="t-more-desk"><button type="button" class="b-empty" data-newdesk>+ New desk</button></li>` : "";
    const rows = list.map(d => {
      const m = mark3(d.panes), n = d.panes.length, full = fullest(d);
      const say = m === "!" ? `${plural(d.panes.filter(p => p.status && p.status.blocked).length, "panel")} waiting on you` : m === "●" ? "Running" : "Idle";
      // The row's end says only what is unusual: a panel that needs you, a
      // context window nearly full, three panels or more (two is what most
      // desks have, so a 2 on every row told them apart by nothing). A live
      // desk is a dot and an idle one is nothing; the tip carries the rest.
      const working = d.panes.filter(p => p.status && (p.status.agent === "working" || p.status.running)).length;
      const fp = full == null ? null : d.panes.find(p => p.status && p.status.ctx_pct === full);
      const tip = [plural(n, "panel"), working ? `${working} working` : "", full == null ? "" : `context ${full}%${fp && fp.status.model ? ` (${fp.status.model})` : ""}`].filter(Boolean).join(" · ");
      return [`<li class="t-desk"><a href="/desk/${d.id}" data-desk="${d.id}" class="${on && state.deskId === d.id ? "active" : ""}">` +
        `${icon("desk")}<span class="title nm">${esc(d.name)}</span>`,
        `<span class="end" data-tip="${esc(say)}" data-tip-sub="${esc(tip)}">${full != null && full >= 85 ? `<span class="ctx hot">${full}%</span>` : ""}${m === "!" ? `<span class="dot blk">! needs you</span>` : m === "●" ? `<span class="dot on"></span>` : ""}<span class="vh">${say}</span>${n > 2 ? `<span class="k">${n}</span>` : ""}</span>`,
        `${capability ? `<button type="button" class="row-x" data-dropdesk="${d.id}" data-tip="Close desk" aria-label="Close desk ${esc(d.name)}">${glyph("x")}</button>` : ""}</a></li>`];
    });
    // A pane's dot changes far more often than the list does, and the row
    // under the pointer must not be swapped for a copy of itself: it would
    // lose its hover until the pointer moved, and a click pressed on the old
    // row and let go on the new one would not be a click. So what changed
    // is written, and only that -- the mark column, the head -- and the list
    // is drawn whole only when a row itself is different.
    // The desk glyph on each project's row follows its desk's state here,
    // where the dots change, rather than by drawing the tree again.
    for (const b of treeEl.querySelectorAll("[data-deskof]")) {
      const d = list.find(x => String(x.id) === b.dataset.deskof);
      if (d) b.className = "b-new has" + deskState(d);
    }
    const lis = deskNav.querySelectorAll(".t-desk"), same = deskNav.$top === top + more && lis.length === rows.length && rows.every((r, i) => lis[i].$r === r[0] + r[2]);
    if (!same) {
      deskNav.innerHTML = head + top + rows.map(r => r.join("")).join("") + more + `</ul>`;
      deskNav.$top = top + more; deskNav.$head = head;
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
      docEl.innerHTML = `<div class="inbox-head"><h1>Desks</h1><p>Desks run in the snyvi desktop window. This is a browser tab, and a browser tab cannot start one. Open the same address in the desktop app.</p></div><p><code>snyvi:/${esc(location.pathname)}</code></p>`;
      tocEl.innerHTML = metaEl.innerHTML = ""; rail.classList.add("empty");
      return;
    }
    try { desk = await (deskLoading ||= import(`/assets/desk.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { deskLoading = null; toast("Could not open the desk", { sub: e }); return; }
    if (state.view !== "desk") return;
    if (!state.desks) await loadDesks();
    desk.open({ id, slot, was, icons: ICONS, desks: state.desks, held: heldPanes, connect: connectClaude, api: deskApi, blob: deskBlob, socket: deskSocket, toast: toast4, sayErr, esc, glyph, keyHint, plural, rel, relShort, fmt, read: id => showDoc(id, true, false, true), reveal: openFolder, sized: () => { paintControls(); toast("Text size", { sub: desk.textSize().name }); }, go: showDesk, swap: swapDesk, make: (el, byKey) => el ? askWhere(el, byKey) : act("make", null), refresh: loadDesks, menu: (el, x, y, byKey) => menuFor(el, x, y, byKey), done: markDone, main, docEl, tocEl, metaEl, rail, root });
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
   *  to: Home, the Inbox, a folder's contents, the agents page, a desk. Asked just
   *  before the page leaves it. Read on from one document to the next, with
   *  `j`, a link or the palette, and the reader is still on the same visit:
   *  the entry being left already knows where that visit began. */
  function cameFrom() {
    if (state.view === "doc" || (state.view === "browse" && state.browsePath)) return (history.state && history.state.back) || null;
    if (state.view === "home") return { home: true };
    if (state.view === "inbox") return { inbox: true };
    if (state.view === "browse" && state.browseRoot) return { browse: state.browseRoot.id, path: "" };
    if (state.view === "connect") return { connect: true };
    if (state.view === "start") return { start: true };
    if (state.view === "welcome") return { welcome: true };
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
    if (b && b.home) return { name: "Home", go: () => showHome(true) };
    if (b && b.connect) return { name: "Agents", go: () => showConnect(true) };
    if (b && b.start) return { name: "How snyvi works", go: () => showStart(true, "") };
    if (b && b.welcome) return { name: "Welcome", go: () => showWelcome(true) };
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
    overX.dataset.tip = label; overX.dataset.key = state.deskBehind != null ? "ctrl+`" : "esc";
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
  const MENU_AT = ".brand-mark, .b-root > summary, .b-dir > details > summary, a[data-browse], .t-proj > summary, a[data-id], a[data-desk], " +
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
      if (Array.isArray(n.notes)) { state.notes = withOwn(n.notes); renderNote(); }
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
    const es = new EventSource("/api/events" + (inWindow ? `?window=${encodeURIComponent(windowMark)}` : ""));
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
      if (h) { setOnline(h.agents); setUpd(h.update); }
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
    // The updater's word: first on every stream, then whenever it changes.
    es.addEventListener("update", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      setUpd(j);
    });
    // An agent left a note, or a reader looked at one somewhere.
    es.addEventListener("notes", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(j.notes)) { state.notes = withOwn(j.notes); renderNote(); }
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
      // A newer version of a file already waiting takes that row's place:
      // the daemon marked the older ones read when this one landed, and
      // counts one. By file and not by `supersedes`, which names only the
      // version just before -- a page that missed an event kept the rest.
      const older = d.source_path ? state.queue.filter(q => q.id !== d.id && q.project_id === d.project_id && q.source_path === d.source_path).map(q => q.id) : [];
      if (older.length) dropFromQueue(older, state.waiting - older.length);
      // Held in order only while everything waiting is held: past that the
      // arrival is the newest, and belongs after rows this page never had.
      if (!queueIds.has(d.id) && state.queue.length === state.waiting) state.queue.push(d);
      state.waiting = j.waiting != null ? j.waiting : state.waiting + 1;
      arrivals++;
      if (!opens) wash([d.id]);
      holdQueue();   // a burst's events carry counts ahead of the rows this page holds
      state.cache.delete(d.id);
      renderTree(); markActive();
      await refreshTree(d.project_id);
      deskDocs();
      // First in the library, wherever the reader is -- on a desk, most
      // often -- and not just first into an empty inbox: a reader with a
      // year of documents is not told this one is their first.
      if (state.tree.reduce((n, p) => n + p.docs, 0) <= 1) snyviSays("first-doc");
      else if (state.waiting > 1) snyviSays("two-waiting");
      else if (j.supersedes) snyviSays("version");
      if (opens) {
        await showDoc(d.id, true);
        // Nobody pressed anything: this one came in on its own, so it keeps
        // the corner rather than pointing at whatever was last touched.
        toast(d.title, { sub: `${d.project} · just now`, kind: "news" });
      }
      else if (superseded) {
        // The rail picks it up either way, so the offer is free to fade: a
        // reader who misses the button finds the new version at the top of
        // Versions, and `]` steps to it.
        renderHistory();
        toast("A newer version arrived", { sub: d.title, kind: "news",
          action: { label: "Read it", run: () => showDoc(d.id, true) } });
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
      const turn = opening;
      state.cache.delete(j.id);
      depart([j.id]);
      state.queue = state.queue.filter(d => d.id !== j.id);
      if (j.waiting != null) state.waiting = j.waiting;
      await refreshTree();
      deskDocs();
      if (state.doc && state.doc.id === j.id) { if (turn === opening) showInbox(true); }
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
    es.addEventListener("reset", () => panelMod().then(m => m.afterReset(), () => location.replace("/")));
    es.addEventListener("browse", ev => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      state.browse = j.roots || [];
      renderBrowse();
    });
    es.addEventListener("pinned", async () => { await refreshTree(); deskDocs(); });
    // A document taken off a desk's list, or put back, in another window.
    es.addEventListener("deskdocs", deskDocs);
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
    // Home shows a little of all of these; each one reads it again, soon.
    for (const ev of ["panes", "ctx", "desks", "desknotes", "doc", "read", "update", "notes", "agents", "deleted", "restored"]) es.addEventListener(ev, homeTick);
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
    rest: EYE(11) + EYE(21) + SMILE,
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
    (FACES[feel] || FACES.rest) + `</svg>`;
  /* The same head at the 72 px peek's size, where it keeps the shine in its
   * eyes and the blush the icon has (docs/DESIGN.md §2.2: below 48 px they
   * go). One drawing for the aside card and the update card, so the peek is
   * never a face drawn by hand in the chunk that shows it. */
  const SHINE = { rest: [11, 21], whoa: [11, 21], wink: [21] };
  const mascotPeek = feel => mascotHead(feel).replace("</svg>",
    `<ellipse class="mk-cheek" cx="7.4" cy="21.8" rx="2.4" ry="1.5"/><ellipse class="mk-cheek" cx="24.6" cy="21.8" rx="2.4" ry="1.5"/>` +
    (SHINE[FACES[feel] ? feel : "rest"] || []).map(x => `<circle class="mk-shine" cx="${x + 0.9}" cy="15.2" r="1"/>`).join("") + "</svg>");
  /* Where the reader acted, taken as they act (docs/DESIGN.md §4.2). A press
   * keeps its point and the control under it; a key keeps its moment, since
   * the answer to a key belongs at the focus, never at an idle pointer. An
   * answer that comes ten seconds after either answers nobody, and goes to
   * the corner. A caller that knows better passes `at` itself -- a menu item's
   * rect, taken before the menu closed; a control's, before a redraw. */
  const ACTABLE = "button, a, summary, [role='button'], .ln, .anchor";
  let press = null, keyAt = -1e9;
  addEventListener("pointerdown", e => { press = { x: e.clientX, y: e.clientY, t: performance.now(), el: e.target?.closest?.(ACTABLE) }; }, true);
  addEventListener("keydown", () => { keyAt = performance.now(); }, true);
  /** Where the last act was: the focused control after a key (on a desk,
   *  its panel's head); after a press, the control pressed, or the point it
   *  stood at if a redraw has taken it. */
  function actedAt() {
    const pt = press?.t ?? -1e9;
    if (performance.now() - Math.max(pt, keyAt) > 10000) return null;
    if (keyAt > pt) {
      const a = document.activeElement;
      return a && a !== document.body ? a.closest(".pn")?.querySelector(".pn-head") || a : null;
    }
    return press.el?.isConnected ? press.el : { x: press.x, y: press.y };
  }
  /** An anchor as a rect: an element (while it is in the page), a DOMRect,
   *  or a point. */
  const rectOf = a => !a ? null : a instanceof Element ? (a.isConnected ? a.getBoundingClientRect() : null)
    : "width" in a ? a : { left: a.x, right: a.x, top: a.y, bottom: a.y, width: 0, height: 0 };

  /* The tip (docs/DESIGN.md §8.1) is ui/tip.js, fetched the first time a
   * pointer comes over something with a `data-tip`, or Tab is first pressed:
   * its first showing waits 450 ms, which covers the fetch. */
  let tipMod = null, tipLoading = null;
  const useTip = (since = performance.now()) => tipLoading ||= import(`/assets/tip.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (tipMod = m.init({ keyHint, since })), () => { tipLoading = null; });
  document.addEventListener("pointerover", e => { if (!tipLoading && e.target.closest?.("[data-tip]")) useTip(); }, { passive: true });
  document.addEventListener("keydown", e => { if (!tipLoading && e.key === "Tab") useTip(); });
  /** An error, in words: `why` for the sub-line, `raw` (its own text, for
   *  whoever needs the exact words) for the toast's title until 1.8's tip.
   *  What snyvi's daemon said is shown as it said it; what the browser said
   *  about the daemon is said the way a person would. */
  function sayErr(e) {
    const raw = String(e?.message ?? e).replace(/^Error: /, "");
    return { raw, why: /dynamically imported|module script/i.test(raw) ? "part of snyvi did not load"
      : /fetch|network|load failed/i.test(raw) ? "snyvi is not answering"
      : /token|capabilit|\b40[13]\b/i.test(raw) ? "this window lost its link to snyvi · reopen it"
      : /\b5\d\d\b/.test(raw) ? "something went wrong in snyvi"
      : /\b(404|410)\b/.test(raw) ? "it is not there any more" : raw };
  }

  /** snyvi's answer (docs/DESIGN.md §4): toast(title, { sub, at, kind,
   *  action, retry, face, life, go }), drawn by ui/toast.js -- fetched the
   *  first time snyvi has something to say, since a page that is only read
   *  says nothing. Where the reader acted is taken now, as they act, not
   *  when the chunk lands; and what was said before it did is said in order. */
  let toastMod = null, toastLoading = null;
  function toast(title, o = {}) {
    const at = "at" in o ? o.at : actedAt(), say = m => m.say(title, o, at);
    if (toastMod) return void say(toastMod);
    (toastLoading ||= import(`/assets/toast.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (toastMod = m.init({
      toastsEl: $("#toasts"), esc, glyph, mascotHead, quiet, sayErr, rectOf, UNDO_MS,
      tipGone: el => tipMod?.gone(el),
      rest: () => { clearTimeout(qbSettle); const w = queueBar.querySelector(".qb-who[data-feel]"); if (w) { delete w.dataset.feel; w.innerHTML = mascotHead("rest"); } },
    })), () => { toastLoading = null; })).then(m => m && say(m));
  }
  /** Clear whatever is being said now, without ceremony. */
  const hush = () => toastMod?.hush();

  /** A copy, answered in the control that copied (docs/DESIGN.md §3.4): it
   *  waits for the clipboard to say yes, then the button reads "Copied" for
   *  1.2 s. With no button left to say it in -- a menu has closed, a line
   *  number was clicked -- a small "Copied" answers where the press was. */
  async function copied(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { return toast("Could not copy", { sub: `select and press ${keyHint("mod+c")}`, at: btn }); }
    if (!btn?.isConnected || btn.matches(".ln") || btn.dataset.copied) return toast("Copied", { sub: text, at: btn });
    const was = btn.innerHTML;
    btn.dataset.copied = 1; btn.textContent = "Copied";
    setTimeout(() => { btn.innerHTML = was; delete btn.dataset.copied; }, 1200);
  }
  /** Ask twice (docs/DESIGN.md §3.4), the one way: the first press arms the
   *  button -- it reads `label` ("Close desk?") and its tip says what the
   *  second press does ("Ends 3 panels · click again") -- and ARM_MS puts it
   *  back. True when this press is the second, and the thing should happen.
   *  `text` is the part of the button that carries its words. */
  const ARM_MS = 3000;
  function armed(b, { label, sub, text = b }) {
    if (b.dataset.armed) return true;
    const was = text.innerHTML, tip = b.dataset.tipSub, li = b.closest("li");
    b.dataset.armed = "1"; text.textContent = label; b.dataset.tipSub = `${sub} · click again`;
    li?.classList.add("arming");
    setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; text.innerHTML = was; tip ? (b.dataset.tipSub = tip) : delete b.dataset.tipSub; li?.classList.remove("arming"); } }, ARM_MS);
    return false;
  }
  /** The old order of arguments, for desk.js until it is moved onto toast()'s
   *  options with the rest of its sweep. */
  const toast4 = (title, sub, go, action, o) => toast(title, { sub, go, action, ...o });

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
    let lk;
    try { [palMod, lk] = await Promise.all([palLoading ||= import(`/assets/palette.js${boot.v ? `?v=${boot.v}` : ""}`), useLook()]); }
    catch (e) { palLoading = null; closeDialog(pal); toast("Could not open search", { sub: e }); return; }
    const { THEMES, slot, previewTheme, setTheme, loadThemes } = lk;
    palMod.open({ pal, input: $("#palette-input"), list: $("#palette-list"), state, capability, root, esc, rel, mascotHead, browsing, codePre,
      openDialog, closeDialog, THEMES, slot, previewTheme, setTheme, loadThemes, toggleQuiet, checkUpdates, panel, showHome, showInbox, act, gotoLine, showDesk, showBrowse, showDoc, showConnect, showStart, showWelcome, openHelp, places: deskPlaces });
  }
  const closePalette = () => { if (palMod) palMod.close(); };
  const browsing = () => state.view === "browse" && state.browseRoot;
  $("#btn-search").addEventListener("click", openPalette);

  // ---------- the look: theme, accent, font ----------
  /* The three steppers in the foot column and the loader for the themes
   * that are not in first paint are ui/look.js, fetched once the page is
   * idle, or sooner if the hand reaches the column or ⌘K opens. Until it is
   * in, the page wears what boot.js resolved, which is all first paint needs. */
  let look = null, lookLoading = null;
  const useLook = () => (lookLoading ||= import(`/assets/look.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (look = m.init({ root, $, store, boot, toast, control, onDesk, desk: () => desk, mmd: () => mmd, sayTermSize })), e => { lookLoading = null; throw e; }));
  (window.requestIdleCallback || setTimeout)(() => useLook().catch(() => {}), { timeout: 1500 });
  for (const ev of ["pointerenter", "focusin"]) $(".foot-set").addEventListener(ev, () => useLook().catch(() => {}));
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
    if (c === "wide") return w === "code" ? "already full width" : "";
    if (c === "wrap") return w === "desk" ? "not for desks, terminals always wrap" : docEl.querySelector("pre.code") ? "" : "no code on this page";
    return w === "code" ? "code is always monospace" : w === "list" ? "for documents" : "";
  }
  const btnOf = c => $(c === "font" ? "#btn-font" : c === "wide" ? "#btn-wide" : "#btn-wrap");
  function paintControls() {
    for (const c of Object.keys(NAMES)) {
      const b = btnOf(c), no = why(c);
      b.classList.toggle("dim", !!no);
      no ? b.setAttribute("aria-disabled", "true") : b.removeAttribute("aria-disabled");
      if (no) { b.dataset.tip = NAMES[c]; b.dataset.tipSub = no; } else delete b.dataset.tipSub;
    }
    if (!why("wide")) $("#btn-wide").dataset.tip = onDesk() ? "Focused panel in full view" : "Maximise width";
    if (!why("wrap")) $("#btn-wrap").dataset.tip = "Wrap long lines";
    if (!why("font")) look?.paintFontBtn();
  }
  /** Run a control, or say why it does nothing here, beside its button. */
  const control = (c, run) => () => {
    const no = why(c);
    no ? toast(NAMES[c], { sub: no, face: null }) : run();
    paintControls();
  };
  // It is only seen while the column is open, so that is when it is painted.
  $(".foot-set").addEventListener("pointerenter", paintControls);
  $(".foot-set").addEventListener("focusin", paintControls);
  /** A setting that is on or off says which, to the eye and to a reader. */
  const pressed = (b, on) => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); };
  function toggleWide() {
    if (onDesk()) { desk.zoomOn(); return; }
    const on = root.dataset.wide !== "1";
    on ? (root.dataset.wide = "1") : delete root.dataset.wide;
    store.set("snyvi.wide", on ? "1" : "0");
    pressed($("#btn-wide"), on);
  }
  $("#btn-wide").addEventListener("click", control("wide", toggleWide));
  pressed($("#btn-wide"), root.dataset.wide === "1");

  function toggleWrap() {
    const on = root.dataset.wrap !== "1";
    on ? (root.dataset.wrap = "1") : delete root.dataset.wrap;
    store.set("snyvi.wrap", on ? "1" : "0");
    pressed($("#btn-wrap"), on);
  }
  $("#btn-wrap").addEventListener("click", control("wrap", toggleWrap));
  pressed($("#btn-wrap"), root.dataset.wrap === "1");

  /** The terminal's text size, after Aa on a desk: the panels' text is the
   *  answer, and Aa's label, under the hand, names the size. */
  const sayTermSize = paintControls;
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
  /* The card opens at once with its title and foot; its rows of keys ride
   * with the about chunk (ui/about.js) and are put in the first time. */
  /** The shortcuts card opens filled: about.js fills it and carries its
   *  look, so the first `?` waits the moment it takes to arrive. */
  async function openHelp() { if (!help.querySelector(".hk")) await panel("help"); openDialog(help, help.firstElementChild); }
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
    // The sky is the sidebar, and a rail is 44 px of it.
    if (root.dataset.side === "0") { toast("Asteroids", { sub: sideNarrow.matches ? "needs a wider window" : `needs the sidebar open · ${keyHint("\\")}`, face: null }); return; }
    try { game = await (gameLoading ||= import(`/assets/game.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { gameLoading = null; toast("Could not start the game", { sub: e }); return; }
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
    catch (e) { panelLoading = null; toast("Could not open that panel", { sub: e }); return; }
    m.open(which, { $, openDialog, closeDialog, help, aboutDlg, resetDlg, plural, rel, capability, deskApi, sayErr, panel, showConnect, showStart, showWelcome });
  }
  // The shortcuts card's box, and its foot's buttons, are built and wired
  // by about.js (`fillHelp`), the first time it opens.

  // ---------- the contents on a narrow window ----------
  /* Past 1100 px the rail stops fitting beside the document and becomes a
   * sheet over it: `t` opens the sheet rather than changing the setting the
   * wide layout keeps, the button in #chrome does the same for a finger, and
   * Escape or a tap on the scrim closes it. The contents inside the sheet
   * open on the current section, which the hidden pane could not scroll to.
   * The sidebar has no sheet: narrow, it is its rail (below). */
  const railNarrow = matchMedia("(max-width: 1100px)"), sideNarrow = matchMedia("(max-width: 760px)");
  const sideEl = $("#side");
  let sheetOpener = null;
  function openSheet(which, opener) {
    if (root.dataset.sheet === which) return;
    sheetOpener = opener || document.activeElement;
    root.dataset.sheet = which;
    keepCurInView(true);
    (tocEl.querySelector("a.cur") || tocEl.querySelector("a") || metaEl.querySelector("button, a") || rail).focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!root.dataset.sheet) return false;
    delete root.dataset.sheet;
    const back = sheetOpener; sheetOpener = null;
    if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
    return true;
  }
  const toggleSheet = (which, opener) => root.dataset.sheet === which ? closeSheet() : openSheet(which, opener);
  $("#scrim").addEventListener("click", () => { closeSheet(); closePop(); });
  /** A pane folded (`t`, `\`, or the button at its top) at a width where it
   *  is a column, not a sheet. Remembered. The rail folds away and its
   *  button in #chrome is the way back; the sidebar folds to its rail, which
   *  is its own way back. Under 760 px the sidebar is only ever its rail,
   *  so there `\` has nothing to fold. */
  const fold = which => {
    if (which === "side") { closePop(false); if (sideNarrow.matches) return; if (game?.isOpen()) game.close(); }
    const off = root.dataset[which] !== "0";
    root.dataset[which] = off ? "0" : "1";
    store.set(`snyvi.${which}`, off ? "0" : "1");
    if (which === "side") paintSideBtn();
  };
  $("#btn-rail").addEventListener("click", e => railNarrow.matches ? toggleSheet("rail", e.currentTarget) : fold("rail"));
  // The button on the pane itself: puts it away, or, when the pane is a
  // sheet, closes the sheet and gives focus back to what opened it.
  $("#btn-rail-hide").addEventListener("click", () => railNarrow.matches ? closeSheet() : fold("rail"));
  $("#btn-side-hide").addEventListener("click", () => fold("side"));
  // The window grew past the width that made it a sheet: it is a pane again.
  railNarrow.addEventListener("change", () => { if (!railNarrow.matches) closeSheet(); });

  // ---------- the rail: the sidebar folded to its icons ----------
  /* Each icon opens its section in #pop, beside the rail: the section's own
   * element, moved in, and moved back to its place when the popover closes.
   * Every renderer writes by id, so what arrives while it is open lands in
   * the popover; #pop is inside #trees, so the clicks the tree delegates
   * still reach it. One at a time; Esc, a click outside it, a link followed
   * in it and `\` close it. The numbers on the icons are the ones the
   * sections say: waiting, panels waiting on you, agents connected. */
  const railNav = $("#rail-nav");
  ICONS.search = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>';
  for (const b of railNav.querySelectorAll("[data-ico]")) b.insertAdjacentHTML("afterbegin", icon(b.dataset.ico));
  /** A number on a rail icon; none at 0. Hoisted: the renderers call it at boot. */
  function badge(sel, n, cls = "") {
    const b = document.querySelector(`#rail-nav ${sel} .badge`);
    if (b) { b.textContent = n ? String(n) : ""; b.className = "badge" + cls; }
  }
  /* What the popover does -- open, close, what closes it -- is menu.js's
   * (`pop`, `unpop`), fetched on the first press of a rail icon: a reader
   * whose sidebar is never folded never pays for it. Open means loaded. */
  const closePop = (back = true) => !!root.dataset.pop && acts.unpop(back);
  railNav.addEventListener("click", e => {
    const b = e.target.closest("[data-pop]");
    if (b) useActs().then(m => m.pop(actsCtx, b.dataset.pop, b));
    else if (e.target.closest("#rail-search")) openPalette();
  });
  // A toolbar: the arrows walk it, Tab leaves it.
  railNav.addEventListener("keydown", e => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...railNav.querySelectorAll(".icon")].filter(x => x.offsetParent), i = all.indexOf(document.activeElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    e.preventDefault();
  });
  function paintSideBtn() {
    const b = $("#btn-side-hide"), slim = root.dataset.side === "0";
    b.dataset.tip = slim ? "Show sidebar" : "Hide sidebar";
    b.setAttribute("aria-label", slim ? "Show sidebar" : "Hide sidebar");
  }
  // Narrow, the sidebar is its rail; wide again, it is what the reader left it.
  const sideFits = () => {
    closePop(false);
    if (sideNarrow.matches) root.dataset.side = "0";
    else if (store.get("snyvi.side") !== "0") delete root.dataset.side;
    paintSideBtn();
  };
  sideNarrow.addEventListener("change", sideFits);
  sideFits();

  // ---------- the panes' widths ----------
  /* Dragging a pane's edge, and its keys, are look.js's: the edge fetches it
   * when the hand comes over it or the focus lands on it, which is before
   * any press can. */
  for (const g of document.querySelectorAll(".gutter")) for (const ev of ["pointerenter", "focus"]) g.addEventListener(ev, () => useLook().catch(() => {}), { once: true });

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

  /* What the letters act on, handed to keys.js with each one. */
  const keyCtx = { state, browsing, browseEl, showBrowse, order, siblings, showDoc, showCompare, togglePin, toggleSplit, togglePreview,
    openFind, deleteCurrent, openNext, showInbox, showHome, rawUrl, mmd: () => mmd,
    wide: () => control("wide", toggleWide)(), wrap: () => control("wrap", toggleWrap)(),
    rail: () => railNarrow.matches ? rail.classList.contains("empty") || toggleSheet("rail") : fold("rail"),
    side: () => closePop() || fold("side") };

  document.addEventListener("keydown", e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyB" && !inField) { e.preventDefault(); keys(!keysOn); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); return; }
    if (e.key === "Escape") {
      // Esc takes down whatever is over the page, one press for all of it;
      // only with nothing over it, and the hand in no field and no panel,
      // does it leave the page, the way its ✕ does.
      const over = keysOn || anyDialogOpen() || !!root.dataset.sheet || !!root.dataset.pop || !findBar.hidden || !!docEl.querySelector(".mmd[data-full]") || !!document.querySelector("#ctx:not([hidden])");
      keys(false);
      if (mmd) mmd.escape();
      closePalette(); closeDialog(help); closeDialog(aboutDlg); closeDialog(resetDlg); closeSheet(); closePop(); acts?.shut(); if (!findBar.hidden) { if (find) find.close(); else findBar.hidden = true; }
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
    // Undo: the one offer standing, whatever kind it is (offer()). The hand
    // goes here before it goes to the button.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "z" || e.key === "Z") && undoing) {
      e.preventDefault();
      undoing();
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    // `?` answers asleep too: the help box is where a reader finds out the
    // letters sleep at all, so the key that opens it cannot be one of them.
    if (e.key === "?") { e.preventDefault(); help.hidden ? openHelp() : closeDialog(help); return; }
    if (!keysOn) { if (e.key.length === 1 || e.key === "Delete") useKeys().then(m => m.hint(), () => {}); return; }
    // The letters themselves are keys.js's, which ⌃B fetched before any of
    // them could act; one pressed in the milliseconds before it landed is dropped.
    if (keyMode?.letter(e, keyCtx)) { keyMode.hit(); e.preventDefault(); }
  });

  // ---------- boot ----------
  if (state.view === "doc" && state.doc) {
    // Opened from a link -- an agent's, or the notification's -- so it is read.
    markRead(state.doc.id);
    // A page or a PDF opens as itself here too, not only from the sidebar.
    setPreview(boot.preview, boot.preview_url, "d:" + state.doc.id); applyPreview();
    document.title = state.doc.title; afterRender(); history.replaceState({ id: state.doc.id }, "", location.pathname + location.hash);
    // A link to a section: the browser's own fragment scroll aimed at a
    // placeholder, the same way a smooth scroll does. Land it properly.
    if (location.hash && !lineHash()) jumpToHash();
    // Opened afresh -- a restart, a link -- it goes back to where it was left.
    else if (!location.hash) { const was = places()[placeKey(state.doc)]; if (was && !was.end && was.i >= 0) placeAt(was); }
  }
  else if (state.view === "browse" && state.browseRoot) { showBrowse(state.browseRoot.id, state.browsePath, false); history.replaceState({ browse: state.browseRoot.id, path: state.browsePath }, "", location.pathname + location.hash); }
  else if (state.view === "connect") { showConnect(false); history.replaceState({ connect: true }, "", "/connect"); }
  else if (state.view === "start") { history.replaceState({ start: true }, "", "/start" + location.hash); showStart(false); }
  else if (state.view === "welcome") { history.replaceState({ welcome: true }, "", "/welcome"); showWelcome(false); }
  else if (state.view === "desk") { history.replaceState({ desk: boot.desk }, "", location.pathname); showDesk(boot.desk, false); }
  else if (state.view === "home") { history.replaceState({ home: true }, "", "/"); showHome(false); }
  else { showInbox(false); history.replaceState({ inbox: true }, "", location.pathname === "/" ? "/" : "/inbox"); }
  connect();
  loadDesks();
})();
