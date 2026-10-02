//! The local HTTP server: UI shell, JSON API, SSE, and the receive endpoint.

use crate::browse::Browser;
use crate::config::{self, Paths};
use crate::platform;
use crate::receive::{self, Payload};
use crate::render::{self, Renderer};
use crate::store::{Doc, Store};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::borrow::Cow;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The commit and target from build.rs, "" outside a checkout.
pub const BUILD_SHA: &str = env!("SNYVI_GIT_SHA");
pub const BUILD_TARGET: &str = env!("SNYVI_TARGET");

const INDEX_HTML: &str = include_str!("../ui/index.html");
/// An address snyvi has nothing at: its own miss, so the page wears `oops`
/// (docs/DESIGN.md §2.3) and offers Home. Static, with no word of the path
/// asked for, so nothing a link carried reaches the page.
const NOT_FOUND_HTML: &str = include_str!("../ui/404.html");
const APP_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/app.css"));
const APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/app.js"));
const BOOT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/boot.js"));
/// The diagram driver, imported by app.js with the first diagram and never on a
/// page without one. A module, so it is fetched rather than linked.
const MMD_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/mmd.js"));
/// The desk view: the pane grid, the painter, the keys. Loaded when a desk is
/// opened and not before, like the diagram driver -- a reader who never opens a
/// desk pays nothing for it.
const DESK_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/desk.js"));
/// The window's frame -- the bar's three buttons and what drags -- fetched
/// only inside the native window, since a tab has no window to frame.
const FRAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/frame.js"));
/// The game behind the rocket at the foot of the sidebar, fetched when the
/// rocket is pressed and never before: a reader who never presses it pays
/// nothing for it.
const GAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
/// The about panel and the reset dialog, fetched when one of them is opened:
/// neither is on the way to reading a document, and both ask the daemon
/// something the moment they open, so the module rides with that request.
const ABOUT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/about.js"));
/// Find in the document -- the bar `/` opens and the marks it lays down --
/// fetched the first time it is asked for. A reader who never searches inside
/// a document never fetches it, and the page's calls into it are no-ops until
/// it is there, because until then nothing is marked.
const FIND_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/find.js"));
/// The key mode's pill -- whether the single letters are awake -- fetched on
/// the first ⌃B, or the first letter pressed while they sleep. The gate itself
/// is in `app.js`; only what shows it is here.
const KEYS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/keys.js"));
/// What a folder and a desk can be asked to do -- the right-click menu, making
/// a desk, closing one, opening a folder -- fetched on the first such click. A
/// reader who only reads never fetches it; the sidebar draws its desks without
/// it, because drawing them is in `app.js` and only doing something is here.
const MENU_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/menu.js"));
/// ⌘K, fetched the first time it is pressed: the one box a reader summons
/// rather than meets, so first paint does not carry it.
const PALETTE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/palette.js"));
/// The theme, accent and font steppers, fetched once the page is idle or the
/// foot column is reached: nothing on screen needs them until a click there.
const LOOK_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/look.js"));
/// The aside card at the sidebar's foot, fetched when there is an aside to
/// show: a reader no agent has spoken to never pays for it.
const NOTE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/note.js"));
/// The tip every control names itself with (docs/DESIGN.md §8.1), fetched on
/// the first pointer resting on one, or the first Tab.
const TIP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/tip.js"));
/// Home, the page the mark opens: fetched when it is first shown, so a
/// reader who goes straight to a document never pays for it.
const HOME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/home.js"));
/// The toast, fetched the first time snyvi has something to say.
const TOAST_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/toast.js"));
/// A comparison and a split diff, fetched the first time either is asked for.
const DIFF_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/diff.js"));
/// A folder's page and a file read from disk, fetched when one is opened.
const BROWSE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/browse.js"));
const PATHS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/paths.js"));
/// Every theme but Paper and Ink, fetched once the page is idle: first paint
/// carries only the two defaults, and boot.js paints a returning reader's
/// own theme from a copy it kept, so the window opens as fast as it can.
const THEMES_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/themes.css"));
/// Mermaid, gzip-compressed at build time; served with Content-Encoding: gzip.
const MERMAID_JS_GZ: &[u8] = include_bytes!("../ui/mermaid.min.js.gz");
/// Content-Security-Policy for the UI. Everything comes from the daemon itself; Mermaid
/// needs inline styles for the SVG it produces, and images may be data URIs.
/// `blob:` is for a note's pictures: they come behind the desk's capability,
/// which an `<img>` cannot send, so the page fetches them and shows its own
/// object URL. Only the page itself can mint one.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const FONTS: &[(&str, &[u8])] = &[
    ("inter.woff2", include_bytes!("../ui/fonts/inter.woff2")),
    (
        "inter-italic.woff2",
        include_bytes!("../ui/fonts/inter-italic.woff2"),
    ),
    (
        "jetbrains-mono.woff2",
        include_bytes!("../ui/fonts/jetbrains-mono.woff2"),
    ),
    (
        "source-serif.woff2",
        include_bytes!("../ui/fonts/source-serif.woff2"),
    ),
    (
        "source-serif-italic.woff2",
        include_bytes!("../ui/fonts/source-serif-italic.woff2"),
    ),
    // Literata and Atkinson Hyperlegible Next (both OFL), latin cuts: two
    // more reading faces for the Aa button. Fetched only when chosen.
    (
        "literata.woff2",
        include_bytes!("../ui/fonts/literata.woff2"),
    ),
    (
        "literata-italic.woff2",
        include_bytes!("../ui/fonts/literata-italic.woff2"),
    ),
    (
        "atkinson.woff2",
        include_bytes!("../ui/fonts/atkinson.woff2"),
    ),
    (
        "atkinson-italic.woff2",
        include_bytes!("../ui/fonts/atkinson-italic.woff2"),
    ),
    // Nerd Fonts' symbols (MIT, `symbols-nerd.LICENSE`), cut to the private
    // use area: the icons a prompt draws in a pane. Fetched only when a pane
    // shows one -- the face's `unicode-range` in ui/desk.js.
    (
        "symbols-nerd.woff2",
        include_bytes!("../ui/fonts/symbols-nerd.woff2"),
    ),
];

/// Where the UI is read from.
///
/// The shipped daemon serves the five text assets `include_str!` compiled into
/// it, which is why a stylesheet change costs a rebuild: the bytes are in the
/// binary. They are the files in `ui/` with their comments and indentation
/// taken out -- `build.rs` runs each through `crate::strip` on the way in, so
/// the wire carries what a browser reads and the source keeps its prose.
/// `SNYVI_UI_DIR` points at a working tree's `ui/` instead, and every request
/// reads the file off disk, as written, comments and all: the dev loop is
/// where a person reads them. That is the whole dev loop -- a saved stylesheet
/// becomes a reload, and with the watcher below, not even that.
///
/// Dev only, and it says so: the variable has to be set deliberately, an unset
/// or unreadable one falls back to the compiled-in copy rather than failing,
/// and nothing about the response changes except its cache header. The names
/// are these four constants, never anything a request carries, so there is no
/// path for a URL to reach a file that is not one of them.
pub struct Ui {
    dir: Option<PathBuf>,
}

impl Ui {
    fn from_env() -> Ui {
        let dir = std::env::var_os("SNYVI_UI_DIR")
            .map(PathBuf::from)
            .filter(|d| d.join("app.css").is_file());
        Ui { dir }
    }

    /// True while assets come off disk.
    pub fn live(&self) -> bool {
        self.dir.is_some()
    }

    /// The named asset: off disk when live, the compiled-in copy otherwise.
    /// A file that has gone missing mid-edit -- an editor writing by rename --
    /// falls back rather than serving an empty page.
    fn text(&self, name: &str, built_in: &'static str) -> Cow<'static, str> {
        self.dir
            .as_ref()
            .and_then(|d| std::fs::read_to_string(d.join(name)).ok())
            .map_or(Cow::Borrowed(built_in), Cow::Owned)
    }

    /// What the UI assets hash to right now. The page carries this as
    /// `?v=`, `/api/health` reports it, and a page whose copy no longer
    /// matches the daemon's reloads -- so recomputing it per request is what
    /// makes an edit on disk a new bundle, with no restart in it.
    fn version(&self, built_in: &str) -> String {
        let Some(_) = self.dir.as_ref() else {
            return built_in.to_string();
        };
        let mut h = blake3::Hasher::new();
        for (name, fallback) in [
            ("index.html", INDEX_HTML),
            ("app.css", APP_CSS),
            ("app.js", APP_JS),
            ("boot.js", BOOT_JS),
            ("mmd.js", MMD_JS),
            ("desk.js", DESK_JS),
            ("frame.js", FRAME_JS),
            ("game.js", GAME_JS),
            ("about.js", ABOUT_JS),
            ("find.js", FIND_JS),
            ("keys.js", KEYS_JS),
            ("menu.js", MENU_JS),
            ("themes.css", THEMES_CSS),
            ("palette.js", PALETTE_JS),
            ("look.js", LOOK_JS),
            ("note.js", NOTE_JS),
            ("tip.js", TIP_JS),
            ("home.js", HOME_JS),
            ("toast.js", TOAST_JS),
            ("diff.js", DIFF_JS),
            ("browse.js", BROWSE_JS),
            ("paths.js", PATHS_JS),
        ] {
            h.update(self.text(name, fallback).as_bytes());
        }
        h.finalize().to_hex()[..8].to_string()
    }
}

pub struct App {
    pub store: Store,
    pub renderer: Renderer,
    pub browse: Browser,
    /// Where the store and the token live; a reset needs to know.
    pub paths: Paths,
    /// The desks' key values: the keychain, or the 0600 file beside the
    /// token when no keychain answers. Names are the store's.
    pub secrets: crate::secrets::Secrets,
    /// Behind a lock because a reset replaces it: the old token is dead from
    /// that moment, which is the point of replacing it.
    pub token: std::sync::RwLock<String>,
    pub events: broadcast::Sender<String>,
    /// Fires when `snyvi stop` asks the daemon to exit.
    pub shutdown: broadcast::Sender<()>,
    pub started: Instant,
    /// Build hash for immutable asset URLs, for the compiled-in bundle.
    /// Read through `asset_v()`, which a live UI recomputes per request.
    built_v: String,
    /// Normally the compiled-in UI; `SNYVI_UI_DIR` makes it the one on disk.
    pub ui: Ui,
    /// Last time any open tab reported having focus; drives desktop notifications.
    pub last_focus: std::sync::Mutex<Instant>,
    /// How many native windows are reading. `snyvi app` opens the page with a
    /// mark on it, the page carries the mark into its event stream, and the
    /// count falls when that stream ends -- so this is exactly as live as the
    /// window is, with nothing to time out and nothing to leave stale when a
    /// window is quit.
    ///
    /// **A count and nothing more.** The mark it is kept by rides the query
    /// string, so anything that can reach the daemon can inflate it; what that
    /// buys is a link handed to a window that is not there, and never a
    /// privilege. Authority is `capabilities` below, which is minted per launch
    /// and never appears in a URL the server sees. The two signals coexist
    /// because they answer different questions -- how many are reading, and
    /// whether this page is one of them -- and only the second is trusted.
    pub windows: AtomicUsize,
    /// How many event streams are open, window or not. One per page, and a
    /// page holds a browser connection for as long as it holds one: a browser
    /// allows six to a host, so a page that does not give its stream back on
    /// the way out costs the next page a socket. Reported so a probe can say
    /// that it does.
    pub streams: AtomicUsize,
    /// Of those, the ones a page holds -- a tab or the window -- and not an
    /// agent's `snyvi mcp`: what the watchers ask before they look at files
    /// for a page to redraw. Counting every stream kept them awake for as
    /// long as any Claude session was open.
    pub pages: AtomicUsize,
    /// Which agents are here now, and how many of each: the MCP server holds
    /// an event stream under its client's name from `initialize` until its
    /// process ends, so this is exactly as live as the agent is, the way the
    /// window count is. Before it, the daemon heard of an agent only when one
    /// sent, and the page could say "last sent 12 minutes ago" of a session
    /// that had been closed for eleven.
    pub online: std::sync::Mutex<std::collections::BTreeMap<String, usize>>,
    /// The capabilities minted for windows, kept beside the token so a window
    /// open across a restart keeps its panes. See `crate::capability`.
    pub capabilities: crate::capability::Capabilities,
    /// The panes that have been woken since this daemon started: their
    /// screens, and their processes while they run. See `crate::pane`.
    pub panes: Arc<crate::pane::Panes>,
    /// The last few lines agents left beside the work. See `crate::aside`.
    pub asides: crate::aside::Asides,
    /// What git last said about each desk's folder, kept briefly: Home is
    /// drawn again on every event it shows. See `crate::git`.
    pub git: crate::git::Cache,
    /// The file this daemon was started from, as it was then. `current_exe`
    /// is not it once the file has been replaced under a running process --
    /// `/proc/self/exe` says `(deleted)`, a renamed bundle moves the answer
    /// with it -- so the path is written down at start, and a successor is
    /// spawned by that path. Re-stat'ing it is how health says `stale`.
    pub exe: Option<Exe>,
    /// When this process started, in seconds since the epoch: what
    /// `snyvi restart` watches for a change of, since the version may not.
    pub started_at: i64,
    /// A restart that has been asked for and is waiting for the panes to be
    /// quiet. See `restart` and `Leaving`.
    pub restart: std::sync::Mutex<Option<Pending>>,
    /// Woken when a pending restart should be looked at again: an agent
    /// changed state, a restart was asked for, a stream ended.
    pub restart_wake: tokio::sync::Notify,
    /// Why `run` returned, set on the planned way out.
    leaving: std::sync::Mutex<Leaving>,
    /// The updater: what is out, what is staged, when it may go. None only
    /// when this process could not say what file it runs from. See
    /// `crate::update`.
    pub update: Option<Arc<crate::update::Updater>>,
    /// Set when the window has been asked to quit so a newer one can be
    /// started in its place; acted on when its stream ends.
    pub relaunch_window: std::sync::atomic::AtomicBool,
    /// Set once this daemon has decided to leave for a restart: what the
    /// pill says in the seconds before the stream drops, rather than
    /// going back to "Restart to update".
    pub restarting: std::sync::atomic::AtomicBool,
    /// The `update` block last sent, so the watcher's tick sends it again
    /// only when something in it moved. See `emit_update_if_changed`.
    update_sent: std::sync::Mutex<String>,
    /// The account's rate-limit windows, as the last status line in a panel
    /// said them: account-wide, so the latest is the one. Home's quota.
    pub quota: std::sync::Mutex<Option<serde_json::Value>>,
}

/// The daemon's own executable, stamped at start.
#[derive(Clone, Debug)]
pub struct Exe {
    pub path: PathBuf,
    stamp: (u64, u64, u64, u64),
}

impl Exe {
    fn here() -> Option<Exe> {
        let path = std::env::current_exe().ok()?;
        let path = path.canonicalize().unwrap_or(path);
        let stamp = stamp(&path)?;
        Some(Exe { path, stamp })
    }
    /// The file at the recorded path is not the one this process runs: an
    /// `apt upgrade`, a `brew upgrade --greedy`, a copy by hand, a swap by
    /// the updater. Or it is gone.
    pub fn stale(&self) -> bool {
        stamp(&self.path) != Some(self.stamp)
    }
}

/// What tells one file from another under the same name: device and inode
/// where there are such things, and the size and modification time
/// everywhere. A rename over the file changes the inode; a rewrite in place
/// changes the time.
fn stamp(path: &std::path::Path) -> Option<(u64, u64, u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (m.dev(), m.ino())
    };
    #[cfg(not(unix))]
    let (dev, ino) = (0, 0);
    Some((dev, ino, m.len(), mtime))
}

/// A restart that has been asked for. It is carried out the moment the panes
/// are quiet -- no agent mid-turn, nothing printing -- or at once when `now`.
#[derive(Clone, Copy, Debug)]
pub struct Pending {
    pub since: Instant,
    /// Take the staged update on the way (the updater's, later). Recorded
    /// with the exit either way, so the daemon that comes up can tell a
    /// restart that applied something from one that did not.
    pub apply: bool,
    /// Put the previous version back first (`snyvi update --back`).
    pub back: bool,
    pub now: bool,
}

/// Why `run` returned: asked to stop, or asked to restart -- in which case
/// the caller relaunches, by the recorded path, and how depends on whether
/// systemd is the one to do it.
#[derive(Clone, Debug)]
pub enum Leaving {
    Stopped,
    Restart { exe: Option<PathBuf>, apply: bool },
}

