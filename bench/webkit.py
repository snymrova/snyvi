#!/usr/bin/env python3
"""What the page does in WebKitGTK, the engine of the Linux window.

bench/ui.mjs reads the page in Chromium. The desktop window on Linux is not
Chromium: `snyvi-app` is a WebKitGTK view, and two faults in 0.12 were only
ever visible there -- a diagram filling the screen drew every glyph as
nothing, and on the way back the figure kept its placeholder's size until
the next scroll. Neither shows in Chromium, headless or not. This drives the
same page in a WebKitGTK view under Xvfb and reads the two things that went
wrong, off the pixels for the first, since layout said the labels were there
when the screen said they were not.

The third thing is going somewhere. This engine refuses `scrollIntoView`
outright when the target sits inside a subtree it has skipped -- a
`.prose > *` below the fold, or one of the chunks a long code file is cut
into. An outline entry for line 2531 and an agent's `#L2531` both left the
document at scroll 0 with the line 52,525 px away, and a find match 8,879 px
down was marked and never reached, all three while working in Chromium. The
page moves the scroller itself now and corrects until the target settles;
these rows are what says it still does.

    xvfb-run -a python3 bench/webkit.py            report
    xvfb-run -a python3 bench/webkit.py --check    and exit non-zero on a fault
    xvfb-run -a python3 bench/webkit.py --desk     only what a working desk costs
    xvfb-run -a python3 bench/webkit.py --desk-hidden --desk-scroll --idle --daemon

The desk row is a measurement rather than a check: four panels on a desk,
each drawing bench/tui-load.mjs, and what the web process spends painting
them (docs/DESK-PAINT.md). Xvfb draws with llvmpipe, so the number is not the
window's; the same row before and after a change is what it is for. `--ui
<dir>` serves the page from disk rather than the binary, so a change to ui/
is measured without a build, and `--seconds <n>` samples for longer than 10.

The rest are what the desk row never sees, because it never looks away,
scrolls or waits. `--desk-hidden` is the same desk at work while the reader
is not looking at it -- a document read over it, another desk, the window
hidden -- and each of those is a check: a page with nothing to show spends
next to nothing, and the daemon slows what it sends. `--desk-scroll` is a
desk whose output goes by, until each panel holds the page's 6000 rows of
scrollback, and then what it costs to come back to it: the snapshots, and
how long they take to draw. `--idle` is the library with nothing happening,
and then with a note nobody has read, which must not cost more. Every row
here also says what the daemon spent over the same seconds. `--daemon` is the
daemon on its own: with nothing at all happening, for a minute; with a desk at
work and no window on it; and whether a redraw that reaches it in two writes
inside a synchronized update goes on to the page as one frame.

Needs the distribution's Python with its GObject bindings, the WebKitGTK
introspection data, xdotool for the one gesture the page cannot fake -- the
browser grants fullscreen to a real key and to nothing else -- and Xvfb:

    apt install python3-gi python3-gi-cairo gir1.2-webkit2-4.1 xdotool xvfb

Not in CI: the runners that build the window are the only ones with the
engine, and this is a check by hand for now. The daemon is the release build
at ./target/release/snyvi, or --bin.
"""

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import gi

gi.require_version("WebKit2", "4.1")
gi.require_version("Gtk", "3.0")
import cairo  # noqa: E402

gi.require_foreign("cairo")
from gi.repository import Gtk, WebKit2  # noqa: E402

args = sys.argv[1:]
CHECK = "--check" in args
BIN = os.path.abspath(args[args.index("--bin") + 1] if "--bin" in args else "./target/release/snyvi")
PORT = "7798"  # 7796 and 7797 are the Chromium benches
DESK_ONLY = "--desk" in args
DESK_HIDDEN = "--desk-hidden" in args
DESK_SCROLL = "--desk-scroll" in args
IDLE = "--idle" in args
DAEMON = "--daemon" in args
UI = os.path.abspath(args[args.index("--ui") + 1]) if "--ui" in args else None
SECONDS = int(args[args.index("--seconds") + 1]) if "--seconds" in args else 10
LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui-load.mjs")
# The most a page showing nothing that moves may cost, as a share of one core
# of the whole web process: nothing, give or take what Xvfb spends keeping a
# window. A desk out of view is held to it, and so is an idle library.
QUIET = 2.0
# And the daemon, which draws nothing: a share of one core, with nothing
# happening at all, and with four panels at work that no page is watching.
DAEMON_IDLE = 0.5
DAEMON_UNWATCHED = 1.0
IDLE_SECONDS = 60
# Coming back to a desk whose panels are full: each panel's snapshot drawn
# within this many ms of its arriving, and none of them bigger than this many
# KB. The four arrive together and are drawn one after another, so the last
# shows several of these after the switch: that is printed, not enforced.
ATTACH_MS = 150
SNAPSHOT_KB = 256
KEEP_LINES = 6000  # the page's scrollback, ui/desk.js


def flowchart(n):
    lines = ["flowchart TD"]
    for i in range(n):
        lines.append(f"  n{i}[Label {i}]")
        if i:
            lines.append(f"  n{(i - 1) // 2} --> n{i}")
    return "\n".join(lines)


PARA = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " * 6
DOC = (
    "# A diagram in the middle\n\n"
    + "".join(f"## Before {i}\n\n{PARA}\n\n" for i in range(8))
    + "## The diagram\n\n```mermaid\n" + flowchart(12) + "\n```\n\n"
    + "".join(f"## After {i}\n\n{PARA}\n\n" for i in range(12))
)

# Read in the page: the figure, its frame, and its labels as layout sees them.
PROBE = """(() => {
  const fig = document.querySelector('.mmd'), svg = fig.querySelector('svg'), frame = fig.querySelector('.mmd-frame');
  if (!svg) return JSON.stringify({ state: fig.dataset.state });
  const labels = [...svg.querySelectorAll('foreignObject, text')].map(t => t.getBoundingClientRect()).filter(r => r.width > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight);
  const fr = frame.getBoundingClientRect();
  return JSON.stringify({ state: fig.dataset.state, full: fig.dataset.full === '1', topLayer: document.fullscreenElement === fig,
    frame: [fr.left, fr.top, fr.width, fr.height].map(Math.round), width: frame.clientWidth, zoom: fig.dataset.zoom,
    labels: labels.length, label: labels[0] ? [labels[0].left, labels[0].top, labels[0].width, labels[0].height].map(Math.round) : null,
    win: [innerWidth, innerHeight], top: document.querySelector('#main').scrollTop });
})()"""


