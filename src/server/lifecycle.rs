//! The daemon's own life: health and about, restart and the planned exit a
//! restart is, the update watcher, the relaunch of the successor, and reset.

use super::*;

/// A restart that has been asked for. It is carried out the moment the panes
/// are quiet -- no agent mid-turn, nothing printing -- or at once when `now`.
#[derive(Clone, Copy, Debug)]
pub struct Pending {
    pub since: Instant,
    /// Take the staged update on the way (the updater's, later). Recorded
    /// with the exit either way, so the daemon that comes up can tell a
    /// restart that applied something from one that did not.
    pub apply: bool,
    /// Put the previous version back first (`snyvi update --back`).
    pub back: bool,
    pub now: bool,
}

/// Why `run` returned: asked to stop, or asked to restart -- in which case
/// the caller relaunches, by the recorded path, and how depends on whether
/// systemd is the one to do it.
#[derive(Clone, Debug)]
pub enum Leaving {
    Stopped,
    Restart { exe: Option<PathBuf>, apply: bool },
}

/// Whether systemd started this process as the `snyvi` user unit and will
/// bring it back after a non-zero exit. `INVOCATION_ID` is set by systemd for
/// every unit it runs; the unit being active is what says it is ours and not
/// a service snyvi happens to run under.
pub(crate) fn under_systemd() -> bool {
    if std::env::var_os("INVOCATION_ID").is_none() {
        return false;
    }
    std::process::Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "snyvi"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The exit code of a planned restart under systemd. 75 (`EX_TEMPFAIL`) is
/// not success, so `Restart=on-failure` in `packaging/snyvi.service` starts
/// the unit again from the file now at `ExecStart`; and it is a code nothing
/// else here exits with, so a log can tell a planned restart from a crash.
pub const PLANNED_RESTART_EXIT: i32 = 75;

/// The file a planned exit leaves for the next daemon, beside the store:
/// `{ "apply": bool, "from": "<version>", "at": <epoch> }`. Its presence is
/// what tells a planned start from a crash-restart; `apply` is for the
/// updater, which must not count a plain restart as a day's update.
pub(crate) const RESTART_MARKER: &str = "restart.json";

/// What a planned exit does before the listener goes: the panes an agent was
/// in are marked to come back as `claude --resume`, the marker is written,
/// and the reason is recorded for `run` to return. The shutdown itself is
/// the ordinary one -- every stream told, every pane hung up on -- so a
/// restart costs exactly what a stop does, and the window's reconnect is
/// what brings the panes back.
pub(crate) fn leave_for_restart(app: &App, apply: bool, back: bool) -> bool {
    // On its way out from the moment the pending restart is taken: the
    // apply can take a while, and `snyvi restart` reads "nothing pending and
    // not restarting" as given up. Given up it is, if this returns false.
    app.restarting.store(true, Ordering::Relaxed);
    let left = leave(app, apply, back);
    if !left {
        app.restarting.store(false, Ordering::Relaxed);
        emit_update(app);
    }
    left
}

pub(crate) fn leave(app: &App, apply: bool, back: bool) -> bool {
    if apply || back {
        let Some(u) = &app.update else {
            eprintln!("snyvi: no updater on this daemon; not restarting");
            return false;
        };
        if back {
            match u.rollback(true) {
                Ok(true) => {
                    eprintln!("snyvi: the previous version is back in place; restarting onto it")
                }
                Ok(false) => {
                    eprintln!("snyvi: there is no previous version to go back to");
                    return false;
                }
                Err(e) => {
                    eprintln!("snyvi: could not put the previous version back: {e:#}");
                    u.fail(format!("{e:#}"));
                    emit_update(app);
                    return false;
                }
            }
        } else {
            match u.apply() {
                Ok(v) => eprintln!("snyvi: {v} is in place; restarting onto it"),
                Err(e) => {
                    // Not tried again every five seconds: what was staged
                    // goes, the next check stages afresh, and About says why.
                    eprintln!("snyvi: could not apply the update: {e:#}");
                    u.fail(format!("{e:#}"));
                    u.drop_staged();
                    emit_update(app);
                    return false;
                }
            }
        }
    }
    app.restarting.store(true, Ordering::Relaxed);
    emit_update(app);
    // The panes an agent is in, and the marks this daemon was given and
    // nobody has spent yet -- an update applied while nobody was here must
    // not lose the last one's.
    let (mut resume, offer) = app.panes.unspent();
    resume.extend(app.panes.with_agent());
    match app.store.mark_panes_resume(&resume) {
        Ok(n) if n > 0 => {
            eprintln!("snyvi: restarting; {n} panel(s) will resume their conversation")
        }
        Ok(_) => eprintln!("snyvi: restarting"),
        Err(e) => eprintln!("snyvi: restarting; could not mark panels to resume: {e}"),
    }
    let _ = app.store.offer_panes_resume(&offer);
    let marker = json!({ "apply": apply, "from": VERSION, "at": crate::store::now() });
    let _ = std::fs::write(app.paths.data_dir.join(RESTART_MARKER), marker.to_string());
    *app.leaving.lock().unwrap() = Leaving::Restart {
        exe: app.exe.as_ref().map(|e| e.path.clone()),
        apply,
    };
    let _ = app.shutdown.send(());
    true
}

/// How old a marker may be and still describe this start. A planned exit
/// is followed by a start within seconds -- two under systemd, a few more
/// for a successor that crashed and was started again -- so a marker older
/// than this was left by an exit whose start never came.
pub(crate) const RESTART_MARKER_FOR: i64 = 10 * 60;

/// A planned restart's marker, if the last exit left one and it is recent.
/// `Some(apply)` when the last exit was planned. Read here and taken only
/// once this daemon holds the port (`drop_restart_marker`): a successor
/// that dies before then is started again, and must find it again.
pub(crate) fn read_restart_marker(paths: &Paths) -> Option<bool> {
    let text = std::fs::read_to_string(paths.data_dir.join(RESTART_MARKER)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let at = v["at"].as_i64()?;
    if (crate::store::now() - at).abs() > RESTART_MARKER_FOR {
        return None;
    }
    Some(v["apply"].as_bool().unwrap_or(false))
}

pub(crate) fn drop_restart_marker(paths: &Paths) {
    let _ = std::fs::remove_file(paths.data_dir.join(RESTART_MARKER));
}

/// The pending restart as the pill and About see it: `restart_json`
/// without its clock, so the block only changes when what it says does.
pub(crate) fn pending_json(app: &App) -> serde_json::Value {
    let pending = *app.restart.lock().unwrap();
    match pending {
        Some(p) => {
            let busy = if p.now { vec![] } else { app.panes.busy() };
            json!({
                "apply": p.apply,
                "back": p.back,
                "now": p.now,
                "waiting": waiting_named(app, &busy),
                "waiting_on": busy,
            })
        }
        None => serde_json::Value::Null,
    }
}

/// Who a restart is waiting for, by the names the reader knows them by:
/// "ledger · panel 1 · Claude working", and since when. `waiting_on` stays
/// the bare ids, which the CLI and the benches read.
pub(crate) fn waiting_named(app: &App, ids: &[String]) -> Vec<serde_json::Value> {
    ids.iter()
        .map(|id| {
            let st = app.panes.status(id);
            let placed = app.store.pane(id).ok().flatten();
            json!({
                "pane": id,
                "desk": placed.as_ref().map(|p| p.desk_name.clone()),
                "desk_id": placed.as_ref().map(|p| p.desk_id),
                "slot": placed.as_ref().map(|p| p.pane.slot),
                "agent": st.agent,
                "since": st.agent_since.or(st.since),
            })
        })
        .collect()
}

/// The pending restart, as health and `snyvi restart` see it.
pub(crate) fn restart_json(app: &App) -> serde_json::Value {
    match *app.restart.lock().unwrap() {
        Some(p) => json!({
            "pending": true,
            "apply": p.apply,
            "back": p.back,
            "since_s": p.since.elapsed().as_secs(),
            "waiting_on": if p.now { vec![] } else { app.panes.busy() },
        }),
        None => serde_json::Value::Null,
    }
}

/// Carries out a pending restart once the panes are quiet. Looked at when
/// something changes -- a restart asked for, an agent's state, a pane's
/// process -- and every five seconds regardless, since "quiet" is partly a
/// clock: a pane stops being busy ninety seconds after its last output with
/// nothing to say so.
pub(crate) fn spawn_restart_watcher(app: Arc<App>) {
    tokio::spawn(async move {
        let mut changes = app.events.subscribe();
        loop {
            tokio::select! {
                _ = app.restart_wake.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
                m = changes.recv() => {
                    // Only a pane's word matters here; everything else on
                    // the stream is documents.
                    if !matches!(&m, Ok(s) if s.starts_with("panes\n")) { continue }
                }
            }
            // The block moves with the clock too -- the day's slot opening,
            // amber at a day, a failure ageing out -- and with the panels a
            // pending restart waits on; nothing else would say so.
            emit_update_if_changed(&app);
            let pending = *app.restart.lock().unwrap();
            match pending {
                Some(p) => {
                    if !p.now && !app.panes.busy().is_empty() {
                        continue;
                    }
                    // A check is downloading or an apply is swapping: wait
                    // it out rather than block this task on the lock.
                    if (p.apply || p.back) && app.update.as_ref().is_some_and(|u| u.busy()) {
                        continue;
                    }
                    app.restart.lock().unwrap().take();
                    if leave_for_restart(&app, p.apply, p.back) {
                        return;
                    }
                }
                None => {
                    // The automatic path: a version staged, the day's slot
                    // open, and one of the doors -- nobody here, or a window
                    // left in the background -- open too. See `update::door`.
                    let Some(u) = &app.update else { continue };
                    let now = crate::store::now();
                    if let Some(why) = u.should_apply(now, &doors(&app)) {
                        let v = u.state().ready.unwrap_or_default();
                        eprintln!("snyvi: applying {v} now, since {}", why.say());
                        if leave_for_restart(&app, true, false) {
                            return;
                        }
                    }
                }
            }
        }
    });
}

/// Who is here, for the updater's doors: windows, pages that are not
/// agents, how long since a page said it was in front, and whether a pane
/// is busy.
pub(crate) fn doors(app: &App) -> crate::update::Doors {
    let agents: usize = app
        .online
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .sum();
    let streams = app.streams.load(Ordering::Relaxed);
    crate::update::Doors {
        windows: app.windows.load(Ordering::Relaxed),
        pages: streams.saturating_sub(agents),
        focus_age: app.last_focus.lock().unwrap().elapsed(),
        busy: !app.panes.busy().is_empty(),
    }
}

/// Reads the manifest on a timer: shortly after the start, then every six
/// hours or so. A failure is a line in the log and a field in About, never
/// a pill. `SNYVI_UPDATE_EVERY_S` shortens the timer for the bench.
pub(crate) fn spawn_update_checker(app: Arc<App>) {
    use crate::update::{jitter_d, CHECK_EVERY, CHECK_JITTER, FIRST_CHECK, FIRST_CHECK_JITTER};
    let Some(u) = app.update.clone() else { return };
    if u.channel == crate::update::Channel::Dev {
        return;
    }
    let every = std::env::var("SNYVI_UPDATE_EVERY_S")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(std::time::Duration::from_secs);
    tokio::spawn(async move {
        let mut wait = match every {
            Some(e) => e,
            None => FIRST_CHECK + jitter_d(FIRST_CHECK_JITTER),
        };
        loop {
            tokio::time::sleep(wait).await;
            wait = match every {
                Some(e) => e,
                None => CHECK_EVERY - CHECK_JITTER + jitter_d(CHECK_JITTER * 2),
            };
            if !u.auto() {
                continue;
            }
            let checker = u.clone();
            let before = checker.state().ready;
            let r =
                tokio::task::spawn_blocking(move || checker.check(crate::update::Ask::TIMER, None))
                    .await;
            match r {
                Ok(Ok(c)) if c.ready.is_some() && c.ready != before => {
                    eprintln!(
                        "snyvi: {} is staged, verified, and applies at a quiet moment",
                        c.ready.as_deref().unwrap_or("?")
                    )
                }
                Ok(Ok(c)) if c.newer() && c.told => eprintln!(
                    "snyvi: {} is out; this install is updated by hand",
                    c.latest
                ),
                Ok(Ok(_)) => {}
                Ok(Err(e)) => eprintln!("snyvi: update check: {e:#}"),
                Err(_) => {}
            }
            emit_update(&app);
            app.restart_wake.notify_one();
        }
    });
}

/// The `update` block of health and About, and the `update` event's body:
/// the updater's word, the restart waiting for quiet if one is, and whether
/// this daemon is on its way out.
pub(crate) fn update_json(app: &App) -> serde_json::Value {
    let stale = app.exe.as_ref().is_some_and(Exe::stale);
    let mut j = match &app.update {
        Some(u) => u.json(crate::store::now(), stale),
        None => json!({ "channel": "unknown", "auto": false, "show": stale, "stale": stale }),
    };
    j["restart"] = pending_json(app);
    j["restarting"] = json!(app.restarting.load(Ordering::Relaxed));
    j
}

pub(crate) fn emit_update(app: &App) {
    let j = update_json(app);
    *app.update_sent.lock().unwrap_or_else(|e| e.into_inner()) = j.to_string();
    emit(app, "update", j);
}

/// `emit_update`, only when the block differs from the one last sent.
pub(crate) fn emit_update_if_changed(app: &App) {
    let j = update_json(app);
    let text = j.to_string();
    {
        let mut sent = app.update_sent.lock().unwrap_or_else(|e| e.into_inner());
        if *sent == text {
            return;
        }
        *sent = text;
    }
    emit(app, "update", j);
}

/// After `run` has returned `Leaving::Restart`: the successor, by the path
/// recorded at start. Under systemd the unit does it -- this process exits
/// with `PLANNED_RESTART_EXIT` and `Restart=on-failure` brings the new file
/// up inside the unit, where `update::first_start` takes a bad one back out.
/// Otherwise the successor is spawned detached, with its output in
/// `daemon.log`, and watched for up to `CAME_UP_WITHIN`: when nothing at all
/// answers after an apply, the previous version is put back and started.
/// Something else answering -- an older snyvi from another path holding the
/// port -- is not the successor, and not a reason to take the update back
/// out either. Never returns.
pub fn relaunch(exe: Option<PathBuf>, apply: bool, paths: &Paths) -> ! {
    if under_systemd() {
        eprintln!("snyvi: planned restart under systemd; exiting {PLANNED_RESTART_EXIT} for the unit to start the new file");
        std::process::exit(PLANNED_RESTART_EXIT);
    }
    let Some(exe) = exe.or_else(|| std::env::current_exe().ok()) else {
        eprintln!("snyvi: cannot restart: the path of this executable is unknown");
        std::process::exit(1);
    };
    let me = std::process::id();
    if let Err(e) = platform::spawn_daemon(&exe) {
        eprintln!(
            "snyvi: cannot restart: starting {} failed: {e}",
            exe.display()
        );
        std::process::exit(1);
    }
    match came_up(me, &exe) {
        CameUp::Ours(v) => {
            eprintln!(
                "snyvi: {v} is up on {}; this one is done",
                config::base_url()
            );
            std::process::exit(0);
        }
        CameUp::Other(what) => {
            eprintln!(
                "snyvi: something else answered on {} after the restart ({what}), not {}; stop it and run `snyvi restart`",
                config::base_url(),
                exe.display()
            );
            std::process::exit(1);
        }
        CameUp::Nothing => {}
    }
    eprintln!(
        "snyvi: {} did not answer within {} s of a planned restart; see {}",
        exe.display(),
        CAME_UP_WITHIN.as_secs(),
        platform::daemon_log(&paths.data_dir).display()
    );
    if apply {
        // The file just placed does not run. The one that did is beside it
        // as `.prev`: put it back, start it, and let it say `failed`.
        let u = crate::update::Updater::new(paths, &exe, Box::new(crate::update::Http));
        match u.rollback(false) {
            Ok(true) => eprintln!("snyvi: put the previous version back"),
            Ok(false) => eprintln!("snyvi: nothing to put back"),
            Err(e) => eprintln!("snyvi: could not put the previous version back: {e:#}"),
        }
        if let Err(e) = platform::spawn_daemon(&exe) {
            eprintln!("snyvi: starting {} again failed: {e}", exe.display());
            std::process::exit(1);
        }
        if let CameUp::Ours(v) = came_up(me, &exe) {
            eprintln!("snyvi: {v} is back up on {}", config::base_url());
            std::process::exit(0);
        }
        eprintln!(
            "snyvi: {} did not answer after the rollback either",
            exe.display()
        );
    }
    std::process::exit(1);
}

/// How long a successor has to answer. A daemon still migrating its store
/// is not a failed one, and a rollback under it would be.
pub(crate) const CAME_UP_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) enum CameUp {
    /// Our successor: another process, from the recorded path. Its version.
    Ours(String),
    /// Another process answered, from another file.
    Other(String),
    Nothing,
}

/// Who answered health, within `CAME_UP_WITHIN`: a process other than `me`
/// and from `exe` is the successor. A daemon from before health said its
/// file (1.7.0 and older, what `--to` may go down to) is taken on its pid.
pub(crate) fn came_up(me: u32, exe: &std::path::Path) -> CameUp {
    let deadline = Instant::now() + CAME_UP_WITHIN;
    let mut wait = std::time::Duration::from_millis(20);
    let mut other = None;
    while Instant::now() < deadline {
        if let Some(h) = crate::client::health() {
            let version = h["version"].as_str().unwrap_or("?").to_string();
            if h["pid"].as_u64() != Some(u64::from(me)) {
                match h["exe"].as_str() {
                    Some(e) if std::path::Path::new(e) != exe => {
                        // Maybe the old one is still letting go of the port
                        // and this is a third party that just took it; keep
                        // looking until the deadline, and say so then.
                        other = Some(format!("snyvi {version} from {e}"));
                    }
                    _ => return CameUp::Ours(version),
                }
            }
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(std::time::Duration::from_millis(250));
    }
    match other {
        Some(what) => CameUp::Other(what),
        None => CameUp::Nothing,
    }
}

pub(crate) async fn health(State(app): S) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "version": VERSION,
        "commit": BUILD_SHA,
        // So `snyvi stop` can end this exact process if it ignores the
        // shutdown endpoint, without having to guess which snyvi it is.
        "pid": std::process::id(),
        // The file it runs from, so a restart can tell its successor from
        // another snyvi that happens to hold the port.
        "exe": app.exe.as_ref().map(|e| e.path.display().to_string()),
        "docs": app.store.count().unwrap_or(0),
        // Whether a link should be handed to a window or opened in a browser.
        // `snyvi open`, `snyvi browse` and the MCP server all ask here.
        "window": app.has_window(),
        "streams": app.streams.load(Ordering::Relaxed),
        // How many pane processes are running, so `snyvi bench` and a person
        // with curl can see what a desk is costing without a window open.
        "panes": app.panes.running(),
        // Which agents hold a stream right now, by the name each gave.
        "agents": app.online(),
        // The bundle this daemon serves, so a page that reconnects after an
        // upgrade can tell it is running another one's and reload.
        "v": app.asset_v(),
        "languages": app.renderer.languages().len(),
        "uptime_s": app.started.elapsed().as_secs(),
        // When this process started, so a restart can be seen to have
        // happened even when the version did not change.
        "started": app.started_at,
        // The file this daemon runs from has been replaced since it started:
        // an upgrade by a package manager, a copy by hand, the updater. A
        // restart would pick the new one up.
        "stale": app.exe.as_ref().is_some_and(Exe::stale),
        // A restart asked for and waiting for the panes to be quiet, with
        // the panes it is waiting on; null when none is.
        "restart": restart_json(&app),
        // What is out, what is staged, and when it may go. See `crate::update`.
        "update": update_json(&app),
    }))
}

