//! The tool list, merged (1.67, plan f586a9fe09): 38 listed tools became 23.
//!
//! Claude Code defers a server's tool descriptions, so often a tool's name is
//! all an agent sees, and seven groups overlapped: three reads beside
//! `read_desk`, a tick beside the stages, five ways to suggest, four ways to
//! offer, a card cleared or a link pinned beside `show_card`, a look and an
//! export beside a board's read and arrange. Each group is one tool now, with
//! a `what`, a section or a flag, and each answers through the handler it
//! had: nothing a tool does changed, only how it is reached.
//!
//! The old names still answer for one release (`TOOLS`): a session that
//! started before the update has them in its list. They are not listed.

use super::{arg, said, Session};
use serde_json::{json, Map, Value};

/// The names no longer listed: each answers through the merged tool's way.
pub(super) const AWAY: [&str; 17] = [
    "read_desk_notes",
    "read_focus",
    "read_widgets",
    "tick_desk_note",
    "suggest_desk_note",
    "suggest_launch",
    "suggest_check",
    "suggest_panel",
    "suggest_desk",
    "offer_document",
    "offer_line",
    "offer_post",
    "offer_routine",
    "clear_card",
    "pin_link",
    "frame_look",
    "board_export",
];

/// The sections `read_desk` reads besides the desk's own (1.67): the notes,
/// where the user is, and the widgets. Read only when named.
const MORE: [&str; 3] = ["notes", "focus", "widgets"];

const READ: &str = "Read this snyvi desk before asking the user where things stand. By `sections`: notes (the \
user's desk notes, with ids and stages), threads, panels, folder (checkouts against main), decisions (open, \
answered, dropped; `query` finds one by its words), desks (the others, by name), focus (what the user has \
open: a board's selection, a file and lines), widgets. Left out: threads, panels, folder, decisions and desks. \
Read notes when the user refers to their list; focus before acting on \"this\".";

const MARK: &str = "Say how far you have got with one of the user's desk notes, by `id` (or `ids`), only when \
the user set you on it: `read` when understood; `planned` when the plan is sent (`about` its id; \
send_document's notes does it for you); `working` once they approved; `done` when it is finished and \
checked, with the `commit` it went into or the `evidence` URL, and `say`, one line of what changed for them \
to check. A done with neither is claimed, not checked. You can move a note back a stage.";

const SUGGEST: &str = "Suggest something the user decides on, by `what`. note: a line for this desk's notes \
(`text`, or dated `lines`; `desk` names another desk). launch: after a ship, its dated steps (`lines`, each \
with `due`; drafts by the skill's grow.md, you never post). check: up to five lines the user will try once \
a note is done (`note`, `texts`). panel: a command to open (`name`, `cmd`, `why`, `back`). desk: a folder \
that deserves one (`folder`, `why`). Nothing happens until they press.";

const OFFER: &str = "Offer something the user sends on their own press: this call sends and publishes nothing. \
By `what`: document, to a friend the desk brief lists (`to`, `id`; `review` asks them to review it); line, to \
a friend (`to`, `text`, at most 200 characters); post, a moment for the desk's page, never twice for the same \
thing (`title`, `text`, `about`); routine, work on a schedule or a watch, never cron, /loop or /schedule \
(`command`, `when`, `asked`, `tried`; read the skill's routine.md first).";

const CARD: &str = "Keep one thing in view on this desk's rail while you work, only when the user asked: a \
`text` card (a status, a count) or a `link` card (a dev server, a preview), with `id` to update it and `for` \
seconds to let it go; `pin`, a link that stays after this session (the live site, staging). `clear` with \
its `id` takes a card off. A figure kept current is a widget instead.";

/// The tools that took others in, specs built from the ones they had so a
/// field keeps the words it had. `friends`: a friend to offer to, so
/// `offer` lists document and line.
pub(super) fn specs(friends: bool) -> Vec<Value> {
    vec![
        read_spec(),
        mark_spec(),
        suggest_spec(),
        offer_spec(friends),
        card_spec(),
        board_read_spec(),
        board_arrange_spec(),
    ]
}

