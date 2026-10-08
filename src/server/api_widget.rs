//! The sidebars' layout and their widgets over HTTP (`crate::widget`).
//!
//! The layout is the reader's: set from this page (or with the token, as
//! every reader's action may be), normalized, kept, and sent to every page
//! as a `layout` event, which reorders the sections it has in place.

use super::*;
use crate::widget::{self, Layout};
use axum::body::Bytes;

/// The layout, as every page draws it.
pub(crate) fn layout_json(app: &App) -> serde_json::Value {
    let l = app.store.widgets(|c, _| widget::layout(c)).unwrap_or_default();
    serde_json::to_value(l).unwrap_or_default()
}

/// The global widgets' seats, for every page's first paint.
pub(crate) fn global_seats_json(app: &App) -> serde_json::Value {
    let s = app.store.widgets(|c, _| widget::seats(c, 0)).unwrap_or_default();
    serde_json::to_value(s).unwrap_or_default()
}

/// Keep the reader's layout. Anything a page sends is normalized first, so
/// an id from a newer page is dropped and a missing one is put back, and
/// what is answered -- and sent to every page -- is what was kept.
pub(crate) async fn set_layout(State(app): S, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let Ok(l) = serde_json::from_slice::<Layout>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "not a layout" }))).into_response();
    };
    match app.store.widgets(|c, now| widget::set_layout(c, &l, now)) {
        Ok(kept) => {
            let j = serde_json::to_value(&kept).unwrap_or_default();
            emit(&app, "layout", j.clone());
            Json(j).into_response()
        }
        Err(e) => err(e),
    }
}
