/* Opening a document: the gesture a reader makes most, measured.
 *
 * The other three benches each measure a half of it and none measures the
 * whole. `snyvi bench` times the renderer and the daemon, which is over before
 * the browser has anything. `bench/browser.mjs` times a cold page load, which
 * a reader pays once a session. `bench/ui.mjs` reads what the page does and
 * never looks at a clock. What was never measured is the click: a row in the
 * sidebar, and a document on screen -- which is where the 2.3 s frozen frame
 * on a long code file lived, and where the work this bench is here to hold
 * went.
 *
 *   node bench/open.mjs            report the numbers
 *   node bench/open.mjs --check    and exit non-zero if one is over budget
 *
 * ---------- how it measures, and why this way ----------
 *
 * Paint-anchored, count-enforced.
 *
 * The clock comes out of two things the page already has. A MutationObserver
 * on `#doc` fires in the microtask after `innerHTML` is assigned -- the HTML
 * is in place and nothing has been laid out yet. `requestAnimationFrame` plus
 * `setTimeout(0)` is the app's own `afterPaint`: the frame callback runs
 * before the paint and the task it queues runs after it. One gesture gives
 * two numbers, and the second is the one that matters:
 *
 *     click -> swapped     fetching the document and putting it in the page
 *     swapped -> on screen  style, layout and paint -- what chunking changes
 *
 * Nothing is screencast and no frame is captured. A video of the open would
 * be a truer paint timestamp and would cost tens of megabytes of encoded
 * frames per run to learn the same thing; two observers and a frame callback
 * cost nothing, which is why this can run on every push.
 *
 * The clocks are printed and, on a shared machine, not enforced -- for the
 * reason at the top of bench/browser.mjs: two hosted runners reported 444 ms
 * and 1404 ms of first paint for the same commit. What CI defends is the
 * counts, and they do not depend on the machine at all:
 *
 *   layout objects   The DOM of a 6,000-line file is whole; its layout tree
 *                    must not be. That is chunking working, in one number.
 *   JS heap          After a forced collection, across twenty opens. A
 *                    navigation that keeps the document it left is a leak.
 *   sidebar, before   Opening an unread document must not redraw the sidebar
 *                    before the reader sees the page -- and must redraw it
 *                    after, or the row proves nothing.
 *   daemon resident  What the other end holds while all of this happens.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "./fixture.mjs";
import { probe } from "./page.mjs";
import { launch, killTree, pageLoad, evaluate, call, sleep, tab } from "./chrome.mjs";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const KEEP = args.includes("--keep");
const SHARED = !!process.env.SNYVI_BENCH_SHARED;
const BIN = flag("--bin") || "./target/release/snyvi";
const PORT = flag("--port") || "7799";   // 7796 browser.mjs, 7797 ui.mjs, 7798 webkit.py
const FACTOR = Number(process.env.SNYVI_BENCH_FACTOR || flag("--factor") || 1);
/* Twenty, because one open's heap delta is noise: a page that keeps one
 * document it left behind looks the same as a page that kept none. Twenty
 * alternating opens either grow or they do not. */
const OPENS = Number(process.env.SNYVI_BENCH_OPENS || 20);
/* Three tries per fixture, best kept. See bestOpen. */
const TRIES = Number(process.env.SNYVI_BENCH_TRIES || 3);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

/* ---------- the fixtures ----------
 *
 * Three documents, each one a different thing to be slow at.
 *
 * The code file is 6,000 lines of about 33 bytes, which puts it at ~195 KB --
 * deliberately under the renderer's 256 KB highlight cap. Over the cap the
 * daemon serves the tail plain and swaps the highlighted version in when it
 * is ready, and a reading taken while that is in flight measures the race and
 * not the open. The first draft of this file used a longer line, landed at
 * 549 KB without noticing, and measured the wrong thing.
 *
 * 6,000 lines is thirty chunks, which is all this needs to prove. The file
 * that froze the tab for 2.3 s was fifteen thousand, and the counts below say
 * what the shape of the fix does at any length.
 */
