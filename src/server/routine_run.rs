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
//! - **1.63: what wakes it.** A time's words and the lines its watch or
//!   gate printed, in the reader's shape, are added to its prompt; nothing
//!   else is (`Routine::prompt_with`). The gate is asked for a clock run at
//!   a ticked time only (C2): an answer and an event never meet it. A run
//!   no hook has spoken from in 90 s did not start, and says so (R9).

use super::*;
use crate::routine::{self, events, times, Routine};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
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
/// A session no hook has spoken from this long after its start did not
/// start: a sign-in, a trust question, a crash. Not 60: a start with a few
/// hundred skills is slow on a small box.
const START_S: i64 = 90;
/// An event run that could not start waits this long before trying again,
/// so a limit or a sign-in is said once, not every tick.
const EVENT_HOLD_S: i64 = 300;
/// A five-hour reading older than this is not kept on a run (R12).
const FRESH_S: i64 = 300;

/// The last time any hook spoke from each panel, in memory (R9), and
/// whether one ever has since the daemon started: on a machine whose hook
/// is not set up, no run is ended for its silence.
static HEARD: LazyLock<Mutex<(bool, HashMap<String, i64>)>> =
    LazyLock::new(|| Mutex::new((false, HashMap::new())));
/// Event runs held after a start that could not happen, until when.
static EVENT_HOLD: LazyLock<Mutex<HashMap<i64, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Routines a start is under way for: from its checks to its run written
/// down, a gate's minute included. The clock, a watch's batch and Run now
/// are separate looks, and two starts of one routine at once would each
/// pass `blocked` and the second would stop the first's panel.
static STARTING: LazyLock<Mutex<std::collections::HashSet<i64>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// A routine claimed for one start, let go when the start is over.
struct Starting(i64);

impl Starting {
    fn claim(id: i64) -> Option<Starting> {
        // The lock is let go before a `Starting` exists: one made and
        // dropped under it would take it again, and free the other's claim.
        let took = STARTING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
        took.then(|| Starting(id))
    }
}

