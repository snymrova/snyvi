use super::*;
use crate::desk::{self, LeftOff, Mark};

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::routine::SCHEMA).unwrap();
    conn.execute_batch(desk::SCHEMA).unwrap();
    conn.execute_batch(desk::POS_COLUMN).unwrap();
    conn.execute_batch(desk::HELD_COLUMN).unwrap();
    conn.execute_batch(desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(desk::LOOP_COLUMNS_1_37).unwrap();
    conn.execute_batch(crate::thread::THREAD_COLUMN).unwrap();
    conn.execute_batch(crate::links::COLUMN_1_43).unwrap();
    conn.execute_batch(crate::accounts::SCHEMA).unwrap();
    for c in crate::accounts::COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    for c in crate::peer::COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE desk_notes"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(COLUMNS_1_47).unwrap();
    conn.execute_batch("CREATE TABLE docs(id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        .unwrap();
    conn
}

const DAY: i64 = 86_400;

/// A left-off that needs the reader is on Home after two days, not before;
/// Approve takes it off and makes the next step the agent's.
#[test]
fn a_left_off_that_needs_the_reader_waits_two_days_then_asks() {
    let conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let left = LeftOff {
        text: "If you approve the migration, ship it".into(),
        at: 100,
        by: "claude-code".into(),
        needs: "You".into(),
        ..LeftOff::default()
    };
    desk::set_left_off(&conn, d, &left).unwrap();
    assert_eq!(
        desk::get(&conn, d)
            .unwrap()
            .unwrap()
            .left_off
            .unwrap()
            .needs,
        "you"
    );
    assert!(rows(&conn, 100 + LEFT_WAIT_S - 1).unwrap().is_empty());
    let w = rows(&conn, 100 + LEFT_WAIT_S).unwrap();
    assert_eq!((w.len(), w[0].kind, w[0].desk), (1, "left", d));

    assert!(approve_left_off(&conn, d, false, 100 + LEFT_WAIT_S + 5).unwrap());
    let l = desk::get(&conn, d).unwrap().unwrap().left_off.unwrap();
    assert_eq!(
        (l.needs.as_str(), l.ok_at),
        ("claude", 100 + LEFT_WAIT_S + 5)
    );
    assert!(rows(&conn, 100 + 3 * DAY).unwrap().is_empty());
    // Undo puts it back on the reader.
    approve_left_off(&conn, d, true, 0).unwrap();
    assert_eq!(rows(&conn, 100 + 3 * DAY).unwrap().len(), 1);
}

/// Unsaid is never read into the words: "if you approve" without `needs`
/// is not on Home, until the reader marks it On me.
#[test]
fn needs_is_said_never_guessed() {
    let conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let left = LeftOff {
        text: "If you approve, ship it".into(),
        at: 100,
        needs: "whenever".into(),
        ..LeftOff::default()
    };
    desk::set_left_off(&conn, d, &left).unwrap();
    assert_eq!(
        desk::get(&conn, d)
            .unwrap()
            .unwrap()
            .left_off
            .unwrap()
            .needs,
        ""
    );
    assert!(rows(&conn, 100 + 3 * DAY).unwrap().is_empty());
    assert!(set_needs(&conn, d, "you").unwrap());
    assert_eq!(rows(&conn, 100 + 3 * DAY).unwrap().len(), 1);
}

/// A plan sent for two lines grows Approve; a day without it is a row on
/// Home; Approve marks both lines and takes the row away.
#[test]
fn a_plan_is_approved_for_every_line_it_was_sent_for() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let a = desk::add_note(&mut conn, d, "dates on lines", 0)
        .unwrap()
        .unwrap()
        .id;
    let b = desk::add_note(&mut conn, d, "waiting on you", 0)
        .unwrap()
        .unwrap()
        .id;
    conn.execute(
        "INSERT INTO docs(id, title) VALUES('7a1c2b3d4e', 'Plan 1.47')",
        [],
    )
    .unwrap();
    for id in [a, b] {
        let m = Mark {
            stage: "planned".into(),
            by: "claude-code".into(),
            doc: "7a1c2b3d4e".into(),
            ..Mark::default()
        };
        assert!(desk::mark_note(&conn, d, id, &m, 50).unwrap());
    }
    assert_eq!(plan_for(&conn, "nope").unwrap(), None);
    let p = plan_for(&conn, "7a1c2b3d4e").unwrap().unwrap();
    assert_eq!((p.desk, p.notes.clone(), p.ok_at), (d, vec![a, b], 0));

    assert!(rows(&conn, 50 + PLAN_WAIT_S - 1).unwrap().is_empty());
    let w = rows(&conn, 50 + PLAN_WAIT_S).unwrap();
    assert_eq!(
        (w[0].kind, w[0].text.as_str(), w[0].notes.clone()),
        ("plan", "Plan 1.47", vec![a, b])
    );

    assert_eq!(
        approve_plan(&conn, d, "7a1c2b3d4e", false, 60).unwrap(),
        vec![a, b]
    );
    assert_eq!(plan_for(&conn, "7a1c2b3d4e").unwrap().unwrap().ok_at, 60);
    assert!(rows(&conn, 50 + 2 * DAY).unwrap().is_empty());
    assert!(desk::notes(&conn, d).unwrap().iter().all(|n| n.ok_at == 60));
    approve_plan(&conn, d, "7a1c2b3d4e", true, 70).unwrap();
    assert_eq!(plan_for(&conn, "7a1c2b3d4e").unwrap().unwrap().ok_at, 0);
}
