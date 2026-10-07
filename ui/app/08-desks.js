/* ui/app/08-desks.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { body: j, status: r.status });
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
    state, esc, toast, sayErr, copied, keyHint, armed, toggleQuiet, checkUpdates, browseEl, peerCtx, keepCurInView,
    navList: () => navMod ? navMod.list() : [],
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
    // The desks moved in the reader's order (menu.js, `moveDesk`).
    drawDesks: () => renderDesks(),
    focusDesk: id => deskNav.querySelector(`a[data-desk="${id}"]`)?.focus({ preventScroll: false }),
    deskSaid: (id, text, e) => { clearTimeout(deskSaid?.timer); deskSaid = { id, text, why: e ? sayErr(e).why : "", timer: setTimeout(() => { deskSaid = null; renderDesks(); }, 4000) }; renderDesks(); },
  };
  /* A desk row dragged to another place (menu.js, `dragDesk`). The chunk is
   * fetched when the pointer comes over the list, so it is there by the
   * press; a press before that is a click, as it always was. */
  deskNav.addEventListener("pointerenter", () => { if (capability) useActs().catch(() => { actsLoading = null; }); });
  deskNav.addEventListener("pointerdown", e => {
    const a = e.target.closest(".t-desk > a[data-desk]");
    if (a && capability && acts && !e.target.closest("[data-dropdesk]")) acts.dragDesk(actsCtx, a, e);
  });
  /** A desk row's own word on what just failed on it, for a few seconds: in
   *  the row, where the reader was looking, not in a corner. */
  let deskSaid = null;
  /** Panels made to wait for the reader's Enter: a new project desk's first,
   *  holding `claude`. The desk view takes each once, as it draws it. */
  const heldPanes = new Set();
  /** Where a new desk could go besides the home folder: the folders the
   *  Inbox's projects were written from, then the folders open under Folders,
   *  one row a folder, less any that already has a desk -- that one is a
   *  click on its row away, and a second desk on it is its menu's to offer. */
  function deskPlaces() {
    const home = pathKey(state.desks && state.desks.home), taken = new Set(state.desks ? state.desks.desks.map(d => pathKey(d.root)) : []), out = [];
    const put = (abs, f) => { const k = pathKey(abs); if (k && k !== home && !taken.has(k)) { taken.add(k); out.push({ abs, ...f }); } };
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
      return [`<li class="t-desk"><a href="/desk/${d.id}" data-desk="${d.id}" draggable="false" class="${on && state.deskId === d.id ? "active" : ""}">` +
        `${icon("desk")}<span class="title nm">${esc(d.name)}</span>`,
        deskSaid && deskSaid.id === d.id ? `<span class="end"><span class="t-said" role="status" data-tip="${esc(deskSaid.text)}" data-tip-sub="${esc(deskSaid.why)}">${esc(deskSaid.text)}</span></span>` :
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
    desk.open({ id, slot, was, icons: ICONS, desks: state.desks, held: heldPanes, connect: connectClaude, api: deskApi, blob: deskBlob, socket: deskSocket, toast: toast4, sayErr, esc, glyph, keyHint, plural, rel, relShort, fmt, read: id => showDoc(id, true, false, true), reveal: openFolder, tilde, paths: pathsUse, sized: () => { paintControls(); toast("Text size", { sub: desk.textSize().name }); }, go: showDesk, swap: swapDesk, make: (el, byKey) => el ? askWhere(el, byKey) : act("make", null), refresh: loadDesks, menu: (el, x, y, byKey) => menuFor(el, x, y, byKey), nav: navStep, done: markDone, main, docEl, tocEl, metaEl, rail, root });
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
    ".dk-pane, .pn-head, .pn-body, .dk-doc, .dk-list > .dk-note:not(.gone), .nv-b";
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
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && capability && el.matches("a[data-desk]") && deskNav.contains(el)) {
      // A desk's place in the list, from its row: what its menu's Move up
      // and Move down do.
      e.preventDefault(); e.stopPropagation();
      act("moveDesk", +el.dataset.desk, e.key === "ArrowUp" ? -1 : 1, true);
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
    const q = await getJson(`/api/queue?limit=${QUEUE_HELD}`);
    if (Array.isArray(q)) {
      state.queue = q;
      // Fewer than the page ever holds means these are all there are.
      state.waiting = q.length < QUEUE_HELD ? q.length : Math.max(state.waiting, q.length);
    }
    const n = await getJson("/api/notes");
    if (n && Array.isArray(n.notes)) { state.notes = withOwn(n.notes); renderNote(); }
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

  /** An event's body, or null for one that is not JSON. */
  const parse = ev => { try { return JSON.parse(ev.data); } catch { return null; } };
  /** A line from a friend arrived, or an agent offered a document to one:
   *  peer.js says so where the reader is (`event`). */
  const onPeer = ev => { const j = parse(ev); j && peerUse().then(m => m.event(peerCtx, j), () => {}); };
  /** Home shows a little of all of these; each one reads it again, soon. */
  const HOME_EVENTS = ["panes", "ctx", "desks", "desknotes", "doc", "read", "update", "notes", "agents", "deleted", "restored", "peers", "peernotes", "peeroffers", "pairing"];
  function connect() {
    const es = new EventSource("/api/events" + (inWindow ? `?window=${encodeURIComponent(windowMark)}` : ""));
    stream = es;
    es.onopen = async () => {
      // A first connection is not a return.
      if (root.dataset.link !== "off") return;
      linked(true); sayFocus(true);
      // The daemon on the port now may be a newer build than the one that
      // served this page: its bundle is the one to run, so start over on it.
      // Otherwise catch up on what arrived while nothing was heard.
      const h = await getJson("/api/health");
      if (h && h.v && boot.v && h.v !== boot.v) { location.reload(); return; }
      if (h) { setOnline(h.agents); setUpd(h.update); }
      catchUp();
    };
    // The dev loop, and only the dev loop: a daemon started with SNYVI_UI_DIR
    // serves this file off disk and says so when it changes. A shipped daemon
    // never sends this, so the listener costs a page nothing but its own line.
    es.addEventListener("reload", () => location.reload());
    // The daemon's channel ran ahead of this stream and the events between
    // are gone: one `resync` says so, and the page reads everything again,
    // the way it does on coming back.
    es.addEventListener("resync", () => catchUp());

    // An agent arrived or left: its process opened or ended a stream.
    es.addEventListener("agents", ev => {
      const j = parse(ev); if (!j) return;
      setOnline(j.online);
    });
    // The updater's word: first on every stream, then whenever it changes.
    es.addEventListener("update", ev => {
      const j = parse(ev); if (!j) return;
      setUpd(j);
    });
    // An agent left a note, or a reader looked at one somewhere.
    es.addEventListener("notes", ev => {
      const j = parse(ev); if (!j) return;
      if (Array.isArray(j.notes)) { state.notes = withOwn(j.notes); renderNote(); }
    });
    es.addEventListener("doc", async ev => {
      const j = parse(ev); if (!j) return;
      const d = j.doc;
      // A project that was put away and has just been written to is not put
      // away any more: the sidebar never holds back something waiting to be
      // read. Taking it out of the set is enough -- the refresh below draws it.
      if (d && away.delete(String(d.project_id))) saveAway();
      // A save in place carries its project's row and rows: they go in and
      // the sidebar is drawn once (`patchTree`), where a save used to
      // refetch the tree and the project. An arrival still fetches.
      // An overwrite of a document already here is not an arrival: refresh it where
      // it is if it is on screen, never navigate to it, and never toast — a file
      // being watched changes on every save.
      if (j.existing) {
        if (state.doc && state.doc.id === d.id) await refreshDoc(d.id);
        else state.cache.delete(d.id);
        if (patchTree(j)) { renderTree(); markActive(); } else await refreshTree(d.project_id);
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
        toast(d.title, { sub: `${d.project} · just now`, kind: "news", go: () => showDoc(d.id, true) });
      }
      else if (superseded) {
        // The rail picks it up either way, so the offer is free to fade: a
        // reader who misses the button finds the new version at the top of
        // Versions, and `]` steps to it.
        renderHistory();
        toast("A newer version arrived", { sub: d.title, kind: "news", go: () => showDoc(d.id, true),
          action: { label: "Read it", run: () => showDoc(d.id, true) } });
      }
      else if (state.view === "inbox") showInbox(false);
    });
    // A document was opened somewhere -- this tab, another, the window -- and
    // is off the queue everywhere.
    es.addEventListener("read", ev => {
      const j = parse(ev); if (!j) return;
      if (Array.isArray(j.ids)) dropFromQueue(j.ids, j.waiting);
      deskDocs();
    });
    // A large code file finished highlighting in the background: swap the body in place.
    es.addEventListener("rendered", ev => {
      const j = parse(ev); if (!j) return;
      refreshDoc(j.id);
    });
    // Something in a browsed folder changed on disk: the open file, or a listed folder.
    es.addEventListener("changed", ev => {
      const j = parse(ev); if (!j) return;
      if (j.dir) {
        reloadTree(browseEl.querySelector(`.b-tree[data-root="${j.root}"][data-path="${CSS.escape(j.path)}"]`));
        if (browsing() && state.browseRoot.id === j.root && !state.browsePath && j.path === (state.browseIn || "")) showBrowse(j.root, j.path && j.path + "/", false);
        return;
      }
      if (browsing() && state.browseRoot.id === j.root && state.browsePath === j.path) refreshBrowsed();
    });
    es.addEventListener("deleted", async ev => {
      const j = parse(ev); if (!j) return;
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
      const j = parse(ev); if (!j) return;
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
      const j = parse(ev); if (!j) return;
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
    es.addEventListener("desknotes", ev => { const j = parse(ev); if (j && desk && desk.notesChanged) desk.notesChanged(j.desk); });
    // A pane started, stopped, or rang for its reader: the dots, at once.
    es.addEventListener("panes", ev => {
      const j = parse(ev); if (!j) return;
      for (const d of state.desks ? state.desks.desks : []) for (const p of d.panes) if (p.id === j.id) p.status = { ...p.status, running: j.running, blocked: j.blocked, agent: j.agent };
      renderDesks();
    });
    for (const ev of ["peeroffers", "peernotes", "peerdone", "peerreply"]) es.addEventListener(ev, onPeer);
    for (const ev of HOME_EVENTS) es.addEventListener(ev, homeTick);
    // Another tab named a project or a workflow.
    es.addEventListener("renamed", ev => {
      const j = parse(ev); if (!j) return;
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
