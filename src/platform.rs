//! The handful of things snyvi does that the operating system decides.
//!
//! Opening a URL, raising a notification, ending a process, starting the
//! daemon detached, knowing whether there is a screen at all, and what an
//! executable is called. Everything else in snyvi is the same code everywhere,
//! so these live together rather than as `#[cfg]` forks scattered through the
//! modules that happen to need them.
//!
//! Nothing here takes a dependency: each platform is asked in the way it
//! already answers, through a program it ships with.

use std::process::{Command, Stdio};

/// What an executable is called, for building a path to one.
pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Is there a display to open a window on?
///
/// On Windows and macOS a desktop session is the only way the program is
/// reached, so the answer is yes; on Linux it is a question worth asking,
/// because snyvi is often run over ssh, where a window would fail and a
/// printed URL is the useful answer.
/// The file a shell would run for `name`: the first match along PATH, with
/// the executable suffixes Windows adds. None when there is none.
pub fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        let ext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
        let mut v = vec![name.to_string()];
        v.extend(
            ext.split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!("{name}{}", e.to_ascii_lowercase())),
        );
        v
    } else {
        vec![name.to_string()]
    };
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

pub fn has_display() -> bool {
    if cfg!(not(target_os = "linux")) {
        return true;
    }
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Hand a URL to whatever the desktop opens links with.
pub fn open_url(url: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        // `start` is a builtin of cmd, not a program, so this goes through the
        // shell -- and a command line for cmd has to be built rather than
        // passed as arguments. Rust quotes an argument only when it contains a
        // space, and an unquoted `&` is where cmd stops reading a URL and
        // starts reading a second command. So the line is written out with the
        // URL quoted, and any quote inside it dropped so it cannot close that
        // quoting and be read as one.
        //
        // The empty pair before it is the window title: `start` takes a lone
        // quoted argument as one, and would open a window rather than the URL.
        let safe: String = url
            .chars()
            .filter(|c| *c != '"' && *c != '\n' && *c != '\r')
            .collect();
        return Command::new("cmd")
            .arg("/C")
            .raw_arg(format!("start \"\" \"{safe}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        for opener in ["xdg-open", "open"] {
            if Command::new(opener)
                .arg(url)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .is_ok()
            {
                return true;
            }
        }
        false
    }
}

/// The browsers that can open a chrome-less window, in the order to try them.
///
/// A Chromium-family browser in app mode has no tabs, no address bar and no
/// bookmarks: near enough a native window, and already installed far more
/// often than snyvi-app is. On Windows these are not on PATH, so the usual
/// install locations are tried as well.
pub fn app_mode_browsers() -> Vec<String> {
    if cfg!(target_os = "windows") {
        let mut out = vec![];
        for base in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            let Some(dir) = std::env::var_os(base) else {
                continue;
            };
            let dir = std::path::PathBuf::from(dir);
            for rel in [
                r"Microsoft\Edge\Application\msedge.exe",
                r"Google\Chrome\Application\chrome.exe",
                r"BraveSoftware\Brave-Browser\Application\brave.exe",
            ] {
                let p = dir.join(rel);
                if p.is_file() {
                    out.push(p.to_string_lossy().into_owned());
                }
            }
        }
        out
    } else if cfg!(target_os = "macos") {
        // Nothing on PATH on a Mac either: a browser is an application
        // bundle, and the executable is inside it.
        let mut out = vec![];
        for (bundle, exe) in [
            ("Google Chrome.app", "Google Chrome"),
            ("Chromium.app", "Chromium"),
            ("Brave Browser.app", "Brave Browser"),
            ("Microsoft Edge.app", "Microsoft Edge"),
        ] {
            for app in app_bundles(bundle) {
                let p = app.join("Contents/MacOS").join(exe);
                if p.is_file() {
                    out.push(p.to_string_lossy().into_owned());
                }
            }
        }
        out
    } else {
        [
            "chromium",
            "chromium-browser",
            "google-chrome",
            "brave-browser",
            "microsoft-edge",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }
}

/// Where a macOS application bundle of that name would be, whether or not it
/// is: `/Applications` and the user's own. Empty anywhere else, so a caller
/// needs no `#[cfg]` of its own.
pub fn app_bundles(name: &str) -> Vec<std::path::PathBuf> {
    if cfg!(not(target_os = "macos")) {
        return vec![];
    }
    let mut out = vec![std::path::PathBuf::from("/Applications").join(name)];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Applications").join(name));
    }
    out.into_iter().filter(|p| p.is_dir()).collect()
}

