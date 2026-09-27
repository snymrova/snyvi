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
.foot-rail > button:nth-child(2) { transition-delay: .02s; }
.foot-rail > button:nth-child(3) { transition-delay: .05s; }
.foot-rail > button:nth-child(4) { transition-delay: .08s; }
.foot-rail > button:nth-child(5) { transition-delay: .11s; }
.foot-rail > button:nth-child(6) { transition-delay: .14s; }
.foot-rail > button:nth-child(7) { transition-delay: .17s; }
/* What each one is, said beside it. These were \`title\`s, and the browser drew
   them where it liked -- over the column, on its own schedule, covering the
   very icons a reader was looking down to read. The name belongs next to the
   column, not on top of it, and there is room to the right for all of them.
   \`aria-label\` is what a screen reader was using all along; only the drawing
   of it has changed. */
.foot-rail > button { position: relative; }
.foot-rail > button::after, #rail-nav > .icon::after { content: attr(data-label);
  position: absolute; left: calc(100% + 9px); top: 50%; transform: translate(-3px, -50%); z-index: 32;
  padding: 3px 8px; border-radius: 7px; background: var(--bg-raise); border: 1px solid var(--rule);
  font-family: var(--sans); font-size: 11px; line-height: 1.35; font-weight: 500; color: var(--fg-2);
  white-space: nowrap; pointer-events: none; opacity: 0;
  transition: opacity .12s ease, transform .18s ease; }
.foot-rail > button:hover::after, .foot-rail > button:focus-visible::after, #rail-nav > .icon:not(.on):is(:hover, :focus-visible)::after { opacity: 1; transform: translateY(-50%); }
/* snyvi answers a press in that same strip of space to the right, which is
   the point of answering there -- so while it is talking, the label steps
   aside rather than being talked over. */
.foot-rail > button.said::after { opacity: 0 !important; }
/* And the column holds itself open for as long as it is being answered: the
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
    b.dataset.label = `Theme: ${(THEMES[root.dataset.theme] || [root.dataset.theme])[0]} · click for ${THEMES[n][0]}`;
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
    const [label, side] = THEMES[name] || [];
    if (!side) return;
    store.set(side === "light" ? "snyvi.theme.light" : "snyvi.theme.dark", name);
    store.set("snyvi.theme.follow", side === sysSide() ? "" : side);
    keepCopies();
    previewTheme(null);
    paintThemeBtn();
    toast("Theme", label, null, null, { face: "glad", at: $("#btn-theme") });
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
    if (onDesk()) { const t = desk().textSize(); $("#btn-font").dataset.label = `Text size: ${t.name} · click for ${t.next}`; return; }
    $("#btn-font").dataset.label = `Font: ${f[1]} · click for the next`;
  }
  $("#btn-font").addEventListener("click", control("font", () => {
    if (onDesk()) { const t = desk().textSize(); desk().textSize(t.at === t.of - 1 ? -(t.of - 1) : 1); sayTermSize(); return; }
    const i = FONTS.findIndex(([k]) => k === (root.dataset.font || ""));
    const [next, name] = FONTS[(i + 1) % FONTS.length];
    next ? (root.dataset.font = next) : delete root.dataset.font;
    store.set("snyvi.font", next);
    paintFontBtn();
    toast("Font", name, null, null, { face: "glad", at: $("#btn-font") });
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
    accBtn.dataset.label = `Accent: ${accName(ACCENTS[i][0])} · click for ${accName(ACCENTS[(i + 1) % ACCENTS.length][0])}`;
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
    const [next, name] = ACCENTS[(i + 1) % ACCENTS.length];
    setAccent(next);
    // The swatch is the same shape in every colour, so the change is quiet
    // where the click was. It flicks once, and snyvi says the name beside it.
    accBtn.classList.remove("flick"); void accBtn.offsetWidth; accBtn.classList.add("flick");
    toast("Accent", name, null, null, { face: "glad", at: accBtn });
  });
  accBtn.addEventListener("animationend", () => accBtn.classList.remove("flick"));
  paintAccent();
  paintFavicon();
  loadThemes();
  return { THEMES, slot, previewTheme, setTheme, loadThemes, paintFontBtn };
}
