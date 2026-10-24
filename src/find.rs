//! ⌘K's file names (#188): every desk's folder and every folder open for
//! reading, searched by name as the reader types, and a file opened in the
//! folder reader when one is picked.
//!
//! One index in memory, built the first time ⌘K opens and kept fresh without
//! walking again. Adding, removing or renaming a file changes its directory's
//! modification time, so each open stats the directories the index knows
//! (about 4,400 across twenty real folders, 30-50 ms, off the typing path)
//! and lists again only the ones that changed. An ignore file that changed
//! walks its folder again, since it can hide or show any file under it.
//! Polling, not a watcher, for the reason `crate::watch` gives: the same on
//! every OS, and no watch limit for a large repository to run into.
//!
//! A search rejects most paths with one AND against a mask of the letters
//! each holds, then ranks what is left in tiers -- the name is the query, it
//! starts with it, a word in it does, it holds it, the path holds it -- and
//! falls back to the letters in order only when the tiers found too few.
//! Typing narrows: a query that extends the last one looks only at what the
//! last one matched. Measured on 31,880 real paths: 1-6 ms a search, 15 at
//! worst, 7.8 ms for all eight keystrokes of `diagrams`.
//!
//! Never the home folder or a folder above it: snyvi does not scan `~`.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// Files kept per folder, as the folder reader's own quick-open caps it.
const FOLDER_CAP: usize = 40_000;
/// Files kept in all, so a dozen huge repositories cannot hold the daemon's
/// memory hostage.
const TOTAL_CAP: usize = 200_000;
/// An open of ⌘K within this of the last refresh does not stat again.
const FRESH: Duration = Duration::from_secs(2);
/// Folders almost never meant, even when committed: ranked last, not hidden.
const JUNK: [&str; 7] = ["node_modules", "vendor", "dist", "build", "target", ".next", "__pycache__"];
const IGNORE_FILES: [&str; 2] = [".gitignore", ".ignore"];
/// A directory changed this recently may change again within the same tick
/// of the file system's clock, and its time would not move: it is listed
/// again on the next refresh rather than trusted (git's "racy" rule).
const RACY: Duration = Duration::from_millis(100);

/// Whose folder a file is found in, which is what opening it needs: an open
/// root's file shows at once, a desk's opens the desk's folder first.
#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    Desk(i64),
    Root(String),
}