def long_js():
    """A file long enough to be cut into chunks, with its declarations spread
    out so the outline reaches deep lines, and a word far down for find."""
    out = []
    for i in range(6000):
        if i % 24 == 0:
            out.append(f"function thing{i}(a, b) {{")
        elif i % 24 == 23:
            out.append("}")
        elif i == 4801:
            out.append("  // needle_far_down lives here, well past the fold")
        else:
            out.append(f"  const v{i} = a + {i};")
    return "\n".join(out) + "\n"


# Going somewhere in a long code file: the deepest outline entry, the same
# line as a `#L` link, and a find match far down. Each one is asked for, then
# read back a moment later -- the corrections the page makes run over the
# frames after the click, and a reading taken in the same turn would catch it
# mid-chase and say it failed.
#
# It leaves its answer on `window.__go` for the harness to poll rather than
# returning it: `js()` reads a value out of the engine and a promise is not
# one, so an async probe that returns is a probe that reports nothing.
GO = """(() => { window.__go = null; (async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const main = document.querySelector('#main');
  const pre = document.querySelector('pre.code');
  const lines = pre.getElementsByClassName('ln');
  const links = [...document.querySelectorAll('#toc a[data-line]')];
  const a = links[links.length - 1];
  const line = +a.dataset.line;
  const el = lines[line - 1];
  const seen = r => ({ top: Math.round(r.top), scroll: Math.round(main.scrollTop),
    inView: r.top > -20 && r.top < innerHeight && r.height > 0 });

  main.scrollTo({ top: 0, behavior: 'instant' });
  await wait(200);
  a.click();
  await wait(1200);
  const outline = { line, ...seen(el.getBoundingClientRect()) };

  main.scrollTo({ top: 0, behavior: 'instant' });
  location.hash = '';
  await wait(200);
  location.hash = '#L' + line;
  await wait(1200);
  const hash = seen(el.getBoundingClientRect());

  main.scrollTo({ top: 0, behavior: 'instant' });
  await wait(200);
  // Find is `/` with the letters awake (Ctrl+B), as a reader opens it: the
  // toolbar button this once clicked is gone, and the bar is a chunk.
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  key('b', { code: 'KeyB', ctrlKey: true });
  await wait(600);
  key('/');
  await wait(600);
  const input = document.querySelector('#find-input');
  input.value = 'needle_far_down';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(1500);
  const m = document.querySelector('#doc mark.find.cur') || document.querySelector('#doc mark.find');
  const find = { marks: document.querySelectorAll('#doc mark.find').length,
    ...(m ? seen(m.getBoundingClientRect()) : { top: null, scroll: Math.round(main.scrollTop), inView: false }) };

  window.__go = { line, chunks: pre.getElementsByClassName('lc').length,
    outline: { ...outline, win: Math.round(innerHeight) }, hash, find };
})(); return 'started'; })()"""


class View:
    def __init__(self, url, size=(1280, 900)):
        self.win = Gtk.Window()
        self.win.set_default_size(*size)
        self.view = WebKit2.WebView.new_with_context(WebKit2.WebContext.new_ephemeral())
        self.view.get_settings().set_enable_fullscreen(True)
        self.win.add(self.view)
        self.win.show_all()
        self.view.load_uri(url)

    def wait(self, ms):
        end = time.time() + ms / 1000
        while time.time() < end:
            Gtk.main_iteration_do(False)
            time.sleep(0.005)

    def js(self, expr, timeout=30):
        """The value of `expr`, or TimeoutError when the page is too busy to
        answer at all -- a row that fails, not a bench that hangs."""
        res = {}

        def done(v, r):
            try:
                res["v"] = v.evaluate_javascript_finish(r).to_string()
            except Exception as e:  # noqa: BLE001
                res["v"] = "ERR " + str(e)
            res["done"] = True

        self.view.evaluate_javascript(expr, -1, None, None, None, done)
        end = time.time() + timeout
        while "done" not in res:
            if time.time() > end:
                raise TimeoutError(f"the page did not answer in {timeout} s")
            Gtk.main_iteration_do(False)
            time.sleep(0.005)
        return res["v"]

    def probe(self):
        return json.loads(self.js(PROBE))

    def snapshot(self):
        res = {}

        def done(v, r):
            res["surface"] = v.get_snapshot_finish(r)
            res["done"] = True

        self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)
        while "done" not in res:
            Gtk.main_iteration_do(False)
            time.sleep(0.005)
        return res["surface"]


def ink(surface, box):
    """Pixels in `box` that differ from the box's own corner: glyphs, if any."""
    x, y, w, h = box
    data, stride = surface.get_data(), surface.get_stride()

    def lum(px, py):
        o = py * stride + px * 4
        b, g, r = data[o], data[o + 1], data[o + 2]
        return 0.299 * r + 0.587 * g + 0.114 * b

    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(surface.get_width(), x + w), min(surface.get_height(), y + h)
    if x1 <= x0 or y1 <= y0:
        return 0
    base = lum(x0, y0)
    return sum(1 for py in range(y0, y1) for px in range(x0, x1) if abs(lum(px, py) - base) > 60)


# ---------- what a working desk costs ----------


def post(base, path, body, headers):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"{}")


def web_processes():
    """This process's WebKit web processes, by pid. Each view's context starts
    its own, as a child of the harness."""
    me, found = os.getpid(), set()
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/stat") as f:
                st = f.read()
        except OSError:
            continue
        comm, rest = st[st.index("(") + 1:st.rindex(")")], st[st.rindex(")") + 2:].split()
        if comm == "WebKitWebProces" and int(rest[1]) == me:
            found.add(int(pid))
    return found


def cpu_ticks(path):
    """utime + stime, fields 14 and 15 of a /proc stat file."""
    with open(path) as f:
        st = f.read()
    rest = st[st.rindex(")") + 2:].split()
    return int(rest[11]) + int(rest[12])