/// Open the machine's own terminal, with its working directory set.
///
/// snyvi passes no command. That is the whole of why this exists and an
/// embedded terminal does not: the only input is a directory snyvi already
/// holds, nothing a document contains reaches a command line, and nothing comes
/// back -- output goes to the terminal, which snyvi neither reads nor renders.
/// `docs/TERMINAL.md` has the argument.
///
/// Guarded by `has_display`, so a daemon reached over ssh declines rather than
/// failing: this is the same question as opening a window, and gets the same
/// answer. Best effort otherwise, exactly like `app_mode_browsers` -- the
/// candidates are tried in order and the first one that starts wins, since a
/// program that is not installed is a spawn that returns Err rather than
/// something to go looking for first.
///
/// The working directory is set on the child as well as passed as a flag. The
/// flag is what a terminal reads when it hands the directory to a server it
/// talks to rather than opening the window itself; the child's own directory is
/// what a terminal that takes no flag uses. Neither covers the list alone.
pub fn open_terminal(dir: &std::path::Path) -> bool {
    if !has_display() {
        return false;
    }
    for args in terminals(dir) {
        let Some((program, rest)) = args.split_first() else {
            continue;
        };
        let mut cmd = Command::new(program);
        cmd.args(rest)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        if cmd.spawn().is_ok() {
            return true;
        }
    }
    false
}

/// Ask the desktop for a folder, with its own dialog, and wait for the answer.
///
/// `Ok(None)` is the reader closing the dialog; `Err` is a desktop with no
/// dialog to show. The dialog is the desktop's and not the page's, so the path
/// comes from the reader's own hand in a trusted window -- nothing a page
/// sends ever names a directory. Blocking: call it off the async runtime.
pub fn pick_folder() -> Result<Option<std::path::PathBuf>, String> {
    let title = "Open a folder in snyvi";
    #[cfg(target_os = "macos")]
    let tries: Vec<Vec<String>> = vec![vec![
        "osascript".into(),
        "-e".into(),
        format!("POSIX path of (choose folder with prompt \"{title}\")"),
    ]];
    #[cfg(target_os = "windows")]
    let tries: Vec<Vec<String>> = vec![vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-STA".into(),
        "-Command".into(),
        format!(
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '{}'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') {{ $d.SelectedPath }}",
            ps_quote(title)
        ),
    ]];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let tries: Vec<Vec<String>> = {
        if !has_display() {
            return Err("there is no display to show a folder dialog on".into());
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        vec![
            vec![
                "zenity".into(),
                "--file-selection".into(),
                "--directory".into(),
                format!("--title={title}"),
            ],
            vec![
                "kdialog".into(),
                "--getexistingdirectory".into(),
                home,
                "--title".into(),
                title.into(),
            ],
            vec![
                "yad".into(),
                "--file".into(),
                "--directory".into(),
                format!("--title={title}"),
            ],
        ]
    };
    for args in tries {
        let Some((program, rest)) = args.split_first() else {
            continue;
        };
        let mut cmd = Command::new(program);
        cmd.args(rest).stdin(Stdio::null()).stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Not installed: the next one. Anything else is the dialog's answer.
        let Ok(out) = cmd.output() else {
            continue;
        };
        let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Every one of them answers a cancel with a non-zero exit and nothing
        // on stdout, and a choice with the path on a line of its own.
        return Ok((out.status.success() && !picked.is_empty()).then(|| picked.into()));
    }
    Err(if cfg!(target_os = "linux") {
        "no folder dialog is installed: zenity or kdialog would give one".into()
    } else {
        "the desktop's folder dialog could not be started".into()
    })
}

