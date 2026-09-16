/* The README's pictures and its film, taken by a script so they are the same
 * page every release and never a screenshot of something that has since moved.
 *
 *   node bench/media.mjs [--out docs/media] [--bin target/release/snyvi] [--keep] [--stills] [--film]
 *
 * A daemon of its own on a port of its own, seeded from bench/seed with the
 * documents an agent would send over an afternoon on one project -- a plan,
 * a review of the PR, the plan again as revised, a summary that arrives while
 * the plan is being read -- and a second project so the sidebar has a shape.
 * Then Chromium, at 1440x900, on each of the views the README shows: the
 * stills at 2x in both themes, and the film at 1x from the page's own
 * screencast, cut to an mp4 by ffmpeg. Nothing here is measured;
 * bench/ui.mjs is the probe. This is the camera.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, killTree, pageLoad, evaluate, sleep, tab } from "./chrome.mjs";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const KEEP = args.includes("--keep");
const STILLS = args.includes("--stills") || !args.includes("--film");
const FILM = args.includes("--film") || !args.includes("--stills");
const OUT = resolve(flag("--out") || "docs/media");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");
const PORT = flag("--port") || "7798";   // 7796 is browser.mjs, 7797 ui.mjs
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "seed");
const W = 1440, H = 900;

const KEYS = {
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  "?": { key: "?", code: "Slash", vk: 191, text: "?", shift: true },
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
    const modifiers = (spec.shift ? 8 : 0) | (meta ? 4 : 0);
    const down = { type: spec.text && !meta ? "keyDown" : "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers };
    if (down.type === "keyDown") down.text = spec.text;
    await this.cdp.send("Input.dispatchKeyEvent", down, this.s);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers }, this.s);
    await sleep(120);
  }
  async type(text) { await this.cdp.send("Input.insertText", { text }, this.s); await sleep(300); }
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
  /** Scroll the document pane by `dy`, the smooth way the page scrolls itself. */
  async scroll(dy) {
    await this.ev(`document.querySelector("#main").scrollBy({ top: ${dy}, behavior: "smooth" })`);
    await sleep(700);
  }
  /** Every frame the page paints from now until stop(), with when it was painted. */
  async record() {
    const frames = [];
    this.cdp.on("Page.screencastFrame", async (f, sn) => {
      if (sn !== this.s) return;
      frames.push({ data: f.data, at: f.metadata.timestamp });
      try { await this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }, this.s); } catch {}
    });
    await this.cdp.send("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 }, this.s);
    return { frames, stop: async () => { await sleep(300); await this.cdp.send("Page.stopScreencast", {}, this.s); return frames; } };
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
  const env = { ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT, PATH: `${bin}:${process.env.PATH ?? ""}` };
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
    // The revision is what arrives in the film, so it is sent there when
    // there is one; the stills alone get it now.
    const plan = FILM ? null : (copyFileSync(join(SEED, "plan-v2.md"), planV1), await send(planV1, { cwd: ledger, workflow }));
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
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.0" } } };
    agent = spawn(BIN, ["mcp"], { env, cwd: ledger, stdio: ["pipe", "ignore", "ignore"] });
    agent.stdin.write(JSON.stringify(init) + "\n");

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
    if (FILM) await film(p, base, ledger, workflow, planV1, send, tmp);

    const latest = (await (await fetch(`${base}/api/inbox?limit=50`)).json()).find(d => d.source_path === planV1);
    const url = `${base}/d/${latest.id}`;
    if (!STILLS) return;
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

/** Twenty-odd seconds: the plan is being read, its revision arrives from the
 *  agent, `n` opens it, `c` shows what changed, the diagram fills the screen,
 *  and ⌘K finds a word across the library. The page's own screencast is the
 *  source: a frame for every paint and the time it was painted, which ffmpeg
 *  turns into a constant-rate film. */
async function film(p, base, ledger, workflow, planV1, send, tmp) {
  const v1 = (await (await fetch(`${base}/api/inbox?limit=50`)).json()).find(d => d.source_path === planV1);
  await p.goto(`${base}/d/${v1.id}`);
  await p.theme("light");
  await p.move(1, 1);
  await p.settled();

  const rec = await p.record();
  await sleep(1500);
  // The reader is a little way in.
  await p.scroll(320);
  await sleep(1200);
  // The agent sends the revision.
  copyFileSync(join(SEED, "plan-v2.md"), planV1);
  await send(planV1, { cwd: ledger, workflow });
  await sleep(2600);
  await p.press("n");
  await sleep(2200);
  await p.press("c");
  await p.settled();
  await sleep(1200);
  await p.scroll(520);
  await sleep(1800);
  await p.click('[data-act="back"]');
  await p.settled();
  await sleep(600);
  await p.ev(`document.querySelector(".mmd").scrollIntoView({ block: "center", behavior: "smooth" })`);
  await sleep(1200);
  await p.settled();
  await sleep(600);
  await p.press("f");
  await sleep(2200);
  await p.press("Escape");
  await sleep(900);
  await p.press("k", { meta: true });
  await sleep(500);
  for (const ch of "retry") { await p.type(ch); await sleep(140); }
  await sleep(1800);
  await p.press("Enter");
  await sleep(2200);
  const frames = await rec.stop();

  // Frames to disk, each held until the next was painted, then cut.
  const dir = join(tmp, "frames");
  mkdirSync(dir);
  const list = [];
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(5, "0")}.png`;
    writeFileSync(join(dir, name), Buffer.from(f.data, "base64"));
    const next = frames[i + 1];
    list.push(`file '${name}'`, `duration ${(next ? Math.max(next.at - f.at, 1 / 60) : 2).toFixed(4)}`);
  });
  list.push(`file 'f${String(frames.length - 1).padStart(5, "0")}.png'`);
  writeFileSync(join(dir, "list.txt"), list.join("\n") + "\n");
  const ff = (...a) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...a], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  ff("-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", join(OUT, "demo.mp4"));
  // No gif: half a minute of a full page does not go under 7 MB with the
  // text still readable, and the mp4 is under 2. The README carries the
  // mp4 the one way GitHub plays one inline, which the release notes say.
  console.log(`  demo.mp4 (${frames.length} frames, ${((frames.at(-1).at - frames[0].at) + 2).toFixed(1)} s)`);
}

main().catch(e => { console.error(e); process.exit(1); });
