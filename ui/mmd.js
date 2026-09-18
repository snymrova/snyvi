/* The diagram driver: everything snyvi does with Mermaid, and the one part of
 * the page that is not paid for at first paint.
 *
 * It lives here rather than in app.js because of what it costs. Mermaid itself
 * has always been lazy -- 952.8 KB fetched when a diagram is on screen and not
 * before -- but the code that drives it was not: 820 lines and 11.6 KB gzipped
 * of queueing, caching, theming, zooming and fullscreen, carried by every page
 * load whether or not a diagram was ever going to be drawn. Most documents have
 * no diagram in them. bench/bytes.mjs is what made this visible and what keeps
 * it true; docs/DIAGRAMS.md has the timings the behaviour here is tuned to.
 *
 * The seam is four functions. `prepare` on every render, `retheme` when the
 * theme moves, and `escape` and `key` for the keys -- and app.js calls none of
 * them until a document holding `pre.mermaid` has actually arrived, which is
 * what makes the import lazy rather than merely deferred.
 *
 * Nothing is passed in. The module takes its own handles on the page below,
 * because it is only ever imported once a document is on screen, and a seam
 * with no arguments is a seam with nothing to keep in step.
 */

const root = document.documentElement;
const main = document.querySelector("#main");
const docEl = document.querySelector("#doc");
const boot = JSON.parse(document.querySelector("#boot")?.textContent || "{}");


// ---------- mermaid (loaded only when a diagram is actually wanted) ----------
/* A diagram is drawn when the reader is near it, one per task, and never as
 * part of the render that puts the document on screen. `mermaid.run` drew
 * every diagram on the page in one unyielding call: a 220-node flowchart
 * froze the tab for 3.1 seconds, during which it neither scrolled nor
 * answered a key. docs/DIAGRAMS.md has the measurements; bench/browser.mjs
 * keeps them honest. */
let mermaidReady = null;   // the library, once something has asked for it
let mermaidTheme = null;   // the theme it was last initialised with
let mmdToken = 0;          // bumped when the body is replaced; queued work checks it
let mmdQueue = [];
let mmdDraining = false;
let mmdSeq = 0;
let mmdWatcher = null;

/* A diagram is a pure function of its source and the theme, and a stored
 * document never changes, so no SVG in this tab is worth computing twice.
 * Measured before this existed: revisiting a document drew the 220-node
 * flowchart again for another 2426 ms, and `snyvi watch` paid the same price
 * on every save of the file it was watching.
 *
 * A source that cannot be parsed is remembered as well, so the rule is the
 * whole of it: no source is handed to Mermaid twice in one tab. The failure
 * is a fact about the source in exactly the way the drawing is, and the
 * document holding it is the one a reader re-opens to look at what the agent
 * actually wrote.
 *
 * What is kept is the SVG with the id it was drawn under swapped for a token.
 * That id is the one part of the string that belongs to the figure rather
 * than to the drawing -- Mermaid writes it into the root element, into an
 * id-scoped <style> block, and into the ids of the markers its edges point at
 * -- so a document carrying the same diagram twice would otherwise put two of
 * each into the page and let the second one's arrowheads resolve to the
 * first.
 *
 * Bounded in bytes rather than in entries, because one diagram's SVG is two
 * orders of magnitude larger than another's, and a tab left open all day
 * reading documents is exactly the tab this project promises will stay
 * small. */
const mmdCache = new Map();          // `theme\nsource` -> {svg} or {err}, least recent first
const MMD_CACHE_BYTES = 4 << 20;
const MMD_ID = "__mmd_id__";
let mmdCacheBytes = 0;

const mmdRenderId = fig => `${fig.dataset.mmdId}-svg`;
const mmdKey = src => `${mmdCurrentTheme()}\n${src}`;
const mmdCached = src => mmdCache.has(mmdKey(src));

const mmdSize = e => (e.svg || e.err || "").length;

function mmdTake(key) {
  const entry = mmdCache.get(key);
  if (entry === undefined) return null;
  // Re-inserted, so the Map's own insertion order is least-recent-first and
  // eviction is a walk from the front.
  mmdCache.delete(key);
  mmdCache.set(key, entry);
  return entry;
}

function mmdKeep(key, entry) {
  if (mmdCache.has(key)) mmdCacheBytes -= mmdSize(mmdCache.get(key));
  mmdCache.set(key, entry);
  mmdCacheBytes += mmdSize(entry);
  for (const [k, v] of mmdCache) {
    // Never the entry just asked for, even when it is alone and over the
    // budget by itself: evicting it would make the next visit pay again for
    // the one diagram most likely to be wanted.
    if (mmdCacheBytes <= MMD_CACHE_BYTES || k === key) break;
    mmdCache.delete(k);
    mmdCacheBytes -= mmdSize(v);
  }
}

