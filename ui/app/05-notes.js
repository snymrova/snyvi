/* ui/app/05-notes.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
  // ---------- the corner: where every message lives ----------
  /* The pill in the bottom-right corner, its tray (On you and Lately) and
   * the card that rises from outside are ui/corner.js (plan b0bca0a11f),
   * fetched when there is something to show: the boot payload says Lately
   * holds something unseen or something waits on the reader, an event says
   * a message came, a desk opens, or Ctrl Alt Y asks for it. Until then the
   * page keeps only the mark: `data-note` on the root, which makes the logo
   * blink while an agent's aside waits. */
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

  /* snyvi's own asides: four lines at four first moments, each once, each
   * pointing into /start. Not a tour and not a checklist: their words, and
   * the holding back while an agent's aside is unseen, are corner.js's
   * (`says`); first paint carries only their names. */
  const OWN = new Set(["first-doc", "two-waiting", "blocked", "version"]);
  /* Lately is hidden: no clock in the sidebar's foot or its rail, no column
   * on Home, no dot and no blinking mark for what waits in it. What comes
   * still rises as a card, and the daemon still keeps it (src/lately.rs),
   * so nothing is lost. Showing it again is this switch, bench/ui.mjs's
   * LATELY, and its two clock buttons back in index.html (#rail-lately at
   * the rail's end, #btn-lately before #live; git show 52ffc42:ui/index.html),
   * which came out rather than ship hidden: first paint had no room. */
  const LATELY_SHOWN = false;
  let cornerMod = null, cornerLoading = null;
  /* The corner is the desk's while its rail is on screen: on the desk, and
   * on a document opened from the desk's own list, which keeps that rail
   * (08-desks.js `behindDesk`). Asking only for the desk view drew a card
   * twice there, in the desk's corner and this page's (#171). */
  const overDesk = () => (state.view === "desk" || state.deskBehind != null) && !!desk;
  const cornerUse = () => (cornerLoading ||= import(`/assets/corner.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (cornerMod ||= m.init({ root, store, esc, relShort, capability, deskApi, sayErr, toast, who: whoIco, glyph, peek: mascotPeek, showDoc: id => showDoc(id, true, false, overDesk()), showDesk, showHome, showStart,
      view: () => state.view, onDesk: overDesk, friends: () => state.friends, lately: LATELY_SHOWN,
      deskRedraw: () => desk?.arranged?.(), deskTray: () => desk?.openTray?.(), homeRedraw: () => homeMod?.redraw?.(),
      openLately: () => openLately($(root.dataset.side === "0" ? "#rail-lately" : "#btn-lately")), unpop: () => closePop(false),
      hop: () => { const m = $(".brand-mark"); if (m && !quiet()) { m.classList.remove("hop"); void m.offsetWidth; m.classList.add("hop"); } } })))
    .catch(e => { cornerLoading = null; throw e; }));
  const corner = f => cornerUse().then(f, () => {});
  const snyviSays = key => { if (OWN.has(key) && !store.get(`snyvi.seen.${key}`)) corner(m => m.says(key)); };
  // A moment held when the last page closed is still owed.
  if ((store.get("snyvi.own.held") || "[]") !== "[]") setTimeout(() => corner(m => m.sayHeld()), 30e3);
  {
    const a = (boot.notes || []).find(n => !n.dismissed);
    if (LATELY_SHOWN && a && !a.seen) root.dataset.note = a.lit ? "lit" : "new";
  }
  // Ctrl+Alt+Y ("you") opens and closes the corner's tray on every page; a
  // desk's corner hears it first, its panels' keys included (10-onyou.js).
  document.addEventListener("keydown", e => {
    if (e.code !== "KeyY" || !e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || e.getModifierState?.("AltGraph") || state.view === "desk") return;
    e.preventDefault();
    corner(m => m.toggle());
  });

  // ---------- the mark ----------
  /** The mark is the way Home, and hovering it says so: the "Home" tip, as
   *  any control's. It used to answer with a line drawn by lot in place of
   *  its own name, which hid the tip, and put "3 waiting" and "not
   *  connected" in a draw beside "hi" (audit 67d008cb6f). Its faces stay:
   *  the hop, the heart, sleep while the page cannot hear the daemon. */
  /** A desk's last open note ticked (desk.js): the milestone of docs/DESIGN.md
   *  §2.3, and a desk may carry no face, so it is the mark's -- glad, one
   *  hop, for as long as a face's moment lasts, and Home says the count.
   *  Rare by nature: it is the end of a list, not of a line. */
  function markDone() {
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
    // The first block whose foot is below the edge. Blocks stack down the
    // page, so their feet only grow: halved each step, a 5,000-block file
    // asks for 13 rectangles where it asked for every one above the fold.
    let lo = 0, hi = blocks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (blocks[m].getBoundingClientRect().bottom > edge) hi = m; else lo = m + 1; }
    if (lo >= blocks.length) return { top, i: -1, delta: 0 };
    return { top, i: lo, delta: blocks[lo].getBoundingClientRect().top - edge + 1 };
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
    state.doc = j.doc; state.previous = j.previous; state.folder = j.folder; setHistory(j.history);
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
  /* The versions arrive with the document and are drawn with the rest of the
   * rail's foot, in the same frame (#53): the foot sits at the bottom of the
   * rail, so a box added to it after the paint pushed every row above it up.
   * The read after the paint only brings a list that moved since the document
   * was cached up to date, in place. */
  function setHistory(h) {
    state.history = h && h.length > 1 ? h : null;
    state.versions = state.history ? state.history.map(d => d.id) : [];
  }
  const historyBox = () => {
    const h = state.history, d = state.doc;
    return h && d ? `<div id="history"><h4>Versions · ${h.length}</h4>` + h.map(v => `<a href="/d/${v.id}" data-id="${v.id}" class="${v.id === d.id ? "cur" : ""}" data-tip="${esc(v.workflow_title)}">${fmt(v.received_at)}${v.pinned ? " " + glyph("pin", 10) : ""}</a>`).join("") + `</div>` : "";
  };
  async function renderHistory() {
    const d = state.doc;
    if (!d || !d.source_path || state.view !== "doc") return;
    let h; try { h = await (await fetch(`/api/docs/${d.id}/history`)).json(); } catch { return; }
    if (state.doc !== d || state.deskBehind != null) return;
    const was = historyBox();
    setHistory(h);
    const now = historyBox(), old = $("#history");
    if (now === was) return;
    if (old) { if (now) old.outerHTML = now; else old.remove(); }
    else if (now) metaEl.insertAdjacentHTML("beforeend", now);
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
    // A page's preview is framed where nothing of snyvi's can reach, which is
    // the point of the frame (`applyPreview`): find looks in its source, and
    // the redraw that brings the source up lays the search over it (#156).
    if (state.preview === "html" && state.previewOn) togglePreview();
    findBar.hidden = false;
    const input = $("#find-input");
    input.placeholder = state.preview === "html" ? "Find in the source" : "Find in document";
    input.focus(); input.select();
    try { find = await (findLoading ||= import(`/assets/find.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { findLoading = null; findBar.hidden = true; toast("Could not open find", { sub: e }); return; }
    find.open({ $, docEl, bring }, from);
  }

  // ---------- focus beacon for desktop notifications ----------
  // Said when it changes, and not on a clock: in front, or not, by a name
  // this page picks and a count, so another tab cannot take its word and a
  // late one is not the last. Leaving always says not; a stream that comes
  // back says again (the daemon may be a new process: `sayFocus(true)`).
  // With it, whether the page can be seen at all and the desk it shows --
  // a document read over a desk shows the desk's rail -- which is what
  // decides whether a widget runs (src/widget/run.rs).
  let saidFocus = null, focusSeq = 0;
  // The page's own name, which its event stream carries too (08-desks.js
  // `connect`): when the stream ends, the daemon drops this page's word,
  // so a window that died without `pagehide` is not "in view" for the
  // runner (src/server/events.rs).
  const pageMark = state.page = Math.random().toString(36).slice(2);
  function sayFocus(again, leaving) {
    const focused = !leaving && document.hasFocus() && !document.hidden, visible = !leaving && !document.hidden;
    const desk = state.view === "desk" ? state.deskId : state.deskBehind;
    const word = `${focused}|${visible}|${desk ?? ""}`;
    if (word === saidFocus && !again) return;
    saidFocus = word;
    fetch("/api/focus", { method: "POST", keepalive: true, body: JSON.stringify({ focused, visible, desk: desk ?? null, page: pageMark, seq: ++focusSeq }) }).catch(() => {});
  }
  const beacon = () => sayFocus();
  onPlace = beacon;
  addEventListener("focus", beacon); addEventListener("blur", beacon); document.addEventListener("visibilitychange", beacon);
  addEventListener("pagehide", () => sayFocus(1, 1));
  beacon();
