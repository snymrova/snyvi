//! The command line: what each `snyvi <subcommand>` parses to, and one
//! function per subcommand. `main` only hands over to [`run`].

use crate::{
    agents, bench, client, config, desktop, hook, mcp, platform, plural, receive, reset, secrets,
    server, setup, statusline, store, update, version, watch,
};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::io::Read;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "snyvi",
    version,
    about = "A fast, beautiful viewer for the documents your agents produce"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the viewer daemon in the foreground.
    Serve,
    /// Send a file (or stdin) to the viewer and print its link.
    Send {
        /// File to send. Reads stdin when omitted.
        file: Option<PathBuf>,
        #[arg(short, long)]
        title: Option<String>,
        #[arg(short, long)]
        workflow: Option<String>,
        /// Format hint: md, diff, rs, py, ...
        #[arg(short, long)]
        lang: Option<String>,
        /// Project directory (defaults to the current directory).
        #[arg(short, long)]
        project: Option<PathBuf>,
        /// Open the link in the browser after sending.
        #[arg(short, long)]
        open: bool,
    },
    /// Send a file now and again whenever it changes on disk, until interrupted.
    Watch {
        /// Files to watch.
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Title (meant for a single file).
        #[arg(short, long)]
        title: Option<String>,
        #[arg(short, long)]
        workflow: Option<String>,
        /// Format hint: md, diff, rs, py, ...
        #[arg(short, long)]
        lang: Option<String>,
        /// Project directory (defaults to the current directory).
        #[arg(short, long)]
        project: Option<PathBuf>,
        /// Open the link in the browser after the first send.
        #[arg(short, long)]
        open: bool,
    },
    /// Open the viewer (or a document) in the native window if one is running, else the browser.
    Open { id: Option<String> },
    /// Read a folder straight from disk. Nothing is stored or added to the library.
    Browse {
        /// Directory to browse. Defaults to the current directory.
        dir: Option<PathBuf>,
        /// Print the link without opening a browser.
        #[arg(long)]
        no_open: bool,
    },
    /// Open the viewer in a native window (needs the `desktop` build feature; falls back to the browser).
    App {
        /// What to open there: a document id, a `snyvi://` link, or a URL on the daemon.
        /// This is what the desktop runs for a click on a `snyvi://` link.
        target: Option<String>,
    },
    /// Run the MCP server on stdio (for Claude Code).
    Mcp,
    /// Claude Code hook (reads hook JSON on stdin): sends Markdown files Claude writes, and tells a desk panel what Claude in it is doing.
    Hook,
    /// Claude Code status line (reads its JSON on stdin): tells a desk panel which model it is and how full its context window is. Prints nothing, or the status line you had before.
    Statusline,
    /// Register snyvi with an agent: claude, codex, cursor, claude-desktop, gemini, windsurf, vscode or zed. Safe to run again.
    Init {
        /// Which agent. Alone, lists every agent and what each has of snyvi.
        agent: Option<String>,
        /// Claude Code: also install the PostToolUse hook so every Markdown file Claude writes is sent automatically.
        #[arg(long)]
        auto: bool,
        /// Also add one line to the agent's instructions file (CLAUDE.md, AGENTS.md, GEMINI.md, ...) asking it to send you what it writes.
        #[arg(long, visible_alias = "claude-md")]
        instructions: bool,
    },
    /// Undo `init <agent>`: the MCP server entry and the instructions line. Documents are kept.
    Uninstall {
        /// Which agent: claude, codex, cursor, claude-desktop, gemini, windsurf, vscode or zed.
        agent: String,
    },
    /// The same as `init claude`: the MCP server and a session hook. Safe to run again.
    InitClaude {
        /// Also install the PostToolUse hook so every Markdown file Claude writes is sent automatically.
        #[arg(long)]
        auto: bool,
        /// Also add one line to ~/.claude/CLAUDE.md asking Claude to send you what it writes.
        #[arg(long)]
        claude_md: bool,
        /// What an installer runs on an update: point whatever Claude Code already has of snyvi at this binary, and add nothing.
        #[arg(long, conflicts_with_all = ["auto", "claude_md"])]
        refresh: bool,
    },
    /// The same as `uninstall claude`: the MCP server, the hooks and the CLAUDE.md line. Documents are kept.
    UninstallClaude,
    /// Linux: a menu entry, the icon, `snyvi://` links, and a systemd user unit (written, not enabled), all for this binary and all in your home. Safe to run again.
    InstallDesktop,
    /// Undo `install-desktop`: exactly the files it wrote.
    UninstallDesktop,
    /// Put `snyvi` on PATH: a link in /usr/local/bin or ~/.local/bin, or the binary's folder on Windows.
    InstallCli {
        /// Directory to link into (Linux and macOS). Defaults to /usr/local/bin when writable, else ~/.local/bin.
        dir: Option<PathBuf>,
    },
    /// Delete unpinned documents older than N days.
    Prune {
        #[arg(long, default_value_t = 30)]
        days: u32,
        /// List what would be deleted without deleting.
        #[arg(long)]
        dry_run: bool,
    },
    /// Back to a fresh install: every document, the index, the token and the page's preferences go; the agents stay registered.
    Reset {
        /// Do not ask. Without it the number of documents has to be typed back, at a terminal.
        #[arg(long)]
        yes: bool,
        /// Say what would go, and stop.
        #[arg(long)]
        dry_run: bool,
        /// Also take snyvi out of Claude Code (what `uninstall-claude` does).
        #[arg(long)]
        agents: bool,
        /// Reset even though some documents are pinned. Refused otherwise: a pin means keep.
        #[arg(long)]
        pinned: bool,
    },
    /// Stop the background daemon.
    Stop,
    /// Restart the daemon so a newly installed binary takes over. Waits until no panel has an agent mid-turn or a program printing; Claude panels come back with their conversation.
    Restart {
        /// Do not wait for the panels to be quiet.
        #[arg(long)]
        now: bool,
        /// Call off a restart that is waiting for the panels to be quiet.
        #[arg(long, conflicts_with = "now")]
        cancel: bool,
    },
    /// Check for a new version, stage it, and restart onto it when the panels are quiet. Ignores the once-a-day floor: you asked.
    Update {
        #[command(subcommand)]
        what: Option<UpdateCmd>,
        /// Do not wait for the panels to be quiet.
        #[arg(long)]
        now: bool,
        /// One release by number, even an older one.
        #[arg(long)]
        to: Option<String>,
        /// Put the previous version back: the one the last update replaced.
        #[arg(long)]
        back: bool,
    },
    /// Print one of this desk's keys, for a command in a snyvi panel: `curl -H "x-api-key: $(snyvi key NAME)" ...`. Works only inside a panel; a key added after the panel started works at once.
    Key {
        /// The key's name, as the desk's Keys list shows it.
        name: String,
    },
    /// A widget in snyvi's sidebars, for a script, a git hook or cron: `snyvi widget set backups --tone ok "done 03:00"`.
    Widget {
        #[command(subcommand)]
        cmd: WidgetCmd,
    },
    /// Show daemon status.
    Status,
    /// Say hello: the face, the version and the address. Not in the help; for whoever thought to ask.
    #[command(hide = true)]
    Hi,
    /// Measure render speed on synthetic documents, and a daemon of its own: binary size, cold start, send, first byte, resident memory.
    Bench {
        /// Exit non-zero if any case exceeds its budget (SNYVI_BENCH_FACTOR scales budgets for slow CI runners).
        #[arg(long)]
        check: bool,
    },
}

