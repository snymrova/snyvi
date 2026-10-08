//! A stdio MCP server exposing send_document, send_aside for the rare line
//! beside the work, and -- only to an agent running in a desk's pane --
//! read_desk_notes, which reads that desk's list, mark_desk_note, saying how
//! far the agent has got with a line, tick_desk_note, marking a line done,
//! suggest_desk_note, offering one for the reader to keep, offer_document, asking that one go to a friend,
//! leave_off, saying where the work was left, and name_panel, which names the
//! panel the agent runs in; and the #90 six, filing the work as a thread and
//! putting what only the reader can do on their Your turn (`threads`). And four prompts, the loop's own slash commands
//! (`PROMPTS`). Newline-delimited JSON-RPC 2.0, as the MCP stdio transport
//! specifies.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

mod threads;
mod widgets;

const TOOL_DESCRIPTION: &str = "Send a finished document to snyvi, the user's document viewer. \
Call this whenever you finish writing a plan, report, review, summary, design note, or any document the user \
will want to read, and whenever the user asks to see a file. Prefer `path` for files you wrote to disk; use \
`content` for text that is not a file (a review, a summary, a diff). The document arrives at once and waits \
in the viewer to be read.\n\n\
What snyvi shows, and when to choose it:\n\
- A plan, report or review: Markdown. Mermaid code blocks are drawn as diagrams, so draw a flow, a sequence \
or a structure rather than describing it. Images in Markdown show only when the document is sent by `path` \
(they are read from beside the file); a video or a song beside it plays in place the same way, \
`![take 2](take2.mp4)`, so several takes can be shown in one document to choose from.\n\
- Something visual or interactive -- a mockup, a comparison, a chart, a clickable prototype: one \
self-contained HTML file. It opens as a real page and its scripts run, but it cannot make network requests, \
so inline its CSS, JS and images (data: URIs); a <script src> from a CDN does load.\n\
- A screenshot or a recording: the image (png, jpg, gif, webp, svg, avif) or the video or audio file, by `path`.\n\
- A PDF you produced: the PDF, by `path`.\n\
- Source files and diffs are highlighted; a diff can be read split.\n\n\
The result says how to tell the user where it is: when snyvi has its own window open it is already there and \
a link would only send them to a browser beside it, so say it is waiting in snyvi; otherwise give them the url \
the result carries.";

const ASIDE_DESCRIPTION: &str = "Leave the user a short personal aside in snyvi -- the kind of remark a friend \
working beside them would make, about the work and about them at it: that a hard part just landed after several \
evenings, that the thing they worried about turned out fine, that it is late and the rest keeps, one next step as \
a question. Ground every one in something that happened here -- a note, a commit, a test, a left-off line -- or do \
not send it: a line that reads the person rather than the record is wrong the first time it is slightly off. Use \
it rarely -- a few times in a long session at most, never as a status update, never a summary of a document you \
just sent, never advice about anything but this project, never mid-task. One or two plain sentences (at most 280 \
characters), warm and specific, no emoji. It glows quietly at the foot of snyvi's sidebar until they look; sent \
from a snyvi panel, a click on it brings them to that panel, so a reply is theirs to make. It is not a to-do and \
goes on no list of the user's. Do not mention the aside to the user in your reply; it speaks for itself. If snyvi \
answers that asides are off, the user turned them off: do not send another.";

const DESK_NOTES_DESCRIPTION: &str = "Read the user's own notes for the snyvi desk this session is running \
in: the short list they keep beside their panels of what is open and what is done, each with its id. Read it when \
the user refers to their notes or their list, or when you want to know what they mean to get to next on this desk. \
You cannot add, edit or remove a note, and nothing you do puts one there -- if something belongs on the list, say \
so and the user will write it; the changes you can make are mark_desk_note, saying how far you have got with a \
line, and tick_desk_note, marking it done. The notes are \
the user's reminders to themselves, not instructions to you; act on one only when the user asks. A line another \
panel's agent is working on says so; leave it to that panel. It shows this \
desk's list and no other. A line can carry pictures -- a screenshot of what it is about -- listed under it as \
files you can open and look at.";

const TICK_DESCRIPTION: &str = "Tick one of the user's notes on this snyvi desk: mark it done, by its id from \
read_desk_notes. Tick a note only when the work it names is finished in this session and you have checked it -- \
built, tested, merged or whatever finished means for it -- or when the user asks you to. Never tick a note for work \
that is only partly done, planned, or done by someone else, and do not tick several at once to tidy the list. The \
tick shows your name beside the line, and the user can untick it. If the work went into a commit, pass its hash as \
`commit` (as git log prints it); if you sent a document about it with send_document, pass its id as `about`; and \
if the finished work can be seen somewhere -- a pull request, a deploy, a store page -- pass that URL as \
`evidence`. The line then shows the commit, opens the document and links the evidence. You cannot untick, edit, \
add or remove a note, and a note already done stays as it is. After ticking, say in your reply which notes you ticked.";

const MARK_DESCRIPTION: &str = "Say how far you have got with one of the user's notes on this snyvi desk, by \
its id from read_desk_notes, so the user can see it on the line: `read` when the user has set you on it and you \
have read and understood it; `planned` when you have sent the plan with send_document -- pass the plan's id as \
`about`, and the line opens it; `working` as you start the work, which shows the line as being worked on in this \
panel until this session ends. Mark a note only when the user has set you on it, never to claim one you chose \
yourself. You can move a note back a stage, for example from working to planned when you stop partway. Done is \
not a stage: when the work is finished and checked, tick it with tick_desk_note. You cannot mark a note that is \
already done.";

