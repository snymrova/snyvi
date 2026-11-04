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
  /* Inbox and Desks are one kind of thing, so one hand draws their
   * heads: a chevron that folds the section, an icon, the name and a count.
   * What each holds hangs under it on one guide line at one indent. A fold is
   * a class on #trees rather than a redraw, so it survives every render and
   * costs none; it is remembered per reader. */
  const folded = saved("snyvi.fold");
  const isFolded = k => folded.has(k);
  /* The desk's rail kept its folds apart, one key a section, until its
   * sections became these (docs/DESIGN.md §8.4): carried over, and the old
   * keys taken out, so it happens once and leaves nothing behind. Resting,
   * which started folded, is gone (#109): its key and its place in the set
   * with it. */
  {
    const old = [["panels", "panels"], ["docs", "docs"], ["notes", "notes"]].filter(([, was]) => store.get(`snyvi.dk.fold-${was}`) != null);
    for (const [k, was] of old) {
      if (store.get(`snyvi.dk.fold-${was}`) === "1") folded.add(k);
      store.del(`snyvi.dk.fold-${was}`);
    }
    if (store.get("snyvi.dk.fold-threads-rest") != null) store.del("snyvi.dk.fold-threads-rest");
    const rest = folded.delete("rest");
    if (old.length || rest) save("snyvi.fold", folded);
  }
  /* A project the reader has taken out of the sidebar. Nothing is deleted --
   * snyvi deletes nothing on this path -- so the project keeps every document
   * it has, in All, in search and at its own URL; what changes is
   * that it stops taking a row here. It comes back the moment anything lands
   * in it, and the row under the tree brings them all back by hand. Per
   * reader, as the folds are: it is a view, not a fact about the library. */
  const away = saved("snyvi.away");
  const saveAway = () => save("snyvi.away", away);
  /* What the Inbox's list shows (#206, 03-queue.js): what waits or
   * everything, one project (by id) or every one, and what the find box
   * holds. The first two are the reader's and kept, as the folds are; the
   * words are not. */
  const see = { proj: store.get("snyvi.see") || "", wait: store.get("snyvi.seeWait") === "1", q: "" };
  // A project shown alone is fetched whole: the tree's caps (ten a session)
  // are for a project among others, and the list is its every document.
  if (see.proj) liftedCaps.add(see.proj);
  /** The cap the last draw used, so a resize that leaves it where it was
   *  draws nothing. */
  let capSeen = null;
  /** The one just put away, while the offer to undo it is still standing. It
   *  keeps the row's place in the tree so the offer is where the click was --
   *  a toast in the far corner asks the eye to leave the sidebar to find out
   *  what the sidebar just did. Cleared by the timer, by the undo, or by the
   *  next one put away, which is the moment the offer stops being about it. */
  let awayJust = null, awayClock = null, awayUndo = null;
  /** The document just removed, while its row still offers Undo: what it was,
   *  where its row stood (`where` "proj", and the place in that list),
   *  and the clock. Captured at the click, because the refetch that
   *  follows no longer has the row to say where it was. One at a time. */
  let gone = null;
  /** Whether the ghost can be seen: drawn, on the Inbox page or in a
   *  sidebar that is not folded. */
  const inView = g => g.drawn && (g.page && state.view === "inbox" || root.dataset.side !== "0");
  const LEFT_SECS = ["inbox", "desks"];
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
    for (const s of document.querySelectorAll(`.sec[data-sec="${key}"]`)) { s.classList.toggle("folded", fold); if (!fold) markCut(s); }
    gapsLeft();
    if (!LEFT_SECS.includes(key)) return;
    applyFolds();
    // A folded Desks leaves the Inbox room for more rows; the reader's
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
    // The Desks head's order (#175): up and down.
    sort: '<path d="M7 4v16m-3.5-3.5L7 20l3.5-3.5M17 20V4m-3.5 3.5L17 4l3.5 3.5"/>',
    widgets: '<rect x="3.5" y="3.5" width="17" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.8"/>',
    pin: '<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5zM12 13v7.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    aside: '<path d="M20.5 14.5a2 2 0 0 1-2 2H8.5l-5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    more: '<circle cx="6" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="18" cy="12" r=".8"/>',
    prev: '<path d="m15 6-6 6 6 6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
    // The Inbox's filter and its find box (#206).
    funnel: '<path d="M3.5 5h17l-6.5 8v6l-4-2v-4z"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.9-4.9"/>',
    // Music (#204).
    music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
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
  /** A friend, as the first letter of their name in a small circle, where a
   *  row's icon stands: their documents and their own row (audit 7c0fc42885:
   *  4 of a friend's 5 sat in the reader's project looking like their own).
   *  In a colour of their own (#123), the same wherever they show -- the
   *  sidebar, Waiting, Home, a desk's note, the document's head, where the
   *  daemon picks it the same way (assets.rs `friend_hue`) -- so a friend's
   *  reads as theirs at a glance; it was grey, and read as a page glyph. */
  const hueOf = s => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 360, 7);
  const whoIco = (name, tip) => `<span class="r-who" style="--h:${hueOf(name || "")}"${tip ? ` data-tip="${esc(tip)}"` : ""} aria-hidden="true">${esc((name || "?").trim().charAt(0).toUpperCase() || "?")}</span>`;
  /** Rows on their way: two bars where the rows will be (docs/DESIGN.md
   *  §7.4), never a bare "…". They wait --sk-wait, so a fast answer shows none. */
  const skRows = `<li class="t-wait"><span class="sk-bar" style="width:62%"></span></li><li class="t-wait"><span class="sk-bar" style="width:44%"></span></li>`;
  /** A section's head (docs/DESIGN.md §8.4), the one both sidebars draw --
   *  desk.js has it as ctx.secHead. A quiet label that folds what is under
   *  it, its chevron shown on hover and while folded; then at the right, in
   *  this order, the actions and the count -- the count last, so it lines
   *  up under the rows' times and counts. The count stays while folded,
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
    // The count's slot is there with no count in it, so one arriving moves
    // nothing beside it (the audit of 1.46.2 saw the Desks head's buttons
    // slide 19 px when a panel rang).
    const has = o.count != null && o.count !== "";
    const n = `<span class="sec-n${has && o.tone ? ` ${o.tone}` : ""}${has && o.foldOnly ? " fold-only" : ""}"${has ? tip(o.countTip) : ""}>${has ? o.count : ""}</span>`;
    return `<div class="sec-head${o.empty ? " empty" : ""}" data-sec="${key}"${o.part ? ` data-part="${o.part}"` : ""}>${lead}${o.acts ? `<span class="sec-acts">${o.acts}</span>` : ""}${n}${o.end || ""}</div>`;
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
  // Folders left the sidebar in 1.56 (#214): a folder is read through its desk.
  let layout = boot.layout || { left: ["inbox", "desks", "widgets"], right: [], hidden: [] };
  const LEFT_NODES = { inbox: [inboxRowEl, treeEl], desks: [$("#desk-nav")], widgets: [widgetsEl] };
  const LEFT_ICONS = { inbox: ['[data-pop="inbox"]'], desks: ['[data-pop="desks"]'], widgets: ['[data-pop="widgets"]'] };
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
   *  as they do, and its head's tip says who wrote it and when. Its body keeps a
   *  fixed room, `lines` × 20 px, so a new one never moves what is under
   *  it; a longer one opens where it is when clicked. A failed run says so
   *  over the last good body, which stays. Past its time it dims. The body
   *  is the daemon's, drawn strictly (src/render.rs `widget_md`).
   *  The frame is drawn with what never changes -- the name, the fold -- and
   *  the rest is patched into it (`patchSeat`), so an update to a body is
   *  never a redraw of the side it is on. */
  /** `data-wsrc` is "own" for a desk's own widget file (1.32), whose menu
   *  shares it rather than picks its desks (menu.js `widgetItems`). */
  /** The fold's key is the widget's, not its name's: a global `status` and
   *  desk 7's own `status` are two widgets, folded apart. A shared file's
   *  seats on several desks fold together, as one widget. */
  function seatFrame(w) {
    const key = `w:${w.owner || (w.desk_id ? `d${w.desk_id}` : "g")}:${w.name}`, t = w.title || wTitle(w.name);
    return `<section class="sec wg${secFolded(key) ? " folded" : ""}" id="wg-${w.desk_id}-${w.name}" data-sec="${key}" data-w="${w.name}" data-wdesk="${w.desk_id}" data-wsrc="${w.owner ? "own" : w.source}">` +
      secHead(key, esc(t), { tip: t }) +
      `<div class="sec-body"></div></section>`;
  }
  /** What a seat's body holds, apart, so an update patches it in place. */
  /** A widget file that waits on the reader: never run (`allow:`), or
   *  changed since it was allowed (`changed:`) -- src/server/widget_run.rs.
   *  Its seat asks, with the button that answers; only the window can. */
  const wAsks = w => /^(allow|changed): /.test(w.error || "");
  /** One that failed three times in a row for the same reason: stopped on
   *  this desk until the reader says Try again (#111). Turn off here takes
   *  it off this desk; the rest keep it. */
  const wStopped = w => /^stopped: /.test(w.error || "");
  /* The seat keeps its room, `lines` × 20 px, printed or not, and its
   * line -- Allow, stopped, failed -- lies over the top of it: a run that
   * fails, or works again, never moves what is below (no layout shift). */
  const seatInner = w => `<div class="wg-body" style="--lines:${w.lines}">${w.html || ""}${w.html ? W_MORE : ""}</div>` +
    (wAsks(w) ? `<p class="wg-ask" role="status"><span data-tip="${esc(w.error.replace(/^\w+: /, ""))}">${esc(w.error.replace(/^\w+: /, ""))}</span><button type="button" class="wg-allow" data-wallow="${w.name}" data-tip="Allow it to run" data-tip-sub="Again whenever its folder changes, unless Rerun my edits is on for it on /sidebars. Only the snyvi window can allow">Allow</button></p>`
      : wStopped(w) ? `<p class="wg-ask wg-stop" role="status"><span data-tip="${esc(w.error.replace(/^stopped: /, "Stopped "))}">Stopped ${esc(w.error.replace(/^stopped: /, ""))}</span><button type="button" class="wg-allow" data-wretry="${w.name}" data-wd="${w.desk_id}" data-tip="Run it again" data-tip-sub="It stops again after three failures in a row">Try again</button>${w.desk_id ? `<button type="button" class="wg-allow" data-wnot="${w.name}" data-wd="${w.desk_id}" data-tip="Off on this desk" data-tip-sub="/sidebars switches it back on">Turn off${w.owner ? "" : " here"}</button>` : ""}</p>`
      : w.error ? wFailed(w) : "");
  /** Past its room: the cut line's "more", which opens it where it is --
   *  shown only once the box is measured as cut (`markCut`). */
  const W_MORE = `<button type="button" class="wg-more" aria-expanded="false">more</button>`;
  /** A failed run (#112): why, in one line that opens whole, and for a
   *  widget file, the button that tells the agent that proposed it. */
  const wFailed = w => `<div class="wg-err" role="status"><div class="wg-why">${esc(w.error)}${W_MORE}</div>` +
    (w.source === "file" && w.agent ? `<button type="button" class="wg-allow" data-wtell="${w.name}" data-wd="${w.desk_id}">Tell the agent</button>` : "") + `</div>`;
  /** Which of a seat's body and its line are cut by their room, so their
   *  "more" shows: measured after they are drawn, and again when the seat
   *  is unfolded, since a folded one measures nothing. */
  function markCut(el) { requestAnimationFrame(() => el.querySelectorAll(".wg-body:not(.open), .wg-why:not(.open)").forEach(x => x.classList.toggle("cut", x.scrollHeight > x.clientHeight + 1))); }
  /** The global widgets, drawn whole: on the first paint, and when one
   *  comes or goes. A body that changed is patched (`patchSeat`). */
  function drawWidgets() {
    const seats = globalSeats(), h = seats.map(seatFrame).join("");
    if (widgetsEl.$html !== h) widgetsEl.innerHTML = widgetsEl.$html = h;
    for (const w of seats) { const el = document.getElementById(`wg-0-${w.name}`); if (el) patchSeat(el, w); }
    placeLeft();
  }
  /** A box's buttons -- Allow, Try again, Turn off here, Tell the agent,
   *  more -- are menu.js's, fetched on the first such click (`act`,
   *  08-desks.js). */
  const allowWidget = b => act("allowWidget", b), seatAct = b => act("seatAct", b), seatOpen = x => act("seatOpen", x);
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
   *  sidebar is not redrawn, so nothing takes the focus or the scroll. A
   *  body that did not change is left as it is, so a rail redrawn for a
   *  panel's dot does not snap an opened "more" shut or bring back an
   *  Allow the reader just pressed; one that did keeps "more" open. */
  function patchSeat(el, w) {
    const body = el.querySelector(":scope > .sec-body");
    if (!body) return false;
    el.$w = w;
    const inner = seatInner(w);
    if (body.$inner !== inner) {
      const open = body.querySelector(".wg-body.open, .wg-why.open") != null;
      body.innerHTML = body.$inner = inner;
      if (open) seatOpen(body.querySelector(".wg-body, .wg-why"));
      markCut(el);
    }
    // Who writes it, how often and how long ago: the name's tip, not a line
    // of the box's own, so the box is its name, its count and its body.
    el.querySelector(".sec-fold").dataset.tipSub = `${w.writer || w.source} · ${relShort(w.updated_at)}`;
    el.classList.toggle("stale", wStale(w));
    const head = el.querySelector(":scope > .sec-head"), nm = head.querySelector(".sec-nm"), t = w.title || wTitle(w.name);
    if (nm.textContent !== t) nm.textContent = el.querySelector(".sec-fold").dataset.tip = t;
    const n = head.querySelector(".sec-n"), tone = W_TONE[w.tone] || "";
    if (w.count) {
      const c = n || head.insertBefore(document.createElement("span"), head.querySelector(".sec-acts"));
      c.className = `sec-n${tone ? ` ${tone}` : ""}`; c.textContent = w.count;
    } else if (n) { n.className = "sec-n"; n.textContent = ""; }
    return true;
  }
  /** Every minute each seat is patched with what it last had: its age and
   *  whether it is stale are said again, since a box a dead cron job stops
   *  writing is the one `stale_after` is for, and no event comes for it. An
   *  unchanged body is left as it is (`$inner`), so nothing flickers. */
  setInterval(() => document.querySelectorAll("section.wg").forEach(el => el.$w && patchSeat(el, el.$w)), 60000);

  /** Highlight whatever is on screen, without rebuilding either tree. */
  /** Told whenever the page may have moved (`markActive`): the focus beacon
   *  (05-notes.js) says which desk the page shows, for the widgets that run
   *  only while one is in view. A hook, so this part need not know it. */
  let onPlace = () => {};
  function markActive() {
    onPlace();
    for (const a of treesEl.querySelectorAll("a.active")) { a.classList.remove("active"); a.removeAttribute("aria-current"); }
    // Home has no row: the mark is its way, so on Home the mark is where the
    // reader is, as any current row is (audit 67d008cb6f).
    const brand = $(".side-head .brand"), home = state.view === "home";
    brand.classList.toggle("active", home);
    if (home) brand.setAttribute("aria-current", "page"); else brand.removeAttribute("aria-current");
    const on = state.view === "inbox" ? inboxRowEl.querySelector(".sec-all")
      : state.view === "desk" && state.deskId != null ? $("#desk-nav").querySelector(`a[data-desk="${state.deskId}"]`)
      // A document read over a desk is still the desk: the desk keeps the
      // mark, and the rail marks the document.
      : state.deskBehind != null ? $("#desk-nav").querySelector(`a[data-desk="${state.deskBehind}"]`)
        // The one being opened outranks the one being left: a redraw that lands
        // while a document is on its way must not put the mark back on the row
        // the reader has already moved off.
        : state.opening ? treeEl.querySelector(`a[data-id="${state.opening}"]`)
          : state.doc ? treeEl.querySelector(`a[data-id="${state.doc.id}"]`) : null;
    if (on) { on.classList.add("active"); on.setAttribute("aria-current", "page"); }
    // Brought into the sidebar's view only when it is out of it, and only as
    // far as it takes: moved by hand, since WebKitGTK may decline to scroll.
    const mark = on && treeEl.contains(on) ? on : null;
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
  /** What a row says its document weighs, when the daemon said: the hover
   *  prefetch in 07-nav.js leaves a long one for the click. */
  const sizeOf = d => d.size ? ` data-size="${d.size}"` : "";
  /** A document's row in the Inbox's list (#206): its title on the first
   *  line, whole where it fits and cut in the middle where it does not, and
   *  under it its project and when it came. The project is a way in: a
   *  click shows that project alone, and its menu is the project's. */
  const docRow = d => {
    noteKnown(d);
    const t = mid(d.title, titleRoom), who = d.friend || (d.origin === "peer" ? d.sender : "");
    // Not "active": markActive puts that on, so the rows a reader moves between
    // draw the same and a move between two of them costs no redraw.
    const cls = waitingRow(d) ? "new" : "";
    // A friend's, in a project of the reader's or their own, wears the
    // friend where the page glyph stands, and says so in its tip.
    return `<li class="t-doc${washCls(d.id)}"${moment(d.id)}><a href="/d/${d.id}" class="${cls}" data-id="${d.id}"${sizeOf(d)}${cut(d, t)}>${who ? whoIco(who, `From ${who}`) : docIco()}<span class="t2"><span class="title">${lit(t)}</span>` +
      `<span class="sub"><span class="p" data-only="${d.project_id}" data-tip="Only ${esc(d.project || "")}"><span class="nm">${esc(d.project || "")}</span></span><span class="k">${relShort(d.received_at)}</span>${d.pinned ? `<span class="pin" data-tip="Pinned" data-tip-sub="kept by prune">${glyph("pin", 11)}</span>` : ""}</span></span>${removeBtn(d)}</a></li>`;
  };
  /** A title with what the find box holds marked in it. */
  const lit = t => {
    const q = see.q.trim(), i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? esc(t) : esc(t.slice(0, i)) + `<mark>${esc(t.slice(i, i + q.length))}</mark>` + esc(t.slice(i + q.length));
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
  function ghostRow(h) {
    const g = gone;
    g.drawn = true;
    const t = Date.now() - (g.closing || g.made);
    // A refused Undo says so in the row and holds its clock: the button is
    // its Retry. Pruned, there is nothing to retry, and the row just closes.
    return `<li class="t-doc t-gone${g.closing ? " leaving" : ""}${g.back || g.err ? " back" : ""}" style="--t:-${t}ms${h ? `;height:${h}px` : ""}"><div class="t-ghost" role="status" style="--undo-left:${g.clock.left()}">${docIco()}<span class="title"${g.err ? ` data-tip="${esc(g.d.title)}"` : ""}>${esc(g.err || g.d.title)}</span>${g.err ? "" : `<span class="k">removed${g.versions > 1 ? ` · ${g.versions} versions` : ""}</span>`}${g.dead ? "" : `<button type="button" class="t-undo" data-undoc>${g.err ? "Retry" : "Undo"}</button>`}</div></li>`;
  }
  /** The same ghost on the Inbox page, where the row stood there (`g.page`,
   *  at that row's height), drawn again with the sidebar's so the two say
   *  the same, and gone with it. */
  function pageGhost() {
    const el = docEl.querySelector(".inbox > .t-gone");
    if (el) gone?.page && state.view === "inbox" ? el.outerHTML = ghostRow(gone.page.h) : el.remove();
  }
