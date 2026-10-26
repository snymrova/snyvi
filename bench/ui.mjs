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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, copyFileSync, existsSync, readdirSync, unlinkSync, realpathSync, symlinkSync } from "node:fs";
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
const PORT = flag("--port") || "7797";
/* Lately is hidden in the window (LATELY_SHOWN, ui/app/05-notes.js, which
 * says what else comes back with it): the rows that open it wait for it,
 * and rows that say it stays out of sight stand in for them. */
const LATELY = false;   // 7796 is browser.mjs; 7791, 7794-7795 and 7812-7814 are CI's

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
    // under a `workflow` of its own, and as the hook or an agent (`origin`,
    // `title`) would.
    const arrive = async (o = {}) => {
      const n = ++arrivals, path = join(tmp, o.name || `arrival-${n}.md`);
      writeFileSync(path, o.body || `# Arrival ${n}\n\nA document that came in while something else was being read.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, cwd: tmp, ...(o.workflow ? { workflow: o.workflow } : {}), ...(o.origin ? { origin: o.origin, title: o.title } : {}) }),
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
    await section("a draft, then the send", () => draftRows(p, url, arrive));
    await section("a delete, and the way back", () => deleteRows(p, arrive));
    // Before any other section sends an aside: only the first in ten minutes
    // lights up, and only one that lights up rises (src/aside.rs).
    await section("an aside, in the corner", () => asideRows(p, base, token));
    await section("nothing lost when snyvi says no", () => lossRows(p, base, token, arrive, browsed));
    await section("by keyboard, and back", () => reachRows(p, base, token, arrive));
    await section("the ✕ over what is read", () => backRows(p, browsed));
    await section("back and forward", () => navRows(p));
    await section("the sidebars, arranged", () => sidebarsRows(p, token));
    await section("one system: tips, answers, one Undo", () => designRows(p, url, arrive));
    await section("a folder, in the file manager", () => revealRows(p, browsed, folder, tmp));
    await section("a link into a folder", () => browseRows(p, browsed));
    await section("#183: a picture, to keep", () => downloadRows(p, cdp, url, arrive, tmp));
    await section("#194: a copy keeps the Markdown", () => copyRows(p, url, arrive));
    await section("a folder, opened in snyvi", () => folderRows(cdp, base, browsed));
    await section("a link out of a document", () => docLinkRows(p, base, token, first.doc.id));
    await section("the socket a page holds", () => socketRows(p, url, base, browsed));
    await section("a window to hand a link to", () => windowRows(p, url, base, mcpSend));
    await section("a link that opens in the window", () => linkRows(p, url, base, env, tmp, token, stub, mcpSend));
    await section("what moves, and for how long", () => motionRows(p, url, arrive));
    await section("what a save, and a hover, cost", () => costRows(p, url, base, token, tmp, arrive));
    await section("desks that hold still", () => deskRows(cdp, base, token));
    await section("a desk for each project", () => projectDeskRows(cdp, base, token, tmp));
    await section("subfolder projects under their parent", () => nestRows(cdp, base, token, tmp));
    await section("nothing lost on a desk when snyvi says no", () => deskLossRows(cdp, base, token));
    await section("a widget's box, failing and long", () => widgetBoxRows(cdp, base, tmp));
    await section("the keys sheet: Claude as, then keys", () => keysSheetRows(cdp, base));
    await section("panels: full view, moved, linked, and their menus", () => panelRows(cdp, base, token));
    await section("panels in the back: a chip, a drawer, one that dies", () => backPanelRows(cdp, base));
    await section("#187: back from a page is back to the panel that sent it", () => senderRows(cdp, base, token));
    await section("#188: files by name in ⌘K", () => findRows(cdp, base, token, env, tmp));
    await section("#161-#164: the feet, the cards, focus that follows, a run in steps", () => footRows(cdp, base, token));
    await section("Home, and what a Claude in a panel is told", () => homeRows(cdp, base, token, arrive, tmp));
    await section("1.14: desks in your order, a repo link, one paste, a ; that draws", () => orderRepoRows(cdp, base, token, env, tmp));
    await section("answers beside their buttons", () => answerRows(url, tmp));
    await section("every control, in every view", () => controlRows(cdp, p, url, browsed, base, token));
    await section("the first frame, in the reader's theme", () => firstFrameRows(p, url));
    await section("the about box", () => aboutRows(p, url));
    await section("#191: Show me → and ▶ Watch it", () => guideRows(p, url, arrive));
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

  // B1 of the audit of 1.46.2: the daemon's head date and the rail's
  // Received are one format, the page's ("Oct 23, 12:33" beside "23 Oct, 12:33").
  const when = await p.ev(`({ head: document.querySelector(".doc-sub time[data-ts]")?.textContent || "", rail: [...document.querySelectorAll("#meta .row")].find(r => r.querySelector("b")?.textContent === "Received")?.querySelector("span")?.textContent || "" })`);
  rows.push(["the head and the rail say one time", !!when.head && when.head === when.rail,
    !when.head ? "no time in the document's head" : when.head === when.rail ? `"${when.head}" in both` : `the head says "${when.head}", the rail "${when.rail}"`]);

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
  // B5 of the audit of 1.46.2: the rail's letter hints sleep with the keys.
  const hintOp = () => p.ev(`(() => { const k = document.querySelector("#meta .actions kbd.lk"); return k ? +getComputedStyle(k).opacity : null; })()`);
  const hintAsleep = await hintOp();
  rows.push(["a letter asleep does nothing, and says why", !asleep.on && asleep.title === asleepAt.title && /show/.test(asleep.pill) && /^(⌃B|Ctrl B) for keys$/.test(asleep.says),
    asleep.title !== asleepAt.title ? "k moved without ⌃B" : `pill "${asleep.says}" (${asleep.pill})`]);
  await p.press("b", { ctrl: true }); await sleep(200);
  const woke = await keyState(), hintAwake = await hintOp();
  rows.push(["letter hints wait for Ctrl B", hintAsleep != null && hintAsleep < 1 && hintAwake > 0.9,
    hintAsleep == null ? "no letter hint in the rail" : `${hintAsleep} asleep, ${hintAwake} after Ctrl B`]);
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
  const HOME = ["inbox-row", "tree", "desk-nav", "browse-nav", "widgets-nav", "pop"];
  // The fold eases over 160 ms; the widths below are read where it lands.
  const eased = () => p.ev(`Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => 0))).then(() => 1)`);
  await p.press("\\");
  await eased();
  const folded = await p.ev(`({ side: document.documentElement.dataset.side, width: Math.round(document.querySelector("#side").getBoundingClientRect().width), icons: window.__ui.vis("#rail-nav"), tree: window.__ui.vis("#tree") })`);
  rows.push(["\\ folds the sidebar to its rail", folded.side === "0" && folded.width === 44 && folded.icons && !folded.tree,
    folded.side !== "0" ? "\\ did not fold it" : folded.width !== 44 ? `the rail is ${folded.width} px` : !folded.icons ? "no icons on it" : folded.tree ? "the tree is still drawn in 44 px" : "44 px, icons only"]);

  const opened = [], broke = [];
  for (const [sec, id] of [["inbox", "inbox-row"], ["tree", "tree"], ["desks", "desk-nav"], ["browse", "browse-nav"]]) {
    if (!(await p.ui("vis", `#rail-nav [data-pop="${sec}"]`))) { broke.push(`${sec}: no icon`); continue; }
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
  const count = await p.ev(`({ badge: document.querySelector('#rail-nav [data-pop="inbox"] .badge').textContent, label: document.querySelector("#inbox-row .t-inbox.new .n")?.textContent || "" })`);
  rows.push(["the inbox icon says how many wait", count.badge !== "" && count.badge === count.label,
    count.badge === "" ? `nothing on the icon (Recent says ${count.label || "nothing"})` : count.badge !== count.label ? `the icon says ${count.badge}, Recent ${count.label}` : `${count.badge}, as Recent says`]);

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

/** 1.33: what the hook saves as Claude writes is a draft -- a row in its
 *  project, and nothing announced: no bar, no count, Recent not lit, no
 *  wash. The agent's send of the same bytes takes the draft over, and
 *  that is the arrival: one row, washed once, with the agent's title. */
async function draftRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  await p.goto(url);
  await p.ev(`fetch("/api/queue/clear", { method: "POST" }).then(r => r.status)`);
  await p.reload();
  await p.pointerAway();
  const body = "# Draft heading\n\nSaved as Claude wrote it, not sent yet.\n";
  const draft = await arrive({ name: "draft.md", body, origin: "hook" });
  const listed = await until(`!!document.querySelector('#tree a[data-id="${draft.id}"]')`, 30);
  await sleep(300);
  const hushed = await p.ev(`({ bar: !document.querySelector("#queue-bar").hidden, queued: !!document.querySelector("#inbox-row .t-inbox.new"),
    washed: document.querySelectorAll(".wash").length, marked: !!document.querySelector('#tree a.new[data-id="${draft.id}"]') })`);
  const counted = await p.ev(`fetch("/api/queue").then(r => r.json()).then(q => q.length)`);
  rows.push(["a draft is listed and says nothing", listed && !hushed.bar && !hushed.queued && !hushed.washed && !hushed.marked && counted === 0,
    !listed ? "the draft is not in the tree" : hushed.bar ? "the bar came up" : hushed.queued ? "it lights Recent" : hushed.washed ? "something washed" : hushed.marked ? "the tree marks it new" : counted ? `the daemon counts ${counted} waiting`
      : "in the tree, unmarked; no bar, Recent not lit, no wash, nothing counted"]);

  const sent = await arrive({ name: "draft.md", body, origin: "mcp", title: "The draft, sent" });
  // The mark comes with the event; the title with the project's rows, a read later.
  const came = await until(`!!document.querySelector('#tree a.new[data-id="${sent.id}"]') && !!document.querySelector("#inbox-row .t-inbox.new")`, 30);
  const washes = await p.ev(`(() => { const li = document.querySelector('#tree li.t-doc.wash:has(> a[data-id="${sent.id}"])'); return li ? li.getAnimations().filter(x => x.animationName === "land").length : -1; })()`);
  await until(`document.querySelector('#tree a[data-id="${sent.id}"] .title')?.textContent === "The draft, sent"`, 30);
  const title = await p.ev(`document.querySelector('#tree a[data-id="${sent.id}"] .title')?.textContent || ""`);
  rows.push(["the send takes the draft over, and arrives", sent.id === draft.id && came && washes === 1 && title === "The draft, sent",
    sent.id !== draft.id ? "a second row, not the draft" : !came ? "not marked new, or Recent not lit" : washes !== 1 ? `${washes < 0 ? "no" : washes} wash on the row` : title !== "The draft, sent" ? `the row says "${title}"`
      : "one row, marked new, Recent lit, washed once, with the agent's title"]);
  await p.ev(`fetch("/api/queue/clear", { method: "POST" }).then(r => r.status)`);
  return rows;
}

/** 0.14: an arrival joins a queue and the page stays where it is; `n` reads
 *  down the line; Back returns to the place; the count survives a reload. */
