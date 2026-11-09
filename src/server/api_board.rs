//! A board over HTTP (`crate::board`, docs/BOARD.md), and the reader's focus
//! (`crate::focus`).
//!
//! The agent's routes are on the token, through `agent_pane`, and reach only
//! the pane's own desk's folder: `board_read`, `frame_write` (and its hide),
//! `board_arrange`, `frame_look`, `board_export`, `read_focus`, and
//! `open_view`, which opens a view on the reader's screen. The page's
//! are on the capability, through `refuse_desk`: the same read, and setting
//! the focus. A token still mints no capability and starts no command.
//!
//! A frame's HTML is never served from here. A frame is a document, and the
//! page loads it from the document's own route (`/api/docs/{id}/blob`) with
//! that route's CSP, as an HTML document is shown -- an iframe could not
//! carry the capability anyway. So the read names each frame's document,
//! and puts a frame file no version names yet (one written by hand, or with
//! Claude's Write tool) through `receive` first.

use super::*;
use crate::board;

fn refused(e: anyhow::Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": format!("{e:#}") })),
    )
        .into_response()
}

fn no_board(name: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": format!("this desk has no board \"{name}\" yet; frame_write makes it") })),
    )
        .into_response()
}

/// A board's directory on a desk, or the answer to refuse with.
fn board_dir(root: &str, name: &str) -> Result<std::path::PathBuf, Box<Response>> {
    match board::dir(std::path::Path::new(root), name, false) {
        Ok(Some(d)) => Ok(d),
        Ok(None) => Err(Box::new(no_board(name))),
        Err(e) => Err(Box::new(refused(e))),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct BoardQ {
    /// The last read's hash: unchanged, and the read says only that.
    #[serde(default)]
    pub(crate) since: Option<String>,
}

/// Each frame's newest version and how many it has, putting a frame file
/// that is ahead of its newest version into the store first, quietly.
/// Off the executor: these are store reads and, now and then, a render.
fn versions(
    app: &Arc<App>,
    desk: i64,
    root: &str,
    board_name: &str,
    dir: &std::path::Path,
    frames: &[board::FrameRead],
    pane: Option<&str>,
) -> Vec<(Option<String>, usize)> {
    let project = crate::receive::desk_project(root).0;
    let mut filed = false;
    let out = frames
        .iter()
        .map(|f| {
            let Some(path) = board::frame_file(dir, &f.frame.id) else {
                return (None, 0);
            };
            let sp = path.to_string_lossy().into_owned();
            let mut latest = app.store.latest_for_path(&project, &sp).ok().flatten();
            let behind = latest
                .as_ref()
                .is_none_or(|d| !d.content_hash.starts_with(&f.hash));
            if !f.missing && behind {
                let p = board::payload(std::path::Path::new(root), board_name, &path, pane);
                if let Ok(r) = crate::receive::receive(&app.store, &app.renderer, p) {
                    emit_doc(app, doc_event(app, &r));
                    latest = Some(r.doc);
                    filed = true;
                }
            }
            match latest {
                Some(d) => {
                    let n = app.store.history(d.project_id, &sp).map_or(1, |h| h.len());
                    (Some(d.id), n)
                }
                None => (None, 0),
            }
        })
        .collect();
    if filed {
        board_moved(app, desk, board_name);
    }
    out
}

/// The board as both sides read it: its frames with their place, size,
/// hash, newest version and count, the tokens and DESIGN.md's first
/// paragraph, and the reader's focus. `since` the last read's hash, and the
/// answer is only `unchanged`.
async fn board_read(
    app: &Arc<App>,
    root: String,
    desk: i64,
    name: String,
    since: Option<String>,
    pane: Option<String>,
) -> Response {
    let dir = match board_dir(&root, &name) {
        Ok(d) => d,
        Err(no) => return *no,
    };
    let held = app.clone();
    let read = tokio::task::spawn_blocking(move || {
        let (b, frames, files) = board::frames(&dir);
        let vs = versions(&held, desk, &root, &name, &dir, &frames, pane.as_deref());
        // The read's hash is the folder's and the versions': a frame put
        // into the store just now changes it, though no file did.
        let mut h = blake3::Hasher::new();
        h.update(files.as_bytes());
        for (doc, n) in &vs {
            h.update(format!("{}:{n};", doc.as_deref().unwrap_or("")).as_bytes());
        }
        let hash = h.finalize().to_hex()[..16].to_string();
        if since.as_deref() == Some(hash.as_str()) {
            return json!({ "unchanged": true, "hash": hash });
        }
        let frames: Vec<serde_json::Value> = frames
            .iter()
            .zip(vs)
            .map(|(f, (doc, n))| {
                let mut v = json!(f);
                v["doc"] = json!(doc);
                v["versions"] = json!(n);
                v
            })
            .collect();
        json!({
            "id": name,
            "name": if b.name.is_empty() { name.clone() } else { b.name.clone() },
            "path": format!("{}/{name}", board::DIR),
            "hash": hash,
            "frames": frames,
            "tokens": board::tokens(std::path::Path::new(&root)),
            "focus": held.focus.get(desk),
        })
    })
    .await;
    match read {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(anyhow::anyhow!("reading the board: {e}")),
    }
}

/// `board_read`: the board on this pane's desk.
pub(crate) async fn pane_board(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(String, String)>,
    Query(q): Query<BoardQ>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    board_read(&app, placed.root, placed.desk_id, name, q.since, Some(id)).await
}

/// The page's read of a board, for the Board view.
pub(crate) async fn desk_board(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    board_read(&app, desk.root, id, name, q.get("since").cloned(), None).await
}

#[derive(Deserialize)]
pub(crate) struct FrameBody {
    /// The frame whole. `null` hides it, through the hide route.
    pub(crate) html: String,
    #[serde(flatten)]
    pub(crate) size: board::Size,
}

/// `frame_write`: one frame, whole. The file, `board.json`, then a quiet
/// version in the store, told to the page as any document is.
pub(crate) async fn pane_frame_write(
    State(app): S,
    headers: HeaderMap,
    Path((id, name, frame)): Path<(String, String, String)>,
    Json(b): Json<FrameBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let root = placed.root.clone();
    let (n, f) = (name.clone(), frame.clone());
    let wrote = tokio::task::spawn_blocking(move || {
        board::write(std::path::Path::new(&root), &n, &f, &b.html, b.size)
    })
    .await;
    let path = match wrote {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return refused(e),
        Err(e) => return err(anyhow::anyhow!("writing the frame: {e}")),
    };
    let p = board::payload(std::path::Path::new(&placed.root), &name, &path, Some(&id));
    match receive_and_emit(&app, p).await {
        Ok(r) => {
            board_moved(&app, placed.desk_id, &name);
            (
                StatusCode::CREATED,
                Json(json!({
                    "board": name, "frame": frame, "doc": r.doc.id,
                    "same_version": r.existing,
                    "path": format!("{}/{name}/{frame}.html", board::DIR),
                })),
            )
                .into_response()
        }
        Err(no) => *no,
    }
}

#[derive(Deserialize)]
pub(crate) struct HideBody {
    #[serde(default = "yes")]
    pub(crate) hidden: bool,
}

fn yes() -> bool {
    true
}

/// A board moved -- a frame written, hidden, placed -- told as one `board`
/// event the open Board view reloads on. A frame's version is a `doc` event
/// as well, but a quiet one reaches the page's sidebar, not its desk.
fn board_moved(app: &App, desk: i64, name: &str) {
    emit(app, "board", json!({ "desk": desk, "board": name }));
}

/// `frame_write` with `html: null`: hidden, the file and every version kept.
pub(crate) async fn pane_frame_hide(
    State(app): S,
    headers: HeaderMap,
    Path((id, name, frame)): Path<(String, String, String)>,
    Json(b): Json<HideBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match board::hide(std::path::Path::new(&placed.root), &name, &frame, b.hidden) {
        Ok(true) => {
            board_moved(&app, placed.desk_id, &name);
            Json(json!({ "frame": frame, "hidden": b.hidden, "kept": true })).into_response()
        }
        Ok(false) => no_board(&name),
        Err(e) => refused(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct ArrangeBody {
    #[serde(default)]
    pub(crate) frames: Vec<board::Place>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

/// `board_arrange`: places, order, names; the board's name.
pub(crate) async fn pane_board_arrange(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(String, String)>,
    Json(b): Json<ArrangeBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match board::arrange(
        std::path::Path::new(&placed.root),
        &name,
        &b.frames,
        b.name.as_deref(),
    ) {
        Ok(board) => {
            board_moved(&app, placed.desk_id, &name);
            Json(json!({ "board": board })).into_response()
        }
        Err(e) => refused(e),
    }
}

/// `frame_look`: the window's own picture of a frame comes later. Until then the
/// tool exists and says what to do instead, so the skill does not change
/// when it arrives.
pub(crate) async fn pane_frame_look(
    State(app): S,
    headers: HeaderMap,
    Path((id, name, frame)): Path<(String, String, String)>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let dir = match board_dir(&placed.root, &name) {
        Ok(d) => d,
        Err(no) => return *no,
    };
    let b = board::read(&dir);
    let Some(f) = b.frames.iter().find(|f| f.id == frame) else {
        return no_board(&name);
    };
    let file = dir.join(format!("{}.html", f.id));
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": format!(
                "snyvi cannot show you the frame yet. Render {} at {} wide with your own browser (Playwright, or chromium --headless --screenshot --window-size={},{}) and read the picture.",
                file.display(), f.w, f.w, f.h
            ),
            "file": file, "w": f.w, "h": f.h,
        })),
    )
        .into_response()
}

/// `board_export`: one HTML page of every shown frame, in order, written
/// beside the boards as `design/<board>.html` (not in the board's folder,
/// where it would be a frame).
pub(crate) async fn pane_board_export(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(String, String)>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let dir = match board_dir(&placed.root, &name) {
        Ok(d) => d,
        Err(no) => return *no,
    };
    let b = board::read(&dir);
    let title = if b.name.is_empty() {
        name.clone()
    } else {
        b.name
    };
    let html = board::export(&dir, &title);
    let Some(out) = dir.parent().map(|d| d.join(format!("{name}.html"))) else {
        return no_board(&name);
    };
    match std::fs::write(&out, html.as_bytes()) {
        Ok(()) => Json(json!({ "path": out, "bytes": html.len() })).into_response(),
        Err(e) => err(anyhow::anyhow!("writing {}: {e}", out.display())),
    }
}

/// `read_focus`: where the reader is in this pane's desk's view, or null.
pub(crate) async fn pane_focus(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let now = crate::store::now();
    let f = app.focus.get(placed.desk_id).filter(|f| f.fresh(now));
    Json(json!({
        "focus": f,
        "line": f.as_ref().map(|f| f.line()),
    }))
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct FocusBody {
    pub(crate) view: String,
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) items: Vec<String>,
}

/// The open view says where the reader is. `panels` clears it. A change is
/// told as a `desk` event, so a second window agrees.
pub(crate) async fn set_desk_focus(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<FocusBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !matches!(app.store.desk(id), Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let f = crate::focus::Focus::from_page(&b.view, &b.path, &b.items, crate::store::now());
    if f.is_none() && b.view != "panels" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a focus is folder, board:<name> or panels" })),
        )
            .into_response();
    }
    if app.focus.set(id, f.clone()) {
        emit(&app, "focus", json!({ "desk": id, "focus": f }));
    }
    Json(json!({ "focus": f })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct ViewBody {
    view: String,
    #[serde(default)]
    path: String,
}

/// `open_view` (1.60, plan 586c0491b6): a view of the pane's own desk opened
/// on the reader's screen -- the panels, its folder (at a file in it), its
/// page or one of its boards -- by an agent the reader said yes to; its tool
/// says to ask first, every time. It is a view and only that: nothing is
/// typed, run or sent, and the token still mints no capability. Only while
/// a page shows that desk: anywhere else nothing opens, and the agent is
/// told so. The page opens it (`view`, 25-views.js), once the reader has
/// stopped typing.
pub(crate) async fn pane_open_view(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<ViewBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let root = std::path::Path::new(&placed.root);
    let view = b.view.trim();
    let known = matches!(view, "panels" | "folder" | "page")
        || (view.starts_with("board:") && board::views(root).iter().any(|v| v == view));
    if !known {
        return refused(anyhow::anyhow!(
            "a view is panels, folder, page, or board:<name> for a board this desk has"
        ));
    }
    let path = b.path.trim().trim_start_matches("./");
    if !path.is_empty() {
        let rel = std::path::Path::new(path);
        if view != "folder" {
            return refused(anyhow::anyhow!("a path goes with the folder view only"));
        }
        if !rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return refused(anyhow::anyhow!(
                "a path is a file's, relative to the desk's folder, with no .."
            ));
        }
        if !root.join(rel).is_file() {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("there is no file {path} in the desk's folder") })),
            )
                .into_response();
        }
    }
    if !in_view(&app, Some(placed.desk_id)) {
        return Json(json!({
            "opened": false,
            "line": format!("The user is not looking at the desk {} now, so nothing opened. Say in your reply what you wanted to show them.", placed.desk_name),
        }))
        .into_response();
    }
    let by = format!("Claude in panel {}", placed.pane.slot);
    emit(
        &app,
        "view",
        json!({ "desk": placed.desk_id, "view": view, "path": path, "by": by, "pane": placed.pane.id }),
    );
    let at = if path.is_empty() {
        String::new()
    } else {
        format!(" at {path}")
    };
    Json(json!({
        "opened": true,
        "line": format!("Opened {view}{at} on the user's desk; they go back with its chip or Esc. read_focus says where they are."),
    }))
    .into_response()
}

/// Each desk's views, for the desks list: Folder always, then one per
/// board in its folder (`board::views`).
pub(crate) fn views_by_desk(desks: &[crate::desk::Desk]) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    for d in desks {
        m.insert(
            d.id.to_string(),
            json!(board::views(std::path::Path::new(&d.root))),
        );
    }
    serde_json::Value::Object(m)
}
