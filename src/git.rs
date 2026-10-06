//! What git says about a desk's folder: the branch, how much is changed, what
//! is not pushed, the commits of the last few weeks, and where the repository
//! lives on the web. Home reads it for the pick-up card and the log of the
//! days, and the desk's rail for its repo link.
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
    /// The repository's page on the web, from the `origin` remote (or the
    /// first remote when there is no `origin`): `https://github.com/o/r`.
    /// `None` with no remote, or one that is a path on this machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
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
    // Read from the config, never asked of the remote: no network. A repo
    // with no remote at all makes `git config` exit 1, which is `None`.
    s.remote = run(root, &["config", "--get-regexp", r"^remote\..*\.url$"])
        .and_then(|out| remote(&out))
        .and_then(|url| web_url(&url));
    Some(s)
}

/// The URL of `origin`, or of the first remote when there is none, out of
/// `git config --get-regexp` lines: `remote.<name>.url <url>`.
fn remote(out: &str) -> Option<String> {
    let urls: Vec<(&str, &str)> = out
        .lines()
        .filter_map(|l| {
            let (key, url) = l.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name, url.trim()))
        })
        .collect();
    urls.iter()
        .find(|(n, _)| *n == "origin")
        .or(urls.first())
        .map(|(_, u)| u.to_string())
}

/// A remote's URL as the repository's web page: `git@github.com:o/r.git`,
/// `ssh://git@host:22/o/r` and `https://user:token@host/o/r.git` are all
/// `https://host/o/r`. What it never keeps is a user, a password or a token,
/// a query or an ssh port. `None` for a path on this machine or anything that
/// does not read as a host and a path.
pub fn web_url(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        // scp-like, `[user@]host:path`: a colon before any slash. A Windows
        // drive (`C:\...`, `C:/...`) is a one-letter host, and a path.
        None => {
            let colon = url.find(':')?;
            if url[..colon].contains('/') || colon < 2 {
                return None;
            }
            ("ssh".to_string(), url)
        }
    };
    let web = match scheme.as_str() {
        "http" => "http",
        "https" | "ssh" | "git" | "git+ssh" | "ssh+git" => "https",
        _ => return None,
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (authority, path) = if url.contains("://") {
        rest.split_once('/')?
    } else {
        rest.split_once(':')?
    };
    // Whatever is before the last `@` is credentials: dropped, never shown.
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // A port is the web's only for http(s); an ssh port says nothing of it.
    let host = match host.rsplit_once(':') {
        Some((h, port))
            if !scheme.starts_with("http") && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            h
        }
        _ => host,
    };
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    let ok = |s: &str| !s.is_empty() && !s.contains(char::is_whitespace);
    if !ok(host) || !ok(path) || host.contains(['/', '\\']) {
        return None;
    }
    Some(format!("{web}://{host}/{path}"))
}

/// A repository as two snyvis can name it to each other without a path:
/// what a friend's frame says it is about (`crate::peer::Folder`), and what
/// `projects` keeps for each folder the reader has, to find it by.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Print {
    /// blake3 over the sorted root commits: the same in every clone, fork
    /// and worktree of it, whatever its remote. `None` in a shallow clone,
    /// whose oldest commits only look like roots.
    pub repo: Option<String>,
    /// blake3 over the remote's web address (`web_url`), lower-cased: the
    /// shallow clone's way of being found.
    pub remote: Option<String>,
}

/// The fingerprint of the repository `root` is in. Blocking, two or three
/// git commands through `run`, so call it off the async runtime: the
/// daemon's sweep (`server::peer_link`) and a send do. `None` for a folder
/// in no repository, the home directory's, or where git did not answer.
pub fn print(root: &Path) -> Option<Print> {
    let top = repository(root)?;
    if dirs::home_dir().is_some_and(|h| same(&h, &top)) {
        return None;
    }
    let shallow = run(root, &["rev-parse", "--is-shallow-repository"])
        .is_some_and(|s| s.trim() == "true");
    let repo = if shallow {
        None
    } else {
        run(root, &["rev-list", "--max-parents=0", "HEAD"]).and_then(|out| roots_print(&out))
    };
    let remote = run(root, &["config", "--get-regexp", r"^remote\..*\.url$"])
        .and_then(|out| remote(&out))
        .and_then(|url| web_url(&url))
        .map(|web| remote_print(&web));
    (repo.is_some() || remote.is_some()).then_some(Print { repo, remote })
}

/// `git rev-list --max-parents=0 HEAD`, one hash a line, as one print: sorted,
/// so the order git walks them in does not matter.
fn roots_print(out: &str) -> Option<String> {
    let mut roots: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if roots.is_empty() {
        return None;
    }
    roots.sort_unstable();
    roots.dedup();
    let h = blake3::hash(format!("snyvi repo v1 {}", roots.join(" ")).as_bytes());
    Some(h.to_hex()[..32].to_string())
}

