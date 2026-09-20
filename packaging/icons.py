#!/usr/bin/env python3
"""Draw the snyvi mark at every size and format the platforms ask for.

The mark is snyvi itself, the mascot that leaves notes at the foot of the
sidebar: a peach tile with a maroon nub on top and a maroon face. Its
geometry lives here in the 32-unit space the UI draws it in, so the tab,
the sidebar, the taskbar and the tray cannot drift apart.

Two faces, because one does not serve both ends of the range:

  >= 48px  the full face: eyes with their shine, rosy cheeks, the smile.
           Drawn 8x and downsampled.
  <= 32px  eyes and smile only, the smile a little heavier. Sparkles and
           cheeks a pixel across antialias into a smudge.

Run by hand when the mark changes; the output is committed, so nothing in
the build depends on Python:

    python3 packaging/icons.py
"""

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

BODY = "#f9a77e"     # the mascot's peach
INK = "#6b2208"      # its face, a maroon dark enough to read on peach
NUB = "#c2410c"      # the logo's maroon, the UI's --brand
CHEEK = "#f5847e"    # #f0607e at half strength over the body, flattened
SHINE = "#ffffff"

# The 32-unit geometry: boxes as (x, y, w, h, radius), eyes as centres.
NUB_BOX = (14, 0.5, 4, 5, 2)
BODY_BOX = (1, 4, 30, 27, 9)
EYES = ((11, 16.5), (21, 16.5))
EYE = (2.6, 3.3)
SMILE = ((13.5, 23), (16, 25.2), (18.5, 23))   # a quadratic: start, control, end
FULL = {"smile": 1.8, "shine": ((0.9, -1.3, 1.0), (-0.6, 1.4, 0.45)),
        "cheeks": ((7.8, 21.5), (24.2, 21.5)), "cheek": (2.2, 1.4)}
SIMPLE = {"smile": 2.2, "shine": (), "cheeks": (), "cheek": None}

PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256, 512)
# 128 is left out: it is pure overhead as an uncompressed bitmap, and Windows
# halves the 256 PNG for that slot without visible loss.
ICO_SIZES = (16, 24, 32, 48, 64, 256)
SMALL = 32               # at or below this, the simple face

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"


def ellipse(d, k, cx, cy, rx, ry, fill):
    d.ellipse([(cx - rx) * k, (cy - ry) * k, (cx + rx) * k, (cy + ry) * k], fill=fill)


def box(d, k, x, y, w, h, r, fill):
    d.rounded_rectangle([x * k, y * k, (x + w) * k, (y + h) * k], radius=r * k, fill=fill)


def quad(p0, p1, p2, n=24):
    """Points along a quadratic curve, for the smile PIL has no path for."""
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append(tuple((1 - t) ** 2 * a + 2 * (1 - t) * t * b + t * t * c
                         for a, b, c in zip(p0, p1, p2)))
    return pts


def render(size):
    face = SIMPLE if size <= SMALL else FULL
    scale = 8
    k = size * scale / 32
    img = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    box(d, k, *NUB_BOX, NUB)
    box(d, k, *BODY_BOX, BODY)
    for cx, cy in face["cheeks"]:
        ellipse(d, k, cx, cy, *face["cheek"], CHEEK)
    for cx, cy in EYES:
        ellipse(d, k, cx, cy, *EYE, INK)
        for dx, dy, r in face["shine"]:
            ellipse(d, k, cx + dx, cy + dy, r, r, SHINE)
    w = face["smile"] * k
    pts = [(x * k, y * k) for x, y in quad(*SMILE)]
    d.line(pts, fill=INK, width=round(w), joint="curve")
    for x, y in (pts[0], pts[-1]):   # round caps
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=INK)
    return img.resize((size, size), Image.LANCZOS)


def svg(face=FULL):
    """The master, for scalable icon themes and anywhere an SVG is wanted."""
    def rect(x, y, w, h, r, fill):
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"/>'
    parts = [rect(*NUB_BOX, NUB), rect(*BODY_BOX, BODY)]
    for cx, cy in face["cheeks"]:
        parts.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{face["cheek"][0]}" ry="{face["cheek"][1]}" fill="{CHEEK}"/>')
    for cx, cy in EYES:
        parts.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{EYE[0]}" ry="{EYE[1]}" fill="{INK}"/>')
        for dx, dy, r in face["shine"]:
            parts.append(f'<circle cx="{round(cx + dx, 2)}" cy="{round(cy + dy, 2)}" r="{r}" fill="{SHINE}"/>')
    (x0, y0), (x1, y1), (x2, y2) = SMILE
    parts.append(f'<path d="M{x0} {y0}Q{x1} {y1} {x2} {y2}" fill="none" stroke="{INK}" '
                 f'stroke-width="{face["smile"]}" stroke-linecap="round"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
            + "".join(parts) + "</svg>\n")


def dib(img):
    """One icon directory entry as a DIB: the format every Windows reads.

    A .ico entry may hold a PNG instead, and tools often write one at every
    size, but only the 256px entry is documented to work that way; parts of
    the shell still want a bitmap below that. So the small sizes -- the ones
    that actually appear in the taskbar, the title bar and Alt-Tab -- are
    bitmaps, and only 256 is a PNG, where the saving is worth having.

    The bitmap is bottom-up BGRA with a doubled height in the header, because
    the format expects a colour image followed by an AND mask. The mask is
    unused at 32bpp but has to be there, padded to whole 32-bit words.
    """
    w, h = img.size
    px = img.load()
    colour = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            colour += bytes((b, g, r, a))
    mask_stride = ((w + 31) // 32) * 4
    mask = bytes(mask_stride * h)
    header = struct.pack(
        "<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(colour) + len(mask), 0, 0, 0, 0
    )
    return header + bytes(colour) + mask


def write_ico(path, images):
    """An .ico holding every size as it was drawn.

    Pillow's own ICO writer resizes a single image down to each requested
    size, which would throw away the hand-snapped small ones, so the
    directory is written here instead.
    """
    payloads = []
    for img in images:
        if img.size[0] >= 256:
            buf = BytesIO()
            img.save(buf, format="PNG")
            payloads.append(buf.getvalue())
        else:
            payloads.append(dib(img))
    n = len(payloads)
    entries, blob = b"", b""
    offset = 6 + 16 * n
    for img, data in zip(images, payloads):
        w, h = img.size
        entries += struct.pack(
            "<BBBBHHII",
            0 if w >= 256 else w,   # 0 means 256
            0 if h >= 256 else h,
            0, 0, 1, 32, len(data), offset + len(blob),
        )
        blob += data
    path.write_bytes(struct.pack("<HHH", 0, 1, n) + entries + blob)


def main():
    OUT.mkdir(exist_ok=True)
    drawn = {}
    for size in PNG_SIZES:
        img = render(size)
        drawn[size] = img
        img.save(OUT / f"{size}.png")
    # icon.png is the master raster; Tauri and the .desktop entry look for it.
    drawn[512].save(OUT / "icon.png")
    # The tray is asked for one image and scales it: 32 is the largest size
    # still drawn on the pixel grid, so it is the crispest one to hand over.
    drawn[32].save(OUT / "tray.png")
    write_ico(OUT / "icon.ico", [drawn[s] for s in ICO_SIZES])
    (OUT / "icon.svg").write_text(svg())
    # The small face, for the favicon and the sidebar, where the full one smudges.
    (OUT / "icon-small.svg").write_text(svg(SIMPLE))
    for p in sorted(OUT.iterdir()):
        print(f"{p.name:12} {p.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
