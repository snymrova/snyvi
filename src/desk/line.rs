//! The line (1.67, plan f586a9fe09, stage 5): a desk has a goal and an
//! ordered queue of its notes, and one press starts the next piece.
//!
//! Until 1.67 the reader picked every next piece by hand: read the list,
//! open a panel, tell its agent which note. The hidden pipeline had tried
//! "work the list until done" by starting agents itself, which is why it
//! stayed hidden. The line keeps the one good idea and leaves the start with
//! the reader:
//!
//! - **A goal** is one line on the desk, in the reader's words.
//! - **The queue** is the reader's order over notes they chose (`ord`, 0 for
//!   a note not in it). A done note keeps its place, so "4 of 9" counts.
//! - **Done when** is one command a note may carry, the reader's, typed on
//!   the page. snyvi shows it and tells the agent; it does not run it here.
//! - **A claim** is which panel has a queued note. It holds while that panel
//!   is open, so a panel closed or crashed frees its note with no sweep.
//!   `next_for` gives a panel the first free note and claims it in the same
//!   statement's transaction, so two panels never take the same one.
//!
//! Only the page writes the goal, the order and the command. An agent reads
//! its next note and claims it; it cannot reorder, and it cannot start
//! another agent: Start next is a capability route (`api_line`).

use super::*;
use serde::Serialize;

/// Version 41 of `store::MIGRATIONS`.
pub const COLUMNS_1_67: &str = "ALTER TABLE desks ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE desk_notes ADD COLUMN ord INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desk_notes ADD COLUMN done_when TEXT NOT NULL DEFAULT '';
ALTER TABLE desk_notes ADD COLUMN claim_pane TEXT NOT NULL DEFAULT '';
ALTER TABLE desk_notes ADD COLUMN claim_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desk_notes ADD COLUMN tree TEXT NOT NULL DEFAULT '';";

/// A goal is one line.
pub const GOAL_CHARS: usize = 120;
/// A done-when command is one line the reader can read in the row.
pub const WHEN_CHARS: usize = 200;
/// How many notes a queue holds: a goal with more pieces is two goals.
pub const QUEUE: usize = 40;

/// The panel that has a note: its claim while the panel is open, else the
/// panel it was marked working from while that one is open, else nobody.
const HOLDER: &str = "CASE
  WHEN n.claim_pane != '' AND EXISTS(SELECT 1 FROM panes p WHERE p.id = n.claim_pane) THEN n.claim_pane
  WHEN n.stage = 'working' AND n.stage_pane != '' AND EXISTS(SELECT 1 FROM panes p WHERE p.id = n.stage_pane) THEN n.stage_pane
  ELSE '' END";

/// One note in the queue, as the page draws it beside the note's own row.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Queued {
    pub id: i64,
    pub done: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_when: String,
    /// The panel that has it, while that panel is open.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pane: String,
    /// The worktree Start next made for it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tree: String,
}

/// A desk's line: its goal, its queue in order, and the note Start next
/// would take (0 when every queued note is done or held).
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Line {
    pub goal: String,
    pub queue: Vec<Queued>,
    pub next: i64,
}

/// What `next_work` hands a panel.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
pub struct Work {
    pub id: i64,
    pub text: String,
    pub goal: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_when: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tree: String,
    /// It was this panel's already: the same answer as the last call.
    pub held: bool,
    /// How many queued notes are still open, this one included.
    pub left: i64,
}

/// One line of the reader's, with nothing a terminal or a row would trip on.
fn one_line(text: &str, chars: usize) -> String {
    let s: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .filter(|c| !is_bidi(*c))
        .collect();
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(chars)
        .collect()
}

pub fn goal(conn: &Connection, desk_id: i64) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT goal FROM desks WHERE id = ?1",
            params![desk_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default())
}

