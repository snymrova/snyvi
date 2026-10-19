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
//! desks it is on and until when -- is `widget_prefs`, by owner and name,
//! and nothing a writer sends changes it.
//!
//! **A widget file has an owner** (1.32): the desk whose folder it is in
//! (`widgets/@<desk id>/<name>/`), or none -- 0 -- for one in the widgets
//! folder itself, shared by the desks it is on or global. An agent's
//! widget is its desk's and runs nowhere else; sharing it is the reader's
//! move. A name is shared or owned, never both, so two desks may each own
//! a `status` while a shared `status` would be refused.
//!
//! **An agent asks first** (#111). A widget file it proposes is a card on Your
//! turn, and so is the first box a panel pushes onto a desk: `widget_asks`
//! keeps the reader's answer per desk and name -- waiting, yes, not now, or
//! ended -- and the body that waits behind the card. A box the reader
//! removed is `removed` there, with its last body kept for Undo.
//!
//! Nothing is deleted on the reader's account: hiding is a flag, and a body
//! cleared by its writer is the writer's to clear.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub mod files;
pub mod gallery;
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
-- A gallery's outputs (`gallery`): every one kept, its file in data/gallery.
CREATE TABLE IF NOT EXISTS gallery_items (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  job TEXT NOT NULL DEFAULT '',
  file TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  cost_micros INTEGER NOT NULL DEFAULT 0,
  poster TEXT NOT NULL DEFAULT '',
  failed TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  pane TEXT NOT NULL DEFAULT '',
  writer TEXT NOT NULL DEFAULT '',
  made_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gallery_items_box ON gallery_items(desk_id, name, id);
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

/// 1.31: a widget file's own title for its seat's head, which the name only
/// stands in for (#112). Version 17 of `store::MIGRATIONS`, never in
/// `SCHEMA`.
pub const TITLE_COLUMN_1_31: &str =
    "ALTER TABLE widget_bodies ADD COLUMN title TEXT NOT NULL DEFAULT ''";

/// 1.32: a widget file's owner, the desk it belongs to (0: shared, or
/// global). `widget_prefs` is keyed by owner and name, which SQLite cannot
/// change in place, so it is built again. A widget on exactly one desk is
/// marked to be that desk's -- its owner the desk's id, negative -- and
/// `adopt` moves its folder at the next start, once. A seat says whose it
/// is. Version 18 of `store::MIGRATIONS`, never in `SCHEMA`.
pub const OWNER_1_32: [&str; 5] = [
    "CREATE TABLE widget_prefs_1_32 (
       owner INTEGER NOT NULL DEFAULT 0,
       name TEXT NOT NULL,
       hidden INTEGER NOT NULL DEFAULT 0,
       settings TEXT NOT NULL DEFAULT '{}',
       trusted_hash TEXT NOT NULL DEFAULT '',
       rerun_edits INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL,
       desks TEXT NOT NULL DEFAULT '',
       until INTEGER NOT NULL DEFAULT 0,
       until_pane TEXT NOT NULL DEFAULT '',
       PRIMARY KEY (owner, name)
     )",
    "INSERT INTO widget_prefs_1_32 (owner, name, hidden, settings, trusted_hash, rerun_edits, updated_at, desks, until, until_pane)
     SELECT CASE WHEN desks GLOB '[0-9]*' AND desks NOT GLOB '*[^0-9]*' THEN -CAST(desks AS INTEGER) ELSE 0 END,
            name, hidden, settings, trusted_hash, rerun_edits, updated_at, desks, until, until_pane
     FROM widget_prefs",
    "DROP TABLE widget_prefs",
    "ALTER TABLE widget_prefs_1_32 RENAME TO widget_prefs",
    "ALTER TABLE widget_bodies ADD COLUMN owner INTEGER NOT NULL DEFAULT 0",
];

/// The most a seat's line keeps of why a run failed. A longer one ends in
/// "…", so it is never read as whole when it is not.
pub const ERROR_MAX: usize = 600;
pub const FAILS_TO_STOP: u8 = 3;

// --- the layout -----------------------------------------------------------

