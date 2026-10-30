//! Routines (1.50, plan 4f1379f4a4): a line that comes back. The reader
//! types `newsroom · every day 07:30` in a desk's notes field; it is kept
//! here, apart from the notes -- no tick, no done, no stage, never in Home's
//! Due list or the brief's open notes -- and at its hour snyvi starts the
//! desk's own slash command in a panel in the back (`server::routine_run`).
//!
//! What it holds to:
//!
//! - **The reader's line, the reader's file.** The prompt is `/<the line's
//!   head>`, and its first word must be a command file under the desk's
//!   folder, `.claude/commands/<word>.md`, hashed when the reader allowed it:
//!   a file changed since is not run until they allow it again. Nothing an
//!   agent writes becomes a daily prompt; an agent may offer a routine, and
//!   only the reader's Save in the sheet makes it real.
//! - **What waits for the reader is denied, not asked.** `waits` is the
//!   reader's list of Bash patterns; the runner writes them into the run's
//!   settings file as deny rules, so the agent cannot run them and hands
//!   each over as a card instead.
//! - **A clock, never a queue.** A missed hour runs once at the next tick
//!   and says how late; an hour that cannot run says why on the row and
//!   waits for the next one.
//! - **Nothing is deleted.** Remove from view and Pause are stamps; the runs
//!   stay in `routine_runs`, which is the routine's history.
//!
//! 1.53 (plan f30461f2c1): a routine has a field of its own, and a line
//! there is a **draft** until the reader's Start (`started_at`). Its name
//! resolves through `places` -- the reader's and the project's commands
//! and skills, in Claude Code's order -- and the file it came to is kept
//! (`file`) and hashed; a line whose first word is none of them is the
//! reader's own words, sent as they are. An agent's offer is a draft with
//! its name on it, and never words.
//!
//! The store's side only, as `crate::desk` is for notes: no HTTP, no panes.

pub mod places;
pub mod waits;

use crate::due::every::{every, every_tail, Every};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cmd TEXT NOT NULL,
  every TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  waits TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 25,
  five_hour INTEGER NOT NULL DEFAULT 80,
  pane TEXT NOT NULL DEFAULT '',
  cmd_hash TEXT NOT NULL DEFAULT '',
  allowed_at INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0,
  last_state TEXT NOT NULL DEFAULT '',
  last_line TEXT NOT NULL DEFAULT '',
  runs INTEGER NOT NULL DEFAULT 0,
  running_since INTEGER NOT NULL DEFAULT 0,
  running TEXT NOT NULL DEFAULT '',
  late_s INTEGER NOT NULL DEFAULT 0,
  suggested_by TEXT NOT NULL DEFAULT '',
  suggested_pane TEXT NOT NULL DEFAULT '',
  paused_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS routines_desk ON routines(desk_id, removed_at, due_at);
