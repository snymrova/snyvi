/* What the page does, read rather than trusted.
 *
 * bench/browser.mjs measures how long the page takes. This reads what it
 * does: where the contents' marker is after a read to the end, what a wheel
 * over the rail moves, what Back does after a click on an entry, whether a
 * save keeps the reader's place, what `t` opens on a narrow window, whether
 * Tab reaches every control and a dialog gives focus back, what a drag on a
 * pane's edge does, what `f` fills and what Escape gives back, what an
 * arrival does to a reader in the middle of a page, whether a delete can be
 * taken back, where a link into a browsed folder lands, whether a page gives
 * its connection back when it leaves, whether the daemon knows a window
 * is up, which link an agent is given and where `snyvi app` sends it,
 * whether what moves in the sidebar moves once and briefly, and
 * whether a reset waits for the number and lands on the empty library. Every
 * row here was a fault once -- the 0.11 to
 * 0.15 notes in docs/ROADMAP.md say which -- and the point of running them on
 * every push is that the rail cannot quietly stop following again.
 *
 *   node bench/ui.mjs            report
 *   node bench/ui.mjs --check    and exit non-zero if a row fails
 *   node bench/ui.mjs --only "a desk|folder"   only the sections whose name it matches
 *   node bench/ui.mjs --before "a folder, opened in snyvi"   the sections up to that one
 *   node bench/ui.mjs --from "a folder, opened in snyvi"     that one and the rest
 *
 * Counts and positions only, no clocks, so every row is enforced on every
 * machine. Chromium is driven the way browser.mjs drives it, over the
 * DevTools protocol with nothing installed; the gestures are real input
 * events -- a wheel, a click, a key -- rather than calls into the page,
 * because a handler that is never reached by the real event is the fault
 * being looked for.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, copyFileSync, existsSync, unlinkSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { plan, flowchart } from "./fixture.mjs";
import { launch, killTree, pageLoad, evaluate, sleep, tab } from "./chrome.mjs";

/** The daemon's window secret, read once it is up: what mints a window's
 *  capability answers to it and not to the token (`config::window_secret_path`). */
let windowSecret = "";

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const KEEP = args.includes("--keep");
const BIN_SRC = resolve(flag("--bin") || "./target/release/snyvi");   // absolute: one send runs from the fixture's folder
let BIN = BIN_SRC;   // the copy the daemon runs from, once main() has made it
const PORT = flag("--port") || "7797";   // 7796 is browser.mjs; 7791, 7794-7795 and 7812-7814 are CI's

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

/* ---------- what runs inside the page ---------- */

/** Installed before every document. Small readings the rows below share; each
 *  is a function so `node --check` reads it, as bench/page.mjs explains. */
function prelude() {
  const q = s => document.querySelector(s);
  // What the page counts of itself: app.js adds one to `renders` per draw
  // of the sidebar when this object is there, and nothing when it is not.
  window.__perf = { renders: 0 };
  window.__ui = {
    vis(s) {
      const el = q(s);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length > 0;
    },
    center(s) {
      const el = q(s);
      if (!el) throw new Error(`nothing on the page matches ${s}`);
      el.scrollIntoView({ block: "nearest", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    /** How far a heading's top is from the top of the *reading area*, which is
     *  the bottom of the document's sticky head and not the top of the pane:
     *  `#chrome` sits inside `#main` at `top: 0`, opaque and 52 px tall, so a
     *  heading level with the pane's top is a heading behind it. Every anchor
     *  in app.css clears it by `calc(var(--head-h) + 12px)`, and this is what
     *  that 12 px is measured as. Falls back to the pane where there is no
     *  head to speak of. */
    headingOffset(id) {
      const el = document.getElementById(id);
      const h = el && (el.closest("h1,h2,h3,h4") || el);
      if (!h) return null;
      const head = q("#chrome");
      const from = head && head.getClientRects().length
        ? head.getBoundingClientRect().bottom
        : q("#main").getBoundingClientRect().top;
      return Math.round(h.getBoundingClientRect().top - from);
    },
    /** The contents' current entry, and whether it is inside the rail's box. */
    cur() {
      const rail = q("#rail").getBoundingClientRect();
      const cur = q("#toc a.cur");
      if (!cur) return { text: null, inView: false };
      const r = cur.getBoundingClientRect();
      return { text: cur.textContent.trim().slice(0, 24), inView: r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1 };
    },
    /** The reader's place as a block and an offset into it, the way app.js keeps it. */
    place() {
      const main = q("#main"), edge = main.getBoundingClientRect().top + 1;
      const blocks = [...document.querySelectorAll(".prose > *")];
      const i = blocks.findIndex(b => b.getBoundingClientRect().bottom > edge);
      return { top: main.scrollTop, block: i, delta: i < 0 ? 0 : Math.round(blocks[i].getBoundingClientRect().top - edge) };
    },
    focus() {
      const a = document.activeElement;
      return {
        tag: a.tagName, id: a.id, cls: typeof a.className === "string" ? a.className : "",
        text: (a.textContent || "").trim().slice(0, 24),
        inPalette: !!a.closest(".palette-box"), inHelp: !!a.closest(".help-box"),
        inRail: !!a.closest("#rail"), inSide: !!a.closest("#side"),
      };
    },
    at(s) { const a = document.activeElement; return !!a && a.matches(s); },
    scrollMain(top) { q("#main").scrollTo({ top, behavior: "instant" }); },
    scrollToc(top) { q("#toc").scrollTo({ top, behavior: "instant" }); },
  };
}

/* ---------- running it ---------- */

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "snyvi-ui-bench-"));
  // A home of its own, so the connect page reads agent files the probe
  // wrote and not whatever this machine has.
  const home = join(tmp, "home");
  mkdirSync(home);
  // The daemon runs from a copy in a directory of the probe's own, with no
  // `snyvi-app` beside it and none on its PATH, so whether a window executable
  // is installed is the rows' to decide: the ones about the `snyvi://` link
  // write a stub beside the copy and take it out again, and the daemon looks
  // each time it is asked, so one daemon answers both ways.
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  BIN = join(bin, basename(BIN_SRC));
  copyFileSync(BIN_SRC, BIN);
  const app = process.platform === "win32" ? "snyvi-app.exe" : "snyvi-app";
  const sep = process.platform === "win32" ? ";" : ":";
  // What opens a folder or a link on this machine, stood in for: nothing the
  // probe does may open a real file manager on the desk it runs on. Each
  // writes down what it was handed, for the row that opens a folder.
  const openers = join(tmp, "openers");
  mkdirSync(openers);
  for (const o of ["xdg-open", "open"]) writeFileSync(join(openers, o), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(tmp, "opened")}"\n`, { mode: 0o755 });
  // git, which the desk's repo line asks, may live beside an installed
  // snyvi-app that the PATH below leaves out: kept, by a link of its own.
  if (process.platform !== "win32") {
    const git = (process.env.PATH ?? "").split(sep).map(d => join(d, "git")).find(f => existsSync(f));
    if (git) symlinkSync(git, join(openers, "git"));
  }
  const path = [openers, ...(process.env.PATH ?? "").split(sep).filter(d => d && !existsSync(join(d, app)))].join(sep);
  const env = { ...process.env, HOME: home, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT, PATH: path };
  const stub = join(bin, app);
  const base = `http://127.0.0.1:${PORT}`;
  let chromeProc = null, failed = false;
  try {
    // Two documents: the second so `j` has somewhere to go, sent first so it
    // is the older one, and through the CLI so the daemon comes up the way it
    // always does. The plan itself goes in as a watched file, because one
    // row saves it again and wants the save to land in place.
    const second = join(tmp, "second.md");
    writeFileSync(second, plan("second plan"));
    const secondUrl = execFileSync(BIN, ["send", second], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop();
    if (!/^https?:\/\//.test(secondUrl)) throw new Error(`snyvi send printed no URL:\n${secondUrl}`);
    const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
    windowSecret = readFileSync(join(tmp, "config", "window"), "utf8").trim();
    const md = join(tmp, "plan.md");
    writeFileSync(md, plan());
    const send = async () => {
      const r = await fetch(`${base}/api/docs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: md, cwd: tmp, origin: "watch" }),
      });
      if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const first = await send();
    const url = `${base}/d/${first.doc.id}`;
    // A third, with a diagram in it, for the rows that fill the screen. Small,
    // so it is drawn in a moment; sent last, so it is the newest and `j` from
    // the plan still opens the second.
    const diagram = join(tmp, "diagram.md");
    writeFileSync(diagram, "# A diagram to fill the screen with\n\nA paragraph before it.\n\n```mermaid\n" + flowchart(12, "Label") + "\n```\n\nAnd one after.\n");
    const diagramUrl = execFileSync(BIN, ["send", diagram], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop();
    // A new document, the way an agent's send makes one: its own file, its
    // own content, through the API. What the queue rows send while reading.
    let arrivals = 0;
    // `o` sends a named file (`name`, `body`), again if it was sent before,
    // under a `workflow` of its own.
    const arrive = async (o = {}) => {
      const n = ++arrivals, path = join(tmp, o.name || `arrival-${n}.md`);
      writeFileSync(path, o.body || `# Arrival ${n}\n\nA document that came in while something else was being read.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, cwd: tmp, ...(o.workflow ? { workflow: o.workflow } : {}) }),
      });
      if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
      return (await r.json()).doc;
    };

    // A folder to browse, for the rows that open a file at a section or a
    // line the way a link from outside does.
    const folder = join(tmp, "folder");
    mkdirSync(folder);
    writeFileSync(join(folder, "notes.md"), plan("browsed notes"));
    writeFileSync(join(folder, "code.rs"), Array.from({ length: 400 }, (_, i) => `fn line_${i + 1}() { /* ${i + 1} */ }`).join("\n") + "\n");
    // A folder inside it, and a file that names one inside that, for #91's
    // rows: a folder Ctrl-clicked, and a ▸ row, open on the folder page.
    mkdirSync(join(folder, "sub", "inner"), { recursive: true });
    writeFileSync(join(folder, "sub", "where.md"), "# Where\n\nThe deep one is in inner/ now.\n");
    writeFileSync(join(folder, "sub", "inner", "deep.md"), "# Deep\n");
    const browsed = execFileSync(BIN, ["browse", folder, "--no-open"], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop();
    if (!/\/b\//.test(browsed)) throw new Error(`snyvi browse printed no URL:\n${browsed}`);
    // One send through the MCP server, the way an agent's does it, so the row
    // below can read what the agent is told about where the document went.
    // It opens with `initialize` the way every client does, under a name no
    // agent in the table has, so the connect page has a sender of its own to show.
    const mcpSend = title => {
      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "bench-agent", version: "0" } } };
      const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_document", arguments: { content: `# ${title}\n\nSent the way an agent sends.\n`, title } } };
      const out = execFileSync(BIN, ["mcp"], { env, cwd: tmp, encoding: "utf8", input: JSON.stringify(init) + "\n" + JSON.stringify(call) + "\n" });
      return JSON.parse(out.trim().split("\n").pop()).result.content[0].text;
    };

    const browser = await launch(join(tmp, "chrome"));
    chromeProc = browser.proc;
    const cdp = browser.cdp;
    const { sessionId } = await tab(cdp);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);

    const p = new Driver(cdp, sessionId);
    await p.goto(url);

    const sections = [];
    // `--only <pattern>` runs the sections whose name it matches, for work on one.
    // `--before <name>` and `--from <name>` cut the run in two at a section,
    // which is how CI runs the halves side by side; each half starts on a
    // daemon of its own, so neither may lean on what the other left.
    const only = flag("--only") && new RegExp(flag("--only"));
    const from = flag("--from"), before = flag("--before");
    let inRange = !from;
    const seen = new Set();
    const section = async (name, rows) => {
      seen.add(name);
      if (name === from) inRange = true;
      if (name === before) inRange = false;
      if (!inRange || (only && !only.test(name))) return;
      const t = Date.now();
      const r = await rows();
      sections.push([`${name}  (${((Date.now() - t) / 1000).toFixed(1)} s)`, r]);
    };
    await section("the rail, 1280 px wide", () => railRows(p, url, md, send));
    await section("narrow windows", () => narrowRows(p, url));
    await section("the sidebar, folded to its rail", () => sideRailRows(p, url, arrive));
    await section("by keyboard", () => keyboardRows(p, url));
    await section("the panes' edges", () => widthRows(p, url));
    await section("a diagram, filled", () => diagramRows(p, diagramUrl));
    await section("arrivals, while reading", () => queueRows(p, url, arrive));
    await section("a delete, and the way back", () => deleteRows(p, arrive));
    await section("nothing lost when snyvi says no", () => lossRows(p, base, token, arrive, browsed));
    await section("by keyboard, and back", () => reachRows(p, base, token, arrive));
    await section("the ✕ over what is read", () => backRows(p, browsed));
    await section("back and forward", () => navRows(p));
    await section("an aside, closed", () => asideRows(p, base, token));
    await section("one system: tips, answers, one Undo", () => designRows(p, url, arrive));
    await section("a folder, in the file manager", () => revealRows(p, browsed, folder, tmp));
    await section("a link into a folder", () => browseRows(p, browsed));
    await section("a folder, opened in snyvi", () => folderRows(cdp, base, browsed));
    await section("a link out of a document", () => docLinkRows(p, base, token, first.doc.id));
    await section("the socket a page holds", () => socketRows(p, url, base, browsed));
    await section("a window to hand a link to", () => windowRows(p, url, base, mcpSend));
    await section("a link that opens in the window", () => linkRows(p, url, base, env, tmp, token, stub, mcpSend));
    await section("what moves, and for how long", () => motionRows(p, url, arrive));
    await section("what a save, and a hover, cost", () => costRows(p, url, base, token, tmp, arrive));
    await section("desks that hold still", () => deskRows(cdp, base, token));
    await section("a desk for each project", () => projectDeskRows(cdp, base, token, tmp));
    await section("nothing lost on a desk when snyvi says no", () => deskLossRows(cdp, base, token));
    await section("panels: full view, moved, linked, and their menus", () => panelRows(cdp, base, token));
    await section("Home, and what a Claude in a panel is told", () => homeRows(cdp, base, token, arrive, tmp));
    await section("1.14: desks in your order, a repo link, one paste, a ; that draws", () => orderRepoRows(cdp, base, token, env, tmp));
    await section("answers beside their buttons", () => answerRows(url, tmp));
    await section("every control, in every view", () => controlRows(cdp, p, url, browsed, base, token));
    await section("the first frame, in the reader's theme", () => firstFrameRows(p, url));
    await section("the about box", () => aboutRows(p, url));
    await section("the first ten minutes", () => startRows(p, url, arrive, base));
    await section("connecting an agent", () => connectRows(p, url, home, env));
    await section("an agent that is here", () => presenceRows(p, url, base, env, tmp));
    // Last, because it takes the library with it.
    await section("a reset, and the friction on it", () => resetRows(p, url, arrive));
    // And after it, because it takes the daemon.
    await section("a daemon that stops, and the page that follows", () => stopRows(p, base, tmp, env, second));

    // A cut named wrong would run nothing, or everything, and say ok.
    for (const cut of [from, before]) if (cut && !seen.has(cut)) throw new Error(`no section is named "${cut}"`);
    console.log("ui: what the page does\n");
    for (const [title, rows] of sections) {
      console.log(title);
      for (const [name, ok, why] of rows) {
        failed ||= !ok;
        console.log(`  ${name.padEnd(30)}${ok ? " ok  " : " FAIL"} ${why}`);
      }
      console.log("");
    }
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
    console.error("ui: something the page should do, it does not");
    process.exitCode = 1;
  }
}

/* ---------- the gestures ---------- */

/** Keys the way a keyboard sends them. A key with text goes as keyDown, which
 *  is what makes a keypress; one without goes raw, which is what lets Tab and
 *  Escape do what the browser does with them. */
const KEYS = {
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  "⇧F10": { key: "F10", code: "F10", vk: 121, shift: true },
  "⇧Tab": { key: "Tab", code: "Tab", vk: 9, shift: true },
  "?": { key: "?", code: "Slash", vk: 191, text: "?", shift: true },
  "/": { key: "/", code: "Slash", vk: 191, text: "/" },
  "\\": { key: "\\", code: "Backslash", vk: 220, text: "\\" },
};

class Driver {
  constructor(cdp, sessionId) { this.cdp = cdp; this.s = sessionId; }
  ev(expr) { return evaluate(this.cdp, this.s, expr); }
  ui(method, ...a) { return this.ev(`window.__ui.${method}(${a.map(x => JSON.stringify(x)).join(", ")})`); }
  async goto(url) {
    const loaded = pageLoad(this.cdp, this.s, url);
    await this.cdp.send("Page.navigate", { url }, this.s);
    await loaded;
    await sleep(400);
  }
  async reload() {
    const loaded = pageLoad(this.cdp, this.s, "reload");
    await this.cdp.send("Page.reload", {}, this.s);
    await loaded;
    await sleep(400);
  }
  /** A single letter only acts once ⌃B has woken the keys, so a probe that
   *  presses one wakes them first, the way a reader does -- unless they are
   *  awake already (a second ⌃B would put them back to sleep), or the focus is
   *  somewhere the letter is typed rather than obeyed: a field, where ⌃B does
   *  nothing, or a panel, where it belongs to the program. `raw` skips this,
   *  for the rows about the gate itself. */
  async press(k, { ctrl = false, alt = false, raw = false } = {}) {
    if (!raw && !ctrl && !alt && (k.length === 1 || k === "Delete")) {
      const asleep = await this.ev(`(() => { const t = document.activeElement; return !document.body.classList.contains("keys") && !(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || t.closest(".pn-body"))); })()`);
      if (asleep) await this.press("b", { ctrl: true });
    }
    const spec = KEYS[k] || { key: k, code: `Key${k.toUpperCase()}`, vk: k.toUpperCase().charCodeAt(0), text: k };
    const modifiers = (spec.shift ? 8 : 0) | (ctrl ? 2 : 0) | (alt ? 1 : 0);
    const down = { type: spec.text && !ctrl && !alt ? "keyDown" : "rawKeyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers };
    if (down.type === "keyDown") down.text = spec.text;
    await this.cdp.send("Input.dispatchKeyEvent", down, this.s);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers }, this.s);
    await sleep(80);
  }
  async type(text) { await this.cdp.send("Input.insertText", { text }, this.s); await sleep(250); }
  async wheel(x, y, dy) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }, this.s);
    await sleep(120);
  }
  async click(x, y) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, this.s);
    }
    await sleep(200);
  }
  async clickOn(selector) { const at = await this.ui("center", selector); await this.click(at.x, at.y); }
  /** A right-click, which is what opens a row's menu with the pointer. */
  async rightClickOn(selector) {
    const { x, y } = await this.ui("center", selector);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s);
    for (const type of ["mousePressed", "mouseReleased"]) await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "right", clickCount: 1 }, this.s);
    await sleep(250);
  }
  /** Rest the pointer on something, for what only opens under one. */
  async hoverOn(selector) {
    const at = await this.ui("center", selector);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, this.s);
    await sleep(200);
  }
  async dblclick(x, y) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s);
    for (const clickCount of [1, 2]) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount }, this.s);
      }
    }
    await sleep(200);
  }
  /** Press at (x, y), move `dx` to the side in a few steps, let go. */
  async drag(x, y, dx) {
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.s);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, this.s);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x + dx * i / steps), y, button: "left", buttons: 1 }, this.s);
      await sleep(20);
    }
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", clickCount: 1 }, this.s);
    await sleep(200);
  }
  /** Park the pointer where it hovers nothing that matters. */
  async pointerAway() { await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }, this.s); }
  async width(w, h = 800) {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, this.s);
    await this.settled(w);
  }
  async wide() { await this.cdp.send("Emulation.clearDeviceMetricsOverride", {}, this.s); await this.settled(1280); }
  /** The override reaches layout a frame or two later; wait until the page agrees. */
  async settled(w) {
    for (let i = 0; i < 40; i++) {
      if (await this.ev("innerWidth") === w) break;
      await sleep(50);
    }
    await sleep(300);
  }
}

/* ---------- the rows ---------- */

const within = (v, lo, hi) => v !== null && v >= lo && v <= hi;
/** The daemon saying no, once. The next request the page makes with `method`
 *  to a path matching `path` is answered with `status` and `body` without
 *  reaching the daemon, and `fetch` is the page's own again. A status of 0 is
 *  no answer at all, the way a fetch to a stopped daemon fails. What happens
 *  to the page after a no is what the rows that use this read; `refused(p)`
 *  says whether the no was ever asked for, so a row cannot pass by never
 *  having been refused. A navigation takes it off with everything else. */
const refuse = (p, method, path, status = 500, body = { error: "refused by the bench" }) => p.ev(`(() => {
  const real = window.fetch, re = new RegExp(${JSON.stringify(path.source)});
  window.__refused = false;
  window.fetch = function (u, o) {
    const at = new URL(u instanceof Request ? u.url : u, location.href).pathname;
    if (((o && o.method) || "GET").toUpperCase() !== ${JSON.stringify(method)} || !re.test(at)) return real.apply(this, arguments);
    window.fetch = real;
    window.__refused = true;
    return ${status} ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { "content-type": "application/json" } }))
      : Promise.reject(new TypeError("Failed to fetch"));
  };
  return 1;
})()`);
const refused = p => p.ev("window.__refused === true");
/** Everything a row read, on stderr, for when a row fails and the sentence is not enough. */
const dbg = (name, o) => { if (process.env.SNYVI_UI_DEBUG) console.error(`  [${name}] ${JSON.stringify(o)}`); };

/** 0.11: the rail follows the reader. Each row is a line of the before/after
 *  table in docs/ROADMAP.md. */
async function railRows(p, url, md, send) {
  const rows = [];
  await p.pointerAway();

  const toc = await p.ev(`(() => { const t = document.querySelector("#toc"), r = document.querySelector("#rail").getBoundingClientRect(), a = document.querySelector("#meta .actions").getBoundingClientRect();
    return { entries: t.querySelectorAll("a").length, scrollable: t.scrollHeight - t.clientHeight, height: Math.round(t.clientHeight), actionsBottom: Math.round(a.bottom), railBottom: Math.round(r.bottom), hrefs: [...t.querySelectorAll("a")].map(x => x.getAttribute("href").slice(1)) }; })()`);
  rows.push(["contents scroll on their own", toc.scrollable > 0 && toc.actionsBottom <= toc.railBottom,
    `${toc.entries} entries in ${toc.height} px; actions end at ${toc.actionsBottom} in a rail of ${toc.railBottom}`]);

  await p.ui("scrollMain", 999999);
  await sleep(500);
  const atEnd = await p.ui("cur");
  await p.ev(`window.__ui.scrollMain(document.querySelector("#main").scrollHeight * 0.6)`);
  await sleep(500);
  const atMid = await p.ui("cur");
  rows.push(["marker kept in view", atEnd.inView && atMid.inView,
    `"${atEnd.text}" at the end, "${atMid.text}" at 60%${atEnd.inView && atMid.inView ? ", both in the rail" : ", one of them off it"}`]);

  await p.ui("scrollMain", 0); await p.ui("scrollToc", 0); await sleep(200);
  const railAt = await p.ui("center", "#toc");
  for (let i = 0; i < 7; i++) await p.wheel(railAt.x, railAt.y, 800);
  await sleep(400);
  const afterRail = await p.ev(`[document.querySelector("#toc").scrollTop, document.querySelector("#main").scrollTop]`);
  // The wheel that takes the contents to their end is spent there, as it
  // would be on a pane the browser chained itself; the next one moves the
  // document. So one wheel's worth is the slack.
  const expect = 5600 - toc.scrollable - 800;
  rows.push(["wheel over the rail", afterRail[1] >= expect,
    `5600 px of wheel: contents took ${Math.round(afterRail[0])}, the document moved ${Math.round(afterRail[1])}`]);

  await p.ui("scrollMain", 0); await sleep(200);
  const treesAt = await p.ui("center", "#trees");
  await p.wheel(treesAt.x, treesAt.y, 800);
  await sleep(400);
  const afterSide = await p.ev(`document.querySelector("#main").scrollTop`);
  rows.push(["wheel over the sidebar", afterSide >= 700, `800 px of wheel moved the document ${Math.round(afterSide)}`]);
  await p.pointerAway();

  await p.ui("scrollMain", 0); await p.ui("scrollToc", 0); await sleep(200);
  const histBefore = await p.ev("history.length");
  const entry = 12;
  await p.clickOn(`#toc a[data-i="${entry}"]`);
  await sleep(150);   // inside the heading's 700 ms flash
  const lit = await p.ev(`(() => { const a = document.querySelector('#toc a[data-i="${entry}"]'); const el = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1))); return (el?.closest("h1, h2, h3, h4, h5, h6") || el)?.classList.contains("flash") === true; })()`);
  await sleep(350);
  const landed = await p.ev(`(() => { const a = document.querySelector('#toc a[data-i="${entry}"]'); return { off: window.__ui.headingOffset(a.getAttribute("href").slice(1)), hash: location.hash, hist: history.length }; })()`);
  rows.push(["a click on an entry", within(landed.off, 4, 28) && landed.hist === histBefore && lit,
    `heading ${landed.off} px in${lit ? ", lit for a moment" : ", never lit"}, ${landed.hist - histBefore} history entries added, hash ${landed.hash.slice(0, 14)}…`]);
  await p.pointerAway();

  // Two sections in the history, the way two clicks on the contents leave
  // them, then Back: the reader should move to the first, in the same page.
  const [there, here] = [toc.hrefs[20], toc.hrefs[25]];
  await p.ev(`document.querySelector("#doc article").dataset.sentinel = "kept";
    history.replaceState(history.state, "", location.pathname + "#" + ${JSON.stringify(there)});
    history.pushState(history.state, "", location.pathname + "#" + ${JSON.stringify(here)});
    history.back();`);
  await sleep(800);
  const back = await p.ev(`({ off: window.__ui.headingOffset(location.hash.slice(1)), hash: location.hash.slice(1), kept: document.querySelector("#doc article")?.dataset.sentinel === "kept" })`);
  rows.push(["Back to a section", back.hash === there && within(back.off, 4, 28) && back.kept,
    !back.kept ? "rebuilt the document" : back.hash !== there ? `went to "${back.hash.slice(0, 18)}…"` : `moved to "${back.hash.slice(0, 18)}…", ${back.off} px in, without a rebuild`]);

  await p.ui("scrollMain", 12000); await sleep(700);
  const before = await p.ui("place");
  appendFileSync(md, "\nAnother saved line.\n");
  const saved = await send();
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) { await sleep(100); seen = await p.ev(`document.querySelector("#doc").textContent.includes("Another saved line")`); }
  await sleep(300);
  const after = await p.ui("place");
  rows.push(["a save while reading", saved.existing === true && seen && before.block === after.block && Math.abs(before.delta - after.delta) < 2,
    !saved.existing ? "the save made a new version instead of landing in place"
      : !seen ? "the saved line never reached the page"
        : `block ${before.block} at ${before.delta} px before, block ${after.block} at ${after.delta} px after`]);

  await p.ui("scrollToc", 400); await sleep(100);
  const titleBefore = await p.ev("document.title");
  await p.press("j");
  await sleep(700);
  const afterJ = await p.ev(`({ toc: document.querySelector("#toc").scrollTop, title: document.title })`);
  rows.push(["the contents after j", afterJ.title !== titleBefore && afterJ.toc === 0,
    afterJ.title === titleBefore ? "j opened nothing" : `next document open, contents at ${afterJ.toc}`]);

  // The key mode. The letters sleep until ⌃B, stay awake while they are used,
  // and go back to sleep on Esc, a click, or ten quiet seconds. The page is
  // on the older document here, so `k` has somewhere to go and `j` does not.
  const keyState = () => p.ev(`({ on: document.body.classList.contains("keys"), title: document.title, pill: document.querySelector("#keymode")?.className ?? null, says: document.querySelector("#keymode")?.textContent ?? null })`);
  await p.press("Escape");
  const asleepAt = await keyState();
  await p.press("k", { raw: true }); await sleep(300);
  const asleep = await keyState();
  rows.push(["a letter asleep does nothing, and says why", !asleep.on && asleep.title === asleepAt.title && /show/.test(asleep.pill) && /^(⌃B|Ctrl B) for keys$/.test(asleep.says),
    asleep.title !== asleepAt.title ? "k moved without ⌃B" : `pill "${asleep.says}" (${asleep.pill})`]);
  await p.press("b", { ctrl: true }); await sleep(200);
  const woke = await keyState();
  await p.press("k", { raw: true }); await sleep(500);
  const moved = await keyState();
  await p.press("j", { raw: true }); await sleep(500);
  const movedBack = await keyState();
  rows.push(["⌃B wakes the letters, and they stay awake", woke.on && /on/.test(woke.pill) && woke.says === "Keys on · Esc" && moved.title !== woke.title && movedBack.title === woke.title && movedBack.on,
    !woke.on ? "⌃B did nothing" : moved.title === woke.title ? "k after ⌃B did nothing" : movedBack.title !== woke.title ? "the second letter did not act" : `pill "${woke.says}", k then j, still awake`]);
  await p.press("Escape");
  const escaped = await keyState();
  await p.press("b", { ctrl: true }); await sleep(200);
  await p.clickOn("#doc article p"); await sleep(200);
  const clicked = await keyState();
  rows.push(["Esc and a click put them to sleep", !escaped.on && !/show/.test(escaped.pill) && !clicked.on,
    escaped.on ? "Esc left them awake" : clicked.on ? "a click left them awake" : "asleep after each"]);
  await p.press("b", { ctrl: true });
  await sleep(10_600);
  const quiet = await keyState();
  await p.press("k", { raw: true }); await sleep(400);
  const quietK = await keyState();
  rows.push(["ten quiet seconds put them to sleep", !quiet.on && quietK.title === quiet.title,
    quiet.on ? "still awake after 10.6 s" : quietK.title !== quiet.title ? "asleep, but k still moved" : "asleep, and k did nothing"]);

  await p.press("t");
  const hidden = await p.ui("vis", "#rail");
  await p.reload();
  const stillHidden = await p.ui("vis", "#rail");
  await p.press("t");
  const backAgain = await p.ui("vis", "#rail");
  rows.push(["t after a reload", !hidden && !stillHidden && backAgain,
    hidden ? "t did not hide the rail" : stillHidden ? "the reload forgot it" : !backAgain ? "t did not bring it back" : "hidden, still hidden after the reload, back on the next t"]);

  const deep = toc.hrefs[30];
  await p.goto(`${url}#${deep}`);
  const onLoad = await p.ev(`({ off: window.__ui.headingOffset(${JSON.stringify(deep)}), cur: window.__ui.cur() })`);
  rows.push(["a link to a section, on load", within(onLoad.off, 4, 28) && onLoad.cur.inView,
    `heading ${onLoad.off} px in, marker "${onLoad.cur.text}" ${onLoad.cur.inView ? "in the rail" : "off the rail"}`]);

  const anchorTarget = toc.hrefs[8];
  await p.ev(`document.getElementById(${JSON.stringify(anchorTarget)}).closest("h1,h2,h3,h4").scrollIntoView({ block: "start", behavior: "instant" })`);
  await sleep(300);
  const pre = await p.ev(`({ top: document.querySelector("#main").scrollTop, hist: history.length })`);
  await p.ev(`document.getElementById(${JSON.stringify(anchorTarget)}).click()`);
  await sleep(300);
  // Since 0.15 the mark confirms the copy itself, for a moment, in place of a toast.
  const anchored = await p.ev(`({ hash: location.hash.slice(1), top: document.querySelector("#main").scrollTop, hist: history.length, said: document.getElementById(${JSON.stringify(anchorTarget)}).dataset.said || "" })`);
  rows.push(["the # beside a heading", anchored.hash === anchorTarget && anchored.top === pre.top && anchored.hist === pre.hist && /copied/i.test(anchored.said),
    anchored.hash !== anchorTarget ? "did not write the section into the URL" : anchored.top !== pre.top ? "scrolled" : anchored.hist !== pre.hist ? "added a history entry" : `URL written, the mark reads "${anchored.said}", nothing moved`]);

  return rows;
}