fn remote_print(web: &str) -> String {
    let h = blake3::hash(format!("snyvi remote v1 {}", web.to_lowercase()).as_bytes());
    h.to_hex()[..32].to_string()
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
        // Plain, not `\\?\`: git's own runtime reads its working directory.
        .current_dir(dunce::simplified(dir))
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
    fn a_remote_is_its_web_page_and_never_its_credentials() {
        let cases = [
            (
                "git@github.com:snymrova/snyvi.git",
                Some("https://github.com/snymrova/snyvi"),
            ),
            ("github.com:o/r", Some("https://github.com/o/r")),
            (
                "ssh://git@gitlab.com:22/group/sub/repo.git",
                Some("https://gitlab.com/group/sub/repo"),
            ),
            (
                "git+ssh://git@codeberg.org/o/r",
                Some("https://codeberg.org/o/r"),
            ),
            ("https://github.com/o/r.git", Some("https://github.com/o/r")),
            ("https://github.com/o/r/", Some("https://github.com/o/r")),
            (
                "https://x-access-token:ghp_secret@github.com/o/r.git",
                Some("https://github.com/o/r"),
            ),
            (
                "https://user@bitbucket.org/o/r.git?x=1",
                Some("https://bitbucket.org/o/r"),
            ),
            (
                "https://git.example.com:8443/o/r",
                Some("https://git.example.com:8443/o/r"),
            ),
            (
                "http://localhost:3000/o/r.git",
                Some("http://localhost:3000/o/r"),
            ),
            ("git://example.org/o/r.git", Some("https://example.org/o/r")),
            ("file:///home/me/r.git", None),
            ("/home/me/r.git", None),
            ("../r", None),
            ("C:\\repos\\r", None),
            ("C:/repos/r", None),
            ("https://github.com", None),
            ("", None),
        ];
        for (url, want) in cases {
            assert_eq!(web_url(url).as_deref(), want, "{url}");
        }
        for (url, _) in cases {
            assert!(
                !web_url(url).unwrap_or_default().contains("secret"),
                "{url}"
            );
        }
    }

    #[test]
    fn origin_is_the_remote_and_else_the_first() {
        let out = "remote.upstream.url https://github.com/a/b\nremote.origin.url git@github.com:o/r.git\n";
        assert_eq!(remote(out).as_deref(), Some("git@github.com:o/r.git"));
        assert_eq!(
            remote("remote.fork.url https://github.com/f/r\nremote.up.url x\n").as_deref(),
            Some("https://github.com/f/r")
        );
        assert_eq!(remote(""), None);
    }

    #[test]
    fn a_repository_says_its_remote_without_asking_it() {
        let dir = crate::store::tempdir::Dir::new("snyvi-git-remote");
        let git = |args: &[&str]| run(&dir.path, args).is_some();
        if !git(&["init", "-q"]) {
            return; // no git here
        }
        assert_eq!(read(&dir.path, 0).and_then(|s| s.remote), None, "no remote");
        // A remote that does not exist: nothing is fetched, so nothing fails.
        assert!(git(&[
            "remote",
            "add",
            "origin",
            "https://tok@github.invalid/o/r.git"
        ]));
        assert_eq!(
            read(&dir.path, 0).and_then(|s| s.remote).as_deref(),
            Some("https://github.invalid/o/r")
        );
    }

    #[test]
    fn a_folder_in_no_repository_is_not_read() {
        let dir = crate::store::tempdir::Dir::new("snyvi-git");
        if repository(&dir.path).is_none() {
            assert!(read(&dir.path, 0).is_none());
        }
    }

    #[test]
    fn a_clone_and_a_worktree_have_the_print_their_repository_has() {
        let dir = crate::store::tempdir::Dir::new("snyvi-git-print");
        let (a, b, w, other) = (
            dir.path.join("a"),
            dir.path.join("b"),
            dir.path.join("w"),
            dir.path.join("other"),
        );
        let git = |at: &Path, args: &[&str]| run(at, args).is_some();
        let commit = |at: &Path, m: &str| {
            git(
                at,
                &[
                    "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
                    "commit", "-q", "--allow-empty", "-m", m,
                ],
            )
        };
        for d in [&a, &other] {
            std::fs::create_dir_all(d).unwrap();
            if !git(d, &["init", "-q"]) {
                return; // no git here
            }
        }
        assert_eq!(print(&a), None, "no commit yet, no remote: nothing to name it by");
        assert!(commit(&a, "first") && commit(&a, "second") && commit(&other, "first"));
        let pa = print(&a).expect("a repository with a commit");
        assert!(pa.repo.is_some() && pa.remote.is_none());
        assert!(git(&dir.path, &["clone", "-q", a.to_str().unwrap(), b.to_str().unwrap()]));
        assert!(git(&a, &["worktree", "add", "-q", w.to_str().unwrap()]));
        assert_eq!(print(&b).and_then(|p| p.repo), pa.repo, "a clone");
        assert_eq!(print(&w).and_then(|p| p.repo), pa.repo, "a worktree");
        assert_eq!(print(&a.join("sub")).and_then(|p| p.repo), None, "not a folder that is there");
        assert_ne!(print(&other).and_then(|p| p.repo), pa.repo, "another repository");
        // A remote names it too, whatever the case of its address.
        assert!(git(&b, &["remote", "set-url", "origin", "git@GitHub.com:O/R.git"]));
        assert_eq!(
            print(&b).and_then(|p| p.remote),
            Some(remote_print("https://github.com/o/r"))
        );
    }

    #[test]
    fn the_roots_are_one_print_in_any_order() {
        assert_eq!(roots_print("b\na\n"), roots_print("a\nb\n"));
        assert_ne!(roots_print("a\n"), roots_print("a\nb\n"));
        assert_eq!(roots_print("\n"), None);
        assert_eq!(roots_print("a").map(|p| p.len()), Some(32));
    }
}
