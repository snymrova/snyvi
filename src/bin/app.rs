//! `snyvi-app`: the native window, and nothing else.
//!
//! A separate executable rather than a subcommand, because linking a browser
//! engine into the binary links it into every other thing the binary does --
//! `serve`, `send`, `mcp`, `hook` -- and the daemon then carries an engine it
//! never opens. `snyvi app` finds this and hands it a URL; everything else
//! about snyvi stays a static binary that depends on nothing.
//!
//! It therefore needs nothing from the crate: the URL arrives on argv. Run
//! with no argument at all -- a double-clicked `snyvi.app` on macOS, or a bare
//! `snyvi-app` in a terminal -- it hands over to the `snyvi` beside it, which
//! starts the daemon if need be and comes back here with the URL.
//!
//! The URL may also be a `snyvi://` link, which is what the desktop hands
//! this executable when one is clicked anywhere: `snyvi://d/<id>` is the
//! document at `/d/<id>` on the daemon, and `snyvi://` alone is the viewer.
//! With a daemon up it is read as that address; without one it is handed to
//! `snyvi app`, which starts the daemon and comes back here with it.

// A window, not a console program. Without this Windows gives the executable
// a console of its own, and a double-click on the Start menu entry would open
// a black terminal beside the viewer. Output handed down still arrives:
// `snyvi app` passes its own, which is how a terminal and CI read this.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::sync::Once;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The mark at 256px for the window, and at 32 for the tray -- the largest
/// size still drawn on the pixel grid, and so the crispest thing to hand a
/// tray that will draw it at 16 or 24.
const WINDOW_ICON: &[u8] = include_bytes!("../../icons/256.png");
const TRAY_ICON: &[u8] = include_bytes!("../../icons/tray.png");

/// The key that shows the window from anywhere, or hides it again -- the other
/// half of the tray item, for a reader who would rather not find the tray.
///
/// A key that no desktop's own shell holds: ⌘⇧Space on macOS, where ⌘Space is
/// Spotlight and ⌃Space changes the input source, and Ctrl+Shift+Space on
/// Windows and Linux, where the Super key is the shell's. Some programs use
/// the same chord for something of their own -- a spreadsheet selects its
/// sheet with it -- and a global shortcut wins over a program's, so it is a
/// default and not a decision: `SNYVI_SHORTCUT` names another key, and `0`
/// registers none.
///
/// Spelled per platform rather than as `CmdOrCtrl`, so the line that says it
/// registered names the key the reader will press.
#[cfg(target_os = "macos")]
const SHORTCUT: &str = "Cmd+Shift+Space";
#[cfg(not(target_os = "macos"))]
const SHORTCUT: &str = "Ctrl+Shift+Space";

/// The scheme of a link that opens here rather than in a browser. The same
/// name as the command, so `snyvi://d/<id>` reads as what it is.
const SCHEME: &str = "snyvi";

/// The daemon's port, as `snyvi` itself reads it. Copied rather than shared
/// because this binary links none of that crate.
const DEFAULT_PORT: u16 = 7777;

/// What the page in this window carries on its first URL, so the daemon
/// counts it as a window. The same mark `snyvi app` puts there.
const WINDOW_MARK: &str = "window=1";

