//! Panes that run: a PTY, the process on it, and the screen it draws on.
//!
//! `crate::desk` is the workspace -- which folder, which slot, what to re-run --
//! and it is on disk. This is the runtime, and it is not. A pane here is a
//! `Live`: a screen, the frames sent from it, and, while the reader has asked
//! for one, a process. Nothing starts a process except `start`, and nothing
//! calls `start` except a request carrying the window's capability. A daemon
//! that wakes up finds its panes stopped and leaves them so: it is the window,
//! showing a pane whose shell went with the last daemon, that asks for another
//! one -- over the same route a click on `Start` takes.
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
/// And with no page watching, once a second. The frame still has to be made --
/// it is what moves lines off the screen into the scrollback that is kept --
/// but nobody is drawing it, so a spinner in a panel on another desk costs one
/// diff a second rather than sixty. A page that attaches is caught up at once.
const UNWATCHED_FRAME: Duration = Duration::from_secs(1);
/// How often a pane that has changed writes its text down, so a daemon that is
/// killed rather than stopped loses at most this much of it.
const PERSIST_EVERY: Duration = Duration::from_secs(15);
/// How often a running pane's folder is asked whether its tree is modified.
/// This is the half of the prompt that costs a process (`crate::prompt` reads
/// the branch itself, out of .git/HEAD), which is exactly why it happens here
/// and not there: nobody waits for it, and a folder that answers slowly is
/// asked less often rather than making a prompt stutter.
const GIT_EVERY: Duration = Duration::from_secs(3);
/// A folder is asked again no sooner than ten times what the last answer cost,
/// and no later than this. A repository big enough to take a second is worth
/// a minute of quiet.
const GIT_BACKOFF: u32 = 10;
const GIT_AT_MOST: Duration = Duration::from_secs(60);

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
    /// The colour this pane's prompt was dressed in, `#rrggbb`, or empty for a
    /// shell snyvi does not dress. The page paints that exact colour as the
    /// accent, so changing the swatch re-tints a prompt already on the screen.
    pub accent: String,
    /// The branch the pane's folder is on, and whether its tree is modified.
    /// Worked out by the daemon rather than by the prompt, so that a pane
    /// whose shell snyvi cannot dress still says both.
    pub branch: String,
    pub dirty: bool,
    /// What the agent in this pane is doing, when the agent says so: Claude
    /// Code's hooks report `working`, `needs_you` or `done` (see `Agent`).
    /// Empty for everything else, which keeps `blocked` as its only signal.
    pub agent: &'static str,
    pub agent_since: Option<i64>,
}

/// The states an agent reports through its hooks. `needs_you` is Claude's
/// precise version of `blocked`: a permission prompt, not a bell.
pub const AGENT_STATES: [&str; 3] = ["working", "needs_you", "done"];

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
    /// The folder the running process was started in, for the git tick.
    cwd: String,
}

impl Inner {
    /// The frame for whatever changed since the pages were last sent one, and
    /// `shown` brought up to date. The frame task calls it, and so does an
    /// attach, which is why it is one function: the two must never disagree
    /// about what the pages hold.
    fn frame_now(&mut self, id: &str) -> Option<String> {
        // `clear` empties everything the reader could scroll back to, and
        // the last run's text sits above the scrollback: it goes with it,
        // here and on disk, so a page that attaches later is not sent it
        // back. The page drops its own copy on the frame that says so.
        if self.screen.scrollback_cleared() && !self.old.is_empty() {
            self.old.clear();
            self.unsaved = true;
        }
        self.screen.frame(id, &mut self.shown)
    }
}

pub struct Live {
    pub id: String,
    inner: Mutex<Inner>,
    tx: broadcast::Sender<Arc<str>>,
    wake: Notify,
    /// A page began watching: the frame task, idling at `UNWATCHED_FRAME`,
    /// stops waiting out the rest of its second.
    watched: Notify,
}

/// What `start` needs to know that is not the pane's own.
pub struct Start<'a> {
    pub cwd: &'a str,
    pub cmd: &'a str,
    pub desk: &'a str,
    pub slot: i64,
    pub cols: u16,
    pub rows: u16,
    /// The accent the window is wearing, `#rrggbb`, for the prompt snyvi
    /// dresses the shell in. Empty when the page did not say.
    pub accent: &'a str,
}