/** 0.12: the chrome at every width. */
async function narrowRows(p, url) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();

  await p.width(1000);
  const gone = await p.ev(`({ rail: window.__ui.vis("#rail"), button: window.__ui.vis("#btn-rail") })`);
  await p.ev(`window.__ui.scrollMain(document.querySelector("#main").scrollHeight * 0.5)`);
  await sleep(500);
  await p.press("t");
  const open = await p.ev(`({ sheet: document.documentElement.dataset.sheet, rail: window.__ui.vis("#rail"), fixed: getComputedStyle(document.querySelector("#rail")).position, width: Math.round(document.querySelector("#rail").getBoundingClientRect().width), cur: window.__ui.cur(), focus: window.__ui.focus(), scrim: window.__ui.vis("#scrim") })`);
  await p.press("Escape");
  const closed = await p.ev(`({ sheet: document.documentElement.dataset.sheet, rail: window.__ui.vis("#rail"), focus: window.__ui.focus() })`);
  dbg("1000 px", { gone, open, closed });
  rows.push(["at 1000 px, t opens the contents", !gone.rail && gone.button && open.sheet === "rail" && open.rail && open.fixed === "fixed" && open.width === 320 && open.cur.inView && open.focus.inRail && open.scrim && !closed.rail && closed.sheet === undefined && !closed.focus.inRail,
    gone.rail ? "the rail is still beside the document" : !gone.button ? "no button offers the contents"
      : !open.rail ? "t opened nothing" : open.fixed !== "fixed" || open.width !== 320 ? `the rail came back as a ${open.fixed} pane ${open.width} px wide`
        : !open.cur.inView ? `the sheet opened with "${open.cur.text}" out of view` : !open.focus.inRail ? "focus stayed outside the sheet" : !open.scrim ? "nothing behind it to tap"
          : closed.rail ? "Escape did not close it" : closed.focus.inRail ? "focus was left in the closed sheet"
            : `a ${open.width} px sheet on "${open.cur.text}", focus inside, Escape closes it`]);

  await p.clickOn("#btn-rail");
  const byButton = await p.ev(`document.documentElement.dataset.sheet`);
  await p.click(200, 400);
  const byScrim = await p.ev(`document.documentElement.dataset.sheet`);
  await p.pointerAway();
  rows.push(["the button and the scrim", byButton === "rail" && byScrim === undefined,
    byButton !== "rail" ? "the button opened nothing" : byScrim ? "a tap outside did not close it" : "the button opens it, a tap outside closes it"]);

  await p.ui("scrollMain", 0); await sleep(300);
  await p.clickOn("#btn-rail");
  await p.clickOn('#toc a[data-i="6"]');
  await sleep(400);
  const viaEntry = await p.ev(`({ sheet: document.documentElement.dataset.sheet, off: window.__ui.headingOffset(document.querySelector('#toc a[data-i="6"]').getAttribute("href").slice(1)) })`);
  await p.pointerAway();
  rows.push(["an entry in the sheet", viaEntry.sheet === undefined && within(viaEntry.off, 4, 28),
    viaEntry.sheet ? "the sheet stayed open over the section it went to" : `jumps to the section (${viaEntry.off} px in) and closes`]);

  // 1.7.1: under 760 px the sidebar is its rail, and a section opens in a
  // popover beside it, full height, over a scrim. The sheet it was is gone.
  await p.width(700);
  const narrow = await p.ev(`({ side: window.__ui.vis("#side"), width: Math.round(document.querySelector("#side").getBoundingClientRect().width), icons: window.__ui.vis("#rail-nav"), fold: window.__ui.vis("#btn-side-hide") })`);
  await p.press("\\");
  const still = await p.ev(`({ side: document.documentElement.dataset.side, pop: document.documentElement.dataset.pop })`);
  await p.clickOn('#rail-nav [data-pop="tree"]');
  const popped = await p.ev(`(() => { const r = document.querySelector("#pop").getBoundingClientRect();
    return { pop: document.documentElement.dataset.pop, tree: !!document.querySelector("#pop > #tree"), top: Math.round(r.top), h: Math.round(r.height), full: Math.round(r.height) >= innerHeight - 1, scrim: window.__ui.vis("#scrim"), focus: window.__ui.focus() }; })()`);
  await p.press("Escape");
  const unpopped = await p.ev(`({ pop: document.documentElement.dataset.pop, home: document.querySelector("#tree").parentElement.id, focus: window.__ui.focus() })`);
  rows.push(["at 700 px, the sidebar is its rail", narrow.side && narrow.width === 44 && narrow.icons && !narrow.fold && still.side === "0" && !still.pop
    && popped.pop === "tree" && popped.tree && popped.top === 0 && popped.full && popped.scrim && popped.focus.inSide && !unpopped.pop && unpopped.home === "trees" && unpopped.focus.cls.includes("icon"),
    !narrow.side || narrow.width !== 44 || !narrow.icons ? `the sidebar is ${narrow.side ? narrow.width + " px" : "gone"}${narrow.icons ? "" : ", with no icons"}` : narrow.fold ? "it offers to open, which it cannot at this width"
      : still.side !== "0" || still.pop ? "\\ did something where there is nothing to fold" : popped.pop !== "tree" || !popped.tree ? "the projects icon opened nothing"
        : popped.top !== 0 || !popped.full ? `the popover is ${popped.h} px from ${popped.top}, not the window's height` : !popped.scrim ? "nothing behind it to tap" : !popped.focus.inSide ? "focus stayed outside it"
          : unpopped.pop || unpopped.home !== "trees" ? "Escape did not put the projects back" : !unpopped.focus.cls.includes("icon") ? `focus went to ${unpopped.focus.tag}.${unpopped.focus.cls}, not the icon`
            : "44 px of icons; a section opens full height over a scrim, Escape puts it back and focus on its icon"]);

  const titleBefore = await p.ev("document.title");
  await p.clickOn('#rail-nav [data-pop="tree"]');
  const rowsShown = await p.ev(`({ all: document.querySelectorAll("#pop .t-doc a").length, other: document.querySelectorAll("#pop .t-doc a:not([aria-current])").length })`);
  if (rowsShown.other) await p.clickOn(`#pop .t-doc a:not([aria-current])`);
  await sleep(600);
  const navigated = await p.ev(`({ pop: document.documentElement.dataset.pop, title: document.title })`);
  await p.wide();
  const widened = await p.ev(`({ side: window.__ui.vis("#side"), width: Math.round(document.querySelector("#side").getBoundingClientRect().width), rail: window.__ui.vis("#rail"), icons: window.__ui.vis("#rail-nav") })`);
  await p.pointerAway();
  rows.push(["a row in the popover, then a wider window", navigated.title !== titleBefore && !navigated.pop && widened.side && widened.width > 200 && !widened.icons && widened.rail,
    navigated.title === titleBefore ? `the row opened nothing (${rowsShown.all} rows, ${rowsShown.other} not current)` : navigated.pop ? "the popover stayed open over the document it opened"
      : !widened.side || widened.width <= 200 || widened.icons ? `back at 1280 px the sidebar is ${widened.side ? widened.width + " px" : "gone"}` : !widened.rail ? "back at 1280 px the rail is gone"
        : "opens the document and closes; the sidebar is back open at 1280 px"]);
  // Back to the page with code on it: `z` below says "no code on this page"
  // on the one the popover opened, and it would be right to.
  if (navigated.title !== titleBefore) { await p.press("ArrowLeft", { alt: true }); await sleep(600); }

  for (const w of [1000, 700]) {
    await p.width(w);
    // Clear anything left over; with nothing over the page, Esc would take
    // the reader off the document (backRows), which is not this row's to do.
    if (await p.ev(`!!document.documentElement.dataset.sheet || !!document.documentElement.dataset.pop || document.body.classList.contains("keys")`)) await p.press("Escape");
    const worked = [], broke = [];
    const check = (name, ok) => (ok ? worked : broke).push(name);
    await p.press("?"); check("?", await p.ui("vis", "#help")); await p.press("Escape");
    await p.press("/"); check("/", (await p.ui("vis", "#find")) && (await p.ui("at", "#find-input"))); await p.press("Escape");
    await p.press("k", { ctrl: true }); check("⌘K", (await p.ui("vis", "#palette")) && (await p.ui("at", "#palette-input"))); await p.press("Escape");
    const wideBefore = await p.ev(`document.documentElement.dataset.wide || ""`);
    await p.press("w"); check("w", (await p.ev(`document.documentElement.dataset.wide || ""`)) !== wideBefore); await p.press("w");
    const wrapBefore = await p.ev(`document.documentElement.dataset.wrap || ""`);
    await p.press("z"); check("z", (await p.ev(`document.documentElement.dataset.wrap || ""`)) !== wrapBefore); await p.press("z");
    await p.press("t"); check("t", (await p.ev(`document.documentElement.dataset.sheet`)) === "rail"); await p.press("Escape");
    // Narrow, the sidebar is only ever its rail, so \\ has nothing to fold.
    await p.press("\\"); check("\\", await p.ev(`document.documentElement.dataset.side === "0"`)); await p.press("Escape");
    if (w > 760) await p.press("\\");   // put the pane back
    await p.press("i"); await sleep(400); check("i", await p.ev(`document.querySelector("#rail").classList.contains("empty")`));
    await p.press("j"); await sleep(600); check("j", await p.ev(`!document.querySelector("#rail").classList.contains("empty")`));
    rows.push([`every key at ${w} px`, broke.length === 0, broke.length ? `${broke.join(" ")} did nothing` : `${worked.join(" ")} do what the help box says`]);
  }
  await p.wide();

  // The palette's rows are titled in the page's own colour. Its title and
  // subtitle spans are .t and .s, which are also the highlighter's classes
  // for a type and a string, and until 0.16 those rules were global: every
  // result title came up in the cyan of a type name.
  await p.press("k", { ctrl: true });
  await p.type("a");
  await sleep(500);
  const inks = await p.ev(`(() => {
    const t = document.querySelector("#palette-list .t"), s = document.querySelector("#palette-list .s");
    const c = el => el ? getComputedStyle(el).color : "";
    return { rows: document.querySelectorAll("#palette-list li").length, title: c(t), sub: c(s), page: getComputedStyle(document.body).color, type: getComputedStyle(document.documentElement).getPropertyValue("--s-type").trim() };
  })()`);
  await p.press("Escape");
  rows.push(["the palette's rows, in ink", inks.rows > 0 && inks.title === inks.page && inks.sub !== inks.title,
    !inks.rows ? "the palette found nothing to list" : inks.title !== inks.page ? `a title is ${inks.title}, the page ${inks.page} (a type is ${inks.type})` : inks.sub === inks.title ? "the subtitle is in the title's colour" : "titles in the page's colour, subtitles quieter, nothing from the syntax theme"]);
  return rows;
}

/** 1.7.1: `\\` folds the sidebar to a 44 px rail of its sections' icons, and
 *  each icon opens its section beside it -- the same element, moved, and moved
 *  back. (`railRows` above is the contents rail on the right.) */
async function sideRailRows(p, url, arrive) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();
  const HOME = ["inbox-row", "queue", "tree", "desk-nav", "browse-nav", "pop"];
  // The fold eases over 160 ms; the widths below are read where it lands.
  const eased = () => p.ev(`Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => 0))).then(() => 1)`);
  await p.press("\\");
  await eased();
  const folded = await p.ev(`({ side: document.documentElement.dataset.side, width: Math.round(document.querySelector("#side").getBoundingClientRect().width), icons: window.__ui.vis("#rail-nav"), tree: window.__ui.vis("#tree") })`);
  rows.push(["\\ folds the sidebar to its rail", folded.side === "0" && folded.width === 44 && folded.icons && !folded.tree,
    folded.side !== "0" ? "\\ did not fold it" : folded.width !== 44 ? `the rail is ${folded.width} px` : !folded.icons ? "no icons on it" : folded.tree ? "the tree is still drawn in 44 px" : "44 px, icons only"]);

  const opened = [], broke = [];
  for (const [sec, id] of [["inbox", "queue"], ["tree", "tree"], ["desks", "desk-nav"], ["browse", "browse-nav"], ["note", "note"]]) {
    if (!(await p.ui("vis", `#rail-nav [data-pop="${sec}"]`))) { if (sec !== "note") broke.push(`${sec}: no icon`); continue; }
    await p.clickOn(`#rail-nav [data-pop="${sec}"]`);
    const m = await p.ev(`({ in: !!document.querySelector("#pop > #${id}"), shown: window.__ui.vis("#pop"), left: Math.round(document.querySelector("#pop").getBoundingClientRect().left), focus: window.__ui.focus() })`);
    await p.press("Escape");
    const back = await p.ev(`({ pop: document.documentElement.dataset.pop, on: document.activeElement?.dataset.pop })`);
    if (!m.in || !m.shown) broke.push(`${sec}: #${id} not in the popover`);
    else if (m.left < 44) broke.push(`${sec}: the popover is over the rail (${m.left} px)`);
    else if (!m.focus.inSide) broke.push(`${sec}: focus stayed outside`);
    else if (back.pop || back.on !== sec) broke.push(`${sec}: Escape left ${back.pop ? "it open" : `focus on ${back.on}`}`);
    else opened.push(sec);
  }
  rows.push(["each icon opens its section", broke.length === 0 && opened.length >= 4, broke.length ? broke.join("; ") : `${opened.join(", ")}: beside the rail, focus in, Escape back to the icon`]);

  // One at a time: a second icon closes the first.
  await p.clickOn('#rail-nav [data-pop="tree"]');
  await p.clickOn('#rail-nav [data-pop="browse"]');
  const one = await p.ev(`({ pop: document.documentElement.dataset.pop, tree: document.querySelector("#tree").parentElement.id, browse: document.querySelector("#browse-nav").parentElement.id })`);
  await p.click(640, 400);
  const outside = await p.ev(`document.documentElement.dataset.pop || ""`);
  rows.push(["one popover at a time, a click outside closes it", one.pop === "browse" && one.tree === "trees" && one.browse === "pop" && outside === "",
    one.pop !== "browse" || one.browse !== "pop" ? "the second icon opened nothing" : one.tree !== "trees" ? "the first section stayed in the popover" : outside ? "a click outside left it open" : "the second replaces the first; a click beside it closes it"]);

  // The number on the inbox is the number waiting.
  await arrive();
  await sleep(700);
  const count = await p.ev(`({ badge: document.querySelector('#rail-nav [data-pop="inbox"] .badge').textContent, label: document.querySelector("#queue .t-label .n")?.textContent || "" })`);
  rows.push(["the inbox icon says how many wait", count.badge !== "" && count.badge === count.label,
    count.badge === "" ? `nothing on the icon (the queue says ${count.label || "nothing"})` : count.badge !== count.label ? `the icon says ${count.badge}, the queue ${count.label}` : `${count.badge}, as the queue says`]);

  // Tab reaches every icon, and the arrows walk them.
  await p.ev(`document.querySelector(".brand").focus()`);
  const tabbed = new Set();
  for (let i = 0; i < 16; i++) {
    await p.press("Tab");
    const f = await p.ev(`(() => { const a = document.activeElement; return a.closest("#rail-nav") ? (a.dataset.pop || a.id) : ""; })()`);
    if (f) tabbed.add(f);
  }
  await p.ev(`document.querySelector('#rail-nav [data-pop="inbox"]').focus()`);
  await p.press("ArrowDown");
  const walked = await p.ev(`document.activeElement?.dataset.pop || ""`);
  const want = ["inbox", "tree", "desks", "browse", "rail-live", "rail-search"];
  const missed = want.filter(k => !tabbed.has(k));
  rows.push(["Tab reaches every icon, the arrows walk them", missed.length === 0 && walked === "tree",
    missed.length ? `never reached ${missed.join(", ")}` : walked !== "tree" ? `↓ from the inbox went to ${walked || "nothing"}` : "every icon a stop, ↓ to the next"]);

  // Unfolded, every section is back in #trees, in its order.
  // With one open, \\ closes it; the next one unfolds.
  await p.clickOn('#rail-nav [data-pop="desks"]');
  await p.press("\\");
  const shut = await p.ev(`({ pop: document.documentElement.dataset.pop || "", side: document.documentElement.dataset.side })`);
  await p.press("\\");
  await eased();
  const order = await p.ev(`[...document.querySelector("#trees").children].map(e => e.id)`);
  const width = await p.ev(`Math.round(document.querySelector("#side").getBoundingClientRect().width)`);
  rows.push(["\\ closes a popover, then unfolds, the sections in their order", !shut.pop && shut.side === "0" && JSON.stringify(order) === JSON.stringify(HOME) && width > 200,
    shut.pop ? "\\ left the popover open" : shut.side !== "0" ? "\\ unfolded with a popover open" : width <= 200 ? `the sidebar is ${width} px` : `#trees holds ${order.join(", ")}`]);
  return rows;
}

/** 0.12: by keyboard, and by a finger. */
async function keyboardRows(p, url) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();

  // Tab from the top of the page, noting where focus lands each time, until
  // it comes back round or runs out.
  // From the top: the sidebar (tabindex -1) takes the focus and gives it up,
  // which puts Tab's starting point before the brand whatever a section
  // before this one left focused -- a same-page goto does not reload.
  await p.ev(`document.activeElement.blur(); document.querySelector("#side").focus(); document.activeElement.blur(); window.__ui.scrollMain(0)`);
  const seen = [];
  for (let i = 0; i < 160; i++) {
    await p.press("Tab");
    const f = await p.ev(`(() => { const a = document.activeElement; a.dataset.tabbed = "1"; return window.__ui.focus(); })()`);
    if (f.tag === "BODY" && i > 0) break;
    seen.push(f);
  }
  const required = [
    [".brand", "the brand"], ["#btn-search", "search"], [".t-inbox", "the inbox row"], [".t-doc a", "a document row"], [".ren", "a rename"],
    ["#btn-theme", "theme"], ["#btn-font", "font"], ["#btn-wide", "width"], ["#btn-wrap", "wrap"], ["#btn-help", "the keys"],
    ["#toc a", "a contents entry"], ["#meta [data-act=pin]", "pin"], ["#meta [data-act=delete]", "delete"], ["pre.code .copy", "copy code"],
  ];
  // Each stop was marked in the page as it was reached, because most of these
  // controls have no id to name them by from out here.
  const missing = [];
  for (const [sel, name] of required) {
    const hit = await p.ev(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; return els.some(el => el.dataset.tabbed === "1"); })()`);
    if (!hit) missing.push(name);
  }
  const stops = seen.map(f => f.id || f.cls.split(" ")[0] || f.tag.toLowerCase()).join(" ");
  dbg("tab", { stops, last: seen[seen.length - 1], rail: await p.ev(`({ display: getComputedStyle(document.querySelector("#rail")).display, attr: document.documentElement.dataset.rail, links: document.querySelectorAll("#toc a").length, empty: document.querySelector("#rail").classList.contains("empty") })`) });
  rows.push(["Tab reaches every control", missing.length === 0 && seen.length > 0,
    missing.length ? `${seen.length} stops (${stops}), and never ${missing.join(", ")}` : `${seen.length} stops, every control among them`]);

  await p.ev(`document.querySelector("#btn-search").focus()`);
  await p.press("k", { ctrl: true });
  const palIn = await p.ui("focus");
  for (let i = 0; i < 3; i++) await p.press("Tab");
  const palStill = await p.ui("focus");
  await p.press("Escape");
  const palBack = await p.ui("focus");
  rows.push(["the palette holds focus", palIn.id === "palette-input" && palStill.inPalette && palBack.id === "btn-search",
    palIn.id !== "palette-input" ? `opened with focus on ${palIn.tag}#${palIn.id}` : !palStill.inPalette ? `three Tabs later focus is on ${palStill.tag}#${palStill.id}` : palBack.id !== "btn-search" ? `closed with focus on ${palBack.tag}#${palBack.id || palBack.cls}` : "focus in, kept in, given back"]);

  await p.ev(`document.querySelector("#btn-help").focus()`);
  await p.press("?");
  const helpIn = await p.ui("focus");
  for (let i = 0; i < 2; i++) await p.press("Tab");
  const helpStill = await p.ui("focus");
  await p.press("Escape");
  const helpBack = await p.ui("focus");
  // The keys button stands in the column that grows out of the light/dark
  // switch, which is up only while a pointer rests there; a click at its
  // coordinates with the pointer parked elsewhere lands on whatever the
  // closed column is floating over.
  await p.hoverOn(".foot-set");
  await p.clickOn("#btn-help");
  const byClick = await p.ui("vis", "#help");
  await p.clickOn("#help-close");
  const byClose = await p.ui("vis", "#help");
  await p.pointerAway();
  rows.push(["the help box holds focus", helpIn.inHelp && helpStill.inHelp && helpBack.id === "btn-help" && byClick && !byClose,
    !helpIn.inHelp ? `opened with focus on ${helpIn.tag}#${helpIn.id}` : !helpStill.inHelp ? `two Tabs later focus is on ${helpStill.tag}#${helpStill.id}` : helpBack.id !== "btn-help" ? `closed with focus on ${helpBack.tag}#${helpBack.id || helpBack.cls}` : !byClick ? "the footer's button did not open it" : byClose ? "its close button did not close it" : "focus in, kept in, given back; opens and closes by button too"]);

  await p.press("/");
  await p.type("fox");
  await sleep(300);
  const count = await p.ev(`(() => { const c = document.querySelector("#find-count"); return { text: c.textContent, live: c.getAttribute("aria-live"), role: c.getAttribute("role") }; })()`);
  await p.press("Escape");
  rows.push(["the find count is announced", /^\d+ \/ \d+$/.test(count.text) && count.live === "polite",
    count.live !== "polite" ? "the count is not a live region" : `"${count.text}", polite`]);

  await p.ev("document.activeElement.blur()");
  const opacity = sel => p.ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).opacity`);
  // A headless browser has no pointing device and answers (hover: none)
  // already; a headed one is asked to pretend it is a touch screen. Either
  // way the reading is taken with the page believing there is nothing to
  // hover with, which is the case the rule exists for.
  await p.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 }, p.s);
  await sleep(400);   // the control focus had shown is fading back out
  const touch = await p.ev(`({ none: matchMedia("(hover: none)").matches, copy: getComputedStyle(document.querySelector("pre.code .copy")).opacity, ren: getComputedStyle(document.querySelector(".ren")).opacity, lang: getComputedStyle(document.querySelector("pre.code"), "::before").opacity, anchor: getComputedStyle(document.querySelector(".prose a.anchor")).opacity })`);
  await p.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, p.s);
  rows.push(["no pointer to hover with", touch.none && touch.copy === "1" && touch.ren === "1" && Number(touch.anchor) > 0,
    !touch.none ? "the page could not be made to believe it has no pointer" : `copy ${touch.copy}, rename ${touch.ren}, # ${touch.anchor} under (hover: none)`]);

  return rows;
}

/** 0.13: the panes' edges drag, within limits, and the width is kept. */
async function widthRows(p, url) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();
  const side = () => p.ev(`({ w: Math.round(document.querySelector("#side").getBoundingClientRect().width), now: document.querySelector("#side .gutter").getAttribute("aria-valuenow"), main: Math.round(document.querySelector("#main").getBoundingClientRect().left) })`);
  const railW = () => p.ev(`Math.round(document.querySelector("#rail").getBoundingClientRect().width)`);
  const gutter = sel => p.ui("center", sel);

  const start = await side();
  let at = await gutter("#side .gutter");
  await p.drag(at.x, at.y, 120);
  const wider = await side();
  dbg("drag", { start, at, wider });
  rows.push(["the sidebar drags wider", start.w === 264 && wider.w === 384 && wider.main === 384,
    `${start.w} px, dragged 120: ${wider.w} px, the document starts at ${wider.main}`]);

  at = await gutter("#side .gutter");
  await p.drag(at.x, at.y, 600);
  const capped = await side();
  rows.push(["and stops at its limit", capped.w === 440, `dragged 600 more: ${capped.w} px`]);

  await p.reload();
  const kept = await side();
  rows.push(["kept after a reload", kept.w === 440, `${kept.w} px after the reload`]);

  await p.ev(`document.querySelector("#side .gutter").focus()`);
  await p.press("ArrowLeft");
  const byKey = await side();
  rows.push(["the arrow keys move it", byKey.w === 424 && byKey.now === "424", `ArrowLeft from 440: ${byKey.w} px, announced as ${byKey.now}`]);

  at = await gutter("#side .gutter");
  await p.dblclick(at.x, at.y);
  const reset = await side();
  await p.reload();
  const resetKept = await side();
  rows.push(["double-click puts it back", reset.w === 264 && resetKept.w === 264, `${reset.w} px, ${resetKept.w} px after a reload`]);

  const railBefore = await railW();
  at = await gutter("#rail .gutter");
  await p.drag(at.x, at.y, -100);
  const railAfter = await railW();
  at = await gutter("#rail .gutter");
  await p.dblclick(at.x, at.y);
  const railReset = await railW();
  await p.pointerAway();
  rows.push(["the rail drags too", railBefore === 232 && railAfter === 332 && railReset === 232,
    `${railBefore} px, dragged 100 leftwards: ${railAfter} px, double-click: ${railReset} px`]);
  return rows;
}

/** 0.13: a diagram fills the window from inside the page, and the page
 *  comes back whole. */
async function diagramRows(p, url) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();
  await p.ev(`document.querySelector(".mmd").scrollIntoView({ block: "center", behavior: "instant" })`);
  let drawn = false;
  for (let i = 0; i < 80 && !drawn; i++) { await sleep(100); drawn = await p.ev(`!!document.querySelector('.mmd[data-state="done"]')`); }
  await sleep(300);
  const read = () => p.ev(`(() => {
    const fig = document.querySelector(".mmd"), frame = fig.querySelector(".mmd-frame"), r = frame.getBoundingClientRect();
    const labels = [...fig.querySelectorAll("foreignObject, text")].filter(t => t.getBoundingClientRect().width > 0).length;
    return { drawn: fig.dataset.state === "done", full: fig.dataset.full === "1", topLayer: document.fullscreenElement === fig,
      frame: [r.left, r.top, r.width, r.height].map(Math.round), width: frame.clientWidth, labels, zoom: fig.dataset.zoom,
      cv: fig.style.contentVisibility, win: [innerWidth, innerHeight], top: document.querySelector("#main").scrollTop };
  })()`);
  const before = await read();
  await p.press("f");
  await sleep(600);
  const filled = await read();
  dbg("fill", { before, filled });
  rows.push(["f fills the window", before.drawn && filled.full && !filled.topLayer && filled.frame[0] === 0 && filled.frame[1] === 0 && filled.frame[2] === filled.win[0] && filled.frame[3] === filled.win[1] && filled.labels > 0,
    !before.drawn ? "the diagram was never drawn" : !filled.full ? "f filled nothing" : filled.topLayer ? "the figure itself went into the top layer"
      : filled.labels === 0 ? "the labels were not laid out" : filled.frame[2] !== filled.win[0] || filled.frame[3] !== filled.win[1] ? `the frame is ${filled.frame[2]}×${filled.frame[3]} in a ${filled.win[0]}×${filled.win[1]} window`
        : `the frame is the ${filled.win[0]}×${filled.win[1]} window, ${filled.labels} labels laid out, the figure itself not in the top layer`]);

  await p.press("Escape");
  await sleep(600);
  const back = await read();
  dbg("back", back);
  rows.push(["Escape gives the page back", !back.full && back.width > 0 && back.frame[3] > 0 && back.frame[3] < back.win[1] && back.zoom === "fit" && back.cv === "visible" && Math.abs(back.top - before.top) < 2,
    back.full ? "still filling" : back.width === 0 ? "the figure came back with no size, waiting on a scroll" : back.frame[3] >= back.win[1] ? `came back ${back.frame[3]} px tall`
      : back.zoom !== "fit" ? `came back zoomed ${back.zoom}` : back.cv !== "visible" ? "came back as a placeholder again" : Math.abs(back.top - before.top) >= 2 ? `the document moved from ${before.top} to ${back.top}`
        : `${back.width} px wide and fitted again with no scroll, document at ${back.top}`]);

  await p.clickOn(".mmd [data-mmd=full]");
  await sleep(600);
  const byButton = await read();
  await p.clickOn(".mmd [data-mmd=full]");
  await sleep(600);
  const byButtonBack = await read();
  await p.pointerAway();
  rows.push(["the button, both ways", byButton.full && !byButtonBack.full && byButtonBack.width > 0,
    !byButton.full ? "the button filled nothing" : byButtonBack.full ? "the button did not give the page back" : byButtonBack.width === 0 ? "back with no size" : "fills on one click, gives the page back on the next"]);
  return rows;
}

/** 0.14: an arrival joins a queue and the page stays where it is; `n` reads
 *  down the line; Back returns to the place; the count survives a reload. */
async function queueRows(p, url, arrive) {
  const rows = [];
  const read = () => p.ev(`(() => {
    const bar = document.querySelector("#queue-bar");
    return { title: document.title, path: location.pathname, bar: bar.hidden ? null : bar.textContent.trim(),
      side: [...document.querySelectorAll("#queue a.new .title")].map(a => a.textContent), more: document.querySelector("#queue .t-more")?.textContent || null,
      marked: document.querySelectorAll("#tree a.new").length, waiting: [...document.querySelectorAll(".inbox.waiting .title")].map(a => a.textContent),
      place: window.__ui.place() };
  })()`);
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };

  await p.goto(url);
  // Nothing waiting to start with, whatever the sections above left unread:
  // every count below is counted from here. Mark all read, as the inbox does.
  await p.ev(`fetch("/api/queue/clear", { method: "POST" }).then(r => r.status)`);
  await p.reload();
  await p.pointerAway();
  await p.ui("scrollMain", 12000); await sleep(700);
  const before = await read();
  const first = await arrive();
  const barCame = await until(`!document.querySelector("#queue-bar").hidden`);
  await sleep(400);
  const during = await read();
  dbg("arrival", { before, during });
  const stayed = during.title === before.title && during.place.block === before.place.block && Math.abs(during.place.delta - before.place.delta) < 2;
  rows.push(["an arrival while reading", barCame && stayed && /^1 waiting/.test(during.bar) && during.bar.includes(first.title) && during.side.length === 1 && during.marked === 1,
    !barCame ? "no bar appeared" : during.title !== before.title ? `the page changed to "${during.title}"` : !stayed ? `the document moved: block ${before.place.block} at ${before.place.delta} px, then block ${during.place.block} at ${during.place.delta} px`
      : !/^1 waiting/.test(during.bar) ? `the bar reads "${during.bar.slice(0, 30)}"` : during.side.length !== 1 ? `${during.side.length} rows in the sidebar's queue` : during.marked !== 1 ? `${during.marked} rows marked in the tree`
        : `page unmoved at block ${during.place.block}; bar reads "1 waiting", one row in the sidebar, one marked in the tree`]);

  await p.press("n");
  await sleep(600);
  const opened = await read();
  rows.push(["n opens it", opened.title === first.title && opened.bar === null && opened.side.length === 0 && opened.marked === 0,
    opened.title !== first.title ? `n opened "${opened.title}"` : opened.bar !== null ? "the bar is still up" : opened.side.length ? "the sidebar still lists it" : opened.marked ? "the tree still marks it" : "open, off the queue, unmarked in the tree"]);

  await p.press("ArrowLeft", { alt: true });
  await sleep(800);
  const back = await read();
  dbg("back", { before: before.place, back: back.place });
  rows.push(["alt ← is Back, to the place", back.title === before.title && back.place.block === before.place.block && Math.abs(back.place.delta - before.place.delta) < 2,
    back.title !== before.title ? `landed on "${back.title}"` : `back on the plan at block ${back.place.block}, ${back.place.delta} px in (was ${before.place.delta})`]);
  await p.press("ArrowRight", { alt: true });
  await sleep(600);
  const fwd = await read();
  rows.push(["alt → is Forward", fwd.title === first.title, fwd.title === first.title ? "forward to the arrival" : `landed on "${fwd.title}"`]);

  await Promise.all(Array.from({ length: 12 }, arrive));
  const twelve = await until(`/^1\\/12/.test(document.querySelector("#queue-bar").textContent)`);
  await sleep(300);
  const many = await read();
  // Twelve sent at once land in whatever order the daemon took them; the
  // order it keeps is the order the page must show.
  const served = await p.ev(`fetch("/api/queue").then(r => r.json()).then(q => q.map(d => d.title))`);
  const inOrder = many.side.join("|") === served.slice(0, 6).join("|");
  rows.push(["twelve at once", twelve && many.side.length === 6 && /6 more/.test(many.more || "") && inOrder,
    !twelve ? `the bar reads "${many.bar ? many.bar.slice(0, 20) : "nothing"}"` : many.side.length !== 6 ? `${many.side.length} rows in the sidebar` : !/6 more/.test(many.more || "") ? `"${many.more}" under them` : !inOrder ? `the sidebar's order is not the daemon's` : "bar reads 1/12; six rows and \"6 more\" in the sidebar, in arrival order"]);

  await p.reload();
  const kept = await read();
  rows.push(["still waiting after a reload", /^1\/12/.test(kept.bar || "") && kept.side.length === 6,
    `the bar reads "${(kept.bar || "nothing").slice(0, 20)}", ${kept.side.length} rows in the sidebar`]);

  // ‹ › step the bar through what waits, round the ends, and open nothing (#100).
  await p.clickOn("#queue-bar [data-q=step]");
  await sleep(200);
  const stepped = await read();
  await p.clickOn("#queue-bar [data-q=prev]");
  await p.clickOn("#queue-bar [data-q=prev]");
  await sleep(200);
  const round = await read();
  await p.clickOn("#queue-bar [data-q=step]");
  await sleep(200);
  const home = await read();
  const shows = (r, i) => (r.bar || "").startsWith(`${i + 1}/12${served[i]}`);
  rows.push(["› and ‹ step the bar, round the ends", shows(stepped, 1) && shows(round, 11) && shows(home, 0) && home.side.length === 6,
    `the bar read "${(stepped.bar || "").slice(0, 16)}", "${(round.bar || "").slice(0, 16)}", "${(home.bar || "").slice(0, 16)}", ${home.side.length} rows still waiting`]);

  await p.press("i");
  await sleep(600);
  const inbox = await read();
  rows.push(["the inbox lists them first", inbox.bar === null && inbox.waiting.length === 12 && inbox.waiting[0] === served[0],
    inbox.bar !== null ? "the bar is up on the inbox" : `${inbox.waiting.length} waiting on the inbox, "${inbox.waiting[0]}" first`]);

  const late = await arrive();
  await until(`document.querySelectorAll(".inbox.waiting li").length === 13`);
  const still = await read();
  await p.clickOn(".inbox-sec [data-q=clear]");
  await sleep(500);
  await p.reload();
  const cleared = await read();
  rows.push(["an inbox with a queue, cleared", still.title === "snyvi" && still.waiting.length === 13 && cleared.waiting.length === 0 && cleared.side.length === 0 && cleared.bar === null,
    still.title !== "snyvi" ? `the arrival opened itself over the inbox: "${still.title}"` : still.waiting.length !== 13 ? `${still.waiting.length} waiting after the arrival` : cleared.waiting.length || cleared.side.length ? "something is still waiting after Mark all read and a reload" : `the arrival became the 13th row; Mark all read emptied the queue, and a reload agrees`]);

  const fresh = await arrive();
  const openedItself = await until(`document.title === ${JSON.stringify(fresh.title)}`);
  const empty = await read();
  rows.push(["an arrival on an empty inbox", openedItself && empty.bar === null && empty.marked === 0,
    !openedItself ? `stayed on "${empty.title}"` : empty.bar !== null ? "opened, but the bar counts it" : "opened itself, and is read"]);

  // 1.7.1: one file sent three times, twice from one session and once from
  // another workflow, unread, is one row waiting: the newest. The daemon
  // counted one all along; the page kept the older rows until a reload.
  await p.goto(url);
  const plan = "the-plan.md";
  await arrive({ name: plan, body: "# The plan\n\nFirst draft.\n" });
  await until(`[...document.querySelectorAll("#queue .title")].some(t => t.textContent === "The plan")`);
  await arrive({ name: plan, body: "# The plan, revised\n\nSecond draft.\n" });
  await until(`[...document.querySelectorAll("#queue .title")].some(t => t.textContent === "The plan, revised")`);
  await sleep(300);
  const twice = await p.ev(`({ rows: [...document.querySelectorAll("#queue .title")].map(t => t.textContent).filter(t => t.startsWith("The plan")), n: document.querySelector("#queue .t-label .n")?.textContent })`);
  await arrive({ name: plan, body: "# The plan, third\n\nFrom elsewhere.\n", workflow: "ui audit" });
  await until(`[...document.querySelectorAll("#queue .title")].some(t => t.textContent === "The plan, third")`);
  await sleep(300);
  const thrice = await p.ev(`({ rows: [...document.querySelectorAll("#queue .title")].map(t => t.textContent).filter(t => t.startsWith("The plan")), n: document.querySelector("#queue .t-label .n")?.textContent })`);
  await p.press("i"); await sleep(600);
  const listed = await p.ev(`[...document.querySelectorAll(".inbox.waiting .title")].map(a => a.textContent).filter(t => t.startsWith("The plan"))`);
  rows.push(["one file sent three times waits once", twice.rows.join("|") === "The plan, revised" && thrice.rows.join("|") === "The plan, third" && listed.join("|") === "The plan, third" && thrice.n === "1",
    twice.rows.length !== 1 ? `after two sends the sidebar lists ${twice.rows.join(", ")}` : thrice.rows.length !== 1 ? `after a third from another workflow it lists ${thrice.rows.join(", ")}`
      : listed.length !== 1 ? `the inbox lists ${listed.join(", ")}` : thrice.n !== "1" ? `the count says ${thrice.n}` : "one row, the newest, in the sidebar and the inbox; the count says 1"]);
  void late;
  return rows;
}

