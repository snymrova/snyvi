//! Threads, Your turn, and suggested panels: what an agent files so the
//! bookkeeping around a piece of work is not the reader's (#90).
//!
//! A **thread** is one arc of work on a desk -- "Home + friends" -- holding
//! the notes it answers, the folder and branch it lives in, its PR, and a
//! stage. It is the folder the notes sit in, not a replacement for them: a
//! note keeps its own stages and its own tick, and a note is in one thread at
//! most (`desk_notes.thread_id`).
//!
//! A **turn** is something only the reader can do: a question with options
//! (`decide`), or a hand-over -- try it, merge it, add a key. An answered
//! `decide` row is the decision; the thread card lists them under Decided, so
//! what was settled in a chat is not left in a chat.
//!
//! A **suggestion** is a panel or a desk an agent thinks the work wants, with
//! the exact command or folder. It is a card with Open and ✕: snyvi never
//! opens a panel or starts a turn on its own, and nothing here does either.
//!
//! Nothing is deleted. A ✕ on any of the three sets `removed_at` (or settles a
//! suggestion), and the row's Undo puts it back.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'planned',
  folder TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  branch_seen INTEGER NOT NULL DEFAULT 0,
  commits INTEGER NOT NULL DEFAULT 0,
  pr TEXT NOT NULL DEFAULT '',
  ci TEXT NOT NULL DEFAULT '',
  merged TEXT NOT NULL DEFAULT '',
  merged_at INTEGER NOT NULL DEFAULT 0,
  next TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  pane TEXT NOT NULL DEFAULT '',
  moved_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  shipped_at INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_desk ON threads(desk_id, removed_at, moved_at);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL DEFAULT 0,
  pane TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'ask',
  text TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '',
  recommended INTEGER NOT NULL DEFAULT -1,
  link TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  answered_in TEXT NOT NULL DEFAULT '',
  answered_at INTEGER NOT NULL DEFAULT 0,
  told_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_desk ON turns(desk_id, removed_at, answered_at);
CREATE TABLE IF NOT EXISTS desk_suggestions (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  cmd TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  pane TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  settled_at INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '',
  told_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS desk_suggestions_desk ON desk_suggestions(desk_id, settled_at);
"#;

/// 1.20: the thread a note is in, or 0. Version 8 of `store::MIGRATIONS`, on
/// the same terms as `desk::POS_COLUMN`: never in `desk::SCHEMA`.
pub const THREAD_COLUMN: &str =
    "ALTER TABLE desk_notes ADD COLUMN thread_id INTEGER NOT NULL DEFAULT 0";

/// 1.21: the command a `run` turn hands the reader, or empty. Version 9 of
/// `store::MIGRATIONS`, never in `SCHEMA`.
pub const CMD_COLUMN: &str = "ALTER TABLE turns ADD COLUMN cmd TEXT NOT NULL DEFAULT ''";

/// 1.30: the card a `decide` turn was asked on with others (#110), as the
/// first one's id, or 0. Version 15 of `store::MIGRATIONS`, after the accounts' 14,
/// never in `SCHEMA`.
pub const GROUP_COLUMN: &str = "ALTER TABLE turns ADD COLUMN ask_group INTEGER NOT NULL DEFAULT 0";

/// 1.26: when a panel last took the thread up -- started it, or moved it
/// from its own prompt. Which thread is "the panel's" (`of_pane`) goes by
/// this, so a reader's click on the rail never takes a panel's thread from
/// it. Version 13 of `store::MIGRATIONS`, never in `SCHEMA`.
pub const TAKEN_COLUMN: &str = "ALTER TABLE threads ADD COLUMN taken_at INTEGER NOT NULL DEFAULT 0";
/// Every thread there before 1.26 was last taken when it last moved.
pub const TAKEN_FILL: &str = "UPDATE threads SET taken_at = moved_at WHERE taken_at = 0";

/// Where a thread is. Every move is allowed -- the reader and the agent both
/// know better than a state machine -- and only `shipped` stamps a date.
/// `parked` carries the next step to pick it up by.
pub const STAGES: [&str; 7] = [
    "idea", "planned", "building", "review", "waiting", "shipped", "parked",
];

/// What a turn asks of the reader. The kind picks the buttons: `decide` has
/// the agent's options, `try` has Looks good and Needs changes, `merge` and
/// `key` have Done, and `run` has its command and Run, which types it into
/// the panel that asked as Claude Code's `!` shell mode (#95).
pub const KINDS: [&str; 5] = ["decide", "try", "merge", "key", "run"];

/// The longest command a `run` turn carries, in bytes: one line, typed into
/// a terminal on the reader's click.
pub const CMD_BYTES: usize = 2048;

/// Threads a desk holds that no panel has moved on from: not shipped, put
/// away, parked, or left by a panel that closed or took up another. A desk is
/// a project; past a dozen arcs at once it is a backlog, and the notes are
/// for that. With a panel holding one thread, it is the threads started from
/// outside a panel that this keeps in bounds.
pub const THREADS_PER_DESK: i64 = 12;

/// Turns waiting on the reader per desk. Few, so a panel left alone cannot
/// stack up questions while the reader is away.
pub const TURNS_PER_DESK: i64 = 6;
/// The most questions one `ask` puts as one card (#110): the most a plan
/// ends on, and what Claude Code's own question dialog takes.
pub const GROUP_MAX: usize = 4;

/// Suggested panels and desks waiting per desk, as `desk::SUGGESTIONS_PER_DESK`.
pub const SUGGESTIONS_PER_DESK: i64 = 3;

const NAME_CHARS: usize = 60;
const TEXT_CHARS: usize = 300;
const OPTION_CHARS: usize = 80;
const PATH_CHARS: usize = 400;
const CMD_CHARS: usize = 400;

/// One arc of work on a desk.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Thread {
    pub id: i64,
    pub desk_id: i64,
    pub name: String,
    pub stage: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub folder: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
    /// The branch, the commits and the PR were seen by the snyvi mod
    /// watching the panel's git and gh, rather than said by the agent.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub seen: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub commits: i64,
    /// The PR's number, as digits.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pr: String,
    /// The checks, as the mod last read them: `9/13`, `passing`, `failing`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub ci: String,
    /// The merge commit, once the PR is merged.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub merged: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub merged_at: i64,
    /// The next step, for a parked thread.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub next: String,
    /// The agent that started it, as its MCP client names itself.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    /// The pane that last started or moved it: "the pane's thread", which
    /// `move_thread` and `hand_over` act on without naming it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pane: String,
    /// Who moved it last: a pane's id, or empty for the reader on the page.
    /// What tells a panel of a move that was not its own.
    #[serde(skip)]
    pub moved_by: String,
    pub created_at: i64,
    pub moved_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub shipped_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub removed_at: i64,
    /// When a panel last took it up (`TAKEN_COLUMN`).
    #[serde(skip)]
    pub taken_at: i64,
    /// Why no panel is moving it, or empty while one is: `parked`, `panel
    /// closed`, `moved on` (its panel took up a later thread), `no panel`.
    /// Worked out when a list is read (`mark_rest`), never stored, so the
    /// rail, Home, the brief and the cap read the one rule.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub rest: String,
    /// The notes in it, by id.
    pub notes: Vec<i64>,
}

