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
 * One picture is not free. The desk shows two real Claude Code sessions, so
 * taking it spends a turn from each on the machine taking the pictures, and
 * it needs Claude Code logged in -- the credentials are copied into a config
 * directory under `tmp` and deleted with it, and nothing is written to the
 * real one. Without them the panes run a shell instead and the script says so,
 * so a re-shoot still works on a machine that has no agent on it.
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

/** What the two panes in the desk picture are working on, left then right.
 *  These are real Claude Code sessions in the seeded checkout, not a mock-up:
 *  the picture is two agents doing the plan the library is full of, so change
 *  a line here and the picture changes, and nothing else does.
 *
 *  Two prompts each, and the picture is of the second. `start` launches the
 *  session and is left to answer in full; `then` is typed into the session it
 *  left running and photographed while it is still working. The first turn is
 *  there to fill the pane: Claude Code opens with a banner naming its version,
 *  its model and the plan the account is on, and nothing scrolls that off but
 *  a screenful of work. So the picture is a session already underway, which is
 *  what a desk looks like by the time anyone glances at one.
 *
 *  They run against a copy in a temporary directory that is deleted with
 *  everything else. Without Claude Code logged in the panes run SHELL instead,
 *  so the script still takes a picture on a machine that has no agent on it. */
const PANES = [
  {
    start: 'claude "Read docs/rate-limiting.md and gateway/limit.rs, then say which part of the plan the code already implements"',
    then: "Now add the per-organisation bucket the plan asks for",
  },
  {
    start: 'claude "Read gateway/limit.rs and say what it does today"',
    then: "Now review it against docs/rate-limiting.md and list what the plan asks for that is not there yet",
  },
];
const SHELL = [
  "git --no-pager log --oneline -3",
  "grep -rn RetryAfter gateway/",
];

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
  async press(k, { meta = false, wait = 120 } = {}) {
    const spec = KEYS[k] || { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
    const modifiers = meta ? 4 : 0;
    const down = { type: spec.text && !meta ? "keyDown" : "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers };
    if (down.type === "keyDown") down.text = spec.text;
    await this.cdp.send("Input.dispatchKeyEvent", down, this.s);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers }, this.s);
    await sleep(wait);
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
  /** Wait until `n` panes are running. A pane starts its shell on its first
   *  real size, so this is the page getting there, not the daemon. */
  async panes(n) {
    for (let i = 0; i < 120; i++) {
      if ((await this.ev(`document.querySelectorAll('.pn-body').length`)) >= n
        && (await this.ev(`!document.querySelector('.pn-start:not([hidden])')`))) break;
      await sleep(100);
    }
    await sleep(700);
  }
  /** How long after the prompts go in the panes are photographed.
   *
   *  Mid-turn is the picture. A pane shows the tail of its transcript, so a
   *  session that has answered shows the answer -- a page of prose, which at
   *  the width the README draws this is a grey wall -- where a session still
   *  working shows the tool calls it is making under a spinner, which says
   *  "an agent is at work here" at a glance and in any language.
   *
   *  Late in the turn rather than early, because a pane is about forty lines
   *  tall and Claude Code opens with a banner naming the version, the model
   *  and the plan the account is on. Under a screenful of output that banner
   *  is still there; past one it has scrolled off and what is left is the work.
   *  So the prompts above are the kind that make a dozen tool calls, and this
   *  is long enough for them to pile up and short enough that the turn has not
   *  answered. It is a wait and not a signal because nothing a pane paints
   *  tells a turn in progress from a turn just done.
   *
   *  `SNYVI_MEDIA_WORK_MS` moves it, for re-timing without an edit. */
  async working(ms = Number(process.env.SNYVI_MEDIA_WORK_MS) || 11000) { await sleep(ms); }
  /** How long the opening turn is given to answer before the second is asked.
   *  Long enough for the slower of the two, since what it is buying is a pane
   *  with a screenful in it. `SNYVI_MEDIA_SETTLE_MS` moves it. */
  async settling(ms = Number(process.env.SNYVI_MEDIA_SETTLE_MS) || 55000) { await sleep(ms); }
  /** Type a command into pane `i` and run it. Key by key, because a pane reads
   *  `keydown` and sends the bytes on: inserted text never reaches a PTY.
   *
   *  Briskly, at `wait` ms a character: a hundred-character prompt typed at
   *  reading speed is a quarter of a minute in which the pane already started
   *  is getting on with its turn, and the picture wants both of them at the
   *  same point in one. */
  async shell(i, cmd, wait = 12) {
    await this.ev(`document.querySelectorAll(".pn-body")[${i}].focus()`);
    for (const ch of cmd) await this.press(ch, { wait });
    await this.press("Enter");
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
  // The panes run Claude Code, which needs to be logged in to do anything. It
  // is given a config directory of its own under `tmp`, holding a copy of the
  // credentials and nothing else, so the sessions in the picture touch none of
  // the real one's history and go with the rest of `tmp` at the end. No
  // credentials, no agent: the panes fall back to SHELL and say so.
  const claudeCfg = join(tmp, "claude");
  const creds = join(process.env.HOME ?? "", ".claude", ".credentials.json");
  const agentReady = (() => {
    try {
      mkdirSync(claudeCfg, { recursive: true, mode: 0o700 });
      copyFileSync(creds, join(claudeCfg, ".credentials.json"));
      return true;
    } catch { return false; }
  })();
  // A pane inherits the daemon's environment, and the daemon inherits whoever
  // ran the camera. Run it from inside an agent and that agent's variables
  // reach the sessions in the picture, which then say so across the bottom of
  // the pane. Nothing named for an agent or a model provider is passed on.
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^(CLAUDE|CLAUDECODE|ANTHROPIC|AWS_BEARER_TOKEN|GOOGLE_|VERTEX|BEDROCK)/.test(k)));
  const env = { ...clean, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT, SNYVI_NOTIFY: "0", CLAUDE_CONFIG_DIR: claudeCfg, PATH: `${bin}:${process.env.PATH ?? ""}` };
  const base = `http://127.0.0.1:${PORT}`;
  let chromeProc = null, agent = null, cdp = null;
  try {
    // Two projects, each a real git checkout, so the sidebar shows a branch
    // beside each -- and so a pane opened on one can run `git` and mean it.
    // Identity and config on the command line, and the two config files sent
    // nowhere, so whoever is taking the pictures does not sign these.
    const GIT = ["-c", "user.name=ledger-core", "-c", "user.email=core@ledger.test", "-c", "commit.gpgsign=false"];
    const gitEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const git = (dir, ...a) => execFileSync("git", [...GIT, "-C", dir, ...a], { env: gitEnv, stdio: "ignore" });
    // Under the seeded home, not under `tmp`: a desk shows its root and a
    // dressed prompt says where it is, and `~/code/ledger` is a path a reader
    // recognises where `/tmp/snyvi-media-nDlOLz/ledger` is a tell.
    const repo = (name, branch) => {
      const dir = join(home, "code", name);
      mkdirSync(dir, { recursive: true });
      execFileSync("git", [...GIT, "init", "-q", "-b", branch, dir], { env: gitEnv, stdio: "ignore" });
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

    // A history for a pane to stand in: the work the plan is the plan for.
    writeFileSync(join(ledger, "README.md"), "# ledger\n\nThe public API, and the gateway in front of it.\n");
    for (const [msg, file] of [
      ["Gateway: forward /v1/* to the API", "README.md"],
      ["limit: token buckets per key and per organisation", join("gateway", "limit.rs")],
      ["docs: rate limiting, as accepted", join("docs", "rate-limiting.md")],
    ]) {
      git(ledger, "add", "--", file);
      git(ledger, "commit", "-qm", msg);
    }

    // What Claude Code would otherwise stop and ask on its way into a folder
    // it has never seen: the onboarding, and whether this checkout is trusted.
    // Written into the copy's own config, so neither answer is given on behalf
    // of the real one, and both go when `tmp` does.
    if (agentReady) {
      writeFileSync(join(claudeCfg, ".claude.json"), JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { [ledger]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
      }));
    }

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

    // The desk the pictures show: a folder opened under Folders, and a desk on
    // it. Panes are behind the window's capability -- a browser tab has none,
    // and that is the whole of the rule that keeps processes out of one -- so
    // the camera mints one over the token, the way a window launch does, and
    // hands it to the page on the URL fragment exactly as `snyvi app` would.
    const post = async (path, body) => {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body ?? {}),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const rootId = (await post("/api/browse", { path: ledger })).root.id;
    const cap = (await post("/api/capability")).capability;
    await p.goto(`${base}/?window=1#cap=${cap}`);
    // Made from the page, not from here: the daemon answers this route only for
    // a request that came from a page of its own and carries the capability.
    const deskId = await p.ev(`(async () => {
      const h = { "content-type": "application/json", "x-snyvi-capability": sessionStorage.getItem("snyvi.cap") };
      const made = await fetch("/api/desks", { method: "POST", headers: h, body: ${JSON.stringify(JSON.stringify({ root: rootId, name: "ledger" }))} });
      const desk = (await made.json()).desk;
      // A desk is created empty and the page opens the first pane; the camera
      // asks for one per command so the picture is not at the mercy of that.
      for (let i = 0; i < ${PANES.length}; i++) {
        const r = await fetch("/api/desks/" + desk.id + "/panes", { method: "POST", headers: h, body: "{}" });
        if (!r.ok) throw new Error("pane " + i + ": " + r.status + " " + await r.text());
      }
      return desk.id;
    })()`);

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

    // The desk, once rather than once per theme: two real Claude Code sessions
    // in the checkout the plan is about, in the same window as the documents
    // they are sending into. The sessions are started once and photographed in
    // both themes back to back, so the pair differs in nothing but the theme --
    // and so the picture costs one turn from each agent, not two.
    {
      await p.goto(`${base}/desk/${deskId}`);
      await p.panes(PANES.length);
      if (agentReady) {
        // Both sessions opened together and both asked again together, so the
        // pair is at the same point in the picture: start them one after the
        // other and one pane is a page deep while the other is still reading.
        for (const [i, { start }] of PANES.entries()) await p.shell(i, start);
        await p.settling();
        for (const [i, { then }] of PANES.entries()) await p.shell(i, then);
        await p.working();
      } else {
        console.log("  (no Claude Code credentials; the panes run a shell)");
        for (const [i, cmd] of SHELL.entries()) await p.shell(i, cmd);
      }
      await p.move(1, 1);
      for (const theme of ["light", "dark"]) {
        await p.theme(theme);
        await p.shot(`desk-${theme}`);
      }
    }
  } finally {
    agent?.stdin.end();
    cdp?.close();
    if (!KEEP) {
      killTree(chromeProc);
      try { execFileSync(join(tmp, "bin", "snyvi"), ["stop"], { env, stdio: "ignore" }); } catch {}
      // The panes' shells sit in the folder about to be removed, and they go
      // when the daemon that owns their PTYs does -- but not in the same
      // instant, and a directory a process is still in will not rmdir.
      await sleep(1500);
      rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