/** 0.15: a removal is one keystroke and a few seconds of Undo, over a soft
 *  delete the daemon keeps until `prune` runs. The confirmation it replaces
 *  was a `window.confirm`, which the native window draws as the toolkit's own
 *  dialog -- and which would hang every row below, since a blocked page
 *  answers nothing. 1.6: the Undo stands in the row's own place, for 6 s (1.8's one window),
 *  with a bar that drains, and no toast says "Deleted". */
async function deleteRows(p, arrive) {
  const rows = [];
  const listed = title => p.ev(`[...document.querySelectorAll(".inbox .title")].map(t => t.textContent).includes(${JSON.stringify(title)})`);
  const toastEl = () => p.ev(`(() => { const t = document.querySelector("#toasts .toast"); return t ? { text: t.textContent, act: !!t.querySelector(".act") } : null; })()`);
  const ghost = () => p.ev(`(() => { const g = document.querySelector("#trees .t-ghost"); if (!g) return null; const r = g.getBoundingClientRect(); return { text: g.textContent, y: Math.round(r.top), h: Math.round(r.height) }; })()`);
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };

  const doomed = await arrive();
  await p.goto(`${await p.ev("location.origin")}/d/${doomed.id}`);
  await p.pointerAway();
  await p.press("Delete");
  await sleep(500);
  const after = await toastEl(), g1 = await ghost();
  const gone = !(await listed(doomed.title));
  const said = g1 && g1.text.includes(doomed.title) && /removed/.test(g1.text);
  rows.push(["Del removes at once", gone && said && !(after && /Deleted/.test(after.text)) && await p.ev(`document.title === "snyvi"`),
    !gone ? "the document is still in the inbox" : !g1 ? "no row offers Undo in the sidebar" : after && /Deleted/.test(after.text) ? `a toast still says "${after.text}"` : `nothing asked, and its row says "${g1.text}"`]);

  await p.clickOn("#trees .t-ghost .t-undo");
  const back = await until(`document.title === ${JSON.stringify(doomed.title)}`);
  rows.push(["Undo in the row puts it back", back, back ? "the document is open again, where it was removed from" : `landed on "${await p.ev("document.title")}"`]);

  await p.press("Delete");
  await sleep(400);
  await p.press("z", { ctrl: true });
  const byKey = await until(`document.title === ${JSON.stringify(doomed.title)}`);
  rows.push(["and ⌘Z does the same", byKey, byKey ? "removed and undone without touching the row" : `landed on "${await p.ev("document.title")}"`]);

  // The ✕ on the row itself: the ghost takes the row's own place and height.
  const sel = `#tree a[data-id="${doomed.id}"]`;
  const was = await p.ev(`(() => { const a = document.querySelector(${JSON.stringify(sel)}); if (!a) return null; const r = a.getBoundingClientRect(); return { y: Math.round(r.top), h: Math.round(r.height) }; })()`);
  if (was) {
    await p.hoverOn(sel);
    await p.clickOn(`${sel} [data-deldoc]`);
    await sleep(300);
    const g2 = await ghost(), t2 = await toastEl();
    const inPlace = g2 && Math.abs(g2.y - was.y) <= 1 && Math.abs(g2.h - was.h) <= 1;
    rows.push(["the ✕ leaves its Undo in the row", !!inPlace && !t2,
      !g2 ? "no ghost row" : t2 ? `a toast came too: "${t2.text}"` : inPlace ? `at the row's own place, ${g2.h} px high` : `the row was at y ${was.y}, ${was.h} px; the ghost is at y ${g2.y}, ${g2.h} px`]);
    // Resting on it stops the clock.
    await p.hoverOn("#trees .t-ghost");
    await sleep(6600);
    const held = !!(await ghost());
    rows.push(["resting on it stops the clock", held, held ? "still offering Undo after 6.6 s under the pointer" : "it went while the pointer was on it"]);
    await p.pointerAway();
    await sleep(6800);
    const settled = !(await ghost());
    rows.push(["and off it, the offer ends", settled, settled ? "the row closed once the 6 s had run" : "the ghost is still there"]);
  } else rows.push(["the ✕ leaves its Undo in the row", false, "the document's row is not in the sidebar"]);

  await p.reload();
  const stillGone = !(await listed(doomed.title));
  const found = await p.ev(`fetch("/api/search?q=" + encodeURIComponent(${JSON.stringify(doomed.title)})).then(r => r.json()).then(h => h.length)`);
  rows.push(["a removal a reload agrees with", stillGone && found === 0,
    !stillGone ? "the inbox lists it again after the reload" : found ? `search still finds ${found}` : "gone from the inbox and from search, because the daemon did it"]);
  return rows;
}

/** 1.8, the design system (docs/DESIGN.md) as behaviour: every control names
 *  itself in snyvi's tip and never the OS's title; an answer stands where it
 *  was asked, and gives the tip way; one Undo stands at a time, across kinds,
 *  with its drain; a removal says how many versions went; after the window,
 *  Removed · Show still brings it back; the quiet switch keeps. */
async function designRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const tipOn = () => p.ev(`(() => { const t = document.querySelector("#tip.on"); return t ? t.textContent : null; })()`);
  await p.goto(url);
  await p.pointerAway();

  // No title anywhere: the OS would draw its own box over snyvi's.
  await p.press("?");
  await until(`!document.querySelector("#help").hidden`);
  const titled = await p.ev(`[...document.querySelectorAll("[title]")].filter(e => e.tagName !== "IFRAME" && e.tagName !== "TITLE").map(e => e.id || e.className || e.tagName).slice(0, 5)`);
  await p.press("Escape");
  rows.push(["no element in ui/ has a title", titled.length === 0, titled.length ? `still titled: ${titled.join(", ")}` : "the page and the shortcuts card name everything by tip"]);

  // The tip, on the keyboard's focus as well as the pointer's rest.
  let tabbed = null;
  for (let i = 0; i < 20 && !tabbed; i++) {
    await p.press("Tab");
    tabbed = await p.ev(`document.activeElement?.dataset?.tip || null`);
  }
  await sleep(300);
  const onFocus = await tipOn();
  rows.push(["tip shows on focus", !!tabbed && !!onFocus && onFocus.startsWith(tabbed),
    !tabbed ? "Tab reached no control with a tip" : !onFocus ? `focus on "${tabbed}" and no tip` : `"${onFocus}"`]);
  await p.ev(`document.activeElement?.blur()`);

  // An answer at the control takes the tip's place: wrap on the Inbox is
  // dimmed, and a click says why, beside it.
  await p.goto(`${new URL(url).origin}/inbox`);
  await p.hoverOn(".foot-set");
  await p.hoverOn("#btn-wrap");
  await sleep(700);
  const before = await tipOn();
  await p.clickOn("#btn-wrap");
  await sleep(300);
  const after = { tip: await tipOn(), toast: await p.ev(`document.querySelector("#toasts .toast")?.textContent || null`) };
  rows.push(["tip hides when a toast anchors to the same control", !!before && !after.tip && !!after.toast,
    !before ? "no tip while resting on wrap" : after.tip ? `the tip stayed: "${after.tip}"` : !after.toast ? "no answer came" : `"${after.toast}" beside it, and the tip gave way`]);
  await p.pointerAway();

  // A menu's answer stands where its item stood: the menu has gone.
  await p.ev(`for (const d of document.querySelectorAll("#tree details.t-proj:not([open])")) d.open = true`);
  await until(`!!document.querySelector("#tree a[data-id]")`);
  await p.rightClickOn("#tree a[data-id]");
  await until(`!document.querySelector("#ctx").hidden`);
  const item = await p.ev(`(() => { const b = [...document.querySelectorAll("#ctx button")].find(b => /^Copy link/.test(b.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: [r.left, r.top, r.right, r.bottom] }; })()`);
  if (item) {
    await p.click(item.x, item.y);
    await sleep(300);
    const t = await p.ev(`(() => { const t = document.querySelector("#toasts .toast"); if (!t) return null; const r = t.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
    const gap = t ? Math.max(0, t[0] - item.r[2], item.r[0] - t[2]) + Math.max(0, t[1] - item.r[3], item.r[1] - t[3]) : null;
    rows.push(["menu Copy link → answer at the menu item's place", gap !== null && gap <= 20,
      gap === null ? "no answer came" : `${Math.round(gap)} px from where the item stood`]);
  } else rows.push(["menu Copy link → answer at the menu item's place", false, "the document's menu has no Copy link"]);
  await p.press("Escape");

  // One Undo, whatever kind: a document, then a project, and ⌘Z brings the
  // project -- the newest offer -- back.
  const d1 = await arrive();
  await p.goto(`${new URL(url).origin}/d/${d1.id}`);
  await until(`!!document.querySelector("#tree .t-proj")`);
  await p.pointerAway();
  await p.press("Delete");
  await until(`!!document.querySelector("#trees .t-ghost")`);
  const drain = await p.ev(`(g => g && getComputedStyle(g, "::after").content !== "none")(document.querySelector("#trees .t-ghost"))`);
  const pid = await p.ev(`document.querySelector("#tree .t-proj")?.dataset.pid || null`);
  if (pid) {
    await p.hoverOn(`#tree .t-proj[data-pid="${pid}"] > summary`);
    await p.clickOn(`#tree .t-proj[data-pid="${pid}"] > summary [data-away]`);
    await until(`!!document.querySelector("#tree .t-back")`);
    const backDrain = await p.ev(`(g => g && getComputedStyle(g, "::after").content !== "none" && g.getAttribute("role") === "status")(document.querySelector("#tree .t-back"))`);
    rows.push(["every ghost has a drain bar", drain && backDrain, !drain ? "the document's ghost has none" : !backDrain ? "the project's way back has none, or no status role" : "a document's and a project's"]);
    await p.press("z", { ctrl: true });
    const projBack = await until(`!!document.querySelector('#tree .t-proj[data-pid="${pid}"]') && !document.querySelector("#tree .t-back")`);
    const docGhost = await p.ev(`!!document.querySelector("#trees .t-ghost")`);
    rows.push(["remove a doc, then a project, ⌘Z → the project comes back", projBack && !docGhost,
      !projBack ? "⌘Z did not bring the project back" : docGhost ? "and the document's offer still stands beside it" : "the newest offer, and the document's had settled"]);
  } else rows.push(["remove a doc, then a project, ⌘Z → the project comes back", false, "no project row to remove"]);

  // A file sent three times goes with its three versions, and says so.
  const name = "lineage.md";
  let last = null;
  for (const n of [1, 2, 3]) last = await arrive({ name, body: `# Lineage\n\nVersion ${n}.\n` });
  await p.goto(`${new URL(url).origin}/d/${last.id}`);
  await p.pointerAway();
  await p.press("Delete");
  const three = await until(`/3 versions/.test(document.querySelector("#trees .t-ghost")?.textContent || document.querySelector("#toasts .toast")?.textContent || "")`, 30);
  rows.push(["lineage ghost says 3 versions", three, three ? "removed · 3 versions" : `it says "${await p.ev(`document.querySelector("#trees .t-ghost")?.textContent || ""`)}"`]);

  // Past the window, Removed · Show still has it, with an Undo.
  await p.pointerAway();
  await sleep(6800);
  await p.goto(`${new URL(url).origin}/inbox`);
  const shown = await until(`!!document.querySelector(".inbox-removed .t-away")`, 30);
  if (shown) {
    await p.clickOn(".inbox-removed .t-away");
    const row = await p.ev(`[...document.querySelectorAll(".inbox-removed .rm")].findIndex(r => /Lineage/.test(r.textContent) && /3 versions/.test(r.textContent))`);
    if (row >= 0) await p.clickOn(`.inbox-removed li:nth-child(${row + 1}) .t-undo`);
    const back = row >= 0 && await p.ev(`fetch("/api/docs/${last.id}").then(r => r.ok)`);
    rows.push(["remove, wait past the window, Show, Undo → back", back, row < 0 ? "the lineage is not in the list" : back ? "the document is back, all three versions" : "the Undo did not bring it back"]);
  } else rows.push(["remove, wait past the window, Show, Undo → back", false, "no Removed · Show at the Inbox's foot"]);

  // The quiet switch keeps: ⌘K > Quiet mascot, then a reload.
  await p.press("k", { ctrl: true });
  await p.type(">quiet");
  await sleep(300);
  await p.press("Enter");
  await p.reload();
  const quiet = await p.ev(`document.documentElement.dataset.mascot === "quiet"`);
  await p.ev(`localStorage.removeItem("snyvi.mascot"); delete document.documentElement.dataset.mascot; 1`);
  rows.push(["the quiet switch keeps across a reload", quiet, quiet ? "set from ⌘K, and boot.js put it back" : "not quiet after the reload"]);
  return rows;
}

/** 1.7.2: what the reader did is never lost to a refusal. Each row makes the
 *  daemon say no once (`refuse`), and reads that the page says so where the
 *  thing was done and still holds what it held: an error stays until its ✕,
 *  and news that comes meanwhile waits behind it rather than taking its place. */
async function lossRows(p, base, token, arrive, browsed) {
  const rows = [];
  const origin = await p.ev("location.origin");
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const said = () => p.ev(`(() => { const t = document.querySelector("#toasts .toast"); return t ? { text: t.querySelector(".t").textContent, alert: t.getAttribute("role") === "alert", face: !!t.querySelector(".who") } : null; })()`);
  const waiting = () => p.ev(`fetch("/api/queue").then(r => r.json()).then(q => q.length)`);

  // Mark all read, refused: the queue is still there, and the page says so.
  const a = await arrive({ name: "loss-a.md", body: "# Loss A\n\nThe document being read.\n" });
  await arrive({ name: "loss-b.md", body: "# Loss B\n\nOne that waits.\n" });
  await p.goto(`${origin}/d/${a.id}`);
  await p.pointerAway();
  await until(`!document.querySelector("#queue-bar").hidden`);
  const before = await waiting();
  await refuse(p, "POST", /^\/api\/queue\/clear$/);
  await p.clickOn("#queue-bar [data-q=clear]");
  await sleep(300);
  const t1 = await said(), bar1 = await p.ev(`!document.querySelector("#queue-bar").hidden`), w1 = await waiting();
  rows.push(["mark all read refused → queue still there", await refused(p) && !!t1?.alert && !t1.face && bar1 && w1 === before,
    !(await refused(p)) ? "the click never asked the daemon" : !t1 ? "nothing was said" : !t1.alert ? `it said "${t1.text}", as if it had worked` : t1.face ? "the error wears a face" : !bar1 ? "the queue bar went anyway" : `"${t1.text}", no face, the bar and ${w1} waiting still there`]);

  // News while the error stands: a newer version of the open document.
  await arrive({ name: "loss-a.md", body: "# Loss A\n\nThe document being read, again.\n" });
  await sleep(1500);
  const t2 = await said();
  await p.clickOn("#toasts .toast .tx");
  const news = await until(`/newer version/.test(document.querySelector("#toasts .toast .t")?.textContent || "")`, 20);
  rows.push(["error toast survives an arrival", t2?.alert && news,
    !t2?.alert ? `the arrival took its place: "${t2?.text}"` : news ? "the error stayed until its ✕, and then the arrival was said" : "the arrival was dropped, not held"]);

  // Mark all read, done: the bar that was clicked says so and holds the
  // Undo; it holds against news too, and brings them back.
  await p.clickOn("#queue-bar [data-q=clear]");
  await sleep(300);
  const barSays = () => p.ev(`document.querySelector("#queue-bar .qb.ghost .qb-next")?.textContent || null`);
  const t3 = await barSays();
  await arrive({ name: "loss-a.md", body: "# Loss A\n\nThe document being read, a third time.\n" });
  await sleep(1500);
  const t4 = await barSays();
  rows.push(["Marked read · Undo survives an arrival", /^Marked \d+ read$/.test(t3 || "") && t4 === t3,
    !t3 ? "the bar said nothing" : !/^Marked \d+ read$/.test(t3) ? `the bar said "${t3}"` : t4 !== t3 ? `the arrival took its place: "${t4}"` : `"${t3} · Undo" is still in the bar after the arrival`]);
  await p.clickOn("#queue-bar [data-q=undo]");
  const back = await until(`fetch("/api/queue").then(r => r.json()).then(q => q.length >= ${before})`, 30);
  rows.push(["and its Undo puts them back", back, back ? `${before} waiting again` : `${await waiting()} waiting, not ${before}`]);

  // Folded to its rail, the sidebar has no row to hold the ghost: the Undo is
  // in the toast, and it brings the document back to the page it was on.
  await p.wide();
  if (await p.ev(`document.documentElement.dataset.side !== "0"`)) await p.press("\\");
  const tucked = await arrive({ name: "loss-folded.md", body: "# Loss folded\n\nRemoved with the sidebar folded.\n" });
  await p.goto(`${origin}/d/${tucked.id}`);
  await p.pointerAway();
  await p.press("Delete");
  const offered = await until(`document.querySelector("#toasts .toast .t")?.textContent === "Removed" && document.querySelector("#toasts .toast .act")?.textContent === "Undo"`);
  let home = false;
  if (offered) { await p.clickOn("#toasts .toast .act"); home = await until(`document.title === ${JSON.stringify(tucked.title)}`); await sleep(600); home = home && await p.ev(`document.title === ${JSON.stringify(tucked.title)}`); }
  rows.push(["sidebar folded → Remove's Undo is in the toast, and brings it back", offered && home,
    !offered ? `the toast says "${await p.ev(`document.querySelector("#toasts .toast .t")?.textContent || "nothing"`)}"` : !home ? `the Undo landed on "${await p.ev("document.title")}"` : "Removed · Undo, and the document is open again"]);
  await p.press("\\");
  await until(`document.documentElement.dataset.side !== "0"`);

  // A removal's Undo, refused: the ghost stays, says so, and offers Retry.
  const ghost = () => p.ev(`(() => { const g = document.querySelector("#trees .t-ghost"); return g ? { text: g.querySelector(".title").textContent, btn: g.querySelector(".t-undo")?.textContent || null } : null; })()`);
  const doomed = await arrive({ name: "loss-undo.md", body: "# Loss undo\n\nRemoved, and wanted back.\n" });
  await p.goto(`${origin}/d/${doomed.id}`);
  await p.pointerAway();
  await p.press("Delete");
  // The ghost, and then the tree drawn again as the daemon's word on the
  // removal comes back: a press across that redraw is lost.
  await until(`!!document.querySelector("#trees .t-ghost .t-undo")`);
  await sleep(500);
  await refuse(p, "POST", /\/undelete$/);
  await p.clickOn("#trees .t-ghost .t-undo");
  // The refusal comes back, and only then is there a Retry to press.
  await until(`/^Could not/.test(document.querySelector("#trees .t-ghost .title")?.textContent || "")`);
  const g1 = await ghost();
  rows.push(["undo refused → ghost and Undo still there", await refused(p) && g1?.text === "Could not bring it back" && g1.btn === "Retry",
    !(await refused(p)) ? "the Undo never asked the daemon" : !g1 ? "the ghost went, and its Undo with it" : `the ghost reads "${g1.text}" with ${g1.btn ? `"${g1.btn}"` : "no button"}`]);
  await p.clickOn("#trees .t-ghost .t-undo");
  const again = await until(`document.title === ${JSON.stringify(doomed.title)}`);
  rows.push(["undo refused → Retry brings it back", again, again ? "the second ask was answered, and the document is open again" : `landed on "${await p.ev("document.title")}"`]);

  // Pin, refused: no ●, and the button still offers to pin.
  await p.pointerAway();
  await until(`!!document.querySelector("#meta [data-act=pin]")`);
  // The meta pane is drawn again as the page settles on a document; a click
  // across a redraw is lost, so the row waits for it to hold still. The rail
  // scrolls on its own; the button is brought into it, as a reader would.
  for (let last = "", i = 0; i < 20; i++) { const now = await p.ev(`document.querySelector("#meta").innerHTML`); if (now === last) break; last = now; await sleep(250); }
  await p.ev(`document.querySelector("#meta [data-act=pin]")?.scrollIntoView({ block: "center" })`);
  await refuse(p, "POST", /\/pin$/);
  await p.clickOn("#meta [data-act=pin]");
  await sleep(400);
  const pinned = await p.ev(`({ btn: document.querySelector("#meta [data-act=pin]")?.firstChild?.textContent.trim(), dot: !!document.querySelector('#trees a[data-id="${doomed.id}"] .pin'), err: document.querySelector("#toasts .toast[role=alert] .t")?.textContent || null })`);
  rows.push(["pin refused → no ●, button still reads Pin", await refused(p) && pinned.btn === "Pin" && !pinned.dot && /^Could not pin/.test(pinned.err || ""),
    !(await refused(p)) ? "the button never asked the daemon" : pinned.btn !== "Pin" ? `the button reads "${pinned.btn}"` : pinned.dot ? "the row has its ● anyway" : !pinned.err ? "nothing said it failed" : `still "Pin", no ●, and "${pinned.err}"`]);
  await p.ev(`document.querySelector("#toasts .toast .tx")?.click()`);

  // Close folder: a ghost with its Undo where the row was, and the Undo
  // opens the same folder again. Refused, the row stays and says so.
  const root = browsed.replace(/^.*\/b\//, "").replace(/\/.*$/, "");
  const open = () => p.ev(`fetch("/api/browse").then(r => r.text()).then(t => t.includes(${JSON.stringify(root)}))`);
  const rowOf = `#browse-nav .b-root[data-root="${root}"]`;
  await p.goto(`${origin}/`);
  await p.pointerAway();
  await until(`!!document.querySelector(${JSON.stringify(rowOf)})`);
  await p.hoverOn(`${rowOf} > summary`);
  await p.clickOn(`${rowOf} [data-close]`);
  await sleep(500);
  const shut = await p.ev(`(() => { const g = document.querySelector("#browse-nav .b-ghost"); return g ? g.textContent : null; })()`), closed = !(await open());
  if (shut) await p.clickOn("#browse-nav .b-ghost [data-reopen]");
  const reopened = !!shut && await until(`!!document.querySelector(${JSON.stringify(rowOf)})`) && await open();
  rows.push(["close folder → ghost; Undo reopens it", closed && !!shut && reopened,
    !closed ? "the daemon still has the folder open" : !shut ? "the row went with no ghost" : reopened ? `"${shut}", and the Undo opened the same folder again` : "the Undo did not bring the folder back"]);
  await p.pointerAway();
  await sleep(300);
  await refuse(p, "POST", /\/close$/);
  await p.hoverOn(`${rowOf} > summary`);
  await p.clickOn(`${rowOf} [data-close]`);
  await sleep(400);
  const kept = await p.ev(`!!document.querySelector(${JSON.stringify(rowOf)})`), no = await p.ev(`document.querySelector("#toasts .toast[role=alert] .t")?.textContent || null`);
  rows.push(["close folder refused → row stays, with the error", await refused(p) && kept && /^Could not close/.test(no || ""),
    !(await refused(p)) ? "the ✕ never asked the daemon" : !kept ? "the row went anyway" : !no ? "nothing said it failed" : `the row is there, and beside its ✕: "${no}"`]);
  await p.ev(`document.querySelector("#toasts .toast .tx")?.click()`);

  // The Inbox, not sent: a line that says so, with its Retry -- not Welcome,
  // which is what an empty library looks like.
  await p.goto(`${origin}/`);
  await p.pointerAway();
  await refuse(p, "GET", /^\/api\/inbox$/);
  await p.clickOn(".t-inbox");
  await sleep(500);
  const inbox = await p.ev(`({ line: document.querySelector("#doc .no-reach")?.textContent || null, welcome: (document.querySelector("#doc h1")?.textContent || "") !== "Inbox", list: !!document.querySelector("#doc ul.inbox") })`);
  if (inbox.line) await p.clickOn("#doc .no-reach [data-retry]");
  const listed = !!inbox.line && await until(`!!document.querySelector("#doc ul.inbox")`);
  rows.push(["inbox fetch refused → Retry line, not Welcome", await refused(p) && !!inbox.line && !inbox.welcome && listed,
    !(await refused(p)) ? "the Inbox never asked the daemon" : inbox.welcome ? "the page is Welcome, as if the library were empty" : !inbox.line ? "nothing says it could not load" : listed ? `"${inbox.line}", and the Retry brought the list` : "the Retry did not bring the list"]);

  // An aside's Undo, refused: the daemon still holds it closed, so the card
  // must not show it again; it shows the ghost, saying so.
  const say = async text => {
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text, sender: "bench-agent" }) });
    return (await r.json()).note;
  };
  const aside = await say("An aside whose Undo will be refused.");
  await p.goto(`${origin}/`);
  await p.pointerAway();
  await until(`document.querySelector("#note .note-now p")?.textContent === ${JSON.stringify(aside.text)}`);
  await p.hoverOn("#note .note-now");
  await sleep(300);
  await p.clickOn("#note .note-x");
  await sleep(500);   // past the first moments, when a second click is the double-click's, not an Undo
  await refuse(p, "POST", /^\/api\/notes\/restore$/);
  await p.clickOn("#note [data-note-undo]");
  await sleep(300);
  const card = await p.ev(`(() => { const g = document.querySelector("#note .note-ghost"); return g ? g.textContent : document.querySelector("#note .note-now p")?.textContent || null; })()`);
  const still = (await (await fetch(`${base}/api/notes`)).json()).notes.find(n => n.id === aside.id)?.dismissed === true;
  rows.push(["aside undo refused → card still shows the ghost", await refused(p) && /Could not bring it back/.test(card || "") && still,
    !(await refused(p)) ? "the Undo never asked the daemon" : !/Could not bring it back/.test(card || "") ? `the card reads "${card}"` : "the ghost says so, and the daemon still has it closed"]);
  await p.pointerAway();
  return rows;
}

/** 1.7.2: a keyboard is never left on nothing. A menu gives the focus back
 *  to the row it came from, however it was opened and however it closed. */
async function reachRows(p, base, token, arrive) {
  const rows = [];
  const origin = await p.ev("location.origin");
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const d = await arrive({ name: "reach.md", body: "# Reach\n\nA row to open a menu on.\n" });
  const row = `#trees a[data-id="${d.id}"]`;
  await p.goto(`${origin}/`);
  await p.pointerAway();
  await until(`!!document.querySelector(${JSON.stringify(row)})`);

  // By key: ⇧F10 on the row, `p` to Pin, Enter. The focus is on the row again.
  await p.ev(`document.querySelector(${JSON.stringify(row)}).focus()`);
  await p.press("⇧F10", { raw: true });
  const opened = await until(`!document.querySelector("#ctx")?.hidden`, 20);
  await p.press("p", { raw: true });
  await p.press("Enter");
  await sleep(400);
  const back = await p.ui("at", row);
  rows.push(["menu item by Enter → focus on the row it was opened from", opened && back,
    !opened ? "⇧F10 opened no menu" : back ? "Pin ran, and the focus is on the row" : `the focus is on ${JSON.stringify(await p.ui("focus"))}`]);
  // Unpinned again, the same way, so the library is as it was.
  await p.press("⇧F10", { raw: true }); await p.press("u", { raw: true }); await p.press("Enter"); await sleep(300);

  // By pointer: a right-click, then Esc. The focus is on the row.
  await p.ev(`document.activeElement?.blur()`);
  await p.rightClickOn(row);
  const menu = await until(`!document.querySelector("#ctx")?.hidden`, 20);
  await p.press("Escape");
  await sleep(200);
  const esc = await p.ui("at", row);
  rows.push(["Esc after right-click → focus back", menu && esc,
    !menu ? "the right-click opened no menu" : esc ? "the menu went, and the focus is on the row that was right-clicked" : `the focus is on ${JSON.stringify(await p.ui("focus"))}`]);
  await p.pointerAway();

  // Del: the removal leaves the hand on its Undo, and Enter takes it back.
  const del = await arrive({ name: "reach-del.md", body: "# Reach del\n\nRemoved by a key.\n" });
  await p.goto(`${origin}/d/${del.id}`);
  await p.pointerAway();
  await p.press("Delete");
  await sleep(500);
  const onUndo = await p.ui("at", ".t-gone .t-undo");
  if (onUndo) await p.press("Enter");
  const undone = onUndo && await until(`document.title === ${JSON.stringify(del.title)}`);
  rows.push(["Del on a row → focus on Undo; Enter brings it back", !!undone,
    !onUndo ? `the focus is on ${JSON.stringify(await p.ui("focus"))}, not the Undo` : undone ? "the hand was on the Undo, and Enter brought the document back" : "Enter on the Undo did not bring it back"]);

  // An older aside in the trail is reached by Tab and opened by Enter.
  const say = async (text, about) => {
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text, sender: "bench-agent", ...(about ? { about } : {}) }) });
    return (await r.json()).note;
  };
  await say("The first older aside, about the reach document.", d.id);
  await say("The second older aside, about it too.", d.id);
  const now = await say("The newest aside, on the card.");
  await p.goto(`${origin}/`);
  await p.pointerAway();
  await until(`document.querySelector("#note .note-now p")?.textContent === ${JSON.stringify(now.text)}`);
  await p.ev(`document.querySelector("#note .note-now").focus()`);
  await sleep(500);
  await p.press("⇧Tab", { raw: true });   // Close all
  await p.press("⇧Tab", { raw: true });   // the aside nearest the card, the first one sent
  const on = await p.ev(`document.activeElement?.closest(".note-trail li")?.querySelector(".note-t")?.textContent || null`);
  await p.press("Enter");
  const went = await until(`document.title === ${JSON.stringify(d.title)}`);
  rows.push(["Tab reaches an older aside in the trail; Enter opens it", /first older aside/.test(on || "") && went,
    !on ? `Tab went to ${JSON.stringify(await p.ui("focus"))}, not the trail` : !/first older aside/.test(on) ? `Tab reached "${on}"` : went ? "reached, and Enter opened the document it is about" : `Enter left the page on "${await p.ev("document.title")}"`]);
  await p.pointerAway();
  return rows;
}

