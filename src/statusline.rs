//! `snyvi statusline`: Claude Code's status line command, run after every
//! reply with the session as JSON on stdin. Hooks carry no token counts; this
//! does -- the model's name and how full its context window is -- so in a
//! desk panel it tells the panel, and the panel's head, its rail row and the
//! desk's row in the sidebar can say "Fable 5.1 · 43%".
//!
//! It prints nothing: the line exists to feed snyvi, and Claude Code's own
//! bottom line stays as empty as it was. A reader who had a status line of
//! their own keeps it: `init-claude` saves that entry beside the config
//! (`statusline-before.json`), this runs it with the same JSON and prints what
//! it prints, and `uninstall-claude` puts it back. The command in
//! settings.json stays plain `snyvi statusline`, under the rule the hooks
//! follow: never another binary's path, never a shell line built from the
//! reader's.
//!
//! Quiet on every path, like the hook: Claude Code runs it after every reply,
//! so it exits 0 whatever happens and waits on the daemon no longer than the
//! hook's client call does.

use crate::client;
use crate::config::Paths;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// What one status line payload says that snyvi keeps.
#[derive(Debug, Default, PartialEq)]
pub struct Seen {
    pub session: Option<String>,
    pub cwd: Option<String>,
    /// `model.display_name`, or the agent's name when Claude runs `--agent`.
    pub model: String,
    /// `context_window.used_percentage`, 0 to 100.
    pub pct: Option<u8>,
    /// `context_window.context_window_size`, in tokens.
    pub size: Option<u64>,
    /// `context_window.total_input_tokens`.
    pub input: Option<u64>,
    /// The tokens in the window now: `current_usage`'s input, cache writes
    /// and cache reads (its output is not in the window yet). Before the
    /// first call and right after `/compact` there is no `current_usage`, and
    /// `total_input_tokens` stands in.
    pub used: Option<u64>,
    /// `rate_limits.five_hour` and `seven_day`: how much of the account's
    /// window is used, 0 to 100, and when it resets (Unix seconds). Only for
    /// a Pro or Max account, and only after the session's first reply; either
    /// may be absent. The spend limit a gateway sets is not read.
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
}

/// One rate-limit window, as the status line gives it.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Limit {
    pub used: f64,
    pub resets_at: i64,
}

/// Read the payload. Every field is optional, as it is in Claude Code's own
/// docs; a payload with none of them is simply nothing to tell.
pub fn read(v: &Value) -> Seen {
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    let n = |p: &str| v.pointer(p).and_then(Value::as_f64);
    let tokens = |p: &str| {
        n(p).filter(|x| x.is_finite() && *x >= 0.0)
            .map(|x| x as u64)
    };
    let now = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .map(|k| tokens(&format!("/context_window/current_usage/{k}")));
    let input = tokens("/context_window/total_input_tokens");
    let agent = s("/agent/name").filter(|a| !a.trim().is_empty());
    let model = s("/model/display_name").unwrap_or_default();
    let model = match agent {
        Some(a) if !model.is_empty() => format!("{a} · {model}"),
        Some(a) => a,
        None => model,
    };
    Seen {
        session: s("/session_id").filter(|x| crate::desk::valid_session(x)),
        cwd: s("/cwd").or_else(|| s("/workspace/current_dir")),
        model: clean(&model),
        pct: n("/context_window/used_percentage")
            .filter(|p| p.is_finite())
            .map(|p| p.clamp(0.0, 100.0).round() as u8),
        size: n("/context_window/context_window_size")
            .filter(|x| x.is_finite() && *x > 0.0)
            .map(|x| x as u64),
        input,
        used: match now.iter().any(Option::is_some) {
            true => Some(now.iter().flatten().sum()),
            false => input,
        },
        five_hour: limit(v, "five_hour"),
        seven_day: limit(v, "seven_day"),
    }
}

fn limit(v: &Value, window: &str) -> Option<Limit> {
    let used = v
        .pointer(&format!("/rate_limits/{window}/used_percentage"))
        .and_then(Value::as_f64)
        .filter(|p| p.is_finite())?;
    let resets_at = v
        .pointer(&format!("/rate_limits/{window}/resets_at"))
        .and_then(Value::as_f64)
        .filter(|t| t.is_finite() && *t > 0.0)? as i64;
    Some(Limit {
        used: used.clamp(0.0, 100.0),
        resets_at,
    })
}