pub struct Panes {
    live: Mutex<HashMap<String, Arc<Live>>>,
    dir: PathBuf,
    /// When each folder may be asked about its tree again. Keyed by folder,
    /// not by pane: two panes in one folder are one question.
    git: Mutex<HashMap<String, Instant>>,
    /// The daemon's event stream, for the `panes` event the sidebar draws its
    /// dots from. Held here rather than an `App`, so a pane can say it changed
    /// without knowing what a server is.
    events: broadcast::Sender<String>,
    /// What each pane last said on that stream: `(running, blocked, agent)`.
    /// Forgotten with the pane.
    told: Mutex<HashMap<String, (bool, bool, &'static str)>>,
}

impl Panes {
    pub fn new(data_dir: &std::path::Path, events: broadcast::Sender<String>) -> Arc<Panes> {
        let panes = Arc::new(Panes {
            live: Mutex::new(HashMap::new()),
            dir: data_dir.join("panes"),
            git: Mutex::new(HashMap::new()),
            events,
            told: Mutex::new(HashMap::new()),
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
        let weak = Arc::downgrade(&panes);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(GIT_EVERY);
            loop {
                tick.tick().await;
                let Some(p) = weak.upgrade() else { return };
                p.git_tick().await;
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
                cwd: String::new(),
            }),
            tx,
            wake: Notify::new(),
            watched: Notify::new(),
        });
        live.insert(id.to_string(), l.clone());
        drop(live);
        tokio::spawn(frames(Arc::downgrade(&l), Arc::downgrade(self)));
        l
    }

    /// What each running pane's folder is on, asked of git and told to the
    /// pages that are watching. One question per folder per tick, and a folder
    /// that answers slowly is asked less often: see `GIT_BACKOFF`.
    async fn git_tick(self: &Arc<Self>) {
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        let mut by_dir: HashMap<String, Vec<Arc<Live>>> = HashMap::new();
        for l in live {
            if let Some(cwd) = l.running_in() {
                by_dir.entry(cwd).or_default().push(l);
            }
        }
        // A folder nothing runs in any more is not worth remembering.
        self.git
            .lock()
            .unwrap()
            .retain(|d, _| by_dir.contains_key(d));
        for (dir, panes) in by_dir {
            let now = Instant::now();
            if self
                .git
                .lock()
                .unwrap()
                .get(&dir)
                .is_some_and(|due| now < *due)
            {
                continue;
            }
            let d = dir.clone();
            let Ok((branch, dirty)) = tokio::task::spawn_blocking(move || {
                let p = std::path::Path::new(&d);
                (crate::project::head_of(p), crate::project::modified(p))
            })
            .await
            else {
                continue;
            };
            let cost = now.elapsed();
            let next = now + (cost * GIT_BACKOFF).clamp(GIT_EVERY, GIT_AT_MOST);
            self.git.lock().unwrap().insert(dir, next);
            for l in panes {
                l.set_git(branch.clone().unwrap_or_default(), dirty.unwrap_or(false));
            }
        }
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

    /// An agent in a running pane says what it is doing. Only a pane this
    /// daemon already has running is told: an id that is not one is refused,
    /// and nothing is woken or created for it. `state` is one of
    /// `AGENT_STATES`, or empty for an agent that has gone.
    pub fn set_agent(&self, id: &str, state: &str) -> bool {
        let Some(l) = self.live.lock().unwrap().get(id).cloned() else {
            return false;
        };
        let state = AGENT_STATES.into_iter().find(|s| *s == state).unwrap_or("");
        let mut i = l.inner.lock().unwrap();
        if !i.status.running {
            return false;
        }
        if i.status.agent == state {
            return true;
        }
        // `needs_you` is also `blocked`, so everything that already shows a
        // pane waiting on its reader -- the sidebar's `!`, its count -- shows
        // this one too. Leaving it takes back only what it set.
        if state == "needs_you" && !i.status.blocked {
            i.status.blocked = true;
            i.status.blocked_since = Some(crate::store::now());
        } else if i.status.agent == "needs_you" && state != "needs_you" {
            i.status.blocked = false;
            i.status.blocked_since = None;
        }
        i.status.agent = state;
        i.status.agent_since = (!state.is_empty()).then(crate::store::now);
        let s = i.status.clone();
        drop(i);
        let _ = l.tx.send(status_frame(&l.id, &s).into());
        self.changed(&l.id, &s);
        true
    }

    /// Whether this pane has a process right now. Nothing is woken to answer.
    pub fn is_running(&self, id: &str) -> bool {
        self.live
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|l| l.inner.lock().unwrap().status.running)
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
        self.told.lock().unwrap().remove(id);
        let _ = std::fs::remove_file(self.text_path(id));
    }