/** Every document and every file has a ✕ in its head, and it goes back to
 *  the screen the reading began on: the Inbox, past every document `j` read
 *  on to; a folder's contents; and the Inbox for a deep link, which has no
 *  screen behind it. Esc does the same, once nothing is over the page. The
 *  desk's own way back is deskRows' to read, since a tab has no desk. */
async function backRows(p, browsed) {
  const rows = [];
  const origin = await p.ev("location.origin");
  const where = () => p.ev("location.pathname");
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const bar = () => p.ev(`(() => { const o = document.querySelector("#chrome .over"), x = o.querySelector(".over-x"), r = x.getBoundingClientRect();
    return { shown: !o.hidden && r.width > 0, title: x.dataset.tip || "" }; })()`);

  await p.goto(`${origin}/inbox`);
  await p.pointerAway();
  const onInbox = await bar();
  // j walks the rows a reader can see: the projects are opened, as a reader
  // would, and the Inbox entry opened is the one highest in the tree, so two
  // j's have somewhere to go whatever the sections before this one sent.
  await p.ev(`for (const d of document.querySelectorAll("#tree details.t-proj:not([open])")) d.open = true`);
  await until(`document.querySelectorAll("#tree a[data-id]").length >= 3`);
  const top = await p.ev(`[...document.querySelectorAll("#tree a[data-id]")].map(a => a.dataset.id).find(id => document.querySelector('.inbox a[data-id="' + id + '"]')) || ""`);
  await p.clickOn(top ? `.inbox a[data-id="${top}"]` : ".inbox a[data-id]");
  await until(`location.pathname.startsWith("/d/")`);
  const first = await where(), b1 = await bar();
  await p.press("j"); await until(`location.pathname !== ${JSON.stringify(first)}`);
  const second = await where();
  await p.press("j"); await until(`location.pathname !== ${JSON.stringify(second)}`);
  const read = new Set([first, second, await where()]).size;
  rows.push(["every document has the ✕", !onInbox.shown && b1.shown && /Back to Inbox/.test(b1.title),
    onInbox.shown ? "the Inbox has one too" : !b1.shown ? "a document opened from the Inbox has none" : `its tip reads "${b1.title}"`]);
  await p.clickOn("#chrome .over-x");
  const home = await until(`location.pathname === "/inbox" && !!document.querySelector(".inbox")`);
  rows.push(["and it goes back past what j read", home && read === 3,
    read !== 3 ? `j read ${read} documents, not 3` : home ? "three documents read, one click, the Inbox" : `landed on ${await where()}`]);

  const root = browsed.replace(/^.*\/b\//, "/b/").replace(/\/$/, "");
  await p.goto(browsed);
  await p.pointerAway();
  await p.clickOn(`.inbox a[data-path="notes.md"]`);
  await until(`location.pathname.endsWith("/notes.md")`);
  const b2 = await bar();
  await p.clickOn("#chrome .over-x");
  const folder = await until(`location.pathname === ${JSON.stringify(root)}`);
  rows.push(["a file goes back to its folder", b2.shown && folder,
    !b2.shown ? "the file has no ✕" : folder ? `back on the folder's contents, "${b2.title}"` : `landed on ${await where()}`]);

  await p.goto(`${origin}${first}`);
  await p.pointerAway();
  await p.clickOn("#chrome .over-x");
  const deep = await until(`location.pathname === "/inbox"`);
  rows.push(["a deep link goes to the Inbox", deep, deep ? "no screen behind it, so the Inbox" : `landed on ${await where()}`]);

  await p.goto(`${origin}${first}`);
  await p.pointerAway();
  await p.press("k", { ctrl: true });
  const pal = await until(`!document.querySelector("#palette").hidden`, 10);
  await p.press("Escape"); await sleep(200);
  const stayed = await p.ev(`document.querySelector("#palette").hidden && location.pathname === ${JSON.stringify(first)}`);
  await p.press("Escape");
  const esc = await until(`location.pathname === "/inbox"`);
  rows.push(["Esc takes one thing down at a time", pal && stayed && esc,
    !pal ? "⌃K opened no palette" : !stayed ? `the first Esc left the page for ${await where()}` : esc ? "the first Esc shut the palette, the second went to the Inbox" : "the second Esc stayed on the document"]);
  return rows;
}

/** 1.23: back and forward. ‹ › sit at the head's left on every view,
 *  dimmed at either end and never hidden; ‹ goes back to the document read
 *  before, where it was left, › comes forward again; a right-click lists
 *  where the window has been, the one on screen marked; a mouse's back
 *  button is one step. */
async function navRows(p) {
  const rows = [];
  const origin = await p.ev("location.origin");
  const where = () => p.ev("location.pathname");
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const btns = () => p.ev(`[...document.querySelectorAll("#chrome .nv-b")].map(b => { const r = b.getBoundingClientRect(); return { off: b.getAttribute("aria-disabled") === "true", tip: b.dataset.tip, w: Math.round(r.width), x: Math.round(r.left) }; })`);

  await p.goto(`${origin}/inbox`);
  await p.pointerAway();
  // The tips and the list are nav.js's, fetched once the page is idle.
  await until(`!!document.querySelector("#chrome .nv-b").dataset.tipSub`);
  // The Inbox entry highest in the tree, as the ✕'s rows pick it, so `j`
  // has a document after it to go to.
  await p.ev(`for (const d of document.querySelectorAll("#tree details.t-proj:not([open])")) d.open = true`);
  await until(`document.querySelectorAll("#tree a[data-id]").length >= 3`);
  const pick = await p.ev(`[...document.querySelectorAll("#tree a[data-id]")].map(a => a.dataset.id).find(id => document.querySelector('.inbox a[data-id="' + id + '"]')) || ""`);
  const inbox = await btns();
  await p.clickOn(pick ? `.inbox a[data-id="${pick}"]` : ".inbox a[data-id]");
  await until(`location.pathname.startsWith("/d/")`);
  const a = await where();
  await until(`document.title !== "snyvi"`);
  const aTitle = await p.ev("document.title");
  await p.ev(`document.querySelector("#main").scrollTop = 240`);
  await sleep(400);
  const aTop = await p.ev(`document.querySelector("#main").scrollTop`);
  await p.press("j");
  await until(`location.pathname !== ${JSON.stringify(a)}`);
  const b = await where();
  await sleep(300);
  const onB = await btns();
  rows.push(["‹ › are on every view, and only dimmed at the ends", inbox.length === 2 && onB.length === 2 && !onB[0].off && onB[1].off && inbox[0].x === onB[0].x && inbox[0].w === onB[0].w,
    inbox.length !== 2 ? "the Inbox has no ‹ ›" : onB[0].off ? "‹ is dimmed with a document behind it" : !onB[1].off ? "› is lit with nothing ahead" : inbox[0].x !== onB[0].x ? `‹ moved from x=${inbox[0].x} to x=${onB[0].x}` : "‹ lit, › dimmed, in the same place as on the Inbox"]);
  rows.push(["‹ names where it goes", onB[0].tip === `Back to ${aTitle}`, `"${onB[0].tip}"`]);

  await p.clickOn('#chrome .nv-b[data-step="-1"]');
  const backA = await until(`location.pathname === ${JSON.stringify(a)}`);
  await sleep(400);
  const top = await p.ev(`document.querySelector("#main").scrollTop`);
  rows.push(["‹ goes back to the document before, where it was left", backA && Math.abs(top - aTop) <= 40,
    !backA ? `landed on ${await where()}` : `scrolled to ${top}, left at ${aTop}`]);
  const onA = await btns();
  await p.clickOn('#chrome .nv-b[data-step="1"]');
  const fwd = await until(`location.pathname === ${JSON.stringify(b)}`);
  rows.push(["› comes forward again", !onA[1].off && fwd, onA[1].off ? "› is dimmed after a step back" : fwd ? "lit after the step back, and one step forward" : `landed on ${await where()}`]);

  await p.rightClickOn('#chrome .nv-b[data-step="-1"]');
  const listed = await until(`!document.querySelector("#ctx")?.hidden`, 20);
  const list = listed ? await p.ev(`[...document.querySelectorAll("#ctx button")].map(b => b.textContent)`) : [];
  rows.push(["a right-click lists where the window has been", listed && list.length >= 3 && /here$/.test(list[0]),
    !listed ? "no list" : `${list.length} places: ${list.join(" · ")}`]);
  await p.press("Escape");

  await p.ev(`dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true }))`);
  const side = await until(`location.pathname === ${JSON.stringify(a)}`);
  rows.push(["a mouse's back button is one step", side, side ? "back on the document before" : `landed on ${await where()}`]);
  return rows;
}

/** An aside can be closed: the ✕ on its card, or Esc on it, and the card
 *  stands as one line holding the Undo for 6 s, as a removed document's row
 *  does. The daemon only flags it, so Undo is real, and a closed one is
 *  closed in every page. The next aside takes the card once the offer ends. */
async function asideRows(p, base, token) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const say = async text => {
    const r = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, sender: "bench-agent" }),
    });
    if (!r.ok) throw new Error(`aside: ${r.status} ${await r.text()}`);
    return (await r.json()).note;
  };
  const daemon = async () => (await (await fetch(`${base}/api/notes`)).json()).notes;
  const card = () => p.ev(`(() => { const n = document.querySelector("#note"); if (n.hidden) return null;
    const g = n.querySelector(".note-ghost"), c = n.querySelector(".note-now p");
    return { ghost: g ? g.textContent : null, text: c ? c.textContent : null }; })()`);

  const older = await say("An older aside, for the trail.");
  const newer = await say("A newer aside, to close.");
  await p.goto(`${base}/`);
  await p.pointerAway();
  await until(`!!document.querySelector("#note .note-now")`);
  await p.hoverOn("#note .note-now");
  await sleep(300);
  await p.clickOn("#note .note-x");
  await sleep(300);
  const c1 = await card(), d1 = await daemon();
  const flagged = d1.find(n => n.id === newer.id)?.dismissed === true;
  rows.push(["the ✕ closes the aside, and Undo stands in its place", !!c1 && /Aside closed/.test(c1.ghost || "") && flagged,
    !c1 ? "the card went with nothing in its place" : !c1.ghost ? `the card still reads "${c1.text}"` : !flagged ? "the daemon was not told" : "one line, \"Aside closed · Undo\", and the daemon keeps it flagged"]);

  await p.clickOn("#note [data-note-undo]");
  await sleep(300);
  const c2 = await card(), d2 = await daemon();
  const back = c2?.text === newer.text && d2.find(n => n.id === newer.id)?.dismissed === false;
  rows.push(["Undo puts it back", back, back ? "the same aside on the card, and unflagged in the daemon" : `the card reads ${JSON.stringify(c2)}`]);

  await p.ev(`document.querySelector("#note .note-now").focus()`);
  const was = await p.ev("location.pathname");
  await p.press("Escape");
  await sleep(300);
  const c3 = await card(), stayed = await p.ev(`location.pathname === ${JSON.stringify(was)}`);
  const onUndo = await p.ev(`!!document.activeElement?.matches("#note [data-note-undo]")`);
  rows.push(["Esc on the card closes it, and only that", /Aside closed/.test(c3?.ghost || "") && stayed && onUndo,
    !stayed ? `Esc also left the page for ${await p.ev("location.pathname")}` : !c3?.ghost ? "Esc did not close it" : onUndo ? "closed, the page stayed, and the hand is on Undo" : "closed, but the focus went back to the page's start"]);

  await p.pointerAway();
  await p.ev(`document.activeElement?.blur()`);
  const next = await until(`document.querySelector("#note .note-now p")?.textContent === ${JSON.stringify(older.text)}`, 90);
  rows.push(["when the offer ends, the next aside has the card", next, next ? "the older aside, after 6 s" : `the card reads ${JSON.stringify(await card())}`]);

  await say("One more, so there is a trail to close.");
  await until(`!!document.querySelector("#note .note-all")`);
  await p.hoverOn("#note .note-now");
  await sleep(500);
  await p.clickOn("#note [data-note-all]");
  await sleep(300);
  const c4 = await card();
  await p.pointerAway();
  const empty = await until(`document.querySelector("#note").hidden`, 70);
  const allFlagged = (await daemon()).every(n => n.dismissed);
  rows.push(["Close all, from the trail", /Asides closed/.test(c4?.ghost || "") && empty && allFlagged,
    !c4?.ghost ? "no Undo stood after Close all" : !empty ? "the card is still there after the offer" : !allFlagged ? "the daemon still has one open" : "one Undo for all of them, then no card at all"]);

  const fresh = await say("A new aside after closing them all.");
  const shows = await until(`document.querySelector("#note .note-now p")?.textContent === ${JSON.stringify(fresh.text)}`);
  rows.push(["a new aside still shows", shows, shows ? "closing is not muting" : `the card reads ${JSON.stringify(await card())}`]);
  // Read, the way a reader does: an aside left waiting keeps the logo
  // blinking, and the rows after this one count every animation that runs.
  await p.hoverOn("#note .note-now");
  await sleep(1000);
  await p.pointerAway();
  return rows;
}

/** Open in file manager where a folder is in view, and no Open terminal
 *  here anywhere (retired in 1.16: a desk is the terminal): the document's,
 *  the browsed folder's, and the folder row's menu. The daemon resolves the ids
 *  itself and hands the folder to the desktop's opener -- stubbed for the
 *  probe, which reads back what it was handed. */
async function revealRows(p, browsed, folder, tmp) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const opened = join(tmp, "opened");
  const origin = await p.ev("location.origin");
  await p.goto(`${origin}/inbox`);
  await p.clickOn(".inbox a[data-id]");
  await until(`location.pathname.startsWith("/d/")`);
  const inDoc = await until(`!!document.querySelector('#meta [data-act="reveal"]')`, 20);
  const termDoc = await p.ev(`!!document.querySelector('#meta [data-act="terminal"]')`);
  await p.goto(`${browsed.replace(/\/$/, "")}/notes.md`);
  const inBrowse = await until(`!!document.querySelector('#meta [data-act="reveal"]')`, 20);
  const termBrowse = await p.ev(`!!document.querySelector('#meta [data-act="terminal"]')`);
  rows.push(["Open in file manager, and no Open terminal here", inDoc && inBrowse && !termDoc && !termBrowse,
    !inDoc ? "a document's meta has none" : !inBrowse ? "a browsed file's meta has none" : termDoc || termBrowse ? "Open terminal here is still drawn" : "in a document's meta and a browsed file's, alone"]);

  if (process.platform === "win32") { rows.push(["the folder a file sits in is opened", true, "not clicked on Windows, where Explorer itself would open"]); return rows; }
  if (existsSync(opened)) unlinkSync(opened);
  await p.clickOn('#meta [data-act="reveal"]');
  for (let i = 0; i < 30 && !existsSync(opened); i++) await sleep(100);
  const handed = existsSync(opened) ? readFileSync(opened, "utf8").trim() : null;
  const said = await p.ev(`[...document.querySelectorAll("#toasts .toast")].map(t => t.textContent).join(" | ")`);
  const want = realpathSync(folder);
  const noDisplay = !handed && /no desktop session/.test(said);
  rows.push(["the folder a file sits in is opened", handed === want || noDisplay,
    handed === want ? `the opener was handed ${handed}` : noDisplay ? "no display in this run, and the daemon said so" : handed ? `the opener was handed ${handed}, not ${want}` : `nothing was opened; the page said "${said}"`]);
  return rows;
}

/** #91: a folder Ctrl-clicked in what is being read opens on snyvi's folder
 *  page, never the file manager; a ▸ row there opens the folder it names, ▴ ..
 *  goes back up, and an address ending in `/` is that folder's listing. In a
 *  tab of its own, with the capability Ctrl-click asks the daemon with. */
