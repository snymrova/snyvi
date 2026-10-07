//! A picture inside a document, sized from its file: the few bytes of a
//! PNG, GIF, WebP or JPEG header that say its width and height, so the page
//! can give the picture its box and load it lazily without ever moving.

use super::*;

/// The `<img>` tag with its size and `loading="lazy"` on it, when the file
/// is one of the document's own and its header gives a size; `None` leaves
/// the tag as it was. A tag that already says its size or how to load is
/// the author's and is left alone.
pub(super) fn sized(tag: &str, path: &str, base: &str, dir: &Path) -> Option<String> {
    if tag.contains(" width=") || tag.contains(" loading=") {
        return None;
    }
    let rel = path.strip_prefix(base)?;
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        return None;
    }
    let ext = ext_of(rel);
    if !is_image_ext(&ext) || ext == "svg" {
        return None;
    }
    let (w, h) = picture_size_of(&dir.join(rel))?;
    let body = tag
        .strip_suffix("/>")
        .or_else(|| tag.strip_suffix('>'))?
        .trim_end();
    Some(format!(
        "{body} width=\"{w}\" height=\"{h}\" loading=\"lazy\" decoding=\"async\">"
    ))
}

/// The first bytes of a picture file, enough for every header `picture_size`
/// reads: a JPEG's size comes after its EXIF block, which can be tens of KB.
const PICTURE_HEAD: usize = 64 * 1024;

fn picture_size_of(file: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let f = std::fs::File::open(file).ok()?;
    let mut head = Vec::with_capacity(PICTURE_HEAD);
    f.take(PICTURE_HEAD as u64).read_to_end(&mut head).ok()?;
    picture_size(&head)
}

/// Width and height from a picture's header: PNG, JPEG, GIF, WebP. Bounds
/// are checked on every read, so a short or odd file gives `None`, never a
/// panic; a size of zero, which no picture has, gives `None` too.
pub(super) fn picture_size(b: &[u8]) -> Option<(u32, u32)> {
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
    };
    let be16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            b.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let le16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_le_bytes(
            b.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    let le24 = |at: usize| -> Option<u32> {
        let x = b.get(at..at + 3)?;
        Some(u32::from(x[0]) | u32::from(x[1]) << 8 | u32::from(x[2]) << 16)
    };
    let some = |w: u32, h: u32| (w > 0 && h > 0).then_some((w, h));
    // PNG: the signature, then IHDR, whose first eight bytes are the size.
    if b.starts_with(b"\x89PNG\r\n\x1a\n") && b.get(12..16) == Some(b"IHDR") {
        return some(be32(16)?, be32(20)?);
    }
    // GIF: the logical screen, right after the six-byte signature.
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return some(le16(6)?, le16(8)?);
    }
    // WebP: a RIFF file whose first chunk says which of the three kinds.
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        return match b.get(12..16)? {
            // Lossy: the frame header after the three-byte tag and the
            // start code, fourteen bits each.
            b"VP8 " => some(le16(26)? & 0x3fff, le16(28)? & 0x3fff),
            // Lossless: a signature byte, then 14 + 14 bits, minus one.
            b"VP8L" if b.get(20) == Some(&0x2f) => {
                let x = b.get(21..25)?;
                let w = (u32::from(x[0]) | (u32::from(x[1]) & 0x3f) << 8) + 1;
                let h =
                    (u32::from(x[1]) >> 6 | u32::from(x[2]) << 2 | (u32::from(x[3]) & 0x0f) << 10)
                        + 1;
                some(w, h)
            }
            // Extended: the canvas, 24 bits each, minus one.
            b"VP8X" => some(le24(24)? + 1, le24(27)? + 1),
            _ => None,
        };
    }
    // JPEG: segments from the SOI, until the first frame header (SOF0-15,
    // but not the tables DHT, JPG and DAC that share the range), whose
    // payload is precision, height, width.
    if b.starts_with(b"\xff\xd8") {
        let mut at = 2;
        while at + 4 <= b.len() {
            if b[at] != 0xff {
                return None;
            }
            let marker = b[at + 1];
            // Fill bytes before a marker.
            if marker == 0xff {
                at += 1;
                continue;
            }
            let len = be16(at + 2)? as usize;
            if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                return some(be16(at + 7)?, be16(at + 5)?);
            }
            // A standalone marker (RSTn, TEM) has no length.
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                at += 2;
                continue;
            }
            if len < 2 {
                return None;
            }
            at += 2 + len;
        }
        return None;
    }
    None
}
