//! suggest_check (1.58, H2.1): checks the user will hold against a note --
//! one line each of what they will try once the work is done
//! (`crate::desk::checks`). The agent may suggest them while it plans; it is
//! never shown them again. `read_desk_notes` says only how many are held.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const SUGGEST: &str = "Suggest checks the user will hold against one of their notes: each one line under 160 characters, in their \
terms, of what they will try once the work is done (\"after Download I can see where the file went\"), not a \
test you will run. Offer them when you plan the note. They wait beside it until the user keeps or removes \
them, and you are not shown them again, only how many are held. A failed check reopens the note. At most 5 \
per call, 3 waiting on a note.";

pub(super) fn specs() -> Vec<Value> {
    vec![json!({
        "name": "suggest_check", "title": "Suggest checks for a note", "description": SUGGEST,
        "inputSchema": { "type": "object", "properties": {
            "note": { "type": "integer", "description": "The note's id, from read_desk_notes." },
            "texts": { "type": "array", "maxItems": 5, "items": { "type": "string" },
                "description": "One to five checks, each one line under 160 characters." }
        }, "required": ["note", "texts"], "additionalProperties": false },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })]
}

impl Session {
    pub(super) fn suggest_check(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no note to suggest checks for.",
                true,
            );
        };
        let Some(note) = args.get("note").and_then(Value::as_i64) else {
            return said(
                "suggest_check needs `note`, the note's id from read_desk_notes.",
                true,
            );
        };
        let mut texts: Vec<Value> = args
            .get("texts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let one = arg(args, "text");
        if !one.is_empty() {
            texts.push(json!(one));
        }
        let body = json!({ "texts": texts, "by": self.by() });
        match client::pane_thread(&self.paths, p, &format!("notes/{note}/suggest-check"), body) {
            Ok(r) => {
                let n = |k: &str| r.get(k).and_then(Value::as_u64).unwrap_or(0);
                let refused = match n("refused") {
                    0 => String::new(),
                    k => format!(" {k} did not fit (5 a call, 3 waiting on a note, 7 held)."),
                };
                said(
                    format!(
                        "{} suggested on note {note}; the user keeps or removes them, and you will not see which.{refused} It holds {} checks now.",
                        n("suggested"),
                        n("checks_held")
                    ),
                    n("suggested") == 0,
                )
            }
            Err(e) => said(format!("snyvi did not take the checks: {e}"), true),
        }
    }
}
