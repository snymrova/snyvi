//! The first ten minutes: registering with Claude Code, undoing it, and putting
//! the command where a shell finds it.
//!
//! Everything here is run more than once in a program's life -- after an
//! update, after the binary moved, on a second machine set up from notes --
//! so each step reads what is there before it changes anything, does nothing
//! when there is nothing to do, and says which of the two happened.

use crate::hook;
use crate::platform;
use anyhow::{Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The line `--claude-md` writes. Matched on `send_document` when removed or
/// checked for, so a reader who rewords it keeps their wording.
pub const CLAUDE_MD_LINE: &str = "When you produce a document for me to read (plan, review, summary), send it to snyvi with send_document and give me the link.";

/// How this binary is named to Claude Code: `snyvi` when the `snyvi` a shell
/// would run is this file, its absolute path otherwise. A bare name survives
/// a binary that moves within PATH, an update that replaces it, and a
/// package that installs over a tarball; an absolute path is right when the
/// binary is not on PATH at all, which is the only case it was written for.
pub fn program() -> (String, bool) {
    let here = std::env::current_exe().and_then(|p| p.canonicalize()).ok();
    let on_path = platform::find_on_path("snyvi")
        .and_then(|p| p.canonicalize().ok())
        .zip(here.as_ref())
        .map(|(found, here)| &found == here)
        .unwrap_or(false);
    if on_path {
        ("snyvi".to_string(), true)
    } else {
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("snyvi"));
        (exe.to_string_lossy().to_string(), false)
    }
}

/// Whether two program spellings run the same file.
fn same_program(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let resolve = |s: &str| -> Option<PathBuf> {
        let p = Path::new(s);
        if p.components().count() > 1 {
            p.canonicalize().ok()
        } else {
            platform::find_on_path(s).and_then(|p| p.canonicalize().ok())
        }
    };
    matches!((resolve(a), resolve(b)), (Some(x), Some(y)) if x == y)
}

/// What Claude Code has under the name `snyvi`, read from where its user
/// scope lives rather than asked of `claude`, which need not be installed to
/// answer. The command and its arguments.
pub fn registered() -> Option<(String, Vec<String>)> {
    let path = dirs::home_dir()?.join(".claude.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let s = v.get("mcpServers")?.get("snyvi")?;
    let command = s.get("command")?.as_str()?.to_string();
    let args = s
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some((command, args))
}

enum Claude {
    Ok,
    Failed(String),
    Missing,
}

/// Run `claude` with its output captured: what it prints is ours to
/// summarise, and a `claude` that cannot be started is a different answer
/// from one that ran and refused.
fn claude(args: &[&str]) -> Claude {
    match platform::shim("claude").args(args).output() {
        Ok(out) if out.status.success() => Claude::Ok,
        Ok(out) => {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            );
            let text = text.trim().to_string();
            // cmd /C on Windows answers a missing program with a status, not an error.
            if text.contains("is not recognized as") {
                Claude::Missing
            } else {
                Claude::Failed(text)
            }
        }
        Err(_) => Claude::Missing,
    }
}

pub fn init_claude(auto: bool, claude_md: bool) -> Result<()> {
    let (exe, on_path) = program();
    let base = crate::config::base_url();

    // 1. The MCP server.
    let manual = format!("claude mcp add --scope user snyvi -- {exe} mcp");
    let add = |why: &str| match claude(&[
        "mcp", "add", "--scope", "user", "snyvi", "--", &exe, "mcp",
    ]) {
        Claude::Ok => println!("Registered snyvi with Claude Code (user scope){why}: {exe} mcp"),
        Claude::Failed(text) if text.contains("already exists") => {
            println!(
                "Claude Code already has a snyvi registered, under another path. Re-registering."
            );
            if let Claude::Ok = claude(&["mcp", "remove", "--scope", "user", "snyvi"]) {
                if let Claude::Ok =
                    claude(&["mcp", "add", "--scope", "user", "snyvi", "--", &exe, "mcp"])
                {
                    println!("Registered snyvi with Claude Code (user scope): {exe} mcp");
                    return;
                }
            }
            println!("Could not re-register. Do it by hand:\n\n  claude mcp remove --scope user snyvi\n  {manual}\n");
        }
        Claude::Failed(text) => {
            println!(
                "`claude mcp add` failed:\n  {}\n\nRegister by hand once it works:\n\n  {manual}\n",
                text.replace('\n', "\n  ")
            );
        }
        Claude::Missing => {
            println!("`claude` is not on PATH, so snyvi is not registered yet. Install Claude Code and run this again, or register by hand:\n\n  {manual}\n");
        }
    };
    match registered() {
        Some((c, a)) if a == ["mcp"] && same_program(&c, &exe) => {
            println!("Claude Code already has snyvi registered (user scope): {c} mcp");
        }
        Some((c, _)) => {
            println!("Claude Code has snyvi registered as `{c}`, which is not this binary. Re-registering.");
            match claude(&["mcp", "remove", "--scope", "user", "snyvi"]) {
                Claude::Ok => add(""),
                Claude::Missing => add(""),
                Claude::Failed(text) => println!("`claude mcp remove` failed:\n  {text}\n\nBy hand:\n\n  claude mcp remove --scope user snyvi\n  {manual}\n"),
            }
        }
        None => add(""),
    }

    // 2. The hooks.
    let command = hook::command_line(&exe);
    let (path, events, rewritten) = hook::install(&command, auto)?;
    let file = path.display();
    if rewritten {
        println!("Hooks in {file} now run this binary ({command}).");
    }
    if events.contains(&"PostToolUse") {
        println!("Hooks in {file}: SessionStart, PostToolUse (every Markdown file Claude writes is sent).");
    } else {
        println!("Hook in {file}: SessionStart (documents from one session share a workflow).");
        println!("  `snyvi init-claude --auto` adds a PostToolUse hook that sends every Markdown file Claude writes.");
    }
    if !on_path {
        println!("  Written with the binary's full path, since `snyvi` is not on PATH; run this again if it moves.");
    }

    // 3. The line in CLAUDE.md.
    if claude_md {
        let (path, added) = claude_md_add()?;
        if added {
            println!(
                "Added a line to {}: Claude is asked to send what it writes for you.",
                path.display()
            );
        } else {
            println!(
                "{} already asks Claude to send documents to snyvi.",
                path.display()
            );
        }
    } else if !claude_md_has()? {
        println!("  `snyvi init-claude --claude-md` adds one line to ~/.claude/CLAUDE.md asking Claude to send you what it writes.");
    }

    println!("\nTry it: in Claude Code, ask for a plan. It arrives at {base}, or in the window when one is open.");
    println!("`snyvi status` shows all of this; `snyvi uninstall-claude` takes it back out.");
    Ok(())
}

