//! A routine's times (1.63, plan d621276291 step 1): each hour it runs at,
//! with the words that hour adds to its prompt and whether its gate is asked
//! first ("Only if", C1). `every day 09:30 13:00` on one line of the sheet is
//! two rows here, so each has its own next.
//!
//! What it holds to:
//!
//! - **`routines.due_at` is the soonest of its times**, or 0 with none, and
//!   written with them; `due()` reads `due_at > 0`, so a draft with no when
//!   never rings.
//! - **One set of words a look** (R3). Nothing queues: the clock takes the
//!   earliest group of times past due that share their words, re-arms only
//!   those, and leaves the rest due for the next look after the run.
//! - **A time's words are the reader's**, written only by the sheet's Save
//!   behind the desk's gate; an offer may carry them and an offer never runs.

use crate::due::every::{every, Cadence, Every, Times};
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// A routine's hours at most, over all its lines.
pub const MAX: usize = 6;
/// The longest set of words a time adds to the prompt.
pub const WORDS_CHARS: usize = 60;

/// Migration 38 (1.63): times, events, and the trigger columns. Every
/// routine before it had one hour, `routines.every`, which becomes its
/// one time.
pub const TRIGGER_COLUMNS_1_63: &str = "
CREATE TABLE IF NOT EXISTS routine_times (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  every TEXT NOT NULL,
  words TEXT NOT NULL DEFAULT '',
  gated INTEGER NOT NULL DEFAULT 1,
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routine_times_of ON routine_times(routine_id, due_at);
INSERT INTO routine_times(routine_id, every, due_at)
  SELECT id, every, due_at FROM routines WHERE every != '';
CREATE TABLE IF NOT EXISTS routine_events (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  line TEXT NOT NULL,
  at INTEGER NOT NULL,
  run_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS routine_events_of ON routine_events(routine_id, run_id, at);
ALTER TABLE routines ADD COLUMN gate TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN watch TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN shape TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN effort TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN slim INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN woke TEXT NOT NULL DEFAULT '';
ALTER TABLE routine_runs ADD COLUMN five_before REAL NOT NULL DEFAULT -1;
ALTER TABLE routine_runs ADD COLUMN five_after REAL NOT NULL DEFAULT -1;
ALTER TABLE routine_runs ADD COLUMN woke TEXT NOT NULL DEFAULT '';";

/// One hour of a routine, as stored.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Time {
    pub id: i64,
    /// One cadence, one hour: `every mon 09:30`.
    pub every: String,
    pub words: String,
    pub gated: bool,
    pub due_at: i64,
}

/// One line of the sheet's When: a cadence, its hours, its words, its tick.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub times: Times,
    pub words: String,
    pub gated: bool,
}

/// A line as the sheet draws it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Said {
    pub every: String,
    pub words: String,
    pub gated: bool,
    /// The soonest next of its hours.
    pub next: i64,
}

/// A time's words, or `None`: one short line, no control characters, and
/// never a `/` first, which would read as a second command.
pub fn words_ok(w: &str) -> Option<String> {
    let w = w.trim();
    let bad =
        w.chars().count() > WORDS_CHARS || w.chars().any(char::is_control) || w.starts_with('/');
    (!bad).then(|| w.to_string())
}