/// Whether systemd started this process as the `snyvi` user unit and will
/// bring it back after a non-zero exit. `INVOCATION_ID` is set by systemd for
/// every unit it runs; the unit being active is what says it is ours and not
/// a service snyvi happens to run under.
fn under_systemd() -> bool {
    if std::env::var_os("INVOCATION_ID").is_none() {
        return false;
    }
    std::process::Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "snyvi"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The exit code of a planned restart under systemd. 75 (`EX_TEMPFAIL`) is
/// not success, so `Restart=on-failure` in `packaging/snyvi.service` starts
/// the unit again from the file now at `ExecStart`; and it is a code nothing
/// else here exits with, so a log can tell a planned restart from a crash.
pub const PLANNED_RESTART_EXIT: i32 = 75;

/// The file a planned exit leaves for the next daemon, beside the store:
/// `{ "apply": bool, "from": "<version>", "at": <epoch> }`. Its presence is
/// what tells a planned start from a crash-restart; `apply` is for the
/// updater, which must not count a plain restart as a day's update.
const RESTART_MARKER: &str = "restart.json";

/// What a planned exit does before the listener goes: the panes an agent was
/// in are marked to come back as `claude --resume`, the marker is written,
/// and the reason is recorded for `run` to return. The shutdown itself is
/// the ordinary one -- every stream told, every pane hung up on -- so a
/// restart costs exactly what a stop does, and the window's reconnect is
/// what brings the panes back.
fn leave_for_restart(app: &App, apply: bool, back: bool) -> bool {
    // On its way out from the moment the pending restart is taken: the
    // apply can take a while, and `snyvi restart` reads "nothing pending and
    // not restarting" as given up. Given up it is, if this returns false.
    app.restarting.store(true, Ordering::Relaxed);
    let left = leave(app, apply, back);
    if !left {
        app.restarting.store(false, Ordering::Relaxed);
        emit_update(app);
    }
    left
}

fn leave(app: &App, apply: bool, back: bool) -> bool {
    if apply || back {
        let Some(u) = &app.update else {
            eprintln!("snyvi: no updater on this daemon; not restarting");
            return false;
        };
        if back {
            match u.rollback(true) {
                Ok(true) => {
                    eprintln!("snyvi: the previous version is back in place; restarting onto it")
                }
                Ok(false) => {
                    eprintln!("snyvi: there is no previous version to go back to");
                    return false;
                }
                Err(e) => {
                    eprintln!("snyvi: could not put the previous version back: {e:#}");
                    u.fail(format!("{e:#}"));
                    emit_update(app);
                    return false;
                }
            }
        } else {
            match u.apply() {
                Ok(v) => eprintln!("snyvi: {v} is in place; restarting onto it"),
                Err(e) => {
                    // Not tried again every five seconds: what was staged
                    // goes, the next check stages afresh, and About says why.
                    eprintln!("snyvi: could not apply the update: {e:#}");
                    u.fail(format!("{e:#}"));
                    u.drop_staged();
                    emit_update(app);
                    return false;
                }
            }
        }
    }
    app.restarting.store(true, Ordering::Relaxed);
    emit_update(app);
    // The panes an agent is in, and the marks this daemon was given and
    // nobody has spent yet -- an update applied while nobody was here must
    // not lose the last one's.
    let (mut resume, offer) = app.panes.unspent();
    resume.extend(app.panes.with_agent());
    match app.store.mark_panes_resume(&resume) {
        Ok(n) if n > 0 => {
            eprintln!("snyvi: restarting; {n} panel(s) will resume their conversation")
        }
        Ok(_) => eprintln!("snyvi: restarting"),
        Err(e) => eprintln!("snyvi: restarting; could not mark panels to resume: {e}"),
    }
    let _ = app.store.offer_panes_resume(&offer);
    let marker = json!({ "apply": apply, "from": VERSION, "at": crate::store::now() });
    let _ = std::fs::write(app.paths.data_dir.join(RESTART_MARKER), marker.to_string());
    *app.leaving.lock().unwrap() = Leaving::Restart {
        exe: app.exe.as_ref().map(|e| e.path.clone()),
        apply,
    };
    let _ = app.shutdown.send(());
    true
}

/// How old a marker may be and still describe this start. A planned exit
/// is followed by a start within seconds -- two under systemd, a few more
/// for a successor that crashed and was started again -- so a marker older
/// than this was left by an exit whose start never came.
const RESTART_MARKER_FOR: i64 = 10 * 60;

/// A planned restart's marker, if the last exit left one and it is recent.
/// `Some(apply)` when the last exit was planned. Read here and taken only
/// once this daemon holds the port (`drop_restart_marker`): a successor
/// that dies before then is started again, and must find it again.
fn read_restart_marker(paths: &Paths) -> Option<bool> {
    let text = std::fs::read_to_string(paths.data_dir.join(RESTART_MARKER)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let at = v["at"].as_i64()?;
    if (crate::store::now() - at).abs() > RESTART_MARKER_FOR {
        return None;
    }
    Some(v["apply"].as_bool().unwrap_or(false))
}

fn drop_restart_marker(paths: &Paths) {
    let _ = std::fs::remove_file(paths.data_dir.join(RESTART_MARKER));
}

/// The pending restart as the pill and About see it: `restart_json`
/// without its clock, so the block only changes when what it says does.
fn pending_json(app: &App) -> serde_json::Value {
    let pending = *app.restart.lock().unwrap();
    match pending {
        Some(p) => {
            let busy = if p.now { vec![] } else { app.panes.busy() };
            json!({
                "apply": p.apply,
                "back": p.back,
                "now": p.now,
                "waiting": waiting_named(app, &busy),
                "waiting_on": busy,
            })
        }
        None => serde_json::Value::Null,
    }
}

/// Who a restart is waiting for, by the names the reader knows them by:
/// "ledger · panel 1 · Claude working", and since when. `waiting_on` stays
/// the bare ids, which the CLI and the benches read.
fn waiting_named(app: &App, ids: &[String]) -> Vec<serde_json::Value> {
    ids.iter()
        .map(|id| {
            let st = app.panes.status(id);
            let placed = app.store.pane(id).ok().flatten();
            json!({
                "pane": id,
                "desk": placed.as_ref().map(|p| p.desk_name.clone()),
                "desk_id": placed.as_ref().map(|p| p.desk_id),
                "slot": placed.as_ref().map(|p| p.pane.slot),
                "agent": st.agent,
                "since": st.agent_since.or(st.since),
            })
        })
        .collect()
}

/// The pending restart, as health and `snyvi restart` see it.
fn restart_json(app: &App) -> serde_json::Value {
    match *app.restart.lock().unwrap() {
        Some(p) => json!({
            "pending": true,
            "apply": p.apply,
            "back": p.back,
            "since_s": p.since.elapsed().as_secs(),
            "waiting_on": if p.now { vec![] } else { app.panes.busy() },
        }),
        None => serde_json::Value::Null,
    }
}

impl App {
    /// The live agents, for health, the boot payload and the `agents` event.
    pub fn online(&self) -> serde_json::Value {
        let m = self.online.lock().unwrap_or_else(|e| e.into_inner());
        json!(*m)
    }
    /// Is a native window up? What decides whether a link is handed to it or
    /// opened in a browser beside it.
    pub fn has_window(&self) -> bool {
        self.windows.load(Ordering::Relaxed) > 0
    }
    /// The bundle this daemon is serving. Constant for a shipped build, and
    /// the hash of what is on disk while the UI is live.
    pub fn asset_v(&self) -> String {
        self.ui.version(&self.built_v)
    }
}

type S = State<Arc<App>>;

/// The most the queue is ever sent as. Past this a reader is not going to
/// read down the line; the count beside the rows says how many there are.
const QUEUE_MAX: usize = 500;
/// How much of it a page opens with. The sidebar shows six and the bar shows
/// the oldest; the inbox, which lists them all, asks for the rest itself. A
/// library with hundreds waiting used to double the shell page.
const QUEUE_BOOT: usize = 24;

/// The queue's length, for the events and the boot payload: every tab keeps
/// its count from here rather than by arithmetic on what it happened to see.
fn waiting(app: &App) -> i64 {
    app.store.waiting().unwrap_or(0)
}

pub async fn run(paths: Paths) -> anyhow::Result<Leaving> {
    let token = config::load_or_create_token(&paths)?;
    let store = Store::open(&paths)?;
    // A planned restart left a marker and marks; a crash left neither. Both
    // are read now, before anything can ask, and cleared once the port is
    // held: a successor that dies before then is started again, and must
    // find them again. A mark to resume with no marker behind it -- the
    // restart it was for never came, or came long ago -- is only an offer:
    // nothing types a conversation back on its own the next day.
    let planned = read_restart_marker(&paths);
    let (mut resume, mut offer) = store.panes_resume().unwrap_or_default();
    if planned.is_none() {
        offer.append(&mut resume);
    }
    if let Some(apply) = planned {
        eprintln!(
            "snyvi: back from a planned restart{}; {} panel(s) to resume",
            if apply {
                " (an update was applied)"
            } else {
                ""
            },
            resume.len()
        );
    }
    let renderer = Renderer::new();
    let (tx, _) = broadcast::channel(64);
    let (stop_tx, mut stop_rx) = broadcast::channel::<()>(1);
    // The Mermaid bundle is in the hash as well. It is served immutable for a
    // year like every other asset, and its URL had no version in it -- so a
    // browser that had cached one snyvi's bundle would have kept it across
    // every upgrade, which is exactly what a trimmed bundle would need to
    // replace. Hashing a megabyte once at startup costs under a millisecond.
    let asset_v = {
        let mut h = blake3::Hasher::new();
        h.update(INDEX_HTML.as_bytes());
        h.update(APP_CSS.as_bytes());
        h.update(APP_JS.as_bytes());
        h.update(DESK_JS.as_bytes());
        h.update(FRAME_JS.as_bytes());
        h.update(GAME_JS.as_bytes());
        h.update(ABOUT_JS.as_bytes());
        h.update(FIND_JS.as_bytes());
        h.update(KEYS_JS.as_bytes());
        h.update(MENU_JS.as_bytes());
        h.update(THEMES_CSS.as_bytes());
        h.update(PALETTE_JS.as_bytes());
        h.update(LOOK_JS.as_bytes());
        h.update(NOTE_JS.as_bytes());
        h.update(TIP_JS.as_bytes());
        h.update(HOME_JS.as_bytes());
        h.update(TOAST_JS.as_bytes());
        h.update(DIFF_JS.as_bytes());
        h.update(BROWSE_JS.as_bytes());
        h.update(PATHS_JS.as_bytes());
        h.update(VERSION.as_bytes());
        h.update(MERMAID_JS_GZ);
        h.finalize().to_hex()[..8].to_string()
    };
    let panes = crate::pane::Panes::new(&paths.data_dir, tx.clone());
    let exe = Exe::here();
    let update = exe.as_ref().map(|e| {
        Arc::new(crate::update::Updater::new(
            &paths,
            &e.path,
            Box::new(crate::update::Http),
        ))
    });
    let app = Arc::new(App {
        store,
        renderer,
        browse: Browser::load(paths.config_dir.join("folders.json")),
        paths: paths.clone(),
        secrets: crate::secrets::Secrets::new(paths.config_dir.join("keys.json")),
        token: std::sync::RwLock::new(token),
        events: tx,
        shutdown: stop_tx,
        started: Instant::now(),
        built_v: asset_v,
        ui: Ui::from_env(),
        last_focus: std::sync::Mutex::new(Instant::now() - std::time::Duration::from_secs(60)),
        windows: AtomicUsize::new(0),
        streams: AtomicUsize::new(0),
        pages: AtomicUsize::new(0),
        online: std::sync::Mutex::new(Default::default()),
        capabilities: crate::capability::Capabilities::load(paths.config_dir.join("capabilities")),
        panes,
        asides: Default::default(),
        git: Default::default(),
        exe,
        started_at: crate::store::now(),
        restart: std::sync::Mutex::new(None),
        restart_wake: tokio::sync::Notify::new(),
        leaving: std::sync::Mutex::new(Leaving::Stopped),
        update,
        relaunch_window: std::sync::atomic::AtomicBool::new(false),
        restarting: std::sync::atomic::AtomicBool::new(false),
        update_sent: Default::default(),
        quota: Default::default(),
    });
    if let Some(u) = &app.update {
        if u.channel == crate::update::Channel::Dev {
            eprintln!("snyvi: a development build; it will not check for updates");
        } else if !u.auto() {
            eprintln!("snyvi: automatic updates are off; `snyvi update` still works");
        }
    }
    // Before the listener: a window's first status frame must already say
    // which panes come back as a conversation.
    app.panes.mark_resume(resume);
    app.panes.mark_offer(offer);
    // Where a shell moves to is where it starts next (`pane::follow_folders`).
    let weak = Arc::downgrade(&app);
    app.panes.on_cwd(Box::new(move |id, cwd| {
        if let Some(app) = weak.upgrade() {
            let _ = app.store.set_pane_cwd(id, cwd);
        }
    }));
    // Kept past the router, which takes its own: what the daemon does on the
    // way out needs the panes.
    let leaving = app.clone();
    let told = app.shutdown.clone();
    crate::watch::spawn_browse_watcher(app.clone());
    crate::watch::spawn_ui_watcher(app.clone());

    let router = Router::new()
        .route("/", get(shell_home))
        .route("/inbox", get(shell_inbox))
        .route("/api/home", get(home))
        .route("/connect", get(shell_connect))
        .route("/start", get(shell_start))
        .route("/welcome", get(shell_welcome))
        .route("/d/{id}", get(shell_doc))
        .route("/b/{id}", get(shell_browse))
        .route("/b/{id}/{*path}", get(shell_browse_file))
        .route("/assets/app.css", get(asset_css))
        .route("/assets/app.js", get(asset_js))
        .route("/assets/boot.js", get(asset_boot))
        .route("/assets/mmd.js", get(asset_mmd))
        .route("/assets/mermaid.js", get(asset_mermaid))
        .route("/files/{id}/{*path}", get(doc_file))
        .route("/assets/fonts/{name}", get(asset_font))
        .route("/api/health", get(health))
        .route("/api/about", get(about))
        .route("/api/agents", get(agents))
        .route("/api/agents/claude/connect", post(connect_claude))
        .route("/api/tree", get(tree))
        .route("/api/projects/{id}/tree", get(project_tree))
        .route("/api/workflows/{id}/tree", get(workflow_tree))
        .route("/api/inbox", get(inbox))
        .route("/api/search", get(search))
        .route("/api/docs", post(receive_doc))
        .route("/api/docs/{id}", get(doc_json))
        .route("/api/docs/{id}/pin", post(pin))
        .route("/api/docs/{id}/read", post(mark_read))
        .route("/api/queue", get(queue))
        .route("/api/queue/clear", post(clear_queue))
        .route("/api/queue/unread", post(unread))
        .route("/api/docs/{id}/delete", post(delete_doc))
        .route("/api/docs/{id}/undelete", post(undelete_doc))
        .route("/api/removed", get(removed_list))
        .route("/api/docs/{id}/history", get(history))
        .route("/api/projects/{id}/rename", post(rename_project))
        .route("/api/workflows/{id}/rename", post(rename_workflow))
        .route("/api/docs/{id}/split", get(doc_split))
        .route("/api/docs/{id}/outline", get(doc_outline))
        // Asides, on the routes they had when they were called notes: an MCP
        // server and a page from before the rename still reach them.
        .route("/api/notes", get(asides).post(receive_aside))
        .route("/api/notes/seen", post(see_asides))
        .route("/api/notes/dismiss", post(dismiss_asides))
        .route("/api/notes/restore", post(restore_asides))
        .route("/api/focus", post(focus))
        .route("/api/shutdown", post(shutdown))
        .route("/api/restart", post(restart).delete(cancel_restart))
        .route("/api/update/check", post(update_check))
        .route("/api/update/auto", post(update_auto))
        .route("/api/update/later", post(update_later))
        .route("/api/reset", get(reset_census).post(reset))
        .route("/api/terminal", post(terminal))
        .route("/api/reveal", post(reveal))
        .route("/api/resolve", post(resolve_path))
        .route("/api/browse", get(browse_list).post(browse_open))
        .route("/api/browse/pick", post(browse_pick))
        .route("/api/browse/{id}/close", post(browse_close))
        .route("/api/browse/{id}/reopen", post(browse_reopen))
        .route("/api/browse/{id}/tree", get(browse_tree))
        .route("/api/browse/{id}/file", get(browse_file))
        .route("/api/browse/{id}/raw", get(browse_raw))
        .route("/api/browse/{id}/raw/{*path}", get(browse_raw_path))
        .route("/api/browse/{id}/find", get(browse_find))
        .route("/api/browse/{id}/outline", get(browse_outline))
        .route("/api/docs/{id}/raw", get(doc_raw))
        .route("/api/docs/{id}/blob", get(doc_blob))
        .route("/api/compare/{a}/{b}", get(compare))
        .route("/api/events", get(events))
        .route("/api/capability", post(mint_capability))
        .route("/api/desk", get(desk_socket))
        .route("/api/desks", get(desks).post(create_desk))
        .route("/api/desks/{id}/rename", post(rename_desk))
        .route("/api/desks/{id}/layout", post(desk_layout))
        .route("/api/desks/{id}/move", post(move_pane))
        .route("/api/desks/{id}/delete", post(delete_desk))
        .route("/api/desks/{id}/reopen", post(reopen_desk))
        .route("/api/desks/{id}/panes", post(open_pane))
        .route("/api/desks/{id}/docs", get(desk_docs))
        .route("/api/desks/{id}/docs/{doc}/remove", post(remove_desk_doc))
        .route("/api/desks/{id}/docs/{doc}/restore", post(restore_desk_doc))
        .route("/api/desks/{id}/notes", get(desk_notes).post(add_desk_note))
        .route("/api/desks/{id}/notes/{note}", post(set_desk_note))
        .route(
            "/api/desks/{id}/notes/{note}/remove",
            post(remove_desk_note),
        )
        .route(
            "/api/desks/{id}/notes/{note}/restore",
            post(restore_desk_note),
        )
        .route("/api/desks/{id}/notes/{note}/keep", post(keep_desk_note))
        .route("/api/desks/{id}/leftoff", post(desk_left_off))
        .route("/api/desks/{id}/keys", get(desk_keys).post(add_desk_key))
        .route("/api/desks/{id}/keys/{name}/remove", post(remove_desk_key))
        .route("/api/desks/{id}/visit", post(visit_desk))
        .route("/api/desks/{id}/park", post(park_desk))
        .route("/api/desks/{id}/week", post(desk_week))
        .route(
            "/api/desks/{id}/notes/{note}/image",
            post(add_note_image).layer(axum::extract::DefaultBodyLimit::max(NOTE_IMAGE_BYTES)),
        )
        .route("/api/desks/{id}/notes/{note}/images", post(set_note_images))
        .route("/api/desks/{id}/note-images/{name}", get(note_image))
        .route("/api/brief", get(brief_setting).post(set_brief_setting))
        .route("/api/panes/{id}/delete", post(close_pane))
        .route("/api/panes/{id}/restore", post(restore_pane))
        .route("/api/panes/{id}/rename", post(rename_pane))
        .route("/api/panes/{id}/start", post(start_pane))
        .route("/api/panes/{id}/stop", post(stop_pane))
        .route("/api/panes/{id}/agent", post(pane_agent))
        .route("/api/panes/{id}/notes", get(pane_notes))
        .route("/api/panes/{id}/notes/{note}/tick", post(pane_tick_note))
        .route("/api/panes/{id}/notes/{note}/mark", post(pane_mark_note))
        .route("/api/panes/{id}/name", post(pane_name))
        .route("/api/panes/{id}/brief", get(pane_brief))
        .route("/api/panes/{id}/changes", get(pane_changes))
        .route("/api/panes/{id}/leftoff", post(pane_left_off))
        .route("/api/panes/{id}/suggest", post(pane_suggest_note))
        .route(
            "/api/panes/{id}/paste",
            post(paste_image).layer(axum::extract::DefaultBodyLimit::max(receive::MAX_BYTES)),
        )
        .route("/desks", get(shell_desk_list))
        .route("/desk/{id}", get(shell_desk))
        .route("/assets/desk.js", get(asset_desk))
        .route("/assets/frame.js", get(asset_frame))
        .route("/assets/game.js", get(asset_game))
        .route("/assets/about.js", get(asset_about))
        .route("/assets/find.js", get(asset_find))
        .route("/assets/keys.js", get(asset_keys))
        .route("/assets/menu.js", get(asset_menu))
        .route("/assets/themes.css", get(asset_themes))
        .route("/assets/palette.js", get(asset_palette))
        .route("/assets/look.js", get(asset_look))
        .route("/assets/note.js", get(asset_note))
        .route("/assets/tip.js", get(asset_tip))
        .route("/assets/home.js", get(asset_home))
        .route("/assets/toast.js", get(asset_toast))
        .route("/assets/diff.js", get(asset_diff))
        .route("/assets/browse.js", get(asset_browse))
        .route("/assets/paths.js", get(asset_paths))
        .fallback(not_found)
        .with_state(app);

    let addr = format!("127.0.0.1:{}", config::port());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    // What the last exit did, told by its marker: only a planned exit that
    // applied something opens the next day's slot. Said once this daemon
    // holds the port -- one that panicked on the way here has not started,
    // and `update::first_start` is still counting it -- and before it
    // answers anything, so health never shows a version as ready that is
    // now running.
    if let Some(u) = &leaving.update {
        match u.note_started(planned.unwrap_or(false), crate::store::now()) {
            Some(crate::update::Started::Applied(v)) => {
                eprintln!("snyvi: now {v}, updated; the next automatic update is a day or so away")
            }
            Some(crate::update::Started::Failed(v)) => eprintln!(
                "snyvi: {v} was put in place but this is {VERSION} running from the same path; {v} is marked failed and not tried again on its own"
            ),
            None => {}
        }
    }
    drop_restart_marker(&paths);
    let _ = leaving.store.clear_panes_resume();
    // After it: until then `ready` may still name the version now running,
    // and the watcher would apply it again.
    spawn_restart_watcher(leaving.clone());
    spawn_update_checker(leaving.clone());
    // An install from an older snyvi gets the hooks that tell a panel what
    // Claude is doing, without the reader running `init-claude` again. Only
    // where our hook already is and names this binary, and only once this
    // daemon holds the port: one that is about to exit writes nothing. See
    // `hook::top_up`.
    tokio::task::spawn_blocking(|| {
        if let Ok(true) = crate::hook::top_up() {
            eprintln!("snyvi: added the panel status hooks to ~/.claude/settings.json");
        }
    });
    eprintln!("snyvi {VERSION} listening on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let term = async {
                #[cfg(unix)]
                {
                    let mut sig =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                            .expect("SIGTERM handler");
                    sig.recv().await;
                }
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            };
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term => {},
                _ = stop_rx.recv() => {},
            }
            // However it was asked, every open stream is told: a graceful
            // shutdown waits for each one, and an event stream or a desk
            // socket never ends of its own accord. `snyvi stop` already sends
            // this; a signal, which is how systemd and a logout ask, did not.
            let _ = told.send(());
        })
        .await?;
    // Every pane's text is written down and every process is hung up on: a
    // daemon that is going takes its shells with it, and they do not come
    // back with the next one. What comes back is the text, greyed -- and,
    // after a planned restart, the conversation, which the window asks for.
    let why = leaving.leaving.lock().unwrap().clone();
    // Not planned -- `snyvi stop`, a signal, a reboot: the panes with Claude
    // in them are marked to be offered back, which the next window does with
    // one click and not on its own. A planned restart marked them already.
    if matches!(why, Leaving::Stopped) {
        // With the marks still unspent, as offers: this exit was not planned.
        let (resume, offer) = leaving.panes.unspent();
        let mut with_agent = leaving.panes.with_agent();
        with_agent.extend(resume);
        with_agent.extend(offer);
        if let Ok(n) = leaving.store.offer_panes_resume(&with_agent) {
            if n > 0 {
                eprintln!("snyvi: {n} panel(s) had Claude open; the window will offer each conversation back");
            }
        }
    }
    leaving.panes.shutdown();
    Ok(why)
}

/// Carries out a pending restart once the panes are quiet. Looked at when
/// something changes -- a restart asked for, an agent's state, a pane's
/// process -- and every five seconds regardless, since "quiet" is partly a
/// clock: a pane stops being busy ninety seconds after its last output with
/// nothing to say so.
fn spawn_restart_watcher(app: Arc<App>) {
    tokio::spawn(async move {
        let mut changes = app.events.subscribe();
        loop {
            tokio::select! {
                _ = app.restart_wake.notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
                m = changes.recv() => {
                    // Only a pane's word matters here; everything else on
                    // the stream is documents.
                    if !matches!(&m, Ok(s) if s.starts_with("panes\n")) { continue }
                }
            }
            // The block moves with the clock too -- the day's slot opening,
            // amber at a day, a failure ageing out -- and with the panels a
            // pending restart waits on; nothing else would say so.
            emit_update_if_changed(&app);
            let pending = *app.restart.lock().unwrap();
            match pending {
                Some(p) => {
                    if !p.now && !app.panes.busy().is_empty() {
                        continue;
                    }
                    // A check is downloading or an apply is swapping: wait
                    // it out rather than block this task on the lock.
                    if (p.apply || p.back) && app.update.as_ref().is_some_and(|u| u.busy()) {
                        continue;
                    }
                    app.restart.lock().unwrap().take();
                    if leave_for_restart(&app, p.apply, p.back) {
                        return;
                    }
                }
                None => {
                    // The automatic path: a version staged, the day's slot
                    // open, and one of the doors -- nobody here, or a window
                    // left in the background -- open too. See `update::door`.
                    let Some(u) = &app.update else { continue };
                    let now = crate::store::now();
                    if let Some(why) = u.should_apply(now, &doors(&app)) {
                        let v = u.state().ready.unwrap_or_default();
                        eprintln!("snyvi: applying {v} now, since {}", why.say());
                        if leave_for_restart(&app, true, false) {
                            return;
                        }
                    }
                }
            }
        }
    });
}

/// Who is here, for the updater's doors: windows, pages that are not
/// agents, how long since a page said it was in front, and whether a pane
/// is busy.
fn doors(app: &App) -> crate::update::Doors {
    let agents: usize = app
        .online
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .sum();
    let streams = app.streams.load(Ordering::Relaxed);
    crate::update::Doors {
        windows: app.windows.load(Ordering::Relaxed),
        pages: streams.saturating_sub(agents),
        focus_age: app.last_focus.lock().unwrap().elapsed(),
        busy: !app.panes.busy().is_empty(),
    }
}

/// Reads the manifest on a timer: shortly after the start, then every six
/// hours or so. A failure is a line in the log and a field in About, never
/// a pill. `SNYVI_UPDATE_EVERY_S` shortens the timer for the bench.
fn spawn_update_checker(app: Arc<App>) {
    use crate::update::{jitter_d, CHECK_EVERY, CHECK_JITTER, FIRST_CHECK, FIRST_CHECK_JITTER};
    let Some(u) = app.update.clone() else { return };
    if u.channel == crate::update::Channel::Dev {
        return;
    }
    let every = std::env::var("SNYVI_UPDATE_EVERY_S")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(std::time::Duration::from_secs);
    tokio::spawn(async move {
        let mut wait = match every {
            Some(e) => e,
            None => FIRST_CHECK + jitter_d(FIRST_CHECK_JITTER),
        };
        loop {
            tokio::time::sleep(wait).await;
            wait = match every {
                Some(e) => e,
                None => CHECK_EVERY - CHECK_JITTER + jitter_d(CHECK_JITTER * 2),
            };
            if !u.auto() {
                continue;
            }
            let checker = u.clone();
            let before = checker.state().ready;
            let r =
                tokio::task::spawn_blocking(move || checker.check(crate::update::Ask::TIMER, None))
                    .await;
            match r {
                Ok(Ok(c)) if c.ready.is_some() && c.ready != before => {
                    eprintln!(
                        "snyvi: {} is staged, verified, and applies at a quiet moment",
                        c.ready.as_deref().unwrap_or("?")
                    )
                }
                Ok(Ok(c)) if c.newer() && c.told => eprintln!(
                    "snyvi: {} is out; this install is updated by hand",
                    c.latest
                ),
                Ok(Ok(_)) => {}
                Ok(Err(e)) => eprintln!("snyvi: update check: {e:#}"),
                Err(_) => {}
            }
            emit_update(&app);
            app.restart_wake.notify_one();
        }
    });
}

/// The `update` block of health and About, and the `update` event's body:
/// the updater's word, the restart waiting for quiet if one is, and whether
/// this daemon is on its way out.
fn update_json(app: &App) -> serde_json::Value {
    let stale = app.exe.as_ref().is_some_and(Exe::stale);
    let mut j = match &app.update {
        Some(u) => u.json(crate::store::now(), stale),
        None => json!({ "channel": "unknown", "auto": false, "show": stale, "stale": stale }),
    };
    j["restart"] = pending_json(app);
    j["restarting"] = json!(app.restarting.load(Ordering::Relaxed));
    j
}

pub(crate) fn emit_update(app: &App) {
    let j = update_json(app);
    *app.update_sent.lock().unwrap_or_else(|e| e.into_inner()) = j.to_string();
    emit(app, "update", j);
}

/// `emit_update`, only when the block differs from the one last sent.
fn emit_update_if_changed(app: &App) {
    let j = update_json(app);
    let text = j.to_string();
    {
        let mut sent = app.update_sent.lock().unwrap_or_else(|e| e.into_inner());
        if *sent == text {
            return;
        }
        *sent = text;
    }
    emit(app, "update", j);
}

/// After `run` has returned `Leaving::Restart`: the successor, by the path
/// recorded at start. Under systemd the unit does it -- this process exits
/// with `PLANNED_RESTART_EXIT` and `Restart=on-failure` brings the new file
/// up inside the unit, where `update::first_start` takes a bad one back out.
/// Otherwise the successor is spawned detached, with its output in
/// `daemon.log`, and watched for up to `CAME_UP_WITHIN`: when nothing at all
/// answers after an apply, the previous version is put back and started.
/// Something else answering -- an older snyvi from another path holding the
/// port -- is not the successor, and not a reason to take the update back
/// out either. Never returns.
pub fn relaunch(exe: Option<PathBuf>, apply: bool, paths: &Paths) -> ! {
    if under_systemd() {
        eprintln!("snyvi: planned restart under systemd; exiting {PLANNED_RESTART_EXIT} for the unit to start the new file");
        std::process::exit(PLANNED_RESTART_EXIT);
    }
    let Some(exe) = exe.or_else(|| std::env::current_exe().ok()) else {
        eprintln!("snyvi: cannot restart: the path of this executable is unknown");
        std::process::exit(1);
    };
    let me = std::process::id();
    if let Err(e) = platform::spawn_daemon(&exe) {
        eprintln!(
            "snyvi: cannot restart: starting {} failed: {e}",
            exe.display()
        );
        std::process::exit(1);
    }
    match came_up(me, &exe) {
        CameUp::Ours(v) => {
            eprintln!(
                "snyvi: {v} is up on {}; this one is done",
                config::base_url()
            );
            std::process::exit(0);
        }
        CameUp::Other(what) => {
            eprintln!(
                "snyvi: something else answered on {} after the restart ({what}), not {}; stop it and run `snyvi restart`",
                config::base_url(),
                exe.display()
            );
            std::process::exit(1);
        }
        CameUp::Nothing => {}
    }
    eprintln!(
        "snyvi: {} did not answer within {} s of a planned restart; see {}",
        exe.display(),
        CAME_UP_WITHIN.as_secs(),
        platform::daemon_log(&paths.data_dir).display()
    );
    if apply {
        // The file just placed does not run. The one that did is beside it
        // as `.prev`: put it back, start it, and let it say `failed`.
        let u = crate::update::Updater::new(paths, &exe, Box::new(crate::update::Http));
        match u.rollback(false) {
            Ok(true) => eprintln!("snyvi: put the previous version back"),
            Ok(false) => eprintln!("snyvi: nothing to put back"),
            Err(e) => eprintln!("snyvi: could not put the previous version back: {e:#}"),
        }
        if let Err(e) = platform::spawn_daemon(&exe) {
            eprintln!("snyvi: starting {} again failed: {e}", exe.display());
            std::process::exit(1);
        }
        if let CameUp::Ours(v) = came_up(me, &exe) {
            eprintln!("snyvi: {v} is back up on {}", config::base_url());
            std::process::exit(0);
        }
        eprintln!(
            "snyvi: {} did not answer after the rollback either",
            exe.display()
        );
    }
    std::process::exit(1);
}

/// How long a successor has to answer. A daemon still migrating its store
/// is not a failed one, and a rollback under it would be.
const CAME_UP_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);

enum CameUp {
    /// Our successor: another process, from the recorded path. Its version.
    Ours(String),
    /// Another process answered, from another file.
    Other(String),
    Nothing,
}

