//! The sidebars' layout and their widgets over HTTP (`crate::widget`).
//!
//! The layout is the reader's: set from this page (or with the token, as
//! every reader's action may be), normalized, kept, and sent to every page
//! as a `layout` event, which reorders the sections it has in place.

use super::*;
use crate::widget::{self, Layout};
use axum::body::Bytes;

/// The layout, as every page draws it.
pub(crate) fn layout_json(app: &App) -> serde_json::Value {
    let l = app
        .store
        .clocked(|c, _| widget::layout(c))
        .unwrap_or_default();
    serde_json::to_value(l).unwrap_or_default()
}

/// The global widgets' seats, for every page's first paint.
pub(crate) fn global_seats_json(app: &App) -> serde_json::Value {
    let s = app
        .store
        .clocked(|c, _| widget::seats(c, 0))
        .unwrap_or_default();
    serde_json::to_value(s).unwrap_or_default()
}

/// A desk's widgets, for its rail.
pub(crate) async fn desk_widgets(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.clocked(|c, _| widget::seats(c, id)) {
        Ok(s) => Json(json!({ "widgets": s })).into_response(),
        Err(e) => err(e),
    }
}

/// Everything /sidebars arranges: the layout, every widget file with what
/// it asks and whether it is allowed as it is now, and every pushed widget
/// with its desk. A read for the window or the token (1.46): it names every
/// folder, command and the settings the reader typed, which is not any
/// local process's to read. Not `refuse_reader`: a browser sends no
/// `Origin` on a same-origin GET, and a `Host` alone any process can send,
/// so the page shows its capability (`deskApi`), as a desk's reads do.
pub(crate) async fn list_widgets(State(app): S, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        if let Some(no) = refuse_desk(&app, &headers, &Default::default()) {
            return no;
        }
    }
    // Hashed before the lock is taken: the store waits on no disk.
    let found: Vec<_> = widget::files::scan(&app.paths.config_dir)
        .into_iter()
        .map(|f| {
            let hash = widget::files::hash(&f.folder);
            (f, hash)
        })
        .collect();
    let desks = app.store.desks().unwrap_or_default();
    let r = app.store.clocked(|c, now| {
        let layout = widget::layout(c)?;
        let mut files = Vec::new();
        for (f, hash) in &found {
            let p = widget::prefs(c, f.owner, &f.name)?;
            let owner_desk = desks.iter().find(|d| d.id == f.owner).map(|d| d.name.clone());
            files.push(match &f.spec {
                Ok(s) => json!({
                    "name": f.name, "owner": f.owner, "owner_desk": owner_desk,
                    "title": s.title, "scope": s.scope, "command": s.run.command,
                    "every": s.run.every, "folder": f.folder, "lines": s.lines,
                    "allowed": !p.trusted_hash.is_empty() && hash.as_deref().ok() == Some(p.trusted_hash.as_str()),
                    "changed": !p.trusted_hash.is_empty() && hash.as_deref().ok() != Some(p.trusted_hash.as_str()),
                    "error": widget::files::lint(s, &f.folder).err().or(hash.clone().err()), "rerun_edits": p.rerun_edits, "hidden": p.hidden,
                    "fields": s.settings, "settings": s.settings_with(&p.settings),
                    "keys": s.keys, "proposed_by": p.proposed_by,
                    "desks": p.desks, "until": p.until, "until_pane": p.until_pane,
                    // Off because its time is up, not by the reader's switch.
                    "ended": p.hidden && p.ended(now, |x| app.panes.is_running(x)),
                }),
                Err(why) => json!({ "name": f.name, "owner": f.owner, "owner_desk": owner_desk, "folder": f.folder, "error": why, "hidden": p.hidden }),
            });
        }
        let mut pushed = Vec::new();
        for d in std::iter::once(0).chain(desks.iter().map(|d| d.id)) {
            for s in widget::seats(c, d)? {
                if s.source == "push" {
                    let desk = desks.iter().find(|x| x.id == d).map(|x| x.name.clone());
                    pushed.push(json!({ "name": s.name, "desk_id": d, "desk": desk, "writer": s.writer, "updated_at": s.updated_at, "hidden": s.hidden, "agent": s.agent }));
                }
            }
        }
        let said_no: Vec<serde_json::Value> = widget::asks_refused(c)?
            .into_iter()
            .filter_map(|a| {
                let desk = desks.iter().find(|x| x.id == a.desk_id)?;
                Some(json!({ "name": a.name, "desk_id": a.desk_id, "desk": desk.name, "answer": a.answer, "writer": a.writer }))
            })
            .collect();
        let open: Vec<serde_json::Value> = desks
            .iter()
            .map(|d| json!({ "id": d.id, "name": d.name }))
            .collect();
        Ok(json!({ "layout": layout, "files": files, "pushed": pushed, "said_no": said_no, "desks": open }))
    });
    match r {
        Ok(j) => Json(j).into_response(),
        Err(e) => err(e),
    }
}

/// Keep the reader's layout. Anything a page sends is normalized first, so
/// an id from a newer page is dropped and a missing one is put back, and
/// what is answered -- and sent to every page -- is what was kept.
pub(crate) async fn set_layout(State(app): S, headers: HeaderMap, body: Bytes) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let Ok(l) = serde_json::from_slice::<Layout>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "not a layout" })),
        )
            .into_response();
    };
    match app.store.clocked(|c, now| widget::set_layout(c, &l, now)) {
        Ok(kept) => {
            let j = serde_json::to_value(&kept).unwrap_or_default();
            emit(&app, "layout", j.clone());
            Json(j).into_response()
        }
        Err(e) => err(e),
    }
}

// --- writing one ----------------------------------------------------------

/// What a writer posts: the widget's name, and its body -- Markdown as a
/// string, or the contract's object (`widget::Body::parse`). An empty body
/// clears. `desk` is for the token's route: a desk's id, or none for a
/// global widget; a panel's is its own desk.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PushBody {
    pub(crate) name: String,
    pub(crate) body: serde_json::Value,
    pub(crate) desk: Option<i64>,
    pub(crate) writer: String,
    /// A panel's box: how long it suggests the box lasts, on the card.
    #[serde(rename = "for")]
    pub(crate) lasts: String,
}

