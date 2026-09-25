#!/usr/bin/env node
/**
 * A panel's worth of an agent at work, the same every run.
 *
 * The desk's cost is paint, and what it paints is a Claude-Code-like screen:
 * a framed header, `─` rules, a rounded input box, block characters and a
 * powerline status line, all of them drawn cells in the page (DRAWN in
 * ui/desk.js), under one line that a spinner and a timer rewrite many times a
 * second. A real agent gives a different screen every run, so this draws a
 * fixed one and changes only that line, from a frame count rather than the
 * clock. It never scrolls: the whole screen is placed with the cursor.
 *
 *    node bench/tui-load.mjs [--hz 10]
 *
 * Run in a panel; bench/webkit.py starts four of these on a desk and reads
 * what the window's web process spends drawing them. Redraws itself on a
 * resize, since the page sizes the panel after it starts.
 */

const args = process.argv.slice(2);
const HZ = Number(args[args.indexOf("--hz") + 1]) || 10;

const E = "\x1b[";
const fg = n => `${E}38;5;${n}m`, bg = n => `${E}48;5;${n}m`, R = `${E}0m`, B = `${E}1m`, DIM = `${E}2m`;
const at = (y, x = 0) => `${E}${y + 1};${x + 1}H`;
const PL = "", PLT = "", PLR = "";

const cut = (s, n) => [...s].slice(0, Math.max(0, n)).join("");
const pad = (s, n) => cut(s, n) + " ".repeat(Math.max(0, n - [...s].length));

/** A rounded frame `w` wide around `lines`, each line already free of escapes
 *  except through `paint`, which colours the inside. */
function frame(w, lines, colour, paint = s => s) {
  const inner = w - 4;
  return [
    `${fg(colour)}╭${"─".repeat(w - 2)}╮${R}`,
    ...lines.map(l => `${fg(colour)}│${R} ${paint(pad(l, inner))} ${fg(colour)}│${R}`),
    `${fg(colour)}╰${"─".repeat(w - 2)}╯${R}`,
  ];
}

function screen(cols, rows) {
  const w = Math.max(20, cols);
  const out = [];
  out.push(...frame(Math.min(w, 60), [
    "✻ Welcome to Claude Code",
    "",
    "  /help for help, /status for your current setup",
    "",
    "  cwd: /home/bench/project",
  ], 173, s => s.replace("Welcome to Claude Code", `${B}Welcome to Claude Code${R}`)));
  out.push(`${fg(208)} ▐▛███▜▌${R}   Opus 5.5 · Claude Max`);
  out.push(`${fg(208)}▝▜█████▛▘${R}  ~/project`);
  out.push(`${fg(208)}  ▘▘ ▝▝${R}`);
  out.push(`  tests ${fg(114)}${"█".repeat(18)}▊${R}${fg(238)}${"░".repeat(11)}${R} 62%  ▁▂▃▄▅▆▇█ ▏▎▍▌▋▊▉`);
  out.push("");
  out.push(`${fg(250)}> Draw the desk's box characters from bitmaps instead of SVG masks${R}`);
  out.push("");
  out.push(`${fg(114)}⏺${R} ${B}Read${R}(ui/desk.js)`);
  out.push(`  ⎿  Read 1,612 lines`);
  out.push(`${fg(114)}⏺${R} ${B}Update${R}(ui/desk.js)`);
  out.push(...frame(Math.min(w, 72), [
    "268 - function drawn(W, H) {",
    "268 + function drawn(W, H, dpr = devicePixelRatio) {",
    "269     const t = Math.max(1, Math.round(W / 7));",
  ], 240, s => s.replace(/^(\d+ )-/, `$1${fg(203)}-`).replace(/^(\d+ )\+/, `$1${fg(114)}+`) + R));
  // Room for the spinner, then the bottom: rule, input box, status line.
  const bottom = [
    `${fg(238)}${"─".repeat(w)}${R}`,
    ...frame(w, [`> ${DIM}Try "how does paint() decide which rows changed"${R}`], 244),
    `${bg(31)}${fg(231)} ~/project ${fg(31)}${bg(238)}${PL}${fg(250)}  claude/desk-paint ${fg(238)}${bg(236)}${PL}${fg(250)} ${PLT} +3 ~2 ${R}${fg(236)}${PL}${R}` +
      ` ${fg(244)}? for shortcuts${R}`,
  ];
  // What does not fit above the spinner is cut, as a real screen would scroll it off.
  const spinY = Math.max(0, rows - bottom.length - 2);
  return { lines: out.slice(0, spinY), spinY, bottom, bottomY: spinY + 2 };
}

const SPIN = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
let layout, frameNo = 0;

function draw() {
  const cols = process.stdout.columns || 80, rows = process.stdout.rows || 24;
  layout = screen(cols, rows);
  let s = `${E}?25l${E}2J${E}H`;
  layout.lines.forEach((l, y) => { s += at(y) + l; });
  layout.bottom.forEach((l, i) => { if (layout.bottomY + i < rows) s += at(layout.bottomY + i) + l; });
  process.stdout.write(s + tick(true));
}

/** The one line that changes: a spinner, a timer and a token count, all from
 *  the frame number so two runs draw the same frames. */
function tick(quiet) {
  if (!quiet) frameNo++;
  const secs = Math.floor(frameNo / HZ), tokens = (1.2 + frameNo * 0.013).toFixed(1);
  const line = `${fg(208)}${SPIN[frameNo % SPIN.length]}${R} ${fg(208)}Painting…${R} ${fg(244)}(${secs}s · ↑ ${tokens}k tokens · esc to interrupt)${R}`;
  return at(layout.spinY) + `${E}2K` + line;
}

process.stdout.on("resize", draw);
draw();
setInterval(() => process.stdout.write(tick(false)), 1000 / HZ);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { process.stdout.write(`${R}${E}?25h\n`); process.exit(0); });
