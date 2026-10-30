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
//!   its panel takes it over; a turn's end is the run's end. Its minutes
//!   are the ones it ran: a laptop asleep mid-run does not use them up
//!   (1.54, #198, `asleep`).
//! - **Run on a card starts the command as the panel's process** (decision
//!   of 24 Oct), on the reader's click, in the desk's folder with its keys:
//!   at once when the command is on the routine's Waits list, and only at a
//!   second press, Run anyway, when it is not (1.53, T7).
//! - **A draft runs only as a try** (1.53, plan f30461f2c1): Try once now
//!   while the reader watches, and the answers to that try once; the clock
//!   and Run now wait for Start.
//! - **Answers go on where the run was.** A command whose file reads a
//!   `continue:` form starts fresh as `/<cmd> continue: …`; any other, and
//!   the reader's own words, resume the run's own session with the answers
//!   (`--resume`, spike S4, 26 Oct: the session went on with what it had).

use super::*;
use crate::routine::{self, Routine};
use std::time::Duration;

/// How often runs under way are looked at.
const TICK: Duration = Duration::from_secs(5);
/// A session gone this soon after its start is still starting.
const GRACE_S: i64 = 15;
/// How long a panel's last process is given to go before a run starts.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// A tick this much later than its `TICK` is a machine that slept. A busy
/// box or a held store lock keeps a tick back a few seconds; half a minute
/// is longer than any of that and shorter than any sleep worth counting.
const ASLEEP_AFTER_S: i64 = 30;

/// The runner, on its own task, from the daemon's start: a run that was
/// under way when the last daemon stopped is over, and says so.
///
/// Sleep is a gap between ticks on the wall clock. Not a monotonic clock:
/// whether one counts a suspend differs by OS, and a wall-clock gap between
/// 5 s ticks reads the same on Linux, macOS and Windows. The clock set
/// forward by more than half a minute reads as sleep too, and a run gets
/// those minutes back; set back, it reads as nothing.
pub(crate) fn spawn(app: Arc<App>) {
    let _ = app.store.clocked(|c, now| routine::end_all(c, now));
    tokio::spawn(async move {
        let mut last = crate::store::now();
        loop {
            tokio::time::sleep(TICK).await;
            let slept = asleep(crate::store::now() - last);
            if slept > 0 {
                let _ = app.store.clocked(|c, _| routine::slept(c, slept));
            }
            tick(&app).await;
            last = crate::store::now();
        }
    });
}

