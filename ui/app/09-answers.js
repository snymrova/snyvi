/* ui/app/09-answers.js: a part of app.js. build.rs joins ui/app/*.js in name order inside
 * one function scope (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
  /* ---------- what snyvi says back ----------
   * A toast at the bottom-right corner is a message posted to an address
   * nobody is looking at: the click was on a button in the left rail, or on a
   * mark in the middle of a paragraph, and the eye is still there. The answer
   * moves to the hand instead. Every one of these is snyvi answering -- the
   * same face as the logo, wearing the accent -- and it comes up beside the
   * thing that was just pressed, leaning towards it, with the corner kept for
   * the few that answer nothing in particular: an arrival, a dropped stream.
   *
   * The DOM is what it was -- `#toasts` holding `.toast`, with `.t`, `.s` and
   * `button.act` inside -- so what reads a toast, bench/ui.mjs included,
   * still finds it. What changed is where the box is put and who is in it. */
  /* The six faces, which are the whole of the tone. The box around them is
   * kept as small as it can be read at -- a head, a line, and a line under it
   * when there is more to say -- because the face is what is being looked at.
   * Every one is built from the logo's own geometry: eyes at 11 and 21,
   * mouth at 23, so the head in an answer is the head in the corner of the
   * sidebar and reads as the same creature rather than an illustration of
   * it. What each one does when it lands is in app.css, keyed off data-feel. */
  const EYE = (x, r = 2.6) => `<ellipse class="mk-ink" cx="${x}" cy="16.5" rx="${r}" ry="${+(r * 1.27).toFixed(2)}"/>`;
  const SHUT = `<path class="mk-line" d="M8.6 17q2.4 1.8 4.8 0M18.6 17q2.4 1.8 4.8 0"/>`;
  const UP = (l = 1, r = 1) => `<path class="mk-line" d="${l ? "M8.6 17.8q2.4-3 4.8 0" : ""}${r ? "M18.6 17.8q2.4-3 4.8 0" : ""}"/>`;
  const HEART_EYE = x => `<path class="mk-love" transform="translate(${x} 16.5) scale(.85)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/>`;
  const SMILE = `<path class="mk-line" d="M13.5 23q2.5 2.2 5 0"/>`;
  const FACES = {
    // Open eyes, a small smile: heard you.
    rest: EYE(11) + EYE(21) + SMILE,
    // Eyes up, mouth open: the thing you wanted happened.
    glad: UP() + `<path class="mk-ink" d="M13 22.4q3 4 6 0z"/>`,
    // One eye up: said with a bit of mischief, for the lights and the like.
    wink: UP(1, 0) + EYE(21) + SMILE,
    // Hearts, and they float off. Rare on purpose; it means nothing if not.
    love: HEART_EYE(11) + HEART_EYE(21) + SMILE +
      // The heart that floats off is a group with the placement on the path
      // inside it: a CSS transform on an SVG element replaces the element's
      // own transform attribute outright, so the animation gets a wrapper of
      // its own to move rather than eating the placement.
      `<g class="mk-puff"><path transform="translate(26 8) scale(.5)" d="M0 3.2c-3.4-2-4.3-4.4-2.6-5.6 1-.7 2.1-.1 2.6.8.5-.9 1.6-1.5 2.6-.8 1.7 1.2.8 3.6-2.6 5.6z"/></g>`,
    // Eyes wide, mouth a small o: something arrived.
    whoa: EYE(11, 3.1) + EYE(21, 3.1) + `<ellipse class="mk-ink" cx="16" cy="23.4" rx="1.9" ry="2.2"/>`,
    // Eyes down, mouth flat: it could not, and it is sorry about it.
    oops: SHUT + `<path class="mk-line" d="M13.8 23.4h4.4"/>`,
  };
  /** snyvi's head at any size, in the accent it is wearing. */
  const mascotHead = feel => `<svg class="mk" viewBox="0 0 32 32" aria-hidden="true">` +
    `<rect class="mk-nub" x="14" y="0.5" width="4" height="5" rx="2"/><rect class="mk-body" x="1" y="4" width="30" height="27" rx="9"/>` +
    (FACES[feel] || FACES.rest) + `</svg>`;
  /* The same head at the 72 px peek's size, where it keeps the shine in its
   * eyes and the blush the icon has (docs/DESIGN.md §2.2: below 48 px they
   * go). One drawing for the aside card and the update card, so the peek is
   * never a face drawn by hand in the chunk that shows it. */
  const SHINE = { rest: [11, 21], whoa: [11, 21], wink: [21] };
  const mascotPeek = feel => mascotHead(feel).replace("</svg>",
    `<ellipse class="mk-cheek" cx="7.4" cy="21.8" rx="2.4" ry="1.5"/><ellipse class="mk-cheek" cx="24.6" cy="21.8" rx="2.4" ry="1.5"/>` +
    (SHINE[FACES[feel] ? feel : "rest"] || []).map(x => `<circle class="mk-shine" cx="${x + 0.9}" cy="15.2" r="1"/>`).join("") + "</svg>");
  /* Where the reader acted, taken as they act (docs/DESIGN.md §4.2). A press
   * keeps its point and the control under it; a key keeps its moment, since
   * the answer to a key belongs at the focus, never at an idle pointer. An
   * answer that comes ten seconds after either answers nobody, and goes to
   * the corner. A caller that knows better passes `at` itself -- a menu item's
   * rect, taken before the menu closed; a control's, before a redraw. */
  const ACTABLE = "button, a, summary, [role='button'], .ln, .anchor";
  let press = null, keyAt = -1e9;
  addEventListener("pointerdown", e => { press = { x: e.clientX, y: e.clientY, t: performance.now(), el: e.target?.closest?.(ACTABLE) }; }, true);
  addEventListener("keydown", () => { keyAt = performance.now(); }, true);
  /** Where the last act was: the focused control after a key (on a desk,
   *  its panel's head); after a press, the control pressed, or the point it
   *  stood at if a redraw has taken it. */
  function actedAt() {
    const pt = press?.t ?? -1e9;
    if (performance.now() - Math.max(pt, keyAt) > 10000) return null;
    if (keyAt > pt) {
      const a = document.activeElement;
      return a && a !== document.body ? a.closest(".pn")?.querySelector(".pn-head") || a : null;
    }
    return press.el?.isConnected ? press.el : { x: press.x, y: press.y };
  }
  /** An anchor as a rect: an element (while it is in the page), a DOMRect,
   *  or a point. */
  const rectOf = a => !a ? null : a instanceof Element ? (a.isConnected ? a.getBoundingClientRect() : null)
    : "width" in a ? a : { left: a.x, right: a.x, top: a.y, bottom: a.y, width: 0, height: 0 };

  /* The tip (docs/DESIGN.md §8.1) is ui/tip.js, fetched the first time a
   * pointer comes over something with a `data-tip`, or Tab is first pressed:
   * its first showing waits 450 ms, which covers the fetch. */
  let tipMod = null, tipLoading = null;
  const useTip = (since = performance.now()) => tipLoading ||= import(`/assets/tip.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (tipMod = m.init({ keyHint, since })), () => { tipLoading = null; });
  document.addEventListener("pointerover", e => { if (!tipLoading && e.target.closest?.("[data-tip]")) useTip(); }, { passive: true });
  document.addEventListener("keydown", e => { if (!tipLoading && e.key === "Tab") useTip(); });
  /** An error, in words: `why` for the sub-line, `raw` (its own text, for
   *  whoever needs the exact words) for the toast's title until 1.8's tip.
   *  What snyvi's daemon said is shown as it said it; what the browser said
   *  about the daemon is said the way a person would. */
  function sayErr(e) {
    const raw = String(e?.message ?? e).replace(/^Error: /, "");
    return { raw, why: /dynamically imported|module script/i.test(raw) ? "part of snyvi did not load"
      : /fetch|network|load failed/i.test(raw) ? "snyvi is not answering"
      : /token|capabilit|\b40[13]\b/i.test(raw) ? "this window lost its link to snyvi · reopen it"
      : /\b5\d\d\b/.test(raw) ? "something went wrong in snyvi"
      : /\b(404|410)\b/.test(raw) ? "it is not there any more" : raw };
  }

  /** snyvi's answer (docs/DESIGN.md §4): toast(title, { sub, at, kind,
   *  action, retry, face, life, go }), drawn by ui/toast.js -- fetched the
   *  first time snyvi has something to say, since a page that is only read
   *  says nothing. Where the reader acted is taken now, as they act, not
   *  when the chunk lands; and what was said before it did is said in order. */
  let toastMod = null, toastLoading = null;
  function toast(title, o = {}) {
    const at = "at" in o ? o.at : actedAt(), say = m => m.say(title, o, at);
    if (toastMod) return void say(toastMod);
    (toastLoading ||= import(`/assets/toast.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (toastMod = m.init({
      toastsEl: $("#toasts"), esc, glyph, mascotHead, quiet, sayErr, rectOf, UNDO_MS,
      tipGone: el => tipMod?.gone(el),
      rest: () => { clearTimeout(qbSettle); const w = queueBar.querySelector(".qb-who[data-feel]"); if (w) { delete w.dataset.feel; w.innerHTML = mascotHead("rest"); } },
    })), () => { toastLoading = null; })).then(m => m && say(m));
  }
  /** Clear whatever is being said now, without ceremony. */
  const hush = () => toastMod?.hush();

  /** A copy, answered in the control that copied (docs/DESIGN.md §3.4): it
   *  waits for the clipboard to say yes, then the button reads "Copied" for
   *  1.2 s. With no button left to say it in -- a menu has closed, a line
   *  number was clicked -- a small "Copied" answers where the press was. */
  async function copied(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch { return toast("Could not copy", { sub: `select and press ${keyHint("mod+c")}`, at: btn }); }
    if (!btn?.isConnected || btn.matches(".ln") || btn.dataset.copied) return toast("Copied", { sub: text, at: btn });
    const was = btn.innerHTML;
    btn.dataset.copied = 1; btn.textContent = "Copied";
    setTimeout(() => { btn.innerHTML = was; delete btn.dataset.copied; }, 1200);
  }
  /** Ask twice (docs/DESIGN.md §3.4), the one way: the first press arms the
   *  button -- it reads `label` ("Close desk?") and its tip says what the
   *  second press does ("Ends 3 panels · click again") -- and ARM_MS puts it
   *  back. True when this press is the second, and the thing should happen.
   *  `text` is the part of the button that carries its words. */
  const ARM_MS = 3000;
  function armed(b, { label, sub, text = b }) {
    if (b.dataset.armed) return true;
    const was = text.innerHTML, tip = b.dataset.tipSub, li = b.closest("li");
    b.dataset.armed = "1"; text.textContent = label; b.dataset.tipSub = `${sub} · click again`;
    li?.classList.add("arming");
    setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; text.innerHTML = was; tip ? (b.dataset.tipSub = tip) : delete b.dataset.tipSub; li?.classList.remove("arming"); } }, ARM_MS);
    return false;
  }
  /** The old order of arguments, for desk.js until it is moved onto toast()'s
   *  options with the rest of its sweep. */
  const toast4 = (title, sub, go, action, o) => toast(title, { sub, go, action, ...o });

  // ---------- palette ----------
  /* ⌘K is ui/palette.js, fetched the first time it is asked for: the one box
   * a reader summons rather than meets, so first paint does not carry it.
   * The page keeps `#palette` and these two names, so Esc and ⌘K mean the
   * same thing before it is fetched -- a palette never opened has nothing to
   * close. */
  const pal = $("#palette");
  let palMod = null, palLoading = null;
  async function openPalette() {
    // The box goes up now and the chunk fills it when it lands, searching
    // whatever was typed in between -- a ⌘K followed at once by a word
    // would otherwise lose the word to a box that was not there yet.
    const input = $("#palette-input");
    if (pal.hidden) { input.value = ""; openDialog(pal, input); }
    let lk;
    try { [palMod, lk] = await Promise.all([palLoading ||= import(`/assets/palette.js${boot.v ? `?v=${boot.v}` : ""}`), useLook()]); }
    catch (e) { palLoading = null; closeDialog(pal); toast("Could not open search", { sub: e }); return; }
    const { THEMES, slot, previewTheme, setTheme, loadThemes } = lk;
    palMod.open({ pal, input: $("#palette-input"), list: $("#palette-list"), state, capability, root, esc, rel, mascotHead, browsing, codePre,
      openDialog, closeDialog, THEMES, slot, previewTheme, setTheme, loadThemes, toggleQuiet, checkUpdates, panel, showHome, showInbox, act, gotoLine, showDesk, showBrowse, showDoc, showConnect, showStart, showWelcome, showSidebars, openHelp, peerCtx, places: deskPlaces });
  }
  const closePalette = () => { if (palMod) palMod.close(); };
  const browsing = () => state.view === "browse" && state.browseRoot;
  $("#btn-search").addEventListener("click", openPalette);

  // ---------- the look: theme, accent, font ----------
  /* The three steppers in the foot column and the loader for the themes
   * that are not in first paint are ui/look.js, fetched once the page is
   * idle, or sooner if the hand reaches the column or ⌘K opens. Until it is
   * in, the page wears what boot.js resolved, which is all first paint needs. */
  let look = null, lookLoading = null;
  const useLook = () => (lookLoading ||= import(`/assets/look.js${boot.v ? `?v=${boot.v}` : ""}`)
    .then(m => (look = m.init({ root, $, store, boot, toast, control, onDesk, desk: () => desk, mmd: () => mmd, sayTermSize })), e => { lookLoading = null; throw e; }));
  (window.requestIdleCallback || setTimeout)(() => useLook().catch(() => {}), { timeout: 1500 });
  for (const ev of ["pointerenter", "focusin"]) $(".foot-set").addEventListener(ev, () => useLook().catch(() => {}));
  /* Which controls mean something where the reader is, in one place: the
   * column paints from it and `w` and `z` ask it, so the two cannot
   * disagree. A control that does nothing here is dimmed, not hidden -- it
   * stays focusable, and its tooltip, a click and its key all say why,
   * instead of the silence it used to answer with. "" is "it works". */
  const onDesk = () => root.dataset.view === "desk" && !!desk && !!docEl.querySelector(".pn");
  function where() {
    if (onDesk()) return "desk";
    const a = docEl.querySelector("article.prose, article.preview");
    return !a ? "list" : a.matches(".kind-markdown") ? "prose" : "code";
  }
  const NAMES = { wide: "Width", wrap: "Wrap", font: "Font" };
  function why(c) {
    const w = where();
    if (c === "wide") return w === "code" ? "already full width" : "";
    if (c === "wrap") return w === "desk" ? "not for desks, terminals always wrap" : docEl.querySelector("pre.code") ? "" : "no code on this page";
    return w === "code" ? "code is always monospace" : w === "list" ? "for documents" : "";
  }
  const btnOf = c => $(c === "font" ? "#btn-font" : c === "wide" ? "#btn-wide" : "#btn-wrap");
  function paintControls() {
    for (const c of Object.keys(NAMES)) {
      const b = btnOf(c), no = why(c);
      b.classList.toggle("dim", !!no);
      no ? b.setAttribute("aria-disabled", "true") : b.removeAttribute("aria-disabled");
      if (no) { b.dataset.tip = NAMES[c]; b.dataset.tipSub = no; } else delete b.dataset.tipSub;
    }
    if (!why("wide")) $("#btn-wide").dataset.tip = onDesk() ? "Focused panel in full view" : "Maximise width";
    if (!why("wrap")) $("#btn-wrap").dataset.tip = "Wrap long lines";
    if (!why("font")) look?.paintFontBtn();
  }
  /** Run a control, or say why it does nothing here, beside its button. */
  const control = (c, run) => () => {
    const no = why(c);
    no ? toast(NAMES[c], { sub: no, face: null }) : run();
    paintControls();
  };
  // It is only seen while the column is open, so that is when it is painted.
  $(".foot-set").addEventListener("pointerenter", paintControls);
  $(".foot-set").addEventListener("focusin", paintControls);
  /** A setting that is on or off says which, to the eye and to a reader. */
  const pressed = (b, on) => { b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); };
  function toggleWide() {
    if (onDesk()) { desk.zoomOn(); return; }
    const on = root.dataset.wide !== "1";
    on ? (root.dataset.wide = "1") : delete root.dataset.wide;
    store.set("snyvi.wide", on ? "1" : "0");
    pressed($("#btn-wide"), on);
  }
  $("#btn-wide").addEventListener("click", control("wide", toggleWide));
  pressed($("#btn-wide"), root.dataset.wide === "1");

  function toggleWrap() {
    const on = root.dataset.wrap !== "1";
    on ? (root.dataset.wrap = "1") : delete root.dataset.wrap;
    store.set("snyvi.wrap", on ? "1" : "0");
    pressed($("#btn-wrap"), on);
  }
  $("#btn-wrap").addEventListener("click", control("wrap", toggleWrap));
  pressed($("#btn-wrap"), root.dataset.wrap === "1");

  /** The terminal's text size, after Aa on a desk: the panels' text is the
   *  answer, and Aa's label, under the hand, names the size. */
  const sayTermSize = paintControls;
  // ---------- dialogs: focus goes in, stays in, and comes back ----------
  const appEl = $("#app"), help = $("#help"), aboutDlg = $("#about"), resetDlg = $("#reset");
  const dialogs = [pal, help, aboutDlg, resetDlg];
  const anyDialogOpen = () => dialogs.some(d => !d.hidden);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  let dialogOpener = null;
  /** Show a dialog. The page behind it goes inert, so Tab and a screen
   *  reader stay inside it, and whatever had focus gets it back on close. */
  function openDialog(el, focusEl) {
    if (!el.hidden) { (focusEl || el).focus(); return; }
    if (!anyDialogOpen()) dialogOpener = document.activeElement;
    el.hidden = false;
    appEl.inert = true;
    (focusEl || el.querySelector(FOCUSABLE) || el.firstElementChild).focus();
  }
  function closeDialog(el) {
    if (el.hidden) return;
    el.hidden = true;
    if (anyDialogOpen()) return;
    appEl.inert = false;
    const back = dialogOpener; dialogOpener = null;
    if (back && back.isConnected && back !== document.body) back.focus();
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const box = dialogs.find(d => !d.hidden)?.firstElementChild;
    if (!box) return;
    const f = [...box.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    const at = document.activeElement, first = f[0], last = f[f.length - 1];
    if (e.shiftKey ? (at === first || !box.contains(at)) : (at === last || !box.contains(at))) {
      e.preventDefault(); (e.shiftKey ? last : first).focus();
    }
  }, true);
  help.addEventListener("click", e => { if (e.target === help) closeDialog(help); });
  /* The card opens at once with its title and foot; its rows of keys ride
   * with the about chunk (ui/about.js) and are put in the first time. */
  /** The shortcuts card opens filled: about.js fills it and carries its
   *  look, so the first `?` waits the moment it takes to arrive. */
  async function openHelp() { if (!help.querySelector(".hk")) await panel("help"); openDialog(help, help.firstElementChild); }
  $("#btn-help").addEventListener("click", openHelp);

  // ---------- the rocket: a game, over the sidebar and nowhere else ----------
  /* A chunk on the desk view's terms: fetched on the first press and never on
   * a page that does not press it. It covers the sidebar column and leaves
   * the page beside it alone, so nothing that arrives while it is up is in
   * its way, and it takes the cover down when the rocket is pressed again. */
  let game = null, gameLoading = null;
  const gameBtn = $("#btn-game");
  gameBtn.addEventListener("click", async () => {
    if (game?.isOpen()) { game.close(); return; }
    // The sky is the sidebar, and a rail is 44 px of it.
    if (root.dataset.side === "0") { toast("Asteroids", { sub: sideNarrow.matches ? "needs a wider window" : `needs the sidebar open · ${keyHint("\\")}`, face: null }); return; }
    try { game = await (gameLoading ||= import(`/assets/game.js${boot.v ? `?v=${boot.v}` : ""}`)); }
    catch (e) { gameLoading = null; toast("Could not start the game", { sub: e }); return; }
    gameBtn.classList.add("on");
    game.open($("#side"), { back: gameBtn, onClose: () => gameBtn.classList.remove("on") });
  });

  // ---------- about and reset: a chunk, fetched when one is asked for ----------
  /* Neither panel is on the way to reading a document: one says which build
   * is answering, the other empties the library. Both go to the daemon the
   * moment they open anyway, so the module that fills them rides with that
   * press instead of being carried by every first paint. ui/about.js. */
  async function panel(which) {
    let m;
    try { m = await panelMod(); }
    catch (e) { panelLoading = null; toast("Could not open that panel", { sub: e }); return; }
    m.open(which, { $, openDialog, closeDialog, help, aboutDlg, resetDlg, plural, rel, capability, deskApi, sayErr, panel, showConnect, showStart, showWelcome });
  }
  // The shortcuts card's box, and its foot's buttons, are built and wired
  // by about.js (`fillHelp`), the first time it opens.

  // ---------- the contents on a narrow window ----------
  /* Past 1100 px the rail stops fitting beside the document and becomes a
   * sheet over it: `t` opens the sheet rather than changing the setting the
   * wide layout keeps, the button in #chrome does the same for a finger, and
   * Escape or a tap on the scrim closes it. The contents inside the sheet
   * open on the current section, which the hidden pane could not scroll to.
   * The sidebar has no sheet: narrow, it is its rail (below). What the
   * sheet does is menu.js's (`openSheet`, `closeSheet`), as the folded
   * rail's popover is: fetched on the first press under 1100 px, so a wide
   * window never pays for it. Open means loaded. The opener is taken now,
   * as the reader presses, not when the chunk lands. */
  const railNarrow = matchMedia("(max-width: 1100px)"), sideNarrow = matchMedia("(max-width: 760px)");
  const sideEl = $("#side");
  function closeSheet() { return !!root.dataset.sheet && acts.closeSheet(); }
  const toggleSheet = (which, opener = document.activeElement) => root.dataset.sheet === which ? closeSheet() : useActs().then(m => m.openSheet(actsCtx, which, opener));
  $("#scrim").addEventListener("click", () => { closeSheet(); closePop(); });
  /** A pane folded (`t`, `\`, or the button at its top) at a width where it
   *  is a column, not a sheet. Remembered. The rail folds away and its
   *  button in #chrome is the way back; the sidebar folds to its rail, which
   *  is its own way back. Under 760 px the sidebar is only ever its rail,
   *  so there `\` has nothing to fold. */
  const fold = which => {
    if (which === "side") { closePop(false); if (sideNarrow.matches) return; if (game?.isOpen()) game.close(); }
    const off = root.dataset[which] !== "0";
    root.dataset[which] = off ? "0" : "1";
    store.set(`snyvi.${which}`, off ? "0" : "1");
    if (which === "side") paintSideBtn();
  };
  $("#btn-rail").addEventListener("click", e => railNarrow.matches ? toggleSheet("rail", e.currentTarget) : fold("rail"));
  // The button on the pane itself: puts it away, or, when the pane is a
  // sheet, closes the sheet and gives focus back to what opened it.
  $("#btn-rail-hide").addEventListener("click", () => railNarrow.matches ? closeSheet() : fold("rail"));
  $("#btn-side-hide").addEventListener("click", () => fold("side"));
  // The window grew past the width that made it a sheet: it is a pane again.
  railNarrow.addEventListener("change", () => { if (!railNarrow.matches) closeSheet(); });

  // ---------- the rail: the sidebar folded to its icons ----------
  /* Each icon opens its section in #pop, beside the rail: the section's own
   * element, moved in, and moved back to its place when the popover closes.
   * Every renderer writes by id, so what arrives while it is open lands in
   * the popover; #pop is inside #trees, so the clicks the tree delegates
   * still reach it. One at a time; Esc, a click outside it, a link followed
   * in it and `\` close it. The numbers on the icons are the ones the
   * sections say: waiting, panels waiting on you, agents connected. */
  const railNav = $("#rail-nav");
  ICONS.search = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>';
  for (const b of railNav.querySelectorAll("[data-ico]")) b.insertAdjacentHTML("afterbegin", icon(b.dataset.ico));
  /** A number on a rail icon; none at 0. Hoisted: the renderers call it at boot. */
  function badge(sel, n, cls = "") {
    const b = document.querySelector(`#rail-nav ${sel} .badge`);
    if (b) { b.textContent = n ? String(n) : ""; b.className = "badge" + cls; }
  }
  /* What the popover does -- open, close, what closes it -- is menu.js's
   * (`pop`, `unpop`), fetched on the first press of a rail icon: a reader
   * whose sidebar is never folded never pays for it. Open means loaded. */
  const closePop = (back = true) => !!root.dataset.pop && acts.unpop(back);
  railNav.addEventListener("click", e => {
    const b = e.target.closest("[data-pop]");
    if (b) useActs().then(m => m.pop(actsCtx, b.dataset.pop, b));
    else if (e.target.closest("#rail-search")) openPalette();
  });
  // A toolbar: the arrows walk it, Tab leaves it.
  railNav.addEventListener("keydown", e => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...railNav.querySelectorAll(".icon")].filter(x => x.offsetParent), i = all.indexOf(document.activeElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    e.preventDefault();
  });
  function paintSideBtn() {
    const b = $("#btn-side-hide"), slim = root.dataset.side === "0";
    b.dataset.tip = slim ? "Show sidebar" : "Hide sidebar";
    b.setAttribute("aria-label", slim ? "Show sidebar" : "Hide sidebar");
  }
  // Narrow, the sidebar is its rail; wide again, it is what the reader left it.
  const sideFits = () => {
    closePop(false);
    if (sideNarrow.matches) root.dataset.side = "0";
    else if (store.get("snyvi.side") !== "0") delete root.dataset.side;
    paintSideBtn();
  };
  sideNarrow.addEventListener("change", sideFits);
  sideFits();

  // ---------- the panes' widths ----------
  /* Dragging a pane's edge, and its keys, are look.js's: the edge fetches it
   * when the hand comes over it or the focus lands on it, which is before
   * any press can. */
  for (const g of document.querySelectorAll(".gutter")) for (const ev of ["pointerenter", "focus"]) g.addEventListener(ev, () => useLook().catch(() => {}), { once: true });

  // ---------- the key mode ----------
  // The single letters sleep until ⌃B wakes them. A viewer sits beside the
  // terminals a reader types into all day, and a `j` or a Del meant for one of
  // them that lands here instead moves the page or deletes the document. So a
  // letter only acts once the reader has said so, and the pill says it is on.
  // It stays on while it is used, and goes off the way attention leaves: Esc,
  // ⌃B again, a click, a field or a panel taking the focus, or ten quiet
  // seconds. Inside a panel ⌃B never gets here -- the panel sends it to the
  // program (tmux's prefix, readline's back-a-character) and stops it.
  // The pill that shows all this, and the listeners that notice a click or
  // the focus leaving, are a chunk (ui/keys.js), fetched on the first ⌃B or
  // the first letter pressed asleep.
  let keysOn = false, keyMode = null, keysLoading = null;
  const useKeys = () => (keysLoading ||= import(`/assets/keys.js${boot.v ? `?v=${boot.v}` : ""}`).then(m => (keyMode = m)));
  function keys(on) {
    if (on === keysOn) return;
    keysOn = on;
    document.body.classList.toggle("keys", on);
    if (on) useKeys().then(m => { if (keysOn) m.on(() => keys(false)); }, () => {});
    else keyMode?.off();
  }

  /* What the letters act on, handed to keys.js with each one. */
  const keyCtx = { state, browsing, browseEl, showBrowse, order, siblings, showDoc, showCompare, togglePin, toggleSplit, togglePreview,
    openFind, deleteCurrent, openNext, showInbox, showHome, rawUrl, mmd: () => mmd,
    noteBar: () => state.view === "home" && !!homeMod?.focusBar(),
    wide: () => control("wide", toggleWide)(), wrap: () => control("wrap", toggleWrap)(),
    rail: () => railNarrow.matches ? rail.classList.contains("empty") || toggleSheet("rail") : fold("rail"),
    side: () => closePop() || fold("side") };

  document.addEventListener("keydown", e => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyB" && !inField) { e.preventDefault(); keys(!keysOn); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); return; }
    if (e.key === "Escape") {
      // Esc takes down whatever is over the page, one press for all of it;
      // only with nothing over it, and the hand in no field and no panel,
      // does it leave the page, the way its ✕ does.
      const over = keysOn || anyDialogOpen() || !!root.dataset.sheet || !!root.dataset.pop || !findBar.hidden || !!docEl.querySelector(".mmd[data-full]") || !!document.querySelector("#ctx:not([hidden])");
      keys(false);
      if (mmd) mmd.escape();
      closePalette(); closeDialog(help); closeDialog(aboutDlg); closeDialog(resetDlg); closeSheet(); closePop(); acts?.shut(); if (!findBar.hidden) { if (find) find.close(); else findBar.hidden = true; }
      if (!over && !inField && !e.target.closest(".pn") && !overEl.hidden) { e.preventDefault(); goBack(); }
      return;
    }
    // Back and forward, where the browser does not do it itself: the desktop
    // window has no toolbar and no shortcut of its own for either. A browser
    // that has one yields it to the page's preventDefault, so this is one
    // step there too, not two.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") history.back(); else history.forward();
      return;
    }
    // Between the desk and the reading view: a key no shell or TUI wants,
    // so it works from inside a pane as well.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "`" && capability) {
      e.preventDefault();
      swapDesk();
      return;
    }
    // Undo: the one offer standing, whatever kind it is (offer()). The hand
    // goes here before it goes to the button.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "z" || e.key === "Z") && undoing) {
      e.preventDefault();
      undoing();
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    // `?` answers asleep too: the help box is where a reader finds out the
    // letters sleep at all, so the key that opens it cannot be one of them.
    if (e.key === "?") { e.preventDefault(); help.hidden ? openHelp() : closeDialog(help); return; }
    if (!keysOn) { if (e.key.length === 1 || e.key === "Delete") useKeys().then(m => m.hint(), () => {}); return; }
    // The letters themselves are keys.js's, which ⌃B fetched before any of
    // them could act; one pressed in the milliseconds before it landed is dropped.
    if (keyMode?.letter(e, keyCtx)) { keyMode.hit(); e.preventDefault(); }
  });