/// A name for one line of a head: printable, one line, short.
pub fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(48)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn run(paths: &Paths) -> anyhow::Result<()> {
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        return Ok(());
    }
    // The reader's own line first, so what they see is never late for snyvi.
    if let Some(cmd) = saved_command(&before_path(paths)) {
        chain(&cmd, &input);
    }
    let Ok(v) = serde_json::from_slice::<Value>(&input) else {
        return Ok(());
    };
    let seen = read(&v);
    if let (Some(cwd), Some(sid)) = (&seen.cwd, &seen.session) {
        crate::session::record(paths, cwd, sid);
    }
    if let Some(pane) = std::env::var("SNYVI_SESSION")
        .ok()
        .filter(|p| crate::pane::valid_id(p))
    {
        client::agent_context(paths, &pane, &seen);
    }
    Ok(())
}

/// Where the reader's own status line is kept while snyvi's stands in for it.
pub fn before_path(paths: &Paths) -> PathBuf {
    paths.config_dir.join("statusline-before.json")
}

/// The command of the saved entry, when there is one and it is a command.
pub fn saved_command(path: &Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let c = v.get("command")?.as_str()?.trim();
    (!c.is_empty()).then(|| c.to_string())
}

/// Run the reader's own command as Claude Code would have: through the
/// shell, the JSON on stdin, its output printed unchanged.
fn chain(cmd: &str, input: &[u8]) {
    #[cfg(windows)]
    let mut c = std::process::Command::new("cmd");
    #[cfg(windows)]
    c.args(["/C", cmd]);
    #[cfg(not(windows))]
    let mut c = std::process::Command::new("sh");
    #[cfg(not(windows))]
    c.args(["-c", cmd]);
    let Ok(mut child) = c
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    if let Ok(out) = child.wait_with_output() {
        let _ = std::io::stdout().write_all(&out.stdout);
    }
}

/// A status line entry of ours, whatever path it was written with.
pub fn ours(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.ends_with(" statusline") && c.contains("snyvi"))
}

/// Put ours in `settings.statusLine`, keeping a reader's own in `before`
/// (written only when there is one to keep). An entry of ours already there
/// is pointed at `command`. Returns whether the settings changed.
pub fn install_into(settings: &mut Value, command: &str, before: &Path) -> anyhow::Result<bool> {
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("settings.json is not an object"))?;
    let mut ours_now = serde_json::json!({ "type": "command", "command": command });
    match obj.get("statusLine") {
        Some(e) if ours(e) => {
            if e.get("command").and_then(Value::as_str) == Some(command) {
                return Ok(false);
            }
            // Keep what else the entry says (its padding), only the path moves.
            ours_now = e.clone();
            ours_now["command"] = Value::from(command);
        }
        Some(e) => {
            if let Some(dir) = before.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(before, serde_json::to_string_pretty(e)?)?;
            if let Some(p) = e.get("padding") {
                ours_now["padding"] = p.clone();
            }
        }
        None => {}
    }
    obj.insert("statusLine".into(), ours_now);
    Ok(true)
}

