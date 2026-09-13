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
import { fixture, families, DIAGRAMS } from "./fixture.mjs";
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

/** A load event, or a failure saying so.
 *
 *  A page that never fires one used to hang this harness rather than fail it:
 *  a render loop in the sidebar held the document open for ever and this wait
 *  had no floor, so a fault that a reader would have felt as a pegged core read
 *  here as a build that never finished. */
function pageLoad(cdp, sessionId, what) {
  return new Promise((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error(`${what}: no load event in 20s -- something is holding the document open, and a render loop will do it`)),
      20_000);
    cdp.on("Page.loadEventFired", (_p, sn) => {
      if (sn !== sessionId) return;
      clearTimeout(timer);
      res();
    });
  });
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

    const loaded = pageLoad(cdp, sessionId, "the document");
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;

    // Let the queue drain. The page is idle long before this on a working
    // scheduler; the wait is sized for the one that is not.
    await evaluate(cdp, sessionId, call(page.settle));

    const perf = await evaluate(cdp, sessionId, "window.__perf");
    const diagrams = await evaluate(cdp, sessionId, call(page.inspect));
    const viewport = await evaluate(cdp, sessionId, "innerHeight");

    const onDemand = await evaluate(cdp, sessionId, call(page.onDemand, "huge-flow"));

    /* The same diagram, now that it is drawn: is it something a reader can
     * actually read? Phase 3. */
    const readable = await evaluate(cdp, sessionId, call(page.readable, "huge-flow"));
    const full = await fullscreen(cdp, sessionId);

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

    /* Phase 2a, in the same tab and with the library already in it: leave the
     * document and come back, and count calls into the renderer rather than
     * milliseconds. Deliberately after the reload above, because a reload is
     * where the cache legitimately starts empty -- what is under test is the
     * client-side navigation a reader actually makes. */
    // Settled first, and not optionally: drewAfterReturn is satisfied by two
    // diagrams, and the unparseable one is still in the queue behind them. A
    // first render counted as a second one is a failure nobody can reproduce.
    if (revisit.ok) await evaluate(cdp, sessionId, call(page.settle));
    const cached = revisit.ok
      ? await evaluate(cdp, sessionId, call(page.revisitUsesCache))
      : { ok: false, why: "skipped: the navigation before it never completed" };

    /* The other half of the roadmap's test: not how long a diagram takes but
     * whether it looks like it belongs in the document around it. A second
     * document, sent the same way, so none of the timing rows above move -- and
     * read in both themes, because the token mapping is shared and the faults it
     * can carry are not. */
    const famMd = join(tmp, "diagram-families.md");
    writeFileSync(famMd, families());
    const famUrl = execFileSync(BIN, ["send", famMd], { env, encoding: "utf8" }).trim().split("\n").pop();
    const famLoaded = pageLoad(cdp, sessionId, "the families document");
    await cdp.send("Page.navigate", { url: famUrl }, sessionId);
    await famLoaded;
    const light = await evaluate(cdp, sessionId, call(page.legible, "light"));
    const toggled = await evaluate(cdp, sessionId, call(page.setTheme, "dark"));
    const dark = toggled.ok ? await evaluate(cdp, sessionId, call(page.legible, "dark")) : [];

    /* The sidebar, on a library that has been used rather than the two
     * documents every number above was taken against. Last, and in a page of
     * its own, because seeding a library is a couple of hundred arrivals and
     * every one of them lands in whatever tab is open. */
    const seeded = await sidebar(cdp, env);

    failed = report({ perf, diagrams, viewport, onDemand, find, findChrome, revisit, cached, legible: [...light, ...dark], toggled, throttle, seeded, readable, full });
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

/** Fullscreen, which is the one gesture the page cannot fake for itself: the
 *  browser grants it to a real click and to nothing else, so the click is sent
 *  through the protocol. */