/// The terminals to try, in order, with the argument each one takes for a
/// working directory -- which is not uniform, so the flag travels with the name
/// rather than being assumed.
///
/// `$TERMINAL` is honoured first and passed no flag at all, because the whole
/// point of it is that snyvi does not know which program it names. It is also
/// often unset exactly where it would be most useful: the daemon is started by
/// the reader's first `snyvi send`, or by `systemd --user` at login, and neither
/// carries much of an environment. The list below is not a fallback for the
/// unusual machine, it is the path that runs on the ordinary one.
fn terminals(dir: &std::path::Path) -> Vec<Vec<String>> {
    let d = dir.to_string_lossy().into_owned();
    let mut out: Vec<Vec<String>> = vec![];
    let _ = &d;
    #[cfg(target_os = "windows")]
    {
        // Windows Terminal ships with Windows 11 and is the one most likely to
        // be wanted; a console by way of `start` is what is there when it is
        // not. The empty argument after `start` is the window title, which it
        // would otherwise take from the program name that follows.
        out.push(vec!["wt.exe".into(), "-d".into(), d.clone()]);
        out.push(vec![
            "cmd.exe".into(),
            "/C".into(),
            "start".into(),
            String::new(),
            "cmd.exe".into(),
        ]);
    }
    #[cfg(target_os = "macos")]
    out.push(vec![
        "open".into(),
        "-a".into(),
        "Terminal".into(),
        d.clone(),
    ]);
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(t) = std::env::var_os("TERMINAL") {
            let t = t.to_string_lossy().into_owned();
            if !t.trim().is_empty() {
                out.push(vec![t]);
            }
        }
        for (name, flag) in [
            ("gnome-terminal", Some("--working-directory")),
            ("konsole", Some("--workdir")),
            ("xfce4-terminal", Some("--working-directory")),
            ("alacritty", Some("--working-directory")),
            ("kitty", Some("--directory")),
            ("foot", Some("--working-directory")),
            ("ptyxis", Some("--working-directory")),
            // wezterm wants a subcommand before it will take a directory.
            ("wezterm", None),
            // Debian's alternative is a symlink to any of the above and so
            // takes none of their flags. It inherits the directory instead.
            ("x-terminal-emulator", None),
        ] {
            let mut argv = vec![name.to_string()];
            if name == "wezterm" {
                argv.extend(["start".to_string(), "--cwd".to_string(), d.clone()]);
            } else if let Some(f) = flag {
                argv.extend([f.to_string(), d.clone()]);
            }
            out.push(argv);
        }
    }
    out
}

/// Run a program that might be installed as a shell script rather than an
/// executable.
///
/// npm puts its command-line tools on Windows behind a .cmd shim, and
/// CreateProcess only ever appends .exe, so spawning `claude` by name finds
/// nothing at all. Going through cmd is what the shell does on the user's
/// behalf when they type the same word.
pub fn shim(name: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(name);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    Command::new(name)
}

/// Whether a notification asks the desktop for a sound.
///
/// Off unless asked, with `SNYVI_SOUND=1`. A sound is the one signal a reader
/// cannot decline by not looking, and it is only ever raised on a
/// notification, which is only ever raised when no snyvi page has focus. An
/// agent writing twelve files is twelve notifications, so a burst sounds
/// once: `Asked` at most every two seconds, `Declined` for the rest.
/// `SNYVI_SOUND=0` declines every time, which matters on Windows, where a
/// toast sounds unless told not to; unset, `Unsaid` leaves each desktop to
/// its own default -- none on the free desktops and macOS, one on Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sound {
    Asked,
    Declined,
    Unsaid,
}

const BURST: std::time::Duration = std::time::Duration::from_secs(2);

fn sound() -> Sound {
    static LAST: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let want = match std::env::var("SNYVI_SOUND").as_deref() {
        Ok("1") | Ok("true") | Ok("yes") => Some(true),
        Ok("0") | Ok("false") | Ok("no") | Ok("") => Some(false),
        _ => None,
    };
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    sound_for(want, &mut last, std::time::Instant::now())
}

/// The decision, apart from the clock and the environment so it can be tested.
fn sound_for(
    want: Option<bool>,
    last: &mut Option<std::time::Instant>,
    now: std::time::Instant,
) -> Sound {
    match want {
        None => Sound::Unsaid,
        Some(false) => Sound::Declined,
        Some(true) => {
            if last.is_some_and(|t| now.duration_since(t) < BURST) {
                Sound::Declined
            } else {
                *last = Some(now);
                Sound::Asked
            }
        }
    }
}

