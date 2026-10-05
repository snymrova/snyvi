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

/// 1.14: the reader's order for the desks (`reorder`). Not in `SCHEMA`: it is
/// version 2 of `store::MIGRATIONS`, which runs once and takes an error as
/// one, so a database made new must not have it before the step adds it.
pub const POS_COLUMN: &str = "ALTER TABLE desks ADD COLUMN pos INTEGER NOT NULL DEFAULT 0";

/// 1.15: what kind of desk it was, and a studio desk's folder. Version 3 of
/// `store::MIGRATIONS`, on the same terms as `POS_COLUMN`. The studio was
/// retired in 1.16 and every desk is a terminal desk again (version 4 turns
/// a studio desk into one); the columns stay, unread, because dropping them
/// means rebuilding the table for nothing, and a 1.15 binary that opens the
/// database still finds them.
pub const KIND_COLUMNS: [&str; 2] = [
    "ALTER TABLE desks ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal'",
    "ALTER TABLE desks ADD COLUMN boards TEXT NOT NULL DEFAULT ''",
];

/// 1.16: the studio is retired, and a studio desk is a terminal desk on the
/// same folder (its root was always the folder), with its panels, notes,
/// keys and documents. Version 4 of `store::MIGRATIONS`. Nothing on disk is
/// touched: the folder, its `folder.json` files and the hides table stay.
pub const RETIRE_STUDIO: &str = "UPDATE desks SET kind = 'terminal' WHERE kind = 'studio'";

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
  left_off_pane TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS desk_keys (
  desk_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (desk_id, name)
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
  done_pane TEXT NOT NULL DEFAULT '',
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
    /// The keys its panels start with, by name only: the desk's own and the
    /// ones kept for every desk. Values live in the keychain (`crate::secrets`).
    pub keys: Vec<DeskKey>,
    pub panes: Vec<Pane>,
}

/// A key a desk hands its panels, by name. The value is in the keychain or
/// snyvi's 0600 file (`crate::secrets`), never in this row, never in a
/// response, never in an event: the window and the brief see names.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DeskKey {
    /// The desk it belongs to, or `EVERY_DESK`.
    pub desk_id: i64,
    /// The environment variable, `[A-Z][A-Z0-9_]*`.
    pub name: String,
    /// What the reader called it: `github`, `openrouter`; may be empty.
    pub provider: String,
    pub created_at: i64,
    /// When a panel last started with it; 0 for never.
    pub used_at: i64,
}

/// The desk id a key kept for every desk is filed under. Not a desk, so no
/// cascade reaches it: `prune_keys` is what takes a desk's rows.
pub const EVERY_DESK: i64 = 0;

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
    /// The pane it was said from, when an agent said it: what keeps a panel
    /// from being told its own left-off as news (`crate::brief::changes`).
    /// Never the page's.
    #[serde(skip)]
    pub pane: String,
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
    /// The pane an agent ticked it from, and when it was ticked by anyone:
    /// what `crate::brief::changes` reads to tell a panel of a tick that was
    /// not its own. The page has `done` and the order; neither goes to it.
    #[serde(skip)]
    pub done_pane: String,
    #[serde(skip)]
    pub done_at: i64,
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
    let Some((hash, ext)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 16
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
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
    /// The command that goes back to `agent_session`
    /// (`crate::agents::resume_cmd`), or empty with no conversation. The page
    /// types this one rather than building its own.
    pub resume: String,
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

/// Every desk, in the reader's order (`reorder`) -- the order they were made
/// in until the reader moves one -- each with its panes in slot order.
///
/// Two queries rather than a join with a row per pane: a desk with no panes is
/// a real and common state -- it is what every desk is for the moment after it
/// is made -- and it should not need a left join to survive the trip.
pub fn list(conn: &Connection) -> Result<Vec<Desk>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {DESK_COLS} FROM desks WHERE closed_at = 0 ORDER BY pos, id"
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
    // One query for every desk's keys, picked per desk the way `keys` picks.
    let mut stmt = conn.prepare(
        "SELECT desk_id, name, provider, created_at, used_at FROM desk_keys ORDER BY name, desk_id DESC",
    )?;
    let all: Vec<DeskKey> = stmt
        .query_map([], row_to_key)?
        .collect::<rusqlite::Result<_>>()?;
    if !all.is_empty() {
        for d in &mut desks {
            let id = d.id;
            d.keys = pick_keys(
                all.iter()
                    .filter(|k| k.desk_id == id || k.desk_id == EVERY_DESK)
                    .cloned(),
            );
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
    desk.keys = keys(conn, id)?;
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
    // Last in the reader's order, as a desk made now always was. Past the
    // closed ones too, which keep their places for a reopen.
    conn.execute(
        "INSERT INTO desks(name, root, col, row, created_at, pos)
         VALUES(?1, ?2, 0.5, 0.5, ?3, (SELECT COALESCE(MAX(pos), 0) + 1 FROM desks))",
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
        keys: Vec::new(),
        panes: Vec::new(),
    })
}

/// The reader's order for the desks: `ids` is every open desk, top first.
/// Anything else -- one missing, one extra, one twice, one closed -- is
/// refused with `false` and nothing changes, so two windows that each saw a
/// different list cannot leave half of each. A closed desk keeps the place it
/// had, and a reopen puts it back there.
pub fn reorder(conn: &mut Connection, ids: &[i64]) -> Result<bool> {
    let tx = conn.transaction()?;
    let mut open: Vec<i64> = tx
        .prepare("SELECT id FROM desks WHERE closed_at = 0")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut asked = ids.to_vec();
    open.sort_unstable();
    asked.sort_unstable();
    if open != asked {
        return Ok(false);
    }
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE desks SET pos = ?2 WHERE id = ?1",
            params![id, i as i64 + 1],
        )?;
    }
    tx.commit()?;
    Ok(true)
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