/// Undo `init-claude`: the MCP entry, every hook of ours, the CLAUDE.md line.
/// The library is not touched, and says where it is.
pub fn uninstall_claude() -> Result<()> {
    match registered() {
        Some(_) => match claude(&["mcp", "remove", "--scope", "user", "snyvi"]) {
            Claude::Ok => println!("Removed snyvi from Claude Code's MCP servers."),
            Claude::Missing => println!("`claude` is not on PATH; remove the MCP entry by hand:\n\n  claude mcp remove --scope user snyvi\n"),
            Claude::Failed(text) => println!("`claude mcp remove` failed:\n  {text}"),
        },
        None => println!("Claude Code has no snyvi MCP server registered."),
    }
    let (path, n) = hook::uninstall()?;
    match n {
        0 => println!("No snyvi hooks in {}.", path.display()),
        n => println!("Removed {n} snyvi hook(s) from {}.", path.display()),
    }
    if let Some(path) = claude_md_remove()? {
        println!("Removed the snyvi line from {}.", path.display());
    }
    let paths = crate::config::paths();
    println!(
        "\nKept: your documents and index in {}, the token in {}.\n`snyvi stop` ends the daemon; then remove the package or the binary, and those two directories if you want nothing left.",
        paths.data_dir.display(),
        paths.config_dir.display()
    );
    Ok(())
}

fn claude_md_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join(".claude")
        .join("CLAUDE.md"))
}

fn claude_md_has() -> Result<bool> {
    let path = claude_md_path()?;
    Ok(std::fs::read_to_string(path)
        .map(|s| s.contains("send_document"))
        .unwrap_or(false))
}

/// Append the line unless something in the file already names the tool.
fn claude_md_add() -> Result<(PathBuf, bool)> {
    let path = claude_md_path()?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if text.contains("send_document") {
        return Ok((path, false));
    }
    let mut out = text;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(CLAUDE_MD_LINE);
    out.push('\n');
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, out)?;
    Ok((path, true))
}

/// Take out exactly the line `--claude-md` wrote, and a reworded one only
/// if it still names the tool on a line of its own.
fn claude_md_remove() -> Result<Option<PathBuf>> {
    let path = claude_md_path()?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !(l.contains("send_document") && l.contains("snyvi")))
        .collect();
    if kept.len() == text.lines().count() {
        return Ok(None);
    }
    let mut out = kept.join("\n");
    while out.ends_with("\n\n") {
        out.pop();
    }
    if !out.is_empty() {
        out.push('\n');
    }
    std::fs::write(&path, out)?;
    Ok(Some(path))
}