/// Who answered health, within `CAME_UP_WITHIN`: a process other than `me`
/// and from `exe` is the successor. A daemon from before health said its
/// file (1.7.0 and older, what `--to` may go down to) is taken on its pid.
fn came_up(me: u32, exe: &std::path::Path) -> CameUp {
    let deadline = Instant::now() + CAME_UP_WITHIN;
    let mut wait = std::time::Duration::from_millis(20);
    let mut other = None;
    while Instant::now() < deadline {
        if let Some(h) = crate::client::health() {
            let version = h["version"].as_str().unwrap_or("?").to_string();
            if h["pid"].as_u64() != Some(u64::from(me)) {
                match h["exe"].as_str() {
                    Some(e) if std::path::Path::new(e) != exe => {
                        // Maybe the old one is still letting go of the port
                        // and this is a third party that just took it; keep
                        // looking until the deadline, and say so then.
                        other = Some(format!("snyvi {version} from {e}"));
                    }
                    _ => return CameUp::Ours(version),
                }
            }
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(std::time::Duration::from_millis(250));
    }
    match other {
        Some(what) => CameUp::Other(what),
        None => CameUp::Nothing,
    }
}

// ---------- shell ----------

/// How much of a project the sidebar is given when it is expanded: enough to
/// read, never a year of sessions. Everything past this is one click away and
/// arrives whole, so nothing is hidden -- only unasked for.
const TREE_WORKFLOWS: usize = 10;
const TREE_DOCS: usize = 10;

/// One project's rows: its sessions, newest first, each holding its newest
/// documents.
///
/// `whole` is the workflow the reader is reading in, which comes back complete
/// rather than capped: `[` and `]` step through the versions of a document, and
/// a cap there would stop them somewhere arbitrary. The page a reader opens and
/// the fetch their tab makes later both come through here, so an arrival cannot
/// quietly hand back a shorter list than the page did.
fn project_rows(
    app: &App,
    project_id: i64,
    workflows: usize,
    docs: usize,
    whole: Option<i64>,
) -> Vec<crate::store::TreeWorkflow> {
    let mut wfs = app
        .store
        .project_tree(project_id, workflows, docs)
        .unwrap_or_default();
    if let Some(id) = whole {
        if let Ok(Some(full)) = app.store.workflow_tree(id) {
            match wfs.iter().position(|w| w.id == full.id) {
                Some(at) => wfs[at] = full,
                // The document being read is in a session too old to be among
                // the most recent few. It goes in anyway: the reader is in it.
                None => wfs.insert(0, full),
            }
        }
    }
    wfs
}

/// The same rows, keyed by project id, which is the shape the boot payload
/// carries them in.
fn subtree(app: &App, project_id: i64, whole: Option<i64>) -> serde_json::Value {
    let wfs = project_rows(app, project_id, TREE_WORKFLOWS, TREE_DOCS, whole);
    let mut m = serde_json::Map::new();
    m.insert(
        project_id.to_string(),
        serde_json::to_value(wfs).unwrap_or_default(),
    );
    serde_json::Value::Object(m)
}

fn escape_json_for_script(s: &str) -> String {
    s.replace("</", "<\\/")
}

/// Nothing at this address. The API answers with the status alone, as it
/// did before there was a page; anything a browser would show gets the page.
async fn not_found(State(app): S, uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    not_found_page(&app)
}

/// The page, off disk under `SNYVI_UI_DIR` as every other file of the UI is.
fn not_found_page(app: &App) -> Response {
    (
        StatusCode::NOT_FOUND,
        [
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        Html(app.ui.text("404.html", NOT_FOUND_HTML).into_owned()),
    )
        .into_response()
}

fn shell(app: &App, mut boot: serde_json::Value, initial_html: &str, title: &str) -> Response {
    // The build hash, for the one asset the client asks for itself rather than
    // through the markup: the Mermaid bundle.
    if let Some(o) = boot.as_object_mut() {
        o.insert("v".into(), serde_json::Value::String(app.asset_v()));
        // What is waiting to be read, on every page: the bar above the
        // document and the section at the top of the sidebar draw from it
        // before the first paint, so a reload never loses count.
        o.insert(
            "queue".into(),
            serde_json::to_value(app.store.queue(QUEUE_BOOT).unwrap_or_default())
                .unwrap_or_default(),
        );
        o.insert("waiting".into(), json!(waiting(app)));
        // Who is here, for the count beside the brand mark on the first paint.
        o.insert("online".into(), app.online());
        // The aside showing at the foot of the sidebar, and the trail under it.
        o.insert("notes".into(), json!(app.asides.list()));
    }
    let page = app
        .ui
        .text("index.html", INDEX_HTML)
        .replace("{{V}}", &app.asset_v())
        .replace("{{TITLE}}", &html_escape::encode_text(title))
        .replace("{{INITIAL_HTML}}", initial_html)
        .replace("{{BOOT_JSON}}", &escape_json_for_script(&boot.to_string()));
    (
        [
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
        ],
        Html(page),
    )
        .into_response()
}

pub fn fmt_time(ts: i64) -> String {
    use time::{format_description::FormatItem, macros::format_description, OffsetDateTime};
    const F: &[FormatItem] =
        format_description!("[month repr:short] [day padding:none], [hour]:[minute]");
    let local = OffsetDateTime::from_unix_timestamp(ts)
        .map(|t| {
            t.to_offset(time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC))
        })
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    local.format(F).unwrap_or_default()
}

/// Server-side document markup, mirrored by `renderDoc` in app.js.
fn doc_html(doc: &Doc, body: &str) -> String {
    let e = html_escape::encode_text;
    let mut sub = format!("{} · {}", e(&doc.project), e(&doc.workflow_title));
    if let Some(b) = &doc.branch {
        sub.push_str(&format!(" · <span class=\"branch\">{}</span>", e(b)));
    }
    sub.push_str(&format!(" · {}", fmt_time(doc.received_at)));
    format!(
        "<header class=\"doc-head\"><h1 class=\"doc-title\">{}</h1><p class=\"doc-sub\">{}</p></header><article class=\"prose kind-{}\">{}</article>",
        e(&doc.title),
        sub,
        doc.kind.as_str(),
        render::chunk_code(body)
    )
}

/// `/`: Home, the page the mark opens -- what needs the reader, the desks,
/// what is waiting, the update. An empty library is still Welcome, which the
/// Inbox's view draws, so it keeps that view.
async fn shell_home(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let empty = app.store.inbox(1).map(|i| i.is_empty()).unwrap_or(true);
    if empty {
        return shell_inbox(State(app)).await;
    }
    let boot = json!({ "view": "home", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "snyvi")
}

/// The Inbox, at `/inbox` since `/` became Home: every document, newest
/// first, with what is waiting at the top.
async fn shell_inbox(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let inbox = app.store.inbox(50).unwrap_or_default();
    // A single project is shown expanded, so its rows are wanted on this page
    // and are worth the bytes rather than a second round trip. Any more than
    // one and the reader's own choice of what is open decides, which is in
    // their browser and not here.
    let sub = match tree.as_slice() {
        [only] => subtree(&app, only.id, None),
        _ => serde_json::Value::Object(Default::default()),
    };
    let mut boot = json!({ "view": "inbox", "tree": tree, "sub": sub, "inbox": inbox, "browse": app.browse.list(), "version": VERSION });
    // An empty library opens on the connect page, and the page is on screen
    // with the sidebar rather than a round trip after it.
    if inbox.is_empty() {
        boot["agents"] = agents_json(&app);
    }
    shell(&app, boot, "", "snyvi")
}

/// The connect page, asked for: from `?`, or by its address.
async fn shell_connect(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "connect", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION, "agents": agents_json(&app) });
    shell(&app, boot, "", "Agents · snyvi")
}

/// The first ten minutes: a page the client draws (`ui/about.js`), asked for
/// from `?`, the connect page, ⌘K `>`, or an aside's link.
async fn shell_start(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "start", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "How snyvi works · snyvi")
}

/// Welcome: what snyvi is, and one question -- which project first. The page
/// an empty window opens on, drawn by `ui/about.js`; reopened from Help.
async fn shell_welcome(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "welcome", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Welcome · snyvi")
}

async fn shell_doc(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return not_found_page(&app);
    };
    let body = app.store.html(&id).unwrap_or_default();
    let tree = app.store.projects().unwrap_or_default();
    let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
    let title = doc.title.clone();
    let folder = doc_folder(&app, &doc);
    // The project this document is in is the one the sidebar opens on, so it
    // arrives with the page rather than a moment after it.
    let sub = subtree(&app, doc.project_id, Some(doc.workflow_id));
    // A page or a PDF is framed on a cold load as on an open from the
    // sidebar (`doc_json`): the page needs to know it is one.
    let preview = render::preview_kind(&doc_ext(&doc));
    let boot = json!({ "view": "doc", "tree": tree, "sub": sub, "doc": doc, "previous": previous, "folder": folder, "browse": app.browse.list(), "version": VERSION,
        "preview": preview, "preview_url": preview.map(|_| format!("/api/docs/{id}/blob")) });
    shell(&app, boot, &doc_html(&doc, &body), &title)
}

/// A desk, by its address. The page is the same page in a window and a tab --
/// what differs is that a tab holds no capability, and the desk view says so
/// in one sentence rather than drawing a grid that could never run anything.
/// Home in one call: every desk with what its card shows, what is waiting,
/// the update, the agents and the account's quota. The desk half is behind
/// the desk gate, as `/api/desks` is: a tab gets the rest, and a line saying
/// desks are the window's.
///
/// A desk's card is where the work stands -- when it was last touched, where
/// it was left or else the last thing that happened on it, what is open, what
/// git says in its folder -- and `days` is what happened on every desk over the
/// last `DAYS_SHOWN` days, a row per tick, document, left-off line and commit,
/// for the page to group by the reader's own days. `pulse` is each desk's
/// active hours over git's `WEEKS`, for its rhythm. Git is read off the
/// runtime, a folder at a time, and kept for half a minute (`crate::git`).
async fn home(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let gated = refuse_desk(&app, &headers, &q).is_none();
    let app2 = app.clone();
    let (desks, days) = if gated {
        tokio::task::spawn_blocking(move || home_desks(&app2))
            .await
            .unwrap_or((serde_json::Value::Null, serde_json::Value::Null))
    } else {
        (serde_json::Value::Null, serde_json::Value::Null)
    };
    Json(json!({
        "desks": desks,
        "days": days,
        "queue": app.store.queue(5).unwrap_or_default(),
        "waiting": waiting(&app),
        "update": update_json(&app),
        "agents": app.online(),
        "quota": *app.quota.lock().unwrap_or_else(|e| e.into_inner()),
        "version": VERSION,
    }))
    .into_response()
}

/// How many days of rows Home's log is sent: a week, and the day before it,
/// so "this week" is whole on any day it is read.
const DAYS_SHOWN: i64 = 8;

/// How many of a desk's open lines Home shows under it before "and N more".
const HOME_NOTES: usize = 5;

/// The desk half of Home, blocking: the store and git.
fn home_desks(app: &App) -> (serde_json::Value, serde_json::Value) {
    let now = crate::store::now();
    let since = now - crate::git::WEEKS * 7 * 86_400;
    let shown = now - DAYS_SHOWN * 86_400;
    let list = app.store.desks().unwrap_or_default();
    let done = app.store.desks_done_since(since).unwrap_or_default();
    let sent = app.store.desks_sent_since(since).unwrap_or_default();
    let mut days: Vec<serde_json::Value> = Vec::new();
    let cards: Vec<serde_json::Value> = list
        .iter()
        .map(|d| {
            let mut notes = app.store.desk_notes(d.id).unwrap_or_default();
            settle_stages(app, &mut notes);
            let open = notes.iter().filter(|n| !n.done && n.suggested_by.is_empty()).count();
            let notes_done = notes.iter().filter(|n| n.done).count();
            let suggested = notes.iter().filter(|n| !n.done && !n.suggested_by.is_empty()).count();
            // The first open lines, by id as well as by text: Home ticks
            // them where they stand, and adds to the list, without the desk.
            let next: Vec<serde_json::Value> = notes
                .iter()
                .filter(|n| !n.done && n.suggested_by.is_empty())
                .take(HOME_NOTES)
                .map(|n| json!({ "id": n.id, "text": n.text, "stage": n.stage, "stage_by": n.stage_by,
                    "stage_doc": n.stage_doc, "stage_panel": n.stage_panel,
                    // Its dot breathes only while the agent is at it.
                    "stage_busy": n.stage == "working" && app.panes.status(&n.stage_pane).agent == "working" }))
                .collect();
            let last_doc = app.store.desk_docs(d.id, 1, false).unwrap_or_default().into_iter().next();
            let git = app.git.read(std::path::Path::new(&d.root), now);
            let ticks: Vec<&crate::desk::Done> = done.iter().filter(|t| t.desk_id == d.id).collect();
            let docs: Vec<&(i64, String, String, i64)> = sent.iter().filter(|x| x.0 == d.id).collect();
            let commits: &[crate::git::Commit] = git.as_deref().map(|g| g.commits.as_slice()).unwrap_or(&[]);

            // The rows of the log.
            for t in ticks.iter().filter(|t| t.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "tick", "at": t.at, "text": t.text, "by": t.by,
                    "commit": t.commit, "doc": t.doc, "evidence": t.evidence }));
            }
            for x in docs.iter().filter(|x| x.3 >= shown) {
                days.push(json!({ "desk": d.id, "kind": "doc", "at": x.3, "id": x.1, "text": x.2 }));
            }
            for c in commits.iter().filter(|c| c.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "commit", "at": c.at, "hash": c.hash, "text": c.subject }));
            }
            if let Some(l) = d.left_off.as_ref().filter(|l| l.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "left", "at": l.at, "text": l.text, "by": l.by }));
            }

            // Its rhythm: the hours anything happened in, once each.
            let mut pulse: Vec<i64> = ticks
                .iter()
                .map(|t| t.at)
                .chain(docs.iter().map(|x| x.3))
                .chain(commits.iter().map(|c| c.at))
                .chain(d.left_off.iter().map(|l| l.at))
                .filter(|&at| at >= since)
                .map(|at| at - at.rem_euclid(3600))
                .collect();
            pulse.sort_unstable();
            pulse.dedup();

            // The last thing that happened, for a desk no one said Left off on.
            let tick = ticks.last().map(|t| (t.at, json!({ "kind": "tick", "at": t.at, "text": t.text, "commit": t.commit })));
            let doc = last_doc.as_ref().map(|x| (x.received_at, json!({ "kind": "doc", "at": x.received_at, "text": x.title, "id": x.id })));
            let last = match (tick, doc) {
                (Some(t), Some(x)) => Some(if t.0 >= x.0 { t.1 } else { x.1 }),
                (t, x) => t.or(x).map(|p| p.1),
            };

            // Touched: opened, or anything that happened on it.
            let touched = [
                d.visited_at,
                d.left_off.as_ref().map_or(0, |l| l.at),
                last_doc.as_ref().map_or(0, |x| x.received_at),
                ticks.last().map_or(0, |t| t.at),
                git.as_deref().and_then(|g| g.last.as_ref()).map_or(0, |c| c.at),
            ]
            .into_iter()
            .max()
            .unwrap_or(0);

            let panes: Vec<serde_json::Value> = d
                .panes
                .iter()
                .map(|p| {
                    let st = app.panes.status(&p.id);
                    json!({
                        "id": p.id, "slot": p.slot, "name": p.name,
                        "running": st.running, "agent": st.agent, "agent_since": st.agent_since,
                        "blocked": st.blocked, "blocked_since": st.blocked_since,
                        "title": st.title, "model": st.model,
                        "ctx_pct": st.ctx_pct, "ctx_used": st.ctx_used, "ctx_size": st.ctx_size,
                    })
                })
                .collect();
            json!({
                "id": d.id, "name": d.name, "root": d.root, "left_off": d.left_off,
                "visited_at": d.visited_at, "parked": d.parked, "touched": touched,
                "panes": panes, "open": open, "done": notes_done, "suggested": suggested, "next": next,
                "last": last, "git": git.as_deref(), "pulse": pulse,
                // By name, for Home's Keys widget; never a value.
                "keys": d.keys,
            })
        })
        .collect();
    days.sort_by_key(|r| r["at"].as_i64().unwrap_or(0));
    (json!(cards), json!(days))
}

/// The reader opened a desk: Home's "last touched" and the desk it offers to
/// pick up are read from this.
async fn visit_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.visit_desk(id) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct ParkBody {
    /// Park with this next step; absent takes the desk down off the shelf.
    #[serde(default)]
    next: Option<String>,
}

/// Put a desk on the shelf with its next step, or take it down. What it was
/// comes back, for the Undo in the row.
async fn park_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<ParkBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.park_desk(id, b.next.as_deref()) {
        Ok(Some(was)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "was": was })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct WeekBody {
    title: String,
    content: String,
}

/// A week of a desk's log, as a document in the desk's own project: the
/// page writes the markdown from the rows it drew, and the folder it is filed
/// under is the desk's, never one the page names.
async fn desk_week(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<WeekBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let payload = Payload {
        content: Some(b.content),
        title: Some(b.title.chars().take(200).collect()),
        workflow: Some("Your days".into()),
        lang: Some("md".into()),
        cwd: Some(desk.root),
        origin: Some("home".into()),
        sender: Some("snyvi".into()),
        ..Default::default()
    };
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || {
        receive::receive(&app2.store, &app2.renderer, payload)
    })
    .await
    {
        Ok(Ok(received)) => {
            let doc = received.doc;
            emit(
                &app,
                "doc",
                json!({ "doc": doc, "url": format!("{}/d/{}", config::base_url(), doc.id), "existing": received.existing, "supersedes": received.supersedes, "waiting": waiting(&app) }),
            );
            Json(json!({ "ok": true, "id": doc.id })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// So nothing about a desk is in this answer: the page asks for it with the
/// capability, or cannot.
async fn shell_desk(State(app): S, Path(id): Path<i64>) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "desk", "desk": id, "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Desk · snyvi")
}

/// Every desk, which is where the sidebar's `Desks` row goes.
async fn shell_desk_list(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "desk", "desk": null, "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Desks · snyvi")
}

// ---------- assets ----------

fn immutable(content_type: &'static str, body: impl Into<Body>) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        body.into(),
    )
        .into_response()
}

/// An asset that is immutable for a shipped build -- its URL carries the
/// build hash, so a year is the right answer -- and uncached while the UI is
/// live, where the whole point is that the next request sees the edit.
fn asset(app: &App, content_type: &'static str, name: &str, built_in: &'static str) -> Response {
    let body = app.ui.text(name, built_in).into_owned();
    if !app.ui.live() {
        return immutable(content_type, body);
    }
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        body,
    )
        .into_response()
}

async fn asset_css(State(app): S) -> Response {
    asset(&app, "text/css; charset=utf-8", "app.css", APP_CSS)
}
async fn asset_js(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "app.js",
        APP_JS,
    )
}
async fn asset_boot(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "boot.js",
        BOOT_JS,
    )
}
/// The diagram driver. Immutable like the rest for a shipped build, and served
/// on the same terms as app.js -- it is the same UI, split at the one seam where
/// most page loads do not need what is on the other side.
async fn asset_mmd(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "mmd.js",
        MMD_JS,
    )
}
/// The desk view, on the same terms as the diagram driver.
async fn asset_desk(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "desk.js",
        DESK_JS,
    )
}
/// The window's frame, on the same terms: a tab never asks for it.
async fn asset_frame(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "frame.js",
        FRAME_JS,
    )
}
/// The game, on the same terms: nothing asks for it but the rocket.
async fn asset_game(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "game.js",
        GAME_JS,
    )
}
/// The about panel and the reset dialog, on the same terms: nothing asks for
/// them but the two buttons that open them.
async fn asset_about(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "about.js",
        ABOUT_JS,
    )
}
/// Find, on the same terms: the bar is not up until someone puts it up.
async fn asset_find(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "find.js",
        FIND_JS,
    )
}
/// The key mode's pill, on the same terms: the letters have not been woken
/// until someone presses ⌃B.
async fn asset_keys(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "keys.js",
        KEYS_JS,
    )
}
/// The folder menu and the desk actions, on the same terms: nothing here has
/// happened until someone has clicked something.
/// ⌘K, on the same terms: nothing asks for it but the first ⌘K.
async fn asset_palette(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "palette.js",
        PALETTE_JS,
    )
}
/// The look steppers, on the same terms: the page asks once it is idle.
async fn asset_look(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "look.js",
        LOOK_JS,
    )
}
/// The aside card, on the same terms: asked for when there is an aside.
async fn asset_note(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "note.js",
        NOTE_JS,
    )
}
/// The tip, on the same terms: asked for when a control is first rested on.
async fn asset_tip(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "tip.js",
        TIP_JS,
    )
}
/// Home, on the same terms: asked for when Home is first shown.
async fn asset_home(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "home.js",
        HOME_JS,
    )
}
/// The toast, on the same terms: asked for the first time something is said.
async fn asset_toast(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "toast.js",
        TOAST_JS,
    )
}
/// The comparison and the split diff, on the same terms.
async fn asset_diff(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "diff.js",
        DIFF_JS,
    )
}
/// A folder's page and a file from disk, on the same terms.
async fn asset_browse(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "browse.js",
        BROWSE_JS,
    )
}
/// Ctrl-click on a path, in a panel or in the reader, on the same terms:
/// asked the first time Ctrl is held in a window that holds a capability.
async fn asset_paths(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "paths.js",
        PATHS_JS,
    )
}
/// The other themes, on the same terms: the page asks once it is idle.
async fn asset_themes(State(app): S) -> Response {
    asset(&app, "text/css; charset=utf-8", "themes.css", THEMES_CSS)
}
async fn asset_menu(State(app): S) -> Response {
    asset(
        &app,
        "application/javascript; charset=utf-8",
        "menu.js",
        MENU_JS,
    )
}
async fn asset_mermaid() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/javascript; charset=utf-8"),
            ),
            (header::CONTENT_ENCODING, HeaderValue::from_static("gzip")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        MERMAID_JS_GZ,
    )
        .into_response()
}

/// Images referenced relatively from a document, resolved against the source file's
/// directory and confined to the project root. Image types only.
async fn doc_file(State(app): S, Path((id, rel)): Path<(String, String)>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(src) = doc.source_path.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(dir) = std::path::Path::new(src).parent() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = dir.join(&rel);
    let ext = target
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !render::is_image_ext(&ext) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (Ok(canon), Ok(root)) = (
        target.canonicalize(),
        crate::project::resolve(dir).root.canonicalize(),
    ) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !canon.starts_with(&root) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match tokio::fs::read(&canon).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&canon)
                .first_or_octet_stream()
                .to_string();
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "private, max-age=300".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn asset_font(Path(name): Path<String>) -> Response {
    match FONTS.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => immutable("font/woff2", *bytes),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------- api ----------

async fn health(State(app): S) -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "version": VERSION,
        "commit": BUILD_SHA,
        // So `snyvi stop` can end this exact process if it ignores the
        // shutdown endpoint, without having to guess which snyvi it is.
        "pid": std::process::id(),
        // The file it runs from, so a restart can tell its successor from
        // another snyvi that happens to hold the port.
        "exe": app.exe.as_ref().map(|e| e.path.display().to_string()),
        "docs": app.store.count().unwrap_or(0),
        // Whether a link should be handed to a window or opened in a browser.
        // `snyvi open`, `snyvi browse` and the MCP server all ask here.
        "window": app.has_window(),
        "streams": app.streams.load(Ordering::Relaxed),
        // How many pane processes are running, so `snyvi bench` and a person
        // with curl can see what a desk is costing without a window open.
        "panes": app.panes.running(),
        // Which agents hold a stream right now, by the name each gave.
        "agents": app.online(),
        // The bundle this daemon serves, so a page that reconnects after an
        // upgrade can tell it is running another one's and reload.
        "v": app.asset_v(),
        "languages": app.renderer.languages().len(),
        "uptime_s": app.started.elapsed().as_secs(),
        // When this process started, so a restart can be seen to have
        // happened even when the version did not change.
        "started": app.started_at,
        // The file this daemon runs from has been replaced since it started:
        // an upgrade by a package manager, a copy by hand, the updater. A
        // restart would pick the new one up.
        "stale": app.exe.as_ref().is_some_and(Exe::stale),
        // A restart asked for and waiting for the panes to be quiet, with
        // the panes it is waiting on; null when none is.
        "restart": restart_json(&app),
        // What is out, what is staged, and when it may go. See `crate::update`.
        "update": update_json(&app),
    }))
}

/// The about panel: what this is, which build is answering, where its
/// files are, and what Claude Code has of it. The version comes from here
/// and not from the page's bundle, so the panel cannot name a number
/// `snyvi --version` would not.
async fn about(State(app): S) -> Json<serde_json::Value> {
    // The path recorded at start, not `current_exe()` now: after the file
    // has been replaced under this process the latter says `(deleted)`.
    let exe = app.exe.as_ref().map(|e| e.path.clone());
    Json(json!({
        "name": "snyvi",
        "description": env!("CARGO_PKG_DESCRIPTION"),
        "version": VERSION,
        "commit": BUILD_SHA,
        "target": BUILD_TARGET,
        "binary": exe.as_deref().map(|p| p.display().to_string()),
        "stale": app.exe.as_ref().is_some_and(Exe::stale),
        "data_dir": app.paths.data_dir.display().to_string(),
        "config_dir": app.paths.config_dir.display().to_string(),
        "agents": std::iter::once(crate::setup::claude_code_status())
            .chain(crate::agents::status_lines())
            .collect::<Vec<_>>()
            .join("\n"),
        "license": env!("CARGO_PKG_LICENSE"),
        "repository": env!("CARGO_PKG_REPOSITORY"),
        "docs": app.store.count().unwrap_or(0),
        "uptime_s": app.started.elapsed().as_secs(),
        "update": update_json(&app),
    }))
}

/// The connect page's rows: every agent and what its own file says it has
/// of snyvi, read now, whether it is here now, and when each last sent
/// something. `program` is how this binary is spelled to them, for the page
/// to show in its commands.
async fn agents(State(app): S) -> Response {
    Json(agents_json(&app)).into_response()
}

