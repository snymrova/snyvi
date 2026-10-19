//! set_widget: a small box in this desk's rail that an agent keeps up to
//! date -- "deploy 3/5", a test run's count, a port that is up -- without
//! a turn of the user's to ask for it (`crate::widget`, docs/WIDGETS.md).
//! propose_widget: a widget file the user adds or not, for a status that
//! should outlive the session: snyvi runs its command on a timer, on the
//! agent's desk alone (1.32). read_widgets: what is on the desk and where
//! each stands, so the agent does not push what was refused.
//! add_to_gallery: what an image or a video model made, as a tile in the
//! desk's gallery box (`crate::widget::gallery`).

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const SET: &str = "Show a small status box in this snyvi desk's rail, kept up to date as the work goes. Only \
when the user asked for one. A box is for a figure that changes by itself and that they would otherwise go and \
check: CI 3/5 green, a deploy running, a dev server up. Never for what waits on them (that is hand_over), how to \
do something (say it in your reply), news (a document), or what changes only when they act. Put the figure in \
count and one short line in the body (\"**deploy** 3/5 green\"), no instructions. The first time, the user gets \
a card on their On you list to allow the box, and nothing shows until they do; after that the same name updates it \
freely, and an empty body clears it. If they said not now, or removed it, leave it. Optional: for (today, week, \
panel: while this panel is open) suggests how long it lasts, tone (ok, warn, bad) colours the count, lines is its \
height (1-6, keep it 1), stale_after the seconds before it dims as old (default 1800).";

const PROPOSE: &str = "Propose a widget file to the user, for a status worth keeping after this session ends: \
snyvi runs its command on a timer while this desk is in view and shows what it prints (Markdown, or \
{\"body\",\"tone\",\"count\"} JSON). Only when the user asked for a widget. The same test as set_widget: a \
figure that changes by itself and that they would otherwise go and check, printed as count plus one short line, \
never a to-do of theirs or how to do it. The user gets a card on \
their On you list showing the script, where it runs and how often, can try it once, and adds it or not; nothing \
runs before. It is this desk's own: it runs in this desk's folder and on no other desk, and only the user can \
share it. The script's folder is first on PATH and in $SNYVI_WIDGET_DIR, so name the script bare as the command \
(run.sh, not ./run.sh or sh run.sh), or write \"$SNYVI_WIDGET_DIR/run.sh\"; snyvi refuses a command that hands \
one of the files it was given to an interpreter by a bare name, or names it by a relative path. Give the script \
whole as script with its file name as script_name (it gets the desk and settings as JSON on stdin), with any \
files it reads and the settings the user would change. A key the script needs (an API token on this desk's Keys \
list) goes in keys, by name: the card shows the names, and the run gets each as $NAME in its environment; snyvi \
key does not work in a run. Try it first: write widget.json and the script to a folder of your own (never the \
widgets folder) and run snyvi widget check NAME --dir FOLDER from the desk's folder, which runs it as snyvi \
would, with the same environment. Proposing the same name again replaces the card waiting for it. If the user \
said not now to a name, it is refused: leave it. for suggests how long it lasts: today, week, panel (while this \
panel is open), or leave it out for until the user turns it off.";

const READ: &str = "Read the widgets on this snyvi desk and where each stands: the boxes panels push \
(waiting on the user's card, allowed, not now, removed, again after the user took a no back, ended when its \
time was up) and the widget files snyvi runs (showing, waits for the user's Allow, changed since allowed, waits \
for a key, off, stopped after failing, or failing with the error), what each shows, which are yours, and the \
cards still waiting. A widget that waits for Allow or a key is not failing: nothing of the script's to fix. Read \
it before set_widget or propose_widget, to update your own box rather than make a second, to pick a name that \
is free, and to leave alone what the user said not now to or removed: boxes, proposals and widget files alike. \
A desk has room for six.";

const GALLERY: &str = "Show what an image or video model made for the user (OpenRouter, fal, Replicate, a local \
model, a render) as a tile in this snyvi desk's gallery: a box in the desk's rail with the newest outputs, which \
the user opens big, steps through, and picks from; their pick, with a line, comes back to you on your next prompt. \
file is a picture (png, jpg, gif, webp, avif) or a clip (mp4, webm, mov, m4v) on this machine: download a model's \
output first, never pass a URL. snyvi copies it in, so it stays after your folder is cleaned. For a slow model, \
call it first with a job and no file -- the tile says it is being made -- then again with the same job and the \
file, or with failed and why. Give caption (a few words: what differs from the others), model, the prompt, and \
cost in dollars when you know them; a clip can have a poster, its first frame as a picture. The first add on a \
desk asks the user with a card on their On you list; outputs added meanwhile are kept and show when they allow \
it. If they said not now, or removed it, stop adding. Not for screenshots of your work or documents: those go \
with send_document.";

