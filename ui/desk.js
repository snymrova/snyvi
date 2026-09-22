/* The desk view: a folder, up to four panes in a fixed two-column grid, and
 * the rail that names them.
 *
 * Not on the wire until a desk is opened -- the same bargain as ui/mmd.js --
 * and nothing in it runs in a tab: app.js only imports this once the page
 * holds a capability. Everything it needs from the page comes in `open`'s one
 * argument, so the seam is three calls wide: `open`, `update` when the list of
 * desks moves, and `close` on the way out.
 *
 * A pane is painted, not emulated. The daemon owns the terminal -- the PTY,
 * the parser, the screen -- and sends frames: rows that changed, as runs of
 * text sharing an attribute. This keeps a copy of the grid exactly as the
 * frames describe it and paints rows into the DOM, which is why selection is
 * the browser's own and copy is `mouseup`. The protocol and its one hard rule
 * -- a resize is resize-and-clear on both sides -- are in docs/DESK.md.
 */

const WIDE = 256;
const LINE_PX = 16;            // a row's height, which the pane's CSS matches
const KEEP_LINES = 6000;       // scrollback rows kept in the page; the daemon keeps 2 MB
let ctx = null;                // what app.js handed `open`
let sock = null, sockP = null, retry = 0;
let deskId = null, focused = null, cellW = 7.5;
/** Zoomed: the focused pane alone, at the grid's full size, and the rest as
 *  tabs -- tmux's `prefix z`. A state of the view rather than of a pane, so
 *  focusing another pane while zoomed shows that one at full size, and the
 *  key that zoomed puts the grid back. */
let zoomed = false;
/** The documents this desk's panes have sent, for the rail, and which desk
 *  they belong to -- so a desk swapped for another never shows the last
 *  one's list while its own is on the way. */
let docList = [], docsAt = null;
/** The rail shows the latest few of those and names the rest; a click on
 *  the rest opens the whole list, for this desk, until it is left. */
const DOCS_SHOWN = 8;
let docsAll = false;
/** The reader's own list for this desk, and which desk it belongs to. Not
 *  `crate::note`'s kind: those are an agent's sentences and the daemon forgets
 *  them. These are written here, ticked here, and kept in the database. */
let noteList = [], notesAt = null, notesGet = null;
/** The field that is open on the list, while one is: a new line at the end, or
 *  a line being rewritten in place. Held here rather than in the DOM because
 *  the rail is redrawn whole -- by a pane's status, by the clock every 30s --
 *  and a field that lived only in the page would be swept away mid-word. */
let noteField = null, noteDraft = "", noteCaret = 0;
/** True only while the rail's HTML is being replaced. An element losing the
 *  focus that way is not a reader clicking away from it, and must not be read
 *  as one: without this, every redraw committed whatever was half-typed. */
let drawing = false;
/** How long the offer to put a line back stands, matching the page's own undo. */
const BACK_MS = 8000;
let backTimer = 0;
const views = new Map();       // pane id -> its view
let clock = 0;

// ---------- the page's side of the socket ----------

async function socket() {
  if (sock && sock.readyState === 1) return sock;
  sockP ||= ctx.socket().then(s => {
    sockP = null;
    sock = s;
    if (!s) return null;
    s.onmessage = ev => { let f; try { f = JSON.parse(ev.data); } catch { return; } receive(f); };
    s.onclose = () => {
      if (sock !== s) return;
      sock = null;
      // A new socket is watching nothing: every pane is asked for again. And
      // a daemon that restarted has dropped the processes, so each pane is a
      // candidate to start itself once more.
      for (const v of views.values()) { v.asked = false; v.resumed = false; }
      // The daemon went, or restarted. Try again while a desk is on screen.
      clearTimeout(retry);
      if (deskId != null) retry = setTimeout(() => watch(), 1000);
    };
    return s;
  });
  return sockP;
}
const say = m => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(m)); };

async function watch() {
  const s = await socket();
  if (!s) { refused(); return; }
  // The daemon sends a snapshot only for a pane this socket was not already
  // watching, and a view made since -- the desk drawn again after the list of
  // desks, another desk, a reconnect -- has nothing for a diff to land on.
  // Those are left out of one watch and put back in the next, so each gets
  // its snapshot; what it held before is dropped, since the snapshot brings
  // the scrollback again.
  const ids = [...views.keys()], fresh = ids.filter(id => !views.get(id).asked);
  if (fresh.length) {
    say({ t: "watch", panes: ids.filter(id => views.get(id).asked) });
    for (const id of fresh) { const v = views.get(id); v.asked = true; v.old.replaceChildren(); v.sb.replaceChildren(); }
  }
  say({ t: "watch", panes: ids });
}

function receive(f) {
  const v = views.get(f.p);
  if (!v) return;
  if (f.t === "frame") paint(v, f);
  else if (f.t === "status") { v.status = f.s; header(v); resume(v); if (v.id === focused) rail(); }
  else if (f.t === "old") {
    // What the last run left, greyed: the scrollback is now the old text, and
    // the new run starts with none of its own.
    v.old.innerHTML = f.lines.map(l => `<div>${ctx.esc(l) || " "}</div>`).join("");
    v.sb.replaceChildren();
  }
}

/** The capability did not open a socket: the daemon behind this window is
 *  not the one that minted it -- restarted, or upgraded -- and only a new
 *  window is given a new one. */
function refused() {
  ctx.docEl.querySelector(".dk-grid")?.replaceChildren(Object.assign(document.createElement("p"), {
    className: "dk-none",
    textContent: "This window's capability is from a daemon that has since restarted, so it cannot reach the panes. Close the window and open it again with `snyvi app`.",
  }));
}

// ---------- painting ----------

/** Apply one frame to the page's copy of the grid, then repaint the rows it
 *  touched. The same steps, in the same order, as the replica in
 *  src/screen.rs's tests -- which is what says this cannot drift. */
function paint(v, f) {
  // A diff for a grid this page does not hold yet: its snapshot is behind it.
  if (!f.sz && !v.rows) return;
  born = v.status.accent ? parseInt(v.status.accent.slice(1), 16) : -1;
  const pinned = v.body.scrollTop + v.body.clientHeight >= v.body.scrollHeight - 4;
  if (f.sz) {
    // Resize-and-clear, on this side as on the daemon's.
    v.cols = f.sz[0]; v.rows = f.sz[1];
    v.cells = Array.from({ length: v.rows }, () => blankRow(v.cols));
    v.scr.replaceChildren(...v.cells.map(() => document.createElement("div")));
    v.scr.style.height = v.rows * LINE_PX + "px";
  }
  // `clear` clears everything the reader could scroll to: the run before
  // this one, greyed above the scrollback, goes with it.
  if (f.sbclear) { v.sb.replaceChildren(); v.old.replaceChildren(); }
  if (f.gap) v.sb.insertAdjacentHTML("beforeend", `<div class="gap">⋯ ${f.gap.toLocaleString()} lines went by</div>`);
  if (f.sb && f.sb.length) {
    v.sb.insertAdjacentHTML("beforeend", f.sb.map(l => `<div>${runsHtml(l.r || l) || " "}</div>`).join(""));
    for (let n = v.sb.childElementCount - KEEP_LINES; n > 0; n--) v.sb.firstElementChild.remove();
  }
  if (f.r) {
    for (const [y, x0, runs] of f.r) {
      const row = v.cells[y];
      let x = x0;
      for (const [t, fg = 0, bg = 0, fl = 0] of runs) {
        const wide = fl & WIDE, a = fl & ~WIDE;
        for (const ch of t) {
          row[x++] = [ch, fg, bg, a, wide ? 2 : 1];
          if (wide) row[x++] = null;
        }
      }
      v.scr.children[y].innerHTML = rowHtml(row);
    }
  }
  if (f.c) v.cur = f.c;
  if (f.m) v.mode = f.m;
  cursor(v);
  if (pinned) v.body.scrollTop = v.body.scrollHeight;
}

const blankRow = n => Array.from({ length: n }, () => [" ", 0, 0, 0, 1]);

function cursor(v) {
  const [x, y, on] = v.cur;
  v.caret.hidden = !on || !v.status.running;
  v.caret.style.transform = `translate(${x * cellW}px, ${y * LINE_PX}px)`;
  v.caret.style.width = cellW * ((v.cells[y] && v.cells[y][x] && v.cells[y][x][4]) || 1) + "px";
}

/** A row of cells as HTML: runs that share an attribute become one span.
 *  A character the pane's font does not have is a span of its own, one cell
 *  wide or two, so that the advance of whatever font draws it cannot push the
 *  rest of the row off the grid. */
function rowHtml(row) {
  let out = "", text = "", key = null, at = null;
  const flush = () => { if (text) out += span(at, text, false); text = ""; };
  for (const c of row) {
    if (!c) continue;
    if (c[4] === 2 || c[0] >= "\u2000") { flush(); key = null; out += span(c, c[0], true); continue; }
    const k = `${c[1]},${c[2]},${c[3]}`;
    if (k !== key) { flush(); key = k; at = c; }
    text += c[0];
  }
  flush();
  return out;
}
const runsHtml = runs => {
  const row = [];
  for (const [t, fg = 0, bg = 0, fl = 0] of runs) for (const ch of t) row.push([ch, fg, bg, fl & ~WIDE, fl & WIDE ? 2 : 1]);
  return rowHtml(row);
};

function span(c, text, own) {
  const [, fg, bg, fl, w] = c;
  const t = ctx.esc(text);
  let cls = (fl & 1 ? " b" : "") + (fl & 2 ? " d" : "") + (fl & 4 ? " i" : "") + (fl & 8 ? " u" : "") + (fl & 128 ? " s" : "") + (fl & 64 ? " h" : "");
  if (own) cls += (w === 2 ? " x w" : " x") + (DRAWN[text] ? ` g g${text.charCodeAt(0).toString(16)}` : /[\ue000-\uf8ff]/.test(text) ? " nf" : "");
  if (!fg && !bg && !cls) return t;
  let f = color(fg), b = color(bg);
  if (fl & 32) { [f, b] = [b || "var(--pn-bg)", f || "var(--pn-fg)"]; }
  const style = (f ? `color:${f};` : "") + (b ? `background:${b};` : "");
  return `<span${cls ? ` class="${cls.slice(1)}"` : ""}${style ? ` style="${style}"` : ""}>${t}</span>`;
}

