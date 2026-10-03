#!/usr/bin/env python3
"""A key's echo, from the desk socket and back: what typing into a panel
feels like, without a browser.

Each case starts `cat` in a panel on a daemon of its own (a spare port, a
throwaway HOME in /dev/shm, never 7777), types into it over the desk socket
as a page does, and times each key to the frame that moves the caret. Two of
the cases have a 25 fps spinner in the same panel, which is any panel busy
beside the one being typed into: all of a desk's panels share one socket.

Before 1.13 the busy cases had a 40-55 ms tail: the daemon's socket left
Nagle on, so an echo written while a spinner's frame was unacknowledged sat
in the kernel until the page's delayed ACK. And every echo waited out the
4 ms settle and the 16 ms frame gap meant for bulk output (src/pane.rs).

    python3 bench/echo.py                 report
    python3 bench/echo.py --check         and exit non-zero over the gate
    python3 bench/echo.py --bin <path>    another build (default ./target/release/snyvi)

Gate: p99 at most 20 ms with the spinner and fast typing. Needs the
`websockets` package.
"""
import asyncio, json, os, random, shutil, subprocess, sys, tempfile, time, urllib.request

import websockets

args = sys.argv[1:]
BIN = os.path.abspath(args[args.index("--bin") + 1] if "--bin" in args else "./target/release/snyvi")
CHECK = "--check" in args
PORT = os.environ.get("PORT", "7853")
N = int(os.environ.get("N", "120"))
GATE_P99 = 20.0

SPIN = r"""while :; do printf '\0337\033[30;60H%s\0338' $RANDOM; sleep 0.04; done &"""
CASES = [
    ("quiet, slow typing", "stty -icanon; exec cat", 0.12),
    ("quiet, fast typing (40 ms)", "stty -icanon; exec cat", 0.04),
    ("25 fps spinner, slow typing", SPIN + " stty -icanon; exec cat", 0.12),
    ("25 fps spinner, fast typing", SPIN + " stty -icanon; exec cat", 0.04),
]


def post(base, path, body, headers):
    r = urllib.request.Request(base + path, json.dumps(body).encode(),
                               {"content-type": "application/json", "origin": base, **headers})
    with urllib.request.urlopen(r) as x:
        return json.loads(x.read() or b"{}")


def capability(cfg, base):
    """Minted over the window secret where there is one (1.13 on), over the
    token before that, so an older build can be measured the same way."""
    if os.path.exists(f"{cfg}/window"):
        h = {"x-snyvi-window": open(f"{cfg}/window").read().strip()}
    else:
        h = {"authorization": "Bearer " + open(f"{cfg}/token").read().strip()}
    return post(base, "/api/capability", {}, h)["capability"]


async def drain(ws, wait):
    try:
        while True:
            await asyncio.wait_for(ws.recv(), wait)
    except asyncio.TimeoutError:
        pass


async def case(base, H, cap, desk, cmd, gap):
    pane = post(base, f"/api/desks/{desk}/panes", {}, H)["pane"]["id"]
    post(base, f"/api/panes/{pane}/start", {"cmd": cmd}, H)
    url = base.replace("http", "ws") + "/api/desk"
    lat, last = [], None
    async with websockets.connect(url, additional_headers={"Origin": base}, max_size=None) as ws:
        await ws.send(json.dumps({"capability": cap}))
        await ws.recv()
        await ws.send(json.dumps({"t": "watch", "panes": [pane]}))
        await ws.send(json.dumps({"t": "size", "p": pane, "c": 100, "r": 30}))
        await asyncio.sleep(1.5)
        await drain(ws, 0.05)
        for i in range(N):
            ch = "abcdefghijklmnopqrstuvwxyz"[i % 26]
            t0 = time.perf_counter()
            await ws.send(json.dumps({"t": "in", "p": pane, "d": ch}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), 2))
                # The spinner saves and restores the caret, so only an echo moves it.
                if m.get("t") == "frame" and m.get("c") and m["c"][:2] != last:
                    last = m["c"][:2]
                    break
            lat.append((time.perf_counter() - t0) * 1000)
            if ch == "z":
                await ws.send(json.dumps({"t": "in", "p": pane, "d": "\n"}))
            await asyncio.sleep(gap * random.uniform(0.7, 1.3))
            await drain(ws, 0.001)
    post(base, f"/api/panes/{pane}/stop", {}, H)
    lat.sort()
    return lambda p: lat[min(len(lat) - 1, int(p * len(lat)))]


async def main():
    tmp = tempfile.mkdtemp(prefix="snyvi-echo-", dir="/dev/shm")
    env = {k: v for k, v in os.environ.items() if not k.startswith("SNYVI_")}
    env.update(SNYVI_DATA_DIR=f"{tmp}/data", SNYVI_CONFIG_DIR=f"{tmp}/config", SNYVI_PORT=PORT,
               HOME=f"{tmp}/home", SNYVI_NOTIFY="0")
    os.makedirs(env["HOME"])
    open(f"{tmp}/doc.md", "w").write("# x\n")
    bad = []
    try:
        subprocess.run([BIN, "send", f"{tmp}/doc.md"], env=env, cwd=tmp, capture_output=True)
        base = f"http://127.0.0.1:{PORT}"
        cap = capability(env["SNYVI_CONFIG_DIR"], base)
        H = {"x-snyvi-capability": cap}
        d = post(base, "/api/desks", {"name": "echo"}, H)
        desk = (d.get("desk") or d)["id"]
        print(f"echo: key to echo frame, {N} keys a case, ms")
        for name, cmd, gap in CASES:
            q = await case(base, H, cap, desk, cmd, gap)
            print(f"  {name:30s} p50 {q(.5):5.1f}  p90 {q(.9):5.1f}  p99 {q(.99):5.1f}")
            if name.startswith("25 fps spinner, fast") and q(.99) > GATE_P99:
                bad.append(f"{name}: p99 {q(.99):.1f} over {GATE_P99:.0f}")
    finally:
        subprocess.run([BIN, "stop"], env=env, capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
    for b in bad:
        print("  over the gate:", b)
    if CHECK and bad:
        sys.exit(1)


asyncio.run(main())
