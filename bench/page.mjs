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