async function queueRows(p, url, arrive) {
  const rows = [];
  const read = () => p.ev(`(() => {
    const bar = document.querySelector("#queue-bar");
    return { title: document.title, path: location.pathname, bar: bar.hidden ? null : bar.textContent.trim(),
      side: +(document.querySelector("#inbox-row .t-inbox.new .n")?.textContent || 0),
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
  rows.push(["an arrival while reading", barCame && stayed && /^1 waiting/.test(during.bar) && during.bar.includes(first.title) && during.side === 1 && during.marked === 1,
    !barCame ? "no bar appeared" : during.title !== before.title ? `the page changed to "${during.title}"` : !stayed ? `the document moved: block ${before.place.block} at ${before.place.delta} px, then block ${during.place.block} at ${during.place.delta} px`
      : !/^1 waiting/.test(during.bar) ? `the bar reads "${during.bar.slice(0, 30)}"` : during.side !== 1 ? `Recent counts ${during.side}` : during.marked !== 1 ? `${during.marked} rows marked in the tree`
        : `page unmoved at block ${during.place.block}; bar reads "1 waiting", Recent counts 1, one marked in the tree`]);

  await p.press("n");
  await sleep(600);
  const opened = await read();
  rows.push(["n opens it", opened.title === first.title && opened.bar === null && opened.side === 0 && opened.marked === 0,
    opened.title !== first.title ? `n opened "${opened.title}"` : opened.bar !== null ? "the bar is still up" : opened.side ? "Recent still counts it" : opened.marked ? "the tree still marks it" : "open, off the queue, unmarked in the tree"]);

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
  rows.push(["twelve at once", twelve && many.side === 12 && (many.bar || "").startsWith(`1/12${served[0]}`),
    !twelve ? `the bar reads "${many.bar ? many.bar.slice(0, 20) : "nothing"}"` : many.side !== 12 ? `Recent counts ${many.side}` : !(many.bar || "").startsWith(`1/12${served[0]}`) ? "the bar does not start where the daemon does" : "bar reads 1/12 from the newest; Recent counts 12"]);

  await p.reload();
  const kept = await read();
  rows.push(["still waiting after a reload", /^1\/12/.test(kept.bar || "") && kept.side === 12,
    `the bar reads "${(kept.bar || "nothing").slice(0, 20)}", Recent counts ${kept.side}`]);

  // 1.36.1: the Inbox head is All at its edge, then Recent alone. Waiting, the
  // row that folded the same documents in place, is gone: Recent is lit with
  // how many are unread, and its page lists them first, then the rest, each
  // once. All is the whole Inbox.
  const head = () => p.ev(`({ n: document.querySelector("#inbox-row .t-inbox.new .n")?.textContent || "", rows: document.querySelectorAll("#inbox-row .s-row").length,
    list: !!document.querySelector("#queue, #inbox-row .t-wait"), all: document.querySelector("#inbox-row .sec-all")?.textContent.trim() || "" })`);
  const lit = await head();
  rows.push(["Recent is lit with how many are unread", lit.n === "12" && lit.rows === 1 && !lit.list,
    lit.list ? "the Waiting row or its list is still drawn" : lit.rows !== 1 ? `${lit.rows} rows under the Inbox head` : lit.n !== "12" ? `Recent reads "${lit.n}"` : "Recent 12, in the accent, the one row under the head"]);
  await p.clickOn("#inbox-row .t-inbox");
  const recent = await until(`location.search === "?recent" && document.querySelector("#doc h1")?.textContent === "Recent"`);
  const page = await p.ev(`(() => { const t = s => [...document.querySelectorAll(s)].map(a => a.textContent); const un = t("#doc .inbox.waiting .title"), all = [...document.querySelectorAll("#doc .inbox a[data-id]")].map(a => a.dataset.id);
    return { un, twice: all.length - new Set(all).size, rest: document.querySelectorAll("#doc .inbox:not(.waiting) li").length, heads: [...document.querySelectorAll("#doc h2.inbox-sec")].map(h => h.firstChild?.textContent.trim()).join(", ") }; })()`);
  await p.clickOn("#inbox-row .sec-all");
  const whole = await until(`location.search === "" && document.querySelector("#doc h1")?.textContent === "Inbox" && !!document.querySelector("#doc .inbox.waiting")`);
  // B3 of the audit of 1.46.2: All is the same page, each document once,
  // under Waiting and Earlier, and neither page says Unread.
  const allPage = await p.ev(`(() => { const all = [...document.querySelectorAll("#doc .inbox a[data-id]")].map(a => a.dataset.id); return { twice: all.length - new Set(all).size, heads: [...document.querySelectorAll("#doc h2.inbox-sec")].map(h => h.firstChild?.textContent.trim()).join(", ") }; })()`);
  rows.push(["Recent lists the unread first; All is the whole Inbox", recent && page.un.length === 12 && page.un[0] === served[0] && !page.twice && page.rest > 0 && whole,
    !recent ? "Recent did not open /inbox?recent" : page.un.length !== 12 ? `${page.un.length} unread on Recent` : page.un[0] !== served[0] ? `"${page.un[0]}" first, not the newest`
      : page.twice ? `${page.twice} listed twice` : !page.rest ? "nothing under the unread" : !whole ? "All did not open the Inbox with what waits" : `Recent: 12 unread, newest first, then ${page.rest} more, each once; All at /inbox`]);
  rows.push(["each document once on both Inbox pages, Waiting then Earlier", !allPage.twice && allPage.heads === "Waiting, Earlier" && page.heads === "Waiting, Earlier",
    allPage.twice ? `${allPage.twice} listed twice on /inbox` : `/inbox heads "${allPage.heads}", Recent "${page.heads}"`]);
  await p.goto(url);
  await until(`!document.querySelector("#queue-bar").hidden`);

  // ‹ › page through what waits, opening each, round the ends; the count is
  // the place in the batch, so a read does not take the one shown off it.
  const ids = await p.ev(`fetch("/api/queue").then(r => r.json()).then(q => q.map(d => d.id))`);
  const on = i => until(`document.title === ${JSON.stringify(served[i])}`);
  await p.clickOn("#queue-bar [data-q=step]");
  const stepOpened = await on(1);
  await sleep(200);
  const stepped = await read();
  await p.clickOn("#queue-bar [data-q=prev]");
  await on(0);
  await p.clickOn("#queue-bar [data-q=prev]");
  const roundOpened = await on(11);
  await sleep(200);
  const round = await read();
  await p.clickOn("#queue-bar [data-q=step]");
  const homeOpened = await on(0);
  await sleep(200);
  const home = await read();
  const shows = (r, i) => (r.bar || "").startsWith(`${i + 1}/12${served[i]}`);
  rows.push(["› and ‹ open the next and the one before, round the ends", stepOpened && roundOpened && homeOpened && shows(stepped, 1) && shows(round, 11) && shows(home, 0) && home.side === 9,
    `opened ${[stepOpened, roundOpened, homeOpened].map(Number).join("")}; the bar read "${(stepped.bar || "").slice(0, 16)}", "${(round.bar || "").slice(0, 16)}", "${(home.bar || "").slice(0, 16)}", ${home.side} still waiting`]);
  // The three read put back, for the rows below that count twelve.
  await p.ev(`fetch("/api/queue/unread", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ${JSON.stringify(ids)} }) }).then(r => r.status)`);
  await p.goto(url);
  await until(`/^1\\/12/.test(document.querySelector("#queue-bar").textContent)`);

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
  rows.push(["an inbox with a queue, cleared", still.title === "snyvi" && still.waiting.length === 13 && cleared.waiting.length === 0 && cleared.side === 0 && cleared.bar === null,
    still.title !== "snyvi" ? `the arrival opened itself over the inbox: "${still.title}"` : still.waiting.length !== 13 ? `${still.waiting.length} waiting after the arrival` : cleared.waiting.length || cleared.side ? "something is still waiting after Mark all read and a reload" : `the arrival became the 13th row; Mark all read emptied the queue, and a reload agrees`]);

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
  // What waits, as the bar says it -- the oldest, and how many -- and
  // Recent's count: an older version still held would be "1/2" and first.
  const held = `(() => { const qb = document.querySelector("#queue-bar .qb"); return { rows: qb ? [qb.querySelector(".qb-next b")?.textContent || ""].filter(t => t.startsWith("The plan")) : [],
    one: !!qb && /^1 waiting/.test(qb.querySelector(".qb-n")?.textContent || ""), n: document.querySelector("#inbox-row .t-inbox.new .n")?.textContent }; })()`;
  const onBar = t => `document.querySelector("#queue-bar .qb-next b")?.textContent === ${JSON.stringify(t)}`;
  await until(onBar("The plan"));
  await arrive({ name: plan, body: "# The plan, revised\n\nSecond draft.\n" });
  await until(onBar("The plan, revised"));
  await sleep(300);
  const twice = await p.ev(held);
  await arrive({ name: plan, body: "# The plan, third\n\nFrom elsewhere.\n", workflow: "ui audit" });
  await until(onBar("The plan, third"));
  await sleep(300);
  const thrice = await p.ev(held);
  await p.press("i"); await sleep(600);
  const listed = await p.ev(`[...document.querySelectorAll(".inbox.waiting .title")].map(a => a.textContent).filter(t => t.startsWith("The plan"))`);
  rows.push(["one file sent three times waits once", twice.rows.join("|") === "The plan, revised" && twice.one && thrice.rows.join("|") === "The plan, third" && thrice.one && listed.join("|") === "The plan, third" && thrice.n === "1",
    !twice.one || twice.rows.length !== 1 ? `after two sends the bar shows ${twice.rows.join(", ") || "something else"}, not one` : !thrice.one || thrice.rows.length !== 1 ? `after a third from another workflow the bar shows ${thrice.rows.join(", ") || "something else"}, not one`
      : listed.length !== 1 ? `the inbox lists ${listed.join(", ")}` : thrice.n !== "1" ? `the count says ${thrice.n}` : "one waiting, the newest, on the bar and the inbox; Recent says 1"]);
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

  // On the Inbox page (A1 of the audit of 1.46.2): the menu's Remove turns
  // the page's row into the sidebar's ghost where it stood, through the
  // page's redraw, with no toast in the corner; Undo puts the row back there.
  const onPage = await arrive();
  await p.goto(`${await p.ev("location.origin")}/inbox`);
  await p.pointerAway();
  const pageSel = JSON.stringify(`#doc .inbox a[data-id="${onPage.id}"]`);
  const topOf = s => p.ev(`(() => { const e = document.querySelector(${s}); return e ? Math.round(e.getBoundingClientRect().top) : null; })()`);
  await until(`!!document.querySelector(${pageSel})`);
  const rowTop = await topOf(pageSel);
  await p.rightClickOn(JSON.parse(pageSel));
  await until(`!document.querySelector("#ctx").hidden`);
  const rm = await p.ev(`(() => { const b = [...document.querySelectorAll("#ctx button")].find(b => b.textContent.startsWith("Remove")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (rm && rowTop != null) {
    await p.click(rm.x, rm.y);
    // Past the daemon's answer and the page's redraw on its event.
    await sleep(1200);
    const pg = await p.ev(`(() => { const g = document.querySelector("#doc .inbox > .t-gone .t-ghost"); if (!g) return null; return { text: g.textContent, y: Math.round(g.getBoundingClientRect().top) }; })()`);
    const t3 = await toastEl();
    rows.push(["Remove on the Inbox page answers in the row", !!pg && Math.abs(pg.y - rowTop) <= 2 && /removed/.test(pg.text) && !t3,
      !pg ? (t3 ? `no ghost on the page, and a toast: "${t3.text}"` : "no ghost on the page") : t3 ? `a toast came too: "${t3.text}"` : Math.abs(pg.y - rowTop) > 2 ? `the row was at y ${rowTop}, the ghost is at y ${pg.y}` : `"${pg.text}" where the row stood`]);
    await p.clickOn("#doc .inbox > .t-gone .t-undo");
    const returned = await until(`!!document.querySelector(${pageSel}) && !document.querySelector("#doc .inbox > .t-gone")`);
    const backTop = returned ? await topOf(pageSel) : null;
    rows.push(["and its Undo puts the row back where it was", returned && backTop === rowTop,
      !returned ? "the row did not come back on the page" : backTop === rowTop ? `at y ${backTop}, its own place` : `it was at y ${rowTop}, it came back at y ${backTop}`]);
  } else rows.push(["Remove on the Inbox page answers in the row", false, rowTop == null ? "the document's row is not on the Inbox page" : "the row's menu has no Remove"]);

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

  // A tooltip, not a card (#177): one line beside the control, its sub-line
  // in the tip for a screen reader but not drawn. Copy all's tip has one.
  // Shown by the keyboard: this browser is hover: none, where a resting
  // pointer brings no tip. A Tab fetches the chunk and makes focus visible.
  await p.goto(url);
  await until(`window.__ui.vis("#btn-copy-top")`);
  await p.press("Tab");
  await p.ev(`document.querySelector("#btn-copy-top").focus()`);
  await until(`document.querySelector("#tip.on")?.textContent.startsWith("Copy all")`);
  const line = await p.ev(`(() => { const t = document.querySelector("#tip.on"), b = document.querySelector("#btn-copy-top"), s = t?.querySelector(".tip-s");
    if (!t) return null; const r = t.getBoundingClientRect();
    return { h: Math.round(r.height), sub: b.dataset.tipSub || "", read: !!s && t.textContent.includes(b.dataset.tipSub), drawn: !!s && s.getBoundingClientRect().width > 1, shadow: getComputedStyle(t).boxShadow }; })()`);
  rows.push(["a tip is one line, its sub-line read aloud and not drawn", !!line && !!line.sub && line.h <= 24 && line.read && !line.drawn && line.shadow === "none",
    !line ? "no tip on Copy all, focused" : !line.sub ? "Copy all's tip has no sub-line to test with" : line.drawn ? "the sub-line is drawn" : !line.read ? "the sub-line is not in the tip" : `${line.h} px tall, shadow ${line.shadow}`]);
  await p.ev(`document.activeElement?.blur()`);

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
  // B4 of the audit of 1.46.2: the rail's versions say which is which, sent
  // in one minute as these are; they read one date three times.
  await until(`document.querySelectorAll("#history a").length === 3`, 30);
  const vs = await p.ev(`[...document.querySelectorAll("#history a")].map(a => a.textContent.trim())`);
  rows.push(["a lineage's versions say which is which", vs.length === 3 && vs.every((t, i) => t.startsWith(`v${3 - i} · `)) && new Set(vs).size === 3,
    vs.length !== 3 ? `${vs.length} versions in the rail` : `they read ${vs.map(t => `"${t}"`).join(", ")}`]);
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

  // News while the error stands: a newer version of the open document. It
  // rises in the corner (1.38), so the error is not pushed out by it.
  await arrive({ name: "loss-a.md", body: "# Loss A\n\nThe document being read, again.\n" });
  const news = await until(`/newer version/i.test(document.querySelector("#cn")?.textContent || "")`, 30);
  const t2 = await said();
  await p.clickOn("#toasts .toast .tx");
  rows.push(["error toast survives an arrival, which rises in the corner", t2?.alert && news,
    !t2?.alert ? `the arrival took its place: "${t2?.text}"` : news ? "the error stayed until its ✕, and the newer version rose in the corner" : "the arrival was dropped: not in the corner"]);

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
  await p.clickOn(".sec-all");
  await sleep(500);
  const inbox = await p.ev(`({ line: document.querySelector("#doc .no-reach")?.textContent || null, welcome: (document.querySelector("#doc h1")?.textContent || "") !== "Inbox", list: !!document.querySelector("#doc ul.inbox") })`);
  if (inbox.line) await p.clickOn("#doc .no-reach [data-retry]");
  const listed = !!inbox.line && await until(`!!document.querySelector("#doc ul.inbox")`);
  rows.push(["inbox fetch refused → Retry line, not Welcome", await refused(p) && !!inbox.line && !inbox.welcome && listed,
    !(await refused(p)) ? "the Inbox never asked the daemon" : inbox.welcome ? "the page is Welcome, as if the library were empty" : !inbox.line ? "nothing says it could not load" : listed ? `"${inbox.line}", and the Retry brought the list` : "the Retry did not bring the list"]);

  // An aside's Undo, refused: the daemon still holds it removed, so the
  // corner's row must not show it again; it says so, where the Undo was.
  const say = async text => {
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text, sender: "bench-agent" }) });
    return (await r.json()).note;
  };
  if (!LATELY) return rows;
  const aside = await say("An aside whose Undo will be refused.");
  await p.goto(`${origin}/`);
  await p.pointerAway();
  // 1.43: asides are Lately's, and Lately is the sidebar's (the head's
  // clock opens it); the corner's pill is On you's alone. An aside inside
  // the daemon's quiet may not rise, so its card is not waited for.
  await until(`!!document.querySelector("#cn .cn-card")`, 10);
  await p.ev(`document.querySelector("#cn [data-a=cn-later]")?.click(); 1`);
  await p.clickOn("#btn-lately");
  const row = `#lately-nav .cn-row:has(.cn-t) .cn-rx[data-r="${aside.id}"]`;
  await until(`!!document.querySelector(${JSON.stringify(row)})`);
  await p.ev(`document.querySelector(${JSON.stringify(row)}).click(); 1`);
  await sleep(500);
  await refuse(p, "POST", /^\/api\/lately\/restore$/);
  await p.ev(`document.querySelector("#lately-nav .cn-gone .cn-undo")?.click(); 1`);
  await sleep(300);
  const card = await p.ev(`document.querySelector("#lately-nav .cn-gone")?.textContent || null`);
  const still = (await (await fetch(`${base}/api/notes`)).json()).notes.find(n => n.id === aside.id)?.dismissed === true;
  rows.push(["aside undo refused → its row says so, the Undo a Retry", await refused(p) && /Could not bring it back/.test(card || "") && still,
    !(await refused(p)) ? "the Undo never asked the daemon" : !/Could not bring it back/.test(card || "") ? `the row reads "${card}"` : "the row says so, and the daemon still has it removed"]);
  await p.press("Escape");
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

  // An older aside in Lately is reached by Ctrl Alt Y and Tab, and opened
  // by Enter (the corner, plan b0bca0a11f).
  if (!LATELY) return rows;
  const say = async (text, about) => {
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ text, sender: "bench-agent", ...(about ? { about } : {}) }) });
    return (await r.json()).note;
  };
  await say("The first older aside, about the reach document.", d.id);
  await say("The second older aside, about it too.", d.id);
  await say("The newest aside.");
  await p.goto(`${origin}/`);
  await p.pointerAway();
  // 1.43: Lately is the sidebar's, behind the clock in its head, which Tab
  // reaches like any button; Enter opens it with the focus inside, and Tab
  // goes on down its rows. Ctrl Alt Y is On you's alone.
  await until(`!!document.querySelector("#cn .cn-card")`, 10);
  await p.ev(`document.querySelector("#cn [data-a=cn-later]")?.click(); document.querySelector("#btn-lately").focus(); 1`);
  await p.press("Enter");
  await until(`document.documentElement.dataset.pop === "lately" && !!document.querySelector("#lately-nav .cn-t")`);
  let on = null;
  for (let i = 0; i < 12 && !/first older aside/.test(on || ""); i++) {
    await p.press("Tab", { raw: true });
    on = await p.ev(`document.activeElement?.matches("#lately-nav .cn-t") ? document.activeElement.textContent : null`);
  }
  await p.press("Enter");
  const went = await until(`document.title === ${JSON.stringify(d.title)}`);
  rows.push(["Lately's clock and Tab reach an older aside; Enter opens it", /first older aside/.test(on || "") && went,
    !on ? `Tab went to ${JSON.stringify(await p.ui("focus"))}, not Lately` : !/first older aside/.test(on) ? `Tab reached "${on}"` : went ? "reached, and Enter opened the document it is about" : `Enter left the page on "${await p.ev("document.title")}"`]);
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

/** /sidebars: a move saves, the left sidebar follows, and the page read
 *  again says the same. 1.27.0 moved the row and saved nothing: the page's
 *  stylesheet was named CSS, which hid the browser's CSS.escape, and the
 *  redraw threw before the POST. Reset at the end, for the sections after. */
