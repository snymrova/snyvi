//! Widget files: a folder in `<config>/widgets/<name>/` holding a
//! `widget.json` and the command it names, which snyvi runs on a timer
//! while the widget is in view and draws what it prints (docs/WIDGETS.md).
//!
//! Nothing in here runs anything: this reads the folders, says what each
//! one asks for, hashes what the reader allowed, and writes a starter. The
//! running is the daemon's (`crate::server::widget_run`).

use super::{name_ok, LINES_DEFAULT, LINES_MAX, LINES_MIN};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The most a widget's folder may hold, all its files together: what is
/// hashed is what was allowed, and a folder this size is read in a moment.
pub const FOLDER_MAX: u64 = 64 * 1024;
/// How often a command may run, and how long it may take.
pub const EVERY_MIN: u64 = 5;
pub const EVERY_DEFAULT: u64 = 60;
pub const TIMEOUT_MAX: u64 = 30;
pub const TIMEOUT_DEFAULT: u64 = 10;

/// Where the reader's widget folders are.
pub fn dir(config_dir: &Path) -> PathBuf {
    config_dir.join("widgets")
}

/// Where a widget runs: on the desk on the page, in its folder, or
/// everywhere, in its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Desk,
    Global,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub command: String,
    #[serde(default = "every_default")]
    pub every: u64,
    #[serde(default = "timeout_default")]
    pub timeout: u64,
}

fn every_default() -> u64 {
    EVERY_DEFAULT
}
fn timeout_default() -> u64 {
    TIMEOUT_DEFAULT
}

/// One setting, drawn by snyvi on /sidebars as a row: a string, a number,
/// a choice or on/off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub default: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}

/// What a `widget.json` says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spec {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub scope: Scope,
    pub run: Run,
    #[serde(default = "lines_default")]
    pub lines: u8,
    #[serde(default)]
    pub settings: BTreeMap<String, Field>,
}

fn lines_default() -> u8 {
    LINES_DEFAULT
}

impl Spec {
    /// The spec as it is run: every bound applied, the title filled in.
    fn bounded(mut self) -> Spec {
        self.run.every = self.run.every.max(EVERY_MIN);
        self.run.timeout = self.run.timeout.clamp(1, TIMEOUT_MAX);
        self.lines = self.lines.clamp(LINES_MIN, LINES_MAX);
        if self.title.trim().is_empty() {
            self.title = super::title_of(&self.name);
        }
        self.title = self.title.trim().chars().take(40).collect();
        self
    }

    /// The settings a run is given: each field's default, then what the
    /// reader set, for the fields the widget has.
    pub fn settings_with(&self, reader: &str) -> Value {
        let set: serde_json::Map<String, Value> = serde_json::from_str(reader).unwrap_or_default();
        let mut out = serde_json::Map::new();
        for (k, f) in &self.settings {
            out.insert(k.clone(), set.get(k).cloned().unwrap_or_else(|| f.default.clone()));
        }
        Value::Object(out)
    }
}

/// A folder found under the widgets folder: its spec, or why it has none.
#[derive(Debug, Clone)]
pub struct Found {
    pub name: String,
    pub folder: PathBuf,
    pub spec: Result<Spec, String>,
}

/// Every widget folder, by name. A folder whose `widget.json` does not read,
/// or names another widget, is listed with the reason, so /sidebars can
/// say it rather than leave the reader guessing.
pub fn scan(config_dir: &Path) -> Vec<Found> {
    let Ok(rd) = std::fs::read_dir(dir(config_dir)) else {
        return Vec::new();
    };
    let mut out: Vec<Found> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name_ok(&name).then(|| Found { spec: read(&e.path(), &name), name, folder: e.path() })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// One folder's `widget.json`, read and bounded.
pub fn read(folder: &Path, name: &str) -> Result<Spec, String> {
    let text = std::fs::read_to_string(folder.join("widget.json")).map_err(|_| "it has no widget.json".to_string())?;
    let spec: Spec = serde_json::from_str(&text).map_err(|e| format!("widget.json does not read: {e}"))?;
    if spec.name != name {
        return Err(format!("widget.json says \"{}\", in a folder called {name}", spec.name));
    }
    if spec.run.command.trim().is_empty() {
        return Err("widget.json has no run.command".into());
    }
    Ok(spec.bounded())
}

/// A stamp of everything in a folder, cheap to take every round: what
/// changed in it moves it, and only then is the folder hashed again.
pub fn stamp(folder: &Path) -> Option<(u128, u64, usize)> {
    let mut newest = 0u128;
    let (mut bytes, mut n) = (0u64, 0usize);
    for f in files(folder) {
        let m = std::fs::metadata(&f).ok()?;
        let t = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        newest = newest.max(t);
        bytes += m.len();
        n += 1;
    }
    Some((newest, bytes, n))
}

/// Every regular file under a folder, in a fixed order; links are not
/// followed, so the hash is of what is in the folder and nothing it points
/// to.
fn files(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut todo = vec![folder.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                todo.push(e.path());
            } else if t.is_file() {
                out.push(e.path());
            }
        }
    }
    out.sort();
    out
}

