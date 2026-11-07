//! A desk's page over HTTP (`crate::page`, docs/WALL.md).
//!
//! The page's routes are the window's, on the capability, through
//! `refuse_desk`: read the page (or its draft), save it, write a moment,
//! answer a card, write `.snyvi/owner`. The press that publishes is one of
//! them too (`crate::wall`), so nothing leaves on an agent's word.
//!
//! The agent's one route is `POST /api/panes/{id}/post` = `offer_post`, on
//! the token through `agent_pane`: it makes a card in the corner and
//! nothing else, the way `offer_document` makes one for a friend.
//!
//! `/pages/{file}` serves a page's copied-in files by their content names
//! and nothing else in the data folder; an SVG is sandboxed, so a logo that
//! carries a script runs none of it.
//!
//! Door (a), snyvi's own card on a ship, is `offer_shipped`: called after a
//! thread move, a seen merge and a landed one (`api_thread`).

use super::*;
use crate::page::{self, files, Edit, MomentIn, Offered};

fn refused(e: anyhow::Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": format!("{e:#}") })),
    )
        .into_response()
}

fn pages_dir(app: &App) -> std::path::PathBuf {
    app.paths.data_dir.join(files::DIR)
}

/// The desk's threads' stages, for the draft's stage.
fn stages(app: &App, desk_id: i64) -> Vec<String> {
    app.store
        .clocked(|c, _| crate::thread::for_desk(c, desk_id))
        .map(|ts| ts.into_iter().map(|t| t.stage).collect())
        .unwrap_or_default()
}

/// The draft, and its logo copied in (empty when it has none, or it is
/// over the cap: the page starts without a logo rather than not at all).
fn draft_with_logo(app: &App, desk: &crate::desk::Desk) -> (page::Draft, String) {
    let d = page::draft::draft(
        std::path::Path::new(&desk.root),
        &desk.name,
        &stages(app, desk.id),
    );
    let logo = d
        .logo
        .as_ref()
        .and_then(|p| files::copy_in(&pages_dir(app), p, files::Role::Logo, 0).ok())
        .unwrap_or_default();
    (d, logo)
}

/// The page as the view reads it: the page, its moments, its cards, and
/// what it holds against its cap. With no page yet, the draft it would
/// start from, so the view shows a page before anything is kept.
fn page_json(app: &App, desk: &crate::desk::Desk) -> anyhow::Result<serde_json::Value> {
    let (p, offers) = app
        .store
        .clocked(|c, _| Ok((page::get(c, desk.id)?, page::open_offers(c, desk.id)?)))?;
    let Some(p) = p else {
        let d = page::draft::draft(
            std::path::Path::new(&desk.root),
            &desk.name,
            &stages(app, desk.id),
        );
        let logo = d
            .logo
            .as_ref()
            .and_then(|l| l.strip_prefix(&desk.root).ok())
            .map(|l| l.to_string_lossy().into_owned());
        return Ok(json!({
            "page": null,
            "draft": d,
            "logo_path": logo,
            "slug": page::slug_of(&desk.name, desk.id),
            "offers": offers,
        }));
    };
    let (moments, names) = app
        .store
        .clocked(|c, _| Ok((page::moments(c, p.id, false)?, page::file_names(c, &p)?)))?;
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    Ok(json!({
        "page": p,
        "moments": moments,
        "offers": offers,
        "held": files::held(&pages_dir(app), &refs),
        "cap": files::PAGE_MAX,
    }))
}

