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

/// Show a folder in the desktop's file manager.
///
/// On Windows that is Explorer by name, with the path as its argument, rather
/// than `open_url`'s `cmd /C start`: a command line for cmd would read a `%`
/// or a `^` in a folder's name as its own. Elsewhere the link opener already
/// does it -- `xdg-open` and `open` show a directory in the file manager.
pub fn open_folder(dir: &std::path::Path) -> bool {
    // Explorer does not open a `\\?\` path as the folder it names.
    let dir = dunce::simplified(dir);
    #[cfg(target_os = "windows")]
    {
        return Command::new("explorer")
            .arg(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        open_url(&dir.to_string_lossy())
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

/// Ask the desktop for a folder, with its own dialog, and wait for the answer.
///
/// `Ok(None)` is the reader closing the dialog; `Err` is a desktop with no
/// dialog to show. The dialog is the desktop's and not the page's, so the path
/// comes from the reader's own hand in a trusted window -- nothing a page
/// sends ever names a directory.
///
/// The dialog lives as long as the asking does, and no longer: dropping this
/// future -- the page reloaded, the window closed -- ends the dialog's process,
/// as do `cancel` and [`PICK_TIMEOUT`]. A dialog nobody is waiting on stays
/// on the screen with no window to come back to, and the next one piles on it.
pub async fn pick_folder(
    cancel: &tokio::sync::Notify,
) -> Result<Option<std::path::PathBuf>, String> {
    let title = "Open a folder in snyvi";
    #[cfg(target_os = "macos")]
    let tries: Vec<Vec<String>> = vec![vec![
        "osascript".into(),
        "-e".into(),
        format!("POSIX path of (choose folder with prompt \"{title}\")"),
    ]];
    // Explorer's own folder dialog, owned by a topmost form so it opens in
    // front of snyvi: src/pick_folder.ps1 says how. Encoded, because the
    // script quotes C# and a command line would have to quote it again.
    #[cfg(target_os = "windows")]
    let tries: Vec<Vec<String>> = vec![vec![
        "powershell".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-STA".into(),
        "-EncodedCommand".into(),
        encoded_command(&PICK_FOLDER_PS1.replace("@TITLE@", &ps_quote(title))),
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
    if let Some(answer) = ask_folder(tries, cancel, PICK_TIMEOUT, |_| {}).await {
        return answer;
    }
    Err(if cfg!(target_os = "linux") {
        "no folder dialog is installed: zenity or kdialog would give one".into()
    } else {
        "the desktop's folder dialog could not be started".into()
    })
}

/// The Windows folder dialog's script, with `@TITLE@` for its title.
#[cfg(target_os = "windows")]
const PICK_FOLDER_PS1: &str = include_str!("pick_folder.ps1");

/// A script as `powershell -EncodedCommand` takes it: UTF-16LE, in base64.
/// Written out rather than taken as a dependency; it is a dozen lines.
#[cfg_attr(not(windows), allow(dead_code))]
fn encoded_command(script: &str) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                B64[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// How long a folder dialog may stay open before snyvi gives up on it. Long:
/// it only clears away a dialog forgotten or never seen -- Cancel and closing
/// the window end one at once -- and a short one would close the dialog on a
/// reader still looking through a large drive.
pub const PICK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The first of `tries` that starts, and its answer: `None` when none of them
/// could be started. `spawned` is told the dialog's process id, for the tests.
async fn ask_folder(
    tries: Vec<Vec<String>>,
    cancel: &tokio::sync::Notify,
    timeout: std::time::Duration,
    spawned: impl FnOnce(u32),
) -> Option<Result<Option<std::path::PathBuf>, String>> {
    let mut spawned = Some(spawned);
    for args in tries {
        let Some((program, rest)) = args.split_first() else {
            continue;
        };
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(rest)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // The dialog is this process's: ending it closes the dialog,
            // and there is no grandchild left behind.
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Not installed: the next one. Anything else is the dialog's answer.
        let Ok(child) = cmd.spawn() else {
            continue;
        };
        if let (Some(f), Some(pid)) = (spawned.take(), child.id()) {
            f(pid);
        }
        // Each of the other two drops the child, which kills it.
        let out = tokio::select! {
            r = child.wait_with_output() => r,
            _ = tokio::time::sleep(timeout) => return Some(Ok(None)),
            _ = cancel.notified() => return Some(Ok(None)),
        };
        let Ok(out) = out else {
            return Some(Ok(None));
        };
        let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // Every one of them answers a cancel with a non-zero exit and nothing
        // on stdout, and a choice with the path on a line of its own.
        return Some(Ok(
            (out.status.success() && !picked.is_empty()).then(|| picked.into())
        ));
    }
    None
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
///
/// Where there are standard streams to give (not Windows, for the reason
/// above), the daemon's go to `daemon.log` beside the store, appended to:
/// a restart that went wrong is otherwise a daemon that says why to
/// nobody. Over `DAEMON_LOG_MAX` it is moved to `daemon.log.1` first.
pub fn spawn_daemon(exe: &std::path::Path) -> std::io::Result<()> {
    #[cfg(not(windows))]
    {
        if let Some(log) = open_daemon_log(&crate::config::paths().data_dir) {
            let err = log.try_clone()?;
            let mut cmd = Command::new(exe);
            cmd.arg("serve")
                .stdin(Stdio::null())
                .stdout(Stdio::from(log))
                .stderr(Stdio::from(err));
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0);
            }
            cmd.spawn()?;
            return Ok(());
        }
    }
    spawn_detached(exe, &["serve"])
}

#[cfg(not(windows))]
const DAEMON_LOG_MAX: u64 = 1 << 20;

/// Where a daemon started by snyvi writes what it says. `snyvi status`
/// names it.
pub fn daemon_log(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("daemon.log")
}

#[cfg(not(windows))]
fn open_daemon_log(data_dir: &std::path::Path) -> Option<std::fs::File> {
    let path = daemon_log(data_dir);
    std::fs::create_dir_all(data_dir).ok()?;
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > DAEMON_LOG_MAX) {
        let _ = std::fs::rename(&path, data_dir.join("daemon.log.1"));
    }
    let mut o = std::fs::OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(&path).ok()
}

/// The same detached start for any of snyvi's own commands: `serve`, `app`
/// when the daemon relaunches the window after an update, `--quit` handed
/// to the window binary. Arguments are plain words, never paths.
pub fn spawn_detached(exe: &std::path::Path, args: &[&str]) -> std::io::Result<()> {
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
        for a in args {
            line.push(b' ' as u16);
            line.extend(a.encode_utf16());
        }
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
        cmd.args(args)
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
/// What the calling thread's heap freed goes back to the system now. The
/// allocator is mimalloc on every platform (main.rs), and a pool thread that
/// rendered a document keeps the pages it freed until it allocates again or
/// retires -- and a retired thread's pages wait for another thread to take
/// them over, which in an idle daemon is never. So the 1.8.0 candidate's
/// settled row read 50 MB on one run and 69 on the next, the same binary and
/// files, by which thread the render had landed on; with this, 25-33 every
/// time. Called on the render thread itself, as its last act: it collects
/// that thread's heap and nothing else, and costs a send no measurable time.
pub fn release_thread_memory() {
    // SAFETY: mi_collect takes no pointers; it frees only memory this
    // thread's heap no longer uses, and is safe on any thread at any time.
    unsafe { libmimalloc_sys::mi_collect(true) }
}

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

#[cfg(test)]
mod tests {
    use super::{sound_for, Sound};

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
}

/// The folder dialog's lifetime, with a program that waits in its place: no
/// test can click a real dialog, but every way of ending one ends a process.
#[cfg(test)]
mod pick_tests {
    use super::ask_folder;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};
    use tokio::sync::Notify;

    /// A "dialog" that stays open for ten minutes and never answers.
    fn stays_open() -> Vec<Vec<String>> {
        let argv: &[&str] = if cfg!(windows) {
            &["powershell", "-NoProfile", "-Command", "Start-Sleep 600"]
        } else {
            &["sleep", "600"]
        };
        vec![argv.iter().map(|s| s.to_string()).collect()]
    }

    /// A "dialog" the reader answered at once.
    fn answers(path: &str) -> Vec<Vec<String>> {
        let argv: Vec<String> = if cfg!(windows) {
            vec!["cmd".into(), "/C".into(), format!("echo {path}")]
        } else {
            vec!["echo".into(), path.into()]
        };
        vec![argv]
    }

    fn alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .expect("tasklist runs");
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        } else {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status()
                .is_ok_and(|s| s.success())
        }
    }

    /// Ending a process is not instant everywhere: a second to be gone.
    /// Waited on the runtime, not the thread: tokio reaps a child it killed
    /// on a later turn, and until then `kill -0` still finds the zombie.
    async fn gone_soon(pid: u32) -> bool {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn a_dialog_nobody_waits_on_is_closed() {
        let pid = AtomicU32::new(0);
        let cancel = Notify::new();
        let asking = ask_folder(stays_open(), &cancel, Duration::from_secs(600), |p| {
            pid.store(p, Ordering::SeqCst)
        });
        // The page reloads while the dialog is up: the request, and with it
        // this future, is dropped.
        let _ = tokio::time::timeout(Duration::from_millis(1500), asking).await;
        let pid = pid.load(Ordering::SeqCst);
        assert_ne!(pid, 0, "the dialog started");
        assert!(
            gone_soon(pid).await,
            "the dialog's process outlived the asking"
        );
    }

    #[tokio::test]
    async fn cancel_closes_the_dialog() {
        let pid = AtomicU32::new(0);
        let cancel = Notify::new();
        let asking = ask_folder(stays_open(), &cancel, Duration::from_secs(600), |p| {
            pid.store(p, Ordering::SeqCst)
        });
        let started = Instant::now();
        let (answer, ()) = tokio::join!(asking, async {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            cancel.notify_waiters();
        });
        assert!(matches!(answer, Some(Ok(None))), "a cancel is no choice");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancel ends it at once"
        );
        assert!(gone_soon(pid.load(Ordering::SeqCst)).await);
    }

    #[tokio::test]
    async fn a_dialog_left_open_is_given_up_on() {
        let pid = AtomicU32::new(0);
        let cancel = Notify::new();
        let answer = ask_folder(stays_open(), &cancel, Duration::from_millis(1500), |p| {
            pid.store(p, Ordering::SeqCst)
        })
        .await;
        assert!(matches!(answer, Some(Ok(None))));
        assert!(gone_soon(pid.load(Ordering::SeqCst)).await);
    }

    #[tokio::test]
    async fn a_cancel_with_no_dialog_open_is_not_kept_for_the_next() {
        let cancel = Notify::new();
        cancel.notify_waiters();
        let picked = if cfg!(windows) {
            r"C:\picked"
        } else {
            "/picked"
        };
        let answer = ask_folder(answers(picked), &cancel, Duration::from_secs(60), |_| {}).await;
        assert_eq!(
            answer.unwrap().unwrap().as_deref(),
            Some(std::path::Path::new(picked))
        );
    }

    #[tokio::test]
    async fn a_dialog_that_is_not_installed_is_the_next_ones_turn() {
        let cancel = Notify::new();
        let mut tries = vec![vec!["snyvi-no-such-dialog".to_string()]];
        tries.extend(answers(if cfg!(windows) { r"C:\b" } else { "/b" }));
        let answer = ask_folder(tries, &cancel, Duration::from_secs(60), |_| {}).await;
        assert!(matches!(answer, Some(Ok(Some(_)))));
        let none = ask_folder(
            vec![vec!["snyvi-no-such-dialog".into()]],
            &cancel,
            Duration::from_secs(60),
            |_| {},
        )
        .await;
        assert!(none.is_none());
    }
}

#[cfg(test)]
mod encoded_tests {
    use super::encoded_command;

    #[test]
    fn a_script_is_base64_of_its_utf16() {
        assert_eq!(encoded_command(""), "");
        assert_eq!(encoded_command("a"), "YQA=");
        assert_eq!(encoded_command("Hi"), "SABpAA==");
        assert_eq!(encoded_command("abc"), "YQBiAGMA");
    }

    /// What PowerShell runs is what was written, and what it prints comes
    /// back as written -- a folder's name in Hindi or with an accent too.
    #[cfg(windows)]
    #[test]
    fn powershell_runs_the_script_and_answers_in_utf8() {
        let script = r"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; 'D:\प्रोजेक्ट\café'";
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
            .arg(encoded_command(script))
            .output()
            .expect("powershell runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            r"D:\प्रोजेक्ट\café"
        );
    }

    /// The modern dialog is C# compiled as the script runs; a typo there
    /// would only ever show as the old dialog. Compiled here, shown never.
    #[cfg(windows)]
    #[test]
    fn the_folder_dialogs_csharp_compiles() {
        let ps1 = super::PICK_FOLDER_PS1;
        let from = ps1
            .find("Add-Type -TypeDefinition @'")
            .expect("the C# is there");
        let to = ps1[from..].find("\n'@").expect("and ends") + from + 3;
        let script = format!(
            "$ErrorActionPreference = 'Stop'; {}; [SnyviFolderDialog].Name",
            &ps1[from..to]
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
            .arg(encoded_command(&script))
            .output()
            .expect("powershell runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "SnyviFolderDialog",
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
