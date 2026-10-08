//! The runner: widget files' commands, run on their timers while their
//! widget is in view, and what they print drawn into their seat
//! (`crate::widget::files`, docs/WIDGETS.md).
//!
//! What it holds to, every round:
//!
//! - **Allowed, and unchanged.** Nothing runs until the reader allowed the
//!   folder from the window, and a folder whose hash moved since waits on
//!   "changed · Allow" -- unless the reader switched Rerun my edits on for
//!   it, when the new hash is taken as allowed. Agents in panels have a shell
//!   as the reader and could write here; Allow is consent and a guard
//!   against accidents, not a sandbox, and the docs say so.
//! - **In view.** A desk's widget runs while a page that can be seen shows
//!   that desk (the beacon, `events::in_view`), in the desk's folder; a
//!   global one while any page can be seen, in its own. A hidden widget, a
//!   tick while the last run is still going, and a desk with no folder do
//!   not run.
//! - **Cheaply, and bounded.** The login shell's `PATH` is read once (a
//!   daemon started by systemd has almost none), and each run is `sh -c`
//!   (`cmd /C` on Windows) with that, a scrubbed environment, the run's JSON
//!   on stdin, at most two at a time, at most 4 KB read, in a process group
//!   of its own that a timeout ends whole.

use super::*;
use crate::widget::{self, files};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How often the folders are looked at, and the timers checked.
const ROUND: Duration = Duration::from_secs(2);
/// The most a run may print that is read.
const OUT_MAX: u64 = 4096;
/// Runs at once, across every widget.
const AT_ONCE: usize = 2;

/// A folder's stamp (`files::stamp`), and the hash taken at it.
type Hashed = ((u128, u64, usize), Result<String, String>);

/// What the runner keeps between rounds.
#[derive(Default)]
struct Runner {
    /// A folder's stamp and the hash taken at it.
    hashes: HashMap<String, Hashed>,
    /// When each (desk, name) last started, and whether it is running now.
    last: HashMap<(i64, String), Instant>,
    running: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<(i64, String)>>>,
    /// The line each seat was last given, so a waiting widget is said once.
    said: HashMap<(i64, String), String>,
}

pub(crate) fn spawn(app: Arc<App>) {
    tokio::spawn(async move {
        let gate = Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
        let mut r = Runner::default();
        let path = login_path().await;
        loop {
            tokio::time::sleep(ROUND).await;
            if app.pages.load(Ordering::Relaxed) == 0 {
                continue;
            }
            round(&app, &mut r, &gate, &path);
        }
    });
}

/// One look: every widget folder, what each needs, and the runs that are due.
fn round(app: &Arc<App>, r: &mut Runner, gate: &Arc<tokio::sync::Semaphore>, path: &str) {
    let found = files::scan(&app.paths.config_dir);
    if found.is_empty() {
        return;
    }
    let desks = desks_in_view(app);
    let all = app.store.desks().unwrap_or_default();
    for f in found {
        let Ok(spec) = &f.spec else { continue };
        let Ok(prefs) = app.store.widgets(|c, _| widget::prefs(c, &f.name)) else {
            continue;
        };
        if prefs.hidden {
            continue;
        }
        // Where it would run now.
        let seats: Vec<(i64, Option<String>)> = match spec.scope {
            files::Scope::Global => {
                if !in_view(app, None) {
                    continue;
                }
                vec![(0, None)]
            }
            files::Scope::Desk => desks
                .iter()
                .filter_map(|id| all.iter().find(|d| d.id == *id))
                .map(|d| (d.id, Some(d.root.clone())))
                .collect(),
        };
        if seats.is_empty() {
            continue;
        }
        // Allowed, and unchanged since.
        let stamp = files::stamp(&f.folder).unwrap_or_default();
        let cached = r
            .hashes
            .get(&f.name)
            .filter(|(s, _)| *s == stamp)
            .map(|(_, h)| h.clone());
        let h = match cached {
            Some(h) => h,
            None => {
                let h = files::hash(&f.folder);
                r.hashes.insert(f.name.clone(), (stamp, h.clone()));
                h
            }
        };
        let hash = match h {
            Ok(h) => h,
            Err(why) => {
                for (desk, _) in &seats {
                    say(app, r, *desk, &f.name, &why);
                }
                continue;
            }
        };
        if prefs.trusted_hash != hash {
            if prefs.rerun_edits && !prefs.trusted_hash.is_empty() {
                let _ = app.store.widgets(|c, now| {
                    widget::set_prefs(c, &f.name, None, None, Some(&hash), None, now)
                });
            } else {
                let why = if prefs.trusted_hash.is_empty() {
                    format!(
                        "allow: {} wants to run {} every {} s",
                        spec.title, spec.run.command, spec.run.every
                    )
                } else {
                    format!("changed: {} changed since you allowed it", spec.title)
                };
                for (desk, _) in &seats {
                    say(app, r, *desk, &f.name, &why);
                }
                continue;
            }
        }
        for (desk, root) in seats {
            let key = (desk, f.name.clone());
            let cwd = match &root {
                None => f.folder.clone(),
                Some(root) if root.is_empty() || !Path::new(root).is_dir() => {
                    say(app, r, desk, &f.name, "this desk has no folder");
                    continue;
                }
                Some(root) => PathBuf::from(root),
            };
            if r.running.lock().unwrap().contains(&key) {
                continue;
            }
            if r.last
                .get(&key)
                .is_some_and(|t| t.elapsed() < Duration::from_secs(spec.run.every))
            {
                continue;
            }
            r.last.insert(key.clone(), Instant::now());
            r.said.remove(&key);
            r.running.lock().unwrap().insert(key.clone());
            let stdin = json!({
                "desk": all.iter().find(|d| d.id == desk).map(|d| json!({ "id": d.id, "name": d.name, "folder": d.root })),
                "settings": spec.settings_with(&prefs.settings),
                "snyvi": VERSION,
            });
            let (app, gate, running, spec, path) = (
                app.clone(),
                gate.clone(),
                r.running.clone(),
                spec.clone(),
                path.to_string(),
            );
            tokio::spawn(async move {
                let _held = gate.acquire_owned().await;
                let out = run_once(&spec, &cwd, &path, &stdin).await;
                land(&app, desk, &spec, out);
                running.lock().unwrap().remove(&(desk, spec.name.clone()));
            });
        }
    }
}

