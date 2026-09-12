fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();

    // tauri-build above gives the window executable its icon. snyvi.exe is a
    // console program and nothing gives it one, so it is attached here -- in
    // the pass that builds it, and only that pass, since a second icon
    // resource on the window binary would collide with tauri's own.
    //
    // Best effort. A Windows build without the SDK's resource compiler still
    // produces a working snyvi.exe; it just wears the default icon.
    #[cfg(all(windows, not(feature = "desktop")))]
    {
        println!("cargo:rerun-if-changed=icons/icon.ico");
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icons/icon.ico");
        if let Err(e) = res.compile() {
            println!("cargo:warning=snyvi.exe has no icon resource: {e}");
        }
    }
}
