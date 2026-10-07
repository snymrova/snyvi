//! A friend's snyvi, over HTTP: pairing, the friends list, a document or a
//! line sent to one, an agent's offer, and what is done with a frame a
//! friend sent -- brought in through `receive::receive` like everything
//! else. The cryptography and the relay's protocol are in `crate::peer`;
//! the socket that waits at the relay is `peer_link`; this file is the
//! daemon's side of both.
//!
//! Every reader's action here is behind `refuse_reader` -- this page, or the
//! token -- and never a desk's capability: a tab can send a document to a
//! friend as well as the window can. The one agent route, `/offer`, is behind
//! the token and a running pane like the rest of a panel's, and it sends
//! nothing: it writes an offer the reader answers.

use super::*;
use crate::peer::{self, Content, Identity, PairState, Peer, Waiting};
use std::collections::HashMap;

/// What the daemon holds in memory for its friends: its own keys once read,
/// the pairings under way, and the link's wake-up.
#[derive(Default)]
pub(crate) struct Peers {
    /// The identity, read from the keychain once per process.
    pub identity: std::sync::Mutex<Option<Identity>>,
    /// Pairings under way or lately finished, by code.
    pub pairings: std::sync::Mutex<HashMap<String, Pairing>>,
    /// Woken when there is something to send, or a friend was added or
    /// removed: the link (`peer_link`) flushes the outbox, opens, or closes.
    pub wake: tokio::sync::Notify,
}

#[derive(Clone, Debug)]
pub(crate) struct Pairing {
    pub state: PairState,
    /// When the code dies; the entry is forgotten a while after.
    pub until: i64,
}

/// How many pairings may wait at once. One is the case; a few is a reader
/// who typed the wrong code twice.
const PAIRINGS_MAX: usize = 5;
/// A finished pairing stays readable this long after its code died.
const PAIRING_KEPT: i64 = 600;
/// A frame that fails this many times is left in the outbox, not retried.
const TRIES_MAX: i64 = 20;
/// What the reader is told at the Send button, and what a queued frame's
/// row says, when a document is over `peer::SEND_MAX`.
const TOO_LARGE: &str = "too large to send to a friend (over 8 MB)";

/// The identity, minting one if there is none. Blocking: the keychain.
pub(crate) fn identity_blocking(app: &App) -> anyhow::Result<Identity> {
    if let Some(id) = app.peers.identity.lock().unwrap().clone() {
        return Ok(id);
    }
    let id = Identity::load_or_mint(&app.secrets)?;
    *app.peers.identity.lock().unwrap() = Some(id.clone());
    Ok(id)
}

/// The identity if one was ever minted; never mints. What the link asks,
/// so a daemon nobody has paired touches no keychain.
pub(crate) fn identity_if_any(app: &App) -> Option<Identity> {
    if let Some(id) = app.peers.identity.lock().unwrap().clone() {
        return Some(id);
    }
    let id = Identity::load(&app.secrets)?;
    *app.peers.identity.lock().unwrap() = Some(id.clone());
    Some(id)
}

/// The name a friend sees this snyvi as. What the reader typed when pairing,
/// kept in one file; the account's name until then.
pub(crate) fn my_name(paths: &Paths) -> String {
    std::fs::read_to_string(paths.config_dir.join("peer-name"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "a friend".to_string())
        })
}

fn set_my_name(paths: &Paths, name: &str) {
    let name: String = name.trim().chars().take(60).collect();
    if name.is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(&paths.config_dir);
    let _ = std::fs::write(paths.config_dir.join("peer-name"), name);
}

fn peers_moved(app: &App) {
    emit(app, "peers", json!({}));
}

/// `GET /api/peers`: the friends, the lines waiting, the offers open, and
/// what this snyvi is called. Open, as the project list is: names and
/// dates, no keys that open anything.
pub(crate) async fn peers_list(State(app): S) -> Response {
    let friends = app.store.peers().unwrap_or_default();
    let notes = app.store.peer_notes().unwrap_or_default();
    let offers = app.store.peer_offers().unwrap_or_default();
    // What has not gone, each with whether it stopped trying: the friends
    // list says it in the friend's row, with Retry.
    let outbox: Vec<_> = app
        .store
        .peer_outgoing()
        .unwrap_or_default()
        .into_iter()
        .map(|o| {
            let stopped = o.tries >= TRIES_MAX;
            let mut v = json!(o);
            v["stopped"] = json!(stopped);
            v
        })
        .collect();
    Json(json!({
        "friends": friends,
        "notes": notes,
        "offers": offers,
        "outbox": outbox,
        "me": { "name": my_name(&app.paths) },
        "relay": peer::relay(),
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct PairBody {
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) code: String,
}

fn too_many(app: &App) -> bool {
    let now = crate::store::now();
    let mut p = app.peers.pairings.lock().unwrap();
    p.retain(|_, x| x.until + PAIRING_KEPT > now);
    p.values().filter(|x| x.state == PairState::Waiting).count() >= PAIRINGS_MAX
}

/// `POST /api/peers/pair`: mint a code and wait in its room for whoever
/// types it. The answer is the code to say and when it dies.
pub(crate) async fn pair_start(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<PairBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if too_many(&app) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "a few codes are already waiting; let one run out" })),
        )
            .into_response();
    }
    let code = match peer::mint_code() {
        Ok(c) => c,
        Err(e) => return err(e),
    };
    set_my_name(&app.paths, &b.name);
    let until = start_pairing(&app, code.clone(), my_name(&app.paths));
    Json(json!({ "code": code, "until": until })).into_response()
}