#[derive(Subcommand)]
enum WidgetCmd {
    /// Set a widget's body: Markdown, or the contract's JSON (docs/WIDGETS.md). Reads stdin when the text is - or left out. Inside a snyvi panel it is that desk's; otherwise global, on the left.
    Set {
        /// Lowercase letters, digits and dashes, at most 32.
        name: String,
        /// The body. Empty clears the widget.
        text: Option<String>,
        /// On this desk, by its id, from anywhere.
        #[arg(long, conflicts_with = "global")]
        desk: Option<i64>,
        /// On the left, everywhere, even inside a panel.
        #[arg(long)]
        global: bool,
        /// The count's colour: ok, warn, bad or none.
        #[arg(long)]
        tone: Option<String>,
        /// A figure beside the name, kept while the widget is folded: 3, !2, 3/5.
        #[arg(long)]
        count: Option<String>,
        /// The body's room, in lines of 20 px: 1 to 6 (3).
        #[arg(long)]
        lines: Option<i64>,
        /// Seconds before it dims as old (1800); 0 is never.
        #[arg(long)]
        stale_after: Option<i64>,
    },
    /// Clear a widget.
    Clear {
        name: String,
        #[arg(long, conflicts_with = "global")]
        desk: Option<i64>,
        #[arg(long)]
        global: bool,
    },
    /// Write a starter widget file in snyvi's widgets folder: a widget.json and a script that prints its body. It does not run until you Allow it in the window.
    New {
        name: String,
        /// On the left, everywhere, run in its own folder (the default is a desk's, run in the desk's folder).
        #[arg(long)]
        global: bool,
    },
    /// Run a widget file once, here, as snyvi would, and print what it would draw -- or why it refuses.
    Check { name: String },
}

