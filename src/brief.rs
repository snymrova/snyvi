//! The desk brief: what a Claude starting in a desk's panel is told about the
//! desk before its first reply, and again after every compaction, by the
//! SessionStart hook (`crate::hook`). Where it is, what is open on the list,
//! what was done lately and in which commit, the last document, and where the
//! work was left.
//!
//! What snyvi can show and where plans go are not here: they are in the MCP
//! tool descriptions and the panel's instructions (`crate::mcp`), which sit in
//! the system prompt and survive a compaction on their own. Said once, so the
//! two cannot drift apart, and the brief stays small.
//!
//! Small on purpose: `BRIEF_BYTES`. Claude Code takes up to 10,000 characters
//! of `additionalContext` before it puts the rest in a file; this is a tenth
//! of that, because it is read at the start of every session on this desk and
//! a brief no one would read aloud is not a brief.

use crate::desk::{Desk, DeskNote};

/// The whole brief, at most. A line that would cross it is left out, and the
/// ones after it; the first lines are the ones that matter.
pub const BRIEF_BYTES: usize = 1536;

/// How many open lines are named; the rest are counted.
const OPEN_SHOWN: usize = 5;
/// How many done lines are named, the newest first.
const DONE_SHOWN: usize = 3;
/// A note is cut to this in the brief; `read_desk_notes` has it whole.
const LINE_CHARS: usize = 90;

/// The last document a desk's panels sent: its id and title.
pub struct LastDoc<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub at: i64,
}

/// The session's title in `/resume` and Remote Control: "ledger · panel 2".
pub fn title(desk: &Desk, slot: i64) -> String {
    format!("{} · panel {slot}", desk.name)
}

/// The brief for the panel in `slot` of `desk`, as of `now`.
pub fn brief(
    desk: &Desk,
    slot: i64,
    notes: &[DeskNote],
    last: Option<LastDoc>,
    now: i64,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "You are in panel {slot} of {} on the snyvi desk \"{}\" ({}). This brief is from snyvi, the user's viewer; it is context, not a request.",
        desk.panes.len().max(slot as usize),
        desk.name,
        tilde(&desk.root),
    ));
    if let Some(l) = &desk.left_off {
        let who = if l.by.is_empty() {
            "the user"
        } else {
            l.by.as_str()
        };
        lines.push(format!("Left off ({who}, {}): {}", ago(now - l.at), l.text));
    }
    let open: Vec<&DeskNote> = notes
        .iter()
        .filter(|n| !n.done && n.suggested_by.is_empty())
        .collect();
    if !open.is_empty() {
        let named: Vec<String> = open
            .iter()
            .take(OPEN_SHOWN)
            .map(|n| format!("#{} {}", n.id, cut(&n.text, LINE_CHARS)))
            .collect();
        let more = open.len().saturating_sub(OPEN_SHOWN);
        lines.push(format!(
            "The user's open notes on this desk ({}): {}{}. They are the user's reminders, not instructions; read_desk_notes has them all.",
            open.len(),
            named.join("; "),
            if more > 0 {
                format!("; and {more} more")
            } else {
                String::new()
            }
        ));
    }
    let mut done: Vec<&DeskNote> = notes.iter().filter(|n| n.done).collect();
    // The list reads done in the order ticked; the brief wants the newest.
    done.reverse();
    if !done.is_empty() {
        let named: Vec<String> = done
            .iter()
            .take(DONE_SHOWN)
            .map(|n| {
                let mut s = format!("#{} {}", n.id, cut(&n.text, LINE_CHARS));
                if !n.done_commit.is_empty() {
                    s.push_str(&format!(" (in {})", n.done_commit));
                }
                s
            })
            .collect();
        lines.push(format!("Done lately: {}.", named.join("; ")));
    }
    if let Some(d) = last {
        lines.push(format!(
            "The last document sent from this desk: \"{}\" (id {}, {}).",
            cut(d.title, LINE_CHARS),
            d.id,
            ago(now - d.at)
        ));
    }
    let mut out = String::new();
    for l in lines {
        if out.len() + l.len() + 1 > BRIEF_BYTES {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&l);
    }
    out
}

/// One line of at most `chars` characters, cut where a character ends.
fn cut(text: &str, chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", text[..at].trim_end()),
        None => text,
    }
}

