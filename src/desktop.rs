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

/// What a page loaded in the native window carries, so the daemon knows there
/// is a window to hand a link to. The page latches it for the session, so it
/// survives the navigations the window then does.
pub const WINDOW_MARK: &str = "?window=1";

/// The window executable, looked for next to this binary before PATH so that a
/// tarball install finds its own copy rather than an older one on PATH.
fn window_binary() -> Option<PathBuf> {
    let name = crate::platform::exe("snyvi-app");
    if let Ok(exe) = std::env::current_exe() {
        if let Some(sibling) = exe.parent().map(|d| d.join(&name)) {
            if sibling.is_file() {
                return Some(sibling);
            }
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(&name))
        .find(|c| c.is_file())
}

/// Hand a URL to a window that is already up, and raise it.
///
/// The window's own single-instance plugin does both: a second `snyvi-app`
/// passes its argument to the first and exits, and the first navigates and
/// shows itself. So this is a spawn and nothing else -- no wait, because the
/// answer is a window coming forward, not an exit status.
///
/// Only ever called when the daemon says a window is connected. False means
/// there is no window binary to hand it to, and the caller falls back.
pub fn hand_to_window(url: &str) -> bool {
    if !crate::platform::has_display() {
        return false;
    }
    let Some(bin) = window_binary() else {
        return false;
    };
    Command::new(&bin)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

pub fn open(url: &str) -> anyhow::Result<()> {
    if crate::platform::has_display() {
        if let Some(bin) = window_binary() {
            // The mark rides on the first page only: the page keeps it for
            // the session, and the rungs below it are not windows anything
            // can raise, so they are opened unmarked.
            let marked = format!("{url}/{WINDOW_MARK}");
            // Replace this process: the window is the foreground program from
            // here on, and `snyvi app` should live exactly as long as it does.
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let e = Command::new(&bin).arg(&marked).exec();
                // exec only returns on failure; fall through to a browser.
                eprintln!("snyvi: {}: {e}", bin.display());
            }
            #[cfg(not(unix))]
            match Command::new(&bin).arg(&marked).status() {
                Ok(_) => return Ok(()),
                Err(e) => eprintln!("snyvi: {}: {e}", bin.display()),
            }
        }
    }

    // A Chromium-family "app" window has no browser chrome and starts fast.
    for browser in crate::platform::app_mode_browsers() {
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
    if crate::platform::has_display() && window_binary().is_none() {
        eprintln!("(install snyvi-app for a native window)");
    }
    Ok(())
}
