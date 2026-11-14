//! A routine's gate and its watch's ground (1.63, plan d621276291 step 2):
//! the commands the reader allowed beside a routine, run as a widget's
//! command is, never as a panel is (R7).
//!
//! What it holds to:
//!
//! - **A cleared environment.** PATH (the routine's scripts folder first,
//!   then the login shell's), the reader's home, user and language, an ssh
//!   agent when the daemon has one, and only the desk's keys its lines or
//!   scripts name (`api_routine::key_names`). Never the token, the Claude
//!   account's, or the mod's folder, which a panel's environment carries.
//! - **Capped and timed.** 4 KB of stdout read, a minute at most, and the
//!   whole process group ended past it.
//! - **The gate answers only the clock** (C2). Exit 0 runs, 1 is a quiet
//!   run with no panel, anything else is a failed gate on the row. Its
//!   stdout lines go to the routine's events, in its shape.

use super::*;
use crate::routine::{self, places, Routine};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// The most a gate prints that is read.
pub(crate) const OUT_MAX: u64 = 4096;
/// The longest a gate runs.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Failed gates in a row before the reader is told on On you.
const FAILS_TO_CARD: i64 = 3;

/// Where a routine's gate and watch run, and with what.
pub(crate) struct Ground {
    pub cwd: PathBuf,
    /// The scripts folder, first on PATH (`places::scripts`).
    pub dir: Option<PathBuf>,
    pub keys: Vec<(String, String)>,
    /// 1.66: `SNYVI_STATE`, the routine's own folder for what its scripts
    /// remember (`state_dir`).
    pub state: PathBuf,
}

/// A routine's own state folder (1.66): `<data>/routines/<id>/state`, made
/// when first asked for. Two routines on one scripts folder shared its
/// `state/` -- `pro-forum` #22 and #23 wrote one cursor file -- so each has
/// its own now, passed as `SNYVI_STATE` to its watch, gate and runs. The
/// first time, what the shared `state/` held is copied in, so a cursor is
/// not lost: the scripts read the new folder from then on.
pub(crate) fn state_dir(data_dir: &Path, r: &Routine, scripts: Option<&Path>) -> PathBuf {
    let d = data_dir
        .join("routines")
        .join(r.id.to_string())
        .join("state");
    if !d.is_dir() {
        let _ = std::fs::create_dir_all(&d);
        if let Some(old) = scripts.map(|s| s.join(places::STATE)) {
            if let Ok(rd) = std::fs::read_dir(&old) {
                for e in rd.flatten() {
                    if e.file_type().is_ok_and(|t| t.is_file()) {
                        let _ = std::fs::copy(e.path(), d.join(e.file_name()));
                    }
                }
            }
        }
    }
    d
}

/// The routine's command place, as it was allowed.
fn place_of(root: &Path, r: &Routine) -> Option<places::Place> {
    if r.words() {
        return None;
    }
    places::from_file(root, &r.file)
}

/// The ground for a routine on its desk: its folder, its scripts, the keys
/// its lines and scripts name. Read on a blocking thread: it reads files.
pub(crate) async fn ground(app: &App, r: &Routine, desk: &crate::desk::Desk) -> Ground {
    let root = PathBuf::from(&desk.root);
    let rr = r.clone();
    let (dir, names) = tokio::task::spawn_blocking(move || {
        let p = place_of(&root, &rr);
        let dir = p.as_ref().and_then(|p| places::scripts(p, &rr.cmd));
        let mut text = format!("{}\n{}\n", rr.gate, rr.watch);
        if let Some(p) = &p {
            text.push_str(&places::scripts_text(p, &rr.cmd));
        }
        (dir, super::api_routine::key_names(&text))
    })
    .await
    .unwrap_or((None, Vec::new()));
    let wanted: Vec<_> = app
        .store
        .desk_keys(desk.id)
        .unwrap_or_default()
        .into_iter()
        .filter(|k| names.contains(&k.name))
        .collect();
    let keys = if wanted.is_empty() {
        Vec::new()
    } else {
        let secrets = app.secrets.clone();
        tokio::task::spawn_blocking(move || secrets.values(&wanted))
            .await
            .unwrap_or_default()
    };
    let state = state_dir(&app.paths.data_dir, r, dir.as_deref());
    Ground {
        cwd: PathBuf::from(&desk.root),
        state,
        dir,
        keys,
    }
}