// ---------- drawn characters ----------

/* Box drawing, blocks and powerline separators are drawn, not set in a font:
 * a font draws them inside its own em box, and a row is taller than that, so
 * a frame's sides come apart into dashes and a prompt's segments end in a
 * notch. Drawn to the cell, they meet the next row and the next cell exactly.
 * Each is a mask the cell's colour shows through, made once the cell has been
 * measured. Light and heavy lines: which of left, right, up, down, and how
 * thick. */
const LINES = {
  "─": "1100", "━": "2200", "│": "0011", "┃": "0022", "┌": "0101", "┏": "0202", "┐": "1001", "┓": "2002",
  "└": "0110", "┗": "0220", "┘": "1010", "┛": "2020", "├": "0111", "┣": "0222", "┤": "1011", "┫": "2022",
  "┬": "1101", "┳": "2202", "┴": "1110", "┻": "2220", "┼": "1111", "╋": "2222",
  "╴": "1000", "╵": "0010", "╶": "0100", "╷": "0001", "╸": "2000", "╹": "0020", "╺": "0200", "╻": "0002",
};
// Blocks, as rectangles on a unit cell: [x, y, w, h, opacity].
const Q = { a: [0, 0, .5, .5], b: [.5, 0, .5, .5], c: [0, .5, .5, .5], d: [.5, .5, .5, .5] };
const BLOCKS = {
  "▀": [[0, 0, 1, .5]], "█": [[0, 0, 1, 1]], "▐": [[.5, 0, .5, 1]], "▔": [[0, 0, 1, .125]], "▕": [[.875, 0, .125, 1]],
  "░": [[0, 0, 1, 1, .25]], "▒": [[0, 0, 1, 1, .5]], "▓": [[0, 0, 1, 1, .75]],
  "▖": "c", "▗": "d", "▘": "a", "▙": "acd", "▚": "ad", "▛": "abc", "▜": "abd", "▝": "b", "▞": "bc", "▟": "bcd",
};
for (let n = 1; n < 8; n++) {
  BLOCKS[String.fromCharCode(0x2580 + n)] = [[0, 1 - n / 8, 1, n / 8]];   // ▁ to ▇
  BLOCKS[String.fromCharCode(0x2590 - n)] = [[0, 0, n / 8, 1]];           // ▏ to ▉
}
const DRAWN = {};

function drawn(W, H) {
  const t = Math.max(1, Math.round(W / 7)), cx = W / 2, cy = H / 2;
  const svg = (body, box = `${W} ${H}`) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box}" preserveAspectRatio="none">${body}</svg>`;
  const rect = (x, y, w, h, o = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${o < 1 ? ` fill-opacity="${o}"` : ""}/>`;
  const line = d => `<path d="${d}" fill="none" stroke="#000" stroke-width="${t}"/>`;
  const fill = d => `<path d="${d}"/>`;
  for (const [ch, w] of Object.entries(LINES)) {
    const [l, r, u, d] = [...w].map(Number), m = Math.max(l, r, u, d) * t / 2;
    DRAWN[ch] = svg((l ? rect(0, cy - l * t / 2, cx + m, l * t) : "") + (r ? rect(cx - m, cy - r * t / 2, W - cx + m, r * t) : "") +
      (u ? rect(cx - u * t / 2, 0, u * t, cy + m) : "") + (d ? rect(cx - d * t / 2, cy - m, d * t, H - cy + m) : ""));
  }
  const r = cx;
  DRAWN["╭"] = svg(line(`M${W} ${cy}H${cx + r}A${r} ${r} 0 0 0 ${cx} ${cy + r}V${H}`));
  DRAWN["╮"] = svg(line(`M0 ${cy}H${cx - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}V${H}`));
  DRAWN["╯"] = svg(line(`M0 ${cy}H${cx - r}A${r} ${r} 0 0 0 ${cx} ${cy - r}V0`));
  DRAWN["╰"] = svg(line(`M${W} ${cy}H${cx + r}A${r} ${r} 0 0 1 ${cx} ${cy - r}V0`));
  for (const [ch, b] of Object.entries(BLOCKS)) DRAWN[ch] = svg((typeof b === "string" ? [...b].map(q => Q[q]) : b).map(a => rect(...a)).join(""), "1 1");
  // Powerline: the separators a prompt's segments are joined with.
  const P = String.fromCharCode;
  Object.assign(DRAWN, {
    [P(0xe0b0)]: svg(fill(`M0 0L${W} ${cy}L0 ${H}Z`)), [P(0xe0b2)]: svg(fill(`M${W} 0L0 ${cy}L${W} ${H}Z`)),
    [P(0xe0b1)]: svg(line(`M0 0L${W} ${cy}L0 ${H}`)), [P(0xe0b3)]: svg(line(`M${W} 0L0 ${cy}L${W} ${H}`)),
    [P(0xe0b4)]: svg(fill(`M0 0A${W} ${cy} 0 0 1 0 ${H}Z`)), [P(0xe0b6)]: svg(fill(`M${W} 0A${W} ${cy} 0 0 0 ${W} ${H}Z`)),
    [P(0xe0b5)]: svg(line(`M0 0A${W} ${cy} 0 0 1 0 ${H}`)), [P(0xe0b7)]: svg(line(`M${W} 0A${W} ${cy} 0 0 0 ${W} ${H}`)),
    [P(0xe0b8)]: svg(fill(`M0 0L${W} ${H}H0Z`)), [P(0xe0ba)]: svg(fill(`M${W} 0V${H}H0Z`)),
    [P(0xe0bc)]: svg(fill(`M0 0H${W}L0 ${H}Z`)), [P(0xe0be)]: svg(fill(`M0 0H${W}V${H}Z`)),
    [P(0xe0b9)]: svg(line(`M0 0L${W} ${H}`)), [P(0xe0bf)]: svg(line(`M0 0L${W} ${H}`)),
    [P(0xe0bb)]: svg(line(`M${W} 0L0 ${H}`)), [P(0xe0bd)]: svg(line(`M${W} 0L0 ${H}`)),
  });
  return Object.entries(DRAWN).map(([ch, s]) => `.pn-body .g${ch.charCodeAt(0).toString(16)}{--g:url("data:image/svg+xml,${encodeURIComponent(s)}")}`).join("\n") +
    `\n.pn-body .x { width: ${W}px; text-align: center; } .pn-body .x.w { width: ${2 * W}px; }`;
}

/* The colour the pane being painted had its prompt dressed in. snyvi wrote
 * that colour into the shell's rc when the pane started, so the escape the
 * prompt sends carries it exactly; painting it as the accent rather than as
 * the colour it literally is means a new swatch re-tints every prompt already
 * on the screen, and the scrollback above them, without asking a shell to
 * draw anything again. Anything else that sends that exact colour re-tints
 * too, which is a fair trade for a prompt that follows the window. */
let born = -1;

/** A colour on the wire: 0 the default, 1..256 a palette index plus one,
 *  bit 24 set for truecolor. The first sixteen are the theme's own. */
function color(n) {
  if (!n) return "";
  if (n >= 1 << 24) {
    const c = n & 0xffffff;
    return c === born ? "var(--accent)" : "#" + c.toString(16).padStart(6, "0");
  }
  const i = n - 1;
  if (i < 16) return `var(--t${i})`;
  if (i < 232) {
    const l = [0, 95, 135, 175, 215, 255], j = i - 16;
    return `rgb(${l[Math.floor(j / 36)]},${l[Math.floor(j / 6) % 6]},${l[j % 6]})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// ---------- keys ----------

const CUR = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const SS3 = { F1: "P", F2: "Q", F3: "R", F4: "S" };
const CTRL = { " ": 0, "@": 0, "2": 0, "[": 27, "3": 27, "\\": 28, "4": 28, "]": 29, "5": 29, "^": 30, "6": 30, "_": 31, "7": 31, "-": 31, "/": 31, "?": 127, "8": 127 };

/** What a key sends to a program, as xterm sends it. `null` for a key this
 *  leaves to the page: the platform's own shortcuts, and the two snyvi keeps. */
export function keyBytes(e, appCursor) {
  const m = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  let k = e.key;
  if (CUR[k]) return m > 1 ? `\x1b[1;${m}${CUR[k]}` : `\x1b${appCursor ? "O" : "["}${CUR[k]}`;
  if (TILDE[k]) return `\x1b[${TILDE[k]}${m > 1 ? ";" + m : ""}~`;
  if (SS3[k]) return m > 1 ? `\x1b[1;${m}${SS3[k]}` : `\x1bO${SS3[k]}`;
  // Alt on a Mac composes a character (⌥d is ∂); a terminal wants the key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) k = e.shiftKey ? e.code[3] : e.code[3].toLowerCase();
  const alt = e.altKey ? "\x1b" : "";
  if (k === "Enter") return alt + "\r";
  if (k === "Backspace") return alt + (e.ctrlKey ? "\x08" : "\x7f");
  if (k === "Tab") return e.shiftKey ? "\x1b[Z" : alt + "\t";
  if (k === "Escape") return "\x1b";
  if ([...k].length !== 1) return null;
  if (e.ctrlKey) {
    const c = k.toLowerCase();
    if (c >= "a" && c <= "z") return alt + String.fromCharCode(c.charCodeAt(0) - 96);
    return CTRL[k] != null ? alt + String.fromCharCode(CTRL[k]) : null;
  }
  return alt + k;
}

/** Keys and pastes from the reader, and nothing else: this is the only place
 *  bytes for a pane are made, and every caller is a key or a paste event. */
function input(v, text) {
  if (!v.status.running || !text) return;
  say({ t: "in", p: v.id, d: text });
  v.body.scrollTop = v.body.scrollHeight;
}
const bracket = (v, t) => (v.mode && v.mode[1] ? `\x1b[200~${t}\x1b[201~` : t);

/** Where a turn of the wheel goes. A program that asked for the mouse gets it
 *  as a wheel report -- the only mouse report a pane sends, since clicks are
 *  the browser's, for selection -- which is how Claude Code scrolls its own
 *  transcript from the alternate screen. One on the alternate screen that did
 *  not ask gets arrow keys, as xterm's alternateScroll has always sent them.
 *  Otherwise, and with Shift held, the wheel is the page's: it scrolls the
 *  scrollback. A notch is three lines, as on every desktop. */
function wheel(v, e) {
  const [, , mouse, alt] = v.mode;
  if (e.shiftKey || !(mouse || alt) || !v.status.running || !v.rows) return;
  e.preventDefault();
  const px = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * v.rows * LINE_PX : e.deltaY;
  // A turn the other way starts over rather than working off the remainder.
  v.wheelAcc = (v.wheelAcc < 0) === (px < 0) ? v.wheelAcc + px : px;
  const n = Math.trunc(v.wheelAcc / (3 * LINE_PX));
  if (!n) return;
  v.wheelAcc -= n * 3 * LINE_PX;
  const down = n > 0, k = Math.min(Math.abs(n), 5);
  let one;
  if (mouse) {
    const r = v.scr.getBoundingClientRect();
    const x = Math.max(0, Math.min(v.cols - 1, Math.floor((e.clientX - r.left) / cellW)));
    const y = Math.max(0, Math.min(v.rows - 1, Math.floor((e.clientY - r.top) / LINE_PX)));
    const b = 64 + (down ? 1 : 0);
    // X10 reports carry a cell as one byte past 32, so they end at column 223.
    one = mouse === 2 ? `\x1b[<${b};${x + 1};${y + 1}M` : x < 223 && y < 223 ? `\x1b[M${String.fromCharCode(32 + b, 33 + x, 33 + y)}` : "";
  } else {
    one = (v.mode[0] ? "\x1bO" : "\x1b[") + (down ? "B" : "A");
  }
  if (one) input(v, one.repeat(k));
}

// ---------- a pane ----------

function makeView(p) {
  const el = document.createElement("section");
  el.className = "pn";
  el.dataset.id = p.id;
  el.innerHTML = `<header class="pn-head"><span class="pn-slot"></span><span class="pn-cmd"></span><span class="pn-git"></span><span class="pn-state"></span></header>` +
    `<div class="pn-body" tabindex="0" role="region" aria-label="Terminal"><div class="pn-old"></div><div class="pn-sb"></div><div class="pn-live"><div class="pn-scr"></div><i class="pn-caret" hidden></i></div></div>` +
    `<form class="pn-start" hidden><button type="submit">▶ Start</button><input spellcheck="false" autocomplete="off" aria-label="Command to run"></form>`;
  const v = {
    id: p.id, pane: p, el, status: p.status || {}, cols: 0, rows: 0, cells: [], cur: [0, 0, 0], mode: [0, 0, 0, 0], wheelAcc: 0, asked: false,
    // A pane with no process and no exit code lost its shell to a daemon that
    // went away: it will start itself, so it does not flash the Start bar on
    // the way there. `resumed` is one attempt, per daemon.
    resumed: false, starting: false, resuming: !(p.status && (p.status.running || p.status.exit != null)),
    body: el.querySelector(".pn-body"), old: el.querySelector(".pn-old"), sb: el.querySelector(".pn-sb"), scr: el.querySelector(".pn-scr"),
    caret: el.querySelector(".pn-caret"), start: el.querySelector(".pn-start"), size: "",
  };
  const { body, start } = v;

  body.addEventListener("focus", () => { focused = v.id; el.classList.add("on"); rail(); });
  body.addEventListener("blur", () => el.classList.remove("on"));
  el.querySelector(".pn-head").addEventListener("click", () => body.focus());
  body.addEventListener("keydown", e => {
    // The platform's (⌘C, ⌘V, ⌘K), and snyvi's own: the swap, the pane keys
    // and the zoom.
    if (e.metaKey || (e.ctrlKey && e.key === "`") || (e.ctrlKey && e.altKey && /^(Digit[1-4]|KeyZ)$/.test(e.code))) return;
    // Ctrl+Shift+C and V are copy and paste in a Linux terminal; V lets the
    // browser's own paste event through.
    if (e.ctrlKey && e.shiftKey && /^[cv]$/i.test(e.key)) { if (/c/i.test(e.key)) copy(v, true); return; }
    if (e.isComposing || e.key === "Dead" || e.key === "Process") return;
    const b = keyBytes(e, v.mode[0]);
    if (b == null) return;
    e.preventDefault(); e.stopPropagation();
    input(v, b);
  });
  // Copy on selection: the scrollback is text in the page, so the browser
  // selects it, and letting go is the copy.
  body.addEventListener("mouseup", () => setTimeout(() => copy(v, false), 0));
  body.addEventListener("wheel", e => wheel(v, e), { passive: false });
  body.addEventListener("paste", e => { e.preventDefault(); paste(v, e.clipboardData); });
  start.addEventListener("submit", e => { e.preventDefault(); run(v, start.querySelector("input").value); });
  start.querySelector("input").addEventListener("keydown", e => e.stopPropagation());
  new ResizeObserver(() => fit(v)).observe(body);
  header(v);
  return v;
}

function copy(v, always) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !v.body.contains(sel.anchorNode)) { if (always) ctx.toast("Nothing selected"); return; }
  // A row is drawn to its full width, so a line's trailing blanks are the
  // grid's, not the program's.
  const text = sel.toString().split("\n").map(l => l.trimEnd()).join("\n").replace(/\n+$/, "");
  if (!text) return;
  navigator.clipboard?.writeText(text);
  ctx.toast("Copied", text.length > 60 ? text.slice(0, 57) + "…" : text);
}

