//! Desks: a named workspace rooted at a folder, holding up to four panes in a
//! fixed two-column grid.
//!
//! A desk is not a document, and this is the file that makes that true. It has
//! its own tables and its own id space, so it is absent from the tree, the
//! inbox, the queue and search by construction rather than by a condition some
//! later query could forget. Give a desk a document id and "the library is
//! everything an agent sent you" stops being a sentence anyone can say.
//!
//! Two things are persisted and one is not. The workspace -- which folder,
//! which slots, what to re-run -- is here, because that is what a restore needs
//! and a restore is the point. The process is not: a pane comes back stopped,
//! with `Start` offered, and nothing on this machine ever spawns a shell
//! because a daemon woke up. The screen and the PTY that Phase 3 adds are
//! in-memory beside these rows and die with the daemon, which is why a pane row
//! carries no state column at all.
//!
//! The two caps are the budget, not a preference. `docs/BRAINSTORM.md:31` sets
//! 60 MB resident and `:549` records 40 MB today, so there are 20 MB to spend.
//! A truecolor cell is about 11 bytes, so a 2 MB scrollback is roughly 900 rows
//! at 200 columns, and eight of those is a 16 MB ceiling that fits. Four panes
//! per desk bounds nothing once desks are unbounded -- the global cap is the
//! line that holds, and it is the one worth writing a test about.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How many panes one desk holds. Two columns, two rows, and the third pane
/// spans the bottom rather than leaving a hole beside it.
pub const PER_DESK: i64 = 4;

/// How many panes exist at once, across every desk. This is the number the
/// memory budget is written against.
pub const EVERYWHERE: i64 = 8;

/// A line on a desk's list, not a paragraph. Past this it is a document and
/// `send_document` is for it -- the same line `crate::aside` draws, for the same
/// reason: a list whose rows wrap three times is a list no one reads.
pub const NOTE_CHARS: usize = 200;

/// How many notes one desk keeps, open and done together. A list is a working
/// set; a thousand rows is an archive, and snyvi has one of those already.
pub const NOTES_PER_DESK: i64 = 200;

/// A divider never goes so far that the pane beside it is a sliver. The
/// fraction is of the axis it splits, so these are the two ends of the drag.
const MIN_FRACTION: f64 = 0.15;
const MAX_FRACTION: f64 = 0.85;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS desks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  col REAL NOT NULL DEFAULT 0.5,
  row REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  cmd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  agent_session TEXT NOT NULL DEFAULT '',
  UNIQUE(desk_id, slot)
);
CREATE INDEX IF NOT EXISTS panes_desk ON panes(desk_id, slot);
CREATE TABLE IF NOT EXISTS desk_notes (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done_at INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS desk_notes_desk ON desk_notes(desk_id, done_at, id);
"#;

/// A desk as the sidebar lists it and the view draws it: a name, the folder it
/// is rooted at, the two divider fractions that are the whole of its geometry,
/// and what is in its slots.
#[derive(Clone, Debug, Serialize)]
pub struct Desk {
    pub id: i64,
    pub name: String,
    pub root: String,
    /// Where the vertical divider sits, as a fraction of the width.
    pub col: f64,
    /// Where the horizontal divider sits, as a fraction of the height.
    pub row: f64,
    pub created_at: i64,
    pub panes: Vec<Pane>,
}

/// A line the reader wrote on a desk's own list.
///
/// Not an aside (`crate::aside`), which is a sentence an agent leaves and the
/// daemon forgets when it restarts. This one is the reader's: it is theirs to write,
/// tick and put away, it belongs to a desk rather than to a sender, and it is
/// in the database because a list that did not survive a restart would be a
/// list no one trusted enough to write on.
#[derive(Clone, Debug, Serialize)]
pub struct DeskNote {
    pub id: i64,
    pub text: String,
    pub done: bool,
    pub created_at: i64,
}

/// A pane, which in this phase is a workspace row and no process.
///
/// The id is 16 bytes of hex because it is the value `SNYVI_SESSION` will carry
/// into the child's environment in Phase 3: it leaves the daemon, so it is
/// unguessable rather than sequential. A desk's id never leaves this machine's
/// own UI, so it is an integer, like a project's.
#[derive(Clone, Debug, Serialize)]
pub struct Pane {
    pub id: String,
    /// 1 to `PER_DESK`. Slots, not splits: the grid is fixed.
    pub slot: i64,
    pub cwd: String,
    /// What to re-run when the reader asks for it. Empty means the shell.
    pub cmd: String,
    pub created_at: i64,
    /// The last Claude Code conversation that ran in this pane, as its hook
    /// reported it, so the pane can offer to resume it after Claude or the
    /// daemon has gone. Empty when none has. Always a `valid_session`.
    pub agent_session: String,
}

/// Where a document came from, when it came from a pane: the desk and the
/// slot, which is what the reader sees -- `snyvi [1]` -- and what the link in
/// the document's meta opens. Copied onto the document when it arrives rather
/// than looked up when it is read, so a document keeps saying where it came
/// from after the pane or the desk is gone.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Origin {
    pub id: i64,
    pub name: String,
    pub slot: i64,
}