const CODE_LINES = Number(process.env.SNYVI_BENCH_LINES || 6000);
const code = () =>
  Array.from({ length: CODE_LINES }, (_, i) =>
    `fn f${i}(x: u32) -> u32 { x + ${i} }\n`).join("");
/* The cap the fixture above is sized against, and a check rather than a
 * comment: two drafts of this file drifted over it without anything saying
 * so, and over it the reading is a race with the background highlighter
 * instead of an open. render::HIGHLIGHT_CAP in src/render.rs. */
const HIGHLIGHT_CAP = 256 * 1024;
const note = () => "# A note\n\nOne short paragraph, which is most of what an agent sends.\n";

/* ---------- what runs inside the page ---------- */

/** One open, timed from the click to the frame that carries the document.
 *
 *  The click is `row.click()` rather than a mouse event at coordinates: the
 *  row may be anywhere in a seeded sidebar, scrolling it into view is layout
 *  this wants to charge to nobody, and the delegated handler that opens a
 *  document sees the same bubbling event either way. bench/ui.mjs is where
 *  real input events earn their cost, because there the handler being reached
 *  is the thing under test.
 */
async function openDoc(id) {
  const doc = document.querySelector("#doc");
  const row = document.querySelector(`a[data-id="${id}"]`);
  if (!row) return { ok: false, why: `no sidebar row for ${id}` };
  if (location.pathname === `/d/${id}`) return { ok: false, why: "that document is already open" };

  // Everything the sidebar does, whenever it does it. `#trees` rather than
  // `#tree`, so the queue counts too: taking a row off the queue is the
  // redraw an open used to pay for before the reader saw anything.
  /* Two different things happen to the sidebar on a click, and only one of
   * them is allowed to happen while the reader is waiting.
   *
   * Rebuilding rows is work: it is the 718 ms task the lazy sidebar took out,
   * and an open must not pay any of it before the document is on screen.
   * Marking the row the reader just clicked is four attribute writes on two
   * elements, and it *should* happen at once -- a click that does not light
   * up until the document lands feels broken. So they are counted apart:
   * childList before the frame is a failure, attributes before the frame are
   * the page answering the click. */
  let rows = 0, marks = 0, after = 0, framed = false;
  const early = [];
  const sidebar = new MutationObserver(rs => {
    for (const r of rs) {
      if (framed) { after++; continue; }
      if (r.type === "attributes") marks++; else rows++;
      if (early.length < 12) {
        const t = r.target;
        early.push(`${r.type === "attributes" ? r.attributeName : r.addedNodes.length ? `+${r.addedNodes.length} rows` : `-${r.removedNodes.length} rows`} on ${(t.nodeName || "?").toLowerCase()}.${(t.className || t.id || "").toString().trim().slice(0, 28)}`);
      }
    }
  });
  sidebar.observe(document.querySelector("#trees"), { childList: true, subtree: true, attributes: true });

  // Frames over 50 ms, with the split the browser knows and a stopwatch does
  // not: how much of one was style and layout. Absent in a browser without
  // the entry type, which is why nothing below requires it to exist.
  const frames = [];
  let loaf = null;
  try {
    loaf = new PerformanceObserver(l => {
      for (const e of l.getEntries()) frames.push({
        start: e.startTime, duration: e.duration,
        blocking: e.blockingDuration || 0,
        layout: e.styleAndLayoutStart ? Math.round(e.renderStart + e.duration - e.styleAndLayoutStart) : null,
      });
    });
    loaf.observe({ type: "long-animation-frame" });
  } catch { loaf = null; }

  /* The instant the document is in the page: a childList record on #doc,
   * delivered as a microtask, before a single box has been laid out.
   *
   * `.prose:not(.sk-body)`, because a click now puts a shell up first -- the
   * title the row knew and bars where the text will be -- and that shell is a
   * `.prose` too. Anchoring on the first one would time the page's answer to
   * the click and call it the document, which is the flattering half of the
   * same gesture. Both are worth knowing, so both are taken: `shell` is what
   * the reader gets at once, `swap` is still the document itself. */
  const shelled = new Promise(res => {
    const mo = new MutationObserver(() => {
      if (doc.querySelector(".prose")) { mo.disconnect(); res(performance.now()); }
    });
    mo.observe(doc, { childList: true });
  });
  const swapped = new Promise(res => {
    const mo = new MutationObserver(() => {
      if (doc.querySelector(".prose:not(.sk-body)")) { mo.disconnect(); res(performance.now()); }
    });
    mo.observe(doc, { childList: true });
  });

  const t0 = performance.now();
  row.click();
  const shell = await shelled;
  const swap = await swapped;
  /* The two anchors, and they are deliberately different.
   *
   * The ordering is read inside the frame callback: the last moment before
   * the browser styles, lays out and paints the frame, and strictly earlier
   * than anything the page queued to run after it. That matters because
   * `afterPaint` in ui/app.js is a timer queued from a frame callback of its
   * own, registered before this one -- so a reading taken from any later task
   * lands behind the very work it is trying to prove was deferred, and says
   * the sidebar was drawn early whether it was or not. The first draft of
   * this file read it from a timer, then from a port message, and both told
   * the same lie.
   *
   * The clock is the port message that callback posts, which runs once the
   * frame is on screen. It carries whatever the page deferred to the same
   * boundary, which is honest: that work is between the reader and the next
   * thing they can do. */
  const painted = await new Promise(res => requestAnimationFrame(() => {
    framed = true;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => res(performance.now());
    ch.port2.postMessage(0);
  }));

  // Let what was deferred land, so "and afterwards" is a real reading and not
  // a race with it.
  await new Promise(r => setTimeout(r, 500));
  sidebar.disconnect();
  if (loaf) loaf.disconnect();

  const pre = document.querySelector("pre.code");
  return {
    ok: location.pathname === `/d/${id}`,
    why: location.pathname === `/d/${id}` ? "opened" : `the click landed on ${location.pathname}`,
    shell: shell - t0,
    fetch: swap - t0,
    paint: painted - swap,
    total: painted - t0,
    rowsBefore: rows,
    marksBefore: marks,
    sidebarAfter: after,
    early,
    loaf: loaf !== null,
    frames: frames.filter(f => f.start >= t0),
    chunks: pre ? pre.getElementsByClassName("lc").length : 0,
    lines: pre ? pre.getElementsByClassName("ln").length : 0,
    scrollHeight: document.querySelector("#main").scrollHeight,
  };
}