CREATE TABLE IF NOT EXISTS routine_runs (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  why TEXT NOT NULL,
  what TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '',
  line TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS routine_runs_of ON routine_runs(routine_id, started_at);
"#;

/// 1.53: a draft until Start, and the file its name came to (`places`),
/// `~/…` or under the desk. Every routine before this was live, and a
/// `.claude/commands/` file. Version 32 of `store::MIGRATIONS`.
pub const DRAFT_COLUMNS_1_53: &str =
    "ALTER TABLE routines ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE routines ADD COLUMN file TEXT NOT NULL DEFAULT '';
     UPDATE routines SET started_at = created_at WHERE suggested_by = '';
     UPDATE routines SET file = '.claude/commands/' || cmd || '.md' WHERE cmd != '';";

/// 1.54 (#198): how late each run started, for its line in History, and
/// how long the machine slept through a run, so a laptop's lid never
/// counts against its minutes (`slept`). A run's sleep is kept on its
/// history line too. Version 34 of `store::MIGRATIONS`.
pub const LATE_COLUMNS_1_54: &str =
    "ALTER TABLE routine_runs ADD COLUMN late_s INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE routine_runs ADD COLUMN slept_s INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE routines ADD COLUMN slept_s INTEGER NOT NULL DEFAULT 0;";

/// How many routines a desk keeps: a handful is the point.
pub const PER_DESK: i64 = 6;
/// The longest line a routine is: the reader's words are its prompt.
pub const WORDS_CHARS: usize = 200;
/// The longest line kept from a run's last message.
pub const LINE_CHARS: usize = 120;
/// What waits for the reader: this many patterns, this long, at most.
const WAITS_MAX: usize = 12;
const WAIT_CHARS: usize = 200;

/// `running`: a Claude session is under way in the routine's panel. Any
/// other non-empty value is the command a run card started there.
pub const SESSION: &str = "session";

/// A routine, as the rail draws it and the runner reads it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Routine {
    pub id: i64,
    pub desk_id: i64,
    /// The line's head, as typed, without its `/`: `newsroom`, `bench main`,
    /// or the reader's own words.
    pub name: String,
    /// Its first word, the command or skill it runs; empty for words.
    pub cmd: String,
    /// The cadence, said one way (`Every::words`).
    pub every: String,
    /// The next hour it runs at.
    pub due_at: i64,
    pub waits: Vec<String>,
    pub minutes: i64,
    pub five_hour: i64,
    /// Its panel in the back, once it has run; empty before.
    pub pane: String,
    #[serde(skip)]
    pub cmd_hash: String,
    pub allowed_at: i64,
    pub last_at: i64,
    pub last_state: String,
    pub last_line: String,
    pub runs: i64,
    pub running_since: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub running: String,
    /// How late the run under way, or the last, started, in seconds: a
    /// clock's catch-up only; any other start is on time.
    pub late_s: i64,
    /// How long the machine slept while the run under way ran (1.54,
    /// #198): its minutes are counted without it.
    pub slept_s: i64,
    /// The agent offering it, while it is an offer.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub suggested_by: String,
    #[serde(skip)]
    pub suggested_pane: String,
    pub paused_at: i64,
    pub created_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub removed_at: i64,
    /// The reader's Start; 0 while a draft or an offer.
    pub started_at: i64,
    /// The file its name came to when it was allowed (`places::Place::file`).
    #[serde(rename = "path")]
    pub file: String,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Routine {
    /// What the session is started with: the reader's line, as a slash
    /// command, or their words as they are. Words never start with `/`.
    pub fn prompt(&self) -> String {
        if self.cmd.is_empty() {
            self.name.trim_start_matches('/').to_string()
        } else {
            format!("/{}", self.name)
        }
    }

    /// `offer`, `draft`, `paused` or `live`: the four stamps read as one.
    pub fn state(&self) -> &'static str {
        if !self.suggested_by.is_empty() {
            "offer"
        } else if self.started_at == 0 {
            "draft"
        } else if self.paused_at != 0 {
            "paused"
        } else {
            "live"
        }
    }

    /// Whether it is the reader's words rather than a command's.
    pub fn words(&self) -> bool {
        self.cmd.is_empty()
    }

    pub fn cadence(&self) -> Option<Every> {
        every(&self.every)
    }
}

/// One run, for the sheet's history.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Run {
    pub id: i64,
    /// `clock`, `you` (Run now), `try` (Try once now), `answer` (a card's
    /// answer) or `card` (a run card's command).
    pub why: String,
    pub what: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub state: String,
    pub line: String,
    /// How late a clock's catch-up started, in seconds; 0 for any other.
    pub late_s: i64,
    /// How long the machine slept while it ran.
    pub slept_s: i64,
}

/// A line read as a routine: its name, its command, its cadence.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub name: String,
    /// The first word when it could be a command's name, else empty.
    pub cmd: String,
    /// Typed with its `/`: a command, never words.
    pub slash: bool,
    pub every: Every,
}

impl Line {
    /// The same line as the reader's words: no command.
    pub fn into_words(mut self) -> Line {
        self.cmd.clear();
        self
    }
}

