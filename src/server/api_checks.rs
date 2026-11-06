//! 1.58: checks the reader holds on a note (`crate::desk::checks`, H2.1).
//!
//! Five routes are the page's, behind `refuse_desk` like every write on a
//! desk's list: add one, rewrite or ✓/✗ one, ✕, Undo, Keep a suggestion. One
//! is an agent's, behind the token and a running pane (`agent_pane`): it may
//! suggest lines for a note on its own desk, and is answered with numbers.
//! No route an agent can reach reads the lines back. Apart from `api_desk`,
//! which has no room left under its limit.

use super::*;
use crate::desk::checks::{self, Added};

#[derive(Deserialize)]
pub(crate) struct CheckAddBody {
    pub(crate) text: String,
}

#[derive(Deserialize, Default)]
pub(crate) struct CheckSetBody {
    #[serde(default)]
    pub(crate) text: Option<String>,
    /// "ok", "fail" or "clear": the reader's ✓ or ✗ at check-it.
    #[serde(default)]
    pub(crate) result: Option<String>,
}

#[derive(Deserialize, Default)]
pub(crate) struct SuggestCheckBody {
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) texts: Vec<String>,
    /// The agent's name, as its MCP client gave it.
    #[serde(default)]
    pub(crate) by: String,
}

fn full() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": format!("a line holds {} checks", checks::CHECKS_PER_NOTE) })),
    )
        .into_response()
}

/// What an add, a keep or a restore answers, the line told on when it moved.
fn added(app: &App, desk: i64, a: anyhow::Result<Added>) -> Response {
    match a {
        Ok(Added::Check(c)) => {
            notes_moved(app, desk);
            (StatusCode::CREATED, Json(json!({ "check": c }))).into_response()
        }
        Ok(Added::Full) => full(),
        Ok(Added::Empty) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a check needs a line of text" })),
        )
            .into_response(),
        Ok(Added::NoSuchNote) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

fn changed(app: &App, desk: i64, r: anyhow::Result<bool>) -> Response {
    match r {
        Ok(true) => {
            notes_moved(app, desk);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The reader holds a new check on a line: "What will you try?", Enter.
pub(crate) async fn add_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<CheckAddBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let a = app
        .store
        .clocked(|c, now| checks::add(c, id, note, &b.text, "", now));
    added(&app, id, a)
}

/// The reader rewrites a check, or sets its ✓ / ✗ at check-it. One of the two
/// per call; a result that is not one of the three is a 404, as a check not
/// on this line is.
pub(crate) async fn set_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note, check)): Path<(i64, i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<CheckSetBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let r = app.store.clocked(|c, now| match (&b.text, &b.result) {
        (Some(t), _) => checks::set_text(c, id, note, check, t),
        (None, Some(r)) => checks::set_result(c, id, note, check, r, now),
        (None, None) => Ok(false),
    });
    changed(&app, id, r)
}

/// A ✕ on a check: off the line, and `restore` brings it back.
pub(crate) async fn remove_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note, check)): Path<(i64, i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let r = app
        .store
        .clocked(|c, now| checks::remove(c, id, note, check, now));
    changed(&app, id, r)
}

pub(crate) async fn restore_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note, check)): Path<(i64, i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let a = app
        .store
        .clocked(|c, _| checks::restore(c, id, note, check));
    added(&app, id, a)
}

/// The reader keeps an agent's suggested check: held from here on.
pub(crate) async fn keep_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note, check)): Path<(i64, i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let a = app.store.clocked(|c, _| checks::keep(c, id, note, check));
    added(&app, id, a)
}

/// An agent suggests checks for a line on its own desk: `suggest_check`. It
/// is answered how many landed and how many the caps turned away, and the
/// line's count of held checks, never the list.
pub(crate) async fn pane_suggest_check(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(String, i64)>,
    Json(b): Json<SuggestCheckBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let mut texts = b.texts;
    if !b.text.trim().is_empty() {
        texts.insert(0, b.text);
    }
    if texts.iter().all(|t| t.trim().is_empty()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "suggest_check needs at least one line of text" })),
        )
            .into_response();
    }
    let desk = placed.desk_id;
    let r = app
        .store
        .clocked(|c, now| checks::suggest(c, desk, note, &texts, &b.by, now));
    match r {
        Ok(s) if s.no_note => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("there is no note #{note} on this desk; read_desk_notes lists them") })),
        )
            .into_response(),
        Ok(s) => {
            if s.added > 0 {
                notes_moved(&app, desk);
            }
            let held = app
                .store
                .desk_notes(desk)
                .ok()
                .and_then(|ns| ns.into_iter().find(|n| n.id == note))
                .map_or(0, |n| n.checks_held);
            (
                StatusCode::CREATED,
                Json(json!({
                    "suggested": s.added, "refused": s.refused, "checks_held": held,
                    "per_call": checks::SUGGEST_PER_CALL, "waiting_per_note": checks::SUGGESTED_PER_NOTE,
                })),
            )
                .into_response()
        }
        Err(e) => err(e),
    }
}