/// The keys a desk's panels start with: its own rows and the every-desk rows,
/// by name, a desk's own shadowing an every-desk one of the same name.
pub fn keys(conn: &Connection, desk_id: i64) -> Result<Vec<DeskKey>> {
    let mut stmt = conn.prepare(
        "SELECT desk_id, name, provider, created_at, used_at FROM desk_keys
         WHERE desk_id IN (?1, 0) ORDER BY name, desk_id DESC",
    )?;
    let rows: Vec<DeskKey> = stmt
        .query_map(params![desk_id], row_to_key)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(pick_keys(rows))
}

fn row_to_key(r: &rusqlite::Row) -> rusqlite::Result<DeskKey> {
    Ok(DeskKey {
        desk_id: r.get(0)?,
        name: r.get(1)?,
        provider: r.get(2)?,
        created_at: r.get(3)?,
        used_at: r.get(4)?,
    })
}

/// Rows ordered by name, a desk's own before the every-desk one: the first
/// of each name is the one the desk gets.
fn pick_keys(rows: impl IntoIterator<Item = DeskKey>) -> Vec<DeskKey> {
    let mut out: Vec<DeskKey> = Vec::new();
    for k in rows {
        if out.last().is_some_and(|l| l.name == k.name) {
            continue;
        }
        out.push(k);
    }
    out
}

/// Keep a key's name on a desk (or on every desk). Pasted again, it is new
/// again: `created_at` moves and `used_at` starts over.
pub fn add_key(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    provider: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO desk_keys(desk_id, name, provider, created_at, used_at) VALUES (?1, ?2, ?3, ?4, 0)",
        params![desk_id, name, provider, now],
    )?;
    Ok(())
}

/// Take a key's name off a desk; whether there was one. The value is the
/// caller's to forget (`crate::secrets`).
pub fn remove_key(conn: &Connection, desk_id: i64, name: &str) -> Result<bool> {
    Ok(conn.execute(
        "DELETE FROM desk_keys WHERE desk_id = ?1 AND name = ?2",
        params![desk_id, name],
    )? > 0)
}

/// A panel started with these: say when.
pub fn touch_keys(conn: &Connection, keys: &[DeskKey], now: i64) -> Result<()> {
    for k in keys {
        conn.execute(
            "UPDATE desk_keys SET used_at = ?3 WHERE desk_id = ?1 AND name = ?2",
            params![k.desk_id, k.name, now],
        )?;
    }
    Ok(())
}

