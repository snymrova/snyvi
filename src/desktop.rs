//! The desktop face: what `snyvi app` opens the viewer in.
//!
//! Three rungs, best first. A native window if the `snyvi-app` executable is
//! installed beside this binary or on PATH; else a Chromium-family window in
//! app mode, which has no browser chrome either; else the default browser.
//!
//! The window lives in its own executable so that this one -- the daemon, the
//! CLI, the MCP server and the hook -- never links a browser engine and stays
//! static. Nothing here is compiled conditionally: a build without the window
//! and a machine without it installed are the same case, handled the same way.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The window executable, looked for next to this binary before PATH so that a
/// tarball install finds its own copy rather than an older one on PATH.
fn window_binary() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(sibling) = exe.parent().map(|d| d.join("snyvi-app")) {
            if sibling.is_file() {
                return Some(sibling);
            }
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join("snyvi-app"))
        .find(|c| c.is_file())
}

fn has_display() -> bool {
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

pub fn open(url: &str) -> anyhow::Result<()> {
    if has_display() {
        if let Some(bin) = window_binary() {
            // Replace this process: the window is the foreground program from
            // here on, and `snyvi app` should live exactly as long as it does.
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let e = Command::new(&bin).arg(url).exec();
                // exec only returns on failure; fall through to a browser.
                eprintln!("snyvi: {}: {e}", bin.display());
            }
            #[cfg(not(unix))]
            match Command::new(&bin).arg(url).status() {
                Ok(_) => return Ok(()),
                Err(e) => eprintln!("snyvi: {}: {e}", bin.display()),
            }
        }
    }

    // A Chromium-family "app" window has no browser chrome and starts fast.
    for browser in [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "brave-browser",
        "microsoft-edge",
    ] {
        let ok = Command::new(browser)
            .arg(format!("--app={url}"))
            .arg("--window-size=1280,860")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok();
        if ok {
            return Ok(());
        }
    }
    crate::client::open_in_browser(url);
    if has_display() && window_binary().is_none() {
        eprintln!("(install snyvi-app for a native window)");
    }
    Ok(())
}
