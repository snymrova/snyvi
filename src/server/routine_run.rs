//! The routines' runner (1.50, plan 4f1379f4a4): at a routine's hour, the
//! desk's slash command in a panel in the back (`crate::routine`).
//!
//! What it holds to:
//!
//! - **Started by the clock the reader set, or their Run now.** Nothing a
//!   token says starts a routine. The prompt is the reader's line; the
//!   next session's prompt is the reader's answers on its cards, never the
//!   questions an agent wrote.
//! - **A session is an argument, never keystrokes**, as a pipeline's stage
//!   is: `claude --permission-mode auto --settings <file> -- /newsroom`,
//!   the prompt one argv entry. The settings file is written here, at each
//!   start, beside the store: the pipelines' `DENY` and the routine's
//!   Waits list as deny rules (spike S1, 24 Oct: a deny matched behind
//!   `cd x && …`, and Claude said so in a line).
//! - **Each start is checked, and a skip says why**: the desk open and not
//!   parked, the command on disk as it was allowed, the account signed in,
//!   the five-hour window under the routine's limit, no run under way.
//! - **It stops.** A run past its minutes is stopped; the reader typing in
//!   its panel takes it over; a turn's end is the run's end.
//! - **Run on a card starts the command as the panel's process** (decision
//!   of 24 Oct), on the reader's click, in the desk's folder with its keys.

use super::*;
use crate::routine::{self, Routine};
use std::time::Duration;

/// How often runs under way are looked at.
const TICK: Duration = Duration::from_secs(5);
/// A session gone this soon after its start is still starting.
const GRACE_S: i64 = 15;
/// How long a panel's last process is given to go before a run starts.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// The runner, on its own task, from the daemon's start: a run that was
/// under way when the last daemon stopped is over, and says so.
pub(crate) fn spawn(app: Arc<App>) {
    let _ = app.store.clocked(|c, now| routine::end_all(c, now));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app).await;
        }
    });
}

/// A desk's routines moved: its windows read them again, on the
/// `desknotes` event the rail already listens to.
pub(crate) fn changed(app: &App, desk: i64) {
    emit(app, "desknotes", json!({ "desk": desk, "routines": true }));
}

/// The clock's half-minute look (`lifecycle::ring_due`): each routine whose
/// hour has come is set to its next first, then started.
pub(crate) fn ring(app: &Arc<App>) {
    let due = match app.store.clocked(|c, now| {
        routine::pass_closed(c, now)?;
        let due = routine::due(c, now)?;
        for r in &due {
            routine::rearm(c, r, now)?;
        }
        Ok(due)
    }) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("snyvi: the clock for routines: {e:#}");
            return;
        }
    };
    for r in due {
        let app = app.clone();
        tokio::spawn(async move {
            let _ = start(&app, r.id, "clock").await;
        });
    }
}

/// Why a run cannot start now, in the row's words, or `None`.
async fn blocked(app: &App, r: &Routine, desk: &crate::desk::Desk, why: &str) -> Option<String> {
    if !r.suggested_by.is_empty() {
        return Some("an offer: Accept… first".into());
    }
    if desk.parked.is_some() && why == "clock" {
        return Some("desk parked".into());
    }
    let root = std::path::PathBuf::from(&desk.root);
    let cmd = r.cmd.clone();
    let hash = tokio::task::spawn_blocking(move || routine::hash_of(&root, &cmd))
        .await
        .ok()
        .flatten();
    match hash {
        None => return Some(format!("command gone: .claude/commands/{}.md", r.cmd)),
        Some(h) if h != r.cmd_hash => return Some("changed · Allow".into()),
        Some(_) => {}
    }
    if r.running_since != 0 {
        return Some("running".into());
    }
    let account = crate::accounts::effective(desk.account, None);
    if app.usage.is_broken(account) {
        return Some("sign in".into());
    }
    if let Some(l) = app.usage.five_hour(account) {
        let now = crate::store::now();
        if l.resets_at > now && l.used >= r.five_hour as f64 {
            return Some(format!(
                "limit: the five-hour window is {}% used, until {}",
                l.used.round(),
                hm(l.resets_at)
            ));
        }
    }
    None
}

/// `07:30`, in the reader's time.
fn hm(at: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(at)
        .map(|t| {
            let t = t.to_offset(crate::due::offset());
            format!("{:02}:{:02}", t.hour(), t.minute())
        })
        .unwrap_or_default()
}

/// Start a routine's session: from the clock, Run now (`you`), or the
/// reader's answers (`answer`, with `prompt` the continue line). A start
/// that cannot happen is a skip on the row, and the reason is the answer.
pub(crate) async fn start(app: &Arc<App>, id: i64, why: &str) -> Result<(), String> {
    start_with(app, id, why, None).await
}