async function folderRows(cdp, base, browsed) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const root = browsed.replace(/\/$/, ""), id = root.split("/").pop();
  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const mouse = async (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
  const ctrl = type => cdp.send("Input.dispatchKeyEvent", { type, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: type === "keyUp" ? 0 : 2 }, sessionId);
  const listed = `[...document.querySelectorAll("#doc .inbox .title")].map(t => t.textContent).join(" · ")`;
  const at = path => `location.pathname === ${JSON.stringify(path)}`;
  const said = () => q.ev(`[...document.querySelectorAll("#toasts .toast")].map(t => t.textContent).join(" | ")`);
  try {
    await q.goto(`${root}#cap=${cap}`);
    await until(`/▸ sub/.test(${listed})`);
    await q.clickOn(`#doc .inbox a[data-path="sub/"]`);
    const into = await until(`${at(`/b/${id}/sub/`)} && /inner/.test(${listed})`);
    const list = await q.ev(listed);
    rows.push(["a ▸ folder on the folder page opens it", into && /▴ \.\./.test(list),
      into ? `/b/…/sub/: ${list}` : `at ${await q.ev("location.pathname")}, and the page said "${await said()}"`]);
    await q.clickOn(`#doc .inbox a[data-path=""]`);
    const up = await until(`${at(`/b/${id}`)} && /▸ sub/.test(${listed})`);
    rows.push(["and ▴ .. goes back up", up, up ? "the folder's own listing again" : `at ${await q.ev("location.pathname")}`]);

    await q.goto(`${root}/sub/inner/`);
    const loaded = await until(`/deep\\.md/.test(${listed})`);
    rows.push(["an address ending in / is that folder's listing", loaded, loaded ? await q.ev(listed) : `the page shows "${await q.ev(listed)}"`]);

    // A path in a file being read, Ctrl-clicked: `inner/` is a folder beside it.
    await q.goto(`${root}/sub/where.md`);
    await until(`/inner\\//.test(document.querySelector("#doc .prose")?.textContent || "")`);
    const word = await q.ev(`(() => { const p = [...document.querySelectorAll("#doc .prose p")].find(e => e.textContent.includes("inner/"));
      if (!p) return null; const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n, off = p.textContent.indexOf("inner/") + 2;
      while ((n = w.nextNode()) && off >= n.length) off -= n.length; const r = document.createRange(); r.setStart(n, off); r.setEnd(n, off + 1);
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (word) {
      await ctrl("rawKeyDown");
      await sleep(300);
      await mouse("mouseMoved", word.x, word.y, { modifiers: 2 });
      const lined = await until(`!!document.querySelector(".path-ul i")`, 30);
      for (const type of ["mousePressed", "mouseReleased"]) await mouse(type, word.x, word.y, { button: "left", clickCount: 1, modifiers: 2 });
      await ctrl("keyUp");
      const opened = await until(`${at(`/b/${id}/sub/inner/`)} && /deep\\.md/.test(${listed})`);
      const toast = await said();
      rows.push(["a Ctrl-clicked folder opens on the folder page, not the file manager", lined && opened && !/file manager/.test(toast),
        !lined ? "Ctrl never underlined inner/" : !opened ? `at ${await q.ev("location.pathname")}, and the page said "${toast}"` : /file manager/.test(toast) ? `it still says "${toast}"` : "inner/ listed in snyvi, with deep.md in it"]);
    } else rows.push(["a Ctrl-clicked folder opens on the folder page, not the file manager", false, "inner/ is not in the file as read"]);
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** 0.15: a link into a browsed folder lands where it points, the way a link
 *  into a document does. The browser's own fragment scroll is no use for
 *  either: it aims at blocks that are still content-visibility placeholders. */
async function browseRows(p, browsed) {
  const rows = [];
  const file = `${browsed}/notes.md`;
  await p.goto(file);
  await p.pointerAway();
  // A heading well down the page, taken from the page itself rather than
  // guessed from the fixture's wording.
  const id = await p.ev(`(() => { const a = [...document.querySelectorAll("#toc a")]; return a[Math.floor(a.length * 0.7)].getAttribute("href").slice(1); })()`);
  // Away first: a navigation that changes only the fragment is not a load,
  // and what is being read here is what a link from outside the page does.
  await p.goto(browsed);
  await p.goto(`${file}#${id}`);
  await sleep(400);
  const at = await p.ui("headingOffset", id);
  const scrolled = await p.ev(`Math.round(document.querySelector("#main").scrollTop)`);
  rows.push(["a browsed file opens at a section", within(at, 0, 28) && scrolled > 100,
    at === null ? "the heading is not in the page" : `the heading is ${at} px in, ${scrolled} px down the file`]);

  await p.goto(`${browsed}/code.rs#L300`);
  await sleep(400);
  const line = await p.ev(`(() => { const m = [...document.querySelectorAll("pre.code .ln.at")];
    if (!m.length) return { n: 0 };
    const r = m[0].getBoundingClientRect(), main = document.querySelector("#main").getBoundingClientRect();
    // The number is a CSS counter, so what the span holds is the code on it.
    return { n: m.length, text: m[0].textContent.trim(), inView: r.top >= main.top && r.bottom <= main.bottom }; })()`);
  const right = /line_300\b/.test(line.text || "");
  rows.push(["and at a line", line.n === 1 && right && line.inView,
    !line.n ? "no line was marked" : line.n !== 1 ? `${line.n} lines marked` : !right ? `the marked line reads "${line.text}"` : !line.inView ? "line 300 is marked but off the screen" : "line 300 marked and on the screen"]);
  return rows;
}

/** 1.0.2: a link inside a document, and where following one goes. The viewer
 *  is a page in a window with no address bar and no Back button of its own --
 *  Back is the page's own key handler, and a page from somewhere else does not
 *  have it -- so a click on a link to github.com used to leave the reader
 *  there with nothing to come home by but the tray, and `[notes](./notes.md)`
 *  in a sent document resolved against `/d/<id>` and landed on a bare "Not
 *  found". The renderer sorts the links at receive time and the page acts on
 *  what it wrote, which is what these rows read.
 *
 *  The web is read as an attribute rather than clicked: a click on it is a
 *  second tab, and what the native window does with one is `stays_home`'s to
 *  say, under test in src/bin/app.rs. Everything that stays same-origin is
 *  clicked for real, because a handler the real event never reaches is the
 *  fault being looked for. */
async function docLinkRows(p, base, token, otherId) {
  const rows = [];
  const body = [
    "# Links that go somewhere",
    "",
    "[the web](https://github.com/snymrova/snyvi)",
    "",
    "[mail](mailto:a@b.c)",
    "",
    "[a section](#links-that-go-somewhere)",
    "",
    "[a file beside it](./notes.md)",
    "",
    `[another document](/d/${otherId})`,
    "",
  ].join("\n");
  const r = await fetch(`${base}/api/docs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: body, title: "Links that go somewhere", lang: "md" }),
  });
  if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
  const { id } = await r.json();
  const url = `${base}/d/${id}`;
  await p.goto(url);
  await p.pointerAway();

  // What the renderer wrote on each link, and what the stylesheet hangs on it.
  const read = sel => p.ev(`(() => { const a = document.querySelector(${JSON.stringify(sel)});
    if (!a) return null;
    return { target: a.getAttribute("target"), rel: a.getAttribute("rel"),
             ext: a.dataset.ext !== undefined,
             mark: getComputedStyle(a, "::after").content }; })()`);

  const web = await read(`.prose a[href^="https://github.com"]`);
  const webOk = web && web.target === "_blank" && /noopener/.test(web.rel || "") && web.ext && /↗/.test(web.mark || "");
  rows.push(["the web opens away from the viewer", !!webOk,
    !web ? "the link is not in the page"
      : webOk ? "target=_blank, rel=noopener, and the ↗ says so before it is followed"
      : `target=${JSON.stringify(web.target)} rel=${JSON.stringify(web.rel)} data-ext=${web.ext} mark=${web.mark}`]);

  // A scheme the desktop answers for is outbound, but a browser should not
  // open a blank tab for it.
  const mail = await read(`.prose a[href^="mailto:"]`);
  const mailOk = mail && mail.ext && mail.target === null;
  rows.push(["and mailto: leaves without a tab", !!mailOk,
    !mail ? "the link is not in the page"
      : mailOk ? "marked as leaving, with no target for a browser to act on"
      : `target=${JSON.stringify(mail.target)} data-ext=${mail.ext}`]);

  // A fragment and a relative path stay here, and are left unmarked: the ↗
  // would be a promise of a tab that never opens.
  const frag = await read(`.prose a[href="#links-that-go-somewhere"]`);
  const rel = await read(`.prose a[href="./notes.md"]`);
  const quiet = frag && rel && !frag.ext && !rel.ext && frag.target === null && rel.target === null
    && !/↗/.test(frag.mark || "") && !/↗/.test(rel.mark || "");
  rows.push(["a section and a relative path stay", !!quiet,
    !frag || !rel ? "one of the two links is not in the page"
      : quiet ? "neither is marked, and neither wears the ↗"
      : `#section: ext=${frag?.ext} mark=${frag?.mark}; ./notes.md: ext=${rel?.ext} mark=${rel?.mark}`]);

  // The regression itself: a relative link in a sent document resolves against
  // `/d/<id>`, which is not a page this viewer has. It used to land on "Not
  // found" with no way back. A real click, and the document has to still be here.
  await p.ev(`document.querySelectorAll("#toasts .toast").forEach(t => t.remove()); window.__stay = 1`);
  await p.clickOn(`.prose a[href="./notes.md"]`);
  await sleep(300);
  const said = await p.ev(`(() => { const t = document.querySelector("#toasts .toast");
    return { title: t ? t.querySelector(".t").textContent.trim() : null,
             sub: t ? (t.querySelector(".s")?.textContent.trim() ?? null) : null,
             act: t ? (t.querySelector("button.act")?.textContent.trim() ?? null) : null,
             path: location.pathname, stay: window.__stay === 1 }; })()`);
  const toldOk = said.title === "Not a page in snyvi" && said.sub === "./notes.md" && said.act === "Open anyway"
    && said.path === `/d/${id}` && said.stay;
  rows.push(["a path that is not a page says so", toldOk,
    !said.title ? `nothing was said, and the page is at ${said.path}`
      : toldOk ? `"${said.title}" — ${said.sub}, with "${said.act}" for the reader who meant it, and the document still open`
      : `said "${said.title}" / ${JSON.stringify(said.sub)} / ${JSON.stringify(said.act)}; the page is at ${said.path}${said.stay ? "" : " after a reload"}`]);

  // And a link that is a page here is a turn of the page, not a load.
  await p.ev(`document.querySelectorAll("#toasts .toast").forEach(t => t.remove()); window.__stay = 1`);
  await p.clickOn(`.prose a[href="/d/${otherId}"]`);
  await sleep(400);
  const went = await p.ev(`({ path: location.pathname, stay: window.__stay === 1, title: document.title })`);
  const wentOk = went.path === `/d/${otherId}` && went.stay;
  rows.push(["a link to another document turns the page", wentOk,
    wentOk ? `the viewer shows "${went.title}" without a page load`
      : `the page is at ${went.path}${went.stay ? "" : ", reloaded to get there"}`]);
  return rows;
}

/** 0.15: a page holds one connection open for its event stream, and a browser
 *  allows six to a host. A page that does not give the connection back on the
 *  way out spends one of the six for good: eight page loads left eight streams
 *  behind, the pool ran out at six, and the next page did not load for 25
 *  seconds -- which is what this harness reports as a document being held
 *  open, and how the fault was found. */
async function socketRows(p, url, base, browsed) {
  const rows = [];
  const health = async () => (await (await fetch(`${base}/api/health`)).json());
  // Eight loads in a row, alternating so none of them is a same-document
  // navigation. Each one throws here if it does not load, which is the first
  // half of the row; the daemon's count is the second.
  const loads = [url, `${browsed}/notes.md`, browsed, `${browsed}/code.rs`];
  for (let i = 0; i < 8; i++) await p.goto(loads[i % loads.length]);
  await sleep(600);
  const { streams } = await health();
  // One is the page that is open; two when the one before it is still in the
  // back/forward cache with its stream, which the browser may keep a moment.
  rows.push(["eight loads, and the streams left behind", streams <= 2,
    `the daemon holds ${streams} event stream${streams === 1 ? "" : "s"} after eight page loads, not eight`]);
  return rows;
}

/** 0.15: with a window running, a link belongs in it. The window's page says
 *  so on its event stream, which is what makes the answer as live as the
 *  window -- and what an agent is told changes with it, because a url to click
 *  through a browser is the wrong answer when the viewer is already open. */
async function windowRows(p, url, base, mcpSend) {
  const rows = [];
  const window_up = async () => (await (await fetch(`${base}/api/health`)).json()).window;
  const until = async (want, tries = 40) => { for (let i = 0; i < tries; i++) { if (await window_up() === want) return true; await sleep(100); } return false; };

  await p.goto(url);
  const tab = await window_up();
  rows.push(["a browser tab is not a window", tab === false, tab ? "the daemon thinks a tab is a window" : "the daemon says there is no window"]);

  const said = mcpSend("Sent with no window");
  const hasUrl = said.includes(`${base}/d/`);
  rows.push(["what the agent is told, with none", hasUrl, hasUrl ? "the reply carries the link to give the user" : `the reply is "${said.slice(0, 60)}"`]);

  await p.goto(`${base}/?window=1`);
  const marked = await until(true);
  const addr = await p.ev(`location.search + "|" + location.pathname`);
  rows.push(["the window says it is one", marked && addr === "|/",
    !marked ? "the daemon still says there is no window" : addr !== "|/" ? `the mark stayed in the address: "${addr}"` : "the daemon knows, and the mark is out of the address"]);

  await p.goto(url);
  const kept = await window_up();
  rows.push(["and still, once it has navigated", kept === true, kept ? "a window that opened a document is still a window" : "the window was forgotten on the first navigation"]);

  const inWindow = mcpSend("Sent with a window");
  const quiet = !inWindow.includes("http");
  rows.push(["what the agent is told, with one", quiet && /snyvi/.test(inWindow), quiet ? "the reply says it is waiting in snyvi, with no link to a browser" : `the reply still hands out a url: "${inWindow.slice(0, 70)}"`]);

  await p.goto("about:blank");
  const forgotten = await until(false);
  rows.push(["and not once the window is gone", forgotten, forgotten ? "the stream ended and the daemon knows at once" : "the daemon still thinks a window is up"]);
  await p.goto(url);
  return rows;
}

/** 0.20: which link an agent is given, and where `snyvi app` sends it. With
 *  no window up, the tool answered with `http://…/d/…` whatever was installed,
 *  and a click on it opened a browser beside a window that was a click away.
 *  Now the answer depends on what is installed: where a window executable is,
 *  `snyvi://d/<id>` too, which the desktop hands to it. These rows decide
 *  that themselves -- a stub `snyvi-app` beside the daemon's copy, written
 *  and removed -- and the stub writes down what it was handed, which is how
 *  `snyvi app <link>` is read without a display: the address the link stands
 *  for, marked as a window when it becomes one and bare when it is handed to
 *  one that is up. */
async function linkRows(p, url, base, env, tmp, token, stub, mcpSend) {
  const rows = [];
  const health = async () => (await (await fetch(`${base}/api/health`)).json());
  const until = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(100); } return false; };
  const post = async title => {
    const r = await fetch(`${base}/api/docs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: `# ${title}\n\nFor the link rows.\n`, title, lang: "md" }),
    });
    if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
    return r.json();
  };
  // The stub stands in for the window: it writes its arguments down and
  // exits, so what `snyvi app` would have opened a window on can be read.
  const argv = join(tmp, "argv");
  const handed = async () => { if (!await until(() => existsSync(argv), 30)) return null; const a = readFileSync(argv, "utf8").trim(); unlinkSync(argv); return a; };
  // A display it never uses: `snyvi app` opens a browser where there is none,
  // and the question here is what it hands the window, not whether there is one.
  const shown = { ...env, DISPLAY: process.env.DISPLAY ?? ":99" };
  const app = args => execFileSync(BIN, ["app", ...args], { env: shown, cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // The tab is still a window from the rows before: the page keeps the mark
  // in session storage for the tab's life, which is the design. Taken out
  // here; the row that opens a window puts it back, and the rows after
  // these expect it there.
  await p.ev(`sessionStorage.removeItem("snyvi.window")`);
  await p.goto(url);
  if (!await until(async () => (await health()).window === false)) throw new Error("the tab is still a window with the mark taken out");
  const bare = await post("With nothing to open it in");
  const bareSaid = mcpSend("Told with nothing to open it in");
  const none = bare.app_url == null && !/snyvi:\/\//.test(bareSaid) && bareSaid.includes(`${base}/d/`);
  rows.push(["no window executable, no app link", none,
    none ? "the send answers with the http link alone, and so is the agent told" : `app_url: ${JSON.stringify(bare.app_url)}; the agent is told "${bareSaid.slice(0, 80)}"`]);

  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\n`, { mode: 0o755 });
  const linked = await post("With a window executable installed");
  const linkedSaid = mcpSend("Told with a window executable installed");
  const want = `snyvi://d/${linked.id}`;
  const both = linkedSaid.includes("snyvi://d/") && linkedSaid.includes(`${base}/d/`);
  rows.push(["with one, the link is snyvi://d/<id>", linked.app_url === want && both,
    linked.app_url !== want ? `app_url is ${JSON.stringify(linked.app_url)}, not ${want}` : !both ? `the agent is told "${linkedSaid.slice(0, 90)}"` : "the send answers with it, and the agent is told to give it, with the http link beside"]);

  // A window launch is minted a capability, and it rides the fragment: the
  // query string reaches the daemon's request path and whatever logs one, and
  // a fragment is never sent to a server at all. So the address is checked in
  // three parts -- the document, the window mark, and the secret on the
  // fragment and nowhere else.
  const launched = url => {
    const [head, ...frag] = url.split("#");
    return {
      head,
      cap: /^cap=([0-9a-f]{64})$/.exec(frag.join("#"))?.[1],
      leaked: /[?&]cap=/.test(head),
    };
  };

  app([want]);
  const opened = launched(await handed());
  const marked = `${base}/d/${linked.id}?window=1`;
  const openedOk = opened.head === marked && opened.cap && !opened.leaked;
  rows.push(["snyvi app <link>, no window: opens one on it", !!openedOk,
    openedOk ? "the window was started on the document, marked as a window, with a capability on the fragment"
      : opened.leaked ? "the capability is in the query string, where it would be logged"
      : opened.head !== marked ? `the window was handed ${JSON.stringify(opened.head)}`
      : "the window was started with no capability on it"]);

  app([`${base}/d/${linked.id}?v=2`]);
  const query = launched(await handed());
  const want2 = `${base}/d/${linked.id}?v=2&window=1`;
  const queryOk = query.head === want2 && query.cap && !query.leaked;
  rows.push(["and a url with a query keeps it", !!queryOk,
    queryOk ? "the mark joined the query rather than replacing it, and the capability stayed off it"
      : query.leaked ? "the capability is in the query string, where it would be logged"
      : query.head !== want2 ? `the window was handed ${JSON.stringify(query.head)}`
      : "the window was started with no capability on it"]);

  await p.goto(`${base}/?window=1`);
  const up = await until(async () => (await health()).window === true);
  app([linked.id]);
  const given = up && await handed();
  rows.push(["with a window up, an id is handed to it, bare", given === `${base}/d/${linked.id}`,
    !up ? "the daemon never counted the page as a window" : given === `${base}/d/${linked.id}` ? "the window that is up was handed the document's address, with no mark" : `the window was handed ${JSON.stringify(given)}`]);

  const quiet = mcpSend("Told with a window up and a window executable");
  const noLink = !/https?:\/\//.test(quiet) && !/snyvi:\/\//.test(quiet);
  rows.push(["and the agent is given no link at all", noLink,
    noLink ? "waiting in snyvi, and neither link is offered" : `the agent is told "${quiet.slice(0, 90)}"`]);

  unlinkSync(stub);
  // Left as it was found: a window, for the rows that follow.
  await p.goto(url);
  return rows;
}

/** 0.15: what moves in the sidebar, said once and briefly. The sidebar is
 *  rebuilt from state whenever the library moves, which is how the bar over
 *  the document came to rise again for every arrival after the first, and
 *  why an arrival's row and a read's row could show nothing at all: a rebuilt
 *  row has no past to animate from. These rows read the page's own animation
 *  list, so a wash that plays twice, a bar that rises twice, or a row that
 *  is simply gone all fail here -- and so does anything that runs long, or at
 *  all under reduced motion. */
/** A desk whose panel is busy, and a sidebar that stays where the pointer is.
 *  An agent retitles its terminal about once a second while it works, and in
 *  1.3.0 every title redrew the sidebar's desks and the whole rail: the row
 *  under the pointer was swapped for a copy, lost its hover until the pointer
 *  moved, and a click pressed on one copy and let go on the next was no click.
 *  Here a panel retitles itself ten times a second, and the rows read what
 *  changed while the pointer rests on a desk: nothing but the panel's name.
 *  In a tab of its own, because the capability it opens with stays in that
 *  tab, and every other section is a browser tab without one. */
async function deskRows(cdp, base, token) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const a = await post("/api/desks", { name: "still-a" }), b = await post("/api/desks", { name: "still-b" });
  const [da, db] = [a.desk ? a.desk.id : a.id, b.desk ? b.desk.id : b.id];
  const pane = (await post(`/api/desks/${da}/panes`)).pane.id;
  await post(`/api/panes/${pane}/start`, { cmd: `while :; do printf "\\033]0;work %s\\007" $RANDOM; sleep 0.1; done` });
  let second = null;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  try {
    await p.goto(`${base}/desk/${da}#cap=${cap}`);
    const opened = await until(`!!document.querySelector(".dk .pn") && /work/.test(document.querySelector(".dk-focus .nm")?.textContent || "")`);
    rows.push(["a desk opens, its panel at work", opened, opened ? "the desk, its panel, and the panel's title in the rail" : "no desk on the page: the desk chunk did not load, or the panel never said a title"]);

    await p.hoverOn(`a[data-desk="${db}"]`);
    // What is allowed to change, and where: the panel's name, in its row.
    const watch = `(() => { const c = window.__still = { side: 0, name: 0, rail: 0 };
      const inName = n => { const e = n.nodeType === 1 ? n : n.parentElement; return !!(e && e.closest(".dk-focus")); };
      const o = (el, f) => new MutationObserver(ms => ms.forEach(f)).observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
      o(document.querySelector("#desk-nav"), () => c.side++);
      o(document.querySelector("#toc"), m => inName(m.target) ? c.name++ : c.rail++);
      window.__row = document.querySelector('a[data-desk="${db}"]'); window.__pane = document.querySelector(".dk-focus"); return 1; })()`;
    await p.ev(watch);
    await sleep(3000);
    const still = await p.ev(`({ ...window.__still, same: window.__row === document.querySelector('a[data-desk="${db}"]'), lit: window.__row.matches(":hover"), paneSame: window.__pane === document.querySelector(".dk-focus") })`);
    rows.push(["a busy panel leaves the sidebar alone", still.side === 0 && still.same && still.lit,
      still.side ? `${still.side} changes to the desks under a resting pointer` : !still.same ? "the row under the pointer was replaced" : !still.lit ? "the row under the pointer lost its hover" : "0 changes in 3 s of titles, and the row under the pointer is the same row, still lit"]);
    rows.push(["and the rail, but for the panel's name", still.rail === 0 && still.name > 0 && still.paneSame,
      still.rail ? `${still.rail} changes to the rail besides the name` : !still.name ? "the name never took a new title" : !still.paneSame ? "the panel's row was replaced" : `the name took its titles in place (${still.name} changes), nothing else moved`]);

    // A real change: the panel needs its reader. The mark and the head's
    // count say so; the row under the pointer is still that row.
    await p.ev(`window.__still.side = 0; window.__rowA = document.querySelector('a[data-desk="${da}"]'); 1`);
    await post(`/api/panes/${pane}/agent`, { state: "needs_you" }, { "content-type": "application/json", authorization: `Bearer ${token}` });
    const rang = await until(`!!document.querySelector('a[data-desk="${da}"] .dot.blk') && !!document.querySelector("#desk-nav .sec-n.warn")`);
    const after = await p.ev(`({ rowA: window.__rowA === document.querySelector('a[data-desk="${da}"]'), row: window.__row === document.querySelector('a[data-desk="${db}"]'), lit: window.__row.matches(":hover") })`);
    rows.push(["a panel that needs you changes only its mark", rang && after.rowA && after.row && after.lit,
      !rang ? "no ! on the desk or the head" : !after.rowA ? "the desk's row was drawn again rather than its mark" : !after.row || !after.lit ? "the row under the pointer was replaced" : "the ! on the desk and on the head, and every row is the row it was"]);

    // An aside sent from a panel is a way back to it. From the other
    // desk, a click on the card opens this one with that panel focused.
    second = (await post(`/api/desks/${da}/panes`)).pane.id;
    await p.clickOn(`a[data-desk="${db}"]`);
    await until(`location.pathname === "/desk/${db}"`);
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Four evenings on that one, and it held.", sender: "bench-agent", pane: second }) });
    const from = r.ok && (await r.json()).note.from;
    const led = await until(`!!document.querySelector('#note .note-now[data-desk="${da}"][data-slot="2"]')`);
    if (led) await p.clickOn("#note .note-now p");
    const there = led && await until(`location.pathname === "/desk/${da}" && document.querySelector(".pn.on .pn-body")?.getAttribute("aria-label") === "Panel 2"`);
    rows.push(["an aside from a panel goes back to that panel", !!there,
      !from ? "the daemon did not say where the aside came from" : !led ? "the card does not lead to the panel" : !there ? `the click landed on ${await p.ev("location.pathname")}, not panel 2 of still-a` : "the click opened still-a with panel 2 focused"]);
    await p.pointerAway();
  } finally {
    if (second) await post(`/api/panes/${second}/stop`).catch(() => {});
    await post(`/api/panes/${pane}/stop`).catch(() => {});
    for (const d of [da, db]) await post(`/api/desks/${d}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** 1.14: the reader's order for desks -- by alt ↑, by the row's menu, by a
 *  drag that moves nothing until the drop, kept over a reload and on Home,
 *  and put back, said in the row, when snyvi says no; the repository's link
 *  at the foot of a desk's rail, and none for a folder with no remote; a
 *  plain ⌃V into a panel with Claude in it left to Claude, while a shell
 *  still gets the picture's path, once; and a sequence diagram with a `;` in
 *  a note, drawn. In a tab of its own, with the capability. */
async function orderRepoRows(cdp, base, token, env, tmp) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const T = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const listed = async () => (await (await fetch(`${base}/api/desks`, { headers: H })).json()).desks.map(d => d.name);
  // A repository with a remote that is never asked anything, and a folder with none.
  const repo = join(tmp, "repo-114"), plain = join(tmp, "plain-114");
  mkdirSync(repo, { recursive: true }); mkdirSync(plain, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:someone/thing.git"], { cwd: repo });
  const rootOf = dir => execFileSync(BIN, ["browse", dir, "--no-open"], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop().match(/\/b\/([^/?#]+)/)[1];
  const made = [];
  const desk = async body => { const j = await post("/api/desks", body); const d = j.desk || j; made.push(d.id); return d.id; };
  const o1 = await desk({ name: "order-1" }), o2 = await desk({ name: "order-2" }), o3 = await desk({ name: "order-3" });
  const dRepo = await desk({ root: rootOf(repo), path: "" }), dPlain = await desk({ root: rootOf(plain), path: "" });
  const ours = names => names.filter(n => /^order-/.test(n));

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const sideOrder = () => p.ev(`[...document.querySelectorAll("#desk-nav .t-desk .nm")].map(e => e.textContent).filter(n => /^order-/.test(n))`);
  const panes = [];
  try {
    await p.goto(`${base}/#cap=${cap}`);
    await until(`!!document.querySelector('a[data-desk="${o3}"]')`);

    // ⌥↑ on a row.
    await p.ev(`document.querySelector('a[data-desk="${o3}"]').focus(); 1`);
    await p.press("ArrowUp", { alt: true });
    await until(`[...document.querySelectorAll("#desk-nav .t-desk .nm")].map(e => e.textContent).join() .includes("order-1,order-3,order-2")`, 30);
    const byKey = await sideOrder(), saved = ours(await listed()), focusKept = await p.ev(`document.activeElement === document.querySelector('a[data-desk="${o3}"]')`);
    rows.push(["alt ↑ moves a desk's row, and the daemon keeps it", byKey.join() === "order-1,order-3,order-2" && saved.join() === byKey.join() && focusKept,
      byKey.join() !== "order-1,order-3,order-2" ? `the sidebar reads ${byKey.join(", ")}` : saved.join() !== byKey.join() ? `the daemon has ${saved.join(", ")}` : !focusKept ? "the focus left the row it moved" : "order-1, order-3, order-2, in the sidebar and the daemon, the focus still on order-3"]);

    // The row's menu.
    await p.rightClickOn(`a[data-desk="${o1}"]`);
    const offered = await p.ev(`[...document.querySelectorAll("#ctx button")].map(b => b.textContent.trim())`);
    const isTop = await p.ev(`document.querySelector("#desk-nav .t-desk a[data-desk]")?.dataset.desk === "${o1}"`);
    const down = offered.findIndex(t => /^Move down/.test(t));
    if (down >= 0) await p.ev(`[...document.querySelectorAll("#ctx button")][${down}].click(); 1`);
    await sleep(500);
    const byMenu = await sideOrder();
    const upOnTop = isTop && offered.some(t => /^Move up/.test(t));
    rows.push(["Move down in the row's menu, and no Move up on the top row", down >= 0 && !upOnTop && byMenu.join() === "order-3,order-1,order-2",
      down < 0 ? `the menu offers ${offered.join(" · ")}` : upOnTop ? "the top row is offered Move up" : byMenu.join() !== "order-3,order-1,order-2" ? `after Move down the sidebar reads ${byMenu.join(", ")}` : "order-1 went down one, past order-3"]);

    // A drag: every row holds still until the drop, and the drop is not a click.
    await p.hoverOn("#desk-nav");
    await until(`!!document.querySelector("#desk-nav")`);
    await sleep(400);
    const at = await p.ev(`(() => { const r = q => document.querySelector(q).getBoundingClientRect(); const a = r('a[data-desk="${o3}"]'), z = r('a[data-desk="${o2}"]');
      return { x: a.left + a.width / 2, y: a.top + a.height / 2, to: z.bottom - 3, tops: [...document.querySelectorAll("#desk-nav .t-desk")].map(li => li.getBoundingClientRect().top) }; })()`);
    const path0 = await p.ev(`location.pathname`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 }, sessionId);
    for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y + (at.to - at.y) * i / 8, button: "left", buttons: 1 }, sessionId); await sleep(30); }
    const mid = await p.ev(`({ line: !!document.querySelector(".t-drop"), tops: [...document.querySelectorAll("#desk-nav .t-desk")].map(li => li.getBoundingClientRect().top) })`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.to, button: "left", clickCount: 1 }, sessionId);
    await sleep(600);
    const byDrag = await sideOrder(), path1 = await p.ev(`location.pathname`);
    const still = mid.tops.length === at.tops.length && mid.tops.every((t, i) => Math.abs(t - at.tops[i]) < 0.5);
    rows.push(["a drag moves nothing until the drop, then the row", mid.line && still && byDrag.join() === "order-1,order-2,order-3" && path1 === path0,
      !mid.line ? "no line said where it would land" : !still ? "rows moved during the drag" : path1 !== path0 ? `the drop opened ${path1}` : byDrag.join() !== "order-1,order-2,order-3" ? `after the drop the sidebar reads ${byDrag.join(", ")}`
        : "a line while dragging, every row where it was, order-3 last on the drop, and no desk opened"]);

    // snyvi says no: the list goes back and the row says so.
    await p.ev(`window.__fetch = window.fetch; window.fetch = (u, o) => String(u).includes("/api/desks/order") ? Promise.resolve(new Response("{}", { status: 500 })) : window.__fetch(u, o); 1`);
    await p.ev(`document.querySelector('a[data-desk="${o3}"]').focus(); 1`);
    await p.press("ArrowUp", { alt: true });
    const said = await until(`!!document.querySelector('a[data-desk="${o3}"] .t-said')`, 30);
    const backTo = await sideOrder();
    await p.ev(`window.fetch = window.__fetch; 1`);
    rows.push(["a move snyvi refuses goes back, and its row says so", said && backTo.join() === "order-1,order-2,order-3",
      !said ? "nothing said in the row" : `the sidebar reads ${backTo.join(", ")}`]);

    // Kept: a reload, and Home's own lists.
    await p.reload();
    await until(`!!document.querySelector('a[data-desk="${o3}"]')`);
    const reloaded = await sideOrder();
    const home = await (await fetch(`${base}/api/home`, { headers: H })).json();
    const homeOrder = ours(home.desks.map(d => d.name));
    rows.push(["the order survives a reload and is Home's", reloaded.join() === "order-1,order-2,order-3" && homeOrder.join() === reloaded.join(),
      reloaded.join() !== "order-1,order-2,order-3" ? `after a reload: ${reloaded.join(", ")}` : `Home has ${homeOrder.join(", ")}`]);

    // The repository's link, and none for a plain folder.
    await p.goto(`${base}/desk/${dRepo}#cap=${cap}`);
    const linked = await until(`!!document.querySelector("#meta .dk-repo")`);
    const link = linked ? await p.ev(`({ href: document.querySelector("#meta .dk-repo").getAttribute("href"), text: document.querySelector("#meta .dk-repo").textContent })`) : {};
    await p.goto(`${base}/desk/${dPlain}#cap=${cap}`);
    await until(`!!document.querySelector(".dk")`);
    await sleep(1200);
    const none = await p.ev(`!document.querySelector("#meta .dk-repo")`);
    rows.push(["a desk on a repository links it; a plain folder links nothing", linked && link.href === "https://github.com/someone/thing" && /someone\/thing/.test(link.text) && none,
      !linked ? "no repo line on the repository's desk" : link.href !== "https://github.com/someone/thing" ? `the link is ${link.href}` : !none ? "a folder with no remote has a repo line" : "someone/thing ↗ to https://github.com/someone/thing, and nothing on the plain folder"]);

    // One picture for a plain ⌃V: Claude takes it itself; a shell gets the path.
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    // By its full path: the daemon's PATH leaves out the folder of an installed snyvi-app.
    const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
    const pasted = async (claude) => {
      const pid = (await post(`/api/desks/${dPlain}/panes`)).pane.id;
      panes.push(pid);
      await post(`/api/panes/${pid}/start`, { cmd: `${sleepBin} 300` });
      if (claude) await post(`/api/panes/${pid}/agent`, { session: "0f3b2a1c-9d8e-4f70-a1b2-c3d4e5f60718" }, T);
      // The same address as the page's is a jump within it, and loads nothing.
      if (await p.ev(`location.pathname`) === `/desk/${dPlain}`) await p.reload(); else await p.goto(`${base}/desk/${dPlain}#cap=${cap}`);
      await until(`!!document.querySelector('.pn[data-id="${pid}"] .pn-body')`);
      await sleep(500);
      await p.ev(`window.__pastes = 0; window.__fetch = window.fetch; window.fetch = (u, o) => { if (/^[/]api[/]panes[/][^/]+[/]paste/.test(new URL(String(u), location.href).pathname)) window.__pastes++; return window.__fetch(u, o); };
        document.querySelector('.pn[data-id="${pid}"] .pn-body').focus(); 1`);
      await p.press("v", { ctrl: true });
      await p.ev(`dispatchEvent(new CustomEvent("snyvi-paste-image", { detail: "${png}" })); 1`);
      await sleep(800);
      return p.ev(`window.__pastes`);
    };
    const toClaude = await pasted(true), toShell = await pasted(false);
    rows.push(["a plain ⌃V into Claude is Claude's; a shell gets the picture once", toClaude === 0 && toShell === 1,
      toClaude ? `snyvi saved the picture ${toClaude} time(s) for Claude, which had read it itself` : toShell !== 1 ? `a shell's paste saved ${toShell} picture(s)` : "nothing saved for Claude, one picture for the shell"]);

    // A `;` in a sequence diagram's note.
    const semi = join(tmp, "semicolon.md");
    writeFileSync(semi, "# A semicolon\n\n```mermaid\nsequenceDiagram\n  actor You\n  participant Side\n  You->>Side: drag\n  Note over Side: rows stay still; a 2px line marks the drop\n  You->>Side: drop\n```\n");
    const semiUrl = execFileSync(BIN, ["send", semi], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop();
    await p.goto(semiUrl);
    await p.ev(`document.querySelector(".mmd")?.scrollIntoView({ block: "center", behavior: "instant" }); 1`);
    const drew = await until(`!!document.querySelector('.mmd[data-state="done"]') || !!document.querySelector('.mmd[data-state="error"], .mmd-err')`, 80);
    const state = await p.ev(`document.querySelector(".mmd")?.dataset.state || "none"`);
    rows.push(["a ; in a sequence diagram's note still draws", drew && state === "done", `the diagram is ${state}`]);
  } finally {
    for (const pid of panes) await post(`/api/panes/${pid}/stop`).catch(() => {});
    for (const d of made) await post(`/api/desks/${d}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** 1.8's second half: Home at `/` and the Inbox at `/inbox`; a desk closed
 *  with its notes and brought back; Left off, set, shown in the desk's head,
 *  cleared and undone; an agent's suggestion kept; the brief a Claude
 *  starting in a panel is handed, and its off switch; an agent's HTML sent
 *  inline opening as a page; the aside card laid over the tree so nothing in
 *  it moves; and a document reopened where it was left. In a tab of its own,
 *  with the capability. */
async function homeRows(cdp, base, token, arrive, tmp) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" }, T = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => { const r = await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const get = async (path, h = H) => (await fetch(base + path, { headers: h })).json().catch(() => ({}));
  const made = await post("/api/desks", { name: "home-bench" });
  const d = made.json.desk ? made.json.desk.id : made.json.id;
  const pane = (await post(`/api/desks/${d}/panes`)).json.pane.id;
  // By full path: the daemon's PATH here leaves out any directory holding a
  // snyvi-app, which on an installed machine is /usr/bin -- and a pane whose
  // program is not found is not running, which is what an agent's routes ask.
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  await post(`/api/panes/${pane}/start`, { cmd: `${sleepBin} 300` });

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  let other = 0;
  try {
    // Home and the Inbox, each at its own address.
    await p.goto(`${base}/#cap=${cap}`);
    const home = await until(`!!document.querySelector(".hm .hm-pick [data-hm-open]") && [...document.querySelectorAll(".hm a[data-desk]")].some(a => a.textContent.includes("home-bench"))`);
    const quiet = await p.ev(`document.querySelector(".hm .hm-status")?.textContent || ""`);
    rows.push(["the mark opens Home, with Pick up and a one-line status", home && /Nothing needs you/.test(quiet),
      !home ? "no Home, no Pick up, or the desk is not on it" : `the status says "${quiet.replace(/\s+/g, " ").trim().slice(0, 60)}"`]);
    // The page is a grid, not the reading measure.
    const wide = await p.ev(`(() => { const hm = document.querySelector(".hm").getBoundingClientRect().width, days = document.querySelector(".hm .hm-main")?.getBoundingClientRect(), side = document.querySelector(".hm .hm-side")?.getBoundingClientRect(), pick = document.querySelector(".hm .hm-pick")?.getBoundingClientRect(); const at = b => b ? Math.round(b.left) + "," + Math.round(b.top) + "-" + Math.round(b.right) : "none"; return { hm: Math.round(hm), at: "main " + at(days) + " pick " + at(pick) + " side " + at(side), beside: !!days && !!side && !!pick && Math.abs(days.top - side.top) < 2 && side.left > days.right && side.left > pick.right }; })()`);
    rows.push(["Home takes the width, with the side column beside Pick up and the desks", wide.beside, `${wide.hm}px wide; ${wide.beside ? "Pick up, the desks and the week on the left, the side column beside them from the top" : `not side by side: ${wide.at}`}`]);
    // 1.19: the date in the head and no clock; Arrived heads the side column
    // and has no ✕; with no friend there is no Friends widget, and Pair with
    // a friend… is in the foot with the version and Check for updates.
    const side = await p.ev(`(() => { const s = document.querySelector(".hm .hm-side"); const first = [...(s?.children || [])].find(x => !x.hidden); const foot = document.querySelector(".hm .hm-foot")?.textContent || ""; return { date: !!document.querySelector(".hm-head .hm-v")?.textContent.trim(), clock: !!document.querySelector(".hm-time, .hm-cal, [data-w=today], [data-w=snyvi]"), first: first?.dataset.w || first?.className || "", hide: !!document.querySelector(".hm-arrived .hm-hide"), friends: !!document.querySelector("[data-w=friends]"), foot: /snyvi \\S+ · Check for updates · Pair with a friend…/.test(foot), footText: foot, keys: document.querySelector("details.hm-keys") ? "folded" : "none" }; })()`);
    rows.push(["Home: the date in the head, Arrived first and not hideable, no Friends without a friend, Pair… in the foot", side.date && !side.clock && side.first === "arrived" && !side.hide && !side.friends && side.foot && side.keys === "folded",
      !side.date ? "no date in the head" : side.clock ? "Today or the snyvi widget is still there" : side.first !== "arrived" ? `the side column starts with ${side.first}` : side.hide ? "Arrived has a ✕" : side.friends ? "a Friends widget with no friend" : !side.foot ? `the foot does not carry the version, Check for updates and Pair…: "${side.footText}"` : side.keys !== "folded" ? "Keys is not folded" : "date, Arrived, Claude, Keys folded; Pair… in the foot"]);

    // The note bar: one field for a line on any desk, Pick up's to start with.
    const notesOn = async id => ((await get(`/api/desks/${id}/notes`)).notes || []).map(n => n.text);
    await p.press("a");
    const inBar = await p.ev(`document.activeElement?.dataset?.hm === "bar" && document.querySelector(".hm [data-hm=to]")?.textContent === "home-bench"`);
    await p.type("Write the bar's own row");
    await p.press("Enter");
    const added = await until(`/Added to home-bench/.test(document.querySelector(".hm-nb-say")?.textContent || "") && document.querySelector("input[data-hm=bar]").value === "" && document.activeElement?.dataset?.hm === "bar"`);
    const onDesk = (await notesOn(d)).includes("Write the bar's own row");
    await p.clickOn(".hm [data-hm=barundo]");
    const undone = await until(`document.querySelector("input[data-hm=bar]").value === "Write the bar's own row"`);
    const offDesk = !(await notesOn(d)).includes("Write the bar's own row");
    rows.push(["the note bar: a, a line, Enter puts it on Pick up's desk; Undo takes it back", inBar && added && onDesk && undone && offDesk,
      !inBar ? "a did not put the hand in the bar, on home-bench" : !added ? `the bar says "${await p.ev(`document.querySelector(".hm-nb-say")?.textContent || ""`)}"` : !onDesk ? "the line is not on the desk" : !undone || !offDesk ? "Undo left the line on the desk, or did not give the words back" : "added, said in the bar's row, and taken back into the bar"]);

    // `#` and the start of a name, then Tab: that desk on the chip, the
    // `#name` out of the line. A `#` that names no desk is the note's own.
    const two = (await post("/api/desks", { name: "bench-two" })).json;
    other = two.desk ? two.desk.id : two.id;
    // A query of its own: the same address with only a new fragment is not a load.
    await p.goto(`${base}/?two=1#cap=${cap}`);
    await until(`!!document.querySelector(".hm input[data-hm=bar]") && !!document.querySelector(".hm-dk-add")`);
    await p.clickOn(".hm input[data-hm=bar]");
    await p.ev(`(() => { const b = document.querySelector("input[data-hm=bar]"); b.value = ""; b.dispatchEvent(new InputEvent("input", { bubbles: true })); return 1; })()`);
    await p.type("Ship it #bench-t");
    const hashList = await p.ev(`[...document.querySelectorAll(".hm-nb-list:not([hidden]) .hm-nb-o .hm-t")].map(x => x.textContent).join()`);
    await p.press("Tab");
    const hashed = await p.ev(`({ chip: document.querySelector(".hm [data-hm=to]").textContent, text: document.querySelector("input[data-hm=bar]").value, shut: document.querySelector(".hm-nb-list").hidden })`);
    await p.type("#77");
    const plain = await p.ev(`document.querySelector(".hm-nb-list").hidden && document.querySelector("input[data-hm=bar]").value === "Ship it #77"`);
    rows.push(["# and Tab put a desk on the bar's chip; a # that names no desk stays text", hashList === "bench-two" && hashed.chip === "bench-two" && hashed.text === "Ship it " && hashed.shut && plain,
      hashList !== "bench-two" ? `#bench-t hashList "${hashList}"` : hashed.chip !== "bench-two" ? `the chip says ${hashed.chip}` : hashed.text !== "Ship it " ? `the line is "${hashed.text}"` : !plain ? "#77 opened the list or lost its text" : "bench-two on the chip, \"Ship it #77\" in the line"]);
    await p.press("Escape");

    // A card's +, at the foot of a scrolled page: its desk on the chip, the
    // hand in the bar, and neither the page nor the card moves.
    const plusAt = await p.ev(`(() => { const m = document.querySelector("#main"); m.style.scrollBehavior = "auto"; m.scrollTo({ top: m.scrollHeight }); const b = [...document.querySelectorAll(".hm-dk-add")].pop(); b.dataset.bench = "1"; return { y: m.scrollTop, h: b.closest(".hm-dk").getBoundingClientRect().height, name: b.getAttribute("aria-label").replace("A new note on ", "") }; })()`);
    await p.clickOn(`.hm-dk-add[data-bench="1"]`);
    const plussed = await p.ev(`(() => { const m = document.querySelector("#main"), b = [...document.querySelectorAll(".hm-dk-add")].find(x => x.getAttribute("aria-label") === ${JSON.stringify("A new note on ")} + ${JSON.stringify(plusAt.name)}); m.style.scrollBehavior = ""; return { y: m.scrollTop, h: b?.closest(".hm-dk").getBoundingClientRect().height, chip: document.querySelector(".hm [data-hm=to]").textContent, inBar: document.activeElement?.dataset?.hm === "bar", top: Math.round(document.querySelector(".hm-nb").getBoundingClientRect().top) }; })()`);
    rows.push(["a card's + puts its desk on the bar, in view, and nothing moves", plussed.chip === plusAt.name && plussed.inBar && Math.abs(plussed.y - plusAt.y) < 1 && Math.abs(plussed.h - plusAt.h) < 1 && plussed.top >= 0,
      plussed.chip !== plusAt.name ? `the chip says ${plussed.chip}, not ${plusAt.name}` : !plussed.inBar ? "the hand is not in the bar" : Math.abs(plussed.y - plusAt.y) >= 1 ? `the page moved ${plusAt.y} → ${plussed.y}` : Math.abs(plussed.h - plusAt.h) >= 1 ? `the card grew ${plusAt.h} → ${plussed.h} px` : `${plusAt.name} on the chip, the bar held ${plussed.top} px from the top`]);
    await post(`/api/desks/${other}/delete`); other = 0;

    await p.goto(`${base}/inbox#cap=${cap}`);
    const inbox = await until(`document.querySelector("#doc h1")?.textContent === "Inbox"`);
    rows.push(["the Inbox is at /inbox", inbox, inbox ? "its own page, its own address" : "no Inbox at /inbox"]);

    // Left off: said by the reader, shown in the head, cleared and undone.
    const set = await post(`/api/desks/${d}/leftoff`, { text: "If the tests pass, ship the migration" });
    await p.goto(`${base}/desk/${d}#cap=${cap}`);
    const head = await until(`/ship the migration/.test(document.querySelector(".dk-head .dk-left")?.textContent || "")`);
    const cleared = await post(`/api/desks/${d}/leftoff`, { text: "" });
    const back = cleared.json.was && (await post(`/api/desks/${d}/leftoff`, cleared.json.was)).status === 200;
    const kept = (await get("/api/desks")).desks.find(x => x.id === d)?.left_off;
    rows.push(["Left off is one line in the desk's head, and a clear comes back", set.status === 200 && head && back && kept && kept.text === "If the tests pass, ship the migration" && kept.at === cleared.json.was.at,
      !head ? "the head does not show it" : !back ? "the clear handed nothing back to undo with" : "shown, cleared, and put back with its own time"]);

    // A suggestion from the agent in the panel: a ghost row until kept.
    const sug = await post(`/api/panes/${pane}/suggest`, { text: "Write the rollback note", by: "bench-agent" }, T);
    const ghost = await until(`!!document.querySelector("#toc .dk-sug [data-a=note-keep]")`);
    if (ghost) await p.clickOn("#toc .dk-sug [data-a=note-keep]");
    const keptRow = ghost && await until(`!document.querySelector("#toc .dk-sug") && [...document.querySelectorAll("#toc .dk-note .nm")].some(n => /rollback note/.test(n.textContent))`);
    rows.push(["an agent's suggestion is a ghost row until it is kept", sug.status === 201 && ghost && keptRow,
      sug.status !== 201 ? `the suggestion was refused (${sug.status})` : !ghost ? "no ghost row with Keep" : keptRow ? "Keep made it a line of the reader's" : "Keep left it a suggestion"]);

    // The kept line is the desk's only open one. Ticked by the agent, the
    // list read back finds nothing open: the mark in the sidebar goes glad
    // and hops, once, and the rail itself shows no face (docs/DESIGN.md §2.3).
    const lineId = await p.ev(`[...document.querySelectorAll("#toc .dk-note [data-a=note-tick]")].find(b => /rollback note/.test(b.getAttribute("aria-label")))?.dataset.n || null`);
    const ticked = lineId ? await post(`/api/desks/${d}/notes/${lineId}`, { done: true }) : { status: 0 };
    const glad = ticked.status === 200 && await until(`document.documentElement.dataset.done === "1" && document.querySelector(".brand-mark").classList.contains("hop")`, 30);
    const railFace = await p.ev(`!!document.querySelector("#toc .mk, #toc .brand-mark")`);
    const settled = glad && await until(`!document.documentElement.dataset.done`, 40);
    rows.push(["the last open note ticked: the mark hops glad, the desk shows no face", glad && !railFace && settled,
      !lineId ? "the kept line is not in the rail" : ticked.status !== 200 ? `the tick was refused (${ticked.status})` : !glad ? "the mark did not go glad" : railFace ? "a face turned up in the rail" : !settled ? "the mark stayed glad past its moment" : "glad and a hop on the mark for 2.4 s, nothing in the rail"]);

    // The brief, and its off switch.
    const brief = await get(`/api/panes/${pane}/brief`, T);
    await post("/api/brief", { on: false });
    const off = await get(`/api/panes/${pane}/brief`, T);
    await post("/api/brief", { on: true });
    rows.push(["a Claude starting in the panel is told about its desk", /home-bench/.test(brief.context || "") && /Left off/.test(brief.context || "") && /rollback note/.test(brief.context || "") && brief.title === "home-bench · panel 1" && off.context === "",
      `"${(brief.context || "").split("\n")[0].slice(0, 70)}…", titled "${brief.title}"; off says ${JSON.stringify(off.context)}`]);

    // A desk closed with its notes, and brought back.
    const note = (await post(`/api/desks/${d}/notes`, { text: "a line that must outlive the close" })).json.note;
    await post(`/api/desks/${d}/notes/${note.id}`, { done: true });
    await post(`/api/panes/${pane}/stop`);
    const shut = await post(`/api/desks/${d}/delete`);
    const listed = (await get("/api/removed")).items.find(x => x.kind === "desk" && x.id === String(d));
    const gone = !(await get("/api/desks")).desks.some(x => x.id === d);
    const re = listed ? await post(listed.restore) : { status: 0 };
    const notes = (await get(`/api/desks/${d}/notes`)).notes || [];
    const outlived = notes.find(n => n.id === note.id);
    rows.push(["a closed desk keeps its notes and comes back with them", shut.json.ok && gone && !!listed && re.status === 200 && !!outlived && outlived.done,
      !gone ? "the desk is still listed after its close" : !listed ? "the Removed list has no row for it" : !outlived ? "its notes did not come back" : `${notes.length} notes back, the ticked one still ticked`]);

    // Opening a desk is when it was last touched; a tick is in the log and
    // the rhythm; a desk parks with its next step, and comes down again.
    const t0 = Math.floor(Date.now() / 1000) - 2;
    const seen = (await get("/api/home")).desks.find(x => x.id === d);
    const tick = (await post(`/api/desks/${d}/notes`, { text: "Fail open on Redis errors" })).json.note;
    await post(`/api/desks/${d}/notes/${tick.id}`, { done: true });
    const hm = await get("/api/home");
    const card = hm.desks.find(x => x.id === d);
    const logged = (hm.days || []).some(r => r.desk === d && r.kind === "tick" && r.text === "Fail open on Redis errors");
    rows.push(["opening a desk touches it, and a tick is in the log and the rhythm", seen && seen.visited_at >= t0 - 60 && card.touched >= t0 && logged && card.pulse.length > 0,
      !seen?.visited_at ? "visited_at was not set by opening the desk" : !logged ? "the tick is not in the days" : `touched ${Math.floor(Date.now() / 1000) - card.touched} s ago, ${card.pulse.length} active hour(s)`]);
    const parked = await post(`/api/desks/${d}/park`, { next: "Retry-After in whole seconds" });
    const shelf = (await get("/api/home")).desks.find(x => x.id === d)?.parked;
    const down = await post(`/api/desks/${d}/park`, {});
    const unparked = (await get("/api/home")).desks.find(x => x.id === d);
    rows.push(["a desk parks with its next step and comes down again", parked.status === 200 && shelf?.next === "Retry-After in whole seconds" && down.json.was?.next === shelf?.next && !unparked.parked,
      !shelf ? "the desk did not park" : unparked.parked ? "it stayed parked" : "parked, then taken down with the step handed back"]);
    const week = await post(`/api/desks/${d}/week`, { title: "home-bench · the week", content: "# home-bench · the week\n\n- ✓ Fail open on Redis errors\n" });
    const filed = week.json.id && (await get(`/api/docs/${week.json.id}`, T));
    rows.push(["a week of the log is a document in the desk's project", week.status === 200 && JSON.stringify(filed || {}).includes(week.json.id),
      week.status !== 200 ? `refused (${week.status})` : "sent, and in the library"]);
    const noCap = await fetch(`${base}/api/desks/${d}/park`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    rows.push(["parking is the window's, like every desk route", noCap.status >= 400, `a page with no capability gets ${noCap.status}`]);

    // An agent's inline HTML is a page.
    const html = await post("/api/docs", { content: "<!doctype html><title>Mock</title><h1 id=x>A mockup</h1>", lang: "html", title: "An inline mockup", cwd: tmp }, T);
    await p.goto(`${base}/d/${html.json.id}`);
    const framed = await until(`!!document.querySelector("#doc .preview iframe")`);
    rows.push(["an HTML page sent as content opens as the page", framed, framed ? "framed, its source one click away" : "it opened as its source"]);

    // The aside card over the tree: nothing in the tree moves when it comes.
    await p.goto(`${base}/inbox`);
    await sleep(400);
    const before = await p.ev(`(() => { const t = document.querySelector("#trees"); return { h: t.getBoundingClientRect().height, top: [...t.querySelectorAll("a")].slice(-1)[0]?.getBoundingClientRect().top }; })()`);
    await post("/api/notes", { text: "An aside over the tree.", sender: "bench-agent" }, T);
    await until(`!document.querySelector("#note").hidden && !!document.querySelector("#note .note-now")`);
    await sleep(400);
    const after = await p.ev(`(() => { const t = document.querySelector("#trees"); return { h: t.getBoundingClientRect().height, top: [...t.querySelectorAll("a")].slice(-1)[0]?.getBoundingClientRect().top }; })()`);
    rows.push(["an aside arriving moves nothing in the tree", before.h === after.h && before.top === after.top,
      before.h === after.h && before.top === after.top ? "the tree's height and its last row stayed where they were" : `#trees ${before.h} → ${after.h} px, last row ${before.top} → ${after.top}`]);

    // A long document reopened from the Inbox opens where it was left.
    const long = await arrive({ name: "long-read.md", body: "# Long\n\n" + Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}, to be read past.`).join("\n\n") + "\n" });
    await p.goto(`${base}/d/${long.id}`);
    await until(`!!document.querySelector("#doc .prose p")`);
    await p.ev(`(() => { const m = document.querySelector("#main") || document.querySelector("main"); m.scrollTo({ top: m.scrollHeight / 2, behavior: "instant" }); return 1; })()`);
    await sleep(700);
    await p.goto(`${base}/inbox`);
    await until(`!!document.querySelector(".inbox a[data-id='${long.id}']")`);
    await p.clickOn(`.inbox a[data-id='${long.id}']`);
    await until(`location.pathname === "/d/${long.id}"`);
    await sleep(500);
    const at = await p.ev(`(document.querySelector("#main") || document.querySelector("main")).scrollTop`);
    rows.push(["a document opens where it was left", at > 200, `${Math.round(at)} px down on reopening from the Inbox`]);

    // 1.25: Home under events that change nothing. Twenty asides, each an
    // event Home listens for and none of them on Home, spaced past the
    // read's debounce: twenty reads of /api/home, no redraw of the page
    // (the row under the pointer, the hand in the bar, left alone) and no
    // read of /api/peers, which only a friends event asks for.
    await p.goto(`${base}/#cap=${cap}`);
    await until(`!!document.querySelector(".hm .hm-pick")`);
    await sleep(600);
    await p.ev(`(() => { const d = document.querySelector("#doc"); window.__hm = { draws: 0, peers: 0, home: 0 }; new MutationObserver(() => window.__hm.draws++).observe(d, { childList: true }); const f = window.fetch; window.fetch = (u, ...r) => { const s = String(u); if (/\\/api\\/peers(\\?|$)/.test(s)) window.__hm.peers++; if (/\\/api\\/home(\\?|$)/.test(s)) window.__hm.home++; return f(u, ...r); }; return 1; })()`);
    for (let i = 0; i < 20; i++) {
      await post("/api/notes", { text: `Quiet aside ${i + 1}.`, sender: "bench-agent" }, T);
      await sleep(320);
    }
    await sleep(800);
    const ev20 = await p.ev(`window.__hm`);
    rows.push(["Home under 20 events that change nothing: no redraw, no friends read", ev20.draws === 0 && ev20.peers === 0 && ev20.home >= 10,
      `${ev20.draws} redraw${ev20.draws === 1 ? "" : "s"}, ${ev20.peers} read${ev20.peers === 1 ? "" : "s"} of /api/peers, ${ev20.home} of /api/home`]);
  } finally {
    if (other) await post(`/api/desks/${other}/delete`).catch(() => {});
    await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${d}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** A desk is for a project. `+ New desk` asks where before it makes anything,
 *  the Inbox's project is among the answers and the home folder is the last;
 *  the project, chosen, is a desk on its folder named for it; and its row in
 *  the Inbox then carries the desk glyph lit, which goes back to that desk
 *  rather than making another. In a tab of its own, with the capability, as
 *  `deskRows` is. */
async function projectDeskRows(cdp, base, token, tmp) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const desks = async () => (await (await fetch(`${base}/api/desks`, { headers: H })).json()).desks;
  // The project the probe's sends made: their working folder is `tmp`.
  const proj = (await (await fetch(`${base}/api/tree`)).json()).find(x => x.root && (x.root === tmp || x.root.endsWith(basename(tmp))));
  const before = (await desks()).length;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  let made = null;
  try {
    await p.goto(`${base}/#cap=${cap}`);
    await until(`!!document.querySelector("#desk-nav .sec-acts [data-newdesk]")`);
    // Every click the reader makes from here to the desk, counted by the
    // page: the launch's newcomer gets a project's desk in three or fewer.
    await p.ev(`window.__clicks = 0, document.addEventListener("click", () => window.__clicks++, true)`);
    await p.clickOn("#desk-nav .sec-acts [data-newdesk]");
    const asked = await until(`!!document.querySelector("#ctx:not([hidden]) button")`);
    const menu = asked ? await p.ev(`[...document.querySelectorAll("#ctx button")].map(b => b.textContent.trim())`) : [];
    const none = (await desks()).length === before, at = proj ? menu.indexOf(proj.name) : -1;
    rows.push(["+ New desk asks where first", asked && none && at >= 0 && /home folder/.test(menu[menu.length - 1] || ""),
      !proj ? "the probe's sends made no project on its folder" : !asked ? "no menu under the +" : !none ? "a desk was made before anything was chosen"
        : at < 0 ? `the project is not offered: ${menu.join(" · ")}` : !/home folder/.test(menu[menu.length - 1] || "") ? `the home folder is not last: ${menu.join(" · ")}` : `${menu.join(" · ")}, and no desk yet`]);

    if (at >= 0) {
      await p.clickOn(`#ctx button[data-i="${await p.ev(`[...document.querySelectorAll("#ctx button")].findIndex(b => b.textContent.trim() === ${JSON.stringify(proj.name)})`)}"]`);
      const on = await until(`location.pathname.startsWith("/desk/")`);
      made = (await desks()).find(d => d.root === proj.root) || null;
      rows.push(["the project, chosen, is a desk on its folder", on && !!made && made.name === proj.name,
        !on ? "the page did not go to a desk" : !made ? "no desk on the project's folder" : made.name !== proj.name ? `the desk is named ${made.name}` : `desk ${made.name} on ${made.root}`]);
      const clicks = await p.ev("window.__clicks"), panel = on && await until(`!!document.querySelector(".dk-pane")`);
      rows.push(["a project's desk, with its first panel, in three clicks or fewer", !!panel && clicks <= 3,
        !panel ? "the desk shows no panel" : `${clicks} click${clicks === 1 ? "" : "s"} from the + beside Desks to a desk with its first panel`]);

      const glyph = `.t-proj[data-pid="${proj.id}"] > summary > .b-new.has`;
      await p.clickOn(".t-inbox");
      const lit = await until(`!!document.querySelector(${JSON.stringify(glyph)})`);
      if (lit) await p.clickOn(glyph);
      const back = lit && made && await until(`location.pathname === "/desk/${made.id}"`), one = (await desks()).length === before + 1;
      rows.push(["its row's glyph goes back to that desk", !!back && one,
        !lit ? "the project's row shows no lit desk glyph" : !back ? "the glyph did not open the project's desk" : !one ? "the glyph made a second desk" : "the glyph is lit, and a click on it is the same desk"]);
    }
  } finally {
    if (made) await post(`/api/desks/${made.id}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** 1.7.2, on a desk: a note or a name the daemon refused is back in its
 *  field with the reason under it; the rail puts back what it changed when
 *  the daemon says no, and says which thing failed, in that thing's row. In
 *  a tab of its own, with the capability, as `deskRows` is. */
async function deskLossRows(cdp, base, token) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "refusals" });
  const desk = d.desk ? d.desk.id : d.id;
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  const pane = (await post(`/api/desks/${desk}/panes`)).pane.id;
  await post(`/api/panes/${pane}/start`, { cmd: `while :; do ${sleepBin} 1; done` });
  await post(`/api/desks/${desk}/notes`, { text: "a line to tick" });
  const d2 = await post("/api/desks", { name: "refusals-b" }), other = d2.desk ? d2.desk.id : d2.id;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const field = sel => p.ev(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); return i ? { value: i.value, err: i.parentElement.querySelector(".field-err")?.textContent || null, focused: document.activeElement === i } : null; })()`);
  // The desks' list can redraw between finding a row and the click on it,
  // and a click that lands on the section's head folds it: a switch waits for
  // the row to be there, opens the section if it is folded, and is asked
  // again until the page is on that desk.
  const toDesk = async id => {
    for (let i = 0; i < 3; i++) {
      if (await p.ev(`document.querySelector("#trees").classList.contains("fold-desks")`)) await p.clickOn('#trees [data-fold="desks"]');
      await until(`(() => { const a = document.querySelector('#desk-nav a[data-desk="${id}"]'); return !!a && a.getBoundingClientRect().height > 0; })()`, 30);
      await p.clickOn(`#desk-nav a[data-desk="${id}"]`);
      if (await until(`location.pathname === "/desk/${id}"`, 30)) return true;
    }
    return false;
  };
  try {
    await p.goto(`${base}/desk/${desk}#cap=${cap}`);
    await until(`!!document.querySelector("#toc [data-a=note-new]")`);

    // A new note, refused: the text is back in the field, and why is under it.
    const typed = "a line the daemon will not keep";
    await p.clickOn("#toc [data-a=note-new]");
    await until(`!!document.querySelector("#toc .dk-note-in")`);
    await p.type(typed);
    await until(`document.querySelector("#toc .dk-note-in")?.value === ${JSON.stringify(typed)}`);
    await refuse(p, "POST", /\/notes$/, 400, { error: "a desk holds 50 notes" });
    await p.press("Enter");
    await sleep(400);
    const f1 = await field("#toc .dk-note-in");
    rows.push(["note save refused → text back in the field", await refused(p) && f1?.value === typed && /^Could not add the note/.test(f1.err || ""),
      !(await refused(p)) ? "Enter never asked the daemon" : !f1 ? "the field closed, and the text with it" : f1.value !== typed ? `the field holds "${f1.value}"` : !f1.err ? "the text is back, but nothing says why" : `"${f1.value}", and under it "${f1.err}"`]);
    await p.press("Escape");

    // The desk's name, refused: the typed name is back in the field. Rename
    // is on the ⋯ at the end of the desk's head, and the name is edited
    // where it stands in the head.
    await p.clickOn(".dk-head [data-desk-menu]");
    await until(`!document.querySelector("#ctx")?.hidden`, 20);
    await p.clickOn(`#ctx button[data-i="${await p.ev(`[...document.querySelectorAll("#ctx button")].findIndex(b => b.textContent.startsWith("Rename"))`)}"]`);
    await until(`!!document.querySelector(".dk-head .ren-in")`);
    await p.type("a name the daemon refuses");
    await refuse(p, "POST", /\/rename$/, 400, { error: "that name is taken" });
    await p.press("Enter");
    await sleep(400);
    const f2 = await field(".dk-head .ren-in");
    rows.push(["rename refused → typed name back in the field", await refused(p) && f2?.value === "a name the daemon refuses" && /^Could not rename/.test(f2.err || ""),
      !(await refused(p)) ? "Enter never asked the daemon" : !f2 ? "the field closed, and the name with it" : f2.value !== "a name the daemon refuses" ? `the field holds "${f2.value}"` : !f2.err ? "the name is back, but nothing says why" : `"${f2.value}", and under it "${f2.err}"`]);
    await p.press("Escape");

    // A tick, refused: the box is unticked again, and the row says so.
    const err = () => p.ev(`[...document.querySelectorAll("#toc .dk-err")].map(e => e.firstChild.textContent)`);
    await until(`!!document.querySelector("#toc [data-a=note-tick]")`);
    await refuse(p, "POST", /\/notes\/\d+$/);
    await p.clickOn("#toc [data-a=note-tick]");
    await sleep(400);
    const tick = await p.ev(`document.querySelector("#toc [data-a=note-tick]")?.getAttribute("aria-checked")`), e1 = await err();
    rows.push(["tick refused → unticked again", await refused(p) && tick === "false" && e1.includes("Could not tick this"),
      !(await refused(p)) ? "the tick never asked the daemon" : tick !== "false" ? "the box stayed ticked" : !e1.length ? "nothing said it failed" : `unticked, and the row says "${e1.join(" / ")}"`]);

    // An edit that empties the line takes it off the ✕'s way: a ghost with
    // its Undo, and the Undo brings the words back.
    await p.clickOn("#toc [data-a=note-edit]");
    await until(`!!document.querySelector("#toc .dk-note-in")`);
    await p.ev(`document.querySelector("#toc .dk-note-in").select()`);
    await p.press("Delete");
    await p.press("Enter");
    await sleep(400);
    const ghost = await p.ev(`(() => { const g = document.querySelector("#toc .dk-note.gone"); return g ? { text: g.querySelector(".nm").textContent, undo: !!g.querySelector("[data-a=note-back]") } : null; })()`);
    if (ghost?.undo) await p.clickOn("#toc .dk-note.gone [data-a=note-back]");
    const back = ghost?.undo && await until(`document.querySelector("#toc [data-a=note-edit]")?.textContent === "a line to tick"`);
    rows.push(["empty edit → ghost with Undo; Undo brings the text back", !!back,
      !ghost ? "the line went with no ghost" : !ghost.undo ? `the ghost "${ghost.text}" offers no Undo` : back ? `"${ghost.text} · Undo", and the Undo put the words back` : "the Undo did not bring the line back"]);

    // A close, refused: the panel is still in its row, running, and no
    // "Closed · Undo" was ever said.
    await until(`!!document.querySelector("#toc .dk-pane [data-a=close]")`);
    await refuse(p, "POST", /^\/api\/panes\/[^/]+\/delete$/);
    await p.hoverOn("#toc .dk-pane");
    await p.clickOn("#toc .dk-pane [data-a=close]");
    await sleep(500);
    const shut = await p.ev(`({ row: !!document.querySelector("#toc .dk-pane.run:not(.closing)"), closed: [...document.querySelectorAll("#toc .dk-panes .dk-note.gone")].some(r => /Closed/.test(r.textContent)) })`), e2 = await err();
    rows.push(["close refused → panel row running, no Closed row", await refused(p) && shut.row && !shut.closed && e2.includes("Could not close panel 1"),
      !(await refused(p)) ? "the ✕ never asked the daemon" : !shut.row ? "the panel's row is gone or still closing" : shut.closed ? "a Closed · Undo row was drawn anyway" : !e2.length ? "nothing said it failed" : `still running, and its row says "${e2.join(" / ")}"`]);

    // Another desk's notes, not sent: a line that says so, not the bar an
    // empty list is.
    await refuse(p, "GET", /\/notes$/);
    await toDesk(other);
    await until(`location.pathname === "/desk/${other}"`);
    await sleep(500);
    const notes = await p.ev(`({ line: document.querySelector("#toc .dk-notes .no-reach")?.textContent || null, prompt: !!document.querySelector("#toc .dk-notes .dk-note.new") })`);
    if (notes.line) await p.clickOn("#toc .dk-notes .no-reach [data-a=reload]");
    const prompt = !!notes.line && await until(`!!document.querySelector("#toc .dk-notes .dk-note.new")`);
    rows.push(["notes fetch refused → Retry line, not the empty prompt", await refused(p) && !!notes.line && !notes.prompt && prompt,
      !(await refused(p)) ? "the desk never asked for its notes" : notes.prompt ? "the empty prompt, as if the list were empty" : !notes.line ? "nothing says the notes did not load" : prompt ? `"${notes.line}", and the Retry read the (empty) list` : "the Retry did not read the list"]);

    // A point kept from a document this desk's panel sent is still there
    // after going to another desk and back.
    await fetch(`${base}/api/docs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: "# A passage to keep\n\nThis line is worth keeping as a point for the panel that sent it.\n", title: "A passage to keep", pane }) });
    await toDesk(desk);
    const listed = await until(`!!document.querySelector("#toc a[data-read]")`, 150);
    let kept = false, survived = false;
    if (listed) {
      await p.clickOn("#toc a[data-read]");
      await until(`!!document.querySelector("#doc .prose p")`);
      const at = await p.ui("center", "#doc .prose p");
      await p.drag(at.x - 150, at.y, 300);
      if (await until(`!!document.querySelector(".dk-pick")`, 20)) {
        await p.clickOn(".dk-pick");
        kept = await until(`!!document.querySelector("#toc .dk-points")`, 20);
      }
      if (kept) {
        await toDesk(other);
        await toDesk(desk);
        survived = await until(`!!document.querySelector("#toc .dk-points")`, 20);
      }
    }
    rows.push(["points survive switching desk and back", survived,
      !listed ? "the panel's document is not in the desk's rail" : !kept ? "no point could be kept from it" : survived ? "the point is in the rail after another desk and back" : "the point went with the switch"]);
  } finally {
    await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${other}/delete`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** 1.6's desk: a panel in full view fills the window and comes back; a head
 *  dragged onto another panel trades their places, and so does ⌃⌥⇧ and an
 *  arrow, the daemon renumbering them; a link a program printed opens on a
 *  Ctrl-click and only then; the context menu on a panel, a note and a
 *  sidebar row, doing what the row's own controls do; an agent's tick lands
 *  in the rail with its name; and a narrow window still offers a third panel.
 *  In a tab of its own, with the capability, as `deskRows` is. */
async function panelRows(cdp, base, token) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const slotOf = async (desk, pane) => { const j = await (await fetch(`${base}/api/desks`, { headers: H })).json(); return j.desks.find(d => d.id === desk)?.panes.find(p => p.id === pane)?.slot; };
  const d = await post("/api/desks", { name: "panels" });
  const desk = d.desk ? d.desk.id : d.id;
  const pa = (await post(`/api/desks/${desk}/panes`)).pane.id, pb = (await post(`/api/desks/${desk}/panes`)).pane.id;
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  await post(`/api/panes/${pa}/start`, { cmd: `printf 'see https://example.com/snyvi-bench. then\\n'; while :; do ${sleepBin} 1; done` });
  await post(`/api/panes/${pb}/start`, { cmd: `while :; do ${sleepBin} 1; done` });
  const n1 = (await post(`/api/desks/${desk}/notes`, { text: "a line for the menu" })).note.id;
  const n2 = (await post(`/api/desks/${desk}/notes`, { text: "a line for an agent" })).note.id;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const mouse = async (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
  const rightOn = async sel => { const at = await q.ui("center", sel); await mouse("mouseMoved", at.x, at.y); await mouse("mousePressed", at.x, at.y, { button: "right", clickCount: 1 }); await mouse("mouseReleased", at.x, at.y, { button: "right", clickCount: 1 }); await sleep(250); };
  const menu = `(() => { const m = document.querySelector("#ctx"); return m && !m.hidden ? { head: m.querySelector(".ctx-head")?.textContent, items: [...m.querySelectorAll("button")].map(b => b.textContent) } : null; })()`;
  const pick = async label => { await q.ev(`[...document.querySelectorAll("#ctx button")].find(b => b.textContent.startsWith(${JSON.stringify(label)}))?.click(); 1`); await sleep(300); };
  const P = id => `.pn[data-id="${id}"]`;
  try {
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    await until(`document.querySelectorAll(".dk-grid > .pn").length === 2 && /snyvi-bench/.test(document.querySelector('${P(pa)} .pn-scr')?.textContent || "")`);

    // 1.7.1: what `snyvi statusline` tells a panel -- its model and how full
    // its context window is -- is in the panel's head, amber from 85%.
    const told = await fetch(`${base}/api/panes/${pa}/agent`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "Fable 5.1", ctx: { pct: 87.4, size: 200000, input: 174800 } }) });
    // The head gives the tokens against the window, the model and the % in
    // its tip; the rail's row, which has less room, the %.
    const ctxShown = await until(`document.querySelector('${P(pa)} .pn-ctx')?.textContent === "175k / 200k"`, 30);
    const ctxLook = await q.ev(`({ hot: !!document.querySelector('${P(pa)} .pn-ctx.hot'), title: document.querySelector('${P(pa)} .pn-ctx')?.dataset.tip || "", row: document.querySelector('.dk-pane:has([data-focus="${pa}"]) .ctx')?.textContent || "" })`);
    rows.push(["a panel says how full its agent's context window is", told.status === 204 && ctxShown && ctxLook.hot && /Fable 5\.1/.test(ctxLook.title) && /87(\.4)?%/.test(ctxLook.title) && ctxLook.row === "87%",
      told.status !== 204 ? `the route answered ${told.status}` : !ctxShown ? "the head never showed it" : !ctxLook.hot ? "87% is not amber" : !ctxLook.row ? "the rail's row does not show it" : `"${ctxLook.title}", amber, and in the rail`]);

    // Full view, from the head's button, and back by the key.
    await q.hoverOn(`${P(pa)} .pn-head`);
    await q.clickOn(`${P(pa)} .pn-full`);
    await sleep(300);
    const fv = await q.ev(`(() => { const p = document.querySelector('${P(pa)}'); return { full: document.documentElement.dataset.full === "1", side: getComputedStyle(document.querySelector("#side")).display,
      w: Math.round(p.getBoundingClientRect().width), W: innerWidth, other: !!document.querySelector('${P(pb)}')?.isConnected, tab: !!document.querySelector('.dk-tabs [data-focus="${pb}"]') }; })()`);
    rows.push(["⤢ puts a panel in full view", fv.full && fv.side === "none" && fv.w > fv.W - 60 && !fv.other && fv.tab,
      !fv.full ? "the window was not told" : fv.side !== "none" ? "the sidebar is still there" : fv.w <= fv.W - 60 ? `the panel is ${fv.w} px of ${fv.W}` : !fv.tab ? "the other panel has no tab" : `${fv.w} of ${fv.W} px, no sidebar, the other panel a tab`]);
    await q.press("z", { ctrl: true, alt: true });
    await sleep(300);
    const back = await q.ev(`({ full: "full" in document.documentElement.dataset, side: getComputedStyle(document.querySelector("#side")).display, both: document.querySelectorAll(".dk-grid > .pn").length })`);
    rows.push(["and ⌃⌥Z brings the grid back", !back.full && back.side !== "none" && back.both === 2,
      back.full ? "still in full view" : back.side === "none" ? "the sidebar did not come back" : `${back.both} panels in the grid`]);

    // A head dragged onto the other panel, then the keys the other way.
    const from = await q.ui("center", `${P(pa)} .pn-head`), to = await q.ui("center", `${P(pb)} .pn-body`);
    await mouse("mouseMoved", from.x, from.y);
    await mouse("mousePressed", from.x, from.y, { button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8, { button: "left", buttons: 1 }); await sleep(25); }
    await mouse("mouseReleased", to.x, to.y, { button: "left", clickCount: 1 });
    let moved = false;
    for (let i = 0; i < 30 && !moved; i++) { moved = (await slotOf(desk, pa)) === 2 && (await slotOf(desk, pb)) === 1; if (!moved) await sleep(100); }
    const order = await until(`document.querySelector(".dk-grid > .pn")?.dataset.id === ${JSON.stringify(pb)}`, 30);
    rows.push(["a head dragged onto a panel trades their places", moved && order,
      !moved ? `panel 1 is at ${await slotOf(desk, pa)}, panel 2 at ${await slotOf(desk, pb)}` : !order ? "the daemon moved them, the grid did not" : "1 and 2 traded, in the daemon and on the page"]);
    await q.ev(`document.querySelector('${P(pa)} .pn-body').focus(); 1`);
    for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 11 }, sessionId);
    let keyed = false;
    for (let i = 0; i < 30 && !keyed; i++) { keyed = (await slotOf(desk, pa)) === 1; if (!keyed) await sleep(100); }
    // And on the page: the daemon's word lands before the grid is redrawn,
    // and the link below is measured on screen. Measured a beat early it was
    // measured in the right-hand column, and the Ctrl that followed landed
    // on the other panel once this one had moved -- which failed CI on #39.
    const drawnBack = keyed && await until(`document.querySelector(".dk-grid > .pn")?.dataset.id === ${JSON.stringify(pa)}`, 30);
    rows.push(["⌃⌥⇧← moves the focused panel back", keyed && drawnBack, !keyed ? `still at ${await slotOf(desk, pa)}` : !drawnBack ? "the daemon moved it, the grid did not" : "position 1 again, and the other at 2"]);

    // A link a program printed: a plain click does nothing, a Ctrl-click opens it.
    await until(`document.querySelector('${P(pa)}')?.isConnected`);
    await q.ev(`window.__opened = []; window.open = u => { window.__opened.push(u); return null; }; 1`);
    const at = await q.ev(`(() => { const row = [...document.querySelectorAll('${P(pa)} .pn-scr > div')].find(r => r.textContent.includes("example.com"));
      if (!row) return null; const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n, off = row.textContent.indexOf("example");
      while ((n = w.nextNode()) && off >= n.length) off -= n.length; const r = document.createRange(); r.setStart(n, off); r.setEnd(n, off + 3);
      const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    if (at) {
      await mouse("mouseMoved", at.x, at.y);
      for (const type of ["mousePressed", "mouseReleased"]) await mouse(type, at.x, at.y, { button: "left", clickCount: 1 });
      await sleep(200);
      const plain = await q.ev("window.__opened.length");
      await mouse("mouseMoved", at.x, at.y, { modifiers: 2 });
      await sleep(100);
      const lined = await q.ev(`!!document.querySelector('${P(pa)} .pn-ul i')`);
      for (const type of ["mousePressed", "mouseReleased"]) await mouse(type, at.x, at.y, { button: "left", clickCount: 1, modifiers: 2 });
      await sleep(200);
      const opened = await q.ev("window.__opened");
      rows.push(["a plain click on a link opens nothing", plain === 0, plain ? `opened ${plain}` : "the click only went to the panel"]);
      rows.push(["Ctrl shows it, and Ctrl-click opens it", lined && opened.length === 1 && opened[0] === "https://example.com/snyvi-bench",
        !lined ? "no underline under Ctrl" : `opened ${JSON.stringify(opened)}${opened[0] === "https://example.com/snyvi-bench" ? ", the sentence's full stop left off" : ""}`]);
    } else rows.push(["a link in a panel", false, "the printed link never reached the panel's text"]);

    // The menu on a panel's head: it names the panel, and Close asks twice.
    await rightOn(`${P(pa)} .pn-head`);
    const pm = await q.ev(menu);
    rows.push(["a right-click on a panel's head opens its menu", !!pm && /^Panel 1/.test(pm.head) && pm.items.some(t => t.startsWith("Full view")) && pm.items.some(t => t.startsWith("Close panel")),
      pm ? `"${pm.head}": ${pm.items.join(" · ")}` : "no menu"]);
    await q.press("Escape", { raw: true });
    const shut = await q.ev(`!document.querySelector("#ctx") || document.querySelector("#ctx").hidden`);
    rows.push(["Esc closes the menu", shut, shut ? "closed" : "still open"]);

    // A note's menu ticks it, as its box does; an agent's tick lands with its name.
    await rightOn(`.dk-note:has([data-n="${n1}"]) .nm`);
    const nm = await q.ev(menu);
    await pick("Tick");
    const ticked = await until(`!!document.querySelector('.dk-note.done [data-n="${n1}"]')`, 30);
    rows.push(["a note's menu ticks it", !!nm && ticked, !nm ? "no menu on the note" : ticked ? `"${nm.head}": ${nm.items.join(" · ")}` : "the note is still open"]);
    const tickBy = body => fetch(`${base}/api/panes/${pa}/notes/${n2}/tick`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const wrong = await tickBy({ by: "bench-agent", commit: "main" });
    const tk = await tickBy({ by: "bench-agent", commit: "90F09D6aa" });
    const byAgent = tk.ok && await until(`document.querySelector('.dk-note.done:has([data-n="${n2}"]) .dk-by > span')?.textContent === "bench-agent"`, 40);
    const sha = await q.ev(`document.querySelector('.dk-note.done:has([data-n="${n2}"]) .dk-sha')?.textContent || ""`);
    rows.push(["an agent's tick carries its commit, and a branch name is refused", wrong.status === 400 && sha === "90f09d6",
      wrong.status !== 400 ? `"main" as a commit answered ${wrong.status}` : `the row shows "${sha}"`]);
    const named = await fetch(`${base}/api/panes/${pa}/name`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "bench named" }) });
    const headSays = named.ok && await until(`document.querySelector('${P(pa)} .pn-head')?.textContent.includes("bench named")`, 40);
    const unnamed = await fetch(`${base}/api/panes/${pa}/name`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "" }) });
    const noToken = await fetch(`${base}/api/panes/${pa}/name`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    rows.push(["an agent names its panel, and only with the token", headSays && unnamed.ok && noToken.status === 401,
      !named.ok ? `name answered ${named.status}` : !headSays ? "the head never showed it" : noToken.status !== 401 ? `no token answered ${noToken.status}` : "the head shows it, empty gives it back"]);
    const again = await tickBy({ by: "bench-agent" });
    rows.push(["an agent's tick shows in the rail, with its name", byAgent && again.status === 409,
      !tk.ok ? `the tick answered ${tk.status}` : !byAgent ? "the rail never showed it" : again.status !== 409 ? `a second tick answered ${again.status}` : "done, \"bench-agent\" at its end, and a second tick refused"]);

    // #95: a note's text has the row. Its thread and its stage are said in
    // its tip, with only small marks under its number; a long line is two
    // lines, and a row in a thread is as tall as a bare one.
    const A = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const agent = (path, body) => fetch(`${base}/api/panes/${pa}/${path}`, { method: "POST", headers: A, body: JSON.stringify(body) });
    const n3 = (await post(`/api/desks/${desk}/notes`, { text: "a long line to see that a note in a thread keeps the rail's width for its own words, and stops at two lines however long it is" })).note.id;
    const threaded = await agent("thread", { name: "bench thread with a long name", notes: [n3], by: "bench-agent" });
    await agent(`notes/${n3}/mark`, { stage: "read", by: "bench-agent" });
    const row95 = n => `.dk-note:has([data-n="${n}"])`;
    const inTip = await until(`(document.querySelector('${row95(n3)} .nm')?.dataset.tipSub || "").includes("bench thread with a long name")`, 40);
    const lay = await q.ev(`(() => { const a = document.querySelector('${row95(n3)}'), b = document.querySelector('${row95(n1)}'); if (!a || !b) return null;
      const t = a.querySelector(".nm-t"), lh = parseFloat(getComputedStyle(t).lineHeight);
      return { h: a.getBoundingClientRect().height, bare: b.getBoundingClientRect().height, w: t.getBoundingClientRect().width, row: a.getBoundingClientRect().width,
        lines: Math.round(t.getBoundingClientRect().height / lh), beside: a.querySelectorAll(":scope > :not(.dk-lead):not(.nm):not(.dk-tail)").length,
        marks: a.querySelectorAll(".dk-marks > *").length, tip: a.querySelector(".nm").dataset.tipSub || "" }; })()`);
    rows.push(["a note in a thread keeps the row for its text, two lines, as tall as a bare one",
      threaded.ok && inTip && !!lay && lay.h === lay.bare && lay.w >= lay.row * 0.6 && lay.lines === 2 && lay.beside === 0 && lay.marks === 1 && lay.tip.includes("read by bench-agent"),
      !threaded.ok ? `the thread answered ${threaded.status}` : !inTip || !lay ? "the tip never named the thread" :
        `${lay.h} px tall against ${lay.bare}, text ${Math.round(lay.w)} of ${Math.round(lay.row)} px in ${lay.lines} lines, ${lay.beside} beside it, ${lay.marks} marks, tip "${lay.tip}"`]);

    // 1.26: a panel's thread is one line under its row, not a card of its
    // own; a second thread the panel starts rests the first, and the line's
    // menu is what a reader does -- Done, Park, Rename, Remove -- not stages.
    const thLine = `.dk-pth:has(.th-sum[data-tip="bench thread with a long name"])`;
    const thOnRow = threaded.ok && await until(`!!document.querySelector('${thLine}') && document.querySelector('${thLine}').previousElementSibling?.matches(".dk-pane")`, 40);
    await agent("thread", { name: "bench second thread", by: "bench-agent" });
    const thRested = await until(`!!document.querySelector('.dk-pth .th-sum[data-tip="bench second thread"]') && !document.querySelector('${thLine}')
      && [...document.querySelectorAll('.th-rest .dk-thread.rest .th-name')].some(e => e.textContent === "bench thread with a long name")`, 40);
    const thWhy = await q.ev(`[...document.querySelectorAll('.th-rest .dk-thread.rest')].find(e => e.querySelector(".th-name")?.textContent === "bench thread with a long name")?.querySelector(".th-why")?.textContent || ""`);
    await rightOn('.dk-pth .th-sum[data-tip="bench second thread"]');
    const thMenu = await q.ev(menu);
    const thSaid = thMenu ? thMenu.items.join(" · ") : "";
    if (thMenu) await pick("Done");
    const thDone = !!thMenu && await until(`document.querySelector('.dk-pth:has(.th-sum[data-tip="bench second thread"]) .th-word')?.textContent === "✓ shipped"`, 40);
    rows.push(["a panel's thread is a line under its row; the next one rests it; Done ships it",
      thOnRow && thRested && thWhy.endsWith("moved on") && !!thMenu && !/Move to/.test(thSaid) && thSaid.startsWith("Done") && thDone,
      !thOnRow ? "no line under the panel's row" : !thRested ? "the second thread did not take the line, or the first did not rest" : !thWhy.endsWith("moved on") ? `the first rests as "${thWhy}"` :
        !thMenu ? "no menu on the line" : /Move to|^(?!Done)/.test(thSaid) ? `the menu: ${thSaid}` : !thDone ? "Done left it unshipped" : `rests "${thWhy}"; menu ${thSaid}; ✓ shipped`]);

    // #95: a command handed over is a card with the whole command; one that
    // could close the paste early is refused at the door; Run types it into
    // the panel that asked as a ! command, Enter apart, on the click alone.
    const refusedCmd = await agent("handover", { kind: "run", text: "Run this", cmd: "echo \u001b[201~ typed as keys", by: "bench-agent" });
    const handed = await agent("handover", { kind: "run", text: "Upload the bench file", cmd: "echo bench-run-ok", by: "bench-agent" });
    await agent("agent", { session: "0b1c2d3e-4f50-4617-8899-aabbccddeeff" });
    const card = await until(`document.querySelector('.dk-turn .tn-cmd')?.textContent === "echo bench-run-ok" && !!document.querySelector('[data-a="tn-run"]')`, 60);
    await q.ev(`window.__typed = []; const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { try { const j = JSON.parse(d); if (j.t === "in") window.__typed.push(j.d); } catch {} return send.call(this, d); }; 1`);
    if (card) await q.clickOn('[data-a="tn-run"]');
    const typed = card && await until(`window.__typed.length >= 2`, 30) ? await q.ev("window.__typed") : [];
    const ranGone = card && await until(`!document.querySelector('.dk-turn .tn-cmd')`, 30);
    const pasted = (typed[0] || "").replace("\u001b[200~", "").replace("\u001b[201~", "");
    rows.push(["a handed-over command: refused if it could escape, else Run types it as a ! command",
      refusedCmd.status === 400 && handed.status === 201 && card && pasted === "! echo bench-run-ok" && typed[1] === "\r" && ranGone,
      refusedCmd.status !== 400 ? `an escape in the command answered ${refusedCmd.status}` : handed.status !== 201 ? `the hand-over answered ${handed.status}` :
        !card ? "no card with the command and Run" : !typed.length ? "Run typed nothing" : `typed ${JSON.stringify(typed)}${ranGone ? "" : ", and the card stayed"}`]);

    // A sidebar document's menu: Remove leaves the row's own Undo.
    const doc = await q.ev(`document.querySelector("#trees a[data-id]")?.dataset.id || ""`);
    if (doc) {
      await rightOn(`#trees a[data-id="${doc}"]`);
      const dm = await q.ev(menu);
      await q.ev(`[...document.querySelectorAll("#ctx button")].find(b => b.firstChild?.textContent === "Remove")?.click(); 1`); await sleep(300);
      const ghost = await until(`!!document.querySelector("#trees [data-undoc]")`, 20);
      rows.push(["a document's menu removes it, with the row's Undo", !!dm && dm.items.includes("RemoveDel") && ghost,
        !dm ? "no menu on the row" : !ghost ? "no Undo in the row" : `${dm.items.length} entries, and the row holds its Undo`]);
      if (ghost) { await q.clickOn("#trees [data-undoc]"); await sleep(300); }
    } else rows.push(["a document's menu", false, "no document row in the sidebar to try it on"]);

    // A narrow window: the width shows fewer, and never refuses one.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(400);
    const narrow = await q.ev(`({ plus: document.querySelector('.dk-head .icon[data-a="new"]')?.disabled, shown: document.querySelectorAll(".dk-grid > .pn").length, tabs: document.querySelectorAll(".dk-tabs [data-focus]").length })`);
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    rows.push(["600 px wide: one panel shown, and + still offered", narrow.plus === false && narrow.shown === 1 && narrow.tabs === 2,
      narrow.plus ? "the + is refused at this width" : `${narrow.shown} shown, ${narrow.tabs} tabs, and + offered`]);

    // 1.7.1: ✕ closes at once, the row holds Undo for 8 s, and the panels
    // after it close up, so ⌃⌥2 is the one now second.
    const pc = (await post(`/api/desks/${desk}/panes`)).pane.id;
    await until(`document.querySelectorAll(".dk-pane").length === 3`);
    const slotsBefore = [await slotOf(desk, pa), await slotOf(desk, pb), await slotOf(desk, pc)];
    const first = [pa, pb, pc][slotsBefore.indexOf(1)], second = [pa, pb, pc][slotsBefore.indexOf(2)], third = [pa, pb, pc][slotsBefore.indexOf(3)];
    await q.hoverOn(`.dk-pane:has([data-focus="${first}"])`);
    await q.clickOn(`.dk-pane [data-a="close"][data-p="${first}"]`);
    const offered = await until(`!!document.querySelector('.dk-note.gone [data-a="pane-back"][data-p="${first}"]')`, 30);
    const after = { gone: !(await slotOf(desk, first)), a: await slotOf(desk, second), b: await slotOf(desk, third) };
    rows.push(["✕ closes a panel at once, and the rest close up", offered && after.gone && after.a === 1 && after.b === 2,
      !after.gone ? "the panel is still open" : !offered ? "no Undo in the rail" : `the others are at ${after.a} and ${after.b}`]);
    await q.ev(`document.querySelector('${P(second)} .pn-body')?.focus(); 1`);
    for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "2", code: "Digit2", windowsVirtualKeyCode: 50, modifiers: 3 }, sessionId);
    await sleep(200);
    const on2 = await q.ev(`document.activeElement?.closest(".pn")?.dataset.id || ""`);
    rows.push(["⌃⌥2 is the panel now second", on2 === third, on2 === third ? "the former third" : `focus went to ${on2 === second ? "the first" : on2 || "nothing"}`]);
    await q.clickOn(`[data-a="pane-back"][data-p="${first}"]`);
    const stopped = await until(`!!document.querySelector('${P(first)} .pn-start:not([hidden])') || !!document.querySelector('.dk-pane:has([data-focus="${first}"]) [data-a="start"]')`, 40);
    const at3 = await slotOf(desk, first);
    rows.push(["Undo brings it back, stopped, Start offered", stopped && at3 === 3, !at3 ? "it did not come back" : at3 !== 3 ? `it came back at ${at3}` : !stopped ? "it started itself" : "at the end, with Start"]);
    await q.hoverOn(`.dk-pane:has([data-focus="${first}"])`);
    await q.clickOn(`.dk-pane [data-a="close"][data-p="${first}"]`);
    await sleep(8600);
    const spent = await q.ev(`!document.querySelector('[data-a="pane-back"]')`);
    rows.push(["the offer ends after 8 s", spent, spent ? "gone, and the panel stays closed" : "Undo is still offered"]);
  } finally {
    for (const pane of [pa, pb]) await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** Round 2 of the themes: an answer in the column is centred on the button
 *  it answers. It kept its top 96 px off the window's foot, a guess at its
 *  height, and at 802 px tall the theme button's answer sat level with Aa --
 *  a centre at 729 px for a button at 778. Measured the way it was found. */
async function answerRows(url, tmp) {
  const rows = [];
  /* A browser of its own, told it has a mouse: headless Chromium answers
   * (hover: none), and under that the column is the touch screen's row, so
   * every button sits at one height and the fault could not be seen. */
  const own = await launch(join(tmp, "chrome-hover"), { windowSize: "1280,802",
    args: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] });
  const { sessionId } = await tab(own.cdp);
  await own.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(own.cdp, sessionId);
  try {
  await p.width(1280, 802);
  await p.goto(url);
  const hover = await p.ev(`matchMedia("(hover: hover)").matches`);
  rows.push(["a pointer that hovers", hover, hover ? "the column, not the touch screen's row" : "the page still believes it has no pointer"]);
  const restore = `(() => { for (const k of ["snyvi.accent", "snyvi.font", "snyvi.theme.light", "snyvi.theme.dark", "snyvi.theme.follow", "snyvi.theme.css.light", "snyvi.theme.css.dark"]) localStorage.removeItem(k);
    const d = document.documentElement; delete d.dataset.accent; delete d.dataset.font; snyviTheme.apply(); return 1; })()`;
  const fill = await p.ev(`(() => { const r = document.querySelector(".foot-rail"); return getComputedStyle(r).backgroundColor; })()`);
  await p.hoverOn(".foot-set");
  const open = await p.ev(`getComputedStyle(document.querySelector(".foot-rail")).backgroundColor`);
  await p.pointerAway();
  rows.push(["the column is filled while open", /rgba\(0, 0, 0, 0\)|transparent/.test(fill) && !/rgba\(0, 0, 0, 0\)|transparent/.test(open),
    `at rest ${fill}, open ${open}`]);
  // 1.8: the setting changing is the answer, and the button's own tip, under
  // the hand, names what it is now (docs/DESIGN.md §4.1) -- no toast.
  for (const [id, name] of [["#btn-theme", "theme"], ["#btn-accent", "accent"], ["#btn-font", "Aa"]]) {
    await p.hoverOn(".foot-set");
    await p.hoverOn(id);
    await sleep(600);   // the tip's chunk comes with the first rest on a control
    const was = await p.ev(`document.querySelector(${JSON.stringify(id)}).dataset.tip`);
    await p.clickOn(id);
    await sleep(450);
    const m = await p.ev(`(() => { const t = document.querySelector("#tip.on"), b = document.querySelector(${JSON.stringify(id)});
      const toast = !!document.querySelector("#toasts .toast");
      if (!t) return { toast }; const r = t.getBoundingClientRect(), s = b.getBoundingClientRect();
      return { toast, text: t.textContent, tip: r.top + r.height / 2, button: s.top + s.height / 2 }; })()`);
    const off = m.tip != null ? Math.abs(m.tip - m.button) : null;
    rows.push([`${name}'s answer is its tip, beside it`, !m.toast && off !== null && off <= 3 && m.text && !m.text.startsWith(was),
      m.toast ? "a toast came up as well" : off === null ? "no tip after the click" : m.text.startsWith(was) ? `the tip still reads "${m.text}"` : `"${m.text}", its centre ${Math.round(m.tip)} px, the button's ${Math.round(m.button)} px`]);
    await p.pointerAway();
    await p.ev(restore);
    // Gone before the next press: at the foot of a short window an answer
    // can lie over the button below it.
    await p.ev(`document.querySelectorAll("#toasts .toast").forEach(t => t.remove()); document.querySelectorAll(".foot-rail .said").forEach(b => b.classList.remove("said")); 1`);
  }
  } finally {
    killTree(own.proc);
  }
  return rows;
}

/** Every control means something in every view, or says why not. A click on
 *  width, wrap or Aa either changes what it sets or is dimmed and answers
 *  with the reason -- never the silence that `z` on a desk used to be. The
 *  desk is walked in a tab of its own, with a real panel, which is also
 *  where the terminal's text size is read back: the columns and rows the
 *  program is told, the caret over its character, and the character under
 *  a point being the one the cell grid says. */
async function controlRows(cdp, p, url, browsed, base, token) {
  const rows = [];
  const walk = async (drv, view) => {
    for (const [c, id] of [["wide", "#btn-wide"], ["wrap", "#btn-wrap"], ["font", "#btn-font"]]) {
      const read = `(() => { const d = document.documentElement, g = document.querySelector(".dk-grid");
        return [d.dataset.wide, d.dataset.wrap, d.dataset.font, g && g.dataset.zoom, localStorage.getItem("snyvi.term-size")].join("|"); })()`;
      const before = await drv.ev(read);
      await drv.ev(`document.querySelectorAll("#toasts .toast").forEach(t => t.remove()); 1`);
      await drv.hoverOn(".foot-set");
      await drv.clickOn(id);
      await sleep(250);
      const after = await drv.ev(read);
      const dim = await drv.ev(`(() => { const b = document.querySelector(${JSON.stringify(id)}); return b.classList.contains("dim") ? { label: [b.dataset.tip, b.dataset.tipSub].filter(Boolean).join(" · "), said: document.querySelector("#toasts .toast .s")?.textContent || "" } : null; })()`);
      const ok = dim ? !!dim.said && dim.label.endsWith(dim.said) && after === before : after !== before;
      rows.push([`${c} on ${view}`, ok, dim ? `dimmed: "${dim.label}"${after !== before ? ", and it changed something anyway" : ""}` : after !== before ? "it changed what it sets" : "not dimmed, and it changed nothing"]);
      // Back as it was: a second press for the toggles; Aa's steps are keys.
      await drv.pointerAway();
      await drv.ev(`(() => { const d = document.documentElement; delete d.dataset.font; localStorage.removeItem("snyvi.font"); return 1; })()`);
      // On a desk, width is full view, which folds the sidebar the button
      // sits in away: the way back is the key, as it is for a reader.
      if (!dim && c !== "font") {
        if (await drv.ev(`"full" in document.documentElement.dataset`)) await drv.press("z", { ctrl: true, alt: true });
        else { await drv.hoverOn(".foot-set"); await drv.clickOn(id); await drv.pointerAway(); }
      }
    }
  };
  await p.goto(url);
  await walk(p, "a prose document");
  await p.goto(`${browsed}/code.rs`);
  await sleep(400);
  await walk(p, "a code file");
  await p.goto(base + "/inbox");
  await walk(p, "the inbox");

  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}) => (await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "sizes" });
  const desk = d.desk ? d.desk.id : d.id;
  const panes = [(await post(`/api/desks/${desk}/panes`)).pane.id, (await post(`/api/desks/${desk}/panes`)).pane.id];
  // It says its size whenever it is told one, then leaves the caret after ">>".
  // By full path: the daemon's PATH here leaves out any directory holding a
  // snyvi-app, which on an installed machine is /usr/bin, sleep and stty too.
  const which = c => execFileSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).trim();
  const [stty, sleepBin] = [which("stty"), which("sleep")];
  for (const pane of panes) await post(`/api/panes/${pane}/start`, { cmd: `trap 'clear; ${stty} size; printf ">>"' WINCH; clear; ${stty} size; printf ">>"; while :; do ${sleepBin} 0.1; done` });
  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const size = `(() => { const t = document.querySelector(".dk .pn-scr")?.innerText || ""; const m = /(\\d+) (\\d+)/.exec(t); return m ? m[2] + "x" + m[1] : ""; })()`;
  try {
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    // The panes were started at 80x24 before the page fitted them: the size to
    // come back to is the one they settle at. A size, and not just "not
    // 80x24": the screen is empty for a moment while the panel is redrawn,
    // which once ended the wait before the fit, and ⌃0 then went back to
    // the fit and not to the 80x24 read too soon.
    await until(`(${size}) !== ""`);
    await until(`!["", "80x24"].includes(${size})`, 100);
    await sleep(300);
    const was = await q.ev(size);
    await walk(q, "a desk");
    await q.ev(`document.querySelector(".dk .pn-body").focus(); 1`);
    await q.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "0", code: "Digit0", windowsVirtualKeyCode: 48, modifiers: 2 }, q.s);
    await q.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "0", code: "Digit0", windowsVirtualKeyCode: 48, modifiers: 2 }, q.s);
    const back = await until(`(${size}) === ${JSON.stringify(was)}`);
    rows.push(["⌃0 in a panel puts it back", back, back ? `Aa stepped it, and ⌃0 told it ${was} again` : `told ${await q.ev(size)}, not ${was}`]);
    await q.hoverOn(".foot-set");
    await q.clickOn("#btn-font");
    await q.pointerAway();
    const grew = await until(`(${size}) !== "" && (${size}) !== ${JSON.stringify(was)}`);
    const now = await q.ev(size);
    rows.push(["Aa on a desk: the program's size", grew, grew ? `told ${was}, then ${now} at the next size up` : `still ${now || "nothing"} after a step up`]);
    const at = await q.ev(`(() => {
      const body = document.querySelector(".dk .pn-body"), caret = body.querySelector(".pn-caret"), scr = body.querySelector(".pn-scr");
      const row = [...scr.children].find(r => r.textContent.startsWith(">>"));
      if (!row) return null;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n, off = 2;
      while ((n = walker.nextNode()) && off > n.length) off -= n.length;
      const r = document.createRange(); r.setStart(n, off); r.setEnd(n, off);
      const want = r.getBoundingClientRect().left, got = caret.getBoundingClientRect().left;
      const cell = row.getBoundingClientRect(), mid = caret.getBoundingClientRect();
      const hit = document.caretRangeFromPoint(cell.left + (mid.left - cell.left) / 2 - 2, mid.top + mid.height / 2);
      return { want, got, ch: hit && hit.startContainer.textContent[hit.startOffset] };
    })()`);
    const caretOk = at && Math.abs(at.want - at.got) <= 1.5;
    rows.push(["the caret still on its character", !!caretOk, !at ? "no prompt row to read" : `caret at ${at.got.toFixed(1)} px, the character after ">>" at ${at.want.toFixed(1)} px`]);
    rows.push(["a point still finds its character", !!at && at.ch === ">", !at ? "no prompt row to read" : `the character under the first cell is "${at.ch}"`]);
  } finally {
    await q.ev(`localStorage.removeItem("snyvi.term-size"); 1`).catch(() => {});
    for (const pane of panes) await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** The window opens in the reader's theme, not in Paper and then theirs.
 *  First paint carries Paper and Ink only; boot.js paints any other theme
 *  from the copy the app kept of it. Each of the eight is chosen, and the
 *  page reloaded twice: with its copy, the first frame is already that
 *  theme's ground; without, it is Paper or Ink by side -- never a light
 *  frame on a dark choice -- and the theme follows when themes.css lands,
 *  with a fresh copy kept. The first frame is read by the first animation
 *  frame, which is not given until the page can be drawn. */
async function firstFrameRows(p, url) {
  const rows = [];
  const { identifier } = await p.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `requestAnimationFrame(() => {
    const d = document.documentElement; window.__first = { theme: d.dataset.theme, bg: getComputedStyle(d).getPropertyValue("--bg").trim(),
      later: !!document.querySelector('link[href*="themes.css"]') }; })` }, p.s);
  const THEMES = { paper: "light", snow: "light", sage: "light", parchment: "light", ink: "dark", midnight: "dark", espresso: "dark", contrast: "dark" };
  const settle = async () => { for (let i = 0; i < 40; i++) { if (await p.ev(`[...document.styleSheets].some(s => /themes\\.css/.test(s.href || ""))`)) break; await sleep(50); } await sleep(150); };
  try {
    await p.goto(url);
    for (const [name, side] of Object.entries(THEMES)) {
      await p.ev(`(async () => { document.querySelector("#btn-search").click();
        const i = document.querySelector("#palette-input"); i.value = "theme"; i.dispatchEvent(new Event("input", { bubbles: true }));
        for (let n = 0; n < 80 && !document.querySelector('#palette-list li.theme[data-theme="${name}"]'); n++) await new Promise(r => setTimeout(r, 25));
        document.querySelector('#palette-list li.theme[data-theme="${name}"]')?.click(); return 1; })()`);
      await sleep(150);
      const bg = await p.ev(`getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()`);
      await p.reload(); await settle();
      const kept = await p.ev(`({ ...window.__first, now: document.documentElement.dataset.theme })`);
      const core = name === "paper" || name === "ink";
      rows.push([`${name}, reopened`, kept.theme === name && kept.bg === bg && !kept.later && kept.now === name,
        kept.theme !== name ? `the first frame was ${kept.theme}` : kept.bg !== bg ? `the first frame's ground was ${kept.bg}, not ${bg}` : kept.later ? "themes.css was already in the page" : core ? "in first paint itself" : "from its kept copy, before themes.css"]);
      if (core) continue;
      await p.ev(`localStorage.removeItem("snyvi.theme.css.light"); localStorage.removeItem("snyvi.theme.css.dark"); 1`);
      await p.reload(); await settle();
      const cold = await p.ev(`({ ...window.__first, now: document.documentElement.dataset.theme, copy: !!localStorage.getItem("snyvi.theme.css.${side}") })`);
      const stand = side === "dark" ? "ink" : "paper";
      rows.push([`${name}, with no copy`, cold.theme === stand && cold.now === name && cold.copy,
        cold.theme !== stand ? `the first frame was ${cold.theme}, not ${stand}` : cold.now !== name ? `it stayed ${cold.now}` : !cold.copy ? "no copy was kept for next time" : `${stand} first, then ${name}, and a copy kept`]);
    }
  } finally {
    await p.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, p.s).catch(() => {});
    await p.ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("snyvi.theme")) localStorage.removeItem(k); snyviTheme.apply(); return 1; })()`);
  }
  return rows;
}

async function motionRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const anims = () => p.ev(`document.getAnimations().map(a => ({ name: a.animationName || a.transitionProperty || "", ms: Number(a.effect.getTiming().duration), n: a.effect.getTiming().iterations }))`);

  await p.goto(url);
  await p.pointerAway();
  // From nothing waiting, so the first arrival is what makes the bar appear
  // and the oldest \`n\` opens; the sections before this one leave a queue.
  await p.ev(`fetch("/api/queue/clear", { method: "POST" })`);
  await until(`document.querySelector("#queue-bar").hidden`);
  const first = await arrive();
  await until(`!document.querySelector("#queue-bar").hidden`);
  await p.ev(`window.__bar = document.querySelector("#queue-bar .qb")`);
  const washed = await p.ev(`(() => { const li = document.querySelector('#queue li.t-doc.wash:has(> a[data-id="${first.id}"])'); return li ? li.getAnimations().filter(x => x.animationName === "land").length : -1; })()`);
  rows.push(["an arrival washes its row", washed === 1, washed < 0 ? "the row is not marked as washed" : `${washed} wash animation${washed === 1 ? "" : "s"} on the row`]);

  // A second arrival 300 ms in rebuilds every row. The first one's wash
  // carries on from where it was: a restart would read near zero. Where a
  // wash is, is its time less its delay -- a negative delay is how the page
  // resumes it, and the animation's own clock restarts from zero.
  await sleep(300);
  const second = await arrive();
  await until(`/^1\\/2/.test(document.querySelector("#queue-bar").textContent)`);
  const resumed = await p.ev(`(() => { const li = document.querySelector('#queue li.wash:has(> a[data-id="${first.id}"])'); const w = li && li.getAnimations().find(x => x.animationName === "land"); return w ? Math.round(w.currentTime - w.effect.getTiming().delay) : -1; })()`);
  rows.push(["once, whatever the tree does under it", resumed >= 250 && resumed < 700, resumed < 0 ? "the wash is gone or was never there" : `the wash is ${resumed} ms in, on a row rebuilt by the next arrival`]);
  const bar = await p.ev(`(() => { const qb = document.querySelector("#queue-bar .qb"); const n = qb && qb.querySelector(".qb-n");
    return { kept: qb === window.__bar, rise: qb ? qb.getAnimations().some(a => a.animationName === "rise") : null, tick: n ? n.classList.contains("tick") || n.getAnimations().some(a => a.animationName === "tick") : null }; })()`);
  // The tick is 180 ms, over before a slow machine gets here; the class the
  // page put on the new count says it ran.
  rows.push(["the bar stays put and the count ticks", bar.kept && !bar.rise && bar.tick,
    !bar.kept ? "the bar was rebuilt for the second arrival" : bar.rise ? "the bar rose again" : !bar.tick ? "the count changed with nothing to say so" : "the same bar, and the new count settled in"]);

  const running = await anims();
  const long = running.filter(a => a.ms > 700 || a.n === Infinity);
  rows.push(["nothing runs long", running.length > 0 && long.length === 0,
    !running.length ? "nothing is animating at all, which the rows above say is wrong" : long.length ? `${long.map(a => `${a.name} ${a.n === Infinity ? "forever" : a.ms + " ms"}`).join(", ")}` : `${running.length} animations running, the longest ${Math.max(...running.map(a => a.ms))} ms`]);

  // \`n\` opens the oldest: its row is drawn closing, briefly, then gone.
  // \`void\`: the harness awaits a promise an expression returns, and this one
  // is meant to be read after the key, not before it.
  await p.ev(`void (window.__left = new Promise(r => { const t = setTimeout(() => r(null), 2000); new MutationObserver((_, o) => { const li = document.querySelector("#queue li.leaving"); if (li) { clearTimeout(t); o.disconnect(); r({ id: li.querySelector("a").dataset.id, anim: li.getAnimations().some(a => a.animationName === "leave") }); } }).observe(document.querySelector("#queue"), { childList: true, subtree: true, attributes: true }); }))`);
  await p.press("n");
  const left = await p.ev(`window.__left`);
  await sleep(400);
  const after = await p.ev(`({ leaving: document.querySelectorAll("#queue li.leaving").length, there: !!document.querySelector('#queue a[data-id="${first.id}"]') })`);
  rows.push(["a read closes its row where it was", !!left && left.id === first.id && left.anim && !after.leaving && !after.there,
    !left ? "the row was gone with nothing drawn" : left.id !== first.id ? "a different row was drawn closing" : !left.anim ? "the row was marked but not moving" : after.leaving || after.there ? "the row is still there 400 ms later" : "drawn closing, and gone 400 ms later"]);

  // The \`#\` beside a heading says it copied, itself, and raises no toast.
  // Back on the plan: \`n\` opened the arrival, which is one heading long.
  await p.goto(url);
  const toasts = await p.ev(`document.querySelectorAll("#toasts .toast").length`);
  await p.clickOn(".prose h2 a.anchor");
  const said = await p.ev(`({ said: document.querySelector(".prose a.anchor[data-said]")?.dataset.said || null, toasts: document.querySelectorAll("#toasts .toast").length })`);
  rows.push(["the # says it copied, itself", said.said === "Copied" && said.toasts === toasts,
    said.said !== "Copied" ? "the mark says nothing" : said.toasts !== toasts ? "and a toast came up as well" : "the mark reads Copied for a moment, and no toast"]);

  // Under reduced motion there is no motion: not slower, none.
  await p.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, p.s);
  await arrive();
  await until(`/^1\\/2/.test(document.querySelector("#queue-bar").textContent)`);
  const quiet = await anims();
  await p.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] }, p.s);
  rows.push(["reduced motion means none", quiet.length === 0, quiet.length ? `${quiet.length} still running: ${[...new Set(quiet.map(a => a.name))].join(", ")}` : "no animation on the page at all"]);

  // None, and nothing lost to it: what used to show only by fading in (the
  // skeleton) still shows, and an Undo's clock still stops under the hand.
  const media = v => p.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: v }] }, p.s);
  await media("reduce");
  const sk = await p.ev(`(() => { const b = document.createElement("span"); b.className = "sk-bar"; document.body.append(b); const o = +getComputedStyle(b).opacity; b.remove(); return o; })()`);
  await media("");
  rows.push(["skeleton visible under reduced motion", sk > 0.03, sk > 0.03 ? `the bars rest at ${sk}` : `the bars are at ${sk}: the wait shows nothing`]);
  const origin = await p.ev("location.origin"), held = {};
  for (const mode of ["reduce", ""]) {
    await media(mode);
    const d = await arrive();
    await p.goto(`${origin}/d/${d.id}`);
    await p.pointerAway();
    await p.press("Delete");
    for (let i = 0; i < 40 && !(await p.ev(`!!document.querySelector("#trees .t-ghost .t-undo")`)); i++) await sleep(100);
    await sleep(500);
    await p.ev(`document.querySelector("#trees .t-ghost .t-undo")?.focus()`);
    await sleep(6000);
    held[mode || "full"] = await p.ev(`!!document.querySelector("#trees .t-ghost .t-undo")`);
    await p.ev(`document.activeElement?.blur()`);
  }
  await media("");
  rows.push(["ghost Undo still there after 6 s with focus on it, both motion modes", held.reduce && held.full,
    held.reduce && held.full ? "the clock held while the focus rested on the Undo, with motion and without" : `gone after 6 s under focus with ${[!held.reduce && "reduced motion", !held.full && "full motion"].filter(Boolean).join(" and ")}`]);
  void second;
  return rows;
}

/** 1.17: a save costs a render. An agent saving a file in the open project
 *  reaches the page as one event, and the page draws the project the event
 *  carries: nothing fetched, the sidebar drawn once, and the draw reading
 *  the page's layout before it writes rather than after. And the pointer
 *  crossing the sidebar fetches nothing until it rests on a row. The audit
 *  of 1.15 counted the same save at two to four requests, two draws and two
 *  to four forced layouts, and a document fetched for every row the pointer
 *  crossed on its way to one. */
async function costRows(p, url, base, token, tmp, arrive) {
  const rows = [];
  // A second file in the plan's project, saved the way a watched file is:
  // once to exist, and again under the probe, so that save lands in place
  // (`existing`) the way an agent's edits do.
  const other = join(tmp, "other.md");
  const save = async n => {
    writeFileSync(other, `# Another file\n\nSaved ${n} times.\n`);
    const r = await fetch(`${base}/api/docs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: other, cwd: tmp, origin: "watch" }),
    });
    if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
    return r.json();
  };
  await save(1);
  await p.goto(url);
  await p.pointerAway();
  await sleep(600);
  // Counted at the source: every GET under /api, every draw of the sidebar
  // (the page counts its own, see prelude), and every read of layout that
  // follows a write to the DOM before a frame has settled it -- which is
  // what makes the browser lay the page out on the spot. The frame loop
  // clears the mark the way the browser's own layout at the end of a frame
  // does, so a read in a later frame is not charged.
  await p.ev(`(() => {
    const C = window.__cost = { api: [], forced: 0, dirty: false, renders: window.__perf.renders };
    const real = window.fetch;
    window.fetch = function (u, o) {
      const at = new URL(u instanceof Request ? u.url : u, location.href).pathname;
      if (at.startsWith("/api/") && ((o && o.method) || "GET").toUpperCase() === "GET") C.api.push(at);
      return real.apply(this, arguments);
    };
    const read = () => { if (C.dirty) { C.forced++; C.dirty = false; } };
    const write = (proto, name) => { const d = Object.getOwnPropertyDescriptor(proto, name); Object.defineProperty(proto, name, { ...d, set(v) { C.dirty = true; d.set.call(this, v); } }); };
    write(Element.prototype, "innerHTML"); write(Element.prototype, "outerHTML"); write(Node.prototype, "textContent");
    const prop = (proto, name) => { const d = Object.getOwnPropertyDescriptor(proto, name); Object.defineProperty(proto, name, { ...d, get() { read(); return d.get.call(this); } }); };
    for (const n of ["clientWidth", "clientHeight", "scrollTop", "scrollHeight"]) prop(Element.prototype, n);
    for (const n of ["offsetWidth", "offsetHeight", "offsetTop"]) prop(HTMLElement.prototype, n);
    for (const n of ["getBoundingClientRect", "getClientRects"]) { const f = Element.prototype[n]; Element.prototype[n] = function () { read(); return f.apply(this, arguments); }; }
    const gcs = window.getComputedStyle; window.getComputedStyle = function () { read(); return gcs.apply(this, arguments); };
    const frame = () => requestAnimationFrame(() => setTimeout(() => { C.dirty = false; frame(); }, 0));
    frame();
    return 1;
  })()`);
  const saved = await save(2);
  await sleep(1200);
  // The requests the finding named: the tree, a project's rows, a document
  // and its versions. Anything else under /api is printed, not charged.
  const c = await p.ev(`({ api: window.__cost.api, forced: window.__cost.forced, renders: window.__perf.renders - window.__cost.renders })`);
  const tree = c.api.filter(a => /^\/api\/(tree|projects\/|workflows\/|docs\/|queue)/.test(a));
  dbg("save", { saved: saved.existing, c });
  rows.push(["a save fetches nothing", saved.existing === true && tree.length === 0,
    !saved.existing ? "the save made a new version instead of landing in place"
      : tree.length ? `${tree.length} fetched: ${tree.join(", ")}` : `the event carried the project, and the page asked for nothing${c.api.length ? ` (${c.api.join(", ")} aside)` : ""}`]);
  rows.push(["and draws the sidebar once", c.renders === 1, `${c.renders} draw${c.renders === 1 ? "" : "s"} for one event`]);
  rows.push(["reading layout once, before it writes", c.forced <= 1, `${c.forced} layout${c.forced === 1 ? "" : "s"} forced by a read after a write`]);

  // The pointer across the rows, one every 50 ms, which is what a hand on
  // its way to a row does to the rows on the way. Over documents this page
  // has never fetched -- arrivals, whose cache entry the page drops -- so a
  // fetch would show. Then it rests on the last, and that one may come.
  // How long the pointer sat on each row is read on the page's own clock:
  // a busy runner can stretch a 50 ms step past the 150 ms rest, and a row
  // the pointer truly rested on may be fetched. Only rows crossed under
  // 140 ms are charged.
  const fresh = [];
  for (let i = 0; i < 8; i++) fresh.push((await arrive({ name: `sweep-${i}.md`, body: `# Swept ${i}\n\nA row the pointer crosses.\n` })).id);
  for (let i = 0; i < 40 && !(await p.ev(`!!document.querySelector('#trees a[data-id="${fresh[fresh.length - 1]}"]')`)); i++) await sleep(100);
  await sleep(400);
  const swept = (await p.ev(`[...document.querySelectorAll("#trees a[data-id]")].map(a => a.dataset.id)`)).filter(id => fresh.includes(id));
  const ids = [...new Set(swept)];
  await p.ev(`(() => {
    window.__cost.api.length = 0;
    const S = window.__sweep = [];
    document.addEventListener("mouseover", e => {
      const id = e.target.closest?.("a[data-id]")?.dataset.id || null;
      if (!S.length || S[S.length - 1][0] !== id) S.push([id, performance.now()]);
    }, true);
    return 1;
  })()`);
  for (const id of ids) {
    const at = await p.ui("center", `a[data-id="${id}"]`);
    await p.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, p.s);
    await sleep(50);
  }
  await p.pointerAway();
  await sleep(400);
  const sweep = await p.ev(`window.__sweep.slice()`);
  const dwell = new Map();
  sweep.forEach(([id, t], i) => { if (id && sweep[i + 1]) dwell.set(id, Math.max(dwell.get(id) || 0, sweep[i + 1][1] - t)); });
  const quick = ids.filter(id => dwell.has(id) && dwell.get(id) < 140);
  const crossed = (await p.ev(`window.__cost.api.slice()`)).filter(a => a.startsWith("/api/docs/") && quick.includes(a.split("/")[3]));
  const slow = ids.length - quick.length;
  rows.push(["a sweep over the rows fetches nothing", ids.length >= 6 && quick.length >= 4 && crossed.length === 0,
    ids.length < 6 ? `only ${ids.length} fresh rows on screen to sweep`
      : quick.length < 4 ? `only ${quick.length} of ${ids.length} rows crossed under 140 ms, too slow a sweep to judge`
      : crossed.length ? `${crossed.length} documents fetched for ${quick.length} rows crossed under 140 ms`
      : `${quick.length} rows crossed under 140 ms, nothing fetched${slow ? ` (${slow} the runner held longer, not charged)` : ""}`]);
  await p.ev(`window.__cost.api.length = 0`);
  await p.hoverOn(`a[data-id="${ids[ids.length - 1]}"]`);
  await sleep(400);
  const rested = (await p.ev(`window.__cost.api.slice()`)).filter(a => a.startsWith("/api/docs/"));
  rows.push(["resting on one fetches that one", rested.length === 1 && rested[0].endsWith(`/${ids[ids.length - 1]}`),
    rested.length === 1 ? "the row the pointer rested on, and only that" : `${rested.length} fetched: ${rested.join(", ") || "nothing"}`]);
  return rows;
}

