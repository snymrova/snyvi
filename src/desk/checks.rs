//! 1.58: checks the reader holds on a note (H2.1, plan 111a6341b3).
//!
//! A held check is one line, in the reader's words, of what they will try
//! once a note's work is done: "after Download I can see where the file
//! went". The spike on five past notes (ce8efb3960) found that both real
//! misses were checks the maker never wrote down, so the note gets a place
//! for them.
//!
//! They are held *from the builder*. `DeskNote` carries only how many
//! (`checks_held`, filled by `count_into`); the lines themselves are read by
//! `for_desk`, which only the page's handler calls, and never by
//! `read_desk_notes` or the brief. An agent may suggest lines while it plans
//! (`suggest`) -- it knows its own suggestions that session -- but once the
//! reader keeps one it is theirs and out of every later read. The holdout
//! ends when a check fails: the reader's ✗ reopens the note with that
//! line's words as its reply, which is what the next brief leads with.
//!
//! Nothing is deleted: a ✕ sets `removed_at`, and `restore` brings it back.

use super::*;
use serde::Serialize;
use std::collections::BTreeMap;

/// How long one check is, at most: one line the reader can run in a minute.
pub const CHECK_CHARS: usize = 160;
/// How many a note holds of the reader's, kept suggestions included.
pub const CHECKS_PER_NOTE: i64 = 7;
/// How many an agent's suggestions wait on one note for Keep or ✕.
pub const SUGGESTED_PER_NOTE: i64 = 3;
/// How many lines one `suggest_check` call may carry.
pub const SUGGEST_PER_CALL: usize = 5;

/// Version 36 of `store::MIGRATIONS`. `ok_at` and `fail_at` are the reader's
/// ✓ and ✗ at the last check-it; a reopen clears them (`clear_results`) so
/// the next one runs fresh.
pub const COLUMNS_1_58: &str = "
CREATE TABLE note_checks (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  note_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  suggested_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  removed_at INTEGER NOT NULL DEFAULT 0,
  ok_at INTEGER NOT NULL DEFAULT 0,
  fail_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX note_checks_note ON note_checks(desk_id, note_id, removed_at);
";

/// One held check, as the page sees it. Never on a `DeskNote`.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Check {
    pub id: i64,
    pub note: i64,
    pub text: String,
    /// The agent that suggested it, until the reader keeps it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub suggested_by: String,
    /// "ok", "fail", or empty: the reader's ✓ or ✗ at this check-it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub result: String,
}

/// What came of adding a check, or of keeping a suggestion.
#[derive(Debug, PartialEq)]
pub enum Added {
    Check(Check),
    /// The note holds `CHECKS_PER_NOTE`, or `SUGGESTED_PER_NOTE` wait on it.
    Full,
    Empty,
    /// No such line on this desk, or it was removed.
    NoSuchNote,
}

/// What a `suggest_check` call did: how many landed, how many the caps
/// turned away. The agent is told the numbers, never the list.
#[derive(Debug, PartialEq, Default)]
pub struct Suggested {
    pub added: usize,
    pub refused: usize,
    pub no_note: bool,
}

fn line(text: &str) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(CHECK_CHARS).collect()
}