/// What a line ending in a cadence says: `newsroom · every day 07:30`,
/// `/bench main, every weekday 9`, `open PRs, summarise · every weekday 9`.
/// Whether its first word is a command is the caller's to look up
/// (`resolve`): a line typed with `/` must be one, any other may be words.
pub fn from_line(text: &str) -> Option<Line> {
    let (head, every) = every_tail(text)?;
    let head = head.trim().trim_end_matches(['·', ',', ';', '-']).trim();
    let slash = head.starts_with('/');
    let name = head.trim_start_matches('/').trim().to_string();
    let first = name.split_whitespace().next()?.to_string();
    let cmd = if cmd_ok(&first) { first } else { String::new() };
    if (slash && cmd.is_empty()) || name.chars().any(char::is_control) {
        return None;
    }
    Some(Line {
        name: crate::thread::line(&name, WORDS_CHARS),
        cmd,
        slash,
        every,
    })
}

/// What a line's name comes to in a desk's folder.
#[derive(Debug, PartialEq)]
pub enum Made {
    /// A command or a skill, and its hash as it is now.
    File(places::Place, String),
    /// The reader's words.
    Words,
    /// Two files the docs leave open (`places::Resolved::Two`).
    Two(String, String),
    /// Typed with `/`, and there is no such command or skill.
    NoFile(String),
}

/// What a line comes to: its first word resolved, or the reader's words.
pub fn resolve(root: &Path, line: &Line) -> Made {
    resolve_name(root, &line.cmd, line.slash)
}

fn resolve_name(root: &Path, cmd: &str, slash: bool) -> Made {
    if cmd.is_empty() {
        return Made::Words;
    }
    match places::resolve(root, cmd) {
        places::Resolved::One(p) => match places::hash(&p) {
            Some(h) => Made::File(p, h),
            None => Made::NoFile(cmd.to_string()),
        },
        places::Resolved::Two(a, b) => Made::Two(a.file, b.file),
        places::Resolved::Words if slash => Made::NoFile(cmd.to_string()),
        places::Resolved::Words => Made::Words,
    }
}

/// A command file's name: letters, digits, `-` and `_`.
pub fn cmd_ok(cmd: &str) -> bool {
    !cmd.is_empty()
        && cmd.len() <= 40
        && cmd
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Where a routine's name resolves now, and the file's hash: what Claude
/// Code would run if it started this minute.
pub fn now_of(root: &Path, r: &Routine) -> Made {
    resolve_name(root, &r.cmd, true)
}

/// How a routine's file stands: `ok`, `changed` since it was allowed (its
/// text, or the file its name now comes to), `gone`, `two`, `new` -- a
/// draft or an offer never allowed -- or `words`, which has none.
pub fn file_state(root: &Path, r: &Routine) -> &'static str {
    match now_of(root, r) {
        Made::Words => "words",
        Made::NoFile(_) => "gone",
        Made::Two(..) => "two",
        Made::File(..) if r.cmd_hash.is_empty() => "new",
        Made::File(p, h) if h == r.cmd_hash && p.file == r.file => "ok",
        Made::File(..) => "changed",
    }
}

/// Whether a command's file reads a `continue:` form: then the reader's
/// answers start it fresh as `/<cmd> continue: …`; else they go on in the
/// run's own session (`--resume`). Cheap and honest: it says the author
/// thought of it, and a try says whether it works.
pub fn continues(text: &str) -> bool {
    text.contains("continue:")
        || text.lines().any(|l| {
            let l = l.trim();
            l.starts_with('#') && l.to_ascii_lowercase().contains("continue")
        })
}

/// The reader's Waits list, one pattern a line, or `None` when a line is
/// not one: control characters, too long, too many.
pub fn waits_ok(text: &str) -> Option<Vec<String>> {
    let v: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    let bad = v.len() > WAITS_MAX
        || v.iter()
            .any(|l| l.chars().count() > WAIT_CHARS || l.chars().any(char::is_control));
    (!bad).then_some(v)
}