async fn start_with(
    app: &Arc<App>,
    id: i64,
    why: &str,
    prompt: Option<String>,
) -> Result<(), String> {
    let Ok(Some(r)) = app.store.clocked(|c, _| routine::get(c, id)) else {
        return Err("no such routine".into());
    };
    let Ok(Some(desk)) = app.store.desk(r.desk_id) else {
        return Err("its desk is closed".into());
    };
    if r.removed_at != 0 {
        return Err("removed".into());
    }
    if let Some(no) = blocked(app, &r, &desk, why).await {
        // Run now refused is said where it was clicked; an hour passed by
        // is kept on the row and in the history.
        if no != "running" && why != "you" {
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, id, &no, now));
            changed(app, r.desk_id);
        }
        return Err(no);
    }
    let prompt = prompt.unwrap_or_else(|| r.prompt());
    match start_now(app, &r, &desk, &prompt).await {
        Ok(()) => {
            let _ = app.store.clocked(|c, now| {
                routine::began(c, id, why, &prompt, routine::SESSION, now).map(|_| ())
            });
            changed(app, r.desk_id);
            Ok(())
        }
        Err(e) => {
            let no = format!("{e:#}");
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, id, &no, now));
            changed(app, r.desk_id);
            Err(no)
        }
    }
}

/// The routine's panel in the back, made at its first run and named by its
/// line; made again when the reader closed it.
async fn panel(app: &App, r: &Routine, desk: &crate::desk::Desk) -> anyhow::Result<String> {
    if !r.pane.is_empty() && app.store.pane(&r.pane)?.is_some() {
        return Ok(r.pane.clone());
    }
    let pane = match app
        .store
        .open_pane_on(desk.id, &desk.root, "", false, true)?
    {
        crate::desk::Opened::Pane(p) => p,
        crate::desk::Opened::DeskFull => {
            anyhow::bail!("the desk's back is full: close a panel there")
        }
        crate::desk::Opened::NoSuchDesk => anyhow::bail!("its desk is closed"),
    };
    app.store.rename_pane(&pane.id, &r.name, "")?;
    app.store
        .clocked(|c, _| routine::set_pane(c, r.id, &pane.id))?;
    super::api_desk::desks_moved(app);
    Ok(pane.id)
}