#[derive(Subcommand)]
enum UpdateCmd {
    /// Say whether a newer version is out, and stop. Exit 10 when one is, 0 on the latest, 1 when the check failed.
    Check,
    /// Automatic updates on (the default): checked a few times a day, applied once a day at a quiet moment.
    On,
    /// Automatic updates off. `snyvi update` still works when you ask.
    Off,
}

pub(crate) fn run() -> Result<()> {
    let paths = config::paths();
    match Cli::parse().cmd {
        Cmd::Serve => serve(&paths),
        Cmd::Send {
            file,
            title,
            workflow,
            lang,
            project,
            open,
        } => send(&paths, file, title, workflow, lang, project, open),
        Cmd::Watch {
            files,
            title,
            workflow,
            lang,
            project,
            open,
        } => {
            let base = receive::Payload {
                title,
                workflow,
                lang,
                cwd: project_dir(project),
                ..Default::default()
            };
            watch::run_cli(&paths, &files, &base, open)
        }
        Cmd::Open { id } => {
            client::ensure_daemon()?;
            let url = match id {
                Some(id) => format!("{}/d/{id}", config::base_url()),
                None => config::base_url(),
            };
            client::open_where_the_reader_is(&url);
            Ok(())
        }
        Cmd::Browse { dir, no_open } => browse(&paths, dir, no_open),
        Cmd::App { target } => app(&paths, target),
        Cmd::Mcp => mcp::run(paths),
        Cmd::Hook => hook::run(&paths),
        Cmd::Statusline => statusline::run(&paths),
        Cmd::Init {
            agent: None,
            auto: _,
            instructions: _,
        } => agents::list(&paths),
        Cmd::Init {
            agent: Some(id),
            auto,
            instructions,
        } => init(&id, auto, instructions),
        Cmd::Uninstall { agent: id } => match agents::find(&id) {
            Some(a) if a.id == "claude" => setup::uninstall_claude(),
            Some(a) => agents::uninstall(&a),
            None => no_such_agent(&id),
        },
        Cmd::InitClaude { refresh: true, .. } => setup::refresh_claude(),
        Cmd::InitClaude {
            auto, claude_md, ..
        } => setup::init_claude(auto, claude_md),
        Cmd::InstallDesktop => setup::install_desktop(),
        Cmd::UninstallDesktop => setup::uninstall_desktop(),
        Cmd::UninstallClaude => setup::uninstall_claude(),
        Cmd::InstallCli { dir } => setup::install_cli(dir),
        Cmd::Prune { days, dry_run } => prune(&paths, days, dry_run),
        Cmd::Reset {
            yes,
            dry_run,
            agents,
            pinned,
        } => reset::run(
            &paths,
            reset::Opts {
                yes,
                dry_run,
                agents,
                pinned,
            },
        ),
        Cmd::Stop => {
            if !client::stop(&paths)? {
                println!("not running");
            }
            Ok(())
        }
        Cmd::Restart { cancel: true, .. } => client::cancel_restart(&paths),
        Cmd::Restart { now, .. } => client::restart(&paths, now),
        Cmd::Update {
            what,
            now,
            to,
            back,
        } => match what {
            Some(UpdateCmd::Check) => {
                if client::update_check(&paths)? {
                    std::process::exit(10);
                }
                Ok(())
            }
            Some(UpdateCmd::On) => client::update_auto(&paths, true),
            Some(UpdateCmd::Off) => client::update_auto(&paths, false),
            None => client::update(&paths, client::UpdateOpts { now, to, back }),
        },
        Cmd::Key { name } => {
            use std::io::Write;
            // No newline: `$(...)` would drop it anyway, and a pipe should get
            // the value exactly.
            let value = client::key(&paths, &name)?;
            let mut out = std::io::stdout().lock();
            out.write_all(value.as_bytes())?;
            out.flush()?;
            Ok(())
        }
        Cmd::Widget { cmd } => widget_cmd(&paths, cmd),
        Cmd::Status => status(&paths),
        Cmd::Bench { check } => bench::run(check),
        Cmd::Hi => hi(),
    }
}

