//! next_work (1.67, the line, plan f586a9fe09): the next note of this desk's
//! queue, claimed for this panel (`crate::desk::line`). The user orders the
//! queue and presses Start next; an agent only takes what is next.

use super::{said, Session};
use crate::client;
use serde_json::{json, Value};

const NEXT: &str = "Take the next note from this desk's line: the user's goal and their ordered queue. Call it \
when the user says to work the line, or when snyvi started this panel for a note. It answers one note, claimed \
for this panel, with its done-when command if the user gave one; again, the same note until you tick it. Work \
it as any note: read, plan, wait for Approve, working, run its done-when yourself, tick with the commit. It \
never reorders the queue or starts an agent.";

pub(super) fn specs() -> Vec<Value> {
    vec![json!({
        "name": "next_work", "title": "Take the next note in the line", "description": NEXT,
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })]
}

/// What `next_work` says for the daemon's answer.
fn say(r: &Value) -> String {
    let s = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let Some(w) = r.get("work").filter(|w| w.is_object()) else {
        let goal = s(r, "goal");
        let goal = if goal.is_empty() {
            String::new()
        } else {
            format!(" The goal is \"{goal}\".")
        };
        return format!(
            "Nothing in this desk's line is free: every queued note is done or another panel has it.{goal} Say so and stop; the user orders the queue."
        );
    };
    let id = w.get("id").and_then(Value::as_i64).unwrap_or(0);
    let left = w.get("left").and_then(Value::as_i64).unwrap_or(0);
    let mut out = if w.get("held").and_then(Value::as_bool).unwrap_or(false) {
        format!("Note #{id} is still yours: {}", s(w, "text"))
    } else {
        format!("Note #{id} is yours now: {}", s(w, "text"))
    };
    let goal = s(w, "goal");
    if !goal.is_empty() {
        out.push_str(&format!("\nThe desk's goal: {goal}"));
    }
    let when = s(w, "done_when");
    if when.is_empty() {
        out.push_str("\nNo done-when command is set: say in your tick what you checked.");
    } else {
        out.push_str(&format!(
            "\nDone when this passes (the user's command; run it yourself before you tick): {when}"
        ));
    }
    let tree = s(w, "tree");
    if !tree.is_empty() {
        out.push_str(&format!(
            "\nIts worktree: {tree}. Work there, on its branch; build to a target of its own."
        ));
    }
    out.push_str(&format!(
        "\n{left} open in the line. Next: mark_desk_note read, then the plan with send_document's notes, and wait for Approve."
    ));
    out
}

impl Session {
    pub(super) fn next_work(&self, _args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no line to take work from.",
                true,
            );
        };
        match client::pane_thread(&self.paths, p, "next-work", json!({})) {
            Ok(r) => json!({
                "content": [{ "type": "text", "text": say(&r) }],
                "structuredContent": r,
                "isError": false
            }),
            Err(e) => said(format!("snyvi did not give the next note: {e}"), true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::say;
    use serde_json::json;

    #[test]
    fn next_work_says_the_note_its_command_and_what_comes_next() {
        let got = say(
            &json!({ "work": { "id": 250, "text": "Back chip says working", "goal": "Home is the floor",
            "done_when": "node bench/ui.mjs back", "tree": "/w/snyvi-250", "held": false, "left": 3 } }),
        );
        assert!(got.starts_with("Note #250 is yours now: Back chip says working"));
        assert!(got.contains("node bench/ui.mjs back"));
        assert!(got.contains("/w/snyvi-250"));
        assert!(got.contains("3 open in the line"));
        let none = say(&json!({ "work": null, "goal": "Home is the floor" }));
        assert!(none.starts_with("Nothing in this desk's line is free"));
        assert!(none.contains("\"Home is the floor\""));
    }
}