/// A pattern as a deny rule: `python3 newsroom/publish.py *` becomes
/// `Bash(python3 newsroom/publish.py *)`; a rule written whole is kept.
pub fn rule(pattern: &str) -> String {
    if pattern.starts_with("Bash(") && pattern.ends_with(')') {
        pattern.to_string()
    } else {
        format!("Bash({pattern})")
    }
}

/// The run's settings: the deny rules every run has, and what waits for the
/// reader. Nothing else: the session's other settings are the reader's own.
pub fn settings(deny: &[&str], waits: &[String]) -> serde_json::Value {
    let mut rules: Vec<String> = deny.iter().map(|s| s.to_string()).collect();
    rules.extend(waits.iter().map(|w| rule(w)));
    serde_json::json!({ "permissions": { "deny": rules } })
}

const COLS: &str =
    "id, desk_id, name, cmd, every, due_at, waits, minutes, five_hour, pane, cmd_hash,
    allowed_at, last_at, last_state, last_line, runs, running_since, running, late_s,
    suggested_by, suggested_pane, paused_at, created_at, removed_at, started_at, file, slept_s";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Routine> {
    let waits: String = r.get(6)?;
    Ok(Routine {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        name: r.get(2)?,
        cmd: r.get(3)?,
        every: r.get(4)?,
        due_at: r.get(5)?,
        waits: waits.lines().map(String::from).collect(),
        minutes: r.get(7)?,
        five_hour: r.get(8)?,
        pane: r.get(9)?,
        cmd_hash: r.get(10)?,
        allowed_at: r.get(11)?,
        last_at: r.get(12)?,
        last_state: r.get(13)?,
        last_line: r.get(14)?,
        runs: r.get(15)?,
        running_since: r.get(16)?,
        running: r.get(17)?,
        late_s: r.get(18)?,
        suggested_by: r.get(19)?,
        suggested_pane: r.get(20)?,
        paused_at: r.get(21)?,
        created_at: r.get(22)?,
        removed_at: r.get(23)?,
        started_at: r.get(24)?,
        file: r.get(25)?,
        slept_s: r.get(26)?,
    })
}

/// A desk's routines on view, oldest first.
pub fn for_desk(conn: &Connection, desk_id: i64) -> Result<Vec<Routine>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLS} FROM routines WHERE desk_id = ?1 AND removed_at = 0 ORDER BY id"
    ))?;
    let v = st
        .query_map(params![desk_id], row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// One routine, on view or removed.
pub fn get(conn: &Connection, id: i64) -> Result<Option<Routine>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM routines WHERE id = ?1"),
            params![id],
            row,
        )
        .optional()?)
}

/// The routine a panel is the panel of, while it is on view.
pub fn of_pane(conn: &Connection, pane: &str) -> Result<Option<Routine>> {
    if pane.is_empty() {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLS} FROM routines WHERE pane = ?1 AND removed_at = 0 ORDER BY id DESC LIMIT 1"
            ),
            params![pane],
            row,
        )
        .optional()?)
}

/// The panels a desk's routines run in: their answers are theirs alone
/// (`thread::take_untold` is handed these as live, always).
pub fn panes(conn: &Connection, desk_id: i64) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached(
        "SELECT pane FROM routines WHERE desk_id = ?1 AND removed_at = 0 AND pane != ''",
    )?;
    let v = st
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What came of adding one.
#[derive(Debug, PartialEq)]
pub enum Added {
    Routine(Box<Routine>),
    Full,
    NoSuchDesk,
}

/// Who an offer is from: the agent's name and its panel.
#[derive(Default)]
pub struct Offer<'a> {
    pub by: &'a str,
    pub pane: &'a str,
}

