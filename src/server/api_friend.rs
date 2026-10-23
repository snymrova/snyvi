//! A friend, as one place (1.49, audit 6f451571c6 cut C): the page at
//! `/friend/{id}` and what it lists (`/api/peers/{id}/talk`), and where a
//! new version of a friend's document lands -- with its earlier ones
//! (`follow_versions`). Beside `api_peer`, which holds the frames, the
//! pairing and the sends, and is long enough.

use super::*;
use crate::peer::Peer;

/// How many things the page asks for at a time.
const TALK_PAGE: usize = 30;

/// `/friend/{id}`: the page for one friend, drawn by `ui/friend.js`.
pub(crate) async fn shell_friend(State(app): S, Path(id): Path<i64>) -> Response {
    let Ok(Some(p)) = app.store.peer(id) else {
        return not_found_page(&app);
    };
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "friend", "friend": id, "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", &format!("{} · snyvi", p.name))
}

/// `GET /api/peers/{id}/talk?before=`: everything between the reader and
/// this friend, both ways, newest first, a page at a time
/// (`peer::timeline`). Open, as `/api/peers` is: titles, lines, dates.
pub(crate) async fn peer_talk(
    State(app): S,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Ok(Some(p)) = app.store.peer(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let before = q.get("before").and_then(|b| b.parse().ok()).unwrap_or(0);
    match app.store.peer_timeline(&p, before, TALK_PAGE) {
        Ok(items) => {
            let more = items.len() == TALK_PAGE;
            let away = app.peers.away.lock().unwrap().get(&p.id).copied();
            let desk = friend_desk(&app, &p).map(|d| json!({ "id": d.id, "name": d.name }));
            Json(json!({ "friend": p, "away": away, "desk": desk, "items": items, "more": more }))
                .into_response()
        }
        Err(e) => err(e),
    }
}

/// A new version of a friend's document lands where its earlier versions
/// are, so one document is never two rows (F8). With a desk for the friend
/// set, earlier versions still on the friend's own row move onto it; with
/// none, a new version that landed on their row joins the earlier ones
/// where the reader kept them. Nothing is re-dated; `move_lineage` takes
/// every version of the one it is given.
pub(crate) fn follow_versions(app: &App, p: &Peer, doc: &Doc, desk: Option<&crate::desk::Desk>) {
    let Some(path) = doc.source_path.as_deref() else {
        return;
    };
    let Ok(others) = app
        .store
        .peer_other_versions(&p.sign_key, path, doc.project_id)
    else {
        return;
    };
    let Some((other_id, other_desk)) = others.into_iter().next() else {
        return;
    };
    let moved = match (desk, other_desk) {
        // Their desk is set: the earlier ones come onto it.
        (Some(d), _) => {
            let (root, name, _) = receive::desk_project(&d.root);
            app.store
                .move_lineage(&other_id, &root, &name, &on_desk(d))
                .ok()
                .flatten()
                .is_some()
        }
        // No desk: the new one goes where the reader kept the earlier ones.
        (None, Some(kept)) => match app.store.desk(kept).ok().flatten() {
            Some(d) => {
                let (root, name, _) = receive::desk_project(&d.root);
                app.store
                    .move_lineage(&doc.id, &root, &name, &on_desk(&d))
                    .ok()
                    .flatten()
                    .is_some()
            }
            None => false,
        },
        (None, None) => false,
    };
    if moved {
        emit(app, "pinned", json!({ "id": doc.id }));
    }
}
