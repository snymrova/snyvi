//! Every agent that speaks MCP, and what each has of snyvi.
//!
//! `snyvi mcp` is a plain stdio MCP server and has worked with every client
//! that speaks the protocol since 0.2; what was missing was anything that
//! said so. This is the table: where each agent keeps its servers, how an
//! entry for snyvi is spelled there, where its instructions file is, and
//! how it names itself on the wire. The state of each is read from the
//! agent's own file and nothing else -- never asked of the agent, which need
//! not be installed to answer -- so it is cheap, and cannot be wrong about
//! anything it did not do. A file that is not there is "not set up", not an
//! error: the agent may simply not be installed, and the row says so without
//! guessing which.
//!
//! `init <agent>` and `uninstall <agent>` write the files snyvi can safely
//! own: JSON with a servers object, and Codex's TOML through a parser that
//! keeps comments and spacing. Claude Code keeps its own path through
//! `claude mcp add`, in setup.rs, because Claude Code owns that file. A file
//! snyvi cannot parse -- comments in a JSON file, a hand that slipped -- is
//! not edited: the snippet is printed instead, and the file is left alone.

use crate::platform;
use crate::setup::{self, same_program};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The line an instructions file gets. A registration lets the model send;
/// this is what makes it want to.
pub const LINE: &str = setup::CLAUDE_MD_LINE;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    /// `{"mcpServers": {"snyvi": {"command": …, "args": ["mcp"]}}}`:
    /// Claude Code, Cursor, Claude Desktop, Gemini CLI, Windsurf.
    McpServers,
    /// VS Code: `{"servers": {"snyvi": {"type": "stdio", …}}}`.
    Servers,
    /// Zed: `{"context_servers": {"snyvi": {"source": "custom", …}}}`.
    ContextServers,
    /// Codex CLI: `[mcp_servers.snyvi]`.
    Toml,
}

impl Format {
    fn key(self) -> &'static str {
        match self {
            Format::McpServers => "mcpServers",
            Format::Servers => "servers",
            Format::ContextServers => "context_servers",
            Format::Toml => "mcp_servers",
        }
    }
}

/// Where an agent reads the line from.
pub enum Where {
    /// A file snyvi can read and append to.
    File(PathBuf),
    /// A place in the agent's own settings, said in words.
    Setting(&'static str),
}

pub struct Agent {
    pub id: &'static str,
    pub name: &'static str,
    pub format: Format,
    /// The agent's servers file. None when this system has no known place for it.
    pub file: Option<PathBuf>,
    pub instructions: Option<Where>,
    /// Lower-case pieces of the `clientInfo.name` the agent opens with.
    pub client: &'static [&'static str],
}

