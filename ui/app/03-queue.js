/* ui/app/03-queue.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
    // One more draw, for bench/ui.mjs to count; nothing when it is not watching.
    window.__perf && window.__perf.renders++;
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
