//! Claude Code hooks. `PostToolUse`: when Claude writes or edits a Markdown
//! file, send it. Zero agent cooperation needed. And inside a desk panel, every
//! event that says what Claude is doing -- a prompt, a tool, a permission
//! prompt, the end of a turn -- is told to the panel. Quiet on every path: a
//! hook must never interrupt the session, so failures are swallowed and exit 0.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The events installed for the panel's status. Each one maps to a state in
/// `agent_state`. `PostToolUse` is installed for this too, as an entry of its
/// own on every tool (`matcher: *`), with the same command as every other:
/// a flag here would be read by whatever snyvi the entry names, and one from
/// before the flag existed fails on it, on every tool call. So whether a
/// written file is sent is not the entry's to say but `auto_send`'s.
const STATUS_EVENTS: [&str; 4] = ["UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

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
    // In a desk panel, the panel is told. Outside one, nothing new happens.
    if let Some(state) = agent_state(&event) {
        if let Some(pane) = std::env::var("SNYVI_SESSION")
            .ok()
            .filter(|v| crate::pane::valid_id(v))
        {
            client::agent_state(paths, &pane, state);
        }
    }
    if event.get("hook_event_name").and_then(Value::as_str) != Some("PostToolUse") {
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
    if !wanted(Path::new(file)) || !auto_send() {
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

/// What an event says the agent is doing, or nothing when it says nothing new.
/// Empty is "gone": the session ended. A `PostToolUse` is `working` even
/// straight after a permission prompt, which is exactly what clears
/// `needs_you` once the reader has answered it.
fn agent_state(event: &Value) -> Option<&'static str> {
    match event.get("hook_event_name").and_then(Value::as_str)? {
        "UserPromptSubmit" | "PostToolUse" => Some("working"),
        "Stop" => Some("done"),
        "SessionEnd" => Some(""),
        // A permission prompt needs the reader. The idle reminder a minute
        // after a turn ended does not: the turn is done, and says so already.
        "Notification" => {
            let idle = event.get("notification_type").and_then(Value::as_str)
                == Some("idle_prompt")
                || event
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|m| m.contains("waiting for your input"));
            (!idle).then_some("needs_you")
        }
        _ => None,
    }
}

/// Whether the reader asked for every file Claude writes to be sent: the
/// Write/Edit entry `init-claude --auto` installs is there. Asked only for a
/// write of a file that would be sent, so the settings are read rarely.
fn auto_send() -> bool {
    settings_path()
        .and_then(|p| read_settings(&p))
        .map(|s| installed(&s).iter().any(|(e, _)| *e == "PostToolUse"))
        .unwrap_or(false)
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

/// An entry that runs on every tool: the status one, under `PostToolUse`.
/// The send entry names its tools.
fn every_tool(entry: &Value) -> bool {
    matches!(
        entry.get("matcher").and_then(Value::as_str),
        None | Some("" | "*")
    )
}

/// Merge hooks into ~/.claude/settings.json, preserving everything else in it.
/// SessionStart (session bookkeeping) and the panel's status events are
/// always installed; PostToolUse on Write and Edit (auto-send) only when
/// `auto` is set. A hook already there is kept, and its command
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
    let hook = |c: &str| json!({ "hooks": [{ "type": "command", "command": c, "timeout": 10 }] });
    let mut wanted: Vec<(&str, Value)> = vec![("SessionStart", hook(command))];
    for event in STATUS_EVENTS {
        wanted.push((event, hook(command)));
    }
    wanted.push((
        "PostToolUse",
        json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
    ));
    if auto {
        wanted.push((
            "PostToolUse",
            json!({ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
        ));
    }
    for (event, entry) in wanted {
        let is_status = every_tool(&entry);
        let list = hooks.entry(event).or_insert(json!([]));
        let list = list
            .as_array_mut()
            .with_context(|| format!("{event} is not an array"))?;
        // Two entries of ours can share an event -- PostToolUse -- and are
        // told apart by their matcher.
        let already = list.iter().any(|e| {
            every_tool(e) == is_status
                && e.pointer("/hooks")
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
/// The status-only `PostToolUse` entry is not counted: `PostToolUse` here
/// means auto-send, which is what a reader asks about.
pub fn installed(settings: &Value) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return out;
    };
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "Notification",
        "Stop",
        "SessionEnd",
        "PostToolUse",
    ] {
        let found = hooks
            .get(event)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|e| event != "PostToolUse" || !every_tool(e))
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

/// Bring an install made by an older snyvi up to this one's set of hooks: the
/// daemon does this as it starts, so a reader who ran `init-claude` once gets
/// the panel's status without running it again. Only where a hook of ours is
/// already installed -- a reader who never asked for one is never given one --
/// and with the command and the `--auto` choice that install already made.
///
/// And only when that hook runs this very binary. A second snyvi on the
/// machine -- a build from source, a test, a daemon from before an upgrade --
/// never writes hooks for an install that is not its own: what it would add
/// is run by the other one.
pub fn top_up() -> Result<bool> {
    let path = settings_path()?;
    let mut settings = read_settings(&path)?;
    let have = installed(&settings);
    let Some((_, command)) = have.iter().find(|(e, _)| *e == "SessionStart") else {
        return Ok(false);
    };
    let me = std::env::current_exe().ok();
    if !me.is_some_and(|me| runs(command, &me)) {
        return Ok(false);
    }
    let auto = have.iter().any(|(e, _)| *e == "PostToolUse");
    let (changed, _) = install_into(&mut settings, &command.clone(), auto)?;
    if changed {
        write_settings(&path, &settings)?;
    }
    Ok(changed)
}

/// Whether a hook command runs the binary at `exe`: its program, found on
/// PATH when it is a bare name, is the same file.
fn runs(command: &str, exe: &Path) -> bool {
    let program = command.trim_end_matches(" hook").trim_matches('"');
    let program = if Path::new(program).components().count() == 1 {
        crate::platform::find_on_path(program)
    } else {
        Some(PathBuf::from(program))
    };
    let real = |p: &Path| std::fs::canonicalize(p).ok();
    match (program.as_deref().and_then(real), real(exe)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
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
    fn each_event_says_what_the_agent_is_doing() {
        let ev = |e: &str| json!({ "hook_event_name": e });
        assert_eq!(agent_state(&ev("UserPromptSubmit")), Some("working"));
        assert_eq!(agent_state(&ev("PostToolUse")), Some("working"));
        assert_eq!(agent_state(&ev("Stop")), Some("done"));
        assert_eq!(agent_state(&ev("SessionEnd")), Some(""));
        assert_eq!(agent_state(&ev("SessionStart")), None);
        assert_eq!(
            agent_state(
                &json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt",
                "message": "Claude needs your permission to use Bash" })
            ),
            Some("needs_you")
        );
        // The idle reminder after a turn is not the reader being needed.
        assert_eq!(
            agent_state(
                &json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt" })
            ),
            None
        );
        assert_eq!(
            agent_state(&json!({ "hook_event_name": "Notification",
                "message": "Claude is waiting for your input" })),
            None
        );
    }

    const ALL: [&str; 5] = [
        "SessionStart",
        "UserPromptSubmit",
        "Notification",
        "Stop",
        "SessionEnd",
    ];

    #[test]
    fn install_is_idempotent_and_follows_the_binary() {
        let mut s = json!({ "theme": "dark", "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "other --x" }] } ] } });
        let (changed, rewritten) = install_into(&mut s, "/opt/snyvi hook", false).unwrap();
        assert!(changed && !rewritten);
        assert_eq!(
            installed(&s),
            ALL.map(|e| (e, "/opt/snyvi hook".to_string())).to_vec()
        );
        // The status entry runs on every tool, and never sends.
        let post = s["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2);
        assert_eq!(post[1]["matcher"], "*");
        assert_eq!(post[1]["hooks"][0]["command"], "/opt/snyvi hook");
        // And it does not count as auto-send.
        assert!(!installed(&s).iter().any(|(e, _)| *e == "PostToolUse"));
        // Again, with the same binary: nothing to do.
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", false).unwrap(),
            (false, false)
        );
        // --auto adds the send entry beside the status one; nothing else moves.
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", true).unwrap(),
            (true, false)
        );
        assert_eq!(installed(&s).len(), 6);
        assert_eq!(s["hooks"]["PostToolUse"].as_array().unwrap().len(), 3);
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", true).unwrap(),
            (false, false)
        );
        // The binary moved: every hook follows it, and --auto is not needed
        // to say so.
        assert_eq!(
            install_into(&mut s, "snyvi hook", false).unwrap(),
            (true, true)
        );
        assert!(installed(&s).iter().all(|(_, c)| c == "snyvi hook"));
        assert_eq!(installed(&s).last().unwrap().0, "PostToolUse");
        assert_eq!(
            s["hooks"]["PostToolUse"][1]["hooks"][0]["command"],
            "snyvi hook"
        );
        assert_eq!(
            s["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "other --x"
        );
    }

    /// An install from before the panel's status: SessionStart alone, or with
    /// the send entry. Topping it up adds the status hooks and keeps the choice.
    #[test]
    fn an_older_install_is_topped_up_with_its_own_choices() {
        let mut old = json!({ "hooks": {
            "SessionStart": [{ "hooks": [{ "type": "command", "command": "/usr/bin/snyvi hook" }] }],
            "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit",
                "hooks": [{ "type": "command", "command": "/usr/bin/snyvi hook" }] }] } });
        let have = installed(&old);
        assert_eq!(have.len(), 2);
        assert!(
            install_into(&mut old, "/usr/bin/snyvi hook", true)
                .unwrap()
                .0
        );
        assert_eq!(installed(&old).len(), 6);
        assert_eq!(old["hooks"]["PostToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(old["hooks"]["PostToolUse"][1]["matcher"], "*");
    }

    /// A build from source never tops up the hooks of an installed snyvi:
    /// what it would write is run by the other binary.
    #[test]
    fn only_the_binary_a_hook_names_tops_it_up() {
        let me = std::env::current_exe().unwrap();
        let line = command_line(&me.to_string_lossy());
        assert!(runs(&line, &me));
        let dir = crate::store::tempdir::Dir::new("snyvi-hook-bin");
        let other = dir.path.join("snyvi");
        std::fs::write(&other, b"").unwrap();
        assert!(!runs(&command_line(&other.to_string_lossy()), &me));
        assert!(!runs("/nowhere/snyvi hook", &me));
    }

    #[test]
    fn uninstall_leaves_what_it_found() {
        let before = json!({ "theme": "dark", "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "other --x" }] } ] } });
        let mut s = before.clone();
        install_into(&mut s, "/opt/snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 7);
        assert_eq!(s, before);
        // A file that had only ours goes back to having no hooks key at all.
        let mut s = json!({ "theme": "dark" });
        install_into(&mut s, "snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 7);
        assert_eq!(s, json!({ "theme": "dark" }));
        assert_eq!(remove_from(&mut s), 0);
    }
}