/// Every agent snyvi knows, in the order the page lists them.
pub fn all() -> Vec<Agent> {
    let home = dirs::home_dir();
    let h = |rel: &str| home.as_ref().map(|h| h.join(rel));
    // Claude Desktop and VS Code keep user files under the platform's
    // application-support directory; Zed under ~/.config on every unix.
    let cfg = |rel: &str| dirs::config_dir().map(|c| c.join(rel));
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| h(".codex"));
    vec![
        Agent {
            id: "claude",
            name: "Claude Code",
            format: Format::McpServers,
            file: h(".claude.json"),
            instructions: h(".claude/CLAUDE.md").map(Where::File),
            client: &["claude-code", "claude code"],
        },
        Agent {
            id: "codex",
            name: "Codex CLI",
            format: Format::Toml,
            file: codex_home.as_ref().map(|c| c.join("config.toml")),
            instructions: codex_home
                .as_ref()
                .map(|c| Where::File(c.join("AGENTS.md"))),
            client: &["codex"],
        },
        Agent {
            id: "cursor",
            name: "Cursor",
            format: Format::McpServers,
            file: h(".cursor/mcp.json"),
            instructions: Some(Where::Setting("Cursor → Settings → Rules → User Rules")),
            client: &["cursor"],
        },
        Agent {
            id: "claude-desktop",
            name: "Claude Desktop",
            format: Format::McpServers,
            file: cfg("Claude/claude_desktop_config.json"),
            instructions: Some(Where::Setting(
                "Claude → Settings → Profile, the preferences box",
            )),
            client: &["claude-ai", "claude desktop", "claude-desktop"],
        },
        Agent {
            id: "gemini",
            name: "Gemini CLI",
            format: Format::McpServers,
            file: h(".gemini/settings.json"),
            instructions: h(".gemini/GEMINI.md").map(Where::File),
            client: &["gemini"],
        },
        Agent {
            id: "windsurf",
            name: "Windsurf",
            format: Format::McpServers,
            file: h(".codeium/windsurf/mcp_config.json"),
            instructions: h(".codeium/windsurf/memories/global_rules.md").map(Where::File),
            client: &["windsurf", "codeium"],
        },
        Agent {
            id: "vscode",
            name: "VS Code",
            format: Format::Servers,
            file: cfg("Code/User/mcp.json"),
            instructions: Some(Where::Setting(
                ".github/copilot-instructions.md in each repository",
            )),
            client: &["visual studio code", "vscode", "vs code", "copilot"],
        },
        Agent {
            id: "zed",
            name: "Zed",
            format: Format::ContextServers,
            file: if cfg!(windows) {
                cfg("Zed/settings.json")
            } else {
                h(".config/zed/settings.json")
            },
            instructions: Some(Where::Setting(".rules at the root of each project")),
            client: &["zed"],
        },
    ]
}

pub fn find(id: &str) -> Option<Agent> {
    let id = id.to_ascii_lowercase().replace('_', "-");
    let id = match id.as_str() {
        "claude-code" => "claude",
        "desktop" => "claude-desktop",
        "code" => "vscode",
        other => other,
    };
    all().into_iter().find(|a| a.id == id)
}

pub fn ids() -> Vec<&'static str> {
    all().into_iter().map(|a| a.id).collect()
}

/// What the agent's file has under the name `snyvi`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    /// Registered, and the program it names exists.
    Connected { command: String, args: Vec<String> },
    /// Registered under a path that no longer exists: an update, a move, a
    /// tarball unpacked somewhere else. The one state that looks fine from
    /// the agent's side and fails on every send.
    Stale { command: String, args: Vec<String> },
    /// No file, or no entry in it.
    NotSetUp,
    /// A file that is there and cannot be read as what it should be.
    Unreadable { error: String },
}

impl State {
    fn registered(&self) -> Option<(&str, &[String])> {
        match self {
            State::Connected { command, args } | State::Stale { command, args } => {
                Some((command, args))
            }
            _ => None,
        }
    }
}

/// Whether a program spelling runs something: a bare name that PATH finds,
/// or a path that is a file.
fn program_exists(command: &str) -> bool {
    let p = Path::new(command);
    (p.components().count() == 1 && platform::find_on_path(command).is_some()) || p.is_file()
}

fn state_of(command: Option<(String, Vec<String>)>) -> State {
    match command {
        None => State::NotSetUp,
        Some((command, args)) if program_exists(&command) => State::Connected { command, args },
        Some((command, args)) => State::Stale { command, args },
    }
}

