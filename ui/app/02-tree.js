/* ui/app/02-tree.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
  /* A section that starts folded -- Resting, which a panel moving on to its
   * next piece of work fills -- is in the set while the reader has it open:
   * the set is what differs from where each section starts, so a reader who
   * never folds anything stores nothing. */
  const FOLDED_FIRST = new Set(["rest"]);
  const isFolded = k => folded.has(k) !== FOLDED_FIRST.has(k);
  /* The desk's rail kept its folds apart, one key a section, until its
   * sections became these (docs/DESIGN.md §8.4): carried over, and the old
   * keys taken out, so it happens once and leaves nothing behind. */
  {
    const old = [["panels", "panels"], ["docs", "docs"], ["notes", "notes"], ["rest", "threads-rest"]].filter(([, was]) => store.get(`snyvi.dk.fold-${was}`) != null);
    for (const [k, was] of old) {
      const shut = store.get(`snyvi.dk.fold-${was}`) === "1" || (k === "rest" && store.get(`snyvi.dk.fold-${was}`) !== "0");
      if (shut !== FOLDED_FIRST.has(k)) folded.add(k);
      store.del(`snyvi.dk.fold-${was}`);
    }
    if (old.length && folded.size) save("snyvi.fold", folded);
  }
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
  const LEFT_SECS = ["inbox", "desks", "folders"];
  const applyFolds = () => { for (const k of LEFT_SECS) treesEl.classList.toggle(`fold-${k}`, folded.has(k)); };
  applyFolds();
  /** Fold a section or open it, on either side: one set, one key a section,
   *  and every head that names it told. A section of the desk's rail is a
   *  class on its own box, there and in the set; one of the sidebar's is a
   *  class on #trees. `fold` left out turns it over. */
  function toggleFold(key, fold = !isFolded(key)) {
    if (fold === isFolded(key)) return;
    if (!folded.delete(key)) folded.add(key);
    save("snyvi.fold", folded);
    for (const b of document.querySelectorAll(`[data-fold="${key}"]`)) b.setAttribute("aria-expanded", !fold);
    for (const s of document.querySelectorAll(`.sec[data-sec="${key}"]`)) s.classList.toggle("folded", fold);
    gapsLeft();
    if (!LEFT_SECS.includes(key)) return;
    applyFolds();
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
    plus: '<path d="M12 5v14M5 12h14"/>',
    widgets: '<rect x="3.5" y="3.5" width="17" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.8"/>',
    pin: '<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5zM12 13v7.5"/>',
    more: '<circle cx="6" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="18" cy="12" r=".8"/>',
    prev: '<path d="m15 6-6 6 6 6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
  };
  /** An icon at any size with the same 1.5 px line on screen: the drawings
   *  are on a 24 grid, so the stroke is scaled to the size asked for. */
  const icon = (k, px = 16, cls = "r-ico") => `<svg class="${cls}" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="${+(36 / px).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
  const glyph = (k, px = 12) => icon(k, px, "g-ico");
  /** A row that folds says so after its name, in the section heads' own
   *  chevron: every row reads icon, name, chevron (app.css, .s-chev). */
  const chev = `<span class="s-chev" aria-hidden="true"></span>`;
  /** Documents and files carry the document glyph, smaller and quieter
   *  than a row that holds things, so the left column is always an icon. */
  const docIco = () => icon("doc", 14);
  /** Rows on their way: two bars where the rows will be (docs/DESIGN.md
   *  §7.4), never a bare "…". They wait --sk-wait, so a fast answer shows none. */
  const skRows = `<li class="t-wait"><span class="sk-bar" style="width:62%"></span></li><li class="t-wait"><span class="sk-bar" style="width:44%"></span></li>`;
  /** A section's head (docs/DESIGN.md §8.4), the one both sidebars draw --
   *  desk.js has it as ctx.secHead. A quiet label that folds what is under
   *  it, its chevron shown on hover and while folded; then at the right, in
   *  this order, the count and the actions. The count stays while folded,
   *  so nothing waiting goes unseen; `tone` colours it (accent: something
   *  waits, warn: something is blocked). The actions show on hover and on
   *  focus, and always on an `empty` section, whose + is the way in.
   *  `fixed` is a section that never folds: no chevron, and not a button.
   *  `open` draws it open whatever the reader left it as (a panel's Undo
   *  is never out of reach). Tips are raw text; this escapes them. */
  function secHead(key, name, o = {}) {
    const open = !!o.open || !isFolded(key);
    const tip = (t, sub) => t ? ` data-tip="${esc(t)}"${sub ? ` data-tip-sub="${esc(sub)}"` : ""}` : "";
    const label = `<span class="sec-nm">${name}</span>`;
    const lead = o.fixed ? `<span class="sec-fold"${tip(o.tip, o.sub)}>${label}</span>`
      : `<button type="button" class="sec-fold" data-fold="${key}" aria-expanded="${open}"${tip(o.tip, o.sub)}>${label}${chev}</button>`;
    const n = o.count == null || o.count === "" ? "" : `<span class="sec-n${o.tone ? ` ${o.tone}` : ""}${o.foldOnly ? " fold-only" : ""}"${tip(o.countTip)}>${o.count}</span>`;
    return `<div class="sec-head${o.empty ? " empty" : ""}" data-sec="${key}"${o.part ? ` data-part="${o.part}"` : ""}>${lead}${n}${o.acts ? `<span class="sec-acts">${o.acts}</span>` : ""}</div>`;
  }
  /** Whether a section is drawn folded: the reader's fold, unless `open`. */
  const secFolded = (key, open) => !open && isFolded(key);

  // ---------- the layout ----------
  /* Which sections each side has, in what order, and which are hidden
   * (src/widget.rs `Layout`): the reader's, arranged on /sidebars, one for
   * every page, and moved in place when it changes (the `layout` event).
   * The left's sections are these nodes -- the Inbox is three -- and its
   * rail icons; a hidden one is out of the page, and every renderer still
   * writes to it by id, so showing it again draws nothing. */
  const widgetsEl = $("#widgets-nav");
  let layout = boot.layout || { left: ["inbox", "desks", "folders", "widgets"], right: [], hidden: [] };
  const LEFT_NODES = { inbox: [inboxRowEl, queueEl, treeEl], desks: [$("#desk-nav")], folders: [browseEl], widgets: [widgetsEl] };
  const LEFT_ICONS = { inbox: ['[data-pop="inbox"]', '[data-pop="tree"]'], desks: ['[data-pop="desks"]'], folders: ['[data-pop="browse"]'], widgets: ['[data-pop="widgets"]'] };
  /** The global widgets the reader has not switched off, in their order. */
  const globalSeats = () => (state.widgets || []).filter(w => !w.hidden);
  const offLeft = id => layout.hidden.includes(id) || (id === "widgets" && (layout.hidden.includes("left:widgets") || !globalSeats().length));
  function placeLeft() {
    const pop = $("#pop"), nav = $("#rail-nav"), live = $("#rail-live");
    for (const id of layout.left) {
      // One in the rail's popover is put back by menu.js, in this order.
      for (const n of LEFT_NODES[id] || []) { if (n.parentElement === treesEl) treesEl.insertBefore(n, pop); n.classList.toggle("lay-off", offLeft(id)); }
      for (const sel of LEFT_ICONS[id] || []) { const b = nav.querySelector(sel); if (b) { nav.insertBefore(b, live); b.classList.toggle("lay-off", offLeft(id)); } }
    }
    treesEl.dataset.order = layout.left.flatMap(id => (LEFT_NODES[id] || []).map(n => `#${n.id}`)).join(" ");
    gapsLeft();
  }
  /** The room above each of the left's heads (app.css): 4 px for the first,
   *  2 after a folded section, 16 after an open one. The Inbox is three
   *  nodes and the widgets one per widget, so it is said with a class on
   *  each section's first node rather than with a sibling selector. */
  function gapsLeft() {
    const shown = layout.left.filter(id => !offLeft(id));
    const foldedAt = id => id === "widgets" ? !!widgetsEl.lastElementChild?.classList.contains("folded") : folded.has(id);
    shown.forEach((id, i) => {
      const n = LEFT_NODES[id][0];
      n.classList.toggle("sec-first", i === 0);
      n.classList.toggle("sec-after-fold", i > 0 && foldedAt(shown[i - 1]));
    });
  }
  /** A new layout, from /sidebars here or in another window. */
  function setLayout(l) {
    if (!l || !Array.isArray(l.left)) return;
    layout = l;
    placeLeft();
    // The Inbox's room is what the sections under it leave.
    if (capSeen != null) { renderTree(); markActive(); }
  }

  // ---------- widgets ----------
  /** A widget's title, from its name: `deploy-status` is "Deploy status". */
  const wTitle = n => (n.charAt(0).toUpperCase() + n.slice(1)).replace(/-/g, " ");
  /** Whether a body is past the time it said it is good for. */
  const wStale = w => w.stale_after > 0 && Date.now() / 1000 - w.updated_at > w.stale_after;
  const W_TONE = { ok: "ok", warn: "warn", bad: "bad" };
  /** A widget's seat (docs/WIDGETS.md), on either side -- desk.js has it as
   *  ctx.seatFrame: a section like any other, so it folds and spaces itself
   *  as they do, and under its head who wrote it and when. Its body keeps a
   *  fixed room, `lines` × 20 px, so a new one never moves what is under
   *  it; a longer one opens where it is when clicked. A failed run says so
   *  over the last good body, which stays. Past its time it dims. The body
   *  is the daemon's, drawn strictly (src/render.rs `widget_md`).
   *  The frame is drawn with what never changes -- the name, the fold -- and
   *  the rest is patched into it (`patchSeat`), so an update to a body is
   *  never a redraw of the side it is on. */
  function seatFrame(w) {
    const key = `w:${w.name}`;
    return `<section class="sec wg${secFolded(key) ? " folded" : ""}" id="wg-${w.desk_id}-${w.name}" data-sec="${key}" data-w="${w.name}">` +
      secHead(key, wTitle(w.name), { tip: wTitle(w.name), sub: w.source === "file" ? "A widget file, run while it is in view" : "Set by an agent or a script" }) +
      `<div class="sec-body"></div></section>`;
  }
  /** What a seat's body holds, apart, so an update patches it in place. */
  /** A widget file that waits on the reader: never run (`allow:`), or
   *  changed since it was allowed (`changed:`) -- src/server/widget_run.rs.
   *  Its seat asks, with the button that answers; only the window can. */
  const wAsks = w => /^(allow|changed): /.test(w.error || "");
  const seatInner = w => `<p class="wg-by">${esc(w.writer || w.source)} · <span class="wg-age" data-t="${w.updated_at}">${relShort(w.updated_at)}</span></p>` +
    (wAsks(w) ? `<p class="wg-ask" role="status">${esc(w.error.replace(/^\w+: /, ""))}<button type="button" class="wg-allow" data-wallow="${w.name}" data-tip="Allow it to run" data-tip-sub="Again whenever its folder changes, unless Rerun my edits is on for it on /sidebars. Only the snyvi window can allow">Allow</button></p>`
      : w.error ? `<p class="wg-err" role="status">${esc(w.error)}</p>` : "") +
    `<div class="wg-body" style="--lines:${w.lines}">${w.html}</div>`;
  /** The global widgets, drawn whole: on the first paint, and when one
   *  comes or goes. A body that changed is patched (`patchSeat`). */
  function drawWidgets() {
    const seats = globalSeats(), h = seats.map(seatFrame).join("");
    if (widgetsEl.$html !== h) widgetsEl.innerHTML = widgetsEl.$html = h;
    for (const w of seats) { const el = document.getElementById(`wg-0-${w.name}`); if (el) patchSeat(el, w); }
    placeLeft();
  }
  /** Allow a widget file to run, from its seat: the window's capability,
   *  which a tab has not. Its next run, a moment later, fills the seat. */
  async function allowWidget(b) {
    b.disabled = true;
    try { await deskApi(`/api/widgets/${b.dataset.wallow}/allow`, {}); b.textContent = "Allowed"; }
    catch { b.disabled = false; toast("Allow works in the snyvi window", { sub: "A tab cannot let a command run" }); }
  }
  /** A global widget changed (the `widget` event): patched where it stands,
   *  or the slot drawn again when one came, went or was switched off. */
  function widgetSaid(j) {
    const i = state.widgets.findIndex(w => w.name === j.name), was = i >= 0 ? state.widgets[i] : null;
    if (j.cleared) { if (was) { state.widgets.splice(i, 1); drawWidgets(); } return; }
    if (was) state.widgets[i] = j; else state.widgets.push(j);
    const el = document.getElementById(`wg-0-${j.name}`);
    if (was && was.hidden === j.hidden && el) patchSeat(el, j); else drawWidgets();
  }
  /** One seat's body, its count and its tone, changed where it stands: the
   *  sidebar is not redrawn, so nothing takes the focus or the scroll. */
  function patchSeat(el, w) {
    const body = el.querySelector(":scope > .sec-body");
    if (!body) return false;
    body.innerHTML = seatInner(w);
    el.classList.toggle("stale", wStale(w));
    const head = el.querySelector(":scope > .sec-head"), n = head.querySelector(".sec-n"), tone = W_TONE[w.tone] || "";
    if (w.count) {
      const c = n || head.insertBefore(document.createElement("span"), head.querySelector(".sec-acts"));
      c.className = `sec-n${tone ? ` ${tone}` : ""}`; c.textContent = w.count;
    } else n?.remove();
    return true;
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
  /** Told whenever the page may have moved (`markActive`): the focus beacon
   *  (05-notes.js) says which desk the page shows, for the widgets that run
   *  only while one is in view. A hook, so this part need not know it. */
  let onPlace = () => {};
  function markActive() {
    onPlace();
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
  /** A folder's key, for comparing and never for showing. On Windows the
   *  daemon has spelled roots with `\\?\`, and a drive path is one place in
   *  either slash and any case; elsewhere only a trailing slash is not
   *  another place. */
  const pathKey = p => !p ? p : /^(\\\\\?\\)?[A-Za-z]:[\\/]/.test(p)
    ? p.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/(.)\\+$/, "$1").toLowerCase()
    : p.replace(/(.)\/+$/, "$1");
  /** A folder as the reader spelled it, less the `\\?\` Windows' API put on it. */
  const shown = p => p && p.replace(/^\\\\\?\\/, "");
  /** A folder under the home folder, as `~` and the rest. */
  const tilde = p => {
    const home = state.desks && state.desks.home, h = pathKey(home), k = pathKey(p);
    if (!h || !k) return shown(p);
    if (k === h) return "~";
    // pathKey changes no length but the prefix's and the trailing slashes',
    // so the home folder's key is as long as its start in `shown(p)`.
    return k.startsWith(h + (/^[a-z]:/.test(h) ? "\\" : "/")) ? "~" + shown(p).slice(h.length) : shown(p);
  };
  /** One folder however it was spelled. */
  const sameRoot = (a, b) => !!a && !!b && pathKey(a) === pathKey(b);
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

  /** What a row says its document weighs, when the daemon said: the hover
   *  prefetch in 07-nav.js leaves a long one for the click. */
  const sizeOf = d => d.size ? ` data-size="${d.size}"` : "";
  const docRow = d => {
    noteKnown(d);
    const ago = relShort(d.received_at);
    // Not "active": markActive puts that on, so the rows a reader moves between
    // draw the same and a move between two of them costs no redraw.
    const cls = waitingRow(d) ? "new" : "";
    return `<li class="t-doc${washCls(d.id)}"${moment(d.id)}><a href="/d/${d.id}" class="${cls}" data-id="${d.id}"${sizeOf(d)}${cut(d, mid(d.title, roomFor(ago)))}>${docIco()}<span class="title">${esc(mid(d.title, roomFor(ago)))}</span>${d.pinned ? `<span class="pin" data-tip="Pinned" data-tip-sub="kept by prune">${glyph("pin", 11)}</span>` : ""}<span class="k">${ago}</span>${removeBtn(d)}</a></li>`;
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
