//! A board (1.58, docs/BOARD.md): frames the agent draws in the desk's
//! `design/<board>/`, which the reader watches arrive beside its panel, and
//! `read_focus`, where the reader is in the desk's view. The skill's
//! `board.md` is how to work at one.

use super::{arg, said, Session};
use crate::client;
use serde_json::{json, Value};

const READ: &str = "Read a board on this snyvi desk: its frames (id, size, place, version), what the user has \
selected on it, and the design's tokens and DESIGN.md's first paragraph. Read it before the first frame, and \
before acting on \"this\" or \"these\": the selection is what they mean. A board is design/<board>/ in the \
desk's folder; frame_write makes one. Pass `since` (the last read's hash) to learn only whether it changed.";

const WRITE: &str = "Draw one frame on a board in this snyvi desk, whole: a self-contained HTML fragment (CSS \
inline, tokens as var(--…) with tokens.css's :root copied in, no network), 300 to 3,000 bytes, at a size in \
CSS pixels. The user, watching the board, sees it arrive. A frame is rewritten whole; a write to the same frame \
within 20 s is the same version. Show options as several frames side by side (hero-a, hero-b), not as prose. \
`html: null` hides a frame: its file and versions stay, and say so. Look at what you drew before saying done \
(frame_look).";

const ARRANGE: &str =
    "Move, reorder or name frames on a board in this snyvi desk, or name the board, or make a frame \
live with `source` (`threads`: what shipped and what was told, posted into the frame by snyvi). Only \
frames already on it; an unknown id is refused.";

const LOOK: &str = "See a frame on a board in this snyvi desk as the window draws it. Until snyvi can, it answers \
with the file and size to render yourself (Playwright, or chromium --headless --screenshot): do that, and read \
the picture, before saying a frame is done.";

const EXPORT: &str =
    "Write one HTML page of every shown frame of a board in this snyvi desk, in order, to \
design/<board>.html: a file to keep or send. To show it to the user, send_document it.";

const FOCUS: &str = "Where the user is in this snyvi desk's view right now: the Folder view's file and lines, or \
the frames selected on a board. Read it before acting on \"this\", \"here\" or \"the left one\". Null when they are \
on the panels.";

/// 1.60 (plan 586c0491b6): a view opened for the reader, after they said yes.
const OPEN_VIEW: &str = "Open a view of this snyvi desk on the user's screen: its panels, its folder (at a file in it, \
`path`), its page, or a board (board:<name>). Ask the user first, every time, and call this only after they said yes in \
this conversation: a yes is for that one opening, not the rest of the session. Use it when they would need the view to \
follow you -- a file you changed, a board you drew. It opens only while they are looking at this desk; it types, runs and \
sends nothing.";

fn board_prop() -> Value {
    json!({ "type": "string", "description": "The board's name: design/<board>/. Default home." })
}

fn frame_prop() -> Value {
    json!({ "type": "string", "description": "The frame's id: lowercase letters, digits, hyphens (hero, cards-2)." })
}

fn annotations(read: bool) -> Value {
    json!({ "readOnlyHint": read, "destructiveHint": false, "idempotentHint": read, "openWorldHint": false })
}

