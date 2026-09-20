//! Notes: a line an agent leaves beside the work, the way a friend at the next
//! desk would -- not a document, not a notification.
//!
//! Kept in memory and only the last few: a note is about now, and one that
//! outlived a daemon restart would be about some other now. Rare by
//! construction as well as by asking: a note that comes within `QUIET_SECS` of
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
/// A note lights up at most this often.
const QUIET_SECS: i64 = 600;

#[derive(Clone, Debug, Serialize)]
pub struct Note {
    pub id: u64,
    pub text: String,
    /// The agent's name from its MCP `initialize`.
    pub sender: Option<String>,
    /// The project the agent is working in, from its working directory.
    pub project: Option<String>,
    /// A document the note is about; clicking the note opens it.
    pub about: Option<String>,
    pub at: i64,
    /// Whether it arrived glowing. False when it came too soon after the last.
    pub lit: bool,
    /// Whether a reader has looked at it.
    pub seen: bool,
}

/// What a sender posts.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct NewNote {
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
    notes: VecDeque<Note>,
    next: u64,
    last_lit: Option<i64>,
}

#[derive(Default)]
pub struct Notes(Mutex<Inner>);

impl Notes {
    pub fn add(&self, n: NewNote, now: i64) -> Result<Note> {
        let text = n.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            bail!("a note needs some text");
        }
        if text.chars().count() > MAX_CHARS {
            bail!("a note is a sentence or two (at most {MAX_CHARS} characters); send anything longer with send_document");
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
        let note = Note {
            id: g.next,
            text,
            sender: n.sender.filter(|s| !s.trim().is_empty()),
            project,
            about: n.about.filter(|s| !s.trim().is_empty()),
            at: now,
            lit,
            seen: false,
        };
        g.notes.push_front(note.clone());
        g.notes.truncate(KEEP);
        Ok(note)
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Note> {
        let g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.notes.iter().cloned().collect()
    }

    /// Everything kept has been looked at. True when that changed anything.
    pub fn see(&self) -> bool {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        for n in g.notes.iter_mut().filter(|n| !n.seen) {
            n.seen = true;
            changed = true;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(text: &str) -> NewNote {
        NewNote {
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_the_last_few_newest_first() {
        let notes = Notes::default();
        for i in 0..7 {
            notes.add(new(&format!("note {i}")), 1000 + i).unwrap();
        }
        let l = notes.list();
        assert_eq!(l.len(), KEEP);
        assert_eq!(l[0].text, "note 6");
        assert_eq!(l[KEEP - 1].text, "note 2");
    }

    #[test]
    fn lights_up_rarely() {
        let notes = Notes::default();
        assert!(notes.add(new("a"), 0).unwrap().lit);
        assert!(!notes.add(new("b"), 60).unwrap().lit);
        assert!(notes.add(new("c"), QUIET_SECS).unwrap().lit);
    }

    #[test]
    fn refuses_empty_and_long() {
        let notes = Notes::default();
        assert!(notes.add(new("   "), 0).is_err());
        assert!(notes.add(new(&"x".repeat(MAX_CHARS + 1)), 0).is_err());
        assert_eq!(
            notes.add(new("  two\n  lines "), 0).unwrap().text,
            "two lines"
        );
    }

    #[test]
    fn seeing_is_once() {
        let notes = Notes::default();
        notes.add(new("a"), 0).unwrap();
        assert!(notes.see());
        assert!(!notes.see());
        assert!(notes.list()[0].seen);
    }
}