/** The same document with the chunks' containment forced off.
 *
 *  This is what makes the layout row a fact rather than a number somebody
 *  chose: it is read against the page it is beating -- same machine, same
 *  tab, same document, a second apart. Nothing puts it back, because the tab
 *  this runs in is closed immediately afterwards. */
function loosen() {
  const s = document.createElement("style");
  s.textContent = "pre.code .lc { content-visibility: visible !important; }";
  document.head.appendChild(s);
  // Force the layout rather than wait for one: nothing on this page scrolls
  // or resizes on its own, so an override nobody reads is an override that
  // never costs anything and never proves anything either.
  return document.querySelector("pre.code").getBoundingClientRect().height > 0;
}

/** Back to the inbox, so the next open is an open and not a no-op. The row
 *  for the document just read is still in the sidebar either way. */
async function goInbox() {
  const home = document.querySelector('[data-nav="inbox"], a.t-inbox');
  if (!home) return false;
  home.click();
  for (let i = 0; i < 100 && location.pathname !== "/"; i++) await new Promise(r => setTimeout(r, 10));
  return location.pathname === "/";
}

/** Twenty opens, alternating, with nothing read back but the clock. What the
 *  caller does with it is the heap either side. Alternating rather than
 *  repeating: the tab keeps the last forty documents it fetched, so opening
 *  one document twenty times measures the cache and not a navigation. */
