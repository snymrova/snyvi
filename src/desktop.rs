//! The desktop face. With the `desktop` feature: a native WebKitGTK window on the
//! local daemon. Without it: the browser, in app mode when Chromium is around.

#[cfg(feature = "desktop")]
pub fn open(url: &str) -> anyhow::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let has_display =
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if !has_display {
        eprintln!("no display server found; opening in the browser instead");
        crate::client::open_in_browser(url);
        return Ok(());
    }
    let url: tauri::Url = url.parse()?;
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("snyvi")
                .inner_size(1280.0, 860.0)
                .min_inner_size(480.0, 320.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("desktop window: {e}"))
}

#[cfg(not(feature = "desktop"))]
pub fn open(url: &str) -> anyhow::Result<()> {
    use std::process::{Command, Stdio};
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
    eprintln!("(build with `--features desktop` for a native window)");
    Ok(())
}
