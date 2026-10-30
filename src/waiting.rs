//! What waits on the reader (1.47): a left-off that says the next step is
//! theirs, and a plan sent for desk notes that no one has approved.
//!
//! A left-off carries `needs` -- `you`, `claude` or `time` -- when the agent
//! said so with `leave_off`, or the reader marked it *On me* on Home. snyvi
//! never reads it into the words: "if you approve…" is a phrase, `needs: you`
//! is a fact. Two days of `you` and it is a row on Home's Waiting on you.
//!
//! A plan is a document that is some open note's `stage_doc`: what
//! `send_document(notes=)` and `mark_desk_note planned` make. Its head grows
//! Approve, and the reader's press marks those notes `ok_at`, which the
//! brief and the next prompt carry. A day without it is a row too.
//!
//! Neither starts anything. Approve is a line Claude reads at its next
//! prompt, never one typed into a panel.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// 1.47's columns: when the reader approved a line's plan, what a desk's
/// left-off needs and when the reader approved it. Version 28 of
/// `store::MIGRATIONS`, never in a `SCHEMA`.
pub const COLUMNS_1_47: &str = "ALTER TABLE desk_notes ADD COLUMN ok_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desks ADD COLUMN left_off_needs TEXT NOT NULL DEFAULT '';
ALTER TABLE desks ADD COLUMN left_off_ok_at INTEGER NOT NULL DEFAULT 0;";

/// Whose the next step is, when it was said: the reader's, the agent's, or
/// something outside both (a review, a store, a friend).
pub const NEEDS: [&str; 3] = ["you", "claude", "time"];

/// How long a left-off that needs the reader sits on the desk head before
/// it is a row on On you: a day. It was two, so a sentence said at the end
/// of an evening was not on them by morning; with a list to sit in (1.54,
/// `crate::onyou`) a day is enough, and a routine's line does not wait at
/// all, since its run was for this morning.
pub const LEFT_WAIT_S: i64 = 86_400;

/// How long a plan waits for Approve before it is a row on Home: a day.
pub const PLAN_WAIT_S: i64 = 86_400;

/// `needs` as stored: one of `NEEDS`, or empty for unsaid.
pub fn needs_of(n: &str) -> String {
    let n = n.trim().to_ascii_lowercase();
    if NEEDS.contains(&n.as_str()) {
        n
    } else {
        String::new()
    }
}

/// The reader marks a left-off as theirs, or not: Home's *On me*, for the
/// sentences said before `needs` was. Whether there was one to mark.
pub fn set_needs(conn: &Connection, desk_id: i64, needs: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET left_off_needs = ?2 WHERE id = ?1 AND left_off != ''",
        params![desk_id, needs_of(needs)],
    )? > 0)
}

/// The reader approves a left-off: the next step is the agent's now, and its
/// next prompt says so (`crate::brief::changes`). Undo takes it back.
pub fn approve_left_off(conn: &Connection, desk_id: i64, undo: bool, now: i64) -> Result<bool> {
    let n = if undo {
        conn.execute(
            "UPDATE desks SET left_off_ok_at = 0, left_off_needs = 'you' WHERE id = ?1 AND left_off != ''",
            params![desk_id],
        )?
    } else {
        conn.execute(
            "UPDATE desks SET left_off_ok_at = ?2, left_off_needs = 'claude' WHERE id = ?1 AND left_off != ''",
            params![desk_id, now],
        )?
    };
    Ok(n > 0)
}

/// The reader approves a plan, or takes it back: every open line on the desk
/// whose plan it is. The lines marked, by id; none when it is no one's plan.
pub fn approve_plan(
    conn: &Connection,
    desk_id: i64,
    doc: &str,
    undo: bool,
    now: i64,
) -> Result<Vec<i64>> {
    let ids = plan_notes(conn, desk_id, doc)?;
    conn.execute(
        "UPDATE desk_notes SET ok_at = ?3 WHERE desk_id = ?1 AND stage_doc = ?2 AND stage != ''
         AND done_at = 0 AND removed_at = 0",
        params![desk_id, doc, if undo { 0 } else { now }],
    )?;
    Ok(ids)
}