def threads(pid):
    """Each thread's name and ticks. The main thread is where the page is laid
    out and painted; the rest are mostly the compositor, which under Xvfb is
    llvmpipe drawing in software, a cost the window's GPU does not have."""
    out = {}
    for tid in os.listdir(f"/proc/{pid}/task"):
        try:
            with open(f"/proc/{pid}/task/{tid}/comm") as f:
                out[int(tid)] = (f.read().strip(), cpu_ticks(f"/proc/{pid}/task/{tid}/stat"))
        except OSError:
            pass
    return out


# What is on the screen while it is measured: the panes, how many live screens
# are canvases, and how many frames reached the page -- so a number that falls
# because frames stopped arriving says so. Frames are counted as the desk
# parses them: a live screen on a canvas writes no rows into the page to count.
#
# A snapshot is the frame with the grid's size near its head. While
# `window.__snap` is set, each one is counted and measured. The handler that
# parses it draws it before it returns, so a microtask queued at the parse
# runs when that panel is drawn: `each` is the longest of those. `done` is
# when the last was drawn, from the switch.
DESK_WATCH = """(() => {
  window.__frames = 0;
  if (window.__watching) return 1;
  window.__watching = 1;
  const parse = JSON.parse;
  JSON.parse = function (t) {
    if (typeof t === 'string' && t.startsWith('{"t":"frame"')) {
      window.__frames++;
      const s = window.__snap;
      if (s && t.lastIndexOf('"sz":', 80) > 0) {
        const t1 = performance.now();
        queueMicrotask(() => {
          const now = performance.now();
          s.each = Math.max(s.each, now - t1);
          s.done = Math.max(s.done, now - s.t0);
          const b = new TextEncoder().encode(t).length;
          s.n++; s.bytes += b; s.big = Math.max(s.big, b);
        });
      }
    }
    return parse.apply(this, arguments);
  };
  return 1;
})()"""
DESK_SEEN = """JSON.stringify({ panes: document.querySelectorAll('.dk .pn').length,
  working: [...document.querySelectorAll('.dk .pn-scr')].filter(s => /Painting/.test(s.textContent)).length,
  drawn: document.querySelectorAll('.dk .pn-cv').length,
  size: [...document.querySelectorAll('.dk .pn-body')].map(b => b.clientWidth + 'x' + b.clientHeight)[0] || '',
  frames: window.__frames || 0 })"""


def capability(env, base):
    """The daemon's token, and a window's capability with the header that carries it."""
    token = open(f"{env['SNYVI_CONFIG_DIR']}/token").read().strip()
    cap = post(base, "/api/capability", {}, {"authorization": f"Bearer {token}"})["capability"]
    return token, cap, {"x-snyvi-capability": cap}


def make_desk(base, H, name, cmd=None, panes=4):
    """A desk, and `panes` panels on it running `cmd` (none without one): the
    desk's id and the panels'."""
    d = post(base, "/api/desks", {"name": name}, H)
    desk, ids = (d.get("desk") or d)["id"], []
    for _ in range(panes if cmd else 0):
        ids.append(post(base, f"/api/desks/{desk}/panes", {}, H)["pane"]["id"])
        post(base, f"/api/panes/{ids[-1]}/start", {"cmd": cmd}, H)
    return desk, ids


def stop(base, H, panes):
    """Stop a row's panels, so the rows after it measure a daemon with nothing
    of this one's still running."""
    for pane in panes:
        try:
            post(base, f"/api/panes/{pane}/stop", {}, H)
        except OSError:
            pass


def daemon_pid(base):
    with urllib.request.urlopen(base + "/api/health") as r:
        return json.loads(r.read())["pid"]


def working(v, n=4):
    """Wait for `n` panels to be drawing the load; what the desk shows either way."""
    seen = {}
    for _ in range(150):
        seen = json.loads(v.js(DESK_SEEN))
        if seen["working"] == n:
            break
        v.wait(100)
    return seen


def resident_gb(pid):
    """A process's resident set, in GB, or None once it is gone."""
    try:
        with open(f"/proc/{pid}/status") as f:
            kb = next(int(line.split()[1]) for line in f if line.startswith("VmRSS:"))
        return kb / 1e6
    except (OSError, StopIteration):
        return None


def one_new(before):
    """The web process a new view started, or None if it is not exactly one."""
    procs = web_processes() - before
    return procs.pop() if len(procs) == 1 else None


def go(v, path, state=None):
    """Move the page the way Back and Forward do, which is the route the page
    takes for every place it can be: history, then `popstate`."""
    v.js(f"history.pushState({json.dumps(state)}, '', {json.dumps(path)}); "
         "dispatchEvent(new PopStateEvent('popstate', { state: history.state })); 1")


def until(v, expr, tries=100):
    for _ in range(tries):
        if v.js(expr) == "true":
            return True
        v.wait(100)
    return False


def measure(v, pid, dpid):
    """The web process's CPU while the page goes on as it is: the mean and the
    95th percentile of one-second samples, as a percentage of one core, the
    main thread's share, the frames that reached the page, and the daemon's
    CPU over the same seconds."""
    hz = os.sysconf("SC_CLK_TCK")
    v.js("window.__frames = 0")
    # For a profile of what it measures: the web process's pid, written to
    # this file once sampling begins, for a `perf record -p` to wait on.
    if os.environ.get("SNYVI_DESK_PID"):
        with open(os.environ["SNYVI_DESK_PID"], "w") as f:
            f.write(str(pid))
    stat, dstat = f"/proc/{pid}/stat", f"/proc/{dpid}/stat"
    first, d0, t0 = threads(pid), cpu_ticks(dstat), time.monotonic()
    samples, last, t = [], cpu_ticks(stat), t0
    for _ in range(SECONDS):
        v.wait(1000)
        now, nt = cpu_ticks(stat), time.monotonic()
        samples.append(100 * (now - last) / hz / (nt - t))
        last, t = now, nt
    end, d1, span = threads(pid), cpu_ticks(dstat), time.monotonic() - t0
    frames = int(v.js("window.__frames || 0") or 0)
    try:
        anims = json.loads(v.js(ANIMS) or "[]")
    except (TimeoutError, ValueError):
        anims = []
    pct = lambda ticks: 100 * ticks / hz / span  # noqa: E731
    others = {}
    for tid, (name, ticks) in end.items():
        if tid != pid:
            others[name] = others.get(name, 0) + ticks - first.get(tid, (name, 0))[1]
    return {
        "main": pct(end[pid][1] - first.get(pid, ("", 0))[1]),
        "mean": sum(samples) / len(samples),
        "p95": sorted(samples)[max(0, math.ceil(0.95 * len(samples)) - 1)],
        "top": ", ".join(f"{n} {pct(k):.0f}%" for n, k in sorted(others.items(), key=lambda x: -x[1])[:3] if pct(k) >= 1),
        "fps": frames / span,
        "daemon": pct(d1 - d0),
        "anims": anims,
    }


