//! The press and what comes back (1.59, `crate::wall`, docs/WALL.md).
//!
//! `POST /api/desks/{id}/page/publish` is the reader's press, on the
//! capability: Everyone queues the outbox and flushes it now; Friends only
//! seals the page to each paired friend through the peers' own outbox. Off
//! publishes nothing. `…/page/down` takes it down. Nothing here runs on a
//! token: an agent offers (`offer_post`), the reader presses.
//!
//! `take` is the wall's daily line arriving, from the wall's own key and
//! nothing else; `friend_page` is a friend's page arriving. Both are kept
//! to show and told as a `page` event; neither is ever input to a pane.

use super::*;
use crate::page::{self, files};
use crate::peer::{Content, Identity, Waiting};
use crate::wall::{self, Row};

fn refused(e: anyhow::Error) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": format!("{e:#}") })),
    )
        .into_response()
}

/// How one flush went, for the row under Publish.
#[derive(Debug, PartialEq)]
pub(crate) enum Flushed {
    /// Nothing waits: all of it is up.
    Up,
    /// The wall could not be reached: the rest waits for the next tick.
    Offline,
    /// The wall refused, for good, with why ("that name is taken").
    Refused(String),
}

/// What a row is, as a request: method, path, body, content type.
fn request(
    app: &App,
    me: &Identity,
    slug: &str,
    r: &Row,
) -> anyhow::Result<(&'static str, String, Vec<u8>, String)> {
    let json = "application/json".to_string();
    Ok(match r.what.split_once(':') {
        Some(("file", name)) => {
            if !files::file_name_ok(name) {
                anyhow::bail!("not a page's file: {name}");
            }
            let bytes = std::fs::read(app.paths.data_dir.join(files::DIR).join(name))?;
            let ext = crate::render::ext_of(name);
            let ct = mime_guess::from_ext(&ext)
                .first_or_octet_stream()
                .to_string();
            ("PUT", format!("/pages/{slug}/files/{name}"), bytes, ct)
        }
        Some(("moment", id)) => (
            "PUT",
            format!("/pages/{slug}/moments/{id}"),
            r.body.clone().into_bytes(),
            json,
        ),
        _ => match r.what.as_str() {
            // The page, with this daemon's box key in the signed body: what
            // the wall seals its daily line to.
            "page" => {
                let mut v: serde_json::Value = serde_json::from_str(&r.body)?;
                v["box"] = json!(crate::peer::b64(&me.box_public()));
                (
                    "PUT",
                    format!("/pages/{slug}"),
                    v.to_string().into_bytes(),
                    json,
                )
            }
            "check" => (
                "POST",
                format!("/pages/{slug}/check"),
                r.body.clone().into_bytes(),
                json,
            ),
            "down" => ("DELETE", format!("/pages/{slug}"), Vec::new(), json),
            other => anyhow::bail!("an outbox row of a kind this snyvi does not send: {other}"),
        },
    })
}

/// Send one signed request to the wall: its status and body.
pub(crate) fn signed(
    me: &Identity,
    method: &str,
    path: &str,
    body: &[u8],
    ct: &str,
) -> anyhow::Result<(u16, Vec<u8>)> {
    use std::io::Read;
    let url = format!("{}{path}", wall::base());
    let auth = me.wall_auth(method, path, body);
    let from = me.address();
    let http = crate::peer::http();
    let resp = match method {
        "PUT" => http
            .put(&url)
            .header("x-snyvi-from", &from)
            .header("x-snyvi-auth", &auth)
            .header("content-type", ct)
            .send(body),
        "POST" => http
            .post(&url)
            .header("x-snyvi-from", &from)
            .header("x-snyvi-auth", &auth)
            .header("content-type", ct)
            .send(body),
        _ => http
            .delete(&url)
            .header("x-snyvi-from", &from)
            .header("x-snyvi-auth", &auth)
            .call(),
    };
    let mut resp = resp.map_err(|e| anyhow::anyhow!("reaching the wall: {e}"))?;
    let status = resp.status().as_u16();
    let mut out = Vec::new();
    resp.body_mut()
        .as_reader()
        .take(64 * 1024)
        .read_to_end(&mut out)?;
    Ok((status, out))
}

/// The wall's refusal in words, from its `{"error": …}`.
fn why(status: u16, body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("the wall answered {status}"))
}

