//! Change detection by modification time, shared by browse mode (refresh the open
//! file when it changes on disk) and `snyvi watch` (re-send a file when it does).
//!
//! Polling rather than inotify, on purpose. The set is tiny: the files a reader has
//! open and the folders they have expanded, or the files named on the command line.
//! One stat each a few times a second costs nothing, behaves the same on every
//! platform and inside the static build, and needs no watch descriptors on a
//! repository with a hundred thousand files. A native watcher would need a debounce
//! on top anyway, because editors write in steps.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use crate::server::{emit, App};
use anyhow::{Context, Result};
use serde_json::json;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// How often the daemon looks at the files open in browse mode.
const BROWSE_TICK: Duration = Duration::from_millis(250);
/// How often it checks whether there is anything to look at.
const BROWSE_IDLE: Duration = Duration::from_secs(1);
/// How often `snyvi watch` looks at its files.
const CLI_TICK: Duration = Duration::from_millis(400);

/// What a file looked like at a glance. `None` for a file that is not there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub modified: SystemTime,
    pub len: u64,
}

pub fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp {
        modified: meta.modified().ok()?,
        len: meta.len(),
    })
}

/// Reports a change only once the new state has held for a whole tick, so a file
/// caught halfway through a write is not rendered or sent in that state.
pub struct Tracker<K> {
    seen: HashMap<K, Seen>,
}

struct Seen {
    settled: Option<Stamp>,
    candidate: Option<Option<Stamp>>,
}

impl<K: Hash + Eq> Tracker<K> {
    pub fn new() -> Tracker<K> {
        Tracker {
            seen: HashMap::new(),
        }
    }

    /// Feed the current stamp; true when a change has settled. The first sighting
    /// of a key is its baseline and never counts as a change.
    pub fn observe(&mut self, key: K, now: Option<Stamp>) -> bool {
        match self.seen.entry(key) {
            Entry::Vacant(v) => {
                v.insert(Seen {
                    settled: now,
                    candidate: None,
                });
                false
            }
            Entry::Occupied(mut o) => {
                let s = o.get_mut();
                if now == s.settled {
                    s.candidate = None;
                    return false;
                }
                if s.candidate == Some(now) {
                    s.settled = now;
                    s.candidate = None;
                    return true;
                }
                s.candidate = Some(now);
                false
            }
        }
    }

    pub fn retain(&mut self, keep: impl Fn(&K) -> bool) {
        self.seen.retain(|k, _| keep(k));
    }

    pub fn clear(&mut self) {
        self.seen.clear();
    }
}