/// Stop what the panel is running, and wait for it to go.
async fn stop_then(app: &App, pane: &str) -> anyhow::Result<()> {
    if !app.panes.is_running(pane) {
        return Ok(());
    }
    app.panes.get(pane).stop();
    let until = Instant::now() + STOP_WAIT;
    while app.panes.is_running(pane) {
        if Instant::now() > until {
            anyhow::bail!("the panel's program did not stop");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// The run's settings, written by snyvi beside its store at each start.
fn settings_file(data_dir: &std::path::Path, r: &Routine) -> anyhow::Result<std::path::PathBuf> {
    let dir = data_dir.join("routines").join(r.id.to_string());
    std::fs::create_dir_all(&dir)?;
    let f = dir.join("settings.json");
    let deny: Vec<&str> = super::pipeline_run::DENY.to_vec();
    std::fs::write(&f, routine::settings(&deny, &r.waits).to_string())?;
    Ok(f)
}

async fn start_now(
    app: &Arc<App>,
    r: &Routine,
    desk: &crate::desk::Desk,
    prompt: &str,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let pane = panel(app, r, desk).await?;
    let placed = app.store.pane(&pane)?.context("its panel is gone")?;
    let settings = settings_file(&app.paths.data_dir, r)?;
    let mut env = super::api_desk::pane_env(app, &placed).await.env;
    env.push(("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), "85".into()));
    let args: Vec<String> = vec![
        "--permission-mode".into(),
        "auto".into(),
        "--settings".into(),
        settings.to_string_lossy().into_owned(),
        "--".into(),
        prompt.to_string(),
    ];
    process(app, &placed, "claude", &args, &env).await
}

/// Start `cmd` as the panel's process, its last one stopped first.
async fn process(
    app: &Arc<App>,
    placed: &crate::desk::Placed,
    cmd: &str,
    args: &[String],
    env: &[(String, String)],
) -> anyhow::Result<()> {
    stop_then(app, &placed.pane.id).await?;
    let live = app.panes.get(&placed.pane.id);
    let (cols, rows) = live.size();
    live.start(
        crate::pane::Start {
            cwd: &placed.root,
            root: &placed.root,
            cmd,
            args,
            desk: &placed.desk_name,
            slot: placed.pane.slot,
            cols,
            rows,
            accent: "",
            offer: false,
            env,
            account: placed.account(),
            back: crate::desk::in_back(placed.pane.slot),
        },
        &app.panes,
    )?;
    Ok(())
}

/// What the hook said at a turn's end in a routine's panel: the session's
/// run is over, with its last line. A turn that failed ends it too.
pub(crate) fn heard(
    app: &App,
    pane: &str,
    stopped: Option<&str>,
    stop: Option<&super::pipeline_run::StopBody>,
) {
    let failed = stopped.filter(|w| !w.is_empty());
    if stop.is_none() && failed.is_none() {
        return;
    }
    let Ok(Some(r)) = app.store.clocked(|c, _| routine::of_pane(c, pane)) else {
        return;
    };
    if r.running != routine::SESSION {
        return;
    }
    let (state, line) = match failed {
        Some(why) => (format!("ended: {why}"), String::new()),
        None => (
            "done".to_string(),
            last_line(&stop.map(|s| s.reply.clone()).unwrap_or_default()),
        ),
    };
    let _ = app
        .store
        .clocked(|c, now| routine::ended(c, r.id, &state, &line, now));
    changed(app, r.desk_id);
}

/// The last line a reply said, without its Markdown marks.
fn last_line(reply: &str) -> String {
    reply
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches(['#', '>', '-', '*', ' '])
                .replace("**", "")
        })
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or_default()
}

/// The reader answered a card from a routine's panel. A run card's Run
/// starts its command as the panel's process; a question's answer waits for
/// the tick, which starts the next session once every question is in.
pub(crate) async fn answered(app: &Arc<App>, turn: &crate::thread::Turn) {
    if turn.kind != "run" || turn.answer != RUN || turn.cmd.is_empty() {
        return;
    }
    let Ok(Some(r)) = app.store.clocked(|c, _| routine::of_pane(c, &turn.pane)) else {
        return;
    };
    let Ok(Some(placed)) = app.store.pane(&r.pane) else {
        return;
    };
    let env = super::api_desk::pane_env(app, &placed).await.env;
    let cmd = turn.cmd.clone();
    if r.running == routine::SESSION {
        let _ = app
            .store
            .clocked(|c, now| routine::ended(c, r.id, "done", "", now).map(|_| ()));
    }
    match process(app, &placed, &cmd, &[], &env).await {
        Ok(()) => {
            let _ = app
                .store
                .clocked(|c, now| routine::began(c, r.id, "card", &cmd, &cmd, now).map(|_| ()));
        }
        Err(e) => {
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, r.id, &format!("{e:#}"), now));
        }
    }
    changed(app, r.desk_id);
}

/// The answer a routine's run card gives when its Run is pressed.
pub(crate) const RUN: &str = "Run";

async fn tick(app: &Arc<App>) {
    let Ok(all) = app.store.clocked(|c, _| {
        let mut st =
            c.prepare_cached("SELECT DISTINCT desk_id FROM routines WHERE removed_at = 0")?;
        let desks: Vec<i64> = st
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut v = Vec::new();
        for d in desks {
            v.extend(routine::for_desk(c, d)?);
        }
        Ok(v)
    }) else {
        return;
    };
    let now = crate::store::now();
    for r in all.into_iter().filter(|r| !r.pane.is_empty()) {
        if r.running_since != 0 {
            watch(app, &r, now);
            continue;
        }
        // The reader's answers, all in, start the next session.
        let Ok(ready) = app.store.clocked(|c, _| routine::answers_ready(c, &r.pane)) else {
            continue;
        };
        if ready.is_empty() || app.panes.status(&r.pane).agent == "working" {
            continue;
        }
        let prompt = routine::continue_prompt(&r, &ready);
        let ids: Vec<i64> = ready.iter().map(|(id, _)| *id).collect();
        let _ = app.store.clocked(|c, now| routine::told(c, &ids, now));
        let app = app.clone();
        tokio::spawn(async move {
            let _ = start_with(&app, r.id, "answer", Some(prompt)).await;
        });
    }
}

/// A run under way: over its minutes, taken over, or gone?
fn watch(app: &App, r: &Routine, now: i64) {
    let status = app.panes.status(&r.pane);
    let end = |state: String| {
        let _ = app
            .store
            .clocked(|c, now| routine::ended(c, r.id, &state, "", now));
        changed(app, r.desk_id);
    };
    if !status.running {
        // Not yet started, unless it has already said how it ended.
        if now - r.running_since < GRACE_S && status.exit.is_none() {
            return;
        }
        if r.running == routine::SESSION {
            return end("ended".into());
        }
        return end(match status.exit {
            Some(code) => format!("ran · exit {code}"),
            None => "ran".into(),
        });
    }
    if r.running == routine::SESSION && status.entered_at > r.running_since {
        return end(format!("taken over {}", hm(status.entered_at)));
    }
    if now - r.running_since > r.minutes * 60 {
        app.panes.get(&r.pane).stop();
        end(format!("stopped at {} min", r.minutes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runs_last_line_is_what_it_said_last() {
        assert_eq!(
            last_line("Fetched 6.\n\n**Done:** 2 drafts wait for you.\n\n"),
            "Done: 2 drafts wait for you."
        );
        assert_eq!(last_line("- one\n- two"), "two");
        assert_eq!(last_line(""), "");
    }

    #[test]
    fn a_runs_settings_deny_what_no_run_may_do_and_what_waits() {
        let dir = crate::store::tempdir::Dir::new("snyvi-routine-settings");
        let r = Routine {
            id: 4,
            waits: vec!["python3 -I newsroom/publish.py *".into()],
            ..Routine::default()
        };
        let f = settings_file(&dir.path, &r).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let deny = v["permissions"]["deny"].as_array().unwrap();
        assert!(deny.iter().any(|x| x == "Bash(git push *)"));
        assert!(deny
            .iter()
            .any(|x| x == "Bash(python3 -I newsroom/publish.py *)"));
        assert!(f.ends_with("routines/4/settings.json"));
    }
}
