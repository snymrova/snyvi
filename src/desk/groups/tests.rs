use super::*;
use crate::desk;
use crate::desk::tests::db;

fn tab(conn: &mut Connection, desk: i64, name: &str) -> Created {
    let tx = conn.transaction().unwrap();
    let made = create(&tx, desk, name, 1).unwrap().unwrap();
    tx.commit().unwrap();
    made
}

fn open_in(conn: &mut Connection, desk: i64, grp: i64, back: bool) -> Opened {
    open_pane(conn, desk, "/p", "", false, (grp, back), 0).unwrap()
}

/// (grp, slot) of every pane on a desk, in the order `get` lists them.
fn placed(conn: &Connection, desk: i64) -> Vec<(i64, i64)> {
    get(conn, desk)
        .unwrap()
        .unwrap()
        .panes
        .iter()
        .map(|p| (p.grp, p.slot))
        .collect()
}

fn zeros(conn: &Connection, desk: i64) -> (i64, i64) {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM panes WHERE desk_id = ?1 AND grp = 0),
                (SELECT COUNT(*) FROM panes_closed WHERE desk_id = ?1 AND grp = 0)",
        params![desk],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

/// A desk with no tabs is the desk it was: its panes at 0, no groups in
/// its JSON, its own layout. The first `+` makes two groups, puts every
/// pane and closed pane that was at 0 into the first, "Tab 1", in the
/// desk's folder like every tab, holding the desk's dividers, and shows the new one.
#[test]
fn the_first_tab_splits_the_desk_and_leaves_no_row_at_zero() {
    let mut conn = db();
    let d = desk::create(&conn, "/w/ohmydog", None, 0).unwrap().id;
    for _ in 0..3 {
        assert!(matches!(open_in(&mut conn, d, 0, false), Opened::Pane(_)));
    }
    let gone = get(&conn, d).unwrap().unwrap().panes[2].id.clone();
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &gone, 5).unwrap().unwrap();
    tx.commit().unwrap();
    assert!(layout(&conn, d, 0, (0.3, 0.7), Some(2)).unwrap());
    assert_eq!(placed(&conn, d), [(0, 1), (0, 2)]);
    assert!(get(&conn, d).unwrap().unwrap().groups.is_empty());
    assert_eq!(default_grp(&conn, d).unwrap(), 0);

    let made = tab(&mut conn, d, "  insta ");
    let first = made
        .first
        .expect("the desk's first tab makes the first group");
    assert_ne!(first, made.id);
    assert_eq!(zeros(&conn, d), (0, 0), "nothing left at 0");
    let desk = get(&conn, d).unwrap().unwrap();
    assert_eq!(placed(&conn, d), [(first, 1), (first, 2)]);
    let names: Vec<(&str, &str)> = desk
        .groups
        .iter()
        .map(|g| (g.name.as_str(), g.root.as_str()))
        .collect();
    assert_eq!(names, [("Tab 1", "/w/ohmydog"), ("insta", "/w/ohmydog")]);
    let g = &desk.groups[0];
    assert_eq!(
        (g.col, g.row, g.full_slot),
        (0.3, 0.7, 2),
        "the desk's layout"
    );
    assert_eq!(desk.grp_shown, made.id, "the new tab is the one shown");

    // The closed pane comes back into the first tab, not a group 0 no
    // one shows.
    let Restored::Pane(p) = restore_pane(&mut conn, &gone).unwrap() else {
        panic!("back")
    };
    assert_eq!((p.grp, p.slot), (first, 3));

    // A second `+` makes one more and splits nothing.
    let third = tab(&mut conn, d, "");
    assert_eq!(third.first, None);
    assert_eq!(get(&conn, d).unwrap().unwrap().groups[2].name, "Tab 3");
}

/// Four in the grid and four in the back, per tab: three tabs hold
/// twenty-four, and the ninth in any one is refused.
#[test]
fn eight_panes_in_each_of_three_tabs() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let a = tab(&mut conn, d, "b");
    let grps = [a.first.unwrap(), a.id, tab(&mut conn, d, "c").id];
    for g in grps {
        for back in [false, true] {
            for _ in 0..GRID {
                assert!(matches!(open_in(&mut conn, d, g, back), Opened::Pane(_)));
            }
            assert!(matches!(open_in(&mut conn, d, g, back), Opened::DeskFull));
        }
    }
    assert_eq!(panes_open(&conn).unwrap(), 3 * SLOTS);
    // Each tab's slots run 1 to 8 on their own.
    for g in grps {
        let mut s: Vec<i64> = placed(&conn, d)
            .into_iter()
            .filter(|(x, _)| *x == g)
            .map(|(_, s)| s)
            .collect();
        s.sort_unstable();
        assert_eq!(s, (1..=SLOTS).collect::<Vec<_>>());
    }
}

