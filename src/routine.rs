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
//! 1.63 (plan d621276291): a routine has **times** (`times`), each hour with
//! its own words and its own "Only if"; a **gate**, a command the reader
//! allowed that says whether a clock run is worth a session; and a
//! **watch**, a command that prints a line when something happens, whose
//! lines in the reader's shape wake it (`events`). Only ids reach the
//! prompt: `/pro-forum tag 5304 ; tag 5311`.
//!
//! The store's side only, as `crate::desk` is for notes: no HTTP, no panes.

pub mod events;
pub mod places;
pub mod times;
pub mod waits;

pub use times::TRIGGER_COLUMNS_1_63;

use crate::due::every::{every_tail, Times};
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

/// 1.66 (plan e7fda1ca90): a routine's file kept as two hashes, what it
/// **may** run and its **words** (`places::split_hash`), and the words as
/// they were, for News's diff; the user's ask and the agent's try, which
/// the Start row says; a change that waits for Allow (`pending`); a watch
/// read fast (`fast`); why it cannot run, said once in Waiting rather than
/// on each skipped hour (`stuck`); and the one routine a copy was folded
/// into.
///
/// Then the copies are folded, once (`pro-forum` was made 13 times, and
/// `blog-next` and `eva-feature-reel` live twice each, one per day): on a
/// desk, the live routines with one command become the newest of them,
/// holding every time the others had, and their waiting events. The others
/// are removed from view, with `merged_into` saying where they went, and
/// keep their own times: nothing is deleted. Drafts and offers are left as
/// they are; the next offer of the same command updates them.
/// Each fold is a line in News (`crate::news`, which comes first in
/// version 40). Version 40 of `store::MIGRATIONS`.
pub const YOU_COLUMNS_1_66: &str = "
ALTER TABLE routines ADD COLUMN may_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN words_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN words_text TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN asked TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN tried TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN pending TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN merged_into INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN stuck TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN stuck_at INTEGER NOT NULL DEFAULT 0;
CREATE TEMP TABLE routine_folds AS
  SELECT r.id AS old,
    (SELECT MAX(o.id) FROM routines o WHERE o.desk_id = r.desk_id AND o.cmd = r.cmd
       AND o.removed_at = 0 AND o.started_at != 0 AND o.suggested_by = '') AS keep
  FROM routines r
  WHERE r.removed_at = 0 AND r.started_at != 0 AND r.suggested_by = '' AND r.cmd != '';
DELETE FROM routine_folds WHERE old = keep;
INSERT INTO routine_times(routine_id, every, words, gated, due_at)
  SELECT f.keep, t.every, t.words, t.gated, t.due_at
  FROM routine_folds f JOIN routine_times t ON t.routine_id = f.old
  WHERE NOT EXISTS (SELECT 1 FROM routine_times k
                    WHERE k.routine_id = f.keep AND k.every = t.every AND k.words = t.words);
UPDATE routine_events SET routine_id = (SELECT keep FROM routine_folds WHERE old = routine_events.routine_id)
  WHERE run_id = 0 AND routine_id IN (SELECT old FROM routine_folds);
UPDATE routines SET due_at = (SELECT MIN(t.due_at) FROM routine_times t WHERE t.routine_id = routines.id AND t.due_at > 0)
  WHERE id IN (SELECT keep FROM routine_folds);
INSERT INTO news(desk_id, kind, text, routine_id, created_at)
  SELECT k.desk_id, 'folded',
    k.name || ': ' || (COUNT(*) + 1) || ' copies are one routine now, with every time they had',
    k.id, CAST(strftime('%s','now') AS INTEGER)
  FROM routine_folds f JOIN routines k ON k.id = f.keep GROUP BY f.keep;
UPDATE routines SET merged_into = (SELECT keep FROM routine_folds WHERE old = routines.id),
    removed_at = CAST(strftime('%s','now') AS INTEGER)
  WHERE id IN (SELECT old FROM routine_folds);
DROP TABLE routine_folds;";

/// How many routines a desk keeps: a handful is the point.
pub const PER_DESK: i64 = 6;
/// The longest line a routine is: the reader's words are its prompt.
pub const WORDS_CHARS: usize = 200;
/// The longest line kept from a run's last message.
pub const LINE_CHARS: usize = 120;
/// What waits for the reader: this many patterns, this long, at most.
const WAITS_MAX: usize = 12;
const WAIT_CHARS: usize = 200;

