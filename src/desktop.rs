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
pub const WINDOW_MARK: &str = "window=1";

/// The key the window's capability travels under, on the fragment of the first
/// URL the window is given. See `crate::capability` for why it is the fragment
/// and never the query string.
pub const CAPABILITY_KEY: &str = "cap";

/// A URL split at its fragment: everything before `#`, and the fragment with
/// its `#` still on it. A query parameter goes in front of a fragment, so
/// anything added to a URL here has to know where the fragment starts.
fn split_fragment(url: &str) -> (&str, &str) {
    match url.find('#') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    }
}

/// A URL with the window's mark on it, whether or not it has a query already.
///
/// The mark is a query parameter, so it goes before any fragment. Appending it
/// to the end of the string instead -- which this did -- buries it *inside* the
/// fragment of a URL that has one: `/d/x#top` became `/d/x#top?window=1`, where
/// the whole of `top?window=1` is the fragment, the daemon is sent nothing, and
/// the window it opened is not counted as one.
fn marked(url: &str) -> String {
    let (head, frag) = split_fragment(url);
    let sep = if head.contains('?') { '&' } else { '?' };
    format!("{head}{sep}{WINDOW_MARK}{frag}")
}

/// A URL carrying the window's capability on its fragment, in front of
/// whatever fragment the URL already had -- a document opened at a heading or
/// a line range keeps it, because the page puts back what is left after it
/// takes the capability off.
fn with_capability(url: &str, cap: &str) -> String {
    let (head, frag) = split_fragment(url);
    match frag.strip_prefix('#').unwrap_or("") {
        "" => format!("{head}#{CAPABILITY_KEY}={cap}"),
        rest => format!("{head}#{CAPABILITY_KEY}={cap}&{rest}"),
    }
}

/// The scheme of a link that opens in the window rather than a browser:
/// `snyvi://d/<id>` is the document at `/d/<id>`, and `snyvi://` alone is
/// the viewer. The desktop hands such a link to `snyvi-app` (registered by
/// the package's desktop entry, the bundle's Info.plist, or the window
/// itself on first run), which reads it as the daemon's address for it.
pub const SCHEME: &str = "snyvi";

/// The `snyvi://` link to a document.
pub fn app_url(id: &str) -> String {
    format!("{SCHEME}://d/{id}")
}

/// What a thing to open means as an address on the daemon: a `snyvi://` link
/// as the path it names, an `http` link as it is, and anything else as a
/// document id.
pub fn resolve(target: &str) -> String {
    let base = crate::config::base_url();
    if let Some(rest) = target.strip_prefix(&format!("{SCHEME}:")) {
        let rest = rest.trim_start_matches('/');
        return format!("{base}/{rest}");
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    format!("{base}/d/{target}")
}

/// Whether the window executable is installed here, and so whether a
/// `snyvi://` link has anything to open in.
pub fn window_installed() -> bool {
    window_binary().is_some()
}

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

/// Open the viewer, with the capability this launch was given if it got one.
///
/// The capability rides the native window's rung and no other: the rungs below
/// it are browsers, and a browser is not the window panes are allowed in. A
/// `None` here is a launch that could not mint one -- no daemon to ask, or one
/// too old to know how -- and it opens a window that reads exactly as it always
/// did and has no panes.
pub fn open(url: &str, capability: Option<&str>) -> anyhow::Result<()> {
    if crate::platform::has_display() {
        if let Some(bin) = window_binary() {
            // The mark rides on the first page only: the page keeps it for
            // the session, and the rungs below it are not windows anything
            // can raise, so they are opened unmarked. The capability rides
            // with it, for the same one page and the same reason.
            let marked = match capability {
                Some(cap) => with_capability(&marked(url), cap),
                None => marked(url),
            };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_a_url_and_an_id_all_resolve_on_the_daemon() {
        let base = crate::config::base_url();
        assert_eq!(resolve("snyvi://d/abc"), format!("{base}/d/abc"));
        assert_eq!(resolve("snyvi://"), format!("{base}/"));
        assert_eq!(resolve("abc"), format!("{base}/d/abc"));
        assert_eq!(
            resolve("http://127.0.0.1:7777/d/abc"),
            "http://127.0.0.1:7777/d/abc"
        );
    }

    #[test]
    fn the_mark_joins_whatever_query_is_there() {
        assert_eq!(marked("http://h:1"), "http://h:1?window=1");
        assert_eq!(marked("http://h:1/d/x?v=2"), "http://h:1/d/x?v=2&window=1");
    }

    #[test]
    fn the_mark_goes_in_front_of_a_fragment_rather_than_into_it() {
        assert_eq!(marked("http://h:1/d/x#top"), "http://h:1/d/x?window=1#top");
        assert_eq!(
            marked("http://h:1/d/x?v=2#L4-L9"),
            "http://h:1/d/x?v=2&window=1#L4-L9"
        );
    }

    #[test]
    fn the_capability_leads_the_fragment_and_keeps_what_was_there() {
        let cap = "a".repeat(64);
        assert_eq!(
            with_capability("http://h:1/?window=1", &cap),
            format!("http://h:1/?window=1#cap={cap}")
        );
        assert_eq!(
            with_capability("http://h:1/d/x?window=1#L4-L9", &cap),
            format!("http://h:1/d/x?window=1#cap={cap}&L4-L9")
        );
    }

    #[test]
    fn app_url_is_the_scheme_and_the_document() {
        assert_eq!(app_url("abc"), "snyvi://d/abc");
    }
}