main().catch(e => { console.error(e.message); process.exit(1); });

/** 0.18: the one thing that cannot be undone asks for a number. The button
 *  is dead until the number of documents is typed back; a document that
 *  arrives while the dialog is open makes the number stale and the daemon
 *  refuses; and what a reset leaves is the page a newcomer sees, with
 *  nothing remembered for the reader who was here before. */
/** One panel inside `?`, and everything on it read from the daemon when it
 *  opens, so the version it names is the one answering. */
/** 1.7.1: the first ten minutes. `?` answers with the letters asleep, the
 *  page has its six sections, each Show me lights exactly its element and
 *  moves nothing, the samples wear the real rules, and snyvi's own aside
 *  says its line once. */
async function startRows(p, url, arrive, base) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  await p.goto(url);
  await p.pointerAway();
  await p.press("?", { raw: true });
  const asleep = await p.ev(`!document.body.classList.contains("keys")`);
  const help = await p.ui("vis", "#help");
  rows.push(["? opens the keys with the letters asleep", asleep && help, !asleep ? "the letters were awake" : help ? "the box is up" : "nothing opened"]);
  await p.clickOn("#btn-start");
  const drawn = await until(`document.querySelectorAll(".start .start-sec").length === 6`);
  const ids = await p.ev(`[...document.querySelectorAll(".start .start-sec")].map(s => s.id).join(" ")`);
  rows.push(["/start has its six sections", drawn && ids === "desks arrives waiting notes versions keys" && (await p.ev("location.pathname")) === "/start",
    drawn ? ids : "the page did not draw"]);

  // Each Show me: exactly one element lit, nothing else moved.
  const before = await p.ev(`({ url: location.href, focus: document.activeElement?.id || document.activeElement?.tagName })`);
  const lit = [], broke = [];
  for (const k of ["arrives", "waiting", "desks", "notes", "keys"]) {
    const has = await p.ev(`!!document.querySelector('.start .show-me[data-show="${k}"]')`);
    if (!has) { const why = await p.ev(`document.querySelector("#${k} .show-none")?.textContent || ""`); if (!why && k !== "keys") broke.push(`${k}: no link and no reason`); continue; }
    await p.ev(`document.querySelector('.start .show-me[data-show="${k}"]').click(); 1`);
    const n = await p.ev(`document.querySelectorAll(".show-lit").length`);
    if (n !== 1) broke.push(`${k}: ${n} lit`); else lit.push(k);
    await sleep(1600);
  }
  const after = await p.ev(`({ url: location.href, focus: document.activeElement?.id || document.activeElement?.tagName })`);
  rows.push(["each Show me lights one thing and moves nothing", broke.length === 0 && lit.length >= 2 && after.url === before.url && after.focus === before.focus,
    broke.length ? broke.join("; ") : after.url !== before.url ? `went to ${after.url}` : after.focus !== before.focus ? `focus moved to ${after.focus}` : `lit ${lit.join(", ")}; the rest say why not`]);

  // The samples wear the page's own rules: a real diff's colours, the pill's.
  const sample = await p.ev(`(() => { const c = s => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : ""; };
    const pill = document.querySelector(".keymode-sample");
    return { add: c(".start-sample .add"), del: c(".start-sample .del"), pill: c(".keymode-sample"), pos: pill ? getComputedStyle(pill).position : "", inert: document.querySelectorAll(".start [inert]").length }; })()`);
  const want = await p.ev(`(() => { const pre = document.createElement("pre"); pre.className = "diff"; pre.innerHTML = '<code><span class="ln add">+</span><span class="ln del">-</span></code>'; document.body.append(pre);
    const r = { add: getComputedStyle(pre.querySelector(".add")).backgroundColor, del: getComputedStyle(pre.querySelector(".del")).backgroundColor, raise: getComputedStyle(document.body).getPropertyValue("--bg-raise") }; pre.remove(); return r; })()`);
  rows.push(["the samples are drawn with the page's rules, inert", sample.add === want.add && sample.del === want.del && !!sample.pill && sample.pos === "static" && sample.inert >= 3,
    sample.add !== want.add || sample.del !== want.del ? `the hunk is ${sample.add}/${sample.del}, a diff ${want.add}/${want.del}` : !sample.pill ? "the pill sample has no look"
      : sample.pos !== "static" ? `the pill sample is ${sample.pos}, not in the page's flow` : `${sample.inert} inert samples, in the reader's colours`]);

  // about.js's sheet stays once fetched: a danger row in the context menu
  // must still read, red on its own background and not on red.
  await p.ev(`(() => { const a = document.querySelector("#tree a[data-id]"), r = a.getBoundingClientRect();
    a.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 4 })); return 1; })()`);
  await until(`!!document.querySelector("#ctx:not([hidden]) button.danger")`, 30);
  const danger = await p.ev(`(() => { const b = document.querySelector("#ctx:not([hidden]) button.danger"); if (!b) return null; const s = getComputedStyle(b); return { label: b.textContent, fg: s.color, bg: s.backgroundColor }; })()`);
  await p.press("Escape");
  rows.push(["a menu's danger row reads after about.js has loaded", !!danger && danger.fg !== danger.bg && !/^rgb\(/.test(danger.bg),
    !danger ? "no danger row in a document's menu" : danger.fg === danger.bg || /^rgb\(/.test(danger.bg) ? `"${danger.label}" is ${danger.fg} on ${danger.bg}` : `"${danger.label}" in ${danger.fg}, on no fill`]);

  // snyvi's own aside: said once, when two are waiting, and never over an
  // agent's that is still unread.
  // From the page, as note.js asks it: a reader's action needs our Origin.
  await p.ev(`fetch("/api/notes/seen", { method: "POST" }).then(r => r.status)`);
  await p.ev(`Object.keys(localStorage).filter(k => k.startsWith("snyvi.seen.")).forEach(k => localStorage.removeItem(k)); 1`);
  await p.goto(url);
  await arrive(); await arrive();
  const said = await until(`/^Two are waiting/.test(document.querySelector("#note .note-now p")?.textContent || "")`, 40);
  await p.ev(`document.querySelector("#note [data-note-x]")?.click(); 1`);
  await sleep(4500);
  await arrive();
  await sleep(800);
  const again = await p.ev(`/^Two are waiting/.test(document.querySelector("#note .note-now p")?.textContent || "")`);
  rows.push(["snyvi says its own line once", said && !again, !said ? "no aside when two were waiting" : again ? "it said it again" : "once, pointing at the first ten minutes"]);
  return rows;
}

async function aboutRows(p, url) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  await p.goto(url);
  await p.pointerAway();
  await p.press("?");
  const offered = (await p.ui("vis", "#help")) && (await p.ui("vis", "#btn-about"));
  await p.clickOn("#btn-about");
  const opened = await until(`!document.querySelector("#about").hidden && document.querySelector("#about-facts dd") !== null`);
  const helpGone = await p.ev(`document.querySelector("#help").hidden`);
  rows.push(["? opens it", offered && opened && helpGone, !offered ? "no About in the help box" : !opened ? "the panel did not open, or said nothing" : !helpGone ? "the help box stayed open behind it" : "one line in the help box, one panel in its place"]);

  const served = await p.ev(`fetch("/api/about").then(r => r.json())`);
  const facts = await p.ev(`Object.fromEntries([...document.querySelectorAll("#about-facts dt")].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))`);
  const version = (facts.Version || "").startsWith(served.version) && (!served.commit || facts.Version.includes(served.commit));
  const dirs = facts.Documents === served.data_dir && facts.Settings === served.config_dir;
  const agents = facts.Agents === served.agents && /^Claude Code:/.test(facts.Agents);
  const source = await p.ev(`(() => { const a = [...document.querySelectorAll("#about-facts dt")].find(dt => dt.textContent === "Source")?.nextElementSibling.querySelector("a"); return a && a.href === ${JSON.stringify(served.repository)} && a.target === "_blank"; })()`);
  rows.push(["and it says what the daemon says", version && dirs && agents && source && facts.License === "MIT",
    !version ? `version "${facts.Version}" for a daemon serving ${served.version} ${served.commit}` : !dirs ? "the directories are not the daemon's" : !agents ? `agents line "${facts.Agents}"` : !source ? "the source link is wrong or missing" : `${facts.Version}, both directories, the agents line, MIT, the repository`]);

  await p.press("Escape");
  const closed = await until(`document.querySelector("#about").hidden && !document.querySelector("#app").inert`);
  rows.push(["Escape closes it", closed, closed ? "and the page is live again" : "still open, or the page still inert"]);
  return rows;
}

