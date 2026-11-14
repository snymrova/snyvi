//! The #90 tools, for an agent in a desk's panel: start_thread and
//! move_thread file a piece of work, ask puts a decision in the reader's
//! Waiting and hand_over a chore in their To do, settle takes the agent's
//! own back off, and suggest_panel and suggest_desk offer a card the reader
//! clicks or not (`crate::thread`). Each description is kept short: all
//! seven are in every panel session's tool list.
//!
//! 1.66 (plan e7fda1ca90): one door each. `hand_over` has no kind -- snyvi
//! reads it from what is given, and `try` is gone, since "try this" is a
//! question (0 of 7 were answered as a chore) -- and `settle` is the one way
//! back off, where `settle_asks` and `remove_card` were two. A session from
//! before 1.66 still has those names; they answer as before.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const START: &str = "File a piece of work on this snyvi desk as a thread: a name, the desk notes it answers (ids \
from read_desk_notes), and the folder it lives in. Call it when you take the work on. The same name again \
updates that thread instead of making a second. It becomes this panel's thread, and the one before it \
rests: move it to shipped first if it is done.";

const MOVE: &str = "Move this panel's thread: a stage (idea, planned, building, review, waiting, shipped, \
parked), and with parked the next step to pick it up by. Add a PR number or more note ids. Call it when the \
work changes stage. Shipped, then told with url once the user posts it and says where: you never post, you \
draft.";

const ASK: &str = "Ask the user to decide, when you are stuck on it: a question, two to four short options, the \
one you recommend; up to four at once as questions. It goes to their Waiting. Their press is typed into this \
panel as your next message, so stop after asking unless other work does not depend on it. about: the document \
it is asked under. At this panel, your own question tool.";

const HAND_OVER: &str = "Hand the user what only they can do and blocks you: a PR to merge (its link), a key to add \
(key: its name), a command you were blocked from (cmd, one line, or steps: their Run types it here and you get \
its output), or anything else (pay, sign in, post). It goes to their To do and stays until they say Done or \
Can't. One sentence. Never ask them to paste a command.";

/// `hand_over`'s description is at its 350 (the test below), so a run in
/// steps (#164) is explained on its own field, which the agent reads as well.
const STEPS: &str = "In place of cmd, when it takes several commands or things done by hand between \
them (a setup, a device to plug in): one run with steps, never commands written in your reply. Each step a cmd \
(one line) or a say (a thing done by hand), at most 12. They run each with a click, in order, here or in a \
shell of its own when it asks for a password (sudo), and tick each done.";

const SETTLE: &str = "Take your own things off the user's lists. With answers: the questions their message here \
answered, each by id with their words, kept as the decision. With ids and why: cards no longer on them (it is \
done, a newer one asks it, they said so here); never only because it is old. Each removal shows in their News \
with Undo.";

