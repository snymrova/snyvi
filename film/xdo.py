#!/usr/bin/env python3
"""Keys and clicks for the film's camera, straight at the X server.

The camera photographs the real desktop window rather than a page in headless
Chromium, which means the things a reader does with the keyboard -- the search
palette, the compare view, filling the screen with a diagram -- have to be
done with the keyboard. There is no xdotool on the machine this was written
on, and no wmctrl either, so this is the part of those that the camera needs:
find the window, raise it, and fake input at it through the XTEST extension.

    python3 film/xdo.py find                     # print the window id
    python3 film/xdo.py focus
    python3 film/xdo.py key ctrl+k
    python3 film/xdo.py key Escape
    python3 film/xdo.py type "retry"

It needs python-xlib, which is not a system package here -- the camera makes a
virtual environment for it. `--display` defaults to $DISPLAY, and `--name` to
the window snyvi opens, which is titled exactly "snyvi".
"""

import argparse
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

# What a name in `key` means, where it is not simply the character itself.
SPECIAL = {
    "escape": "Escape", "esc": "Escape", "enter": "Return", "return": "Return",
    "tab": "Tab", "space": "space", "backspace": "BackSpace", "delete": "Delete",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
    "slash": "slash", "backslash": "backslash", "question": "question",
}
MODS = {"ctrl": "Control_L", "control": "Control_L", "shift": "Shift_L",
        "alt": "Alt_L", "super": "Super_L", "meta": "Super_L"}


def windows(d, want):
    """Every mapped window whose title is exactly `want`, outermost first."""
    found = []

    def walk(w):
        try:
            name = w.get_wm_name()
            if name == want and w.get_attributes().map_state == X.IsViewable:
                geom = w.get_geometry()
                found.append((geom.width * geom.height, w))
            for child in w.query_tree().children:
                walk(child)
        except Exception:
            pass

    walk(d.screen().root)
    # Biggest first: the frame, not the 10x10 helper the toolkit also names.
    return [w for _, w in sorted(found, key=lambda p: -p[0])]


def find(d, name):
    got = windows(d, name)
    if not got:
        sys.exit(f"xdo: no mapped window called {name!r}")
    return got[0]


def focus(d, win):
    win.configure(stack_mode=X.Above)
    win.set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()
    time.sleep(0.25)


def code(d, keysym_name):
    """The keycode for a keysym, and whether shift is needed to reach it.

    A keycode carries several keysyms and the layout decides which one a press
    produces: `apostrophe` unshifted is `quotedbl` shifted, on the same key. So
    asking only for the keycode types the wrong character for every shifted
    one -- which is how `claude "..."` arrived at a shell as `claude '...'`.
    The shifted position is looked up rather than guessed, so this follows
    whatever layout the machine is actually on.
    """
    sym = XK.string_to_keysym(keysym_name)
    if sym == 0:
        sys.exit(f"xdo: no keysym called {keysym_name!r}")
    kc = d.keysym_to_keycode(sym)
    if kc == 0:
        sys.exit(f"xdo: {keysym_name!r} is not on this keyboard map")
    return kc, d.keycode_to_keysym(kc, 0) != sym and d.keycode_to_keysym(kc, 1) == sym


def tap(d, keysym_name, mods=()):
    """Press `keysym_name` with `mods` held, and let go of everything."""
    kc, needs_shift = code(d, keysym_name)
    if needs_shift and "shift" not in mods:
        mods = (*mods, "shift")
    held = [code(d, MODS[m])[0] for m in mods]
    for h in held:
        xtest.fake_input(d, X.KeyPress, h)
    xtest.fake_input(d, X.KeyPress, kc)
    xtest.fake_input(d, X.KeyRelease, kc)
    for h in reversed(held):
        xtest.fake_input(d, X.KeyRelease, h)
    d.sync()