/// A folder to search, as the server knows it.
pub struct Want {
    pub path: PathBuf,
    pub label: String,
    pub key: Key,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Hit {
    pub name: String,
    /// From the folder searched, `/` separated.
    pub rel: String,
    /// The folders between, empty at the top.
    pub dir: String,
    /// The desk's or the open folder's name.
    pub under: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desk: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// What a refresh did: folders walked whole, directories listed again.
#[derive(Debug, Default, PartialEq)]
pub struct Refreshed {
    pub walked: usize,
    pub relisted: usize,
}

struct Folder {
    id: u16,
    path: PathBuf,
    label: String,
    key: Key,
    /// Each directory under it, by path from it, at the time it was listed.
    dirs: HashMap<String, SystemTime>,
    ignores: HashMap<String, SystemTime>,
}

/// One file: its path and the same lowercased, side by side in `Index::text`.
/// ASCII lowercasing keeps the two the same length.
#[derive(Clone, Copy)]
struct E {
    at: u32,
    len: u16,
    base: u16,
    folder: u16,
    mask: u32,
    junk: bool,
}

#[derive(Default)]
struct Index {
    built: bool,
    folders: Vec<Folder>,
    text: String,
    entries: Vec<E>,
    /// Bytes of `text` no entry points at any more; compacted past half.
    dead: usize,
    /// Each desk's folder as the index holds it: the folder searched and the
    /// path within it, for "this desk first".
    here: HashMap<i64, (u16, String)>,
    /// Bumped on every change, so a narrowed search never reads a stale list.
    gen: u64,
    last: Option<(u64, String, Vec<u32>)>,
}

impl Index {
    fn orig(&self, e: &E) -> &str {
        &self.text[e.at as usize..e.at as usize + e.len as usize]
    }
    fn lower(&self, e: &E) -> &str {
        let at = e.at as usize + e.len as usize;
        &self.text[at..at + e.len as usize]
    }
    fn folder(&self, id: u16) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }
    fn push(&mut self, folder: u16, path: &str) {
        if self.entries.len() >= TOTAL_CAP || path.len() > u16::MAX as usize {
            return;
        }
        let lower = path.to_ascii_lowercase();
        let base = path.rfind('/').map_or(0, |i| i + 1);
        let e = E {
            at: self.text.len() as u32,
            len: path.len() as u16,
            base: base as u16,
            folder,
            mask: mask(lower.as_bytes()),
            junk: lower.split('/').rev().skip(1).any(|s| JUNK.contains(&s)),
        };
        self.text.push_str(path);
        self.text.push_str(&lower);
        self.entries.push(e);
    }
    /// Drop the entries `gone` says, keeping count of the bytes they leave.
    fn drop_where(&mut self, gone: impl Fn(&str, &E) -> bool) {
        let mut keep = Vec::with_capacity(self.entries.len());
        let mut dead = 0;
        for e in &self.entries {
            if gone(self.orig(e), e) {
                dead += e.len as usize * 2;
            } else {
                keep.push(*e);
            }
        }
        self.entries = keep;
        self.dead += dead;
        if self.dead > self.text.len() / 2 {
            let old = std::mem::take(&mut self.text);
            for e in &mut self.entries {
                let (at, n) = (e.at as usize, e.len as usize * 2);
                e.at = self.text.len() as u32;
                self.text.push_str(&old[at..at + n]);
            }
            self.dead = 0;
        }
    }
}

/// What one walk saw: files, and directories and ignore files with their
/// times. `subdirs` is filled only by a one-directory listing.
#[derive(Default)]
struct Walked {
    files: Vec<String>,
    dirs: Vec<(String, SystemTime)>,
    ignores: Vec<(String, SystemTime)>,
    subdirs: Vec<String>,
}

/// What a refresh found for one folder, worked out without the lock.
enum Change {
    Add(Want, Walked),
    Replace(u16, Walked),
    Patch {
        id: u16,
        /// Directories listed again: their own files are replaced.
        relisted: Vec<String>,
        /// Directories gone or newly ignored: everything under them goes.
        gone: Vec<String>,
        add: Walked,
    },
    Drop(u16),
}

pub struct Finder {
    index: Mutex<Index>,
    busy: AtomicBool,
    at: Mutex<Option<Instant>>,
}

impl Default for Finder {
    fn default() -> Self {
        Finder::new()
    }
}

impl Finder {
    pub fn new() -> Finder {
        Finder {
            index: Mutex::new(Index::default()),
            busy: AtomicBool::new(false),
            at: Mutex::new(None),
        }
    }

    /// An index of one folder's paths as given, nothing walked: the bench's
    /// thirty thousand, and the tests'.
    pub fn from_paths<'a>(label: &str, paths: impl IntoIterator<Item = &'a str>) -> Finder {
        let f = Finder::new();
        {
            let mut ix = f.index.lock().unwrap();
            ix.folders.push(Folder {
                id: 0,
                path: PathBuf::from(label),
                label: label.to_string(),
                key: Key::Root(label.to_string()),
                dirs: HashMap::new(),
                ignores: HashMap::new(),
            });
            for p in paths {
                ix.push(0, p);
            }
            ix.here.insert(0, (0, String::new()));
            ix.built = true;
        }
        f
    }

    pub fn ready(&self) -> bool {
        self.index.lock().unwrap().built
    }