/** A paste. Text is typed as the reader's, bracketed if the program asked for
 *  that. An image cannot go down a PTY, so it goes to the daemon as a document
 *  and its path is what is typed. */
async function paste(v, data) {
  if (!data || !v.status.running) return;
  const img = [...data.items].find(i => i.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(i.type));
  if (img) {
    const blob = img.getAsFile();
    try {
      const j = await ctx.api(`/api/panes/${v.id}/paste`, blob, blob.type);
      input(v, bracket(v, j.path));
      ctx.toast("Pasted as a document", j.path);
    } catch (e) { ctx.toast("Could not paste the image", String(e)); }
    return;
  }
  const t = data.getData("text/plain");
  if (t) input(v, bracket(v, t.replace(/\r?\n/g, "\r")));
}

/** How many columns and rows the pane has room for, told to the daemon when
 *  it changes. The daemon resizes and clears, and the frame that follows
 *  carries `sz`, which is when this page clears its own. */
function fit(v) {
  const w = v.body.clientWidth - 12, h = v.body.clientHeight - 8;
  if (w <= 0 || h <= 0) return;
  const c = Math.max(2, Math.floor(w / cellW)), r = Math.max(1, Math.floor(h / LINE_PX));
  const size = `${c}x${r}`;
  if (size === v.size) return;
  v.size = size;
  clearTimeout(v.fitT);
  v.fitT = setTimeout(() => say({ t: "size", p: v.id, c, r }), 60);
  // The first size is also the moment the pane is really on screen, which is
  // when a pane that lost its shell asks for it back -- at the size it is
  // drawn at, and not for panes sitting behind a tab.
  resume(v);
}

/** The shell, back, without being asked twice.
 *
 *  A pane is runtime, and a daemon that wakes up finds every one of them
 *  stopped. That is not the reader's doing and there is nothing to tell them
 *  about it: the pane starts what it ran before, and the old screen stays
 *  above it, greyed, as scrollback. A process that ended on its own, or that
 *  the reader stopped, has an exit code -- that one keeps the Start bar,
 *  because what to do next is a question only the reader can answer. */
function resume(v) {
  if (v.resumed || v.starting || !v.size) return;
  if (v.status.running || v.status.exit != null) {
    if (v.resuming) { v.resuming = false; header(v); }
    return;
  }
  run(v, v.status.cmd || v.pane.cmd || "", true);
}

/** The accent this window wears, as CSS resolved it, for the prompt the shell
 *  is dressed in. The shell bakes it in at birth and cannot be told again --
 *  the page re-tints instead, in `color`, so a swatch reaches a pane that is
 *  already running. */
function accent() {
  const c = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c : "";
}

async function run(v, cmd, quiet) {
  if (v.starting) return;
  v.starting = true;
  v.resumed = true;
  const [c, r] = v.size ? v.size.split("x").map(Number) : [80, 24];
  try {
    const j = await ctx.api(`/api/panes/${v.id}/start`, { cmd, cols: c, rows: r, accent: accent() });
    v.status = j.status;
    if (!quiet) v.body.focus();
  } catch (e) {
    // Two windows on one desk both resume it, and the one that loses is told
    // "already running" -- which is the outcome it wanted. Anything else is
    // worth saying, even for a start nobody asked for: the folder may be gone.
    if (!quiet || !/already running/i.test(String(e))) ctx.toast("Could not start", String(e));
  } finally {
    v.starting = false;
    v.resuming = false;
    header(v);
  }
}

const tilde = p => {
  const home = ctx.desks && ctx.desks.home;
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
};
const what = v => v.status.title || v.status.cmd || v.pane.cmd || "shell";

function header(v) {
  const s = v.status, $ = q => v.el.querySelector(q);
  $(".pn-slot").textContent = `[${v.pane.slot}]`;
  $(".pn-cmd").textContent = what(v);
  // The branch and whether the tree is modified: snyvi's own answer, not the
  // prompt's, so a pane whose shell it cannot dress says both too.
  $(".pn-git").textContent = s.branch ? s.branch + (s.dirty ? "*" : "") : "";
  $(".pn-state").textContent = s.blocked ? "! waiting on you" : s.running ? "● running" : s.exit != null ? `exited ${s.exit}` : "○ stopped";
  v.el.classList.toggle("blk", !!s.blocked);
  v.el.classList.toggle("off", !s.running);
  // Ended: the last screen stays, greyed by .off, and Start sits over it with
  // what was run last already typed. A pane on its way back from a daemon
  // restart is not ended, and shows nothing.
  const wasHidden = v.start.hidden;
  v.start.hidden = !!s.running || v.resuming || v.starting;
  if (!v.start.hidden && wasHidden) v.start.querySelector("input").value = s.cmd || v.pane.cmd || "";
  v.start.querySelector("input").placeholder = "blank for the shell";
  cursor(v);
}

