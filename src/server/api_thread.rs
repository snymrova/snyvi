//! Threads, Your turn and suggested panels over HTTP (`crate::thread`, #90).
//!
//! Two sides, as the notes have. An agent in a panel files a thread, asks,
//! hands over and suggests on `/api/panes/{id}/…`, behind the token and a
//! running pane (`agent_pane`); the snyvi mod in that panel reports what it
//! saw git and gh do, mirrors Claude's own question and waits for its answer
//! there too. The page answers, moves, parks and puts away on
//! `/api/desks/{id}/…`, behind the desk's gate, with the desk in every
//! `WHERE`. Every change is the `desknotes` event the list already sends,
//! with the desk's id: a thread is the folder its notes sit in, the rail and
//! Home already read again on it, and the window's first paint needs no
//! new listener for it.

use super::*;
use crate::thread::{self, Ask, Asked, Move, Moved, Seen, Start, Started, Suggest, Suggested};
use std::time::Duration;

type Q = Query<std::collections::HashMap<String, String>>;

/// Every window showing this desk -- its rail, Home -- asks again; a held
/// question in the mod wakes on it too (`pane_wait_turn`).
pub(crate) fn threads_moved(app: &App, desk: i64) {
    notes_moved(app, desk);
}

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

// --- the agent's side ------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct StartBody {
    name: String,
    notes: Vec<i64>,
    folder: String,
    stage: String,
    by: String,
}