/// A pane with the desk it is on, for the things that need both: starting it,
/// which needs the folder and the name, and naming a document it sent.
#[derive(Clone, Debug)]
pub struct Placed {
    pub pane: Pane,
    pub desk_id: i64,
    pub desk_name: String,
    pub root: String,
}

/// What came of asking for a pane.
///
/// The two refusals are separate because the sentence a reader gets is
/// different: one says this desk is full and a second desk would take the next
/// pane, the other says snyvi is full and something has to be closed first.
/// Collapsing them would make the first look like the second.
#[derive(Debug)]
pub enum Opened {
    Pane(Pane),
    DeskFull,
    NoRoomLeft,
    NoSuchDesk,
}

/// Every desk, oldest first, each with its panes in slot order.
///
/// Two queries rather than a join with a row per pane: a desk with no panes is
/// a real and common state -- it is what every desk is for the moment after it
/// is made -- and it should not need a left join to survive the trip.
pub fn list(conn: &Connection) -> Result<Vec<Desk>> {
    let mut stmt =
        conn.prepare("SELECT id, name, root, col, row, created_at FROM desks ORDER BY id")?;
    let mut desks: Vec<Desk> = stmt
        .query_map([], row_to_desk)?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT desk_id, id, slot, cwd, cmd, created_at, agent_session FROM panes ORDER BY desk_id, slot",
    )?;
    let panes: Vec<(i64, Pane)> = stmt
        .query_map([], |r| Ok((r.get(0)?, row_to_pane(r, 1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (desk_id, pane) in panes {
        if let Some(d) = desks.iter_mut().find(|d| d.id == desk_id) {
            d.panes.push(pane);
        }
    }
    Ok(desks)
}

/// One desk, with its panes, or nothing if that id is not a desk's.
pub fn get(conn: &Connection, id: i64) -> Result<Option<Desk>> {
    let Some(mut desk) = conn
        .query_row(
            "SELECT id, name, root, col, row, created_at FROM desks WHERE id = ?1",
            params![id],
            row_to_desk,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT id, slot, cwd, cmd, created_at, agent_session FROM panes WHERE desk_id = ?1 ORDER BY slot",
    )?;
    desk.panes = stmt
        .query_map(params![id], |r| row_to_pane(r, 0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(desk))
}

/// A new desk on a folder.
///
/// Two desks on one folder is a workflow and not a mistake -- the first holds
/// the agent and its tests, the second holds the chores -- so the root is not
/// unique and nothing here refuses the second. The name is, because a list of
/// three rows all reading `snyvi` is a list that cannot be used: the folder's
/// own name is taken when it is free, and numbered when it is not.
pub fn create(conn: &Connection, root: &str, name: Option<&str>, now: i64) -> Result<Desk> {
    let wanted = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| derive_name(root));
    let name = free_name(conn, &wanted)?;
    conn.execute(
        "INSERT INTO desks(name, root, col, row, created_at) VALUES(?1, ?2, 0.5, 0.5, ?3)",
        params![name, root, now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Desk {
        id,
        name,
        root: root.to_string(),
        col: 0.5,
        row: 0.5,
        created_at: now,
        panes: Vec::new(),
    })
}

/// Rename a desk. The name a reader typed is theirs: it is not numbered, and a
/// second desk called `chores` is allowed if that is what they asked for.
pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<bool> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        "UPDATE desks SET name = ?2 WHERE id = ?1",
        params![id, name],
    )? > 0)
}

/// Where the two dividers sit. Clamped, because a fraction that came from a
/// drag can arrive as anything and a pane no one can see is not a pane.
pub fn layout(conn: &Connection, id: i64, col: f64, row: f64) -> Result<bool> {
    let clamp = |f: f64| {
        if f.is_finite() {
            f.clamp(MIN_FRACTION, MAX_FRACTION)
        } else {
            0.5
        }
    };
    Ok(conn.execute(
        "UPDATE desks SET col = ?2, row = ?3 WHERE id = ?1",
        params![id, clamp(col), clamp(row)],
    )? > 0)
}

/// Close a desk, and its panes with it.
///
/// `ON DELETE CASCADE` does the second half, which is why `PRAGMA foreign_keys`
/// is on for this connection: without it the panes would stay, hold their share
/// of the global cap, and belong to nothing.
pub fn delete(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM desks WHERE id = ?1", params![id])? > 0)
}

/// Open a pane on a desk, in the lowest free slot.
///
/// Both caps are read inside the same transaction that writes the row, so two
/// requests that arrive together cannot each see seven panes and both make an
/// eighth.
pub fn open_pane(
    conn: &mut Connection,
    desk_id: i64,
    cwd: &str,
    cmd: &str,
    now: i64,
) -> Result<Opened> {
    let tx = conn.transaction()?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(Opened::NoSuchDesk);
    }
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM panes", [], |r| r.get(0))?;
    if total >= EVERYWHERE {
        return Ok(Opened::NoRoomLeft);
    }
    let taken: Vec<i64> = tx
        .prepare("SELECT slot FROM panes WHERE desk_id = ?1")?
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Some(slot) = (1..=PER_DESK).find(|s| !taken.contains(s)) else {
        return Ok(Opened::DeskFull);
    };
    let id = pane_id()?;
    tx.execute(
        "INSERT INTO panes(id, desk_id, slot, cwd, cmd, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, desk_id, slot, cwd, cmd, now],
    )?;
    tx.commit()?;
    Ok(Opened::Pane(Pane {
        id,
        slot,
        cwd: cwd.to_string(),
        cmd: cmd.to_string(),
        created_at: now,
        agent_session: String::new(),
    }))
}