impl PushBody {
    fn raw(&self) -> String {
        match &self.body {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

fn refused(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// An agent in a panel sets a widget on its own desk (MCP `set_widget`).
pub(crate) async fn pane_set_widget(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let Ok(b) = serde_json::from_slice::<PushBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget");
    };
    let writer = format!("panel {}", placed.pane.slot);
    let w = widget::Writer {
        source: widget::Source::Push,
        writer: &writer,
        pane: &id,
        title: "",
        owner: 0,
    };
    let desk = placed.desk_id;
    if !widget::name_ok(&b.name) {
        return push(&app, desk, &b.name, "", &w);
    }
    // The reader says yes to a panel's box once per desk and name (#111):
    // until then it waits behind a card on On you, and nothing is drawn. A
    // name a widget file or a script's box holds is not a panel's to ask
    // for (1.46): nothing is handed over by name.
    let raw = b.raw();
    let clears = matches!(widget::Body::parse(&raw), Ok(widget::Sent::Clear));
    let held = app.store.clocked(|c, _| {
        Ok((
            widget::name_held(c, desk, &b.name)?,
            widget::ask_of(c, desk, &b.name)?,
        ))
    });
    let (held, ask) = match held {
        Ok(x) => x,
        Err(e) => return err(e),
    };
    match (held, ask) {
        (Some(widget::Held::File), _) => refused(
            StatusCode::CONFLICT,
            format!(
                "a widget file is called {} on this desk, and only it fills that seat: pick another name",
                b.name
            ),
        ),
        (Some(widget::Held::Box), None) => refused(
            StatusCode::CONFLICT,
            format!(
                "a script's box is called {} on this desk: it is the user's, not a panel's to take over. Pick another name",
                b.name
            ),
        ),
        (None, None) if clears => refused(
            StatusCode::NOT_FOUND,
            format!("there is no box called {} on this desk", b.name),
        ),
        (_, Some(a)) if a.answer == "yes" => push(&app, desk, &b.name, &raw, &w),
        (_, Some(a)) if a.answer == "no" => refused(
            StatusCode::CONFLICT,
            format!(
                "the user said not now to the box {} on this desk: leave it, or say in your reply why it would help",
                b.name
            ),
        ),
        // Removed by the reader: the panel that pushed it is told so; a
        // new panel asks again, with a card, and the no holds until the
        // reader answers it.
        (_, Some(a)) if a.answer == "removed" && a.pane == id => refused(
            StatusCode::CONFLICT,
            format!(
                "the user removed the box {} from this desk: leave it removed unless they ask for it",
                b.name
            ),
        ),
        _ => ask_for_box(&app, desk, &id, &writer, &b, &raw),
    }
}

/// A panel's box the reader has not said yes to: its body waits, and the
/// card that asks is on On you -- one per desk and name, however often
/// the panel sends meanwhile. A clear while it waits takes the body back.
/// The body is kept only once there is a card to wait behind: refused
/// with no card is refused with nothing kept.
pub(crate) fn ask_for_box(
    app: &Arc<App>,
    desk: i64,
    pane: &str,
    writer: &str,
    b: &PushBody,
    raw: &str,
) -> Response {
    let cleared = matches!(widget::Body::parse(raw), Ok(widget::Sent::Clear));
    if let Err(why) = widget::Body::parse(raw) {
        return refused(StatusCode::BAD_REQUEST, why);
    }
    // Only a box a card can be asked for: no seat free on the desk is told
    // now, not at the reader's Allow.
    let room = app.store.clocked(|c, _| {
        Ok(widget::seat_of(c, desk, &b.name)?.is_some() || !widget::slot_full(c, desk)?)
    });
    if !cleared && !room.unwrap_or(true) {
        return refused(
            StatusCode::CONFLICT,
            format!(
                "this desk has {} widgets, which is all it can have: read_widgets, and update one of yours",
                widget::DESK_MAX
            ),
        );
    }
    let preview_md = match widget::Body::parse(raw) {
        Ok(widget::Sent::Body(b)) => b.md,
        _ => String::new(),
    };
    let preview: String = widget::Body::parse(raw)
        .ok()
        .and_then(|s| match s {
            // A gallery's card says what it is, not its mark.
            widget::Sent::Body(b) => {
                Some(b.md.replace(widget::gallery::MARK, "").trim().to_string())
            }
            widget::Sent::Clear => None,
        })
        .unwrap_or_default();
    let r = app.store.clocked(|c, now| {
        let wait = |c: &rusqlite::Connection| {
            widget::ask_wait(
                c,
                desk,
                &b.name,
                pane,
                writer,
                if cleared { "" } else { raw },
                now,
            )
        };
        if cleared || crate::thread::box_waiting(c, desk, &b.name)? {
            wait(c)?;
            return Ok(None);
        }
        let s = crate::thread::Suggest {
            kind: "box".into(),
            name: b.name.clone(),
            cmd: preview.clone(),
            why: if widget::gallery::is_gallery(&preview_md) {
                format!("{writer} wants a gallery on this desk, for what its models make")
            } else {
                format!("{writer} wants a box on this desk")
            },
            by: writer.to_string(),
            pane: pane.to_string(),
            lasts: b.lasts.clone(),
            ..Default::default()
        };
        let made = crate::thread::suggest(c, desk, &s, now)?;
        if matches!(made, crate::thread::Suggested::Card(_)) {
            wait(c)?;
        }
        Ok(Some(made))
    });
    match r {
        Ok(None) => (
            StatusCode::ACCEPTED,
            Json(json!({ "waiting": true, "name": b.name, "cleared": cleared })),
        )
            .into_response(),
        Ok(Some(crate::thread::Suggested::Card(card))) => {
            threads_moved(app, desk);
            (
                StatusCode::ACCEPTED,
                Json(json!({ "waiting": true, "name": b.name, "suggestion": card })),
            )
                .into_response()
        }
        Ok(Some(crate::thread::Suggested::Full)) => refused(
            StatusCode::CONFLICT,
            "three suggestions are waiting on this desk already: the box can be asked for once the user answers one",
        ),
        Ok(Some(_)) => refused(StatusCode::BAD_REQUEST, "not a box"),
        Err(e) => err(e),
    }
}

/// Anything with the token sets a widget: a script, a git hook, cron, CI
/// (`snyvi widget set`). On a desk by its id, or global.
pub(crate) async fn set_widget(State(app): S, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(b) = serde_json::from_slice::<PushBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget");
    };
    let desk = b.desk.unwrap_or(0);
    if desk != 0
        && !app
            .store
            .desks()
            .map(|ds| ds.iter().any(|d| d.id == desk))
            .unwrap_or(false)
    {
        return refused(StatusCode::NOT_FOUND, format!("there is no desk {desk}"));
    }
    let writer = if b.writer.trim().is_empty() {
        "a script".to_string()
    } else {
        b.writer.trim().chars().take(40).collect()
    };
    let raw = b.raw();
    // A box the reader said Not now to, or removed, on this desk stays so
    // whoever holds the token -- a panel's agent can run this CLI with its
    // session unset. Clearing it is still anyone's.
    let clears = matches!(widget::Body::parse(&raw), Ok(widget::Sent::Clear));
    if desk != 0 && !clears {
        match app.store.clocked(|c, _| widget::ask_of(c, desk, &b.name)) {
            Err(e) => return err(e),
            Ok(Some(a)) if a.answer == "no" || a.answer == "removed" => {
                return refused(
                    StatusCode::CONFLICT,
                    format!(
                        "the user {} the box {} on desk {desk}: it stays so until they take that back on /sidebars",
                        if a.answer == "no" { "said not now to" } else { "removed" },
                        b.name
                    ),
                )
            }
            Ok(_) => {}
        }
    }
    let w = widget::Writer {
        source: widget::Source::Push,
        writer: &writer,
        pane: "",
        title: "",
        owner: 0,
    };
    push(&app, desk, &b.name, &raw, &w)
}

/// Read, draw, keep and say a pushed body, or clear the widget.
pub(crate) fn push(
    app: &Arc<App>,
    desk: i64,
    name: &str,
    raw: &str,
    w: &widget::Writer,
) -> Response {
    match push_result(app, desk, name, raw, w) {
        Ok(j) => Json(j).into_response(),
        Err((code, why)) => refused(code, why),
    }
}

/// `push`, with its refusal as a status and the reason, for a caller
/// that carries the reason on (`allow_box`).
fn push_result(
    app: &Arc<App>,
    desk: i64,
    name: &str,
    raw: &str,
    w: &widget::Writer,
) -> Result<serde_json::Value, (StatusCode, String)> {
    if !widget::name_ok(name) {
        return Err((
            StatusCode::BAD_REQUEST,
            "a widget's name is lowercase letters, digits and dashes, at most 32".into(),
        ));
    }
    let sent = widget::Body::parse(raw).map_err(|why| (StatusCode::BAD_REQUEST, why))?;
    let b = match sent {
        widget::Sent::Clear => {
            return match app
                .store
                .clocked(|c, _| widget::clear(c, desk, name, w.source))
            {
                Ok(was) => {
                    if was {
                        announce(app, desk, name);
                    }
                    Ok(json!({ "cleared": was }))
                }
                Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
            };
        }
        widget::Sent::Body(b) => b,
    };
    // A gallery's body is its outputs, drawn again from what is kept
    // whenever it is pushed, allowed or brought back (`widget::gallery`).
    let gallery = widget::gallery::is_gallery(&b.md) && desk != 0;
    let html = if gallery {
        String::new()
    } else {
        crate::render::widget_md(&b.md)
    };
    match app.store.clocked(|c, now| {
        if gallery {
            let (b, html) = widget::gallery::body_now(c, desk, name, &b)?;
            return widget::put(c, desk, name, &b, &html, w, now);
        }
        widget::put(c, desk, name, &b, &html, w, now)
    }) {
        Ok(widget::Put::Done) => {
            announce(app, desk, name);
            Ok(json!({ "ok": true, "desk": desk, "name": name }))
        }
        Ok(widget::Put::Full) => Err((
            StatusCode::CONFLICT,
            if desk == 0 {
                format!(
                    "there are {} global widgets, which is all there can be",
                    widget::GLOBAL_MAX
                )
            } else {
                format!(
                    "this desk has {} widgets, which is all it can have",
                    widget::DESK_MAX
                )
            },
        )),
        Ok(widget::Put::Owned) => Err((
            StatusCode::CONFLICT,
            format!(
                "a widget file is called {name}, and only it fills that seat: pick another name"
            ),
        )),
        Ok(widget::Put::Box) => Err((
            StatusCode::CONFLICT,
            format!("a box is called {name} on this desk: a widget file does not take its seat"),
        )),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// How often one widget's seat is sent to the pages: an agent writing every
/// 100 ms is drawn twice a second, the last word always.
const COALESCE: std::time::Duration = std::time::Duration::from_millis(500);

/// When each widget -- (desk, name) -- was last sent, and whether a send is waiting.
type Announced = std::collections::HashMap<(i64, String), (Instant, bool)>;
static SENT: std::sync::LazyLock<std::sync::Mutex<Announced>> =
    std::sync::LazyLock::new(Default::default);

/// Tell the pages a widget changed: now, or once its half second is up --
/// whatever it says by then.
pub(crate) fn announce(app: &Arc<App>, desk: i64, name: &str) {
    let key = (desk, name.to_string());
    let now = Instant::now();
    let mut m = SENT.lock().unwrap();
    match m.get_mut(&key) {
        Some((at, waiting)) if now.duration_since(*at) < COALESCE => {
            if !*waiting {
                *waiting = true;
                let wait = COALESCE - now.duration_since(*at);
                let app = app.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    SENT.lock()
                        .unwrap()
                        .insert(key.clone(), (Instant::now(), false));
                    send_seat(&app, key.0, &key.1);
                });
            }
        }
        _ => {
            m.insert(key, (now, false));
            drop(m);
            send_seat(app, desk, name);
        }
    }
}

/// One widget as the pages draw it, or the word that it is gone.
fn send_seat(app: &App, desk: i64, name: &str) {
    match app.store.clocked(|c, _| widget::seat_of(c, desk, name)) {
        Ok(Some(s)) => emit(app, "widget", serde_json::to_value(s).unwrap_or_default()),
        Ok(None) => emit(
            app,
            "widget",
            json!({ "desk_id": desk, "name": name, "cleared": true }),
        ),
        Err(_) => {}
    }
}

/// A panel closed: a box allowed for its life goes, and so does a widget
/// file the reader kept only while it was open -- switched off, not removed.
/// What else its agent pushed stays, dimmed, and says so.
pub(crate) fn pane_widgets_ended(app: &Arc<App>, pane: &str, slot: Option<i64>) {
    let said = slot.map_or("a panel since closed".to_string(), |n| {
        format!("panel {n} closed")
    });
    let found = widget::files::scan(&app.paths.config_dir);
    let Ok(seats) = app.store.clocked(|c, now| {
        let mut s = widget::asks_ending(c, now, |p| p != pane)?;
        for (d, n) in &s {
            widget::clear(c, *d, n, widget::Source::Push)?;
        }
        for f in &found {
            let p = widget::prefs(c, f.owner, &f.name)?;
            if p.until_pane == pane && !p.hidden {
                let off = widget::Change {
                    hidden: Some(true),
                    ..Default::default()
                };
                widget::set_prefs(c, f.owner, &f.name, &off, now)?;
                s.extend(
                    widget::desks_of(c, f.owner, &f.name)?
                        .into_iter()
                        .map(|d| (d, f.name.clone())),
                );
            }
        }
        s.extend(widget::of_pane(c, pane)?);
        widget::pane_ended(c, pane, &said)?;
        Ok(s)
    }) else {
        return;
    };
    for (desk, name) in seats {
        announce(app, desk, &name);
    }
}

// --- the reader's say over a widget file -------------------------------------

#[derive(Deserialize)]
#[serde(default)]
pub(crate) struct AllowBody {
    /// Allow the folder as it is now. False with `rerun_edits` changes the
    /// switch alone.
    allow: bool,
    rerun_edits: Option<bool>,
    /// The desk the widget belongs to; 0 for a shared or global one.
    owner: i64,
}

impl Default for AllowBody {
    fn default() -> AllowBody {
        AllowBody {
            allow: true,
            rerun_edits: None,
            owner: 0,
        }
    }
}

/// Allow a widget file's folder as it is now, and with it, whether the
/// reader's own edits rerun without asking. Only from the window: neither
/// the token an agent holds nor a page's `Origin` is enough to let a
/// command run on a timer.
pub(crate) async fn allow_widget(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let b: AllowBody = serde_json::from_slice(&body).unwrap_or_default();
    let folder = widget::files::folder_of(&app.paths.config_dir, b.owner, &name);
    let spec = match widget::files::read(&folder, &name) {
        Ok(s) => s,
        Err(why) => return refused(StatusCode::NOT_FOUND, why),
    };
    if b.allow {
        if let Err(why) = widget::files::lint(&spec, &folder) {
            return refused(StatusCode::BAD_REQUEST, why);
        }
    }
    let hash = if b.allow {
        match widget::files::hash(&folder) {
            Ok(h) => Some(h),
            Err(why) => return refused(StatusCode::BAD_REQUEST, why),
        }
    } else {
        None
    };
    let ch = widget::Change {
        trusted_hash: hash.as_deref(),
        rerun_edits: b.rerun_edits,
        ..Default::default()
    };
    match app.store.clocked(|c, now| {
        let p = widget::set_prefs(c, b.owner, &name, &ch, now)?;
        let mut ds = if b.allow {
            widget::unstop(c, b.owner, &name, None)?
        } else {
            Vec::new()
        };
        // Every seat it has is told, so a page redrawn before the next run
        // does not show the Allow it just answered.
        for d in widget::desks_of(c, b.owner, &name)? {
            if !ds.contains(&d) {
                ds.push(d);
            }
        }
        Ok((p, ds))
    }) {
        Ok((p, ds)) => {
            for d in ds {
                announce(&app, d, &name);
            }
            Json(json!({ "ok": true, "prefs": p })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct RetryBody {
    desk: Option<i64>,
    /// The desk the widget belongs to; 0 for a shared one.
    owner: i64,
}

/// Try again, on a widget file that stopped after failing: it runs at the
/// runner's next look, on that desk (or every desk it stopped on).
pub(crate) async fn retry_widget(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let b: RetryBody = serde_json::from_slice(&body).unwrap_or_default();
    match app
        .store
        .clocked(|c, _| widget::unstop(c, b.owner, &name, b.desk))
    {
        Ok(ds) => {
            for d in &ds {
                announce(&app, *d, &name);
            }
            Json(json!({ "ok": true, "desks": ds })).into_response()
        }
        Err(e) => err(e),
    }
}

/// Tell the agent, from a failing widget file's box: the agent that
/// proposed it hears why it fails, whole, with its next prompt (#112). One
/// the reader wrote by hand has no agent to tell, and says so.
pub(crate) async fn tell_widget(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let b: RetryBody = serde_json::from_slice(&body).unwrap_or_default();
    let desk = b.desk.unwrap_or(0);
    // Who can hear it: its own panel, or any panel on the desk in its
    // stead (`thread::take_opened`). None, and the button says so rather
    // than "told".
    let live: Vec<String> = app
        .store
        .desk(desk)
        .ok()
        .flatten()
        .map(|d| {
            d.panes
                .iter()
                .filter(|p| app.panes.is_running(&p.id))
                .map(|p| p.id.clone())
                .collect()
        })
        .unwrap_or_default();
    let told = app.store.clocked(|c, _| {
        let Some(seat) = widget::seat_of(c, desk, &name)? else {
            return Ok(None);
        };
        let why = seat
            .error
            .strip_prefix(widget::STOPPED)
            .unwrap_or(&seat.error);
        if why.is_empty() || seat.source != "file" {
            return Ok(None);
        }
        let p = widget::prefs(c, seat.owner, &name)?;
        let next = if p.rerun_edits {
            "the box runs it again once it changes"
        } else {
            "the user is asked to allow it again once it changes"
        };
        let note = format!(
            "The user asks you to fix your widget {name}: its box says \"{why}\". \
             Fix it in its folder; {next}."
        );
        let told = crate::thread::tell_widget(c, seat.owner, &name, &note)?;
        let heard = told && crate::thread::widget_heard(c, seat.owner, &name, &live)?;
        Ok(Some((told, heard)))
    });
    match told {
        Ok(None) => refused(StatusCode::CONFLICT, "nothing to tell: it has not failed"),
        Ok(Some((told, heard))) => Json(json!({
            "told": told && heard,
            "why": if !told { "no agent proposed it" } else if !heard { "its panel closed, and no panel is open on this desk: the next one here hears it" } else { "" },
        }))
        .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PrefsBody {
    hidden: Option<bool>,
    settings: Option<serde_json::Map<String, serde_json::Value>>,
    /// The desks it is on; none is every desk.
    desks: Option<Vec<i64>>,
    /// On this desk alone, from its box's menu.
    only_desk: Option<i64>,
    /// Off this desk, from its box's menu: the rest keep it.
    not_desk: Option<i64>,
    /// When it turns itself off (0: when the reader does), and the panel
    /// whose life it lasts.
    until: Option<i64>,
    until_pane: Option<String>,
    /// The desk the widget belongs to; 0 for a shared or global one.
    owner: i64,
    /// Share a desk's own widget: it moves out of the desk's folder, and is
    /// on that desk alone until the reader ticks more.
    share: bool,
    /// Make a shared widget this desk's own: it moves into the desk's
    /// folder, and leaves the other desks.
    keep_here: Option<i64>,
    /// Take back a Not now, or a Remove, of a panel's box on this desk:
    /// its next push asks again (1.36).
    ask_again: Option<i64>,
}

impl PrefsBody {
    /// Whether this asks for more than off: see `widget_prefs`.
    fn widens(&self) -> bool {
        self.hidden == Some(false)
            || self.settings.is_some()
            || self.desks.is_some()
            || self.only_desk.is_some()
            || self.until.is_some()
            || self.until_pane.is_some()
            || self.share
            || self.keep_here.is_some()
            || self.ask_again.is_some()
    }
}

/// Switch a widget off or on, change its settings, the desks it is on, or
/// how long it lasts: the reader's, from /sidebars and its box's menu. Its
/// seats say so to every page. Off the last desk it was on is off. A desk's
/// own widget is on its desk alone: the desks are not its to change, and
/// off its desk is off.
///
/// Turning it off, or off a desk, is any reader's -- a tab's, the CLI's.
/// What widens it -- on again, more desks, shared, longer, other settings
/// (its stdin) -- is the window's alone, as Allow is: the token an agent
/// holds would otherwise share what the reader allowed on one desk to
/// every desk's folder.
pub(crate) async fn widget_prefs(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(b) = serde_json::from_slice::<PrefsBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget's settings");
    };
    if b.widens() {
        if let Some(no) = refuse_desk(&app, &headers, &q) {
            return no;
        }
    }
    // Off one desk of a widget on every desk pins it to today's desks, so
    // a desk made later never gets it: that narrows what the reader chose
    // for the future, and is the window's.
    if let (Some(_), 0) = (b.not_desk, b.owner) {
        let every = app
            .store
            .clocked(|c, _| widget::prefs(c, 0, &name))
            .map(|p| p.desks.is_empty())
            .unwrap_or(false);
        if every {
            if let Some(no) = refuse_desk(&app, &headers, &q) {
                return no;
            }
        }
    }
    if b.share && b.owner != 0 {
        return rehome_widget(&app, &name, b.owner, 0);
    }
    if let (Some(d), 0) = (b.keep_here, b.owner) {
        return rehome_widget(&app, &name, 0, d);
    }
    if let Some(d) = b.ask_again {
        return match app
            .store
            .clocked(|c, now| widget::ask_again(c, d, &name, now))
        {
            Ok(was) => Json(json!({ "ok": was })).into_response(),
            Err(e) => err(e),
        };
    }
    let owner = b.owner;
    let settings = b.settings.map(|m| serde_json::Value::Object(m).to_string());
    let open: Vec<i64> = app
        .store
        .desks()
        .unwrap_or_default()
        .iter()
        .map(|d| d.id)
        .collect();
    let r = app.store.clocked(|c, now| {
        let was = widget::prefs(c, owner, &name)?;
        let before = widget::desks_of(c, owner, &name)?;
        let mut hidden = b.hidden;
        let desks: Option<Vec<i64>> = match (b.only_desk, b.not_desk, &b.desks) {
            _ if owner != 0 => {
                if b.not_desk == Some(owner) {
                    hidden = Some(true);
                }
                None
            }
            (Some(d), _, _) => Some(vec![d]),
            (_, Some(d), _) => {
                let from = if was.desks.is_empty() {
                    open.clone()
                } else {
                    was.desks.clone()
                };
                let left: Vec<i64> = from.into_iter().filter(|x| *x != d).collect();
                if left.is_empty() {
                    hidden = Some(true);
                    None
                } else {
                    Some(left)
                }
            }
            (_, _, Some(ds)) => Some(ds.iter().copied().filter(|d| open.contains(d)).collect()),
            _ => None,
        };
        // On again, by its switch, after its time was up: on until the
        // reader says, or the runner would switch it off at its next look.
        let back = hidden == Some(false) && was.ended(now, |p| app.panes.is_running(p));
        let until = b.until.map(|u| u.max(0)).or(back.then_some(0));
        let until_pane = b.until_pane.as_deref().or(back.then_some(""));
        let ch = widget::Change {
            hidden,
            settings: settings.as_deref(),
            desks: desks.as_deref(),
            until,
            until_pane,
            ..Default::default()
        };
        let p = widget::set_prefs(c, owner, &name, &ch, now)?;
        let off = if owner == 0 {
            widget::off_desks(c, &name, &p.desks)?
        } else {
            Vec::new()
        };
        // A pushed box's switch is its desk's (owner = its desk, 1.36):
        // that desk is told, whatever was found under the name.
        let mut told = before;
        if owner != 0 && !told.contains(&owner) {
            told.push(owner);
        }
        for d in off {
            if !told.contains(&d) {
                told.push(d);
            }
        }
        Ok((p, told))
    });
    match r {
        Ok((p, desks)) => {
            for d in desks {
                announce(&app, d, &name);
            }
            Json(json!({ "ok": true, "prefs": p })).into_response()
        }
        Err(e) => err(e),
    }
}

/// Share a desk's own widget (`to` 0), or make a shared one a desk's own:
/// its folder moves, and what the reader decided -- allowed, settings, how
/// long -- goes with it. Shared, it is on the desk it came from and no
/// other until the reader ticks more, so nothing runs anywhere new; a
/// desk's own, it leaves every other desk. A global widget is on no desk.
fn rehome_widget(app: &Arc<App>, name: &str, from: i64, to: i64) -> Response {
    let cfg = &app.paths.config_dir;
    let (src, dst) = (
        widget::files::folder_of(cfg, from, name),
        widget::files::folder_of(cfg, to, name),
    );
    match widget::files::read(&src, name) {
        Err(why) => return refused(StatusCode::NOT_FOUND, why),
        Ok(s) if s.scope == widget::files::Scope::Global => {
            return refused(
                StatusCode::BAD_REQUEST,
                "a global widget is on the left, not on a desk",
            )
        }
        Ok(_) => {}
    }
    if to != 0
        && !app
            .store
            .desks()
            .map(|ds| ds.iter().any(|d| d.id == to))
            .unwrap_or(false)
    {
        return refused(StatusCode::NOT_FOUND, format!("there is no desk {to}"));
    }
    if let Some(why) = widget::files::taken_moving(cfg, from, to, name) {
        return refused(StatusCode::CONFLICT, why);
    }
    let moved = dst
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::rename(&src, &dst));
    if let Err(e) = moved {
        return refused(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not move it: {e}"),
        );
    }
    match app
        .store
        .clocked(|c, now| widget::rehome(c, name, from, to, now))
    {
        Ok(desks) => {
            for d in desks.iter().chain((to != 0).then_some(&to)) {
                announce(app, *d, name);
            }
            Json(json!({ "ok": true, "owner": to })).into_response()
        }
        Err(e) => {
            // The record did not change: the folder goes back with it.
            let _ = std::fs::rename(&dst, &src);
            err(e)
        }
    }
}

// --- removing an agent's ----------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct RemoveBody {
    /// The desk its box is on.
    desk: i64,
    /// The desk a widget file belongs to; 0 for a box a panel pushed.
    owner: i64,
    /// Undo's: the id its folder was kept under (`files::remove`).
    from: String,
}

/// Remove an agent's widget, from its box's menu or /sidebars: a desk's own
/// widget file moves to `widgets/.removed/` and the agent that proposed it
/// is told; a box a panel pushed goes, and that panel's next push of it is
/// refused. Nothing is deleted, and Undo (`restore_widget`) puts it back.
/// The window's alone, as Allow is: an agent's token removes nothing. A
/// shared or global widget file, and a script's box, are the reader's own
/// and have Turn off.
pub(crate) async fn remove_widget(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let b: RemoveBody = serde_json::from_slice(&body).unwrap_or_default();
    if b.owner == 0 {
        return match app
            .store
            .clocked(|c, now| widget::remove_box(c, b.desk, &name, now))
        {
            Ok(true) => {
                announce(&app, b.desk, &name);
                Json(json!({ "ok": true })).into_response()
            }
            Ok(false) => refused(
                StatusCode::CONFLICT,
                "only a box an agent pushed can be removed: Turn off takes the rest out of view",
            ),
            Err(e) => err(e),
        };
    }
    let cfg = &app.paths.config_dir;
    // A seat whose folder is gone already (1.46): nothing to keep, so
    // nothing to undo; the seat goes, and the agent is not told of a
    // removal that was its own.
    if !widget::files::folder_of(cfg, b.owner, &name).is_dir() {
        return match app.store.clocked(|c, _| {
            let desks = widget::desks_of(c, b.owner, &name)?;
            for d in &desks {
                widget::clear(c, *d, &name, widget::Source::File)?;
            }
            Ok(desks)
        }) {
            Ok(desks) => {
                for d in desks {
                    announce(&app, d, &name);
                }
                Json(json!({ "ok": true, "from": serde_json::Value::Null })).into_response()
            }
            Err(e) => err(e),
        };
    }
    let id = match widget::files::remove(cfg, b.owner, &name, crate::store::now()) {
        Ok(id) => id,
        Err(why) => return refused(StatusCode::NOT_FOUND, why),
    };
    let note = format!(
        "The user removed your widget {name} from this desk. Leave it removed: \
         propose it again only if they ask for it."
    );
    let r = app.store.clocked(|c, _| {
        let desks = widget::desks_of(c, b.owner, &name)?;
        for d in &desks {
            widget::clear(c, *d, &name, widget::Source::File)?;
        }
        crate::thread::tell_widget(c, b.owner, &name, &note)?;
        Ok(desks)
    });
    match r {
        Ok(desks) => {
            for d in desks {
                announce(&app, d, &name);
            }
            Json(json!({ "ok": true, "from": id })).into_response()
        }
        Err(e) => {
            // The record did not change: the folder goes back with it.
            let _ = widget::files::restore(cfg, &id, b.owner, &name);
            err(e)
        }
    }
}

/// Undo a removal, within the moment its box offers it: a widget file's
/// folder back where it was -- allowed as it was, since what the reader
/// decided about it was kept -- or a box allowed again with what it last
/// showed.
pub(crate) async fn restore_widget(
    State(app): S,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !widget::name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let b: RemoveBody = serde_json::from_slice(&body).unwrap_or_default();
    if b.owner != 0 {
        return match widget::files::restore(&app.paths.config_dir, &b.from, b.owner, &name) {
            Ok(()) => {
                let _ = app
                    .store
                    .clocked(|c, now| widget::untell_removed(c, b.owner, &name, now));
                Json(json!({ "ok": true })).into_response()
            }
            Err(why) => refused(StatusCode::CONFLICT, why),
        };
    }
    match app
        .store
        .clocked(|c, now| widget::restore_box(c, b.desk, &name, now))
    {
        Ok(Some(a)) => {
            let pane = if app.panes.is_running(&a.pane) {
                a.pane.as_str()
            } else {
                ""
            };
            let w = widget::Writer {
                source: widget::Source::Push,
                writer: &a.writer,
                pane,
                title: "",
                owner: 0,
            };
            push(&app, b.desk, &name, &a.body, &w)
        }
        Ok(None) => refused(
            StatusCode::CONFLICT,
            format!("{name} was not removed from here"),
        ),
        Err(e) => err(e),
    }
}

// --- an agent proposing one ----------------------------------------------------

/// What `propose_widget` sends: a widget file, whole.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct ProposeBody {
    name: String,
    title: String,
    /// Before 1.32 an agent could ask for every desk or global; its widget
    /// is its desk's now, and a scope sent is not read.
    #[allow(dead_code)]
    scope: String,
    command: String,
    every: u64,
    timeout: u64,
    lines: u8,
    script_name: String,
    script: String,
    why: String,
    by: String,
    /// How long the agent suggests it lasts: `today`, `week`, `panel`.
    #[serde(rename = "for")]
    lasts: String,
    /// The rows /sidebars draws for it, as `widget.json` has them
    /// (`files::Field`); the run gets them on stdin.
    settings: serde_json::Map<String, serde_json::Value>,
    /// Files beside the script that it reads: a helper, a query. Each is
    /// shown on the card, as the script is.
    files: std::collections::BTreeMap<String, String>,
    /// The desk keys the run needs, by name (1.46): on the card, in the
    /// run's environment once the reader adds it.
    keys: Vec<String>,
}

/// The longest script a proposal may carry, and each file beside it.
const SCRIPT_MAX: usize = 16 * 1024;

/// How many files a proposal may carry beside its script.
const FILES_MAX: usize = 4;

/// A file a proposal writes: in its own folder, by a plain name, never
/// `widget.json`, which is snyvi's to write from what was sent -- in any
/// case, since a Mac's or Windows' disk takes `Widget.json` for it.
fn proposed_name_ok(n: &str) -> bool {
    !n.is_empty()
        && !n.contains(['/', '\\'])
        && !n.starts_with('.')
        && !n.eq_ignore_ascii_case("widget.json")
}

/// Whether a proposal's files are each one of their own on any disk: none
/// is the script, or another of them, but for its case -- which on a Mac
/// or Windows would write over the one the card shows.
fn proposed_names_apart(script: &str, files: &std::collections::BTreeMap<String, String>) -> bool {
    let mut seen = std::collections::HashSet::new();
    std::iter::once(script)
        .filter(|n| !n.is_empty())
        .chain(files.keys().map(String::as_str))
        .all(|n| seen.insert(n.to_lowercase()))
}

/// Where proposals wait until the reader adds them or not: under the
/// widgets folder, in a name no widget can have, so the runner never sees
/// them.
fn proposed_dir(app: &App) -> std::path::PathBuf {
    widget::files::dir(&app.paths.config_dir).join(".proposed")
}

/// Why an agent's proposal is refused before anything is written, or
/// nothing: its name, room on the desk, a one-line command, and files
/// named apart and small enough to hash.
fn propose_refusal(app: &App, desk: i64, b: &ProposeBody) -> Option<Box<Response>> {
    if !widget::name_ok(&b.name) {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "a widget's name is lowercase letters, digits and dashes, at most 32",
        )));
    }
    if let Some(why) = widget::files::taken(&app.paths.config_dir, desk, &b.name) {
        return Some(Box::new(refused(StatusCode::CONFLICT, why)));
    }
    // A name a box holds on the desk, and one the reader said Not now to:
    // neither is proposed over.
    let standing = app.store.clocked(|c, _| {
        Ok((
            widget::desk_has_room(c, desk)?,
            widget::name_held(c, desk, &b.name)?,
            widget::proposals_declined(c, desk)?.contains(&b.name),
        ))
    });
    let (room, held, declined) = standing.unwrap_or((true, None, false));
    if matches!(held, Some(widget::Held::Box) | Some(widget::Held::Asked(_))) {
        return Some(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "a box is called {} on this desk already: pick another name",
                b.name
            ),
        )));
    }
    if declined {
        return Some(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "the user said not now to the widget {}: leave it, or say in your reply why it would help",
                b.name
            ),
        )));
    }
    if !room {
        return Some(Box::new(refused(
            StatusCode::CONFLICT,
            format!(
                "this desk shows {} widgets already: read_widgets, and update one of yours",
                widget::DESK_MAX
            ),
        )));
    }
    let command = b.command.trim();
    if command.is_empty() || command.contains('\n') {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "the command is one line",
        )));
    }
    if b.script_name.is_empty() && !b.script.trim().is_empty() {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "name the script: script_name is the file the script is written as, which the command names",
        )));
    }
    let script_ok = b.script_name.is_empty() || proposed_name_ok(&b.script_name);
    if !script_ok || b.script.len() > SCRIPT_MAX {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "the script is one file of at most 16 KB, named without a folder",
        )));
    }
    if b.keys.len() > widget::files::KEYS_MAX
        || b.keys
            .iter()
            .any(|k| crate::secrets::valid_name(k).is_err())
    {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            format!(
                "keys are the names of at most {} of this desk's keys, as the Keys list shows them",
                widget::files::KEYS_MAX
            ),
        )));
    }
    let files_ok = b.files.len() <= FILES_MAX
        && proposed_names_apart(&b.script_name, &b.files)
        && b.files
            .iter()
            .all(|(n, t)| proposed_name_ok(n) && t.len() <= SCRIPT_MAX);
    if !files_ok {
        return Some(Box::new(refused(
            StatusCode::BAD_REQUEST,
            "files beside the script are at most 4, each of at most 16 KB, named without a folder, and none the script's name or another's in any case",
        )));
    }
    None
}