# What is animating at the end of a measurement, so a quiet row that is not
# quiet says what moves.
ANIMS = """JSON.stringify([...new Set(document.getAnimations().filter(a => a.playState === 'running').map(a => {
  const t = a.effect && a.effect.target, c = t ? (t.getAttribute && t.getAttribute('class')) || t.tagName : '?';
  return (a.animationName || a.transitionProperty || 'script') + ' on ' + c;
}))])"""


def cost(m):
    # A saturated process draws fewer frames at the same CPU, so the cost of
    # one frame on the main thread is the number that cannot hide.
    return (f"main thread {m['main']:.0f}% of a core, {10 * m['main'] / max(m['fps'], 0.1):.2f} ms per frame "
            f"({m['fps']:.0f}/s); whole process {m['mean']:.0f}%, p95 {m['p95']:.0f}% ({m['top']}); "
            f"daemon {m['daemon']:.1f}%")


def quiet(name, m, what=""):
    """A row held to QUIET: the page shows nothing that moves."""
    return (name, m["mean"] <= QUIET,
            f"whole process {m['mean']:.1f}%, p95 {m['p95']:.1f}%, main thread {m['main']:.1f}% "
            f"(at most {QUIET:.0f}%); {m['fps']:.1f} frames/s reach the page; daemon {m['daemon']:.1f}%"
            + (f"; {what}" if what else "")
            + (f"; threads {m['top']}" if m["top"] and m["mean"] > QUIET else "")
            + (f"; running: {', '.join(m['anims'])}" if m["anims"] else ""))


def desk_row(env, base):
    """Four panels at work on one desk, and the web process's CPU while it
    draws them."""
    _, cap, H = capability(env, base)
    node = shutil.which("node") or "node"
    desk, panes = make_desk(base, H, "paint", f"{node} {LOAD}")
    dpid = daemon_pid(base)
    before = web_processes()
    # A window the size of a screen, as the desk is usually worked in.
    v = View(f"{base}/desk/{desk}#cap={cap}", (1920, 1080))
    try:
        seen = working(v)
        if seen.get("working") != 4:
            return ("a desk of 4 at work", False, f"{seen.get('panes', 0)} panels open, {seen.get('working', 0)} drawing the load")
        v.wait(3000)
        pid = one_new(before)
        if pid is None:
            return ("a desk of 4 at work", False, "not exactly one new web process")
        v.js(DESK_WATCH)
        m = measure(v, pid, dpid)
        seen = json.loads(v.js(DESK_SEEN))
        return ("a desk of 4 at work", True, f"{cost(m)}; {seen['drawn']} live canvases, panes {seen['size']} px")
    finally:
        v.win.destroy()
        stop(base, H, panes)


def desk_hidden_rows(env, base, doc):
    """The same desk at work, then out of view three ways, and each of those
    held to QUIET. The panels go on working the whole time: what is measured
    is what the page and the daemon spend on screens nobody can see."""
    _, cap, H = capability(env, base)
    node = shutil.which("node") or "node"
    desk, panes = make_desk(base, H, "hidden", f"{node} {LOAD}")
    other, _ = make_desk(base, H, "elsewhere")
    dpid = daemon_pid(base)
    before = web_processes()
    v = View(f"{base}/desk/{desk}#cap={cap}", (1920, 1080))
    rows = []
    try:
        seen = working(v)
        if seen.get("working") != 4:
            return [("a desk out of view", False, f"{seen.get('panes', 0)} panels open, {seen.get('working', 0)} drawing the load")]
        v.wait(3000)
        pid = one_new(before)
        if pid is None:
            return [("a desk out of view", False, "not exactly one new web process")]
        v.js(DESK_WATCH)
        rows.append(("the desk in view, to compare", True, cost(measure(v, pid, dpid))))

        # A document read over the desk, as one opened from its rail is: the
        # desk steps aside and keeps its sockets, so coming back is a redraw
        # (desk.js, aside()).
        go(v, f"/d/{doc}", {"over": desk})
        ok = until(v, "!!document.querySelector('#doc .prose') && !document.querySelector('.dk .pn') "
                      "&& document.documentElement.dataset.view !== 'desk'")
        # What the desk behind costs, not the switch: a document opening
        # spends its first few seconds settling (its fonts, its figures, the
        # rail's entrance), whatever is behind it.
        v.wait(5000)
        rows.append(quiet("behind a document", measure(v, pid, dpid)) if ok
                    else ("behind a document", False, "the document never replaced the desk"))

        go(v, f"/desk/{desk}")
        working(v)
        go(v, f"/desk/{other}")
        ok = until(v, f"location.pathname === '/desk/{other}' && !!document.querySelector('.dk') && !document.querySelector('.dk .pn')")
        v.wait(5000)
        rows.append(quiet("on another desk", measure(v, pid, dpid)) if ok
                    else ("on another desk", False, "the other desk never opened"))

        go(v, f"/desk/{desk}")
        working(v)
        v.wait(1000)
        # Unmapped, which is as hidden as a window gets without a window
        # manager to minimize it: the engine says so to the page.
        v.win.hide()
        v.wait(1500)
        hidden = v.js("document.hidden")
        rows.append(quiet("the window hidden", measure(v, pid, dpid), f"document.hidden is {hidden}"))
        v.win.show_all()
    finally:
        v.win.destroy()
        stop(base, H, panes)
    return rows


# The rows each panel's scrollback holds, in the document or put away (ui/desk.js, addRows).
SB_SEEN = "JSON.stringify([...document.querySelectorAll('.dk .pn-sb')].map(s => s.rows || 0))"
# And the rows each panel's scrollback holds in all: those, and the ones the
# daemon has above them that the page asks for as the reader scrolls up.
SB_HELD = "JSON.stringify([...document.querySelectorAll('.dk .pn-sb')].map(s => (s.rows || 0) + (s.more || 0)))"


