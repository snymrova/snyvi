use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    conn
}

fn pane_on(conn: &mut Connection, desk: i64) -> String {
    match crate::desk::open_pane(conn, desk, "/w", "", 0).unwrap() {
        crate::desk::Opened::Pane(p) => p.id,
        o => panic!("no pane: {o:?}"),
    }
}

#[test]
fn a_panel_runs_as_its_own_account_or_its_desks() {
    assert_eq!(effective(0, None), 0);
    assert_eq!(effective(2, None), 2);
    assert_eq!(effective(2, Some(3)), 3);
    // A panel set to /login on a desk that is not stays on /login.
    assert_eq!(effective(2, Some(DEFAULT)), DEFAULT);
}

#[test]
fn taking_an_account_away_puts_what_used_it_back_on_login() {
    let mut conn = db();
    let work = add(&conn, "Work", 10).unwrap();
    let home = add(&conn, "Home", 11).unwrap();
    assert_eq!(list(&conn).unwrap(), vec![work.clone(), home.clone()]);
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let p1 = pane_on(&mut conn, d);
    let p2 = pane_on(&mut conn, d);
    assert!(set_desk(&conn, d, work.id).unwrap());
    assert!(set_pane(&conn, &p1, Some(work.id)).unwrap());
    assert!(set_pane(&conn, &p2, Some(home.id)).unwrap());
    let desk = crate::desk::get(&conn, d).unwrap().unwrap();
    assert_eq!(desk.account, work.id);
    assert_eq!(desk.panes[0].account, Some(work.id));

    assert!(remove(&mut conn, work.id).unwrap());
    let desk = crate::desk::get(&conn, d).unwrap().unwrap();
    assert_eq!(desk.account, DEFAULT, "the desk is back on /login");
    assert_eq!(
        desk.panes[0].account, None,
        "the panel follows its desk again"
    );
    assert_eq!(
        desk.panes[1].account,
        Some(home.id),
        "the other account is untouched"
    );
    assert!(!remove(&mut conn, work.id).unwrap(), "gone once");
    assert!(
        !remove(&mut conn, DEFAULT).unwrap(),
        "/login is not a row to take away"
    );
    assert!(exists(&conn, DEFAULT).unwrap());
    assert!(!exists(&conn, work.id).unwrap());
}

#[test]
fn a_closed_panel_comes_back_as_the_account_it_ran_as() {
    let mut conn = db();
    let work = add(&conn, "Work", 10).unwrap();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let p = pane_on(&mut conn, d);
    set_pane(&conn, &p, Some(work.id)).unwrap();
    let tx = conn.transaction().unwrap();
    crate::desk::close_pane(&tx, &p, 5).unwrap().unwrap();
    tx.commit().unwrap();
    match crate::desk::restore_pane(&mut conn, &p).unwrap() {
        crate::desk::Restored::Pane(back) => assert_eq!(back.account, Some(work.id)),
        o => panic!("not restored: {o:?}"),
    }
}

#[test]
fn the_panels_that_follow_a_desk_are_the_ones_without_their_own() {
    let mut conn = db();
    let work = add(&conn, "Work", 10).unwrap();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let p1 = pane_on(&mut conn, d);
    let p2 = pane_on(&mut conn, d);
    set_pane(&conn, &p2, Some(work.id)).unwrap();
    assert_eq!(following(&conn, d).unwrap(), vec![p1]);
}

#[test]
fn a_label_is_one_short_line() {
    assert_eq!(
        clean_label("  Work \n laptop ").as_deref(),
        Some("Work laptop")
    );
    assert_eq!(clean_label(" \n "), None);
    assert_eq!(
        clean_label(&"x".repeat(90)).unwrap().chars().count(),
        LABEL_CHARS
    );
}

#[test]
fn a_token_is_a_setup_token_and_an_api_key_is_sent_to_keys() {
    let tok = format!("sk-ant-oat01-{}", "a1B2_c-".repeat(14));
    assert_eq!(valid_token(&tok), Ok(()));
    assert!(valid_token("sk-ant-api03-abcdef")
        .unwrap_err()
        .contains("ANTHROPIC_API_KEY"));
    assert!(valid_token("ghp_abcdef").is_err());
    assert!(valid_token("sk-ant-oat01-short").is_err());
    assert!(valid_token(&format!("{tok} trailing")).is_err());
}