/// A proposal's folder, written where proposals wait: snyvi's widget.json
/// from what was sent, the script made runnable, the files beside it.
fn write_proposal(stage: &std::path::Path, b: &ProposeBody, command: &str) -> std::io::Result<()> {
    let spec = json!({
        "name": b.name,
        "title": b.title.trim(),
        "scope": "desk",
        "run": { "command": command, "every": if b.every == 0 { widget::files::EVERY_DEFAULT } else { b.every }, "timeout": if b.timeout == 0 { widget::files::TIMEOUT_DEFAULT } else { b.timeout } },
        "lines": if b.lines == 0 { widget::LINES_DEFAULT } else { b.lines },
        "settings": b.settings,
        "keys": b.keys,
    });
    // Its own folder, never one that is there: two proposals in one second
    // would otherwise write into each other's, and the card would show
    // less than Add allows.
    if let Some(parent) = stage.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir(stage)?;
    std::fs::write(
        stage.join("widget.json"),
        serde_json::to_string_pretty(&spec).unwrap_or_default() + "\n",
    )?;
    if !b.script_name.is_empty() {
        let p = stage.join(&b.script_name);
        std::fs::write(&p, &b.script)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    for (n, t) in &b.files {
        std::fs::write(stage.join(n), t)?;
    }
    Ok(())
}

/// An agent proposes a widget: the folder is written where proposals wait,
/// and the reader gets a card on On you -- Add, or Not now. Nothing runs
/// and nothing is in the widgets folder until Add. It is for the agent's
/// desk alone: sharing it is the reader's (1.32).
pub(crate) async fn pane_propose_widget(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let Ok(b) = serde_json::from_slice::<ProposeBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget");
    };
    if let Some(no) = propose_refusal(&app, placed.desk_id, &b) {
        return *no;
    }
    let command = b.command.trim();
    // Where it goes: this desk, alone.
    let place = "here";
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() & 0xffff)
        .unwrap_or(0);
    let stage = proposed_dir(&app).join(format!("{}-{nonce:04x}-{}", crate::store::now(), b.name));
    let wrote = write_proposal(&stage, &b, command);
    if let Err(e) = wrote {
        return refused(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not write it: {e}"),
        );
    }
    // Checked before the reader sees it: a command that cannot reach its own
    // script goes back to the agent with how to write it (#111).
    let read = widget::files::read(&stage, &b.name)
        .and_then(|s| widget::files::settings_ok(&s).map(|_| s))
        .and_then(|s| widget::files::keys_ok(&s, placed.desk_id).map(|_| s))
        .and_then(|s| widget::files::lint(&s, &stage).map(|_| s));
    // The card is the folder as it is now: Try once and Add refuse a folder
    // that changed after it (an agent has a shell as the reader).
    let read = read.and_then(|s| widget::files::hash(&stage).map(|h| (s, h)));
    let (spec, hash) = match read {
        Ok(s) => s,
        Err(why) => {
            let _ = std::fs::remove_dir_all(&stage);
            return refused(StatusCode::BAD_REQUEST, why);
        }
    };
    // The card shows the folder that was hashed, read back from it, so
    // what Add allows is what the card showed, file for file.
    let files: Vec<serde_json::Value> = std::fs::read_dir(&stage)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n == "widget.json" || n == b.script_name {
                return None;
            }
            let text = std::fs::read_to_string(e.path()).ok()?;
            Some(json!({ "name": n, "text": text }))
        })
        .collect();
    let detail = json!({
        "hash": hash,
        "where": place,
        "every": spec.run.every,
        "lines": spec.lines,
        "script_name": b.script_name,
        "script": std::fs::read_to_string(stage.join(&b.script_name)).unwrap_or_default(),
        "files": files,
        "settings": spec.settings,
        "keys": spec.keys,
    });
    let s = crate::thread::Suggest {
        kind: "widget".into(),
        name: b.name.clone(),
        cmd: command.to_string(),
        folder: stage.to_string_lossy().to_string(),
        why: b.why,
        by: b.by,
        pane: id,
        lasts: b.lasts,
        detail: detail.to_string(),
    };
    let desk = placed.desk_id;
    match app
        .store
        .clocked(|c, now| crate::thread::suggest(c, desk, &s, now))
    {
        Ok(crate::thread::Suggested::Card(card)) => {
            threads_moved(&app, desk);
            (StatusCode::CREATED, Json(json!({ "suggestion": card }))).into_response()
        }
        Ok(crate::thread::Suggested::Full) => {
            let _ = std::fs::remove_dir_all(&stage);
            refused(
                StatusCode::CONFLICT,
                "three suggestions are waiting on this desk already",
            )
        }
        Ok(_) => {
            let _ = std::fs::remove_dir_all(&stage);
            refused(StatusCode::BAD_REQUEST, "say why, in a sentence")
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&stage);
            err(e)
        }
    }
}

