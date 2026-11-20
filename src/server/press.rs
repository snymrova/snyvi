//! The reader's press, typed into the panel that asked (1.67, plan f586a9fe09).
//!
//! Until 1.67 only the window typed: an answer pressed on the desk whose page
//! was open went into its panel, and one pressed on Home, in the corner or on
//! a plan's own page waited for the reader's next message there. So the
//! reader could not run their agents from one place. Now the daemon types it,
//! wherever the press was.
//!
//! What is typed is the reader's own: the answer they chose on a card, and
//! snyvi's fixed words round it ("Answered in snyvi:", "Approved in snyvi: go
//! ahead with the plan <id> for #n."). Never the agent's question, a
//! document's text, or anything a friend sent: what goes into a terminal is
//! input, and snyvi makes no input from what it received. It is typed only on
//! a capability route, the window's, so a token still starts nothing; and
//! only into an agent's session (Claude Code's or Codex's) at rest at its
//! prompt (`pane::Live::press`).
//! When that is not so, nothing is typed and the answer goes as it always
//! did, at the turn's end (the Stop hook) or with the panel's next prompt.

use super::*;
use crate::thread::{self, Turn};

/// What became of a press, for the window: `typed`, or `later` and why.
fn said(r: Result<(), &'static str>) -> serde_json::Value {
    match r {
        Ok(()) => json!({ "sent": "typed" }),
        Err(why) => json!({ "sent": "later", "why": why }),
    }
}

/// An agent's session id, as the page's Send now asked for one: a panel
/// whose agent left no such id may be a shell, where a line typed is a
/// command run. Claude Code's or Codex's (1.67, `agents::session_agent`):
/// both hooks name their conversation, both prompts take a bracketed paste
/// and an Enter, so an approved Codex no longer waits for the reader to type.
fn session_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

/// Type `lines` into `pane` of `desk`, if it is a panel a press may go to:
/// on this desk, holding an agent's session, and not a routine's panel, whose
/// answers start its next run instead (`routine_run`).
fn press(app: &App, desk: i64, pane: &str, lines: &[String]) -> Result<(), &'static str> {
    if pane.is_empty() {
        return Err("its panel is gone");
    }
    let ok = app.store.clocked(|c, _| {
        let Some(p) = crate::desk::pane(c, pane)? else {
            return Ok(Err("its panel is gone"));
        };
        if p.desk_id != desk {
            return Ok(Err("its panel is gone"));
        }
        if !session_ok(&p.pane.agent_session) {
            return Ok(Err("no agent session is in its panel"));
        }
        if crate::routine::of_pane(c, pane)?.is_some() {
            return Ok(Err("a routine hears it at its next run"));
        }
        Ok(Ok(()))
    });
    match ok {
        Ok(Ok(())) => app.panes.press(pane, lines),
        Ok(Err(why)) => Err(why),
        Err(_) => Err("snyvi could not read its panel"),
    }
}

/// The reader answered `turn` in snyvi. Typed into the panel that asked: a
/// card of one at once, a card of several once its last question is answered,
/// numbered as the agent asked them. `None` for what is never typed: a
/// question the mod holds (its answer is already with Claude), a due line or
/// a "who should know" card (snyvi's own), and a press the window says is
/// quiet (a command Run typed, "answered in the chat").
pub(crate) fn answered(app: &App, turn: &Turn, quiet: bool) -> Option<serde_json::Value> {
    if quiet
        || turn.via == "dialog"
        || turn.kind == crate::due::KIND
        || turn.kind == crate::told::KIND
        || turn.answered_in != "snyvi"
        || turn.told_at != 0
    {
        return None;
    }
    let desk = turn.desk_id;
    let (ids, lines): (Vec<i64>, Vec<String>) = if turn.ask_group == 0 {
        (
            vec![turn.id],
            vec![format!("Answered in snyvi: {}", turn.answer)],
        )
    } else {
        let g = turn.ask_group;
        let all = app
            .store
            .clocked(|c, _| thread::group_turns(c, desk, g))
            .ok()?;
        if all.iter().any(|w| w.answered_at == 0) {
            return Some(json!({ "sent": "wait" }));
        }
        let ms: Vec<&Turn> = all
            .iter()
            .filter(|w| w.answered_in == "snyvi" && w.told_at == 0)
            .collect();
        let mut lines = vec!["Answered in snyvi:".to_string()];
        lines.extend(ms.iter().map(|w| format!("{}. {}", w.id - g + 1, w.answer)));
        (ms.iter().map(|w| w.id).collect(), lines)
    };
    if ids.is_empty() {
        return None;
    }
    let r = press(app, desk, &turn.pane, &lines);
    if r.is_ok() {
        // Told by the typing: the prompt it starts does not bring them again.
        let _ = app.store.clocked(|c, now| {
            for id in &ids {
                thread::sent_turn(c, desk, *id, now)?;
            }
            Ok(())
        });
    }
    Some(said(r))
}

/// The reader approved the plan `doc` on `desk`: the go-ahead typed into the
/// panel that planned it, in snyvi's own words with the plan's id and its
/// lines' numbers. `None` when no open line is planned by it.
pub(crate) fn approved(app: &App, desk: i64, doc: &str) -> Option<serde_json::Value> {
    let notes = app.store.clocked(|c, _| crate::desk::notes(c, desk)).ok()?;
    let xs: Vec<&crate::desk::DeskNote> = notes
        .iter()
        .filter(|x| x.stage_doc == doc && x.stage == "planned" && x.ok_at != 0 && !x.done)
        .collect();
    let pane = xs.first()?.stage_pane.clone();
    let ids = xs
        .iter()
        .map(|x| format!("#{}", x.id))
        .collect::<Vec<_>>()
        .join(" ");
    let line = format!("Approved in snyvi: go ahead with the plan {doc} for {ids}.");
    Some(said(press(app, desk, &pane, &[line])))
}

#[cfg(test)]
mod tests {
    use super::session_ok;

    #[test]
    fn only_a_session_id_is_a_session() {
        assert!(session_ok("00b483b7-1c61-4366-8ed7-1d95fbef6a17"));
        assert!(!session_ok(""));
        assert!(!session_ok("codex-1"));
        // A Codex thread id is a session too (1.67): version 7.
        assert!(session_ok("019a3c4e-5b6d-7e8f-9a0b-1c2d3e4f5a6b"));
        assert!(!session_ok("00B483B7-1C61-4366-8ED7-1D95FBEF6A17"));
        assert!(!session_ok("00b483b7-1c61-4366-8ed7-1d95fbef6a1"));
        assert!(!session_ok("00b483b7x1c61-4366-8ed7-1d95fbef6a17"));
    }
}
