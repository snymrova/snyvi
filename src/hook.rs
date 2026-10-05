//! Claude Code hooks. `PostToolUse`: when Claude writes or edits a Markdown
//! file, send it. Zero agent cooperation needed. And inside a desk panel, every
//! event that says what Claude is doing -- a prompt, a tool, a permission
//! prompt, the end of a turn -- is told to the panel; a session starting there
//! is handed the desk brief (`crate::brief`) and named after its panel; each
//! prompt is handed what changed on the desk since the last one; and a
//! plan Claude asks to have approved lands in snyvi while it waits for the
//! answer. Codex runs the same hooks with the same events and the same
//! stdin, and takes the same `additionalContext` back. Quiet on every path: a hook must never interrupt the session, so
//! failures are swallowed and exit 0.

use crate::client;
use crate::config::Paths;
use crate::receive::Payload;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The events installed for the panel's status. Each one maps to a state in
/// `agent_state`. `PostToolUse` is installed for this too, as an entry of its
/// own on `STATUS_TOOLS`, with the same command as every other: a flag here
/// would be read by whatever snyvi the entry names, and one from before the
/// flag existed fails on it, on every tool call. So whether a written file
/// is sent is not the entry's to say but `auto_send`'s.
const STATUS_EVENTS: [&str; 4] = ["UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

/// The tools the status entry runs after. It used to be every tool (`*`),
/// which is one process started per Read, Grep and Glob of every turn, and
/// hundreds of those to a prompt. What the entry is there for is narrower:
/// a prompt says `working` already, and a `Stop` says done; between them the
/// one thing only a tool call can say is that a permission the reader was
/// asked for has been answered, since the tool then runs. So the tools that
/// ask: the shell, the file writes, the web, plans, and snyvi's own MCP
/// tools. From 1.13 to 1.16 it was every MCP tool of every server, which
/// made a Playwright or a Context7 call one more process each; the status
/// line runs after every reply and says `working` for those already.
pub const STATUS_TOOLS: &str =
    "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|ExitPlanMode|mcp__snyvi__.*";

/// The matcher 1.13 through 1.16 wrote, brought along to `STATUS_TOOLS` the
/// way an older `*` is.
const STATUS_TOOLS_1_13: &str =
    "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|ExitPlanMode|mcp__.*";

/// What of an event this reads. Everything else -- above all a tool's output,
/// which can be megabytes, and a Write's whole file -- is skipped as it is
/// read, never built into a value: this runs after every tool call of every
/// session, and it used to parse all of it.
///
/// Every field is taken as it comes, and one of a shape nobody expected is
/// only that field missing -- as it was when this read a `Value` -- never the
/// whole event, which would leave a panel saying `needs_you` after it was
/// answered.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Event {
    hook_event_name: Str,
    cwd: Str,
    session_id: Str,
    tool_name: Str,
    tool_input: ToolInput,
    /// Read only for `ExitPlanMode`, whose response carries the plan; any
    /// other tool's output is skipped as it is read, like its input.
    tool_response: ToolInput,
    notification_type: Str,
    message: Str,
    /// SessionStart: startup, resume, clear, compact or fork.
    source: Str,
    /// SessionStart: the title the session already has, if any.
    session_title: Str,
}

/// The few fields of a tool's input or response this reads. `plan` and
/// `plan_file` are `ExitPlanMode`'s: Claude Code puts the plan and its file in
/// the input it hands a hook (`plan`, `planFilePath`) and in the response
/// (`plan`, `filePath`).
#[derive(Default)]
struct ToolInput {
    file_path: Str,
    plan: Str,
    plan_file: Str,
}

/// A string, or nothing for anything else, which is skipped as it is read.
#[derive(Default)]
struct Str(Option<String>);

impl Str {
    fn get(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

/// What `Str` and `ToolInput` do with a value that is not theirs: read it to
/// its end and let it go.
macro_rules! ignore_the_rest {
    ($out:expr) => {
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok($out)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok($out)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok($out)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok($out)
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($out)
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut a: A,
        ) -> Result<Self::Value, A::Error> {
            while a.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok($out)
        }
    };
}

impl<'de> Deserialize<'de> for Str {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Str, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Str;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("anything")
            }
            fn visit_str<E>(self, s: &str) -> Result<Str, E> {
                Ok(Str(Some(s.to_string())))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> Result<Str, A::Error> {
                while a
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(Str(None))
            }
            ignore_the_rest!(Str(None));
        }
        d.deserialize_any(V)
    }
}

impl<'de> Deserialize<'de> for ToolInput {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<ToolInput, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = ToolInput;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("anything")
            }
            // Only these are kept: a Write's whole file goes by unread.
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> Result<ToolInput, A::Error> {
                let mut out = ToolInput::default();
                while let Some(k) = a.next_key::<Str>()? {
                    match k.get() {
                        Some("file_path") => out.file_path = a.next_value()?,
                        Some("plan") => out.plan = a.next_value()?,
                        Some("planFilePath" | "filePath") => out.plan_file = a.next_value()?,
                        _ => {
                            a.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }
            fn visit_str<E>(self, _: &str) -> Result<ToolInput, E> {
                Ok(ToolInput::default())
            }
            ignore_the_rest!(ToolInput::default());
        }
        d.deserialize_any(V)
    }
}

