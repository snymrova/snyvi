//! A studio folder read from disk: its folders as a tree, one folder's
//! pictures, videos and sounds, each with the JSON beside it, and what it
//! all says it cost.
//!
//! The agent arranges the folder; snyvi reads it. A folder may hold a
//! `folder.json` -- `title`, `order`, `note`, `picks`, and at the top a
//! `budget` -- and each file a `<file>.json` with its prompt, model, seed
//! and cost. Into the reader's files snyvi writes one thing: the ★, as a
//! name in `picks` of the folder's `folder.json`, so the agent reads the
//! reader's choice from the file it already reads.
//!
//! Everything is read forgivingly and bounded. A broken `folder.json` is a
//! folder with less said about it, never an error. The bounds are the
//! tests: 3 folders deep for the tree, 5,000 entries read from one folder,
//! 64 KB for a JSON file, dot-files and dot-folders (`.scripts/`) skipped,
//! and nothing followed out of the studio folder -- a symlink that leaves it
//! is not there.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

/// The file a folder says things about itself in.
pub const META: &str = "folder.json";
/// How deep the tree goes below the studio folder: a folder, one in it, and
/// one in that.
pub const TREE_DEPTH: usize = 3;
/// How deep the spend is added up.
pub const DEPTH: usize = 8;
/// How many entries of one folder are read; past this the folder says
/// `more` and shows what it read.
pub const ENTRIES: usize = 5000;
/// The most a JSON file snyvi reads may weigh. Past it, the file is as good
/// as missing -- and a `folder.json` that big is never written over.
pub const JSON_BYTES: u64 = 64 * 1024;
/// The most names `picks` holds; the oldest go first.
pub const PICKS: usize = 500;

/// A folder in the tree: where it is, what it calls itself, how many
/// pictures, videos and sounds are directly in it, and the folders in it.
#[derive(Debug, Serialize, PartialEq)]
pub struct Node {
    pub rel: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    pub n: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<Node>,
}

/// One folder, as the viewer draws it.
#[derive(Debug, Serialize, Default)]
pub struct Folder {
    pub rel: String,
    pub name: String,
    /// What `folder.json` says, every field optional.
    pub title: String,
    pub note: String,
    /// The reader's ★s: names of files in this folder.
    pub picks: Vec<String>,
    /// The pictures, videos and sounds in it: `order` first, then newest.
    pub items: Vec<Item>,
    /// How many in it the reader hid.
    pub hidden: usize,
    /// More entries than `ENTRIES` in it.
    pub more: bool,
}

/// A picture, a video or a sound.
#[derive(Debug, Serialize, Clone)]
pub struct Item {
    /// Relative to the studio folder, with `/`: what the raw route, a hide,
    /// a ★ and the agent's prompt context all name it by.
    pub rel: String,
    pub name: String,
    /// `image`, `video` or `audio`.
    pub kind: &'static str,
    pub size: u64,
    /// Seconds since the epoch.
    pub mtime: i64,
    /// Its `<file>.json`, when there is one that parses and is not too big.
    #[serde(skip_serializing_if = "Value::is_null")]
    pub info: Value,
    /// Hidden by the reader, and shown only because they asked to see what
    /// they hid, with Put back.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

/// What a file is, by its extension, or None for one the viewer does not
/// show: a document (the rail's Documents has those), a JSON file, a
/// script, anything else the agent keeps beside the work.
pub fn kind_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" => "image",
        "mp4" | "webm" | "mov" | "m4v" => "video",
        "mp3" | "wav" | "ogg" | "oga" | "m4a" | "flac" | "aac" | "opus" => "audio",
        _ => return None,
    })
}

/// The path a studio-relative name stands for, or an error when it is not
/// one: an absolute path, a `..`, a dot-folder, or one that lands outside
/// the studio folder once its symlinks are followed. `root` is the desk's
/// folder as stored, already real (`folder_ok`).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim_matches('/');
    let mut p = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(part) => {
                if part.to_string_lossy().starts_with('.') {
                    bail!("not in the studio folder");
                }
                p.push(part);
            }
            Component::CurDir => {}
            _ => bail!("not in the studio folder"),
        }
    }
    let real = p.canonicalize()?;
    if !real.starts_with(root) {
        bail!("outside the studio folder");
    }
    Ok(real)
}

