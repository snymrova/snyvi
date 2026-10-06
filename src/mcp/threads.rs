//! The #90 tools, for an agent in a desk's panel: start_thread and
//! move_thread file a piece of work, ask and hand_over put what only the
//! reader can do on Your turn, and suggest_panel and suggest_desk offer a
//! card the reader clicks or not (`crate::thread`). Each description is kept
//! short: all six are in every panel session's tool list.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const START: &str = "File a piece of work on this snyvi desk as a thread: a name, the desk notes it answers (ids \
from read_desk_notes), and the folder it lives in. Call it when you take the work on. The same name again \
updates that thread instead of making a second. It becomes this panel's thread.";

const MOVE: &str = "Move this panel's thread: a stage (idea, planned, building, review, waiting, shipped, \
parked), and with parked the next step to pick it up by. Add a PR number or more note ids. Call it when the \
work changes stage, not every turn.";

const ASK: &str = "Put a decision on the user's Your turn in snyvi: a question, two to four short options, and \
the one you recommend. It does not wait: the answer comes with the user's next message, and it is kept on \
the thread as decided. Prefer your own question tool when the user is at this panel.";

const HAND_OVER: &str = "Put what only the user can do on their Your turn in snyvi: try (try a change), merge (a PR), key (add a \
key), or run (a command you were blocked from running: pass cmd, one line; their Run types it here as a \
! command and its output comes back to you). Never ask them to paste a command. One sentence, and a link \
if there is one.";

const SUGGEST_PANEL: &str = "Suggest a panel on this desk: a name, the exact command it would run, and why. \
The user sees a card with the command and opens it or not; nothing runs until they click. Three wait at \
most.";

const SUGGEST_DESK: &str = "Suggest a desk for another folder: the folder's path and why it deserves its \
own desk. The user sees a card and opens it or not. A folder that already has a desk is not suggested; you \
are told which desk it is.";

pub(super) fn specs() -> Vec<Value> {
    let ann = |idem: bool| json!({ "readOnlyHint": false, "destructiveHint": false, "idempotentHint": idem, "openWorldHint": false });
    let notes = json!({ "type": "array", "items": { "type": "integer" }, "description": "Desk note ids, from read_desk_notes." });
    vec![
        json!({
            "name": "start_thread", "title": "Start a thread", "description": START,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "A few words, at most 60 characters." },
                "notes": notes,
                "folder": { "type": "string", "description": "The folder or worktree the work is in." },
                "stage": { "type": "string", "enum": crate::thread::STAGES, "description": "Default planned." }
            }, "required": ["name"], "additionalProperties": false },
            "annotations": ann(true)
        }),
        json!({
            "name": "move_thread", "title": "Move this panel's thread", "description": MOVE,
            "inputSchema": { "type": "object", "properties": {
                "stage": { "type": "string", "enum": crate::thread::STAGES },
                "next": { "type": "string", "description": "The next step, for parked." },
                "pr": { "type": "string", "description": "The PR's number." },
                "notes": notes
            }, "additionalProperties": false },
            "annotations": ann(true)
        }),
        json!({
            "name": "ask", "title": "Ask the user to decide", "description": ASK,
            "inputSchema": { "type": "object", "properties": {
                "question": { "type": "string", "description": "One sentence." },
                "options": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 4, "description": "Short labels." },
                "recommended": { "type": "integer", "description": "The index of the option you recommend, from 0." }
            }, "required": ["question", "options"], "additionalProperties": false },
            "annotations": ann(false)
        }),
        json!({
            "name": "hand_over", "title": "Hand something to the user", "description": HAND_OVER,
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string", "description": "One sentence: what to do." },
                "kind": { "type": "string", "enum": ["try", "merge", "key", "run"] },
                "link": { "type": "string", "description": "A URL or a port, if there is one." },
                "cmd": { "type": "string", "description": "run only: one command line, exactly as it should run." }
            }, "required": ["text", "kind"], "additionalProperties": false },
            "annotations": ann(false)
        }),
        json!({
            "name": "suggest_panel", "title": "Suggest a panel", "description": SUGGEST_PANEL,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "cmd": { "type": "string", "description": "One command line, exactly as it should run." },
                "why": { "type": "string", "description": "One sentence." }
            }, "required": ["name", "cmd", "why"], "additionalProperties": false },
            "annotations": ann(false)
        }),
        json!({
            "name": "suggest_desk", "title": "Suggest a desk", "description": SUGGEST_DESK,
            "inputSchema": { "type": "object", "properties": {
                "folder": { "type": "string", "description": "An absolute path." },
                "why": { "type": "string", "description": "One sentence." }
            }, "required": ["folder", "why"], "additionalProperties": false },
            "annotations": ann(false)
        }),
    ]
}

