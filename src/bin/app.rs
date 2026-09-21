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
//! Such a link is handed to `snyvi app`, which starts the daemon if it is down,
//! mints the window's capability, and comes back here with an address. Only
//! where there is no `snyvi` to hand it to is it read as an address here.

// A window, not a console program. Without this Windows gives the executable
// a console of its own, and a double-click on the Start menu entry would open
// a black terminal beside the viewer. Output handed down still arrives:
// `snyvi app` passes its own, which is how a terminal and CI read this.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Once;
use std::time::Duration;

use tauri::{
    image::Image,
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
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

/// The window commands the page is allowed, and no others. The frame is the
/// page's: it drags the window by its own header row (Tauri's own handler
/// answers a `data-tauri-drag-region` attribute with the first two commands)
/// and draws the three buttons a title bar had (the next four). The last is
/// for `FRAME_CHECK` below.
const PAGE_WINDOW_COMMANDS: [&str; 7] = [
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
    "core:window:allow-set-decorations",
];

/// Run in the page once it has loaded: a page with a drag region carries the
/// frame itself, and the window draws none; a page without one gets the
/// system's frame back, since it cannot be moved by any other means.
///
/// The page and this window come from different processes, and the daemon
/// serving the page can be older than the window showing it -- upgraded on
/// disk, not yet restarted. Deciding here, from what the page actually is
/// rather than what it is expected to be, means a window is never left with
/// no title bar and nothing to drag.
const FRAME_CHECK: &str = "window.__TAURI_INTERNALS__.invoke('plugin:window|set_decorations', \
    { value: !document.querySelector('[data-tauri-drag-region]') })";

/// What the window remembers between runs: where it was, how big, whether
/// maximised. Not whether it had a frame -- that is decided afresh each run,
/// by `FRAME_CHECK` and the page, and a saved answer would outlive it. A
/// window that once ran frameless would otherwise come back frameless under
/// a build whose page cannot draw the buttons, with no bar and no way to
/// close it.
const REMEMBERED: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::from_bits_truncate(
        tauri_plugin_window_state::StateFlags::all().bits()
            & !tauri_plugin_window_state::StateFlags::DECORATIONS.bits()
            & !tauri_plugin_window_state::StateFlags::FULLSCREEN.bits(),
    );

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
    // A `snyvi://` link goes to `snyvi app` whenever there is one to go to.
    //
    // It needs a daemon to be read against, and a window opened from it needs a
    // capability -- and minting one takes the write token, which this binary
    // cannot read, because it links none of that crate and that is the point of
    // it being separate. `snyvi app` holds both: it starts the daemon if it is
    // down, mints, and comes back here with an address. A window already up is
    // reached before any of this, by the single-instance plugin below, and it
    // has held its own capability since it opened.
    //
    // The hand-off used to happen only when the daemon was down. Doing it
    // whenever it can costs an exec and buys the window its panes. Falling
    // through -- no `snyvi` beside this executable -- reads the link here, as
    // before, and opens a window with no capability and so no panes.
    let parsed = if parsed.scheme() == SCHEME {
        if snyvi_binary().is_some() || !daemon_up() {
            hand_to_snyvi(Some(&url));
        }
        resolve(&parsed, &base_url(None))
    } else {
        parsed
    };
    // The origin the window reads from, kept before the URL is handed to the
    // builder. Every navigation is measured against it below.
    let home = parsed.origin().ascii_serialization();
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
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(REMEMBERED)
                .build(),
        )
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
            use tauri_plugin_window_state::{AppHandleExt, WindowExt};
            let at_home = home.clone();
            let frame = frame_wanted();
            // The page may run the window commands above, and only from the
            // daemon's origin -- the one place the window ever shows, as the
            // navigation rule says. Granted here, at run time, because that
            // origin is only known once the window is given its URL; a
            // capability file would have to guess the port. Before the window
            // exists, so no page is ever ahead of its permission.
            let mut cap = CapabilityBuilder::new("page-frame")
                .local(false)
                .remote(home.clone())
                .window("main");
            for permission in PAGE_WINDOW_COMMANDS {
                cap = cap.permission(permission);
            }
            if let Err(e) = app.add_capability(cap) {
                eprintln!("snyvi-app: the page cannot drag or close the window ({e})");
            }
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("snyvi")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 320.0)
                // No title bar of the system's: the page's own header row is
                // the drag region and carries the window buttons, so the app
                // stops being a web page in a frame. The edges still resize
                // the window; the runtime does that itself for an undecorated
                // window. `SNYVI_FRAME=1` keeps the system's frame.
                .decorations(frame);
            // On macOS the frame stays and the title bar goes transparent
            // instead, so the traffic lights are the system's own and sit
            // over the page's header, where the page leaves room for them.
            #[cfg(target_os = "macos")]
            let builder = match frame {
                true => builder,
                false => builder
                    .decorations(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true),
            };
            let w = builder
                // The web belongs in a browser. This window has no address bar
                // and no Back button -- Back is the page's own key handler, and
                // a page from somewhere else does not have it -- so a link
                // followed here would strand the reader on a site with no way
                // home but the tray. Anything off the daemon's origin is handed
                // to the desktop instead and the window stays where it was.
                .on_navigation(move |url| {
                    if stays_home(url, &at_home) {
                        return true;
                    }
                    hand_to_desktop(url.as_str());
                    false
                })
                // `window.open` and `target="_blank"`, which the engine treats
                // as a request for a second window rather than a navigation.
                // snyvi has one window, so these go to the desktop too --
                // including the viewer's own "Open source", whose raw text is
                // a thing to read beside snyvi rather than inside it.
                .on_new_window(|url, _features| {
                    hand_to_desktop(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                })
                // Every page, not only the first: the window navigates, and
                // each page it lands on is asked the same question. Not on
                // macOS, where the frame is never taken away.
                .on_page_load(move |w, payload| {
                    if cfg!(target_os = "macos") || frame {
                        return;
                    }
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = w.eval(FRAME_CHECK);
                    }
                })
                .icon(Image::from_bytes(WINDOW_ICON)?)?
                .build()?;
            // Size and position from the last run, saved by the plugin on close.
            let _ = w.restore_state(REMEMBERED);

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
                    let _ = handle.save_window_state(REMEMBERED);
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
/// `snyvi://d/<id>` is `<base>/d/<id>`, `snyvi://` alone is the viewer, and a
/// query rides along. So does a fragment: `snyvi://d/x#L4-L9` is a link to a
/// line range, and dropping the fragment -- which this did -- opened the
/// document at the top instead. The window's mark is added, since where a link
/// opens here is a window; the page keeps the mark for its session and drops it
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
    let frag = match link.fragment() {
        Some(f) => format!("#{f}"),
        None => String::new(),
    };
    let url = match link.query() {
        Some(q) => format!("{base}{path}?{q}&{WINDOW_MARK}{frag}"),
        None => format!("{base}{path}?{WINDOW_MARK}{frag}"),
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

/// Whether a URL is somewhere this window should go itself.
///
/// The daemon's own origin is snyvi, and everything else is the web. `about:`
/// is the engine's own -- a frame with nothing in it yet, or the blank page a
/// webview starts on -- and is not a place a reader can be stranded, so it is
/// not handed to a browser either.
fn stays_home(url: &tauri::Url, home: &str) -> bool {
    url.scheme() == "about" || url.origin().ascii_serialization() == home
}

/// Hand a URL to whatever the desktop opens links with.
///
/// The same thing `snyvi`'s own `platform::open_url` does, written again here
/// because this binary links none of that crate -- which is the point of it
/// being separate. Failure is a line and nothing more: a link that would not
/// open is worth saying, and is never worth taking the window down for.
fn hand_to_desktop(url: &str) {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    {
        // `start` is a builtin of cmd, not a program, so this goes through the
        // shell -- and a command line for cmd has to be built rather than
        // passed as arguments. An unquoted `&` is where cmd stops reading a
        // URL and starts reading a second command, so the URL is written out
        // quoted, with any quote inside it dropped so it cannot close that
        // quoting and be read as one. The empty pair before it is the window
        // title, which `start` would otherwise take the URL for.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let safe: String = url
            .chars()
            .filter(|c| *c != '"' && *c != '\n' && *c != '\r')
            .collect();
        if Command::new("cmd")
            .arg("/C")
            .raw_arg(format!("start \"\" \"{safe}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return;
        }
    }
    #[cfg(not(windows))]
    for opener in ["xdg-open", "open"] {
        if Command::new(opener)
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    eprintln!("snyvi-app: nothing on this desktop opens {url}");
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

/// Whether the system's own window frame is wanted. `SNYVI_FRAME=1` (or
/// `yes`, `on`, `true`) says so, for a desktop whose title bars should all
/// look alike, or a window manager that draws its own; unset is the page's
/// frame, which is the default.
fn frame_wanted() -> bool {
    matches!(
        std::env::var("SNYVI_FRAME").as_deref().map(str::trim),
        Ok("1" | "yes" | "on" | "true")
    )
}

/// No daemon is known to be up: no URL was given, or a `snyvi://` link was
/// and nothing answers on the port. The `snyvi` beside this executable knows
/// how to start one -- `snyvi app` does, and runs this again with the URL,
/// the link's own if there was one -- so hand over to it. On unix that is an
/// exec, so the window that follows is this same process as far as whoever
/// launched it can tell.
/// The `snyvi` command beside this executable, when there is one. Beside it
/// rather than on PATH, so an install finds its own copy: the same rule the
/// daemon uses to find this binary, read the other way round.
fn snyvi_binary() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| {
            p.parent()
                .map(|d| d.join(if cfg!(windows) { "snyvi.exe" } else { "snyvi" }))
        })
        .filter(|p| p.is_file())
}

fn hand_to_snyvi(link: Option<&str>) -> ! {
    if let Some(snyvi) = snyvi_binary() {
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

    fn goes(url: &str) -> bool {
        stays_home(&url.parse().unwrap(), "http://127.0.0.1:7777")
    }

    #[test]
    fn the_window_keeps_the_daemon_and_gives_the_web_away() {
        // Everything the viewer is made of stays.
        assert!(goes("http://127.0.0.1:7777/"));
        assert!(goes("http://127.0.0.1:7777/d/abc?window=1"));
        assert!(goes("http://127.0.0.1:7777/api/docs/abc/raw"));
        assert!(goes("about:blank"));
        // The web, and a port that is not the daemon's, do not.
        assert!(!goes("https://github.com/snymrova/snyvi"));
        assert!(!goes("http://127.0.0.1:7778/d/abc"));
        assert!(!goes("https://127.0.0.1:7777/d/abc"));
        assert!(!goes("mailto:a@b.c"));
        assert!(!goes("file:///etc/hosts"));
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
