//! A page's accent, from its logo (design round 40303cb7e4).
//!
//! The mark is quantised to 32 colours and scored the way Material's
//! `Score` does: anything with a chroma under 5 is dropped, each colour
//! scores 0.7 × the share of the mark near its hue plus how near its chroma
//! is to 48 (0.1 a point below, 0.3 a point above), hues are kept 15° apart,
//! and the first is the seed. The seed then **snaps to the nearest of
//! snyvi's eight accents by hue**, because those eight are the ones
//! `bench/page.mjs` proves at 4.5:1 on every surface; a seed under chroma 12
//! is graphite. The seed's own hex is kept as the page's **wash**, the faint
//! tint behind its hero, never ink.
//!
//! Chroma and hue are CIE LCh(ab) under D65, whose chroma runs on about the
//! scale Material's HCT does (0 to ~130), so its numbers carry over.
//!
//! PNG and SVG only. A PNG is read here, inflated with `flate2` (in the tree
//! already) and unfiltered by hand: 8- and 16-bit, grey, RGB, palette and
//! their alpha, not interlaced. An SVG is read by its fill colours, with no
//! rasteriser. Anything else is graphite with no wash, and the swatch still
//! offers the other seven.

use std::io::Read;

/// The eight, in the swatch's order, each with the light ink its hue is read
/// from (`ui/app.css`, `--accent-l`). Passion is the default.
pub const EIGHT: [(&str, &str); 8] = [
    ("passion", "#8c0f26"),
    ("crimson", "#b91c1c"),
    ("rose", "#be185d"),
    ("violet", "#7c3aed"),
    ("blue", "#1d4ed8"),
    ("teal", "#0f766e"),
    ("green", "#137639"),
    ("graphite", "#57534e"),
];

/// One of the eight's names.
pub fn is_accent(s: &str) -> bool {
    EIGHT.iter().any(|(n, _)| *n == s)
}

/// What a logo gives the page: one of the eight, and the seed's hex as the
/// wash (empty when the mark has no colour of its own).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accent {
    pub name: &'static str,
    pub wash: String,
}

impl Accent {
    fn graphite() -> Accent {
        Accent {
            name: "graphite",
            wash: String::new(),
        }
    }
}

/// A logo's accent, from its bytes and its extension (`png`, `svg`).
pub fn accent_of(bytes: &[u8], ext: &str) -> Accent {
    let colours = match ext {
        "png" => png_pixels(bytes).map(|p| quantise(&p)).unwrap_or_default(),
        "svg" => svg_fills(bytes),
        _ => Vec::new(),
    };
    match seed(&colours) {
        Some((rgb, chroma, hue)) => Accent {
            name: if chroma < 12.0 { "graphite" } else { snap(hue) },
            wash: hex(rgb),
        },
        None => Accent::graphite(),
    }
}

type Rgb = [u8; 3];

/// The seed out of weighted colours: Material's score, the first kept.
/// `(colour, chroma, hue)`.
fn seed(colours: &[(Rgb, f64)]) -> Option<(Rgb, f64, f64)> {
    let total: f64 = colours.iter().map(|(_, w)| w).sum();
    if total <= 0.0 {
        return None;
    }
    let lch: Vec<(Rgb, f64, f64, f64)> = colours
        .iter()
        .map(|(c, w)| {
            let (_, ch, h) = lch_of(*c);
            (*c, ch, h, w / total)
        })
        .filter(|(_, ch, _, _)| *ch >= 5.0)
        .collect();
    let mut scored: Vec<(f64, Rgb, f64, f64)> = lch
        .iter()
        .filter_map(|(c, ch, h, _)| {
            // The share of the mark within 15° of this hue, as Material
            // weighs a colour by its neighbourhood rather than its bucket.
            let near: f64 = lch
                .iter()
                .filter(|(_, _, h2, _)| hue_gap(*h, *h2) <= 15.0)
                .map(|(_, _, _, s)| s)
                .sum();
            // A speck of colour on a grey mark is grey: under 1% is noise.
            if near < 0.01 {
                return None;
            }
            let pull = if *ch < 48.0 { 0.1 } else { 0.3 };
            Some((0.7 * near * 100.0 + (ch - 48.0) * pull, *c, *ch, *h))
        })
        .collect();
    // Highest first. Material keeps the next ones 15° from those before;
    // a page wants only the first, so that rule has nothing to drop here.
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.first().map(|s| (s.1, s.2, s.3))
}

/// The nearest of the seven with a hue, by hue.
fn snap(hue: f64) -> &'static str {
    EIGHT[..7]
        .iter()
        .map(|(n, h)| (*n, lch_of(parse_hex(h).unwrap_or([0; 3])).2))
        .min_by(|a, b| hue_gap(hue, a.1).total_cmp(&hue_gap(hue, b.1)))
        .map(|(n, _)| n)
        .unwrap_or("passion")
}

