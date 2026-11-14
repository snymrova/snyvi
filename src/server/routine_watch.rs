//! A routine's watch (1.63, plan d621276291 step 2): the command the reader
//! allowed that stays running and prints a line when something happens --
//! `omdbot watch` printing `tag 5304` when a member tags the bot. Each line
//! in the routine's shape is kept as an event (`routine::events`) and the
//! runner's tick starts a run once a batch has waited (`routine_run::tick`).
//! The watch is what makes a tag answered in a minute rather than at the
//! next hour, and why there is no polling cadence (decision of 10 Nov).
//!
//! What it holds to:
//!
//! - **One child per live routine** with a watch, on an open, unparked
//!   desk, its command file as it was allowed. A routine paused, parked,
//!   removed or changed has its watch stopped at the next look.
//! - **Its own process group**, killed whole; a pidfile beside the run's
//!   settings, so a daemon that was killed (not stopped) has its leftover
//!   ended at the next start (R14).
//! - **Lines are data.** `#` lines are heartbeats; any other goes through
//!   the shape, and one out of it is dropped and counted.
//! - **It backs off and gives up out loud**: 5 s, 30 s, 2 min, 5 min after
//!   an exit, and five exits in ten minutes stop it with one On you card.
//!   A machine that woke from sleep has every watch started again.

use super::*;
use crate::routine::{self, Routine};
use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::io::AsyncBufReadExt;

/// How often the watches are looked at.
const LOOK: Duration = Duration::from_secs(5);
/// The backoff after each exit in the window, in seconds.
const BACKOFF: [i64; 4] = [5, 30, 120, 300];
/// Exits within `GIVE_UP_S` that stop a watch.
const GIVE_UP: usize = 5;
const GIVE_UP_S: i64 = 600;
/// How often a running watch's command file is checked against what was
/// allowed: a changed script stops it.
const CHECK_S: i64 = 30;

/// A watch as the row and the sheet read it.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub(crate) struct Live {
    pub watching: bool,
    /// The last line or heartbeat it printed.
    pub heard_at: i64,
    /// Its last line of stderr, or why it stopped.
    pub said: String,
    /// Stopped for good until the reader saves, resumes or starts it again.
    pub stopped: bool,
    #[serde(skip)]
    exits: VecDeque<i64>,
    #[serde(skip)]
    wait_until: i64,
    #[serde(skip)]
    pid: Option<u32>,
    /// What it was started as: its line and its routine's hash.
    #[serde(skip)]
    as_: String,
    #[serde(skip)]
    checked_at: i64,
    /// Its file read as changed at the last check: not started again until
    /// a check finds it as allowed. Between checks it would otherwise come
    /// back on the next tick, running what the reader has not seen.
    #[serde(skip)]
    changed: bool,
    #[serde(skip)]
    task: Option<tokio::task::AbortHandle>,
}

static LIVE: LazyLock<Mutex<HashMap<i64, Live>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A routine's watch, as the row says it; `None` with none.
pub(crate) fn live(id: i64) -> Option<Live> {
    LIVE.lock().ok()?.get(&id).cloned()
}

/// The reader saved, resumed or started it: a stopped watch may try again.
pub(crate) fn forgive(id: i64) {
    if let Ok(mut m) = LIVE.lock() {
        if let Some(l) = m.get_mut(&id) {
            l.stopped = false;
            l.exits.clear();
            l.wait_until = 0;
            l.said.clear();
            // Its file is read again at the next look, not half a minute on.
            l.checked_at = 0;
        }
    }
}

fn pidfile(app: &App, id: i64) -> std::path::PathBuf {
    app.paths
        .data_dir
        .join("routines")
        .join(id.to_string())
        .join("watch.pid")
}

/// The supervisor, from the daemon's start: leftovers ended first.
pub(crate) fn spawn(app: Arc<App>) {
    end_leftovers(&app);
    tokio::spawn(async move {
        loop {
            look(&app).await;
            tokio::time::sleep(LOOK).await;
        }
    });
}

/// The daemon is going: every watch and what it started.
pub(crate) fn stop_all() {
    let Ok(mut m) = LIVE.lock() else { return };
    for l in m.values_mut() {
        stop(l);
    }
}

/// The machine woke: every watch starts again, since a socket held across a
/// sleep is often dead and says nothing.
pub(crate) fn woke() {
    let Ok(mut m) = LIVE.lock() else { return };
    for l in m.values_mut() {
        stop(l);
        l.wait_until = 0;
    }
}

fn stop(l: &mut Live) {
    super::widget_run::stop_group(l.pid.take());
    if let Some(t) = l.task.take() {
        t.abort();
    }
    l.watching = false;
}

