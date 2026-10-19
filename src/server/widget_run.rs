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
//!   (`cmd /C` on Windows) with that -- the widget's own folder first on it,
//!   and in `SNYVI_WIDGET_DIR` -- a scrubbed environment, the run's JSON on
//!   stdin, at most two at a time, at most 4 KB read, in a process group of
//!   its own that a timeout ends whole.
//! - **Where the reader put it, while they want it** (#111). A desk's own
//!   widget runs on its desk and nowhere else; a shared one on the desks its
//!   prefs list (none is every desk), and its by-line says so. One past its
//!   time, or whose panel closed, is switched off -- not removed -- and its
//!   seats go. A pushed box allowed for a while is cleared the same way.
//! - **Reachable, and not forever failing.** A desk widget whose command
//!   cannot reach its own files (`files::lint`) is not run, and its seat
//!   says how to write it. One that fails `FAILS_TO_STOP` times in a row
//!   for the same reason stops on that desk, says so, and the agent that
//!   proposed it is told; Try again, Allow or an edit runs it again.

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

/// The login shell's PATH, once the runner has read it: Try once on a card
/// runs with the same.
static LOGIN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// The PATH a run is given: the login shell's, or the daemon's own before
/// the runner has read it.
pub(crate) fn path_now() -> String {
    LOGIN_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

/// Failures in a row, by (desk, name), and the reason the last one gave.
type Fails = std::sync::Arc<std::sync::Mutex<HashMap<(i64, String), (u8, String)>>>;

/// What the runner keeps between rounds.
#[derive(Default)]
struct Runner {
    /// When each (desk, name) last started, and whether it is running now.
    last: HashMap<(i64, String), Instant>,
    running: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<(i64, String)>>>,
    /// The line each seat was last given, so a waiting widget is said once.
    said: HashMap<(i64, String), String>,
    /// The hash each widget last ran as allowed: one allowed anew -- by
    /// Allow, or its own edit with Rerun my edits on -- runs at the next
    /// look rather than at the end of its `every`, so its seat stops asking.
    /// By the widget's key.
    ran_as: HashMap<String, String>,
    fails: Fails,
}

pub(crate) fn spawn(app: Arc<App>) {
    tokio::spawn(async move {
        let gate = Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
        let mut r = Runner::default();
        adopt(&app);
        let path = login_path().await;
        let _ = LOGIN_PATH.set(path.clone());
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
    let live = |p: &str| app.panes.is_running(p);
    end_asks(app);
    let found = files::scan(&app.paths.config_dir);
    forget_gone(app, r, &found);
    if found.is_empty() {
        return;
    }
    let desks = desks_in_view(app);
    let all = app.store.desks().unwrap_or_default();
    for f in found {
        let Ok(spec) = &f.spec else { continue };
        let Ok(prefs) = app.store.clocked(|c, _| widget::prefs(c, f.owner, &f.name)) else {
            continue;
        };
        if prefs.hidden {
            continue;
        }
        // Its time is up: off, as the reader's switch would have it, with
        // `until` kept for /sidebars to say when.
        if prefs.ended(crate::store::now(), live) {
            let off = widget::Change {
                hidden: Some(true),
                ..Default::default()
            };
            if let Ok(ds) = app.store.clocked(|c, now| {
                widget::set_prefs(c, f.owner, &f.name, &off, now)?;
                widget::desks_of(c, f.owner, &f.name)
            }) {
                for d in ds {
                    announce(app, d, &f.name);
                }
            }
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
                .filter(|id| prefs.on_desk(**id))
                .filter_map(|id| all.iter().find(|d| d.id == *id))
                .map(|d| (d.id, Some(d.root.clone())))
                .collect(),
        };
        if seats.is_empty() {
            continue;
        }
        let by = byline(spec, &prefs);
        let who = Who {
            spec,
            owner: f.owner,
            by: &by,
        };
        // A command that cannot reach its own script fails on every desk,
        // every time: not run, and the seat says how to write it.
        if let Err(why) = files::lint(spec, &f.folder) {
            for (desk, _) in &seats {
                say(app, r, *desk, &who, &why);
            }
            continue;
        }
        // Allowed, and unchanged since: hashed every round (at most 96 KB),
        // since a cheaper stamp -- an mtime, a size -- is the writer's to
        // set, and what the reader allowed must be what runs.
        let hash = match files::hash(&f.folder) {
            Ok(h) => h,
            Err(why) => {
                for (desk, _) in &seats {
                    say(app, r, *desk, &who, &why);
                }
                continue;
            }
        };
        if prefs.trusted_hash != hash {
            if prefs.rerun_edits && !prefs.trusted_hash.is_empty() {
                let took = widget::Change {
                    trusted_hash: Some(&hash),
                    ..Default::default()
                };
                let _ = app
                    .store
                    .clocked(|c, now| widget::set_prefs(c, f.owner, &f.name, &took, now));
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
                    say(app, r, *desk, &who, &why);
                }
                continue;
            }
        }
        let key = f.key();
        if r.ran_as.get(&key) != Some(&hash) {
            // Allowed anew, or edited: whatever stopped it may be fixed.
            let mine = |d: i64, n: &str| n == f.name && (f.owner == 0 || d == f.owner);
            r.last.retain(|(d, n), _| !mine(*d, n));
            r.fails.lock().unwrap().retain(|(d, n), _| !mine(*d, n));
            if r.ran_as.contains_key(&key) {
                let _ = app
                    .store
                    .clocked(|c, _| widget::unstop(c, f.owner, &f.name, None));
            }
            r.ran_as.insert(key, hash.clone());
        }
        start_seats(app, r, gate, path, &f, &who, &prefs, &all, seats);
    }
}

/// A widget whose folder is gone -- removed, moved by hand, an agent's
/// `rm` -- leaves no seat behind: what it last said is cleared and the
/// pages told, and its last run is forgotten, so one put back by Undo
/// runs on the next round rather than a period later. A seat that outlived
/// its folder could be neither allowed nor removed (1.46).
fn forget_gone(app: &Arc<App>, r: &mut Runner, found: &[files::Found]) {
    r.last
        .retain(|(_, n), _| found.iter().any(|f| &f.name == n));
    let keep: Vec<(i64, String)> = found.iter().map(|f| (f.owner, f.name.clone())).collect();
    let Ok(gone) = app
        .store
        .clocked(|c, _| widget::clear_files_except(c, &keep))
    else {
        return;
    };
    for (desk, name) in gone {
        r.said.remove(&(desk, name.clone()));
        r.ran_as.retain(|k, _| k != &name && !k.ends_with(&format!("/{name}")));
        announce(app, desk, &name);
    }
}

/// Boxes allowed for a while whose while is up: taken off, and said.
fn end_asks(app: &Arc<App>) {
    let live = |p: &str| app.panes.is_running(p);
    if let Ok(ended) = app.store.clocked(|c, now| {
        let due = widget::asks_ending(c, now, live)?;
        for (d, n) in &due {
            widget::clear(c, *d, n, widget::Source::Push)?;
        }
        Ok(due)
    }) {
        for (d, n) in ended {
            announce(app, d, &n);
        }
    }
}

/// A widget file as one round sees it: its spec, the desk it belongs to
/// (0: none), and its seat's by-line.
struct Who<'a> {
    spec: &'a files::Spec,
    owner: i64,
    by: &'a str,
}

/// What a widget file's seat says under its head: how often it runs, and
/// for a shared desk widget where else -- the exception named, not the
/// default, so a desk's own says only "every 2 min".
fn byline(spec: &files::Spec, prefs: &widget::Prefs) -> String {
    let every = widget::every_words(spec.run.every);
    if spec.scope == files::Scope::Global || prefs.owner != 0 {
        return every;
    }
    match prefs.desks.len() {
        0 => format!("every desk · {every}"),
        1 => format!("shared · {every}"),
        n => format!("{n} desks · {every}"),
    }
}

/// A widget allowed and unchanged, run on each of its seats that is due:
/// not running already, its time since the last run up, not stopped.
#[allow(clippy::too_many_arguments)]
fn start_seats(
    app: &Arc<App>,
    r: &mut Runner,
    gate: &Arc<tokio::sync::Semaphore>,
    path: &str,
    f: &files::Found,
    who: &Who,
    prefs: &widget::Prefs,
    all: &[crate::desk::Desk],
    seats: Vec<(i64, Option<String>)>,
) {
    let spec = who.spec;
    for (desk, root) in seats {
        let key = (desk, f.name.clone());
        let cwd = match &root {
            None => f.folder.clone(),
            Some(root) if root.is_empty() || !Path::new(root).is_dir() => {
                say(app, r, desk, who, "this desk has no folder");
                continue;
            }
            Some(root) => PathBuf::from(root),
        };
        if r.running.lock().unwrap().contains(&key) {
            continue;
        }
        let (seat, full) = app
            .store
            .clocked(|c, _| Ok((widget::seat_of(c, desk, &f.name)?, widget::slot_full(c, desk)?)))
            .unwrap_or((None, false));
        // Due by the clock that ran it last, or by the wall: the monotonic
        // clock stands still while the machine sleeps, and a widget run at
        // nine should run at the wake, not an hour after it.
        let every = Duration::from_secs(spec.run.every);
        let since_wall = seat
            .as_ref()
            .map(|s| crate::store::now() - s.updated_at)
            .unwrap_or(i64::MAX);
        if r.last.get(&key).is_some_and(|t| t.elapsed() < every)
            && since_wall < spec.run.every as i64
        {
            continue;
        }
        // Stopped after failing: until the reader says Try again.
        if seat
            .as_ref()
            .is_some_and(|s| s.error.starts_with(widget::STOPPED))
        {
            continue;
        }
        // No seat, and none free: nothing it prints could be shown. Said
        // in the log, since the seat that would say it is the one missing.
        if seat.is_none() && full {
            if r.said.get(&key).is_none() {
                eprintln!(
                    "snyvi: widget {} does not run on desk {desk}: the desk has {} widgets already",
                    f.name,
                    widget::DESK_MAX
                );
                r.said.insert(key.clone(), "full".into());
            }
            continue;
        }
        // The keys it named, from the desk it belongs to. One not on the
        // desk is said in the seat, and the run waits for it.
        let keys: Vec<(String, String)> = spec
            .keys
            .iter()
            .filter_map(|k| app.secrets.value(who.owner, k).map(|v| (k.clone(), v)))
            .collect();
        if keys.len() < spec.keys.len() {
            let missing: Vec<&str> = spec
                .keys
                .iter()
                .filter(|k| !keys.iter().any(|(n, _)| n == *k))
                .map(String::as_str)
                .collect();
            say(
                app,
                r,
                desk,
                who,
                &format!(
                    "needs the key {} on this desk: add it under Keys",
                    missing.join(", ")
                ),
            );
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
        let (app, gate, running, fails, spec, folder, path, owner, by) = (
            app.clone(),
            gate.clone(),
            r.running.clone(),
            r.fails.clone(),
            spec.clone(),
            f.folder.clone(),
            path.to_string(),
            who.owner,
            who.by.to_string(),
        );
        tokio::spawn(async move {
            let _held = gate.acquire_owned().await;
            let out = run_once(&spec, &folder, &cwd, &path, &stdin, &keys).await;
            let who = Who {
                spec: &spec,
                owner,
                by: &by,
            };
            // Removed, or moved, while it ran: what it printed has no seat
            // to go to, and the next round runs it where it is now.
            if folder.is_dir() {
                land(&app, desk, &who, &cwd, &fails, out);
            }
            running.lock().unwrap().remove(&(desk, spec.name.clone()));
        });
    }
}

/// A line in a seat instead of a run: said once, until it changes. A seat
/// that stopped keeps its stop through a passing line (the desk's folder
/// gone for a round, the folder too big) -- Try again, Allow or an edit
/// end a stop, not a round -- and only Allow's and changed's lines, which
/// the reader must answer, write over it.
fn say(app: &Arc<App>, r: &mut Runner, desk: i64, who: &Who, why: &str) {
    let name = &who.spec.name;
    let key = (desk, name.clone());
    // Said already, and its box still says it. A box taken away meanwhile
    // -- removed, and put back by Undo -- is said to again.
    let seat = app
        .store
        .clocked(|c, _| widget::seat_of(c, desk, name))
        .ok()
        .flatten();
    if r.said.get(&key).is_some_and(|w| w == why) && seat.is_some() {
        return;
    }
    let asks = why.starts_with("allow: ") || why.starts_with("changed: ");
    if !asks && seat.is_some_and(|s| s.error.starts_with(widget::STOPPED)) {
        return;
    }
    r.said.insert(key, why.to_string());
    if app
        .store
        .clocked(|c, now| {
            widget::fail(c, desk, name, why, who.spec.lines, &file_writer(who), now)
        })
        .is_ok()
    {
        announce(app, desk, name);
    }
}

/// A widget file as its seat's writer: its by-line, its title's tip, for
/// the desk it belongs to.
fn file_writer<'a>(who: &'a Who) -> widget::Writer<'a> {
    widget::Writer {
        source: widget::Source::File,
        writer: who.by,
        pane: "",
        title: &who.spec.title,
        owner: who.owner,
    }
}

