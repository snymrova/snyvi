//! News (1.66, plan e7fda1ca90): what happened that the reader may want to
//! know, and nothing they must answer. On you was one list with one count,
//! and a merge's tick, a routine's reworded command and a card an agent
//! took back sat beside a question an agent was stuck on, counted the same
//! (rethink e36434e663). News has no count and blocks nothing: read or not,
//! and Undo where an agent's change can be taken back.
//!
//! What it holds to:
//!
//! - **An agent's change the reader did not press is said here**, so nothing
//!   changes silently: a routine's words, its times or model, a card it took
//!   back, copies of a routine folded into one.
//! - **Undo is the change's own**, kept with it as JSON (`undo`) and done by
//!   the server, which knows each kind (`api_routine::news_undo`). A line
//!   with nothing to undo has none.
//! - **Nothing is deleted.** Seen and undone are stamps.
//!
//! The store's side only: no HTTP.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Migration 40 (1.66): News, and when the reader saw a turn there.
pub const SCHEMA_1_66: &str = "
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  undo TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  routine_id INTEGER NOT NULL DEFAULT 0,
  turn_id INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL DEFAULT 0,
  undone_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS news_desk ON news(desk_id, created_at);
ALTER TABLE turns ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0;";

/// How long a line is in News: a week, then it is history.
pub const SHOWN_S: i64 = 7 * 86_400;
/// The longest detail kept: a diff of a command, cut.
const DETAIL_CHARS: usize = 4_000;
/// The most lines News reads at once.
const LIMIT: i64 = 60;

/// One line of News.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Item {
    pub id: i64,
    pub desk_id: i64,
    /// `reworded` (a routine's words), `changed` (its times, model, what
    /// wakes it), `took_back` (a card an agent removed), `folded` (copies
    /// of a routine made one), `stopped`, `ran`.
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
    /// Whether it has an Undo.
    pub undo: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub routine_id: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub turn_id: i64,
    pub at: i64,
    pub seen: bool,
    pub undone: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// What a line is made of.
#[derive(Default)]
pub struct New<'a> {
    pub kind: &'a str,
    pub text: &'a str,
    pub detail: &'a str,
    pub undo: &'a str,
    pub by: &'a str,
    pub routine_id: i64,
    pub turn_id: i64,
}

/// Write one line; its id.
pub fn add(conn: &Connection, desk_id: i64, n: &New, now: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO news(desk_id, kind, text, detail, undo, by, routine_id, turn_id, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            desk_id,
            n.kind,
            crate::thread::line(n.text, 300),
            cut(n.detail, DETAIL_CHARS),
            n.undo,
            crate::thread::line(n.by, 60),
            n.routine_id,
            n.turn_id,
            now
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn cut(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &s[..end])
}

const COLS: &str = "n.id, n.desk_id, n.kind, n.text, n.detail, n.undo != '', n.by, n.routine_id,
    n.turn_id, n.created_at, n.seen_at != 0, n.undone_at != 0";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        kind: r.get(2)?,
        text: r.get(3)?,
        detail: r.get(4)?,
        undo: r.get(5)?,
        by: r.get(6)?,
        routine_id: r.get(7)?,
        turn_id: r.get(8)?,
        at: r.get(9)?,
        seen: r.get(10)?,
        undone: r.get(11)?,
    })
}

/// The week's News on every open desk, newest first; one desk's with `desk`.
pub fn list(conn: &Connection, desk: Option<i64>, now: i64) -> Result<Vec<Item>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLS} FROM news n JOIN desks d ON d.id = n.desk_id
         WHERE d.closed_at = 0 AND n.created_at >= ?1 AND (?2 = 0 OR n.desk_id = ?2)
         ORDER BY n.created_at DESC, n.id DESC LIMIT ?3"
    ))?;
    let v = st
        .query_map(params![now - SHOWN_S, desk.unwrap_or(0), LIMIT], row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// One line, with what its Undo does.
pub fn get(conn: &Connection, id: i64) -> Result<Option<(Item, String)>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS}, n.undo FROM news n WHERE n.id = ?1"),
            params![id],
            |r| Ok((row(r)?, r.get(12)?)),
        )
        .optional()?)
}

/// The reader saw News: every line up to now, on one desk or all.
pub fn seen(conn: &Connection, desk: Option<i64>, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE news SET seen_at = ?1 WHERE seen_at = 0 AND (?2 = 0 OR desk_id = ?2)",
        params![now, desk.unwrap_or(0)],
    )?)
}

/// How many lines the reader has not seen: a dot, never a number.
pub fn unseen(conn: &Connection, desk: Option<i64>, now: i64) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM news n JOIN desks d ON d.id = n.desk_id
         WHERE d.closed_at = 0 AND n.seen_at = 0 AND n.created_at >= ?1 AND (?2 = 0 OR n.desk_id = ?2)",
        params![now - SHOWN_S, desk.unwrap_or(0)],
        |r| r.get(0),
    )?)
}

/// Its Undo was done: stamped, so it is not done twice.
pub fn undone(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE news SET undone_at = ?2, seen_at = CASE WHEN seen_at = 0 THEN ?2 ELSE seen_at END
         WHERE id = ?1 AND undone_at = 0 AND undo != ''",
        params![id, now],
    )? > 0)
}

/// A short line diff of two texts, `-` and `+` lines only, for a reworded
/// command: what was taken out and what came in, in order, at most `max`
/// lines. Not a minimal diff: a command is a page, and the reader needs to
/// see what moved, not a patch.
pub fn diff(was: &str, now: &str, max: usize) -> String {
    let a: Vec<&str> = was.lines().collect();
    let b: Vec<&str> = now.lines().collect();
    // The common head and tail are left out; what is between is the change.
    let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let tail = a[head..]
        .iter()
        .rev()
        .zip(b[head..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let gone = &a[head..a.len() - tail];
    let came = &b[head..b.len() - tail];
    let mut out: Vec<String> = Vec::new();
    for l in gone {
        if !came.contains(l) {
            out.push(format!("- {l}"));
        }
    }
    for l in came {
        if !gone.contains(l) {
            out.push(format!("+ {l}"));
        }
    }
    let more = out.len().saturating_sub(max);
    out.truncate(max);
    if more > 0 {
        out.push(format!("… and {more} more lines"));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_says_what_went_and_what_came() {
        let was = "# Pro forum\nRead the group.\nDraft replies.\nQueue them.";
        let now = "# Pro forum\nRead the group.\nDraft replies in Sunny's voice.\nQueue them.";
        assert_eq!(
            diff(was, now, 10),
            "- Draft replies.\n+ Draft replies in Sunny's voice."
        );
        assert_eq!(diff("a", "a", 10), "");
        let long: String = (0..30).map(|i| format!("line {i}\n")).collect();
        let d = diff("", &long, 5);
        assert!(d.ends_with("… and 25 more lines"), "{d}");
    }

    #[test]
    fn a_detail_is_cut_on_a_character() {
        let s = "é".repeat(3000);
        let c = cut(&s, 4001);
        assert!(c.ends_with('…'));
        assert!(c.len() < 4010);
    }
}