const LEAVE_OFF_DESCRIPTION: &str = "Say where the work on this snyvi desk stands, in one sentence, for \
whoever picks it up next -- the user, or the next Claude in a panel here, which is handed it when it starts. \
Write it as the next step with its condition: \"If the migration tests pass, ship it; if not, the failing \
case is in orders.rs.\" Call it when a stretch of work ends -- the user is wrapping up, a task is done, or \
you are stopping partway -- not after every step. It replaces the one before (the user can undo that), \
shows in the desk's head and on snyvi's Home, and is at most 200 characters. Pass `about` with a document's \
id from send_document when the next step is written up there.";

const SUGGEST_DESCRIPTION: &str = "Suggest a line for the user's notes on this snyvi desk: something that \
came up in the work and should not be forgotten, like a follow-up, a known gap, or a decision left open. It \
shows as a suggestion beside their list, with Keep and a remove button, and is on their list only if they \
keep it. Suggest rarely and only what the user would want to track themselves; never your own next steps \
or a to-do for this session. A desk holds only a few suggestions waiting at once. One short line, at most \
200 characters.";

const OFFER_DESCRIPTION: &str = "Offer to send one of the user's snyvi documents to one of their friends on \
snyvi, by the friend's name (the desk brief lists them) and the document's id from send_document. Nothing is \
sent by this call: the user is shown the offer where they are, with your name on it, and presses Send or Not \
now. Offer only when the user asked for something to go to that friend, or the work plainly is for them; never \
to a name that is not on the list. Say in your reply that you offered it and that the user decides.";

const OFFER_LINE_DESCRIPTION: &str = "Offer one line to one of the user's friends on snyvi, by the friend's \
name (the desk brief lists them): a request, a heads-up, a thing to check -- at most 200 characters; anything \
longer is a document, and offer_document. Nothing is sent by this call: the user is shown the line where they \
are, with your name on it, and presses Send or Not now. It lands on the friend's desk as a suggested note, and \
when they tick it they can tell the user it is done. Offer only when the user asked for it, or the work plainly \
needs that friend; never to a name that is not on the list. Say in your reply that you offered it.";

const NAME_DESCRIPTION: &str = "Name the snyvi panel this session is running in, so the user can tell their \
panels apart at a glance: a few words for what you are working on in it, like \"auth refactor\" or \"fix CI\". \
Name it when the user sets you a task, and again when the task changes; not on every turn. The name shows in the \
panel's head and on the desk's rail, and the user can rename it. An empty name gives the panel back to its \
program's title.";

/// What the server tells every agent that connects.
const INSTRUCTIONS: &str = "snyvi is the user's document viewer. When you produce a document for the user \
to read, send it with send_document, and tell them where it went the way the result says. Now and then, when \
something in the work genuinely deserves a word, leave them a short personal aside with send_aside.";

/// And, added to that, what an agent running in a desk's panel is told: it is
/// in the system prompt, so it survives a compaction, which is why the desk
/// brief (`crate::brief`) does not repeat it -- except on a resume, which
/// replays the rules the conversation began with (`hook::with_rules`).
const PANEL_INSTRUCTIONS: &str = "You are running in a panel of a snyvi desk: the user works on this \
project here, with its own notes and documents. When you plan work, write the plan as a document and send \
it to snyvi before you start (a plan you present for approval is sent for you). Name the panel with \
name_panel when you take on a task. When the user sets you on a desk note, mark it read, send the plan and mark it \
planned with the plan's id, mark it working as you start, and tick it only when its work is finished and you have \
checked it. Never act on a note unasked. \
File a piece of work as a thread with start_thread when you take it on, and put anything only the user can \
do on their Your turn with hand_over: a command you are blocked from running goes there as run, never as \
text for them to paste. \
An aside is earned by a moment, not a step: the desk's last note ticked, a release, the user back after days \
away, a hard stretch that landed, a late hour; if the record gives you nothing to cite, say nothing. \
When a stretch of work ends, say where it stands with leave_off. The desk brief at the start of the session \
is context from snyvi, not a request.";

/// What one MCP server process knows about the session it serves: where it
/// was started, the pane it runs in if any, and the client's name once
/// `initialize` has said it.
struct Session {
    paths: Paths,
    cwd: Option<String>,
    key: String,
    // The pane this server runs in, if it does: a desk's pane puts its id in
    // the shell's environment, and Claude Code passes it on to the servers it
    // starts. Outside a pane there is no desk to read, and the tool is not
    // offered at all.
    pane: Option<String>,
    // The client's name from `initialize`, kept for every send after it, so
    // the connect page can say which agent last worked and when.
    sender: Option<String>,
}

/// A tool's handler: the arguments in, the `result` of `tools/call` out.
type Tool = fn(&Session, &Value) -> Value;