    /// Refresh unless one is running or one just ran. `wants` is asked only
    /// when this one goes ahead: it reads the store.
    pub fn refresh_if_due(
        &self,
        wants: impl FnOnce() -> (Vec<Want>, Vec<(i64, PathBuf)>),
    ) -> Option<Refreshed> {
        if self.at.lock().unwrap().is_some_and(|t| t.elapsed() < FRESH) {
            return None;
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return None;
        }
        // Cleared by dropping, so a refresh that panics does not leave the
        // index frozen for the life of the daemon.
        struct Done<'a>(&'a AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.busy);
        let (w, desks) = wants();
        let r = self.refresh(w, desks);
        *self.at.lock().unwrap() = Some(Instant::now());
        Some(r)
    }

    /// Bring the index up to the folders wanted: walk the new ones, drop the
    /// gone ones, and in the rest list again only the directories whose time
    /// moved. The disk is read without the lock; the lock is held to apply.
    pub fn refresh(&self, wants: Vec<Want>, desks: Vec<(i64, PathBuf)>) -> Refreshed {
        let wants = folders(wants);
        let snapshot: Vec<(u16, PathBuf, HashMap<String, SystemTime>, HashMap<String, SystemTime>)> = {
            let ix = self.index.lock().unwrap();
            ix.folders
                .iter()
                .map(|f| (f.id, f.path.clone(), f.dirs.clone(), f.ignores.clone()))
                .collect()
        };
        let mut done = Refreshed::default();
        let mut changes = vec![];
        for (id, path, _, _) in &snapshot {
            if !wants.iter().any(|w| &w.path == path) {
                changes.push(Change::Drop(*id));
            }
        }
        let mut relabel = vec![];
        for w in wants {
            let Some((id, path, dirs, ignores)) = snapshot.iter().find(|s| s.1 == w.path) else {
                done.walked += 1;
                let walked = walk(&w.path, &w.path, false);
                changes.push(Change::Add(w, walked));
                continue;
            };
            relabel.push((*id, w.label, w.key));
            if ignores.iter().any(|(rel, t)| mtime(&path.join(rel)) != Some(*t)) {
                done.walked += 1;
                changes.push(Change::Replace(*id, walk(path, path, false)));
                continue;
            }
            if let Some(c) = patch(*id, path, dirs, ignores, &mut done) {
                changes.push(c);
            }
        }
        let mut ix = self.index.lock().unwrap();
        let changed = !changes.is_empty();
        for c in changes {
            apply(&mut ix, c);
        }
        for (id, label, key) in relabel {
            if let Some(f) = ix.folders.iter_mut().find(|f| f.id == id) {
                f.label = label;
                f.key = key;
            }
        }
        let here = desks
            .into_iter()
            .filter_map(|(desk, root)| {
                let root = root.canonicalize().ok()?;
                let f = ix
                    .folders
                    .iter()
                    .filter(|f| root.starts_with(&f.path))
                    .max_by_key(|f| f.path.components().count())?;
                let rel = root.strip_prefix(&f.path).ok()?.to_string_lossy().replace('\\', "/");
                Some((desk, (f.id, if rel.is_empty() { rel } else { rel + "/" })))
            })
            .collect();
        ix.here = here;
        if changed || !ix.built {
            ix.gen += 1;
            ix.last = None;
        }
        ix.built = true;
        done
    }

    /// The best `k` files for `q`, this desk's first. None until the first
    /// walk is in.
    pub fn search(&self, q: &str, here: Option<i64>, k: usize) -> Option<Vec<Hit>> {
        let mut ix = self.index.lock().unwrap();
        if !ix.built {
            return None;
        }
        let ql = q.to_ascii_lowercase();
        let words: Vec<&str> = ql.split_whitespace().collect();
        if words.is_empty() || k == 0 {
            return Some(vec![]);
        }
        let qmask = words.iter().fold(0, |m, w| m | mask(w.as_bytes()));
        let fuzzy = ql.trim().len() >= 3;
        let here = here.and_then(|d| ix.here.get(&d).cloned());
        let narrow = match &ix.last {
            Some((g, lq, kept)) if *g == ix.gen && ql.starts_with(lq.as_str()) => Some(kept.clone()),
            _ => None,
        };
        let r: &Index = &ix;
        let n = r.entries.len() as u32;
        let (mut subs, mut fuzz, mut kept) = (Top::new(k), Top::new(k), vec![]);
        let mut each = |i: u32| {
            let e = &r.entries[i as usize];
            if e.mask & qmask != qmask {
                return;
            }
            let (path, lower) = (r.orig(e), r.lower(e));
            let orig = path.as_bytes();
            if !words.iter().all(|w| subseq(lower.as_bytes(), w.as_bytes())) {
                return;
            }
            // Kept by the letters in order, not by the tiers, so the next
            // keystroke's fuzzy fallback finds everything it could.
            kept.push(i);
            let (mut s, mut loose) = (0, false);
            for w in &words {
                match tier(orig, lower, e.base as usize, w) {
                    Some(x) => s += x,
                    None if fuzzy => {
                        loose = true;
                        s += loose_score(orig, lower.as_bytes(), e.base as usize, w.as_bytes());
                    }
                    None => return,
                }
            }
            s -= e.len as i32 / 2;
            if e.junk {
                s -= 400;
            }
            if here.as_ref().is_some_and(|(f, pre)| e.folder == *f && path.starts_with(pre.as_str())) {
                s += 60;
            }
            (if loose { &mut fuzz } else { &mut subs }).offer(s, i, path, r);
        };
        match &narrow {
            Some(list) => list.iter().for_each(|&i| each(i)),
            None => (0..n).for_each(&mut each),
        }
        let mut top = subs.list;
        if fuzzy && subs.seen < k {
            let at = |i: u32| r.orig(&r.entries[i as usize]);
            top.extend(fuzz.list);
            top.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| at(a.1).cmp(at(b.1))));
            top.truncate(k);
        }
        let hits = top.iter().filter_map(|&(_, i)| hit(r, &r.entries[i as usize])).collect();
        let gen = ix.gen;
        ix.last = Some((gen, ql, kept));
        Some(hits)
    }
}

