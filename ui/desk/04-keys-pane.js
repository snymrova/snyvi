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
  el.innerHTML = `<header class="pn-head"><span class="pn-slot"></span><span class="pn-cmd"></span><span class="pn-acc"></span><span class="pn-git"></span><span class="pn-ctx"></span><a class="pn-page" hidden></a><span class="pn-state"></span><button type="button" class="pn-ren" data-tip="Rename panel" data-key="f2" aria-label="Rename this panel">${ctx.glyph("pen")}</button><button type="button" class="pn-full" data-tip="Full view" data-key="ctrl+alt+z" aria-label="Full view">${ctx.glyph("fill")}</button><button type="button" class="pn-x" data-tip="Close panel" data-tip-sub="asks first · Undo for 8 s" aria-label="Close this panel">${ctx.glyph("x")}</button></header>` +
    `<div class="pn-body" tabindex="0" role="region" aria-label="Panel ${p.slot}"><div class="pn-old"></div><div class="pn-sb"></div><div class="pn-live"><canvas class="pn-cv"></canvas><div class="pn-scr"></div><i class="pn-caret" hidden></i></div></div>` +
    `<div class="pn-offer" hidden role="status"><span>${OFFER_SAYS}</span><button type="button" data-offer="go">↻ Resume conversation</button><button type="button" data-offer="x" data-tip="Not now" aria-label="Not now">✕</button></div>` +
    `<div class="pn-switch" hidden role="status"><span></span></div>` +
    `<div class="pn-connect" hidden role="status"></div>` +
    `<form class="pn-start" hidden><button type="submit">▶ Start</button><input spellcheck="false" autocomplete="off" aria-label="Command to run"><button type="button" class="pn-resume" hidden data-tip="Resume conversation" data-tip-sub="claude --resume, the one this panel last had">↻ Resume conversation</button></form>`;
  // A new project desk's first panel, holding `claude` for the reader's
  // press. The daemon keeps the hold (`Pane::held`), so it is held on every
  // load and in every window, never resumed, until a Start ends it.
  const first = !!p.held;
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
  claudeStrip(v, first);
  v.g = v.cv.getContext("2d");
  watchLook();

  // Read where the reader is when they scroll, not on every frame: a read
  // there is a layout forced once per frame per pane (docs/DESK-PAINT.md).
  body.addEventListener("scroll", () => { v.pinned = body.scrollTop + body.clientHeight >= body.scrollHeight - 4; }, { passive: true });
  body.addEventListener("focus", () => { focused = v.id; el.classList.add("on"); rail(); });
  body.addEventListener("blur", () => el.classList.remove("on"));
  const hd = el.querySelector(".pn-head");
  hd.addEventListener("click", e => {
    // The page this panel sent and the reader has not opened (rail.js `pageChips`).
    const pg = e.target.closest(".pn-page");
    if (pg) { e.preventDefault(); ctx.read(pg.dataset.read); return; }
    if (e.target.closest(".pn-full")) { focused = v.id; zoom(); return; }
    if (e.target.closest(".pn-ren")) { renamePanel(v); return; }
    const x = e.target.closest(".pn-x");
    if (x) { closeAsked(v, x); return; }
    if (!v.dragged) body.focus();
    v.dragged = false;
  });
  // A double-click on the head, not the body: there it selects a word.
  hd.addEventListener("dblclick", e => { if (!e.target.closest(".pn-full, .pn-ren, .pn-x, .pn-page")) { focused = v.id; zoom(); } });
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
    // clipboard itself on it: the window's own picture paste stands aside. On
    // Windows it is paste, as in Windows Terminal (Claude there takes Alt+V): the
    // paste event comes through and a picture goes in as a document, path typed.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyV") { if (document.documentElement.dataset.os === "win") return; v.ctrlV = Date.now(); }
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
  dropOn(v);
  start.addEventListener("submit", e => { e.preventDefault(); run(v, start.querySelector("input").value); });
  start.querySelector("input").addEventListener("keydown", e => e.stopPropagation());
  start.querySelector(".pn-resume").addEventListener("click", () => run(v, "", false, true));
  el.querySelector(".pn-offer").addEventListener("click", e => offerClick(v, e));
  el.querySelector(".pn-switch").addEventListener("click", e => switchClick(v, e));
  new ResizeObserver(() => fit(v)).observe(body);
  header(v);
  return v;
}

