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
///
/// Next to the binary as it really is: on macOS the command on PATH is a
/// symlink into `snyvi.app`, where the window sits beside the real file, and
/// the path a process is started by is the link. Then PATH; then, on macOS,
/// the two places an application is dragged to.
fn window_binary() -> Option<PathBuf> {
    let name = crate::platform::exe("snyvi-app");
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.canonicalize().unwrap_or(exe);
        if let Some(sibling) = exe.parent().map(|d| d.join(&name)) {
            if sibling.is_file() {
                return Some(sibling);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&path)
            .map(|d| d.join(&name))
            .find(|c| c.is_file())
        {
            return Some(found);
        }
    }
    crate::platform::app_bundles("snyvi.app")
        .into_iter()
        .map(|app| app.join("Contents/MacOS").join(&name))
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
        let ok = Command::new(&browser)
            .arg(format!("--app={url}"))
            .arg("--window-size=1280,860")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok();
        if ok {
            say_rung(&format!("this is {} in app mode", program_name(&browser)));
            return Ok(());
        }
    }
    if crate::platform::open_url(url) {
        say_rung("this is the default browser");
    } else {
        say_rung("and no browser could be opened from here");
        eprintln!("  open this yourself: {url}");
    }
    Ok(())
}

/// Which rung of the ladder was taken, and how to get the one above it. The
/// ladder used to be silent, so a person with no window package could not
/// tell a fallback from the thing itself.
fn say_rung(what: &str) {
    if !crate::platform::has_display() {
        eprintln!("snyvi: no display, so no window; {what}");
        return;
    }
    if window_binary().is_some() {
        eprintln!("snyvi: the native window could not be started; {what}");
        return;
    }
    let get = if cfg!(target_os = "macos") {
        "put snyvi.app in Applications for one"
    } else if cfg!(windows) {
        "put snyvi-app.exe beside snyvi.exe for one"
    } else {
        "install the snyvi-app package for one"
    };
    eprintln!("snyvi: no native window installed, so {what}; {get}");
}

fn program_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}