/// Send what waits for one page, in order. Blocking.
pub(crate) fn flush_page(app: &App, me: &Identity, p: &page::Page) -> anyhow::Result<Flushed> {
    let rows = app.store.clocked(|c, _| wall::held(c, Some(p.id)))?;
    for r in rows {
        let (method, path, body, ct) = match request(app, me, &p.slug, &r) {
            Ok(x) => x,
            Err(e) => {
                app.store
                    .clocked(|c, _| wall::refused(c, p.id, &format!("{e:#}")))?;
                return Ok(Flushed::Refused(format!("{e:#}")));
            }
        };
        let (status, out) = match signed(me, method, &path, &body, &ct) {
            Ok(x) => x,
            Err(e) => {
                app.store
                    .clocked(|c, _| wall::failed(c, r.id, &format!("{e:#}")))?;
                return Ok(Flushed::Offline);
            }
        };
        match status {
            200..=299 => {
                app.store.clocked(|c, now| {
                    wall::sent(c, r.id, now)?;
                    after_sent(c, p, &r, &out, now)
                })?;
            }
            409 => {
                let w = "that name is taken".to_string();
                app.store.clocked(|c, _| wall::refused(c, p.id, &w))?;
                return Ok(Flushed::Refused(w));
            }
            400 | 401 | 403 | 413 | 422 => {
                let w = why(status, &out);
                app.store.clocked(|c, _| wall::refused(c, p.id, &w))?;
                return Ok(Flushed::Refused(w));
            }
            _ => {
                let w = why(status, &out);
                app.store.clocked(|c, _| wall::failed(c, r.id, &w))?;
                return Ok(Flushed::Offline);
            }
        }
    }
    Ok(Flushed::Up)
}

/// A row the wall took: the page is up, a moment is up, the check answered.
fn after_sent(
    c: &rusqlite::Connection,
    p: &page::Page,
    r: &Row,
    out: &[u8],
    now: i64,
) -> anyhow::Result<()> {
    match r.what.split_once(':') {
        Some(("moment", id)) => {
            if let Ok(id) = id.parse() {
                page::moment_up(c, id, now)?;
            }
        }
        _ if r.what == "page" => page::mark_up(c, p.id, now)?,
        _ if r.what == "check" => {
            let ok = serde_json::from_slice::<serde_json::Value>(out)
                .ok()
                .and_then(|v| v.get("checked").and_then(|b| b.as_bool()))
                .unwrap_or(false);
            page::mark_checked(c, p.id, if ok { now } else { 0 })?;
        }
        _ => {}
    }
    Ok(())
}

/// Every page with something held, tried again: the minute tick's, while
/// anything waits. Blocking; quiet when the wall is still not there.
pub(crate) fn flush_held(app: &App) {
    let Ok(rows) = app.store.clocked(|c, _| wall::held(c, None)) else {
        return;
    };
    let mut pages: Vec<i64> = rows.iter().map(|r| r.page_id).collect();
    pages.dedup();
    if pages.is_empty() {
        return;
    }
    let Ok(me) = super::api_peer::identity_blocking(app) else {
        return;
    };
    for id in pages {
        let Ok(Some(p)) = app.store.clocked(|c, _| page::by_id(c, id)) else {
            continue;
        };
        if matches!(flush_page(app, &me, &p), Ok(Flushed::Up)) {
            emit(app, "page", json!({ "desk": p.desk_id, "what": "page" }));
        }
    }
}

/// Friends only: the page and its newest moment, sealed to every paired
/// friend through the peers' outbox. The relay carries it; the wall never
/// sees it. How many it went to.
fn to_friends(app: &Arc<App>, p: &page::Page, moments: &[page::Moment]) -> anyhow::Result<usize> {
    let now = crate::store::now();
    let moment = moments
        .iter()
        .find(|m| m.hidden_at == 0)
        .map(|m| wall::public_moment(m, now))
        .unwrap_or(serde_json::Value::Null);
    let body = json!({ "page": wall::public_page(p), "moment": moment }).to_string();
    let friends: Vec<crate::peer::Peer> = app
        .store
        .peers()?
        .into_iter()
        .filter(|f| f.removed_at == 0)
        .collect();
    if friends.is_empty() {
        anyhow::bail!("there are no friends paired yet; pair one from Home");
    }
    app.store.clocked(|c, now| {
        for f in &friends {
            crate::peer::queue_kind(c, f, "page", &p.slug, "", &body, now)?;
        }
        page::mark_up(c, p.id, now)?;
        for m in moments
            .iter()
            .filter(|m| m.hidden_at == 0 && m.published_at == 0)
        {
            page::moment_up(c, m.id, now)?;
        }
        Ok(())
    })?;
    super::api_peer::flush_all(app);
    Ok(friends.len())
}