/// `POST /api/peers/join`: the other side's code, typed.
pub(crate) async fn pair_join(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<PairBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let code = match peer::normalize_code(&b.code) {
        Ok(c) => c,
        Err(why) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "error": why })),
            )
                .into_response()
        }
    };
    if too_many(&app) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "a few codes are already waiting; let one run out" })),
        )
            .into_response();
    }
    if app.peers.pairings.lock().unwrap().contains_key(&code) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "that is this snyvi's own code" })),
        )
            .into_response();
    }
    set_my_name(&app.paths, &b.name);
    let until = start_pairing(&app, code.clone(), my_name(&app.paths));
    Json(json!({ "code": code, "until": until })).into_response()
}

/// `GET /api/peers/pair/{code}`: where it has got to.
pub(crate) async fn pair_state(State(app): S, Path(code): Path<String>) -> Response {
    let p = app.peers.pairings.lock().unwrap().get(&code).cloned();
    match p {
        Some(p) => Json(json!({ "pairing": p.state, "until": p.until })).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// One side of a pairing, on a thread of its own, from the code to the
/// pinned row. Returns when the code dies.
fn start_pairing(app: &Arc<App>, code: String, name: String) -> i64 {
    let until = crate::store::now() + peer::CODE_TTL;
    app.peers.pairings.lock().unwrap().insert(
        code.clone(),
        Pairing {
            state: PairState::Waiting,
            until,
        },
    );
    let app = app.clone();
    tokio::spawn(async move {
        let app2 = app.clone();
        let c = code.clone();
        let r = tokio::task::spawn_blocking(move || -> anyhow::Result<(Peer, String)> {
            let me = identity_blocking(&app2)?;
            peer::pair(&me, &c, &name, until)
        })
        .await;
        let state = match r {
            Ok(Ok((p, emoji))) => match app.store.pin_peer(&p) {
                Ok(pinned) => {
                    eprintln!("snyvi: paired with {}", pinned.name);
                    peers_moved(&app);
                    app.peers.wake.notify_one();
                    PairState::Done {
                        emoji,
                        name: pinned.name,
                        peer: pinned.id,
                    }
                }
                Err(e) => PairState::Failed { why: e.to_string() },
            },
            Ok(Err(e)) => PairState::Failed {
                why: format!("{e:#}"),
            },
            Err(e) => PairState::Failed { why: e.to_string() },
        };
        if let Some(p) = app.peers.pairings.lock().unwrap().get_mut(&code) {
            p.state = state.clone();
        }
        emit(&app, "pairing", json!({ "code": code, "pairing": state }));
    });
    until
}

#[derive(Deserialize, Default)]
pub(crate) struct NameBody {
    #[serde(default)]
    pub(crate) name: String,
}

pub(crate) async fn peer_rename(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<NameBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.rename_peer(id, &b.name) {
        Ok(true) => {
            // The friend's project row follows their name, unless the reader
            // named that themselves.
            if let Ok(Some(p)) = app.store.peer(id) {
                let _ = app
                    .store
                    .rename_project_by_root(&p.project_root(), &p.project_name());
            }
            peers_moved(&app);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct MuteBody {
    #[serde(default)]
    pub(crate) muted: bool,
}

pub(crate) async fn peer_mute(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<MuteBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.mute_peer(id, b.muted) {
        Ok(true) => {
            peers_moved(&app);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// ✕ on a friend: off the list, keys kept, nothing more arrives from them
/// until Restore. A document already here stays, as every document does.
pub(crate) async fn peer_remove(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.remove_peer(id) {
        Ok(true) => {
            peers_moved(&app);
            // The link closes when that was the last friend.
            app.peers.wake.notify_one();
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn peer_restore(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.restore_peer(id) {
        Ok(true) => {
            peers_moved(&app);
            app.peers.wake.notify_one();
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct TextBody {
    #[serde(default)]
    pub(crate) text: String,
}

/// `POST /api/peers/{id}/note`: a line for a friend's notes. Queued, as a
/// document is, and tried now: a relay that is away gets it when it is back,
/// and the sheet says so rather than failing.
pub(crate) async fn peer_note(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<TextBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let text: String = b.text.trim().chars().take(peer::NOTE_CHARS).collect();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "a line of text" })),
        )
            .into_response();
    }
    let Ok(Some(p)) = app.store.peer(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if p.removed_at != 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this friend was removed; Restore them first" })),
        )
            .into_response();
    }
    let frame = match app.store.peer_queue_note(&p, &text) {
        Ok(f) => f,
        Err(e) => return err(e),
    };
    let app2 = app.clone();
    let sent = tokio::task::spawn_blocking(move || flush_outbox(&app2, Some(&frame)))
        .await
        .unwrap_or(false);
    peers_moved(&app);
    Json(json!({ "sent": sent, "to": p.name })).into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct SettleBody {
    #[serde(default)]
    pub(crate) what: String,
    /// For `keep`: the desk the line goes on.
    #[serde(default)]
    pub(crate) desk: i64,
}

/// `POST /api/peers/notes/{id}`: a waiting line was kept on a desk, put
/// away, or brought back (`what`: taken, remove, restore) -- or is kept on
/// a desk here and now (`keep`, with `desk`): Home's Keep on…, one click.
/// The line becomes the desk's, with the friend's name on it (`sent_by`),
/// and the answer carries it so the row's Undo can take it off again.
/// That one writes a desk's list, so it is behind the desk's capability.
pub(crate) async fn peer_note_settle(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<SettleBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if b.what == "keep" {
        if let Some(no) = refuse_desk(&app, &headers, &q) {
            return no;
        }
        return keep_line(&app, id, b.desk);
    }
    match app.store.settle_peer_note(id, &b.what) {
        Ok(true) => {
            emit(&app, "peernotes", json!({}));
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A friend's waiting line, put on a desk: the desk's line, then the
/// waiting one settled. A full desk says so and the line stays waiting.
fn keep_line(app: &Arc<App>, id: i64, desk: i64) -> Response {
    let Ok(Some(n)) = app
        .store
        .peer_notes()
        .map(|ns| ns.into_iter().find(|n| n.id == id))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(Some(d)) = app.store.desk(desk) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such desk" })),
        )
            .into_response();
    };
    match app.store.add_desk_note_from(desk, &n.text, &n.from) {
        Ok(Some(note)) => {
            let _ = app.store.settle_peer_note(id, "taken");
            emit(app, "desknotes", json!({ "desk": desk }));
            emit(app, "peernotes", json!({}));
            Json(json!({ "note": note, "desk": desk, "name": d.name })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": format!("{} keeps {} notes; take one off first", d.name, crate::desk::NOTES_PER_DESK) })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct SendBody {
    #[serde(default)]
    pub(crate) peer: i64,
}

/// `POST /api/docs/{id}/send`: this document to that friend. Queued, so a
/// relay that is away tonight gets it tomorrow, and tried now.
pub(crate) async fn doc_send(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<SendBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(Some(p)) = app.store.peer(b.peer) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such friend" })),
        )
            .into_response();
    };
    if p.removed_at != 0 {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "this friend was removed; Restore them first" })),
        )
            .into_response();
    }
    if doc.size as usize > peer::SEND_MAX {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": TOO_LARGE })),
        )
            .into_response();
    }
    let frame = match app.store.peer_queue(&p, &id) {
        Ok(f) => f,
        Err(e) => return err(e),
    };
    let app2 = app.clone();
    let sent = tokio::task::spawn_blocking(move || flush_outbox(&app2, Some(&frame)))
        .await
        .unwrap_or(false);
    peers_moved(&app);
    Json(json!({ "sent": sent, "to": p.name })).into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct AnswerBody {
    #[serde(default)]
    pub(crate) send: bool,
    /// Not now, taken back: the offer is open again, as long as its panel's
    /// program still runs. The Undo on Home's row.
    #[serde(default)]
    pub(crate) undo: bool,
}

/// `POST /api/peers/offers/{id}`: the reader's Send or Not now on an agent's
/// offer. Send queues the document as a Send to… would.
pub(crate) async fn offer_answer(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<AnswerBody>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if b.undo {
        return match app.store.reopen_peer_offer(id) {
            Ok(true) => {
                emit(&app, "peeroffers", json!({}));
                StatusCode::NO_CONTENT.into_response()
            }
            Ok(false) => StatusCode::NOT_FOUND.into_response(),
            Err(e) => err(e),
        };
    }
    let Ok(Some(o)) = app.store.peer_offer_get(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Too large is said before the offer is answered, so it stays open and
    // the reader can press Not now with the reason in front of them.
    if b.send {
        if let Ok(Some(doc)) = app.store.get(&o.doc_id) {
            if doc.size as usize > peer::SEND_MAX {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(json!({ "error": TOO_LARGE })),
                )
                    .into_response();
            }
        }
    }
    if let Err(e) = app.store.answer_peer_offer(id, b.send) {
        return err(e);
    }
    emit(&app, "peeroffers", json!({}));
    if !b.send {
        return Json(json!({ "sent": false })).into_response();
    }
    let Ok(Some(p)) = app.store.peer(o.peer_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let frame = match app.store.peer_queue(&p, &o.doc_id) {
        Ok(f) => f,
        Err(e) => return err(e),
    };
    let app2 = app.clone();
    let sent = tokio::task::spawn_blocking(move || flush_outbox(&app2, Some(&frame)))
        .await
        .unwrap_or(false);
    peers_moved(&app);
    Json(json!({ "sent": sent, "to": p.name })).into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct OfferBody {
    #[serde(default)]
    pub(crate) to: String,
    #[serde(default)]
    pub(crate) doc: String,
    #[serde(default)]
    pub(crate) by: String,
}

/// `POST /api/panes/{id}/offer`: `offer_document`. An agent in a panel asks
/// that a document go to a friend; the reader is shown the question where
/// they are and presses Send, or not. Nothing leaves on the agent's word.
pub(crate) async fn pane_offer(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<OfferBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let to = b.to.trim();
    if to.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "offer_document needs the friend's name" })),
        )
            .into_response();
    }
    let Ok(Some(p)) = app.store.peer_by_name(to) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("the user has no friend called {to}; they pair from Home") }))).into_response();
    };
    let Ok(Some(doc)) = app.store.get(b.doc.trim()) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no document by that id; send_document answers with one" })),
        )
            .into_response();
    };
    match app.store.peer_offer(p.id, &doc.id, &id, &b.by) {
        Ok(offer_id) => {
            emit(
                &app,
                "peeroffers",
                json!({ "offer": offer_id, "to": p.name, "title": doc.title, "by": b.by, "desk": placed.desk_name }),
            );
            (
                StatusCode::CREATED,
                Json(json!({ "to": p.name, "title": doc.title })),
            )
                .into_response()
        }
        Err(e) => err(e),
    }
}