/// Once, at start: each widget 1.32 marked as on one desk alone
/// (`widget::OWNER_1_32`) moves into that desk's folder and is its own
/// from now on, allowed as it was -- the hash is of what is in the folder,
/// not where. One that cannot move -- gone, global, its desk closed, the
/// name taken there, the rename refused -- stays shared, as it was, and the
/// log says why.
fn adopt(app: &Arc<App>) {
    let Ok(marked) = app.store.clocked(|c, _| widget::to_adopt(c)) else {
        return;
    };
    let open = app.store.desks().unwrap_or_default();
    let cfg = &app.paths.config_dir;
    for (name, desk) in marked {
        let from = files::folder_of(cfg, 0, &name);
        let to = files::folder_of(cfg, desk, &name);
        let why = match files::read(&from, &name) {
            Err(why) => Some(why),
            Ok(s) if s.scope == files::Scope::Global => Some("it is global".into()),
            Ok(_) if !open.iter().any(|d| d.id == desk) => Some(format!("desk {desk} is closed")),
            Ok(_) if to.exists() => Some(format!("desk {desk} has one of that name")),
            Ok(_) => std::fs::create_dir_all(files::owned_dir(cfg, desk))
                .and_then(|_| std::fs::rename(&from, &to))
                .err()
                .map(|e| e.to_string()),
        };
        let r = app.store.clocked(|c, _| match &why {
            None => widget::adopted(c, &name, desk),
            Some(_) => widget::stays_shared(c, &name, desk),
        });
        match (&why, r) {
            (None, Ok(())) => {
                let desk_name = open
                    .iter()
                    .find(|d| d.id == desk)
                    .map_or("", |d| d.name.as_str());
                eprintln!("snyvi: moved widget {name} to desk {desk} ({desk_name}): it is that desk's own now");
                announce(app, desk, &name);
            }
            (Some(why), _) => eprintln!("snyvi: widget {name} stays shared: {why}"),
            (None, Err(e)) => {
                // The folder moved but the record did not: put it back, so
                // the widget is as it was.
                let _ = std::fs::rename(&to, &from);
                let _ = app
                    .store
                    .clocked(|c, _| widget::stays_shared(c, &name, desk));
                eprintln!("snyvi: widget {name} stays shared: {e}");
            }
        }
    }
}

