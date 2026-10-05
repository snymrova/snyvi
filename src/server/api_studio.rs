//! The page's side of a studio desk: its folder, the folders in it, one
//! folder's pictures, videos and sounds, the reader's ★ and hides. Every
//! route here is behind `refuse_desk` but the media route (`studio_raw`),
//! which is behind the host gate as browse mode's raw route is: an `<img>`
//! or a `<video>` cannot carry the capability, and a file read starts
//! nothing.

use super::*;

/// The desktop's folder dialog, for a studio folder: the folder chosen, as a
/// path, or 204 when it was closed without one. Nothing is opened under
/// Folders and nothing is made; the path goes back with New studio desk or
/// the desk's Studio folder…, and is checked there.
pub(crate) async fn studio_pick(
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
    // Cleared by dropping, as browse's pick is: a window closed while the
    // dialog is up drops this future where it waits.
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            PICKING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _done = Done;
    match tokio::task::spawn_blocking(crate::platform::pick_folder).await {
        Ok(Ok(Some(dir))) => Json(json!({ "path": dir })).into_response(),
        Ok(Ok(None)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))).into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

#[derive(Deserialize)]
pub(crate) struct StudioFolderBody {
    /// The folder itself: this desk's studio folder from now on.
    pub(crate) path: String,
}