/// A line in a seat instead of a run: said once, until it changes.
fn say(app: &Arc<App>, r: &mut Runner, desk: i64, name: &str, why: &str) {
    let key = (desk, name.to_string());
    if r.said.get(&key).is_some_and(|w| w == why) {
        return;
    }
    r.said.insert(key, why.to_string());
    if app
        .store
        .widgets(|c, now| widget::fail(c, desk, name, why, "widget file", now))
        .is_ok()
    {
        announce(app, desk, name);
    }
}

/// What came of a run.
enum Ran {
    Printed(String),
    Failed(String),
}

/// Run a widget's command once: in `cwd`, with the run's JSON on stdin, and
/// only the reader's PATH, home and language from the daemon's environment
/// -- not the token, not snyvi's own variables, not a desk's keys.
async fn run_once(spec: &files::Spec, cwd: &Path, path: &str, stdin: &serde_json::Value) -> Ran {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/C").arg(&spec.run.command);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&spec.run.command);
        c
    };
    cmd.current_dir(cwd)
        .env_clear()
        .env("PATH", path)
        .env("SNYVI_WIDGET", &spec.name)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for k in [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Ran::Failed(format!("could not start: {e}")),
    };
    let pid = child.id();
    if let Some(mut i) = child.stdin.take() {
        let _ = i.write_all(stdin.to_string().as_bytes()).await;
    }
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let work = async {
        let (o, e) = tokio::join!(read_cap(out, OUT_MAX + 1), read_cap(err, 1024));
        (o, e, child.wait().await)
    };
    match tokio::time::timeout(Duration::from_secs(spec.run.timeout), work).await {
        Err(_) => {
            stop_group(pid);
            Ran::Failed(format!(
                "took longer than {} s and was stopped",
                spec.run.timeout
            ))
        }
        Ok((o, e, status)) => {
            if o.len() as u64 > OUT_MAX {
                stop_group(pid);
                return Ran::Failed(format!("printed more than {} KB", OUT_MAX / 1024));
            }
            let first_err = String::from_utf8_lossy(&e)
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            match status {
                Ok(s) if s.success() => Ran::Printed(String::from_utf8_lossy(&o).to_string()),
                Ok(s) => Ran::Failed(match (s.code(), first_err.is_empty()) {
                    (Some(c), true) => format!("exit {c}"),
                    (Some(c), false) => format!("exit {c}: {first_err}"),
                    (None, _) => "stopped by a signal".into(),
                }),
                Err(e) => Ran::Failed(format!("could not wait for it: {e}")),
            }
        }
    }
}

/// At most `cap` bytes of a pipe; the rest is left, and the pipe closed
/// when this returns, so a run printing without end stops on its own.
async fn read_cap<R: tokio::io::AsyncRead + Unpin>(p: Option<R>, cap: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(p) = p {
        let _ = AsyncReadExt::take(p, cap).read_to_end(&mut buf).await;
    }
    buf
}