/// The left's sections, in the order a new reader has them: today's.
/// `widgets` is the slot every global widget sits in, together.
pub const LEFT: [&str; 4] = ["inbox", "desks", "folders", "widgets"];
/// The right's, on a desk. `widgets` is the slot the desk's widgets sit in.
/// Your turn was `turn`, fixed first, until 1.32: it waits in the desk's
/// corner now, so a stored layout that names it loses it here (`order`
/// drops an id it does not know).
pub const RIGHT: [&str; 5] = ["panels", "points", "docs", "notes", "widgets"];

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
        let right = order(&self.right, &RIGHT);
        let can_hide = |h: &str| -> bool {
            match h.split_once(':') {
                Some(("left", "widgets")) | Some(("right", "widgets")) => true,
                Some(_) => false,
                None => h != "widgets" && (LEFT.contains(&h) || RIGHT.contains(&h)),
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
            // An object that is not a widget's says so, rather than clear
            // the box or show its braces: `{"status":"ok"}`, `{"body":5}`.
            if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(t) {
                const KNOWN: [&str; 5] = ["body", "tone", "count", "lines", "stale_after"];
                if let Some(k) = o
                    .keys()
                    .find(|k| !KNOWN.contains(&k.as_str()))
                    .filter(|_| !o.contains_key("body"))
                {
                    return Err(format!("JSON with \"{k}\" and no \"body\": a widget prints {{\"body\": …}}, or Markdown"));
                }
                if o.get("body")
                    .is_some_and(|b| !b.is_string() && !b.is_null())
                {
                    return Err("\"body\" is Markdown text".into());
                }
            }
            let wire = serde_json::from_str::<Wire>(t);
            // An object with a body whose other fields are the wrong shape
            // is refused by name, not drawn as its braces.
            if wire.is_err()
                && serde_json::from_str::<serde_json::Value>(t)
                    .ok()
                    .and_then(|v| v.get("body").map(serde_json::Value::is_string))
                    .unwrap_or(false)
            {
                return Err("lines and stale_after are whole numbers of lines and seconds, tone is a word, count a number or a short text".into());
            }
            if let Ok(w) = wire {
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
    /// A widget file's title; empty for a push, whose head is its name.
    pub title: String,
    /// The desk a widget file belongs to; 0 for a shared or global one, and
    /// for a push.
    pub owner: i64,
    /// An agent's: a desk's own widget file, or a box a panel pushed (its
    /// panel may have closed since). Only these have Remove.
    pub agent: bool,
}

/// Who wrote a body: "panel 2", "a script", or for a widget file how often
/// it runs ("every 2 min"), with the title its head says and the desk it
/// belongs to (0: none).
pub struct Writer<'a> {
    pub source: Source,
    pub writer: &'a str,
    pub pane: &'a str,
    pub title: &'a str,
    pub owner: i64,
}

/// A seat's columns, its prefs' `hidden` by the widget's owner: a desk's own
/// widget and a shared one never have the same name on a desk.
const SEAT_COLS: &str =
    "b.desk_id, b.name, b.source, b.body_html, b.tone, b.count, b.lines, b.stale_after,
     b.writer, b.pane, b.error, b.updated_at,
     COALESCE((SELECT p.hidden FROM widget_prefs p WHERE p.name = b.name AND p.owner = b.owner AND b.source = 'file'),
       (SELECT p.hidden FROM widget_prefs p WHERE p.name = b.name AND p.owner = b.desk_id AND b.source = 'push' AND b.desk_id != 0),
       (SELECT p.hidden FROM widget_prefs p WHERE p.name = b.name AND p.owner = 0 AND b.source = 'push'), 0),
     b.title, b.owner,
     CASE WHEN b.source = 'file' THEN b.owner != 0 ELSE b.pane != '' OR EXISTS
       (SELECT 1 FROM widget_asks a WHERE a.desk_id = b.desk_id AND a.name = b.name) END";

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
        title: r.get(13)?,
        owner: r.get(14)?,
        agent: r.get::<_, i64>(15)? != 0,
    })
}

