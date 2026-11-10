//! Where a `/name` lives (1.53, plan f30461f2c1): the one place that knows.
//!
//! Claude Code reads four places, and when two hold the same name it says
//! which wins (the skills page, read 26 Oct): a personal skill or command
//! beats the project's, and a skill beats a `.claude/commands/` file. That
//! is the order here, so the sheet names the file Claude Code will run:
//!
//! 1. `~/.claude/skills/<name>/SKILL.md`
//! 2. `~/.claude/commands/<name>.md`
//! 3. `.claude/skills/<name>/SKILL.md`
//! 4. `.claude/commands/<name>.md`
//!
//! One pair the docs leave open: the reader's command file against the
//! project's skill (personal says one, skill says the other). That pair is
//! `Two`, and refused until one is renamed. A skill answers to its folder's
//! name and to its frontmatter `name:` (spike S5, 26 Oct: both ran it); a
//! skill with `user-invocable: false` has no `/name` and is not here.
//! Plugin skills (`/plugin:x`) and subfolders of `commands/` (`/sub:x`) are
//! left out: a routine's name is one word.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// How many the list holds at most: `/` is for finding one, not a catalogue.
const LIST_MAX: usize = 300;
/// A skill's folder is hashed whole up to this; past it, `SKILL.md` alone.
const FOLDER_FILES: usize = 200;
const FOLDER_BYTES: u64 = 4 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Command,
    Skill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Who {
    You,
    Project,
}

/// A slash command or a skill, where it lives.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Place {
    /// What `/` takes: a skill's `name:`, else its folder's or file's name.
    pub name: String,
    pub kind: Kind,
    pub who: Who,
    /// As the sheet says it: `.claude/commands/newsroom.md`,
    /// `~/.claude/skills/bench/SKILL.md`. What a routine keeps.
    pub file: String,
    /// Its frontmatter `description`, else its first heading or line.
    pub about: String,
    #[serde(skip)]
    pub path: PathBuf,
}

impl Place {
    /// `project · command`, `yours · skill`.
    pub fn tag(&self) -> String {
        let who = match self.who {
            Who::You => "yours",
            Who::Project => "project",
        };
        let kind = match self.kind {
            Kind::Command => "command",
            Kind::Skill => "skill",
        };
        format!("{who} · {kind}")
    }

    /// A skill's folder; `None` for a command.
    pub fn folder(&self) -> Option<&Path> {
        (self.kind == Kind::Skill)
            .then(|| self.path.parent())
            .flatten()
    }
}

/// What a name comes to.
#[derive(Clone, Debug, PartialEq)]
pub enum Resolved {
    One(Place),
    /// The pair the docs leave open: the reader's command, the project's skill.
    Two(Place, Place),
    /// No file: the line is the reader's own words.
    Words,
}

/// The two homes: the reader's (`~`) and the desk's folder.
pub(crate) struct Roots<'a> {
    pub(crate) home: Option<PathBuf>,
    pub(crate) root: &'a Path,
}

impl Roots<'_> {
    fn of(root: &Path) -> Roots<'_> {
        Roots {
            home: dirs::home_dir(),
            root,
        }
    }

    /// The four folders, in Claude Code's order.
    fn dirs(&self) -> Vec<(Who, Kind, PathBuf)> {
        let mut v = Vec::new();
        if let Some(h) = &self.home {
            let c = h.join(".claude");
            v.push((Who::You, Kind::Skill, c.join("skills")));
            v.push((Who::You, Kind::Command, c.join("commands")));
        }
        let c = self.root.join(".claude");
        // A desk on the home folder is not a project with a second copy.
        if self.home.as_deref() != Some(self.root) {
            v.push((Who::Project, Kind::Skill, c.join("skills")));
            v.push((Who::Project, Kind::Command, c.join("commands")));
        }
        v
    }

    /// The file as the sheet says it: under `~` or under the desk.
    fn said(&self, who: Who, path: &Path) -> String {
        let base = match who {
            Who::You => self.home.as_deref(),
            Who::Project => Some(self.root),
        };
        let rel = base
            .and_then(|b| path.strip_prefix(b).ok())
            .map(slashed)
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        match who {
            Who::You => format!("~/{rel}"),
            Who::Project => rel,
        }
    }
}

/// A name `/` takes: letters, digits, `-` and `_`, as `routine::cmd_ok`.
fn name_ok(n: &str) -> bool {
    crate::routine::cmd_ok(n)
}

