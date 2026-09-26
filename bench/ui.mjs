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
 *
 * Counts and positions only, no clocks, so every row is enforced on every
 * machine. Chromium is driven the way browser.mjs drives it, over the
 * DevTools protocol with nothing installed; the gestures are real input
 * events -- a wheel, a click, a key -- rather than calls into the page,
 * because a handler that is never reached by the real event is the fault
 * being looked for.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, copyFileSync, existsSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { plan, flowchart } from "./fixture.mjs";
import { launch, killTree, pageLoad, evaluate, sleep, tab } from "./chrome.mjs";

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
    const arrive = async () => {
      const n = ++arrivals, path = join(tmp, `arrival-${n}.md`);
      writeFileSync(path, `# Arrival ${n}\n\nA document that came in while something else was being read.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, cwd: tmp }),
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
    sections.push(["the rail, 1280 px wide", await railRows(p, url, md, send)]);
    sections.push(["narrow windows", await narrowRows(p, url)]);
    sections.push(["by keyboard", await keyboardRows(p, url)]);
    sections.push(["the panes' edges", await widthRows(p, url)]);
    sections.push(["a diagram, filled", await diagramRows(p, diagramUrl)]);
    sections.push(["arrivals, while reading", await queueRows(p, url, arrive)]);
    sections.push(["a delete, and the way back", await deleteRows(p, arrive)]);
    sections.push(["the ✕ over what is read", await backRows(p, browsed)]);
    sections.push(["an aside, closed", await asideRows(p, base, token)]);
    sections.push(["a folder, in the file manager", await revealRows(p, browsed, folder, tmp)]);
    sections.push(["a link into a folder", await browseRows(p, browsed)]);
    sections.push(["a link out of a document", await docLinkRows(p, base, token, first.doc.id)]);
    sections.push(["the socket a page holds", await socketRows(p, url, base, browsed)]);
    sections.push(["a window to hand a link to", await windowRows(p, url, base, mcpSend)]);
    sections.push(["a link that opens in the window", await linkRows(p, url, base, env, tmp, token, stub, mcpSend)]);
    sections.push(["what moves, and for how long", await motionRows(p, url, arrive)]);
    sections.push(["desks that hold still", await deskRows(cdp, base, token)]);
    sections.push(["answers beside their buttons", await answerRows(url, tmp)]);
    sections.push(["every control, in every view", await controlRows(cdp, p, url, browsed, base, token)]);
    sections.push(["the first frame, in the reader's theme", await firstFrameRows(p, url)]);
    sections.push(["the about box", await aboutRows(p, url)]);
    sections.push(["connecting an agent", await connectRows(p, url, home, env)]);
    sections.push(["an agent that is here", await presenceRows(p, url, base, env, tmp)]);
    // Last, because it takes the library with it.
    sections.push(["a reset, and the friction on it", await resetRows(p, url, arrive)]);
    // And after it, because it takes the daemon.
    sections.push(["a daemon that stops, and the page that follows", await stopRows(p, base, tmp, env, second)]);

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
  Delete: { key: "Delete", code: "Delete", vk: 46 },
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
  rows.push(["a letter asleep does nothing, and says why", !asleep.on && asleep.title === asleepAt.title && /show/.test(asleep.pill) && asleep.says === "⌃B for keys",
    asleep.title !== asleepAt.title ? "k moved without ⌃B" : `pill "${asleep.says}" (${asleep.pill})`]);
  await p.press("b", { ctrl: true }); await sleep(200);
  const woke = await keyState();
  await p.press("k", { raw: true }); await sleep(500);
  const moved = await keyState();
  await p.press("j", { raw: true }); await sleep(500);
  const movedBack = await keyState();
  rows.push(["⌃B wakes the letters, and they stay awake", woke.on && /on/.test(woke.pill) && woke.says === "Keys on · esc" && moved.title !== woke.title && movedBack.title === woke.title && movedBack.on,
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

  await p.width(700);
  const narrow = await p.ev(`({ side: window.__ui.vis("#side"), button: window.__ui.vis("#btn-side") })`);
  await p.press("\\");
  const sideOpen = await p.ev(`({ sheet: document.documentElement.dataset.sheet, side: window.__ui.vis("#side"), focus: window.__ui.focus() })`);
  await p.press("Escape");
  const sideClosed = await p.ev(`({ sheet: document.documentElement.dataset.sheet, side: window.__ui.vis("#side") })`);
  rows.push(["at 700 px, \\ opens the sidebar", !narrow.side && narrow.button && sideOpen.sheet === "side" && sideOpen.side && sideOpen.focus.inSide && !sideClosed.side && sideClosed.sheet === undefined,
    narrow.side ? "the sidebar is still beside the document" : !narrow.button ? "no button offers the sidebar"
      : !sideOpen.side ? "\\ opened nothing" : !sideOpen.focus.inSide ? "focus stayed outside the sheet" : sideClosed.side ? "Escape did not close it"
        : "a sheet, focus inside, Escape closes it"]);

  const titleBefore = await p.ev("document.title");
  await p.clickOn("#btn-side");
  const rowsShown = await p.ev(`({ all: document.querySelectorAll(".t-doc a").length, other: document.querySelectorAll(".t-doc a:not([aria-current])").length })`);
  if (rowsShown.other) await p.clickOn(`.t-doc a:not([aria-current])`);
  await sleep(600);
  const navigated = await p.ev(`({ sheet: document.documentElement.dataset.sheet, title: document.title })`);
  await p.wide();
  const widened = await p.ev(`({ side: window.__ui.vis("#side"), width: Math.round(document.querySelector("#side").getBoundingClientRect().width), rail: window.__ui.vis("#rail"), sheet: document.documentElement.dataset.sheet })`);
  await p.pointerAway();
  rows.push(["a row in the sheet, then a wider window", navigated.title !== titleBefore && navigated.sheet === undefined && widened.side && widened.width > 200 && widened.rail && widened.sheet === undefined,
    navigated.title === titleBefore ? `the row opened nothing (${rowsShown.all} rows, ${rowsShown.other} not current)` : navigated.sheet ? "the sheet stayed open over the document it opened"
      : !widened.side || widened.width <= 200 ? `back at 1280 px the sidebar is ${widened.side ? widened.width + " px" : "gone"}` : !widened.rail ? "back at 1280 px the rail is gone"
        : "opens the document and closes; both panes are back at 1280 px"]);

  for (const w of [1000, 700]) {
    await p.width(w);
    // Clear anything left over; with nothing over the page, Esc would take
    // the reader off the document (backRows), which is not this row's to do.
    if (await p.ev(`!!document.documentElement.dataset.sheet || document.body.classList.contains("keys")`)) await p.press("Escape");
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
    await p.press("\\"); check("\\", (await p.ev(`document.documentElement.dataset.sheet`)) === (w <= 760 ? "side" : undefined) && (w <= 760 || await p.ev(`document.documentElement.dataset.side === "0"`))); await p.press("Escape");
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

/** 0.12: by keyboard, and by a finger. */
async function keyboardRows(p, url) {
  const rows = [];
  await p.goto(url);
  await p.pointerAway();

  // Tab from the top of the page, noting where focus lands each time, until
  // it comes back round or runs out.
  await p.ev(`document.activeElement.blur(); window.__ui.scrollMain(0)`);
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
  const twelve = await until(`/^12 waiting/.test(document.querySelector("#queue-bar").textContent)`);
  await sleep(300);
  const many = await read();
  // Twelve sent at once land in whatever order the daemon took them; the
  // order it keeps is the order the page must show.
  const served = await p.ev(`fetch("/api/queue").then(r => r.json()).then(q => q.map(d => d.title))`);
  const inOrder = many.side.join("|") === served.slice(0, 6).join("|");
  rows.push(["twelve at once", twelve && many.side.length === 6 && /6 more/.test(many.more || "") && inOrder,
    !twelve ? `the bar reads "${many.bar ? many.bar.slice(0, 20) : "nothing"}"` : many.side.length !== 6 ? `${many.side.length} rows in the sidebar` : !/6 more/.test(many.more || "") ? `"${many.more}" under them` : !inOrder ? `the sidebar's order is not the daemon's` : "bar reads 12 waiting; six rows and \"6 more\" in the sidebar, in arrival order"]);

  await p.reload();
  const kept = await read();
  rows.push(["still waiting after a reload", /^12 waiting/.test(kept.bar || "") && kept.side.length === 6,
    `the bar reads "${(kept.bar || "nothing").slice(0, 20)}", ${kept.side.length} rows in the sidebar`]);

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
  void late;
  return rows;
}

/** 0.15: a removal is one keystroke and a few seconds of Undo, over a soft
 *  delete the daemon keeps until `prune` runs. The confirmation it replaces
 *  was a `window.confirm`, which the native window draws as the toolkit's own
 *  dialog -- and which would hang every row below, since a blocked page
 *  answers nothing. 1.6: the Undo stands in the row's own place, for 4 s,
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
    await sleep(4600);
    const held = !!(await ghost());
    rows.push(["resting on it stops the clock", held, held ? "still offering Undo after 4.6 s under the pointer" : "it went while the pointer was on it"]);
    await p.pointerAway();
    await sleep(4800);
    const settled = !(await ghost());
    rows.push(["and off it, the offer ends", settled, settled ? "the row closed once the 4 s had run" : "the ghost is still there"]);
  } else rows.push(["the ✕ leaves its Undo in the row", false, "the document's row is not in the sidebar"]);

  await p.reload();
  const stillGone = !(await listed(doomed.title));
  const found = await p.ev(`fetch("/api/search?q=" + encodeURIComponent(${JSON.stringify(doomed.title)})).then(r => r.json()).then(h => h.length)`);
  rows.push(["a removal a reload agrees with", stillGone && found === 0,
    !stillGone ? "the inbox lists it again after the reload" : found ? `search still finds ${found}` : "gone from the inbox and from search, because the daemon did it"]);
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
    return { shown: !o.hidden && r.width > 0, title: x.title }; })()`);

  await p.goto(`${origin}/`);
  await p.pointerAway();
  const onInbox = await bar();
  await p.clickOn(".inbox a[data-id]");
  await until(`location.pathname.startsWith("/d/")`);
  const first = await where(), b1 = await bar();
  await p.press("j"); await until(`location.pathname !== ${JSON.stringify(first)}`);
  const second = await where();
  await p.press("j"); await until(`location.pathname !== ${JSON.stringify(second)}`);
  const read = new Set([first, second, await where()]).size;
  rows.push(["every document has the ✕", !onInbox.shown && b1.shown && /Back to Inbox/.test(b1.title),
    onInbox.shown ? "the Inbox has one too" : !b1.shown ? "a document opened from the Inbox has none" : `its tooltip reads "${b1.title}"`]);
  await p.clickOn("#chrome .over-x");
  const home = await until(`location.pathname === "/" && !!document.querySelector(".inbox")`);
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
  const deep = await until(`location.pathname === "/"`);
  rows.push(["a deep link goes to the Inbox", deep, deep ? "no screen behind it, so the Inbox" : `landed on ${await where()}`]);

  await p.goto(`${origin}${first}`);
  await p.pointerAway();
  await p.press("k", { ctrl: true });
  const pal = await until(`!document.querySelector("#palette").hidden`, 10);
  await p.press("Escape"); await sleep(200);
  const stayed = await p.ev(`document.querySelector("#palette").hidden && location.pathname === ${JSON.stringify(first)}`);
  await p.press("Escape");
  const esc = await until(`location.pathname === "/"`);
  rows.push(["Esc takes one thing down at a time", pal && stayed && esc,
    !pal ? "⌃K opened no palette" : !stayed ? `the first Esc left the page for ${await where()}` : esc ? "the first Esc shut the palette, the second went to the Inbox" : "the second Esc stayed on the document"]);
  return rows;
}

