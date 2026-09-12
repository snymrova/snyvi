/* The browser half of the perf budget.
 *
 * `snyvi bench` measures the daemon: how fast Markdown becomes HTML. It has
 * never measured the half the reader actually waits on. docs/DIAGRAMS.md found
 * the delay there -- a 3123 ms frozen frame while Mermaid drew a 220-node
 * flowchart -- with a harness that was thrown away afterwards. This is that
 * harness, kept, so the numbers are checked on every push instead of quoted
 * from a document.
 *
 *   node bench/browser.mjs            report the numbers
 *   node bench/browser.mjs --check    and exit non-zero if one is over budget
 *
 * No dependencies: Chromium is driven over the DevTools protocol with the
 * WebSocket and fetch that Node 22 already has. A `npm install` in a project
 * whose whole pitch is one static binary would be a poor trade for a wrapper.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, DIAGRAMS } from "./fixture.mjs";
import * as page from "./page.mjs";

if (typeof WebSocket !== "function") {
  console.error(`this harness drives Chromium over a WebSocket, and node ${process.version} does not have one.\nNode 22 or newer, or node --experimental-websocket.`);
  process.exit(1);
}

const args = process.argv.slice(2);
/* Two kinds of number are printed here, and only one of them is a fact about
 * snyvi.
 *
 * "longest task, drawing" is about whether the work is cut into slices, not how
 * fast the machine cutting them is. It read 0 ms on a hosted runner and 0 ms on
 * another one three times slower, and 1455 ms the moment the scheduler was
 * taken out. That discriminates, so it is enforced everywhere.
 *
 * First paint and the boot task are mostly a browser and a machine starting up.
 * Two runners eighteen minutes apart reported 444 ms and 1404 ms for the same
 * commit. A budget loose enough to admit 1404 catches nothing; one that is not
 * fails the build for whoever drew the slow runner. So SNYVI_BENCH_SHARED says
 * "this machine's speed is not mine to promise": those rows are measured and
 * printed and not enforced. What CI defends is the behaviour, which does not
 * depend on the clock at all.
 */
const SHARED = !!process.env.SNYVI_BENCH_SHARED;
const CHECK = args.includes("--check");
const KEEP = args.includes("--keep");          // leave the browser and daemon up
const BIN = flag("--bin") || "./target/release/snyvi";
const PORT = flag("--port") || "7796";   // 7791, 7794-7795 and 7812-7814 are CI's
const FACTOR = Number(process.env.SNYVI_BENCH_FACTOR || flag("--factor") || 1);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

/* Chromium, wherever this machine keeps it. The env var wins, so a runner with
 * an unusual path needs no change here. */
function chromePath() {
  const candidates = [
    process.env.SNYVI_CHROME,
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "no Chromium found. Set SNYVI_CHROME to the binary. Tried:\n  " + candidates.join("\n  ")
  );
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Kill the browser and everything it started. `detached` puts it at the head of
 *  its own group, and the negative pid is what reaches the rest of the group;
 *  the fallback is for a platform or a state where that does not apply. */
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, "SIGKILL"); }
  catch { try { proc.kill("SIGKILL"); } catch {} }
}

/* ---------- the DevTools protocol, in about forty lines ---------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", e => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else {
        this.handlers.get(m.method)?.forEach(h => h(m.params, m.sessionId));
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot reach ${url}`)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { this.ws.close(); }
}

/** A page function, as source the page can evaluate. Arguments are passed as
 *  JSON, so anything handed over has to survive a round trip -- which is the
 *  same constraint returning a value already imposes. */
const call = (fn, ...args) => `(${fn})(${args.map(a => JSON.stringify(a)).join(", ")})`;

