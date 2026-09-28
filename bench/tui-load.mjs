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
 *    node bench/tui-load.mjs [--hz 10] [--split [--sync]]
 *    node bench/tui-load.mjs --scroll [20] [--fill 6500]
 *
 * Run in a panel; bench/webkit.py starts four of these on a desk and reads
 * what the window's web process spends drawing them. Redraws itself on a
 * resize, since the page sizes the panel after it starts.
 *
 * `--scroll` is the other half of an agent's screen: output that goes by. It
 * prints `--fill` lines first, enough to fill the page's 6000 rows of
 * scrollback, then `--scroll` lines a second under the same spinner, each one
 * of them a line an agent prints -- a tool call, its result, a framed diff --
 * so the scrollback fills with the drawn box characters it fills with in use.
 *
 * `--split` writes each tick in two halves, 8 ms apart, as a program's redraw
 * arrives in more than one read; `--sync` wraps each in a synchronized update
 * (mode 2026), as Claude Code does, and then a tick should reach the page as
 * one frame rather than two.
 */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const HZ = opt("--hz", 10) || 10;
const SCROLL = opt("--scroll", 20) || 0;
const FILL = opt("--fill", 6500) ?? (SCROLL ? 6500 : 0);
const SPLIT = args.includes("--split"), SYNC = args.includes("--sync");

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

/** The lines that go by in `--scroll`, in turn: a tool call, what it said,
 *  and a framed diff with a rule and a bar under it. */
const LOG = [
  i => `${fg(114)}⏺${R} ${B}Bash${R}(cargo test screen::tests::case_${i})`,
  i => `  ⎿  ${fg(244)}running 1 test ... ok (${i % 97} ms)${R}`,
  () => `${fg(240)}╭${"─".repeat(62)}╮${R}`,
  i => `${fg(240)}│${R} ${pad(`${i} + let w = row.iter().map(|c| c.width()).sum::<usize>();`, 60)} ${fg(240)}│${R}`,
  i => `${fg(240)}│${R} ${fg(203)}${pad(`${i} - let w = row.len();`, 60)}${R} ${fg(240)}│${R}`,
  () => `${fg(240)}╰${"─".repeat(62)}╯${R}`,
  i => `${fg(238)}${"─".repeat(40)}${R} ${fg(114)}${"█".repeat(i % 12)}${R}${fg(238)}${"░".repeat(12 - i % 12)}${R} ${PLT}`,
];
let logNo = 0, owed = 0;
const logLines = n => { let s = ""; for (let k = 0; k < n; k++) { s += LOG[logNo % LOG.length](logNo) + "\r\n"; logNo++; } return s; };

/** The spinner as the last row, the output scrolling up past it: the line is
 *  cleared, what went by is printed in its place, and the spinner goes under. */
function scrollTick(fill) {
  frameNo++;
  let due = fill;
  if (due == null) { owed += SCROLL / HZ; due = Math.floor(owed); owed -= due; }
  const secs = Math.floor(frameNo / HZ), tokens = (1.2 + frameNo * 0.013).toFixed(1);
  return `\r${E}2K` + logLines(due) +
    `${fg(208)}${SPIN[frameNo % SPIN.length]}${R} ${fg(208)}Painting…${R} ${fg(244)}(${secs}s · ↑ ${tokens}k tokens · esc to interrupt)${R}`;
}

if (SCROLL) {
  // The fill goes out 200 lines a tick, not at once: the daemon sends a
  // watching page at most 400 lines a frame and counts the rest as a gap, and
  // a page shown "6100 lines went by" has no scrollback to measure.
  let fill = FILL;
  process.stdout.write(`${E}?25l${E}2J${E}H`);
  setInterval(() => {
    const n = fill > 0 ? Math.min(fill, 200) : undefined;
    if (n) fill -= n;
    process.stdout.write(scrollTick(n));
  }, 1000 / HZ);
} else {
  process.stdout.on("resize", draw);
  draw();
  setInterval(() => put(tick(false)), 1000 / HZ);
}

/** A tick, whole or in two writes: see `--split` and `--sync` above. */
function put(s) {
  if (!SPLIT) return process.stdout.write(s);
  const i = Math.max(1, s.indexOf("Painting"));
  process.stdout.write((SYNC ? `${E}?2026h` : "") + s.slice(0, i));
  setTimeout(() => process.stdout.write(s.slice(i) + (SYNC ? `${E}?2026l` : "")), 8);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { process.stdout.write(`${R}${E}?25h\n`); process.exit(0); });
