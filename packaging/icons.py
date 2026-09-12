#!/usr/bin/env python3
"""Draw the snyvi mark at every size and format the platforms ask for.

The mark is the one already in the UI's favicon: a rounded square in the
accent colour with three lines, the last one short. Its proportions live
here as fractions of the icon's side, taken from that favicon's 32-unit
viewBox so the tab, the taskbar and the tray cannot drift apart.

Two renderers, because one does not serve both ends of the range:

  >= 48px  the mark as specified, drawn 8x and downsampled, round caps
           and smooth corners.
  <= 32px  the same rhythm snapped to whole pixels, with a stroke that is
           deliberately heavier. At 7.5% a 16px icon gets a 1.2px line,
           which antialiases into grey mush; a 2px line is the smallest
           one that is still a line.

Run by hand when the mark changes; the output is committed, so nothing in
the build depends on Python:

    python3 packaging/icons.py
"""

import struct
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (194, 65, 12, 255)  # #c2410c, the UI's --accent
INK = (255, 255, 255, 255)

# Fractions of the side, from the favicon's 32-unit viewBox.
RADIUS = 7 / 32          # corner radius
STROKE = 2.4 / 32        # line thickness
ROWS = (10 / 32, 16 / 32, 22 / 32)   # line centres
X0, X1 = 9 / 32, 23 / 32             # line ends, centre of the round cap
SHORT_X1 = 18 / 32                   # the third line stops here

CAP = STROKE / 2         # round caps reach half a stroke past the ends

PNG_SIZES = (16, 20, 24, 32, 48, 64, 128, 256, 512)
# 128 is left out: it is pure overhead as an uncompressed bitmap, and Windows
# halves the 256 PNG for that slot without visible loss.
ICO_SIZES = (16, 24, 32, 48, 64, 256)
SMALL = 32               # at or below this, snap to the pixel grid

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"


def rounded(size, scale=1):
    """The accent square, drawn large and downsampled so corners stay smooth."""
    big = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle(
        [0, 0, size * scale - 1, size * scale - 1],
        radius=RADIUS * size * scale,
        fill=ACCENT,
    )
    return big if scale == 1 else big.resize((size, size), Image.LANCZOS)


def render_large(size):
    scale = 8
    img = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size * scale
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=RADIUS * s, fill=ACCENT)
    t = STROKE * s
    for i, row in enumerate(ROWS):
        cy = row * s
        x1 = (SHORT_X1 if i == 2 else X1) * s
        d.rounded_rectangle(
            [X0 * s - CAP * s, cy - t / 2, x1 + CAP * s, cy + t / 2],
            radius=t / 2,
            fill=INK,
        )
    return img.resize((size, size), Image.LANCZOS)


def render_small(size):
    """Whole-pixel geometry: the corners are antialiased, the lines are not."""
    img = rounded(size, scale=8)
    d = ImageDraw.Draw(img)
    # 8.5% rather than 7.5%: see the module docstring.
    t = max(2, round(size * 0.085))
    for i, row in enumerate(ROWS):
        cy = round(row * size)
        top = cy - t // 2
        x0 = round((X0 - CAP) * size)
        x1 = round(((SHORT_X1 if i == 2 else X1) + CAP) * size)
        d.rectangle([x0, top, x1 - 1, top + t - 1], fill=INK)
    return img


def render(size):
    return render_small(size) if size <= SMALL else render_large(size)


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


def svg():
    """The master, for scalable icon themes and anywhere an SVG is wanted."""
    line = ('<path d="M{x0} {y0}H{x1}M{x0} {y1}H{x1}M{x0} {y2}H{x3}" '
            'stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        '<rect width="32" height="32" rx="7" fill="#c2410c"/>'
        + line.format(x0=9, x1=23, x3=18, y0=10, y1=16, y2=22)
        + "</svg>\n"
    )


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
    for p in sorted(OUT.iterdir()):
        print(f"{p.name:12} {p.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