fn main() {
    let url = match std::env::args().nth(1) {
        Some(u) => u,
        None => hand_to_snyvi(None),
    };
    // The caller checks for a display too, and falls back to a browser when
    // there is none. Checked again here because this is also reachable
    // directly. Linux only: elsewhere a desktop session is the only way this
    // is reached. It cannot share `snyvi`'s copy of the check -- this binary
    // links none of that crate, which is the point of it being separate.
    #[cfg(target_os = "linux")]
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
    // A `snyvi://` link needs a daemon to read it from. A window already up
    // has one, and the single-instance plugin below hands the link to that
    // window before this process builds anything. Otherwise the daemon may
    // be down -- this is a click on a link in a terminal or a chat, not a
    // hand-off from `snyvi app` -- and starting it is `snyvi`'s job.
    let parsed = if parsed.scheme() == SCHEME {
        if !daemon_up() {
            hand_to_snyvi(Some(&url));
        }
        resolve(&parsed, &base_url(None))
    } else {
        parsed
    };
    let shortcut = shortcut_wanted();
    let builder = tauri::Builder::default()
        // Before every other plugin, which is what this one requires: it has
        // to answer for a second process before that process builds anything.
        //
        // A second `snyvi app` means "show me the viewer", not "open another
        // one" -- and it is a likely thing to type now that closing the window
        // only hides it, which would otherwise leave two tray icons behind.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let Some(w) = app.get_webview_window("main") else {
                return;
            };
            if let Some(u) = argv.get(1).and_then(|u| u.parse::<tauri::Url>().ok()) {
                open_in(&w, u);
            }
            reveal(&w);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init());
    // Only when a key is wanted: the plugin opens the display's hotkey
    // interface as it loads, and a failure there is fatal to the whole window,
    // which a shortcut is never worth. The key itself is registered in setup
    // below, where its failure is a line and not an exit.
    let builder = match shortcut.is_some() {
        true => builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _key, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(w) = app.get_webview_window("main") {
                        toggle(&w);
                    }
                })
                .build(),
        ),
        false => builder,
    };
    let run = builder
        .setup(move |app| {
            use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
            let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("snyvi")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 320.0)
                .icon(Image::from_bytes(WINDOW_ICON)?)?
                .build()?;
            // Size and position from the last run, saved by the plugin on close.
            let _ = w.restore_state(StateFlags::all());

            // A tray is an addition, not a precondition. On Linux it is loaded
            // at runtime rather than linked, so a machine without
            // libayatana-appindicator has none -- and a window is still worth
            // far more than no window.
            let tray = match tray(app.handle(), &w) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("snyvi-app: no tray icon ({e})");
                    false
                }
            };

            if let Some(key) = &shortcut {
                match app.global_shortcut().register(key.as_str()) {
                    Ok(()) => eprintln!("snyvi-app: {key} shows or hides the window from anywhere"),
                    // Another program holds the key, or the display has no
                    // way to grant one. The tray still shows the window, and
                    // so does running `snyvi app` again.
                    Err(e) => eprintln!("snyvi-app: no global shortcut ({key}: {e})"),
                }
            }

            // Off the main thread: it runs the desktop's own tools, and the
            // window should not wait on them. Nothing on macOS, where the
            // scheme is declared in the bundle's Info.plist and cannot be
            // claimed at runtime.
            #[cfg(any(target_os = "linux", windows))]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || claim_scheme(&handle));
            }

            let window = w.clone();
            let handle = app.handle().clone();
            w.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Closing puts snyvi away rather than ending it. Showing a
                    // hidden window is instant; starting a browser engine is
                    // the ~150 ms this avoids paying again, and the tray is
                    // there to bring it back.
                    //
                    // Only when there is a tray, though: hiding the window
                    // with nothing to click would leave snyvi running with no
                    // way back to it.
                    if !tray {
                        return;
                    }
                    api.prevent_close();
                    // Written now rather than on exit, because by then the
                    // window has been hidden and has no geometry worth saving.
                    let _ = handle.save_window_state(StateFlags::all());
                    let _ = window.hide();
                    said_where_it_went();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match run {
        Ok(app) => app,
        Err(e) => {
            eprintln!("snyvi-app: {e}");
            std::process::exit(1);
        }
    };
    app.run(|_app, _event| {
        // A `snyvi://` link on macOS arrives here, from the desktop, whether
        // the app was running or was started for it -- there is no argv for
        // a link on macOS. Anything else on the run loop is Tauri's own.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let Some(w) = _app.get_webview_window("main") else {
                return;
            };
            if let Some(u) = urls.into_iter().find(|u| u.scheme() == SCHEME) {
                open_in(&w, u);
            }
            reveal(&w);
        }
    });
}