/// Connect Claude Code from the window: what `snyvi init-claude --auto` does
/// in a terminal, run by this binary for this binary -- never for another
/// one -- after the reader said yes to what it writes. The window's gate,
/// as a desk is: a tab cannot change what Claude Code runs. It answers with
/// what init printed and the agents as they are now.
async fn connect_claude(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // The path this daemon was started from, as the updater keeps it: once an
    // update has renamed a new file over it, `current_exe` names the old one,
    // gone (`… (deleted)` on Linux), and the same program is at the path.
    let recorded = app.exe.as_ref().map(|e| e.path.clone());
    let ran = tokio::task::spawn_blocking(move || {
        let exe = match recorded {
            Some(p) => p,
            None => std::env::current_exe()?,
        };
        std::process::Command::new(exe)
            .args(["init-claude", "--auto"])
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await;
    match ran {
        Ok(Ok(out)) => {
            let said = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            Json(json!({ "ok": out.status.success(), "said": said.trim(), "agents": agents_json(&app) }))
                .into_response()
        }
        Ok(Err(e)) => err(e.into()),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

fn agents_json(app: &App) -> serde_json::Value {
    let senders = app.store.senders().unwrap_or_default();
    let online = app.online.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({
        "program": crate::setup::program().0,
        // Whether a new desk's first panel can offer `claude`: on the
        // daemon's PATH, or registered (which it would not be without it).
        "claude_on_path": crate::platform::find_on_path("claude").is_some(),
        "rows": crate::agents::rows(&senders, &online),
        "online": online,
        "now": crate::store::now(),
    })
}

async fn tree(State(app): S) -> Response {
    match app.store.projects() {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct TreeQ {
    workflows: Option<usize>,
    docs: Option<usize>,
    /// A workflow to send whole whatever the caps are: the one the reader is in.
    whole: Option<i64>,
}

/// What one project holds, fetched when a reader expands it. Zero for either
/// cap means all of them: that is a reader who clicked past the cap, and the
/// answer to "show me the rest" is the rest.
async fn project_tree(State(app): S, Path(id): Path<i64>, Query(q): Query<TreeQ>) -> Response {
    let workflows = q.workflows.unwrap_or(TREE_WORKFLOWS);
    let docs = q.docs.unwrap_or(TREE_DOCS);
    Json(project_rows(&app, id, workflows, docs, q.whole)).into_response()
}

/// One workflow, whole. Asked for by the tree when a reader wants everything in
/// a session, and by nothing else.
async fn workflow_tree(State(app): S, Path(id): Path<i64>) -> Response {
    match app.store.workflow_tree(id) {
        Ok(Some(w)) => Json(w).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct Limit {
    limit: Option<usize>,
}

async fn inbox(State(app): S, Query(q): Query<Limit>) -> Response {
    match app.store.inbox(q.limit.unwrap_or(50).min(500)) {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct SearchQ {
    q: String,
    limit: Option<usize>,
}

async fn search(State(app): S, Query(q): Query<SearchQ>) -> Response {
    match app.store.search(&q.q, q.limit.unwrap_or(30).min(200)) {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

async fn doc_json(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.get(&id) {
        Ok(Some(doc)) => {
            let body = app.store.html(&id).unwrap_or_default();
            let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
            // Every version of the same file, so the rail's foot is drawn whole
            // with the document: a list fetched after the paint grew the foot
            // and pushed every row above it up (#53). None for one alone.
            let history = doc
                .source_path
                .as_deref()
                .and_then(|p| app.store.history(doc.project_id, p).ok())
                .filter(|h| h.len() > 1);
            // A stored page or PDF is framed from its own bytes. Only the one file was
            // snapshotted, so unlike browse mode there are no sibling assets to load.
            // Sent as `content` with `lang: "html"`, it is a page all the same.
            let preview = render::preview_kind(&doc_ext(&doc));
            Json(json!({
                "doc": doc,
                "html": doc_html(&doc, &body),
                "previous": previous,
                "history": history,
                "preview": preview,
                "preview_url": preview.map(|_| format!("/api/docs/{id}/blob")),
                // So the page knows whether there is a terminal button to draw.
                // A control that is disabled and cannot say why is worse than
                // no control, and the directory is not something the page can
                // work out for itself -- it is a parent path on a machine whose
                // separator the page does not know.
                "folder": doc_folder(&app, &doc),
            }))
            .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn doc_raw(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.source(&id) {
        Ok(src) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], src).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// A stored document's bytes, as they arrived. This is how an image document's
/// `<img>` gets its picture and a video's player its frames; the content type
/// comes from the source file's name so the browser knows what it is.
/// What a stored document is, by extension: its file's, or for one sent as
/// `content`, the `lang` it was sent with -- which is how an agent's inline
/// HTML page is a page and not its source.
fn doc_ext(doc: &crate::store::Doc) -> String {
    match (doc.source_path.as_deref(), doc.lang.as_deref()) {
        (Some(p), _) => render::ext_of(p),
        (None, Some(l)) => l.trim().to_ascii_lowercase(),
        (None, None) => String::new(),
    }
}

async fn doc_blob(State(app): S, Path(id): Path<String>, req: HeaderMap) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = doc_ext(&doc);
    let mime = if ext.is_empty() {
        "application/octet-stream".to_string()
    } else {
        mime_guess::from_ext(&ext)
            .first_or_octet_stream()
            .to_string()
    };
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    // Documents are immutable, so the bytes behind an id never change.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000"),
    );
    protect(&mut headers, &ext);
    serve_file(&app.store.src_path(&id), headers, &req).await
}

#[derive(Deserialize)]
struct ViewQ {
    view: Option<String>,
}

async fn doc_split(State(app): S, Path(id): Path<String>) -> Response {
    match (app.store.get(&id), app.store.source(&id)) {
        (Ok(Some(doc)), Ok(src)) if doc.kind == crate::render::Kind::Diff => {
            Json(json!({ "html": render::diff_split(&src) })).into_response()
        }
        (Ok(Some(_)), _) => StatusCode::BAD_REQUEST.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Declarations in a stored code document, for the rail.
async fn doc_outline(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if doc.kind != crate::render::Kind::Code {
        return Json(Vec::<crate::render::Outline>::new()).into_response();
    }
    if let Some(json) = app.store.outline(&id) {
        return ([(header::CONTENT_TYPE, "application/json")], json).into_response();
    }
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || outline_of(&app2, &id, doc.lang.as_deref())).await {
        Ok(Some(json)) => ([(header::CONTENT_TYPE, "application/json")], json).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// A stored code document's outline, worked out and kept beside its HTML. A
/// document does not change, so this runs once: on arrival, in the background,
/// or on the first open of one that came before outlines were kept.
fn outline_of(app: &App, id: &str, lang: Option<&str>) -> Option<String> {
    let src = app.store.source(id).ok()?;
    let json = serde_json::to_string(&app.renderer.outline(lang, &src)).ok()?;
    let _ = app.store.set_outline(id, &json);
    Some(json)
}

async fn history(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(path) = doc.source_path.as_deref() else {
        return Json(Vec::<Doc>::new()).into_response();
    };
    match app.store.history(doc.project_id, path) {
        Ok(h) => Json(h).into_response(),
        Err(e) => err(e),
    }
}

/// Delete at once, and say nothing first. The page offers Undo for a few
/// seconds; the document is on disk until `prune` runs either way.
async fn delete_doc(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.delete_versions(&id) {
        Ok(n) if n > 0 => {
            emit(
                &app,
                "deleted",
                json!({ "id": id, "waiting": waiting(&app) }),
            );
            Json(json!({ "ok": true, "versions": n })).into_response()
        }
        Ok(_) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// What can still come back after its Undo has gone, newest first until
/// prune takes it: the page's "Removed · Show" (docs/DESIGN.md §4.4). The
/// desk rows -- notes off a list, closed panels -- only for a page holding
/// the desk capability, the gate every desk route has; without it the list
/// is the documents and the asides, which any page can already see.
async fn removed_list(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    const ROWS: usize = 100;
    let desks = refuse_desk(&app, &headers, &q).is_none();
    let mut items = match app.store.removed(ROWS, desks) {
        Ok(v) => v,
        Err(e) => return err(e),
    };
    for a in app.asides.list().into_iter().filter(|a| a.dismissed) {
        items.push(crate::store::Removed {
            kind: "aside",
            id: a.id.to_string(),
            title: a.text,
            from: a.sender.unwrap_or_default(),
            desk: None,
            at: a.at,
            versions: 1,
            restore: "/api/notes/restore".into(),
        });
    }
    items.sort_by_key(|a| std::cmp::Reverse(a.at));
    items.truncate(ROWS);
    Json(json!({ "items": items })).into_response()
}

/// The other half of Undo. Gone means pruned, which is the one delete that
/// cannot be taken back.
async fn undelete_doc(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.undelete(&id) {
        Ok(true) => {
            let doc = app.store.get(&id).ok().flatten();
            emit(
                &app,
                "restored",
                json!({ "id": id, "doc": doc, "waiting": waiting(&app) }),
            );
            Json(json!({ "ok": true, "doc": doc })).into_response()
        }
        Ok(false) => (
            StatusCode::GONE,
            Json(json!({ "error": "that document has been pruned" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// Ask the daemon to exit, so a new binary can take over the port.
async fn shutdown(State(app): S, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let _ = app.shutdown.send(());
    Json(json!({ "ok": true, "version": VERSION })).into_response()
}

#[derive(Deserialize)]
struct RestartBody {
    /// `idle` (the default) waits until no pane is busy; `now` does not.
    #[serde(default)]
    when: Option<String>,
    /// Take the staged update on the way: the files are swapped at the
    /// planned exit and the successor is the new version.
    #[serde(default)]
    apply: bool,
    /// Put the previous version back on the way instead.
    #[serde(default)]
    back: bool,
}

/// Ask the daemon to restart itself: at once, or as soon as no pane has an
/// agent mid-turn or a program printing. The panes an agent was in come
/// back as `claude --resume`; the rest as shells with their old screen
/// greyed above, which is what any restart already does. Answers to the
/// token (`snyvi restart`) or the window's capability (a click on the
/// update pill); a tab holds neither. Asking again adds to the restart
/// already pending rather than queueing another: `snyvi restart` while the
/// pill's update waits still takes the update, and `--now` hurries both.
async fn restart(State(app): S, headers: HeaderMap, Json(b): Json<RestartBody>) -> Response {
    let cap = headers
        .get(CAPABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| app.capabilities.verify(c.trim()));
    if !cap && !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let now = match b.when.as_deref().unwrap_or("idle") {
        "idle" => false,
        "now" => true,
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("when must be idle or now, not {other:?}") })),
            )
                .into_response()
        }
    };
    if b.apply && app.update.as_ref().is_none_or(|u| u.staged().is_none()) {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": "nothing is staged to apply; `snyvi update` checks and stages" }),
            ),
        )
            .into_response();
    }
    if b.back && !app.update.as_ref().is_some_and(|u| u.can_go_back()) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "there is no previous version beside this one to go back to" })),
        )
            .into_response();
    }
    let now = {
        let mut slot = app.restart.lock().unwrap();
        let was = *slot;
        let p = Pending {
            since: was.map(|p| p.since).unwrap_or_else(Instant::now),
            apply: b.apply || was.is_some_and(|p| p.apply),
            back: b.back || was.is_some_and(|p| p.back),
            now: now || was.is_some_and(|p| p.now),
        };
        *slot = Some(p);
        p.now
    };
    let waiting_on = if now { vec![] } else { app.panes.busy() };
    let waiting = waiting_named(&app, &waiting_on);
    app.restart_wake.notify_one();
    emit_update(&app);
    Json(json!({ "ok": true, "waiting_on": waiting_on, "waiting": waiting, "version": VERSION }))
        .into_response()
}

/// Call off a restart that is waiting for quiet: `snyvi restart --cancel`,
/// Ctrl-C under `snyvi restart`, and the pill's Cancel. The same who as
/// asking. One already under way is past calling off, and says so.
async fn cancel_restart(State(app): S, headers: HeaderMap) -> Response {
    if !capable(&app, &headers) && !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let cancelled = app.restart.lock().unwrap().take().is_some();
    if cancelled {
        eprintln!("snyvi: the restart that was waiting is called off");
    }
    emit_update(&app);
    Json(json!({ "ok": true, "cancelled": cancelled })).into_response()
}

#[derive(Deserialize)]
struct UpdateCheckBody {
    /// One release by number, for `snyvi update --to`; may go down.
    #[serde(default)]
    to: Option<String>,
    /// Whether what is found goes past the daily floor: Check now and
    /// `snyvi update` (and every client from before this field); not
    /// `snyvi update check`, which a script may run every hour.
    #[serde(default = "yes")]
    lift: bool,
}

fn yes() -> bool {
    true
}

/// `Check now` in About, and `snyvi update`: read the manifest, stage what
/// it names, and say. What it finds newer goes past the daily floor unless
/// `lift` is false. Token or capability; a bare tab has neither.
async fn update_check(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<UpdateCheckBody>,
) -> Response {
    if !capable(&app, &headers) && !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let Some(u) = app.update.clone() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "this daemon cannot say what file it runs from, so it does not update itself" }))).into_response();
    };
    if u.channel == crate::update::Channel::Dev {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a development build does not update itself" })),
        )
            .into_response();
    }
    if let Some(to) = &b.to {
        if semver::Version::parse(to).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("{to:?} is not a version") })),
            )
                .into_response();
        }
    }
    let to = b.to.clone();
    let ask = crate::update::Ask {
        fresh: true,
        lift: b.lift,
    };
    let r = tokio::task::spawn_blocking(move || u.check(ask, to.as_deref())).await;
    emit_update(&app);
    app.restart_wake.notify_one();
    match r {
        Ok(Ok(c)) => {
            // A person asking is a person who wants to hear: a "Later" on
            // the version found is off.
            if b.lift {
                if let Some(u) = &app.update {
                    let _ = u.snooze(None, crate::store::now());
                }
            }
            Json(json!({
                "ok": true,
                "running": c.running.to_string(),
                "latest": c.latest.to_string(),
                "newer": c.newer(),
                "ready": c.ready,
                "told": c.told,
                "update": update_json(&app),
            }))
            .into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("{e:#}"), "update": update_json(&app) })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!("the check did not finish: {e}")),
    }
}

#[derive(Deserialize)]
struct UpdateAutoBody {
    on: bool,
}

/// `Updates: on / off` in About, and `snyvi update on|off`. Written to
/// `<config>/updates.json`; `SNYVI_UPDATES=off` in the daemon's environment
/// wins, and the answer says so.
async fn update_auto(State(app): S, headers: HeaderMap, Json(b): Json<UpdateAutoBody>) -> Response {
    if !capable(&app, &headers) && !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let Some(u) = &app.update else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this daemon does not update itself" })),
        )
            .into_response();
    };
    match u.set_auto(b.on) {
        Ok(auto) => {
            emit_update(&app);
            Json(json!({ "ok": true, "auto": auto, "update": update_json(&app) })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct LaterBody {
    /// Until when, in seconds since the epoch: the page says "tomorrow
    /// morning" in the reader's own time. Absent brings the offer back.
    #[serde(default)]
    until: Option<i64>,
}

/// "Later" on the update card: the offer of this version waits until then,
/// in every window, since it is the daemon's word the windows draw from.
async fn update_later(State(app): S, headers: HeaderMap, Json(b): Json<LaterBody>) -> Response {
    if !capable(&app, &headers) && !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    let Some(u) = &app.update else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this daemon does not update itself" })),
        )
            .into_response();
    };
    match u.snooze(b.until, crate::store::now()) {
        Ok(()) => {
            emit_update(&app);
            Json(json!({ "ok": true, "update": update_json(&app) })).into_response()
        }
        Err(e) => err(e),
    }
}

/// The window's capability, on the header it rides.
fn capable(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get(CAPABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| app.capabilities.verify(c.trim()))
}

/// What a reset would take, for the sentence that asks.
async fn reset_census(State(app): S) -> Response {
    match app.store.census() {
        Ok(c) => Json(c).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct ResetBody {
    /// The number of documents the caller was shown and typed back. It has to
    /// be the number there is now: a document that arrived between the
    /// sentence and the answer makes the answer stale, and the caller is told
    /// to look again rather than reset a library other than the one described.
    documents: i64,
    /// Said explicitly, or the pinned documents keep the reset from happening.
    #[serde(default)]
    pinned: bool,
    /// The number of desks the caller was shown, checked the way the documents
    /// are. Missing reads as none: a caller that never said there were desks
    /// never showed the reader any, and is refused if there are.
    #[serde(default)]
    desks: i64,
}

/// Back to a fresh install: every document and version, the index, the token,
/// and -- by the event this ends with -- the preferences every open page keeps.
/// The daemon stays up and the agents stay registered, so the next send lands
/// in an empty library. The one action here that cannot be undone, and the one
/// that asks for a number rather than a click.
///
/// A same-origin POST is accepted beside the token, as `terminal` explains:
/// the page has no token, and the dialog is the page's.
/// "1 document", "3 documents": the reset refusals are read by a person.
fn docs(n: i64) -> String {
    format!("{n} document{}", if n == 1 { "" } else { "s" })
}
fn pinned_docs(n: i64) -> String {
    format!("{n} pinned document{}", if n == 1 { "" } else { "s" })
}

async fn reset(State(app): S, headers: HeaderMap, Json(b): Json<ResetBody>) -> Response {
    if !from_this_page(&headers) && !authorized(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page, and no token" })),
        )
            .into_response();
    }
    let census = match app.store.census() {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    if b.documents != census.documents {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("the library has changed: {} now, not {}", docs(census.documents), b.documents),
                "census": census,
            })),
        )
            .into_response();
    }
    if b.desks != census.desks {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("the desks have changed: {} now, not {}", census.desks, b.desks),
                "census": census,
            })),
        )
            .into_response();
    }
    if census.pinned > 0 && !b.pinned {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("{} would go with it", pinned_docs(census.pinned)),
                "census": census,
            })),
        )
            .into_response();
    }
    // The wipe and the VACUUM are disk work, and on a disk under pressure
    // they take as long as they take: off the runtime, so the other pages'
    // requests -- and the reload they are about to make -- are still answered.
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || app2.store.reset()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return err(e),
        Err(e) => return err(anyhow::anyhow!("reset task: {e}")),
    }
    // The store has let go of every pane; the processes and their text go too.
    app.panes.clear();
    for root in app.browse.list() {
        app.browse.close(&root.id);
    }
    app.browse.forget_closed();
    let _ = std::fs::remove_file(app.paths.config_dir.join("sessions.json"));
    let _ = std::fs::remove_file(app.paths.config_dir.join("folders.json"));
    match config::rotate_token(&app.paths) {
        Ok(t) => *app.token.write().unwrap() = t,
        Err(e) => return err(e),
    }
    emit(&app, "reset", json!({}));
    Json(json!({ "ok": true, "removed": census })).into_response()
}

/// Open tabs report focus so arrivals only raise a desktop notification when nobody is looking.
async fn focus(State(app): S) -> StatusCode {
    *app.last_focus.lock().unwrap() = Instant::now();
    StatusCode::NO_CONTENT
}

fn notify_desktop(app: &App, doc: &Doc) {
    if std::env::var("SNYVI_NOTIFY")
        .map(|v| v == "0")
        .unwrap_or(false)
    {
        return;
    }
    let focused_recently =
        app.last_focus.lock().unwrap().elapsed() < std::time::Duration::from_secs(4);
    if focused_recently {
        return;
    }
    // Clicking it opens the document where the reader reads: the window it
    // belongs to, raised, or a browser when there is no window. The daemon is
    // the one process that knows which, so it decides here rather than handing
    // a URL to the desktop and hoping.
    let url = format!("{}/d/{}", config::base_url(), doc.id);
    let has_window = app.has_window();
    crate::platform::notify_open(
        &doc.title,
        &format!("{} · {}", doc.project, doc.workflow_title),
        move || {
            if has_window && crate::desktop::hand_to_window(&url) {
                return;
            }
            platform::open_url(&url);
        },
    );
}