def desk_scroll_rows(env, base):
    """A desk of four whose output goes by, once each panel holds the page's
    full scrollback; then away to another desk and back, which is every
    switch, reconnect and new window: each panel is sent whole."""
    _, cap, H = capability(env, base)
    node = shutil.which("node") or "node"
    desk, panes = make_desk(base, H, "scroll", f"{node} {LOAD} --scroll 20")
    other, _ = make_desk(base, H, "elsewhere")
    dpid = daemon_pid(base)
    before = web_processes()
    v = View(f"{base}/desk/{desk}#cap={cap}", (1920, 1080))
    rows = []
    try:
        seen = working(v)
        if seen.get("working") != 4:
            return [("a desk of 4 scrolling", False, f"{seen.get('panes', 0)} panels open, {seen.get('working', 0)} drawing the load")]
        # 6500 lines at 200 a frame is a few seconds of fill; two minutes is
        # a page that cannot keep up, and it says how big it got meanwhile.
        sb, end = [], time.time() + 120
        while time.time() < end:
            try:
                sb = json.loads(v.js(SB_HELD))
            except TimeoutError:
                break
            if len(sb) == 4 and min(sb) >= KEEP_LINES:
                break
            v.wait(100)
        if len(sb) != 4 or min(sb) < KEEP_LINES:
            gb = [g for g in map(resident_gb, web_processes() - before) if g is not None]
            size = f"; the web process holds {max(gb):.1f} GB" if gb else ""
            return [("a desk of 4 scrolling", False,
                     f"the scrollback reached {sb or 'no answer'} rows, not {KEEP_LINES} in each, in 2 minutes{size}")]
        v.wait(2000)
        pid = one_new(before)
        if pid is None:
            return [("a desk of 4 scrolling", False, "not exactly one new web process")]
        v.js(DESK_WATCH)
        m = measure(v, pid, dpid)
        rows.append(("a desk of 4 scrolling", True,
                     f"{cost(m)}; {KEEP_LINES}+ rows of scrollback in each, {min(json.loads(v.js(SB_SEEN)))}+ of them in the page"))

        go(v, f"/desk/{other}")
        until(v, f"location.pathname === '/desk/{other}' && !document.querySelector('.dk .pn')")
        v.wait(1000)
        v.js("window.__snap = { n: 0, bytes: 0, big: 0, each: 0, done: 0, t0: performance.now() }; 1")
        go(v, f"/desk/{desk}")
        until(v, "window.__snap.n >= 4", 150)
        v.wait(1000)
        snap = json.loads(v.js("JSON.stringify(window.__snap)"))
        ok = snap["n"] >= 4 and snap["each"] <= ATTACH_MS and snap["big"] <= SNAPSHOT_KB * 1024
        rows.append(("back to it: 4 panels' snapshots", ok,
                     f"{snap['n']} snapshots, {snap['bytes'] / 1024:.0f} KB, the largest {snap['big'] / 1024:.0f} KB; "
                     f"each drawn within {snap['each']:.0f} ms, the last {snap['done']:.0f} ms after the switch "
                     f"(at most {ATTACH_MS} ms and {SNAPSHOT_KB} KB each)"))
        # A snapshot is the newest of the scrollback; the rest comes as the
        # reader scrolls up to it.
        # Said by what is left above, not by the rows, which the output going
        # by grows anyway.
        left = "(document.querySelector('.dk .pn-sb').more || 0)"
        had = [json.loads(v.js(SB_SEEN))[0], int(v.js(left))]
        # With its scroll event at once, as a reader's scroll has: the page
        # keeps a panel at the bottom until it hears it was scrolled, and the
        # output going by would put it back before the event came.
        v.js("(b => { b.scrollTop = 0; b.dispatchEvent(new Event('scroll')); })(document.querySelector('.dk .pn-body')); 1")
        more = had[1] > 0 and until(v, f"{left} < {had[1]}", 50)
        now = [json.loads(v.js(SB_SEEN))[0], int(v.js(left))]
        rows.append(("scrolled to its top: older lines come", more,
                     f"{had[0]} rows with {had[1]} above at the daemon, then {now[0]} with {now[1]} within 5 s"))
    except TimeoutError as e:
        gb = [g for g in map(resident_gb, web_processes() - before) if g is not None]
        size = f"; the web process holds {max(gb):.1f} GB" if gb else ""
        rows.append(("back to it: 4 panels' snapshots" if rows else "a desk of 4 scrolling", False, f"{e}{size}"))
    finally:
        v.win.destroy()
        stop(base, H, panes)
    return rows


def idle_rows(env, base):
    """The library with nothing happening, and then with an agent's note that
    nobody has read. Both are held to QUIET: a note is news, not an animation
    that runs for as long as the reader is away."""
    token, _, _ = capability(env, base)
    dpid = daemon_pid(base)
    before = web_processes()
    v = View(base + "/", (1280, 900))
    rows = []
    try:
        until(v, "document.readyState === 'complete'")
        v.wait(3000)
        pid = one_new(before)
        if pid is None:
            return [("the library, idle", False, "not exactly one new web process")]
        note = v.js("document.documentElement.dataset.note || 'none'")
        rows.append(quiet("the library, idle", measure(v, pid, dpid), f"note {note}"))

        post(base, "/api/notes", {"text": "The bench left this, and nobody has read it.", "sender": "bench"},
             {"authorization": f"Bearer {token}"})
        ok = until(v, "!!document.documentElement.dataset.note && !!document.querySelector('#note')")
        # The face perks up when a note comes -- two blinks, four pulses, under
        # ten seconds (app.css) -- and the row is what it costs after that.
        v.wait(10000)
        note = v.js("document.documentElement.dataset.note || 'none'")
        rows.append(quiet("an unread note, idle", measure(v, pid, dpid), f"note {note}") if ok
                    else ("an unread note, idle", False, "the note never reached the page"))
    finally:
        v.win.destroy()
    return rows


def daemon_cpu(dpid, seconds):
    """The daemon's CPU over `seconds`, as a share of one core. Its panels'
    programs are processes of their own and are not counted."""
    hz, stat = os.sysconf("SC_CLK_TCK"), f"/proc/{dpid}/stat"
    d0, t0 = cpu_ticks(stat), time.monotonic()
    time.sleep(seconds)
    return 100 * (cpu_ticks(stat) - d0) / hz / (time.monotonic() - t0)


