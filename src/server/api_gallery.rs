//! A desk's gallery over HTTP (`crate::widget::gallery`): an agent or a
//! script adds what a model made, the page reads the outputs for its
//! viewer, the reader picks one, and the files are served by their hash.
//!
//! Adding is the token's, as `set_widget` is, and a panel's first add on a
//! desk asks with the same card a box does; the outputs added while it
//! waits are kept and drawn on Allow. Reading the list and picking are the
//! window's: they need the desk's capability. The files are read as a
//! document's blob is, by anyone on this host who has the name, which is
//! the hash of the bytes.

use super::*;
use crate::widget::{self, gallery};
use axum::body::Bytes;

/// What an add carries: the box's name (default `gallery`), the file, and
/// what is known about it. A `job` with no file is a tile being made; the
/// same job with a file fills it, with `failed` says why it did not.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct AddBody {
    name: String,
    file: String,
    job: String,
    caption: String,
    model: String,
    prompt: String,
    cost: Option<f64>,
    poster: String,
    failed: String,
    lines: Option<u8>,
    /// The token's route: the desk it goes on.
    desk: Option<i64>,
    writer: String,
    /// A panel's first add: how long it suggests the gallery lasts.
    #[serde(rename = "for")]
    lasts: String,
}

/// An add, read with a field sent as `null` taken as not sent: the CLI
/// sends every flag, given or not, and an agent's tool call may too.
fn read_add(body: &Bytes) -> Option<AddBody> {
    let mut v: serde_json::Value = serde_json::from_slice(body).ok()?;
    v.as_object_mut()?.retain(|_, x| !x.is_null());
    serde_json::from_value(v).ok()
}

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// An agent in a panel adds to a gallery on its own desk (MCP
/// `add_to_gallery`).
pub(crate) async fn pane_add_gallery(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let Some(b) = read_add(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not an output");
    };
    let writer = format!("panel {}", placed.pane.slot);
    add(&app, placed.desk_id, &id, &writer, b).await
}

/// A script adds to a gallery on a desk by its id (`snyvi gallery add`).
pub(crate) async fn add_gallery(State(app): S, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(b) = read_add(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not an output");
    };
    let Some(desk) = b.desk.filter(|d| *d > 0) else {
        return refused(
            StatusCode::BAD_REQUEST,
            "a gallery is on a desk: say which, by its id",
        );
    };
    if !app
        .store
        .desks()
        .map(|ds| ds.iter().any(|d| d.id == desk))
        .unwrap_or(false)
    {
        return refused(StatusCode::NOT_FOUND, format!("there is no desk {desk}"));
    }
    let writer = if b.writer.trim().is_empty() {
        "a script".to_string()
    } else {
        gallery::clip(&b.writer, 40)
    };
    add(&app, desk, "", &writer, b).await
}

