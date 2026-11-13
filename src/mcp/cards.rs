//! show_card and clear_card: the small things above the rail's foot while
//! this panel has focus (`crate::card`, #162) -- a link to where the work
//! can be seen, or a word on where it is -- each for as long as it says.
//! A widget is the desk's lasting figure; a card is the panel's passing word.
//! pin_link: the desk's lasting doorways, in the rail's foot itself
//! (`crate::links`) -- the live site, a preview, a dashboard.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const SHOW: &str = "Show a small card above the rail's foot while this panel has focus: `kind` link, with a label and url, for a \
place the user will want while you work (a preview, a deploy, a CI run); or `kind` text for progress worth a \
glance (\"Building 3/7\"), with `tone` and `for`, the seconds it stays. Send the same `id` again to update \
it in place. Never a paragraph or something the user must do (hand_over); a figure for the whole desk is \
set_widget. A card the user closed stays closed.";

const PIN: &str = "Pin a link in the rail's foot of this desk: a place its work lives that the user will want one click away on \
any day (the live site, a staging deploy that stays, a dashboard, the docs). It stays until the user takes \
it out. Pin the same url again to change its label. For a place that matters only while you work (a dev \
server, a CI run), use show_card. The repository and the thread's PR are shown already. Never one to \
something they must do (hand_over).";

const CLEAR: &str =
    "Take a card you showed with show_card off the rail's foot, by its id: when the link is \
no longer useful or the word no longer true.";

pub(super) fn specs() -> Vec<Value> {
    vec![
        json!({
            "name": "show_card", "title": "Show a card", "description": SHOW,
            "inputSchema": { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["link", "text"] },
                "label": { "type": "string", "description": "One line: at most 32 characters for a link, 80 for text." },
                "url": { "type": "string", "description": "For a link: http or https, this machine included (http://127.0.0.1:7801)." },
                "id": { "type": "string", "description": "Letters, digits, - and _, at most 32. The same id updates the card." },
                "tone": { "type": "string", "enum": ["run", "ok", "warn", "bad", "none"] },
                "for": { "type": "integer", "minimum": 10, "maximum": 3600, "description": "Seconds it stays. Leave it out to keep it while this session runs." }
            }, "required": ["kind", "label"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "pin_link", "title": "Pin a link", "description": PIN,
            "inputSchema": { "type": "object", "properties": {
                "label": { "type": "string", "description": "What it is, at most 32 characters: \"Live site\", \"Staging\"." },
                "url": { "type": "string", "description": "http or https." }
            }, "required": ["label", "url"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "clear_card", "title": "Clear a card", "description": CLEAR,
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" }
            }, "required": ["id"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
    ]
}

impl Session {
    pub(super) fn show_card(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no rail to show a card in.",
                true,
            );
        };
        let mut body = json!({ "kind": arg(args, "kind"), "label": arg(args, "label") });
        for k in ["url", "id", "tone", "for"] {
            if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
                body[k] = v.clone();
            }
        }
        match client::pane_thread(&self.paths, p, "card", body) {
            Ok(r) if r.get("closed").and_then(Value::as_bool) == Some(true) => said(
                "The user closed this card with its ✕, so it stays out of view for this session. Don't put it again; if something about it needs them, say so in your reply.",
                false,
            ),
            Ok(_) => said(
                match args.get("id").and_then(Value::as_str) {
                    Some(id) => format!("The card {id} is above the rail's foot while this panel has focus. Send the same id to update it; clear_card takes it off."),
                    None => "The card is above the rail's foot while this panel has focus.".to_string(),
                },
                false,
            ),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }

    pub(super) fn pin_link(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no rail to pin a link in.",
                true,
            );
        };
        let body = json!({ "label": arg(args, "label"), "url": arg(args, "url"), "by": self.by() });
        match client::pane_thread(&self.paths, p, "links", body) {
            Ok(r) if r.get("hidden").and_then(Value::as_bool) == Some(true) => said(
                "The user took this link out of the rail's foot with its ✕, so it stays out. Don't pin it again.",
                false,
            ),
            Ok(r) => said(
                format!(
                    "The link is in the rail's foot of the desk {}. Pin the same url to change its label.",
                    r.get("desk").and_then(Value::as_str).unwrap_or("")
                ),
                false,
            ),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }

    pub(super) fn clear_card(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so it has no cards.",
                true,
            );
        };
        let id = arg(args, "id");
        match client::pane_thread(&self.paths, p, "card", json!({ "id": id, "clear": true })) {
            Ok(_) => said(format!("The card {id} is off the rail."), false),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }
}
