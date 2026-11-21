//! What a program says of itself (`OSC 7501`), put on its pane. Kept out of
//! `pane.rs` with the one rule it has: this word is drawn, and nothing acts
//! on it.

use super::Status;

/// A pane's last word on the page-wide stream: `(running, blocked, agent,
/// said)`.
pub(super) type Told = (bool, bool, &'static str, &'static str);

/// What a program said of itself (`Status::said`) put on its pane. A hook's
/// agent in the pane wins: its word is the one everything else reads, and
/// two voices for one program would only disagree. `needs_you` and `error`
/// are also `blocked`, as an agent's `needs_you` is, and leaving them takes
/// back only what they set. Whether anything changed, and whether the pane
/// just came to wait on its reader.
pub(super) fn say(s: &mut Status, word: &'static str, app: String) -> (bool, bool) {
    let hooked = s.agent_in || !s.agent.is_empty();
    let (word, app) = if hooked || !s.running {
        ("", String::new())
    } else {
        (word, app)
    };
    if s.said == word && s.said_app == app {
        return (false, false);
    }
    let waits = |w: &str| w == "needs_you" || w == "error";
    let mut rang = false;
    if waits(word) && !s.blocked {
        s.blocked = true;
        s.blocked_since = Some(crate::store::now());
        rang = true;
    } else if waits(s.said) && !waits(word) && s.agent != "needs_you" {
        s.blocked = false;
        s.blocked_since = None;
    }
    s.said = word;
    s.said_app = app;
    (true, rang)
}
