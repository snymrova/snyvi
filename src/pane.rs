//! Panes that run: a PTY, the process on it, and the screen it draws on.
//!
//! `crate::desk` is the workspace -- which folder, which slot, what to re-run --
//! and it is on disk. This is the runtime, and it is not. A pane here is a
//! `Live`: a screen, the frames sent from it, and, while the reader has asked
//! for one, a process. Nothing starts a process except `start`, and nothing
//! calls `start` except a request carrying the window's capability, which is a
//! click. A daemon that wakes up finds its panes stopped and leaves them so.
//!
//! One thread per running pane reads the PTY and feeds the screen; one task
//! per pane turns the screen into frames, at most one a frame, and sends them
//! to every page watching. The frame task holds the pane's lock while it
//! sends, and a page that arrives takes its snapshot under the same lock, so
//! the snapshot and the first frame after it always join up: that is how two
//! windows on one pane agree with each other and with the screen.
//!
//! What a pane leaves behind when its process ends or the daemon stops is its
//! last screen as plain text, in `panes/<id>.txt` beside the store. It comes
//! back greyed after a restart -- the last thing the reader saw -- and it is
//! plain text on purpose: colour on a screen nobody can type into is noise.

use crate::screen::{self, Screen, Shown};
use anyhow::{bail, Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Notify};

/// A frame a second more than 60 is not drawn by any screen anyone owns.
const FRAME: Duration = Duration::from_millis(16);
/// And under load, half of that. A frame this big is the adversary's case --
/// every cell a different colour -- and nothing real sends it twice in a row.
const HEAVY_FRAME: usize = 32 * 1024;
const SLOW_FRAME: Duration = Duration::from_millis(33);
/// How often a pane that has changed writes its text down, so a daemon that is
/// killed rather than stopped loses at most this much of it.
const PERSIST_EVERY: Duration = Duration::from_secs(15);

/// What the rail and the sidebar say about a pane, sent whenever it changes.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    /// When the process started, in seconds since the epoch.
    pub since: Option<i64>,
    /// How the last process ended, if one has.
    pub exit: Option<i32>,
    /// The program rang for its reader and nobody has typed since.
    pub blocked: bool,
    pub blocked_since: Option<i64>,
    /// What was run, as typed.
    pub cmd: String,
    /// The title the program set, if it set one.
    pub title: String,
}

struct Proc {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct Inner {
    screen: Screen,
    parser: vte::Parser,
    shown: Shown,
    proc: Option<Proc>,
    status: Status,
    /// The text a previous run left, shown greyed until this one draws.
    old: Vec<String>,
    /// Something changed since the text was last written down.
    unsaved: bool,
    /// Bumped by each start, so the threads of a process that has been
    /// replaced do not write into the one that replaced it.
    run: u64,
}

pub struct Live {
    pub id: String,
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<str>>,
    wake: Notify,
}

/// What `start` needs to know that is not the pane's own.
pub struct Start<'a> {
    pub cwd: &'a str,
    pub cmd: &'a str,
    pub desk: &'a str,
    pub slot: i64,
    pub cols: u16,
    pub rows: u16,
}

pub struct Panes {
    live: Mutex<HashMap<String, Arc<Live>>>,
    dir: PathBuf,
    /// The daemon's event stream, for the `panes` event the sidebar draws its
    /// dots from. Held here rather than an `App`, so a pane can say it changed
    /// without knowing what a server is.
    events: broadcast::Sender<String>,
}