/** Past this a diagram is offered rather than drawn. The flowchart that
 *  started all this costs 2.4 s of CPU however it is scheduled, and spending
 *  that on a reader who was scrolling past is not a thing a scheduler can
 *  make polite. */
const MMD_CAP_LINES = 150, MMD_CAP_BYTES = 20000;

/** What a diagram will cost, judged from its source: Mermaid draws roughly one
 *  node or edge per line that is neither blank nor a `%%` comment. */
function mmdWeight(src) {
  let n = 0;
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("%%")) n++;
  }
  return n;
}

const yieldToBrowser = () =>
  window.scheduler && window.scheduler.yield
    ? window.scheduler.yield()
    : new Promise(r => setTimeout(r, 0));

/** Put something in the frame in place of the diagram: a label, a spinner, a
 *  button, an error. Replacing the frame's contents wholesale is what makes
 *  the states exclusive -- there is never a stale spinner under an SVG. */
function mmdNote(fig, ...nodes) {
  const note = document.createElement("div");
  note.className = "mmd-note";
  note.append(...nodes);
  const frame = fig.querySelector(".mmd-frame");
  frame.textContent = "";
  frame.append(note);
  return note;
}

/** Every `<pre class="mermaid">` the server sent becomes a placeholder of about
 *  the right size, watched for coming near the viewport. Called wherever the
 *  body changes, and the bumped token is what stops a diagram queued for the
 *  document the reader just left from being drawn into a detached node. */
/** Generous, so a diagram is drawn by the time it is scrolled to rather than
 *  after: a screen of margin is roughly a flick of the wheel. */
function mmdWatch() {
  if (mmdWatcher) mmdWatcher.disconnect();
  mmdWatcher = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      mmdWatcher.unobserve(e.target);
      mmdEnqueue(e.target);
    }
  }, { root: main, rootMargin: "600px 0px" });
}

export function prepare() {
  // A new document under a filled figure: the figure goes with the old one,
  // and the browser's fullscreen, if it was granted, goes with it.
  if (document.fullscreenElement) quiet(document.exitFullscreen());
  mmdToken++;
  mmdQueue = [];
  if (mmdWatcher) mmdWatcher.disconnect();
  mmdWatcher = null;
  const pres = docEl.querySelectorAll("pre.mermaid");
  if (!pres.length) return;
  mmdWatch();
  for (const pre of pres) {
    const fig = document.createElement("figure");
    fig.className = "mmd";
    fig.dataset.src = pre.textContent.trim();
    fig.dataset.mmdId = `mmd-${++mmdSeq}`;
    const frame = document.createElement("div");
    frame.className = "mmd-frame";
    fig.appendChild(frame);
    pre.replaceWith(fig);
    mmdReserve(fig);
  }
  mmdPrefetch();
}

/** The theme moved, so every diagram on the page was drawn in the other one.
 *  Put them all back to placeholders and queue what is near the viewport
 *  again: for anything this tab has already drawn in the theme being returned
 *  to, that costs a string assignment, since the theme is half of the cache
 *  key. Nothing is dropped -- toggling back is free as well, and the byte
 *  bound is what keeps holding both from mattering. */
export function retheme() {
  const figs = [...docEl.querySelectorAll(".mmd")];
  if (!figs.length) return;
  mmdToken++;
  mmdQueue = [];
  mmdWatch();
  for (const fig of figs) mmdReserve(fig);
}

/** A figure, in the state it starts in: a box of about the right size, and
 *  either a place in the queue or an offer to draw it. Shared by the first
 *  pass over a document and by a theme change, which starts them all over. */
function mmdReserve(fig) {
  const src = fig.dataset.src;
  const weight = mmdWeight(src);
  fig.classList.remove("mmd-slow");
  // An estimate and only that: the source says how much there is to draw,
  // never how tall the drawing will be. Measured on the fixture in
  // bench/fixture.mjs, a small flowchart lands at 258 px and a nine-line
  // sequence diagram at 383, so the floor sits between them rather than
  // under both -- half a screen of settling either way beats a full one in
  // one direction. Phase 3 is what makes this exact: a diagram in a frame of
  // a bounded height is a height that can be reserved rather than guessed.
  fig.style.setProperty("--mmd-reserve", `${Math.min(520, Math.max(240, 170 + weight * 4))}px`);
  // The cap is about cost, and a diagram already drawn in this tab has none:
  // a reader who asked for this one once is not asked again on the way back.
  if ((weight > MMD_CAP_LINES || src.length > MMD_CAP_BYTES) && !mmdCached(src)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mmd-ask";
    btn.dataset.mmdRender = "";
    btn.textContent = "Render diagram";
    const why = document.createElement("span");
    why.className = "mmd-why";
    why.textContent = `${weight} lines — this one takes a moment`;
    // An offer, not a diagram on its way: it reserves room for itself and
    // not for the drawing behind it, which arrives only if asked for.
    fig.style.setProperty("--mmd-reserve", "150px");
    fig.dataset.state = "held";
    mmdNote(fig, btn, why);
  } else {
    fig.dataset.state = "pending";
    mmdNote(fig, document.createTextNode("Diagram"));
    mmdWatcher.observe(fig);
  }
}

