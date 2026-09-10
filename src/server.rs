//! The local HTTP server: UI shell, JSON API, SSE, and the receive endpoint.

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
    pub token: String,
    pub events: broadcast::Sender<String>,
    pub started: Instant,
    /// Build hash for immutable asset URLs.
    pub asset_v: String,
}

type S = State<Arc<App>>;

pub async fn run(paths: Paths) -> anyhow::Result<()> {
    let token = config::load_or_create_token(&paths)?;
    let store = Store::open(&paths)?;
    let renderer = Renderer::new();
    let (tx, _) = broadcast::channel(64);
    let asset_v = blake3::hash(format!("{INDEX_HTML}{APP_CSS}{APP_JS}{VERSION}").as_bytes())
        .to_hex()[..8]
        .to_string();
    let app = Arc::new(App {
        store,
        renderer,
        token,
        events: tx,
        started: Instant::now(),
        asset_v,
    });

    let router = Router::new()
        .route("/", get(shell_home))
        .route("/d/{id}", get(shell_doc))
        .route("/assets/app.css", get(asset_css))
        .route("/assets/app.js", get(asset_js))
        .route("/assets/fonts/{name}", get(asset_font))
        .route("/api/health", get(health))
        .route("/api/tree", get(tree))
        .route("/api/inbox", get(inbox))
        .route("/api/search", get(search))
        .route("/api/docs", post(receive_doc))
        .route("/api/docs/{id}", get(doc_json))
        .route("/api/docs/{id}/pin", post(pin))
        .route("/api/docs/{id}/raw", get(doc_raw))
        .route("/api/compare/{a}/{b}", get(compare))
        .route("/api/events", get(events))
        .with_state(app);

    let addr = format!("127.0.0.1:{}", config::port());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    eprintln!("snyvi {VERSION} listening on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

// ---------- shell ----------

fn escape_json_for_script(s: &str) -> String {
    s.replace("</", "<\\/")
}

fn shell(app: &App, boot: serde_json::Value, initial_html: &str, title: &str) -> Html<String> {
    let page = INDEX_HTML
        .replace("{{V}}", &app.asset_v)
        .replace("{{TITLE}}", &html_escape::encode_text(title))
        .replace("{{INITIAL_HTML}}", initial_html)
        .replace("{{BOOT_JSON}}", &escape_json_for_script(&boot.to_string()));
    Html(page)
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
    let boot = json!({ "view": "inbox", "tree": tree, "inbox": inbox, "version": VERSION });
    shell(&app, boot, "", "snyvi").into_response()
}

async fn shell_doc(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return (StatusCode::NOT_FOUND, Html("<h1>Not found</h1>")).into_response();
    };
    let body = app.store.html(&id).unwrap_or_default();
    let tree = app.store.tree().unwrap_or_default();
    let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
    let title = doc.title.clone();
    let boot = json!({ "view": "doc", "tree": tree, "doc": doc, "previous": previous, "version": VERSION });
    shell(&app, boot, &doc_html(&doc, &body), &title).into_response()
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
            Json(json!({ "doc": doc, "html": doc_html(&doc, &body), "previous": previous }))
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

async fn compare(State(app): S, Path((a, b)): Path<(String, String)>) -> Response {
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