impl Panes {
    pub fn new(data_dir: &std::path::Path, events: broadcast::Sender<String>) -> Arc<Panes> {
        let panes = Arc::new(Panes {
            live: Mutex::new(HashMap::new()),
            dir: data_dir.join("panes"),
            events,
        });
        // A daemon killed rather than stopped keeps what it had up to the
        // last of these.
        let weak = Arc::downgrade(&panes);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PERSIST_EVERY);
            loop {
                tick.tick().await;
                let Some(p) = weak.upgrade() else { return };
                p.persist_all();
            }
        });
        panes
    }

    /// A pane's runtime, made on first use: the pane exists in the store and
    /// has never been shown since this daemon started. Its last text is read
    /// from disk then, and not before -- most panes are never looked at.
    pub fn get(self: &Arc<Self>, id: &str) -> Arc<Live> {
        let mut live = self.live.lock().unwrap();
        if let Some(l) = live.get(id) {
            return l.clone();
        }
        let old = self.read_text(id);
        let (tx, _) = broadcast::channel(256);
        let l = Arc::new(Live {
            id: id.to_string(),
            inner: Mutex::new(Inner {
                screen: Screen::new(80, 24),
                parser: vte::Parser::new(),
                shown: Shown::new(80, 24),
                proc: None,
                status: Status::default(),
                old,
                unsaved: false,
                run: 0,
            }),
            tx,
            wake: Notify::new(),
        });
        live.insert(id.to_string(), l.clone());
        drop(live);
        tokio::spawn(frames(Arc::downgrade(&l), Arc::downgrade(self)));
        l
    }

    /// Only the panes this daemon has woken, with no disk read for the rest.
    pub fn status(&self, id: &str) -> Status {
        self.live
            .lock()
            .unwrap()
            .get(id)
            .map(|l| l.inner.lock().unwrap().status.clone())
            .unwrap_or_default()
    }

    /// How many processes are running across every pane.
    pub fn running(&self) -> usize {
        self.live
            .lock()
            .unwrap()
            .values()
            .filter(|l| l.inner.lock().unwrap().status.running)
            .count()
    }

    /// The process on a pane is stopped, its text is deleted, and the pane is
    /// forgotten here -- which is what closing a pane or a desk does, after
    /// the store has let go of the row.
    pub fn close(&self, id: &str) {
        let l = self.live.lock().unwrap().remove(id);
        if let Some(l) = l {
            l.stop();
        }
        let _ = std::fs::remove_file(self.text_path(id));
    }

    /// Every pane: stopped, forgotten, and its text gone. A reset.
    pub fn clear(&self) {
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().drain().map(|(_, l)| l).collect();
        for l in all {
            l.stop();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    /// Stop everything and write it down: the daemon is going.
    pub fn shutdown(&self) {
        self.persist_all();
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in all {
            l.stop();
        }
    }

    fn persist_all(&self) {
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in all {
            let text = {
                let mut i = l.inner.lock().unwrap();
                if !i.unsaved {
                    continue;
                }
                i.unsaved = false;
                keep_text(&i.old, i.screen.text())
            };
            self.write_text(&l.id, &text);
        }
    }

    fn text_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.txt"))
    }

    fn read_text(&self, id: &str) -> Vec<String> {
        // An id is 32 hex characters from `crate::desk`, so it is safe as a
        // file name -- and anything that is not is refused rather than joined.
        if !valid_id(id) {
            return Vec::new();
        }
        std::fs::read_to_string(self.text_path(id))
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    fn write_text(&self, id: &str, lines: &[String]) {
        if !valid_id(id) {
            return;
        }
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.dir.join(format!("{id}.tmp"));
        if std::fs::write(&tmp, lines.join("\n")).is_ok() {
            let _ = std::fs::rename(&tmp, self.text_path(id));
        }
    }

    /// The dots, and nothing else: this goes down `/api/events`, which a
    /// browser tab reads too, so what was typed and the title a program set
    /// stay behind the capability, on the desk socket.
    fn changed(&self, id: &str, status: &Status) {
        let _ = self.events.send(format!(
            "panes\n{}",
            serde_json::json!({ "id": id, "running": status.running, "blocked": status.blocked })
        ));
    }
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The previous run's text and this one's, joined and cut to the scrollback
/// cap from the front, whole lines at a time.
fn keep_text(old: &[String], now: Vec<String>) -> Vec<String> {
    let mut all: Vec<String> = old.iter().cloned().chain(now).collect();
    let mut bytes: usize = all.iter().map(|l| l.len() + 1).sum();
    let mut drop = 0;
    while bytes > screen::SCROLLBACK_BYTES && drop < all.len() {
        bytes -= all[drop].len() + 1;
        drop += 1;
    }
    all.drain(..drop);
    all
}

impl Live {
    /// What a page that has just arrived is sent -- the pane's status and a
    /// snapshot of the screen as every other page holds it -- and the
    /// receiver it goes on reading. Taken under the lock the frame task sends
    /// under, so the snapshot and the next frame join up exactly.
    pub fn attach(&self) -> (Vec<String>, broadcast::Receiver<Arc<str>>) {
        let i = self.inner.lock().unwrap();
        let mut first = vec![status_frame(&self.id, &i.status)];
        if !i.old.is_empty() {
            first.push(serde_json::json!({ "t": "old", "p": self.id, "lines": i.old }).to_string());
        }
        first.push(i.screen.snapshot(&self.id, &i.shown));
        (first, self.tx.subscribe())
    }

    /// Keys from the reader, and only from the reader: this is called for a
    /// frame the page sent from a key or a paste, never for anything snyvi
    /// received. It is also what un-blocks a pane -- the reader has answered.
    pub fn input(&self, bytes: &[u8], panes: &Panes) {
        let mut i = self.inner.lock().unwrap();
        let Some(p) = i.proc.as_mut() else { return };
        let _ = p.writer.write_all(bytes);
        let _ = p.writer.flush();
        if i.status.blocked {
            i.status.blocked = false;
            i.status.blocked_since = None;
            let s = i.status.clone();
            let _ = self.tx.send(status_frame(&self.id, &s).into());
            drop(i);
            panes.changed(&self.id, &s);
        }
    }

    /// The page's pane changed size. Resize-and-clear on both sides, which
    /// `Screen::resize` does, and the process is told.
    pub fn resize(&self, cols: u16, rows: u16) {
        let mut i = self.inner.lock().unwrap();
        let Inner {
            screen,
            shown,
            proc,
            ..
        } = &mut *i;
        let (c, r) = (usize::from(cols), usize::from(rows));
        if screen.size() == (c.clamp(2, 1000), r.clamp(1, 500)) {
            return;
        }
        screen.resize(c, r, shown);
        if let Some(p) = proc.as_ref() {
            let (c, r) = screen.size();
            let _ = p.master.resize(PtySize {
                rows: r as u16,
                cols: c as u16,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        drop(i);
        self.wake.notify_one();
    }

    /// Start the pane's process: its command, or the reader's shell, in the
    /// desk's folder, with `SNYVI_SESSION` set to the pane's id so that what it
    /// sends to snyvi says where it came from.
    pub fn start(self: &Arc<Self>, s: Start, panes: &Arc<Panes>) -> Result<Status> {
        if !std::path::Path::new(s.cwd).is_dir() {
            bail!("{} is not a folder any more", s.cwd);
        }
        let mut i = self.inner.lock().unwrap();
        if i.status.running {
            bail!("already running");
        }
        let pty = portable_pty::native_pty_system();
        let size = PtySize {
            rows: s.rows.clamp(1, 500),
            cols: s.cols.clamp(2, 1000),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty.openpty(size).context("opening a terminal")?;
        let mut cmd = command(s.cmd);
        cmd.cwd(s.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "snyvi");
        cmd.env("SNYVI_SESSION", &self.id);
        cmd.env("SNYVI_DESK", s.desk);
        cmd.env("SNYVI_SLOT", s.slot.to_string());
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("starting {}", display_cmd(s.cmd)))?;
        // The slave end belongs to the child now. Holding it here would keep
        // the PTY open after the child exits, and the reader would never see
        // the end of it.
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .context("reading the terminal")?;
        let writer = pair.master.take_writer().context("writing the terminal")?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        // A fresh screen at the page's size. The old text stays, greyed, above
        // it: that is what `old` is for.
        let (c, r) = (usize::from(size.cols), usize::from(size.rows));
        let mut screen = Screen::new(c, r);
        let mut shown = Shown::new(c, r);
        // Let what the previous process left be the history of this one, as
        // the page shows it; nothing else about the old screen carries over.
        std::mem::swap(&mut screen, &mut i.screen);
        std::mem::swap(&mut shown, &mut i.shown);
        let previous = screen.text();
        if !previous.is_empty() {
            i.old = keep_text(&i.old, previous);
        }
        i.parser = vte::Parser::new();
        i.run += 1;
        let run = i.run;
        i.proc = Some(Proc {
            master: pair.master,
            writer,
            killer,
        });
        i.status = Status {
            running: true,
            pid,
            since: Some(crate::store::now()),
            exit: None,
            blocked: false,
            blocked_since: None,
            cmd: s.cmd.to_string(),
            title: String::new(),
        };
        i.unsaved = true;
        let status = i.status.clone();
        let _ = self.tx.send(status_frame(&self.id, &status).into());
        if !i.old.is_empty() {
            let old = serde_json::json!({ "t": "old", "p": self.id, "lines": i.old });
            let _ = self.tx.send(old.to_string().into());
        }
        drop(i);
        panes.changed(&self.id, &status);
        self.wake.notify_one();

        // The reader: bytes to the screen, answers back to the program. It
        // says when it has read the last of them.
        let me = Arc::downgrade(self);
        let (done_tx, done) = std::sync::mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(format!("pane {}", &self.id[..8]))
            .spawn(move || {
                read_loop(me, reader, run);
                let _ = done_tx.send(());
            })
            .context("starting the pane's reader")?;
        // The waiter: the exit status, and the text written down -- after the
        // reader has drained what the process printed on its way out, or a
        // moment, whichever is first: a background job still holding the
        // terminal must not keep a finished pane looking alive.
        let me = Arc::downgrade(self);
        let panes = Arc::downgrade(panes);
        std::thread::Builder::new()
            .name(format!("wait {}", &self.id[..8]))
            .spawn(move || {
                let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
                let _ = done.recv_timeout(Duration::from_millis(500));
                let (Some(me), Some(panes)) = (me.upgrade(), panes.upgrade()) else {
                    return;
                };
                me.exited(run, code, &panes);
            })
            .context("starting the pane's waiter")?;
        Ok(status)
    }

    fn exited(&self, run: u64, code: i32, panes: &Panes) {
        let (status, text) = {
            let mut i = self.inner.lock().unwrap();
            if i.run != run {
                return;
            }
            i.proc = None;
            i.status.running = false;
            i.status.pid = None;
            i.status.exit = Some(code);
            i.status.blocked = false;
            i.status.blocked_since = None;
            i.unsaved = false;
            (i.status.clone(), keep_text(&i.old, i.screen.text()))
        };
        panes.write_text(&self.id, &text);
        let _ = self.tx.send(status_frame(&self.id, &status).into());
        panes.changed(&self.id, &status);
        self.wake.notify_one();
    }

    /// Hang up on the process. The PTY closing is a second hangup for anything
    /// that did not hear the first.
    pub fn stop(&self) {
        let mut i = self.inner.lock().unwrap();
        if let Some(mut p) = i.proc.take() {
            let _ = p.killer.kill();
            drop(p);
        }
    }
}

fn read_loop(me: std::sync::Weak<Live>, mut reader: Box<dyn Read + Send>, run: u64) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let Some(l) = me.upgrade() else { return };
        {
            let mut i = l.inner.lock().unwrap();
            if i.run != run {
                return;
            }
            let Inner {
                screen,
                parser,
                proc,
                unsaved,
                ..
            } = &mut *i;
            screen.feed(parser, &buf[..n]);
            *unsaved = true;
            if !screen.replies.is_empty() {
                let replies = std::mem::take(&mut screen.replies);
                if let Some(p) = proc.as_mut() {
                    let _ = p.writer.write_all(&replies);
                    let _ = p.writer.flush();
                }
            }
        }
        l.wake.notify_one();
    }
}

/// One pane's frames: woken by output, a resize or a start, and never more
/// than once a frame. Sends while holding the pane's lock, which is what
/// makes `attach` exact.
async fn frames(me: std::sync::Weak<Live>, panes: std::sync::Weak<Panes>) {
    let mut last = Instant::now() - FRAME;
    let mut gap = FRAME;
    loop {
        let Some(l) = me.upgrade() else { return };
        // Waiting holds only the Notify, not the pane: a pane that has been
        // closed drops, and this ends at the next wake or the upgrade above.
        let notified = {
            let l2 = l.clone();
            drop(l);
            async move { l2.wake.notified().await }
        };
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(Duration::from_secs(30)) => continue,
        }
        let since = last.elapsed();
        if since < gap {
            tokio::time::sleep(gap - since).await;
        }
        let Some(l) = me.upgrade() else { return };
        let mut i = l.inner.lock().unwrap();
        let Inner {
            screen,
            shown,
            status,
            ..
        } = &mut *i;
        let frame = screen.frame(&l.id, shown);
        gap = match &frame {
            Some(f) if f.len() > HEAVY_FRAME => SLOW_FRAME,
            _ => FRAME,
        };
        if let Some(f) = frame {
            let _ = l.tx.send(f.into());
        }
        last = Instant::now();
        let mut said = None;
        if std::mem::take(&mut screen.bell) && status.running && !status.blocked {
            status.blocked = true;
            status.blocked_since = Some(crate::store::now());
            said = Some(status.clone());
        }
        if screen.title != status.title {
            status.title = screen.title.clone();
            said = Some(status.clone());
        }
        if let Some(s) = &said {
            let _ = l.tx.send(status_frame(&l.id, s).into());
        }
        drop(i);
        if let (Some(s), Some(p)) = (said, panes.upgrade()) {
            p.changed(&l.id, &s);
        }
    }
}

fn status_frame(id: &str, s: &Status) -> String {
    serde_json::json!({ "t": "status", "p": id, "s": s }).to_string()
}

/// What runs. The reader's shell when nothing was typed, as a login shell so
/// its `PATH` is the one they know -- a daemon started by systemd has almost
/// none of its own. A typed command runs inside that same shell, so `claude
/// --continue` finds `claude` the way the reader's own terminal would.
fn command(typed: &str) -> CommandBuilder {
    let typed = typed.trim();
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut c = CommandBuilder::new(&shell);
        c.arg("-l");
        if !typed.is_empty() {
            c.arg("-c");
            c.arg(typed);
        }
        c
    }
    #[cfg(windows)]
    {
        if typed.is_empty() {
            CommandBuilder::new_default_prog()
        } else {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg(typed);
            c
        }
    }
}

fn display_cmd(typed: &str) -> &str {
    if typed.trim().is_empty() {
        "the shell"
    } else {
        typed.trim()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_text_is_cut_from_the_front_to_the_cap() {
        let old: Vec<String> = (0..10).map(|i| format!("old {i}")).collect();
        let big = "z".repeat(1024);
        let now: Vec<String> = (0..3000).map(|_| big.clone()).collect();
        let kept = keep_text(&old, now);
        let bytes: usize = kept.iter().map(|l| l.len() + 1).sum();
        assert!(bytes <= screen::SCROLLBACK_BYTES);
        assert_eq!(kept.last().unwrap(), &big, "the newest line is kept");
        assert!(
            !kept.iter().any(|l| l.starts_with("old")),
            "the oldest go first"
        );
        // Under the cap, nothing is lost and the order holds.
        let kept = keep_text(&old, vec!["new".into()]);
        assert_eq!(kept.len(), 11);
        assert_eq!(kept[0], "old 0");
        assert_eq!(kept[10], "new");
    }

    #[test]
    fn only_a_pane_id_is_a_file_name() {
        assert!(valid_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("0123456789abcdef0123456789abcde/"));
        assert!(!valid_id(""));
    }

    /// A real process on a real PTY, end to end: the child sees its pane's
    /// id in `SNYVI_SESSION` and its desk's folder as its cwd, what it prints
    /// arrives as a frame, and its exit is a status.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_pane_runs_a_process_and_its_output_arrives_as_frames() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pane");
        let (events, _) = broadcast::channel(16);
        let panes = Panes::new(&dir.path, events);
        let id = "00112233445566778899aabbccddeeff";
        let live = panes.get(id);
        let (first, mut rx) = live.attach();
        assert!(first[0].contains("\"running\":false"));
        let cwd = dir.path.to_string_lossy().to_string();
        live.start(
            Start {
                cwd: &cwd,
                cmd: "printf 'pane=%s\\n' \"$SNYVI_SESSION\"; pwd; exit 3",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
            },
            &panes,
        )
        .unwrap();
        let mut seen = String::new();
        let mut exit = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while exit.is_none() && tokio::time::Instant::now() < deadline {
            let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await else {
                break;
            };
            let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
            if v["t"] == "frame" {
                seen.push_str(&msg);
            }
            if v["t"] == "status" && v["s"]["running"] == false {
                exit = v["s"]["exit"].as_i64();
            }
        }
        // The last frame follows the status by at most a frame.
        while let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
            seen.push_str(&msg);
        }
        assert!(seen.contains(&format!("pane={id}")), "{seen}");
        assert!(seen.contains(cwd.split('/').next_back().unwrap()), "{seen}");
        assert_eq!(exit, Some(3));
        // And what it left is on disk, for a restart to grey out.
        let text =
            std::fs::read_to_string(dir.path.join("panes").join(format!("{id}.txt"))).unwrap();
        assert!(text.contains(&format!("pane={id}")));
    }
}