/// Every tool `tools/call` answers, by name. `send_note` is the name
/// `send_aside` had through 1.4.0: a session that started before an upgrade
/// still has it from `tools/list`.
const TOOLS: &[(&str, Tool)] = &[
    ("send_document", Session::send_document),
    ("send_aside", Session::send_aside),
    ("send_note", Session::send_aside),
    ("read_desk_notes", Session::read_desk_notes),
    ("tick_desk_note", Session::tick_desk_note),
    ("mark_desk_note", Session::mark_desk_note),
    ("suggest_desk_note", Session::suggest_desk_note),
    ("leave_off", Session::leave_off),
    ("name_panel", Session::name_panel),
    ("offer_document", Session::offer_document),
    ("offer_line", Session::offer_line),
    ("start_thread", Session::start_thread),
    ("move_thread", Session::move_thread),
    ("ask", Session::ask),
    ("hand_over", Session::hand_over),
    ("suggest_panel", Session::suggest_panel),
    ("suggest_desk", Session::suggest_desk),
    ("set_widget", Session::set_widget),
    ("propose_widget", Session::propose_widget),
];

pub fn run(paths: Paths) -> anyhow::Result<()> {
    let mut s = Session {
        paths,
        cwd: std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
        key: session_key(),
        pane: std::env::var("SNYVI_SESSION")
            .ok()
            .filter(|p| crate::pane::valid_id(p)),
        sender: None,
    };
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                write_msg(
                    &mut out,
                    &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } }),
                )?;
                continue;
            }
        };
        // Notifications have no id and get no reply.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let reply = match s.answer(method, &params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        };
        write_msg(&mut out, &reply)?;
    }
    Ok(())
}

/// What `tools/list` offers: the two any agent has, and in a panel the
/// desk's. `offer_document` only for a reader with a friend to offer to --
/// an agent shown a tool it can never use tries it -- and when the daemon
/// did not say (`None`), as before.
fn tools(panel: bool, friends: Option<bool>) -> Vec<Value> {
    let mut tools = vec![tool_spec(), aside_spec()];
    if panel {
        tools.extend([
            desk_notes_spec(),
            mark_spec(),
            tick_spec(),
            suggest_spec(),
            leave_off_spec(),
            name_spec(),
        ]);
        tools.extend(threads::specs());
        tools.extend(widgets::specs());
        if friends != Some(false) {
            tools.push(offer_spec());
            tools.push(offer_line_spec());
        }
    }
    tools
}

/// A tool's answer: one text for the agent, and whether it is an error.
fn said(text: impl Into<String>, bad: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": bad })
}

