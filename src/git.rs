//! What git says about a desk's folder: the branch, how much is changed, what
//! is not pushed, and the commits of the last few weeks. Home reads it for the
//! pick-up card and the log of the days.
//!
//! Read-only and local. snyvi holds no tokens and calls nothing: this runs
//! `git status` and `git log` in a folder the reader gave a desk, with the same
//! care `project::modified` takes -- no fsmonitor hook runs, no index lock is
//! taken, no window flashes on Windows -- and gives up after `WAIT`. Never in
//! the home directory: a dotfiles repository there would have `git status`
//! walk every file the reader owns, and snyvi does not look through `~`.
//!
//! Home is drawn again on every event it shows, so the answers are kept for
//! `FRESH` per folder. A commit made a moment ago shows within that.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long one git command may take before its answer is not worth waiting for.
const WAIT: Duration = Duration::from_secs(2);
/// How long an answer is kept.
const FRESH: Duration = Duration::from_secs(30);
/// How far back the commits go: the eight weeks Home's rhythm shows.
pub const WEEKS: i64 = 8;
/// At most this many commits are read, however busy the weeks were.
const MOST: usize = 400;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct State {
    /// The branch, or the short commit a detached head is on.
    pub branch: String,
    /// Files changed, staged or not, untracked included.
    pub changed: usize,
    /// Commits on this branch its upstream does not have; `None` when the
    /// branch has no upstream to compare with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    /// The newest commit on HEAD, whenever it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Commit>,
    /// The commits on HEAD of the last `WEEKS` weeks, oldest first. Not sent
    /// as they are: Home turns them into the log and the rhythm.
    #[serde(skip)]
    pub commits: Vec<Commit>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Commit {
    pub at: i64,
    pub hash: String,
    pub subject: String,
}

/// One folder's answer, and when it was read.
type Reading = (Instant, Option<Arc<State>>);

/// The answers kept per folder, and when each was read.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<PathBuf, Reading>>);

impl Cache {
    /// What git says about `root`, from the cache while it is fresh. Blocking:
    /// call it off the async runtime. `None` for a folder that is not in a
    /// repository, is the home directory's, or where git did not answer.
    pub fn read(&self, root: &Path, now: i64) -> Option<Arc<State>> {
        let key = root.to_path_buf();
        if let Some((at, s)) = self.0.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            if at.elapsed() < FRESH {
                return s.clone();
            }
        }
        let s = read(root, now).map(Arc::new);
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Folders a desk no longer has are not kept forever.
        map.retain(|_, (at, _)| at.elapsed() < FRESH * 4);
        map.insert(key, (Instant::now(), s.clone()));
        s
    }
}

/// Read a folder's state now, without the cache.
pub fn read(root: &Path, now: i64) -> Option<State> {
    let top = repository(root)?;
    if dirs::home_dir().is_some_and(|h| same(&h, &top)) {
        return None;
    }
    let status = run(root, &["status", "--porcelain=v2", "--branch"])?;
    let mut s = parse_status(&status);
    let since = now - WEEKS * 7 * 86_400;
    let log = run(
        root,
        &[
            "log",
            "HEAD",
            "--no-merges",
            // More than eight digits is seconds since 1970 to git.
            &format!("--since={since}"),
            &format!("-n{MOST}"),
            "--format=%ct%x09%h%x09%s",
        ],
    )
    .unwrap_or_default();
    s.commits = parse_log(&log);
    s.last = s.commits.last().cloned().or_else(|| {
        run(root, &["log", "-1", "--format=%ct%x09%h%x09%s"]).and_then(|l| parse_log(&l).pop())
    });
    Some(s)
}

/// The top of the repository `dir` is in, found by looking for `.git` on the
/// way up -- no process for a folder that is in none.
fn repository(dir: &Path) -> Option<PathBuf> {
    let dir = dir.canonicalize().ok()?;
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

fn same(a: &Path, b: &Path) -> bool {
    a.canonicalize().ok().as_deref().unwrap_or(a) == b
}

/// One git command in `dir`, its output when it succeeded within `WAIT`.
fn run(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.fsmonitor=false", "--no-optional-locks"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::platform::CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    // Read on a thread, so a long answer cannot fill the pipe and stall the
    // child while this one waits on it.
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < WAIT => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let text = reader.join().ok()?;
    status.success().then_some(text)
}

/// `git status --porcelain=v2 --branch`: the headers say the branch and how far
/// ahead it is, and every other line is one changed file.
fn parse_status(out: &str) -> State {
    let mut s = State::default();
    let mut oid = String::new();
    for line in out.lines() {
        if let Some(h) = line.strip_prefix("# branch.head ") {
            s.branch = h.to_string();
        } else if let Some(o) = line.strip_prefix("# branch.oid ") {
            oid = o.chars().take(7).collect();
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            s.ahead = ab
                .split_whitespace()
                .next()
                .and_then(|a| a.strip_prefix('+'))
                .and_then(|a| a.parse().ok());
        } else if !line.starts_with('#') && !line.is_empty() {
            s.changed += 1;
        }
    }
    if s.branch == "(detached)" {
        s.branch = oid;
    }
    s
}

/// `%ct\t%h\t%s` per line, newest first as git gives it; oldest first back.
fn parse_log(out: &str) -> Vec<Commit> {
    let mut v: Vec<Commit> = out
        .lines()
        .filter_map(|l| {
            let mut f = l.splitn(3, '\t');
            Some(Commit {
                at: f.next()?.parse().ok()?,
                hash: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect();
    v.reverse();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_says_the_branch_what_is_ahead_and_how_much_changed() {
        let out = "# branch.oid 9adceca1234\n# branch.head claude/limits\n# branch.upstream origin/claude/limits\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/a.rs\n? notes.md\n";
        let s = parse_status(out);
        assert_eq!(s.branch, "claude/limits");
        assert_eq!(s.ahead, Some(2));
        assert_eq!(s.changed, 2);
    }

    #[test]
    fn a_branch_with_no_upstream_has_nothing_to_be_ahead_of() {
        let s = parse_status("# branch.oid 9adceca1234\n# branch.head main\n");
        assert_eq!(s.ahead, None);
        assert_eq!(s.changed, 0);
    }

    #[test]
    fn a_detached_head_is_the_commit_it_is_on() {
        let s = parse_status("# branch.oid 9adceca1234\n# branch.head (detached)\n");
        assert_eq!(s.branch, "9adceca");
    }

    #[test]
    fn the_log_comes_back_oldest_first_and_keeps_tabs_in_a_subject() {
        let v = parse_log("200\tb2\tsecond\twith a tab\n100\ta1\tfirst\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].hash, "a1");
        assert_eq!(v[1].subject, "second\twith a tab");
    }

    #[test]
    fn a_folder_in_no_repository_is_not_read() {
        let dir = crate::store::tempdir::Dir::new("snyvi-git");
        if repository(&dir.path).is_none() {
            assert!(read(&dir.path, 0).is_none());
        }
    }
}