/// Show a URL in the window: a `snyvi://` link as the daemon's address for
/// it, anything else as it is.
fn open_in(w: &WebviewWindow, url: tauri::Url) {
    let url = if url.scheme() == SCHEME {
        resolve(&url, &base_url(Some(w)))
    } else {
        url
    };
    let _ = w.navigate(url);
}

/// A `snyvi://` link as the address it stands for on the daemon:
/// `snyvi://d/<id>` is `<base>/d/<id>`, `snyvi://` alone is the viewer, and
/// a query rides along. The window's mark is added, since where a link opens
/// here is a window -- the page keeps the mark for its session and drops it
/// from the address, so one more copy of it does no harm.
fn resolve(link: &tauri::Url, base: &str) -> tauri::Url {
    let mut path = String::new();
    if let Some(host) = link.host_str().filter(|h| !h.is_empty()) {
        path.push('/');
        path.push_str(host);
    }
    path.push_str(link.path());
    if path.is_empty() {
        path.push('/');
    }
    let url = match link.query() {
        Some(q) => format!("{base}{path}?{q}&{WINDOW_MARK}"),
        None => format!("{base}{path}?{WINDOW_MARK}"),
    };
    url.parse()
        .unwrap_or_else(|_| format!("{base}/").parse().expect("base url"))
}

/// Where the daemon is: the origin of what the window is showing, when there
/// is a window, since that is the daemon it has been reading from; else the
/// address `snyvi` would compute, from `SNYVI_PORT` or the default.
fn base_url(w: Option<&WebviewWindow>) -> String {
    if let Some(u) = w.and_then(|w| w.url().ok()) {
        if u.scheme().starts_with("http") {
            return u.origin().ascii_serialization();
        }
    }
    format!("http://127.0.0.1:{}", port())
}

fn port() -> u16 {
    std::env::var("SNYVI_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Whether anything answers on the daemon's port. A connection and nothing
/// more: the question is whether to start one, not what it says.
fn daemon_up() -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port()));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Make this executable the desktop's handler for `snyvi://`, unless a
/// package's own desktop entry already is. The .deb installs one that says
/// `snyvi app %u`; a tarball or a zip installs nothing, and this is what
/// makes the links work for it too. Written once per launch, to a handler
/// entry of the plugin's own in the user's applications directory (Linux)
/// or the user's registry classes (Windows), and rewritten only when the
/// executable has moved.
#[cfg(any(target_os = "linux", windows))]
fn claim_scheme(app: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    #[cfg(target_os = "linux")]
    {
        // What the desktop opens the scheme with now. Empty when nothing is
        // registered; the plugin's own handler entry when this ran before;
        // anything else is a choice -- the package's entry, or the reader's
        // own -- and is left as it is.
        let owner = std::process::Command::new("xdg-mime")
            .args(["query", "default", &format!("x-scheme-handler/{SCHEME}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if !owner.is_empty() && !owner.contains("snyvi-app-handler") {
            return;
        }
    }
    #[cfg(windows)]
    if app.deep_link().is_registered(SCHEME).unwrap_or(false) {
        return;
    }
    if let Err(e) = app.deep_link().register(SCHEME) {
        eprintln!("snyvi-app: {SCHEME}:// links will not open here ({e})");
    }
}

/// The tray icon: how a hidden window is found again, and how snyvi is quit.
///
/// Two items, because there is nothing else a tray should decide. The library,
/// the daemon and everything about them belong to `snyvi` itself.
fn tray(app: &tauri::AppHandle, window: &WebviewWindow) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show snyvi", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit snyvi", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let _ = window;

    let builder = TrayIconBuilder::with_id("snyvi")
        .icon(Image::from_bytes(TRAY_ICON)?)
        .tooltip("snyvi")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    reveal(&w);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    // On Windows a left click should toggle the window and only a right click
    // open the menu, which is what people expect of a tray there. Linux's tray
    // protocol delivers no click events at all -- the menu is the whole
    // interface -- so there it has to answer both buttons.
    #[cfg(target_os = "windows")]
    let builder = {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        builder
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            reveal(&w);
                        }
                    }
                }
            })
    };

    builder.build(app)?;
    Ok(())
}