/// The properties of each old spec, into one: the first spelling of a name
/// wins, so a shared `text` or `lines` keeps one description.
fn union(specs: &[Value]) -> Map<String, Value> {
    let mut all = Map::new();
    for s in specs {
        if let Some(p) = s["inputSchema"]["properties"].as_object() {
            for (k, v) in p {
                all.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
    }
    all
}

fn with(spec: Value, description: &str, props: Map<String, Value>, required: Value) -> Value {
    let mut spec = spec;
    spec["description"] = json!(description);
    spec["inputSchema"]["properties"] = Value::Object(props);
    spec["inputSchema"]["required"] = required;
    if spec["inputSchema"]["required"] == json!([]) {
        spec["inputSchema"]
            .as_object_mut()
            .map(|o| o.remove("required"));
    }
    spec
}

fn named<'a>(specs: &'a [Value], name: &str) -> &'a Value {
    specs
        .iter()
        .find(|s| s["name"] == name)
        .unwrap_or(&Value::Null)
}

fn read_spec() -> Value {
    let old = super::desk::specs().remove(0);
    let mut props = union(std::slice::from_ref(&old));
    let mut sections: Vec<Value> = props["sections"]["items"]["enum"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    sections.extend(MORE.iter().map(|s| json!(s)));
    props["sections"]["items"]["enum"] = Value::Array(sections);
    props["sections"]["description"] = json!("Which to read.");
    with(old, READ, props, json!([]))
}

fn mark_spec() -> Value {
    let (mark, tick) = (super::mark_spec(), super::tick_spec());
    let mut props = union(&[mark.clone(), tick]);
    props.insert(
        "stage".into(),
        json!({ "type": "string", "enum": ["read", "planned", "working", "done"] }),
    );
    props.insert("about".into(), json!({ "type": "string", "description": "A document's id from send_document: the plan, with planned; the work, with done." }));
    with(mark, MARK, props, json!(["stage"]))
}

fn suggest_spec() -> Value {
    let checks = super::checks::specs();
    let threads = super::threads::specs();
    let parts = [
        super::suggest_spec(),
        super::launch_spec(),
        named(&checks, "suggest_check").clone(),
        named(&threads, "suggest_panel").clone(),
        named(&threads, "suggest_desk").clone(),
    ];
    let mut props = Map::new();
    props.insert(
        "what".into(),
        json!({ "type": "string", "enum": ["note", "launch", "check", "panel", "desk"] }),
    );
    props.extend(union(&parts));
    props.insert("desk".into(), json!({ "type": "string", "description": "With note: another desk, by its name, when the line is for work there (one `text`)." }));
    props["lines"]["description"] =
        json!("Dated lines as one set: a launch's steps, each with `due`.");
    let spec = json!({ "name": "suggest", "title": "Suggest something for the user to decide",
        "inputSchema": { "type": "object", "additionalProperties": false },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } });
    with(spec, SUGGEST, props, json!(["what"]))
}

fn offer_spec(friends: bool) -> Value {
    let page = super::page::specs();
    let mut parts = vec![super::routine_spec(), named(&page, "offer_post").clone()];
    let whats = if friends {
        parts.insert(0, super::offer_spec());
        parts.insert(1, super::offer_line_spec());
        vec!["document", "line", "post", "routine"]
    } else {
        vec!["post", "routine"]
    };
    let mut props = Map::new();
    props.insert("what".into(), json!({ "type": "string", "enum": whats }));
    props.extend(union(&parts));
    if friends {
        props.insert("text".into(), json!({ "type": "string", "description": "line: the line, at most 200 characters. post: a few lines in the maker's words." }));
    }
    let spec = json!({ "name": "offer", "title": "Offer something the user sends",
        "inputSchema": { "type": "object", "additionalProperties": false },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false } });
    with(spec, OFFER, props, json!(["what"]))
}