/// The about panel: what this is, which build is answering, where its
/// files are, and what Claude Code has of it. The version comes from here
/// and not from the page's bundle, so the panel cannot name a number
/// `snyvi --version` would not.
pub(crate) async fn about(State(app): S) -> Json<serde_json::Value> {
    // The path recorded at start, not `current_exe()` now: after the file
    // has been replaced under this process the latter says `(deleted)`.
    let exe = app.exe.as_ref().map(|e| e.path.clone());
    Json(json!({
        "name": "snyvi",
        "description": env!("CARGO_PKG_DESCRIPTION"),
        "version": VERSION,
        "commit": BUILD_SHA,
        "target": BUILD_TARGET,
        "binary": exe.as_deref().map(|p| p.display().to_string()),
        "stale": app.exe.as_ref().is_some_and(Exe::stale),
        "data_dir": app.paths.data_dir.display().to_string(),
        "config_dir": app.paths.config_dir.display().to_string(),
        "agents": std::iter::once(crate::setup::claude_code_status())
            .chain(crate::agents::status_lines())
            .collect::<Vec<_>>()
            .join("\n"),
        "license": env!("CARGO_PKG_LICENSE"),
        "repository": env!("CARGO_PKG_REPOSITORY"),
        "docs": app.store.count().unwrap_or(0),
        "uptime_s": app.started.elapsed().as_secs(),
        "update": update_json(&app),
    }))
}

