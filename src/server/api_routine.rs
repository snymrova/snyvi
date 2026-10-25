//! Routines over HTTP (`crate::routine`, 1.50): the window's, and only the
//! window's. Every route is behind the desk's gate (`refuse_desk`), and a
//! routine is checked to be on the desk the route names. No route behind
//! the token makes, widens or runs one: an agent may offer a routine
//! (`suggest_desk_note` with `every`), and only the reader's Save in the
//! sheet makes the offer real.

use super::*;
use crate::due::every::every;
use crate::routine::{self, Added, Routine};

type Q = Query<std::collections::HashMap<String, String>>;

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// What a routine's row needs beyond the store: how its file stands.
fn row_json(r: &Routine, root: &std::path::Path) -> serde_json::Value {
    let mut v = json!(r);
    v["file"] = json!(routine::file_state(root, r));
    v
}

/// The routine `row` when it is on the desk `id`.
fn on_desk(app: &App, id: i64, row: i64) -> Option<(Routine, crate::desk::Desk)> {
    let r = app.store.clocked(|c, _| routine::get(c, row)).ok()??;
    if r.desk_id != id {
        return None;
    }
    let desk = app.store.desk(id).ok()??;
    Some((r, desk))
}

/// A desk's routines on view, for the rail.
pub(crate) async fn desk_routines(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match app.store.clocked(|c, _| routine::for_desk(c, id)) {
        Ok(rs) => {
            let root = std::path::PathBuf::from(&desk.root);
            let rows: Vec<_> = rs.iter().map(|r| row_json(r, &root)).collect();
            Json(json!({ "routines": rows })).into_response()
        }
        Err(e) => err(e),
    }
}

