//! The server's tests, with the route table every route must be in.

use super::{
    desk_key, desk_refusal, dir_of, hello_allows, parse_range, Span, Ui, ABOUT_JS, APP_CSS, APP_JS,
    BOOT_JS, BROWSE_JS, DESK_JS, DIFF_JS, FIND_JS, FRAME_JS, GAME_JS, HOME_JS, INDEX_HTML, KEYS_JS,
    LOOK_JS, MENU_JS, MMD_JS, NAV_JS, NOTE_JS, PALETTE_JS, PATHS_JS, PEER_JS, TIP_JS, TOAST_JS,
};
use super::{
    new_app, router, Body, Paths, Router, StatusCode, Store, CAPABILITY_HEADER, NOT_THIS_HOST,
    NOT_THIS_ORIGIN, WINDOW_HEADER,
};
use crate::capability::Capabilities;
use axum::http::{header, HeaderMap, HeaderValue};
use tower::ServiceExt;

/// A file opens the folder it sits in; a folder opens itself.
#[test]
fn a_file_opens_beside_itself() {
    let tmp = crate::store::tempdir::Dir::new("snyvi-reveal");
    let file = tmp.path.join("notes.md");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(dir_of(file), Some(tmp.path.clone()));
    assert_eq!(dir_of(tmp.path.clone()), Some(tmp.path.clone()));
}

/// What a player sends when it seeks, and what it must get back.
#[test]
fn ranges_are_read_the_way_players_send_them() {
    assert_eq!(parse_range("bytes=0-", 1000), Span::Part(0, 999));
    assert_eq!(parse_range("bytes=100-199", 1000), Span::Part(100, 199));
    assert_eq!(
        parse_range("bytes=900-5000", 1000),
        Span::Part(900, 999),
        "clamped to the end"
    );
    assert_eq!(
        parse_range("bytes=-500", 1000),
        Span::Part(500, 999),
        "a suffix"
    );
    assert_eq!(parse_range("bytes=-5000", 1000), Span::Part(0, 999));
    assert_eq!(parse_range("bytes=1000-", 1000), Span::Unsatisfiable);
    assert_eq!(
        parse_range("bytes=0-", 0),
        Span::Unsatisfiable,
        "an empty file"
    );
    assert_eq!(parse_range("bytes=-0", 1000), Span::Unsatisfiable);
    assert_eq!(
        parse_range("bytes=0-1,5-9", 1000),
        Span::Whole,
        "several fall back to all"
    );
    assert_eq!(parse_range("items=0-1", 1000), Span::Whole);
    assert_eq!(parse_range("bytes=9-3", 1000), Span::Whole);
    assert_eq!(parse_range("bytes=x-", 1000), Span::Whole);
}

