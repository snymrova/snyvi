//! Asides: a line an agent leaves beside the work, the way a friend at the next
//! desk would -- not a document, not a notification.
//!
//! Kept, as rows of `crate::lately`: they lived in memory, five at most, and
//! every update restarts the daemon, so what Claude said an hour ago had no
//! answer anywhere (plan b0bca0a11f). An aside stays until the reader removes
//! it, like a document. Rare by construction as well as by asking: an aside
//! that comes within `QUIET_SECS` of the last one that lit up joins the list
//! without lighting up itself, so an agent that sends one per edit costs the
//! reader nothing.

use anyhow::{bail, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::lately;

/// How many `/api/notes` lists: the newest and the few before it.
pub const KEEP: usize = 5;
/// A sentence or two. Past this it is a document and `send_document` is for it.
pub const MAX_CHARS: usize = 280;
/// An aside lights up at most this often.
const QUIET_SECS: i64 = 600;

#[derive(Clone, Debug, Serialize)]
pub struct Aside {
    pub id: i64,
    pub text: String,
    /// The agent's name from its MCP `initialize`.
    pub sender: Option<String>,
    /// The project the agent is working in, from its working directory.
    pub project: Option<String>,
    /// A document the aside is about; clicking the aside opens it.
    pub about: Option<String>,
    /// The desk and panel it was sent from, when it came from one: clicking
    /// an aside that is about no document goes there, where a reply is typed.
    /// Copied at arrival, like a document's, so it outlives the pane.
    pub from: Option<crate::desk::Origin>,
    pub at: i64,
    /// Whether it arrived glowing. False when it came too soon after the last.
    pub lit: bool,
    /// Whether a reader has looked at it.
    pub seen: bool,
    /// Removed by a reader. Still listed, flagged, so an Undo has it to put
    /// back.
    pub dismissed: bool,
}

impl From<lately::Row> for Aside {
    fn from(r: lately::Row) -> Aside {
        let project = r
            .data
            .get("project")
            .and_then(|v| v.as_str())
            .map(String::from);
        Aside {
            id: r.id,
            text: r.text,
            sender: Some(r.who).filter(|s| !s.is_empty()),
            project,
            about: Some(r.doc).filter(|s| !s.is_empty()),
            from: r.from,
            at: r.at,
            lit: r.lit,
            seen: r.seen,
            dismissed: r.removed,
        }
    }
}

/// What a sender posts.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct NewAside {
    pub text: String,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// The pane it was sent from: `SNYVI_SESSION`. The daemon looks it up;
    /// one it does not know is no reason to refuse the aside.
    #[serde(default)]
    pub pane: Option<String>,
}

/// The text as it is kept, or why it is refused.
fn text_of(n: &NewAside) -> Result<String> {
    let text = n.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        bail!("an aside needs some text");
    }
    if text.chars().count() > MAX_CHARS {
        bail!("an aside is a sentence or two (at most {MAX_CHARS} characters); send anything longer with send_document");
    }
    Ok(text)
}

pub fn add(
    conn: &Connection,
    n: NewAside,
    from: Option<crate::desk::Origin>,
    now: i64,
) -> Result<(Aside, lately::Row)> {
    let text = text_of(&n)?;
    let project = n
        .cwd
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| crate::project::resolve(std::path::Path::new(c)).name);
    let lit = lately::last_lit_aside(conn)?.is_none_or(|t| now - t >= QUIET_SECS);
    let row = lately::add(
        conn,
        &lately::New {
            kind: "aside",
            text,
            who: n
                .sender
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_default(),
            from,
            doc: n.about.filter(|s| !s.trim().is_empty()).unwrap_or_default(),
            data: project
                .map(|p| serde_json::json!({ "project": p }))
                .unwrap_or_default(),
            lit,
        },
        now,
    )?;
    Ok((row.clone().into(), row))
}

