//! `offer_post` (1.59, docs/WALL.md): the agent's door onto the desk's
//! page. It puts a card in the desk's corner -- *Have a look · Not now* --
//! and nothing else. The page, what is on it, and whether anything leaves
//! are the user's, pressed in the Page view; a token never publishes.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

/// Written as notes for a colleague: when it is worth a card, and when not.
const POST: &str = "Offer something that shipped to this snyvi desk's page: a card in the desk's corner says \
your words, and the user's Have a look opens their page with it as a moment, where they decide whether it \
goes on the wall. Nothing is published by this call. Once per thing that shipped -- a chapter accepted, a \
release, a clip worth showing -- never after a step, never twice for the same thing, never for a plan. Write \
it in the maker's words, short: what happened and why it matters, one picture or clip at most. `about` is what \
it is about, and the key: a document's id, a path in the desk's folder, gallery ids, or the thread's name; a \
second call about the same thing updates the card rather than making another.";

pub(super) fn specs() -> Vec<Value> {
    vec![json!({
        "name": "offer_post",
        "title": "Offer a moment for the desk's page",
        "description": POST,
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "maxLength": 60, "description": "What happened, as a headline: \"Chapter 4 is in\"." },
                "text": { "type": "string", "maxLength": 2000, "description": "A few lines in the maker's words." },
                "about": { "type": "string", "description": "What it is about: a document id, a path, gallery ids, or the thread's name." }
            },
            "required": ["title", "about"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })]
}

impl Session {
    pub(super) fn offer_post(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no page to offer to.",
                true,
            );
        };
        let (title, text, about) = (arg(args, "title"), arg(args, "text"), arg(args, "about"));
        if title.trim().is_empty() || about.trim().is_empty() {
            return said("offer_post needs a title and what it is about.", true);
        }
        match client::offer_post(&self.paths, p, &title, &text, &about, self.by()) {
            Ok(said_) => said(format!("{said_}. Say so in your reply."), false),
            Err(e) => said(format!("snyvi did not take the offer: {e}"), true),
        }
    }
}