fn card_spec() -> Value {
    let cards = super::cards::specs();
    let show = named(&cards, "show_card").clone();
    let mut props = union(&[show.clone(), named(&cards, "pin_link").clone()]);
    props.insert(
        "kind".into(),
        json!({ "type": "string", "enum": ["text", "link", "pin"] }),
    );
    props.insert(
        "clear".into(),
        json!({ "type": "boolean", "description": "Take the card `id` off." }),
    );
    with(show, CARD, props, json!([]))
}

fn board_read_spec() -> Value {
    let specs = super::board::specs();
    let read = named(&specs, "board_read").clone();
    let mut props = union(std::slice::from_ref(&read));
    props.insert(
        "look".into(),
        json!({ "type": "string", "description": "A frame's id: see it as the window draws it, before saying it is done." }),
    );
    let d = read["description"].as_str().unwrap_or("").to_string();
    with(read, &d, props, json!([]))
}

fn board_arrange_spec() -> Value {
    let specs = super::board::specs();
    let arrange = named(&specs, "board_arrange").clone();
    let mut props = union(std::slice::from_ref(&arrange));
    props.insert(
        "export".into(),
        json!({ "type": "boolean", "description": "Make one HTML page of every shown section, in order: a file to keep or pass on." }),
    );
    let d = arrange["description"].as_str().unwrap_or("").to_string();
    with(arrange, &d, props, json!([]))
}

/// Several answers as one: their words one after another, an error if any
/// was, and each one's structured answer under its name.
fn joined(parts: Vec<(&str, Value)>) -> Value {
    let mut text = Vec::new();
    let mut structured = Map::new();
    let mut bad = false;
    for (name, v) in parts {
        bad |= v["isError"].as_bool().unwrap_or(false);
        if let Some(t) = v["content"][0]["text"].as_str() {
            text.push(t.to_string());
        }
        if let Some(s) = v.get("structuredContent") {
            structured.insert(name.to_string(), s.clone());
        }
    }
    let mut out =
        json!({ "content": [{ "type": "text", "text": text.join("\n\n") }], "isError": bad });
    if !structured.is_empty() {
        out["structuredContent"] = Value::Object(structured);
    }
    out
}

impl Session {
    /// `read_desk`, with the notes, focus and widgets as sections.
    pub(super) fn read_desk_all(&self, args: &Value) -> Value {
        let asked: Vec<String> = args
            .get("sections")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let more: Vec<&str> = MORE
            .iter()
            .copied()
            .filter(|m| asked.iter().any(|a| a == m))
            .collect();
        if more.is_empty() {
            return self.read_desk(args);
        }
        let rest: Vec<&String> = asked
            .iter()
            .filter(|a| !MORE.contains(&a.as_str()))
            .collect();
        let mut parts = Vec::new();
        if !rest.is_empty() || !arg(args, "query").is_empty() {
            let mut a = args.clone();
            a["sections"] = json!(rest);
            parts.push(("desk", self.read_desk(&a)));
        }
        for m in more {
            let v = match m {
                "notes" => self.read_desk_notes(&json!({})),
                "focus" => self.read_focus(&json!({})),
                _ => self.read_widgets(&json!({})),
            };
            parts.push((m, v));
        }
        joined(parts)
    }

    /// `mark_desk_note`, with done as a stage: the tick.
    pub(super) fn mark_or_tick(&self, args: &Value) -> Value {
        if arg(args, "stage") == "done" {
            self.tick_desk_note(args)
        } else {
            self.mark_desk_note(args)
        }
    }