/** The offer runs `claude --resume <id>` at the prompt of the shell the pane
 *  came back as, in its folder. Nothing is typed until it is clicked, and a
 *  click that cannot go says why in the strip, which stays (#108). */
function offerClick(v, e) {
  const b = e.target.closest("[data-offer]");
  if (!b || b.disabled) return;
  if (b.dataset.offer === "go") {
    // A shell still on its way to its prompt is waited for, not refused:
    // a click that only said "not at a prompt" was a dead end (audit
    // 2dbcf2e538).
    if (v.status.running && !v.mode[1]) return offerWait(v);
    const why = resumeHere(v, true);
    if (why) { offerSay(v, why); return; }
  } else if (b.dataset.offer === "restart") offerRestart(v);
  else { offerStop(v); v.body.focus(); }
  v.offered = false; v.offerSpent = true; header(v);
}

/** A picture dropped on a panel goes in as a pasted one does. Only files are
 *  taken: a drag of text or a link from the page is left alone. */
function dropOn(v) {
  const files = e => e.dataTransfer?.types.includes("Files");
  v.body.addEventListener("dragover", e => {
    if (!files(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = v.status.running ? "copy" : "none";
  });
  v.body.addEventListener("drop", e => {
    if (!files(e)) return;
    e.preventDefault();
    if (![...e.dataTransfer.items].some(i => i.kind === "file" && /^image\/(png|jpeg|gif|webp)$/.test(i.type))) { ctx.toast("Only a picture can be dropped on a panel", "PNG, JPEG, GIF or WebP"); return; }
    v.body.focus();
    paste(v, e.dataTransfer);
  });
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
      ctx.toast("Pasted", j.path);
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
 *  comes back in the folder it was in -- the daemon starts the shell, not
 *  what the pane ran, for a pane on offer -- and the strip over it offers
 *  the conversation with one click, which runs the resume there (#108). */
function resume(v) {
  if (v.resumed || v.starting || !v.size) return;
  if (v.status.running || v.status.exit != null) {
    if (v.resuming) { v.resuming = false; header(v); }
    return;
  }
  run(v, v.status.cmd || v.pane.cmd || "", true, !!v.status.resume);
}

/** What the strip over a pane says, and for five seconds instead of it
 *  whatever kept its button from going. */
const OFFER_SAYS = "Claude was open here when snyvi stopped";
function offerSay(v, why) {
  const t = v.el.querySelector(".pn-offer > span");
  if (!t) return;
  t.textContent = why;
  t.classList.add("why");
  clearTimeout(v.offerTimer);
  v.offerTimer = setTimeout(() => { t.textContent = OFFER_SAYS; t.classList.remove("why"); }, 5000);
}

/** The strip's Resume on a shell that is not at its prompt yet -- its rc
 *  still loading, an instant prompt not yet live -- waits for it, as long as
 *  OFFER_WAIT_MS, and then types the resume as a ready shell gets it. Past
 *  that, something else holds the panel, and the strip offers the one thing
 *  that still goes: the panel restarted straight into the conversation. */
const OFFER_WAIT_MS = 8000;
function offerWait(v) {
  offerStop(v);
  const t = v.el.querySelector(".pn-offer > span"), go = v.el.querySelector(".pn-offer [data-offer]");
  t.textContent = "Waiting for the shell's prompt…";
  go.disabled = true;
  const at = Date.now();
  v.offerWait = setInterval(() => {
    if (v.mode[1]) {
      offerStop(v);
      const why = resumeHere(v, true);
      if (why) offerSay(v, why); else { v.offered = false; v.offerSpent = true; header(v); }
    } else if (Date.now() - at > OFFER_WAIT_MS) {
      offerStop(v);
      t.textContent = `Something is running in panel ${v.pane.slot}`;
      t.classList.add("why");
      go.dataset.offer = "restart";
      go.textContent = "↻ Restart into the conversation";
      go.dataset.tip = "Stops what is running here";
    }
  }, 200);
}

/** The strip back as it was: no wait, Resume its button, its own line. */
function offerStop(v) {
  clearInterval(v.offerWait);
  v.offerWait = 0;
  const t = v.el.querySelector(".pn-offer > span"), go = v.el.querySelector(".pn-offer [data-offer]");
  if (!t || !go) return;
  clearTimeout(v.offerTimer);
  t.textContent = OFFER_SAYS;
  t.classList.remove("why");
  go.disabled = false;
  go.dataset.offer = "go";
  go.textContent = "↻ Resume conversation";
  delete go.dataset.tip;
}

/** Stop the panel and start it as its conversation, as a stopped panel's
 *  Resume does; the start waits on the stop (`onStop`, 02-socket.js). */
function offerRestart(v) {
  offerStop(v);
  v.onStop = () => run(v, v.status.cmd || v.pane.cmd || "", false, true);
  ctx.api(`/api/panes/${v.id}/stop`, {}).catch(e => { v.onStop = null; ctx.toast("Could not restart the panel", e); });
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

async function run(v, cmd, quiet, again, once) {
  if (v.starting) return;
  v.starting = true;
  unready(v);
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
    const j = await ctx.api(`/api/panes/${v.id}/start`, { ...(again ? { resume: true } : {}), ...(once ? { once: true } : {}), marked: !!quiet, cmd, cols: c, rows: r, accent: accent() });
    v.status = j.status;
    // The account picked is not the one running: its token is gone, or a
    // key Claude Code ranks above it is set.
    if (j.account_missing) ctx.toast(`Panel ${v.pane.slot} started as your login`, "its account's token is missing: add it again in Keys");
    else if (j.outranked) ctx.toast(`Panel ${v.pane.slot} runs on ${j.outranked[0]}`, "Claude Code takes that over the account picked");
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
/** Account `account`'s window `k` (five_hour, seven_day): the freshest of
 *  what the daemon last heard from it anywhere and what this desk's panels
 *  running as it say (#107). The windows are the account's, so a panel on
 *  another account says nothing about them; and within a window the share
 *  used only grows, so the latest window's highest share is the newest
 *  reading, with no clock to compare. */
const windowOf = (account, k) => {
  let b = (ctx.desks.quotas || {})[account]?.[k] || null;
  for (const v of views.values()) {
    const l = v.status && (v.status.account || 0) === account && v.status[k];
    if (l && (!b || l.resets_at > b.resets_at || (l.resets_at === b.resets_at && l.used > b.used))) b = l;
  }
  return b;
};
/** What is left of a window, as Home's bars say it: one past its reset is
 *  full again until a Claude answers and a new reading comes. */
const leftOf = l => (l.resets_at <= Date.now() / 1000 ? 100 : Math.round(100 - Math.max(0, Math.min(100, l.used))));
/** When a window resets, as the hover says it: in minutes or hours inside
 *  a day, and past that the day and the time -- "resets Mon 9:30" -- since
 *  "in 70 h" is a sum to do. Nothing for one already past. */
function resetsIn(l) {
  const s = l.resets_at - Date.now() / 1000;
  if (s <= 0) return "";
  if (s < 3600) return ` · resets in ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return ` · resets in ${Math.round(s / 3600)} h`;
  const at = new Date(l.resets_at * 1000);
  return ` · resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
/** "Usage left: 5 h 62% · resets in 2 h · 7 d 80% · resets Mon 9:30", the
 *  context hover's second line, for the panel's own account; nothing for an
 *  account Claude Code gives no windows to. */
function usageSub(account) {
  const f = windowOf(account, "five_hour"), w = windowOf(account, "seven_day");
  if (!f && !w) return "";
  return "Usage left: " + [f ? `5 h ${leftOf(f)}%${resetsIn(f)}` : "", w ? `7 d ${leftOf(w)}%${resetsIn(w)}` : ""].filter(Boolean).join(" · ");
}
/** The second line on every panel head's context figure: a reading from
 *  one panel is news for every panel on the same account. Written only
 *  where it differs. */
function paintUsage() {
  const subs = new Map();
  for (const v of views.values()) {
    const id = accountOf(v).id;
    if (!subs.has(id)) subs.set(id, usageSub(id));
    const sub = subs.get(id);
    const cx = v.el && v.el.querySelector(".pn-ctx"), on = sub && ctxPct(v.status) != null ? sub : "";
    if (!cx || (cx.dataset.tipSub || "") === on) continue;
    if (on) cx.dataset.tipSub = on; else delete cx.dataset.tipSub;
  }
}
/** The conversation this pane last had, when there is one and Claude is not
 *  in the pane now. Checked here too: it is about to be a command line. */
/** Who sent a document on the rail: the panel in that slot by the name it
 *  holds still under, or the slot alone once the panel is gone. */
const sentBy = (vs, slot) => {
  // Slot 0: sent from the desk's folder outside its panels (Claude in the
  // reader's own terminal), or by a panel since closed.
  if (!slot) return "this desk's folder";
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

/** The account a panel is on (`crate::accounts`), as `{ id, label }`. A
 *  running panel whose account was taken away still holds its token, and
 *  is that, not your login. */
function accountOf(v) {
  const id = v.status.running ? v.status.account || 0 : v.pane.account ?? current()?.account ?? 0;
  return accounts().find(a => a.id === id) || { id, label: "a removed account", removed: true };
}

function header(v) {
  const s = v.status, $ = q => v.el.querySelector(q);
  const sl = $(".pn-slot");
  if (sl.textContent !== `[${v.pane.slot}]`) { sl.textContent = `[${v.pane.slot}]`; sl.dataset.key = `ctrl+alt+${v.pane.slot}`; }
  // Which Claude account, once there is more than one: what a running panel
  // started as, or what a stopped one will start as.
  const acc = (ctx.desks.accounts || []).length || accountOf(v).removed ? accountOf(v) : null;
  // What the rail's foot used to say of the focused panel and nowhere else
  // (1.43): its model, its pid, and the folder its shell moved to.
  const here = s.cwd || v.pane.cwd, d = current();
  const st = [`Panel ${v.pane.slot}`, s.model, acc && `Claude as ${acc.label}`, s.running && s.pid && `pid ${s.pid}`].filter(Boolean).join(" · ");
  if (sl.dataset.tip !== st) sl.dataset.tip = st;
  const away = here && d && here !== d.root ? `In ${tilde(here)}` : "";
  if ((sl.dataset.tipSub || "") !== away) { if (away) sl.dataset.tipSub = away; else delete sl.dataset.tipSub; }
  // And in the head itself, beside the command, once the panel is not on
  // your login or its desk is not: a tip was the only place it was said.
  const pa = $(".pn-acc"), says = acc && (acc.id || current()?.account) ? acc.label : "";
  if (pa.textContent !== says) pa.textContent = says;
  const c = $(".pn-cmd");
  // Its title as the rail writes it: Claude Code puts its spinner's frame at
  // the front (◑, ✳), and the state beside it already says it is working.
  // Each field is written only when it differs, as the slot is: the header
  // is drawn on every status the socket brings, and a write that changes
  // nothing still costs the browser a style and a layout.
  const put = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const tipOf = (el, tip) => { if (!el) return; if (tip) { if (el.dataset.tip !== tip) el.dataset.tip = tip; } else if (el.dataset.tip !== undefined) delete el.dataset.tip; };
  if (c) { put(c, short(v)); tipOf(c, v.pane.name && v.status.title ? v.status.title : ""); }
  // The branch and whether the tree is modified: snyvi's own answer, not the
  // prompt's, so a pane whose shell it cannot dress says both too.
  put($(".pn-git"), s.branch ? s.branch + (s.dirty ? "*" : "") : "");
  // An agent that reports through its hooks (Claude Code) says what it is
  // doing; anything else is only running, ringing, or ended.
  // The context window, in the header only once it is filling (70%): its
  // place is kept for as long as an agent is in the pane, so the figure
  // coming in moves nothing beside it. The meta line has it always.
  const cp = ctxPct(s), cx = $(".pn-ctx");
  put(cx, cp == null || cp < 70 ? "" : ctxFig(s));
  const cls = "pn-ctx " + (cp == null ? "" : "kept " + ctxCls(cp));
  if (cx.className !== cls) cx.className = cls;
  tipOf(cx, cp == null ? "" : ctxTip(s));
  paintUsage();
  if (s.agent) heardFrom(v);
  put($(".pn-state"), v.switching ? `↻ as ${v.switching}…` : s.agent === "needs_you" ? "! needs you" : s.blocked ? "! needs you" : s.agent === "working" ? "● working" : s.agent === "done" ? "✓ done" : s.running ? "● running" : s.exit != null ? `exited ${s.exit}` : v.pane.held ? "○ ready" : "○ stopped");
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
  // The status keeps saying `offer` for the whole life of the shell it came
  // back as, so the strip cannot wait on it to go: Claude opened in the panel
  // by any road -- typed by hand, the rail's ↻, the strip itself -- has spent
  // the offer, and so has a start that was not the offer's. A strip the
  // reader answered stays answered in this window.
  if (s.agent_in || (s.running && !s.offer)) { if (v.offered) v.offerSpent = true; v.offered = false; }
  else if (s.offer && !v.offerSpent) v.offered = true;
  const off = v.el.querySelector(".pn-offer");
  if (off) off.hidden = !(v.offered && talked(v) && s.running);
  if (off && off.hidden && v.offerWait) offerStop(v);
  switchStrip(v);
  cursor(v);
}

/** Why a turn ends that says the account's sign-in no longer works
 *  (`accounts::AUTH_REASONS`). */
const AUTH_STOPS = ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error"];
/** What account `id` has left, the lower of its two windows; null when
 *  nothing was heard from it. */
function leftNow(id) {
  const ws = ["five_hour", "seven_day"].map(k => windowOf(id, k)).filter(Boolean);
  if (!ws.length) return null;
  const w = ws.reduce((a, b) => (leftOf(b) < leftOf(a) ? b : a));
  return { left: leftOf(w), w };
}

/** A switch of account that waits, or the way out of a limit or a sign-in
 *  that stopped working, said on the panel it is about rather than in a
 *  toast that went before it was done (notes #124, #126, #127). Over the
 *  top of the screen like the offer, so it moves nothing.
 *  - A switch asked for mid-answer says it goes when the answer ends,
 *    until it does or is cancelled.
 *  - A turn that ended at the usage limit (`stopped`, from Claude Code's
 *    StopFailure) offers the other accounts, each with what it has left,
 *    the ones that are out too after the rest; and, when none has any left,
 *    Add another account: one click, the browser's approval, and the panel
 *    goes on as it.
 *  - A turn that ended because the sign-in no longer works offers Renew,
 *    which comes back into the conversation as the same account.
 *  - A sign-in the strip started shows its progress here (`signRow`).
 *  Each until the next prompt or a ✕. */
function switchStrip(v) {
  const el = v.el.querySelector(".pn-switch");
  if (!el) return;
  const s = v.status, on = accountOf(v);
  const open = !v.pending && !v.signing && s.running && v.limitShut !== s.agent_since;
  const limit = open && s.stopped === "rate_limit" && continuable(v);
  const auth = open && AUTH_STOPS.includes(s.stopped);
  const others = limit || (auth && continuable(v)) ? accounts().filter(a => a.id !== on.id).map(a => ({ a, l: leftNow(a.id) })) : [];
  // Something left first, most first; not heard from next; out last.
  const rank = o => (o.l == null ? 50 : o.l.left === 0 ? -1 : 100 + o.l.left);
  others.sort((x, y) => rank(y) - rank(x));
  const add = limit && !others.some(o => !o.l || o.l.left > 0);
  const renew = !!(auth && on.id && !on.removed);
  const say = v.pending ? `Switches to ${labelOf(v.pending.account)} when this answer ends`
    : v.signing ? " "
    : limit ? `Limit reached as ${on.label}`
    : auth ? (on.id ? `${on.removed ? "Its" : `${on.label}'s`} sign-in no longer works` : "Your login no longer works · run /login here")
    : "";
  const key = `${say}|${others.map(o => `${o.a.id}:${o.l ? o.l.left : ""}`)}|${add}|${renew}`;
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  el.hidden = !say;
  el.replaceChildren();
  if (!say) return;
  const btn = (sw, text, tip, sub) => {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.sw = sw; b.textContent = text;
    if (tip) b.dataset.tip = tip;
    if (sub) b.dataset.tipSub = sub;
    el.append(b);
    return b;
  };
  if (v.signing) {
    const row = document.createElement("div");
    row.className = "sg-row";
    el.append(row);
    signRow(row, { label: "Try again", run: () => stripSign(v, v.signing?.renew ?? null) });
  } else {
    const t = document.createElement("span");
    t.textContent = say;
    if (v.pending) { t.dataset.tip = "Switching now would lose the answer Claude is writing"; t.dataset.tipSub = "it restarts into this conversation as soon as the answer is done"; }
    else if (limit) { t.dataset.tip = `Usage limit reached as ${on.label}`; t.dataset.tipSub = "go on as another account, back into this conversation"; }
    el.append(t);
  }
  if (renew) btn("renew", "Renew", `Sign ${on.label} in again`, continuable(v) ? "approve in your browser; the panel goes on as it" : "approve in your browser");
  for (const { a, l } of others) {
    const b = btn("as", `Continue as ${a.label}${!l ? "" : l.left ? ` · ${l.left}% left` : ` · out${resetsIn(l.w)}`}`, "Restarts this panel into its conversation", `as ${a.label}`);
    b.dataset.n = a.id;
    if (l && !l.left) b.classList.add("out");
  }
  if (add) btn("add", "Add another account", "Sign in another Claude account", "approve in your browser; the panel goes on as it");
  const x = btn("x", "✕", v.pending ? "Cancel the switch" : v.signing ? "Cancel the sign-in" : "Not now");
  x.setAttribute("aria-label", x.dataset.tip);
}

/** Add another account, or Renew, from a panel's strip: the sign-in, then
 *  the panel back into its conversation as that account. A failure stays
 *  on the strip with Try again; a cancel puts the strip back. */
async function stripSign(v, renew) {
  v.signing = { renew }; header(v);
  let id;
  try { id = await signIn(renew ? { renew } : {}); }
  catch (e) { if (e.cancelled) { v.signing = null; header(v); } return; }
  v.signing = null;
  const d = current();
  if (continuable(v)) switchSoon(v, id === d?.account ? null : id, labelOf(id), !!renew).catch(e => ctx.toast(`Could not switch panel ${v.pane.slot}`, e));
  else v.limitShut = v.status.agent_since;
  header(v);
}

function switchClick(v, e) {
  const b = e.target.closest("[data-sw]");
  if (!b) return;
  const k = b.dataset.sw;
  if (k === "x") {
    if (v.signing) { if (signOpen(signing)) signCancel(); v.signing = null; }
    else if (v.pending) { v.whenDone = null; v.pending = null; } else v.limitShut = v.status.agent_since;
    header(v); v.body.focus();
    return;
  }
  if (k === "add") return void stripSign(v, null);
  if (k === "renew") return void stripSign(v, accountOf(v).id);
  const d = current(), a = accounts().find(x => x.id === +b.dataset.n);
  if (d && a) switchSoon(v, a.id === d.account ? null : a.id, a.label).catch(e => ctx.toast(`Could not switch panel ${v.pane.slot}`, e));
}

/** Where Claude Code stands here, for the panels and the rail to say what is
 *  missing where the work is (R2): "missing" -- no `claude` on the daemon's
 *  PATH -- "unconnected", or "connected". Asked once a desk view, and again
 *  after a Connect; null until the first answer, when nothing is said. */
let claudeIs = null, claudeAsk = null;
function claudeNow(again) {
  if (claudeAsk && !again) return claudeAsk;
  claudeAsk = fetch("/api/agents").then(r => r.json()).then(a => {
    const row = a.rows.find(r => r.id === "claude"), was = claudeIs;
    claudeIs = row && row.state === "connected" ? "connected" : a.claude_on_path ? "unconnected" : "missing";
    if (claudeIs !== was) { rail(); for (const v of views.values()) claudeStrip(v, !!v.pane.held); }
    return claudeIs;
  }).catch(() => { claudeAsk = null; return claudeIs; });
  return claudeAsk;
}
/** Connect, from a panel's strip or the rail: the window's own confirm, then
 *  everything that said "not connected" asks again. */
function connectFrom(btn) {
  ctx.connect(btn, (_, ok) => { if (ok) setTimeout(() => claudeNow(true), 2400); });
}

/** What snyvi asks for a new project desk, by the panel's one button: the
 *  question a maker coming back to their own folder has, or, on a folder
 *  snyvi just made for them, how Claude and snyvi work together. snyvi's own words, never anything it
 *  received; run only on the reader's press, into a panel they made, and
 *  quoted as one argument -- so they hold to letters, spaces and . , ' ?
 *  (bench/ui.mjs checks), which `sh -c` and `cmd /C` both take as typed. */
const ASK_LEFT = "Where did I leave off? Read this folder and its history, then send me where it stands and three next steps, to snyvi";
// A folder just made has nothing in it to plan from yet: Claude says, in a
// page that lands on the desk, how it and snyvi take a project from start
// to finish, then asks what the reader wants to make -- the first page and
// the first conversation at once.
const ASK_NEW = "In plain words for someone new to snyvi, tell me how you and snyvi can help me start this project and see it through. Send it to snyvi as a short page, then ask me what I want to make here.";
/** Folders snyvi made with Start something new (about.js): their desk asks
 *  about snyvi, there being nothing to have left off. */
const madeNew = root => { try { return (JSON.parse(localStorage.getItem("snyvi.own.made") || "[]")).includes(root); } catch { return false; } };

/** The strip over a Claude panel. Over a held one -- a new project desk's
 *  first, on every load -- it is the desk's one thing to do: *Ask Claude*,
 *  focused, so Enter presses it, in the middle of the empty panel (`.ready`),
 *  with a quiet *or just start Claude* for the bare prompt in place of the
 *  Start bar, so the panel offers one thing and not three. Over any Claude panel while snyvi is not connected, it says so
 *  with Connect: a session started before that can never see snyvi. A
 *  panel with Claude Code missing altogether says nothing here; the rail
 *  says it once for the desk. The strip is an overlay in its own slot, so
 *  nothing under it moves. */
function claudeStrip(v, held) {
  const strip = v.el.querySelector(".pn-connect"), cmd = (v.pane.cmd || "").trim();
  if (!strip || !(held || /^claude\b/.test(cmd))) return;
  claudeNow();
  if (claudeIs == null) return;
  ready(v, false);
  if (claudeIs === "unconnected" && (held || v.status.running)) {
    strip.innerHTML = `<p>snyvi isn't connected to Claude Code yet. Connect it, so what Claude writes lands here${held ? "" : ", then start Claude again"}.</p><div class="w-connect"><button type="button" class="w-btn">Connect</button></div>`;
    strip.hidden = false;
    strip.querySelector("button").addEventListener("click", e => connectFrom(e.currentTarget));
  } else if (claudeIs === "connected" && held && !v.status.running) {
    const name = ctx.esc(v.pane.cwd.split(/[\\/]/).filter(Boolean).pop() || "this"), plan = madeNew(v.pane.cwd);
    strip.innerHTML = `<p class="pn-ready">Claude is ready, in ${name}'s folder.</p><div class="w-connect"><button type="button" class="w-btn">${plan ? "Ask Claude about snyvi" : "Ask Claude: where did I leave off?"}</button></div>` +
      `<p>${plan ? `Claude sends a short page here on how the two of you take <b>${name}</b> from start to finish, then asks what you want to make.` : `It reads the folder and its history, and sends you <b>where ${name} stands</b>: what's done, what's half-done, three next steps.`}</p>` +
      // Claude's own first question in a folder it hasn't seen has No, exit
      // picked: said here, before the press, so Enter there doesn't end it.
      `<p class="pn-fine">If Claude asks whether you trust this folder, choose <b>Yes</b>.</p>` +
      `<p><button type="button" class="text pn-bare">or just start Claude</button></p>`;
    strip.hidden = false;
    ready(v, true);
    const b = strip.querySelector(".w-btn");
    b.addEventListener("click", () => { strip.hidden = true; ready(v, false); run(v, `claude "${plan ? ASK_NEW : ASK_LEFT}"`, false, false, true); });
    strip.querySelector(".pn-bare").addEventListener("click", () => { strip.hidden = true; ready(v, false); run(v, v.start.querySelector("input").value || v.pane.cmd || "claude"); });
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!strip.hidden && !v.el.contains(document.activeElement)) b.focus(); }));
    return;
  } else strip.hidden = true;
  if (held) requestAnimationFrame(() => requestAnimationFrame(() => { if (!v.start.hidden && !v.el.contains(document.activeElement)) v.start.querySelector("input").focus(); }));
}

/** A held panel's *Ask Claude* strip goes once the panel starts, by any
 *  button and in any window: the hold it was for is over. */
function unready(v) {
  const st = v.el.querySelector(".pn-connect");
  if (st && st.querySelector(".pn-ready")) { st.hidden = true; ready(v, false); }
}
const ready = (v, on) => v.el.classList.toggle("ready", on);

/** The first time a hook is heard from any panel, that panel says so, once,
 *  in its own place: Claude and snyvi are talking. */
function heardFrom(v) {
  try { if (localStorage.getItem("snyvi.seen.hooked")) return; localStorage.setItem("snyvi.seen.hooked", "1"); } catch { return; }
  const strip = v.el.querySelector(".pn-connect");
  strip.innerHTML = `<p class="ok">Claude is connected here. What it sends lands on this desk's rail.</p>`;
  strip.hidden = false;
  setTimeout(() => { strip.hidden = true; }, 6000);
}