fn note_live(conn: &Connection, desk_id: i64, note_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM desk_notes n JOIN desks d ON d.id = n.desk_id
             WHERE n.desk_id = ?1 AND n.id = ?2 AND n.removed_at = 0 AND d.closed_at = 0",
            params![desk_id, note_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// (kept, waiting) on one note.
fn counts(conn: &Connection, desk_id: i64, note_id: i64) -> Result<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COALESCE(SUM(suggested_by = ''), 0), COALESCE(SUM(suggested_by != ''), 0)
         FROM note_checks WHERE desk_id = ?1 AND note_id = ?2 AND removed_at = 0",
        params![desk_id, note_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// The reader adds a check (`by` empty), or an agent suggests one (`by` its
/// name). The count and the insert share a transaction, as a note's do.
pub fn add(
    conn: &mut Connection,
    desk_id: i64,
    note_id: i64,
    text: &str,
    by: &str,
    now: i64,
) -> Result<Added> {
    let text = line(text);
    if text.is_empty() {
        return Ok(Added::Empty);
    }
    let by: String = by.trim().chars().take(60).collect();
    let tx = conn.transaction()?;
    if !note_live(&tx, desk_id, note_id)? {
        return Ok(Added::NoSuchNote);
    }
    let (kept, waiting) = counts(&tx, desk_id, note_id)?;
    if kept >= CHECKS_PER_NOTE || (!by.is_empty() && waiting >= SUGGESTED_PER_NOTE) {
        return Ok(Added::Full);
    }
    tx.execute(
        "INSERT INTO note_checks(desk_id, note_id, text, suggested_by, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![desk_id, note_id, text, by, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Added::Check(Check {
        id,
        note: note_id,
        text,
        suggested_by: by,
        result: String::new(),
    }))
}

/// An agent's suggestions, at most `SUGGEST_PER_CALL` of them; the rest of
/// the call, and any past the caps, are counted as refused.
pub fn suggest(
    conn: &mut Connection,
    desk_id: i64,
    note_id: i64,
    texts: &[String],
    by: &str,
    now: i64,
) -> Result<Suggested> {
    let by = if by.trim().is_empty() { "an agent" } else { by };
    let mut out = Suggested::default();
    for (i, t) in texts.iter().filter(|t| !line(t).is_empty()).enumerate() {
        if i >= SUGGEST_PER_CALL {
            out.refused += 1;
            continue;
        }
        match add(conn, desk_id, note_id, t, by, now)? {
            Added::Check(_) => out.added += 1,
            Added::NoSuchNote => {
                out.no_note = true;
                return Ok(out);
            }
            _ => out.refused += 1,
        }
    }
    Ok(out)
}

/// Every live check on a desk, by note: the reader's first, then what an
/// agent suggested, each in the order written. The page's only.
pub fn for_desk(conn: &Connection, desk_id: i64) -> Result<BTreeMap<i64, Vec<Check>>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, text, suggested_by, ok_at, fail_at FROM note_checks
         WHERE desk_id = ?1 AND removed_at = 0
         ORDER BY note_id, suggested_by != '', id",
    )?;
    let mut map: BTreeMap<i64, Vec<Check>> = BTreeMap::new();
    let rows = stmt.query_map(params![desk_id], |r| {
        let (ok, fail): (i64, i64) = (r.get(4)?, r.get(5)?);
        Ok(Check {
            id: r.get(0)?,
            note: r.get(1)?,
            text: r.get(2)?,
            suggested_by: r.get(3)?,
            result: match (ok > 0, fail > 0) {
                (_, true) => "fail".into(),
                (true, _) => "ok".into(),
                _ => String::new(),
            },
        })
    })?;
    for c in rows {
        let c = c?;
        map.entry(c.note).or_default().push(c);
    }
    Ok(map)
}

/// How many checks each line holds, kept ones only, onto the notes: the one
/// thing about them a builder reads (`read_desk_notes`, the brief).
pub fn count_into(conn: &Connection, desk_id: i64, notes: &mut [DeskNote]) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT note_id, COUNT(*) FROM note_checks
         WHERE desk_id = ?1 AND removed_at = 0 AND suggested_by = '' GROUP BY note_id",
    )?;
    let held: BTreeMap<i64, i64> = stmt
        .query_map(params![desk_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for n in notes {
        n.checks_held = held.get(&n.id).copied().unwrap_or(0);
    }
    Ok(())
}

/// The one check, live, on this desk's line.
const WHERE_ONE: &str = "WHERE desk_id = ?1 AND note_id = ?2 AND id = ?3";

/// The reader rewrites a check. Empty text is refused; the ✕ is `remove`.
pub fn set_text(
    conn: &Connection,
    desk_id: i64,
    note_id: i64,
    id: i64,
    text: &str,
) -> Result<bool> {
    let text = line(text);
    if text.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        &format!("UPDATE note_checks SET text = ?4 {WHERE_ONE} AND removed_at = 0"),
        params![desk_id, note_id, id, text],
    )? > 0)
}