/// Ask the daemon to exit, so a new binary can take over the port.
pub(crate) async fn shutdown(State(app): S, headers: HeaderMap) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let _ = app.shutdown.send(());
    Json(json!({ "ok": true, "version": VERSION })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct RestartBody {
    /// `idle` (the default) waits until no pane is busy; `now` does not.
    #[serde(default)]
    pub(crate) when: Option<String>,
    /// Take the staged update on the way: the files are swapped at the
    /// planned exit and the successor is the new version.
    #[serde(default)]
    pub(crate) apply: bool,
    /// Put the previous version back on the way instead.
    #[serde(default)]
    pub(crate) back: bool,
}

/// Ask the daemon to restart itself: at once, or as soon as no pane has an
/// agent mid-turn or a program printing. The panes an agent was in come
/// back as `claude --resume`; the rest as shells with their old screen
/// greyed above, which is what any restart already does. Answers to the
/// window secret (`snyvi restart`) or the window's capability (a click on
/// the update pill); a tab holds neither, and nor does an agent's token.
/// Asking again adds to the restart
/// already pending rather than queueing another: `snyvi restart` while the
/// pill's update waits still takes the update, and `--now` hurries both.
pub(crate) async fn restart(State(app): S, headers: HeaderMap, Json(b): Json<RestartBody>) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let now = match b.when.as_deref().unwrap_or("idle") {
        "idle" => false,
        "now" => true,
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("when must be idle or now, not {other:?}") })),
            )
                .into_response()
        }
    };
    if b.apply && app.update.as_ref().is_none_or(|u| u.staged().is_none()) {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": "nothing is staged to apply; `snyvi update` checks and stages" }),
            ),
        )
            .into_response();
    }
    if b.back && !app.update.as_ref().is_some_and(|u| u.can_go_back()) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "there is no previous version beside this one to go back to" })),
        )
            .into_response();
    }
    let now = {
        let mut slot = app.restart.lock().unwrap();
        let was = *slot;
        let p = Pending {
            since: was.map(|p| p.since).unwrap_or_else(Instant::now),
            apply: b.apply || was.is_some_and(|p| p.apply),
            back: b.back || was.is_some_and(|p| p.back),
            now: now || was.is_some_and(|p| p.now),
        };
        *slot = Some(p);
        p.now
    };
    let waiting_on = if now { vec![] } else { app.panes.busy() };
    let waiting = waiting_named(&app, &waiting_on);
    app.restart_wake.notify_one();
    emit_update(&app);
    Json(json!({ "ok": true, "waiting_on": waiting_on, "waiting": waiting, "version": VERSION }))
        .into_response()
}