/// The widgets on desk `desk_id` (0 for the global ones), oldest first, so a
/// new one lands at the end of its slot and nothing above it moves.
pub fn seats(conn: &Connection, desk_id: i64) -> Result<Vec<Seat>> {
    let mut st = conn.prepare(&format!(
        "SELECT {SEAT_COLS} FROM widget_bodies b WHERE b.desk_id = ?1 ORDER BY b.rowid"
    ))?;
    let rows = st.query_map([desk_id], seat)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One widget's seat.
pub fn seat_of(conn: &Connection, desk_id: i64, name: &str) -> Result<Option<Seat>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {SEAT_COLS} FROM widget_bodies b WHERE b.desk_id = ?1 AND b.name = ?2"
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
    /// A box a panel or a script pushed has this name: a widget file does
    /// not take its seat over it.
    Box,
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
        Some("push") if w.source == Source::File => return Ok(Put::Box),
        Some(_) => {}
        None if slot_full(conn, desk_id)? => return Ok(Put::Full),
        None => {}
    }
    conn.execute(
        "INSERT INTO widget_bodies (desk_id, name, source, body_md, body_html, tone, count, lines, stale_after, writer, pane, error, updated_at, title, owner)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', ?12, ?13, ?14)
         ON CONFLICT(desk_id, name) DO UPDATE SET source = excluded.source, body_md = excluded.body_md,
           body_html = excluded.body_html, tone = excluded.tone, count = excluded.count, lines = excluded.lines,
           stale_after = excluded.stale_after, writer = excluded.writer, pane = excluded.pane, error = '',
           updated_at = excluded.updated_at, title = excluded.title, owner = excluded.owner",
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
            now,
            w.title,
            w.owner
        ],
    )?;
    Ok(Put::Done)
}

/// Whether the slot -- a desk, or the left -- has every seat taken.
pub fn slot_full(conn: &Connection, desk_id: i64) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM widget_bodies WHERE desk_id = ?1",
        [desk_id],
        |r| r.get(0),
    )?;
    let cap = if desk_id == 0 { GLOBAL_MAX } else { DESK_MAX };
    Ok(n as usize >= cap)
}

/// A widget file's run went wrong: say so in its seat, over the last good
/// body, which stays. A widget that never ran well has a seat with only the
/// line in it, at the file's own `lines`, so its first body fills the room
/// the line held and moves nothing below. The seat counts against the
/// slot's cap as a body does: whether there was one for the line.
pub fn fail(
    conn: &Connection,
    desk_id: i64,
    name: &str,
    why: &str,
    lines: u8,
    w: &Writer,
    now: i64,
) -> Result<bool> {
    let why = cut(why, ERROR_MAX);
    let n = conn.execute(
        "UPDATE widget_bodies SET error = ?3, updated_at = ?4, writer = ?5, title = ?6, owner = ?7
         WHERE desk_id = ?1 AND name = ?2 AND source = 'file'",
        params![desk_id, name, why, now, w.writer, w.title, w.owner],
    )?;
    if n > 0 {
        return Ok(true);
    }
    if seat_of(conn, desk_id, name)?.is_some() || slot_full(conn, desk_id)? {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO widget_bodies (desk_id, name, source, body_md, body_html, lines, stale_after, writer, error, updated_at, title, owner)
         VALUES (?1, ?2, 'file', '', '', ?3, 0, ?4, ?5, ?6, ?7, ?8)",
        params![desk_id, name, lines as i64, w.writer, why, now, w.title, w.owner],
    )?;
    Ok(true)
}

/// Where a name stands on a desk, for whoever would take it: a widget file's
/// seat, a pushed box's, or a box asked for (its answer), or free.
#[derive(Debug, PartialEq, Eq)]
pub enum Held {
    File,
    Box,
    Asked(String),
}

pub fn name_held(conn: &Connection, desk_id: i64, name: &str) -> Result<Option<Held>> {
    let source: Option<String> = conn
        .query_row(
            "SELECT source FROM widget_bodies WHERE desk_id = ?1 AND name = ?2",
            params![desk_id, name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match source.as_deref() {
        Some("file") => Some(Held::File),
        Some(_) => Some(Held::Box),
        None => ask_of(conn, desk_id, name)?.map(|a| Held::Asked(a.answer)),
    })
}

/// The seats of widget files whose folder is gone -- removed, moved by
/// hand, or an agent's `rm` -- so a seat never outlives what fills it:
/// every file seat but the ones in `keep` (owner, name). The (desk, name)
/// of each seat cleared, to say.
pub fn clear_files_except(conn: &Connection, keep: &[(i64, String)]) -> Result<Vec<(i64, String)>> {
    let mut st =
        conn.prepare("SELECT desk_id, name, owner FROM widget_bodies WHERE source = 'file'")?;
    let gone: Vec<(i64, String)> = st
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, n, o)| !keep.iter().any(|(ko, kn)| ko == o && kn == n))
        .map(|(d, n, _)| (d, n))
        .collect();
    for (d, n) in &gone {
        clear(conn, *d, n, Source::File)?;
    }
    Ok(gone)
}