/// The frontmatter's `key: value` lines, and the body after it.
fn front(text: &str) -> (HashMap<String, String>, &str) {
    let mut m = HashMap::new();
    let Some(rest) = text.strip_prefix("---") else {
        return (m, text);
    };
    let Some((head, body)) = rest.split_once("\n---") else {
        return (m, text);
    };
    for l in head.lines() {
        if let Some((k, v)) = l.split_once(':') {
            let v = v.trim().trim_matches(['"', '\'']).trim();
            m.insert(k.trim().to_ascii_lowercase(), v.to_string());
        }
    }
    (m, body.split_once('\n').map_or("", |(_, b)| b))
}

/// What a file says first: its first heading or line, unmarked.
pub fn first_line(text: &str) -> String {
    let (_, body) = front(text);
    crate::thread::line(
        body.lines()
            .map(|l| l.trim().trim_start_matches('#').trim())
            .find(|l| !l.is_empty())
            .unwrap_or(""),
        120,
    )
}

/// What a command or skill is for: its `description`, else its first line.
pub fn about(text: &str) -> String {
    let (m, _) = front(text);
    match m.get("description").filter(|d| !d.is_empty()) {
        Some(d) => crate::thread::line(d, 120),
        None => first_line(text),
    }
}

/// A skill's folder read: its `/name` and whether it has one at all.
fn skill(dir: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let (m, _) = front(&text);
    if m.get("user-invocable")
        .map(|v| v.eq_ignore_ascii_case("false"))
        == Some(true)
    {
        return None;
    }
    let folder = dir.file_name()?.to_string_lossy().into_owned();
    let name = m
        .get("name")
        .filter(|n| name_ok(n))
        .cloned()
        .unwrap_or(folder);
    Some((name, about(&text)))
}

/// The places in one folder, as `(name, also, place)`: `also` is the other
/// word a skill answers to, its folder's name beside its `name:`.
fn read_dir(roots: &Roots, who: Who, kind: Kind, dir: &Path) -> Entries {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut v = Vec::new();
    for e in rd.flatten().take(LIST_MAX * 2) {
        let p = e.path();
        let n = e.file_name().to_string_lossy().into_owned();
        match kind {
            Kind::Command => {
                let Some(cmd) = n.strip_suffix(".md") else {
                    continue;
                };
                if !name_ok(cmd) || !p.is_file() {
                    continue;
                }
                let text = std::fs::read_to_string(&p).unwrap_or_default();
                v.push((
                    None,
                    Place {
                        name: cmd.to_string(),
                        kind,
                        who,
                        file: roots.said(who, &p),
                        about: about(&text),
                        path: p,
                    },
                ));
            }
            Kind::Skill => {
                let Some((name, about)) = skill(&p).filter(|(n, _)| name_ok(n)) else {
                    continue;
                };
                let file = p.join("SKILL.md");
                let also = (name != n && name_ok(&n)).then_some(n);
                v.push((
                    also,
                    Place {
                        name,
                        kind,
                        who,
                        file: roots.said(who, &file),
                        about,
                        path: file,
                    },
                ));
            }
        }
    }
    v
}

/// The four folders' entries, uncached, in Claude Code's order.
fn read_all(roots: &Roots) -> Entries {
    roots
        .dirs()
        .into_iter()
        .flat_map(|(who, kind, dir)| read_dir(roots, who, kind, &dir))
        .collect()
}

/// The places a name could be, in Claude Code's order.
fn found(all: &[(Option<String>, Place)], name: &str) -> Vec<Place> {
    all.iter()
        .filter(|(also, p)| p.name == name || also.as_deref() == Some(name))
        .map(|(_, p)| p.clone())
        .collect()
}

/// What `/name` comes to, from the desk's folder `root`.
pub fn resolve(root: &Path, name: &str) -> Resolved {
    resolve_at(&Roots::of(root), name)
}

pub(crate) fn resolve_at(roots: &Roots, name: &str) -> Resolved {
    if !name_ok(name) {
        return Resolved::Words;
    }
    pick(found(&cached(roots), name))
}

/// The winner among the places a name is found in, by the docs' order.
fn pick(at: Vec<Place>) -> Resolved {
    let of = |who, kind| at.iter().find(|p| p.who == who && p.kind == kind).cloned();
    if let Some(p) = of(Who::You, Kind::Skill) {
        return Resolved::One(p);
    }
    match (of(Who::You, Kind::Command), of(Who::Project, Kind::Skill)) {
        (Some(a), Some(b)) => Resolved::Two(a, b),
        (Some(p), None) | (None, Some(p)) => Resolved::One(p),
        (None, None) => match of(Who::Project, Kind::Command) {
            Some(p) => Resolved::One(p),
            None => Resolved::Words,
        },
    }
}