async function churn(ids, n) {
  let worst = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const id = ids[i % ids.length];
    const doc = document.querySelector("#doc");
    const swapped = new Promise(res => {
      const mo = new MutationObserver(() => {
        if (doc.querySelector(".prose")) { mo.disconnect(); res(performance.now()); }
      });
      mo.observe(doc, { childList: true });
    });
    const t0 = performance.now();
    document.querySelector(`a[data-id="${id}"]`).click();
    await swapped;
    const painted = await new Promise(res => requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => res(performance.now());
      ch.port2.postMessage(0);
    }));
    worst = Math.max(worst, painted - t0);
    total += painted - t0;
  }
  return { worst, mean: total / n, detached: document.querySelectorAll("#doc .prose").length };
}

/* ---------- running it ---------- */

/** One fixture, opened three times, best kept.
 *
 *  A single reading of an open ranged from 740 ms to 1092 ms on the same
 *  commit on this machine -- a spread wide enough that any budget tight
 *  enough to catch a regression would also fail on a quiet afternoon. Each
 *  try reloads the page first, so every one of them is a genuine cold open
 *  with an empty document cache and not the tab's memory of the last try;
 *  best of three is what src/bench.rs does with a send for the same reason.
 *
 *  The page is left on the document after the last try, because the counts
 *  the caller reads next are counts of what holding it costs. */
async function bestOpen(cdp, sessionId, id, tries = TRIES) {
  let best = null;
  for (let i = 0; i < tries; i++) {
    const loaded = pageLoad(cdp, sessionId, "the inbox");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await loaded;
    await sleep(300);          // the shell settles, so the click is not racing boot
    await gc(cdp, sessionId);
    const r = await evaluate(cdp, sessionId, call(openDoc, id));
    if (!r.ok) return r;
    if (!best || r.total < best.total) best = r;
  }
  return best;
}

/** What one open costs to hold, in a tab of its own.
 *
 *  A tab of its own because the clocks above are best of three, and a page
 *  navigated away from does not stop existing: Chromium keeps it in the
 *  back/forward cache, DOM and all, which is the app's own fast Back and is
 *  not something to switch off for a reading. Counted in the same tab, three
 *  tries of a 6,000-line file reported 1,083,916 nodes and a collection did
 *  not touch them, because all three were alive and correctly so. One open in
 *  one fresh tab is the number that means what the row says it means.
 *
 *  The containment comparison happens here too, while the document is up. */
