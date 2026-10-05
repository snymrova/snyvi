//! The library over HTTP: the tree, the inbox, search, a document and its
//! versions, what the reader does to one (read, pin, remove, Undo), asides,
//! and the receive endpoint every transport ends in.

use super::*;

pub(crate) async fn tree(State(app): S) -> Response {
    match app.store.projects() {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct TreeQ {
    pub(crate) workflows: Option<usize>,
    pub(crate) docs: Option<usize>,
    /// A workflow to send whole whatever the caps are: the one the reader is in.
    pub(crate) whole: Option<i64>,
}

/// What one project holds, fetched when a reader expands it. Zero for either
/// cap means all of them: that is a reader who clicked past the cap, and the
/// answer to "show me the rest" is the rest.
pub(crate) async fn project_tree(
    State(app): S,
    Path(id): Path<i64>,
    Query(q): Query<TreeQ>,
) -> Response {
    let workflows = q.workflows.unwrap_or(TREE_WORKFLOWS);
    let docs = q.docs.unwrap_or(TREE_DOCS);
    Json(project_rows(&app, id, workflows, docs, q.whole)).into_response()
}

/// One workflow, whole. Asked for by the tree when a reader wants everything in
/// a session, and by nothing else.
pub(crate) async fn workflow_tree(State(app): S, Path(id): Path<i64>) -> Response {
    match app.store.workflow_tree(id) {
        Ok(Some(w)) => Json(w).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct Limit {
    pub(crate) limit: Option<usize>,
}

pub(crate) async fn inbox(State(app): S, Query(q): Query<Limit>) -> Response {
    match app.store.inbox(q.limit.unwrap_or(50).min(500)) {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct SearchQ {
    pub(crate) q: String,
    pub(crate) limit: Option<usize>,
}

pub(crate) async fn search(State(app): S, Query(q): Query<SearchQ>) -> Response {
    match app.store.search(&q.q, q.limit.unwrap_or(30).min(200)) {
        Ok(t) => Json(t).into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn doc_json(State(app): S, Path(id): Path<String>) -> Response {
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

pub(crate) async fn doc_raw(State(app): S, Path(id): Path<String>) -> Response {
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
pub(crate) fn doc_ext(doc: &crate::store::Doc) -> String {
    match (doc.source_path.as_deref(), doc.lang.as_deref()) {
        (Some(p), _) => render::ext_of(p),
        (None, Some(l)) => l.trim().to_ascii_lowercase(),
        (None, None) => String::new(),
    }
}

pub(crate) async fn doc_blob(State(app): S, Path(id): Path<String>, req: HeaderMap) -> Response {
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
pub(crate) struct ViewQ {
    pub(crate) view: Option<String>,
}

pub(crate) async fn doc_split(State(app): S, Path(id): Path<String>) -> Response {
    match (app.store.get(&id), app.store.source(&id)) {
        (Ok(Some(doc)), Ok(src)) if doc.kind == crate::render::Kind::Diff => {
            Json(json!({ "html": render::diff_split(&src) })).into_response()
        }
        (Ok(Some(_)), _) => StatusCode::BAD_REQUEST.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Declarations in a stored code document, for the rail.
pub(crate) async fn doc_outline(State(app): S, Path(id): Path<String>) -> Response {
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
pub(crate) fn outline_of(app: &App, id: &str, lang: Option<&str>) -> Option<String> {
    let src = app.store.source(id).ok()?;
    let json = serde_json::to_string(&app.renderer.outline(lang, &src)).ok()?;
    let _ = app.store.set_outline(id, &json);
    Some(json)
}

pub(crate) async fn history(State(app): S, Path(id): Path<String>) -> Response {
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
pub(crate) async fn delete_doc(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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
pub(crate) async fn removed_list(
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
pub(crate) async fn undelete_doc(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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

pub(crate) async fn compare(
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
pub(crate) struct PinBody {
    pub(crate) pinned: bool,
}

#[derive(Deserialize)]
pub(crate) struct RenameBody {
    pub(crate) name: String,
}

/// A label the sidebar has to draw on one line, so it is trimmed of the whitespace
/// an accidental paste brings and cut to a length that cannot push the tree around.
pub(crate) fn clean_name(raw: &str) -> Option<String> {
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
pub(crate) async fn rename_project(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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

pub(crate) async fn rename_workflow(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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
pub(crate) async fn queue(State(app): S, Query(q): Query<Limit>) -> Response {
    match app.store.queue(q.limit.unwrap_or(QUEUE_MAX).min(QUEUE_MAX)) {
        Ok(q) => Json(q).into_response(),
        Err(e) => err(e),
    }
}

/// A tab opened a document. Every other tab hears, so the same row leaves
/// the queue everywhere at once; a document already read answers the same
/// and tells nobody, since nothing changed.
pub(crate) async fn mark_read(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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
pub(crate) async fn clear_queue(State(app): S, headers: HeaderMap) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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
pub(crate) struct IdsBody {
    pub(crate) ids: Vec<String>,
}

/// Mark all read, taken back: the ids `clear_queue` answered with wait again.
/// Every tab hears it as a restore, which refetches the queue and the tree.
pub(crate) async fn unread(State(app): S, headers: HeaderMap, Json(b): Json<IdsBody>) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
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

/// Pinning is UI state: from this page, or the CLI with the token. It only
/// affects what `prune` keeps.
pub(crate) async fn pin(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<PinBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.set_pinned(&id, b.pinned) {
        Ok(true) => {
            emit(&app, "pinned", json!({ "id": id, "pinned": b.pinned }));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn receive_doc(
    State(app): S,
    headers: HeaderMap,
    Json(payload): Json<Payload>,
) -> Response {
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
            emit_doc(&app, &received);
            let doc = received.doc;
            let url = format!("{}/d/{}", config::base_url(), doc.id);
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
pub(crate) async fn receive_aside(
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

pub(crate) async fn asides(State(app): S) -> Json<serde_json::Value> {
    Json(json!({ "notes": app.asides.list() }))
}

/// A reader looked: the glow goes out in every page.
pub(crate) async fn see_asides(State(app): S, headers: HeaderMap) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if app.asides.see() {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct AsideIds {
    pub(crate) ids: Vec<u64>,
}

/// A reader closed an aside, or all of them: gone from the card in every
/// page. Only flagged, so `restore` is the Undo.
pub(crate) async fn dismiss_asides(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<AsideIds>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if app.asides.dismiss(&b.ids) {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true })).into_response()
}

pub(crate) async fn restore_asides(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<AsideIds>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if app.asides.restore(&b.ids) {
        emit(&app, "notes", json!({ "notes": app.asides.list() }));
    }
    Json(json!({ "ok": true })).into_response()
}

/// Large code files are stored partly plain for an instant first view; finish the
/// highlight off the request path and tell open tabs to refetch.
/// Past this many bytes a render is large enough that the memory it frees is
/// worth handing back at once. See `platform::release_freed_memory`.
pub(crate) const LARGE_RENDER: usize = 512 * 1024;

pub(crate) fn spawn_full_highlight(app: Arc<App>, id: String, lang: Option<String>) {
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

/// Opening a folder exposes its files, so this one needs the token. Reading inside a
/// root the user already opened does not.
#[derive(Deserialize)]
pub(crate) struct TerminalBody {
    pub(crate) doc: Option<String>,
    pub(crate) root: Option<String>,
    pub(crate) path: Option<String>,
    /// A desk's folder. Behind the desk's gate: see `refuse_folder`.
    pub(crate) desk: Option<i64>,
    /// A project's root, as the sidebar's project rows know it.
    pub(crate) project: Option<i64>,
    /// With `desk`, a folder on the studio desk, relative to its folder ("" for
    /// the folder itself), resolved inside it as the media route is.
    #[serde(default)]
    pub(crate) board: Option<String>,
}

/// The directory a terminal would open in for a document, if one exists.
///
/// In order: the folder the file was sent from, then the project's root. The
/// second is the case that matters. `source_path` is an `Option` and a document
/// sent as content rather than as a path has none, so without the fallback the
/// button would be missing from exactly the sends that come straight out of an
/// agent.
pub(crate) fn doc_folder(app: &App, doc: &Doc) -> Option<std::path::PathBuf> {
    doc.source_path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf()))
        .into_iter()
        .chain(app.store.project_root(doc.project_id).map(Into::into))
        .find(|d: &std::path::PathBuf| d.is_dir())
}

/// Open the machine's own terminal, in the directory the reader is looking at.
///
/// The only thing this takes from the caller is an id snyvi already holds; the
/// directory is looked up here, no command is passed, and nothing comes back.
/// `docs/TERMINAL.md` has the argument, and section 3 of it has what is
/// deliberately absent.
pub(crate) async fn terminal(
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
pub(crate) async fn reveal(
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
pub(crate) fn refuse_folder(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
    b: &TerminalBody,
) -> Option<Response> {
    if b.desk.is_some() {
        return refuse_desk(app, headers, q);
    }
    refuse_reader(app, headers)
}

/// The folder a request names, looked up here from an id snyvi already
/// holds, so nothing the caller types is ever a path. One function for
/// `terminal` and `reveal`, so the two can never open different places.
pub(crate) fn folder_of(app: &App, b: &TerminalBody) -> Option<std::path::PathBuf> {
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
        let d = app.store.desk(id).ok().flatten()?;
        match &b.board {
            Some(rel) if d.kind == crate::desk::STUDIO => std::path::Path::new(&d.boards)
                .canonicalize()
                .ok()
                .and_then(|boards| crate::studio::folder::resolve(&boards, rel).ok())
                .and_then(dir_of),
            _ => Some(d.root.into()),
        }
    } else if let Some(id) = b.project {
        app.store.project_root(id).map(Into::into)
    } else {
        None
    };
    dir.filter(|d| d.is_dir())
}

/// A folder is itself; a file is the folder it sits in.
pub(crate) fn dir_of(p: std::path::PathBuf) -> Option<std::path::PathBuf> {
    if p.is_dir() {
        Some(p)
    } else {
        p.parent().map(|d| d.to_path_buf())
    }
}