// ---------- the desk ----------

function current() {
  return ctx.desks && ctx.desks.desks.find(d => d.id === deskId);
}

/** How many panes the width has room for: four above 1100px, two above
 *  700px, one below. Four panes at phone width are four unreadable panes. */
const room = () => (innerWidth > 1100 ? 4 : innerWidth > 700 ? 2 : 1);

/** Why there is no new pane, when there is not: the nearer of the two caps,
 *  or the width, is the one worth naming. Empty while one can be made. Both
 *  places that offer a pane -- the + in the head and the row in the rail --
 *  ask this, so they never disagree. */
function noNew(d) {
  const j = ctx.desks;
  return j.panes >= j.cap ? `Every pane is in use: ${j.panes} of ${j.cap} everywhere`
    : d.panes.length >= j.per_desk ? `A desk holds ${j.per_desk}`
    : d.panes.length >= room() ? "No room for another at this width" : "";
}

function layout() {
  const d = current(), grid = ctx.docEl.querySelector(".dk-grid");
  if (!d || !grid) return;
  const all = d.panes.map(p => views.get(p.id)).filter(Boolean);
  // The focused pane is always shown; the rest in slot order, while there is room.
  const n = zoomed ? 1 : room(), f = all.find(v => v.id === focused);
  const shown = all.length <= n ? all : [f, ...all.filter(v => v !== f)].filter(Boolean).slice(0, n).sort((a, b) => a.pane.slot - b.pane.slot);
  if (zoomed && all.length > 1) grid.dataset.zoom = "1"; else delete grid.dataset.zoom;
  const cols = shown.length > 1 ? 2 : 1, rows = shown.length > 2 ? 2 : 1;
  grid.style.gridTemplateColumns = cols === 2 ? `${d.col}fr ${1 - d.col}fr` : "1fr";
  grid.style.gridTemplateRows = rows === 2 ? `${d.row}fr ${1 - d.row}fr` : "1fr";
  grid.style.setProperty("--col", d.col);
  grid.style.setProperty("--row", d.row);
  grid.dataset.cols = cols; grid.dataset.rows = rows;
  // Slots, not splits: an odd pane out spans the row rather than leave a hole.
  shown.forEach((v, i) => { v.el.style.gridColumn = shown.length % 2 && i === shown.length - 1 && cols === 2 ? "1 / -1" : ""; });
  // Moving an element blurs it, and this runs on every resize of the window:
  // the panes are put back only when the set changes, and the reader's focus
  // with them, or their next key would land on the reading view.
  const keep = [...grid.querySelectorAll(":scope > .dk-div")], want = [...shown.map(v => v.el), ...keep];
  if (want.length !== grid.children.length || want.some((el, i) => grid.children[i] !== el)) {
    const had = grid.contains(document.activeElement) ? document.activeElement : null;
    grid.replaceChildren(...want);
    if (had && had.isConnected) had.focus({ preventScroll: true });
  }
  if (!all.length) grid.innerHTML = `<p class="dk-none">No panes on this desk. <button type="button" data-a="new">New pane</button></p>`;
  tabs(d, all, shown);
}

function tabs(d, all, shown) {
  const t = ctx.docEl.querySelector(".dk-tabs");
  if (!t) return;
  t.innerHTML = all.length > shown.length ? all.map(v => `<button type="button" data-focus="${v.id}" class="${shown.includes(v) ? "on" : ""}">[${v.pane.slot}]</button>`).join("") : "";
  t.title = zoomed && all.length > 1 ? "Zoomed  ⌃⌥Z" : "";
  // The + goes quiet when there is no pane to add, and says why under the
  // cursor. At the desk's own cap the count sits beside it -- 4/4 -- which
  // is what ties the greyed + to the panes on the desk.
  const plus = ctx.docEl.querySelector(".dk-head .icon[data-a=\"new\"]"), why = noNew(d), j = ctx.desks;
  if (plus) {
    plus.disabled = !!why;
    plus.title = why ? `New pane · ${why}` : "New pane";
    let n = plus.previousElementSibling?.classList.contains("dk-cap") ? plus.previousElementSibling : null;
    const full = d.panes.length >= j.per_desk;
    if (full && !n) { n = document.createElement("span"); n.className = "dk-cap"; plus.before(n); }
    if (n) { if (full) { n.textContent = `${d.panes.length}/${j.per_desk}`; n.title = why; } else n.remove(); }
  }
}

function draw() {
  const d = current();
  const { docEl } = ctx;
  if (!d) {
    docEl.innerHTML = deskId == null ? list() : `<div class="inbox-head"><h1>No such desk</h1><p>It was closed, here or in another window.</p></div>` + list();
    ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = "";
    ctx.rail.classList.add("empty");
    document.title = "Desks · snyvi";
    return;
  }
  document.title = `${d.name} · desk`;
  docEl.innerHTML = `<div class="dk"><header class="dk-head" data-tauri-drag-region="deep"><b class="dk-name"></b><span class="dk-root"></span><span class="dk-tabs"></span>` +
    `<button type="button" class="icon" data-a="new" title="New pane" aria-label="New pane">${head("plus")}</button></header>` +
    `<div class="dk-grid"><div class="dk-div dk-v" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize"></div><div class="dk-div dk-h" role="separator" aria-orientation="horizontal" tabindex="0" title="Drag to resize"></div></div></div>`;
  docEl.querySelector(".dk-name").textContent = d.name;
  docEl.querySelector(".dk-root").textContent = tilde(d.root);
  sync(d);
  dividers();
  rail();
}

/** Views for the desk's panes: the ones already here kept, scrollback and
 *  all, new ones made, gone ones dropped. Then the socket is told. */
function sync(d) {
  const ids = new Set(d.panes.map(p => p.id));
  for (const id of [...views.keys()]) if (!ids.has(id)) views.delete(id);
  for (const p of d.panes) {
    const v = views.get(p.id);
    if (v) { v.pane = p; if (p.status) v.status = { ...v.status, ...p.status }; header(v); }
    else views.set(p.id, makeView(p));
  }
  if (!views.has(focused)) focused = d.panes[0] ? d.panes[0].id : null;
  layout();
  watch();
}

function list() {
  const ds = ctx.desks ? ctx.desks.desks : [];
  return `<div class="inbox-head"><h1>Desks</h1><p>A desk is up to four terminal panes side by side. A new one starts in your home folder; to start one in a folder, right-click the folder under Folders, or press the + beside it.</p><p><button type="button" class="dk-make" data-a="make">+ New desk</button></p></div>` +
    (ds.length ? `<ul class="inbox">${ds.map(d => `<li><a href="/desk/${d.id}" data-desk="${d.id}"><span class="title">${ctx.esc(d.name)}</span><span class="time">${ctx.plural(d.panes.length, "pane")}</span><span class="sub">${ctx.esc(tilde(d.root))}</span></a></li>`).join("")}</ul>` : "");
}

// ---------- the dividers ----------

function dividers() {
  const grid = ctx.docEl.querySelector(".dk-grid");
  for (const div of grid.querySelectorAll(".dk-div")) {
    const vert = div.classList.contains("dk-v");
    const set = f => {
      const d = current();
      if (!d) return;
      f = Math.max(0.15, Math.min(0.85, f));
      if (vert) d.col = f; else d.row = f;
      layout();
    };
    const save = () => { const d = current(); if (d) ctx.api(`/api/desks/${d.id}/layout`, { col: d.col, row: d.row }).catch(() => {}); };
    div.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      div.setPointerCapture(e.pointerId);
      ctx.root.dataset.resizing = "1";
      const r = grid.getBoundingClientRect();
      const move = ev => set(vert ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
      const up = () => { delete ctx.root.dataset.resizing; div.removeEventListener("pointermove", move); div.removeEventListener("pointerup", up); save(); };
      div.addEventListener("pointermove", move);
      div.addEventListener("pointerup", up);
      e.preventDefault();
    });
    div.addEventListener("dblclick", () => { set(0.5); save(); });
    div.addEventListener("keydown", e => {
      const d = current(), step = e.shiftKey ? 0.1 : 0.03, at = vert ? d.col : d.row;
      const k = vert ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step };
      if (k[e.key] == null) return;
      set(at + k[e.key]); save();
      e.preventDefault(); e.stopPropagation();
    });
  }
}

// ---------- the rail ----------

const ago = s => { const d = Math.max(0, Date.now() / 1000 - s); return d < 60 ? `${Math.round(d)}s` : d < 3600 ? `${Math.round(d / 60)}m` : `${Math.floor(d / 3600)}h ${Math.round((d % 3600) / 60)}m`; };

/** A pane as a row names it: the shell's title less the `user@host:` a
 *  prompt puts before the folder. Every row on a desk carries the same
 *  prefix, and it is the folder after it that tells them apart. */
const short = v => { const t = what(v), m = /^[\w.-]+@[\w.-]+:(.+)$/.exec(t); return m ? tilde(m[1]) : t; };

/** The rail's small controls, drawn as lines the way the sidebar's icons
 *  are: stop and start on a pane, close on a pane or the desk, a pen on the
 *  desk's name. */
const ICO = {
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  doc: '<path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z"/><path d="M9.5 1.5v3h3M6 8h4M6 10.5h4"/>',
  pen: '<path d="M11.2 2.8a1.5 1.5 0 0 1 2 2L6 12l-3 1 1-3z"/>',
  back: '<path d="M6.5 3L3 8l3.5 5M3 8h10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5"/>',
  tick: '<path d="M3.5 8.5l3 3 6-7"/>',
};
const ico = k => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;
/** The head's plus: drawn on the grid the page's own icon buttons use
 *  (#btn-side, #btn-rail), so it sits on the same centre as a pane's
 *  outline and not on a text baseline. */