/// What an agent in a panel reads of its desk's widgets (`read_widgets`):
/// what each shows, in the Markdown it was sent or printed in, and where
/// each stands -- a box waiting on its card, allowed, Not now, removed; a
/// widget file allowed, changed since, off, stopped -- so it does not push
/// a box the reader said no to, or propose a name that is taken. A read,
/// with the token, of this panel's desk alone.
pub(crate) async fn pane_widgets(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    let cfg = &app.paths.config_dir;
    // Hashed before the lock is taken: the store waits on no disk.
    let found: Vec<_> = widget::files::scan(cfg)
        .into_iter()
        .filter(|f| f.owner == 0 || f.owner == desk)
        .map(|f| {
            let hash = widget::files::hash(&f.folder).ok();
            (f, hash)
        })
        .collect();
    // Removed, and not back since: a name proposed again and added is
    // not one to leave alone.
    let live: Vec<String> = found.iter().map(|(f, _)| f.name.clone()).collect();
    let removed: Vec<String> = widget::files::removed_names(cfg, desk)
        .into_iter()
        .filter(|n| !live.contains(n))
        .collect();
    let r = app.store.clocked(|c, _| {
        let seats = widget::seats(c, desk)?;
        let md = widget::bodies_md(c, desk)?;
        let mut shown = Vec::new();
        for s in &seats {
            let body = md
                .iter()
                .find(|(n, _)| *n == s.name)
                .map(|(_, b)| b.as_str());
            // Where it stands, in words an agent can act on: what waits on
            // the reader is not a failure of the script's.
            let state = if s.hidden {
                "off"
            } else if s.error.starts_with(widget::STOPPED) {
                "stopped"
            } else if s.error.starts_with("allow: ") {
                "waits for the user's Allow"
            } else if s.error.starts_with("changed: ") {
                "changed since allowed: waits for the user's Allow"
            } else if s.error.starts_with("needs the key ") {
                "waits for a key"
            } else if !s.error.is_empty() {
                "failing"
            } else {
                "showing"
            };
            let yours = if s.source == "file" {
                widget::prefs(c, s.owner, &s.name)?.proposed_by == id
            } else {
                s.pane == id
            };
            shown.push(json!({
                "name": s.name,
                "kind": if s.source == "file" { "file" } else { "box" },
                "title": s.title, "count": s.count, "tone": s.tone,
                "body": body.unwrap_or(""), "by": s.writer, "yours": yours,
                "state": state, "error": s.error, "updated_at": s.updated_at,
            }));
        }
        let boxes: Vec<serde_json::Value> = widget::asks(c, desk)?
            .into_iter()
            .map(|a| {
                let answer = match a.answer.as_str() {
                    "" => "waiting",
                    "yes" => "allowed",
                    "no" => "not now",
                    other => other,
                };
                json!({ "name": a.name, "answer": answer, "yours": a.pane == id })
            })
            .collect();
        let files = desk_files(c, &found, desk, &id)?;
        let cards: Vec<serde_json::Value> = crate::thread::suggestions(c, desk)?
            .into_iter()
            .filter(|s| s.kind == "widget" || s.kind == "box")
            .map(|s| json!({ "kind": s.kind, "name": s.name, "yours": s.pane == id }))
            .collect();
        Ok(json!({
            "desk": placed.desk_name, "limit": widget::DESK_MAX, "widgets": shown,
            "boxes": boxes, "files": files, "waiting": cards,
            "proposals_not_now": widget::proposals_declined(c, desk)?,
            "removed": removed,
        }))
    });
    match r {
        Ok(j) => Json(j).into_response(),
        Err(e) => err(e),
    }
}