/// Close one pane. Its slot is free immediately, and so is its share of the
/// global cap.
pub fn close_pane(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute("DELETE FROM panes WHERE id = ?1", params![id])? > 0)
}

/// One pane and where it is, or nothing if that id is not a pane's.
pub fn pane(conn: &Connection, id: &str) -> Result<Option<Placed>> {
    Ok(conn
        .query_row(
            "SELECT p.id, p.slot, p.cwd, p.cmd, p.created_at, p.agent_session, d.id, d.name, d.root
             FROM panes p JOIN desks d ON d.id = p.desk_id WHERE p.id = ?1",
            params![id],
            |r| {
                Ok(Placed {
                    pane: row_to_pane(r, 0)?,
                    desk_id: r.get(6)?,
                    desk_name: r.get(7)?,
                    root: r.get(8)?,
                })
            },
        )
        .optional()?)
}

/// What a pane re-runs, as the reader last typed it into `Start`. Kept, so the
/// field is pre-filled with it after a restart.
pub fn set_cmd(conn: &Connection, id: &str, cmd: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE panes SET cmd = ?2 WHERE id = ?1",
        params![id, cmd.trim()],
    )? > 0)
}

/// The conversation a pane last had, as its hook said. True only when that
/// changed something, so a hook firing on every turn is one no-op UPDATE and
/// the windows are told only when there is something new to offer. The id
/// ends up on a command line (`claude --resume <id>`), so only a UUID is kept.
pub fn set_agent_session(conn: &Connection, id: &str, session: &str) -> Result<bool> {
    if !valid_session(session) {
        return Ok(false);
    }
    Ok(conn.execute(
        "UPDATE panes SET agent_session = ?2 WHERE id = ?1 AND agent_session <> ?2",
        params![id, session],
    )? > 0)
}

