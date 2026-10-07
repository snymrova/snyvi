/* ui/app/05-notes.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
      noteMod = m.init({ root, $, state, liveNotes, esc, relShort, showDoc, showStart, showDesk: capability && showDesk, toast, keyHint, closeSay, undoClock,
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
    findBar.hidden = false;
    const input = $("#find-input");
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
  let inFront = null, focusSeq = 0;
  const pageMark = Math.random().toString(36).slice(2);
  function sayFocus(again, leaving) {
    const now = !leaving && document.hasFocus() && !document.hidden;
    if (now !== inFront || again) fetch("/api/focus", { method: "POST", keepalive: true, body: JSON.stringify({ focused: inFront = now, page: pageMark, seq: ++focusSeq }) }).catch(() => {});
  }
  const beacon = () => sayFocus();
  addEventListener("focus", beacon); addEventListener("blur", beacon); document.addEventListener("visibilitychange", beacon);
  addEventListener("pagehide", () => sayFocus(1, 1));
  beacon();