pub(super) fn specs() -> Vec<Value> {
    vec![
        json!({
            "name": "read_widgets", "title": "Read this desk's widgets", "description": READ,
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "propose_widget", "title": "Propose a widget", "description": PROPOSE,
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string", "description": "Lowercase letters, digits and dashes, at most 32." },
                "title": { "type": "string" },
                "command": { "type": "string", "description": "One line, run with sh -c (cmd /C on Windows) in the desk's folder. Name the script bare: run.sh. Its folder is first on PATH and in $SNYVI_WIDGET_DIR." },
                "every": { "type": "integer", "minimum": 5, "description": "Seconds between runs (60)." },
                "timeout": { "type": "integer", "minimum": 1, "maximum": 30 },
                "lines": { "type": "integer", "minimum": 1, "maximum": 6 },
                "script_name": { "type": "string", "description": "The script's file name, e.g. run.sh: required when script is given, and what the command names." },
                "script": { "type": "string", "description": "The script, whole, at most 16 KB." },
                "keys": { "type": "array", "items": { "type": "string" }, "maxItems": 4, "description": "Names of this desk's keys the run needs, as its Keys list shows them (OPENROUTER_API_KEY). Each is $NAME in the run's environment once the user adds the widget; shown on the card." },
                "files": { "type": "object", "additionalProperties": { "type": "string" }, "maxProperties": 4, "description": "Other files the script reads, by name: a helper, a query. Each at most 16 KB, named without a folder; reach them through $SNYVI_WIDGET_DIR. Shown on the card." },
                "settings": { "type": "object", "description": "Rows the user sets on /sidebars, as widget.json has them: {\"base\": {\"type\": \"string\", \"label\": \"Compare against\", \"default\": \"main\"}}. type is string, number, boolean, or choice with choices. At most 8. The script gets them on stdin as settings." },
                "why": { "type": "string", "description": "One sentence." },
                "for": { "type": "string", "enum": ["today", "week", "panel"], "description": "How long you suggest it lasts; the user picks on the card. Left out: until the user turns it off." }
            }, "required": ["name", "command", "why"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "add_to_gallery", "title": "Add to the gallery", "description": GALLERY,
            "inputSchema": { "type": "object", "properties": {
                "file": { "type": "string", "description": "The output: an absolute path (a relative one is read from this session's folder)." },
                "job": { "type": "string", "description": "Your id for one output, to show it being made before the file is there, and to fill it." },
                "caption": { "type": "string", "description": "A few words." },
                "model": { "type": "string" },
                "prompt": { "type": "string" },
                "cost": { "type": "number", "minimum": 0, "description": "In dollars." },
                "poster": { "type": "string", "description": "A clip's first frame, a picture's path." },
                "failed": { "type": "string", "description": "Why the job made nothing." },
                "name": { "type": "string", "description": "The gallery's name, default gallery. Lowercase letters, digits and dashes." },
                "lines": { "type": "integer", "minimum": 2, "maximum": 6, "description": "The box's height, 20 px a line (4)." },
                "for": { "type": "string", "enum": ["today", "week", "panel"], "description": "How long you suggest it lasts; the user picks on the card. Left out: until the user turns it off." }
            }, "additionalProperties": false },
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
                "stale_after": { "type": "integer", "minimum": 0, "description": "Seconds; 0 is never." },
                "for": { "type": "string", "enum": ["today", "week", "panel"], "description": "How long you suggest it lasts; the user picks on the card. Left out: until the user turns it off." }
            }, "required": ["name", "body"], "additionalProperties": false },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        }),
    ]
}

impl Session {
    pub(super) fn read_widgets(&self, _args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there are no desk widgets to read.",
                true,
            );
        };
        match client::desk_widgets(&self.paths, p) {
            Ok(v) => json!({
                "content": [{ "type": "text", "text": say_widgets(&v) }],
                "structuredContent": v,
                "isError": false
            }),
            Err(e) => said(
                format!("snyvi could not read the desk's widgets: {e}"),
                true,
            ),
        }
    }

    pub(super) fn add_to_gallery(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no gallery to add to.",
                true,
            );
        };
        let mut body = args.clone();
        // The daemon reads the file; a path relative to this session means
        // nothing to it.
        for k in ["file", "poster"] {
            if let Some(f) = args
                .get(k)
                .and_then(Value::as_str)
                .filter(|f| !f.trim().is_empty())
            {
                let path = std::path::Path::new(f.trim());
                if path.is_relative() && !f.contains("://") {
                    if let Some(cwd) = self.cwd.as_deref() {
                        body[k] = json!(std::path::Path::new(cwd).join(path).to_string_lossy());
                    }
                }
            }
        }
        match client::pane_thread(&self.paths, p, "gallery", body) {
            Ok(v) if v["waiting"].as_bool() == Some(true) => said(
                format!("Kept as output #{}. The user has a card on their On you list to allow the gallery; it shows when they do. Carry on.", v["id"]),
                false,
            ),
            Ok(v) => {
                let failed = args
                    .get("failed")
                    .and_then(Value::as_str)
                    .is_some_and(|f| !f.trim().is_empty());
                let no_file = args
                    .get("file")
                    .and_then(Value::as_str)
                    .is_none_or(|f| f.trim().is_empty());
                let then = if failed {
                    ", marked as failed with why"
                } else if no_file {
                    ", shown as being made: add the same job with its file when it is done"
                } else {
                    ""
                };
                said(format!("In the gallery as output #{}{then}.", v["id"]), false)
            }
            Err(e) => said(format!("snyvi did not take it, and kept nothing: {e}"), true),
        }
    }

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
                format!("Proposed. The user has a card on their On you list in snyvi with the script, where it runs and how often; nothing runs until they add {}. Carry on.", arg(args, "name")),
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
        let mut sent = json!({ "name": name, "body": body });
        if let Some(f) = args.get("for").and_then(Value::as_str) {
            sent["for"] = json!(f);
        }
        match client::pane_thread(&self.paths, p, "widget", sent) {
            Ok(v) if v.get("waiting").and_then(Value::as_bool) == Some(true) => said(
                format!("The user has a card on their On you list to allow the box {name} on this desk; it shows once they do, with what you sent last. Carry on, and set it as the work goes: your updates wait behind the card."),
                false,
            ),
            Ok(_) if cleared => said(format!("Cleared the widget {name}."), false),
            Ok(_) => said(
                format!("The widget {name} is in this desk's rail. Set it again with the same name to update it; an empty body clears it."),
                false,
            ),
            Err(e) => said(format!("snyvi did not take it: {e}"), true),
        }
    }
}