/// A killed daemon's watches: each pidfile's group is ended when its
/// process still runs the line it was started with.
fn end_leftovers(app: &App) {
    let Ok(rd) = std::fs::read_dir(app.paths.data_dir.join("routines")) else {
        return;
    };
    for e in rd.flatten() {
        let f = e.path().join("watch.pid");
        let Ok(text) = std::fs::read_to_string(&f) else {
            continue;
        };
        let _ = std::fs::remove_file(&f);
        let (pid, line) = text.split_once('\n').unwrap_or((&text, ""));
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        if still_runs(pid, line.trim()) {
            eprintln!("snyvi: ended a routine's watch left by the last daemon (pid {pid})");
            super::widget_run::stop_group(Some(pid));
        }
    }
}

/// Whether `pid` is still the watch's `sh -c <line>`: its command line
/// names the line, so a pid reused by someone else is never ended.
fn still_runs(pid: u32, line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        // Its words are NUL-separated; `sh` may have exec'd the line's
        // command in its own place, so the words are matched, not `sh -c`.
        std::fs::read(format!("/proc/{pid}/cmdline"))
            .map(|b| {
                String::from_utf8_lossy(&b)
                    .replace('\0', " ")
                    .contains(line)
            })
            .unwrap_or(false)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(line))
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        let _ = pid;
        false
    }
}

/// The routines whose watch should be running now, with their desks.
async fn wanted(app: &App) -> Vec<(Routine, crate::desk::Desk)> {
    let Ok(all) = app.store.clocked(|c, _| {
        let mut st = c.prepare_cached(
            "SELECT DISTINCT desk_id FROM routines WHERE removed_at = 0 AND watch != ''",
        )?;
        let desks: Vec<i64> = st
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut v = Vec::new();
        for d in desks {
            v.extend(routine::for_desk(c, d)?);
        }
        Ok(v)
    }) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in all {
        if r.watch.trim().is_empty() || r.state() != "live" {
            continue;
        }
        let Ok(Some(desk)) = app.store.desk(r.desk_id) else {
            continue;
        };
        if desk.parked.is_some() {
            continue;
        }
        out.push((r, desk));
    }
    out
}

/// What a watch is started as: a change to either stops and starts it.
fn as_of(r: &Routine) -> String {
    format!("{}\n{}\n{}", r.watch, r.cmd_hash, r.shape)
}

async fn look(app: &Arc<App>) {
    let want = wanted(app).await;
    let now = crate::store::now();
    let ids: Vec<i64> = want.iter().map(|(r, _)| r.id).collect();
    // Gone from what is wanted: stopped, and forgotten when not stopped
    // for good, so a routine started again begins afresh.
    if let Ok(mut m) = LIVE.lock() {
        m.retain(|id, l| {
            if ids.contains(id) {
                return true;
            }
            stop(l);
            let _ = std::fs::remove_file(pidfile(app, *id));
            false
        });
    }
    for (r, desk) in want {
        // Its file as allowed, checked every half a minute: a changed
        // script stops the watch until the reader allows it again.
        //
        // 1.66: only what it may run stops it (`routine::file_state`); its
        // words reworded run on, said in News (`routine_run::file_now`). A
        // stop is loud: the routine goes to Waiting once, the rail redraws,
        // and its lines wait as events for the reader's Allow. It stopped
        // with only "changed · Allow" in memory before, and the row read
        // as done (bug 0f204f3135).
        let check = live(r.id).is_none_or(|l| now - l.checked_at >= CHECK_S);
        if check && !r.words() {
            let root = std::path::PathBuf::from(&desk.root);
            let state = super::routine_run::file_now(app, &r, &root).await;
            let blocked = !matches!(state, "ok" | "words");
            let why = match state {
                "gone" => format!("/{} is gone: no command or skill by that name", r.cmd),
                "two" => format!("two /{}: rename one", r.cmd),
                _ => "changed · Allow".to_string(),
            };
            let newly = {
                let mut m = LIVE.lock().unwrap();
                let l = m.entry(r.id).or_default();
                l.checked_at = now;
                let was = l.changed;
                l.changed = blocked;
                if blocked {
                    if l.watching {
                        super::routine_run::log(&format!(
                            "watch of routine {} ({}) stopped: {why}",
                            r.id, r.name
                        ));
                    }
                    stop(l);
                    l.said = why.clone();
                } else if was {
                    l.said.clear();
                }
                blocked && !was
            };
            if blocked {
                if newly {
                    super::routine_run::changed(app, r.desk_id);
                }
                super::routine_run::stuck(app, &r, &why);
                continue;
            }
        }
        let start = {
            let mut m = LIVE.lock().unwrap();
            let l = m.entry(r.id).or_default();
            if l.watching && l.as_ != as_of(&r) {
                stop(l);
            }
            !l.watching && !l.stopped && !l.changed && now >= l.wait_until
        };
        if start {
            begin(app, &r, &desk).await;
        }
    }
}