/// The models a routine may run with (S1), `""` the reader's default.
pub const MODELS: &[&str] = &["", "haiku", "sonnet", "opus", "fable"];
/// Its effort, `""` the default.
pub const EFFORTS: &[&str] = &["", "low", "medium", "high"];

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
    /// 1.63: the command that says whether a clock run is worth a session
    /// (exit 0 yes, 1 no), asked only for a time with "Only if" ticked.
    pub gate: String,
    /// 1.63: the command that prints a line when something happens.
    pub watch: String,
    /// 1.63: the shape a watch's line must have to wake it (`events::ok`).
    pub shape: String,
    /// 1.63: `--model` and `--effort` for its sessions; empty for the default.
    pub model: String,
    pub effort: String,
    /// 1.63: its sessions start without the reader's global CLAUDE.md.
    pub slim: bool,
    /// 1.63: the watch's lines dropped as out of shape, all told.
    pub dropped: i64,
    /// 1.63: what woke the run under way, or the last: written before its
    /// start, so the brief its session reads at once can say it.
    pub woke: String,
    /// 1.66: what it may run and its words, as allowed (`places::split_hash`);
    /// empty on a routine allowed before 1.66 until its file is read as it
    /// was allowed (`file_state`).
    #[serde(skip)]
    pub may_hash: String,
    #[serde(skip)]
    pub words_hash: String,
    #[serde(skip)]
    pub words_text: String,
    /// 1.66: what the user asked for, in their words, and what the agent's
    /// own try of it did: the Start row says both.
    pub asked: String,
    pub tried: String,
    /// 1.66: an agent's change to what a live routine may run, waiting for
    /// the reader's Allow (`Pending`, as JSON); empty with none.
    pub pending: String,
    /// 1.66: its watch's lines run in ten seconds, thirty an hour.
    pub fast: bool,
    /// 1.66: why it cannot run, in the row's words (`changed · Allow`, its
    /// watch gave up), and since when: one row in Waiting, loud, until the
    /// reader allows, saves, resumes or starts it. Empty while it can run.
    pub stuck: String,
    pub stuck_at: i64,
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

    /// The prompt with what woke it (1.63): a time's words, then the ids its
    /// watch or gate printed, `/pro-forum tag 5304 ; tag 5311`. Both are
    /// the reader's: their words, or lines in the shape they allowed.
    pub fn prompt_with(&self, words: &str, ids: &[String]) -> String {
        let mut p = self.prompt();
        if !words.is_empty() {
            p.push(' ');
            p.push_str(words);
        }
        if !ids.is_empty() {
            p.push(' ');
            p.push_str(&ids.join(" ; "));
        }
        p
    }
}

/// One run, for the sheet's history.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Run {
    pub id: i64,
    /// `clock`, `you` (Run now), `try` (Try once now), `answer` (a card's
    /// answer), `card` (a run card's command) or `event` (its watch, 1.63).
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
    /// What woke it (1.63): `13:00 · case`, `tag 5304 ; tag 5311`.
    pub woke: String,
    /// The five-hour window's use before and after, when both readings were
    /// fresh; -1 when not kept.
    pub five_before: f64,
    pub five_after: f64,
    /// Quiet runs of the same day folded into this line (1.63, R10).
    #[serde(skip_serializing_if = "is_zero")]
    pub more: i64,
}

/// A line read as a routine: its name, its command, its cadence.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub name: String,
    /// The first word when it could be a command's name, else empty.
    pub cmd: String,
    /// Typed with its `/`: a command, never words.
    pub slash: bool,
    /// Its when, if the line ends in one (1.63: the field is what-only, and
    /// a draft may have no time until its sheet gives it one).
    pub every: Option<Times>,
}

impl Line {
    /// The same line as the reader's words: no command.
    pub fn into_words(mut self) -> Line {
        self.cmd.clear();
        self
    }
}