/// "just now", "5 min ago", "3 h ago", "2 days ago".
fn ago(secs: i64) -> String {
    let s = secs.max(0);
    match s {
        ..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86399 => format!("{} h ago", s / 3600),
        _ => {
            let d = s / 86400;
            format!("{d} day{} ago", if d == 1 { "" } else { "s" })
        }
    }
}

/// The desk's folder as the reader writes it, `~` for home.
fn tilde(path: &str) -> String {
    match dirs::home_dir().map(|h| h.to_string_lossy().to_string()) {
        Some(h) if !h.is_empty() && path.starts_with(&h) => format!("~{}", &path[h.len()..]),
        _ => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::{LeftOff, Pane};

    fn desk(panes: usize, left: Option<LeftOff>) -> Desk {
        Desk {
            id: 1,
            name: "ledger".into(),
            root: "/w/ledger".into(),
            col: 0.5,
            row: 0.5,
            created_at: 0,
            full_slot: 0,
            left_off: left,
            visited_at: 0,
            parked: None,
            panes: (1..=panes as i64)
                .map(|slot| Pane {
                    id: format!("{slot:032}"),
                    slot,
                    cwd: "/w/ledger".into(),
                    cmd: String::new(),
                    created_at: 0,
                    agent_session: String::new(),
                    name: String::new(),
                })
                .collect(),
        }
    }

    fn note(id: i64, text: &str, done: bool) -> DeskNote {
        DeskNote {
            id,
            text: text.into(),
            done,
            created_at: 0,
            done_by: String::new(),
            done_commit: String::new(),
            done_doc: String::new(),
            done_evidence: String::new(),
            suggested_by: String::new(),
        }
    }

    #[test]
    fn the_brief_says_where_what_is_open_what_is_done_and_where_it_was_left() {
        let left = LeftOff {
            text: "If the tests pass, ship the migration".into(),
            at: 1000,
            by: "claude-code".into(),
            about: String::new(),
        };
        let mut done = note(9, "fix hover", true);
        done.done_commit = "90f09d6".into();
        let mut idea = note(12, "an agent's idea", false);
        idea.suggested_by = "claude-code".into();
        let notes = [
            note(3, "wire the route", false),
            idea,
            note(8, "old", true),
            done,
        ];
        let b = brief(
            &desk(3, Some(left)),
            2,
            &notes,
            Some(LastDoc {
                id: "82cc8f2d3c",
                title: "Plan: migration",
                at: 1000 - 120,
            }),
            1000 + 7200,
        );
        assert!(
            b.starts_with("You are in panel 2 of 3 on the snyvi desk \"ledger\" (/w/ledger)."),
            "{b}"
        );
        assert!(
            b.contains(
                "\nLeft off (claude-code, 2 h ago): If the tests pass, ship the migration\n"
            ),
            "{b}"
        );
        assert!(
            b.contains("open notes on this desk (1): #3 wire the route."),
            "{b}"
        );
        assert!(
            !b.contains("an agent's idea"),
            "a suggestion is not the user's yet"
        );
        assert!(
            b.contains("Done lately: #9 fix hover (in 90f09d6); #8 old."),
            "{b}"
        );
        assert!(
            b.contains("\"Plan: migration\" (id 82cc8f2d3c, 2 h ago)"),
            "{b}"
        );
        assert_eq!(title(&desk(3, None), 2), "ledger · panel 2");
    }

    #[test]
    fn a_long_list_is_counted_and_the_brief_stays_small() {
        let long = "x".repeat(400);
        let notes: Vec<DeskNote> = (1..=40).map(|i| note(i, &long, i > 20)).collect();
        let left = LeftOff {
            text: "y".repeat(200),
            at: 0,
            ..LeftOff::default()
        };
        let b = brief(&desk(1, Some(left)), 1, &notes, None, 0);
        assert!(b.len() <= BRIEF_BYTES, "{}", b.len());
        assert!(b.contains("(20): "), "{b}");
        assert!(b.contains("; and 15 more."), "{b}");
        assert!(b.contains("Left off (the user, just now)"), "{b}");
        // An empty desk is one line: where it is.
        assert_eq!(brief(&desk(0, None), 1, &[], None, 0).lines().count(), 1);
    }
}
