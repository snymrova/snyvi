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
/// Output after a quiet spell is framed this long after it starts, not at the
/// first read: a program's redraw arrives in several reads, and framing the
/// first alone sent a torn half of it and then the rest -- two frames, two
/// paints, for one redraw. Short enough that a key's echo does not lag.
const SETTLE: Duration = Duration::from_millis(4);
/// A synchronized update (mode 2026) is framed when it ends, or after this --
/// what terminals that speak the mode hold one for at most, so a program that
/// never ends its update is not frozen.
const SYNC_AT_MOST: Duration = Duration::from_millis(150);
/// How often a pane that has kept new lines writes its text down, so a daemon
/// that is killed rather than stopped loses at most this much of them.
const PERSIST_EVERY: Duration = Duration::from_secs(15);
/// And a pane whose screen alone changed -- a spinner, a clock, an agent
/// thinking -- this often: the whole text is written each time, up to the
/// scrollback cap, and a working panel's screen is never still for fifteen
/// seconds.
const PERSIST_SCREEN_EVERY: Duration = Duration::from_secs(60);
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
/// How long after its last output a pane still counts as busy, for a restart
/// that waits for quiet. A build that prints a line a minute is not done; a
/// shell at its prompt has printed nothing for longer than this.
pub const BUSY_OUTPUT: Duration = Duration::from_secs(90);
/// How long a resume mark is honoured once someone looks: the clock starts
/// at the first desk a window shows after the daemon came up, not at the
/// start -- an update applied while nobody was here must not have spent the
/// marks before anyone could see them. A window that shows a desk within
/// this starts `claude --resume` in the marked panes; after it, an unspent
/// mark becomes an offer (`Status::offer`), because a conversation left that
/// long is the reader's to pick up, not a restart's to assume. See
/// `Panes::arm_marks`.
const RESUME_FOR: Duration = Duration::from_secs(5 * 60);
/// However long nobody looks, the marks and offers go this long after the
/// daemon came up: a conversation a day old is not coming back by itself.
const MARKS_AT_MOST: Duration = Duration::from_secs(24 * 3600);
/// An agent that says `working` and has printed nothing this long is not
/// working: a Claude stopped with Esc says nothing more, while one that is
/// working repaints its spinner every second.
const WORKING_SILENT: Duration = Duration::from_secs(10 * 60);
/// A pane busy only because its program keeps printing -- a log tail, a
/// watcher, a dev server -- counts for at most this long, or an update
/// would wait on it forever.
const PRINTING_AT_MOST: Duration = Duration::from_secs(2 * 3600);

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
    /// This pane was running Claude when the last daemon went on purpose --
    /// a planned restart -- so the window's next start of it should be
    /// `claude --resume` rather than the shell. Set by `mark_resume` for a
    /// pane that has not run since, cleared by its first start, and honoured
    /// for `RESUME_FOR` after a window first shows a desk. The page reads it
    /// off the same status frame that tells it the pane lost its process.
    pub resume: bool,
    /// Claude was open in this pane when the last daemon stopped without
    /// planning to (`snyvi stop`, a signal, a reboot), or it was marked to
    /// resume and nobody looked in time: nothing starts it again, but the
    /// page offers the conversation back with one click. Cleared by the
    /// pane's first start, like `resume`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub offer: bool,
    /// The folder the shell is in now, as the kernel says -- not where it was
    /// started. Empty until it has been asked, and on Windows, which has no
    /// cheap answer.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cwd: String,
    /// Which model the agent in this pane is, and how full its context window
    /// is, as Claude Code's status line said after its last reply
    /// (`crate::statusline`). Empty for a shell or another agent, and cleared
    /// with `agent` when the session ends.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_pct: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_size: Option<u64>,
    /// The tokens in the context window now, exact where `ctx_pct` rounds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctx_at: Option<i64>,
    /// When snyvi last spoke to the agent in this pane about its desk: the
    /// brief at a start, or the changes at a prompt (`crate::brief::changes`).
    /// What the next prompt's changes are counted from. The daemon's own, not
    /// the page's; 0 is "never", and a pane at 0 is told nothing but stamped.
    #[serde(skip)]
    pub told_at: i64,
}

/// The session is over: what it said about its model goes with it.
fn clear_context(s: &mut Status) {
    s.model.clear();
    s.ctx_pct = None;
    s.ctx_size = None;
    s.ctx_used = None;
    s.ctx_at = None;
}

/// A token count as the page writes it, reduced to what would change the
/// text: thousands under a million ("412k"), tenths of a million above
/// ("1.2M"), the two ranges kept apart.
fn ctx_figure(used: Option<u64>) -> Option<u64> {
    used.map(|n| match n {
        0..1_000_000 => n / 1000,
        _ => 1_000_000 + n / 100_000,
    })
}

/// The states an agent reports through its hooks. `needs_you` is Claude's
/// precise version of `blocked`: a permission prompt, not a bell.
pub const AGENT_STATES: [&str; 3] = ["working", "needs_you", "done"];

