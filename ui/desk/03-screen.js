/* ui/desk/03-screen.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- the scrollback ----------

/* A panel's scrollback is thousands of rows, and four panels of them as rows
 * in the document were a million boxes -- every drawn character a layer of
 * its own -- which WebKit took gigabytes and whole seconds a frame to lay
 * out. So the rows go in chunks of CHUNK, and only the chunks near the view
 * are in the document: the rest are their HTML, kept as a string, in an empty
 * box as tall as they were. The oldest go a chunk at a time, not a row a
 * frame. `box.rows` is how many a box holds. */

/** A chunk's rows as HTML, made the first time it is needed: a chunk put
 *  away keeps the lines as they came, and most of a snapshot is never
 *  scrolled to. Building every row of four snapshots was a second of the
 *  page's time on every return to a desk. */
function chunkHtml(v, c) {
  if (c.todo.length) { c.src += c.todo.map(fmtOf(v, c.parentElement)).join(""); c.todo = []; }
  return c.src;
}

/** Add rows, each a line as it came (see `sbRow`), to the end of `v.sb` or
 *  `v.old`. */
function addRows(v, box, rows) {
  const fmt = fmtOf(v, box);
  for (let i = 0; i < rows.length;) {
    let c = box.lastElementChild;
    if (!c || c.n >= CHUNK) {
      c = document.createElement("div");
      c.className = "pn-pg";
      c.n = 0; c.src = ""; c.todo = [];
      // A snapshot is thousands of rows at once, and all but the last two
      // chunks of it are out of sight: they start put away, not laid out
      // first and put away after.
      if (rows.length - i > 2 * CHUNK) { c.held = true; c.classList.add("held"); }
      box.append(c);
      v.io.observe(c);
    }
    const k = Math.min(rows.length - i, CHUNK - c.n), take = rows.slice(i, i + k);
    c.n += k; i += k;
    if (c.held) { c.todo.push(...take); c.style.setProperty("--n", c.n); }
    else { const h = take.map(fmt).join(""); chunkHtml(v, c); c.src += h; c.insertAdjacentHTML("beforeend", h); }
  }
  box.rows = (box.rows || 0) + rows.length;
  let gone = 0;
  for (let c; (c = box.firstElementChild) && box.rows - c.n >= KEEP_LINES;) {
    box.rows -= c.n; gone += c.n;
    v.io.unobserve(c);
    c.remove();
    // Full: what was above the top that went is not asked for again, and an
    // answer on its way would land above a hole.
    box.more = 0; box.asking = false; box.at = null;
  }
  // A reader scrolled up stays on the line they were reading.
  if (gone && !v.pinned) v.body.scrollTop -= gone * LINE_PX;
}

/** Put rows above the first of `box`'s: older lines, which the daemon sent
 *  because the reader scrolled up to the top of what the page held. They
 *  start put away, and the view stays on the line it was showing. */
function prependRows(v, box, rows) {
  if (!rows.length) return;
  const b = v.body, h = b.scrollHeight;
  let at = box.firstElementChild;
  for (let end = rows.length; end > 0;) {
    const c = document.createElement("div"), start = Math.max(0, end - CHUNK);
    c.className = "pn-pg held";
    c.held = true; c.n = end - start; c.src = ""; c.todo = rows.slice(start, end);
    c.style.setProperty("--n", c.n);
    box.insertBefore(c, at);
    v.io.observe(c);
    at = c; end = start;
  }
  box.rows = (box.rows || 0) + rows.length;
  b.scrollTop = v.pinned ? b.scrollHeight : b.scrollTop + b.scrollHeight - h;
}

function clearRows(v, box) {
  for (const c of box.children) v.io.unobserve(c);
  box.replaceChildren();
  box.rows = 0;
  box.more = 0; box.asking = false; box.at = null;
}

/** A chunk out of reach is put away, unless the reader's selection is in it:
 *  that would take the selection with it. The first chunk of a box coming
 *  near, with more above it at the daemon, asks for the next of them. */