    pub(super) fn suggest(&self, args: &Value) -> Value {
        match arg(args, "what").as_str() {
            "note" => self.suggest_desk_note(args),
            "launch" => self.suggest_launch(args),
            "check" => self.suggest_check(args),
            "panel" => self.suggest_panel(args),
            "desk" => self.suggest_desk(args),
            w => said(
                format!("suggest takes `what`: note, launch, check, panel or desk, not \"{w}\"."),
                true,
            ),
        }
    }

    pub(super) fn offer(&self, args: &Value) -> Value {
        match arg(args, "what").as_str() {
            "document" => self.offer_document(args),
            "line" => self.offer_line(args),
            "post" => self.offer_post(args),
            "routine" => self.offer_routine(args),
            w => said(
                format!("offer takes `what`: document, line, post or routine, not \"{w}\"."),
                true,
            ),
        }
    }

    /// `show_card`, with a pinned link and a clear.
    pub(super) fn card(&self, args: &Value) -> Value {
        if args.get("clear").and_then(Value::as_bool).unwrap_or(false) {
            return self.clear_card(args);
        }
        if arg(args, "kind") == "pin" {
            return self.pin_link(args);
        }
        self.show_card(args)
    }

    /// `board_read`, or one frame looked at.
    pub(super) fn board_read_or_look(&self, args: &Value) -> Value {
        let look = arg(args, "look");
        if look.is_empty() {
            return self.board_read(args);
        }
        self.frame_look(&json!({ "board": arg(args, "board"), "frame": look }))
    }

    /// `board_arrange`, and its export: arranged first when it moves
    /// anything, then exported.
    pub(super) fn arrange_or_export(&self, args: &Value) -> Value {
        if !args.get("export").and_then(Value::as_bool).unwrap_or(false) {
            return self.board_arrange(args);
        }
        let moves = ["frames", "name", "css"]
            .iter()
            .any(|k| args.get(*k).is_some());
        let export = self.board_export(&json!({ "board": arg(args, "board") }));
        if !moves {
            return export;
        }
        joined(vec![
            ("arrange", self.board_arrange(args)),
            ("export", export),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_merged_tool_keeps_the_fields_it_took_in() {
        let all = specs(true);
        let names: Vec<&str> = all.iter().filter_map(|s| s["name"].as_str()).collect();
        assert_eq!(
            names,
            [
                "read_desk",
                "mark_desk_note",
                "suggest",
                "offer",
                "show_card",
                "board_read",
                "board_arrange"
            ]
        );
        let props = |n: &str| named(&all, n)["inputSchema"]["properties"].clone();
        for k in ["commit", "evidence", "say", "ids"] {
            assert!(props("mark_desk_note").get(k).is_some(), "{k}");
        }
        for k in [
            "text", "lines", "due", "doc", "desk", "note", "texts", "cmd", "back", "folder",
        ] {
            assert!(props("suggest").get(k).is_some(), "{k}");
        }
        for k in [
            "to", "id", "review", "command", "when", "asked", "tried", "title", "about",
        ] {
            assert!(props("offer").get(k).is_some(), "{k}");
        }
        assert!(props("show_card").get("url").is_some());
        assert!(props("board_read").get("look").is_some());
        assert!(props("board_arrange").get("export").is_some());
        // No friend to offer to: the friends' ways are not listed.
        let lone = specs(false);
        let what = &named(&lone, "offer")["inputSchema"]["properties"]["what"]["enum"];
        assert_eq!(what, &json!(["post", "routine"]));
        assert!(named(&lone, "offer")["inputSchema"]["properties"]
            .get("review")
            .is_none());
    }

    #[test]
    fn a_merged_tool_says_what_it_takes_when_what_is_wrong() {
        let s = Session {
            paths: crate::config::paths(),
            cwd: None,
            key: String::new(),
            pane: None,
            sender: None,
        };
        let out = s.suggest(&json!({ "what": "song" }));
        assert_eq!(out["isError"], true);
        assert!(out["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("note, launch, check, panel or desk"));
        let out = s.offer(&json!({}));
        assert_eq!(out["isError"], true);
    }
}