/// A Claude Code session id: a UUID, lowercase hex and four dashes. Nothing
/// else is stored or put on a command line.
pub fn valid_session(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// How many panes are open across every desk, which is the number the budget
/// cares about and the rail shows as `7 of 8 total`.
pub fn panes_open(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM panes", [], |r| r.get(0))?)
}

/// Every desk and every pane, gone. Called by a reset, which says the store is
/// what a machine that has never seen snyvi would have.
pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM desk_notes; DELETE FROM panes; DELETE FROM desks;")?;
    Ok(())
}

/// A desk's list: what is open first, in the order it was written, then what
/// is done, in the order it was ticked off. Removed rows are not here.
///
/// Written order rather than newest-first, because a list is read from the top
/// down and a row that jumped to the top each time one was added would move
/// the row under the reader's cursor on every keystroke they finished.
pub fn notes(conn: &Connection, desk_id: i64) -> Result<Vec<DeskNote>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, done_at, created_at FROM desk_notes
         WHERE desk_id = ?1 AND removed_at = 0
         ORDER BY CASE WHEN done_at = 0 THEN 0 ELSE 1 END, done_at, id",
    )?;
    let notes: Vec<DeskNote> = stmt
        .query_map(params![desk_id], row_to_note)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(notes)
}

/// Add a line to a desk's list. `None` when there is no such desk, or when the
/// desk is already holding as many as it keeps.
///
/// The count and the insert share a transaction for the reason the pane caps
/// do: two windows typing at once must not each see 199 and both write the
/// 200th.
pub fn add_note(
    conn: &mut Connection,
    desk_id: i64,
    text: &str,
    now: i64,
) -> Result<Option<DeskNote>> {
    let text = clip(text);
    if text.is_empty() {
        return Ok(None);
    }
    let tx = conn.transaction()?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }
    let held: i64 = tx.query_row(
        "SELECT COUNT(*) FROM desk_notes WHERE desk_id = ?1 AND removed_at = 0",
        params![desk_id],
        |r| r.get(0),
    )?;
    if held >= NOTES_PER_DESK {
        return Ok(None);
    }
    tx.execute(
        "INSERT INTO desk_notes(desk_id, text, created_at) VALUES(?1, ?2, ?3)",
        params![desk_id, text, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Some(DeskNote {
        id,
        text,
        done: false,
        created_at: now,
    }))
}

/// Rewrite a line, tick it, or untick it. Either half may be left alone, so
/// ticking a row off does not have to send the text back with it.
///
/// The desk is in the `WHERE` rather than trusted from the path: a note id
/// from the page reaches only the desk the page asked about.
pub fn set_note(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    text: Option<&str>,
    done: Option<bool>,
    now: i64,
) -> Result<bool> {
    if let Some(text) = text {
        let text = clip(text);
        // An emptied line is not a line; it is put away, the way the ✕ does,
        // so the row goes rather than sitting there blank.
        if text.is_empty() {
            return remove_note(conn, desk_id, id, now);
        }
        if conn.execute(
            "UPDATE desk_notes SET text = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
            params![desk_id, id, text],
        )? == 0
        {
            return Ok(false);
        }
    }
    let Some(done) = done else {
        return Ok(text.is_some());
    };
    // `done_at` carries the order the done half is listed in, so ticking a row
    // twice moves it to the end of that half rather than leaving it where the
    // first tick put it.
    Ok(conn.execute(
        "UPDATE desk_notes SET done_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, if done { now } else { 0 }],
    )? > 0)
}