/// A routine from a line, as a draft: nothing is allowed and nothing rings
/// until the reader's Start (`start`). `file` is where its name came to,
/// empty for words; an offer (`from.by`) is a draft with the agent's name.
pub fn add(
    conn: &mut Connection,
    desk_id: i64,
    line: &Line,
    waits: &[String],
    file: &str,
    from: &Offer,
    now: i64,
) -> Result<Added> {
    let tx = conn.transaction()?;
    let open = tx
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !open {
        return Ok(Added::NoSuchDesk);
    }
    let held: i64 = tx.query_row(
        "SELECT COUNT(*) FROM routines WHERE desk_id = ?1 AND removed_at = 0",
        params![desk_id],
        |r| r.get(0),
    )?;
    if held >= PER_DESK {
        return Ok(Added::Full);
    }
    tx.execute(
        "INSERT INTO routines(desk_id, name, cmd, every, due_at, waits, file,
           suggested_by, suggested_pane, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            desk_id,
            line.name,
            line.cmd,
            line.every.words(),
            line.every.next_after(now, crate::due::offset()),
            waits.join("\n"),
            file,
            crate::thread::line(from.by, 60),
            from.pane,
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    let r = get(&tx, id)?.expect("the row just written");
    tx.commit()?;
    Ok(Added::Routine(Box::new(r)))
}

/// The sheet's Save.
pub struct Save {
    pub name: String,
    pub every: Every,
    pub waits: Vec<String>,
    pub minutes: i64,
    pub five_hour: i64,
    /// The file's hash as the reader saw it, and where: saving a live
    /// routine allows it. A draft's waits for Start.
    pub hash: String,
    pub file: String,
}

/// Save the sheet: the next hour read again from the cadence, a live
/// routine's file allowed as it is, and an offer made the reader's draft.
pub fn save(conn: &Connection, id: i64, s: &Save, now: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE routines SET name = ?2, every = ?3, due_at = ?4, waits = ?5, minutes = ?6,
           five_hour = ?7,
           cmd_hash = CASE WHEN started_at = 0 OR ?8 = '' THEN cmd_hash ELSE ?8 END,
           file = CASE WHEN started_at = 0 OR ?8 = '' THEN file ELSE ?10 END,
           allowed_at = CASE WHEN started_at = 0 OR ?8 = '' THEN allowed_at ELSE ?9 END,
           suggested_by = '', suggested_pane = ''
         WHERE id = ?1 AND removed_at = 0",
        params![
            id,
            s.name,
            s.every.words(),
            s.every.next_after(now, crate::due::offset()),
            s.waits.join("\n"),
            s.minutes.clamp(1, 240),
            s.five_hour.clamp(10, 100),
            s.hash,
            now,
            s.file
        ],
    )?;
    Ok(n > 0)
}

/// Start it: a draft or an offer made live, its file allowed as it is now
/// (`hash`, `file`; both empty for words), its first hour the next one.
pub fn start(conn: &Connection, id: i64, hash: &str, file: &str, now: i64) -> Result<bool> {
    let Some(r) = get(conn, id)? else {
        return Ok(false);
    };
    let next = r
        .cadence()
        .map_or(now + 86_400, |e| e.next_after(now, crate::due::offset()));
    Ok(conn.execute(
        "UPDATE routines SET started_at = ?2, due_at = ?3, cmd_hash = ?4, file = ?5,
           allowed_at = ?2, suggested_by = '', suggested_pane = '', late_s = 0
         WHERE id = ?1 AND removed_at = 0 AND started_at = 0",
        params![id, now, next, hash, file],
    )? > 0)
}

/// What the row's menu does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Act {
    Pause,
    Resume,
    Remove,
    Restore,
}

impl Act {
    pub fn of(word: &str) -> Option<Act> {
        Some(match word {
            "pause" => Act::Pause,
            "resume" => Act::Resume,
            "remove" => Act::Remove,
            "restore" => Act::Restore,
            _ => return None,
        })
    }
}