/// The path under `root`, written with `/` whatever the OS says.
fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// A JSON file, when it is there, small enough, and parses.
pub fn read_json(p: &Path) -> Option<Value> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > JSON_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// A string field of a JSON object, or empty.
pub fn text(v: &Value, k: &str) -> String {
    v.get(k)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A list of strings in a JSON object, or empty.
fn names(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim_end_matches('/').to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// One entry of a folder.
struct Entry {
    path: PathBuf,
    name: String,
    dir: bool,
    size: u64,
    mtime: i64,
}

/// A folder's entries, at most `ENTRIES`, dot-files and dot-folders left
/// out, symlinks followed only when they stay under `root`. The bool says
/// whether there were more.
fn entries(root: &Path, dir: &Path) -> (Vec<Entry>, bool) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (Vec::new(), false);
    };
    let mut out = Vec::new();
    for (i, e) in rd.flatten().enumerate() {
        if i >= ENTRIES {
            return (out, true);
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let mut path = e.path();
        let Ok(mut meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            match path.canonicalize() {
                Ok(real) if real.starts_with(root) => {
                    let Ok(m) = std::fs::metadata(&real) else {
                        continue;
                    };
                    meta = m;
                    path = real;
                }
                _ => continue,
            }
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        out.push(Entry {
            path,
            name,
            dir: meta.is_dir(),
            size: meta.len(),
            mtime,
        });
    }
    (out, false)
}

/// `a` before `b` by a folder.json `order`: what it names first, in its
/// order; the rest after, by `rest`.
fn by_order(
    order: &[String],
    a: &str,
    b: &str,
    rest: impl FnOnce() -> std::cmp::Ordering,
) -> std::cmp::Ordering {
    let at = |n: &str| order.iter().position(|o| o == n);
    match (at(a), at(b)) {
        (Some(i), Some(j)) => i.cmp(&j),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => rest(),
    }
}

/// The folders in the studio folder, nested `TREE_DEPTH` deep, each in its
/// parent's `order` and then by name, less the ones the reader hid.
pub fn tree(root: &Path, hidden: &HashSet<String>) -> Vec<Node> {
    fn walk(root: &Path, dir: &Path, depth: usize, hidden: &HashSet<String>) -> Vec<Node> {
        if depth >= TREE_DEPTH {
            return Vec::new();
        }
        let order = read_json(&dir.join(META))
            .map(|v| names(&v, "order"))
            .unwrap_or_default();
        let (list, _) = entries(root, dir);
        let mut out: Vec<Node> = list
            .iter()
            .filter(|e| e.dir && !hidden.contains(&rel_of(root, &e.path)))
            .map(|e| {
                let (inner, _) = entries(root, &e.path);
                let n = inner
                    .iter()
                    .filter(|x| !x.dir && kind_of(&x.name).is_some())
                    .filter(|x| !hidden.contains(&rel_of(root, &x.path)))
                    .count();
                Node {
                    rel: rel_of(root, &e.path),
                    title: read_json(&e.path.join(META))
                        .map(|v| text(&v, "title"))
                        .unwrap_or_default(),
                    name: e.name.clone(),
                    n,
                    folders: walk(root, &e.path, depth + 1, hidden),
                }
            })
            .collect();
        out.sort_by(|a, b| {
            by_order(&order, &a.name, &b.name, || {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            })
        });
        out
    }
    walk(root, root, 0, hidden)
}

/// How many pictures, videos and sounds sit directly in the studio folder,
/// less the hidden: the tree's top row, for a studio whose agent has not
/// made a folder yet.
pub fn loose(root: &Path, hidden: &HashSet<String>) -> usize {
    let (list, _) = entries(root, root);
    list.iter()
        .filter(|x| !x.dir && kind_of(&x.name).is_some())
        .filter(|x| !hidden.contains(&rel_of(root, &x.path)))
        .count()
}

/// One folder: `rel` under `root` ("" for the studio folder itself). With
/// `show`, what the reader hid is in it too, marked.
pub fn folder(root: &Path, rel: &str, hidden: &HashSet<String>, show: bool) -> Result<Folder> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        bail!("not a folder");
    }
    let (list, more) = entries(root, &dir);
    let meta = read_json(&dir.join(META)).unwrap_or(Value::Null);
    let order = names(&meta, "order");
    let mut f = Folder {
        rel: rel_of(root, &dir),
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        title: text(&meta, "title"),
        note: text(&meta, "note"),
        picks: names(&meta, "picks"),
        more,
        ..Folder::default()
    };
    for e in list.iter().filter(|e| !e.dir) {
        let Some(kind) = kind_of(&e.name) else {
            continue;
        };
        let rel = rel_of(root, &e.path);
        let hid = hidden.contains(&rel);
        f.hidden += usize::from(hid);
        if hid && !show {
            continue;
        }
        let mut sidecar = e.path.clone().into_os_string();
        sidecar.push(".json");
        f.items.push(Item {
            rel,
            name: e.name.clone(),
            kind,
            size: e.size,
            mtime: e.mtime,
            info: read_json(Path::new(&sidecar)).unwrap_or(Value::Null),
            hidden: hid,
        });
    }
    f.items.sort_by(|x, y| {
        by_order(&order, &x.name, &y.name, || {
            y.mtime.cmp(&x.mtime).then(x.name.cmp(&y.name))
        })
    });
    Ok(f)
}