pub(crate) async fn pane_start_thread(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<StartBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let s = Start {
        name: b.name,
        notes: b.notes,
        folder: b.folder,
        stage: b.stage,
        by: b.by,
        pane: id,
    };
    let desk = placed.desk_id;
    match app.store.threads(|c, now| thread::start(c, desk, &s, now)) {
        Ok(Started::New(t)) => {
            threads_moved(&app, desk);
            (
                StatusCode::CREATED,
                Json(json!({ "thread": t, "again": false })),
            )
                .into_response()
        }
        Ok(Started::Again(t)) => {
            threads_moved(&app, desk);
            Json(json!({ "thread": t, "again": true })).into_response()
        }
        Ok(Started::Empty) => refused(StatusCode::BAD_REQUEST, "start_thread needs a name"),
        Ok(Started::BadStage) => refused(
            StatusCode::BAD_REQUEST,
            format!("a stage is one of {}", thread::STAGES.join(", ")),
        ),
        Ok(Started::Full) => refused(
            StatusCode::CONFLICT,
            format!(
                "this desk already has {} threads moving; ship, park or pick up one of them",
                thread::THREADS_PER_DESK
            ),
        ),
        Ok(Started::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct MoveBody {
    stage: String,
    next: String,
    pr: String,
    name: String,
    notes: Vec<i64>,
    /// The reader moved it from the panel (the mod's `/park`): told to the
    /// panel's Claude at its next prompt, as a move on the page is.
    reader: bool,
}

fn moved(app: &App, desk: i64, r: anyhow::Result<Moved>) -> Response {
    match r {
        Ok(Moved::Thread(t)) => {
            threads_moved(app, desk);
            Json(json!({ "thread": t })).into_response()
        }
        Ok(Moved::BadStage) => refused(
            StatusCode::BAD_REQUEST,
            format!("a stage is one of {}", thread::STAGES.join(", ")),
        ),
        Ok(Moved::BadPr) => refused(StatusCode::BAD_REQUEST, "a PR is its number"),
        Ok(Moved::NoThread) => refused(
            StatusCode::CONFLICT,
            "this panel has no thread yet; start one with start_thread",
        ),
        Err(e) => err(e),
    }
}

pub(crate) async fn pane_move_thread(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<MoveBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let m = Move {
        stage: b.stage,
        next: b.next,
        pr: b.pr,
        name: String::new(),
        notes: b.notes,
        pane: id,
        reader: b.reader,
    };
    let desk = placed.desk_id;
    let r = app
        .store
        .threads(|c, now| thread::move_thread(c, desk, None, &m, now));
    moved(&app, desk, r)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct AskBody {
    kind: String,
    text: String,
    options: Vec<String>,
    recommended: Option<i64>,
    link: String,
    via: String,
    by: String,
    cmd: String,
}

fn asked(app: &App, desk: i64, r: anyhow::Result<Asked>) -> Response {
    match r {
        Ok(Asked::Turn(t)) => {
            threads_moved(app, desk);
            (StatusCode::CREATED, Json(json!({ "turn": t }))).into_response()
        }
        Ok(Asked::Empty) => refused(StatusCode::BAD_REQUEST, "it needs one sentence"),
        Ok(Asked::BadKind) => refused(StatusCode::BAD_REQUEST, "kind is try, merge, key or run"),
        Ok(Asked::BadCmd) => refused(
            StatusCode::BAD_REQUEST,
            format!(
                "run needs cmd: one line, at most {} bytes, with no control characters",
                thread::CMD_BYTES
            ),
        ),
        Ok(Asked::BadOptions) => refused(
            StatusCode::BAD_REQUEST,
            "a question takes two to four options; a hand-over takes none",
        ),
        Ok(Asked::Full) => refused(
            StatusCode::CONFLICT,
            format!(
                "{} things are already waiting on the user on this desk; wait for an answer",
                thread::TURNS_PER_DESK
            ),
        ),
        Ok(Asked::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// `ask`, and the mod's mirror of Claude's own question (`via: dialog`).
pub(crate) async fn pane_ask(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AskBody>,
) -> Response {
    pane_turn(app, headers, id, b, true).await
}

/// `hand_over`: try, merge, key or run.
pub(crate) async fn pane_hand_over(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AskBody>,
) -> Response {
    pane_turn(app, headers, id, b, false).await
}

async fn pane_turn(
    app: Arc<App>,
    headers: HeaderMap,
    id: String,
    b: AskBody,
    decide: bool,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    // Each route takes its own kinds: a hand-over is not a question with no
    // options, and a question is not a hand-over.
    let kind = if decide { "decide".to_string() } else { b.kind };
    if !decide && kind == "decide" {
        return refused(StatusCode::BAD_REQUEST, "kind is try, merge, key or run");
    }
    let a = Ask {
        kind,
        text: b.text,
        options: b.options,
        recommended: b.recommended.unwrap_or(-1),
        link: b.link,
        via: b.via,
        by: b.by,
        pane: id,
        cmd: b.cmd,
    };
    let desk = placed.desk_id;
    let r = app.store.threads(|c, now| thread::ask(c, desk, &a, now));
    asked(&app, desk, r)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct SuggestPanelBody {
    name: String,
    cmd: String,
    folder: String,
    why: String,
    by: String,
}

pub(crate) async fn pane_suggest_panel(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<SuggestPanelBody>,
) -> Response {
    pane_suggest(app, headers, id, b, "panel").await
}

pub(crate) async fn pane_suggest_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<SuggestPanelBody>,
) -> Response {
    pane_suggest(app, headers, id, b, "desk").await
}

async fn pane_suggest(
    app: Arc<App>,
    headers: HeaderMap,
    id: String,
    b: SuggestPanelBody,
    kind: &str,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let s = Suggest {
        kind: kind.into(),
        name: b.name,
        cmd: b.cmd,
        folder: b.folder,
        why: b.why,
        by: b.by,
        pane: id,
    };
    let desk = placed.desk_id;
    match app.store.threads(|c, now| thread::suggest(c, desk, &s, now)) {
        Ok(Suggested::Card(card)) => {
            threads_moved(&app, desk);
            (StatusCode::CREATED, Json(json!({ "suggestion": card }))).into_response()
        }
        Ok(Suggested::Empty) => refused(
            StatusCode::BAD_REQUEST,
            if kind == "desk" {
                "suggest_desk needs a folder and why"
            } else {
                "suggest_panel needs a command and why"
            },
        ),
        Ok(Suggested::HasDesk(d)) => {
            let name = app
                .store
                .desk(d)
                .ok()
                .flatten()
                .map(|d| d.name)
                .unwrap_or_default();
            refused(
                StatusCode::CONFLICT,
                format!("that folder already has a desk, \"{name}\""),
            )
        }
        Ok(Suggested::Full) => refused(
            StatusCode::CONFLICT,
            format!(
                "{} suggestions are already waiting on this desk; wait until the user opens or removes one",
                thread::SUGGESTIONS_PER_DESK
            ),
        ),
        Ok(Suggested::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// The mod saw the panel's git or gh do something: a branch, commits, a PR,
/// the checks, a merge. Filed on the pane's thread, or nowhere.
pub(crate) async fn pane_seen(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<Seen>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    match app
        .store
        .threads(|c, now| thread::seen(c, desk, &id, &b, now))
    {
        // Only a thread that moved is worth an event: the mod says what it
        // saw on every run of gh, and most runs see the same thing.
        Ok(Some((t, changed))) => {
            if changed {
                threads_moved(&app, desk);
            }
            Json(json!({ "thread": t })).into_response()
        }
        Ok(None) => Json(json!({ "thread": null })).into_response(),
        Err(e) => err(e),
    }
}

/// The band's line above the mod's prompt: the pane's thread and what is
/// waiting on the reader. Empty when there is neither.
pub(crate) fn band_line(t: Option<&thread::Thread>, waiting: &[thread::Turn]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = t.filter(|t| t.stage != "shipped" || t.merged_at == 0) {
        parts.push(format!("▸ {}", t.name));
        parts.push(t.stage.clone());
        if !t.branch.is_empty() {
            parts.push(t.branch.clone());
        }
        if t.commits > 0 {
            parts.push(format!(
                "{} commit{}",
                t.commits,
                if t.commits == 1 { "" } else { "s" }
            ));
        }
        if !t.pr.is_empty() {
            parts.push(if t.ci.is_empty() {
                format!("PR {}", t.pr)
            } else {
                format!("PR {} {}", t.pr, t.ci)
            });
        }
    }
    if let Some(w) = waiting.first() {
        let what = match w.kind.as_str() {
            "decide" => "decide".to_string(),
            _ => thread::line(&w.text, 40),
        };
        let more = if waiting.len() > 1 {
            format!(" (+{})", waiting.len() - 1)
        } else {
            String::new()
        };
        parts.push(format!("your turn: {what}{more}"));
    }
    parts.join(" · ")
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BandQ {
    /// The tag of the band the mod has (`band_tag`): the answer is held until
    /// the band differs, or `WAIT` passes. Without one, the band at once.
    v: Option<String>,
}

/// The band: the pane's thread and what waits on the reader on its desk,
/// with the line the mod draws from them. With `v`, a long-poll: the mod
/// sends the tag of the band it has, and the answer waits until a change on
/// this desk gives a different one, or 204 after `WAIT`. A mod that sends no
/// `v` gets the band as before.
pub(crate) async fn pane_band(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<BandQ>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    band_held(&app, placed.desk_id, &id, q.v.as_deref(), WAIT).await
}

/// The band's JSON and its tag.
fn band_now(app: &App, desk: i64, pane: &str) -> anyhow::Result<(serde_json::Value, String)> {
    let (t, waiting) = app.store.threads(|c, _| {
        let t = thread::of_pane(c, desk, pane)?;
        // The mod's own dialog is on screen already; the band names the rest.
        let waiting = thread::waiting_on(c, desk, false)?;
        Ok((t, waiting))
    })?;
    let body = json!({
        "line": band_line(t.as_ref(), &waiting),
        "thread": t,
        "waiting": waiting.len(),
        "turns": waiting.iter().map(|w| json!({ "kind": w.kind, "text": w.text })).collect::<Vec<_>>(),
    });
    let tag = band_tag(&body);
    Ok((body, tag))
}

/// The desk a `desknotes` event is about; `None` for any other event.
fn desknotes_on(event: &str) -> Option<i64> {
    let data = event.strip_prefix("desknotes\n")?;
    serde_json::from_str::<serde_json::Value>(data)
        .ok()?
        .get("desk")?
        .as_i64()
}

/// A band's tag: a short hash of its JSON, what the mod sends back as `v`.
pub(crate) fn band_tag(body: &serde_json::Value) -> String {
    blake3::hash(body.to_string().as_bytes()).to_hex()[..8].to_string()
}

/// The band, held while it is the one the mod has. Subscribed before the
/// first look, so a change between the look and the wait is not missed;
/// only a `desknotes` for this desk is a reason to look again, since every
/// other desk's turns and threads are not in this band.
pub(crate) async fn band_held(
    app: &App,
    desk: i64,
    pane: &str,
    v: Option<&str>,
    wait: Duration,
) -> Response {
    let mut rx = app.events.subscribe();
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let (mut body, tag) = match band_now(app, desk, pane) {
            Ok(b) => b,
            Err(e) => return err(e),
        };
        if v != Some(tag.as_str()) {
            body["v"] = json!(tag);
            return Json(body).into_response();
        }
        let woke = tokio::time::timeout_at(deadline, async {
            loop {
                match rx.recv().await {
                    Ok(m) if desknotes_on(&m) == Some(desk) => break,
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        })
        .await;
        if woke.is_err() {
            return StatusCode::NO_CONTENT.into_response();
        }
    }
}

/// How long the mod's held question waits on one request before it asks
/// again: under a proxy's idle cut, and far under Claude Code's own.
const WAIT: Duration = Duration::from_secs(25);

/// The mod holds Claude's question and waits here for the reader to answer
/// it in snyvi: the answer as soon as there is one, or 204 after `WAIT`, and
/// the mod asks again. A turn put away answers 410, and the mod stops.
pub(crate) async fn pane_wait_turn(
    State(app): S,
    headers: HeaderMap,
    Path((id, turn)): Path<(String, i64)>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    // Subscribed before the first look, so an answer between the look and
    // the wait is not missed.
    let mut rx = app.events.subscribe();
    let deadline = tokio::time::Instant::now() + WAIT;
    loop {
        match app.store.threads(|c, _| thread::turn(c, desk, turn)) {
            Ok(Some(t)) if t.pane != id => return StatusCode::NOT_FOUND.into_response(),
            Ok(Some(t)) if t.removed_at != 0 => return StatusCode::GONE.into_response(),
            Ok(Some(t)) if t.answered_at != 0 => {
                return Json(json!({ "answer": t.answer, "in": t.answered_in })).into_response()
            }
            Ok(Some(_)) => {}
            Ok(None) => return StatusCode::NOT_FOUND.into_response(),
            Err(e) => return err(e),
        }
        // Any change to a desk's list or threads is a reason to look again;
        // a lagged receiver looks again too.
        let woke = tokio::time::timeout_at(deadline, async {
            loop {
                match rx.recv().await {
                    Ok(m) if m.starts_with("desknotes\n") => break,
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        })
        .await;
        if woke.is_err() {
            return StatusCode::NO_CONTENT.into_response();
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PanelAnswerBody {
    answer: String,
    /// The question went without an answer: Claude moved on, or the mod's
    /// hook failed and gave the plain dialog back.
    drop: bool,
}

/// The mod's question was answered in the panel, or dropped: the row is
/// settled and an open wait for it ends.
pub(crate) async fn pane_answer_turn(
    State(app): S,
    headers: HeaderMap,
    Path((id, turn)): Path<(String, i64)>,
    Json(b): Json<PanelAnswerBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    let r = app.store.threads(|c, now| {
        let Some(t) = thread::turn(c, desk, turn)? else {
            return Ok(false);
        };
        if t.pane != id {
            return Ok(false);
        }
        if b.drop {
            return thread::drop_dialog(c, desk, turn, now);
        }
        Ok(thread::answer(c, desk, turn, &b.answer, "panel", now)?.is_some())
    });
    match r {
        Ok(true) => {
            threads_moved(&app, desk);
            Json(json!({ "ok": true })).into_response()
        }
        // Answered in snyvi first: the first answer stands.
        Ok(false) => StatusCode::CONFLICT.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PanelNoteBody {
    text: String,
}

/// `/note` in a panel with the mod: a line on the desk's list, the reader's
/// own -- they typed it -- with no turn spent.
pub(crate) async fn pane_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<PanelNoteBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match app.store.add_desk_note(placed.desk_id, &b.text) {
        Ok(Some(note)) => {
            notes_moved(&app, placed.desk_id);
            (StatusCode::CREATED, Json(json!({ "note": note }))).into_response()
        }
        Ok(None) => refused(
            StatusCode::CONFLICT,
            format!(
                "an empty line, or the desk keeps {} notes",
                crate::desk::NOTES_PER_DESK
            ),
        ),
        Err(e) => err(e),
    }
}

// --- the page's side -------------------------------------------------------

/// How long an answered hand-over stays on the rail after its answer.
const ANSWERED_SHOWN: i64 = 24 * 3600;

/// A desk's threads, its turns and its waiting suggestions: the rail's three
/// sections in one read.
pub(crate) async fn desk_threads(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Q,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let r = app.store.threads(|c, now| {
        Ok((
            thread::for_desk(c, id, now)?,
            thread::turns(c, id, now - ANSWERED_SHOWN)?,
            thread::suggestions(c, id)?,
        ))
    });
    match r {
        Ok((threads, turns, suggestions)) => {
            Json(json!({ "threads": threads, "turns": turns, "suggestions": suggestions }))
                .into_response()
        }
        Err(e) => err(e),
    }
}

pub(crate) async fn desk_move_thread(
    State(app): S,
    headers: HeaderMap,
    Path((id, t)): Path<(i64, i64)>,
    Query(q): Q,
    Json(b): Json<MoveBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let m = Move {
        stage: b.stage,
        next: b.next,
        pr: b.pr,
        name: b.name,
        notes: b.notes,
        pane: String::new(),
        reader: true,
    };
    let r = app
        .store
        .threads(|c, now| thread::move_thread(c, id, Some(t), &m, now));
    moved(&app, id, r)
}

/// ✕ and its Undo, for a thread, a turn or a suggestion -- and Open. For a
/// suggested panel Open only settles it: the page opens the panel on the
/// route it always has, with the command the card showed. For a suggested
/// desk the daemon makes the desk here, from the folder on the row: the page
/// can only name a folder the picker gave it, and the reader's click on the
/// card is the pick.
fn row_act(app: &App, id: i64, what: &str, row: i64, act: &str) -> Response {
    if (what, act) == ("suggestions", "open") {
        return open_suggestion(app, id, row);
    }
    let r = app.store.threads(|c, now| {
        Ok(match (what, act) {
            ("threads", "remove") => thread::remove(c, id, row, now)?,
            ("threads", "restore") => thread::restore(c, id, row)?,
            ("turns", "remove") => thread::remove_turn(c, id, row, now)?,
            ("turns", "restore") => thread::restore_turn(c, id, row)?,
            ("suggestions", "dismiss") => thread::settle(c, id, row, "dismissed", now)?.is_some(),
            ("suggestions", "restore") => thread::unsettle(c, id, row)?,
            _ => false,
        })
    });
    match r {
        Ok(true) => {
            threads_moved(app, id);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

fn open_suggestion(app: &App, id: i64, row: i64) -> Response {
    let card = match app.store.threads(|c, _| thread::suggestion(c, id, row)) {
        Ok(Some(s)) if s.settled_at == 0 => s,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    let mut made = serde_json::Value::Null;
    if card.kind == "desk" {
        let dir = std::path::PathBuf::from(&card.folder);
        if !dir.is_absolute() || !dir.is_dir() {
            return refused(StatusCode::BAD_REQUEST, "that folder is not there");
        }
        match app.store.create_desk(&dir.to_string_lossy(), None) {
            Ok(desk) => {
                desks_moved(app);
                made = json!(desk);
            }
            Err(e) => return err(e),
        }
    }
    match app
        .store
        .threads(|c, now| thread::settle(c, id, row, "opened", now))
    {
        Ok(_) => {
            threads_moved(app, id);
            Json(json!({ "ok": true, "desk": made })).into_response()
        }
        Err(e) => err(e),
    }
}

pub(crate) async fn desk_thread_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
) -> Response {
    refuse_desk(&app, &headers, &q).unwrap_or_else(|| row_act(&app, id, "threads", row, &act))
}

pub(crate) async fn desk_turn_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
) -> Response {
    refuse_desk(&app, &headers, &q).unwrap_or_else(|| row_act(&app, id, "turns", row, &act))
}

pub(crate) async fn desk_suggestion_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
) -> Response {
    refuse_desk(&app, &headers, &q).unwrap_or_else(|| row_act(&app, id, "suggestions", row, &act))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct AnswerBody {
    answer: String,
}

/// The reader answers a turn on the rail or on Home. It reaches Claude with
/// the panel's next prompt (`crate::brief::changes`), or at once through the
/// mod's held question; Send now is the page typing it, the reader's click.
pub(crate) async fn desk_answer_turn(
    State(app): S,
    headers: HeaderMap,
    Path((id, t)): Path<(i64, i64)>,
    Query(q): Q,
    Json(b): Json<AnswerBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app
        .store
        .threads(|c, now| thread::answer(c, id, t, &b.answer, "snyvi", now))
    {
        Ok(Some(turn)) => {
            threads_moved(&app, id);
            Json(json!({ "turn": turn })).into_response()
        }
        Ok(None) => refused(StatusCode::CONFLICT, "it was answered already, or put away"),
        Err(e) => err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_band_names_the_thread_and_what_is_waiting() {
        let t = thread::Thread {
            name: "Home + friends".into(),
            stage: "building".into(),
            branch: "claude/asides".into(),
            commits: 3,
            ..thread::Thread::default()
        };
        let w = thread::Turn {
            kind: "try".into(),
            text: "Try it on 7871".into(),
            ..thread::Turn::default()
        };
        assert_eq!(
            band_line(Some(&t), &[w.clone(), w]),
            "▸ Home + friends · building · claude/asides · 3 commits · your turn: Try it on 7871 (+1)"
        );
        assert_eq!(band_line(None, &[]), "");
    }
}
