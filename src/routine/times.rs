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

/// A routine's hours at most, over all its lines. 1.66: twelve, since one
/// routine now holds every time its copies had (`pro-forum` ran at six
/// hours a day and two more a week, as thirteen rows).
pub const MAX: usize = 12;
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

/// A routine's `when` in one line (1.66, plan e7fda1ca90), as an agent
/// writes it for `offer_routine`:
///
/// `every day 09:30 13:00 17:30; sun 20:00 news; on watch fast`
///
/// Lines split at `;`. A line is a cadence and its hours (`every` may be
/// left out: `sun 20:00`), then the words that hour adds to the prompt
/// (`news`), and `always` last when the gate is not asked at that hour.
/// `on watch` turns the watch on, `on watch fast` with ten-second batches
/// and thirty runs an hour (`events::pace`). Two ways to say times -- a
/// cadence with several hours, and a `times` list -- were why three of nine
/// jobs became one routine per hour.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct When {
    pub lines: Vec<Line>,
    pub watch: bool,
    pub fast: bool,
}

/// `when` read, or what to write instead, in words an agent can act on.
pub fn when(text: &str) -> std::result::Result<When, String> {
    let mut w = When::default();
    for seg in text.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let low = seg.to_lowercase();
        let low: Vec<&str> = low.split_whitespace().collect();
        match low.as_slice() {
            ["on", "watch"] | ["watch"] => {
                w.watch = true;
                continue;
            }
            ["on", "watch", "fast"] | ["watch", "fast"] => {
                w.watch = true;
                w.fast = true;
                continue;
            }
            _ => {}
        }
        w.lines.push(when_line(seg)?);
    }
    if w.lines.is_empty() && !w.watch {
        return Err("`when` is empty: write it like `every day 09:00`, `mon 07:00; thu 07:00` or `on watch`".into());
    }
    if count(&w.lines) > MAX {
        return Err(format!(
            "`when` names more than {MAX} hours: one routine holds {MAX} at most"
        ));
    }
    Ok(w)
}

fn when_line(seg: &str) -> std::result::Result<Line, String> {
    let mut toks: Vec<&str> = seg.split_whitespace().collect();
    let gated = match toks.last() {
        Some(l) if l.eq_ignore_ascii_case("always") => {
            toks.pop();
            false
        }
        _ => true,
    };
    let first = toks.first().map(|t| t.to_lowercase()).unwrap_or_default();
    let lead = if matches!(first.as_str(), "every" | "daily" | "weekdays") {
        String::new()
    } else {
        "every ".to_string()
    };
    let bad = || {
        format!("`{seg}` is not a time: write it like `every day 09:00`, `weekdays 08:30`, `mon 07:00 news` or `1st 10:00`")
    };
    for j in (1..=toks.len()).rev() {
        let Some(times) = crate::due::every::every_times(&format!("{lead}{}", toks[..j].join(" ")))
        else {
            continue;
        };
        let words = toks[j..].join(" ");
        let Some(words) = words_ok(&words) else {
            return Err(format!(
                "`{words}` after the hours is too long: a time's words are at most {WORDS_CHARS} characters and never start with /"
            ));
        };
        return Ok(Line {
            times,
            words,
            gated,
        });
    }
    Err(bad())
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

#[cfg(test)]
mod when_tests {
    use super::*;
    use crate::due::every::Cadence;

    #[test]
    fn one_line_says_every_time() {
        let w = when("every day 09:30 13:00 17:30 21:30; sun 20:00 news; mon 09:30 case always; on watch fast").unwrap();
        assert!(w.watch && w.fast);
        assert_eq!(w.lines.len(), 3);
        assert_eq!(w.lines[0].times.cadence, Cadence::Daily);
        assert_eq!(
            w.lines[0].times.at,
            vec![(9, 30), (13, 0), (17, 30), (21, 30)]
        );
        assert_eq!(w.lines[0].words, "");
        assert_eq!(w.lines[1].words, "news");
        assert!(w.lines[1].gated);
        assert_eq!(w.lines[2].words, "case");
        assert!(!w.lines[2].gated);
        assert_eq!(count(&w.lines), 6);
    }

    #[test]
    fn a_watch_alone_is_a_when_and_nonsense_says_what_to_write() {
        let w = when("on watch").unwrap();
        assert!(w.watch && !w.fast && w.lines.is_empty());
        assert!(when("").unwrap_err().contains("every day 09:00"));
        assert!(when("whenever it rains")
            .unwrap_err()
            .contains("is not a time"));
        let many = "every day 1 2 3 4 5 6; every day 7 8 9 10 11 12; sun 13";
        assert!(when(many).unwrap_err().contains("12 at most"));
    }
}
