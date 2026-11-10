/* ui/app/03-queue.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
  // ---------- the queue ----------
  /* What arrived and has not been opened, newest first (1.33: an agent's
   * "it is waiting" is the top row, not the seventh behind "N more"). An arrival
   * joins it and an open leaves it, wherever the open came from: it is the
   * unread set with an order, not a second list to keep. It never takes the
   * page away from a reader. Before 0.14 an arrival opened itself whenever
   * the reader had gone 2.5 s without touching anything -- which is what
   * reading a paragraph looks like -- and with several agents sending, the
   * document changed under them many times an hour. Now it is Recent, lit,
   * in the sidebar, a bar above the document, and `n`. It was once a list
   * of its own there too, Waiting, under Recent: the same documents twice,
   * and the bar already says what arrived. */
  /** One GET, as JSON, or null: what every ask of the daemon below wants. */
  const getJson = async u => { try { return await (await fetch(u)).json(); } catch { return null; } };
  const QUEUE_HELD = 24;   // what a page opens with and keeps; the count is the daemon's, whatever is held
  /** Whether a row is on the queue: held here, or marked by the daemon on a
   *  row fetched with its project. */
  const waitingRow = d => queueIds.has(d.id) || !!d.unread;
  /** Rows fetched with their projects carry the daemon's mark; when a read
   *  happens here, the mark comes off here too, rather than a refetch. */
  function unmarkRows(ids) {
    for (const wfs of state.sub.values()) for (const w of wfs) for (const d of w.docs) if (d.unread && (!ids || ids.has(d.id))) d.unread = false;
  }
  /** Fewer held than are waiting, and room to hold more: ask for the newest
   *  again. A moment later, so a burst of twelve is one ask and not twelve. */
  let holdTimer = 0;
  function holdQueue() {
    if (state.queue.length >= QUEUE_HELD || state.waiting <= state.queue.length) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(async () => {
      const q = await getJson(`/api/queue?limit=${QUEUE_HELD}`);
      if (Array.isArray(q)) { state.queue = q; renderTree(); markActive(); if (state.view === "inbox") showInbox(false); }
    }, 150);
  }

  /* ---------- what moved, and when ----------
   * The sidebar is rebuilt from state whenever the library moves, so a row
   * has no life of its own to animate: an arrival is a row that was not there
   * a render ago. It is kept here for as long as its wash lasts, with the
   * moment it came, and a row that is rebuilt mid-wash starts its animation
   * at a negative delay -- where the last one was -- rather than from the
   * top. So an arrival washes once, whatever the tree does underneath.
   * LEAVE_MS is how long a removed row's ghost takes to close. */
  const WASH_MS = 700, LEAVE_MS = 140;
  const washes = new Map();   // id -> when it arrived, or came back
  let sweep = 0;
  /** A style that starts this row's animation where the last render left it. */
  function moment(id) {
    const t = washes.get(id);
    if (t == null) return "";
    return ` style="animation-delay:-${Date.now() - t}ms"`;
  }
  const washCls = id => (washes.has(id) ? " wash" : "");
  /** Mark rows to be washed, once, on the next render. */
  function wash(ids) {
    const now = Date.now();
    for (const id of ids) washes.set(id, now);
    schedule();
  }
  /** A re-render when the next wash is over, to draw what state says and
   *  nothing more -- the render drops what has finished -- and then the one
   *  after, the earliest first. */
  function schedule() {
    clearTimeout(sweep);
    const now = Date.now();
    const due = [...washes.values()].map(t => WASH_MS - (now - t));
    if (!due.length) return;
    sweep = setTimeout(() => { renderTree(); markActive(); schedule(); }, Math.max(0, Math.min(...due)) + 40);
  }
  const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

  /** Recent's count in the sidebar and the bar above the document, both
   *  from the same rows. The bar is not drawn on the inbox, which lists the
   *  queue itself, nor on a desk. */
  let qbGhost = null;   // Mark all read, answered by the bar itself: { n, undo, clock }
  let qbWas = 0, qbSettle = 0, waitedWas = 0;   // the bar's count last drawn, the face's way back to rest, and the count last seen
  // The bar's ✕ hides it, read nothing, until the next arrival.
  let arrivals = 0, qbShut = -1;
  let qbAt = null;   // the waiting document the bar shows, by id; null is the newest
  /* ‹ › page through what was waiting, opening each one: the bar sits over a
   * document, and a pager there that only turned its own label read as
   * broken. An open is a read, which takes the document off the queue, so
   * the pages are a snapshot taken at the first step -- the count stays the
   * place in that batch and ‹ goes back to one just read. An arrival joins
   * the end. The batch ends when the reader goes anywhere else, or on ✕. */
  let qbBatch = null;   // [{ id, title, project }] since the first step; null when not paging
  let qbGoing = null;   // the batch's document being opened, so the page left behind does not end it
  const qbRow = ({ id, title, project }) => ({ id, title, project });
  /** ‹ or › on the bar: the one before or after, round the ends, opened. */
  function qbStep(by) {
    const b = qbBatch || state.queue.map(qbRow), n = b.length;
    if (n < 2) return;
    qbBatch = b;
    const i = Math.max(0, b.findIndex(d => d.id === qbAt));
    const id = qbAt = qbGoing = b[(i + by + n) % n].id;
    renderQueue();
    showDoc(id, true).finally(() => { if (qbGoing === id) qbGoing = null; renderQueue(); });
  }
  // ← → on one of the bar's buttons step it as ‹ › do; the page's keys are not told.
  queueBar.addEventListener("keydown", e => {
    if (!/^Arrow(Left|Right)$/.test(e.key) || e.altKey || e.ctrlKey || e.metaKey || !queueBar.querySelector(".qb:not(.ghost)")) return;
    e.preventDefault(); e.stopPropagation();
    qbStep(e.key === "ArrowLeft" ? -1 : 1);
  });
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
    // What has finished washing is dropped here, at the render, and not only
    // at the sweep: a sweep is put off by every arrival, and a row that had
    // washed was otherwise drawn again, washing, until one ran.
    const now = Date.now();
    for (const [id, t] of washes) if (now - t >= WASH_MS) washes.delete(id);
    const n = state.waiting, head = state.queue[0];
    badge('[data-pop="inbox"]', n);
    drawInbox(n);
    // The last one waiting was read: the one moment snyvi shows love, on the
    // mark, for as long as a face's moment lasts (§2.2).
    if (!n && waitedWas && !quiet()) { root.dataset.cleared = "1"; setTimeout(() => delete root.dataset.cleared, 2400); }
    waitedWas = n;
    // Marked read from the bar: the bar says so and holds the Undo, in the
    // same card at the same place, until the drain runs out (DESIGN §4.4).
    // Not on a desk (1.32): there the bar lay over the desk's head -- its
    // folder, Left off and the window's drag grip -- with other desks'
    // documents in it, and said again what the rail's Docs says. A desk's
    // own arrivals are at the top of its rail's Documents, marked new; the
    // rest light Recent in the sidebar. Audit dc5adb4641. Nor on Home (1.32): it lay under
    // Home's own sticky note bar and said again what Arrived and the status
    // line say. Audit 67d008cb6f.
    const off = state.view === "inbox" || state.view === "desk" || state.view === "home";
    if (qbGhost && !off) {
      queueBar.hidden = false;
      if (!queueBar.querySelector(".qb.ghost")) queueBar.innerHTML = `<div class="qb ghost" role="status" style="--undo-left:${qbGhost.clock.left()}"><span class="qb-next">Marked ${qbGhost.n} read</span><button type="button" class="t-undo" data-q="undo">Undo<kbd>${esc(keyHint("mod+z"))}</kbd></button></div>`;
      qbWas = 0;
      return;
    }
    // A batch outlives the page only while that page is one of its own.
    if (qbBatch && !qbGoing && !(state.view === "doc" && qbBatch.some(d => d.id === state.doc?.id))) qbBatch = null;
    if (qbBatch) for (const d of state.queue) if (!qbBatch.some(x => x.id === d.id)) qbBatch.push(qbRow(d));
    const bar = (!!qbBatch || (n > 0 && !!head)) && !off && qbShut !== arrivals;
    queueBar.hidden = !bar;
    if (!bar) { queueBar.innerHTML = ""; qbWas = 0; qbBatch = null; return; }
    // The bar rises when it appears and stays put after: a count that changes
    // ticks in place. It used to be rebuilt on every render, which re-ran the
    // rise for one more arrival, and twelve arrivals rose twelve times.
    // ‹ › step through what this page holds (#100), by id: an arrival or a
    // read elsewhere leaves the one shown where it is, and if it goes, the
    // bar is back on the newest.
    // Paging, the figure is the place in the batch, which is also what ‹ ›
    // step through; it was the daemon's count while they stepped through the
    // rows held here, and past QUEUE_HELD the two parted.
    const rows = qbBatch || state.queue, total = qbBatch ? rows.length : n;
    let at = qbAt ? rows.findIndex(d => d.id === qbAt) : 0;
    if (at < 0) { at = 0; qbAt = null; }
    const cur = rows[at], one = rows.length < 2;
    const count = one ? `${n} waiting` : `${at + 1}/${total}`, next = `<b>${esc(cur.title)}</b> · ${esc(cur.project)}`;
    // The bar, not the Marked-read ghost that stood in its place: a ghost
    // found here was taken for the bar, lost its words to the next title and
    // threw on its missing count -- inside the Undo, before it could ask.
    const qb = queueBar.querySelector(".qb:not(.ghost)");
    // The bar is snyvi holding what came for the reader, so it is snyvi's
    // face at the front of it: the same head that answers a click, at the
    // top of the page. It arrives wide-eyed and settles into a smile.
    if (!qb) {
      queueBar.innerHTML = `<div class="qb${one ? " one" : ""}"><span class="qb-who"></span>` +
        `<button type="button" class="icon qb-step" data-q="prev" data-tip="Open the previous one" aria-label="Open the previous one waiting">${glyph("prev", 14)}</button><span class="qb-n">${count}</span>` +
        `<button type="button" class="icon qb-step" data-q="step" data-tip="Open the next one" aria-label="Open the next one waiting">${glyph("next", 14)}</button><span class="qb-next">${next}</span>` +
        `<button type="button" data-q="next" data-tip="Open this one" data-tip-sub="n opens the newest · letter keys: Ctrl B turns them on">Open<kbd class="lk">n</kbd></button><a href="/inbox?recent" class="qb-all" data-nav="inbox">Show all</a>` +
        `<button type="button" class="icon" data-q="clear" data-tip="Mark all read" aria-label="Mark all read">${glyph("checks", 14)}</button>` +
        `<button type="button" class="icon" data-q="shut" data-tip="Hide this bar" data-tip-sub="they stay lit in the Inbox" aria-label="Hide this bar">${glyph("x", 14)}</button></div>`;
      qbFeel("whoa");
      qbWas = total;
      return;
    }
    const num = qb.querySelector(".qb-n"), nx = qb.querySelector(".qb-next");
    qb.classList.toggle("one", one);
    if (nx.innerHTML !== next) nx.innerHTML = next;
    // A step changes the figure and is not news: it is written, not ticked.
    if (num.textContent !== count && total === qbWas) num.textContent = count;
    else if (num.textContent !== count) {
      num.textContent = count;
      // Restarted by replacing the node: a class taken off and put back in
      // one task runs nothing, and reading layout in between costs a reflow.
      const fresh = num.cloneNode(true);
      fresh.classList.add("tick");
      num.replaceWith(fresh);
      // One more is a surprise; one fewer is a read, which happens tens of
      // times a day and moves nothing (docs/DESIGN.md §7.2).
      if (total > qbWas) qbFeel("whoa");
    }
    qbWas = total;
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
    if (held) { state.queue = state.queue.filter(d => d.id !== id); queueIds.delete(id); }
    unmarkRows(new Set([id]));
    state.waiting = Math.max(0, state.waiting - 1);
    renderTree(); markActive();   // now, so the row is drawn closing rather than found gone
    fetch(`/api/docs/${id}/read`, { method: "POST" }).catch(() => {});
  }

  /** `n`: the newest waiting document, the one an agent just said is there.
   *  Opening it takes it off, so the next `n` is the one before it; a reader
   *  drains the queue with one key. */
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
    state.queue = []; state.waiting = 0; qbBatch = null;
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
      if (w === "dir") browseMod?.fill(browseCtx(), rt.closest(".b-tree")); else if (w === "inbox") showInbox(false); else if (w === "home") showHome(false); else if (w === "tree") refreshTree(); else if (w === "desks") loadDesks();
      return;
    }
    // The Inbox page's ghost answers as the sidebar's does (treesEl's click).
    if (e.target.closest("#doc [data-undoc]")) {
      e.preventDefault();
      if (gone && Date.now() - gone.made > 350) undoGone(gone);
      return;
    }
    const b = e.target.closest("[data-q]");
    if (!b) return;
    e.preventDefault();
    // Paging, the one the bar shows is already open: Open is `n` again, the newest unread.
    if (b.dataset.q === "next") { const id = qbBatch ? null : qbAt; qbAt = null; qbBatch = null; id ? showDoc(id, true) : (openNext(), renderQueue()); }
    else if (b.dataset.q === "prev" || b.dataset.q === "step") qbStep(b.dataset.q === "prev" ? -1 : 1);
    else if (b.dataset.q === "clear") clearQueue();
    else if (b.dataset.q === "undo") qbGhost?.undo();
    else if (b.dataset.q === "shut") { qbShut = arrivals; qbBatch = null; renderQueue(); }
  });

  /* ---------- the Inbox: one list ----------
   * The Inbox is every document in one list, newest first, each row saying
   * its project under its title (#206; mockups 6e193a899f). It was a tree of
   * projects, and a document was two clicks under its project -- after a
   * project row that said only when it last heard. Live data had 60
   * documents from 11 projects in 28 hours, in 43 runs, so the list names
   * the project on every row rather than once above a run.
   *
   * What it shows is the reader's: what waits or everything, and one project
   * or all of them (`see`, 02-tree.js), with a find box over the list that
   * narrows it by title and project as they type. Ctrl K is still the search
   * inside documents; the find box hands its words there when they find
   * nothing here. One row a title in a project: a file sent again is one row
   * already (`head_docs`), and two documents with one title in one project
   * are the same thing to a reader -- the older is on the All page. */
  const LIST_HELD = 100;   // what the page holds and the find box looks through
  let listOff = false;
  /** The newest documents, from the daemon, for the list and the find box. */
  async function refreshList() {
    const j = await getJson(`/api/inbox?limit=${LIST_HELD}`);
    listOff = !Array.isArray(j) && !state.list;
    if (Array.isArray(j)) state.list = j;
  }
  /** A document the stream says is in, put in the list where it belongs: a
   *  save in place, a draft, an arrival -- one row a file, the newest. */
  // A board's section is not the Inbox's (1.62, V5): its read leaves them
  // out (store.rs `inbox`), and so does an arrival.
  function listPut(d) {
    if (!state.list || !d || d.origin === "board") return;
    const same = x => x.id === d.id || (!!d.source_path && x.project_id === d.project_id && x.source_path === d.source_path);
    state.list = [d, ...state.list.filter(x => !same(x))].sort((a, b) => b.received_at - a.received_at);
  }
  /** The project `see` names, while there is one. */
  const seenProj = () => see.proj && state.tree.find(p => String(p.id) === see.proj);
  /** Where the rows come from, before the find box: what waits, the one
   *  project's own (fetched as the tree's were), or the newest of all. Null
   *  while they are on their way. */
  function listSource() {
    const p = seenProj();
    if (see.wait) return p ? state.queue.filter(d => String(d.project_id) === see.proj) : state.queue;
    if (!p) return state.list && state.list.filter(d => !away.has(String(d.project_id)));
    const wfs = state.sub.get(see.proj);
    // A fill that failed once is not asked again by a draw: its list is empty.
    if (!wfs) { fillProject(see.proj); return filling.has(see.proj) ? null : []; }
    return wfs.flatMap(w => w.docs).map(d => ({ ...d, project_id: p.id, project: p.name })).sort((a, b) => b.received_at - a.received_at);
  }
  function listRows() {
    let ds = listSource();
    if (!ds) return null;
    const q = see.q.trim().toLowerCase();
    if (q) ds = ds.filter(d => String(d.title).toLowerCase().includes(q) || String(d.project || "").toLowerCase().includes(q));
    const seen = new Set();
    ds = ds.filter(d => { const k = `${d.project_id}\n${d.title}`; return !seen.has(k) && seen.add(k); });
    // Under the reader's pointer the rows keep the order they had and take
    // no newcomer: an arrival moved every row down one while the reader
    // reached for one, and the click landed on its neighbour (audit
    // 67d008cb6f). The rest come in when the pointer leaves (`sideEl`).
    if (frozen && frozen.size && sideEl.matches(":hover")) ds = ds.filter(d => frozen.has(d.id)).sort((a, b) => frozen.get(a.id) - frozen.get(b.id));
    return ds;
  }
  let frozen = null;
  const sideEl = $("#side");
  /** The rows' order, held while the pointer is over the sidebar: taken
   *  when it comes in, and again after the reader changes what the list
   *  shows -- their click is what moved it, and the next arrival must not. */
  const freeze = () => { frozen = sideEl.matches(":hover") ? new Map((listSource() || []).map((d, i) => [d.id, i])) : null; };
  sideEl.addEventListener("pointerenter", () => freeze());
  sideEl.addEventListener("pointerleave", () => { frozen = null; drawnTree = null; renderTree(); markActive(); });
  /** A change of what the list shows: the reader's, so kept, and the
   *  pointer's hold on the old order let go -- it is their click that moved it. */
  function seeInbox(ch) {
    Object.assign(see, ch);
    if (see.proj && !liftedCaps.has(see.proj)) { liftedCaps.add(see.proj); if (state.sub.has(see.proj)) fillProject(see.proj, true); }
    store.set("snyvi.see", see.proj); store.set("snyvi.seeWait", see.wait ? "1" : "");
    freeze();
    renderTree(); markActive();
  }
  /** The find box's words, as a search inside every document (Ctrl K). */
  function searchFor(q) {
    openPalette();
    const i = $("#palette-input");
    i.value = q; i.dispatchEvent(new Event("input"));
  }

  let drawnTree = null, drawnInbox = null, drawnTok = null, recutDone = true;
  const treeTouched = new MutationObserver(() => { drawnTree = null; });
  treeTouched.observe(treeEl, { childList: true, subtree: true });
  /** How many rows the list shows: a fixed CAP_MAX, so a tall window does
   *  not turn the sidebar into one long list (the reader's ask, 1.58: the
   *  rest is one click away in All documents). Fewer when they do not fit
   *  between what stands above it (the head and the find box) and what must
   *  stay on screen below it (every section after the Inbox, down to the
   *  last one's head), less the foot row; measured, because each of those
   *  changes it; never fewer than three. A row is two lines, 40 px (app.css
   *  .t-doc a). */
  const ROW_H = 40, FOOT_H = 26, MIN_CAP = 3, CAP_MAX = 8;
  function inboxCap() {
    const room = treesEl.clientHeight;
    if (!room || root.dataset.side === "0" || folded.has("inbox")) return CAP_MAX;
    const after = layout.left.slice(layout.left.indexOf("inbox") + 1).filter(id => !offLeft(id));
    const fh = after.map(id => LEFT_NODES[id][0].querySelector(".sec-head")).filter(Boolean).pop();
    const port = treesEl.getBoundingClientRect(), at = treeEl.getBoundingClientRect();
    const above = at.top - port.top + treesEl.scrollTop;
    const below = fh ? fh.getBoundingClientRect().bottom - at.bottom : 0;
    return Math.min(CAP_MAX, Math.max(MIN_CAP, Math.floor((room - above - below - 8 - FOOT_H) / ROW_H)));
  }
  /* The head and the find box are made once and written into, so a count
   * changing never takes the field out from under a reader typing in it. */
  inboxRowEl.innerHTML = `<div class="ib-head"></div><label class="ib-find">${icon("find", 14)}<span class="ib-tok"></span><input type="search" placeholder="Find a document" aria-label="Find a document in the Inbox" spellcheck="false" autocomplete="off"></label>`;
  const ibHead = inboxRowEl.firstElementChild, ibTok = inboxRowEl.querySelector(".ib-tok"), ibIn = inboxRowEl.querySelector("input");
  ibIn.addEventListener("input", () => { see.q = ibIn.value; renderTree(); markActive(); });
  ibIn.addEventListener("keydown", e => {
    const first = () => treeEl.querySelector("a[data-id]");
    if (e.key === "Escape" && ibIn.value) { e.preventDefault(); e.stopPropagation(); ibIn.value = see.q = ""; renderTree(); markActive(); }
    else if (e.key === "Enter" && first()) { e.preventDefault(); first().click(); }
    else if (e.key === "ArrowDown" && first()) { e.preventDefault(); first().focus(); }
  });
  /** The Inbox's head: how many wait, in the accent; the filter, lit while
   *  it holds anything back; and All, the whole library on its own page.
   *  And in the find box, what the filter holds the list to, each with its
   *  ✕. Written only when it changed, as every section is. */
  function drawInbox(waiting = state.waiting) {
    const total = state.tree.reduce((k, p) => k + p.docs, 0), p = seenProj(), on = !!p || see.wait;
    const all = `<a class="sec-all" href="/inbox" data-nav="inbox" data-tip="All documents" data-tip-sub="${plural(total, "document")} · what waits, then every project, newest first">All</a>`;
    const ibf = `<button type="button" class="ib-f${on ? " on" : ""}" data-ibf data-tip="Show" data-tip-sub="what waits or everything · one project or all" aria-label="Filter the Inbox">${glyph("funnel", 14)}</button>`;
    const inbox = secHead("inbox", "Inbox", { count: waiting || "", tone: "accent", countTip: waiting ? `${waiting} waiting to be read` : "", acts: ibf, end: all });
    if (inbox !== drawnInbox) ibHead.innerHTML = drawnInbox = inbox;
    const x = (k, say) => `<button type="button" data-unsee="${k}" aria-label="${say}">${glyph("x", 10)}</button>`;
    const tok = (see.wait ? `<span class="tok">Waiting${x("wait", "Show everything")}</span>` : "") +
      (p ? `<span class="tok" data-only="${p.id}"><span class="nm">${esc(p.name)}</span>${x("proj", "Show every project")}</span>` : "");
    if (tok !== drawnTok) { ibTok.innerHTML = drawnTok = tok; ibIn.placeholder = on ? "Find in these" : "Find a document"; }
  }
  /** The row under the list: the way to the rest of what it shows, when
   *  there is more than fits or the find box found nothing here -- and the
   *  projects taken out of it, one click from coming back. It is always
   *  there, at one height, so nothing under it moves when what it says
   *  changes; a project just hidden holds its Undo in it. */
  function listFoot(more, none) {
    if (awayJust) {
      const p = state.tree.find(x => String(x.id) === awayJust);
      return `<div class="t-back" role="status" style="--undo-left:${awayClock?.left() ?? 1}"><span class="nm">${esc(p ? p.name : "Project")} hidden</span><button type="button" class="t-undo" data-back="${awayJust}">Undo</button></div>`;
    }
    const q = see.q.trim(), p = seenProj(), put = state.tree.filter(x => away.has(String(x.id))).length;
    const go = q && (none || more) ? `<button type="button" class="t-all" data-findall="${esc(q)}">Search inside for “${esc(q)}”</button>`
      : !more ? ""
      : p ? `<button type="button" class="t-all" data-findall="p:${esc(p.name)} ">All in ${esc(p.name)}</button>`
      : `<a class="t-all" href="${see.wait ? "/inbox?recent" : "/inbox"}" data-nav="inbox">${see.wait ? "All waiting" : "All documents"}</a>`;
    return `<div class="t-foot">${go}${put && !p ? `<button type="button" class="t-away" data-back="">${plural(put, "project")} hidden · Show</button>` : ""}</div>`;
  }
  function renderTree() {
    // One more draw, for bench/ui.mjs to count; nothing when it is not watching.
    window.__perf && window.__perf.renders++;
    pageGhost();
    // A read of the page's layout that follows a write lays the sidebar out
    // again on the spot, so a draw reads first: the title width, then the
    // room the list has once the sections above it stand. The title width is
    // measured rather than assumed, because the gutter resizes the sidebar,
    // and once per draw rather than once per row.
    if (fitCtx && treeEl.clientWidth) {
      // At a document row's size, a Sub-row's (app.css .t-doc a), not the tree's.
      const cs = getComputedStyle(treeEl);
      const f = `550 ${cs.getPropertyValue("--fs-small").trim() || "12px"} ${cs.fontFamily}`;
      if (f !== fitFont) fitCtx.font = fitFont = f;
      titleRoom = roomIn(treeEl.clientWidth);
    }
    renderQueue();
    renderDesks();
    const cap = capSeen = inboxCap();
    let h = treeOff || listOff ? noReach("tree") : "";
    const rows = treeOff || listOff ? [] : listRows();
    if (!state.tree.length && rows && !rows.length && !see.q) {
      h += state.browse.length ? "" : `<div class="t-empty">What your agents write lands here, newest first.</div>`;
    } else if (!rows) {
      // On its way: the rows' room, held, so Desks does not move when they land.
      h += `<ul class="t-list">${`<li class="t-wait"><span class="sk-bar" style="width:62%"></span></li>`.repeat(cap)}</ul>` + listFoot(false, false);
    } else {
      // A removed row's ghost stands where the row was, at its height, and
      // the list under it gives up a row so nothing below moves (`gone`).
      const g = gone && gone.where === "list" && !rows.some(d => d.id === gone.id) ? gone : null;
      const shown = rows.slice(0, g ? cap - 1 : cap), lis = shown.map(docRow);
      if (g) lis.splice(Math.min(g.at, lis.length), 0, ghostRow(g.h));
      const none = !lis.length ? `<li class="t-none">${see.q.trim() ? `No title here has “${esc(see.q.trim())}”` : see.wait ? "Nothing waiting" : "Nothing here yet"}</li>` : "";
      // Narrowed by the reader -- a filter, the find box -- the list keeps
      // the room it had, so what is under it stays where it was.
      const hold = see.proj || see.wait || see.q.trim() ? ` style="min-height:${cap * ROW_H}px"` : "";
      h += `<ul class="t-list"${hold}>${lis.join("") || none}</ul>` + listFoot(rows.length > shown.length, !rows.length);
    }
    // The same rows as last time are left alone: the string says what is on
    // screen, and anything else that touches the rows clears `drawnTree`.
    if (h !== drawnTree) {
      // A keyboard on a ghost's Undo, or on a row, stays on it through the redraw.
      const a = document.activeElement, onUndo = a?.matches(".t-gone .t-undo"), onRow = treeEl.contains(a) && a.dataset.id;
      treeEl.innerHTML = h;
      if (onUndo) toUndo();
      else if (onRow) treeEl.querySelector(`a[data-id="${CSS.escape(onRow)}"]`)?.focus({ preventScroll: true });
      drawnTree = h;
      treeTouched.takeRecords();
    }
    // Any write above may have moved the column -- the rows, or a queue or a
    // desk list that brought the scrollbar in -- so the recut is armed. It
    // runs only if the width it was cut for is not the width there is.
    if (!recut) recutDone = false;
  }

  /* The scrollbar exists only once the rows do, and takes width from the
   * column the titles were just cut to -- so a tree that overflows was cut
   * against a width that stopped being true as it was drawn. Once more, when
   * the browser says the column changed, and from what it says: asking the
   * page for its width right after the write would lay it out on the spot.
   * Once per draw of the rows, as before, so two widths that each cause the
   * other cannot trade places all day. #tree has no padding, so the box the
   * observer reports is the width the titles are cut to. */
  try {
    new ResizeObserver(es => {
      const w = Math.round(es[es.length - 1].contentRect.width);
      if (recutDone || !fitCtx || !w || roomIn(w) === titleRoom) return;
      recutDone = recut = true;
      try { renderTree(); markActive(); } finally { recut = false; }
    }).observe(treeEl);
  } catch {}

  /* The first draw can land before Inter has, and a fallback font measures
   * narrower -- titles are then cut to a width the real font overflows, and
   * the row ends in two ellipses. Measure again once it is here. */
  try {
    document.fonts.ready.then(() => { fitFont = ""; renderTree(); markActive(); });
  } catch {}

  /* The cap follows the room: the window's height, a desk made or closed.
   * Only a change in the cap draws the list, and what changes then is how
   * many rows it shows -- Desks stays where it was, which is the point. */
  try {
    let queued = false;
    const recap = () => { queued = false; if (capSeen != null && inboxCap() !== capSeen) { renderTree(); markActive(); } };
    const watch = new ResizeObserver(() => { if (!queued) { queued = true; requestAnimationFrame(recap); } });
    for (const el of [treesEl, inboxRowEl, $("#desk-nav")]) watch.observe(el);
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
    const wfs = await getJson(`/api/projects/${pid}/tree${q.size ? `?${q}` : ""}`);
    if (Array.isArray(wfs)) state.sub.set(pid, wfs);
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
    const w = await getJson(`/api/workflows/${wid}/tree`);
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

  /** A save in place carries the one project that moved: its row as
   *  /api/tree has it, and its sessions as /api/projects/{id}/tree has them
   *  under the default caps. Put in here, so a save fetches nothing (audit
   *  finding 4: a file saved every few seconds pulled the tree and the
   *  project back down every few seconds). Only for a save in place, which
   *  adds and takes away no row: a session this tab holds whole and the
   *  event capped keeps the rows past the cap as they were. False, and the
   *  fetch it was, for a daemon that sends no rows or a cap the reader
   *  lifted. An arrival still fetches: it moves rows between versions. */
  function patchTree(j) {
    listPut(j.doc);
    const p = j.project, rows = j.rows;
    if (!p || !Array.isArray(rows)) return false;
    const pid = String(p.id), had = state.sub.get(pid);
    if (had && liftedCaps.has(pid)) return false;
    state.tree = state.tree.filter(x => String(x.id) !== pid).concat(p)
      .sort((a, b) => (b.latest || 0) - (a.latest || 0) || b.id - a.id);
    treeOff = false;
    if (!had) return true;
    const whole = w => liftedWorkflows.has(w.id) || state.doc?.workflow_id === w.id;
    const next = rows.map(r => {
      const w = had.find(x => x.id === r.id);
      if (!w || !whole(w) || r.docs.length >= r.total) return r;
      const ids = new Set(r.docs.map(d => d.id));
      return { ...r, docs: r.docs.concat(w.docs.filter(d => !ids.has(d.id))) };
    });
    for (const w of had) if (whole(w) && !next.some(x => x.id === w.id)) next.unshift(w);
    state.sub.set(pid, next);
    return true;
  }

  /** The library moved: refetch the project rows, the list, and the
   *  projects this tab has already filled -- the one the list may be showing
   *  and the one the open document is in. `only` narrows those to one
   *  project, which is what an arrival needs — nothing else in the library
   *  moved.  */
  async function refreshTree(only) {
    const [j] = await Promise.all([getJson("/api/tree"), refreshList()]);
    treeOff = !Array.isArray(j);
    if (!treeOff) state.tree = j;
    const pids = only != null ? [String(only)] : [...state.sub.keys()];
    await Promise.all(pids.filter(pid => state.sub.has(pid)).map(pid => fillProject(pid, true)));
    renderTree();
    markActive();
  }

  treesEl.addEventListener("click", async e => {
    // The Inbox's own: a filter's ✕ in the find box, a project's name on a
    // row (the list shows that project alone), the filter's menu, and the
    // find box's words handed to the search inside documents. The ✕ and the
    // name are inside the row's link and the box's label: not a click on them.
    const un = e.target.closest("[data-unsee]");
    if (un) { e.preventDefault(); e.stopPropagation(); seeInbox(un.dataset.unsee === "wait" ? { wait: false } : { proj: "" }); return; }
    const only = e.target.closest("[data-only]");
    if (only) { e.preventDefault(); e.stopPropagation(); if (!only.closest(".ib-tok")) seeInbox({ proj: only.dataset.only }); return; }
    const ibf = e.target.closest("[data-ibf]");
    if (ibf) { e.preventDefault(); e.stopPropagation(); askWhere(ibf, e.detail === 0); return; }
    const fa = e.target.closest("[data-findall]");
    if (fa) { e.preventDefault(); searchFor(fa.dataset.findall); return; }
    const fold = e.target.closest("[data-fold]");
    if (fold) { e.preventDefault(); toggleFold(fold.dataset.fold); return; }
    const wa = e.target.closest("[data-wallow]");
    if (wa) { allowWidget(wa); return; }
    const ws = e.target.closest("[data-wretry], [data-wnot], [data-wtell]");
    if (ws) { seatAct(ws); return; }
    // A widget's body or failed line past its room opens where it is, and
    // closes again.
    const wb = !e.target.closest("a") && e.target.closest(".wg-body, .wg-why");
    if (wb) { seatOpen(wb); return; }
    const nd = e.target.closest("[data-newdesk]");
    if (nd) {
      // Inside a <summary> too: a click on the + is not a click on the folder.
      e.preventDefault(); e.stopPropagation();
      // In a folder's row, a desk on that folder; in the Desks head, the
      // question of where -- a menu even with no project known yet, since
      // the home folder's shell is an answer too, and a dialog that opened
      // straight from a click could open behind the window and be lost.
      const f = folderOf(nd);
      if (f) act("make", f); else askWhere(nd, e.detail === 0);
      return;
    }
    const dx = e.target.closest("[data-deldoc]");
    if (dx) {
      // Inside the document's link: a click on the ✕ is not a click on the row.
      e.preventDefault(); e.stopPropagation();
      const id = dx.dataset.deldoc, a = dx.closest("a");
      const d = state.queue.find(x => x.id === id) || (state.list || []).find(x => x.id === id) || { id, title: a.querySelector(".title").textContent, project_id: +a.querySelector("[data-only]")?.dataset.only || null };
      deleteDoc(d, dx, !e.detail);
      return;
    }
    if (e.target.closest("[data-undoc]")) {
      e.preventDefault(); e.stopPropagation();
      // Not in the first moments: the Undo is drawn where the ✕ was, and the
      // second click of a quick double-click is not a change of mind.
      if (gone && Date.now() - gone.made > 350) undoGone(gone);
      return;
    }
    const df = e.target.closest("[data-deskdir]");
    if (df) { e.preventDefault(); e.stopPropagation(); deskDir(+df.dataset.deskdir); return; }
    const dd = e.target.closest("[data-dropdesk]");
    if (dd) {
      // Inside the desk's link: a click on the ✕ is not a click on the desk.
      e.preventDefault(); e.stopPropagation();
      act("drop", dd);
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
    }
  });

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