function reach(v, entries) {
  const sel = getSelection();
  for (const { target: c, isIntersecting: near } of entries) {
    if (near && c.held) { c.held = false; c.classList.remove("held"); c.innerHTML = chunkHtml(v, c); }
    else if (!near && !c.held && !(sel.rangeCount && sel.containsNode(c, true))) {
      c.held = true; c.style.setProperty("--n", c.n); c.classList.add("held"); c.replaceChildren();
    }
    const box = c.parentElement;
    if (near && box && box.firstElementChild === c && box.more > 0 && !box.asking && box.rows < KEEP_LINES) {
      box.asking = true;
      const n = KEEP_LINES - box.rows;
      if (box === v.old) say({ t: "more", p: v.id, old: box.g, before: box.rows, n });
      else say({ t: "more", p: v.id, before: box.at, n });
    }
  }
}

/** The row before or after one in the scrollback, over a chunk's edge, while
 *  that chunk is in the document. */
const rowBefore = r => r.previousElementSibling || r.parentElement.previousElementSibling?.lastElementChild || null;
const rowAfter = r => r.nextElementSibling || r.parentElement.nextElementSibling?.firstElementChild || null;

function dropView(v) {
  v.io.disconnect();
  views.delete(v.id);
}

const bornOf = v => (v.status.accent ? parseInt(v.status.accent.slice(1), 16) : -1);
const blankRow = n => Array.from({ length: n }, () => [" ", 0, 0, 0, 1]);

function cursor(v) {
  const [x, y, on] = v.cur;
  const hide = !on || !v.status.running, w = cellW * ((v.cells[y] && v.cells[y][x] && v.cells[y][x][4]) || 1);
  // Written only when it moved: a frame that leaves the caret where it was
  // is most of them, and the same style written again is still a restyle.
  const at = `${hide},${x * cellW},${y * LINE_PX},${w}`;
  if (at === v.caretAt) return;
  v.caretAt = at;
  v.caret.hidden = hide;
  v.caret.style.transform = `translate(${x * cellW}px, ${y * LINE_PX}px)`;
  v.caret.style.width = w + "px";
}

/** A row of cells as HTML: runs that share an attribute become one span.
 *  A character the pane's font does not have is a span of its own, one cell
 *  wide or two, so that the advance of whatever font draws it cannot push the
 *  rest of the row off the grid. */
function rowHtml(row) {
  let out = "", text = "", key = null, at = null;
  const flush = () => { if (text) out += span(at, text, false); text = ""; };
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (!c) continue;
    if (ownCell(c)) {
      flush(); key = null;
      // A rule or a bar is one character many times over: one span for the
      // run, its mask repeated across it, not a span and a layer for each.
      let n = 1;
      if (c[4] === 1 && DRAWN[c[0]]) {
        for (let d; (d = row[i + n]) && d[0] === c[0] && d[1] === c[1] && d[2] === c[2] && d[3] === c[3];) n++;
      }
      out += span(c, n > 1 ? c[0].repeat(n) : c[0], true, n);
      i += n - 1;
      continue;
    }
    const k = `${c[1]},${c[2]},${c[3]}`;
    if (k !== key) { flush(); key = k; at = c; }
    text += c[0];
  }
  flush();
  return out;
}
const runsHtml = runs => {
  const row = [];
  for (const [t, fg = 0, bg = 0, fl = 0] of runs) for (const ch of fl & CLUSTER ? [t] : t) row.push([ch, fg, bg, fl & ~(WIDE | CLUSTER), fl & WIDE ? 2 : 1]);
  return rowHtml(row);
};

