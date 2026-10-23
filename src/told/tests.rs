use super::*;

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
    conn.execute_batch(crate::thread::SCHEMA).unwrap();
    conn.execute_batch(crate::thread::CMD_COLUMN).unwrap();
    conn.execute_batch(crate::thread::GROUP_COLUMN).unwrap();
    conn.execute_batch(crate::thread::AWAY_COLUMN_1_44).unwrap();
    conn.execute_batch(crate::thread::TAKEN_COLUMN).unwrap();
    conn.execute_batch(crate::thread::PR_STATE_1_43).unwrap();
    for c in crate::thread::ON_YOU_1_36 {
        conn.execute_batch(c).unwrap();
    }
    for c in crate::peer::COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE desk_notes"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::due::TURN_COLUMN_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::peer::SCHEMA).unwrap();
    conn.execute_batch(COLUMNS_1_48).unwrap();
    conn
}

/// A desk with a thread that just merged, at `at`.
fn merged(conn: &mut Connection, name: &str, at: i64) -> (i64, i64) {
    let d = crate::desk::create(conn, "/w", None, 0).unwrap().id;
    let s = crate::thread::Start {
        name: name.into(),
        stage: "building".into(),
        ..Default::default()
    };
    let t = match crate::thread::start(conn, d, &s, 1).unwrap() {
        crate::thread::Started::New(t) => t.id,
        other => panic!("{other:?}"),
    };
    conn.execute(
        "UPDATE threads SET stage = 'shipped', merged = 'abc1234', merged_at = ?2, shipped_at = ?2 WHERE id = ?1",
        params![t, at],
    )
    .unwrap();
    (d, t)
}

#[test]
fn a_fix_is_told_to_no_one_and_a_feature_gets_a_release_note() {
    assert_eq!(told_default("dates on lines", &[]), RELEASE);
    assert_eq!(told_default("fix the tray", &[]), NO_ONE);
    let notes = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(told_default("x", &notes(&["Fix: the tray jumps", "typo in About"])), NO_ONE);
    assert_eq!(told_default("x", &notes(&["fix the tray", "a PDF button"])), RELEASE);
    assert_eq!(told_default("x", &notes(&["#182 bug in md to pdf"])), NO_ONE);
}

/// A thread merged asks once; the card's rows write a dated line in the
/// thread; No one marks it told with nothing to say where.
#[test]
fn a_merge_asks_who_should_know_once() {
    let mut conn = db();
    let (d, t) = merged(&mut conn, "1.48 told", 100);
    assert_eq!(ask(&conn, 200).unwrap(), vec![d]);
    assert!(ask(&conn, 230).unwrap().is_empty(), "once");
    let card = crate::thread::waiting(&conn, 231).unwrap().remove(0);
    assert_eq!(card.kind, KIND);
    assert_eq!(card.thread_id, t);
    assert_eq!(card.options, vec![RELEASE, POST, NO_ONE]);
    assert_eq!(card.recommended, 0);
    assert_eq!(untold(&conn, d, 300).unwrap().len(), 1);

    let (said, note) = answer(&conn, d, &card, POST, 300).unwrap().unwrap();
    assert_eq!(said.answer, POST);
    let n = crate::desk::notes(&conn, d).unwrap();
    let n = n.iter().find(|x| x.id == note).unwrap();
    assert_eq!(n.text, "post 1.48 told (X · HN · the blog)");
    assert!(n.due_at > 300);
    let thread_of: i64 = conn
        .query_row("SELECT thread_id FROM desk_notes WHERE id = ?1", params![note], |r| r.get(0))
        .unwrap();
    assert_eq!(thread_of, t);
    assert!(answer(&conn, d, &said, NO_ONE, 301).unwrap().is_none(), "answered");

    // Told with a URL: the card would go, the thread says where.
    assert!(mark(&conn, d, t, "https://x.com/s/1", "", 400).unwrap());
    let th = crate::thread::get(&conn, d, t).unwrap().unwrap();
    assert_eq!((th.told_at, th.told_url.as_str(), th.told_how.as_str(), th.stage.as_str()), (400, "https://x.com/s/1", "post", "shipped"));
    assert!(untold(&conn, d, 500).unwrap().is_empty());
}

#[test]
fn no_one_marks_it_told_and_a_friend_is_a_row() {
    let mut conn = db();
    conn.execute(
        "INSERT INTO peers(sign_key, box_key, name, paired_at) VALUES('k', 'b', 'Trapti', 1)",
        [],
    )
    .unwrap();
    let (d, t) = merged(&mut conn, "fix the tray", 100);
    ask(&conn, 200).unwrap();
    let card = crate::thread::waiting(&conn, 201).unwrap().remove(0);
    assert_eq!(card.options, vec![RELEASE, POST, "Tell Trapti", NO_ONE]);
    assert_eq!(card.recommended, 3, "a fix: no one");
    let (_, note) = answer(&conn, d, &card, NO_ONE, 300).unwrap().unwrap();
    assert_eq!(note, 0);
    let th = crate::thread::get(&conn, d, t).unwrap().unwrap();
    assert_eq!((th.told_at, th.told_how.as_str()), (300, "none"));
    assert_eq!(
        line_for("Tell Trapti", "1.48", 0).unwrap().0,
        "tell Trapti 1.48 is out"
    );
}

/// The threads shipped before 1.48 are stamped by the migration: no card.
#[test]
fn old_threads_stay_quiet() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::thread::SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO desks(id, name, root, created_at) VALUES(1, 'w', '/w', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO threads(desk_id, name, stage, merged_at, created_at, moved_at) VALUES(1, 'old', 'shipped', 5, 1, 1)",
        [],
    )
    .unwrap();
    conn.execute_batch(COLUMNS_1_48).unwrap();
    let asked: i64 = conn
        .query_row("SELECT ask_told_at FROM threads", [], |r| r.get(0))
        .unwrap();
    assert_eq!(asked, 1);
}

#[test]
fn a_told_url_is_one_web_line() {
    assert_eq!(url_ok(" https://a.b/c ").as_deref(), Some("https://a.b/c"));
    assert_eq!(url_ok("").as_deref(), Some(""));
    assert!(url_ok("javascript:alert(1)").is_none());
    assert!(url_ok("https://a b").is_none());
}
