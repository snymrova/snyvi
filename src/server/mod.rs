//! The local HTTP server: UI shell, JSON API, SSE, and the receive endpoint.
//!
//! One file per concern, each with `use super::*`: `auth` (the three leaves and
//! the host gate), `assets` (what the browser loads), `api_docs` (the library),
//! `api_desk` (the page's side of a desk), `api_agent` (the agent's side), `ws`
//! (the desk socket), `events` (SSE), `api_browse` (folders read from disk),
//! `lifecycle` (restart, update, reset), `api_peer` (a friend's snyvi) and
//! `peer_link` (the socket that waits at the relay for a friend's frame).
//! This file holds what they share: the `App`, the router, `run`, and the
//! one way a document is told to every page.

mod api_agent;
mod api_browse;
mod api_desk;
mod api_docs;
mod api_peer;
mod api_thread;
mod api_widget;
mod assets;
mod auth;
mod events;
mod lifecycle;
mod peer_link;
#[cfg(test)]
mod tests;
mod widget_run;
mod ws;

use api_agent::*;
use api_browse::*;
use api_desk::*;
use api_docs::*;
use api_peer::*;
use api_thread::*;
use api_widget::*;
use assets::*;
use auth::*;
use events::*;
use lifecycle::*;
pub use lifecycle::{relaunch, Leaving};
use peer_link::*;
use ws::*;

use crate::browse::Browser;
use crate::capability::constant_eq;
use crate::config::{self, Paths};
use crate::platform;
use crate::receive::{self, Payload};
use crate::render::{self, Renderer};
use crate::store::{Doc, Store};
pub use crate::version::{BUILD_SHA, BUILD_TARGET, VERSION};
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
    /// The window secret: made beside the token on first run and read by the
    /// CLI from the daemon's own files. The leave to stop, restart and update
    /// the daemon and to mint a window's capability -- never the token, so
    /// an agent holding the token sends and nothing more. See `windowed`.
    pub window: String,
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
    /// Held while a `doc` event's count is taken and the event sent
    /// (`emit_doc`), so the counts go out in the order they were taken.
    doc_said: std::sync::Mutex<()>,
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
    /// Friends: the daemon's own keys once read, the pairings under way, and
    /// the link's wake-up. See `api_peer`, `peer_link` and `crate::peer`.
    pub peers: api_peer::Peers,
}

/// The daemon's own executable, stamped at start.
#[derive(Clone, Debug)]
pub struct Exe {
    pub path: PathBuf,
    pub(crate) stamp: (u64, u64, u64, u64),
}