/// Send what is queued: every unsent frame, or the one named. Blocking.
/// `true` when the named one went, or when every one did.
pub(crate) fn flush_outbox(app: &App, only: Option<&str>) -> bool {
    let Ok(rows) = app.store.peer_unsent() else {
        return false;
    };
    let Ok(me) = identity_blocking(app) else {
        return false;
    };
    let name = my_name(&app.paths);
    let mut all = true;
    let mut moved = false;
    for row in rows {
        let (frame_id, peer_id) = (row.id.as_str(), row.peer_id);
        if only.is_some_and(|o| o != frame_id) {
            continue;
        }
        if row.tries >= TRIES_MAX {
            all = false;
            continue;
        }
        let went = match send_one(app, &me, &name, &row) {
            Ok(peer::Deposit::Sent) => {
                let _ = app.store.peer_sent(frame_id);
                let _ = app.store.touch_peer(peer_id, false);
                moved = true;
                true
            }
            // Waiting, not failing: the next retry tries again, and the
            // tries are kept for what is really wrong.
            Ok(peer::Deposit::Later(why)) => {
                let _ = app.store.peer_waiting(frame_id, why);
                false
            }
            Err(e) => {
                let _ = app.store.peer_failed(frame_id, &format!("{e:#}"));
                false
            }
        };
        all &= went;
    }
    if moved && only.is_none() {
        peers_moved(app);
    }
    all
}

