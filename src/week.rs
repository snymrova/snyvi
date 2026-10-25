//! Your week (1.48): on Sunday at 20:00, Home opens one box above Pick up
//! with what shipped, what was told and where, what waited on the reader,
//! three numbers from the store, and three fields -- next week I ship, I
//! tell, I drop -- that become dated lines. Until Tuesday 06:00, then it is
//! gone till the next Sunday; Hide turns it off for good, Not this week for
//! the one. One box, never a nag (usage audit 63cc69c8c1, P5).
//!
//! Worked out when Home reads it, from the clock and one row, so a restart
//! or a window shut on Sunday changes nothing: there is no moment to miss.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use time::{Duration, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

/// 1.48's state for Home's week, one row: the Sunday it was put away for
/// (Not this week, or filed), off for good, and the ship line it filed, which
/// the brief says on that desk. With it the desks' week for the reopen rule
/// (`crate::reopen`). Version 29 of `store::MIGRATIONS`.
pub const COLUMNS_1_48: &str = "CREATE TABLE IF NOT EXISTS home_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  week_skip INTEGER NOT NULL DEFAULT 0,
  week_off INTEGER NOT NULL DEFAULT 0,
  week_note INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO home_state(id) VALUES(1);
ALTER TABLE desks ADD COLUMN rule_asked_at INTEGER NOT NULL DEFAULT 0;";

/// From Sunday 20:00 to Tuesday 06:00: a window shut on Sunday evening
/// sees the box on Monday morning.
pub const SHOWN_S: i64 = 34 * 3600;

/// The latest Sunday 20:00 at or before `now`, in the reader's time.
pub fn sunday(now: i64) -> i64 {
    sunday_at(now, crate::due::offset())
}

pub fn sunday_at(now: i64, off: UtcOffset) -> i64 {
    let Ok(t) = OffsetDateTime::from_unix_timestamp(now) else {
        return now;
    };
    let t = t.to_offset(off);
    let back = t.weekday().number_days_from_sunday() as i64;
    let at = |d| {
        PrimitiveDateTime::new(d, Time::from_hms(20, 0, 0).unwrap_or(Time::MIDNIGHT))
            .assume_offset(off)
            .unix_timestamp()
    };
    let s = at(t.date() - Duration::days(back));
    if s <= now {
        s
    } else {
        at(t.date() - Duration::days(back + 7))
    }
}

/// A thread the week shipped, told or not.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Shipped {
    pub desk: i64,
    pub thread: i64,
    pub name: String,
    pub at: i64,
    pub told_at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub told_url: String,
}

/// A field's prefill: the text and where it goes.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Pick {
    pub desk: i64,
    pub thread: i64,
    pub text: String,
}

/// Three figures from rows snyvi keeps anyway, recomputed every read.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Numbers {
    /// Lines ticked this week whose thread raised no card on the reader.
    pub without_you: i64,
    pub ticked: i64,
    /// The median from a line written to its tick, in seconds; 0 for none.
    pub median_s: i64,
    /// Threads told and threads shipped in the last thirty days.
    pub told: i64,
    pub shipped: i64,
    /// The sessions the desks' routines ran this week, and the cards they
    /// raised (1.50, `crate::routine::week`).
    pub routine_runs: i64,
    pub routine_waits: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Week {
    /// The Sunday 20:00 it is for.
    pub at: i64,
    pub shipped: Vec<Shipped>,
    /// How many things wait on the reader (`crate::waiting::rows`).
    pub waited: usize,
    pub ship: Option<Pick>,
    pub tell: Option<Pick>,
    pub drop: Option<Pick>,
    pub numbers: Numbers,
}

/// The week, while its box is open: `None` outside Sunday 20:00 to Tuesday
/// 06:00, when it is off, or when this Sunday's was put away.
/// The clock the box is read by. A review on a weekday sees Sunday's box:
/// debug builds only, never a release (`SNYVI_WEEK_NOW`, a unix time).
fn clock(now: i64) -> i64 {
    #[cfg(debug_assertions)]
    if let Some(t) = std::env::var("SNYVI_WEEK_NOW")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return t;
    }
    now
}