/// The reader's ✓ ("ok"), ✗ ("fail"), or neither ("clear") on a kept check.
/// False for anything else, or a suggestion not yet kept.
pub fn set_result(
    conn: &Connection,
    desk_id: i64,
    note_id: i64,
    id: i64,
    result: &str,
    now: i64,
) -> Result<bool> {
    let (ok, fail) = match result {
        "ok" => (now, 0),
        "fail" => (0, now),
        "clear" => (0, 0),
        _ => return Ok(false),
    };
    Ok(conn.execute(
        &format!("UPDATE note_checks SET ok_at = ?4, fail_at = ?5 {WHERE_ONE} AND removed_at = 0 AND suggested_by = ''"),
        params![desk_id, note_id, id, ok, fail],
    )? > 0)
}

/// A ✕: off the list, recoverable.
pub fn remove(conn: &Connection, desk_id: i64, note_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        &format!("UPDATE note_checks SET removed_at = ?4 {WHERE_ONE} AND removed_at = 0"),
        params![desk_id, note_id, id, now],
    )? > 0)
}

/// Undo of a ✕. A kept check comes back only while the note has room for it.
pub fn restore(conn: &Connection, desk_id: i64, note_id: i64, id: i64) -> Result<Added> {
    let (kept, _) = counts(conn, desk_id, note_id)?;
    let mine: Option<bool> = conn
        .query_row(
            &format!("SELECT suggested_by = '' FROM note_checks {WHERE_ONE} AND removed_at != 0"),
            params![desk_id, note_id, id],
            |r| r.get(0),
        )
        .optional()?;
    match mine {
        None => Ok(Added::NoSuchNote),
        Some(true) if kept >= CHECKS_PER_NOTE => Ok(Added::Full),
        Some(_) => {
            conn.execute(
                &format!("UPDATE note_checks SET removed_at = 0 {WHERE_ONE}"),
                params![desk_id, note_id, id],
            )?;
            Ok(one(conn, id)?.map_or(Added::NoSuchNote, Added::Check))
        }
    }
}

/// The reader keeps an agent's suggestion: from here it is theirs, held
/// from every builder like the rest.
pub fn keep(conn: &Connection, desk_id: i64, note_id: i64, id: i64) -> Result<Added> {
    let (kept, _) = counts(conn, desk_id, note_id)?;
    if kept >= CHECKS_PER_NOTE {
        return Ok(Added::Full);
    }
    let n = conn.execute(
        &format!("UPDATE note_checks SET suggested_by = '' {WHERE_ONE} AND removed_at = 0 AND suggested_by != ''"),
        params![desk_id, note_id, id],
    )?;
    if n == 0 {
        return Ok(Added::NoSuchNote);
    }
    Ok(one(conn, id)?.map_or(Added::NoSuchNote, Added::Check))
}

fn one(conn: &Connection, id: i64) -> Result<Option<Check>> {
    Ok(conn
        .query_row(
            "SELECT note_id, text, suggested_by FROM note_checks WHERE id = ?1",
            params![id],
            |r| {
                Ok(Check {
                    id,
                    note: r.get(0)?,
                    text: r.get(1)?,
                    suggested_by: r.get(2)?,
                    result: String::new(),
                })
            },
        )
        .optional()?)
}

