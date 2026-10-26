//! Routines over HTTP (`crate::routine`, 1.50; the field and the draft,
//! 1.53, plan f30461f2c1): the window's, and only the window's. Every route
//! is behind the desk's gate (`refuse_desk`), and a routine is checked to
//! be on the desk the route names. No route behind the token makes, widens
//! or runs one: an agent may offer a routine (`suggest_desk_note` with
//! `every`), and only the reader's Start makes it run on its own.
//!
//! The way in is one: a line in the Routines field is read here first
//! (`read`, for the chip), then made a draft (`new_routine`), whose sheet
//! comes back in the same reply. The sheet's Try once now runs it while the
//! reader watches; Start it allows the file as it is and gives it its hour.

use super::*;
use crate::due::every::every;
use crate::routine::{self, places, waits, Added, Made, Routine};

type Q = Query<std::collections::HashMap<String, String>>;

/// The longest diff a sheet shows, in lines.
const DIFF_LINES: usize = 400;

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// What a routine's row needs beyond the store: how its file stands, and
/// its state in one word.
fn row_json(r: &Routine, root: &std::path::Path) -> serde_json::Value {
    let mut v = json!(r);
    v["file"] = json!(routine::file_state(root, r));
    v["state"] = json!(r.state());
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

/// The commands and skills `/` lists in the Routines field: each name once,
/// as Claude Code would run it (`places::list`, cached by the folders'
/// times), with how many are the project's and how many the reader's.
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
    let root = std::path::PathBuf::from(&desk.root);
    let list = tokio::task::spawn_blocking(move || places::list(&root))
        .await
        .unwrap_or_default();
    let mine = list.iter().filter(|p| p.who == places::Who::You).count();
    let v: Vec<_> = list
        .iter()
        .map(|p| json!({ "name": p.name, "tag": p.tag(), "who": p.who, "kind": p.kind, "about": p.about, "file": p.file }))
        .collect();
    Json(json!({ "commands": v, "project": list.len() - mine, "yours": mine })).into_response()
}

/// What a line would become, said as the chip says it: the daemon's own
/// grammar, so the window has none of its own (D7).
fn read_json(root: &std::path::Path, text: &str, now: i64) -> serde_json::Value {
    let text = text.trim();
    let Some(line) = routine::from_line(text) else {
        // A command named, and no time yet.
        let first = text
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("");
        if text.starts_with('/') && !first.is_empty() {
            if let places::Resolved::One(p) = places::resolve(root, first) {
                return json!({ "when": true, "cmd": p.name, "where": p.tag(), "about": p.about });
            }
            return json!({ "error": format!("no /{first} here: no command or skill by that name") });
        }
        let low = text.to_ascii_lowercase();
        let tail = ["every ", "daily", "weekdays"]
            .iter()
            .filter_map(|w| low.rfind(w))
            .max();
        if tail.is_some_and(|i| text.len() - i <= 24) {
            return json!({ "error": "every day · every weekday · every mon · every 1st, and a time: 07:30" });
        }
        return json!({});
    };
    let mut v = json!({
        "every": line.every.words(),
        "next": line.every.next_after(now, crate::due::offset()),
        "name": line.name,
    });
    match routine::resolve(root, &line) {
        Made::File(p, _) => {
            v["cmd"] = json!(line.cmd);
            v["where"] = json!(p.tag());
            v["about"] = json!(p.about);
            v["path"] = json!(p.file);
            v["words"] = json!(false);
        }
        Made::Words => v["words"] = json!(true),
        Made::Two(a, b) => {
            v["error"] = json!(format!("two /{}: {a} and {b} -- rename one", line.cmd));
            v["two"] = json!([a, b]);
        }
        Made::NoFile(cmd) => {
            v["error"] = json!(format!("no /{cmd} here: no command or skill by that name"));
        }
    }
    v
}

