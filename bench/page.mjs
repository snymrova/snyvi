/* The code that runs inside the page, as functions rather than as strings.
 *
 * Each is stringified and handed to Runtime.evaluate by bench/browser.mjs. It is
 * written this way so `node --check` reads it: a page script kept in a template
 * literal has its backslashes eaten twice on the way in, and the only report is
 * a SyntaxError from a browser naming a line number in a string nobody can see.
 *
 * None of it runs in Node, so it uses browser globals freely. Each function
 * crosses over on its own, as source: nothing it refers to from this module's
 * scope exists on the other side, so every helper is inlined into the function
 * that needs it.
 */

/** Installed before any page script. Everything collected is a standard
 *  performance entry -- the only snyvi-specific part is the names of the marks
 *  app.js emits, which are what let a long task spent compiling Mermaid be told
 *  apart from one spent drawing with it. */
export function probe() {
  window.__perf = { longtasks: [], paints: [], marks: [], measures: [] };
  const watch = (type, keep) =>
    new PerformanceObserver(l => { for (const e of l.getEntries()) keep(e); })
      .observe({ type, buffered: true });
  watch("longtask", e => window.__perf.longtasks.push({ start: e.startTime, duration: e.duration }));
  watch("paint", e => window.__perf.paints.push({ name: e.name, start: e.startTime }));
  watch("mark", e => window.__perf.marks.push({ name: e.name, start: e.startTime }));
  watch("measure", e => window.__perf.measures.push({ name: e.name, start: e.startTime, duration: e.duration }));
}

/** Resolve once nothing is queued or drawing. The page is idle long before the
 *  timeout on a working scheduler; the wait is sized for the one that is not.
 *  `pre.mermaid:not([data-processed])` is in the selector so this also settles
 *  correctly against a client that never adopted the scheduler at all. */
export function settle() {
  return new Promise(resolve => {
    let quiet = 0;
    const busy = () => document.querySelector(
      '.mmd[data-state="rendering"], .mmd[data-state="queued"], pre.mermaid:not([data-processed])');
    const tick = () => {
      quiet = busy() ? 0 : quiet + 1;
      quiet > 8 ? resolve(true) : setTimeout(tick, 100);
    };
    tick();
  });
}

/** The state of every diagram, read off the DOM. A diagram is known by the
 *  `%% id:` comment in its source rather than by document order, so reordering
 *  the fixture cannot silently swap two assertions. */
export function inspect() {
  const out = [];
  for (const el of document.querySelectorAll(".mmd, pre.mermaid")) {
    const src = el.dataset.src || el.textContent || "";
    const id = /%%\s*id:(\S+)/.exec(src);
    const kept = el.querySelector(".mmd-src");
    const box = el.getBoundingClientRect();
    out.push({
      id: id ? id[1] : null,
      state: el.dataset.state || (el.dataset.processed ? "done" : "raw"),
      hasSvg: !!el.querySelector("svg"),
      hasButton: !!el.querySelector("[data-mmd-render]"),
      keepsSource: !!kept && kept.textContent.trim() === src.trim(),
      height: Math.round(box.height),
    });
  }
  return out;
}

/** The escape hatch, exercised: scroll to the held diagram, press its button,
 *  and wait for it to draw. Timed separately -- a diagram the reader asked for
 *  is allowed to cost what it costs. */
export async function onDemand(id) {
  const el = [...document.querySelectorAll(".mmd")]
    .find(e => new RegExp("%%\\s*id:" + id + "\\b").test(e.dataset.src || ""));
  if (!el) return { ok: false, why: `no ${id} placeholder` };
  const btn = el.querySelector("[data-mmd-render]");
  if (!btn) return { ok: false, why: "the held diagram offers no button" };
  el.scrollIntoView();
  const t0 = performance.now();
  btn.click();
  for (let i = 0; i < 600; i++) {
    if (el.querySelector("svg")) return { ok: true, ms: performance.now() - t0 };
    await new Promise(r => setTimeout(r, 50));
  }
  return { ok: false, why: "asked for it and it never drew" };
}

/** Find, against a word that is a label inside a diagram that has been drawn.
 *  `runFind` used to walk the SVG's text nodes and wrap the match in an HTML
 *  <mark>, which lays out at 0x0 inside an <svg>: the label vanished, and the
 *  counter counted matches nobody could be shown. */