/// The press, blocking: what the row under Publish says.
fn press(app: &Arc<App>, desk_id: i64) -> anyhow::Result<String> {
    let (p, moments) = app.store.clocked(|c, _| {
        let Some(p) = page::get(c, desk_id)? else {
            anyhow::bail!("this desk has no page yet");
        };
        let m = page::moments(c, p.id, false)?;
        Ok((p, m))
    })?;
    match p.visibility.as_str() {
        "friends" => {
            let n = to_friends(app, &p, &moments)?;
            Ok(format!(
                "sent · to {n} friend{} · sealed, through the relay",
                if n == 1 { "" } else { "s" }
            ))
        }
        "everyone" => {
            if !page::valid_slug(&p.slug) {
                anyhow::bail!("a page's name is 2 to 40 lowercase letters, digits and hyphens");
            }
            app.store
                .clocked(|c, now| wall::queue_publish(c, &p, &moments, now))?;
            let me = super::api_peer::identity_blocking(app)?;
            Ok(match flush_page(app, &me, &p)? {
                Flushed::Up => {
                    let checked = app
                        .store
                        .clocked(|c, _| page::get(c, desk_id))?
                        .is_some_and(|p| p.checked_at > 0);
                    if checked {
                        format!("up · just now · snyvi.page/{}", p.slug)
                    } else {
                        format!(
                            "up at snyvi.page/{} · not on the wall yet: add the check to the repo",
                            p.slug
                        )
                    }
                }
                Flushed::Offline => {
                    "not up yet: no connection; it goes when the wall answers".into()
                }
                Flushed::Refused(w) => format!("not up: {w}"),
            })
        }
        _ => anyhow::bail!("choose who sees it first"),
    }
}