def daemon_rows(env, base):
    """The daemon with no page on it: first with nothing happening, which
    is most of its life, then with a desk at work that nobody is watching,
    which is a window closed on one. And a redraw that arrives in two writes,
    watched: inside a synchronized update it is one frame, not a torn half
    and then the rest."""
    _, cap, H = capability(env, base)
    node = shutil.which("node") or "node"
    dpid = daemon_pid(base)
    rows = []
    time.sleep(3)
    pct = daemon_cpu(dpid, IDLE_SECONDS)
    rows.append(("the daemon, nothing happening", pct <= DAEMON_IDLE,
                 f"{pct:.2f}% of a core over {IDLE_SECONDS} s (at most {DAEMON_IDLE}%)"))

    desk, panes = make_desk(base, H, "unwatched", f"{node} {LOAD}")
    try:
        time.sleep(3)
        pct = daemon_cpu(dpid, SECONDS)
        rows.append(("the daemon, 4 panels at work and no window", pct <= DAEMON_UNWATCHED,
                     f"{pct:.2f}% of a core (at most {DAEMON_UNWATCHED}%); the watched desk's row says what it is with one"))
    finally:
        stop(base, H, panes)

    for sync in (False, True):
        flag = " --split --sync" if sync else " --split"
        desk, panes = make_desk(base, H, "sync" if sync else "split", f"{node} {LOAD}{flag}")
        before = web_processes()
        v = View(f"{base}/desk/{desk}#cap={cap}", (1920, 1080))
        name = "a redraw in two writes, synchronized" if sync else "a redraw in two writes, to compare"
        try:
            seen = working(v)
            if seen.get("working") != 4:
                rows.append((name, False, f"{seen.get('panes', 0)} panels open, {seen.get('working', 0)} drawing the load"))
                continue
            v.wait(3000)
            pid = one_new(before)
            if pid is None:
                rows.append((name, False, "not exactly one new web process"))
                continue
            v.js(DESK_WATCH)
            m = measure(v, pid, dpid)
            # Ten ticks a second in each of four panels (tui-load.mjs).
            per = m["fps"] / 40
            rows.append((name, per <= 1.25 if sync else True,
                         f"{per:.2f} frames a redraw ({m['fps']:.0f}/s for 40 redraws/s)"
                         + (" (at most 1.25)" if sync else "") + f"; {cost(m)}"))
        finally:
            v.win.destroy()
            stop(base, H, panes)
    return rows


# The two rows below need a real key press, which only xdotool can send. It
# is a prerequisite rather than a dependency: without it those rows say so
# and the rest of the file still runs, which is better than the whole check
# dying on a missing tool.
HAVE_XDO = shutil.which("xdotool") is not None


# A panel that prints a known screen, then ticks one row: a red ground on
# cells 0-6, a box corner at 8, 中 over 13-14 and an x at 15 on row 0; a line,
# shades and a powerline separator on row 1; a counter on row 2.
CANVAS_LOAD = (
    "printf '\\033[2J\\033[H\\033[41m  RED  \\033[0m \u256d\u2500\u2500\u256e \u4e2dx \\033[1mbold\\033[0m \\033[4mund\\033[0m\\n'\n"
    "printf '\u2502ab\u2502 \u2591\u2592\u2593 \\033[34m\ue0b0\\033[0m\\n'\n"
    "i=0; while true; do i=$((i+1)); printf '\\033[3;1Htick %s' $i; sleep 0.1; done\n")
CANVAS_GEOMETRY = """JSON.stringify((() => {
  const cv = document.querySelector('.pn-cv'), b = document.querySelector('.pn-body'), scr = document.querySelector('.pn-scr');
  const r = cv.getBoundingClientRect(), s = scr.getBoundingClientRect();
  const probe = Object.assign(document.createElement('span'), { className: 'pn-probe', textContent: '0'.repeat(40) });
  document.body.append(probe); const cw = probe.getBoundingClientRect().width / 40; probe.remove();
  return { x: r.left, y: r.top, w: r.width, sx: s.left, sy: s.top, cw, dpr: devicePixelRatio, pw: cv.width,
           lh: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pn-line')),
           red: snyviTheme.colour('--t1', b), blue: snyviTheme.colour('--t4', b), t0: scr.children[0].textContent };
})())"""
# The canvas as drawn, against the same canvas drawn whole in the same task: a
# theme set to itself redraws every row, before any frame can land between.
CANVAS_WHOLE = """(() => { const cv = document.querySelector('.pn-cv'), g = cv.getContext('2d');
  const a = g.getImageData(0, 0, cv.width, cv.height).data;
  document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  Promise.resolve().then(() => { const b = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; window.__whole = n; }); return 1; })()"""