/** Ask for the library as soon as a page is known to hold a diagram at all,
 *  in idle time, rather than when a diagram comes near the viewport.
 *
 *  Measured: the first diagram on a page lands at ~1170 ms, of which ~490 ms
 *  is one unbreakable task compiling 3.57 MB of JavaScript -- and none of it
 *  used to start until the reader had scrolled to the diagram, which is the
 *  worst possible moment to begin. Spent here it is spent while they are
 *  still reading the first screen, and by the time they arrive only the
 *  drawing is left. A page with no diagram asks for nothing, which is most
 *  pages; a tab that already has the library asks again for nothing at all.
 *
 *  `requestIdleCallback` rather than a timer, so this waits for a gap instead
 *  of making one. The timeout is the floor under a tab that never has a gap:
 *  the compile is coming either way, and sooner is a better moment than the
 *  one the reader chose. */
function mmdPrefetch() {
  if (mermaidReady) return;
  const go = () => { if (!mermaidReady) mermaidLib().catch(() => {}); };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2000 });
  else setTimeout(go, 400);
}

function mmdEnqueue(fig) {
  if (fig.dataset.state === "queued" || fig.dataset.state === "rendering" || fig.dataset.state === "done") return;
  fig.dataset.state = "queued";
  mmdNote(fig, document.createTextNode("Diagram"));
  mmdQueue.push(fig);
  mmdDrain();
}

/** The library, fetched the first time a diagram is actually wanted. The marks
 *  are what let bench/browser.mjs tell a long task spent compiling 3.57 MB of
 *  Mermaid from one spent drawing with it -- two different faults with two
 *  different fixes. */
function mermaidLib() {
  if (!mermaidReady) {
    performance.mark("snyvi:mermaid-load");
    mermaidReady = new Promise((res, rej) => {
      const sc = document.createElement("script");
      // Versioned like every other asset: the bundle is served immutable for
      // a year, so without this a browser would keep the first one it ever
      // saw across every upgrade.
      sc.src = `/assets/mermaid.js${boot.v ? `?v=${boot.v}` : ""}`;
      sc.onload = () => { performance.mark("snyvi:mermaid-ready"); res(); };
      sc.onerror = () => rej(new Error("could not load the diagram library"));
      document.head.appendChild(sc);
    });
  }
  return mermaidReady;
}

/** `initialize` decides the theme of the next render and nothing else, so it is
 *  called when the theme has moved rather than once. Diagrams already drawn
 *  keep the theme they were drawn in; re-drawing them belongs with the cache. */
function mmdCurrentTheme() {
  const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? "dark" : "light";
}

/** The diagram is drawn in the viewer's own palette, read off `:root` rather
 *  than written out again here -- so a token changed in app.css moves the
 *  diagrams with it and the two cannot drift.
 *
 *  `theme: "base"` is the lever: it is the only theme that takes
 *  `themeVariables` at all, which is why `neutral` could never be nudged into
 *  the palette one value at a time. What a colour cannot say goes in
 *  `themeCSS`, which Mermaid emits inside each diagram's own `#id`-scoped
 *  <style> block, after its own rules -- so it wins by order, where the same
 *  rules in app.css would lose on specificity and need `!important` on every
 *  line. */