/// The widget files on desk `desk`, for `read_widgets`: allowed, changed
/// since, off -- or the reason one cannot be read, which is what an agent
/// that wrote it needs.
fn desk_files(
    c: &rusqlite::Connection,
    found: &[(widget::files::Found, Option<String>)],
    desk: i64,
    pane: &str,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut files = Vec::new();
    for (f, hash) in found {
        let p = widget::prefs(c, f.owner, &f.name)?;
        let spec = match &f.spec {
            Ok(spec) => spec,
            Err(why) => {
                if f.owner == desk {
                    files.push(json!({ "name": f.name, "own": true, "error": why }));
                }
                continue;
            }
        };
        let here = if f.owner != 0 {
            f.owner == desk
        } else {
            spec.scope == widget::files::Scope::Desk && p.on_desk(desk)
        };
        if !here {
            continue;
        }
        let trusted = !p.trusted_hash.is_empty();
        files.push(json!({
            "name": f.name, "title": spec.title, "command": spec.run.command,
            "every": spec.run.every, "own": f.owner == desk, "yours": p.proposed_by == pane,
            "keys": spec.keys,
            "allowed": trusted && hash.as_deref() == Some(p.trusted_hash.as_str()),
            "changed": trusted && hash.as_deref() != Some(p.trusted_hash.as_str()),
            "off": p.hidden, "until": p.until,
        }));
    }
    Ok(files)
}