/** The page the empty library is: one row per agent, each read from the
 *  agent's own file by the daemon, turning as the file does. */
async function connectRows(p, url, home, env) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const stateOf = id => p.ev(`document.querySelector('.agent[data-agent="${id}"]')?.className.replace(/.*is-(\\w+).*/, "$1")`);

  await p.goto(url);
  await p.pointerAway();
  await p.press("?");
  const offered = await p.ui("vis", "#btn-connect");
  await p.clickOn("#btn-connect");
  const opened = await until(`location.pathname === "/connect" && document.querySelectorAll(".connect .agent").length >= 8`);
  const served = await p.ev(`fetch("/api/agents").then(r => r.json())`);
  const names = await p.ev(`[...document.querySelectorAll(".agent-name")].map(e => e.textContent)`);
  // Claude Code and whatever has been set up or has sent first; the rest in
  // the daemon's order under "Using a different agent?".
  const first = r => r.id === "claude" || r.id.startsWith("sender:") || (r.state && r.state !== "not_set_up") || r.live;
  const order = [...served.rows.filter(first), ...served.rows.filter(r => !first(r))].map(r => r.name);
  const same = opened && names[0] === "Claude Code" && JSON.stringify(names) === JSON.stringify(order);
  const allOff = same && (await p.ev(`[...document.querySelectorAll(".agent:not([data-agent^='sender:'])")].every(e => e.classList.contains("is-off"))`));
  rows.push(["? reaches it, one row per agent", offered && same && allOff,
    !offered ? "no Connect an agent in the help box" : !opened ? "the page did not open" : !same ? `rows ${JSON.stringify(names)}` : !allOff ? "a row is not 'not set up' in a home that has never seen an agent" : `${names.length} rows, Claude Code first, every agent not set up`]);

  const sender = await p.ev(`(() => { const e = document.querySelector('.agent[data-agent="sender:bench-agent"]'); return e && e.classList.contains("is-connected") && /sent/.test(e.querySelector(".agent-state").textContent); })()`);
  rows.push(["a sender it never heard of has a row", !!sender, sender ? "bench-agent, connected, with when it sent" : "no row for the MCP client that sent under its own name"]);

  // A Cursor file appears with snyvi under a path that is gone, then the fix
  // is run in a terminal: the row turns twice, without a reload.
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, snyvi: { command: "/gone/snyvi", args: ["mcp"] } } }));
  const stale = await until(`document.querySelector('.agent[data-agent="cursor"]')?.classList.contains("is-stale")`, 60);
  const says = stale && await p.ev(`document.querySelector('.agent[data-agent="cursor"] .agent-say').textContent`);
  const fixShown = stale && await p.ev(`/init cursor$/.test(document.querySelector('.agent[data-agent="cursor"] .agent-fix code').textContent)`);
  execFileSync(BIN, ["init", "cursor"], { env, encoding: "utf8" });
  const connected = await until(`document.querySelector('.agent[data-agent="cursor"]')?.classList.contains("is-connected")`, 60);
  const kept = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.other?.command === "x";
  rows.push(["a row turns as its file does", stale && fixShown && connected && kept,
    !stale ? `Cursor stayed "${await stateOf("cursor")}" after its file named a path that is gone` : !fixShown ? "the fix is not the init command" : !connected ? "init cursor ran and the row did not turn" : !kept ? "the other server in the file was lost" : `needs fixing — "${says}" — then connected, the other entry kept`]);

  // Codex is under "Using a different agent?", folded: opened as a reader would.
  if (!(await p.ev(`!!document.querySelector(".agents-more")?.open`))) await p.clickOn(".agents-more > summary");
  const copyThere = await p.ui("vis", '.agent[data-agent="codex"] .agent-fix .copy');
  if (copyThere) await p.clickOn('.agent[data-agent="codex"] .agent-fix .copy');
  const copied = copyThere && await until(`document.querySelector('.agent[data-agent="codex"] .agent-fix .copy')?.textContent === "Copied"`, 10);
  rows.push(["Copy says it copied", copied, copied ? "the button reads Copied for a moment" : !copyThere ? `no Copy button in codex's fix line, on ${await p.ev("location.pathname")}` : "the button did not change"]);

  await p.press("ArrowLeft", { alt: true });
  const back = await until(`location.pathname !== "/connect" && !!document.querySelector(".prose")`);
  rows.push(["Back leaves it", back, back ? "the document is back on screen" : `still on ${await p.ev("location.pathname")}`]);
  return rows;
}