/// A close in one tab closes up that tab only; a move and a send to the
/// back stay in their tab; full view is each tab's own.
#[test]
fn a_close_in_one_tab_leaves_the_others_where_they_are() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let (one, two) = (made.first.unwrap(), made.id);
    for g in [one, two] {
        for _ in 0..3 {
            open_in(&mut conn, d, g, false);
        }
    }
    assert!(layout(&conn, d, one, (0.5, 0.5), Some(3)).unwrap());
    assert!(layout(&conn, d, two, (0.4, 0.6), Some(2)).unwrap());
    let first_of_one = get(&conn, d)
        .unwrap()
        .unwrap()
        .panes
        .into_iter()
        .find(|p| p.grp == one && p.slot == 1)
        .unwrap()
        .id;
    let tx = conn.transaction().unwrap();
    let freed = close_pane(&tx, &first_of_one, 2).unwrap().unwrap();
    tx.commit().unwrap();
    assert_eq!(
        freed,
        Freed {
            desk_id: d,
            grp: one,
            slot: 1
        }
    );
    let mut p = placed(&conn, d);
    p.sort_unstable();
    let mut want = vec![(one, 1), (one, 2), (two, 1), (two, 2), (two, 3)];
    want.sort_unstable();
    assert_eq!(p, want);
    let gs = get(&conn, d).unwrap().unwrap().groups;
    assert_eq!(gs[0].full_slot, 2, "one's full view followed its pane");
    assert_eq!(
        (gs[1].col, gs[1].full_slot),
        (0.4, 2),
        "two's is its own and untouched"
    );

    // A move in two leaves one alone.
    let tx = conn.transaction().unwrap();
    assert!(move_pane(&tx, d, two, (1, 3)).unwrap());
    assert!(!move_pane(&tx, d, one, (3, 1)).unwrap(), "one has no 3 now");
    tx.commit().unwrap();
}

/// A closed panel goes back to its own tab; a tab that filled up while it
/// was closed refuses it, as a full desk did.
#[test]
fn a_restore_into_a_full_tab_is_refused() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let two = made.id;
    for _ in 0..GRID {
        open_in(&mut conn, d, two, false);
    }
    let id = get(&conn, d)
        .unwrap()
        .unwrap()
        .panes
        .into_iter()
        .find(|p| p.grp == two)
        .unwrap()
        .id;
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &id, 3).unwrap().unwrap();
    tx.commit().unwrap();
    open_in(&mut conn, d, two, false);
    assert!(matches!(
        restore_pane(&mut conn, &id).unwrap(),
        Restored::DeskFull
    ));
    // The other tab has room, and a full one is no reason to put it there.
    assert!(get(&conn, d)
        .unwrap()
        .unwrap()
        .panes
        .iter()
        .all(|p| p.id != id));
}

/// A panel moved to another tab takes that tab's lowest free slot on its
/// own side, the tab it left closes up, and a full side refuses.
#[test]
fn a_panel_moves_to_another_tab_and_its_old_tab_closes_up() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let (one, two) = (made.first.unwrap(), made.id);
    for _ in 0..3 {
        open_in(&mut conn, d, one, false);
    }
    open_in(&mut conn, d, two, false);
    assert!(layout(&conn, d, one, (0.5, 0.5), Some(3)).unwrap());
    let at = |conn: &Connection, g: i64, s: i64| {
        get(conn, d)
            .unwrap()
            .unwrap()
            .panes
            .into_iter()
            .find(|p| p.grp == g && p.slot == s)
            .map(|p| p.id)
    };
    let moving = at(&conn, one, 1).unwrap();
    let tx = conn.transaction().unwrap();
    assert_eq!(
        regroup(&tx, &moving, two).unwrap(),
        Regrouped::Moved {
            desk_id: d,
            from_grp: one,
            from: 1,
            to_grp: two,
            to: 2
        }
    );
    assert_eq!(regroup(&tx, &moving, two).unwrap(), Regrouped::Stays);
    assert_eq!(regroup(&tx, &moving, 9999).unwrap(), Regrouped::Gone);
    assert_eq!(regroup(&tx, "nope", one).unwrap(), Regrouped::Gone);
    tx.commit().unwrap();
    assert_eq!(at(&conn, two, 2), Some(moving));
    assert!(at(&conn, one, 3).is_none(), "one closed up");
    assert_eq!(get(&conn, d).unwrap().unwrap().groups[0].full_slot, 2);

    for _ in 0..2 {
        open_in(&mut conn, d, two, false);
    }
    let last = at(&conn, one, 1).unwrap();
    let tx = conn.transaction().unwrap();
    assert_eq!(regroup(&tx, &last, two).unwrap(), Regrouped::Full);
}

