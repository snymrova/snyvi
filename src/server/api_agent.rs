//! The agent's side of a desk: `/api/agents` and what an agent in a panel
//! says through its hook and its MCP server (`/api/panes/{id}/…`), behind
//! the token and a running pane (`agent_pane`).

use super::*;

/// The connect page's rows: every agent and what its own file says it has
/// of snyvi, read now, whether it is here now, and when each last sent
/// something. `program` is how this binary is spelled to them, for the page
/// to show in its commands.
pub(crate) async fn agents(State(app): S) -> Response {
    Json(agents_json(&app)).into_response()
}

/// Connect Claude Code from the window: what `snyvi init-claude --auto` does
/// in a terminal, run by this binary for this binary -- never for another
/// one -- after the reader said yes to what it writes. The window's gate,
/// as a desk is: a tab cannot change what Claude Code runs. It answers with
/// what init printed and the agents as they are now.
pub(crate) async fn connect_claude(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    // The path this daemon was started from, as the updater keeps it: once an
    // update has renamed a new file over it, `current_exe` names the old one,
    // gone (`… (deleted)` on Linux), and the same program is at the path.
    let recorded = app.exe.as_ref().map(|e| e.path.clone());
    let ran = tokio::task::spawn_blocking(move || {
        let exe = match recorded {
            Some(p) => p,
            None => std::env::current_exe()?,
        };
        std::process::Command::new(exe)
            .args(["init-claude", "--auto"])
            .stdin(std::process::Stdio::null())
            .output()
    })
    .await;
    match ran {
        Ok(Ok(out)) => {
            let said = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            Json(json!({ "ok": out.status.success(), "said": said.trim(), "agents": agents_json(&app) }))
                .into_response()
        }
        Ok(Err(e)) => err(e.into()),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

pub(crate) fn agents_json(app: &App) -> serde_json::Value {
    let senders = app.store.senders().unwrap_or_default();
    let online = app.online.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({
        "program": crate::setup::program().0,
        // Whether a new desk's first panel can offer `claude`: on the
        // daemon's PATH, or registered (which it would not be without it).
        "claude_on_path": crate::platform::find_on_path("claude").is_some(),
        "rows": crate::agents::rows(&senders, &online),
        "online": online,
        "now": crate::store::now(),
    })
}

#[derive(Deserialize)]
pub(crate) struct AgentBody {
    /// Absent when the event says nothing about what the agent is doing (a
    /// `SessionStart`, which only names the conversation).
    #[serde(default)]
    pub(crate) state: Option<String>,
    /// The Claude Code session id, a UUID, when the event carried one.
    #[serde(default)]
    pub(crate) session: Option<String>,
    /// From the status line (`snyvi statusline`): the model's name, and how
    /// full its context window is.
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) ctx: Option<CtxBody>,
    /// The account's rate-limit windows, from the status line
    /// (`crate::statusline::Limit`): Home's quota.
    #[serde(default)]
    pub(crate) limits: Option<LimitsBody>,
}

#[derive(Deserialize, Default)]
pub(crate) struct LimitsBody {
    #[serde(default)]
    pub(crate) five_hour: Option<crate::statusline::Limit>,
    #[serde(default)]
    pub(crate) seven_day: Option<crate::statusline::Limit>,
}

#[derive(Deserialize, Default)]
pub(crate) struct CtxBody {
    #[serde(default)]
    pub(crate) pct: Option<f64>,
    #[serde(default)]
    pub(crate) size: Option<u64>,
    /// `total_input_tokens`. A line from before `used` sent only this; it
    /// stands in, as it does in the line itself when there is no
    /// `current_usage`.
    #[serde(default)]
    pub(crate) input: Option<u64>,
    /// The tokens in the window now (`crate::statusline::Seen::used`).
    #[serde(default)]
    pub(crate) used: Option<u64>,
}

/// What the agent in a pane is doing, told by its hook (`snyvi hook`, run by
/// Claude Code inside the pane, which knows the pane by `SNYVI_SESSION`).
///
/// This is the one pane route behind the token rather than the window's
/// capability: the hook is a process like `snyvi send`, and it holds the token
/// and never the capability. What it can do with it is small on purpose. It
/// sets one word on a pane that is already running, and that word is shown
/// and nothing more; and it names the conversation in that pane, a UUID the
/// pane keeps so a reader's click can resume it later. It never starts, stops,
/// or types into anything, touches the store only through
/// `set_pane_session`, and an id that is not a running pane is a 404.
pub(crate) async fn pane_agent(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AgentBody>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !crate::pane::valid_id(&id) || !agent_said_ok(b.state.as_deref(), b.session.as_deref()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut live = match &b.state {
        Some(state) => app.panes.set_agent(&id, state),
        // A session named with no state is a SessionStart: an agent is in.
        None if b.session.is_some() => app.panes.agent_in(&id),
        None => app.panes.is_running(&id),
    };
    if live && (b.model.is_some() || b.ctx.is_some()) {
        let c = b.ctx.unwrap_or_default();
        let pct = c
            .pct
            .filter(|p| p.is_finite())
            .map(|p| p.clamp(0.0, 100.0).round() as u8);
        let changed = app.panes.set_context(
            &id,
            &crate::statusline::clean(b.model.as_deref().unwrap_or("")),
            pct,
            c.size.filter(|s| *s > 0),
            c.used.or(c.input),
        );
        live = changed.is_some();
        // A light event of its own, only when the figure a reader sees moved:
        // Home shows the fullest window, and the `panes` event stays about
        // running and waiting, so a quiet page stays quiet.
        if changed == Some(true) {
            emit(&app, "ctx", json!({ "pane": id }));
        }
    }
    if !live {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(l) = &b.limits {
        if l.five_hour.is_some() || l.seven_day.is_some() {
            *app.quota.lock().unwrap_or_else(|e| e.into_inner()) = Some(json!({
                "five_hour": l.five_hour,
                "seven_day": l.seven_day,
                "at": crate::store::now(),
            }));
        }
    }
    if let Some(session) = &b.session {
        if let Ok(true) = app.store.set_pane_session(&id, session) {
            desks_moved(&app);
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Whether what an event says about the agent is one of the words a pane
/// takes, and a session id of the right shape.
fn agent_said_ok(state: Option<&str>, session: Option<&str>) -> bool {
    let state_ok = |s: &str| s.is_empty() || crate::pane::AGENT_STATES.contains(&s);
    state.is_none_or(state_ok) && session.is_none_or(crate::desk::valid_session)
}

/// What the hook says about its agent with the brief or the changes it asks
/// for: the same two fields `pane_agent` takes, on the same route's terms.
/// One request per event instead of two -- the hook used to post the state
/// first and ask second, on every prompt and every session start.
#[derive(Deserialize, Default)]
pub(crate) struct AgentQ {
    #[serde(default)]
    pub(crate) state: Option<String>,
    #[serde(default)]
    pub(crate) session: Option<String>,
}

/// Apply what the hook said alongside its question, for a pane `agent_pane`
/// has already placed. Says what was applied, which goes back in the answer
/// so a hook can tell this daemon from one that read the question alone.
fn agent_said(app: &App, id: &str, q: &AgentQ) -> Result<serde_json::Value, Box<Response>> {
    if !agent_said_ok(q.state.as_deref(), q.session.as_deref()) {
        return Err(Box::new(StatusCode::BAD_REQUEST.into_response()));
    }
    match &q.state {
        Some(state) => {
            app.panes.set_agent(id, state);
        }
        None if q.session.is_some() => {
            app.panes.agent_in(id);
        }
        None => {}
    }
    if let Some(session) = &q.session {
        if let Ok(true) = app.store.set_pane_session(id, session) {
            desks_moved(app);
        }
    }
    Ok(json!(q.state.clone().unwrap_or_default()))
}

/// The notes of the desk a pane is on, for the agent running in that pane
/// (`read_desk_notes`, from `snyvi mcp`, which knows the pane by
/// `SNYVI_SESSION`).
///
/// The second pane route behind the token rather than the capability, and the
/// only one that gives anything back. It reads and never writes: a desk's list
/// is the reader's, and an agent that could add to it would be an agent
/// writing the reader's to-dos. It answers only for a pane that is running, so
/// a pane id found in an old screen or a log reads nothing once that shell is
/// gone, and only with that one desk's list -- never another desk's, never the
/// library. A token holder could already open the store; what this adds is
/// that an agent is handed one list through the front door instead.
pub(crate) async fn pane_notes(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match app.store.desk_notes(placed.desk_id) {
        Ok(mut notes) => {
            settle_stages(&app, &mut notes);
            for n in notes
                .iter_mut()
                .filter(|n| n.stage == "working" && n.stage_pane == id)
            {
                n.stage_panel = "this panel".into();
            }
            // A line's pictures, as files the agent can open and look at.
            let dir = app.paths.data_dir.join(crate::desk::NOTE_IMAGES);
            for n in &mut notes {
                n.images = n
                    .images
                    .iter()
                    .map(|x| dir.join(x).to_string_lossy().to_string())
                    .collect();
            }
            Json(json!({ "desk": placed.desk_name, "notes": notes })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct TickBody {
    /// The agent's name, as its MCP client gave it in `initialize`.
    #[serde(default)]
    pub(crate) by: String,
    /// The commit the work is in, if the agent made one.
    #[serde(default)]
    pub(crate) commit: String,
    /// A document the agent sent about the work, by its id.
    #[serde(default)]
    pub(crate) about: String,
    /// Where the finished work can be seen: a PR, a deploy, a store page.
    #[serde(default)]
    pub(crate) evidence: String,
}

/// An agent ticks a line on its own desk's list: `tick_desk_note`. The same
/// gate as reading it -- the token, then a pane that is running -- and the one
/// write an agent has on the list: done, by it, on an open line of the desk
/// its pane is on. Every window's rail is told, so the tick shows at once.
pub(crate) async fn pane_tick_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(String, i64)>,
    body: Option<Json<TickBody>>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let b = body.map(|Json(b)| b).unwrap_or_default();
    let (commit, doc, evidence) = (b.commit.trim(), b.about.trim(), b.evidence.trim());
    // Said wrong, it is said back rather than dropped: the agent can tick
    // again with the hash `git log` printed, and the line is still open.
    if !commit.is_empty() && !crate::desk::commit_ok(commit) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "commit must be a hash as git log prints it: 7 to 40 hex digits" })),
        )
            .into_response();
    }
    if !doc.is_empty() && !crate::desk::doc_ok(doc) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "about must be a document id from send_document: 10 hex digits" }),
            ),
        )
            .into_response();
    }
    if !evidence.is_empty() && !crate::desk::evidence_ok(evidence) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "evidence must be an http or https URL, one line, at most 500 characters" })),
        )
            .into_response();
    }
    let tick = crate::desk::Tick {
        by: b.by,
        commit: commit.into(),
        doc: doc.into(),
        evidence: evidence.into(),
        pane: id.clone(),
    };
    match app.store.tick_desk_note(placed.desk_id, note, &tick) {
        Ok(true) => {
            emit(&app, "desknotes", json!({ "desk": placed.desk_id }));
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        // Not on this desk's list, taken off it, or already done: the agent is
        // told which it cannot tell apart, and nothing changed.
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "no open note by that id on this desk" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct MarkBody {
    #[serde(default)]
    pub(crate) stage: String,
    /// The agent's name, as its MCP client gave it in `initialize`.
    #[serde(default)]
    pub(crate) by: String,
    /// The plan's document id: needed with `planned`.
    #[serde(default)]
    pub(crate) about: String,
}

/// An agent says how far it has got with a line on its own desk's list:
/// `mark_desk_note`. The gate the tick has -- the token, then a running pane
/// -- and the one write is that line's stage, on an open line of the desk the
/// pane is on. `working` is tied to this pane and the conversation it has
/// now, so it lasts only as long as that conversation (`settle_stages`).
pub(crate) async fn pane_mark_note(
    State(app): S,
    headers: HeaderMap,
    Path((id, note)): Path<(String, i64)>,
    body: Option<Json<MarkBody>>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let b = body.map(|Json(b)| b).unwrap_or_default();
    let (stage, doc) = (b.stage.trim(), b.about.trim());
    let say = |why: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": why }))).into_response();
    if !crate::desk::STAGES.contains(&stage) {
        return say("stage must be read, planned or working; done is tick_desk_note");
    }
    if !doc.is_empty() && !crate::desk::doc_ok(doc) {
        return say("about must be a document id from send_document: 10 hex digits");
    }
    if stage == "planned" && doc.is_empty() {
        return say("planned needs about: the id of the plan you sent with send_document");
    }
    let mark = crate::desk::Mark {
        stage: stage.into(),
        by: b.by,
        doc: doc.into(),
        pane: id.clone(),
        session: placed.pane.agent_session.clone(),
    };
    match app.store.mark_desk_note(placed.desk_id, note, &mark) {
        Ok(true) => {
            emit(&app, "desknotes", json!({ "desk": placed.desk_id }));
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "no open note by that id on this desk" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// An agent names the panel it runs in: `name_panel`. The gate the list has
/// -- the token, then a running pane -- and the one thing it touches is that
/// pane's own name, the one the reader sets with ✎. Empty gives the panel
/// back to its program's title.
pub(crate) async fn pane_name(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<RenameBody>,
) -> Response {
    if let Err(no) = agent_pane(&app, &headers, &id) {
        return *no;
    }
    renamed(&app, &id, &b.name)
}

/// The running pane `id`, placed on its desk, for the routes an agent reaches
/// from inside it: the token, a pane id of the right shape, a pane that is
/// running -- which a pane only is while its program is -- and then its row.
/// The answer to refuse with otherwise.
pub(crate) fn agent_pane(
    app: &App,
    headers: &HeaderMap,
    id: &str,
) -> Result<crate::desk::Placed, Box<Response>> {
    if !authorized(app, headers) {
        return Err(Box::new(StatusCode::UNAUTHORIZED.into_response()));
    }
    if !crate::pane::valid_id(id) {
        return Err(Box::new(StatusCode::BAD_REQUEST.into_response()));
    }
    if !app.panes.is_running(id) {
        return Err(Box::new(StatusCode::NOT_FOUND.into_response()));
    }
    match app.store.pane(id) {
        Ok(Some(p)) => Ok(p),
        Ok(None) => Err(Box::new(StatusCode::NOT_FOUND.into_response())),
        Err(e) => Err(Box::new(err(e))),
    }
}

/// The desk brief for a Claude starting in this pane (`crate::brief`): what
/// the SessionStart hook hands it as context, and the session's title. The
/// gate the list has, and only this pane's own desk. Empty when the reader
/// turned the brief off, so the hook says nothing.
pub(crate) async fn pane_brief(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<AgentQ>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let state = match agent_said(&app, &id, &q) {
        Ok(s) => s,
        Err(no) => return *no,
    };
    if !brief_on(&app) {
        return Json(json!({ "context": "", "title": "", "state": state })).into_response();
    }
    let Ok(Some(desk)) = app.store.desk(placed.desk_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut notes = app.store.desk_notes(desk.id).unwrap_or_default();
    settle_stages(&app, &mut notes);
    // Worked on here is not worked on elsewhere: a Claude starting in the
    // pane that said `working` is a new conversation, and the old one's claim
    // has already been settled above.
    let notes: Vec<_> = notes
        .into_iter()
        .map(|mut n| {
            if n.stage == "working" && n.stage_pane == id {
                n.stage_panel.clear();
            }
            n
        })
        .collect();
    let docs = app.store.desk_docs(desk.id, 1, false).unwrap_or_default();
    let last = docs.first().map(|d| crate::brief::LastDoc {
        id: &d.id,
        title: &d.title,
        at: d.received_at,
    });
    let now = crate::store::now();
    // The brief says everything as of now; the next prompt's changes start
    // here.
    app.panes.told(&id, now);
    let friends: Vec<String> = app
        .store
        .peers()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.removed_at == 0)
        .map(|p| p.name)
        .collect();
    let (threads, waiting) = app
        .store
        .threads(|c, _| {
            Ok((
                crate::thread::for_desk(c, desk.id)?,
                // This desk's own, dialog turns kept: the brief says what
                // waits here, not the first thirty across every desk.
                crate::thread::waiting_on(c, desk.id, true)?,
            ))
        })
        .unwrap_or_default();
    let work = crate::brief::Work {
        notes: &notes,
        threads: &threads,
        waiting: &waiting,
    };
    let context = crate::brief::brief_of(
        &desk,
        placed.pane.slot,
        &work,
        &desk.keys,
        &friends,
        last,
        now,
    );
    Json(json!({
        "context": context,
        "title": crate::brief::title(&desk, placed.pane.slot, &placed.pane.name),
        "desk": desk.name,
        "state": state,
    }))
    .into_response()
}

/// One of this pane's desk's keys, by name: what `snyvi key NAME` prints, so
/// a command in the panel can say `$(snyvi key NAME)` and the shell, not the
/// conversation, carries the value. A key added after the panel started is
/// usable at once, with no restart. The token and a running pane, as the
/// brief: only the pane's own desk and the every-desk keys, never another
/// desk's. The value is the body and nothing else, never stored on the way.
pub(crate) async fn pane_key(
    State(app): S,
    headers: HeaderMap,
    Path((id, name)): Path<(String, String)>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let held = app.clone();
    let found = tokio::task::spawn_blocking(move || {
        desk_key(&held.store, &held.secrets, placed.desk_id, &name)
    })
    .await
    .unwrap_or(Err((
        StatusCode::INTERNAL_SERVER_ERROR,
        "could not read the key".into(),
    )));
    match found {
        Ok(value) => (
            [
                (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            value,
        )
            .into_response(),
        Err((status, why)) => (status, Json(json!({ "error": why }))).into_response(),
    }
}

/// The value of the key `name` as desk `desk_id` sees it -- its own, or the
/// every-desk one -- marked used. The keychain blocks: call it from a
/// blocking thread. A refusal says what to do, by name only.
pub(crate) fn desk_key(
    store: &Store,
    secrets: &crate::secrets::Secrets,
    desk_id: i64,
    name: &str,
) -> std::result::Result<String, (StatusCode, String)> {
    if let Err(why) = crate::secrets::valid_name(name) {
        return Err((StatusCode::BAD_REQUEST, why.to_string()));
    }
    let keys = store.desk_keys(desk_id).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not read the desk's keys".to_string(),
        )
    })?;
    let Some(key) = keys.into_iter().find(|k| k.name == name) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("this desk has no key called {name}; add it under ⋯ Keys… on the desk"),
        ));
    };
    let Some(value) = secrets.value(key.desk_id, &key.name) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("{name} is on this desk but its value is gone; add it again under ⋯ Keys…"),
        ));
    };
    let _ = store.touch_desk_keys(&[key]);
    Ok(value)
}

