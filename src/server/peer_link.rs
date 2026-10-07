//! The links: the sockets this daemon holds at the relay for as long as it
//! has a friend. One line per friend (`/line/{me}/{them}`): a frame goes
//! down it as pieces and the relay passes them straight to the friend's
//! socket when that is open, storing them only when it is not, so a
//! document to someone who is there costs the relay a twentieth of a
//! request and nothing written. The friend's ack comes back as "arrived".
//! And, while any friend is on a snyvi too old for a line (`LINE_V`), one
//! link to this daemon's own mailbox (`/inbox/{me}`), where such a friend
//! leaves frames over HTTP and the relay pushes them down. The routes and
//! what to do with a frame are in `api_peer`; the cryptography and the
//! relay's protocol in `crate::peer`; this file only keeps the sockets up.
//!
//! A supervisor task starts a task per friend and the mailbox one, and is
//! the one place the outbox is flushed from on a wake and on the ten-minute
//! tick (`flush_all`: one flush at a time, detached, so no socket waits on
//! an upload). Each socket task:
//!
//!   connect ─(101)─▶ open ─(closed, error, 60 s of silence)─▶ backoff
//!   connect ─(refused, no network)─▶ backoff ─(1, 2, 4 … 300 s)─▶ connect
//!   open ─(up for a minute)─▶ the backoff starts over at the next close
//!   open ─(closed 4429: the day's share of sockets spent)─▶ sleep until midnight
//!   open or backoff ─(the friend removed, or no friend needs it)─▶ done
//!
//! Beside them, a round every ten minutes fingerprints the reader's folders
//! (`spawn_prints`).

use super::*;
use crate::peer::{self, Assembly, Chunk, Identity, LineSaid, Peer, Waiting};
use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMessage};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The relay has this long to answer the upgrade.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Nothing heard -- no frame, no pong -- for this long, and the link is
/// taken for dead and opened again. One ping past `PING_EVERY`. A link
/// that stayed up this long counts as a good one: its backoff starts over.
const SILENCE: Duration = Duration::from_secs(60);
/// Between flushes of what waits in the outbox, and the housekeeping that
/// goes with them.
const RETRY_EVERY: Duration = Duration::from_secs(600);
/// Tries at the mailbox socket before the inbox is swept over HTTP instead,
/// in case a proxy on the way lets a request through and not an upgrade.
const FALLBACK_AFTER: u32 = 6;
/// How often the supervisor looks whether a friend was added or needs a
/// socket (a pairing also wakes it, so this is the belt).
const LOOK_EVERY: Duration = Duration::from_secs(60);
/// Frames waiting to go down one line, cut already: eight full ones at most.
const LINE_QUEUE: usize = 8;
/// While the relay asks for quiet, no reconnect comes sooner than this.
const QUIET_BACKOFF: Duration = Duration::from_secs(60);

/// How an open socket ended.
enum Left {
    /// Nothing to wait for: the friend was removed, or no friend needs it.
    Done,
    /// Closed, broken, or silent: open it again.
    Closed(String),
    /// The relay closed it for the day: this address opened its share of
    /// sockets. Back at the moment it named (seconds).
    Budget(i64),
}

/// The task: beside the update checker, for the life of the daemon.
pub(crate) fn spawn_peer_link(app: Arc<App>) {
    spawn_prints(app.clone());
    tokio::spawn(supervise(app));
}