async fn compare(
    State(app): S,
    Path((a, b)): Path<(String, String)>,
    Query(v): Query<ViewQ>,
) -> Response {
    let (Ok(Some(da)), Ok(Some(db))) = (app.store.get(&a), app.store.get(&b)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (Ok(sa), Ok(sb)) = (app.store.source(&a), app.store.source(&b)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let a_name = format!("{} ({})", da.title, fmt_time(da.received_at));
    let b_name = format!("{} ({})", db.title, fmt_time(db.received_at));
    let unified = render::unified(&a_name, &sa, &b_name, &sb);
    let html = if unified.trim().is_empty() {
        "<p class=\"empty\">No changes between these two versions.</p>".to_string()
    } else if v.view.as_deref() == Some("split") {
        render::diff_split(&unified)
    } else {
        render::diff(&unified)
    };
    Json(json!({ "a": da, "b": db, "html": html })).into_response()
}

#[derive(Deserialize)]
struct EventsQ {
    /// Set by a page that is inside the native window, so the daemon knows
    /// there is one to hand a link to. A string rather than a bool because a
    /// query string is not JSON: `?window=1` is what a page would naturally
    /// send, and it is not a bool to serde.
    ///
    /// Forgeable, and deliberately kept anyway: it is a count hint, not a
    /// credential. `EventSource` cannot set a header, so the capability cannot
    /// ride this stream and the count has nowhere else to live; what makes that
    /// safe is that nothing reachable from here grants anything. See
    /// `App::windows`.
    #[serde(default)]
    window: Option<String>,
    /// Set by the MCP server, with the name its client gave in `initialize`,
    /// so the daemon knows that agent is here for as long as the stream is.
    #[serde(default)]
    agent: Option<String>,
}

impl EventsQ {
    fn is_window(&self) -> bool {
        self.window
            .as_deref()
            .is_some_and(|v| !matches!(v, "" | "0" | "false" | "False"))
    }

    /// What the window says of itself: a window from 1.7 on stamps its own
    /// number on the mark, and the page passes it along; an older one says
    /// `1`, which the updater reads as older than any.
    fn window_version(&self) -> Option<String> {
        self.window.clone().filter(|_| self.is_window())
    }

    /// The agent's name, trimmed and cut to a length the header can hold.
    /// None when it is empty, which is a page and not an agent.
    fn agent(&self) -> Option<String> {
        let name = self.agent.as_deref()?.trim();
        if name.is_empty() {
            return None;
        }
        Some(name.chars().take(64).collect())
    }
}

/// Held by an event stream for as long as that stream lasts. A page that is
/// closed, reloaded or navigated away from takes its connection with it, and
/// an agent's process that ends takes its own; every count follows. Nothing
/// here times out, so a window that is quit is not a window a moment later,
/// a page that is gone is not a socket, and an agent whose session was
/// closed is not here.
struct StreamMark {
    app: Arc<App>,
    window: bool,
    agent: Option<String>,
}

impl StreamMark {
    fn new(
        app: Arc<App>,
        window: bool,
        agent: Option<String>,
        window_version: Option<String>,
    ) -> StreamMark {
        app.streams.fetch_add(1, Ordering::Relaxed);
        if agent.is_none() {
            app.pages.fetch_add(1, Ordering::Relaxed);
        }
        if window {
            app.windows.fetch_add(1, Ordering::Relaxed);
            // A window older than the update just applied wants: asked to
            // quit, and started again once its stream has ended, below.
            // Most releases never touch the window, and it is left alone.
            if let Some(u) = &app.update {
                if u.window_is_too_old(window_version.as_deref()) {
                    if let Some(bin) = u.app_path() {
                        eprintln!("snyvi: the window is {}, older than this release wants; relaunching it", window_version.as_deref().unwrap_or("?"));
                        app.relaunch_window.store(true, Ordering::Relaxed);
                        if let Err(e) = platform::spawn_detached(&bin, &["--quit"]) {
                            eprintln!("snyvi: could not ask the window to quit: {e}");
                            app.relaunch_window.store(false, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        if let Some(name) = &agent {
            let changed = {
                let mut m = app.online.lock().unwrap_or_else(|e| e.into_inner());
                *m.entry(name.clone()).or_insert(0) += 1;
                json!(*m)
            };
            emit(&app, "agents", json!({ "online": changed }));
        }
        StreamMark { app, window, agent }
    }
}

impl Drop for StreamMark {
    fn drop(&mut self) {
        self.app.streams.fetch_sub(1, Ordering::Relaxed);
        if self.agent.is_none() {
            self.app.pages.fetch_sub(1, Ordering::Relaxed);
        }
        if self.window {
            let left = self
                .app
                .windows
                .fetch_sub(1, Ordering::Relaxed)
                .saturating_sub(1);
            if left == 0 && self.app.relaunch_window.load(Ordering::Relaxed) {
                relaunch_window_when_gone(self.app.clone());
            }
        }
        // The last window closing is one of the updater's doors, and a page
        // going is worth a look at a pending restart.
        self.app.restart_wake.notify_one();
        if let Some(name) = &self.agent {
            let changed = {
                let mut m = self.app.online.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = m.get_mut(name) {
                    *n -= 1;
                    if *n == 0 {
                        m.remove(name);
                    }
                }
                json!(*m)
            };
            emit(&self.app, "agents", json!({ "online": changed }));
        }
    }
}

/// The window that was asked to quit has closed its stream: once no window
/// has come back for `WINDOW_GONE_FOR` -- a page that reloads itself closes
/// its stream too, and is back in a moment -- the new one is started. A
/// window that did come back is still the old one, and its stream ending
/// later is looked at again.
fn relaunch_window_when_gone(app: Arc<App>) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(async move {
        tokio::time::sleep(WINDOW_GONE_FOR).await;
        if app.windows.load(Ordering::Relaxed) != 0
            || !app.relaunch_window.swap(false, Ordering::Relaxed)
        {
            return;
        }
        if let Some(exe) = app.exe.as_ref().map(|e| e.path.clone()) {
            if let Err(e) = platform::spawn_detached(&exe, &["app"]) {
                eprintln!("snyvi: could not start the window again: {e}");
            }
        }
    });
}

const WINDOW_GONE_FOR: std::time::Duration = std::time::Duration::from_secs(2);

/// Broadcast payloads are "<event name>\n<json>".
///
/// The stream ends when the daemon is asked to stop. A graceful shutdown
/// closes the listener and then waits for every response in flight to
/// finish, and a stream that never ends is a response that never finishes:
/// the old daemon stayed up for as long as the window did, listening on
/// nothing, and the window stayed on it -- it heard no more arrivals, and the
/// daemon that took the port counted no window and handed every agent a link
/// to open in a browser instead. Seen on this machine: ten hours, one tab per
/// document. Ended here, the page reconnects to whatever is on the port now.
async fn events(
    State(app): S,
    Query(q): Query<EventsQ>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = app.events.subscribe();
    let stop = BroadcastStream::new(app.shutdown.subscribe()).map(|_| None);
    let mark = StreamMark::new(app.clone(), q.is_window(), q.agent(), q.window_version());
    // The first thing on every stream is what the updater has to say, so
    // the pill is right at first paint without a field on every boot
    // payload or a poll.
    let first = tokio_stream::once(Some(Ok(Event::default()
        .event("update")
        .data(update_json(&app).to_string()))));
    let stream = first
        .chain(BroadcastStream::new(rx).filter_map(move |m| {
            // Captured so that the mark lives exactly as long as the stream does.
            let _keep = &mark;
            m.ok().map(|msg| {
                let (name, data) = msg.split_once('\n').unwrap_or(("doc", msg.as_str()));
                Some(Ok(Event::default().event(name).data(data)))
            })
        }))
        .merge(stop)
        .take_while(Option::is_some)
        .map(Option::unwrap);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub(crate) fn emit(app: &App, name: &str, data: serde_json::Value) {
    let _ = app.events.send(format!("{name}\n{data}"));
}

#[derive(Deserialize)]
struct PinBody {
    pinned: bool,
}

#[derive(Deserialize)]
struct RenameBody {
    name: String,
}

/// One line for a desk's list. Bounded and trimmed by `desk::add_note`, not
/// here: the cap belongs beside the list it is a cap on.
#[derive(Deserialize)]
struct NoteTextBody {
    text: String,
}

/// What changed about a line. Either half may be absent, so ticking a row off
/// does not have to send its text back with it.
#[derive(Debug, Default, Deserialize)]
struct NoteEditBody {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    done: Option<bool>,
}

/// A label the sidebar has to draw on one line, so it is trimmed of the whitespace
/// an accidental paste brings and cut to a length that cannot push the tree around.
fn clean_name(raw: &str) -> Option<String> {
    let name: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    Some(name.chars().take(120).collect())
}

/// Renaming is a label, like pinning: it moves nothing on disk and reveals nothing,
/// so it needs no token. The identity underneath (a project's root, a workflow's key)
/// is untouched, so what arrives next still lands where it did.
async fn rename_project(State(app): S, Path(id): Path<i64>, Json(b): Json<RenameBody>) -> Response {
    let Some(name) = clean_name(&b.name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a name cannot be empty" })),
        )
            .into_response();
    };
    match app.store.rename_project(id, &name) {
        Ok(true) => {
            emit(&app, "renamed", json!({ "project": id, "name": name }));
            Json(json!({ "ok": true, "name": name })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn rename_workflow(
    State(app): S,
    Path(id): Path<i64>,
    Json(b): Json<RenameBody>,
) -> Response {
    let Some(name) = clean_name(&b.name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a name cannot be empty" })),
        )
            .into_response();
    };
    match app.store.rename_workflow(id, &name) {
        Ok(true) => {
            emit(&app, "renamed", json!({ "workflow": id, "name": name }));
            Json(json!({ "ok": true, "name": name })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The queue: what arrived and has not been opened, oldest first.
async fn queue(State(app): S, Query(q): Query<Limit>) -> Response {
    match app.store.queue(q.limit.unwrap_or(QUEUE_MAX).min(QUEUE_MAX)) {
        Ok(q) => Json(q).into_response(),
        Err(e) => err(e),
    }
}

/// A tab opened a document. Every other tab hears, so the same row leaves
/// the queue everywhere at once; a document already read answers the same
/// and tells nobody, since nothing changed.
async fn mark_read(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.mark_read(&id) {
        Ok(true) => {
            emit(
                &app,
                "read",
                json!({ "ids": [id], "waiting": waiting(&app) }),
            );
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err(e),
    }
}

/// Everything waiting, read without being opened.
async fn clear_queue(State(app): S) -> Response {
    match app.store.mark_all_read() {
        Ok(ids) => {
            if !ids.is_empty() {
                emit(&app, "read", json!({ "ids": ids, "waiting": 0 }));
            }
            Json(json!({ "ok": true, "n": ids.len(), "ids": ids })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct IdsBody {
    ids: Vec<String>,
}

/// Mark all read, taken back: the ids `clear_queue` answered with wait again.
/// Every tab hears it as a restore, which refetches the queue and the tree.
async fn unread(State(app): S, Json(b): Json<IdsBody>) -> Response {
    match app.store.mark_unread(&b.ids) {
        Ok(back) => {
            if !back.is_empty() {
                emit(&app, "restored", json!({ "waiting": waiting(&app) }));
            }
            Json(json!({ "ok": true, "n": back.len() })).into_response()
        }
        Err(e) => err(e),
    }
}

/// Pinning is UI state, so it needs no token; it only affects what `prune` keeps.
async fn pin(State(app): S, Path(id): Path<String>, Json(b): Json<PinBody>) -> Response {
    match app.store.set_pinned(&id, b.pinned) {
        Ok(true) => {
            emit(&app, "pinned", json!({ "id": id, "pinned": b.pinned }));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn receive_doc(State(app): S, headers: HeaderMap, Json(payload): Json<Payload>) -> Response {
    if !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    // Rendering is CPU work; keep it off the async executor.
    let app2 = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let large = payload
            .content
            .as_ref()
            .is_some_and(|c| c.len() > LARGE_RENDER)
            || payload
                .path
                .as_ref()
                .and_then(|p| std::fs::metadata(p).ok())
                .is_some_and(|m| m.len() > LARGE_RENDER as u64);
        let received = receive::receive(&app2.store, &app2.renderer, payload);
        crate::platform::release_thread_memory();
        (received, large)
    })
    .await;
    // After the render, not inside it: a trim over a heap that just held a
    // large render takes long enough to show on the sender's round trip, and
    // the sender is an agent waiting on its hook.
    let result = result.map(|(received, large)| {
        if large {
            tokio::task::spawn_blocking(crate::platform::release_freed_memory);
        }
        received
    });
    match result {
        Ok(Ok(received)) => {
            let doc = received.doc;
            let url = format!("{}/d/{}", config::base_url(), doc.id);
            emit(
                &app,
                "doc",
                json!({ "doc": doc, "url": url, "existing": received.existing, "supersedes": received.supersedes, "waiting": waiting(&app) }),
            );
            if !received.existing {
                notify_desktop(&app, &doc);
            }
            if received.needs_full_highlight {
                spawn_full_highlight(app.clone(), doc.id.clone(), doc.lang.clone());
            }
            // The rail's outline, ready before the reader opens it.
            if doc.kind == crate::render::Kind::Code {
                let (app2, id, lang) = (app.clone(), doc.id.clone(), doc.lang.clone());
                tokio::task::spawn_blocking(move || outline_of(&app2, &id, lang.as_deref()));
            }
            let status = if received.existing {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            };
            (
                status,
                Json(json!({
                    "id": doc.id,
                    "url": url,
                    // The same document as a `snyvi://` link, which opens in
                    // the window rather than a browser -- given only where
                    // there is a window executable for the desktop to hand
                    // it to, since anywhere else the link opens nothing.
                    "app_url": crate::desktop::window_installed().then(|| crate::desktop::app_url(&doc.id)),
                    "doc": doc,
                    "existing": received.existing,
                    // So the sender can say where the document went without a
                    // second round trip: a window, or a link to click.
                    "window": app.has_window(),
                })),
            )
                .into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// An aside from an agent: kept, and shown to every page at once. Never a
/// desktop notification -- an aside that could be missed costs nothing.
async fn receive_aside(
    State(app): S,
    headers: HeaderMap,
    Json(n): Json<crate::aside::NewAside>,
) -> Response {
    if !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    match app.asides.add(n, crate::store::now()) {
        Ok(aside) => {
            emit(&app, "notes", json!({ "notes": app.asides.list() }));
            (
                StatusCode::CREATED,
                Json(json!({ "note": aside, "window": app.has_window() })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn asides(State(app): S) -> Json<serde_json::Value> {
    Json(json!({ "notes": app.asides.list() }))
}

/// A reader looked: the glow goes out in every page.
async fn see_asides(State(app): S) -> Json<serde_json::Value> {
    if app.asides.see() {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct AsideIds {
    ids: Vec<u64>,
}

/// A reader closed an aside, or all of them: gone from the card in every
/// page. Only flagged, so `restore` is the Undo.
async fn dismiss_asides(State(app): S, Json(b): Json<AsideIds>) -> Json<serde_json::Value> {
    if app.asides.dismiss(&b.ids) {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true }))
}

async fn restore_asides(State(app): S, Json(b): Json<AsideIds>) -> Json<serde_json::Value> {
    if app.asides.restore(&b.ids) {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true }))
}

/// Large code files are stored partly plain for an instant first view; finish the
/// highlight off the request path and tell open tabs to refetch.
/// Past this many bytes a render is large enough that the memory it frees is
/// worth handing back at once. See `platform::release_freed_memory`.
const LARGE_RENDER: usize = 512 * 1024;

fn spawn_full_highlight(app: Arc<App>, id: String, lang: Option<String>) {
    tokio::task::spawn_blocking(move || {
        let stored = {
            let Ok(src) = app.store.source(&id) else {
                return;
            };
            let html = app.renderer.render_code_uncapped(lang.as_deref(), &src);
            app.store.replace_html(&id, &html).is_ok()
        };
        // A full highlight only runs on a file past the highlight cap, so it
        // is always a large render; the source and HTML are dropped above.
        // Nobody waits on this thread, so the trim can run here.
        crate::platform::release_freed_memory();
        if stored {
            emit(&app, "rendered", json!({ "id": id }));
        }
    });
}

// ---------- browse ----------

#[derive(Deserialize)]
struct OpenBody {
    path: String,
}

#[derive(Deserialize)]
struct PathQ {
    path: Option<String>,
}

#[derive(Deserialize)]
struct FindQ {
    q: Option<String>,
    limit: Option<usize>,
}

/// Opening a folder exposes its files, so this one needs the token. Reading inside a
/// root the user already opened does not.
#[derive(Deserialize)]
struct TerminalBody {
    doc: Option<String>,
    root: Option<String>,
    path: Option<String>,
    /// A desk's folder. Behind the desk's gate: see `refuse_folder`.
    desk: Option<i64>,
    /// A project's root, as the sidebar's project rows know it.
    project: Option<i64>,
}

/// The directory a terminal would open in for a document, if one exists.
///
/// In order: the folder the file was sent from, then the project's root. The
/// second is the case that matters. `source_path` is an `Option` and a document
/// sent as content rather than as a path has none, so without the fallback the
/// button would be missing from exactly the sends that come straight out of an
/// agent.
fn doc_folder(app: &App, doc: &Doc) -> Option<std::path::PathBuf> {
    doc.source_path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf()))
        .into_iter()
        .chain(app.store.project_root(doc.project_id).map(Into::into))
        .find(|d: &std::path::PathBuf| d.is_dir())
}

/// Mint a capability for a window that is opening.
///
/// The token is required, and this is the only endpoint whose answer is itself
/// a secret. The caller is `snyvi app`, in the moment between deciding to open a
/// window and launching one: see `crate::capability` for why the answer is not
/// the token itself and never reaches disk.
async fn mint_capability(State(app): S, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "no token" }))).into_response();
    }
    match app.capabilities.mint() {
        Ok(capability) => Json(json!({ "capability": capability })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// How long a socket has to prove itself. A page that holds the capability
/// sends it in its first frame, which on a loopback connection is one round
/// trip; anything still silent after this is not a page of ours, and the
/// deadline is what keeps a connection that will never speak from being held
/// open by whatever opened it.
const CAPABILITY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

/// The first frame on a desk socket, and the only one read before the
/// capability is known to be good.
#[derive(Deserialize)]
struct Hello {
    capability: String,
}

/// What a page says on its desk socket once it is allowed. `docs/DESK.md` has
/// the protocol; the frames going the other way are `crate::screen`'s.
#[derive(Deserialize)]
#[serde(tag = "t")]
enum Said {
    /// The panes this page is showing, which replaces whatever it showed
    /// before. Each is sent a status, its old text if it has any, and a
    /// snapshot, and then its frames.
    #[serde(rename = "watch")]
    Watch { panes: Vec<String> },
    /// Keys or a paste, for one pane this page is watching.
    #[serde(rename = "in")]
    In { p: String, d: String },
    /// The size a pane is drawn at on this page.
    #[serde(rename = "size")]
    Size { p: String, c: u16, r: u16 },
    /// Of the panes this page watches, the ones out of sight: a document read
    /// over the desk, a hidden window, no room in the grid. They are framed
    /// once a second rather than sixty times, and the page draws none of it
    /// until they are back. Replaces the last one.
    #[serde(rename = "pace")]
    Pace { slow: Vec<String> },
    /// Older scrollback, above line `before`, for a page scrolled up to the
    /// top of what it holds -- or with `old`, the last run's text above the
    /// `before` lines of it the page holds. At most `n` lines.
    #[serde(rename = "more")]
    More {
        p: String,
        before: usize,
        n: usize,
        #[serde(default)]
        old: Option<u64>,
    },
}

/// One pane's frames, from its broadcast to this socket. A page that falls so
/// far behind that the broadcast drops frames for it is not sent the rest:
/// it is sent a fresh snapshot, which is always right, instead of a diff
/// against a screen it no longer holds.
async fn forward(
    live: Arc<crate::pane::Live>,
    first: Vec<String>,
    mut rx: broadcast::Receiver<Arc<str>>,
    out: tokio::sync::mpsc::Sender<Arc<str>>,
) {
    for f in first {
        if out.send(f.into()).await.is_err() {
            return;
        }
    }
    loop {
        match rx.recv().await {
            Ok(m) => {
                if out.send(m).await.is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let (first, fresh) = live.attach();
                rx = fresh;
                for f in first {
                    if out.send(f.into()).await.is_err() {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// The socket desks will speak over, and today the capability's proof and
/// nothing else.
///
/// Three refusals before a single byte of desk traffic could ever flow: the
/// capability is not accepted from the query string, the handshake must come
/// from snyvi's own page, and the socket is inert until a valid capability
/// arrives. A browser tab gets past none of them, which is the premise the
/// whole feature rests on.
async fn desk_socket(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Refused rather than quietly upgraded, so that an attempt to put the
    // capability where it would be logged fails at the place it is made. A
    // query string lands in the request path; the fragment it rides on instead
    // is never sent to a server at all.
    if q.contains_key(crate::desktop::CAPABILITY_KEY) || q.contains_key("capability") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "the capability is not a query parameter" })),
        )
            .into_response();
    }
    // The same check the terminal button is behind, for the same reason: a page
    // on another origin is refused, and a local process with no browser sends
    // neither header and is refused too.
    if !from_this_page(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page" })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| desk_session(app, socket))
}

/// What a first frame means: allowed, or not.
///
/// Split out from the socket so the rule can be read and tested on its own,
/// which is worth doing for the one function in this server that decides
/// whether a thing may run a shell. Anything that is not a well-formed frame
/// carrying a live capability under the one key that means it is a refusal.
fn hello_allows(caps: &crate::capability::Capabilities, frame: Option<&str>) -> bool {
    frame
        .and_then(|f| serde_json::from_str::<Hello>(f).ok())
        .is_some_and(|h| caps.verify(&h.capability))
}

/// A desk socket from the upgrade to the close.
///
/// It proves itself and then does nothing, which is the whole of this phase:
/// the panes that will speak here are two phases out. What is being built now
/// is the one thing they cannot be built without -- a socket that a window can
/// open and a tab cannot.
async fn desk_session(app: Arc<App>, mut socket: WebSocket) {
    let first = tokio::time::timeout(CAPABILITY_DEADLINE, socket.recv()).await;
    let frame = match &first {
        Ok(Some(Ok(Message::Text(t)))) => Some(t.as_str()),
        // Silence past the deadline, a close, a socket error, or a binary
        // frame: none of them is a capability, and all of them end the same
        // way. Only the text frame is read.
        _ => None,
    };
    if !hello_allows(&app.capabilities, frame) {
        let _ = socket
            .send(Message::Text(
                json!({ "error": "no capability" }).to_string().into(),
            ))
            .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let _ = socket
        .send(Message::Text(json!({ "ok": true }).to_string().into()))
        .await;
    // A window is showing a desk: someone can see the panes a restart
    // marked, so their clock starts now. See `pane::RESUME_FOR`.
    app.panes.arm_marks();
    // Bounded, so a page that cannot keep up makes its forwarders wait, and a
    // forwarder that waits long enough is resynced rather than buffered.
    let (out, mut frames) = tokio::sync::mpsc::channel::<Arc<str>>(64);
    let mut going = app.shutdown.subscribe();
    let mut watching: std::collections::HashMap<
        String,
        (Arc<crate::pane::Live>, tokio::task::JoinHandle<()>),
    > = Default::default();
    // The panes this page has out of sight, each one `pace(true)` owed a
    // `pace(false)`: when the page says so, stops watching it, or goes --
    // however it goes, which is why it is paid on drop.
    let mut slowed = Slowed::default();
    loop {
        tokio::select! {
            // The daemon is going, and the page's reconnect is what tells the
            // reader: the capability it holds dies with this process.
            _ = going.recv() => break,
            f = frames.recv() => {
                let Some(f) = f else { break };
                if socket.send(Message::Text(f.to_string().into())).await.is_err() {
                    break;
                }
            }
            msg = socket.recv() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(said) = serde_json::from_str::<Said>(text.as_str()) else { continue };
                match said {
                    Said::Watch { panes } => {
                        let wanted: std::collections::HashSet<String> = panes
                            .into_iter()
                            .filter(|id| crate::pane::valid_id(id))
                            .filter(|id| matches!(app.store.pane(id), Ok(Some(_))))
                            .take(crate::desk::PER_DESK as usize)
                            .collect();
                        watching.retain(|id, (live, task)| {
                            let keep = wanted.contains(id);
                            if !keep {
                                task.abort();
                                slowed.set(id, live, false);
                            }
                            keep
                        });
                        for id in wanted {
                            if watching.contains_key(&id) {
                                continue;
                            }
                            let live = app.panes.get(&id);
                            let (first, rx) = live.attach();
                            let task = tokio::spawn(forward(live.clone(), first, rx, out.clone()));
                            watching.insert(id, (live, task));
                        }
                    }
                    // Only for a pane this page is watching: a page cannot type
                    // into a pane it is not showing.
                    Said::In { p, d } => {
                        if let Some((live, _)) = watching.get(&p) {
                            live.input(d.as_bytes(), &app.panes);
                        }
                    }
                    Said::Size { p, c, r } => {
                        if let Some((live, _)) = watching.get(&p) {
                            live.resize(c, r);
                        }
                    }
                    Said::Pace { slow } => {
                        for (id, (live, _)) in &watching {
                            slowed.set(id, live, slow.contains(id));
                        }
                    }
                    // Straight back on this socket, not the pane's broadcast:
                    // only this page asked. It lands above what the page holds,
                    // so its order among the frames does not matter.
                    Said::More { p, before, n, old } => {
                        let Some((live, _)) = watching.get(&p) else { continue };
                        let Some(f) = live.more(old, before, n.min(crate::screen::KEEP_LINES)) else { continue };
                        if socket.send(Message::Text(f.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    }
    for (_, (_, task)) in watching {
        task.abort();
    }
}

/// The panes one desk socket has told the daemon are out of sight, each owed
/// a `pace(false)`. Paid as each comes back or stops being watched, and the
/// rest when the socket's session ends -- by drop, so a session that ends
/// some other way than its loop running out cannot leave a pane framed once
/// a second for a page that has it in view.
#[derive(Default)]
struct Slowed(std::collections::HashMap<String, Arc<crate::pane::Live>>);

impl Slowed {
    fn set(&mut self, id: &str, live: &Arc<crate::pane::Live>, slow: bool) {
        if slow == self.0.contains_key(id) {
            return;
        }
        live.pace(slow);
        if slow {
            self.0.insert(id.to_string(), live.clone());
        } else {
            self.0.remove(id);
        }
    }
}

impl Drop for Slowed {
    fn drop(&mut self) {
        for live in self.0.values() {
            live.pace(false);
        }
    }
}

/// Did this request come from snyvi's own page?
///
/// The first check of its kind in this server, and the reason section 7 of
/// `docs/TERMINAL.md` counts it as new work: until now every endpoint either
/// carried the token or answered with something a foreign page cannot read back
/// anyway. This one is a side effect that arrives from a click.
///
/// It cannot be the token, because the page has none. The token exists so that
/// a random local process cannot inject a document, and putting it into HTML
/// that any local process can `GET` would be the end of that. So the token is
/// accepted -- it is how the CLI and the tests reach this -- and a same-origin
/// POST is accepted beside it.
///
/// `Origin` rather than `Sec-Fetch-Site`: a browser sets `Origin` on every POST,
/// same-origin included, and has done for far longer, so a window whose engine
/// predates fetch metadata still gets the button. Where the newer header is
/// present it is read too, and anything but `same-origin` is refused outright.
/// A page on another origin is refused by both; curl sends neither and needs the
/// token.
fn from_this_page(headers: &HeaderMap) -> bool {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site != "same-origin" {
            return false;
        }
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = config::port();
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| origin == format!("http://{h}:{port}"))
}

/// A read from this page, which carries no `Origin`: a browser sets it on
/// every POST and every cross-origin request, but not on a same-origin GET, so
/// `from_this_page` alone refuses the desk list the window asks for.
///
/// `Host` stands in for it. A page on another origin cannot get here without an
/// `Origin` -- the capability header makes its request a CORS one -- and a page
/// that rebinds its own name to 127.0.0.1 sends that name as `Host`. Where
/// fetch metadata is sent, it has to say `same-origin` as well.
fn same_origin_read(headers: &HeaderMap) -> bool {
    if headers.contains_key(header::ORIGIN) {
        return false;
    }
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site != "same-origin" {
            return false;
        }
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = config::port();
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| host == format!("{h}:{port}"))
}

/// Where the capability rides on an HTTP request.
///
/// A header, for the reason the socket refuses the query string: a query
/// parameter lands in the request path and so in anything that logs one. A
/// header is the one place a page can put a secret on a `fetch` it composes
/// itself, and `EventSource`'s inability to set one is what kept the window
/// count on a query string -- a count, which grants nothing.
const CAPABILITY_HEADER: &str = "x-snyvi-capability";

/// May this request touch a desk? A sentence if not, and nothing if so.
///
/// Three refusals, the same three the socket makes, in the same order: not the
/// query string, not another page, and not without a live capability. A browser
/// tab gets past none of them, which is the premise the whole feature rests on
/// -- so this takes the capabilities and the request, and no `App`, leaving
/// nothing a forgeable signal could reach it through.
fn desk_refusal(
    caps: &crate::capability::Capabilities,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
) -> Option<&'static str> {
    if q.contains_key(crate::desktop::CAPABILITY_KEY) || q.contains_key("capability") {
        return Some("the capability is not a query parameter");
    }
    if !from_this_page(headers) && !same_origin_read(headers) {
        return Some("not from this page");
    }
    let given = headers
        .get(CAPABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    (!caps.verify(given)).then_some("no capability")
}

/// The gate as a handler uses it: the refusal, already a response.
fn refuse_desk(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
) -> Option<Response> {
    desk_refusal(&app.capabilities, headers, q)
        .map(|why| (StatusCode::FORBIDDEN, Json(json!({ "error": why }))).into_response())
}

#[derive(Deserialize)]
struct NewDeskBody {
    /// A browse root's id, and the path of a folder inside it -- the two things
    /// every directory row in the sidebar already carries. None is a desk on
    /// no folder in particular, which starts in the home directory.
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    path: String,
    /// Or a project, by id: the folder its agents wrote from, which the store
    /// holds. The page names the project, never the path.
    #[serde(default)]
    project: Option<i64>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct LayoutBody {
    col: f64,
    row: f64,
    /// The slot in full view, 0 for the grid; left out keeps what is there.
    #[serde(default)]
    full: Option<i64>,
}

#[derive(Deserialize)]
struct MoveBody {
    from: i64,
    to: i64,
}

#[derive(Deserialize)]
struct NewPaneBody {
    /// What to re-run when the reader asks for it. Nothing here means a shell,
    /// and nothing here starts anything: Phase 3 spawns, this phase records.
    #[serde(default)]
    cmd: Option<String>,
}

/// Every desk, with its panes, and how many panes are open across them.
async fn desks(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match (app.store.desks(), app.store.panes_open()) {
        (Ok(desks), Ok(panes)) => Json(json!({
            "desks": with_status(&app, &desks),
            // So a pane's header can say `~/snyvi` rather than the whole path.
            "home": dirs::home_dir(),
            "panes": panes,
            "per_desk": crate::desk::PER_DESK,
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => err(e),
    }
}

/// The desks, each pane carrying what its runtime says about it: running or
/// not, blocked or not, and the rest of what the rail draws.
fn with_status(app: &App, desks: &[crate::desk::Desk]) -> serde_json::Value {
    let mut v = serde_json::to_value(desks).unwrap_or_default();
    for d in v.as_array_mut().into_iter().flatten() {
        for p in d["panes"].as_array_mut().into_iter().flatten() {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            p["status"] = serde_json::to_value(app.panes.status(&id)).unwrap_or_default();
        }
    }
    v
}

/// A new desk, on a folder, on a project's folder, or on none.
///
/// The folder arrives as a root id and a relative path rather than as an
/// absolute one, so it goes through `resolve` -- the same guard the terminal
/// button and every byte `browse_file` reads go through, which is what keeps a
/// path from the page inside the root it names. A project arrives as its id,
/// and its folder is the one the store recorded, as the terminal button's is.
async fn create_desk(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NewDeskBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // No folder is the home directory, which the daemon names and the page
    // does not: nothing from the page reaches the filesystem on this path.
    let (dir, fallback) = match &b.root {
        Some(root) => match app.browse.resolve(root, &b.path) {
            Ok(dir) => (dir, None),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "no such folder" })),
                )
                    .into_response()
            }
        },
        None if b.project.is_some() => match b.project.and_then(|id| app.store.project_root(id)) {
            Some(root) => (std::path::PathBuf::from(root), None),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "no such project" })),
                )
                    .into_response()
            }
        },
        None => match dirs::home_dir() {
            Some(home) => (home, Some("desk")),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "there is no home directory to start in" })),
                )
                    .into_response()
            }
        },
    };
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a desk is rooted at a folder" })),
        )
            .into_response();
    }
    // A desk on the home directory would otherwise be named after the user.
    let name = b
        .name
        .as_deref()
        .and_then(clean_name)
        .or(fallback.map(String::from));
    match app
        .store
        .create_desk(&dir.to_string_lossy(), name.as_deref())
    {
        Ok(desk) => {
            desks_moved(&app);
            (StatusCode::CREATED, Json(json!({ "desk": desk }))).into_response()
        }
        Err(e) => err(e),
    }
}

/// The documents the panes on a desk have sent, for the rail's Documents
/// list. Forty is more than a rail shows without scrolling and fewer than a
/// long day of a file being watched produces; the library has the rest.
async fn desk_docs(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let removed = app.store.desk_docs(id, 40, true).unwrap_or_default();
    match app.store.desk_docs(id, 40, false) {
        Ok(docs) => Json(json!({ "docs": docs, "removed": removed })).into_response(),
        Err(e) => err(e),
    }
}

/// The reader takes a document off this desk's list, from its ✕. The
/// document stays in the library, the Inbox and search: this is the desk's
/// list, and nothing is deleted. The other windows hear it (`deskdocs`).
async fn remove_desk_doc(
    State(app): S,
    headers: HeaderMap,
    Path((id, doc)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    desk_doc_off(&app, id, &doc, true)
}

/// Undo, or Show's way back: the document is on the desk's list again.
async fn restore_desk_doc(
    State(app): S,
    headers: HeaderMap,
    Path((id, doc)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    desk_doc_off(&app, id, &doc, false)
}

fn desk_doc_off(app: &App, id: i64, doc: &str, off: bool) -> Response {
    match app.store.set_desk_doc_off(id, doc, off) {
        Ok(true) => {
            emit(app, "deskdocs", json!({ "desk": id }));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's own list, which is the reader's and not an agent's: `/api/notes`
/// is an agent's asides, and the two never meet. Behind the same gate as the rest
/// of a desk, so what someone wrote on theirs is as unreachable from a tab as
/// their panes are.
///
/// Every write below tells the other windows (`desknotes`), as an agent's tick
/// does: Home counts every desk's list, and a second window on the same desk
/// was showing a list that another had changed. A write is a line committed --
/// Enter, a tick, a ✕ -- never a keystroke, so it is not an event per key.
async fn desk_notes(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.desk_notes(id) {
        Ok(mut notes) => {
            settle_stages(&app, &mut notes);
            Json(json!({ "notes": notes })).into_response()
        }
        Err(e) => err(e),
    }
}

/// A line said to be `working` is only still being worked on while the
/// conversation that said so is going, in the pane it was said from: a
/// session that ended, a panel closed, a daemon restarted, and the line is
/// back at the stage before (`desk::settle_stage`). While it holds, the line
/// carries the panel's name as the reader sees it. Read, never written: the
/// stage in the store is what the agent said, and this is what is true now.
fn settle_stages(app: &App, notes: &mut [crate::desk::DeskNote]) {
    for n in notes.iter_mut().filter(|n| n.stage == "working") {
        let s = app.panes.status(&n.stage_pane);
        let pane = if s.running && !s.agent.is_empty() {
            app.store.pane(&n.stage_pane).ok().flatten()
        } else {
            None
        };
        let pane = pane.filter(|p| p.pane.agent_session == n.stage_session);
        if let Some(p) = &pane {
            n.stage_panel = if p.pane.name.is_empty() {
                format!("panel {}", p.pane.slot)
            } else {
                p.pane.name.clone()
            };
        }
        crate::desk::settle_stage(n, pane.is_some());
    }
}

async fn add_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteTextBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.add_desk_note(id, &b.text) {
        // One refusal for three states -- no such desk, an empty line, a full
        // list -- because the page has just been told the count and can say
        // which it is; the daemon repeating it would be two sources for one
        // sentence.
        Ok(Some(note)) => {
            notes_moved(&app, id);
            (StatusCode::CREATED, Json(json!({ "note": note }))).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a desk keeps {} notes", crate::desk::NOTES_PER_DESK) })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// Rewrite a line, tick it off, or both. An emptied line is taken off the list
/// rather than kept as a blank row, which is what `desk::set_note` does with it.
async fn set_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteEditBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_desk_note(id, note, b.text.as_deref(), b.done) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Take a line off the list. The row is kept and `restore` puts it back: this
/// path deletes nothing, which is why it does not ask twice the way closing a
/// desk does.
async fn remove_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.remove_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn restore_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.restore_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Keep an agent's suggestion: it is an ordinary line of the reader's from
/// here. Its ✕ is `remove_desk_note`, as any row's.
async fn keep_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.keep_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's list changed: every window that shows it -- its rail, Home --
/// asks for it again. The desk's id and nothing of what is on it, for the
/// reason `desks_moved` gives: the stream reaches tabs too.
/// How big a picture on a line may be: a screenshot of a whole screen, with room.
const NOTE_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A picture pasted or dropped on a line: kept in `note_images/`, named by
/// its content so the same picture twice is one file, and put at the end of
/// the line's pictures. The answer is the line's pictures now.
async fn add_note_image(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let ext = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
    {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({ "error": "an image, as png, jpeg, gif or webp" })),
            )
                .into_response()
        }
    };
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "an empty image" })),
        )
            .into_response();
    }
    let dir = app.paths.data_dir.join(crate::desk::NOTE_IMAGES);
    let name = format!("{}.{ext}", &blake3::hash(&body).to_hex()[..16]);
    let file = dir.join(&name);
    if !file.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
            return err(anyhow::anyhow!("keeping the picture: {e}"));
        }
    }
    match app.store.add_note_image(id, note, &name) {
        Ok(Some(images)) => {
            notes_moved(&app, id);
            Json(json!({ "name": name, "images": images })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a line holds {} pictures", crate::desk::IMAGES_PER_NOTE) })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct NoteImagesBody {
    images: Vec<String>,
}

/// A line's pictures, set whole: one taken off, or Undo putting the list back.
/// The files stay; only the line's list changes.
async fn set_note_images(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteImagesBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_note_images(id, note, &b.images) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A picture on a line, for the page to draw. Behind the gate like the rest
/// of a desk: the page fetches it with the capability and shows the bytes.
async fn note_image(
    State(app): S,
    headers: HeaderMap,
    Path((_id, name)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !crate::desk::image_name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let kind = match name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    };
    match std::fs::read(
        app.paths
            .data_dir
            .join(crate::desk::NOTE_IMAGES)
            .join(&name),
    ) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, kind),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn notes_moved(app: &App, desk: i64) {
    emit(app, "desknotes", json!({ "desk": desk }));
}

/// The reader writes, rewrites or clears where the work on a desk was left,
/// in the desk's head. The answer carries the one it replaced, `was`, which
/// the page's Undo sends back as it came -- its time and its author with it.
async fn desk_left_off(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<crate::desk::LeftOff>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_left_off(id, &b) {
        Ok(Some(was)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "was": was })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's keys by name: its own and the every-desk ones, with when a panel
/// last started with each. No value is ever in this answer.
async fn desk_keys(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.desk_keys(id) {
        Ok(keys) => Json(json!({ "keys": keys })).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct KeyBody {
    name: String,
    value: String,
    #[serde(default)]
    provider: String,
    /// For every desk rather than this one.
    #[serde(default)]
    every: bool,
}

#[derive(Deserialize, Default)]
struct KeyWhere {
    #[serde(default)]
    every: bool,
}

/// Keep a key for a desk, or for every desk: the value to the keychain (or
/// the 0600 file when no keychain answers), the name to the store. The value
/// is in no log, no event and no response; `kept` says where it went.
async fn add_desk_key(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<KeyBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let name = b.name.trim().to_string();
    if let Err(why) = crate::secrets::valid_name(&name) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": why })),
        )
            .into_response();
    }
    let value = b.value.trim().to_string();
    if value.is_empty() || value.len() > 4096 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "a key is one line, up to 4 KB" })),
        )
            .into_response();
    }
    if !matches!(app.store.desk(id), Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let desk_id = if b.every { crate::desk::EVERY_DESK } else { id };
    let secrets = app.secrets.clone();
    let (n, v) = (name.clone(), value);
    let kept = match tokio::task::spawn_blocking(move || secrets.keep(desk_id, &n, &v)).await {
        Ok(Ok(kept)) => kept,
        Ok(Err(e)) => return err(e),
        Err(e) => return err(anyhow::anyhow!("keeping the key: {e}")),
    };
    if let Err(e) = app.store.add_desk_key(desk_id, &name, b.provider.trim()) {
        return err(e);
    }
    desks_moved(&app);
    Json(json!({ "ok": true, "kept": kept })).into_response()
}

/// Take a key off a desk (or off every desk): the name from the store, the
/// value from wherever it was kept. The window held the row for its Undo
/// before asking, so this is the end of it.
async fn remove_desk_key(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<KeyWhere>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let every = b.every;
    let desk_id = if every { crate::desk::EVERY_DESK } else { id };
    match app.store.remove_desk_key(desk_id, &name) {
        Ok(true) => {
            let secrets = app.secrets.clone();
            let n = name.clone();
            let _ = tokio::task::spawn_blocking(move || secrets.forget(desk_id, &n)).await;
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Whether a Claude starting in a panel is handed the desk brief: on unless
/// the reader turned it off in About. A file, not a row: the hook's route
/// reads it on every session start, and it is the daemon's own setting.
fn brief_on(app: &App) -> bool {
    !app.paths.config_dir.join("brief-off").exists()
}

async fn brief_setting(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(json!({ "on": brief_on(&app) })).into_response()
}

#[derive(Deserialize)]
struct BriefBody {
    on: bool,
}

async fn set_brief_setting(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<BriefBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let flag = app.paths.config_dir.join("brief-off");
    let done = if b.on {
        match std::fs::remove_file(&flag) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        std::fs::create_dir_all(&app.paths.config_dir).and_then(|_| std::fs::write(&flag, b""))
    };
    match done {
        Ok(()) => Json(json!({ "on": brief_on(&app) })).into_response(),
        Err(e) => err(e.into()),
    }
}

async fn rename_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some(name) = clean_name(&b.name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a name cannot be empty" })),
        )
            .into_response();
    };
    match app.store.rename_desk(id, &name) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "name": name })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The two divider fractions, which are the whole of a desk's geometry.
async fn desk_layout(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<LayoutBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_desk_layout(id, b.col, b.row, b.full) {
        // Silent: a drag ends hundreds of times an hour and no other window
        // needs to be told where this one's divider came to rest.
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A pane to another position on its desk, trading places with the pane
/// there. Every window redraws: the numbers moved, not only this one's grid.
async fn move_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<MoveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.move_pane(id, b.from, b.to) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn delete_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // Closed, not deleted (`desk::close`): its panes stop and keep their
    // text, as a closed panel's does, and its notes stay on it, until prune.
    match app.store.close_desk(id) {
        Ok(Some(panes)) => {
            for p in &panes {
                app.panes.forget(p);
            }
            desks_moved(&app);
            Json(json!({ "ok": true, "restore": format!("/api/desks/{id}/reopen") }))
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A closed desk back, with its notes and the panels that closed with it,
/// stopped: the Undo on a close, and its row in the Removed list.
async fn reopen_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.reopen_desk(id) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A pane on a desk, in the lowest free slot, rooted where the desk is.
///
/// The cwd is the desk's own and is not taken from the caller: a desk is
/// already a folder the reader chose, and a second place for a path to come
/// from would be a second place to guard.
async fn open_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NewPaneBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cmd = b.cmd.unwrap_or_default();
    match app.store.open_pane(desk.id, &desk.root, cmd.trim()) {
        Ok(crate::desk::Opened::Pane(pane)) => {
            desks_moved(&app);
            (StatusCode::CREATED, Json(json!({ "pane": pane }))).into_response()
        }
        // Full: another desk takes the next pane. There is no cap across desks.
        Ok(crate::desk::Opened::DeskFull) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk holds {}", crate::desk::PER_DESK), "full": "desk" })),
        )
            .into_response(),
        Ok(crate::desk::Opened::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

async fn close_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.close_pane(&id) {
        // Stopped and kept: the row waits in `panes_closed` and the text on
        // disk, for Undo, until `prune`.
        Ok(true) => {
            app.panes.forget(&id);
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A closed pane back on its desk, stopped, in the lowest free slot: the
/// Undo on a close. 409 when the desk filled up in the meantime.
async fn restore_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.restore_pane(&id) {
        Ok(crate::desk::Restored::Pane(pane)) => {
            desks_moved(&app);
            Json(json!({ "pane": pane })).into_response()
        }
        Ok(crate::desk::Restored::DeskFull) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk holds {}", crate::desk::PER_DESK), "full": "desk" })),
        )
            .into_response(),
        Ok(crate::desk::Restored::Gone) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Call a pane something; empty gives it back to its program's title.
async fn rename_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.rename_pane(&id, &b.name) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Tell the windows that the list changed.
///
/// A nudge and nothing in it. The event stream goes to every page, tabs
/// included, and a pane's command and its folder are the desk's business, not
/// a tab's: so a window hearing this asks `/api/desks` again, with its
/// capability, and a tab hearing it can ask nothing.
fn desks_moved(app: &App) {
    emit(app, "desks", json!({}));
}

#[derive(Deserialize)]
struct StartBody {
    /// What to run, as typed into the pane's `Start`. Absent means what the
    /// pane ran last; empty means the shell.
    #[serde(default)]
    cmd: Option<String>,
    /// Resume the conversation the pane last had, instead of `cmd`. The
    /// command is built here, from the id the pane kept, never from the page.
    #[serde(default)]
    resume: bool,
    /// The resume is the page's own, after a restart, not a click: honoured
    /// only while this daemon still holds the pane's mark. A mark that lapsed
    /// while its panel sat unshown starts `cmd`, with the conversation offered.
    #[serde(default)]
    marked: bool,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
    /// The accent the window wears, `#rrggbb`, as its CSS resolved it. The
    /// pane's prompt is drawn in it; absent means snyvi's own.
    #[serde(default)]
    accent: String,
}
fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

/// Start a pane's process. The only way one starts: this request, from a
/// click in a window holding the capability. Nothing on a timer, nothing at
/// daemon start, and nothing derived from a document -- premise 3.
async fn start_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<StartBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(placed)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let lapsed = b.resume && b.marked && !app.panes.marked(&id);
    let offer = lapsed && app.panes.offered(&id);
    // A resume is a one-off: what `Start` re-runs stays what the reader typed.
    let cmd = if b.resume && !lapsed {
        let session = &placed.pane.agent_session;
        if !crate::desk::valid_session(session) {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "this panel has no conversation to resume" })),
            )
                .into_response();
        }
        format!("claude --resume {session}")
    } else {
        let cmd = b.cmd.unwrap_or_else(|| placed.pane.cmd.clone());
        if cmd.trim() != placed.pane.cmd {
            let _ = app.store.set_pane_cmd(&id, &cmd);
        }
        cmd
    };
    let live = app.panes.get(&id);
    // Where the shell last was; the desk's own folder if that one is gone.
    let cwd = if std::path::Path::new(&placed.pane.cwd).is_dir() {
        placed.pane.cwd.as_str()
    } else {
        placed.root.as_str()
    };
    // The desk's keys: names from the store, values from the keychain on a
    // blocking thread, into the child's environment and nowhere else. A key
    // whose value is nowhere is not set at all.
    let keys = app.store.desk_keys(placed.desk_id).unwrap_or_default();
    let env: Vec<(String, String)> = if keys.is_empty() {
        Vec::new()
    } else {
        let secrets = app.secrets.clone();
        let wanted = keys.clone();
        tokio::task::spawn_blocking(move || secrets.values(&wanted))
            .await
            .unwrap_or_default()
    };
    if !env.is_empty() {
        let found: Vec<_> = keys
            .iter()
            .filter(|k| env.iter().any(|(n, _)| n == &k.name))
            .cloned()
            .collect();
        let _ = app.store.touch_desk_keys(&found);
    }
    let start = crate::pane::Start {
        cwd,
        root: &placed.root,
        cmd: &cmd,
        desk: &placed.desk_name,
        slot: placed.pane.slot,
        cols: b.cols,
        rows: b.rows,
        accent: &b.accent,
        offer,
        env: &env,
    };
    match live.start(start, &app.panes) {
        Ok(status) => Json(json!({ "status": status })).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Hang up on a pane's process. The pane stays, stopped, with `Start` offered.
async fn stop_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(_)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    app.panes.get(&id).stop();
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct AgentBody {
    /// Absent when the event says nothing about what the agent is doing (a
    /// `SessionStart`, which only names the conversation).
    #[serde(default)]
    state: Option<String>,
    /// The Claude Code session id, a UUID, when the event carried one.
    #[serde(default)]
    session: Option<String>,
    /// From the status line (`snyvi statusline`): the model's name, and how
    /// full its context window is.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    ctx: Option<CtxBody>,
    /// The account's rate-limit windows, from the status line
    /// (`crate::statusline::Limit`): Home's quota.
    #[serde(default)]
    limits: Option<LimitsBody>,
}

#[derive(Deserialize, Default)]
struct LimitsBody {
    #[serde(default)]
    five_hour: Option<crate::statusline::Limit>,
    #[serde(default)]
    seven_day: Option<crate::statusline::Limit>,
}

#[derive(Deserialize, Default)]
struct CtxBody {
    #[serde(default)]
    pct: Option<f64>,
    #[serde(default)]
    size: Option<u64>,
    /// `total_input_tokens`. A line from before `used` sent only this; it
    /// stands in, as it does in the line itself when there is no
    /// `current_usage`.
    #[serde(default)]
    input: Option<u64>,
    /// The tokens in the window now (`crate::statusline::Seen::used`).
    #[serde(default)]
    used: Option<u64>,
}

/// What the agent in a pane is doing, told by its hook (`snyvi hook`, run by
/// Claude Code inside the pane, which knows the pane by `SNYVI_SESSION`).
///
/// This is the one pane route behind the token rather than the window's
/// capability: the hook is a process like `snyvi send`, and it holds the token
/// and never the capability. What it can do with it is small on purpose. It
/// sets one word on a pane that is already running, and that word is shown
/// and nothing more; and it names the conversation in that pane, a UUID the
/// pane keeps so a reader's click can resume it later. It never starts, stops,
/// or types into anything, touches the store only through
/// `set_pane_session`, and an id that is not a running pane is a 404.
async fn pane_agent(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AgentBody>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let state_ok = |s: &str| s.is_empty() || crate::pane::AGENT_STATES.contains(&s);
    if !crate::pane::valid_id(&id)
        || !b.state.as_deref().is_none_or(state_ok)
        || !b.session.as_deref().is_none_or(crate::desk::valid_session)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut live = match &b.state {
        Some(state) => app.panes.set_agent(&id, state),
        None => app.panes.is_running(&id),
    };
    if live && (b.model.is_some() || b.ctx.is_some()) {
        let c = b.ctx.unwrap_or_default();
        let pct = c
            .pct
            .filter(|p| p.is_finite())
            .map(|p| p.clamp(0.0, 100.0).round() as u8);
        let changed = app.panes.set_context(
            &id,
            &crate::statusline::clean(b.model.as_deref().unwrap_or("")),
            pct,
            c.size.filter(|s| *s > 0),
            c.used.or(c.input),
        );
        live = changed.is_some();
        // A light event of its own, only when the figure a reader sees moved:
        // Home shows the fullest window, and the `panes` event stays about
        // running and waiting, so a quiet page stays quiet.
        if changed == Some(true) {
            emit(&app, "ctx", json!({ "pane": id }));
        }
    }
    if !live {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(l) = &b.limits {
        if l.five_hour.is_some() || l.seven_day.is_some() {
            *app.quota.lock().unwrap_or_else(|e| e.into_inner()) = Some(json!({
                "five_hour": l.five_hour,
                "seven_day": l.seven_day,
                "at": crate::store::now(),
            }));
        }
    }
    if let Some(session) = &b.session {
        if let Ok(true) = app.store.set_pane_session(&id, session) {
            desks_moved(&app);
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// The notes of the desk a pane is on, for the agent running in that pane
/// (`read_desk_notes`, from `snyvi mcp`, which knows the pane by
/// `SNYVI_SESSION`).
///
/// The second pane route behind the token rather than the capability, and the
/// only one that gives anything back. It reads and never writes: a desk's list
/// is the reader's, and an agent that could add to it would be an agent
/// writing the reader's to-dos. It answers only for a pane that is running, so
/// a pane id found in an old screen or a log reads nothing once that shell is
/// gone, and only with that one desk's list -- never another desk's, never the
/// library. A token holder could already open the store; what this adds is
/// that an agent is handed one list through the front door instead.
async fn pane_notes(State(app): S, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::pane::valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !app.panes.is_running(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let placed = match app.store.pane(&id) {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    match app.store.desk_notes(placed.desk_id) {
        Ok(mut notes) => {
            settle_stages(&app, &mut notes);
            for n in notes
                .iter_mut()
                .filter(|n| n.stage == "working" && n.stage_pane == id)
            {
                n.stage_panel = "this panel".into();
            }
            // A line's pictures, as files the agent can open and look at.
            let dir = app.paths.data_dir.join(crate::desk::NOTE_IMAGES);
            for n in &mut notes {
                n.images = n
                    .images
                    .iter()
                    .map(|x| dir.join(x).to_string_lossy().to_string())
                    .collect();
            }
            Json(json!({ "desk": placed.desk_name, "notes": notes })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
struct TickBody {
    /// The agent's name, as its MCP client gave it in `initialize`.
    #[serde(default)]
    by: String,
    /// The commit the work is in, if the agent made one.
    #[serde(default)]
    commit: String,
    /// A document the agent sent about the work, by its id.
    #[serde(default)]
    about: String,
    /// Where the finished work can be seen: a PR, a deploy, a store page.
    #[serde(default)]
    evidence: String,
}

/// An agent ticks a line on its own desk's list: `tick_desk_note`. The same
/// gate as reading it -- the token, then a pane that is running -- and the one
/// write an agent has on the list: done, by it, on an open line of the desk
/// its pane is on. Every window's rail is told, so the tick shows at once.
async fn pane_tick_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(String, i64)>,
    body: Option<Json<TickBody>>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::pane::valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !app.panes.is_running(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let placed = match app.store.pane(&id) {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    let b = body.map(|Json(b)| b).unwrap_or_default();
    let (commit, doc, evidence) = (b.commit.trim(), b.about.trim(), b.evidence.trim());
    // Said wrong, it is said back rather than dropped: the agent can tick
    // again with the hash `git log` printed, and the line is still open.
    if !commit.is_empty() && !crate::desk::commit_ok(commit) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "commit must be a hash as git log prints it: 7 to 40 hex digits" })),
        )
            .into_response();
    }
    if !doc.is_empty() && !crate::desk::doc_ok(doc) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "about must be a document id from send_document: 10 hex digits" }),
            ),
        )
            .into_response();
    }
    if !evidence.is_empty() && !crate::desk::evidence_ok(evidence) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "evidence must be an http or https URL, one line, at most 500 characters" })),
        )
            .into_response();
    }
    let tick = crate::desk::Tick {
        by: b.by,
        commit: commit.into(),
        doc: doc.into(),
        evidence: evidence.into(),
        pane: id.clone(),
    };
    match app.store.tick_desk_note(placed.desk_id, note, &tick) {
        Ok(true) => {
            emit(&app, "desknotes", json!({ "desk": placed.desk_id }));
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        // Not on this desk's list, taken off it, or already done: the agent is
        // told which it cannot tell apart, and nothing changed.
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "no open note by that id on this desk" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
struct MarkBody {
    #[serde(default)]
    stage: String,
    /// The agent's name, as its MCP client gave it in `initialize`.
    #[serde(default)]
    by: String,
    /// The plan's document id: needed with `planned`.
    #[serde(default)]
    about: String,
}

/// An agent says how far it has got with a line on its own desk's list:
/// `mark_desk_note`. The gate the tick has -- the token, then a running pane
/// -- and the one write is that line's stage, on an open line of the desk the
/// pane is on. `working` is tied to this pane and the conversation it has
/// now, so it lasts only as long as that conversation (`settle_stages`).
async fn pane_mark_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(String, i64)>,
    body: Option<Json<MarkBody>>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::pane::valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !app.panes.is_running(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let placed = match app.store.pane(&id) {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    let b = body.map(|Json(b)| b).unwrap_or_default();
    let (stage, doc) = (b.stage.trim(), b.about.trim());
    let say = |why: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": why }))).into_response();
    if !crate::desk::STAGES.contains(&stage) {
        return say("stage must be read, planned or working; done is tick_desk_note");
    }
    if !doc.is_empty() && !crate::desk::doc_ok(doc) {
        return say("about must be a document id from send_document: 10 hex digits");
    }
    if stage == "planned" && doc.is_empty() {
        return say("planned needs about: the id of the plan you sent with send_document");
    }
    let mark = crate::desk::Mark {
        stage: stage.into(),
        by: b.by,
        doc: doc.into(),
        pane: id.clone(),
        session: placed.pane.agent_session.clone(),
    };
    match app.store.mark_desk_note(placed.desk_id, note, &mark) {
        Ok(true) => {
            emit(&app, "desknotes", json!({ "desk": placed.desk_id }));
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "no open note by that id on this desk" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// An agent names the panel it runs in: `name_panel`. The gate the list has
/// -- the token, then a running pane -- and the one thing it touches is that
/// pane's own name, the one the reader sets with ✎. Empty gives the panel
/// back to its program's title.
async fn pane_name(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<RenameBody>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::pane::valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !app.panes.is_running(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match app.store.rename_pane(&id, &b.name) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The running pane `id`, placed on its desk, for the routes an agent reaches
/// from inside it: the token, a pane id of the right shape, a pane that is
/// running -- which a pane only is while its program is -- and then its row.
/// The answer to refuse with otherwise.
fn agent_pane(
    app: &App,
    headers: &HeaderMap,
    id: &str,
) -> Result<crate::desk::Placed, Box<Response>> {
    if !authorized(app, headers) {
        return Err(Box::new(StatusCode::UNAUTHORIZED.into_response()));
    }
    if !crate::pane::valid_id(id) {
        return Err(Box::new(StatusCode::BAD_REQUEST.into_response()));
    }
    if !app.panes.is_running(id) {
        return Err(Box::new(StatusCode::NOT_FOUND.into_response()));
    }
    match app.store.pane(id) {
        Ok(Some(p)) => Ok(p),
        Ok(None) => Err(Box::new(StatusCode::NOT_FOUND.into_response())),
        Err(e) => Err(Box::new(err(e))),
    }
}

/// The desk brief for a Claude starting in this pane (`crate::brief`): what
/// the SessionStart hook hands it as context, and the session's title. The
/// gate the list has, and only this pane's own desk. Empty when the reader
/// turned the brief off, so the hook says nothing.
async fn pane_brief(State(app): S, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    if !brief_on(&app) {
        return Json(json!({ "context": "", "title": "" })).into_response();
    }
    let Ok(Some(desk)) = app.store.desk(placed.desk_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut notes = app.store.desk_notes(desk.id).unwrap_or_default();
    settle_stages(&app, &mut notes);
    // Worked on here is not worked on elsewhere: a Claude starting in the
    // pane that said `working` is a new conversation, and the old one's claim
    // has already been settled above.
    let notes: Vec<_> = notes
        .into_iter()
        .map(|mut n| {
            if n.stage == "working" && n.stage_pane == id {
                n.stage_panel.clear();
            }
            n
        })
        .collect();
    let docs = app.store.desk_docs(desk.id, 1, false).unwrap_or_default();
    let last = docs.first().map(|d| crate::brief::LastDoc {
        id: &d.id,
        title: &d.title,
        at: d.received_at,
    });
    let now = crate::store::now();
    // The brief says everything as of now; the next prompt's changes start
    // here.
    app.panes.told(&id, now);
    Json(json!({
        "context": crate::brief::brief(&desk, placed.pane.slot, &notes, &desk.keys, last, now),
        "title": crate::brief::title(&desk, placed.pane.slot),
    }))
    .into_response()
}

/// What changed on this pane's desk since snyvi last spoke to its agent
/// (`crate::brief::changes`): what the UserPromptSubmit hook hands Claude with
/// the prompt. The same gate and switch as the brief. Empty when nothing
/// changed, when the brief is off, and when the daemon does not know when it
/// last spoke to this pane -- it has just started -- in which case it only
/// starts counting.
async fn pane_changes(State(app): S, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let quiet = || Json(json!({ "context": "" })).into_response();
    if !brief_on(&app) {
        return quiet();
    }
    let now = crate::store::now();
    let since = match app.panes.told(&id, now) {
        Some(since) if since > 0 => since,
        _ => return quiet(),
    };
    let Ok(Some(desk)) = app.store.desk(placed.desk_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut notes = app.store.desk_notes(desk.id).unwrap_or_default();
    settle_stages(&app, &mut notes);
    let removed = app
        .store
        .removed_desk_notes_since(desk.id, since)
        .unwrap_or_default();
    let docs = app
        .store
        .desk_docs(desk.id, crate::brief::DOCS_LOOKED_AT, false)
        .unwrap_or_default();
    let context = crate::brief::changes(&crate::brief::Changes {
        slot: placed.pane.slot,
        pane: &id,
        notes: &notes,
        removed: &removed,
        docs: &docs,
        keys: &desk.keys,
        left_off: desk.left_off.as_ref(),
        since,
        now,
    });
    Json(json!({ "context": context })).into_response()
}

#[derive(Deserialize, Default)]
struct AgentLeftOffBody {
    #[serde(default)]
    text: String,
    #[serde(default)]
    about: String,
    /// The agent's name, as its MCP client gave it.
    #[serde(default)]
    by: String,
}

/// An agent says where it left the work on its own desk: `leave_off`. The
/// one it replaced stays reachable from the desk head's Undo, as a reader's
/// edit does; an agent cannot clear one, only say the next.
async fn pane_left_off(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AgentLeftOffBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    if b.text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "leave_off needs a sentence" })),
        )
            .into_response();
    }
    let by = if b.by.trim().is_empty() {
        "an agent".to_string()
    } else {
        b.by
    };
    let to = crate::desk::LeftOff {
        text: b.text,
        at: 0,
        by,
        about: b.about,
        pane: id.clone(),
    };
    match app.store.set_left_off(placed.desk_id, &to) {
        Ok(Some(_)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
struct SuggestBody {
    #[serde(default)]
    text: String,
    #[serde(default)]
    by: String,
}

/// An agent suggests a line for its own desk's list: `suggest_desk_note`. It
/// shows as a ghost row with Keep and ✕, and is on the list only once kept.
async fn pane_suggest_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<SuggestBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match app.store.suggest_desk_note(placed.desk_id, &b.text, &b.by) {
        Ok(crate::desk::Suggested::Note(note)) => {
            notes_moved(&app, placed.desk_id);
            (StatusCode::CREATED, Json(json!({ "note": note, "desk": placed.desk_name }))).into_response()
        }
        Ok(crate::desk::Suggested::Empty) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "suggest_desk_note needs a line of text" })),
        )
            .into_response(),
        Ok(crate::desk::Suggested::Full) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk already has {} suggestions waiting for the user (or its list is full); wait until they keep or remove one", crate::desk::SUGGESTIONS_PER_DESK) })),
        )
            .into_response(),
        Ok(crate::desk::Suggested::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// An image pasted into a pane. A terminal cannot take a bitmap, so snyvi does
/// what it does with everything else: the image is received as a document,
/// named for the pane it came from, and what goes back to the page is a path
/// the page then types into the pane as the reader's paste.
///
/// A path and not the document's URL: the program on the other end is almost
/// always an agent, and an agent opens a file with its own tools and has no
/// reason to be able to fetch from this daemon. The file sits beside the
/// store, in `pastes/`, named by its content so pasting it twice is one file.
/// A sandboxed agent may not be allowed to read there; that is the one open
/// question this leaves, and `docs/DESK.md` says so.
async fn paste_image(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(placed)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
    {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({ "error": "an image, as png, jpeg, gif or webp" })),
            )
                .into_response()
        }
    };
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "an empty paste" })),
        )
            .into_response();
    }
    let dir = app.paths.data_dir.join("pastes");
    let name = format!("{}.{ext}", &blake3::hash(&body).to_hex()[..16]);
    let file = dir.join(&name);
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
        return err(anyhow::anyhow!("keeping the pasted image: {e}"));
    }
    let payload = Payload {
        path: Some(file.to_string_lossy().to_string()),
        title: Some(format!(
            "Pasted into {} [{}]",
            placed.desk_name, placed.pane.slot
        )),
        workflow: Some(format!("{} pastes", placed.desk_name)),
        cwd: Some(placed.root.clone()),
        origin: Some("paste".into()),
        pane: Some(id.clone()),
        ..Default::default()
    };
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || {
        receive::receive(&app2.store, &app2.renderer, payload)
    })
    .await
    {
        Ok(Ok(received)) => {
            let doc = received.doc;
            emit(
                &app,
                "doc",
                json!({ "doc": doc, "url": format!("{}/d/{}", config::base_url(), doc.id), "existing": received.existing, "supersedes": received.supersedes, "waiting": waiting(&app) }),
            );
            Json(json!({ "id": doc.id, "path": file })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// Open the machine's own terminal, in the directory the reader is looking at.
///
/// The only thing this takes from the caller is an id snyvi already holds; the
/// directory is looked up here, no command is passed, and nothing comes back.
/// `docs/TERMINAL.md` has the argument, and section 3 of it has what is
/// deliberately absent.
async fn terminal(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<TerminalBody>,
) -> Response {
    if let Some(no) = refuse_folder(&app, &headers, &q, &b) {
        return no;
    }
    let Some(dir) = folder_of(&app, &b) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no folder to open" })),
        )
            .into_response();
    };
    // `open_terminal` refuses without a display as well; asking here is only so
    // that the two ways of having no terminal say different things.
    if !platform::has_display() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no desktop session to open a terminal in" })),
        )
            .into_response();
    }
    if platform::open_terminal(&dir) {
        Json(json!({ "dir": dir })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no terminal found on this machine" })),
        )
            .into_response()
    }
}

/// Open the folder the reader is looking at in the system's file manager.
/// The same ids in and the same guard as `terminal`; `platform::open_folder`
/// does the opening.
async fn reveal(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<TerminalBody>,
) -> Response {
    if let Some(no) = refuse_folder(&app, &headers, &q, &b) {
        return no;
    }
    let Some(dir) = folder_of(&app, &b) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "no folder to open" })),
        )
            .into_response();
    };
    if !platform::has_display() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no desktop session to open a folder in" })),
        )
            .into_response();
    }
    if platform::open_folder(&dir) {
        Json(json!({ "dir": dir })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "nothing on this machine opens folders" })),
        )
            .into_response()
    }
}