/// Something only the reader can do.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Turn {
    pub id: i64,
    pub desk_id: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub thread_id: i64,
    /// The pane that asked: where the answer goes, and what Send now types into.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pane: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    pub kind: String,
    /// `ask` for the MCP tool, `dialog` for Claude's own question mirrored
    /// by the snyvi mod: the mod hands that answer back as the tool's result,
    /// so it is never told again at the next prompt.
    pub via: String,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// The option the agent recommends, by index, or -1.
    pub recommended: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub link: String,
    /// A `run` turn's command, exactly as Run types it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cmd: String,
    /// The questions asked together (`ask_group`) share the first one's id;
    /// 0 for a turn on its own.
    #[serde(skip_serializing_if = "is_zero")]
    pub ask_group: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub answer: String,
    /// `snyvi` or `panel`: where the answer was given.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub answered_in: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub answered_at: i64,
    #[serde(skip)]
    pub told_at: i64,
    pub created_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub removed_at: i64,
}

/// A panel or a desk an agent suggests, waiting on the reader's click.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Suggestion {
    pub id: i64,
    pub desk_id: i64,
    /// `panel` or `desk`.
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// The command, exactly as it will run in the new panel.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cmd: String,
    /// The folder, for a desk.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub folder: String,
    pub why: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub pane: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub settled_at: i64,
    /// `opened` or `dismissed`, once settled.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub outcome: String,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// One line of at most `chars` characters, whitespace runs folded.
pub fn line(text: &str, chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(chars) {
        Some((at, _)) => text[..at].trim_end().to_string(),
        None => text,
    }
}

/// A branch name git would take, near enough: no spaces, no `..`, no
/// control characters, and short.
pub fn branch_ok(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 120
        && !b.contains("..")
        && !b.starts_with('-')
        && b.bytes()
            .all(|c| c.is_ascii_graphic() && !b"~^:?*[\\".contains(&c))
}

/// A PR as a number: `57`, `#57`, or a GitHub pull URL ending in one.
pub fn pr_number(pr: &str) -> Option<String> {
    let pr = pr.trim();
    let tail = pr
        .rsplit_once("/pull/")
        .map(|(_, n)| n.trim_end_matches('/'))
        .unwrap_or_else(|| pr.trim_start_matches('#'));
    (!tail.is_empty() && tail.len() <= 9 && tail.bytes().all(|b| b.is_ascii_digit()))
        .then(|| tail.to_string())
}

fn desk_open(conn: &Connection, desk_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

// --- threads ---------------------------------------------------------------

const THREAD_COLS: &str =
    "id, desk_id, name, stage, folder, branch, branch_seen, commits, pr, ci, merged, merged_at,
     next, by, pane, created_at, moved_at, shipped_at, removed_at, moved_by, taken_at";

fn row_to_thread(r: &rusqlite::Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        name: r.get(2)?,
        stage: r.get(3)?,
        folder: r.get(4)?,
        branch: r.get(5)?,
        seen: r.get::<_, i64>(6)? != 0,
        commits: r.get(7)?,
        pr: r.get(8)?,
        ci: r.get(9)?,
        merged: r.get(10)?,
        merged_at: r.get(11)?,
        next: r.get(12)?,
        by: r.get(13)?,
        pane: r.get(14)?,
        created_at: r.get(15)?,
        moved_at: r.get(16)?,
        shipped_at: r.get(17)?,
        removed_at: r.get(18)?,
        moved_by: r.get(19)?,
        taken_at: r.get(20)?,
        rest: String::new(),
        notes: Vec::new(),
    })
}

