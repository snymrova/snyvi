//! The event stream (`/api/events`): one SSE connection per open page,
//! the mark that counts windows and agents, the resync when a stream falls
//! behind, and the focus beacon desktop notifications read.

use super::*;

/// Open tabs report focus so arrivals only raise a desktop notification when nobody is looking.
pub(crate) async fn focus(State(app): S, headers: HeaderMap) -> Response {
    if let Some(no) = refuse_reader(&app, &headers) {
        return no;
    }
    *app.last_focus.lock().unwrap() = Instant::now();
    StatusCode::NO_CONTENT.into_response()
}

pub(crate) fn notify_desktop(app: &App, doc: &Doc) {
    if std::env::var("SNYVI_NOTIFY")
        .map(|v| v == "0")
        .unwrap_or(false)
    {
        return;
    }
    let focused_recently =
        app.last_focus.lock().unwrap().elapsed() < std::time::Duration::from_secs(4);
    if focused_recently {
        return;
    }
    // Clicking it opens the document where the reader reads: the window it
    // belongs to, raised, or a browser when there is no window. The daemon is
    // the one process that knows which, so it decides here rather than handing
    // a URL to the desktop and hoping.
    let url = format!("{}/d/{}", config::base_url(), doc.id);
    let has_window = app.has_window();
    crate::platform::notify_open(
        &doc.title,
        &format!("{} · {}", doc.project, doc.workflow_title),
        move || {
            if has_window && crate::desktop::hand_to_window(&url) {
                return;
            }
            platform::open_url(&url);
        },
    );
}

#[derive(Deserialize)]
pub(crate) struct EventsQ {
    /// Set by a page that is inside the native window, so the daemon knows
    /// there is one to hand a link to. A string rather than a bool because a
    /// query string is not JSON: `?window=1` is what a page would naturally
    /// send, and it is not a bool to serde.
    ///
    /// Forgeable, and deliberately kept anyway: it is a count hint, not a
    /// credential. `EventSource` cannot set a header, so the capability cannot
    /// ride this stream and the count has nowhere else to live; what makes that
    /// safe is that nothing reachable from here grants anything. See
    /// `App::windows`.
    #[serde(default)]
    pub(crate) window: Option<String>,
    /// Set by the MCP server, with the name its client gave in `initialize`,
    /// so the daemon knows that agent is here for as long as the stream is.
    #[serde(default)]
    pub(crate) agent: Option<String>,
}

impl EventsQ {
    pub(crate) fn is_window(&self) -> bool {
        self.window
            .as_deref()
            .is_some_and(|v| !matches!(v, "" | "0" | "false" | "False"))
    }

    /// What the window says of itself: a window from 1.7 on stamps its own
    /// number on the mark, and the page passes it along; an older one says
    /// `1`, which the updater reads as older than any.
    pub(crate) fn window_version(&self) -> Option<String> {
        self.window.clone().filter(|_| self.is_window())
    }

    /// The agent's name, trimmed and cut to a length the header can hold.
    /// None when it is empty, which is a page and not an agent.
    pub(crate) fn agent(&self) -> Option<String> {
        let name = self.agent.as_deref()?.trim();
        if name.is_empty() {
            return None;
        }
        Some(name.chars().take(64).collect())
    }
}

/// Held by an event stream for as long as that stream lasts. A page that is
/// closed, reloaded or navigated away from takes its connection with it, and
/// an agent's process that ends takes its own; every count follows. Nothing
/// here times out, so a window that is quit is not a window a moment later,
/// a page that is gone is not a socket, and an agent whose session was
/// closed is not here.
pub(crate) struct StreamMark {
    pub(crate) app: Arc<App>,
    pub(crate) window: bool,
    pub(crate) agent: Option<String>,
}