/// `GET …/routines/read?text=`: what Enter would make of the line.
pub(crate) async fn read_line(
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
    let text = q.get("text").cloned().unwrap_or_default();
    let root = std::path::PathBuf::from(&desk.root);
    let v = tokio::task::spawn_blocking(move || read_json(&root, &text, crate::store::now()))
        .await
        .unwrap_or_default();
    Json(v).into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct LineBody {
    text: String,
}

/// From the Routines field: a draft, and its sheet in the same reply. A
/// line typed with `/` must name a command or skill; any other line whose
/// first word is none is the reader's own words. Nothing runs and nothing
/// is allowed until Try once now or Start it.
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
            "a routine is a line and when: /newsroom · every day 07:30, or your own words · every weekday 9",
        );
    };
    let root = std::path::PathBuf::from(&desk.root);
    let made = match routine::resolve(&root, &line) {
        Made::File(p, _) => Ok(p.file),
        Made::Words => Ok(String::new()),
        Made::Two(a, b) => Err(format!("two /{}: {a} and {b}", line.cmd)),
        Made::NoFile(cmd) => Err(format!("no /{cmd} here")),
    };
    let file = match made {
        Ok(f) => f,
        Err(why) => {
            let more = if why.starts_with("two") {
                "Claude Code's docs don't say which runs, so rename one"
            } else {
                "no command or skill by that name in this desk's folder or yours"
            };
            return refused(StatusCode::CONFLICT, format!("{why}: {more}"));
        }
    };
    let line = if file.is_empty() {
        line.into_words()
    } else {
        line
    };
    match app
        .store
        .clocked(|c, now| routine::add(c, id, &line, &[], &file, &routine::Offer::default(), now))
    {
        Ok(Added::Routine(r)) => {
            super::routine_run::changed(&app, id);
            (StatusCode::CREATED, Json(sheet_json(&app, &r, &desk).await)).into_response()
        }
        Ok(Added::Full) => refused(
            StatusCode::CONFLICT,
            format!("a desk keeps {} routines", routine::PER_DESK),
        ),
        Ok(Added::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The sheet: the routine, the file it runs and what it says, the Waits
/// the file suggests and what each pattern catches, Ready, the diff when it
/// changed, and its last runs.
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
    Json(sheet_json(&app, &r, &desk).await).into_response()
}

/// The text of the file a routine's name resolves to now, and where.
fn file_now(root: &std::path::Path, r: &Routine) -> Option<(places::Place, String)> {
    match routine::now_of(root, r) {
        Made::File(p, _) => {
            let text = std::fs::read_to_string(&p.path).unwrap_or_default();
            Some((p, text))
        }
        _ => None,
    }
}

async fn sheet_json(app: &Arc<App>, r: &Routine, desk: &crate::desk::Desk) -> serde_json::Value {
    let root = std::path::PathBuf::from(&desk.root);
    let (rr, rt) = (r.clone(), root.clone());
    let found = tokio::task::spawn_blocking(move || {
        let now = file_now(&rt, &rr);
        let large = now.as_ref().is_some_and(|(p, _)| places::large(p));
        (now, large)
    })
    .await
    .unwrap_or((None, false));
    let (place, text) = match &found.0 {
        Some((p, t)) => (Some(p), t.as_str()),
        None => (None, ""),
    };
    let has: Vec<&str> = desk.keys.iter().map(|k| k.name.as_str()).collect();
    let keys: Vec<serde_json::Value> = key_names(text)
        .into_iter()
        .map(|k| json!({ "name": k, "has": has.contains(&k.as_str()) }))
        .collect();
    let skill = place.is_some_and(|p| p.kind == places::Kind::Skill);
    let suggested: Vec<serde_json::Value> = waits::suggest(text, skill)
        .into_iter()
        .map(|s| {
            let on = r.waits.iter().any(|w| w == &s.pattern);
            json!({ "pattern": s.pattern, "lines": s.lines, "why": s.why, "on": on })
        })
        .collect();
    let catches: Vec<serde_json::Value> = r
        .waits
        .iter()
        .map(|w| json!({ "pattern": w, "lines": waits::catches(w, text) }))
        .collect();
    let state = routine::file_state(&root, r);
    let diff = if state == "changed" {
        diff_of(&app.paths.data_dir, r, text)
    } else {
        String::new()
    };
    let ready = ready(r, desk, text, state).await;
    let runs = app
        .store
        .clocked(|c, _| routine::runs_of(c, r.id, 30))
        .unwrap_or_default();
    json!({
        "routine": row_json(r, &root),
        "place": place.map(|p| json!({ "file": p.file, "where": p.tag(), "large": found.1 })),
        "about": place.map(|p| p.about.clone()).unwrap_or_default(),
        "keys": keys,
        "suggested": suggested,
        "catches": catches,
        "continues": !r.words() && routine::continues(text),
        "ready": ready,
        "diff": diff,
        "runs": runs,
    })
}

/// The lines to paste into a command's file for a `continue:` form: what
/// the sheet folds under its Ready line (plan 4f1379f4a4 §4, reworded).
const CONTINUE_FORM: &str = "## When it is given `continue: <answers>`\n\nThe user answered the questions the last run asked: $ARGUMENTS.\nGo on from the first step not done, with those answers; do not start again.\nAsk anything new with ask, one decision a question, and end with leave_off.";

/// One Ready line: whether it holds, what it says, and the fix -- a button
/// the sheet draws (`act`) or words.
fn item(ok: bool, says: impl Into<String>, fix: serde_json::Value) -> serde_json::Value {
    json!({ "ok": ok, "says": says.into(), "fix": fix })
}

/// Whether Claude Code has trusted the desk's folder: its own record,
/// `~/.claude.json`'s `projects[root].hasTrustDialogAccepted`. `None` when
/// it cannot be read.
fn trusted(root: &str) -> Option<bool> {
    let f = dirs::home_dir()?.join(".claude.json");
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(f).ok()?).ok()?;
    // A folder Claude Code has never opened has no entry: not trusted yet.
    let p = v.get("projects")?.get(root.trim_end_matches('/'));
    Some(
        p.and_then(|p| p.get("hasTrustDialogAccepted"))
            .and_then(|b| b.as_bool())
            == Some(true),
    )
}