fn fill_notes(conn: &Connection, threads: &mut [Thread]) -> Result<()> {
    let mut st = conn.prepare_cached(
        "SELECT id FROM desk_notes WHERE thread_id = ?1 AND removed_at = 0 ORDER BY id",
    )?;
    for t in threads.iter_mut() {
        t.notes = st
            .query_map(params![t.id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
    }
    Ok(())
}

/// One thread by id, on the desk named (the page's routes put the desk in
/// the `WHERE`, as the notes do).
pub fn get(conn: &Connection, desk_id: i64, id: i64) -> Result<Option<Thread>> {
    let t = conn
        .query_row(
            &format!("SELECT {THREAD_COLS} FROM threads WHERE desk_id = ?1 AND id = ?2"),
            params![desk_id, id],
            row_to_thread,
        )
        .optional()?;
    let Some(t) = t else { return Ok(None) };
    let mut v = [t];
    fill_notes(conn, &mut v)?;
    let [t] = v;
    Ok(Some(t))
}

/// A panel holds one thread, the one it last took up (`of_pane`). Mark every
/// other one with why it rests.
fn mark_rest(conn: &Connection, threads: &mut [Thread]) -> Result<()> {
    let mut open = conn.prepare_cached("SELECT 1 FROM panes WHERE id = ?1 AND desk_id = ?2")?;
    let mut later = conn.prepare_cached(
        "SELECT 1 FROM threads WHERE desk_id = ?1 AND pane = ?2 AND removed_at = 0
         AND (taken_at > ?3 OR (taken_at = ?3 AND id > ?4)) LIMIT 1",
    )?;
    for t in threads.iter_mut() {
        t.rest = if t.stage == "parked" {
            "parked"
        } else if t.pane.is_empty() {
            "no panel"
        } else if !open.exists(params![t.pane, t.desk_id])? {
            "panel closed"
        } else if later.exists(params![t.desk_id, t.pane, t.taken_at, t.id])? {
            "moved on"
        } else {
            ""
        }
        .to_string();
    }
    Ok(())
}

/// Whether a list names a thread: one a panel holds, or shipped (the page
/// and Home keep their own windows for shipped). One no panel is moving --
/// parked, its panel closed, or its panel took up another -- is on no list
/// (#109): kept, and a panel that starts it again by its name brings it
/// back.
fn listed(t: &Thread) -> bool {
    t.rest.is_empty() || t.stage == "shipped"
}

/// A desk's threads, the most recently moved first: the ones its panels
/// hold, and shipped ones, which the page shows the last few of. Put-away
/// ones are left out, and so are the ones no panel is moving.
pub fn for_desk(conn: &Connection, desk_id: i64) -> Result<Vec<Thread>> {
    let mut st = conn.prepare(&format!(
        "SELECT {THREAD_COLS} FROM threads WHERE desk_id = ?1 AND removed_at = 0
         ORDER BY moved_at DESC, id DESC LIMIT 40"
    ))?;
    let mut v: Vec<Thread> = st
        .query_map(params![desk_id], row_to_thread)?
        .collect::<rusqlite::Result<_>>()?;
    mark_rest(conn, &mut v)?;
    v.retain(listed);
    fill_notes(conn, &mut v)?;
    Ok(v)
}

/// Every open desk's threads, for Home, left out as `for_desk` does: what
/// is moving, and what shipped since `shipped_since`.
pub fn across_desks(conn: &Connection, shipped_since: i64) -> Result<Vec<Thread>> {
    let mut st = conn.prepare(&format!(
        "SELECT {} FROM threads t JOIN desks d ON d.id = t.desk_id
         WHERE t.removed_at = 0 AND d.closed_at = 0 AND (t.stage != 'shipped' OR t.shipped_at >= ?1)
         ORDER BY t.moved_at DESC, t.id DESC LIMIT 60",
        THREAD_COLS
            .split(',')
            .map(|c| format!("t.{}", c.trim()))
            .collect::<Vec<_>>()
            .join(", ")
    ))?;
    let mut v: Vec<Thread> = st
        .query_map(params![shipped_since], row_to_thread)?
        .collect::<rusqlite::Result<_>>()?;
    mark_rest(conn, &mut v)?;
    v.retain(listed);
    fill_notes(conn, &mut v)?;
    Ok(v)
}

/// The thread a pane last took up -- started, or moved from its own prompt;
/// never one the reader moved on the page: what `move_thread`, `hand_over`
/// and the mod's `seen` act on. A shipped one still counts, so a merge seen
/// after the move is filed where it belongs.
pub fn of_pane(conn: &Connection, desk_id: i64, pane: &str) -> Result<Option<Thread>> {
    if pane.is_empty() {
        return Ok(None);
    }
    let id: Option<i64> = conn
        .query_row(
            "SELECT id FROM threads WHERE desk_id = ?1 AND pane = ?2 AND removed_at = 0
             ORDER BY taken_at DESC, id DESC LIMIT 1",
            params![desk_id, pane],
            |r| r.get(0),
        )
        .optional()?;
    match id {
        Some(id) => get(conn, desk_id, id),
        None => Ok(None),
    }
}

/// What `start_thread` was asked.
#[derive(Clone, Debug, Default)]
pub struct Start {
    pub name: String,
    pub notes: Vec<i64>,
    pub folder: String,
    pub stage: String,
    pub by: String,
    pub pane: String,
}

#[derive(Debug, PartialEq)]
pub enum Started {
    New(Thread),
    /// A thread of that name was open on the desk: it was updated instead of
    /// a second one made, and the pane takes it as its own.
    Again(Thread),
    Full,
    Empty,
    BadStage,
    NoSuchDesk,
}

/// Put notes in a thread. A note is in one thread at most, so this moves it
/// out of any other; only open, kept lines on the same desk are taken.
fn link_notes(conn: &Connection, desk_id: i64, thread: i64, notes: &[i64]) -> Result<()> {
    let mut st = conn.prepare_cached(
        "UPDATE desk_notes SET thread_id = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0
         AND suggested_by = ''",
    )?;
    for n in notes.iter().take(40) {
        st.execute(params![desk_id, n, thread])?;
    }
    Ok(())
}

/// `start_thread`: a new arc, or the one of that name again.
pub fn start(conn: &mut Connection, desk_id: i64, s: &Start, now: i64) -> Result<Started> {
    let name = line(&s.name, NAME_CHARS);
    if name.is_empty() {
        return Ok(Started::Empty);
    }
    let stage = if s.stage.is_empty() {
        "planned"
    } else {
        s.stage.as_str()
    };
    if !STAGES.contains(&stage) {
        return Ok(Started::BadStage);
    }
    let folder = line(&s.folder, PATH_CHARS);
    let by = line(&s.by, 60);
    let tx = conn.transaction()?;
    if !desk_open(&tx, desk_id)? {
        return Ok(Started::NoSuchDesk);
    }
    let same: Option<i64> = tx
        .query_row(
            "SELECT id FROM threads WHERE desk_id = ?1 AND removed_at = 0 AND stage != 'shipped'
             AND lower(name) = lower(?2) ORDER BY id DESC LIMIT 1",
            params![desk_id, name],
            |r| r.get(0),
        )
        .optional()?;
    let (id, again) = match same {
        Some(id) => {
            // The stage is kept unless one was asked for: starting a thread
            // that is already building does not send it back to planned.
            tx.execute(
                "UPDATE threads SET pane = ?3, moved_by = ?3, moved_at = ?4, taken_at = ?4,
                   folder = CASE WHEN ?5 = '' THEN folder ELSE ?5 END,
                   stage = CASE WHEN ?6 = '' THEN stage ELSE ?6 END,
                   shipped_at = CASE WHEN ?6 = 'shipped' THEN ?4 ELSE shipped_at END
                 WHERE desk_id = ?1 AND id = ?2",
                params![desk_id, id, s.pane, now, folder, s.stage],
            )?;
            (id, true)
        }
        None => {
            // Open is moving: held by no panel, or the thread a panel on the
            // desk last took up. One whose panel closed or moved on rests
            // (#102), so a desk where panels came and went, or a panel that
            // went from one piece of work to the next, is not full of them.
            let open: i64 = tx.query_row(
                "SELECT COUNT(*) FROM threads t WHERE desk_id = ?1 AND removed_at = 0
                 AND stage NOT IN ('shipped', 'parked')
                 AND (pane = '' OR (pane IN (SELECT id FROM panes WHERE desk_id = ?1)
                   AND NOT EXISTS (SELECT 1 FROM threads l WHERE l.desk_id = ?1 AND l.pane = t.pane
                     AND l.removed_at = 0 AND (l.taken_at > t.taken_at OR (l.taken_at = t.taken_at AND l.id > t.id)))))",
                params![desk_id],
                |r| r.get(0),
            )?;
            if open >= THREADS_PER_DESK {
                return Ok(Started::Full);
            }
            tx.execute(
                "INSERT INTO threads(desk_id, name, stage, folder, by, pane, moved_by, created_at, moved_at, taken_at, shipped_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7, ?7, CASE WHEN ?3 = 'shipped' THEN ?7 ELSE 0 END)",
                params![desk_id, name, stage, folder, by, s.pane, now],
            )?;
            (tx.last_insert_rowid(), false)
        }
    };
    link_notes(&tx, desk_id, id, &s.notes)?;
    let t = get(&tx, desk_id, id)?.expect("the row just written");
    tx.commit()?;
    Ok(if again {
        Started::Again(t)
    } else {
        Started::New(t)
    })
}

/// What `move_thread`, or the page, asks of a thread. Every field is
/// optional; an empty one leaves it as it was.
#[derive(Clone, Debug, Default)]
pub struct Move {
    pub stage: String,
    pub next: String,
    pub pr: String,
    pub name: String,
    pub notes: Vec<i64>,
    /// The pane it was said from, or empty for the page -- which does not
    /// take the thread from the pane that has it.
    pub pane: String,
    /// The reader moved it (the page, or `/park` in the panel): the move is
    /// news to every panel, the one it was typed in too.
    pub reader: bool,
}

#[derive(Debug, PartialEq)]
pub enum Moved {
    /// Boxed: a thread is far bigger than the refusals.
    Thread(Box<Thread>),
    BadStage,
    BadPr,
    NoThread,
}

/// Move a thread by id. `None` for the id is the pane's thread.
pub fn move_thread(
    conn: &mut Connection,
    desk_id: i64,
    id: Option<i64>,
    m: &Move,
    now: i64,
) -> Result<Moved> {
    if !m.stage.is_empty() && !STAGES.contains(&m.stage.as_str()) {
        return Ok(Moved::BadStage);
    }
    let pr = if m.pr.trim().is_empty() {
        String::new()
    } else {
        match pr_number(&m.pr) {
            Some(n) => n,
            None => return Ok(Moved::BadPr),
        }
    };
    let tx = conn.transaction()?;
    let t = match id {
        Some(id) => get(&tx, desk_id, id)?.filter(|t| t.removed_at == 0),
        None => of_pane(&tx, desk_id, &m.pane)?,
    };
    let Some(t) = t else {
        return Ok(Moved::NoThread);
    };
    let next = line(&m.next, 200);
    let name = line(&m.name, NAME_CHARS);
    // Parked carries its next step; leaving parked drops it, so a stale one
    // is not read as the plan for a thread that is building again.
    let next = match m.stage.as_str() {
        "parked" if next.is_empty() => t.next.clone(),
        "parked" => next,
        "" if t.stage == "parked" && !next.is_empty() => next,
        "" => t.next.clone(),
        _ => String::new(),
    };
    tx.execute(
        "UPDATE threads SET
           stage = CASE WHEN ?3 = '' THEN stage ELSE ?3 END,
           next = ?4,
           pr = CASE WHEN ?5 = '' THEN pr ELSE ?5 END,
           name = CASE WHEN ?6 = '' THEN name ELSE ?6 END,
           pane = CASE WHEN ?7 = '' THEN pane ELSE ?7 END,
           taken_at = CASE WHEN ?7 = '' THEN taken_at ELSE ?8 END,
           moved_by = ?9,
           moved_at = ?8,
           shipped_at = CASE WHEN ?3 = 'shipped' AND stage != 'shipped' THEN ?8
                             WHEN ?3 != '' AND ?3 != 'shipped' THEN 0 ELSE shipped_at END
         WHERE desk_id = ?1 AND id = ?2",
        params![
            desk_id,
            t.id,
            m.stage,
            next,
            pr,
            name,
            m.pane,
            now,
            if m.reader { "" } else { m.pane.as_str() }
        ],
    )?;
    link_notes(&tx, desk_id, t.id, &m.notes)?;
    let t = get(&tx, desk_id, t.id)?.expect("the row just written");
    tx.commit()?;
    Ok(Moved::Thread(Box::new(t)))
}

/// What the snyvi mod saw the panel's git and gh do.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct Seen {
    pub branch: String,
    /// Commits made, to add to the count.
    pub commits: i64,
    pub pr: String,
    pub ci: String,
    pub merged: String,
}

/// File what the mod saw on the pane's thread. `None` when the pane has no
/// thread, which is most panes most of the time: nothing is made up for it.
/// The flag says whether the thread changed -- branch, commits, PR, checks,
/// merge or stage -- so the same sighting twice moves nothing twice.
pub fn seen(
    conn: &mut Connection,
    desk_id: i64,
    pane: &str,
    s: &Seen,
    now: i64,
) -> Result<Option<(Thread, bool)>> {
    let tx = conn.transaction()?;
    let Some(was) = of_pane(&tx, desk_id, pane)? else {
        return Ok(None);
    };
    let t = &was;
    let branch = if branch_ok(s.branch.trim()) {
        s.branch.trim().to_string()
    } else {
        String::new()
    };
    let pr = pr_number(&s.pr).unwrap_or_default();
    let ci = line(&s.ci, 30);
    let merged = s.merged.trim().to_ascii_lowercase();
    let merged = if crate::desk::commit_ok(&merged) {
        merged
    } else {
        String::new()
    };
    // A new branch starts the count again: commits are the branch's.
    tx.execute(
        "UPDATE threads SET
           commits = CASE WHEN ?3 != '' AND ?3 != branch THEN 0 ELSE commits END + ?4,
           branch_seen = CASE WHEN ?3 != '' OR ?4 > 0 OR ?5 != '' THEN 1 ELSE branch_seen END,
           branch = CASE WHEN ?3 = '' THEN branch ELSE ?3 END,
           pr = CASE WHEN ?5 = '' THEN pr ELSE ?5 END,
           ci = CASE WHEN ?6 = '' THEN ci ELSE ?6 END,
           merged = CASE WHEN ?7 = '' THEN merged ELSE ?7 END,
           merged_at = CASE WHEN ?7 != '' AND merged = '' THEN ?8 ELSE merged_at END
         WHERE desk_id = ?1 AND id = ?2",
        params![
            desk_id,
            t.id,
            branch,
            s.commits.clamp(0, 1000),
            pr,
            ci,
            merged,
            now
        ],
    )?;
    // The first sight of the merge ticks the thread's open notes: merging is
    // the reader's own yes to the work, and a note left open after it is a
    // tick an agent forgot (#103-#106 stood a day that way). By "merged",
    // with the merge and the PR, so the row says where the work went; the
    // reader unticks one the merge did not finish. A suggestion is not
    // theirs yet. The merge changes the thread too, so the event that tells
    // the page goes out.
    if was.merged.is_empty() && !merged.is_empty() {
        let evidence = if crate::desk::evidence_ok(s.pr.trim()) {
            s.pr.trim()
        } else {
            ""
        };
        tx.execute(
            "UPDATE desk_notes SET done_at = ?3, done_by = 'merged', done_commit = ?4, done_doc = '', done_evidence = ?5, done_pane = ?6
             WHERE desk_id = ?1 AND thread_id = ?2 AND removed_at = 0 AND done_at = 0 AND suggested_by = ''",
            params![desk_id, t.id, now, merged, evidence, pane],
        )?;
    }
    let t = get(&tx, desk_id, t.id)?.expect("the row just written");
    tx.commit()?;
    let changed = (&t.branch, t.commits, &t.pr, &t.ci, &t.merged, &t.stage)
        != (
            &was.branch,
            was.commits,
            &was.pr,
            &was.ci,
            &was.merged,
            &was.stage,
        );
    Ok(Some((t, changed)))
}

/// Put a thread away, or back. Its notes keep their link, so Undo brings the
/// thread back whole.
pub fn remove(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE threads SET removed_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, now],
    )? > 0)
}

