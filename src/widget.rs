//! The sidebars as sections the reader arranges, and widgets: small boxes in
//! them that anything can fill (docs/WIDGETS.md).
//!
//! **The layout** is one for every page: which sections each side has, in
//! which order, and which are hidden. The sides are fixed -- the left is
//! global and the right is the desk on the page -- so a section never
//! changes side, and Your turn is always first on the right and never hidden
//! (`Layout::normalize`). The reader's folds are not here: they are the
//! page's, per reader (`snyvi.fold`).
//!
//! **A widget** is a name and a body. A body is Markdown, or one JSON object
//! with the Markdown in it and a tone, a count and a size (`Body::parse`):
//! the same shape whether an agent pushed it (`set_widget`), a script did
//! (`snyvi widget set`), or a widget file's command printed it. It is drawn
//! through `render::widget_md` and kept, drawn, in `widget_bodies`; a desk's
//! widget is under its desk, a global one under desk 0. An empty body clears.
//!
//! What the reader decided about a widget -- hidden, its settings, the hash
//! of the folder they allowed to run, whether their own edits rerun, the
//! desks it is on and until when -- is `widget_prefs`, by name, and nothing
//! a writer sends changes it.
//!
//! **An agent asks first** (#111). A widget file it proposes is a card on Your
//! turn, and so is the first box a panel pushes onto a desk: `widget_asks`
//! keeps the reader's answer per desk and name -- waiting, yes, not now, or
//! ended -- and the body that waits behind the card.
//!
//! Nothing is deleted on the reader's account: hiding is a flag, and a body
//! cleared by its writer is the writer's to clear.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub mod files;
#[cfg(test)]
mod tests;

