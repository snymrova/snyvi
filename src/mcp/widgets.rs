//! set_widget: a small box in this desk's rail that an agent keeps up to
//! date -- "deploy 3/5", a test run's count, a port that is up -- without
//! a turn of the user's to ask for it (`crate::widget`, docs/WIDGETS.md).
//! propose_widget: a widget file the user adds or not, for a status that
//! should outlive the session: snyvi runs its command on a timer.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const SET: &str = "Show a small status box in this snyvi desk's rail, kept up to date as the work goes: a name, \
and a short Markdown body (\"**deploy** 3/5 green\"). The same name again replaces it; an empty body clears it. \
Optional: tone (ok, warn, bad) colours the count, count is a short figure shown even when the box is folded, \
lines is its height (1-6), stale_after the seconds before it dims as old (default 1800). For a status worth \
glancing at, not for news: news is a document.";

const PROPOSE: &str = "Propose a widget file to the user, for a status worth keeping after this session ends: \
snyvi runs its command on a timer while the widget is in view and shows what it prints (Markdown, or \
{\"body\",\"tone\",\"count\"} JSON). The user gets a card with the command and adds it or not; nothing runs \
before. scope desk runs it in the desk's folder on that desk's rail; global on the left, everywhere. Give the \
script whole (it gets the desk and settings as JSON on stdin) and a command that runs it, e.g. ./run.sh.";

pub(super) fn specs() -> Vec<Value> {
    vec![
        json!({
            "name": "propose_widget", "title": "Propose a widget", "description": PROPOSE,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "Lowercase letters, digits and dashes, at most 32." },
                "title": { "type": "string" },
                "scope": { "type": "string", "enum": ["desk", "global"] },
                "command": { "type": "string", "description": "One line, run with sh -c (cmd /C on Windows) in the widget's folder or the desk's." },
                "every": { "type": "integer", "minimum": 5, "description": "Seconds between runs (60)." },
                "timeout": { "type": "integer", "minimum": 1, "maximum": 30 },
                "lines": { "type": "integer", "minimum": 1, "maximum": 6 },
                "script_name": { "type": "string", "description": "The script's file name, e.g. run.sh." },
                "script": { "type": "string", "description": "The script, whole, at most 16 KB." },
                "why": { "type": "string", "description": "One sentence." }
            }, "required": ["name", "command", "why"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "set_widget", "title": "Set a widget", "description": SET,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "Lowercase letters, digits and dashes, at most 32." },
                "body": { "type": "string", "description": "Markdown, at most 1500 characters. Empty clears." },
                "tone": { "type": "string", "enum": ["ok", "warn", "bad", "none"] },
                "count": { "type": "string", "description": "At most 8 characters: 3, !2, 3/5." },
                "lines": { "type": "integer", "minimum": 1, "maximum": 6 },
                "stale_after": { "type": "integer", "minimum": 0, "description": "Seconds; 0 is never." }
            }, "required": ["name", "body"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
    ]
}

impl Session {
    pub(super) fn propose_widget(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no one to propose it to.",
                true,
            );
        };
        let mut body = args.clone();
        body["by"] = json!(self.by());
        match client::pane_thread(&self.paths, p, "propose-widget", body) {
            Ok(_) => said(
                format!("Proposed. The user has a card on their Your turn in snyvi with the command; nothing runs until they add {}. Carry on.", arg(args, "name")),
                false,
            ),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }

    pub(super) fn set_widget(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no rail to put it in.",
                true,
            );
        };
        let name = arg(args, "name");
        let mut body = json!({ "body": args.get("body").and_then(Value::as_str).unwrap_or("") });
        for k in ["tone", "count", "lines", "stale_after"] {
            if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
                body[k] = v.clone();
            }
        }
        let cleared = body["body"].as_str().is_some_and(|b| b.trim().is_empty());
        match client::pane_thread(&self.paths, p, "widget", json!({ "name": name, "body": body })) {
            Ok(_) if cleared => said(format!("Cleared the widget {name}."), false),
            Ok(_) => said(
                format!("The widget {name} is in this desk's rail. Set it again with the same name to update it; an empty body clears it."),
                false,
            ),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }
}