fn send_one(
    app: &App,
    me: &Identity,
    name: &str,
    row: &peer::Unsent,
) -> anyhow::Result<peer::Deposit> {
    let (frame_id, doc_id) = (row.id.as_str(), row.doc_id.as_str());
    let p = app
        .store
        .peer(row.peer_id)?
        .ok_or_else(|| anyhow::anyhow!("no such friend"))?;
    // A line: no document behind it, the words are the whole of it.
    if doc_id.is_empty() {
        let content = Content::Note {
            text: row.text.clone(),
            name: name.to_string(),
            at: peer::Folder {
                v: peer::CONTENT_V,
                ..Default::default()
            },
        };
        let frame = peer::seal(me, &p, &content, b"")?;
        return peer::deposit(me, &p.sign_key, frame_id, &frame);
    }
    let Some(doc) = app.store.get(doc_id)? else {
        // The document went while the frame waited: nothing to send, done.
        app.store.peer_sent(frame_id)?;
        return Ok(peer::Deposit::Sent);
    };
    let mut bytes = std::fs::read(app.store.src_path(doc_id))?;
    // Checked at the Send button too; this is the document that grew while
    // the frame waited for the relay.
    if bytes.len() > peer::SEND_MAX {
        anyhow::bail!("{TOO_LARGE}");
    }
    // A page's own pictures go inside it, so they arrive with it.
    let room = peer::SEND_MAX.saturating_sub(bytes.len());
    let with = match (
        doc.kind,
        doc.source_path.as_deref(),
        std::str::from_utf8(&bytes),
    ) {
        (crate::render::Kind::Markdown, Some(file), Ok(text)) => {
            Some(inline_pictures(text, std::path::Path::new(file), room))
        }
        _ => None,
    };
    if let Some(with) = with {
        bytes = with.into_bytes();
    }
    let content = Content::Document {
        title: doc.title.clone(),
        lang: doc.lang.clone(),
        file: doc
            .source_path
            .as_deref()
            .and_then(|sp| std::path::Path::new(sp).file_name())
            .map(|f| f.to_string_lossy().to_string()),
        name: name.to_string(),
        id: doc.id.clone(),
        at: folder_of(app, &doc),
    };
    let frame = peer::seal(me, &p, &content, &bytes)?;
    peer::deposit(me, &p.sign_key, frame_id, &frame)
}

/// How long a folder's fingerprint is taken as read: a day. Root commits do
/// not change; a remote, rarely.
pub(crate) const PRINT_KEPT: i64 = 86_400;

