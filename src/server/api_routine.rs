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
use crate::due::every::every_times;
use crate::routine::{self, events, places, times, waits, Added, Made, Routine};

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
    let file = routine::file_state(root, r);
    v["file"] = json!(file);
    v["state"] = json!(r.state());
    // 1.63: its watch as it stands, for the row's line.
    let live = (!r.watch.is_empty())
        .then(|| super::routine_watch::live(r.id))
        .flatten();
    v["health"] = json!(routine_health(r, file, live.as_ref()));
    v["next_at"] = json!(r.due_at);
    if let Some(l) = &live {
        v["heard_at"] = json!(l.heard_at);
    }
    if !r.watch.is_empty() {
        v["watch_live"] = json!(live);
    }
    v
}

/// A routine's health in one word (1.66), for its row's dot and the brief:
/// `ok`; `late`, it ran badly or its watch is backing off and it will try
/// again; `stopped`, it cannot run until the reader does something; and
/// `paused`, `draft` or `offer` for the ones that are not meant to run.
pub(crate) fn routine_health(r: &Routine, file: &str, live: Option<&super::routine_watch::Live>) -> &'static str {
    match r.state() {
        "offer" => return "offer",
        "draft" => return "draft",
        "paused" => return "paused",
        _ => {}
    }
    if !r.stuck.is_empty() || matches!(file, "changed" | "gone" | "two") || live.is_some_and(|l| l.stopped) {
        return "stopped";
    }
    let bad = ["failed", "skipped", "gate failed", "limit", "stopped"];
    if bad.iter().any(|b| r.last_state.starts_with(b))
        || live.is_some_and(|l| !l.watching && !l.said.is_empty())
    {
        return "late";
    }
    "ok"
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
///
/// 1.63: the field is what-only, so a line needs no when; one it ends in is
/// still read, and a tail snyvi cannot read is a hint, not an error.
fn read_json(root: &std::path::Path, text: &str, now: i64) -> serde_json::Value {
    let text = text.trim();
    let Some(line) = routine::from_line(text) else {
        let first = text
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("");
        if text.starts_with('/') && !first.is_empty() {
            return json!({ "error": format!("no /{first} here: no command or skill by that name") });
        }
        return json!({});
    };
    let mut v = json!({ "name": line.name });
    match &line.every {
        Some(t) => {
            v["every"] = json!(t.words());
            v["next"] = json!(t.next_after(now, crate::due::offset()));
        }
        None => {
            let low = text.to_ascii_lowercase();
            let tail = ["every ", "daily", "weekdays"]
                .iter()
                .filter_map(|w| low.rfind(w))
                .max();
            if tail.is_some_and(|i| text.len() - i <= 24) {
                v["hint"] = json!("its when goes in its sheet: every day · every weekday · every mon · every 1st, and a time: 07:30");
            }
        }
    }
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
            "a routine is a command or your own words: /newsroom, or open PRs, summarise",
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
/// With its scripts' text after it (1.63, R6), so the diff and the keys
/// cover them too.
fn file_now(root: &std::path::Path, r: &Routine) -> Option<(places::Place, String)> {
    match routine::now_of(root, r) {
        Made::File(p, _) => Some(text_of(&p, &r.cmd)).map(|t| (p, t)),
        _ => None,
    }
}

/// A command's text as allowed: its file, then its scripts.
fn text_of(p: &places::Place, cmd: &str) -> String {
    let mut text = std::fs::read_to_string(&p.path).unwrap_or_default();
    text.push_str(&places::scripts_text(p, cmd));
    text
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
    let (runs, when, waiting) = app
        .store
        .clocked(|c, _| {
            Ok((
                routine::runs_of(c, r.id, 30)?,
                times::lines(&times::times_of(c, r.id)?),
                events::waiting(c, r.id)?,
            ))
        })
        .unwrap_or_default();
    let scripts = scripts_json(&root, r).await;
    json!({
        "times": when,
        "waiting": waiting,
        "scripts": scripts,
        "models": routine::MODELS,
        "efforts": routine::EFFORTS,
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

/// The routine's scripts folder and what is in it (R6), as the sheet lists
/// them; `null` for words, `{ folder, files: [] }` when there is none yet.
async fn scripts_json(root: &std::path::Path, r: &Routine) -> serde_json::Value {
    if r.words() {
        return json!(null);
    }
    let (root, rr) = (root.to_path_buf(), r.clone());
    tokio::task::spawn_blocking(move || {
        let Some(p) =
            places::from_file(&root, &rr.file).or_else(|| match routine::now_of(&root, &rr) {
                Made::File(p, _) => Some(p),
                _ => None,
            })
        else {
            return json!(null);
        };
        let folder = places::scripts_said(&p, &rr.cmd);
        let files: Vec<String> = places::scripts(&p, &rr.cmd)
            .and_then(|d| {
                places::script_files(&d).map(|v| {
                    v.iter()
                        .filter_map(|f| f.strip_prefix(&d).ok())
                        .map(|f| f.to_string_lossy().replace('\\', "/"))
                        .collect()
                })
            })
            .unwrap_or_default();
        json!({ "folder": folder, "files": files })
    })
    .await
    .unwrap_or(json!(null))
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
    // How a run takes answers is the command author's to change, not the
    // reader's: the sheet folds these under "For the command's author"
    // (audit 566d17f746, R5).
    if r.words() {
        v.push(item(
            true,
            "your answers to its questions go on in its own session",
            json!(null),
        ));
    } else if routine::continues(text) {
        v.push(json!({
            "ok": true,
            "says": format!("answers go to /{} continue:", r.cmd),
            "fix": null,
            "author": true,
        }));
    } else {
        v.push(json!({
            "ok": true,
            "says": "answers will resume the run's own session · add a continue form for a fresh one",
            "fix": null,
            "paste": CONTINUE_FORM,
            "author": true,
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

/// The keys a command file names: words like `OPENROUTER_API_KEY`. In its
/// prose any such word counts; inside a fenced block only what the shell
/// reads as one -- `$NAME`, `${NAME}`, `snyvi key NAME` -- since a code
/// block's `"key":"SHORT_KEY"` is an example's text, and a "not on this
/// desk" for it taught the reader to pass over the real ones (audit
/// 566d17f746, R6).
pub(crate) fn key_names(text: &str) -> Vec<String> {
    let keyish = |w: &str| {
        w.len() >= 6
            && w.starts_with(|c: char| c.is_ascii_uppercase())
            && ["_KEY", "_TOKEN", "_SECRET"].iter().any(|e| w.ends_with(e))
    };
    let word = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_';
    let mut v: Vec<String> = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        let mut at = 0;
        for w in line.split(|c: char| !word(c)) {
            let start = line[at..].find(w).map_or(at, |i| at + i);
            at = start + w.len();
            if w.is_empty() || !keyish(w) {
                continue;
            }
            let before = line[..start].trim_end_matches('{');
            let read = before.ends_with('$') || line[..start].ends_with("snyvi key ");
            if !fenced || read {
                v.push(w.to_string());
            }
        }
    }
    v.sort();
    v.dedup();
    v.truncate(8);
    v
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct SaveBody {
    name: String,
    /// Before 1.63, the one when; still read when `times` is not sent.
    every: String,
    /// 1.63: the When, whole. Absent keeps the times as they are.
    times: Option<Vec<TimeBody>>,
    gate: Option<String>,
    watch: Option<String>,
    shape: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    slim: Option<bool>,
    waits: String,
    minutes: i64,
    five_hour: i64,
}

/// One line of a When, as the sheet or an agent's offer sends it.
#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub(crate) struct TimeBody {
    pub(crate) every: String,
    pub(crate) words: String,
    pub(crate) gated: Option<bool>,
}

/// The longest gate or watch line.
const LINE_MAX: usize = 400;

/// A gate's or watch's line: one line, not too long.
fn command_ok(what: &str, line: &str) -> Result<String, String> {
    let line = line.trim();
    if line.chars().any(char::is_control) || line.chars().count() > LINE_MAX {
        return Err(format!("{what} is one line, {LINE_MAX} characters at most"));
    }
    Ok(line.to_string())
}

/// The When as the sheet sent it, read: each line a cadence and hours,
/// its words, its tick. A time with words is not gated unless ticked (C1).
fn times_ok(b: &SaveBody) -> Result<Option<Vec<times::Line>>, String> {
    let sent: Vec<TimeBody> = match &b.times {
        Some(t) => t.clone(),
        None if b.every.trim().is_empty() => return Ok(None),
        None => vec![TimeBody {
            every: b.every.clone(),
            ..TimeBody::default()
        }],
    };
    read_times(&sent).map(Some)
}

/// Lines of a When read: each a cadence and its hours, its words, its tick.
pub(crate) fn read_times(sent: &[TimeBody]) -> Result<Vec<times::Line>, String> {
    let mut v = Vec::new();
    for t in sent.iter().filter(|t| !t.every.trim().is_empty()) {
        let Some(times) = every_times(&t.every) else {
            return Err(format!("\"{}\" is not a time snyvi reads: try every day 07:30, every weekday 9 13:00, every mon 09:00, every 1st", t.every.trim()));
        };
        let Some(words) = times::words_ok(&t.words) else {
            return Err(format!(
                "a time's words are one short line, {} characters at most, not starting with /",
                times::WORDS_CHARS
            ));
        };
        let gated = t.gated.unwrap_or(words.is_empty());
        v.push(times::Line {
            times,
            words,
            gated,
        });
    }
    if times::count(&v) > times::MAX {
        return Err(format!("a routine has {} times at most", times::MAX));
    }
    Ok(v)
}

/// A routine's gate, watch, shape, model and effort, each read.
pub(crate) fn triggers_ok(
    gate: &str,
    watch: &str,
    shape: &str,
    model: &str,
    effort: &str,
) -> Result<routine::Triggers, String> {
    let gate = command_ok("Only if", gate)?;
    let watch = command_ok("Wakes on", watch)?;
    let shape = shape.trim().to_string();
    if !events::shape_ok(&shape) {
        return Err(
            "a shape is words and holes: tag <number>, id <number>, <word>, several joined by |"
                .into(),
        );
    }
    let (model, effort) = (model.trim().to_lowercase(), effort.trim().to_lowercase());
    if !routine::MODELS.contains(&model.as_str()) || !routine::EFFORTS.contains(&effort.as_str()) {
        return Err(
            "a model is haiku, sonnet, opus or fable, an effort low, medium or high".into(),
        );
    }
    Ok(routine::Triggers {
        gate,
        watch,
        shape,
        model,
        effort,
    })
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
    let when = match times_ok(&b) {
        Ok(w) => w,
        Err(why) => return refused(StatusCode::BAD_REQUEST, why),
    };
    let pick = |sent: &Option<String>, was: &str| sent.clone().unwrap_or_else(|| was.to_string());
    let t = match triggers_ok(
        &pick(&b.gate, &r.gate),
        &pick(&b.watch, &r.watch),
        &pick(&b.shape, &r.shape),
        &pick(&b.model, &r.model),
        &pick(&b.effort, &r.effort),
    ) {
        Ok(t) => t,
        Err(why) => return refused(StatusCode::BAD_REQUEST, why),
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
                let text = text_of(&p, &r.cmd);
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
    // A live routine keeps a when (C3): saved with no time and no watch, it
    // would never run, and Start refused it for that.
    let kept_times = match &when {
        Some(t) => !t.is_empty(),
        None => app
            .store
            .clocked(|c, _| times::times_of(c, r.id))
            .map(|t| !t.is_empty())
            .unwrap_or(true),
    };
    if r.started_at != 0 && !kept_times && t.watch.is_empty() {
        return refused(
            StatusCode::BAD_REQUEST,
            "a started routine needs a when: a time, or Wakes on -- or Pause it",
        );
    }
    let s = routine::Save {
        name,
        times: when,
        triggers: t,
        slim: b.slim.unwrap_or(r.slim),
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
            super::routine_watch::forgive(r.id);
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
                let text = text_of(&p, &r.cmd);
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
    if start
        && !app
            .store
            .clocked(|c, _| routine::has_when(c, r))
            .unwrap_or(false)
    {
        return Err("give it a when first: a time, or Wakes on".into());
    }
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
    super::routine_watch::forgive(r.id);
    if done && !r.words() {
        keep_allowed(&app.paths.data_dir, r.id, &text);
        // 1.66: what it may run and its words, as the reader allowed them;
        // and an agent's change that waited for this Allow, taken in.
        let (root, rr) = (root.to_path_buf(), r.clone());
        if let Some((h, sp)) = routine::split_now(&root, &rr).filter(|(h, _)| *h == hash) {
            let _ = app.store.clocked(|c, _| routine::set_split(c, r.id, &h, &sp));
        }
    }
    if done {
        let _ = app.store.clocked(|c, _| routine::take_pending(c, r.id));
    }
    Ok(done)
}

/// The words a try is given (1.63): what a time's words would be.
#[derive(Deserialize, Default)]
#[serde(default)]
struct ActBody {
    words: String,
}

/// A try's words (B6) are held to what a run could be woken with: a line
/// in the routine's shape, as its watch's would be, or the words of one of
/// its times. None is always fine.
fn try_words_ok(app: &App, r: &Routine, words: &str) -> bool {
    words.is_empty()
        || events::ok(&r.shape, words)
        || app
            .store
            .clocked(|c, _| times::times_of(c, r.id))
            .is_ok_and(|ts| ts.iter().any(|t| t.words == words))
}

/// The row's menu and the sheet's acts: `run` (Run now), `try` (Try once
/// now, with `{ words }` in its body when the sheet has them), `start`
/// (Start it), `allow`, `pause`, `resume`, `remove` (Cancel, on a draft),
/// `restore`, `stop` (1.63: the run under way).
pub(crate) async fn routine_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
    body: axum::body::Bytes,
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
            let words = serde_json::from_slice::<ActBody>(&body)
                .map(|b| b.words)
                .unwrap_or_default();
            let Some(words) = times::words_ok(&words) else {
                return refused(
                    StatusCode::BAD_REQUEST,
                    "a try's words are one short line, not starting with /",
                );
            };
            if !try_words_ok(&app, &r, &words) {
                return refused(
                    StatusCode::BAD_REQUEST,
                    "not in its shape: a try's words are what its watch would print, or one of its times' words",
                );
            }
            let ran = if act == "run" {
                super::routine_run::start(&app, r.id, "you").await
            } else {
                super::routine_run::try_with(&app, r.id, &words).await
            };
            return match ran {
                Ok(()) => Json(json!({ "ok": true })).into_response(),
                Err(why) => refused(StatusCode::CONFLICT, why),
            };
        }
        "stop" => {
            return if super::routine_run::stop(&app, &r) {
                Json(json!({ "ok": true })).into_response()
            } else {
                refused(StatusCode::CONFLICT, "nothing is running")
            };
        }
        "start" | "allow" => match allow_now(&app, &r, &root, act == "start") {
            Ok(d) => Ok(d),
            Err(why) => return refused(StatusCode::CONFLICT, why),
        },
        word => match routine::Act::of(word) {
            Some(a) => {
                if a == routine::Act::Resume || a == routine::Act::Restore {
                    super::routine_watch::forgive(r.id);
                }
                app.store.clocked(|c, now| routine::act(c, r.id, a, now))
            }
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

    /// An example inside a code block is not a key the run reads; what the
    /// shell reads there is (audit 566d17f746, R6).
    #[test]
    fn a_code_blocks_example_is_not_a_key() {
        let f = "Log it:\n\n```bash\nlog '{\"key\":\"SHORT_KEY\"}'\ncurl -H \"$API_TOKEN\" -d ${POST_SECRET} x\nT=$(snyvi key CLOUD_TOKEN)\n```\n";
        assert_eq!(
            key_names(f),
            vec!["API_TOKEN", "CLOUD_TOKEN", "POST_SECRET"]
        );
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
        let v = read_json(&dir.path, "/zz-snyvi-read", now);
        assert_eq!(
            (v["cmd"].as_str(), v.get("every")),
            (Some("zz-snyvi-read"), None),
            "a what with no when"
        );
        assert!(
            read_json(&dir.path, "/zz-snyvi-gone · every day", now)["error"]
                .as_str()
                .unwrap()
                .starts_with("no /zz-snyvi-gone here")
        );
        assert!(read_json(&dir.path, "news every fortnight", now)["hint"].is_string());
        assert_eq!(read_json(&dir.path, "buy milk", now)["words"], true);
        let v = read_json(&dir.path, "zz-snyvi-read · every day 09:30 13:00", now);
        assert_eq!(v["every"], "every day 09:30 13:00");
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

#[cfg(test)]
mod save_tests {
    use super::*;

    fn body(times: serde_json::Value) -> SaveBody {
        serde_json::from_value(json!({ "times": times })).unwrap()
    }

    #[test]
    fn the_when_is_read_line_by_line_and_a_time_with_words_is_not_gated() {
        let t = times_ok(&body(json!([
            { "every": "every day 09:30 13:00 17:30" },
            { "every": "every mon 09:30", "words": "case" },
            { "every": "every fri 18:00", "words": "week", "gated": true },
            { "every": "  " }
        ])))
        .unwrap()
        .unwrap();
        assert_eq!(t.len(), 3, "an empty line is no time");
        assert_eq!((t[0].times.at.len(), t[0].gated), (3, true));
        assert_eq!((t[1].words.as_str(), t[1].gated), ("case", false));
        assert!(t[2].gated, "ticked by the reader");
        assert!(
            times_ok(&body(
                json!([{ "every": "every day 1 2 3 4" }, { "every": "every mon 1 2 3" }])
            ))
            .is_err(),
            "six at most"
        );
        assert!(times_ok(&body(json!([{ "every": "every fortnight" }]))).is_err());
        assert!(times_ok(&body(json!([{ "every": "every day", "words": "/rm" }]))).is_err());
        // An older window sends `every` alone; nothing sent keeps them.
        let old: SaveBody = serde_json::from_value(json!({ "every": "every day 07:30" })).unwrap();
        assert_eq!(times_ok(&old).unwrap().unwrap().len(), 1);
        assert_eq!(times_ok(&SaveBody::default()).unwrap(), None);
        assert_eq!(
            times_ok(&body(json!([]))).unwrap(),
            Some(vec![]),
            "a draft with no when"
        );
    }

    #[test]
    fn a_gate_or_watch_is_one_line() {
        assert_eq!(command_ok("Only if", " gate.sh ").unwrap(), "gate.sh");
        assert!(command_ok("Only if", "a\nb").is_err());
        assert!(command_ok("Wakes on", &"x".repeat(401)).is_err());
    }
}
