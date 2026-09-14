mod bench;
mod browse;
mod client;
mod config;
mod desktop;
mod hook;
mod mcp;
mod platform;
mod project;
mod receive;
mod render;
mod server;
mod session;
mod setup;
mod store;
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
    App,
    /// Run the MCP server on stdio (for Claude Code).
    Mcp,
    /// Claude Code PostToolUse hook: send Markdown files Claude writes (reads hook JSON on stdin).
    Hook,
    /// Register snyvi with Claude Code: the MCP server and a session hook. Safe to run again.
    InitClaude {
        /// Also install the PostToolUse hook so every Markdown file Claude writes is sent automatically.
        #[arg(long)]
        auto: bool,
        /// Also add one line to ~/.claude/CLAUDE.md asking Claude to send you what it writes.
        #[arg(long)]
        claude_md: bool,
    },
    /// Undo init-claude: the MCP server, the hooks and the CLAUDE.md line. Documents are kept.
    UninstallClaude,
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
    /// Stop the background daemon.
    Stop,
    /// Restart the daemon so a newly installed binary takes over.
    Restart,
    /// Show daemon status.
    Status,
    /// Measure render speed on synthetic documents, and a daemon of its own: binary size, cold start, send, first byte, resident memory.
    Bench {
        /// Exit non-zero if any case exceeds its budget (SNYVI_BENCH_FACTOR scales budgets for slow CI runners).
        #[arg(long)]
        check: bool,
    },
}

fn main() -> Result<()> {
    let paths = config::paths();
    match Cli::parse().cmd {
        Cmd::Serve => {
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
            rt.block_on(server::run(paths))
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
        Cmd::App => {
            client::ensure_daemon()?;
            desktop::open(&config::base_url())
        }
        Cmd::Mcp => mcp::run(paths),
        Cmd::Hook => hook::run(&paths),
        Cmd::InitClaude { auto, claude_md } => setup::init_claude(auto, claude_md),
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
            Ok(())
        }
        Cmd::Stop => {
            if !client::stop(&paths)? {
                println!("not running");
            }
            Ok(())
        }
        Cmd::Restart => {
            client::stop(&paths)?;
            client::ensure_daemon()?;
            let v = client::health()
                .and_then(|h| {
                    h.get("version")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            println!("snyvi {v} running on {}", config::base_url());
            Ok(())
        }
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
                }
                None => println!("not running (would listen on {})", config::base_url()),
            }
            println!("{}", setup::claude_code_status());
            Ok(())
        }
        Cmd::Bench { check } => bench::run(check),
    }
}
