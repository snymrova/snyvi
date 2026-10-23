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
    match app.store.clocked(|c, now| thread::start(c, desk, &s, now)) {
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
        .clocked(|c, now| thread::move_thread(c, desk, None, &m, now));
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
    /// `key` only: the key's name, so adding it settles the turn.
    key: String,
    /// `ask` with several questions, as one card (#110): each one's text,
    /// options and recommended, in place of the body's own.
    questions: Vec<QuestionBody>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct QuestionBody {
    question: String,
    options: Vec<String>,
    recommended: Option<i64>,
}

/// What else waits on the reader on the desk, told back to the agent that
/// just asked (#174): it can see a card it repeats, or one a session before
/// it left that is done, and remove that one (`pane_away`).
fn also_open(app: &App, desk: i64, not: &[i64]) -> Vec<serde_json::Value> {
    let waiting = app
        .store
        .clocked(|c, now| thread::waiting_on(c, desk, false, now))
        .unwrap_or_default();
    waiting
        .iter()
        .filter(|t| !not.contains(&t.id))
        .map(|t| json!({ "id": t.id, "kind": t.kind, "text": t.text, "cmd": t.cmd, "stale": t.stale, "created_at": t.created_at }))
        .collect()
}

fn asked(app: &App, desk: i64, r: anyhow::Result<Asked>) -> Response {
    match r {
        Ok(Asked::Turn(t)) => {
            threads_moved(app, desk);
            notify_turn(app, &t, 0);
            let open = also_open(app, desk, &[t.id]);
            (StatusCode::CREATED, Json(json!({ "turn": t, "open": open }))).into_response()
        }
        Ok(Asked::Group(ts)) => {
            threads_moved(app, desk);
            notify_turn(app, &ts[0], ts.len() - 1);
            let ids: Vec<i64> = ts.iter().map(|t| t.id).collect();
            let open = also_open(app, desk, &ids);
            (
                StatusCode::CREATED,
                Json(json!({ "turn": ts[0], "turns": ts, "open": open })),
            )
                .into_response()
        }
        Ok(Asked::BadGroup) => refused(
            StatusCode::BAD_REQUEST,
            format!(
                "questions are one to {}, each with two to four options",
                thread::GROUP_MAX
            ),
        ),
        Ok(Asked::Empty) => refused(StatusCode::BAD_REQUEST, "it needs one sentence"),
        Ok(Asked::BadKind) => refused(StatusCode::BAD_REQUEST, "kind is try, merge, key, run or do"),
        Ok(Asked::BadCmd) => refused(
            StatusCode::BAD_REQUEST,
            format!(
                "run needs cmd, or steps with at least one command: each command one line, at most {} bytes, with no control characters; at most {} steps",
                thread::CMD_BYTES,
                thread::STEPS_MAX
            ),
        ),
        Ok(Asked::BadOptions) => refused(
            StatusCode::BAD_REQUEST,
            "a question takes two to four options; a hand-over takes none",
        ),
        Ok(Asked::Full) => refused(
            StatusCode::CONFLICT,
            format!(
                "{} things asked in the last half hour are already waiting on the user on this desk; wait for an answer",
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

/// `hand_over`: try, merge, key, run or do.
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
        return refused(
            StatusCode::BAD_REQUEST,
            "kind is try, merge, key, run or do",
        );
    }
    let a = Ask {
        kind,
        text: b.text,
        options: b.options,
        recommended: b.recommended.unwrap_or(-1),
        link: b.link,
        // Only a question can be the mod's mirror of Claude's own: a
        // hand-over said to be a dialog would be kept out of On you, where
        // the reader is the only one who can settle it (B7).
        via: if decide { b.via } else { String::new() },
        by: b.by,
        pane: id,
        cmd: b.cmd,
        key_name: b.key,
    };
    let desk = placed.desk_id;
    // Several questions are one card; a hand-over has no questions to put.
    if !b.questions.is_empty() {
        if !decide {
            return refused(StatusCode::BAD_REQUEST, "only a question takes questions");
        }
        let asks: Vec<Ask> = b
            .questions
            .into_iter()
            .map(|q| Ask {
                text: q.question,
                options: q.options,
                recommended: q.recommended.unwrap_or(-1),
                ..a.clone()
            })
            .collect();
        let r = app
            .store
            .clocked(|c, now| thread::ask_group(c, desk, &asks, now));
        return asked(&app, desk, r);
    }
    let r = app.store.clocked(|c, now| thread::ask(c, desk, &a, now));
    asked(&app, desk, r)
}

/// `settle_asks`: the agent says the questions it put on On you were
/// answered in the conversation (B1). Only its own, only questions.
pub(crate) async fn pane_settle(
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
        .clocked(|c, now| thread::settle_asks(c, desk, &id, now))
    {
        Ok(n) => {
            if n > 0 {
                threads_moved(&app, desk);
            }
            Json(json!({ "settled": n })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct AwayBody {
    turn: i64,
    #[serde(default)]
    why: String,
}

/// `remove_card`: an agent on the desk removes a card from On you, saying why
/// (#174). Any waiting turn on its own desk, never another desk's; the why
/// is said in the tray with Bring back, and nothing is deleted.
pub(crate) async fn pane_away(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AwayBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    if b.why.trim().is_empty() {
        return refused(
            StatusCode::BAD_REQUEST,
            "say why it is no longer on the user",
        );
    }
    let desk = placed.desk_id;
    let who = format!("panel {}", placed.pane.slot);
    match app
        .store
        .clocked(|c, now| thread::put_away(c, desk, b.turn, &who, &b.why, now))
    {
        Ok(Some(t)) => {
            threads_moved(&app, desk);
            Json(json!({ "turn": t })).into_response()
        }
        Ok(None) => refused(
            StatusCode::NOT_FOUND,
            "no card of that id is waiting on the user on this desk",
        ),
        Err(e) => err(e),
    }
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
        ..Suggest::default()
    };
    let desk = placed.desk_id;
    match app.store.clocked(|c, now| thread::suggest(c, desk, &s, now)) {
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
    let mut b = b;
    if !b.merged.trim().is_empty() {
        b.mine = merged_by_reader(&app, desk, &id, &b).await;
    }
    match app
        .store
        .clocked(|c, now| thread::seen(c, desk, &id, &b, now))
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

/// Whether the merge the mod saw was the reader's own: who merged it, as
/// the mod's gh said or the daemon's own asks, is who gh is signed in as
/// here. Not knowing is not the reader's: the notes then land for their
/// check rather than tick (#167). Off the lock and the runtime.
async fn merged_by_reader(app: &Arc<App>, desk: i64, pane: &str, b: &Seen) -> bool {
    let Ok(Some(root)) = app.store.desk(desk).map(|d| d.map(|d| d.root)) else {
        return false;
    };
    let pr = match thread::pr_number(&b.pr) {
        Some(n) => n,
        None => app
            .store
            .clocked(|c, _| thread::of_pane(c, desk, pane))
            .ok()
            .flatten()
            .map(|t| t.pr)
            .unwrap_or_default(),
    };
    let said = b.merged_by.trim().to_string();
    tokio::task::spawn_blocking(move || {
        let dir = std::path::Path::new(&root);
        let by = if said.is_empty() {
            crate::gh::view(dir, &pr)
                .map(|p| p.merged_by)
                .unwrap_or_default()
        } else {
            said
        };
        !by.is_empty() && crate::gh::viewer(dir).is_some_and(|me| me.eq_ignore_ascii_case(&by))
    })
    .await
    .unwrap_or(false)
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
        parts.push(format!("on you: {what}{more}"));
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
    let (t, waiting) = app.store.clocked(|c, now| {
        let t = thread::of_pane(c, desk, pane)?;
        // The mod's own dialog is on screen already; the band names the
        // rest, while it is fresh: a turn that went quiet is not "on you"
        // above every prompt for days.
        let mut waiting = thread::waiting_on(c, desk, false, now)?;
        waiting.retain(|w| !w.stale);
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
        match app.store.clocked(|c, _| thread::turn(c, desk, turn)) {
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
    let r = app.store.clocked(|c, now| {
        let Some(t) = thread::turn(c, desk, turn)? else {
            return Ok(None);
        };
        if t.pane != id {
            return Ok(None);
        }
        if b.drop {
            return Ok(thread::drop_dialog(c, desk, turn, now)?.then_some(None));
        }
        Ok(thread::answer(c, desk, turn, &b.answer, "panel", now)?.map(Some))
    });
    match r {
        Ok(Some(answered)) => {
            if let Some(t) = answered {
                log_answered(&app, &t);
            }
            threads_moved(&app, desk);
            Json(json!({ "ok": true })).into_response()
        }
        // Answered in snyvi first: the first answer stands.
        Ok(None) => StatusCode::CONFLICT.into_response(),
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

/// How often one thread's PR, or its branch's merge, is looked for.
const MERGE_LOOK: Duration = Duration::from_secs(300);

/// What one sweep learned of one thread, off the lock.
#[derive(Default)]
struct Looked {
    id: i64,
    /// The branch its own worktree has out, when that differs from the row.
    branch: Option<String>,
    /// Its PR, found by its branch, when it had none.
    found: Option<String>,
    pr: Option<crate::gh::Pr>,
    viewer: Option<String>,
    /// git's guess at a merge, when GitHub could not be asked.
    git: Option<(String, i64)>,
}

/// A thread's PR, read from GitHub, not guessed (#167). Each thread at most
/// every MERGE_LOOK, off the store's lock and the runtime, before the rail
/// reads its threads, so a PR merged on GitHub's page, from another
/// checkout or with no panel open is heard as surely as one the panel's mod
/// watched:
///
/// - with a PR: `gh pr view` says open, merged or closed, the checks, the
///   merge and who made it; the reader's own merge ticks the thread's notes,
///   anyone else's lands them for the reader's check (`thread::pr_facts`);
/// - on a branch with no PR: the PR from that branch, if there is one now;
/// - once, a thread from before 1.43 that counted as merged: its own
///   worktree's branch and that branch's PR put right what a drifted branch
///   had credited it with;
/// - no gh, or no answer: git's guess at the branch's merge, which ships the
///   thread and ticks nothing (`thread::landed`), as before.
async fn merges_unseen(app: Arc<App>, desk: i64) {
    static LOOKED: std::sync::Mutex<Vec<(i64, std::time::Instant)>> =
        std::sync::Mutex::new(Vec::new());
    let Ok(open) = app.store.clocked(|c, _| thread::sweep_due(c, desk)) else {
        return;
    };
    let due: Vec<_> = {
        let mut looked = LOOKED.lock().unwrap_or_else(|e| e.into_inner());
        looked.retain(|(_, at)| at.elapsed() < MERGE_LOOK);
        let due: Vec<_> = open
            .into_iter()
            .filter(|d| !looked.iter().any(|(l, _)| *l == d.id))
            .collect();
        looked.extend(due.iter().map(|d| (d.id, std::time::Instant::now())));
        due
    };
    if due.is_empty() {
        return;
    }
    let found = tokio::task::spawn_blocking(move || due.into_iter().map(look).collect::<Vec<_>>())
        .await
        .unwrap_or_default();
    let moved = app
        .store
        .clocked(|c, now| {
            let mut moved = false;
            for l in &found {
                moved |= file_looked(c, desk, l, now)?;
            }
            Ok(moved)
        })
        .unwrap_or(false);
    if moved {
        threads_moved(&app, desk);
    }
}

/// Ask GitHub, or git, about one thread. Blocking.
fn look(d: thread::Due) -> Looked {
    let dir = std::path::Path::new(&d.dir);
    let mut l = Looked {
        id: d.id,
        ..Looked::default()
    };
    if d.pr_state.is_empty() && d.own {
        l.branch = crate::git::branch_of(dir).filter(|b| *b != d.branch && thread::branch_ok(b));
    }
    let branch = l.branch.clone().unwrap_or_else(|| d.branch.clone());
    let pr = if d.pr.is_empty() && !branch.is_empty() {
        l.found = crate::gh::by_head(dir, &branch);
        l.found.clone().unwrap_or_default()
    } else {
        d.pr.clone()
    };
    if !pr.is_empty() {
        l.pr = crate::gh::view(dir, &pr);
        if l.pr.as_ref().is_some_and(|p| p.state == "merged") {
            l.viewer = crate::gh::viewer(dir);
        }
    }
    if l.pr.is_none() && !d.merged && !branch.is_empty() {
        l.git = crate::git::merge_of(dir, &branch);
    }
    l
}

/// What `look` learned, filed. Whether a thread changed.
fn file_looked(c: &rusqlite::Connection, desk: i64, l: &Looked, now: i64) -> anyhow::Result<bool> {
    let mut moved = thread::repair_branch(
        c,
        desk,
        l.id,
        l.branch.as_deref().unwrap_or(""),
        l.found.as_deref().unwrap_or(""),
    )?;
    let Some(t) = thread::get(c, desk, l.id)? else {
        return Ok(moved);
    };
    if let Some(p) = &l.pr {
        let mine = !p.merged_by.is_empty()
            && l.viewer
                .as_deref()
                .is_some_and(|me| me.eq_ignore_ascii_case(&p.merged_by));
        moved |= thread::pr_facts(c, &t, &thread::PrFacts::from(p), mine, "", now)?;
    } else if let Some((m, at)) = &l.git {
        moved |= thread::landed(c, desk, l.id, m, *at)?;
    } else if t.pr.is_empty() {
        moved |= thread::no_pr(c, desk, l.id)?;
    }
    Ok(moved)
}

/// A line's work went out by another branch than its thread's -- a release
/// branch that gathered several worktrees, a branch reused, a worktree with
/// none -- and no merge of its thread's branch ever came: #129-#131 sat at
/// "planned" on 1.36 with their commit in 1.35. So the commits on main are
/// read too, for what they say they finish ("(#129-#131)", `git::named_in`),
/// and a line one names lands: "check it", with the commit, for the reader
/// to check (`desk::land_notes`). As often as the merges, off the lock.
async fn notes_landed(app: &Arc<App>, desk: i64) {
    static LOOKED: std::sync::Mutex<Vec<(i64, std::time::Instant)>> =
        std::sync::Mutex::new(Vec::new());
    {
        let mut looked = LOOKED.lock().unwrap_or_else(|e| e.into_inner());
        looked.retain(|(_, at)| at.elapsed() < MERGE_LOOK);
        if looked.iter().any(|(d, _)| *d == desk) {
            return;
        }
        looked.push((desk, std::time::Instant::now()));
    }
    let Ok(Some(root)) = app.store.desk(desk).map(|d| d.map(|d| d.root)) else {
        return;
    };
    let Ok(open) = app.store.clocked(|c, _| crate::desk::landable(c, desk)) else {
        return;
    };
    let Some(since) = open.iter().map(|(_, t)| *t).min() else {
        return;
    };
    let named = tokio::task::spawn_blocking(move || {
        crate::git::notes_named(std::path::Path::new(&root), since)
    })
    .await
    .unwrap_or_default();
    // Newest first from git: the latest commit that names a line, made after
    // the line was written (or reopened), is the one it lands with.
    let mut found: Vec<(i64, String, i64)> = Vec::new();
    for (id, commit, at) in named {
        let fits = open.iter().any(|(n, t)| *n == id && at >= *t);
        if fits && !found.iter().any(|(f, ..)| *f == id) {
            found.push((id, commit, at));
        }
    }
    if found.is_empty() {
        return;
    }
    if app
        .store
        .clocked(|c, _| crate::desk::land_notes(c, desk, &found))
        .unwrap_or(0)
        > 0
    {
        notes_moved(app, desk);
    }
}

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
    // GitHub can take seconds to answer: the rail is not held for it. What
    // the sweep finds comes as the `desknotes` event, and the rail reads again.
    tokio::spawn(merges_unseen(app.clone(), id));
    notes_landed(&app, id).await;
    let r = app.store.clocked(|c, now| {
        // What has waited three days is put away first (`thread::retire`).
        if thread::retire(c, now)? > 0 {
            threads_moved(&app, id);
        }
        Ok((
            thread::for_desk(c, id)?,
            thread::turns(c, id, now - ANSWERED_SHOWN, now)?,
            thread::suggestions(c, id)?,
            thread::put_away_lately(c, id, now)?,
        ))
    });
    match r {
        Ok((threads, turns, suggestions, away)) => Json(json!({
            "threads": threads, "turns": turns, "suggestions": suggestions, "away": away,
        }))
        .into_response(),
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
        .clocked(|c, now| thread::move_thread(c, id, Some(t), &m, now));
    moved(&app, id, r)
}

/// ✕ and its Undo, for a thread, a turn or a suggestion -- and Open. For a
/// suggested panel Open only settles it: the page opens the panel on the
/// route it always has, with the command the card showed. For a suggested
/// desk the daemon makes the desk here, from the folder on the row: the page
/// can only name a folder the picker gave it, and the reader's click on the
/// card is the pick.
fn row_act(app: &Arc<App>, id: i64, what: &str, row: i64, act: &str, body: &[u8]) -> Response {
    if (what, act) == ("suggestions", "open") {
        return open_suggestion(app, id, row, body);
    }
    let r = app.store.clocked(|c, now| {
        Ok(match (what, act) {
            ("threads", "remove") => thread::remove(c, id, row, now)?,
            ("threads", "restore") => thread::restore(c, id, row)?,
            ("turns", "remove") => thread::remove_turn(c, id, row, now)?,
            ("turns", "restore") => thread::restore_turn(c, id, row)?,
            // Send now typed it into the panel: told there, not again.
            ("turns", "sent") => thread::sent_turn(c, id, row, now)?,
            // Not now on a panel's box is the reader's answer: later pushes
            // of it are refused, until its Undo takes the answer back.
            ("suggestions", "dismiss") => match thread::settle(c, id, row, "dismissed", now)? {
                Some(s) if s.kind == "box" => {
                    crate::widget::ask_answer(c, id, &s.name, "no", 0, "", now)?;
                    true
                }
                was => was.is_some(),
            },
            ("suggestions", "restore") => {
                let back = thread::unsettle(c, id, row)?;
                if back {
                    if let Some(s) = thread::suggestion(c, id, row)?.filter(|s| s.kind == "box") {
                        crate::widget::ask_answer(c, id, &s.name, "", 0, "", now)?;
                    }
                }
                back
            }
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

fn open_suggestion(app: &Arc<App>, id: i64, row: i64, body: &[u8]) -> Response {
    let card = match app.store.clocked(|c, _| thread::suggestion(c, id, row)) {
        Ok(Some(s)) if s.settled_at == 0 => s,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    let mut made = serde_json::Value::Null;
    // How long the reader chose on the card, for a widget or a box.
    let lasts: Lasts = serde_json::from_slice(body).unwrap_or_default();
    if card.kind == "widget" {
        if let Err(no) = install_proposed(app, &card, &lasts) {
            // A card that can never be added -- its folder changed, its
            // name taken -- is settled as stale, and the agent told why,
            // rather than left asking; a full desk keeps it waiting.
            if no.stale {
                let note = format!(
                    "The user pressed Add on your widget {}, but snyvi could not add it: {}.",
                    card.name, no.why
                );
                let _ = app
                    .store
                    .clocked(|c, now| thread::settle_with(c, id, row, "stale", &note, now));
                threads_moved(app, id);
            }
            return refused(StatusCode::CONFLICT, no.why);
        }
    }
    if card.kind == "box" {
        if let Err(why) = allow_box(app, &card, &lasts) {
            return refused(StatusCode::CONFLICT, why);
        }
    }
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
        .clocked(|c, now| thread::settle(c, id, row, "opened", now))
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
    refuse_desk(&app, &headers, &q).unwrap_or_else(|| row_act(&app, id, "threads", row, &act, b""))
}

pub(crate) async fn desk_turn_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
) -> Response {
    refuse_desk(&app, &headers, &q).unwrap_or_else(|| row_act(&app, id, "turns", row, &act, b""))
}

pub(crate) async fn desk_suggestion_act(
    State(app): S,
    headers: HeaderMap,
    Path((id, row, act)): Path<(i64, i64, String)>,
    Query(q): Q,
    body: axum::body::Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if act == "try" {
        return try_suggestion(&app, id, row).await;
    }
    row_act(&app, id, "suggestions", row, &act, &body)
}

/// Try once, on a proposed widget's card: its command run here, as the
/// runner would, and what it printed shown in the card. The click is the
/// reader's consent to that one run, which is why it is the window's, as
/// Allow is.
async fn try_suggestion(app: &Arc<App>, id: i64, row: i64) -> Response {
    let card = match app.store.clocked(|c, _| thread::suggestion(c, id, row)) {
        Ok(Some(s)) if s.settled_at == 0 && s.kind == "widget" => s,
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    };
    Json(try_proposed(app, &card).await).into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct AnswerBody {
    answer: String,
    /// A due card's Later…: when to, in the reader's words (`crate::due`).
    later: Option<String>,
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
    // A due card is snyvi's own: Done ticks its line, a time moves it --
    // `later`, or a time as the answer itself (Home's corner sends one).
    let later = b
        .later
        .as_deref()
        .or((!b.answer.trim().eq_ignore_ascii_case("done")).then_some(b.answer.as_str()));
    match app.store.clocked(|c, now| match thread::turn(c, id, t)? {
        Some(due) if due.kind == crate::due::KIND => crate::due::answer(c, id, &due, later, now),
        _ => thread::answer(c, id, t, &b.answer, "snyvi", now),
    }) {
        Ok(Some(turn)) => {
            log_answered(&app, &turn);
            threads_moved(&app, id);
            Json(json!({ "turn": turn })).into_response()
        }
        Ok(None) => refused(StatusCode::CONFLICT, "it was answered already, or put away"),
        Err(e) => err(e),
    }
}

/// An answered turn, in Lately: what was asked and what the reader said, so
/// "what did I tell it?" has an answer once the card is gone. The reader's
/// own doing, so it lights nothing (`lately::unseen`).
fn log_answered(app: &App, t: &thread::Turn) {
    lately_log(
        app,
        crate::lately::New {
            kind: "answered",
            text: t.text.clone(),
            who: t.by.clone(),
            from: crate::receive::pane_origin(&app.store, Some(t.pane.as_str())),
            data: json!({ "answer": t.answer, "turn": t.id, "desk": t.desk_id, "kind": t.kind }),
            lit: false,
            ..Default::default()
        },
    );
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
            "▸ Home + friends · building · claude/asides · 3 commits · on you: Try it on 7871 (+1)"
        );
        assert_eq!(band_line(None, &[]), "");
    }
}
