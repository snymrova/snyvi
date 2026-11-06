//! 1.57: a desk's tabs, the page's side (#217). The code calls them groups
//! (`crate::desk::groups` says why). Every route is behind `refuse_desk`, as
//! the rest of a desk's are: making, renaming, ordering, showing, closing
//! and restoring a tab, and moving a panel into one. Apart from `api_desk`,
//! which has no room left under its limit for six more handlers.

use super::*;
use crate::desk::groups::{Closed, Regrouped};

#[derive(Deserialize)]
pub(crate) struct NewGroupBody {
    /// What the reader called it; empty is "Tab n". Every tab is in the
    /// desk's own folder: a tab is a set of panels, not another project.
    #[serde(default)]
    pub(crate) name: String,
}

#[derive(Deserialize)]
pub(crate) struct GroupMoveBody {
    /// The place among the desk's open tabs, 0 the leftmost.
    pub(crate) to: usize,
}

#[derive(Deserialize)]
pub(crate) struct RegroupBody {
    pub(crate) grp: i64,
}

/// The 409 a full side of a tab answers, as a full desk's did.
fn tab_full() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": format!("this tab holds {} and {} in the back", crate::desk::GRID, crate::desk::BACK) })),
    )
        .into_response()
}

/// The tab a new panel goes in and the folder it starts in: `grp` when it is
/// one of the desk's open tabs, else the one it reopens on, else its first;
/// the desk's own folder on a desk with no tabs. Read from the desk the
/// caller already has, so a panel's folder is always one the reader picked.
pub(crate) fn group_root(desk: &crate::desk::Desk, grp: i64) -> (i64, String) {
    let pick = desk
        .groups
        .iter()
        .find(|g| g.id == grp)
        .or_else(|| desk.groups.iter().find(|g| g.id == desk.grp_shown))
        .or_else(|| desk.groups.first());
    match pick {
        Some(g) => (g.id, g.root.clone()),
        None => (0, desk.root.clone()),
    }
}

/// A new tab, in the desk's folder. On a desk with no tabs it makes the first
/// tab too, for the panels already there. Answers the desk and the new tab's
/// id; the page starts its first panel the way a new desk's is.
pub(crate) async fn create_group(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NewGroupBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.create_group(id, &b.name) {
        Ok(Some(grp)) => {
            desks_moved(&app);
            let desk = app.store.desk(id).ok().flatten();
            (
                StatusCode::CREATED,
                Json(json!({ "grp": grp, "desk": desk })),
            )
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn rename_group(
    State(app): S,
    headers: HeaderMap,
    Path((id, grp)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.rename_group(id, grp, &b.name) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn move_group(
    State(app): S,
    headers: HeaderMap,
    Path((id, grp)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<GroupMoveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.move_group(id, grp, b.to) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Where the desk reopens. Silent, as a divider's drag is: the shown tab is
/// each window's own, and no other window follows this one's switch.
pub(crate) async fn show_group(
    State(app): S,
    headers: HeaderMap,
    Path((id, grp)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.show_group(id, grp) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A tab closed with its panels, stopped and kept, as ✕ closes one; the
/// answer carries the restore for the rail's Undo. The desk's last tab
/// stays: 409, and its menu says so before it is ever asked.
pub(crate) async fn close_group(
    State(app): S,
    headers: HeaderMap,
    Path((id, grp)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // Which panel each was, for what its agent left in a widget: read before
    // the rows go.
    let slots: std::collections::HashMap<String, i64> = app
        .store
        .desk(id)
        .ok()
        .flatten()
        .map(|d| d.panes.iter().map(|p| (p.id.clone(), p.slot)).collect())
        .unwrap_or_default();
    match app.store.close_group(id, grp) {
        Ok(Closed::Panes(panes)) => {
            for p in &panes {
                app.panes.forget(p);
                pane_widgets_ended(&app, p, slots.get(p).copied());
            }
            desks_moved(&app);
            Json(json!({
                "ok": true,
                "restore": format!("/api/desks/{id}/groups/{grp}/restore"),
            }))
            .into_response()
        }
        Ok(Closed::Last) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "a desk keeps one tab; close the desk instead" })),
        )
            .into_response(),
        Ok(Closed::Gone) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn restore_group(
    State(app): S,
    headers: HeaderMap,
    Path((id, grp)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.restore_group(id, grp) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A panel to another tab of its desk: a drag onto the tab's name, or the
/// tab's menu. Running or not, its process is untouched; only its place.
pub(crate) async fn regroup_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RegroupBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.regroup_pane(&id, b.grp) {
        Ok(Regrouped::Moved { to, to_grp, .. }) => {
            desks_moved(&app);
            Json(json!({ "grp": to_grp, "slot": to })).into_response()
        }
        Ok(Regrouped::Stays) => Json(json!({ "ok": true })).into_response(),
        Ok(Regrouped::Full) => tab_full(),
        Ok(Regrouped::Gone) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}