# Characters X does not name after themselves. Everything absent here -- the
# letters, the digits -- is its own keysym name, and `code` works out on its
# own whether the layout needs shift to reach it.
PUNCT = {
    " ": "space", "!": "exclam", '"': "quotedbl", "#": "numbersign",
    "$": "dollar", "%": "percent", "&": "ampersand", "'": "apostrophe",
    "(": "parenleft", ")": "parenright", "*": "asterisk", "+": "plus",
    ",": "comma", "-": "minus", ".": "period", "/": "slash", ":": "colon",
    ";": "semicolon", "<": "less", "=": "equal", ">": "greater",
    "?": "question", "@": "at", "[": "bracketleft", "\\": "backslash",
    "]": "bracketright", "^": "asciicircum", "_": "underscore",
    "`": "grave", "{": "braceleft", "|": "bar", "}": "braceright",
    "~": "asciitilde", "\t": "Tab", "\n": "Return",
}


def spell(d, text, gap):
    """Type `text` a character at a time, as key events, because that is the
    only kind of input a terminal pane reads."""
    for ch in text:
        tap(d, PUNCT.get(ch, ch))
        time.sleep(gap)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["find", "focus", "key", "type", "click", "move", "untip"])
    p.add_argument("value", nargs="?", default="")
    p.add_argument("--name", default="snyvi")
    p.add_argument("--display", default=None)
    p.add_argument("--gap", type=float, default=0.012, help="seconds between characters")
    # Focusing the top-level takes focus off whatever inside it had it, which
    # is how the first `type` after opening the search palette went to the
    # document underneath and not to the box. Raise once, then stop touching it.
    p.add_argument("--no-focus", action="store_true", help="the window already has focus")
    a = p.parse_args()

    d = display.Display(a.display)
    win = find(d, a.name)

    if a.action == "find":
        g = win.get_geometry()
        print(f"{hex(win.id)} {g.width}x{g.height}+{g.x}+{g.y}")
        return

    if not a.no_focus:
        focus(d, win)
    if a.action == "focus":
        return
    if a.action == "key":
        *mods, last = a.value.split("+")
        tap(d, SPECIAL.get(last.lower(), last), tuple(m.lower() for m in mods))
    elif a.action == "untip":
        # A tooltip is a window of its own, laid over this one, and the camera
        # takes the screen's pixels -- so a pointer left over a row put a black
        # bar and a /tmp path in the frame. Take down every other override-
        # redirect window bigger than an icon before a shot.
        for w in d.screen().root.query_tree().children:
            at = w.get_attributes()
            if w.id != win.id and at.override_redirect and at.map_state == X.IsViewable and w.get_geometry().width > 20:
                w.unmap()
        d.sync()
    elif a.action == "move":
        # `x,y` inside the window, and no button: what shows the tools a row
        # keeps for the pointer, like the new-desk button on a folder.
        x, y = (int(n) for n in a.value.split(","))
        pos = win.translate_coords(win.query_tree().root, x, y)
        xtest.fake_input(d, X.MotionNotify, x=pos.x, y=pos.y)
        d.sync()
        time.sleep(0.3)
    elif a.action == "click":
        # `x,y` inside the window. Scrolling a pane or a document with the
        # keyboard needs the keyboard pointed at it first, and what points it
        # there is a click, the way a reader's would.
        x, y = (int(n) for n in a.value.split(","))
        g = win.get_geometry()
        root = win.query_tree().root
        pos = win.translate_coords(root, x, y)
        xtest.fake_input(d, X.MotionNotify, x=pos.x, y=pos.y)
        d.sync()
        time.sleep(0.1)
        xtest.fake_input(d, X.ButtonPress, 1)
        xtest.fake_input(d, X.ButtonRelease, 1)
        d.sync()
        time.sleep(0.2)
    else:
        spell(d, a.value, a.gap)
    d.sync()
    time.sleep(0.1)


if __name__ == "__main__":
    main()