async function holdings(cdp, id) {
  const { targetId, sessionId } = await tab(cdp);
  try {
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId);
    await cdp.send("HeapProfiler.enable", {}, sessionId);
    const loaded = pageLoad(cdp, sessionId, "the inbox, for the counts");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await loaded;
    await sleep(300);
    const open = await evaluate(cdp, sessionId, call(openDoc, id));
    if (!open.ok) throw new Error(`counting: ${open.why}`);
    await gc(cdp, sessionId);
    const after = await metrics(cdp, sessionId);
    // The other end of the same reading: the same page, a second later, with
    // the chunks' containment forced off.
    await evaluate(cdp, sessionId, call(loosen));
    await sleep(1500);
    const loose = (await metrics(cdp, sessionId)).LayoutObjects;
    return { ...open, after, loose };
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-open-bench-"));
  const env = {
    ...process.env,
    SNYVI_DATA_DIR: join(tmp, "data"),
    SNYVI_CONFIG_DIR: join(tmp, "config"),
    SNYVI_PORT: PORT,
  };
  const send = (file, title) =>
    execFileSync(BIN, ["send", "-t", title, file], { env, encoding: "utf8" }).trim().split("\n").pop();
  const idOf = url => {
    const m = /\/d\/([A-Za-z0-9_-]+)/.exec(url || "");
    if (!m) throw new Error(`snyvi send printed no document URL:\n${url}`);
    return m[1];
  };

  let chromeProc = null;
  let failed = false;
  try {
    // A library with something in it, so the sidebar has real work to skip
    // and the numbers are not taken against three rows in an empty page.
    seed(env);

    const files = {
      note: join(tmp, "note.md"),
      plan: join(tmp, "plan.md"),
      code: join(tmp, "handlers.rs"),
    };
    writeFileSync(files.note, note());
    writeFileSync(files.plan, plan());
    writeFileSync(files.code, code());
    const codeBytes = readFileSync(files.code).length;
    if (codeBytes >= HIGHLIGHT_CAP) {
      throw new Error(`the code fixture is ${(codeBytes / 1024).toFixed(0)} KB, over the renderer's ${HIGHLIGHT_CAP / 1024} KB highlight cap: `
        + `the daemon would serve its tail plain and swap the rest in later, and every number below would be a race with that. `
        + `Shorten the line or lower SNYVI_BENCH_LINES.`);
    }
    const sizes = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readFileSync(f).length]));
    // Sent last, so all three are unread rows at the top of the queue.
    const ids = {
      note: idOf(send(files.note, "A note")),
      plan: idOf(send(files.plan, "The plan")),
      code: idOf(send(files.code, "handlers.rs")),
    };

    /* Asked for once each, before a browser exists, and this is not just a
     * warm-up. `snyvi send` returns as soon as the document is stored; the
     * daemon renders and highlights it after that, on a thread of its own.
     * Measuring the first open while 6,000 lines of Rust are still being
     * highlighted behind it measures the contention, which is why an
     * everyday open read 55 ms on one run of this file and 189 ms on the
     * next. `/api/docs/<id>` answers when the document is ready, so asking
     * here is how this waits -- and the answer is the daemon column, taken
     * against a daemon with nothing else to do. */
    const api = {};
    for (const kind of ["note", "plan", "code"]) api[kind] = await apiMs(ids[kind]);

    const browser = await launch(join(tmp, "chrome"));
    chromeProc = browser.proc;
    const cdp = browser.cdp;
    const { sessionId } = await tab(cdp);
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId);
    await cdp.send("HeapProfiler.enable", {}, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${probe})()` }, sessionId);
    const throttle = Number(process.env.SNYVI_BENCH_CPU || 1);
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle }, sessionId);

    const loaded = pageLoad(cdp, sessionId, "the inbox");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
    await loaded;

    // One open each, in the order a reader would meet them, with the page's
    // counts read while the document is still on screen.
    const opens = {};
    for (const kind of ["note", "plan", "code"]) {
      const r = await bestOpen(cdp, sessionId, ids[kind]);
      if (!r.ok) throw new Error(`${kind}: ${r.why}`);
      opens[kind] = { ...r, bytes: sizes[kind], api: api[kind] };
    }

    // What holding the long one costs, counted where nothing else is held.
    const held = await holdings(cdp, ids.code);
    if (!(await evaluate(cdp, sessionId, call(goInbox)))) throw new Error("could not get back to the inbox");

    // The heap, either side of twenty navigations, each one collected first
    // so what is measured is what the page is holding and not what it has
    // not got round to dropping.
    await gc(cdp, sessionId);
    const heapBefore = (await metrics(cdp, sessionId)).JSHeapUsedSize;
    const churned = await evaluate(cdp, sessionId, call(churn, [ids.plan, ids.code, ids.note], OPENS));
    await gc(cdp, sessionId);
    const heapAfter = (await metrics(cdp, sessionId)).JSHeapUsedSize;

    // The cold open, for the one row that is not a click: a link an agent
    // handed over, pasted into a window with nothing in it.
    let cold = { fcp: null, boot: 0 };
    for (let i = 0; i < TRIES; i++) {
      const c = await coldLoad(cdp, sessionId, ids.plan);
      if (c.fcp !== null && (cold.fcp === null || c.fcp < cold.fcp)) cold = c;
    }

    const resident = residentMb(await health());

    failed = report({ opens, held, churned, heap: { before: heapBefore, after: heapAfter }, cold, resident, throttle });
  } finally {
    if (!KEEP) {
      killTree(chromeProc);
      try { execFileSync(BIN, ["stop"], { env, stdio: "ignore" }); } catch {}
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else {
      console.log(`\n--keep: daemon and browser left running; data in ${tmp}`);
    }
  }
  if (failed && CHECK) {
    console.error("\nopen budget: something is over budget or misbehaving");
    process.exitCode = 1;
  }
}

/** A library the shape a used one has. Smaller than the one browser.mjs
 *  seeds, because what is measured here is one click and not the tree: this
 *  is here so the sidebar has rows to redraw, not so it has thousands. */
function seed(env) {
  const projects = Number(process.env.SNYVI_BENCH_PROJECTS || 3);
  const sessions = Number(process.env.SNYVI_BENCH_SESSIONS || 6);
  const docs = Number(process.env.SNYVI_BENCH_DOCS || 4);
  for (let p = 0; p < projects; p++) {
    for (let w = 0; w < sessions; w++) {
      for (let d = 0; d < docs; d++) {
        execFileSync(BIN,
          ["send", "-t", `Plan ${p}.${w}.${d}`, "-w", `session-${p}-${w}`, "--project", `/tmp/snyvi-open-bench-${p}`],
          { env, input: `# Plan ${p}.${w}.${d}\n\nSomething an agent wrote.\n`, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
      }
    }
  }
}

