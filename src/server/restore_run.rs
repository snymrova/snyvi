//! 1.58: bringing the conversations back after a crash, or any stop
//! (plan 4b492bec68, rev 2 0d2cbfff44).
//!
//! On 6 Nov the OOM killer took the session with 31 conversations open on
//! 20 desks, and none were offered back: a crash wrote no marks. Now an
//! agent in a panel leaves a live mark (`desk::marks`), the start after a
//! crash reads what is left as offers, and this is what brings them back.
//!
//! What it holds to:
//!
//! - **Only a click starts anything.** The queue holds what a window holding
//!   the capability named -- Restore all, a desk's Resume, the ticks in
//!   Choose… -- and only panes this start found on offer. Nothing at daemon
//!   start, nothing on a timer: `api_desk::start_pane`'s premise, with this
//!   its one other click-started path, as routines are.
//! - **Two at a time, fewer when memory is short.** Thirty `claude --resume`
//!   at once is how the session was lost. `pressure` reads the kernel's
//!   memory pressure where there is one, and waits at the top of it.
//! - **A start keeps its slot until the agent is in.** Or the process ends,
//!   or `SLOT_AT_MOST`: one stuck at a prompt -- a trust dialog, a sign-in
//!   -- goes on starting, and stops holding up the rest.
//! - **What the reader is using is left alone.** A panel running anything
//!   but the shell its offer came back as has been answered, and is not
//!   stopped; that shell is, once it has been quiet a moment.

use super::*;
use crate::pane::Mark;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::Duration;

/// How many conversations start at once, when memory allows.
const AT_ONCE: usize = 2;
/// How long one start holds its slot without its agent reporting.
const SLOT_AT_MOST: Duration = Duration::from_secs(120);
/// How often the queue looks again.
const TICK: Duration = Duration::from_secs(1);
/// A shell on offer printed this recently is in use: wait for it.
const AT_REST: Duration = Duration::from_secs(2);
/// And at most this long, before it is left as it is.
const REST_AT_MOST: Duration = Duration::from_secs(60);

/// The offers this start found, and a restore under way. One per daemon.
#[derive(Default)]
pub(crate) struct Restore(std::sync::Mutex<State>);

#[derive(Default)]
struct State {
    /// pane → where it is: the offers not yet answered.
    found: BTreeMap<String, Found>,
    /// The bar's ✕: hidden until the next start.
    hidden: bool,
    /// Whether a window has been shown the offers (`seen`).
    seen: bool,
    queue: VecDeque<String>,
    /// pane → when its start went, while it holds a slot.
    flight: HashMap<String, Instant>,
    /// pane → since when its shell has been in use, while the queue waits.
    waiting: HashMap<String, Instant>,
    /// This run's count: how many were asked for, how many are back.
    total: usize,
    back: usize,
    /// One worker at a time.
    running: bool,
}

#[derive(Clone, Copy)]
struct Found {
    desk: i64,
    slot: i64,
    crashed: bool,
}

impl Restore {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap()
    }
}

/// From the daemon's start, before any pane can: the marks' sink, the
/// offers this start found, and the clock that lets them go.
pub(crate) fn start(app: &Arc<App>, marks: &crate::desk::ResumeMarks) {
    follow(app);
    {
        let mut s = app.restore.lock();
        for id in &marks.offered {
            let Ok(Some(p)) = app.store.pane(id) else {
                continue;
            };
            let crashed = marks.crashed.contains(id);
            s.found.insert(
                id.clone(),
                Found {
                    desk: p.desk_id,
                    slot: p.pane.slot,
                    crashed,
                },
            );
        }
    }
    let app = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(crate::pane::MARKS_AT_MOST).await;
        let _ = app.store.lapse_pane_offers();
        app.restore.lock().found.clear();
        told(&app);
    });
}