/// A thread in one line, as the agent is told it back.
fn card(t: &Value) -> String {
    let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut parts = vec![s("name"), s("stage")];
    let notes: Vec<String> = t
        .get("notes")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_i64)
                .map(|n| format!("#{n}"))
                .collect()
        })
        .unwrap_or_default();
    if !notes.is_empty() {
        parts.push(notes.join(" "));
    }
    for k in ["folder", "branch"] {
        if !s(k).is_empty() {
            parts.push(s(k));
        }
    }
    if !s("pr").is_empty() {
        parts.push(format!("PR {}", s("pr")));
    }
    if !s("next").is_empty() {
        parts.push(format!("next: {}", s("next")));
    }
    parts.join(" · ")
}

fn notes_arg(args: &Value) -> Vec<i64> {
    args.get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

const NO_DESK: &str =
    "This session is not running in a snyvi desk, so there is no desk to file it on.";

impl Session {
    fn thread_call(&self, path: &str, body: Value) -> Result<Value, Value> {
        let Some(p) = self.pane.as_deref() else {
            return Err(said(NO_DESK, true));
        };
        client::pane_thread(&self.paths, p, path, body)
            .map_err(|e| said(format!("snyvi did not take it: {e}"), true))
    }

    pub(super) fn start_thread(&self, args: &Value) -> Value {
        let body = json!({
            "name": arg(args, "name"), "notes": notes_arg(args), "folder": arg(args, "folder"),
            "stage": arg(args, "stage"), "by": self.by(),
        });
        match self.thread_call("thread", body) {
            Ok(v) => {
                let again = v.get("again").and_then(Value::as_bool) == Some(true);
                said(
                    format!(
                        "{} the thread: {}. It is this panel's thread; move it with move_thread.",
                        if again { "Picked up" } else { "Started" },
                        card(&v["thread"])
                    ),
                    false,
                )
            }
            Err(e) => e,
        }
    }

    pub(super) fn move_thread(&self, args: &Value) -> Value {
        let body = json!({
            "stage": arg(args, "stage"), "next": arg(args, "next"), "pr": arg(args, "pr"),
            "notes": notes_arg(args),
        });
        match self.thread_call("thread/move", body) {
            Ok(v) => said(format!("Moved: {}.", card(&v["thread"])), false),
            Err(e) => e,
        }
    }

    pub(super) fn ask(&self, args: &Value) -> Value {
        let body = json!({
            "kind": "decide", "text": arg(args, "question"),
            "options": args.get("options").cloned().unwrap_or(json!([])),
            "recommended": args.get("recommended").and_then(Value::as_i64).unwrap_or(-1),
            "by": self.by(),
        });
        match self.thread_call("ask", body) {
            Ok(_) => said("Asked. It is on the user's Your turn in snyvi; the answer comes with their next message. Carry on with what does not depend on it.", false),
            Err(e) => e,
        }
    }

    pub(super) fn hand_over(&self, args: &Value) -> Value {
        let body = json!({
            "kind": arg(args, "kind"), "text": arg(args, "text"), "link": arg(args, "link"),
            "cmd": arg(args, "cmd"), "by": self.by(),
        });
        let run = arg(args, "kind") == "run";
        match self.thread_call("handover", body) {
            Ok(_) if run => said("Handed over. When the user clicks Run, it is typed into this panel as a ! command, and its output arrives here as their message. Say so in your reply; do not ask them to paste it.", false),
            Ok(_) => said("Handed over. It is on the user's Your turn in snyvi; their answer comes with their next message. Say so in your reply.", false),
            Err(e) => e,
        }
    }

    pub(super) fn suggest_panel(&self, args: &Value) -> Value {
        let body = json!({
            "kind": "panel", "name": arg(args, "name"), "cmd": arg(args, "cmd"), "why": arg(args, "why"),
            "by": self.by(),
        });
        match self.thread_call("suggest-panel", body) {
            Ok(_) => said(
                "Suggested; the user opens it or not. Mention it in your reply.",
                false,
            ),
            Err(e) => e,
        }
    }

    pub(super) fn suggest_desk(&self, args: &Value) -> Value {
        let body = json!({
            "kind": "desk", "folder": arg(args, "folder"), "why": arg(args, "why"), "by": self.by(),
        });
        match self.thread_call("suggest-desk", body) {
            Ok(_) => said(
                "Suggested; the user opens it or not. Mention it in your reply.",
                false,
            ),
            Err(e) => e,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six tools in every panel session: each says what it does in a few
    /// lines, takes only what it names, and none is destructive.
    #[test]
    fn the_six_are_short_and_take_only_what_they_name() {
        let specs = specs();
        assert_eq!(specs.len(), 6);
        for s in &specs {
            let d = s["description"].as_str().unwrap();
            assert!(d.len() <= 350, "{}: {} chars", s["name"], d.len());
            assert_eq!(s["inputSchema"]["additionalProperties"], false);
            assert_eq!(s["annotations"]["destructiveHint"], false);
            assert!(super::super::TOOLS.iter().any(|(n, _)| *n == s["name"]));
        }
    }

    #[test]
    fn a_thread_is_told_back_in_one_line() {
        let t = json!({ "name": "Home + friends", "stage": "building", "notes": [87, 91],
                        "branch": "claude/asides", "pr": "57" });
        assert_eq!(
            card(&t),
            "Home + friends · building · #87 #91 · claude/asides · PR 57"
        );
    }
}
