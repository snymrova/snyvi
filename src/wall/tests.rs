use super::*;
use crate::peer::{b64, open, seal, seal_nonce, Content, Identity};

fn ident(n: u8) -> Identity {
    let mut seed = [n; 64];
    seed[0] = n.wrapping_add(100);
    Identity::from_seed(&seed)
}

fn as_peer(id: &Identity, name: &str) -> Peer {
    Peer {
        id: 1,
        sign_key: id.address(),
        box_key: b64(&id.box_public()),
        name: name.into(),
        v: CONTENT_V,
        ..Default::default()
    }
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::peer::SCHEMA).unwrap();
    conn.execute_batch(crate::page::SCHEMA).unwrap();
    conn.execute_batch(crate::page::COLUMNS_1_62).unwrap();
    conn.execute(
        "INSERT INTO desks(id, name, root, created_at) VALUES(1, 'dogs', '/tmp/dogs', 1)",
        [],
    )
    .unwrap();
    conn
}

#[test]
fn the_signature_covers_the_method_the_path_the_time_and_the_body() {
    let m = auth_message("PUT", "/pages/dogs", 1_800_000_000, b"{}");
    assert_eq!(
        m,
        format!(
            "snyvi-wall-v1\nPUT\n/pages/dogs\n1800000000\n{}",
            blake3::hash(b"{}").to_hex()
        )
    );
    assert_ne!(m, auth_message("PUT", "/pages/dogs", 1_800_000_000, b"{ }"));
    let h = ident(1).wall_auth("PUT", "/pages/dogs", b"{}");
    let (secs, sig) = h.split_once('.').unwrap();
    assert!(secs.parse::<i64>().unwrap() > 1_700_000_000);
    assert_eq!(crate::peer::unb64(sig).unwrap().len(), 64);
}

#[test]
fn the_press_queues_files_then_the_page_then_its_moments_then_the_check() {
    let conn = db();
    let d = crate::page::Draft {
        title: "Dogs".into(),
        ..Default::default()
    };
    let p = crate::page::start(&conn, 1, "dogs", &d, "0123456789abcdef.svg", 1).unwrap();
    let m = crate::page::MomentIn {
        title: "Chapter 4".into(),
        files: vec!["fedcba9876543210.png".into()],
        ..Default::default()
    };
    crate::page::put_moment(&conn, p.id, &m, 2).unwrap();
    let ms = crate::page::moments(&conn, p.id, false).unwrap();
    queue_publish(&conn, &p, &ms, 3).unwrap();
    let rows: Vec<String> = held(&conn, Some(p.id))
        .unwrap()
        .into_iter()
        .map(|r| r.what)
        .collect();
    assert_eq!(
        rows,
        [
            "file:0123456789abcdef.svg",
            "file:fedcba9876543210.png",
            "page",
            &format!("moment:{}", ms[0].id),
            "check",
        ]
    );
    // What the wall is sent is what the builder chose to show, and nothing
    // of this machine's: no desk, no folder, no provenance.
    let page = &held(&conn, Some(p.id)).unwrap()[2].body;
    for not in ["desk_id", "provenance", "/tmp/dogs", "created_at"] {
        assert!(!page.contains(not), "{not} in {page}");
    }
    // A second press replaces what the first left held.
    queue_publish(&conn, &p, &ms, 4).unwrap();
    assert_eq!(held(&conn, Some(p.id)).unwrap().len(), 5);
    let first = held(&conn, None).unwrap()[0].id;
    sent(&conn, first, 5).unwrap();
    failed(&conn, first + 1, "no connection").unwrap();
    let h = held(&conn, None).unwrap();
    assert_eq!(
        (h.len(), h[0].tries, h[0].error.as_str()),
        (4, 1, "no connection")
    );
    refused(&conn, p.id, "that name is taken").unwrap();
    assert!(held(&conn, None).unwrap().is_empty());
}

