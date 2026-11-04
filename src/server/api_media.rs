//! Music while you work (#204), in the left rail. The reader's alone -- a
//! page's capability starts it, and no token route, no MCP tool, plays a
//! station. Apart from `api_desk.rs`, which is near its ceiling.

use super::*;
use axum::{
    body::Body,
    extract::{Path, Query},
    http::StatusCode,
    response::Response,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

type Q = Query<HashMap<String, String>>;

/// The reader's music choices: their own streams and the folder they
/// picked, in the config directory beside `folders.json`. The volume is the
/// page's own, in its storage.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
struct Prefs {
    mine: Vec<Mine>,
    folder: Option<String>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct Mine {
    name: String,
    url: String,
}

/// One writer at a time: two adds at once would each read the list without
/// the other's.
static PREFS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn prefs_path(app: &App) -> std::path::PathBuf {
    app.paths.config_dir.join("music.json")
}

fn prefs(app: &App) -> Prefs {
    std::fs::read(prefs_path(app))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(app: &App, p: &Prefs) -> std::io::Result<()> {
    let path = prefs_path(app);
    std::fs::create_dir_all(&app.paths.config_dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(p).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}

fn folder_name(p: &Prefs) -> Option<String> {
    let f = p.folder.as_deref()?;
    let path = std::path::Path::new(f);
    let home = dirs::home_dir();
    Some(
        match home.as_deref().and_then(|h| path.strip_prefix(h).ok()) {
            Some(rel) if !rel.as_os_str().is_empty() => format!("~/{}", rel.to_string_lossy()),
            _ => f.to_string(),
        },
    )
}

/// What the Music pop draws: the stations (by name and group: a number is
/// what plays one), the reader's own, and their folder.
fn music_json(p: &Prefs) -> serde_json::Value {
    json!({
        "stations": crate::music::STATIONS,
        "mine": p.mine,
        "folder": folder_name(p),
    })
}

pub(crate) async fn music(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(music_json(&prefs(&app))).into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct MineBody {
    url: String,
    name: String,
    /// Take this one out of the list rather than add it.
    remove: bool,
}

/// Add a stream of the reader's own, or take one out. Its name is what they
/// typed, or the address's host.
pub(crate) async fn music_mine(
    State(app): S,
    headers: HeaderMap,
    Query(q): Q,
    Json(b): Json<MineBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let _held = PREFS.lock().unwrap_or_else(|e| e.into_inner());
    let mut p = prefs(&app);
    if b.remove {
        p.mine.retain(|m| m.url != b.url.trim());
    } else {
        let url = match crate::music::check_url(&b.url) {
            Ok(u) => u,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response()
            }
        };
        if !p.mine.iter().any(|m| m.url == url) {
            if p.mine.len() >= crate::music::MINE_CAP {
                let error = format!("{} streams of your own is the most", crate::music::MINE_CAP);
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
            }
            let host = url
                .split("://")
                .nth(1)
                .and_then(|r| r.split(['/', ':', '?']).next())
                .unwrap_or("");
            let name = b.name.trim().chars().take(60).collect::<String>();
            p.mine.push(Mine {
                name: if name.is_empty() {
                    host.to_string()
                } else {
                    name
                },
                url,
            });
        }
    }
    if let Err(e) = save(&app, &p) {
        return err(anyhow::anyhow!("keeping your streams: {e}"));
    }
    Json(music_json(&p)).into_response()
}

static PICKING: AtomicBool = AtomicBool::new(false);
static PICK_CANCEL: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// The reader picks their music folder in the desktop's own dialog. Only
/// that folder is read, two levels down (`crate::music::list_folder`); it
/// is not opened for reading, which is for documents.
pub(crate) async fn music_folder(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if PICKING.swap(true, Ordering::SeqCst) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a folder dialog is already open" })),
        )
            .into_response();
    }
    let picked = crate::platform::pick_folder(&PICK_CANCEL).await;
    PICKING.store(false, Ordering::SeqCst);
    match picked {
        Ok(Some(dir)) => {
            let _held = PREFS.lock().unwrap_or_else(|e| e.into_inner());
            let mut p = prefs(&app);
            p.folder = Some(dir.to_string_lossy().to_string());
            if let Err(e) = save(&app, &p) {
                return err(anyhow::anyhow!("keeping your music folder: {e}"));
            }
            Json(music_json(&p)).into_response()
        }
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::NOT_IMPLEMENTED, Json(json!({ "error": e }))).into_response(),
    }
}

/// The folder's tracks, by name, in their order. Listed off the runtime: a
/// folder on a slow disk takes its time.
pub(crate) async fn music_files(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some(dir) = prefs(&app).folder else {
        return Json(json!({ "files": [] })).into_response();
    };
    let files =
        tokio::task::spawn_blocking(move || crate::music::list_folder(std::path::Path::new(&dir)))
            .await
            .unwrap_or_default();
    Json(json!({ "files": files, "capped": files.len() >= crate::music::FILES_CAP }))
        .into_response()
}

/// A media element sends no capability, so what plays is held to a read
/// from this page instead: no `Origin`, our `Host`, and fetch metadata,
/// where the engine sends it, saying `same-origin` -- an `<audio>` on
/// another site says `cross-site`. What it can reach is narrow either way:
/// a station on the list, a stream the reader added, a file in their folder.
fn not_ours(headers: &HeaderMap) -> Option<Response> {
    (!same_origin_read(headers)).then(|| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page" })),
        )
            .into_response()
    })
}

/// Folder track `n`, with Range, so a long track seeks.
pub(crate) async fn music_file(
    State(app): S,
    headers: HeaderMap,
    Path(n): Path<usize>,
) -> Response {
    if let Some(no) = not_ours(&headers) {
        return no;
    }
    let Some(dir) = prefs(&app).folder else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let found =
        tokio::task::spawn_blocking(move || crate::music::track(std::path::Path::new(&dir), n))
            .await
            .ok()
            .flatten();
    let Some(path) = found else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut out = HeaderMap::new();
    if let Ok(v) = crate::music::mime(&path).parse() {
        out.insert(header::CONTENT_TYPE, v);
    }
    out.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, max-age=300"),
    );
    serve_file(&path, out, &headers).await
}

/// Station or stream `n`, relayed: the daemon fetches it and passes the
/// bytes on as they come (`crate::music` says why). The fetch runs on a
/// thread of its own; when the page stops listening -- another station,
/// Stop, the window closed -- the next send fails and the thread lets the
/// station go.
pub(crate) async fn music_play(
    State(app): S,
    headers: HeaderMap,
    Path(n): Path<usize>,
) -> Response {
    if let Some(no) = not_ours(&headers) {
        return no;
    }
    let mine: Vec<String> = prefs(&app).mine.into_iter().map(|m| m.url).collect();
    let Some(url) = crate::music::url_for(n, &mine) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let opened = tokio::task::spawn_blocking(move || crate::music::open(&url)).await;
    let (ty, mut reader) = match opened {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response()
        }
        Err(e) => return err(anyhow::anyhow!(e)),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<axum::body::Bytes>>(8);
    tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(k) => {
                    if tx
                        .blocking_send(Ok(axum::body::Bytes::copy_from_slice(&buf[..k])))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    let mut resp =
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)).into_response();
    let h = resp.headers_mut();
    if let Ok(v) = ty.parse() {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    resp
}