/// `--project`, or the current directory: the project a send is filed under.
fn project_dir(project: Option<PathBuf>) -> Option<String> {
    project
        .or_else(|| std::env::current_dir().ok())
        .map(|p| p.to_string_lossy().to_string())
}

fn no_such_agent(id: &str) -> Result<()> {
    anyhow::bail!(
        "no agent called `{id}`; one of {}",
        agents::ids().join(", ")
    )
}

fn serve(paths: &config::Paths) -> Result<()> {
    // First, before anything a bad release could break: a version
    // just applied that keeps dying before it holds the port is
    // taken back out, and the one before it started instead.
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let update::FirstStart::RolledBack(v) = update::first_start(paths, &exe) {
            eprintln!("snyvi: {v} was started and never came up, twice; the previous version is back in its place, and starting");
            return restart_self(&exe);
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        // Renders run on blocking threads, and a thread's freed memory
        // is only handed back when that thread next touches the
        // allocator -- which an idle one never does. Tokio keeps an
        // idle blocking thread for ten seconds, so a 1 MB document
        // left the daemon at 84 MB resident for ten seconds after it
        // had answered, and 42 MB the moment the thread went. A
        // thread is cheap to start next to a render; a second is
        // enough to serve a burst of sends from one.
        .thread_keep_alive(std::time::Duration::from_secs(1))
        .enable_all()
        .build()?;
    let why = rt.block_on(server::run(paths.clone()))?;
    // The runtime goes before a successor is started: its listener
    // is what the successor binds, and it must be closed, not merely
    // no longer served.
    drop(rt);
    match why {
        server::Leaving::Stopped => Ok(()),
        server::Leaving::Restart { exe, apply } => server::relaunch(exe, apply, paths),
    }
}

fn send(
    paths: &config::Paths,
    file: Option<PathBuf>,
    title: Option<String>,
    workflow: Option<String>,
    lang: Option<String>,
    project: Option<PathBuf>,
    open: bool,
) -> Result<()> {
    let (content, path) = match &file {
        Some(f) => (
            None,
            Some(
                f.canonicalize()
                    .unwrap_or(f.clone())
                    .to_string_lossy()
                    .to_string(),
            ),
        ),
        None => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .context("reading stdin")?;
            (Some(s), None)
        }
    };
    let cwd = project_dir(project);
    let payload = receive::Payload {
        path,
        content,
        title,
        workflow,
        lang,
        cwd,
        session: None,
        origin: Some("cli".into()),
        sender: None,
        pane: None,
        peer: None,
    };
    let resp = client::send(paths, &payload)?;
    let url = resp
        .get("url")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    println!("{url}");
    if open {
        client::open_where_the_reader_is(&url);
    }
    Ok(())
}