/// The best `k` seen so far, best first, without sorting the rest.
struct Top {
    k: usize,
    seen: usize,
    list: Vec<(i32, u32)>,
}

impl Top {
    fn new(k: usize) -> Top {
        Top { k, seen: 0, list: Vec::with_capacity(k + 1) }
    }
    fn offer(&mut self, s: i32, i: u32, path: &str, ix: &Index) {
        self.seen += 1;
        if self.list.len() == self.k && s <= self.list[self.k - 1].0 {
            return;
        }
        // Equal scores in path order, so a list does not depend on the order
        // the disk handed the files over in.
        let at = self.list.partition_point(|&(t, j)| t > s || (t == s && ix.orig(&ix.entries[j as usize]) <= path));
        self.list.insert(at, (s, i));
        self.list.truncate(self.k);
    }
}

fn hit(ix: &Index, e: &E) -> Option<Hit> {
    let f = ix.folder(e.folder)?;
    let orig = ix.orig(e);
    let base = e.base as usize;
    let (desk, root) = match &f.key {
        Key::Desk(d) => (Some(*d), None),
        Key::Root(r) => (None, Some(r.clone())),
    };
    Some(Hit {
        name: orig[base..].to_string(),
        rel: orig.to_string(),
        dir: orig[..base.saturating_sub(1)].to_string(),
        under: f.label.clone(),
        desk,
        root,
    })
}

/// `rel` inside the folder `root`, both made canonical: the folder and the
/// file, or None for a path that leaves it, a file that is not there, or a
/// folder ⌘K does not search (`~` and above).
pub fn inside(root: &Path, rel: &str) -> Option<(PathBuf, PathBuf)> {
    let root = root.canonicalize().ok().filter(|p| p.is_dir())?;
    if dirs::home_dir()
        .and_then(|h| h.canonicalize().ok())
        .is_some_and(|h| h.starts_with(&root))
    {
        return None;
    }
    let relp = Path::new(rel.trim_matches('/'));
    if rel.trim_matches('/').is_empty()
        || relp.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    // A link inside could still point out, so the canonical paths decide.
    let file = root.join(relp).canonicalize().ok().filter(|p| p.is_file())?;
    file.starts_with(&root).then_some((root, file))
}

/// The folders to search: real, not `~` or above it, each once. A folder
/// inside another is searched as part of it; an open root wins over a desk
/// on the same folder, since its files open without opening anything.
fn folders(wants: Vec<Want>) -> Vec<Want> {
    let home = dirs::home_dir().and_then(|h| h.canonicalize().ok());
    let mut v: Vec<Want> = wants
        .into_iter()
        .filter_map(|w| {
            let path = w.path.canonicalize().ok().filter(|p| p.is_dir())?;
            if home.as_ref().is_some_and(|h| h.starts_with(&path)) {
                return None;
            }
            Some(Want { path, ..w })
        })
        .collect();
    v.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| matches!(a.key, Key::Desk(_)).cmp(&matches!(b.key, Key::Desk(_)))));
    let mut out: Vec<Want> = vec![];
    for w in v {
        if !out.iter().any(|k| w.path.starts_with(&k.path)) {
            out.push(w);
        }
    }
    out
}