const metrics = async (cdp, sessionId) => {
  const r = await cdp.send("Performance.getMetrics", {}, sessionId);
  return Object.fromEntries(r.metrics.map(m => [m.name, m.value]));
};
const gc = (cdp, sessionId) => cdp.send("HeapProfiler.collectGarbage", {}, sessionId);

/** A page load at `/d/<id>`, and the paint the browser reports for it. The
 *  probe from bench/page.mjs is already installed on every new document, so
 *  this costs a navigation and a read.
 *
 *  Polled rather than read once: the load event and the contentful paint are
 *  not ordered with respect to each other, and reading straight after the
 *  load reported no paint at all on the first run of this file. */
async function coldLoad(cdp, sessionId, id) {
  const loaded = pageLoad(cdp, sessionId, "the document, cold");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/d/${id}` }, sessionId);
  await loaded;
  let perf = null, fcp = null;
  for (let i = 0; i < 60 && fcp === null; i++) {
    perf = await evaluate(cdp, sessionId, "window.__perf || null");
    fcp = perf?.paints.find(p => p.name === "first-contentful-paint")?.start ?? null;
    if (fcp === null) await sleep(50);
  }
  return { fcp, boot: (perf?.longtasks || []).reduce((m, t) => Math.max(m, t.duration), 0) };
}

/** What the daemon takes to answer for a document, measured from here. The
 *  fetch half of an open is the page waiting on this, and when that half
 *  grows this row says whose it is. Best of three, like src/bench.rs: the
 *  first call warms a cache the next reader will have warm too. */
async function apiMs(id) {
  let best = Infinity, bytes = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/docs/${id}`);
    bytes = (await r.arrayBuffer()).byteLength;
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, bytes };
}

const health = async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();

/** What the daemon holds, from the kernel. Linux only by design: this is the
 *  same reading src/bench.rs takes, and on macOS a plain resident count is
 *  not comparable (it says so there). A platform that cannot answer prints a
 *  dash rather than failing a build over it. */
function residentMb({ pid }) {
  try {
    const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return kb ? Number(kb[1]) / 1024 : null;
  } catch { return null; }
}

/* ---------- the numbers, and the budgets ---------- */

