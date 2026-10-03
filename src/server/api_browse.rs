//! Browse mode over HTTP: folders opened with `snyvi browse`, read off disk
//! on demand and never stored (`crate::browse`), and the ranged file serving
//! a `<video>` or a PDF asks for.

use super::*;

#[derive(Deserialize)]
pub(crate) struct OpenBody {
    pub(crate) path: String,
}

#[derive(Deserialize)]
pub(crate) struct PathQ {
    pub(crate) path: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct FindQ {
    pub(crate) q: Option<String>,
    pub(crate) limit: Option<usize>,
}

pub(crate) async fn browse_open(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<OpenBody>,
) -> Response {
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
pub(crate) async fn browse_pick(
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

pub(crate) async fn browse_list(State(app): S) -> Response {
    Json(app.browse.list()).into_response()
}

pub(crate) async fn browse_close(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if app.browse.close(&id) {
        emit(&app, "browse", json!({ "roots": app.browse.list() }));
        Json(json!({ "ok": true })).into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

/// Close folder, taken back. Only a folder closed in this run comes back, so
/// a page with no token can undo its own close and open nothing else.
pub(crate) async fn browse_reopen(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.browse.reopen(&id) {
        Some(root) => {
            emit(&app, "browse", json!({ "roots": app.browse.list() }));
            Json(json!({ "root": root })).into_response()
        }
        None => StatusCode::GONE.into_response(),
    }
}

pub(crate) async fn browse_tree(
    State(app): S,
    Path(id): Path<String>,
    Query(q): Query<PathQ>,
) -> Response {
    match app.browse.entries(&id, q.path.as_deref().unwrap_or("")) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn browse_file(
    State(app): S,
    Path(id): Path<String>,
    Query(q): Query<PathQ>,
) -> Response {
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

pub(crate) async fn browse_raw(
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
pub(crate) async fn browse_raw_path(
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
pub(crate) fn protect(headers: &mut HeaderMap, ext: &str) {
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

pub(crate) async fn serve_browsed(
    app: &Arc<App>,
    id: &str,
    rel: &str,
    req: &HeaderMap,
) -> Response {
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
pub(crate) async fn serve_file(
    path: &std::path::Path,
    mut headers: HeaderMap,
    req: &HeaderMap,
) -> Response {
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
pub(crate) enum Span {
    /// No usable range: several at once, another unit, or nonsense. The
    /// header is ignored and the whole file sent, as HTTP allows.
    Whole,
    /// First and last byte, inclusive, both inside the file.
    Part(u64, u64),
    /// Starts past the end.
    Unsatisfiable,
}

pub(crate) fn parse_range(v: &str, len: u64) -> Span {
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
pub(crate) struct Chunks {
    pub(crate) file: tokio::io::Take<tokio::fs::File>,
    pub(crate) buf: Box<[u8]>,
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
pub(crate) async fn browse_outline(
    State(app): S,
    Path(id): Path<String>,
    Query(q): Query<PathQ>,
) -> Response {
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

pub(crate) async fn browse_find(
    State(app): S,
    Path(id): Path<String>,
    Query(q): Query<FindQ>,
) -> Response {
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