const HEAD = {
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
};
const head = k => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HEAD[k]}</svg>`;
/** A control that does something there is no undoing asks twice. Its text
 *  is `data-sure` while armed, and the title says why. */
const sure = (a, p, title, label, glyph) => `<button type="button" data-a="${a}"${p ? ` data-p="${p}"` : ""} data-sure="Close?" title="${title}" aria-label="${label}">${glyph}</button>`;

/** Whether the reader folded one of the rail's sections, remembered as the
 *  sidebar remembers its own folds -- and per section, so folding the list
 *  away does not take the documents with it. `docs` keeps the key it had. */
const FOLD = sec => `snyvi.dk.fold-${sec}`;
const secFolded = sec => { try { return localStorage.getItem(FOLD(sec)) === "1"; } catch { return false; } };
function folded(e) {
  const d = e.target;
  if (!d.classList || !d.classList.contains("dk-sec") || !d.dataset.sec) return;
  try { localStorage.setItem(FOLD(d.dataset.sec), d.open ? "0" : "1"); } catch {}
}

function rail() {
  const d = current();
  if (!d) return;
  const { esc } = ctx, j = ctx.desks;
  const dot = v => v.status.blocked ? "!" : v.status.running ? "●" : "○";
  const vs = d.panes.map(p => views.get(p.id)).filter(Boolean);
  const here = `${d.panes.length} of ${j.per_desk} on this desk`, total = `${j.panes} of ${j.cap} everywhere`;
  const why = noNew(d);
  const dl = docsAt === d.id ? docList : [];
  // The latest few, and always the one on the page: a document being read
  // is never the one the rail hides. The count names what is not shown.
  const shown = docsAll ? dl : dl.filter((x, i) => i < DOCS_SHOWN || x.id === reading);
  const rest = dl.length - shown.length;
  const stopped = vs.filter(x => !x.status.running).length;
  // A pane's row: the mark, the slot, the name -- and under the cursor, what
  // can be done to that pane: stopped or started, and closed. On the row
  // itself, so a control acts on the pane it sits beside and never on
  // whichever pane happens to have the focus.
  const paneRow = v => {
    const n = v.pane.slot, run = v.status.running;
    return `<li class="dk-pane${v.id === focused && reading == null ? " on" : ""}${v.status.blocked ? " blk" : run ? " run" : ""}">` +
      `<button type="button" class="dk-focus" data-focus="${v.id}" title="${esc(what(v))}"><span class="dot">${dot(v)}</span><span class="slot">${n}</span><span class="nm">${esc(short(v))}</span></button>` +
      `<span class="dk-tools">` +
      (run ? `<button type="button" data-a="stop" data-p="${v.id}" title="Stop" aria-label="Stop pane ${n}">${ico("stop")}</button>`
        : `<button type="button" data-a="start" data-p="${v.id}" title="Start" aria-label="Start pane ${n}">${ico("play")}</button>`) +
      sure("close", v.id, "Close pane", `Close pane ${n}`, ico("x")) +
      `</span></li>`;
  };
  // Replacing the rail takes the focus off whatever had it. A field open on
  // the list has to know that is what happened, and not a reader clicking
  // away, so the replacement says so while it is under way.
  drawing = true;
  ctx.tocEl.innerHTML = `<div class="dk-rail">` +
    `<div class="t-label dk-lab" title="${esc(here)} · ${esc(total)}">Panes<span class="n">${d.panes.length}<i>/${j.per_desk}</i></span></div>` +
    `<ul class="dk-panes">` + vs.map(paneRow).join("") + `</ul>` +
    `<div class="dk-foot"><button type="button" class="dk-new" data-a="new"${why ? ` disabled title="${esc(why)}"` : ""}>+ New pane</button>` +
    (stopped > 1 ? `<button type="button" class="dk-new" data-a="all" title="Start every stopped pane again">Start all</button>` : "") + `</div>` +
    // The documents fold, as a section in the sidebar does: the chevron
    // shows under the cursor, and stays while the list is folded.
    `<details class="dk-sec" data-sec="docs"${secFolded("docs") ? "" : " open"}><summary class="t-label dk-lab" title="The documents the panes on this desk have sent, newest first">From the panes<span class="s-chev" aria-hidden="true"></span>${dl.length ? `<span class="n">${dl.length}</span>` : ""}</summary>` +
    // A document's row: the one on the page is marked, the way a pane's row
    // is while the desk is the page. Under the cursor, the path it was sent
    // from, to copy -- the thing to hand back to the pane that sent it.
    (dl.length ? `<ul class="dk-docs">` + shown.map(x => `<li class="dk-doc${x.id === reading ? " on" : ""}"><a href="/d/${x.id}" data-read="${x.id}" class="${x.unread ? "new" : ""}" title="${x.id === reading ? "Click again to go back to the panes" : `${esc(x.title)} · ${esc(x.project)} · ${ctx.fmt(x.received_at)}${x.unread ? " · waiting to be read" : ""}`}"${x.id === reading ? ` aria-current="page"` : ""}>${ico("doc")}<span class="title">${esc(x.title)}</span>${x.pinned ? `<span class="pin" title="Pinned">●</span>` : ""}<span class="slot" title="Sent from pane ${x.slot}">${x.slot}</span>${x.id === reading ? "" : `<span class="k">${ctx.relShort(x.received_at)}</span>`}</a>` +
      // Its tools: the path to copy, where there is one; and on the row of
      // the document on the page, the way back to the panes. That row's
      // tools stay in view rather than wait for the cursor.
      ((x.source_path || x.id === reading) ? `<span class="dk-tools">` +
        (x.source_path ? `<button type="button" data-a="copy" data-path="${esc(x.source_path)}" title="Copy path · ${esc(x.source_path)}" aria-label="Copy the path of ${esc(x.title)}">${ico("copy")}</button>` : "") +
        (x.id === reading ? `<button type="button" data-a="desk" title="Back to the panes  ⌃\`" aria-label="Back to the panes">${ico("back")}</button>` : "") + `</span>` : "") + `</li>`).join("") + `</ul>` +
      // The rest, named rather than listed: one row that opens them here.
      (rest ? `<button type="button" class="dk-new dk-more" data-a="more" title="Show every document this desk has sent">${rest} more</button>` : "")
      : `<p class="dk-empty">Nothing yet. What an agent in a pane sends lands here.</p>`) +
    `</details>` + noteSec(d) + `</div>`;
  drawing = false;
  noteFocus();
  const v = views.get(focused), s = v ? v.status : null;
  const since = !s ? "" : s.blocked && s.blocked_since ? `blocked ${ago(s.blocked_since)}` : s.running && s.since ? `up ${ago(s.since)}` : s.exit != null ? `exited ${s.exit}` : "not running";
  // The desk's own two actions sit on its name, under the cursor: renaming
  // it and closing it are things done to the desk, and the name is where
  // the desk is.
  ctx.metaEl.innerHTML = `<div class="row dk-row"><b>Desk</b><span class="dk-nm">${esc(d.name)}</span><span class="dk-tools">` +
    `<button type="button" data-a="rename" title="Rename desk" aria-label="Rename desk">${ico("pen")}</button>` +
    sure("drop", "", "Close the desk and its panes", "Close desk", ico("x")) + `</span></div>` +
    `<div class="row"><b>Folder</b><span title="${esc(d.root)}">${esc(tilde(d.root))}</span></div>` +
    (v ? `<div class="row"><b>Pane</b><span><span class="dk-slot">[${v.pane.slot}]</span>${s.pid ? ` · pid ${s.pid}` : ""}${since ? ` · ${since}` : ""}</span></div>` : "");
  ctx.rail.classList.remove("empty");
}

/* ---------- the list ----------
 *
 * A desk's third section, under the documents: what this desk owes the reader,
 * in their own words. A checklist rather than prose -- one line, a circle to
 * tick, and the done half sinking to the bottom -- because the thing a rail is
 * good for is the short list you glance at while the work is in front of you.
 *
 * Every action here is optimistic and then confirmed: the circle fills under
 * the finger and the daemon is told afterwards, because a list that waits for
 * a round trip before it ticks feels broken even on loopback. The daemon's
 * answer is then read back, since it owns the order -- done lines sit in the
 * order they were ticked, and this page does not try to guess that.
 */

/** The section, drawn from whatever this page holds. */
function noteSec(d) {
  const { esc } = ctx;
  const mine = notesAt === d.id ? noteList : [];
  // Asked for once per desk, from the draw that first needs it: the list is
  // small and it is not worth a round trip on every arrival the way the
  // documents are.
  if (notesAt !== d.id) getNotes(d.id);
  const left = mine.filter(x => !x.done && !x.gone).length;
  const rows = mine.map(x => noteRow(x, esc)).join("");
  return `<details class="dk-sec dk-notes" data-sec="notes"${secFolded("notes") ? "" : " open"}>` +
    `<summary class="t-label dk-lab" title="A list of your own for this desk. It is kept on this machine and nothing on it is ever sent anywhere.">Notes<span class="s-chev" aria-hidden="true"></span>${left ? `<span class="n">${left}</span>` : ""}</summary>` +
    (rows ? `<ul class="dk-list">${rows}</ul>`
      : noteField ? "" : `<p class="dk-empty">Nothing on the list. What this desk owes you goes here.</p>`) +
    (noteField && noteField.kind === "new"
      ? `<div class="dk-note new"><span class="dk-tick ghost" aria-hidden="true"></span><input class="dk-note-in" placeholder="What has to happen" aria-label="A new note on this desk" spellcheck="false"></div>`
      : `<button type="button" class="dk-new" data-a="note-new">+ New note</button>`) +
    `</details>`;
}

/** One line. A line being rewritten is a field in the row's own place, so the
 *  text does not move under the cursor as it becomes editable; a line just
 *  taken off keeps its place too, holding the offer to put it back where the
 *  ✕ was rather than in a corner of the window. */
function noteRow(x, esc) {
  if (x.gone) {
    return `<li class="dk-note gone"><span class="nm">${esc(x.text)}</span>` +
      `<button type="button" class="dk-undo" data-a="note-back" data-n="${x.id}">Undo</button></li>`;
  }
  if (noteField && noteField.kind === "edit" && noteField.id === x.id) {
    return `<li class="dk-note${x.done ? " done" : ""}"><span class="dk-tick ghost" aria-hidden="true"></span>` +
      `<input class="dk-note-in" aria-label="This note" spellcheck="false"></li>`;
  }
  return `<li class="dk-note${x.done ? " done" : ""}">` +
    `<button type="button" class="dk-tick" role="checkbox" aria-checked="${x.done}" data-a="note-tick" data-n="${x.id}" aria-label="${x.done ? "Done" : "Not done"}: ${esc(x.text)}">${x.done ? ico("tick") : ""}</button>` +
    `<button type="button" class="nm" data-a="note-edit" data-n="${x.id}" title="Click to rewrite">${esc(x.text)}</button>` +
    `<span class="dk-tools"><button type="button" data-a="note-x" data-n="${x.id}" title="Take it off the list · nothing is deleted" aria-label="Take ${esc(x.text)} off the list">${ico("x")}</button></span></li>`;
}

/** Leaving a desk leaves its list with it: another desk's notes are another
 *  desk's, and a field left open on this one must not reopen on that one. */
function forgetNotes() {
  clearTimeout(backTimer);
  noteList = []; notesAt = null; notesGet = null; noteField = null; noteDraft = ""; noteCaret = 0;
}

/** This desk's list. Asked for once, unless a write says to look again. */
async function getNotes(id, again) {
  if (id == null || !ctx) return;
  if (!again && (notesAt === id || notesGet === id)) return;
  notesGet = id;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/notes`); } catch { notesGet = null; return; }
  notesGet = null;
  // The desk was swapped while this was in flight: its list is not this one's.
  if (id !== deskId) return;
  noteList = j.notes || []; notesAt = id;
  if (current()) rail();
}