/// Show a window that may be hidden, minimised, or simply behind something.
fn reveal(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// What the shortcut does: a window the reader is looking at goes away, and
/// any other -- hidden, minimised, behind the editor -- comes to the front.
/// The same key both ways, so there is one thing to remember.
fn toggle(w: &WebviewWindow) {
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        reveal(w);
    }
}

/// The key to register, if any. `SNYVI_SHORTCUT` unset is the default key;
/// `0` (or `off`, `none`) is no key; anything else is read as a chord in the
/// usual `Ctrl+Shift+Space` spelling, with `CmdOrCtrl` for the key that is ⌘
/// on a Mac and Ctrl elsewhere.
///
/// On Linux the hotkey interface is X11's, so a Wayland session gets none --
/// rather than one that fires only when an X11 program has the focus, which
/// is worse than none. The desktop's own shortcut settings can bind a key to
/// `snyvi app` there, and that reaches the running window the same way.
fn shortcut_wanted() -> Option<String> {
    let key = match std::env::var("SNYVI_SHORTCUT") {
        Ok(v) => match v.trim() {
            "" | "0" | "off" | "none" | "no" | "false" => return None,
            k => k.to_string(),
        },
        Err(_) => SHORTCUT.to_string(),
    };
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_none() {
        eprintln!(
            "snyvi-app: no global shortcut on Wayland; bind a key to `snyvi app` in the desktop's settings"
        );
        return None;
    }
    Some(key)
}

/// No daemon is known to be up: no URL was given, or a `snyvi://` link was
/// and nothing answers on the port. The `snyvi` beside this executable knows
/// how to start one -- `snyvi app` does, and runs this again with the URL,
/// the link's own if there was one -- so hand over to it. On unix that is an
/// exec, so the window that follows is this same process as far as whoever
/// launched it can tell.
fn hand_to_snyvi(link: Option<&str>) -> ! {
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| {
            p.parent()
                .map(|d| d.join(if cfg!(windows) { "snyvi.exe" } else { "snyvi" }))
        })
        .filter(|p| p.is_file());
    if let Some(snyvi) = sibling {
        let mut cmd = std::process::Command::new(&snyvi);
        cmd.arg("app");
        if let Some(l) = link {
            cmd.arg(l);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let e = cmd.exec();
            eprintln!("snyvi-app: {}: {e}", snyvi.display());
        }
        // `snyvi.exe` is a console program, and one started from a window
        // with no console is given a new one -- a terminal that would sit
        // beside the viewer for as long as it is open. Nothing it prints here
        // is for anyone: the window that follows is the answer.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(not(unix))]
        match cmd.status() {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(e) => eprintln!("snyvi-app: {}: {e}", snyvi.display()),
        }
    }
    match link {
        Some(l) => eprintln!(
            "snyvi-app: {l}: no daemon on port {} and no snyvi beside this executable to start one; run `snyvi app` first",
            port()
        ),
        None => eprintln!("usage: snyvi-app <url>    (normally run for you by `snyvi app`)"),
    }
    std::process::exit(2);
}

/// Say once where the window went. Closing something and having it keep
/// running is worth one line the first time and nothing after that.
fn said_where_it_went() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "snyvi-app: hidden to the tray. Click the tray icon to show it, or Quit from its menu."
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(link: &str) -> String {
        resolve(&link.parse().unwrap(), "http://127.0.0.1:7777").to_string()
    }

    #[test]
    fn a_link_is_the_daemon_address_with_the_mark() {
        assert_eq!(r("snyvi://d/abc"), "http://127.0.0.1:7777/d/abc?window=1");
        assert_eq!(r("snyvi:///d/abc"), "http://127.0.0.1:7777/d/abc?window=1");
        assert_eq!(r("snyvi://"), "http://127.0.0.1:7777/?window=1");
        assert_eq!(
            r("snyvi://d/abc?v=2"),
            "http://127.0.0.1:7777/d/abc?v=2&window=1"
        );
    }
}