/// The one decision in this server that stands between a web page and a
/// shell. Every shape that is not a live capability under the key that
/// means it has to be a refusal, including the shapes that look close.
#[test]
fn only_a_frame_carrying_a_live_capability_opens_a_desk() {
    let caps = Capabilities::default();
    let cap = caps.mint().unwrap();

    assert!(hello_allows(
        &caps,
        Some(&format!(r#"{{"capability":"{cap}"}}"#))
    ));

    // Silence until the deadline, which is what a socket opened by
    // something with nothing to present does.
    assert!(!hello_allows(&caps, None));
    // A capability that was never minted, and the empty one.
    assert!(!hello_allows(
        &caps,
        Some(&format!(r#"{{"capability":"{}"}}"#, "b".repeat(64)))
    ));
    assert!(!hello_allows(&caps, Some(r#"{"capability":""}"#)));
    // The right secret under the wrong key is not a hello, and neither is a
    // bare string: the frame has to be the shape the protocol says.
    assert!(!hello_allows(
        &caps,
        Some(&format!(r#"{{"token":"{cap}"}}"#))
    ));
    assert!(!hello_allows(&caps, Some(&format!(r#""{cap}""#))));
    assert!(!hello_allows(&caps, Some("")));
    assert!(!hello_allows(&caps, Some("not json at all")));
}

/// `window=1` is forgeable, so the desk path must never read it. The two
/// window signals were allowed to coexist on exactly this condition: the
/// count answers "how many are reading", the capability answers "may this
/// page run a shell", and the second never consults the first. `EventSource`
/// cannot set a header, which is why the count still rides a query string;
/// this test is what makes that harmless rather than a second way in.
#[test]
fn the_window_count_is_never_consulted_on_the_desk_path() {
    let src = include_str!("ws.rs");
    let from = src
        .find("async fn desk_socket")
        .expect("the desk socket should be in ws.rs");
    let to = src[from..]
        .find("\npub(crate) fn hello_allows")
        .expect("hello_allows follows the socket")
        + from;
    let path = &src[from..to];

    for forgeable in ["has_window", "windows", "is_window", "EventsQ"] {
        assert!(
            !path.contains(forgeable),
            "the desk path reads `{forgeable}`, which a browser tab can forge"
        );
    }
    // And the gate it does go through takes no app at all, so there is
    // nothing for a count to reach it through even by accident.
    assert!(
        src.contains(
            "fn hello_allows(caps: &crate::capability::Capabilities, frame: Option<&str>)"
        ),
        "the desk gate should see a capability and a frame, and nothing else"
    );
}

/// The same three refusals as the socket, on the routes a desk is made
/// and named over. The capability rides in a header because that is the
/// one place a page can put a secret on a request it composes itself --
/// and the query string, where it would be logged, is refused at the place
/// the attempt is made rather than quietly ignored.
#[test]
fn a_desk_route_takes_its_capability_from_a_header_and_nowhere_else() {
    let caps = Capabilities::default();
    let cap = caps.mint().unwrap();
    let none = std::collections::HashMap::new();
    let ours = |cap: &str| {
        let mut h = HeaderMap::new();
        h.insert(
            header::ORIGIN,
            HeaderValue::from_str(&crate::config::base_url()).unwrap(),
        );
        h.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        if !cap.is_empty() {
            h.insert(
                super::CAPABILITY_HEADER,
                HeaderValue::from_str(cap).unwrap(),
            );
        }
        h
    };

    assert_eq!(desk_refusal(&caps, &ours(&cap), &none), None);

    // A page of ours, and no capability: a browser tab, which is the case
    // the whole feature rests on refusing.
    assert_eq!(desk_refusal(&caps, &ours(""), &none), Some("no capability"));
    assert_eq!(
        desk_refusal(&caps, &ours(&"c".repeat(64)), &none),
        Some("no capability")
    );

    // The right secret, in the wrong place.
    let query = std::collections::HashMap::from([("cap".to_string(), cap.clone())]);
    assert_eq!(
        desk_refusal(&caps, &ours(&cap), &query),
        Some("the capability is not a query parameter")
    );
    let query = std::collections::HashMap::from([("capability".to_string(), cap.clone())]);
    assert_eq!(
        desk_refusal(&caps, &ours(&cap), &query),
        Some("the capability is not a query parameter")
    );

    // Another origin, and a local process with no browser at all: neither
    // is this page, whatever it is holding.
    let mut elsewhere = ours(&cap);
    elsewhere.insert(
        header::ORIGIN,
        HeaderValue::from_static("http://evil.example"),
    );
    assert_eq!(
        desk_refusal(&caps, &elsewhere, &none),
        Some("not from this page")
    );
    let mut bare = HeaderMap::new();
    bare.insert(
        super::CAPABILITY_HEADER,
        HeaderValue::from_str(&cap).unwrap(),
    );
    assert_eq!(
        desk_refusal(&caps, &bare, &none),
        Some("not from this page")
    );

    // The window's own GET: a browser sends no `Origin` on a same-origin
    // read, so `Host` is what says it is ours. The live window found this;
    // the desk list was refused and every desk read "No such desk".
    let read = |host: &str, site: Option<&'static str>| {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(s) = site {
            h.insert("sec-fetch-site", HeaderValue::from_static(s));
        }
        h.insert(
            super::CAPABILITY_HEADER,
            HeaderValue::from_str(&cap).unwrap(),
        );
        h
    };
    let here = format!("127.0.0.1:{}", crate::config::port());
    assert_eq!(
        desk_refusal(&caps, &read(&here, Some("same-origin")), &none),
        None
    );
    assert_eq!(desk_refusal(&caps, &read(&here, None), &none), None);
    // A name rebound to 127.0.0.1 is still its own name in `Host`.
    let rebound = format!("evil.example:{}", crate::config::port());
    assert_eq!(
        desk_refusal(&caps, &read(&rebound, Some("same-origin")), &none),
        Some("not from this page")
    );
    assert_eq!(
        desk_refusal(&caps, &read(&here, Some("cross-site")), &none),
        Some("not from this page")
    );
}

/// What a route answers to. `ROUTES` names one for every route, and the
/// test sends each route a request from another host, one with nothing,
/// one with the wrong leave and one with the right one.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Gate {
    /// Anyone on this host: the shell, the assets, the reads.
    Open,
    /// A reader's action: from this page (an `Origin` of ours) or the token.
    Reader,
    /// A desk: this page and a live capability.
    Desk,
    /// An agent in a panel, or what sends: the token.
    Token,
    /// What runs the daemon: the capability or the window secret.
    Window,
    /// The one mint: the window secret alone.
    Mint,
}

/// Method, path, JSON body (none sends no body), gate, and whether the
/// request with the right leave is sent at all. A few routes open a
/// dialog, write a keychain or run a setup; those are asked only to
/// refuse. Ids are made up, so a route let through answers 404 or 400
/// from its handler -- which is the proof the gate came first.
const ROUTES: &[(&str, &str, Option<&str>, Gate, bool)] = &[
    ("GET", "/", None, Gate::Open, true),
    ("GET", "/inbox", None, Gate::Open, true),
    ("GET", "/api/home", None, Gate::Open, true),
    ("GET", "/connect", None, Gate::Open, true),
    ("GET", "/start", None, Gate::Open, true),
    ("GET", "/welcome", None, Gate::Open, true),
    ("GET", "/d/nope", None, Gate::Open, true),
    ("GET", "/b/nope", None, Gate::Open, true),
    ("GET", "/b/nope/x.md", None, Gate::Open, true),
    ("GET", "/files/nope/x.png", None, Gate::Open, true),
    ("GET", "/assets/mermaid.js", None, Gate::Open, true),
    ("GET", "/assets/app.js", None, Gate::Open, true),
    ("GET", "/assets/fonts/x.woff2", None, Gate::Open, true),
    ("GET", "/api/health", None, Gate::Open, true),
    ("GET", "/api/about", None, Gate::Open, true),
    ("GET", "/api/agents", None, Gate::Open, true),
    (
        "POST",
        "/api/agents/claude/connect",
        None,
        Gate::Desk,
        false,
    ),
    ("GET", "/api/tree", None, Gate::Open, true),
    ("GET", "/api/projects/1/tree", None, Gate::Open, true),
    ("GET", "/api/workflows/1/tree", None, Gate::Open, true),
    ("GET", "/api/inbox", None, Gate::Open, true),
    ("GET", "/api/search?q=x", None, Gate::Open, true),
    ("POST", "/api/docs", Some("{}"), Gate::Token, true),
    ("GET", "/api/docs/nope", None, Gate::Open, true),
    (
        "POST",
        "/api/docs/nope/pin",
        Some(r#"{"pinned":true}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/docs/nope/read", None, Gate::Reader, true),
    ("GET", "/api/queue", None, Gate::Open, true),
    ("POST", "/api/layout", Some("{}"), Gate::Reader, true),
    ("POST", "/api/queue/clear", None, Gate::Reader, true),
    (
        "POST",
        "/api/queue/unread",
        Some(r#"{"ids":[]}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/docs/nope/delete", None, Gate::Reader, true),
    ("POST", "/api/docs/nope/undelete", None, Gate::Reader, true),
    ("GET", "/api/removed", None, Gate::Open, true),
    ("GET", "/api/docs/nope/history", None, Gate::Open, true),
    (
        "POST",
        "/api/projects/1/rename",
        Some(r#"{"name":"x"}"#),
        Gate::Reader,
        true,
    ),
    (
        "POST",
        "/api/workflows/1/rename",
        Some(r#"{"name":"x"}"#),
        Gate::Reader,
        true,
    ),
    ("GET", "/api/docs/nope/split", None, Gate::Open, true),
    ("GET", "/api/docs/nope/outline", None, Gate::Open, true),
    ("GET", "/api/notes", None, Gate::Open, true),
    (
        "POST",
        "/api/notes",
        Some(r#"{"text":"x"}"#),
        Gate::Token,
        true,
    ),
    ("POST", "/api/notes/seen", None, Gate::Reader, true),
    (
        "POST",
        "/api/notes/dismiss",
        Some(r#"{"ids":[]}"#),
        Gate::Reader,
        true,
    ),
    (
        "POST",
        "/api/notes/restore",
        Some(r#"{"ids":[]}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/focus", None, Gate::Reader, true),
    ("POST", "/api/shutdown", None, Gate::Window, true),
    ("POST", "/api/restart", Some("{}"), Gate::Window, true),
    ("DELETE", "/api/restart", None, Gate::Window, true),
    (
        "POST",
        "/api/update/check",
        Some(r#"{"lift":false}"#),
        Gate::Window,
        true,
    ),
    (
        "POST",
        "/api/update/auto",
        Some(r#"{"on":false}"#),
        Gate::Window,
        true,
    ),
    ("POST", "/api/update/later", Some("{}"), Gate::Window, true),
    ("GET", "/api/reset", None, Gate::Open, true),
    // 999 documents is never the count there is, so the reset is refused
    // as stale once it is past the gate, and the store stays.
    (
        "POST",
        "/api/reset",
        Some(r#"{"documents":999}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/reveal", Some("{}"), Gate::Reader, true),
    (
        "POST",
        "/api/resolve",
        Some(r#"{"word":"x"}"#),
        Gate::Desk,
        true,
    ),
    ("GET", "/api/browse", None, Gate::Open, true),
    (
        "POST",
        "/api/browse",
        Some(r#"{"path":"."}"#),
        Gate::Token,
        true,
    ),
    ("POST", "/api/browse/pick", None, Gate::Desk, false),
    // With no dialog open, a cancel wakes nothing: safe to let through.
    ("POST", "/api/browse/pick/cancel", None, Gate::Desk, true),
    ("POST", "/api/browse/nope/close", None, Gate::Reader, true),
    ("POST", "/api/browse/nope/reopen", None, Gate::Reader, true),
    ("GET", "/api/browse/nope/tree", None, Gate::Open, true),
    (
        "GET",
        "/api/browse/nope/file?path=x.md",
        None,
        Gate::Open,
        true,
    ),
    (
        "GET",
        "/api/browse/nope/raw?path=x.md",
        None,
        Gate::Open,
        true,
    ),
    ("GET", "/api/browse/nope/raw/x.md", None, Gate::Open, true),
    ("GET", "/api/browse/nope/find?q=x", None, Gate::Open, true),
    (
        "GET",
        "/api/browse/nope/outline?path=x.md",
        None,
        Gate::Open,
        true,
    ),
    ("GET", "/api/docs/nope/raw", None, Gate::Open, true),
    ("GET", "/api/docs/nope/blob", None, Gate::Open, true),
    ("GET", "/api/compare/a/b", None, Gate::Open, true),
    ("GET", "/api/events", None, Gate::Open, true),
    ("POST", "/api/capability", None, Gate::Mint, true),
    // The socket proves itself in its first frame; without an upgrade it
    // is a GET that goes nowhere, and the host gate is what is tested.
    ("GET", "/api/desk", None, Gate::Open, true),
    ("GET", "/api/desks", None, Gate::Desk, true),
    ("POST", "/api/desks", Some("{}"), Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/rename",
        Some(r#"{"name":"x"}"#),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/layout",
        Some(r#"{"col":0.5,"row":0.5}"#),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/move",
        Some(r#"{"from":1,"to":2}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/desks/1/delete", None, Gate::Desk, true),
    ("POST", "/api/desks/1/reopen", None, Gate::Desk, true),
    ("POST", "/api/desks/1/panes", Some("{}"), Gate::Desk, true),
    ("GET", "/api/desks/1/docs", None, Gate::Desk, true),
    ("POST", "/api/desks/1/docs/d/remove", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/docs/d/restore",
        None,
        Gate::Desk,
        true,
    ),
    ("GET", "/api/desks/1/notes", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/notes",
        Some(r#"{"text":"x"}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/desks/1/notes/1", Some("{}"), Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/notes/1/remove",
        None,
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/notes/1/restore",
        None,
        Gate::Desk,
        true,
    ),
    ("POST", "/api/desks/1/notes/1/keep", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/leftoff",
        Some(r#"{"text":"x","at":0}"#),
        Gate::Desk,
        true,
    ),
    ("GET", "/api/desks/1/keys", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/keys",
        Some(r#"{"name":"X_KEY","value":"y"}"#),
        Gate::Desk,
        false,
    ),
    (
        "POST",
        "/api/desks/1/keys/X_KEY/remove",
        Some("{}"),
        Gate::Desk,
        false,
    ),
    ("POST", "/api/desks/1/visit", None, Gate::Desk, true),
    ("GET", "/api/desks/1/git", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/order",
        Some(r#"{"ids":[1]}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/desks/1/park", Some("{}"), Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/week",
        Some(r#"{"title":"t","content":"c"}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/desks/1/notes/1/image", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/notes/1/images",
        Some(r#"{"images":[]}"#),
        Gate::Desk,
        true,
    ),
    (
        "GET",
        "/api/desks/1/note-images/x.png",
        None,
        Gate::Desk,
        true,
    ),
    // Friends. Pair and join are asked only to refuse: let through, they
    // mint a key into the keychain and open a room at the relay.
    ("GET", "/api/peers", None, Gate::Open, true),
    ("POST", "/api/peers/pair", Some("{}"), Gate::Reader, false),
    ("POST", "/api/peers/join", Some("{}"), Gate::Reader, false),
    ("GET", "/api/peers/pair/nope", None, Gate::Open, true),
    (
        "POST",
        "/api/peers/1/rename",
        Some(r#"{"name":"x"}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/peers/1/mute", Some("{}"), Gate::Reader, true),
    ("POST", "/api/peers/1/remove", None, Gate::Reader, true),
    ("POST", "/api/peers/1/restore", None, Gate::Reader, true),
    (
        "POST",
        "/api/peers/1/note",
        Some(r#"{"text":"x"}"#),
        Gate::Reader,
        true,
    ),
    ("POST", "/api/peers/notes/1", Some("{}"), Gate::Reader, true),
    (
        "POST",
        "/api/peers/offers/1",
        Some("{}"),
        Gate::Reader,
        true,
    ),
    (
        "POST",
        "/api/docs/nope/send",
        Some("{}"),
        Gate::Reader,
        true,
    ),
    // Where a friend's things land, and a friend's document kept on a desk
    // and saved into its folder: the window's, as a desk is.
    (
        "POST",
        "/api/peers/1/desk",
        Some(r#"{"desk":0}"#),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/docs/nope/keep",
        Some(r#"{"desk":1}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/docs/nope/save", None, Gate::Desk, true),
    // A friend's document back under their row, and a frame tried again:
    // the reader's, from a tab as well as the window.
    ("POST", "/api/docs/nope/unfile", None, Gate::Reader, true),
    (
        "POST",
        "/api/peers/outbox/nope/retry",
        None,
        Gate::Reader,
        true,
    ),
    // 1.23: a reply under a friend's document, whether a friend hears of a
    // read, and Tell Trapti ✓ on a line she sent: the reader's.
    (
        "POST",
        "/api/docs/nope/reply",
        Some(r#"{"text":"thanks"}"#),
        Gate::Reader,
        true,
    ),
    (
        "POST",
        "/api/peers/1/receipts",
        Some(r#"{"on":true}"#),
        Gate::Reader,
        true,
    ),
    (
        "POST",
        "/api/desks/1/notes/1/tell",
        None,
        Gate::Reader,
        true,
    ),
    ("GET", "/api/brief", None, Gate::Desk, true),
    (
        "POST",
        "/api/brief",
        Some(r#"{"on":true}"#),
        Gate::Desk,
        true,
    ),
    ("GET", "/api/asides", None, Gate::Desk, true),
    (
        "POST",
        "/api/asides",
        Some(r#"{"on":true}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/panes/nope/delete", None, Gate::Desk, true),
    ("POST", "/api/panes/nope/restore", None, Gate::Desk, true),
    (
        "POST",
        "/api/panes/nope/rename",
        Some(r#"{"name":"x"}"#),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/start",
        Some(r#"{"cols":80,"rows":24}"#),
        Gate::Desk,
        true,
    ),
    ("POST", "/api/panes/nope/stop", None, Gate::Desk, true),
    (
        "POST",
        "/api/panes/nope/agent",
        Some("{}"),
        Gate::Token,
        true,
    ),
    ("GET", "/api/panes/nope/notes", None, Gate::Token, true),
    (
        "POST",
        "/api/panes/nope/notes/1/tick",
        None,
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/notes/1/mark",
        None,
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/name",
        Some(r#"{"name":"x"}"#),
        Gate::Token,
        true,
    ),
    ("GET", "/api/panes/nope/brief", None, Gate::Token, true),
    ("GET", "/api/panes/nope/changes", None, Gate::Token, true),
    (
        "GET",
        "/api/panes/nope/keys/GH_TOKEN",
        None,
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/leftoff",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/suggest",
        Some("{}"),
        Gate::Token,
        true,
    ),
    ("POST", "/api/panes/nope/paste", None, Gate::Desk, true),
    (
        "POST",
        "/api/panes/nope/offer",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/thread",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/thread/move",
        Some("{}"),
        Gate::Token,
        true,
    ),
    ("POST", "/api/panes/nope/ask", Some("{}"), Gate::Token, true),
    (
        "POST",
        "/api/panes/nope/handover",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/suggest-panel",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/suggest-desk",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/seen",
        Some("{}"),
        Gate::Token,
        true,
    ),
    ("GET", "/api/panes/nope/band", None, Gate::Token, true),
    ("GET", "/api/panes/nope/turns/1", None, Gate::Token, true),
    (
        "POST",
        "/api/panes/nope/turns/1",
        Some("{}"),
        Gate::Token,
        true,
    ),
    (
        "POST",
        "/api/panes/nope/note",
        Some("{}"),
        Gate::Token,
        true,
    ),
    ("GET", "/api/desks/1/threads", None, Gate::Desk, true),
    (
        "POST",
        "/api/desks/1/threads/1/move",
        Some("{}"),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/threads/1/remove",
        None,
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/turns/1/answer",
        Some("{}"),
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/turns/1/remove",
        None,
        Gate::Desk,
        true,
    ),
    (
        "POST",
        "/api/desks/1/suggestions/1/open",
        None,
        Gate::Desk,
        true,
    ),
    ("GET", "/api/claude-mod", None, Gate::Desk, true),
    (
        "POST",
        "/api/claude-mod",
        Some(r#"{"on":true}"#),
        Gate::Desk,
        true,
    ),
    ("GET", "/desks", None, Gate::Open, true),
    ("GET", "/desk/1", None, Gate::Open, true),
];

/// One request to the router, without a port. Only a refusal's body is
/// read: an event stream never ends.
async fn ask(
    router: &Router,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut req = axum::http::Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = match body {
        Some(b) => req
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let text = if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
        let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        String::new()
    };
    (status, text)
}

/// Every leave there is, for one router: the host and origin it answers
/// to, the agent's token, a minted capability and the window's secret.
struct Leaves {
    host: String,
    origin: String,
    bearer: String,
    cap: String,
    window: String,
}

/// The router against a store in a temp dir, kept alive by the `Dir`.
fn gated_router(name: &str) -> (crate::store::tempdir::Dir, Router, Leaves) {
    gated_router_with(name, |_| {})
}

/// The same, with the store set up first: desks, panes, whatever the test is about.
fn gated_router_with(
    name: &str,
    prep: impl FnOnce(&Store),
) -> (crate::store::tempdir::Dir, Router, Leaves) {
    let tmp = crate::store::tempdir::Dir::new(name);
    let paths = Paths {
        data_dir: tmp.path.join("data"),
        config_dir: tmp.path.join("config"),
        docs_dir: tmp.path.join("data").join("docs"),
        db_path: tmp.path.join("data").join("snyvi.db"),
        token_path: tmp.path.join("config").join("token"),
    };
    let token = crate::config::load_or_create_token(&paths).unwrap();
    let window = crate::config::load_or_create_window_secret(&paths).unwrap();
    assert_ne!(token, window, "two secrets, two jobs");
    let store = Store::open(&paths).unwrap();
    prep(&store);
    let app = new_app(&paths, store, token.clone(), window.clone(), None, None);
    let cap = app.capabilities.mint().unwrap();
    let host = format!("127.0.0.1:{}", crate::config::port());
    let leaves = Leaves {
        origin: format!("http://{host}"),
        host,
        bearer: format!("Bearer {token}"),
        cap,
        window,
    };
    (tmp, router(app), leaves)
}

/// A gate helps only if every route is behind it, and a route added later
/// is exactly the one that will forget. So the router is built against a
/// store in a temp dir and every route is sent four requests: the count
/// of routes in `router()` has to match the table, so a new route must
/// say what it answers to before the build is green.
#[tokio::test]
async fn every_route_answers_to_its_gate_and_to_this_host_only() {
    let (_tmp, router, leaves) = gated_router("snyvi-routes");

    // The table is the router. Git on Windows checks this file out with CRLF.
    // `router`, the panels' and the friends' routes it merges, and the
    // receive route it builds apart for its body limit.
    let src = include_str!("mod.rs").replace("\r\n", "\n");
    let routes_in = |name: &str| {
        let routed = &src[src.find(name).unwrap()..];
        let routed = &routed[..routed.find("\n}\n").unwrap()];
        routed.matches("get(").count()
            + routed.matches("post(").count()
            + routed.matches(".delete(").count()
    };
    let n = routes_in("\nfn router(")
        + routes_in("\nfn pane_routes(")
        + routes_in("\nfn peer_routes(")
        + routes_in("\nfn thread_routes(")
        + routes_in("\nfn widget_routes(")
        + routes_in("\nfn receive_route(");
    assert_eq!(
        n,
        ROUTES.len(),
        "every route is in ROUTES, and nothing else is"
    );
    for &route in ROUTES {
        answers_to_its_gate(&router, &leaves, route).await;
    }
}

/// One row of ROUTES, sent from another host, another origin, with nothing,
/// with the wrong leave and with each right one.
async fn answers_to_its_gate(
    router: &Router,
    l: &Leaves,
    (method, path, body, gate, go): (&str, &str, Option<&str>, Gate, bool),
) {
    let (host, origin, bearer, cap, window) = (
        l.host.as_str(),
        l.origin.as_str(),
        l.bearer.as_str(),
        l.cap.as_str(),
        l.window.as_str(),
    );
    let router = router.clone();
    let refused = |s: StatusCode| s == StatusCode::UNAUTHORIZED || s == StatusCode::FORBIDDEN;
    let what = format!("{method} {path}");
    // From another host, with every leave there is: refused before any
    // handler, by the gate and not by a route.
    let (s, t) = ask(
        &router,
        method,
        path,
        body,
        &[
            ("host", "evil.example:7777"),
            ("authorization", bearer),
            (CAPABILITY_HEADER, cap),
            (WINDOW_HEADER, window),
        ],
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "{what}: another host");
    assert!(
        t.contains(NOT_THIS_HOST),
        "{what}: the gate refuses another host, not a handler: {t}"
    );
    // Our host, a stranger's Origin: a page elsewhere, or a rebound name.
    let (s, t) = ask(
        &router,
        method,
        path,
        body,
        &[
            ("host", host),
            ("origin", "http://evil.example"),
            ("authorization", bearer),
        ],
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "{what}: another origin");
    assert!(
        t.contains(NOT_THIS_ORIGIN),
        "{what}: the gate refuses another origin: {t}"
    );
    // Nothing but the host.
    let (bare, _) = ask(&router, method, path, body, &[("host", host)]).await;
    if gate == Gate::Open {
        assert!(!refused(bare), "{what}: open, but {bare}");
        return;
    }
    assert!(refused(bare), "{what}: nothing offered, but {bare}");
    // The wrong leave: a capability where the token is wanted, the
    // token where the window's leave is, a capability with no page
    // behind it where the page is.
    let wrong: Vec<(&str, &str)> = match gate {
        Gate::Token => vec![("host", host), ("origin", origin), (CAPABILITY_HEADER, cap)],
        Gate::Window | Gate::Mint => vec![("host", host), ("authorization", bearer)],
        Gate::Desk => vec![
            ("host", host),
            ("origin", origin),
            ("authorization", bearer),
        ],
        Gate::Reader => vec![("host", host), (CAPABILITY_HEADER, cap)],
        Gate::Open => unreachable!(),
    };
    let (s, _) = ask(&router, method, path, body, &wrong).await;
    assert!(refused(s), "{what}: the wrong leave let through: {s}");
    if gate == Gate::Mint {
        let (s, _) = ask(
            &router,
            method,
            path,
            body,
            &[("host", host), (CAPABILITY_HEADER, cap)],
        )
        .await;
        assert!(refused(s), "{what}: a capability mints nothing");
    }
    if !go {
        return;
    }
    // The right leave, each there is.
    let rights: Vec<Vec<(&str, &str)>> = match gate {
        Gate::Reader => vec![
            vec![("host", host), ("origin", origin)],
            vec![("host", host), ("authorization", bearer)],
        ],
        Gate::Desk => vec![vec![
            ("host", host),
            ("origin", origin),
            (CAPABILITY_HEADER, cap),
        ]],
        Gate::Token => vec![vec![("host", host), ("authorization", bearer)]],
        Gate::Window => vec![
            vec![("host", host), (WINDOW_HEADER, window)],
            vec![("host", host), ("origin", origin), (CAPABILITY_HEADER, cap)],
        ],
        Gate::Mint => vec![vec![("host", host), (WINDOW_HEADER, window)]],
        Gate::Open => unreachable!(),
    };
    for h in rights {
        let (s, t) = ask(&router, method, path, body, &h).await;
        assert!(!refused(s), "{what}: refused with the right leave: {s} {t}");
    }
}

#[tokio::test]
async fn a_write_from_another_site_is_refused_and_a_read_from_the_address_bar_is_not() {
    let (_tmp, router, l) = gated_router("snyvi-fetch-site");
    let port = crate::config::port();
    let (host, origin) = (l.host.as_str(), l.origin.as_str());
    // Fetch metadata that says the request came from another site is
    // refused on anything that is not a read, whatever else it carries.
    let (s, t) = ask(
        &router,
        "POST",
        "/api/focus",
        None,
        &[
            ("host", host),
            ("origin", origin),
            ("sec-fetch-site", "cross-site"),
        ],
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(t.contains(NOT_THIS_ORIGIN));
    // And a read from the address bar is not.
    let (s, _) = ask(
        &router,
        "GET",
        "/api/health",
        None,
        &[("host", host), ("sec-fetch-site", "none")],
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = ask(
        &router,
        "GET",
        "/api/health",
        None,
        &[("host", format!("localhost:{port}").as_str())],
    )
    .await;
    assert_eq!(s, StatusCode::OK, "localhost is this host too");
}

/// The capability is read off the fragment and presented in a frame. If it
/// ever reaches a URL the page builds, it reaches the daemon's request path
/// and whatever logs one -- so the page's own source is where that line is
/// held.
#[test]
fn the_page_never_puts_the_capability_in_a_url() {
    assert!(
        APP_JS.contains("/api/desk"),
        "the desk socket should be opened from here"
    );
    for (name, src) in [("app.js", APP_JS), ("desk.js", DESK_JS)] {
        for bad in ["cap=${", "capability=${", "?cap=", "&cap=", "?capability="] {
            assert!(
                !src.contains(bad),
                "the capability is in a URL in {name}: {bad}"
            );
        }
    }
}

/// The desk view is the second chunk, and its bargain is the diagram
/// driver's: one import, made when a desk is opened -- and only past the
/// point where a tab has been given its sentence and sent away, so a page
/// with no capability never fetches the code that paints a pane.
#[test]
fn the_page_asks_for_the_desk_view_only_in_a_window_opening_a_desk() {
    assert_eq!(APP_JS.matches("import(`/assets/desk.js").count(), 1);
    let import = APP_JS.find("import(`/assets/desk.js").unwrap();
    let sentence = APP_JS
        .find("This is a browser tab, and a browser tab cannot start one")
        .expect("a tab is told why there is no desk");
    let refusal = APP_JS[..sentence]
        .rfind("if (!capability)")
        .expect("the sentence is what a page without the capability gets");
    assert!(refusal < import, "the import sits past the tab's refusal");
    assert!(sentence < import);
    for seam in [
        "export function open(",
        "export function update(",
        "export function close(",
    ] {
        assert!(DESK_JS.contains(seam), "desk.js should export `{seam}`");
    }
}

/// The game is the fourth chunk, and the smallest bargain of them: one
/// import, in the rocket's click handler and nowhere else, so a page
/// whose rocket is never pressed never fetches a game.
#[test]
fn the_page_asks_for_the_game_only_when_the_rocket_is_pressed() {
    assert_eq!(APP_JS.matches("import(`/assets/game.js").count(), 1);
    let import = APP_JS.find("import(`/assets/game.js").unwrap();
    let press = APP_JS
        .find(r##"$("#btn-game")"##)
        .expect("the rocket is the button the game is behind");
    assert!(press < import, "the import sits inside the rocket's press");
    for seam in [
        "export function open(",
        "export function close(",
        "export function isOpen(",
    ] {
        assert!(GAME_JS.contains(seam), "game.js should export `{seam}`");
    }
}

/// The fifth chunk, and the one the budget was over by: the about panel
/// and the reset dialog. Two buttons, one import, and a page that opens
/// neither never fetches either. `bench/bytes.mjs` is what noticed they
/// were being carried by every first paint.
#[test]
fn the_page_asks_for_the_panels_only_when_one_is_opened() {
    assert_eq!(APP_JS.matches("import(`/assets/about.js").count(), 1);
    // Since 1.8 the two buttons are in the shortcuts card, which the
    // chunk builds and wires when it first opens: the page has neither.
    for button in [r##"on("#btn-about""##, r##"on("#btn-reset""##] {
        assert!(
            ABOUT_JS.contains(button),
            "{button} is wired where the card is built"
        );
    }
    for button in [r##"$("#btn-about")"##, r##"$("#btn-reset")"##] {
        assert!(
            !APP_JS.contains(button),
            "{button} belongs to the chunk now"
        );
    }
    assert!(
        ABOUT_JS.contains("export function open("),
        "about.js should export `open`"
    );
    // The panels themselves must not have stayed behind in the page.
    for gone in ["/api/about", "#about-facts", "#reset-go"] {
        assert!(
            !APP_JS.contains(gone),
            "`{gone}` belongs to the chunk now, not to app.js"
        );
    }
}

/// The driver is a chunk, and the page's half of that bargain is that it
/// asks for the chunk only when a document actually holds a diagram. An
/// import that escaped that check would be eager again -- 11.6 KB gzipped
/// back on every page load, for a feature most documents do not use, and
/// nothing would say so but `bench/bytes.mjs` on the next push.
#[test]
fn the_page_asks_for_the_diagram_driver_only_when_a_document_holds_one() {
    assert_eq!(
        APP_JS.matches("import(`/assets/mmd.js").count(),
        1,
        "one import, so there is one place the laziness can be lost"
    );
    assert!(
        APP_JS.contains(r#"if (docEl.querySelector("pre.mermaid")) mmdLoad()"#),
        "the import should sit behind the check for a diagram in this document"
    );
    // The machinery itself must not have found its way back into the page.
    for gone in [
        "mermaid.run",
        "mermaidLib",
        "mmdRender",
        "mmdReserve",
        "mmdDrain",
        "mmdQueue",
    ] {
        assert!(!APP_JS.contains(gone), "`{gone}` is back in app.js");
    }
    // And the module is what holds it, behind the four names the page knows.
    for kept in [
        "export function prepare(",
        "export function retheme(",
        "export function escape(",
        "export function key(",
    ] {
        assert!(MMD_JS.contains(kept), "mmd.js should export `{kept}`");
    }
}

/// The dev loop's whole promise is that the file on disk is the one being
/// served, and its whole safety is that a daemon without `SNYVI_UI_DIR`
/// cannot be made to read one. Both halves, plus the fallback that keeps a
/// page rendering while an editor has the file renamed out from under it.
#[test]
fn a_live_ui_serves_the_file_on_disk_and_a_shipped_one_cannot() {
    let dir = std::env::temp_dir().join(format!("snyvi-ui-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let css = dir.join("app.css");
    std::fs::write(&css, "body { --probe: 1 }").unwrap();

    let live = Ui {
        dir: Some(dir.clone()),
    };
    assert_eq!(live.text("app.css", APP_CSS), "body { --probe: 1 }");
    assert!(live.live());
    // A different file on disk is a different bundle, which is what makes
    // an open page reload without the daemon restarting.
    let before = live.version("shipped");
    std::fs::write(&css, "body { --probe: 2 }").unwrap();
    assert_ne!(live.version("shipped"), before);
    // Gone mid-edit: the compiled-in copy, not an empty stylesheet.
    std::fs::remove_file(&css).unwrap();
    assert_eq!(live.text("app.css", APP_CSS), APP_CSS);

    let shipped = Ui { dir: None };
    assert!(!shipped.live());
    assert_eq!(shipped.text("app.css", APP_CSS), APP_CSS);
    assert_eq!(shipped.version("shipped"), "shipped");
    std::fs::remove_dir_all(&dir).ok();
}

/// `$("#btn-wrap").addEventListener` on an element that is not in the page throws on
/// boot and takes the whole UI with it, so every id the script uses without checking
/// first must exist in the markup. A guarded `const x = $("#id"); if (x)` is fine.
///
/// Every chunk and not only `app.js`: the panels, the find bar and the game
/// were moved out of the first paint, and an id one of them reaches for is
/// no longer caught at boot -- it throws when the chunk loads, which is
/// later, and in front of someone.
#[test]
fn every_id_the_script_uses_unguarded_is_in_the_page() {
    let mut missing = Vec::new();
    for (file, src) in [
        ("app.js", APP_JS),
        ("desk.js", DESK_JS),
        ("frame.js", FRAME_JS),
        ("game.js", GAME_JS),
        ("about.js", ABOUT_JS),
        ("find.js", FIND_JS),
        ("keys.js", KEYS_JS),
        ("menu.js", MENU_JS),
        ("palette.js", PALETTE_JS),
        ("look.js", LOOK_JS),
        ("nav.js", NAV_JS),
        ("note.js", NOTE_JS),
        ("tip.js", TIP_JS),
        ("home.js", HOME_JS),
        ("peer.js", PEER_JS),
        ("toast.js", TOAST_JS),
        ("diff.js", DIFF_JS),
        ("browse.js", BROWSE_JS),
        ("paths.js", PATHS_JS),
    ] {
        for (i, _) in src.match_indices("$(\"#") {
            let rest = &src[i + 4..];
            let end = rest.find('"').expect("unterminated selector");
            let id = &rest[..end];
            let used_at_once = rest[end..].starts_with("\").");
            // Or in the chunk itself: about.js builds the boxes it fills.
            let built = format!("id=\"{id}\"");
            if used_at_once && !INDEX_HTML.contains(&built) && !src.contains(&built) {
                missing.push(format!("{file}: {id}"));
            }
        }
    }
    assert!(missing.is_empty(), "not in index.html: {missing:?}");
}

/// Every chunk the page can fetch under `?v=` is in the hash that makes
/// `v`, or a browser keeps a stale copy across an upgrade. The hash walks
/// `ASSETS`, so what this holds is that `ASSETS` names every text asset in
/// `ui/`: a file added there and not to the table is neither served nor
/// hashed, and this is where that is caught rather than in a browser.
#[test]
fn the_hash_behind_the_version_covers_every_chunk_the_page_can_fetch() {
    let src = include_str!("mod.rs");
    let from = src.find("let asset_v = {").expect("the startup hash");
    let to = from + src[from..].find("\n    };").expect("the end of it");
    let block = &src[from..to];
    assert!(
        block.contains("INDEX_HTML"),
        "the page itself is in the hash"
    );
    assert!(block.contains("in ASSETS"), "the hash walks ASSETS");
    assert!(
        block.contains("MERMAID_JS_GZ"),
        "the diagram bundle is in the hash"
    );

    let ui = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/ui"));
    let mut on_disk: Vec<String> = std::fs::read_dir(ui)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            if p.is_dir() && name != "fonts" && !ui.join(format!("{name}.js")).exists() {
                // A script kept as parts: served under the directory's name.
                return Some(format!("{name}.js"));
            }
            (name.ends_with(".js") || name.ends_with(".css")).then_some(name)
        })
        .collect();
    on_disk.sort();
    let mut named: Vec<String> = super::assets::ASSETS
        .iter()
        .map(|(n, _, _)| n.to_string())
        .collect();
    named.sort();
    assert_eq!(
        on_disk, named,
        "every .js and .css in ui/ is in ASSETS, and nothing else is"
    );
}

/// A name is drawn on one line in the tree, and it arrives from a field a paste can
/// fill with anything.
#[test]
fn a_name_is_cleaned_before_it_is_stored() {
    use super::clean_name;
    assert_eq!(clean_name("  Auth work  ").unwrap(), "Auth work");
    assert_eq!(clean_name("Auth\n\twork").unwrap(), "Auth work");
    assert_eq!(clean_name("Auth   work").unwrap(), "Auth work");
    assert!(clean_name("").is_none());
    assert!(clean_name("   \n ").is_none(), "whitespace is not a name");
    // Counted in characters, so a multi-byte name is not cut mid-character.
    let long = "é".repeat(400);
    assert_eq!(clean_name(&long).unwrap().chars().count(), 120);
}

/// The pre-paint script and the app must agree on the keys, or a saved setting is
/// written by one and never read by the other. The app's half is app.js, or
/// look.js for the theme and font, which it fetches once the page is idle. The
/// three theme keys are spelled out in full: this is a substring check, and
/// `snyvi.theme` would go on passing on the strength of `snyvi.theme.light` alone.
#[test]
fn settings_written_by_the_app_are_applied_before_first_paint() {
    for key in [
        "theme.light",
        "theme.dark",
        "theme.follow",
        "font",
        "side",
        "wide",
        "wrap",
    ] {
        let k = format!("snyvi.{key}");
        assert!(
            APP_JS.contains(&k) || LOOK_JS.contains(&k),
            "{k} is not used by app.js or look.js"
        );
        assert!(BOOT_JS.contains(&k), "{k} is not applied by boot.js");
    }
}

/// `snyvi key NAME` answers with the value of a key the pane's desk has --
/// its own, or the every-desk one, its own first -- marks it used, and
/// refuses another desk's, a name that is not one, and a key whose value is
/// gone, saying so by name only.
#[test]
fn a_panel_reads_its_own_desks_keys_and_no_other_desks() {
    let tmp = crate::store::tempdir::Dir::new("snyvi-pane-key");
    let paths = Paths {
        data_dir: tmp.path.join("data"),
        config_dir: tmp.path.join("config"),
        docs_dir: tmp.path.join("data").join("docs"),
        db_path: tmp.path.join("data").join("snyvi.db"),
        token_path: tmp.path.join("config").join("token"),
    };
    let store = Store::open(&paths).unwrap();
    let secrets = crate::secrets::Secrets::file_only(tmp.path.join("keys.json"));
    let a = store.create_desk("/tmp/a", Some("a")).unwrap().id;
    let b = store.create_desk("/tmp/b", Some("b")).unwrap().id;
    let every = crate::desk::EVERY_DESK;
    for (desk, name, value) in [
        (a, "ELEVENLABS_API_KEY", "a-eleven"),
        (b, "OTHER_KEY", "b-other"),
        (every, "GH_TOKEN", "every-gh"),
        (a, "GH_TOKEN", "a-gh"),
        (every, "OPENAI_API_KEY", "every-openai"),
    ] {
        store.add_desk_key(desk, name, "").unwrap();
        secrets.keep(desk, name, value).unwrap();
    }

    assert_eq!(
        desk_key(&store, &secrets, a, "ELEVENLABS_API_KEY").unwrap(),
        "a-eleven"
    );
    assert_eq!(
        desk_key(&store, &secrets, a, "GH_TOKEN").unwrap(),
        "a-gh",
        "its own first"
    );
    assert_eq!(
        desk_key(&store, &secrets, b, "GH_TOKEN").unwrap(),
        "every-gh"
    );
    assert_eq!(
        desk_key(&store, &secrets, a, "OPENAI_API_KEY").unwrap(),
        "every-openai"
    );
    assert!(
        store
            .desk_keys(a)
            .unwrap()
            .iter()
            .any(|k| k.name == "ELEVENLABS_API_KEY" && k.used_at > 0),
        "a read marks the key used"
    );

    let (s, why) = desk_key(&store, &secrets, a, "OTHER_KEY").unwrap_err();
    assert_eq!(s, StatusCode::NOT_FOUND, "another desk's key");
    assert!(
        why.contains("OTHER_KEY") && !why.contains("b-other"),
        "{why}"
    );
    let (s, _) = desk_key(&store, &secrets, a, "lower; rm").unwrap_err();
    assert_eq!(s, StatusCode::BAD_REQUEST, "not a name");
    secrets.forget(a, "ELEVENLABS_API_KEY");
    let (s, why) = desk_key(&store, &secrets, a, "ELEVENLABS_API_KEY").unwrap_err();
    assert_eq!(s, StatusCode::NOT_FOUND, "a name whose value is gone");
    assert!(why.contains("add it again"), "{why}");
}

/// A video beside a sent document plays from `/files/`: a range at a time,
/// so it can seek. The folder's bounds and the kinds it serves stay as they
/// were: a file of another kind, or one outside the project, is refused.
#[tokio::test]
async fn a_video_beside_a_document_streams_by_range_and_nothing_else_does() {
    let tmp = crate::store::tempdir::Dir::new("snyvi-doc-media");
    let paths = Paths {
        data_dir: tmp.path.join("data"),
        config_dir: tmp.path.join("config"),
        docs_dir: tmp.path.join("data").join("docs"),
        db_path: tmp.path.join("data").join("snyvi.db"),
        token_path: tmp.path.join("config").join("token"),
    };
    let proj = tmp.path.join("proj");
    std::fs::create_dir_all(proj.join(".git")).unwrap();
    let take: Vec<u8> = (0..100u8).collect();
    std::fs::write(proj.join("take.mp4"), &take).unwrap();
    std::fs::write(proj.join("notes.txt"), "not for the page").unwrap();
    std::fs::write(tmp.path.join("outside.mp4"), &take).unwrap();
    let plan = proj.join("plan.md");
    std::fs::write(&plan, "![take](take.mp4)").unwrap();
    let plan = plan.to_string_lossy().to_string();

    let token = crate::config::load_or_create_token(&paths).unwrap();
    let window = crate::config::load_or_create_window_secret(&paths).unwrap();
    let store = Store::open(&paths).unwrap();
    let doc = store
        .insert(
            "abcdef0123",
            crate::store::NewDoc {
                project_root: &proj.to_string_lossy(),
                project_name: "proj",
                workflow_key: "w",
                workflow_title: "w",
                title: "plan",
                kind: crate::render::Kind::Markdown,
                lang: None,
                source_path: Some(&plan),
                branch: None,
                origin: "cli",
                sender: "",
                desk: None,
                source: b"![take](take.mp4)",
                staged: None,
                search_body: "",
                html: "",
            },
        )
        .unwrap();
    let router = router(new_app(&paths, store, token, window, None, None));
    let host = format!("127.0.0.1:{}", crate::config::port());
    let get = |path: String, range: Option<&'static str>| {
        let router = router.clone();
        let host = host.clone();
        async move {
            let mut req = axum::http::Request::builder()
                .uri(path)
                .header("host", host);
            if let Some(r) = range {
                req = req.header("range", r);
            }
            let resp = router
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let status = resp.status();
            let headers = resp.headers().clone();
            let body = axum::body::to_bytes(resp.into_body(), 1 << 20)
                .await
                .unwrap();
            (status, headers, body)
        }
    };

    let id = &doc.id;
    let (s, h, body) = get(format!("/files/{id}/take.mp4"), Some("bytes=10-19")).await;
    assert_eq!(s, StatusCode::PARTIAL_CONTENT);
    assert_eq!(&body[..], &take[10..20]);
    assert_eq!(h[header::CONTENT_RANGE], "bytes 10-19/100");
    assert_eq!(h[header::CONTENT_TYPE], "video/mp4");
    let (s, _, body) = get(format!("/files/{id}/take.mp4"), None).await;
    assert_eq!((s, body.len()), (StatusCode::OK, 100));

    let (s, _, _) = get(format!("/files/{id}/notes.txt"), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "not a picture, a video or a song");
    let (s, _, _) = get(format!("/files/{id}/../outside.mp4"), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "outside the project");
}

/// A send bigger than axum's 2 MB default reaches `receive` and is refused
/// by the cap that is actually snyvi's, with its reason: an agent that sends
/// too much is told how much is too much, not handed a bare 413.
#[tokio::test]
async fn an_oversize_send_is_refused_with_its_size_not_a_bare_413() {
    let (_tmp, router, leaves) = gated_router("snyvi-oversize");
    let content = "x".repeat(crate::receive::MAX_BYTES + 1);
    let body =
        serde_json::to_string(&serde_json::json!({ "content": content, "title": "Too much" }))
            .unwrap();
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/docs")
        .header("host", &leaves.host)
        .header("origin", &leaves.origin)
        .header("authorization", &leaves.bearer)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("larger than 32 MB"), "{text}");
}

/// An aside sent from a panel carries the desk and slot it came from, so a
/// click on it goes there. A pane snyvi does not know -- closed, or made up --
/// is no reason to refuse it: the token is the gate, the pane only the way back.
#[tokio::test]
async fn an_aside_from_a_panel_says_which_and_one_from_nowhere_is_still_taken() {
    let pane = std::sync::Mutex::new(String::new());
    let (_tmp, router, leaves) = gated_router_with("snyvi-aside-from", |store| {
        let desk = store.create_desk("/tmp/ledger", Some("ledger")).unwrap();
        for _ in 0..2 {
            if let crate::desk::Opened::Pane(p) =
                store.open_pane(desk.id, "/tmp/ledger", "").unwrap()
            {
                *pane.lock().unwrap() = p.id;
            }
        }
    });
    let pane = pane.into_inner().unwrap();
    let send = |body: serde_json::Value| {
        axum::http::Request::builder()
            .method("POST")
            .uri("/api/notes")
            .header("host", &leaves.host)
            .header("origin", &leaves.origin)
            .header("authorization", &leaves.bearer)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let said = |resp: axum::response::Response| async move {
        assert_eq!(resp.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["note"].clone()
    };

    let note = said(
        router
            .clone()
            .oneshot(send(
                serde_json::json!({ "text": "Four evenings, and it held.", "pane": pane }),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(note["from"]["name"], "ledger");
    assert_eq!(note["from"]["slot"], 2, "the second pane opened");

    for pane in ["0123456789abcdef0123456789abcdef", "../not-an-id"] {
        let note = said(
            router
                .clone()
                .oneshot(send(
                    serde_json::json!({ "text": "From nowhere.", "pane": pane }),
                ))
                .await
                .unwrap(),
        )
        .await;
        assert!(note["from"].is_null(), "{pane}: {note}");
    }
    let note = said(
        router
            .oneshot(send(serde_json::json!({ "text": "No pane at all." })))
            .await
            .unwrap(),
    )
    .await;
    assert!(note["from"].is_null());
}

/// A Ctrl-clicked folder opens in the folder reader, never the file manager:
/// under the panel's desk when it is inside it, at its path there, or else as
/// a row of its own under Folders. A folder that is not there is a 404.
#[tokio::test]
async fn a_ctrl_clicked_folder_opens_in_the_reader() {
    let desk_dir = crate::store::tempdir::Dir::new("snyvi-resolve-desk");
    std::fs::create_dir_all(desk_dir.path.join("src")).unwrap();
    std::fs::create_dir_all(desk_dir.path.join("a/b")).unwrap();
    let away = crate::store::tempdir::Dir::new("snyvi-resolve-away");
    let root = desk_dir.path.to_string_lossy().into_owned();
    let at = std::sync::Mutex::new((0, String::new()));
    let (_tmp, router, leaves) = gated_router_with("snyvi-resolve-dir", |store| {
        let desk = store.create_desk(&root, Some("ledger")).unwrap();
        if let crate::desk::Opened::Pane(p) = store.open_pane(desk.id, &root, "").unwrap() {
            *at.lock().unwrap() = (desk.id, p.id);
        }
    });
    let (desk, pane) = at.into_inner().unwrap();
    let click = |word: &str| {
        let body = serde_json::json!({ "word": word, "desk": desk, "pane": pane, "open": true });
        let req = axum::http::Request::builder()
            .method("POST")
            .uri("/api/resolve")
            .header("host", &leaves.host)
            .header("origin", &leaves.origin)
            .header(CAPABILITY_HEADER, &leaves.cap)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        router.clone().oneshot(req)
    };
    async fn answer(resp: axum::response::Response) -> serde_json::Value {
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    let src = answer(click("src").await.unwrap()).await;
    assert_eq!(src["kind"], "dir");
    assert_eq!(src["rel"], "src", "{src}");
    let deep = answer(click("a/b").await.unwrap()).await;
    assert_eq!(deep["rel"], "a/b");
    assert_eq!(deep["root"], src["root"], "the desk's folder, opened once");

    let other = answer(click(&away.path.to_string_lossy()).await.unwrap()).await;
    assert_eq!(other["kind"], "dir");
    assert_eq!(other["rel"], "", "a folder outside the desk is its own row");
    assert_ne!(other["root"], src["root"]);

    let gone = click(&desk_dir.path.join("nope").to_string_lossy())
        .await
        .unwrap();
    assert_eq!(gone.status(), StatusCode::NOT_FOUND);
}

/// Asides turned off in About: an agent's aside is refused with words it can
/// read back, nothing is kept, and turning them on takes the next one.
#[tokio::test]
async fn an_aside_is_refused_while_asides_are_off() {
    let (tmp, router, leaves) = gated_router("snyvi-asides-off");
    let send = || {
        axum::http::Request::builder()
            .method("POST")
            .uri("/api/notes")
            .header("host", &leaves.host)
            .header("origin", &leaves.origin)
            .header("authorization", &leaves.bearer)
            .header("content-type", "application/json")
            .body(Body::from(r#"{"text":"Four evenings, and it held."}"#))
            .unwrap()
    };
    let off = tmp.path.join("config").join("asides-off");
    std::fs::write(&off, b"").unwrap();
    let resp = router.clone().oneshot(send()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("asides are off in About"));
    async fn kept(router: Router, host: &str) -> usize {
        let req = axum::http::Request::builder()
            .uri("/api/notes")
            .header("host", host)
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["notes"]
            .as_array()
            .map_or(0, Vec::len)
    }
    assert_eq!(
        kept(router.clone(), &leaves.host).await,
        0,
        "a refused aside is not kept"
    );

    std::fs::remove_file(&off).unwrap();
    let resp = router.clone().oneshot(send()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    assert_eq!(kept(router, &leaves.host).await, 1);
}

/// Home's Keep on…: a friend's waiting line goes on a desk in one click,
/// with their name on it, and only from the window -- it writes a desk's list.
#[tokio::test]
async fn a_friends_line_kept_on_a_desk_says_who_sent_it() {
    let root = crate::store::tempdir::Dir::new("snyvi-keep-line-desk");
    let dir = root.path.to_string_lossy().into_owned();
    let at = std::sync::Mutex::new((0, 0));
    let (_tmp, router, leaves) = gated_router_with("snyvi-keep-line", |store| {
        let desk = store.create_desk(&dir, Some("Garden")).unwrap();
        let p = store
            .pin_peer(&crate::peer::Peer {
                sign_key: "SIGN".into(),
                box_key: "BOX".into(),
                name: "Trapti".into(),
                ..Default::default()
            })
            .unwrap();
        let n = store
            .peer_note_arrived(p.id, "water the beans", "")
            .unwrap();
        *at.lock().unwrap() = (desk.id, n);
    });
    let (desk, line) = at.into_inner().unwrap();
    let keep = |cap: bool| {
        let mut req = axum::http::Request::builder()
            .method("POST")
            .uri(format!("/api/peers/notes/{line}"))
            .header("host", &leaves.host)
            .header("origin", &leaves.origin)
            .header("content-type", "application/json");
        if cap {
            req = req.header(CAPABILITY_HEADER, &leaves.cap);
        }
        let body = serde_json::json!({ "what": "keep", "desk": desk }).to_string();
        router.clone().oneshot(req.body(Body::from(body)).unwrap())
    };
    let read = |uri: String| {
        let req = axum::http::Request::builder()
            .uri(uri)
            .header("host", &leaves.host)
            .header(CAPABILITY_HEADER, &leaves.cap)
            .body(Body::empty())
            .unwrap();
        router.clone().oneshot(req)
    };
    async fn json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    assert_eq!(
        keep(false).await.unwrap().status(),
        StatusCode::FORBIDDEN,
        "a tab has no desks to keep it on"
    );
    let kept = keep(true).await.unwrap();
    assert_eq!(kept.status(), StatusCode::OK);
    let kept = json(kept).await;
    assert_eq!(kept["name"], "Garden");
    assert_eq!(kept["note"]["sent_by"], "Trapti");
    let notes = json(read(format!("/api/desks/{desk}/notes")).await.unwrap()).await;
    let ours = notes["notes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["text"] == "water the beans")
        .cloned()
        .unwrap();
    assert_eq!(ours["sent_by"], "Trapti");
    assert!(
        ours.get("suggested_by").is_none(),
        "the reader's, not a question"
    );
    let peers = json(read("/api/peers".into()).await.unwrap()).await;
    assert_eq!(peers["notes"], serde_json::json!([]), "no longer waiting");
    assert_eq!(
        keep(true).await.unwrap().status(),
        StatusCode::NOT_FOUND,
        "kept once"
    );
}

/// A friend's document: Save waits for a desk, Keep puts it on one, Save
/// then writes `from-trapti/<name>` into the desk's folder and never over a
/// file, and none of it is anyone's but the window's or a friend's document.
#[tokio::test]
async fn a_friends_document_is_kept_on_a_desk_then_saved_into_its_folder() {
    let garden = crate::store::tempdir::Dir::new("snyvi-keep-doc-desk");
    let root = garden.path.to_string_lossy().into_owned();
    let at = std::sync::Mutex::new((0, String::new(), String::new()));
    let (_tmp, router, leaves) = gated_router_with("snyvi-keep-doc", |store| {
        let desk = store.create_desk(&root, Some("Garden")).unwrap();
        let doc = |id: &str, origin: &str, path: &str| {
            store
                .insert(
                    id,
                    crate::store::NewDoc {
                        project_root: "peer:KEY",
                        project_name: "From Trapti",
                        workflow_key: "sent",
                        workflow_title: "Sent by Trapti",
                        title: "Seed list",
                        kind: crate::render::Kind::Markdown,
                        lang: None,
                        source_path: Some(path),
                        branch: None,
                        origin,
                        sender: "Trapti",
                        desk: None,
                        source: b"# Seeds\n\nbeans",
                        staged: None,
                        search_body: "beans",
                        html: "<p>beans</p>",
                    },
                )
                .unwrap()
                .id
        };
        let theirs = doc("abcdef0001", "peer", "seeds.md");
        let mine = doc("abcdef0002", "cli", "mine.md");
        *at.lock().unwrap() = (desk.id, theirs, mine);
    });
    let (desk, theirs, mine) = at.into_inner().unwrap();
    let post = |uri: String, body: serde_json::Value, cap: bool| {
        let mut req = axum::http::Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", &leaves.host)
            .header("origin", &leaves.origin)
            .header("content-type", "application/json");
        if cap {
            req = req.header(CAPABILITY_HEADER, &leaves.cap);
        }
        router
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
    };
    async fn json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 65536).await.unwrap();
        serde_json::from_slice(&bytes).unwrap_or_default()
    }
    let save = |id: &str| post(format!("/api/docs/{id}/save"), serde_json::json!({}), true);
    let keep = |id: &str, cap: bool| {
        post(
            format!("/api/docs/{id}/keep"),
            serde_json::json!({ "desk": desk }),
            cap,
        )
    };

    let early = save(&theirs).await.unwrap();
    assert_eq!(early.status(), StatusCode::CONFLICT, "not on a desk yet");
    assert_eq!(
        keep(&theirs, false).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        keep(&mine, true).await.unwrap().status(),
        StatusCode::CONFLICT,
        "only a friend's document moves this way"
    );
    let kept = keep(&theirs, true).await.unwrap();
    assert_eq!(kept.status(), StatusCode::OK);
    let kept = json(kept).await;
    assert_eq!(kept["desk"], "Garden");
    assert_eq!(kept["doc"]["desk"]["id"], desk);
    assert_eq!(kept["doc"]["sender"], "Trapti", "still from them");

    let first = json(save(&theirs).await.unwrap()).await;
    assert_eq!(first["rel"], "from-trapti/seeds.md", "{first}");
    let second = json(save(&theirs).await.unwrap()).await;
    assert_eq!(second["rel"], "from-trapti/seeds-2.md", "never over a file");
    assert_eq!(
        std::fs::read(garden.path.join("from-trapti/seeds.md")).unwrap(),
        b"# Seeds\n\nbeans"
    );
    assert!(garden.path.join("from-trapti/seeds-2.md").exists());
}

/// A friend's document in one of the reader's folders says so, and Move to
/// From Trapti takes it back to their row, off the desk; nobody else's
/// document moves that way.
#[tokio::test]
async fn a_friends_document_in_a_folder_goes_back_to_their_row() {
    let garden = crate::store::tempdir::Dir::new("snyvi-unfile-desk");
    let root = garden.path.to_string_lossy().into_owned();
    let (_tmp, router, leaves) = gated_router_with("snyvi-unfile", |store| {
        let desk = store.create_desk(&root, Some("Garden")).unwrap();
        for (id, origin) in [("abcdef0001", "peer"), ("abcdef0002", "cli")] {
            store
                .insert(
                    id,
                    crate::store::NewDoc {
                        project_root: "peer:KEY",
                        project_name: "From Trapti",
                        workflow_key: "sent",
                        workflow_title: "Sent by Trapti",
                        title: "Seed list",
                        kind: crate::render::Kind::Markdown,
                        lang: None,
                        source_path: Some("docs/seeds.md"),
                        branch: None,
                        origin,
                        sender: "Trapti",
                        desk: None,
                        source: b"# Seeds",
                        staged: None,
                        search_body: "",
                        html: "<p>Seeds</p>",
                    },
                )
                .unwrap();
        }
        store
            .pin_peer(&crate::peer::Peer {
                id: 0,
                sign_key: "KEY".into(),
                box_key: "BOX".into(),
                name: "Trapti".into(),
                paired_at: 0,
                muted: false,
                removed_at: 0,
                last_from: 0,
                last_to: 0,
                desk_id: 0,
                v: 0,
                read_receipts: false,
            })
            .unwrap();
        // Who sent it, by key, as `arrived` sets it.
        store.set_peer_key("abcdef0001", "KEY").unwrap();
        let (r, n, _) = crate::receive::desk_project(&root);
        let on = crate::desk::Origin {
            id: desk.id,
            name: desk.name.clone(),
            slot: 0,
        };
        let kept = store
            .move_lineage("abcdef0001", &r, &n, &on)
            .unwrap()
            .unwrap();
        assert!(kept.filed, "in the reader's folder now");
    });
    let unfile = |id: &str| {
        router.clone().oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/docs/{id}/unfile"))
                .header("host", &leaves.host)
                .header("origin", &leaves.origin)
                .body(Body::empty())
                .unwrap(),
        )
    };
    let back = unfile("abcdef0001").await.unwrap();
    assert_eq!(back.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(back.into_body(), 65536).await.unwrap();
    let back: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(back["doc"]["project"], "From Trapti", "{back}");
    assert!(back["doc"]["desk"].is_null(), "{back}");
    assert!(back["doc"].get("filed").is_none(), "{back}");
    assert_eq!(
        unfile("abcdef0002").await.unwrap().status(),
        StatusCode::CONFLICT,
        "only a friend's document"
    );
}

#[test]
fn a_saved_friends_document_gets_a_plain_name() {
    use super::api_peer::{file_name, slug};
    assert_eq!(slug("Trapti"), "trapti");
    assert_eq!(slug("  Ana María / B "), "ana-maría-b");
    assert_eq!(slug("../.."), "friend");
    let mut d = crate::store::Doc {
        id: "x".into(),
        project_id: 1,
        project: "p".into(),
        workflow_id: 1,
        workflow: "sent".into(),
        workflow_title: "Sent".into(),
        title: "Garden plan!".into(),
        kind: crate::render::Kind::Markdown,
        lang: None,
        size: 1,
        received_at: 0,
        source_path: Some("../../etc/plan.md".into()),
        branch: None,
        pinned: false,
        origin: "peer".into(),
        content_hash: String::new(),
        desk: None,
        sender: "Trapti".into(),
        filed: false,
        local_path: None,
    };
    assert_eq!(file_name(&d), "plan.md", "a name and no path");
    d.source_path = None;
    assert_eq!(file_name(&d), "garden-plan.md");
    d.source_path = Some(".bashrc".into());
    assert_eq!(file_name(&d), "garden-plan.md", "never a dotfile");
}

/// A page sent to a friend carries its own pictures: one beside it goes in
/// as `data:`, one outside its project, one of a kind that is not a
/// picture, a link out, and one past the room left all stay as written.
#[test]
fn a_pages_pictures_travel_inside_it() {
    use super::api_peer::inline_pictures;
    let tmp = crate::store::tempdir::Dir::new("snyvi-inline-pictures");
    let proj = tmp.path.join("proj");
    std::fs::create_dir_all(proj.join(".git")).unwrap();
    std::fs::create_dir_all(proj.join("img")).unwrap();
    std::fs::write(proj.join("img/shot.png"), b"PNGDATA").unwrap();
    std::fs::write(proj.join("draw.svg"), b"<svg/>").unwrap();
    std::fs::write(tmp.path.join("away.png"), b"AWAY").unwrap();
    let page = proj.join("plan.md");
    let md =
        "![shot](img/shot.png) ![svg](draw.svg) ![away](../away.png) ![web](https://x.dev/a.png)";
    let out = inline_pictures(md, &page, 1 << 20);
    assert!(
        out.starts_with(&format!(
            "![shot]({})",
            crate::render::data_uri("image/png", b"PNGDATA")
        )),
        "{out}"
    );
    assert!(out.contains("![svg](draw.svg)"));
    assert!(
        out.contains("![away](../away.png)"),
        "not outside its project"
    );
    assert!(out.contains("![web](https://x.dev/a.png)"));
    assert_eq!(
        inline_pictures(md, &page, 4),
        md,
        "nothing past the room a frame has"
    );
    assert_eq!(
        inline_pictures(md, std::path::Path::new("plan.md"), 1 << 20),
        md,
        "a name with no folder, as a friend's document has"
    );
}

/// The mod's band is a long-poll: the band it has is held until this desk
/// moves, another desk's move does not wake it, a change answers at once,
/// and a wait of nothing is one 204. The wait is the handler's argument, so
/// the test's is short (tokio's paused clock needs its `test-util` feature,
/// which the crate does not carry).
#[tokio::test]
async fn a_band_is_held_until_its_own_desk_moves() {
    use super::api_thread::{band_held, band_tag};
    use std::time::Duration;
    const WAIT: Duration = Duration::from_millis(600);
    let tick = || tokio::time::sleep(Duration::from_millis(100));
    let tmp = crate::store::tempdir::Dir::new("snyvi-band-held");
    let paths = Paths {
        data_dir: tmp.path.join("data"),
        config_dir: tmp.path.join("config"),
        docs_dir: tmp.path.join("data").join("docs"),
        db_path: tmp.path.join("data").join("snyvi.db"),
        token_path: tmp.path.join("config").join("token"),
    };
    let token = crate::config::load_or_create_token(&paths).unwrap();
    let window = crate::config::load_or_create_window_secret(&paths).unwrap();
    let store = Store::open(&paths).unwrap();
    let desk = store.create_desk("/tmp/band", Some("band")).unwrap();
    let other = store.create_desk("/tmp/other", Some("other")).unwrap();
    let crate::desk::Opened::Pane(pane) = store.open_pane(desk.id, "/tmp/band", "").unwrap() else {
        panic!("a pane")
    };
    let app = new_app(&paths, store, token, window, None, None);

    // No tag: the band at once, with its tag.
    let resp = band_held(&app, desk.id, &pane.id, None, WAIT).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let tag = j["v"].as_str().unwrap().to_string();
    assert_eq!(tag.len(), 8);
    assert_eq!(j["waiting"], 0);

    // The same tag: held. Another desk's event is not a reason to look; this
    // desk's is, and a band that is still the same is held on.
    let held = {
        let app = app.clone();
        let (tag, pane) = (tag.clone(), pane.id.clone());
        tokio::spawn(async move { band_held(&app, desk.id, &pane, Some(&tag), WAIT).await })
    };
    tick().await;
    assert!(!held.is_finished());
    super::emit(&app, "desknotes", serde_json::json!({ "desk": other.id }));
    tick().await;
    assert!(!held.is_finished(), "another desk's move");
    super::emit(&app, "desknotes", serde_json::json!({ "desk": desk.id }));
    tick().await;
    assert!(
        !held.is_finished(),
        "this desk moved, but the band is the same"
    );
    // A turn on this desk changes the band, and the held call answers.
    app.store
        .threads(|c, now| {
            crate::thread::ask(
                c,
                desk.id,
                &crate::thread::Ask {
                    kind: "try".into(),
                    text: "the new build".into(),
                    pane: pane.id.clone(),
                    ..Default::default()
                },
                now,
            )
        })
        .unwrap();
    super::emit(&app, "desknotes", serde_json::json!({ "desk": desk.id }));
    let resp = tokio::time::timeout(std::time::Duration::from_secs(5), held)
        .await
        .expect("answered on the change")
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1 << 16)
        .await
        .unwrap();
    let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(j["waiting"], 1);
    let tag2 = j["v"].as_str().unwrap().to_string();
    assert_ne!(tag2, tag);
    assert_eq!(
        band_tag(&serde_json::json!({ "a": 1 })),
        band_tag(&serde_json::json!({ "a": 1 })),
        "a tag is a function of the body"
    );

    // A changed tag answers at once, whatever it was.
    let resp = band_held(&app, desk.id, &pane.id, Some("stale000"), WAIT).await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Nothing for the whole wait: one 204, at the wait's end and not before.
    let held = {
        let app = app.clone();
        let (tag, pane) = (tag2.clone(), pane.id.clone());
        tokio::spawn(async move { band_held(&app, desk.id, &pane, Some(&tag), WAIT).await })
    };
    tokio::time::sleep(WAIT / 2).await;
    assert!(!held.is_finished());
    tokio::time::sleep(WAIT).await;
    assert!(held.is_finished());
    assert_eq!(held.await.unwrap().status(), StatusCode::NO_CONTENT);
}

/// The reader's layout is kept as normalized -- Your turn first, an id from
/// nowhere dropped, a missing section back in its place -- answered as kept,
/// and on the next page's first paint.
#[tokio::test]
async fn a_layout_is_kept_normalized_and_reaches_the_next_page() {
    let (_tmp, router, leaves) = gated_router("snyvi-layout");
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/layout")
        .header("host", &leaves.host)
        .header("origin", &leaves.origin)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"left":["folders","inbox","nope"],"right":["notes","turn"],"hidden":["folders","turn"]}"#,
        ))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
    let kept: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(kept["left"][0], "folders");
    assert_eq!(kept["left"].as_array().unwrap().len(), 4);
    assert_eq!(kept["right"][0], "turn");
    assert_eq!(kept["hidden"], serde_json::json!(["folders"]));

    let req = axum::http::Request::builder()
        .uri("/inbox")
        .header("host", &leaves.host)
        .body(Body::empty())
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let page = axum::body::to_bytes(resp.into_body(), 4 << 20).await.unwrap();
    let page = String::from_utf8_lossy(&page);
    assert!(page.contains(r#""layout":{"left":["folders","#), "the first paint has the layout");
}