    /// Every pane: stopped, forgotten, and its text gone. A reset.
    pub fn clear(&self) {
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().drain().map(|(_, l)| l).collect();
        self.told.lock().unwrap().clear();
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
        // An exact repeat of the last word is dropped: every page redraws on
        // this, and a redraw that changes nothing still takes the row out from
        // under the pointer.
        let now = (status.running, status.blocked, status.agent);
        if self.told.lock().unwrap().insert(id.to_string(), now) == Some(now) {
            return;
        }
        let _ = self.events.send(format!(
            "panes\n{}",
            serde_json::json!({ "id": id, "running": status.running, "blocked": status.blocked, "agent": status.agent })
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
        let mut i = self.inner.lock().unwrap();
        // An unwatched pane's frames run a second behind; what the frame task
        // has not sent yet goes now, to whoever else is watching, so the
        // snapshot below starts from the screen as it is.
        if let Some(f) = i.frame_now(&self.id) {
            let _ = self.tx.send(f.into());
        }
        self.watched.notify_one();
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
        let (mut cmd, born) = command(s.cmd, s.accent);
        cmd.cwd(s.cwd);
        i.cwd = s.cwd.to_string();
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
            accent: born,
            // Carried across the restart: the folder has not moved, and
            // blanking it would flicker the header on every start.
            branch: i.status.branch.clone(),
            dirty: i.status.dirty,
            agent: "",
            agent_since: None,
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
            i.status.agent = "";
            i.status.agent_since = None;
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
            let Some(l) = me.upgrade() else { return };
            let watched = {
                let l2 = l.clone();
                drop(l);
                async move { l2.watched.notified().await }
            };
            tokio::select! {
                _ = tokio::time::sleep(gap - since) => {}
                _ = watched => {}
            }
        }
        let Some(l) = me.upgrade() else { return };
        let mut i = l.inner.lock().unwrap();
        let frame = i.frame_now(&l.id);
        gap = match &frame {
            _ if l.tx.receiver_count() == 0 => UNWATCHED_FRAME,
            Some(f) if f.len() > HEAVY_FRAME => SLOW_FRAME,
            _ => FRAME,
        };
        let Inner { screen, status, .. } = &mut *i;
        if let Some(f) = frame {
            let _ = l.tx.send(f.into());
        }
        last = Instant::now();
        // Two audiences. The pane's header shows its title, so a new title
        // goes down the desk socket; the sidebar's dot does not, so only a
        // bell goes on to the page-wide stream. An agent animates its title
        // about once a second while it works, and every one of those used to
        // redraw the sidebar under the reader's pointer.
        let mut said = None;
        let mut rang = false;
        if std::mem::take(&mut screen.bell) && status.running && !status.blocked {
            status.blocked = true;
            status.blocked_since = Some(crate::store::now());
            rang = true;
        }
        let retitled = screen.title != status.title;
        if retitled {
            status.title = screen.title.clone();
        }
        if rang || retitled {
            said = Some(status.clone());
        }
        if let Some(s) = &said {
            let _ = l.tx.send(status_frame(&l.id, s).into());
        }
        drop(i);
        if let (true, Some(s), Some(p)) = (rang, said, panes.upgrade()) {
            p.changed(&l.id, &s);
        }
    }
}

impl Live {
    /// The folder a running process was started in, or nothing when the pane
    /// is stopped: a stopped pane has no tree worth asking about.
    fn running_in(&self) -> Option<String> {
        let i = self.inner.lock().unwrap();
        i.status
            .running
            .then(|| i.cwd.clone())
            .filter(|c| !c.is_empty())
    }

