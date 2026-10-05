//! The page's side of a desk: Home, desks, panels, notes, keys, pastes and
//! Ctrl-clicked paths. Every route here is behind `refuse_desk`: this page,
//! and a live capability.

use super::*;

/// A desk, by its address. The page is the same page in a window and a tab --
/// what differs is that a tab holds no capability, and the desk view says so
/// in one sentence rather than drawing a grid that could never run anything.
/// Home in one call: every desk with what its card shows, what is waiting,
/// the update, the agents and the account's quota. The desk half is behind
/// the desk gate, as `/api/desks` is: a tab gets the rest, and a line saying
/// desks are the window's.
///
/// A desk's card is where the work stands -- when it was last touched, where
/// it was left or else the last thing that happened on it, what is open, what
/// git says in its folder -- and `days` is what happened on every desk over the
/// last `DAYS_SHOWN` days, a row per tick, document, left-off line and commit,
/// for the page to group by the reader's own days. `pulse` is each desk's
/// active hours over git's `WEEKS`, for its rhythm. Git is read off the
/// runtime, a folder at a time, and kept for half a minute (`crate::git`).
pub(crate) async fn home(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let gated = refuse_desk(&app, &headers, &q).is_none();
    let app2 = app.clone();
    let (desks, days) = if gated {
        tokio::task::spawn_blocking(move || home_desks(&app2))
            .await
            .unwrap_or((serde_json::Value::Null, serde_json::Value::Null))
    } else {
        (serde_json::Value::Null, serde_json::Value::Null)
    };
    Json(json!({
        "desks": desks,
        "days": days,
        "queue": app.store.queue(5).unwrap_or_default(),
        "waiting": waiting(&app),
        "update": update_json(&app),
        "agents": app.online(),
        "quota": *app.quota.lock().unwrap_or_else(|e| e.into_inner()),
        "version": VERSION,
    }))
    .into_response()
}

/// How many days of rows Home's log is sent: a week, and the day before it,
/// so "this week" is whole on any day it is read.
pub(crate) const DAYS_SHOWN: i64 = 8;

/// How many of a desk's open lines Home shows under it before "and N more".
pub(crate) const HOME_NOTES: usize = 5;