function mmdTheme() {
  const cs = getComputedStyle(root);
  const v = n => cs.getPropertyValue(n).trim();
  const bg = v("--bg"), raise = v("--bg-raise"), side = v("--bg-side");
  const fg = v("--fg"), fg2 = v("--fg-2"), fg3 = v("--fg-3");
  const rule = v("--rule"), rule2 = v("--rule-2");
  const accent = v("--accent"), accentBg = v("--accent-bg");
  return {
    fontFamily: v("--sans"),
    themeVariables: {
      background: bg, edgeLabelBackground: bg,
      mainBkg: raise, primaryColor: raise, actorBkg: raise, stateBkg: raise,
      secondaryColor: side, clusterBkg: side, labelBoxBkgColor: side,
      primaryTextColor: fg, textColor: fg, nodeTextColor: fg,
      // Mermaid computes `stateLabelColor = stateLabelColor || stateBkg ||
      // primaryTextColor`, so mapping stateBkg to the box's own fill -- which
      // is right for the box -- paints every state label the colour of the
      // thing behind it. Measured: white on white, labels present in the DOM,
      // correctly positioned, invisible. Named explicitly, it cannot happen.
      stateLabelColor: fg,
      signalColor: fg2, signalTextColor: fg2, titleColor: fg2,
      lineColor: fg3,
      clusterBorder: rule,
      nodeBorder: rule2, primaryBorderColor: rule2, actorBorder: rule2,
      noteBkgColor: accentBg, activationBkgColor: accentBg,
      noteBorderColor: accent, activationBorderColor: accent,
      /* A gantt draws its own everything: bars, section bands, a grid, and
       * text placed inside a bar or beside it depending on how much room
       * there is. None of it derives from the values above, which is how
       * "Scheduler" came to sit at 1.4:1 on its own bar. The text colours are
       * all `--fg` because every bar fill here is within a shade of the page.
       */
      sectionBkgColor: bg, altSectionBkgColor: side, sectionBkgColor2: bg,
      taskBkgColor: raise, taskBorderColor: rule2,
      activeTaskBkgColor: accentBg, activeTaskBorderColor: accent,
      doneTaskBkgColor: side, doneTaskBorderColor: rule2,
      critBkgColor: accentBg, critBorderColor: accent,
      taskTextColor: fg, taskTextDarkColor: fg, taskTextLightColor: fg,
      taskTextOutsideColor: fg2, taskTextClickableColor: accent,
      gridColor: rule, todayLineColor: accent,
    },
    /* Descendant selectors throughout: a `>` comes back HTML-escaped in the
     * SVG string, and while it round-trips correctly through `innerHTML`,
     * anything reading that string as text sees a broken selector. Nothing
     * here needs one.
     *
     * Terse on purpose, and explained here rather than in the string: Mermaid
     * copies themeCSS into every diagram's own <style> block, so a page with
     * eight diagrams carries eight copies of whatever is written below. The
     * rules are measured at ~651 bytes; a paragraph of reasoning would be
     * larger than the rules.
     *
     * The focus label is the paper colour rather than --accent-bg. On paper
     * the accent is a dark orange and --accent-bg a pale wash of it, which
     * reads well; in the dark palette the accent is a *light* orange and
     * --accent-bg is that same orange at 14% alpha, so a label composited
     * onto the fill behind it measured 1.0:1 -- the same colour, twice.
     * --bg is the one token guaranteed to oppose the accent in both
     * palettes, because the accent is chosen to sit on it. */
    themeCSS: `
      .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 1px; }
      .edgePath .path, .flowchart-link { stroke-width: 1.25px; }
      .cluster rect { rx: 8px; ry: 8px; }
      .nodeLabel, .edgeLabel, .label, .messageText, .loopText, .noteText { letter-spacing: .01em; }
      text.title, .titleText { font-family: ${v("--serif")}; font-size: 18px; font-weight: 600; }
      .node.focus rect, .node.focus circle, .node.focus ellipse, .node.focus polygon, .node.focus path { fill: ${accent}; stroke: ${accent}; }
      .node.focus .nodeLabel { color: ${bg}; fill: ${bg}; }
      .node.muted rect, .node.muted circle, .node.muted ellipse, .node.muted polygon, .node.muted path { fill: ${bg}; stroke: ${rule}; }
      .node.muted .nodeLabel { color: ${fg3}; fill: ${fg3}; }
    `,
  };
}

function mmdInit() {
  const theme = mmdCurrentTheme();
  if (theme === mermaidTheme) return;
  mermaidTheme = theme;
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", ...mmdTheme() });
}

/** One diagram per task, yielding between. A 2433 ms diagram is still 2433 ms
 *  of CPU -- but it is one diagram's worth, and every slot boundary hands the
 *  browser back a frame. */
async function mmdDrain() {
  if (mmdDraining) return;
  mmdDraining = true;
  const token = mmdToken;
  try {
    await mermaidLib();
    if (token !== mmdToken) return;
    mmdInit();
    while (mmdQueue.length && token === mmdToken) {
      const fig = mmdQueue.shift();
      if (!fig.isConnected || fig.dataset.state !== "queued") continue;
      await mmdRender(fig, token);
      if (mmdQueue.length) await yieldToBrowser();
    }
  } catch (e) {
    console.warn("mermaid", e);
    if (token === mmdToken) {
      for (const fig of mmdQueue) if (fig.isConnected) mmdFail(fig, e);
      mmdQueue = [];
    }
  } finally {
    mmdDraining = false;
    // Something may have come near the viewport while the library was loading,
    // or while the diagram before it was drawing. The token is deliberately
    // not consulted here: when the reader navigates mid-render this loop ends
    // on the stale token while the new document's diagrams are already queued,
    // and a restart conditional on the old token would strand them. mmdDrain
    // reads the current token on the way in, so the restart is the new
    // document's, not this one's.
    if (mmdQueue.length) mmdDrain();
  }
}