/// The newest few, removed ones flagged, newest first.
pub fn list(conn: &Connection) -> Vec<Aside> {
    lately::of_kind(conn, "aside", KEEP)
        .unwrap_or_default()
        .into_iter()
        .map(Aside::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(lately::SCHEMA).unwrap();
        c
    }

    fn new(text: &str) -> NewAside {
        NewAside {
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn lists_the_last_few_newest_first() {
        let c = db();
        for i in 0..7 {
            add(&c, new(&format!("aside {i}")), None, 1000 + i).unwrap();
        }
        let l = list(&c);
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].text, "aside 6");
        assert_eq!(l[KEEP - 1].text, "aside 2");
        assert_eq!(
            lately::list(&c, 0, 2000).unwrap().len(),
            7,
            "all of them are kept"
        );
    }

    #[test]
    fn lights_up_rarely() {
        let c = db();
        assert!(add(&c, new("a"), None, 0).unwrap().0.lit);
        assert!(!add(&c, new("b"), None, 60).unwrap().0.lit);
        assert!(add(&c, new("c"), None, QUIET_SECS).unwrap().0.lit);
    }

    #[test]
    fn refuses_empty_and_long() {
        let c = db();
        assert!(add(&c, new("   "), None, 0).is_err());
        assert!(add(&c, new(&"x".repeat(MAX_CHARS + 1)), None, 0).is_err());
        assert_eq!(
            add(&c, new("  two\n  lines "), None, 0).unwrap().0.text,
            "two lines"
        );
    }

    #[test]
    fn keeps_where_it_came_from() {
        let c = db();
        let at = crate::desk::Origin {
            id: 3,
            name: "ledger".into(),
            slot: 2,
            grp: 0,
        };
        let (a, _) = add(&c, new("from a panel"), Some(at.clone()), 0).unwrap();
        assert_eq!(a.from.as_ref(), Some(&at));
        let json = serde_json::to_value(&list(&c)[0]).unwrap();
        assert_eq!(json["from"]["slot"], 2);
        assert_eq!(json["from"]["name"], "ledger");
        let (b, _) = add(&c, new("from nowhere"), None, 60).unwrap();
        assert!(b.from.is_none());
        assert!(serde_json::to_value(&b).unwrap()["from"].is_null());
        let n = NewAside {
            about: Some("abc".into()),
            sender: Some("claude-code".into()),
            ..new("about one")
        };
        let (d, _) = add(&c, n, None, 61).unwrap();
        assert_eq!(d.about.as_deref(), Some("abc"));
        assert_eq!(d.sender.as_deref(), Some("claude-code"));
    }

    #[test]
    fn seeing_is_once() {
        let c = db();
        add(&c, new("a"), None, 0).unwrap();
        assert!(lately::see(&c).unwrap());
        assert!(!lately::see(&c).unwrap());
        assert!(list(&c)[0].seen);
    }

    #[test]
    fn closing_keeps_it_for_undo() {
        let c = db();
        let (a, _) = add(&c, new("a"), None, 0).unwrap();
        let (b, _) = add(&c, new("b"), None, 60).unwrap();
        assert!(lately::remove(&c, &[b.id], Some("aside"), 1).unwrap());
        assert!(
            !lately::remove(&c, &[b.id], Some("aside"), 2).unwrap(),
            "closing twice changes nothing"
        );
        let l = list(&c);
        assert_eq!(l.len(), 2, "a closed aside is still listed");
        assert!(l[0].dismissed && !l[1].dismissed);
        assert!(lately::restore(&c, &[b.id], Some("aside")).unwrap());
        assert!(!list(&c)[0].dismissed);
        assert!(lately::remove(&c, &[a.id, b.id], Some("aside"), 3).unwrap());
        let (d, _) = add(&c, new("c"), None, 120).unwrap();
        assert!(!list(&c)[0].dismissed, "a new aside after a close shows");
        assert_eq!(list(&c)[0].id, d.id);
        assert!(
            !lately::remove(&c, &[999], Some("aside"), 4).unwrap(),
            "an id that is gone changes nothing"
        );
    }
}