impl Exe {
    pub(crate) fn here() -> Option<Exe> {
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

/// Everything the handlers share, built once from the store and the two
/// secrets. `run` calls this with the updater it made for the binary on
/// disk; the router test calls it with none, which is how every route is
/// exercised against a real `App` and a real store without a port.
fn new_app(
    paths: &Paths,
    store: Store,
    token: String,
    window: String,
    update: Option<Arc<crate::update::Updater>>,
    exe: Option<Exe>,
) -> Arc<App> {
    let renderer = Renderer::new();
    // Room for a burst: a desk's four panels changing state while a batch of
    // documents lands. A stream that still falls behind is sent one `resync`
    // (`events`) rather than losing what it missed.
    let (tx, _) = broadcast::channel(256);
    let (stop_tx, _) = broadcast::channel::<()>(1);
    // The Mermaid bundle is in the hash as well. It is served immutable for a
    // year like every other asset, and its URL had no version in it -- so a
    // browser that had cached one snyvi's bundle would have kept it across
    // every upgrade, which is exactly what a trimmed bundle would need to
    // replace. Hashing a megabyte once at startup costs under a millisecond.
    let asset_v = {
        let mut h = blake3::Hasher::new();
        h.update(INDEX_HTML.as_bytes());
        for (_, built_in, _) in ASSETS {
            h.update(built_in.as_bytes());
        }
        h.update(VERSION.as_bytes());
        h.update(MERMAID_JS_GZ);
        h.finalize().to_hex()[..8].to_string()
    };
    let panes = crate::pane::Panes::new(&paths.data_dir, tx.clone());
    Arc::new(App {
        store,
        renderer,
        browse: Browser::load(paths.config_dir.join("folders.json")),
        paths: paths.clone(),
        secrets: crate::secrets::Secrets::new(paths.config_dir.join("keys.json")),
        token: std::sync::RwLock::new(token),
        window,
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
        doc_said: std::sync::Mutex::new(()),
        leaving: std::sync::Mutex::new(Leaving::Stopped),
        update,
        relaunch_window: std::sync::atomic::AtomicBool::new(false),
        restarting: std::sync::atomic::AtomicBool::new(false),
        update_sent: Default::default(),
        quota: Default::default(),
        peers: Default::default(),
    })
}

/// A friend's snyvi, `/api/peers/*` and Send to… (`api_peer`, docs/PEER.md):
/// pairing, the friends, their lines, an agent's offers. Their own function
/// for the same reason as `pane_routes`; the route table counts these too.
fn peer_routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/peers", get(peers_list))
        .route("/api/peers/pair", post(pair_start))
        .route("/api/peers/join", post(pair_join))
        .route("/api/peers/pair/{code}", get(pair_state))
        .route("/api/peers/{id}/rename", post(peer_rename))
        .route("/api/peers/{id}/mute", post(peer_mute))
        .route("/api/peers/{id}/remove", post(peer_remove))
        .route("/api/peers/{id}/restore", post(peer_restore))
        .route("/api/peers/{id}/note", post(peer_note))
        .route("/api/peers/notes/{id}", post(peer_note_settle))
        .route("/api/peers/offers/{id}", post(offer_answer))
        .route("/api/docs/{id}/send", post(doc_send))
        .route("/api/peers/{id}/desk", post(peer_desk))
        .route("/api/docs/{id}/keep", post(doc_keep))
        .route("/api/docs/{id}/save", post(doc_save))
        .route("/api/docs/{id}/unfile", post(doc_unfile))
        .route("/api/peers/outbox/{id}/retry", post(outbox_retry))
        .route("/api/docs/{id}/reply", post(doc_reply))
        .route("/api/peers/{id}/receipts", post(peer_receipts))
        .route("/api/desks/{desk}/notes/{note}/tell", post(note_tell))
}

/// A panel's routes, `/api/panes/{id}/*`: the page's (close, restore,
/// rename, start, stop, a pasted picture) and the agent's in it, behind the
/// token (`api_agent`). Their own function so `router` stays one screen; the
/// route table in `tests` counts both.
fn pane_routes() -> Router<Arc<App>> {
    Router::new()
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
        .route("/api/panes/{id}/keys/{name}", get(pane_key))
        .route("/api/panes/{id}/leftoff", post(pane_left_off))
        .route("/api/panes/{id}/suggest", post(pane_suggest_note))
        .route("/api/panes/{id}/offer", post(pane_offer))
        .route(
            "/api/panes/{id}/paste",
            post(paste_image).layer(axum::extract::DefaultBodyLimit::max(receive::MAX_BYTES)),
        )
}

/// The sidebars' layout and their widgets (`api_widget`).
fn widget_routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/layout", post(set_layout))
        .route("/api/desks/{id}/widgets", get(desk_widgets))
        .route("/api/panes/{id}/widget", post(pane_set_widget))
        .route("/api/widgets", get(list_widgets).post(set_widget))
        .route("/sidebars", get(shell_sidebars))
        .route("/api/widgets/{name}/allow", post(allow_widget))
        .route("/api/widgets/{name}/prefs", post(widget_prefs))
        .route("/api/panes/{id}/propose-widget", post(pane_propose_widget))
}

