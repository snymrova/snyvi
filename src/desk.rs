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
//! which slots, what to re-run, the folder each shell had moved to -- is here,
//! because that is what a restore needs and a restore is the point. The
//! process is not: a pane comes back stopped, and the daemon never spawns a
//! shell because it woke up. The window does: a pane that lost its process to
//! a daemon going away is started again by the page when it is drawn
//! (`resume()` in ui/desk.js), since that is the reader's window asking, not a
//! timer. The screen and the PTY are in-memory beside these rows and die with
//! the daemon, which is why a pane row carries no state column at all --
//! `resume_next` is a mark for the next start, not a state.
//!
//! A desk holds four panes and there is no cap across desks. There was one,
//! eight, written against the memory budget: a truecolor cell is about 11
//! bytes, so a 2 MB scrollback is roughly 900 rows at 200 columns, and eight
//! of those was a 16 MB ceiling. It went because a reader with three projects
//! running wants three desks of panels, not a refusal; what an unwatched pane
//! costs is kept small instead -- its frames run once a second
//! (`pane::UNWATCHED_FRAME`) -- and its scrollback is still capped at 2 MB.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How many panes one desk holds. Two columns, two rows, and the third pane
/// spans the bottom rather than leaving a hole beside it.
pub const PER_DESK: i64 = 4;

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
  created_at INTEGER NOT NULL,
  full_slot INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER NOT NULL DEFAULT 0,
  left_off TEXT NOT NULL DEFAULT '',
  left_off_at INTEGER NOT NULL DEFAULT 0,
  left_off_by TEXT NOT NULL DEFAULT '',
  left_off_about TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL DEFAULT 0,
  parked_at INTEGER NOT NULL DEFAULT 0,
  parked_next TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  cmd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  agent_session TEXT NOT NULL DEFAULT '',
  resume_next INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  UNIQUE(desk_id, slot)
);
CREATE INDEX IF NOT EXISTS panes_desk ON panes(desk_id, slot);
CREATE TABLE IF NOT EXISTS panes_closed (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  cmd TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  agent_session TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desk_notes (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done_at INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_by TEXT NOT NULL DEFAULT '',
  done_commit TEXT NOT NULL DEFAULT '',
  done_doc TEXT NOT NULL DEFAULT '',
  done_evidence TEXT NOT NULL DEFAULT '',
  suggested_by TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  stage_by TEXT NOT NULL DEFAULT '',
  stage_doc TEXT NOT NULL DEFAULT '',
  stage_at INTEGER NOT NULL DEFAULT 0,
  stage_pane TEXT NOT NULL DEFAULT '',
  stage_session TEXT NOT NULL DEFAULT ''
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
    /// The slot shown alone, full view, or 0 for the grid. Kept, so a desk
    /// comes back the way it was left; a close renumbers it with the slots.
    pub full_slot: i64,
    /// Where the work on this desk was left, in a sentence: what the next
    /// session starts from. `None` when no one has said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_off: Option<LeftOff>,
    /// When the reader last opened this desk in the window, or 0 for never
    /// since there was a column for it. Home's "last touched" starts here.
    pub visited_at: i64,
    /// Put on the shelf, with the step to pick it up by: out of Home's
    /// pick-up and its chips until the reader takes it down again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parked: Option<Parked>,
    pub panes: Vec<Pane>,
}

/// A desk the reader put on the shelf, and the next step they wrote on the way
/// out: "Park it?" asks for one, so a project coming back starts from a
/// sentence rather than from nothing. Parked is not closed -- the desk, its
/// panels and its notes are all where they were.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Parked {
    pub at: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub next: String,
}

/// A line ticked off, with the desk it was on and when: what Home's log of
/// the days is made of. Only the notes still on a list -- one the reader put
/// away with ✕ is not work to show.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Done {
    pub desk_id: i64,
    pub text: String,
    pub at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub commit: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub evidence: String,
}

/// One sentence on where the work was left -- "If the tests pass, ship the
/// migration" -- that an agent says with `leave_off` at the end of a stretch,
/// or the reader writes in the desk's head. It is what the brief hands the next
/// Claude on this desk and what Home's desk card leads with. One per desk,
/// replaced by the next: a history of them is the documents'.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(default)]
pub struct LeftOff {
    pub text: String,
    pub at: i64,
    /// The agent that said it, as its MCP client names itself; empty for the
    /// reader.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub by: String,
    /// A document it is about, by id.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub about: String,
}

/// How long a Left off is, at most: one sentence.
pub const LEFT_OFF_CHARS: usize = 200;

/// A line the reader wrote on a desk's own list.
///
/// Not an aside (`crate::aside`), which is a sentence an agent leaves and the
/// daemon forgets when it restarts. This one is the reader's: it is theirs to write,
/// tick and put away, it belongs to a desk rather than to a sender, and it is
/// in the database because a list that did not survive a restart would be a
/// list no one trusted enough to write on.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DeskNote {
    pub id: i64,
    pub text: String,
    pub done: bool,
    pub created_at: i64,
    /// Who ticked it, when it was not the reader: the agent's name, as its
    /// MCP client gave it. Empty for a tick from the page, and for any line
    /// not done.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_by: String,
    /// The commit the agent said the work is in, when it ticked the line: a
    /// hash, so the reader can find it in `git log`. Only ever beside `done_by`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_commit: String,
    /// A document the agent sent about the work (its id), which the row opens.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_doc: String,
    /// Where the finished work can be seen, when the agent said: a PR, a
    /// deploy, a store page. An `http(s)` URL (`evidence_ok`).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub done_evidence: String,
    /// An agent's suggestion, not yet the reader's: shown as a ghost row with
    /// Keep and ✕, and on the list only once kept. The agent's name.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub suggested_by: String,
    /// Pictures on the line -- a screenshot of the thing it is about -- by
    /// file name in `note_images/` under the data dir (`NOTE_IMAGES`): the
    /// content's hash and its extension, so the same picture is one file.
    /// The agent's read (`pane_notes`) gets them as absolute paths.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// How far an agent has got with an open line, short of done: one of
    /// `STAGES`, or empty for a line no agent has picked up. Done stays the
    /// tick, and a done line's stage is not shown.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stage: String,
    /// The agent that set the stage, as its MCP client gave its name.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stage_by: String,
    /// The plan, when there is one: a document's id, which the line opens.
    /// Set with `planned` and kept through `working`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stage_doc: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub stage_at: i64,
    /// The pane `working` was said from, and the Claude conversation it had
    /// then: `working` is only true while that conversation is still going
    /// there (`working_in`), so a session that ended, or a panel that closed
    /// or crashed, does not leave a line saying it is being worked on. The
    /// pane goes to the page too, which settles it the same way the moment
    /// that pane's agent goes quiet, without waiting for the list again.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stage_pane: String,
    #[serde(skip)]
    pub stage_session: String,
    /// Which panel is working on it, as the reader calls it: filled in by the
    /// server from the pane, only while `working` holds.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub stage_panel: String,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// The stages an agent can say a line is at, in order: it has read the line
/// and taken it in; it has planned it, in a document; it is at work on it.
/// Done is the tick, not a stage.
pub const STAGES: [&str; 3] = ["read", "planned", "working"];

/// What an agent says with a stage: `mark_note`.
#[derive(Clone, Debug, Default)]
pub struct Mark {
    /// One of `STAGES`.
    pub stage: String,
    pub by: String,
    /// The plan's id: needed with `planned`, and checked by `doc_ok`.
    pub doc: String,
    /// The pane it was said from, and that pane's conversation.
    pub pane: String,
    pub session: String,
}

/// Where a note's pictures are kept, under the data dir. Nothing here is
/// removed when a picture comes off a line: taking it off is Undo-able, and a
/// file shared by two lines is still the other's.
pub const NOTE_IMAGES: &str = "note_images";
/// How many pictures one line holds.
pub const IMAGES_PER_NOTE: usize = 6;

/// A picture's name as `note_images` holds it: 16 hex characters and one of
/// the four extensions. Anything else never reaches a path.
pub fn image_name_ok(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() == 16
        && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && matches!(ext, "png" | "jpg" | "gif" | "webp")
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
    /// What the reader called it, or empty for the title its program sets.
    pub name: String,
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
#[derive(Debug)]
pub enum Opened {
    Pane(Pane),
    DeskFull,
    NoSuchDesk,
}

/// How long a panel's name is, at most: a head's worth, like a desk's.
pub const NAME_CHARS: usize = 80;

/// Every desk, oldest first, each with its panes in slot order.
///
/// Two queries rather than a join with a row per pane: a desk with no panes is
/// a real and common state -- it is what every desk is for the moment after it
/// is made -- and it should not need a left join to survive the trip.
pub fn list(conn: &Connection) -> Result<Vec<Desk>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DESK_COLS} FROM desks WHERE closed_at = 0 ORDER BY id"
    ))?;
    let mut desks: Vec<Desk> = stmt
        .query_map([], row_to_desk)?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT desk_id, id, slot, cwd, cmd, created_at, agent_session, name FROM panes ORDER BY desk_id, slot",
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
            &format!("SELECT {DESK_COLS} FROM desks WHERE id = ?1 AND closed_at = 0"),
            params![id],
            row_to_desk,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT id, slot, cwd, cmd, created_at, agent_session, name FROM panes WHERE desk_id = ?1 ORDER BY slot",
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
        full_slot: 0,
        left_off: None,
        visited_at: 0,
        parked: None,
        panes: Vec::new(),
    })
}

