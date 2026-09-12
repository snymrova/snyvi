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
    out.push(vec!["open".into(), "-a".into(), "Terminal".into(), d.clone()]);
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

/// Raise a desktop notification. Best effort and never blocking: a machine
/// with no notification daemon is not an error, it is a machine that will not
/// show one.
pub fn notify(title: &str, body: &str) {
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
             $t.Item(1).AppendChild($x.CreateTextNode('{}')) > $null;\
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
            ps_quote(title),
            ps_quote(body),
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
            "display notification \"{}\" with title \"{}\"",
            body.replace('\\', "\\\\").replace('"', "\\\""),
            title.replace('\\', "\\\\").replace('"', "\\\""),
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
            .args(["-a", "snyvi", "-i", "snyvi", title, body])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
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
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(test)]
mod tests {
    use super::terminals;
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
