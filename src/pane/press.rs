//! The reader's own press, typed by the daemon (1.67, plan f586a9fe09). A part
//! of `pane`: it reads the pane's own state, and is kept apart for its size.

use super::*;

/// A press is not typed under the reader's hands: how long after their last
/// key in the pane (the page's `TYPED_MS`).
const PRESS_AFTER_KEYS: Duration = Duration::from_millis(2000);
/// Enter follows the paste by this much, as the page's Send now sent it.
const PRESS_ENTER_AFTER: Duration = Duration::from_millis(120);

/// One line of a press: every control character a space, so nothing in an
/// answer ends the paste early, presses Enter, or is read as a key.
fn press_line(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

impl Panes {
    /// `Live::press` for a pane this daemon has running. One it has not woken
    /// is not woken for it: nothing is at a prompt there.
    pub fn press(&self, id: &str, lines: &[String]) -> Result<(), &'static str> {
        let Some(l) = self.live.lock().unwrap().get(id).cloned() else {
            return Err("its panel is not running");
        };
        l.press(lines, self)
    }
}

impl Live {
    /// The reader's own press, typed by the daemon (1.67, plan f586a9fe09): an
    /// answer they chose on a card, or snyvi's fixed words for an Approve,
    /// wherever the press was -- Home, the corner, a desk not on screen. The
    /// caller (`server::press`) builds `lines` from the reader's answer and
    /// snyvi's own words, never from what an agent or a friend sent. Typed
    /// only into an agent at rest at its prompt, as the page's Send now asked:
    /// a session in the pane, not at work, no prompt of its own open, a
    /// bracketed paste on, and no key from the reader in the last
    /// `PRESS_AFTER_KEYS`. Otherwise nothing is typed and the reason is said:
    /// the answer goes at the turn's end or with the next prompt, as before.
    /// The lines go as one bracketed paste and Enter apart from it, since a
    /// paste with its Enter inside is not submitted by every program.
    pub fn press(&self, lines: &[String], panes: &Panes) -> Result<(), &'static str> {
        let text = lines
            .iter()
            .map(|l| press_line(l))
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\r");
        if text.is_empty() {
            return Err("there is nothing to say");
        }
        let mut i = self.inner.lock().unwrap();
        if !i.status.running {
            return Err("its panel is not running");
        }
        if !i.status.agent_in {
            return Err("no agent is in its panel");
        }
        match i.status.agent {
            "working" => return Err("it is at work"),
            "needs_you" => return Err("it has a prompt of its own open"),
            _ => {}
        }
        if !i.screen.bracketed_paste {
            return Err("it is not at its prompt");
        }
        if i.keyed.is_some_and(|t| t.elapsed() < PRESS_AFTER_KEYS) {
            return Err("you are typing in its panel");
        }
        let Some(p) = i.proc.as_ref() else {
            return Err("its panel is not running");
        };
        let tx = p.input.clone();
        if tx
            .send(format!("\x1b[200~{text}\x1b[201~").into_bytes())
            .is_err()
        {
            return Err("its panel is not running");
        }
        std::thread::spawn(move || {
            std::thread::sleep(PRESS_ENTER_AFTER);
            let _ = tx.send(b"\r".to_vec());
        });
        i.status.entered_at = crate::store::now();
        if i.status.blocked {
            i.status.blocked = false;
            i.status.blocked_since = None;
            let s = i.status.clone();
            let _ = self.tx.send(status_frame(&self.id, &s).into());
            drop(i);
            panes.changed(&self.id, &s);
        }
        Ok(())
    }
}
