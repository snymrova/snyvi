/* ui/app/06-rail.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
      `</div>` + historyBox();
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