    /// What git said, kept and sent on only when it is news. A header that
    /// redraws every few seconds for no change is a header that flickers.
    fn set_git(&self, branch: String, dirty: bool) {
        let mut i = self.inner.lock().unwrap();
        if i.status.branch == branch && i.status.dirty == dirty {
            return;
        }
        i.status.branch = branch;
        i.status.dirty = dirty;
        let s = i.status.clone();
        drop(i);
        let _ = self.tx.send(status_frame(&self.id, &s).into());
    }
}

fn status_frame(id: &str, s: &Status) -> String {
    serde_json::json!({ "t": "status", "p": id, "s": s }).to_string()
}

/// What runs. The reader's shell when nothing was typed, as a login shell so
/// its `PATH` is the one they know -- a daemon started by systemd has almost
/// none of its own. A typed command runs inside that same shell, so `claude
/// --continue` finds `claude` the way the reader's own terminal would.
///
/// A shell with nothing typed is the one the reader will sit and type at, so
/// it wears snyvi's prompt (see `crate::prompt`). A typed command is not
/// interactive and has no prompt to dress.
/// Put a dressing on a command: its arguments, then its environment. Shared
/// by both arms below so that what CI alone compiles stays as small as it can
/// be. Never called on a builder made by `new_default_prog`, which panics on
/// `arg`.
fn apply(c: &mut CommandBuilder, d: &crate::prompt::Dress) {
    for a in &d.args {
        c.arg(a);
    }
    for (k, v) in &d.env {
        c.env(k, v);
    }
}

fn command(typed: &str, accent: &str) -> (CommandBuilder, String) {
    let typed = typed.trim();
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut c = CommandBuilder::new(&shell);
        let dress = if typed.is_empty() {
            crate::prompt::dress(std::path::Path::new(&shell), accent)
        } else {
            None
        };
        match dress {
            Some(d) => {
                apply(&mut c, &d);
                (c, crate::prompt::effective(accent))
            }
            None => {
                c.arg("-l");
                if !typed.is_empty() {
                    c.arg("-c");
                    c.arg(typed);
                }
                (c, String::new())
            }
        }
    }
    #[cfg(windows)]
    {
        if !typed.is_empty() {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg(typed);
            return (c, String::new());
        }
        // Whatever the reader's COMSPEC names -- cmd.exe as it ships, or a
        // PowerShell they pointed it at. snyvi does not choose the shell here,
        // only how it is dressed. Named rather than left as portable-pty's
        // default program, because a default-prog builder panics on `arg`.
        let prog = std::env::var("ComSpec")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string());
        let mut c = CommandBuilder::new(&prog);
        match crate::prompt::dress(std::path::Path::new(&prog), accent) {
            Some(d) => {
                apply(&mut c, &d);
                (c, crate::prompt::effective(accent))
            }
            None => (c, String::new()),
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
                // Wide enough for a macOS temp dir, which is long enough to
                // wrap at 80 and split the name this looks for across rows.
                cols: 400,
                rows: 10,
                accent: "",
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

    /// A pane nobody watches makes a frame a second, not sixty -- and a page
    /// that attaches between two of them still gets the screen as it is.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unwatched_pane_is_caught_up_when_a_page_attaches() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pane-idle");
        let (events, _) = broadcast::channel(16);
        let panes = Panes::new(&dir.path, events);
        let live = panes.get("ffeeddccbbaa99887766554433221100");
        let cwd = dir.path.to_string_lossy().to_string();
        live.start(
            Start {
                cwd: &cwd,
                cmd: "printf 'early\\n'; sleep 0.3; printf 'late\\n'; sleep 2",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
            },
            &panes,
        )
        .unwrap();
        // "late" is printed 0.3 s in; the next unwatched frame is a second
        // after the first, so without a catch-up the snapshot would miss it.
        tokio::time::sleep(Duration::from_millis(700)).await;
        let (first, _rx) = live.attach();
        let snap = first.last().unwrap();
        assert!(snap.contains("late"), "{snap}");
    }

