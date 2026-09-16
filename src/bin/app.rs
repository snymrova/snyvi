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

use std::sync::Once;

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

fn main() {
    let url = match std::env::args().nth(1) {
        Some(u) => u,
        None => hand_to_snyvi(),
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
                let _ = w.navigate(u);
            }
            reveal(&w);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());
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
        .run(tauri::generate_context!());
    if let Err(e) = run {
        eprintln!("snyvi-app: {e}");
        std::process::exit(1);
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

/// No URL was given, so there is no daemon known to be up and no page to
/// open. The `snyvi` beside this executable knows how to do both -- `snyvi
/// app` starts the daemon if it must and runs this again with the URL -- so
/// hand over to it. On unix that is an exec, so the window that follows is
/// this same process as far as whoever launched it can tell.
fn hand_to_snyvi() -> String {
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
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let e = cmd.exec();
            eprintln!("snyvi-app: {}: {e}", snyvi.display());
        }
        #[cfg(not(unix))]
        match cmd.status() {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(e) => eprintln!("snyvi-app: {}: {e}", snyvi.display()),
        }
    }
    eprintln!("usage: snyvi-app <url>    (normally run for you by `snyvi app`)");
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