/// Who may open a folder: a desk's only behind the desk's own gate, since a
/// desk is reached by nothing less; anything else from this page or with the
/// token, as `terminal` always was.
fn refuse_folder(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
    b: &TerminalBody,
) -> Option<Response> {
    if b.desk.is_some() {
        return refuse_desk(app, headers, q);
    }
    if !from_this_page(headers) && !authorized(app, headers) {
        return Some(
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "not from this page, and no token" })),
            )
                .into_response(),
        );
    }
    None
}

/// The folder a request names, looked up here from an id snyvi already
/// holds, so nothing the caller types is ever a path. One function for
/// `terminal` and `reveal`, so the two can never open different places.
fn folder_of(app: &App, b: &TerminalBody) -> Option<std::path::PathBuf> {
    let dir = if let Some(id) = b.root.as_deref() {
        // `resolve` is what keeps a path from the caller inside the root it
        // names -- the same guard `browse_file` reads its bytes through. A file
        // opens beside itself; the root opens at the root.
        app.browse
            .resolve(id, b.path.as_deref().unwrap_or(""))
            .ok()
            .and_then(dir_of)
    } else if let Some(id) = b.doc.as_deref() {
        app.store
            .get(id)
            .ok()
            .flatten()
            .and_then(|d| doc_folder(app, &d))
    } else if let Some(id) = b.desk {
        app.store.desk(id).ok().flatten().map(|d| d.root.into())
    } else if let Some(id) = b.project {
        app.store.project_root(id).map(Into::into)
    } else {
        None
    };
    dir.filter(|d| d.is_dir())
}