/// Threads, Your turn and suggested panels (`api_thread`): the agent's and
/// the mod's on the panel, behind the token, and the page's on the desk.
fn thread_routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/panes/{id}/thread", post(pane_start_thread))
        .route("/api/panes/{id}/thread/move", post(pane_move_thread))
        .route("/api/panes/{id}/ask", post(pane_ask))
        .route("/api/panes/{id}/handover", post(pane_hand_over))
        .route("/api/panes/{id}/suggest-panel", post(pane_suggest_panel))
        .route("/api/panes/{id}/suggest-desk", post(pane_suggest_desk))
        .route("/api/panes/{id}/seen", post(pane_seen))
        .route("/api/panes/{id}/band", get(pane_band))
        .route(
            "/api/panes/{id}/turns/{turn}",
            get(pane_wait_turn).post(pane_answer_turn),
        )
        .route("/api/panes/{id}/note", post(pane_note))
        .route("/api/claude-mod", get(mod_setting).post(set_mod_setting))
        .route("/api/desks/{id}/threads", get(desk_threads))
        .route("/api/desks/{id}/threads/{row}/move", post(desk_move_thread))
        .route("/api/desks/{id}/threads/{row}/{act}", post(desk_thread_act))
        .route("/api/desks/{id}/turns/{row}/answer", post(desk_answer_turn))
        .route("/api/desks/{id}/turns/{row}/{act}", post(desk_turn_act))
        .route(
            "/api/desks/{id}/suggestions/{row}/{act}",
            post(desk_suggestion_act),
        )
}

/// Every route -- a panel's merged in from `pane_routes` -- and the one layer
/// in front of them all.
///
/// The test `every_route_answers_to_its_gate_and_to_this_host_only` sends a
/// request to each of these; a route added here and not there fails it on
/// the count, which is the point.
/// The receive endpoint, taking up to what `receive` takes with room for
/// the fields around the content: a send over axum's 2 MB default reaches
/// it, and one over the cap is refused with its real size, not a bare 413.
fn receive_route() -> axum::routing::MethodRouter<Arc<App>> {
    post(receive_doc).layer(axum::extract::DefaultBodyLimit::max(
        receive::MAX_BYTES + 64 * 1024,
    ))
}

fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/", get(shell_home))
        .route("/inbox", get(shell_inbox))
        .route("/api/home", get(home))
        .route("/connect", get(shell_connect))
        .route("/start", get(shell_start))
        .route("/welcome", get(shell_welcome))
        .route("/d/{id}", get(shell_doc))
        .route("/b/{id}", get(shell_browse))
        .route("/b/{id}/{*path}", get(shell_browse_file))
        .route("/files/{id}/{*path}", get(doc_file))
        .route("/assets/mermaid.js", get(asset_mermaid))
        .route("/assets/{name}", get(asset_named))
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
        .route("/api/docs", receive_route())
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
        .route("/api/reveal", post(reveal))
        .route("/api/resolve", post(resolve_path))
        .route("/api/browse", get(browse_list).post(browse_open))
        .route("/api/browse/pick", post(browse_pick))
        .route("/api/browse/pick/cancel", post(browse_pick_cancel))
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
        .route("/api/desks/order", post(order_desks))
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
        .route("/api/desks/{id}/git", get(desk_git))
        .route("/api/desks/{id}/park", post(park_desk))
        .route("/api/desks/{id}/week", post(desk_week))
        .route(
            "/api/desks/{id}/notes/{note}/image",
            post(add_note_image).layer(axum::extract::DefaultBodyLimit::max(NOTE_IMAGE_BYTES)),
        )
        .route("/api/desks/{id}/notes/{note}/images", post(set_note_images))
        .route("/api/desks/{id}/note-images/{name}", get(note_image))
        .route("/api/brief", get(brief_setting).post(set_brief_setting))
        .route("/api/asides", get(asides_setting).post(set_asides_setting))
        // Friends (`api_peer`): the reader's actions from this page or with
        // the token, the reads open like the project list is.
        .merge(pane_routes())
        .merge(thread_routes())
        .merge(widget_routes())
        .merge(peer_routes())
        .route("/desks", get(shell_desk_list))
        .route("/desk/{id}", get(shell_desk))
        .fallback(not_found)
        // After every route and the fallback: nothing is served to a request
        // from another host, and the table test in `tests` holds that.
        .layer(axum::middleware::from_fn(host_gate))
        .with_state(app)
}

/// Every panel of a desk shares one socket, and its frames are already paced
/// to one per 16 ms: Nagle buys nothing there, and held a key's echo behind
/// the page's delayed ACK -- 40 ms -- whenever another panel was busy.
fn nodelay(
    listener: tokio::net::TcpListener,
) -> axum::serve::TapIo<tokio::net::TcpListener, fn(&mut tokio::net::TcpStream)> {
    use axum::serve::ListenerExt;
    listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    })
}

