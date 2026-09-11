//! The local HTTP server: UI shell, JSON API, SSE, and the receive endpoint.

use crate::browse::Browser;
use crate::config::{self, Paths};
use crate::receive::{self, Payload};
use crate::render::{self, Renderer};
use crate::store::{Doc, Store};
use axum::{
    body::Body,
    extract::{Path, Query, State},
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
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const INDEX_HTML: &str = include_str!("../ui/index.html");
const APP_CSS: &str = include_str!("../ui/app.css");
const APP_JS: &str = include_str!("../ui/app.js");
const BOOT_JS: &str = include_str!("../ui/boot.js");
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

pub struct App {
    pub store: Store,
    pub renderer: Renderer,
    pub browse: Browser,
    pub token: String,
    pub events: broadcast::Sender<String>,
    /// Fires when `snyvi stop` asks the daemon to exit.
    pub shutdown: broadcast::Sender<()>,
    pub started: Instant,
    /// Build hash for immutable asset URLs.
    pub asset_v: String,
    /// Last time any open tab reported having focus; drives desktop notifications.
    pub last_focus: std::sync::Mutex<Instant>,
}

type S = State<Arc<App>>;

pub async fn run(paths: Paths) -> anyhow::Result<()> {
    let token = config::load_or_create_token(&paths)?;
    let store = Store::open(&paths)?;
    let renderer = Renderer::new();
    let (tx, _) = broadcast::channel(64);
    let (stop_tx, mut stop_rx) = broadcast::channel::<()>(1);
    let asset_v = blake3::hash(format!("{INDEX_HTML}{APP_CSS}{APP_JS}{VERSION}").as_bytes())
        .to_hex()[..8]
        .to_string();
    let app = Arc::new(App {
        store,
        renderer,
        browse: Browser::new(),
        token,
        events: tx,
        shutdown: stop_tx,
        started: Instant::now(),
        asset_v,
        last_focus: std::sync::Mutex::new(Instant::now() - std::time::Duration::from_secs(60)),
    });

    let router = Router::new()
        .route("/", get(shell_home))
        .route("/d/{id}", get(shell_doc))
        .route("/b/{id}", get(shell_browse))
        .route("/b/{id}/{*path}", get(shell_browse_file))
        .route("/assets/app.css", get(asset_css))
        .route("/assets/app.js", get(asset_js))
        .route("/assets/boot.js", get(asset_boot))
        .route("/assets/mermaid.js", get(asset_mermaid))
        .route("/files/{id}/{*path}", get(doc_file))
        .route("/assets/fonts/{name}", get(asset_font))
        .route("/api/health", get(health))
        .route("/api/tree", get(tree))
        .route("/api/inbox", get(inbox))
        .route("/api/search", get(search))
        .route("/api/docs", post(receive_doc))
        .route("/api/docs/{id}", get(doc_json))
        .route("/api/docs/{id}/pin", post(pin))
        .route("/api/docs/{id}/delete", post(delete_doc))
        .route("/api/docs/{id}/history", get(history))
        .route("/api/docs/{id}/split", get(doc_split))
        .route("/api/focus", post(focus))
        .route("/api/shutdown", post(shutdown))
        .route("/api/browse", get(browse_list).post(browse_open))
        .route("/api/browse/{id}/close", post(browse_close))
        .route("/api/browse/{id}/tree", get(browse_tree))
        .route("/api/browse/{id}/file", get(browse_file))
        .route("/api/browse/{id}/raw", get(browse_raw))
        .route("/api/browse/{id}/raw/{*path}", get(browse_raw_path))
        .route("/api/browse/{id}/find", get(browse_find))
        .route("/api/docs/{id}/raw", get(doc_raw))
        .route("/api/docs/{id}/blob", get(doc_blob))
        .route("/api/compare/{a}/{b}", get(compare))
        .route("/api/events", get(events))
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

fn escape_json_for_script(s: &str) -> String {
    s.replace("</", "<\\/")
}

fn shell(app: &App, boot: serde_json::Value, initial_html: &str, title: &str) -> Response {
    let page = INDEX_HTML
        .replace("{{V}}", &app.asset_v)
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
    let tree = app.store.tree().unwrap_or_default();
    let inbox = app.store.inbox(50).unwrap_or_default();
    let boot = json!({ "view": "inbox", "tree": tree, "inbox": inbox, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "snyvi")
}

async fn shell_doc(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return (StatusCode::NOT_FOUND, Html("<h1>Not found</h1>")).into_response();
    };
    let body = app.store.html(&id).unwrap_or_default();
    let tree = app.store.tree().unwrap_or_default();
    let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
    let title = doc.title.clone();
    let boot = json!({ "view": "doc", "tree": tree, "doc": doc, "previous": previous, "browse": app.browse.list(), "version": VERSION });
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

async fn asset_css() -> Response {
    immutable("text/css; charset=utf-8", APP_CSS)
}
async fn asset_js() -> Response {
    immutable("application/javascript; charset=utf-8", APP_JS)
}
async fn asset_boot() -> Response {
    immutable("application/javascript; charset=utf-8", BOOT_JS)
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
        "docs": app.store.count().unwrap_or(0),
        "languages": app.renderer.languages().len(),
        "uptime_s": app.started.elapsed().as_secs(),
    }))
}

async fn tree(State(app): S) -> Response {
    match app.store.tree() {
        Ok(t) => Json(t).into_response(),
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

async fn delete_doc(State(app): S, Path(id): Path<String>) -> Response {
    match app.store.delete(&id) {
        Ok(true) => {
            emit(&app, "deleted", json!({ "id": id }));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
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
    let _ = std::process::Command::new("notify-send")
        .args([
            "-a",
            "snyvi",
            "-i",
            "text-x-generic",
            &doc.title,
            &format!("{} · {}", doc.project, doc.workflow_title),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
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

/// Broadcast payloads are "<event name>\n<json>".
async fn events(State(app): S) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = app.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|m| {
        m.ok().map(|msg| {
            let (name, data) = msg.split_once('\n').unwrap_or(("doc", msg.as_str()));
            Ok(Event::default().event(name).data(data))
        })
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn emit(app: &App, name: &str, data: serde_json::Value) {
    let _ = app.events.send(format!("{name}\n{data}"));
}

#[derive(Deserialize)]
struct PinBody {
    pinned: bool,
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
                json!({ "doc": doc, "url": url, "existing": received.existing }),
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
                Json(
                    json!({ "id": doc.id, "url": url, "doc": doc, "existing": received.existing }),
                ),
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
        "tree": app.store.tree().unwrap_or_default(),
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
        .map(|t| constant_eq(t, &app.token))
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