struct Proc {
    master: Box<dyn MasterPty + Send>,
    /// What goes to the program: keys, pastes, the terminal's answers. Handed
    /// to a thread that does the writing (`write_loop`), because a write to a
    /// program that is not reading blocks, and it used to block holding the
    /// pane's lock on one of the daemon's two workers -- stalling the frame
    /// task, and the reader, which then could not drain the program's output
    /// so that it would ever read again.
    input: std::sync::mpsc::Sender<Vec<u8>>,
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
    /// Of that, something more than the screen: lines kept, or the last run's
    /// text gone or grown. Written at the next `PERSIST_EVERY`; a change to
    /// the screen alone waits for `PERSIST_SCREEN_EVERY`.
    unsaved_lines: bool,
    /// When the text was last written down.
    saved_at: Instant,
    /// Bumped by each start, so the threads of a process that has been
    /// replaced do not write into the one that replaced it.
    run: u64,
    /// The folder the running process was started in, for the git tick.
    cwd: String,
    /// When the process started, and whether its shell has been seen in
    /// `cwd` since: between the fork and the child's `chdir` the kernel names
    /// the daemon's own folder, and a tick that lands there is not a move.
    started: Instant,
    arrived: bool,
    /// The desk's own folder. git's `status` is asked only inside it: a
    /// repository's own config can name commands that `status` runs (a
    /// filter driver), and a shell can `cd` into any repository at all.
    root: String,
    /// When the process last printed anything, for `busy`: a pane whose
    /// program is still writing is not one to restart the daemon under.
    wrote: Instant,
    /// When the present run of output began: the first print after
    /// `busy_output` of quiet. See `PRINTING_AT_MOST`.
    printing_since: Instant,
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
            self.unsaved_lines = true;
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
    /// How many of the pages watching have this pane out of sight -- a
    /// document read over the desk, a window hidden, no room in the grid. A
    /// pane every watcher has out of sight is framed as if nobody watched.
    slow: std::sync::atomic::AtomicUsize,
}

/// What `start` needs to know that is not the pane's own.
pub struct Start<'a> {
    pub cwd: &'a str,
    /// The desk's folder: see `Inner.root`.
    pub root: &'a str,
    pub cmd: &'a str,
    pub desk: &'a str,
    pub slot: i64,
    pub cols: u16,
    pub rows: u16,
    /// The accent the window is wearing, `#rrggbb`, for the prompt snyvi
    /// dresses the shell in. Empty when the page did not say.
    pub accent: &'a str,
    /// The pane comes back as its shell while its conversation is still on
    /// offer: the page's own resume found the mark lapsed (`start_pane`).
    pub offer: bool,
    /// The desk's keys, `NAME=value`, for the child's environment and nowhere
    /// else: not in the status, not in the text, not in a frame.
    pub env: &'a [(String, String)],
}

/// Told a panel's id and the folder its shell is now in.
type CwdSink = Box<dyn Fn(&str, &str) + Send + Sync>;

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
    /// Held while a pane's text is built and written, and while one is
    /// deleted, so the tick's write on its own thread never lands on top of a
    /// close's, or brings back a file a discard has just removed.
    writing: Mutex<()>,
    /// What each pane last said on that stream: `(running, blocked, agent)`.
    /// Forgotten with the pane.
    told: Mutex<HashMap<String, (bool, bool, &'static str)>>,
    /// The panes the last daemon marked to resume or to offer, and the
    /// clocks on them. See `Marks`.
    marks: Mutex<Marks>,
    /// Where a pane's shell has moved to is written down through this -- the
    /// store's `set_pane_cwd`, given by the server, since panes have no store.
    cwd_sink: Mutex<Option<CwdSink>>,
}

