use super::*;
use crate::peer::{self, Content, Folder};

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(crate::desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(crate::desk::LOOP_COLUMNS_1_37).unwrap();
    conn.execute_batch(crate::thread::THREAD_COLUMN).unwrap();
    conn.execute_batch(crate::links::COLUMN_1_43).unwrap();
    conn.execute_batch(crate::accounts::SCHEMA).unwrap();
    for c in crate::accounts::COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);")
        .unwrap();
    conn.execute_batch(peer::SCHEMA).unwrap();
    for c in peer::COLUMNS_1_19 {
        conn.execute_batch(c).unwrap();
    }
    for c in peer::COLUMNS_1_23 {
        conn.execute_batch(c).unwrap();
    }
    for c in peer::COLUMNS_1_25
        .iter()
        .filter(|c| c.contains("peer_outbox"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn
}

/// A promise travels as a Note with its date; a snyvi before 1.48, which
/// knows a Note as words and a name, reads it as the plain line it also is.
#[test]
fn a_promise_is_a_line_to_an_older_snyvi() {
    let c = Content::Note {
        text: "post the release note".into(),
        name: "Sunny".into(),
        at: Folder::default(),
        due_at: 1_800_000_000,
        promise: true,
    };
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["due_at"], 1_800_000_000);
    assert_eq!(json["promise"], true);
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "lowercase", tag = "kind")]
    #[allow(dead_code)]
    enum Old {
        Note { text: String, name: String },
    }
    let Old::Note { text, .. } = serde_json::from_value(json).unwrap();
    assert_eq!(text, "post the release note");
    // And a plain line says neither.
    let plain = serde_json::to_value(Content::Note {
        text: "x".into(),
        name: "S".into(),
        at: Folder::default(),
        due_at: 0,
        promise: false,
    })
    .unwrap();
    assert!(plain.get("due_at").is_none() && plain.get("promise").is_none());
}

#[test]
fn a_promise_is_queued_marked_and_kept_once_its_line_is_ticked() {
    let mut conn = db();
    conn.execute(
        "INSERT INTO peers(sign_key, box_key, name, paired_at) VALUES('k', 'b', 'Trapti', 1)",
        [],
    )
    .unwrap();
    let p = peer::list(&conn).unwrap().remove(0);
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let n = crate::desk::add_note(&mut conn, d, "post the note", 0)
        .unwrap()
        .unwrap();
    let frame = queue(&conn, &p, n.id, &n.text, 5_000, 10).unwrap();
    let (re, extra): (String, String) = conn
        .query_row(
            "SELECT re, extra FROM peer_outbox WHERE id = ?1",
            params![frame],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(of_row(&re, &extra), (5_000, true));
    assert_eq!(of_row("", ""), (0, false));
    assert_eq!(
        promised(&conn, d).unwrap(),
        vec![(n.id, "Trapti".to_string(), false)]
    );

    // Not sent yet, or not ticked: nothing to keep.
    crate::desk::set_note(&conn, d, n.id, None, Some(true), 20).unwrap();
    assert!(keep(&conn, 30).unwrap().is_empty(), "not sent yet");
    conn.execute(
        "UPDATE peer_outbox SET sent_at = 15 WHERE id = ?1",
        params![frame],
    )
    .unwrap();
    assert_eq!(keep(&conn, 40).unwrap(), vec![p.id]);
    assert!(keep(&conn, 50).unwrap().is_empty(), "once");
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM peer_outbox WHERE kind = 'done' AND re = ?1",
            params![frame],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(done, 1);
    assert!(promised(&conn, d).unwrap()[0].2, "kept");
}

/// On the friend's side the promise is a Home row with its date, and their
/// Done marks it kept.
#[test]
fn a_promise_made_to_the_reader_reads_kept() {
    let conn = db();
    conn.execute(
        "INSERT INTO peers(sign_key, box_key, name, paired_at) VALUES('k', 'b', 'Sunny', 1)",
        [],
    )
    .unwrap();
    let p = peer::list(&conn).unwrap().remove(0);
    let text = said("post the note", 0, 0);
    assert_eq!(text, "post the note");
    peer::note_arrived(&conn, p.id, &said("post the note", 200_000, 0), "f1", 0).unwrap();
    assert_eq!(
        kept(&conn, p.id, "f1").unwrap().unwrap(),
        format!("{} · kept ✓", said("post the note", 200_000, 0))
    );
    assert!(kept(&conn, p.id, "f1").unwrap().is_none(), "once");
    assert!(kept(&conn, p.id, "nope").unwrap().is_none());
}