/// What a reader holds. `read_to_end` doubles its buffer on the way, and
/// under mimalloc every buffer it outgrew stays resident: 2 MB of tool output
/// on stdin was 12 MB more at the peak. So a call's first 64 KB -- all of one
/// in almost every case -- are read into a buffer of that size, and only what
/// is longer gets room for 32 MB at once, which costs the pages it fills and
/// not the rest, and grows as ever past that.
fn read_all(mut r: impl Read) -> std::io::Result<Vec<u8>> {
    const FIRST: usize = 64 << 10;
    const ROOM: usize = 32 << 20;
    let mut head = Vec::with_capacity(FIRST);
    (&mut r).take(FIRST as u64).read_to_end(&mut head)?;
    if head.len() < FIRST {
        return Ok(head);
    }
    let mut all = Vec::with_capacity(ROOM);
    all.extend_from_slice(&head);
    drop(head);
    r.read_to_end(&mut all)?;
    Ok(all)
}

pub fn run(paths: &Paths) -> Result<()> {
    // Read whole, then parsed from the bytes: `from_reader` skipped the
    // output without holding it but went byte by byte, slower than the copy.
    let input = read_all(std::io::stdin().lock())?;
    let Ok(event) = serde_json::from_slice::<Event>(&input) else {
        return Ok(());
    };
    drop(input);
    let name = event.hook_event_name.get().unwrap_or("");
    // A session starting, or a prompt, keeps the session map fresh, so the
    // MCP server can file its documents under the same workflow as the hook.
    // Not a tool call: there are hundreds of those to a prompt, and the map
    // does not change between them.
    // In a desk panel, the panel is told what the agent is doing and which
    // conversation it is, so it can offer that conversation back after Claude
    // or the daemon has gone. Outside one, nothing new happens.
    let pane = std::env::var("SNYVI_SESSION")
        .ok()
        .filter(|v| crate::pane::valid_id(v));
    if matches!(name, "SessionStart" | "UserPromptSubmit") {
        if let (Some(cwd), Some(sid)) = (event.cwd.get(), event.session_id.get()) {
            crate::session::record(paths, cwd, sid, pane.as_deref());
        }
    }
    if let Some(pane) = &pane {
        let state = agent_state(&event);
        let session = event
            .session_id
            .get()
            .filter(|s| crate::desk::valid_session(s));
        let starting = name == "SessionStart";
        let said = state.is_some() || (starting && session.is_some());
        // The two events that also ask the daemon something tell it the
        // state in the same request; a daemon from before 1.17 answers
        // without taking it, and one that did not answer at all -- slow,
        // or the pane unknown to it -- may not have taken it either: both
        // are told the way they know, after. Telling twice sets it twice.
        let asks = starting || name == "UserPromptSubmit";
        if said && !asks {
            client::agent_state(paths, pane, state, session);
        }
        let tell_anyway = |heard: Option<&client::Said>| {
            if said && heard.is_none_or(|h| !h.applied) {
                client::agent_state(paths, pane, state, session);
            }
        };
        // The desk brief, on every start -- a new session, a resume, a
        // /clear, a compaction, a fork -- so what Claude knows about the desk
        // comes back each time its context does. Claude's first reply waits
        // for this: `client::brief` gives up after half a second, and then
        // nothing is printed and Claude starts as it would have.
        if starting {
            let b = client::brief(paths, pane, session);
            tell_anyway(b.as_ref());
            if let Some(b) = b {
                if let Some(out) = session_start_output(&event, &b.context, &b.title, &b.desk) {
                    println!("{out}");
                }
            }
            return Ok(());
        }
        // And at each prompt, what the reader and the other panels did on the
        // desk since the last one -- a note added, one ticked, a document
        // from the panel beside this one -- goes in with the prompt. Only
        // when something did: most prompts get nothing, and nothing is
        // printed. It rides on the reader's own message, so snyvi still
        // never starts a turn.
        if name == "UserPromptSubmit" {
            let c = client::changes(paths, pane, state, session);
            tell_anyway(c.as_ref());
            if let Some(out) = c.and_then(|c| prompt_output(&event, &c.context, &c.title, &c.desk))
            {
                println!("{out}");
            }
            return Ok(());
        }
    }
    if event.tool_name.get() == Some("ExitPlanMode") && matches!(name, "PreToolUse" | "PostToolUse")
    {
        send_plan(paths, &event, pane.is_some());
        return Ok(());
    }
    if name != "PostToolUse" {
        return Ok(());
    }
    if !matches!(
        event.tool_name.get().unwrap_or(""),
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit"
    ) {
        return Ok(());
    }
    let Some(file) = event.tool_input.file_path.get() else {
        return Ok(());
    };
    if !wanted(Path::new(file)) || !auto_send() {
        return Ok(());
    }
    let payload = Payload {
        path: Some(file.to_string()),
        cwd: event.cwd.get().map(str::to_string),
        session: event.session_id.get().map(crate::session::workflow_key),
        origin: Some("hook".into()),
        sender: Some("claude-code".into()),
        ..Default::default()
    };
    // Errors are deliberately ignored: the hook must not break Claude's turn.
    // Never a daemon started for it, and a bounded wait, on `send_plan`'s
    // terms: this runs inside the turn, and a `snyvi stop` the reader asked
    // for stays stopped. The daemon that is up answers once the document is
    // stored and finishes rendering after the hook has gone.
    let _ = client::send_quick(paths, &payload, AUTO_SEND_WITHIN);
    Ok(())
}