def canvas_rows(env, base):
    """The live screen drawn on a canvas (docs/DESK-PAINT.md, Phase 3): what
    it draws, where, in which colours, and the text over it that selection
    and copy read."""
    token = open(f"{env['SNYVI_CONFIG_DIR']}/token").read().strip()
    cap = post(base, "/api/capability", {}, {"authorization": f"Bearer {token}"})["capability"]
    H = {"x-snyvi-capability": cap}
    d = post(base, "/api/desks", {"name": "canvas"}, H)
    desk = (d.get("desk") or d)["id"]
    load = f"{env['HOME']}/canvas-load.sh"
    with open(load, "w") as f:
        f.write(CANVAS_LOAD)
    pane = post(base, f"/api/desks/{desk}/panes", {}, H)["pane"]["id"]
    post(base, f"/api/panes/{pane}/start", {"cmd": f"sh {load}"}, H)
    v = View(f"{base}/desk/{desk}#cap={cap}", (1280, 900))
    rows = []
    try:
        for _ in range(200):
            if v.js("(r => !!r && /RED/.test(r.textContent))(document.querySelector('.pn-scr > div'))") == "true":
                break
            v.wait(100)
        v.wait(1500)
        g = json.loads(v.js(CANVAS_GEOMETRY))
        ok = abs(g["x"] - g["sx"]) < .5 and abs(g["y"] - g["sy"]) < .5 and g["pw"] == round(g["w"] * g["dpr"]) and g["w"] > 0 \
            and g["t0"].startswith("  RED   \u256d\u2500\u2500\u256e \u4e2dx bold und")
        rows.append(("the live screen: a canvas under its text", ok,
                     f"{g['pw']} device px over {g['w']:.0f} px, on the text at ({g['sx']:.0f}, {g['sy']:.0f}); the text reads {g['t0'][:22]!r}"))

        shot = v.snapshot()
        data, stride = shot.get_data(), shot.get_stride()

        def px(x, y):
            o = int(y) * stride + int(x) * 4
            return "#%02x%02x%02x" % (data[o + 2], data[o + 1], data[o])

        def near(a, b, t=24):
            return all(abs(int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) <= t for i in (1, 3, 5))
        cx = lambda i: g["x"] + (i + .5) * g["cw"]  # noqa: E731
        cy = lambda j: g["y"] + (j + .5) * g["lh"]  # noqa: E731
        ground, red = px(cx(40), cy(0)), px(cx(3), g["y"] + 2)
        corner = any(not near(px(cx(8) + dx, cy(0) + dy), ground, 40) for dx in (-1, 0, 1) for dy in (0, 3, 6))
        top, bottom = px(cx(0), g["y"] + g["lh"] + 1), px(cx(0), g["y"] + 2 * g["lh"] - 1)
        line = not near(top, ground, 40) and not near(bottom, ground, 40)
        sep = px(cx(9) - g["cw"] * .3, cy(1))
        ok = near(red, g["red"]) and corner and line and near(sep, g["blue"], 40)
        rows.append(("drawn to the cell, in the theme's colours", ok,
                     f"red ground {red} for {g['red']}; corner {'drawn' if corner else 'missing'}; "
                     f"│ {'meets both rows' if line else 'falls short'}; powerline {sep} for {g['blue']}"))

        at = json.loads(v.js("""JSON.stringify((() => {
          const row = document.querySelector('.pn-scr').children[0], w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n;
          while ((n = w.nextNode())) { const i = n.data.indexOf('x bold'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect().left; } }
          return null; })())"""))
        want = g["x"] + 15 * g["cw"]
        rows.append(("a wide character keeps the grid", at is not None and abs(at - want) < 1.5,
                     f"the x after 中 at {at} px in the text, column 15 at {want:.1f} px" if at is not None else "no x after 中 in the text"))

        t1 = v.js("document.querySelector('.pn-scr').children[2].textContent")
        s1 = v.snapshot()
        v.wait(2200)
        t2 = v.js("document.querySelector('.pn-scr').children[2].textContent")
        s2 = v.snapshot()

        def band(s):
            dd, st, y0, x0 = s.get_data(), s.get_stride(), int(g["y"] + 2 * g["lh"]), int(g["x"])
            return b"".join(bytes(dd[(y0 + k) * st + x0 * 4:(y0 + k) * st + (x0 + int(20 * g["cw"])) * 4]) for k in range(int(g["lh"])))
        ok = band(s1) != band(s2) and t1 != t2 and t2.startswith("tick")
        rows.append(("new frames drawn, and the text catches up", ok, f"the counter drawn anew; its text went {t1.strip()!r} to {t2.strip()!r}"))

        v.js(CANVAS_WHOLE)
        v.wait(100)
        n = v.js("window.__whole")
        rows.append(("the cells a frame changed, drawn as a whole row would be", n == "0", f"{n} bytes differ from the canvas drawn whole"))

        sel = v.js("""(() => { const s = document.querySelector('.pn-scr'), r = document.createRange();
          s.parentElement.closest('.pn-body').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); dispatchEvent(new MouseEvent('mouseup'));
          r.setStart(s.children[0].firstChild, 2); r.setEnd(s.children[1], 0);
          getSelection().removeAllRanges(); getSelection().addRange(r); const t = getSelection().toString(); getSelection().removeAllRanges(); return t; })()""")
        rows.append(("selecting the live screen gives its text", sel.startswith("RED") and "\u4e2dx" in sel, repr(sel.strip()[:30])))

        themes = ["paper", "ink", "contrast", "espresso", "midnight", "parchment", "sage", "snow"]
        off = []
        for th in themes:
            v.js(f"document.documentElement.dataset.theme = '{th}'")
            v.wait(400)
            want = v.js("snyviTheme.colour('--t1', document.querySelector('.pn-body'))")
            s = v.snapshot()
            dd, st = s.get_data(), s.get_stride()
            o = int(g["y"] + 2) * st + int(cx(3)) * 4
            got = "#%02x%02x%02x" % (dd[o + 2], dd[o + 1], dd[o])
            if not near(got, want):
                off.append(f"{th} {got} for {want}")
        rows.append(("every theme redraws the canvas", not off, "; ".join(off) or f"the red ground follows all {len(themes)}"))
    finally:
        v.win.destroy()
        stop(base, H, [pane])
    return rows


def xdo(*a):
    subprocess.run(["xdotool", *a], check=False)


