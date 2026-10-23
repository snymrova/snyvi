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
    conn.execute_batch(crate::thread::TAKEN_COLUMN).unwrap();
    conn.execute_batch(crate::thread::PR_STATE_1_43).unwrap();
    for c in crate::peer::COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE desk_notes"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::told::COLUMNS_1_48).unwrap();
    conn
}

fn line(text: &str, due: &str) -> Line {
    Line {
        text: text.into(),
        due: due.into(),
    }
}

/// A set is many suggestions, dated, in the panel's thread; Keep all keeps
/// the set and not a suggestion written apart from it.
#[test]
fn a_launch_is_a_set_kept_at_once() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let alone = crate::desk::suggest_note(&mut conn, d, "an older one", "Claude", 5).unwrap();
    assert!(matches!(alone, crate::desk::Suggested::Note(_)));
    let set = vec![
        line("pictures and copy", "in 2 days"),
        line("post it", "in 9 days"),
        line("Show HN in 11 days", ""),
        line("write what happened", "someday"),
        line("  ", ""),
    ];
    let Lines::Set(ids, undated) = suggest_lines(&mut conn, d, &set, "Claude", "", 10).unwrap()
    else {
        panic!()
    };
    assert_eq!(ids.len(), 4);
    assert_eq!(undated, vec!["write what happened"]);
    let notes = crate::desk::notes(&conn, d).unwrap();
    let hn = notes.iter().find(|n| n.id == ids[2]).unwrap();
    assert_eq!(hn.text, "Show HN");
    assert_eq!(hn.due_at, 10 + 11 * 86_400);
    assert!(notes
        .iter()
        .filter(|n| ids.contains(&n.id))
        .all(|n| n.suggested_by == "Claude"));

    assert_eq!(keep_set(&conn, d, ids[0]).unwrap(), 4);
    let notes = crate::desk::notes(&conn, d).unwrap();
    assert!(notes
        .iter()
        .filter(|n| ids.contains(&n.id))
        .all(|n| n.suggested_by.is_empty()));
    assert_eq!(
        notes.iter().filter(|n| !n.suggested_by.is_empty()).count(),
        1,
        "the one apart waits"
    );
    assert_eq!(keep_set(&conn, d, ids[0]).unwrap(), 0, "kept already");
}

#[test]
fn a_set_has_its_bounds() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let many: Vec<Line> = (0..13).map(|i| line(&format!("step {i}"), "")).collect();
    assert_eq!(
        suggest_lines(&mut conn, d, &many, "", "", 1).unwrap(),
        Lines::TooMany
    );
    assert_eq!(
        suggest_lines(&mut conn, d, &[line(" ", "")], "", "", 1).unwrap(),
        Lines::Empty
    );
    for i in 0..3 {
        crate::desk::suggest_note(&mut conn, d, &format!("s{i}"), "Claude", 2).unwrap();
    }
    assert_eq!(
        suggest_lines(&mut conn, d, &[line("one", "")], "", "", 3).unwrap(),
        Lines::Full
    );
    assert_eq!(
        suggest_lines(&mut conn, 99, &[line("one", "")], "", "", 3).unwrap(),
        Lines::NoSuchDesk
    );
}