/// Each panel's mark, as its pane says it changed, written to the store --
/// and the queue told, so an agent that is in frees its slot.
fn follow(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    app.panes.on_mark(Box::new(move |id, mark| {
        let Some(app) = weak.upgrade() else { return };
        let _ = match mark {
            Mark::AgentIn => app.store.set_pane_live(id, true),
            Mark::AgentOut => app.store.set_pane_live(id, false),
            Mark::Spent => app.store.spend_pane_mark(id),
        };
        heard(&app, id, mark);
    }));
}

/// The queue's side of a mark. An agent in answers the offer, and is one
/// back if the queue started it; a start of any other kind answers it too.
fn heard(app: &App, id: &str, mark: Mark) {
    let changed = {
        let mut s = app.restore.lock();
        match mark {
            Mark::AgentIn => {
                let flew = s.flight.remove(id).is_some();
                s.back += usize::from(flew);
                let had = s.found.remove(id).is_some();
                s.queue.retain(|q| q != id);
                flew || had
            }
            Mark::Spent => s.found.remove(id).is_some(),
            Mark::AgentOut => false,
        }
    };
    if changed {
        told(app);
    }
}

/// A window has shown the offers: from here they lapse at the second start
/// after this one (`desk::age_offers`). Once per daemon.
pub(crate) fn seen(app: &App) {
    {
        let mut s = app.restore.lock();
        if s.seen || s.found.is_empty() {
            return;
        }
        s.seen = true;
    }
    let _ = app.store.age_pane_offers();
}

/// What Home and the desks read: what is on offer, by desk, and the run
/// under way. `panes` names each one, for Choose…: one store read each,
/// only when asked.
pub(crate) fn json(app: &App, panes: bool) -> Value {
    let (found, mut out) = {
        let s = app.restore.lock();
        let mut desks: BTreeMap<String, usize> = BTreeMap::new();
        for f in s.found.values() {
            *desks.entry(f.desk.to_string()).or_default() += 1;
        }
        let out = json!({
            "left": s.found.len(),
            "crashed": s.found.values().any(|f| f.crashed),
            "hidden": s.hidden,
            "desks": desks,
            "total": s.total,
            "back": s.back,
            "queued": s.queue.len() + s.flight.len(),
        });
        let found: Vec<(String, Found)> = if panes {
            s.found.iter().map(|(k, v)| (k.clone(), *v)).collect()
        } else {
            Vec::new()
        };
        (found, out)
    };
    if panes {
        let named: Vec<Value> = found
            .into_iter()
            .filter_map(|(id, f)| {
                let p = app.store.pane(&id).ok().flatten()?;
                Some(json!({
                    "id": id, "desk": f.desk, "desk_name": p.desk_name,
                    "slot": f.slot, "name": p.pane.name, "crashed": f.crashed,
                }))
            })
            .collect();
        out["panes"] = json!(named);
    }
    out
}

/// For Home's payload: the block, when anything is on offer. Showing it
/// is a window seeing the offers.
pub(crate) fn for_home(app: &App) -> Option<Value> {
    let j = json(app, false);
    if j["left"].as_u64().unwrap_or(0) == 0 && j["queued"].as_u64().unwrap_or(0) == 0 {
        return None;
    }
    seen(app);
    Some(j)
}

/// How many conversations are on offer on one desk, for its head.
pub(crate) fn offers_on(app: &App, desk: i64) -> usize {
    app.restore
        .lock()
        .found
        .values()
        .filter(|f| f.desk == desk)
        .count()
}

/// The bar's ✕: it stays hidden until the next start. The offers stand.
pub(crate) fn hide(app: &App) {
    app.restore.lock().hidden = true;
    told(app);
}

/// Stop: the queue is emptied, and the starts under way finish.
pub(crate) fn stop(app: &App) {
    {
        let mut s = app.restore.lock();
        s.queue.clear();
        s.waiting.clear();
        s.total = s.back + s.flight.len();
    }
    told(app);
}

