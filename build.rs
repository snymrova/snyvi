#[path = "src/strip.rs"]
mod strip;

fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();

    build_line();
    strip_ui();

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

/// The UI the daemon embeds: the files in `ui/` with their comments and
/// indentation taken out, written beside the build. The source keeps every
/// word of its prose and `SNYVI_UI_DIR` still serves it as written; what goes
/// in the binary is what a browser actually reads. `src/strip.rs` says why,
/// and is where the scanner's tests live.
fn strip_ui() {
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    )
    .join("ui");
    for (name, lang) in [
        ("app.js", strip::Lang::Js),
        ("boot.js", strip::Lang::Js),
        ("mmd.js", strip::Lang::Js),
        ("desk.js", strip::Lang::Js),
        ("frame.js", strip::Lang::Js),
        ("game.js", strip::Lang::Js),
        ("about.js", strip::Lang::Js),
        ("find.js", strip::Lang::Js),
        ("menu.js", strip::Lang::Js),
        ("app.css", strip::Lang::Css),
    ] {
        let from = dir.join(name);
        println!("cargo:rerun-if-changed={}", from.display());
        let src =
            std::fs::read_to_string(&from).unwrap_or_else(|e| panic!("{}: {e}", from.display()));
        std::fs::write(out.join(name), strip::strip(&src, lang))
            .unwrap_or_else(|e| panic!("{}: {e}", out.join(name).display()));
    }
}

/// The commit and the target the binary was built from, for the about
/// panel: the version alone cannot tell two builds between the same two
/// tags apart. Empty outside a checkout (a tarball, a crates.io build); the
/// panel then shows the version and nothing false beside it.
fn build_line() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    println!(
        "cargo:rustc-env=SNYVI_GIT_SHA={}",
        git(&["rev-parse", "--short=9", "HEAD"])
    );
    println!(
        "cargo:rustc-env=SNYVI_TARGET={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    // A new commit moves HEAD or the branch it names; either is a rebuild.
    if let Ok(dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let head = std::path::Path::new(&dir).join(".git/HEAD");
        println!("cargo:rerun-if-changed={}", head.display());
        if let Some(r) = std::fs::read_to_string(&head)
            .ok()
            .and_then(|h| h.trim().strip_prefix("ref: ").map(str::to_string))
        {
            println!("cargo:rerun-if-changed={}/.git/{r}", dir);
        }
    }
}