pub fn restore(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE threads SET removed_at = 0 WHERE desk_id = ?1 AND id = ?2",
        params![desk_id, id],
    )? > 0)
}

/// Threads moved since `since` by anyone but `pane` -- the reader on the page
/// among them -- and merges seen since then by anyone: what a panel is told
/// at its next prompt.
pub fn moved_since(conn: &Connection, desk_id: i64, pane: &str, since: i64) -> Result<Vec<Thread>> {
    let mut st = conn.prepare(&format!(
        "SELECT {THREAD_COLS} FROM threads WHERE desk_id = ?1 AND removed_at = 0
         AND ((moved_at > ?2 AND moved_by != ?3) OR merged_at > ?2) ORDER BY moved_at, id LIMIT 8"
    ))?;
    let v = st
        .query_map(params![desk_id, since, pane], row_to_thread)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

// --- turns -----------------------------------------------------------------

const TURN_COLS: &str =
    "id, desk_id, thread_id, pane, by, kind, via, text, options, recommended, link,
     answer, answered_in, answered_at, told_at, created_at, removed_at, cmd, ask_group";

fn row_to_turn(r: &rusqlite::Row) -> rusqlite::Result<Turn> {
    let options: String = r.get(8)?;
    Ok(Turn {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        thread_id: r.get(2)?,
        pane: r.get(3)?,
        by: r.get(4)?,
        kind: r.get(5)?,
        via: r.get(6)?,
        text: r.get(7)?,
        options: if options.is_empty() {
            Vec::new()
        } else {
            options.split('\n').map(String::from).collect()
        },
        recommended: r.get(9)?,
        link: r.get(10)?,
        answer: r.get(11)?,
        answered_in: r.get(12)?,
        answered_at: r.get(13)?,
        told_at: r.get(14)?,
        created_at: r.get(15)?,
        removed_at: r.get(16)?,
        cmd: r.get(17)?,
        ask_group: r.get(18)?,
    })
}

pub fn turn(conn: &Connection, desk_id: i64, id: i64) -> Result<Option<Turn>> {
    Ok(conn
        .query_row(
            &format!("SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND id = ?2"),
            params![desk_id, id],
            row_to_turn,
        )
        .optional()?)
}

/// A desk's turns: what is waiting, then what was answered in the last
/// `answered_since` (the Decided rows of a thread go further back: see
/// `decided`).
pub fn turns(conn: &Connection, desk_id: i64, answered_since: i64) -> Result<Vec<Turn>> {
    let mut st = conn.prepare(&format!(
        "SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND removed_at = 0
         AND (answered_at = 0 OR answered_at >= ?2 OR (kind = 'decide' AND thread_id != 0))
         ORDER BY answered_at != 0, id LIMIT 60"
    ))?;
    let v = st
        .query_map(params![desk_id, answered_since], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What is waiting on the reader on one desk, oldest first: the band and the
/// brief. With `dialog` false the mod's own dialog turns are left out, since
/// they are on the panel's screen already; the brief keeps them.
pub fn waiting_on(conn: &Connection, desk_id: i64, dialog: bool) -> Result<Vec<Turn>> {
    let via = if dialog { "" } else { " AND via != 'dialog'" };
    let mut st = conn.prepare(&format!(
        "SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND answered_at = 0 AND removed_at = 0{via}
         ORDER BY id LIMIT 60"
    ))?;
    let v = st
        .query_map(params![desk_id], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What is waiting on the reader across every open desk, oldest first: Home's
/// Your turn.
pub fn waiting(conn: &Connection) -> Result<Vec<Turn>> {
    let cols = TURN_COLS
        .split(',')
        .map(|c| format!("t.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut st = conn.prepare(&format!(
        "SELECT {cols} FROM turns t JOIN desks d ON d.id = t.desk_id
         WHERE t.removed_at = 0 AND t.answered_at = 0 AND d.closed_at = 0 ORDER BY t.id LIMIT 30"
    ))?;
    let v = st
        .query_map([], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What an agent asks the reader.
#[derive(Clone, Debug, Default)]
pub struct Ask {
    pub kind: String,
    pub text: String,
    pub options: Vec<String>,
    pub recommended: i64,
    pub link: String,
    pub via: String,
    pub by: String,
    pub pane: String,
    /// `run` only: the command.
    pub cmd: String,
}

#[derive(Debug, PartialEq)]
pub enum Asked {
    /// Boxed, as `Moved::Thread`.
    Turn(Box<Turn>),
    /// Two to four questions put as one card (`ask_group`).
    Group(Vec<Turn>),
    Full,
    Empty,
    /// `decide` needs two to four options; the others take none.
    BadOptions,
    BadKind,
    /// A group is two to `GROUP_MAX` questions, every one a `decide`.
    BadGroup,
    /// `run` needs one line of command, with no control characters: it is
    /// typed into a terminal, where an escape could end the paste early and
    /// type something else.
    BadCmd,
    NoSuchDesk,
}

/// A `run` turn's command as it will be typed, or `None` when it cannot be:
/// empty, longer than `CMD_BYTES`, or holding any control character -- a
/// newline would submit half of it, and an escape could close the bracketed
/// paste and type the rest as keys. Never cut short: half a command is a
/// different command.
fn command(cmd: &str) -> Option<&str> {
    let c = cmd.trim();
    (!c.is_empty() && c.len() <= CMD_BYTES && !c.chars().any(char::is_control)).then_some(c)
}

/// `ask` and `hand_over`, and the mod's mirror of Claude's own question. The
/// pane's thread, when it has one, is the thread the turn belongs to.
pub fn ask(conn: &mut Connection, desk_id: i64, a: &Ask, now: i64) -> Result<Asked> {
    ask_group(conn, desk_id, std::slice::from_ref(a), now)
}

/// A turn's fields once they are checked, ready for its row.
struct Checked<'a> {
    text: String,
    options: Vec<String>,
    recommended: i64,
    cmd: &'a str,
    link: String,
    via: &'static str,
    by: String,
}

fn check(a: &Ask) -> std::result::Result<Checked<'_>, Asked> {
    if !KINDS.contains(&a.kind.as_str()) {
        return Err(Asked::BadKind);
    }
    let text = line(&a.text, TEXT_CHARS);
    if text.is_empty() {
        return Err(Asked::Empty);
    }
    let options: Vec<String> = a
        .options
        .iter()
        .map(|o| line(o, OPTION_CHARS).replace('\n', " "))
        .filter(|o| !o.is_empty())
        .collect();
    let ok = match a.kind.as_str() {
        "decide" => (2..=4).contains(&options.len()),
        _ => options.is_empty(),
    };
    if !ok {
        return Err(Asked::BadOptions);
    }
    let recommended = if (0..options.len() as i64).contains(&a.recommended) {
        a.recommended
    } else {
        -1
    };
    let cmd = if a.kind == "run" {
        command(&a.cmd).ok_or(Asked::BadCmd)?
    } else {
        ""
    };
    Ok(Checked {
        text,
        options,
        recommended,
        cmd,
        link: line(&a.link, 400),
        via: if a.via == "dialog" { "dialog" } else { "ask" },
        by: line(&a.by, 60),
    })
}

/// Several questions an agent needs decided before it goes on, put as one
/// card (#110): each its own `decide` turn, answered and told as one is, and
/// all of them sharing `ask_group`, the first one's id. One question is a
/// turn of its own, with no group. All go in, or none: a group cut short by
/// the desk's room for turns would be a card missing its last questions.
pub fn ask_group(conn: &mut Connection, desk_id: i64, asks: &[Ask], now: i64) -> Result<Asked> {
    if asks.is_empty() {
        return Ok(Asked::Empty);
    }
    if asks.len() > GROUP_MAX || (asks.len() > 1 && asks.iter().any(|a| a.kind != "decide")) {
        return Ok(Asked::BadGroup);
    }
    let mut checked = Vec::with_capacity(asks.len());
    for a in asks {
        match check(a) {
            Ok(c) => checked.push(c),
            Err(why) => return Ok(why),
        }
    }
    let tx = conn.transaction()?;
    if !desk_open(&tx, desk_id)? {
        return Ok(Asked::NoSuchDesk);
    }
    let waiting: i64 = tx.query_row(
        "SELECT COUNT(*) FROM turns WHERE desk_id = ?1 AND removed_at = 0 AND answered_at = 0",
        params![desk_id],
        |r| r.get(0),
    )?;
    if waiting + asks.len() as i64 > TURNS_PER_DESK {
        return Ok(Asked::Full);
    }
    // One pane asks for the whole group, so one thread holds it.
    let thread = of_pane(&tx, desk_id, &asks[0].pane)?
        .filter(|t| t.stage != "shipped")
        .map(|t| t.id)
        .unwrap_or(0);
    let mut group = 0;
    let mut turns = Vec::with_capacity(asks.len());
    for (a, c) in asks.iter().zip(&checked) {
        tx.execute(
            "INSERT INTO turns(desk_id, thread_id, pane, by, kind, via, text, options, recommended, link, created_at, cmd, ask_group)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                desk_id,
                thread,
                a.pane,
                c.by,
                a.kind,
                c.via,
                c.text,
                c.options.join("\n"),
                c.recommended,
                c.link,
                now,
                c.cmd,
                group
            ],
        )?;
        let id = tx.last_insert_rowid();
        if asks.len() > 1 && group == 0 {
            group = id;
            tx.execute("UPDATE turns SET ask_group = ?1 WHERE id = ?1", params![id])?;
        }
        turns.push(turn(&tx, desk_id, id)?.expect("the row just written"));
    }
    tx.commit()?;
    Ok(if turns.len() == 1 {
        Asked::Turn(Box::new(turns.remove(0)))
    } else {
        Asked::Group(turns)
    })
}

/// Answer a turn. `in_` is `snyvi` or `panel`. A `decide` answer is one of its
/// options, or the reader's own words; a `try` that needs changes carries
/// what they are after a colon. `None` when there is no such turn or it was
/// answered already -- the first answer stands, wherever it was given.
pub fn answer(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    answer: &str,
    in_: &str,
    now: i64,
) -> Result<Option<Turn>> {
    let answer = line(answer, TEXT_CHARS);
    if answer.is_empty() {
        return Ok(None);
    }
    let in_ = if in_ == "panel" { "panel" } else { "snyvi" };
    let Some(t) = turn(conn, desk_id, id)? else {
        return Ok(None);
    };
    if t.answered_at != 0 || t.removed_at != 0 {
        return Ok(None);
    }
    // A question answered in the panel, or Claude's own question answered
    // anywhere while the mod held it, is already known to Claude: told now.
    let told = if in_ == "panel" || t.via == "dialog" {
        now
    } else {
        0
    };
    let n = conn.execute(
        "UPDATE turns SET answer = ?3, answered_in = ?4, answered_at = ?5, told_at = ?6
         WHERE desk_id = ?1 AND id = ?2 AND answered_at = 0",
        params![desk_id, id, answer, in_, now, told],
    )?;
    if n == 0 {
        return Ok(None);
    }
    turn(conn, desk_id, id)
}

/// The mod's held question is gone without an answer -- the session ended, or
/// Claude moved on. The row is put away, so it does not wait on the reader
/// for a question no one is asking any more.
pub fn drop_dialog(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE turns SET removed_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND via = 'dialog'
         AND answered_at = 0 AND removed_at = 0",
        params![desk_id, id, now],
    )? > 0)
}

pub fn remove_turn(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE turns SET removed_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, now],
    )? > 0)
}