pub fn state(agent: &Agent) -> State {
    let Some(file) = &agent.file else {
        return State::NotSetUp;
    };
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return State::NotSetUp,
        Err(e) => {
            return State::Unreadable {
                error: e.to_string(),
            }
        }
    };
    if text.trim().is_empty() {
        return State::NotSetUp;
    }
    match agent.format {
        Format::Toml => match text.parse::<toml_edit::DocumentMut>() {
            Ok(doc) => state_of(toml_entry(&doc)),
            Err(e) => State::Unreadable {
                error: first_line(&e.to_string()),
            },
        },
        f => match serde_json::from_str::<Value>(&text) {
            Ok(v) => state_of(json_entry(&v, f)),
            Err(e) => State::Unreadable {
                error: e.to_string(),
            },
        },
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or_default().to_string()
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn json_entry(root: &Value, f: Format) -> Option<(String, Vec<String>)> {
    let e = root.get(f.key())?.get("snyvi")?;
    // Zed has spelled the command two ways: a string beside `args`, and,
    // earlier, an object with `path` and `args` in it.
    if let Some(c) = e.get("command").and_then(Value::as_str) {
        return Some((c.to_string(), strings(e.get("args"))));
    }
    let c = e.get("command")?.get("path")?.as_str()?;
    Some((c.to_string(), strings(e.get("command")?.get("args"))))
}

fn toml_entry(doc: &toml_edit::DocumentMut) -> Option<(String, Vec<String>)> {
    let e = doc.get("mcp_servers")?.get("snyvi")?;
    let command = e.get("command")?.as_str()?.to_string();
    let args = e
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some((command, args))
}

/// The entry as it goes into the agent's file.
fn json_value(f: Format, program: &str) -> Value {
    match f {
        Format::McpServers => json!({ "command": program, "args": ["mcp"] }),
        Format::Servers => json!({ "type": "stdio", "command": program, "args": ["mcp"] }),
        Format::ContextServers => {
            json!({ "source": "custom", "command": program, "args": ["mcp"] })
        }
        Format::Toml => unreachable!("TOML has its own spelling"),
    }
}

/// What to paste, for the person doing it by hand. Spelled by hand rather
/// than pretty-printed, so the entry is three lines and not nine.
pub fn snippet(agent: &Agent, program: &str) -> String {
    match agent.format {
        Format::Toml => {
            let mut t = toml_edit::Table::new();
            t["command"] = toml_edit::value(program);
            t["args"] = toml_edit::value(toml_edit::Array::from_iter(["mcp"]));
            format!("[mcp_servers.snyvi]\n{}", t).trim_end().to_string()
        }
        f => {
            let c = serde_json::to_string(program).unwrap_or_default();
            let extra = match f {
                Format::Servers => "\"type\": \"stdio\", ",
                Format::ContextServers => "\"source\": \"custom\", ",
                _ => "",
            };
            format!(
                "{{\n  \"{}\": {{\n    \"snyvi\": {{ {extra}\"command\": {c}, \"args\": [\"mcp\"] }}\n  }}\n}}",
                f.key()
            )
        }
    }
}

fn place(agent: &Agent) -> String {
    match &agent.file {
        Some(f) => tilde(f),
        None => format!(
            "wherever {} keeps its MCP servers on this system",
            agent.name
        ),
    }
}

/// A path with the home directory as `~`, the way the reader wrote it.
pub fn tilde(p: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = p.strip_prefix(&home) {
            return format!("~/{}", rest.display()).replace('\\', "/");
        }
    }
    p.display().to_string()
}

// ---------- the line ----------

fn line_present(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|s| s.contains("send_document"))
        .unwrap_or(false)
}

/// Append the line unless something in the file already names the tool.
pub fn line_add(path: &Path) -> Result<bool> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    if text.contains("send_document") {
        return Ok(false);
    }
    let mut out = text;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(LINE);
    out.push('\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, out)?;
    Ok(true)
}

/// Take out exactly the line `init` wrote, and a reworded one only if it
/// still names the tool on a line of its own.
pub fn line_remove(path: &Path) -> Result<bool> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !(l.contains("send_document") && l.contains("snyvi")))
        .collect();
    if kept.len() == text.lines().count() {
        return Ok(false);
    }
    let mut out = kept.join("\n");
    while out.ends_with("\n\n") {
        out.pop();
    }
    if !out.is_empty() {
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(true)
}

// ---------- init and uninstall ----------

/// The entry written, or the file left alone with the snippet printed.
enum Wrote {
    Done,
    /// The file has something snyvi does not understand; nothing was changed.
    Left(String),
}