async function mmdRender(fig, token) {
  fig.dataset.state = "rendering";
  const key = mmdKey(fig.dataset.src);
  const hit = mmdTake(key);
  if (hit !== null) {
    // Nothing to wait for, so no spinner and no slow class -- which the
    // on-demand button sets on the way in, before it can know this one is
    // free.
    fig.classList.remove("mmd-slow");
    hit.svg ? mmdPaint(fig, hit.svg, performance.now()) : mmdFail(fig, hit.err);
    return;
  }
  // A spinner only once the wait is long enough to be worth explaining.
  const slow = setTimeout(() => fig.classList.add("mmd-slow"), 150);
  const t0 = performance.now();
  try {
    const id = mmdRenderId(fig);
    const { svg } = await window.mermaid.render(id, fig.dataset.src);
    const kept = svg.split(id).join(MMD_ID);
    // Kept before the token is consulted: the drawing is done and paid for
    // either way, and a reader who navigated away while it was being made is
    // the reader most likely to come straight back to it.
    mmdKeep(key, { svg: kept });
    if (token !== mmdToken || !fig.isConnected) return;
    mmdPaint(fig, kept, t0);
  } catch (e) {
    mmdKeep(key, { err: e && e.message ? e.message : String(e) });
    if (token === mmdToken && fig.isConnected) mmdFail(fig, e);
  } finally {
    clearTimeout(slow);
    fig.classList.remove("mmd-slow");
  }
}

/** The cached string carries a token where its id belongs, and the figure it
 *  is painted into supplies one. */
function mmdPaint(fig, svg, t0) {
  const frame = fig.querySelector(".mmd-frame");
  frame.innerHTML = svg.split(MMD_ID).join(mmdRenderId(fig));
  fig.dataset.state = "done";
  mmdViewport(fig);
  // Named, so the browser budget can find it. A cache hit measures what it
  // actually costs, which is the assignment above.
  performance.measure("snyvi:diagram", { start: t0, end: performance.now() });
}

// ---------- a diagram in a viewport: pan, zoom, fullscreen ----------
/* Mermaid hands back an SVG with a viewBox, and everything a reader needs is
 * a viewport around it. The viewBox is what this drives, rather than a CSS
 * transform: the browser redraws the same vectors into a different box, so
 * strokes stay crisp at any zoom and a frame costs nothing.
 *
 * Measured before it existed (docs/DIAGRAMS.md section 8): the 220-node
 * flowchart is 4738 px wide and was drawn 30 px tall, because `max-width:
 * 100%` fitted its width into the reading column and `height: auto` took the
 * height down with it. The one diagram big enough to be worth drawing was the
 * one that could not be read.
 *
 * A diagram that has to be shrunk to fit the column is the one that gets a
 * bounded frame; one that already fits keeps the height it drew itself at,
 * because for a long sequence diagram the page's own scroll is the right
 * viewport and always was. Both can be zoomed, panned and filled to the
 * screen. */
const mmdViews = new WeakMap();
const MMD_MAX_ZOOM = 40;          // 4738 px of flowchart, read at 120 px of it
const MMD_MIN_FIT = 0.15;         // a fit smaller than this is a smudge, not a diagram
let mmdTouched = null;            // the last diagram the reader used, for the keys

/** The tallest a fitted diagram may be: most of a screen and never more than
 *  one, so the text after it is still something the reader can see. */
const mmdCap = () => Math.max(260, Math.min(680, Math.round(innerHeight * 0.7)));

/** Give a drawn diagram its frame and its fit. Called on every paint, cache
 *  hit included, because the SVG is new each time and the frame's width may
 *  not be. */
