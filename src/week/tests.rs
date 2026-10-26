use super::*;
use time::{Date, Month};

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::routine::SCHEMA).unwrap();
    conn.execute_batch(crate::routine::DRAFT_COLUMNS_1_53)
        .unwrap();
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
    conn.execute_batch(crate::thread::TAKEN_COLUMN).unwrap();
    conn.execute_batch(crate::thread::PR_STATE_1_43).unwrap();
    conn.execute_batch(crate::thread::CMD_COLUMN).unwrap();
    conn.execute_batch(crate::thread::GROUP_COLUMN).unwrap();
    conn.execute_batch(crate::thread::AWAY_COLUMN_1_44).unwrap();
    conn.execute_batch(crate::thread::REMOVED_BY_1_53).unwrap();
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
    conn.execute_batch(crate::told::COLUMNS_1_48).unwrap();
    conn.execute_batch(COLUMNS_1_48).unwrap();
    // A plan's title is read from the documents (`waiting::rows`).
    conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        .unwrap();
    conn
}

fn ist() -> UtcOffset {
    UtcOffset::from_hms(5, 30, 0).unwrap()
}

/// A wall-clock time in IST in October 2026.
fn at(d: u8, h: u8, m: u8) -> i64 {
    PrimitiveDateTime::new(
        Date::from_calendar_date(2026, Month::October, d).unwrap(),
        Time::from_hms(h, m, 0).unwrap(),
    )
    .assume_offset(ist())
    .unix_timestamp()
}

/// 25 October 2026 is a Sunday.
#[test]
fn the_week_is_sunday_at_eight() {
    assert_eq!(sunday_at(at(25, 20, 0), ist()), at(25, 20, 0));
    assert_eq!(sunday_at(at(25, 19, 59), ist()), at(18, 20, 0));
    assert_eq!(sunday_at(at(27, 5, 0), ist()), at(25, 20, 0));
    assert_eq!(sunday_at(at(31, 23, 0), ist()), at(25, 20, 0));
}

#[test]
fn the_box_is_up_from_sunday_eight_to_tuesday_six_and_files_lines() {
    let conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let s = sunday(1_800_000_000);
    assert!(week(&conn, s - 1).unwrap().is_none_or(|w| w.at < s));
    let w = week(&conn, s + 60).unwrap().expect("up on Sunday evening");
    assert_eq!(w.at, s);
    assert!(
        week(&conn, s + SHOWN_S).unwrap().is_none(),
        "gone on Tuesday 06:00"
    );

    let ship = Field {
        text: "the PDF button".into(),
        desk: d,
        thread: 0,
    };
    let ids = file(&conn, Some(&ship), None, s + 120).unwrap();
    assert_eq!(ids.len(), 1);
    assert!(
        week(&conn, s + 180).unwrap().is_none(),
        "filed: put away for this Sunday"
    );
    let (text, due) = ship_line(&conn, d, s + 200).unwrap().unwrap();
    assert_eq!(text, "the PDF button");
    assert!(due > s, "due on Friday");
    assert!(ship_line(&conn, d + 1, s + 200).unwrap().is_none());
    assert!(
        week(&conn, s + 7 * 86_400 + 60).unwrap().is_some(),
        "next Sunday again"
    );

    set_off(&conn, true).unwrap();
    assert!(
        week(&conn, s + 7 * 86_400 + 60).unwrap().is_none(),
        "hidden for good"
    );
}

#[test]
fn the_numbers_come_from_the_rows() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    for (i, t) in ["a", "b", "c"].iter().enumerate() {
        let n = crate::desk::add_note(&mut conn, d, t, 100)
            .unwrap()
            .unwrap();
        conn.execute(
            "UPDATE desk_notes SET done_at = ?2, done_by = ?3 WHERE id = ?1",
            params![
                n.id,
                100 + 3600 * (i as i64 + 1),
                if i == 0 { "" } else { "Claude" }
            ],
        )
        .unwrap();
    }
    let n = numbers(&conn, 0, 20_000).unwrap();
    assert_eq!((n.ticked, n.without_you, n.median_s), (3, 2, 7200));
}

#[test]
fn two_reopens_in_a_week_suggest_a_rule_once() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let a = crate::desk::add_note(&mut conn, d, "the tray", 0)
        .unwrap()
        .unwrap()
        .id;
    let b = crate::desk::add_note(&mut conn, d, "the corner", 0)
        .unwrap()
        .unwrap()
        .id;
    let now = 30 * 86_400;
    crate::desk::check_note(&conn, d, a, false, "broken in the dark theme", now).unwrap();
    assert_eq!(
        reopen_rule(&mut conn, d, now).unwrap(),
        None,
        "one is not a pattern"
    );
    crate::desk::check_note(&conn, d, b, false, "the dark theme again", now + 60).unwrap();
    let id = reopen_rule(&mut conn, d, now + 60)
        .unwrap()
        .expect("a rule");
    let n = crate::desk::notes(&conn, d)
        .unwrap()
        .into_iter()
        .find(|n| n.id == id)
        .unwrap();
    assert_eq!(n.suggested_by, "snyvi");
    assert!(
        n.text.starts_with("Before ticking: check dark"),
        "{}",
        n.text
    );
    assert_eq!(
        reopen_rule(&mut conn, d, now + 120).unwrap(),
        None,
        "once a week"
    );
}