/// Put the entry in, under whatever else the file has. JSON is parsed and
/// printed back with two-space indentation, as the agents themselves write
/// it; TOML goes through toml_edit and comes back with its comments and
/// spacing. Either way the rest of the file is what it was.
fn write_entry(agent: &Agent, file: &Path, program: &str) -> Result<Wrote> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", file.display())),
    };
    let out = match agent.format {
        Format::Toml => {
            let mut doc = if text.trim().is_empty() {
                toml_edit::DocumentMut::new()
            } else {
                match text.parse::<toml_edit::DocumentMut>() {
                    Ok(d) => d,
                    Err(e) => return Ok(Wrote::Left(first_line(&e.to_string()))),
                }
            };
            let servers = doc
                .entry("mcp_servers")
                .or_insert_with(|| {
                    let mut t = toml_edit::Table::new();
                    // `[mcp_servers.snyvi]` alone, not an empty `[mcp_servers]` above it.
                    t.set_implicit(true);
                    toml_edit::Item::Table(t)
                })
                .as_table_mut()
                .context("mcp_servers is not a table")?;
            let mut t = toml_edit::Table::new();
            t["command"] = toml_edit::value(program);
            t["args"] = toml_edit::value(toml_edit::Array::from_iter(["mcp"]));
            servers.insert("snyvi", toml_edit::Item::Table(t));
            doc.to_string()
        }
        f => {
            let mut root = if text.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => v,
                    Err(e) => return Ok(Wrote::Left(e.to_string())),
                }
            };
            let obj = root
                .as_object_mut()
                .context("the file is not a JSON object")?;
            let servers = obj.entry(f.key()).or_insert(json!({}));
            let servers = servers
                .as_object_mut()
                .with_context(|| format!("{} is not an object", f.key()))?;
            servers.insert("snyvi".into(), json_value(f, program));
            let mut s = serde_json::to_string_pretty(&root)?;
            if text.is_empty() || text.ends_with('\n') {
                s.push('\n');
            }
            s
        }
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, out).with_context(|| format!("writing {}", file.display()))?;
    Ok(Wrote::Done)
}

/// Take the entry out, and the servers object with it when ours was the only
/// one, so a file that had nothing of snyvi's before has nothing after.
fn remove_entry(agent: &Agent, file: &Path) -> Result<Wrote> {
    let text = std::fs::read_to_string(file)?;
    let out = match agent.format {
        Format::Toml => {
            let mut doc = match text.parse::<toml_edit::DocumentMut>() {
                Ok(d) => d,
                Err(e) => return Ok(Wrote::Left(first_line(&e.to_string()))),
            };
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(|s| s.as_table_mut()) {
                servers.remove("snyvi");
                if servers.is_empty() {
                    doc.remove("mcp_servers");
                }
            }
            doc.to_string()
        }
        f => {
            let mut root = match serde_json::from_str::<Value>(&text) {
                Ok(v) => v,
                Err(e) => return Ok(Wrote::Left(e.to_string())),
            };
            if let Some(obj) = root.as_object_mut() {
                let empty = obj
                    .get_mut(f.key())
                    .and_then(Value::as_object_mut)
                    .map(|s| {
                        s.remove("snyvi");
                        s.is_empty()
                    })
                    .unwrap_or(false);
                if empty {
                    obj.remove(f.key());
                }
            }
            let mut s = serde_json::to_string_pretty(&root)?;
            if text.ends_with('\n') {
                s.push('\n');
            }
            s
        }
    };
    std::fs::write(file, out)?;
    Ok(Wrote::Done)
}