/// Call off a restart that is waiting for quiet: `snyvi restart --cancel`,
/// Ctrl-C under `snyvi restart`, and the pill's Cancel. The same who as
/// asking. One already under way is past calling off, and says so.
pub(crate) async fn cancel_restart(State(app): S, headers: HeaderMap) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let cancelled = app.restart.lock().unwrap().take().is_some();
    if cancelled {
        eprintln!("snyvi: the restart that was waiting is called off");
    }
    emit_update(&app);
    Json(json!({ "ok": true, "cancelled": cancelled })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct UpdateCheckBody {
    /// One release by number, for `snyvi update --to`; may go down.
    #[serde(default)]
    pub(crate) to: Option<String>,
    /// Whether what is found goes past the daily floor: Check now and
    /// `snyvi update` (and every client from before this field); not
    /// `snyvi update check`, which a script may run every hour.
    #[serde(default = "yes")]
    pub(crate) lift: bool,
}

pub(crate) fn yes() -> bool {
    true
}

/// `Check now` in About, and `snyvi update`: read the manifest, stage what
/// it names, and say. What it finds newer goes past the daily floor unless
/// `lift` is false. Token or capability; a bare tab has neither.
pub(crate) async fn update_check(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<UpdateCheckBody>,
) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let Some(u) = app.update.clone() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "this daemon cannot say what file it runs from, so it does not update itself" }))).into_response();
    };
    if u.channel == crate::update::Channel::Dev {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a development build does not update itself" })),
        )
            .into_response();
    }
    if let Some(to) = &b.to {
        if semver::Version::parse(to).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("{to:?} is not a version") })),
            )
                .into_response();
        }
    }
    let to = b.to.clone();
    let ask = crate::update::Ask {
        fresh: true,
        lift: b.lift,
    };
    let r = tokio::task::spawn_blocking(move || u.check(ask, to.as_deref())).await;
    emit_update(&app);
    app.restart_wake.notify_one();
    match r {
        Ok(Ok(c)) => {
            // A person asking is a person who wants to hear: a "Later" on
            // the version found is off.
            if b.lift {
                if let Some(u) = &app.update {
                    let _ = u.snooze(None, crate::store::now());
                }
            }
            Json(json!({
                "ok": true,
                "running": c.running.to_string(),
                "latest": c.latest.to_string(),
                "newer": c.newer(),
                "ready": c.ready,
                "told": c.told,
                "update": update_json(&app),
            }))
            .into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("{e:#}"), "update": update_json(&app) })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!("the check did not finish: {e}")),
    }
}

