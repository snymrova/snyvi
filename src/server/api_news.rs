//! News on the page (1.66, `crate::news`): seen, and Undo. The window's
//! routes, behind the desk's gate: an agent writes News by what it does,
//! never by a route of its own, and only the reader undoes.

use super::*;

type Q = Query<std::collections::HashMap<String, String>>;

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct SeenBody {
    /// One desk's News, or every desk's with none.
    desk: Option<i64>,
}

/// The reader looked at News: `POST /api/news/seen`.
pub(crate) async fn news_seen(
    State(app): S,
    headers: HeaderMap,
    Query(q): Q,
    Json(b): Json<SeenBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.clocked(|c, now| crate::news::seen(c, b.desk, now)) {
        Ok(n) => {
            if n > 0 {
                emit(&app, "desknotes", json!({ "desk": b.desk.unwrap_or(0) }));
            }
            Json(json!({ "ok": true, "seen": n })).into_response()
        }
        Err(e) => err(e),
    }
}

/// A News line's Undo: `POST /api/news/{id}/undo`. A card an agent took
/// back comes back; an agent's change to a routine is put back as it was.
pub(crate) async fn news_undo(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some((item, undo))) = app.store.clocked(|c, _| crate::news::get(c, id)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if item.undone || undo.is_empty() {
        return (StatusCode::CONFLICT, Json(json!({ "error": "nothing to undo" }))).into_response();
    }
    let undo: serde_json::Value = serde_json::from_str(&undo).unwrap_or_default();
    let done = match item.kind.as_str() {
        "took_back" => app.store.clocked(|c, _| {
            crate::thread::restore_turn(c, item.desk_id, undo["turn"].as_i64().unwrap_or(0))
        }),
        "changed" => super::routine_offer::undo_change(&app, &undo),
        _ => Ok(false),
    };
    match done {
        Ok(true) => {
            let _ = app.store.clocked(|c, now| crate::news::undone(c, id, now));
            super::routine_run::changed(&app, item.desk_id);
            super::api_thread::threads_moved(&app, item.desk_id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => (StatusCode::CONFLICT, Json(json!({ "error": "it is not there to put back" }))).into_response(),
        Err(e) => err(e),
    }
}