/** Put the open field back after a redraw, with what was typed into it and the
 *  caret where the reader left it. */
function noteFocus() {
  const inp = ctx.tocEl.querySelector(".dk-note-in");
  if (!inp) return;
  inp.value = noteDraft;
  inp.addEventListener("input", () => { noteDraft = inp.value; noteCaret = inp.selectionStart; });
  // Where the caret was, not the end of the line: the rail redraws on the
  // clock every 30 seconds, and a caret that jumped to the end each time
  // would make a long note impossible to correct in the middle.
  for (const e of ["keyup", "click"]) inp.addEventListener(e, () => { noteCaret = inp.selectionStart; });
  inp.addEventListener("keydown", e => {
    // The desk gives every other key to the shell in the focused panel.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); saveNote(true); }
    else if (e.key === "Escape") { e.preventDefault(); noteField = null; noteDraft = ""; noteCaret = 0; rail(); }
  });
  inp.addEventListener("blur", () => { if (!drawing) saveNote(false); });
  inp.focus();
  const at = Math.min(noteCaret, inp.value.length);
  inp.setSelectionRange(at, at);
}

/** Keep what is in the field. `again` is Enter, which on a new line opens the
 *  next one: a list is written in a run, not one visit per line. An emptied
 *  line is taken off rather than kept blank, which is what the daemon does
 *  with an empty rewrite. */
async function saveNote(again) {
  const f = noteField, text = noteDraft.trim(), d = current();
  if (!f || !d) return;
  noteField = again && f.kind === "new" ? { kind: "new" } : null;
  noteDraft = ""; noteCaret = 0;
  rail();
  if (f.kind === "new" && !text) return;
  try {
    if (f.kind === "new") await ctx.api(`/api/desks/${d.id}/notes`, { text });
    else await ctx.api(`/api/desks/${d.id}/notes/${f.id}`, { text });
    await getNotes(d.id, true);
  } catch (e) { ctx.toast("Could not keep that note", String(e)); }
}

/** The documents this desk's panes sent, for the rail. Fetched when the desk
 *  opens, and again whenever the page hears a document arrive, get opened or
 *  go; the rail draws whatever it has meanwhile. */
export async function docs() {
  const id = deskId;
  if (id == null || !ctx) return;
  let j;
  try { j = await ctx.api(`/api/desks/${id}/docs`); } catch { return; }
  if (id !== deskId) return;
  docList = j.docs || []; docsAt = id;
  if (current()) rail();
}

// ---------- actions ----------

async function act(b) {
  const a = b.dataset.a, d = current(), v = views.get(b.dataset.p || focused);
  // Closing ends a process, and there is no undoing that: the first click
  // says what the second will do, in the control's own place.
  if (b.dataset.sure && !b.dataset.armed) {
    b.dataset.armed = "1"; const was = b.innerHTML, title = b.title;
    b.textContent = b.dataset.sure; b.title = "Click again to confirm";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.innerHTML = was; b.title = title; } }, 3000);
    return;
  }
  try {
    if (a === "make") ctx.make();
    else if (a === "swap") ctx.swap();
    else if (a === "new") {
      const j = await ctx.api(`/api/desks/${d.id}/panes`, {});
      focused = j.pane.id;
      await ctx.refresh();
      // Asking for a pane is asking for a shell: it starts, and the Start bar
      // is for a pane whose process ended, not one just made.
      const nv = views.get(j.pane.id);
      if (nv) { await run(nv, ""); nv.body.focus(); }
    } else if (a === "stop" && v) await ctx.api(`/api/panes/${v.id}/stop`, {});
    else if (a === "start" && v) run(v, v.start.querySelector("input").value);
    else if (a === "all") { for (const x of views.values()) if (!x.status.running) await run(x, x.status.cmd || x.pane.cmd || ""); }
    else if (a === "close" && v) { await ctx.api(`/api/panes/${v.id}/delete`, {}); await ctx.refresh(); }
    else if (a === "drop") { await ctx.api(`/api/desks/${d.id}/delete`, {}); await ctx.refresh(); ctx.go(null, true); }
    else if (a === "rename") renameDesk(d);
    else if (a === "desk") ctx.go(deskId, true);
    else if (a === "copy") { await navigator.clipboard?.writeText(b.dataset.path); ctx.toast("Copied", b.dataset.path); }
    else if (a === "more") { docsAll = true; rail(); }
    // The list. Each of these draws first and tells the daemon after: on a
    // list, the thing that has to feel instant is the tick.
    else if (a === "note-new") { noteField = { kind: "new" }; noteDraft = ""; noteCaret = 0; rail(); }
    else if (a === "note-edit") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) { noteField = { kind: "edit", id: x.id }; noteDraft = x.text; noteCaret = x.text.length; rail(); }
    } else if (a === "note-tick") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) {
        x.done = !x.done;
        rail();
        await ctx.api(`/api/desks/${d.id}/notes/${x.id}`, { done: x.done });
        // The daemon owns the order -- a line just ticked goes to the end of
        // the done half -- so the list is read back rather than guessed at.
        await getNotes(d.id, true);
      }
    } else if (a === "note-x") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      if (x) {
        // Only the newest offer stands: two rows both saying Undo cannot both
        // mean the last thing that happened.
        clearTimeout(backTimer);
        noteList = noteList.filter(y => y === x || !y.gone);
        x.gone = true;
        backTimer = setTimeout(() => {
          noteList = noteList.filter(y => !y.gone);
          if (current()) rail();
        }, BACK_MS);
        rail();
        await ctx.api(`/api/desks/${d.id}/notes/${x.id}/remove`, {});
      }
    } else if (a === "note-back") {
      const x = noteList.find(y => y.id === +b.dataset.n);
      clearTimeout(backTimer);
      if (x) {
        delete x.gone;
        rail();
        await ctx.api(`/api/desks/${d.id}/notes/${x.id}/restore`, {});
        await getNotes(d.id, true);
      }
    }
  } catch (e) { ctx.toast("Could not do that", String(e)); }
}

function renameDesk(d) {
  const nm = ctx.metaEl.querySelector(".dk-nm");
  if (!nm) return;
  const input = Object.assign(document.createElement("input"), { className: "ren-in", value: d.name, spellcheck: false });
  input.setAttribute("aria-label", "Name of this desk");
  nm.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async keep => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name && name !== d.name) {
      try { await ctx.api(`/api/desks/${d.id}/rename`, { name }); await ctx.refresh(); } catch (e) { ctx.toast("Could not rename", String(e)); }
    }
    rail();
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function focusPane(id) {
  const v = views.get(id);
  if (!v) return;
  // While a document is the page, a pane's row is the way back to the desk,
  // with that pane focused.
  if (reading != null) { ctx.go(deskId, true, v.pane.slot); return; }
  focused = id;
  layout();
  v.body.focus();
}

function click(e) {
  const f = e.target.closest("[data-focus]");
  if (f) { focusPane(f.dataset.focus); return; }
  const r = e.target.closest("a[data-read]");
  // The row of the document on the page is a toggle: a second click puts
  // the panes back, the way the first put the document up.
  if (r) { e.preventDefault(); if (r.dataset.read === reading) ctx.go(deskId, true); else ctx.read(r.dataset.read); return; }
  const b = e.target.closest("[data-a]");
  if (b && !b.disabled) act(b);
}

/** The focused pane alone, or the grid again. */
function zoom() {
  zoomed = !zoomed;
  layout();
  const v = views.get(focused);
  if (v) v.body.focus();
}

/** ⌃⌥1 to ⌃⌥4: a pane by its slot, from anywhere on the desk. ⌃⌥Z: the
 *  focused pane alone. */
function keys(e) {
  if (!(e.ctrlKey && e.altKey) || e.metaKey) return;
  if (e.code === "KeyZ") { if (reading != null) return; e.preventDefault(); e.stopPropagation(); zoom(); return; }
  if (!/^Digit[1-4]$/.test(e.code)) return;
  const d = current(), p = d && d.panes.find(x => x.slot === +e.code[5]);
  if (!p) return;
  e.preventDefault(); e.stopPropagation();
  focusPane(p.id);
}

const onResize = () => { if (current()) layout(); };

// ---------- the seam ----------

/** The document the desk stepped aside for, or null while the desk is the
 *  page. */
let reading = null;

function detach() {
  clearTimeout(retry);
  clearInterval(clock);
  if (!ctx) return;
  ctx.docEl.removeEventListener("click", click);
  ctx.tocEl.removeEventListener("click", click);
  ctx.tocEl.removeEventListener("toggle", folded, true);
  ctx.metaEl.removeEventListener("click", click);
  document.removeEventListener("keydown", keys, true);
  removeEventListener("resize", onResize);
}