/// `POST /api/desks/{id}/page/publish`: the reader's press.
pub(crate) async fn desk_page_publish(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let a = app.clone();
    match tokio::task::spawn_blocking(move || press(&a, id)).await {
        Ok(Ok(said)) => {
            emit(&app, "page", json!({ "desk": id, "what": "page" }));
            Json(json!({ "said": said })).into_response()
        }
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Take it down, blocking: off the wall within the minute, off for
/// everyone here. A friend keeps the copy they were sent; the row says so.
fn take_down(app: &Arc<App>, desk_id: i64) -> anyhow::Result<String> {
    let Some(p) = app.store.clocked(|c, _| page::get(c, desk_id))? else {
        anyhow::bail!("this desk has no page yet");
    };
    let was = p.visibility.clone();
    app.store.clocked(|c, now| {
        if was == "everyone" && p.published_at > 0 {
            wall::refused(c, p.id, "taken down")?;
            wall::queue(c, p.id, "down", "", now)?;
        }
        page::mark_down(c, p.id, now)
    })?;
    if was == "everyone" && p.published_at > 0 {
        let me = super::api_peer::identity_blocking(app)?;
        return Ok(match flush_page(app, &me, &p)? {
            Flushed::Up => "down · off the wall".into(),
            Flushed::Offline => "down here · off the wall when it answers".into(),
            Flushed::Refused(w) => format!("down here · the wall said: {w}"),
        });
    }
    Ok(if was == "friends" {
        "down · friends keep the copy they were sent".into()
    } else {
        "down".into()
    })
}

/// `POST /api/desks/{id}/page/down`: the Undo of a publish.
pub(crate) async fn desk_page_down(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let a = app.clone();
    match tokio::task::spawn_blocking(move || take_down(&a, id)).await {
        Ok(Ok(said)) => {
            emit(&app, "page", json!({ "desk": id, "what": "page" }));
            Json(json!({ "said": said })).into_response()
        }
        Ok(Err(e)) => refused(e),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The wall's daily line, from its own key (`peer::take_in` sends it here
/// before any friend lookup). Only `Content::Wall` about one of this
/// daemon's own pages is kept; anything else from that key is dropped.
pub(crate) fn take(
    app: &Arc<App>,
    me: &Identity,
    w: &Waiting,
    bytes: &[u8],
) -> anyhow::Result<bool> {
    if app.store.peer_taken(&w.id)? || bytes.len() > crate::peer::FRAME_MAX {
        return Ok(false);
    }
    let opened = crate::peer::open(me, &wall::wall_peer(), bytes);
    app.store.peer_take(&w.id)?;
    let Ok((
        Content::Wall {
            slug,
            hearts,
            names,
            since,
            reported,
            follows,
            followers,
            reads,
            ..
        },
        _,
    )) = opened
    else {
        return Ok(false);
    };
    let line = page::Line {
        hearts,
        names,
        since,
        reported,
        follows,
        followers,
        reads,
    };
    let desk = app
        .store
        .clocked(|c, now| page::hearts_said(c, &slug, &line, now))?;
    match desk {
        Some(d) => {
            emit(
                app,
                "page",
                json!({ "desk": d, "what": "hearts", "hearts": hearts }),
            );
            Ok(true)
        }
        None => Ok(false),
    }
}

/// A friend's page, sent Friends only: kept in `pages_from`, shown in Home's
/// Friends segment with their name. A resend is a new version.
pub(crate) fn friend_page(
    app: &Arc<App>,
    p: &crate::peer::Peer,
    slug: &str,
    page_json: serde_json::Value,
    moment: serde_json::Value,
) -> anyhow::Result<()> {
    if !page::valid_slug(slug) || !page_json.is_object() {
        anyhow::bail!("a page that is not one");
    }
    app.store.clocked(|c, now| {
        page::friend_page(
            c,
            p.id,
            slug,
            &page_json.to_string(),
            &moment.to_string(),
            now,
        )
    })?;
    emit(
        app,
        "page",
        json!({ "desk": 0, "what": "friends", "from": p.name }),
    );
    Ok(())
}

// ---- Home's section: the wall, read through this daemon (step 6) ----------
//
// The window never fetches the internet: Home asks `/api/wall`, and this
// daemon reads wall.json from the wall, an hour in memory and on disk, so
// a Home with no connection still shows the last wall it saw. Its files the
// same, through `/api/wall/file/{name}`, kept up to 50 MB, oldest out. A
// heart is signed here, by this daemon's key, minted on the first one.

const WALL_FRESH: std::time::Duration = std::time::Duration::from_secs(3600);
const WALL_FILES_MAX: u64 = 50 << 20;

fn wall_dir(app: &App) -> std::path::PathBuf {
    app.paths.data_dir.join("wall")
}

/// wall.json, from memory while fresh, else the wall, else the last on disk.
fn wall_json(app: &App, again: bool) -> serde_json::Value {
    use std::sync::Mutex;
    static KEPT: Mutex<Option<(std::time::Instant, serde_json::Value)>> = Mutex::new(None);
    if !again {
        if let Some((at, v)) = KEPT.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            if at.elapsed() < WALL_FRESH {
                return v.clone();
            }
        }
    }
    let disk = wall_dir(app).join("wall.json");
    let got = crate::peer::http()
        .get(&format!("{}/wall.json", wall::base()))
        .call()
        .ok()
        .filter(|r| r.status().is_success())
        .and_then(|mut r| {
            r.body_mut()
                .with_config()
                .limit(4 << 20)
                .read_json::<serde_json::Value>()
                .ok()
        });
    let v = match got {
        Some(v) => {
            let _ = std::fs::create_dir_all(wall_dir(app));
            let _ = std::fs::write(&disk, v.to_string());
            v
        }
        None => std::fs::read(&disk)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({ "pages": [], "offline": true })),
    };
    *KEPT.lock().unwrap_or_else(|e| e.into_inner()) = Some((std::time::Instant::now(), v.clone()));
    v
}

/// This daemon's own pages that are up, with the wall's last line: Home's
/// own-page row ("Breeds of dogs is on the wall · 41 ♥ since Thursday").
fn mine(app: &App) -> Vec<serde_json::Value> {
    let Ok(desks) = app.store.desks() else {
        return Vec::new();
    };
    desks
        .iter()
        .filter_map(|d| {
            app.store
                .clocked(|c, _| {
                    let Some(p) = page::get(c, d.id)? else {
                        return Ok(None);
                    };
                    let h = page::hearts_of(c, p.id)?;
                    let f = page::heard_of(c, p.id)?;
                    Ok(p.is_up().then(|| {
                        json!({ "desk": d.id, "slug": p.slug, "title": p.title, "visibility": p.visibility,
                                "checked": p.checked_at > 0, "hearts": h.0, "names": h.1, "since": h.2,
                                "follows": f.0, "reads": f.2 })
                    }))
                })
                .ok()
                .flatten()
        })
        .collect()
}

/// `GET /api/wall`: the wall, this daemon's own pages, and friends' pages.
pub(crate) async fn wall_read(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let again = q.contains_key("again");
    let a = app.clone();
    let got = tokio::task::spawn_blocking(move || {
        let friends = a
            .store
            .clocked(|c, _| page::friend_pages(c, 40))
            .unwrap_or_default();
        // The pages this reader follows, signed at the wall (1.62, D2).
        let follows: Vec<serde_json::Value> = a
            .store
            .clocked(|c, _| page::follows(c))
            .unwrap_or_default()
            .into_iter()
            .map(|(slug, at, seen)| json!({ "slug": slug, "at": at, "seen": seen }))
            .collect();
        json!({ "wall": wall_json(&a, again), "mine": mine(&a), "friends": friends, "follows": follows })
    })
    .await;
    match got {
        Ok(j) => Json(j).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// A wall file, kept on disk: fetched once, then served from there. The
/// oldest go when what is kept passes `WALL_FILES_MAX`.
fn wall_file_kept(app: &App, name: &str) -> Option<std::path::PathBuf> {
    let dir = wall_dir(app).join("files");
    let at = dir.join(name);
    if at.is_file() {
        return Some(at);
    }
    let mut r = crate::peer::http()
        .get(&format!("{}/files/{name}", wall::base()))
        .call()
        .ok()
        .filter(|r| r.status().is_success())?;
    let bytes = r
        .body_mut()
        .with_config()
        .limit(21 << 20)
        .read_to_vec()
        .ok()?;
    // What the wall named by its content is that content, or it is not kept.
    if !name.starts_with(&blake3::hash(&bytes).to_hex()[..16]) {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(&at, &bytes).ok()?;
    let mut kept: Vec<(std::time::SystemTime, u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    kept.sort();
    let mut total: u64 = kept.iter().map(|k| k.1).sum();
    for (_, len, p) in kept {
        if total <= WALL_FILES_MAX || p == at {
            break;
        }
        let _ = std::fs::remove_file(&p);
        total -= len;
    }
    Some(at)
}

/// `GET /api/wall/file/{name}`: a picture on the wall, as an `<img>` asks.
pub(crate) async fn wall_file(State(app): S, Path(name): Path<String>, req: HeaderMap) -> Response {
    if !files::file_name_ok(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let a = app.clone();
    let n = name.clone();
    let Ok(Some(at)) = tokio::task::spawn_blocking(move || wall_file_kept(&a, &n)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ext = crate::render::ext_of(&name);
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
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'; style-src 'unsafe-inline'"),
    );
    serve_file(&at, headers, &req).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct HeartBody {
    pub(crate) slug: String,
    pub(crate) moment: Option<i64>,
}

/// `POST /api/wall/heart`: the reader's heart, signed by this daemon's key.
pub(crate) async fn wall_heart(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<HeartBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !page::valid_slug(&b.slug) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let a = app.clone();
    let sent = tokio::task::spawn_blocking(move || -> anyhow::Result<(u16, Vec<u8>)> {
        let me = super::api_peer::identity_blocking(&a)?;
        let path = match b.moment {
            Some(m) => format!("/pages/{}/moments/{m}/hearts", b.slug),
            None => format!("/pages/{}/hearts", b.slug),
        };
        signed(&me, "POST", &path, b"", "application/json")
    })
    .await;
    match sent {
        Ok(Ok((200, out))) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            out,
        )
            .into_response(),
        Ok(Ok((status, out))) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": why(status, &out) })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("{e:#}") })),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
pub(crate) struct FollowBody {
    pub(crate) slug: String,
    #[serde(default = "yes")]
    pub(crate) on: bool,
}
fn yes() -> bool {
    true
}

/// `POST /api/wall/follow`: the reader follows a page (or stops), signed by
/// this daemon's key at the wall, so its builder hears it (1.62, D2), and
/// kept here once the wall has taken it.
pub(crate) async fn wall_follow(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<FollowBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if !page::valid_slug(&b.slug) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let a = app.clone();
    let sent = tokio::task::spawn_blocking(move || -> anyhow::Result<(u16, Vec<u8>)> {
        let me = super::api_peer::identity_blocking(&a)?;
        let body = json!({ "on": b.on }).to_string();
        let got = signed(
            &me,
            "POST",
            &format!("/pages/{}/follow", b.slug),
            body.as_bytes(),
            "application/json",
        )?;
        if got.0 == 200 {
            a.store
                .clocked(|c, now| page::set_follow(c, &b.slug, b.on, now))?;
        }
        Ok(got)
    })
    .await;
    match sent {
        Ok(Ok((200, out))) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            out,
        )
            .into_response(),
        Ok(Ok((status, out))) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": why(status, &out) })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("{e:#}") })),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `POST /api/wall/seen`: Home showed the followed pages' moments; the line
/// that said there were new ones goes.
pub(crate) async fn wall_seen(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.clocked(|c, now| page::follows_seen(c, now)) {
        Ok(()) => Json(json!({ "seen": true })).into_response(),
        Err(e) => refused(e),
    }
}