/// The places `/` lists: each name once, as Claude Code would run it, the
/// project's first (what is looked for), then the reader's.
pub fn list(root: &Path) -> Vec<Place> {
    list_at(&Roots::of(root))
}

pub(crate) fn list_at(roots: &Roots) -> Vec<Place> {
    let all = cached(roots);
    let mut names: Vec<&str> = all.iter().map(|(_, p)| p.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    let mut v: Vec<Place> = names
        .into_iter()
        .filter_map(|n| match pick(found(&all, n)) {
            Resolved::One(p) | Resolved::Two(_, p) => Some(p),
            Resolved::Words => None,
        })
        .collect();
    v.sort_by(|a, b| (a.who == Who::You, &a.name).cmp(&(b.who == Who::You, &b.name)));
    v.truncate(LIST_MAX);
    v
}

/// A folder's stamp: its time, and the names in it. The time alone missed
/// an entry that came and went within one tick of the clock it is kept by
/// -- about 15 ms on Windows, a second or two on some disks -- and the list
/// kept a command that was gone. Reading the names is one directory read,
/// and no file is opened for it.
type Stamp = (Option<SystemTime>, Vec<std::ffi::OsString>);
/// The four folders' stamps: a list read again only when one moved (T15).
type Stamps = Vec<Stamp>;
type Entries = Vec<(Option<String>, Place)>;
/// By the reader's home and the desk's folder.
type Cache = HashMap<(Option<PathBuf>, PathBuf), (Stamps, Entries)>;
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn stamp(dir: &Path) -> Stamp {
    let time = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.file_name())).collect())
        .unwrap_or_default();
    names.sort();
    (time, names)
}

/// The entries for a desk, from the cache when no folder moved. A folder's
/// stamp moves when an entry comes or goes; a file rewritten in place is
/// read at its next resolve's `hash`, which never trusts the cache.
fn cached(roots: &Roots) -> Entries {
    let stamps: Stamps = roots.dirs().iter().map(|(_, _, d)| stamp(d)).collect();
    let key = (roots.home.clone(), roots.root.to_path_buf());
    if let Ok(c) = CACHE.lock() {
        if let Some((s, v)) = c.get(&key) {
            if *s == stamps {
                return v.clone();
            }
        }
    }
    let v = read_all(roots);
    if let Ok(mut c) = CACHE.lock() {
        if c.len() > 64 {
            c.clear();
        }
        c.insert(key, (stamps, v.clone()));
    }
    v
}

/// A place again from the file a routine keeps, for its hash and its diff.
pub fn from_file(root: &Path, file: &str) -> Option<Place> {
    let (who, path) = match file.strip_prefix("~/") {
        Some(rest) => (Who::You, dirs::home_dir()?.join(rest)),
        None => (Who::Project, root.join(file)),
    };
    let kind = if file.ends_with("/SKILL.md") {
        Kind::Skill
    } else {
        Kind::Command
    };
    let text = std::fs::read_to_string(&path).ok()?;
    Some(Place {
        name: String::new(),
        kind,
        who,
        file: file.to_string(),
        about: about(&text),
        path,
    })
}

/// A path under a root with `/` between its parts on every system: what the
/// row stores and the 1.53 backfill writes (`.claude/commands/<cmd>.md`),
/// and what `from_file` reads back. Windows' backslashes made one file two.
fn slashed(p: &Path) -> String {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The files a skill's folder holds, sorted, or `None` when it is past
/// the bounds and `SKILL.md` alone is hashed (T8).
fn folder_files(dir: &Path) -> Option<Vec<PathBuf>> {
    files_but(dir, None)
}

/// A routine's scripts folder keeps what its scripts remember in `state/`
/// (a last id seen, a cursor): written by every run, so never part of what
/// the reader allowed, or a gate that notes its day would stop its own
/// routine at "changed · Allow" the next morning.
pub const STATE: &str = "state";

/// The files under `dir`, sorted, but the folder `skip` at its top; `None`
/// past the bounds.
fn files_but(dir: &Path, skip: Option<&str>) -> Option<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    let skipped = skip.map(|s| dir.join(s));
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if skipped.as_ref() != Some(&e.path()) {
                    stack.push(e.path());
                }
            } else if t.is_file() {
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(e.path());
                if out.len() > FOLDER_FILES || bytes > FOLDER_BYTES {
                    return None;
                }
            }
        }
    }
    out.sort();
    Some(out)
}

