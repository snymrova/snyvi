//! Lately: everything that came to the reader from outside, kept (plan
//! b0bca0a11f).
//!
//! A message used to reach the reader in eight places, and three of them
//! forgot it: a news toast lasted a few seconds, the card for a document from
//! another desk went at the first click elsewhere, and asides lived in the
//! daemon's memory, five at most, until the next restart. "What did that toast
//! say?" had no answer anywhere. So every one of them is a row here, written
//! beside the event that already says it, and the corner's tray lists them
//! (`ui/corner.js`) the way the Inbox lists documents.
//!
//! - **Kinds.** `doc` and `version` (a document arrived, or a newer one),
//!   `aside` (an agent's line, `crate::aside`), `line`, `reply` and `tick`
//!   (a friend's), `answered` (a turn the reader answered), `offered` (an
//!   agent's offer to a friend, once answered), `told` (a shipped thread
//!   the world heard of, with where, `crate::told`).
//! - **Seen** is one watermark for the whole daemon: the dot means a row is
//!   newer than it. Opening the tray in any page moves it.
//! - **Kept.** An aside stays until the reader removes it, like a document.
//!   The rest is news, and after `NEWS_DAYS` it is pruned. A ✕ only sets
//!   `removed_at`, and the Removed list can bring it back.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS lately (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  desk_id INTEGER NOT NULL DEFAULT 0,
  desk_name TEXT NOT NULL DEFAULT '',
  slot INTEGER NOT NULL DEFAULT 0,
  doc_id TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  lit INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lately_at ON lately(at);
CREATE TABLE IF NOT EXISTS lately_seen (
  k INTEGER PRIMARY KEY CHECK (k = 1),
  upto INTEGER NOT NULL
);
"#;

/// How long news is kept. Asides are kept until removed.
pub const NEWS_DAYS: i64 = 14;
/// Rows to a page of the tray; older ones come with `before`.
pub const PAGE: usize = 50;
pub const KINDS: [&str; 9] = [
    "doc", "version", "aside", "line", "reply", "tick", "answered", "offered", "told",
];

/// A row as the page reads it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Row {
    pub id: i64,
    pub kind: String,
    pub at: i64,
    pub text: String,
    /// Who said it: an agent's name, a friend's, a hook.
    pub who: String,
    /// The desk and panel it came from, copied at arrival like a document's.
    pub from: Option<crate::desk::Origin>,
    /// The document it is about, or empty.
    pub doc: String,
    /// The kind's own: a project, a friend's id, the answer given.
    pub data: Value,
    /// Whether it arrived glowing; an aside too soon after the last does not.
    pub lit: bool,
    pub seen: bool,
    pub removed: bool,
    /// When it was removed, for the Removed list's order.
    #[serde(skip)]
    pub removed_at: i64,
}

/// What a writer logs.
#[derive(Clone, Debug, Default)]
pub struct New {
    pub kind: &'static str,
    pub text: String,
    pub who: String,
    pub from: Option<crate::desk::Origin>,
    pub doc: String,
    pub data: Value,
    pub lit: bool,
}

const COLS: &str =
    "id, kind, at, text, who, desk_id, desk_name, slot, doc_id, data, lit, removed_at";

fn row(r: &rusqlite::Row, upto: i64) -> rusqlite::Result<Row> {
    let id: i64 = r.get(0)?;
    let desk_id: i64 = r.get(5)?;
    let data: String = r.get(9)?;
    let removed_at: i64 = r.get(11)?;
    Ok(Row {
        id,
        kind: r.get(1)?,
        at: r.get(2)?,
        text: r.get(3)?,
        who: r.get(4)?,
        from: (desk_id > 0).then(|| crate::desk::Origin {
            id: desk_id,
            name: r.get(6).unwrap_or_default(),
            slot: r.get(7).unwrap_or_default(),
        }),
        doc: r.get(8)?,
        data: serde_json::from_str(&data).unwrap_or(Value::Null),
        lit: r.get::<_, i64>(10)? != 0,
        seen: id <= upto,
        removed: removed_at > 0,
        removed_at,
    })
}