fn browse(paths: &config::Paths, dir: Option<PathBuf>, no_open: bool) -> Result<()> {
    let dir = dir
        .or_else(|| std::env::current_dir().ok())
        .context("no directory given and no current directory")?;
    let dir = dir
        .canonicalize()
        .with_context(|| format!("no such directory: {}", dir.display()))?;
    let url = client::browse(paths, &dir.to_string_lossy())?;
    println!("{url}");
    if !no_open {
        client::open_where_the_reader_is(&url);
    }
    Ok(())
}

fn app(paths: &config::Paths, target: Option<String>) -> Result<()> {
    client::ensure_daemon()?;
    let url = match target {
        Some(t) => desktop::resolve(&t),
        None => config::base_url(),
    };
    // A window that is up takes the link and comes forward; there is
    // no starting another. Without one, this becomes the window --
    // and a new window is the only thing a capability is minted for,
    // since the one already up has held its own since it opened.
    if client::window_is_up() && desktop::hand_to_window(&url) {
        return Ok(());
    }
    desktop::open(&url, client::mint_capability(paths).as_deref())
}

fn init(id: &str, auto: bool, instructions: bool) -> Result<()> {
    match agents::find(id) {
        Some(a) if a.id == "claude" => setup::init_claude(auto, instructions),
        Some(a) if auto => anyhow::bail!(
            "--auto is Claude Code's hook; `snyvi init {}` takes no flags but --instructions",
            a.id
        ),
        Some(a) => agents::init(&a, instructions),
        None => no_such_agent(id),
    }
}

fn prune(paths: &config::Paths, days: u32, dry_run: bool) -> Result<()> {
    let store = store::Store::open(paths)?;
    let before = store::now() - i64::from(days) * 86_400;
    let gone = store.prune(before, dry_run)?;
    for (id, title) in &gone {
        println!(
            "{} {id}  {title}",
            if dry_run { "would delete" } else { "deleted" }
        );
    }
    println!(
        "{}{}",
        plural(gone.len(), "document"),
        if dry_run {
            " would be deleted"
        } else {
            " deleted"
        }
    );
    // Closed panels, on the same terms as a deleted document: kept
    // for Undo until a prune, and their saved text goes with them.
    let panels = store.prune_panes(before, dry_run)?;
    for (id, what) in &panels {
        if !dry_run {
            // Its kept lines and its last screen (`.scr`, from 1.17).
            for ext in ["txt", "scr"] {
                let _ =
                    std::fs::remove_file(paths.data_dir.join("panes").join(format!("{id}.{ext}")));
            }
        }
        println!(
            "{} panel {id}  {what}",
            if dry_run { "would delete" } else { "deleted" }
        );
    }
    if !panels.is_empty() {
        println!(
            "{}{}",
            plural(panels.len(), "closed panel"),
            if dry_run {
                " would be deleted"
            } else {
                " deleted"
            }
        );
    }
    // A pruned desk's keys go with it: the names from the store, the
    // values from the keychain or the file they were kept in.
    let keys = store.prune_desk_keys(before, dry_run)?;
    if !dry_run {
        let secrets = secrets::Secrets::new(paths.config_dir.join("keys.json"));
        for (desk, name) in &keys {
            secrets.forget(*desk, name);
        }
    }
    for (desk, name) in &keys {
        println!(
            "{} key {name} of desk {desk}",
            if dry_run { "would forget" } else { "forgot" }
        );
    }
    // Closed desks, after their panels: the cascade takes their notes
    // and what is left of their rows, and the text went just above.
    let desks = store.prune_desks(before, dry_run)?;
    for (id, name) in &desks {
        println!(
            "{} desk {id}  {name}",
            if dry_run { "would delete" } else { "deleted" }
        );
    }
    if !desks.is_empty() {
        println!(
            "{}{}",
            plural(desks.len(), "closed desk"),
            if dry_run {
                " would be deleted"
            } else {
                " deleted"
            }
        );
    }
    Ok(())
}