/// A widget's title from its name, when it has none of its own:
/// `deploy-status` is "Deploy status".
pub fn title_of(name: &str) -> String {
    let t = name.replace('-', " ");
    let mut c = t.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS ui_layout (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS widget_prefs (
  name TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  trusted_hash TEXT NOT NULL DEFAULT '',
  rerun_edits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS widget_bodies (
  desk_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  body_md TEXT NOT NULL,
  body_html TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'none',
  count TEXT NOT NULL DEFAULT '',
  lines INTEGER NOT NULL DEFAULT 3,
  stale_after INTEGER NOT NULL DEFAULT 1800,
  writer TEXT NOT NULL DEFAULT '',
  pane TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (desk_id, name)
);
CREATE TABLE IF NOT EXISTS widget_asks (
  desk_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  pane TEXT NOT NULL DEFAULT '',
  writer TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  until INTEGER NOT NULL DEFAULT 0,
  until_pane TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (desk_id, name)
);
"#;

/// 1.30: the desks a widget file is on (ids, comma-separated; none is every
/// desk), and until when it is on: a time (0 is until the reader turns it
/// off) or a panel's life. Version 16 of `store::MIGRATIONS`, never in
/// `SCHEMA`.
pub const PREFS_COLUMNS_1_30: [&str; 3] = [
    "ALTER TABLE widget_prefs ADD COLUMN desks TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE widget_prefs ADD COLUMN until INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE widget_prefs ADD COLUMN until_pane TEXT NOT NULL DEFAULT ''",
];

/// The line a widget file's seat says once it has failed `FAILS_TO_STOP`
/// times in a row for the same reason, and does not run again until the
/// reader says Try again, allows it, or its folder changes.
pub const STOPPED: &str = "stopped: ";
pub const FAILS_TO_STOP: u8 = 3;

// --- the layout -----------------------------------------------------------

/// The left's sections, in the order a new reader has them: today's.
/// `widgets` is the slot every global widget sits in, together.
pub const LEFT: [&str; 4] = ["inbox", "desks", "folders", "widgets"];
/// The right's, on a desk. `turn` is Your turn with Suggested under it, and
/// is always first; `widgets` is the slot the desk's widgets sit in.
pub const RIGHT: [&str; 6] = ["turn", "panels", "points", "docs", "notes", "widgets"];
/// The one section that never moves and is never hidden.
pub const FIXED: &str = "turn";

/// Which sections each side has, in order, and which of them are hidden. A
/// section's id is unique on its side; `widgets` is on both, so a hidden
/// slot is named with its side (`left:widgets`, `right:widgets`), and every
/// other id stands for itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Layout {
    #[serde(default)]
    pub left: Vec<String>,
    #[serde(default)]
    pub right: Vec<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

impl Default for Layout {
    fn default() -> Layout {
        Layout {
            left: LEFT.iter().map(|s| s.to_string()).collect(),
            right: RIGHT.iter().map(|s| s.to_string()).collect(),
            hidden: Vec::new(),
        }
    }
}

/// `ids` in the reader's order: unknown ones and repeats dropped, and each
/// known one that is missing put back where it is by default -- after the
/// last section that comes before it there, or first -- so a section added
/// in a later version arrives in its place and nothing the reader moved
/// moves.
fn order(ids: &[String], known: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(known.len());
    for id in ids {
        if known.contains(&id.as_str()) && !out.contains(id) {
            out.push(id.clone());
        }
    }
    for (i, k) in known.iter().enumerate() {
        if out.iter().any(|x| x == k) {
            continue;
        }
        let at = known[..i]
            .iter()
            .rev()
            .find_map(|before| out.iter().position(|x| x == before))
            .map_or(0, |p| p + 1);
        out.insert(at, k.to_string());
    }
    out
}

impl Layout {
    /// The layout as it may be stored and drawn: every known section on its
    /// own side exactly once, Your turn first on the right, and hidden only
    /// what can be. Whatever a page sends goes through this first.
    pub fn normalize(&self) -> Layout {
        let left = order(&self.left, &LEFT);
        let mut right = order(&self.right, &RIGHT);
        right.retain(|x| x != FIXED);
        right.insert(0, FIXED.to_string());
        let can_hide = |h: &str| -> bool {
            match h.split_once(':') {
                Some(("left", "widgets")) | Some(("right", "widgets")) => true,
                Some(_) => false,
                None => h != FIXED && h != "widgets" && (LEFT.contains(&h) || RIGHT.contains(&h)),
            }
        };
        let mut hidden: Vec<String> = Vec::new();
        for h in &self.hidden {
            if can_hide(h) && !hidden.contains(h) {
                hidden.push(h.clone());
            }
        }
        Layout {
            left,
            right,
            hidden,
        }
    }
}

/// The stored layout, or the default when there is none or it does not read.
pub fn layout(conn: &Connection) -> Result<Layout> {
    let json: Option<String> = conn
        .query_row("SELECT json FROM ui_layout WHERE id = 1", [], |r| r.get(0))
        .optional()?;
    Ok(json
        .and_then(|j| serde_json::from_str::<Layout>(&j).ok())
        .unwrap_or_default()
        .normalize())
}

/// Keep `l`, normalized, and give back what was kept.
pub fn set_layout(conn: &Connection, l: &Layout, now: i64) -> Result<Layout> {
    let l = l.normalize();
    conn.execute(
        "INSERT INTO ui_layout (id, json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![serde_json::to_string(&l)?, now],
    )?;
    Ok(l)
}

// --- the contract ---------------------------------------------------------

/// The longest name: a widget's name is its id in the page and its folder.
pub const NAME_MAX: usize = 32;
/// The longest body, in characters, as its writer sent it.
pub const BODY_MAX: usize = 1500;
/// The longest count: a figure and a word, `!2` or `3/5`.
pub const COUNT_MAX: usize = 8;
/// A body's seat, in lines of 20 px: the room it keeps whatever it says.
pub const LINES_MIN: u8 = 1;
pub const LINES_MAX: u8 = 6;
pub const LINES_DEFAULT: u8 = 3;
/// How long a body reads as current before it dims, unless it says.
pub const STALE_DEFAULT: i64 = 30 * 60;
/// The longest `stale_after` a body can ask for; 0 is never.
pub const STALE_MAX: i64 = 7 * 24 * 3600;
/// Widgets a desk can have, and global ones, however they are filled.
pub const DESK_MAX: usize = 6;
pub const GLOBAL_MAX: usize = 8;

/// A widget's name: lowercase letters, digits and dashes, 1 to 32, starting
/// with a letter or a digit. It is a folder name and a CSS id, so nothing
/// that would need escaping in either.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_MAX
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The colour a widget's count takes. `none` is the quiet one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    #[default]
    None,
    Ok,
    Warn,
    Bad,
}

impl Tone {
    pub fn as_str(self) -> &'static str {
        match self {
            Tone::None => "none",
            Tone::Ok => "ok",
            Tone::Warn => "warn",
            Tone::Bad => "bad",
        }
    }
    pub fn parse(s: &str) -> Option<Tone> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "none" => Some(Tone::None),
            "ok" | "good" | "green" => Some(Tone::Ok),
            "warn" | "warning" | "yellow" => Some(Tone::Warn),
            "bad" | "error" | "fail" | "red" => Some(Tone::Bad),
            _ => None,
        }
    }
}