/** 0.19: who is here now. The MCP server holds an event stream on the daemon
 *  under its client's name from `initialize` until its process ends, so the
 *  count beside the brand mark says how many agents are connected this
 *  moment and the connect page says which -- not only who last sent, and
 *  when. These rows run a real `snyvi mcp`, keep its stdin open, and end it. */
async function presenceRows(p, url, base, env, tmp) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  // What it says is its tip now: the count's name, and who, under it.
  const live = () => p.ev(`(e => ({ n: e.textContent, on: e.classList.contains("on"), title: [e.dataset.tip, e.dataset.tipSub].filter(Boolean).join(" · ") }))(document.querySelector("#live"))`);
  const health = async () => (await (await fetch(`${base}/api/health`)).json());

  await p.goto(url);
  const none = await live();
  rows.push(["none, and the count says none", none.n === "0" && !none.on && /no agent/i.test(none.title),
    none.n === "0" && !none.on ? `"0", dim, "${none.title}"` : `the count reads "${none.n}"${none.on ? ", lit" : ""} with no agent on the daemon`]);

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "bench-agent", version: "0" } } };
  const agent = spawn(BIN, ["mcp"], { env, cwd: tmp, stdio: ["pipe", "ignore", "ignore"] });
  agent.stdin.write(JSON.stringify(init) + "\n");
  const lit = await until(`document.querySelector("#live").textContent === "1" && document.querySelector("#live").classList.contains("on")`, 40);
  const one = await live();
  const h = await health();
  rows.push(["one arrives, and the count turns", lit && h.agents["bench-agent"] === 1 && /bench-agent/.test(one.title),
    !lit ? `the count reads "${one.n}" 4 s after an agent initialized` : h.agents["bench-agent"] !== 1 ? `health says ${JSON.stringify(h.agents)}` : `"1", lit, "${one.title}", and health agrees`]);

  await p.clickOn("#live");
  const row = await until(`location.pathname === "/connect" && document.querySelector('.agent[data-agent="sender:bench-agent"]')?.classList.contains("is-live") && /^running now/.test(document.querySelector('.agent[data-agent="sender:bench-agent"] .agent-state').textContent)`, 40);
  const said = row && await p.ev(`document.querySelector('.agent[data-agent="sender:bench-agent"] .agent-state').textContent`);
  rows.push(["the count opens the rows, and its row says running now", row, row ? `the connect page, bench-agent "${said}"` : `at ${await p.ev("location.pathname")}, the row does not say running now`]);

  agent.stdin.end();
  const fell = await until(`document.querySelector("#live").textContent === "0" && !document.querySelector('.agent[data-agent="sender:bench-agent"]')?.classList.contains("is-live")`, 40);
  const after = await health();
  rows.push(["and leaves, and the count falls", fell && !after.agents["bench-agent"],
    fell ? "0 again, and the row no longer says online, within 4 s of the agent's end" : `the count reads "${(await live()).n}" 4 s after the agent's stdin closed; health says ${JSON.stringify(after.agents)}`]);
  await p.goto(url);
  return rows;
}

async function resetRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const goDisabled = () => p.ev(`document.querySelector("#reset-go").disabled`);
  const say = () => p.ev(`document.querySelector("#reset-say").textContent`);

  await p.goto(url);
  await p.press("w");   // a preference to be forgotten
  await p.pointerAway();
  await p.press("?");
  const offered = (await p.ui("vis", "#help")) && (await p.ui("vis", "#btn-reset"));
  rows.push(["? offers it, and nothing else does", offered && !(await p.ev(`[...document.querySelectorAll("#chrome button, #side button")].some(b => /reset/i.test(b.textContent))`)),
    offered ? "one line at the foot of the help box, no key, no button in the chrome" : "no Reset in the help box"]);

  await p.clickOn("#btn-reset");
  const opened = await until(`!document.querySelector("#reset").hidden && /This deletes \\d+ documents? in/.test(document.querySelector("#reset-say").textContent)`);
  const census = await p.ev(`fetch("/api/reset").then(r => r.json())`);
  const focused = await p.ui("at", "#reset-n");
  const tt = await p.ev(`(() => { const h = document.querySelector("#reset-title"); return { t: getComputedStyle(h).textTransform, s: h.textContent }; })()`);
  rows.push(["reset title in sentence case", tt.t === "none" && tt.s === "Reset snyvi", tt.t === "none" ? `"${tt.s}"` : `drawn ${tt.t}`]);
  rows.push(["the dialog says what goes", opened && focused && (await say()).includes(`${census.documents} document`) && (await say()).includes("Agents stay") && await goDisabled(),
    !opened ? "the dialog did not open, or said nothing" : !focused ? "focus is not in the number field" : `"${await say()}", the button dead, the cursor in the field`]);

  await p.type(String(census.documents + 1));
  const wrongDead = await goDisabled();
  await p.ev(`(() => { const i = document.querySelector("#reset-n"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await p.type(String(census.documents));
  const rightLive = !(await goDisabled());
  rows.push(["the button waits for the number", wrongDead && rightLive, !wrongDead ? "enabled for the wrong number" : !rightLive ? "still dead for the right one" : `dead for ${census.documents + 1}, live for ${census.documents}`]);

  await arrive();
  await sleep(300);
  await p.press("Enter");
  const refused = await until(`!document.querySelector("#reset-err").hidden && /^Could not reset · 1 document arrived since you looked · type \\d+$/.test(document.querySelector("#reset-err").textContent)`);
  const stillHere = !(await p.ev(`document.querySelector("#reset").hidden`)) && (await p.ev(`fetch("/api/reset").then(r => r.json()).then(c => c.documents)`)) === census.documents + 1;
  const reasked = (await say()).includes(`${census.documents + 1} document`) && await goDisabled();
  rows.push(["a stale number is refused", refused && stillHere && reasked,
    !refused ? "nothing said, or the wrong thing" : !stillHere ? "the library was reset on a number that was no longer true" : !reasked ? "the sentence was not brought up to date" : "refused, the sentence says the new number, and the button is dead again"]);

  await p.type(String(census.documents + 1));
  await p.press("Enter");
  // A newcomer's window, with no desk: Welcome, at the inbox's address.
  const landed = await until(`location.pathname === "/" && !!document.querySelector(".welcome")`, 80);
  const left = landed ? await p.ev(`(() => { try { return Object.keys(localStorage).filter(k => k.startsWith("snyvi.")); } catch { return []; } })()`) : [];
  const forgotten = landed && left.length === 0;
  const wideOff = landed && !(await p.ev(`document.documentElement.dataset.wide`));
  const empty = (await p.ev(`fetch("/api/reset").then(r => r.json()).then(c => c.documents)`)) === 0;
  // The agents were not touched: the row the connect rows turned is still connected.
  const stillConnected = landed && await p.ev(`fetch("/api/agents").then(r => r.json()).then(a => a.rows.find(r => r.id === "cursor")?.state === "connected")`);
  rows.push(["and lands where a newcomer does", landed && forgotten && wideOff && empty && stillConnected,
    !landed ? `on "${await p.ev("location.pathname")}" with title "${await p.ev("document.title")}"` : !forgotten ? `still in the page's storage: ${left.join(", ")}` : !wideOff ? "the width preference survived" : !empty ? "the daemon still has documents" : !stillConnected ? "the Cursor row no longer says connected" : "Welcome, the width forgotten, nothing in storage, Cursor still connected"]);
  return rows;
}

/** 0.19: a page outlives the daemon that served it -- `snyvi stop`, an
 *  upgrade taking the port -- and has to know. The stream used to outlive the
 *  daemon instead: a graceful shutdown waits for every response in flight,
 *  and a stream that never ends kept the old process up, listening on
 *  nothing, with the window still on it. The daemon that took the port then
 *  counted no window and handed every agent a link, one browser tab per
 *  document. Seen for ten hours on the machine this was written on. */
async function stopRows(p, base, tmp, env, second) {
  const rows = [];
  const health = async () => { try { return await (await fetch(`${base}/api/health`)).json(); } catch { return null; } };
  const until = async (fn, tries = 50) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(100); } return false; };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const before = await health();
  const token = readFileSync(join(tmp, "config", "token"), "utf8").trim();
  // Leaving is the window's to ask for, not the agent's token's (server/auth.rs).
  await fetch(`${base}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-snyvi-window": windowSecret } });
  const gone = await until(() => !alive(before.pid), 30);
  rows.push(["the daemon exits with a page on it", gone, gone ? `pid ${before.pid} gone within 3 s, ${before.streams} stream${before.streams === 1 ? "" : "s"} open on it` : `pid ${before.pid} is still up 3 s after it was asked to stop`]);

  const said = await until(() => p.ev(`document.documentElement.dataset.link === "off"`));
  rows.push(["and the page says so", said, said ? "the brand mark went hollow" : "the page shows nothing"]);

  // Another daemon, the way one always comes up: on a send. Its arrival is
  // what the page has to catch up on, since it was heard by nobody.
  execFileSync(BIN, ["send", second], { env, cwd: tmp, encoding: "utf8" });
  const after = await health();
  const back = await until(async () => { const h = await health(); return h && h.pid !== before.pid && h.window === true; }, 80);
  const solid = back && await until(() => p.ev(`!document.documentElement.dataset.link`));
  rows.push(["the page is on the next one, a window still", back && solid && before.window === true,
    before.window !== true ? "the page was not a window before, so this proves nothing" : !back ? `the new daemon (pid ${after && after.pid}) says window: ${after && after.window} after 8 s` : !solid ? "the daemon knows, but the mark is still hollow" : `pid ${after.pid} counts the window, and the mark is solid again`]);

  const caught = await until(() => p.ev(`[...document.querySelectorAll(".inbox.waiting .title")].some(t => /second plan/.test(t.textContent))`), 30);
  rows.push(["and caught up on what it missed", caught, caught ? "the document that raised the daemon is in the inbox" : `the inbox does not list it: "${await p.ev(`document.querySelector("#doc").textContent.trim().slice(0, 60)`)}"`]);
  return rows;
}