#[derive(Deserialize)]
pub(crate) struct UpdateAutoBody {
    pub(crate) on: bool,
}

/// `Updates: on / off` in About, and `snyvi update on|off`. Written to
/// `<config>/updates.json`; `SNYVI_UPDATES=off` in the daemon's environment
/// wins, and the answer says so.
pub(crate) async fn update_auto(State(app): S, headers: HeaderMap, Json(b): Json<UpdateAutoBody>) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let Some(u) = &app.update else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this daemon does not update itself" })),
        )
            .into_response();
    };
    match u.set_auto(b.on) {
        Ok(auto) => {
            emit_update(&app);
            Json(json!({ "ok": true, "auto": auto, "update": update_json(&app) })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct LaterBody {
    /// Until when, in seconds since the epoch: the page says "tomorrow
    /// morning" in the reader's own time. Absent brings the offer back.
    #[serde(default)]
    pub(crate) until: Option<i64>,
}

/// "Later" on the update card: the offer of this version waits until then,
/// in every window, since it is the daemon's word the windows draw from.
pub(crate) async fn update_later(State(app): S, headers: HeaderMap, Json(b): Json<LaterBody>) -> Response {
    if !windowed(&app, &headers) {
        return not_windowed();
    }
    let Some(u) = &app.update else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this daemon does not update itself" })),
        )
            .into_response();
    };
    match u.snooze(b.until, crate::store::now()) {
        Ok(()) => {
            emit_update(&app);
            Json(json!({ "ok": true, "update": update_json(&app) })).into_response()
        }
        Err(e) => err(e),
    }
}

/// What a reset would take, for the sentence that asks.
pub(crate) async fn reset_census(State(app): S) -> Response {
    match app.store.census() {
        Ok(c) => Json(c).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct ResetBody {
    /// The number of documents the caller was shown and typed back. It has to
    /// be the number there is now: a document that arrived between the
    /// sentence and the answer makes the answer stale, and the caller is told
    /// to look again rather than reset a library other than the one described.
    pub(crate) documents: i64,
    /// Said explicitly, or the pinned documents keep the reset from happening.
    #[serde(default)]
    pub(crate) pinned: bool,
    /// The number of desks the caller was shown, checked the way the documents
    /// are. Missing reads as none: a caller that never said there were desks
    /// never showed the reader any, and is refused if there are.
    #[serde(default)]
    pub(crate) desks: i64,
}

/// Back to a fresh install: every document and version, the index, the token,
/// and -- by the event this ends with -- the preferences every open page keeps.
/// The daemon stays up and the agents stay registered, so the next send lands
/// in an empty library. The one action here that cannot be undone, and the one
/// that asks for a number rather than a click.
///
/// A same-origin POST is accepted beside the token, as `terminal` explains:
/// the page has no token, and the dialog is the page's.
/// "1 document", "3 documents": the reset refusals are read by a person.
pub(crate) fn docs(n: i64) -> String {
    format!("{n} document{}", if n == 1 { "" } else { "s" })
}

pub(crate) fn pinned_docs(n: i64) -> String {
    format!("{n} pinned document{}", if n == 1 { "" } else { "s" })
}

pub(crate) async fn reset(State(app): S, headers: HeaderMap, Json(b): Json<ResetBody>) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let census = match app.store.census() {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    if b.documents != census.documents {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("the library has changed: {} now, not {}", docs(census.documents), b.documents),
                "census": census,
            })),
        )
            .into_response();
    }
    if b.desks != census.desks {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("the desks have changed: {} now, not {}", census.desks, b.desks),
                "census": census,
            })),
        )
            .into_response();
    }
    if census.pinned > 0 && !b.pinned {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("{} would go with it", pinned_docs(census.pinned)),
                "census": census,
            })),
        )
            .into_response();
    }
    // The wipe and the VACUUM are disk work, and on a disk under pressure
    // they take as long as they take: off the runtime, so the other pages'
    // requests -- and the reload they are about to make -- are still answered.
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || app2.store.reset()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return err(e),
        Err(e) => return err(anyhow::anyhow!("reset task: {e}")),
    }
    // The store has let go of every pane; the processes and their text go too.
    app.panes.clear();
    for root in app.browse.list() {
        app.browse.close(&root.id);
    }
    app.browse.forget_closed();
    let _ = std::fs::remove_file(app.paths.config_dir.join("sessions.json"));
    let _ = std::fs::remove_file(app.paths.config_dir.join("folders.json"));
    match config::rotate_token(&app.paths) {
        Ok(t) => *app.token.write().unwrap() = t,
        Err(e) => return err(e),
    }
    emit(&app, "reset", json!({}));
    Json(json!({ "ok": true, "removed": census })).into_response()
}