#[test]
fn the_walls_line_opens_against_the_walls_keys_and_nothing_else_does() {
    let (wall, me, stranger) = (ident(1), ident(2), ident(3));
    let line = Content::Wall {
        slug: "dogs".into(),
        hearts: 41,
        names: vec!["Trapti".into()],
        since: 1_800_000_000,
        reported: 0,
        follows: 12,
        followers: vec!["Sam".into()],
        reads: 140,
        v: CONTENT_V,
    };
    let frame = seal(&wall, &as_peer(&me, "me"), &line, b"").unwrap();
    let (got, _) = open(&me, &as_peer(&wall, "the wall"), &frame).unwrap();
    assert_eq!(got, line);
    // The same line from a stranger's key does not open as the wall's.
    let forged = seal(&stranger, &as_peer(&me, "me"), &line, b"").unwrap();
    assert!(open(&me, &as_peer(&wall, "the wall"), &forged).is_err());
    // A key that is not minted is no one's: nothing is the wall's.
    assert!(!is_wall(""));
}

#[test]
fn a_friends_page_round_trips_and_an_older_reader_holds_it() {
    let (a, b) = (ident(4), ident(5));
    let c = Content::Page {
        slug: "dogs".into(),
        page: json!({ "title": "Dogs" }),
        moment: json!({ "title": "Chapter 4" }),
        v: CONTENT_V,
    };
    let frame = seal(&a, &as_peer(&b, "b"), &c, b"").unwrap();
    assert_eq!(open(&b, &as_peer(&a, "a"), &frame).unwrap().0, c);
    // A 1.58 reader (v 4) knows no `page` kind: serde's `other` is Other.
    #[derive(serde::Deserialize, Debug)]
    #[serde(tag = "kind", rename_all = "lowercase")]
    enum Old {
        Note,
        #[serde(other)]
        Other,
    }
    let old: Old = serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
    assert!(matches!(old, Old::Other), "{old:?}");
}

/// The vectors `wall/test/vectors.json` holds: the wall's TypeScript seal,
/// checked byte for byte against this one, and a daemon's signature the
/// wall must verify. Written by this test, so they cannot drift from it.
#[test]
fn the_walls_vectors_are_written_from_here() {
    let (wall, me) = (ident(7), ident(8));
    let mut wall_seed = [7u8; 64];
    wall_seed[0] = 107;
    let line = Content::Wall {
        slug: "breeds-of-dogs".into(),
        hearts: 3,
        names: vec!["Trapti".into(), "Sam".into()],
        since: 1_800_000_000,
        reported: 1,
        follows: 2,
        followers: vec!["Sam".into()],
        reads: 9,
        v: CONTENT_V,
    };
    let nonce = [5u8; 24];
    let frame = seal_nonce(&wall, &as_peer(&me, "me"), &line, b"", nonce).unwrap();
    assert!(open(&me, &as_peer(&wall, "the wall"), &frame).is_ok());
    let body = br#"{"slug":"breeds-of-dogs"}"#;
    let secs = 1_800_000_123;
    let message = auth_message("PUT", "/pages/breeds-of-dogs", secs, body);
    let v = json!({
        "note": "written by `cargo test wall::tests::the_walls_vectors_are_written_from_here`; do not edit",
        "wall_seed": b64(&wall_seed),
        "wall_sign": wall.address(),
        "wall_box": b64(&wall.box_public()),
        "to_sign": me.address(),
        "to_box": b64(&me.box_public()),
        "nonce": b64(&nonce),
        "content": serde_json::to_string(&line).unwrap(),
        "frame": b64(&frame),
        "auth": {
            "method": "PUT",
            "path": "/pages/breeds-of-dogs",
            "secs": secs,
            "body": b64(body),
            "message": message,
            "from": me.address(),
            "signature": me.sign_for_test(message.as_bytes()),
        },
    });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("wall/test/vectors.json");
    let text = serde_json::to_string_pretty(&v).unwrap() + "\n";
    if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
    }
}