fn hue_gap(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    d.min(360.0 - d)
}

/// sRGB to CIE LCh(ab), D65: lightness, chroma, hue in degrees.
pub fn lch_of(c: Rgb) -> (f64, f64, f64) {
    let lin = |v: u8| {
        let v = v as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f64| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            (24389.0 / 27.0 * t + 16.0) / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    let (l, a, bb) = (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
    let h = bb.atan2(a).to_degrees();
    (
        l,
        (a * a + bb * bb).sqrt(),
        if h < 0.0 { h + 360.0 } else { h },
    )
}

pub fn hex(c: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// `#rgb` or `#rrggbb`.
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let h = s.strip_prefix('#')?;
    let v = |s: &str| u8::from_str_radix(s, 16).ok();
    match h.len() {
        3 => {
            let d: Vec<u8> = h
                .chars()
                .map(|c| c.to_digit(16).map(|d| (d * 17) as u8))
                .collect::<Option<_>>()?;
            Some([d[0], d[1], d[2]])
        }
        6 => Some([v(&h[0..2])?, v(&h[2..4])?, v(&h[4..6])?]),
        _ => None,
    }
}

/// The 32 commonest colours of the opaque pixels, each the mean of its
/// bucket (4 bits a channel), weighted by how many pixels it is.
fn quantise(px: &[Rgb]) -> Vec<(Rgb, f64)> {
    let mut buckets = vec![(0u64, 0u64, 0u64, 0u64); 4096];
    for p in px {
        let i = ((p[0] as usize >> 4) << 8) | ((p[1] as usize >> 4) << 4) | (p[2] as usize >> 4);
        let b = &mut buckets[i];
        b.0 += p[0] as u64;
        b.1 += p[1] as u64;
        b.2 += p[2] as u64;
        b.3 += 1;
    }
    let mut kept: Vec<(Rgb, f64)> = buckets
        .into_iter()
        .filter(|b| b.3 > 0)
        .map(|(r, g, b, n)| ([(r / n) as u8, (g / n) as u8, (b / n) as u8], n as f64))
        .collect();
    kept.sort_by(|a, b| b.1.total_cmp(&a.1));
    kept.truncate(32);
    kept
}

/// An SVG's colours: every `fill` and `stop-color`, as an attribute or in a
/// style, counted once each. `none`, `currentColor` and `url(…)` say no
/// colour and are skipped.
fn svg_fills(bytes: &[u8]) -> Vec<(Rgb, f64)> {
    let text = String::from_utf8_lossy(bytes);
    let mut seen: Vec<(Rgb, f64)> = Vec::new();
    for key in ["fill", "stop-color"] {
        let mut rest: &str = &text;
        while let Some(i) = rest.find(key) {
            let after = &rest[i + key.len()..];
            rest = after;
            let v = after.trim_start();
            let Some(v) = v.strip_prefix('=').or_else(|| v.strip_prefix(':')) else {
                continue;
            };
            let v = v.trim_start().trim_start_matches(['"', '\'']);
            let end = v.find(['"', '\'', ';', ' ', '>', '/']).unwrap_or(v.len());
            if let Some(c) = colour_word(&v[..end.min(v.len())], v) {
                match seen.iter_mut().find(|(s, _)| *s == c) {
                    Some(s) => s.1 += 1.0,
                    None => seen.push((c, 1.0)),
                }
            }
        }
    }
    seen
}

/// `#…`, or `rgb(r, g, b)` read from the full rest when the word is its head.
fn colour_word(word: &str, rest: &str) -> Option<Rgb> {
    if word.starts_with('#') {
        return parse_hex(word);
    }
    let inner = rest.strip_prefix("rgb(")?;
    let inner = &inner[..inner.find(')')?];
    let n: Vec<u8> = inner
        .split(',')
        .map(|p| p.trim().parse::<u8>().ok())
        .collect::<Option<_>>()?;
    (n.len() == 3).then(|| [n[0], n[1], n[2]])
}

/// The most pixels read from a mark, and the most bytes it inflates to: a
/// logo is at most 400 KB on disk, and nothing past this changes its colour.
const MAX_PIXELS: u64 = 4096 * 4096;
const MAX_INFLATED: u64 = 80 << 20;

/// A PNG's opaque pixels as RGB, every one of them up to `MAX_PIXELS`.
/// `None` for anything not read here: interlaced, broken, too big.
pub fn png_pixels(b: &[u8]) -> Option<Vec<Rgb>> {
    if !b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut at = 8;
    let (mut w, mut h, mut depth, mut ct) = (0u32, 0u32, 0u8, 0u8);
    let (mut plte, mut trns, mut idat) = (Vec::new(), Vec::new(), Vec::new());
    while at + 8 <= b.len() {
        let len = u32::from_be_bytes(b[at..at + 4].try_into().ok()?) as usize;
        let kind = &b[at + 4..at + 8];
        let data = b.get(at + 8..at + 8 + len)?;
        match kind {
            b"IHDR" if len >= 13 => {
                w = u32::from_be_bytes(data[0..4].try_into().ok()?);
                h = u32::from_be_bytes(data[4..8].try_into().ok()?);
                depth = data[8];
                ct = data[9];
                if data[12] != 0 {
                    return None;
                }
            }
            b"PLTE" => plte = data.to_vec(),
            b"tRNS" => trns = data.to_vec(),
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        at += 12 + len;
    }
    if w == 0 || h == 0 || (w as u64) * (h as u64) > MAX_PIXELS {
        return None;
    }
    let channels: usize = match ct {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        _ => return None,
    };
    if !matches!(depth, 1 | 2 | 4 | 8 | 16) || (depth < 8 && !matches!(ct, 0 | 3)) {
        return None;
    }
    let bits = channels * depth as usize;
    let stride = (w as usize * bits).div_ceil(8);
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(&idat[..])
        .take(MAX_INFLATED)
        .read_to_end(&mut raw)
        .ok()?;
    let rows = unfilter(&raw, stride, bits.div_ceil(8), h as usize)?;
    let mut out = Vec::with_capacity((w * h) as usize);
    for row in rows.chunks(stride) {
        for x in 0..w as usize {
            if let Some(p) = pixel(row, x, ct, depth, &plte, &trns) {
                out.push(p);
            }
        }
    }
    Some(out)
}

/// Undo each scanline's filter (None, Sub, Up, Average, Paeth).
fn unfilter(raw: &[u8], stride: usize, bpp: usize, h: usize) -> Option<Vec<u8>> {
    let mut out = vec![0u8; stride * h];
    for y in 0..h {
        let line = raw.get(y * (stride + 1)..(y + 1) * (stride + 1))?;
        let (f, src) = (line[0], &line[1..]);
        for x in 0..stride {
            let a = if x >= bpp {
                out[y * stride + x - bpp]
            } else {
                0
            };
            let up = if y > 0 { out[(y - 1) * stride + x] } else { 0 };
            let c = if y > 0 && x >= bpp {
                out[(y - 1) * stride + x - bpp]
            } else {
                0
            };
            let pred = match f {
                0 => 0,
                1 => a,
                2 => up,
                3 => ((a as u16 + up as u16) / 2) as u8,
                4 => paeth(a, up, c),
                _ => return None,
            };
            out[y * stride + x] = src[x].wrapping_add(pred);
        }
    }
    Some(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i16 + b as i16 - c as i16;
    let (pa, pb, pc) = (
        (p - a as i16).abs(),
        (p - b as i16).abs(),
        (p - c as i16).abs(),
    );
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// Pixel `x` of an unfiltered row, or `None` when it is mostly transparent.
fn pixel(row: &[u8], x: usize, ct: u8, depth: u8, plte: &[u8], trns: &[u8]) -> Option<Rgb> {
    // A sample: the high byte of a 16-bit one, or a sub-byte one unpacked.
    let sample = |i: usize| -> u8 {
        match depth {
            16 => row[i * 2],
            8 => row[i],
            d => {
                let per = 8 / d as usize;
                let byte = row[i / per];
                let shift = 8 - d as usize * (i % per + 1);
                let v = (byte >> shift) & ((1u8 << d) - 1);
                if ct == 3 {
                    v
                } else {
                    (v as u16 * 255 / ((1u16 << d) - 1)) as u8
                }
            }
        }
    };
    let (rgb, alpha) = match ct {
        0 => {
            let g = sample(x);
            ([g, g, g], 255)
        }
        2 => ([sample(x * 3), sample(x * 3 + 1), sample(x * 3 + 2)], 255),
        3 => {
            let i = sample(x) as usize;
            let p = plte.get(i * 3..i * 3 + 3)?;
            ([p[0], p[1], p[2]], trns.get(i).copied().unwrap_or(255))
        }
        4 => {
            let g = sample(x * 2);
            ([g, g, g], sample(x * 2 + 1))
        }
        _ => (
            [sample(x * 4), sample(x * 4 + 1), sample(x * 4 + 2)],
            sample(x * 4 + 3),
        ),
    };
    (alpha >= 128).then_some(rgb)
}