export function open(c) {
  const first = !ctx;
  detach();
  ctx = c;
  style();
  if (first) {
    // A cell's width, measured in the font a pane is drawn in.
    const probe = Object.assign(document.createElement("span"), { className: "pn-probe", textContent: "0".repeat(40) });
    document.body.append(probe);
    cellW = probe.getBoundingClientRect().width / 40 || cellW;
    probe.remove();
    const g = document.createElement("style");
    g.id = "desk-drawn";
    g.textContent = drawn(cellW, LINE_PX);
    document.head.append(g);
  }
  if (deskId !== c.id) { views.clear(); focused = null; zoomed = false; docList = []; docsAt = null; docsAll = false; forgetNotes(); }
  deskId = c.id; reading = null;
  const d = current();
  if (d && c.slot) { const p = d.panes.find(x => x.slot === c.slot); if (p) focused = p.id; }
  draw();
  ctx.docEl.addEventListener("click", click);
  ctx.tocEl.addEventListener("click", click);
  ctx.tocEl.addEventListener("toggle", folded, true);
  ctx.metaEl.addEventListener("click", click);
  document.addEventListener("keydown", keys, true);
  addEventListener("resize", onResize);
  clock = setInterval(() => { if (current()) rail(); }, 30000);
  if (d && docsAt !== d.id) docs();
  const v = views.get(focused);
  if (v) setTimeout(() => v.body.focus(), 0);
}

export function update(desks) {
  if (!ctx) return;
  ctx.desks = desks;
  const d = current();
  // Behind a document, the page is not the desk's to draw: the rail is.
  if (reading != null) { if (d) { sync(d); rail(); } else { ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = ""; } return; }
  if (!d || !ctx.docEl.querySelector(".dk")) { draw(); return; }
  ctx.docEl.querySelector(".dk-name").textContent = d.name;
  sync(d);
  rail();
}

/** The desk steps aside for a document: the page becomes the document's,
 *  and the rail stays the desk's, with the document's row marked. The panes
 *  keep their socket and their scrollback -- a frame lands on a pane that is
 *  simply not in the page -- so coming back is a redraw, not a reconnect. */
export function aside(docId) {
  if (!ctx || deskId == null) return;
  reading = docId;
  ctx.docEl.removeEventListener("click", click);
  if (current()) rail();
}

export function close() {
  if (!ctx) return;
  say({ t: "watch", panes: [] });
  deskId = null; reading = null;
  views.clear();
  focused = null;
  docList = []; docsAt = null; docsAll = false;
  forgetNotes();
  detach();
  ctx.tocEl.innerHTML = ctx.metaEl.innerHTML = "";
}

// ---------- style ----------