    /// The agent's word reaches only a pane that is running, is sent once per
    /// change, and goes with the process.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_agent_state_is_set_on_a_running_pane_once_per_change() {
        let dir = crate::store::tempdir::Dir::new("snyvi-agent");
        let (events, mut ev) = broadcast::channel(64);
        let panes = Panes::new(&dir.path, events);
        let id = "ffeeddccbbaa99887766554433221100";
        assert!(!panes.set_agent(id, "working"), "a pane nobody opened");
        let live = panes.get(id);
        assert!(!panes.set_agent(id, "working"), "a stopped pane");
        let (_, mut rx) = live.attach();
        let cwd = dir.path.to_string_lossy().to_string();
        live.start(
            Start {
                cwd: &cwd,
                cmd: "read x",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
            },
            &panes,
        )
        .unwrap();
        assert!(panes.set_agent(id, "needs_you"));
        assert!(
            panes.status(id).blocked,
            "needs_you is blocked, for the sidebar"
        );
        assert!(panes.set_agent(id, "needs_you"));
        assert!(panes.set_agent(id, "nonsense"), "an unknown word clears it");
        let st = panes.status(id);
        assert_eq!(st.agent, "");
        assert!(!st.blocked, "leaving needs_you unblocks");
        assert!(panes.set_agent(id, "done"));
        let mut said = Vec::new();
        while let Ok(Ok(m)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            let v: serde_json::Value = serde_json::from_str(&m).unwrap();
            if v["t"] == "status" && v["s"]["running"] == true {
                said.push(v["s"]["agent"].as_str().unwrap().to_string());
            }
        }
        assert_eq!(said, ["", "needs_you", "", "done"], "one frame per change");
        let mut dots = Vec::new();
        while let Ok(m) = ev.try_recv() {
            dots.push(m);
        }
        assert!(
            dots.iter().any(|d| d.contains("\"agent\":\"needs_you\"")),
            "{dots:?}"
        );
        live.stop();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while panes.status(id).running && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            panes.status(id).agent,
            "",
            "the agent goes with its process"
        );
    }

    /// A title is the pane header's business and goes down the desk socket;
    /// the page-wide stream hears only what the sidebar draws, once per
    /// change. An agent retitles its pane about once a second while it works.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_new_title_reaches_the_desk_and_not_the_sidebar() {
        let dir = crate::store::tempdir::Dir::new("snyvi-title");
        let (events, mut ev) = broadcast::channel(64);
        let panes = Panes::new(&dir.path, events);
        let id = "00112233445566778899aabbccddeeff";
        let live = panes.get(id);
        let (_, mut rx) = live.attach();
        let cwd = dir.path.to_string_lossy().to_string();
        live.start(
            Start {
                cwd: &cwd,
                cmd: "for t in a b c d e; do printf '\\033]0;%s\\007' $t; sleep 0.05; done; printf '\\a'; read x",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
            },
            &panes,
        )
        .unwrap();
        let mut titles = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !panes.status(id).blocked && tokio::time::Instant::now() < deadline {
            while let Ok(m) = rx.try_recv() {
                let v: serde_json::Value = serde_json::from_str(&m).unwrap();
                if v["t"] == "status" {
                    titles.push(v["s"]["title"].as_str().unwrap_or("").to_string());
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(panes.status(id).blocked, "the bell rang");
        assert!(
            titles.iter().any(|t| t == "c"),
            "the header hears titles: {titles:?}"
        );
        // A repeat of what was said is not said again.
        let s = panes.status(id);
        panes.changed(id, &s);
        let mut dots = Vec::new();
        while let Ok(m) = ev.try_recv() {
            dots.push(m);
        }
        assert_eq!(
            dots.len(),
            2,
            "the start and the bell, nothing per title: {dots:?}"
        );
        assert!(dots[1].contains("\"blocked\":true"), "{dots:?}");
        live.stop();
    }
}
