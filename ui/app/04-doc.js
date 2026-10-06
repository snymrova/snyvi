/* ui/app/04-doc.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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

  /* The cache is bounded in bytes rather than in entries, the way mmd.js
   * bounds its diagrams: forty entries was forty documents of any size, and a
   * tab left open all day over long files is the tab this project promises
   * stays small. Summed at each fetch rather than kept, since a dozen places
   * drop an entry; the oldest go first, and never the one just fetched.
 * Eight megabytes of rendered html. */
  async function fetchDoc(id) {
    if (state.cache.has(id)) return state.cache.get(id);
    const r = await fetch(`/api/docs/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    state.cache.set(id, j);
    let n = 0;
    for (const v of state.cache.values()) n += v.html?.length || 0;
    for (const [k, v] of state.cache) {
      if (n <= 8 << 20 || k === id) break;
      state.cache.delete(k);
      n -= v.html?.length || 0;
    }
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
    state.view = "doc"; state.doc = j.doc; state.previous = j.previous; state.comparing = null; state.folder = j.folder; setHistory(j.history);
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

  /* Ctrl-click on a path, in the reader and in a desk's panels, is
   * ui/paths.js: fetched the first time Ctrl is held in a window that holds
   * the capability, and never in a tab, which cannot ask. */
  let pathsLoading = null;
  const pathsUse = () => (pathsLoading ||= import(`/assets/paths.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => m.init({ api: deskApi, state, docEl, toast,
    browse: (r, p) => showBrowse(r, p, true),
    landLine: n => { history.replaceState(history.state, "", `${location.pathname}#L${n}`); jumpToHash(); } }), e => { pathsLoading = null; throw e; }));
  addEventListener("keydown", e => { if (e.key === "Control" && capability && !pathsLoading) pathsUse().catch(() => {}); });

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
    // Nothing to read, and no desk yet: the page at `/` is Welcome -- which
    // project first. The Inbox asked for by name -- a click, or `/inbox`
    // drawn again by a refresh -- is the Inbox's own empty state, as is a
    // window that has desks and no documents yet. Nothing *said* is not
    // nothing there: that is its own line, never Welcome.
    let welcomeHtml = items ? null : `<div class="inbox-head"><h1>Inbox</h1>${noReach("inbox")}</div>`;
    if (items && !items.length && !push && location.pathname === "/") {
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
        // In place, where the reader may have scrolled: WebKitGTK would put them back at the top.
        if (Array.isArray(q) && state.view === "inbox" && homeMod) { state.queue = q; const y = main.scrollTop; docEl.innerHTML = inboxHtml(items, homeMod); if (main.scrollTop !== y) main.scrollTo({ top: y, behavior: "instant" }); renderTree(); markActive(); }
      } catch {}
    }
  }

  /** The Inbox's list is home.js's (`inboxHtml`), the chunk for the pages
   *  that list, fetched alongside the list itself. */
  const inboxHtml = (items, m) => m.inboxHtml(items, { state, esc, rel, plural, mascotHead, kindTag, waitingRow, noteKnown });

  /* After the Undo has gone: "N removed · Show" at the foot of the Inbox,
   * drawn by home.js (`removedLine`), the chunk for the pages that list. */
  const homeUse = () => (homeLoading ||= import(`/assets/home.js${boot.v ? `?v=${boot.v}` : ""}`)).then(m => (homeMod = m));
  /** A friend's snyvi (docs/PEER.md): pairing, Send to…, a line, an agent's
   *  offer. All of it is peer.js, fetched on the first of those and never on
   *  a read; first paint has no room to spare, so only the wiring is here.
   *  No promise kept: the module map already holds a loaded one, and a
   *  failed fetch is simply tried again on the next click. */
  const peerUse = () => import(`/assets/peer.js${boot.v ? `?v=${boot.v}` : ""}`);
  const peerCtx = { esc, rel, sayErr, toast, peer: peerUse, home: () => showHome(true) };
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
    return m.welcome({ cap: !!capability, places: welcomePlaces, tilde, mascot: mascotHead("glad"), esc });
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
    await homeMod.show({ view: () => state.view, esc, rel, relShort, plural, capability, deskApi, docEl, card: panelMod, updCtx, checkUpdates, peerCtx,
      next: openNext, newDesk: b => askWhere(b, b.matches(":focus-visible")), notes: () => state.notes });
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
    // A friend's buttons in a document's head: Send to…, Keep on a desk…, Save.
    else if (w === "send") peerUse().then(m => m.head(peerCtx, b), () => toast("Could not open that"));
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