/// What a line says: `newsroom`, `/bench main`, `open PRs, summarise`, and
/// a when if it ends in one (`newsroom · every day 07:30`). Whether its
/// first word is a command is the caller's to look up (`resolve`): a line
/// typed with `/` must be one, any other may be words.
pub fn from_line(text: &str) -> Option<Line> {
    let (head, every) = match every_tail(text) {
        Some((h, t)) => (h, Some(t)),
        None => (text.to_string(), None),
    };
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
        places::Resolved::One(p) => match places::hash_with(&p, cmd) {
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
///
/// 1.66: `changed` is a change to what it **may** run, and `reworded` a
/// change to its words alone, which runs on (`places::split_hash`). A
/// routine allowed before 1.66 has no split yet: its whole hash decides,
/// and `split_now` gives it one once its file is as it was allowed.
pub fn file_state(root: &Path, r: &Routine) -> &'static str {
    match now_of(root, r) {
        Made::Words => "words",
        Made::NoFile(_) => "gone",
        Made::Two(..) => "two",
        Made::File(..) if r.cmd_hash.is_empty() => "new",
        Made::File(p, _) if p.file != r.file => "changed",
        Made::File(_, h) if r.may_hash.is_empty() => {
            if h == r.cmd_hash {
                "ok"
            } else {
                "changed"
            }
        }
        Made::File(p, _) => match places::split_hash(&p, &r.cmd) {
            None => "gone",
            Some(s) if s.may != r.may_hash => "changed",
            Some(s) if s.words != r.words_hash => "reworded",
            Some(_) => "ok",
        },
    }
}

/// The routine's file split as it is now, and the whole hash: what `allow`,
/// `start` and the fold of pre-1.66 rows write. `None` for words or a file
/// that is not one.
pub fn split_now(root: &Path, r: &Routine) -> Option<(String, places::Split)> {
    match now_of(root, r) {
        Made::File(p, h) => places::split_hash(&p, &r.cmd).map(|s| (h, s)),
        _ => None,
    }
}

/// The split written as allowed: on Start, Allow and Save with the whole
/// hash the reader saw (`hash`), and on a pre-1.66 row whose file is as it
/// was allowed. Written only when the file still hashes to `hash`, so what
/// is kept is what the reader saw.
pub fn set_split(conn: &Connection, id: i64, hash: &str, s: &places::Split) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE routines SET may_hash = ?3, words_hash = ?4, words_text = ?5
         WHERE id = ?1 AND cmd_hash = ?2",
        params![id, hash, s.may, s.words, cap_text(&s.text)],
    )? > 0)
}

/// Its words changed and nothing it may run did (1.66): the new words are
/// kept as allowed, and the whole hash with them, so the file reads `ok`
/// again; what the words were is returned for News's diff.
pub fn reworded(conn: &Connection, id: i64, hash: &str, s: &places::Split) -> Result<Option<String>> {
    let was: Option<String> = conn
        .query_row(
            "SELECT words_text FROM routines WHERE id = ?1 AND may_hash = ?2",
            params![id, s.may],
            |r| r.get(0),
        )
        .optional()?;
    let Some(was) = was else { return Ok(None) };
    conn.execute(
        "UPDATE routines SET words_hash = ?2, words_text = ?3, cmd_hash = ?4 WHERE id = ?1",
        params![id, s.words, cap_text(&s.text), hash],
    )?;
    Ok(Some(was))
}

/// Words kept for a diff, at most this long: a command is a page, not a book.
const WORDS_KEPT: usize = 20_000;