pub(super) fn specs() -> Vec<Value> {
    vec![
        json!({ "name": "board_read", "title": "Read a board", "description": READ,
            "inputSchema": { "type": "object", "properties": { "board": board_prop(),
                "since": { "type": "string", "description": "The hash from the last board_read." } },
                "additionalProperties": false }, "annotations": annotations(true) }),
        json!({ "name": "frame_write", "title": "Draw a frame", "description": WRITE,
            "inputSchema": { "type": "object", "properties": { "board": board_prop(), "frame": frame_prop(),
                "html": { "type": ["string", "null"], "description": "The frame's HTML, whole; null hides it." },
                "w": { "type": "integer", "minimum": 1, "maximum": 4000, "description": "Width in CSS px. Default 800, or its last." },
                "h": { "type": "integer", "minimum": 1, "maximum": 4000, "description": "Height in CSS px. Default 600, or its last." },
                "x": { "type": "integer", "description": "Left on the board; a new frame goes right of the rest." },
                "y": { "type": "integer", "description": "Top on the board." } },
                "required": ["frame", "html"], "additionalProperties": false }, "annotations": annotations(false) }),
        json!({ "name": "board_arrange", "title": "Arrange a board", "description": ARRANGE,
            "inputSchema": { "type": "object", "properties": { "board": board_prop(),
                "frames": { "type": "array", "maxItems": 100, "items": { "type": "object", "properties": {
                    "id": frame_prop(), "x": { "type": "integer" }, "y": { "type": "integer" },
                    "order": { "type": "integer" }, "name": { "type": "string" },
                    "source": { "type": "string", "enum": ["threads", ""], "description": "A live frame: snyvi posts this source's numbers into it (board.md, A live frame); empty takes it off." } },
                    "required": ["id"], "additionalProperties": false } },
                "name": { "type": "string", "description": "The board's title." } },
                "additionalProperties": false }, "annotations": annotations(false) }),
        json!({ "name": "frame_look", "title": "Look at a frame", "description": LOOK,
            "inputSchema": { "type": "object", "properties": { "board": board_prop(), "frame": frame_prop() },
                "required": ["frame"], "additionalProperties": false }, "annotations": annotations(true) }),
        json!({ "name": "board_export", "title": "Export a board", "description": EXPORT,
            "inputSchema": { "type": "object", "properties": { "board": board_prop() },
                "additionalProperties": false }, "annotations": annotations(false) }),
        json!({ "name": "read_focus", "title": "Where the user is", "description": FOCUS,
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": annotations(true) }),
        json!({ "name": "open_view", "title": "Open a view, once asked", "description": OPEN_VIEW,
            "inputSchema": { "type": "object", "properties": {
                "view": { "type": "string", "description": "panels, folder, page, or board:<name>." },
                "path": { "type": "string", "description": "With folder: a file, relative to the desk's folder (src/limit.rs)." } },
                "required": ["view"], "additionalProperties": false },
            "annotations": annotations(false) }),
    ]
}

/// What the daemon said, for a refusal: its `error`, or the status.
fn refusal(status: u16, v: &Value) -> String {
    v.get("error")
        .and_then(Value::as_str)
        .map_or_else(|| format!("snyvi answered {status}"), str::to_string)
}

/// A board's frames, its selection and its look, said for an agent to act on.
fn say_board(v: &Value) -> String {
    let id = v["id"].as_str().unwrap_or("");
    let frames = v["frames"].as_array().cloned().unwrap_or_default();
    let shown: Vec<&Value> = frames
        .iter()
        .filter(|f| f["hidden"] != json!(true))
        .collect();
    let mut out = format!(
        "Board \"{}\" ({}): {} frame(s){}.\n",
        v["name"].as_str().unwrap_or(id),
        v["path"].as_str().unwrap_or(""),
        shown.len(),
        match frames.len() - shown.len() {
            0 => String::new(),
            n => format!(", {n} hidden"),
        }
    );
    for f in &frames {
        out.push_str(&format!(
            "- {} {}×{} at ({}, {}), v{}, {} bytes{}{}\n",
            f["id"].as_str().unwrap_or(""),
            f["w"],
            f["h"],
            f["x"],
            f["y"],
            f["versions"].as_u64().unwrap_or(0).max(1),
            f["bytes"],
            if f["hidden"] == json!(true) {
                ", hidden"
            } else {
                ""
            },
            if f["missing"] == json!(true) {
                ", its file is gone"
            } else {
                ""
            },
        ));
    }
    // A live frame's numbers (1.61, C7), the same the window posts into it,
    // so a digest says real ones.
    if let Some(live) = v["live"].as_object() {
        for (id, n) in live {
            out.push_str(&format!(
                "Live in {id} (threads): {} shipped, {} told ({}%){}.\n",
                n["shipped"],
                n["told"],
                n["share"],
                n["median_hours"]
                    .as_i64()
                    .map(|h| format!(", median {h} h from merge to told"))
                    .unwrap_or_default()
            ));
        }
    }
    let picked: Vec<String> = v["focus"]["items"]
        .as_array()
        .filter(|_| v["focus"]["view"].as_str() == Some(&format!("board:{id}")))
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    out.push_str(&if picked.is_empty() {
        "Selected by the user: nothing.\n".to_string()
    } else {
        format!(
            "Selected by the user: {}. \"This\" means those.\n",
            picked.join(", ")
        )
    });
    if let Some(d) = v["tokens"]["design"].as_str() {
        out.push_str(&format!("DESIGN.md: {d}\n"));
    }
    let vars: Vec<String> = v["tokens"]["vars"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some(format!("{}: {}", p[0].as_str()?, p[1].as_str()?)))
                .collect()
        })
        .unwrap_or_default();
    if !vars.is_empty() {
        out.push_str(&format!(
            "Tokens (design/tokens.css): {}\n",
            vars.join("; ")
        ));
    }
    out.push_str(&format!("hash: {}", v["hash"].as_str().unwrap_or("")));
    out
}

impl Session {
    /// This pane, and the board and frame a call names, checked here as the
    /// daemon checks them: a name is part of the route, so one that is not a
    /// name never becomes one.
    fn on_board(&self, args: &Value, frame: bool) -> Result<(String, String, String), Value> {
        let Some(p) = self.pane.clone() else {
            return Err(said(
                "This session is not running in a snyvi desk, so there is no board here.",
                true,
            ));
        };
        let board = match arg(args, "board") {
            b if b.is_empty() => "home".to_string(),
            b => b,
        };
        let f = arg(args, "frame");
        if !crate::board::valid_name(&board) || (frame && !crate::board::valid_name(&f)) {
            return Err(said(
                "A board's name and a frame's id are lowercase letters, digits and hyphens, like home or hero-2.",
                true,
            ));
        }
        Ok((p, board, f))
    }