/// The desk half of Home, blocking: the store and git.
pub(crate) fn home_desks(app: &App) -> (serde_json::Value, serde_json::Value) {
    let now = crate::store::now();
    let since = now - crate::git::WEEKS * 7 * 86_400;
    let shown = now - DAYS_SHOWN * 86_400;
    let list = app.store.desks().unwrap_or_default();
    let done = app.store.desks_done_since(since).unwrap_or_default();
    let sent = app.store.desks_sent_since(since).unwrap_or_default();
    let mut days: Vec<serde_json::Value> = Vec::new();
    let cards: Vec<serde_json::Value> = list
        .iter()
        .map(|d| {
            let mut notes = app.store.desk_notes(d.id).unwrap_or_default();
            settle_stages(app, &mut notes);
            let open = notes.iter().filter(|n| !n.done && n.suggested_by.is_empty()).count();
            let notes_done = notes.iter().filter(|n| n.done).count();
            let suggested = notes.iter().filter(|n| !n.done && !n.suggested_by.is_empty()).count();
            // The first open lines, by id as well as by text: Home ticks
            // them where they stand, and adds to the list, without the desk.
            let next: Vec<serde_json::Value> = notes
                .iter()
                .filter(|n| !n.done && n.suggested_by.is_empty())
                .take(HOME_NOTES)
                .map(|n| json!({ "id": n.id, "text": n.text, "stage": n.stage, "stage_by": n.stage_by,
                    "stage_doc": n.stage_doc, "stage_panel": n.stage_panel,
                    // Its dot breathes only while the agent is at it.
                    "stage_busy": n.stage == "working" && app.panes.status(&n.stage_pane).agent == "working" }))
                .collect();
            let last_doc = app.store.desk_docs(d.id, 1, false).unwrap_or_default().into_iter().next();
            let git = app.git.read(std::path::Path::new(&d.root), now);
            let ticks: Vec<&crate::desk::Done> = done.iter().filter(|t| t.desk_id == d.id).collect();
            let docs: Vec<&(i64, String, String, i64)> = sent.iter().filter(|x| x.0 == d.id).collect();
            let commits: &[crate::git::Commit] = git.as_deref().map(|g| g.commits.as_slice()).unwrap_or(&[]);

            // The rows of the log.
            for t in ticks.iter().filter(|t| t.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "tick", "at": t.at, "text": t.text, "by": t.by,
                    "commit": t.commit, "doc": t.doc, "evidence": t.evidence }));
            }
            for x in docs.iter().filter(|x| x.3 >= shown) {
                days.push(json!({ "desk": d.id, "kind": "doc", "at": x.3, "id": x.1, "text": x.2 }));
            }
            for c in commits.iter().filter(|c| c.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "commit", "at": c.at, "hash": c.hash, "text": c.subject }));
            }
            if let Some(l) = d.left_off.as_ref().filter(|l| l.at >= shown) {
                days.push(json!({ "desk": d.id, "kind": "left", "at": l.at, "text": l.text, "by": l.by }));
            }

            // Its rhythm: the hours anything happened in, once each.
            let mut pulse: Vec<i64> = ticks
                .iter()
                .map(|t| t.at)
                .chain(docs.iter().map(|x| x.3))
                .chain(commits.iter().map(|c| c.at))
                .chain(d.left_off.iter().map(|l| l.at))
                .filter(|&at| at >= since)
                .map(|at| at - at.rem_euclid(3600))
                .collect();
            pulse.sort_unstable();
            pulse.dedup();

            // The last thing that happened, for a desk no one said Left off on.
            let tick = ticks.last().map(|t| (t.at, json!({ "kind": "tick", "at": t.at, "text": t.text, "commit": t.commit })));
            let doc = last_doc.as_ref().map(|x| (x.received_at, json!({ "kind": "doc", "at": x.received_at, "text": x.title, "id": x.id })));
            let last = match (tick, doc) {
                (Some(t), Some(x)) => Some(if t.0 >= x.0 { t.1 } else { x.1 }),
                (t, x) => t.or(x).map(|p| p.1),
            };

            // Touched: opened, or anything that happened on it.
            let touched = [
                d.visited_at,
                d.left_off.as_ref().map_or(0, |l| l.at),
                last_doc.as_ref().map_or(0, |x| x.received_at),
                ticks.last().map_or(0, |t| t.at),
                git.as_deref().and_then(|g| g.last.as_ref()).map_or(0, |c| c.at),
            ]
            .into_iter()
            .max()
            .unwrap_or(0);

            let panes: Vec<serde_json::Value> = d
                .panes
                .iter()
                .map(|p| {
                    let st = app.panes.status(&p.id);
                    json!({
                        "id": p.id, "slot": p.slot, "name": p.name,
                        "running": st.running, "agent": st.agent, "agent_since": st.agent_since,
                        "blocked": st.blocked, "blocked_since": st.blocked_since,
                        "title": st.title, "model": st.model,
                        "ctx_pct": st.ctx_pct, "ctx_used": st.ctx_used, "ctx_size": st.ctx_size,
                    })
                })
                .collect();
            json!({
                "id": d.id, "name": d.name, "root": d.root, "left_off": d.left_off,
                "visited_at": d.visited_at, "parked": d.parked, "touched": touched,
                "panes": panes, "open": open, "done": notes_done, "suggested": suggested, "next": next,
                "last": last, "git": git.as_deref(), "pulse": pulse,
                // By name, for Home's Keys widget; never a value.
                "keys": d.keys,
            })
        })
        .collect();
    days.sort_by_key(|r| r["at"].as_i64().unwrap_or(0));
    (json!(cards), json!(days))
}

/// What git says about a desk's folder, for its rail: the repository's page
/// on the web. The same half-minute cache Home reads (`crate::git`), off the
/// runtime; `null` for a folder with no repository or no remote.
pub(crate) async fn desk_git(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let app2 = app.clone();
    let git = tokio::task::spawn_blocking(move || {
        app2.git
            .read(std::path::Path::new(&desk.root), crate::store::now())
    })
    .await
    .ok()
    .flatten();
    Json(json!({ "remote": git.as_deref().and_then(|g| g.remote.clone()) })).into_response()
}

/// The reader opened a desk: Home's "last touched" and the desk it offers to
/// pick up are read from this.
pub(crate) async fn visit_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.visit_desk(id) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct ParkBody {
    /// Park with this next step; absent takes the desk down off the shelf.
    #[serde(default)]
    pub(crate) next: Option<String>,
}

/// Put a desk on the shelf with its next step, or take it down. What it was
/// comes back, for the Undo in the row.
pub(crate) async fn park_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<ParkBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.park_desk(id, b.next.as_deref()) {
        Ok(Some(was)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "was": was })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct WeekBody {
    pub(crate) title: String,
    pub(crate) content: String,
}

/// A week of a desk's log, as a document in the desk's own project: the
/// page writes the markdown from the rows it drew, and the folder it is filed
/// under is the desk's, never one the page names.
pub(crate) async fn desk_week(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<WeekBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let payload = Payload {
        content: Some(b.content),
        title: Some(b.title.chars().take(200).collect()),
        workflow: Some("Your days".into()),
        lang: Some("md".into()),
        cwd: Some(desk.root),
        origin: Some("home".into()),
        sender: Some("snyvi".into()),
        ..Default::default()
    };
    match receive_and_emit(&app, payload).await {
        Ok(received) => Json(json!({ "ok": true, "id": received.doc.id })).into_response(),
        Err(no) => *no,
    }
}