/// Point the studio desk at another folder: its ⋯ menu's Studio folder….
/// The files in the old one stay where they are; snyvi never moves the
/// reader's files. The panel goes on in the folder it started in until it
/// is started again.
pub(crate) async fn studio_folder(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<StudioFolderBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let dir = match crate::studio::folder_ok(&b.path) {
        Ok(dir) => dir,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    };
    let path = dir.to_string_lossy().to_string();
    match app
        .store
        .studio(|c| crate::studio::move_folder(c, id, &path))
    {
        Ok(true) => {
            // What it was looking at was in the old folder.
            app.studio.forget(id);
            app.studio.say(
                id,
                crate::store::now(),
                format!("The studio folder is now {path}; you are still in the old one until the panel starts again."),
            );
            desks_moved(&app);
            Json(json!({ "folder": path })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A studio desk and its folder, or the answer to send instead: 404 for no
/// such desk, or one that is not a studio desk; 409 when its folder has
/// gone (moved, unmounted), which the viewer says in one line with a way to
/// point it somewhere.
pub(crate) fn studio_of(
    app: &App,
    id: i64,
) -> Result<(crate::desk::Desk, std::path::PathBuf), Box<Response>> {
    match app.store.desk(id) {
        Ok(Some(d)) if d.kind == crate::desk::STUDIO => {
            match std::path::Path::new(&d.boards).canonicalize() {
                Ok(p) if p.is_dir() => Ok((d, p)),
                _ => Err(Box::new((
                    StatusCode::CONFLICT,
                    Json(json!({ "error": "the studio folder is not there", "folder": d.boards })),
                )
                    .into_response())),
            }
        }
        Ok(_) => Err(Box::new(StatusCode::NOT_FOUND.into_response())),
        Err(e) => Err(Box::new(err(e))),
    }
}

/// A studio route's two refusals in one: the page's gate, then the desk.
fn gate(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
    id: i64,
) -> Result<(crate::desk::Desk, std::path::PathBuf), Box<Response>> {
    if let Some(no) = refuse_desk(app, headers, q) {
        return Err(Box::new(no));
    }
    studio_of(app, id)
}

/// What the viewer and the rail draw, in one read: the folders (the rail's
/// tree), what it all cost against the budget, and the open folder (`rel`,
/// empty for the studio folder itself). With `stamp`, the mark the page drew
/// from: when nothing in the studio folder changed since, only the mark
/// comes back, so the page can ask every second or two for the price of a
/// listing. `hidden=1` shows what the reader hid in the open folder, marked,
/// to put back.
pub(crate) async fn studio_look(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let (d, root) = match gate(&app, &headers, &q, id) {
        Ok(x) => x,
        Err(no) => return *no,
    };
    let rel = q.get("rel").cloned().unwrap_or_default();
    let had = q.get("stamp").cloned().unwrap_or_default();
    let show = q.get("hidden").is_some_and(|v| v == "1");
    let hidden = app
        .store
        .studio(|c| crate::studio::hidden(c, d.id))
        .unwrap_or_default();
    let read = tokio::task::spawn_blocking(move || {
        use crate::studio::folder;
        let stamp = folder::stamp(&root);
        if !had.is_empty() && had == stamp {
            return json!({ "same": true, "stamp": stamp });
        }
        // The open folder went (renamed, hidden): the top, and the page
        // finds its place again from the tree.
        let open = folder::folder(&root, &rel, &hidden, show)
            .or_else(|_| folder::folder(&root, "", &hidden, show))
            .ok();
        json!({
            "stamp": stamp,
            "tree": folder::tree(&root, &hidden),
            "loose": folder::loose(&root, &hidden),
            "spend": folder::spend(&root, &root, 0),
            "budget": folder::budget(&root),
            "folder": open,
        })
    })
    .await;
    match read {
        Ok(mut j) => {
            j["root"] = json!(d.boards);
            Json(j).into_response()
        }
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

#[derive(Deserialize)]
pub(crate) struct RelBody {
    pub(crate) rel: String,
}

/// ★: keep a file, or take the ★ off it -- its name in or out of `picks`
/// in its folder's folder.json (`folder::pick`), where the agent reads it.
/// The agent is told too, with its next prompt.
pub(crate) async fn studio_keep(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RelBody>,
) -> Response {
    let (d, root) = match gate(&app, &headers, &q, id) {
        Ok(x) => x,
        Err(no) => return *no,
    };
    let rel = b.rel.trim_matches('/').to_string();
    let r2 = rel.clone();
    let done = tokio::task::spawn_blocking(move || crate::studio::folder::pick(&root, &r2)).await;
    match done {
        Ok(Ok(on)) => {
            app.studio.say(
                d.id,
                crate::store::now(),
                if on {
                    format!("The reader starred {}/{rel}.", d.boards)
                } else {
                    format!("The reader took the star off {}/{rel}.", d.boards)
                },
            );
            Json(json!({ "picked": on })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// Hide a file or a folder: out of the viewer and the rail, never off the
/// disk.
pub(crate) async fn studio_hide(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RelBody>,
) -> Response {
    set_hidden(&app, &headers, &q, id, &b.rel, true)
}

/// The Undo on a hide, and Put back.
pub(crate) async fn studio_unhide(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RelBody>,
) -> Response {
    set_hidden(&app, &headers, &q, id, &b.rel, false)
}

fn set_hidden(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
    id: i64,
    rel: &str,
    hide: bool,
) -> Response {
    let (d, _) = match gate(app, headers, q, id) {
        Ok(x) => x,
        Err(no) => return *no,
    };
    let rel = rel.trim_matches('/');
    if rel.is_empty()
        || rel
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "not in the studio folder" })),
        )
            .into_response();
    }
    let now = crate::store::now();
    match app
        .store
        .studio(|c| crate::studio::set_hidden(c, d.id, rel, hide, now))
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err(e),
    }
}

/// A picture, a video or a sound off a studio desk's folder,
/// whole or the range a player asks for. Behind the host gate alone, as
/// browse mode's raw route is: an `<img>` and a `<video>` cannot send the
/// capability, a gigabyte video cannot go through a blob, and a file read
/// starts nothing. Only files the viewer shows are served, from the folder
/// the reader chose, inert (`protect`).
pub(crate) async fn studio_raw(
    State(app): S,
    Path((id, rel)): Path<(i64, String)>,
    req: HeaderMap,
) -> Response {
    let Ok((_, root)) = studio_of(&app, id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(path) = crate::studio::folder::resolve(&root, &rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if crate::studio::folder::kind_of(&name).is_none() || !path.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    protect(&mut headers, &render::ext_of(&path.to_string_lossy()));
    serve_file(&path, headers, &req).await
}

/// What the reader has open in the viewer, for the agent's next prompt:
/// "The reader is looking at …". Empty is nothing open.
pub(crate) async fn studio_selection(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RelBody>,
) -> Response {
    let (d, _) = match gate(&app, &headers, &q, id) {
        Ok(x) => x,
        Err(no) => return *no,
    };
    let rel = b.rel.trim_matches('/');
    if rel.split('/').any(|p| p == "..") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "not in the studio folder" })),
        )
            .into_response();
    }
    app.studio.look(d.id, crate::store::now(), rel.to_string());
    Json(json!({ "ok": true })).into_response()
}

// ---------- the agent's side ----------

/// What the studio desk has, for its agent: `read_studio`. Its folder, what
/// the reader has open, the keys by name (never a value), and the scripts
/// it kept, by name. Only for a panel on a studio desk.
pub(crate) async fn pane_read_studio(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let d = match app.store.desk(placed.desk_id) {
        Ok(Some(d)) if d.kind == crate::desk::STUDIO => d,
        Ok(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "this panel is not on a studio desk" })),
            )
                .into_response()
        }
        Err(e) => return err(e),
    };
    let scripts: Vec<String> = std::fs::read_dir(std::path::Path::new(&d.boards).join(".scripts"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .take(200)
        .collect();
    Json(json!({
        "folder": d.boards,
        "looking_at": app.studio.looking_at(d.id).map(|r| format!("{}/{r}", d.boards)),
        "keys": d.keys.iter().map(|k| k.name.clone()).collect::<Vec<_>>(),
        "scripts": scripts,
    }))
    .into_response()
}