function mmdViewport(fig) {
  const svg = fig.querySelector("svg");
  const frame = fig.querySelector(".mmd-frame");
  if (!svg || !frame) {
    mmdViews.delete(fig);
    return;
  }
  const full = fig.dataset.full === "1";
  // The window's width when the figure fills it, rather than the frame's:
  // the frame is the window then, but measured before the browser has laid
  // that out it still says what it was. A figure that is not laid out at
  // all cannot be fitted; left as it is, it is fitted on the next pass.
  const width = full ? Math.round(innerWidth) : frame.clientWidth;
  if (!width) return;
  mmdViews.delete(fig);
  // The graph's own bounds, kept on the element: the live viewBox is wherever
  // the reader has panned to, so a second pass -- a resize, or coming back
  // from fullscreen -- would otherwise take the view for the whole diagram
  // and never find its way out again.
  const vb = (svg.dataset.mmdBase || svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  // No usable viewBox is not a failure: the diagram is shown as Mermaid sized
  // it, and it simply has no viewport. Nothing below assumes one exists.
  if (vb.length !== 4 || vb.some(n => !Number.isFinite(n)) || vb[2] <= 0 || vb[3] <= 0) return;
  const base = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  svg.dataset.mmdBase = `${base.x} ${base.y} ${base.w} ${base.h}`;
  // Mermaid sizes the SVG itself, in the units it drew in. The frame decides
  // how big it is on the page from here on.
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  /* A graph far wider than the column has a fit nobody can read: the 220-node
   * flowchart measures 20023 units across and fits at 4% of itself, which is
   * a smudge rather than a shape. Past that point the diagram opens where a
   * label can be read instead -- at its own size, at the corner it starts in
   * -- and "Fit" is the button that offers the bird's-eye. Under it, fitted
   * is what a reader wants and what they get. */
  const fitScale = width / base.w;
  const smudge = fitScale < MMD_MIN_FIT;
  const height = full ? Math.round(innerHeight)
    : smudge ? mmdCap()
      : base.w > width ? Math.max(220, Math.min(mmdCap(), Math.round(base.h * fitScale)))
        : Math.round(base.h);
  frame.style.height = `${height}px`;
  mmdViews.set(fig, { base, svg, frame, view: { ...base }, fit: null });
  mmdFit(fig);
  if (smudge && !full) mmdStart(fig);
  mmdTools(fig);
}

/** The whole graph, in a box shaped like the frame it is shown in.
 *
 *  Matching the frame's aspect ratio is what makes the arithmetic below exact:
 *  with the two in step there is no letterboxing, so one pixel of frame is one
 *  known distance in the diagram and a point under the cursor can be held
 *  still while the view shrinks around it. */
function mmdFit(fig) {
  const v = mmdViews.get(fig);
  if (!v) return;
  const r = v.frame.getBoundingClientRect();
  const shape = (r.width || 1) / (r.height || 1);
  const { base } = v;
  const w = base.w / base.h > shape ? base.w : base.h * shape;
  const h = w / shape;
  v.fit = { x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h };
  v.view = { ...v.fit };
  // A diagram small enough to be shown whole at its own size is already at
  // full size, so "100%" would be a button that does nothing. Zoom in and out
  // still say what they mean, and the toggle comes back the moment there is a
  // difference between the two states.
  v.shrunk = (r.width || 1) / w < 0.995;
  mmdApply(fig);
}

/** Where a diagram too wide to fit opens: its own size, at the corner it
 *  starts in, which for every graph Mermaid lays out is where the beginning
 *  of it is. */
function mmdStart(fig) {
  const v = mmdViews.get(fig);
  if (!v) return;
  const r = v.frame.getBoundingClientRect();
  const w = Math.min(v.fit.w, r.width || v.fit.w);
  const h = w * v.fit.h / v.fit.w;
  v.view = { x: v.base.x, y: v.base.y, w, h };
  mmdClamp(fig);
  mmdApply(fig);
}

/** Pixels per diagram unit, as the SVG is actually drawn right now. */
function mmdScale(fig) {
  const v = mmdViews.get(fig);
  if (!v) return 1;
  const r = v.svg.getBoundingClientRect();
  return Math.min(r.width / v.view.w, r.height / v.view.h) || 1;
}

/** Where in the diagram a point on the screen is. */
function mmdPoint(fig, cx, cy) {
  const v = mmdViews.get(fig);
  if (!v || cx == null) return null;
  const r = v.svg.getBoundingClientRect();
  const s = Math.min(r.width / v.view.w, r.height / v.view.h);
  if (!(s > 0)) return null;
  const ox = (r.width - v.view.w * s) / 2, oy = (r.height - v.view.h * s) / 2;
  return { x: v.view.x + (cx - r.left - ox) / s, y: v.view.y + (cy - r.top - oy) / s };
}

/** The reader cannot lose the diagram: wherever the view goes, its middle
 *  stays over the graph. Forgiving rather than strict, so a flick of the
 *  wrist never has to be undone. */
function mmdClamp(fig) {
  const { base, view } = mmdViews.get(fig);
  const cx = Math.min(Math.max(view.x + view.w / 2, base.x), base.x + base.w);
  const cy = Math.min(Math.max(view.y + view.h / 2, base.y), base.y + base.h);
  view.x = cx - view.w / 2;
  view.y = cy - view.h / 2;
}

function mmdApply(fig) {
  const v = mmdViews.get(fig);
  if (!v) return;
  const { view, fit } = v;
  v.svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  const zoomed = !!fit && view.w < fit.w - 0.5;
  fig.dataset.zoom = zoomed ? "in" : "fit";
  const toggle = fig.querySelector("[data-mmd=zoom]");
  if (toggle) {
    toggle.hidden = !v.shrunk && !zoomed;
    toggle.textContent = zoomed ? "Fit" : "100%";
    toggle.title = zoomed ? "Fit the whole diagram  0" : "Show it at full size";
  }
}

/** Zoom by `k` about a point on the screen, or about the middle of the frame.
 *  Out is bounded by the fit -- there is nothing past the whole diagram -- and
 *  in by MMD_MAX_ZOOM, which is where the largest diagram measured becomes a
 *  screenful of readable labels. */
function mmdZoom(fig, k, cx, cy) {
  const v = mmdViews.get(fig);
  if (!v || !v.fit) return;
  const w = Math.max(v.fit.w / MMD_MAX_ZOOM, Math.min(v.fit.w, v.view.w / k));
  if (Math.abs(w - v.view.w) < 0.01) return;
  const h = w * v.view.h / v.view.w;
  const p = mmdPoint(fig, cx, cy) || { x: v.view.x + v.view.w / 2, y: v.view.y + v.view.h / 2 };
  v.view.x = p.x - (p.x - v.view.x) * (w / v.view.w);
  v.view.y = p.y - (p.y - v.view.y) * (h / v.view.h);
  v.view.w = w;
  v.view.h = h;
  mmdClamp(fig);
  mmdApply(fig);
  mmdTouched = fig;
}

/** One diagram unit per pixel: the "let me read that label" half of the
 *  toggle, from wherever the reader is looking. */
function mmdActual(fig) {
  const v = mmdViews.get(fig);
  if (!v || !v.fit) return;
  const r = v.frame.getBoundingClientRect();
  mmdZoom(fig, v.view.w / Math.max(1, r.width), null, null);
}

/** Fill the window with one diagram; the same key or button, or Escape,
 *  gives the page back.
 *
 *  The figure is laid over the page from where it is (`.mmd[data-full]` in
 *  app.css), and the document, not the figure, asks the browser for
 *  fullscreen -- a courtesy that hides the browser's own chrome where it is
 *  granted, and nothing here depends on the answer. 0.9 put the figure
 *  itself in the top layer, and in WebKitGTK, the engine of the Linux
 *  window, two things came of that: every glyph inside the fullscreen
 *  element drew as nothing -- the boxes and arrows stayed; the labels, the
 *  tool bar and an SVG's own <text> went -- and on the way back the figure,
 *  a content-visibility placeholder again, kept the placeholder's size
 *  until the next scroll laid it out. A fixed box in the page has neither
 *  fault in any engine, and the figure is marked visible for good, since it
 *  is the one the reader is looking at. bench/webkit.py is where both were
 *  seen. */
let mmdFullFrom = 0;   // where the document was, to put it back there
function quiet(p) { if (p && p.catch) p.catch(() => {}); }   // a promise whose refusal is no news
function mmdFull(fig) {
  const open = docEl.querySelector(".mmd[data-full]");
  if (open) { mmdUnfill(open); return; }
  mmdFullFrom = main.scrollTop;
  fig.style.contentVisibility = "visible";
  fig.dataset.full = "1";
  mmdRefit();
  if (document.documentElement.requestFullscreen && !document.fullscreenElement) quiet(document.documentElement.requestFullscreen());
}
function mmdUnfill(fig) {
  delete fig.dataset.full;
  main.scrollTo({ top: mmdFullFrom, behavior: "instant" });
  mmdRefit();
  if (document.fullscreenElement) quiet(document.exitFullscreen());
}
/** After the browser has laid the change out, not during: measured
 *  mid-transition, a frame reports the width it is leaving and the diagram
 *  comes back fitted to a column that is no longer there. */
function mmdRefit() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) mmdViewport(fig);
  }));
}
// The browser's own way out -- Escape, or whatever it binds -- ends the
// fill too; a window that changed size around it is measured again.
document.addEventListener("fullscreenchange", () => {
  const open = docEl.querySelector(".mmd[data-full]");
  if (open && !document.fullscreenElement) mmdUnfill(open);
  else mmdRefit();
});