pub fn get(conn: &Connection, desk_id: i64) -> Result<Line> {
    let mut st = conn.prepare(&format!(
        "SELECT n.id, n.done_at != 0, n.done_when, {HOLDER}, n.tree FROM desk_notes n
         WHERE n.desk_id = ?1 AND n.removed_at = 0 AND n.suggested_by = '' AND n.ord > 0
         ORDER BY n.ord, n.id"
    ))?;
    let queue: Vec<Queued> = st
        .query_map(params![desk_id], |r| {
            Ok(Queued {
                id: r.get(0)?,
                done: r.get(1)?,
                done_when: r.get(2)?,
                pane: r.get(3)?,
                tree: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let next = queue
        .iter()
        .find(|q| !q.done && q.pane.is_empty())
        .map_or(0, |q| q.id);
    Ok(Line {
        goal: goal(conn, desk_id)?,
        queue,
        next,
    })
}

/// The reader's goal for the desk, or none with an empty line.
pub fn set_goal(conn: &Connection, desk_id: i64, text: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET goal = ?2 WHERE id = ?1",
        params![desk_id, one_line(text, GOAL_CHARS)],
    )? > 0)
}

/// The queue, as the reader ordered it: these notes, in this order, and no
/// others. A note that is not this desk's, or was removed, or is still an
/// agent's suggestion, is passed over. False when the list is too long.
pub fn set_order(conn: &mut Connection, desk_id: i64, ids: &[i64]) -> Result<bool> {
    if ids.len() > QUEUE {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE desk_notes SET ord = 0 WHERE desk_id = ?1 AND ord != 0",
        params![desk_id],
    )?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE desk_notes SET ord = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND suggested_by = ''",
            params![desk_id, id, i as i64 + 1],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

/// The command a note is done when it passes: the reader's, one line.
pub fn set_when(conn: &Connection, desk_id: i64, id: i64, cmd: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_notes SET done_when = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, one_line(cmd, WHEN_CHARS)],
    )? > 0)
}

/// Panel `pane` has note `id`, in `tree` when Start next made it one. Only
/// an open note nobody holds: false when another panel got there first.
pub fn claim(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    pane: &str,
    tree: &str,
    now: i64,
) -> Result<bool> {
    Ok(conn.execute(
        &format!(
            "UPDATE desk_notes AS n SET claim_pane = ?3, claim_at = ?4, tree = CASE WHEN ?5 != '' THEN ?5 ELSE tree END
             WHERE n.desk_id = ?1 AND n.id = ?2 AND n.removed_at = 0 AND n.done_at = 0 AND n.suggested_by = ''
               AND ({HOLDER}) IN ('', ?3)"
        ),
        params![desk_id, id, pane, now, tree],
    )? > 0)
}