/// Whether desk `desk_id` has a seat free for a widget an agent brings: the
/// reader's own widget files take seats as they please, an agent's take
/// one only while there is one.
pub fn desk_has_room(conn: &Connection, desk_id: i64) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM widget_bodies WHERE desk_id = ?1",
        [desk_id],
        |r| r.get(0),
    )?;
    Ok((n as usize) < DESK_MAX)
}

/// `s` kept to `max` characters, ending in "…" when it was longer.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max - 1).collect();
    t.push('…');
    t
}

/// How often a widget file runs, as its seat's by-line says it: "every
/// 30 s", "every 2 min", "every hour", "every 3 h".
pub fn every_words(secs: u64) -> String {
    match secs {
        0..=59 => format!("every {secs} s"),
        60..=3599 if secs.is_multiple_of(60) => format!("every {} min", secs / 60),
        60..=3599 => format!("every {} min {} s", secs / 60, secs % 60),
        3600 => "every hour".into(),
        _ if secs.is_multiple_of(3600) => format!("every {} h", secs / 3600),
        _ => format!("every {} min", secs / 60),
    }
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

/// The desks with a seat for `name` (0 for the global one): the widget
/// `owner` has, and for a shared name the boxes pushed under it too.
pub fn desks_of(conn: &Connection, owner: i64, name: &str) -> Result<Vec<i64>> {
    let mut st =
        conn.prepare("SELECT desk_id FROM widget_bodies WHERE name = ?1 AND owner = ?2")?;
    let rows = st.query_map(params![name, owner], |r| r.get(0))?;
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
    /// The desk the widget belongs to; 0 for a shared or global one.
    pub owner: i64,
    pub name: String,
    pub hidden: bool,
    pub settings: String,
    pub trusted_hash: String,
    pub rerun_edits: bool,
    /// The desks a shared desk widget is on; none is every desk. A desk's
    /// own widget is on its desk alone, whatever this says.
    pub desks: Vec<i64>,
    /// When it turns itself off; 0 is when the reader does.
    pub until: i64,
    /// The panel whose life it lasts; none is not one.
    pub until_pane: String,
    /// The pane that proposed it, when an agent did (1.46): `read_widgets`
    /// says "yours" by it, so two agents on a desk know whose it is.
    pub proposed_by: String,
}

/// 1.46: which pane proposed a widget file, for `read_widgets`. Version 26
/// of `store::MIGRATIONS`.
pub const PROPOSED_BY_1_46: &str =
    "ALTER TABLE widget_prefs ADD COLUMN proposed_by TEXT NOT NULL DEFAULT ''";

impl Prefs {
    /// Whether a desk widget is on desk `id`.
    pub fn on_desk(&self, id: i64) -> bool {
        if self.owner != 0 {
            return id == self.owner;
        }
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

const PREFS_COLS: &str =
    "owner, name, hidden, settings, trusted_hash, rerun_edits, desks, until, until_pane, proposed_by";

fn prefs_row(r: &rusqlite::Row) -> rusqlite::Result<Prefs> {
    Ok(Prefs {
        owner: r.get(0)?,
        name: r.get(1)?,
        hidden: r.get::<_, i64>(2)? != 0,
        settings: r.get(3)?,
        trusted_hash: r.get(4)?,
        rerun_edits: r.get::<_, i64>(5)? != 0,
        desks: desks_read(&r.get::<_, String>(6)?),
        until: r.get(7)?,
        until_pane: r.get(8)?,
        proposed_by: r.get(9)?,
    })
}

/// What the reader decided about `owner`'s widget `name` (0: a shared or
/// global one), or the defaults when nothing yet.
pub fn prefs(conn: &Connection, owner: i64, name: &str) -> Result<Prefs> {
    Ok(conn
        .query_row(
            &format!("SELECT {PREFS_COLS} FROM widget_prefs WHERE owner = ?1 AND name = ?2"),
            params![owner, name],
            prefs_row,
        )
        .optional()?
        .unwrap_or_else(|| Prefs {
            owner,
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
    pub proposed_by: Option<&'a str>,
}

/// Change what the reader decided about `owner`'s widget `name`.
pub fn set_prefs(
    conn: &Connection,
    owner: i64,
    name: &str,
    ch: &Change,
    now: i64,
) -> Result<Prefs> {
    let was = prefs(conn, owner, name)?;
    conn.execute(
        "INSERT INTO widget_prefs (owner, name, hidden, settings, trusted_hash, rerun_edits, desks, until, until_pane, updated_at, proposed_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(owner, name) DO UPDATE SET hidden = excluded.hidden, settings = excluded.settings,
           trusted_hash = excluded.trusted_hash, rerun_edits = excluded.rerun_edits, desks = excluded.desks,
           until = excluded.until, until_pane = excluded.until_pane, updated_at = excluded.updated_at,
           proposed_by = excluded.proposed_by",
        params![
            owner,
            name,
            ch.hidden.unwrap_or(was.hidden) as i64,
            ch.settings.unwrap_or(&was.settings),
            ch.trusted_hash.unwrap_or(&was.trusted_hash),
            ch.rerun_edits.unwrap_or(was.rerun_edits) as i64,
            desks_text(ch.desks.unwrap_or(&was.desks)),
            ch.until.unwrap_or(was.until),
            ch.until_pane.unwrap_or(&was.until_pane),
            now,
            ch.proposed_by.unwrap_or(&was.proposed_by)
        ],
    )?;
    prefs(conn, owner, name)
}

/// A widget changing hands: what the reader decided about it, and its
/// seats, go from `from` to `to` (0: shared). Shared, it stays on the desk
/// it was that desk's, and only there until the reader ticks more; a desk's
/// own, its seats elsewhere go. The desks whose seats changed.
pub fn rehome(conn: &Connection, name: &str, from: i64, to: i64, now: i64) -> Result<Vec<i64>> {
    let was = prefs(conn, from, name)?;
    let desks: Vec<i64> = if to == 0 { vec![from] } else { Vec::new() };
    conn.execute(
        "DELETE FROM widget_prefs WHERE owner = ?1 AND name = ?2",
        params![from, name],
    )?;
    let ch = Change {
        hidden: Some(was.hidden),
        settings: Some(&was.settings),
        trusted_hash: Some(&was.trusted_hash),
        rerun_edits: Some(was.rerun_edits),
        desks: Some(&desks),
        until: Some(was.until),
        until_pane: Some(&was.until_pane),
        proposed_by: Some(&was.proposed_by),
    };
    set_prefs(conn, to, name, &ch, now)?;
    let mut touched = desks_of(conn, from, name)?;
    if to != 0 {
        conn.execute(
            "DELETE FROM widget_bodies WHERE name = ?1 AND owner = ?2 AND source = 'file' AND desk_id != ?3",
            params![name, from, to],
        )?;
    }
    conn.execute(
        "UPDATE widget_bodies SET owner = ?3 WHERE name = ?1 AND owner = ?2 AND source = 'file'",
        params![name, from, to],
    )?;
    touched.sort_unstable();
    touched.dedup();
    Ok(touched)
}

/// The widgets marked in 1.32 to become a desk's own (`OWNER_1_32`): each
/// one's name and desk, its owner still negative until `adopted` or
/// `stays_shared` settles it.
pub fn to_adopt(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut st = conn.prepare("SELECT name, -owner FROM widget_prefs WHERE owner < 0")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A marked widget whose folder moved into its desk's: the desk's own now,
/// and its seat says so.
pub fn adopted(conn: &Connection, name: &str, desk: i64) -> Result<()> {
    conn.execute(
        "UPDATE widget_prefs SET owner = ?2, desks = '' WHERE owner = -?2 AND name = ?1",
        params![name, desk],
    )?;
    conn.execute(
        "UPDATE widget_bodies SET owner = ?2 WHERE name = ?1 AND desk_id = ?2 AND source = 'file'",
        params![name, desk],
    )?;
    Ok(())
}

/// A marked widget that could not move: shared, as it was, on its one desk.
pub fn stays_shared(conn: &Connection, name: &str, desk: i64) -> Result<()> {
    conn.execute(
        "UPDATE widget_prefs SET owner = 0 WHERE owner = -?2 AND name = ?1",
        params![name, desk],
    )?;
    Ok(())
}

/// A shared widget file's seats on desks it is no longer on: what its runs
/// printed there, which a run makes again if it comes back. The desks it
/// left.
pub fn off_desks(conn: &Connection, name: &str, desks: &[i64]) -> Result<Vec<i64>> {
    if desks.is_empty() {
        return Ok(Vec::new());
    }
    let gone: Vec<i64> = desks_of(conn, 0, name)?
        .into_iter()
        .filter(|d| *d != 0 && !desks.contains(d))
        .collect();
    for d in &gone {
        conn.execute(
            "DELETE FROM widget_bodies WHERE desk_id = ?1 AND name = ?2 AND source = 'file' AND owner = 0",
            params![d, name],
        )?;
    }
    Ok(gone)
}

/// Let `owner`'s stopped widget file run again: on one desk, or on all.
/// The desks whose seat it was.
pub fn unstop(conn: &Connection, owner: i64, name: &str, desk: Option<i64>) -> Result<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT desk_id FROM widget_bodies WHERE name = ?1 AND source = 'file' AND owner = ?4
         AND substr(error, 1, length(?2)) = ?2 AND (?3 IS NULL OR desk_id = ?3)",
    )?;
    let ds: Vec<i64> = st
        .query_map(params![name, STOPPED, desk, owner], |r| r.get(0))?
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

const ASK_COLS: &str = "desk_id, name, answer, pane, writer, body, until, until_pane";

fn ask_row(r: &rusqlite::Row) -> rusqlite::Result<Ask> {
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
}

pub fn ask_of(conn: &Connection, desk_id: i64, name: &str) -> Result<Option<Ask>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ASK_COLS} FROM widget_asks WHERE desk_id = ?1 AND name = ?2"),
            params![desk_id, name],
            ask_row,
        )
        .optional()?)
}

/// Every box asked for on desk `desk_id`, whatever the reader answered, for
/// the agents in its panels to read (`read_widgets`).
pub fn asks(conn: &Connection, desk_id: i64) -> Result<Vec<Ask>> {
    let mut st = conn.prepare(&format!(
        "SELECT {ASK_COLS} FROM widget_asks WHERE desk_id = ?1 ORDER BY name"
    ))?;
    let rows = st.query_map([desk_id], ask_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The widget files proposed on desk `desk_id` whose newest card the
/// reader answered Not now, for the agents in its panels to leave alone
/// (`read_widgets`). The cards are the thread's (`desk_suggestions`); a
/// name proposed again and added since is not among them.
pub fn proposals_declined(conn: &Connection, desk_id: i64) -> Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT s.name FROM desk_suggestions s
         WHERE s.desk_id = ?1 AND s.kind = 'widget' AND s.outcome = 'dismissed'
           AND s.id = (SELECT MAX(t.id) FROM desk_suggestions t
                       WHERE t.desk_id = s.desk_id AND t.kind = 'widget' AND t.name = s.name
                         AND t.outcome IN ('dismissed', 'opened'))
         ORDER BY s.name",
    )?;
    let rows = st.query_map([desk_id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The reader undid a widget file's Remove: the word queued for the agent
/// that proposed it ("Leave it removed", `thread::tell_widget`) is taken
/// back while it has not been heard, so the agent is not told of a Remove
/// that did not stand. The cards are the thread's (`desk_suggestions`).
pub fn untell_removed(conn: &Connection, owner: i64, name: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_suggestions SET note = '', told_at = ?3
         WHERE kind = 'widget' AND name = ?1 AND outcome = 'opened' AND told_at = 0
           AND (?2 = 0 OR desk_id = ?2) AND note LIKE 'The user removed your widget %'",
        params![name, owner, now],
    )? > 0)
}

/// Every box the reader said Not now to, or removed, on any desk, for
/// /sidebars to list with Ask again: a no is the reader's to take back.
pub fn asks_refused(conn: &Connection) -> Result<Vec<Ask>> {
    let mut st = conn.prepare(&format!(
        "SELECT {ASK_COLS} FROM widget_asks WHERE answer IN ('no', 'removed') ORDER BY desk_id, name"
    ))?;
    let rows = st.query_map([], ask_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The reader took back a Not now, or a Remove, of box `name` on desk
/// `desk_id`: the next push of it asks again with a card, from any panel.
/// What it last showed stays on its ask. Whether there was a no to take.
pub fn ask_again(conn: &Connection, desk_id: i64, name: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE widget_asks SET answer = 'again', updated_at = ?3
         WHERE desk_id = ?1 AND name = ?2 AND answer IN ('no', 'removed')",
        params![desk_id, name, now],
    )? > 0)
}

/// The Markdown each widget on desk `desk_id` shows, as it was sent or
/// printed, by name: an agent reads what it wrote, not the page's HTML.
pub fn bodies_md(conn: &Connection, desk_id: i64) -> Result<Vec<(String, String)>> {
    let mut st =
        conn.prepare("SELECT name, body_md FROM widget_bodies WHERE desk_id = ?1 ORDER BY rowid")?;
    let rows = st.query_map([desk_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A panel's body waits behind its card: the newest one sent is the one
/// shown on yes. A box the reader removed stays removed -- the no holds for
/// the CLI and the panel that pushed it until the reader takes it back or
/// allows the new card -- with the body that waits behind that card.
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
         ON CONFLICT(desk_id, name) DO UPDATE SET
           answer = CASE WHEN widget_asks.answer = 'removed' THEN 'removed' ELSE '' END,
           pane = CASE WHEN widget_asks.answer = 'removed' THEN widget_asks.pane ELSE excluded.pane END,
           writer = CASE WHEN widget_asks.answer = 'removed' THEN widget_asks.writer ELSE excluded.writer END,
           body = excluded.body, updated_at = excluded.updated_at",
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

/// The reader removed an agent's box: its seat goes, and what it last
/// showed is kept on its ask, as the body a panel sends (`Body::parse`), for
/// Undo. Its panel is kept too: that panel's pushes are refused after this,
/// and a new panel's ask again. Whether there was an agent's box to remove.
pub fn remove_box(conn: &Connection, desk_id: i64, name: &str, now: i64) -> Result<bool> {
    let seat = conn
        .query_row(
            "SELECT body_md, tone, count, lines, stale_after, pane, writer FROM widget_bodies
             WHERE desk_id = ?1 AND name = ?2 AND source = 'push'",
            params![desk_id, name],
            |r| {
                Ok((
                    serde_json::json!({
                        "body": r.get::<_, String>(0)?, "tone": r.get::<_, String>(1)?,
                        "count": r.get::<_, String>(2)?, "lines": r.get::<_, i64>(3)?,
                        "stale_after": r.get::<_, i64>(4)?,
                    })
                    .to_string(),
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    let Some((raw, pane, writer)) = seat else {
        return Ok(false);
    };
    if pane.is_empty() && ask_of(conn, desk_id, name)?.is_none() {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO widget_asks (desk_id, name, answer, pane, writer, body, updated_at)
         VALUES (?1, ?2, 'removed', ?3, ?4, ?5, ?6)
         ON CONFLICT(desk_id, name) DO UPDATE SET answer = 'removed', body = excluded.body,
           pane = CASE WHEN excluded.pane != '' THEN excluded.pane ELSE widget_asks.pane END,
           writer = excluded.writer, updated_at = excluded.updated_at",
        params![desk_id, name, pane, writer, raw, now],
    )?;
    clear(conn, desk_id, name, Source::Push)
}

/// Undo a removed box: allowed again, for as long as it was, and the ask
/// -- with the body it last showed, to put back -- or None when it is not
/// one removed.
pub fn restore_box(conn: &Connection, desk_id: i64, name: &str, now: i64) -> Result<Option<Ask>> {
    match ask_of(conn, desk_id, name)? {
        Some(a) if a.answer == "removed" => {
            ask_answer(conn, desk_id, name, "yes", a.until, &a.until_pane, now)?;
            Ok(Some(a))
        }
        _ => Ok(None),
    }
}
