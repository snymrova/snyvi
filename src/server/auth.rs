//! Who may call what. Three leaves, never confused: the write token (an
//! agent's: send, aside, its own panel), the window's capability (a desk,
//! the reader's actions), and the window secret (stop, restart, update,
//! mint). In front of them all, the host gate.

use super::*;

/// The window's capability, on the header it rides.
pub(crate) fn capable(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get(CAPABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| app.capabilities.verify(c.trim()))
}

/// Where the window secret rides: a header, for the reason the capability
/// is one (`CAPABILITY_HEADER`).
pub(crate) const WINDOW_HEADER: &str = "x-snyvi-window";

/// Does this request carry the window secret? The CLI reads it from the
/// daemon's own files (`config::window_secret_path`) for `snyvi stop`,
/// `snyvi restart`, `snyvi update` and `snyvi app`.
pub(crate) fn window_secret_ok(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get(WINDOW_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| constant_eq(s.trim(), &app.window))
}

/// The window's leave: the capability a window holds, or the window secret
/// the CLI reads. What stops, restarts and updates the daemon answers to
/// this and not to the token, so that an agent holding the token -- to send,
/// to tick a note, to name its panel -- holds nothing that starts or ends a
/// process. A tab holds neither.
pub(crate) fn windowed(app: &App, headers: &HeaderMap) -> bool {
    capable(app, headers) || window_secret_ok(app, headers)
}

/// What a request that is not the window's gets.
pub(crate) fn not_windowed() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "not the window, and no window secret" })),
    )
        .into_response()
}

/// A reader's action -- a ✕, a pin, a rename, mark read, Undo -- is taken
/// from this page, which a browser proves with an `Origin` of ours on every
/// POST, or from the CLI with the token. Nothing else: a page on another
/// origin sends its own `Origin`, and a local program that sends none has
/// the token to read if it is the reader's. The sentence if not.
pub(crate) fn refuse_reader(app: &App, headers: &HeaderMap) -> Option<Response> {
    (!from_this_page(headers) && !authorized(app, headers)).then(|| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not from this page, and no token" })),
        )
            .into_response()
    })
}

/// Mint a capability for a window that is opening.
///
/// The window secret is required -- not the token, which an agent holds and
/// which must not reach a desk's panels -- and this is the only endpoint
/// whose answer is itself a secret. The caller is `snyvi app`, in the moment
/// between deciding to open a window and launching one: see
/// `crate::capability` for why the answer is not the token itself, and how
/// it is kept beside the token so a window outlives the daemon.
pub(crate) async fn mint_capability(State(app): S, headers: HeaderMap) -> Response {
    if !window_secret_ok(&app, &headers) {
        return not_windowed();
    }
    match app.capabilities.mint() {
        Ok(capability) => Json(json!({ "capability": capability })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Did this request come from snyvi's own page?
///
/// The first check of its kind in this server, and the reason section 7 of
/// `docs/TERMINAL.md` counts it as new work: until now every endpoint either
/// carried the token or answered with something a foreign page cannot read back
/// anyway. This one is a side effect that arrives from a click.
///
/// It cannot be the token, because the page has none. The token exists so that
/// a random local process cannot inject a document, and putting it into HTML
/// that any local process can `GET` would be the end of that. So the token is
/// accepted -- it is how the CLI and the tests reach this -- and a same-origin
/// POST is accepted beside it.
///
/// `Origin` rather than `Sec-Fetch-Site`: a browser sets `Origin` on every POST,
/// same-origin included, and has done for far longer, so a window whose engine
/// predates fetch metadata still gets the button. Where the newer header is
/// present it is read too, and anything but `same-origin` is refused outright.
/// A page on another origin is refused by both; curl sends neither and needs the
/// token.
pub(crate) fn from_this_page(headers: &HeaderMap) -> bool {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site != "same-origin" {
            return false;
        }
    }
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = config::port();
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| origin == format!("http://{h}:{port}"))
}

/// A read from this page, which carries no `Origin`: a browser sets it on
/// every POST and every cross-origin request, but not on a same-origin GET, so
/// `from_this_page` alone refuses the desk list the window asks for.
///
/// `Host` stands in for it. A page on another origin cannot get here without an
/// `Origin` -- the capability header makes its request a CORS one -- and a page
/// that rebinds its own name to 127.0.0.1 sends that name as `Host`. Where
/// fetch metadata is sent, it has to say `same-origin` as well.
pub(crate) fn same_origin_read(headers: &HeaderMap) -> bool {
    if headers.contains_key(header::ORIGIN) {
        return false;
    }
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site != "same-origin" {
            return false;
        }
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = config::port();
    ["127.0.0.1", "localhost", "[::1]"]
        .iter()
        .any(|h| host == format!("{h}:{port}"))
}

/// What the gate says, and the test reads: a refusal of the host, and one
/// of the origin.
pub(crate) const NOT_THIS_HOST: &str = "not this host";

pub(crate) const NOT_THIS_ORIGIN: &str = "not this origin";

/// Is this request addressed to this daemon, by a page of this daemon's?
///
/// The daemon listens on the loopback and nowhere else, which keeps the
/// network out. It does not keep a browser out: a page on any site can send a
/// request to `http://127.0.0.1:7777`, and a site that points its own name at
/// 127.0.0.1 (DNS rebinding) can then read the answers, since to the browser
/// that is its own origin. The `Host` header is the one thing both leave
/// behind -- the rebound page sends its own name -- so every request is held
/// to a `Host` of ours before any route sees it, and to an `Origin` of ours
/// where one is sent, which a browser does on every POST and every
/// cross-origin request. Fetch metadata, where an engine sends it, has to
/// agree on anything that is not a read: `same-origin` from a page, `none`
/// from the address bar or a link opened from outside. A read is left alone
/// so a link to a document still opens from anywhere.
pub(crate) fn not_this_host(
    headers: &HeaderMap,
    method: &axum::http::Method,
) -> Option<&'static str> {
    let port = config::port();
    let ours = |given: &str, scheme: &str| {
        let given = given.trim().to_ascii_lowercase();
        ["127.0.0.1", "localhost", "[::1]"]
            .iter()
            .any(|h| given == format!("{scheme}{h}:{port}"))
    };
    match headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        Some(h) if ours(h, "") => {}
        _ => return Some(NOT_THIS_HOST),
    }
    if let Some(o) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !ours(o, "http://") {
            return Some(NOT_THIS_ORIGIN);
        }
    }
    if *method != axum::http::Method::GET && *method != axum::http::Method::HEAD {
        if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
            if site != "same-origin" && site != "none" {
                return Some(NOT_THIS_ORIGIN);
            }
        }
    }
    None
}