/// Starts a socket task per live friend and the mailbox one while a friend
/// needs it, and flushes the outbox on a wake and on the tick. A task that
/// ended (its friend removed) is started again if the friend comes back.
async fn supervise(app: Arc<App>) {
    let mut lines: HashMap<i64, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut mailbox: Option<tokio::task::JoinHandle<()>> = None;
    let mut wake = app.peers.wake.subscribe();
    let mut tick = tokio::time::interval(RETRY_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        lines.retain(|_, h| !h.is_finished());
        if mailbox.as_ref().is_some_and(|h| h.is_finished()) {
            mailbox = None;
        }
        let friends = live_friends(&app);
        if !friends.is_empty() {
            if let Some(me) = friend_identity(&app).await {
                for p in &friends {
                    lines.entry(p.id).or_insert_with(|| {
                        tokio::spawn(line_task(app.clone(), me.clone(), p.clone()))
                    });
                }
                if mailbox.is_none() && friends.iter().any(|p| p.v < peer::LINE_V) {
                    mailbox = Some(tokio::spawn(mailbox_task(app.clone(), me.clone())));
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(LOOK_EVERY) => {},
            _ = wake.changed() => {
                if !friends.is_empty() {
                    let app_b = app.clone();
                    let _ = tokio::task::spawn_blocking(move || sweep_offers(&app_b)).await;
                    flush_all(&app);
                }
            },
            _ = tick.tick() => {
                if !friends.is_empty() {
                    let app_b = app.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = app_b.store.prune_peer_taken();
                    }).await;
                    flush_all(&app);
                }
            },
        }
    }
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

fn live_friends(app: &App) -> Vec<Peer> {
    app.store
        .peers()
        .map(|ps| ps.into_iter().filter(|p| p.removed_at == 0).collect())
        .unwrap_or_default()
}

fn has_friends(app: &App) -> bool {
    !live_friends(app).is_empty()
}

/// Whether this friend is still one.
fn friend(app: &App, id: i64) -> Option<Peer> {
    app.store
        .peer(id)
        .ok()
        .flatten()
        .filter(|p| p.removed_at == 0)
}

/// Whether the mailbox link has a friend to wait for: one on a snyvi too
/// old for a line.
fn needs_mailbox(app: &App) -> bool {
    live_friends(app).iter().any(|p| p.v < peer::LINE_V)
}

/// The wait before the `attempt`th try: the relay's backoff, and no less
/// than a minute while it asks for quiet.
fn wait_before(app: &App, attempt: u32) -> Duration {
    let b = peer::backoff(attempt);
    let quiet = app.peers.quiet_until.load(Relaxed);
    if quiet > crate::store::now() {
        b.max(QUIET_BACKOFF)
    } else {
        b
    }
}

/// Whether the backoff starts over after a socket that ended: only one
/// that was up for `SILENCE`. A relay that accepts and closes at once is
/// backed off like one that refuses.
pub(crate) fn attempt_after(up_for: Duration, attempt: u32) -> u32 {
    if up_for >= SILENCE {
        0
    } else {
        attempt
    }
}

/// Asleep until the moment the relay named: a wake does not cut it short.
async fn sleep_until_secs(until: i64) {
    let now = crate::store::now();
    if until > now {
        tokio::time::sleep(Duration::from_secs((until - now) as u64)).await;
    }
}

/// A signed upgrade at `path`.
async fn connect(me: &Identity, url: String, path: &str) -> anyhow::Result<Socket> {
    let mut req = url.into_client_request().context("the relay's address")?;
    req.headers_mut().insert(
        "x-snyvi-auth",
        me.relay_auth("GET", path)
            .parse()
            .context("the signature as a header")?,
    );
    let (socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(req))
        .await
        .map_err(|_| anyhow::anyhow!("no answer to the link in {} s", CONNECT_TIMEOUT.as_secs()))?
        .context("opening the link")?;
    Ok(socket)
}

/// Whether a close frame is the relay spending this address's day, and when
/// it says to come back.
fn budget_close(
    frame: &Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>,
) -> Option<i64> {
    let f = frame.as_ref()?;
    (u16::from(f.code) == peer::CLOSE_BUDGET).then(|| peer::until_of(&f.reason))
}

/// What the relay said in a text message that is not a frame: quiet, which
/// both kinds of socket hear.
fn heard_quiet(app: &App, t: &str) {
    if let Ok(LineSaid::Quiet { until }) = serde_json::from_str::<LineSaid>(t) {
        app.peers.quiet_until.store(until / 1000, Relaxed);
    }
}

// ---- a line --------------------------------------------------------------------

/// One friend's line, for as long as they are a friend.
async fn line_task(app: Arc<App>, me: Identity, p: Peer) {
    let mut attempt: u32 = 0;
    let mut wake = app.peers.wake.subscribe();
    let path = format!("/line/{}/{}", me.address(), p.sign_key);
    loop {
        if friend(&app, p.id).is_none() {
            return;
        }
        match connect(&me, peer::line_ws(&me.address(), &p.sign_key), &path).await {
            Ok(socket) => {
                if attempt > 0 {
                    eprintln!("snyvi: the line to {} is back", p.name);
                }
                let opened = Instant::now();
                match on_line(&app, &me, &p, socket, &mut wake).await {
                    Ok(Left::Done) => return,
                    Ok(Left::Closed(why)) => {
                        eprintln!("snyvi: the line to {} closed: {why}", p.name)
                    }
                    Ok(Left::Budget(until)) => {
                        eprintln!("snyvi: the relay has had this snyvi's share of sockets for today; the line to {} waits", p.name);
                        sleep_until_secs(until).await;
                        attempt = 0;
                        continue;
                    }
                    Err(e) => eprintln!("snyvi: the line to {}: {e:#}", p.name),
                }
                attempt = attempt_after(opened.elapsed(), attempt);
            }
            Err(e) => {
                if attempt == 0 {
                    eprintln!("snyvi: the line to {}: {e:#}", p.name);
                }
            }
        }
        attempt += 1;
        tokio::select! {
            _ = tokio::time::sleep(wait_before(&app, attempt)) => {},
            _ = wake.changed() => {},
        }
    }
}

/// An open line, from the first flush to whatever ends it.
async fn on_line(
    app: &Arc<App>,
    me: &Identity,
    p: &Peer,
    mut socket: Socket,
    wake: &mut tokio::sync::watch::Receiver<u64>,
) -> anyhow::Result<Left> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Outbound>(LINE_QUEUE);
    app.peers
        .lines
        .lock()
        .unwrap()
        .insert(p.id, LineHandle { tx: tx.clone() });
    // Whatever waits for them is due now that there is a line to put it on.
    let app_b = app.clone();
    let pid = p.id;
    let _ = tokio::task::spawn_blocking(move || app_b.store.peer_due_now(pid)).await;
    flush_all(app);

    let mut ping = tokio::time::interval(peer::PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut heard = Instant::now();
    let mut assembly = Assembly::default();

    let left = loop {
        let silence = tokio::time::sleep_until(heard + SILENCE);
        tokio::select! {
            msg = socket.next() => {
                let Some(msg) = msg else {
                    break Ok(Left::Closed("the relay hung up".into()));
                };
                let msg = msg.context("reading the line")?;
                heard = Instant::now();
                match msg {
                    WsMessage::Binary(b) => {
                        let Some(c) = Chunk::parse(&b) else { continue };
                        if let Some((id, bytes)) = assembly.take(&c) {
                            let w = Waiting { id, sender: p.sign_key.clone(), size: bytes.len() as u64 };
                            took(app, me, &mut socket, w, bytes, true).await?;
                        }
                    }
                    WsMessage::Text(t) => {
                        if t.as_str() == "pong" {
                            continue;
                        }
                        let Ok(said) = serde_json::from_str::<LineSaid>(t.as_str()) else { continue };
                        let app_b = app.clone();
                        let p_b = p.clone();
                        tokio::task::spawn_blocking(move || line_said(&app_b, &p_b, said)).await?;
                    }
                    WsMessage::Close(f) => {
                        break Ok(match budget_close(&f) {
                            Some(until) => Left::Budget(until),
                            None => Left::Closed("closed by the relay".into()),
                        });
                    }
                    _ => {}
                }
            }
            out = rx.recv() => {
                let Some(out) = out else { break Ok(Left::Closed("the line's queue closed".into())) };
                for c in out.chunks {
                    socket.send(WsMessage::Binary(c.into())).await.with_context(|| format!("sending {} down the line", out.id))?;
                }
            }
            _ = ping.tick() => {
                socket.send(WsMessage::Text("ping".into())).await.context("the ping")?;
            }
            _ = silence => {
                let _ = socket.close(None).await;
                break Ok(Left::Closed(format!("nothing heard in {} s", SILENCE.as_secs())));
            }
            _ = wake.changed() => {
                if friend(app, p.id).is_none() {
                    let _ = socket.close(None).await;
                    break Ok(Left::Done);
                }
            }
        }
    };
    // Only this task's handle goes: a newer task for the same friend may
    // have put its own there already.
    let mut lines = app.peers.lines.lock().unwrap();
    if lines.get(&p.id).is_some_and(|h| h.tx.same_channel(&tx)) {
        lines.remove(&p.id);
    }
    left
}

/// What the line said about a frame or the friend, kept in the store.
/// Blocking.
fn line_said(app: &Arc<App>, p: &Peer, said: LineSaid) {
    let now = crate::store::now();
    match said {
        // In the relay's keeping for them: Sent, as a mailbox deposit is.
        LineSaid::Held(id) => {
            let _ = app.store.peer_sent(&id);
            let _ = app.store.touch_peer(p.id, false);
            peers_moved(app);
        }
        // They have it: Sent, and the arrived mark, in one word.
        LineSaid::Arrived(id) => {
            let _ = app.store.peer_sent(&id);
            let _ = app.store.touch_peer(p.id, false);
            let _ = app.store.peer_receipt(p.id, &id, "arrived");
            peers_moved(app);
        }
        LineSaid::Resend(id) => {
            let _ = app.store.peer_waiting(&id, "sending again", Some(now));
            flush_all(app);
        }
        LineSaid::Full(id) => {
            let _ = app.store.peer_waiting(&id, "their line is full", None);
        }
        LineSaid::Failed { id, why } => {
            let _ = app.store.peer_failed(&id, &why);
        }
        // Their socket is on the line: they speak on one, and whatever
        // waits for them goes now.
        LineSaid::Friend { on: true } => {
            if p.v < peer::LINE_V {
                let _ = app.store.peer_set_v(p.id, peer::LINE_V);
            }
            let _ = app.store.peer_due_now(p.id);
            flush_all(app);
        }
        LineSaid::Friend { on: false } => {}
        LineSaid::Quiet { until } => app.peers.quiet_until.store(until / 1000, Relaxed),
    }
}

// ---- the mailbox link ----------------------------------------------------------

/// The link to this daemon's own mailbox, while a friend on an older snyvi
/// needs it.
async fn mailbox_task(app: Arc<App>, me: Identity) {
    let mut attempt: u32 = 0;
    let mut wake = app.peers.wake.subscribe();
    let path = format!("/inbox/{}", me.address());
    loop {
        if !needs_mailbox(&app) {
            return;
        }
        match connect(&me, peer::relay_ws(&me.address()), &path).await {
            Ok(socket) => {
                if attempt > 0 {
                    eprintln!("snyvi: the relay is back");
                }
                let opened = Instant::now();
                match linked(&app, &me, socket, &mut wake).await {
                    Ok(Left::Done) => return,
                    Ok(Left::Closed(why)) => eprintln!("snyvi: the relay link closed: {why}"),
                    Ok(Left::Budget(until)) => {
                        eprintln!("snyvi: the relay has had this snyvi's share of sockets for today; the mailbox link waits");
                        sleep_until_secs(until).await;
                        attempt = 0;
                        continue;
                    }
                    Err(e) => eprintln!("snyvi: the relay link: {e:#}"),
                }
                attempt = attempt_after(opened.elapsed(), attempt);
            }
            Err(e) => {
                if attempt == 0 {
                    eprintln!("snyvi: the relay: {e:#}");
                }
            }
        }
        attempt += 1;
        if attempt >= FALLBACK_AFTER {
            flush_all(&app);
            let app_b = app.clone();
            let me_b = me.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(e) = bring_in(&app_b, &me_b) {
                    eprintln!("snyvi: the relay, over HTTP: {e:#}");
                }
            })
            .await;
        }
        tokio::select! {
            _ = tokio::time::sleep(wait_before(&app, attempt)) => {},
            _ = wake.changed() => {},
        }
    }
}

