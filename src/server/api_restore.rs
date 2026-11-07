//! 1.58: the window's side of a restore (`restore_run`): what is on offer,
//! and the click that brings it back. Both routes are a desk's: this page
//! and a live capability (`refuse_desk`), never the token, since a restore
//! starts processes and only the reader's click may.

use super::*;

/// What a click asks: everything, one desk's, or the panes ticked in
/// Choose…; `from` is the desk the reader is on, which goes first. `stop`
/// empties the queue, and `hide` is the bar's ✕.
#[derive(Deserialize, Default)]
pub(crate) struct RestoreBody {
    #[serde(default)]
    pub(crate) all: bool,
    #[serde(default)]
    pub(crate) desk: Option<i64>,
    #[serde(default)]
    pub(crate) ids: Vec<String>,
    #[serde(default)]
    pub(crate) from: Option<i64>,
    #[serde(default)]
    pub(crate) stop: bool,
    #[serde(default)]
    pub(crate) hide: bool,
}

/// `GET /api/restore`, `?panes=1` with each one named for Choose….
pub(crate) async fn get_restore(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let panes = q.get("panes").is_some_and(|v| v == "1");
    Json(super::restore_run::json(&app, panes)).into_response()
}

/// `POST /api/restore`: queue what the click named, of what is on offer.
pub(crate) async fn post_restore(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RestoreBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    use super::restore_run as r;
    if b.stop {
        r::stop(&app);
        return Json(r::json(&app, false)).into_response();
    }
    if b.hide {
        r::hide(&app);
        return Json(r::json(&app, false)).into_response();
    }
    let ids = if b.all {
        r::on_offer(&app, None)
    } else if let Some(d) = b.desk {
        r::on_offer(&app, Some(d))
    } else {
        b.ids
    };
    if ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "name what to restore: all, a desk, or ids" })),
        )
            .into_response();
    }
    let queued = r::enqueue(&app, &ids, b.from.or(b.desk));
    (StatusCode::ACCEPTED, Json(json!({ "queued": queued }))).into_response()
}