/// The layer `router` puts in front of every route: `not_this_host`, as a
/// refusal before any handler runs.
pub(crate) async fn host_gate(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if let Some(why) = not_this_host(req.headers(), req.method()) {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": why }))).into_response();
    }
    next.run(req).await
}

/// Where the capability rides on an HTTP request.
///
/// A header, for the reason the socket refuses the query string: a query
/// parameter lands in the request path and so in anything that logs one. A
/// header is the one place a page can put a secret on a `fetch` it composes
/// itself, and `EventSource`'s inability to set one is what kept the window
/// count on a query string -- a count, which grants nothing.
pub(crate) const CAPABILITY_HEADER: &str = "x-snyvi-capability";

/// May this request touch a desk? A sentence if not, and nothing if so.
///
/// Three refusals, the same three the socket makes, in the same order: not the
/// query string, not another page, and not without a live capability. A browser
/// tab gets past none of them, which is the premise the whole feature rests on
/// -- so this takes the capabilities and the request, and no `App`, leaving
/// nothing a forgeable signal could reach it through.
pub(crate) fn desk_refusal(
    caps: &crate::capability::Capabilities,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
) -> Option<&'static str> {
    if q.contains_key(crate::desktop::CAPABILITY_KEY) || q.contains_key("capability") {
        return Some("the capability is not a query parameter");
    }
    if !from_this_page(headers) && !same_origin_read(headers) {
        return Some("not from this page");
    }
    let given = headers
        .get(CAPABILITY_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    (!caps.verify(given)).then_some("no capability")
}

/// The gate as a handler uses it: the refusal, already a response.
pub(crate) fn refuse_desk(
    app: &App,
    headers: &HeaderMap,
    q: &std::collections::HashMap<String, String>,
) -> Option<Response> {
    desk_refusal(&app.capabilities, headers, q)
        .map(|why| (StatusCode::FORBIDDEN, Json(json!({ "error": why }))).into_response())
}

pub(crate) fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let alt = headers
        .get("x-snyvi-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    bearer
        .or(alt)
        .map(|t| constant_eq(t, &app.token.read().unwrap()))
        .unwrap_or(false)
}