/// `snyvi init <agent>`: read what is there, do only what is needed, and say
/// which of the three happened -- already registered, re-registered under
/// this binary, or registered.
pub fn init(agent: &Agent, instructions: bool) -> Result<()> {
    let (program, on_path) = setup::program();
    let base = crate::config::base_url();
    let Some(file) = &agent.file else {
        println!(
            "snyvi does not know where {} keeps its MCP servers on this system. Wherever that is, put this in it:\n\n{}\n",
            agent.name,
            indent(&snippet(agent, &program))
        );
        return Ok(());
    };
    let before = state(agent);
    let write = match &before {
        State::Connected { command, args }
            if args == &["mcp"] && same_program(command, &program) =>
        {
            println!(
                "{} already has snyvi registered: {command} mcp, in {}",
                agent.name,
                tilde(file)
            );
            false
        }
        State::Connected { command, .. } | State::Stale { command, .. } => {
            println!(
                "{} has snyvi registered as `{command}`, which is not this binary. Re-registering.",
                agent.name
            );
            true
        }
        State::NotSetUp => true,
        State::Unreadable { error } => {
            println!(
                "{} has something snyvi does not understand ({error}), so it was left alone. Put this in it yourself:\n\n{}\n",
                tilde(file),
                indent(&snippet(agent, &program))
            );
            false
        }
    };
    if write {
        match write_entry(agent, file, &program)? {
            Wrote::Done => println!(
                "Registered snyvi with {}: {program} mcp, in {}",
                agent.name,
                tilde(file)
            ),
            Wrote::Left(why) => {
                println!(
                    "{} has something snyvi does not understand ({why}), so it was left alone. Put this in it yourself:\n\n{}\n",
                    tilde(file),
                    indent(&snippet(agent, &program))
                );
                return Ok(());
            }
        }
        if !on_path {
            println!("  Written with the binary's full path, since `snyvi` is not on PATH; run this again if it moves.");
        }
    }

    match &agent.instructions {
        Some(Where::File(path)) if instructions => {
            if line_add(path)? {
                println!(
                    "Added a line to {}: {} is asked to send what it writes for you.",
                    tilde(path),
                    agent.name
                );
            } else {
                println!(
                    "{} already asks {} to send documents to snyvi.",
                    tilde(path),
                    agent.name
                );
            }
        }
        Some(Where::File(path)) if !line_present(path) => println!(
            "  `snyvi init {} --instructions` adds one line to {} asking {} to send you what it writes.",
            agent.id,
            tilde(path),
            agent.name
        ),
        Some(Where::File(_)) => {}
        Some(Where::Setting(place)) => println!(
            "  In {place}, one line makes {} send you what it writes:\n    {LINE}",
            agent.name
        ),
        None => {}
    }
    println!(
        "\nTry it: in {}, ask for a plan. It arrives at {base}, or in the window when one is open.",
        agent.name
    );
    println!(
        "`snyvi status` shows all of this; `snyvi uninstall {}` takes it back out.",
        agent.id
    );
    Ok(())
}

/// `snyvi uninstall <agent>`: the entry and the line, and nothing else. The
/// library is not touched, and says where it is.
pub fn uninstall(agent: &Agent) -> Result<()> {
    uninstall_keeping(agent, true)
}

/// `keeping` says whether to end by naming what is left, which is true
/// after `uninstall` and false after a `reset --agents`, where nothing is.
pub fn uninstall_keeping(agent: &Agent, keeping: bool) -> Result<()> {
    let Some(file) = &agent.file else {
        println!("snyvi does not know where {} keeps its MCP servers on this system; nothing to take out.", agent.name);
        return Ok(());
    };
    match state(agent) {
        State::NotSetUp => println!("{} has no snyvi MCP server registered.", agent.name),
        State::Unreadable { error } => println!(
            "{} has something snyvi does not understand ({error}), so it was left alone.",
            tilde(file)
        ),
        _ => match remove_entry(agent, file)? {
            Wrote::Done => println!(
                "Removed snyvi from {}'s MCP servers, in {}.",
                agent.name,
                tilde(file)
            ),
            Wrote::Left(why) => println!(
                "{} has something snyvi does not understand ({why}), so it was left alone.",
                tilde(file)
            ),
        },
    }
    if let Some(Where::File(path)) = &agent.instructions {
        if line_remove(path)? {
            println!("Removed the snyvi line from {}.", tilde(path));
        }
    }
    if !keeping {
        return Ok(());
    }
    let paths = crate::config::paths();
    println!(
        "\nKept: your documents and index in {}, the token in {}.",
        paths.data_dir.display(),
        paths.config_dir.display()
    );
    Ok(())
}

fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("  {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------- the page ----------

#[derive(Serialize)]
pub struct Row {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub state: State,
    /// The agent's servers file, as the reader would write it.
    pub file: Option<String>,
    pub fix: Fix,
    pub instructions: Option<Instructions>,
    /// When a document last arrived from this agent, if one ever has, and
    /// the name it gave.
    pub last_sent: Option<i64>,
    pub sender: Option<String>,
    /// How many of this agent hold a stream on the daemon right now: its
    /// sessions that are open, whether or not any has sent.
    pub live: usize,
}

#[derive(Serialize)]
pub struct Fix {
    /// The one line that does it.
    pub command: String,
    /// What to paste, for the person doing it by hand, and where.
    pub snippet: String,
    pub place: String,
}

#[derive(Serialize)]
pub struct Instructions {
    pub place: String,
    /// Whether `place` is a file snyvi read, and the line is in it. None
    /// when the place is a setting snyvi cannot see into.
    pub present: Option<bool>,
    pub line: &'static str,
}

/// One row per agent, and one more for each name the daemon has heard
/// that is none of them, so a client snyvi has never heard of still shows
/// as connected once it has proved it. `senders` is what the store knows:
/// each `clientInfo.name`, and when it last sent. `online` is what the
/// daemon knows now: each name holding a stream, and how many of it.
pub fn rows(senders: &[(String, i64)], online: &BTreeMap<String, usize>) -> Vec<Row> {
    let (program, _) = setup::program();
    let mut claimed_sender = vec![false; senders.len()];
    let mut claimed_online: BTreeMap<&str, bool> =
        online.keys().map(|k| (k.as_str(), false)).collect();
    let mut out: Vec<Row> = all()
        .iter()
        .map(|a| {
            let is_theirs = |name: &str| {
                let n = name.to_ascii_lowercase();
                a.client.iter().any(|c| n.contains(c))
            };
            let latest = senders
                .iter()
                .enumerate()
                .filter(|(_, (name, _))| is_theirs(name))
                .map(|(i, (name, t))| {
                    claimed_sender[i] = true;
                    (*t, name.clone())
                })
                .max();
            let (last_sent, sender) = match latest {
                Some((t, n)) => (Some(t), Some(n)),
                None => (None, None),
            };
            let live = online
                .iter()
                .filter(|(name, _)| is_theirs(name))
                .map(|(name, n)| {
                    claimed_online.insert(name.as_str(), true);
                    *n
                })
                .sum();
            Row {
                id: a.id.to_string(),
                name: a.name.to_string(),
                state: state(a),
                file: a.file.as_deref().map(tilde),
                fix: Fix {
                    command: format!("{program} init {}", a.id),
                    snippet: snippet(a, &program),
                    place: place(a),
                },
                instructions: a.instructions.as_ref().map(|w| match w {
                    Where::File(p) => Instructions {
                        place: tilde(p),
                        present: Some(line_present(p)),
                        line: LINE,
                    },
                    Where::Setting(s) => Instructions {
                        place: s.to_string(),
                        present: None,
                        line: LINE,
                    },
                }),
                last_sent,
                sender,
                live,
            }
        })
        .collect();
    // The names none of the table's agents own: a sender, an agent that is
    // here now, or both, under the one row its name is.
    let mut others: BTreeMap<&str, (Option<i64>, usize)> = BTreeMap::new();
    for (i, (name, t)) in senders.iter().enumerate() {
        if !claimed_sender[i] {
            others.entry(name).or_insert((None, 0)).0 = Some(*t);
        }
    }
    for (name, n) in online {
        if !claimed_online[name.as_str()] {
            others.entry(name).or_insert((None, 0)).1 = *n;
        }
    }
    for (name, (last_sent, live)) in others {
        out.push(Row {
            id: format!("sender:{name}"),
            name: name.to_string(),
            state: State::Connected {
                command: String::new(),
                args: vec![],
            },
            file: None,
            fix: Fix {
                command: String::new(),
                snippet: String::new(),
                place: String::new(),
            },
            instructions: None,
            last_sent,
            sender: Some(name.to_string()),
            live,
        });
    }
    out
}

/// `snyvi init` with no agent: the page, as text. The senders and who is
/// here now come from the daemon when it is up; the senders alone from the
/// database when it is not, and are none when there is neither.
pub fn list(paths: &crate::config::Paths) -> Result<()> {
    let mut online = BTreeMap::new();
    let senders = if crate::client::health().is_some() {
        ureq::get(&format!("{}/api/agents", crate::config::base_url()))
            .call()
            .ok()
            .and_then(|mut r| r.body_mut().read_json::<Value>().ok())
            .map(|v| {
                online = v
                    .get("online")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter_map(|(k, n)| Some((k.clone(), n.as_u64()? as usize)))
                    .collect();
                v.get("rows")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        Some((
                            r.get("sender")?.as_str()?.to_string(),
                            r.get("last_sent")?.as_i64()?,
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else if paths.db_path.exists() {
        crate::store::Store::open(paths)?.senders()?
    } else {
        Vec::new()
    };
    let now = crate::store::now();
    for r in rows(&senders, &online) {
        let what = match &r.state {
            State::Connected { command, .. } if command.is_empty() => {
                if r.last_sent.is_some() {
                    "sent to snyvi".to_string()
                } else {
                    "here, under its own name".to_string()
                }
            }
            State::Connected { command, args } => {
                format!("connected ({command} {})", args.join(" "))
            }
            State::Stale { command, .. } => {
                format!(
                    "registered as `{command}`, which no longer exists; run `{}`",
                    r.fix.command
                )
            }
            State::NotSetUp => format!("not set up; run `{}`", r.fix.command),
            State::Unreadable { error } => {
                format!("{} could not be read: {error}", r.file.unwrap_or_default())
            }
        };
        let here = match r.live {
            0 => String::new(),
            1 => ", online".to_string(),
            n => format!(", online \u{d7}{n}"),
        };
        let when = match r.last_sent {
            Some(t) => format!(", last sent {}", ago(now - t)),
            None => String::new(),
        };
        println!("{}: {what}{here}{when}", r.name);
    }
    Ok(())
}

fn ago(secs: i64) -> String {
    match secs {
        s if s < 90 => "just now".to_string(),
        s if s < 3600 => format!("{} minutes ago", s / 60),
        s if s < 86_400 => format!("{} hours ago", s / 3600),
        s => format!("{} days ago", s / 86_400),
    }
}

/// One line per agent that has snyvi registered, for `snyvi status` after
/// Claude Code's own line, and for the about box. Agents that are not set
/// up say nothing here; the page is where they are listed.
pub fn status_lines() -> Vec<String> {
    all()
        .iter()
        .filter(|a| a.id != "claude")
        .filter_map(|a| {
            let s = state(a);
            let (c, args) = s.registered()?;
            let mut line = format!("{}: MCP server registered ({c} {})", a.name, args.join(" "));
            if matches!(s, State::Stale { .. }) {
                line.push_str(&format!(
                    "\n  a registered path no longer exists; run `snyvi init {}` again",
                    a.id
                ));
            }
            Some(line)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, dir: &Path) -> Agent {
        let mut a = find(id).unwrap();
        let file = a.file.take().unwrap();
        a.file = Some(dir.join(file.file_name().unwrap()));
        a
    }

    #[test]
    fn json_in_and_out_leaves_the_rest() {
        let dir = std::env::temp_dir().join(format!("snyvi-agents-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = agent("cursor", &dir);
        let file = a.file.clone().unwrap();
        std::fs::write(
            &file,
            "{\"mcpServers\":{\"other\":{\"command\":\"x\"}},\"theme\":1}\n",
        )
        .unwrap();
        assert_eq!(state(&a), State::NotSetUp);
        assert!(matches!(
            write_entry(&a, &file, "/nowhere/snyvi").unwrap(),
            Wrote::Done
        ));
        assert_eq!(
            state(&a),
            State::Stale {
                command: "/nowhere/snyvi".into(),
                args: vec!["mcp".into()]
            }
        );
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert_eq!(v["theme"], 1);
        assert!(matches!(remove_entry(&a, &file).unwrap(), Wrote::Done));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v, json!({"mcpServers":{"other":{"command":"x"}},"theme":1}));
        // Only ours: the servers object goes too.
        std::fs::write(&file, "{\"theme\":1}").unwrap();
        write_entry(&a, &file, "snyvi").unwrap();
        remove_entry(&a, &file).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\n  \"theme\": 1\n}"
        );
        // A file with a comment in it is not touched.
        std::fs::write(&file, "// mine\n{}").unwrap();
        assert!(matches!(
            write_entry(&a, &file, "snyvi").unwrap(),
            Wrote::Left(_)
        ));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "// mine\n{}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn toml_keeps_comments_and_comes_out_byte_equal() {
        let dir = std::env::temp_dir().join(format!("snyvi-agents-toml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = agent("codex", &dir);
        let file = a.file.clone().unwrap();
        let before = "# mine\nmodel = \"o3\"   # keep\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        std::fs::write(&file, before).unwrap();
        write_entry(&a, &file, "snyvi").unwrap();
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.starts_with(before), "{after}");
        assert!(
            after.contains("[mcp_servers.snyvi]\ncommand = \"snyvi\"\nargs = [\"mcp\"]"),
            "{after}"
        );
        assert!(matches!(
            state(&a),
            State::Connected { .. } | State::Stale { .. }
        ));
        remove_entry(&a, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        // Nothing but ours: the table goes, and the file is empty again.
        std::fs::write(&file, "").unwrap();
        write_entry(&a, &file, "snyvi").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[mcp_servers.snyvi]\ncommand = \"snyvi\"\nargs = [\"mcp\"]\n"
        );
        remove_entry(&a, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_snippet_is_the_entry() {
        let (cursor, codex, zed, code) = (
            find("cursor").unwrap(),
            find("codex").unwrap(),
            find("zed").unwrap(),
            find("vscode").unwrap(),
        );
        assert!(snippet(&cursor, "snyvi").contains("\"mcpServers\""));
        assert_eq!(
            snippet(&codex, "/opt/snyvi"),
            "[mcp_servers.snyvi]\ncommand = \"/opt/snyvi\"\nargs = [\"mcp\"]"
        );
        assert!(snippet(&zed, "snyvi").contains("\"context_servers\""));
        assert!(snippet(&code, "snyvi").contains("\"type\": \"stdio\""));
    }

    #[test]
    fn senders_land_on_their_agent_or_on_a_row_of_their_own() {
        let rows = rows(
            &[
                ("claude-code".into(), 10),
                ("codex-mcp-client".into(), 20),
                ("Something Else".into(), 30),
            ],
            &BTreeMap::new(),
        );
        let by = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by("claude").last_sent, Some(10));
        assert_eq!(by("codex").last_sent, Some(20));
        assert_eq!(by("cursor").last_sent, None);
        let other = by("sender:Something Else");
        assert_eq!(other.last_sent, Some(30));
        assert!(matches!(other.state, State::Connected { .. }));
        assert!(rows.iter().all(|r| r.live == 0));
    }

    #[test]
    fn the_agents_here_now_count_on_their_row() {
        let online: BTreeMap<String, usize> = [
            ("claude-code".to_string(), 3),
            ("Something Else".to_string(), 1),
            ("never-sent".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let rows = rows(&[("Something Else".into(), 30)], &online);
        let by = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by("claude").live, 3);
        assert_eq!(by("codex").live, 0);
        // One row for a name, whether it has sent, is here, or both.
        let other = by("sender:Something Else");
        assert_eq!((other.last_sent, other.live), (Some(30), 1));
        let quiet = by("sender:never-sent");
        assert_eq!((quiet.last_sent, quiet.live), (None, 2));
        assert_eq!(
            rows.iter().filter(|r| r.id.starts_with("sender:")).count(),
            2
        );
    }
}