/// A string argument, trimmed; empty when it is missing.
fn arg(args: &Value, k: &str) -> String {
    args.get(k)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

impl Session {
    /// The `result` of one request, or its JSON-RPC error code and message.
    fn answer(&mut self, method: &str, params: &Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                self.sender = params
                    .pointer("/clientInfo/name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(name) = &self.sender {
                    client::hold_presence(name.clone());
                }
                Ok(json!({
                    "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
                    "capabilities": { "tools": {}, "prompts": {} },
                    "serverInfo": { "name": "snyvi", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": instructions(self.pane.is_some())
                }))
            }
            "prompts/list" => {
                let prompts: Vec<Value> = PROMPTS
                    .iter()
                    .filter(|p| self.pane.is_some() || !p.panel)
                    .map(prompt_spec)
                    .collect();
                Ok(json!({ "prompts": prompts }))
            }
            "prompts/get" => self.prompt(params),
            "ping" => Ok(json!({})),
            "tools/list" => {
                // The friends are asked for only in a panel, where the
                // tool would be listed.
                let friends = self.pane.as_ref().and_then(|_| client::has_friends());
                Ok(json!({ "tools": tools(self.pane.is_some(), friends) }))
            }
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match TOOLS.iter().find(|(n, _)| *n == name) {
                    Some((_, tool)) => Ok(tool(self, &args)),
                    None => Err((-32602, format!("unknown tool {name}"))),
                }
            }
            _ => Err((-32601, format!("method not found: {method}"))),
        }
    }

    fn prompt(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let Some(p) = PROMPTS
            .iter()
            .find(|p| p.name == name && (self.pane.is_some() || !p.panel))
        else {
            return Err((-32602, format!("unknown prompt {name}")));
        };
        let arg = p
            .arg
            .and_then(|(a, _)| params.pointer(&format!("/arguments/{a}")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty());
        Ok(json!({
            "description": p.description,
            "messages": [{ "role": "user", "content": { "type": "text", "text": prompt_text(p, arg) } }]
        }))
    }

    fn by(&self) -> &str {
        self.sender.as_deref().unwrap_or("")
    }

    fn send_document(&self, args: &Value) -> Value {
        match call_send(
            &self.paths,
            args.clone(),
            self.cwd.as_deref(),
            &self.key,
            self.sender.as_deref(),
            self.pane.as_deref(),
        ) {
            Ok(sent) => json!({
                "content": [{ "type": "text", "text": sent.say() }],
                "structuredContent": { "id": sent.id, "url": sent.url, "app_url": sent.app_url, "window": sent.window, "title": sent.title },
                "isError": false
            }),
            Err(e) => said(format!("snyvi could not receive the document: {e}"), true),
        }
    }

    fn send_aside(&self, args: &Value) -> Value {
        match call_aside(
            &self.paths,
            args,
            self.cwd.as_deref(),
            self.sender.as_deref(),
            self.pane.as_deref(),
        ) {
            Ok(()) => said("Left in snyvi. No need to mention it to the user.", false),
            Err(e) => said(format!("snyvi could not take the aside: {e}"), true),
        }
    }

    fn read_desk_notes(&self, _args: &Value) -> Value {
        match self
            .pane
            .as_deref()
            .map(|p| client::desk_notes(&self.paths, p))
        {
            Some(Ok(v)) => json!({
                "content": [{ "type": "text", "text": say_notes(&v) }],
                "structuredContent": v,
                "isError": false
            }),
            Some(Err(e)) => said(format!("snyvi could not read the desk's notes: {e}"), true),
            None => said(
                "This session is not running in a snyvi desk, so there are no desk notes to read.",
                true,
            ),
        }
    }

    fn tick_desk_note(&self, args: &Value) -> Value {
        let note = args.get("id").and_then(Value::as_i64);
        let (commit, about, evidence) = (
            arg(args, "commit"),
            arg(args, "about"),
            arg(args, "evidence"),
        );
        match (self.pane.as_deref(), note) {
            (None, _) => said(
                "This session is not running in a snyvi desk, so there is no desk list to tick.",
                true,
            ),
            (_, None) => said(
                "tick_desk_note needs the note's id, a number from read_desk_notes.",
                true,
            ),
            (Some(p), Some(n)) => match client::tick_desk_note(
                &self.paths,
                p,
                n,
                self.by(),
                &commit,
                &about,
                &evidence,
            ) {
                Ok(v) => said(
                    format!(
                        "Ticked note {n} on the desk \"{}\". Tell the user which note you ticked.",
                        v.get("desk").and_then(Value::as_str).unwrap_or("this desk")
                    ),
                    false,
                ),
                Err(e) => said(format!("snyvi did not tick the note: {e}"), true),
            },
        }
    }

    fn mark_desk_note(&self, args: &Value) -> Value {
        let note = args.get("id").and_then(Value::as_i64);
        let (stage, about) = (arg(args, "stage"), arg(args, "about"));
        match (self.pane.as_deref(), note) {
            (None, _) => said(
                "This session is not running in a snyvi desk, so there is no desk list to mark.",
                true,
            ),
            (_, None) => said(
                "mark_desk_note needs the note's id, a number from read_desk_notes.",
                true,
            ),
            (Some(p), Some(n)) => {
                match client::mark_desk_note(&self.paths, p, n, &stage, self.by(), &about) {
                    Ok(_) => said(format!("Note {n} is marked {stage}."), false),
                    Err(e) => said(format!("snyvi did not mark the note: {e}"), true),
                }
            }
        }
    }

    fn suggest_desk_note(&self, args: &Value) -> Value {
        let text = arg(args, "text");
        match self.pane.as_deref() {
            None => said("This session is not running in a snyvi desk, so there is no desk to write to.", true),
            Some(p) => match client::suggest_desk_note(&self.paths, p, &text, self.by()) {
                Ok(_) => said("Suggested. It waits beside the user's notes until they keep it or remove it; mention it in your reply.", false),
                Err(e) => said(format!("snyvi did not take the suggestion: {e}"), true),
            },
        }
    }

    fn leave_off(&self, args: &Value) -> Value {
        let text = arg(args, "text");
        match self.pane.as_deref() {
            None => said(
                "This session is not running in a snyvi desk, so there is no desk to write to.",
                true,
            ),
            Some(p) => {
                match client::leave_off(&self.paths, p, &text, &arg(args, "about"), self.by()) {
                    Ok(v) => said(
                        format!(
                            "Left off on the desk \"{}\": {text}",
                            v.get("desk").and_then(Value::as_str).unwrap_or("this desk")
                        ),
                        false,
                    ),
                    Err(e) => said(format!("snyvi did not take it: {e}"), true),
                }
            }
        }
    }

    /// `offer_document`: the question goes to the reader; nothing is sent.
    fn offer_document(&self, args: &Value) -> Value {
        let to = arg(args, "to");
        let id = arg(args, "id");
        match self.pane.as_deref() {
            None => said("This session is not running in a snyvi desk, so there is no one to offer to.", true),
            Some(p) => match client::offer_document(&self.paths, p, &to, &id, self.by()) {
                Ok(v) => said(
                    format!(
                        "Offered \"{}\" to {}; the user decides whether it goes. Say so in your reply.",
                        v.get("title").and_then(Value::as_str).unwrap_or(&id),
                        v.get("to").and_then(Value::as_str).unwrap_or(&to)
                    ),
                    false,
                ),
                Err(e) => said(format!("snyvi did not take the offer: {e}"), true),
            },
        }
    }

    /// `offer_line`: as `offer_document`, a line instead of a document.
    fn offer_line(&self, args: &Value) -> Value {
        let to = arg(args, "to");
        let text = arg(args, "text");
        match self.pane.as_deref() {
            None => said("This session is not running in a snyvi desk, so there is no one to offer to.", true),
            Some(p) => match client::offer_line(&self.paths, p, &to, &text, self.by()) {
                Ok(v) => said(
                    format!(
                        "Offered the line to {}; the user decides whether it goes. Say so in your reply.",
                        v.get("to").and_then(Value::as_str).unwrap_or(&to)
                    ),
                    false,
                ),
                Err(e) => said(format!("snyvi did not take the offer: {e}"), true),
            },
        }
    }

    fn name_panel(&self, args: &Value) -> Value {
        let to = arg(args, "name");
        match self.pane.as_deref() {
            None => said(
                "This session is not running in a snyvi desk, so there is no panel to name.",
                true,
            ),
            Some(p) => match client::name_panel(&self.paths, p, &to) {
                Ok(()) if to.is_empty() => said("The panel is back to its program's title.", false),
                Ok(()) => said(format!("The panel is named \"{to}\"."), false),
                Err(e) => said(format!("snyvi did not name the panel: {e}"), true),
            },
        }
    }
}