/** The controls, added once per figure and shown when it is under the cursor
 *  or holds the focus -- the same bargain the rename pencils in the tree make:
 *  present when wanted, absent from a page being read. */
function mmdTools(fig) {
  if (fig.querySelector(".mmd-tools")) return;
  const bar = document.createElement("div");
  bar.className = "mmd-tools";
  bar.innerHTML =
    `<button type="button" data-mmd="out" title="Zoom out" aria-label="Zoom out">−</button>` +
    `<button type="button" data-mmd="in" title="Zoom in  (double-click, or ⌘/ctrl + scroll)" aria-label="Zoom in">+</button>` +
    `<button type="button" data-mmd="zoom" title="Show it at full size">100%</button>` +
    `<button type="button" data-mmd="full" title="Fill the screen  f" aria-label="Fill the screen">⛶</button>`;
  fig.appendChild(bar);
  mmdApply(fig);
}

/** Which diagram a key means: the one under the cursor, else whichever one is
 *  most on screen, else the last one the reader used.
 *
 *  "The first one on the page" was the obvious fallback and the wrong one --
 *  a reader pressing a key is looking at something, and on a page of eight
 *  diagrams it is rarely the first. */
function mmdKeyed() {
  const hovered = docEl.querySelector('.mmd[data-state="done"]:hover');
  if (hovered && mmdViews.has(hovered)) return hovered;
  const middle = innerHeight / 2;
  let best = null, nearest = Infinity;
  for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) {
    if (!mmdViews.has(fig)) continue;
    const r = fig.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;
    const d = Math.abs((r.top + r.bottom) / 2 - middle);
    if (d < nearest) { nearest = d; best = fig; }
  }
  if (best) return best;
  return mmdTouched && mmdTouched.isConnected && mmdViews.has(mmdTouched) ? mmdTouched : null;
}