/// The folder a document is about, as its frame says it (`peer::Folder`):
/// the repository its project is, the file's place in it -- or, for a file
/// outside it, a key standing for the path -- and the branch. Blocking: a
/// fingerprint not read yet is read here, through `git::print`. A document
/// in no repository, or a friend's still in their own row, says nothing but
/// the version.
pub(crate) fn folder_of(app: &App, doc: &crate::store::Doc) -> peer::Folder {
    let mut at = peer::Folder {
        v: peer::CONTENT_V,
        ..Default::default()
    };
    let Some(root) = app
        .store
        .project_root(doc.project_id)
        .filter(|r| !r.starts_with("peer:"))
    else {
        return at;
    };
    let print = match app.store.print_of(&root) {
        Ok(Some((p, when))) if crate::store::now() - when < PRINT_KEPT => Some(p),
        _ => {
            let p = crate::git::print(std::path::Path::new(&root));
            let _ = app.store.set_print(&root, p.as_ref());
            p
        }
    };
    let Some(print) = print.filter(|p| p.repo.is_some() || p.remote.is_some()) else {
        return at;
    };
    at.repo = print.repo;
    at.remote = print.remote;
    at.branch = doc
        .branch
        .clone()
        .or_else(|| crate::project::head_of(std::path::Path::new(&root)));
    (at.path, at.key) = place_in(&root, doc.source_path.as_deref());
    at
}

/// A file's place in the folder `root`, as a frame carries it: the path
/// inside, with `/`, or -- for a file elsewhere, a plan in a scratch folder
/// -- a key that stands for its path, so its next version lands on the same
/// row without the path leaving this machine. A path already relative is a
/// friend's document filed here, and its place is that path.
pub(crate) fn place_in(root: &str, source: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(sp) = source.filter(|s| !s.trim().is_empty()) else {
        return (None, None);
    };
    let file = std::path::Path::new(sp);
    if !file.is_absolute() {
        return (peer::safe_path(sp), None);
    }
    match file.strip_prefix(root) {
        Ok(rel) => (
            peer::safe_path(&rel.to_string_lossy().replace('\\', "/")),
            None,
        ),
        Err(_) => {
            let h = blake3::hash(format!("snyvi key v1 {sp}").as_bytes());
            (None, Some(h.to_hex()[..16].to_string()))
        }
    }
}

/// A Markdown document's own pictures, put into it as `data:` URLs so they
/// travel with it: png, jpeg, gif and webp, named relative to the file and
/// inside its project (as `/files/` serves them), while the whole stays
/// under what a frame carries -- `room` bytes more. The rest is left as
/// written, and the friend's snyvi says those stayed here. A file that is
/// not on this machine any more, or a friend's document passed on, has no
/// folder to look in, and goes as it is.
pub(crate) fn inline_pictures(text: &str, file: &std::path::Path, room: usize) -> String {
    let Some(dir) = file.parent().filter(|d| d.is_absolute()) else {
        return text.to_string();
    };
    let Ok(root) = crate::project::resolve(dir).root.canonicalize() else {
        return text.to_string();
    };
    let mut left = room;
    crate::render::map_md_images(text, |alt, url| {
        if !crate::render::relative_url(url) {
            return None;
        }
        let mime = crate::render::picture_mime(&crate::render::ext_of(url))?;
        let at = dir.join(url).canonicalize().ok()?;
        if !at.starts_with(&root) || std::fs::metadata(&at).ok()?.len() as usize > left {
            return None;
        }
        let bytes = std::fs::read(&at).ok()?;
        let md = format!("![{alt}]({})", crate::render::data_uri(mime, &bytes));
        left = left.checked_sub(md.len())?;
        Some(md)
    })
}

/// One frame from the relay, with its bytes: kept, or dropped, and `true`
/// when it was kept. Blocking. The decisions in order: not from a friend's
/// key, or a friend since removed -- dropped unopened; brought in already
/// (`peer_taken`: the link may be handed a frame twice when its ack was
/// lost) -- dropped; over the cap -- dropped; does not open, or cannot be
/// kept -- dropped with a line on stderr; else `arrived`, and its id
/// remembered. The caller acks every one of these; an `Err` is the store
/// not answering, and the frame is left at the relay for the next catch-up.
pub(crate) fn take_in(
    app: &Arc<App>,
    me: &Identity,
    w: &Waiting,
    bytes: Vec<u8>,
) -> anyhow::Result<bool> {
    let friend = app
        .store
        .peer_by_key(&w.sender)?
        .filter(|p| p.removed_at == 0);
    let Some(p) = friend else {
        return Ok(false);
    };
    if app.store.peer_taken(&w.id)? {
        return Ok(false);
    }
    if w.size as usize > peer::FRAME_MAX || bytes.len() > peer::FRAME_MAX {
        return Ok(false);
    }
    match peer::open(me, &p, &bytes) {
        // A kind from a newer snyvi: held, sealed as it came, for when this
        // one is new enough to read it (`read_held`).
        Ok((Content::Other, _)) => {
            app.store.peer_hold(&w.id, p.id, &bytes)?;
            app.store.peer_take(&w.id)?;
            eprintln!("snyvi: {} sent something this snyvi is too old to read; it is kept for after an update", p.name);
            Ok(false)
        }
        Ok((content, body)) => {
            if let Err(e) = arrived(app, &p, content, body) {
                eprintln!("snyvi: a document from {} could not be kept: {e:#}", p.name);
                return Ok(false);
            }
            app.store.peer_take(&w.id)?;
            Ok(true)
        }
        Err(e) => {
            eprintln!("snyvi: a frame from {} was dropped: {e:#}", p.name);
            Ok(false)
        }
    }
}

