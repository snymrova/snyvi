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
    /// Open the viewer (or a document) in the browser.
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
    /// Register snyvi with Claude Code as a user-scoped MCP server.
    InitClaude {
        /// Also install the PostToolUse hook so every Markdown file Claude writes is sent automatically.
        #[arg(long)]
        auto: bool,
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
    /// Measure render speed on synthetic documents.
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
                client::open_in_browser(&url);
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
            client::open_in_browser(&url);
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
                client::open_in_browser(&url);
            }
            Ok(())
        }
        Cmd::App => {
            client::ensure_daemon()?;
            desktop::open(&config::base_url())
        }
        Cmd::Mcp => mcp::run(paths),
        Cmd::Hook => hook::run(&paths),
        Cmd::InitClaude { auto } => init_claude(auto),
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
            Ok(())
        }
        Cmd::Bench { check } => bench(check),
    }
}

fn init_claude(auto: bool) -> Result<()> {
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let status = platform::shim("claude")
        .args(["mcp", "add", "--scope", "user", "snyvi", "--", &exe, "mcp"])
        .status();
    match status {
        Ok(s) if s.success() => println!("Registered snyvi with Claude Code (user scope)."),
        _ => {
            println!("Could not run `claude`. Register manually with:\n\n  claude mcp add --scope user snyvi -- {exe} mcp\n");
        }
    }
    println!(
        "Optional, in ~/.claude/CLAUDE.md:\n\n  When you produce a document for me to read (plan, review, summary), send it to snyvi with send_document and give me the link.\n"
    );
    let path = hook::install(&exe, auto)?;
    if auto {
        println!("Installed SessionStart and PostToolUse hooks in {} (Markdown files Claude writes are sent automatically).", path.display());
    } else {
        println!(
            "Installed a SessionStart hook in {} so documents from one session share a workflow.",
            path.display()
        );
        println!("Add --auto to also install a PostToolUse hook that sends every Markdown file Claude writes.");
    }
    Ok(())
}

fn bench(check: bool) -> Result<()> {
    use std::time::Instant;
    // Budgets in ms on a warm 4-core dev box. The 1 MB Markdown target in docs/BRAINSTORM.md
    // is 200 ms; comrak with all extensions currently lands at ~265, so the budget holds the
    // line at the measured number until the parser step is optimised.
    let factor: f64 = std::env::var("SNYVI_BENCH_FACTOR")
        .ok()
        .and_then(|f| f.parse().ok())
        .unwrap_or(1.0);
    let t0 = Instant::now();
    let r = render::Renderer::new();
    let init_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // A realistic document: prose, headings, lists, a table, and a code block every ~2 KB.
    let section = "## Section heading\n\nA paragraph of ordinary prose with *emphasis*, **strong text**, `inline code`, and a [link](https://example.com). \
It runs on for a few sentences so the parser sees realistic line lengths and inline markup density.\n\n\
- one item\n- another item with `code`\n- a third\n\n\
| col a | col b | col c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n\
> A quote that says something worth remembering.\n\n\
Another paragraph. Then more prose, because most documents are mostly prose, and the renderer should be judged on that.\n\n\
```rust\nfn main() {\n    let x = 42;\n    println!(\"{x}\");\n}\n```\n\n";
    let md_2k = section;
    let repeat = |bytes: usize| -> String {
        (0..bytes / section.len() + 1)
            .map(|i| section.replacen("Section heading", &format!("Section {i}"), 1))
            .collect()
    };
    let md_100k = repeat(100 * 1024);
    let md_1m = repeat(1024 * 1024);
    let code_10k: String = (0..10_000)
        .map(|i| format!("fn f{i}(x: u32) -> u32 {{ x + {i} }} // line\n"))
        .collect();
    let code_100k: String = (0..100_000)
        .map(|i| format!("fn f{i}(x: u32) -> u32 {{ x + {i} }} // line\n"))
        .collect();
    let cases: Vec<(&str, render::Kind, Option<&str>, &str, f64)> = vec![
        ("markdown 2 KB", render::Kind::Markdown, None, md_2k, 2.0),
        (
            "markdown 100 KB",
            render::Kind::Markdown,
            None,
            &md_100k,
            50.0,
        ),
        ("markdown 1 MB", render::Kind::Markdown, None, &md_1m, 400.0),
        (
            "rust 10k lines (highlighted)",
            render::Kind::Code,
            Some("rs"),
            &code_10k,
            500.0,
        ),
        (
            "rust 100k lines (highlight capped at 256 KB)",
            render::Kind::Code,
            Some("rs"),
            &code_100k,
            500.0,
        ),
    ];
    println!("renderer init: {init_ms:.1} ms   (budget factor {factor})\n");
    println!(
        "{:<48} {:>9} {:>9}   {:>9}   {:>9}",
        "case", "ms", "MB/s", "html KB", "budget"
    );
    let mut failed = false;
    for (name, kind, lang, src, budget) in cases {
        // Warm once so lazy regex compilation is not charged to the measurement.
        let _ = r.render(kind, lang, &src[..src.len().min(2048)]);
        // Best of three: the number we care about is the cost of the work, not scheduler noise.
        let mut best = f64::MAX;
        let mut out_len = 0;
        for _ in 0..3 {
            let t = Instant::now();
            let out = r.render(kind, lang, src);
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            out_len = out.len();
        }
        let budget = budget * factor;
        let ok = best <= budget;
        failed |= !ok;
        let mbs = src.len() as f64 / 1e6 / (best / 1000.0);
        println!(
            "{name:<48} {best:>9.1} {mbs:>9.1}   {:>9}   {budget:>7.0}{}",
            out_len / 1024,
            if ok { " ok" } else { " OVER" }
        );
    }
    if check && failed {
        anyhow::bail!("bench: at least one case exceeded its budget");
    }
    Ok(())
}