/// The seconds a machine slept, from the wall time between two ticks: what
/// came after the tick's own `TICK`, once that is past `ASLEEP_AFTER_S`.
fn asleep(gap_s: i64) -> i64 {
    let after = gap_s - TICK.as_secs() as i64;
    if after > ASLEEP_AFTER_S {
        after
    } else {
        0
    }
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

/// What a session starts with: a prompt, or the run's own session resumed
/// with the reader's answers (its id, their words).
pub(crate) enum Begin {
    Prompt(String),
    Resume(String, String),
}

impl Begin {
    /// As the history keeps it.
    fn what(&self) -> String {
        match self {
            Begin::Prompt(p) => p.clone(),
            Begin::Resume(_, said) => format!("resumed: {said}"),
        }
    }
}

/// Why a run cannot start now, in the row's words, or `None`.
async fn blocked(app: &App, r: &Routine, desk: &crate::desk::Desk, why: &str) -> Option<String> {
    if !r.suggested_by.is_empty() {
        return Some("an offer: Accept… first".into());
    }
    let draft = r.started_at == 0;
    if draft && why != "try" && why != "answer" {
        return Some("a draft: Start it first".into());
    }
    if desk.parked.is_some() && why == "clock" {
        return Some("desk parked".into());
    }
    if !r.words() {
        let root = std::path::PathBuf::from(&desk.root);
        let rr = r.clone();
        let state = tokio::task::spawn_blocking(move || routine::file_state(&root, &rr))
            .await
            .unwrap_or("gone");
        match state {
            "gone" => {
                return Some(format!(
                    "/{} is gone: no command or skill by that name",
                    r.cmd
                ))
            }
            "two" => return Some(format!("two /{}: rename one", r.cmd)),
            "changed" | "new" if !draft => return Some("changed · Allow".into()),
            _ => {}
        }
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

/// Go ahead on a routine's line in On you (1.54, `crate::onyou`): its own
/// session resumes with *go ahead* and the line it said, as the reader's
/// answers resume it (`after_answers`), so the run goes on inside its
/// Waits -- a command outside them still stops at a run card. Without a
/// session to resume, its prompt again, saying so. Started as `answer`,
/// which `blocked` lets through a draft and a parked desk; running, paused
/// or changed come back as the reason.
pub(crate) async fn go_ahead(app: &Arc<App>, id: i64, line: &str) -> Result<(), String> {
    let Ok(Some(r)) = app.store.clocked(|c, _| routine::get(c, id)) else {
        return Err("no such routine".into());
    };
    let said = format!("go ahead: {}", crate::thread::line(line, 200));
    let session = app
        .store
        .pane(&r.pane)
        .ok()
        .flatten()
        .map(|p| p.pane.agent_session)
        .unwrap_or_default();
    let begin = if session.is_empty() {
        Begin::Prompt(format!("{} (resumed: no) The user said {said}", r.prompt()))
    } else {
        Begin::Resume(session, said)
    };
    start_with(app, id, "answer", Some(begin)).await
}

async fn start_with(
    app: &Arc<App>,
    id: i64,
    why: &str,
    begin: Option<Begin>,
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
        if no != "running" && why != "you" && why != "try" {
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, id, &no, now));
            changed(app, r.desk_id);
        } else if why == "clock" {
            // An hour that came while its last run was still under way:
            // the row keeps that run's lateness, not the hour's.
            let _ = app.store.clocked(|c, _| routine::late_as_last(c, id));
        }
        return Err(no);
    }
    if why != "clock" {
        let _ = app.store.clocked(|c, _| routine::not_late(c, id));
    }
    let begin = begin.unwrap_or_else(|| Begin::Prompt(r.prompt()));
    match start_now(app, &r, &desk, &begin).await {
        Ok(()) => {
            let what = begin.what();
            let _ = app.store.clocked(|c, now| {
                routine::began(c, id, why, &what, routine::SESSION, now).map(|_| ())
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
    app.store
        .rename_pane(&pane.id, &crate::thread::line(&r.name, 40), "")?;
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

/// The arguments a session starts with: its settings, then the prompt or
/// the answers as one argument after `--`, never typed.
fn args_of(settings: &std::path::Path, begin: &Begin) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Begin::Resume(session, _) = begin {
        args.extend(["--resume".into(), session.clone()]);
    }
    args.extend([
        "--permission-mode".into(),
        "auto".into(),
        "--settings".into(),
        settings.to_string_lossy().into_owned(),
        "--".into(),
    ]);
    args.push(match begin {
        Begin::Prompt(p) => p.clone(),
        Begin::Resume(_, said) => said.clone(),
    });
    args
}

async fn start_now(
    app: &Arc<App>,
    r: &Routine,
    desk: &crate::desk::Desk,
    begin: &Begin,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let pane = panel(app, r, desk).await?;
    let placed = app.store.pane(&pane)?.context("its panel is gone")?;
    let settings = settings_file(&app.paths.data_dir, r)?;
    let mut env = super::api_desk::pane_env(app, &placed).await.env;
    env.push(("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), "85".into()));
    process(app, &placed, "claude", &args_of(&settings, begin), &env).await
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
    if turn.kind != "run"
        || ![RUN, RUN_ANYWAY].contains(&turn.answer.as_str())
        || turn.cmd.is_empty()
    {
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
/// Its second press, for a command not on the routine's Waits list.
pub(crate) const RUN_ANYWAY: &str = "Run anyway";

/// Before a card is answered: Run on a routine's run card whose command is
/// not on its Waits list is refused, with the words the card shows, and
/// the second press (`RUN_ANYWAY`) runs it (T7). `None` for anything else.
pub(crate) fn run_refused(app: &App, desk: i64, t: i64, answer: &str) -> Option<String> {
    if answer != RUN {
        return None;
    }
    let turn = app
        .store
        .clocked(|c, _| crate::thread::turn(c, desk, t))
        .ok()??;
    if turn.kind != "run" || turn.cmd.is_empty() {
        return None;
    }
    let r = app
        .store
        .clocked(|c, _| routine::of_pane(c, &turn.pane))
        .ok()??;
    (!routine::waits::on_list(&r.waits, &turn.cmd))
        .then(|| "not on your Waits list: Run anyway starts it".to_string())
}

/// A desk's turns, as the rail reads them: each run card from a routine's
/// panel says whether its command is on that routine's Waits list.
pub(crate) fn mark_waits(app: &App, desk: i64, turns: &mut serde_json::Value) {
    let Ok(rs) = app.store.clocked(|c, _| routine::for_desk(c, desk)) else {
        return;
    };
    let Some(list) = turns.as_array_mut() else {
        return;
    };
    for t in list {
        if t["kind"] != "run" {
            continue;
        }
        let pane = t["pane"].as_str().unwrap_or_default();
        if let Some(r) = rs.iter().find(|r| !pane.is_empty() && r.pane == pane) {
            let ok = routine::waits::on_list(&r.waits, t["cmd"].as_str().unwrap_or_default());
            t["waits_ok"] = json!(ok);
        }
    }
}

/// What the reader's answers start: `/<cmd> continue: …` when its file
/// reads that form; else the run's own session resumed with their words;
/// with no session to resume, a fresh one told the answers, and said so.
fn after_answers(app: &App, r: &Routine, answers: &[(i64, String)]) -> Begin {
    let said = routine::said(answers);
    if !r.words() {
        let text = app
            .store
            .desk(r.desk_id)
            .ok()
            .flatten()
            .and_then(|d| routine::places::from_file(std::path::Path::new(&d.root), &r.file))
            .and_then(|p| std::fs::read_to_string(p.path).ok())
            .unwrap_or_default();
        if routine::continues(&text) {
            return Begin::Prompt(routine::continue_prompt(r, answers));
        }
    }
    let session = app
        .store
        .pane(&r.pane)
        .ok()
        .flatten()
        .map(|p| p.pane.agent_session)
        .unwrap_or_default();
    if session.is_empty() {
        Begin::Prompt(format!(
            "{} (resumed: no) Your answers to its questions: {said}",
            r.prompt()
        ))
    } else {
        Begin::Resume(session, said)
    }
}

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
        // Paused, nothing starts; a draft goes on only from its try (T4).
        // A removed one is not in `all`: its cards wait, and start nothing.
        if r.paused_at != 0 || !r.suggested_by.is_empty() {
            continue;
        }
        // The reader's answers, all in, start the next session.
        let Ok(ready) = app.store.clocked(|c, _| routine::answers_ready(c, &r.pane)) else {
            continue;
        };
        if ready.is_empty() || app.panes.status(&r.pane).agent == "working" {
            continue;
        }
        if r.started_at == 0
            && app
                .store
                .clocked(|c, _| routine::last_why(c, r.id))
                .unwrap_or_default()
                != "try"
        {
            continue;
        }
        let begin = after_answers(app, &r, &ready);
        let ids: Vec<i64> = ready.iter().map(|(id, _)| *id).collect();
        let _ = app.store.clocked(|c, now| routine::told(c, &ids, now));
        let app = app.clone();
        tokio::spawn(async move {
            let _ = start_with(&app, r.id, "answer", Some(begin)).await;
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
    if over(r, now) {
        app.panes.get(&r.pane).stop();
        end(format!("stopped at {} min", r.minutes));
    }
}

/// Whether a run under way is past its minutes: the time it ran, without
/// the time the machine slept through it.
fn over(r: &Routine, now: i64) -> bool {
    now - r.running_since - r.slept_s > r.minutes * 60
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
    fn a_tick_half_a_minute_late_is_a_machine_that_slept() {
        assert_eq!(asleep(5), 0);
        assert_eq!(asleep(-3600), 0, "a clock set back is not sleep");
        // A busy box holds a tick back; that is not sleep.
        assert_eq!(asleep(5 + ASLEEP_AFTER_S), 0);
        assert_eq!(asleep(6 + ASLEEP_AFTER_S), 1 + ASLEEP_AFTER_S);
        assert_eq!(asleep(5 + 40 * 60), 40 * 60);
    }

    #[test]
    fn a_runs_minutes_are_the_ones_it_ran_not_the_ones_it_slept() {
        let r = Routine {
            minutes: 25,
            running_since: 1_000,
            ..Routine::default()
        };
        // Forty minutes on the wall, thirty-five of them asleep: five ran.
        let slept = Routine {
            slept_s: 35 * 60,
            ..r.clone()
        };
        assert!(!over(&slept, 1_000 + 40 * 60));
        // The same forty minutes awake are over its twenty-five.
        assert!(over(&r, 1_000 + 40 * 60));
        // Asleep or not, a run that truly ran past its minutes is over.
        assert!(over(&slept, 1_000 + 35 * 60 + 25 * 60 + 1));
        assert!(!over(&r, 1_000 + 25 * 60));
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

    #[test]
    fn answers_resume_the_runs_session_as_one_argument() {
        let f = std::path::Path::new("/d/routines/4/settings.json");
        let a = args_of(
            f,
            &Begin::Resume("abc".into(), "1. approve; 2. skip".into()),
        );
        assert_eq!(
            a,
            [
                "--resume",
                "abc",
                "--permission-mode",
                "auto",
                "--settings",
                "/d/routines/4/settings.json",
                "--",
                "1. approve; 2. skip"
            ]
        );
        let a = args_of(f, &Begin::Prompt("/newsroom continue: approve".into()));
        assert_eq!(a.first().map(String::as_str), Some("--permission-mode"));
        assert_eq!(
            a.last().map(String::as_str),
            Some("/newsroom continue: approve")
        );
        assert_eq!(
            Begin::Resume("x".into(), "yes".into()).what(),
            "resumed: yes"
        );
    }
}
