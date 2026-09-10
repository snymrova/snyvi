//! A stdio MCP server exposing exactly one tool: send_document.
//! Newline-delimited JSON-RPC 2.0, as the MCP stdio transport specifies.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

const TOOL_DESCRIPTION: &str = "Send a finished document to snyvi, the user's document viewer, and get back a link. \
Call this whenever you finish writing a plan, report, review, summary, design note, or any document the user \
will want to read, and whenever the user asks to see a file. Prefer `path` for files you wrote to disk; use \
`content` for text that is not a file (a review, a summary, a diff). Markdown and every kind of source file \
are supported. The document opens in the viewer immediately; include the returned url in your reply so the \
user can click it.";

pub fn run(paths: Paths) -> anyhow::Result<()> {
    let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
    let session = session_key();
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
                write_msg(&mut out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("parse error: {e}") } }))?;
                continue;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        // Notifications have no id and get no reply.
        let Some(id) = id else { continue };
        let reply = match method {
            "initialize" => json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "snyvi", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "snyvi is the user's document viewer. When you produce a document for the user to read, send it with send_document and share the link."
            }}),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [ tool_spec() ] } }),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                if name != "send_document" {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("unknown tool {name}") } })
                } else {
                    match call_send(&paths, args, cwd.as_deref(), &session) {
                        Ok(url) => json!({ "jsonrpc": "2.0", "id": id, "result": {
                            "content": [{ "type": "text", "text": format!("Document is open in snyvi: {url}") }],
                            "structuredContent": { "url": url },
                            "isError": false
                        }}),
                        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "result": {
                            "content": [{ "type": "text", "text": format!("snyvi could not receive the document: {e}") }],
                            "isError": true
                        }}),
                    }
                }
            }
            _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } }),
        };
        write_msg(&mut out, &reply)?;
    }
    Ok(())
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

fn call_send(paths: &Paths, args: Value, cwd: Option<&str>, session: &str) -> anyhow::Result<String> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string).filter(|v| !v.trim().is_empty());
    let payload = Payload {
        path: s("path"),
        content: s("content"),
        title: s("title"),
        workflow: s("workflow"),
        lang: s("lang"),
        cwd: cwd.map(str::to_string),
        session: Some(session.to_string()),
    };
    let resp = client::send(paths, &payload)?;
    Ok(resp.get("url").and_then(Value::as_str).unwrap_or("").to_string())
}

fn write_msg(out: &mut impl Write, v: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, v)?;
    out.write_all(b"\n")?;
    out.flush()
}

/// One key per MCP server process, which Claude Code spawns once per session.
fn session_key() -> String {
    use time::{macros::format_description, OffsetDateTime};
    let t = OffsetDateTime::now_utc().format(format_description!("[year][month][day]-[hour][minute]")).unwrap_or_default();
    let tail = blake3::hash(format!("{}-{}", std::process::id(), t).as_bytes()).to_hex()[..4].to_string();
    format!("session {t} {tail}")
}
