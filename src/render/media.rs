//! A song or a video inside a document: which files a player takes, and the
//! player itself, a button until it is pressed (#117, #120), as the
//! renderer writes it and as an old document's is served.

use super::*;
use std::io::{Read, Seek, SeekFrom};

/// What a browser can play: video, then audio. `.ogg` is usually audio, and an
/// `<audio>` element plays it; `.ogv` is the video one.
pub const MEDIA_EXTS: &[(&str, &str)] = &[
    ("mp4", "video"),
    ("webm", "video"),
    ("mov", "video"),
    ("m4v", "video"),
    ("ogv", "video"),
    ("mp3", "audio"),
    ("wav", "audio"),
    ("m4a", "audio"),
    ("ogg", "audio"),
    ("oga", "audio"),
    ("flac", "audio"),
    ("opus", "audio"),
    ("aac", "audio"),
];

/// "video" or "audio" for an extension a player can take, else None.
pub fn media_kind(ext: &str) -> Option<&'static str> {
    MEDIA_EXTS.iter().find(|(e, _)| *e == ext).map(|(_, k)| *k)
}

/// The player for a media document or file, pointed at wherever its bytes are
/// served; `size` is a video's, from `media_size`.
pub fn media_body(src_url: &str, ext: &str, size: Option<(u32, u32)>) -> String {
    let src = html_escape::encode_double_quoted_attribute(src_url);
    let kind = media_kind(ext).unwrap_or("audio");
    format!(
        "<p class=\"doc-image doc-media\">{}</p>",
        player(kind, &src, "", size)
    )
}

/// The width and height a video shows at, for the kinds whose header says
/// so without decoding a frame: MP4 and QuickTime, the files a phone or a
/// screen recorder writes. Anything else, or a file that does not read as
/// one, is `None`, and its player keeps the 16:9 box.
pub fn media_size(ext: &str, mut file: impl Read + Seek) -> Option<(u32, u32)> {
    if !matches!(ext, "mp4" | "mov" | "m4v") {
        return None;
    }
    video_size(&mut file)
}

/// `media_size` of a file on disk.
pub fn media_size_at(ext: &str, path: &Path) -> Option<(u32, u32)> {
    media_size(ext, std::fs::File::open(path).ok()?)
}

/// From the first video track's `tkhd` in the `moov` box. The boxes are
/// walked by their headers alone, seeking past each body, so a `moov` at the
/// end of a 2 GB take (where a camera writes it) costs a few small reads. A
/// track turned a quarter by its matrix -- a phone held upright -- shows with
/// its width and height swapped, as a browser plays it.
fn video_size(r: &mut (impl Read + Seek)) -> Option<(u32, u32)> {
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let (mut at, moov_end) = find_box(r, 0, end, b"moov")?;
    while let Some((body, next, kind)) = next_box(r, at, moov_end) {
        if &kind == b"trak" {
            if let Some(size) = find_box(r, body, next, b"tkhd").and_then(|(b, _)| tkhd(r, b)) {
                return Some(size);
            }
        }
        at = next;
    }
    None
}

/// The box starting at `at`, if it fits before `end`: where its body starts,
/// where it ends, and its four-letter type.
fn next_box(r: &mut (impl Read + Seek), at: u64, end: u64) -> Option<(u64, u64, [u8; 4])> {
    let mut head = [0u8; 16];
    r.seek(SeekFrom::Start(at)).ok()?;
    r.read_exact(&mut head[..8]).ok()?;
    let kind: [u8; 4] = head[4..8].try_into().ok()?;
    let (len, body) = match u32::from_be_bytes(head[..4].try_into().ok()?) {
        0 => (end.checked_sub(at)?, 8),
        1 => {
            r.read_exact(&mut head[8..16]).ok()?;
            (u64::from_be_bytes(head[8..16].try_into().ok()?), 16)
        }
        n => (u64::from(n), 8),
    };
    (len >= body && at.checked_add(len)? <= end).then_some((at + body, at + len, kind))
}

