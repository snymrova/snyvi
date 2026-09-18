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
const APP_CSS: &str = include_str!("../ui/app.css");
const APP_JS: &str = include_str!("../ui/app.js");
const BOOT_JS: &str = include_str!("../ui/boot.js");
/// The diagram driver, imported by app.js with the first diagram and never on a
/// page without one. A module, so it is fetched rather than linked.
const MMD_JS: &str = include_str!("../ui/mmd.js");
/// Mermaid, gzip-compressed at build time; served with Content-Encoding: gzip.
const MERMAID_JS_GZ: &[u8] = include_bytes!("../ui/mermaid.min.js.gz");
/// Content-Security-Policy for the UI. Everything comes from the daemon itself; Mermaid
/// needs inline styles for the SVG it produces, and images may be data URIs.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
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
];

/// Where the UI is read from.
///
/// The shipped daemon serves the five text assets `include_str!` compiled into
/// it, which is why a stylesheet change costs a rebuild: the bytes are in the
/// binary. `SNYVI_UI_DIR` points at a working tree's `ui/` instead, and every
/// request reads the file off disk. That is the whole dev loop -- a saved
/// stylesheet becomes a reload, and with the watcher below, not even that.
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

    /// What the five assets hash to right now. The page carries this as
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
    /// Which agents are here now, and how many of each: the MCP server holds
    /// an event stream under its client's name from `initialize` until its
    /// process ends, so this is exactly as live as the agent is, the way the
    /// window count is. Before it, the daemon heard of an agent only when one
    /// sent, and the page could say "last sent 12 minutes ago" of a session
    /// that had been closed for eleven.
    pub online: std::sync::Mutex<std::collections::BTreeMap<String, usize>>,
    /// The capabilities minted for windows this daemon has launched. In memory
    /// and nowhere else: a capability that outlived the daemon would be a
    /// secret on disk, which is the one thing it must never be.
    pub capabilities: crate::capability::Capabilities,
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

pub async fn run(paths: Paths) -> anyhow::Result<()> {
    let token = config::load_or_create_token(&paths)?;
    let store = Store::open(&paths)?;
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
        h.update(VERSION.as_bytes());
        h.update(MERMAID_JS_GZ);
        h.finalize().to_hex()[..8].to_string()
    };
    let app = Arc::new(App {
        store,
        renderer,
        browse: Browser::new(),
        paths: paths.clone(),
        token: std::sync::RwLock::new(token),
        events: tx,
        shutdown: stop_tx,
        started: Instant::now(),
        built_v: asset_v,
        ui: Ui::from_env(),
        last_focus: std::sync::Mutex::new(Instant::now() - std::time::Duration::from_secs(60)),
        windows: AtomicUsize::new(0),
        streams: AtomicUsize::new(0),
        online: std::sync::Mutex::new(Default::default()),
        capabilities: Default::default(),
    });
    crate::watch::spawn_browse_watcher(app.clone());
    crate::watch::spawn_ui_watcher(app.clone());

    let router = Router::new()
        .route("/", get(shell_home))
        .route("/connect", get(shell_connect))
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
        .route("/api/docs/{id}/delete", post(delete_doc))
        .route("/api/docs/{id}/undelete", post(undelete_doc))
        .route("/api/docs/{id}/history", get(history))
        .route("/api/projects/{id}/rename", post(rename_project))
        .route("/api/workflows/{id}/rename", post(rename_workflow))
        .route("/api/docs/{id}/split", get(doc_split))
        .route("/api/docs/{id}/outline", get(doc_outline))
        .route("/api/focus", post(focus))
        .route("/api/shutdown", post(shutdown))
        .route("/api/reset", get(reset_census).post(reset))
        .route("/api/terminal", post(terminal))
        .route("/api/browse", get(browse_list).post(browse_open))
        .route("/api/browse/{id}/close", post(browse_close))
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
        .with_state(app);

    let addr = format!("127.0.0.1:{}", config::port());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
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
        })
        .await?;
    Ok(())
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
        body
    )
}

async fn shell_home(State(app): S) -> Response {
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
    shell(&app, boot, "", "Connect an agent · snyvi")
}

async fn shell_doc(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return (StatusCode::NOT_FOUND, Html("<h1>Not found</h1>")).into_response();
    };
    let body = app.store.html(&id).unwrap_or_default();
    let tree = app.store.projects().unwrap_or_default();
    let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
    let title = doc.title.clone();
    let folder = doc_folder(&app, &doc);
    // The project this document is in is the one the sidebar opens on, so it
    // arrives with the page rather than a moment after it.
    let sub = subtree(&app, doc.project_id, Some(doc.workflow_id));
    let boot = json!({ "view": "doc", "tree": tree, "sub": sub, "doc": doc, "previous": previous, "folder": folder, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, &doc_html(&doc, &body), &title)
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
        "docs": app.store.count().unwrap_or(0),
        // Whether a link should be handed to a window or opened in a browser.
        // `snyvi open`, `snyvi browse` and the MCP server all ask here.
        "window": app.has_window(),
        "streams": app.streams.load(Ordering::Relaxed),
        // Which agents hold a stream right now, by the name each gave.
        "agents": app.online(),
        // The bundle this daemon serves, so a page that reconnects after an
        // upgrade can tell it is running another one's and reload.
        "v": app.asset_v(),
        "languages": app.renderer.languages().len(),
        "uptime_s": app.started.elapsed().as_secs(),
    }))
}

