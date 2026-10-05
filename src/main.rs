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
#[cfg(not(feature = "mimalloc-lazy"))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// The same allocator with its arenas committed as they are touched: the A/B
/// build for the 6 MB mimalloc commits ahead of time (Cargo.toml, feature
/// `mimalloc-lazy`). The option has to be set before the first arena is
/// reserved, which is the first allocation, and a global allocator has no
/// earlier hook; so the first call through it sets the option, once, and
/// every call after pays an atomic load to find that done.
#[cfg(feature = "mimalloc-lazy")]
#[global_allocator]
static GLOBAL: lazy_mimalloc::LazyMiMalloc = lazy_mimalloc::LazyMiMalloc;

#[cfg(feature = "mimalloc-lazy")]
mod lazy_mimalloc {
    use std::alloc::{GlobalAlloc, Layout};
    use std::sync::Once;

    pub struct LazyMiMalloc;

    /// `mi_option_arena_eager_commit` in the bundled mimalloc 3 (the sys
    /// crate's option list is a subset and does not name it): its default
    /// of 2 commits eagerly on an overcommitting system, which Linux is.
    const ARENA_EAGER_COMMIT: libmimalloc_sys::mi_option_t = 4;

    fn tune() {
        static ONCE: Once = Once::new();
        // SAFETY: mi_option_set writes one entry of mimalloc's option table
        // and takes no pointers; Once allocates nothing on the way in.
        ONCE.call_once(|| unsafe { libmimalloc_sys::mi_option_set(ARENA_EAGER_COMMIT, 0) });
    }

    unsafe impl GlobalAlloc for LazyMiMalloc {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            tune();
            unsafe { mimalloc::MiMalloc.alloc(l) }
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            tune();
            unsafe { mimalloc::MiMalloc.alloc_zeroed(l) }
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            unsafe { mimalloc::MiMalloc.dealloc(p, l) }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
            unsafe { mimalloc::MiMalloc.realloc(p, l, n) }
        }
    }
}
fn main() -> Result<()> {
    cli::run()
}
