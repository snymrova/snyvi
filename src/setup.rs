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
pub fn same_program(a: &str, b: &str) -> bool {
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
    println!("Hooks in {file}: SessionStart (documents from one session share a workflow), and the prompt, tool, permission and end-of-turn events (a desk panel running Claude says whether it is working, needs you, or is done).");
    if events.contains(&"PostToolUse") {
        println!("  And PostToolUse on Write and Edit: every Markdown file Claude writes is sent.");
    } else {
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

/// `init-claude --refresh`, which is what an installer runs over an older
/// snyvi: whatever Claude Code already has of snyvi -- the MCP entry, the
/// hooks, the auto-send hook or not -- is pointed at this binary, and
/// nothing is added. A reader who took the auto-send hook out, or never
/// registered at all, is not signed back up by an update.
pub fn refresh_claude() -> Result<()> {
    let hooks = hook::settings_path()
        .and_then(|p| hook::read_settings(&p))
        .map(|s| !hook::installed(&s).is_empty())
        .unwrap_or(false);
    if registered().is_none() && !hooks {
        println!("Claude Code has nothing of snyvi, so nothing to refresh; `snyvi init-claude` registers it.");
        return Ok(());
    }
    init_claude(false, false)
}

/// Undo `init-claude`: the MCP entry, every hook of ours, the CLAUDE.md line.
/// The library is not touched, and says where it is.
pub fn uninstall_claude() -> Result<()> {
    uninstall_claude_keeping(true)
}

/// `keeping` says whether to end by naming what is left -- the documents and
/// the token -- which is true after `uninstall-claude` and false after a
/// `reset --agents`, where there is nothing left to name.
pub fn uninstall_claude_keeping(keeping: bool) -> Result<()> {
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
    if !keeping {
        return Ok(());
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
    let added = crate::agents::line_add(&path)?;
    Ok((path, added))
}

/// Take out exactly the line `--claude-md` wrote, and a reworded one only
/// if it still names the tool on a line of its own.
fn claude_md_remove() -> Result<Option<PathBuf>> {
    let path = claude_md_path()?;
    Ok(crate::agents::line_remove(&path)?.then_some(path))
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

// ---------- the desktop, on Linux ----------

/// The first line of every text file `install-desktop` writes, which is how
/// `uninstall-desktop` knows which of them it may take back out: a menu
/// entry or a unit of the same name that someone wrote by hand is left.
#[cfg(target_os = "linux")]
const WRITTEN_BY: &str =
    "# Written by `snyvi install-desktop`; `snyvi uninstall-desktop` removes it.";

#[cfg(target_os = "linux")]
const DESKTOP_ENTRY: &str = include_str!("../packaging/snyvi.desktop");
#[cfg(target_os = "linux")]
const SERVICE_UNIT: &str = include_str!("../packaging/snyvi.service");
/// The sizes the `.deb` installs, less 512, which no panel asks for and
/// which is half the bytes; the scalable master covers anything larger.
#[cfg(target_os = "linux")]
const ICONS: [(u32, &[u8]); 7] = [
    (16, include_bytes!("../icons/16.png")),
    (24, include_bytes!("../icons/24.png")),
    (32, include_bytes!("../icons/32.png")),
    (48, include_bytes!("../icons/48.png")),
    (64, include_bytes!("../icons/64.png")),
    (128, include_bytes!("../icons/128.png")),
    (256, include_bytes!("../icons/256.png")),
];
#[cfg(target_os = "linux")]
const ICON_SVG: &[u8] = include_bytes!("../icons/icon.svg");

/// One argument of an `Exec=` line, as the desktop entry spec wants it:
/// quoted when it holds anything the spec reserves, with `"`, `` ` ``, `$`
/// and `\` escaped inside the quotes, and then every `\` doubled again
/// because the whole value is a string with escapes of its own. `%` is a
/// field code, so a literal one is `%%`.
#[cfg(target_os = "linux")]
fn desktop_arg(arg: &str) -> String {
    let reserved = |c: char| " \t\n\"'\\><~|&;$*?#()`".contains(c);
    let arg = arg.replace('%', "%%");
    let quoted = if arg.chars().any(reserved) {
        let mut q = String::from("\"");
        for c in arg.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                q.push('\\');
            }
            q.push(c);
        }
        q.push('"');
        q
    } else {
        arg
    };
    quoted.replace('\\', "\\\\")
}

/// One argument of a unit's `ExecStart=`: quoted when it has a space or a
/// quote, `\` and `"` escaped inside; `%` is a specifier and `$` a variable,
/// so each is doubled.
#[cfg(target_os = "linux")]
fn systemd_arg(arg: &str) -> String {
    let arg = arg.replace('%', "%%").replace('$', "$$");
    if arg
        .chars()
        .any(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
    {
        format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        arg
    }
}

/// The package's menu entry, for this binary: `Exec` and `TryExec` name it
/// by its path, since a per-user bin directory is not on the PATH a desktop
/// session starts programs with on every distribution.
#[cfg(target_os = "linux")]
fn desktop_entry(template: &str, exe: &Path) -> String {
    let exe = exe.to_string_lossy();
    let mut out = format!("{WRITTEN_BY}\n");
    for line in template.lines() {
        if line.starts_with("Exec=") {
            out.push_str(&format!("TryExec={}\n", exe.replace('\\', "\\\\")));
            out.push_str(&format!("Exec={} app %u\n", desktop_arg(&exe)));
        } else if !line.starts_with("TryExec=") {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// The package's unit, for this binary.
#[cfg(target_os = "linux")]
fn service_unit(template: &str, exe: &Path) -> String {
    let mut out = format!("{WRITTEN_BY}\n");
    for line in template.lines() {
        if line.starts_with("ExecStart=") {
            out.push_str(&format!(
                "ExecStart={} serve\n",
                systemd_arg(&exe.to_string_lossy())
            ));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// What `install-desktop` writes, and where, under the two directories the
/// XDG spec gives a user: the data home for the entry and the icons, the
/// config home for the unit.
#[cfg(target_os = "linux")]
struct DesktopFiles {
    entry: PathBuf,
    icons: Vec<(PathBuf, &'static [u8])>,
    unit: PathBuf,
}

#[cfg(target_os = "linux")]
impl DesktopFiles {
    fn under(data: &Path, config: &Path) -> DesktopFiles {
        let hicolor = data.join("icons").join("hicolor");
        let mut icons: Vec<(PathBuf, &'static [u8])> = ICONS
            .iter()
            .map(|(px, bytes)| {
                (
                    hicolor
                        .join(format!("{px}x{px}"))
                        .join("apps")
                        .join("snyvi.png"),
                    *bytes,
                )
            })
            .collect();
        icons.push((
            hicolor.join("scalable").join("apps").join("snyvi.svg"),
            ICON_SVG,
        ));
        DesktopFiles {
            entry: data.join("applications").join("snyvi.desktop"),
            icons,
            unit: config.join("systemd").join("user").join("snyvi.service"),
        }
    }
}

/// Write `bytes` at `path` unless it already holds them. True when written.
#[cfg(target_os = "linux")]
fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<bool> {
    if std::fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

/// The files themselves, with no program run: what the tests call. `unit`
/// says systemd is here to read one. Returns each file and whether it was
/// written or already current.
#[cfg(target_os = "linux")]
fn install_desktop_into(
    data: &Path,
    config: &Path,
    exe: &Path,
    unit: bool,
) -> Result<Vec<(PathBuf, bool)>> {
    let f = DesktopFiles::under(data, config);
    let mut done = vec![];
    let entry = desktop_entry(DESKTOP_ENTRY, exe);
    done.push((
        f.entry.clone(),
        write_if_changed(&f.entry, entry.as_bytes())?,
    ));
    for (path, bytes) in &f.icons {
        done.push((path.clone(), write_if_changed(path, bytes)?));
    }
    if unit {
        let text = service_unit(SERVICE_UNIT, exe);
        done.push((f.unit.clone(), write_if_changed(&f.unit, text.as_bytes())?));
    }
    Ok(done)
}

#[cfg(target_os = "linux")]
fn uninstall_desktop_from(data: &Path, config: &Path) -> Result<Vec<PathBuf>> {
    let f = DesktopFiles::under(data, config);
    let mut gone = vec![];
    for path in [&f.entry, &f.unit] {
        let ours = std::fs::read_to_string(path)
            .map(|s| s.starts_with(WRITTEN_BY))
            .unwrap_or(false);
        if ours {
            std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
            gone.push(path.clone());
        }
    }
    // The icons carry no mark, but a file called snyvi.png in snyvi's place
    // in the theme is snyvi's.
    for (path, _) in &f.icons {
        if path.is_file() {
            std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
            gone.push(path.clone());
        }
    }
    Ok(gone)
}

/// A program the desktop has, run quietly; whether it ran and said yes.
#[cfg(target_os = "linux")]
fn quietly(program: &str, args: &[&str]) -> bool {
    platform::find_on_path(program).is_some()
        && std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

/// `snyvi install-desktop`. What the `.deb` puts under /usr/share, for a
/// binary that lives in the reader's own home: the menu entry that makes
/// `snyvi://` links open the window, the icon it shows, and a user unit for
/// those who want the daemon started with their session. The unit is
/// written, never enabled: that is a choice, and the line below says how.
/// Every step says whether it wrote something or found it current.
pub fn install_desktop() -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        println!("install-desktop is for Linux. On macOS snyvi.app is the desktop's entry; on Windows the installer made the shortcut, and `snyvi-app` claims snyvi:// links when it first runs.");
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let exe = std::env::current_exe()?.canonicalize()?;
        let data = dirs::data_dir().context("no data directory (is HOME set?)")?;
        let config = dirs::config_dir().context("no config directory (is HOME set?)")?;
        let systemd = platform::find_on_path("systemctl").is_some();
        let done = install_desktop_into(&data, &config, &exe, systemd)?;
        let (wrote, current): (Vec<_>, Vec<_>) = done.iter().partition(|(_, w)| *w);
        for (path, _) in &wrote {
            println!("wrote {}", path.display());
        }
        if !current.is_empty() {
            println!("{} file(s) already current", current.len());
        }
        let apps = data.join("applications");
        quietly("update-desktop-database", &[&apps.to_string_lossy()]);
        // The links: ours unless the reader chose something else. The
        // window's own handler entry, from a run before this, is ours too.
        let owner = std::process::Command::new("xdg-mime")
            .args(["query", "default", "x-scheme-handler/snyvi"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if owner.is_empty() || owner == "snyvi.desktop" || owner.contains("snyvi-app-handler") {
            if quietly(
                "xdg-mime",
                &["default", "snyvi.desktop", "x-scheme-handler/snyvi"],
            ) {
                println!("snyvi:// links open with {}", exe.display());
            }
        } else {
            println!("snyvi:// links stay with {owner}, which you chose");
        }
        if systemd {
            quietly("systemctl", &["--user", "daemon-reload"]);
            if !quietly("systemctl", &["--user", "is-enabled", "--quiet", "snyvi"]) {
                println!("The user unit is written, not enabled. To start snyvi with your session:\n\n  systemctl --user enable --now snyvi\n");
            }
        }
        Ok(())
    }
}

/// `snyvi uninstall-desktop`: exactly what `install-desktop` wrote. A unit
/// that was enabled is disabled first, so no link to it is left behind; a
/// daemon it started keeps running until `snyvi stop`.
pub fn uninstall_desktop() -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        println!("uninstall-desktop is for Linux; nothing was written here.");
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let data = dirs::data_dir().context("no data directory (is HOME set?)")?;
        let config = dirs::config_dir().context("no config directory (is HOME set?)")?;
        let unit = DesktopFiles::under(&data, &config).unit;
        if std::fs::read_to_string(&unit)
            .map(|s| s.starts_with(WRITTEN_BY))
            .unwrap_or(false)
            && quietly("systemctl", &["--user", "is-enabled", "--quiet", "snyvi"])
            && quietly("systemctl", &["--user", "disable", "snyvi"])
        {
            println!("disabled the snyvi user unit");
        }
        let gone = uninstall_desktop_from(&data, &config)?;
        for path in &gone {
            println!("removed {}", path.display());
        }
        if gone.is_empty() {
            println!("nothing of install-desktop's was here");
        } else {
            quietly(
                "update-desktop-database",
                &[&data.join("applications").to_string_lossy()],
            );
            quietly("systemctl", &["--user", "daemon-reload"]);
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod desktop_tests {
    use super::*;

    #[test]
    fn an_exec_line_quotes_what_the_spec_reserves_and_nothing_else() {
        assert_eq!(
            desktop_arg("/home/a/.local/bin/snyvi"),
            "/home/a/.local/bin/snyvi"
        );
        assert_eq!(desktop_arg("/home/a b/snyvi"), "\"/home/a b/snyvi\"");
        // `$` escaped for the argument, and the backslash that escapes it
        // doubled for the string the whole value is.
        assert_eq!(desktop_arg("/opt/$x/snyvi"), "\"/opt/\\\\$x/snyvi\"");
        assert_eq!(desktop_arg("/opt/100%/snyvi"), "/opt/100%%/snyvi");
        assert_eq!(
            systemd_arg("/home/a/.local/bin/snyvi"),
            "/home/a/.local/bin/snyvi"
        );
        assert_eq!(systemd_arg("/home/a b/snyvi"), "\"/home/a b/snyvi\"");
        assert_eq!(systemd_arg("/opt/$x/%h"), "/opt/$$x/%%h");
    }

    #[test]
    fn the_entry_and_the_unit_name_this_binary() {
        let exe = Path::new("/home/a/.local/bin/snyvi");
        let entry = desktop_entry(
            "[Desktop Entry]\nName=snyvi\nExec=snyvi app %u\nIcon=snyvi\n",
            exe,
        );
        assert!(entry.starts_with(WRITTEN_BY));
        assert!(
            entry.contains("\nExec=/home/a/.local/bin/snyvi app %u\n"),
            "{entry}"
        );
        assert!(entry.contains("\nTryExec=/home/a/.local/bin/snyvi\n"));
        assert!(!entry.contains("Exec=snyvi app"));
        let unit = service_unit(
            "[Service]\nExecStart=/usr/bin/snyvi serve\nRestart=on-failure\n",
            exe,
        );
        assert!(unit.starts_with(WRITTEN_BY));
        assert!(
            unit.contains("\nExecStart=/home/a/.local/bin/snyvi serve\n"),
            "{unit}"
        );
        assert!(unit.contains("\nRestart=on-failure\n"));
    }

    #[test]
    fn install_desktop_writes_once_and_uninstall_takes_back_only_its_own() {
        let tmp = std::env::temp_dir().join(format!("snyvi-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (data, config) = (tmp.join("share"), tmp.join("config"));
        let exe = Path::new("/home/a/.local/bin/snyvi");
        let first = install_desktop_into(&data, &config, exe, true).unwrap();
        assert!(
            first.iter().all(|(_, wrote)| *wrote),
            "a fresh home gets every file"
        );
        assert_eq!(first.len(), 1 + ICONS.len() + 1 + 1);
        let again = install_desktop_into(&data, &config, exe, true).unwrap();
        assert!(
            again.iter().all(|(_, wrote)| !*wrote),
            "a second run writes nothing"
        );
        let moved =
            install_desktop_into(&data, &config, Path::new("/opt/snyvi/snyvi"), true).unwrap();
        assert_eq!(
            moved.iter().filter(|(_, w)| *w).count(),
            2,
            "a moved binary rewrites the entry and the unit, not the icons"
        );
        let entry = data.join("applications/snyvi.desktop");
        assert!(std::fs::read_to_string(&entry)
            .unwrap()
            .contains("Exec=/opt/snyvi/snyvi app %u"));

        // A unit someone wrote by hand is not ours to remove.
        let unit = config.join("systemd/user/snyvi.service");
        std::fs::write(&unit, "[Service]\nExecStart=/somewhere/else serve\n").unwrap();
        let gone = uninstall_desktop_from(&data, &config).unwrap();
        assert!(gone.contains(&entry));
        assert!(!gone.contains(&unit) && unit.is_file());
        assert!(!data.join("icons/hicolor/256x256/apps/snyvi.png").exists());
        assert!(
            uninstall_desktop_from(&data, &config).unwrap().is_empty(),
            "twice is nothing"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