/// End a run and everything it started: a `git` under `sh` does not live
/// on past its widget's timeout.
fn stop_group(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// What a run printed, in its seat; or why it printed nothing usable, over
/// the last good body.
fn land(app: &Arc<App>, desk: i64, spec: &files::Spec, ran: Ran) {
    let who = spec
        .run
        .command
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_start_matches("./")
        .to_string();
    let w = widget::Writer {
        source: widget::Source::File,
        writer: &who,
        pane: "",
    };
    let wrote = match ran {
        Ran::Failed(why) => app
            .store
            .widgets(|c, now| widget::fail(c, desk, &spec.name, &why, &who, now)),
        Ran::Printed(out) => match widget::Body::parse(&out) {
            Err(why) => app
                .store
                .widgets(|c, now| widget::fail(c, desk, &spec.name, &why, &who, now)),
            Ok(sent) => {
                let mut b = match sent {
                    widget::Sent::Body(b) => b,
                    widget::Sent::Clear => widget::Body {
                        md: String::new(),
                        tone: widget::Tone::None,
                        count: String::new(),
                        lines: spec.lines,
                        stale_after: 0,
                    },
                };
                // The file's own size unless the run said; and a body that
                // is rewritten on a timer is never old while it runs.
                if !out.trim_start().starts_with('{') {
                    b.lines = spec.lines;
                    b.stale_after = 0;
                }
                let html = crate::render::widget_md(&b.md);
                app.store.widgets(|c, now| {
                    widget::put(c, desk, &spec.name, &b, &html, &w, now).map(|_| ())
                })
            }
        },
    };
    if wrote.is_ok() {
        announce(app, desk, &spec.name);
    }
}

/// The reader's PATH as their login shell has it, read once: a daemon
/// started by systemd or launchd has almost none, and a login shell on
/// every run would be slow. The daemon's own when the shell does not say.
async fn login_path() -> String {
    let own = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        return own;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let ask = tokio::process::Command::new(&shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(5), ask).await {
        Ok(Ok(o)) if o.status.success() => {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if p.is_empty() {
                own
            } else {
                p
            }
        }
        _ => own,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn spec(command: &str, timeout: u64) -> files::Spec {
        files::Spec {
            name: "t".into(),
            title: "T".into(),
            scope: files::Scope::Global,
            run: files::Run {
                command: command.into(),
                every: 5,
                timeout,
            },
            lines: 3,
            settings: Default::default(),
        }
    }

    async fn run(command: &str, timeout: u64) -> Ran {
        let dir = std::env::temp_dir();
        let path = std::env::var("PATH").unwrap_or_default();
        run_once(
            &spec(command, timeout),
            &dir,
            &path,
            &json!({ "settings": { "x": 1 } }),
        )
        .await
    }

    #[tokio::test]
    async fn a_run_prints_its_body_and_reads_its_stdin() {
        match run("cat", 5).await {
            Ran::Printed(o) => assert!(o.contains(r#""x":1"#), "{o}"),
            Ran::Failed(w) => panic!("{w}"),
        }
    }

    #[tokio::test]
    async fn a_failure_says_its_exit_and_first_line() {
        match run("echo nope >&2; exit 3", 5).await {
            Ran::Failed(w) => assert_eq!(w, "exit 3: nope"),
            Ran::Printed(o) => panic!("{o}"),
        }
    }

    #[tokio::test]
    async fn a_timeout_stops_the_whole_group() {
        let mark = std::env::temp_dir().join(format!("snyvi-widget-group-{}", std::process::id()));
        let _ = std::fs::remove_file(&mark);
        // A child of the shell that would write the mark after the timeout.
        let cmd = format!("(sleep 2; touch {}) & sleep 30", mark.display());
        match run(&cmd, 1).await {
            Ran::Failed(w) => assert!(w.contains("took longer than 1 s"), "{w}"),
            Ran::Printed(o) => panic!("{o}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            !mark.exists(),
            "the shell's child lived on past the timeout"
        );
    }

    #[tokio::test]
    async fn more_than_four_kilobytes_is_refused() {
        match run("head -c 10000 /dev/zero | tr '\\0' x", 5).await {
            Ran::Failed(w) => assert!(w.contains("more than 4 KB"), "{w}"),
            Ran::Printed(o) => panic!("{} bytes", o.len()),
        }
    }

    #[tokio::test]
    async fn the_token_is_not_in_its_environment() {
        std::env::set_var("SNYVI_TOKEN_TEST_LEAK", "secret");
        match run("env", 5).await {
            Ran::Printed(o) => {
                assert!(!o.contains("SNYVI_TOKEN_TEST_LEAK"));
                assert!(o.contains("SNYVI_WIDGET=t"));
            }
            Ran::Failed(w) => panic!("{w}"),
        }
    }
}