/// Queue the panes named, of the ones on offer: the desk the reader is on
/// first, then by desk and slot. How many were queued.
pub(crate) fn enqueue(app: &Arc<App>, ids: &[String], first: Option<i64>) -> usize {
    let (n, go) = {
        let mut s = app.restore.lock();
        let mut fresh: Vec<(String, Found)> = ids
            .iter()
            .filter(|id| !s.queue.contains(*id) && !s.flight.contains_key(*id))
            .filter_map(|id| s.found.get(id).map(|f| (id.clone(), *f)))
            .collect();
        fresh.sort_by_key(|(_, f)| (Some(f.desk) != first, f.desk, f.slot));
        fresh.dedup_by(|a, b| a.0 == b.0);
        let n = fresh.len();
        // A new run counts afresh; one under way counts these in.
        if s.flight.is_empty() && s.queue.is_empty() {
            s.total = 0;
            s.back = 0;
        }
        s.total += n;
        s.queue.extend(fresh.into_iter().map(|(id, _)| id));
        let go = n > 0 && !s.running;
        s.running |= go;
        (n, go)
    };
    if go {
        tokio::spawn(work(app.clone()));
    }
    told(app);
    n
}

/// The ids on offer on one desk, or on all of them.
pub(crate) fn on_offer(app: &App, desk: Option<i64>) -> Vec<String> {
    app.restore
        .lock()
        .found
        .iter()
        .filter(|(_, f)| desk.is_none_or(|d| f.desk == d))
        .map(|(id, _)| id.clone())
        .collect()
}

/// The worker: start what is queued as slots free, until nothing is.
async fn work(app: Arc<App>) {
    loop {
        settle_flights(&app);
        let width = pressure();
        let next: Vec<String> = {
            let mut s = app.restore.lock();
            if s.queue.is_empty() && s.flight.is_empty() {
                s.running = false;
                s.waiting.clear();
                drop(s);
                told(&app);
                return;
            }
            let room = width.saturating_sub(s.flight.len());
            let take = room.min(s.queue.len());
            s.queue.drain(..take).collect()
        };
        for id in next {
            match start_one(&app, &id).await {
                Ok(Started::Yes) => {
                    app.restore.lock().flight.insert(id, Instant::now());
                }
                Ok(Started::Later) => app.restore.lock().queue.push_back(id),
                Ok(Started::No(why)) => drop_one(&app, &id, why),
                Err(e) => drop_one(&app, &id, &format!("{e:#}")),
            }
            told(&app);
        }
        tokio::time::sleep(TICK).await;
    }
}

/// A start that holds its slot no longer: its process ended, or it has had
/// `SLOT_AT_MOST`. Asked of the panes outside the queue's lock.
fn settle_flights(app: &App) {
    let flying: Vec<(String, Instant)> = app
        .restore
        .lock()
        .flight
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let over: Vec<String> = flying
        .into_iter()
        .filter(|(id, at)| at.elapsed() >= SLOT_AT_MOST || !app.panes.is_running(id))
        .map(|(id, _)| id)
        .collect();
    if over.is_empty() {
        return;
    }
    let mut s = app.restore.lock();
    for id in over {
        s.flight.remove(&id);
    }
}

fn drop_one(app: &App, id: &str, why: &str) {
    eprintln!("snyvi: restore: panel {} left as it is: {why}", &id[..id.len().min(8)]);
    let mut s = app.restore.lock();
    s.found.remove(id);
    s.waiting.remove(id);
    s.total = s.total.saturating_sub(1);
}