/// Check, copy in, keep, and draw: the one way both routes add. `pane` is
/// the panel's id, or empty for a script, which asks no card.
async fn add(app: &Arc<App>, desk: i64, pane: &str, writer: &str, b: AddBody) -> Response {
    let name = if b.name.trim().is_empty() {
        "gallery".to_string()
    } else {
        b.name.trim().to_string()
    };
    if !widget::name_ok(&name) {
        return refused(
            StatusCode::BAD_REQUEST,
            "a gallery's name is lowercase letters, digits and dashes, at most 32",
        );
    }
    let job = gallery::clip(&b.job, gallery::JOB_CHARS);
    if b.file.trim().is_empty() && job.is_empty() {
        return refused(
            StatusCode::BAD_REQUEST,
            "an output needs its file, or a job to show it is being made",
        );
    }
    if b.file.contains("://") || b.poster.contains("://") {
        return refused(
            StatusCode::BAD_REQUEST,
            "a gallery takes a file on this machine, not a URL: download the output first",
        );
    }
    let cost = match b.cost {
        None => None,
        Some(c) => match gallery::micros(c) {
            Some(m) => Some(m),
            None => return refused(StatusCode::BAD_REQUEST, "cost is dollars, 0 or more"),
        },
    };
    if let Some(no) = said_no(app, desk, pane, &name) {
        return no;
    }
    let allowed = match room_for(app, desk, pane, &name) {
        Ok(yes) => yes,
        Err(no) => return *no,
    };
    let (stored, poster) = match copy_files(app, &b.file, &b.poster).await {
        Ok(x) => x,
        Err(no) => return *no,
    };
    let a = gallery::Add {
        job,
        stored,
        source: b.file.trim().to_string(),
        caption: gallery::clip(&b.caption, gallery::CAPTION_CHARS),
        model: gallery::clip(&b.model, gallery::MODEL_CHARS),
        prompt: gallery::clip(&b.prompt, gallery::PROMPT_CHARS),
        cost_micros: cost,
        poster,
        failed: gallery::clip(&b.failed, gallery::FAILED_CHARS),
        pane: pane.to_string(),
        writer: writer.to_string(),
    };
    let id = match app
        .store
        .clocked(|c, now| gallery::add(c, desk, &name, &a, now))
    {
        Ok(id) => id,
        Err(e) => return err(e),
    };
    let lines = b
        .lines
        .unwrap_or(gallery::LINES_DEFAULT)
        .clamp(widget::LINES_MIN, widget::LINES_MAX);
    let said = [a.caption.as_str(), a.model.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" · ");
    let raw = gallery::raw(lines, if said.is_empty() { &a.job } else { &said });
    let w = widget::Writer {
        source: widget::Source::Push,
        writer,
        pane,
        title: "",
        owner: 0,
    };
    let r = if allowed {
        super::api_widget::push(app, desk, &name, &raw, &w)
    } else {
        let pb = super::api_widget::PushBody {
            name: name.clone(),
            body: serde_json::Value::String(raw.clone()),
            lasts: b.lasts.clone(),
            ..Default::default()
        };
        super::api_widget::ask_for_box(app, desk, pane, writer, &pb, &raw)
    };
    let status = r.status();
    if !status.is_success() {
        return r;
    }
    let waiting = status == StatusCode::ACCEPTED;
    let file = a
        .stored
        .as_ref()
        .map(|s| s.file.clone())
        .unwrap_or_default();
    (
        status,
        Json(json!({ "ok": true, "id": id, "desk": desk, "name": name, "file": file, "waiting": waiting })),
    )
        .into_response()
}

/// Room for its box, and a card to ask with, before anything is kept: an
/// output kept and then refused would be added again, twice over. Ok says
/// whether it is drawn now (a script's, or one the user said yes to).
fn room_for(app: &Arc<App>, desk: i64, pane: &str, name: &str) -> Result<bool, Box<Response>> {
    let standing = app.store.clocked(|c, _| {
        let held = widget::name_held(c, desk, name)?;
        let room = widget::seat_of(c, desk, name)?.is_some() || !widget::slot_full(c, desk)?;
        let asked = widget::ask_of(c, desk, name)?;
        let waiting = crate::thread::box_waiting(c, desk, name)?;
        let cards = crate::thread::suggestions(c, desk)?
            .iter()
            .filter(|s| s.settled_at == 0 && (s.kind == "widget" || s.kind == "box"))
            .count() as i64;
        Ok((held, room, asked, waiting, cards))
    });
    let (held, room, asked, waiting, cards) = match standing {
        Ok(x) => x,
        Err(e) => return Err(Box::new(err(e))),
    };
    if held == Some(widget::Held::File) {
        return Err(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "a widget file is called {name} on this desk: pick another name for the gallery"
            ),
        )));
    }
    if !pane.is_empty() && held == Some(widget::Held::Box) && asked.is_none() {
        return Err(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "a script's box is called {name} on this desk: it is the user's. Pick another name"
            ),
        )));
    }
    if !room {
        return Err(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "this desk has {} widgets, which is all it can have: read_widgets, and update one of yours",
                widget::DESK_MAX
            ),
        )));
    }
    let needs_card =
        !pane.is_empty() && !waiting && !asked.as_ref().is_some_and(|a| a.answer == "yes");
    if needs_card && cards >= crate::thread::SUGGESTIONS_PER_DESK {
        return Err(Box::new(refused(
            StatusCode::CONFLICT,
            "three suggestions are waiting on this desk already: the gallery can be asked for once the user answers one",
        )));
    }
    Ok(pane.is_empty() || asked.as_ref().is_some_and(|a| a.answer == "yes"))
}