/// The first box of type `kind` between `at` and `end`: its body and end.
fn find_box(
    r: &mut (impl Read + Seek),
    mut at: u64,
    end: u64,
    kind: &[u8; 4],
) -> Option<(u64, u64)> {
    while let Some((body, next, k)) = next_box(r, at, end) {
        if &k == kind {
            return Some((body, next));
        }
        at = next;
    }
    None
}

/// A track header's size, when it is a picture's (a sound's is 0 by 0).
/// Version 0 keeps its times in 32 bits and version 1 in 64, which moves
/// the matrix and the 16.16 width and height after them.
fn tkhd(r: &mut (impl Read + Seek), body: u64) -> Option<(u32, u32)> {
    let mut b = [0u8; 96];
    r.seek(SeekFrom::Start(body)).ok()?;
    r.read_exact(&mut b[..1]).ok()?;
    let len = if b[0] == 1 { 96 } else { 84 };
    r.read_exact(&mut b[1..len]).ok()?;
    let at = if b[0] == 1 { 36 } else { 24 };
    let be = |i: usize| i32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let (w, h) = (be(at + 52) as u32 >> 16, be(at + 56) as u32 >> 16);
    if w == 0 || h == 0 {
        return None;
    }
    // The matrix's a and d are 0 when it turns the picture a quarter.
    let quarter = be(at + 16) == 0 && be(at + 32) == 0;
    Some(if quarter { (h, w) } else { (w, h) })
}

/// A player as a button until it is pressed (#117, #120). In the Linux
/// window's engine (WebKitGTK) an `<audio controls>` is a GStreamer pipeline
/// and a scripted set of controls the moment it is in the page: 83 of them
/// held the page 1.9 s before a byte was fetched, and `preload="metadata"`
/// then fetched all 83 and stuttered on for 8 s more. Worse, a player that
/// had loaded ahead and sat waiting took 8.6 s from Play to sound, where one
/// made on the press sounds in half a second. Chromium does neither, which is
/// why the web was quick and the window was not.
///
/// So the real element waits in a `<template>`, inert -- 83 of these cost
/// 13 ms -- and a press plays it (`ui/app/04-doc.js`, `data-w="play"`). A
/// video takes the button's place; a song keeps it, and `ui/player.js` makes
/// the pill its controls, since WebKit's own clip their volume slider to a
/// 54 px box. The button is the player's own box, a song's 54 px or a video's
/// shape (`size`, else 16:9), so the press moves nothing. What it costs is
/// the length and a video's first frame, unseen until Play. The template
/// keeps `controls`: the page takes them off a song, and a video uses them.
///
/// `src` and `title` come already escaped for a double-quoted attribute
/// (the Markdown path copies them across from comrak and ammonia), and an
/// attribute-escaped string reads the same as text. Styled inline: app.css
/// is first paint, at its budget, and a player is only ever in a document.
pub fn player(kind: &str, src: &str, title: &str, size: Option<(u32, u32)>) -> String {
    let label = if title.is_empty() {
        file_label(src)
    } else {
        title.to_string()
    };
    let titled = if title.is_empty() {
        String::new()
    } else {
        format!(" title=\"{title}\"")
    };
    // A video of known shape is that shape, as wide as the column allows
    // and no taller than 70vh, centred; one of unknown shape is 16:9 and
    // letterboxed. Either way the box is there before a byte of it is.
    let shape = match size {
        Some((w, h)) => {
            format!("width:min(100%,calc(70vh * {w} / {h}));aspect-ratio:{w}/{h};margin:0 auto")
        }
        None => "width:100%;aspect-ratio:16/9;max-height:70vh".to_string(),
    };
    let (el, look, face) = if kind == "video" {
        (
            "video",
            format!("display:block;{shape};object-fit:contain;background:#000;border-radius:var(--radius)"),
            format!(
                "display:flex;align-items:center;justify-content:center;gap:10px;{shape};\
                 background:#000;color:#fff;border:0;border-radius:var(--radius)"
            ),
        )
    } else {
        (
            "audio",
            "display:block;width:100%;height:54px".to_string(),
            "display:flex;align-items:center;gap:12px;width:100%;height:54px;padding:0 18px;\
             box-sizing:border-box;border:1px solid var(--rule-2);border-radius:27px;\
             background:var(--bg-raise);color:var(--fg)"
                .to_string(),
        )
    };
    format!(
        "<button type=\"button\" class=\"doc-play\" data-w=\"play\" aria-label=\"Play {label}\" \
         style=\"{face};font:inherit;text-align:left;cursor:pointer\">\
         <span aria-hidden=\"true\">\u{25b6}</span>\
         <span style=\"min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">{label}</span>\
         </button><template><{el} controls preload=\"auto\" src=\"{src}\"{titled} style=\"{look}\"></{el}></template>"
    )
}