fn cap_text(t: &str) -> String {
    if t.len() <= WORDS_KEPT {
        return t.to_string();
    }
    let mut end = WORDS_KEPT;
    while !t.is_char_boundary(end) {
        end -= 1;
    }
    t[..end].to_string()
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
///
/// 1.63 (S2): a slim run leaves out the reader's global `CLAUDE.md` with
/// Claude Code's own `claudeMdExcludes`; their commands and skills stay, so
/// `/pro-forum` is still there.
pub fn settings(deny: &[&str], waits: &[String], slim_home: Option<&Path>) -> serde_json::Value {
    let mut rules: Vec<String> = deny.iter().map(|s| s.to_string()).collect();
    rules.extend(waits.iter().map(|w| rule(w)));
    let mut v = serde_json::json!({ "permissions": { "deny": rules } });
    if let Some(home) = slim_home {
        let f = home.join(".claude").join("CLAUDE.md");
        v["claudeMdExcludes"] = serde_json::json!([f.to_string_lossy()]);
    }
    v
}

const COLS: &str =
    "id, desk_id, name, cmd, every, due_at, waits, minutes, five_hour, pane, cmd_hash,
    allowed_at, last_at, last_state, last_line, runs, running_since, running, late_s,
    suggested_by, suggested_pane, paused_at, created_at, removed_at, started_at, file, slept_s,
    gate, watch, shape, model, effort, slim, dropped, woke,
    may_hash, words_hash, words_text, asked, tried, pending, fast, stuck, stuck_at";

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
        gate: r.get(27)?,
        watch: r.get(28)?,
        shape: r.get(29)?,
        model: r.get(30)?,
        effort: r.get(31)?,
        slim: r.get::<_, i64>(32)? != 0,
        dropped: r.get(33)?,
        woke: r.get(34)?,
        may_hash: r.get(35)?,
        words_hash: r.get(36)?,
        words_text: r.get(37)?,
        asked: r.get(38)?,
        tried: r.get(39)?,
        pending: r.get(40)?,
        fast: r.get::<_, i64>(41)? != 0,
        stuck: r.get(42)?,
        stuck_at: r.get(43)?,
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
         VALUES(?1, ?2, ?3, '', 0, ?4, ?5, ?6, ?7, ?8)",
        params![
            desk_id,
            line.name,
            line.cmd,
            waits.join("\n"),
            file,
            crate::thread::line(from.by, 60),
            from.pane,
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    if let Some(t) = &line.every {
        let one = times::Line {
            times: t.clone(),
            words: String::new(),
            gated: true,
        };
        times::set(&tx, id, &[one], now)?;
    }
    let r = get(&tx, id)?.expect("the row just written");
    tx.commit()?;
    Ok(Added::Routine(Box::new(r)))
}

/// What wakes a routine besides its times, and what it runs with (1.63).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Triggers {
    pub gate: String,
    pub watch: String,
    pub shape: String,
    pub model: String,
    pub effort: String,
}

/// The sheet's Save.
#[derive(Clone, Default)]
pub struct Save {
    pub name: String,
    /// Its When, whole: empty for a draft with no time yet, `None` to keep
    /// the times it has.
    pub times: Option<Vec<times::Line>>,
    pub triggers: Triggers,
    pub slim: bool,
    pub waits: Vec<String>,
    pub minutes: i64,
    pub five_hour: i64,
    /// The file's hash as the reader saw it, and where: saving a live
    /// routine allows it. A draft's waits for Start.
    pub hash: String,
    pub file: String,
}

/// Save the sheet: its times written whole and armed from now, its gate,
/// watch and shape, a live routine's file allowed as it is, and an offer
/// made the reader's draft. One transaction: what the reader saved is
/// what runs, all of it or none (R5). `false` when it is not on view or
/// names more than `times::MAX` hours.
pub fn save(conn: &mut Connection, id: i64, s: &Save, now: i64) -> Result<bool> {
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE routines SET name = ?2, waits = ?3, minutes = ?4, five_hour = ?5,
           cmd_hash = CASE WHEN started_at = 0 OR ?6 = '' THEN cmd_hash ELSE ?6 END,
           file = CASE WHEN started_at = 0 OR ?6 = '' THEN file ELSE ?8 END,
           allowed_at = CASE WHEN started_at = 0 OR ?6 = '' THEN allowed_at ELSE ?7 END,
           suggested_by = '', suggested_pane = '', stuck = '', stuck_at = 0, pending = '',
           gate = ?9, watch = ?10, shape = ?11, model = ?12, effort = ?13, slim = ?14
         WHERE id = ?1 AND removed_at = 0",
        params![
            id,
            s.name,
            s.waits.join("\n"),
            s.minutes.clamp(1, 240),
            s.five_hour.clamp(10, 100),
            s.hash,
            now,
            s.file,
            s.triggers.gate,
            s.triggers.watch,
            s.triggers.shape,
            s.triggers.model,
            s.triggers.effort,
            s.slim as i64,
        ],
    )?;
    if n == 0 {
        return Ok(false);
    }
    if let Some(t) = &s.times {
        if times::set(&tx, id, t, now)?.is_none() {
            return Ok(false);
        }
    }
    tx.commit()?;
    Ok(true)
}