/// Raise a desktop notification. Best effort and never blocking: a machine
/// with no notification daemon is not an error, it is a machine that will not
/// show one. `sound` is decided by the caller, once per notification.
#[allow(unused_variables)]
fn notify_with(title: &str, body: &str, sound: Sound) {
    #[cfg(target_os = "windows")]
    {
        // PowerShell holds the only toast API reachable without a dependency
        // or a registered application id. Borrowing PowerShell's own id is
        // what every script that does this does; the cost is that the toast
        // is attributed to it.
        //
        // Template 5 is ToastText02: a bold first line and a wrapped second,
        // which is the shape of every notification snyvi raises. The
        // image-and-text templates want an image element to fill in.
        let script = format!(
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;\
             $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(5);\
             $t = $x.GetElementsByTagName('text');\
             $t.Item(0).AppendChild($x.CreateTextNode('{}')) > $null;\
             $t.Item(1).AppendChild($x.CreateTextNode('{}')) > $null;{}\
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
            ps_quote(title),
            ps_quote(body),
            // A toast sounds by default; declining is an element that says not to.
            if sound == Sound::Declined {
                "$a = $x.CreateElement('audio'); $a.SetAttribute('silent', 'true'); $x.DocumentElement.AppendChild($a) > $null;"
            } else {
                ""
            },
        );
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"{}",
            body.replace('\\', "\\\\").replace('"', "\\\""),
            title.replace('\\', "\\\\").replace('"', "\\\""),
            if sound == Sound::Asked {
                " sound name \"Glass\""
            } else {
                ""
            },
        );
        let _ = Command::new("osascript")
            .args(["-e", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = Command::new("notify-send")
            .args(["-a", "snyvi", "-i", "snyvi"])
            .args(sound_hint(sound))
            .args([title, body])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// Raise a notification that opens something when it is clicked.
///
/// `open` runs on a thread of its own when the person clicks; it is dropped
/// unrun when they do not, or when the desktop cannot carry an action at all,
/// in which case this is exactly `notify`.
///
/// Only the free desktops can do this without a dependency: `notify-send -A`
/// waits for the click and prints the action back. Windows wants a registered
/// application id and a protocol handler to be clicked at all, and macOS's
/// `display notification` has no action, so both raise the plain notification
/// they raised before.
///
/// One notification at a time carries an action, and a new one replaces it.
/// The alternative is a waiting `notify-send` per arrival -- an agent writing
/// twelve files would leave twelve -- and the one worth clicking is the newest
/// anyway, with the queue in the sidebar holding the rest.
pub fn notify_open(title: &str, body: &str, open: impl FnOnce() + Send + 'static) {
    // Decided once: the fallback below must not ask again and find the burst
    // already spent by this very notification.
    let sound = sound();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if notify_send_takes_actions() {
            let mut child = match Command::new("notify-send")
                .args([
                    "-a",
                    "snyvi",
                    "-i",
                    "snyvi",
                    "-A",
                    "default=Open",
                    "-t",
                    "20000",
                ])
                .args(sound_hint(sound))
                .args([title, body])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => {
                    notify_with(title, body, sound);
                    return;
                }
            };
            let out = child.stdout.take();
            let id = child.id();
            // Replacing the last one, which is also what reaps it: the reader
            // thread below only waits on a child still in this slot, so a
            // process is ended and collected in exactly one place.
            if let Some(mut old) = replace_clickable(Some(child)) {
                let _ = old.kill();
                let _ = old.wait();
            }
            std::thread::spawn(move || {
                use std::io::Read;
                let mut said = String::new();
                if let Some(mut out) = out {
                    let _ = out.read_to_string(&mut said);
                }
                if let Some(mut mine) = take_clickable(id) {
                    let _ = mine.wait();
                }
                if said.trim() == "default" {
                    open();
                }
            });
            return;
        }
    }
    let _ = &open;
    notify_with(title, body, sound);
}

/// The freedesktop `sound-name` hint, which the daemons that play sounds
/// honour and the rest ignore. Nothing when a sound was not asked for.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn sound_hint(sound: Sound) -> &'static [&'static str] {
    if sound == Sound::Asked {
        &["-h", "string:sound-name:message-new-instant"]
    } else {
        &[]
    }
}

