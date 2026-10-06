/* ui/desk/04-keys-pane.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
// ---------- keys ----------

const CUR = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const SS3 = { F1: "P", F2: "Q", F3: "R", F4: "S" };
const CTRL = { " ": 0, "@": 0, "2": 0, "[": 27, "3": 27, "\\": 28, "4": 28, "]": 29, "5": 29, "^": 30, "6": 30, "_": 31, "7": 31, "-": 31, "/": 31, "?": 127, "8": 127 };

/** What a key sends to a program, as xterm sends it. `null` for a key this
 *  leaves to the page: the platform's own shortcuts, and the two snyvi keeps. */
function keyBytes(e, appCursor) {
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
 *  bytes for a pane are made, and every caller is a key, a paste, or the
 *  reader's own click putting their points in (`put`) -- a paste by another
 *  hand, and never anything snyvi received. */
function input(v, text) {
  if (!v.status.running || !text) return;
  say({ t: "in", p: v.id, d: text });
  // Typing brings a reader scrolled up back down. One at the bottom already
  // is left alone: reading the height was a layout forced on every key.
  if (!v.pinned) { v.pinned = true; v.body.scrollTop = v.body.scrollHeight; }
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
  el.innerHTML = `<header class="pn-head"><span class="pn-slot"></span><span class="pn-cmd"></span><span class="pn-git"></span><span class="pn-ctx"></span><span class="pn-state"></span><button type="button" class="pn-ren" data-tip="Rename panel" data-key="f2" aria-label="Rename this panel">${ctx.glyph("pen")}</button><button type="button" class="pn-full" data-tip="Full view" data-key="ctrl+alt+z" aria-label="Full view">${ctx.glyph("fill")}</button><button type="button" class="pn-x" data-tip="Close panel" data-tip-sub="asks first · Undo for 8 s" aria-label="Close this panel">${ctx.glyph("x")}</button></header>` +
    `<div class="pn-body" tabindex="0" role="region" aria-label="Panel ${p.slot}"><div class="pn-old"></div><div class="pn-sb"></div><div class="pn-live"><canvas class="pn-cv"></canvas><div class="pn-scr"></div><i class="pn-caret" hidden></i></div></div>` +
    `<div class="pn-offer" hidden role="status"><span>Claude was open here when snyvi stopped</span><button type="button" data-offer="go">↻ Resume conversation</button><button type="button" data-offer="x" data-tip="Not now" aria-label="Not now">✕</button></div>` +
    `<div class="pn-connect" hidden role="status"></div>` +
    `<form class="pn-start" hidden><button type="submit">▶ Start</button><input spellcheck="false" autocomplete="off" aria-label="Command to run"><button type="button" class="pn-resume" hidden data-tip="Resume conversation" data-tip-sub="claude --resume, the one this panel last had">↻ Resume conversation</button></form>`;
  // A new project desk's first panel, holding `claude` for the reader's Enter.
  const first = !!(ctx.held && ctx.held.delete(p.id));
  const kept = keepStopped.delete(p.id) || first;
  const v = {
    id: p.id, pane: p, el, status: p.status || {}, cols: 0, rows: 0, cells: [], cur: [0, 0, 0], mode: [0, 0, 0, 0], wheelAcc: 0, asked: false,
    // A pane with no process and no exit code lost its shell to a daemon that
    // went away: it will start itself, so it does not flash the Start bar on
    // the way there. `resumed` is one attempt, per daemon. One brought back
    // by Undo is not one of those: it waits for Start.
    resumed: kept, starting: false, resuming: !kept && !(p.status && (p.status.running || p.status.exit != null)),
    body: el.querySelector(".pn-body"), old: el.querySelector(".pn-old"), sb: el.querySelector(".pn-sb"), scr: el.querySelector(".pn-scr"),
    caret: el.querySelector(".pn-caret"), cv: el.querySelector(".pn-cv"), pal: null, stale: new Set(), textT: 0, holding: false, start: el.querySelector(".pn-start"), size: "",
    pinned: true,   // at the bottom, so new lines keep it there
    // The last daemon stopped with Claude open here: offered back once, by
    // the strip, until it is taken, put away, or the reader types.
    offered: !!(p.status && p.status.offer),
  };
  const { body, start } = v;
  // Chunks within a screen of the view, either way, are kept in the document.
  v.io = new IntersectionObserver(e => reach(v, e), { root: body, rootMargin: "100% 0px" });
  if (first) firstPanel(v);
  v.g = v.cv.getContext("2d");
  watchLook();

  // Read where the reader is when they scroll, not on every frame: a read
  // there is a layout forced once per frame per pane (docs/DESK-PAINT.md).
  body.addEventListener("scroll", () => { v.pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 4; }, { passive: true });
  body.addEventListener("focus", () => { focused = v.id; el.classList.add("on"); rail(); });
  body.addEventListener("blur", () => el.classList.remove("on"));
  const hd = el.querySelector(".pn-head");
  hd.addEventListener("click", e => {
    if (e.target.closest(".pn-full")) { focused = v.id; zoom(); return; }
    if (e.target.closest(".pn-ren")) { renamePanel(v); return; }
    const x = e.target.closest(".pn-x");
    if (x) { closeAsked(v, x); return; }
    if (!v.dragged) body.focus();
    v.dragged = false;
  });
  // A double-click on the head, not the body: there it selects a word.
  hd.addEventListener("dblclick", e => { if (!e.target.closest(".pn-full, .pn-ren, .pn-x")) { focused = v.id; zoom(); } });
  hd.addEventListener("pointerdown", e => drag(v, e));
  body.addEventListener("keydown", e => {
    // The platform's (⌘C, ⌘V, ⌘K), and snyvi's own: the swap, the pane keys
    // and the zoom.
    if (e.metaKey || (e.ctrlKey && e.key === "`") || (e.ctrlKey && e.altKey && !altGr(e) && /^(Digit[1-4]|Key[ZNWR]|Bracket(Left|Right))$/.test(e.code))) return;
    // Ctrl+Shift+C and V are copy and paste in a Linux terminal; V lets the
    // browser's own paste event through.
    if (e.ctrlKey && e.shiftKey && /^[cv]$/i.test(e.key)) { if (/c/i.test(e.key)) copy(v, true); return; }
    // ⌃= ⌃- ⌃0: the text size, as a terminal does it. ⌃- sent ^_, which is
    // undo to readline and zsh -- as in GNOME Terminal, undo is still ⌃_.
    if (e.ctrlKey && !e.altKey && /^[-=+0]$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      textSize(e.key === "0" ? 0 : e.key === "-" ? -1 : 1);
      if (ctx.sized) ctx.sized();
      return;
    }
    if (e.isComposing || e.key === "Dead" || e.key === "Process") return;
    if (e.key === "Control" && v.at) hover(v, v.at);
    // A plain ⌃V goes down as ^V, and Claude Code reads a picture off the
    // clipboard itself on it: the window's own picture paste stands aside.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") v.ctrlV = Date.now();
    const b = keyBytes(e, v.mode[0]);
    if (b == null) return;
    e.preventDefault(); e.stopPropagation();
    v.typed = Date.now();
    if (v.offered) { v.offered = false; header(v); }
    input(v, b);
  });
  // Copy on selection: the scrollback is text in the page, so the browser
  // selects it, and letting go is the copy.
  body.addEventListener("mousedown", e => { v.down = [e.clientX, e.clientY]; text(v); v.holding = true; addEventListener("mouseup", () => { v.holding = false; }, { once: true }); });
  body.addEventListener("mouseup", e => {
    // Ctrl-click on a link opens it, and only that: a plain click never does,
    // and neither does a press that travelled or left a selection. A path is
    // opened only once the daemon has said it is there -- the underline.
    const still = v.down && Math.hypot(e.clientX - v.down[0], e.clientY - v.down[1]) < 4;
    if (e.button === 0 && e.ctrlKey && still && getSelection().isCollapsed) {
      const l = linkAt(v, e);
      if (l && !l.path) { openLink(l.url); return; }
      if (l && found(v, l.path)) { P.open(fromPane(v), l.path); hover(v, null); return; }
    }
    setTimeout(() => copy(v, false), 0);
  });
  // Held Ctrl shows the link under the pointer, underlined, as a terminal does.
  body.addEventListener("mousemove", e => { v.at = e; hover(v, e.ctrlKey ? e : null); });
  body.addEventListener("mouseleave", () => { v.at = null; hover(v, null); });
  body.addEventListener("keyup", e => { if (e.key === "Control") hover(v, null); });
  body.addEventListener("wheel", e => wheel(v, e), { passive: false });
  body.addEventListener("paste", e => { e.preventDefault(); paste(v, e.clipboardData); });
  start.addEventListener("submit", e => { e.preventDefault(); run(v, start.querySelector("input").value); });
  start.querySelector("input").addEventListener("keydown", e => e.stopPropagation());
  start.querySelector(".pn-resume").addEventListener("click", () => run(v, "", false, true));
  // The offer types `claude --resume <id>` at the prompt, without Enter (`again`),
  // in the folder the shell came back in. Nothing is typed until it is clicked.
  el.querySelector(".pn-offer").addEventListener("click", e => {
    const b = e.target.closest("[data-offer]");
    if (!b) return;
    v.offered = false; header(v);
    if (b.dataset.offer === "go") again(v); else body.focus();
  });
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
  v.typed = Date.now();
  const img = [...data.items].find(i => i.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(i.type));
  if (img) {
    const blob = img.getAsFile();
    try {
      const j = await ctx.api(`/api/panes/${v.id}/paste`, blob, blob.type);
      input(v, bracket(v, j.path));
      ctx.toast("Pasted as a document", j.path);
    } catch (e) { ctx.toast("Could not paste the image", e); }
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
  // Whole rows only: what is left of the height below the last one goes to
  // the bottom padding, with the top padding's 4 px, so a view kept at the
  // bottom starts on a whole row and not on a sliver of scrollback cut under
  // the head. Padding is inside the box, so the height measured above does
  // not change with it.
  const left = h - r * LINE_PX;
  if (v.left !== left) {
    v.left = left;
    v.body.style.paddingBottom = 8 + left + "px";
    if (v.pinned) v.body.scrollTop = v.body.scrollHeight;
  }
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
 *  because what to do next is a question only the reader can answer.
 *
 *  A daemon that went on purpose -- `snyvi restart`, an update -- marks the
 *  panes an agent was in, and the status that says the pane lost its process
 *  says `resume` too: that one comes back as the conversation, the way the
 *  ↻ button brings it, rather than as the shell. One that went without
 *  planning to -- `snyvi stop`, a signal, a reboot -- says `offer`: the shell
 *  comes back in the folder it was in, and the strip over it offers the
 *  conversation with one click, which types the resume and never runs it. */
function resume(v) {
  if (v.resumed || v.starting || !v.size) return;
  if (v.status.running || v.status.exit != null) {
    if (v.resuming) { v.resuming = false; header(v); }
    return;
  }
  run(v, v.status.cmd || v.pane.cmd || "", true, !!v.status.resume);
}

/** The accent this window wears, as CSS resolved it, for the prompt the shell
 *  is dressed in. The shell bakes it in at birth and cannot be told again --
 *  the page re-tints instead, in `color`, so a swatch reaches a pane that is
 *  already running. */
function accent() {
  // Resolved through boot.js rather than read as text: on :root the token is
  // a light-dark() expression, and the prompt wants six hex digits, which is
  // how boot.js says an opaque colour.
  const c = snyviTheme.colour("--accent");
  return /^#[0-9a-f]{6}$/i.test(c) ? c : "";
}

async function run(v, cmd, quiet, again) {
  if (v.starting) return;
  v.starting = true;
  v.resumed = true;
  let shell = false;
  const [c, r] = v.size ? v.size.split("x").map(Number) : [80, 24];
  try {
    // `again` resumes the conversation the pane kept; the daemon builds that
    // command from the id it holds, and what Start re-runs stays as it was.
    // A quiet `again` is this page's own resume after a restart (`marked`):
    // the daemon holds to it only while the mark does, and past it starts
    // `cmd` with the conversation offered -- a panel unshown for minutes.
    const was = document.activeElement;
    const j = await ctx.api(`/api/panes/${v.id}/start`, again ? { resume: true, marked: !!quiet, cmd, cols: c, rows: r, accent: accent() } : { cmd, cols: c, rows: r, accent: accent() });
    v.status = j.status;
    // The panel takes the keys -- unless the reader went somewhere else, a
    // note, a name, while the daemon was starting it.
    if (!quiet && (document.activeElement === was || document.activeElement === document.body)) v.body.focus();
  } catch (e) {
    // A conversation the daemon no longer has an id for -- the mark outlived
    // it -- is not worth a word: the shell is what the pane gets instead.
    if (again && quiet && /no conversation/i.test(String(e))) shell = true;
    // Two windows on one desk both resume it, and the one that loses is told
    // "already running" -- which is the outcome it wanted. Anything else is
    // worth saying, even for a start nobody asked for: the folder may be gone.
    else if (!quiet || !/already running/i.test(String(e))) ctx.toast("Could not start the panel", e);
  } finally {
    v.starting = false;
    v.resuming = false;
    header(v);
  }
  if (shell) return run(v, cmd, quiet, false);
}

/** A folder under the home folder as `~` and the rest: app.js's, which
 *  knows Windows' spellings of one folder. */
const tilde = p => ctx.tilde(p);
const what = v => v.pane.name || v.status.title || v.status.cmd || v.pane.cmd || "shell";
/** How full the agent's context window is, as its status line last said:
 *  quiet under 70%, and the waiting amber from 85%, where Claude Code
 *  itself starts to warn. Nothing at all for a shell. */
const ctxPct = s => (s && s.ctx_pct != null ? s.ctx_pct : null);
const ctxCls = p => (p >= 85 ? "ctx hot" : p >= 70 ? "ctx warm" : "ctx");
const kTok = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
/** The tokens in the window now: the daemon's exact count, or worked out
 *  from the % for a daemon or a status line older than `ctx_used`. */
const ctxUsed = s => s.ctx_used ?? (s.ctx_pct != null && s.ctx_size ? Math.round(s.ctx_pct * s.ctx_size / 100) : null);
/** "92k / 1M"; "— / 1M" before the first reply and just after /compact,
 *  when there is no count yet rather than an old one. */
const ctxFig = s => { const u = ctxUsed(s); return s.ctx_size ? `${u == null ? "—" : kTok(u)} / ${kTok(s.ctx_size)}` : `${s.ctx_pct}%`; };
const ctxTip = s => `${s.model ? s.model + " · " : ""}${ctxFig(s)} in its context window · ${s.ctx_pct}%`;
/** The conversation this pane last had, when there is one and Claude is not
 *  in the pane now. Checked here too: it is about to be a command line. */
/** Who sent a document on the rail: the panel in that slot by the name it
 *  holds still under, or the slot alone once the panel is gone. */
const sentBy = (vs, slot) => {
  const v = vs.find(x => x.pane.slot === slot);
  if (!v) return `[${slot}]`;
  // What sends documents is an agent: a panel that has had a conversation
  // says so, even while its shell is back at the prompt.
  const agent = v.status.agent || v.pane.agent_session ? "claude" : "";
  return `[${slot}] ${v.pane.name || agent || v.status.cmd || v.pane.cmd || "shell"}`;
};
const talked = v => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.pane.agent_session || "") && !v.status.agent ? v.pane.agent_session : "";
/** The resume command without its id, `claude --resume`, as a tip says it.
 *  The daemon names it (`agents::resume_cmd`); the page only quotes it. */
const resumeWord = v => (v.pane.resume || "").replace(/ \S+$/, "");

/** The desk's live region (`.dk-live`, polite): one line at a time, and the
 *  same line said twice is cleared first so it is read twice. */
function announce(text) {
  const el = ctx.docEl.querySelector(".dk-live");
  if (el) { el.textContent = ""; el.textContent = text; }
}

function header(v) {
  const s = v.status, $ = q => v.el.querySelector(q);
  const sl = $(".pn-slot");
  if (sl.textContent !== `[${v.pane.slot}]`) { sl.textContent = `[${v.pane.slot}]`; sl.dataset.tip = `Panel ${v.pane.slot}`; sl.dataset.key = `ctrl+alt+${v.pane.slot}`; }
  const c = $(".pn-cmd");
  // Its title as the rail writes it: Claude Code puts its spinner's frame at
  // the front (◑, ✳), and the state beside it already says it is working.
  if (c) { c.textContent = short(v); v.pane.name && v.status.title ? (c.dataset.tip = v.status.title) : delete c.dataset.tip; }
  // The branch and whether the tree is modified: snyvi's own answer, not the
  // prompt's, so a pane whose shell it cannot dress says both too.
  $(".pn-git").textContent = s.branch ? s.branch + (s.dirty ? "*" : "") : "";
  // An agent that reports through its hooks (Claude Code) says what it is
  // doing; anything else is only running, ringing, or ended.
  // The context window, in the header only once it is filling (70%): its
  // place is kept for as long as an agent is in the pane, so the figure
  // coming in moves nothing beside it. The meta line has it always.
  const cp = ctxPct(s), cx = $(".pn-ctx");
  cx.textContent = cp == null || cp < 70 ? "" : ctxFig(s);
  cx.className = "pn-ctx " + (cp == null ? "" : "kept " + ctxCls(cp));
  if (cp == null) delete cx.dataset.tip; else cx.dataset.tip = ctxTip(s);
  if (s.agent) heardFrom(v);
  $(".pn-state").textContent = s.agent === "needs_you" ? "! needs you" : s.blocked ? "! waiting on you" : s.agent === "working" ? "● working" : s.agent === "done" ? "✓ done" : s.running ? "● running" : s.exit != null ? `exited ${s.exit}` : "○ stopped";
  // Said once, to a reader who cannot see the dot: a panel that needs the
  // reader, or has finished. Working and running are the quiet states.
  const word = s.agent === "needs_you" || s.blocked ? "needs you" : s.agent === "done" ? "done" : "";
  if (word && v.said !== word) announce(`Panel ${v.pane.slot}${v.pane.name ? ` (${v.pane.name})` : ""} ${word}`);
  v.said = word;
  v.el.classList.toggle("blk", !!s.blocked);
  v.el.classList.toggle("done", s.agent === "done");
  v.el.classList.toggle("off", !s.running);
  // Ended: the last screen stays, greyed by .off, and Start sits over it with
  // what was run last already typed. A pane on its way back from a daemon
  // restart is not ended, and shows nothing.
  const wasHidden = v.start.hidden;
  v.start.hidden = !!s.running || v.resuming || v.starting;
  if (!v.start.hidden && wasHidden) v.start.querySelector("input").value = s.cmd || v.pane.cmd || "";
  v.start.querySelector("input").placeholder = "blank for the shell";
  const again = v.start.querySelector(".pn-resume");
  again.hidden = !talked(v);
  if (talked(v)) again.dataset.tipSub = `${resumeWord(v)}, the one this panel last had`;
  if (s.offer) v.offered = true;
  const off = v.el.querySelector(".pn-offer");
  if (off) off.hidden = !(v.offered && talked(v) && s.running);
  cursor(v);
}

/** The first panel of a new project desk: `claude` in its Start field, the
 *  field focused so Enter runs it -- and, when Claude Code is not set up for
 *  snyvi yet, one strip above it that connects it first. A session started
 *  before that could never see snyvi. */
async function firstPanel(v) {
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!v.start.hidden) v.start.querySelector("input").focus(); }));
  let a;
  try { a = await (await fetch("/api/agents")).json(); } catch { return; }
  const row = a.rows.find(r => r.id === "claude");
  if (!row || row.state === "connected" || !ctx.connect) return;
  const strip = v.el.querySelector(".pn-connect");
  strip.innerHTML = `<p>snyvi isn't connected to Claude Code yet. Connect it first, so what Claude writes lands here.</p><div class="w-connect"><button type="button" class="w-btn">Connect</button></div>`;
  strip.hidden = false;
  strip.querySelector("button").addEventListener("click", e => {
    ctx.connect(e.currentTarget, (_, ok) => { if (ok) setTimeout(() => { strip.hidden = true; v.start.querySelector("input").focus(); }, 2400); });
  });
}

/** The first time a hook is heard from any panel, that panel says so, once,
 *  in its own place: Claude and snyvi are talking. */
function heardFrom(v) {
  try { if (localStorage.getItem("snyvi.seen.hooked")) return; localStorage.setItem("snyvi.seen.hooked", "1"); } catch { return; }
  const strip = v.el.querySelector(".pn-connect");
  strip.innerHTML = `<p class="ok">Claude is connected here. What it sends lands on this desk's rail.</p>`;
  strip.hidden = false;
  setTimeout(() => { strip.hidden = true; }, 6000);
}
