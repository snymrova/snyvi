/* Headless Chromium, driven over the DevTools protocol with the WebSocket and
 * fetch that Node 22 already has. Shared by bench/browser.mjs, which measures
 * the page, and bench/ui.mjs, which reads what it does. No dependencies, for
 * the reason given at the top of browser.mjs: a `npm install` in a project
 * whose whole pitch is one static binary would be a poor trade for a wrapper.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

if (typeof WebSocket !== "function") {
  console.error(`this harness drives Chromium over a WebSocket, and node ${process.version} does not have one.\nNode 22 or newer, or node --experimental-websocket.`);
  process.exit(1);
}

/* Chromium, wherever this machine keeps it. The env var wins, so a runner with
 * an unusual path needs no change here. */
export function chromePath() {
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

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Kill the browser and everything it started. `detached` puts it at the head of
 *  its own group, and the negative pid is what reaches the rest of the group;
 *  the fallback is for a platform or a state where that does not apply. */
export function killTree(proc) {
  live.delete(proc);
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, "SIGKILL"); }
  catch { try { proc.kill("SIGKILL"); } catch {} }
}

/** Every browser this process started and has not killed yet.
 *
 *  A browser is spawned detached, in its own process group, so that a
 *  deliberate teardown reaches the renderers and the zygote rather than only
 *  the leader. Detached also means nothing reaps it when the script itself
 *  dies: a bench interrupted at the keyboard, or one that threw on its way to
 *  its own `finally`, left an eleven-process Chrome behind, holding its
 *  profile under /tmp and about 190 MB, for as long as the machine stayed up.
 *  Two were found three days old, from two different benches.
 *
 *  So the teardown does not belong to the caller alone. Whatever a caller
 *  does or forgets, these take every live browser down with the process. */
const live = new Set();
let hooked = false;
function reapAll() { for (const proc of [...live]) killTree(proc); }
function hook() {
  if (hooked) return;
  hooked = true;
  // `exit` covers the ordinary end, an uncaught throw and an explicit
  // process.exit -- Node runs these listeners for all three.
  process.on("exit", reapAll);
  // A signal does not: it terminates without running them. So reap first,
  // then leave by the code a shell expects of that signal. SIGKILL cannot be
  // caught by anything, and is the one case still left to the OS.
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.on(sig, () => { reapAll(); process.exit(code); });
  }
}

/* ---------- the DevTools protocol, in about forty lines ---------- */

export class CDP {
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
export function pageLoad(cdp, sessionId, what) {
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
export const call = (fn, ...args) => `(${fn})(${args.map(a => JSON.stringify(a)).join(", ")})`;

/** Run an expression in the page and hand back its value, throwing what the page threw. */
export async function evaluate(cdp, session, expression) {
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

/** Start a browser on its own profile and connect to it. Returns the process,
 *  for killTree, and the connection. `args` is for a caller that is not
 *  measuring anything -- the camera in media.mjs -- and is empty for the two
 *  that are. */
export async function launch(profile, { windowSize = "1280,900", args = [] } = {}) {
  const chrome = chromePath();
  // Its own process group, so teardown takes the renderers and the zygote with
  // it. Killing only the leader left chrome, its crashpad handlers and their
  // pipes behind for the runner to reap. Nothing else here is tuned: flags
  // that change how the browser starts change what first paint means.
  const proc = spawn(chrome, [
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
    `--window-size=${windowSize}`,
    ...args,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  // Registered before anything below can throw: every line after this one is
  // a way to leave `launch` without a browser handle, and a browser nobody
  // holds is the one that is still running on Thursday.
  hook();
  live.add(proc);
  proc.once("exit", () => live.delete(proc));
  let err = "";
  proc.stderr.on("data", d => { err += d; });

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
    if (proc.exitCode !== null) throw new Error(`chromium exited: ${err}`);
  }
  if (!devPort) throw new Error(`chromium never reported a debugging port in 60s: ${err}`);

  const version = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
  const cdp = await CDP.open(version.webSocketDebuggerUrl);
  return { proc, cdp };
}

/** A fresh tab with Page and Runtime on, ready to navigate. */
export async function tab(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  return { targetId, sessionId };
}