impl StreamMark {
    pub(crate) fn new(
        app: Arc<App>,
        window: bool,
        agent: Option<String>,
        window_version: Option<String>,
    ) -> StreamMark {
        app.streams.fetch_add(1, Ordering::Relaxed);
        if agent.is_none() {
            app.pages.fetch_add(1, Ordering::Relaxed);
        }
        if window {
            app.windows.fetch_add(1, Ordering::Relaxed);
            // A window older than the update just applied wants: asked to
            // quit, and started again once its stream has ended, below.
            // Most releases never touch the window, and it is left alone.
            if let Some(u) = &app.update {
                if u.window_is_too_old(window_version.as_deref()) {
                    if let Some(bin) = u.app_path() {
                        eprintln!("snyvi: the window is {}, older than this release wants; relaunching it", window_version.as_deref().unwrap_or("?"));
                        app.relaunch_window.store(true, Ordering::Relaxed);
                        if let Err(e) = platform::spawn_detached(&bin, &["--quit"]) {
                            eprintln!("snyvi: could not ask the window to quit: {e}");
                            app.relaunch_window.store(false, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        if let Some(name) = &agent {
            let changed = {
                let mut m = app.online.lock().unwrap_or_else(|e| e.into_inner());
                *m.entry(name.clone()).or_insert(0) += 1;
                json!(*m)
            };
            emit(&app, "agents", json!({ "online": changed }));
        }
        StreamMark { app, window, agent }
    }
}

impl Drop for StreamMark {
    fn drop(&mut self) {
        self.app.streams.fetch_sub(1, Ordering::Relaxed);
        if self.agent.is_none() {
            self.app.pages.fetch_sub(1, Ordering::Relaxed);
        }
        if self.window {
            let left = self
                .app
                .windows
                .fetch_sub(1, Ordering::Relaxed)
                .saturating_sub(1);
            if left == 0 && self.app.relaunch_window.load(Ordering::Relaxed) {
                relaunch_window_when_gone(self.app.clone());
            }
        }
        // The last window closing is one of the updater's doors, and a page
        // going is worth a look at a pending restart.
        self.app.restart_wake.notify_one();
        if let Some(name) = &self.agent {
            let changed = {
                let mut m = self.app.online.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(n) = m.get_mut(name) {
                    *n -= 1;
                    if *n == 0 {
                        m.remove(name);
                    }
                }
                json!(*m)
            };
            emit(&self.app, "agents", json!({ "online": changed }));
        }
    }
}

/// The window that was asked to quit has closed its stream: once no window
/// has come back for `WINDOW_GONE_FOR` -- a page that reloads itself closes
/// its stream too, and is back in a moment -- the new one is started. A
/// window that did come back is still the old one, and its stream ending
/// later is looked at again.
pub(crate) fn relaunch_window_when_gone(app: Arc<App>) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(async move {
        tokio::time::sleep(WINDOW_GONE_FOR).await;
        if app.windows.load(Ordering::Relaxed) != 0
            || !app.relaunch_window.swap(false, Ordering::Relaxed)
        {
            return;
        }
        if let Some(exe) = app.exe.as_ref().map(|e| e.path.clone()) {
            if let Err(e) = platform::spawn_detached(&exe, &["app"]) {
                eprintln!("snyvi: could not start the window again: {e}");
            }
        }
    });
}

pub(crate) const WINDOW_GONE_FOR: std::time::Duration = std::time::Duration::from_secs(2);

/// Broadcast payloads are "<event name>\n<json>".
///
/// The stream ends when the daemon is asked to stop. A graceful shutdown
/// closes the listener and then waits for every response in flight to
/// finish, and a stream that never ends is a response that never finishes:
/// the old daemon stayed up for as long as the window did, listening on
/// nothing, and the window stayed on it -- it heard no more arrivals, and the
/// daemon that took the port counted no window and handed every agent a link
/// to open in a browser instead. Seen on this machine: ten hours, one tab per
/// document. Ended here, the page reconnects to whatever is on the port now.
pub(crate) async fn events(
    State(app): S,
    Query(q): Query<EventsQ>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = app.events.subscribe();
    let stop = BroadcastStream::new(app.shutdown.subscribe()).map(|_| None);
    let mark = StreamMark::new(app.clone(), q.is_window(), q.agent(), q.window_version());
    // The first thing on every stream is what the updater has to say, so
    // the pill is right at first paint without a field on every boot
    // payload or a poll.
    let first = tokio_stream::once(Some(Ok(Event::default()
        .event("update")
        .data(update_json(&app).to_string()))));
    let stream = first
        .chain(BroadcastStream::new(rx).filter_map(move |m| {
            // Captured so that the mark lives exactly as long as the stream does.
            let _keep = &mark;
            let ev = match m {
                Ok(msg) => {
                    let (name, data) = msg.split_once('\n').unwrap_or(("doc", msg.as_str()));
                    Event::default().event(name).data(data)
                }
                // The stream fell behind the channel and the events between
                // are gone. One `resync` in their place: the page refetches
                // the tree, the queue, the notes, the agents and the desks,
                // which is what each of them would have had it do.
                Err(_lagged) => Event::default().event("resync").data("{}"),
            };
            Some(Some(Ok(ev)))
        }))
        .merge(stop)
        .take_while(Option::is_some)
        .map(Option::unwrap);
    Sse::new(stream).keep_alive(KeepAlive::default())
}
