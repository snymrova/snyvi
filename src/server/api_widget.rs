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

/// A desk's widgets, for its rail.
pub(crate) async fn desk_widgets(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.widgets(|c, _| widget::seats(c, id)) {
        Ok(s) => Json(json!({ "widgets": s })).into_response(),
        Err(e) => err(e),
    }
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

// --- writing one ----------------------------------------------------------

/// What a writer posts: the widget's name, and its body -- Markdown as a
/// string, or the contract's object (`widget::Body::parse`). An empty body
/// clears. `desk` is for the token's route: a desk's id, or none for a
/// global widget; a panel's is its own desk.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PushBody {
    name: String,
    body: serde_json::Value,
    desk: Option<i64>,
    writer: String,
}

impl PushBody {
    fn raw(&self) -> String {
        match &self.body {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// An agent in a panel sets a widget on its own desk (MCP `set_widget`).
pub(crate) async fn pane_set_widget(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let Ok(b) = serde_json::from_slice::<PushBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget");
    };
    let writer = format!("panel {}", placed.pane.slot);
    let w = widget::Writer { source: widget::Source::Push, writer: &writer, pane: &id };
    push(&app, placed.desk_id, &b.name, &b.raw(), &w)
}

/// Anything with the token sets a widget: a script, a git hook, cron, CI
/// (`snyvi widget set`). On a desk by its id, or global.
pub(crate) async fn set_widget(State(app): S, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(b) = serde_json::from_slice::<PushBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget");
    };
    let desk = b.desk.unwrap_or(0);
    if desk != 0 && !app.store.desks().map(|ds| ds.iter().any(|d| d.id == desk)).unwrap_or(false) {
        return refused(StatusCode::NOT_FOUND, format!("there is no desk {desk}"));
    }
    let writer = if b.writer.trim().is_empty() { "a script".to_string() } else { b.writer.trim().chars().take(40).collect() };
    let w = widget::Writer { source: widget::Source::Push, writer: &writer, pane: "" };
    push(&app, desk, &b.name, &b.raw(), &w)
}

/// Read, draw, keep and say a pushed body, or clear the widget.
fn push(app: &Arc<App>, desk: i64, name: &str, raw: &str, w: &widget::Writer) -> Response {
    if !widget::name_ok(name) {
        return refused(
            StatusCode::BAD_REQUEST,
            "a widget's name is lowercase letters, digits and dashes, at most 32",
        );
    }
    let sent = match widget::Body::parse(raw) {
        Ok(s) => s,
        Err(why) => return refused(StatusCode::BAD_REQUEST, why),
    };
    let b = match sent {
        widget::Sent::Clear => {
            return match app.store.widgets(|c, _| widget::clear(c, desk, name, w.source)) {
                Ok(was) => {
                    if was {
                        announce(app, desk, name);
                    }
                    Json(json!({ "cleared": was })).into_response()
                }
                Err(e) => err(e),
            };
        }
        widget::Sent::Body(b) => b,
    };
    let html = crate::render::widget_md(&b.md);
    match app.store.widgets(|c, now| widget::put(c, desk, name, &b, &html, w, now)) {
        Ok(widget::Put::Done) => {
            announce(app, desk, name);
            Json(json!({ "ok": true, "desk": desk, "name": name })).into_response()
        }
        Ok(widget::Put::Full) => refused(
            StatusCode::CONFLICT,
            if desk == 0 {
                format!("there are {} global widgets, which is all there can be", widget::GLOBAL_MAX)
            } else {
                format!("this desk has {} widgets, which is all it can have", widget::DESK_MAX)
            },
        ),
        Ok(widget::Put::Owned) => refused(
            StatusCode::CONFLICT,
            format!("a widget file is called {name}, and only it fills that seat: pick another name"),
        ),
        Err(e) => err(e),
    }
}

/// How often one widget's seat is sent to the pages: an agent writing every
/// 100 ms is drawn twice a second, the last word always.
const COALESCE: std::time::Duration = std::time::Duration::from_millis(500);

/// When each widget was last sent, and whether a send is waiting.
static SENT: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<(i64, String), (Instant, bool)>>> =
    std::sync::LazyLock::new(Default::default);

/// Tell the pages a widget changed: now, or once its half second is up --
/// whatever it says by then.
pub(crate) fn announce(app: &Arc<App>, desk: i64, name: &str) {
    let key = (desk, name.to_string());
    let now = Instant::now();
    let mut m = SENT.lock().unwrap();
    match m.get_mut(&key) {
        Some((at, waiting)) if now.duration_since(*at) < COALESCE => {
            if !*waiting {
                *waiting = true;
                let wait = COALESCE - now.duration_since(*at);
                let app = app.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    SENT.lock().unwrap().insert(key.clone(), (Instant::now(), false));
                    send_seat(&app, key.0, &key.1);
                });
            }
        }
        _ => {
            m.insert(key, (now, false));
            drop(m);
            send_seat(app, desk, name);
        }
    }
}

/// One widget as the pages draw it, or the word that it is gone.
fn send_seat(app: &App, desk: i64, name: &str) {
    match app.store.widgets(|c, _| widget::seat_of(c, desk, name)) {
        Ok(Some(s)) => emit(app, "widget", serde_json::to_value(s).unwrap_or_default()),
        Ok(None) => emit(app, "widget", json!({ "desk_id": desk, "name": name, "cleared": true })),
        Err(_) => {}
    }
}

/// A panel closed: what its agent pushed stays, dimmed, and says so.
pub(crate) fn pane_widgets_ended(app: &Arc<App>, pane: &str, slot: Option<i64>) {
    let said = slot.map_or("a panel since closed".to_string(), |n| format!("panel {n} closed"));
    let Ok(seats) = app.store.widgets(|c, _| {
        let s = widget::of_pane(c, pane)?;
        widget::pane_ended(c, pane, &said)?;
        Ok(s)
    }) else {
        return;
    };
    for (desk, name) in seats {
        announce(app, desk, &name);
    }
}