/// The desk's widgets as a few lines an agent reads: one per widget, then
/// the boxes asked for that do not show, then the cards still waiting.
fn say_widgets(v: &Value) -> String {
    let desk = v.get("desk").and_then(Value::as_str).unwrap_or("this desk");
    let list = |k: &str| {
        v.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let s = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let yours = |o: &Value| o.get("yours") == Some(&Value::Bool(true));
    let (shown, boxes, files, waiting) = (
        list("widgets"),
        list("boxes"),
        list("files"),
        list("waiting"),
    );
    let limit = v.get("limit").and_then(Value::as_u64).unwrap_or(6);
    let mut out = format!(
        "Widgets on the desk \"{desk}\": {} of {limit}.\n",
        shown.len()
    );
    for w in &shown {
        let mut line = format!("- {} ({}", s(w, "name"), s(w, "kind"));
        if yours(w) {
            line.push_str(", yours");
        }
        line.push_str(&format!(", {})", s(w, "state")));
        if !s(w, "count").is_empty() {
            line.push_str(&format!(" [{}]", s(w, "count")));
        }
        let body = s(w, "body");
        let first = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        if !first.is_empty() {
            line.push_str(&format!(": {first}"));
        }
        if !s(w, "error").is_empty() {
            line.push_str(&format!(" -- error: {}", s(w, "error")));
        }
        out.push_str(&line);
        out.push('\n');
    }
    let named = |n: &str| shown.iter().any(|w| s(w, "name") == n);
    // A box that shows is in the list above; these are the ones that don't.
    for b in boxes.iter().filter(|b| !named(&s(b, "name"))) {
        let who = if yours(b) { ", yours" } else { "" };
        let then = match s(b, "answer").as_str() {
            "not now" => " -- leave it: a push of it is refused",
            "removed" => " -- leave it: the user removed it",
            "waiting" => " -- on the user's card; your updates wait behind it",
            "again" => " -- the user took back their no: a push of it asks again, with a card",
            "ended" => " -- its time is up: a push of it asks again, with a card",
            _ => "",
        };
        out.push_str(&format!(
            "- box {} ({}{who}){then}\n",
            s(b, "name"),
            s(b, "answer")
        ));
    }
    for f in files.iter().filter(|f| !named(&s(f, "name"))) {
        let who = if yours(f) { ", yours" } else { "" };
        let state = if !s(f, "error").is_empty() {
            format!("cannot be read: {}", s(f, "error"))
        } else if f.get("changed") == Some(&Value::Bool(true)) {
            "changed since it was allowed: waits for Allow".into()
        } else if f.get("allowed") == Some(&Value::Bool(true)) {
            if f.get("off") == Some(&Value::Bool(true)) {
                "off"
            } else {
                "allowed, not run yet"
            }
            .into()
        } else {
            "waits for Allow".into()
        };
        out.push_str(&format!("- file {} ({state}{who})\n", s(f, "name")));
    }
    let names = |k: &str| {
        list(k)
            .iter()
            .filter_map(|n| n.as_str().map(String::from))
            .collect::<Vec<_>>()
    };
    let (declined, removed) = (names("proposals_not_now"), names("removed"));
    if !declined.is_empty() {
        out.push_str(&format!(
            "- proposals the user said not now to: {} -- leave them unless they ask\n",
            declined.join(", ")
        ));
    }
    if !removed.is_empty() {
        out.push_str(&format!(
            "- widget files the user removed: {} -- leave them unless they ask\n",
            removed.join(", ")
        ));
    }
    for c in &waiting {
        let who = if yours(c) { "yours" } else { "another panel's" };
        out.push_str(&format!(
            "- card waiting: {} {} ({who})\n",
            s(c, "kind"),
            s(c, "name")
        ));
    }
    if shown.is_empty()
        && boxes.is_empty()
        && files.is_empty()
        && waiting.is_empty()
        && declined.is_empty()
        && removed.is_empty()
    {
        out.push_str("None yet.\n");
    }
    out
}