    pub(super) fn board_read(&self, args: &Value) -> Value {
        let (p, board, _) = match self.on_board(args, false) {
            Ok(x) => x,
            Err(no) => return no,
        };
        let since = arg(args, "since");
        let q = if since.chars().all(|c| c.is_ascii_hexdigit()) && !since.is_empty() {
            format!("?since={since}")
        } else {
            String::new()
        };
        match client::pane_board(&self.paths, &p, &format!("board/{board}{q}"), None) {
            Ok((200, v)) if v["unchanged"] == json!(true) => {
                said("The board has not changed.", false)
            }
            Ok((200, v)) => said(say_board(&v), false),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn frame_write(&self, args: &Value) -> Value {
        let (p, board, frame) = match self.on_board(args, true) {
            Ok(x) => x,
            Err(no) => return no,
        };
        if args.get("html").is_some_and(Value::is_null) {
            let path = format!("board/{board}/frames/{frame}/hide");
            return match client::pane_board(&self.paths, &p, &path, Some(json!({ "hidden": true }))) {
                Ok((200, _)) => said(
                    format!("Hid {frame} on {board}. Its file and every version are kept; tell the user it is hidden, not gone."),
                    false,
                ),
                Ok((s, v)) => said(refusal(s, &v), true),
                Err(e) => said(format!("snyvi did not answer: {e}"), true),
            };
        }
        let Some(html) = args.get("html").and_then(Value::as_str) else {
            return said(
                "frame_write needs `html`: the frame whole, or null to hide it.",
                true,
            );
        };
        let mut body = json!({ "html": html });
        for k in ["w", "h", "x", "y"] {
            if let Some(n) = args.get(k).and_then(Value::as_i64) {
                body[k] = json!(n);
            }
        }
        let path = format!("board/{board}/frames/{frame}");
        match client::pane_board(&self.paths, &p, &path, Some(body)) {
            Ok((201, v)) => said(
                format!(
                    "Drew {frame} on {board} ({}){}. Look at it with frame_look before saying it is done.",
                    v["path"].as_str().unwrap_or(""),
                    if v["same_version"] == json!(true) { ", the same version as your last write" } else { ", a new version" }
                ),
                false,
            ),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn board_arrange(&self, args: &Value) -> Value {
        let (p, board, _) = match self.on_board(args, false) {
            Ok(x) => x,
            Err(no) => return no,
        };
        let body = json!({
            "frames": args.get("frames").cloned().unwrap_or(json!([])),
            "name": args.get("name").and_then(Value::as_str),
        });
        match client::pane_board(
            &self.paths,
            &p,
            &format!("board/{board}/arrange"),
            Some(body),
        ) {
            Ok((200, v)) => said(
                format!(
                    "Arranged.\n{}",
                    say_board(&json!({
                        "id": board, "name": v["board"]["name"], "frames": v["board"]["frames"],
                        "path": format!("design/{board}"),
                    }))
                ),
                false,
            ),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn frame_look(&self, args: &Value) -> Value {
        let (p, board, frame) = match self.on_board(args, true) {
            Ok(x) => x,
            Err(no) => return no,
        };
        let path = format!("board/{board}/look/{frame}");
        match client::pane_board(&self.paths, &p, &path, Some(json!({}))) {
            // Not an error to the agent: what to do instead, which it does.
            Ok((501, v)) => said(refusal(501, &v), false),
            Ok((200, v)) => said(v.to_string(), false),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn board_export(&self, args: &Value) -> Value {
        let (p, board, _) = match self.on_board(args, false) {
            Ok(x) => x,
            Err(no) => return no,
        };
        match client::pane_board(&self.paths, &p, &format!("board/{board}/export"), None) {
            Ok((200, v)) => said(
                format!(
                    "Wrote {}. send_document it to show the user.",
                    v["path"].as_str().unwrap_or("")
                ),
                false,
            ),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn open_view(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said("This session is not running in a snyvi desk.", true);
        };
        let s = |k: &str| {
            args.get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let body = json!({ "view": s("view"), "path": s("path") });
        match client::pane_board(&self.paths, p, "view", Some(body)) {
            Ok((200, v)) => said(
                v["line"]
                    .as_str()
                    .unwrap_or("Asked snyvi to open it.")
                    .to_string(),
                v["opened"] == json!(false),
            ),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }

    pub(super) fn read_focus(&self, _args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said("This session is not running in a snyvi desk.", true);
        };
        match client::pane_board(&self.paths, p, "focus", None) {
            Ok((200, v)) => said(
                v["line"]
                    .as_str()
                    .unwrap_or("The user is on the desk's panels, in no view.")
                    .to_string(),
                false,
            ),
            Ok((s, v)) => said(refusal(s, &v), true),
            Err(e) => said(format!("snyvi did not answer: {e}"), true),
        }
    }
}
