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
/// with its desk. A read, open as the project list is.
pub(crate) async fn list_widgets(State(app): S) -> Response {
    let found = widget::files::scan(&app.paths.config_dir);
    let desks = app.store.desks().unwrap_or_default();
    let r = app.store.clocked(|c, _| {
        let layout = widget::layout(c)?;
        let mut files = Vec::new();
        for f in &found {
            let p = widget::prefs(c, &f.name)?;
            let hash = widget::files::hash(&f.folder);
            files.push(match &f.spec {
                Ok(s) => json!({
                    "name": f.name, "title": s.title, "scope": s.scope, "command": s.run.command,
                    "every": s.run.every, "folder": f.folder, "lines": s.lines,
                    "allowed": !p.trusted_hash.is_empty() && hash.as_deref().ok() == Some(p.trusted_hash.as_str()),
                    "changed": !p.trusted_hash.is_empty() && hash.as_deref().ok() != Some(p.trusted_hash.as_str()),
                    "error": widget::files::lint(s, &f.folder).err().or(hash.err()), "rerun_edits": p.rerun_edits, "hidden": p.hidden,
                    "fields": s.settings, "settings": s.settings_with(&p.settings),
                    "desks": p.desks, "until": p.until, "until_pane": p.until_pane,
                }),
                Err(why) => json!({ "name": f.name, "folder": f.folder, "error": why, "hidden": p.hidden }),
            });
        }
        let mut pushed = Vec::new();
        for d in std::iter::once(0).chain(desks.iter().map(|d| d.id)) {
            for s in widget::seats(c, d)? {
                if s.source == "push" {
                    let desk = desks.iter().find(|x| x.id == d).map(|x| x.name.clone());
                    pushed.push(json!({ "name": s.name, "desk_id": d, "desk": desk, "writer": s.writer, "updated_at": s.updated_at, "hidden": s.hidden }));
                }
            }
        }
        let open: Vec<serde_json::Value> = desks
            .iter()
            .map(|d| json!({ "id": d.id, "name": d.name }))
            .collect();
        Ok(json!({ "layout": layout, "files": files, "pushed": pushed, "desks": open }))
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
    name: String,
    body: serde_json::Value,
    desk: Option<i64>,
    writer: String,
    /// A panel's box: how long it suggests the box lasts, on the card.
    #[serde(rename = "for")]
    lasts: String,
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
    };
    let desk = placed.desk_id;
    if !widget::name_ok(&b.name) {
        return push(&app, desk, &b.name, "", &w);
    }
    // The reader says yes to a panel's box once per desk and name (#111):
    // until then it waits behind a card on Your turn, and nothing is drawn.
    let raw = b.raw();
    let ask = app.store.clocked(|c, now| {
        widget::ask_grandfather(c, desk, &b.name, now)?;
        widget::ask_of(c, desk, &b.name)
    });
    match ask {
        Err(e) => err(e),
        Ok(Some(a)) if a.answer == "yes" => push(&app, desk, &b.name, &raw, &w),
        Ok(Some(a)) if a.answer == "no" => refused(
            StatusCode::CONFLICT,
            format!(
                "the user said not now to the box {} on this desk: leave it, or say in your reply why it would help",
                b.name
            ),
        ),
        Ok(_) => ask_for_box(&app, desk, &id, &writer, &b, &raw),
    }
}

/// A panel's box the reader has not said yes to: its body waits, and the
/// card that asks is on Your turn -- one per desk and name, however often
/// the panel sends meanwhile. A clear while it waits takes the body back.
fn ask_for_box(
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
    let preview: String = widget::Body::parse(raw)
        .ok()
        .and_then(|s| match s {
            widget::Sent::Body(b) => Some(b.md),
            widget::Sent::Clear => None,
        })
        .unwrap_or_default();
    let r = app.store.clocked(|c, now| {
        widget::ask_wait(
            c,
            desk,
            &b.name,
            pane,
            writer,
            if cleared { "" } else { raw },
            now,
        )?;
        if cleared || crate::thread::box_waiting(c, desk, &b.name)? {
            return Ok(None);
        }
        let s = crate::thread::Suggest {
            kind: "box".into(),
            name: b.name.clone(),
            cmd: preview.clone(),
            why: format!("{writer} wants a box on this desk"),
            by: writer.to_string(),
            pane: pane.to_string(),
            lasts: b.lasts.clone(),
            ..Default::default()
        };
        crate::thread::suggest(c, desk, &s, now).map(Some)
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
    let w = widget::Writer {
        source: widget::Source::Push,
        writer: &writer,
        pane: "",
        title: "",
    };
    push(&app, desk, &b.name, &b.raw(), &w)
}

/// Read, draw, keep and say a pushed body, or clear the widget.
fn push(app: &Arc<App>, desk: i64, name: &str, raw: &str, w: &widget::Writer) -> Response {
    if !widget::name_ok(name) {
        return refused(
            StatusCode::BAD_REQUEST,
            "a widget's name is lowercase letters, digits and dashes, at most 32",
        );
    }
    let sent = match widget::Body::parse(raw) {
        Ok(s) => s,
        Err(why) => return refused(StatusCode::BAD_REQUEST, why),
    };
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
                    Json(json!({ "cleared": was })).into_response()
                }
                Err(e) => err(e),
            };
        }
        widget::Sent::Body(b) => b,
    };
    let html = crate::render::widget_md(&b.md);
    match app
        .store
        .clocked(|c, now| widget::put(c, desk, name, &b, &html, w, now))
    {
        Ok(widget::Put::Done) => {
            announce(app, desk, name);
            Json(json!({ "ok": true, "desk": desk, "name": name })).into_response()
        }
        Ok(widget::Put::Full) => refused(
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
        ),
        Ok(widget::Put::Owned) => refused(
            StatusCode::CONFLICT,
            format!(
                "a widget file is called {name}, and only it fills that seat: pick another name"
            ),
        ),
        Err(e) => err(e),
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
            let p = widget::prefs(c, &f.name)?;
            if p.until_pane == pane && !p.hidden {
                let off = widget::Change {
                    hidden: Some(true),
                    ..Default::default()
                };
                widget::set_prefs(c, &f.name, &off, now)?;
                s.extend(
                    widget::desks_of(c, &f.name)?
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
}

impl Default for AllowBody {
    fn default() -> AllowBody {
        AllowBody {
            allow: true,
            rerun_edits: None,
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
    let folder = widget::files::dir(&app.paths.config_dir).join(&name);
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
        let p = widget::set_prefs(c, &name, &ch, now)?;
        let ds = if b.allow {
            widget::unstop(c, &name, None)?
        } else {
            Vec::new()
        };
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
    match app.store.clocked(|c, _| widget::unstop(c, &name, b.desk)) {
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
        let note = format!(
            "The reader asks you to fix your widget {name}: its box says \"{why}\". \
             Fix it in its folder; the box runs it again once it changes."
        );
        crate::thread::tell_widget(c, &name, &note).map(Some)
    });
    match told {
        Ok(None) => refused(StatusCode::CONFLICT, "nothing to tell: it has not failed"),
        Ok(Some(told)) => Json(json!({ "told": told })).into_response(),
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
}

/// Switch a widget off or on, change its settings, the desks it is on, or
/// how long it lasts: the reader's, from /sidebars and its box's menu. Its
/// seats say so to every page. Off the last desk it was on is off.
pub(crate) async fn widget_prefs(
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
    let Ok(b) = serde_json::from_slice::<PrefsBody>(&body) else {
        return refused(StatusCode::BAD_REQUEST, "not a widget's settings");
    };
    let settings = b.settings.map(|m| serde_json::Value::Object(m).to_string());
    let open: Vec<i64> = app
        .store
        .desks()
        .unwrap_or_default()
        .iter()
        .map(|d| d.id)
        .collect();
    let r = app.store.clocked(|c, now| {
        let was = widget::prefs(c, &name)?;
        let before = widget::desks_of(c, &name)?;
        let mut hidden = b.hidden;
        let desks: Option<Vec<i64>> = match (b.only_desk, b.not_desk, &b.desks) {
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
        let p = widget::set_prefs(c, &name, &ch, now)?;
        let off = widget::off_desks(c, &name, &p.desks)?;
        let mut told = before;
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

// --- an agent proposing one ----------------------------------------------------

/// What `propose_widget` sends: a widget file, whole.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct ProposeBody {
    name: String,
    title: String,
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
}

/// The longest script a proposal may carry.
const SCRIPT_MAX: usize = 16 * 1024;

/// Where proposals wait until the reader adds them or not: under the
/// widgets folder, in a name no widget can have, so the runner never sees
/// them.
fn proposed_dir(app: &App) -> std::path::PathBuf {
    widget::files::dir(&app.paths.config_dir).join(".proposed")
}

/// An agent proposes a widget: the folder is written where proposals wait,
/// and the reader gets a card on Your turn -- Add, or Not now. Nothing runs
/// and nothing is in the widgets folder until Add.
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
    if !widget::name_ok(&b.name) {
        return refused(
            StatusCode::BAD_REQUEST,
            "a widget's name is lowercase letters, digits and dashes, at most 32",
        );
    }
    if widget::files::dir(&app.paths.config_dir)
        .join(&b.name)
        .exists()
    {
        return refused(
            StatusCode::CONFLICT,
            format!("a widget called {} is already there", b.name),
        );
    }
    let command = b.command.trim();
    if command.is_empty() || command.contains('\n') {
        return refused(StatusCode::BAD_REQUEST, "the command is one line");
    }
    let script_ok = b.script_name.is_empty()
        || (!b.script_name.contains(['/', '\\'])
            && !b.script_name.starts_with('.')
            && b.script_name != "widget.json");
    if !script_ok || b.script.len() > SCRIPT_MAX {
        return refused(
            StatusCode::BAD_REQUEST,
            "the script is one file of at most 16 KB, named without a folder",
        );
    }
    // Where it goes: this desk alone, unless the agent asks for every desk
    // and the card says so; or the left, everywhere.
    let place = match b.scope.trim() {
        "global" => "global",
        "every desk" | "every" | "all" | "all desks" => "every",
        _ => "here",
    };
    let spec = json!({
        "name": b.name,
        "title": b.title.trim(),
        "scope": if place == "global" { "global" } else { "desk" },
        "run": { "command": command, "every": if b.every == 0 { widget::files::EVERY_DEFAULT } else { b.every }, "timeout": if b.timeout == 0 { widget::files::TIMEOUT_DEFAULT } else { b.timeout } },
        "lines": if b.lines == 0 { widget::LINES_DEFAULT } else { b.lines },
    });
    let stage = proposed_dir(&app).join(format!("{}-{}", crate::store::now(), b.name));
    let wrote = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&stage)?;
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
        Ok(())
    })();
    if let Err(e) = wrote {
        return refused(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not write it: {e}"),
        );
    }
    // Checked before the reader sees it: a command that cannot reach its own
    // script goes back to the agent with how to write it (#111).
    let read = widget::files::read(&stage, &b.name)
        .and_then(|s| widget::files::lint(&s, &stage).map(|_| s));
    let spec = match read {
        Ok(s) => s,
        Err(why) => {
            let _ = std::fs::remove_dir_all(&stage);
            return refused(StatusCode::BAD_REQUEST, why);
        }
    };
    let detail = json!({
        "where": place,
        "every": spec.run.every,
        "lines": spec.lines,
        "script_name": b.script_name,
        "script": b.script,
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

/// How long the reader said a widget lasts, from the card: until when, and
/// the panel whose life it lasts.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct Lasts {
    pub(crate) until: i64,
    pub(crate) until_pane: String,
}

/// The reader added a proposed widget: its folder moves in with the rest,
/// allowed as it is, on the desk the card was on unless the card said every
/// desk, for as long as the reader chose. Refused if a widget took the name
/// meanwhile.
pub(crate) fn install_proposed(
    app: &App,
    card: &crate::thread::Suggestion,
    lasts: &Lasts,
) -> Result<(), String> {
    let (name, staged) = (card.name.as_str(), card.folder.as_str());
    let stage = std::path::PathBuf::from(staged);
    if !stage.starts_with(proposed_dir(app)) || !stage.is_dir() {
        return Err("the proposal is not there any more".into());
    }
    let to = widget::files::dir(&app.paths.config_dir).join(name);
    if to.exists() {
        return Err(format!("a widget called {name} is already there"));
    }
    let spec = widget::files::read(&stage, name)?;
    widget::files::lint(&spec, &stage)?;
    std::fs::rename(&stage, &to).map_err(|e| format!("could not move it in: {e}"))?;
    let hash = widget::files::hash(&to)?;
    let every = card.detail.get("where").and_then(|w| w.as_str()) != Some("here");
    let desks: Vec<i64> = if every {
        Vec::new()
    } else {
        vec![card.desk_id]
    };
    let ch = widget::Change {
        hidden: Some(false),
        trusted_hash: Some(&hash),
        desks: Some(&desks),
        until: Some(lasts.until.max(0)),
        until_pane: Some(&lasts.until_pane),
        ..Default::default()
    };
    app.store
        .clocked(|c, now| widget::set_prefs(c, name, &ch, now))
        .map(|_| ())
        .map_err(|e| e.to_string())
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
        .clocked(|c, now| {
            widget::ask_answer(
                c,
                desk,
                name,
                "yes",
                lasts.until.max(0),
                &lasts.until_pane,
                now,
            )?;
            widget::ask_of(c, desk, name)
        })
        .map_err(|e| e.to_string())?
        .ok_or("the box is not there any more")?;
    if ask.body.trim().is_empty() {
        return Ok(());
    }
    let w = widget::Writer {
        source: widget::Source::Push,
        writer: &ask.writer,
        pane: &ask.pane,
        title: "",
    };
    let r = push(app, desk, name, &ask.body, &w);
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("snyvi answered {}", r.status()))
    }
}

/// What Try once printed, drawn, or why it printed nothing usable.
pub(crate) async fn try_proposed(app: &App, card: &crate::thread::Suggestion) -> serde_json::Value {
    let stage = std::path::PathBuf::from(&card.folder);
    if !stage.starts_with(proposed_dir(app)) || !stage.is_dir() {
        return json!({ "error": "the proposal is not there any more" });
    }
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
    match super::widget_run::run_once(&spec, &stage, &cwd, &path, &stdin).await {
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
