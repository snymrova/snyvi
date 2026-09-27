mod agents;
mod aside;
mod bench;
mod browse;
mod capability;
mod client;
mod config;
mod desk;
mod desktop;
mod hook;
mod mcp;
mod pane;
mod platform;
mod project;
mod prompt;
mod receive;
mod render;
mod reset;
mod screen;
mod server;
mod session;
mod setup;
mod statusline;
mod store;
/// `build.rs` compiles this one for itself -- it is what strips `ui/` on the
/// way into the binary -- so the daemon never calls it and it is here only to
/// put the scanner's tests in `cargo test`, where they belong.
#[cfg(test)]
mod strip;
mod update;
mod watch;

use anyhow::{Context, Result};

// musl's allocator is slow under the renderer's allocation pattern; mimalloc keeps the
// static binary as fast as the glibc build.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
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
    /// Show daemon status.
    Status,
    /// Measure render speed on synthetic documents, and a daemon of its own: binary size, cold start, send, first byte, resident memory.
    Bench {
        /// Exit non-zero if any case exceeds its budget (SNYVI_BENCH_FACTOR scales budgets for slow CI runners).
        #[arg(long)]
        check: bool,
    },
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

fn main() -> Result<()> {
    let paths = config::paths();
    match Cli::parse().cmd {
        Cmd::Serve => {
            // First, before anything a bad release could break: a version
            // just applied that keeps dying before it holds the port is
            // taken back out, and the one before it started instead.
            if let Ok(exe) = std::env::current_exe() {
                let exe = exe.canonicalize().unwrap_or(exe);
                if let update::FirstStart::RolledBack(v) = update::first_start(&paths, &exe) {
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
                server::Leaving::Restart { exe, apply } => server::relaunch(exe, apply, &paths),
            }
        }
        Cmd::Send {
            file,
            title,
            workflow,
            lang,
            project,
            open,
        } => {
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
            let cwd = project
                .or_else(|| std::env::current_dir().ok())
                .map(|p| p.to_string_lossy().to_string());
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
            };
            let resp = client::send(&paths, &payload)?;
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
        Cmd::Watch {
            files,
            title,
            workflow,
            lang,
            project,
            open,
        } => {
            let cwd = project
                .or_else(|| std::env::current_dir().ok())
                .map(|p| p.to_string_lossy().to_string());
            let base = receive::Payload {
                title,
                workflow,
                lang,
                cwd,
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
        Cmd::Browse { dir, no_open } => {
            let dir = dir
                .or_else(|| std::env::current_dir().ok())
                .context("no directory given and no current directory")?;
            let dir = dir
                .canonicalize()
                .with_context(|| format!("no such directory: {}", dir.display()))?;
            let url = client::browse(&paths, &dir.to_string_lossy())?;
            println!("{url}");
            if !no_open {
                client::open_where_the_reader_is(&url);
            }
            Ok(())
        }
        Cmd::App { target } => {
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
            desktop::open(&url, client::mint_capability(&paths).as_deref())
        }
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
        } => match agents::find(&id) {
            Some(a) if a.id == "claude" => setup::init_claude(auto, instructions),
            Some(a) if auto => anyhow::bail!(
                "--auto is Claude Code's hook; `snyvi init {}` takes no flags but --instructions",
                a.id
            ),
            Some(a) => agents::init(&a, instructions),
            None => anyhow::bail!(
                "no agent called `{id}`; one of {}",
                agents::ids().join(", ")
            ),
        },
        Cmd::Uninstall { agent: id } => match agents::find(&id) {
            Some(a) if a.id == "claude" => setup::uninstall_claude(),
            Some(a) => agents::uninstall(&a),
            None => anyhow::bail!(
                "no agent called `{id}`; one of {}",
                agents::ids().join(", ")
            ),
        },
        Cmd::InitClaude { refresh: true, .. } => setup::refresh_claude(),
        Cmd::InitClaude {
            auto, claude_md, ..
        } => setup::init_claude(auto, claude_md),
        Cmd::InstallDesktop => setup::install_desktop(),
        Cmd::UninstallDesktop => setup::uninstall_desktop(),
        Cmd::UninstallClaude => setup::uninstall_claude(),
        Cmd::InstallCli { dir } => setup::install_cli(dir),
        Cmd::Prune { days, dry_run } => {
            let store = store::Store::open(&paths)?;
            let before = store::now() - i64::from(days) * 86_400;
            let gone = store.prune(before, dry_run)?;
            for (id, title) in &gone {
                println!(
                    "{} {id}  {title}",
                    if dry_run { "would delete" } else { "deleted" }
                );
            }
            println!(
                "{} document(s){}",
                gone.len(),
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
                    let _ = std::fs::remove_file(
                        paths.data_dir.join("panes").join(format!("{id}.txt")),
                    );
                }
                println!(
                    "{} panel {id}  {what}",
                    if dry_run { "would delete" } else { "deleted" }
                );
            }
            if !panels.is_empty() {
                println!(
                    "{} closed panel(s){}",
                    panels.len(),
                    if dry_run {
                        " would be deleted"
                    } else {
                        " deleted"
                    }
                );
            }
            Ok(())
        }
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
        Cmd::Status => {
            match client::health() {
                Some(h) => {
                    println!("{}", serde_json::to_string_pretty(&h)?);
                    let running = h.get("version").and_then(|v| v.as_str()).unwrap_or("");
                    if running != server::VERSION {
                        println!(
                            "\nthis binary is {} but the daemon is {running}; run `snyvi restart`",
                            server::VERSION
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
        Cmd::Bench { check } => bench::run(check),
    }
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