/// The hash of a whole folder -- every file's path in it and its bytes --
/// which is what the reader allows: a change to anything in it, the script
/// or a file it reads, asks again. Refused past `FOLDER_MAX`.
pub fn hash(folder: &Path) -> Result<String, String> {
    let mut h = blake3::Hasher::new();
    let mut total = 0u64;
    for f in files(folder) {
        let rel = f.strip_prefix(folder).unwrap_or(&f).to_string_lossy().replace('\\', "/");
        let bytes = std::fs::read(&f).map_err(|e| format!("could not read {rel}: {e}"))?;
        total += bytes.len() as u64;
        if total > FOLDER_MAX {
            return Err(format!("the folder holds more than {} KB", FOLDER_MAX / 1024));
        }
        h.update(rel.as_bytes());
        h.update(&[0]);
        h.update(&(bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    Ok(h.finalize().to_hex().to_string())
}

/// A starter widget, for `snyvi widget new`: a `widget.json` and a script
/// that prints a body, on this system's shell.
pub fn starter(name: &str, scope: Scope) -> (String, &'static str, String) {
    let script = if cfg!(windows) { "run.ps1" } else { "run.sh" };
    let command = if cfg!(windows) {
        "powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1".to_string()
    } else {
        "./run.sh".to_string()
    };
    let spec = Spec {
        name: name.to_string(),
        title: super::title_of(name),
        scope,
        run: Run { command, every: 30, timeout: 5 },
        lines: 2,
        settings: BTreeMap::new(),
    };
    let json = serde_json::to_string_pretty(&spec).unwrap_or_default() + "\n";
    let body = if cfg!(windows) {
        "# stdin: {\"desk\":{...},\"settings\":{...},\"snyvi\":\"<version>\"}\n\
         # Print Markdown, or one JSON object: {\"body\":\"...\",\"tone\":\"ok\",\"count\":\"3\"}\n\
         $now = Get-Date -Format HH:mm\n\
         Write-Output \"**$(Split-Path -Leaf (Get-Location))** · $now\"\n"
            .to_string()
    } else {
        "#!/bin/sh\n\
         # stdin: {\"desk\":{...},\"settings\":{...},\"snyvi\":\"<version>\"}\n\
         # cwd: the desk's folder (a desk widget) or this folder (a global one).\n\
         # Print Markdown, or one JSON object: {\"body\":\"...\",\"tone\":\"ok\",\"count\":\"3\"}\n\
         printf '**%s** · %s\\n' \"$(basename \"$PWD\")\" \"$(date +%H:%M)\"\n"
            .to_string()
    };
    (json, script, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snyvi-wfiles-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(dir(&d).join("git")).unwrap();
        d
    }

    #[test]
    fn a_spec_is_read_and_bounded() {
        let cfg = folder("read");
        let w = dir(&cfg).join("git");
        std::fs::write(
            w.join("widget.json"),
            r#"{"name":"git","run":{"command":"./run.sh","every":1,"timeout":99},"lines":9,
               "settings":{"base":{"type":"string","default":"main"}}}"#,
        )
        .unwrap();
        let found = scan(&cfg);
        assert_eq!(found.len(), 1);
        let s = found[0].spec.clone().unwrap();
        assert_eq!((s.run.every, s.run.timeout, s.lines), (EVERY_MIN, TIMEOUT_MAX, LINES_MAX));
        assert_eq!(s.title, "Git");
        assert_eq!(s.settings_with(r#"{"base":"dev","other":1}"#), serde_json::json!({ "base": "dev" }));
        assert_eq!(s.settings_with("{}"), serde_json::json!({ "base": "main" }));
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn a_folder_that_says_another_name_is_listed_with_why() {
        let cfg = folder("name");
        std::fs::write(dir(&cfg).join("git").join("widget.json"), r#"{"name":"ci","run":{"command":"x"}}"#).unwrap();
        let found = scan(&cfg);
        assert!(found[0].spec.as_ref().unwrap_err().contains("in a folder called git"));
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn the_hash_covers_every_file_and_has_a_cap() {
        let cfg = folder("hash");
        let w = dir(&cfg).join("git");
        std::fs::write(w.join("run.sh"), "echo a").unwrap();
        let a = hash(&w).unwrap();
        std::fs::create_dir_all(w.join("lib")).unwrap();
        std::fs::write(w.join("lib").join("x.sh"), "echo b").unwrap();
        let b = hash(&w).unwrap();
        assert_ne!(a, b, "a file the script could source is in the hash");
        assert_eq!(b, hash(&w).unwrap());
        std::fs::write(w.join("big"), vec![b'x'; FOLDER_MAX as usize]).unwrap();
        assert!(hash(&w).unwrap_err().contains("more than 64 KB"));
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn a_starter_reads_back() {
        let (json, _, _) = starter("disk-free", Scope::Global);
        let s: Spec = serde_json::from_str(&json).unwrap();
        assert_eq!((s.name.as_str(), s.title.as_str(), s.scope), ("disk-free", "Disk free", Scope::Global));
    }
}