/// The directories of one folder whose time moved, each listed again: its
/// files replaced, a new directory in it walked, a directory gone from it
/// dropped with everything under it. A new ignore file walks the folder
/// again: creating one moves its directory's time, which is how it is seen.
fn patch(
    id: u16,
    path: &Path,
    dirs: &HashMap<String, SystemTime>,
    ignores: &HashMap<String, SystemTime>,
    done: &mut Refreshed,
) -> Option<Change> {
    let (mut relisted, mut gone, mut add) = (vec![], vec![], Walked::default());
    for (rel, t) in dirs {
        let abs = path.join(rel);
        match mtime(&abs) {
            Some(now) if now == *t => continue,
            None => {
                gone.push(rel.clone());
                continue;
            }
            Some(_) => {}
        }
        done.relisted += 1;
        relisted.push(rel.clone());
        let one = walk(path, &abs, true);
        if one.ignores.iter().any(|(i, _)| !ignores.contains_key(i)) {
            done.walked += 1;
            return Some(Change::Replace(id, walk(path, path, false)));
        }
        let listed: HashSet<&str> = one.subdirs.iter().map(String::as_str).collect();
        for (d, _) in dirs.iter().filter(|(d, _)| parent(d) == Some(rel.as_str())) {
            if !listed.contains(d.as_str()) {
                gone.push(d.clone());
            }
        }
        for s in &one.subdirs {
            if !dirs.contains_key(s) {
                let w = walk(path, &path.join(s), false);
                add.files.extend(w.files);
                add.dirs.extend(w.dirs);
                add.ignores.extend(w.ignores);
            }
        }
        add.files.extend(one.files);
        add.dirs.extend(one.dirs);
        add.ignores.extend(one.ignores);
    }
    if relisted.is_empty() && gone.is_empty() {
        return None;
    }
    Some(Change::Patch { id, relisted, gone, add })
}

fn apply(ix: &mut Index, c: Change) {
    match c {
        Change::Drop(id) => {
            ix.drop_where(|_, e| e.folder == id);
            ix.folders.retain(|f| f.id != id);
        }
        Change::Add(w, walked) => {
            let Some(id) = (0..=u16::MAX).find(|i| !ix.folders.iter().any(|f| f.id == *i)) else {
                return;
            };
            ix.folders.push(Folder { id, path: w.path, label: w.label, key: w.key, dirs: HashMap::new(), ignores: HashMap::new() });
            apply(ix, Change::Replace(id, walked));
        }
        Change::Replace(id, walked) => {
            ix.drop_where(|_, e| e.folder == id);
            if let Some(f) = ix.folders.iter_mut().find(|f| f.id == id) {
                f.dirs = walked.dirs.into_iter().collect();
                f.ignores = walked.ignores.into_iter().collect();
            }
            for p in &walked.files {
                ix.push(id, p);
            }
        }
        Change::Patch { id, relisted, gone, add } => {
            let relisted: HashSet<String> = relisted.into_iter().collect();
            let under = |p: &str| gone.iter().any(|g| p == g || p.strip_prefix(g.as_str()).is_some_and(|r| r.starts_with('/')));
            ix.drop_where(|p, e| e.folder == id && (relisted.contains(parent(p).unwrap_or("")) || under(p)));
            if let Some(f) = ix.folders.iter_mut().find(|f| f.id == id) {
                f.dirs.retain(|d, _| !under(d.as_str()));
                f.ignores.retain(|d, _| {
                    let dir = parent(d.as_str()).unwrap_or("");
                    !under(dir) && !relisted.contains(dir)
                });
                f.dirs.extend(add.dirs);
                f.ignores.extend(add.ignores);
            }
            for p in &add.files {
                ix.push(id, p);
            }
        }
    }
}