pub fn week(conn: &Connection, now: i64) -> Result<Option<Week>> {
    let now = clock(now);
    let s = sunday(now);
    let (skip, off): (i64, i64) = conn
        .query_row(
            "SELECT week_skip, week_off FROM home_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, 0));
    if off != 0 || skip >= s || now >= s + SHOWN_S {
        return Ok(None);
    }
    Ok(Some(read(conn, s, now)?))
}

/// What the box says for the week to Sunday `s`.
pub fn read(conn: &Connection, s: i64, now: i64) -> Result<Week> {
    let from = s - 7 * 86_400;
    let shipped: Vec<Shipped> = conn
        .prepare(
            "SELECT t.desk_id, t.id, t.name, t.shipped_at, t.told_at, t.told_url FROM threads t
             JOIN desks d ON d.id = t.desk_id
             WHERE t.removed_at = 0 AND d.closed_at = 0 AND t.stage = 'shipped' AND t.shipped_at >= ?1
             ORDER BY t.shipped_at LIMIT 12",
        )?
        .query_map(params![from], |r| {
            Ok(Shipped {
                desk: r.get(0)?,
                thread: r.get(1)?,
                name: r.get(2)?,
                at: r.get(3)?,
                told_at: r.get(4)?,
                told_url: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let pick = |sql: &str, arg: i64| -> Result<Option<Pick>> {
        Ok(conn
            .query_row(sql, params![arg], |r| {
                Ok(Pick {
                    desk: r.get(0)?,
                    thread: r.get(1)?,
                    text: r.get(2)?,
                })
            })
            .optional()?)
    };
    let ship = pick(
        "SELECT t.desk_id, t.id, t.name FROM threads t JOIN desks d ON d.id = t.desk_id
         WHERE t.removed_at = 0 AND d.closed_at = 0 AND d.parked_at = 0 AND t.stage IN ('review', 'waiting')
           AND t.moved_at <= ?1 ORDER BY t.moved_at LIMIT 1",
        now,
    )?;
    let tell = pick(
        "SELECT t.desk_id, t.id, t.name FROM threads t JOIN desks d ON d.id = t.desk_id
         WHERE t.removed_at = 0 AND d.closed_at = 0 AND t.stage = 'shipped' AND t.merged_at != 0
           AND t.told_at = 0 AND t.ask_told_at > 1 AND t.shipped_at <= ?1 ORDER BY t.shipped_at LIMIT 1",
        now,
    )?;
    let drop = pick(
        "SELECT id, 0, left_off FROM desks WHERE closed_at = 0 AND parked_at = 0 AND left_off != ''
           AND left_off_needs = 'you' AND left_off_at <= ?1 ORDER BY left_off_at LIMIT 1",
        now - 14 * 86_400,
    )?;
    Ok(Week {
        at: s,
        shipped,
        waited: crate::waiting::rows(conn, now)?.len(),
        ship,
        tell,
        drop,
        numbers: numbers(conn, from, now)?,
    })
}

/// The three figures, for the week from `from`.
pub fn numbers(conn: &Connection, from: i64, now: i64) -> Result<Numbers> {
    let (ticked, without_you): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(n.done_by != '' AND NOT EXISTS (
             SELECT 1 FROM turns t WHERE t.desk_id = n.desk_id AND n.thread_id != 0 AND t.thread_id = n.thread_id
               AND t.kind NOT IN ('due', 'tell') AND t.created_at BETWEEN n.created_at AND n.done_at)), 0)
         FROM desk_notes n WHERE n.done_at >= ?1 AND n.removed_at = 0 AND n.suggested_by = ''",
        params![from],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut spans: Vec<i64> = conn
        .prepare(
            "SELECT done_at - created_at FROM desk_notes WHERE done_at >= ?1 AND removed_at = 0
               AND suggested_by = '' AND done_at >= created_at",
        )?
        .query_map(params![from], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    spans.sort_unstable();
    let median_s = if spans.is_empty() {
        0
    } else {
        spans[spans.len() / 2]
    };
    let (told, shipped): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(told_at >= ?1 AND told_how != 'none'), 0), COALESCE(SUM(stage = 'shipped' AND shipped_at >= ?1), 0)
         FROM threads WHERE removed_at = 0",
        params![now - 30 * 86_400],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    // A database from before 1.50's tables has no routines to count.
    let (routine_runs, routine_waits) = crate::routine::week(conn, from).unwrap_or((0, 0));
    Ok(Numbers {
        without_you,
        ticked,
        median_s,
        told,
        shipped,
        routine_runs,
        routine_waits,
    })
}

/// One of the three fields, as the reader left it.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct Field {
    pub text: String,
    pub desk: i64,
    pub thread: i64,
}

/// What filing the week writes: the ship line by Friday 17:00, the tell
/// line by Monday 10:00, each on its desk and in its thread. The ids
/// written. The box is put away for this Sunday either way.
pub fn file(
    conn: &Connection,
    ship: Option<&Field>,
    tell: Option<&Field>,
    now: i64,
) -> Result<Vec<i64>> {
    let mut ids = Vec::new();
    for (f, when, is_ship) in [(ship, "fri 17", true), (tell, "mon 10", false)] {
        let Some(f) = f.filter(|f| !f.text.trim().is_empty() && f.desk > 0) else {
            continue;
        };
        let open: bool = conn
            .query_row(
                "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
                params![f.desk],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !open {
            continue;
        }
        let text: String = f.text.trim().chars().take(200).collect();
        let due_at = crate::due::parse(when, now).unwrap_or(0);
        conn.execute(
            "INSERT INTO desk_notes(desk_id, text, created_at, due_at, thread_id) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![f.desk, text, now, due_at, f.thread.max(0)],
        )?;
        let id = conn.last_insert_rowid();
        if is_ship {
            conn.execute(
                "UPDATE home_state SET week_note = ?1 WHERE id = 1",
                params![id],
            )?;
        }
        ids.push(id);
    }
    skip(conn, now)?;
    Ok(ids)
}

/// Not this week: the box is put away until next Sunday.
pub fn skip(conn: &Connection, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE home_state SET week_skip = ?1 WHERE id = 1",
        params![sunday(clock(now))],
    )?;
    Ok(())
}

/// Hide, for good; or back, with `off` false.
pub fn set_off(conn: &Connection, off: bool) -> Result<()> {
    conn.execute(
        "UPDATE home_state SET week_off = ?1 WHERE id = 1",
        params![off as i64],
    )?;
    Ok(())
}

/// The ship line the reader filed on Sunday, for the brief on its desk:
/// while it is open and not a week old.
pub fn ship_line(conn: &Connection, desk_id: i64, now: i64) -> Result<Option<(String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT n.text, n.due_at FROM home_state h JOIN desk_notes n ON n.id = h.week_note
             WHERE h.id = 1 AND n.desk_id = ?1 AND n.done_at = 0 AND n.removed_at = 0 AND n.created_at >= ?2",
            params![desk_id, now - 8 * 86_400],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

// --- a reopen becomes a rule ----------------------------------------------

/// Words too common to be what two reopened lines share.
const PLAIN: [&str; 24] = [
    "still", "that", "this", "with", "when", "doesnt", "does", "dont", "there", "they", "from",
    "have", "just", "into", "only", "then", "than", "work", "works", "working", "broken", "again",
    "after", "should",
];

/// Two lines reopened on one desk within a week: snyvi suggests one line of
/// its own, "Before ticking: ...", with the word both reasons share -- once
/// per desk per week, and only a suggestion the reader keeps or not. Called
/// on the reopen; the id written, if one was.
pub fn reopen_rule(conn: &mut Connection, desk_id: i64, now: i64) -> Result<Option<i64>> {
    let asked: i64 = conn
        .query_row(
            "SELECT rule_asked_at FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(now);
    if asked > now - 7 * 86_400 {
        return Ok(None);
    }
    let reopened: Vec<(i64, String)> = conn
        .prepare(
            "SELECT id, reply FROM desk_notes WHERE desk_id = ?1 AND stage = 'reopened' AND stage_at >= ?2
               AND removed_at = 0 AND done_at = 0 ORDER BY stage_at DESC LIMIT 2",
        )?
        .query_map(params![desk_id, now - 7 * 86_400], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if reopened.len() < 2 {
        return Ok(None);
    }
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .map(str::to_lowercase)
            .filter(|w| w.chars().count() >= 4 && !PLAIN.contains(&w.as_str()))
            .collect()
    };
    let b = words(&reopened[1].1);
    let shared = words(&reopened[0].1).into_iter().find(|w| b.contains(w));
    let text = match shared {
        Some(w) => format!(
            "Before ticking: check {w} (#{} and #{} came back for it)",
            reopened[1].0, reopened[0].0
        ),
        None => format!(
            "Before ticking: try it as #{} and #{} were reopened",
            reopened[1].0, reopened[0].0
        ),
    };
    conn.execute(
        "UPDATE desks SET rule_asked_at = ?2 WHERE id = ?1",
        params![desk_id, now],
    )?;
    Ok(
        match crate::desk::suggest_note(conn, desk_id, &text, "snyvi", now)? {
            crate::desk::Suggested::Note(n) => Some(n.id),
            _ => None,
        },
    )
}

#[cfg(test)]
mod tests;