/// What a writer sent: the Markdown, and how to show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    pub md: String,
    pub tone: Tone,
    pub count: String,
    pub lines: u8,
    pub stale_after: i64,
}

/// What a writer sent, read: a body to draw, or the word to clear.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    Body(Body),
    Clear,
}

/// The JSON form, as a writer may send it. Every field but `body` may be
/// left out; `count` may be a number.
#[derive(Deserialize)]
struct Wire {
    body: Option<String>,
    #[serde(default)]
    tone: Option<String>,
    #[serde(default)]
    count: Option<serde_json::Value>,
    #[serde(default)]
    lines: Option<i64>,
    #[serde(default)]
    stale_after: Option<i64>,
}

impl Body {
    /// Read what a writer sent: one JSON object (`{"body": …, "tone": …,
    /// "count": …, "lines": …, "stale_after": …}`) when it is one, and
    /// otherwise Markdown, all of it. Nothing at all, or an empty `body`,
    /// clears. Refusals are sentences, for the dim line in the widget's
    /// seat and for the writer.
    pub fn parse(raw: &str) -> std::result::Result<Sent, String> {
        let t = raw.trim();
        if t.is_empty() {
            return Ok(Sent::Clear);
        }
        let mut b = Body {
            md: t.to_string(),
            tone: Tone::None,
            count: String::new(),
            lines: LINES_DEFAULT,
            stale_after: STALE_DEFAULT,
        };
        if t.starts_with('{') {
            if let Ok(w) = serde_json::from_str::<Wire>(t) {
                let body = w.body.unwrap_or_default();
                if body.trim().is_empty() {
                    return Ok(Sent::Clear);
                }
                b.md = body.trim().to_string();
                if let Some(s) = w.tone {
                    b.tone = Tone::parse(&s)
                        .ok_or_else(|| format!("tone is ok, warn, bad or none, not \"{s}\""))?;
                }
                b.count = match w.count {
                    None | Some(serde_json::Value::Null) => String::new(),
                    Some(serde_json::Value::String(s)) => s.trim().to_string(),
                    Some(serde_json::Value::Number(n)) => n.to_string(),
                    Some(_) => return Err("count is a number or a short text".into()),
                };
                if let Some(l) = w.lines {
                    b.lines = l.clamp(LINES_MIN as i64, LINES_MAX as i64) as u8;
                }
                if let Some(s) = w.stale_after {
                    b.stale_after = s.clamp(0, STALE_MAX);
                }
            }
        }
        if b.md.chars().count() > BODY_MAX {
            return Err(format!("the body is longer than {BODY_MAX} characters"));
        }
        if b.count.chars().count() > COUNT_MAX {
            return Err(format!("the count is longer than {COUNT_MAX} characters"));
        }
        Ok(Sent::Body(b))
    }
}