/// One line for `snyvi status`: what Claude Code has of snyvi, and whether
/// it still points at a binary that exists.
pub fn claude_code_status() -> String {
    let mut parts = Vec::new();
    let mut stale = false;
    match registered() {
        Some((c, a)) => {
            let exists = Path::new(&c).components().count() == 1
                && platform::find_on_path(&c).is_some()
                || Path::new(&c).is_file();
            if !exists {
                stale = true;
            }
            parts.push(format!("MCP server registered ({c} {})", a.join(" ")));
        }
        None => parts.push("MCP server not registered".to_string()),
    }
    let hooks = hook::settings_path()
        .and_then(|p| hook::read_settings(&p))
        .map(|s| hook::installed(&s))
        .unwrap_or_default();
    if hooks.is_empty() {
        parts.push("no hooks".to_string());
    } else {
        for (_, c) in &hooks {
            let program = c.trim_end_matches(" hook").trim_matches('"');
            let exists = Path::new(program).components().count() == 1
                && platform::find_on_path(program).is_some()
                || Path::new(program).is_file();
            if !exists {
                stale = true;
            }
        }
        parts.push(format!(
            "hooks: {}",
            hooks.iter().map(|(e, _)| *e).collect::<Vec<_>>().join(", ")
        ));
    }
    let mut line = format!("Claude Code: {}", parts.join("; "));
    if stale {
        line.push_str("\n  a registered path no longer exists; run `snyvi init-claude` again");
    } else if registered().is_none() {
        line.push_str("; run `snyvi init-claude`");
    }
    line
}

/// Put `snyvi` where a shell finds it.
///
/// On macOS the command line lives inside the bundle, and the README's
/// `ln -s` into /usr/local/bin fails for exactly the people it is written
/// for: that directory is root's on a fresh Mac and absent on Apple silicon
/// until Homebrew makes it. So: the directory asked for, else /usr/local/bin
/// when it can be written, else ~/.local/bin, created; and a note when the
/// one used is not on PATH. On Windows there is nothing to link, so the
/// binary's own folder is added to the user's PATH instead.
pub fn install_cli(dir: Option<PathBuf>) -> Result<()> {
    let exe = std::env::current_exe()?.canonicalize()?;
    #[cfg(windows)]
    {
        let _ = dir;
        return install_cli_windows(&exe);
    }
    #[cfg(not(windows))]
    {
        let home = dirs::home_dir().context("no home directory")?;
        let candidates: Vec<PathBuf> = match dir {
            Some(d) => vec![d],
            None => vec![
                PathBuf::from("/usr/local/bin"),
                home.join(".local").join("bin"),
            ],
        };
        let mut last_err = None;
        for dir in &candidates {
            match link_into(dir, &exe) {
                Ok(link) => {
                    let on_path = std::env::var_os("PATH")
                        .map(|p| {
                            std::env::split_paths(&p)
                                .any(|d| d.canonicalize().ok() == dir.canonicalize().ok())
                        })
                        .unwrap_or(false);
                    println!("{} -> {}", link.display(), exe.display());
                    if !on_path {
                        let rc = if cfg!(target_os = "macos") {
                            "~/.zshrc"
                        } else {
                            "~/.bashrc"
                        };
                        println!(
                            "{} is not on PATH. Add it, in {rc}:\n\n  export PATH=\"{}:$PATH\"\n\nthen open a new terminal.",
                            dir.display(),
                            dir.display()
                        );
                    } else {
                        println!("`snyvi` now runs from any terminal.");
                    }
                    return Ok(());
                }
                Err(e) => {
                    last_err = Some((dir.clone(), e));
                }
            }
        }
        let (dir, e) = last_err.unwrap();
        anyhow::bail!(
            "could not link into {}: {e}\n  sudo snyvi install-cli {}   links there as root; `snyvi install-cli ~/.local/bin` needs no sudo",
            dir.display(),
            dir.display()
        )
    }
}

#[cfg(not(windows))]
fn link_into(dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    if !dir.is_dir() {
        // /usr/local/bin is not created here: a directory made by snyvi in a
        // root-owned tree is not something to leave behind.
        if dir.starts_with("/usr") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such directory",
            ));
        }
        std::fs::create_dir_all(dir)?;
    }
    let link = dir.join("snyvi");
    if let Ok(target) = std::fs::read_link(&link) {
        if target == exe {
            return Ok(link);
        }
    }
    if link.exists() || link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link)?;
    }
    std::os::unix::fs::symlink(exe, &link)?;
    Ok(link)
}

#[cfg(windows)]
fn install_cli_windows(exe: &Path) -> Result<()> {
    use std::process::Command;
    let dir = exe.parent().context("the binary has no folder")?;
    // canonicalize answers with the verbatim form, `\\?\C:\...`, which is
    // not a spelling PATH is read in.
    let dir = dir.to_string_lossy().to_string();
    let dir = dir.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(dir);
    let read = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path','User')",
        ])
        .output()
        .context("running powershell")?;
    let current = String::from_utf8_lossy(&read.stdout).trim().to_string();
    let has = current.split(';').any(|d| {
        d.trim()
            .trim_end_matches('\\')
            .eq_ignore_ascii_case(dir.trim_end_matches('\\'))
    });
    if has {
        println!("{dir} is already on your PATH.");
        return Ok(());
    }
    let joined = if current.is_empty() {
        dir.clone()
    } else {
        format!("{current};{dir}")
    };
    let script = format!(
        "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
        joined.replace('\'', "''")
    );
    let set = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()
        .context("running powershell")?;
    anyhow::ensure!(set.success(), "powershell could not set the user PATH");
    println!("Added {dir} to your PATH. Open a new terminal and `snyvi` runs from anywhere.");
    Ok(())
}