/// Pause, Resume, Remove from view, Restore. Resume reads the next hour
/// from now: a routine paused a week does not ring for the days it missed.
pub fn act(conn: &Connection, id: i64, act: Act, now: i64) -> Result<bool> {
    let Some(r) = get(conn, id)? else {
        return Ok(false);
    };
    let n = match act {
        Act::Pause => conn.execute(
            "UPDATE routines SET paused_at = ?2 WHERE id = ?1 AND removed_at = 0 AND paused_at = 0",
            params![id, now],
        )?,
        Act::Resume => {
            let next = r
                .cadence()
                .map_or(r.due_at, |e| e.next_after(now, crate::due::offset()));
            conn.execute(
                "UPDATE routines SET paused_at = 0, due_at = ?2 WHERE id = ?1 AND removed_at = 0",
                params![id, next],
            )?
        }
        Act::Remove => conn.execute(
            "UPDATE routines SET removed_at = ?2 WHERE id = ?1 AND removed_at = 0",
            params![id, now],
        )?,
        Act::Restore => {
            let next = r
                .cadence()
                .map_or(r.due_at, |e| e.next_after(now, crate::due::offset()));
            conn.execute(
                "UPDATE routines SET removed_at = 0, due_at = ?2 WHERE id = ?1 AND removed_at != 0
                 AND (SELECT COUNT(*) FROM routines o WHERE o.desk_id = routines.desk_id AND o.removed_at = 0) < ?3",
                params![id, next, PER_DESK],
            )?
        }
    };
    Ok(n > 0)
}

/// Allow the command file as it is now (the row's Allow), and the file its
/// name now comes to. A draft is allowed by its Start, not here.
pub fn allow(conn: &Connection, id: i64, hash: &str, file: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE routines SET cmd_hash = ?2, allowed_at = ?3, file = ?4
         WHERE id = ?1 AND removed_at = 0 AND suggested_by = '' AND started_at != 0",
        params![id, hash, now, file],
    )? > 0)
}