// --- the bodies -----------------------------------------------------------

/// Where a body came from: pushed by an agent or a script, or printed by a
/// widget file's command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Push,
    File,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Push => "push",
            Source::File => "file",
        }
    }
}

/// A widget's body as the page draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Seat {
    pub desk_id: i64,
    pub name: String,
    pub source: String,
    pub html: String,
    pub tone: String,
    pub count: String,
    pub lines: u8,
    pub stale_after: i64,
    pub writer: String,
    pub pane: String,
    pub error: String,
    pub updated_at: i64,
    pub hidden: bool,
}

/// Who wrote a body: "panel 2", "snyvi widget set", "run.sh".
pub struct Writer<'a> {
    pub source: Source,
    pub writer: &'a str,
    pub pane: &'a str,
}

const SEAT_COLS: &str =
    "b.desk_id, b.name, b.source, b.body_html, b.tone, b.count, b.lines, b.stale_after,
     b.writer, b.pane, b.error, b.updated_at, COALESCE(p.hidden, 0)";

fn seat(r: &rusqlite::Row) -> rusqlite::Result<Seat> {
    Ok(Seat {
        desk_id: r.get(0)?,
        name: r.get(1)?,
        source: r.get(2)?,
        html: r.get(3)?,
        tone: r.get(4)?,
        count: r.get(5)?,
        lines: r
            .get::<_, i64>(6)?
            .clamp(LINES_MIN as i64, LINES_MAX as i64) as u8,
        stale_after: r.get(7)?,
        writer: r.get(8)?,
        pane: r.get(9)?,
        error: r.get(10)?,
        updated_at: r.get(11)?,
        hidden: r.get::<_, i64>(12)? != 0,
    })
}

/// The widgets on desk `desk_id` (0 for the global ones), oldest first, so a
/// new one lands at the end of its slot and nothing above it moves.
pub fn seats(conn: &Connection, desk_id: i64) -> Result<Vec<Seat>> {
    let mut st = conn.prepare(&format!(
        "SELECT {SEAT_COLS} FROM widget_bodies b LEFT JOIN widget_prefs p ON p.name = b.name
         WHERE b.desk_id = ?1 ORDER BY b.rowid"
    ))?;
    let rows = st.query_map([desk_id], seat)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One widget's seat.
pub fn seat_of(conn: &Connection, desk_id: i64, name: &str) -> Result<Option<Seat>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {SEAT_COLS} FROM widget_bodies b LEFT JOIN widget_prefs p ON p.name = b.name
                 WHERE b.desk_id = ?1 AND b.name = ?2"
            ),
            params![desk_id, name],
            seat,
        )
        .optional()?)
}

/// What a write did.
#[derive(Debug, PartialEq, Eq)]
pub enum Put {
    Done,
    /// The desk, or the global slot, has all the widgets it can.
    Full,
    /// A widget file has this name, and only it fills it.
    Owned,
}

/// Keep a body for `name` on `desk_id`, drawn (`html`). A new widget past
/// the slot's cap is refused; one a widget file owns is refused to anyone
/// else. Its place in the slot is kept when it is rewritten.
pub fn put(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    b: &Body,
    html: &str,
    w: &Writer,
    now: i64,
) -> Result<Put> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT source FROM widget_bodies WHERE desk_id = ?1 AND name = ?2",
            params![desk_id, name],
            |r| r.get(0),
        )
        .optional()?;
    match owner.as_deref() {
        Some("file") if w.source != Source::File => return Ok(Put::Owned),
        Some(_) => {}
        None => {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM widget_bodies WHERE desk_id = ?1",
                [desk_id],
                |r| r.get(0),
            )?;
            let cap = if desk_id == 0 { GLOBAL_MAX } else { DESK_MAX };
            if n as usize >= cap {
                return Ok(Put::Full);
            }
        }
    }
    conn.execute(
        "INSERT INTO widget_bodies (desk_id, name, source, body_md, body_html, tone, count, lines, stale_after, writer, pane, error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', ?12)
         ON CONFLICT(desk_id, name) DO UPDATE SET source = excluded.source, body_md = excluded.body_md,
           body_html = excluded.body_html, tone = excluded.tone, count = excluded.count, lines = excluded.lines,
           stale_after = excluded.stale_after, writer = excluded.writer, pane = excluded.pane, error = '',
           updated_at = excluded.updated_at",
        params![
            desk_id,
            name,
            w.source.as_str(),
            b.md,
            html,
            b.tone.as_str(),
            b.count,
            b.lines as i64,
            b.stale_after,
            w.writer,
            w.pane,
            now
        ],
    )?;
    Ok(Put::Done)
}