enum Started {
    Yes,
    /// Its shell is in use: ask again on a later tick.
    Later,
    No(&'static str),
}

/// Start one panel as its conversation, the way the reader's Start does
/// (`api_desk::start_pane`): in the folder its shell was last in, with the
/// desk's keys and its account, the command built from its kept session.
async fn start_one(app: &Arc<App>, id: &str) -> anyhow::Result<Started> {
    let Some(placed) = app.store.pane(id)? else {
        return Ok(Started::No("its panel is closed"));
    };
    if placed.pane.held {
        return Ok(Started::No("it waits for Start"));
    }
    if placed.pane.resume.is_empty() {
        return Ok(Started::No("it has no conversation to resume"));
    }
    let st = app.panes.status(id);
    if st.agent_in {
        return Ok(Started::No("Claude is in it already"));
    }
    if st.running {
        // Only the shell its offer came back as is stopped, and only once
        // it is at rest; anything else running there is the reader's.
        if !st.offer {
            return Ok(Started::No("something else runs there"));
        }
        let quiet = app.panes.quiet_for(id).unwrap_or(Duration::MAX);
        if quiet < AT_REST {
            let since = *app
                .restore
                .lock()
                .waiting
                .entry(id.to_string())
                .or_insert_with(Instant::now);
            if since.elapsed() >= REST_AT_MOST {
                return Ok(Started::No("its shell is in use"));
            }
            return Ok(Started::Later);
        }
        super::routine_run::stop_then(app, id).await?;
    }
    let cwd = if std::path::Path::new(&placed.pane.cwd).is_dir() {
        placed.pane.cwd.as_str()
    } else {
        placed.root.as_str()
    };
    let super::api_desk::PaneEnv { env, account, .. } =
        super::api_desk::pane_env(app, &placed).await;
    let live = app.panes.get(id);
    let (cols, rows) = live.size();
    live.start(
        crate::pane::Start {
            cwd,
            root: &placed.root,
            cmd: &placed.pane.resume,
            args: &[],
            desk: &placed.desk_name,
            slot: placed.pane.slot,
            cols,
            rows,
            accent: "",
            offer: false,
            env: &env,
            account,
            back: crate::desk::in_back(placed.pane.slot),
        },
        &app.panes,
    )?;
    Ok(Started::Yes)
}

/// How many may start at once now: `AT_ONCE`, one when memory is under
/// pressure, none (wait) when it is under a lot. Linux says, in
/// `/proc/pressure/memory`; anywhere it cannot be read, `AT_ONCE`.
fn pressure() -> usize {
    #[cfg(target_os = "linux")]
    {
        if let Ok(t) = std::fs::read_to_string("/proc/pressure/memory") {
            return width_at(&t);
        }
    }
    AT_ONCE
}

/// The rule on its own, so it can be tested without a kernel: the share of
/// the last ten seconds some task waited on memory (`some avg10=`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn width_at(psi: &str) -> usize {
    let avg10 = psi
        .lines()
        .find(|l| l.starts_with("some "))
        .and_then(|l| l.split_whitespace().find_map(|w| w.strip_prefix("avg10=")))
        .and_then(|v| v.parse::<f64>().ok());
    match avg10 {
        Some(p) if p >= 30.0 => 0,
        Some(p) if p >= 10.0 => 1,
        _ => AT_ONCE,
    }
}

/// The `restore` event, for Home's line and the desks' strips: the counts,
/// and how many are left on each desk.
fn told(app: &App) {
    let s = app.restore.lock();
    let mut desks: BTreeMap<String, usize> = BTreeMap::new();
    for f in s.found.values() {
        *desks.entry(f.desk.to_string()).or_default() += 1;
    }
    let ev = json!({
        "desks": desks,
        "left": s.found.len(),
        "back": s.back,
        "total": s.total,
        "queued": s.queue.len() + s.flight.len(),
        "hidden": s.hidden,
    });
    drop(s);
    emit(app, "restore", ev);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_pressure_narrows_the_queue_and_then_holds_it() {
        let psi = |p: &str| {
            format!(
                "some avg10={p} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
            )
        };
        assert_eq!(width_at(&psi("0.00")), 2);
        assert_eq!(width_at(&psi("9.99")), 2);
        assert_eq!(width_at(&psi("10.00")), 1);
        assert_eq!(width_at(&psi("45.20")), 0);
        assert_eq!(width_at("garbage"), 2, "a read it cannot parse is no pressure");
    }
}
