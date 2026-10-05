mod agents;
mod aside;
mod bench;
mod brief;
mod browse;
mod capability;
mod cli;
mod client;
mod config;
mod desk;
mod desktop;
mod git;
mod hook;
mod mcp;
mod pane;
mod platform;
mod project;
mod prompt;
mod receive;
mod render;
mod reset;
mod resolve;
mod screen;
mod secrets;
mod server;
mod session;
mod setup;
mod statusline;
mod store;
/// `build.rs` compiles this one for itself -- it is what strips `ui/` on the
/// way into the binary and joins a script's parts -- and the daemon shares
/// it: under `SNYVI_UI_DIR` an asset kept as parts is joined the same way
/// (`server::assets`), and the scanner's tests are in `cargo test`.
mod strip;
mod studio;
mod text;
mod update;
mod version;
mod watch;

/// "1 panel", "3 panels": a count in words, never "panel(s)"
/// (docs/DESIGN.md §3.1). Regular plurals only, which is every word it is
/// asked for.
pub(crate) fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

use anyhow::Result;

// musl's allocator is slow under the renderer's allocation pattern; mimalloc keeps the
// static binary as fast as the glibc build.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
fn main() -> Result<()> {
    cli::run()
}