/// How long a Markdown write's send waits for the daemon's answer. Claude's
/// turn waits with it, so it is short; a daemon that needs longer keeps the
/// document anyway, since the store comes before the answer.
const AUTO_SEND_WITHIN: std::time::Duration = std::time::Duration::from_millis(1500);

/// What a SessionStart hook prints: the brief as `additionalContext`, and the
/// session named after its panel. Nothing when there is neither.
///
/// The title only where Claude Code applies one -- startup, resume, fork --
/// and never over a name the reader gave: a title that is not one of ours
/// (`ours`) is theirs, from `--name` or `/rename`. One of ours is replaced,
/// since a conversation resumed in another panel lives there now.
///
/// And only for a Claude Code session, which is the one with a 36-character
/// id: Codex takes the same hook and the same context, but refuses an output
/// field it does not know, and `sessionTitle` is one.
fn session_start_output(event: &Event, context: &str, title: &str, desk: &str) -> Option<String> {
    let titled = matches!(event.source.get(), Some("startup" | "resume" | "fork"))
        && !title.is_empty()
        && event
            .session_id
            .get()
            .is_some_and(crate::desk::valid_session)
        && event
            .session_title
            .get()
            .is_none_or(|t| t.trim().is_empty() || titled_by_us(t, desk));
    if context.is_empty() && !titled {
        return None;
    }
    let mut out = json!({ "hookEventName": "SessionStart" });
    if !context.is_empty() {
        out["additionalContext"] = json!(context);
    }
    if titled {
        out["sessionTitle"] = json!(title);
    }
    Some(json!({ "hookSpecificOutput": out }).to_string())
}

/// What a UserPromptSubmit hook prints: the desk's changes as
/// `additionalContext`, and the session's title when the panel's name has
/// moved on from it -- a panel `name_panel` named after the session began.
/// The title on `session_start_output`'s terms: Claude Code's sessions only,
/// and only over one of ours. Nothing at all when there is neither.
fn prompt_output(event: &Event, context: &str, title: &str, desk: &str) -> Option<String> {
    let now = event.session_title.get().map(str::trim).unwrap_or("");
    let titled = !title.is_empty()
        && now != title
        && (now.is_empty() || titled_by_us(now, desk))
        && event
            .session_id
            .get()
            .is_some_and(crate::desk::valid_session);
    let said = !context.trim().is_empty();
    if !said && !titled {
        return None;
    }
    let mut out = json!({ "hookEventName": "UserPromptSubmit" });
    if said {
        out["additionalContext"] = json!(context);
    }
    if titled {
        out["sessionTitle"] = json!(title);
    }
    Some(json!({ "hookSpecificOutput": out }).to_string())
}

/// A title snyvi gave, and so one it may give again: the old
/// "<desk> · panel <n>" on any desk, or anything after this desk's
/// "<desk> · " (`crate::brief::title`), a panel's name included.
fn titled_by_us(t: &str, desk: &str) -> bool {
    our_title(t) || (!desk.is_empty() && t.strip_prefix(desk).is_some_and(|r| r.starts_with(" · ")))
}