/// Closing a tab closes its panels with it, nothing deleted; Undo brings
/// them back where they were. The last open tab stays.
#[test]
fn a_closed_tab_comes_back_with_its_panels_and_the_last_one_stays() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let (one, two) = (made.first.unwrap(), made.id);
    open_in(&mut conn, d, one, false);
    open_in(&mut conn, d, two, false);
    open_in(&mut conn, d, two, true);
    assert_eq!(get(&conn, d).unwrap().unwrap().grp_shown, two);

    let Closed::Panes(ids) = close(&mut conn, d, two, 7).unwrap() else {
        panic!("closed")
    };
    assert_eq!(ids.len(), 2);
    let desk = get(&conn, d).unwrap().unwrap();
    assert_eq!(desk.groups.len(), 1);
    assert_eq!(placed(&conn, d), [(one, 1)]);
    assert_eq!(desk.grp_shown, one, "the reopen default moved off it");
    assert_eq!(close(&mut conn, d, one, 8).unwrap(), Closed::Last);
    assert_eq!(close(&mut conn, d, two, 8).unwrap(), Closed::Gone);

    assert!(restore(&mut conn, d, two).unwrap());
    assert!(!restore(&mut conn, d, two).unwrap(), "already back");
    let mut p = placed(&conn, d);
    p.sort_unstable();
    assert_eq!(p, [(one, 1), (two, 1), (two, GRID + 1)]);
}

/// A desk closed with tabs reopens with each panel in its own tab.
#[test]
fn a_desk_with_tabs_reopens_with_its_panels_in_their_tabs() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let (one, two) = (made.first.unwrap(), made.id);
    for g in [one, two, two] {
        open_in(&mut conn, d, g, false);
    }
    assert_eq!(desk::close(&mut conn, d, 9).unwrap().unwrap().len(), 3);
    assert!(reopen(&mut conn, d).unwrap());
    let mut p = placed(&conn, d);
    p.sort_unstable();
    assert_eq!(p, [(one, 1), (two, 1), (two, 2)]);
}

/// Rename, reorder and the reopen default, each refused off its desk.
#[test]
fn a_tab_is_renamed_moved_and_shown_on_its_own_desk_only() {
    let mut conn = db();
    let d = desk::create(&conn, "/w", None, 0).unwrap().id;
    let other = desk::create(&conn, "/o", None, 0).unwrap().id;
    let made = tab(&mut conn, d, "two");
    let three = tab(&mut conn, d, "three").id;
    let one = made.first.unwrap();
    assert!(rename(&conn, d, made.id, " web ").unwrap());
    assert!(!rename(&conn, d, made.id, "  ").unwrap());
    assert!(!rename(&conn, other, made.id, "x").unwrap());
    assert!(move_to(&mut conn, d, three, 0).unwrap());
    let order: Vec<i64> = of(&conn, d).unwrap().iter().map(|g| g.id).collect();
    assert_eq!(order, [three, one, made.id]);
    assert!(!move_to(&mut conn, other, three, 0).unwrap());
    assert!(show(&conn, d, one).unwrap());
    assert!(!show(&conn, other, one).unwrap());
    assert_eq!(default_grp(&conn, d).unwrap(), one);
    assert_eq!(of(&conn, d).unwrap()[2].name, "web");
    // A panel opened with no tab named lands in the shown one.
    let Opened::Pane(p) = open_in(&mut conn, d, 0, false) else {
        panic!("room")
    };
    assert_eq!(p.grp, one);
    assert!(focus(&conn, d, one, &p.id).unwrap());
    assert!(!focus(&conn, d, three, &p.id).unwrap(), "not in that tab");
}