/// A reopen (`check_note` with works false): the next check-it runs every
/// line fresh.
pub fn clear_results(conn: &Connection, desk_id: i64, note_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE note_checks SET ok_at = 0, fail_at = 0 WHERE desk_id = ?1 AND note_id = ?2",
        params![desk_id, note_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desk_with_note() -> (Connection, i64, i64) {
        let mut conn = super::super::tests::db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let n = add_note(&mut conn, d, "Download says where it saved", 1)
            .unwrap()
            .unwrap()
            .id;
        (conn, d, n)
    }

    fn mine(a: Added) -> Check {
        match a {
            Added::Check(c) => c,
            other => panic!("not added: {other:?}"),
        }
    }

    #[test]
    fn a_held_check_reaches_the_note_as_a_count_only() {
        let (mut conn, d, n) = desk_with_note();
        mine(
            add(
                &mut conn,
                d,
                n,
                "  I press Download and see\n the path ",
                "",
                2,
            )
            .unwrap(),
        );
        mine(add(&mut conn, d, n, "It opens from there", "", 3).unwrap());
        let notes = super::super::notes(&conn, d).unwrap();
        assert_eq!(notes[0].checks_held, 2);
        let read = serde_json::to_string(&notes).unwrap();
        assert!(read.contains("\"checks_held\":2"));
        assert!(
            !read.contains("see the path"),
            "the words stay held: {read}"
        );
        let all = for_desk(&conn, d).unwrap();
        assert_eq!(all[&n][0].text, "I press Download and see the path");
    }

    #[test]
    fn suggestions_wait_three_to_a_note_and_a_call_carries_five() {
        let (mut conn, d, n) = desk_with_note();
        let texts: Vec<String> = (1..=7).map(|i| format!("check {i}")).collect();
        let s = suggest(&mut conn, d, n, &texts, "claude", 2).unwrap();
        assert_eq!((s.added, s.refused), (3, 4));
        // A suggestion is not held until kept: the builder's count is 0.
        assert_eq!(super::super::notes(&conn, d).unwrap()[0].checks_held, 0);
        let first = for_desk(&conn, d).unwrap()[&n][0].id;
        mine(keep(&conn, d, n, first).unwrap());
        assert_eq!(super::super::notes(&conn, d).unwrap()[0].checks_held, 1);
        let s = suggest(&mut conn, d, n, &["one more".into()], "claude", 3).unwrap();
        assert_eq!(s.added, 1);
        let s = suggest(&mut conn, d, 999, &["x".into()], "claude", 3).unwrap();
        assert!(s.no_note);
    }

    #[test]
    fn a_note_holds_seven_and_a_removed_one_comes_back() {
        let (mut conn, d, n) = desk_with_note();
        let ids: Vec<i64> = (0..CHECKS_PER_NOTE)
            .map(|i| mine(add(&mut conn, d, n, &format!("c{i}"), "", 2).unwrap()).id)
            .collect();
        assert_eq!(add(&mut conn, d, n, "c8", "", 2).unwrap(), Added::Full);
        assert!(remove(&conn, d, n, ids[0], 3).unwrap());
        assert!(!remove(&conn, d, n, ids[0], 3).unwrap());
        mine(add(&mut conn, d, n, "c8", "", 4).unwrap());
        assert_eq!(restore(&conn, d, n, ids[0]).unwrap(), Added::Full);
        let last = for_desk(&conn, d).unwrap()[&n].last().unwrap().id;
        assert!(remove(&conn, d, n, last, 5).unwrap());
        assert_eq!(mine(restore(&conn, d, n, ids[0]).unwrap()).text, "c0");
        assert_eq!(add(&mut conn, d, n, "   ", "", 2).unwrap(), Added::Empty);
        assert_eq!(
            add(&mut conn, d, 999, "x", "", 2).unwrap(),
            Added::NoSuchNote
        );
    }

    #[test]
    fn a_reopen_clears_the_results_for_a_fresh_check() {
        let (mut conn, d, n) = desk_with_note();
        let a = mine(add(&mut conn, d, n, "path shows", "", 2).unwrap()).id;
        let b = mine(add(&mut conn, d, n, "opens", "", 2).unwrap()).id;
        assert!(set_result(&conn, d, n, a, "ok", 3).unwrap());
        assert!(set_result(&conn, d, n, b, "fail", 3).unwrap());
        assert!(!set_result(&conn, d, n, b, "maybe", 3).unwrap());
        let got: Vec<String> = for_desk(&conn, d).unwrap()[&n]
            .iter()
            .map(|c| c.result.clone())
            .collect();
        assert_eq!(got, ["ok", "fail"]);
        clear_results(&conn, d, n).unwrap();
        assert!(for_desk(&conn, d).unwrap()[&n]
            .iter()
            .all(|c| c.result.is_empty()));
        assert!(set_text(&conn, d, n, a, "the path shows beside Download").unwrap());
        assert!(!set_text(&conn, d, n, a, " ").unwrap());
    }
}