/// A session title snyvi gave: "<desk> · panel <n>" (`crate::brief::title`).
fn our_title(t: &str) -> bool {
    t.rsplit_once(" · panel ").is_some_and(|(desk, n)| {
        !desk.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// A plan Claude asked to have approved goes to snyvi, rendered, with its
/// diagrams drawn, while the approval is still being asked: the PreToolUse
/// entry runs before the dialog and in the background (`"async": true`), so
/// it can never hold the dialog up. The already-installed PostToolUse entry
/// sends it after approval instead, for an install that has not been given
/// the PreToolUse one yet; where both are, the PreToolUse one did it.
///
/// Inside a panel, always. Anywhere else only for a reader who asked for
/// every document Claude writes (`init-claude --auto`): the hook is in
/// `~/.claude/settings.json`, and so runs for every Claude on the machine.
///
/// By its file, so a revised plan is a new version of the same document and
/// the same row, not a new one each time; the plan's text when there is no
/// file to read. The daemon files it under the desk or the project.
fn send_plan(paths: &Paths, event: &Event, in_pane: bool) {
    let pre = event.hook_event_name.get() == Some("PreToolUse");
    if !in_pane && !auto_send() {
        return;
    }
    if !pre && plan_hook_installed() {
        return;
    }
    let from = if pre {
        &event.tool_input
    } else {
        &event.tool_response
    };
    let file = from
        .plan_file
        .get()
        .filter(|f| Path::new(f).is_file())
        .map(str::to_string);
    let content = from.plan.get().filter(|p| !p.trim().is_empty());
    if file.is_none() && content.is_none() {
        return;
    }
    let payload = Payload {
        content: if file.is_none() {
            content.map(str::to_string)
        } else {
            None
        },
        path: file,
        lang: Some("md".into()),
        cwd: event.cwd.get().map(str::to_string),
        session: event.session_id.get().map(crate::session::workflow_key),
        origin: Some("plan".into()),
        sender: Some("claude-code".into()),
        ..Default::default()
    };
    // Never a daemon started for it, and a bounded wait: in the background
    // before approval, where a slow render costs nothing; after it, where
    // Claude's turn waits, a short one.
    let within = std::time::Duration::from_millis(if pre { 5000 } else { 1500 });
    let _ = client::send_quick(paths, &payload, within);
}

/// Whether the PreToolUse entry for plans is installed, which is what makes
/// the PostToolUse one stand aside. Read only on an ExitPlanMode.
fn plan_hook_installed() -> bool {
    settings_path()
        .and_then(|p| read_settings(&p))
        .map(|s| {
            s.pointer("/hooks/PreToolUse")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|e| {
                    e.get("matcher").and_then(Value::as_str) == Some(PLAN_MATCHER)
                        && e.get("hooks")
                            .and_then(Value::as_array)
                            .is_some_and(|hs| hs.iter().any(ours))
                })
        })
        .unwrap_or(false)
}

/// The tool whose calls the plan entry runs on.
const PLAN_MATCHER: &str = "ExitPlanMode";

/// What an event says the agent is doing, or nothing when it says nothing new.
/// Empty is "gone": the session ended. A `PostToolUse` is `working` even
/// straight after a permission prompt, which is exactly what clears
/// `needs_you` once the reader has answered it.
fn agent_state(event: &Event) -> Option<&'static str> {
    match event.hook_event_name.get()? {
        "UserPromptSubmit" | "PostToolUse" => Some("working"),
        "Stop" => Some("done"),
        "SessionEnd" => Some(""),
        // Codex asks for an approval through this event; Claude Code says the
        // same thing with a `Notification`.
        "PermissionRequest" => Some("needs_you"),
        // A permission prompt needs the reader. The idle reminder a minute
        // after a turn ended does not: the turn is done, and says so already.
        "Notification" => {
            let idle = event.notification_type.get() == Some("idle_prompt")
                || event
                    .message
                    .get()
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

/// The status entry under `PostToolUse`: on `STATUS_TOOLS`, or on every tool
/// as it was written before 1.13. The send entry names its tools.
fn every_tool(entry: &Value) -> bool {
    matches!(
        entry.get("matcher").and_then(Value::as_str),
        None | Some("" | "*")
    ) || status_matcher(entry.get("matcher").and_then(Value::as_str))
}

/// A status matcher as this or an earlier snyvi wrote it.
fn status_matcher(m: Option<&str>) -> bool {
    m == Some(STATUS_TOOLS) || m == Some(STATUS_TOOLS_1_13)
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
    let (mut changed, rewritten) = install_into(&mut settings, command, auto)?;
    changed |= statusline_into(&mut settings, command)?;
    if changed {
        write_settings(&path, &settings)?;
    }
    let events = installed(&settings).into_iter().map(|(e, _)| e).collect();
    Ok((path, events, rewritten))
}

/// The merge itself, on the parsed file. Returns (anything changed, a
/// command was rewritten).
pub fn install_into(settings: &mut Value, command: &str, auto: bool) -> Result<(bool, bool)> {
    merge(settings, command, claude_hooks(command, auto))
}

/// The entries Claude Code gets, each under its event.
fn claude_hooks(command: &str, auto: bool) -> Vec<(&'static str, Value)> {
    let hook = |c: &str| json!({ "hooks": [{ "type": "command", "command": c, "timeout": 10 }] });
    let mut wanted: Vec<(&str, Value)> = vec![("SessionStart", hook(command))];
    for event in STATUS_EVENTS {
        wanted.push((event, hook(command)));
    }
    wanted.push((
        "PostToolUse",
        json!({ "matcher": STATUS_TOOLS, "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
    ));
    // Plans land in snyvi as the approval is asked: in the background, so the
    // dialog never waits on it (`send_plan`).
    wanted.push((
        "PreToolUse",
        json!({ "matcher": PLAN_MATCHER, "hooks": [{ "type": "command", "command": command, "async": true, "timeout": 10 }] }),
    ));
    if auto {
        wanted.push((
            "PostToolUse",
            json!({ "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
        ));
    }
    wanted
}

/// The entries Codex gets: the same events as Claude Code's status ones,
/// spelled the way Codex has them. `PermissionRequest` is its "needs you"
/// (Claude Code says it with a `Notification`, which Codex has not), the
/// `SessionEnd` timeout is the three seconds Codex allows, and there is no
/// plan hook and no auto-send: Codex has no ExitPlanMode, and its edits
/// come as a patch with no file path in the hook's input.
fn codex_hooks(command: &str) -> Vec<(&'static str, Value)> {
    let hook =
        |c: &str, t: u32| json!({ "hooks": [{ "type": "command", "command": c, "timeout": t }] });
    vec![
        ("SessionStart", hook(command, 10)),
        ("UserPromptSubmit", hook(command, 10)),
        ("PermissionRequest", hook(command, 10)),
        (
            "PostToolUse",
            json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }),
        ),
        ("Stop", hook(command, 10)),
        ("SessionEnd", hook(command, 3)),
    ]
}

/// Codex's hooks file, `hooks.json` beside its config: `CODEX_HOME`, or
/// `~/.codex`. The same shape as Claude Code's `hooks` object, under the
/// same key, so the one merge serves both.
pub fn codex_hooks_path() -> Result<PathBuf> {
    let home = match std::env::var_os("CODEX_HOME") {
        Some(h) => PathBuf::from(h),
        None => dirs::home_dir()
            .context("no home directory")?
            .join(".codex"),
    };
    Ok(home.join("hooks.json"))
}

/// Write snyvi's hooks for Codex, keeping whatever else the file holds.
/// Returns the file and whether anything changed.
pub fn install_codex(command: &str) -> Result<(PathBuf, bool)> {
    let path = codex_hooks_path()?;
    let mut settings = read_settings(&path)?;
    let (changed, _) = merge(&mut settings, command, codex_hooks(command))?;
    if changed {
        write_settings(&path, &settings)?;
    }
    Ok((path, changed))
}

/// Take snyvi's hooks out of Codex's file, and nothing else.
pub fn uninstall_codex() -> Result<(PathBuf, usize)> {
    let path = codex_hooks_path()?;
    if !path.is_file() {
        return Ok((path, 0));
    }
    let mut settings = read_settings(&path)?;
    let n = remove_from(&mut settings);
    if n > 0 {
        write_settings(&path, &settings)?;
    }
    Ok((path, n))
}

/// Merge `wanted` into the file's `hooks`, preserving everything else in it.
fn merge(
    settings: &mut Value,
    command: &str,
    wanted: Vec<(&'static str, Value)>,
) -> Result<(bool, bool)> {
    let hooks = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert(json!({}));
    let hooks = hooks.as_object_mut().context("hooks is not an object")?;
    let mut changed = false;
    let mut rewritten = false;
    // Claude Code's status entry narrowed to `STATUS_TOOLS` in 1.13, and
    // again in 1.17; an install from before runs on every tool, or on every
    // MCP tool, and is brought along. Only where that is what is wanted:
    // Codex's entry says `*` and means it.
    let narrow = wanted.iter().any(|(e, v)| {
        *e == "PostToolUse" && v.get("matcher").and_then(Value::as_str) == Some(STATUS_TOOLS)
    });
    // Every hook of ours, under any event, points at this binary from now on.
    for (event, list) in hooks.iter_mut() {
        let Some(list) = list.as_array_mut() else {
            continue;
        };
        for entry in list.iter_mut() {
            let Some(hs) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            let mine = hs.iter().any(ours);
            for h in hs.iter_mut().filter(|h| ours(h)) {
                if h.get("command").and_then(Value::as_str) != Some(command) {
                    h["command"] = json!(command);
                    changed = true;
                    rewritten = true;
                }
            }
            let m = entry.get("matcher").and_then(Value::as_str);
            let every = matches!(m, None | Some("" | "*")) || m == Some(STATUS_TOOLS_1_13);
            if narrow && mine && event == "PostToolUse" && every {
                entry["matcher"] = json!(STATUS_TOOLS);
                changed = true;
            }
        }
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
    let command = command.clone();
    let (mut changed, _) = install_into(&mut settings, &command, auto)?;
    changed |= statusline_into(&mut settings, &command)?;
    if changed {
        write_settings(&path, &settings)?;
    }
    Ok(changed)
}

/// The status line beside the hooks, run by the same program: `X hook` gives
/// `X statusline`. A reader's own line is kept for `crate::statusline` to run
/// and for `uninstall` to give back.
fn statusline_into(settings: &mut Value, hook_command: &str) -> Result<bool> {
    let command = format!("{} statusline", hook_command.trim_end_matches(" hook"));
    crate::statusline::install_into(
        settings,
        &command,
        &crate::statusline::before_path(&crate::config::paths()),
    )
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
    let line = crate::statusline::remove_from(
        &mut settings,
        &crate::statusline::before_path(&crate::config::paths()),
    );
    if n > 0 || line {
        write_settings(&path, &settings)?;
    }
    Ok((path, n + usize::from(line)))
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

    /// Stdin is what was sent, byte for byte: an empty one, one either side
    /// of the first read's size, and one that arrives a few bytes a read.
    #[test]
    fn stdin_is_read_whole_whatever_its_size() {
        struct Dribble<'a>(&'a [u8]);
        impl Read for Dribble<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = buf.len().min(self.0.len()).min(7);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        for len in [0, 1, (64 << 10) - 1, 64 << 10, (64 << 10) + 1, 700_001] {
            let sent: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            assert_eq!(read_all(&sent[..]).unwrap(), sent, "{len}");
            assert_eq!(read_all(Dribble(&sent)).unwrap(), sent, "{len} dribbled");
        }
    }

    fn state_of(v: &Value) -> Option<&'static str> {
        agent_state(&serde_json::from_slice(v.to_string().as_bytes()).unwrap())
    }

    /// A field of a shape nobody expected is that field missing, not the
    /// event: the state still gets through, and so does a file to send.
    #[test]
    fn an_odd_field_does_not_cost_the_event() {
        let odd = json!({ "hook_event_name": "PostToolUse", "cwd": null, "session_id": 7,
            "tool_name": "Write", "message": ["a", { "b": 1 }],
            "tool_input": { "content": "x".repeat(1000), "file_path": "/p/PLAN.md", "extra": [1, 2] } });
        let e: Event = serde_json::from_slice(odd.to_string().as_bytes()).unwrap();
        assert_eq!(agent_state(&e), Some("working"));
        assert_eq!(e.tool_input.file_path.get(), Some("/p/PLAN.md"));
        assert_eq!(e.cwd.get(), None);
        assert_eq!(e.session_id.get(), None);
        for input in [
            json!(null),
            json!("x"),
            json!([1]),
            json!({ "file_path": 3 }),
        ] {
            let ev = json!({ "hook_event_name": "PostToolUse", "tool_input": input });
            let e: Event = serde_json::from_slice(ev.to_string().as_bytes()).unwrap();
            assert_eq!(agent_state(&e), Some("working"));
            assert_eq!(e.tool_input.file_path.get(), None);
        }
    }

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
        assert_eq!(state_of(&ev("UserPromptSubmit")), Some("working"));
        assert_eq!(state_of(&ev("PostToolUse")), Some("working"));
        assert_eq!(state_of(&ev("Stop")), Some("done"));
        assert_eq!(state_of(&ev("SessionEnd")), Some(""));
        assert_eq!(state_of(&ev("SessionStart")), None);
        assert_eq!(
            state_of(
                &json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt",
                "message": "Claude needs your permission to use Bash" })
            ),
            Some("needs_you")
        );
        // The idle reminder after a turn is not the reader being needed.
        assert_eq!(
            state_of(
                &json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt" })
            ),
            None
        );
        assert_eq!(
            state_of(&json!({ "hook_event_name": "Notification",
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
        // The status entry runs on the tools that can ask, and never sends.
        let post = s["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2);
        assert_eq!(post[1]["matcher"], STATUS_TOOLS);
        assert_eq!(post[1]["hooks"][0]["command"], "/opt/snyvi hook");
        // And it does not count as auto-send.
        assert!(!installed(&s).iter().any(|(e, _)| *e == "PostToolUse"));
        // Plans: one entry, on ExitPlanMode only, in the background.
        let pre = s["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["matcher"], "ExitPlanMode");
        assert_eq!(pre[0]["hooks"][0]["async"], true);
        assert_eq!(pre[0]["hooks"][0]["command"], "/opt/snyvi hook");
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
        assert_eq!(old["hooks"]["PostToolUse"][1]["matcher"], STATUS_TOOLS);
    }

    /// An install from 1.12 ran the status entry on every tool. The next
    /// `init-claude` or daemon start narrows it, once, and leaves a status
    /// entry that is not ours (Codex's file, another tool's) as it is.
    #[test]
    fn an_every_tool_status_entry_is_narrowed_once() {
        let mut s = json!({ "hooks": {
            "SessionStart": [{ "hooks": [{ "type": "command", "command": "/usr/bin/snyvi hook" }] }],
            "PostToolUse": [
                { "matcher": "*", "hooks": [{ "type": "command", "command": "other --x" }] },
                { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/snyvi hook" }] }
            ] } });
        assert!(
            install_into(&mut s, "/usr/bin/snyvi hook", false)
                .unwrap()
                .0
        );
        let post = s["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 2, "narrowed in place, not added beside");
        assert_eq!(post[0]["matcher"], "*", "another tool's entry is its own");
        assert_eq!(post[1]["matcher"], STATUS_TOOLS);
        assert_eq!(
            install_into(&mut s, "/usr/bin/snyvi hook", false).unwrap(),
            (false, false)
        );
        // Codex's file keeps its `*`: there the matcher means it.
        let mut c = json!({ "hooks": { "PostToolUse": [
            { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/snyvi hook" }] } ] } });
        merge(
            &mut c,
            "/usr/bin/snyvi hook",
            codex_hooks("/usr/bin/snyvi hook"),
        )
        .unwrap();
        assert_eq!(c["hooks"]["PostToolUse"][0]["matcher"], "*");
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

    /// Codex gets its six events and none of Claude Code's own, beside
    /// whatever the file had; a second write changes nothing, and the
    /// uninstall leaves the rest.
    #[test]
    fn codex_gets_its_own_set_of_hooks_and_keeps_the_rest_of_its_file() {
        let before = json!({ "description": "mine", "hooks": { "Stop": [
            { "hooks": [{ "type": "command", "command": "python3 stop.py" }] } ] } });
        let mut s = before.clone();
        assert_eq!(
            merge(&mut s, "/opt/snyvi hook", codex_hooks("/opt/snyvi hook")).unwrap(),
            (true, false)
        );
        let events: Vec<&str> = s["hooks"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            events,
            [
                "Stop",
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "PostToolUse",
                "SessionEnd"
            ]
        );
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(s["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3);
        assert_eq!(s["hooks"]["PostToolUse"][0]["matcher"], "*");
        assert_eq!(s["description"], "mine");
        assert_eq!(
            merge(&mut s, "/opt/snyvi hook", codex_hooks("/opt/snyvi hook")).unwrap(),
            (false, false)
        );
        assert_eq!(remove_from(&mut s), 6);
        assert_eq!(s, before);
    }

    /// An install from 1.13 through 1.16 ran the status entry on every MCP
    /// tool; it is narrowed to snyvi's own, once, and not written twice.
    #[test]
    fn the_every_mcp_tool_matcher_is_narrowed() {
        let mut s = json!({ "hooks": { "PostToolUse": [
            { "matcher": STATUS_TOOLS_1_13, "hooks": [{ "type": "command", "command": "/opt/snyvi hook" }] } ] } });
        let (changed, rewritten) = install_into(&mut s, "/opt/snyvi hook", false).unwrap();
        assert!(changed && !rewritten);
        let post = s["hooks"]["PostToolUse"].as_array().unwrap();
        assert_eq!(post.len(), 1, "{post:?}");
        assert_eq!(post[0]["matcher"], STATUS_TOOLS);
        assert_eq!(
            install_into(&mut s, "/opt/snyvi hook", false).unwrap(),
            (false, false)
        );
        // And the matcher names snyvi's tools, not every server's: Claude
        // Code reads it as a regex over the whole tool name, alternatives
        // split on `|`.
        let alts: Vec<&str> = STATUS_TOOLS.split('|').collect();
        assert!(alts.contains(&"mcp__snyvi__.*"));
        assert!(!alts.contains(&"mcp__.*"));
        assert!(!alts
            .iter()
            .any(|a| a.contains("Read") || *a == "*" || *a == ".*"));
    }

    /// Nothing a hook does may start a daemon or wait on one for long: it
    /// runs inside Claude's turn, and after a `snyvi stop`. The client's
    /// functions that start one are `send`, `aside`, `browse`, `restart`,
    /// `update` and `ensure_daemon` itself; this module reaches none of
    /// them, and this is where that is kept true.
    #[test]
    fn the_hook_never_reaches_a_function_that_starts_a_daemon() {
        let src = include_str!("hook.rs");
        let allowed = ["send_quick", "agent_state", "brief", "changes", "Said"];
        for (i, line) in src.lines().enumerate() {
            let mut rest = line;
            while let Some(at) = rest.find("client::") {
                let name: String = rest[at + "client::".len()..]
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                // The string in this test is the one `client::` with no name.
                assert!(
                    name.is_empty() || allowed.contains(&name.as_str()),
                    "hook.rs:{}: client::{name} may start a daemon or wait on one",
                    i + 1
                );
                rest = &rest[at + "client::".len()..];
            }
        }
        // And no name is brought in by a `use` the walk above would not see.
        let uses: Vec<&str> = src
            .lines()
            .filter(|l| l.starts_with("use crate::client"))
            .collect();
        assert_eq!(uses, ["use crate::client;"]);
    }

    #[test]
    fn uninstall_leaves_what_it_found() {
        let before = json!({ "theme": "dark", "hooks": { "PostToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "other --x" }] } ] } });
        let mut s = before.clone();
        install_into(&mut s, "/opt/snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 8);
        assert_eq!(s, before);
        // A file that had only ours goes back to having no hooks key at all.
        let mut s = json!({ "theme": "dark" });
        install_into(&mut s, "snyvi hook", true).unwrap();
        assert_eq!(remove_from(&mut s), 8);
        assert_eq!(s, json!({ "theme": "dark" }));
        assert_eq!(remove_from(&mut s), 0);
    }

    fn event(v: Value) -> Event {
        serde_json::from_slice(v.to_string().as_bytes()).unwrap()
    }

    /// The brief goes in on every start; the title only where Claude Code
    /// takes one, and never over a name the reader gave -- one of ours is
    /// replaced, since the conversation may be in another panel now.
    #[test]
    fn a_session_start_is_handed_the_brief_and_named_after_its_panel() {
        let claude = "0f3b2a1c-9d8e-4f70-a1b2-c3d4e5f60718";
        let out = |source: &str, title: Option<&str>| {
            let mut v = json!({ "hook_event_name": "SessionStart", "source": source, "session_id": claude });
            if let Some(t) = title {
                v["session_title"] = json!(t);
            }
            session_start_output(&event(v), "the brief", "ledger · panel 2", "ledger")
                .map(|o| serde_json::from_str::<Value>(&o).unwrap()["hookSpecificOutput"].clone())
        };
        for source in ["startup", "resume", "fork"] {
            let o = out(source, None).unwrap();
            assert_eq!(o["hookEventName"], "SessionStart");
            assert_eq!(o["additionalContext"], "the brief", "{source}");
            assert_eq!(o["sessionTitle"], "ledger · panel 2", "{source}");
        }
        for source in ["clear", "compact"] {
            let o = out(source, None).unwrap();
            assert_eq!(o["additionalContext"], "the brief", "{source}");
            assert!(o.get("sessionTitle").is_none(), "{source}");
        }
        assert!(out("resume", Some("auth refactor"))
            .unwrap()
            .get("sessionTitle")
            .is_none());
        assert_eq!(
            out("resume", Some("chores · panel 1")).unwrap()["sessionTitle"],
            "ledger · panel 2"
        );
        assert_eq!(
            out("startup", Some("  ")).unwrap()["sessionTitle"],
            "ledger · panel 2"
        );
        // A panel's name snyvi gave on this desk is ours to change too.
        assert_eq!(
            out("resume", Some("ledger · auth refactor")).unwrap()["sessionTitle"],
            "ledger · panel 2"
        );
        // The brief turned off: nothing at all.
        let off = event(
            json!({ "hook_event_name": "SessionStart", "source": "startup", "session_id": claude }),
        );
        assert_eq!(session_start_output(&off, "", "", ""), None);
        // Codex: the brief, and no title, which its output schema would refuse.
        let codex = event(
            json!({ "hook_event_name": "SessionStart", "source": "startup",
            "session_id": "thr_0196a7", "model": "gpt-5-codex" }),
        );
        let o = session_start_output(&codex, "the brief", "ledger · panel 2", "ledger").unwrap();
        let o = serde_json::from_str::<Value>(&o).unwrap()["hookSpecificOutput"].clone();
        assert_eq!(o["additionalContext"], "the brief");
        assert!(o.get("sessionTitle").is_none());
        assert_eq!(
            agent_state(&event(
                json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash" })
            )),
            Some("needs_you")
        );
        assert!(
            our_title("a · b · panel 12") && !our_title("panel 2") && !our_title("x · panel two")
        );
    }

    /// A prompt is handed the desk's changes, and nothing when there are none.
    #[test]
    fn a_prompt_is_handed_what_changed_and_nothing_when_nothing_did() {
        let claude = "0f3b2a1c-9d8e-4f70-a1b2-c3d4e5f60718";
        let named = |t: &str| {
            event(
                json!({ "hook_event_name": "UserPromptSubmit", "session_id": claude, "session_title": t }),
            )
        };
        let same = named("ledger · panel 2");
        assert_eq!(prompt_output(&same, "", "ledger · panel 2", "ledger"), None);
        assert_eq!(
            prompt_output(&same, " \n", "ledger · panel 2", "ledger"),
            None
        );
        let o = serde_json::from_str::<Value>(
            &prompt_output(&same, "New on the list: #3", "ledger · panel 2", "ledger").unwrap(),
        )
        .unwrap();
        assert_eq!(o["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
        assert_eq!(
            o["hookSpecificOutput"]["additionalContext"],
            "New on the list: #3"
        );
        assert!(o["hookSpecificOutput"].get("sessionTitle").is_none());
    }

    /// A panel named after its session began names the session at the next
    /// prompt -- over a title snyvi gave, and never over the reader's own.
    #[test]
    fn a_prompt_names_the_session_after_its_panel() {
        let claude = "0f3b2a1c-9d8e-4f70-a1b2-c3d4e5f60718";
        let title = |had: Option<&str>, id: &str| {
            let mut v = json!({ "hook_event_name": "UserPromptSubmit", "session_id": id });
            if let Some(t) = had {
                v["session_title"] = json!(t);
            }
            prompt_output(&event(v), "", "ledger · auth refactor", "ledger").map(|o| {
                serde_json::from_str::<Value>(&o).unwrap()["hookSpecificOutput"]["sessionTitle"]
                    .clone()
            })
        };
        for had in [
            Some("ledger · panel 2"),
            Some("ledger · old name"),
            Some("chores · panel 1"),
            None,
        ] {
            assert_eq!(
                title(had, claude),
                Some(json!("ledger · auth refactor")),
                "{had:?}"
            );
        }
        assert_eq!(title(Some("my own name"), claude), None, "the reader's");
        assert_eq!(
            title(Some("ledgerx · thing"), claude),
            None,
            "another desk's prefix"
        );
        assert_eq!(
            title(Some("ledger · auth refactor"), claude),
            None,
            "already"
        );
        assert_eq!(title(None, "thr_0196a7"), None, "Codex");
    }

    /// ExitPlanMode's plan and its file are read from the input a
    /// PreToolUse hook gets and the response a PostToolUse one does; the
    /// rest of either goes by unread.
    #[test]
    fn a_plan_is_read_from_the_input_and_from_the_response() {
        let pre = event(
            json!({ "hook_event_name": "PreToolUse", "tool_name": "ExitPlanMode",
            "tool_input": { "plan": "# Ship it", "planFilePath": "/h/.claude/plans/ship.md", "allowedPrompts": [] } }),
        );
        assert_eq!(pre.tool_input.plan.get(), Some("# Ship it"));
        assert_eq!(
            pre.tool_input.plan_file.get(),
            Some("/h/.claude/plans/ship.md")
        );
        let post = event(
            json!({ "hook_event_name": "PostToolUse", "tool_name": "ExitPlanMode",
            "tool_input": {}, "tool_response": { "plan": "# Ship it", "filePath": "/h/p.md", "isAgent": false } }),
        );
        assert_eq!(post.tool_response.plan.get(), Some("# Ship it"));
        assert_eq!(post.tool_response.plan_file.get(), Some("/h/p.md"));
        // Any other tool's output is not kept.
        let read = event(
            json!({ "hook_event_name": "PostToolUse", "tool_name": "Read",
            "tool_response": { "file": { "content": "x".repeat(10_000) } } }),
        );
        assert_eq!(read.tool_response.plan.get(), None);
        assert_eq!(
            agent_state(&pre),
            None,
            "a PreToolUse says nothing new about the agent"
        );
    }
}
