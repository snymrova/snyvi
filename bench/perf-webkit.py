#!/usr/bin/env python3
"""Where a WebKitGTK web process's main thread spends its time, from a perf
recording, without `perf report --symfs`.

The perf that runs on this machine (linux-tools 6.8.0-47 on a 6.8.0-139
kernel) dies with a segfault in `perf report` as soon as it is handed the
WebKit debug symbols. So this takes `perf script`'s raw stacks and resolves
the addresses in libwebkit2gtk itself, against the symbol table of the debug
file, and counts, for each function, the share of samples it is on the stack
of (inclusive) and at the top of (self).

    perf record -F 499 -g -p <web process pid> -o wk.data -- sleep 8
    python3 bench/perf-webkit.py wk.data webkit.debug [--top 40]

The debug file is the one debuginfod has for the library's build id (see
docs/DESK-PAINT.md, Measuring). Only the main thread is counted: its comm is
the process's, `WebKitWebProces`, where the other threads are named for what
they do.
"""

import bisect
import collections
import re
import subprocess
import sys

args = sys.argv[1:]
if len(args) < 2:
    sys.exit(__doc__)
DATA, DEBUG = args[0], args[1]
TOP = int(args[args.index("--top") + 1]) if "--top" in args else 40
PERF = "/usr/lib/linux-tools-6.8.0-47/perf"
LIB = "libwebkit2gtk"
# What the desk's plan watches (docs/DESK-PAINT.md), always printed.
WATCH = ["RenderLayer::paint", "paintMaskImages", "SVGImage::draw", "paintMaskForFragments",
         "applyAncestorClippingForBorderRadius", "clipRoundedRect", "performLayout",
         "JSEventListener::handleEvent", "perf-"]
# JavaScript is mostly JIT code, which perf finds in the /tmp/perf-<pid>.map the
# engine writes rather than in any library: "perf-" is that, and handleEvent
# is everything a page's event handler costs, the DOM work it causes included.


def perf_script(*extra):
    return subprocess.run([PERF, "script", "-i", DATA, *extra], capture_output=True, text=True).stdout


# Where the library's code was mapped: address, and the file offset it maps.
maps = []
for line in perf_script("--show-mmap-events").splitlines():
    m = re.search(r"PERF_RECORD_MMAP2 .*\[0x([0-9a-f]+)\(0x([0-9a-f]+)\) @ 0x([0-9a-f]+) .*\]: r-xp (\S+)", line)
    if m and LIB in m.group(4):
        maps.append((int(m.group(1), 16), int(m.group(2), 16), int(m.group(3), 16)))
if not maps:
    sys.exit(f"no {LIB} mapping in {DATA}")

# The text symbols of the debug file. In this library a file offset in the
# code segment is the same as its address, so offset is what gets looked up.
addrs, names = [], []
nm = subprocess.run(["nm", "-C", "--defined-only", DEBUG], capture_output=True, text=True).stdout
for line in nm.splitlines():
    a, kind, name = line.split(" ", 2) if line.count(" ") >= 2 else (None, None, None)
    if kind in ("t", "T", "w", "W"):
        addrs.append(int(a, 16))
        names.append(name.split("(")[0])
order = sorted(range(len(addrs)), key=addrs.__getitem__)
addrs, names = [addrs[i] for i in order], [names[i] for i in order]


def name(ip, dso):
    if LIB not in dso:
        return dso.rsplit("/", 1)[-1]
    for start, size, pgoff in maps:
        if start <= ip < start + size:
            i = bisect.bisect_right(addrs, ip - start + pgoff) - 1
            return names[i] if i >= 0 else "?"
    return "?"


samples, incl, self_ = 0, collections.Counter(), collections.Counter()


def count(stack):
    global samples
    if not stack:
        return
    samples += 1
    seen = set()
    for depth, (ip, dso) in enumerate(stack):
        n = name(ip, dso)
        if depth == 0:
            self_[n] += 1
        if n not in seen:
            seen.add(n)
            incl[n] += 1


stack = []
for line in perf_script("--comm", "WebKitWebProces", "-F", "tid,ip,dso").splitlines():
    parts = line.split()
    if not parts:
        count(stack)
        stack = []
    elif len(parts) >= 2 and parts[-1].startswith("("):
        stack.append((int(parts[-2], 16), parts[-1].strip("()")))
count(stack)
if not samples:
    sys.exit("no main-thread samples")

pct = lambda c: f"{100 * c / samples:5.1f}%"  # noqa: E731
# Samples are taken only while the thread runs, so their count is its CPU time
# and says more than a percentage of a busy machine would.
print(f"{samples} main-thread samples\n\nwatched (inclusive):")
for k in WATCH:
    print(f"  {pct(max((c for n, c in incl.items() if k in n), default=0))}  {k}")
print("\ninclusive:")
for n, c in incl.most_common(TOP):
    print(f"  {pct(c)}  {n[:120]}")
print("\nself:")
for n, c in self_.most_common(15):
    print(f"  {pct(c)}  {n[:120]}")