/// The clock's question: the routines whose hour has come, on view, not
/// paused, not an offer, on an open desk. A parked desk's are found too,
/// so the hour is passed by and said (`skipped: desk parked`) rather than
/// kept for the day the desk is unparked.
pub fn due(conn: &Connection, now: i64) -> Result<Vec<Routine>> {
    let cols = COLS
        .split(',')
        .map(|c| format!("r.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut st = conn.prepare_cached(&format!(
        "SELECT {cols} FROM routines r JOIN desks d ON d.id = r.desk_id
         WHERE r.due_at <= ?1 AND r.removed_at = 0 AND r.paused_at = 0 AND r.suggested_by = ''
           AND r.started_at != 0 AND d.closed_at = 0
         ORDER BY r.due_at, r.id LIMIT 12"
    ))?;
    let v = st
        .query_map(params![now], row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// A closed desk's hours, passed by without a word: the desk is out of
/// view, so nothing is said, and reopening it never starts a stale run.
pub fn pass_closed(conn: &Connection, now: i64) -> Result<usize> {
    let mut st = conn.prepare_cached(
        "SELECT r.id, r.every FROM routines r JOIN desks d ON d.id = r.desk_id
         WHERE r.due_at <= ?1 AND r.removed_at = 0 AND r.started_at != 0 AND d.closed_at != 0
         LIMIT 64",
    )?;
    let v: Vec<(i64, String)> = st
        .query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, every) in &v {
        let next = crate::due::every::every(every)
            .map_or(now + 86_400, |e| e.next_after(now, crate::due::offset()));
        conn.execute(
            "UPDATE routines SET due_at = ?2, late_s = 0 WHERE id = ?1",
            params![id, next],
        )?;
    }
    Ok(v.len())
}

/// The next hour, set before a run starts, so one that fails to start
/// never rings twice; and how late this one is.
pub fn rearm(conn: &Connection, r: &Routine, now: i64) -> Result<i64> {
    let next = r
        .cadence()
        .map_or(now + 86_400, |e| e.next_after(now, crate::due::offset()));
    let late = if now - r.due_at > 3600 {
        now - r.due_at
    } else {
        0
    };
    conn.execute(
        "UPDATE routines SET due_at = ?2, late_s = ?3 WHERE id = ?1",
        params![r.id, next, late],
    )?;
    Ok(late)
}

/// The panel it runs in, made at its first run.
pub fn set_pane(conn: &Connection, id: i64, pane: &str) -> Result<()> {
    conn.execute(
        "UPDATE routines SET pane = ?2 WHERE id = ?1",
        params![id, pane],
    )?;
    Ok(())
}

/// A run under way: `what` is the prompt or the command, `running` says
/// which. Only the clock's start is late, by what `rearm` found just
/// before it; Run now, a try, an answer and a card are on time, and the
/// row stops saying the last clock run's lateness. Its sleep starts at 0.
pub fn began(
    conn: &Connection,
    id: i64,
    why: &str,
    what: &str,
    running: &str,
    now: i64,
) -> Result<i64> {
    conn.execute(
        "UPDATE routines SET running_since = ?2, running = ?3, last_state = 'running', slept_s = 0,
           late_s = CASE WHEN ?4 = 'clock' THEN late_s ELSE 0 END
         WHERE id = ?1",
        params![id, now, running, why],
    )?;
    conn.execute(
        "INSERT INTO routine_runs(routine_id, why, what, started_at, late_s)
         VALUES(?1, ?2, ?3, ?4, COALESCE((SELECT late_s FROM routines WHERE id = ?1), 0))",
        params![id, why, what, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// A start not from the clock, before its session starts: on time. Said
/// before the start and not only in `began`, since the brief the session
/// reads at its start tells it how late it is.
pub fn not_late(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("UPDATE routines SET late_s = 0 WHERE id = ?1", params![id])?;
    Ok(())
}

/// An hour that never ran leaves the row saying the last run's lateness,
/// not its own: `rearm` wrote it before a start that did not happen.
pub fn late_as_last(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE routines SET late_s = COALESCE((SELECT late_s FROM routine_runs
           WHERE routine_id = ?1 AND state NOT LIKE 'skipped%'
           ORDER BY started_at DESC, id DESC LIMIT 1), 0)
         WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// The machine slept `secs` (`server::routine_run` sees it as a gap in its
/// tick): every run under way had them taken away while it slept, so none
/// is counted against its minutes.
pub fn slept(conn: &Connection, secs: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE routines SET slept_s = slept_s + ?1 WHERE running_since != 0",
        params![secs.max(0)],
    )?)
}

/// The run under way is over: `done`, `stopped at 25 min`, `taken over`,
/// `ended`, with the last line it said. A session's end counts as a run.
pub fn ended(conn: &Connection, id: i64, state: &str, line: &str, now: i64) -> Result<bool> {
    let line = crate::thread::line(line, LINE_CHARS);
    let n = conn.execute(
        "UPDATE routines SET running_since = 0, running = '', last_at = ?2, last_state = ?3,
           last_line = CASE WHEN ?4 = '' THEN last_line ELSE ?4 END,
           runs = runs + CASE WHEN running = 'session' THEN 1 ELSE 0 END
         WHERE id = ?1 AND running_since != 0",
        params![id, now, state, line],
    )?;
    if n > 0 {
        conn.execute(
            "UPDATE routine_runs SET ended_at = ?2, state = ?3, line = ?4,
               slept_s = (SELECT slept_s FROM routines WHERE id = ?1)
             WHERE routine_id = ?1 AND ended_at = 0",
            params![id, now, state, line],
        )?;
    }
    Ok(n > 0)
}

/// An hour that could not run, and why: the row says it, the history keeps
/// it, the next hour is kept, and the lateness the row says is the last
/// run's again.
pub fn skipped(conn: &Connection, id: i64, why: &str, now: i64) -> Result<()> {
    late_as_last(conn, id)?;
    conn.execute(
        "UPDATE routines SET last_state = ?2 WHERE id = ?1",
        params![id, format!("skipped: {why}")],
    )?;
    conn.execute(
        "INSERT INTO routine_runs(routine_id, why, what, started_at, ended_at, state)
         VALUES(?1, 'clock', '', ?2, ?2, ?3)",
        params![id, now, format!("skipped: {why}")],
    )?;
    Ok(())
}

/// A daemon that stopped with a run under way: each is over, said so.
pub fn end_all(conn: &Connection, now: i64) -> Result<usize> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM routines WHERE running_since != 0")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &ids {
        ended(conn, *id, "ended: snyvi restarted", "", now)?;
    }
    Ok(ids.len())
}

/// A routine's runs, newest first.
pub fn runs_of(conn: &Connection, id: i64, limit: i64) -> Result<Vec<Run>> {
    let mut st = conn.prepare_cached(
        "SELECT id, why, what, started_at, ended_at, state, line, late_s, slept_s FROM routine_runs
         WHERE routine_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2",
    )?;
    let v = st
        .query_map(params![id, limit], |r| {
            Ok(Run {
                id: r.get(0)?,
                why: r.get(1)?,
                what: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                state: r.get(5)?,
                line: r.get(6)?,
                late_s: r.get(7)?,
                slept_s: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// Why its last session started: `try`, `clock`, … or empty. A draft's
/// answers go on only after a try (T4).
pub fn last_why(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT why FROM routine_runs WHERE routine_id = ?1 AND why != 'card' AND state NOT LIKE 'skipped%'
             ORDER BY started_at DESC, id DESC LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default())
}

/// The reader's answers to a routine's questions, once all of them are
/// in: what the next session starts with (`server::routine_run`). Only its
/// `decide` cards; the others are told at its next prompt, as any panel's.
/// Empty while one is still open, so a card of three is answered whole.
pub fn answers_ready(conn: &Connection, pane: &str) -> Result<Vec<(i64, String)>> {
    let open: i64 = conn.query_row(
        "SELECT COUNT(*) FROM turns WHERE pane = ?1 AND kind = 'decide' AND answered_at = 0
         AND removed_at = 0",
        params![pane],
        |r| r.get(0),
    )?;
    if open > 0 {
        return Ok(Vec::new());
    }
    let mut st = conn.prepare_cached(
        "SELECT id, answer FROM turns WHERE pane = ?1 AND kind = 'decide' AND answered_at != 0
         AND told_at = 0 AND removed_at = 0 AND via != 'dialog' ORDER BY id LIMIT 12",
    )?;
    let v = st
        .query_map(params![pane], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// The answers, told: the session they start carries them.
pub fn told(conn: &Connection, ids: &[i64], now: i64) -> Result<()> {
    let mut st = conn.prepare_cached("UPDATE turns SET told_at = ?2 WHERE id = ?1")?;
    for id in ids {
        st.execute(params![id, now])?;
    }
    Ok(())
}

/// The reader's answers as one line: their words only, never the questions
/// an agent wrote (TERMINAL.md §9b), numbered as they were asked when
/// there are several.
pub fn said(answers: &[(i64, String)]) -> String {
    let one = |a: &str| -> String {
        a.chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_string()
    };
    match answers {
        [(_, a)] => one(a),
        all => all
            .iter()
            .enumerate()
            .map(|(i, (_, a))| format!("{}. {}", i + 1, one(a)))
            .collect::<Vec<_>>()
            .join("; "),
    }
}

/// The next session's prompt, for a command whose file reads `continue:`.
pub fn continue_prompt(r: &Routine, answers: &[(i64, String)]) -> String {
    format!("{} continue: {}", r.prompt(), said(answers))
}

/// Since `since`: the sessions routines ran, and the cards they raised.
/// Home's week.
pub fn week(conn: &Connection, since: i64) -> Result<(i64, i64)> {
    let ran: i64 = conn.query_row(
        "SELECT COUNT(*) FROM routine_runs WHERE started_at >= ?1 AND why != 'card' AND state NOT LIKE 'skipped%'",
        params![since],
        |r| r.get(0),
    )?;
    let waited: i64 = conn.query_row(
        "SELECT COUNT(*) FROM turns t WHERE t.created_at >= ?1 AND t.pane != ''
         AND t.pane IN (SELECT pane FROM routines WHERE pane != '')",
        params![since],
        |r| r.get(0),
    )?;
    Ok((ran, waited))
}

#[cfg(test)]
mod tests;