/// The panel that has note `id`, when it is not `pane`: why a second agent
/// may not mark it working.
pub fn held_by_other(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    pane: &str,
) -> Result<Option<String>> {
    let holder: Option<String> = conn
        .query_row(
            &format!(
                "SELECT {HOLDER} FROM desk_notes n WHERE n.desk_id = ?1 AND n.id = ?2 AND n.removed_at = 0 AND n.done_at = 0"
            ),
            params![desk_id, id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(holder.filter(|h| !h.is_empty() && h != pane))
}

/// The next piece of work for panel `pane`: the note it holds already, or
/// the first in the queue that is open and held by nobody, which is now its
/// own. `None` when the queue has nothing free.
pub fn next_for(conn: &mut Connection, desk_id: i64, pane: &str, now: i64) -> Result<Option<Work>> {
    let tx = conn.transaction()?;
    let open = "n.desk_id = ?1 AND n.removed_at = 0 AND n.done_at = 0 AND n.suggested_by = '' AND n.ord > 0";
    let mine: Option<i64> = tx
        .query_row(
            &format!("SELECT n.id FROM desk_notes n WHERE {open} AND n.claim_pane = ?2 ORDER BY n.ord, n.id LIMIT 1"),
            params![desk_id, pane],
            |r| r.get(0),
        )
        .optional()?;
    let (id, held) = match mine {
        Some(id) => (id, true),
        None => {
            let free: Option<i64> = tx
                .query_row(
                    &format!("SELECT n.id FROM desk_notes n WHERE {open} AND ({HOLDER}) = '' ORDER BY n.ord, n.id LIMIT 1"),
                    params![desk_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(id) = free else {
                return Ok(None);
            };
            if !claim(&tx, desk_id, id, pane, "", now)? {
                return Ok(None);
            }
            (id, false)
        }
    };
    let (text, done_when, tree): (String, String, String) = tx.query_row(
        "SELECT text, done_when, tree FROM desk_notes WHERE desk_id = ?1 AND id = ?2",
        params![desk_id, id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let left: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM desk_notes n WHERE {open}"),
        params![desk_id],
        |r| r.get(0),
    )?;
    let goal = goal(&tx, desk_id)?;
    tx.commit()?;
    Ok(Some(Work {
        id,
        text,
        goal,
        done_when,
        tree,
        held,
        left,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desk_with(notes: usize) -> (Connection, i64, Vec<i64>) {
        let mut conn = crate::desk::tests::db();
        conn.execute_batch(COLUMNS_1_67).unwrap();
        let d = create(&conn, "/tmp/line", None, 1).unwrap();
        let ids = (0..notes)
            .map(|i| {
                add_note(&mut conn, d.id, &format!("piece {i}"), 10 + i as i64)
                    .unwrap()
                    .unwrap()
                    .id
            })
            .collect();
        (conn, d.id, ids)
    }

    fn pane(conn: &mut Connection, desk: i64) -> String {
        match open_pane(conn, desk, "/tmp/line", "", false, (0, false), 5).unwrap() {
            Opened::Pane(p) => p.id,
            _ => panic!("the desk has room"),
        }
    }

    #[test]
    fn the_queue_is_the_readers_order_and_two_panels_never_take_one_note() {
        let (mut conn, desk, ids) = desk_with(3);
        assert!(set_goal(&conn, desk, "  Home is\nthe floor  ").unwrap());
        assert!(set_order(&mut conn, desk, &[ids[2], ids[0]]).unwrap());
        let line = get(&conn, desk).unwrap();
        assert_eq!(line.goal, "Home is the floor");
        assert_eq!(
            line.queue.iter().map(|q| q.id).collect::<Vec<_>>(),
            vec![ids[2], ids[0]]
        );
        assert_eq!(line.next, ids[2]);

        let (a, b) = (pane(&mut conn, desk), pane(&mut conn, desk));
        let first = next_for(&mut conn, desk, &a, 20).unwrap().unwrap();
        assert_eq!((first.id, first.held, first.left), (ids[2], false, 2));
        let again = next_for(&mut conn, desk, &a, 21).unwrap().unwrap();
        assert_eq!((again.id, again.held), (ids[2], true), "the same note");
        let other = next_for(&mut conn, desk, &b, 22).unwrap().unwrap();
        assert_eq!(other.id, ids[0], "the second panel gets the second note");
        assert_eq!(
            held_by_other(&conn, desk, ids[2], &b).unwrap(),
            Some(a.clone())
        );
        assert_eq!(held_by_other(&conn, desk, ids[2], &a).unwrap(), None);
        assert_eq!(get(&conn, desk).unwrap().next, 0, "nothing is free");
        assert!(next_for(&mut conn, desk, "another", 23).unwrap().is_none());

        // A panel closed frees its note with no sweep.
        conn.execute("DELETE FROM panes WHERE id = ?1", params![a])
            .unwrap();
        assert_eq!(get(&conn, desk).unwrap().next, ids[2]);
    }

    #[test]
    fn a_done_note_keeps_its_place_and_a_long_queue_is_refused() {
        let (mut conn, desk, ids) = desk_with(2);
        assert!(set_order(&mut conn, desk, &ids).unwrap());
        assert!(set_when(&conn, desk, ids[1], "node bench/ui.mjs back").unwrap());
        conn.execute(
            "UPDATE desk_notes SET done_at = 30 WHERE id = ?1",
            params![ids[0]],
        )
        .unwrap();
        let line = get(&conn, desk).unwrap();
        assert_eq!(line.queue.len(), 2);
        assert!(line.queue[0].done);
        assert_eq!(line.queue[1].done_when, "node bench/ui.mjs back");
        assert_eq!(line.next, ids[1]);
        let many: Vec<i64> = (1..=QUEUE as i64 + 1).collect();
        assert!(!set_order(&mut conn, desk, &many).unwrap());
        assert_eq!(get(&conn, desk).unwrap().queue.len(), 2, "left as it was");
    }
}