fn status(paths: &config::Paths) -> Result<()> {
    match client::health() {
        Some(h) => {
            println!("{}", serde_json::to_string_pretty(&h)?);
            let running = h.get("version").and_then(|v| v.as_str()).unwrap_or("");
            if running != version::VERSION {
                println!(
                    "\nthis binary is {} but the daemon is {running}; run `snyvi restart`",
                    version::VERSION
                );
            }
            if let Some(line) = client::update_line(&h["update"]) {
                println!("{line}");
            }
            let log = platform::daemon_log(&paths.data_dir);
            if log.exists() {
                println!("log: {}", log.display());
            }
        }
        None => println!("not running (would listen on {})", config::base_url()),
    }
    println!("{}", setup::claude_code_status());
    for line in agents::status_lines() {
        println!("{line}");
    }
    Ok(())
}

/// The one place the mascot is in a terminal, and only when asked
/// (docs/DESIGN.md §2.4): never in an install's last line, never in a
/// hook. Awake when a daemon answers, asleep when none does.
fn hi() -> Result<()> {
    let h = client::health();
    let up = h.is_some();
    let running = h
        .as_ref()
        .and_then(|h| h.get("version").and_then(|v| v.as_str()))
        .map(str::to_string);
    let eyes = if up { "●  ●" } else { "-  -" };
    println!("     ▪\n   ╭──────╮\n   │ {eyes} │\n   │  ‿   │\n   ╰──────╯");
    match running {
        Some(v) if v != version::VERSION => println!(
            "   snyvi {v} at {} · this binary is {}",
            config::base_url(),
            version::VERSION
        ),
        Some(_) => println!(
            "   snyvi {} at {} · here",
            version::VERSION,
            config::base_url()
        ),
        None => println!(
            "   snyvi {} · asleep; would listen at {}",
            version::VERSION,
            config::base_url()
        ),
    }
    Ok(())
}

/// The file at `exe`, which `update::first_start` has just put the previous
/// version back into, in place of this process: the same pid under
/// systemd, so the unit carries on as if nothing happened.
fn restart_self(exe: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = std::process::Command::new(exe).arg("serve").exec();
        anyhow::bail!("starting {} again: {e}", exe.display());
    }
    #[cfg(not(unix))]
    {
        platform::spawn_daemon(exe)?;
        Ok(())
    }
}

/// `snyvi widget …`: one widget set or cleared, the daemon's word printed
/// back when it refuses; a starter written; one run checked.
fn widget_cmd(paths: &config::Paths, cmd: WidgetCmd) -> Result<()> {
    let (name, body, desk, global) = match cmd {
        WidgetCmd::New { name, global } => return widget_new(paths, &name, global),
        WidgetCmd::Check { name } => return widget_check(paths, &name),
        WidgetCmd::Set {
            name,
            text,
            desk,
            global,
            tone,
            count,
            lines,
            stale_after,
        } => {
            let text = match text.as_deref() {
                None | Some("-") => {
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
                    s
                }
                Some(t) => t.to_string(),
            };
            let body = if tone.is_none()
                && count.is_none()
                && lines.is_none()
                && stale_after.is_none()
            {
                serde_json::Value::String(text)
            } else {
                serde_json::json!({ "body": text, "tone": tone, "count": count, "lines": lines, "stale_after": stale_after })
            };
            (name, body, desk, global)
        }
        WidgetCmd::Clear { name, desk, global } => {
            (name, serde_json::Value::String(String::new()), desk, global)
        }
    };
    let v = client::widget(paths, &name, body, desk, global)?;
    if v.get("cleared").and_then(serde_json::Value::as_bool) == Some(false) {
        eprintln!("snyvi: there was no widget called {name} there");
    }
    Ok(())
}

/// `snyvi widget new`: a starter folder, never over one that is there.
fn widget_new(paths: &config::Paths, name: &str, global: bool) -> Result<()> {
    use crate::widget::files;
    if !crate::widget::name_ok(name) {
        anyhow::bail!("a widget's name is lowercase letters, digits and dashes, at most 32");
    }
    let dir = files::dir(&paths.config_dir).join(name);
    if dir.exists() {
        anyhow::bail!("{} is there already", dir.display());
    }
    let (json, script, body) = files::starter(
        name,
        if global {
            files::Scope::Global
        } else {
            files::Scope::Desk
        },
    );
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("widget.json"), json)?;
    std::fs::write(dir.join(script), body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join(script), std::fs::Permissions::from_mode(0o755))?;
    }
    println!("{}", dir.display());
    println!("Edit {script}, try it with `snyvi widget check {name}`, then Allow it in the window: it waits in its seat, and on /sidebars.");
    Ok(())
}

