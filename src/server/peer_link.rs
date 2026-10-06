//! The link: one WebSocket from this daemon to its own mailbox at the relay,
//! held open for as long as it has a friend. The relay pushes a frame down
//! it the moment a friend's daemon leaves one, so a document is here within
//! a second while snyvi runs, and is waiting in the Inbox when the window
//! opens after a night; between frames the mailbox sleeps and the link costs
//! nothing. The routes and what to do with a frame are in `api_peer`; the
//! cryptography and the relay's protocol in `crate::peer`; this file only
//! keeps the socket up.
//!
//! One task, one state at a time:
//!
//!   no friends ─(a friend is pinned)─▶ connect ─(101)─▶ open
//!   connect ─(refused, no network)─▶ backoff ─(1, 2, 4 … 300 s)─▶ connect
//!   backoff, six times running ─▶ one HTTP sweep of the inbox, then on
//!   open ─(closed, error, 60 s of silence)─▶ backoff
//!   open or backoff ─(the last friend removed)─▶ no friends
//!
//! While open: a `{frame}` message followed by its bytes, or fetched over
//! HTTP when the relay said it was too big to push, goes through `take_in`
//! and is acked down the socket; "ping" every 45 s keeps the line and is
//! answered by the relay without waking the mailbox; a wake (a friend added,
//! something to send) flushes the outbox; and every ten minutes the frames
//! the relay once refused with "full" are tried again. Beside it, a round
//! every ten minutes fingerprints the reader's folders (`spawn_prints`).

use super::*;
use crate::peer::{self, Identity, Waiting};
use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The relay has this long to answer the upgrade.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Nothing heard -- no frame, no pong -- for this long, and the link is
/// taken for dead and opened again. One ping past `PING_EVERY`.
const SILENCE: Duration = Duration::from_secs(60);
/// Between tries at frames the relay refused because a friend's mailbox
/// was full.
const RETRY_EVERY: Duration = Duration::from_secs(600);
/// Tries at the socket before the inbox is swept over HTTP instead, in
/// case a proxy on the way lets a request through and not an upgrade.
const FALLBACK_AFTER: u32 = 6;
/// Without a friend, how often to look whether one was pinned (a pairing
/// also wakes the task, so this is the belt).
const LOOK_EVERY: Duration = Duration::from_secs(60);

/// How an open link ended.
enum Left {
    /// The last friend was removed: nothing to wait for.
    NoFriends,
    /// Closed, broken, or silent: open it again.
    Closed(String),
}

/// The task: beside the update checker, for the life of the daemon.
pub(crate) fn spawn_peer_link(app: Arc<App>) {
    spawn_prints(app.clone());
    tokio::spawn(async move {
        // Failed tries since the last open link; 0 while it is open.
        let mut attempt: u32 = 0;
        loop {
            let Some(me) = friend_identity(&app).await else {
                attempt = 0;
                tokio::select! {
                    _ = tokio::time::sleep(LOOK_EVERY) => {},
                    _ = app.peers.wake.notified() => {},
                }
                continue;
            };
            match connect(&me).await {
                Ok(socket) => {
                    if attempt > 0 {
                        eprintln!("snyvi: the relay is back");
                    }
                    attempt = 0;
                    match linked(&app, &me, socket).await {
                        Ok(Left::NoFriends) => continue,
                        Ok(Left::Closed(why)) => eprintln!("snyvi: the relay link closed: {why}"),
                        Err(e) => eprintln!("snyvi: the relay link: {e:#}"),
                    }
                }
                Err(e) => {
                    if attempt == 0 {
                        eprintln!("snyvi: the relay: {e:#}");
                    }
                }
            }
            attempt += 1;
            if attempt >= FALLBACK_AFTER {
                let app_b = app.clone();
                let me_b = me.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    flush_outbox(&app_b, None);
                    if let Err(e) = bring_in(&app_b, &me_b) {
                        eprintln!("snyvi: the relay, over HTTP: {e:#}");
                    }
                })
                .await;
            }
            tokio::select! {
                _ = tokio::time::sleep(peer::backoff(attempt)) => {},
                _ = app.peers.wake.notified() => {},
            }
        }
    });
}

/// How long after a start the reader's folders are first fingerprinted,
/// and how often after that a round looks for one not read for a day.
const PRINTS_FIRST: Duration = Duration::from_secs(20);
const PRINTS_EVERY: Duration = Duration::from_secs(600);
/// At most this many folders a round, each two or three git commands.
const PRINTS_ROUND: usize = 40;

/// The fingerprints of the reader's folders (`git::print`), kept fresh while
/// there is a friend to be sent things by: what a friend's document is filed
/// by (`api_peer::file_into`). Only the folders snyvi already has a row for,
/// and never `~`; with no friend, no git runs for this at all.
fn spawn_prints(app: Arc<App>) {
    tokio::spawn(async move {
        tokio::time::sleep(PRINTS_FIRST).await;
        loop {
            if has_friends(&app) {
                let app_b = app.clone();
                let _ = tokio::task::spawn_blocking(move || print_folders(&app_b)).await;
            }
            tokio::time::sleep(PRINTS_EVERY).await;
        }
    });
}

/// One round: the folders whose fingerprint is a day old or was never read.
/// One that is gone, or in no repository, is marked read with no print, so
/// it is not asked again until tomorrow.
pub(crate) fn print_folders(app: &App) -> usize {
    let before = crate::store::now() - PRINT_KEPT;
    let Ok(roots) = app.store.roots_to_print(before) else {
        return 0;
    };
    let mut n = 0;
    for root in roots.into_iter().take(PRINTS_ROUND) {
        let dir = std::path::Path::new(&root);
        let print = if dir.is_dir() {
            crate::git::print(dir)
        } else {
            None
        };
        n += print.is_some() as usize;
        let _ = app.store.set_print(&root, print.as_ref());
    }
    n
}