/// A widget file's run went wrong: say so in its seat, over the last good
/// body, which stays. A widget that never ran well has a seat with only the
/// line in it.
pub fn fail(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    why: &str,
    writer: &str,
    now: i64,
) -> Result<()> {
    let why: String = why.chars().take(200).collect();
    conn.execute(
        "INSERT INTO widget_bodies (desk_id, name, source, body_md, body_html, writer, error, updated_at)
         VALUES (?1, ?2, 'file', '', '', ?3, ?4, ?5)
         ON CONFLICT(desk_id, name) DO UPDATE SET error = excluded.error, updated_at = excluded.updated_at
         WHERE widget_bodies.source = 'file'",
        params![desk_id, name, writer, why, now],
    )?;
    Ok(())
}

/// Clear `name` on `desk_id`, as its writer may. A widget file's seat is
/// the file's: a push does not clear it. Whether there was one to clear.
pub fn clear(conn: &Connection, desk_id: i64, name: &str, source: Source) -> Result<bool> {
    let n = conn.execute(
        "DELETE FROM widget_bodies WHERE desk_id = ?1 AND name = ?2 AND (source = ?3 OR ?3 = 'file')",
        params![desk_id, name, source.as_str()],
    )?;
    Ok(n > 0)
}

/// The desks with a seat for `name` (0 for the global one).
pub fn desks_of(conn: &Connection, name: &str) -> Result<Vec<i64>> {
    let mut st = conn.prepare("SELECT desk_id FROM widget_bodies WHERE name = ?1")?;
    let rows = st.query_map([name], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every seat a pane's agent pushed, for when the pane ends: they dim and
/// say so, and stay until cleared or replaced.
pub fn of_pane(conn: &Connection, pane: &str) -> Result<Vec<(i64, String)>> {
    let mut st = conn
        .prepare("SELECT desk_id, name FROM widget_bodies WHERE pane = ?1 AND source = 'push'")?;
    let rows = st.query_map([pane], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The pane behind a pushed seat ended: the seat says so where its writer
/// is named, and is past its time from now on.
pub fn pane_ended(conn: &Connection, pane: &str, said: &str) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE widget_bodies SET writer = ?2, stale_after = 1, pane = '' WHERE pane = ?1 AND source = 'push'",
        params![pane, said],
    )?)
}

// --- the reader's say -----------------------------------------------------

/// What the reader decided about a widget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct Prefs {
    pub name: String,
    pub hidden: bool,
    pub settings: String,
    pub trusted_hash: String,
    pub rerun_edits: bool,
    /// The desks a desk widget is on; none is every desk.
    pub desks: Vec<i64>,
    /// When it turns itself off; 0 is when the reader does.
    pub until: i64,
    /// The panel whose life it lasts; none is not one.
    pub until_pane: String,
}

impl Prefs {
    /// Whether a desk widget is on desk `id`.
    pub fn on_desk(&self, id: i64) -> bool {
        self.desks.is_empty() || self.desks.contains(&id)
    }
    /// Whether its time is up: past `until`, or its panel `live` no more.
    pub fn ended(&self, now: i64, live: impl Fn(&str) -> bool) -> bool {
        (self.until > 0 && self.until <= now)
            || (!self.until_pane.is_empty() && !live(&self.until_pane))
    }
}