/// Whether a skill's folder is past the bounds, so only `SKILL.md` counts.
pub fn large(p: &Place) -> bool {
    p.folder().is_some_and(|d| folder_files(d).is_none())
}

/// What is allowed: a command file's bytes, or a skill folder's paths and
/// contents in order. `None` when it is gone.
pub fn hash(p: &Place) -> Option<String> {
    let main = std::fs::read(&p.path).ok()?;
    let Some(dir) = p.folder() else {
        return Some(blake3::hash(&main).to_hex().to_string());
    };
    let Some(files) = folder_files(dir) else {
        return Some(blake3::hash(&main).to_hex().to_string());
    };
    let mut h = blake3::Hasher::new();
    for f in files {
        let rel = slashed(f.strip_prefix(dir).unwrap_or(&f));
        h.update(rel.as_bytes());
        h.update(&[0]);
        h.update(&std::fs::read(&f).unwrap_or_default());
        h.update(&[0]);
    }
    Some(h.finalize().to_hex().to_string())
}

/// A routine's scripts (1.63, R6): `.claude/routines/<cmd>/`, beside the
/// `.claude` its command or skill is in -- the project's for a project
/// command, `~/.claude/routines/<cmd>/` for one of the reader's own. `None`
/// when there is no such folder.
pub fn scripts(p: &Place, cmd: &str) -> Option<PathBuf> {
    if !name_ok(cmd) {
        return None;
    }
    let claude = p
        .path
        .ancestors()
        .find(|a| a.file_name().is_some_and(|n| n == ".claude"))?;
    let d = claude.join("routines").join(cmd);
    d.is_dir().then_some(d)
}

/// The scripts folder as the sheet says it: `.claude/routines/pro-forum/`,
/// `~/.claude/routines/pro-forum/`.
pub fn scripts_said(p: &Place, cmd: &str) -> String {
    match p.who {
        Who::You => format!("~/.claude/routines/{cmd}/"),
        Who::Project => format!(".claude/routines/{cmd}/"),
    }
}

/// The scripts' files, sorted, under the folder's bounds; past them, `None`.
pub fn script_files(dir: &Path) -> Option<Vec<PathBuf>> {
    files_but(dir, Some(STATE))
}

/// What is allowed for a routine (1.63): the command's own hash, and with a
/// scripts folder, every file in it folded in. A routine with no folder
/// keeps the hash it had, so nothing from before reads as changed. A
/// folder past the bounds is hashed by its names and sizes, and the sheet
/// says only those are watched.
pub fn hash_with(p: &Place, cmd: &str) -> Option<String> {
    let main = hash(p)?;
    let Some(dir) = scripts(p, cmd) else {
        return Some(main);
    };
    let mut h = blake3::Hasher::new();
    h.update(main.as_bytes());
    match script_files(&dir) {
        Some(files) if files.is_empty() => return Some(main),
        Some(files) => {
            for f in files {
                h.update(slashed(f.strip_prefix(&dir).unwrap_or(&f)).as_bytes());
                h.update(&[0]);
                h.update(&std::fs::read(&f).unwrap_or_default());
                h.update(&[0]);
            }
        }
        None => {
            h.update(b"large\0");
            for e in walkdir_names(&dir, &dir.join(STATE)) {
                h.update(e.as_bytes());
                h.update(&[0]);
            }
        }
    }
    Some(h.finalize().to_hex().to_string())
}

/// A large folder's files by name and size, sorted, a few thousand at most.
fn walkdir_names(dir: &Path, skip: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                if e.path() != skip {
                    stack.push(e.path());
                }
            } else {
                let len = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(format!(
                    "{} {len}",
                    slashed(e.path().strip_prefix(dir).unwrap_or(&e.path()))
                ));
            }
            if out.len() > 4096 {
                break;
            }
        }
    }
    out.sort();
    out
}

/// The scripts' text, for the diff kept beside the command's: each file
/// under a heading of its own path. Not text, or past the bounds: its name.
pub fn scripts_text(p: &Place, cmd: &str) -> String {
    let Some(dir) = scripts(p, cmd) else {
        return String::new();
    };
    let said = scripts_said(p, cmd);
    let Some(files) = script_files(&dir) else {
        return format!("\n\n## {said} (past 200 files or 4 MB: names and sizes only)\n");
    };
    let mut s = String::new();
    for f in files {
        let rel = slashed(f.strip_prefix(&dir).unwrap_or(&f));
        let text = std::fs::read(&f)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| "(not text)".into());
        s.push_str(&format!("\n\n## {said}{rel}\n\n{text}"));
    }
    s
}

#[cfg(test)]
#[path = "places_tests.rs"]
mod tests;
