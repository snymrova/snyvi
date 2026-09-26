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

The last row is a measurement rather than a check: four panels on a desk,
each drawing bench/tui-load.mjs, and what the web process spends painting
them (docs/DESK-PAINT.md). Xvfb draws with llvmpipe, so the number is not the
window's; the same row before and after a change is what it is for. `--ui
<dir>` serves the page from disk rather than the binary, so a change to ui/
is measured without a build, and `--seconds <n>` samples for longer than 10.

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
UI = os.path.abspath(args[args.index("--ui") + 1]) if "--ui" in args else None
SECONDS = int(args[args.index("--seconds") + 1]) if "--seconds" in args else 10
LOAD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui-load.mjs")


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
  const open = document.querySelector('#btn-find');
  if (open) open.click();
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

    def js(self, expr):
        res = {}

        def done(v, r):
            try:
                res["v"] = v.evaluate_javascript_finish(r).to_string()
            except Exception as e:  # noqa: BLE001
                res["v"] = "ERR " + str(e)
            res["done"] = True

        self.view.evaluate_javascript(expr, -1, None, None, None, done)
        while "done" not in res:
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
DESK_WATCH = """(() => {
  window.__frames = 0;
  const parse = JSON.parse;
  JSON.parse = function (t) { if (typeof t === 'string' && t.startsWith('{"t":"frame"')) window.__frames++; return parse.apply(this, arguments); };
  return 1;
})()"""
DESK_SEEN = """JSON.stringify({ panes: document.querySelectorAll('.dk .pn').length,
  working: [...document.querySelectorAll('.dk .pn-scr')].filter(s => /Painting/.test(s.textContent)).length,
  drawn: document.querySelectorAll('.dk .pn-cv').length,
  size: [...document.querySelectorAll('.dk .pn-body')].map(b => b.clientWidth + 'x' + b.clientHeight)[0] || '',
  frames: window.__frames || 0 })"""


def desk_row(env, base):
    """Four panels at work on one desk, and the web process's CPU while it
    draws them: the mean and the 95th percentile of one-second samples, as a
    percentage of one core."""
    token = open(f"{env['SNYVI_CONFIG_DIR']}/token").read().strip()
    cap = post(base, "/api/capability", {}, {"authorization": f"Bearer {token}"})["capability"]
    H = {"x-snyvi-capability": cap}
    d = post(base, "/api/desks", {"name": "paint"}, H)
    desk = (d.get("desk") or d)["id"]
    node = shutil.which("node") or "node"
    for _ in range(4):
        pane = post(base, f"/api/desks/{desk}/panes", {}, H)["pane"]["id"]
        post(base, f"/api/panes/{pane}/start", {"cmd": f"{node} {LOAD}"}, H)

    before = web_processes()
    # A window the size of a screen, as the desk is usually worked in.
    v = View(f"{base}/desk/{desk}#cap={cap}", (1920, 1080))
    seen = {}
    for _ in range(150):
        seen = json.loads(v.js(DESK_SEEN))
        if seen["working"] == 4:
            break
        v.wait(100)
    if seen.get("working") != 4:
        v.win.destroy()
        return ("a desk of 4 at work", False, f"{seen.get('panes', 0)} panels open, {seen.get('working', 0)} drawing the load")
    v.wait(3000)
    procs = web_processes() - before
    if len(procs) != 1:
        v.win.destroy()
        return ("a desk of 4 at work", False, f"found {len(procs)} new web processes, expected one")
    pid = procs.pop()
    hz = os.sysconf("SC_CLK_TCK")
    v.js(DESK_WATCH)
    # For a profile of what it measures: the web process's pid, written to
    # this file once sampling begins, for a `perf record -p` to wait on.
    if os.environ.get("SNYVI_DESK_PID"):
        with open(os.environ["SNYVI_DESK_PID"], "w") as f:
            f.write(str(pid))
    stat = f"/proc/{pid}/stat"
    first, t0 = threads(pid), time.monotonic()
    samples, last, t = [], cpu_ticks(stat), t0
    for _ in range(SECONDS):
        v.wait(1000)
        now, nt = cpu_ticks(stat), time.monotonic()
        samples.append(100 * (now - last) / hz / (nt - t))
        last, t = now, nt
    end, span = threads(pid), time.monotonic() - t0
    seen = json.loads(v.js(DESK_SEEN))
    v.win.destroy()
    pct = lambda ticks: 100 * ticks / hz / span  # noqa: E731
    main = pct(end[pid][1] - first.get(pid, ("", 0))[1])
    others = {}
    for tid, (name, ticks) in end.items():
        if tid != pid:
            others[name] = others.get(name, 0) + ticks - first.get(tid, (name, 0))[1]
    top = ", ".join(f"{n} {pct(k):.0f}%" for n, k in sorted(others.items(), key=lambda x: -x[1])[:3] if pct(k) >= 1)
    mean = sum(samples) / len(samples)
    p95 = sorted(samples)[max(0, math.ceil(0.95 * len(samples)) - 1)]
    fps = seen["frames"] / span
    # A saturated process draws fewer frames at the same CPU, so the cost of
    # one frame on the main thread is the number that cannot hide.
    return ("a desk of 4 at work", True,
            f"main thread {main:.0f}% of a core, {10 * main / max(fps, 0.1):.2f} ms per frame "
            f"({fps:.0f}/s); whole process {mean:.0f}%, p95 {p95:.0f}% ({top}); "
            f"{seen['drawn']} live canvases, panes {seen['size']} px")


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
        if DESK_ONLY:
            rows.append(desk_row(env, base))
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
        rows.append(desk_row(env, base))
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