/// How long the reader said a widget lasts, from the card: until when, and
/// the panel whose life it lasts.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Lasts {
    pub(crate) until: i64,
    pub(crate) until_pane: String,
}

/// Why a card could not be added: its folder is not what it showed (the
/// card is stale, and settled so: the agent is told), or the desk is full
/// (the card waits, and the reader is told).
#[derive(Debug)]
pub(crate) struct NotAdded {
    pub(crate) why: String,
    pub(crate) stale: bool,
}

/// The reader added a proposed widget: its folder moves into the folder of
/// the desk the card was on, allowed **as the card showed it** -- the hash
/// the card carries is what is trusted, and a folder that differs after
/// the move is refused rather than allowed unseen -- that desk's own, for
/// as long as the reader chose, with nothing of an earlier widget of that
/// name (its Rerun my edits, its settings) carried over. A card from before
/// 1.32 that said every desk, or global, is shared as it said. Refused if
/// a widget or a box took the name meanwhile.
pub(crate) fn install_proposed(
    app: &App,
    card: &crate::thread::Suggestion,
    lasts: &Lasts,
) -> Result<(), NotAdded> {
    let stale = |why: String| NotAdded { why, stale: true };
    let name = card.name.as_str();
    let stage = proposal_as_shown(app, card).map_err(stale)?;
    let spec = widget::files::read(&stage, name).map_err(stale)?;
    widget::files::lint(&spec, &stage).map_err(stale)?;
    let shared = spec.scope == widget::files::Scope::Global
        || card.detail.get("where").and_then(|w| w.as_str()) != Some("here");
    let owner = if shared { 0 } else { card.desk_id };
    widget::files::keys_ok(&spec, owner).map_err(stale)?;
    let held = app
        .store
        .clocked(|c, _| {
            Ok((
                widget::desk_has_room(c, card.desk_id)?,
                widget::name_held(c, card.desk_id, name)?,
            ))
        })
        .unwrap_or((true, None));
    if !shared && !held.0 {
        return Err(NotAdded {
            why: format!(
                "this desk shows {} widgets already: remove one first",
                widget::DESK_MAX
            ),
            stale: false,
        });
    }
    if matches!(
        held.1,
        Some(widget::Held::Box) | Some(widget::Held::Asked(_))
    ) {
        return Err(stale(format!(
            "a box is called {name} on this desk: the widget would take its seat. Ask the agent to propose it under another name"
        )));
    }
    let cfg = &app.paths.config_dir;
    if let Some(why) = widget::files::taken(cfg, owner, name) {
        return Err(stale(why));
    }
    let shown = card
        .detail
        .get("hash")
        .and_then(|h| h.as_str())
        .map(String::from)
        .ok_or_else(|| {
            stale("this card is from before 1.36: ask the agent to propose it again".into())
        })?;
    let to = widget::files::folder_of(cfg, owner, name);
    to.parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::rename(&stage, &to))
        .map_err(|e| NotAdded {
            why: format!("could not move it in: {e}"),
            stale: false,
        })?;
    if widget::files::hash(&to).ok().as_deref() != Some(shown.as_str()) {
        let _ = std::fs::rename(&to, &stage);
        return Err(stale(
            "its folder changed as it was added: not what this card shows. Ask the agent to propose it again".into(),
        ));
    }
    let desks: Vec<i64> = Vec::new();
    let ch = widget::Change {
        hidden: Some(false),
        trusted_hash: Some(&shown),
        rerun_edits: Some(false),
        settings: Some("{}"),
        desks: Some(&desks),
        until: Some(lasts.until.max(0)),
        until_pane: Some(&lasts.until_pane),
        proposed_by: Some(&card.pane),
    };
    app.store
        .clocked(|c, now| widget::set_prefs(c, owner, name, &ch, now))
        .map(|_| ())
        .map_err(|e| NotAdded {
            why: e.to_string(),
            stale: false,
        })
}