async function fullscreen(cdp, sessionId) {
  const at = await evaluate(cdp, sessionId, `(() => {
    const fig = [...document.querySelectorAll('.mmd[data-state="done"]')].pop();
    if (!fig) return null;
    fig.scrollIntoView({ behavior: "instant", block: "center" });
    const b = fig.querySelector("[data-mmd=full]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!at) return { ok: false, why: "no diagram offered a fullscreen button" };
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, sessionId);
  }
  await sleep(600);
  const inside = await evaluate(cdp, sessionId, `(() => {
    const el = document.fullscreenElement;
    const frame = el && el.querySelector(".mmd-frame");
    return { is: !!el && el.classList.contains("mmd"),
      height: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
      window: Math.round(innerHeight) };
  })()`);
  await evaluate(cdp, sessionId, `document.fullscreenElement ? document.exitFullscreen() : null`);
  await sleep(600);
  const after = await evaluate(cdp, sessionId, `(() => {
    const fig = [...document.querySelectorAll('.mmd[data-state="done"]')].pop();
    return { out: !document.fullscreenElement,
      height: fig ? Math.round(fig.querySelector(".mmd-frame").getBoundingClientRect().height) : 0,
      window: Math.round(innerHeight) };
  })()`);
  const ok = inside.is && inside.height >= inside.window - 4 && after.out && after.height > 0 && after.height < after.window;
  return {
    ok, ...inside,
    why: !inside.is ? "the button did not put it fullscreen"
      : inside.height < inside.window - 4 ? `fullscreen left it ${inside.height} px tall in a ${inside.window} px screen`
        : !after.out ? "it never came back out"
          : after.height >= after.window ? `it came back ${after.height} px tall, still filling the page`
            : `${inside.height} px of screen, and ${after.height} px back in the document`,
  };
}

/** Fill a library the shape a used one has -- several projects, more sessions
 *  than a project shows, and a session with more documents than it shows -- and
 *  then read the sidebar in a fresh page.
 *
 *  Sends go in through the CLI, which is how documents arrive; `input` rather
 *  than a file per document, so this costs a process and not a write. */
async function sidebar(cdp, env) {
  const projects = Number(process.env.SNYVI_BENCH_PROJECTS || 4);
  const sessions = Number(process.env.SNYVI_BENCH_SESSIONS || 12);   // past the sidebar's cap of 10
  const docs = Number(process.env.SNYVI_BENCH_DOCS || 4);
  const deep = Number(process.env.SNYVI_BENCH_DEEP || 14);           // one session past the cap of 10
  for (let p = 0; p < projects; p++) {
    for (let w = 0; w < sessions; w++) {
      const n = p === 0 && w === 0 ? deep : docs;
      for (let d = 0; d < n; d++) {
        execFileSync(BIN, ["send", "-t", `Plan ${p}.${w}.${d}`, "-w", `session-${p}-${w}`, "--project", `/tmp/snyvi-bench-project-${p}`],
          { env, input: `# Plan ${p}.${w}.${d}\n\nSomething an agent wrote.\n`, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
      }
    }
  }
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  // A first visit: the tab remembers which projects a reader left open, and
  // the 200 arrivals above walked this browser through several of them. What
  // is being measured is what the sidebar puts in the page before anyone has
  // asked for anything.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument",
    { source: "try { localStorage.clear(); } catch (e) {}" }, sessionId);
  const loaded = pageLoad(cdp, sessionId, "the inbox, on a seeded library");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` }, sessionId);
  await loaded;
  const read = await evaluate(cdp, sessionId, call(page.sidebar));
  await cdp.send("Target.closeTarget", { targetId });
  return { ...read, documents: projects * sessions * docs + (deep - docs) };
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

function report({ perf, diagrams, viewport, onDemand, find, findChrome, revisit, cached, legible, toggled, throttle, seeded, readable, full }) {
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
    ["revisit, drawn again", cached.ok ? cached.ms : null, "Phase 2a: from the in-tab cache"],
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
  failed ||= !cached.ok;
  console.log(`  ${"revisit".padEnd(20)}${cached.ok ? " ok  " : " FAIL"} ${cached.why}`);

  /* 3:1 is the WCAG floor for large text, and diagram labels sit around it in
   * size. It is a legibility check rather than a design review: what it is here
   * to catch is a label drawn in the colour of the thing behind it, which lands
   * at 1.0 and which no other check in this file can see. */
  console.log("\nhow they look");
  failed ||= !toggled.ok;
  console.log(`  ${"theme toggle".padEnd(20)}${toggled.ok ? " ok  " : " FAIL"} ${toggled.why}`);
  if (!legible.length) {
    failed = true;
    console.log(`  ${"legibility".padEnd(20)} FAIL no diagram family was read back at all`);
  }
  for (const f of legible) {
    const ok = f.ratio !== null && f.ratio >= 3 && !f.blank;
    failed ||= !ok;
    const ratio = f.ratio === null ? "—" : f.ratio.toFixed(1);
    const why = f.ratio === null ? `no label could be read (${f.checked} checked, state ${f.state})`
      : f.blank ? `${f.blank} labels lay out at zero size`
        : ok ? `${f.checked} labels, worst ${ratio}:1`
          : `"${f.text}" is ${ratio}:1 against what is behind it`;
    console.log(`  ${`${f.id} (${f.theme})`.padEnd(28)}${ok ? " ok  " : " FAIL"} ${why}`);
  }

  /* Phase 3: a diagram of a few hundred nodes is only worth drawing if it can
   * be read, and every one of these is a gesture the reader makes. */
  console.log("\nthe big diagram, read");
  for (const [name, r] of [["viewport", readable], ["fullscreen", full]]) {
    failed ||= !r.ok;
    console.log(`  ${name.padEnd(20)}${r.ok ? " ok  " : " FAIL"} ${r.why}`);
  }

  /* Counts, not clocks: what the sidebar puts in the page is a fact about
   * snyvi at any library size, and it is enforced on every machine. */
  console.log(`\nthe sidebar, on a library of ${seeded.documents} documents`);
  const sideChecks = [
    ["rows, first visit", seeded.closed, 20,
      `${seeded.projects} projects, and a closed one costs the page nothing`],
    ["rows, one project open", seeded.opened, 130,
      `ten sessions of ten, ${seeded.sessions} drawn with ${seeded.offers} offering the rest`],
    ["shell page, KB", Math.round(seeded.shell / 1024), 48,
      "the tree is a row per project, not the library"],
    ["renders after it settled", seeded.mutations, 8,
      "a tree that answers its own render never stops"],
  ];
  for (const [name, value, budget, why] of sideChecks) {
    const ok = value !== null && value <= budget;
    failed ||= !ok;
    console.log(`  ${name.padEnd(26)}${String(value === null ? "—" : value).padStart(6)}${String(budget).padStart(9)}${ok ? " ok  " : " OVER"} ${why}`);
  }
  if (!seeded.filled) {
    failed = true;
    console.log(`  ${"expanding a project".padEnd(26)}${"".padStart(15)} FAIL it drew no documents at all`);
  }

  console.log(`\nviewport ${viewport}px; ${diagrams.length} diagrams`);

  return failed;
}

main().catch(e => { console.error(e.message); process.exit(1); });
