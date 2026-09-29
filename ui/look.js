/* The look: the theme button, the accent swatch and Aa, which step through
 * their choices one click at a time, and the loader for the themes that are
 * not in first paint.
 *
 * A chunk since 1.7.1. All three buttons sit in the foot column, which is
 * one button's footprint until the hand comes over it, so nothing here is
 * on screen at first paint: the page draws with the theme boot.js resolved
 * and the accent and font `data-` attributes boot.js set, and none of that
 * needs this file. The page fetches it once it is idle -- the same moment it
 * always fetched themes.css, which this now does -- or as soon as the foot
 * column is hovered or focused, or ⌘K is opened, whichever comes first. So
 * the labels are right before anyone can read them, and first paint lost
 * the two kilobytes the rail it paid for costs.
 *
 * What stays in app.js is what `w` and `z` ask: which controls mean anything
 * where the reader is (`why`), and width and wrap themselves.
 */

/* The foot column open: the beat each control arrives on, what each is,
 * said beside it, and the column held open while it is answered. At rest
 * the column is app.css's; none of this is on screen until the hand comes
 * over it, which is also what fetches this file. The labels are the folded
 * rail's icons' too. */
const CSS = `
/* The line the mascot says, beside the mark (openSay). */
.bm-say { position: absolute; left: 28px; top: 50%; z-index: var(--z-tip);
  font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; letter-spacing: -.005em;
  color: var(--accent); white-space: nowrap; max-width: 132px; overflow: hidden; text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0; transform: translateY(calc(-50% + 4px));
  transition: opacity var(--dur-quick) ease, transform .3s var(--ease-spring); }
.bm-say.on { opacity: 1; transform: translateY(-50%); }
/* Print, in 1.8: printing waits for a page long idle, and so does this. */
@media print {
  #side, #rail, #chrome, #toasts, #palette, #help, #about, #reset, #queue-bar, pre.code .copy { display: none !important; }
  #app { display: block; }
  #doc { max-width: none; padding: 0; }
  .prose { font-size: 11.5pt; }
  pre.code { white-space: pre-wrap; }
}

/* The beat each arrives on, capped: the last is in by --dur-instant, however
   many there are (docs/DESIGN.md §7.2). */
.foot-rail > button:nth-child(2) { transition-delay: calc(var(--dur-instant) * .25); }
.foot-rail > button:nth-child(3) { transition-delay: calc(var(--dur-instant) * .5); }
.foot-rail > button:nth-child(4) { transition-delay: calc(var(--dur-instant) * .75); }
.foot-rail > button:nth-child(n+5) { transition-delay: var(--dur-instant); }
/* What each one is, said beside it, is the tip's now (ui/tip.js): these
   were the one place snyvi drew its own labels, and every control has one
   the same way. The column holds itself open for as long as it is being answered: the
   pointer has usually left by then, and a tail pointing at the space where a
   button used to be is worse than no tail at all. */
.foot-rail:has(> button.said) > button { opacity: 1; transform: none; pointer-events: auto; }
`;
{ const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); }

/** Wire the buttons and fetch the other themes. Returns what the palette
 *  and the page call. */