/// The output and its poster copied in, before anything is kept: a clip
/// can be a gigabyte, so off the runtime's threads.
async fn copy_files(
    app: &Arc<App>,
    file: &str,
    poster: &str,
) -> Result<(Option<gallery::Stored>, Option<gallery::Stored>), Box<Response>> {
    let dir = app.paths.data_dir.join(gallery::DIR);
    let (file, poster) = (file.trim().to_string(), poster.trim().to_string());
    // Said before anything is copied, so a clip is not copied for nothing.
    if !poster.is_empty() && gallery::kind_of(&crate::render::ext_of(&poster)) != Some("image") {
        return Err(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "the poster is a picture, a clip's first frame",
        )));
    }
    let copied = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let stored = (!file.is_empty())
            .then(|| gallery::copy_in(&dir, std::path::Path::new(&file)))
            .transpose()
            .map_err(|e| e.to_string())?;
        let poster = (!poster.is_empty())
            .then(|| gallery::copy_in(&dir, std::path::Path::new(&poster)))
            .transpose()
            .map_err(|e| format!("the poster: {e}"))?;
        Ok((stored, poster))
    })
    .await;
    match copied {
        Ok(Ok(x)) => Ok(x),
        Ok(Err(why)) => Err(Box::new(refused(StatusCode::BAD_REQUEST, why))),
        Err(e) => Err(Box::new(err(anyhow::anyhow!(e)))),
    }
}

/// A gallery the reader said Not now to, or removed, on this desk: the
/// refusal, before anything is copied. A panel that was not the one whose
/// box was removed asks again, as a box does.
fn said_no(app: &Arc<App>, desk: i64, pane: &str, name: &str) -> Option<Response> {
    let a = match app.store.clocked(|c, _| widget::ask_of(c, desk, name)) {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => return Some(err(e)),
    };
    let no = a.answer == "no" || (a.answer == "removed" && (pane.is_empty() || a.pane == pane));
    let which = if name == "gallery" {
        "the gallery".to_string()
    } else {
        format!("the gallery {name}")
    };
    no.then(|| {
        refused(
            StatusCode::CONFLICT,
            format!(
                "the user {} {which} on this desk: leave it, or say in your reply why it would help",
                if a.answer == "no" { "said not now to" } else { "removed" }
            ),
        )
    })
}

/// `GET /api/gallery?desk=&name=&all=`: a gallery's outputs for the
/// viewer, newest first, or with `all` every desk's, each with its desk's
/// name. The window's.
pub(crate) async fn list_gallery(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let desk: i64 = q.get("desk").and_then(|d| d.parse().ok()).unwrap_or(0);
    let name = q.get("name").map(String::as_str).unwrap_or("gallery");
    let all = q.get("all").is_some_and(|a| a == "1");
    let r = app.store.clocked(|c, _| {
        let items = gallery::items(c, desk, name, all, gallery::LIST_MAX)?;
        Ok(items)
    });
    let desks: serde_json::Map<String, serde_json::Value> = app
        .store
        .desks()
        .unwrap_or_default()
        .into_iter()
        .map(|d| (d.id.to_string(), json!(d.name)))
        .collect();
    match r {
        Ok(items) => Json(json!({ "items": items, "desks": desks, "all": all })).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PickBody {
    item: i64,
    line: String,
}

/// `POST /api/gallery/pick`: the reader picked an output, with a line. The
/// panel that added it hears it with its next prompt.
pub(crate) async fn pick_gallery(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let b: PickBody = serde_json::from_slice(&body).unwrap_or_default();
    match app
        .store
        .clocked(|c, now| gallery::pick(c, b.item, &b.line, now))
    {
        Ok(Some(desk)) => {
            super::api_thread::threads_moved(&app, desk);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(None) => refused(StatusCode::NOT_FOUND, "that output is not in a gallery"),
        Err(e) => err(e),
    }
}

/// `GET /gallery/{file}`: an output's bytes, by the name its hash gave it;
/// a clip a range at a time, so it seeks. What a name holds never changes.
pub(crate) async fn gallery_file(
    State(app): S,
    Path(file): Path<String>,
    req: HeaderMap,
) -> Response {
    if !gallery::file_name_ok(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let ext = crate::render::ext_of(&file);
    let mut headers = HeaderMap::new();
    if let Ok(v) =
        HeaderValue::from_str(mime_guess::from_ext(&ext).first_or_octet_stream().as_ref())
    {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    let at = app.paths.data_dir.join(gallery::DIR).join(&file);
    serve_file(&at, headers, &req).await
}