/// The frames held for a newer snyvi (`take_in`), opened again: what this
/// one now reads arrives as if it had just come, what it still cannot read
/// waits, and a frame that no longer opens -- its friend removed, or the
/// keys paired again -- goes. Blocking; the link calls it on every open.
pub(crate) fn read_held(app: &Arc<App>, me: &Identity) {
    let _ = app.store.prune_peer_held();
    let Ok(held) = app.store.peer_held() else {
        return;
    };
    for (id, peer_id, bytes) in held {
        let friend = app
            .store
            .peer(peer_id)
            .ok()
            .flatten()
            .filter(|p| p.removed_at == 0);
        let Some(p) = friend else {
            let _ = app.store.peer_unhold(&id);
            continue;
        };
        match peer::open(me, &p, &bytes) {
            Ok((Content::Other, _)) => {}
            Ok((content, body)) => {
                if let Err(e) = arrived(app, &p, content, body) {
                    eprintln!(
                        "snyvi: something held from {} could not be kept: {e:#}",
                        p.name
                    );
                }
                let _ = app.store.peer_unhold(&id);
            }
            Err(_) => {
                let _ = app.store.peer_unhold(&id);
            }
        }
    }
}

/// The inbox swept over HTTP: what the link does when the socket will not
/// open. Blocking. Each frame goes through `take_in` and is acked, opened
/// or not, so the relay holds nothing twice; one from a key that is not a
/// friend's is never downloaded.
pub(crate) fn bring_in(app: &Arc<App>, me: &Identity) -> anyhow::Result<usize> {
    let waiting = peer::inbox(me)?;
    let mut n = 0;
    for w in waiting {
        let friend = app
            .store
            .peer_by_key(&w.sender)?
            .filter(|p| p.removed_at == 0);
        let fetch =
            friend.is_some() && !app.store.peer_taken(&w.id)? && w.size as usize <= peer::FRAME_MAX;
        if fetch {
            let bytes = peer::fetch(me, &w.id)?;
            if take_in(app, me, &w, bytes)? {
                n += 1;
            }
        }
        peer::ack(me, &w.id)?;
    }
    Ok(n)
}

/// The desk a friend's things land on now: theirs, while it is open and not
/// parked. A closed or parked one sends them back to their own row and to
/// Home, so nothing lands where the reader is not looking.
pub(crate) fn friend_desk(app: &App, p: &Peer) -> Option<crate::desk::Desk> {
    if p.desk_id == 0 {
        return None;
    }
    app.store
        .desk(p.desk_id)
        .ok()
        .flatten()
        .filter(|d| d.parked.is_none())
}

/// One opened frame, kept: a document through `receive`, a line to the
/// waiting list -- or, for a friend the reader gave a desk, the document
/// into that desk's project and the line onto its list as a suggestion
/// (Home's Arrived when the desk already has as many as it holds). A muted
/// friend's arrives read, so nothing lights up.
fn arrived(app: &Arc<App>, p: &Peer, content: Content, body: Vec<u8>) -> anyhow::Result<()> {
    let _ = app.store.touch_peer(p.id, true);
    let desk = friend_desk(app, p);
    match content {
        Content::Document {
            title,
            lang,
            file,
            at,
            ..
        } => {
            // The reader's own folder for the repository it is about, when
            // there is one; else their desk, else their row, as before 1.22.
            let filed = file_into(app, &at);
            let desk = match &filed {
                Some((_, d)) => d.clone(),
                None => desk,
            };
            let payload = Payload {
                title: Some(title),
                lang,
                origin: Some("peer".into()),
                sender: Some(p.name.clone()),
                peer: Some(crate::receive::FromPeer {
                    name: p.name.clone(),
                    sign_key: p.sign_key.clone(),
                    bytes: body,
                    lineage: lineage(&at, file.as_deref()),
                    file,
                    desk: desk.as_ref().map(|d| (on_desk(d), d.root.clone())),
                    root: filed.as_ref().map(|(r, _)| r.clone()),
                }),
                ..Default::default()
            };
            let received = receive::receive(&app.store, &app.renderer, payload)?;
            let _ = app.store.set_peer_key(&received.doc.id, &p.sign_key);
            if p.muted {
                let _ = app.store.mark_read(&received.doc.id);
            }
            let mut ev = doc_event(app, &received);
            ev["from"] = json!(p.name);
            ev["quiet"] = json!(p.muted);
            emit(app, "doc", ev);
            if desk.is_some() {
                emit(app, "deskdocs", json!({}));
            }
            if !p.muted && !received.existing {
                eprintln!("snyvi: {} sent \"{}\"", p.name, received.doc.title);
            }
        }
        // Held before it got here (`take_in`); nothing to keep.
        Content::Other => {}
        Content::Note { text, .. } => {
            if let Some(d) = &desk {
                if let Ok(crate::desk::Suggested::Note(_)) =
                    app.store.suggest_desk_note_from(d.id, &text, &p.name)
                {
                    emit(app, "desknotes", json!({ "desk": d.id }));
                    emit(
                        app,
                        "peernotes",
                        json!({ "from": p.name, "quiet": p.muted, "desk": d.name }),
                    );
                    return Ok(());
                }
            }
            app.store.peer_note_arrived(p.id, &text)?;
            emit(
                app,
                "peernotes",
                json!({ "from": p.name, "quiet": p.muted }),
            );
        }
    }
    Ok(())
}