/// An agent's offer, given what it would run with (1.63): its times, gate,
/// watch, shape, model. Only on an offer row, which never runs; the
/// reader's Save is what makes any of it theirs.
pub fn offered(
    conn: &mut Connection,
    id: i64,
    when: &[times::Line],
    t: &Triggers,
    now: i64,
) -> Result<bool> {
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE routines SET gate = ?2, watch = ?3, shape = ?4, model = ?5, effort = ?6
         WHERE id = ?1 AND suggested_by != '' AND started_at = 0",
        params![id, t.gate, t.watch, t.shape, t.model, t.effort],
    )?;
    if n == 0 || times::set(&tx, id, when, now)?.is_none() {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

/// Whether a routine has a when: a time, or a watch to wake it (C3).
pub fn has_when(conn: &Connection, r: &Routine) -> Result<bool> {
    Ok(!r.watch.trim().is_empty() || !times::times_of(conn, r.id)?.is_empty())
}

/// Start it: a draft or an offer made live, its file allowed as it is now
/// (`hash`, `file`; both empty for words), its first hour the next one.
pub fn start(conn: &Connection, id: i64, hash: &str, file: &str, now: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE routines SET started_at = ?2, cmd_hash = ?3, file = ?4,
           allowed_at = ?2, suggested_by = '', suggested_pane = '', late_s = 0, stuck = '', stuck_at = 0
         WHERE id = ?1 AND removed_at = 0 AND started_at = 0",
        params![id, now, hash, file],
    )?;
    if n > 0 {
        times::rearm_all(conn, id, now)?;
    }
    Ok(n > 0)
}

/// It cannot run, and why (1.66): `true` when this is news, so the caller
/// says it once -- a Waiting row, a redraw, a log line -- and not on every
/// look. A watch that stopped on a changed script was a "done" row that
/// said nothing (bug 0f204f3135).
pub fn stuck(conn: &Connection, id: i64, why: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE routines SET stuck = ?2, stuck_at = ?3 WHERE id = ?1 AND removed_at = 0 AND stuck != ?2",
        params![id, line(why, LINE_CHARS), now],
    )? > 0)
}

/// It can run again on its own: the file is as allowed once more.
pub fn unstuck(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE routines SET stuck = '', stuck_at = 0 WHERE id = ?1 AND stuck != ''",
        params![id],
    )? > 0)
}

fn line(s: &str, n: usize) -> String {
    crate::thread::line(s, n)
}

/// An agent's change to what a live routine may run (1.66), kept until the
/// reader's Allow: what waits for them, what wakes it and what lets a clock
/// run through. The routine runs as it was allowed until then.
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Pending {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waits: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default)]
    pub by: String,
}

impl Pending {
    pub fn is_empty(&self) -> bool {
        self.waits.is_none() && self.gate.is_none() && self.watch.is_none() && self.shape.is_none()
    }
}

/// Keep an agent's change for the reader's Allow; an empty one clears it.
pub fn set_pending(conn: &Connection, id: i64, p: &Pending) -> Result<bool> {
    let v = if p.is_empty() {
        String::new()
    } else {
        serde_json::to_string(p)?
    };
    Ok(conn.execute(
        "UPDATE routines SET pending = ?2 WHERE id = ?1 AND removed_at = 0",
        params![id, v],
    )? > 0)
}

/// The reader's Allow takes the change in: written, and cleared.
pub fn take_pending(conn: &Connection, id: i64) -> Result<Option<Pending>> {
    let Some(r) = get(conn, id)? else {
        return Ok(None);
    };
    if r.pending.is_empty() {
        return Ok(None);
    }
    let p: Pending = serde_json::from_str(&r.pending).unwrap_or_default();
    conn.execute(
        "UPDATE routines SET pending = '',
           waits = COALESCE(?2, waits), gate = COALESCE(?3, gate),
           watch = COALESCE(?4, watch), shape = COALESCE(?5, shape)
         WHERE id = ?1",
        params![
            id,
            p.waits.as_ref().map(|w| w.join("\n")),
            p.gate,
            p.watch,
            p.shape
        ],
    )?;
    Ok(Some(p))
}

/// The routine on a desk that runs `cmd`, newest on view (1.66): an offer
/// of the same command updates it, never adds a second. `pro-forum` was
/// made thirteen times, and two of them were live at once on one state
/// file, because nothing told the agent there was one already.
pub fn by_cmd(conn: &Connection, desk_id: i64, cmd: &str) -> Result<Option<Routine>> {
    if cmd.is_empty() {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLS} FROM routines WHERE desk_id = ?1 AND cmd = ?2 AND removed_at = 0
                 ORDER BY started_at != 0 DESC, id DESC LIMIT 1"
            ),
            params![desk_id, cmd],
            row,
        )
        .optional()?)
}