/// One line for a desk's list. Bounded and trimmed by `desk::add_note`, not
/// here: the cap belongs beside the list it is a cap on.
#[derive(Deserialize)]
pub(crate) struct NoteTextBody {
    pub(crate) text: String,
}

/// What changed about a line. Either half may be absent, so ticking a row off
/// does not have to send its text back with it.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct NoteEditBody {
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) done: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct NewDeskBody {
    /// A browse root's id, and the path of a folder inside it -- the two things
    /// every directory row in the sidebar already carries. None is a desk on
    /// no folder in particular, which starts in the home directory.
    #[serde(default)]
    pub(crate) root: Option<String>,
    #[serde(default)]
    pub(crate) path: String,
    /// Or a project, by id: the folder its agents wrote from, which the store
    /// holds. The page names the project, never the path.
    #[serde(default)]
    pub(crate) project: Option<i64>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct LayoutBody {
    pub(crate) col: f64,
    pub(crate) row: f64,
    /// The slot in full view, 0 for the grid; left out keeps what is there.
    #[serde(default)]
    pub(crate) full: Option<i64>,
}

#[derive(Deserialize)]
pub(crate) struct MoveBody {
    pub(crate) from: i64,
    pub(crate) to: i64,
}

#[derive(Deserialize)]
pub(crate) struct NewPaneBody {
    /// What to re-run when the reader asks for it. Nothing here means a shell,
    /// and nothing here starts anything: Phase 3 spawns, this phase records.
    #[serde(default)]
    pub(crate) cmd: Option<String>,
}

/// Every desk, with its panes, and how many panes are open across them.
pub(crate) async fn desks(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match (app.store.desks(), app.store.panes_open()) {
        (Ok(desks), Ok(panes)) => Json(json!({
            "desks": with_status(&app, &desks),
            // So a pane's header can say `~/snyvi` rather than the whole path.
            "home": dirs::home_dir(),
            "panes": panes,
            "per_desk": crate::desk::PER_DESK,
        }))
        .into_response(),
        (Err(e), _) | (_, Err(e)) => err(e),
    }
}

/// The desks, each pane carrying what its runtime says about it: running or
/// not, blocked or not, and the rest of what the rail draws.
pub(crate) fn with_status(app: &App, desks: &[crate::desk::Desk]) -> serde_json::Value {
    let mut v = serde_json::to_value(desks).unwrap_or_default();
    for d in v.as_array_mut().into_iter().flatten() {
        for p in d["panes"].as_array_mut().into_iter().flatten() {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            p["status"] = serde_json::to_value(app.panes.status(&id)).unwrap_or_default();
        }
    }
    v
}

/// A new desk, on a folder, on a project's folder, or on none.
///
/// The folder arrives as a root id and a relative path rather than as an
/// absolute one, so it goes through `resolve` -- the same guard the terminal
/// button and every byte `browse_file` reads go through, which is what keeps a
/// path from the page inside the root it names. A project arrives as its id,
/// and its folder is the one the store recorded, as the terminal button's is.
pub(crate) async fn create_desk(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NewDeskBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // No folder is the home directory, which the daemon names and the page
    // does not: nothing from the page reaches the filesystem on this path.
    let (dir, fallback) = match &b.root {
        Some(root) => match app.browse.resolve(root, &b.path) {
            Ok(dir) => (dir, None),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "no such folder" })),
                )
                    .into_response()
            }
        },
        None if b.project.is_some() => match b.project.and_then(|id| app.store.project_root(id)) {
            Some(root) => (std::path::PathBuf::from(root), None),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "no such project" })),
                )
                    .into_response()
            }
        },
        None => match dirs::home_dir() {
            Some(home) => (home, Some("desk")),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "there is no home directory to start in" })),
                )
                    .into_response()
            }
        },
    };
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a desk is rooted at a folder" })),
        )
            .into_response();
    }
    // A desk on the home directory would otherwise be named after the user.
    let name = b
        .name
        .as_deref()
        .and_then(clean_name)
        .or(fallback.map(String::from));
    match app
        .store
        .create_desk(&dir.to_string_lossy(), name.as_deref())
    {
        Ok(desk) => {
            desks_moved(&app);
            (StatusCode::CREATED, Json(json!({ "desk": desk }))).into_response()
        }
        Err(e) => err(e),
    }
}

/// The documents the panes on a desk have sent, for the rail's Documents
/// list. Forty is more than a rail shows without scrolling and fewer than a
/// long day of a file being watched produces; the library has the rest.
pub(crate) async fn desk_docs(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let removed = app.store.desk_docs(id, 40, true).unwrap_or_default();
    match app.store.desk_docs(id, 40, false) {
        Ok(docs) => Json(json!({ "docs": docs, "removed": removed })).into_response(),
        Err(e) => err(e),
    }
}