/// Where a friend's document about a repository goes: the reader's own
/// folder for it, among the projects snyvi already knows -- never a folder
/// looked for -- with the desk that folder is open on, if one is. Several
/// folders of one repository (a clone and its worktrees) are ranked: one
/// with an unparked desk first, then one on the branch the frame names, then
/// the one a document last arrived in. `None` when the frame names no
/// repository or the reader has none of it, or not yet: a folder whose
/// fingerprint the sweep has not read is not a match.
fn file_into(app: &App, at: &peer::Folder) -> Option<(String, Option<crate::desk::Desk>)> {
    if !at.named() {
        return None;
    }
    let roots = app.store.roots_by_print(at).ok()?;
    if roots.is_empty() {
        return None;
    }
    let desks: Vec<_> = app
        .store
        .desks()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d.parked.is_none())
        .collect();
    roots
        .into_iter()
        .filter(|(root, _)| std::path::Path::new(root).is_dir())
        .map(|(root, newest)| {
            let desk = desks
                .iter()
                .filter(|d| receive::desk_project(&d.root).0 == root)
                .max_by_key(|d| d.visited_at)
                .cloned();
            let branch = at.branch.is_some()
                && crate::project::head_of(std::path::Path::new(&root)) == at.branch;
            ((desk.is_some(), branch, newest), root, desk)
        })
        .max_by_key(|x| x.0)
        .map(|(_, root, desk)| (root, desk))
}

/// The row a friend's document is a version of, by its place in the
/// repository both have; a file from outside it by its key, with the name
/// after it so it still reads as the file; else the name alone, as every
/// frame before 1.22 has it.
fn lineage(at: &peer::Folder, file: Option<&str>) -> Option<String> {
    let name = file
        .and_then(|f| std::path::Path::new(f).file_name())
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.trim().is_empty());
    if at.named() {
        if let Some(path) = at.path.as_deref().and_then(peer::safe_path) {
            return Some(path);
        }
    }
    let key = at
        .key
        .as_deref()
        .filter(|k| k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric()));
    match (key, name) {
        (Some(k), Some(n)) => Some(format!("{k}/{n}")),
        (Some(k), None) => Some(k.to_string()),
        (None, n) => n,
    }
}

/// A desk as a document's origin: the desk, no panel.
fn on_desk(d: &crate::desk::Desk) -> crate::desk::Origin {
    crate::desk::Origin {
        id: d.id,
        name: d.name.clone(),
        slot: 0,
    }
}

#[derive(Deserialize, Default)]
pub(crate) struct DeskBody {
    #[serde(default)]
    pub(crate) desk: i64,
}