function report({ opens, held, churned, heap, cold, resident, throttle }) {
  let failed = false;
  const kb = n => n / 1024;

  console.log(`opening a document   (budget factor ${FACTOR}${throttle > 1 ? `, CPU x${throttle}` : ""}${SHARED ? ", shared machine" : ""})\n`);

  /* ---- the clocks: what the reader waits, in two halves ----
   *
   * `daemon` is the same document asked for from here rather than from the
   * page, so the fetch column has somewhere to point when it grows. */
  console.log(`${"".padEnd(28)}${"daemon".padStart(8)}${"shell".padStart(8)}${"fetch".padStart(8)}${"paint".padStart(8)}${"total".padStart(8)}${"budget".padStart(9)}`);
  const clocks = [
    ["a note, 0.1 KB", opens.note, 100, "the floor: what an open costs before the document does"],
    ["a plan, 54 KB", opens.plan, 150, "the everyday open"],
    [`${CODE_LINES} lines of Rust`, opens.code, 800, "the one chunking is for"],
  ];
  for (const [name, o, budget, why] of clocks) {
    const b = budget * FACTOR;
    const ok = o.ok && o.total <= b;
    if (!SHARED) failed ||= !ok;
    const verdict = ok ? " ok  " : SHARED ? " high" : " OVER";
    console.log(`${name.padEnd(28)}${o.api.ms.toFixed(0).padStart(8)}${o.shell.toFixed(0).padStart(8)}${o.fetch.toFixed(0).padStart(8)}${o.paint.toFixed(0).padStart(8)}${o.total.toFixed(0).padStart(8)}${(SHARED ? `(${b.toFixed(0)})` : b.toFixed(0)).padStart(9)}${verdict} ${why}`);
  }
  const coldB = 250 * FACTOR;
  const coldOk = cold.fcp !== null && cold.fcp <= coldB;
  if (!SHARED) failed ||= !coldOk;
  console.log(`${"cold page load, first paint".padEnd(28)}${"".padStart(32)}${(cold.fcp === null ? "—" : cold.fcp.toFixed(0)).padStart(8)}${(SHARED ? `(${coldB.toFixed(0)})` : coldB.toFixed(0)).padStart(9)}` +
    `${coldOk ? " ok  " : SHARED ? " high" : " OVER"} a link, pasted into an empty window`);
  if (SHARED) {
    console.log("\na budget in brackets is measured and not enforced: this machine's speed is\nnot snyvi's to promise. Everything below is enforced everywhere.");
  }

  /* ---- the counts: memory, footprint, and the ordering ---- */
  const c = held;
  const perLine = c.lines ? c.after.Nodes / c.lines : null;
  console.log("\nwhat it costs to hold");
  console.log(`${"".padEnd(36)}${"is".padStart(8)}${"budget".padStart(9)}`);
  const rows = [
    /* The cause of the fetch column, and a count rather than a clock: the
     * daemon answers for the code file in tens of milliseconds and the page
     * spends the best part of a second receiving and parsing what it said.
     * Per line, so the row holds at any fixture length -- and so a renderer
     * that starts emitting a span per character is caught here rather than
     * in a timing that everyone reads as the machine having a bad day. */
    ["bytes served per line", Math.round(opens.code.api.bytes / CODE_LINES), 700,
      `${(opens.code.api.bytes / 1e6).toFixed(1)} MB of JSON for ${(opens.code.bytes / 1024).toFixed(0)} KB of source`],
    ["layout objects, code file", c.after.LayoutObjects, 30000,
      `${c.chunks} chunks of ${c.lines} lines; ${c.loose ? `${c.loose} of them with containment off` : "containment never measured off"}`],
    ["DOM nodes per line", perLine === null ? null : Math.round(perLine), 70,
      `${c.after.Nodes} nodes for ${c.lines} highlighted lines -- what the page carries whatever it lays out`],
    [`heap growth over ${OPENS} opens, KB`, Math.round(kb(heap.after - heap.before)), 2048,
      "collected either side; a navigation that keeps what it left grows here"],
    ["documents left in the page", churned.detached, 1,
      "one .prose on screen and none kept behind it"],
    ["sidebar rows rebuilt before the paint", opens.plan.rowsBefore, 0,
      opens.plan.rowsBefore ? opens.plan.early.join("; ") : "the reader is waiting for the document, not for the tree"],
    ["daemon resident, MB", resident === null ? null : Math.round(resident), 100,
      "the other end, after everything above"],
  ];
  for (const [name, value, budget, why] of rows) {
    const ok = value !== null && value <= budget;
    failed ||= !ok;
    console.log(`${name.padEnd(36)}${String(value === null ? "—" : value).padStart(8)}${String(Math.round(budget)).padStart(9)}${ok ? " ok  " : " OVER"} ${why}`);
  }

  /* Rows that have to be able to fail the other way round, or they prove
   * nothing: the sidebar must be redrawn, just not before the paint, and the
   * layout number above is only news if the same page without containment is
   * far worse. */
  console.log("\nand afterwards");
  const guards = [
    [opens.plan.sidebarAfter > 0, `the sidebar was rebuilt after the paint (${opens.plan.sidebarAfter} mutations)`,
      "the sidebar was never rebuilt at all, so the row above proves nothing"],
    [opens.plan.marksBefore > 0, `the row the reader clicked was marked at once (${opens.plan.marksBefore} attribute writes, no rows touched)`,
      "the clicked row was not marked until after the paint: a click that does not light up reads as a click that missed"],
    /* The page's own promise, and the one number here that does not depend on
     * how long the document takes: whatever the daemon is doing, a click puts
     * the title and the shape of the text on screen in the same handful of
     * milliseconds. A document that is already in hand goes up whole and has
     * no shell at all, which is why this asks the code file -- the one open
     * that always waits. */
    [opens.code.shell <= 16 * FACTOR, `the click was answered in ${opens.code.shell.toFixed(0)} ms, before the document was fetched`,
      `the click went unanswered for ${opens.code.shell.toFixed(0)} ms: the shell is meant to be up within a frame`],
    [held.chunks > 0, `the code file came cut into ${held.chunks} chunks`,
      "the code file arrived in one piece: chunking is off, and the count above means nothing"],
    [!!c.loose && c.loose > 5 * c.after.LayoutObjects,
      `containment is doing the work: ${c.after.LayoutObjects} layout objects against ${c.loose} with it off`,
      c.loose ? `${c.loose} with containment off against ${c.after.LayoutObjects} with it on -- the chunks are not skipping anything`
        : "the page without containment was never measured, so the layout row is a number nobody can read"],
    [held.lines === CODE_LINES, `all ${CODE_LINES} lines are in the page`,
      `${held.lines} of ${CODE_LINES} lines arrived: cutting the file lost some of it`],
    [held.scrollHeight > 0, `the document has a height (${held.scrollHeight} px) before anything is scrolled`,
      "the page has no height: the chunks reserve nothing and every scroll will jump"],
  ];
  for (const [ok, yes, no] of guards) {
    failed ||= !ok;
    console.log(`  ${ok ? " ok  " : " FAIL"} ${ok ? yes : no}`);
  }

  /* Frames over 50 ms during an open, and where they went. Printed rather
   * than enforced: the entry type is not in every browser, and the budget
   * that catches a regression here is the paint clock above. */
  console.log("\nlong frames during an open");
  for (const [name, o] of [["a note", opens.note], ["a plan", opens.plan], ["code", opens.code]]) {
    if (!o.loaf) { console.log(`  ${name.padEnd(12)} — this browser does not report long animation frames`); continue; }
    const worst = o.frames.reduce((m, f) => (f.duration > (m?.duration ?? 0) ? f : m), null);
    console.log(`  ${name.padEnd(12)}${String(o.frames.length).padStart(3)} over 50 ms` +
      (worst ? `, worst ${worst.duration.toFixed(0)} ms${worst.layout !== null ? ` (${worst.layout} ms of it style and layout)` : ""}` : ""));
  }
  console.log(`\n${OPENS} opens: worst ${churned.worst.toFixed(0)} ms, mean ${churned.mean.toFixed(0)} ms`);

  return failed;
}

main().catch(e => { console.error(e.message); process.exit(1); });