/// The keys of desks closed before `before`, (desk, name), taken off unless
/// `dry_run`: run before `prune_desks`, and forget each value. Every-desk
/// rows belong to no desk and stay.
pub fn prune_keys(conn: &Connection, before: i64, dry_run: bool) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT k.desk_id, k.name FROM desk_keys k JOIN desks d ON d.id = k.desk_id
         WHERE d.closed_at != 0 AND d.closed_at < ?1 ORDER BY k.desk_id, k.name",
    )?;
    let gone: Vec<(i64, String)> = stmt
        .query_map(params![before], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !dry_run {
        conn.execute(
            "DELETE FROM desk_keys WHERE desk_id IN (SELECT id FROM desks WHERE closed_at != 0 AND closed_at < ?1)",
            params![before],
        )?;
    }
    Ok(gone)
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
        resume: String::new(),
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
                stage, stage_by, stage_doc, stage_at, stage_pane, stage_session, done_pane FROM desk_notes
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
        "UPDATE desk_notes SET done_at = ?3, done_by = '', done_commit = '', done_doc = '', done_evidence = '', done_pane = '', suggested_by = ''
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
    /// The pane it was said from.
    pub pane: String,
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
        "UPDATE desk_notes SET done_at = ?3, done_by = ?4, done_commit = ?5, done_doc = ?6, done_evidence = ?7, done_pane = ?8
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND done_at = 0 AND suggested_by = ''",
        params![desk_id, id, now, by, commit, doc, evidence, tick.pane],
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
        n.stage = if n.stage_doc.is_empty() {
            "read"
        } else {
            "planned"
        }
        .into();
    }
}

/// How many suggestions a desk holds waiting for the reader. A few, so an
/// agent cannot fill the list with its own ideas while the reader is away:
/// past this it is told to wait until one is kept or put away.
pub const SUGGESTIONS_PER_DESK: i64 = 3;

/// What came of an agent suggesting a line.
#[derive(Debug, PartialEq)]
pub enum Suggested {
    /// Boxed: a line with its stages is far bigger than the other answers.
    Note(Box<DeskNote>),
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
    Ok(Suggested::Note(Box::new(DeskNote {
        id,
        text,
        created_at: now,
        suggested_by: by,
        ..DeskNote::default()
    })))
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
    let (at, by, about, pane) = if text.is_empty() {
        (0, String::new(), String::new(), String::new())
    } else {
        (to.at, by, about, to.pane.clone())
    };
    conn.execute(
        "UPDATE desks SET left_off = ?2, left_off_at = ?3, left_off_by = ?4, left_off_about = ?5, left_off_pane = ?6 WHERE id = ?1",
        params![desk_id, text, at, by, about, pane],
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

/// The lines taken off one desk's list since `since`: (id, text), oldest
/// first. What a panel is told of at its next prompt (`crate::brief::changes`),
/// so an agent set on a line the reader has since put away hears so.
pub fn removed_since(conn: &Connection, desk_id: i64, since: i64) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, text FROM desk_notes WHERE desk_id = ?1 AND removed_at > ?2 ORDER BY removed_at, id",
    )?;
    let rows = stmt
        .query_map(params![desk_id, since], |r| Ok((r.get(0)?, r.get(1)?)))?
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
        images: r
            .get::<_, String>(9)?
            .split_whitespace()
            .map(String::from)
            .collect(),
        stage: r.get(10)?,
        stage_by: r.get(11)?,
        stage_doc: r.get(12)?,
        stage_at: r.get(13)?,
        stage_pane: r.get(14)?,
        stage_session: r.get(15)?,
        stage_panel: String::new(),
        done_pane: r.get(16)?,
        done_at: r.get(2)?,
    })
}

/// Put one more picture on a line, at the end. `None` when there is no such
/// line or it already holds `IMAGES_PER_NOTE`; the list it has now otherwise.
pub fn add_note_image(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    name: &str,
) -> Result<Option<Vec<String>>> {
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
pub fn set_note_images(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    images: &[String],
) -> Result<bool> {
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
    "id, name, root, col, row, created_at, full_slot, left_off, left_off_at, left_off_by, left_off_about, visited_at, parked_at, parked_next, left_off_pane";

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
                pane: r.get(14)?,
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
        keys: Vec::new(),
        panes: Vec::new(),
    })
}

fn row_to_pane(r: &rusqlite::Row, at: usize) -> rusqlite::Result<Pane> {
    let session: String = r.get(at + 5)?;
    let resume = Some(session.as_str())
        .filter(|s| valid_session(s))
        .and_then(|s| crate::agents::resume_cmd(crate::agents::KEEPS_SESSIONS, s))
        .unwrap_or_default();
    Ok(Pane {
        id: r.get(at)?,
        slot: r.get(at + 1)?,
        cwd: r.get(at + 2)?,
        cmd: r.get(at + 3)?,
        created_at: r.get(at + 4)?,
        agent_session: session,
        resume,
        name: r.get(at + 6)?,
    })
}

#[cfg(test)]
mod tests;