pub fn restore_turn(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE turns SET removed_at = 0 WHERE desk_id = ?1 AND id = ?2",
        params![desk_id, id],
    )? > 0)
}

/// Answers a pane has not been told yet, and they are marked told: what its
/// next prompt carries. Answers to a pane that has gone go to whichever pane
/// on the desk asks next, so a decision is not lost with its panel.
pub fn take_untold(
    conn: &Connection,
    desk_id: i64,
    pane: &str,
    live: &[String],
    now: i64,
) -> Result<Vec<Turn>> {
    let mut st = conn.prepare(&format!(
        "SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND removed_at = 0
         AND answered_at != 0 AND told_at = 0 ORDER BY answered_at, id LIMIT 8"
    ))?;
    let all: Vec<Turn> = st
        .query_map(params![desk_id], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    let mine: Vec<Turn> = all
        .into_iter()
        .filter(|t| t.pane == pane || !live.contains(&t.pane))
        .collect();
    let mut up = conn.prepare_cached("UPDATE turns SET told_at = ?2 WHERE id = ?1")?;
    for t in &mine {
        up.execute(params![t.id, now])?;
    }
    Ok(mine)
}

// --- suggestions -----------------------------------------------------------

const SUG_COLS: &str =
    "id, desk_id, kind, name, cmd, folder, why, by, pane, created_at, settled_at, outcome";

fn row_to_suggestion(r: &rusqlite::Row) -> rusqlite::Result<Suggestion> {
    Ok(Suggestion {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        kind: r.get(2)?,
        name: r.get(3)?,
        cmd: r.get(4)?,
        folder: r.get(5)?,
        why: r.get(6)?,
        by: r.get(7)?,
        pane: r.get(8)?,
        created_at: r.get(9)?,
        settled_at: r.get(10)?,
        outcome: r.get(11)?,
    })
}

pub fn suggestion(conn: &Connection, desk_id: i64, id: i64) -> Result<Option<Suggestion>> {
    Ok(conn
        .query_row(
            &format!("SELECT {SUG_COLS} FROM desk_suggestions WHERE desk_id = ?1 AND id = ?2"),
            params![desk_id, id],
            row_to_suggestion,
        )
        .optional()?)
}

/// What is waiting on a desk, oldest first.
pub fn suggestions(conn: &Connection, desk_id: i64) -> Result<Vec<Suggestion>> {
    let mut st = conn.prepare(&format!(
        "SELECT {SUG_COLS} FROM desk_suggestions WHERE desk_id = ?1 AND settled_at = 0 ORDER BY id"
    ))?;
    let v = st
        .query_map(params![desk_id], row_to_suggestion)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What `suggest_panel` or `suggest_desk` was asked.
#[derive(Clone, Debug, Default)]
pub struct Suggest {
    pub kind: String,
    pub name: String,
    pub cmd: String,
    pub folder: String,
    pub why: String,
    pub by: String,
    pub pane: String,
}

#[derive(Debug, PartialEq)]
pub enum Suggested {
    /// Boxed, as `Moved::Thread`.
    Card(Box<Suggestion>),
    Full,
    Empty,
    /// `suggest_desk` for a folder that already has a desk: the desk is there.
    HasDesk(i64),
    NoSuchDesk,
}

pub fn suggest(conn: &mut Connection, desk_id: i64, s: &Suggest, now: i64) -> Result<Suggested> {
    // A widget is a proposed widget file (`crate::server::api_widget`):
    // its name, its command to show, and where its folder waits.
    let kind = match s.kind.as_str() {
        "desk" => "desk",
        "widget" => "widget",
        _ => "panel",
    };
    let name = line(&s.name, NAME_CHARS);
    // A command is one line, as the panel will run it: a newline in it would
    // run a second command the card did not show.
    let cmd = line(&s.cmd, CMD_CHARS);
    let folder = line(&s.folder, PATH_CHARS);
    let why = line(&s.why, 200);
    let by = line(&s.by, 60);
    if why.is_empty()
        || (kind == "panel" && cmd.is_empty())
        || (kind == "desk" && folder.is_empty())
        || (kind == "widget" && (name.is_empty() || folder.is_empty()))
    {
        return Ok(Suggested::Empty);
    }
    let tx = conn.transaction()?;
    if !desk_open(&tx, desk_id)? {
        return Ok(Suggested::NoSuchDesk);
    }
    if kind == "desk" {
        let trimmed = folder.trim_end_matches('/');
        let has: Option<i64> = tx
            .query_row(
                "SELECT id FROM desks WHERE closed_at = 0 AND rtrim(root, '/') = ?1 LIMIT 1",
                params![trimmed],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(d) = has {
            return Ok(Suggested::HasDesk(d));
        }
    }
    let waiting: i64 = tx.query_row(
        "SELECT COUNT(*) FROM desk_suggestions WHERE desk_id = ?1 AND settled_at = 0",
        params![desk_id],
        |r| r.get(0),
    )?;
    if waiting >= SUGGESTIONS_PER_DESK {
        return Ok(Suggested::Full);
    }
    tx.execute(
        "INSERT INTO desk_suggestions(desk_id, kind, name, cmd, folder, why, by, pane, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![desk_id, kind, name, cmd, folder, why, by, s.pane, now],
    )?;
    let id = tx.last_insert_rowid();
    let card = suggestion(&tx, desk_id, id)?.expect("the row just written");
    tx.commit()?;
    Ok(Suggested::Card(Box::new(card)))
}

/// The reader opened it, or put it away with ✕. Settled once.
pub fn settle(
    conn: &Connection,
    desk_id: i64,
    id: i64,
    outcome: &str,
    now: i64,
) -> Result<Option<Suggestion>> {
    let outcome = if outcome == "opened" {
        "opened"
    } else {
        "dismissed"
    };
    let n = conn.execute(
        "UPDATE desk_suggestions SET settled_at = ?3, outcome = ?4 WHERE desk_id = ?1 AND id = ?2
         AND settled_at = 0",
        params![desk_id, id, now, outcome],
    )?;
    if n == 0 {
        return Ok(None);
    }
    suggestion(conn, desk_id, id)
}

/// Undo a ✕: the card is waiting again. An opened one stays opened -- the
/// panel is there, and closing it is the panel's ✕.
pub fn unsettle(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_suggestions SET settled_at = 0, outcome = '' WHERE desk_id = ?1 AND id = ?2
         AND outcome = 'dismissed'",
        params![desk_id, id],
    )? > 0)
}

/// Suggestions this pane made that the reader has opened and it has not been
/// told of; marked told.
pub fn take_opened(
    conn: &Connection,
    desk_id: i64,
    pane: &str,
    now: i64,
) -> Result<Vec<Suggestion>> {
    let mut st = conn.prepare(&format!(
        "SELECT {SUG_COLS} FROM desk_suggestions WHERE desk_id = ?1 AND pane = ?2
         AND outcome = 'opened' AND told_at = 0 ORDER BY settled_at, id LIMIT 4"
    ))?;
    let v: Vec<Suggestion> = st
        .query_map(params![desk_id, pane], row_to_suggestion)?
        .collect::<rusqlite::Result<_>>()?;
    let mut up = conn.prepare_cached("UPDATE desk_suggestions SET told_at = ?2 WHERE id = ?1")?;
    for s in &v {
        up.execute(params![s.id, now])?;
    }
    Ok(v)
}

#[cfg(test)]
mod tests;
