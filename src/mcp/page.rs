//! `offer_post` (1.59, docs/WALL.md): the agent's door onto the desk's
//! page. It puts a card in the desk's corner -- *Have a look · Not now* --
//! and nothing else. And `page_draft` (1.62, views audit e512285a2b): the
//! page's words, filled in when the user asked Claude to build it. Whether
//! anything leaves is the user's, pressed in the Page view; a token never
//! publishes, never says who sees it and never names its address.

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

/// When to fill the page, and what each field is for.
const DRAFT: &str = "Fill this snyvi desk's page, its landing page, with words: only when the user asked you to build or \
update it (the Page view's Ask Claude types that for them). Read the project first -- the README, what it does, \
who it is for -- and write as its maker would, plainly, no hype. `title` is the name; `lede` one or two lines on \
what it is and for whom; `cta` the one main link (an https:// URL and a button's few words: \"Try the beta\"); \
`points` three short reasons, each a title and a line; `story` a few paragraphs on why it is being built, in the \
first person, blank lines between. `cover` and `logo` are paths of pictures in the desk's folder (take a \
screenshot of the work into the folder first if there is none). Every field is optional; one left out stays as \
it is. A page that does not exist yet is started. Nothing is published, and who sees it and its address stay \
the user's: tell them it is ready to look at in Page, and that Publish is theirs.";

pub(super) fn specs() -> Vec<Value> {
    let link = json!({
        "type": "object",
        "properties": { "label": { "type": "string", "maxLength": 40 }, "url": { "type": "string", "maxLength": 300 } },
        "required": ["label", "url"],
        "additionalProperties": false
    });
    vec![
        json!({
            "name": "page_draft",
            "title": "Fill the desk's page",
            "description": DRAFT,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": 80, "description": "The name." },
                    "lede": { "type": "string", "maxLength": 400, "description": "One or two lines: what it is, for whom." },
                    "kind": { "type": "string", "maxLength": 40, "description": "What it is, in two or three words: \"desktop app\"." },
                    "stage": { "type": "string", "maxLength": 40, "description": "How far: \"beta, 40 testers\"." },
                    "looking_for": { "type": "string", "maxLength": 120, "description": "What would help, if the user said: testers, an illustrator." },
                    "cta": link.clone(),
                    "points": {
                        "type": "array", "maxItems": 3,
                        "items": {
                            "type": "object",
                            "properties": { "title": { "type": "string", "maxLength": 60 }, "text": { "type": "string", "maxLength": 200 } },
                            "required": ["title"],
                            "additionalProperties": false
                        }
                    },
                    "story": { "type": "string", "maxLength": 4000, "description": "Why it is being built, a few paragraphs, blank lines between." },
                    "links": { "type": "array", "maxItems": 6, "items": link },
                    "github": { "type": "string", "maxLength": 300, "description": "The repository's https:// URL." },
                    "cover": { "type": "string", "description": "A picture in the desk's folder, by path: the hero's." },
                    "logo": { "type": "string", "description": "The mark, by path in the desk's folder: a PNG or SVG sets the accent too." }
                },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
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
        }),
    ]
}

/// What `page_draft` passes on: the fields it was given, and only those.
const DRAFT_FIELDS: [&str; 12] = [
    "title",
    "lede",
    "kind",
    "stage",
    "looking_for",
    "cta",
    "points",
    "story",
    "links",
    "github",
    "cover",
    "logo",
];

impl Session {
    pub(super) fn page_draft(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no page to fill.",
                true,
            );
        };
        let body: serde_json::Map<String, Value> = DRAFT_FIELDS
            .iter()
            .filter_map(|k| args.get(*k).map(|v| (k.to_string(), v.clone())))
            .collect();
        if body.is_empty() {
            return said("page_draft needs at least one field.", true);
        }
        match client::pane_page_draft(&self.paths, p, Value::Object(body)) {
            Ok(said_) => said(said_, false),
            Err(e) => said(format!("snyvi did not take the page's words: {e}"), true),
        }
    }

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