function style() {
  if (document.getElementById("desk-css")) return;
  const s = document.createElement("style");
  s.id = "desk-css";
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
@font-face { font-family: "snyvi symbols"; font-display: block; unicode-range: U+E000-F8FF;
  src: local("Symbols Nerd Font Mono"), local("SymbolsNerdFontMono-Regular"), url(/assets/fonts/symbols-nerd.woff2) format("woff2"); }
:root { --pn-bg: var(--bg-raise); --pn-fg: var(--fg);
  --pn-font: "JetBrains Mono", "snyvi symbols", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --t0:#1f1d1a; --t1:#b3261e; --t2:#3b6d11; --t3:#a16207; --t4:#1d4ed8; --t5:#7e22ce; --t6:#0e7490; --t7:#8f897f;
  --t8:#5c574f; --t9:#dc2626; --t10:#4d7c0f; --t11:#ca8a04; --t12:#2563eb; --t13:#9333ea; --t14:#0891b2; --t15:#d8d3c9; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --t0:#2a2f3a; --t1:#f87171; --t2:#86c46d; --t3:#e6b450; --t4:#7aa2f7; --t5:#c792ea; --t6:#5ccfe6; --t7:#c8ccd4;
  --t8:#5c6370; --t9:#ff8b8b; --t10:#a6e3a1; --t11:#f9e2af; --t12:#89b4fa; --t13:#f5c2e7; --t14:#94e2d5; --t15:#ffffff; } }
:root[data-theme="dark"] { --t0:#2a2f3a; --t1:#f87171; --t2:#86c46d; --t3:#e6b450; --t4:#7aa2f7; --t5:#c792ea; --t6:#5ccfe6; --t7:#c8ccd4;
  --t8:#5c6370; --t9:#ff8b8b; --t10:#a6e3a1; --t11:#f9e2af; --t12:#89b4fa; --t13:#f5c2e7; --t14:#94e2d5; --t15:#ffffff; }
:root[data-view="desk"] #main { overflow: hidden; }
:root[data-view="desk"] #doc { max-width: none; height: 100%; padding: 14px 16px 16px; display: flex; flex-direction: column; }
:root[data-view="desk"] #doc:has(.inbox-head) { display: block; padding: 56px 48px; max-width: calc(var(--measure) + 96px); overflow-y: auto; }
.dk { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.dk-head { display: flex; align-items: center; gap: 10px; flex: none; min-width: 0; }
/* The page's bar lays its buttons over this row (app.css, #chrome): the one
 * that brings the sidebar back at the left, the rail's at the right, each
 * there only while its pane is folded, or a sheet. The head makes room for
 * whichever is showing; the window adds its own three (frame.js). */
:root[data-side="0"] .dk-head { padding-left: 30px; }
:root[data-rail="0"] .dk-head, #app:has(#rail.empty) .dk-head { padding-right: 30px; }
@media (max-width: 1100px) { .dk-head { padding-right: 30px; } }
@media (max-width: 760px) { .dk-head { padding-left: 30px; } }
.dk-name { font-weight: 600; }
.dk-root { color: var(--fg-3); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-tabs { display: flex; gap: 2px; margin-left: auto; }
.dk-tabs button { font-family: var(--mono); font-size: 11px; color: var(--fg-3); padding: 2px 5px; border-radius: 4px; }
.dk-tabs button.on { color: var(--accent); background: var(--accent-bg); }
/* Zoomed: the one tab that is on carries a mark, so a full-size pane with
 * tabs beside it reads as a zoom and not as a window too narrow for two. */
.dk:has(.dk-grid[data-zoom="1"]) .dk-tabs button.on::after { content: " ⤢"; }
.dk-head .icon:first-of-type { margin-left: auto; }
.dk-head .dk-tabs:not(:empty) + .icon, .dk-head .dk-cap + .icon { margin-left: 0; }
/* At the cap: the + at rest, and the count beside it in the tab strip's
 * hand, so 4/4 and the quiet + read as one thing. */
.dk-head .icon:disabled { opacity: .4; cursor: default; }
.dk-head .icon:disabled:hover { background: none; color: var(--fg-3); }
.dk-cap { font-family: var(--mono); font-size: 11px; color: var(--fg-3); margin-left: auto; padding: 2px 0 2px 5px; font-variant-numeric: tabular-nums; }
.dk-tabs:not(:empty) + .dk-cap { margin-left: 0; }
.dk-grid { flex: 1; min-height: 0; display: grid; gap: 6px; position: relative; }
.dk-none { color: var(--fg-3); padding: 24px; }
.dk-none button { color: var(--accent); }
.dk-div { position: absolute; z-index: 2; }
.dk-v { top: 0; bottom: 0; width: 8px; left: calc(var(--col) * 100% - 4px); cursor: col-resize; }
.dk-h { left: 0; right: 0; height: 8px; top: calc(var(--row) * 100% - 4px); cursor: row-resize; }
.dk-grid:not([data-cols="2"]) .dk-v, .dk-grid:not([data-rows="2"]) .dk-h { display: none; }
.dk-div:hover, .dk-div:focus-visible { background: var(--accent-bg); }
.pn { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--pn-bg); overflow: hidden; }
.pn.on { border-color: var(--rule-2); box-shadow: 0 0 0 1px var(--accent-bg); }
.pn-head { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; font-size: 11.5px; color: var(--fg-3); border-bottom: 1px solid var(--rule); cursor: default; white-space: nowrap; flex: none; }
.pn-slot { font-family: var(--mono); color: var(--fg-2); }
.pn-start[hidden] { display: none; }
.pn-cmd { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; }
.pn-git { font-family: var(--mono); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; max-width: 40%; flex: none; }
.pn-state { margin-left: auto; padding-left: 8px; }
.pn.blk .pn-head { border-bottom: 2px solid #d97706; }
.pn.blk .pn-state { color: #b45309; font-weight: 600; }
.pn-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 4px 6px; font-family: var(--pn-font); font-size: 12.5px; line-height: ${LINE_PX}px; color: var(--pn-fg); outline: none; scrollbar-width: thin; }
.pn-old > div, .pn-sb > div, .pn-scr > div { white-space: pre; height: ${LINE_PX}px; overflow: hidden; }
.pn-sb > .gap { color: var(--fg-3); font-style: italic; }
.pn-old { color: var(--fg-3); opacity: .7; }
.pn-live { position: relative; }
.pn.off .pn-scr { opacity: .55; }
.pn-caret { position: absolute; left: 0; top: 0; height: ${LINE_PX}px; background: var(--fg); opacity: .35; pointer-events: none; }
.pn.on .pn-caret { opacity: .75; animation: pn-blink 1.1s steps(1) infinite; }
@keyframes pn-blink { 50% { opacity: .15; } }
.pn-body .b { font-weight: 650; } .pn-body .d { opacity: .6; } .pn-body .i { font-style: italic; }
.pn-body .u { text-decoration: underline; } .pn-body .s { text-decoration: line-through; } .pn-body .u.s { text-decoration: underline line-through; }
.pn-body .h { color: transparent !important; }
.pn-body span { display: inline-block; height: ${LINE_PX}px; vertical-align: top; }
/* An icon is drawn a full em wide and a cell is 0.6 of one: set a size down,
 * centred in its cell, and over its neighbours rather than under them. */
.pn-body .nf { position: relative; font-size: 10px; }
.pn-body .g { position: relative; -webkit-text-fill-color: transparent; }
.pn-body .g::before { content: ""; position: absolute; inset: 0; background: currentColor; -webkit-mask: var(--g) 0 0 / 100% 100% no-repeat; mask: var(--g) 0 0 / 100% 100% no-repeat; }
.pn-start { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 8px; align-items: center; padding: 8px; background: var(--bg-raise); border: 1px solid var(--rule-2); border-radius: 6px; box-shadow: var(--shadow); }
.pn-start button { color: var(--accent); font-weight: 600; flex: none; }
.pn-start input { flex: 1; min-width: 0; font: 12.5px var(--mono); color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: 4px; padding: 3px 6px; }
.pn-probe { position: absolute; visibility: hidden; white-space: pre; font-family: var(--pn-font); font-size: 12.5px; }
/* ---------- the rail ----------
 * Three lists and a label over each, drawn the way the sidebar draws its own
 * rows: a mark at the left, the name, and one fact at the right. */
.dk-lab { display: flex; align-items: baseline; padding-left: 8px; }
.dk-lab .n { margin-left: auto; font-family: var(--mono); font-size: 10px; letter-spacing: 0; text-transform: none; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.dk-lab .n i { font-style: normal; opacity: .6; }
.dk-foot { display: flex; gap: 10px; margin-top: 2px; }
.dk-foot + .dk-sec { margin-top: 16px; }
/* #toc styles an outline -- a rule down the left, entries clamped to two
 * lines -- and these are rows, so both are undone at #toc's own weight. */
#toc .dk-rail ul { list-style: none; margin: 2px 0 0; padding: 0; border-left: 0; }
/* A pane's row is the row and its tools: the row focuses the pane, and the
 * tools -- kept to no width until the row is under the cursor, or one of
 * them has the keyboard, the way a sidebar row's ✕ is -- act on it. */
.dk-pane { display: flex; align-items: center; border-radius: 6px; color: var(--fg-2); transition: background var(--t), color var(--t); }
.dk-pane:hover { background: var(--rule); color: var(--fg); }
.dk-pane.on { background: var(--accent-bg); color: var(--accent); }
.dk-focus { display: flex; align-items: baseline; gap: 6px; flex: 1; min-width: 0; text-align: left; padding: 4px 8px; color: inherit; white-space: nowrap; overflow: hidden; }
.dk-tools { display: flex; align-items: center; gap: 1px; flex: none; margin-left: auto; width: 0; overflow: hidden; }
.dk-pane:hover .dk-tools, .dk-doc:hover .dk-tools, .dk-note:hover .dk-tools, .dk-row:hover .dk-tools, .dk-tools:has(:focus-visible), .dk-tools:has([data-armed]) { width: auto; overflow: visible; padding-right: 3px; }
.dk-tools button { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--fg-3); transition: background var(--t), color var(--t); }
.dk-pane.on .dk-tools button { color: var(--accent); opacity: .8; }
.dk-tools button:hover { background: var(--rule-2); color: var(--fg); opacity: 1; }
.dk-tools button[data-armed] { width: auto; padding: 0 5px; font-size: 11px; font-weight: 600; color: #dc2626; }
.dk-tools button[data-armed]:hover { background: color-mix(in srgb, #dc2626 12%, transparent); color: #dc2626; }
.dk-panes .dot { width: 8px; flex: none; text-align: center; font-size: 8px; color: var(--fg-3); align-self: center; }
.dk-panes .run .dot { color: #16a34a; }
.dk-panes .blk .dot { color: #b45309; font-weight: 700; font-size: 11px; }
/* The documents section folds. Its head is the label, made a summary: the
 * chevron the sidebar's heads carry, shown under the cursor and while
 * folded. */
.dk-sec > summary { list-style: none; cursor: pointer; }
.dk-sec > summary::-webkit-details-marker { display: none; }
/* Always shown here, unlike the sidebar's: the rail has one section that
 * folds and one that does not, and the chevron is what tells them apart. */
.dk-sec .s-chev { align-self: center; margin-left: 6px; opacity: 1; }
.dk-sec:not([open]) .s-chev { transform: rotate(-45deg); }
.dk-sec > summary:hover { color: var(--fg-2); }
.dk-panes .slot, .dk-docs .slot, .dk-slot { font-family: var(--mono); font-size: 10.5px; color: var(--fg-3); flex: none; font-variant-numeric: tabular-nums; }
.dk-panes .on .slot { color: inherit; opacity: .7; }
.dk-panes .nm { overflow: hidden; text-overflow: ellipsis; }
.dk-new { display: block; color: var(--fg-3); padding: 3px 8px; font-size: 12px; border-radius: 6px; }
.dk-new:hover:not(:disabled) { color: var(--accent); }
.dk-new:disabled { opacity: .5; cursor: default; }
/* The rest of the documents, as one row under the latest: the count is the
 * number the rail is not showing, so it changes as they arrive. */
.dk-more { margin-top: 2px; font-variant-numeric: tabular-nums; }
/* A document row: a page icon at the left, in the accent while the
 * document waits to be read, then the title, the pane it came from and its
 * age. */
#toc .dk-docs li a { display: flex; flex: 1; min-width: 0; align-items: center; gap: 6px; margin: 0; padding: 4px 8px; border: 0; border-radius: 6px; color: var(--fg-2); line-height: 1.5; white-space: nowrap; overflow: hidden; -webkit-line-clamp: unset; transition: color var(--t); }
.dk-docs a svg { flex: none; color: var(--fg-3); transition: color var(--t); }
.dk-docs a.new svg { color: var(--accent); }
.dk-docs a.new .title { color: var(--fg); font-weight: 550; }
/* The row, and not the link, carries the hover and the mark, so the copy
 * tool beside the link sits on the same ground. */
.dk-doc { display: flex; align-items: center; border-radius: 6px; transition: background var(--t); }
.dk-doc:hover { background: var(--rule); }
#toc .dk-docs li a:hover { color: var(--fg); text-decoration: none; }
.dk-doc.on { background: var(--accent-bg); }
#toc .dk-doc.on a, .dk-doc.on a svg, .dk-doc.on a .slot, .dk-doc.on a .k { color: var(--accent); }
.dk-doc.on .dk-tools { width: auto; overflow: visible; padding-right: 3px; }
/* A document row's tools are drawn as small keys, on their own ground: the
 * marked row shows them at rest, and two bare glyphs beside a title would
 * read as part of it. The age steps aside for them on that row. */
.dk-doc .dk-tools { gap: 3px; }
.dk-doc .dk-tools button { background: var(--bg-raise); box-shadow: 0 0 0 1px var(--rule-2); }
.dk-doc.on .dk-tools button { color: var(--accent); opacity: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
.dk-doc .dk-tools button:hover { background: var(--accent); color: var(--bg); box-shadow: none; }
.dk-docs .title { overflow: hidden; text-overflow: ellipsis; }
.dk-docs .pin { color: var(--accent); font-size: 7px; flex: none; align-self: center; }
.dk-docs .slot { margin-left: auto; }
.dk-docs .slot::before { content: "["; } .dk-docs .slot::after { content: "]"; }
.dk-docs .k { font-family: var(--mono); font-size: 10px; color: var(--fg-3); flex: none; min-width: 3ch; text-align: right; font-variant-numeric: tabular-nums; }
#toc .dk-empty { margin: 2px 8px 0; padding: 0; text-indent: 0; font-size: 12px; line-height: 1.5; color: var(--fg-3); }
/* The desk's name carries its two tools; the row is a little taller than
 * its neighbours so they have room, and the name stays on their baseline. */
#meta .dk-row { align-items: center; min-height: 22px; }
#meta .dk-row .dk-nm { flex: 1; }
#meta .dk-row .dk-tools { line-height: 1; }
.dk-make { padding: 6px 12px; border-radius: 6px; background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.dk-make:hover { background: var(--accent); color: var(--bg); }
/* ---------- the list ----------
 * A checklist, drawn on the same row grid as the panels and the documents
 * above it, so the three read as one rail and not as three widgets. The
 * circle is the one control that is always visible: it is the whole point of
 * the row, and a tick that had to be hunted for under a hover would not be
 * worth having. Everything else -- rewriting, taking it off -- waits for the
 * cursor, as every other row in this app does.
 *
 * A line wraps rather than being cut. A pane's title is a name and a name that
 * does not fit can be shortened; a note is a sentence, and half of it is not a
 * smaller version of it. */
.dk-sec + .dk-notes { margin-top: 16px; }
.dk-note { display: flex; align-items: flex-start; gap: 6px; border-radius: 6px; transition: background var(--t); }
.dk-note:hover { background: var(--rule); }
.dk-note > .nm { flex: 1; min-width: 0; text-align: left; padding: 4px 0; font-size: 12px; line-height: 1.5; color: var(--fg-2); white-space: normal; overflow-wrap: anywhere; }
.dk-note:hover > .nm { color: var(--fg); }
/* Done: said twice, because a strike alone is hard to see at 12px in a dim
   rail and a dim row alone reads as disabled rather than as finished. */
.dk-note.done > .nm { color: var(--fg-3); text-decoration: line-through; text-decoration-color: var(--fg-3); }
/* The circle. A button rather than a checkbox input so it draws the same on
   every platform, with the role and the state a checkbox would have carried. */
.dk-tick { flex: none; display: grid; place-items: center; width: 16px; height: 16px; margin: 5px 0 0 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--fg-3); color: transparent; transition: box-shadow var(--t), background var(--t), color var(--t); }
.dk-tick:hover { box-shadow: inset 0 0 0 1.5px var(--accent); }
.dk-tick[aria-checked="true"] { background: var(--accent); box-shadow: none; color: var(--bg); }
.dk-tick svg { width: 11px; height: 11px; }
/* The field's own circle: the row keeps its shape while it is being written,
   so the text does not step left and back again as the field opens and shuts. */
.dk-tick.ghost { box-shadow: inset 0 0 0 1.5px var(--rule-2); }
.dk-note .dk-tools { align-self: flex-start; margin-top: 3px; }
.dk-note-in { flex: 1; min-width: 0; margin: 2px 8px 2px 0; padding: 2px 6px; font: inherit; font-size: 12px; line-height: 1.5; color: var(--fg); background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; }
.dk-note-in:focus { outline: none; }
.dk-note-in::placeholder { color: var(--fg-3); }
/* A line just taken off, holding its own place in the list: the offer to put
   it back is where the ✕ was, which is where the eye already is. Nothing was
   deleted, so the row says the mildest true thing and says it quietly. */
.dk-note.gone { color: var(--fg-3); font-size: 12px; padding: 4px 8px; animation: dk-fade 140ms ease-out; }
.dk-note.gone > .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: line-through; }
.dk-undo { flex: none; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 4px; color: var(--accent); }
.dk-undo:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
@keyframes dk-fade { from { opacity: 0; } to { opacity: 1; } }
`;
