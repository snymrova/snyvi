//! `snyvi-app`: the native window, and nothing else.
//!
//! A separate executable rather than a subcommand, because linking a browser
//! engine into the binary links it into every other thing the binary does --
//! `serve`, `send`, `mcp`, `hook` -- and the daemon then carries an engine it
//! never opens. `snyvi app` finds this and hands it a URL; everything else
//! about snyvi stays a static binary that depends on nothing.
//!
//! It therefore needs nothing from the crate: the URL arrives on argv.

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let url = match std::env::args().nth(1) {
        Some(u) => u,
        None => {
            eprintln!("usage: snyvi-app <url>    (normally run for you by `snyvi app`)");
            std::process::exit(2);
        }
    };
    // The caller checks for a display too, and falls back to a browser when
    // there is none. Checked again here because this is also reachable directly.
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        eprintln!("snyvi-app: no display server");
        std::process::exit(3);
    }
    let parsed: tauri::Url = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("snyvi-app: {url}: {e}");
            std::process::exit(2);
        }
    };
    let run = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            use tauri_plugin_window_state::{StateFlags, WindowExt};
            let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("snyvi")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 320.0)
                .build()?;
            // Size and position from the last run, saved by the plugin on close.
            let _ = w.restore_state(StateFlags::all());
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = run {
        eprintln!("snyvi-app: {e}");
        std::process::exit(1);
    }
}
