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

Needs the distribution's Python with its GObject bindings, the WebKitGTK
introspection data, xdotool for the one gesture the page cannot fake -- the
browser grants fullscreen to a real key and to nothing else -- and Xvfb:

    apt install python3-gi python3-gi-cairo gir1.2-webkit2-4.1 xdotool xvfb

Not in CI: the runners that build the window are the only ones with the
engine, and this is a check by hand for now. The daemon is the release build
at ./target/release/snyvi, or --bin.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

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
    def __init__(self, url):
        self.win = Gtk.Window()
        self.win.set_default_size(1280, 900)
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


# The two rows below need a real key press, which only xdotool can send. It
# is a prerequisite rather than a dependency: without it those rows say so
# and the rest of the file still runs, which is better than the whole check
# dying on a missing tool.
HAVE_XDO = shutil.which("xdotool") is not None


def xdo(*a):
    subprocess.run(["xdotool", *a], check=False)


def main():
    tmp = tempfile.mkdtemp(prefix="snyvi-webkit-")
    env = dict(os.environ, SNYVI_DATA_DIR=f"{tmp}/data", SNYVI_CONFIG_DIR=f"{tmp}/config", SNYVI_PORT=PORT)
    rows = []
    try:
        path = f"{tmp}/doc.md"
        with open(path, "w") as f:
            f.write(DOC)
        out = subprocess.run([BIN, "send", path], env=env, cwd=tmp, capture_output=True, text=True).stdout
        url = next(w for w in out.split() if w.startswith("http"))
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
    finally:
        subprocess.run([BIN, "stop"], env=env, capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)

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
