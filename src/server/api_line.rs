//! 1.67: the line (`crate::desk::line`, plan f586a9fe09, stage 5).
//!
//! Three routes are the page's, behind `refuse_desk`: read a desk's line,
//! set its goal, its order or a note's done-when, and Start next. One is an
//! agent's, behind the token and a running pane (`agent_pane`): `next_work`
//! reads the next free note of its own desk's queue and claims it.
//!
//! Start next is the one place snyvi starts an agent on the reader's press
//! alone, so what it types is fixed: `claude` and snyvi's own sentence with
//! the note's number. Never the note's text, which a friend or an agent may
//! have written: the agent reads that itself, with `next_work`. The folder
//! is not the caller's either: a worktree beside the desk's repository,
//! named for the note (`git::worktree_for`). An agent cannot reach this
//! route, so no agent starts another.

use super::*;
use crate::desk::line;

#[derive(Deserialize, Default)]
pub(crate) struct LineBody {
    #[serde(default)]
    pub(crate) goal: Option<String>,
    /// The whole queue, in order: note ids.
    #[serde(default)]
    pub(crate) order: Option<Vec<i64>>,
    /// A note, and the command it is done when it passes.
    #[serde(default)]
    pub(crate) note: Option<i64>,
    #[serde(default)]
    pub(crate) done_when: Option<String>,
}

fn no(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// What the agent in a started panel is told: snyvi's words and a number.
fn words(note: i64) -> String {
    format!(
        "claude \"snyvi started this panel for desk note #{note}, in a worktree of its own. Call next_work to read it, send the plan, and wait for Approve.\""
    )
}

fn folder(p: &str) -> std::path::PathBuf {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ => std::path::PathBuf::from(p),
    }
}

pub(crate) async fn desk_line(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.clocked(|c, _| line::get(c, id)) {
        Ok(l) => Json(json!({ "line": l })).into_response(),
        Err(e) => err(e),
    }
}

/// The reader sets the goal, the order, or one note's done-when: whichever
/// the body carries. Answers the line as it is now.
pub(crate) async fn set_desk_line(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<LineBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let r = app.store.clocked(|c, _| {
        if let Some(g) = &b.goal {
            line::set_goal(c, id, g)?;
        }
        if let Some(ids) = &b.order {
            if !line::set_order(c, id, ids)? {
                return Ok(None);
            }
        }
        if let (Some(n), Some(w)) = (b.note, &b.done_when) {
            line::set_when(c, id, n, w)?;
        }
        line::get(c, id).map(Some)
    });
    match r {
        Ok(Some(l)) => {
            notes_moved(&app, id);
            Json(json!({ "line": l })).into_response()
        }
        Ok(None) => no(
            StatusCode::CONFLICT,
            format!("a line holds {} notes", line::QUEUE),
        ),
        Err(e) => err(e),
    }
}

/// Start next: the reader's press. The first queued note nobody holds gets a
/// worktree and a panel in it, started with snyvi's words, and is that
/// panel's from this moment.
pub(crate) async fn start_next(
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
    let next = match app.store.clocked(|c, _| line::get(c, id)) {
        Ok(l) => l.next,
        Err(e) => return err(e),
    };
    if next == 0 {
        return no(
            StatusCode::CONFLICT,
            "nothing in the line is free: every queued note is done or a panel has it",
        );
    }
    let (_, root) = group_root(&desk, 0);
    let root = folder(&root);
    let made = tokio::task::spawn_blocking(move || crate::git::worktree_for(&root, next))
        .await
        .ok()
        .flatten();
    let Some(tree) = made else {
        return no(
            StatusCode::CONFLICT,
            format!("git made no worktree for #{next}: the desk's folder is not a repository, or the folder beside it is taken"),
        );
    };
    match app
        .store
        .open_pane_on(desk.id, &tree, &words(next), false, (0, false))
    {
        Ok(crate::desk::Opened::Pane(pane)) => {
            let claimed = app
                .store
                .clocked(|c, now| line::claim(c, id, next, &pane.id, &tree, now));
            if let Err(e) = claimed {
                return err(e);
            }
            desks_moved(&app);
            notes_moved(&app, id);
            (
                StatusCode::CREATED,
                Json(json!({ "pane": pane, "note": next, "tree": tree })),
            )
                .into_response()
        }
        Ok(crate::desk::Opened::DeskFull) => no(
            StatusCode::CONFLICT,
            format!(
                "this desk holds {}: close a panel or send one to the back, then Start next",
                crate::desk::GRID
            ),
        ),
        Ok(crate::desk::Opened::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// An agent asks for its next piece of work: `next_work`. The note it holds,
/// or the first free one in its desk's queue, claimed for its panel.
pub(crate) async fn pane_next_work(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    match app
        .store
        .clocked(|c, now| line::next_for(c, desk, &id, now))
    {
        Ok(Some(w)) => {
            if !w.held {
                notes_moved(&app, desk);
            }
            Json(json!({ "work": w })).into_response()
        }
        Ok(None) => {
            let goal = app
                .store
                .clocked(|c, _| line::goal(c, desk))
                .unwrap_or_default();
            Json(json!({ "work": null, "goal": goal })).into_response()
        }
        Err(e) => err(e),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn what_start_next_types_is_snyvis_words_and_a_number() {
        let w = super::words(250);
        assert!(w.starts_with("claude \"snyvi started this panel for desk note #250,"));
        assert!(w.ends_with('"'));
        assert_eq!(w.matches('"').count(), 2);
        assert!(!w.contains(['$', '`', '!', '\\', '\'']));
    }
}