def main():
    # In memory where there is some: a daemon on a busy disk can take longer
    # to open its database than `send` waits, and a desk's numbers should not
    # carry the disk's.
    tmp = tempfile.mkdtemp(prefix="snyvi-webkit-", dir="/dev/shm" if os.path.isdir("/dev/shm") else None)
    # A daemon of its own, and panels that start in a home of their own: none
    # of the desk this may be running in, and none of the reader's shell rc.
    # And no notifications: a document sent here is not the reader's news.
    env = {k: val for k, val in os.environ.items() if not k.startswith("SNYVI_")}
    env.update(SNYVI_DATA_DIR=f"{tmp}/data", SNYVI_CONFIG_DIR=f"{tmp}/config", SNYVI_PORT=PORT, HOME=f"{tmp}/home",
               SNYVI_NOTIFY="0")
    if UI:
        env["SNYVI_UI_DIR"] = UI
    os.makedirs(env["HOME"])
    rows = []
    try:
        path = f"{tmp}/doc.md"
        with open(path, "w") as f:
            f.write(DOC)
        out = subprocess.run([BIN, "send", path], env=env, cwd=tmp, capture_output=True, text=True).stdout
        url = next(w for w in out.split() if w.startswith("http"))
        base = url.split("/d/")[0] if "/d/" in url else "/".join(url.split("/")[:3])
        doc = url.rsplit("/d/", 1)[-1].split("#")[0].split("?")[0]
        if DESK_ONLY or DESK_HIDDEN or DESK_SCROLL or IDLE or DAEMON:
            if DAEMON:
                rows += daemon_rows(env, base)
            if IDLE:
                rows += idle_rows(env, base)
            if DESK_ONLY:
                rows.append(desk_row(env, base))
            if DESK_HIDDEN:
                rows += desk_hidden_rows(env, base, doc)
            if DESK_SCROLL:
                rows += desk_scroll_rows(env, base)
            return report(rows)
        v = View(url)
        v.wait(1500)
        for _ in range(40):
            if v.js("document.readyState") == "complete" and v.js("!!document.querySelector('.mmd')") == "true":
                break
            v.wait(100)
        v.js("document.querySelector('.mmd').scrollIntoView({ block: 'center', behavior: 'instant' })")
        for _ in range(80):
            if v.js("!!document.querySelector('.mmd[data-state=\"done\"]')") == "true":
                break
            v.wait(100)
        v.wait(300)
        before = v.probe()
        if not HAVE_XDO:
            rows.append(("f fills the window", None, "skipped: xdotool is not installed"))
            rows.append(("Escape gives the page back", None, "skipped: xdotool is not installed"))
        else:
            # The key, with the pointer over the document, since `f` takes the
            # diagram nearest the middle of the window and this one is.
            xdo("mousemove", "640", "450")
            v.wait(100)
            xdo("key", "f")
            v.wait(1200)
            filled = v.probe()
            shot = v.snapshot()
            painted = ink(shot, filled["label"]) if filled.get("label") else 0
            ok = (before["state"] == "done" and filled["full"] and not filled["topLayer"]
                  and filled["frame"][2] == filled["win"][0] and filled["frame"][3] == filled["win"][1] and painted > 20)
            rows.append(("f fills the window", ok,
                         "the diagram was never drawn" if before["state"] != "done"
                         else "f filled nothing" if not filled["full"]
                         else "the figure itself went into the top layer" if filled["topLayer"]
                         else f"the frame is {filled['frame'][2]}x{filled['frame'][3]} in a {filled['win'][0]}x{filled['win'][1]} window" if not ok and painted > 20
                         else f"the first label has {painted} px of ink -- laid out, not drawn" if painted <= 20
                         else f"the frame is the {filled['win'][0]}x{filled['win'][1]} window; the first label has {painted} px of ink"))
            xdo("key", "Escape")
            v.wait(1200)
            back = v.probe()
            ok = (not back["full"] and back["width"] > 0 and 0 < back["frame"][3] < back["win"][1]
                  and back["zoom"] == "fit" and abs(back["top"] - before["top"]) < 2)
            rows.append(("Escape gives the page back", ok,
                         "still filling" if back["full"]
                         else "the figure came back with no size, waiting on a scroll" if back["width"] == 0
                         else f"came back {back['frame'][3]} px tall" if back["frame"][3] >= back["win"][1]
                         else f"came back zoomed {back['zoom']}" if back["zoom"] != "fit"
                         else f"the document moved from {before['top']} to {back['top']}" if abs(back["top"] - before["top"]) >= 2
                         else f"{back['width']} px wide and fitted again with no scroll, document at {back['top']}"))

        # ---------- going somewhere in a long file ----------
        # A code file long enough to be cut into chunks, with its
        # declarations spread out so the outline reaches deep lines, and a
        # word far down for find. Sent, so the rows do not depend on what
        # this repository happens to look like.
        code_path = f"{tmp}/long.js"
        with open(code_path, "w") as f:
            f.write(long_js())
        out = subprocess.run([BIN, "send", code_path], env=env, capture_output=True, text=True).stdout
        code_url = next(w for w in out.split() if w.startswith("http"))
        v.view.load_uri(code_url)
        for _ in range(150):
            if (v.js("document.readyState") == "complete"
                    and v.js("document.querySelectorAll('#toc a[data-line]').length > 0") == "true"):
                break
            v.wait(100)
        v.wait(800)

        v.js(GO)
        deep = None
        for _ in range(120):
            got = v.js("window.__go ? JSON.stringify(window.__go) : ''")
            if got and got != "''" and got.startswith("{"):
                deep = json.loads(got)
                break
            v.wait(100)
        if deep is None:
            raise RuntimeError("the page never reported where the jumps landed")
        rows.append(("an outline entry lands", deep["outline"]["inView"],
                     f"line {deep['outline']['line']} is {deep['outline']['top']} px down a "
                     f"{deep['outline']['win']} px window, in {deep['chunks']} chunks"
                     if deep["outline"]["inView"] else
                     f"clicked the entry for line {deep['outline']['line']} and the document stayed at "
                     f"{deep['outline']['scroll']}, with the line {deep['outline']['top']} px away"))
        rows.append((f"#L{deep['line']} lands", deep["hash"]["inView"],
                     f"the line is {deep['hash']['top']} px down and marked"
                     if deep["hash"]["inView"] else
                     f"the hash left the document at {deep['hash']['scroll']}, the line {deep['hash']['top']} px away"))
        rows.append(("find reaches its match", deep["find"]["inView"],
                     f"{deep['find']['marks']} marked, the current one {deep['find']['top']} px down"
                     if deep["find"]["inView"] else
                     f"marked {deep['find']['marks']} and stopped at {deep['find']['scroll']}, "
                     f"the match {deep['find']['top']} px away"))
        v.win.destroy()
        rows += canvas_rows(env, base)
        rows += idle_rows(env, base)
        rows.append(desk_row(env, base))
        rows += desk_hidden_rows(env, base, doc)
        rows += desk_scroll_rows(env, base)
        rows += daemon_rows(env, base)
    finally:
        subprocess.run([BIN, "stop"], env=env, capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
    report(rows)


def report(rows):
    print(f"webkit: what the page does in WebKitGTK {WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}\n")
    failed = False
    for name, ok, why in rows:
        failed = failed or ok is False
        print(f"  {name:<30}{' ok  ' if ok else ' skip' if ok is None else ' FAIL'} {why}")
    if failed and CHECK:
        print("\nwebkit: something the page should do in this engine, it does not", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