/// The reader allowed a panel's box: what waits behind the card is drawn,
/// and from now on the panel's updates go straight in -- until when the
/// reader said.
pub(crate) fn allow_box(
    app: &Arc<App>,
    card: &crate::thread::Suggestion,
    lasts: &Lasts,
) -> Result<(), String> {
    let (desk, name) = (card.desk_id, card.name.as_str());
    let ask = app
        .store
        .clocked(|c, _| widget::ask_of(c, desk, name))
        .map_err(|e| e.to_string())?
        .ok_or("the box is not there any more")?;
    // Drawn first, and the yes written only once it is: a desk that is
    // full, or a name a file took meanwhile, is said in the daemon's words
    // and leaves no yes behind a card that still asks.
    if !ask.body.trim().is_empty() {
        let w = widget::Writer {
            source: widget::Source::Push,
            writer: &ask.writer,
            pane: &ask.pane,
            title: "",
            owner: 0,
        };
        push_result(app, desk, name, &ask.body, &w).map_err(|(_, why)| why)?;
    }
    app.store
        .clocked(|c, now| {
            widget::ask_answer(
                c,
                desk,
                name,
                "yes",
                lasts.until.max(0),
                &lasts.until_pane,
                now,
            )
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A proposal's folder, if it is still what its card shows: there, where
/// proposals wait, and not changed since it was proposed. A card made
/// before 1.36 kept no hash, and is asked again.
fn proposal_as_shown(
    app: &App,
    card: &crate::thread::Suggestion,
) -> Result<std::path::PathBuf, String> {
    let stage = std::path::PathBuf::from(&card.folder);
    if !stage.starts_with(proposed_dir(app)) || !stage.is_dir() {
        return Err("the proposal is not there any more".into());
    }
    let shown = card.detail.get("hash").and_then(|h| h.as_str());
    match (shown, widget::files::hash(&stage)) {
        (Some(was), Ok(now)) if was == now => Ok(stage),
        (None, _) => Err("this card is from before 1.36: ask the agent to propose it again".into()),
        _ => Err("its folder changed after it was proposed: not what this card shows. Ask the agent to propose it again".into()),
    }
}

/// What Try once printed, drawn, or why it printed nothing usable.
pub(crate) async fn try_proposed(app: &App, card: &crate::thread::Suggestion) -> serde_json::Value {
    let stage = match proposal_as_shown(app, card) {
        Ok(s) => s,
        Err(why) => return json!({ "error": why }),
    };
    let spec = match widget::files::read(&stage, &card.name)
        .and_then(|s| widget::files::lint(&s, &stage).map(|_| s))
    {
        Ok(s) => s,
        Err(why) => return json!({ "error": why }),
    };
    let desk = app.store.desk(card.desk_id).ok().flatten();
    let cwd = match (spec.scope, &desk) {
        (widget::files::Scope::Global, _) => stage.clone(),
        (_, Some(d)) if !d.root.is_empty() && std::path::Path::new(&d.root).is_dir() => {
            std::path::PathBuf::from(&d.root)
        }
        _ => return json!({ "error": "this desk has no folder to run it in" }),
    };
    let stdin = json!({
        "desk": desk.as_ref().map(|d| json!({ "id": d.id, "name": d.name, "folder": d.root })),
        "settings": spec.settings_with("{}"),
        "snyvi": VERSION,
    });
    let path = super::widget_run::path_now();
    // The keys it names, from this desk, as the runner would give them.
    let keys: Vec<(String, String)> = spec
        .keys
        .iter()
        .filter_map(|k| app.secrets.value(card.desk_id, k).map(|v| (k.clone(), v)))
        .collect();
    if keys.len() < spec.keys.len() {
        let missing: Vec<&str> = spec
            .keys
            .iter()
            .filter(|k| !keys.iter().any(|(n, _)| n == *k))
            .map(String::as_str)
            .collect();
        return json!({ "error": format!("needs the key {} on this desk: add it under Keys first", missing.join(", ")) });
    }
    match super::widget_run::run_once(&spec, &stage, &cwd, &path, &stdin, &keys).await {
        super::widget_run::Ran::Failed(why) => {
            json!({ "error": format!("{why} (in {})", crate::text::tilde(&cwd)) })
        }
        super::widget_run::Ran::Printed(out) => match widget::Body::parse(&out) {
            Err(why) => json!({ "error": why }),
            Ok(widget::Sent::Clear) => json!({ "html": "", "empty": true }),
            Ok(widget::Sent::Body(b)) => json!({
                "html": crate::render::widget_md(&b.md), "count": b.count, "tone": b.tone.as_str(),
            }),
        },
    }
}
