/* ui/desk/02-socket.js: a part of desk.js, one module. build.rs joins ui/desk/*.js in name
 * order (src/strip.rs `source`); SNYVI_UI_DIR serves the same join. */
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
    for (const id of fresh) { const v = views.get(id); v.asked = true; clearRows(v, v.old); clearRows(v, v.sb); }
  }
  say({ t: "watch", panes: ids });
  // A new socket knows nothing of which panes are out of sight.
  if (fresh.length) paced = null;
  pace();
}

/** A pane the reader cannot see: the window is hidden, a document is read
 *  over the desk, or the grid had no room for it. Its frames are taken in
 *  but not drawn (`paint`), and the daemon sends it one a second, not
 *  sixty: a desk left behind a document used to cost as much as one in
 *  view. */
const seen = v => !document.hidden && reading == null && v.el.isConnected;
let paced = null;
function pace() {
  const slow = [...views.values()].filter(v => !seen(v)).map(v => v.id).sort();
  if (String(slow) === paced) return;
  paced = String(slow);
  say({ t: "pace", slow });
}
/** A pane back in sight, drawn as it now is: the canvas once whole, and the
 *  text over it caught up soon, as after any frame. */
function catchUp(v) {
  if (!seen(v)) return;
  if (v.behind) { v.behind = false; drawAll(v); if (v.pinned) v.body.scrollTop = v.body.scrollHeight; }
  if (v.stale.size && !v.textT) v.textT = setTimeout(() => textSoon(v), TEXT_MS);
}
document.addEventListener("visibilitychange", () => {
  if (!ctx || deskId == null) return;
  pace();
  for (const v of views.values()) catchUp(v);
  // The rail's clock skipped its turns while hidden: one draw catches up.
  if (!document.hidden) rail();
});

function receive(f) {
  const v = views.get(f.p);
  if (!v) return;
  if (f.t === "frame") paint(v, f);
  else if (f.t === "status") {
    // The rail marks every pane, so a change to any pane's mark redraws it:
    // a panel that needs its reader says so wherever the focus is.
    // Anything else -- a new title, which an agent changes about once a
    // second while it works -- is the row's name, set where it stands, so
    // the row under the pointer is never swapped for a copy of itself.
    const mark = x => `${x.running}${x.blocked}${x.agent}${talked({ ...v, status: x })}`, was = mark(v.status);
    v.status = f.s; header(v); resume(v);
    // A switch of account waits on the stop it asked for (`runAs`).
    if (v.onStop && !f.s.running) { const k = v.onStop; v.onStop = null; k(); }
    if (mark(f.s) !== was) rail();
    else { named(v); if (v.id === focused) meta(); }
  }
  else if (f.t === "old") {
    const rows = f.lines.slice(-KEEP_LINES);
    // Older lines of it, asked for as the reader scrolled up: they go on top,
    // if they are still for the text this page holds.
    if (f.have != null) {
      if (v.old.asking && v.old.g === f.g && v.old.rows === f.have) { v.old.asking = false; v.old.more = f.more; prependRows(v, v.old, rows); }
      return;
    }
    // What the last run left, greyed: the scrollback is now the old text, and
    // the new run starts with none of its own. It comes as its last lines; the
    // rest is asked for when the reader scrolls up to it.
    clearRows(v, v.old);
    addRows(v, v.old, rows);
    v.old.g = f.g; v.old.more = f.more;
    clearRows(v, v.sb);
  }
  else if (f.t === "more") {
    if (!v.sb.asking || v.sb.at !== f.before) return;
    v.sb.asking = false; v.sb.at = f.sb0; v.sb.more = f.sbm;
    prependRows(v, v.sb, f.sb);
  }
}

/** The capability did not open a socket: the daemon behind this window is
 *  not the one that minted it -- restarted, or upgraded -- and only a new
 *  window is given a new one. */
