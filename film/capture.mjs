/* The film's frames: snyvi itself, photographed at 2x on a seeded library,
 * so every pixel in the film is the current release and not a memory of one.
 *
 *   node film/capture.mjs [--bin target/release/snyvi] [--out film/frames]
 *
 * Stills rather than a screen recording on purpose. A headless Chromium
 * paints only when something changes, so a screencast of a document being
 * read comes back at three frames a second; a still comes back at 2880x1800,
 * which the composition pans, punches into and cuts between at the full
 * rate. Each is kept at the width the film magnifies it to and no wider --
 * see `shot` below for why that matters.
 *
 * The daemon, the seed and the two projects are bench/media.mjs's, which
 * takes the README's stills. This is the camera for the film alone, and it
 * also writes what a real send_document call answered, for the terminal.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, killTree, pageLoad, evaluate, sleep, tab } from "../bench/chrome.mjs";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = resolve(flag("--out") || "film/frames");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7799";   // 7796 is browser.mjs, 7797 ui.mjs, 7798 media.mjs
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "..", "bench", "seed");
const W = 1440, H = 900, DPR = 2;

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
    await sleep(150);
  }
  async type(text) { await this.cdp.send("Input.insertText", { text }, this.s); await sleep(250); }
  async move(x, y) { await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s); await sleep(100); }
  async click(sel) {
    const at = await this.ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await this.move(at.x, at.y);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, this.s);
    }
    await sleep(300);
  }
  async theme(name) {
    await this.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: name }] }, this.s);
    await this.settled();
  }
  async settled() {
    for (let i = 0; i < 120; i++) {
      const busy = await this.ev(`!!document.querySelector('.mmd[data-state="queued"], .mmd[data-state="rendering"]') || document.fonts.status !== "loaded"`);
      if (!busy) break;
      await sleep(50);
    }
    await sleep(350);
  }
  async scrollTo(top) {
    await this.ev(`document.querySelector("#main").scrollTo({ top: ${top}, behavior: "instant" })`);
    await sleep(500);
  }
  /** A still of what the window shows now, taken at 2880x1800 and kept at
   *  the width the film magnifies it to. A frame the composition punches
   *  into at 1.5x inside an 1144px window needs about 1800 across; holding
   *  the full 2880 costs three hundred megabytes of decoded bitmap over the
   *  film and six seconds of load, for pixels nothing ever shows. */
  async shot(name, width = 1800) {
    await this.settled();
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, this.s);
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file,
      "-vf", `scale=${width}:-1:flags=lanczos`, "-pix_fmt", "rgb24", `${file}.tmp.png`]);
    execFileSync("mv", [`${file}.tmp.png`, file]);
    const png = readFileSync(file);
    console.log(`  ${name}.png  ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}  ${(png.length / 1024).toFixed(0)} KB`);
  }
}

/** The two faces the film is set in are the two the page renders documents
 *  with, so they are taken from `ui/fonts` rather than kept a second time:
 *  a film set in a copy could drift from the product it is about. */