export async function find(needle) {
  const drawn = [...document.querySelectorAll('.mmd[data-state="done"] svg')]
    .map(s => s.textContent).join(" ");
  const input = document.querySelector("#find-input");
  input.value = needle;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const marks = [...document.querySelectorAll("#doc mark.find")];
  return {
    labelIsInADiagram: drawn.includes(needle),
    total: marks.length,
    inSvg: marks.filter(m => m.closest("svg")).length,
    inChrome: marks.filter(m => m.closest(".mmd-note")).length,
    counter: (document.querySelector("#find-count").textContent || "").trim(),
  };
}

/** Leave the document while its diagrams are still queued behind the library.
 *
 *  Called with the request for mermaid.js held open, so every diagram is sitting
 *  in "queued" and the drain is parked on an await -- which is where a reader
 *  who opened the wrong document and clicked away actually lands. The return
 *  value is what was left behind: work belonging to the document the reader left
 *  must be dropped, not drawn into detached nodes. */
export async function leaveAndReturn() {
  // Inline, not shared: only the function itself crosses into the page, so a
  // helper from this module's scope would be a ReferenceError over there.
  const until = async (test, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const url = location.pathname;
  if (!await until(() => document.querySelector('.mmd[data-state="queued"]')))
    return { ok: false, why: "no diagram was ever queued, so nothing was interrupted" };
  document.querySelector("[data-nav=inbox]").click();
  await new Promise(r => setTimeout(r, 200));
  const leftBehind = document.querySelectorAll(".mmd").length;
  const link = document.querySelector(`#doc a[href="${url}"], #tree a[href="${url}"]`);
  if (!link) return { ok: false, why: "no link back to the document" };
  link.click();
  await new Promise(r => setTimeout(r, 100));
  return { ok: leftBehind === 0, leftBehind,
    why: leftBehind ? `${leftBehind} diagrams survived the navigation away` : "" };
}

/** And then, once the library has been let through: the document the reader came
 *  back to has to draw. A scheduler that restarts its queue only under the token
 *  it captured strands these forever, and every other check here passes while it
 *  does. */
export async function drewAfterReturn() {
  // Inline, not shared: only the function itself crosses into the page, so a
  // helper from this module's scope would be a ReferenceError over there.
  const until = async (test, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  // Waits for diagrams to appear, not for the absence of pending ones: right
  // after the click there is nothing queued yet either, and "nothing is pending"
  // would be satisfied by a page that never starts.
  const done = () => [...document.querySelectorAll('.mmd[data-state="done"]')].length;
  await until(() => done() >= 2);
  const figures = [...document.querySelectorAll(".mmd")];
  const drawn = done();
  return { ok: drawn >= 2, drawn, total: figures.length,
    why: drawn >= 2 ? `interrupted mid-load, left and returned; ${drawn} of ${figures.length} drawn again`
      : `came back to ${figures.length} diagrams and only ${drawn} drew` };
}

/** The in-tab cache, exercised the way a reader exercises it: leave the document
 *  and come back.
 *
 *  A diagram is a pure function of its source and the theme and a stored
 *  document never changes, so the second visit must not call the renderer at
 *  all. That is counted directly rather than read off the clock, because a
 *  machine fast enough makes a real re-render look like a cache, and the 220-node
 *  flowchart -- the one that makes the difference obvious -- is held behind its
 *  button here and never drawn twice either way. */
export async function revisitUsesCache() {
  // Inline, not shared: only the function itself crosses into the page, so a
  // helper from this module's scope would be a ReferenceError over there.
  const until = async (test, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const done = () => document.querySelectorAll('.mmd[data-state="done"]').length;
  const before = done();
  if (before < 2) return { ok: false, why: `only ${before} diagrams were drawn to begin with` };
  const url = location.pathname;
  const real = window.mermaid.render;
  // Named by the fixture's `%% id:` comment, the same way inspect() names them:
  // "one diagram was drawn again" is not a message anyone can act on.
  const drawnAgain = [];
  window.mermaid.render = function (id, src, ...rest) {
    const m = /%%\s*id:(\S+)/.exec(src || "");
    drawnAgain.push(m ? m[1] : "unlabelled");
    return real.call(this, id, src, ...rest);
  };
  try {
    document.querySelector("[data-nav=inbox]").click();
    await new Promise(r => setTimeout(r, 200));
    const link = document.querySelector(`#doc a[href="${url}"], #tree a[href="${url}"]`);
    if (!link) return { ok: false, why: "no link back to the document" };
    const t0 = performance.now();
    link.click();
    const back = await until(() => done() >= before);
    const ms = performance.now() - t0;
    if (!back) return { ok: false, why: `came back and only ${done()} of ${before} diagrams redrew` };
    /* A cached SVG is kept with a token where the id it was drawn under used to
     * be, and the figure it is painted into supplies a new one -- so an SVG
     * still carrying the id of the figure from the visit before is a cache that
     * has stopped rewriting them. That is the case that puts two of every
     * marker id into a document holding the same diagram twice, and it is
     * invisible on a page that holds each one once. */
    const strayId = [...document.querySelectorAll('.mmd[data-state="done"]')]
      .filter(f => {
        const svg = f.querySelector("svg");
        return !svg || svg.id !== f.dataset.mmdId + "-svg";
      }).length;
    const ok = drawnAgain.length === 0 && strayId === 0;
    return {
      ok, drawnAgain, strayId, ms, drawn: done(),
      why: drawnAgain.length
        ? `drawn again on a revisit: ${drawnAgain.join(", ")}`
        : strayId
          ? `${strayId} restored diagrams carry the id of the figure they were first drawn under`
          : `${done()} diagrams restored without a render call, in ${ms.toFixed(0)} ms`,
    };
  } finally {
    window.mermaid.render = real;
  }
}

/** Whether a drawn diagram behaves like a viewport.
 *
 *  Phase 3 of docs/DIAGRAMS.md, and the fault it answers was measured rather
 *  than imagined: the 220-node flowchart is 4738 px wide and was drawn 30 px
 *  tall, because `max-width: 100%` fitted its width into the reading column and
 *  `height: auto` took the height down with it. The one diagram big enough to
 *  be worth drawing was the one nobody could read.
 *
 *  Every gesture here is dispatched at the frame rather than simulated against
 *  the model: what is under test is the wiring, and a check that calls the
 *  functions directly would pass with nothing listening. Fullscreen is the one
 *  exception -- it needs a gesture the page cannot fake, so it is driven from
 *  the harness. */
export async function readable(id) {
  const fig = [...document.querySelectorAll(".mmd")]
    .find(f => new RegExp("%%\\s*id:" + id + "(\\s|$)").test(f.dataset.src || ""));
  if (!fig) return { ok: false, why: `no diagram called ${id} is in the page` };
  if (fig.dataset.state !== "done") return { ok: false, why: `${id} is ${fig.dataset.state}, not drawn` };
  const frame = fig.querySelector(".mmd-frame"), svg = fig.querySelector("svg");
  if (!svg) return { ok: false, why: `${id} drew no SVG` };
  const box = () => svg.getAttribute("viewBox");
  const width = () => Number((box() || "0 0 0 0").split(/\s+/)[2]);
  // Looked at, before it is used: a key means the diagram the reader has in
  // front of them, so the checks below have to be reading this one.
  fig.scrollIntoView({ behavior: "instant", block: "center" });
  await new Promise(res => setTimeout(res, 150));
  const r = frame.getBoundingClientRect();
  const wheel = ctrl => frame.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -240, ctrlKey: ctrl,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));

  /* Fitted, unless fitting this one would draw it too small to read anything:
   * a graph twenty thousand units wide opens where a label can be read, with
   * "Fit" offering the bird's-eye. Either is a diagram a reader can use; a
   * frame taller than the window is not. */
  const opened = fig.dataset.zoom;
  const offers = (fig.querySelector("[data-mmd=zoom]") || {}).textContent;
  const bounded = r.height <= innerHeight;
  // Back to the whole thing first, so the gestures below start where they can
  // be seen to have done something.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
  await new Promise(res => setTimeout(res, 50));
  const fitted = fig.dataset.zoom === "fit";
  const fit = box();
  wheel(false);
  const plainMoved = box() !== fit;
  wheel(true);
  const zoomedIn = width() < Number(fit.split(/\s+/)[2]);

  // Drag, now that there is something to pan to.
  const before = box();
  frame.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, button: 0, pointerId: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  window.dispatchEvent(new PointerEvent("pointermove", {
    bubbles: true, pointerId: 1, clientX: r.left + r.width / 2 - 120, clientY: r.top + r.height / 2 }));
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  const panned = box() !== before;

  // And back to the whole diagram, from the keyboard.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
  await new Promise(res => setTimeout(res, 50));
  const refits = fig.dataset.zoom === "fit" && box() === fit;

  const opens = opened === "fit" ? offers !== "Fit" : offers === "Fit";
  return {
    ok: bounded && opens && fitted && !plainMoved && zoomedIn && panned && refits,
    opened, offers, bounded, fitted, plainMoved, zoomedIn, panned, refits,
    height: Math.round(r.height), window: Math.round(innerHeight),
    why: !bounded ? `its frame is ${Math.round(r.height)} px in a ${Math.round(innerHeight)} px window`
      : !opens ? `it opened ${opened} and the button offers "${offers}"`
        : !fitted ? "0 did not fit it"
          : plainMoved ? "a plain scroll moved the diagram instead of the page"
            : !zoomedIn ? "ctrl + scroll did not zoom"
              : !panned ? "dragging did not pan"
                : !refits ? "0 did not fit it again"
                  : `opened ${opened === "fit" ? "fitted" : "where a label can be read"} in ${Math.round(r.height)} px of a ${Math.round(innerHeight)} px window, then zoomed, panned and fitted`,
  };
}

/** The sidebar, on a library that has been used.
 *
 *  Every other number in this harness was taken against a two-document
 *  library, which is exactly why an unbounded tree went unnoticed until a
 *  reader with months of sends reported the wait: the shell carried every
 *  document in every project on every page open -- 383 KB and 13,213 rows at
 *  3000 documents -- and the sidebar built all of them before the reader could
 *  do anything.
 *
 *  So what this returns is what the sidebar costs the page rather than how fast
 *  the machine drew it: rows in the DOM with nothing expanded, rows once one
 *  project is, and whether the tree stops rendering once it has drawn. That
 *  last one is a count and not a clock because a tree that renders in response
 *  to its own render looks exactly like a correct one in a screenshot -- it
 *  pegs a core, and the page never finishes loading at all. */
export async function sidebar() {
  // Inline, not shared: only the function itself crosses into the page, so a
  // helper from this module's scope would be a ReferenceError over there.
  const until = async (test, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const tree = document.querySelector("#tree");
  const rows = el => el.querySelectorAll(".t-doc").length;
  const closed = rows(tree);
  const projects = tree.querySelectorAll(".t-proj").length;

  // One project, expanded the way a reader expands it. Found again by its id
  // on every look: a fill rebuilds the sidebar, so the element clicked is not
  // the element the rows arrive in.
  const first = [...tree.querySelectorAll(".t-proj")].find(d => !d.open);
  const pid = first ? first.dataset.pid : null;
  const proj = () => document.querySelector(`#tree .t-proj[data-pid="${pid}"]`);
  let opened = null, sessions = null, offers = null, filled = false;
  if (pid) {
    first.querySelector("summary").click();
    filled = await until(() => proj() && rows(proj()) > 0);
    const p = proj();
    opened = p ? rows(p) : 0;
    sessions = p ? p.querySelectorAll(".t-wf").length : 0;
    offers = p ? p.querySelectorAll("[data-more-docs], [data-more-wf]").length : 0;
  }

  // And then it should stop. Counted over a window with nothing happening in
  // it: a settled tree does nothing at all here.
  let mutations = 0;
  const obs = new MutationObserver(recs => { mutations += recs.length; });
  obs.observe(tree, { childList: true, subtree: true });
  await new Promise(r => setTimeout(r, 700));
  obs.disconnect();

  const nav = performance.getEntriesByType("navigation")[0] || {};
  return {
    closed, projects, opened, sessions, offers, filled, mutations,
    shell: Math.round(nav.transferSize || 0),
    nodes: tree.querySelectorAll("*").length,
  };
}

/** Every label in every diagram, and what it is drawn against.
 *
 *  Section 9 of docs/DIAGRAMS.md asks for a rendered assertion per diagram
 *  family rather than per theme token, because tokens leak across families:
 *  `stateBkg` is right for a state box and also, silently, the colour of the
 *  label on it. That fault put white text on white boxes, correctly positioned
 *  and present in the DOM, and passed every check that existed.
 *
 *  So the colours are read back off real renders. The shape behind a label is
 *  found with elementFromPoint rather than guessed from the DOM shape of each
 *  family -- text is made click-through for the duration, so the point lands on
 *  the fill rather than on the glyph. Alpha is composited, not ignored: half of
 *  snyvi's dark tokens are `rgba(255,255,255,.4)` and up, and a contrast ratio
 *  taken before blending is a number about nothing. */
export async function legible(label) {
  const until = async (test, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const st = document.createElement("style");
  st.textContent = ".mmd svg text, .mmd svg tspan, .mmd svg foreignObject, .mmd svg foreignObject * { pointer-events: none !important; }";
  document.head.appendChild(st);

  const parse = c => {
    const m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return p.length < 3 || p.some(Number.isNaN) ? null : { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (x, y) => {
    const a = lum(x), b = lum(y), hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  };
  const SHAPES = ["rect", "circle", "ellipse", "polygon", "path", "polyline", "line"];
  const page = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };

  const out = [];
  try {
    /* Scrolled to and read one at a time, in that order. The document is short
     * but six diagrams still reach past one screen, and a diagram below the
     * fold is deliberately never drawn -- so bringing them all into view first
     * and reading afterwards reads most of them from off screen, where
     * elementFromPoint answers about nothing. */
    for (const fig of document.querySelectorAll(".mmd")) {
      const m = /%%\s*id:(\S+)/.exec(fig.dataset.src || "");
      // `behavior: "instant"` on purpose: #main sets `scroll-behavior: smooth`,
      // which a plain scrollIntoView inherits, and a measurement taken while the
      // page is still gliding reads every label as off screen. That is what the
      // first version of this check did, and it reported "no label could be
      // read" for whichever families happened to be furthest from the caret.
      fig.scrollIntoView({ block: "center", behavior: "instant" });
      await until(() => fig.dataset.state === "done" || fig.dataset.state === "error");
      await new Promise(r => requestAnimationFrame(r));
      const svg = fig.querySelector("svg");
      if (!svg) {
        out.push({ id: m ? m[1] : "unlabelled", theme: label, checked: 0, blank: 0, ratio: null,
          text: null, state: fig.dataset.state });
        continue;
      }
      const labels = [...svg.querySelectorAll("text, tspan, span, p, div")]
        .filter(el => el.children.length === 0 && (el.textContent || "").trim().length > 0);
      let worst = null, blank = 0, checked = 0;
      for (const el of labels) {
        const box = el.getBoundingClientRect();
        if (!box.width || !box.height) { blank++; continue; }
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        // Off screen after the scroll above, so nothing can be read about it.
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const under = document.elementFromPoint(cx, cy);
        let bg = null;
        if (under && under !== el) {
          const tag = under.tagName.toLowerCase();
          bg = parse(SHAPES.includes(tag) ? getComputedStyle(under).fill : getComputedStyle(under).backgroundColor);
        }
        if (!bg || !bg.a) bg = page; else if (bg.a < 1) bg = over(bg, page);
        const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";
        let fg = parse(isSvg ? getComputedStyle(el).fill : getComputedStyle(el).color);
        if (!fg) continue;
        if (fg.a < 1) fg = over(fg, bg);
        const r = ratio(fg, bg);
        checked++;
        if (!worst || r < worst.ratio) worst = { ratio: r, text: (el.textContent || "").trim().slice(0, 24) };
      }
      out.push({ id: m ? m[1] : "unlabelled", theme: label, checked, blank, state: fig.dataset.state,
        ratio: worst ? worst.ratio : null, text: worst ? worst.text : null });
    }
  } finally {
    st.remove();
  }
  return out;
}

/** Click the theme through until it is the one asked for, and report what the
 *  diagrams on the page look like afterwards. Two things at once on purpose: a
 *  toggle used to leave every drawn diagram in the theme it was drawn in, so
 *  the signature changing is the check for that, and the colours read back
 *  afterwards are the second theme's legibility pass. */
export async function setTheme(want) {
  const until = async (test, tries = 400) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  const signature = () => [...document.querySelectorAll('.mmd[data-state="done"] svg')]
    .map(svg => {
      const shape = svg.querySelector("rect, circle, polygon, path");
      return shape ? getComputedStyle(shape).fill : "-";
    }).join("|");
  const before = signature();
  const btn = document.querySelector("#btn-theme");
  for (let i = 0; i < 4 && document.documentElement.dataset.theme !== want; i++) btn.click();
  if (document.documentElement.dataset.theme !== want) return { ok: false, why: `the theme never became ${want}` };
  const drew = await until(() => signature() !== before && !document.querySelector('.mmd[data-state="queued"], .mmd[data-state="rendering"]'));
  return { ok: drew, before, after: signature(),
    why: drew ? `every drawn diagram was redrawn in ${want}`
      : `switched to ${want} and the diagrams on screen kept the colours they were drawn in` };
}
