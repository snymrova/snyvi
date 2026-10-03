//! The desk socket (`/api/desk`): the capability in the first frame, then
//! keys one way and frames the other. `docs/DESK.md` has the protocol.

use super::*;

/// How long a socket has to prove itself. A page that holds the capability
/// sends it in its first frame, which on a loopback connection is one round
/// trip; anything still silent after this is not a page of ours, and the
/// deadline is what keeps a connection that will never speak from being held
/// open by whatever opened it.
pub(crate) const CAPABILITY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

/// The first frame on a desk socket, and the only one read before the
/// capability is known to be good.
#[derive(Deserialize)]
pub(crate) struct Hello {
    pub(crate) capability: String,
}

/// What a page says on its desk socket once it is allowed. `docs/DESK.md` has
/// the protocol; the frames going the other way are `crate::screen`'s.
#[derive(Deserialize)]
#[serde(tag = "t")]
pub(crate) enum Said {
    /// The panes this page is showing, which replaces whatever it showed
    /// before. Each is sent a status, its old text if it has any, and a
    /// snapshot, and then its frames.
    #[serde(rename = "watch")]
    Watch { panes: Vec<String> },
    /// Keys or a paste, for one pane this page is watching.
    #[serde(rename = "in")]
    In { p: String, d: String },
    /// The size a pane is drawn at on this page.
    #[serde(rename = "size")]
    Size { p: String, c: u16, r: u16 },
    /// Of the panes this page watches, the ones out of sight: a document read
    /// over the desk, a hidden window, no room in the grid. They are framed
    /// once a second rather than sixty times, and the page draws none of it
    /// until they are back. Replaces the last one.
    #[serde(rename = "pace")]
    Pace { slow: Vec<String> },
    /// Older scrollback, above line `before`, for a page scrolled up to the
    /// top of what it holds -- or with `old`, the last run's text above the
    /// `before` lines of it the page holds. At most `n` lines.
    #[serde(rename = "more")]
    More {
        p: String,
        before: usize,
        n: usize,
        #[serde(default)]
        old: Option<u64>,
    },
}

