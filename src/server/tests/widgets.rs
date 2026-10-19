//! A widget's card says what Add allows, the token cannot widen what the
//! reader allowed, and a no holds on the CLI too (1.36).

use super::*;
use crate::widget;

/// What a request answered, its body read whatever its status.
async fn said(
    router: &Router,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut req = axum::http::Request::builder().method("POST").uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = req
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 8192).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// Add allows the folder the card showed and nothing else: an agent that
/// edits its proposal after the card is up -- it has a shell as the reader
/// -- gets nothing allowed, and is asked to propose it again.
#[tokio::test]
async fn add_allows_only_what_the_card_showed() {
    let (_tmp, app, _router, _leaves) = gated_app_with("snyvi-widget-card", |_| {});
    let desk = app
        .store
        .create_desk("/tmp/cardwatch", Some("cardwatch"))
        .unwrap()
        .id;
    let stage = widget::files::dir(&app.paths.config_dir)
        .join(".proposed")
        .join("100-ci");
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(
        stage.join("widget.json"),
        r#"{"name":"ci","scope":"desk","run":{"command":"sh \"$SNYVI_WIDGET_DIR/run.sh\""}}"#,
    )
    .unwrap();
    std::fs::write(stage.join("run.sh"), "echo shown").unwrap();
    let card = crate::thread::Suggestion {
        desk_id: desk,
        kind: "widget".into(),
        name: "ci".into(),
        folder: stage.to_string_lossy().into(),
        detail: serde_json::json!({ "where": "here", "hash": widget::files::hash(&stage).unwrap() }),
        ..Default::default()
    };
    let lasts = super::super::api_widget::Lasts::default();
    std::fs::write(stage.join("run.sh"), "echo swapped").unwrap();
    let no = super::super::api_widget::install_proposed(&app, &card, &lasts)
        .err()
        .unwrap();
    assert!(no.why.contains("changed after it was proposed"), "{}", no.why);
    assert!(no.stale, "a card that can never be added is settled stale");
    assert!(stage.is_dir(), "nothing moved in");
    // A card from before 1.36 kept no hash: asked again too.
    let old = crate::thread::Suggestion {
        detail: serde_json::json!({ "where": "here" }),
        ..card.clone()
    };
    assert!(super::super::api_widget::install_proposed(&app, &old, &lasts).is_err());
    // An earlier widget of the name left Rerun my edits on: not inherited.
    app.store
        .clocked(|c, now| {
            let on = widget::Change {
                rerun_edits: Some(true),
                settings: Some(r#"{"base":"old"}"#),
                ..Default::default()
            };
            widget::set_prefs(c, desk, "ci", &on, now).map(|_| ())
        })
        .unwrap();
    // As shown: added, this desk's own, allowed as the card showed it.
    std::fs::write(stage.join("run.sh"), "echo shown").unwrap();
    super::super::api_widget::install_proposed(&app, &card, &lasts).unwrap();
    let own = widget::files::folder_of(&app.paths.config_dir, desk, "ci");
    let p = app
        .store
        .clocked(|c, _| widget::prefs(c, desk, "ci"))
        .unwrap();
    assert_eq!(p.trusted_hash, widget::files::hash(&own).unwrap());
    assert_eq!(p.trusted_hash, card.detail["hash"].as_str().unwrap());
    assert!(!p.rerun_edits && p.settings == "{}", "nothing of the old one");
}

/// A widget that names a key is given it, from its desk alone: shared it
/// is refused, and on a desk without the key the card's Try once says so.
#[tokio::test]
async fn a_widget_names_its_keys_and_a_shared_one_may_not() {
    let (_tmp, app, _router, _leaves) = gated_app_with("snyvi-widget-keys", |_| {});
    let desk = app
        .store
        .create_desk("/tmp/keyed", Some("keyed"))
        .unwrap()
        .id;
    let stage = widget::files::dir(&app.paths.config_dir)
        .join(".proposed")
        .join("200-spend");
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(
        stage.join("widget.json"),
        r#"{"name":"spend","scope":"desk","run":{"command":"run.sh"},"keys":["OPENROUTER_API_KEY"]}"#,
    )
    .unwrap();
    std::fs::write(stage.join("run.sh"), "#!/bin/sh\necho \"key=$OPENROUTER_API_KEY\"\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(stage.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let spec = widget::files::read(&stage, "spend").unwrap();
    assert_eq!(spec.keys, vec!["OPENROUTER_API_KEY".to_string()]);
    assert!(widget::files::keys_ok(&spec, 0).is_err(), "shared: no desk to take them from");
    assert!(widget::files::keys_ok(&spec, desk).is_ok());
    let card = crate::thread::Suggestion {
        desk_id: desk,
        kind: "widget".into(),
        name: "spend".into(),
        folder: stage.to_string_lossy().into(),
        detail: serde_json::json!({ "where": "here", "hash": widget::files::hash(&stage).unwrap() }),
        ..Default::default()
    };
    // Not on the desk yet: said, and nothing run.
    let tried = super::super::api_widget::try_proposed(&app, &card).await;
    assert!(
        tried["error"]
            .as_str()
            .is_some_and(|e| e.contains("needs the key OPENROUTER_API_KEY")),
        "{tried}"
    );
    app.secrets.keep(desk, "OPENROUTER_API_KEY", "sk-test").unwrap();
    #[cfg(unix)]
    {
        let tried = super::super::api_widget::try_proposed(&app, &card).await;
        assert!(
            tried["html"].as_str().is_some_and(|h| h.contains("key=sk-test")),
            "{tried}"
        );
    }
}

/// Allow on a box draws it first: a desk that filled meanwhile is said in
/// words, and no yes is left behind a card that still asks.
#[tokio::test]
async fn allow_on_a_full_desk_leaves_no_yes_behind() {
    let (_tmp, app, _router, _leaves) = gated_app_with("snyvi-widget-allow-full", |_| {});
    let desk = app
        .store
        .create_desk("/tmp/fullbox", Some("fullbox"))
        .unwrap()
        .id;
    app.store
        .clocked(|c, now| {
            let w = widget::Writer {
                source: widget::Source::Push,
                writer: "a script",
                pane: "",
                title: "",
                owner: 0,
            };
            let b = match widget::Body::parse("x").unwrap() {
                widget::Sent::Body(b) => b,
                _ => unreachable!(),
            };
            for n in 0..widget::DESK_MAX {
                widget::put(c, desk, &format!("w{n}"), &b, "", &w, now)?;
            }
            widget::ask_wait(c, desk, "deploy", "p1", "panel 1", "**3/5**", now)
        })
        .unwrap();
    let card = crate::thread::Suggestion {
        desk_id: desk,
        kind: "box".into(),
        name: "deploy".into(),
        pane: "p1".into(),
        ..Default::default()
    };
    let why = super::super::api_widget::allow_box(&app, &card, &Default::default()).unwrap_err();
    assert!(why.contains("6 widgets"), "{why}");
    let a = app
        .store
        .clocked(|c, _| widget::ask_of(c, desk, "deploy"))
        .unwrap()
        .unwrap();
    assert_eq!(a.answer, "", "still waiting, honestly");
}

/// What /sidebars reads names every folder and setting: this page's or
/// the token's, not any local process's.
#[tokio::test]
async fn the_widget_list_is_not_any_local_processs() {
    let (_tmp, router, l) = gated_router("snyvi-widget-list");
    let get = |headers: Vec<(&str, &str)>| {
        let router = router.clone();
        async move {
            let mut req = axum::http::Request::builder().method("GET").uri("/api/widgets");
            for (k, v) in headers {
                req = req.header(k, v);
            }
            router
                .oneshot(req.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status()
        }
    };
    assert_eq!(get(vec![("host", l.host.as_str())]).await, StatusCode::FORBIDDEN);
    assert_eq!(
        get(vec![("host", l.host.as_str()), ("authorization", l.bearer.as_str())]).await,
        StatusCode::OK
    );
    assert_eq!(
        get(vec![("host", l.host.as_str()), ("origin", l.origin.as_str())]).await,
        StatusCode::OK
    );
}

/// The token turns a widget off, as any reader may; widening it -- on
/// again, shared, more desks, longer, other settings -- is the window's.
#[tokio::test]
async fn the_token_turns_a_widget_off_and_widens_nothing() {
    let (_tmp, router, l) = gated_router("snyvi-widget-widen");
    let agent = [
        ("host", l.host.as_str()),
        ("authorization", l.bearer.as_str()),
    ];
    let window = [
        ("host", l.host.as_str()),
        ("origin", l.origin.as_str()),
        ("x-snyvi-capability", l.cap.as_str()),
    ];
    let path = "/api/widgets/git/prefs";
    for body in [
        r#"{"owner":7,"share":true}"#,
        r#"{"owner":0,"desks":[]}"#,
        r#"{"owner":0,"hidden":false}"#,
        r#"{"owner":0,"until":0}"#,
        r#"{"owner":0,"settings":{"base":"x"}}"#,
        r#"{"owner":0,"ask_again":1}"#,
    ] {
        let (code, _) = said(&router, path, body, &agent).await;
        assert_eq!(code, StatusCode::FORBIDDEN, "the token widened: {body}");
        let (code, _) = said(&router, path, body, &window).await;
        assert_ne!(code, StatusCode::FORBIDDEN, "the window may: {body}");
    }
    let (code, _) = said(&router, path, r#"{"owner":0,"hidden":true}"#, &agent).await;
    assert_ne!(code, StatusCode::FORBIDDEN, "off is anyone's");
}

/// A box the reader said Not now to on a desk is refused there to the
/// token as to a panel -- `snyvi widget set --desk` from a panel's shell
/// is no way round it -- and comes back only when they take the no back.
#[tokio::test]
async fn a_no_holds_on_the_cli_until_the_reader_takes_it_back() {
    let (_tmp, app, router, l) = gated_app_with("snyvi-widget-no", |_| {});
    let desk = app
        .store
        .create_desk("/tmp/nohold", Some("nohold"))
        .unwrap()
        .id;
    app.store
        .clocked(|c, now| {
            widget::ask_wait(c, desk, "deploy", "p1", "panel 1", "x", now)?;
            widget::ask_answer(c, desk, "deploy", "no", 0, "", now).map(|_| ())
        })
        .unwrap();
    let agent = [
        ("host", l.host.as_str()),
        ("authorization", l.bearer.as_str()),
    ];
    let push = |body: &str| format!(r#"{{"name":"deploy","desk":{desk},"body":"{body}"}}"#);
    let (code, why) = said(&router, "/api/widgets", &push("**3/5**"), &agent).await;
    assert_eq!(code, StatusCode::CONFLICT, "{why}");
    assert!(why.contains("not now"), "{why}");
    let (code, _) = said(&router, "/api/widgets", &push(""), &agent).await;
    assert!(code.is_success(), "clearing is still anyone's");
    app.store
        .clocked(|c, now| widget::ask_again(c, desk, "deploy", now))
        .unwrap();
    let (code, _) = said(&router, "/api/widgets", &push("**3/5**"), &agent).await;
    assert!(code.is_success(), "taken back: a script's push goes in");
}