impl Drop for Starting {
    fn drop(&mut self) {
        STARTING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// A hook spoke from `pane`: its session is up.
pub(crate) fn stamp(pane: &str) {
    if let Ok(mut h) = HEARD.lock() {
        h.0 = true;
        h.1.insert(pane.to_string(), crate::store::now());
    }
}

/// Whether a session in `pane` started at `since` has not been heard from,
/// on a machine whose hook speaks.
fn unheard(pane: &str, since: i64) -> bool {
    HEARD
        .lock()
        .map(|h| h.0 && h.1.get(pane).is_none_or(|t| *t < since))
        .unwrap_or(false)
}

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
                super::routine_watch::woke();
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

/// A line in `daemon.log` with its time (1.66): a watch's start, exit,
/// restart and stop, and a routine stuck or reworded. The watch that
/// stopped silently (bug 0f204f3135) left nothing to read back.
pub(crate) fn log(what: &str) {
    let t = time::OffsetDateTime::now_utc().to_offset(crate::due::offset());
    eprintln!(
        "{}-{:02}-{:02} {:02}:{:02}:{:02} snyvi: {what}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    );
}

/// A routine cannot run, and why (1.66): said once, loudly -- a row in
/// Waiting (`onyou`), the rail redrawn, a log line. Its events stay
/// waiting (`run_id 0`) and run on the reader's Allow.
pub(crate) fn stuck(app: &App, r: &Routine, why: &str) {
    let news = app
        .store
        .clocked(|c, now| routine::stuck(c, r.id, why, now))
        .unwrap_or(false);
    if news {
        log(&format!("routine {} ({}) cannot run: {why}", r.id, r.name));
        changed(app, r.desk_id);
        super::api_thread::threads_moved(app, r.desk_id);
    }
}

/// A reason a run cannot start that waits for the reader: its file, and
/// nothing a minute will mend (a run under way, a limit, a parked desk).
pub(crate) fn stuck_kind(no: &str) -> bool {
    no.starts_with("changed") || no.contains(" is gone") || no.starts_with("two /")
}

/// A routine's file as it stands (1.66), with what that settles. A pre-1.66
/// routine whose file is as it was allowed gets its two hashes; one whose
/// words alone changed keeps them as allowed, says so in News with the
/// diff, and runs on. What is left -- `changed` (what it may run), `gone`,
/// `two`, `new` -- blocks; `ok` and `words` do not. A file that is back as
/// allowed takes the routine out of Waiting.
pub(crate) async fn file_now(app: &App, r: &Routine, root: &std::path::Path) -> &'static str {
    let (root, rr) = (root.to_path_buf(), r.clone());
    let (state, split) = tokio::task::spawn_blocking(move || {
        let st = routine::file_state(&root, &rr);
        let split = if (st == "ok" && rr.may_hash.is_empty()) || st == "reworded" {
            routine::split_now(&root, &rr)
        } else {
            None
        };
        (st, split)
    })
    .await
    .unwrap_or(("gone", None));
    let state = match (state, split) {
        ("ok", Some((h, s))) => {
            let _ = app
                .store
                .clocked(|c, _| routine::set_split(c, r.id, &h, &s));
            "ok"
        }
        ("reworded", Some((h, s))) => {
            let said = app.store.clocked(|c, now| {
                let Some(was) = routine::reworded(c, r.id, &h, &s)? else {
                    return Ok(false);
                };
                let detail = crate::news::diff(&was, &s.text, 40);
                let text = format!(
                    "{}'s command was reworded. It runs on with the new words.",
                    r.name
                );
                crate::news::add(
                    c,
                    r.desk_id,
                    &crate::news::New {
                        kind: "reworded",
                        text: &text,
                        detail: &detail,
                        routine_id: r.id,
                        ..Default::default()
                    },
                    now,
                )?;
                Ok(true)
            });
            if matches!(said, Ok(true)) {
                log(&format!(
                    "routine {} ({}): its command was reworded, runs on",
                    r.id, r.name
                ));
                changed(app, r.desk_id);
                super::api_thread::threads_moved(app, r.desk_id);
            }
            "ok"
        }
        ("reworded", None) => "gone",
        (s, _) => s,
    };
    if matches!(state, "ok" | "words")
        && r.stuck.starts_with("changed")
        && app
            .store
            .clocked(|c, _| routine::unstuck(c, r.id))
            .unwrap_or(false)
    {
        changed(app, r.desk_id);
        super::api_thread::threads_moved(app, r.desk_id);
    }
    state
}

/// Raise one card on the reader's On you list about a routine: a watch that
/// gave up, failed gates, a run that did not start.
pub(crate) fn card(app: &App, r: &Routine, text: &str) {
    let ask = crate::thread::Ask {
        kind: "do".into(),
        text: crate::thread::line(text, 400),
        by: "snyvi".into(),
        pane: r.pane.clone(),
        ..Default::default()
    };
    if let Ok(crate::thread::Asked::Turn(t)) = app
        .store
        .clocked(|c, now| crate::thread::ask(c, r.desk_id, &ask, now))
    {
        super::api_thread::threads_moved(app, r.desk_id);
        notify_turn(app, &t, 0);
    }
}

/// What woke a run besides its line: a time's words and whether its gate
/// is asked, and the hour, as History and the brief say it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Wake {
    pub words: String,
    pub gated: bool,
    pub at: String,
}

/// The clock's half-minute look (`lifecycle::ring_due`): each routine whose
/// hour has come has its earliest set of words taken (R3), those times set
/// to their next first, then started.
pub(crate) fn ring(app: &Arc<App>) {
    let due = match app.store.clocked(|c, now| {
        routine::pass_closed(c, now)?;
        let mut out = Vec::new();
        for r in routine::due(c, now)? {
            match times::fired(c, r.id, now)? {
                Some(f) => {
                    routine::rearm(c, &r, &f, now)?;
                    out.push((r.id, f));
                }
                // The cached soonest was stale: read again.
                None => times::sync(c, r.id)?,
            }
        }
        Ok(out)
    }) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("snyvi: the clock for routines: {e:#}");
            return;
        }
    };
    for (id, f) in due {
        let app = app.clone();
        let wake = Wake {
            words: f.words,
            gated: f.gated,
            at: f.at,
        };
        tokio::spawn(async move {
            let _ = start_with(&app, id, "clock", None, wake).await;
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
    if desk.parked.is_some() && (why == "clock" || why == "event") {
        return Some("desk parked".into());
    }
    if !r.words() {
        let root = std::path::PathBuf::from(&desk.root);
        let state = file_now(app, r, &root).await;
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
    start_with(app, id, why, None, Wake::default()).await
}

/// Try once now with words (1.63): the words as a time's would be.
pub(crate) async fn try_with(app: &Arc<App>, id: i64, words: &str) -> Result<(), String> {
    let wake = Wake {
        words: words.to_string(),
        ..Wake::default()
    };
    start_with(app, id, "try", None, wake).await
}

/// Stop, from the row's menu (1.63, R15): the run under way ends, said so,
/// its panel's program stopped.
pub(crate) fn stop(app: &App, r: &Routine) -> bool {
    if r.running_since == 0 {
        return false;
    }
    if !r.pane.is_empty() {
        app.panes.get(&r.pane).stop();
    }
    let done = app
        .store
        .clocked(|c, now| routine::act(c, r.id, routine::Act::Stop, now))
        .unwrap_or(false);
    changed(app, r.desk_id);
    done
}

/// The five-hour window's use for a desk's account, when the reading is fresh.
fn five_now(app: &App, desk: &crate::desk::Desk) -> Option<f64> {
    let account = crate::accounts::effective(desk.account, None);
    app.usage
        .five_hour_fresh(account, crate::store::now(), FRESH_S)
}

/// What woke a run, said once: `at its hour (13:00) · case`, or `tag 5304 ; tag 5311`.
fn woke_words(why: &str, wake: &Wake, ids: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    match why {
        "clock" if !wake.at.is_empty() => parts.push(format!("at its hour ({})", wake.at)),
        "try" if !wake.words.is_empty() => parts.push("a try with words".into()),
        _ => {}
    }
    if !wake.words.is_empty() {
        parts.push(wake.words.clone());
    }
    if !ids.is_empty() {
        parts.push(ids.join(" ; "));
    }
    parts.join(" · ")
}

/// The gate's answer for a clock run at a ticked time (C2): `None` to go
/// on, or the reason it does not, already kept on the row.
async fn gated(
    app: &Arc<App>,
    r: &Routine,
    desk: &crate::desk::Desk,
    woke: &str,
) -> Option<String> {
    match super::routine_gate::ask(app, r, desk).await {
        super::routine_gate::Said::Yes(_) => None,
        super::routine_gate::Said::No => {
            let _ = app
                .store
                .clocked(|c, now| routine::quiet(c, r.id, woke, now));
            changed(app, r.desk_id);
            Some("quiet".into())
        }
        super::routine_gate::Said::Failed(why) => {
            let states = app
                .store
                .clocked(|c, now| {
                    routine::gate_failed(c, r.id, &why, woke, now)?;
                    routine::last_states(c, r.id, 4)
                })
                .unwrap_or_default();
            if super::routine_gate::fails_to_card(&states) {
                card(
                    app,
                    r,
                    &format!(
                        "The gate of routine \"{}\" failed three times in a row: {why}. Look at its sheet.",
                        r.name
                    ),
                );
            }
            changed(app, r.desk_id);
            Some(format!("gate failed: {why}"))
        }
    }
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
    start_with(app, id, "answer", Some(begin), Wake::default()).await
}

async fn start_with(
    app: &Arc<App>,
    id: i64,
    why: &str,
    begin: Option<Begin>,
    wake: Wake,
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
    // Another start of it under way reads as a run: it is one, a moment
    // early.
    let claim = Starting::claim(id);
    let no = match claim {
        None => Some("running".to_string()),
        Some(_) => blocked(app, &r, &desk, why).await,
    };
    if let Some(no) = no {
        // 1.66: what only the reader can fix is said once, in Waiting.
        if (why == "clock" || why == "event") && stuck_kind(&no) {
            stuck(app, &r, &no);
        }
        // Run now refused is said where it was clicked; an hour passed by
        // is kept on the row and in the history.
        if why == "event" {
            // Held, and said once: the lines wait, and the row does not say
            // the same thing again every few minutes.
            if let Ok(mut h) = EVENT_HOLD.lock() {
                h.insert(id, crate::store::now() + EVENT_HOLD_S);
            }
            if no != "running" && r.last_state != format!("skipped: {no}") {
                let _ = app
                    .store
                    .clocked(|c, now| routine::skipped(c, id, why, &no, now));
                changed(app, r.desk_id);
            }
        } else if no != "running" && why != "you" && why != "try" {
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, id, why, &no, now));
            changed(app, r.desk_id);
        } else if why == "clock" {
            // An hour that came while its last run was still under way:
            // the row keeps that run's lateness, not the hour's.
            let _ = app.store.clocked(|c, _| routine::late_as_last(c, id));
        }
        return Err(no);
    }
    if let Ok(mut h) = EVENT_HOLD.lock() {
        h.remove(&id);
    }
    if why == "clock" && wake.gated && !r.gate.trim().is_empty() {
        let woke = woke_words(why, &wake, &[]);
        if let Some(no) = gated(app, &r, &desk, &woke).await {
            return Err(no);
        }
    }
    if why != "clock" {
        let _ = app.store.clocked(|c, _| routine::not_late(c, id));
    }
    // What waits from its watch or gate rides a clock run after its words,
    // and is an event run's reason; taken now, and not put back.
    let ids = if why == "clock" || why == "event" {
        app.store
            .clocked(|c, _| events::take(c, id))
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let woke = woke_words(why, &wake, &ids);
    let _ = app.store.clocked(|c, _| routine::waking(c, id, &woke));
    let begin = begin.unwrap_or_else(|| Begin::Prompt(r.prompt_with(&wake.words, &ids)));
    let five = five_now(app, &desk);
    match start_now(app, &r, &desk, &begin).await {
        Ok(()) => {
            let what = begin.what();
            let _ = app.store.clocked(|c, now| {
                let run = routine::began(c, id, why, &what, routine::SESSION, now)?;
                events::bind(c, id, run)?;
                routine::woke(c, run, &woke, five)
            });
            changed(app, r.desk_id);
            Ok(())
        }
        Err(e) => {
            let no = format!("{e:#}");
            let _ = app
                .store
                .clocked(|c, now| routine::skipped(c, id, why, &no, now));
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
        .open_pane_on(desk.id, &desk.root, "", false, (0, true))?
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

/// Stop what the panel is running, and wait for it to go. The restore
/// queue's too (`restore_run`), before a shell on offer becomes its
/// conversation.
pub(crate) async fn stop_then(app: &App, pane: &str) -> anyhow::Result<()> {
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
/// A slim routine's leave out the reader's global CLAUDE.md (S2).
fn settings_file(
    data_dir: &std::path::Path,
    r: &Routine,
    home: Option<&std::path::Path>,
) -> anyhow::Result<std::path::PathBuf> {
    let dir = data_dir.join("routines").join(r.id.to_string());
    std::fs::create_dir_all(&dir)?;
    let f = dir.join("settings.json");
    let deny: Vec<&str> = super::pipeline_run::DENY.to_vec();
    let slim = home.filter(|_| r.slim);
    std::fs::write(&f, routine::settings(&deny, &r.waits, slim).to_string())?;
    Ok(f)
}

/// The arguments a session starts with: its settings, its model and effort
/// when it has them -- on a resume too, so a run does not change model
/// halfway (S1) -- then the prompt or the answers as one argument after
/// `--`, never typed.
fn args_of(settings: &std::path::Path, begin: &Begin, r: &Routine) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Begin::Resume(session, _) = begin {
        args.extend(["--resume".into(), session.clone()]);
    }
    args.extend([
        "--permission-mode".into(),
        "auto".into(),
        "--settings".into(),
        settings.to_string_lossy().into_owned(),
    ]);
    if routine::MODELS.contains(&r.model.as_str()) && !r.model.is_empty() {
        args.extend(["--model".into(), r.model.clone()]);
    }
    if routine::EFFORTS.contains(&r.effort.as_str()) && !r.effort.is_empty() {
        args.extend(["--effort".into(), r.effort.clone()]);
    }
    args.push("--".into());
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
    let settings = settings_file(&app.paths.data_dir, r, dirs::home_dir().as_deref())?;
    let mut env = super::api_desk::pane_env(app, &placed).await.env;
    env.push(("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), "85".into()));
    // 1.66: its own state folder, as its watch and gate have it.
    let root = std::path::PathBuf::from(&desk.root);
    let rr = r.clone();
    let scripts = tokio::task::spawn_blocking(move || {
        routine::places::from_file(&root, &rr.file)
            .and_then(|p| routine::places::scripts(&p, &rr.cmd))
    })
    .await
    .ok()
    .flatten();
    let state = super::routine_gate::state_dir(&app.paths.data_dir, r, scripts.as_deref());
    env.push(("SNYVI_STATE".into(), state.to_string_lossy().into_owned()));
    process(app, &placed, "claude", &args_of(&settings, begin, r), &env).await
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
    let five = app
        .store
        .desk(r.desk_id)
        .ok()
        .flatten()
        .and_then(|d| five_now(app, &d));
    let _ = app.store.clocked(|c, now| {
        routine::ended(c, r.id, &state, &line, now)?;
        routine::five_after(c, r.id, five)
    });
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
                .clocked(|c, now| routine::skipped(c, r.id, "card", &format!("{e:#}"), now));
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
    for r in &all {
        if r.running_since == 0 && r.state() == "live" {
            event_run(app, r, now);
        }
    }
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
            let _ = start_with(&app, r.id, "answer", Some(begin), Wake::default()).await;
        });
    }
}

/// A live, idle routine whose watch's lines have waited out their batch
/// starts a run woken by them (1.63). Held a while after one that could
/// not start, so it is said once.
fn event_run(app: &Arc<App>, r: &Routine, now: i64) {
    let held = EVENT_HOLD
        .lock()
        .map(|h| h.get(&r.id).is_some_and(|until| *until > now))
        .unwrap_or(false);
    if held {
        return;
    }
    let ready = app
        .store
        .clocked(|c, now| events::ready(c, r.id, r.fast, now))
        .unwrap_or(false);
    if !ready || (!r.pane.is_empty() && app.panes.status(&r.pane).agent == "working") {
        return;
    }
    // Held at once, so the next tick does not start it twice while this
    // one is on its way; a start lets go of the hold.
    if let Ok(mut h) = EVENT_HOLD.lock() {
        h.insert(r.id, now + 30);
    }
    let (app, id) = (app.clone(), r.id);
    tokio::spawn(async move {
        let _ = start_with(&app, id, "event", None, Wake::default()).await;
    });
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
    if r.running == routine::SESSION
        && now - r.running_since >= START_S
        && unheard(&r.pane, r.running_since)
    {
        let why = app
            .store
            .clocked(|c, _| routine::last_why(c, r.id))
            .unwrap_or_default();
        end("didn't start: look at its panel".into());
        // A try is watched; any other start was not, so the reader is told.
        if why != "try" {
            card(
                app,
                r,
                &format!(
                    "Routine \"{}\" didn't start: its panel is waiting on something. Look at it in the desk's back.",
                    r.name
                ),
            );
        }
        return;
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
        let f = settings_file(&dir.path, &r, Some(&dir.path)).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let deny = v["permissions"]["deny"].as_array().unwrap();
        assert!(deny.iter().any(|x| x == "Bash(git push *)"));
        assert!(deny
            .iter()
            .any(|x| x == "Bash(python3 -I newsroom/publish.py *)"));
        assert!(f.ends_with("routines/4/settings.json"));
        assert!(v.get("claudeMdExcludes").is_none(), "everything, as before");
        // Slim: the reader's global CLAUDE.md is left out, nothing else.
        let slim = Routine { slim: true, ..r };
        let f = settings_file(&dir.path, &slim, Some(&dir.path)).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let home_md = dir.path.join(".claude").join("CLAUDE.md");
        assert_eq!(v["claudeMdExcludes"], json!([home_md.to_string_lossy()]));
    }

    #[test]
    fn answers_resume_the_runs_session_as_one_argument() {
        let f = std::path::Path::new("/d/routines/4/settings.json");
        let plain = Routine::default();
        let a = args_of(
            f,
            &Begin::Resume("abc".into(), "1. approve; 2. skip".into()),
            &plain,
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
        let a = args_of(
            f,
            &Begin::Prompt("/newsroom continue: approve".into()),
            &plain,
        );
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

    #[test]
    fn a_routines_model_and_effort_go_before_its_prompt_on_a_resume_too() {
        let f = std::path::Path::new("/d/s.json");
        let r = Routine {
            model: "haiku".into(),
            effort: "low".into(),
            ..Routine::default()
        };
        let a = args_of(f, &Begin::Resume("abc".into(), "yes".into()), &r);
        let at = |w: &str| a.iter().position(|x| x == w).unwrap();
        assert_eq!(a[at("--model") + 1], "haiku");
        assert_eq!(a[at("--effort") + 1], "low");
        assert!(at("--effort") < at("--"));
        assert_eq!(a.last().map(String::as_str), Some("yes"));
        // A value snyvi does not know is never passed.
        let odd = Routine {
            model: "--dangerously".into(),
            ..Routine::default()
        };
        assert!(!args_of(f, &Begin::Prompt("/x".into()), &odd).contains(&"--model".to_string()));
    }

    #[test]
    fn what_woke_a_run_is_said_once() {
        let w = Wake {
            words: "case".into(),
            gated: true,
            at: "09:30".into(),
        };
        assert_eq!(woke_words("clock", &w, &[]), "at its hour (09:30) · case");
        assert_eq!(
            woke_words(
                "event",
                &Wake::default(),
                &["tag 5304".into(), "tag 5311".into()]
            ),
            "tag 5304 ; tag 5311"
        );
        let t = Wake {
            words: "tag 5304".into(),
            ..Wake::default()
        };
        assert_eq!(woke_words("try", &t, &[]), "a try with words · tag 5304");
    }

    /// The clock and a watch's batch came due in one moment on the 1.63
    /// stage, and the second start stopped the first's panel: one start of
    /// a routine at a time.
    #[test]
    fn a_routine_starts_once_at_a_time() {
        let first = Starting::claim(-41).expect("free");
        assert!(Starting::claim(-41).is_none(), "taken while it starts");
        assert!(Starting::claim(-42).is_some(), "another routine is not");
        drop(first);
        assert!(Starting::claim(-41).is_some(), "let go when it is over");
    }
}