fn tool_spec() -> Value {
    json!({
        "name": "send_document",
        "title": "Send document to snyvi",
        "description": TOOL_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path of a file to send. Either path or content is required." },
                "content": { "type": "string", "description": "Inline document text, for documents that are not files." },
                "title": { "type": "string", "description": "Title shown in the viewer. Defaults to the first heading or the file name." },
                "workflow": { "type": "string", "description": "Optional name grouping related documents, e.g. 'auth refactor'. Defaults to this session." },
                "lang": { "type": "string", "description": "Format hint when it cannot be inferred from the path: md, diff, rs, py, ts, ..." }
            },
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })
}

fn aside_spec() -> Value {
    json!({
        "name": "send_aside",
        "title": "Leave an aside in snyvi",
        "description": ASIDE_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "The aside: one or two sentences, at most 280 characters." },
                "about": { "type": "string", "description": "Optional id of a document sent with send_document (its result's structuredContent.id) that the aside is about; clicking the aside opens it." }
            },
            "required": ["text"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })
}

fn desk_notes_spec() -> Value {
    json!({
        "name": "read_desk_notes",
        "title": "Read this desk's notes",
        "description": DESK_NOTES_DESCRIPTION,
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })
}

fn tick_spec() -> Value {
    json!({
        "name": "tick_desk_note",
        "title": "Tick a note on this desk",
        "description": TICK_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "The note's id, from read_desk_notes." },
                "commit": { "type": "string", "description": "Optional hash of the commit the work went into, as git log prints it (7 to 40 hex digits)." },
                "about": { "type": "string", "description": "Optional id of a document sent with send_document (its result's structuredContent.id) about the work; the line opens it." },
                "evidence": { "type": "string", "description": "Optional http(s) URL where the finished work can be seen: a pull request, a deploy, a store page." }
            },
            "required": ["id"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })
}

fn mark_spec() -> Value {
    json!({
        "name": "mark_desk_note",
        "title": "Mark how far a note on this desk has got",
        "description": MARK_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": { "type": "integer", "description": "The note's id, from read_desk_notes." },
                "stage": { "type": "string", "enum": ["read", "planned", "working"], "description": "read, planned or working. Done is tick_desk_note." },
                "about": { "type": "string", "description": "The id of the plan sent with send_document (its result's structuredContent.id). Needed with planned." }
            },
            "required": ["id", "stage"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })
}

fn suggest_spec() -> Value {
    json!({
        "name": "suggest_desk_note",
        "title": "Suggest a note for this desk",
        "description": SUGGEST_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": { "text": { "type": "string", "description": "One short line, at most 200 characters." } },
            "required": ["text"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })
}

fn leave_off_spec() -> Value {
    json!({
        "name": "leave_off",
        "title": "Say where the work was left",
        "description": LEAVE_OFF_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "One sentence, at most 200 characters: the next step and its condition." },
                "about": { "type": "string", "description": "Optional id of a document sent with send_document that the next step is written up in." }
            },
            "required": ["text"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })
}

pub(crate) fn instructions(in_panel: bool) -> String {
    if in_panel {
        format!("{INSTRUCTIONS} {PANEL_INSTRUCTIONS}")
    } else {
        INSTRUCTIONS.to_string()
    }
}

/// A prompt this server offers: Claude Code lists it in the `/` menu as
/// `/snyvi:<name> (MCP)`, and `/mcp__snyvi__<name>` runs it too. The loop's
/// own words, kept here rather than written into anyone's CLAUDE.md.
struct Prompt {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    /// Only in a desk's panel: it uses the desk's tools.
    panel: bool,
    /// One optional argument: its name and what it is.
    arg: Option<(&'static str, &'static str)>,
    text: &'static str,
}

const PROMPTS: [Prompt; 4] = [
    Prompt {
        name: "wrap-up",
        title: "Wrap up",
        description: "Tick what is finished and checked, and say where the work was left.",
        panel: true,
        arg: None,
        text: "We're wrapping up this stretch of work. First read_desk_notes, and tick only the notes whose work \
you finished in this session and checked -- pass the commit, and the evidence URL if there is a pull request or a \
deploy. Leave everything else as it is. Then call leave_off with one sentence on where the work stands and what the \
next session should start with, as a next step with its condition. Then tell me in at most three lines what you \
ticked and where you left off.",
    },
    Prompt {
        name: "plan",
        title: "Plan first",
        description: "Write the plan as a document, send it to snyvi, and wait before starting.",
        panel: false,
        arg: Some(("task", "What to plan; leave empty for the task at hand.")),
        text: "Before you start, write the plan as a Markdown document: the goal, the steps, the files it \
touches, what could go wrong, and how we will know it worked. Draw a Mermaid diagram where a flow or a structure \
is easier to see than to read. Send it with send_document, tell me where it is, and wait for my go-ahead before \
changing anything.",
    },
    Prompt {
        name: "catch-up",
        title: "Catch up",
        description: "Where this desk stands, in five lines, from its brief, notes and last document.",
        panel: true,
        arg: None,
        text: "Catch me up on this desk. Use the snyvi desk brief you were given at the start of this session \
(where the work was left, what was done lately, the last document), read_desk_notes, and the last document if you \
need it. In at most five lines: where we are, what is open, and the next step. Don't start any work.",
    },
    Prompt {
        name: "explain-back",
        title: "Explain it back",
        description: "What was just done and why, what was checked, and what is uncertain.",
        panel: false,
        arg: Some(("topic", "What to explain; leave empty for what you just did.")),
        text: "Explain back to me, in plain words and at most eight lines: what you just did and why, what you \
checked and how, and anything you are unsure of. If a diagram would make it clearer, send it with send_document \
as Markdown with Mermaid, and say where it is.",
    },
];

