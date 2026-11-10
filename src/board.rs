//! A board: frames an agent draws, in a desk's folder, that the reader
//! watches arrive (plan 6ff79c55a7, docs/BOARD.md).
//!
//! **On disk** a board is `design/<board>/`: one HTML file per frame and a
//! `board.json` with each frame's size, place, order and whether it is
//! hidden. `design/DESIGN.md` and `design/tokens.css`, beside the boards,
//! are what the agent reads before its first frame (`tokens`). The folder is
//! the truth: a frame file written some other way than `write` (Claude's own
//! Write tool) is still on the board, placed after the rest (`read`).
//!
//! **Paths.** A board's name and a frame's id are both
//! `^[a-z0-9][a-z0-9-]{0,63}$`, checked before any path is built. The
//! board's directory is then made if missing and canonicalized, one level
//! at a time, and must stay under the canonical desk root (`dir`). Only then
//! is `<id>.html` joined: a new frame has no file to canonicalize yet. A
//! frame file that is a symlink is refused on read; a write replaces it by
//! rename, which replaces the link rather than following it.
//!
//! **Versions.** Every write goes through `receive::receive` with origin
//! `board` (`send`), so the store keeps each version and nothing is lost.
//! The origin is quiet and coalesces only with itself, within 20 s.
//!
//! **Nothing is deleted.** Hiding a frame is a flag in `board.json`; the file
//! stays, and so does every version in the store.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The folder, under a desk's root, every board is in.
pub const DIR: &str = "design";
/// Largest frame accepted. A frame is meant to be 300 to 3,000 bytes (the
/// skill says so); this is only the line past which it is not a frame.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
/// Largest side of a frame, in CSS pixels.
pub const MAX_SIDE: u32 = 4000;
/// The width a frame gets when nothing said one: a file that arrived some
/// other way, or a write that left a size out.
const DEFAULT_W: u32 = 800;
/// A frame's height when nothing said one is 0: its content's (1.62). The
/// window draws a section without a script in one document with the rest
/// and measures it; a frame with a script is still its own sandboxed page,
/// which cannot be measured, so it is drawn this tall when no height was
/// given -- here for the export, in ui/board for the window.
pub const ISLAND_H: u32 = 600;
/// The gap between frames placed one after another.
const GAP: i64 = 80;

/// A board's name or a frame's id: lowercase letters, digits and hyphens,
/// starting with a letter or a digit, at most 64.
pub fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Frame {
    pub id: String,
    /// What the label says; the id when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub w: u32,
    #[serde(default)]
    pub h: u32,
    #[serde(default)]
    pub x: i64,
    #[serde(default)]
    pub y: i64,
    #[serde(default)]
    pub order: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Where a live frame's numbers come from (1.61, C7): one of
    /// `told::SOURCES`, which the daemon reads and the window posts into the
    /// frame. Empty for a frame that only shows its file.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Board {
    /// The board's title; its folder's name when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub frames: Vec<Frame>,
}

/// One board, as the desk's view switcher lists it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BoardHead {
    /// The folder's name: what routes and tools name it by.
    pub id: String,
    pub name: String,
    pub frames: usize,
}

/// A frame as it is read: its place, and what is in its file now.
#[derive(Clone, Debug, Serialize)]
pub struct FrameRead {
    #[serde(flatten)]
    pub frame: Frame,
    /// blake3 of the file's bytes, first 16 hex: what the page loads it by
    /// (`?v=`), and what tells a rewritten frame from an unchanged one.
    pub hash: String,
    pub bytes: usize,
    /// The file is in `board.json` but not on disk.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    /// It has a script (`is_island`): drawn in a document of its own, as a
    /// frame was before 1.62, not as a section of the board's one document.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub island: bool,
}

/// `design/tokens.css`'s custom properties and `DESIGN.md`'s first
/// paragraph: what the agent reads before its first frame.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Tokens {
    pub vars: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design: Option<String>,
}

fn short_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..16].to_string()
}