/** An aside can be closed: the ✕ on its card, or Esc on it, and the card
 *  stands as one line holding the Undo for 4 s, as a removed document's row
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
  const next = await until(`document.querySelector("#note .note-now p")?.textContent === ${JSON.stringify(older.text)}`, 70);
  rows.push(["when the offer ends, the next aside has the card", next, next ? "the older aside, after 4 s" : `the card reads ${JSON.stringify(await card())}`]);

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

/** An Open in file manager beside every Open terminal here: the document's, the
 *  browsed folder's, and the folder row's menu. The daemon resolves the ids
 *  itself and hands the folder to the desktop's opener -- stubbed for the
 *  probe, which reads back what it was handed. */
async function revealRows(p, browsed, folder, tmp) {
  const rows = [];
  const until = async (expr, tries = 40) => { for (let i = 0; i < tries; i++) { if (await p.ev(expr)) return true; await sleep(100); } return false; };
  const opened = join(tmp, "opened");
  const origin = await p.ev("location.origin");
  await p.goto(`${origin}/`);
  await p.clickOn(".inbox a[data-id]");
  await until(`location.pathname.startsWith("/d/")`);
  const inDoc = await until(`!!document.querySelector('#meta [data-act="reveal"]')`, 20);
  await p.goto(`${browsed.replace(/\/$/, "")}/notes.md`);
  const inBrowse = await until(`!!document.querySelector('#meta [data-act="reveal"]')`, 20);
  rows.push(["Open in file manager beside Open terminal here", inDoc && inBrowse,
    !inDoc ? "a document's meta has none" : inBrowse ? "in a document's meta and a browsed file's" : "a browsed file's meta has none"]);

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
  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).capability;
  const H = { "x-snyvi-capability": cap, "content-type": "application/json" };
  const post = async (path, body = {}, h = H) => (await fetch(base + path, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const a = await post("/api/desks", { name: "still-a" }), b = await post("/api/desks", { name: "still-b" });
  const [da, db] = [a.desk ? a.desk.id : a.id, b.desk ? b.desk.id : b.id];
  const pane = (await post(`/api/desks/${da}/panes`)).pane.id;
  await post(`/api/panes/${pane}/start`, { cmd: `while :; do printf "\\033]0;work %s\\007" $RANDOM; sleep 0.1; done` });

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
    const rang = await until(`!!document.querySelector('a[data-desk="${da}"] .dot.blk') && !!document.querySelector("#desk-nav .s-blk")`);
    const after = await p.ev(`({ rowA: window.__rowA === document.querySelector('a[data-desk="${da}"]'), row: window.__row === document.querySelector('a[data-desk="${db}"]'), lit: window.__row.matches(":hover") })`);
    rows.push(["a panel that needs you changes only its mark", rang && after.rowA && after.row && after.lit,
      !rang ? "no ! on the desk or the head" : !after.rowA ? "the desk's row was drawn again rather than its mark" : !after.row || !after.lit ? "the row under the pointer was replaced" : "the ! on the desk and on the head, and every row is the row it was"]);
  } finally {
    await post(`/api/panes/${pane}/stop`).catch(() => {});
    for (const d of [da, db]) await post(`/api/desks/${d}/delete`).catch(() => {});
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
  for (const [id, name] of [["#btn-theme", "theme"], ["#btn-accent", "accent"], ["#btn-font", "Aa"]]) {
    await p.hoverOn(".foot-set");
    await p.clickOn(id);
    await sleep(450);
    const m = await p.ev(`(() => { const t = document.querySelector("#toasts .toast"), b = document.querySelector(${JSON.stringify(id)});
      if (!t) return null; const r = t.getBoundingClientRect(), s = b.getBoundingClientRect();
      return { toast: r.top + r.height / 2, button: s.top + s.height / 2, h: r.height }; })()`);
    const off = m ? Math.abs(m.toast - m.button) : null;
    rows.push([`${name}'s answer beside it`, off !== null && off <= 3,
      m === null ? "no answer came up" : `its centre ${Math.round(m.toast)} px, the button's ${Math.round(m.button)} px, ${off.toFixed(1)} px apart`]);
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
      const dim = await drv.ev(`(() => { const b = document.querySelector(${JSON.stringify(id)}); return b.classList.contains("dim") ? { label: b.dataset.label, said: document.querySelector("#toasts .toast .s")?.textContent || "" } : null; })()`);
      const ok = dim ? !!dim.said && dim.label.endsWith(dim.said) && after === before : after !== before;
      rows.push([`${c} on ${view}`, ok, dim ? `dimmed: "${dim.label}"${after !== before ? ", and it changed something anyway" : ""}` : after !== before ? "it changed what it sets" : "not dimmed, and it changed nothing"]);
      // Back as it was: a second press for the toggles; Aa's steps are keys.
      await drv.pointerAway();
      await drv.ev(`(() => { const d = document.documentElement; delete d.dataset.font; localStorage.removeItem("snyvi.font"); return 1; })()`);
      if (!dim && c !== "font") { await drv.hoverOn(".foot-set"); await drv.clickOn(id); await drv.pointerAway(); }
    }
  };
  await p.goto(url);
  await walk(p, "a prose document");
  await p.goto(`${browsed}/code.rs`);
  await sleep(400);
  await walk(p, "a code file");
  await p.goto(base + "/");
  await walk(p, "the inbox");

  const cap = (await (await fetch(`${base}/api/capability`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).capability;
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
    await until(`(${size}) !== ""`);
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
  await until(`/^2 waiting/.test(document.querySelector("#queue-bar").textContent)`);
  const resumed = await p.ev(`(() => { const li = document.querySelector('#queue li.wash:has(> a[data-id="${first.id}"])'); const w = li && li.getAnimations().find(x => x.animationName === "land"); return w ? Math.round(w.currentTime - w.effect.getTiming().delay) : -1; })()`);
  rows.push(["once, whatever the tree does under it", resumed >= 250 && resumed < 700, resumed < 0 ? "the wash is gone or was never there" : `the wash is ${resumed} ms in, on a row rebuilt by the next arrival`]);
  const bar = await p.ev(`(() => { const qb = document.querySelector("#queue-bar .qb"); const n = qb && qb.querySelector(".qb-n");
    return { kept: qb === window.__bar, rise: qb ? qb.getAnimations().some(a => a.animationName === "rise") : null, tick: n ? n.getAnimations().some(a => a.animationName === "tick") : null }; })()`);
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
  await until(`/^2 waiting/.test(document.querySelector("#queue-bar").textContent)`);
  const quiet = await anims();
  await p.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] }, p.s);
  rows.push(["reduced motion means none", quiet.length === 0, quiet.length ? `${quiet.length} still running: ${[...new Set(quiet.map(a => a.name))].join(", ")}` : "no animation on the page at all"]);
  void second;
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
  const source = await p.ev(`(() => { const a = document.querySelector("#about-facts a"); return a && a.href === ${JSON.stringify(served.repository)} && a.target === "_blank"; })()`);
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
  const same = opened && JSON.stringify(names) === JSON.stringify(served.rows.map(r => r.name));
  const allOff = same && (await p.ev(`[...document.querySelectorAll(".agent:not([data-agent^='sender:'])")].every(e => e.classList.contains("is-off"))`));
  rows.push(["? reaches it, one row per agent", offered && same && allOff,
    !offered ? "no Connect an agent in the help box" : !opened ? "the page did not open" : !same ? `rows ${JSON.stringify(names)}` : !allOff ? "a row is not 'not set up' in a home that has never seen an agent" : `${names.length} rows, in the daemon's order, every agent not set up`]);

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
  const live = () => p.ev(`(e => ({ n: e.textContent, on: e.classList.contains("on"), title: e.title }))(document.querySelector("#live"))`);
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
  const row = await until(`location.pathname === "/connect" && document.querySelector('.agent[data-agent="sender:bench-agent"]')?.classList.contains("is-live") && /^online/.test(document.querySelector('.agent[data-agent="sender:bench-agent"] .agent-state').textContent)`, 40);
  const said = row && await p.ev(`document.querySelector('.agent[data-agent="sender:bench-agent"] .agent-state').textContent`);
  rows.push(["the count opens the rows, and its row says online", row, row ? `the connect page, bench-agent "${said}"` : `at ${await p.ev("location.pathname")}, the row does not say online`]);

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
  const opened = await until(`!document.querySelector("#reset").hidden && /This removes \\d+ documents? in/.test(document.querySelector("#reset-say").textContent)`);
  const census = await p.ev(`fetch("/api/reset").then(r => r.json())`);
  const focused = await p.ui("at", "#reset-n");
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
  const refused = await until(`!document.querySelector("#reset-err").hidden && /has changed/.test(document.querySelector("#reset-err").textContent)`);
  const stillHere = !(await p.ev(`document.querySelector("#reset").hidden`)) && (await p.ev(`fetch("/api/reset").then(r => r.json()).then(c => c.documents)`)) === census.documents + 1;
  const reasked = (await say()).includes(`${census.documents + 1} document`) && await goDisabled();
  rows.push(["a stale number is refused", refused && stillHere && reasked,
    !refused ? "nothing said, or the wrong thing" : !stillHere ? "the library was reset on a number that was no longer true" : !reasked ? "the sentence was not brought up to date" : "refused, the sentence says the new number, and the button is dead again"]);

  await p.type(String(census.documents + 1));
  await p.press("Enter");
  const landed = await until(`location.pathname === "/" && !!document.querySelector(".connect .agent")`, 80);
  const left = landed ? await p.ev(`(() => { try { return Object.keys(localStorage).filter(k => k.startsWith("snyvi.")); } catch { return []; } })()`) : [];
  const forgotten = landed && left.length === 0;
  const wideOff = landed && !(await p.ev(`document.documentElement.dataset.wide`));
  const empty = (await p.ev(`fetch("/api/reset").then(r => r.json()).then(c => c.documents)`)) === 0;
  // The agents were not touched: the row the connect rows turned is still connected.
  const stillConnected = landed && await p.ev(`document.querySelector('.agent[data-agent="cursor"]')?.classList.contains("is-connected")`);
  rows.push(["and lands where a newcomer does", landed && forgotten && wideOff && empty && stillConnected,
    !landed ? `on "${await p.ev("location.pathname")}" with title "${await p.ev("document.title")}"` : !forgotten ? `still in the page's storage: ${left.join(", ")}` : !wideOff ? "the width preference survived" : !empty ? "the daemon still has documents" : !stillConnected ? "the Cursor row no longer says connected" : "the connect page, the width forgotten, nothing in storage, Cursor still connected"]);
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
  await fetch(`${base}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
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