/// Take ours out and put the reader's back, if one was kept. Returns whether
/// the settings changed.
pub fn remove_from(settings: &mut Value, before: &Path) -> bool {
    let Some(obj) = settings.as_object_mut() else {
        return false;
    };
    if !obj.get("statusLine").is_some_and(ours) {
        return false;
    }
    let kept = std::fs::read_to_string(before)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    match kept {
        Some(k) => obj.insert("statusLine".into(), k),
        None => obj.remove("statusLine"),
    };
    let _ = std::fs::remove_file(before);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A payload in the shape Claude Code 2.1.283 documents
    /// (code.claude.com/docs/en/statusline), with the cost block this must
    /// never read. Replace it with a captured one, from a throwaway HOME,
    /// when the shape moves.
    const PAYLOAD: &str = include_str!("../tests/fixtures/statusline.json");

    #[test]
    fn a_real_payload_gives_the_model_and_how_full_the_window_is() {
        let v: Value = serde_json::from_str(PAYLOAD).unwrap();
        let s = read(&v);
        assert_eq!(s.model, "Fable 5.1");
        assert_eq!(s.pct, Some(43));
        assert_eq!(s.size, Some(200_000));
        assert_eq!(s.input, Some(86_120));
        assert_eq!(
            s.used,
            Some(86_120),
            "no current_usage: the total stands in"
        );
        assert_eq!(
            s.session.as_deref(),
            Some("f94bace6-1a2b-4c3d-8e9f-0123456789ab")
        );
        assert_eq!(s.cwd.as_deref(), Some("/home/reader/Projects/bos_dog"));
    }

    #[test]
    fn a_thin_or_odd_payload_says_what_it_can() {
        assert_eq!(read(&json!({})), Seen::default());
        let s = read(&json!({
            "session_id": "not-a-uuid",
            "model": { "display_name": "Fable\n5.1\u{7}" },
            "agent": { "name": "reviewer" },
            "context_window": { "used_percentage": 131.6, "context_window_size": -5 }
        }));
        assert_eq!(s.session, None, "only a UUID is kept");
        assert_eq!(s.model, "reviewer · Fable5.1");
        assert_eq!(s.pct, Some(100));
        assert_eq!(s.size, None);
        assert_eq!(s.five_hour, None);
    }

    /// The account's rate-limit windows, when the line carries them; one can
    /// be there without the other, and one that makes no sense is not kept.
    #[test]
    fn the_rate_limit_windows_are_read_when_they_are_there() {
        let s = read(&json!({ "rate_limits": {
            "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
            "seven_day": { "used_percentage": "lots", "resets_at": 1738857600 },
            "spend_limit": { "used_percentage": 62.8, "resets_at": 1740787200 }
        }}));
        assert_eq!(
            s.five_hour,
            Some(Limit {
                used: 23.5,
                resets_at: 1738425600
            })
        );
        assert_eq!(s.seven_day, None);
        let over = read(
            &json!({ "rate_limits": { "seven_day": { "used_percentage": 140, "resets_at": 5 } } }),
        );
        assert_eq!(
            over.seven_day,
            Some(Limit {
                used: 100.0,
                resets_at: 5
            })
        );
    }

    #[test]
    fn the_window_now_is_input_and_cache_not_output() {
        let window = |current: Value| {
            json!({ "context_window": {
                "total_input_tokens": 15500,
                "total_output_tokens": 1200,
                "context_window_size": 200000,
                "used_percentage": 8,
                "remaining_percentage": 92,
                "current_usage": current,
            }})
        };
        let s = read(&window(json!({
            "input_tokens": 8500,
            "output_tokens": 1200,
            "cache_creation_input_tokens": 5000,
            "cache_read_input_tokens": 2000
        })));
        assert_eq!(s.used, Some(15_500));
        // Before the first call, and right after /compact.
        assert_eq!(read(&window(Value::Null)).used, Some(15_500));
        let s = read(&json!({ "context_window": {
            "total_input_tokens": 40_000,
            "current_usage": null
        }}));
        assert_eq!(s.used, Some(40_000), "the total stands in");
        let s = read(&json!({ "model": { "display_name": "Fable 5.1" } }));
        assert_eq!(s.used, None);
    }

    #[test]
    fn a_readers_own_line_is_kept_and_given_back() {
        let dir = crate::store::tempdir::Dir::new("snyvi-statusline");
        let before = dir.path.join("statusline-before.json");
        let mine =
            json!({ "type": "command", "command": "~/bin/line.sh --short 'x y'", "padding": 1 });
        let mut settings = json!({ "statusLine": mine.clone(), "model": "opus" });
        assert!(install_into(&mut settings, "snyvi statusline", &before).unwrap());
        assert_eq!(settings["statusLine"]["command"], "snyvi statusline");
        assert_eq!(settings["statusLine"]["padding"], 1);
        assert_eq!(
            saved_command(&before).as_deref(),
            Some("~/bin/line.sh --short 'x y'")
        );
        // Again: nothing changes, and the kept line is not overwritten with ours.
        assert!(!install_into(&mut settings, "snyvi statusline", &before).unwrap());
        assert!(install_into(&mut settings, "/opt/snyvi statusline", &before).unwrap());
        assert_eq!(
            saved_command(&before).as_deref(),
            Some("~/bin/line.sh --short 'x y'")
        );
        assert!(remove_from(&mut settings, &before));
        assert_eq!(settings["statusLine"], mine);
        assert!(!before.exists());
        assert!(!remove_from(&mut settings, &before), "theirs is left alone");
    }

    #[test]
    fn with_no_line_before_ours_comes_and_goes_alone() {
        let dir = crate::store::tempdir::Dir::new("snyvi-statusline");
        let before = dir.path.join("statusline-before.json");
        let mut settings = json!({});
        assert!(install_into(&mut settings, "snyvi statusline", &before).unwrap());
        assert!(!before.exists());
        assert!(remove_from(&mut settings, &before));
        assert_eq!(settings, json!({}));
    }
}