export function init({ root, $, store, boot, toast, control, onDesk, desk, mmd, sayTermSize }) {
  /* One click always changes what you see: the button steps to the next of
   * the eight, as the swatch steps to the next accent. The one it lands on is
   * kept exactly as a palette pick is -- in the slot of its side, and
   * dropped to "the system" when that side is what the system shows, so the
   * OS switching light and dark still moves between your two.
   *
   * Which theme is in each slot, and whether the system or the button picks
   * the slot, are the three `snyvi.theme.*` keys; boot.js owns resolving them
   * into `data-theme` and "is it dark?". */
  const { system: sysDark } = snyviTheme;
  /* The eight, each with the side it is: which slot it lives in, and which
   * side the button lands on when it is kept. Four light and four dark, one
   * of each for every pair of accents. */
  const THEMES = { paper: ["Paper", "light"], snow: ["Snow", "light"], sage: ["Sage", "light"], parchment: ["Parchment", "light"],
    ink: ["Ink", "dark"], midnight: ["Midnight", "dark"], espresso: ["Espresso", "dark"], contrast: ["Contrast", "dark"] };
  const sysSide = () => (sysDark.matches ? "dark" : "light");
  const slot = k => store.get(k === "light" ? "snyvi.theme.light" : "snyvi.theme.dark") || (k === "light" ? "paper" : (matchMedia("(prefers-contrast: more)").matches ? "contrast" : "ink"));
  // The button steps through the eight like the swatch steps through the
  // accents: one click, the next one, the whole window in it.
  const ORDER = Object.keys(THEMES);
  const nextTheme = () => ORDER[(ORDER.indexOf(root.dataset.theme) + 1) % ORDER.length];
  const SUN = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="3.5"/><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06"/></svg>';
  const MOON = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z"/></svg>';
  function paintThemeBtn() {
    const b = $("#btn-theme"), n = nextTheme();
    // The icon is the side a click will land on.
    b.innerHTML = THEMES[n][1] === "dark" ? MOON : SUN;
    b.dataset.tip = `Theme: ${(THEMES[root.dataset.theme] || [root.dataset.theme])[0]}`; b.dataset.tipSub = `click for ${THEMES[n][0]}`;
  }
  $("#btn-theme").addEventListener("click", async () => { await loadThemes(); setTheme(nextTheme()); });
  paintThemeBtn();
  /* Every theme but Paper and Ink, fetched once the page is idle rather than
   * carried by first paint. The button and ⌘K theme wait on the same promise,
   * so a click that beats it -- a few milliseconds from the local daemon --
   * lands anyway. When it is in, the theme boot.js stood in for is drawn,
   * and the copies it will stand in with next time are brought up to date. */
  let themesP = null;
  const loadThemes = () => themesP ||= new Promise(done => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = `/assets/themes.css${boot.v ? `?v=${boot.v}` : ""}`;
    l.onload = () => {
      const was = root.dataset.theme;
      snyviTheme.ready();
      keepCopies();
      paintThemeBtn();
      if (root.dataset.theme !== was) mmd()?.retheme();
      done(true);
    };
    l.onerror = () => { l.remove(); themesP = null; done(false); };
    document.head.append(l);
  });
  /** The copies boot.js paints the first frame from: the block of the theme
   *  in each slot, as the sheet has it now, so a copy lasts exactly as long
   *  as that theme's colours do. Paper and Ink are in first paint and need
   *  none; a slot naming a theme that no longer exists goes back to its
   *  default. */
  function keepCopies() {
    const sheet = [...document.styleSheets].find(x => /\/assets\/themes\.css/.test(x.href || ""));
    if (!sheet) return;
    for (const side of ["light", "dark"]) {
      const t = slot(side), key = `snyvi.theme.css.${side}`;
      if (t === "paper" || t === "ink") { store.del(key); continue; }
      const rule = [...sheet.cssRules].find(r => r.selectorText === `[data-theme="${t}"]`);
      if (rule) store.set(key, ":root" + rule.cssText);
      else { store.del(key); store.del(`snyvi.theme.${side}`); }
    }
  }
  /** Keep a theme picked in the palette: it goes in the slot of its side, and
   *  the button lands on that side -- dropped to "the system" when that is
   *  what the system shows, the same rule as a click on the button. */
  function setTheme(name) {
    const [, side] = THEMES[name] || [];
    if (!side) return;
    store.set(side === "light" ? "snyvi.theme.light" : "snyvi.theme.dark", name);
    store.set("snyvi.theme.follow", side === sysSide() ? "" : side);
    keepCopies();
    previewTheme(null);
    // The page in its new colours is the answer (docs/DESIGN.md §4.1, rung
    // 0); the button's own label, under the hand, names it.
    paintThemeBtn();
  }
  /** Draw a theme without keeping it, or, with no name, the one that is
   *  kept. Diagrams already drawn in it come back from their cache. */
  function previewTheme(name) {
    const was = root.dataset.theme;
    name ? (root.dataset.theme = name) : snyviTheme.apply();
    if (root.dataset.theme !== was) mmd()?.retheme();
  }
  // The same fault by a different route: following the system, the page
  // moves when the system does, and the diagrams on it were drawn before it
  // moved. boot.js has already re-resolved `data-theme` by the time this runs;
  // applying again is free and keeps this from depending on that order.
  sysDark.addEventListener("change", () => {
    const was = root.dataset.theme;
    snyviTheme.apply();
    paintThemeBtn();
    if (root.dataset.theme !== was) mmd()?.retheme();
  });
  // The reading faces, in the order Aa steps through them. "" is Inter.
  const FONTS = [["", "Inter"], ["serif", "Source Serif"], ["literata", "Literata"], ["atkinson", "Atkinson Hyperlegible"], ["mono", "JetBrains Mono"]];
  function paintFontBtn() {
    const f = FONTS.find(([k]) => k === (root.dataset.font || "")) || FONTS[0];
    // On a desk, Aa is the terminal's text size; the face there is always mono.
    const b = $("#btn-font");
    // Dimmed, it says why it does nothing here (app.js paintControls); this
    // chunk arriving on the Inbox must not paint over that.
    if (b.classList.contains("dim")) return;
    if (onDesk()) { const t = desk().textSize(); b.dataset.tip = `Text size: ${t.name}`; b.dataset.tipSub = `click for ${t.next}`; return; }
    b.dataset.tip = `Font: ${f[1]}`; b.dataset.tipSub = "click for the next";
  }
  $("#btn-font").addEventListener("click", control("font", () => {
    if (onDesk()) { const t = desk().textSize(); desk().textSize(t.at === t.of - 1 ? -(t.of - 1) : 1); sayTermSize(); return; }
    const i = FONTS.findIndex(([k]) => k === (root.dataset.font || ""));
    const [next] = FONTS[(i + 1) % FONTS.length];
    next ? (root.dataset.font = next) : delete root.dataset.font;
    store.set("snyvi.font", next);
    paintFontBtn();
  }));
  paintFontBtn();
  /* The accent colours, in the order a click steps through them. "" is
   * passion, the default: the red the mark itself wears. They were a popover of eight swatches, which is a
   * menu to read for a setting with no wrong answer: every one of them is
   * simply a colour, and the only way to know which you want is to see it on
   * the page. So the button is the setting now -- one click, the next colour,
   * the whole window in it before the finger is off the mouse -- and the
   * swatch on the button is where you are. snyvi wears the accent too, so the
   * face that says which one it is arrives in that colour. */
  const ACCENTS = [["", "Passion"], ["crimson", "Crimson"], ["rose", "Rose"], ["violet", "Violet"], ["blue", "Blue"], ["teal", "Teal"], ["green", "Green"], ["graphite", "Graphite"]];
  const accBtn = $("#btn-accent");
  const accName = k => (ACCENTS.find(([a]) => a === k) || ACCENTS[0])[1];
  function paintAccent() {
    const i = ACCENTS.findIndex(([k]) => k === (root.dataset.accent || ""));
    accBtn.dataset.tip = `Accent: ${accName(ACCENTS[i][0])}`; accBtn.dataset.tipSub = `click for ${accName(ACCENTS[(i + 1) % ACCENTS.length][0])}`;
  }
  /* The tab's icon wears the accent too: snyvi's face drawn in the mascot
   * colours the stylesheet resolved, each a plain hex the SVG can hold,
   * which is how boot.js hands a token back. */
  function paintFavicon() {
    const [body, nub, ink] = ["--mascot", "--mascot-nub", "--mascot-ink"].map(v => snyviTheme.colour(v));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect x="14" y="0.5" width="4" height="5" rx="2" fill="${nub}"/><rect x="1" y="4" width="30" height="27" rx="9" fill="${body}"/><ellipse cx="11" cy="16.5" rx="2.6" ry="3.3" fill="${ink}"/><ellipse cx="21" cy="16.5" rx="2.6" ry="3.3" fill="${ink}"/><path d="M13.5 23Q16 25.2 18.5 23" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    const link = $("#favicon");
    if (link) link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function setAccent(k) {
    k ? (root.dataset.accent = k) : delete root.dataset.accent;
    store.set("snyvi.accent", k);
    paintAccent();
    paintFavicon();
    mmd()?.retheme();
  }
  accBtn.addEventListener("click", () => {
    const i = ACCENTS.findIndex(([k]) => k === (root.dataset.accent || ""));
    const [next] = ACCENTS[(i + 1) % ACCENTS.length];
    setAccent(next);
    // The swatch is the same shape in every colour, so the change is quiet
    // where the click was. It flicks once; its label, under the hand, names it.
    accBtn.classList.remove("flick"); void accBtn.offsetWidth; accBtn.classList.add("flick");
  });
  accBtn.addEventListener("animationend", () => accBtn.classList.remove("flick"));
  paintAccent();
  paintFavicon();
  loadThemes();
  /* ---------- the panes' widths ----------   (app.js's until 1.7.2) */
  /* Each pane's edge drags, between a floor where its rows stop being
   * readable and a ceiling past which the document would be the pane that
   * does not fit. The width goes into the custom property the grid already
   * reads, so every rule that knows the pane's width follows, and into
   * storage, which boot.js applies before first paint. Double-click puts the
   * default back; for a keyboard the arrow keys move it and Home and End
   * take it to either limit. */
  const PANES = [
    { el: $("#side"), prop: "--side-w", key: "snyvi.side-w", min: 200, max: 440, dflt: 264, sign: 1 },
    { el: $("#rail"), prop: "--rail-w", key: "snyvi.rail-w", min: 180, max: 400, dflt: 232, sign: -1 },
  ];
  for (const pane of PANES) {
    const g = pane.el.querySelector(".gutter");
    const width = () => parseFloat(getComputedStyle(root).getPropertyValue(pane.prop)) || pane.dflt;
    const set = w => {
      w = Math.round(Math.max(pane.min, Math.min(pane.max, w)));
      root.style.setProperty(pane.prop, `${w}px`);
      g.setAttribute("aria-valuenow", w);
      return w;
    };
    g.setAttribute("aria-valuenow", width());
    g.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const x0 = e.clientX, w0 = width();
      let w = w0;
      g.setPointerCapture(e.pointerId);
      root.dataset.resizing = "1";
      const move = ev => { w = set(w0 + pane.sign * (ev.clientX - x0)); };
      const up = () => {
        delete root.dataset.resizing;
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        store.set(pane.key, String(w));
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
      e.preventDefault();
    });
    g.addEventListener("dblclick", () => {
      root.style.removeProperty(pane.prop);
      store.del(pane.key);
      g.setAttribute("aria-valuenow", pane.dflt);
    });
    g.addEventListener("keydown", e => {
      const step = e.shiftKey ? 64 : 16;
      const to = e.key === "ArrowRight" ? width() + pane.sign * step
        : e.key === "ArrowLeft" ? width() - pane.sign * step
          : e.key === "Home" ? pane.min : e.key === "End" ? pane.max : null;
      if (to === null) return;
      // At once, as a drag is: the fold's easing would trail a held key.
      root.dataset.resizing = "1";
      store.set(pane.key, String(set(to)));
      void $("#app").offsetWidth;
      delete root.dataset.resizing;
      e.preventDefault();
      e.stopPropagation();
    });
  }


  /* The foot column is a toolbar: the arrows walk it (up is up: the column
   * grows upward from the switch, which is the first in the page's order),
   * Home and End go to its ends, and Esc lets it go. */
  const foot = $("#foot-rail");
  foot.addEventListener("keydown", e => {
    const bs = [...foot.querySelectorAll("button")].filter(b => b.offsetParent), at = bs.indexOf(document.activeElement);
    const go = i => bs[(i + bs.length) % bs.length]?.focus();
    if (e.key === "ArrowUp") go(at + 1); else if (e.key === "ArrowDown") go(at - 1);
    else if (e.key === "Home") go(0); else if (e.key === "End") go(-1);
    else if (e.key === "Escape") document.activeElement.blur();
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  return { THEMES, slot, previewTheme, setTheme, loadThemes, paintFontBtn, openSay };
}

// ---------- snyvi answers: what it says when a reader rests on the mark ----------
/** What it says, the face it says it with, and how often the line comes up.
 *  The weights are the whole character. Most of what it says is "hi"; a
 *  count when there is one worth giving; and "love you" seldom enough that
 *  it still means something when it lands. A line whose text comes back
 *  empty is not true right now -- no one is waiting, an agent is connected,
 *  it is the middle of the afternoon -- and drops out of the draw.
 *  Every one of them is short on purpose: the line is written where the
 *  word "snyvi" is, and it has that much room and no more. */
const SAYS = [
  { t: "hi", w: 5 },
  { t: "hey you", w: 3 },
  { t: "still here", w: 2 },
  { t: "hello again", w: 2, f: "glad" },
  { t: "glad you're here", w: 2, f: "glad" },
  { t: "love you", w: 1, f: "love" },
  { t: "my favourite", w: 1, f: "love" },
  { t: st => st.waiting ? `${st.waiting} waiting` : "", w: 4, f: "glad" },
  { t: st => Object.keys(st.online).length ? "" : "no agents", w: 3 },
  { t: () => { const h = new Date().getHours(); return h < 5 || h >= 23 ? "late one?" : h < 10 ? "morning" : ""; }, w: 3, f: "wink" },
  // For an hour after a desk's last open note was ticked (app.js markDone):
  // the milestone, answered, and nothing more said about it.
  { t: st => st.doneAt && Date.now() - st.doneAt < 3600e3 ? "all done" : "", w: 4, f: "glad" },
  // For an hour after an update landed (about.js): the maker who wonders
  // what changed points at the face and finds out which snyvi this is.
  { t: st => st.landed && Date.now() - st.landed.at < 3600e3 ? `now ${st.landed.v}` : "", w: 3 },
];
/** The last few lines, so the same one does not come up twice running. */
let saidLast = [];
function pickSay({ root, state }) {
  // The page cannot hear the daemon: the eyes are already shut, and this is
  // where a reader who wonders why finds out.
  if (root.dataset.link === "off") return { t: "not connected", f: "" };
  const pool = [];
  for (const s of SAYS) {
    const t = typeof s.t === "function" ? s.t(state) : s.t;
    if (!t || saidLast.includes(t)) continue;
    for (let i = 0; i < s.w; i++) pool.push({ t, f: s.f || "" });
  }
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : { t: "hi", f: "" };
}
export function openSay(c) {
  const { root, sayEl, state, quiet } = c;
  // A note still glowing is an agent waiting to be read. The agent has the
  // floor until then, and snyvi does not talk over its own messenger.
  // Quiet: the mascot speaks only when something is asked of it.
  if (root.dataset.note || quiet()) return;
  const s = pickSay(c);
  saidLast = [s.t, ...saidLast].slice(0, 3);
  sayEl.textContent = s.t;
  sayEl.hidden = false;
  void sayEl.offsetWidth;   // the resting state first, so the rise transitions
  sayEl.classList.add("on");
  // An empty face is still a face here: `html[data-say]` matching on the
  // bare attribute is what stops the waiting blink and nods the head, and
  // a line said with no expression wants both.
  root.dataset.say = s.f;
}