/// The one notification that is waiting to be clicked, if there is one.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
static CLICKABLE: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn replace_clickable(next: Option<std::process::Child>) -> Option<std::process::Child> {
    let mut slot = CLICKABLE.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::replace(&mut slot, next)
}

/// Take the child back only if the slot still holds this one: a newer
/// notification has already ended and collected it otherwise.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn take_clickable(id: u32) -> Option<std::process::Child> {
    let mut slot = CLICKABLE.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().map(std::process::Child::id) == Some(id) {
        slot.take()
    } else {
        None
    }
}

/// Whether this machine's notify-send can carry an action. libnotify grew
/// `--action` in 0.7.9; older ones fail the whole call when handed one, which
/// would trade a notification that cannot be clicked for no notification.
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn notify_send_takes_actions() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| {
        Command::new("notify-send")
            .arg("--help")
            .output()
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout).into_owned()
                    + &String::from_utf8_lossy(&o.stderr);
                text.contains("--action")
            })
            .unwrap_or(false)
    })
}

/// Single-quote a string for PowerShell, where doubling the quote escapes it.
#[cfg(target_os = "windows")]
fn ps_quote(s: &str) -> String {
    s.replace('\'', "''").replace(['\n', '\r'], " ")
}

/// End a process. `force` is the second ask, after a polite one was ignored.
pub fn terminate(pid: u32, force: bool) {
    #[cfg(target_os = "windows")]
    {
        // Windows has no SIGTERM. `taskkill` without /F posts WM_CLOSE, which
        // a console process ignores, so the polite ask is the shutdown
        // endpoint the caller already tried and this is only ever the forceful
        // one -- but the shape is kept so the caller reads the same everywhere.
        let mut cmd = Command::new("taskkill");
        cmd.arg("/PID").arg(pid.to_string());
        if force {
            cmd.arg("/F");
        }
        let _ = cmd
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Via kill(1), so no libc dependency is needed.
        let _ = Command::new("kill")
            .arg(if force { "-KILL" } else { "-TERM" })
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Start the daemon so that it outlives this process and holds nothing of it.
///
/// On Unix that is a process group of its own. The three streams go to
/// /dev/null and every other descriptor is closed across exec, because Rust
/// opens them close-on-exec.
///
/// Windows has no such default, and this is the whole reason the spawn is
/// written out by hand. CreateProcess inherits either every inheritable handle
/// or none at all, and `std`'s Command always asks for every one. So a daemon
/// started by `url=$(snyvi send FILE)` inherited the write end of that command
/// substitution's pipe and held it for the rest of its life: `send` returned in
/// milliseconds, and the shell then waited forever for an end of file that the
/// daemon alone was keeping from arriving.
///
/// Nothing the daemon does needs a handle from whoever started it, so it is
/// created inheriting none -- which also leaves it without standard streams,
/// and a write to a stdout or stderr that a process does not have is a write
/// that goes nowhere rather than an error.
pub fn spawn_daemon(exe: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
            PROCESS_INFORMATION, STARTUPINFOW,
        };

        // CreateProcessW parses the command line itself, and writes into the
        // buffer while doing it, so it is built here rather than passed as
        // arguments. The quote is dropped from the path rather than escaped:
        // a Windows path cannot contain one, so anything that does is not the
        // executable this process is running as.
        let mut line: Vec<u16> = vec![b'"' as u16];
        line.extend(exe.as_os_str().encode_wide().filter(|c| *c != b'"' as u16));
        line.push(b'"' as u16);
        line.extend(" serve".encode_utf16());
        line.push(0);

        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the command line is NUL-terminated and outlives the call,
        // the two structures are the sizes the call is told they are, and
        // every pointer that may be null is one the call documents as
        // optional -- no application name, default security, the parent's
        // environment, the parent's working directory.
        let started = unsafe {
            CreateProcessW(
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0, // FALSE: inherit nothing. The point of all of this.
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
                std::ptr::null(),
                std::ptr::null(),
                &si,
                &mut pi,
            )
        };
        if started == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // Nothing here waits for the daemon; these two handles are this
        // process's own references to it, and releasing them does not end it.
        unsafe {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(exe);
        cmd.arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.spawn()?;
        Ok(())
    }
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(test)]
mod tests {
    use super::{sound_for, terminals, Sound};
    use std::path::Path;

    /// The property the whole feature rests on, stated so it cannot quietly
    /// stop being true: snyvi hands a terminal a directory, and never anything
    /// a shell could run. A candidate that grew an `-e` or a `--command` would
    /// turn "open a terminal here" into the executor that `docs/TERMINAL.md`
    /// declines.
    ///
    /// The directory has a space in it, so a candidate that had taken to
    /// building a command line out of it rather than passing it as one
    /// argument would fail here rather than on someone's machine.
    #[test]
    fn a_terminal_is_asked_for_a_directory_and_never_for_a_command() {
        let dir = Path::new("/tmp/a folder");
        let candidates = terminals(dir);
        assert!(!candidates.is_empty(), "no terminal is ever tried");
        for argv in &candidates {
            let (_program, rest) = argv.split_first().expect("a candidate with no program");
            for arg in rest {
                let allowed = arg.starts_with('-')      // a flag
                    || arg.starts_with('/')             // a flag, on Windows
                    || arg.is_empty()                   // `start`'s window title
                    || arg == "start"                   // wezterm's and cmd's subcommand
                    || arg == "cmd.exe"                 // what `start` is asked to start
                    || arg == "Terminal"                // what `open -a` is asked to open
                    || *arg == dir.to_string_lossy();
                assert!(
                    allowed,
                    "{argv:?} passes {arg:?}, which is neither a flag nor the directory"
                );
            }
        }
    }

    /// A burst of arrivals is one sound. Twelve files from an agent are twelve
    /// notifications, and the reader who asked for a sound asked to be told,
    /// not told twelve times.
    #[test]
    fn a_burst_sounds_once_and_only_when_asked() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut last = None;
        assert_eq!(sound_for(None, &mut last, t0), Sound::Unsaid);
        assert_eq!(sound_for(Some(false), &mut last, t0), Sound::Declined);
        assert!(
            last.is_none(),
            "declining or saying nothing spent the burst"
        );
        assert_eq!(sound_for(Some(true), &mut last, t0), Sound::Asked);
        for ms in [1, 500, 1999] {
            assert_eq!(
                sound_for(Some(true), &mut last, t0 + Duration::from_millis(ms)),
                Sound::Declined,
                "a second sound {ms} ms into the burst"
            );
        }
        assert_eq!(
            sound_for(Some(true), &mut last, t0 + Duration::from_millis(2000)),
            Sound::Asked
        );
    }

    /// Every candidate has to be told the directory one way or another: by a
    /// flag, or by inheriting the working directory `open_terminal` sets on the
    /// child. The second is invisible here, so this only checks that a
    /// candidate carrying a flag carries the directory with it.
    #[test]
    fn a_flag_never_arrives_without_the_directory_it_is_for() {
        let dir = Path::new("/tmp/a folder");
        for argv in terminals(dir) {
            let takes_dir = argv.iter().any(|a| *a == dir.to_string_lossy());
            let has_flag = argv[1..].iter().any(|a| a.starts_with('-'));
            assert!(
                !has_flag || takes_dir,
                "{argv:?} passes a flag but never the directory"
            );
        }
    }
}

/// Hand the memory a large render just freed back to the operating system.
///
/// glibc keeps freed memory in its pools and returns it on a schedule of its
/// own, so after the same 1 MB and 100k-line sends one daemon settled at 54 MB
/// and the next, same binary and same files, at 93 -- depending only on which
/// threads the render had run on and when they retired. The bench's settled
/// row read that coin flip, and so does a reader who sent one big file and
/// left the daemon running. Called after a render big enough to matter, never
/// on the small sends an agent makes all day: a trim walks every pool.
///
/// glibc only. musl, which the static Linux release is built with, returns
/// large frees at once and has no such call; macOS and Windows have their own
/// allocators. Everywhere else this does nothing.
pub fn release_freed_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        extern "C" {
            fn malloc_trim(pad: usize) -> std::os::raw::c_int;
        }
        // SAFETY: malloc_trim takes no pointers and only returns free pages;
        // it is safe to call from any thread at any time.
        unsafe {
            malloc_trim(0);
        }
    }
}