/// `root/design`, canonical and under the canonical root. Made when `make`
/// and missing; `None` when missing and not made.
fn design_dir(root: &Path, make: bool) -> Result<Option<(PathBuf, PathBuf)>> {
    let root = root
        .canonicalize()
        .with_context(|| format!("the desk's folder {}", root.display()))?;
    let design = root.join(DIR);
    if !design.exists() {
        if !make {
            return Ok(None);
        }
        std::fs::create_dir(&design).with_context(|| format!("making {}", design.display()))?;
    }
    let design = design.canonicalize()?;
    if !design.starts_with(&root) || !design.is_dir() {
        bail!("{DIR}/ is not a folder inside the desk's folder");
    }
    Ok(Some((root, design)))
}

/// A board's directory, checked: the name first, then each level made if
/// `make` and canonicalized under the desk root. `None` when it does not
/// exist and was not to be made.
pub fn dir(root: &Path, board: &str, make: bool) -> Result<Option<PathBuf>> {
    if !valid_name(board) {
        bail!("a board's name is lowercase letters, digits and hyphens: {board:?}");
    }
    let Some((root, design)) = design_dir(root, make)? else {
        return Ok(None);
    };
    let d = design.join(board);
    if !d.exists() {
        if !make {
            return Ok(None);
        }
        std::fs::create_dir(&d).with_context(|| format!("making {}", d.display()))?;
    }
    let d = d.canonicalize()?;
    if !d.starts_with(&root) || !d.is_dir() {
        bail!("{DIR}/{board}/ is not a folder inside the desk's folder");
    }
    Ok(Some(d))
}

/// A frame's file in a checked board directory. The id is checked here, and
/// the file is never canonicalized: it may not exist yet.
fn frame_path(dir: &Path, id: &str) -> Result<PathBuf> {
    if !valid_name(id) {
        bail!("a frame's id is lowercase letters, digits and hyphens: {id:?}");
    }
    Ok(dir.join(format!("{id}.html")))
}

/// A frame's bytes, refusing a symlink: a link planted in the folder must not
/// make the page or the agent read a file outside it.
fn read_frame(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    std::fs::read(path).ok()
}

/// Write `bytes` to `path` by a temporary file and a rename: a reader of the
/// file sees the old bytes or the new, never half.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("a file name")?;
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