/// An open mailbox link, from the catch-up to whatever ends it.
async fn linked(
    app: &Arc<App>,
    me: &Identity,
    mut socket: Socket,
    wake: &mut tokio::sync::watch::Receiver<u64>,
) -> anyhow::Result<Left> {
    // Housekeeping on the open, off the runtime: offers whose panel ended,
    // once per start the frames held for a newer snyvi, and a flush.
    let app_b = app.clone();
    let me_b = me.clone();
    tokio::task::spawn_blocking(move || {
        sweep_offers(&app_b);
        if !app_b.peers.held_read.swap(true, Relaxed) {
            read_held(&app_b, &me_b);
        }
    })
    .await?;
    flush_all(app);

    let mut ping = tokio::time::interval(peer::PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
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
                            heard_quiet(app, t.as_str());
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
                            Ok(bytes) => took(app, me, &mut socket, w, bytes, false).await?,
                            Err(e) => eprintln!("snyvi: a frame from the relay could not be fetched: {e:#}"),
                        }
                    }
                    WsMessage::Binary(b) => {
                        if let Some(w) = pending.take() {
                            took(app, me, &mut socket, w, b.to_vec(), false).await?;
                        }
                    }
                    WsMessage::Close(f) => {
                        return Ok(match budget_close(&f) {
                            Some(until) => Left::Budget(until),
                            None => Left::Closed("closed by the relay".into()),
                        });
                    }
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
            _ = wake.changed() => {
                if !needs_mailbox(app) {
                    let _ = socket.close(None).await;
                    return Ok(Left::Done);
                }
            }
        }
    }
}

/// One frame with its bytes in hand: kept or dropped by `take_in`, then
/// acked down the socket either way. A store that will not answer is the one
/// thing that leaves the frame at the relay for the next catch-up.
async fn took(
    app: &Arc<App>,
    me: &Identity,
    socket: &mut Socket,
    w: Waiting,
    bytes: Vec<u8>,
    via_line: bool,
) -> anyhow::Result<()> {
    let app_b = app.clone();
    let me_b = me.clone();
    let id = w.id.clone();
    match tokio::task::spawn_blocking(move || take_in(&app_b, &me_b, &w, bytes, via_line)).await? {
        Ok(_) => socket
            .send(WsMessage::Text(peer::ack_message(&id).into()))
            .await
            .context("the ack")?,
        Err(e) => eprintln!("snyvi: a frame from the relay was left there: {e:#}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_link_keeps_counting_and_a_long_one_starts_again() {
        assert_eq!(attempt_after(Duration::from_secs(5), 4), 4);
        assert_eq!(attempt_after(Duration::from_secs(120), 4), 0);
    }
}