fn plan_notes(conn: &Connection, desk_id: i64, doc: &str) -> Result<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT id FROM desk_notes WHERE desk_id = ?1 AND stage_doc = ?2 AND stage != ''
         AND done_at = 0 AND removed_at = 0 ORDER BY id",
    )?;
    let ids = st
        .query_map(params![desk_id, doc], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// A document that is a plan: the desk, its open lines, and when the reader
/// approved it (0 for not yet). What the document's head draws Approve from.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlanFor {
    pub desk: i64,
    pub notes: Vec<i64>,
    pub ok_at: i64,
}

/// Whether a document is some open line's plan, on the desk it was made for.
pub fn plan_for(conn: &Connection, doc: &str) -> Result<Option<PlanFor>> {
    let mut st = conn.prepare(
        "SELECT n.desk_id, n.id, n.ok_at FROM desk_notes n JOIN desks d ON d.id = n.desk_id
         WHERE n.stage_doc = ?1 AND n.stage != '' AND n.done_at = 0 AND n.removed_at = 0
           AND d.closed_at = 0 ORDER BY n.desk_id, n.id",
    )?;
    let rows: Vec<(i64, i64, i64)> = st
        .query_map(params![doc], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let Some(&(desk, _, _)) = rows.first() else {
        return Ok(None);
    };
    let mine: Vec<&(i64, i64, i64)> = rows.iter().filter(|r| r.0 == desk).collect();
    Ok(Some(PlanFor {
        desk,
        notes: mine.iter().map(|r| r.1).collect(),
        // Approved once every line is: a line added to the plan since is not.
        ok_at: mine.iter().map(|r| r.2).min().unwrap_or(0),
    }))
}

/// One row of Home's Waiting on you.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Waiting {
    pub desk: i64,
    /// `left` for a left-off that needs the reader, `plan` for a plan.
    pub kind: &'static str,
    pub text: String,
    /// Since when: the left-off's time, or the plan's.
    pub at: i64,
    /// The plan's document, by id; a left-off's `about`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<i64>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
}

/// What has waited on the reader long enough to be on Home, on desks open
/// and not parked, the oldest first: left-offs that need them for
/// `LEFT_WAIT_S` and were not approved since -- nor moved to Tomorrow or
/// said Not this to (1.54, `crate::onyou`) -- and plans unapproved for
/// `PLAN_WAIT_S`.
pub fn rows(conn: &Connection, now: i64) -> Result<Vec<Waiting>> {
    let mut out: Vec<Waiting> = conn
        .prepare(
            // A routine's left-off is said by the routine's name (1.50).
            "SELECT id, left_off, left_off_at, left_off_about,
                    COALESCE((SELECT r.name FROM routines r WHERE r.pane != '' AND r.pane = desks.left_off_pane
                              AND r.removed_at = 0 LIMIT 1), left_off_by) FROM desks
             WHERE closed_at = 0 AND parked_at = 0 AND left_off != '' AND left_off_needs = 'you'
               AND left_off_at <= ?1 AND left_off_ok_at < left_off_at
               AND left_off_until <= ?2 AND left_off_not = ''",
        )?
        .query_map(params![now - LEFT_WAIT_S, now], |r| {
            Ok(Waiting {
                desk: r.get(0)?,
                kind: "left",
                text: r.get(1)?,
                at: r.get(2)?,
                doc: r.get(3)?,
                notes: Vec::new(),
                by: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let plans: Vec<(i64, String, String, i64, String, String)> = conn
        .prepare(
            "SELECT n.desk_id, n.stage_doc, group_concat(n.id, ' '), min(n.stage_at), max(n.stage_by),
                    COALESCE((SELECT title FROM docs WHERE id = n.stage_doc), '')
             FROM desk_notes n JOIN desks d ON d.id = n.desk_id
             WHERE n.stage = 'planned' AND n.stage_doc != '' AND n.ok_at = 0 AND n.done_at = 0
               AND n.removed_at = 0 AND n.suggested_by = '' AND d.closed_at = 0 AND d.parked_at = 0
             GROUP BY n.desk_id, n.stage_doc HAVING min(n.stage_at) <= ?1",
        )?
        .query_map(params![now - PLAN_WAIT_S], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    out.extend(
        plans
            .into_iter()
            .map(|(desk, doc, ids, at, by, title)| Waiting {
                desk,
                kind: "plan",
                text: if title.is_empty() {
                    "a plan".into()
                } else {
                    title
                },
                at,
                doc,
                notes: ids.split(' ').filter_map(|i| i.parse().ok()).collect(),
                by,
            }),
    );
    out.sort_by_key(|w| w.at);
    Ok(out)
}

#[cfg(test)]
mod tests;