/// A folder is itself; a file is the folder it sits in.
fn dir_of(p: std::path::PathBuf) -> Option<std::path::PathBuf> {
    if p.is_dir() {
        Some(p)
    } else {
        p.parent().map(|d| d.to_path_buf())
    }
}

#[derive(Deserialize)]
struct ResolveBody {
    /// The word under the pointer, as the page cut it out.
    word: String,
    /// Where it was: a panel (`desk` and `pane`), a document (`doc`), or a
    /// file in the folder reader (`root` and `path`).
    desk: Option<i64>,
    pane: Option<String>,
    doc: Option<String>,
    root: Option<String>,
    path: Option<String>,
    /// Asked on the click: open what the word names. Without it the answer
    /// only says whether it names anything, for the underline while Ctrl is
    /// held, and nothing is opened or remembered.
    #[serde(default)]
    open: bool,
}

/// A path the reader Ctrl-clicked (see `crate::resolve`).
///
/// The page names the word and where it stood, never a folder: the folders a
/// relative path is tried against are looked up here, from ids snyvi holds.
/// In a panel, the folder its program is in now, then the desk's. In a
/// document, the folder of the file it was sent from, then the desk it was
/// sent from, then its project's. In the folder reader, the file's folder,
/// then the folder open for reading.
///
/// Behind the desk's gate, as the folder dialog is: the answer says whether a
/// path exists, and the click opens it -- a file in the reader, a folder in
/// the file manager. Nothing is run.
async fn resolve_path(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<ResolveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let (Some(id), Some(pane)) = (b.desk, b.pane.as_deref()) {
        let Ok(Some(d)) = app.store.desk(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let Some(p) = d.panes.iter().find(|p| p.id == pane) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let now = app.panes.status(&p.id).cwd;
        bases.extend([now, p.cwd.clone(), d.root.clone()].map(std::path::PathBuf::from));
    } else if let Some(id) = b.doc.as_deref() {
        let Ok(Some(d)) = app.store.get(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        bases.extend(
            d.source_path
                .as_deref()
                .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf())),
        );
        if let Some(o) = &d.desk {
            if let Ok(Some(desk)) = app.store.desk(o.id) {
                bases.push(desk.root.into());
            }
        }
        bases.extend(
            app.store
                .project_root(d.project_id)
                .map(std::path::PathBuf::from),
        );
    } else if let Some(id) = b.root.as_deref() {
        let Some(root) = app.browse.get(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        bases.extend(
            app.browse
                .resolve(id, b.path.as_deref().unwrap_or(""))
                .ok()
                .and_then(dir_of),
        );
        bases.push(root.path.into());
    }
    bases.retain(|d| !d.as_os_str().is_empty() && d.is_dir());
    bases.dedup();
    let home = dirs::home_dir();
    let Some(found) = crate::resolve::find(&b.word, &bases, home.as_deref()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let shown = crate::agents::tilde(&found.path);
    let kind = if found.dir { "dir" } else { "file" };
    if !b.open {
        return Json(json!({ "kind": kind, "path": shown, "line": found.line })).into_response();
    }
    if found.dir {
        if !platform::has_display() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "no desktop session to open a folder in" })),
            )
                .into_response();
        }
        return if platform::open_folder(&found.path) {
            Json(json!({ "kind": kind, "path": shown })).into_response()
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "nothing on this machine opens folders" })),
            )
                .into_response()
        };
    }
    // A file opens in the folder reader: under a folder already open for
    // reading when it is in one, or else under the first of the bases it is
    // in -- the panel's desk, the document's project -- or else its own
    // folder. A folder opened here is a row under Folders, as any other.
    let roots: Vec<(String, std::path::PathBuf)> = app
        .browse
        .list()
        .into_iter()
        .map(|r| (r.id, r.path.into()))
        .collect();
    let (id, rel) = match crate::resolve::under(&found.path, &roots) {
        Some((id, rel)) => (id.to_string(), rel),
        None => {
            let dir = bases
                .iter()
                .rev()
                .filter_map(|b| b.canonicalize().ok())
                .find(|b| found.path.starts_with(b))
                .or_else(|| found.path.parent().map(|p| p.to_path_buf()));
            let Some(root) = dir.and_then(|d| app.browse.open(&d).ok()) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            emit(&app, "browse", json!({ "roots": app.browse.list() }));
            let rel = found
                .path
                .strip_prefix(&root.path)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            (root.id, rel)
        }
    };
    Json(json!({ "kind": kind, "path": shown, "line": found.line, "root": id, "rel": rel }))
        .into_response()
}