/// The file a player plays, by name, for a player with no title: the last
/// part of `src` (attribute-escaped), its `%20`s read, escaped again. Only
/// what an attribute's escaping writes is read back: html_escape's decoder
/// knows all 2,125 named entities, and its table put the binary over its
/// budget for a file name.
fn file_label(src: &str) -> String {
    let src = src
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let path = src.split(['?', '#']).next().unwrap_or("");
    let name = path.rsplit('/').next().unwrap_or(path);
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    html_escape::encode_double_quoted_attribute(&String::from_utf8_lossy(&out)).into_owned()
}

/// A document stored before 1.34 holds the old players, made in the page the
/// moment it opens (`player`). Turned into buttons as it is served, so a
/// document already in the library opens as quickly as a new one, with no
/// resend and nothing rewritten in the store.
pub fn lazy_players(html: &str) -> std::borrow::Cow<'_, str> {
    const OLD: [(&str, &str); 2] = [
        ("audio", "<audio controls preload=\"metadata\" src=\""),
        ("video", "<video controls preload=\"metadata\" src=\""),
    ];
    if !OLD.iter().any(|(_, o)| html.contains(o)) {
        return std::borrow::Cow::Borrowed(html);
    }
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let next = OLD
            .iter()
            .filter_map(|(k, o)| rest.find(o).map(|i| (i, *k, *o)))
            .min_by_key(|(i, ..)| *i);
        let Some((i, kind, open)) = next else { break };
        let tail = &rest[i..];
        let close = format!("</{kind}>");
        let (Some(end), Some(gt)) = (tail.find(&close), tail.find('>')) else {
            break;
        };
        let tag = &tail[..gt];
        let src = &tag[open.len()..];
        let src = &src[..src.find('"').unwrap_or(src.len())];
        let title = tag
            .find(" title=\"")
            .map(|t| &tag[t + 8..])
            .map(|t| &t[..t.find('"').unwrap_or(t.len())])
            .unwrap_or("");
        out.push_str(&rest[..i]);
        out.push_str(&player(kind, src, title, None));
        rest = &tail[end + close.len()..];
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// A Markdown image whose path is a video or a song, `![take 2](take2.mp4)`,
/// becomes a player for it, the alt text its title. Done on the finished
/// HTML, where comrak (`<img src=".." alt=".." />`) and ammonia
/// (`<img src=".." alt="..">`) both write the attributes escaped and
/// double-quoted, so they are copied across as they are.
///
/// It is a button until pressed (`player`). A video beside the document
/// sits in its own shape from the first paint, read from its header
/// (`media_size`); one whose shape cannot be read, in a 16:9 box,
/// letterboxed. Either way the page does not move when the take arrives; a
/// song's is one fixed height.
///
/// A picture under the document's own folder (`files`: the `/files/<id>/`
/// prefix its paths carry, and the folder on disk) is given its size from
/// the file's header and `loading="lazy"`: a page of screenshots fetches
/// only the ones in view, and the box of each is there before it is, so
/// nothing moves when one arrives. A picture whose size cannot be read --
/// a remote one, an SVG, a file that is not what its name says -- stays as
/// it was: eager, and never a shift.
pub(super) fn players(html: String, files: Option<(&str, &Path)>) -> String {
    const IMG: &str = "<img src=\"";
    if !html.contains(IMG) {
        return html;
    }
    let attr = |tag: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        let end = tag[at..].find('"')?;
        Some(tag[at..at + end].to_string())
    };
    let mut out = String::with_capacity(html.len());
    let mut rest = html.as_str();
    while let Some(i) = rest.find(IMG) {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let Some(close) = tail.find('>') else {
            break;
        };
        let tag = &tail[..=close];
        let src = attr(tag, "src").unwrap_or_default();
        let path = src.split(['?', '#']).next().unwrap_or("");
        match media_kind(&ext_of(path)) {
            None => match files.and_then(|(base, dir)| sized(tag, path, base, dir)) {
                Some(t) => out.push_str(&t),
                None => out.push_str(tag),
            },
            Some(kind) => {
                let size = files
                    .filter(|_| kind == "video")
                    .and_then(|(base, dir)| own_file(path, base, dir))
                    .and_then(|f| media_size_at(&ext_of(path), &f));
                out.push_str(&player(
                    kind,
                    &src,
                    &attr(tag, "alt").unwrap_or_default(),
                    size,
                ))
            }
        }
        rest = &tail[close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_or_a_song_in_markdown_plays_in_place() {
        let r = Renderer::new();
        let md = |src: &str| r.render_with_base(Kind::Markdown, None, src, Some("/files/abc/"));
        for (file, tag) in [
            (
                "take2.mp4",
                "<template><video controls preload=\"auto\" src=\"/files/abc/take2.mp4\"",
            ),
            (
                "cut.webm",
                "<template><video controls preload=\"auto\" src=\"/files/abc/cut.webm\"",
            ),
            (
                "song.mp3",
                "<template><audio controls preload=\"auto\" src=\"/files/abc/song.mp3\"",
            ),
            (
                "bed.ogg",
                "<template><audio controls preload=\"auto\" src=\"/files/abc/bed.ogg\"",
            ),
        ] {
            let html = md(&format!("Here:\n\n![take \"2\"]({file})\n"));
            assert!(html.contains(tag), "{file}: {html}");
            assert!(
                html.contains("title=\"take &quot;2&quot;\""),
                "{file}: {html}"
            );
            assert!(!html.contains("<img"), "{file}: {html}");
            // Until Play, a button the page swaps for the template's player
            // (#117, #120); nothing outside a template is a player.
            assert!(
                html.contains("data-w=\"play\" aria-label=\"Play take &quot;2&quot;\""),
                "{file}: {html}"
            );
            let outside = html.split("<template>").next().unwrap_or("");
            assert!(
                !outside.contains("<audio") && !outside.contains("<video"),
                "{file}: {html}"
            );
        }
        // A video's box is there before its size is known, so nothing moves.
        assert!(md("![a](a.mp4)").contains("aspect-ratio:16/9"));
        // A picture stays a picture, and a query is not an extension.
        assert!(md("![a](a.png)").contains("<img src=\"/files/abc/a.png\""));
        assert!(md("![a](a.mp4?t=3)").contains("<video"));
        // Raw HTML takes the sanitizer's road and still gets its player, but
        // a player written by hand does not get through.
        let raw =
            md("<b>hi</b>\n\n![a](a.mp4)\n\n<video src=\"x.mp4\" onplay=\"alert(1)\"></video>");
        assert_eq!(raw.matches("<video").count(), 1, "{raw}");
        assert!(!raw.contains("onplay"), "{raw}");
    }

    /// A document stored with the old players opens with buttons all the
    /// same, its titles and sources kept; one with none is not copied.
    #[test]
    fn an_old_player_is_a_button_as_it_is_served() {
        let old = "<p>a</p><audio controls preload=\"metadata\" src=\"/files/x/my%20take.mp3\" \
                   style=\"display:block;width:100%;height:54px\"></audio>\
                   <p class=\"doc-image doc-media\"><video controls preload=\"metadata\" src=\"/files/x/cut.mp4\" title=\"Cut &amp; run\" \
                   style=\"max-width:100%\"></video></p><p>b</p>";
        let new = lazy_players(old);
        assert!(new.starts_with("<p>a</p><button"), "{new}");
        assert!(new.ends_with("</template></p><p>b</p>"), "{new}");
        assert!(new.contains("aria-label=\"Play my take.mp3\""), "{new}");
        assert!(new.contains("aria-label=\"Play Cut &amp; run\""), "{new}");
        assert!(new.contains("<template><video controls preload=\"auto\" src=\"/files/x/cut.mp4\" title=\"Cut &amp; run\""), "{new}");
        assert!(!new.contains("preload=\"metadata\""), "{new}");
        assert!(matches!(
            lazy_players("<p>none</p>"),
            std::borrow::Cow::Borrowed(_)
        ));
        // A song sent on its own is the same button.
        let one = media_body("/files/x/a%3Cb.ogg", "ogg", None);
        assert!(one.contains("aria-label=\"Play a&lt;b.ogg\""), "{one}");
        assert!(one.contains("<template><audio controls"), "{one}");
    }

    /// An MP4 box: its length, its type, its body.
    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    /// A track header of `version`, `w` by `h`, turned a quarter or not.
    fn tkhd_box(version: u8, w: u32, h: u32, quarter: bool) -> Vec<u8> {
        let mut b = vec![version, 0, 0, 7];
        b.extend(vec![0u8; if version == 1 { 32 } else { 20 }]);
        b.extend([0u8; 16]);
        let one = 0x0001_0000u32.to_be_bytes();
        let less = (-0x0001_0000i32).to_be_bytes();
        let (a, bb, c, d) = if quarter {
            ([0; 4], one, less, [0; 4])
        } else {
            (one, [0; 4], [0; 4], one)
        };
        for x in [
            a,
            bb,
            [0; 4],
            c,
            d,
            [0; 4],
            [0; 4],
            [0; 4],
            0x4000_0000u32.to_be_bytes(),
        ] {
            b.extend(x);
        }
        b.extend((w << 16).to_be_bytes());
        b.extend((h << 16).to_be_bytes());
        b
    }

    fn take(tracks: &[Vec<u8>], moov_last: bool) -> Vec<u8> {
        let traks: Vec<u8> = tracks
            .iter()
            .flat_map(|t| mp4_box(b"trak", &mp4_box(b"tkhd", t)))
            .collect();
        let moov = mp4_box(b"moov", &[mp4_box(b"mvhd", &[0; 100]), traks].concat());
        let mdat = mp4_box(b"mdat", &[9; 300]);
        let ftyp = mp4_box(b"ftyp", b"isom\0\0\x02\0");
        if moov_last {
            [ftyp, mdat, moov].concat()
        } else {
            [ftyp, moov, mdat].concat()
        }
    }

    #[test]
    fn a_video_has_the_shape_its_header_says() {
        let size = |b: Vec<u8>, ext: &str| media_size(ext, std::io::Cursor::new(b));
        // A phone held upright: stored 1920 by 1080, turned a quarter, after
        // a sound's track and with its moov last.
        let phone = take(
            &[tkhd_box(0, 0, 0, false), tkhd_box(0, 1920, 1080, true)],
            true,
        );
        assert_eq!(size(phone.clone(), "mov"), Some((1080, 1920)));
        assert_eq!(
            size(take(&[tkhd_box(1, 1280, 720, false)], false), "mp4"),
            Some((1280, 720))
        );
        // Not a kind whose header is read, a sound alone, a file cut short.
        assert_eq!(size(phone.clone(), "webm"), None);
        assert_eq!(size(take(&[tkhd_box(0, 0, 0, false)], false), "mp4"), None);
        assert_eq!(size(phone[..phone.len() - 20].to_vec(), "mp4"), None);
        assert_eq!(size(b"not a video at all".to_vec(), "mp4"), None);

        // In a document, the take beside it gets its box; one without a
        // readable header keeps 16:9.
        let dir = std::env::temp_dir().join(format!("snyvi-video-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("up.mov"), &phone).unwrap();
        std::fs::write(dir.join("odd.mp4"), b"nope").unwrap();
        let html = Renderer::new().render_with_files(
            Kind::Markdown,
            None,
            "![up](up.mov)\n\n![odd](odd.mp4)\n",
            Some("/files/abc/"),
            Some(&dir),
        );
        let _ = std::fs::remove_dir_all(&dir);
        let up = "width:min(100%,calc(70vh * 1080 / 1920));aspect-ratio:1080/1920;margin:0 auto";
        assert_eq!(
            html.matches(up).count(),
            2,
            "the button and the video: {html}"
        );
        assert_eq!(html.matches("aspect-ratio:16/9").count(), 2, "{html}");
    }
}