function fonts() {
  const to = join(HERE, "fonts");
  mkdirSync(to, { recursive: true });
  for (const f of ["source-serif.woff2", "source-serif-italic.woff2", "jetbrains-mono.woff2", "inter.woff2"]) {
    copyFileSync(join(HERE, "..", "ui", "fonts", f), join(to, f));
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  fonts();
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-film-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const BIN = join(bin, "snyvi");
  copyFileSync(BIN_SRC, BIN);
  // SNYVI_NOTIFY=0 because the seed is nine documents arriving: without it
  // the camera throws nine desktop toasts at whoever is running it, and on
  // Linux leaves a `notify-send` waiting behind each one.
  const env = { ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT, SNYVI_NOTIFY: "0", PATH: `${bin}:${process.env.PATH ?? ""}` };
  const base = `http://127.0.0.1:${PORT}`;
  let chromeProc = null, agent = null, cdp = null;
  try {
    const repo = (name, branch) => {
      const dir = join(tmp, name);
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      return dir;
    };
    const ledger = repo("ledger", "rate-limits");
    const website = repo("website", "main");

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

    const workflow = "Rate limiting";
    const planV1 = join(ledger, "docs", "rate-limiting.md");
    mkdirSync(dirname(planV1), { recursive: true });
    await send(join(SEED, "review.md"), { cwd: ledger, workflow });
    await sleep(1100);
    copyFileSync(join(SEED, "plan.md"), planV1);
    await send(planV1, { cwd: ledger, workflow });
    await sleep(1100);
    const limit = join(ledger, "gateway", "limit.rs");
    mkdirSync(dirname(limit), { recursive: true });
    copyFileSync(join(SEED, "limit.rs"), limit);
    const source = await send(limit, { cwd: ledger, workflow: "Gateway refactor", sender: "codex" });

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { snyvi: { command: "snyvi", args: ["mcp"] } } }));
    execFileSync(BIN, ["init", "cursor"], { env, stdio: "ignore" });
    execFileSync(BIN, ["init", "codex"], { env, stdio: "ignore" });
    agent = spawn(BIN, ["mcp"], { env, cwd: ledger, stdio: ["pipe", "pipe", "ignore"] });
    const rpc = mcpClient(agent);
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.0" } });

    const browser = await launch(join(tmp, "chrome"), { windowSize: `${W},${H}`,
      args: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] });
    chromeProc = browser.proc;
    cdp = browser.cdp;
    const { sessionId } = await tab(cdp);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false }, sessionId);
    const p = new Driver(cdp, sessionId);

    // Everything so far has been read, so the only arrival is the one in the film.
    const inbox = await (await fetch(`${base}/api/inbox?limit=50`)).json();
    for (const d of inbox) await p.goto(`${base}/d/${d.id}`);
    const v1 = inbox.find(d => d.source_path === planV1);
    const url = `${base}/d/${v1.id}?window=1`;

    console.log(`frames: ${OUT}`);
    await p.goto(url);
    await p.theme("light");
    await p.move(1, 1);
    for (let i = 0; i < 40 && !(await (await fetch(`${base}/api/health`)).json()).window; i++) await sleep(100);

    // The plan, as it is read. This one is the film's hero window, held
    // nearly full frame, so it keeps more width than the rest.
    await p.shot("plan", 2200);

    // The revision arrives while the plan is open -- the real call, through
    // the MCP server -- and waits at the top.
    copyFileSync(join(SEED, "plan-v2.md"), planV1);
    const res = await rpc("tools/call", { name: "send_document", arguments: { path: planV1, workflow } });
    const reply = res.content?.[0]?.text || JSON.stringify(res);
    writeFileSync(join(OUT, "reply.txt"), reply + "\n");
    console.log(`  reply.txt  ${reply}`);
    await sleep(1200);
    await p.shot("arrival");

    // `n` opens it.
    await p.press("n");
    await sleep(900);
    await p.shot("opened");

    // `c`, what changed against the version before.
    await p.press("c");
    await p.settled();
    await p.shot("diff");
    await p.click('[data-act="back"]');
    await p.settled();

    // The diagram, drawn in the page.
    await p.ev(`document.querySelector(".mmd").scrollIntoView({ block: "center", behavior: "instant" })`);
    await p.shot("diagram");

    // ⌘K, a word, matches from three documents.
    await p.scrollTo(0);
    await p.press("k", { meta: true });
    await sleep(500);
    await p.type("retry");
    await sleep(900);
    await p.shot("search");
    await p.press("Escape");

    // A source file, with the rail reading its outline, and further down it.
    await p.goto(`${base}/d/${source.id}?window=1`);
    await p.theme("light");
    await p.move(1, 1);
    await p.shot("source");
    await p.scrollTo(900);
    await p.shot("source-body");
  } finally {
    agent?.stdin.end();
    cdp?.close();
    killTree(chromeProc);
    try { execFileSync(join(tmp, "bin", "snyvi"), ["stop"], { env, stdio: "ignore" }); } catch {}
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

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