function refused() {
  ctx.docEl.querySelector(".dk-grid")?.replaceChildren(Object.assign(document.createElement("p"), {
    className: "dk-none",
    textContent: "This window's capability is from a daemon that has since restarted, so it cannot reach the panels. Close the window and open it again with `snyvi app`.",
  }));
}

// ---------- painting ----------

/** Apply one frame to the page's copy of the grid, then repaint the rows it
 *  touched. The same steps, in the same order, as the replica in
 *  src/screen.rs's tests -- which is what says this cannot drift. */
function paint(v, f) {
  // A diff for a grid this page does not hold yet: its snapshot is behind it.
  if (!f.sz && !v.rows) return;
  born = bornOf(v);
  // Only these change how tall the pane's content is; a frame that just
  // rewrites rows leaves the scroll where it is, and asks nothing of layout.
  const grows = f.sz || f.sbclear || f.gap || (f.sb && f.sb.length);
  if (f.sz) {
    // Resize-and-clear, on this side as on the daemon's.
    v.cols = f.sz[0]; v.rows = f.sz[1];
    v.cells = Array.from({ length: v.rows }, () => blankRow(v.cols));
    v.scr.replaceChildren(...v.cells.map(() => document.createElement("div")));
    v.stale.clear();
    v.drawn = null;
    v.scr.style.height = v.rows * LINE_PX + "px";
    sizeCanvas(v);
  }
  // `clear` clears everything the reader could scroll to: the run before
  // this one, greyed above the scrollback, goes with it.
  if (f.sbclear) { clearRows(v, v.sb); clearRows(v, v.old); }
  if (f.gap) addRows(v, v.sb, [{ gap: f.gap }]);
  // A snapshot: the scrollback as it starts, which is its newest lines -- the
  // rest is asked for as the reader scrolls up to it -- and never on top of
  // what this page held, which a resync after falling behind would double.
  if (f.sb0 != null) { clearRows(v, v.sb); v.sb.at = f.sb0; v.sb.more = f.sbm; }
  if (f.sb && f.sb.length) addRows(v, v.sb, f.sb);
  // Out of sight, the cells are kept and nothing is drawn: `catchUp` draws
  // the pane whole when it is back.
  const inSight = seen(v);
  if (!inSight) v.behind = true;
  if (f.up) up(v, f.up, inSight);
  if (f.r) {
    for (const [y, x0, runs] of f.r) {
      const row = v.cells[y];
      let x = x0;
      for (const [t, fg = 0, bg = 0, fl = 0] of runs) {
        const wide = fl & WIDE, a = fl & ~(WIDE | CLUSTER);
        for (const ch of fl & CLUSTER ? [t] : t) {
          row[x++] = [ch, fg, bg, a, wide ? 2 : 1];
          if (wide) row[x++] = null;
        }
      }
      v.stale.add(y);
      if (inSight) drawRow(v, y, x0, x);
    }
  }
  if (inSight && v.stale.size && !v.textT) v.textT = setTimeout(() => textSoon(v), TEXT_MS);
  if (CHECK && inSight) checked(v);
  if (f.c) v.cur = f.c;
  if (f.m) v.mode = f.m;
  cursor(v);
  // Kept at the bottom once a frame of the page, not once a frame of each
  // pane: reading the height here was a layout forced on every frame that
  // brought lines, four panes over, and up to 60 ms of a desk's return.
  if (grows && v.pinned && !v.pinT) v.pinT = requestAnimationFrame(() => { v.pinT = 0; if (v.pinned) v.body.scrollTop = v.body.scrollHeight; });
}

/** A row of each box as HTML, from the line as it came: a scrollback line
 *  (runs, or `{w, r}` for one that wrapped), a gap, or a line of old text. */
const sbRow = l => l.gap ? `<div class="gap">⋯ ${l.gap.toLocaleString()} lines went by</div>`
  : `<div${l.w ? ' data-w="1"' : ""}>${runsHtml(l.r || l) || " "}</div>`;
const oldRow = l => `<div>${ctx.esc(l) || " "}</div>`;
const fmtOf = (v, box) => box === v.old ? oldRow : sbRow;
