/*
 * A page's link-preview picture when it has none of its own (1.62, social
 * audit 16627c32e2, S2): 1200 × 630, the page's accent, its title in large
 * block letters and its address under it. Drawn from fixed shapes -- a 5 × 7
 * letter grid, scaled -- into a two-colour PNG, at each write of the page and
 * kept in R2 beside it, so no read draws anything and no font is shipped.
 *
 * Letters it has no shape for are left out (a title in another script keeps
 * only its address); accents fall back to their letter.
 */

const W = 1200, H = 630, M = 80;

/** Each glyph's seven rows, five bits each, the left bit first. */
const GLYPHS: Record<string, string> = {
  A: "01110,10001,10001,11111,10001,10001,10001", B: "11110,10001,10001,11110,10001,10001,11110",
  C: "01110,10001,10000,10000,10000,10001,01110", D: "11110,10001,10001,10001,10001,10001,11110",
  E: "11111,10000,10000,11110,10000,10000,11111", F: "11111,10000,10000,11110,10000,10000,10000",
  G: "01110,10001,10000,10111,10001,10001,01111", H: "10001,10001,10001,11111,10001,10001,10001",
  I: "01110,00100,00100,00100,00100,00100,01110", J: "00111,00010,00010,00010,00010,10010,01100",
  K: "10001,10010,10100,11000,10100,10010,10001", L: "10000,10000,10000,10000,10000,10000,11111",
  M: "10001,11011,10101,10101,10001,10001,10001", N: "10001,10001,11001,10101,10011,10001,10001",
  O: "01110,10001,10001,10001,10001,10001,01110", P: "11110,10001,10001,11110,10000,10000,10000",
  Q: "01110,10001,10001,10001,10101,10010,01101", R: "11110,10001,10001,11110,10100,10010,10001",
  S: "01111,10000,10000,01110,00001,00001,11110", T: "11111,00100,00100,00100,00100,00100,00100",
  U: "10001,10001,10001,10001,10001,10001,01110", V: "10001,10001,10001,10001,10001,01010,00100",
  W: "10001,10001,10001,10101,10101,10101,01010", X: "10001,10001,01010,00100,01010,10001,10001",
  Y: "10001,10001,10001,01010,00100,00100,00100", Z: "11111,00001,00010,00100,01000,10000,11111",
  "0": "01110,10001,10011,10101,11001,10001,01110", "1": "00100,01100,00100,00100,00100,00100,01110",
  "2": "01110,10001,00001,00010,00100,01000,11111", "3": "11111,00010,00100,00010,00001,10001,01110",
  "4": "00010,00110,01010,10010,11111,00010,00010", "5": "11111,10000,11110,00001,00001,10001,01110",
  "6": "00110,01000,10000,11110,10001,10001,01110", "7": "11111,00001,00010,00100,01000,01000,01000",
  "8": "01110,10001,10001,01110,10001,10001,01110", "9": "01110,10001,10001,01111,00001,00010,01100",
  "-": "00000,00000,00000,11111,00000,00000,00000", ".": "00000,00000,00000,00000,00000,01100,01100",
  ",": "00000,00000,00000,00000,01100,00100,01000", "'": "01100,00100,01000,00000,00000,00000,00000",
  "!": "00100,00100,00100,00100,00100,00000,00100", "?": "01110,10001,00001,00010,00100,00000,00100",
  ":": "00000,01100,01100,00000,01100,01100,00000", "&": "01100,10010,10100,01000,10101,10010,01101",
  "/": "00000,00001,00010,00100,01000,10000,00000", " ": "00000,00000,00000,00000,00000,00000,00000",
};
const ROWS: Record<string, number[]> = Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [k, v.split(",").map((r) => parseInt(r, 2))]));

/** What of `s` can be drawn: upper case, accents dropped, the rest out. */
export function drawable(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split("").filter((c) => ROWS[c]).join("").replace(/\s+/g, " ").trim();
}

/** `s` in lines of at most `n` letters, broken at spaces where it can be. */
function wrap(s: string, n: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    for (let w = word; w; ) {
      const room = line ? n - line.length - 1 : n;
      if (w.length <= room) { line = line ? `${line} ${w}` : w; w = ""; }
      else if (!line && w.length > n) { out.push(w.slice(0, n)); w = w.slice(n); }
      else { out.push(line); line = ""; }
    }
  }
  if (line) out.push(line);
  return out;
}

/** One bit per pixel, a row's bytes after its filter byte. */
function canvas() {
  const stride = W / 8 + 1;
  const px = new Uint8Array(stride * H);
  const dot = (x: number, y: number) => { if (x >= 0 && x < W && y >= 0 && y < H) px[y * stride + 1 + (x >> 3)] |= 0x80 >> (x & 7); };
  const text = (s: string, x0: number, y0: number, k: number) => {
    let x = x0;
    for (const c of s) {
      const rows = ROWS[c];
      rows.forEach((bits, r) => {
        for (let col = 0; col < 5; col++) if (bits & (0x10 >> col)) for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) dot(x + col * k + dx, y0 + r * k + dy);
      });
      x += 6 * k;
    }
  };
  return { px, text };
}

/** The lines of the title at the largest scale that fits four lines above
 *  the address. */
function fit(title: string): { k: number; lines: string[] } {
  for (const k of [16, 14, 12, 10, 8, 6]) {
    const lines = wrap(title, Math.floor((W - 2 * M) / (6 * k)));
    if (lines.length <= 4 && lines.length * 9 * k <= H - 2 * M - 60) return { k, lines };
  }
  return { k: 6, lines: wrap(title, Math.floor((W - 2 * M) / 36)).slice(0, 4) };
}

let table: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The card: `ink` the page's accent (#rrggbb), white letters on it. */
export async function cardPng(title: string, address: string, ink: string): Promise<Uint8Array> {
  const { px, text } = canvas();
  const { k, lines } = fit(drawable(title));
  lines.forEach((l, i) => text(l, M, M + i * 9 * k, k));
  const addr = drawable(address);
  const ak = addr.length * 24 <= W - 2 * M ? 4 : 3;
  text(addr, M, H - M - 7 * ak, ak);
  const hdr = new Uint8Array(13);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H);
  hdr.set([1, 3, 0, 0, 0], 8);
  const rgb = /^#[0-9a-f]{6}$/i.test(ink) ? ink : "#8c0f26";
  const plte = new Uint8Array([1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16)).concat([255, 255, 255]));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", hdr), chunk("PLTE", plte), chunk("IDAT", await zlib(px)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
