//! Desk names an agent can find (1.66.2, plan 815f723b64): `read_desk`'s
//! `desks` are the other open desks by name, and a `--desk` that names none
//! answers with the names there are. The locked host stopped at "no open
//! desk is called" with nothing that listed them.

use super::*;

/// `snyvi note suggest --desk NAME`: the CLI's call, with the token.
async fn suggest(router: &Router, l: &Leaves, desk: &str) -> (StatusCode, String) {
    let body = serde_json::json!({ "desk": desk, "text": "Post on the site", "cwd": "/nowhere" });
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/notes/suggest")
        .header("host", l.host.as_str())
        .header("authorization", l.bearer.as_str())
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn a_desk_that_is_not_there_answers_with_the_ones_that_are() {
    let mut ids = (0, 0);
    let (_tmp, app, router, l) = gated_app_with("desk-names", |store| {
        let a = store.create_desk("/tmp/a", Some("snyvi")).unwrap().id;
        let omd = store.create_desk("/tmp/omd", Some("OMD")).unwrap().id;
        let gone = store.create_desk("/tmp/gone", Some("Gone")).unwrap().id;
        store.close_desk(gone).unwrap();
        ids = (a, omd);
    });

    let (s, t) = suggest(&router, &l, "2025").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{t}");
    assert!(
        t.contains("no open desk is called 2025; the open desks are snyvi, OMD"),
        "{t}"
    );
    assert!(!t.contains("Gone"), "a closed desk is not offered: {t}");

    // No name, and a folder no desk holds: the names, too.
    let (s, t) = suggest(&router, &l, "").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{t}");
    assert!(
        t.contains("pass --desk with its name; the open desks are snyvi, OMD"),
        "{t}"
    );

    // read_desk's `desks`: the others, never the desk asking, never a closed one.
    let others = app
        .store
        .clocked(|c, _| crate::desk::other_names(c, ids.0))
        .unwrap();
    assert_eq!(others, vec!["OMD".to_string()]);
}