async function sidebarsRows(p, token) {
  const rows = [];
  const origin = await p.ev("location.origin");
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  // The list names every widget folder and setting, so since 1.46 it is the
  // window's or the token's: the bench reads what was kept with the token,
  // and the page is a window's for this section (a capability on its
  // fragment), handed back at the end so the sections after are a tab again.
  const kept = async () => (await (await fetch(`${origin}/api/widgets`, { headers: { authorization: `Bearer ${token}` } })).json()).layout;
  const cap = (await (await fetch(`${origin}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const listed = () => p.ev(`[...document.querySelectorAll('.sb-list[data-side="left"] .sb-row')].map(r => r.dataset.sb.split(":")[1]).join(" ")`);
  const onLeft = () => p.ev(`[...document.querySelectorAll("#trees > #inbox-row, #trees > #desk-nav, #trees > #browse-nav")].map(n => ({ "inbox-row": "inbox", "desk-nav": "desks", "browse-nav": "folders" })[n.id]).join(" ")`);
  const errs = [];
  await p.goto(`${origin}/sidebars#cap=${cap}`);
  await until(`!!document.querySelector('.sb-row[data-sb="left:inbox"]')`);
  await p.ev(`window.__sbErr = []; window.addEventListener("error", e => window.__sbErr.push(e.message)); 1`);
  const before = await listed();
  await p.ev(`document.querySelector('.sb-row[data-sb="left:inbox"]').focus(), 1`);
  await p.press("ArrowDown", { alt: true });
  await sleep(500);
  const k1 = await kept();
  errs.push(...await p.ev("window.__sbErr"));
  rows.push(["Alt+↓ on /sidebars moves Inbox down, and the daemon keeps it", k1.left.join(" ") === "desks inbox folders widgets",
    `listed "${before}" → "${await listed()}", the daemon kept "${k1.left.join(" ")}"${errs.length ? `; threw: ${errs[0]}` : ""}`]);
  const focus = await p.ev(`document.activeElement?.dataset?.sb || document.activeElement?.tagName`);
  rows.push(["the focus stays on the row that moved", focus === "left:inbox", `on ${focus}`]);
  rows.push(["the left sidebar follows at once", (await onLeft()) === "desks inbox folders", `"${await onLeft()}"`]);

  // A drag, as the page receives one: Folders dropped on Desks.
  await p.ev(`(() => {
    const dt = new DataTransfer(), at = s => document.querySelector('.sb-row[data-sb="left:' + s + '"]');
    at("folders").focus();   // the press that starts a drag focuses the row
    at("folders").dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    at("desks").dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    at("desks").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    at("folders")?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return 1;
  })()`);
  await sleep(500);
  const k2 = await kept();
  rows.push(["a drag saves too", k2.left.join(" ") === "folders desks inbox widgets", `the daemon kept "${k2.left.join(" ")}"`]);

  await p.goto(`${origin}/sidebars`);
  await until(`!!document.querySelector('.sb-row[data-sb="left:inbox"]')`);
  rows.push(["/sidebars read again shows the order it was left in", (await listed()) === "folders desks inbox widgets", `"${await listed()}"`]);

  const under = await p.ev(`(() => { const b = document.querySelector("[data-reset]"); b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(), t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t === b ? "" : (t?.id || t?.className || t?.tagName || "nothing"); })()`);
  await p.clickOn("[data-reset]");
  await sleep(500);
  const k3 = await kept();
  rows.push(["Reset to default puts today's order back", k3.left.join(" ") === "inbox desks folders widgets" && (await onLeft()) === "inbox desks folders",
    `the daemon kept "${k3.left.join(" ")}", the left reads "${await onLeft()}"${under ? `; over the button: ${under}` : ""}`]);
  await p.ev(`sessionStorage.removeItem("snyvi.cap"), 1`);
  return rows;
}

/** An aside in the corner (plan b0bca0a11f): it rises, a click elsewhere
 *  settles it into the pill with a dot, and the pill's tray lists it under
 *  Lately. Its ✕ there leaves one line holding the Undo, as a removed
 *  document's row does; the daemon only flags it, so Undo is real. */
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
  const lately = async () => (await (await fetch(`${base}/api/lately`)).json());
  // 1.43: what settles goes to Lately, the sidebar's: its clock in the head
  // takes the dot, and opens it. The corner's pill is On you's alone.
  const row = id => `#lately-nav .cn-rx[data-r="${id}"]`;
  const dotLit = `!!document.querySelector("#btn-lately .lt-dot")?.getClientRects().length`;
  // The quiet is the daemon's: an aside within ten minutes of one that lit
  // up does not light up, and does not rise. Seen, so the dot starts out.
  await p.goto(`${base}/`);
  await p.pointerAway();
  await p.ev(`fetch("/api/lately/seen", { method: "POST" }).then(r => r.status)`);

  const lit = await say("An aside that rises in the corner.");
  const rose = await until(`document.querySelector("#cn .cn-card .cn-text")?.textContent === ${JSON.stringify(lit.text)}`);
  const by = await p.ev(`document.querySelector("#cn .cn-card .cn-from")?.textContent || ""`);
  rows.push(["an aside rises in the corner, its byline first who spoke", rose && /^bench-agent/.test(by),
    !rose ? `the corner reads ${JSON.stringify(await p.ev(`document.querySelector("#cn")?.textContent || null`))}` : !/^bench-agent/.test(by) ? `the byline reads "${by}"` : `"${by}"`]);

  // Hidden, a click elsewhere settles it with nothing left behind: no
  // clock, no dot, no blinking mark that nothing could put out.
  if (!LATELY) {
    await p.click(400, 300);
    const out = await until(`!document.querySelector("#cn .cn-card")`);
    const none = await p.ev(`!document.querySelector("#btn-lately, #rail-lately")?.getClientRects().length && !document.documentElement.dataset.note && !document.documentElement.hasAttribute("data-lately")`);
    rows.push(["Lately hidden: a settled aside leaves no clock, dot or blinking mark", out && none,
      !out ? "the card did not go" : !none ? "a clock, a dot or the mark's blink is still drawn" : "the card went, and nothing points at Lately"]);
    await p.ev(`fetch("/api/lately/seen", { method: "POST" }).then(r => r.status)`);
    await p.pointerAway();
    return rows;
  }
  // A click elsewhere settles it into Lately, its clock dotted: nothing
  // that came goes on a timer, or on a click (plan b0bca0a11f).
  await p.click(400, 300);
  const settled = await until(`!document.querySelector("#cn .cn-card") && ${dotLit}`);
  rows.push(["a click elsewhere settles it into Lately, its clock dotted", settled,
    settled ? "the card went, and Lately's clock holds a dot" : `the corner reads ${JSON.stringify(await p.ev(`document.querySelector("#cn")?.innerHTML.slice(0, 160) || null`))}`]);

  await p.clickOn("#btn-lately");
  const listed = await until(`!!document.querySelector(${JSON.stringify(row(lit.id))})`);
  await sleep(300);
  const seen = !(await lately()).unseen && !(await p.ev(dotLit));
  rows.push(["Lately's clock opens it: the aside is listed, and seen", listed && seen,
    !listed ? "Lately has no row for it" : !seen ? "it is still unseen, in the daemon or on the clock" : "listed in Lately, the daemon has it seen, and the dot is out"]);

  await p.ev(`document.querySelector(${JSON.stringify(row(lit.id))}).click(); 1`);
  await sleep(300);
  const gone = await p.ev(`document.querySelector("#lately-nav .cn-gone")?.textContent || null`);
  const flagged = (await daemon()).find(n => n.id === lit.id)?.dismissed === true;
  rows.push(["✕ removes it, and Undo stands in its row", /Removed/.test(gone || "") && flagged,
    !gone ? "the row went with nothing in its place" : !flagged ? "the daemon was not told" : "one line, \"Removed · Undo\", and the daemon keeps it flagged"]);

  await p.ev(`document.querySelector("#lately-nav .cn-gone .cn-undo").click(); 1`);
  await sleep(300);
  const back = !!(await p.ev(`!!document.querySelector(${JSON.stringify(row(lit.id))})`)) && (await daemon()).find(n => n.id === lit.id)?.dismissed === false;
  rows.push(["Undo puts it back", back, back ? "the row is back, and unflagged in the daemon" : "the row did not come back"]);

  await p.ev(`(document.querySelector("#lately-nav .cn-t") || document.querySelector("#pop"))?.focus(); 1`);
  const was = await p.ev("location.pathname");
  await p.press("Escape");
  await sleep(300);
  const closed = await p.ev(`!document.documentElement.dataset.pop && document.querySelector("#pop").hidden`), stayed = await p.ev(`location.pathname === ${JSON.stringify(was)}`);
  rows.push(["Esc closes Lately, and only that", closed && stayed,
    !stayed ? `Esc also left the page for ${await p.ev("location.pathname")}` : !closed ? "Esc did not close it" : "closed, and the page stayed"]);

  // Within the quiet: kept, the dot lit, and nothing rises.
  const quiet = await say("A quiet aside, inside the ten minutes.");
  const dotted = await until(dotLit);
  const roseQuiet = await p.ev(`!!document.querySelector("#cn .cn-card")`);
  const kept = (await lately()).rows.some(r => r.id === quiet.id);
  rows.push(["a quiet aside is kept and dotted, and does not rise", dotted && !roseQuiet && kept,
    !kept ? "the daemon did not keep it" : roseQuiet ? "it rose, inside the quiet" : !dotted ? "Lately's clock has no dot" : "in Lately, its clock dotted, no card"]);
  // Seen, the way a reader does: an aside left waiting keeps the logo
  // blinking, and the rows after this one count every animation that runs.
  await p.clickOn("#btn-lately");
  await sleep(300);
  await p.press("Escape");
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

/** #183: a picture, a film, a song -- the file itself, to keep. A media
 *  page's Download is in Copy all's box, which such a page keeps empty, so
 *  the bar holds still between a page of text and a picture; pressed, the
 *  browser downloads the file under its own name. A picture inside a
 *  document has a ↓ over its corner while the pointer is on it, laid over
 *  the page: the picture does not move. What the window does with the
 *  download is src/bin/app.rs's (`downloads`), which no browser here runs. */
async function downloadRows(p, cdp, url, arrive, tmp) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const box = sel => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && r.width ? [Math.round(r.left), Math.round(r.top), Math.round(r.width)] : null; })()`;
  // In the bar, as far from the way back as: a long page's scrollbar moves
  // the whole bar, and that is not the box moving.
  const inBar = sel => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(), x = document.querySelector("#chrome .over-x").getBoundingClientRect();
    return r && r.width ? [Math.round(x.left - r.left), Math.round(r.top), Math.round(r.width)] : null; })()`;
  const pic = await arrive({ name: "pic.svg", body: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#4a7"/></svg>\n` });
  const takes = await arrive({ name: "takes.md", body: "# Takes\n\nThe picture, to keep.\n\n![a picture](pic.svg)\n\nAnd a line after it.\n" });
  const origin = new URL(url).origin;

  await p.goto(url);
  const ready = await until(`window.__ui.vis("#btn-copy-top") && !!document.querySelector("#btn-dl-top")`, 80);
  const copyAt = await p.ev(inBar("#btn-copy-top"));
  const textOff = ready && await p.ev(`getComputedStyle(document.querySelector("#btn-dl-top")).display === "none"`);
  await p.goto(`${origin}/d/${pic.id}`);
  const dlOn = await until(`!!document.querySelector("#chrome .over.dl") && window.__ui.vis("#btn-dl-top")`, 80);
  const dlAt = await p.ev(inBar("#btn-dl-top"));
  const link = await p.ev(`(() => { const a = document.querySelector("#btn-dl-top"); return a && { href: a.getAttribute("href"), name: a.download, copy: getComputedStyle(document.querySelector("#btn-copy-top")).display }; })()`);
  rows.push(["a picture's page has Download in Copy all's box, a page of text does not",
    !!ready && textOff && dlOn && JSON.stringify(copyAt) === JSON.stringify(dlAt) && link?.copy === "none" && link.href === `/api/docs/${pic.id}/blob` && link.name === "pic.svg",
    !ready ? "copy.js never made the button" : !textOff ? "Download shows on a page of text" : !dlOn ? "no Download on the picture's page" :
      JSON.stringify(copyAt) !== JSON.stringify(dlAt) ? `Copy all at ${JSON.stringify(copyAt)}, Download at ${JSON.stringify(dlAt)}` : `${JSON.stringify(link)}`]);

  // Pressed, the browser keeps it, named as it was sent.
  const dir = join(tmp, "downloads");
  mkdirSync(dir, { recursive: true });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  if (dlOn) await p.clickOn("#btn-dl-top");
  let kept = false;
  for (let i = 0; i < 50 && !kept; i++) { kept = existsSync(join(dir, "pic.svg")); if (!kept) await sleep(100); }
  rows.push(["Download keeps the file under its own name", kept, kept ? "pic.svg in the download folder" : `the folder has ${JSON.stringify(readdirSync(dir))}`]);

  // In a document: a ↓ over the picture's corner, and nothing moves.
  await p.goto(`${origin}/d/${takes.id}`);
  const img = await until(`(() => { const i = document.querySelector("#doc article img"); return i && i.complete && i.getBoundingClientRect().width > 64; })()`, 80)
    && await until(`!!document.querySelector(".dl-fl")`, 80);
  const before = await p.ev(box("#doc article img"));
  if (img) await p.hoverOn("#doc article img");
  const over = img && await until(`document.querySelector(".dl-fl")?.classList.contains("on")`, 20);
  const fl = over ? await p.ev(`(() => { const f = document.querySelector(".dl-fl"), r = f.getBoundingClientRect(), i = document.querySelector("#doc article img").getBoundingClientRect();
    return { inside: r.left >= i.left && r.right <= i.right && r.top >= i.top && r.bottom <= i.bottom, href: new URL(f.href).pathname, name: f.download }; })()`) : null;
  const after = await p.ev(box("#doc article img"));
  rows.push(["a picture in a document has a ↓ over its corner, and does not move",
    !!fl && fl.inside && fl.href === `/files/${takes.id}/pic.svg` && fl.name === "pic.svg" && JSON.stringify(before) === JSON.stringify(after),
    !img ? "the picture did not load" : !over ? "no ↓ while the pointer is on it" : !fl.inside ? "the ↓ is outside the picture" :
      JSON.stringify(before) !== JSON.stringify(after) ? `the picture moved: ${JSON.stringify(before)} → ${JSON.stringify(after)}` : JSON.stringify(fl)]);

  // #195: pressed, the ↓ says so on itself, and the window's word comes
  // beside it, not beside the picture's middle (the far corner, for a tall
  // one). The window's word is played here: a browser never hears it.
  if (over) await p.clickOn(".dl-fl");
  const ticked = over && await until(`document.querySelector(".dl-fl")?.dataset.said === "1"`, 20);
  await p.ev(`dispatchEvent(new CustomEvent("snyvi-downloaded", { detail: { ok: true, path: "/home/r/Downloads/pic.svg" } }))`);
  const near = over && await until(`!!document.querySelector("#toasts .toast")`, 20) && await p.ev(`(() => {
    const t = document.querySelector("#toasts .toast").getBoundingClientRect(), f = document.querySelector(".dl-fl").getBoundingClientRect();
    const gap = Math.max(f.left - t.right, t.left - f.right, f.top - t.bottom, t.top - f.bottom, 0);
    return { gap: Math.round(gap), said: document.querySelector("#toasts .toast").textContent };
  })()`);
  rows.push(["the ↓ pressed turns to a ✓, and \"Downloaded\" comes beside it",
    !!ticked && !!near && near.gap <= 24 && /Downloaded/.test(near.said),
    !over ? "no ↓ to press" : !ticked ? "no ✓ on the ↓" : !near ? "no toast for the window's word" : `${near.gap} px from the ↓: "${near.said}"`]);
  await p.pointerAway();
  return rows;
}

/** #194: a selection that crosses blocks in a Markdown page copies as
 *  Markdown -- bullets, headings, a table in the source's own case, code in
 *  its fence -- and the drawn page as the rich kind; a heading has a copy
 *  glyph beside its `#` that copies its section. The copy is a real `copy`
 *  event on a real selection, read off its own DataTransfer: what the
 *  system's clipboard does with it is the engine's. */
async function copyRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const src = ["# Copies", "", "Some words to start.", "", "## Steps", "", "1. first", "2. second", "   - nested", "", "| Name | Value |", "|:--|--:|", "| a | `1` |", "",
    "```rust", "fn main() {}", "```", "", "## After", "", "The **end**.", ""].join("\n");
  const doc = await arrive({ name: "copies.md", body: src });
  await p.goto(`${new URL(url).origin}/d/${doc.id}`);
  const ready = await until(`!!document.querySelector(".sec-fl") && !!document.querySelector("#doc article.kind-markdown h2")`, 80);
  // From the first words to the end of the code: what a drag does.
  const copy = sel => p.ev(`(() => {
    const art = document.querySelector("#doc article"), r = document.createRange();
    ${sel}
    getSelection().removeAllRanges(); getSelection().addRange(r);
    const dt = new DataTransfer(), e = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    art.dispatchEvent(e);
    return { taken: e.defaultPrevented, text: dt.getData("text/plain"), html: dt.getData("text/html") };
  })()`);
  const all = ready && await copy(`r.setStart(art.querySelector("p").firstChild, 5); r.setEndAfter(art.querySelector("pre"));`);
  const want = ["words to start.", "", "## Steps", "", "1. first", "2. second", "   - nested", "", "| Name | Value |", "| :-- | --: |", "| a | `1` |", "", "```rust", "fn main() {}", "```"].join("\n");
  rows.push(["a selection across blocks copies as Markdown, the page as drawn beside it",
    !!all && all.taken && all.text === want && /<table/.test(all.html) && !/<button/.test(all.html),
    !ready ? "copy.js never came" : !all.taken ? "the engine's copy, not snyvi's" : all.text !== want ? JSON.stringify(all.text) : !/<table/.test(all.html) || /<button/.test(all.html) ? "no table in the rich kind, or a button in it" : `${all.text.split("\n").length} lines of Markdown`]);
  // Words inside one paragraph are the engine's: there is no Markdown to keep.
  const words = ready && await copy(`const t = art.querySelector("p").firstChild; r.setStart(t, 0); r.setEnd(t, 4);`);
  rows.push(["words inside one paragraph are left to the engine", !!words && !words.taken, words?.taken ? JSON.stringify(words.text) : "the engine's"]);

  // The section glyph: beside the `#`, in the gutter, over nothing; pressed,
  // ✓, and the section on the clipboard.
  const head = `#doc article h2`;
  const before = await p.ev(`JSON.stringify(document.querySelector("${head}").getBoundingClientRect())`);
  if (ready) await p.hoverOn(head);
  const on = ready && await until(`document.querySelector(".sec-fl")?.classList.contains("on")`, 20);
  const at = on && await p.ev(`(() => { const b = document.querySelector(".sec-fl").getBoundingClientRect(), h = document.querySelector("${head}").getBoundingClientRect();
    return { gutter: b.right <= h.left + 1, level: Math.abs((b.top + b.height / 2) - (h.top + h.height / 2)) < h.height / 2 }; })()`);
  const after = await p.ev(`JSON.stringify(document.querySelector("${head}").getBoundingClientRect())`);
  rows.push(["a heading has a copy glyph in the gutter beside its #, and does not move",
    !!at && at.gutter && at.level && before === after,
    !on ? "no glyph on the heading's hover" : !at.gutter ? "the glyph is over the heading" : !at.level ? "the glyph is off the heading's line" : before !== after ? `the heading moved: ${before} → ${after}` : "beside the #; the heading held still"]);
  // What it copies, read off the writer it hands to the clipboard: the
  // heading and what is under it, to the next heading as high.
  const sec = on && await p.ev(`(async () => {
    let got = null;
    const was = navigator.clipboard.write;
    navigator.clipboard.write = async items => { got = await (await items[0].getType("text/plain")).text(); };
    document.querySelector(".sec-fl").click();
    for (let i = 0; i < 20 && got == null; i++) await new Promise(r => setTimeout(r, 50));
    navigator.clipboard.write = was;
    return { got, said: document.querySelector(".sec-fl").dataset.said === "1" };
  })()`);
  const wantSec = want.slice(want.indexOf("## Steps"));
  rows.push(["the glyph copies its section as Markdown, and says ✓ on itself",
    !!sec && sec.said && sec.got === wantSec,
    !sec ? "no glyph to press" : !sec.said ? "no ✓" : JSON.stringify(sec.got)]);
  await p.ev(`getSelection().removeAllRanges()`);
  await p.pointerAway();
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
  let second = null, third = null;

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
    const actsAt = `Math.round(document.querySelector('#desk-nav .sec-head[data-sec="desks"] .sec-acts button')?.getBoundingClientRect().left ?? -1)`;
    const actsBefore = await p.ev(actsAt);
    await post(`/api/panes/${pane}/agent`, { state: "needs_you" }, { "content-type": "application/json", authorization: `Bearer ${token}` });
    const rang = await until(`!!document.querySelector('a[data-desk="${da}"] .dot.blk') && !!document.querySelector("#desk-nav .sec-n.warn")`);
    // A3 of the audit of 1.46.2: the count has its slot at rest, so its
    // coming moves nothing on the head.
    const actsAfter = await p.ev(actsAt), headN = await p.ev(`document.querySelector('#desk-nav .sec-head[data-sec="desks"] .sec-n')?.textContent || ""`);
    rows.push(["the Desks head holds still when a count arrives", rang && actsBefore >= 0 && actsAfter === actsBefore && headN === "1",
      !rang ? "no count came on the head" : actsBefore < 0 ? "the Desks head has no buttons" : actsAfter !== actsBefore ? `its buttons moved from x ${actsBefore} to ${actsAfter}` : headN !== "1" ? `the count says "${headN}"` : `the count says 1, its buttons still at x ${actsAfter}`]);
    const after = await p.ev(`({ rowA: window.__rowA === document.querySelector('a[data-desk="${da}"]'), row: window.__row === document.querySelector('a[data-desk="${db}"]'), lit: window.__row.matches(":hover") })`);
    rows.push(["a panel that needs you changes only its mark", rang && after.rowA && after.row && after.lit,
      !rang ? "no ! on the desk or the head" : !after.rowA ? "the desk's row was drawn again rather than its mark" : !after.row || !after.lit ? "the row under the pointer was replaced" : "the ! on the desk and on the head, and every row is the row it was"]);

    if (LATELY) {
    // An aside sent from a panel is a way back to it. From the other
    // desk, a click on its row in the corner's Lately opens this one with
    // that panel focused (it may be inside the daemon's quiet, so it is
    // opened from the tray rather than waited for as a card).
    second = (await post(`/api/desks/${da}/panes`)).pane.id;
    await p.clickOn(`a[data-desk="${db}"]`);
    await until(`location.pathname === "/desk/${db}"`);
    const r = await fetch(`${base}/api/notes`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Four evenings on that one, and it held.", sender: "bench-agent", pane: second }) });
    const note = r.ok && (await r.json()).note, from = note && note.from;
    // 1.43: the row is in Lately, the sidebar's, opened by its clock in the
    // head or on the folded rail -- On you's tray holds only what is on you.
    await until(`!!document.querySelector("#onyou .cn-card")`, 10);
    await p.ev(`document.querySelector("#onyou [data-a=cn-later]")?.click(); 1`);
    // 1.44: the clock is in the sidebar's foot, which a browser with no
    // hover (this one) lays out as a row too wide for it, the clock past
    // its edge; so it is pressed, not clicked where it is drawn.
    await p.ev(`document.querySelector(document.querySelector("#btn-lately").getClientRects().length ? "#btn-lately" : "#rail-lately").click(), 1`);
    const go = `#lately-nav .cn-t[data-a="cn-go"][data-r="${note && note.id}"]`;
    const led = !!from && from.id === da && from.slot === 2 && await until(`!!document.querySelector(${JSON.stringify(go)})`);
    if (led) await p.clickOn(go);
    const there = led && await until(`location.pathname === "/desk/${da}" && document.querySelector(".pn.on .pn-body")?.getAttribute("aria-label") === "Panel 2"`);
    rows.push(["an aside from a panel goes back to that panel", !!there,
      !from ? "the daemon did not say where the aside came from" : !led ? "the card does not lead to the panel" : !there ? `the click landed on ${await p.ev("location.pathname")}, not panel 2 of still-a` : "the click opened still-a with panel 2 focused"]);
    } else second = (await post(`/api/desks/${da}/panes`)).pane.id;

    // 1.32: no queue bar on a desk (audit dc5adb4641). 1.33: no slot in the
    // head either -- the rail's Documents already shows what waits here, in
    // bold -- so the head keeps its room to drag the window by.
    const TK = { "content-type": "application/json", authorization: `Bearer ${token}` };
    await post("/api/queue/clear", {}, TK);
    const mine = (await post("/api/docs", { content: "# Here\n\nFrom panel 2.", title: "Sent here", origin: "mcp", pane: second }, TK)).doc;
    const listed = !!mine && await until(`!!document.querySelector('#rail [data-read="${mine.id}"], #rail [href="/d/${mine.id}"]')`, 40);
    const hd = await p.ev(`(() => ({ bar: !document.querySelector("#queue-bar").hidden, slot: !!document.querySelector(".dk-head .dk-arr") }))()`);
    rows.push(["a desk has no arrivals bar or slot; its rail lists what it sent", listed && !hd.bar && !hd.slot,
      hd.bar ? "the queue bar lay over the desk's head" : hd.slot ? "the head still has an arrivals slot" : !listed ? "the rail's Documents did not list the panel's document" : "no bar, no slot, and the rail lists it"]);
    // 1.35: that was still-a's first page, and a desk's first rises once,
    // saying where pages stay (desk/11-elsewhere.js, ui/corner.js). Later
    // takes it down, so the rows below start from a quiet corner.
    const firstRose = !!mine && await until(`/sent this desk's first page/.test(document.querySelector("#onyou .oy-doc .oy-from")?.textContent || "")`, 40);
    if (firstRose) { await sleep(500); await p.clickOn('#onyou [data-a="cn-later"]'); }
    const firstSettled = firstRose && await until(`!document.querySelector("#onyou .oy-doc")`, 30);
    rows.push(["a desk's first page rises once and says where pages stay; Later takes it down", firstRose && firstSettled,
      !firstRose ? "no card said it was this desk's first page" : !firstSettled ? "Later left the card up" : "it rose, said Documents, and Later took it down"]);

    // #122: a document from a panel on another desk was heard nowhere on
    // this one. It rises in the corner, says who sent it, and Later leaves
    // it waiting -- counted on that desk's row; this desk's own never rose.
    // On still-a whatever the rows above left, and one of its own sent first.
    if (await p.ev("location.pathname") !== `/desk/${da}`) { await p.clickOn(`a[data-desk="${da}"]`); await until(`location.pathname === "/desk/${da}" && !!document.querySelector(".dk .pn")`, 50); }
    const own = (await post("/api/docs", { content: "# Mine\n\nFrom panel 2.", title: "Mine again", origin: "mcp", pane: second }, TK)).doc;
    await until(`!!document.querySelector('#rail [data-read="${own && own.id}"]')`, 30);
    const ownRose = await p.ev(`!!document.querySelector("#onyou .oy-doc")`);
    third = (await post(`/api/desks/${db}/panes`)).pane.id;
    const away = (await post("/api/docs", { content: "# There\n\nFrom still-b.", title: "Sent from still-b", origin: "mcp", pane: third }, TK)).doc;
    const rose = !!away && await until(`/still-b · panel 1 sent a document/.test(document.querySelector("#onyou .oy-doc .oy-from")?.textContent || "") && /Sent from still-b/.test(document.querySelector("#onyou .oy-doc .oy-title")?.textContent || "")`, 40);
    // Once it has risen: a press mid-rise lands where the button is going.
    if (rose) { await sleep(500); await p.clickOn('#onyou [data-a="cn-later"]'); }
    const settled = rose && await until(`!document.querySelector("#onyou .oy-doc") && document.querySelector('a[data-desk="${db}"] .end .k')?.textContent === "1"`, 30);
    const settledSaid = settled ? "" : JSON.stringify(await p.ev(`({ card: !!document.querySelector("#onyou .oy-doc"), row: document.querySelector('a[data-desk="${db}"] .end')?.textContent || "" })`));
    const away2 = (await post("/api/docs", { content: "# Again\n\nFrom still-b.", title: "Again from still-b", origin: "mcp", pane: third }, TK)).doc;
    const rose2 = !!away2 && await until(`!!document.querySelector('#onyou [data-a="cn-card-go"]')`, 40);
    if (rose2) { await sleep(500); await p.clickOn('#onyou [data-a="cn-card-go"]'); }
    const opened2 = rose2 && await until(`location.pathname === "/d/${away2 && away2.id}"`, 40);
    rows.push(["a document from another desk rises here; Later leaves it counted on its desk, Open reads it", !ownRose && rose && settled && opened2,
      ownRose ? "this desk's own document rose in the corner" : !rose ? "no card said still-b's panel sent a document" : !settled ? `Later did not leave a count of 1 on still-b's row: ${settledSaid}` :
      !opened2 ? `Open landed on ${await p.ev("location.pathname")}` : "it rose over this desk, Later left a count of 1 on still-b, and Open read the next one"]);
    if (opened2) { await p.ev("history.back(), 1"); await until(`location.pathname === "/desk/${da}"`, 30); }
    await p.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1`);
    await p.pointerAway();

    if (LATELY) {
    // 1.38, the one the reader lost: a page from another desk rises while
    // they work in a panel, and a click into the panel used to take it away
    // for good. Now it settles into Lately, whose clock is dotted, and
    // Lately holds it, where Open reads it (plan b0bca0a11f; 1.43 moved
    // Lately from the tray to the sidebar).
    const lost = (await post("/api/docs", { content: "# Missed\n\nFrom still-b.", title: "Missed from still-b", origin: "mcp", pane: third }, TK)).doc;
    const rose3 = !!lost && await until(`/Missed from still-b/.test(document.querySelector("#onyou .oy-doc .oy-title")?.textContent || "")`, 40);
    if (rose3) { await sleep(400); await p.clickOn(".dk .pn .pn-body"); }
    const clock = await p.ev(`document.querySelector("#btn-lately").getClientRects().length ? "#btn-lately" : "#rail-lately"`);
    const dotted = rose3 && await until(`!document.querySelector("#onyou .oy-doc") && !!document.querySelector(${JSON.stringify(clock)}).querySelector(".lt-dot")?.getClientRects().length`, 30);
    if (dotted) await p.ev(`document.querySelector(${JSON.stringify(clock)}).click(), 1`);
    const inTray = `#lately-nav [data-a="cn-go"][data-r]`;
    const kept = dotted && await until(`[...document.querySelectorAll(${JSON.stringify(inTray)})].some(b => /Missed from still-b/.test(b.textContent))`, 30);
    if (kept) await p.ev(`[...document.querySelectorAll(${JSON.stringify(inTray)})].find(b => /Missed from still-b/.test(b.textContent)).click(), 1`);
    const read = kept && await until(`location.pathname === "/d/${lost && lost.id}"`, 30);
    rows.push(["a page from another desk, missed, settles into Lately, its clock dotted; Open reads it", !!read,
      !rose3 ? "it never rose" : !dotted ? "a click into the panel left Lately's clock with no dot" : !kept ? "Lately has no row for it" : !read ? `its row opened ${await p.ev("location.pathname")}` : "settled, the clock dotted, kept in Lately, and read from there"]);
    if (read) { await p.ev("history.back(), 1"); await until(`location.pathname === "/desk/${da}"`, 30); }
    await p.pointerAway();
    }

    // #171: a page opened from the desk's own list keeps the desk's rail,
    // and its corner with it. A newer version of that page rose twice there,
    // in the desk's corner and the page's, one over the other; Read it then
    // left the desk for the library.
    const vf = join(mkdtempSync(join(tmpdir(), "snyvi-over-")), "over.md");
    writeFileSync(vf, "# Over the desk\n\nThe first version.\n");
    const v1 = (await post("/api/docs", { path: vf, origin: "mcp", pane: second }, TK)).doc;
    const inRail = !!v1 && await until(`!!document.querySelector('#rail [data-read="${v1.id}"]')`, 40);
    if (inRail) await p.clickOn(`#rail [data-read="${v1.id}"]`);
    const over = inRail && await until(`location.pathname === "/d/${v1.id}" && !!document.querySelector("#toc .dk-rail")`, 40);
    writeFileSync(vf, "# Over the desk\n\nThe second version.\n");
    const v2 = over && (await post("/api/docs", { path: vf, origin: "mcp", pane: second }, TK)).doc;
    const rose4 = !!v2 && await until(`/newer version/i.test(document.querySelector("#onyou .oy-card")?.textContent || "")`, 40);
    await sleep(300);
    const cards = await p.ev(`[...document.querySelectorAll(".oy-card")].filter(c => c.getClientRects().length).length`);
    if (rose4) await p.clickOn('#onyou [data-a="cn-card-go"]');
    const stayed = rose4 && await until(`location.pathname === "/d/${v2.id}" && !!document.querySelector("#toc .dk-rail")`, 40);
    rows.push(["a newer version of a page read over its desk rises once, and Read it keeps the desk's rail", rose4 && cards === 1 && stayed,
      !over ? "the page did not open over the desk" : !rose4 ? "no card in the desk's corner said a newer version arrived" : cards !== 1 ? `${cards} cards rose for one version` :
      !stayed ? `Read it opened ${await p.ev("location.pathname")}, ${await p.ev(`!!document.querySelector("#toc .dk-rail")`) ? "over the desk" : "with the library's rail"}` : "one card, in the desk's corner, and the new version read with the desk's rail"]);
  } finally {
    if (second) await post(`/api/panes/${second}/stop`).catch(() => {});
    if (third) await post(`/api/panes/${third}/stop`).catch(() => {});
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
    // #163: an icon in the foot's last slot, the repository named in its tip.
    const linked = await until(`!!document.querySelector("#meta a.dk-repo")`);
    const link = linked ? await p.ev(`({ href: document.querySelector("#meta a.dk-repo").getAttribute("href"), text: document.querySelector("#meta a.dk-repo").dataset.tip })`) : {};
    await p.goto(`${base}/desk/${dPlain}#cap=${cap}`);
    await until(`!!document.querySelector(".dk")`);
    await sleep(1200);
    const none = await p.ev(`!document.querySelector("#meta a.dk-repo")`);
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
    // A2 of the audit of 1.46.2: at 1000 px, sidebar open, Home's container
    // is under 760 px and the grid is one real column. It was three tracks,
    // with the note bar drawn over the Claude box.
    await p.width(1000);
    const one = await p.ev(`(() => { const g = document.querySelector(".hm-grid"), nb = document.querySelector(".hm-nb"); if (!g || !nb) return null; const b = nb.getBoundingClientRect();
      const over = [...g.querySelectorAll(":scope > * > *, :scope > *")].filter(x => x !== nb && !x.contains(nb) && !nb.contains(x) && getComputedStyle(x).display !== "contents" && x.offsetParent).find(x => { const r = x.getBoundingClientRect(); return r.height > 0 && r.top < b.bottom - 1 && r.bottom > b.top + 1 && r.left < b.right - 1 && r.right > b.left + 1; });
      return { tracks: getComputedStyle(g).gridTemplateColumns, over: over ? (over.dataset.w || over.className) : "" }; })()`);
    await p.wide();
    rows.push(["Home at 1000 px is one column, the note bar over nothing", !!one && one.tracks.split(" ").length === 1 && !one.over,
      !one ? "no grid or no note bar on Home" : one.tracks.split(" ").length !== 1 ? `the grid has tracks ${one.tracks}` : one.over ? `the note bar is drawn over ${one.over}` : `one track, ${one.tracks}, and the bar over nothing`]);
    // B2 of the audit of 1.46.2: a running panel's desk wears the same green
    // in the sidebar as on Home, filled; it was a hollow grey ring there.
    const dotC = await p.ev(`(() => { const dt = document.querySelector('#desk-nav a[data-desk="${d}"] .dot'); if (!dt) return null; const ok = document.createElement("span"); ok.style.color = "var(--ok)"; document.body.append(ok); const want = getComputedStyle(ok).color; ok.remove(); return { cls: dt.className, bg: getComputedStyle(dt, "::before").backgroundColor, want }; })()`);
    rows.push(["running is one dot: filled green in the sidebar too", !!dotC && /\brun\b/.test(dotC.cls) && dotC.bg === dotC.want,
      !dotC ? "no mark on home-bench's row" : !/\brun\b/.test(dotC.cls) ? `the mark is "${dotC.cls}"` : `the dot is ${dotC.bg}${dotC.bg === dotC.want ? ", the --ok green" : `, not ${dotC.want}`}`]);
    // 1.19: the date in the head and no clock; Arrived heads the side column
    // and has no ✕; with no friend there is no Friends widget, and Pair with
    // a friend… is in the foot with the version and Check for updates.
    const side = await p.ev(`(() => { const s = document.querySelector(".hm .hm-side"); const first = [...(s?.children || [])].find(x => !x.hidden); const foot = document.querySelector(".hm .hm-foot")?.textContent || ""; return { date: !!document.querySelector(".hm-head .hm-v")?.textContent.trim(), clock: !!document.querySelector(".hm-time, .hm-cal, [data-w=today], [data-w=snyvi]"), first: first?.dataset.w || first?.className || "", hide: !!document.querySelector(".hm-arrived .hm-hide"), friends: !!document.querySelector("[data-w=friends]"), foot: /^Check for updates · Pair with a friend…/.test(foot.trim()), footText: foot, gone: [...document.querySelectorAll(".hm-keys, [data-w=keys], [data-w=threads], .hm-side .hm-upd, .hm-you")].map(x => x.dataset.w || x.className), bar: !!document.querySelector("#queue-bar:not([hidden])") }; })()`);
    // 1.32 (audit 67d008cb6f): seven blocks. No Keys or Threads section, the
    // update's card under the foot, On you shut until its button, and no
    // waiting bar over Home's own sticky bar.
    // Lately hidden, Arrived is only a friend's waiting line, and there is
    // no friend here: Claude heads the column.
    const sideHead = LATELY ? "arrived" : "claude";
    rows.push([`Home: the date in the head, ${LATELY ? "Arrived" : "Claude"} first and not hideable, no Friends without a friend, Pair… in the foot, no Keys, Threads or waiting bar`, side.date && !side.clock && side.first === sideHead && !side.hide && !side.friends && side.foot && !side.gone.length && !side.bar,
      !side.date ? "no date in the head" : side.clock ? "Today or the snyvi widget is still there" : side.first !== sideHead ? `the side column starts with ${side.first}` : side.hide ? "Arrived has a Hide" : side.friends ? "a Friends widget with no friend" : !side.foot ? `the foot does not read Check for updates, then Pair…: "${side.footText}"` : side.gone.length ? `still on Home: ${side.gone.join(", ")}` : side.bar ? "the waiting bar is over Home" : `date, ${LATELY ? "Arrived, " : ""}Claude; Pair… in the foot; no Keys, Threads or waiting bar`]);

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

    // An aside rises in the corner, over the page: nothing in the tree, or
    // in the Inbox, moves when it comes.
    await p.goto(`${base}/inbox`);
    await sleep(400);
    const place = `(() => { const t = document.querySelector("#trees"), d = document.querySelector("#doc"); return { h: t.getBoundingClientRect().height, top: [...t.querySelectorAll("a")].slice(-1)[0]?.getBoundingClientRect().top, doc: Math.round(d.getBoundingClientRect().height) }; })()`;
    const before = await p.ev(place);
    await post("/api/notes", { text: "An aside over the page.", sender: "bench-agent" }, T);
    await until(`!!document.querySelector("#cn .cn-card") || !!document.querySelector("#btn-lately .lt-dot")?.getClientRects().length`);
    await sleep(400);
    const after = await p.ev(place);
    const still = before.h === after.h && before.top === after.top && before.doc === after.doc;
    rows.push(["an aside arriving moves nothing on the page", still,
      still ? "the tree, its last row and the Inbox stayed where they were" : `#trees ${before.h} → ${after.h} px, last row ${before.top} → ${after.top}, #doc ${before.doc} → ${after.doc}`]);

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

    // 1.25: Home under a burst of events. Twenty asides, spaced past the
    // read's debounce: each is Lately's, which Home draws large, so only
    // that section is drawn again -- no redraw of the page (the row under
    // the pointer, the hand in the bar, left alone), no read of /api/home
    // and none of /api/peers, which only a friends event asks for.
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
    const inLately = await p.ev(`/Quiet aside 20\\./.test(document.querySelector(".hm-arrived")?.textContent || "")`);
    // Home shows the newest five, as Arrived did, and the sidebar's Lately
    // the rest (1.43; it was the corner's tray).
    if (!LATELY) {
      const shown = await p.ev(`!!document.querySelector(".hm .cn-lately")`);
      rows.push(["Home under 20 asides, Lately hidden: no Lately drawn, no redraw, no friends read", ev20.draws === 0 && ev20.peers === 0 && !shown,
        `${ev20.draws} redraw${ev20.draws === 1 ? "" : "s"}, ${ev20.peers} read${ev20.peers === 1 ? "" : "s"} of /api/peers${shown ? ", and Lately drawn on Home" : ", nothing of Lately on Home"}`]);
    } else {
    const capped = await p.ev(`(() => { const l = document.querySelector(".hm-arrived .cn-large"); return { n: l?.querySelectorAll(".cn-row").length ?? -1, more: !!l?.querySelector("[data-a=cn-lately]") }; })()`);
    rows.push(["Home under 20 asides: Lately takes them in, five shown and the rest in the sidebar's, no redraw, no friends read", ev20.draws === 0 && ev20.peers === 0 && inLately && capped.n === 5 && capped.more,
      `${ev20.draws} redraw${ev20.draws === 1 ? "" : "s"}, ${ev20.peers} read${ev20.peers === 1 ? "" : "s"} of /api/peers, ${ev20.home} of /api/home${inLately ? ", the last in Lately" : ", the last not in Lately"}, ${capped.n} rows shown${capped.more ? " and a way to the rest" : ", no way to the rest"}`]);
    }
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
      await p.clickOn(".sec-all");
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

/** 1.32 (audit 7c0fc42885): a folder with no git of its own is a project of
 *  its own, so two job folders both called "reel" were two top-level rows.
 *  They hang under the project whose folder holds them: the parent says how
 *  many, and opening it shows them, each still its own project. */
async function nestRows(cdp, base, token, tmp) {
  const rows = [];
  const T = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const ids = [];
  for (const job of ["one", "two"]) {
    const dir = join(tmp, "nest", job, "reel");
    mkdirSync(dir, { recursive: true });
    const r = await fetch(`${base}/api/docs`, { method: "POST", headers: T, body: JSON.stringify({ content: `# ${job}'s reel`, lang: "md", title: `${job}'s reel`, cwd: dir }) });
    ids.push((await r.json().catch(() => ({}))).id);
  }
  const tree = await (await fetch(`${base}/api/tree`)).json();
  const parent = tree.find(x => x.root && (x.root === tmp || x.root.endsWith(basename(tmp))));
  const reels = tree.filter(x => x.name === "reel" && x.root.includes(`${basename(tmp)}/nest/`));
  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  try {
    await p.goto(`${base}/`);
    const row = parent && await until(`!!document.querySelector('#tree .t-proj[data-pid="${parent.id}"] > summary')`);
    const seen = row ? await p.ev(`(() => {
      const top = [...document.querySelectorAll("#tree > .t-proj")].map(d => d.dataset.pid);
      return { subs: document.querySelector('#tree .t-proj[data-pid="${parent.id}"] > summary .t-subs')?.textContent || "", top };
    })()`) : null;
    const reelsTop = seen ? reels.filter(r => seen.top.includes(String(r.id))).length : -1;
    rows.push(["two folders called reel hang under the project that holds them", ids.every(Boolean) && reels.length === 2 && !!seen && +seen.subs >= 2 && reelsTop === 0,
      !ids.every(Boolean) ? "a send was refused" : reels.length !== 2 ? `${reels.length} reel projects` : !seen ? "the parent has no row" : reelsTop ? `${reelsTop} reel still a top-level row` : `the parent says ${seen.subs}, no reel at the top`]);
    if (row) {
      const was = await p.ev(`document.querySelector('#tree .t-proj[data-pid="${parent.id}"]').open`);
      if (!was) await p.clickOn(`#tree .t-proj[data-pid="${parent.id}"] > summary .nm`);
      const under = await until(`${JSON.stringify(reels.map(r => String(r.id)))}.every(id => !!document.querySelector('#tree .t-proj[data-pid="${parent.id}"] > ul > .t-sub > .t-proj[data-pid="' + id + '"]'))`);
      rows.push(["opening the parent shows them, each its own project", under, under ? "both reels under it, one step in" : "the reels are not under the opened parent"]);
      if (!was) await p.clickOn(`#tree .t-proj[data-pid="${parent.id}"] > summary .nm`);
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** The keys sheet (audit 67d008cb6f): the desk's head names the account
 *  its Claude runs as; the sheet opens on that account, not in a form; "+
 *  Claude account" is one button and Add a key a folded row; and an
 *  account's ⋯ puts Rename, Renew and Remove from every desk in its row.
 *  Its desk is parked after, so Home's Pick up is still home-bench. */
async function keysSheetRows(cdp, base) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}) => (await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "keys-sheet" });
  const desk = d.desk ? d.desk.id : d.id;
  const acc = (await post("/api/accounts", { label: "Work", token: "sk-ant-oat01-" + "b".repeat(80) })).account;
  if (acc) await post(`/api/desks/${desk}/account`, { account: acc.id });
  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  try {
    await p.goto(`${base}/desk/${desk}#cap=${cap}`);
    const named = await until(`document.querySelector(".dk-keys-b .acc")?.textContent === "as Work"`);
    rows.push(["the desk's head names the account its Claude runs as", !!acc && named,
      !acc ? "the account was refused" : named ? "as Work, beside the key" : `the button says "${await p.ev(`document.querySelector(".dk-keys-b")?.textContent || ""`)}"`]);
    await p.clickOn(".dk-keys-b");
    const opened = await until(`!!document.querySelector(".dk-keys-sheet .dk-acc-rows input")`);
    const at = opened ? await p.ev(`({ on: document.activeElement?.matches(".dk-acc-rows input:checked") ? document.activeElement.value : "", open: document.querySelectorAll(".dk-keys-sheet .dk-add[open]").length, renew: document.querySelectorAll(".dk-keys-sheet .dk-acc-rows [data-a=acc-renew]").length })`) : null;
    rows.push(["it opens on the account picked, its forms folded, Renew out of sight", !!at && at.on === String(acc?.id) && !at.open && !at.renew,
      !at ? "no sheet" : at.on !== String(acc?.id) ? `the hand is on ${at.on || "something else"}` : at.open ? `${at.open} form open` : at.renew ? "Renew shows a year early" : "on Work, both Add rows shut"]);
    // Not pressed: it would run the real `claude setup-token`.
    const click = await p.ev(`({ b: !!document.querySelector(".dk-keys-sheet .dk-acc-new[data-a=acc-in]"), name: !!document.querySelector(".dk-keys-sheet input[name=label]"), paste: getComputedStyle(document.querySelector(".dk-keys-sheet .dk-acc-paste")).display === "none" })`);
    rows.push(["+ Claude account is one button: no Name, and the paste only once a sign-in fails", click.b && !click.name && click.paste === true,
      !click.b ? "no + Claude account" : click.name ? "a Name field is still there" : click.paste ? "one button, no Name, the paste out of sight" : "the paste field shows"]);
    await p.clickOn(".dk-keys-sheet .dk-key-more > summary");
    const one = await until(`document.querySelector(".dk-key-more").open && document.activeElement?.name === "name"`);
    rows.push(["Add a key opens with the hand in its first field", one, one ? "Add a key open, the hand on Name" : "the hand is elsewhere"]);
    if (acc) {
      await p.clickOn(`.dk-acc-dots[data-n="${acc.id}"]`);
      const acts = await until(`/Remove from every desk/.test(document.querySelector(".dk-acc-acts")?.textContent || "") && !!document.querySelector('.dk-acc-acts [data-a=acc-name]')`);
      rows.push(["an account's ⋯ says what reaches past this desk", acts, acts ? "Rename, Renew, Remove from every desk, in its row" : "no actions in the row"]);
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    if (acc) await post(`/api/accounts/${acc.id}/delete`);
    await post(`/api/desks/${desk}/park`, { next: "bench: the keys sheet is read" });
  }
  return rows;
}

/** 1.7.2, on a desk: a note or a name the daemon refused is back in its
 *  field with the reason under it; the rail puts back what it changed when
 *  the daemon says no, and says which thing failed, in that thing's row. In
 *  a tab of its own, with the capability, as `deskRows` is. */
/** A widget's box (#112): its own title, how often it runs, a failure
 *  in a line with more and Tell the agent, laid over the box's room, which
 *  is kept whether it printed or not (1.36: no layout shift), and a body
 *  past its room that says so with "more". */
async function widgetBoxRows(cdp, base, tmp) {
  if (process.platform === "win32") return [["a widget's box (its scripts are sh here)", true, "not on Windows"]];
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}) => (await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "boxes" });
  const desk = d.desk ? d.desk.id : d.id;
  // One that cannot reach its script from a desk: refused before it runs,
  // so its box has the line and nothing it ever printed.
  const widgets = join(tmp, "config", "widgets");
  const put = (name, spec, script) => {
    mkdirSync(join(widgets, name), { recursive: true });
    writeFileSync(join(widgets, name, "widget.json"), JSON.stringify({ name, ...spec }));
    writeFileSync(join(widgets, name, "run.sh"), script, { mode: 0o755 });
  };
  put("wbox", { title: "Box title", scope: "desk", run: { command: "sh run.sh", every: 5 } }, "#!/bin/sh\necho hi\n");
  // And one that is this desk's own (1.32), in the desk's folder of widgets.
  const own = join(widgets, `@${desk}`, "wown");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "widget.json"), JSON.stringify({ name: "wown", title: "Own one", scope: "desk", run: { command: "run.sh", every: 5 } }));
  writeFileSync(join(own, "run.sh"), "#!/bin/sh\necho own\n", { mode: 0o755 });
  // And a global one that prints more than its one line holds.
  put("wlong", { title: "Long one", scope: "global", run: { command: "run.sh", every: 5 }, lines: 1 },
    `#!/bin/sh\necho '${"A line that goes on. ".repeat(12)}'\n`);
  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 80) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  try {
    await p.goto(`${base}/desk/${desk}#cap=${cap}`);
    const box = `#wg-${desk}-wbox`;
    const came = await until(`!!document.querySelector("${box} .wg-why")`);
    const b = came && await p.ev(`(() => { const el = document.querySelector("${box}");
      return { head: el.querySelector(".sec-head").textContent, by: el.querySelector(".sec-fold").dataset.tipSub,
        body: !!el.querySelector(".wg-body"), over: getComputedStyle(el.querySelector(".wg-err")).position === "absolute",
        tell: !!el.querySelector("[data-wtell]"),
        cut: el.querySelector(".wg-why").classList.contains("cut"), more: __ui.vis("${box} .wg-why > .wg-more"),
        whole: el.querySelector(".wg-why").textContent.includes("runs by itself") }; })()`);
    // Shared, on every desk: its by-line, the name's tip, says so, ahead of how often.
    rows.push(["a widget's box says its own title, where it runs, and how often", !!b && /Box title/.test(b.head) && /^every desk · every 5 s/.test(b.by),
      !came ? "no box with a line came for a widget that cannot reach its script" : `head "${b.head.trim()}", by-line "${b.by}"`]);
    const obox = `#wg-${desk}-wown`;
    const ocame = await until(`!!document.querySelector("${obox} .sec-fold[data-tip-sub]")`);
    const o = ocame && await p.ev(`(() => { const el = document.querySelector("${obox}");
      return { by: el.querySelector(".sec-fold").dataset.tipSub, src: el.dataset.wsrc }; })()`);
    rows.push(["a desk's own widget says only how often, and its frame is the desk's", !!o && /^every 5 s/.test(o.by) && o.src === "own",
      !ocame ? "no box came for a widget in the desk's own folder" : `by-line "${o.by}", data-wsrc "${o.src}"`]);
    // A seat waiting on Allow holds the file's own room (1.46): the first
    // body, six lines tall, moves nothing below it.
    const six = join(widgets, `@${desk}`, "wsix");
    mkdirSync(six, { recursive: true });
    writeFileSync(join(six, "widget.json"), JSON.stringify({ name: "wsix", title: "Six", scope: "desk", run: { command: "run.sh", every: 5 }, lines: 6 }));
    writeFileSync(join(six, "run.sh"), "#!/bin/sh\necho six\n", { mode: 0o755 });
    const sbox = `#wg-${desk}-wsix`;
    const scame = await until(`!!document.querySelector("${sbox} [data-wallow]")`);
    const h0 = scame && await p.ev(`document.querySelector("${sbox}").offsetHeight`);
    const lines0 = scame && await p.ev(`document.querySelector("${sbox} .wg-body").style.getPropertyValue("--lines")`);
    if (scame) await p.clickOn(`${sbox} [data-wallow]`);
    const ran = scame && await until(`/six/.test(document.querySelector("${sbox} .wg-body")?.textContent || "")`, 120);
    const h1 = ran && await p.ev(`document.querySelector("${sbox}").offsetHeight`);
    rows.push(["a seat waiting on Allow keeps the file's own room, so its first body moves nothing", !!ran && lines0 === "6" && h1 === h0,
      !scame ? "no Allow line came for a six-line widget" : lines0 !== "6" ? `the waiting seat had ${lines0 || "no"} lines, not 6` : !ran ? "its body never came after Allow" : h1 !== h0 ? `the seat grew: ${h0} px → ${h1} px` : `${h0} px before and after`]);
    // A body that fills its room exactly is not "cut" by its own padding.
    put("wfit", { title: "Fits", scope: "global", run: { command: "run.sh", every: 5 }, lines: 2 }, "#!/bin/sh\nprintf 'line one  \\nline two\\n'\n");
    const fbox = "#wg-0-wfit";
    const fcame = await until(`!!document.querySelector("${fbox} [data-wallow]")`);
    if (fcame) await post("/api/widgets/wfit/allow", { owner: 0 });
    const fran = fcame && await until(`/line two/.test(document.querySelector("${fbox} .wg-body")?.textContent || "")`, 120);
    const fcut = fran && await p.ev(`document.querySelector("${fbox} .wg-body").classList.contains("cut")`);
    rows.push(["a body that fills its room exactly is not cut", !!fran && fcut === false,
      !fcame ? "no Allow line came for the two-line widget" : !fran ? "its body never came" : fcut ? "two lines in a two-line room were marked cut" : "two lines, no more"]);
    // An agent's widget is removed from its box's menu: Undo stands where
    // it was, at its height, and puts the folder back.
    if (o) {
      const h0 = await p.ev(`document.querySelector("${obox}").offsetHeight`);
      await p.ev(`(() => { const h = document.querySelector("${obox} .sec-head"), r = h.getBoundingClientRect();
        h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 4 })); return 1; })()`);
      const offered = await until(`[...document.querySelectorAll("#ctx:not([hidden]) button.danger")].some(b => b.textContent.trim() === "Remove")`, 30);
      if (offered) await p.ev(`[...document.querySelectorAll("#ctx:not([hidden]) button.danger")].find(b => b.textContent.trim() === "Remove").click(), 1`);
      const undo = offered && await until(`!!document.querySelector('[data-wundo="wown"]:not(:disabled)')`, 30);
      const h1 = undo && await p.ev(`document.querySelector('[data-wundo="wown"]').closest("section").offsetHeight`);
      const kept = existsSync(join(widgets, ".removed")) && readdirSync(join(widgets, ".removed")).some(n => n.startsWith(`${desk}-wown-`));
      rows.push(["Remove on an agent's widget keeps its folder, and says Undo where it was", !!undo && h1 === h0 && kept && !existsSync(own),
        !offered ? "no Remove in a desk's own widget's menu" : !undo ? "no Undo where the box was" : h1 !== h0 ? `the rail moved: ${h0} px → ${h1} px` : !kept ? "nothing kept in widgets/.removed" : "Undo, at its height, and the folder kept"]);
      if (undo) {
        await p.clickOn('[data-wundo="wown"]');
        // Its place holds, saying so, until the runner has run it again: a
        // round or two, and its period when Undo beat the round.
        const holding = await until(`/Bringing .* back/.test(document.querySelector('section.wg[data-w="wown"]')?.textContent || "")`, 30);
        const back = await until(`!!document.querySelector("${obox} .sec-fold[data-tip-sub]")`, 150);
        rows.push(["Undo puts it back, its place held until it runs", holding && back && existsSync(own), !existsSync(own) ? "the folder did not come back" : !holding ? "its place did not hold" : back ? "Bringing it back…, then its box" : "the folder is back, its box not"]);
      }
      const shared = await p.ev(`(() => { const h = document.querySelector("${box} .sec-head"), r = h.getBoundingClientRect();
        h.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 4 })); return 1; })()`)
        && await until(`!!document.querySelector("#ctx:not([hidden]) button")`, 30)
        && await p.ev(`[...document.querySelectorAll("#ctx:not([hidden]) button")].some(b => b.textContent.trim() === "Remove")`);
      await p.press("Escape");
      rows.push(["a shared widget, the reader's own, has no Remove", !shared, shared ? "Remove offered on a shared widget" : "Turn off alone"]);
    }
    rows.push(["a failed one keeps its room, its line laid over it", !!b && b.body && b.over, !b ? "no box" : !b.body ? "no room kept: its first print will move the rail" : !b.over ? "the line is in flow: a failure moves the rail" : "the room, and the line over it"]);
    rows.push(["its reason is kept whole, a line of it shown with more", !!b && b.whole && b.cut && b.more,
      !b ? "no box" : !b.whole ? "the reason is cut short" : !b.cut ? "the line is not cut to its one line" : !b.more ? "no more on a cut line" : "a line, and more"]);
    if (b && b.more) {
      await p.clickOn(`${box} .wg-why > .wg-more`);
      const open = await until(`document.querySelector("${box} .wg-why").classList.contains("open") && document.querySelector("${box} .wg-why > .wg-more").textContent === "less"`, 20);
      rows.push(["more opens the reason where it is", open, open ? "open, and its button says less" : "the click did not open it"]);
    }
    // The reader's own widget (shared, written by hand) has no agent to
    // tell: no Tell the agent on its failure (1.36).
    rows.push(["a widget the reader wrote has no Tell the agent", !!b && !b.tell, !b ? "no box" : b.tell ? "Tell the agent on a widget no agent proposed" : "its failure, and no agent to tell"]);

    // The long one, allowed: its body is cut at one line, says more, and
    // opens where it is.
    await post("/api/widgets/wlong/allow", {});
    const lbox = "#wg-0-wlong";
    const drew = await until(`!!document.querySelector("${lbox} .wg-body") && document.querySelector("${lbox} .wg-body").classList.contains("cut")`);
    const more = drew && await p.ev(`__ui.vis("${lbox} .wg-body > .wg-more")`);
    rows.push(["a body past its room says more", !!more, !drew ? "the long body never came, or was not measured as cut" : !more ? "cut, but no more to see" : "cut at its line, with more"]);
    if (more) {
      const h0 = await p.ev(`document.querySelector("${lbox} .wg-body").clientHeight`);
      await p.clickOn(`${lbox} .wg-body > .wg-more`);
      // menu.js opens it, fetched on the first such click.
      await until(`document.querySelector("${lbox} .wg-body").clientHeight > ${h0}`, 20);
      const h1 = await p.ev(`document.querySelector("${lbox} .wg-body").clientHeight`);
      rows.push(["and more opens it where it is", h1 > h0, `${h0} px → ${h1} px`]);
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    // Opened last, this desk would be Home's Pick up for the sections after;
    // on the shelf it is out of their way.
    await post(`/api/desks/${desk}/park`, { next: "bench: the boxes are read" });
    rmSync(join(widgets, "wbox"), { recursive: true, force: true });
    rmSync(join(widgets, "wlong"), { recursive: true, force: true });
    rmSync(join(widgets, `@${desk}`), { recursive: true, force: true });
    rmSync(join(widgets, ".removed"), { recursive: true, force: true });
  }
  return rows;
}

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
    const notes = await p.ev(`({ line: document.querySelector("#toc .dk-notes:not(.dk-rts) .no-reach")?.textContent || null, prompt: !!document.querySelector("#toc .dk-notes:not(.dk-rts) .dk-note.new") })`);
    if (notes.line) await p.clickOn("#toc .dk-notes:not(.dk-rts) .no-reach [data-a=reload]");
    const prompt = !!notes.line && await until(`!!document.querySelector("#toc .dk-notes:not(.dk-rts) .dk-note.new")`);
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
  // Bracketed paste on while `paste` exists, as at Claude's prompt (S1 below);
  // the mode is printed only when it changes, so the screen is otherwise still.
  const paste = join(tmpdir(), `snyvi-bench-paste-${process.pid}`);
  rmSync(paste, { force: true });
  await post(`/api/panes/${pa}/start`, { cmd: `printf 'see https://example.com/snyvi-bench. then\\n'; b=0; while :; do if [ -e ${paste} ]; then [ $b = 1 ] || { printf '\\033[?2004h'; b=1; }; else [ $b = 0 ] || { printf '\\033[?2004l'; b=0; }; fi; ${sleepBin} 1; done` });
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

    // 1.29.0 (#107): the same hover says what is left of the account, from
    // the freshest panel -- a reading from the other panel is news here too;
    // 1.30.0, and when the week's window resets.
    const now = Math.floor(Date.now() / 1000);
    const said = (id, five) => fetch(`${base}/api/panes/${id}/agent`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "Fable 5.1", ctx: { pct: id === pa ? 87.4 : 10, size: 200000, input: id === pa ? 174800 : 20000 }, limits: { five_hour: { used: five, resets_at: now + 7200 }, seven_day: { used: 20, resets_at: now + 5 * 86400 } } }) });
    const subOf = `document.querySelector('${P(pa)} .pn-ctx')?.dataset.tipSub || ""`;
    await said(pa, 37.6);
    // The week's reset, days away, is a day and a time, not "in 120 h".
    const usage1 = await until(`(${subOf}).startsWith("Usage left: 5 h 62% · resets in 2 h · 7 d 80% · resets ") && !(${subOf}).includes("· resets in 120")`, 30) && await q.ev(subOf);
    await said(pb, 50);
    const usage2 = await until(`(${subOf}).startsWith("Usage left: 5 h 50%")`, 30);
    rows.push(["the context hover says how much usage is left", !!usage1 && usage2,
      !usage1 ? `the hover's second line read "${await q.ev(subOf)}"` : !usage2 ? "a fresher reading from the other panel did not reach it" : `"${usage1}", and the other panel's newer reading`]);

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
    // 1.32 (audit 7c0fc42885): the done half is one row, "N done", at the
    // list's foot; an agent's tick lands under it, out of sight until the
    // row is clicked. A tick by hand stays in sight (above, n1).
    const fold = await until(`!!document.querySelector('[data-a="notes-done"]')`, 40);
    const foldSays = await q.ev(`document.querySelector('[data-a="notes-done"]')?.textContent.trim() || ""`);
    const hidden2 = await q.ev(`!document.querySelector('.dk-note.done:has([data-n="${n2}"])')`);
    rows.push(["the done notes fold into one row, and an agent's tick goes under it", fold && /^\d+ done$/.test(foldSays) && hidden2,
      !fold ? "no done row" : !/^\d+ done$/.test(foldSays) ? `the row reads "${foldSays}"` : !hidden2 ? "the agent's tick is still a row of its own" : `"${foldSays}", the agent's tick under it`]);
    await q.ev(`document.querySelector('[data-a="notes-done"][aria-expanded="false"]')?.click()`);
    const byAgent = tk.ok && await until(`(document.querySelector('.dk-note.done:has([data-n="${n2}"]) > .nm')?.dataset.tipSub || "").includes("ticked by bench-agent")`, 40);
    // Where it went is the tip -- "ticked by bench-agent · 90f09d6" -- and
    // the menu's Copy commit: no hash on the row, and no third line.
    const oneLine = await q.ev(`(() => { const li = document.querySelector('.dk-note.done:has([data-n="${n2}"])'); return li ? { sha: !!li.querySelector(".dk-sha"), by: !!li.querySelector(".dk-by"), tip: li.querySelector(".nm")?.dataset.tipSub || "" } : null; })()`);
    rows.push(["an agent's tick carries its commit, and a branch name is refused", wrong.status === 400 && byAgent && /90f09d6/.test(oneLine?.tip || ""),
      wrong.status !== 400 ? `"main" as a commit answered ${wrong.status}` : `the tip reads "${oneLine?.tip || ""}"`]);
    rows.push(["a ticked note says where it went in its tip, not on its row", byAgent && oneLine && !oneLine.sha && !oneLine.by,
      !byAgent ? "the tip does not say who ticked it" : JSON.stringify(oneLine)]);
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
      return { h: a.getBoundingClientRect().height, bare: b.getBoundingClientRect().height, lh, w: t.getBoundingClientRect().width, row: a.getBoundingClientRect().width,
        lines: Math.round(t.getBoundingClientRect().height / lh), beside: a.querySelectorAll(":scope > :not(.dk-lead):not(.nm):not(.dk-tail):not(.dk-meta)").length,
        marks: a.querySelectorAll(".dk-marks > *").length, tip: a.querySelector(".nm").dataset.tipSub || "" }; })()`);
    // #106: the number and the marks are a line under the text, so a row is
    // its text and that line: two lines of text are one line taller than one.
    rows.push(["a note in a thread keeps the row for its text, two lines, one line taller than a bare one",
      threaded.ok && inTip && !!lay && Math.abs(lay.h - lay.bare - lay.lh) < 1 && lay.w >= lay.row * 0.6 && lay.lines === 2 && lay.beside === 0 && lay.marks === 1 && lay.tip.includes("read by bench-agent"),
      !threaded.ok ? `the thread answered ${threaded.status}` : !inTip || !lay ? "the tip never named the thread" :
        `${lay.h} px tall against ${lay.bare}, text ${Math.round(lay.w)} of ${Math.round(lay.row)} px in ${lay.lines} lines, ${lay.beside} beside it, ${lay.marks} marks, tip "${lay.tip}"`]);

    // #105: a panel's thread is a chip on its row, not a line under it; a
    // second thread the panel starts rests the first, which is then on no
    // list (#109: no Resting), and the chip's menu is what a reader does --
    // Done, Rename, Remove -- not stages, and no Park.
    const thLine = `.dk-pth[data-tip="bench thread with a long name"]`;
    const thOnRow = threaded.ok && await until(`!!document.querySelector('${thLine}')?.closest(".dk-pane") && !document.querySelector(".dk-pane + li.dk-pth")`, 40);
    await agent("thread", { name: "bench second thread", by: "bench-agent" });
    const thRested = await until(`!!document.querySelector('.dk-pane .dk-pth[data-tip="bench second thread"]') && !document.querySelector('${thLine}')
      && !document.querySelector('[data-part="rail.threads"]')`, 40);
    const thListed = (await (await fetch(`${base}/api/desks/${desk}/threads`, { headers: H })).json().catch(() => ({}))).threads?.map(t => t.name) || [];
    await rightOn('.dk-pth[data-tip="bench second thread"]');
    const thMenu = await q.ev(menu);
    const thSaid = thMenu ? thMenu.items.join(" · ") : "";
    if (thMenu) await pick("Done");
    const thDone = !!thMenu && await until(`document.querySelector('.dk-pth[data-tip="bench second thread"] .th-word')?.textContent === "✓ shipped"`, 40);
    rows.push(["a panel's thread is a chip on its row; the next one files the first away, on no list; Done ships it",
      thOnRow && thRested && !thListed.includes("bench thread with a long name") && !!thMenu && !/Move to|Park/.test(thSaid) && thSaid.startsWith("Done") && thDone,
      !thOnRow ? "no chip on the panel's row, or a line under it" : !thRested ? "the second thread did not take the line, or a Resting section is drawn" : thListed.includes("bench thread with a long name") ? `the first is still listed: ${thListed.join(", ")}` :
        !thMenu ? "no menu on the line" : /Move to|Park|^(?!Done)/.test(thSaid) ? `the menu: ${thSaid}` : !thDone ? "Done left it unshipped" : `off the lists; menu ${thSaid}; ✓ shipped`]);

    // 1.37, the loop: an agent's one line shows under its note; a note whose
    // work is out reads "✓ works · not yet…"; works ticks it as the
    // reader's, and not yet… takes what is still wrong and reopens it, out of
    // its thread, with "you: …" under it. (A commit on main naming a note is
    // the other way out; git.rs's own test reads the subjects.)
    const n4 = (await post(`/api/desks/${desk}/notes`, { text: "bench: loop, still broken" })).note.id;
    const n5 = (await post(`/api/desks/${desk}/notes`, { text: "bench: loop, works" })).note.id;
    await agent("thread", { name: "bench loop thread", notes: [n4, n5], by: "bench-agent" });
    await agent(`notes/${n4}/mark`, { stage: "read", by: "bench-agent", say: "bench: what the agent said" });
    const loopSaid = await until(`document.querySelector('${row95(n4)} .dk-reply')?.textContent === "bench: what the agent said"`, 40);
    await agent("thread/move", { stage: "shipped", by: "bench-agent" });
    const both = await until(`!!document.querySelector('${row95(n4)} [data-a="note-works"]') && !!document.querySelector('${row95(n5)} [data-a="note-broken"]')`, 40);
    if (both) await q.clickOn(`${row95(n5)} [data-a="note-works"]`);
    const works = both && await until(`!!document.querySelector('.dk-note.done:has([data-n="${n5}"])')`, 40);
    if (both) await q.clickOn(`${row95(n4)} [data-a="note-broken"]`);
    const loopField = both && await until(`document.activeElement?.matches?.('${row95(n4)} textarea.dk-note-over')`, 20);
    if (loopField) { await q.type("bench: icons still off"); await q.press("Enter", { raw: true }); }
    const reopened = loopField && await until(`document.querySelector('${row95(n4)} .dk-stage.reopened') && document.querySelector('${row95(n4)} .dk-reply.mine')?.textContent === "you: bench: icons still off"`, 40);
    rows.push(["an agent's line shows under its note; out, a note reads works · not yet…; works ticks it, not yet… reopens it with your words",
      loopSaid && both && works && reopened,
      !loopSaid ? "the agent's line never showed under the note" : !both ? "a shipped note never offered works and not yet…" : !works ? "works left the note open" :
        !loopField ? "not yet… opened no field" : !reopened ? "the note did not read reopened, with your words" : "said, shipped, ticked, reopened"]);

    // #110: decisions asked together are one card: a row each, the
    // recommended option marked; the card counts down as they are answered,
    // and only with all of them answered does it offer to send them.
    const grouped = await (await agent("ask", { by: "bench-agent", questions: [
      { question: "bench: reference game?", options: ["SF6", "SF2"], recommended: 0 },
      { question: "bench: buffer off first?", options: ["Off", "On"], recommended: 0 },
      { question: "bench: throws or drills?", options: ["Throws", "Drills"] },
    ] })).json().catch(() => ({}));
    const gIds = (grouped.turns || []).map(t => t.id);
    // They rise in the corner as one card; the pill opens the tray, where
    // they wait however long the answering takes.
    const gRose = gIds.length === 3 && await until(`!!document.querySelector('#onyou .oy-card .dk-turn.grp[data-g="${gIds[0]}"]')`, 40);
    if (gRose) await q.clickOn("#meta .oy-foot, #onyou .oy-pill");
    const gCard = gIds.length === 3 && await until(`document.querySelectorAll('.dk-turn.grp[data-g="${gIds[0]}"] .tn-gq').length === 3`, 40);
    const gRec = gCard && await q.ev(`document.querySelectorAll('.dk-turn.grp[data-g="${gIds[0]}"] .tn-opt.rec').length`);
    const steps = [];
    for (const [i, v] of [[0, "SF6"], [1, "Off"], [2, "Drills"]]) {
      if (!gCard) break;
      steps.push(await q.ev(`document.querySelector('.dk-turn.grp[data-g="${gIds[0]}"] .tn-gfoot')?.textContent || ""`));
      await q.clickOn(`.dk-turn.grp[data-g="${gIds[0]}"] .tn-gq[data-w="${gIds[i]}"] [data-v="${v}"]`);
      await until(`!document.querySelector('.tn-gq[data-w="${gIds[i]}"]')`, 30);
    }
    const gFoot = gCard && await until(`(() => { const f = document.querySelector('.dk-turn.grp[data-g="${gIds[0]}"] .tn-gfoot'); return f && (f.querySelector('[data-a="tn-gsend"]') || /next message/.test(f.textContent)); })()`, 40);
    rows.push(["questions asked together are one card that counts down to Send answers",
      gCard && gRec === 2 && /3 of 3/.test(steps[0] || "") && /1 of 3/.test(steps[2] || "") && !!gFoot,
      gIds.length !== 3 ? `ask with questions answered ${JSON.stringify(grouped).slice(0, 120)}` : !gCard ? "no card with three rows" : gRec !== 2 ? `${gRec} recommended options marked, not 2` :
        !gFoot ? `the foot never offered to send: ${steps.join(" / ")}` : `${steps.join(" → ")} → send`]);
    // S1 (audit e0a854b732): with no Claude in the panel -- a shell -- Send
    // answers is not offered: what it typed there ran as a command.
    const noSend = gCard && await q.ev(`!document.querySelector('.dk-turn.grp[data-g="${gIds[0]}"] [data-a="tn-gsend"]')`);
    rows.push(["with no Claude in the panel, Send answers is not offered", !!noSend,
      !gCard ? "no card to look at" : noSend ? "the answers go with the next message" : "Send answers is offered into a shell"]);
    if (gCard) await q.ev(`document.querySelector('[data-a="tn-gunsend"][data-g="${gIds[0]}"]')?.click(); 1`);
    await q.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
    const trayShut = await until(`!document.querySelector('#onyou .oy-tray')`, 20);
    rows.push(["the questions rose in the corner as one card, and the pill's tray held them until Esc", gRose && trayShut,
      !gRose ? "no card rose in the corner" : "the tray did not close on Esc"]);

    // Claude's own question dialog is on screen in its panel: it neither
    // rises nor counts here, and is kept for Home.
    const dlg = await (await agent("ask", { kind: "decide", via: "dialog", text: "bench: dialog question?", options: ["Yes", "No"] })).json().catch(() => ({}));
    await sleep(700);
    const dlgHere = await q.ev(`(document.querySelector("#onyou")?.textContent || "").includes("bench: dialog question?")`);
    const dlgKept = ((await (await fetch(`${base}/api/desks/${desk}/threads`, { headers: H })).json().catch(() => ({}))).turns || []).some(t => t.text === "bench: dialog question?");
    if (dlg.turn?.id) await agent(`turns/${dlg.turn.id}`, { drop: true });
    rows.push(["Claude's own dialog stays in its panel: not in the corner, kept for Home", !!dlg.turn?.id && !dlgHere && dlgKept,
      !dlg.turn?.id ? `the ask answered ${JSON.stringify(dlg).slice(0, 100)}` : dlgHere ? "it showed in the corner" : "it was not kept"]);

    // #95: a command handed over is a card with the whole command; one that
    // could close the paste early is refused at the door; Run types it into
    // the panel that asked as a ! command, Enter apart, on the click alone.
    const refusedCmd = await agent("handover", { kind: "run", text: "Run this", cmd: "echo \u001b[201~ typed as keys", by: "bench-agent" });
    const railAt = `(() => { const r = document.querySelector('.dk-sec[data-sec="panels"]')?.getBoundingClientRect(); return r ? Math.round(r.top) + ":" + Math.round(r.height) : ""; })()`;
    const railBefore = await q.ev(railAt);
    const handed = await agent("handover", { kind: "run", text: "Upload the bench file", cmd: "echo bench-run-ok", by: "bench-agent" });
    const rose = await until(`!!document.querySelector('#onyou .oy-card .tn-cmd')`, 60);
    const railAfter = await q.ev(railAt);
    rows.push(["a hand-over rises in the corner, and the rail does not move", rose && !!railBefore && railBefore === railAfter && !(await q.ev(`!!document.querySelector('[data-part="rail.turns"]')`)),
      !rose ? "no card rose in the corner" : railBefore !== railAfter ? `Panels moved: ${railBefore} → ${railAfter}` : "an On you section is still on the rail"]);
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

    // S1: into a Claude at its prompt, Send now types the reader's answer
    // alone -- never the agent's question, which is text an agent sent.
    // A Claude at its prompt has bracketed paste on; panel a's loop turns
    // it on while the flag file is there, and off again after the row. The
    // loop wakes once a second, and the card is drawn as Yes is pressed, so
    // the mode is in before the question is.
    writeFileSync(paste, "");
    await sleep(1500);
    const one = await (await agent("ask", { text: "bench: $(echo never typed)?", options: ["Yes", "No"], by: "bench-agent" })).json().catch(() => ({}));
    const oneId = one.turn?.id;
    const oneUp = !!oneId && await until(`!!document.querySelector('#onyou .dk-turn[data-w="${oneId}"] [data-v="Yes"]')`, 60);
    if (oneUp) await q.clickOn(`#onyou .dk-turn[data-w="${oneId}"] [data-v="Yes"]`);
    const sendUp = oneUp && await until(`!!document.querySelector('#onyou [data-a="tn-send"][data-w="${oneId}"]')`, 30);
    await q.ev(`window.__typed = []; 1`);
    if (sendUp) await q.clickOn(`#onyou [data-a="tn-send"][data-w="${oneId}"]`);
    const sentTyped = sendUp && await until(`window.__typed.length >= 2`, 30) ? await q.ev("window.__typed") : [];
    const said1 = (sentTyped[0] || "").replace("\u001b[200~", "").replace("\u001b[201~", "");
    rows.push(["Send now types only the reader's answer, into a Claude", said1 === "Answered in snyvi: Yes" && sentTyped[1] === "\r",
      !oneUp ? `no card for the question: ${JSON.stringify(one).slice(0, 80)}` : !sendUp ? "no Send now with a Claude at its prompt" : `typed ${JSON.stringify(sentTyped)}`]);
    rmSync(paste, { force: true });

    // U1, U2: the corner is the rail's column, over no panel, and above the
    // rail's foot (its repository and links).
    const placed = await q.ev(`(() => { const e = document.querySelector('#onyou'), o = e?.getBoundingClientRect(), r = document.querySelector('#rail')?.getBoundingClientRect(), pl = document.querySelector('#meta')?.getBoundingClientRect();
      return o && r ? { inRail: e.classList.contains("in-rail") && o.left >= r.left - 1 && o.right <= r.right + 1, overFoot: !!pl && pl.height > 0 && o.height > 0 && o.bottom > pl.top + 1 } : null; })()`);
    rows.push(["the corner sits in the rail's column, above its foot", !!placed && placed.inRail && !placed.overFoot,
      !placed ? "no corner, or no rail" : JSON.stringify(placed)]);

    // U7: hand-overs in a burst ring once, and the card says the rest.
    const bs = [];
    for (const t of ["bench: burst one", "bench: burst two"]) bs.push(await agent("handover", { kind: "try", text: t, by: "bench-agent" }));
    const bIds = (await Promise.all(bs.map(r => r.json().catch(() => ({}))))).map(j => j.turn?.id).filter(Boolean);
    const burst = bIds.length === 2 && await until(`/\\+1 more/.test(document.querySelector('#onyou .oy-more')?.textContent || "")`, 60);
    rows.push(["two hand-overs at once rise as one card that says +1 more", !!burst,
      bIds.length !== 2 ? "the hand-overs were refused" : `the corner: ${await q.ev(`document.querySelector('#onyou')?.textContent.slice(0, 120) || ""`)}`]);

    // B1: a card of questions answered elsewhere goes with one ✕, and its
    // one Undo brings every question back.
    const g2 = await (await agent("ask", { by: "bench-agent", questions: [
      { question: "bench: all one?", options: ["A", "B"] }, { question: "bench: all two?", options: ["A", "B"] }] })).json().catch(() => ({}));
    const g2Id = g2.turns?.[0]?.id;
    if (!(await q.ev(`!!document.querySelector('#onyou .oy-tray')`))) await q.clickOn("#meta .oy-foot, #onyou .oy-pill");
    const gx = !!g2Id && await until(`!!document.querySelector('#onyou [data-a="tn-gx"][data-g="${g2Id}"]')`, 40);
    if (gx) await q.clickOn(`#onyou [data-a="tn-gx"][data-g="${g2Id}"]`);
    const gxGone = gx && await until(`!document.querySelector('.dk-turn.grp[data-g="${g2Id}"]') && !!document.querySelector('#onyou [data-a="fd-back"][data-k="g"]')`, 30);
    if (gxGone) await q.clickOn('#onyou [data-a="fd-back"][data-k="g"]');
    const gxBack = gxGone && await until(`document.querySelectorAll('.dk-turn.grp[data-g="${g2Id}"] .tn-gq').length === 2`, 40);
    rows.push(["a card of questions goes with one ✕, and one Undo brings it all back", !!gxBack,
      !g2Id ? `ask answered ${JSON.stringify(g2).slice(0, 80)}` : !gx ? "no ✕ for the whole card" : !gxGone ? "the card stayed, or no Undo" : "the Undo did not bring both back"]);

    // U8: Ctrl+Alt+Y opens and closes the tray from anywhere on the desk.
    const trayOpen = `!!document.querySelector('#onyou .oy-tray')`;
    const yKey = `document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", key: "y", ctrlKey: true, altKey: true, bubbles: true })); 1`;
    const wasOpen = await q.ev(trayOpen);
    await q.ev(yKey);
    const yFlip = await until(`${trayOpen} === ${!wasOpen}`, 20);
    await q.ev(yKey);
    const yBack = yFlip && await until(`${trayOpen} === ${wasOpen}`, 20);
    rows.push(["Ctrl+Alt+Y opens and closes On you", !!yBack, !yFlip ? "the key did nothing" : "it opened but did not close"]);
    await q.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
    for (const id of [...bIds, ...(g2.turns || []).map(t => t.id)]) await post(`/api/desks/${desk}/turns/${id}/remove`, {}).catch(() => {});

    // #114: a key handed over rises whole -- it was cut at two lines, "...then"
    // and no way on -- says where its link goes, and offers Add key..., which
    // opens this desk's keys sheet at its Add a key form; a tip from inside
    // the corner is drawn above the corner, not under it.
    const keyText = "Create a classic GitHub token with only public_repo (no expiry or a long one), then add it on this desk as WINGET_TOKEN so the release can open the winget PR for you.";
    const keyHanded = await agent("handover", { kind: "key", text: keyText, link: "https://github.com/settings/tokens/new?scopes=public_repo", by: "bench-agent" });
    const keyTurn = (await keyHanded.json().catch(() => ({}))).turn?.id;
    const keyRose = keyHanded.status === 201 && await until(`!!document.querySelector('#onyou .oy-card [data-a="tn-key"]')`, 60);
    const keyCard = keyRose ? await q.ev(`(() => { const c = document.querySelector('#onyou .oy-card'), t = c.querySelector('.tn-q'), z = n => +getComputedStyle(document.documentElement).getPropertyValue(n);
      return { whole: t.textContent.length > 150 && t.scrollHeight <= t.clientHeight + 1 && getComputedStyle(t).webkitLineClamp !== "2", by: c.querySelector('.tn-by').textContent, tipOver: z("--z-tip") > z("--z-toast") }; })()`) : null;
    if (keyRose) await q.clickOn('#onyou .oy-card [data-a="tn-key"]');
    const keyForm = keyRose && await until(`!!document.querySelector('.dk-keys-sheet .dk-key-more[open]')`, 30);
    rows.push(["a key hands over whole, says where its link goes, and Add key... opens the keys sheet at its form",
      !!keyCard && keyCard.whole && keyCard.by.includes("github.com") && !keyCard.by.includes("scopes=") && keyCard.tipOver && keyForm,
      !keyRose ? `no key card rose with Add key... (${keyHanded.status})` : !keyCard.whole ? "the question is cut" : !keyCard.by.includes("github.com") || keyCard.by.includes("scopes=") ? `its by-line: "${keyCard.by}"` :
        !keyCard.tipOver ? "tips are under the corner" : !keyForm ? "the keys sheet did not open at Add a key" : `"${keyCard.by}", the sheet open at Add a key`]);
    await q.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
    await until(`!document.querySelector('.dk-keys-sheet')`, 20);

    // #115: pinned, the tray stays open while the reader works elsewhere --
    // a click on the desk, an Esc there -- and is pinned again on the next
    // visit; its head's ✕ closes it, and unpins.
    if (!(await q.ev(`!!document.querySelector('#onyou .oy-tray')`))) await q.clickOn("#meta .oy-foot, #onyou .oy-pill");
    const trayUp = await until(`!!document.querySelector('#onyou .oy-tray [data-a="oy-pin"]')`, 20);
    if (trayUp) await q.clickOn('#onyou .oy-tray [data-a="oy-pin"]');
    const pinOn = trayUp && await until(`document.querySelector('#onyou .oy-pin')?.getAttribute("aria-pressed") === "true"`, 20);
    if (pinOn) await q.clickOn('.dk-sec[data-sec="panels"]');
    await q.ev(`document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
    await sleep(300);
    const pinHeld = pinOn && await q.ev(`!!document.querySelector('#onyou .oy-tray')`);
    const pinKept = await q.ev(`(() => { try { return JSON.parse(localStorage.getItem("snyvi.onyou.pin") || "[]").length === 1; } catch { return false; } })()`);
    if (pinHeld) await q.clickOn("#onyou .oy-tray .oy-x");
    const pinOff = pinHeld && await until(`!document.querySelector('#onyou .oy-tray')`, 20)
      && await q.ev(`JSON.parse(localStorage.getItem("snyvi.onyou.pin") || "[]").length === 0`);
    rows.push(["a pinned tray stays open through a click and an Esc on the desk; its ✕ closes it and unpins",
      pinHeld && pinKept && pinOff,
      !trayUp ? "no tray with a pin" : !pinOn ? "the pin did not press" : !pinHeld ? "the tray closed under the pin" : !pinKept ? "the pin was not remembered" : !pinOff ? "the ✕ left it open, or pinned" : "held open, remembered, then closed and unpinned"]);

    // #118: with nothing fresh, the pill says they are all older, and its
    // tray opens onto them -- not onto one more "N older" to press in an
    // empty box. 1.43: the pill is the rail's notch, its count in quiet ink
    // (not `on`) and "all older" in its label; 1.44: the foot's button, and
    // an older ask is one line in the tray (09-thread.js olderLine), not a
    // turn's card. An hour on the page's clock makes every waiting turn an
    // older one.
    await q.ev(`window.__now = Date.now; Date.now = () => window.__now.call(Date) + 3600e3; 1`);
    const later = await agent("handover", { kind: "try", text: "bench: try the older tray", by: "bench-agent" });
    const laterTurn = (await later.json().catch(() => ({}))).turn?.id;
    const olderPill = await until(`(() => { const b = document.querySelector('#meta .oy-foot, #onyou .oy-pill'); return !!b && !b.classList.contains('on') && /, all older$/.test(b.getAttribute('aria-label') || ""); })()`, 60);
    if (olderPill) await q.clickOn("#meta .oy-foot, #onyou .oy-pill");
    const olderOpen = olderPill && await until(`(() => { const t = document.querySelector('#onyou .oy-tray'); return !!t && !t.querySelector('.oy-older') && t.querySelectorAll('.dk-turn, .oy-old .cn-row').length >= 2; })()`, 30);
    rows.push(["with nothing fresh the pill says older, and its tray opens onto them", olderOpen,
      !olderPill ? `the pill read "${await q.ev(`(() => { const b = document.querySelector('#meta .oy-foot, #onyou .oy-pill'); return b ? (b.getAttribute('aria-label') || b.textContent) + (b.classList.contains('on') ? ", lit" : "") : ""; })()`)}"` : !olderOpen ? "the tray held only a fold to press" : "the pill said all older, and its tray opened onto them"]);
    await q.ev(`Date.now = window.__now; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); 1`);
    for (const id of [keyTurn, laterTurn]) if (id) await agent(`turns/${id}`, { drop: true });

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

    // A4 of the audit of 1.46.2: at the desk's cap the head says it once,
    // in the quiet +'s tip; the rail's Panels head has the count. It drew
    // 4/4 twice, one each side of the Keys button.
    const j = await (await fetch(`${base}/api/desks`, { headers: H })).json(), per = j.per_desk;
    for (let n = j.desks.find(x => x.id === desk).panes.length; n < per; n++) await post(`/api/desks/${desk}/panes`);
    await until(`document.querySelectorAll(".dk-pane").length === ${per}`);
    const capped = await q.ev(`(() => { const b = document.querySelector('.dk-head .icon[data-a="new"]'); return { caps: document.querySelectorAll(".dk-head .dk-cap").length, off: b?.getAttribute("aria-disabled") === "true", sub: b?.dataset.tipSub || "" }; })()`);
    rows.push(["the desk head says the cap once", capped.caps === 0 && capped.off && capped.sub === `A desk holds ${per}`,
      capped.caps ? `${capped.caps} counts on the head` : !capped.off ? "the + is still offered" : `the + is quiet, its tip "${capped.sub}"`]);
  } finally {
    for (const pane of [pa, pb]) await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** #161-#164: the rail's foot is the sidebar's foot's twin and never moves,
 *  with the desk's links in it (1.43);
 *  cards rise above it and move nothing; focus follows a settled pointer
 *  when asked to, and a sweep takes nothing; a run in steps is one card,
 *  stepped through in order. */
/* 1.49: panels in the back (ui/desk/18-back.js). A dev server leaves the
 * grid for a chip in the desk's head; the drawer it opens is laid out all
 * along, so opening it moves nothing; one that dies there needs the reader. */
async function backPanelRows(cdp, base) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const slotOf = async (desk, pane) => { const j = await (await fetch(`${base}/api/desks`, { headers: H })).json(); return j.desks.find(d => d.id === desk)?.panes.find(p => p.id === pane)?.slot; };
  const d = await post("/api/desks", { name: "the back" });
  const desk = d.desk ? d.desk.id : d.id;
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  const front = (await post(`/api/desks/${desk}/panes`)).pane.id;
  const server = (await post(`/api/desks/${desk}/panes`, { back: true })).pane;
  await post(`/api/panes/${front}/start`, { cmd: `while :; do ${sleepBin} 1; done` });
  await post(`/api/panes/${server.id}/start`, { cmd: `echo serving; while :; do ${sleepBin} 1; done` });
  let dies = null;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const chip = id => `.dk-tabs .dk-back .dk-chip[data-drawer="${id}"]`;
  const box = sel => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(",") : ""; })()`;
  try {
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    const chipped = await until(`!!document.querySelector('${chip(server.id)}') && document.querySelectorAll(".dk-grid > .pn").length === 1`);
    const shut = await q.ev(`!document.querySelector(".dk-drawer")?.classList.contains("open")`);
    rows.push(["a panel in the back is a chip, not a slot", server.slot > 4 && chipped && shut,
      server.slot <= 4 ? `it opened in slot ${server.slot}, in the grid` : !chipped ? "no chip in the head, or it took a place in the grid" : !shut ? "the drawer opened on its own" : `slot ${server.slot}: a chip in the head, the grid holds the one panel`]);

    const grid = await q.ev(box(".dk-grid")), inBack = await q.ev(box(`.dk-drawer .pn[data-id="${server.id}"]`));
    await q.ev(`document.querySelector('${chip(server.id)}').click(); 1`);
    const opened = await until(`document.querySelector(".dk-drawer")?.classList.contains("open")`);
    await sleep(200);
    const grid2 = await q.ev(box(".dk-grid")), inBack2 = await q.ev(box(`.dk-drawer .pn[data-id="${server.id}"]`));
    rows.push(["the drawer opens over the grid and moves nothing", opened && !!inBack && grid2 === grid && inBack2 === inBack,
      !opened ? "the chip opened no drawer" : !inBack ? "the panel was not laid out in the drawer while it was shut" : grid2 !== grid ? `the grid moved: ${grid} to ${grid2}` : inBack2 !== inBack ? `the panel took a new size: ${inBack} to ${inBack2}` : `the grid at ${grid}, the panel at ${inBack}, before and after`]);
    await q.ev(`document.querySelector(".dk-drawer .dk-dr-x")?.click(); 1`);
    const closed = await until(`!document.querySelector(".dk-drawer").classList.contains("open")`);
    rows.push(["and its ✕ shuts it", closed, closed ? "shut, the chip still in the head" : "the drawer stayed open"]);

    // A dev server that falls over while nobody looks: the chip and the
    // desk's row say so, as any panel that needs its reader does.
    dies = (await post(`/api/desks/${desk}/panes`, { back: true })).pane.id;
    await post(`/api/panes/${dies}/start`, { cmd: `${sleepBin} 1; echo 'Error: port taken'; exit 3` });
    const died = await until(`!!document.querySelector('${chip(dies)}.blk') && !!document.querySelector('a[data-desk="${desk}"] .dot.blk')`, 100);
    const hint = died ? "" : await q.ev(`(document.querySelector('${chip(dies)}')?.className || "no chip") + " / " + (document.querySelector('a[data-desk="${desk}"] .dot')?.className || "no dot")`);
    rows.push(["a panel that dies in the back needs you", died, died ? "its chip amber, the desk's dot too" : `after it exited 3: ${hint}`]);

    await post(`/api/panes/${server.id}/back`, { back: false });
    const forward = await until(`!!document.querySelector('.dk-grid > .pn[data-id="${server.id}"]') && !document.querySelector('${chip(server.id)}')`);
    const slot = await slotOf(desk, server.id);
    rows.push(["brought forward, it takes the grid's next place", forward && slot === 2,
      !forward ? "it is still a chip, or not in the grid" : `in the grid at slot ${slot}`]);
  } finally {
    for (const pane of [front, server.id, dies]) if (pane) await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

/** #187: a page one panel sent, opened while another had the focus, goes
 *  back to its sender -- the ✕ says so, the rail marks it, full view
 *  follows, one in the back opens its drawer -- and history's way back
 *  lands where the reader was. */
/** #188: ⌘K finds files by name in the desks' folders, under the documents,
 *  and a file picked opens in the folder reader, its desk's folder opened
 *  under Folders on the way. The folder is a desk's and nothing more: it is
 *  opened for reading only to make the desk on it, and closed again. */
async function findRows(cdp, base, token, env, tmp) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const TK = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const dir = join(tmp, "find-188");
  mkdirSync(join(dir, "docs"), { recursive: true }); mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "docs", "planxy188.md"), "# Plan\n\nA file on disk.\n");
  writeFileSync(join(dir, "build", "planxy188.md"), "built\n");
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  const rid = execFileSync(BIN, ["browse", dir, "--no-open"], { env, cwd: tmp, encoding: "utf8" }).trim().split("\n").pop().match(/\/b\/([^/?#]+)/)[1];
  const made = await post("/api/desks", { root: rid, path: "" }), desk = made.desk ? made.desk.id : made.id;
  await post(`/api/browse/${rid}/close`, {}, TK);
  await post("/api/docs", { content: "# Notes on planxy188\n\nWhere the plan stands.", title: "Notes on planxy188", origin: "mcp" }, TK);

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const p = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const listed = () => p.ev(`[...document.querySelectorAll("#palette-list li[data-i]")].map(li => [li.querySelector(".t")?.textContent || "", li.querySelector(".s")?.textContent || ""])`);
  // The last search's rows are marked first: they have the file too, and a
  // wait that found it there read the old list before the new one was drawn.
  const ask = async q => {
    await p.ev(`(() => { document.querySelectorAll("#palette-list li").forEach(li => li.dataset.stale = "1"); const i = document.querySelector("#palette-input"); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await until(`[...document.querySelectorAll("#palette-list li[data-i]:not([data-stale]) .t")].some(t => t.textContent === "planxy188.md")`, 80);
    return listed();
  };
  try {
    await p.goto(`${base}/#cap=${cap}`);
    await until(`!!document.querySelector('a[data-desk="${desk}"]')`);
    await p.press("k", { ctrl: true });
    await until(`!document.querySelector("#palette").hidden && !!document.querySelector("#palette-list li")`);
    const got = await ask("planxy188");
    // Under the desk's name, or under a wider desk's folder that holds this
    // one, which is then searched as part of it.
    const where = s => s === "docs · find-188" || /^find-188\/docs · /.test(s);
    const files = got.filter(([t]) => t === "planxy188.md"), fileAt = got.findIndex(([t]) => t === "planxy188.md"), docAt = got.findIndex(([t]) => t === "Notes on planxy188");
    rows.push(["a file in a desk's folder, by its name", files.length === 1 && where(files[0][1]),
      !files.length ? `no file row: ${got.map(r => r[0]).join(" · ") || "nothing"}` : files.length > 1 ? "the ignored build/ copy is listed too" : !where(files[0][1]) ? `it reads "${files[0][1]}"` : `planxy188.md · ${files[0][1]}, the ignored copy left out`]);
    rows.push(["documents first, files below them", docAt >= 0 && fileAt > docAt,
      docAt < 0 ? "the document that mentions it is not listed" : fileAt < docAt ? "the file is above the document" : "the document, then the file"]);

    const only = await ask("f:planxy188");
    rows.push(["f: asks for files alone", only.length === 1 && only[0][0] === "planxy188.md",
      `${only.map(r => r[0]).join(" · ") || "nothing"}`]);

    await p.clickOn(`#palette-list li[data-i="0"]`);
    const opened = await until(`location.pathname.endsWith("/docs/planxy188.md")`);
    const roots = await (await fetch(`${base}/api/browse`)).json().catch(() => []);
    const folder = roots.find(r => r.path && r.path.endsWith("find-188"));
    rows.push(["picked, it opens in the folder reader", opened && !!folder,
      !opened ? `the page is on ${await p.ev("location.pathname")}` : !folder ? "its desk's folder is not under Folders" : "the file, under its desk's folder, now a row under Folders"]);

    const tabAsks = (await fetch(`${base}/api/find?q=planxy188`)).status;
    rows.push(["a tab without the window's key lists no files", tabAsks === 403, `the route answered ${tabAsks}`]);
  } finally {
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    const roots = await (await fetch(`${base}/api/browse`)).json().catch(() => []);
    for (const r of roots.filter(r => r.path && r.path.endsWith("find-188"))) await post(`/api/browse/${r.id}/close`, {}, TK).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

async function senderRows(cdp, base, token) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const TK = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "senders" });
  const desk = d.desk ? d.desk.id : d.id;
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  const pa = (await post(`/api/desks/${desk}/panes`)).pane.id, pb = (await post(`/api/desks/${desk}/panes`)).pane.id;
  const pc = (await post(`/api/desks/${desk}/panes`, { back: true })).pane.id;
  for (const pane of [pa, pb, pc]) await post(`/api/panes/${pane}/start`, { cmd: `while :; do ${sleepBin} 1; done` });
  const send = async (pane, title) => (await post("/api/docs", { content: `# ${title}\n\nFor the reader.`, title, origin: "mcp", ...(pane ? { pane } : {}) }, TK)).doc.id;
  const fullSlot = async () => (await (await fetch(`${base}/api/desks`, { headers: H })).json()).desks.find(x => x.id === desk)?.full_slot;

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const P = id => `.pn[data-id="${id}"]`;
  const onRow = `document.querySelector("#toc .dk-pane.on .dk-focus")?.dataset.focus`;
  const focusOn = async id => { await q.clickOn(`${P(id)} .pn-body`); return until(`${onRow} === "${id}"`); };
  const read = async id => { await until(`!!document.querySelector('#toc a[data-read="${id}"]')`); await q.ev(`document.querySelector('#toc a[data-read="${id}"]').click(); 1`); return until(`!document.querySelector("#chrome .over").hidden && document.querySelector("#toc .dk-doc.on a")?.dataset.read === "${id}"`); };
  const ex = `document.querySelector("#chrome .over-x")`;
  const docTop = `Math.round(document.querySelector("#doc").getBoundingClientRect().top * 10) / 10`;
  try {
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    await until(`document.querySelectorAll(".dk-grid > .pn").length === 2`);
    // A page sent with no panel is on no desk's list at all, so the one with
    // no sender here came from a panel that has since closed: the desk keeps
    // it, and no panel is there to go back to.
    const pd = (await post(`/api/desks/${desk}/panes`, { back: true })).pane.id;
    const noPanel = await send(pd, "From no panel");
    await post(`/api/panes/${pd}/delete`);
    const fromA = await send(pa, "Plan from panel 1");
    const fromC = await send(pc, "From the back");
    await focusOn(pb);

    // A page no panel sent, for the rule's other side and the page's box.
    const plain = await read(noPanel);
    const plainTip = await q.ev(`${ex}.getAttribute("aria-label")`), plainTop = await q.ev(docTop);
    const plainFrom = await q.ev(`!!document.querySelector("#chrome .over-from")`);
    rows.push(["a page no panel sent goes back to the panels, unmarked", plain && plainTip === "Back to the panels" && !plainFrom,
      !plain ? "it did not open over the desk" : plainFrom ? "the bar named a panel" : `the ✕ says "${plainTip}"`]);
    await q.ev(`${ex}.click(); 1`);
    await until(`${onRow} === "${pb}"`);

    const opened = await read(fromA);
    const tip = await q.ev(`${ex}.getAttribute("aria-label")`), from = await q.ev(`document.querySelector("#chrome .over-from")?.textContent || ""`);
    const marked = await q.ev(`[...document.querySelectorAll("#toc .dk-pane.sent .dk-focus")].map(b => b.dataset.focus).join(",")`);
    const top = await q.ev(docTop);
    rows.push(["while it is read, the ✕, the bar and the rail name panel 1", opened && /^Back to panel 1 · /.test(tip) && /^from Panel 1 · /.test(from) && marked === pa,
      !opened ? "it did not open over the desk" : `✕ "${tip}", bar "${from}", marked [${marked}] for panel 1's ${pa}`]);
    rows.push(["and the page does not move for it", top === plainTop, `the page's top at ${top}, ${plainTop} for a page with no mark`]);

    await q.ev(`${ex}.click(); 1`);
    const toA = await until(`${onRow} === "${pa}" && !!document.querySelector(".dk-grid")`);
    rows.push(["its ✕ focuses panel 1, not panel 2 where the reader was", toA, toA ? "panel 1 has the focus" : `the focus is on ${await q.ev(onRow)}`]);

    await focusOn(pb);
    await read(fromA);
    await q.ev(`history.back(); 1`);
    const stayed = await until(`${onRow} === "${pb}" && !!document.querySelector(".dk-grid")`);
    rows.push(["history's way back lands on panel 2, where the reader was", stayed, stayed ? "panel 2 has the focus" : `the focus is on ${await q.ev(onRow)}`]);

    await q.ev(`document.querySelector('${P(pb)} .pn-full').click(); 1`);
    const zoomed = await until(`document.documentElement.dataset.full === "1"`);
    await read(fromA);
    await q.ev(`${ex}.click(); 1`);
    const followed = await until(`${onRow} === "${pa}"`) && await fullSlot() === 1;
    rows.push(["in full view of panel 2, the ✕ shows panel 1 in full view", zoomed && followed,
      !zoomed ? "panel 2's Full view did not take" : `full view on slot ${await fullSlot()}, the focus on ${await q.ev(onRow)}`]);
    await q.ev(`document.querySelector('${P(pa)} .pn-full').click(); 1`);
    await until(`document.documentElement.dataset.full !== "1"`);

    await read(fromC);
    const backTip = await q.ev(`${ex}.getAttribute("aria-label")`);
    await q.ev(`${ex}.click(); 1`);
    const drawer = await until(`document.querySelector(".dk-drawer")?.classList.contains("open") && !!document.querySelector('.dk-drawer ${P(pc)}')`);
    rows.push(["one in the back opens its drawer", drawer && /^Back to panel [5-8] · /.test(backTip),
      !drawer ? `no drawer on it; the ✕ said "${backTip}"` : `the drawer is open on it; the ✕ said "${backTip}"`]);
  } finally {
    for (const pane of [pa, pb, pc]) await post(`/api/panes/${pane}/stop`).catch(() => {});
    await post(`/api/desks/${desk}/delete`).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return rows;
}

async function footRows(cdp, base, token) {
  const rows = [];
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { "x-snyvi-window": windowSecret } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const d = await post("/api/desks", { name: "feet" });
  const desk = d.desk ? d.desk.id : d.id;
  const pa = (await post(`/api/desks/${desk}/panes`)).pane.id, pb = (await post(`/api/desks/${desk}/panes`)).pane.id;
  const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim();
  for (const pane of [pa, pb]) await post(`/api/panes/${pane}/start`, { cmd: `while :; do ${sleepBin} 1; done` });
  const agent = (pane, path, body) => fetch(`${base}/api/panes/${pane}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const { targetId, sessionId } = await tab(cdp);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${prelude})()` }, sessionId);
  // A headless page is never the window in front: hover focus waits for that.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {});
  const q = new Driver(cdp, sessionId);
  const until = async (expr, tries = 60) => { for (let i = 0; i < tries; i++) { if (await q.ev(expr)) return true; await sleep(100); } return false; };
  const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
  const P = id => `.pn[data-id="${id}"]`;
  const rects = `(() => { const r = q => { const b = document.querySelector(q)?.getBoundingClientRect(); return b ? [b.top, b.height].map(n => Math.round(n * 10) / 10) : null; };
    return { meta: r("#meta"), side: r(".side-foot"), toc: r("#toc") }; })()`;
  try {
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    await until(`document.querySelectorAll(".dk-grid > .pn").length === 2 && !!document.querySelector("#meta .dk-repo")`);
    await q.clickOn(`${P(pa)} .pn-body`);
    await sleep(600);

    // #163: one height, rules level, one line.
    const feet = await q.ev(rects);
    rows.push(["the rail's foot is the sidebar's foot's height, its rule level with it", !!feet.meta && !!feet.side && feet.meta[1] === feet.side[1] && Math.abs(feet.meta[0] - feet.side[0]) <= .5,
      JSON.stringify(feet)]);
    // 1.43: the desk's links sit in the foot, whole, the rest under +N, and
    // nothing moves; a seventh is refused, and so is what is not the web.
    const notWeb = await agent(pa, "links", { label: "x", url: "javascript:alert(1)" });
    rows.push(["a link refuses what is not the web", notWeb.status === 400, `answered ${notWeb.status}`]);
    for (const [i, l] of ["Live site", "Staging", "Dashboard", "Docs", "Status page", "Analytics"].entries())
      await agent(pa, "links", { label: l, url: `http://127.0.0.1:7801/${i}` });
    const seventh = await agent(pa, "links", { label: "Seventh", url: "http://127.0.0.1:7801/7" });
    const lkUp = await until(`document.querySelectorAll("#meta .dk-lk").length + +(document.querySelector("#meta .dk-lk-more")?.textContent.slice(1) || 0) === 6`, 40);
    await sleep(300);
    const sat = await q.ev(`(() => { const m = document.querySelector("#meta"), b = m.getBoundingClientRect(), cs = [...m.querySelectorAll(".dk-lk")].map(c => c.getBoundingClientRect());
      return { whole: cs.every(c => c.right <= b.right + .5 && c.top >= b.top - .5 && c.bottom <= b.bottom + .5), shown: cs.length, more: m.querySelector(".dk-lk-more")?.textContent || "", rects: ${rects} }; })()`);
    rows.push(["links sit whole in the foot, the rest under +N, and nothing moves", lkUp && seventh.status === 409 && sat.whole && JSON.stringify(sat.rects) === JSON.stringify(feet),
      JSON.stringify({ seventh: seventh.status, ...sat })]);
    // Its ✕ leaves Undo in the link's place; Undo brings it back.
    const lid = await q.ev(`document.querySelector("#meta .dk-lk-x")?.dataset.lk || ""`);
    await q.ev(`document.querySelector("#meta .dk-lk-x")?.click()`);
    const shut = await until(`!!document.querySelector('#meta .dk-lk.shut .dk-lk-undo[data-lk="${lid}"]')`, 20);
    const shutRects = await q.ev(rects);
    await q.ev(`document.querySelector("#meta .dk-lk-undo")?.click()`);
    const lkBack = await until(`!document.querySelector("#meta .dk-lk.shut") && !!document.querySelector('#meta .dk-lk-x[data-lk="${lid}"]')`, 30);
    rows.push(["a link's ✕ leaves Undo in its place, and Undo brings it back", !!lid && shut && lkBack && JSON.stringify(shutRects) === JSON.stringify(feet),
      JSON.stringify({ lid, shut, back: lkBack })]);

    // #162: cards rise above the foot and move nothing.
    const refused = await agent(pa, "card", { kind: "link", label: "x", url: "javascript:alert(1)" });
    rows.push(["a card refuses a link that is not the web", refused.status === 400, `answered ${refused.status}`]);
    const posted = [];
    for (const [i, c] of [["one", "text"], ["two", "link"], ["three", "text"], ["four", "text"]].entries())
      posted.push((await agent(pa, "card", { id: c[0], kind: c[1], label: `card ${c[0]}`, url: c[1] === "link" ? "http://127.0.0.1:7801/" : undefined, for: i === 3 ? 30 : undefined })).status);
    const up = await until(`document.querySelectorAll("#dk-cards .dk-card").length === 3 && /\\+1/.test(document.querySelector("#dk-cards .dk-card-more")?.textContent || "")`, 40);
    // What it saw when they never showed: the answers, how many, the count,
    // and which panel had the keys (cards are the focused panel's).
    const saw = up ? "" : await q.ev(`JSON.stringify({ posted: ${JSON.stringify(posted)}, cards: document.querySelectorAll("#dk-cards .dk-card").length, more: document.querySelector("#dk-cards .dk-card-more")?.textContent || "", on: document.querySelector(".pn.on")?.dataset.id || "", pa: "${pa}" })`);
    await sleep(1200);
    const stood = await q.ev(`(() => { const m = document.querySelector("#meta").getBoundingClientRect(); const cs = [...document.querySelectorAll("#dk-cards .dk-card")].map(c => c.getBoundingClientRect());
      return { above: cs.every(c => c.bottom <= m.top + .5), rects: ${rects}, drain: !!document.querySelector("#dk-cards .dk-card-drain") }; })()`);
    rows.push(["cards rise above the foot, three and a count, and nothing moves", up && stood.above && stood.drain && JSON.stringify(stood.rects) === JSON.stringify(feet),
      !up ? `three cards and +1 never showed: ${saw}` : !stood.above ? "a card is over the foot" : !stood.drain ? "the card with a lifetime has no drain" : JSON.stringify(stood.rects)]);
    // The same id again is the same card, rewritten where it stands.
    await agent(pa, "card", { id: "four", kind: "text", label: "card four, again" });
    const same = await until(`(() => { const t = [...document.querySelectorAll("#dk-cards .dk-card")].map(c => c.dataset.tip); return t.length === 3 && t.includes("card four, again") && !t.includes("card four"); })()`, 20);
    rows.push(["the same id updates its card in place", same, same ? "three cards, the fourth rewritten" : await q.ev(`[...document.querySelectorAll("#dk-cards .dk-card")].map(c => c.dataset.tip).join(" · ")`)]);
    // A panel's cards follow its focus.
    await q.clickOn(`${P(pb)} .pn-body`);
    const gone = await until(`!document.querySelector("#dk-cards .dk-card")`, 30);
    await q.clickOn(`${P(pa)} .pn-body`);
    const back = await until(`document.querySelectorAll("#dk-cards .dk-card").length === 3`, 30);
    rows.push(["cards sink when focus leaves their panel, and rise when it comes back", gone && back, !gone ? "they stayed for the other panel" : !back ? "they did not come back" : "gone with the focus, back with it"]);

    // #161: off by default; on, a settled pointer takes the focus, a sweep does not.
    const off = await q.ev(`localStorage.getItem("snyvi.hover-focus") !== "1"`);
    await q.ev(`localStorage.setItem("snyvi.hover-focus", "1"); 1`);
    // The same URL again is a jump to its fragment, which fires no load
    // event: a page between makes it a new document, read with the setting.
    await q.goto("about:blank");
    await q.goto(`${base}/desk/${desk}#cap=${cap}`);
    await until(`document.querySelectorAll(".dk-grid > .pn").length === 2`);
    await q.clickOn(`${P(pa)} .pn-body`);
    await sleep(900);
    const A = await q.ui("center", `${P(pa)} .pn-body`), B = await q.ui("center", `${P(pb)} .pn-body`), R = await q.ui("center", "#toc");
    const on = () => q.ev(`document.activeElement?.closest(".pn")?.dataset.id || ""`);
    // A sweep from panel 1 across panel 2 to the rail, in 120 ms.
    for (let i = 1; i <= 12; i++) { await mouse("mouseMoved", A.x + (R.x - A.x) * i / 12, A.y + (R.y - A.y) * i / 12); await sleep(10); }
    await sleep(500);
    const swept = await on();
    // A move to panel 2 that rests there.
    for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", R.x + (B.x - R.x) * i / 6, R.y + (B.y - R.y) * i / 6); await sleep(16); }
    await sleep(450);
    const rested = await on();
    const pinged = await q.ev(`!!document.querySelector("#dk-sonar i")`);
    rows.push(["focus follows a settled pointer, and a sweep takes nothing", off && swept === pa && rested === pb && pinged,
      !off ? "it was on before it was asked" : swept !== pa ? "the sweep took the focus" : rested !== pb ? `resting on panel 2 left the focus on ${rested || "nothing"}` : !pinged ? "no sonar" : "panel 2, with a ping"]);
    // A key just typed holds the focus where it is.
    await q.clickOn(`${P(pa)} .pn-body`);
    await sleep(900);
    await q.press("x");
    for (let i = 1; i <= 4; i++) { await mouse("mouseMoved", A.x + (B.x - A.x) * i / 4, B.y); await sleep(16); }
    await sleep(400);
    const typing = await on();
    rows.push(["a key just typed holds the focus", typing === pa, typing === pa ? "panel 1 kept it" : "the pointer took it mid-typing"]);

    // #189: reaching for panel 1's card across panel 2 gives panel 2 the
    // focus on the way; the card stays where it stands for the pointer,
    // and follows the focus once the pointer is back in the panels.
    await q.clickOn(`${P(pa)} .pn-body`);
    await sleep(900);
    const cardAt = () => q.ev(`(() => { const c = document.querySelector("#dk-cards .dk-card"), b = c?.getBoundingClientRect(); return b ? { n: document.querySelectorAll("#dk-cards .dk-card").length, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), top: Math.round(b.top) } : null; })()`);
    const before = await cardAt();
    for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", A.x + (B.x - A.x) * i / 6, A.y + (B.y - A.y) * i / 6); await sleep(16); }
    await sleep(400);
    const crossed = await on();
    for (let i = 1; i <= 6 && before; i++) { await mouse("mouseMoved", B.x + (before.x - B.x) * i / 6, B.y + (before.y - B.y) * i / 6); await sleep(16); }
    await sleep(600);
    const reached = await cardAt();
    for (let i = 1; i <= 6; i++) { await mouse("mouseMoved", B.x + (before?.x - B.x || 0) * (6 - i) / 6, B.y + (before?.y - B.y || 0) * (6 - i) / 6); await sleep(16); }
    await sleep(400);
    const followed = await until(`!document.querySelector("#dk-cards .dk-card")`, 30);
    rows.push(["a card reached for across another panel stays put, then follows the focus", !!before && before.n === 3 && crossed === pb && !!reached && reached.n === 3 && reached.top === before.top && followed,
      !before ? "panel 1 had no cards" : crossed !== pb ? `crossing panel 2 left the focus on ${crossed || "nothing"}` : !reached || reached.n !== 3 || reached.top !== before.top ? `under the pointer: ${JSON.stringify({ before, reached })}` : !followed ? "back in panel 2, panel 1's cards stayed" : "held under the pointer, gone once it was back in panel 2"]);

    // #189: a toast over the corner keeps its place while the pointer is on
    // it, the risen card under it held past its 8 s; both go once it leaves.
    // A real toast first, off and on again, so toast.js and its look are in.
    await q.clickOn("#btn-hover");
    await q.clickOn("#btn-hover");
    await until(`!!document.querySelector("#toasts .toast")`, 20);
    await until(`!document.querySelector("#toasts .toast")`, 60);
    await q.clickOn(`${P(pa)} .pn-body`);
    await agent(pa, "handover", { kind: "do", text: "bench: the corner holds", by: "bench-agent" });
    const risen = await until(`!!document.querySelector("#onyou .oy-card")`, 60);
    const tAt = () => q.ev(`(() => { const b = document.querySelector("#toasts .bench-toast")?.getBoundingClientRect(); return b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), top: Math.round(b.top) } : null; })()`);
    await q.ev(`(() => { const t = document.createElement("div"); t.className = "toast bench-toast"; t.textContent = "bench: a toast"; document.querySelector("#toasts").append(t); })(), 1`);
    await sleep(500);   // its way in, 8 px, done
    const t0 = await tAt();
    if (t0) await mouse("mouseMoved", t0.x, t0.y);
    await sleep(9000);
    const t1 = await tAt(), stillUp = await q.ev(`!!document.querySelector("#onyou .oy-card")`);
    await q.pointerAway();
    const settledOut = await until(`!document.querySelector("#onyou .oy-card")`, 40);
    await sleep(300);
    const t2 = await tAt();
    await q.ev(`document.querySelector("#toasts .bench-toast")?.remove(), 1`);
    rows.push(["a toast over the corner holds still under the pointer, the card under it held", risen && !!t0 && !!t1 && t1.top === t0.top && stillUp && settledOut && !!t2 && t2.top > t0.top,
      !risen ? "the hand-over never rose" : !t0 ? "no toast to point at" : t1?.top !== t0.top ? `the toast moved ${t1 ? t1.top - t0.top : "?"} px under the pointer` : !stillUp ? "the card settled under the pointer" : !settledOut ? "the card stayed once the pointer left" : !t2 || t2.top <= t0.top ? "the toast never came down: the hold was not what kept it" : `held at ${t0.top}, down to ${t2.top} once the pointer left`]);
    await q.ev(`localStorage.removeItem("snyvi.hover-focus"); 1`);

    // #190: no chime without a card. With no rail in view the turn rises in
    // the window's corner, and the pill's tip says what rang.
    await q.width(900);
    await agent(pa, "handover", { kind: "do", text: "bench: rung with the rail away", by: "bench-agent" });
    const cornered = await until(`!!document.querySelector("#onyou:not(.in-rail) .oy-card")`, 60);
    const tipSaid = await q.ev(`document.querySelector("#onyou .oy-pill")?.dataset.tipSub || ""`);
    rows.push(["with no rail in view, a turn rises in the window's corner, and On you says what rang", cornered && /Last chime: .*rung with the rail away/.test(tipSaid),
      !cornered ? "nothing rose: the chime rang for a card no one could see" : `the pill's tip says ${JSON.stringify(tipSaid)}`]);
    await q.wide();

    // #164: a run in steps is one card, run in order.
    const steps = await agent(pa, "handover", { kind: "run", text: "bench: a walk-through", by: "bench-agent",
      options: ["$ echo one", "Plug the phone in", "# Is it seen?", "$ echo two"] });
    const bad = await agent(pa, "handover", { kind: "run", text: "bench: a bad step", options: ["$ echo one\necho two"] });
    await q.ev(`document.querySelector('[data-a="oy-open"]')?.click(); 1`);
    const card = await until(`document.querySelectorAll(".tn-walk .tn-step").length === 3`, 40);
    const first = await q.ev(`(() => { const s = [...document.querySelectorAll(".tn-walk .tn-step")]; return { on: s[0]?.classList.contains("on"), done: !!s[0]?.querySelector('[data-a="tn-step-done"]'), later: !!s[2]?.querySelector('[data-a="tn-step-done"], [data-a="tn-step-run"]') }; })()`);
    await q.ev(`document.querySelector('.tn-walk .tn-step.on [data-a="tn-step-done"]')?.click(); 1`);
    const moved = await until(`document.querySelectorAll(".tn-walk .tn-step")[1]?.classList.contains("on") && document.querySelectorAll(".tn-walk .tn-step")[0]?.classList.contains("ok")`, 20);
    rows.push(["a run in steps is one card, the next step the only one to press", steps.status < 300 && bad.status === 400 && card && first.on && first.done && !first.later && moved,
      steps.status >= 300 ? `the route answered ${steps.status}` : bad.status !== 400 ? "a step with a newline was taken" : !card ? "no card of three steps" : !first.on || first.later ? JSON.stringify(first) : !moved ? "Done did not move it on" : "step 1 done, step 2 lit"]);
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
  // From nothing waiting, so the first arrival is what makes the bar appear;
  // the sections before this one leave a queue.
  await p.ev(`fetch("/api/queue/clear", { method: "POST" })`);
  await until(`document.querySelector("#queue-bar").hidden`);
  const first = await arrive();
  await until(`!document.querySelector("#queue-bar").hidden`);
  await p.ev(`window.__bar = document.querySelector("#queue-bar .qb")`);
  // The tree draws the row once its project's list is fetched, after the bar.
  await until(`!!document.querySelector('#tree a[data-id="${first.id}"]')`, 7);
  const washed = await p.ev(`(() => { const li = document.querySelector('#tree li.t-doc.wash:has(> a[data-id="${first.id}"])'); return li ? li.getAnimations().filter(x => x.animationName === "land").length : -1; })()`);
  rows.push(["an arrival washes its row", washed === 1, washed < 0 ? "the row is not marked as washed" : `${washed} wash animation${washed === 1 ? "" : "s"} on the row`]);

  // A second arrival 300 ms in rebuilds every row. The first one's wash
  // carries on from where it was: a restart would read near zero. Where a
  // wash is, is its time less its delay -- a negative delay is how the page
  // resumes it, and the animation's own clock restarts from zero.
  await sleep(300);
  const second = await arrive();
  await until(`/^1\\/2/.test(document.querySelector("#queue-bar").textContent)`);
  const resumed = await p.ev(`(() => { const li = document.querySelector('#tree li.wash:has(> a[data-id="${first.id}"])'); const w = li && li.getAnimations().find(x => x.animationName === "land"); return w ? Math.round(w.currentTime - w.effect.getTiming().delay) : -1; })()`);
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

  // \`n\` opens the newest, the second: its row in the tree is no longer
  // lit, and Recent counts one fewer. Nothing closes: Waiting's list, where
  // a read row used to, is gone (1.36.1).
  await p.press("n");
  await sleep(400);
  const after = await p.ev(`({ lit: !!document.querySelector('#tree a.new[data-id="${second.id}"]'), n: document.querySelector("#inbox-row .t-inbox.new .n")?.textContent || "" })`);
  rows.push(["a read unlights its row, and Recent counts it", !after.lit && after.n === "1",
    after.lit ? "the tree still marks it unread" : after.n !== "1" ? `Recent reads "${after.n}"` : "unmarked in the tree; Recent 2, then 1"]);

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
  rows.push(["a sweep over the rows fetches nothing", ids.length >= 5 && quick.length >= 4 && crossed.length === 0,
    ids.length < 5 ? `only ${ids.length} fresh rows on screen to sweep`
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
  // agent's that is still unread. It rises in the corner (ui/corner.js).
  // From the page, as corner.js asks it: a reader's action needs our Origin.
  await p.ev(`fetch("/api/lately/seen", { method: "POST" }).then(r => r.status)`);
  await p.ev(`Object.keys(localStorage).filter(k => k.startsWith("snyvi.seen.") || k.startsWith("snyvi.own.")).forEach(k => localStorage.removeItem(k)); 1`);
  await p.goto(url);
  await arrive(); await arrive();
  const said = await until(`/^Two are waiting/.test(document.querySelector("#cn .cn-card .cn-text")?.textContent || "")`, 40);
  await p.ev(`document.querySelector("#cn [data-a=cn-later]")?.click(); 1`);
  await sleep(4500);
  await arrive();
  await sleep(800);
  const again = await p.ev(`/^Two are waiting/.test(document.querySelector("#cn .cn-card .cn-text")?.textContent || "")`);
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

/** #191. Show me → on a page rings the control snyvi's own list names: the
 *  link carries an id, never a selector, and an id the list lacks does
 *  nothing at all. And Welcome's ▶ Watch it plays the loop in place: three
 *  of the tour's frames in turn under their captions, which Escape closes. */
async function guideRows(p, url, arrive) {
  const rows = [];
  const until = async (expr, tries = 50) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const d = await arrive({ name: "show-me.md", body: "# Show me\n\n[Show me →](/show?f=pdf) · [Not one](/show?f=nope)\n" });
  const origin = await p.ev("location.origin");
  await p.goto(`${origin}/d/${d.id}`);
  await p.pointerAway();
  await until(`!!document.querySelector('#doc a[href="/show?f=pdf"]')`);
  await p.clickOn('#doc a[href="/show?f=pdf"]');
  const rung = await until(`(() => { const r = document.querySelector(".gd-ring.on"), b = document.querySelector("#btn-pdf-top"); if (!r || !b) return false;
    const x = r.getBoundingClientRect(), y = b.getBoundingClientRect(); return y.width > 0 && x.left <= y.left && x.right >= y.right && x.top <= y.top && x.bottom >= y.bottom; })()`);
  rows.push(["Show me → rings the control it names", rung, rung ? "a ring round Save as PDF, in the page's head" : "no ring round Save as PDF"]);
  await until(`!document.querySelector(".gd-ring.on")`, 40);
  await p.clickOn('#doc a[href="/show?f=nope"]');
  await sleep(700);
  const quiet = await p.ev(`!document.querySelector(".gd-ring.on") && !/Not a page/.test(document.querySelector("#toasts")?.textContent || "") && location.pathname === ${JSON.stringify(`/d/${d.id}`)}`);
  rows.push(["and an id snyvi does not list does nothing", quiet, quiet ? "no ring, no toast, still on the page" : "a ring, a toast, or a move"]);

  await p.goto(`${origin}/welcome`);
  await p.pointerAway();
  await until(`!!document.querySelector('[data-w="w-watch"]')`);
  await p.clickOn('[data-w="w-watch"]');
  const cap = `document.querySelector(".w-wcap li.on")?.textContent || ""`;
  const playing = await until(`document.querySelectorAll(".w-wpic img").length === 3 && (${cap}).startsWith("1")`);
  // A frame is 6.7 s; the second comes on its own.
  const moved = playing && await until(`(${cap}).startsWith("2") && document.querySelectorAll(".w-wpic img.on").length === 1`, 90);
  rows.push(["▶ Watch it plays the loop in place", playing && moved,
    !playing ? "no three frames under their captions" : !moved ? `still on "${await p.ev(cap)}" after 9 s` : "frame 1, then frame 2 on its own, one picture showing at a time"]);
  await p.press("Escape");
  const closed = await until(`document.querySelector(".w-wbox")?.hidden && document.querySelector('[data-w="w-watch"]').getAttribute("aria-expanded") === "false" && location.pathname === "/welcome"`);
  rows.push(["Escape closes it, and stays on Welcome", closed, closed ? "the box is closed and its button says so" : `the box is ${await p.ev(`document.querySelector(".w-wbox")?.hidden ? "closed" : "open"`)}, on ${await p.ev("location.pathname")}`]);
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