/// `board.json`, strictly: missing is an empty board, unreadable is an
/// error. What a write starts from, so a file the reader broke by hand is
/// refused rather than overwritten with what could be made of it.
fn load(dir: &Path) -> Result<Board> {
    let path = dir.join("board.json");
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("{} is not a board; fix or move it first", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Board::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// `board.json`, leniently: what can be read of it, frame by frame. What the
/// page and `board_read` see; never written back.
fn load_lenient(dir: &Path) -> Board {
    let Ok(bytes) = std::fs::read(dir.join("board.json")) else {
        return Board::default();
    };
    if let Ok(b) = serde_json::from_slice::<Board>(&bytes) {
        return b;
    }
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    Board {
        name: v["name"].as_str().unwrap_or_default().to_string(),
        frames: v["frames"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|f| serde_json::from_value::<Frame>(f.clone()).ok())
                    .filter(|f| valid_name(&f.id))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn save(dir: &Path, board: &Board) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(board)?;
    bytes.push(b'\n');
    atomic_write(&dir.join("board.json"), &bytes)
}

/// Where the next frame goes when nothing said: to the right of the rightmost.
fn next_place(frames: &[Frame]) -> (i64, i64) {
    frames
        .iter()
        .map(|f| f.x + i64::from(f.w.max(1)))
        .max()
        .map_or((0, 0), |right| (right + GAP, 0))
}

/// Every board in a desk's folder: each `design/*/` with a `board.json`, by
/// name. What the desk's JSON offers as views (`views`).
pub fn boards(root: &Path) -> Vec<BoardHead> {
    let Ok(Some((_, design))) = design_dir(root, false) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&design) else {
        return Vec::new();
    };
    let mut out: Vec<BoardHead> = entries
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            let d = dir(root, &id, false).ok()??;
            d.join("board.json").is_file().then(|| {
                let b = read(&d);
                BoardHead {
                    name: if b.name.is_empty() {
                        id.clone()
                    } else {
                        b.name.clone()
                    },
                    frames: b.frames.iter().filter(|f| !f.hidden).count(),
                    id,
                }
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The views a desk's folder has, for the switcher: the folder always, then
/// one per board.
pub fn views(root: &Path) -> Vec<String> {
    std::iter::once("folder".to_string())
        .chain(boards(root).into_iter().map(|b| format!("board:{}", b.id)))
        .collect()
}

/// A board as it is now: `board.json` read leniently, and every frame file
/// in the folder that `board.json` does not name, placed after the rest
/// with the default size. Frames by order, then id.
pub fn read(dir: &Path) -> Board {
    let mut b = load_lenient(dir);
    let mut extra: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let id = name.strip_suffix(".html")?.to_string();
            (valid_name(&id) && !b.frames.iter().any(|f| f.id == id)).then_some(id)
        })
        .collect();
    extra.sort();
    for id in extra {
        let (x, y) = next_place(&b.frames);
        let order = b.frames.iter().map(|f| f.order).max().unwrap_or(-1) + 1;
        b.frames.push(Frame {
            id,
            w: DEFAULT_W,
            x,
            y,
            order,
            ..Default::default()
        });
    }
    // A height of 0 stays 0: the content's (`ISLAND_H`).
    for f in &mut b.frames {
        if f.w == 0 {
            f.w = DEFAULT_W;
        }
    }
    b.frames
        .sort_by(|a, c| a.order.cmp(&c.order).then_with(|| a.id.cmp(&c.id)));
    b
}

/// A board with each frame's hash and size: what `board_read` and the page
/// get. The board's own hash is over `board.json`'s frames and each file's
/// hash, so `since` can say "nothing changed" in one comparison.
pub fn frames(dir: &Path) -> (Board, Vec<FrameRead>, String) {
    let b = read(dir);
    let mut all = blake3::Hasher::new();
    let reads: Vec<FrameRead> = b
        .frames
        .iter()
        .map(|f| {
            let bytes = frame_path(dir, &f.id).ok().and_then(|p| read_frame(&p));
            let hash = bytes.as_deref().map(short_hash).unwrap_or_default();
            all.update(
                format!(
                    "{}:{}:{}:{}:{}:{}:{}:{hash};",
                    f.id, f.w, f.h, f.x, f.y, f.order, f.hidden
                )
                .as_bytes(),
            );
            FrameRead {
                frame: f.clone(),
                bytes: bytes.as_ref().map_or(0, Vec::len),
                missing: bytes.is_none(),
                island: bytes
                    .as_deref()
                    .is_some_and(|b| is_island(&String::from_utf8_lossy(b))),
                hash,
            }
        })
        .collect();
    all.update(b.name.as_bytes());
    (b, reads, all.finalize().to_hex()[..16].to_string())
}

/// One frame's HTML, read safely. What the page's iframe loads.
pub fn frame_html(dir: &Path, id: &str) -> Option<Vec<u8>> {
    read_frame(&frame_path(dir, id).ok()?)
}

/// Where a frame goes and how big it is, as a write gives it.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Size {
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub x: Option<i64>,
    pub y: Option<i64>,
}

/// Write one frame whole: the file, atomically, then its entry in
/// `board.json` (made if it is the first). Returns the file's path, for
/// `send`. A frame is replaced, never merged.
pub fn write(root: &Path, board: &str, id: &str, html: &str, size: Size) -> Result<PathBuf> {
    if html.len() > MAX_FRAME_BYTES {
        bail!(
            "a frame is at most {} KB; split the page into frames",
            MAX_FRAME_BYTES / 1024
        );
    }
    if size.w.is_some_and(|w| w == 0 || w > MAX_SIDE) {
        bail!("a frame's width is 1 to {MAX_SIDE} px");
    }
    // 0 is the content's height again.
    if size.h.is_some_and(|h| h > MAX_SIDE) {
        bail!("a frame's height is 0 (its content's) to {MAX_SIDE} px");
    }
    // Checked before the directory is made, so a bad id leaves no folder.
    if !valid_name(id) {
        bail!("a frame's id is lowercase letters, digits and hyphens: {id:?}");
    }
    let d = dir(root, board, true)?.context("the board's folder")?;
    // Strict first: a board.json that does not parse is refused, not
    // rewritten. Then the board as it is shown, so a frame file that arrived
    // some other way keeps its place and the new one goes after it.
    load(&d)?;
    let mut b = read(&d);
    let path = frame_path(&d, id)?;
    atomic_write(&path, html.as_bytes())?;
    let at = b.frames.iter().position(|f| f.id == id);
    let f = match at {
        Some(i) => &mut b.frames[i],
        None => {
            let (x, y) = next_place(&b.frames);
            let order = b.frames.iter().map(|f| f.order).max().unwrap_or(-1) + 1;
            b.frames.push(Frame {
                id: id.to_string(),
                w: DEFAULT_W,
                x,
                y,
                order,
                ..Default::default()
            });
            b.frames.last_mut().expect("just pushed")
        }
    };
    f.w = size.w.unwrap_or(f.w);
    f.h = size.h.unwrap_or(f.h);
    f.x = size.x.unwrap_or(f.x);
    f.y = size.y.unwrap_or(f.y);
    // Writing a hidden frame again is asking to see it.
    f.hidden = false;
    save(&d, &b)?;
    Ok(path)
}

/// Hide a frame, or show it again: a flag in `board.json`, the file kept.
/// False when the board has no such frame.
pub fn hide(root: &Path, board: &str, id: &str, hidden: bool) -> Result<bool> {
    let Some(d) = dir(root, board, false)? else {
        return Ok(false);
    };
    frame_path(&d, id)?;
    // Strict where it matters: a board.json that does not parse is not
    // rewritten from the lenient read.
    load(&d)?;
    let mut b = read(&d);
    let Some(f) = b.frames.iter_mut().find(|f| f.id == id) else {
        return Ok(false);
    };
    f.hidden = hidden;
    save(&d, &b)?;
    Ok(true)
}

/// One frame's new place, as `board_arrange` gives it.
#[derive(Clone, Debug, Deserialize)]
pub struct Place {
    pub id: String,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub order: Option<i64>,
    pub name: Option<String>,
    /// A live frame's source, `threads`; empty takes it off (1.61, C7).
    #[serde(default)]
    pub source: Option<String>,
}

/// Move frames, reorder them, name them, give one a source, and name the
/// board. A frame it does not know is refused, and so is a source snyvi
/// does not have, so a typo is said rather than dropped.
pub fn arrange(root: &Path, board: &str, places: &[Place], name: Option<&str>) -> Result<Board> {
    let d = dir(root, board, false)?.with_context(|| format!("no board {board:?}"))?;
    load(&d)?;
    let mut b = read(&d);
    for p in places {
        let Some(f) = b.frames.iter_mut().find(|f| f.id == p.id) else {
            bail!("board {board:?} has no frame {:?}", p.id);
        };
        f.x = p.x.unwrap_or(f.x);
        f.y = p.y.unwrap_or(f.y);
        f.order = p.order.unwrap_or(f.order);
        if let Some(n) = &p.name {
            f.name = n.trim().chars().take(80).collect();
        }
        if let Some(src) = &p.source {
            let src = src.trim();
            if !src.is_empty() && !crate::told::SOURCES.contains(&src) {
                bail!(
                    "no source {src:?}: a frame can read {}",
                    crate::told::SOURCES.join(", ")
                );
            }
            f.source = src.to_string();
        }
    }
    if let Some(n) = name {
        b.name = n.trim().chars().take(80).collect();
    }
    save(&d, &b)?;
    Ok(read(&d))
}

/// What the agent reads before its first frame. A missing file is no error:
/// a board can start without either.
pub fn tokens(root: &Path) -> Tokens {
    let Ok(Some((_, design))) = design_dir(root, false) else {
        return Tokens::default();
    };
    let css = read_frame(&design.join("tokens.css"))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let design_md = read_frame(&design.join("DESIGN.md"))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    Tokens {
        vars: css_vars(&css),
        design: first_paragraph(&design_md),
    }
}

/// `--name: value;` pairs, in the order they are written, comments dropped.
/// Not a CSS parser: a tokens file is a list of custom properties.
fn css_vars(css: &str) -> Vec<(String, String)> {
    let mut text = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(i) = rest.find("/*") {
        text.push_str(&rest[..i]);
        rest = rest[i..].find("*/").map_or("", |j| &rest[i + j + 2..]);
    }
    text.push_str(rest);
    let mut out: Vec<(String, String)> = Vec::new();
    for decl in text.split([';', '{', '}']) {
        let Some((k, v)) = decl.split_once(':') else {
            continue;
        };
        let (k, v) = (k.trim(), v.trim());
        if k.starts_with("--") && !v.is_empty() && out.iter().all(|(n, _)| n != k) {
            out.push((k.to_string(), v.to_string()));
        }
    }
    out.truncate(200);
    out
}

/// The first paragraph of prose: past the headings, up to the first blank
/// line, at most 600 characters.
fn first_paragraph(md: &str) -> Option<String> {
    let para: Vec<&str> = md
        .lines()
        .map(str::trim)
        .skip_while(|l| l.is_empty() || l.starts_with('#'))
        .take_while(|l| !l.is_empty())
        .collect();
    let s: String = para.join(" ").chars().take(600).collect();
    (!s.is_empty()).then_some(s)
}

/// One HTML page of every shown frame, in order: a file to keep or hand on.
/// A section without a script is drawn in place, in a declarative shadow
/// root, so its CSS cannot reach another's and its height is its content's,
/// as the window draws it. A frame with a script keeps its own sandboxed
/// iframe, at its height or `ISLAND_H`. PNG, SVG and PDF come later.
pub fn export(dir: &Path, title: &str) -> String {
    let b = read(dir);
    let mut out = String::from("<!doctype html><meta charset=\"utf-8\"><title>");
    out.push_str(&html_escape::encode_text(title));
    out.push_str(
        "</title><style>body{margin:32px;font:14px system-ui,sans-serif;background:#f4f4f2;color:#222}\
         figure{margin:0 0 40px}figcaption{margin:0 0 8px;color:#666}\
         iframe,.s{border:0;background:#fff;color:#000;display:block;box-shadow:0 1px 3px rgba(0,0,0,.15)}\
         .s{font:16px serif;overflow:hidden}</style>",
    );
    for f in b.frames.iter().filter(|f| !f.hidden) {
        let Some(bytes) = frame_html(dir, &f.id) else {
            continue;
        };
        let html = String::from_utf8_lossy(&bytes);
        let label = html_escape::encode_text(if f.name.is_empty() { &f.id } else { &f.name });
        if is_island(&html) {
            let h = if f.h == 0 { ISLAND_H } else { f.h };
            out.push_str(&format!(
                "<figure><figcaption>{label} · {}×{h}</figcaption><iframe sandbox=\"allow-scripts\" width=\"{}\" height=\"{h}\" srcdoc=\"{}\"></iframe></figure>",
                f.w,
                f.w,
                html_escape::encode_double_quoted_attribute(&html),
            ));
        } else {
            let (size, h) = if f.h == 0 {
                (format!("{} wide", f.w), String::new())
            } else {
                (format!("{}×{}", f.w, f.h), format!(";height:{}px", f.h))
            };
            out.push_str(&format!(
                "<figure><figcaption>{label} · {size}</figcaption><div class=\"s\" style=\"width:{}px{h}\"><template shadowrootmode=\"open\">{}</template></div></figure>",
                f.w,
                host_selectors(&html).replace("</template", "&lt;/template"),
            ));
        }
    }
    out
}

/// A frame that runs a script: drawn as its own sandboxed page, since a
/// section in the board's one document never runs one.
pub fn is_island(html: &str) -> bool {
    html.to_ascii_lowercase().contains("<script")
}

/// A frame's CSS made to work in a shadow root: `html`, `body` and `:root`
/// in a selector are the section itself, `:host`. Only selectors change --
/// the text before a `{` -- never a declaration. ui/board-frame.js does the
/// same in the window.
pub fn host_selectors(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(open) = lower.find("<style") else {
            out.push_str(rest);
            return out;
        };
        let Some(gt) = rest[open..].find('>').map(|i| open + i + 1) else {
            out.push_str(rest);
            return out;
        };
        let close = lower[gt..].find("</style").map_or(rest.len(), |i| gt + i);
        out.push_str(&rest[..gt]);
        out.push_str(&css_host(&rest[gt..close]));
        rest = &rest[close..];
    }
}

fn css_host(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut seg = String::new();
    for c in css.chars() {
        match c {
            '{' => {
                out.push_str(&prelude_host(&seg));
                seg.clear();
                out.push(c);
            }
            '}' => {
                out.push_str(&seg);
                seg.clear();
                out.push(c);
            }
            _ => seg.push(c),
        }
    }
    out.push_str(&seg);
    out
}

/// One selector list, its `html`, `body` and `:root` made `:host`.
fn prelude_host(sel: &str) -> String {
    if sel.trim_start().starts_with('@') {
        return sel.to_string();
    }
    // Before the word: the start, a space or a combinator, so `.body` and
    // `#html` (a class, an id) stay; after it, anything but a name's letter.
    let before = |c: Option<char>| c.is_none_or(|c| c.is_whitespace() || ",>+~(".contains(c));
    let edge =
        |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    let mut out = String::with_capacity(sel.len());
    let mut i = 0;
    while i < sel.len() {
        let mut hit = None;
        for word in [":root", "html", "body"] {
            let end = i + word.len();
            if end <= sel.len()
                && sel.is_char_boundary(end)
                && sel[i..end].eq_ignore_ascii_case(word)
                && before(sel[..i].chars().last())
                && edge(sel[end..].chars().next())
            {
                hit = Some(end);
                break;
            }
        }
        if let Some(end) = hit {
            out.push_str(":host");
            i = end;
        } else {
            let ch = sel[i..].chars().next().expect("in bounds");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out.replace(":host :host", ":host")
        .replace(":host > :host", ":host")
}

/// A board's folder name from the name the reader gave it: lowercase
/// letters, digits and hyphens, at most 48, `board` when nothing is left.
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 48 {
            break;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "board".into()
    } else {
        s
    }
}

/// A new, empty board named `name`: `design/<slug>/board.json` with only
/// its name. Its folder's name is the slug, with `-2`, `-3`… when a board
/// already has it. Returns the folder's name.
pub fn create(root: &Path, name: &str) -> Result<String> {
    let name: String = name.trim().chars().take(80).collect();
    if name.is_empty() {
        bail!("a board needs a name");
    }
    let base = slug(&name);
    let taken = |id: &str| dir(root, id, false).ok().flatten().is_some();
    let id = (1..1000)
        .map(|n| {
            if n == 1 {
                base.clone()
            } else {
                format!("{base}-{n}")
            }
        })
        .find(|id| valid_name(id) && !taken(id))
        .context("no free name for the board")?;
    let d = dir(root, &id, true)?.context("the board's folder")?;
    save(
        &d,
        &Board {
            name,
            frames: Vec::new(),
        },
    )?;
    Ok(id)
}

/// What puts a frame into the store as a version: origin `board`, the
/// desk's project, workflow `board:<board>`, from `pane` when an agent wrote
/// it. Quiet, and a burst within 20 s is one version (`receive`). The route
/// hands it to `receive_and_emit`, so the page hears of it as of any send.
pub fn payload(
    root: &Path,
    board: &str,
    path: &Path,
    pane: Option<&str>,
) -> crate::receive::Payload {
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|id| format!("{board} · {id}"));
    crate::receive::Payload {
        path: Some(path.to_string_lossy().into_owned()),
        cwd: Some(root.to_string_lossy().into_owned()),
        title,
        workflow: Some(format!("board:{board}")),
        origin: Some("board".into()),
        pane: pane.map(str::to_string),
        ..Default::default()
    }
}

/// A frame's file, in a checked board directory: what `payload` is given.
pub fn frame_file(dir: &Path, id: &str) -> Option<PathBuf> {
    frame_path(dir, id).ok()
}

#[cfg(test)]
mod tests;