/// Start one watch.
async fn begin(app: &Arc<App>, r: &Routine, desk: &crate::desk::Desk) {
    let g = super::routine_gate::ground(app, r, desk).await;
    let last = app
        .store
        .clocked(|c, _| routine::events::last(c, r.id))
        .unwrap_or_default();
    let extra = [
        ("SNYVI_ROUTINE", r.name.clone()),
        ("SNYVI_LAST_EVENT", last),
    ];
    let mut cmd = super::routine_gate::command(&r.watch, &g, &extra);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            exited(app, r, &format!("could not start: {e}"));
            return;
        }
    };
    let pid = child.id();
    super::routine_run::log(&format!(
        "watch of routine {} ({}) started: {}",
        r.id, r.name, r.watch
    ));
    if let Some(pid) = pid {
        let f = pidfile(app, r.id);
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&f, format!("{pid}\n{}", r.watch));
    }
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let (app2, r2) = (app.clone(), r.clone());
    let task = tokio::spawn(async move {
        let errs = async {
            let mut last = String::new();
            if let Some(e) = err {
                let mut lines = tokio::io::BufReader::new(e).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if !l.trim().is_empty() {
                        last = crate::thread::line(l.trim(), 120);
                    }
                }
            }
            last
        };
        let outs = async {
            if let Some(o) = out {
                let mut lines = tokio::io::BufReader::new(o).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    heard(&app2, &r2, &l);
                }
            }
        };
        let (last, _) = tokio::join!(errs, outs);
        let status = child.wait().await;
        let why = match status {
            Ok(s) => match (s.code(), last.is_empty()) {
                (Some(c), true) => format!("exit {c}"),
                (Some(c), false) => format!("exit {c}: {last}"),
                (None, _) => "stopped by a signal".into(),
            },
            Err(e) => format!("could not wait for it: {e}"),
        };
        exited(&app2, &r2, &why);
    });
    if let Ok(mut m) = LIVE.lock() {
        let l = m.entry(r.id).or_default();
        l.watching = true;
        l.pid = pid;
        l.as_ = as_of(r);
        l.task = Some(task.abort_handle());
    }
    super::routine_run::changed(app, r.desk_id);
}

/// A line the watch printed.
fn heard(app: &App, r: &Routine, line: &str) {
    let now = crate::store::now();
    if let Ok(mut m) = LIVE.lock() {
        if let Some(l) = m.get_mut(&r.id) {
            l.heard_at = now;
        }
    }
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return;
    }
    let _ = app
        .store
        .clocked(|c, now| routine::events::push(c, r.id, &r.shape, line, now));
}

/// The backoff after `n` exits in the window.
fn backoff(n: usize) -> i64 {
    BACKOFF[n.saturating_sub(1).min(BACKOFF.len() - 1)]
}

/// The watch ended on its own: backed off, or stopped for good with one card.
fn exited(app: &App, r: &Routine, why: &str) {
    let now = crate::store::now();
    super::routine_run::log(&format!(
        "watch of routine {} ({}) exited: {why}",
        r.id, r.name
    ));
    let _ = std::fs::remove_file(pidfile(app, r.id));
    let gave_up = {
        let Ok(mut m) = LIVE.lock() else { return };
        let l = m.entry(r.id).or_default();
        l.watching = false;
        l.pid = None;
        l.task = None;
        l.said = why.to_string();
        l.exits.push_back(now);
        while l.exits.front().is_some_and(|t| now - t > GIVE_UP_S) {
            l.exits.pop_front();
        }
        l.wait_until = now + backoff(l.exits.len());
        let gave_up = l.exits.len() >= GIVE_UP && !l.stopped;
        if gave_up {
            l.stopped = true;
        }
        gave_up
    };
    if gave_up {
        // 1.66: a Waiting row of the routine's own, not a card on no panel.
        super::routine_run::stuck(
            app,
            r,
            &format!("its watch stopped after {GIVE_UP} exits in ten minutes: {why}"),
        );
    }
    super::routine_run::changed(app, r.desk_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_watch_backs_off_and_gives_up() {
        assert_eq!(backoff(1), 5);
        assert_eq!(backoff(2), 30);
        assert_eq!(backoff(3), 120);
        assert_eq!(backoff(4), 300);
        assert_eq!(backoff(9), 300);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_leftover_is_ended_only_when_it_still_runs_its_line() {
        let mut c = std::process::Command::new("sh")
            .args(["-c", "sleep 30; : zz-snyvi-watch"])
            .spawn()
            .unwrap();
        let pid = c.id();
        // Until its exec, the child is still this test.
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while !still_runs(pid, "zz-snyvi-watch") && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(still_runs(pid, "zz-snyvi-watch"));
        assert!(!still_runs(pid, "someone else's"));
        assert!(!still_runs(pid, ""));
        let _ = c.kill();
        let _ = c.wait();
    }
}
