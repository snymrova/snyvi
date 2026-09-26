//! Asides: a line an agent leaves beside the work, the way a friend at the next
//! desk would -- not a document, not a notification.
//!
//! Kept in memory and only the last few: an aside is about now, and one that
//! outlived a daemon restart would be about some other now. Rare by
//! construction as well as by asking: an aside that comes within `QUIET_SECS` of
//! the last one that lit up joins the trail without lighting up itself, so an
//! agent that sends one per edit costs the reader nothing.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;

/// How many are kept: the one showing and the trail under it.
pub const KEEP: usize = 5;
/// A sentence or two. Past this it is a document and `send_document` is for it.
pub const MAX_CHARS: usize = 280;
/// An aside lights up at most this often.
const QUIET_SECS: i64 = 600;

#[derive(Clone, Debug, Serialize)]
pub struct Aside {
    pub id: u64,
    pub text: String,
    /// The agent's name from its MCP `initialize`.
    pub sender: Option<String>,
    /// The project the agent is working in, from its working directory.
    pub project: Option<String>,
    /// A document the aside is about; clicking the aside opens it.
    pub about: Option<String>,
    pub at: i64,
    /// Whether it arrived glowing. False when it came too soon after the last.
    pub lit: bool,
    /// Whether a reader has looked at it.
    pub seen: bool,
    /// Closed by a reader. Kept, flagged, so an Undo has it to put back; the
    /// ring still lets it go in its turn.
    pub dismissed: bool,
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
}

#[derive(Default)]
struct Inner {
    asides: VecDeque<Aside>,
    next: u64,
    last_lit: Option<i64>,
}

#[derive(Default)]
pub struct Asides(Mutex<Inner>);

impl Asides {
    pub fn add(&self, n: NewAside, now: i64) -> Result<Aside> {
        let text = n.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            bail!("an aside needs some text");
        }
        if text.chars().count() > MAX_CHARS {
            bail!("an aside is a sentence or two (at most {MAX_CHARS} characters); send anything longer with send_document");
        }
        let project = n
            .cwd
            .as_deref()
            .filter(|c| !c.is_empty())
            .map(|c| crate::project::resolve(std::path::Path::new(c)).name);
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let lit = g.last_lit.is_none_or(|t| now - t >= QUIET_SECS);
        if lit {
            g.last_lit = Some(now);
        }
        g.next += 1;
        let aside = Aside {
            id: g.next,
            text,
            sender: n.sender.filter(|s| !s.trim().is_empty()),
            project,
            about: n.about.filter(|s| !s.trim().is_empty()),
            at: now,
            lit,
            seen: false,
            dismissed: false,
        };
        g.asides.push_front(aside.clone());
        g.asides.truncate(KEEP);
        Ok(aside)
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Aside> {
        let g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.asides.iter().cloned().collect()
    }

    /// Everything kept has been looked at. True when that changed anything.
    pub fn see(&self) -> bool {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for n in g.asides.iter_mut().filter(|n| !n.seen) {
            n.seen = true;
            changed = true;
        }
        changed
    }

    /// A reader closed these. True when that changed anything.
    pub fn dismiss(&self, ids: &[u64]) -> bool {
        self.set_dismissed(ids, true)
    }

    /// Undo: the closed ones are back where they were.
    pub fn restore(&self, ids: &[u64]) -> bool {
        self.set_dismissed(ids, false)
    }

    fn set_dismissed(&self, ids: &[u64], to: bool) -> bool {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for n in g
            .asides
            .iter_mut()
            .filter(|n| ids.contains(&n.id) && n.dismissed != to)
        {
            n.dismissed = to;
            changed = true;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(text: &str) -> NewAside {
        NewAside {
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_the_last_few_newest_first() {
        let asides = Asides::default();
        for i in 0..7 {
            asides.add(new(&format!("aside {i}")), 1000 + i).unwrap();
        }
        let l = asides.list();
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].text, "aside 6");
        assert_eq!(l[KEEP - 1].text, "aside 2");
    }

    #[test]
    fn lights_up_rarely() {
        let asides = Asides::default();
        assert!(asides.add(new("a"), 0).unwrap().lit);
        assert!(!asides.add(new("b"), 60).unwrap().lit);
        assert!(asides.add(new("c"), QUIET_SECS).unwrap().lit);
    }

    #[test]
    fn refuses_empty_and_long() {
        let asides = Asides::default();
        assert!(asides.add(new("   "), 0).is_err());
        assert!(asides.add(new(&"x".repeat(MAX_CHARS + 1)), 0).is_err());
        assert_eq!(
            asides.add(new("  two\n  lines "), 0).unwrap().text,
            "two lines"
        );
    }

    #[test]
    fn seeing_is_once() {
        let asides = Asides::default();
        asides.add(new("a"), 0).unwrap();
        assert!(asides.see());
        assert!(!asides.see());
        assert!(asides.list()[0].seen);
    }

    #[test]
    fn closing_keeps_it_for_undo() {
        let asides = Asides::default();
        let a = asides.add(new("a"), 0).unwrap();
        let b = asides.add(new("b"), 60).unwrap();
        assert!(asides.dismiss(&[b.id]));
        assert!(!asides.dismiss(&[b.id]), "closing twice changes nothing");
        let l = asides.list();
        assert_eq!(l.len(), 2, "a closed aside is still listed");
        assert!(l[0].dismissed && !l[1].dismissed);
        assert!(asides.restore(&[b.id]));
        assert!(!asides.list()[0].dismissed);
        assert!(asides.dismiss(&[a.id, b.id]));
        let c = asides.add(new("c"), 120).unwrap();
        assert!(
            !asides.list()[0].dismissed,
            "a new aside after a close shows"
        );
        assert_eq!(asides.list()[0].id, c.id);
        assert!(
            !asides.dismiss(&[999]),
            "an id that is gone changes nothing"
        );
    }
}