/// The watermark: every row at or under it has been seen.
pub fn seen_upto(conn: &Connection) -> Result<i64> {
    Ok(conn
        .query_row("SELECT upto FROM lately_seen WHERE k = 1", [], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// The oldest news still kept.
fn news_since(now: i64) -> i64 {
    now - NEWS_DAYS * 86_400
}

/// Log one, and let news older than `NEWS_DAYS` go: the one delete here,
/// of a line that said a document came, never of the document.
pub fn add(conn: &Connection, n: &New, now: i64) -> Result<Row> {
    debug_assert!(KINDS.contains(&n.kind));
    conn.execute(
        "DELETE FROM lately WHERE kind != 'aside' AND at < ?1",
        params![news_since(now)],
    )?;
    let (desk_id, desk_name, slot) = n
        .from
        .as_ref()
        .map(|o| (o.id, o.name.as_str(), o.slot))
        .unwrap_or((0, "", 0));
    let data = if n.data.is_null() {
        "{}".to_string()
    } else {
        n.data.to_string()
    };
    conn.execute(
        "INSERT INTO lately (kind, at, text, who, desk_id, desk_name, slot, doc_id, data, lit)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            n.kind,
            now,
            n.text,
            n.who,
            desk_id,
            desk_name,
            slot,
            n.doc,
            data,
            n.lit as i64
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get(conn, id)?.expect("the row just written"))
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Row>> {
    let upto = seen_upto(conn)?;
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM lately WHERE id = ?1"),
            params![id],
            |r| row(r, upto),
        )
        .optional()?)
}

/// Newest first, `PAGE` at a time: under `before` when it is set. Removed
/// rows are not listed; news past its days is not either, pruned or not.
pub fn list(conn: &Connection, before: i64, now: i64) -> Result<Vec<Row>> {
    let upto = seen_upto(conn)?;
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM lately
         WHERE removed_at = 0 AND (?1 = 0 OR id < ?1) AND (kind = 'aside' OR at >= ?2)
         ORDER BY id DESC LIMIT ?3"
    ))?;
    let v = st
        .query_map(params![before, news_since(now), PAGE as i64], |r| {
            row(r, upto)
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// Of one kind, newest first, removed ones included: the asides' own list.
pub fn of_kind(conn: &Connection, kind: &str, limit: usize) -> Result<Vec<Row>> {
    let upto = seen_upto(conn)?;
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM lately WHERE kind = ?1 ORDER BY id DESC LIMIT ?2"
    ))?;
    let v = st
        .query_map(params![kind, limit as i64], |r| row(r, upto))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// Whether anything listed is newer than the watermark: the pill's dot.
/// What the reader did themselves -- a turn answered, an offer settled -- is
/// listed, and lights nothing.
pub fn unseen(conn: &Connection, now: i64) -> Result<bool> {
    let upto = seen_upto(conn)?;
    Ok(conn
        .query_row(
            "SELECT 1 FROM lately WHERE id > ?1 AND removed_at = 0 AND kind NOT IN ('answered', 'offered')
             AND (kind = 'aside' OR at >= ?2) LIMIT 1",
            params![upto, news_since(now)],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The reader looked: everything there now is seen. True when that moved
/// the watermark.
pub fn see(conn: &Connection) -> Result<bool> {
    let top: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) FROM lately", [], |r| r.get(0))?;
    if top <= seen_upto(conn)? {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO lately_seen (k, upto) VALUES (1, ?1) ON CONFLICT(k) DO UPDATE SET upto = ?1",
        params![top],
    )?;
    Ok(true)
}

/// Out of the list, kept for the Removed list and its restore. True when
/// that changed anything. `kind` narrows it: the asides' routes touch only
/// asides.
pub fn remove(conn: &Connection, ids: &[i64], kind: Option<&str>, now: i64) -> Result<bool> {
    set_removed(conn, ids, kind, now)
}

pub fn restore(conn: &Connection, ids: &[i64], kind: Option<&str>) -> Result<bool> {
    set_removed(conn, ids, kind, 0)
}

fn set_removed(conn: &Connection, ids: &[i64], kind: Option<&str>, to: i64) -> Result<bool> {
    let mut changed = 0;
    for id in ids {
        changed += conn.execute(
            "UPDATE lately SET removed_at = ?1
             WHERE id = ?2 AND (?3 IS NULL OR kind = ?3) AND (removed_at = 0) != (?1 = 0)",
            params![to, id, kind],
        )?;
    }
    Ok(changed > 0)
}

/// What was removed and can come back, newest first: the page's Removed.
pub fn removed(conn: &Connection, limit: usize) -> Result<Vec<Row>> {
    let upto = seen_upto(conn)?;
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM lately WHERE removed_at > 0 ORDER BY removed_at DESC LIMIT ?1"
    ))?;
    let v = st
        .query_map(params![limit as i64], |r| row(r, upto))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}

/// When the last aside that lit up arrived: the next one within the quiet
/// joins the list without lighting up (`crate::aside`).
pub fn last_lit_aside(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn.query_row(
        "SELECT MAX(at) FROM lately WHERE kind = 'aside' AND lit = 1",
        [],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    fn new(kind: &'static str, text: &str) -> New {
        New {
            kind,
            text: text.into(),
            lit: true,
            ..Default::default()
        }
    }

    #[test]
    fn lists_newest_first_and_pages() {
        let c = db();
        for i in 0..(PAGE + 3) {
            add(&c, &new("doc", &format!("d{i}")), 1000 + i as i64).unwrap();
        }
        let now = 2000;
        let first = list(&c, 0, now).unwrap();
        assert_eq!(first.len(), PAGE);
        assert_eq!(first[0].text, format!("d{}", PAGE + 2));
        let rest = list(&c, first.last().unwrap().id, now).unwrap();
        assert_eq!(rest.len(), 3);
        assert_eq!(rest.last().unwrap().text, "d0");
    }

    #[test]
    fn keeps_where_it_came_from() {
        let c = db();
        let from = crate::desk::Origin {
            id: 3,
            name: "ledger".into(),
            slot: 2,
        };
        let r = add(
            &c,
            &New {
                from: Some(from.clone()),
                doc: "abc".into(),
                data: serde_json::json!({ "project": "ledger" }),
                ..new("doc", "Plan")
            },
            10,
        )
        .unwrap();
        assert_eq!(r.from, Some(from));
        assert_eq!(r.doc, "abc");
        assert_eq!(r.data["project"], "ledger");
        let none = add(&c, &new("tick", "t"), 11).unwrap();
        assert!(none.from.is_none());
        assert_eq!(none.data, serde_json::json!({}));
    }

    #[test]
    fn seeing_moves_one_watermark() {
        let c = db();
        assert!(!unseen(&c, 0).unwrap());
        assert!(!see(&c).unwrap(), "nothing to see");
        let a = add(&c, &new("doc", "a"), 0).unwrap();
        assert!(!a.seen);
        assert!(unseen(&c, 0).unwrap());
        assert!(see(&c).unwrap());
        assert!(!see(&c).unwrap(), "seeing twice changes nothing");
        assert!(!unseen(&c, 0).unwrap());
        assert!(list(&c, 0, 0).unwrap()[0].seen);
        add(&c, &new("answered", "yes"), 1).unwrap();
        assert!(
            !unseen(&c, 1).unwrap(),
            "the reader's own answer lights nothing"
        );
        let b = add(&c, &new("aside", "b"), 1).unwrap();
        assert!(!b.seen);
        assert!(unseen(&c, 1).unwrap());
    }

    #[test]
    fn removed_is_kept_and_comes_back() {
        let c = db();
        let a = add(&c, &new("doc", "a"), 0).unwrap();
        let b = add(&c, &new("aside", "b"), 0).unwrap();
        assert!(remove(&c, &[a.id], None, 5).unwrap());
        assert!(!remove(&c, &[a.id], None, 6).unwrap(), "twice is once");
        assert_eq!(list(&c, 0, 0).unwrap().len(), 1);
        assert_eq!(removed(&c, 10).unwrap()[0].id, a.id);
        assert!(
            !remove(&c, &[b.id], Some("doc"), 7).unwrap(),
            "a kind narrows it"
        );
        assert_eq!(
            list(&c, 0, 0).unwrap()[0].id,
            b.id,
            "the aside was not touched"
        );
        assert!(restore(&c, &[a.id], None).unwrap());
        assert!(!restore(&c, &[a.id], None).unwrap());
        assert_eq!(list(&c, 0, 0).unwrap().len(), 2);
        assert!(removed(&c, 10).unwrap().is_empty());
    }

    #[test]
    fn news_goes_after_its_days_and_asides_stay() {
        let c = db();
        add(&c, &new("aside", "kept"), 0).unwrap();
        add(&c, &new("tick", "news"), 0).unwrap();
        let later = NEWS_DAYS * 86_400 + 1;
        let l = list(&c, 0, later).unwrap();
        assert_eq!(l.len(), 1, "old news is not listed before a prune");
        assert_eq!(l[0].text, "kept");
        add(&c, &new("doc", "new"), later).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM lately", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2, "the old tick was pruned, the aside kept");
    }

    #[test]
    fn of_kind_lists_removed_too() {
        let c = db();
        let a = add(&c, &new("aside", "a"), 0).unwrap();
        add(&c, &new("doc", "d"), 0).unwrap();
        remove(&c, &[a.id], Some("aside"), 1).unwrap();
        let v = of_kind(&c, "aside", 5).unwrap();
        assert_eq!(v.len(), 1);
        assert!(v[0].removed);
    }

    #[test]
    fn the_last_lit_aside() {
        let c = db();
        assert_eq!(last_lit_aside(&c).unwrap(), None);
        add(&c, &new("aside", "a"), 10).unwrap();
        add(
            &c,
            &New {
                lit: false,
                ..new("aside", "b")
            },
            20,
        )
        .unwrap();
        add(&c, &new("doc", "d"), 30).unwrap();
        assert_eq!(last_lit_aside(&c).unwrap(), Some(10));
    }
}