/// The about panel: what this is, which build is answering, where its
/// files are, and what Claude Code has of it. The version comes from here
/// and not from the page's bundle, so the panel cannot name a number
/// `snyvi --version` would not.
async fn about(State(app): S) -> Json<serde_json::Value> {
    let exe = std::env::current_exe().ok();
    Json(json!({
        "name": "snyvi",
        "description": env!("CARGO_PKG_DESCRIPTION"),
        "version": VERSION,
        "commit": BUILD_SHA,
        "target": BUILD_TARGET,
        "binary": exe.as_deref().map(|p| p.display().to_string()),
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
    }))
}

/// The connect page's rows: every agent and what its own file says it has
/// of snyvi, read now, whether it is here now, and when each last sent
/// something. `program` is how this binary is spelled to them, for the page
/// to show in its commands.
async fn agents(State(app): S) -> Response {
    Json(agents_json(&app)).into_response()
}

fn agents_json(app: &App) -> serde_json::Value {
    let senders = app.store.senders().unwrap_or_default();
    let online = app.online.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({
        "program": crate::setup::program().0,
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
            // A stored page or PDF is framed from its own bytes. Only the one file was
            // snapshotted, so unlike browse mode there are no sibling assets to load.
            let preview = doc
                .source_path
                .as_deref()
                .map(render::ext_of)
                .and_then(|e| render::preview_kind(&e));
            Json(json!({
                "doc": doc,
                "html": doc_html(&doc, &body),
                "previous": previous,
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
/// `<img>` gets its picture; the content type comes from the source file's name so
/// the browser knows what it is.
async fn doc_blob(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = app.store.source_bytes(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = doc
        .source_path
        .as_deref()
        .map(|p| mime_guess::from_path(p).first_or_octet_stream().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    // Documents are immutable, so the bytes behind an id never change.
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000"),
    );
    protect(
        &mut headers,
        &doc.source_path
            .as_deref()
            .map(render::ext_of)
            .unwrap_or_default(),
    );
    (headers, bytes).into_response()
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
    let Ok(src) = app.store.source(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let app2 = app.clone();
    match tokio::task::spawn_blocking(move || app2.renderer.outline(doc.lang.as_deref(), &src))
        .await
    {
        Ok(items) => Json(items).into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
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
    match app.store.delete(&id) {
        Ok(true) => {
            emit(
                &app,
                "deleted",
                json!({ "id": id, "waiting": waiting(&app) }),
            );
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
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
}

/// Back to a fresh install: every document and version, the index, the token,
/// and -- by the event this ends with -- the preferences every open page keeps.
/// The daemon stays up and the agents stay registered, so the next send lands
/// in an empty library. The one action here that cannot be undone, and the one
/// that asks for a number rather than a click.
///
/// A same-origin POST is accepted beside the token, as `terminal` explains:
/// the page has no token, and the dialog is the page's.
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
                "error": format!("the library has changed: {} document(s) now, not {}; look again", census.documents, b.documents),
                "census": census,
            })),
        )
            .into_response();
    }
    if census.pinned > 0 && !b.pinned {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": format!("{} pinned document(s) would go with it; say so", census.pinned),
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
    for root in app.browse.list() {
        app.browse.close(&root.id);
    }
    let _ = std::fs::remove_file(app.paths.config_dir.join("sessions.json"));
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
    fn new(app: Arc<App>, window: bool, agent: Option<String>) -> StreamMark {
        app.streams.fetch_add(1, Ordering::Relaxed);
        if window {
            app.windows.fetch_add(1, Ordering::Relaxed);
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
        if self.window {
            self.app.windows.fetch_sub(1, Ordering::Relaxed);
        }
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
    let mark = StreamMark::new(app.clone(), q.is_window(), q.agent());
    let stream = BroadcastStream::new(rx)
        .filter_map(move |m| {
            // Captured so that the mark lives exactly as long as the stream does.
            let _keep = &mark;
            m.ok().map(|msg| {
                let (name, data) = msg.split_once('\n').unwrap_or(("doc", msg.as_str()));
                Some(Ok(Event::default().event(name).data(data)))
            })
        })
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
            Json(json!({ "ok": true, "n": ids.len() })).into_response()
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
    let result =
        tokio::task::spawn_blocking(move || receive::receive(&app2.store, &app2.renderer, payload))
            .await;
    match result {
        Ok(Ok(received)) => {
            let doc = received.doc;
            let url = format!("{}/d/{}", config::base_url(), doc.id);
            emit(
                &app,
                "doc",
                json!({ "doc": doc, "url": url, "existing": received.existing, "waiting": waiting(&app) }),
            );
            if !received.existing {
                notify_desktop(&app, &doc);
            }
            if received.needs_full_highlight {
                spawn_full_highlight(app.clone(), doc.id.clone(), doc.lang.clone());
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

/// Large code files are stored partly plain for an instant first view; finish the
/// highlight off the request path and tell open tabs to refetch.
fn spawn_full_highlight(app: Arc<App>, id: String, lang: Option<String>) {
    tokio::task::spawn_blocking(move || {
        let Ok(src) = app.store.source(&id) else {
            return;
        };
        let html = app.renderer.render_code_uncapped(lang.as_deref(), &src);
        if app.store.replace_html(&id, &html).is_ok() {
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

/// The first frame on a desk socket, and the only one this phase reads.
#[derive(Deserialize)]
struct Hello {
    capability: String,
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
    // Held open, and silent. The page needs to tell "allowed, and waiting" from
    // "refused", and those are the two answers there are to give yet.
    while let Some(Ok(msg)) = socket.recv().await {
        if matches!(msg, Message::Close(_)) {
            break;
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

/// Open the machine's own terminal, in the directory the reader is looking at.
///
/// The only thing this takes from the caller is an id snyvi already holds; the
/// directory is looked up here, no command is passed, and nothing comes back.
/// `docs/TERMINAL.md` has the argument, and section 3 of it has what is
/// deliberately absent.
async fn terminal(State(app): S, headers: HeaderMap, Json(b): Json<TerminalBody>) -> Response {
    if !from_this_page(&headers) && !authorized(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page, and no token" })),
        )
            .into_response();
    }
    let dir = if let Some(id) = b.root.as_deref() {
        // `resolve` is what keeps a path from the caller inside the root it
        // names -- the same guard `browse_file` reads its bytes through. A file
        // opens beside itself; the root opens at the root.
        app.browse
            .resolve(id, b.path.as_deref().unwrap_or(""))
            .ok()
            .and_then(|p| {
                if p.is_dir() {
                    Some(p)
                } else {
                    p.parent().map(|d| d.to_path_buf())
                }
            })
    } else if let Some(id) = b.doc.as_deref() {
        app.store
            .get(id)
            .ok()
            .flatten()
            .and_then(|d| doc_folder(&app, &d))
    } else {
        None
    };
    let Some(dir) = dir.filter(|d| d.is_dir()) else {
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

async fn browse_raw(State(app): S, Path(id): Path<String>, Query(q): Query<PathQ>) -> Response {
    serve_browsed(&app, &id, q.path.as_deref().unwrap_or("")).await
}

/// The same bytes under a path-shaped URL. A framed page is loaded from here so that
/// its own relative stylesheets, scripts and images resolve against the file's
/// directory instead of against `/api/browse/<id>/`.
async fn browse_raw_path(State(app): S, Path((id, rel)): Path<(String, String)>) -> Response {
    serve_browsed(&app, &id, &rel).await
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

async fn serve_browsed(app: &Arc<App>, id: &str, rel: &str) -> Response {
    let Ok(path) = app.browse.resolve(id, rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
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
    (headers, bytes).into_response()
}

/// Declarations in a browsed file. Parsing is repeated rather than cached: it is
/// off the first-paint path and the rail asks for it only once per file.
async fn browse_outline(State(app): S, Path(id): Path<String>, Query(q): Query<PathQ>) -> Response {
    let rel = q.path.unwrap_or_default();
    let Ok(path) = app.browse.resolve(&id, &rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let app2 = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).ok()?;
        if crate::render::looks_binary(&bytes) {
            return None;
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (kind, lang) = app2
            .renderer
            .detect(Some(&path.to_string_lossy()), None, &text);
        if kind != crate::render::Kind::Code {
            return None;
        }
        Some(app2.renderer.outline(lang.as_deref(), &text))
    })
    .await;
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
    use super::{hello_allows, Ui, APP_CSS, APP_JS, BOOT_JS, INDEX_HTML};
    use crate::capability::Capabilities;

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
        for bad in ["cap=${", "capability=${", "?cap=", "&cap=", "?capability="] {
            assert!(
                !APP_JS.contains(bad),
                "the capability is in a URL in app.js: {bad}"
            );
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
    #[test]
    fn every_id_the_script_uses_unguarded_is_in_the_page() {
        let mut missing = Vec::new();
        for (i, _) in APP_JS.match_indices("$(\"#") {
            let rest = &APP_JS[i + 4..];
            let end = rest.find('"').expect("unterminated selector");
            let id = &rest[..end];
            let used_at_once = rest[end..].starts_with("\").");
            if used_at_once && !INDEX_HTML.contains(&format!("id=\"{id}\"")) {
                missing.push(id);
            }
        }
        assert!(missing.is_empty(), "not in index.html: {missing:?}");
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
    /// written by one and never read by the other.
    #[test]
    fn settings_written_by_the_app_are_applied_before_first_paint() {
        for key in ["theme", "font", "side", "wide", "wrap"] {
            let k = format!("snyvi.{key}");
            assert!(APP_JS.contains(&k), "{k} is not used by app.js");
            assert!(BOOT_JS.contains(&k), "{k} is not applied by boot.js");
        }
    }
}