/// What changed on this pane's desk since snyvi last spoke to its agent
/// (`crate::brief::changes`): what the UserPromptSubmit hook hands Claude with
/// the prompt. The same gate and switch as the brief. Empty when nothing
/// changed, when the brief is off, and when the daemon does not know when it
/// last spoke to this pane -- it has just started -- in which case it only
/// starts counting.
pub(crate) async fn pane_changes(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<AgentQ>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let state = match agent_said(&app, &id, &q) {
        Ok(s) => s,
        Err(no) => return *no,
    };
    let Ok(Some(desk)) = app.store.desk(placed.desk_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The reader's answers on Your turn reach the panel whatever else is
    // said: they are the reader speaking, not context snyvi adds, so the
    // brief's switch and a daemon that has just started do not hold them.
    let live: Vec<String> = desk
        .panes
        .iter()
        .filter(|p| app.panes.is_running(&p.id))
        .map(|p| p.id.clone())
        .collect();
    let answers = app
        .store
        .threads(|c, now| crate::thread::take_untold(c, desk.id, &id, &live, now))
        .unwrap_or_default();
    if !brief_on(&app) {
        let context = crate::brief::answers_only(&answers);
        return Json(json!({ "context": context, "state": state })).into_response();
    }
    // The session's title goes with every answer, so a panel named since the
    // session started gives the session its name at the next prompt.
    let title = crate::brief::title(&desk, placed.pane.slot, &placed.pane.name);
    let quiet = || {
        Json(json!({ "context": "", "title": title, "desk": desk.name, "state": state }))
            .into_response()
    };
    let now = crate::store::now();
    let since = match app.panes.told(&id, now) {
        Some(since) if since > 0 => since,
        _ if answers.is_empty() => return quiet(),
        _ => {
            let context = crate::brief::answers_only(&answers);
            return Json(
                json!({ "context": context, "title": title, "desk": desk.name, "state": state }),
            )
            .into_response();
        }
    };
    let (threads, opened) = app
        .store
        .threads(|c, now| {
            Ok((
                crate::thread::moved_since(c, desk.id, &id, since)?,
                crate::thread::take_opened(c, desk.id, &id, now)?,
            ))
        })
        .unwrap_or_default();
    let mut notes = app.store.desk_notes(desk.id).unwrap_or_default();
    settle_stages(&app, &mut notes);
    let removed = app
        .store
        .removed_desk_notes_since(desk.id, since)
        .unwrap_or_default();
    let docs = app
        .store
        .desk_docs(desk.id, crate::brief::DOCS_LOOKED_AT, false)
        .unwrap_or_default();
    let context = crate::brief::changes(&crate::brief::Changes {
        slot: placed.pane.slot,
        pane: &id,
        notes: &notes,
        removed: &removed,
        docs: &docs,
        keys: &desk.keys,
        left_off: desk.left_off.as_ref(),
        since,
        now,
        panes: &desk.panes,
        answers: &answers,
        threads: &threads,
        opened: &opened,
    });
    Json(json!({ "context": context, "title": title, "desk": desk.name, "state": state }))
        .into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct AgentLeftOffBody {
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) about: String,
    /// The agent's name, as its MCP client gave it.
    #[serde(default)]
    pub(crate) by: String,
}

/// An agent says where it left the work on its own desk: `leave_off`. The
/// one it replaced stays reachable from the desk head's Undo, as a reader's
/// edit does; an agent cannot clear one, only say the next.
pub(crate) async fn pane_left_off(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<AgentLeftOffBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    if b.text.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "leave_off needs a sentence" })),
        )
            .into_response();
    }
    let by = if b.by.trim().is_empty() {
        "an agent".to_string()
    } else {
        b.by
    };
    let to = crate::desk::LeftOff {
        text: b.text,
        at: 0,
        by,
        about: b.about,
        pane: id.clone(),
    };
    match app.store.set_left_off(placed.desk_id, &to) {
        Ok(Some(_)) => {
            desks_moved(&app);
            Json(json!({ "ok": true, "desk": placed.desk_name })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct SuggestBody {
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) by: String,
}

/// An agent suggests a line for its own desk's list: `suggest_desk_note`. It
/// shows as a ghost row with Keep and ✕, and is on the list only once kept.
pub(crate) async fn pane_suggest_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<SuggestBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    match app.store.suggest_desk_note(placed.desk_id, &b.text, &b.by) {
        Ok(crate::desk::Suggested::Note(note)) => {
            notes_moved(&app, placed.desk_id);
            (StatusCode::CREATED, Json(json!({ "note": note, "desk": placed.desk_name }))).into_response()
        }
        Ok(crate::desk::Suggested::Empty) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "suggest_desk_note needs a line of text" })),
        )
            .into_response(),
        Ok(crate::desk::Suggested::Full) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("this desk already has {} suggestions waiting for the user (or its list is full); wait until they keep or remove one", crate::desk::SUGGESTIONS_PER_DESK) })),
        )
            .into_response(),
        Ok(crate::desk::Suggested::NoSuchDesk) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}
