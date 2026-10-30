//! Home's week (1.48, `crate::week`): the box's payload on `/api/home`, and
//! the one route its fields and Hide post to. Apart from `api_desk.rs`,
//! which is near its ceiling.

use super::*;
use axum::{extract::Query, http::StatusCode, response::Response};

/// The week while its box is open, or null.
pub(crate) fn week_json(app: &App) -> serde_json::Value {
    app.store
        .clocked(|c, now| crate::week::week(c, now))
        .ok()
        .flatten()
        .map_or(serde_json::Value::Null, |w| json!(w))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct WeekBody {
    ship: Option<crate::week::Field>,
    tell: Option<crate::week::Field>,
    /// `week` for Not this week, `off` to hide it for good, `on` to bring
    /// it back; empty files the fields.
    hide: String,
}

/// The reader files the week, or puts it away. Drop is the left-off's own
/// route, with its Undo, which the page calls beside this.
pub(crate) async fn home_week(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<WeekBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let r = app.store.clocked(|c, now| match b.hide.as_str() {
        "week" => crate::week::skip(c, now).map(|_| Vec::new()),
        "off" => crate::week::set_off(c, true).map(|_| Vec::new()),
        "on" => crate::week::set_off(c, false).map(|_| Vec::new()),
        // On you's box ⋯ (1.54): whether the tray opens on arrival.
        "arrive-off" => crate::onyou::set_arrive_off(c, true).map(|_| Vec::new()),
        "arrive-on" => crate::onyou::set_arrive_off(c, false).map(|_| Vec::new()),
        _ => crate::week::file(c, b.ship.as_ref(), b.tell.as_ref(), now),
    });
    match r {
        Ok(ids) => {
            let desks: Vec<i64> = [b.ship.as_ref(), b.tell.as_ref()]
                .into_iter()
                .flatten()
                .map(|f| f.desk)
                .collect();
            for d in desks {
                notes_moved(&app, d);
            }
            Json(json!({ "ok": true, "notes": ids })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("{e:#}") })),
        )
            .into_response(),
    }
}