impl<K: Hash + Eq> Default for Tracker<K> {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- browse mode ----------

/// Watch what browse mode has on screen and tell open tabs when it changes. Only
/// runs while a tab is connected and a folder is open; otherwise it sleeps.
pub fn spawn_browse_watcher(app: Arc<App>) {
    tokio::spawn(async move {
        let mut tracker: Tracker<(String, String)> = Tracker::new();
        loop {
            let watched = if app.events.receiver_count() == 0 {
                Vec::new()
            } else {
                app.browse.watched()
            };
            if watched.is_empty() {
                tracker.clear();
                tokio::time::sleep(BROWSE_IDLE).await;
                continue;
            }
            // A stat is microseconds on a local disk, but a network mount can stall,
            // and the executor has two threads to serve pages with.
            let stamps = tokio::task::spawn_blocking(move || {
                watched
                    .into_iter()
                    .map(|w| {
                        let s = stamp(&w.path);
                        (w, s)
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .unwrap_or_default();
            tracker.retain(|k| stamps.iter().any(|(w, _)| w.root == k.0 && w.rel == k.1));
            for (w, s) in stamps {
                if tracker.observe((w.root.clone(), w.rel.clone()), s) {
                    emit(
                        &app,
                        "changed",
                        json!({ "root": w.root, "path": w.rel, "dir": w.dir }),
                    );
                }
            }
            tokio::time::sleep(BROWSE_TICK).await;
        }
    });
}

// ---------- snyvi watch ----------

/// Send each file now, then again whenever it changes, until interrupted. Sends
/// carry origin "watch", so they coalesce with each other and with the hook's.
pub fn run_cli(paths: &Paths, files: &[PathBuf], base: &Payload, open: bool) -> Result<()> {
    let mut targets = Vec::with_capacity(files.len());
    for f in files {
        let p = f
            .canonicalize()
            .with_context(|| format!("no such file: {}", f.display()))?;
        if p.is_dir() {
            anyhow::bail!("{} is a directory; name the files to watch", f.display());
        }
        targets.push(p);
    }
    let mut tracker: Tracker<PathBuf> = Tracker::new();
    for p in &targets {
        tracker.observe(p.clone(), stamp(p));
        let url = send_one(paths, base, p)?;
        println!("{url}");
        if open {
            client::open_in_browser(&url);
        }
    }
    eprintln!(
        "watching {} file{}; ctrl-c to stop",
        targets.len(),
        if targets.len() == 1 { "" } else { "s" }
    );
    loop {
        std::thread::sleep(CLI_TICK);
        for p in &targets {
            let now = stamp(p);
            if !tracker.observe(p.clone(), now) {
                continue;
            }
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if now.is_none() {
                eprintln!("{}  {name} is gone; still watching", clock());
                continue;
            }
            match send_one(paths, base, p) {
                Ok(url) => eprintln!("{}  {name} → {url}", clock()),
                Err(e) => eprintln!("{}  {name}: {e:#}", clock()),
            }
        }
    }
}

fn send_one(paths: &Paths, base: &Payload, path: &Path) -> Result<String> {
    let payload = Payload {
        path: Some(path.to_string_lossy().to_string()),
        content: None,
        origin: Some("watch".into()),
        ..base.clone()
    };
    let resp = client::send(paths, &payload)?;
    Ok(resp
        .get("url")
        .and_then(|u| u.as_str())
        .unwrap_or_default()
        .to_string())
}

fn clock() -> String {
    use time::{format_description::FormatItem, macros::format_description, OffsetDateTime};
    const F: &[FormatItem] = format_description!("[hour]:[minute]:[second]");
    OffsetDateTime::now_utc()
        .to_offset(time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC))
        .format(F)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64, len: u64) -> Option<Stamp> {
        Some(Stamp {
            modified: SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
            len,
        })
    }

    #[test]
    fn a_change_counts_once_it_has_held_for_a_tick() {
        let mut t = Tracker::new();
        assert!(!t.observe("f", at(1, 10)), "first sighting is the baseline");
        assert!(!t.observe("f", at(1, 10)));
        assert!(!t.observe("f", at(2, 12)), "seen once: might be mid-write");
        assert!(t.observe("f", at(2, 12)), "held for a tick: settled");
        assert!(!t.observe("f", at(2, 12)), "reported once");
        // A write in progress keeps moving; nothing fires until it stops.
        assert!(!t.observe("f", at(3, 5)));
        assert!(!t.observe("f", at(3, 40)));
        assert!(t.observe("f", at(3, 40)));
        // Going missing is a change too, and so is coming back.
        assert!(!t.observe("f", None));
        assert!(t.observe("f", None));
        assert!(!t.observe("f", at(4, 40)));
        assert!(t.observe("f", at(4, 40)));
    }

    #[test]
    fn a_change_that_reverts_before_settling_is_not_reported() {
        let mut t = Tracker::new();
        t.observe("f", at(1, 10));
        assert!(!t.observe("f", at(2, 10)));
        assert!(!t.observe("f", at(1, 10)), "back to the settled state");
        assert!(!t.observe("f", at(1, 10)));
    }

    #[test]
    fn retain_forgets_keys_and_clear_resets_baselines() {
        let mut t = Tracker::new();
        t.observe("a", at(1, 1));
        t.observe("b", at(1, 1));
        t.retain(|k| *k == "a");
        assert!(!t.observe("b", at(9, 9)), "forgotten key starts over");
        t.clear();
        assert!(!t.observe("a", at(9, 9)));
    }

    #[test]
    fn stamp_follows_the_file() {
        let d = crate::store::tempdir::Dir::new("snyvi-watch");
        let f = d.path.join("x.md");
        assert!(stamp(&f).is_none());
        std::fs::write(&f, "one").unwrap();
        let a = stamp(&f).unwrap();
        assert_eq!(a.len, 3);
        std::fs::write(&f, "three").unwrap();
        let b = stamp(&f).unwrap();
        assert_ne!(a, b);
    }
}