/// One pane's frames, from its broadcast to this socket. A page that falls so
/// far behind that the broadcast drops frames for it is not sent the rest:
/// it is sent a fresh snapshot, which is always right, instead of a diff
/// against a screen it no longer holds.
pub(crate) async fn forward(
    live: Arc<crate::pane::Live>,
    first: Vec<String>,
    mut rx: broadcast::Receiver<Arc<str>>,
    out: tokio::sync::mpsc::Sender<Arc<str>>,
) {
    for f in first {
        if out.send(f.into()).await.is_err() {
            return;
        }
    }
    loop {
        match rx.recv().await {
            Ok(m) => {
                if out.send(m).await.is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let (first, fresh) = live.attach();
                rx = fresh;
                for f in first {
                    if out.send(f.into()).await.is_err() {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// The socket desks will speak over, and today the capability's proof and
/// nothing else.
///
/// Three refusals before a single byte of desk traffic could ever flow: the
/// capability is not accepted from the query string, the handshake must come
/// from snyvi's own page, and the socket is inert until a valid capability
/// arrives. A browser tab gets past none of them, which is the premise the
/// whole feature rests on.
pub(crate) async fn desk_socket(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Refused rather than quietly upgraded, so that an attempt to put the
    // capability where it would be logged fails at the place it is made. A
    // query string lands in the request path; the fragment it rides on instead
    // is never sent to a server at all.
    if q.contains_key(crate::desktop::CAPABILITY_KEY) || q.contains_key("capability") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "the capability is not a query parameter" })),
        )
            .into_response();
    }
    // The same check the terminal button is behind, for the same reason: a page
    // on another origin is refused, and a local process with no browser sends
    // neither header and is refused too.
    if !from_this_page(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page" })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| desk_session(app, socket))
}

/// What a first frame means: allowed, or not.
///
/// Split out from the socket so the rule can be read and tested on its own,
/// which is worth doing for the one function in this server that decides
/// whether a thing may run a shell. Anything that is not a well-formed frame
/// carrying a live capability under the one key that means it is a refusal.
pub(crate) fn hello_allows(caps: &crate::capability::Capabilities, frame: Option<&str>) -> bool {
    frame
        .and_then(|f| serde_json::from_str::<Hello>(f).ok())
        .is_some_and(|h| caps.verify(&h.capability))
}

/// A desk socket from the upgrade to the close.
///
/// It proves itself and then does nothing, which is the whole of this phase:
/// the panes that will speak here are two phases out. What is being built now
/// is the one thing they cannot be built without -- a socket that a window can
/// open and a tab cannot.
pub(crate) async fn desk_session(app: Arc<App>, mut socket: WebSocket) {
    let first = tokio::time::timeout(CAPABILITY_DEADLINE, socket.recv()).await;
    let frame = match &first {
        Ok(Some(Ok(Message::Text(t)))) => Some(t.as_str()),
        // Silence past the deadline, a close, a socket error, or a binary
        // frame: none of them is a capability, and all of them end the same
        // way. Only the text frame is read.
        _ => None,
    };
    if !hello_allows(&app.capabilities, frame) {
        let _ = socket
            .send(Message::Text(
                json!({ "error": "no capability" }).to_string().into(),
            ))
            .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let _ = socket
        .send(Message::Text(json!({ "ok": true }).to_string().into()))
        .await;
    // A window is showing a desk: someone can see the panes a restart
    // marked, so their clock starts now. See `pane::RESUME_FOR`.
    app.panes.arm_marks();
    // Bounded, so a page that cannot keep up makes its forwarders wait, and a
    // forwarder that waits long enough is resynced rather than buffered.
    let (out, mut frames) = tokio::sync::mpsc::channel::<Arc<str>>(64);
    let mut going = app.shutdown.subscribe();
    let mut watching: std::collections::HashMap<
        String,
        (Arc<crate::pane::Live>, tokio::task::JoinHandle<()>),
    > = Default::default();
    // The panes this page has out of sight, each one `pace(true)` owed a
    // `pace(false)`: when the page says so, stops watching it, or goes --
    // however it goes, which is why it is paid on drop.
    let mut slowed = Slowed::default();
    loop {
        tokio::select! {
            // The daemon is going, and the page's reconnect is what tells the
            // reader: the capability it holds dies with this process.
            _ = going.recv() => break,
            f = frames.recv() => {
                let Some(f) = f else { break };
                if socket.send(Message::Text(f.to_string().into())).await.is_err() {
                    break;
                }
            }
            msg = socket.recv() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(said) = serde_json::from_str::<Said>(text.as_str()) else { continue };
                match said {
                    Said::Watch { panes } => {
                        let wanted: std::collections::HashSet<String> = panes
                            .into_iter()
                            .filter(|id| crate::pane::valid_id(id))
                            .filter(|id| matches!(app.store.pane(id), Ok(Some(_))))
                            .take(crate::desk::PER_DESK as usize)
                            .collect();
                        watching.retain(|id, (live, task)| {
                            let keep = wanted.contains(id);
                            if !keep {
                                task.abort();
                                slowed.set(id, live, false);
                            }
                            keep
                        });
                        for id in wanted {
                            if watching.contains_key(&id) {
                                continue;
                            }
                            let live = app.panes.get(&id);
                            let (first, rx) = live.attach();
                            let task = tokio::spawn(forward(live.clone(), first, rx, out.clone()));
                            watching.insert(id, (live, task));
                        }
                    }
                    // Only for a pane this page is watching: a page cannot type
                    // into a pane it is not showing.
                    Said::In { p, d } => {
                        if let Some((live, _)) = watching.get(&p) {
                            live.input(d.as_bytes(), &app.panes);
                        }
                    }
                    Said::Size { p, c, r } => {
                        if let Some((live, _)) = watching.get(&p) {
                            live.resize(c, r);
                        }
                    }
                    Said::Pace { slow } => {
                        for (id, (live, _)) in &watching {
                            slowed.set(id, live, slow.contains(id));
                        }
                    }
                    // Straight back on this socket, not the pane's broadcast:
                    // only this page asked. It lands above what the page holds,
                    // so its order among the frames does not matter.
                    Said::More { p, before, n, old } => {
                        let Some((live, _)) = watching.get(&p) else { continue };
                        let Some(f) = live.more(old, before, n.min(crate::screen::KEEP_LINES)) else { continue };
                        if socket.send(Message::Text(f.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    }
    for (_, (_, task)) in watching {
        task.abort();
    }
}

/// The panes one desk socket has told the daemon are out of sight, each owed
/// a `pace(false)`. Paid as each comes back or stops being watched, and the
/// rest when the socket's session ends -- by drop, so a session that ends
/// some other way than its loop running out cannot leave a pane framed once
/// a second for a page that has it in view.
#[derive(Default)]
pub(crate) struct Slowed(pub(crate) std::collections::HashMap<String, Arc<crate::pane::Live>>);

impl Slowed {
    pub(crate) fn set(&mut self, id: &str, live: &Arc<crate::pane::Live>, slow: bool) {
        if slow == self.0.contains_key(id) {
            return;
        }
        live.pace(slow);
        if slow {
            self.0.insert(id.to_string(), live.clone());
        } else {
            self.0.remove(id);
        }
    }
}

impl Drop for Slowed {
    fn drop(&mut self) {
        for live in self.0.values() {
            live.pace(false);
        }
    }
}
