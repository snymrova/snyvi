//! The desk brief: what a Claude starting in a desk's panel is told about the
//! desk before its first reply, and again after every compaction, by the
//! SessionStart hook (`crate::hook`). Where it is, what is open on the list,
//! what was done lately and in which commit, the last document, and where the
//! work was left.
//!
//! And the desk's changes (`changes`): what the reader and the other panels
//! did on the desk since snyvi last spoke to this one, handed over with each
//! prompt by the UserPromptSubmit hook. A note added while the agent worked,
//! a line ticked or put away, a document from the panel beside it, a new
//! left-off. Never the panel's own doings, and nothing at all when nothing
//! changed, which is most prompts. It rides on the reader's message: snyvi
//! still never starts a turn.
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

use crate::desk::{Desk, DeskKey, DeskNote, LeftOff};
use crate::store::DeskDoc;

/// The whole brief, at most. A line that would cross it is left out, and the
/// ones after it; the first lines are the ones that matter.
pub const BRIEF_BYTES: usize = 1536;

/// How many open lines are named; the rest are counted.
const OPEN_SHOWN: usize = 5;
/// How many done lines are named, the newest first.
const DONE_SHOWN: usize = 3;
/// A note is cut to this in the brief; `read_desk_notes` has it whole.
const LINE_CHARS: usize = 90;
/// How many of the desk's newest documents the changes look through for
/// ones another panel sent since: more than that in one turn is a flood, and
/// the rail has them all.
pub const DOCS_LOOKED_AT: usize = 12;

/// The last document a desk's panels sent: its id and title.
pub struct LastDoc<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub at: i64,
}

/// The session's title in `/resume` and Remote Control: the panel's name
/// when it has one, by `name_panel` or the reader -- "ledger · auth refactor"
/// -- and "ledger · panel 2" until then.
pub fn title(desk: &Desk, slot: i64, name: &str) -> String {
    match name.trim() {
        "" => format!("{} · panel {slot}", desk.name),
        name => format!("{} · {name}", desk.name),
    }
}