fn desks_text(ids: &[i64]) -> String {
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

fn desks_read(s: &str) -> Vec<i64> {
    s.split(',').filter_map(|x| x.trim().parse().ok()).collect()
}

pub fn prefs(conn: &Connection, name: &str) -> Result<Prefs> {
    Ok(conn
        .query_row(
            "SELECT name, hidden, settings, trusted_hash, rerun_edits, desks, until, until_pane
             FROM widget_prefs WHERE name = ?1",
            [name],
            |r| {
                Ok(Prefs {
                    name: r.get(0)?,
                    hidden: r.get::<_, i64>(1)? != 0,
                    settings: r.get(2)?,
                    trusted_hash: r.get(3)?,
                    rerun_edits: r.get::<_, i64>(4)? != 0,
                    desks: desks_read(&r.get::<_, String>(5)?),
                    until: r.get(6)?,
                    until_pane: r.get(7)?,
                })
            },
        )
        .optional()?
        .unwrap_or_else(|| Prefs {
            name: name.to_string(),
            settings: "{}".into(),
            ..Prefs::default()
        }))
}

/// A change to what the reader decided: each `Some` is set, each `None`
/// left as it was.
#[derive(Default)]
pub struct Change<'a> {
    pub hidden: Option<bool>,
    pub settings: Option<&'a str>,
    pub trusted_hash: Option<&'a str>,
    pub rerun_edits: Option<bool>,
    pub desks: Option<&'a [i64]>,
    pub until: Option<i64>,
    pub until_pane: Option<&'a str>,
}

/// Change what the reader decided about `name`.
pub fn set_prefs(conn: &Connection, name: &str, ch: &Change, now: i64) -> Result<Prefs> {
    let was = prefs(conn, name)?;
    conn.execute(
        "INSERT INTO widget_prefs (name, hidden, settings, trusted_hash, rerun_edits, desks, until, until_pane, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(name) DO UPDATE SET hidden = excluded.hidden, settings = excluded.settings,
           trusted_hash = excluded.trusted_hash, rerun_edits = excluded.rerun_edits, desks = excluded.desks,
           until = excluded.until, until_pane = excluded.until_pane, updated_at = excluded.updated_at",
        params![
            name,
            ch.hidden.unwrap_or(was.hidden) as i64,
            ch.settings.unwrap_or(&was.settings),
            ch.trusted_hash.unwrap_or(&was.trusted_hash),
            ch.rerun_edits.unwrap_or(was.rerun_edits) as i64,
            desks_text(ch.desks.unwrap_or(&was.desks)),
            ch.until.unwrap_or(was.until),
            ch.until_pane.unwrap_or(&was.until_pane),
            now
        ],
    )?;
    prefs(conn, name)
}

/// A widget file's seats on desks it is no longer on: what its runs printed
/// there, which a run makes again if it comes back. The desks it left.
pub fn off_desks(conn: &Connection, name: &str, desks: &[i64]) -> Result<Vec<i64>> {
    if desks.is_empty() {
        return Ok(Vec::new());
    }
    let gone: Vec<i64> = desks_of(conn, name)?
        .into_iter()
        .filter(|d| *d != 0 && !desks.contains(d))
        .collect();
    for d in &gone {
        conn.execute(
            "DELETE FROM widget_bodies WHERE desk_id = ?1 AND name = ?2 AND source = 'file'",
            params![d, name],
        )?;
    }
    Ok(gone)
}

/// Let a stopped widget file run again: on one desk, or on all. The desks
/// whose seat it was.
pub fn unstop(conn: &Connection, name: &str, desk: Option<i64>) -> Result<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT desk_id FROM widget_bodies WHERE name = ?1 AND source = 'file'
         AND substr(error, 1, length(?2)) = ?2 AND (?3 IS NULL OR desk_id = ?3)",
    )?;
    let ds: Vec<i64> = st
        .query_map(params![name, STOPPED, desk], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for d in &ds {
        conn.execute(
            "UPDATE widget_bodies SET error = '' WHERE desk_id = ?1 AND name = ?2",
            params![d, name],
        )?;
    }
    Ok(ds)
}