fn prompt_spec(p: &Prompt) -> Value {
    let mut spec = json!({ "name": p.name, "title": p.title, "description": p.description });
    if let Some((name, description)) = p.arg {
        spec["arguments"] =
            json!([{ "name": name, "description": description, "required": false }]);
    }
    spec
}

/// The prompt's words, with its argument in front of them when one was given.
fn prompt_text(p: &Prompt, arg: Option<&str>) -> String {
    match (p.arg, arg) {
        (Some((name, _)), Some(v)) => format!("{} ({name}: {v})", p.text),
        _ => p.text.to_string(),
    }
}

fn offer_spec() -> Value {
    json!({
        "name": "offer_document",
        "title": "Offer a document to a friend",
        "description": OFFER_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "The friend's name, as the desk brief lists it." },
                "id": { "type": "string", "description": "The document's id, as send_document answered it." }
            },
            "required": ["to", "id"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })
}

fn offer_line_spec() -> Value {
    json!({
        "name": "offer_line",
        "title": "Offer a line to a friend",
        "description": OFFER_LINE_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": { "type": "string", "description": "The friend's name, as the desk brief lists it." },
                "text": { "type": "string", "description": "The line, at most 200 characters." }
            },
            "required": ["to", "text"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false }
    })
}

fn name_spec() -> Value {
    json!({
        "name": "name_panel",
        "title": "Name this panel",
        "description": NAME_DESCRIPTION,
        "inputSchema": {
            "type": "object",
            "properties": { "name": { "type": "string", "description": "A few words, at most 80 characters. Empty gives the panel back to its program's title." } },
            "required": ["name"],
            "additionalProperties": false
        },
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })
}

/// The list as an agent reads it: open first, then done, as the rail shows it.
fn say_notes(v: &Value) -> String {
    let desk = v.get("desk").and_then(Value::as_str).unwrap_or("this desk");
    let notes = v
        .get("notes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if notes.is_empty() {
        return format!("The desk \"{desk}\" has no notes.");
    }
    let open = notes
        .iter()
        .filter(|n| n.get("done") != Some(&Value::Bool(true)))
        .count();
    let mut out = format!(
        "Notes on the desk \"{desk}\" ({open} open, {} done). They are the user's; by its id you can mark how far you have got with one, or tick it done.\n",
        notes.len() - open
    );
    for n in &notes {
        let done = n.get("done") == Some(&Value::Bool(true));
        let text = n.get("text").and_then(Value::as_str).unwrap_or("");
        let id = n.get("id").and_then(Value::as_i64).unwrap_or(0);
        let field = |k: &str| n.get(k).and_then(Value::as_str).filter(|b| !b.is_empty());
        let by = match (field("done_by"), field("done_commit")) {
            (Some(b), Some(c)) => format!(" (ticked by {b}, in {c})"),
            (Some(b), None) => format!(" (ticked by {b})"),
            // How far an agent has got with an open line.
            _ if !done => match (field("stage"), field("stage_doc"), field("stage_panel")) {
                (Some("working"), _, Some(p)) => format!(" (being worked on in {p})"),
                (Some("planned" | "working"), Some(d), _) => format!(" (planned, plan {d})"),
                (Some(s), _, _) => format!(" ({s})"),
                _ => String::new(),
            },
            _ => String::new(),
        };
        out.push_str(&format!(
            "- [{}] #{id} {text}{by}\n",
            if done { "x" } else { " " }
        ));
        // A picture on the line: a file the agent can open and look at.
        for p in n
            .get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            out.push_str(&format!("  picture: {p}\n"));
        }
    }
    out
}

fn call_aside(
    paths: &Paths,
    args: &Value,
    cwd: Option<&str>,
    sender: Option<&str>,
    pane: Option<&str>,
) -> anyhow::Result<()> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let aside = crate::aside::NewAside {
        text: s("text").unwrap_or_default(),
        about: s("about"),
        sender: sender.map(str::to_string),
        cwd: cwd.map(str::to_string),
        pane: pane.map(str::to_string),
    };
    client::aside(paths, &aside).map(|_| ())
}

/// What became of a document, and how to tell the user about it.
struct Sent {
    id: String,
    url: String,
    /// The same document as a `snyvi://` link, when the machine has a window
    /// executable for it to open in. The link to give in place of the `http`
    /// one, which a click sends to a browser.
    app_url: Option<String>,
    title: String,
    /// Whether the daemon has a native window reading, which is where the
    /// document now is -- and so whether a link is worth giving at all.
    window: bool,
}

