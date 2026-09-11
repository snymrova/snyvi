//! Claude Code `PostToolUse` hook: when Claude writes or edits a Markdown file,
//! send it. Zero agent cooperation needed. Quiet on every path: a hook must
//! never interrupt the session, so failures are swallowed and exit 0.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn run(paths: &Paths) -> Result<()> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return Ok(());
    };
    // Any event carrying cwd and session_id keeps the session map fresh, so the MCP
    // server can file its documents under the same workflow as the hook.
    if let (Some(cwd), Some(sid)) = (
        event.get("cwd").and_then(Value::as_str),
        event.get("session_id").and_then(Value::as_str),
    ) {
        crate::session::record(paths, cwd, sid);
    }
    if event.get("hook_event_name").and_then(Value::as_str) == Some("SessionStart") {
        return Ok(());
    }
    let tool = event.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !matches!(tool, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
        return Ok(());
    }
    let Some(file) = event
        .pointer("/tool_input/file_path")
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    if !wanted(Path::new(file)) {
        return Ok(());
    }
    let payload = Payload {
        path: Some(file.to_string()),
        cwd: event.get("cwd").and_then(Value::as_str).map(str::to_string),
        session: event
            .get("session_id")
            .and_then(Value::as_str)
            .map(crate::session::workflow_key),
        origin: Some("hook".into()),
        ..Default::default()
    };
    // Errors are deliberately ignored: the hook must not break Claude's turn.
    let _ = client::send(paths, &payload);
    Ok(())
}

/// Extensions to send, comma separated. Default: Markdown only.
fn wanted(path: &Path) -> bool {
    let exts = std::env::var("SNYVI_HOOK_EXT").unwrap_or_else(|_| "md,markdown".into());
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let skip = path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some(".git" | "node_modules" | "target" | ".snyvi")
        )
    });
    !skip && exts.split(',').any(|e| e.trim().eq_ignore_ascii_case(&ext))
}

/// Merge hooks into ~/.claude/settings.json, preserving everything else in it.
/// SessionStart (session bookkeeping) is always installed; PostToolUse (auto-send)
/// only when `auto` is set.
pub fn install(exe: &str, auto: bool) -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    let path = home.join(".claude").join("settings.json");
    let mut settings: Value = match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).context("parsing ~/.claude/settings.json")?
        }
        _ => json!({}),
    };
    let command = format!("{exe} hook");
    let hooks = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert(json!({}));
    let hooks = hooks.as_object_mut().context("hooks is not an object")?;
    let mut wanted: Vec<(&str, Value)> = vec![(
        "SessionStart",
        json!({ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
    )];
    if auto {
        wanted.push((
            "PostToolUse",
            json!({ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
        ));
    }
    for (event, entry) in wanted {
        let list = hooks.entry(event).or_insert(json!([]));
        let list = list
            .as_array_mut()
            .with_context(|| format!("{event} is not an array"))?;
        let already = list.iter().any(|e| {
            e.pointer("/hooks")
                .and_then(Value::as_array)
                .map(|hs| {
                    hs.iter().any(|h| {
                        h.get("command")
                            .and_then(Value::as_str)
                            .map(|c| c.ends_with(" hook") && c.contains("snyvi"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });
        if !already {
            list.push(entry);
        }
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_string_pretty(&settings)?)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_filter() {
        assert!(wanted(Path::new("/p/PLAN.md")));
        assert!(wanted(Path::new("/p/notes.MD")));
        assert!(!wanted(Path::new("/p/main.rs")));
        assert!(!wanted(Path::new("/p/node_modules/x/README.md")));
        assert!(!wanted(Path::new("/p/.git/x.md")));
    }
}