/// The identity, when there is a friend to wait for. Never mints one: a
/// daemon nobody has paired touches no keychain and no relay.
async fn friend_identity(app: &Arc<App>) -> Option<Identity> {
    if !has_friends(app) {
        return None;
    }
    let app_b = app.clone();
    tokio::task::spawn_blocking(move || identity_if_any(&app_b))
        .await
        .ok()
        .flatten()
}

fn has_friends(app: &App) -> bool {
    app.store
        .peers()
        .map(|ps| ps.iter().any(|p| p.removed_at == 0))
        .unwrap_or(false)
}

/// The upgrade: signed as a read of this daemon's inbox, in the header.
async fn connect(me: &Identity) -> anyhow::Result<Socket> {
    let path = format!("/inbox/{}", me.address());
    let mut req = peer::relay_ws(&me.address())
        .into_client_request()
        .context("the relay's address")?;
    req.headers_mut().insert(
        "x-snyvi-auth",
        me.relay_auth("GET", &path)
            .parse()
            .context("the signature as a header")?,
    );
    let (socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(req))
        .await
        .map_err(|_| anyhow::anyhow!("no answer to the link in {} s", CONNECT_TIMEOUT.as_secs()))?
        .context("opening the link")?;
    Ok(socket)
}

/// An open link, from the catch-up to whatever ends it.
async fn linked(app: &Arc<App>, me: &Identity, mut socket: Socket) -> anyhow::Result<Left> {
    // Housekeeping on every open, off the runtime: ids too old to recur,
    // offers whose panel ended, and whatever is queued to go.
    let app_b = app.clone();
    let me_b = me.clone();
    tokio::task::spawn_blocking(move || {
        let _ = app_b.store.prune_peer_taken();
        sweep_offers(&app_b);
        read_held(&app_b, &me_b);
        flush_outbox(&app_b, None);
    })
    .await?;

    let mut ping = tokio::time::interval(peer::PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut retry = tokio::time::interval(RETRY_EVERY);
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    retry.tick().await;
    let mut heard = Instant::now();
    // A frame announced whose bytes are the next binary message.
    let mut pending: Option<Waiting> = None;

    loop {
        let silence = tokio::time::sleep_until(heard + SILENCE);
        tokio::select! {
            msg = socket.next() => {
                let Some(msg) = msg else {
                    return Ok(Left::Closed("the relay hung up".into()));
                };
                let msg = msg.context("reading the link")?;
                heard = Instant::now();
                match msg {
                    WsMessage::Text(t) => {
                        if t.as_str() == "pong" {
                            continue;
                        }
                        let Ok(peer::Pushed::Frame(w)) = serde_json::from_str::<peer::Pushed>(t.as_str()) else {
                            continue;
                        };
                        if w.size as usize <= peer::INLINE_MAX {
                            pending = Some(w);
                            continue;
                        }
                        pending = None;
                        let me_b = me.clone();
                        let id = w.id.clone();
                        match tokio::task::spawn_blocking(move || peer::fetch(&me_b, &id)).await? {
                            Ok(bytes) => took(app, me, &mut socket, w, bytes).await?,
                            Err(e) => eprintln!("snyvi: a frame from the relay could not be fetched: {e:#}"),
                        }
                    }
                    WsMessage::Binary(b) => {
                        if let Some(w) = pending.take() {
                            took(app, me, &mut socket, w, b.to_vec()).await?;
                        }
                    }
                    WsMessage::Close(_) => return Ok(Left::Closed("closed by the relay".into())),
                    _ => {}
                }
            }
            _ = ping.tick() => {
                socket.send(WsMessage::Text("ping".into())).await.context("the ping")?;
            }
            _ = silence => {
                let _ = socket.close(None).await;
                return Ok(Left::Closed(format!("nothing heard in {} s", SILENCE.as_secs())));
            }
            _ = app.peers.wake.notified() => {
                if !has_friends(app) {
                    let _ = socket.close(None).await;
                    return Ok(Left::NoFriends);
                }
                let app_b = app.clone();
                tokio::task::spawn_blocking(move || {
                    sweep_offers(&app_b);
                    flush_outbox(&app_b, None);
                })
                .await?;
            }
            _ = retry.tick() => {
                let app_b = app.clone();
                tokio::task::spawn_blocking(move || flush_outbox(&app_b, None)).await?;
            }
        }
    }
}

/// One frame with its bytes in hand: kept or dropped by `take_in`, then
/// acked down the link either way. A store that will not answer is the one
/// thing that leaves the frame at the relay for the next catch-up.
async fn took(
    app: &Arc<App>,
    me: &Identity,
    socket: &mut Socket,
    w: Waiting,
    bytes: Vec<u8>,
) -> anyhow::Result<()> {
    let app_b = app.clone();
    let me_b = me.clone();
    let id = w.id.clone();
    match tokio::task::spawn_blocking(move || take_in(&app_b, &me_b, &w, bytes)).await? {
        Ok(_) => socket
            .send(WsMessage::Text(peer::ack_message(&id).into()))
            .await
            .context("the ack")?,
        Err(e) => eprintln!("snyvi: a frame from the relay was left there: {e:#}"),
    }
    Ok(())
}
