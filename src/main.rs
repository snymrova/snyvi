mod client;
mod config;
mod mcp;
mod project;
mod receive;
mod render;
mod server;
mod store;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::io::Read;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "snyvi", version, about = "A fast, beautiful viewer for the documents your agents produce")]
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
    /// Open the viewer (or a document) in the browser.
    Open { id: Option<String> },
    /// Run the MCP server on stdio (for Claude Code).
    Mcp,
    /// Register snyvi with Claude Code as a user-scoped MCP server.
    InitClaude,
    /// Show daemon status.
    Status,
    /// Measure render speed on synthetic documents.
    Bench,
}

fn main() -> Result<()> {
    let paths = config::paths();
    match Cli::parse().cmd {
        Cmd::Serve => {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
            rt.block_on(server::run(paths))
        }
        Cmd::Send { file, title, workflow, lang, project, open } => {
            let (content, path) = match &file {
                Some(f) => (None, Some(f.canonicalize().unwrap_or(f.clone()).to_string_lossy().to_string())),
                None => {
                    let mut s = String::new();
                    std::io::stdin().read_to_string(&mut s).context("reading stdin")?;
                    (Some(s), None)
                }
            };
            let cwd = project
                .or_else(|| std::env::current_dir().ok())
                .map(|p| p.to_string_lossy().to_string());
            let payload = receive::Payload { path, content, title, workflow, lang, cwd, session: None };
            let resp = client::send(&paths, &payload)?;
            let url = resp.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
            println!("{url}");
            if open {
                client::open_in_browser(&url);
            }
            Ok(())
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
        Cmd::Mcp => mcp::run(paths),
        Cmd::InitClaude => init_claude(),
        Cmd::Status => {
            match client::health() {
                Some(h) => println!("{}", serde_json::to_string_pretty(&h)?),
                None => println!("not running (would listen on {})", config::base_url()),
            }
            Ok(())
        }
        Cmd::Bench => bench(),
    }
}

fn init_claude() -> Result<()> {
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let status = std::process::Command::new("claude")
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
    Ok(())
}

fn bench() -> Result<()> {
    use std::time::Instant;
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
        (0..bytes / section.len() + 1).map(|i| section.replacen("Section heading", &format!("Section {i}"), 1)).collect()
    };
    let md_100k = repeat(100 * 1024);
    let md_1m = repeat(1024 * 1024);
    let code_10k: String = (0..10_000).map(|i| format!("fn f{i}(x: u32) -> u32 {{ x + {i} }} // line\n")).collect();
    let code_100k: String = (0..100_000).map(|i| format!("fn f{i}(x: u32) -> u32 {{ x + {i} }} // line\n")).collect();
    let cases: Vec<(&str, render::Kind, Option<&str>, &str)> = vec![
        ("markdown 2 KB", render::Kind::Markdown, None, md_2k),
        ("markdown 100 KB", render::Kind::Markdown, None, &md_100k),
        ("markdown 1 MB", render::Kind::Markdown, None, &md_1m),
        ("rust 10k lines (highlighted)", render::Kind::Code, Some("rs"), &code_10k),
        ("rust 100k lines (highlight capped at 256 KB)", render::Kind::Code, Some("rs"), &code_100k),
    ];
    println!("renderer init: {init_ms:.1} ms\n");
    println!("{:<48} {:>9} {:>9}   {:>9}", "case", "ms", "MB/s", "html KB");
    for (name, kind, lang, src) in cases {
        // Warm once so lazy regex compilation is not charged to the measurement.
        let _ = r.render(kind, lang, &src[..src.len().min(2048)]);
        let t = Instant::now();
        let out = r.render(kind, lang, src);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let mbs = src.len() as f64 / 1e6 / (ms / 1000.0);
        println!("{name:<48} {ms:>9.1} {mbs:>9.1}   {:>9}", out.len() / 1024);
    }
    Ok(())
}