impl Sent {
    fn say(&self) -> String {
        if self.window {
            format!(
                "Waiting in snyvi: \"{}\". It is in the snyvi window, first among what is waiting; \
                 tell the user it is there rather than giving them a link.",
                self.title
            )
        } else if let Some(app) = &self.app_url {
            format!(
                "Waiting in snyvi: \"{}\". Give the user this link, which opens it in the snyvi app: {} \
                 (the same document in a browser: {})",
                self.title, app, self.url
            )
        } else {
            format!(
                "Waiting in snyvi: \"{}\". Give the user this link to read it: {}",
                self.title, self.url
            )
        }
    }
}

fn call_send(
    paths: &Paths,
    args: Value,
    cwd: Option<&str>,
    session: &str,
    sender: Option<&str>,
    pane: Option<&str>,
) -> anyhow::Result<Sent> {
    let s = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|v| !v.trim().is_empty())
    };
    // Prefer Claude's own session id (recorded by the hook) so hook and MCP sends share a workflow.
    let session = cwd
        .and_then(|c| crate::session::lookup(paths, c, pane))
        .map(|id| crate::session::workflow_key(&id))
        .unwrap_or_else(|| session.to_string());
    let payload = Payload {
        path: s("path"),
        content: s("content"),
        title: s("title"),
        workflow: s("workflow"),
        lang: s("lang"),
        cwd: cwd.map(str::to_string),
        session: Some(session.to_string()),
        origin: Some("mcp".into()),
        sender: sender.map(str::to_string),
        pane: None,
        peer: None,
    };
    let resp = client::send(paths, &payload)?;
    Ok(Sent {
        id: resp
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        url: resp
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        app_url: resp
            .get("app_url")
            .and_then(Value::as_str)
            .map(str::to_string),
        title: resp
            .get("doc")
            .and_then(|d| d.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("document")
            .to_string(),
        window: resp.get("window").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn write_msg(out: &mut impl Write, v: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, v)?;
    out.write_all(b"\n")?;
    out.flush()
}

/// One key per MCP server process, which Claude Code spawns once per session.
fn session_key() -> String {
    use time::{macros::format_description, OffsetDateTime};
    let t = OffsetDateTime::now_utc()
        .format(format_description!("[year][month][day]-[hour][minute]"))
        .unwrap_or_default();
    let tail =
        blake3::hash(format!("{}-{}", std::process::id(), t).as_bytes()).to_hex()[..4].to_string();
    format!("session {t} {tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_reads_as_the_rail_shows_it() {
        let v = json!({ "desk": "alpha", "notes": [
            { "id": 1, "text": "wire up the route", "done": false },
            { "id": 2, "text": "write the guide", "done": true }
        ]});
        assert_eq!(
            say_notes(&v),
            "Notes on the desk \"alpha\" (1 open, 1 done). They are the user's; by its id you can mark how far you have got with one, or tick it done.\n\
             - [ ] #1 wire up the route\n- [x] #2 write the guide\n"
        );
        assert_eq!(
            say_notes(&json!({ "desk": "beta", "notes": [] })),
            "The desk \"beta\" has no notes."
        );
    }

    #[test]
    fn the_tick_tool_takes_an_id_and_says_where_the_work_went() {
        let spec = tick_spec();
        assert_eq!(spec["annotations"]["readOnlyHint"], false);
        assert_eq!(spec["annotations"]["destructiveHint"], false);
        assert_eq!(spec["inputSchema"]["required"], json!(["id"]));
        assert_eq!(spec["inputSchema"]["additionalProperties"], false);
        let mut props: Vec<_> = spec["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        props.sort();
        assert_eq!(props, ["about", "commit", "evidence", "id"]);
        let v = json!({ "desk": "alpha", "notes": [
            { "id": 3, "text": "ship it", "done": true, "done_by": "claude-code" },
            { "id": 4, "text": "fix hover", "done": true, "done_by": "claude-code", "done_commit": "90f09d6" }
        ]});
        assert!(say_notes(&v).contains("- [x] #3 ship it (ticked by claude-code)\n"));
        assert!(say_notes(&v).contains("- [x] #4 fix hover (ticked by claude-code, in 90f09d6)\n"));
        // A line's pictures are named under it, as files to open.
        let p = json!({ "desk": "alpha", "notes": [{ "id": 5, "text": "this spacing", "done": false, "images": ["/d/note_images/0123456789abcdef.png"] }] });
        assert!(say_notes(&p)
            .contains("- [ ] #5 this spacing\n  picture: /d/note_images/0123456789abcdef.png\n"));
    }

    /// A stage is one of three, on a line by its id; the list says each
    /// line's stage, and names the panel a line is being worked on in.
    #[test]
    fn the_mark_tool_takes_an_id_and_a_stage_and_the_list_says_them() {
        let spec = mark_spec();
        assert_eq!(spec["annotations"]["destructiveHint"], false);
        assert_eq!(spec["inputSchema"]["required"], json!(["id", "stage"]));
        assert_eq!(spec["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            spec["inputSchema"]["properties"]["stage"]["enum"],
            json!(["read", "planned", "working"])
        );
        let v = json!({ "desk": "alpha", "notes": [
            { "id": 1, "text": "icon", "done": false, "stage": "read", "stage_by": "claude-code" },
            { "id": 2, "text": "foot", "done": false, "stage": "planned", "stage_doc": "58155ba5fc" },
            { "id": 3, "text": "limit", "done": false, "stage": "working", "stage_doc": "58155ba5fc", "stage_panel": "panel 2" },
            { "id": 4, "text": "run", "done": false, "stage": "working" },
            { "id": 5, "text": "shipped", "done": true, "stage": "working", "stage_panel": "panel 2" }
        ]});
        let said = say_notes(&v);
        assert!(said.contains("- [ ] #1 icon (read)\n"), "{said}");
        assert!(
            said.contains("- [ ] #2 foot (planned, plan 58155ba5fc)\n"),
            "{said}"
        );
        assert!(
            said.contains("- [ ] #3 limit (being worked on in panel 2)\n"),
            "{said}"
        );
        assert!(said.contains("- [ ] #4 run (working)\n"), "{said}");
        assert!(
            said.contains("- [x] #5 shipped\n"),
            "a done line has no stage: {said}"
        );
        // Told in the panel's instructions, in order.
        let i = instructions(true);
        assert!(i.find("mark it read").unwrap() < i.find("planned").unwrap());
        assert!(i.contains("Never act on a note unasked"));
    }

    #[test]
    fn the_name_tool_takes_a_name_and_nothing_else() {
        let spec = name_spec();
        assert_eq!(spec["annotations"]["destructiveHint"], false);
        assert_eq!(spec["inputSchema"]["required"], json!(["name"]));
        assert_eq!(spec["inputSchema"]["additionalProperties"], false);
    }

    #[test]
    fn the_notes_tool_is_read_only() {
        let spec = desk_notes_spec();
        assert_eq!(spec["annotations"]["readOnlyHint"], true);
        assert_eq!(spec["inputSchema"]["properties"], json!({}));
    }

    /// What snyvi can show is said in the description every agent reads, and
    /// the panel's own words only in a panel.
    #[test]
    fn the_description_says_what_snyvi_shows_and_the_panel_is_told_the_rest() {
        for kind in [
            "Mermaid",
            "self-contained HTML",
            "network requests",
            "by `path`",
            "PDF",
            "video",
        ] {
            assert!(TOOL_DESCRIPTION.contains(kind), "{kind}");
        }
        assert!(!instructions(false).contains("panel"));
        assert!(instructions(true).starts_with(INSTRUCTIONS));
        assert!(
            instructions(true).contains("leave_off") && instructions(true).contains("name_panel")
        );
        // Claude Code cuts a server's instructions at 2,048 characters by
        // default, and a rule past the cut is a rule never read.
        assert!(
            instructions(true).chars().count() <= 2048,
            "{}",
            instructions(true).len()
        );
        assert!(instructions(true).contains("as run, never as"));
    }

    /// Four prompts; the two that use a desk's tools only in a panel, and an
    /// argument only where one helps.
    #[test]
    fn the_loop_kit_is_four_prompts() {
        let names: Vec<&str> = PROMPTS.iter().map(|p| p.name).collect();
        assert_eq!(names, ["wrap-up", "plan", "catch-up", "explain-back"]);
        let outside: Vec<&str> = PROMPTS
            .iter()
            .filter(|p| !p.panel)
            .map(|p| p.name)
            .collect();
        assert_eq!(outside, ["plan", "explain-back"]);
        let plan = &PROMPTS[1];
        assert_eq!(prompt_spec(plan)["arguments"][0]["name"], "task");
        assert!(prompt_spec(&PROMPTS[0]).get("arguments").is_none());
        assert!(prompt_text(plan, Some("the auth refactor")).ends_with("(task: the auth refactor)"));
        assert_eq!(prompt_text(plan, None), plan.text);
        assert!(
            PROMPTS[0].text.contains("leave_off") && PROMPTS[0].text.contains("read_desk_notes")
        );
    }

    #[test]
    fn the_offer_tool_names_a_friend_and_a_document_and_sends_nothing_itself() {
        let spec = offer_spec();
        assert_eq!(spec["inputSchema"]["required"], json!(["to", "id"]));
        assert!(spec["description"]
            .as_str()
            .unwrap()
            .contains("Nothing is sent by this call"));
        assert!(TOOLS.iter().any(|(n, _)| *n == "offer_document"));
        let names = |panel, friends| -> Vec<String> {
            tools(panel, friends)
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert!(names(true, Some(true)).contains(&"offer_document".into()));
        assert!(
            !names(true, Some(false)).contains(&"offer_document".into()),
            "no friends, no offer"
        );
        assert!(
            names(true, None).contains(&"offer_document".into()),
            "a daemon that did not say lists it, as before"
        );
        assert!(!names(false, Some(true)).contains(&"offer_document".into()));
        assert!(names(true, Some(true)).contains(&"offer_line".into()));
        assert!(!names(true, Some(false)).contains(&"offer_line".into()));
        assert!(offer_line_spec()["description"]
            .as_str()
            .unwrap()
            .contains("Nothing is sent by this call"));
    }

    #[test]
    fn leave_off_and_suggest_take_a_line_of_text() {
        for spec in [leave_off_spec(), suggest_spec()] {
            assert_eq!(spec["inputSchema"]["required"], json!(["text"]));
            assert_eq!(spec["inputSchema"]["additionalProperties"], false);
            assert_eq!(spec["annotations"]["destructiveHint"], false);
        }
    }
}