/// The reader takes a document off this desk's list, from its ✕. The
/// document stays in the library, the Inbox and search: this is the desk's
/// list, and nothing is deleted. The other windows hear it (`deskdocs`).
pub(crate) async fn remove_desk_doc(
    State(app): S,
    headers: HeaderMap,
    Path((id, doc)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    desk_doc_off(&app, id, &doc, true)
}

/// Undo, or Show's way back: the document is on the desk's list again.
pub(crate) async fn restore_desk_doc(
    State(app): S,
    headers: HeaderMap,
    Path((id, doc)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    desk_doc_off(&app, id, &doc, false)
}

pub(crate) fn desk_doc_off(app: &App, id: i64, doc: &str, off: bool) -> Response {
    match app.store.set_desk_doc_off(id, doc, off) {
        Ok(true) => {
            emit(app, "deskdocs", json!({ "desk": id }));
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's own list, which is the reader's and not an agent's: `/api/notes`
/// is an agent's asides, and the two never meet. Behind the same gate as the rest
/// of a desk, so what someone wrote on theirs is as unreachable from a tab as
/// their panes are.
///
/// Every write below tells the other windows (`desknotes`), as an agent's tick
/// does: Home counts every desk's list, and a second window on the same desk
/// was showing a list that another had changed. A write is a line committed --
/// Enter, a tick, a ✕ -- never a keystroke, so it is not an event per key.
pub(crate) async fn desk_notes(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.desk_notes(id) {
        Ok(mut notes) => {
            settle_stages(&app, &mut notes);
            Json(json!({ "notes": notes })).into_response()
        }
        Err(e) => err(e),
    }
}

/// A line said to be `working` is only still being worked on while the
/// conversation that said so is going, in the pane it was said from: a
/// session that ended, a panel closed, a daemon restarted, and the line is
/// back at the stage before (`desk::settle_stage`). While it holds, the line
/// carries the panel's name as the reader sees it. Read, never written: the
/// stage in the store is what the agent said, and this is what is true now.
pub(crate) fn settle_stages(app: &App, notes: &mut [crate::desk::DeskNote]) {
    for n in notes.iter_mut().filter(|n| n.stage == "working") {
        let s = app.panes.status(&n.stage_pane);
        let pane = if s.running && !s.agent.is_empty() {
            app.store.pane(&n.stage_pane).ok().flatten()
        } else {
            None
        };
        let pane = pane.filter(|p| p.pane.agent_session == n.stage_session);
        if let Some(p) = &pane {
            n.stage_panel = if p.pane.name.is_empty() {
                format!("panel {}", p.pane.slot)
            } else {
                p.pane.name.clone()
            };
        }
        crate::desk::settle_stage(n, pane.is_some());
    }
}

pub(crate) async fn add_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteTextBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.add_desk_note(id, &b.text) {
        // One refusal for three states -- no such desk, an empty line, a full
        // list -- because the page has just been told the count and can say
        // which it is; the daemon repeating it would be two sources for one
        // sentence.
        Ok(Some(note)) => {
            notes_moved(&app, id);
            (StatusCode::CREATED, Json(json!({ "note": note }))).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a desk keeps {} notes", crate::desk::NOTES_PER_DESK) })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// Rewrite a line, tick it off, or both. An emptied line is taken off the list
/// rather than kept as a blank row, which is what `desk::set_note` does with it.
pub(crate) async fn set_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteEditBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_desk_note(id, note, b.text.as_deref(), b.done) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Take a line off the list. The row is kept and `restore` puts it back: this
/// path deletes nothing, which is why it does not ask twice the way closing a
/// desk does.
pub(crate) async fn remove_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.remove_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn restore_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.restore_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Keep an agent's suggestion: it is an ordinary line of the reader's from
/// here. Its ✕ is `remove_desk_note`, as any row's.
pub(crate) async fn keep_desk_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.keep_desk_note(id, note) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's list changed: every window that shows it -- its rail, Home --
/// asks for it again. The desk's id and nothing of what is on it, for the
/// reason `desks_moved` gives: the stream reaches tabs too.
/// How big a picture on a line may be: a screenshot of a whole screen, with room.
pub(crate) const NOTE_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A picture pasted or dropped on a line: kept in `note_images/`, named by
/// its content so the same picture twice is one file, and put at the end of
/// the line's pictures. The answer is the line's pictures now.
pub(crate) async fn add_note_image(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let ext = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
    {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({ "error": "an image, as png, jpeg, gif or webp" })),
            )
                .into_response()
        }
    };
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "an empty image" })),
        )
            .into_response();
    }
    let dir = app.paths.data_dir.join(crate::desk::NOTE_IMAGES);
    let name = format!("{}.{ext}", &blake3::hash(&body).to_hex()[..16]);
    let file = dir.join(&name);
    if !file.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
            return err(anyhow::anyhow!("keeping the picture: {e}"));
        }
    }
    match app.store.add_note_image(id, note, &name) {
        Ok(Some(images)) => {
            notes_moved(&app, id);
            Json(json!({ "name": name, "images": images })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("a line holds {} pictures", crate::desk::IMAGES_PER_NOTE) })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct NoteImagesBody {
    pub(crate) images: Vec<String>,
}

/// A line's pictures, set whole: one taken off, or Undo putting the list back.
/// The files stay; only the line's list changes.
pub(crate) async fn set_note_images(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(i64, i64)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NoteImagesBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_note_images(id, note, &b.images) {
        Ok(true) => {
            notes_moved(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A picture on a line, for the page to draw. Behind the gate like the rest
/// of a desk: the page fetches it with the capability and shows the bytes.
pub(crate) async fn note_image(
    State(app): S,
    headers: HeaderMap,
    Path((_id, name)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !crate::desk::image_name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let kind = match name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "image/webp",
    };
    match std::fs::read(
        app.paths
            .data_dir
            .join(crate::desk::NOTE_IMAGES)
            .join(&name),
    ) {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, kind),
                (
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) fn notes_moved(app: &App, desk: i64) {
    emit(app, "desknotes", json!({ "desk": desk }));
}

/// The reader writes, rewrites or clears where the work on a desk was left,
/// in the desk's head. The answer carries the one it replaced, `was`, which
/// the page's Undo sends back as it came -- its time and its author with it.
pub(crate) async fn desk_left_off(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<crate::desk::LeftOff>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_left_off(id, &b) {
        Ok(Some(was)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "was": was })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A desk's keys by name: its own and the every-desk ones, with when a panel
/// last started with each. No value is ever in this answer.
pub(crate) async fn desk_keys(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.desk_keys(id) {
        Ok(keys) => Json(json!({ "keys": keys })).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct KeyBody {
    pub(crate) name: String,
    pub(crate) value: String,
    #[serde(default)]
    pub(crate) provider: String,
    /// For every desk rather than this one.
    #[serde(default)]
    pub(crate) every: bool,
}

#[derive(Deserialize, Default)]
pub(crate) struct KeyWhere {
    #[serde(default)]
    pub(crate) every: bool,
}

/// Keep a key for a desk, or for every desk: the value to the keychain (or
/// the 0600 file when no keychain answers), the name to the store. The value
/// is in no log, no event and no response; `kept` says where it went.
pub(crate) async fn add_desk_key(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<KeyBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let name = b.name.trim().to_string();
    if let Err(why) = crate::secrets::valid_name(&name) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": why })),
        )
            .into_response();
    }
    let value = b.value.trim().to_string();
    if value.is_empty() || value.len() > 4096 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "a key is one line, up to 4 KB" })),
        )
            .into_response();
    }
    if !matches!(app.store.desk(id), Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let desk_id = if b.every { crate::desk::EVERY_DESK } else { id };
    let secrets = app.secrets.clone();
    let (n, v) = (name.clone(), value);
    let kept = match tokio::task::spawn_blocking(move || secrets.keep(desk_id, &n, &v)).await {
        Ok(Ok(kept)) => kept,
        Ok(Err(e)) => return err(e),
        Err(e) => return err(anyhow::anyhow!("keeping the key: {e}")),
    };
    if let Err(e) = app.store.add_desk_key(desk_id, &name, b.provider.trim()) {
        return err(e);
    }
    desks_moved(&app);
    Json(json!({ "ok": true, "kept": kept })).into_response()
}

/// Take a key off a desk (or off every desk): the name from the store, the
/// value from wherever it was kept. The window held the row for its Undo
/// before asking, so this is the end of it.
pub(crate) async fn remove_desk_key(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<KeyWhere>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let every = b.every;
    let desk_id = if every { crate::desk::EVERY_DESK } else { id };
    match app.store.remove_desk_key(desk_id, &name) {
        Ok(true) => {
            let secrets = app.secrets.clone();
            let n = name.clone();
            let _ = tokio::task::spawn_blocking(move || secrets.forget(desk_id, &n)).await;
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Whether a Claude starting in a panel is handed the desk brief: on unless
/// the reader turned it off in About. A file, not a row: the hook's route
/// reads it on every session start, and it is the daemon's own setting.
pub(crate) fn brief_on(app: &App) -> bool {
    !app.paths.config_dir.join("brief-off").exists()
}

pub(crate) async fn brief_setting(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(json!({ "on": brief_on(&app) })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct BriefBody {
    pub(crate) on: bool,
}

pub(crate) async fn set_brief_setting(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<BriefBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let flag = app.paths.config_dir.join("brief-off");
    let done = if b.on {
        match std::fs::remove_file(&flag) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        std::fs::create_dir_all(&app.paths.config_dir).and_then(|_| std::fs::write(&flag, b""))
    };
    match done {
        Ok(()) => Json(json!({ "on": brief_on(&app) })).into_response(),
        Err(e) => err(e.into()),
    }
}

pub(crate) async fn rename_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some(name) = clean_name(&b.name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a name cannot be empty" })),
        )
            .into_response();
    };
    match app.store.rename_desk(id, &name) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "name": name })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct OrderBody {
    pub(crate) ids: Vec<i64>,
}

/// The reader's order for the desks, top first: every open desk, or nothing
/// changes (`desk::reorder`). Every page redraws its lists from the `desks`
/// event, this one too.
pub(crate) async fn order_desks(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<OrderBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.reorder_desks(&b.ids) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "the desks changed; this is not the whole list of them" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// The two divider fractions, which are the whole of a desk's geometry.
pub(crate) async fn desk_layout(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<LayoutBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.set_desk_layout(id, b.col, b.row, b.full) {
        // Silent: a drag ends hundreds of times an hour and no other window
        // needs to be told where this one's divider came to rest.
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A pane to another position on its desk, trading places with the pane
/// there. Every window redraws: the numbers moved, not only this one's grid.
pub(crate) async fn move_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<MoveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.move_pane(id, b.from, b.to) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn delete_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // Closed, not deleted (`desk::close`): its panes stop and keep their
    // text, as a closed panel's does, and its notes stay on it, until prune.
    match app.store.close_desk(id) {
        Ok(Some(panes)) => {
            for p in &panes {
                app.panes.forget(p);
            }
            desks_moved(&app);
            Json(json!({ "ok": true, "restore": format!("/api/desks/{id}/reopen") }))
                .into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A closed desk back, with its notes and the panels that closed with it,
/// stopped: the Undo on a close, and its row in the Removed list.
pub(crate) async fn reopen_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.reopen_desk(id) {
        Ok(true) => {
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A pane on a desk, in the lowest free slot, rooted where the desk is.
///
/// The cwd is the desk's own and is not taken from the caller: a desk is
/// already a folder the reader chose, and a second place for a path to come
/// from would be a second place to guard.
pub(crate) async fn open_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<NewPaneBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cmd = b.cmd.unwrap_or_default();
    match app.store.open_pane(desk.id, &desk.root, cmd.trim()) {
        Ok(crate::desk::Opened::Pane(pane)) => {
            desks_moved(&app);
            (StatusCode::CREATED, Json(json!({ "pane": pane }))).into_response()
        }
        // Full: another desk takes the next pane. There is no cap across desks.
        Ok(crate::desk::Opened::DeskFull) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk holds {}", crate::desk::PER_DESK), "full": "desk" })),
        )
            .into_response(),
        Ok(crate::desk::Opened::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn close_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.close_pane(&id) {
        // Stopped and kept: the row waits in `panes_closed` and the text on
        // disk, for Undo, until `prune`.
        Ok(true) => {
            app.panes.forget(&id);
            desks_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A closed pane back on its desk, stopped, in the lowest free slot: the
/// Undo on a close. 409 when the desk filled up in the meantime.
pub(crate) async fn restore_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.restore_pane(&id) {
        Ok(crate::desk::Restored::Pane(pane)) => {
            desks_moved(&app);
            Json(json!({ "pane": pane })).into_response()
        }
        Ok(crate::desk::Restored::DeskFull) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk holds {}", crate::desk::PER_DESK), "full": "desk" })),
        )
            .into_response(),
        Ok(crate::desk::Restored::Gone) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Call a pane something; empty gives it back to its program's title.
pub(crate) async fn rename_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    renamed(&app, &id, &b.name)
}

/// The one rename, the reader's ✎ and an agent's `name_panel` alike.
pub(crate) fn renamed(app: &App, id: &str, name: &str) -> Response {
    match app.store.rename_pane(id, name) {
        Ok(true) => {
            desks_moved(app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Tell the windows that the list changed.
///
/// A nudge and nothing in it. The event stream goes to every page, tabs
/// included, and a pane's command and its folder are the desk's business, not
/// a tab's: so a window hearing this asks `/api/desks` again, with its
/// capability, and a tab hearing it can ask nothing.
pub(crate) fn desks_moved(app: &App) {
    emit(app, "desks", json!({}));
}

#[derive(Deserialize)]
pub(crate) struct StartBody {
    /// What to run, as typed into the pane's `Start`. Absent means what the
    /// pane ran last; empty means the shell.
    #[serde(default)]
    pub(crate) cmd: Option<String>,
    /// Resume the conversation the pane last had, instead of `cmd`. The
    /// command is built here, from the id the pane kept, never from the page.
    #[serde(default)]
    pub(crate) resume: bool,
    /// The resume is the page's own, after a restart, not a click: honoured
    /// only while this daemon still holds the pane's mark. A mark that lapsed
    /// while its panel sat unshown starts `cmd`, with the conversation offered.
    #[serde(default)]
    pub(crate) marked: bool,
    #[serde(default = "default_cols")]
    pub(crate) cols: u16,
    #[serde(default = "default_rows")]
    pub(crate) rows: u16,
    /// The accent the window wears, `#rrggbb`, as its CSS resolved it. The
    /// pane's prompt is drawn in it; absent means snyvi's own.
    #[serde(default)]
    pub(crate) accent: String,
}

pub(crate) fn default_cols() -> u16 {
    80
}

pub(crate) fn default_rows() -> u16 {
    24
}

/// Start a pane's process. The only way one starts: this request, from a
/// click in a window holding the capability. Nothing on a timer, nothing at
/// daemon start, and nothing derived from a document -- premise 3.
pub(crate) async fn start_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<StartBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(placed)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let lapsed = b.resume && b.marked && !app.panes.marked(&id);
    let offer = lapsed && app.panes.offered(&id);
    // A resume is a one-off: what `Start` re-runs stays what the reader typed.
    let cmd = if b.resume && !lapsed {
        // Built from the pane's kept id (`desk::row_to_pane`), never from
        // the page: empty when there is nothing to go back to.
        if placed.pane.resume.is_empty() {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "this panel has no conversation to resume" })),
            )
                .into_response();
        }
        placed.pane.resume.clone()
    } else {
        let cmd = b.cmd.unwrap_or_else(|| placed.pane.cmd.clone());
        if cmd.trim() != placed.pane.cmd {
            let _ = app.store.set_pane_cmd(&id, &cmd);
        }
        cmd
    };
    let live = app.panes.get(&id);
    // Where the shell last was; the desk's own folder if that one is gone.
    let cwd = if std::path::Path::new(&placed.pane.cwd).is_dir() {
        placed.pane.cwd.as_str()
    } else {
        placed.root.as_str()
    };
    // The desk's keys: names from the store, values from the keychain on a
    // blocking thread, into the child's environment and nowhere else. A key
    // whose value is nowhere is not set at all.
    let keys = app.store.desk_keys(placed.desk_id).unwrap_or_default();
    let env: Vec<(String, String)> = if keys.is_empty() {
        Vec::new()
    } else {
        let secrets = app.secrets.clone();
        let wanted = keys.clone();
        tokio::task::spawn_blocking(move || secrets.values(&wanted))
            .await
            .unwrap_or_default()
    };
    if !env.is_empty() {
        let found: Vec<_> = keys
            .iter()
            .filter(|k| env.iter().any(|(n, _)| n == &k.name))
            .cloned()
            .collect();
        let _ = app.store.touch_desk_keys(&found);
    }
    let start = crate::pane::Start {
        cwd,
        root: &placed.root,
        cmd: &cmd,
        desk: &placed.desk_name,
        slot: placed.pane.slot,
        cols: b.cols,
        rows: b.rows,
        accent: &b.accent,
        offer,
        env: &env,
    };
    match live.start(start, &app.panes) {
        Ok(status) => Json(json!({ "status": status })).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Hang up on a pane's process. The pane stays, stopped, with `Start` offered.
pub(crate) async fn stop_pane(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(_)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    app.panes.get(&id).stop();
    Json(json!({ "ok": true })).into_response()
}

/// An image pasted into a pane. A terminal cannot take a bitmap, so snyvi does
/// what it does with everything else: the image is received as a document,
/// named for the pane it came from, and what goes back to the page is a path
/// the page then types into the pane as the reader's paste.
///
/// A path and not the document's URL: the program on the other end is almost
/// always an agent, and an agent opens a file with its own tools and has no
/// reason to be able to fetch from this daemon. The file sits beside the
/// store, in `pastes/`, named by its content so pasting it twice is one file.
/// A sandboxed agent may not be allowed to read there; that is the one open
/// question this leaves, and `docs/DESK.md` says so.
pub(crate) async fn paste_image(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(placed)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = match headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
    {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({ "error": "an image, as png, jpeg, gif or webp" })),
            )
                .into_response()
        }
    };
    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "an empty paste" })),
        )
            .into_response();
    }
    let dir = app.paths.data_dir.join("pastes");
    let name = format!("{}.{ext}", &blake3::hash(&body).to_hex()[..16]);
    let file = dir.join(&name);
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
        return err(anyhow::anyhow!("keeping the pasted image: {e}"));
    }
    let payload = Payload {
        path: Some(file.to_string_lossy().to_string()),
        title: Some(format!(
            "Pasted into {} [{}]",
            placed.desk_name, placed.pane.slot
        )),
        workflow: Some(format!("{} pastes", placed.desk_name)),
        cwd: Some(placed.root.clone()),
        origin: Some("paste".into()),
        pane: Some(id.clone()),
        ..Default::default()
    };
    match receive_and_emit(&app, payload).await {
        Ok(received) => Json(json!({ "id": received.doc.id, "path": file })).into_response(),
        Err(no) => *no,
    }
}

#[derive(Deserialize)]
pub(crate) struct ResolveBody {
    /// The word under the pointer, as the page cut it out.
    pub(crate) word: String,
    /// Where it was: a panel (`desk` and `pane`), a document (`doc`), or a
    /// file in the folder reader (`root` and `path`).
    pub(crate) desk: Option<i64>,
    pub(crate) pane: Option<String>,
    pub(crate) doc: Option<String>,
    pub(crate) root: Option<String>,
    pub(crate) path: Option<String>,
    /// Asked on the click: open what the word names. Without it the answer
    /// only says whether it names anything, for the underline while Ctrl is
    /// held, and nothing is opened or remembered.
    #[serde(default)]
    pub(crate) open: bool,
}

/// A path the reader Ctrl-clicked (see `crate::resolve`).
///
/// The page names the word and where it stood, never a folder: the folders a
/// relative path is tried against are looked up here, from ids snyvi holds.
/// In a panel, the folder its program is in now, then the desk's. In a
/// document, the folder of the file it was sent from, then the desk it was
/// sent from, then its project's. In the folder reader, the file's folder,
/// then the folder open for reading.
///
/// Behind the desk's gate, as the folder dialog is: the answer says whether a
/// path exists, and the click opens it -- a file in the reader, a folder in
/// the file manager. Nothing is run.
pub(crate) async fn resolve_path(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<ResolveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let (Some(id), Some(pane)) = (b.desk, b.pane.as_deref()) {
        let Ok(Some(d)) = app.store.desk(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let Some(p) = d.panes.iter().find(|p| p.id == pane) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let now = app.panes.status(&p.id).cwd;
        bases.extend([now, p.cwd.clone(), d.root.clone()].map(std::path::PathBuf::from));
    } else if let Some(id) = b.doc.as_deref() {
        let Ok(Some(d)) = app.store.get(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        bases.extend(
            d.source_path
                .as_deref()
                .and_then(|p| std::path::Path::new(p).parent().map(|d| d.to_path_buf())),
        );
        if let Some(o) = &d.desk {
            if let Ok(Some(desk)) = app.store.desk(o.id) {
                bases.push(desk.root.into());
            }
        }
        bases.extend(
            app.store
                .project_root(d.project_id)
                .map(std::path::PathBuf::from),
        );
    } else if let Some(id) = b.root.as_deref() {
        let Some(root) = app.browse.get(id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        bases.extend(
            app.browse
                .resolve(id, b.path.as_deref().unwrap_or(""))
                .ok()
                .and_then(dir_of),
        );
        bases.push(root.path.into());
    }
    bases.retain(|d| !d.as_os_str().is_empty() && d.is_dir());
    bases.dedup();
    let home = dirs::home_dir();
    let Some(found) = crate::resolve::find(&b.word, &bases, home.as_deref()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let shown = crate::agents::tilde(&found.path);
    let kind = if found.dir { "dir" } else { "file" };
    if !b.open {
        return Json(json!({ "kind": kind, "path": shown, "line": found.line })).into_response();
    }
    if found.dir {
        if !platform::has_display() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "no desktop session to open a folder in" })),
            )
                .into_response();
        }
        return if platform::open_folder(&found.path) {
            Json(json!({ "kind": kind, "path": shown })).into_response()
        } else {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "nothing on this machine opens folders" })),
            )
                .into_response()
        };
    }
    // A file opens in the folder reader: under a folder already open for
    // reading when it is in one, or else under the first of the bases it is
    // in -- the panel's desk, the document's project -- or else its own
    // folder. A folder opened here is a row under Folders, as any other.
    let roots: Vec<(String, std::path::PathBuf)> = app
        .browse
        .list()
        .into_iter()
        .map(|r| (r.id, r.path.into()))
        .collect();
    let (id, rel) = match crate::resolve::under(&found.path, &roots) {
        Some((id, rel)) => (id.to_string(), rel),
        None => {
            let dir = bases
                .iter()
                .rev()
                .filter_map(|b| b.canonicalize().ok())
                .find(|b| found.path.starts_with(b))
                .or_else(|| found.path.parent().map(|p| p.to_path_buf()));
            let Some(root) = dir.and_then(|d| app.browse.open(&d).ok()) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            emit(&app, "browse", json!({ "roots": app.browse.list() }));
            let rel = found
                .path
                .strip_prefix(&root.path)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            (root.id, rel)
        }
    };
    Json(json!({ "kind": kind, "path": shown, "line": found.line, "root": id, "rel": rel }))
        .into_response()
}