/// A routine's line as a shell command on its ground, with `extra`
/// variables of snyvi's own (`SNYVI_ROUTINE`, `SNYVI_LAST_EVENT`).
pub(crate) fn command(line: &str, g: &Ground, extra: &[(&str, String)]) -> tokio::process::Command {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let login = super::widget_run::path_now();
    let path = match &g.dir {
        Some(d) if login.is_empty() => d.to_string_lossy().to_string(),
        Some(d) => format!("{}{sep}{login}", d.to_string_lossy()),
        None => login,
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.raw_arg("/C").raw_arg(line);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(line);
        c
    };
    cmd.current_dir(&g.cwd)
        .env_clear()
        .env("PATH", &path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    for k in [
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "SSH_AUTH_SOCK",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    if let Some(d) = &g.dir {
        cmd.env("SNYVI_ROUTINE_DIR", d);
    }
    cmd.env("SNYVI_STATE", &g.state);
    for (k, v) in &g.keys {
        cmd.env(k, v);
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
    cmd
}

/// What a gate said.
#[derive(Debug, PartialEq)]
pub(crate) enum Said {
    /// Exit 0: run, with the lines it printed.
    Yes(Vec<String>),
    /// Exit 1: nothing worth a session.
    No,
    /// Anything else, in the row's words.
    Failed(String),
}

/// Read what a finished gate gives: its code, its stdout and its first
/// line of stderr.
fn said_of(code: Option<i32>, out: &[u8], err: &[u8]) -> Said {
    if out.len() as u64 > OUT_MAX {
        return Said::Failed(format!("printed more than {} KB", OUT_MAX / 1024));
    }
    let first_err = String::from_utf8_lossy(err)
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    match code {
        Some(0) => Said::Yes(
            String::from_utf8_lossy(out)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect(),
        ),
        Some(1) => Said::No,
        Some(c) if first_err.is_empty() => Said::Failed(format!("exit {c}")),
        Some(c) => Said::Failed(format!("exit {c}: {}", crate::thread::line(&first_err, 80))),
        None => Said::Failed("stopped by a signal".into()),
    }
}

/// Run a line once on its ground, to its end or `timeout`.
pub(crate) async fn run(
    line: &str,
    g: &Ground,
    extra: &[(&str, String)],
    timeout: Duration,
) -> Said {
    let mut cmd = command(line, g, extra);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Said::Failed(format!("could not start: {e}")),
    };
    let pid = child.id();
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let work = async {
        let read_out = async {
            let mut buf = Vec::new();
            if let Some(p) = out {
                let _ = AsyncReadExt::take(p, OUT_MAX + 1)
                    .read_to_end(&mut buf)
                    .await;
            }
            buf
        };
        let (o, e) = tokio::join!(read_out, super::widget_run::read_drained(err, 1024));
        (o, e, child.wait().await)
    };
    match tokio::time::timeout(timeout, work).await {
        Err(_) => {
            super::widget_run::stop_group(pid);
            Said::Failed(format!("took longer than {} s", timeout.as_secs()))
        }
        Ok((o, e, status)) => match status {
            Ok(s) => said_of(s.code(), &o, &e),
            Err(e) => Said::Failed(format!("could not wait for it: {e}")),
        },
    }
}

/// Ask a routine's gate before a clock run (C2). Its lines are pushed to
/// the routine's events, in its shape, so the run takes them.
pub(crate) async fn ask(app: &App, r: &Routine, desk: &crate::desk::Desk) -> Said {
    let g = ground(app, r, desk).await;
    let extra = [("SNYVI_ROUTINE", r.name.clone())];
    let said = run(&r.gate, &g, &extra, TIMEOUT).await;
    if let Said::Yes(lines) = &said {
        let _ = app.store.clocked(|c, now| {
            for l in lines.iter().take(routine::events::TAKE as usize) {
                routine::events::push(c, r.id, &r.shape, l, now)?;
            }
            Ok(())
        });
    }
    said
}

/// Whether the last `FAILS_TO_CARD` runs were failed gates and the one
/// before them was not: the moment to say so, once.
pub(crate) fn fails_to_card(states: &[String]) -> bool {
    let n = FAILS_TO_CARD as usize;
    states.len() >= n
        && states[..n].iter().all(|s| s.starts_with("gate failed"))
        && states.get(n).is_none_or(|s| !s.starts_with("gate failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gates_exit_says_run_quiet_or_failed() {
        assert_eq!(
            said_of(Some(0), b"tag 1\n\n tag 2 \n", b""),
            Said::Yes(vec!["tag 1".into(), "tag 2".into()])
        );
        assert_eq!(said_of(Some(1), b"", b"nothing new"), Said::No);
        assert_eq!(
            said_of(Some(2), b"", b"\nssh: connect refused\nmore"),
            Said::Failed("exit 2: ssh: connect refused".into())
        );
        assert_eq!(said_of(Some(7), b"", b""), Said::Failed("exit 7".into()));
        assert!(matches!(
            said_of(Some(0), &[b'x'; 5000], b""),
            Said::Failed(_)
        ));
    }

    #[test]
    fn three_failed_gates_in_a_row_are_said_once() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(!fails_to_card(&s(&[
            "gate failed: exit 2",
            "gate failed: exit 2"
        ])));
        assert!(fails_to_card(&s(&[
            "gate failed: a",
            "gate failed: b",
            "gate failed: c",
            "done"
        ])));
        assert!(fails_to_card(&s(&[
            "gate failed: a",
            "gate failed: b",
            "gate failed: c"
        ])));
        assert!(!fails_to_card(&s(&[
            "gate failed: a",
            "gate failed: b",
            "gate failed: c",
            "gate failed: d"
        ])));
        assert!(!fails_to_card(&s(&[
            "quiet",
            "gate failed: b",
            "gate failed: c"
        ])));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_gate_runs_with_its_scripts_first_and_nothing_of_the_daemons() {
        let dir = crate::store::tempdir::Dir::new("snyvi-routine-gate");
        let scripts = dir.path.join("scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        let f = scripts.join("gate.sh");
        std::fs::write(
            &f,
            "#!/bin/sh\necho \"tag $N\"\necho \"tok=${SNYVI_TOKEN:-none}\"\nexit 0\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        let g = Ground {
            cwd: dir.path.clone(),
            dir: Some(scripts),
            keys: vec![("N".into(), "5304".into())],
            state: dir.path.join("state"),
        };
        let said = run("gate.sh", &g, &[], Duration::from_secs(10)).await;
        assert_eq!(said, Said::Yes(vec!["tag 5304".into(), "tok=none".into()]));
        assert_eq!(
            run("exit 1", &g, &[], Duration::from_secs(10)).await,
            Said::No
        );
        let slow = run("sleep 5", &g, &[], Duration::from_millis(300)).await;
        assert!(matches!(slow, Said::Failed(w) if w.starts_with("took longer")));
    }
}
