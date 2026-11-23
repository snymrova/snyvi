//! Voice (1.70, `crate::voice`): how it stands, fetch, on and off, remove,
//! and the socket a held key speaks over.
//!
//! Every one is the window's, behind the desk's gate: the capability, from
//! snyvi's own page. An agent's token opens none of them, so an agent cannot
//! start the microphone's path, send sound in, or read what was heard.
//!
//! And none of them acts on the words. The socket's answer is the helper's
//! line, handed back to the page that sent the sound; what a phrase means and
//! whether anything runs is decided there, by the reader's own window
//! (`ui/voice.js`), exactly as a command picked in the palette is.

use super::*;

type Q = Query<std::collections::HashMap<String, String>>;

/// How long a voice socket may say nothing. A take is a held key, seconds
/// long; a socket silent past this was left open by a page that went away.
const SILENT_FOR: std::time::Duration = std::time::Duration::from_secs(60);

/// `GET /api/voice`: offered, installed, on, fetching, error, warm, bytes.
pub(crate) async fn voice_status(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(app.voice.status()).into_response()
}

/// `POST /api/voice/fetch`: start fetching the helper and the model. Answers
/// at once; `GET /api/voice` says where the fetch has got to and how it ended.
pub(crate) async fn voice_fetch(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let refuse = |why: &str| (StatusCode::CONFLICT, Json(json!({ "error": why }))).into_response();
    if !crate::voice::offered() {
        return refuse("voice is not offered on this system yet");
    }
    let Some(up) = app.update.clone() else {
        return refuse("this snyvi has no updater, so nothing to fetch voice by");
    };
    if app.voice.status()["fetching"].is_string() {
        return refuse("voice is already being fetched");
    }
    tokio::task::spawn_blocking(move || {
        // Its outcome is kept by `Voice` and read back through the status.
        let _ = app.voice.fetch(&up);
    });
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct OnBody {
    on: bool,
}

/// `POST /api/voice/on`: off keeps the downloads and stops the helper.
pub(crate) async fn voice_on(
    State(app): S,
    headers: HeaderMap,
    Query(q): Q,
    Json(b): Json<OnBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.voice.set_on(b.on) {
        Ok(()) => Json(app.voice.status()).into_response(),
        Err(e) => err(e),
    }
}

/// `POST /api/voice/remove`: the downloads gone.
pub(crate) async fn voice_remove(State(app): S, headers: HeaderMap, Query(q): Q) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.voice.remove() {
        Ok(()) => Json(app.voice.status()).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/voice/listen`: the socket a held key speaks over. The same three
/// refusals as the desk socket, for the same reasons (`ws::desk_socket`): the
/// capability is never a query parameter, the handshake comes from snyvi's
/// own page, and nothing is read as sound until a first frame has proved the
/// capability.
pub(crate) async fn voice_socket(
    State(app): S,
    headers: HeaderMap,
    Query(q): Q,
    ws: WebSocketUpgrade,
) -> Response {
    if q.contains_key(crate::desktop::CAPABILITY_KEY) || q.contains_key("capability") {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "the capability is not a query parameter" })),
        )
            .into_response();
    }
    if !from_this_page(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page" })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| voice_session(app, socket))
}

/// What the page says on a voice socket, between its sound.
#[derive(Deserialize)]
#[serde(tag = "t")]
enum Said {
    /// A key went down: a take begins, at this sample rate.
    #[serde(rename = "start")]
    Start { rate: u32 },
    /// The key came up: say what was heard.
    #[serde(rename = "end")]
    End,
}

/// A voice socket from the upgrade to the close: the capability, then takes.
/// A take is `start`, sound as binary frames of f32, `end`; its answer is one
/// text frame, the helper's line or `{"error": …}`.
async fn voice_session(app: Arc<App>, mut socket: WebSocket) {
    let first = tokio::time::timeout(CAPABILITY_DEADLINE, socket.recv()).await;
    let frame = match &first {
        Ok(Some(Ok(Message::Text(t)))) => Some(t.as_str()),
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
    // The helper is started now, while the reader is still speaking: by the
    // time the key comes up it has loaded. A start that fails is found again
    // by the take, which says why.
    let waking = {
        let app = app.clone();
        tokio::task::spawn_blocking(move || app.voice.wake().is_ok())
    };
    let _ = socket
        .send(Message::Text(json!({ "ok": true }).to_string().into()))
        .await;
    let mut waking = Some(waking);
    let mut take: Option<(u32, Vec<u8>)> = None;
    loop {
        let msg = match tokio::time::timeout(SILENT_FOR, socket.recv()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        match msg {
            Message::Binary(b) => {
                // Sound with no take open is dropped, and so is sound past
                // the longest take: the start of a take is where a command is.
                if let Some((_, sound)) = take.as_mut() {
                    let room = crate::voice::LONGEST_TAKE.saturating_sub(sound.len());
                    sound.extend_from_slice(&b[..b.len().min(room)]);
                }
            }
            Message::Text(t) => match serde_json::from_str::<Said>(&t) {
                Ok(Said::Start { rate }) => take = Some((rate, Vec::new())),
                Ok(Said::End) => {
                    let Some((rate, sound)) = take.take() else {
                        continue;
                    };
                    if let Some(w) = waking.take() {
                        let _ = w.await;
                    }
                    let heard = {
                        let app = app.clone();
                        tokio::task::spawn_blocking(move || app.voice.hear(rate, &sound)).await
                    };
                    let line = match heard {
                        Ok(Ok(line)) => line,
                        Ok(Err(e)) => json!({ "error": format!("{e:#}") }),
                        Err(_) => json!({ "error": "the take did not finish" }),
                    };
                    if socket
                        .send(Message::Text(line.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    stop_when_idle(app.clone());
                }
                Err(_) => break,
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
}

/// Look again once `IDLE` has passed, and stop the helper if no take came in
/// between. One sleeping task per take, each of which does nothing unless it
/// is the last.
fn stop_when_idle(app: Arc<App>) {
    tokio::spawn(async move {
        tokio::time::sleep(crate::voice::IDLE + std::time::Duration::from_secs(1)).await;
        let _ = tokio::task::spawn_blocking(move || app.voice.stop_if_idle()).await;
    });
}