/// `POST /api/peers/{id}/desk`: where this friend's things land from now
/// on -- a desk, or 0 for their own row. Nothing already here moves. The
/// window's: it names a desk.
pub(crate) async fn peer_desk(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<DeskBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if b.desk != 0 && !matches!(app.store.desk(b.desk), Ok(Some(_))) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such desk" })),
        )
            .into_response();
    }
    match app.store.set_peer_desk(id, b.desk) {
        Ok(true) => {
            peers_moved(&app);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A friend's document, and the desk it is to go on or is on: the checks
/// `doc_keep` and `doc_save` share. The error is the response.
fn theirs(app: &App, id: &str) -> Result<crate::store::Doc, Box<Response>> {
    match app.store.get(id) {
        Ok(Some(doc)) if doc.origin == "peer" => Ok(doc),
        Ok(Some(_)) => Err(Box::new(
            (
                StatusCode::CONFLICT,
                Json(json!({ "error": "only a friend's document is kept this way" })),
            )
                .into_response(),
        )),
        Ok(None) => Err(Box::new(StatusCode::NOT_FOUND.into_response())),
        Err(e) => Err(Box::new(err(e))),
    }
}

/// `POST /api/docs/{id}/keep`: a friend's document onto a desk -- it and
/// every version of it into the desk's project and onto its list, still
/// from them. Nothing is written to disk; Save into the folder does that.
pub(crate) async fn doc_keep(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<DeskBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    if let Err(no) = theirs(&app, &id) {
        return *no;
    }
    let Ok(Some(d)) = app.store.desk(b.desk) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "no such desk" })),
        )
            .into_response();
    };
    let (root, name, _) = receive::desk_project(&d.root);
    match app.store.move_lineage(&id, &root, &name, &on_desk(&d)) {
        Ok(Some(doc)) => {
            // The tree and the desks' lists read again (what `pinned` does),
            // and a page with it open draws its head again (`rendered`).
            emit(&app, "pinned", json!({ "id": id }));
            emit(&app, "rendered", json!({ "id": id }));
            Json(json!({ "doc": doc, "desk": d.name })).into_response()
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/docs/{id}/save`: a friend's document, kept on a desk, written
/// into that desk's folder as `from-<friend>/<name>`, so the desk's agents
/// and git can see it. The one step that writes a friend's bytes to disk,
/// and it never writes over a file: a second save is `name-2`.
pub(crate) async fn doc_save(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let doc = match theirs(&app, &id) {
        Ok(d) => d,
        Err(no) => return *no,
    };
    let Some(d) = doc
        .desk
        .as_ref()
        .and_then(|o| app.store.desk(o.id).ok().flatten())
    else {
        return (
            StatusCode::CONFLICT,
            Json(
                json!({ "error": "keep it on a desk first; it is saved into that desk's folder" }),
            ),
        )
            .into_response();
    };
    let src = app.store.src_path(&id);
    let dir = std::path::Path::new(&d.root).join(format!("from-{}", slug(&doc.sender)));
    let name = file_name(&doc);
    match tokio::task::spawn_blocking(move || save_new(&src, &dir, &name)).await {
        Ok(Ok(at)) => {
            let rel = at
                .strip_prefix(&d.root)
                // The same on every system: it is said to the reader, and a
                // path inside a folder reads with /.
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| at.to_string_lossy().to_string());
            Json(json!({ "path": at, "rel": rel, "desk": d.name })).into_response()
        }
        Ok(Err(e)) => err(e),
        Err(e) => err(anyhow::anyhow!(e)),
    }
}

/// `POST /api/docs/{id}/unfile`: a friend's document, and every version of
/// it, back under their own row and off any desk -- the Undo of it being
/// filed into the reader's folder for a repository both have, or kept on a
/// desk. Nothing on disk moves: a Save stays where it was written.
pub(crate) async fn doc_unfile(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    if let Err(no) = theirs(&app, &id) {
        return *no;
    }
    match app.store.unfile(&id) {
        Ok(Some(doc)) => {
            emit(&app, "pinned", json!({ "id": id }));
            emit(&app, "rendered", json!({ "id": id }));
            emit(&app, "deskdocs", json!({}));
            Json(json!({ "doc": doc })).into_response()
        }
        Ok(None) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "it does not say which friend sent it" })),
        )
            .into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/peers/outbox/{id}/retry`: a frame that stopped trying, tried
/// again from the start, now.
pub(crate) async fn outbox_retry(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    match app.store.peer_retry(&id) {
        Ok(true) => {
            app.peers.wake.notify_one();
            peers_moved(&app);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

/// A friend's name as a folder: lowercase letters, digits and dashes.
pub(crate) fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').chars().take(40).collect::<String>();
    if out.is_empty() {
        "friend".to_string()
    } else {
        out
    }
}

/// The name a saved document takes: the sender's file name, a name and no
/// path, or the title as one with the extension its kind has.
pub(crate) fn file_name(doc: &crate::store::Doc) -> String {
    let sent = doc
        .source_path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|f| f.to_string_lossy().to_string())
        .filter(|f| !f.starts_with('.') && !f.trim().is_empty());
    sent.unwrap_or_else(|| {
        let ext = match doc.kind {
            crate::render::Kind::Markdown => "md",
            _ => doc
                .lang
                .as_deref()
                .filter(|l| l.len() <= 8)
                .unwrap_or("txt"),
        };
        format!("{}.{ext}", slug(&doc.title))
    })
}

/// Copy `src` into `dir` as `name`, or `stem-2.ext`, `stem-3.ext`… -- the
/// first that is not there. `create_new` makes "not there" the file
/// system's answer, not a check that a race could slip past.
pub(crate) fn save_new(
    src: &std::path::Path,
    dir: &std::path::Path,
    name: &str,
) -> anyhow::Result<std::path::PathBuf> {
    use std::io::Write;
    let bytes = std::fs::read(src)?;
    std::fs::create_dir_all(dir)?;
    let p = std::path::Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".into());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..1000 {
        let at = dir.join(if n == 1 {
            format!("{stem}{ext}")
        } else {
            format!("{stem}-{n}{ext}")
        });
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&at)
        {
            Ok(mut f) => {
                f.write_all(&bytes)?;
                return Ok(at);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("a thousand files by that name are already there")
}

/// An offer from a panel whose program ended is answered No: the agent that
/// asked is gone, and nothing is sent later on a question nobody can see
/// the context of any more.
pub(crate) fn sweep_offers(app: &App) {
    let Ok(offers) = app.store.peer_offers() else {
        return;
    };
    let mut dropped = 0;
    for o in offers {
        if !o.pane.is_empty() && !app.panes.is_running(&o.pane) {
            dropped += app.store.drop_peer_offers_of(&o.pane).unwrap_or(0);
        }
    }
    if dropped > 0 {
        emit(app, "peeroffers", json!({}));
    }
}