/// The reader opened this desk. Written at most once a minute: the window
/// says so on every draw of the desk, and a row rewritten on each is a write
/// for nothing.
pub fn visit(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET visited_at = ?2 WHERE id = ?1 AND closed_at = 0 AND visited_at < ?2 - 60",
        params![id, now],
    )? > 0)
}

/// Put a desk on the shelf with its next step, or take it down with `None`.
/// The state it replaced is returned, for an Undo; `None` when there is no
/// such desk.
pub fn park(conn: &Connection, id: i64, to: Option<&Parked>) -> Result<Option<Option<Parked>>> {
    let Some(desk) = get(conn, id)? else {
        return Ok(None);
    };
    let (at, next) = match to {
        Some(p) => (p.at, clip_to(&p.next, LEFT_OFF_CHARS)),
        None => (0, String::new()),
    };
    conn.execute(
        "UPDATE desks SET parked_at = ?2, parked_next = ?3 WHERE id = ?1",
        params![id, at, next],
    )?;
    Ok(Some(desk.parked))
}

/// Every line ticked on an open desk since `since`, oldest first.
pub fn done_since(conn: &Connection, since: i64) -> Result<Vec<Done>> {
    let mut stmt = conn.prepare(
        "SELECT n.desk_id, n.text, n.done_at, n.done_by, n.done_commit, n.done_doc, n.done_evidence
         FROM desk_notes n JOIN desks d ON d.id = n.desk_id
         WHERE n.done_at >= ?1 AND n.done_at != 0 AND n.removed_at = 0 AND d.closed_at = 0
         ORDER BY n.done_at, n.id",
    )?;
    let rows = stmt
        .query_map(params![since], |r| {
            Ok(Done {
                desk_id: r.get(0)?,
                text: r.get(1)?,
                at: r.get(2)?,
                by: r.get(3)?,
                commit: r.get(4)?,
                doc: r.get(5)?,
                evidence: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
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

/// Where the two dividers sit, and which slot is in full view. Clamped,
/// because a fraction that came from a drag can arrive as anything and a pane
/// no one can see is not a pane. `full` left out keeps what is there; a slot
/// out of range is the grid.
pub fn layout(conn: &Connection, id: i64, col: f64, row: f64, full: Option<i64>) -> Result<bool> {
    let clamp = |f: f64| {
        if f.is_finite() {
            f.clamp(MIN_FRACTION, MAX_FRACTION)
        } else {
            0.5
        }
    };
    let full = full.map(|s| if (1..=PER_DESK).contains(&s) { s } else { 0 });
    Ok(conn.execute(
        "UPDATE desks SET col = ?2, row = ?3, full_slot = COALESCE(?4, full_slot) WHERE id = ?1",
        params![id, clamp(col), clamp(row), full],
    )? > 0)
}

/// Close a desk: out of every list, its panes closed with it, and nothing
/// deleted. snyvi does not delete what someone wrote, and a desk's list is
/// that: the row stays with `closed_at` set, its notes stay on it, and each
/// pane goes to `panes_closed` on the same instant as the desk, which is how
/// `reopen` knows which ones went with it. `prune` ends it for good
/// (`prune_desks`), and that is where the `ON DELETE CASCADE` still does its
/// work. The ids of the panes it closed, for the caller to stop them and keep
/// their text; `None` when the id is not an open desk's.
pub fn close(conn: &mut Connection, id: i64, now: i64) -> Result<Option<Vec<String>>> {
    let tx = conn.transaction()?;
    if tx.execute(
        "UPDATE desks SET closed_at = ?2 WHERE id = ?1 AND closed_at = 0",
        params![id, now],
    )? == 0
    {
        return Ok(None);
    }
    let ids: Vec<String> = tx
        .prepare("SELECT id FROM panes WHERE desk_id = ?1 ORDER BY slot")?
        .query_map(params![id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    // One at a time, in slot order: `reopen` reads them back in the order
    // they were written, which puts each where it was.
    for p in &ids {
        tx.execute(
            "INSERT OR REPLACE INTO panes_closed(id, desk_id, cwd, cmd, name, agent_session, created_at, closed_at)
             SELECT id, desk_id, cwd, cmd, name, agent_session, created_at, ?2 FROM panes WHERE id = ?1",
            params![p, now],
        )?;
    }
    tx.execute("DELETE FROM panes WHERE desk_id = ?1", params![id])?;
    tx.commit()?;
    Ok(Some(ids))
}

/// A closed desk back in the list, with its notes, and with the panes that
/// closed with it back in their order, stopped, as a restart brings a pane
/// back. A panel closed on its own before the desk went stays in the Removed
/// list, where it was. False when the id is not a closed desk's.
pub fn reopen(conn: &mut Connection, id: i64) -> Result<bool> {
    let tx = conn.transaction()?;
    let Some(at) = tx
        .query_row(
            "SELECT closed_at FROM desks WHERE id = ?1 AND closed_at != 0",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(false);
    };
    tx.execute("UPDATE desks SET closed_at = 0 WHERE id = ?1", params![id])?;
    let back: Vec<String> = tx
        .prepare(
            "SELECT id FROM panes_closed WHERE desk_id = ?1 AND closed_at = ?2
             ORDER BY rowid LIMIT ?3",
        )?
        .query_map(params![id, at, PER_DESK], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (i, p) in back.iter().enumerate() {
        tx.execute(
            "INSERT INTO panes(id, desk_id, slot, cwd, cmd, name, agent_session, created_at)
             SELECT id, desk_id, ?2, cwd, cmd, name, agent_session, created_at FROM panes_closed WHERE id = ?1",
            params![p, i as i64 + 1],
        )?;
        tx.execute("DELETE FROM panes_closed WHERE id = ?1", params![p])?;
    }
    tx.commit()?;
    Ok(true)
}

/// (desk, name, root, closed at)
pub type ClosedDesk = (i64, String, String, i64);

/// Desks closed and not yet pruned, newest first, for `GET /api/removed`.
pub fn closed_desks(conn: &Connection, limit: usize) -> Result<Vec<ClosedDesk>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, root, closed_at FROM desks WHERE closed_at != 0 ORDER BY closed_at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Desks closed before `before`, ended for good unless `dry_run`, with their
/// notes and closed panes by the cascade: (id, name) to print. `prune` runs
/// `prune_closed` first, so the panes' text is removed by the ids it returns.
pub fn prune_desks(conn: &Connection, before: i64, dry_run: bool) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, name FROM desks WHERE closed_at != 0 AND closed_at < ?1 ORDER BY closed_at",
    )?;
    let gone: Vec<(i64, String)> = stmt
        .query_map(params![before], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !dry_run {
        conn.execute(
            "DELETE FROM desks WHERE closed_at != 0 AND closed_at < ?1",
            params![before],
        )?;
    }
    Ok(gone)
}

/// Open a pane on a desk, in the lowest free slot.
///
/// The desk's four is read inside the same transaction that writes the row,
/// so two requests that arrive together cannot each see three panes and both
/// make a fourth.
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
            "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(Opened::NoSuchDesk);
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
        name: String::new(),
    }))
}

/// Move the pane at slot `from` to slot `to` on one desk, and the pane that
/// was at `to`, if any, to `from`. The slot is the pane's place and its number
/// both -- pane 2 is always the one in position 2, the one ⌃⌥2 reaches -- so a
/// move renumbers. Returns false when there is no pane at `from` or a slot is
/// out of range. Runs inside the caller's transaction, which also moves what
/// the panes sent (`Store::move_pane`); `UNIQUE(desk_id, slot)` is checked
/// row by row, so the pane moving out goes through slot 0 first.
pub fn move_pane(tx: &rusqlite::Transaction, desk_id: i64, from: i64, to: i64) -> Result<bool> {
    let range = 1..=PER_DESK;
    if !range.contains(&from) || !range.contains(&to) {
        return Ok(false);
    }
    let moving: Option<String> = tx
        .query_row(
            "SELECT id FROM panes WHERE desk_id = ?1 AND slot = ?2",
            params![desk_id, from],
            |r| r.get(0),
        )
        .optional()?;
    let Some(moving) = moving else {
        return Ok(false);
    };
    if from == to {
        return Ok(true);
    }
    tx.execute("UPDATE panes SET slot = 0 WHERE id = ?1", params![moving])?;
    tx.execute(
        "UPDATE panes SET slot = ?3 WHERE desk_id = ?1 AND slot = ?2",
        params![desk_id, to, from],
    )?;
    tx.execute(
        "UPDATE panes SET slot = ?2 WHERE id = ?1",
        params![moving, to],
    )?;
    // Full view is on a pane, not a position: it goes where that pane went.
    tx.execute(
        "UPDATE desks SET full_slot = CASE full_slot WHEN ?2 THEN ?3 WHEN ?3 THEN ?2 ELSE full_slot END WHERE id = ?1",
        params![desk_id, from, to],
    )?;
    Ok(true)
}

/// Close one pane: its row goes to `panes_closed`, where Undo finds it and
/// `prune` ends it, and the panes after it close up, so the slots stay 1 to n
/// and `⌃⌥3` is always the third one on screen. The desk's full view follows
/// its slot, or goes back to the grid if it was this one. Returns the desk and
/// the slot it held, for the caller to renumber what the panes sent in the
/// same transaction (`Store::close_pane`); `None` if the id is not a pane's.
///
/// Each shift moves a pane into the slot just vacated, so `UNIQUE(desk_id,
/// slot)` holds row by row, the reasoning `move_pane` gives.
pub fn close_pane(tx: &rusqlite::Transaction, id: &str, now: i64) -> Result<Option<(i64, i64)>> {
    let Some((desk_id, slot)) = tx
        .query_row(
            "SELECT desk_id, slot FROM panes WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    tx.execute(
        "INSERT OR REPLACE INTO panes_closed(id, desk_id, cwd, cmd, name, agent_session, created_at, closed_at)
         SELECT id, desk_id, cwd, cmd, name, agent_session, created_at, ?2 FROM panes WHERE id = ?1",
        params![id, now],
    )?;
    tx.execute("DELETE FROM panes WHERE id = ?1", params![id])?;
    for s in slot + 1..=PER_DESK {
        tx.execute(
            "UPDATE panes SET slot = ?3 WHERE desk_id = ?1 AND slot = ?2",
            params![desk_id, s, s - 1],
        )?;
    }
    tx.execute(
        "UPDATE desks SET full_slot = CASE WHEN full_slot = ?2 THEN 0 WHEN full_slot > ?2 THEN full_slot - 1 ELSE full_slot END WHERE id = ?1",
        params![desk_id, slot],
    )?;
    Ok(Some((desk_id, slot)))
}

/// What came of asking for a closed pane back.
#[derive(Debug)]
pub enum Restored {
    Pane(Pane),
    /// Its desk filled up while it was closed.
    DeskFull,
    /// Not a closed pane: pruned, already back, or never one.
    Gone,
}

/// A closed pane back on its desk, in the lowest free slot, as `open_pane`
/// picks one. Stopped: it comes back the way a restart brings a pane back,
/// its saved text greyed and Start offered.
pub fn restore_pane(conn: &mut Connection, id: &str) -> Result<Restored> {
    let tx = conn.transaction()?;
    let Some(desk_id) = tx
        .query_row(
            "SELECT desk_id FROM panes_closed WHERE id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(Restored::Gone);
    };
    let taken: Vec<i64> = tx
        .prepare("SELECT slot FROM panes WHERE desk_id = ?1")?
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Some(slot) = (1..=PER_DESK).find(|s| !taken.contains(s)) else {
        return Ok(Restored::DeskFull);
    };
    tx.execute(
        "INSERT INTO panes(id, desk_id, slot, cwd, cmd, name, agent_session, created_at)
         SELECT id, desk_id, ?2, cwd, cmd, name, agent_session, created_at FROM panes_closed WHERE id = ?1",
        params![id, slot],
    )?;
    tx.execute("DELETE FROM panes_closed WHERE id = ?1", params![id])?;
    let pane = tx.query_row(
        "SELECT id, slot, cwd, cmd, created_at, agent_session, name FROM panes WHERE id = ?1",
        params![id],
        |r| row_to_pane(r, 0),
    )?;
    tx.commit()?;
    Ok(Restored::Pane(pane))
}

/// The closed panes of one desk.
#[cfg(test)]
fn closed_on(conn: &Connection, desk_id: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT id FROM panes_closed WHERE desk_id = ?1")?;
    let ids = stmt
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// Closed panes older than `before`, ended for good unless `dry_run`: their
/// ids, for the caller to remove their text, and a name to print.
pub fn prune_closed(
    conn: &Connection,
    before: i64,
    dry_run: bool,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, COALESCE(NULLIF(c.name, ''), NULLIF(c.cmd, ''), 'shell') || ' on ' || d.name
         FROM panes_closed c JOIN desks d ON d.id = c.desk_id WHERE c.closed_at < ?1 ORDER BY c.closed_at",
    )?;
    let gone: Vec<(String, String)> = stmt
        .query_map(params![before], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !dry_run {
        conn.execute(
            "DELETE FROM panes_closed WHERE closed_at < ?1",
            params![before],
        )?;
    }
    Ok(gone)
}

/// Call a pane something. Trimmed, one line, cut at `NAME_CHARS`; empty goes
/// back to the title its program sets.
pub fn rename_pane(conn: &Connection, id: &str, name: &str) -> Result<bool> {
    let name: String = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NAME_CHARS)
        .collect();
    Ok(conn.execute(
        "UPDATE panes SET name = ?2 WHERE id = ?1",
        params![id, name],
    )? > 0)
}

/// One pane and where it is, or nothing if that id is not a pane's.
pub fn pane(conn: &Connection, id: &str) -> Result<Option<Placed>> {
    Ok(conn
        .query_row(
            "SELECT p.id, p.slot, p.cwd, p.cmd, p.created_at, p.agent_session, p.name, d.id, d.name, d.root
             FROM panes p JOIN desks d ON d.id = p.desk_id WHERE p.id = ?1",
            params![id],
            |r| {
                Ok(Placed {
                    pane: row_to_pane(r, 0)?,
                    desk_id: r.get(7)?,
                    desk_name: r.get(8)?,
                    root: r.get(9)?,
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

/// Mark the panes a planned restart should bring back as `claude --resume`:
/// the ones given, and of those only the ones whose conversation is known,
/// since a mark on a pane with nothing to resume would start `claude
/// --resume ` with no id. Every other mark is cleared in the same statement,
/// so the table only ever describes the one restart in progress.
pub fn mark_resume(conn: &Connection, ids: &[String]) -> Result<usize> {
    conn.execute(
        "UPDATE panes SET resume_next = 0 WHERE resume_next <> 0",
        [],
    )?;
    let mut n = 0;
    for id in ids {
        n += conn.execute(
            "UPDATE panes SET resume_next = 1 WHERE id = ?1 AND agent_session <> ''",
            params![id],
        )?;
    }
    Ok(n)
}

/// Mark the panes that had Claude open when the daemon stopped without
/// planning to -- `snyvi stop`, a signal, a reboot -- as ones to *offer* back
/// (`resume_next = 2`), where a planned restart's mark (1) starts them as the
/// conversation. A pane already marked either way keeps its mark.
pub fn mark_offer(conn: &Connection, ids: &[String]) -> Result<usize> {
    let mut n = 0;
    for id in ids {
        n += conn.execute(
            "UPDATE panes SET resume_next = 2 WHERE id = ?1 AND resume_next = 0 AND agent_session <> ''",
            params![id],
        )?;
    }
    Ok(n)
}

/// The marks the last daemon left: the planned restart's panes, then the ones
/// to offer. Read once by the daemon that comes up, which keeps them in the
/// runtime from there (`pane::Panes::mark_resume`, `mark_offer`) and clears
/// them here (`clear_resume`) only once it holds the port: a successor that
/// dies before then is started again, and must find them again.
pub fn read_resume(conn: &Connection) -> Result<(Vec<String>, Vec<String>)> {
    let mut stmt =
        conn.prepare("SELECT id, resume_next FROM panes WHERE resume_next <> 0 ORDER BY id")?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (planned, offered): (Vec<_>, Vec<_>) = rows.into_iter().partition(|(_, k)| *k == 1);
    Ok((
        planned.into_iter().map(|(id, _)| id).collect(),
        offered.into_iter().map(|(id, _)| id).collect(),
    ))
}

/// Every mark cleared, so a daemon that crashes later does not find them
/// again a day on. What is still unspent at the next exit is written back.
pub fn clear_resume(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE panes SET resume_next = 0 WHERE resume_next <> 0",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
fn take_resume(conn: &Connection) -> Result<(Vec<String>, Vec<String>)> {
    let marks = read_resume(conn)?;
    clear_resume(conn)?;
    Ok(marks)
}

/// Where a pane's shell has gone, so its next start is there: the folder the
/// kernel reported on the git tick, or at shutdown. True only when it moved.
pub fn set_cwd(conn: &Connection, id: &str, cwd: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE panes SET cwd = ?2 WHERE id = ?1 AND cwd <> ?2",
        params![id, cwd],
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

/// How many panes are open across every desk, which the rail's tooltip
/// shows as `7 open on every desk`.
pub fn panes_open(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM panes", [], |r| r.get(0))?)
}

/// Every desk and every pane, gone. Called by a reset, which says the store is
/// what a machine that has never seen snyvi would have.
pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM desk_notes; DELETE FROM panes_closed; DELETE FROM panes; DELETE FROM desks;",
    )?;
    Ok(())
}

/// A desk's list: what is open first, in the order it was written, then what
/// an agent suggested and the reader has not yet kept, then what is done, in
/// the order it was ticked off. Removed rows are not here.
///
/// Written order rather than newest-first, because a list is read from the top
/// down and a row that jumped to the top each time one was added would move
/// the row under the reader's cursor on every keystroke they finished.
pub fn notes(conn: &Connection, desk_id: i64) -> Result<Vec<DeskNote>> {
    let mut stmt = conn.prepare(
        "SELECT id, text, done_at, created_at, done_by, done_commit, done_doc, done_evidence, suggested_by, images,
                stage, stage_by, stage_doc, stage_at, stage_pane, stage_session FROM desk_notes
         WHERE desk_id = ?1 AND removed_at = 0
         ORDER BY CASE WHEN done_at != 0 THEN 2 WHEN suggested_by != '' THEN 1 ELSE 0 END, done_at, id",
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
            "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
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
        created_at: now,
        ..DeskNote::default()
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
    // A tick from the page is the reader's own: whoever ticked it before, it
    // is theirs now, and an untick clears it.
    Ok(conn.execute(
        "UPDATE desk_notes SET done_at = ?3, done_by = '', done_commit = '', done_doc = '', done_evidence = '', suggested_by = ''
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, if done { now } else { 0 }],
    )? > 0)
}

/// What an agent says with its tick: who it is, and, if it has them, the
/// commit the work went into and a document it sent about it.
#[derive(Clone, Debug, Default)]
pub struct Tick {
    pub by: String,
    /// Checked by `commit_ok` before it gets here; kept as given, lowercased.
    pub commit: String,
    /// Checked by `doc_ok`.
    pub doc: String,
    /// Checked by `evidence_ok`.
    pub evidence: String,
}

/// A commit hash as `git log` prints one, short or full: 7 to 40 hex digits
/// and nothing else. A branch name or a sentence is not a commit, and the row
/// that shows it would be showing something no one can look up.
pub fn commit_ok(commit: &str) -> bool {
    (7..=40).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A document's id as `store::new_id` makes one: ten hex digits.
pub fn doc_ok(doc: &str) -> bool {
    doc.len() == 10 && doc.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Where finished work can be seen: an `http` or `https` URL, one line, with
/// a host, and short enough to be a link and not a payload. Anything else --
/// a `file:` path, a `javascript:` link, a sentence -- is not something a row
/// should open.
pub fn evidence_ok(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    url.len() <= 500
        && rest.is_some_and(|r| !r.is_empty() && !r.starts_with('/') && !r.starts_with('.'))
        && url.bytes().all(|b| b.is_ascii_graphic())
}

/// An agent ticks a line on its own desk's list: done, by whom, and where the
/// work is. Only ever done -- an agent cannot untick, write, add or take a
/// line off -- and only an open line: one the reader already ticked stays
/// theirs. False when the line is not on this desk's list, or is already done.
pub fn tick_note(conn: &Connection, desk_id: i64, id: i64, tick: &Tick, now: i64) -> Result<bool> {
    let by = if tick.by.trim().is_empty() {
        "an agent"
    } else {
        tick.by.trim()
    };
    let by: String = by.chars().take(60).collect();
    let commit = if commit_ok(&tick.commit) {
        tick.commit.to_ascii_lowercase()
    } else {
        String::new()
    };
    let doc = if doc_ok(&tick.doc) {
        tick.doc.to_ascii_lowercase()
    } else {
        String::new()
    };
    let evidence = if evidence_ok(&tick.evidence) {
        tick.evidence.clone()
    } else {
        String::new()
    };
    // A suggestion is not the reader's list yet, so it is not the agent's to
    // tick: it is kept, or not, first.
    Ok(conn.execute(
        "UPDATE desk_notes SET done_at = ?3, done_by = ?4, done_commit = ?5, done_doc = ?6, done_evidence = ?7
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND done_at = 0 AND suggested_by = ''",
        params![desk_id, id, now, by, commit, doc, evidence],
    )? > 0)
}

/// An agent says how far it has got with a line on its own desk's list:
/// read, planned (with the plan's id), or working. Only an open line the
/// reader has kept -- a done one is done, and only the reader unticks -- and
/// any stage from any other, so an agent can step back from `working` to
/// `planned` when it stops. The plan stays with the line when a later stage
/// comes without one. False when the line is not open on this desk.
pub fn mark_note(conn: &Connection, desk_id: i64, id: i64, mark: &Mark, now: i64) -> Result<bool> {
    if !STAGES.contains(&mark.stage.as_str()) || (mark.stage == "planned" && !doc_ok(&mark.doc)) {
        return Ok(false);
    }
    let by = if mark.by.trim().is_empty() {
        "an agent"
    } else {
        mark.by.trim()
    };
    let by: String = by.chars().take(60).collect();
    let doc = if doc_ok(&mark.doc) {
        mark.doc.to_ascii_lowercase()
    } else {
        String::new()
    };
    let working = mark.stage == "working";
    Ok(conn.execute(
        "UPDATE desk_notes SET stage = ?3, stage_by = ?4, stage_doc = CASE WHEN ?5 != '' THEN ?5 ELSE stage_doc END,
                stage_at = ?6, stage_pane = ?7, stage_session = ?8
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND done_at = 0 AND suggested_by = ''",
        params![
            desk_id,
            id,
            mark.stage,
            by,
            doc,
            now,
            if working { mark.pane.as_str() } else { "" },
            if working { mark.session.as_str() } else { "" }
        ],
    )? > 0)
}

/// A `working` line whose conversation has ended is back at the stage before
/// it: planned, when there is a plan, and read otherwise. `live` is whether
/// the pane it was said from is still running that conversation.
pub fn settle_stage(n: &mut DeskNote, live: bool) {
    if n.stage == "working" && !live {
        n.stage = if n.stage_doc.is_empty() { "read" } else { "planned" }.into();
    }
}

/// How many suggestions a desk holds waiting for the reader. A few, so an
/// agent cannot fill the list with its own ideas while the reader is away:
/// past this it is told to wait until one is kept or put away.
pub const SUGGESTIONS_PER_DESK: i64 = 3;

/// What came of an agent suggesting a line.
#[derive(Debug, PartialEq)]
pub enum Suggested {
    Note(DeskNote),
    /// As many waiting as a desk holds, or the list is full.
    Full,
    Empty,
    NoSuchDesk,
}

/// An agent suggests a line for this desk's list: `suggest_desk_note`. It
/// lands as a suggestion -- a ghost row with Keep and ✕ -- and is the reader's
/// only once they keep it. The list's cap counts it, as it counts any row.
pub fn suggest_note(
    conn: &mut Connection,
    desk_id: i64,
    text: &str,
    by: &str,
    now: i64,
) -> Result<Suggested> {
    let text = clip(text);
    if text.is_empty() {
        return Ok(Suggested::Empty);
    }
    let by = if by.trim().is_empty() {
        "an agent"
    } else {
        by.trim()
    };
    let by: String = by.chars().take(60).collect();
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
        return Ok(Suggested::NoSuchDesk);
    }
    let (held, waiting): (i64, i64) = tx.query_row(
        "SELECT COUNT(*), COALESCE(SUM(suggested_by != '' AND done_at = 0), 0) FROM desk_notes
         WHERE desk_id = ?1 AND removed_at = 0",
        params![desk_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if held >= NOTES_PER_DESK || waiting >= SUGGESTIONS_PER_DESK {
        return Ok(Suggested::Full);
    }
    tx.execute(
        "INSERT INTO desk_notes(desk_id, text, created_at, suggested_by) VALUES(?1, ?2, ?3, ?4)",
        params![desk_id, text, now, by],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(Suggested::Note(DeskNote {
        id,
        text,
        created_at: now,
        suggested_by: by,
        ..DeskNote::default()
    }))
}

/// The reader keeps a suggestion: it is an ordinary line of theirs from here,
/// among what is open, in the order it was written. Its ✕ is `remove_note`, as any row's.
pub fn keep_note(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_notes SET suggested_by = '' WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND suggested_by != ''",
        params![desk_id, id],
    )? > 0)
}

/// Say where the work on a desk was left, replacing what was there; an empty
/// text clears it. The one before is returned, so a clear -- or an agent's
/// line over the reader's -- has an Undo: `set_left_off` again with it.
pub fn set_left_off(
    conn: &Connection,
    desk_id: i64,
    to: &LeftOff,
) -> Result<Option<Option<LeftOff>>> {
    let text = clip_to(&to.text, LEFT_OFF_CHARS);
    let by: String = to.by.trim().chars().take(60).collect();
    let about = if doc_ok(&to.about) {
        to.about.to_ascii_lowercase()
    } else {
        String::new()
    };
    let Some(desk) = get(conn, desk_id)? else {
        return Ok(None);
    };
    let (at, by, about) = if text.is_empty() {
        (0, String::new(), String::new())
    } else {
        (to.at, by, about)
    };
    conn.execute(
        "UPDATE desks SET left_off = ?2, left_off_at = ?3, left_off_by = ?4, left_off_about = ?5 WHERE id = ?1",
        params![desk_id, text, at, by, about],
    )?;
    Ok(Some(desk.left_off))
}

/// Take a line off the list. The row stays: snyvi does not delete what someone
/// wrote, and `restore_note` is the other half of the toast's Undo.
pub fn remove_note(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_notes SET removed_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, now],
    )? > 0)
}

/// (desk, note, desk name, text, removed at)
pub type RemovedNote = (i64, i64, String, String, i64);
/// (pane, desk, desk name, what it was called, closed at)
pub type ClosedPane = (String, i64, String, String, i64);

/// Notes taken off a desk's list, newest first: what `GET /api/removed`
/// offers back beside the documents. Each is (desk, note, desk name, text,
/// removed at); `restore_note` puts one back.
pub fn removed_notes(conn: &Connection, limit: usize) -> Result<Vec<RemovedNote>> {
    let mut stmt = conn.prepare(
        "SELECT n.desk_id, n.id, d.name, n.text, n.removed_at FROM desk_notes n JOIN desks d ON d.id = n.desk_id
         WHERE n.removed_at != 0 AND d.closed_at = 0 ORDER BY n.removed_at DESC, n.id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Panels closed and not yet pruned, newest first, for the same list: (pane,
/// desk, desk name, what it was called, closed at). `restore_pane` reopens one.
pub fn closed_panes(conn: &Connection, limit: usize) -> Result<Vec<ClosedPane>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.desk_id, d.name, COALESCE(NULLIF(c.name, ''), NULLIF(c.cmd, ''), 'shell'), c.closed_at
         FROM panes_closed c JOIN desks d ON d.id = c.desk_id WHERE d.closed_at = 0 ORDER BY c.closed_at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
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

/// One line of at most `chars` characters: runs of whitespace, newlines
/// among them, are one space.
fn clip_to(text: &str, chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(chars) {
        Some((at, _)) => text[..at].trim_end().to_string(),
        None => text,
    }
}

fn row_to_note(r: &rusqlite::Row) -> rusqlite::Result<DeskNote> {
    Ok(DeskNote {
        id: r.get(0)?,
        text: r.get(1)?,
        done: r.get::<_, i64>(2)? != 0,
        created_at: r.get(3)?,
        done_by: r.get(4)?,
        done_commit: r.get(5)?,
        done_doc: r.get(6)?,
        done_evidence: r.get(7)?,
        suggested_by: r.get(8)?,
        images: r.get::<_, String>(9)?.split_whitespace().map(String::from).collect(),
        stage: r.get(10)?,
        stage_by: r.get(11)?,
        stage_doc: r.get(12)?,
        stage_at: r.get(13)?,
        stage_pane: r.get(14)?,
        stage_session: r.get(15)?,
        stage_panel: String::new(),
    })
}

/// Put one more picture on a line, at the end. `None` when there is no such
/// line or it already holds `IMAGES_PER_NOTE`; the list it has now otherwise.
pub fn add_note_image(conn: &Connection, desk_id: i64, id: i64, name: &str) -> Result<Option<Vec<String>>> {
    let had: Option<String> = conn
        .query_row(
            "SELECT images FROM desk_notes WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
            params![desk_id, id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(had) = had else { return Ok(None) };
    let mut list: Vec<String> = had.split_whitespace().map(String::from).collect();
    if !list.iter().any(|n| n == name) {
        list.push(name.to_string());
    }
    if !set_note_images(conn, desk_id, id, &list)? {
        return Ok(None);
    }
    Ok(Some(list))
}

/// A line's pictures, replaced whole: an added one appended, a removed one
/// left out, and Undo sending back the list it had. Names that are not a
/// picture's are refused rather than kept. False when there is no such line.
pub fn set_note_images(conn: &Connection, desk_id: i64, id: i64, images: &[String]) -> Result<bool> {
    if images.len() > IMAGES_PER_NOTE || !images.iter().all(|n| image_name_ok(n)) {
        return Ok(false);
    }
    let mut seen = Vec::new();
    for n in images {
        if !seen.contains(n) {
            seen.push(n.clone());
        }
    }
    Ok(conn.execute(
        "UPDATE desk_notes SET images = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, seen.join(" ")],
    )? > 0)
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
            .query_row(
                "SELECT 1 FROM desks WHERE name = ?1 AND closed_at = 0",
                params![name],
                |_| Ok(()),
            )
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

const DESK_COLS: &str =
    "id, name, root, col, row, created_at, full_slot, left_off, left_off_at, left_off_by, left_off_about, visited_at, parked_at, parked_next";

fn row_to_desk(r: &rusqlite::Row) -> rusqlite::Result<Desk> {
    let text: String = r.get(7)?;
    Ok(Desk {
        id: r.get(0)?,
        name: r.get(1)?,
        root: r.get(2)?,
        col: r.get(3)?,
        row: r.get(4)?,
        created_at: r.get(5)?,
        full_slot: r.get(6)?,
        left_off: if text.is_empty() {
            None
        } else {
            Some(LeftOff {
                text,
                at: r.get(8)?,
                by: r.get(9)?,
                about: r.get(10)?,
            })
        },
        visited_at: r.get(11)?,
        parked: match r.get::<_, i64>(12)? {
            0 => None,
            at => Some(Parked {
                at,
                next: r.get(13)?,
            }),
        },
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
        name: r.get(at + 6)?,
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

    /// A line's pictures: by name only, a name that is a picture's, each once,
    /// up to the cap, on its own desk's lines; taking one off and Undo are
    /// both the list set whole.
    #[test]
    fn a_line_holds_its_pictures_by_name_and_gives_them_back() {
        let mut conn = db();
        let mine = create(&conn, "/mine", None, 0).unwrap().id;
        let yours = create(&conn, "/yours", None, 0).unwrap().id;
        let n = add_note(&mut conn, mine, "this spacing", 0).unwrap().unwrap();
        let a = "0123456789abcdef.png".to_string();
        let b = "fedcba9876543210.webp".to_string();
        assert_eq!(add_note_image(&conn, mine, n.id, &a).unwrap(), Some(vec![a.clone()]));
        // The same picture twice is on the line once.
        assert_eq!(add_note_image(&conn, mine, n.id, &a).unwrap(), Some(vec![a.clone()]));
        assert_eq!(add_note_image(&conn, mine, n.id, &b).unwrap(), Some(vec![a.clone(), b.clone()]));
        assert_eq!(notes(&conn, mine).unwrap()[0].images, [a.clone(), b.clone()]);
        // Not across desks, and nothing that could be a path.
        assert_eq!(add_note_image(&conn, yours, n.id, &a).unwrap(), None);
        for bad in ["../../etc/passwd", "0123456789abcdef.svg", "0123456789ABCDEF.png", "abc.png", "0123456789abcdef"] {
            assert!(!image_name_ok(bad), "{bad}");
            assert!(!set_note_images(&conn, mine, n.id, &[bad.to_string()]).unwrap());
        }
        // One off, and Undo puts the list back as it was.
        assert!(set_note_images(&conn, mine, n.id, &[b.clone()]).unwrap());
        assert_eq!(notes(&conn, mine).unwrap()[0].images, [b.clone()]);
        assert!(set_note_images(&conn, mine, n.id, &[a.clone(), b.clone()]).unwrap());
        assert_eq!(notes(&conn, mine).unwrap()[0].images, [a.clone(), b]);
        // The cap.
        let many: Vec<String> = (0..=IMAGES_PER_NOTE).map(|i| format!("{i:016x}.png")).collect();
        assert!(!set_note_images(&conn, mine, n.id, &many).unwrap());
        assert!(set_note_images(&conn, mine, n.id, &many[..IMAGES_PER_NOTE]).unwrap());
        assert_eq!(add_note_image(&conn, mine, n.id, &a).unwrap(), None, "a full line takes no more");
    }

    /// An agent ticks only: an open line on its own desk, once, with its name
    /// kept -- and the reader's untick or re-tick makes the line theirs again.
    #[test]
    fn an_agent_ticks_an_open_line_on_its_own_desk_and_nothing_else() {
        let mut conn = db();
        let mine = create(&conn, "/mine", None, 0).unwrap().id;
        let yours = create(&conn, "/yours", None, 0).unwrap().id;
        let n = add_note(&mut conn, mine, "wire the route", 0)
            .unwrap()
            .unwrap();
        assert!(
            !tick_note(&conn, yours, n.id, &by("claude-code"), 1).unwrap(),
            "not across desks"
        );
        assert!(tick_note(&conn, mine, n.id, &by("claude-code"), 1).unwrap());
        let got = &notes(&conn, mine).unwrap()[0];
        assert!(got.done);
        assert_eq!(got.done_by, "claude-code");
        assert!(
            !tick_note(&conn, mine, n.id, &by("claude-code"), 2).unwrap(),
            "a done line stays as it is"
        );

        // The reader unticks it: open again, and no one's but theirs.
        assert!(set_note(&conn, mine, n.id, None, Some(false), 3).unwrap());
        let got = &notes(&conn, mine).unwrap()[0];
        assert!(!got.done);
        assert_eq!(got.done_by, "");
        // A tick from nobody in particular still says an agent did it.
        assert!(tick_note(&conn, mine, n.id, &by("  "), 4).unwrap());
        assert_eq!(notes(&conn, mine).unwrap()[0].done_by, "an agent");
        // A line taken off the list cannot be ticked.
        assert!(set_note(&conn, mine, n.id, None, Some(false), 5).unwrap());
        assert!(remove_note(&conn, mine, n.id, 6).unwrap());
        assert!(!tick_note(&conn, mine, n.id, &by("claude-code"), 7).unwrap());
    }

    fn by(name: &str) -> Tick {
        Tick {
            by: name.into(),
            ..Tick::default()
        }
    }

    fn mark(stage: &str, doc: &str) -> Mark {
        Mark {
            stage: stage.into(),
            by: "claude-code".into(),
            doc: doc.into(),
            pane: "p1".into(),
            session: "s1".into(),
        }
    }

    /// An agent says how far it has got: read, planned with the plan's id,
    /// working from its pane. Any stage from any other, on an open line of
    /// its own desk that the reader has kept; never on a done one.
    #[test]
    fn a_stage_is_read_planned_or_working_and_only_on_an_open_line() {
        let mut conn = db();
        let mine = create(&conn, "/mine", None, 0).unwrap().id;
        let yours = create(&conn, "/yours", None, 0).unwrap().id;
        let n = add_note(&mut conn, mine, "wire the route", 0).unwrap().unwrap();
        let get = |conn: &Connection| notes(conn, mine).unwrap()[0].clone();

        assert!(!mark_note(&conn, yours, n.id, &mark("read", ""), 1).unwrap(), "not across desks");
        assert!(!mark_note(&conn, mine, n.id, &mark("done", ""), 1).unwrap(), "done is the tick");
        assert!(!mark_note(&conn, mine, n.id, &mark("planned", ""), 1).unwrap(), "a plan needs its document");
        assert!(!mark_note(&conn, mine, n.id, &mark("planned", "not-an-id"), 1).unwrap());
        assert_eq!(get(&conn).stage, "");

        assert!(mark_note(&conn, mine, n.id, &mark("read", ""), 2).unwrap());
        let got = get(&conn);
        assert_eq!((got.stage.as_str(), got.stage_by.as_str(), got.stage_at), ("read", "claude-code", 2));
        assert_eq!(got.stage_pane, "", "only working keeps the pane");

        assert!(mark_note(&conn, mine, n.id, &mark("planned", "58155BA5FC"), 3).unwrap());
        assert_eq!(get(&conn).stage_doc, "58155ba5fc");
        // Working keeps the plan, and says where it is happening.
        assert!(mark_note(&conn, mine, n.id, &mark("working", ""), 4).unwrap());
        let got = get(&conn);
        assert_eq!((got.stage.as_str(), got.stage_doc.as_str()), ("working", "58155ba5fc"));
        assert_eq!((got.stage_pane.as_str(), got.stage_session.as_str()), ("p1", "s1"));
        // The conversation ends: back to planned. With no plan: read.
        let mut ended = got.clone();
        settle_stage(&mut ended, false);
        assert_eq!(ended.stage, "planned");
        let mut still = got.clone();
        settle_stage(&mut still, true);
        assert_eq!(still.stage, "working");
        ended.stage = "working".into();
        ended.stage_doc.clear();
        settle_stage(&mut ended, false);
        assert_eq!(ended.stage, "read");
        // And back a step, by the agent itself.
        assert!(mark_note(&conn, mine, n.id, &mark("planned", "58155ba5fc"), 5).unwrap());
        assert_eq!(get(&conn).stage_pane, "");

        // A done line is done: no stage over it. A suggestion is not the
        // reader's list yet.
        assert!(tick_note(&conn, mine, n.id, &by("claude-code"), 6).unwrap());
        assert!(!mark_note(&conn, mine, n.id, &mark("working", ""), 7).unwrap());
        let Suggested::Note(s) = suggest_note(&mut conn, mine, "an idea", "claude-code", 8).unwrap() else {
            panic!("suggested")
        };
        assert!(!mark_note(&conn, mine, s.id, &mark("read", ""), 9).unwrap());
    }

    /// A tick can say where the work went: a commit hash, and a document the
    /// agent sent. Anything that is not one is dropped, not stored, and the
    /// reader's untick takes both off with the name.
    #[test]
    fn a_tick_carries_its_commit_and_document_and_an_untick_clears_them() {
        let mut conn = db();
        let mine = create(&conn, "/mine", None, 0).unwrap().id;
        let n = add_note(&mut conn, mine, "fix the hover", 0)
            .unwrap()
            .unwrap();
        let tick = Tick {
            by: "claude-code".into(),
            commit: "90F09D6".into(),
            doc: "82cc8f2d3c".into(),
            evidence: "https://github.com/o/r/pull/40".into(),
        };
        assert!(tick_note(&conn, mine, n.id, &tick, 1).unwrap());
        let got = &notes(&conn, mine).unwrap()[0];
        assert_eq!(
            (
                got.done_commit.as_str(),
                got.done_doc.as_str(),
                got.done_evidence.as_str()
            ),
            ("90f09d6", "82cc8f2d3c", "https://github.com/o/r/pull/40")
        );
        assert!(set_note(&conn, mine, n.id, None, Some(false), 2).unwrap());
        let got = &notes(&conn, mine).unwrap()[0];
        assert_eq!(
            (
                got.done_by.as_str(),
                got.done_commit.as_str(),
                got.done_doc.as_str()
            ),
            ("", "", "")
        );
        let junk = Tick {
            by: "claude-code".into(),
            commit: "main; rm -rf".into(),
            doc: "../etc".into(),
            evidence: "javascript:alert(1)".into(),
        };
        assert!(tick_note(&conn, mine, n.id, &junk, 3).unwrap());
        let got = &notes(&conn, mine).unwrap()[0];
        assert_eq!(
            (
                got.done_commit.as_str(),
                got.done_doc.as_str(),
                got.done_evidence.as_str()
            ),
            ("", "", "")
        );
        assert!(
            evidence_ok("https://apps.apple.com/app/id1") && evidence_ok("http://localhost:3000/x")
        );
        for bad in [
            "file:///etc/passwd",
            "https://",
            "https:///x",
            "https://a b",
            "ftp://x",
            "https://x\n",
        ] {
            assert!(!evidence_ok(bad), "{bad}");
        }
        assert!(!evidence_ok(&format!("https://x/{}", "a".repeat(500))));
        assert!(commit_ok("90f09d6") && commit_ok(&"a".repeat(40)));
        assert!(!commit_ok("90f09d") && !commit_ok(&"a".repeat(41)) && !commit_ok("main"));
        assert!(doc_ok("82cc8f2d3c") && !doc_ok("82cc8f2d3") && !doc_ok("82cc8f2d3z"));
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

    /// Closing a desk deletes nothing: it leaves every list, its notes stay
    /// on it with their ticks, and reopening it brings both back -- with the
    /// panes that closed with it, in their order, and not one closed before.
    /// Only a prune past its close ends it, notes and all.
    #[test]
    fn closing_a_desk_keeps_its_list_and_reopening_brings_it_back() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let kept = add_note(&mut conn, d, "stays with it", 0).unwrap().unwrap();
        add_note(&mut conn, d, "and this", 0).unwrap().unwrap();
        assert!(set_note(&conn, d, kept.id, None, Some(true), 5).unwrap());
        let (Opened::Pane(a), Opened::Pane(b), Opened::Pane(c)) =
            (pane(&mut conn, d), pane(&mut conn, d), pane(&mut conn, d))
        else {
            panic!()
        };
        let tx = conn.transaction().unwrap();
        close_pane(&tx, &a.id, 10).unwrap();
        tx.commit().unwrap();

        assert_eq!(
            close(&mut conn, d, 20).unwrap(),
            Some(vec![b.id.clone(), c.id.clone()])
        );
        assert_eq!(close(&mut conn, d, 21).unwrap(), None, "already closed");
        assert!(list(&conn).unwrap().is_empty());
        assert!(get(&conn, d).unwrap().is_none());
        assert!(add_note(&mut conn, d, "not on a closed desk", 0)
            .unwrap()
            .is_none());
        assert!(matches!(pane(&mut conn, d), Opened::NoSuchDesk));
        assert_eq!(closed_desks(&conn, 10).unwrap().len(), 1);
        assert!(
            closed_panes(&conn, 10).unwrap().is_empty(),
            "the desk's row stands for them"
        );
        assert_eq!(
            create(&conn, "/w", None, 0).unwrap().name,
            "w",
            "its name is free while it is closed"
        );

        assert!(reopen(&mut conn, d).unwrap());
        assert!(!reopen(&mut conn, d).unwrap(), "already open");
        let back = get(&conn, d).unwrap().unwrap();
        assert_eq!(
            back.panes
                .iter()
                .map(|p| (p.id.clone(), p.slot))
                .collect::<Vec<_>>(),
            vec![(b.id.clone(), 1), (c.id.clone(), 2)]
        );
        assert_eq!(
            closed_on(&conn, d).unwrap(),
            vec![a.id.clone()],
            "closed before it, still closed"
        );
        let ns = notes(&conn, d).unwrap();
        assert_eq!(ns.len(), 2);
        assert!(ns.iter().find(|n| n.id == kept.id).unwrap().done);

        close(&mut conn, d, 30).unwrap();
        assert!(
            prune_desks(&conn, 30, false).unwrap().is_empty(),
            "not before its close"
        );
        assert_eq!(prune_desks(&conn, 31, true).unwrap().len(), 1);
        assert_eq!(
            prune_desks(&conn, 31, false).unwrap(),
            vec![(d, "w".to_string())]
        );
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM desk_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "a pruned desk takes its list by the cascade");
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
        // A closed pane is no longer a pane; its conversation waits with it
        // in `panes_closed`, for Undo.
        let tx = conn.transaction().unwrap();
        assert!(close_pane(&tx, &p.id, 1).unwrap().is_some());
        tx.commit().unwrap();
        assert!(super::pane(&conn, &p.id).unwrap().is_none());
    }

    /// A planned restart marks the panes it should bring back, and only the
    /// ones with a conversation to bring; the next daemon takes the marks
    /// once, and a third daemon finds none.
    #[test]
    fn resume_marks_are_set_for_known_conversations_and_taken_once() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap();
        let Opened::Pane(talked) = pane(&mut conn, d.id) else {
            panic!("no pane")
        };
        let Opened::Pane(silent) = pane(&mut conn, d.id) else {
            panic!("no pane")
        };
        let Opened::Pane(other) = pane(&mut conn, d.id) else {
            panic!("no pane")
        };
        let a = "0f6c1c2e-8a41-4b7e-9d3a-5e2f1b7c9a10";
        assert!(set_agent_session(&conn, &talked.id, a).unwrap());
        assert!(set_agent_session(&conn, &other.id, a).unwrap());
        let none = (Vec::<String>::new(), Vec::<String>::new());
        assert_eq!(take_resume(&conn).unwrap(), none);
        // Two asked for, one with a conversation: one mark. The third pane
        // knows a conversation but was not asked for, and stays unmarked.
        assert_eq!(
            mark_resume(&conn, &[talked.id.clone(), silent.id.clone()]).unwrap(),
            1
        );
        assert_eq!(take_resume(&conn).unwrap().0, vec![talked.id.clone()]);
        assert_eq!(take_resume(&conn).unwrap(), none, "taken once");
        // A new set replaces the old, so a mark cannot outlive the restart
        // that made it.
        mark_resume(&conn, std::slice::from_ref(&talked.id)).unwrap();
        mark_resume(&conn, std::slice::from_ref(&other.id)).unwrap();
        assert_eq!(take_resume(&conn).unwrap().0, vec![other.id.clone()]);

        // 1.7.1: an unplanned stop offers instead, only where a conversation
        // is known, and never over a planned mark.
        mark_resume(&conn, std::slice::from_ref(&talked.id)).unwrap();
        assert_eq!(
            mark_offer(
                &conn,
                &[talked.id.clone(), other.id.clone(), silent.id.clone()]
            )
            .unwrap(),
            1
        );
        assert_eq!(
            take_resume(&conn).unwrap(),
            (vec![talked.id.clone()], vec![other.id.clone()])
        );
    }

    /// Where the shell went is where it starts next, and saying the same
    /// folder twice is no change.
    #[test]
    fn a_pane_keeps_the_folder_its_shell_moved_to() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap();
        let Opened::Pane(p) = pane(&mut conn, d.id) else {
            panic!()
        };
        assert!(set_cwd(&conn, &p.id, "/p/sub").unwrap());
        assert!(!set_cwd(&conn, &p.id, "/p/sub").unwrap());
        assert_eq!(
            super::pane(&conn, &p.id).unwrap().unwrap().pane.cwd,
            "/p/sub"
        );
        assert!(!set_cwd(&conn, "nope", "/x").unwrap());
    }

    /// The gesture is a right-click on a folder, so the folder's name is the
    /// one the reader is expecting -- and two desks on one folder is the
    /// workflow `Show desk` exists for, not a mistake to refuse.
    #[test]
    fn a_desk_is_named_after_its_folder_and_the_second_one_is_numbered() {
        let mut conn = db();
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
        assert!(close(&mut conn, b.id, 1).unwrap().is_some());
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
        let tx = conn.transaction().unwrap();
        assert_eq!(close_pane(&tx, &first, 1).unwrap(), Some((d, 1)));
        tx.commit().unwrap();
        // The rest closed up; the next one takes the end.
        assert_eq!(slots(&conn, d), vec![1, 2, 3]);
        assert!(matches!(pane(&mut conn, d), Opened::Pane(p) if p.slot == 4));
        assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
    }

    /// A move renumbers: the pane at 1 is at 3 and the one at 3 at 1, an
    /// empty slot takes a pane without a partner, and nothing leaves its desk.
    #[test]
    fn a_pane_moves_to_another_slot_and_the_one_there_takes_its_place() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        let other = create(&conn, "/q", None, 0).unwrap().id;
        for _ in 0..3 {
            pane(&mut conn, d);
        }
        pane(&mut conn, other);
        let ids = |conn: &Connection, d| -> Vec<String> {
            get(conn, d)
                .unwrap()
                .unwrap()
                .panes
                .iter()
                .map(|p| p.id.clone())
                .collect()
        };
        let before = ids(&conn, d);
        assert!(layout(&conn, d, 0.5, 0.5, Some(1)).unwrap());
        assert!(layout(&conn, other, 0.5, 0.5, Some(1)).unwrap());
        let tx = conn.transaction().unwrap();
        assert!(move_pane(&tx, d, 1, 3).unwrap());
        tx.commit().unwrap();
        assert_eq!(
            ids(&conn, d),
            [before[2].clone(), before[1].clone(), before[0].clone()]
        );
        assert_eq!(
            get(&conn, d).unwrap().unwrap().full_slot,
            3,
            "full view went with its pane"
        );
        assert_eq!(get(&conn, other).unwrap().unwrap().full_slot, 1);

        // Into the empty slot 4: nothing comes back the other way.
        let tx = conn.transaction().unwrap();
        assert!(move_pane(&tx, d, 2, 4).unwrap());
        tx.commit().unwrap();
        assert_eq!(slots(&conn, d), vec![1, 3, 4]);

        // No pane at the slot, a slot out of range: refused, nothing moved.
        let tx = conn.transaction().unwrap();
        assert!(!move_pane(&tx, d, 2, 1).unwrap());
        assert!(!move_pane(&tx, d, 1, 5).unwrap());
        assert!(!move_pane(&tx, d, 0, 1).unwrap());
        tx.commit().unwrap();
        assert_eq!(slots(&conn, d), vec![1, 3, 4]);
        assert_eq!(slots(&conn, other), vec![1], "the other desk is untouched");
    }

    /// No cap across desks: twelve panes on three desks all open, and each
    /// desk still stops at its own four.
    #[test]
    fn twelve_panes_on_three_desks_all_open() {
        let mut conn = db();
        let desks: Vec<i64> = (0..3)
            .map(|_| create(&conn, "/p", None, 0).unwrap().id)
            .collect();
        for d in &desks {
            for _ in 0..PER_DESK {
                assert!(matches!(pane(&mut conn, *d), Opened::Pane(_)));
            }
            assert!(matches!(pane(&mut conn, *d), Opened::DeskFull));
        }
        assert_eq!(panes_open(&conn).unwrap(), 3 * PER_DESK);

        // Closing a whole desk closes its panes with it.
        assert_eq!(
            close(&mut conn, desks[0], 1).unwrap().unwrap().len(),
            PER_DESK as usize
        );
        assert_eq!(
            panes_open(&conn).unwrap(),
            2 * PER_DESK,
            "its panes closed with it"
        );
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
        assert!(layout(&conn, d, 0.0, 2.5, None).unwrap());
        let after = get(&conn, d).unwrap().unwrap();
        assert_eq!((after.col, after.row), (MIN_FRACTION, MAX_FRACTION));
        assert!(layout(&conn, d, f64::NAN, 0.4, None).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().col, 0.5);
        assert!(!layout(&conn, d + 99, 0.5, 0.5, None).unwrap());
        // Full view is kept, left alone when not sent, and a slot out of
        // range is the grid.
        assert!(layout(&conn, d, 0.5, 0.5, Some(3)).unwrap());
        assert!(layout(&conn, d, 0.5, 0.5, None).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 3);
        assert!(layout(&conn, d, 0.5, 0.5, Some(9)).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 0);
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

    /// 1.7.1: a close keeps the pane for Undo and closes the gap it leaves,
    /// so the slots are always 1 to n; full view follows its slot.
    #[test]
    fn a_closed_pane_leaves_no_gap_and_comes_back_at_the_end() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        for _ in 0..3 {
            pane(&mut conn, d);
        }
        let ids: Vec<String> = get(&conn, d)
            .unwrap()
            .unwrap()
            .panes
            .iter()
            .map(|p| p.id.clone())
            .collect();
        assert!(rename_pane(&conn, &ids[1], "  the   tests \n").unwrap());
        assert!(layout(&conn, d, 0.5, 0.5, Some(3)).unwrap());
        let tx = conn.transaction().unwrap();
        assert_eq!(close_pane(&tx, &ids[1], 5).unwrap(), Some((d, 2)));
        assert_eq!(close_pane(&tx, "nope", 5).unwrap(), None);
        tx.commit().unwrap();
        let after = get(&conn, d).unwrap().unwrap();
        assert_eq!(
            after
                .panes
                .iter()
                .map(|p| (p.id.clone(), p.slot))
                .collect::<Vec<_>>(),
            [(ids[0].clone(), 1), (ids[2].clone(), 2)]
        );
        assert_eq!(after.full_slot, 2, "full view follows the pane it was on");

        // Back, stopped, at the lowest free slot, with its name.
        let Restored::Pane(p) = restore_pane(&mut conn, &ids[1]).unwrap() else {
            panic!("not restored")
        };
        assert_eq!((p.slot, p.name.as_str()), (3, "the tests"));
        assert!(
            matches!(restore_pane(&mut conn, &ids[1]).unwrap(), Restored::Gone),
            "twice is not twice"
        );

        // Closing the one in full view puts the grid back.
        let tx = conn.transaction().unwrap();
        close_pane(&tx, &ids[2], 6).unwrap();
        tx.commit().unwrap();
        assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 0);
    }

    /// The desk filled while the pane was closed: it says so and stays closed.
    #[test]
    fn a_closed_pane_does_not_come_back_to_a_full_desk() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        let Opened::Pane(first) = pane(&mut conn, d) else {
            panic!()
        };
        let tx = conn.transaction().unwrap();
        close_pane(&tx, &first.id, 1).unwrap();
        tx.commit().unwrap();
        for _ in 0..PER_DESK {
            pane(&mut conn, d);
        }
        assert!(matches!(
            restore_pane(&mut conn, &first.id).unwrap(),
            Restored::DeskFull
        ));
        assert_eq!(closed_on(&conn, d).unwrap(), vec![first.id.clone()]);
    }

    /// Kept until `prune`, like a deleted document: only what was closed
    /// before the cut goes, and a desk's prune takes the rest.
    #[test]
    fn closed_panes_last_until_prune_or_their_desk() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        let (Opened::Pane(a), Opened::Pane(b)) = (pane(&mut conn, d), pane(&mut conn, d)) else {
            panic!()
        };
        let tx = conn.transaction().unwrap();
        close_pane(&tx, &a.id, 10).unwrap();
        close_pane(&tx, &b.id, 20).unwrap();
        tx.commit().unwrap();
        let would = prune_closed(&conn, 15, true).unwrap();
        assert_eq!(
            would.iter().map(|g| g.0.clone()).collect::<Vec<_>>(),
            vec![a.id.clone()]
        );
        assert_eq!(
            closed_on(&conn, d).unwrap().len(),
            2,
            "a dry run removes nothing"
        );
        assert_eq!(prune_closed(&conn, 15, false).unwrap().len(), 1);
        assert_eq!(closed_on(&conn, d).unwrap(), vec![b.id.clone()]);
        close(&mut conn, d, 30).unwrap();
        prune_desks(&conn, 31, false).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM panes_closed", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "the desk's prune cascades");
    }

    /// An agent's suggestion is a ghost row until the reader keeps it: it
    /// sits after what is open, cannot be ticked by an agent, a desk holds
    /// only a few waiting, and keeping one makes it an ordinary line.
    #[test]
    fn a_suggestion_waits_for_the_reader_and_is_theirs_once_kept() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let mine = add_note(&mut conn, d, "mine", 0).unwrap().unwrap();
        let Suggested::Note(s1) =
            suggest_note(&mut conn, d, "  write the migration  ", "claude-code", 1).unwrap()
        else {
            panic!()
        };
        assert_eq!(
            (s1.text.as_str(), s1.suggested_by.as_str()),
            ("write the migration", "claude-code")
        );
        assert_eq!(
            suggest_note(&mut conn, d, " ", "x", 1).unwrap(),
            Suggested::Empty
        );
        let later = add_note(&mut conn, d, "written after", 2).unwrap().unwrap();
        let order: Vec<i64> = notes(&conn, d).unwrap().iter().map(|n| n.id).collect();
        assert_eq!(
            order,
            vec![mine.id, later.id, s1.id],
            "suggestions after what is open"
        );
        assert!(
            !tick_note(&conn, d, s1.id, &by("claude-code"), 3).unwrap(),
            "not the agent's to tick"
        );
        for i in 0..SUGGESTIONS_PER_DESK - 1 {
            assert!(matches!(
                suggest_note(&mut conn, d, &format!("idea {i}"), "a", 4).unwrap(),
                Suggested::Note(_)
            ));
        }
        assert_eq!(
            suggest_note(&mut conn, d, "one too many", "a", 5).unwrap(),
            Suggested::Full
        );
        assert!(keep_note(&conn, d, s1.id).unwrap());
        assert!(!keep_note(&conn, d, s1.id).unwrap(), "kept once");
        assert!(
            !keep_note(&conn, d, mine.id).unwrap(),
            "a line of the reader's is not a suggestion"
        );
        let kept = notes(&conn, d)
            .unwrap()
            .into_iter()
            .find(|n| n.id == s1.id)
            .unwrap();
        assert!(kept.suggested_by.is_empty());
        assert!(tick_note(&conn, d, s1.id, &by("claude-code"), 6).unwrap());
        assert!(matches!(
            suggest_note(&mut conn, d, "room again", "a", 7).unwrap(),
            Suggested::Note(_)
        ));
        assert_eq!(
            suggest_note(&mut conn, 99, "no desk", "a", 7).unwrap(),
            Suggested::NoSuchDesk
        );
    }

    /// Left off is one line per desk: set, replaced, cleared -- each hands
    /// back the one before, for an Undo -- and carried on the desk.
    #[test]
    fn left_off_is_one_line_and_hands_back_the_one_before() {
        let conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        assert_eq!(get(&conn, d).unwrap().unwrap().left_off, None);
        let first = LeftOff {
            text: "If the tests pass,\n  ship the migration".into(),
            at: 10,
            by: "claude-code".into(),
            about: "82CC8F2D3C".into(),
        };
        assert_eq!(set_left_off(&conn, d, &first).unwrap(), Some(None));
        let got = get(&conn, d).unwrap().unwrap().left_off.unwrap();
        assert_eq!(got.text, "If the tests pass, ship the migration");
        assert_eq!(
            (got.at, got.by.as_str(), got.about.as_str()),
            (10, "claude-code", "82cc8f2d3c")
        );
        let long = LeftOff {
            text: "x".repeat(300),
            at: 11,
            about: "../etc".into(),
            ..LeftOff::default()
        };
        assert_eq!(
            set_left_off(&conn, d, &long).unwrap(),
            Some(Some(got.clone()))
        );
        let now = get(&conn, d).unwrap().unwrap().left_off.unwrap();
        assert_eq!(
            (
                now.text.chars().count(),
                now.about.as_str(),
                now.by.as_str()
            ),
            (LEFT_OFF_CHARS, "", "")
        );
        let cleared = set_left_off(&conn, d, &LeftOff::default()).unwrap();
        assert_eq!(cleared, Some(Some(now)));
        assert_eq!(get(&conn, d).unwrap().unwrap().left_off, None);
        assert_eq!(
            set_left_off(&conn, d, &got).unwrap(),
            Some(None),
            "the Undo puts it back"
        );
        assert_eq!(get(&conn, d).unwrap().unwrap().left_off, Some(got));
        assert_eq!(set_left_off(&conn, 99, &first).unwrap(), None);
    }

    /// Opening a desk is written once a minute at most, and never on a
    /// closed one.
    #[test]
    fn a_visit_is_written_at_most_once_a_minute() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        assert!(visit(&conn, d, 1_000).unwrap());
        assert!(
            !visit(&conn, d, 1_030).unwrap(),
            "30 s later is the same visit"
        );
        assert_eq!(get(&conn, d).unwrap().unwrap().visited_at, 1_000);
        assert!(visit(&conn, d, 1_061).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().visited_at, 1_061);
        close(&mut conn, d, 2_000).unwrap();
        assert!(!visit(&conn, d, 5_000).unwrap());
    }

    /// A desk parks with its next step and comes down again, each handing
    /// back what it was, for the Undo in the row.
    #[test]
    fn a_desk_parks_with_its_next_step_and_comes_down() {
        let conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        assert_eq!(get(&conn, d).unwrap().unwrap().parked, None);
        let to = Parked {
            at: 50,
            next: "Retry-After in\n whole seconds".into(),
        };
        assert_eq!(park(&conn, d, Some(&to)).unwrap(), Some(None));
        let got = get(&conn, d).unwrap().unwrap().parked.unwrap();
        assert_eq!(
            (got.at, got.next.as_str()),
            (50, "Retry-After in whole seconds")
        );
        assert_eq!(park(&conn, d, None).unwrap(), Some(Some(got)));
        assert_eq!(get(&conn, d).unwrap().unwrap().parked, None);
        assert_eq!(park(&conn, 99, None).unwrap(), None);
    }

    /// The log's ticks: since a time, oldest first, with what the agent said,
    /// and never a line put away or a closed desk's.
    #[test]
    fn ticks_since_leave_out_what_was_put_away_and_closed_desks() {
        let mut conn = db();
        let d = create(&conn, "/w", None, 0).unwrap().id;
        let gone = create(&conn, "/x", None, 0).unwrap().id;
        let ids: Vec<i64> = ["old", "b", "a", "put away"]
            .iter()
            .map(|t| add_note(&mut conn, d, t, 0).unwrap().unwrap().id)
            .collect();
        set_note(&conn, d, ids[0], None, Some(true), 5).unwrap();
        set_note(&conn, d, ids[1], None, Some(true), 30).unwrap();
        let tick = Tick {
            by: "claude-code".into(),
            commit: "a41c2e9".into(),
            ..Tick::default()
        };
        tick_note(&conn, d, ids[2], &tick, 20).unwrap();
        set_note(&conn, d, ids[3], None, Some(true), 25).unwrap();
        remove_note(&conn, d, ids[3], 26).unwrap();
        let other = add_note(&mut conn, gone, "closed", 0).unwrap().unwrap().id;
        set_note(&conn, gone, other, None, Some(true), 25).unwrap();
        close(&mut conn, gone, 40).unwrap();
        let got = done_since(&conn, 10).unwrap();
        let texts: Vec<&str> = got.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["a", "b"]);
        assert_eq!(
            (got[0].by.as_str(), got[0].commit.as_str(), got[0].at),
            ("claude-code", "a41c2e9", 20)
        );
    }
}
