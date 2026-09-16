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
        sender: Some("claude-code".into()),
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

/// The hook line as it goes into settings.json: a string that something else
/// will split, so quoted only when it has to be -- on Windows the binary
/// usually lives under a path with a space in it.
pub fn command_line(program: &str) -> String {
    if program.contains(' ') {
        format!("\"{program}\" hook")
    } else {
        format!("{program} hook")
    }
}

pub fn settings_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join(".claude").join("settings.json"))
}

pub fn read_settings(path: &Path) -> Result<Value> {
    Ok(match std::fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => {
            serde_json::from_str(&s).context("parsing ~/.claude/settings.json")?
        }
        _ => json!({}),
    })
}

fn write_settings(path: &Path, settings: &Value) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

/// A hook entry of ours, whatever path it was written with.
fn ours(h: &Value) -> bool {
    h.get("command")
        .and_then(Value::as_str)
        .map(|c| c.ends_with(" hook") && c.contains("snyvi"))
        .unwrap_or(false)
}

/// Merge hooks into ~/.claude/settings.json, preserving everything else in it.
/// SessionStart (session bookkeeping) is always installed; PostToolUse (auto-send)
/// only when `auto` is set. A hook already there is kept, and its command
/// rewritten when it names a binary other than this one: that is what an
/// update or a moved install looks like, and a hook pointing at a path that
/// is gone fails silently, on every tool call, forever.
///
/// Returns the file, the events now carrying a hook, and whether an existing
/// hook's command was rewritten.
pub fn install(command: &str, auto: bool) -> Result<(PathBuf, Vec<&'static str>, bool)> {
    let path = settings_path()?;
    let mut settings = read_settings(&path)?;
    let (changed, rewritten) = install_into(&mut settings, command, auto)?;
    if changed {
        write_settings(&path, &settings)?;
    }
    let events = installed(&settings).into_iter().map(|(e, _)| e).collect();
    Ok((path, events, rewritten))
}

/// The merge itself, on the parsed file. Returns (anything changed, a
/// command was rewritten).
pub fn install_into(settings: &mut Value, command: &str, auto: bool) -> Result<(bool, bool)> {
    let hooks = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert(json!({}));
    let hooks = hooks.as_object_mut().context("hooks is not an object")?;
    let mut changed = false;
    let mut rewritten = false;
    // Every hook of ours, under any event, points at this binary from now on.
    for (_, list) in hooks.iter_mut() {
        let Some(list) = list.as_array_mut() else {
            continue;
        };
        for entry in list.iter_mut() {
            let Some(hs) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            for h in hs.iter_mut().filter(|h| ours(h)) {
                if h.get("command").and_then(Value::as_str) != Some(command) {
                    h["command"] = json!(command);
                    changed = true;
                    rewritten = true;
                }
            }
        }
    }
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
                .map(|hs| hs.iter().any(ours))
                .unwrap_or(false)
        });
        if !already {
            list.push(entry);
            changed = true;
        }
    }
    Ok((changed, rewritten))
}

/// Every event carrying a hook of ours, with the command it was written with.
pub fn installed(settings: &Value) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return out;
    };
    for event in ["SessionStart", "PostToolUse"] {
        let found = hooks
            .get(event)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|e| e.get("hooks").and_then(Value::as_array))
            .flatten()
            .find(|h| ours(h))
            .and_then(|h| h.get("command").and_then(Value::as_str))
            .map(str::to_string);
        if let Some(c) = found {
            out.push((event, c));
        }
    }
    out
}

/// Take every hook of ours out of ~/.claude/settings.json, and nothing else:
/// an entry that also carried someone else's hook keeps that one, an event
/// left with no entries is dropped, and so is an empty `hooks` object, so a
/// file that had nothing but ours goes back to what it was before.
pub fn uninstall() -> Result<(PathBuf, usize)> {
    let path = settings_path()?;
    let mut settings = read_settings(&path)?;
    let n = remove_from(&mut settings);
    if n > 0 {
        write_settings(&path, &settings)?;
    }
    Ok((path, n))
}

pub fn remove_from(settings: &mut Value) -> usize {
    let mut removed = 0;
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return 0;
    };
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        let Some(list) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        for entry in list.iter_mut() {
            if let Some(hs) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
                let before = hs.len();
                hs.retain(|h| !ours(h));
                removed += before - hs.len();
            }
        }
        list.retain(|e| {
            e.get("hooks")
                .and_then(Value::as_array)
                .map(|hs| !hs.is_empty())
                .unwrap_or(true)
        });
        if list.is_empty() {
            hooks.remove(&event);
        }
    }
    if hooks.is_empty() {
        settings.as_object_mut().map(|o| o.remove("hooks"));
    }
    removed
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

    #[test]
    fn install_is_idempotent_and_follows_the_binary() {
        let mut s = json!({ "theme": "dark", "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "other --x" }] } ] } });
        let (changed, rewritten) = install_into(&mut s, "/opt/snyvi hook", false).unwrap();
        assert!(changed && !rewritten);
        assert_eq!(
            installed(&s),
            vec![("SessionStart", "/opt/snyvi hook".to_string())]
        );
        // Again, with the same binary: nothing to do.
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", false).unwrap(),
            (false, false)
        );
        // --auto adds the second event; the first is left alone.
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", true).unwrap(),
            (true, false)
        );
        assert_eq!(installed(&s).len(), 2);
        assert_eq!(s["hooks"]["PostToolUse"].as_array().unwrap().len(), 2);
        // The binary moved: both hooks follow it, and --auto is not needed to say so.
        assert_eq!(
            install_into(&mut s, "snyvi hook", false).unwrap(),
            (true, true)
        );
        assert_eq!(
            installed(&s),
            vec![
                ("SessionStart", "snyvi hook".to_string()),
                ("PostToolUse", "snyvi hook".to_string())
            ]
        );
        assert_eq!(
            s["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "other --x"
        );
    }

    #[test]
    fn uninstall_leaves_what_it_found() {
        let before = json!({ "theme": "dark", "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "other --x" }] } ] } });
        let mut s = before.clone();
        install_into(&mut s, "/opt/snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 2);
        assert_eq!(s, before);
        // A file that had only ours goes back to having no hooks key at all.
        let mut s = json!({ "theme": "dark" });
        install_into(&mut s, "snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 2);
        assert_eq!(s, json!({ "theme": "dark" }));
        assert_eq!(remove_from(&mut s), 0);
    }
}