// --- an agent's box, asked for ---------------------------------------------

/// The reader's answer to a panel's box on a desk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ask {
    pub desk_id: i64,
    pub name: String,
    /// `""` waiting on the card, `yes`, `no` (Not now), or `ended`.
    pub answer: String,
    pub pane: String,
    pub writer: String,
    /// What waits behind the card, as the panel last sent it.
    pub body: String,
    pub until: i64,
    pub until_pane: String,
}

pub fn ask_of(conn: &Connection, desk_id: i64, name: &str) -> Result<Option<Ask>> {
    Ok(conn
        .query_row(
            "SELECT desk_id, name, answer, pane, writer, body, until, until_pane FROM widget_asks
             WHERE desk_id = ?1 AND name = ?2",
            params![desk_id, name],
            |r| {
                Ok(Ask {
                    desk_id: r.get(0)?,
                    name: r.get(1)?,
                    answer: r.get(2)?,
                    pane: r.get(3)?,
                    writer: r.get(4)?,
                    body: r.get(5)?,
                    until: r.get(6)?,
                    until_pane: r.get(7)?,
                })
            },
        )
        .optional()?)
}

/// A panel's body waits behind its card: the newest one sent is the one
/// shown on yes.
pub fn ask_wait(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    pane: &str,
    writer: &str,
    body: &str,
    now: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO widget_asks (desk_id, name, answer, pane, writer, body, updated_at)
         VALUES (?1, ?2, '', ?3, ?4, ?5, ?6)
         ON CONFLICT(desk_id, name) DO UPDATE SET answer = '', pane = excluded.pane,
           writer = excluded.writer, body = excluded.body, updated_at = excluded.updated_at",
        params![desk_id, name, pane, writer, body, now],
    )?;
    Ok(())
}

/// The reader's answer: `yes` with how long, `no`, `ended`, or `""` again
/// (the Undo of a Not now).
pub fn ask_answer(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    answer: &str,
    until: i64,
    until_pane: &str,
    now: i64,
) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE widget_asks SET answer = ?3, until = ?4, until_pane = ?5, updated_at = ?6
         WHERE desk_id = ?1 AND name = ?2",
        params![desk_id, name, answer, until, until_pane, now],
    )? > 0)
}

/// A box that was there before boxes were asked for is taken as allowed:
/// the reader has been looking at it. Whether it was.
pub fn ask_grandfather(conn: &Connection, desk_id: i64, name: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "INSERT INTO widget_asks (desk_id, name, answer, pane, writer, updated_at)
         SELECT desk_id, name, 'yes', pane, writer, ?3 FROM widget_bodies
         WHERE desk_id = ?1 AND name = ?2 AND source = 'push'
         ON CONFLICT(desk_id, name) DO NOTHING",
        params![desk_id, name, now],
    )? > 0)
}

/// Allowed boxes whose time is up -- past `until`, or their panel not
/// `live` -- marked ended; the (desk, name) of each, to clear.
pub fn asks_ending(
    conn: &Connection,
    now: i64,
    live: impl Fn(&str) -> bool,
) -> Result<Vec<(i64, String)>> {
    let mut st = conn.prepare(
        "SELECT desk_id, name, until, until_pane FROM widget_asks
         WHERE answer = 'yes' AND (until > 0 OR until_pane != '')",
    )?;
    let due: Vec<(i64, String)> = st
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, _, until, pane)| {
            (*until > 0 && *until <= now) || (!pane.is_empty() && !live(pane))
        })
        .map(|(d, n, _, _)| (d, n))
        .collect();
    for (d, n) in &due {
        conn.execute(
            "UPDATE widget_asks SET answer = 'ended', updated_at = ?3 WHERE desk_id = ?1 AND name = ?2",
            params![d, n, now],
        )?;
    }
    Ok(due)
}