/// What came of a run.
pub(crate) enum Ran {
    Printed(String),
    Failed(String),
}

/// Run a widget's command once: in `cwd`, with the run's JSON on stdin, its
/// own `folder` first on PATH and in `SNYVI_WIDGET_DIR`, the `keys` it
/// named, and only the reader's PATH, home and language from the daemon's
/// environment -- not the token, not snyvi's own variables, not the rest of
/// a desk's keys (`files::command`, which `snyvi widget check` runs too).
pub(crate) async fn run_once(
    spec: &files::Spec,
    folder: &Path,
    cwd: &Path,
    path: &str,
    stdin: &serde_json::Value,
    keys: &[(String, String)],
) -> Ran {
    let mut cmd = tokio::process::Command::from(files::command(spec, folder, cwd, path, keys));
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Ran::Failed(format!("could not start: {e}")),
    };
    let pid = child.id();
    // Fed inside the timeout, beside the reads: a command that never reads
    // its stdin cannot hold a run's slot by filling the pipe.
    let (input, text) = (child.stdin.take(), stdin.to_string());
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let work = async {
        let feed = async move {
            if let Some(mut i) = input {
                let _ = i.write_all(text.as_bytes()).await;
            }
        };
        let (_, o, e) = tokio::join!(feed, read_cap(out, OUT_MAX + 1), read_drained(err, 1024));
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
            // Past the cap the pipe was closed and the command has ended
            // (`wait` returned): what it started finds the pipe closed too,
            // and a kill on a reaped pid could reach someone else's group.
            if o.len() as u64 > OUT_MAX {
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

/// At most `cap` bytes of stderr, and the rest read and let go: a run
/// that chatters there (node's warnings, git's progress) and prints its
/// body fine is not killed by a closed pipe. The timeout still ends it.
async fn read_drained<R: tokio::io::AsyncRead + Unpin>(p: Option<R>, cap: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut p) = p {
        let _ = AsyncReadExt::take(&mut p, cap).read_to_end(&mut buf).await;
        let _ = tokio::io::copy(&mut p, &mut tokio::io::sink()).await;
    }
    buf
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
/// the last good body. The `FAILS_TO_STOP`th failure in a row for the same
/// reason stops it on this desk, says where it ran, and tells the agent that
/// proposed it.
fn land(app: &Arc<App>, desk: i64, who: &Who, cwd: &Path, fails: &Fails, ran: Ran) {
    let spec = who.spec;
    let key = (desk, spec.name.clone());
    let ran = match ran {
        Ran::Printed(out) => match widget::Body::parse(&out) {
            Err(why) => Ran::Failed(why),
            Ok(_) => Ran::Printed(out),
        },
        failed => failed,
    };
    let ran = match ran {
        Ran::Printed(out) => {
            fails.lock().unwrap().remove(&key);
            Ran::Printed(out)
        }
        Ran::Failed(why) => {
            let n = {
                let mut m = fails.lock().unwrap();
                let e = m.entry(key).or_insert((0, String::new()));
                // In a row for the same reason: the kind of failure, not
                // its words -- a line with a time or a pid in it would
                // never repeat, and the widget would fail forever unstopped.
                // A stopped widget runs again only after Try again: it
                // gets three tries anew, as the button says.
                let kind = fail_kind(&why);
                if e.1 != kind || e.0 >= widget::FAILS_TO_STOP {
                    *e = (0, kind);
                }
                e.0 = e.0.saturating_add(1);
                e.0
            };
            if n >= widget::FAILS_TO_STOP {
                let at = crate::text::tilde(cwd);
                let line = format!("{}after {n} failures, {why} (in {at})", widget::STOPPED);
                let note = format!(
                    "Your widget {} stopped after {n} failures in a row: {why}, run in {at}. \
                     Fix it, and the user's Try again on its box runs it again.",
                    spec.name
                );
                let _ = app.store.clocked(|c, _| {
                    crate::thread::tell_widget(c, who.owner, &spec.name, &note).map(|_| ())
                });
                Ran::Failed(line)
            } else {
                Ran::Failed(why)
            }
        }
    };
    let w = file_writer(who);
    let fail = |why: &str| {
        app.store
            .clocked(|c, now| widget::fail(c, desk, &spec.name, why, spec.lines, &w, now))
            .map(|_| ())
    };
    let wrote = match ran {
        Ran::Failed(why) => fail(&why),
        Ran::Printed(out) => match widget::Body::parse(&out) {
            Err(why) => fail(&why),
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
                let put = app
                    .store
                    .clocked(|c, now| widget::put(c, desk, &spec.name, &b, &html, &w, now));
                // Nowhere to draw it: the desk is full, or a box holds the
                // name. Said in the log; the seat that would say it is the
                // one there is not.
                match put {
                    Ok(widget::Put::Full) => eprintln!(
                        "snyvi: widget {} printed, but desk {desk} has {} widgets already",
                        spec.name,
                        widget::DESK_MAX
                    ),
                    Ok(widget::Put::Box) => eprintln!(
                        "snyvi: widget {} printed, but a box is called that on desk {desk}",
                        spec.name
                    ),
                    _ => {}
                }
                put.map(|_| ())
            }
        },
    };
    if wrote.is_ok() {
        announce(app, desk, &spec.name);
    }
}

/// What kind of failure a reason is, for "three in a row for the same
/// reason": its exit code, a timeout, too much printed, a body refused --
/// without the words after it, which may carry a time or a pid.
fn fail_kind(why: &str) -> String {
    if let Some(rest) = why.strip_prefix("exit ") {
        return format!("exit {}", rest.split(':').next().unwrap_or(""));
    }
    for head in ["took longer than", "printed more than", "could not start"] {
        if why.starts_with(head) {
            return head.to_string();
        }
    }
    why.to_string()
}

/// The reader's PATH as their shell has it, read once: a daemon started
/// by systemd or launchd has almost none, and a shell on every run would be
/// slow. Interactive as well as login, because a version manager -- nvm,
/// pyenv, asdf -- is loaded in `.zshrc` or `.bashrc`, which a login shell
/// alone skips (#112). An interactive shell may print a greeting, so the
/// PATH comes between markers. A login shell when that says nothing, and
/// the daemon's own when neither does.
async fn login_path() -> String {
    let own = std::env::var("PATH").unwrap_or_default();
    if cfg!(windows) {
        return own;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    shell_path(&shell).await.unwrap_or(own)
}

/// The PATH `shell` has, interactive and login, or login alone.
async fn shell_path(shell: &str) -> Option<String> {
    let say = format!("printf '\\n{PATH_MARK}%s{PATH_MARK}\\n' \"$PATH\"");
    for flags in [&["-i", "-l", "-c"][..], &["-l", "-c"][..]] {
        let ask = tokio::process::Command::new(shell)
            .args(flags)
            .arg(&say)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(5), ask).await {
            if let Some(p) = marked_path(&String::from_utf8_lossy(&o.stdout)) {
                return Some(p);
            }
        }
    }
    None
}

/// What a shell's PATH is fenced with, so whatever else it prints is not.
const PATH_MARK: &str = "__snyvi_path__";

/// The PATH between the markers, when it is there and not empty.
fn marked_path(out: &str) -> Option<String> {
    let (_, rest) = out.split_once(PATH_MARK)?;
    let (p, _) = rest.split_once(PATH_MARK)?;
    let p = p.trim();
    (!p.is_empty()).then(|| p.to_string())
}

/// Windows hands `cmd /C` the line whole (`files::command`): a command with
/// a quoted argument -- the starter's own `-File "%SNYVI_WIDGET_DIR%\run.ps1"`
/// -- reaches the shell as written, not re-quoted by std.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[tokio::test]
    async fn a_quoted_argument_reaches_cmd_whole() {
        let dir = std::env::temp_dir().join(format!("snyvi-widget-win-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("run.ps1"), "Write-Output 'from ps1'\n").unwrap();
        let spec = files::Spec {
            name: "t".into(),
            title: "T".into(),
            scope: files::Scope::Global,
            run: files::Run {
                command: "powershell -NoProfile -ExecutionPolicy Bypass -File \"%SNYVI_WIDGET_DIR%\\run.ps1\"".into(),
                every: 5,
                timeout: 20,
            },
            lines: 3,
            settings: Default::default(),
            keys: Vec::new(),
        };
        let path = std::env::var("PATH").unwrap_or_default();
        match run_once(&spec, &dir, &dir, &path, &json!({}), &[]).await {
            Ran::Printed(o) => assert!(o.contains("from ps1"), "{o}"),
            Ran::Failed(w) => panic!("{w}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
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
            keys: Vec::new(),
        }
    }

    async fn run(command: &str, timeout: u64) -> Ran {
        let dir = std::env::temp_dir();
        let path = std::env::var("PATH").unwrap_or_default();
        run_once(
            &spec(command, timeout),
            &dir,
            &dir,
            &path,
            &json!({ "settings": { "x": 1 } }),
            &[],
        )
        .await
    }

    #[tokio::test]
    async fn a_named_key_is_in_its_environment_and_no_other() {
        let dir = std::env::temp_dir();
        let path = std::env::var("PATH").unwrap_or_default();
        let keys = [("OPENROUTER_API_KEY".to_string(), "sk-test".to_string())];
        match run_once(&spec("env", 5), &dir, &dir, &path, &json!({}), &keys).await {
            Ran::Printed(o) => assert!(o.contains("OPENROUTER_API_KEY=sk-test"), "{o}"),
            Ran::Failed(w) => panic!("{w}"),
        }
    }

    #[test]
    fn a_failures_kind_is_its_code_not_its_words() {
        assert_eq!(fail_kind("exit 7: curl: (7) after 2 ms"), "exit 7");
        assert_eq!(fail_kind("exit 7: curl: (7) after 9 ms"), "exit 7");
        assert_eq!(fail_kind("took longer than 5 s and was stopped"), "took longer than");
        assert_eq!(fail_kind("the body is longer than 1500 characters"), "the body is longer than 1500 characters");
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
    async fn a_desk_widget_finds_its_script_by_name_from_the_desk() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("snyvi-widget-reach-{}", std::process::id()));
        let (own, desk) = (base.join("own"), base.join("desk"));
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&desk).unwrap();
        let script = own.join("count.sh");
        std::fs::write(&script, "#!/bin/sh\necho \"in $(basename \"$PWD\")\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::var("PATH").unwrap_or_default();
        match run_once(&spec("count.sh", 5), &own, &desk, &path, &json!({}), &[]).await {
            Ran::Printed(o) => assert_eq!(o.trim(), "in desk"),
            Ran::Failed(w) => panic!("{w}"),
        }
        let _ = std::fs::remove_dir_all(&base);
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
                assert!(o.contains("SNYVI_WIDGET_DIR="));
            }
            Ran::Failed(w) => panic!("{w}"),
        }
    }

    #[test]
    fn the_path_is_read_between_its_markers() {
        let out = format!("Welcome back!\n{PATH_MARK}/a/bin:/usr/bin{PATH_MARK}\nbye");
        assert_eq!(marked_path(&out).as_deref(), Some("/a/bin:/usr/bin"));
        assert_eq!(marked_path("no markers here"), None);
        assert_eq!(marked_path(&format!("{PATH_MARK}{PATH_MARK}")), None);
    }

    #[tokio::test]
    async fn a_shell_rc_reaches_the_path() {
        // What .zshrc or .bashrc adds -- nvm's way -- is on it: the shell
        // here is a script that adds to PATH only when interactive.
        let dir = std::env::temp_dir().join(format!("snyvi-widget-rc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("fakesh");
        std::fs::write(
            &sh,
            "#!/bin/sh\ncase \"$1\" in -i) PATH=/from/rc:$PATH;; esac\n\
             for a; do last=$a; done\necho hello\n/bin/sh -c \"$last\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = shell_path(sh.to_str().unwrap()).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(p.starts_with("/from/rc:"), "{p}");
    }
}