/// Ready (T2, T12, T13): what would stop a run, read when the sheet opens.
/// It never blocks Try or Start: it says, and the reader decides.
async fn ready(
    r: &Routine,
    desk: &crate::desk::Desk,
    text: &str,
    state: &str,
) -> Vec<serde_json::Value> {
    let mut v = Vec::new();
    let root = desk.root.clone();
    let (trust, login) =
        tokio::task::spawn_blocking(move || (trusted(&root), crate::setup::starts_at_login()))
            .await
            .unwrap_or((None, None));
    match trust {
        Some(true) => v.push(item(true, "Claude Code trusts this folder", json!(null))),
        Some(false) => v.push(item(
            false,
            "Claude Code has not been trusted in this folder yet: a run would stop at its question",
            json!("Open a panel here once and answer it"),
        )),
        None => {}
    }
    if state == "two" {
        v.push(item(
            false,
            format!("two /{}: Claude Code's docs don't say which runs", r.cmd),
            json!("Rename one of them"),
        ));
    }
    let has: Vec<&str> = desk.keys.iter().map(|k| k.name.as_str()).collect();
    let names = key_names(text);
    let missing: Vec<&String> = names
        .iter()
        .filter(|k| !has.contains(&k.as_str()))
        .collect();
    if !missing.is_empty() {
        let m: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
        v.push(item(
            false,
            format!("not on this desk: {}", m.join(", ")),
            json!("Add it under Keys, by that name"),
        ));
    } else if !names.is_empty() {
        v.push(item(
            true,
            "the keys it names are on this desk",
            json!(null),
        ));
    }
    match login {
        Some(true) => v.push(item(true, "snyvi starts at login", json!(null))),
        Some(false) => v.push(item(
            false,
            "snyvi does not start at login: a routine runs only while snyvi does",
            json!({ "act": "login", "label": "Start at login" }),
        )),
        None => v.push(item(
            false,
            "a routine runs only while snyvi does",
            json!("Add snyvi to your login items"),
        )),
    }
    if desk.parked.is_some() {
        v.push(item(
            false,
            "this desk is parked: its hours are passed by",
            json!("Unpark it"),
        ));
    }
    let has_panel = !r.pane.is_empty() && desk.panes.iter().any(|p| p.id == r.pane);
    let back = desk
        .panes
        .iter()
        .filter(|p| crate::desk::in_back(p.slot))
        .count() as i64;
    if !has_panel && back >= crate::desk::BACK {
        v.push(item(
            false,
            "the desk's back is full: a run needs a panel there",
            json!("Close a panel in the back"),
        ));
    }
    if r.words() {
        v.push(item(
            true,
            "your answers to its questions go on in its own session",
            json!(null),
        ));
    } else if routine::continues(text) {
        v.push(item(
            true,
            format!("answers go to /{} continue:", r.cmd),
            json!(null),
        ));
    } else {
        v.push(json!({
            "ok": true,
            "says": "answers will resume the run's own session · add a continue form for a fresh one",
            "fix": null,
            "paste": CONTINUE_FORM,
        }));
    }
    v
}

/// Where the text a routine was allowed with is kept, for its diff.
fn allowed_file(data_dir: &std::path::Path, id: i64) -> std::path::PathBuf {
    data_dir
        .join("routines")
        .join(id.to_string())
        .join("allowed.md")
}