/// What the files under `dir` say they cost (`cost_usd` in the JSON beside
/// each), `DEPTH` deep: the spend line.
pub fn spend(root: &Path, dir: &Path, depth: usize) -> f64 {
    if depth >= DEPTH {
        return 0.0;
    }
    let (list, _) = entries(root, dir);
    let mut sum = 0.0;
    for e in &list {
        if e.dir {
            sum += spend(root, &e.path, depth + 1);
            continue;
        }
        if kind_of(&e.name).is_none() {
            continue;
        }
        let mut sidecar = e.path.clone().into_os_string();
        sidecar.push(".json");
        if let Some(c) =
            read_json(Path::new(&sidecar)).and_then(|v| v.get("cost_usd").and_then(Value::as_f64))
        {
            if c.is_finite() && c > 0.0 {
                sum += c;
            }
        }
    }
    sum
}

/// The budget the studio folder's own `folder.json` sets, in dollars.
pub fn budget(root: &Path) -> Option<f64> {
    read_json(&root.join(META))?
        .get("budget")
        .and_then(Value::as_f64)
        .filter(|b| b.is_finite() && *b > 0.0)
}

/// ★ on a file, or off it: its name added to or taken out of `picks` in its
/// folder's `folder.json`, every other field kept as the agent wrote it.
/// Made when there is none; a `folder.json` that does not parse, is not an
/// object or is too big is the agent's to fix and is never written over.
/// True when the file is now picked.
pub fn pick(root: &Path, rel: &str) -> Result<bool> {
    let file = resolve(root, rel)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !file.is_file() || kind_of(&name).is_none() {
        bail!("not a picture, a video or a sound");
    }
    let dir = file.parent().context("no folder")?;
    let meta_path = dir.join(META);
    let mut meta = if meta_path.exists() {
        match read_json(&meta_path) {
            Some(Value::Object(m)) => m,
            _ => bail!("{META} is not one snyvi can add to"),
        }
    } else {
        serde_json::Map::new()
    };
    let mut picks = names(&Value::Object(meta.clone()), "picks");
    let on = !picks.contains(&name);
    if on {
        picks.push(name);
        let over = picks.len().saturating_sub(PICKS);
        picks.drain(..over);
    } else {
        picks.retain(|p| p != &name);
    }
    meta.insert("picks".into(), Value::from(picks));
    let body = serde_json::to_vec_pretty(&Value::Object(meta))?;
    // Beside it, then over it: a reader of the folder never sees half.
    let tmp = dir.join(format!(".{META}.snyvi"));
    std::fs::write(&tmp, &body).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &meta_path)
        .with_context(|| format!("writing {}", meta_path.display()))?;
    Ok(on)
}

/// A short mark of how the studio folder looks on disk now -- the names,
/// sizes and times of what is in it, as deep as the tree and one more -- so
/// the page can ask "has it changed?" for the price of a listing and redraw
/// only when it has. A `folder.json` rewritten is a change too.
pub fn stamp(root: &Path) -> String {
    let mut h = blake3::Hasher::new();
    let mut todo = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((d, depth)) = todo.pop() {
        let (list, _) = entries(root, &d);
        for e in list {
            seen += 1;
            h.update(e.name.as_bytes());
            h.update(&e.size.to_le_bytes());
            h.update(&e.mtime.to_le_bytes());
            if e.dir && depth < TREE_DEPTH && seen < 4 * ENTRIES {
                todo.push((e.path, depth + 1));
            }
        }
        h.update(b"/");
    }
    h.finalize().to_hex()[..16].to_string()
}

/// The newest pictures and videos in a studio folder, `n` of them, for its
/// card on Home: three levels deep and 400 folders at most, so a large
/// folder costs Home a glance and no more.
pub fn newest(root: &Path, n: usize) -> Vec<(String, &'static str)> {
    let mut found: Vec<(i64, String, &'static str)> = Vec::new();
    let mut todo = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0;
    while let Some((dir, depth)) = todo.pop() {
        seen += 1;
        if seen > 400 {
            break;
        }
        let (list, _) = entries(root, &dir);
        for e in list {
            if e.dir {
                if depth < 3 {
                    todo.push((e.path, depth + 1));
                }
            } else if let Some(k @ ("image" | "video")) = kind_of(&e.name) {
                found.push((e.mtime, rel_of(root, &e.path), k));
            }
        }
    }
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found.into_iter().take(n).map(|(_, r, k)| (r, k)).collect()
}