function span(c, text, own, run = 1) {
  const [ch, fg, bg, fl, w] = c;
  const t = ctx.esc(text);
  let cls = (fl & 1 ? " b" : "") + (fl & 2 ? " d" : "") + (fl & 4 ? " i" : "") + (fl & 8 ? " u" : "") + (fl & 128 ? " s" : "") + (fl & 64 ? " h" : "");
  if (own) cls += (w === 2 ? " x w" : " x") + (DRAWN[ch] ? ` g g${ch.charCodeAt(0).toString(16)}${run > 1 ? " r" : ""}` : /[\ue000-\uf8ff]/.test(text) ? " nf" : "");
  if (!fg && !bg && !cls) return t;
  let f = color(fg), b = color(bg);
  if (fl & 32) { [f, b] = [b || "var(--pn-bg)", f || "var(--pn-fg)"]; }
  const style = (f ? `color:${f};` : "") + (b ? `background:${b};` : "") + (run > 1 ? `--r:${run};` : "");
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
const DRAWN = {}, MASK = {}, TINT = new Map();
// Drawn characters that are the same all the way across the cell: a run of
// one of them is its mask stretched over the run, one draw rather than one a
// cell -- a frame's top edge is a couple of hundred `─`.
const SPAN = new Set("─━▀█▔░▒▓▁▂▃▄▅▆▇");

function drawn(W, H) {
  const t = Math.max(1, Math.round(W / 7)), cx = W / 2, cy = H / 2;
  // Each is drawn once, in device pixels, and handed to CSS as a PNG: an SVG
  // mask is laid out again as a document for every cell on every paint
  // (docs/DESK-PAINT.md), a bitmap is only drawn.
  // The canvas is kept: the live screen tints it (`tint`), the scrollback
  // shows it through CSS as a PNG.
  const dpr = window.devicePixelRatio || 1;
  let c;
  const png = (parts, unit) => {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    c = cv.getContext("2d");
    c.setTransform(cv.width / (unit ? 1 : W), 0, 0, cv.height / (unit ? 1 : H), 0, 0);
    for (const p of parts) if (p) p();
    return cv;
  };
  const rect = (x, y, w, h, o = 1) => () => { c.globalAlpha = o; c.fillRect(x, y, w, h); c.globalAlpha = 1; };
  const line = d => () => { c.lineWidth = t; c.stroke(new Path2D(d)); };
  const fill = d => () => c.fill(new Path2D(d));
  for (const [ch, w] of Object.entries(LINES)) {
    const [l, r, u, d] = [...w].map(Number), m = Math.max(l, r, u, d) * t / 2;
    MASK[ch] = png([l && rect(0, cy - l * t / 2, cx + m, l * t), r && rect(cx - m, cy - r * t / 2, W - cx + m, r * t),
      u && rect(cx - u * t / 2, 0, u * t, cy + m), d && rect(cx - d * t / 2, cy - m, d * t, H - cy + m)]);
  }
  const r = cx;
  MASK["╭"] = png([line(`M${W} ${cy}H${cx + r}A${r} ${r} 0 0 0 ${cx} ${cy + r}V${H}`)]);
  MASK["╮"] = png([line(`M0 ${cy}H${cx - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}V${H}`)]);
  MASK["╯"] = png([line(`M0 ${cy}H${cx - r}A${r} ${r} 0 0 0 ${cx} ${cy - r}V0`)]);
  MASK["╰"] = png([line(`M${W} ${cy}H${cx + r}A${r} ${r} 0 0 1 ${cx} ${cy - r}V0`)]);
  for (const [ch, b] of Object.entries(BLOCKS)) MASK[ch] = png((typeof b === "string" ? [...b].map(q => Q[q]) : b).map(a => rect(...a)), true);
  // Powerline: the separators a prompt's segments are joined with.
  const P = String.fromCharCode;
  Object.assign(MASK, {
    [P(0xe0b0)]: png([fill(`M0 0L${W} ${cy}L0 ${H}Z`)]), [P(0xe0b2)]: png([fill(`M${W} 0L0 ${cy}L${W} ${H}Z`)]),
    [P(0xe0b1)]: png([line(`M0 0L${W} ${cy}L0 ${H}`)]), [P(0xe0b3)]: png([line(`M${W} 0L0 ${cy}L${W} ${H}`)]),
    [P(0xe0b4)]: png([fill(`M0 0A${W} ${cy} 0 0 1 0 ${H}Z`)]), [P(0xe0b6)]: png([fill(`M${W} 0A${W} ${cy} 0 0 0 ${W} ${H}Z`)]),
    [P(0xe0b5)]: png([line(`M0 0A${W} ${cy} 0 0 1 0 ${H}`)]), [P(0xe0b7)]: png([line(`M${W} 0A${W} ${cy} 0 0 0 ${W} ${H}`)]),
    [P(0xe0b8)]: png([fill(`M0 0L${W} ${H}H0Z`)]), [P(0xe0ba)]: png([fill(`M${W} 0V${H}H0Z`)]),
    [P(0xe0bc)]: png([fill(`M0 0H${W}L0 ${H}Z`)]), [P(0xe0be)]: png([fill(`M0 0H${W}V${H}Z`)]),
    [P(0xe0b9)]: png([line(`M0 0L${W} ${H}`)]), [P(0xe0bf)]: png([line(`M0 0L${W} ${H}`)]),
    [P(0xe0bb)]: png([line(`M${W} 0L0 ${H}`)]), [P(0xe0bd)]: png([line(`M${W} 0L0 ${H}`)]),
  });
  TINT.clear();
  for (const ch in MASK) DRAWN[ch] = MASK[ch].toDataURL("image/png");
  return Object.entries(DRAWN).map(([ch, s]) => `.pn-body .g${ch.charCodeAt(0).toString(16)}{--g:url("${s}")}`).join("\n") +
    `\n.pn-body { --cw: ${W}px; } .pn-body .x { width: ${W}px; text-align: center; } .pn-body .x.w { width: ${2 * W}px; }`;
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

// ---------- the live screen, on a canvas ----------

/* The rows a program redraws many times a second are drawn on a canvas; the
 * scrollback stays text (docs/DESK-PAINT.md, Phase 3). A row of spans in the
 * page cost a layer per drawn cell, walked by the compositor on every frame;
 * a canvas is one picture however many there are. Over it, the same rows as
 * plain text nobody sees: the browser's selection, copy on `mouseup` and the
 * caret's place are all read off that, as they were off the painted rows. */

/** A row as the text over the canvas: characters, and a character that
 *  could push the rest off the grid in a cell-wide span of its own, as
 *  `rowHtml` does. No colours and no drawn glyphs: nothing here is seen. */
function rowText(row) {
  let out = "", text = "";
  for (const c of row) {
    if (!c) continue;
    if (ownCell(c)) { out += ctx.esc(text) + `<span class="x${c[4] === 2 ? " w" : ""}">${ctx.esc(c[0])}</span>`; text = ""; continue; }
    text += c[0];
  }
  return out + ctx.esc(text);
}

/** The text catches up with the canvas once a second, not on every frame:
 *  a row rewritten in the page is a layout, and a spinner is 25 of them a
 *  second (docs/DESK-PAINT.md). A press in the pane brings it up to date
 *  first, so a selection starts on what is drawn; and it waits while a
 *  button is held, so a selection being dragged is not written over. */
const TEXT_MS = 1000;
/* A check on the canvas, off unless `snyvi.paintcheck` is "1": what each
 * cell was last drawn as, kept beside the grid, and compared with the grid
 * after every frame. The first cell that differs is logged with its row,
 * which is a row the canvas shows stale. */
const CHECK = (() => { try { return localStorage.getItem("snyvi.paintcheck") === "1"; } catch { return false; } })();
const sig = c => (c ? c.join("\u0001") : "");
function checked(v) {
  if (!v.drawn) return;
  for (let y = 0; y < v.rows; y++) {
    const row = v.cells[y], d = v.drawn[y];
    for (let x = 0; x < v.cols; x++) if (sig(row[x]) !== (d ? d[x] : sig(blankRow(1)[0]))) {
      console.warn(`[snyvi paint] pane ${v.id} row ${y} col ${x} is stale on the canvas`, row[x], d && d[x]);
      return;
    }
  }
}
function textSoon(v) {
  v.textT = 0;
  if (v.holding) { v.textT = setTimeout(() => textSoon(v), TEXT_MS); return; }
  text(v);
}
function text(v) {
  for (const y of v.stale) if (v.scr.children[y]) v.scr.children[y].innerHTML = rowText(v.cells[y]);
  v.stale.clear();
}

/** The canvas the size of the grid, in device pixels. */
function sizeCanvas(v) {
  const k = window.devicePixelRatio || 1;
  v.k = k;
  v.cv.width = Math.max(1, Math.round(v.cols * cellW * k));
  v.cv.height = Math.max(1, Math.round(v.rows * LINE_PX * k));
  v.cv.style.width = v.cols * cellW + "px";
  v.cv.style.height = v.rows * LINE_PX + "px";
  v.pal = null;
}

/** The theme, read once for a pane until it changes: the sixteen, the
 *  accent, the pane's ground and ink, and its font. Resolved on the pane,
 *  so a pane that wears its own colours is drawn in them. */
function palette(v) {
  const col = n => snyviTheme.colour(n, v.body);
  const t = [];
  for (let i = 0; i < 16; i++) t.push(col(`--t${i}`));
  v.pal = { t, accent: col("--accent"), bg: col("--pn-bg"), fg: col("--pn-fg"), font: getComputedStyle(v.body).fontFamily, fonts: new Map(), inks: new Map() };
  return v.pal;
}

/** `color`, for a canvas: the same colours, resolved -- and kept, since a
 *  row asks for every cell's, and a truecolor one is a new string each time
 *  it is worked out. The prompt's own colour is asked first, as it follows
 *  the pane being drawn and not the number. */
function ink(p, n) {
  if (!n) return "";
  if (n >= 1 << 24 && (n & 0xffffff) === born) return p.accent;
  let s = p.inks.get(n);
  if (s === undefined) {
    s = n >= 1 << 24 ? "#" + (n & 0xffffff).toString(16).padStart(6, "0") : n <= 16 ? p.t[n - 1] : color(n);
    if (p.inks.size > 4096) p.inks.clear();
    p.inks.set(n, s);
  }
  return s;
}

/** A font at a size, and where its baseline sits in a row: centred in the
 *  line as CSS centres it, by the font's own ascent and descent. */
function font(v, g, px, fl) {
  const key = `${fl & 5},${px}`;
  let f = v.pal.fonts.get(key);
  if (!f) {
    const k = v.k, css = `${fl & 4 ? "italic " : ""}${fl & 1 ? 650 : 400} ${px * k}px ${v.pal.font}`;
    g.font = css;
    // Whole pixels, as CSS lays out a line: its ascent and descent rounded,
    // and the room left over split with the odd pixel below.
    const m = g.measureText("Hg"), a = Math.round(m.fontBoundingBoxAscent ?? px * k * .8), d = Math.round(m.fontBoundingBoxDescent ?? px * k * .2);
    f = { css, base: Math.floor((LINE_PX * k - (a + d)) / 2) + a, a, d };
    v.pal.fonts.set(key, f);
  }
  g.font = f.css;
  // No kerning to work out. Ligatures are kept out by `drawRow`, which gives
  // the canvas one character at a time: WebKit's canvas has no
  // `textRendering` to turn them off with, and `=>` came out as one arrow.
  g.fontKerning = "none";
  return f;
}

/** A drawn character's mask in one colour, kept: a row that shows it again
 *  draws a picture it already has. */
function tint(ch, col) {
  const key = ch + col;
  let t = TINT.get(key);
  if (!t) {
    const m = MASK[ch];
    t = document.createElement("canvas");
    t.width = m.width; t.height = m.height;
    const c = t.getContext("2d");
    c.drawImage(m, 0, 0);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = col;
    c.fillRect(0, 0, t.width, t.height);
    if (TINT.size > 2048) TINT.clear();
    TINT.set(key, t);
  }
  return t;
}

/** One row of the grid, drawn: its grounds, then its characters, in the
 *  colours and attributes `span` gives them. Only cells `a` to `b` if that
 *  is all a frame changed -- a spinner is a cell or two -- cleared a cell
 *  wider on each side, since a glyph can reach into its neighbour (an icon,
 *  italics), and drawn from two cells further out, so what reaches back in
 *  from a neighbour is whole again. */
function drawRow(v, y, a = 0, b = v.cols) {
  const g = v.g, row = v.cells[y], p = v.pal || palette(v), k = v.k;
  const top = Math.round(y * LINE_PX * k), h = Math.round((y + 1) * LINE_PX * k) - top;
  const X = i => Math.round(i * cellW * k);
  // A cell's ink and ground, inverse swapping the two.
  const fgOf = c => (c[3] & 32 ? ink(p, c[2]) || p.bg : ink(p, c[1]) || p.fg);
  const bgOf = c => (c[3] & 32 ? ink(p, c[1]) || p.fg : ink(p, c[2]));
  const whole = a <= 0 && b >= row.length;
  const c0 = Math.max(0, a - 1), c1 = Math.min(row.length, b + 1);
  let s = Math.max(0, c0 - 2);
  while (s > 0 && !row[s]) s--;
  const e = Math.min(row.length, c1 + 2);
  if (whole) g.clearRect(0, top, v.cv.width, h);
  else { g.save(); g.beginPath(); g.rect(X(c0), top, X(c1) - X(c0), h); g.clip(); g.clearRect(X(c0), top, X(c1) - X(c0), h); }
  for (let x = s; x < e; x++) {
    const c = row[x];
    if (!c) continue;
    const b = bgOf(c);
    if (!b) continue;
    // A run of one ground is one rectangle, so no seam shows between cells.
    let n = x + c[4];
    while (n < e && (!row[n] || (bgOf(row[n]) === b && (row[n][3] & 2) === (c[3] & 2)))) n += row[n] ? row[n][4] : 1;
    g.globalAlpha = c[3] & 2 ? .6 : 1;
    g.fillStyle = b;
    g.fillRect(X(x), top, X(n) - X(x), h);
    x = n - 1;
  }
  const size = SIZES[sizeAt][1];
  for (let x = s; x < e;) {
    const c = row[x];
    if (!c) { x++; continue; }
    const f = fgOf(c), fl = c[3];
    let n = x + c[4], text = c[0];
    const own = ownCell(c);
    const same = r => r && r[4] === 1 && r[1] === c[1] && r[2] === c[2] && r[3] === fl;
    if (!own) {
      while (n < e && same(row[n]) && !ownCell(row[n])) text += row[n++][0];
    } else if (c[4] === 1 && SPAN.has(text)) {
      while (n < e && same(row[n]) && row[n][0] === text) n++;
    }
    g.globalAlpha = fl & 2 ? .6 : 1;
    if (!(fl & 64) && text.trim()) {
      if (own && MASK[text]) g.drawImage(tint(text, f), X(x), top, X(n) - X(x), h);
      else {
        const icon = own && /[\ue000-\uf8ff]/.test(text), m = font(v, g, icon ? 10 : size, fl);
        g.fillStyle = f;
        g.textAlign = "center";
        if (own) g.fillText(text, (X(x) + X(n)) / 2, top + m.base);
        // A character to a cell, each centred in its own. A run given whole
        // is spaced by the canvas's own advance, which is not the cell the
        // page measured: at 2x, or on the GPU canvas of the Linux window,
        // half a pixel short a letter. A row drifted off the grid, opened
        // gaps where the next run started on it again, and a partial redraw
        // under a typed key showed the wrong letters in its clip. (A run here
        // is one UTF-16 unit a cell: anything longer is `ownCell`.)
        else for (let i = 0; i < text.length; i++) if (text[i] !== " ") g.fillText(text[i], (X(x + i) + X(x + i + 1)) / 2, top + m.base);
        g.textAlign = "start";
      }
    }
    if (fl & 136 && !(fl & 64)) {
      const m = font(v, g, size, fl), th = Math.max(1, Math.round(k * size / 12));
      g.fillStyle = f;
      if (fl & 8) g.fillRect(X(x), Math.round(top + m.base + m.d / 3), X(n) - X(x), th);
      if (fl & 128) g.fillRect(X(x), Math.round(top + m.base - m.a * .3), X(n) - X(x), th);
    }
    x = n;
  }
  g.globalAlpha = 1;
  if (!whole) g.restore();
  if (CHECK) {
    v.drawn ||= [];
    const d = v.drawn[y] ||= Array(v.cols).fill(sig(blankRow(1)[0]));
    for (let x = whole ? 0 : c0; x < (whole ? row.length : c1); x++) d[x] = sig(row[x]);
  }
}

/** The screen scrolled `k` rows: the grid, the text over the canvas and the
 *  canvas all move up with it, the same steps as `shown` in src/screen.rs,
 *  and the frame's rows then draw only what came in at the bottom. Before
 *  this, output that scrolled redrew every row of the canvas, every frame. */
function up(v, k, inSight) {
  if (!v.rows) return;
  // The daemon never moves the whole screen, but a page that holds fewer
  // rows than it does could be told to: that is every row blank, and the
  // canvas with them, never the old paint left standing.
  if (k >= v.rows) {
    v.cells = Array.from({ length: v.rows }, () => blankRow(v.cols));
    for (let y = 0; y < v.rows; y++) v.stale.add(y);
    if (inSight) drawAll(v);
    return;
  }
  v.cells.splice(0, k);
  for (let i = 0; i < k; i++) v.cells.push(blankRow(v.cols));
  // The text moves too, unless a selection is being dragged in it: then it
  // all catches up once the button is let go, as it would anyway.
  if (v.holding) for (let y = 0; y < v.rows; y++) v.stale.add(y);
  else {
    for (let i = 0; i < k; i++) { const d = v.scr.firstElementChild; d.textContent = ""; v.scr.append(d); }
    v.stale = new Set([...v.stale].filter(y => y >= k).map(y => y - k));
  }
  if (!inSight) return;
  // Moved by a whole number of device pixels only; a row that does not
  // start on one would come out a pixel off, so that density draws whole.
  const d = k * LINE_PX * v.k, W = v.cv.width, H = v.cv.height;
  if (d !== Math.round(d)) { drawAll(v); return; }
  const g = v.g;
  g.save();
  g.globalCompositeOperation = "copy";
  g.drawImage(v.cv, 0, d, W, H - d, 0, 0, W, H - d);
  g.restore();
  g.clearRect(0, H - d, W, d);
  if (CHECK && v.drawn) { v.drawn.splice(0, k); v.drawn.length = v.rows; }
}

/** Every row again: the size, the theme, the font or the density changed. */
function drawAll(v) {
  if (!v.rows || !v.g) return;
  born = bornOf(v);
  for (let y = 0; y < v.rows; y++) drawRow(v, y);
}

/** The theme and the accent are attributes on the root (boot.js resolves
 *  "follow the system" into one): a change is every pane drawn again. A font
 *  the page was still fetching when the cell was measured is a cell of
 *  another width once it lands: that is a measure again, which draws again. */
let lookWatch = null;
function watchLook() {
  if (lookWatch) return;
  lookWatch = new MutationObserver(() => { for (const v of views.values()) { v.pal = null; drawAll(v); } });
  lookWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  document.fonts?.addEventListener("loadingdone", () => { if (ctx) remeasure(); });
}
