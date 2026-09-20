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
  if (f.sbclear) v.sb.replaceChildren();
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

// ---------- a pane ----------

function makeView(p) {
  const el = document.createElement("section");
  el.className = "pn";
  el.dataset.id = p.id;
  el.innerHTML = `<header class="pn-head"><span class="pn-slot"></span><span class="pn-cmd"></span><span class="pn-git"></span><span class="pn-state"></span></header>` +
    `<div class="pn-body" tabindex="0" role="region" aria-label="Terminal"><div class="pn-old"></div><div class="pn-sb"></div><div class="pn-live"><div class="pn-scr"></div><i class="pn-caret" hidden></i></div></div>` +
    `<form class="pn-start" hidden><button type="submit">▶ Start</button><input spellcheck="false" autocomplete="off" aria-label="Command to run"></form>`;
  const v = {
    id: p.id, pane: p, el, status: p.status || {}, cols: 0, rows: 0, cells: [], cur: [0, 0, 0], mode: [0, 0], asked: false,
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
    // The platform's (⌘C, ⌘V, ⌘K), and snyvi's two: the swap and the pane keys.
    if (e.metaKey || (e.ctrlKey && e.key === "`") || (e.ctrlKey && e.altKey && /^Digit[1-4]$/.test(e.code))) return;
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

function layout() {
  const d = current(), grid = ctx.docEl.querySelector(".dk-grid");
  if (!d || !grid) return;
  const all = d.panes.map(p => views.get(p.id)).filter(Boolean);
  // The focused pane is always shown; the rest in slot order, while there is room.
  const n = room(), f = all.find(v => v.id === focused);
  const shown = all.length <= n ? all : [f, ...all.filter(v => v !== f)].filter(Boolean).slice(0, n).sort((a, b) => a.pane.slot - b.pane.slot);
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
  docEl.innerHTML = `<div class="dk"><header class="dk-head"><b class="dk-name"></b><span class="dk-root"></span><span class="dk-tabs"></span>` +
    `<button type="button" class="icon" data-a="new" title="New pane" aria-label="New pane">+</button>` +
    `<button type="button" class="icon" data-a="swap" title="Reading view  ⌃\`" aria-label="Reading view">▣</button></header>` +
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

function rail() {
  const d = current();
  if (!d) return;
  const { esc } = ctx, j = ctx.desks;
  const dot = v => v.status.blocked ? "!" : v.status.running ? "●" : "○";
  const vs = d.panes.map(p => views.get(p.id)).filter(Boolean);
  // The nearer of the two caps is the one worth naming.
  const here = `${d.panes.length} of ${j.per_desk} here`, total = `${j.panes} of ${j.cap} total`;
  const cap = j.cap - j.panes < j.per_desk - d.panes.length ? total : here;
  ctx.tocEl.innerHTML = `<div class="dk-rail"><div class="t-label">Panes</div><ul>` +
    vs.map(v => `<li><button type="button" data-focus="${v.id}" class="${v.id === focused ? "on" : ""}${v.status.blocked ? " blk" : ""}"><span class="dot">${dot(v)}</span>${v.pane.slot} ${esc(what(v))}</button></li>`).join("") +
    `</ul><button type="button" class="dk-new" data-a="new"${d.panes.length >= Math.min(j.per_desk, room()) || j.panes >= j.cap ? " disabled" : ""}>+ new pane</button><p class="dk-cap">${cap}</p></div>`;
  const v = views.get(focused), s = v ? v.status : null;
  const since = !s ? "" : s.blocked && s.blocked_since ? `blocked ${ago(s.blocked_since)}` : s.running && s.since ? `up ${ago(s.since)}` : s.exit != null ? `exited ${s.exit}` : "not running";
  const stopped = vs.filter(x => !x.status.running).length;
  ctx.metaEl.innerHTML = `<div class="row"><b>Desk</b><span class="dk-nm">${esc(d.name)}</span></div><div class="row"><b>Folder</b><span title="${esc(d.root)}">${esc(tilde(d.root))}</span></div>` +
    (v ? `<div class="row"><b>Focused</b><span>[${v.pane.slot}] ${esc(what(v))}</span></div>` + (s.pid ? `<div class="row"><b>Pid</b><span>${s.pid}</span></div>` : "") + `<div class="row"><b>State</b><span>${since}</span></div>` : "") +
    `<div class="actions">` +
    (v && s.running ? `<button data-a="stop">Stop</button>` : v ? `<button data-a="start">Start</button>` : "") +
    (stopped > 1 ? `<button data-a="all">Start all</button>` : "") +
    (v ? `<button data-a="close" data-sure="Close the pane: click again">Close pane</button>` : "") +
    `<button data-a="rename">Rename desk</button><button data-a="drop" data-sure="Close the desk and its panes: click again">Close desk</button></div>`;
  ctx.rail.classList.remove("empty");
}

// ---------- actions ----------

async function act(b) {
  const a = b.dataset.a, d = current(), v = views.get(focused);
  // Closing ends a process, and there is no undoing that: the first click
  // says what the second will do.
  if (b.dataset.sure && !b.dataset.armed) {
    b.dataset.armed = "1"; const was = b.textContent; b.textContent = b.dataset.sure;
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = was; } }, 3000);
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
  focused = id;
  layout();
  v.body.focus();
}

function click(e) {
  const f = e.target.closest("[data-focus]");
  if (f) { focusPane(f.dataset.focus); return; }
  const b = e.target.closest("[data-a]");
  if (b && !b.disabled) act(b);
}

/** ⌃⌥1 to ⌃⌥4: a pane by its slot, from anywhere on the desk. */
function keys(e) {
  if (!(e.ctrlKey && e.altKey) || !/^Digit[1-4]$/.test(e.code)) return;
  const d = current(), p = d && d.panes.find(x => x.slot === +e.code[5]);
  if (!p) return;
  e.preventDefault(); e.stopPropagation();
  focusPane(p.id);
}

const onResize = () => { if (current()) layout(); };

// ---------- the seam ----------

function detach() {
  clearTimeout(retry);
  clearInterval(clock);
  if (!ctx) return;
  ctx.docEl.removeEventListener("click", click);
  ctx.tocEl.removeEventListener("click", click);
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
  if (deskId !== c.id) { views.clear(); focused = null; }
  deskId = c.id;
  const d = current();
  if (d && c.slot) { const p = d.panes.find(x => x.slot === c.slot); if (p) focused = p.id; }
  draw();
  ctx.docEl.addEventListener("click", click);
  ctx.tocEl.addEventListener("click", click);
  ctx.metaEl.addEventListener("click", click);
  document.addEventListener("keydown", keys, true);
  addEventListener("resize", onResize);
  clock = setInterval(() => { if (current()) rail(); }, 30000);
  const v = views.get(focused);
  if (v) setTimeout(() => v.body.focus(), 0);
}

export function update(desks) {
  if (!ctx) return;
  ctx.desks = desks;
  const d = current();
  if (!d || !ctx.docEl.querySelector(".dk")) { draw(); return; }
  ctx.docEl.querySelector(".dk-name").textContent = d.name;
  sync(d);
  rail();
}

export function close() {
  if (!ctx) return;
  say({ t: "watch", panes: [] });
  deskId = null;
  views.clear();
  focused = null;
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
:root[data-view="desk"] #doc { max-width: none; height: 100%; padding: 12px 16px 16px; display: flex; flex-direction: column; }
:root[data-view="desk"] #doc:has(.inbox-head) { display: block; padding: 56px 48px; max-width: calc(var(--measure) + 96px); overflow-y: auto; }
.dk { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
.dk-head { display: flex; align-items: center; gap: 10px; flex: none; min-width: 0; }
.dk-name { font-weight: 600; }
.dk-root { color: var(--fg-3); font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-tabs { display: flex; gap: 2px; margin-left: auto; }
.dk-tabs button { font-family: var(--mono); font-size: 11px; color: var(--fg-3); padding: 2px 5px; border-radius: 4px; }
.dk-tabs button.on { color: var(--accent); background: var(--accent-bg); }
.dk-head .icon:first-of-type { margin-left: auto; }
.dk-tabs:not(:empty) + .icon { margin-left: 0; }
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
.dk-rail ul { list-style: none; margin: 4px 0; padding: 0; }
.dk-rail li button { display: flex; gap: 6px; width: 100%; text-align: left; padding: 3px 6px; border-radius: 5px; color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-rail li button.on { background: var(--accent-bg); color: var(--accent); }
.dk-rail li button.blk .dot { color: #b45309; font-weight: 700; }
.dk-rail .dot { width: 10px; flex: none; text-align: center; font-size: 9px; }
.dk-new { color: var(--fg-3); padding: 3px 6px; font-size: 12.5px; }
.dk-new:hover:not(:disabled) { color: var(--accent); }
.dk-new:disabled { opacity: .5; cursor: default; }
.dk-make { padding: 6px 12px; border-radius: 6px; background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.dk-make:hover { background: var(--accent); color: var(--bg); }
.dk-make { padding: 6px 12px; border-radius: 6px; background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.dk-make:hover { background: var(--accent); color: var(--bg); }
.dk-cap { margin: 4px 6px; font-size: 11px; color: var(--fg-3); }
`;