/** Run an expression in the page and hand back its value, throwing what the page threw. */
async function evaluate(cdp, session, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    session
  );
  if (r.exceptionDetails) {
    throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

/* ---------- what the page records about itself ---------- */



/* ---------- running it ---------- */

async function main() {
  const chrome = chromePath();
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-browser-bench-"));
  const env = {
    ...process.env,
    SNYVI_DATA_DIR: join(tmp, "data"),
    SNYVI_CONFIG_DIR: join(tmp, "config"),
    SNYVI_PORT: PORT,
  };
  let chromeProc = null;
  // Declared out here because report() runs inside the try and exiting from
  // there would skip the cleanup below -- which is exactly what left a browser,
  // two crashpad handlers and a daemon behind for the runner to reap.
  let failed = false;
  try {
    // The document goes in the way a document always goes in, so the budget
    // covers the real path: CLI, daemon, store, renderer, browser.
    const md = join(tmp, "diagram-budget.md");
    writeFileSync(md, fixture());
    const url = execFileSync(BIN, ["send", md], { env, encoding: "utf8" }).trim().split("\n").pop();
    if (!/^https?:\/\//.test(url)) throw new Error(`snyvi send printed no URL:\n${url}`);

    const profile = join(tmp, "chrome");
    // Its own process group, so teardown takes the renderers and the zygote with
    // it. Killing only the leader left chrome, its crashpad handlers and their
    // pipes behind for the runner to reap. Nothing else here is tuned: flags
    // that change how the browser starts change what first paint means.
    chromeProc = spawn(chrome, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // Nothing should reach the network; the page is entirely local. These
      // also stop a first-run profile from spending a second on housekeeping
      // that the first long-task number would then carry.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--window-size=1280,900",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let chromeErr = "";
    chromeProc.stderr.on("data", d => { chromeErr += d; });

    // Sixty seconds, not ten: the first cold start on a hosted runner took longer
    // than ten and failed the build for a reason that had nothing to do with
    // snyvi. Nothing waits this long when the browser is behaving -- the file
    // appears in a second or two and the loop ends there -- so the only cost of
    // the larger number is how long a genuinely broken Chromium takes to say so.
    const portFile = join(profile, "DevToolsActivePort");
    let devPort = null;
    for (let i = 0; i < 1200 && devPort === null; i++) {
      await sleep(50);
      if (existsSync(portFile)) devPort = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (chromeProc.exitCode !== null) throw new Error(`chromium exited: ${chromeErr}`);
    }
    if (!devPort) throw new Error(`chromium never reported a debugging port in 60s: ${chromeErr}`);

    const version = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
    const cdp = await CDP.open(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${page.probe})()` }, sessionId);
    // A dev box and a hosted runner differ by more than the budget factor can
    // absorb. Pin the CPU so the numbers mean the same thing on both, and so a
    // change that is only fast on a fast machine still shows up.
    const throttle = Number(process.env.SNYVI_BENCH_CPU || 1);
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle }, sessionId);

    const loaded = new Promise(res => cdp.on("Page.loadEventFired", (_p, s) => s === sessionId && res()));
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;

    // Let the queue drain. The page is idle long before this on a working
    // scheduler; the wait is sized for the one that is not.
    await evaluate(cdp, sessionId, call(page.settle));

    const perf = await evaluate(cdp, sessionId, "window.__perf");
    const diagrams = await evaluate(cdp, sessionId, call(page.inspect));
    const viewport = await evaluate(cdp, sessionId, "innerHeight");

    const onDemand = await evaluate(cdp, sessionId, call(page.onDemand, "huge-flow"));

    // Two searches, because there are two ways find used to go wrong. "Node 1"
    // is a label in the first flowchart and also a phrase in the prose, so it
    // separates "skips the SVG" from "stopped finding anything". "Diagram" is
    // the word in the document's own title and the word on every placeholder.
    const find = await evaluate(cdp, sessionId, call(page.find, "Node 1"));
    const findChrome = await evaluate(cdp, sessionId, call(page.find, "Diagram"));

    /* Navigating away mid-render, with the window held open rather than raced
     * for. The library request is paused, so every diagram stays queued and the
     * drain stays parked on its await for as long as this takes -- the same
     * state a reader lands in when 3.57 MB of Mermaid is still arriving, but
     * deterministic. Timing this with a sleep would pass whether or not the
     * scheduler cancels anything. */
    let held = null;
    cdp.on("Fetch.requestPaused", (p, sn) => {
      if (sn !== sessionId) return;
      if (/mermaid/.test(p.request.url)) held = p.requestId;
      else cdp.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId);
    });
    // Without this the library comes from the tab's own cache and is never a
    // request at all, so there is nothing to hold and no window to open.
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    for (let i = 0; i < 400 && held === null; i++) await sleep(25);
    if (held === null) throw new Error("the reload never asked for the diagram library");
    const revisit = await evaluate(cdp, sessionId, call(page.leaveAndReturn));
    await cdp.send("Fetch.continueRequest", { requestId: held }, sessionId);
    await cdp.send("Fetch.disable", {}, sessionId);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, sessionId);
    if (revisit.ok) Object.assign(revisit, await evaluate(cdp, sessionId, call(page.drewAfterReturn)));

    failed = report({ perf, diagrams, viewport, onDemand, find, findChrome, revisit, throttle });
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
    console.error("\nbrowser budget: something is over budget or misbehaving");
    process.exitCode = 1;
  }
}

/* ---------- the numbers, and the budgets ---------- */

/** Whether a placeholder ended up where the fixture says it should, and a
 *  sentence saying what happened either way -- the failure message is the whole
 *  value of a budget nobody is watching when it fires. */
function judge(expect, got) {
  switch (expect) {
    case "drawn":
      return [got.hasSvg, got.hasSvg ? "drawn, as it is on screen" : `on screen and never drawn (${got.state})`];
    case "idle":
      return [!got.hasSvg, got.hasSvg ? "drawn while off screen" : "left alone, as it is below the fold"];
    case "held":
      return [!got.hasSvg && got.hasButton,
        got.hasSvg ? "drew a 220-node flowchart nobody asked for"
          : got.hasButton ? "held behind a button, as it is over the cap"
            : `over the cap and offers nothing (${got.state})`];
    case "error":
      return [got.state === "error" && got.keepsSource,
        got.state !== "error" ? `unparseable source did not end in the error state (${got.state})`
          : got.keepsSource ? "failed to parse, and still shows what it choked on"
            : "failed to parse and ate the source"];
    default:
      return [false, `the fixture asks for "${expect}", which the harness does not know`];
  }
}

function report({ perf, diagrams, viewport, onDemand, find, findChrome, revisit, throttle }) {
  const mark = n => perf.marks.find(m => m.name === n)?.start ?? null;
  const fcp = perf.paints.find(p => p.name === "first-contentful-paint")?.start ?? null;
  const libStart = mark("snyvi:mermaid-load");
  const libReady = mark("snyvi:mermaid-ready");

  const longest = list => list.reduce((m, t) => Math.max(m, t.duration), 0);
  // Three windows, because three different things are slow in them and three
  // different phases of docs/DIAGRAMS.md fix them.
  //   boot   -- parsing the HTML and starting app.js. Nothing to do with Mermaid.
  //   lib    -- compiling 3.57 MB of Mermaid. Phase 4 (a trimmed bundle) is what
  //             moves this; the scheduler cannot.
  //   render -- drawing diagrams. This is Phase 1's number, and the only one
  //             here that a regression to `mermaid.run` would blow.
  const boot = perf.longtasks.filter(t => libStart === null || t.start < libStart);
  const lib = perf.longtasks.filter(t => libStart !== null && t.start >= libStart && (libReady === null || t.start < libReady));
  const render = perf.longtasks.filter(t => libReady !== null && t.start >= libReady);

  const byId = Object.fromEntries(diagrams.map(d => [d.id, d]));
  const firstSvg = perf.measures.filter(m => m.name === "snyvi:diagram")
    .reduce((m, e) => Math.min(m, e.start + e.duration), Infinity);

  // `steady` marks a row whose budget is a claim about snyvi rather than about
  // the machine; see SNYVI_BENCH_SHARED at the top of this file.
  const rows = [
    ["first contentful paint", fcp, 250, false, "the reader sees the document"],
    ["longest task, boot", longest(boot), 200, false, "before Mermaid is even fetched"],
    ["longest task, drawing", longest(render), 250, true, "Phase 1: one diagram per task"],
    ["first diagram drawn", Number.isFinite(firstSvg) ? firstSvg : null, 2000, false, "includes the library parse"],
  ];
  const notes = [
    ["longest task, Mermaid parse", longest(lib), "3.57 MB of JS; Phase 4"],
    ["diagram on demand", onDemand.ok ? onDemand.ms : null, "the 220-node one, asked for"],
  ];

  console.log(`browser budget   (budget factor ${FACTOR}${throttle > 1 ? `, CPU x${throttle}` : ""}${SHARED ? ", shared machine" : ""})\n`);
  console.log(`${"".padEnd(34)}${"ms".padStart(9)}${"budget".padStart(10)}`);
  let failed = false;
  for (const [name, value, budget, steady, why] of rows) {
    const b = budget * FACTOR;
    const enforced = steady || !SHARED;
    const ok = value !== null && value <= b;
    if (enforced) failed ||= !ok;
    const shown = value === null ? "—" : value.toFixed(0);
    const verdict = ok ? " ok  " : enforced ? " OVER" : " high";
    const shownBudget = enforced ? b.toFixed(0) : `(${b.toFixed(0)})`;
    console.log(`${name.padEnd(34)}${shown.padStart(9)}${shownBudget.padStart(10)}${verdict} ${why}`);
  }
  for (const [name, value, why] of notes) {
    console.log(`${name.padEnd(34)}${(value === null ? "—" : value.toFixed(0)).padStart(9)}${"".padStart(10)}      ${why}`);
  }
  if (SHARED) {
    console.log("\na budget in brackets is measured and not enforced: this machine's speed is\nnot snyvi's to promise. The behaviour below is enforced everywhere.");
  }

  console.log("\ndiagrams");
  const checks = [];
  for (const want of DIAGRAMS) {
    const got = byId[want.id];
    if (!got) { checks.push([want.id, false, "not found in the page at all"]); continue; }
    checks.push([want.id, ...judge(want.expect, got)]);
  }
  for (const [id, ok, why] of checks) {
    failed ||= !ok;
    console.log(`  ${id.padEnd(20)}${ok ? " ok  " : " FAIL"} ${why}`);
  }
  if (!onDemand.ok) {
    failed = true;
    console.log(`  ${"on demand".padEnd(20)} FAIL ${onDemand.why}`);
  }

  console.log("\nfind");
  const findChecks = [
    [find.labelIsInADiagram, '"Node 1" really is a label in a drawn diagram',
      "the fixture stopped putting that word inside a diagram, so this proves nothing"],
    [find.inSvg === 0, "no match marked inside an SVG",
      `${find.inSvg} matches marked inside an SVG, where each one hides the label it matched`],
    [find.total > 0, `the prose match is still found (${find.counter})`,
      "find stopped finding the prose match as well as the diagram one"],
    [findChrome.inChrome === 0, 'searching "Diagram" marked nothing in a placeholder',
      `${findChrome.inChrome} matches marked in a placeholder label`],
    [findChrome.total > 0, `"Diagram" is still found in the prose (${findChrome.counter})`,
      "find stopped finding the title too"],
  ];
  for (const [ok, yes, no] of findChecks) {
    failed ||= !ok;
    console.log(`  ${ok ? " ok  " : " FAIL"} ${ok ? yes : no}`);
  }
  failed ||= !revisit.ok;
  console.log(`  ${"navigate away".padEnd(20)}${revisit.ok ? " ok  " : " FAIL"} ${revisit.why}`);

  console.log(`\nviewport ${viewport}px; ${diagrams.length} diagrams`);

  return failed;
}

main().catch(e => { console.error(e.message); process.exit(1); });