/// `snyvi widget check`: one run, in this terminal, of what snyvi would
/// run, with what it would be given; then the body it would draw, or why
/// it would not. Run here and now, in this shell's environment -- so a
/// command that works here and not in snyvi is a PATH to look at.
fn widget_check(paths: &config::Paths, name: &str) -> Result<()> {
    use crate::widget::{self, files};
    let folder = files::dir(&paths.config_dir).join(name);
    let spec =
        files::read(&folder, name).map_err(|why| anyhow::anyhow!("{}: {why}", folder.display()))?;
    let hash = files::hash(&folder).map_err(|why| anyhow::anyhow!(why))?;
    let cwd = match spec.scope {
        files::Scope::Global => folder.clone(),
        files::Scope::Desk => std::env::current_dir()?,
    };
    let stdin = serde_json::json!({
        "desk": if spec.scope == files::Scope::Desk { serde_json::json!({ "id": 0, "name": "check", "folder": cwd }) } else { serde_json::Value::Null },
        "settings": spec.settings_with("{}"),
        "snyvi": crate::version::VERSION,
    });
    eprintln!(
        "{} · {} · every {} s · in {}",
        spec.title,
        spec.run.command,
        spec.run.every,
        cwd.display()
    );
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(&spec.run.command);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(&spec.run.command);
        c
    };
    let mut child = cmd
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .context("starting it")?;
    if let Some(mut i) = child.stdin.take() {
        use std::io::Write;
        let _ = i.write_all(stdin.to_string().as_bytes());
    }
    let started = std::time::Instant::now();
    let out = child.wait_with_output()?;
    let took = started.elapsed();
    if !out.status.success() {
        anyhow::bail!(
            "it exited {}: snyvi would show that over the last good body",
            out.status.code().unwrap_or(-1)
        );
    }
    if took.as_secs() >= spec.run.timeout {
        eprintln!(
            "snyvi: it took {:.1} s, past its timeout of {} s: snyvi would stop it",
            took.as_secs_f64(),
            spec.run.timeout
        );
    }
    if out.stdout.len() > 4096 {
        anyhow::bail!(
            "it printed {} bytes: snyvi reads 4 KB at most",
            out.stdout.len()
        );
    }
    let printed = String::from_utf8_lossy(&out.stdout);
    // As the runner draws it: the file's own room, unless the run said.
    let own = |mut b: widget::Body| {
        if !printed.trim_start().starts_with('{') {
            b.lines = spec.lines;
        }
        b
    };
    match widget::Body::parse(&printed).map(|s| match s {
        widget::Sent::Body(b) => widget::Sent::Body(own(b)),
        s => s,
    }) {
        Err(why) => anyhow::bail!("snyvi would refuse what it printed: {why}"),
        Ok(widget::Sent::Clear) => println!("(nothing: the seat would be empty)"),
        Ok(widget::Sent::Body(b)) => {
            println!(
                "tone {} · count {} · {} lines",
                b.tone.as_str(),
                if b.count.is_empty() { "none" } else { &b.count },
                b.lines
            );
            println!("{}", crate::render::widget_md(&b.md));
        }
    }
    // Read only: the daemon owns the database, and opening it as the store
    // does would tidy what the daemon is in the middle of.
    let allowed = rusqlite::Connection::open_with_flags(
        &paths.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()
    .and_then(|c| widget::prefs(&c, name).ok())
    .is_some_and(|p| p.trusted_hash == hash);
    eprintln!(
        "{}",
        if allowed {
            "Allowed as it is: snyvi runs it while it is in view."
        } else {
            "Not allowed as it is: Allow it in the window, in its seat or on /sidebars."
        }
    );
    Ok(())
}