docEl.addEventListener("click", e => {
  const b = e.target.closest("[data-mmd]");
  if (!b) return;
  const fig = b.closest(".mmd");
  if (!fig) return;
  mmdTouched = fig;
  const what = b.dataset.mmd;
  if (what === "in") mmdZoom(fig, 1.6, null, null);
  else if (what === "out") mmdZoom(fig, 1 / 1.6, null, null);
  else if (what === "full") mmdFull(fig);
  else if (what === "zoom") fig.dataset.zoom === "in" ? mmdFit(fig) : mmdActual(fig);
});

/* Zoom on ⌘/ctrl + scroll, which is the web's own convention and the reason a
 * cursor crossing a diagram never traps the page. A trackpad pinch arrives
 * here as exactly this event, so pinching works without a second path. */
docEl.addEventListener("wheel", e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const fig = e.target.closest('.mmd[data-state="done"]');
  if (!fig || !mmdViews.has(fig)) return;
  e.preventDefault();
  mmdZoom(fig, Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });

/* Drag to pan, but only once there is something to pan to: a fitted diagram
 * holds the whole graph already, and a drag across it is a reader selecting a
 * label, not moving a map. */
docEl.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  const fig = e.target.closest('.mmd[data-state="done"]');
  if (!fig || fig.dataset.zoom !== "in" || !mmdViews.has(fig) || e.target.closest("[data-mmd]")) return;
  const v = mmdViews.get(fig);
  let last = { x: e.clientX, y: e.clientY };
  fig.dataset.grab = "1";
  mmdTouched = fig;
  const move = ev => {
    const s = mmdScale(fig);
    v.view.x -= (ev.clientX - last.x) / s;
    v.view.y -= (ev.clientY - last.y) / s;
    last = { x: ev.clientX, y: ev.clientY };
    mmdClamp(fig);
    mmdApply(fig);
  };
  const up = () => {
    delete fig.dataset.grab;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
  e.preventDefault();
});

docEl.addEventListener("dblclick", e => {
  const fig = e.target.closest('.mmd[data-state="done"]');
  if (!fig || !mmdViews.has(fig)) return;
  e.preventDefault();
  mmdZoom(fig, 2, e.clientX, e.clientY);
});

/* The frame's width decides the fit, so a window that changes size has
 * changed the fit. Re-measured rather than rescaled, which also puts a
 * diagram back where the reader can see all of it. */
let mmdResize = null;
addEventListener("resize", () => {
  clearTimeout(mmdResize);
  mmdResize = setTimeout(() => {
    for (const fig of docEl.querySelectorAll('.mmd[data-state="done"]')) mmdViewport(fig);
  }, 150);
});

/** Mermaid answers a source it cannot parse with its own error graphic, which
 *  replaces the source -- at exactly the moment the reader wants to see what
 *  the agent wrote. Show what it choked on instead. */
function mmdFail(fig, e) {
  fig.dataset.state = "error";
  fig.style.removeProperty("--mmd-reserve");
  const msg = document.createElement("p");
  msg.className = "mmd-err";
  msg.textContent = `This diagram could not be drawn — ${e && e.message ? e.message : e}`;
  const pre = document.createElement("pre");
  pre.className = "mmd-src";
  pre.textContent = fig.dataset.src;
  // Not in a .mmd-note: the note is chrome that find skips, and this source is
  // the one thing on the page a reader would most want to search.
  const box = document.createElement("div");
  box.className = "mmd-fail";
  box.append(msg, pre);
  const frame = fig.querySelector(".mmd-frame");
  frame.textContent = "";
  frame.append(box);
}

docEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-mmd-render]");
  if (!btn) return;
  const fig = btn.closest(".mmd");
  if (!fig) return;
  fig.dataset.state = "queued";
  mmdNote(fig, document.createTextNode("Drawing…"));
  fig.classList.add("mmd-slow");
  mmdQueue.push(fig);
  mmdDrain();
});

/* The two the keyboard reaches, which app.js used to reach into this block to
 * do for itself. They are here so that the page's key handler holds no
 * knowledge of what a diagram is: it forwards a keystroke and this decides
 * whether there was anything to do with it. */

/** Escape, which leaves a filled diagram and means nothing when none is. */
export function escape() {
  const filled = docEl.querySelector(".mmd[data-full]");
  if (filled) mmdUnfill(filled);
}

/** `0` fits the diagram under the cursor, `f` fills the screen with it. Both
 *  are no-ops on a page with no diagram on it. */
export function key(which) {
  const fig = mmdKeyed();
  if (!fig) return;
  (which === "f" ? mmdFull : mmdFit)(fig);
  mmdTouched = fig;
}