/// What an agent changes on a routine that is not what it may run (1.66):
/// its line, its times, its model, effort and pace. On a live routine it is
/// written at once and said in News with Undo; on an offer it is the offer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Change {
    pub name: String,
    pub lines: Vec<times::Line>,
    pub model: String,
    pub effort: String,
    pub fast: bool,
    pub asked: String,
    pub tried: String,
}

/// Write a change whole, in one transaction; `false` when it is not on
/// view or names too many hours.
pub fn change(conn: &mut Connection, id: i64, c: &Change, now: i64) -> Result<bool> {
    let tx = conn.transaction()?;
    let n = tx.execute(
        "UPDATE routines SET name = ?2, model = ?3, effort = ?4, fast = ?5,
           asked = CASE WHEN ?6 = '' THEN asked ELSE ?6 END,
           tried = CASE WHEN ?7 = '' THEN tried ELSE ?7 END
         WHERE id = ?1 AND removed_at = 0",
        params![
            id,
            c.name,
            c.model,
            c.effort,
            c.fast as i64,
            line(&c.asked, 300),
            line(&c.tried, 300)
        ],
    )?;
    if n == 0 || times::set(&tx, id, &c.lines, now)?.is_none() {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

/// A routine's times as `Line`s again, one hour a line: what an Undo puts
/// back.
pub fn lines_of(conn: &Connection, id: i64) -> Result<Vec<times::Line>> {
    Ok(times::times_of(conn, id)?
        .into_iter()
        .filter_map(|t| {
            let e = crate::due::every::every(&t.every)?;
            Some(times::Line {
                times: Times {
                    cadence: e.cadence,
                    at: vec![e.at],
                },
                words: t.words,
                gated: t.gated,
            })
        })
        .collect())
}

/// A change as News says it: `added 21:30, model sonnet`. Empty when
/// nothing a reader would see moved.
pub fn change_said(was: &Routine, was_times: &[times::Time], c: &Change) -> String {
    let mut out: Vec<String> = Vec::new();
    let before: Vec<String> = times::lines(was_times)
        .iter()
        .map(|l| format!("{}{}", l.every, if l.words.is_empty() { String::new() } else { format!(" {}", l.words) }))
        .collect();
    let after: Vec<String> = c
        .lines
        .iter()
        .map(|l| format!("{}{}", l.times.words(), if l.words.is_empty() { String::new() } else { format!(" {}", l.words) }))
        .collect();
    if before != after {
        out.push(if after.is_empty() {
            "no times now".to_string()
        } else {
            format!("runs {}", after.join("; "))
        });
    }
    if was.name != c.name {
        out.push(format!("its line is now /{}", c.name));
    }
    if was.model != c.model {
        out.push(format!(
            "model {}",
            if c.model.is_empty() { "the default" } else { &c.model }
        ));
    }
    if was.effort != c.effort {
        out.push(format!(
            "effort {}",
            if c.effort.is_empty() { "the default" } else { &c.effort }
        ));
    }
    if was.fast != c.fast {
        out.push(if c.fast { "its watch is fast".into() } else { "its watch is at the usual pace".into() });
    }
    out.join(", ")
}

/// What the row's menu does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Act {
    Pause,
    Resume,
    Remove,
    Restore,
    /// 1.63: the run under way ends, said so (`server::routine_run::stop`).
    Stop,
}

impl Act {
    pub fn of(word: &str) -> Option<Act> {
        Some(match word {
            "pause" => Act::Pause,
            "resume" => Act::Resume,
            "remove" => Act::Remove,
            "restore" => Act::Restore,
            "stop" => Act::Stop,
            _ => return None,
        })
    }
}

/// Pause, Resume, Remove from view, Restore. Resume reads the next hour
/// from now: a routine paused a week does not ring for the days it missed.
pub fn act(conn: &Connection, id: i64, act: Act, now: i64) -> Result<bool> {
    let n = match act {
        Act::Pause => conn.execute(
            "UPDATE routines SET paused_at = ?2 WHERE id = ?1 AND removed_at = 0 AND paused_at = 0",
            params![id, now],
        )?,
        Act::Resume => conn.execute(
            "UPDATE routines SET paused_at = 0, stuck = '', stuck_at = 0 WHERE id = ?1 AND removed_at = 0",
            params![id],
        )?,
        Act::Remove => conn.execute(
            "UPDATE routines SET removed_at = ?2 WHERE id = ?1 AND removed_at = 0",
            params![id, now],
        )?,
        Act::Restore => conn.execute(
            "UPDATE routines SET removed_at = 0 WHERE id = ?1 AND removed_at != 0
             AND (SELECT COUNT(*) FROM routines o WHERE o.desk_id = routines.desk_id AND o.removed_at = 0) < ?2",
            params![id, PER_DESK],
        )?,
        Act::Stop => {
            return ended(conn, id, "stopped by you", "", now);
        }
    };
    if n > 0 && matches!(act, Act::Resume | Act::Restore) {
        times::rearm_all(conn, id, now)?;
    }
    Ok(n > 0)
}

/// Allow the command file as it is now (the row's Allow), and the file its
/// name now comes to. A draft is allowed by its Start, not here.
pub fn allow(conn: &Connection, id: i64, hash: &str, file: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE routines SET cmd_hash = ?2, allowed_at = ?3, file = ?4, stuck = '', stuck_at = 0
         WHERE id = ?1 AND removed_at = 0 AND suggested_by = '' AND started_at != 0",
        params![id, hash, now, file],
    )? > 0)
}