/// `GET /api/desks/{id}/page`: the Page view's read.
pub(crate) async fn desk_page(
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
    // The cards alone, for a desk opening: no draft read, no git run.
    if q.contains_key("offers") {
        return match app.store.clocked(|c, _| page::open_offers(c, id)) {
            Ok(o) => Json(json!({ "offers": o })).into_response(),
            Err(e) => refused(e),
        };
    }
    let a = app.clone();
    match tokio::task::spawn_blocking(move || page_json(&a, &desk)).await {
        Ok(Ok(j)) => Json(j).into_response(),
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A file the reader picked in the desk's folder, for the logo or cover.
#[derive(Deserialize)]
pub(crate) struct Pick {
    pub(crate) field: String,
    /// Under the desk's folder.
    pub(crate) path: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PageBody {
    /// Make the page from its draft, if it has none.
    pub(crate) start: bool,
    pub(crate) edit: Option<Edit>,
    /// A chip pressed: this field back to the draft.
    pub(crate) redraft: Option<String>,
    pub(crate) pick: Option<Pick>,
}

/// A path the reader named under the desk's folder, made absolute and held
/// inside it: `..` and a link out are refused.
fn in_desk(root: &str, path: &str) -> anyhow::Result<std::path::PathBuf> {
    let root = dunce::canonicalize(root)?;
    let p = dunce::canonicalize(root.join(path.trim_start_matches('/')))
        .map_err(|_| anyhow::anyhow!("{path} is not in this desk's folder"))?;
    if !p.starts_with(&root) || !p.is_file() {
        anyhow::bail!("{path} is not a file in this desk's folder");
    }
    Ok(p)
}

fn save_page(app: &App, desk: &crate::desk::Desk, b: PageBody) -> anyhow::Result<()> {
    let has = app.store.clocked(|c, _| page::get(c, desk.id))?.is_some();
    if !has || b.redraft.is_some() {
        let (d, logo) = draft_with_logo(app, desk);
        if !has {
            if !b.start && b.edit.is_none() && b.pick.is_none() {
                anyhow::bail!("this desk has no page yet");
            }
            app.store
                .clocked(|c, now| page::start(c, desk.id, &desk.name, &d, &logo, now))?;
        }
        if let Some(f) = &b.redraft {
            app.store
                .clocked(|c, now| page::redraft(c, desk.id, f, &d, &logo, now))?;
        }
    }
    if let Some(pk) = &b.pick {
        let role = match pk.field.as_str() {
            "logo" => files::Role::Logo,
            "cover" => files::Role::Picture,
            _ => anyhow::bail!("a picked file is the logo or the cover"),
        };
        let from = in_desk(&desk.root, &pk.path)?;
        let held = held_by(app, desk.id)?;
        let name = files::copy_in(&pages_dir(app), &from, role, held)?;
        app.store
            .clocked(|c, now| page::set_file(c, desk.id, &pk.field, &name, now))?;
        if pk.field == "logo" && from.extension().is_some_and(|e| e == "png" || e == "svg") {
            // A new mark, a new accent: the builder's pick is still theirs to change.
            let bytes = std::fs::read(&from)?;
            let ext = crate::render::ext_of(&from.to_string_lossy());
            let a = page::accent::accent_of(&bytes, &ext);
            let e = Edit {
                accent: Some(a.name.into()),
                ..Default::default()
            };
            app.store.clocked(|c, now| {
                page::save(c, desk.id, &e, now)?;
                c.execute(
                    "UPDATE pages SET wash = ?1 WHERE desk_id = ?2",
                    rusqlite::params![a.wash, desk.id],
                )?;
                Ok(())
            })?;
        }
    }
    if let Some(e) = &b.edit {
        app.store.clocked(|c, now| page::save(c, desk.id, e, now))?;
    }
    Ok(())
}

/// What the page's files hold now, against `files::PAGE_MAX`.
fn held_by(app: &App, desk_id: i64) -> anyhow::Result<u64> {
    let names = app.store.clocked(|c, _| match page::get(c, desk_id)? {
        Some(p) => page::file_names(c, &p),
        None => Ok(Vec::new()),
    })?;
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    Ok(files::held(&pages_dir(app), &refs))
}

/// `POST /api/desks/{id}/page`: start, edit, redraft a field, or pick a
/// picture. The page as it is after, told to a second window as `page`.
pub(crate) async fn save_desk_page(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<PageBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let a = app.clone();
    let done = tokio::task::spawn_blocking(move || {
        save_page(&a, &desk, b)?;
        page_json(&a, &desk)
    })
    .await;
    match done {
        Ok(Ok(j)) => {
            emit(&app, "page", json!({ "desk": id, "what": "page" }));
            Json(j).into_response()
        }
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct MomentBody {
    /// An existing moment to hide or show again.
    pub(crate) id: Option<i64>,
    pub(crate) hidden: Option<bool>,
    pub(crate) moment: Option<MomentIn>,
    /// Files to copy in for it: paths under the desk's folder, or a
    /// gallery file's name.
    pub(crate) pick: Vec<String>,
}

fn put_moment(app: &App, desk: &crate::desk::Desk, b: MomentBody) -> anyhow::Result<i64> {
    let Some(p) = app.store.clocked(|c, _| page::get(c, desk.id))? else {
        anyhow::bail!("this desk has no page yet");
    };
    if let (Some(id), Some(hidden)) = (b.id, b.hidden) {
        let ok = app.store.clocked(|c, now| {
            let ours = page::moment(c, id)?.is_some_and(|m| m.page_id == p.id);
            Ok(ours && page::hide_moment(c, id, hidden, now)?)
        })?;
        if !ok {
            anyhow::bail!("no such moment on this page");
        }
        return Ok(id);
    }
    let Some(mut m) = b.moment else {
        anyhow::bail!("a moment, or one to hide");
    };
    let mut held = held_by(app, desk.id)?;
    for pick in &b.pick {
        let from = if crate::widget::gallery::file_name_ok(pick) {
            app.paths
                .data_dir
                .join(crate::widget::gallery::DIR)
                .join(pick)
        } else {
            in_desk(&desk.root, pick)?
        };
        let ext = crate::render::ext_of(&from.to_string_lossy());
        let ext = if ext == "jpeg" { "jpg".into() } else { ext };
        let Some(role) = files::Role::of_ext(&ext) else {
            anyhow::bail!("{pick}: a moment shows a picture or a clip");
        };
        let name = files::copy_in(&pages_dir(app), &from, role, held)?;
        held += std::fs::metadata(pages_dir(app).join(&name))
            .map(|m| m.len())
            .unwrap_or(0);
        if !m.files.contains(&name) {
            m.files.push(name);
        }
    }
    app.store
        .clocked(|c, now| page::put_moment(c, p.id, &m, now))
}

/// `POST /api/desks/{id}/page/moments`: write a moment, or hide one.
pub(crate) async fn desk_page_moment(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<MomentBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(desk)) = app.store.desk(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let a = app.clone();
    match tokio::task::spawn_blocking(move || put_moment(&a, &desk, b)).await {
        Ok(Ok(m)) => {
            emit(&app, "page", json!({ "desk": id, "what": "page" }));
            Json(json!({ "moment": m })).into_response()
        }
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `POST /api/desks/{id}/page/offers/{o}/{answer}`: Have a look or Not now.
pub(crate) async fn desk_page_offer(
    State(app): S,
    headers: HeaderMap,
    Path((id, offer, answer)): Path<(i64, i64, String)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let answered = app
        .store
        .clocked(|c, now| match page::offer_by_id(c, offer)? {
            Some(o) if o.desk_id == id => page::answer_offer(c, offer, &answer, now),
            _ => Ok(false),
        });
    match answered {
        Ok(true) => {
            emit(
                &app,
                "page",
                json!({ "desk": id, "what": "offers", "offer": offer, "state": answer }),
            );
            Json(json!({ "offer": offer, "state": answer })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => refused(e),
    }
}

/// The line `.snyvi/owner` holds: the daemon's address, which the wall
/// finds at the repository's HEAD before a page is on Everyone's wall.
pub(crate) fn owner_line(address: &str) -> String {
    format!("snyvi-owner-v1 {address}\n")
}

/// `POST /api/desks/{id}/page/owner`: Add the check to the repo. Writes the
/// file in the desk's folder and nothing else: the commit and the push are
/// the builder's, and the row says them.
pub(crate) async fn desk_page_owner(
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
    let a = app.clone();
    let wrote = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let me = super::api_peer::identity_blocking(&a)?;
        let dir = std::path::Path::new(&desk.root).join(".snyvi");
        std::fs::create_dir_all(&dir)?;
        let line = owner_line(&me.address());
        std::fs::write(dir.join("owner"), &line)?;
        Ok(me.address())
    })
    .await;
    match wrote {
        Ok(Ok(address)) => Json(json!({
            "path": ".snyvi/owner",
            "address": address,
            "push": "git add .snyvi/owner && git commit -m \"snyvi: the page's check\" && git push",
        }))
        .into_response(),
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `GET /pages/{file}`: a page's copied-in file, by its content name.
pub(crate) async fn page_file(State(app): S, Path(file): Path<String>, req: HeaderMap) -> Response {
    if !files::file_name_ok(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let ext = crate::render::ext_of(&file);
    let mut headers = HeaderMap::new();
    if let Ok(v) =
        HeaderValue::from_str(mime_guess::from_ext(&ext).first_or_octet_stream().as_ref())
    {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Opened on its own, an SVG is a document: sandboxed, it runs nothing.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"),
    );
    serve_file(&pages_dir(&app).join(&file), headers, &req).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct PostBody {
    pub(crate) title: String,
    pub(crate) text: String,
    pub(crate) about: String,
    pub(crate) by: String,
}

/// `POST /api/panes/{id}/post`: `offer_post`. A card in the desk's corner,
/// and nothing more; the reader's Have a look opens the page with it.
pub(crate) async fn pane_post(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<PostBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let desk = placed.desk_id;
    let got = app.store.clocked(|c, now| {
        let Some(p) = page::get(c, desk)? else {
            return Ok(None);
        };
        let o = page::offer(c, desk, &b.about, &b.title, &b.text, &b.by, &id, now)?;
        Ok(Some((p, o)))
    });
    let (p, o) =
        match got {
            Ok(Some(x)) => x,
            Ok(None) => return Json(json!({
                "said": "no page yet: the user starts one from Page in the desk's head; say so once"
            }))
            .into_response(),
            Err(e) => return refused(e),
        };
    let said = match o {
        Offered::New(offer) | Offered::Updated(offer) => {
            emit(
                &app,
                "page",
                json!({ "desk": desk, "what": "offers", "offer": offer, "title": b.title, "by": b.by }),
            );
            if matches!(o, Offered::New(_)) {
                format!(
                    "offered · page `{}` ({}) · the user decides on the card",
                    p.slug,
                    if p.visibility == "off" {
                        "not up yet"
                    } else {
                        p.visibility.as_str()
                    }
                )
            } else {
                "already offered; updated its words".to_string()
            }
        }
        Offered::Answered => {
            "the user answered this one already; it is not offered again".to_string()
        }
    };
    (StatusCode::CREATED, Json(json!({ "said": said }))).into_response()
}

/// Door (a): a thread on this desk shipped in the last day, and no card was
/// ever made about it. snyvi's own card, by `snyvi`, with the thread's name
/// as what it is about, so the agent's `offer_post` about the same thread
/// updates this one rather than making a second.
pub(crate) fn offer_shipped(app: &App, desk_id: i64) {
    let made = app.store.clocked(|c, now| {
        let mut made = Vec::new();
        for t in crate::thread::for_desk(c, desk_id)? {
            if t.stage != "shipped" || t.shipped_at < now - 86_400 || t.name.trim().is_empty() {
                continue;
            }
            if page::offered(c, desk_id, &t.name)? {
                continue;
            }
            if let Offered::New(id) =
                page::offer(c, desk_id, &t.name, &t.name, "", "snyvi", "", now)?
            {
                made.push((id, t.name));
            }
        }
        Ok(made)
    });
    for (offer, title) in made.unwrap_or_default() {
        emit(
            app,
            "page",
            json!({ "desk": desk_id, "what": "offers", "offer": offer, "title": title, "by": "snyvi" }),
        );
    }
}