/// Keep the text as allowed (Allow, Start, a live routine's Save).
fn keep_allowed(data_dir: &std::path::Path, id: i64, text: &str) {
    let f = allowed_file(data_dir, id);
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, text);
}

/// What changed since it was allowed: a unified diff of the kept text
/// against the file now, cut at `DIFF_LINES` (T9).
fn diff_of(data_dir: &std::path::Path, r: &Routine, now: &str) -> String {
    let Ok(was) = std::fs::read_to_string(allowed_file(data_dir, r.id)) else {
        return String::new();
    };
    let d = similar::TextDiff::from_lines(was.as_str(), now)
        .unified_diff()
        .context_radius(2)
        .header("allowed", "now")
        .to_string();
    let mut lines: Vec<&str> = d.lines().take(DIFF_LINES + 1).collect();
    if lines.len() > DIFF_LINES {
        lines.truncate(DIFF_LINES);
        lines.push("…");
    }
    lines.join("\n")
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

/// The name a Save keeps: a command's line starts with its command; the
/// reader's words are any line that does not start with `/`.
fn name_ok(r: &Routine, name: &str) -> Result<String, String> {
    if name.chars().any(char::is_control) {
        return Err("one line, please".into());
    }
    if r.words() {
        if name.starts_with('/') {
            return Err("your words can't start with /: that would be a command".into());
        }
        return Ok(crate::thread::line(name, routine::WORDS_CHARS));
    }
    let name = name.trim_start_matches('/').trim();
    if name.split_whitespace().next() != Some(r.cmd.as_str()) {
        return Err(format!("the line starts with its command, {}", r.cmd));
    }
    Ok(crate::thread::line(name, routine::WORDS_CHARS))
}

/// The sheet's Save: the cadence read again, the Waits list, the limits, a
/// words routine's words; a live routine's file allowed as it is now, and
/// an offer made the reader's draft.
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
    let name = b.name.trim();
    let name = match name_ok(
        &r,
        if name.is_empty() {
            r.name.as_str()
        } else {
            name
        },
    ) {
        Ok(n) => n,
        Err(why) => return refused(StatusCode::BAD_REQUEST, why),
    };
    let Some(waits) = routine::waits_ok(&b.waits) else {
        return refused(
            StatusCode::BAD_REQUEST,
            "Waits for you takes up to 12 patterns, one a line, 200 characters each",
        );
    };
    let root = std::path::PathBuf::from(&desk.root);
    let (hash, file, text) = if r.words() {
        (String::new(), String::new(), String::new())
    } else {
        match routine::now_of(&root, &r) {
            Made::File(p, h) => {
                let text = std::fs::read_to_string(&p.path).unwrap_or_default();
                (h, p.file, text)
            }
            _ => {
                return refused(
                    StatusCode::CONFLICT,
                    format!("/{} is gone, or two files hold it", r.cmd),
                )
            }
        }
    };
    let s = routine::Save {
        name,
        every: e,
        waits,
        minutes: if b.minutes > 0 { b.minutes } else { r.minutes },
        five_hour: if b.five_hour > 0 {
            b.five_hour
        } else {
            r.five_hour
        },
        hash,
        file,
    };
    match app.store.clocked(|c, now| routine::save(c, r.id, &s, now)) {
        Ok(true) => {
            if r.started_at != 0 && !r.words() {
                keep_allowed(&app.paths.data_dir, r.id, &text);
            }
            super::routine_run::changed(&app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// Start it, or Allow: the file as it is now, hashed and kept for a later
/// diff. A words routine has none.
fn allow_now(app: &App, r: &Routine, root: &std::path::Path, start: bool) -> Result<bool, String> {
    let (hash, file, text) = if r.words() {
        (String::new(), String::new(), String::new())
    } else {
        match routine::now_of(root, r) {
            Made::File(p, h) => {
                let text = std::fs::read_to_string(&p.path).unwrap_or_default();
                (h, p.file, text)
            }
            Made::Two(a, b) => return Err(format!("two /{}: {a} and {b} -- rename one", r.cmd)),
            _ => {
                return Err(format!(
                    "/{} is gone: no command or skill by that name",
                    r.cmd
                ))
            }
        }
    };
    let done = app
        .store
        .clocked(|c, now| {
            if start {
                routine::start(c, r.id, &hash, &file, now)
            } else {
                routine::allow(c, r.id, &hash, &file, now)
            }
        })
        .map_err(|e| format!("{e:#}"))?;
    if done && !r.words() {
        keep_allowed(&app.paths.data_dir, r.id, &text);
    }
    Ok(done)
}

/// The row's menu and the sheet's acts: `run` (Run now), `try` (Try once
/// now), `start` (Start it), `allow`, `pause`, `resume`, `remove` (Cancel,
/// on a draft), `restore`.
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
    let root = std::path::PathBuf::from(&desk.root);
    let done = match act.as_str() {
        "run" | "try" => {
            let why = if act == "run" { "you" } else { "try" };
            return match super::routine_run::start(&app, r.id, why).await {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(why) => refused(StatusCode::CONFLICT, why),
            };
        }
        "start" | "allow" => match allow_now(&app, &r, &root, act == "start") {
            Ok(d) => Ok(d),
            Err(why) => return refused(StatusCode::CONFLICT, why),
        },
        word => match routine::Act::of(word) {
            Some(a) => app.store.clocked(|c, now| routine::act(c, r.id, a, now)),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    match done {
        Ok(true) => {
            super::routine_run::changed(&app, id);
            let r = app
                .store
                .clocked(|c, _| routine::get(c, r.id))
                .ok()
                .flatten();
            Json(json!({ "ok": true, "routine": r.map(|r| row_json(&r, &root)) })).into_response()
        }
        Ok(false) => refused(StatusCode::CONFLICT, "it is not on view, or was already"),
        Err(e) => err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_files_keys_are_read() {
        let f = "---\ndescription: x\n---\n\n# The newsroom: today's news\n\nUses $OPENROUTER_API_KEY and GH_TOKEN, not PATH or HOME_DIR.\n";
        assert_eq!(key_names(f), vec!["GH_TOKEN", "OPENROUTER_API_KEY"]);
    }

    #[test]
    fn the_chip_says_what_enter_would_make() {
        let dir = crate::store::tempdir::Dir::new("snyvi-routine-read");
        let cmds = dir.path.join(".claude").join("commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(cmds.join("zz-snyvi-read.md"), "# Read the news").unwrap();
        let now = 1_800_000_000;
        let v = read_json(&dir.path, "zz-snyvi-read · every day 7:30", now);
        assert_eq!(v["every"], "every day 07:30");
        assert_eq!(v["where"], "project · command");
        assert_eq!(v["about"], "Read the news");
        assert_eq!(v["words"], false);
        assert!(v["next"].as_i64().unwrap() > now);
        let v = read_json(&dir.path, "open PRs, summarise · every weekday 9", now);
        assert_eq!(
            (v["words"].as_bool(), v["name"].as_str()),
            (Some(true), Some("open PRs, summarise"))
        );
        assert_eq!(read_json(&dir.path, "/zz-snyvi-read", now)["when"], true);
        assert!(
            read_json(&dir.path, "/zz-snyvi-gone · every day", now)["error"]
                .as_str()
                .unwrap()
                .starts_with("no /zz-snyvi-gone here")
        );
        assert!(read_json(&dir.path, "news every fortnight", now)["error"].is_string());
        assert_eq!(read_json(&dir.path, "buy milk", now), json!({}));
    }

    #[test]
    fn a_save_keeps_a_commands_line_and_the_readers_words() {
        let c = Routine {
            name: "bench".into(),
            cmd: "bench".into(),
            ..Routine::default()
        };
        assert_eq!(name_ok(&c, "/bench main").unwrap(), "bench main");
        assert!(name_ok(&c, "rm -rf").is_err());
        let w = Routine::default();
        assert_eq!(name_ok(&w, "open PRs").unwrap(), "open PRs");
        assert!(
            name_ok(&w, "/bench").is_err(),
            "words never become a command"
        );
        assert!(name_ok(&w, "a\u{7}b").is_err());
    }

    #[test]
    fn a_changed_file_shows_what_changed_since_it_was_allowed() {
        let dir = crate::store::tempdir::Dir::new("snyvi-routine-diff");
        let r = Routine {
            id: 3,
            ..Routine::default()
        };
        assert_eq!(
            diff_of(&dir.path, &r, "x"),
            "",
            "nothing kept, nothing said"
        );
        keep_allowed(&dir.path, 3, "# News\nfetch\npublish\n");
        let d = diff_of(&dir.path, &r, "# News\nfetch\npublish --all\n");
        assert!(d.contains("-publish\n+publish --all"), "{d}");
    }
}