/// The desk's slash commands, by name, for the chip under the notes field:
/// `every` is a routine's only before one of these.
pub(crate) async fn desk_commands(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    Json(json!({ "commands": routine::commands(std::path::Path::new(&desk.root)) })).into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct LineBody {
    text: String,
}

/// From the notes field: a line with a cadence whose first word is one of
/// the desk's commands. The reader typed it, so the file is allowed as it
/// is now.
pub(crate) async fn new_routine(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Q,
    Json(b): Json<LineBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(line) = routine::from_line(&b.text) else {
        return refused(
            StatusCode::BAD_REQUEST,
            "not a routine: a command and when, like newsroom · every day 07:30",
        );
    };
    let root = std::path::PathBuf::from(&desk.root);
    let Some(hash) = routine::hash_of(&root, &line.cmd) else {
        return refused(
            StatusCode::CONFLICT,
            format!(
                "every needs a /command: there is no .claude/commands/{}.md in this desk's folder",
                line.cmd
            ),
        );
    };
    match app
        .store
        .clocked(|c, now| routine::add(c, id, &line, &[], &hash, &routine::Offer::default(), now))
    {
        Ok(Added::Routine(r)) => {
            super::routine_run::changed(&app, id);
            (
                StatusCode::CREATED,
                Json(json!({ "routine": row_json(&r, &root) })),
            )
                .into_response()
        }
        Ok(Added::Full) => refused(
            StatusCode::CONFLICT,
            format!("a desk keeps {} routines", routine::PER_DESK),
        ),
        Ok(Added::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The sheet: the routine, its command file's first line, the keys the
/// file names and whether the desk has them, and its last runs.
pub(crate) async fn routine_sheet(
    State(app): S,
    headers: HeaderMap,
    Path((id, row)): Path<(i64, i64)>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some((r, desk)) = on_desk(&app, id, row) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let root = std::path::PathBuf::from(&desk.root);
    let text = std::fs::read_to_string(routine::command_file(&root, &r.cmd)).unwrap_or_default();
    let has: Vec<&str> = desk.keys.iter().map(|k| k.name.as_str()).collect();
    let keys: Vec<serde_json::Value> = key_names(&text)
        .into_iter()
        .map(|k| json!({ "name": k, "has": has.contains(&k.as_str()) }))
        .collect();
    let runs = app
        .store
        .clocked(|c, _| routine::runs_of(c, r.id, 30))
        .unwrap_or_default();
    Json(json!({
        "routine": row_json(&r, &root),
        "about": first_line(&text),
        "keys": keys,
        "runs": runs,
    }))
    .into_response()
}

/// What a command file says first: its first heading or line, unmarked.
fn first_line(text: &str) -> String {
    let body = text
        .strip_prefix("---")
        .and_then(|t| t.split_once("\n---").map(|(_, rest)| rest))
        .unwrap_or(text);
    crate::thread::line(
        body.lines()
            .map(|l| l.trim().trim_start_matches('#').trim())
            .find(|l| !l.is_empty())
            .unwrap_or(""),
        120,
    )
}

/// The keys a command file names: words like `OPENROUTER_API_KEY`.
fn key_names(text: &str) -> Vec<String> {
    let mut v: Vec<String> = text
        .split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'))
        .filter(|w| {
            w.len() >= 6
                && w.starts_with(|c: char| c.is_ascii_uppercase())
                && ["_KEY", "_TOKEN", "_SECRET"].iter().any(|e| w.ends_with(e))
        })
        .map(String::from)
        .collect();
    v.sort();
    v.dedup();
    v.truncate(8);
    v
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct SaveBody {
    name: String,
    every: String,
    waits: String,
    minutes: i64,
    five_hour: i64,
}

/// The sheet's Save: the cadence read again, the Waits list, the limits;
/// the command file allowed as it is now, and an offer the reader's own.
pub(crate) async fn save_routine(
    State(app): S,
    headers: HeaderMap,
    Path((id, row)): Path<(i64, i64)>,
    Query(q): Q,
    Json(b): Json<SaveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some((r, desk)) = on_desk(&app, id, row) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(e) = every(&b.every) else {
        return refused(
            StatusCode::BAD_REQUEST,
            format!("\"{}\" is not a time snyvi reads: try every day 07:30, every weekday 9, every mon 09:00, every 1st", b.every.trim()),
        );
    };
    let name = b.name.trim().trim_start_matches('/').trim();
    let name = if name.is_empty() {
        r.name.as_str()
    } else {
        name
    };
    if name.split_whitespace().next() != Some(r.cmd.as_str()) || name.chars().any(char::is_control)
    {
        return refused(
            StatusCode::BAD_REQUEST,
            format!("the line starts with its command, {}", r.cmd),
        );
    }
    let Some(waits) = routine::waits_ok(&b.waits) else {
        return refused(
            StatusCode::BAD_REQUEST,
            "Waits for you takes up to 12 patterns, one a line, 200 characters each",
        );
    };
    let Some(hash) = routine::hash_of(std::path::Path::new(&desk.root), &r.cmd) else {
        return refused(
            StatusCode::CONFLICT,
            format!("its command is gone: .claude/commands/{}.md", r.cmd),
        );
    };
    let s = routine::Save {
        name: crate::thread::line(name, 80),
        every: e,
        waits,
        minutes: if b.minutes > 0 { b.minutes } else { r.minutes },
        five_hour: if b.five_hour > 0 {
            b.five_hour
        } else {
            r.five_hour
        },
        hash,
    };
    match app.store.clocked(|c, now| routine::save(c, r.id, &s, now)) {
        Ok(true) => {
            super::routine_run::changed(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The row's menu and its Allow: `run` (Run now), `pause`, `resume`,
/// `allow`, `remove`, `restore`.
pub(crate) async fn routine_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some((r, desk)) = on_desk(&app, id, row) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let done = match act.as_str() {
        "run" => {
            return match super::routine_run::start(&app, r.id, "you").await {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(why) => refused(StatusCode::CONFLICT, why),
            };
        }
        "allow" => {
            let Some(hash) = routine::hash_of(std::path::Path::new(&desk.root), &r.cmd) else {
                return refused(
                    StatusCode::CONFLICT,
                    format!("its command is gone: .claude/commands/{}.md", r.cmd),
                );
            };
            app.store
                .clocked(|c, now| routine::allow(c, r.id, &hash, now))
        }
        word => match routine::Act::of(word) {
            Some(a) => app.store.clocked(|c, now| routine::act(c, r.id, a, now)),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    match done {
        Ok(true) => {
            super::routine_run::changed(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => refused(StatusCode::CONFLICT, "it is not on view, or was already"),
        Err(e) => err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_files_first_line_and_its_keys_are_read() {
        let f = "---\ndescription: x\n---\n\n# The newsroom: today's news\n\nUses $OPENROUTER_API_KEY and GH_TOKEN, not PATH or HOME_DIR.\n";
        assert_eq!(first_line(f), "The newsroom: today's news");
        assert_eq!(key_names(f), vec!["GH_TOKEN", "OPENROUTER_API_KEY"]);
        assert_eq!(first_line(""), "");
    }
}
