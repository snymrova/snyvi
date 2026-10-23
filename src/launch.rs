//! A launch is a list (1.48): dated lines on the desk, suggested as one set
//! and kept as one. `suggest_desk_note` with `lines` puts up to a dozen
//! suggestions at once -- each its own row with its own chip and ✕ -- and
//! Keep all on the set's first row keeps the rest with it. The run sheet a
//! launch used to be was an 800-word document nobody ticked (usage audit
//! 63cc69c8c1, P3).
//!
//! A set is the suggestions one call wrote: the same agent, the same second.
//! Nothing new is stored to say so, so an older snyvi reads them as the
//! separate suggestions they also are.
//!
//! The lines go into the thread of the panel that suggested them, so the
//! desk head can count the launch (`7/11`) from the thread's dated lines.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

/// The most lines one set carries, as the most steps a `run` card does.
pub const LINES_MAX: usize = crate::thread::STEPS_MAX;

/// The template Claude reads when the user says launch, installed with the
/// skill beside SKILL.md.
pub const TEMPLATE: &str = include_str!("skill/launch.md");

/// One line of a set: its text and, in the user's words, when it is due.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct Line {
    pub text: String,
    pub due: String,
}

#[derive(Debug, PartialEq)]
pub enum Lines {
    /// The ids written, in order, and the lines whose date was not one.
    Set(Vec<i64>, Vec<String>),
    Empty,
    TooMany,
    Full,
    NoSuchDesk,
}

/// Write a set of suggested lines on a desk, in the pane's thread when it
/// has one. The waiting cap is the single suggestion's (`desk::suggest_note`)
/// counted once for the set; the desk's 200 lines count every one.
pub fn suggest_lines(
    conn: &mut Connection,
    desk_id: i64,
    lines: &[Line],
    by: &str,
    pane: &str,
    now: i64,
) -> Result<Lines> {
    let lines: Vec<&Line> = lines.iter().filter(|l| !l.text.trim().is_empty()).collect();
    if lines.is_empty() {
        return Ok(Lines::Empty);
    }
    if lines.len() > LINES_MAX {
        return Ok(Lines::TooMany);
    }
    let by: String = match by.trim() {
        "" => "an agent".to_string(),
        b => b.chars().take(60).collect(),
    };
    let tx = conn.transaction()?;
    if tx
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        return Ok(Lines::NoSuchDesk);
    }
    let (held, waiting): (i64, i64) = tx.query_row(
        "SELECT COUNT(*), COALESCE(SUM(suggested_by != '' AND done_at = 0), 0) FROM desk_notes
         WHERE desk_id = ?1 AND removed_at = 0",
        params![desk_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if held + lines.len() as i64 > crate::desk::NOTES_PER_DESK
        || waiting >= crate::desk::SUGGESTIONS_PER_DESK
    {
        return Ok(Lines::Full);
    }
    let thread: i64 = if pane.is_empty() {
        0
    } else {
        crate::thread::of_pane(&tx, desk_id, pane)?.map_or(0, |t| t.id)
    };
    let mut ids = Vec::new();
    let mut undated = Vec::new();
    for l in lines {
        let text: String = l.text.trim().chars().take(200).collect();
        // A date said apart wins; else one at the line's end, as typed.
        let (text, due_at) = match l.due.trim() {
            "" => crate::due::split(&text, now).unwrap_or((text, 0)),
            w => match crate::due::parse(w, now) {
                Some(at) => (text, at),
                None => {
                    undated.push(text.clone());
                    (text, 0)
                }
            },
        };
        tx.execute(
            "INSERT INTO desk_notes(desk_id, text, created_at, suggested_by, due_at, thread_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![desk_id, text, now, by, due_at, thread],
        )?;
        ids.push(tx.last_insert_rowid());
    }
    tx.commit()?;
    Ok(Lines::Set(ids, undated))
}

/// Keep all: the suggestion at `id` and every other waiting one written
/// with it -- the same agent, the same second. How many were kept.
pub fn keep_set(conn: &Connection, desk_id: i64, id: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE desk_notes SET suggested_by = '' WHERE desk_id = ?1 AND removed_at = 0 AND suggested_by != ''
           AND done_at = 0 AND (suggested_by, created_at) =
             (SELECT suggested_by, created_at FROM desk_notes WHERE desk_id = ?1 AND id = ?2 AND suggested_by != '')",
        params![desk_id, id],
    )?)
}

#[cfg(test)]
mod tests;