/// Walk `dir` inside the folder `root`, with the folder reader's rules:
/// ignore files and hidden files left out, links not followed. `one` lists
/// `dir` alone and names the directories in it rather than entering them.
fn walk(root: &Path, dir: &Path, one: bool) -> Walked {
    let mut w = Walked::default();
    let mut b = ignore::WalkBuilder::new(dir);
    b.parents(true)
        .git_ignore(true)
        .git_global(true)
        .require_git(false)
        .hidden(true)
        .follow_links(false);
    if one {
        b.max_depth(Some(1));
    }
    for entry in b.build().flatten() {
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !entry.file_type().is_some_and(|t| t.is_dir()) {
            if entry.depth() > 0 {
                w.files.push(rel);
            }
            if w.files.len() >= FOLDER_CAP {
                break;
            }
            continue;
        }
        if one && entry.depth() > 0 {
            w.subdirs.push(rel);
            continue;
        }
        // Stat before the walker reads the directory: a file added between
        // the two is listed now and listed again next time, never missed.
        if let Some(mut t) = mtime(entry.path()) {
            if SystemTime::now().duration_since(t).map_or(true, |d| d < RACY) {
                t = SystemTime::UNIX_EPOCH;
            }
            for n in IGNORE_FILES {
                if let Some(it) = mtime(&entry.path().join(n)) {
                    w.ignores.push((join(&rel, n), it));
                }
            }
            w.dirs.push((rel, t));
        }
    }
    w
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// The directory a path is in, "" at the top, None for the top itself.
fn parent(p: &str) -> Option<&str> {
    if p.is_empty() {
        return None;
    }
    Some(p.rfind('/').map_or("", |i| &p[..i]))
}

fn bit(c: u8) -> u32 {
    match c {
        b'a'..=b'z' => 1 << (c - b'a'),
        b'0'..=b'9' => 1 << 26,
        b'.' => 1 << 27,
        b'-' | b'_' => 1 << 28,
        _ => 0,
    }
}

fn mask(s: &[u8]) -> u32 {
    s.iter().fold(0, |m, &c| m | bit(c))
}

/// The start of a word: after a separator, or a camelCase hump.
fn boundary(orig: &[u8], i: usize) -> bool {
    i == 0
        || matches!(orig[i - 1], b'/' | b'-' | b'_' | b'.' | b' ')
        || (orig[i].is_ascii_uppercase() && orig[i - 1].is_ascii_lowercase())
}

fn subseq(h: &[u8], w: &[u8]) -> bool {
    let mut it = h.iter();
    w.iter().all(|c| it.any(|x| x == c))
}

/// One word against one path, by the tiers. None when the path does not
/// hold it as written.
fn tier(orig: &[u8], lower: &str, base: usize, w: &str) -> Option<i32> {
    let name = &lower[base..];
    if name == w || (name.starts_with(w) && name.as_bytes().get(w.len()) == Some(&b'.')) {
        return Some(1000);
    }
    if name.starts_with(w) {
        return Some(900);
    }
    if let Some(at) = name.find(w) {
        return Some(if boundary(orig, base + at) { 800 } else { 700 });
    }
    let at = lower.find(w)?;
    Some(if boundary(orig, at) { 550 } else { 450 })
}

/// The letters in order, matched from the end so the name is preferred:
/// points for a word start, for a run, for being in the name; a gap costs.
/// Always under the tiers.
fn loose_score(orig: &[u8], lower: &[u8], base: usize, w: &[u8]) -> i32 {
    let (mut j, mut s, mut run, mut last) = (w.len() as isize - 1, 300.0f32, 0, usize::MAX);
    for i in (0..lower.len()).rev() {
        if j < 0 {
            break;
        }
        if lower[i] == w[j as usize] {
            if boundary(orig, i) {
                s += 12.0;
            }
            run = if last == i + 1 { run + 1 } else { 0 };
            s += run as f32 * 4.0;
            if i >= base {
                s += 3.0;
            }
            last = i;
            j -= 1;
        } else if last != usize::MAX {
            s -= 0.3;
        }
    }
    (s as i32).clamp(101, 400)
}

#[cfg(test)]
mod tests;
