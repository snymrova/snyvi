/* ui/app/07-nav.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
    if (u.pathname === "/sidebars") { e.preventDefault(); showSidebars(true); return; }
    e.preventDefault();
    toast("Not a page in snyvi", { sub: href, action: {
      label: "Open anyway",
      run: () => window.open(a.href, "_blank", "noopener"),
    } });
  });

  /* A document is fetched ahead for a row the pointer rests on, not for
   * every row it crosses on the way: a hand moving down the sidebar fetched
   * one whole rendered document per row (audit finding 5). 150 ms is a rest;
   * a row over 256 KB is left for the click, since a prefetch that size is
   * a long document's whole cost for a hover. Rows say their size where the
   * daemon told them it (`data-size`). */
  let dwell = 0, dwellOn = null;
  document.addEventListener("mouseover", e => {
    const a = e.target.closest("a[data-id]");
    if (a === dwellOn) return;
    clearTimeout(dwell);
    dwellOn = a;
    if (!a || state.cache.has(a.dataset.id) || +a.dataset.size > 256 * 1024) return;
    dwell = setTimeout(() => { if (dwellOn === a) fetchDoc(a.dataset.id).catch(() => {}); }, 150);
  });
  // ---------- back and forward ----------
  /* Every place the page goes is a history entry already -- a document, a
   * desk's panels, a folder -- and Alt+←/→ walk them; ‹ › in the head show
   * it. History does not say whether there is a forward, so each entry
   * carries its step `n`, and `navTop` is the highest step: a push cuts what
   * was ahead, so a push is the top. Kept in sessionStorage, so a reload
   * keeps it; a new window starts at 0. Only that, the buttons' ends and
   * their clicks are here: what each step is called, the tips, the list on
   * a right-click and a link to a heading are ui/nav.js, fetched when the
   * page is idle. The ✕ and Esc are not this: they leave what is read. */
  const stepAt = () => (history.state && history.state.n) || 0;
  let navTop = 0, navMod = null;
  try { if (history.state && history.state.n != null) navTop = +sessionStorage.getItem("snyvi.nav.top") || 0; } catch {}
  const push0 = history.pushState.bind(history), rep0 = history.replaceState.bind(history);
  history.pushState = (s, t, u) => { const n = stepAt() + 1; push0({ ...s, n }, t, u); navTop = n; navStep(); };
  history.replaceState = (s, t, u) => rep0({ ...s, n: stepAt() }, t, u);
  /** Both pairs -- the head's, and the desk's own -- dimmed at either end,
   *  never hidden: nothing comes or goes, so nothing moves. */
  function navStep() {
    try { sessionStorage.setItem("snyvi.nav.top", navTop); } catch {}
    const n = stepAt();
    for (const b of document.querySelectorAll(".nv-b")) b.setAttribute("aria-disabled", String(b.dataset.step === "-1" ? n < 1 : n >= navTop));
    navMod?.step();
  }
  document.addEventListener("click", e => {
    const b = e.target.closest(".nv-b");
    if (b && b.getAttribute("aria-disabled") !== "true") b.dataset.step === "-1" ? history.back() : history.forward();
  });
  // The mouse's side buttons: the desktop window has no toolbar, so WebKit
  // does nothing with them on its own.
  addEventListener("mouseup", e => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.button === 3 ? history.back() : history.forward(); } });
  // A link to a heading lands with no step, and its popstate comes before
  // the hashchange that gives it one (ui/nav.js): only a stepped entry paints.
  addEventListener("popstate", () => { if (history.state && history.state.n != null) navStep(); });
  const useNav = () => import(`/assets/nav.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (navMod = m.init({ stepAt, rep0, top: () => navTop, setTop: n => { navTop = n; navStep(); }, menuFor: (el, x, y) => menuFor(el, x, y, false), relShort })));
  (window.requestIdleCallback || setTimeout)(() => useNav().catch(() => {}), { timeout: 1500 });
  navStep();

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
    if (location.pathname === "/sidebars") return showSidebars(false);
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