/// The brief for the panel in `slot` of `desk`, as of `now`.
pub fn brief(
    desk: &Desk,
    slot: i64,
    notes: &[DeskNote],
    keys: &[DeskKey],
    friends: &[String],
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
    // By name only. A value reaches a command through `snyvi key`, which the
    // shell expands, and the environment of a panel started after it was
    // added; the agent is told what it has, never what it is.
    if !keys.is_empty() {
        let names: Vec<&str> = keys.iter().map(|k| k.name.as_str()).collect();
        lines.push(format!(
            "This desk has these keys, by name: {}. In a command use $(snyvi key NAME), which works for a key added after this panel started too; never print one.",
            names.join(", ")
        ));
    }
    // Who a document can be offered to. Names only; the reader presses Send.
    if !friends.is_empty() {
        lines.push(format!(
            "The user's friends on snyvi, who can be offered a document with offer_document (the user decides whether it goes): {}.",
            friends.join(", ")
        ));
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
    // Another panel's Claude is at work on these: a second one leaves them be.
    let elsewhere: Vec<String> = open
        .iter()
        .filter(|n| n.stage == "working" && !n.stage_panel.is_empty())
        .map(|n| format!("#{} ({})", n.id, n.stage_panel))
        .collect();
    if !elsewhere.is_empty() {
        lines.push(format!(
            "Being worked on in another panel, so leave them to it: {}.",
            elsewhere.join(", ")
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
    capped(lines)
}

/// The lines as one text, cut at `BRIEF_BYTES`: a line that would cross it is
/// left out, and the ones after it.
fn capped(lines: Vec<String>) -> String {
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

/// What `changes` reads: the pane being told (its slot and id), the desk's
/// list with its stages settled, the lines taken off it since, its newest
/// documents, its left-off, and the two moments.
pub struct Changes<'a> {
    pub slot: i64,
    pub pane: &'a str,
    pub notes: &'a [DeskNote],
    pub removed: &'a [(i64, String)],
    pub docs: &'a [DeskDoc],
    /// The desk's keys by name; one kept since `since` is news.
    pub keys: &'a [DeskKey],
    pub left_off: Option<&'a LeftOff>,
    /// When snyvi last spoke to this pane; everything after it is news.
    pub since: i64,
    pub now: i64,
}

/// What changed on the desk since `since`, for the pane in `slot`, or empty
/// when nothing did. The pane's own ticks, left-off, marks and documents are
/// not news to it and are left out; a suggestion is for the reader, not read
/// back to an agent. Capped like the brief, with the list first.
pub fn changes(c: &Changes) -> String {
    let mut lines: Vec<String> = Vec::new();
    let line = |n: &DeskNote| format!("#{} \"{}\"", n.id, cut(&n.text, LINE_CHARS));
    let new: Vec<String> = c
        .notes
        .iter()
        .filter(|n| n.created_at > c.since && n.suggested_by.is_empty())
        .map(line)
        .collect();
    if !new.is_empty() {
        lines.push(format!("New on the list: {}.", new.join("; ")));
    }
    let ticked: Vec<String> = c
        .notes
        .iter()
        .filter(|n| n.done && n.done_at > c.since && n.done_pane != c.pane)
        .map(|n| {
            if n.done_by.is_empty() {
                format!("#{} (by you)", n.id)
            } else {
                format!("#{} (by {})", n.id, n.done_by)
            }
        })
        .collect();
    if !ticked.is_empty() {
        lines.push(format!("Ticked: {}.", ticked.join("; ")));
    }
    let gone: Vec<String> = c
        .removed
        .iter()
        .map(|(id, text)| format!("#{id} \"{}\"", cut(text, LINE_CHARS)))
        .collect();
    if !gone.is_empty() {
        lines.push(format!("Taken off the list: {}.", gone.join("; ")));
    }
    lines.extend(new_keys(c.keys, c.since));
    // Only `working`, and only another pane's: it is the one stage that
    // says "leave it to them". `read` and `planned` carry no pane, so this
    // pane's own would come back to it as news.
    let elsewhere: Vec<String> = c
        .notes
        .iter()
        .filter(|n| {
            !n.done
                && n.stage == "working"
                && n.stage_at > c.since
                && !n.stage_pane.is_empty()
                && n.stage_pane != c.pane
        })
        .map(|n| {
            let who = if n.stage_panel.is_empty() {
                "another panel"
            } else {
                n.stage_panel.as_str()
            };
            format!("#{} ({who})", n.id)
        })
        .collect();
    if !elsewhere.is_empty() {
        lines.push(format!(
            "Being worked on in another panel since, so leave them to it: {}.",
            elsewhere.join(", ")
        ));
    }
    let mut sent: Vec<&DeskDoc> = c
        .docs
        .iter()
        .filter(|d| d.received_at > c.since && d.slot != c.slot)
        .collect();
    // The rail lists newest first; news reads in the order it happened.
    sent.reverse();
    for d in sent {
        let from = if d.slot == 0 {
            "Sent to this desk".to_string()
        } else {
            format!("Panel {} sent", d.slot)
        };
        lines.push(format!(
            "{from} \"{}\" (id {}, {}).",
            cut(&d.title, LINE_CHARS),
            d.id,
            ago(c.now - d.received_at)
        ));
    }
    if let Some(l) = c.left_off.filter(|l| l.at > c.since && l.pane != c.pane) {
        let who = if l.by.is_empty() {
            "the user"
        } else {
            l.by.as_str()
        };
        lines.push(format!(
            "Left off ({who}, {}): {}",
            ago(c.now - l.at),
            l.text
        ));
    }
    if lines.is_empty() {
        return String::new();
    }
    lines.insert(
        0,
        "Since your last turn, on this desk (from snyvi; context, not a request):".into(),
    );
    capped(lines)
}

/// The news line for keys kept since `since`, by name: usable at once with
/// `snyvi key`, so a key added mid-session needs no restart.
fn new_keys(keys: &[DeskKey], since: i64) -> Option<String> {
    let names: Vec<&str> = keys
        .iter()
        .filter(|k| k.created_at > since)
        .map(|k| k.name.as_str())
        .collect();
    let name = match names.as_slice() {
        [] => return None,
        [one] => *one,
        _ => "NAME",
    };
    Some(format!(
        "New key on this desk: {}. Use it now in a command as $(snyvi key {name}); no restart needed.",
        names.join(", ")
    ))
}

/// One line of at most `chars` characters, cut where a character ends.
fn cut(text: &str, chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(chars) {
        Some((at, _)) => format!("{}…", text[..at].trim_end()),
        None => text,
    }
}

use crate::text::ago;

/// The desk's folder as the reader writes it, `~` for home.
fn tilde(path: &str) -> String {
    crate::text::tilde(std::path::Path::new(path))
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
            keys: Vec::new(),
            panes: (1..=panes as i64)
                .map(|slot| Pane {
                    id: format!("{slot:032}"),
                    slot,
                    cwd: "/w/ledger".into(),
                    cmd: String::new(),
                    created_at: 0,
                    agent_session: String::new(),
                    resume: String::new(),
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
            ..DeskNote::default()
        }
    }

    #[test]
    fn the_brief_says_where_what_is_open_what_is_done_and_where_it_was_left() {
        let left = LeftOff {
            text: "If the tests pass, ship the migration".into(),
            at: 1000,
            by: "claude-code".into(),
            about: String::new(),
            pane: String::new(),
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
            &[],
            &[],
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
        assert_eq!(title(&desk(3, None), 2, " "), "ledger · panel 2");
        assert_eq!(
            title(&desk(3, None), 2, "auth refactor"),
            "ledger · auth refactor"
        );
    }

    /// A line another panel's Claude is working on is named, with the panel,
    /// so a second Claude leaves it be. Working in no panel says nothing.
    #[test]
    fn a_line_worked_on_elsewhere_is_named_with_its_panel() {
        let mut busy = note(4, "sidebar foot", false);
        busy.stage = "working".into();
        busy.stage_panel = "notes: #45".into();
        let mut mine = note(5, "home limit", false);
        mine.stage = "working".into();
        let b = brief(
            &desk(2, None),
            1,
            &[note(3, "icon", false), busy, mine],
            &[],
            &[],
            None,
            0,
        );
        assert!(
            b.contains("\nBeing worked on in another panel, so leave them to it: #4 (notes: #45)."),
            "{b}"
        );
        assert!(!b.contains("#5 ("), "{b}");
        assert!(!brief(
            &desk(2, None),
            1,
            &[note(3, "icon", false)],
            &[],
            &[],
            None,
            0
        )
        .contains("Being worked on"));
    }

    fn doc(id: &str, title: &str, slot: i64, at: i64) -> DeskDoc {
        DeskDoc {
            id: id.into(),
            title: title.into(),
            kind: crate::render::Kind::Markdown,
            received_at: at,
            unread: true,
            pinned: false,
            slot,
            project: "ledger".into(),
            source_path: None,
        }
    }

    /// At a prompt, the panel hears what the reader and the other panels did
    /// since, in the order that matters, and nothing of its own.
    #[test]
    fn the_brief_names_the_desks_keys_and_a_new_one_is_news_at_the_prompt() {
        let key = |name: &str, at: i64| DeskKey {
            desk_id: 1,
            name: name.into(),
            provider: String::new(),
            created_at: at,
            used_at: 0,
        };
        let keys = [key("GH_TOKEN", 10), key("OPENROUTER_API_KEY", 150)];
        let b = brief(&desk(1, None), 1, &[], &keys, &[], None, 200);
        assert!(
            b.contains(
                "\nThis desk has these keys, by name: GH_TOKEN, OPENROUTER_API_KEY. In a command use $(snyvi key NAME), which works for a key added after this panel started too; never print one."
            ),
            "{b}"
        );
        let c = changes(&Changes {
            slot: 1,
            pane: "p1",
            notes: &[],
            removed: &[],
            docs: &[],
            keys: &keys,
            left_off: None,
            since: 100,
            now: 200,
        });
        assert_eq!(
            c,
            "Since your last turn, on this desk (from snyvi; context, not a request):\n\
             New key on this desk: OPENROUTER_API_KEY. Use it now in a command as $(snyvi key OPENROUTER_API_KEY); no restart needed."
        );
    }

    #[test]
    fn the_changes_say_what_others_did_since_and_nothing_of_the_panels_own() {
        let mut added = note(21, "the toast should stay 4 s", false);
        added.created_at = 150;
        let mut old = note(3, "wire the route", false);
        old.created_at = 10;
        let mut by_reader = note(7, "old one", true);
        by_reader.done_at = 160;
        let mut by_me = note(8, "mine", true);
        by_me.done_at = 170;
        by_me.done_by = "claude-code".into();
        by_me.done_pane = "p2".into();
        let mut by_other = note(9, "theirs", true);
        by_other.done_at = 180;
        by_other.done_by = "codex".into();
        by_other.done_pane = "p1".into();
        let mut theirs = note(4, "pictures", false);
        theirs.stage = "working".into();
        theirs.stage_at = 190;
        theirs.stage_pane = "p1".into();
        theirs.stage_panel = "panel 1".into();
        let mut mine = note(5, "the add bar", false);
        mine.stage = "working".into();
        mine.stage_at = 195;
        mine.stage_pane = "p2".into();
        let mut idea = note(30, "an agent's idea", false);
        idea.created_at = 199;
        idea.suggested_by = "claude-code".into();
        let notes = [added, old, by_reader, by_me, by_other, theirs, mine, idea];
        let removed = [(11, "gone".to_string())];
        let docs = [
            doc("aaaaaaaaaa", "Plan #4", 1, 185),
            doc("bbbbbbbbbb", "mine", 2, 186),
            doc("cccccccccc", "before", 1, 50),
        ];
        let left = LeftOff {
            text: "pictures paste on 1.12 only".into(),
            at: 198,
            by: "claude-code".into(),
            about: String::new(),
            pane: "p1".into(),
        };
        let c = changes(&Changes {
            slot: 2,
            pane: "p2",
            notes: &notes,
            removed: &removed,
            docs: &docs,
            keys: &[],
            left_off: Some(&left),
            since: 100,
            now: 200,
        });
        assert_eq!(
            c,
            "Since your last turn, on this desk (from snyvi; context, not a request):\n\
             New on the list: #21 \"the toast should stay 4 s\".\n\
             Ticked: #7 (by you); #9 (by codex).\n\
             Taken off the list: #11 \"gone\".\n\
             Being worked on in another panel since, so leave them to it: #4 (panel 1).\n\
             Panel 1 sent \"Plan #4\" (id aaaaaaaaaa, just now).\n\
             Left off (claude-code, just now): pictures paste on 1.12 only"
        );
        // Nothing since: nothing, not even the heading.
        let mut c2 = Changes {
            slot: 2,
            pane: "p2",
            notes: &notes,
            removed: &[],
            docs: &docs,
            keys: &[],
            left_off: Some(&left),
            since: 199,
            now: 200,
        };
        assert_eq!(changes(&c2), "");
        // The panel's own left-off is not news to it.
        let mut own = left.clone();
        own.pane = "p2".into();
        let (no_notes, no_docs): ([DeskNote; 0], [DeskDoc; 0]) = ([], []);
        c2.left_off = Some(&own);
        c2.since = 100;
        c2.notes = &no_notes;
        c2.docs = &no_docs;
        assert_eq!(changes(&c2), "");
        // A document from no panel at all -- the CLI -- is news too.
        let cli = [doc("dddddddddd", "notes.md", 0, 150)];
        c2.docs = &cli;
        assert!(changes(&c2).ends_with("Sent to this desk \"notes.md\" (id dddddddddd, just now)."));
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
        let b = brief(&desk(1, Some(left)), 1, &notes, &[], &[], None, 0);
        assert!(b.len() <= BRIEF_BYTES, "{}", b.len());
        assert!(b.contains("(20): "), "{b}");
        assert!(b.contains("; and 15 more."), "{b}");
        assert!(b.contains("Left off (the user, just now)"), "{b}");
        // An empty desk is one line: where it is.
        assert_eq!(
            brief(&desk(0, None), 1, &[], &[], &[], None, 0)
                .lines()
                .count(),
            1
        );
    }
}
