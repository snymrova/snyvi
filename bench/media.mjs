/* The README's pictures, taken by a script so they are the same page every
 * release and never a screenshot of something that has since moved.
 *
 *   node bench/media.mjs [--out docs/media] [--bin target/release/snyvi] [--keep]
 *
 * A daemon of its own on a port of its own, seeded from bench/seed with the
 * documents an agent would send over an afternoon on one project -- a plan,
 * a review of the PR, the plan again as revised, a summary that arrives while
 * the plan is being read -- and a second project so the sidebar has a shape.
 * Then Chromium, at 1440x900 and 2x, on each of the views the README shows,
 * in both themes. Nothing here is measured; bench/ui.mjs is the probe. This
 * is the camera.
 *
 * The film is not taken here. It is cut from its own frames by its own
 * camera and its own composition, in film/ -- see film/README.md.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, killTree, pageLoad, evaluate, sleep, tab } from "./chrome.mjs";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const KEEP = args.includes("--keep");
const OUT = resolve(flag("--out") || "docs/media");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7798";   // 7796 is browser.mjs, 7797 ui.mjs
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "seed");
const W = 1440, H = 900;

const KEYS = {
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
};

class Driver {
  constructor(cdp, s) { this.cdp = cdp; this.s = s; }
  ev(expr) { return evaluate(this.cdp, this.s, expr); }
  async goto(url) {
    const loaded = pageLoad(this.cdp, this.s, url);
    await this.cdp.send("Page.navigate", { url }, this.s);
    await loaded;
    await sleep(600);
  }
  async press(k, { meta = false } = {}) {
    const spec = KEYS[k] || { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
    const modifiers = meta ? 4 : 0;
    const down = { type: spec.text && !meta ? "keyDown" : "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers };
    if (down.type === "keyDown") down.text = spec.text;
    await this.cdp.send("Input.dispatchKeyEvent", down, this.s);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers }, this.s);
    await sleep(120);
  }
  async type(text) { await this.cdp.send("Input.insertText", { text }, this.s); await sleep(300); }
  async move(x, y) { await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s); await sleep(100); }
  async theme(name) {
    await this.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: name }] }, this.s);
    // Diagrams redraw in the new theme; wait for the queue to empty.
    for (let i = 0; i < 80; i++) {
      if (!(await this.ev(`!!document.querySelector('.mmd[data-state="queued"], .mmd[data-state="rendering"]')`))) break;
      await sleep(50);
    }
    await sleep(400);
  }
  /** Wait until nothing on the page is still drawing. */
  async settled() {
    for (let i = 0; i < 100; i++) {
      const busy = await this.ev(`!!document.querySelector('.mmd[data-state="queued"], .mmd[data-state="rendering"]') || document.fonts.status !== "loaded"`);
      if (!busy) break;
      await sleep(50);
    }
    await sleep(300);
  }
  async shot(name) {
    await this.settled();
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "webp", quality: 92, captureBeyondViewport: false }, this.s);
    writeFileSync(join(OUT, `${name}.webp`), Buffer.from(data, "base64"));
    console.log(`  ${name}.webp`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-media-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const BIN = join(bin, "snyvi");
  copyFileSync(BIN_SRC, BIN);
  // The copy is first on PATH, so agents register it by name -- `snyvi mcp`
  // -- and no temporary path is in the pictures.
  // SNYVI_NOTIFY=0 so the seeded arrivals do not throw desktop toasts at
  // whoever is taking the pictures.
  const env = { ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT, SNYVI_NOTIFY: "0", PATH: `${bin}:${process.env.PATH ?? ""}` };
  const base = `http://127.0.0.1:${PORT}`;
  let chromeProc = null, agent = null, cdp = null;
  try {
    // Two projects, each a git checkout as far as snyvi can tell, so the
    // sidebar shows a branch beside each.
    const repo = (name, branch) => {
      const dir = join(tmp, name);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      return dir;
    };
    const ledger = repo("ledger", "rate-limits");
    const website = repo("website", "main");

    // The daemon comes up the way it always does, on the first send.
    execFileSync(BIN, ["send", join(SEED, "notes.md"), "-w", "Pricing rewrite"], { env, cwd: website, encoding: "utf8" });
    const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
    const send = async (file, { cwd, workflow, sender = "claude-code" } = {}) => {
      const r = await fetch(`${base}/api/docs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: file, cwd, workflow, sender, origin: "mcp" }),
      });
      if (!r.ok) throw new Error(`send ${file}: ${r.status} ${await r.text()}`);
      return (await r.json()).doc;
    };

    // One session on the ledger project: the review, the plan, then the plan
    // again as the reader revised it. `c` compares with the document before
    // it in the workflow, so the two plans are sent last and adjacent.
    const workflow = "Rate limiting";
    const planV1 = join(ledger, "docs", "rate-limiting.md");
    mkdirSync(dirname(planV1), { recursive: true });
    await send(join(SEED, "review.md"), { cwd: ledger, workflow });
    await sleep(1100);   // received_at is whole seconds; keep the order
    copyFileSync(join(SEED, "plan.md"), planV1);
    await send(planV1, { cwd: ledger, workflow });
    await sleep(1100);
    // The revision, so the pictures have a version to compare against.
    copyFileSync(join(SEED, "plan-v2.md"), planV1);
    await send(planV1, { cwd: ledger, workflow });
    // The file the review is of, sent by a different agent.
    const limit = join(ledger, "gateway", "limit.rs");
    mkdirSync(dirname(limit), { recursive: true });
    copyFileSync(join(SEED, "limit.rs"), limit);
    const source = await send(limit, { cwd: ledger, workflow: "Gateway refactor", sender: "codex" });

    // Three agents registered in this home, one of them here right now: a
    // real `snyvi mcp` under Claude Code's name, held open until the end, so
    // the count beside the mark reads 1 and the connect page says online.
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { snyvi: { command: "snyvi", args: ["mcp"] } } }));
    execFileSync(BIN, ["init", "cursor"], { env, stdio: "ignore" });
    execFileSync(BIN, ["init", "codex"], { env, stdio: "ignore" });
    agent = spawn(BIN, ["mcp"], { env, cwd: ledger, stdio: ["pipe", "pipe", "ignore"] });
    const rpc = mcpClient(agent);
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.0" } });

    // Headless Chromium says it has no pointer that hovers, and everything the
    // page shows on hover is then shown everywhere. A reader's desktop has a
    // mouse; this tells Blink so (hover type 2 is "hover", pointer type 4 is
    // "fine"), which Emulation.setEmulatedMedia cannot.
    const browser = await launch(join(tmp, "chrome"), { windowSize: `${W},${H}`,
      args: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] });
    chromeProc = browser.proc;
    cdp = browser.cdp;
    const { sessionId } = await tab(cdp);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sessionId);
    const p = new Driver(cdp, sessionId);

    // Everything so far has been read, so the only arrival in the pictures
    // is the one that arrives in them.
    const inbox = await (await fetch(`${base}/api/inbox?limit=50`)).json();
    for (const d of inbox) await p.goto(`${base}/d/${d.id}`);

    console.log(`media: ${OUT}`);
    const latest = (await (await fetch(`${base}/api/inbox?limit=50`)).json()).find(d => d.source_path === planV1);
    const url = `${base}/d/${latest.id}`;
    for (const theme of ["light", "dark"]) {
      await p.goto(url);
      await p.theme(theme);
      await p.move(1, 1);

      // The plan, read: sidebar, document, rail.
      await p.shot(`plan-${theme}`);

      // The same plan against the version before it.
      await p.press("c");
      await p.settled();
      await p.shot(`diff-${theme}`);
      await p.press("Escape");
      await p.goto(url);
      await p.theme(theme);

      // Its diagram, drawn in the page.
      await p.ev(`document.querySelector(".mmd").scrollIntoView({ block: "center", behavior: "instant" })`);
      await p.settled();
      await p.shot(`diagram-${theme}`);
      await p.ev(`document.querySelector("#main").scrollTo({ top: 0, behavior: "instant" })`);

      // A document arriving while this one is being read. Read with `n`, then
      // taken out again, so the other theme's pass can have it arrive too:
      // the same bytes from the same path are the same document, not a new one.
      const summary = await send(join(SEED, "summary.md"), { cwd: ledger, workflow });
      await sleep(900);
      await p.shot(`arrival-${theme}`);
      await p.press("n");
      await sleep(600);
      await fetch(`${base}/api/docs/${summary.id}/delete`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      await sleep(600);
      await p.goto(url);
      await p.theme(theme);

      // Search across everything.
      await p.press("k", { meta: true });
      await p.type("retry");
      await sleep(500);
      await p.shot(`search-${theme}`);
      await p.press("Escape");

      // A source file, with the rail reading its outline.
      await p.goto(`${base}/d/${source.id}`);
      await p.theme(theme);
      await p.shot(`source-${theme}`);

      // The page an empty library shows: which agents are connected.
      await p.goto(`${base}/connect`);
      await p.theme(theme);
      await p.shot(`connect-${theme}`);
    }
  } finally {
    agent?.stdin.end();
    cdp?.close();
    if (!KEEP) {
      killTree(chromeProc);
      try { execFileSync(join(tmp, "bin", "snyvi"), ["stop"], { env, stdio: "ignore" }); } catch {}
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } else {
      console.log(`--keep: daemon on ${base}, data in ${tmp}`);
    }
  }
}

/** A JSON-RPC client over the MCP server's stdio, one request at a time:
 *  `rpc(method, params)` resolves with the result. */
function mcpClient(proc) {
  let next = 1, buf = "";
  const waiting = new Map();
  proc.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {}
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, m => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}


main().catch(e => { console.error(e); process.exit(1); });