impl Panes {
    pub fn new(data_dir: &std::path::Path, events: broadcast::Sender<String>) -> Arc<Panes> {
        let panes = Arc::new(Panes {
            live: Mutex::new(HashMap::new()),
            dir: data_dir.join("panes"),
            git: Mutex::new(HashMap::new()),
            events,
            writing: Mutex::new(()),
            told: Mutex::new(HashMap::new()),
            marks: Mutex::new(Marks::default()),
            cwd_sink: Mutex::new(None),
        });
        // A daemon killed rather than stopped keeps what it had up to the
        // last of these.
        let weak = Arc::downgrade(&panes);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(PERSIST_EVERY);
            loop {
                tick.tick().await;
                let Some(p) = weak.upgrade() else { return };
                let _ = tokio::task::spawn_blocking(move || p.persist_all(false)).await;
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
                status: Status {
                    resume: self.marked(id),
                    offer: self.offered(id),
                    ..Status::default()
                },
                old,
                unsaved: false,
                unsaved_lines: false,
                saved_at: Instant::now(),
                run: 0,
                cwd: String::new(),
                started: Instant::now(),
                arrived: false,
                root: String::new(),
                wrote: Instant::now(),
                printing_since: Instant::now(),
            }),
            tx,
            wake: Notify::new(),
            watched: Notify::new(),
            slow: std::sync::atomic::AtomicUsize::new(0),
        });
        live.insert(id.to_string(), l.clone());
        drop(live);
        tokio::spawn(frames(Arc::downgrade(&l), Arc::downgrade(self)));
        l
    }

    /// What each running pane's folder is on, asked of git and told to the
    /// pages that are watching. One question per folder per tick, and a folder
    /// that answers slowly is asked less often: see `GIT_BACKOFF`. Only for a
    /// pane a page is watching: with no window open, or a desk nobody is
    /// showing, it was a `git status` every three seconds for nobody. A pane
    /// watched again is asked on the next tick.
    async fn git_tick(self: &Arc<Self>) {
        self.follow_folders();
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        // Each folder, whether a pane in it is inside its desk's folder, and
        // the panes in it.
        let mut by_dir: HashMap<String, (bool, Vec<Arc<Live>>)> = HashMap::new();
        for l in live {
            if l.tx.receiver_count() == 0 {
                continue;
            }
            if let Some((cwd, home)) = l.running_in() {
                let e = by_dir.entry(cwd).or_default();
                e.0 |= home;
                e.1.push(l);
            }
        }
        // A folder nothing runs in any more is not worth remembering.
        self.git
            .lock()
            .unwrap()
            .retain(|d, _| by_dir.contains_key(d));
        for (dir, (home, panes)) in by_dir {
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
                // The branch is read from files; whether the tree has changes
                // runs git, which only the desk's own folder gets to steer.
                let dirty = if home {
                    crate::project::modified(p)
                } else {
                    None
                };
                (crate::project::head_of(p), dirty)
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
    /// A pane not yet woken still says whether it is marked to resume: the
    /// desks' list is what a page that reloaded on a new bundle draws from.
    pub fn status(&self, id: &str) -> Status {
        self.live
            .lock()
            .unwrap()
            .get(id)
            .map(|l| l.inner.lock().unwrap().status.clone())
            .unwrap_or_else(|| Status {
                resume: self.marked(id),
                offer: self.offered(id),
                ..Status::default()
            })
    }

    /// The panes a restart should wait for, and an update: see `is_busy`.
    pub fn busy(&self) -> Vec<String> {
        let now = Instant::now();
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        let mut out: Vec<String> = live
            .iter()
            .filter(|l| {
                let i = l.inner.lock().unwrap();
                is_busy(
                    &i.status,
                    now.saturating_duration_since(i.wrote),
                    now.saturating_duration_since(i.printing_since),
                )
            })
            .map(|l| l.id.clone())
            .collect();
        out.sort();
        out
    }

    /// The running panes an agent has reported from, which is what a planned
    /// exit marks for `--resume`. Whether each one's conversation is known is
    /// the store's to say; this is only which panes had an agent in them.
    pub fn with_agent(&self) -> Vec<String> {
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        live.iter()
            .filter(|l| {
                let s = &l.inner.lock().unwrap().status;
                s.running && !s.agent.is_empty()
            })
            .map(|l| l.id.clone())
            .collect()
    }

    /// The panes the last daemon marked on its planned way out. Read from
    /// the store once at start and held until someone looks, and then for
    /// `RESUME_FOR` (see `arm_marks`); a window that asks for one of them
    /// back in that time gets `claude --resume`, and after it the offer.
    pub fn mark_resume(&self, ids: Vec<String>) {
        {
            let mut m = self.marks.lock().unwrap();
            m.resume = ids.into_iter().collect();
            m.resume_until = None;
            m.cap = Instant::now() + MARKS_AT_MOST;
        }
        self.refresh_marks();
    }

    /// The first desk a window shows after the daemon came up starts the
    /// resume marks' clock. Once per daemon: a later look is not a first.
    pub fn arm_marks(&self) {
        {
            let mut m = self.marks.lock().unwrap();
            if m.resume_until.is_some() {
                return;
            }
            m.resume_until = Some(Instant::now() + resume_for());
        }
        self.refresh_marks();
    }

    /// A pane already woken says what the marks say now -- a page arrived
    /// before the marks were read, which the order in `server::run` rules
    /// out, or a mark lapsed into an offer. Cheap to hold to.
    fn refresh_marks(&self) {
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in live {
            let (marked, offered) = (self.marked(&l.id), self.offered(&l.id));
            let mut i = l.inner.lock().unwrap();
            if !i.status.running {
                i.status.resume = marked;
                i.status.offer = offered;
            }
        }
    }

    /// The marks still unspent, as they stand now -- to resume, then to
    /// offer -- for an exit to write back: a daemon that goes before anyone
    /// looked must not take the last one's marks with it. A pane started
    /// since has spent its mark (`unmark`).
    pub fn unspent(&self) -> (Vec<String>, Vec<String>) {
        let now = Instant::now();
        let m = self.marks.lock().unwrap();
        let mut resume: Vec<String> = m
            .resume
            .iter()
            .filter(|id| m.resume(id, now))
            .cloned()
            .collect();
        let mut offer: Vec<String> = m
            .resume
            .union(&m.offer)
            .filter(|id| m.offer(id, now))
            .cloned()
            .collect();
        resume.sort();
        offer.sort();
        (resume, offer)
    }

    /// Whether a pane is marked to come back as its conversation, now.
    pub fn marked(&self, id: &str) -> bool {
        self.marks.lock().unwrap().resume(id, Instant::now())
    }

    fn unmark(&self, id: &str) {
        let mut m = self.marks.lock().unwrap();
        m.resume.remove(id);
        m.offer.remove(id);
    }

    /// The panes that had Claude open when the last daemon stopped unplanned:
    /// read once at start, like `mark_resume`, and held as long as a mark
    /// can be.
    pub fn mark_offer(&self, ids: Vec<String>) {
        {
            let mut m = self.marks.lock().unwrap();
            m.offer = ids.into_iter().collect();
            m.cap = Instant::now() + MARKS_AT_MOST;
        }
        self.refresh_marks();
    }

    /// Whether a pane's conversation is offered back, now.
    pub fn offered(&self, id: &str) -> bool {
        self.marks.lock().unwrap().offer(id, Instant::now())
    }

    /// How a moved shell's folder is written down. Set once, by the server.
    pub fn on_cwd(&self, sink: CwdSink) {
        *self.cwd_sink.lock().unwrap() = Some(sink);
    }

    /// Ask the kernel where each running shell is, and when one has moved, say
    /// so: in its status, for the page; in `Inner.cwd`, for the git tick; and
    /// through the sink, so the next start is there too. The kernel and not
    /// the terminal's folder report (OSC 7): that is text any program in the
    /// panel can print, and this folder decides where the daemon runs git.
    fn follow_folders(&self) {
        // Long enough for any fork to reach its `chdir`, short enough that a
        // shell that moves at once is still followed on the next tick.
        const ARRIVE_WITHIN: Duration = Duration::from_secs(1);
        let live: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in live {
            let Some(now) = l.shell_cwd() else { continue };
            // The kernel answers with the folder resolved -- macOS's /var is
            // /private/var, and any folder reached through a link -- so the
            // one the pane was started in is not a move to where it is.
            let (was, settling) = {
                let i = l.inner.lock().unwrap();
                (
                    i.cwd.clone(),
                    !i.arrived && i.started.elapsed() < ARRIVE_WITHIN,
                )
            };
            if was == now || same_folder(&was, &now) {
                l.inner.lock().unwrap().arrived = true;
                continue;
            }
            // Not there yet: the child has not reached its folder, and what
            // the kernel names is where the daemon is.
            if settling {
                continue;
            }
            let s = {
                let mut i = l.inner.lock().unwrap();
                if i.cwd != was || !i.status.running {
                    continue;
                }
                i.cwd = now.clone();
                i.status.cwd = now.clone();
                i.status.clone()
            };
            let _ = l.tx.send(status_frame(&l.id, &s).into());
            if let Some(sink) = self.cwd_sink.lock().unwrap().as_ref() {
                sink(&l.id, &now);
            }
        }
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
        if state.is_empty() {
            clear_context(&mut i.status);
            i.status.told_at = 0;
        }
        let s = i.status.clone();
        drop(i);
        let _ = l.tx.send(status_frame(&l.id, &s).into());
        self.changed(&l.id, &s);
        true
    }

    /// snyvi is about to tell the agent in this pane about its desk, as of
    /// `now`: when it last did so (0 for never), with `now` written in its
    /// place. `None` when the pane is not running. Read-and-stamp in one
    /// step, so two prompts in a row never count the same change twice.
    pub fn told(&self, id: &str, now: i64) -> Option<i64> {
        let l = self.live.lock().unwrap().get(id).cloned()?;
        let mut i = l.inner.lock().unwrap();
        if !i.status.running {
            return None;
        }
        let was = i.status.told_at;
        i.status.told_at = now;
        Some(was)
    }

    /// The model and the context window, as the status line in this pane last
    /// said them. `None` when the pane is not running; otherwise whether what
    /// the reader sees changed. Only such a change is sent on: the line runs
    /// after every reply, and most replies move the percentage by less than
    /// one and the count by less than its figure shows (`ctx_figure`).
    pub fn set_context(
        &self,
        id: &str,
        model: &str,
        pct: Option<u8>,
        size: Option<u64>,
        used: Option<u64>,
    ) -> Option<bool> {
        let l = self.live.lock().unwrap().get(id).cloned()?;
        let mut i = l.inner.lock().unwrap();
        if !i.status.running {
            return None;
        }
        let st = &i.status;
        if st.model == model
            && st.ctx_pct == pct
            && st.ctx_size == size
            && ctx_figure(st.ctx_used) == ctx_figure(used)
        {
            i.status.ctx_used = used;
            return Some(false);
        }
        i.status.model = model.to_string();
        i.status.ctx_pct = pct;
        i.status.ctx_size = size;
        i.status.ctx_used = used;
        i.status.ctx_at = Some(crate::store::now());
        let s = i.status.clone();
        drop(i);
        let _ = l.tx.send(status_frame(&l.id, &s).into());
        self.changed(&l.id, &s);
        Some(true)
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

    /// The process on a pane is stopped and the pane is forgotten here, its
    /// text written down and kept -- which is what closing a pane does: the
    /// store keeps the row for Undo, and a pane brought back shows its last
    /// screen, greyed, as after a restart.
    pub fn forget(&self, id: &str) {
        let l = self.live.lock().unwrap().remove(id);
        if let Some(l) = l {
            let _w = self.writing.lock().unwrap();
            let text = {
                let mut i = l.inner.lock().unwrap();
                i.unsaved.then(|| {
                    i.unsaved = false;
                    i.unsaved_lines = false;
                    keep_text(&i.old, i.screen.text())
                })
            };
            if let Some(text) = text {
                self.write_text(&l.id, &text);
            }
            l.stop();
        }
        self.told.lock().unwrap().remove(id);
    }

    /// Every pane: stopped, forgotten, and its text gone. A reset.
    pub fn clear(&self) {
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().drain().map(|(_, l)| l).collect();
        self.told.lock().unwrap().clear();
        for l in all {
            l.stop();
        }
        let _w = self.writing.lock().unwrap();
        let _ = std::fs::remove_dir_all(&self.dir);
    }

    /// Stop everything and write it down: the daemon is going.
    pub fn shutdown(&self) {
        // Where each shell is, one last time, so each comes back there.
        self.follow_folders();
        self.persist_all(true);
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in all {
            l.stop();
        }
    }

    /// Write down the text of every pane that is due (`PERSIST_EVERY`,
    /// `PERSIST_SCREEN_EVERY`), or of every pane that changed at all. Blocking
    /// work: the text is built under the pane's lock and written to disk, so
    /// the tick runs it on a blocking thread, not on one of the two workers.
    fn persist_all(&self, all: bool) {
        let panes: Vec<Arc<Live>> = self.live.lock().unwrap().values().cloned().collect();
        for l in panes {
            let _w = self.writing.lock().unwrap();
            // Let go of while this waited: `let_go` wrote it down, or it was
            // discarded and its file must stay gone.
            if !self.holds(&l) {
                continue;
            }
            let text = {
                let mut i = l.inner.lock().unwrap();
                let due = all || i.unsaved_lines || i.saved_at.elapsed() >= PERSIST_SCREEN_EVERY;
                if !i.unsaved || !due {
                    continue;
                }
                i.unsaved = false;
                i.unsaved_lines = false;
                i.saved_at = Instant::now();
                keep_text(&i.old, i.screen.text())
            };
            self.write_text(&l.id, &text);
        }
    }

    /// Whether `l` is still this id's pane: one let go of has had its text
    /// written down by `let_go`, or deleted, and must not be written again.
    fn holds(&self, l: &Live) -> bool {
        self.live
            .lock()
            .unwrap()
            .get(&l.id)
            .is_some_and(|m| std::ptr::eq(Arc::as_ptr(m), l))
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

/// Whether a pane is one a restart should wait for, and an update. The
/// rule on its own, so it can be read and tested without a process. A
/// running pane is busy while its agent waits on the reader (`needs_you`:
/// a restart would take the question away unanswered), while it is mid-turn
/// and printing (`WORKING_SILENT`), or while its program printed something
/// less than `BUSY_OUTPUT` ago, for at most `PRINTING_AT_MOST` of unbroken
/// printing. `since_output` is how long since it last printed, and
/// `printing_for` how long the present run of printing has gone on.
pub fn is_busy(s: &Status, since_output: Duration, printing_for: Duration) -> bool {
    if !s.running {
        return false;
    }
    match s.agent {
        "needs_you" => true,
        "working" => since_output < WORKING_SILENT,
        _ => since_output < busy_output() && printing_for < PRINTING_AT_MOST,
    }
}

/// The panes the last daemon marked, and their clocks. A resume mark holds
/// from the start until `resume_until`, which is unset until someone looks;
/// past it, an unspent mark is an offer. Everything goes at `cap`.
struct Marks {
    resume: std::collections::HashSet<String>,
    offer: std::collections::HashSet<String>,
    resume_until: Option<Instant>,
    cap: Instant,
}

impl Default for Marks {
    fn default() -> Marks {
        Marks {
            resume: Default::default(),
            offer: Default::default(),
            resume_until: None,
            cap: Instant::now(),
        }
    }
}

impl Marks {
    fn resume(&self, id: &str, now: Instant) -> bool {
        now < self.cap && self.resume_until.is_none_or(|t| now < t) && self.resume.contains(id)
    }
    fn offer(&self, id: &str, now: Instant) -> bool {
        now < self.cap
            && (self.offer.contains(id)
                || (self.resume.contains(id) && self.resume_until.is_some_and(|t| now >= t)))
    }
}

/// `RESUME_FOR`, unless `SNYVI_RESUME_S` says otherwise, for
/// bench/restart.mjs, which cannot wait five minutes. Read once.
fn resume_for() -> Duration {
    static FOR: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *FOR.get_or_init(|| {
        std::env::var("SNYVI_RESUME_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .map(Duration::from_secs)
            .unwrap_or(RESUME_FOR)
    })
}

/// `BUSY_OUTPUT`, unless `SNYVI_QUIET_S` says otherwise: bench/restart.mjs
/// proves the wait on a daemon of its own and cannot spend ninety seconds
/// on every push doing it. Read once.
fn busy_output() -> Duration {
    static QUIET: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *QUIET.get_or_init(|| {
        std::env::var("SNYVI_QUIET_S")
            .ok()
            .and_then(|s| s.parse().ok())
            .map(Duration::from_secs)
            .unwrap_or(BUSY_OUTPUT)
    })
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// How much of the last run's text a page is sent at once, as JSON: the end
/// of it, which is what sits just above the new run. Older lines come as the
/// reader scrolls up to them (`Live::more`).
const OLD_BYTES: usize = 64 * 1024;

/// The last run's text as a page is sent it: the newest lines of it, above
/// the `have` it holds already when it asked for more, as many as fit in
/// `OLD_BYTES` and `max`. `more` is how many are left above those, and `g`
/// is the run it belongs to, for the page to ask with.
fn old_frame(id: &str, old: &[String], run: u64, have: Option<usize>, max: usize) -> String {
    let end = old.len().saturating_sub(have.unwrap_or(0));
    let (mut from, mut size) = (end, 0);
    while from > 0 && end - from < max {
        let n = old[from - 1].len() + 3;
        if size + n > OLD_BYTES && from < end {
            break;
        }
        size += n;
        from -= 1;
    }
    let mut out = String::with_capacity(size + 96);
    out.push_str("{\"t\":\"old\",\"p\":");
    screen::push_json_str(&mut out, id);
    out.push_str(&format!(",\"g\":{run},\"more\":{from}"));
    if let Some(h) = have {
        out.push_str(&format!(",\"have\":{h}"));
    }
    out.push_str(",\"lines\":[");
    for (k, l) in old[from..end].iter().enumerate() {
        if k > 0 {
            out.push(',');
        }
        screen::push_json_str(&mut out, l);
    }
    out.push_str("]}");
    out
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
            first.push(old_frame(&self.id, &i.old, i.run, None, usize::MAX));
        }
        first.push(i.screen.snapshot(&self.id, &i.shown));
        (first, self.tx.subscribe())
    }

    /// A page watching this pane has it out of sight (`true`), or has it back
    /// in sight: then it is caught up at once, as a page that attaches is.
    /// Every `true` is matched by one `false`, which `server::desk_session`
    /// owes when it stops watching.
    pub fn pace(&self, slow: bool) {
        use std::sync::atomic::Ordering;
        if slow {
            self.slow.fetch_add(1, Ordering::Relaxed);
        } else {
            // Down by one, never below none: a loop rather than fetch_update,
            // which newer toolchains call deprecated and older ones lack the
            // new name of.
            let mut n = self.slow.load(Ordering::Relaxed);
            while n > 0 {
                match self.slow.compare_exchange_weak(
                    n,
                    n - 1,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(now) => n = now,
                }
            }
            self.watched.notify_one();
        }
    }

    /// Older scrollback, for a page scrolled up to the top of what it holds:
    /// see `Screen::more`. With `old`, it is the last run's text instead, and
    /// `before` is how many of its lines the page holds already; `run` says
    /// which run's text that was, and a page asking about one that has since
    /// been replaced is told nothing.
    pub fn more(&self, old: Option<u64>, before: usize, max: usize) -> Option<String> {
        let i = self.inner.lock().unwrap();
        match old {
            None => Some(i.screen.more(&self.id, before, max)),
            Some(run) if run == i.run => {
                Some(old_frame(&self.id, &i.old, i.run, Some(before), max))
            }
            Some(_) => None,
        }
    }

    /// Keys from the reader, and only from the reader: this is called for a
    /// frame the page sent from a key or a paste, never for anything snyvi
    /// received. It is also what un-blocks a pane -- the reader has answered.
    pub fn input(&self, bytes: &[u8], panes: &Panes) {
        let mut i = self.inner.lock().unwrap();
        let Some(p) = i.proc.as_ref() else { return };
        let _ = p.input.send(bytes.to_vec());
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
        i.started = Instant::now();
        i.arrived = false;
        i.root = s.root.to_string();
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "snyvi");
        cmd.env("SNYVI_SESSION", &self.id);
        cmd.env("SNYVI_DESK", s.desk);
        cmd.env("SNYVI_SLOT", s.slot.to_string());
        for (k, v) in s.env {
            cmd.env(k, v);
        }
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
            input: write_loop(writer, &self.id),
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
            // Whatever this start is, the mark is spent: a window that chose
            // the shell over the conversation has chosen.
            resume: false,
            offer: s.offer,
            cwd: s.cwd.to_string(),
            // A new process has told nothing yet about any model.
            ..Status::default()
        };
        i.wrote = Instant::now();
        i.printing_since = i.wrote;
        i.unsaved = true;
        i.unsaved_lines = true;
        panes.unmark(&self.id);
        let status = i.status.clone();
        let _ = self.tx.send(status_frame(&self.id, &status).into());
        if !i.old.is_empty() {
            let old = old_frame(&self.id, &i.old, i.run, None, usize::MAX);
            let _ = self.tx.send(old.into());
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
            i.unsaved_lines = false;
            i.saved_at = Instant::now();
            (i.status.clone(), keep_text(&i.old, i.screen.text()))
        };
        {
            // A pane discarded is killed on its way out, and this runs after:
            // writing here would bring back the file `discard` just deleted.
            let _w = panes.writing.lock().unwrap();
            if panes.holds(self) {
                panes.write_text(&self.id, &text);
            }
        }
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

/// The thread that writes a process's input, in the order it was sent. It
/// ends, and closes its end of the PTY, when the process's `Proc` goes and
/// with it the last sender -- or when a write fails, the program gone.
fn write_loop(mut writer: Box<dyn Write + Send>, id: &str) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let _ = std::thread::Builder::new()
        .name(format!("input {}", &id[..8.min(id.len())]))
        .spawn(move || {
            for bytes in rx {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    return;
                }
            }
        });
    tx
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
                unsaved_lines,
                wrote,
                printing_since,
                ..
            } = &mut *i;
            let lines = screen.lines_ever();
            screen.feed(parser, &buf[..n]);
            *unsaved = true;
            if screen.lines_ever() != lines || screen.scrollback_cleared() {
                *unsaved_lines = true;
            }
            let now = Instant::now();
            if now.saturating_duration_since(*wrote) >= busy_output() {
                *printing_since = now;
            }
            *wrote = now;
            if !screen.replies.is_empty() {
                let replies = std::mem::take(&mut screen.replies);
                if let Some(p) = proc.as_ref() {
                    let _ = p.input.send(replies);
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
    // A synchronized update is open: the frame waits for its end, or this.
    let mut hold: Option<Instant> = None;
    loop {
        let Some(l) = me.upgrade() else { return };
        // Waiting holds only the Notify, not the pane: a pane that has been
        // closed drops, and this ends at the next wake or the upgrade above.
        let notified = {
            let l2 = l.clone();
            drop(l);
            async move { l2.wake.notified().await }
        };
        let wait = hold.map_or(Duration::from_secs(30), |t| {
            t.saturating_duration_since(Instant::now())
        });
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(wait) => if hold.is_none() { continue },
        }
        let since = last.elapsed();
        if since >= gap && hold.is_none() {
            tokio::time::sleep(SETTLE).await;
        } else if since < gap {
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
        hold = i.screen.holding(SYNC_AT_MOST);
        if hold.is_some() {
            continue;
        }
        let frame = i.frame_now(&l.id);
        gap = match &frame {
            // Nobody watching, or everybody watching with it out of sight.
            _ if l.tx.receiver_count() <= l.slow.load(std::sync::atomic::Ordering::Relaxed) => {
                UNWATCHED_FRAME
            }
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
    /// The folder this pane's process is in now, as the kernel reports it.
    fn shell_cwd(&self) -> Option<String> {
        let pid = {
            let i = self.inner.lock().unwrap();
            if !i.status.running {
                return None;
            }
            i.status.pid?
        };
        folder_of(pid)
    }

    /// The folder the running process is in, and whether that is inside the
    /// desk's own folder (see `Inner.root`).
    fn running_in(&self) -> Option<(String, bool)> {
        let (cwd, root) = {
            let i = self.inner.lock().unwrap();
            if !i.status.running || i.cwd.is_empty() {
                return None;
            }
            (i.cwd.clone(), i.root.clone())
        };
        // Both resolved: the folder may be the kernel's answer (see
        // `follow_folders`) and the root as the desk was made.
        let real = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
        let home = !root.is_empty() && real(&cwd).starts_with(real(&root));
        Some((cwd, home))
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

/// A process's working folder. Linux reads `/proc/<pid>/cwd`; macOS asks
/// `proc_pidinfo`; anywhere else there is no answer, and a pane's folder
/// stays the one it started in.
#[cfg(target_os = "linux")]
pub fn folder_of(pid: u32) -> Option<String> {
    let p = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
    p.is_dir().then(|| p.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
pub fn folder_of(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer is a zeroed struct of exactly the size passed, the
    // layout the kernel fills for this flavour.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if n != size {
        return None;
    }
    let raw: &[libc::c_char] = unsafe {
        std::slice::from_raw_parts(
            info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char,
            std::mem::size_of_val(&info.pvi_cdir.vip_path),
        )
    };
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    let p = String::from_utf8(bytes).ok()?;
    std::path::Path::new(&p).is_dir().then_some(p)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn folder_of(_pid: u32) -> Option<String> {
    None
}

/// Two spellings of one folder: through a link, or with /private in front.
fn same_folder(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
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
    fn a_context_count_moves_when_its_figure_would() {
        let f = |n: u64| ctx_figure(Some(n));
        assert_eq!(f(412_000), f(412_999), "412k either way");
        assert_ne!(f(412_999), f(413_000));
        assert_eq!(f(1_200_000), f(1_299_999), "1.2M either way");
        assert_ne!(f(1_299_999), f(1_300_000));
        assert_ne!(f(999_999), f(1_000_000), "999k is not 1.0M");
        assert_ne!(f(10_000), f(1_000_000), "10k is not 1.0M");
        assert_eq!(ctx_figure(None), None);
    }

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

    /// The quiet predicate, over what a restart and an update look at: an
    /// agent waiting on its reader, one mid-turn, or a program still
    /// printing is busy; a stopped pane, one that finished a turn, and one
    /// at its prompt for a while are not -- and neither is an agent silent
    /// past `WORKING_SILENT`, nor a program that has printed without a
    /// break for `PRINTING_AT_MOST`.
    #[test]
    fn a_restart_waits_for_agents_and_recent_output_but_not_forever() {
        let s = |running: bool, agent: &'static str| Status {
            running,
            agent,
            ..Status::default()
        };
        let long_ago = BUSY_OUTPUT + Duration::from_secs(1);
        let just_now = Duration::from_secs(1);
        let a_while = Duration::from_secs(60);
        let silent = WORKING_SILENT + Duration::from_secs(1);
        let for_ever = PRINTING_AT_MOST + Duration::from_secs(1);
        assert!(is_busy(&s(true, "working"), long_ago, a_while));
        assert!(is_busy(&s(true, ""), just_now, a_while));
        assert!(is_busy(&s(true, "done"), just_now, a_while));
        assert!(!is_busy(&s(true, ""), long_ago, a_while));
        assert!(!is_busy(&s(true, "done"), long_ago, a_while));
        // An approval waiting is never cut off, however long it waits.
        assert!(is_busy(&s(true, "needs_you"), long_ago, a_while));
        assert!(is_busy(&s(true, "needs_you"), silent, for_ever));
        // A turn stopped with Esc says `working` and nothing more.
        assert!(!is_busy(&s(true, "working"), silent, a_while));
        // A log tail is busy for two hours, and then it is not.
        assert!(is_busy(&s(true, ""), just_now, PRINTING_AT_MOST - a_while));
        assert!(!is_busy(&s(true, ""), just_now, for_ever));
        assert!(!is_busy(&s(true, "done"), just_now, for_ever));
        assert!(!is_busy(&s(false, "working"), just_now, a_while));
        assert!(!is_busy(&s(false, "needs_you"), just_now, a_while));
        assert!(!is_busy(&s(false, ""), just_now, a_while));
    }

    /// The marks wait for someone to look: ten minutes with nobody here
    /// spends nothing. The first look starts `RESUME_FOR`; past it, an
    /// unspent resume is an offer; past the cap, nothing is either.
    #[test]
    fn a_mark_waits_for_a_look_then_lapses_into_an_offer() {
        let t0 = Instant::now();
        let m = |until: Option<Instant>| Marks {
            resume: ["r".to_string()].into(),
            offer: ["o".to_string()].into(),
            resume_until: until,
            cap: t0 + MARKS_AT_MOST,
        };
        let later = t0 + Duration::from_secs(10 * 60);
        // Nobody has looked: a resume holds, however long.
        assert!(m(None).resume("r", later));
        assert!(!m(None).offer("r", later));
        assert!(m(None).offer("o", later));
        // Looked at ten minutes: it holds five more, then is an offer.
        let armed = m(Some(later + RESUME_FOR));
        assert!(armed.resume("r", later + Duration::from_secs(60)));
        assert!(!armed.resume("r", later + RESUME_FOR));
        assert!(armed.offer("r", later + RESUME_FOR));
        assert!(!armed.resume("o", later), "an offer is never a resume");
        // A day on, nothing is anything.
        let day = t0 + MARKS_AT_MOST;
        assert!(!m(None).resume("r", day));
        assert!(!armed.offer("r", day));
        assert!(!armed.offer("o", day));
    }

    /// A mark is carried on the pane's status until its first start, whether
    /// the pane was woken before or after the marks were read, and past its
    /// time it is an offer.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_resume_mark_rides_the_status_until_the_pane_starts_or_it_lapses() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pane-mark");
        let (events, _) = broadcast::channel(16);
        let panes = Panes::new(&dir.path, events);
        let early = "0000000000000000000000000000000a";
        let late = "0000000000000000000000000000000b";
        let never = "0000000000000000000000000000000c";
        let woken = panes.get(early);
        assert!(!woken.attach().0[0].contains("\"resume\":true"));
        panes.mark_resume(vec![early.into(), late.into()]);
        // Woken before the marks: told. Woken after: told. Not woken: the
        // desks' list still says so. Unmarked: nothing.
        assert!(panes.status(early).resume);
        assert!(panes.get(late).attach().0[0].contains("\"resume\":true"));
        assert!(panes.status(late).resume);
        assert!(!panes.status(never).resume);
        assert!(panes.busy().is_empty(), "a stopped pane is never busy");
        // A start of any kind spends the mark; the status it sends says so.
        #[cfg(unix)]
        {
            let cwd = dir.path.to_string_lossy().to_string();
            let s = Start {
                cwd: &cwd,
                root: &cwd,
                cmd: "sleep 30",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
                offer: false,
                env: &[],
            };
            let status = panes.get(late).start(s, &panes).unwrap();
            assert!(!status.resume);
            assert!(!panes.status(late).resume);
            // And a pane that just started is busy until it has been quiet
            // for a while -- the start itself counts as output.
            assert_eq!(panes.busy(), vec![late.to_string()]);
            panes.get(late).stop();
        }
        assert!(panes.status(early).resume, "the other mark is untouched");
        // What an exit writes back: the mark nobody has spent.
        assert!(panes.unspent().0.contains(&early.to_string()));
        #[cfg(unix)]
        assert!(
            !panes.unspent().0.contains(&late.to_string()),
            "spent by its start"
        );
        // Past its time, a mark is an offer: the woken pane says so too.
        panes.arm_marks();
        panes.marks.lock().unwrap().resume_until = Some(Instant::now());
        panes.refresh_marks();
        assert!(!panes.status(early).resume);
        assert!(panes.status(early).offer);
        assert!(!panes.marked(early), "the page's own resume is refused now");
        assert!(panes.unspent().0.is_empty());
        assert!(
            panes.unspent().1.contains(&early.to_string()),
            "and written back as an offer"
        );
        assert!(!panes.get(never).attach().0[0].contains("\"resume\":true"));
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
                root: &cwd,
                cmd: "printf 'pane=%s key=%s\\n' \"$SNYVI_SESSION\" \"$SNYVI_T\"; pwd; exit 3",
                desk: "d",
                slot: 1,
                // Wide enough for a macOS temp dir, which is long enough to
                // wrap at 80 and split the name this looks for across rows.
                cols: 400,
                rows: 10,
                accent: "",
                offer: false,
                env: &[("SNYVI_T".to_string(), "x".to_string())],
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
        // The desk's keys reach the child's environment and nothing else does.
        assert!(seen.contains(&format!("pane={id} key=x")), "{seen}");
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
        // The shell leaves a file once "late" is out, and the page attaches
        // the moment it is there: a shell slow to start on a busy machine
        // moves both together, where a fixed wait once caught neither line.
        let said = dir.path.join("late-said");
        let cmd = format!(
            "printf 'early\\n'; sleep 0.3; printf 'late\\n'; : > '{}'; sleep 2",
            said.display()
        );
        live.start(
            Start {
                cwd: &cwd,
                root: &cwd,
                cmd: &cmd,
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
                offer: false,
                env: &[],
            },
            &panes,
        )
        .unwrap();
        // "late" is printed 0.3 s after "early"; the next unwatched frame is
        // a second after the first, so without a catch-up the snapshot taken
        // now would miss it.
        for _ in 0..100 {
            if said.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(said.exists(), "the shell never printed its second line");
        let (first, _rx) = live.attach();
        let snap = first.last().unwrap();
        assert!(snap.contains("late"), "{snap}");
    }

    /// A pane started in a folder reached through a link has not moved when
    /// the kernel names the folder resolved: macOS's /var is /private/var.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_folder_through_a_link_is_not_a_move() {
        let dir = crate::store::tempdir::Dir::new("snyvi-link");
        std::fs::create_dir_all(dir.path.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path.join("real"), dir.path.join("link")).unwrap();
        let (events, _ev) = broadcast::channel(64);
        let panes = Panes::new(&dir.path, events);
        let id = "00112233445566778899aabbccddeeff";
        let live = panes.get(id);
        let link = dir.path.join("link").to_string_lossy().to_string();
        live.start(
            Start {
                cwd: &link,
                root: &link,
                cmd: "sleep 30",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
                offer: false,
                env: &[],
            },
            &panes,
        )
        .unwrap();
        // Until the child is in it: between the fork and its chdir, the
        // kernel names the parent's folder.
        for _ in 0..100 {
            if live.shell_cwd().is_some_and(|c| c.ends_with("/real")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            live.shell_cwd().is_some_and(|c| c.ends_with("/real")),
            "the kernel names it resolved"
        );
        panes.follow_folders();
        assert_eq!(live.inner.lock().unwrap().cwd, link, "not a move");
        assert!(
            live.running_in().is_some_and(|(_, home)| home),
            "and still inside the desk's folder"
        );
        live.stop();
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
                root: &cwd,
                cmd: "read x",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
                offer: false,
                env: &[],
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
                root: &cwd,
                cmd: "for t in a b c d e; do printf '\\033]0;%s\\007' $t; sleep 0.05; done; printf '\\a'; read x",
                desk: "d",
                slot: 1,
                cols: 80,
                rows: 10,
                accent: "",
                offer: false,
                env: &[],
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

    /// 1.7.1: a shell that `cd`s is found where it went, by asking the
    /// kernel -- which is what brings a panel back in that folder.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_shell_that_moved_is_found_where_it_went() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pane-cwd");
        std::fs::create_dir(dir.path.join("sub")).unwrap();
        let mut child = std::process::Command::new("sh")
            .args(["-c", "cd sub && exec sleep 5"])
            .current_dir(&dir.path)
            .spawn()
            .unwrap();
        let want = std::fs::canonicalize(dir.path.join("sub")).unwrap();
        let mut seen = None;
        for _ in 0..50 {
            seen = folder_of(child.id()).map(std::path::PathBuf::from);
            if seen.as_deref() == Some(want.as_path()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(seen.as_deref(), Some(want.as_path()));
        assert_eq!(folder_of(u32::MAX), None, "no such process, no folder");
    }
}