/// What ends the daemon: Ctrl-C, SIGTERM (how systemd and a logout ask), or
/// `snyvi stop`. Out of `run` so that stays one screen.
async fn asked_to_stop(mut stop_rx: broadcast::Receiver<()>, told: broadcast::Sender<()>) {
    let term = async {
        #[cfg(unix)]
        {
            let mut sig = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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
}

pub async fn run(paths: Paths) -> anyhow::Result<Leaving> {
    let token = config::load_or_create_token(&paths)?;
    let window = config::load_or_create_window_secret(&paths)?;
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
    let exe = Exe::here();
    let update = exe.as_ref().map(|e| {
        Arc::new(crate::update::Updater::new(
            &paths,
            &e.path,
            Box::new(crate::update::Http),
        ))
    });
    let app = new_app(&paths, store, token, window, update, exe);
    let stop_rx = app.shutdown.subscribe();
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
    // Widget files' commands, while their widgets are in view.
    widget_run::spawn(app.clone());
    crate::claude_mod::start(&paths);
    let router = router(app);

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
    // The link to the relay, for as long as there is a friend: what they
    // send arrives as it lands, page open or not.
    spawn_peer_link(leaving.clone());
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
    axum::serve(nodelay(listener), router)
        .with_graceful_shutdown(asked_to_stop(stop_rx, told))
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

pub(crate) fn emit(app: &App, name: &str, data: serde_json::Value) {
    let _ = app.events.send(format!("{name}\n{data}"));
}

/// A `doc` event, with the count of what is waiting taken as it is sent.
/// Twelve sends at once used to take their counts before building the
/// project's rows and send after: an event counted at 11 could go out after
/// the one counted at 12, and a page that believes the newest event read
/// "1/11" with twelve waiting. Count and send under one lock, and the last
/// event out carries the last count.
pub(crate) fn emit_doc(app: &App, mut ev: serde_json::Value) {
    let _held = app.doc_said.lock().unwrap_or_else(|e| e.into_inner());
    ev["waiting"] = json!(waiting(app));
    emit(app, "doc", ev);
}

/// The `doc` event every arrival ends in, shaped one way for the three
/// routes a document comes in by.
///
/// It carries the one project that moved, as the tree lists it (`project`)
/// and as expanding it would (`rows`, the default caps), so a page patches
/// that project and redraws once rather than fetching the whole tree and the
/// project's rows back on every save of a file an agent is editing.
///
/// Built where the receive ran, off the executor: the project's row and its
/// rows are store reads, and every save pays them. Left out when no page is
/// open to patch its sidebar with them -- a page that misses them refetches.
pub(crate) fn doc_event(app: &App, received: &receive::Received) -> serde_json::Value {
    let doc = &received.doc;
    let mut ev = json!({ "doc": doc, "url": format!("{}/d/{}", config::base_url(), doc.id), "existing": received.existing, "supersedes": received.supersedes, "waiting": waiting(app) });
    if app.pages.load(Ordering::Relaxed) > 0 {
        ev["project"] = json!(app.store.project_row(doc.project_id).ok().flatten());
        ev["rows"] = json!(project_rows(
            app,
            doc.project_id,
            TREE_WORKFLOWS,
            TREE_DOCS,
            None
        ));
    }
    ev
}

/// A document in, the plain way: rendered and stored off the executor, then
/// told to every page. A send has more to do around it (`receive_doc`); a
/// pasted picture and a week's page have not, and come through here. The
/// refusal is the response the caller returns, boxed: a `Response` is a
/// large thing to carry in every `Ok`, and clippy says so.
async fn receive_and_emit(
    app: &Arc<App>,
    payload: Payload,
) -> Result<receive::Received, Box<Response>> {
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || {
        receive::receive(&app2.store, &app2.renderer, payload).map(|r| (doc_event(&app2, &r), r))
    })
    .await
    {
        Ok(Ok((event, received))) => {
            emit_doc(app, event);
            Ok(received)
        }
        Ok(Err(e)) => Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response(),
        )),
        Err(e) => Err(Box::new(err(anyhow::anyhow!(e)))),
    }
}

fn err(e: anyhow::Error) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}