const SUGGEST_PANEL: &str = "Suggest a panel on this desk: a name, the exact command it would run, and why. \
The user sees a card with the command and opens it or not; nothing runs until they click. Three wait at \
most. back: true for something that runs and is not read, a dev server or a watcher: it opens in the back, \
out of the grid, and the user is told if it dies.";

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
                "stage": { "type": "string", "enum": crate::thread::STAGES.iter().chain(&["told"]).collect::<Vec<_>>() },
                "next": { "type": "string", "description": "The next step, for parked." },
                "url": { "type": "string", "description": "With told: where the user posted or released it." },
                "pr": { "type": "string", "description": "The PR's number." },
                "notes": notes
            }, "additionalProperties": false },
            "annotations": ann(true)
        }),
        json!({
            "name": "ask", "title": "Ask the user to decide", "description": ASK,
            "inputSchema": { "type": "object", "properties": {
                "question": { "type": "string", "description": "One sentence. Or pass questions instead." },
                "options": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 4, "description": "Short labels." },
                "recommended": { "type": "integer", "description": "The index of the option you recommend, from 0." },
                "questions": { "type": "array", "minItems": 1, "maxItems": 4, "description": "Several decisions at once, as one card, in place of question, options and recommended.",
                    "items": { "type": "object", "properties": {
                        "question": { "type": "string", "description": "One sentence." },
                        "options": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 4, "description": "Short labels." },
                        "recommended": { "type": "integer", "description": "The index of the option you recommend, from 0." }
                    }, "required": ["question", "options"], "additionalProperties": false } },
                "about": { "type": "string", "description": "The id of the document the question is asked under, from send_document." },
                "replaces": { "type": "integer", "description": "The id of a card of yours this one asks again, changed: it is taken off, with every question on it, as this goes on. The same question in the same words is never asked twice: it is folded into its card." }
            }, "additionalProperties": false },
            "annotations": ann(false)
        }),
        json!({
            "name": "hand_over", "title": "Hand something to the user", "description": HAND_OVER,
            "inputSchema": { "type": "object", "properties": {
                "text": { "type": "string", "description": "One sentence: what to do." },
                "link": { "type": "string", "description": "A URL or a port, if there is one: a PR's link makes it a merge." },
                "cmd": { "type": "string", "description": "A command you were blocked from: one line, exactly as it should run." },
                "steps": { "type": "array", "maxItems": 12, "description": STEPS, "items": { "type": "object", "properties": {
                    "cmd": { "type": "string", "description": "One command line, exactly as it should run." },
                    "say": { "type": "string", "description": "A thing done by hand, or the line over cmd when both are given." }
                }, "additionalProperties": false } },
                "key": { "type": "string", "description": "A key to add, by its name, e.g. CLOUDFLARE_API_TOKEN. Adding it settles this." },
                "replaces": { "type": "integer", "description": "The id of a card of yours this one says again, changed: it is taken off as this goes on." }
            }, "required": ["text"], "additionalProperties": false },
            "annotations": ann(false)
        }),
        json!({
            "name": "settle", "title": "Take your own off the user's lists", "description": SETTLE,
            "inputSchema": { "type": "object", "properties": {
                "answers": { "type": "array", "description": "Questions their message here answered, in their words.",
                    "items": { "type": "object", "properties": {
                        "id": { "type": "integer", "description": "The question's id, as ask said it." },
                        "answer": { "type": "string", "description": "Their answer, short." }
                    }, "required": ["id", "answer"], "additionalProperties": false } },
                "ids": { "type": "array", "items": { "type": "integer" }, "description": "Cards no longer on the user, by id." },
                "why": { "type": "string", "description": "With ids: a few words, what shows they are no longer on the user." }
            }, "additionalProperties": false },
            "annotations": ann(true)
        }),
        json!({
            "name": "suggest_panel", "title": "Suggest a panel", "description": SUGGEST_PANEL,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "cmd": { "type": "string", "description": "One command line, exactly as it should run." },
                "why": { "type": "string", "description": "One sentence." },
                "back": { "type": "boolean", "description": "Open it in the back, out of the grid." }
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

/// What else waits on the user on the desk, after an ask or a hand-over
/// (#174): a card this one repeats, or one an ended session left that is
/// done, is the agent's to remove. Nothing when nothing else waits.
fn also_open(v: &Value) -> String {
    let open: Vec<String> = v
        .get("open")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(6)
        .map(|t| {
            let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("");
            let text: String = s("text").chars().take(80).collect();
            let old = if t.get("stale").and_then(Value::as_bool) == Some(true) {
                ", older"
            } else {
                ""
            };
            format!(
                "#{} {}: \"{text}\"{old}",
                t.get("id").and_then(Value::as_i64).unwrap_or(0),
                s("kind")
            )
        })
        .collect();
    if open.is_empty() {
        return String::new();
    }
    format!(
        " Also on the user's On you list on this desk: {}. If one is done, or this card repeats it, remove_card it with why.",
        open.join("; ")
    )
}

/// A thread in one line, as the agent is told it back.
fn card(t: &Value) -> String {
    let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut parts = vec![s("name"), s("stage")];
    // Told (1.48, `crate::told`): said, with where, so the move is seen to hold.
    if t.get("told_at").and_then(Value::as_i64).unwrap_or(0) != 0 {
        parts.push(match s("told_url") {
            u if u.is_empty() => "told".to_string(),
            u => format!("told at {u}"),
        });
    }
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
            "notes": notes_arg(args), "url": arg(args, "url"),
        });
        match self.thread_call("thread/move", body) {
            Ok(v) => said(format!("Moved: {}.", card(&v["thread"])), false),
            Err(e) => e,
        }
    }

    pub(super) fn ask(&self, args: &Value) -> Value {
        let mut body = json!({
            "kind": "decide", "text": arg(args, "question"),
            "options": args.get("options").cloned().unwrap_or(json!([])),
            "recommended": args.get("recommended").and_then(Value::as_i64).unwrap_or(-1),
            "by": self.by(),
        });
        let many = args
            .get("questions")
            .and_then(Value::as_array)
            .filter(|q| !q.is_empty());
        if let Some(q) = many {
            body["questions"] = json!(q);
        }
        if let Some(r) = args.get("replaces").and_then(Value::as_i64) {
            body["replaces"] = json!(r);
        }
        // The document it is asked under: what the decisions group by.
        let about = arg(args, "about");
        if !about.is_empty() {
            body["link"] = json!(about);
        }
        match self.thread_call("ask", body) {
            // Already waiting, in the same words (C8): folded, not asked twice.
            Ok(v) if v.get("again").and_then(Value::as_bool) == Some(true) => {
                let id = v.pointer("/turn/id").and_then(Value::as_i64).unwrap_or(0);
                let n = v
                    .pointer("/turn/asked")
                    .and_then(Value::as_i64)
                    .unwrap_or(2);
                said(format!("Already on the user's On you list as #{id}, unanswered: not asked again (asked {n} times now). The answer comes with their next message; to change the question, ask with replaces: {id}.") + &also_open(&v), false)
            }
            Ok(v) => {
                let n = v.get("turns").and_then(Value::as_array).map_or(1, Vec::len);
                // Each by its id: what settle_asks takes an answer for.
                let turns: Vec<&Value> = match v.get("turns").and_then(Value::as_array) {
                    Some(t) => t.iter().collect(),
                    None => v.get("turn").into_iter().collect(),
                };
                let ids: Vec<String> = turns
                    .iter()
                    .filter_map(|t| t.get("id").and_then(Value::as_i64))
                    .map(|i| format!("#{i}"))
                    .collect();
                let ids = ids.join(", ");
                let head = if n > 1 {
                    format!("Asked {n} questions ({ids}), on one card on the user's On you list in snyvi; the answers come with their next message. Carry on with what does not depend on them.")
                } else {
                    format!("Asked ({ids}). It is on the user's On you list in snyvi; the answer comes with their next message. Carry on with what does not depend on it.")
                };
                said(head + &also_open(&v), false)
            }
            Err(e) => e,
        }
    }

    pub(super) fn hand_over(&self, args: &Value) -> Value {
        let steps = run_steps(args);
        let kind = handed_kind(args, !steps.is_empty());
        let body = json!({
            "kind": kind, "text": arg(args, "text"), "link": arg(args, "link"),
            "cmd": arg(args, "cmd"), "key": arg(args, "key"), "by": self.by(), "options": steps,
            "replaces": args.get("replaces").and_then(Value::as_i64).unwrap_or(0),
        });
        let run = kind == "run";
        let head = if run && !steps.is_empty() {
            "Handed over as steps. The user runs each command with a click, in order -- typed into this panel as a ! command, its output arriving here as their message, or into a shell panel of its own where you do not see it -- and ticks each step done. When all are, their answer says which ran where. Say so in your reply; do not repeat the commands for them to paste."
        } else if run {
            "Handed over. When the user clicks Run, it is typed into this panel as a ! command, and its output arrives here as their message. Say so in your reply; do not ask them to paste it."
        } else {
            "Handed over. It is in the user's To do in snyvi until they press Done or Can't, which is typed into this panel as a message. Say so in your reply."
        };
        match self.thread_call("handover", body) {
            Ok(v) => said(head.to_string() + &also_open(&v), false),
            Err(e) => e,
        }
    }

    /// `settle` (1.66): answers given here, and cards no longer on the
    /// reader, in one call.
    pub(super) fn settle(&self, args: &Value) -> Value {
        let ids: Vec<i64> = args
            .get("ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        let why = arg(args, "why");
        let mut out: Vec<String> = Vec::new();
        let mut failed = false;
        if args.get("answers").is_some() || ids.is_empty() {
            let r = self.settle_asks(args);
            failed |= r["isError"] == true;
            out.push(text_of(&r));
        }
        if !ids.is_empty() && why.is_empty() {
            return said("settle with ids needs why: a few words on what shows they are no longer on the user.", true);
        }
        let mut gone: Vec<String> = Vec::new();
        for id in &ids {
            match self.thread_call("away", json!({ "turn": id, "why": why })) {
                Ok(_) => gone.push(format!("#{id}")),
                Err(e) => {
                    failed = true;
                    out.push(format!("#{id}: {}", text_of(&e)));
                }
            }
        }
        if !gone.is_empty() {
            out.push(format!("Removed {}. The user sees it in News, with Undo.", gone.join(", ")));
        }
        said(out.join(" "), failed && gone.is_empty())
    }

    /// The reader answered this panel's questions in the conversation: off
    /// On you, answered there, and nothing comes back about them.
    pub(super) fn settle_asks(&self, args: &Value) -> Value {
        let answers = args.get("answers").cloned().unwrap_or(json!([]));
        match self.thread_call("settle", json!({ "answers": answers })) {
            Ok(v) => match v.get("settled").and_then(Value::as_i64).unwrap_or(0) {
                0 => said("None of your questions was open on On you.", false),
                1 => said(
                    "Settled: one question, answered in the conversation.",
                    false,
                ),
                n => said(
                    format!("Settled: {n} questions, answered in the conversation."),
                    false,
                ),
            },
            Err(e) => e,
        }
    }

    /// A card that is no longer on the reader, off On you with why (#174).
    pub(super) fn remove_card(&self, args: &Value) -> Value {
        let id = args.get("id").and_then(Value::as_i64).unwrap_or(0);
        match self.thread_call("away", json!({ "turn": id, "why": arg(args, "why") })) {
            Ok(_) => said(
                "Removed. It is off the user's lists; their News says why, with Undo.",
                false,
            ),
            Err(e) => e,
        }
    }

    pub(super) fn suggest_panel(&self, args: &Value) -> Value {
        let body = json!({
            "kind": "panel", "name": arg(args, "name"), "cmd": arg(args, "cmd"), "why": arg(args, "why"),
            "back": args.get("back").and_then(Value::as_bool).unwrap_or(false), "by": self.by(),
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

/// What a hand-over is, read from what was given (1.66): a key's name is a
/// key, a PR's link a merge, a command or steps a run, anything else a do.
/// A session from before 1.66 passes `kind`; it is kept, but `try`, which
/// is a question and goes to `ask`.
fn handed_kind(args: &Value, steps: bool) -> &'static str {
    match arg(args, "kind").as_str() {
        "merge" => return "merge",
        "key" => return "key",
        "run" => return "run",
        "do" | "try" => return "do",
        _ => {}
    }
    let link = arg(args, "link");
    if !arg(args, "key").is_empty() {
        "key"
    } else if !arg(args, "cmd").is_empty() || steps {
        "run"
    } else if link.contains("/pull/") || link.contains("/merge_requests/") {
        "merge"
    } else {
        "do"
    }
}

/// A tool result's text.
fn text_of(v: &Value) -> String {
    v.pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// `hand_over`'s steps as the turn keeps them (`thread::steps`): `$ cmd` a
/// command, `# words` the line over the command after it, the rest a step
/// done by hand. What the agent wrote is never read as one of the marks.
fn run_steps(args: &Value) -> Vec<String> {
    let mut out = vec![];
    for s in args
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let get = |k| {
            s.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
        };
        let say = get("say")
            .map(|t| t.trim_start_matches(['$', '#', ' ']).to_string())
            .filter(|t| !t.is_empty());
        match (get("cmd"), say) {
            (Some(c), Some(t)) => out.extend([format!("# {t}"), format!("$ {c}")]),
            (Some(c), None) => out.push(format!("$ {c}")),
            (None, Some(t)) => out.push(t),
            (None, None) => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seven tools in every panel session: each says what it does in a few
    /// lines, takes only what it names, and none is destructive.
    #[test]
    fn the_seven_are_short_and_take_only_what_they_name() {
        let specs = specs();
        assert_eq!(specs.len(), 7);
        for s in &specs {
            let d = s["description"].as_str().unwrap();
            assert!(d.len() <= 350, "{}: {} chars", s["name"], d.len());
            assert_eq!(s["inputSchema"]["additionalProperties"], false);
            assert_eq!(s["annotations"]["destructiveHint"], false);
            assert!(super::super::TOOLS.iter().any(|(n, _)| *n == s["name"]));
        }
    }

    /// A hand-over's kind is read from what it carries (1.66).
    #[test]
    fn a_hand_over_says_its_kind_by_what_it_carries() {
        let k = |v: Value| handed_kind(&v, false);
        assert_eq!(k(json!({ "text": "add it", "key": "CF_TOKEN" })), "key");
        assert_eq!(k(json!({ "text": "merge", "link": "https://github.com/a/b/pull/12" })), "merge");
        assert_eq!(k(json!({ "text": "deploy", "cmd": "npm run deploy" })), "run");
        assert_eq!(k(json!({ "text": "sign in to GA4" })), "do");
        assert_eq!(k(json!({ "text": "try it", "kind": "try" })), "do");
        assert_eq!(handed_kind(&json!({ "text": "set up" }), true), "run");
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