/// The clock's question: the routines whose hour has come, on view, not
/// paused, not an offer, not running (R3: passed over, not re-armed, so the
/// hour runs after the run under way), on an open desk; a routine with no
/// time (`due_at = 0`) never. A parked desk's are found too,
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
         WHERE r.due_at > 0 AND r.due_at <= ?1 AND r.removed_at = 0 AND r.paused_at = 0
           AND r.suggested_by = '' AND r.started_at != 0 AND r.running_since = 0 AND d.closed_at = 0
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
        "SELECT r.id FROM routines r JOIN desks d ON d.id = r.desk_id
         WHERE r.due_at > 0 AND r.due_at <= ?1 AND r.removed_at = 0 AND r.started_at != 0
           AND d.closed_at != 0
         LIMIT 64",
    )?;
    let v: Vec<i64> = st
        .query_map(params![now], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &v {
        times::rearm_all(conn, *id, now)?;
        conn.execute("UPDATE routines SET late_s = 0 WHERE id = ?1", params![id])?;
    }
    Ok(v.len())
}

/// The times that rang, set to their next before a run starts, so one
/// that fails to start never rings twice; and how late this one is. The
/// other times past due keep theirs for the next look (R3).
pub fn rearm(conn: &Connection, r: &Routine, f: &times::Fired, now: i64) -> Result<i64> {
    times::rearm_fired(conn, r.id, f, now)?;
    let late = if now - f.due_at > 3600 {
        now - f.due_at
    } else {
        0
    };
    conn.execute(
        "UPDATE routines SET late_s = ?2 WHERE id = ?1",
        params![r.id, late],
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

/// What wakes the run about to start, before its session does (1.63).
pub fn waking(conn: &Connection, id: i64, woke: &str) -> Result<()> {
    conn.execute(
        "UPDATE routines SET woke = ?2 WHERE id = ?1",
        params![id, crate::thread::line(woke, LINE_CHARS)],
    )?;
    Ok(())
}

/// A start not from the clock, before its session starts: on time. Said
/// before the start and not only in `began`, since the brief the session
/// reads at its start tells it how late it is.
pub fn not_late(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("UPDATE routines SET late_s = 0 WHERE id = ?1", params![id])?;
    Ok(())
}

/// The runs that were sessions or commands, in SQL: not an hour passed by,
/// not a quiet run, not a failed gate (1.63, R10).
const RAN: &str =
    "state NOT LIKE 'skipped%' AND state != 'quiet' AND state NOT LIKE 'gate failed%'";

/// An hour that never ran leaves the row saying the last run's lateness,
/// not its own: `rearm` wrote it before a start that did not happen.
pub fn late_as_last(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        &format!(
            "UPDATE routines SET late_s = COALESCE((SELECT late_s FROM routine_runs
               WHERE routine_id = ?1 AND {RAN}
               ORDER BY started_at DESC, id DESC LIMIT 1), 0)
             WHERE id = ?1"
        ),
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
/// it under what started it (`run_why`: `clock`, `event`, `answer`, …),
/// the next hour is kept, and the lateness the row says is the last run's
/// again.
pub fn skipped(conn: &Connection, id: i64, run_why: &str, why: &str, now: i64) -> Result<()> {
    passed(conn, id, run_why, &format!("skipped: {why}"), "", now)
}

/// A run that never was a session, said on the row and kept in History:
/// `skipped: …`, `quiet`, `gate failed: …`.
fn passed(
    conn: &Connection,
    id: i64,
    run_why: &str,
    state: &str,
    woke: &str,
    now: i64,
) -> Result<()> {
    late_as_last(conn, id)?;
    conn.execute(
        "UPDATE routines SET last_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    conn.execute(
        "INSERT INTO routine_runs(routine_id, why, what, started_at, ended_at, state, woke)
         VALUES(?1, ?2, '', ?3, ?3, ?4, ?5)",
        params![id, run_why, now, state, woke],
    )?;
    Ok(())
}

/// The gate said no (exit 1, 1.63): one grey line, no session, no panel.
/// The row says `quiet` and when.
pub fn quiet(conn: &Connection, id: i64, woke: &str, now: i64) -> Result<()> {
    passed(conn, id, "clock", "quiet", woke, now)?;
    conn.execute(
        "UPDATE routines SET last_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// The gate failed (any exit but 0 and 1, a timeout): on the row, in History.
pub fn gate_failed(conn: &Connection, id: i64, why: &str, woke: &str, now: i64) -> Result<()> {
    passed(conn, id, "clock", &format!("gate failed: {why}"), woke, now)
}

/// The states of a routine's last `n` runs, newest first.
pub fn last_states(conn: &Connection, id: i64, n: i64) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached(
        "SELECT state FROM routine_runs WHERE routine_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2",
    )?;
    let v = st
        .query_map(params![id, n], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// What woke a run, and the five-hour window's use as it began (when the
/// reading was fresh), on its history line.
pub fn woke(conn: &Connection, run_id: i64, woke: &str, five: Option<f64>) -> Result<()> {
    conn.execute(
        "UPDATE routine_runs SET woke = ?2, five_before = ?3 WHERE id = ?1",
        params![
            run_id,
            crate::thread::line(woke, LINE_CHARS),
            five.unwrap_or(-1.0)
        ],
    )?;
    Ok(())
}

/// The window's use as the run ended, when the reading was fresh: History
/// says "window moved 2%" only when both ends were.
pub fn five_after(conn: &Connection, id: i64, five: Option<f64>) -> Result<()> {
    conn.execute(
        "UPDATE routine_runs SET five_after = ?2 WHERE id = (SELECT id FROM routine_runs
           WHERE routine_id = ?1 AND ended_at != 0 ORDER BY ended_at DESC, id DESC LIMIT 1)
           AND five_before >= 0",
        params![id, five.unwrap_or(-1.0)],
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

/// A routine's runs, newest first, `limit` lines. A day's quiet runs are
/// one line, its `more` the others (R10): four a day would fill History
/// in a week.
pub fn runs_of(conn: &Connection, id: i64, limit: i64) -> Result<Vec<Run>> {
    let mut st = conn.prepare_cached(
        "SELECT id, why, what, started_at, ended_at, state, line, late_s, slept_s, woke,
           five_before, five_after FROM routine_runs
         WHERE routine_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2",
    )?;
    let all: Vec<Run> = st
        .query_map(params![id, limit * 8], |r| {
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
                woke: r.get(9)?,
                five_before: r.get(10)?,
                five_after: r.get(11)?,
                more: 0,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(fold_quiet(all, limit as usize))
}

/// The local day a time is on.
fn day_of(at: i64) -> i64 {
    (at + crate::due::offset().whole_seconds() as i64).div_euclid(86_400)
}

/// Quiet runs on the same day as the quiet line above them, folded into it.
fn fold_quiet(all: Vec<Run>, limit: usize) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in all {
        if r.state == "quiet" {
            if let Some(q) = out
                .iter_mut()
                .rev()
                .find(|q| q.state == "quiet" && day_of(q.started_at) == day_of(r.started_at))
            {
                q.more += 1;
                continue;
            }
        }
        if out.len() >= limit {
            break;
        }
        out.push(r);
    }
    out
}

/// Why its last session started: `try`, `clock`, … or empty. A draft's
/// answers go on only after a try (T4).
pub fn last_why(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT why FROM routine_runs WHERE routine_id = ?1 AND why != 'card' AND {RAN}
                 ORDER BY started_at DESC, id DESC LIMIT 1"
            ),
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
        &format!(
            "SELECT COUNT(*) FROM routine_runs WHERE started_at >= ?1 AND why != 'card' AND {RAN}"
        ),
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