async fn browse_open(State(app): S, headers: HeaderMap, Json(b): Json<OpenBody>) -> Response {
    if !authorized(&app, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid token" })),
        )
            .into_response();
    }
    match app.browse.open(std::path::Path::new(&b.path)) {
        Ok(root) => {
            let url = format!("{}/b/{}", config::base_url(), root.id);
            emit(&app, "browse", json!({ "roots": app.browse.list() }));
            (
                StatusCode::CREATED,
                Json(json!({ "root": root, "url": url })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// The sidebar's `+` beside Folders: the desktop's own folder dialog, and the
/// folder it answers with opened for browsing.
///
/// Behind the same gate as the desks, because it is the same kind of act: a
/// page reaching the filesystem. The page names nothing -- it asks, and the
/// path comes from the reader's hand in a dialog the desktop draws. A browser
/// tab is refused before a dialog is shown, and one dialog is open at a time,
/// so a page cannot stack them on the reader's screen.
async fn browse_pick(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    static PICKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if PICKING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a folder dialog is already open" })),
        )
            .into_response();
    }
    // Cleared by dropping, not by the line after the await: a reader who closes
    // the window while the dialog is up drops this handler's future where it
    // waits, and a flag cleared below that line would stay true for the life of
    // the daemon -- one abandoned dialog and the `+` never works again.
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            PICKING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _done = Done;
    let picked = tokio::task::spawn_blocking(crate::platform::pick_folder).await;
    match picked {
        Ok(Ok(Some(dir))) => match app.browse.open(&dir) {
            Ok(root) => {
                let url = format!("{}/b/{}", config::base_url(), root.id);
                emit(&app, "browse", json!({ "roots": app.browse.list() }));
                (
                    StatusCode::CREATED,
                    Json(json!({ "root": root, "url": url })),
                )
                    .into_response()
            }
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response(),
        },
        // Closed without a choice: nothing to say, and nothing opened.
        Ok(Ok(None)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(why)) => {
            (StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": why }))).into_response()
        }
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

async fn browse_list(State(app): S) -> Response {
    Json(app.browse.list()).into_response()
}

async fn browse_close(State(app): S, Path(id): Path<String>) -> Response {
    if app.browse.close(&id) {
        emit(&app, "browse", json!({ "roots": app.browse.list() }));
        Json(json!({ "ok": true })).into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

/// Close folder, taken back. Only a folder closed in this run comes back, so
/// a page with no token can undo its own close and open nothing else.
async fn browse_reopen(State(app): S, Path(id): Path<String>) -> Response {
    match app.browse.reopen(&id) {
        Some(root) => {
            emit(&app, "browse", json!({ "roots": app.browse.list() }));
            Json(json!({ "root": root })).into_response()
        }
        None => StatusCode::GONE.into_response(),
    }
}

async fn browse_tree(State(app): S, Path(id): Path<String>, Query(q): Query<PathQ>) -> Response {
    match app.browse.entries(&id, q.path.as_deref().unwrap_or("")) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn browse_file(State(app): S, Path(id): Path<String>, Query(q): Query<PathQ>) -> Response {
    let rel = q.path.unwrap_or_default();
    let app2 = app.clone();
    let rel2 = rel.clone();
    let id2 = id.clone();
    // Rendering is CPU work; keep it off the async executor.
    let res =
        tokio::task::spawn_blocking(move || app2.browse.file(&id2, &rel2, &app2.renderer)).await;
    match res {
        Ok(Ok(view)) => {
            let root = app.browse.get(&id);
            Json(json!({ "file": view, "root": root })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

async fn browse_raw(
    State(app): S,
    Path(id): Path<String>,
    Query(q): Query<PathQ>,
    req: HeaderMap,
) -> Response {
    serve_browsed(&app, &id, q.path.as_deref().unwrap_or(""), &req).await
}

/// The same bytes under a path-shaped URL. A framed page is loaded from here so that
/// its own relative stylesheets, scripts and images resolve against the file's
/// directory instead of against `/api/browse/<id>/`.
async fn browse_raw_path(
    State(app): S,
    Path((id, rel)): Path<(String, String)>,
    req: HeaderMap,
) -> Response {
    serve_browsed(&app, &id, &rel, &req).await
}

/// Headers that make a file safe to frame.
///
/// A page is somebody else's code: the frame denies it our origin, and this denies it
/// the network, so it cannot report home with whatever it can see. A PDF is not code
/// at all — it goes to the browser's own viewer, which refuses to run inside a
/// sandbox, so it is framed unsandboxed and `nosniff` plus its content type are what
/// keep it from ever being treated as a page. Anything else is served inert.
fn protect(headers: &mut HeaderMap, ext: &str) {
    let policy = match render::preview_kind(ext) {
        Some("html") => "connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
        Some("pdf") => "frame-ancestors 'self'",
        _ => "sandbox; default-src 'none'",
    };
    if let Ok(v) = HeaderValue::from_str(policy) {
        headers.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

async fn serve_browsed(app: &Arc<App>, id: &str, rel: &str, req: &HeaderMap) -> Response {
    let Ok(path) = app.browse.resolve(id, rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let mut headers = HeaderMap::new();
    let mut set = |k: header::HeaderName, v: &str| {
        if let Ok(v) = HeaderValue::from_str(v) {
            headers.insert(k, v);
        }
    };
    set(header::CONTENT_TYPE, &mime);
    set(header::CACHE_CONTROL, "private, max-age=60");
    protect(&mut headers, &render::ext_of(&path.to_string_lossy()));
    serve_file(&path, headers, req).await
}

/// A file off disk, whole or the one range asked for, streamed.
///
/// A player seeks by asking for `bytes=N-`, over and over, and a gigabyte
/// video must not become a gigabyte in the daemon: the body is read a buffer
/// at a time as the connection takes it, so what the daemon holds per open
/// player is one buffer whatever the file weighs. `headers` are the
/// caller's (type, cache, policy); length and range are added here.
async fn serve_file(path: &std::path::Path, mut headers: HeaderMap, req: &HeaderMap) -> Response {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(len) = file.metadata().await.map(|m| m.len()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let asked = req.get(header::RANGE).and_then(|v| v.to_str().ok());
    let (status, start, count) = match asked.map(|v| parse_range(v, len)) {
        None | Some(Span::Whole) => (StatusCode::OK, 0, len),
        Some(Span::Part(a, b)) => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {a}-{b}/{len}")) {
                headers.insert(header::CONTENT_RANGE, v);
            }
            (StatusCode::PARTIAL_CONTENT, a, b - a + 1)
        }
        Some(Span::Unsatisfiable) => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
                headers.insert(header::CONTENT_RANGE, v);
            }
            return (StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response();
        }
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    let body = Body::from_stream(Chunks {
        file: file.take(count),
        buf: vec![0; 128 * 1024].into_boxed_slice(),
    });
    (status, headers, body).into_response()
}

/// What a `Range` header asks of a file `len` bytes long.
#[derive(Debug, PartialEq)]
enum Span {
    /// No usable range: several at once, another unit, or nonsense. The
    /// header is ignored and the whole file sent, as HTTP allows.
    Whole,
    /// First and last byte, inclusive, both inside the file.
    Part(u64, u64),
    /// Starts past the end.
    Unsatisfiable,
}

fn parse_range(v: &str, len: u64) -> Span {
    let Some(spec) = v.trim().strip_prefix("bytes=") else {
        return Span::Whole;
    };
    if spec.contains(',') {
        return Span::Whole;
    }
    let Some((a, b)) = spec.trim().split_once('-') else {
        return Span::Whole;
    };
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| s.parse::<u64>().ok();
    match (a.is_empty(), b.is_empty()) {
        // `-500`: the last 500 bytes.
        (true, false) => match num(b) {
            Some(0) => Span::Unsatisfiable,
            Some(n) if len > 0 => Span::Part(len.saturating_sub(n), len - 1),
            Some(_) => Span::Unsatisfiable,
            None => Span::Whole,
        },
        (false, _) => match (num(a), if b.is_empty() { Some(u64::MAX) } else { num(b) }) {
            (Some(a), Some(b)) if a > b => Span::Whole,
            (Some(a), Some(_)) if a >= len => Span::Unsatisfiable,
            (Some(a), Some(b)) => Span::Part(a, b.min(len - 1)),
            _ => Span::Whole,
        },
        (true, true) => Span::Whole,
    }
}

/// A file read as a stream of chunks, one buffer at a time, for a body.
struct Chunks {
    file: tokio::io::Take<tokio::fs::File>,
    buf: Box<[u8]>,
}

impl tokio_stream::Stream for Chunks {
    type Item = std::io::Result<axum::body::Bytes>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        let this = &mut *self;
        let mut rb = tokio::io::ReadBuf::new(&mut this.buf);
        match tokio::io::AsyncRead::poll_read(std::pin::Pin::new(&mut this.file), cx, &mut rb) {
            Poll::Ready(Ok(())) if rb.filled().is_empty() => Poll::Ready(None),
            Poll::Ready(Ok(())) => {
                Poll::Ready(Some(Ok(axum::body::Bytes::copy_from_slice(rb.filled()))))
            }
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Declarations in a browsed file. Parsing is repeated rather than cached: it is
/// off the first-paint path and the rail asks for it only once per file.
async fn browse_outline(State(app): S, Path(id): Path<String>, Query(q): Query<PathQ>) -> Response {
    let rel = q.path.unwrap_or_default();
    let Ok(path) = app.browse.resolve(&id, &rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    drop(path);
    let app2 = app.clone();
    let res =
        tokio::task::spawn_blocking(move || app2.browse.outline(&id, &rel, &app2.renderer)).await;
    match res {
        Ok(items) => Json(items.unwrap_or_default()).into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

async fn browse_find(State(app): S, Path(id): Path<String>, Query(q): Query<FindQ>) -> Response {
    let app2 = app.clone();
    let query = q.q.unwrap_or_default();
    let limit = q.limit.unwrap_or(40).min(200);
    match tokio::task::spawn_blocking(move || app2.browse.find(&id, &query, limit)).await {
        Ok(Ok(hits)) => Json(hits).into_response(),
        Ok(Err(e)) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

async fn shell_browse(State(app): S, Path(id): Path<String>) -> Response {
    browse_shell(app, id, String::new()).await
}

async fn shell_browse_file(State(app): S, Path((id, path)): Path<(String, String)>) -> Response {
    browse_shell(app, id, path).await
}

async fn browse_shell(app: Arc<App>, id: String, path: String) -> Response {
    let Some(root) = app.browse.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Html("<h1>That folder is no longer open</h1>"),
        )
            .into_response();
    };
    // Land on the README when no file was asked for.
    let path = if path.is_empty() {
        app.browse.landing(&id).unwrap_or_default()
    } else {
        path
    };
    let title = if path.is_empty() {
        root.name.clone()
    } else {
        path.clone()
    };
    let boot = json!({
        "view": "browse",
        "tree": app.store.projects().unwrap_or_default(),
        "browse": app.browse.list(),
        "browseRoot": root,
        "browsePath": path,
        "version": VERSION,
    });
    shell(&app, boot, "", &title)
}

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let alt = headers
        .get("x-snyvi-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    bearer
        .or(alt)
        .map(|t| constant_eq(t, &app.token.read().unwrap()))
        .unwrap_or(false)
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn err(e: anyhow::Error) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        desk_refusal, dir_of, hello_allows, parse_range, Span, Ui, ABOUT_JS, APP_CSS, APP_JS,
        BOOT_JS, BROWSE_JS, DESK_JS, DIFF_JS, FIND_JS, FRAME_JS, GAME_JS, HOME_JS, INDEX_HTML,
        KEYS_JS, LOOK_JS, MENU_JS, MMD_JS, NOTE_JS, PALETTE_JS, PATHS_JS, TIP_JS, TOAST_JS,
    };
    use crate::capability::Capabilities;
    use axum::http::{header, HeaderMap, HeaderValue};

    /// A file opens the folder it sits in; a folder opens itself.
    #[test]
    fn a_file_opens_beside_itself() {
        let tmp = crate::store::tempdir::Dir::new("snyvi-reveal");
        let file = tmp.path.join("notes.md");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(dir_of(file), Some(tmp.path.clone()));
        assert_eq!(dir_of(tmp.path.clone()), Some(tmp.path.clone()));
    }

    /// What a player sends when it seeks, and what it must get back.
    #[test]
    fn ranges_are_read_the_way_players_send_them() {
        assert_eq!(parse_range("bytes=0-", 1000), Span::Part(0, 999));
        assert_eq!(parse_range("bytes=100-199", 1000), Span::Part(100, 199));
        assert_eq!(
            parse_range("bytes=900-5000", 1000),
            Span::Part(900, 999),
            "clamped to the end"
        );
        assert_eq!(
            parse_range("bytes=-500", 1000),
            Span::Part(500, 999),
            "a suffix"
        );
        assert_eq!(parse_range("bytes=-5000", 1000), Span::Part(0, 999));
        assert_eq!(parse_range("bytes=1000-", 1000), Span::Unsatisfiable);
        assert_eq!(
            parse_range("bytes=0-", 0),
            Span::Unsatisfiable,
            "an empty file"
        );
        assert_eq!(parse_range("bytes=-0", 1000), Span::Unsatisfiable);
        assert_eq!(
            parse_range("bytes=0-1,5-9", 1000),
            Span::Whole,
            "several fall back to all"
        );
        assert_eq!(parse_range("items=0-1", 1000), Span::Whole);
        assert_eq!(parse_range("bytes=9-3", 1000), Span::Whole);
        assert_eq!(parse_range("bytes=x-", 1000), Span::Whole);
    }

    /// The one decision in this server that stands between a web page and a
    /// shell. Every shape that is not a live capability under the key that
    /// means it has to be a refusal, including the shapes that look close.
    #[test]
    fn only_a_frame_carrying_a_live_capability_opens_a_desk() {
        let caps = Capabilities::default();
        let cap = caps.mint().unwrap();

        assert!(hello_allows(
            &caps,
            Some(&format!(r#"{{"capability":"{cap}"}}"#))
        ));

        // Silence until the deadline, which is what a socket opened by
        // something with nothing to present does.
        assert!(!hello_allows(&caps, None));
        // A capability that was never minted, and the empty one.
        assert!(!hello_allows(
            &caps,
            Some(&format!(r#"{{"capability":"{}"}}"#, "b".repeat(64)))
        ));
        assert!(!hello_allows(&caps, Some(r#"{"capability":""}"#)));
        // The right secret under the wrong key is not a hello, and neither is a
        // bare string: the frame has to be the shape the protocol says.
        assert!(!hello_allows(
            &caps,
            Some(&format!(r#"{{"token":"{cap}"}}"#))
        ));
        assert!(!hello_allows(&caps, Some(&format!(r#""{cap}""#))));
        assert!(!hello_allows(&caps, Some("")));
        assert!(!hello_allows(&caps, Some("not json at all")));
    }

    /// `window=1` is forgeable, so the desk path must never read it. The two
    /// window signals were allowed to coexist on exactly this condition: the
    /// count answers "how many are reading", the capability answers "may this
    /// page run a shell", and the second never consults the first. `EventSource`
    /// cannot set a header, which is why the count still rides a query string;
    /// this test is what makes that harmless rather than a second way in.
    #[test]
    fn the_window_count_is_never_consulted_on_the_desk_path() {
        let src = include_str!("server.rs");
        let from = src
            .find("async fn desk_socket")
            .expect("the desk socket should be in this file");
        let to = src[from..]
            .find("\nfn hello_allows")
            .expect("hello_allows follows the socket")
            + from;
        let path = &src[from..to];

        for forgeable in ["has_window", "windows", "is_window", "EventsQ"] {
            assert!(
                !path.contains(forgeable),
                "the desk path reads `{forgeable}`, which a browser tab can forge"
            );
        }
        // And the gate it does go through takes no app at all, so there is
        // nothing for a count to reach it through even by accident.
        assert!(
            src.contains(
                "fn hello_allows(caps: &crate::capability::Capabilities, frame: Option<&str>)"
            ),
            "the desk gate should see a capability and a frame, and nothing else"
        );
    }

    /// The same three refusals as the socket, on the routes a desk is made
    /// and named over. The capability rides in a header because that is the
    /// one place a page can put a secret on a request it composes itself --
    /// and the query string, where it would be logged, is refused at the place
    /// the attempt is made rather than quietly ignored.
    #[test]
    fn a_desk_route_takes_its_capability_from_a_header_and_nowhere_else() {
        let caps = Capabilities::default();
        let cap = caps.mint().unwrap();
        let none = std::collections::HashMap::new();
        let ours = |cap: &str| {
            let mut h = HeaderMap::new();
            h.insert(
                header::ORIGIN,
                HeaderValue::from_str(&crate::config::base_url()).unwrap(),
            );
            h.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
            if !cap.is_empty() {
                h.insert(
                    super::CAPABILITY_HEADER,
                    HeaderValue::from_str(cap).unwrap(),
                );
            }
            h
        };

        assert_eq!(desk_refusal(&caps, &ours(&cap), &none), None);

        // A page of ours, and no capability: a browser tab, which is the case
        // the whole feature rests on refusing.
        assert_eq!(desk_refusal(&caps, &ours(""), &none), Some("no capability"));
        assert_eq!(
            desk_refusal(&caps, &ours(&"c".repeat(64)), &none),
            Some("no capability")
        );

        // The right secret, in the wrong place.
        let query = std::collections::HashMap::from([("cap".to_string(), cap.clone())]);
        assert_eq!(
            desk_refusal(&caps, &ours(&cap), &query),
            Some("the capability is not a query parameter")
        );
        let query = std::collections::HashMap::from([("capability".to_string(), cap.clone())]);
        assert_eq!(
            desk_refusal(&caps, &ours(&cap), &query),
            Some("the capability is not a query parameter")
        );

        // Another origin, and a local process with no browser at all: neither
        // is this page, whatever it is holding.
        let mut elsewhere = ours(&cap);
        elsewhere.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.example"),
        );
        assert_eq!(
            desk_refusal(&caps, &elsewhere, &none),
            Some("not from this page")
        );
        let mut bare = HeaderMap::new();
        bare.insert(
            super::CAPABILITY_HEADER,
            HeaderValue::from_str(&cap).unwrap(),
        );
        assert_eq!(
            desk_refusal(&caps, &bare, &none),
            Some("not from this page")
        );

        // The window's own GET: a browser sends no `Origin` on a same-origin
        // read, so `Host` is what says it is ours. The live window found this;
        // the desk list was refused and every desk read "No such desk".
        let read = |host: &str, site: Option<&'static str>| {
            let mut h = HeaderMap::new();
            h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            if let Some(s) = site {
                h.insert("sec-fetch-site", HeaderValue::from_static(s));
            }
            h.insert(
                super::CAPABILITY_HEADER,
                HeaderValue::from_str(&cap).unwrap(),
            );
            h
        };
        let here = format!("127.0.0.1:{}", crate::config::port());
        assert_eq!(
            desk_refusal(&caps, &read(&here, Some("same-origin")), &none),
            None
        );
        assert_eq!(desk_refusal(&caps, &read(&here, None), &none), None);
        // A name rebound to 127.0.0.1 is still its own name in `Host`.
        let rebound = format!("evil.example:{}", crate::config::port());
        assert_eq!(
            desk_refusal(&caps, &read(&rebound, Some("same-origin")), &none),
            Some("not from this page")
        );
        assert_eq!(
            desk_refusal(&caps, &read(&here, Some("cross-site")), &none),
            Some("not from this page")
        );
    }

    /// A gate helps only if every route is behind it, and a route added later
    /// is exactly the one that will forget. So the file is read: each desk
    /// handler must reach the gate before it reaches the store.
    #[test]
    fn every_desk_route_is_behind_the_gate() {
        // A checkout on Windows can have CRLF line endings, and the end of a
        // handler is found by its newlines.
        let src = include_str!("server.rs").replace("\r\n", "\n");
        let src = src.as_str();
        for handler in [
            "async fn desks(",
            "async fn create_desk(",
            "async fn browse_pick(",
            "async fn rename_desk(",
            "async fn desk_layout(",
            "async fn move_pane(",
            "async fn delete_desk(",
            "async fn reopen_desk(",
            "async fn desk_docs(",
            "async fn remove_desk_doc(",
            "async fn restore_desk_doc(",
            "async fn desk_notes(",
            "async fn add_desk_note(",
            "async fn set_desk_note(",
            "async fn remove_desk_note(",
            "async fn restore_desk_note(",
            "async fn keep_desk_note(",
            "async fn desk_left_off(",
            "async fn visit_desk(",
            "async fn park_desk(",
            "async fn desk_week(",
            "async fn add_note_image(",
            "async fn set_note_images(",
            "async fn note_image(",
            "async fn brief_setting(",
            "async fn set_brief_setting(",
            "async fn open_pane(",
            "async fn close_pane(",
            "async fn restore_pane(",
            "async fn rename_pane(",
            "async fn start_pane(",
            "async fn stop_pane(",
            "async fn paste_image(",
            "async fn connect_claude(",
            "async fn resolve_path(",
        ] {
            let from = src
                .find(handler)
                .unwrap_or_else(|| panic!("{handler} is a route in this file"));
            let body = &src[from..];
            let end = body.find("\n}\n").expect("a handler ends");
            let body = &body[..end];
            let gate = body
                .find("refuse_desk")
                .expect("a desk handler goes through the gate");
            let store = body.find("app.store").unwrap_or(usize::MAX);
            assert!(gate < store, "{handler} reaches the store before the gate");
        }
        // The folder dialog is a page reaching the filesystem, the same as a
        // desk: no dialog is shown to a page that has not passed the gate.
        let pick = &src[src.find("async fn browse_pick(").unwrap()..];
        assert!(
            pick.find("refuse_desk").unwrap() < pick.find("pick_folder").unwrap(),
            "browse_pick shows a dialog before the gate"
        );
        // And the routes themselves: every path a desk is reached by is one of
        // the handlers above.
        for route in [
            r#".route("/api/desks", get(desks).post(create_desk))"#,
            r#".route("/api/browse/pick", post(browse_pick))"#,
            r#".route("/api/resolve", post(resolve_path))"#,
            r#".route("/api/desks/{id}/rename", post(rename_desk))"#,
            r#".route("/api/desks/{id}/layout", post(desk_layout))"#,
            r#".route("/api/desks/{id}/move", post(move_pane))"#,
            r#".route("/api/desks/{id}/delete", post(delete_desk))"#,
            r#".route("/api/desks/{id}/reopen", post(reopen_desk))"#,
            r#".route("/api/desks/{id}/panes", post(open_pane))"#,
            r#".route("/api/desks/{id}/docs", get(desk_docs))"#,
            r#".route("/api/desks/{id}/docs/{doc}/remove", post(remove_desk_doc))"#,
            r#".route("/api/desks/{id}/docs/{doc}/restore", post(restore_desk_doc))"#,
            r#".route("/api/desks/{id}/notes", get(desk_notes).post(add_desk_note))"#,
            r#".route("/api/desks/{id}/notes/{note}", post(set_desk_note))"#,
            r#".route("/api/desks/{id}/notes/{note}/remove", post(remove_desk_note))"#,
            r#".route("/api/desks/{id}/notes/{note}/restore", post(restore_desk_note))"#,
            r#".route("/api/desks/{id}/notes/{note}/keep", post(keep_desk_note))"#,
            r#".route("/api/desks/{id}/leftoff", post(desk_left_off))"#,
            r#".route("/api/desks/{id}/keys", get(desk_keys).post(add_desk_key))"#,
            r#".route("/api/desks/{id}/keys/{name}/remove", post(remove_desk_key))"#,
            r#".route("/api/desks/{id}/visit", post(visit_desk))"#,
            r#".route("/api/desks/{id}/park", post(park_desk))"#,
            r#".route("/api/desks/{id}/week", post(desk_week))"#,
            r#""/api/desks/{id}/notes/{note}/image""#,
            "post(add_note_image)",
            r#".route("/api/desks/{id}/notes/{note}/images", post(set_note_images))"#,
            r#".route("/api/desks/{id}/note-images/{name}", get(note_image))"#,
            r#".route("/api/brief", get(brief_setting).post(set_brief_setting))"#,
            r#".route("/api/panes/{id}/changes", get(pane_changes))"#,
            r#".route("/api/panes/{id}/delete", post(close_pane))"#,
            r#".route("/api/panes/{id}/restore", post(restore_pane))"#,
            r#".route("/api/panes/{id}/rename", post(rename_pane))"#,
            r#".route("/api/panes/{id}/start", post(start_pane))"#,
            r#".route("/api/panes/{id}/stop", post(stop_pane))"#,
            r#""/api/panes/{id}/paste""#,
            "post(paste_image)",
        ] {
            assert!(src.contains(route), "the route table should hold {route}");
        }
        // The one pane route outside the gate, on purpose: the agent's hook
        // holds the token, not the capability. It answers to the token first,
        // and it reaches the store for one thing -- the conversation's id,
        // after the pane is known to be running.
        let agent = &src[src.find("async fn pane_agent(").unwrap()..];
        let agent = &agent[..agent.find("\n}\n").unwrap()];
        assert!(agent.find("authorized(").unwrap() < agent.find("app.panes").unwrap());
        assert!(agent.find("app.panes").unwrap() < agent.find("app.store").unwrap());
        assert_eq!(
            agent.matches("app.store").count(),
            agent.matches("app.store.set_pane_session(").count(),
            "pane_agent reaches the store for more than the session id"
        );
        // And the one that reads: token first, then a running pane, and then
        // the store only to find that pane's desk and read its list -- no
        // write of any kind.
        let notes = &src[src.find("async fn pane_notes(").unwrap()..];
        let notes = &notes[..notes.find("\n}\n").unwrap()];
        assert!(notes.find("authorized(").unwrap() < notes.find("app.panes").unwrap());
        assert!(notes.find("app.panes.is_running(").unwrap() < notes.find("app.store").unwrap());
        assert_eq!(
            notes.matches("app.store").count(),
            notes.matches("app.store.pane(").count()
                + notes.matches("app.store.desk_notes(").count(),
            "pane_notes reaches the store for more than reading one desk's list"
        );
        assert!(src.contains(r#".route("/api/panes/{id}/notes", get(pane_notes))"#));
        // And the one write: token, running pane, then the store only to find
        // the pane's desk and tick one line on it.
        let tick = &src[src.find("async fn pane_tick_note(").unwrap()..];
        let tick = &tick[..tick.find("\n}\n").unwrap()];
        assert!(tick.find("authorized(").unwrap() < tick.find("app.panes").unwrap());
        assert!(tick.find("app.panes.is_running(").unwrap() < tick.find("app.store").unwrap());
        assert_eq!(
            tick.matches("app.store").count(),
            tick.matches("app.store.pane(").count()
                + tick.matches("app.store.tick_desk_note(").count(),
            "pane_tick_note reaches the store for more than ticking one line"
        );
        assert!(
            src.contains(r#".route("/api/panes/{id}/notes/{note}/tick", post(pane_tick_note))"#)
        );
        // And the stage: the same gate, and one line's stage on its own desk.
        let mark = &src[src.find("async fn pane_mark_note(").unwrap()..];
        let mark = &mark[..mark.find("\n}\n").unwrap()];
        assert!(mark.find("authorized(").unwrap() < mark.find("app.panes").unwrap());
        assert!(mark.find("app.panes.is_running(").unwrap() < mark.find("app.store").unwrap());
        assert_eq!(
            mark.matches("app.store").count(),
            mark.matches("app.store.pane(").count()
                + mark.matches("app.store.mark_desk_note(").count(),
            "pane_mark_note reaches the store for more than one line's stage"
        );
        assert!(
            src.contains(r#".route("/api/panes/{id}/notes/{note}/mark", post(pane_mark_note))"#)
        );
        // And naming its panel: token, running pane, then only that pane's name.
        let name = &src[src.find("async fn pane_name(").unwrap()..];
        let name = &name[..name.find("\n}\n").unwrap()];
        assert!(name.find("authorized(").unwrap() < name.find("app.panes").unwrap());
        assert!(name.find("app.panes.is_running(").unwrap() < name.find("app.store").unwrap());
        assert_eq!(
            name.matches("app.store").count(),
            name.matches("app.store.rename_pane(&id,").count(),
            "pane_name reaches the store for more than its own pane's name"
        );
        assert!(src.contains(r#".route("/api/panes/{id}/name", post(pane_name))"#));
    }

    /// The capability is read off the fragment and presented in a frame. If it
    /// ever reaches a URL the page builds, it reaches the daemon's request path
    /// and whatever logs one -- so the page's own source is where that line is
    /// held.
    #[test]
    fn the_page_never_puts_the_capability_in_a_url() {
        assert!(
            APP_JS.contains("/api/desk"),
            "the desk socket should be opened from here"
        );
        for (name, src) in [("app.js", APP_JS), ("desk.js", DESK_JS)] {
            for bad in ["cap=${", "capability=${", "?cap=", "&cap=", "?capability="] {
                assert!(
                    !src.contains(bad),
                    "the capability is in a URL in {name}: {bad}"
                );
            }
        }
    }

    /// The desk view is the second chunk, and its bargain is the diagram
    /// driver's: one import, made when a desk is opened -- and only past the
    /// point where a tab has been given its sentence and sent away, so a page
    /// with no capability never fetches the code that paints a pane.
    #[test]
    fn the_page_asks_for_the_desk_view_only_in_a_window_opening_a_desk() {
        assert_eq!(APP_JS.matches("import(`/assets/desk.js").count(), 1);
        let import = APP_JS.find("import(`/assets/desk.js").unwrap();
        let sentence = APP_JS
            .find("This is a browser tab, and a browser tab cannot start one")
            .expect("a tab is told why there is no desk");
        let refusal = APP_JS[..sentence]
            .rfind("if (!capability)")
            .expect("the sentence is what a page without the capability gets");
        assert!(refusal < import, "the import sits past the tab's refusal");
        assert!(sentence < import);
        for seam in [
            "export function open(",
            "export function update(",
            "export function close(",
        ] {
            assert!(DESK_JS.contains(seam), "desk.js should export `{seam}`");
        }
    }

    /// The game is the fourth chunk, and the smallest bargain of them: one
    /// import, in the rocket's click handler and nowhere else, so a page
    /// whose rocket is never pressed never fetches a game.
    #[test]
    fn the_page_asks_for_the_game_only_when_the_rocket_is_pressed() {
        assert_eq!(APP_JS.matches("import(`/assets/game.js").count(), 1);
        let import = APP_JS.find("import(`/assets/game.js").unwrap();
        let press = APP_JS
            .find(r##"$("#btn-game")"##)
            .expect("the rocket is the button the game is behind");
        assert!(press < import, "the import sits inside the rocket's press");
        for seam in [
            "export function open(",
            "export function close(",
            "export function isOpen(",
        ] {
            assert!(GAME_JS.contains(seam), "game.js should export `{seam}`");
        }
    }

    /// The fifth chunk, and the one the budget was over by: the about panel
    /// and the reset dialog. Two buttons, one import, and a page that opens
    /// neither never fetches either. `bench/bytes.mjs` is what noticed they
    /// were being carried by every first paint.
    #[test]
    fn the_page_asks_for_the_panels_only_when_one_is_opened() {
        assert_eq!(APP_JS.matches("import(`/assets/about.js").count(), 1);
        // Since 1.8 the two buttons are in the shortcuts card, which the
        // chunk builds and wires when it first opens: the page has neither.
        for button in [r##"on("#btn-about""##, r##"on("#btn-reset""##] {
            assert!(
                ABOUT_JS.contains(button),
                "{button} is wired where the card is built"
            );
        }
        for button in [r##"$("#btn-about")"##, r##"$("#btn-reset")"##] {
            assert!(
                !APP_JS.contains(button),
                "{button} belongs to the chunk now"
            );
        }
        assert!(
            ABOUT_JS.contains("export function open("),
            "about.js should export `open`"
        );
        // The panels themselves must not have stayed behind in the page.
        for gone in ["/api/about", "#about-facts", "#reset-go"] {
            assert!(
                !APP_JS.contains(gone),
                "`{gone}` belongs to the chunk now, not to app.js"
            );
        }
    }

    /// The driver is a chunk, and the page's half of that bargain is that it
    /// asks for the chunk only when a document actually holds a diagram. An
    /// import that escaped that check would be eager again -- 11.6 KB gzipped
    /// back on every page load, for a feature most documents do not use, and
    /// nothing would say so but `bench/bytes.mjs` on the next push.
    #[test]
    fn the_page_asks_for_the_diagram_driver_only_when_a_document_holds_one() {
        assert_eq!(
            APP_JS.matches("import(`/assets/mmd.js").count(),
            1,
            "one import, so there is one place the laziness can be lost"
        );
        assert!(
            APP_JS.contains(r#"if (docEl.querySelector("pre.mermaid")) mmdLoad()"#),
            "the import should sit behind the check for a diagram in this document"
        );
        // The machinery itself must not have found its way back into the page.
        for gone in [
            "mermaid.run",
            "mermaidLib",
            "mmdRender",
            "mmdReserve",
            "mmdDrain",
            "mmdQueue",
        ] {
            assert!(!APP_JS.contains(gone), "`{gone}` is back in app.js");
        }
        // And the module is what holds it, behind the four names the page knows.
        for kept in [
            "export function prepare(",
            "export function retheme(",
            "export function escape(",
            "export function key(",
        ] {
            assert!(MMD_JS.contains(kept), "mmd.js should export `{kept}`");
        }
    }

    /// The dev loop's whole promise is that the file on disk is the one being
    /// served, and its whole safety is that a daemon without `SNYVI_UI_DIR`
    /// cannot be made to read one. Both halves, plus the fallback that keeps a
    /// page rendering while an editor has the file renamed out from under it.
    #[test]
    fn a_live_ui_serves_the_file_on_disk_and_a_shipped_one_cannot() {
        let dir = std::env::temp_dir().join(format!("snyvi-ui-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let css = dir.join("app.css");
        std::fs::write(&css, "body { --probe: 1 }").unwrap();

        let live = Ui {
            dir: Some(dir.clone()),
        };
        assert_eq!(live.text("app.css", APP_CSS), "body { --probe: 1 }");
        assert!(live.live());
        // A different file on disk is a different bundle, which is what makes
        // an open page reload without the daemon restarting.
        let before = live.version("shipped");
        std::fs::write(&css, "body { --probe: 2 }").unwrap();
        assert_ne!(live.version("shipped"), before);
        // Gone mid-edit: the compiled-in copy, not an empty stylesheet.
        std::fs::remove_file(&css).unwrap();
        assert_eq!(live.text("app.css", APP_CSS), APP_CSS);

        let shipped = Ui { dir: None };
        assert!(!shipped.live());
        assert_eq!(shipped.text("app.css", APP_CSS), APP_CSS);
        assert_eq!(shipped.version("shipped"), "shipped");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `$("#btn-wrap").addEventListener` on an element that is not in the page throws on
    /// boot and takes the whole UI with it, so every id the script uses without checking
    /// first must exist in the markup. A guarded `const x = $("#id"); if (x)` is fine.
    ///
    /// Every chunk and not only `app.js`: the panels, the find bar and the game
    /// were moved out of the first paint, and an id one of them reaches for is
    /// no longer caught at boot -- it throws when the chunk loads, which is
    /// later, and in front of someone.
    #[test]
    fn every_id_the_script_uses_unguarded_is_in_the_page() {
        let mut missing = Vec::new();
        for (file, src) in [
            ("app.js", APP_JS),
            ("desk.js", DESK_JS),
            ("frame.js", FRAME_JS),
            ("game.js", GAME_JS),
            ("about.js", ABOUT_JS),
            ("find.js", FIND_JS),
            ("keys.js", KEYS_JS),
            ("menu.js", MENU_JS),
            ("palette.js", PALETTE_JS),
            ("look.js", LOOK_JS),
            ("note.js", NOTE_JS),
            ("tip.js", TIP_JS),
            ("home.js", HOME_JS),
            ("toast.js", TOAST_JS),
            ("diff.js", DIFF_JS),
            ("browse.js", BROWSE_JS),
            ("paths.js", PATHS_JS),
        ] {
            for (i, _) in src.match_indices("$(\"#") {
                let rest = &src[i + 4..];
                let end = rest.find('"').expect("unterminated selector");
                let id = &rest[..end];
                let used_at_once = rest[end..].starts_with("\").");
                // Or in the chunk itself: about.js builds the boxes it fills.
                let built = format!("id=\"{id}\"");
                if used_at_once && !INDEX_HTML.contains(&built) && !src.contains(&built) {
                    missing.push(format!("{file}: {id}"));
                }
            }
        }
        assert!(missing.is_empty(), "not in index.html: {missing:?}");
    }

    /// The page asks for every chunk as `/assets/x.js?v=`, and they are served
    /// immutable for a year -- so a chunk left out of the hash that makes `?v=`
    /// is a chunk a browser keeps across the change that was meant to replace
    /// it. `Ui::version` lists them for a live directory; this is the hash that
    /// ships, and `about.js` and `find.js` were once added to the first and not
    /// the second. Held together here so the next chunk cannot be half-added.
    #[test]
    fn the_hash_behind_the_version_covers_every_chunk_the_page_can_fetch() {
        let src = include_str!("server.rs");
        let from = src.find("let asset_v = {").expect("the startup hash");
        let to = from + src[from..].find("\n    };").expect("the end of it");
        let block = &src[from..to];
        for chunk in [
            "INDEX_HTML",
            "APP_CSS",
            "APP_JS",
            "DESK_JS",
            "FRAME_JS",
            "GAME_JS",
            "ABOUT_JS",
            "FIND_JS",
            "KEYS_JS",
            "MENU_JS",
            "THEMES_CSS",
            "PALETTE_JS",
            "LOOK_JS",
            "NOTE_JS",
            "TIP_JS",
            "HOME_JS",
            "TOAST_JS",
            "DIFF_JS",
            "BROWSE_JS",
            "PATHS_JS",
        ] {
            assert!(
                block.contains(chunk),
                "{chunk} is served immutable under ?v= but is not in the hash that makes it"
            );
        }
    }

    /// A name is drawn on one line in the tree, and it arrives from a field a paste can
    /// fill with anything.
    #[test]
    fn a_name_is_cleaned_before_it_is_stored() {
        use super::clean_name;
        assert_eq!(clean_name("  Auth work  ").unwrap(), "Auth work");
        assert_eq!(clean_name("Auth\n\twork").unwrap(), "Auth work");
        assert_eq!(clean_name("Auth   work").unwrap(), "Auth work");
        assert!(clean_name("").is_none());
        assert!(clean_name("   \n ").is_none(), "whitespace is not a name");
        // Counted in characters, so a multi-byte name is not cut mid-character.
        let long = "é".repeat(400);
        assert_eq!(clean_name(&long).unwrap().chars().count(), 120);
    }

    /// The pre-paint script and the app must agree on the keys, or a saved setting is
    /// written by one and never read by the other. The app's half is app.js, or
    /// look.js for the theme and font, which it fetches once the page is idle. The
    /// three theme keys are spelled out in full: this is a substring check, and
    /// `snyvi.theme` would go on passing on the strength of `snyvi.theme.light` alone.
    #[test]
    fn settings_written_by_the_app_are_applied_before_first_paint() {
        for key in [
            "theme.light",
            "theme.dark",
            "theme.follow",
            "font",
            "side",
            "wide",
            "wrap",
        ] {
            let k = format!("snyvi.{key}");
            assert!(
                APP_JS.contains(&k) || LOOK_JS.contains(&k),
                "{k} is not used by app.js or look.js"
            );
            assert!(BOOT_JS.contains(&k), "{k} is not applied by boot.js");
        }
    }
}