/// A routine's times, in the order the sheet wrote them.
pub fn times_of(conn: &Connection, routine_id: i64) -> Result<Vec<Time>> {
    let mut st = conn.prepare_cached(
        "SELECT id, every, words, gated, due_at FROM routine_times WHERE routine_id = ?1 ORDER BY id",
    )?;
    let v = st
        .query_map(params![routine_id], |r| {
            Ok(Time {
                id: r.get(0)?,
                every: r.get(1)?,
                words: r.get(2)?,
                gated: r.get::<_, i64>(3)? != 0,
                due_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// A line being folded: its cadence, hours, words, tick and soonest next.
type Folding = (Cadence, Vec<(u8, u8)>, String, bool, i64);

/// The times folded back into the sheet's lines: neighbours with one
/// cadence, the same words and the same tick are one line of hours.
pub fn lines(times: &[Time]) -> Vec<Said> {
    let mut out: Vec<Folding> = Vec::new();
    for t in times {
        let Some(e) = every(&t.every) else { continue };
        match out.last_mut() {
            Some((c, at, w, g, next)) if *c == e.cadence && *w == t.words && *g == t.gated => {
                at.push(e.at);
                if t.due_at > 0 && (*next == 0 || t.due_at < *next) {
                    *next = t.due_at;
                }
            }
            _ => out.push((e.cadence, vec![e.at], t.words.clone(), t.gated, t.due_at)),
        }
    }
    out.into_iter()
        .map(|(cadence, mut at, words, gated, next)| {
            at.sort_unstable();
            Said {
                every: Times { cadence, at }.words(),
                words,
                gated,
                next,
            }
        })
        .collect()
}

/// What the rail says for the when: the first line, and how many more.
pub fn summary(times: &[Time]) -> String {
    let l = lines(times);
    match l.split_first() {
        None => String::new(),
        Some((first, [])) => first.every.clone(),
        Some((first, rest)) => format!("{} +{}", first.every, rest.len()),
    }
}

/// How many hours lines come to.
pub fn count(lines: &[Line]) -> usize {
    lines.iter().map(|l| l.times.at.len()).sum()
}

/// Write a routine's times whole, each hour armed from `now`, and the
/// routine's soonest and summary with them. The caller holds the
/// transaction, so the two never disagree. `None` past `MAX`.
pub fn set(conn: &Connection, routine_id: i64, lines: &[Line], now: i64) -> Result<Option<()>> {
    if count(lines) > MAX {
        return Ok(None);
    }
    conn.execute(
        "DELETE FROM routine_times WHERE routine_id = ?1",
        params![routine_id],
    )?;
    let mut st = conn.prepare_cached(
        "INSERT INTO routine_times(routine_id, every, words, gated, due_at) VALUES(?1, ?2, ?3, ?4, ?5)",
    )?;
    for l in lines {
        for e in l.times.each() {
            st.execute(params![
                routine_id,
                e.words(),
                l.words,
                l.gated as i64,
                e.next_after(now, crate::due::offset())
            ])?;
        }
    }
    sync(conn, routine_id)?;
    Ok(Some(()))
}

/// The routine's cached soonest and its said-once summary, read again
/// from its times.
pub fn sync(conn: &Connection, routine_id: i64) -> Result<()> {
    let times = times_of(conn, routine_id)?;
    let due = times
        .iter()
        .map(|t| t.due_at)
        .filter(|d| *d > 0)
        .min()
        .unwrap_or(0);
    conn.execute(
        "UPDATE routines SET due_at = ?2, every = ?3 WHERE id = ?1",
        params![routine_id, due, summary(&times)],
    )?;
    Ok(())
}

fn next_of(t: &Time, now: i64) -> i64 {
    every(&t.every).map_or(now + 86_400, |e: Every| {
        e.next_after(now, crate::due::offset())
    })
}

/// Every time armed again from `now`: Start, Resume, Restore, and a closed
/// desk's hours passed by. A routine paused a week does not ring for the
/// days it missed.
pub fn rearm_all(conn: &Connection, routine_id: i64, now: i64) -> Result<()> {
    for t in times_of(conn, routine_id)? {
        conn.execute(
            "UPDATE routine_times SET due_at = ?2 WHERE id = ?1",
            params![t.id, next_of(&t, now)],
        )?;
    }
    sync(conn, routine_id)
}

/// The times that rang together: one set of words, and whether its gate
/// is asked first.
#[derive(Clone, Debug, PartialEq)]
pub struct Fired {
    pub ids: Vec<i64>,
    pub words: String,
    pub gated: bool,
    /// The earliest of them: how late the run is, from here.
    pub due_at: i64,
    /// Its hour, as the brief says it: `13:00`.
    pub at: String,
}

/// The clock's pick for a routine (R3): the earliest time past due, and
/// every other past due with its words and its tick. `None` when none is.
pub fn fired(conn: &Connection, routine_id: i64, now: i64) -> Result<Option<Fired>> {
    let past: Vec<Time> = times_of(conn, routine_id)?
        .into_iter()
        .filter(|t| t.due_at > 0 && t.due_at <= now)
        .collect();
    let Some(first) = past.iter().min_by_key(|t| (t.due_at, t.id)) else {
        return Ok(None);
    };
    let same: Vec<&Time> = past
        .iter()
        .filter(|t| t.words == first.words && t.gated == first.gated)
        .collect();
    let at = every(&first.every)
        .map(|e| format!("{:02}:{:02}", e.at.0, e.at.1))
        .unwrap_or_default();
    Ok(Some(Fired {
        ids: same.iter().map(|t| t.id).collect(),
        words: first.words.clone(),
        gated: first.gated,
        due_at: first.due_at,
        at,
    }))
}

/// The times that rang, each set to its next before the run starts, so one
/// that fails to start never rings twice. The others keep their hour.
pub fn rearm_fired(conn: &Connection, routine_id: i64, f: &Fired, now: i64) -> Result<()> {
    for t in times_of(conn, routine_id)? {
        if f.ids.contains(&t.id) {
            conn.execute(
                "UPDATE routine_times SET due_at = ?2 WHERE id = ?1",
                params![t.id, next_of(&t, now)],
            )?;
        }
    }
    sync(conn, routine_id)
}