/// Take a line off the list. The row stays: snyvi does not delete what someone
/// wrote, and `restore_note` is the other half of the toast's Undo.
pub fn remove_note(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_notes SET removed_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, now],
    )? > 0)
}

/// Put a removed line back where it was.
pub fn restore_note(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_notes SET removed_at = 0 WHERE desk_id = ?1 AND id = ?2",
        params![desk_id, id],
    )? > 0)
}

/// One line, trimmed and bounded. Cut on a character and not a byte: a list
/// written in any other language than English must not come back invalid.
fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(NOTE_CHARS) {
        Some((at, _)) => text[..at].trim_end().to_string(),
        None => text.to_string(),
    }
}

fn row_to_note(r: &rusqlite::Row) -> rusqlite::Result<DeskNote> {
    Ok(DeskNote {
        id: r.get(0)?,
        text: r.get(1)?,
        done: r.get::<_, i64>(2)? != 0,
        created_at: r.get(3)?,
    })
}

/// The folder's own name, which is what the reader right-clicked and so what
/// they expect to see in the list. A root at `/` has no last component; it is
/// the only path that needs a word of its own.
fn derive_name(root: &str) -> String {
    std::path::Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "desk".to_string())
}

/// `snyvi`, then `snyvi 2`, then `snyvi 3`. The suffix counts desks and not
/// attempts, so closing `snyvi 2` and making another gives `snyvi 2` back
/// rather than climbing forever.
fn free_name(conn: &Connection, wanted: &str) -> Result<String> {
    let taken = |name: &str| -> Result<bool> {
        Ok(conn
            .query_row("SELECT 1 FROM desks WHERE name = ?1", params![name], |_| {
                Ok(())
            })
            .optional()?
            .is_some())
    };
    if !taken(wanted)? {
        return Ok(wanted.to_string());
    }
    for n in 2.. {
        let candidate = format!("{wanted} {n}");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!("the range is unbounded")
}

/// 16 bytes from the OS, hex encoded. The same source as the capability's 32
/// for the same reason -- a secret derived from the clock is one a neighbouring
/// program can search for -- and half the length because this one identifies a
/// pane to its own child rather than proving anything.
fn pane_id() -> Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf)
        .map_err(|e| anyhow::anyhow!("reading random bytes for a pane id: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn row_to_desk(r: &rusqlite::Row) -> rusqlite::Result<Desk> {
    Ok(Desk {
        id: r.get(0)?,
        name: r.get(1)?,
        root: r.get(2)?,
        col: r.get(3)?,
        row: r.get(4)?,
        created_at: r.get(5)?,
        panes: Vec::new(),
    })
}

fn row_to_pane(r: &rusqlite::Row, at: usize) -> rusqlite::Result<Pane> {
    Ok(Pane {
        id: r.get(at)?,
        slot: r.get(at + 1)?,
        cwd: r.get(at + 2)?,
        cmd: r.get(at + 3)?,
        created_at: r.get(at + 4)?,
        agent_session: r.get(at + 5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    /// The list is read from the top down, so it is written that way: what is
    /// open in the order it was written, what is done in the order it was
    /// ticked, and the done half at the bottom.
    #[test]
    fn a_list_reads_open_first_then_done_in_the_order_it_was_ticked() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        for (i, text) in ["first", "second", "third"].iter().enumerate() {
            add_note(&mut conn, d, text, i as i64).unwrap().unwrap();
        }
        let ids: Vec<i64> = notes(&conn, d).unwrap().iter().map(|n| n.id).collect();
        // The first written is ticked last, so it is last in the done half --
        // the tick's order, not the writing's.
        set_note(&conn, d, ids[1], None, Some(true), 10).unwrap();
        set_note(&conn, d, ids[0], None, Some(true), 20).unwrap();
        let after = notes(&conn, d).unwrap();
        assert_eq!(
            after
                .iter()
                .map(|n| (n.text.as_str(), n.done))
                .collect::<Vec<_>>(),
            [("third", false), ("second", true), ("first", true)]
        );
        // Unticking puts it back among the open, in the order it was written.
        set_note(&conn, d, ids[0], None, Some(false), 30).unwrap();
        assert_eq!(notes(&conn, d).unwrap()[0].text, "first");
    }

    /// Taking a line off the list is not deleting it: the row stays, so Undo
    /// has something to put back. Nothing on this path destroys what someone
    /// wrote.
    #[test]
    fn a_line_taken_off_is_kept_and_can_come_back() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let n = add_note(&mut conn, d, "wire up the route", 0)
            .unwrap()
            .unwrap();
        assert!(remove_note(&conn, d, n.id, 1).unwrap());
        assert!(notes(&conn, d).unwrap().is_empty());
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM desk_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the row is kept, not deleted");
        assert!(restore_note(&conn, d, n.id).unwrap());
        assert_eq!(notes(&conn, d).unwrap()[0].text, "wire up the route");
        // Twice is not an error the second time, and not a second row either.
        assert!(remove_note(&conn, d, n.id, 2).unwrap());
        assert!(!remove_note(&conn, d, n.id, 3).unwrap());
    }

    /// A note id from the page reaches only the desk the page asked about.
    /// Without the desk in the `WHERE`, one window could rewrite another
    /// desk's list by guessing an integer.
    #[test]
    fn a_note_is_reachable_only_through_its_own_desk() {
        let mut conn = db();
        let mine = create(&conn, "/mine", None, 0).unwrap().id;
        let yours = create(&conn, "/yours", None, 0).unwrap().id;
        let n = add_note(&mut conn, mine, "mine", 0).unwrap().unwrap();
        assert!(!set_note(&conn, yours, n.id, Some("yours"), None, 1).unwrap());
        assert!(!remove_note(&conn, yours, n.id, 1).unwrap());
        assert_eq!(notes(&conn, mine).unwrap()[0].text, "mine");
        assert!(notes(&conn, yours).unwrap().is_empty());
    }

    /// An emptied line is not a blank row: rewriting a note to nothing takes
    /// it off the list, which is what a reader who selected all and pressed
    /// delete meant. It is still recoverable, as any other removal is.
    #[test]
    fn a_line_rewritten_to_nothing_comes_off_the_list() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let n = add_note(&mut conn, d, "something", 0).unwrap().unwrap();
        assert!(set_note(&conn, d, n.id, Some("   "), None, 1).unwrap());
        assert!(notes(&conn, d).unwrap().is_empty());
        assert!(restore_note(&conn, d, n.id).unwrap());
        assert_eq!(notes(&conn, d).unwrap()[0].text, "something");
    }

    /// The cap is a cap, an empty line is not a line, and a desk that is not
    /// a desk takes nothing. All three are the one `None`.
    #[test]
    fn a_list_is_bounded_and_takes_no_empty_line() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        assert!(add_note(&mut conn, d, "   ", 0).unwrap().is_none());
        assert!(add_note(&mut conn, d + 99, "nowhere", 0).unwrap().is_none());
        for i in 0..NOTES_PER_DESK {
            assert!(add_note(&mut conn, d, &format!("line {i}"), i)
                .unwrap()
                .is_some());
        }
        assert!(add_note(&mut conn, d, "one too many", 0).unwrap().is_none());
        // A line taken off makes room again: the cap is on the list, not on
        // everything the desk has ever held.
        let first = notes(&conn, d).unwrap()[0].id;
        remove_note(&conn, d, first, 1).unwrap();
        assert!(add_note(&mut conn, d, "room now", 0).unwrap().is_some());
    }

    /// Cut on a character, not a byte: a list written in any other language
    /// than English must not come back invalid.
    #[test]
    fn a_long_line_is_cut_where_a_character_ends() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let long = "日".repeat(NOTE_CHARS + 50);
        let n = add_note(&mut conn, d, &long, 0).unwrap().unwrap();
        assert_eq!(n.text.chars().count(), NOTE_CHARS);
        assert_eq!(notes(&conn, d).unwrap()[0].text, n.text);
    }

    /// A desk's list goes when the desk does, the way its panes do -- and by
    /// the same cascade, so a list can never outlive the desk it is about.
    #[test]
    fn closing_a_desk_takes_its_list_with_it() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        add_note(&mut conn, d, "goes with it", 0).unwrap().unwrap();
        assert!(delete(&conn, d).unwrap());
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM desk_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    fn pane(conn: &mut Connection, desk: i64) -> Opened {
        open_pane(conn, desk, "/p", "", 0).unwrap()
    }

    fn slots(conn: &Connection, desk: i64) -> Vec<i64> {
        get(conn, desk)
            .unwrap()
            .unwrap()
            .panes
            .iter()
            .map(|p| p.slot)
            .collect()
    }

    /// A pane keeps the last conversation its hook named, only a UUID, and a
    /// hook saying the same id again changes nothing and tells no one.
    #[test]
    fn a_pane_keeps_the_last_conversation_and_only_a_uuid() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap();
        let Opened::Pane(p) = pane(&mut conn, d.id) else {
            panic!("no pane")
        };
        assert_eq!(p.agent_session, "");
        let a = "0f6c1c2e-8a41-4b7e-9d3a-5e2f1b7c9a10";
        let b = "a1b2c3d4-0000-4000-8000-123456789abc";
        assert!(set_agent_session(&conn, &p.id, a).unwrap());
        assert!(
            !set_agent_session(&conn, &p.id, a).unwrap(),
            "same id again"
        );
        assert_eq!(
            super::pane(&conn, &p.id)
                .unwrap()
                .unwrap()
                .pane
                .agent_session,
            a
        );
        assert!(set_agent_session(&conn, &p.id, b).unwrap());
        assert_eq!(get(&conn, d.id).unwrap().unwrap().panes[0].agent_session, b);
        for bad in [
            "",
            "; rm -rf ~",
            "A1B2C3D4-0000-4000-8000-123456789ABC",
            "a1b2c3d4-0000-4000-8000-123456789abc ",
            "a1b2c3d4-0000-4000-8000-123456789ab$",
            "a1b2c3d400004000800-0123456789abcde",
        ] {
            assert!(!valid_session(bad), "{bad:?}");
            assert!(!set_agent_session(&conn, &p.id, bad).unwrap());
        }
        assert!(!set_agent_session(&conn, "nope", a).unwrap());
        // Closing the pane takes its conversation with it.
        assert!(close_pane(&conn, &p.id).unwrap());
        assert!(super::pane(&conn, &p.id).unwrap().is_none());
    }

    /// The gesture is a right-click on a folder, so the folder's name is the
    /// one the reader is expecting -- and two desks on one folder is the
    /// workflow `Show desk` exists for, not a mistake to refuse.
    #[test]
    fn a_desk_is_named_after_its_folder_and_the_second_one_is_numbered() {
        let conn = db();
        let a = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        let b = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        let c = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        assert_eq!(
            (a.name.as_str(), b.name.as_str(), c.name.as_str()),
            ("snyvi", "snyvi 2", "snyvi 3")
        );
        assert_ne!(a.id, b.id);
        assert_eq!(b.root, "/home/p/snyvi", "same folder, separate instance");
        // A name the reader typed is theirs, numbered only if it collides.
        let d = create(&conn, "/home/p/snyvi", Some("chores"), 0).unwrap();
        assert_eq!(d.name, "chores");
        // And the count follows the desks that exist, not the ones that did:
        // closing the second gives its name back.
        assert!(delete(&conn, b.id).unwrap());
        assert_eq!(
            create(&conn, "/home/p/snyvi", None, 0).unwrap().name,
            "snyvi 2"
        );
    }

    /// Slots, not splits. The lowest free one is taken, so closing pane 1 of
    /// four and opening another puts it back in slot 1 rather than leaving a
    /// hole and growing the grid.
    #[test]
    fn panes_fill_the_lowest_free_slot_and_the_fifth_is_refused() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        for _ in 0..PER_DESK {
            assert!(matches!(pane(&mut conn, d), Opened::Pane(_)));
        }
        assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
        assert!(matches!(pane(&mut conn, d), Opened::DeskFull));

        let first = get(&conn, d).unwrap().unwrap().panes[0].id.clone();
        assert!(close_pane(&conn, &first).unwrap());
        assert!(matches!(pane(&mut conn, d), Opened::Pane(p) if p.slot == 1));
        assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
    }

    /// The cap that protects the budget. Four per desk bounds nothing once
    /// desks are unbounded; this is the line that holds, and it answers
    /// differently from the desk's own cap because the reader has to do
    /// something different about it.
    #[test]
    fn eight_panes_is_the_whole_of_it_however_many_desks_there_are() {
        let mut conn = db();
        let desks: Vec<i64> = (0..4)
            .map(|_| create(&conn, "/p", None, 0).unwrap().id)
            .collect();
        for d in &desks[..2] {
            for _ in 0..PER_DESK {
                assert!(matches!(pane(&mut conn, *d), Opened::Pane(_)));
            }
        }
        assert_eq!(panes_open(&conn).unwrap(), EVERYWHERE);
        // A desk with three slots free is still refused, and not as "full".
        assert!(matches!(pane(&mut conn, desks[2]), Opened::NoRoomLeft));

        // Closing a whole desk gives its four back, panes and all.
        assert!(delete(&conn, desks[0]).unwrap());
        assert_eq!(panes_open(&conn).unwrap(), 4, "the cascade took its panes");
        assert!(matches!(pane(&mut conn, desks[2]), Opened::Pane(_)));
    }

    /// A pane id leaves the daemon -- Phase 3 puts it in a child's environment
    /// as `SNYVI_SESSION` -- so it is 16 bytes from the OS and not a counter.
    #[test]
    fn a_pane_id_is_random_hex_and_a_desk_id_is_not() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap();
        assert_eq!(d.id, 1, "a desk is an integer, like a project");
        let Opened::Pane(a) = pane(&mut conn, d.id) else {
            panic!("a pane on an empty desk")
        };
        let Opened::Pane(b) = pane(&mut conn, d.id) else {
            panic!("a second pane")
        };
        assert_eq!(a.id.len(), 32);
        assert!(a.id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a.id, b.id);
    }

    /// Four integers of geometry, and a drag can send anything.
    #[test]
    fn divider_fractions_are_clamped_and_a_missing_desk_says_so() {
        let conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        assert!(layout(&conn, d, 0.0, 2.5).unwrap());
        let after = get(&conn, d).unwrap().unwrap();
        assert_eq!((after.col, after.row), (MIN_FRACTION, MAX_FRACTION));
        assert!(layout(&conn, d, f64::NAN, 0.4).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().col, 0.5);
        assert!(!layout(&conn, d + 99, 0.5, 0.5).unwrap());
        assert!(!rename(&conn, d, "  ").unwrap(), "a name is not whitespace");
        assert!(rename(&conn, d, "chores").unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().name, "chores");
    }

    /// A desk that is not there is not a desk that is full.
    #[test]
    fn a_pane_on_no_desk_is_refused_without_inventing_one() {
        let mut conn = db();
        assert!(matches!(pane(&mut conn, 7), Opened::NoSuchDesk));
        assert_eq!(panes_open(&conn).unwrap(), 0);
        assert!(list(&conn).unwrap().is_empty());
    }

    /// The list is what the sidebar draws, and a desk with no panes is what
    /// every desk is for the moment after it is made.
    #[test]
    fn the_list_carries_empty_desks_and_their_panes_in_slot_order() {
        let mut conn = db();
        let a = create(&conn, "/p/one", None, 0).unwrap().id;
        let b = create(&conn, "/p/two", None, 0).unwrap().id;
        let _ = pane(&mut conn, b);
        let _ = pane(&mut conn, b);
        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, a);
        assert!(listed[0].panes.is_empty());
        assert_eq!(
            listed[1].panes.iter().map(|p| p.slot).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(listed[1].panes[0].cwd, "/p");
    }
}
