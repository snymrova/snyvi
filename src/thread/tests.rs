use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(crate::desk::HELD_COLUMN).unwrap();
    conn.execute_batch(crate::desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(crate::desk::LOOP_COLUMNS_1_37).unwrap();
    conn.execute_batch(THREAD_COLUMN).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(CMD_COLUMN).unwrap();
    conn.execute_batch(TAKEN_COLUMN).unwrap();
    conn.execute_batch(GROUP_COLUMN).unwrap();
    conn.execute_batch(PR_STATE_1_43).unwrap();
    conn.execute_batch(AWAY_COLUMN_1_44).unwrap();
    conn.execute_batch(REMOVED_BY_1_53).unwrap();
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::due::TURN_COLUMN_1_47).unwrap();
    conn.execute_batch(crate::told::COLUMNS_1_48).unwrap();
    for c in SUGGEST_COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    for c in ON_YOU_1_36 {
        conn.execute_batch(c).unwrap();
    }
    for c in crate::peer::COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE desk_notes"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn
}

fn desk(conn: &mut Connection) -> (i64, Vec<i64>) {
    let d = crate::desk::create(conn, "/w", None, 0).unwrap().id;
    let notes = ["one", "two", "three"]
        .iter()
        .map(|t| crate::desk::add_note(conn, d, t, 0).unwrap().unwrap().id)
        .collect();
    // The panels the tests ask from are open: a turn from a panel with no
    // row is stale (`mark_stale`), and "gone" is the one that is not.
    for (slot, p) in ["p1", "p2", "p3"].iter().enumerate() {
        conn.execute(
            "INSERT OR IGNORE INTO panes(id, desk_id, slot, cwd, created_at) VALUES (?1, ?2, ?3, '/w', 0)",
            params![p, d, slot as i64 + 1],
        )
        .unwrap();
    }
    (d, notes)
}

fn start_as(conn: &mut Connection, d: i64, name: &str, pane: &str, notes: &[i64]) -> Started {
    start(
        conn,
        d,
        &Start {
            name: name.into(),
            notes: notes.to_vec(),
            pane: pane.into(),
            by: "claude-code".into(),
            ..Start::default()
        },
        10,
    )
    .unwrap()
}

/// A thread groups notes, and the same name again is the same thread: an
/// agent that starts "Home + friends" twice does not make two.
#[test]
fn a_thread_groups_notes_and_its_name_again_is_the_same_thread() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    let Started::New(t) = start_as(&mut conn, d, "Home + friends", "p1", &n[..2]) else {
        panic!()
    };
    assert_eq!(t.stage, "planned");
    assert_eq!(t.notes, n[..2]);
    let Started::Again(again) = start_as(&mut conn, d, "home + FRIENDS", "p2", &n[2..]) else {
        panic!()
    };
    assert_eq!(again.id, t.id);
    assert_eq!(again.notes, n);
    assert_eq!(again.pane, "p2");
    // The note wears it.
    let notes = crate::desk::notes(&conn, d).unwrap();
    assert!(notes.iter().all(|x| x.thread == t.id));
}

/// A note is in one thread at most: putting it in a second takes it out of
/// the first.
#[test]
fn a_note_moves_to_the_thread_it_was_last_put_in() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    let Started::New(a) = start_as(&mut conn, d, "A", "p1", &n) else {
        panic!()
    };
    let Started::New(b) = start_as(&mut conn, d, "B", "p1", &n[..1]) else {
        panic!()
    };
    assert_eq!(get(&conn, d, a.id).unwrap().unwrap().notes, n[1..]);
    assert_eq!(get(&conn, d, b.id).unwrap().unwrap().notes, n[..1]);
}

/// `move_thread` with no id is the pane's thread; parked keeps a next step,
/// and leaving parked drops it. Only shipped stamps a date.
#[test]
fn moving_the_panes_thread_parks_and_ships_it() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    start_as(&mut conn, d, "A", "p1", &[]);
    let mv = |stage: &str, next: &str| Move {
        stage: stage.into(),
        next: next.into(),
        pane: "p1".into(),
        ..Move::default()
    };
    let Moved::Thread(t) =
        move_thread(&mut conn, d, None, &mv("parked", "rebase first"), 20).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (t.stage.as_str(), t.next.as_str()),
        ("parked", "rebase first")
    );
    let Moved::Thread(t) = move_thread(&mut conn, d, None, &mv("building", ""), 30).unwrap() else {
        panic!()
    };
    assert_eq!(
        (t.stage.as_str(), t.next.as_str(), t.shipped_at),
        ("building", "", 0)
    );
    let Moved::Thread(t) = move_thread(&mut conn, d, None, &mv("shipped", ""), 40).unwrap() else {
        panic!()
    };
    assert_eq!(t.shipped_at, 40);
    // Another pane has no thread to move.
    let other = Move {
        stage: "review".into(),
        pane: "p9".into(),
        ..Move::default()
    };
    assert_eq!(
        move_thread(&mut conn, d, None, &other, 50).unwrap(),
        Moved::NoThread
    );
    assert_eq!(
        move_thread(&mut conn, d, None, &mv("done", ""), 50).unwrap(),
        Moved::BadStage
    );
}

/// What the mod sees lands on the pane's thread and is marked seen; a
/// commit on another branch is not the thread's (#167), and a merge is
/// dated once.
#[test]
fn what_the_mod_saw_is_filed_on_the_panes_thread() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    assert!(seen(&mut conn, d, "p1", &Seen::default(), 1)
        .unwrap()
        .is_none());
    start_as(&mut conn, d, "A", "p1", &[]);
    let s = |branch: &str, commits: i64| Seen {
        branch: branch.into(),
        commits,
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &s("claude/a", 0), 2).unwrap();
    seen(&mut conn, d, "p1", &s("", 1), 3).unwrap();
    let (t, changed) = seen(&mut conn, d, "p1", &s("claude/a", 2), 4)
        .unwrap()
        .unwrap();
    assert_eq!(
        (t.branch.as_str(), t.commits, t.seen, changed),
        ("claude/a", 3, true, true)
    );
    let (t, changed) = seen(&mut conn, d, "p1", &s("claude/b", 1), 5)
        .unwrap()
        .unwrap();
    assert_eq!(
        (t.branch.as_str(), t.commits, changed),
        ("claude/a", 3, false),
        "a commit on another branch is another thread's"
    );
    let m = Seen {
        pr: "https://github.com/o/r/pull/57".into(),
        merged: "7E1C0A2".into(),
        ..Seen::default()
    };
    let (t, changed) = seen(&mut conn, d, "p1", &m, 6).unwrap().unwrap();
    assert_eq!(
        (t.pr.as_str(), t.merged.as_str(), t.merged_at, changed),
        ("57", "7e1c0a2", 6, true)
    );
    assert_eq!(
        (t.pr_state.as_str(), t.stage.as_str()),
        ("merged", "shipped")
    );
    // The same sighting again changes nothing: the mod's CI watch says the
    // same thing every minute, and only the first time is an event.
    let (t, changed) = seen(&mut conn, d, "p1", &m, 7).unwrap().unwrap();
    assert_eq!((t.merged_at, changed), (6, false));
    let ci = Seen {
        ci: "passing".into(),
        ..Seen::default()
    };
    assert!(seen(&mut conn, d, "p1", &ci, 8).unwrap().unwrap().1);
    assert!(!seen(&mut conn, d, "p1", &ci, 9).unwrap().unwrap().1);
    // Nothing that is not a branch gets in.
    let (t, changed) = seen(&mut conn, d, "p1", &s("a b", 0), 10).unwrap().unwrap();
    assert_eq!((t.branch.as_str(), changed), ("claude/a", false));
}

/// The first sight of the reader's own merge ticks the thread's open notes,
/// by "merged", with the merge and the PR; a note outside the thread stays
/// open, and one the reader unticks is not ticked again by the same merge
/// seen again.
#[test]
fn a_merge_ticks_the_threads_notes() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    start_as(&mut conn, d, "A", "p1", &n[..2]);
    let open = |c: &Connection| {
        crate::desk::notes(c, d)
            .unwrap()
            .into_iter()
            .filter(|x| !x.done)
            .count()
    };
    let pr = Seen {
        pr: "https://github.com/o/r/pull/67".into(),
        ci: "passing".into(),
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &pr, 2).unwrap();
    assert_eq!(open(&conn), 3, "a PR alone ticks nothing");
    let m = Seen {
        merged: "B6E235B".into(),
        mine: true,
        ..pr
    };
    let (_, changed) = seen(&mut conn, d, "p1", &m, 3).unwrap().unwrap();
    assert!(changed);
    let notes = crate::desk::notes(&conn, d).unwrap();
    let done: Vec<_> = notes.iter().filter(|x| x.done).collect();
    assert_eq!(done.len(), 2);
    for x in &done {
        assert!(n[..2].contains(&x.id));
        assert_eq!(
            (
                x.done_by.as_str(),
                x.done_commit.as_str(),
                x.done_evidence.as_str()
            ),
            ("merged", "b6e235b", "https://github.com/o/r/pull/67")
        );
    }
    conn.execute("UPDATE desk_notes SET done_at = 0 WHERE id = ?1", [n[0]])
        .unwrap();
    seen(&mut conn, d, "p1", &m, 4).unwrap();
    assert_eq!(open(&conn), 2);
}

/// A merge git found, which no panel saw, ships the thread as of the merge
/// and ticks nothing: its notes wait on the reader's check (7c0fc42885).
#[test]
fn a_merge_no_panel_saw_ships_and_ticks_nothing() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    start_as(&mut conn, d, "A", "p1", &n[..2]);
    let t = of_pane(&conn, d, "p1").unwrap().unwrap().id;
    assert!(
        sweep_due(&conn, d).unwrap().is_empty(),
        "no branch, no question"
    );
    let b = Seen {
        branch: "claude/a".into(),
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &b, 2).unwrap();
    assert!(sweep_due(&conn, d).unwrap().is_empty(), "still at its plan");
    conn.execute("UPDATE threads SET stage = 'review' WHERE id = ?1", [t])
        .unwrap();
    let u = sweep_due(&conn, d).unwrap();
    assert_eq!(u.len(), 1);
    assert_eq!(
        (u[0].id, u[0].dir.as_str(), u[0].branch.as_str(), u[0].own),
        (t, "/w", "claude/a", false),
        "the desk's folder when the thread has none"
    );
    assert!(!landed(&conn, d, t, "not a sha", 5).unwrap());
    assert!(landed(&conn, d, t, "CB8D8A5", 5).unwrap());
    assert!(!landed(&conn, d, t, "cb8d8a5", 6).unwrap(), "once");
    let t = get(&conn, d, t).unwrap().unwrap();
    assert_eq!(
        (t.stage.as_str(), t.merged.as_str(), t.merged_at),
        ("shipped", "cb8d8a5", 5)
    );
    assert!(crate::desk::notes(&conn, d)
        .unwrap()
        .iter()
        .all(|x| !x.done));
    let u = sweep_due(&conn, d).unwrap();
    assert_eq!(
        (u.len(), u[0].merged),
        (1, true),
        "a guessed merge is read once for its PR"
    );
    assert!(no_pr(&conn, d, t.id).unwrap());
    assert!(
        sweep_due(&conn, d).unwrap().is_empty(),
        "and then not again"
    );
}

/// One panel works three branches, one thread after another: each thread
/// keeps the branch it started on and counts only its own commits, and a
/// thread with a PR keeps the PR's branch however the panel switches (#167).
#[test]
fn a_thread_keeps_its_own_branch() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let s = |branch: &str, commits: i64| Seen {
        branch: branch.into(),
        commits,
        ..Seen::default()
    };
    start_as(&mut conn, d, "A", "p1", &[]);
    seen(&mut conn, d, "p1", &s("claude/a", 1), 2).unwrap();
    let a = of_pane(&conn, d, "p1").unwrap().unwrap().id;
    start(
        &mut conn,
        d,
        &Start {
            name: "B".into(),
            pane: "p1".into(),
            ..Start::default()
        },
        20,
    )
    .unwrap();
    seen(&mut conn, d, "p1", &s("claude/b", 0), 21).unwrap();
    seen(&mut conn, d, "p1", &s("claude/b", 1), 22).unwrap();
    // A commit back on A's branch, from B's panel: not B's.
    seen(&mut conn, d, "p1", &s("claude/a", 1), 23).unwrap();
    let b = of_pane(&conn, d, "p1").unwrap().unwrap();
    assert_eq!((b.branch.as_str(), b.commits), ("claude/b", 1));
    let a = get(&conn, d, a).unwrap().unwrap();
    assert_eq!((a.branch.as_str(), a.commits), ("claude/a", 1));
    // A PR'd thread ignores a later `switch -c`.
    let pr = Seen {
        pr: "57".into(),
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &pr, 24).unwrap();
    let (b, _) = seen(&mut conn, d, "p1", &s("claude/c", 0), 25)
        .unwrap()
        .unwrap();
    assert_eq!((b.branch.as_str(), b.pr.as_str()), ("claude/b", "57"));
    // And keeps its PR when another is made in the panel.
    let other = Seen {
        pr: "58".into(),
        ..Seen::default()
    };
    let (b, _) = seen(&mut conn, d, "p1", &other, 26).unwrap().unwrap();
    assert_eq!(b.pr, "57");
    // A first commit on main is no thread's own branch.
    start(
        &mut conn,
        d,
        &Start {
            name: "C".into(),
            pane: "p2".into(),
            ..Start::default()
        },
        30,
    )
    .unwrap();
    seen(&mut conn, d, "p2", &s("main", 1), 31).unwrap();
    let (c, _) = seen(&mut conn, d, "p2", &s("claude/c", 0), 32)
        .unwrap()
        .unwrap();
    assert_eq!((c.branch.as_str(), c.commits), ("claude/c", 0));
}

/// A merge by someone else -- a friend, a bot, or one nobody can say who
/// made -- ships the thread and lands its notes for the reader's check;
/// only the reader's own merge ticks them.
#[test]
fn only_the_readers_merge_ticks() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    start_as(&mut conn, d, "A", "p1", &n[..2]);
    let m = Seen {
        pr: "https://github.com/o/r/pull/67".into(),
        merged: "B6E235B".into(),
        merged_by: "trapti".into(),
        ..Seen::default()
    };
    let (t, changed) = seen(&mut conn, d, "p1", &m, 3).unwrap().unwrap();
    assert!(changed);
    assert_eq!(
        (t.stage.as_str(), t.pr_state.as_str()),
        ("shipped", "merged")
    );
    let notes = crate::desk::notes(&conn, d).unwrap();
    let mine: Vec<_> = notes.iter().filter(|x| n[..2].contains(&x.id)).collect();
    assert!(mine.iter().all(|x| !x.done && x.landed_commit == "b6e235b"));
}

/// GitHub's word puts right what a guess got wrong: a PR still open takes
/// back a merge git guessed, the PR's own branch is the thread's, and its
/// merge, the reader's, ticks the notes and settles the card that names
/// that PR -- and only that PR -- whichever thread it was asked on (#168).
#[test]
fn the_prs_word_settles_its_own_card() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    start_as(&mut conn, d, "Gallery", "p1", &[]);
    let card = |text: &str, link: &str| Ask {
        kind: "merge".into(),
        text: text.into(),
        link: link.into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let Asked::Turn(c89) = ask(
        &mut conn,
        d,
        &card("Merge PR #89", "https://github.com/o/r/pull/89"),
        2,
    )
    .unwrap() else {
        panic!()
    };
    let Asked::Turn(c88) = ask(
        &mut conn,
        d,
        &card("Merge PR #88", "https://github.com/o/r/pull/88"),
        2,
    )
    .unwrap() else {
        panic!()
    };
    start_as(&mut conn, d, "Foot", "p2", &n[..2]);
    let foot = of_pane(&conn, d, "p2").unwrap().unwrap();
    // git guessed the gallery's merge for it.
    assert!(landed(&conn, d, foot.id, "2cc6bd5", 5).unwrap());
    assert!(repair_branch(&conn, d, foot.id, "claude/foot-cards", "89").unwrap());
    let foot = get(&conn, d, foot.id).unwrap().unwrap();
    assert_eq!(
        (foot.branch.as_str(), foot.pr.as_str()),
        ("claude/foot-cards", "89")
    );
    let open = PrFacts {
        state: "open".into(),
        ci: "9/13".into(),
        ..PrFacts::default()
    };
    assert!(pr_facts(&conn, &foot, &open, false, "", 6).unwrap());
    let foot = get(&conn, d, foot.id).unwrap().unwrap();
    assert_eq!(
        (
            foot.merged.as_str(),
            foot.stage.as_str(),
            foot.pr_state.as_str(),
            foot.ci.as_str()
        ),
        ("", "review", "open", "9/13")
    );
    let merged = PrFacts {
        state: "merged".into(),
        merge: "5294d9e".into(),
        merged_by: "me".into(),
        merged_at: 7,
        head: "claude/foot-cards".into(),
        url: "https://github.com/o/r/pull/89".into(),
        ..PrFacts::default()
    };
    assert!(pr_facts(&conn, &foot, &merged, true, "", 8).unwrap());
    let foot = get(&conn, d, foot.id).unwrap().unwrap();
    assert_eq!(
        (foot.merged.as_str(), foot.merged_at, foot.stage.as_str()),
        ("5294d9e", 7, "shipped")
    );
    assert!(crate::desk::notes(&conn, d)
        .unwrap()
        .iter()
        .filter(|x| n[..2].contains(&x.id))
        .all(|x| x.done && x.done_by == "merged"));
    assert_eq!(
        turn(&conn, d, c89.id).unwrap().unwrap().answer,
        "Merged (5294d9e, seen by snyvi)"
    );
    assert_eq!(
        turn(&conn, d, c88.id).unwrap().unwrap().answered_at,
        0,
        "#88's card waits for #88"
    );
    // The same merge read again changes nothing.
    assert!(!pr_facts(&conn, &foot, &merged, true, "", 9).unwrap());
    // Another thread on the desk cannot take a PR that is the foot's.
    let gallery = of_pane(&conn, d, "p1").unwrap().unwrap();
    assert!(!repair_branch(&conn, d, gallery.id, "", "89").unwrap());
}

/// A desk's turns are its own: thirty-one waiting on another desk do not
/// push this desk's one out of its band or its brief, and the band leaves
/// out the mod's dialog turns while the brief keeps them.
#[test]
fn a_desks_waiting_turns_are_its_own() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let other = crate::desk::create(&conn, "/o", None, 0).unwrap().id;
    let q = |text: &str, via: &str| Ask {
        kind: "try".into(),
        text: text.into(),
        via: via.into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    // Straight into the table: `ask` caps a desk at `TURNS_PER_DESK`, and
    // the point here is `waiting`'s thirty across desks.
    for i in 0..31 {
        conn.execute(
            "INSERT INTO turns(desk_id, kind, text, created_at) VALUES (?1, 'try', ?2, 1)",
            params![other, format!("other {i}")],
        )
        .unwrap();
    }
    ask(&mut conn, d, &q("mine", ""), 2).unwrap();
    ask(&mut conn, d, &q("on screen", "dialog"), 3).unwrap();
    let band = waiting_on(&conn, d, false, 3).unwrap();
    assert_eq!(
        band.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        ["mine"]
    );
    let brief = waiting_on(&conn, d, true, 3).unwrap();
    assert_eq!(
        brief.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        ["mine", "on screen"]
    );
    assert_eq!(
        waiting(&conn, 9).unwrap().len(),
        30,
        "Home's cap, as before"
    );
}

/// Several questions an agent needs decided are one card (#110): all of
/// them in, sharing the first one's id, or none of them; and each is still
/// a turn answered on its own.
#[test]
fn questions_asked_together_are_one_card() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let q = |text: &str, options: &[&str]| Ask {
        kind: "decide".into(),
        text: text.into(),
        options: options.iter().map(|s| s.to_string()).collect(),
        recommended: 0,
        pane: "p1".into(),
        ..Ask::default()
    };
    let three = [
        q("SF6 as the reference?", &["Yes", "No"]),
        q("Input buffer off first?", &["Off", "On"]),
        q("Throws or drills first?", &["Throws", "Drills"]),
    ];
    let Asked::Group(ts) = ask_group(&mut conn, d, &three, 1).unwrap() else {
        panic!()
    };
    assert_eq!(ts.len(), 3);
    assert!(ts
        .iter()
        .all(|t| t.ask_group == ts[0].id && t.kind == "decide"));
    assert_eq!(turns(&conn, d, 0, 7).unwrap().len(), 3);
    // Answered one at a time, as any turn.
    assert!(answer(&conn, d, ts[1].id, "Off", "snyvi", 2)
        .unwrap()
        .is_some());
    // One question alone has no group.
    let Asked::Turn(one) = ask_group(&mut conn, d, &three[..1], 3).unwrap() else {
        panic!()
    };
    assert_eq!(one.ask_group, 0);
    // A bad question refuses the whole card, and so does no room for it all:
    // 3 waiting, and 6 the most, leaves no room for four.
    let bad = [q("Fine?", &["Yes", "No"]), q("Lonely?", &["Only one"])];
    assert_eq!(ask_group(&mut conn, d, &bad, 4).unwrap(), Asked::BadOptions);
    let four = [&three[..], &three[..1]].concat();
    assert_eq!(ask_group(&mut conn, d, &four, 5).unwrap(), Asked::Full);
    let five = [&three[..], &three[..2]].concat();
    assert_eq!(ask_group(&mut conn, d, &five, 6).unwrap(), Asked::BadGroup);
    // A group is questions; a hand-over is not one of them.
    let merge = Ask {
        kind: "merge".into(),
        text: "Merge PR 57".into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let mixed = [three[0].clone(), merge];
    assert_eq!(ask_group(&mut conn, d, &mixed, 7).unwrap(), Asked::BadGroup);
    assert_eq!(
        turns(&conn, d, 0, 7)
            .unwrap()
            .iter()
            .filter(|t| t.answered_at == 0)
            .count(),
        3
    );
}

/// A decide takes two to four options; the first answer stands, wherever it
/// was given; an answer from snyvi is told once, to the pane that asked.
#[test]
fn a_question_is_answered_once_and_told_once() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let q = |options: &[&str]| Ask {
        kind: "decide".into(),
        text: "Search box after how many docs?".into(),
        options: options.iter().map(|s| s.to_string()).collect(),
        recommended: 1,
        pane: "p1".into(),
        ..Ask::default()
    };
    assert_eq!(
        ask(&mut conn, d, &q(&["10"]), 1).unwrap(),
        Asked::BadOptions
    );
    let Asked::Turn(t) = ask(&mut conn, d, &q(&["After 5", "After 10"]), 1).unwrap() else {
        panic!()
    };
    assert_eq!(t.recommended, 1);
    let a = answer(&conn, d, t.id, "After 10", "snyvi", 2)
        .unwrap()
        .unwrap();
    assert_eq!(a.answered_in, "snyvi");
    assert!(answer(&conn, d, t.id, "After 5", "panel", 3)
        .unwrap()
        .is_none());
    let live = vec!["p1".to_string(), "p2".to_string()];
    assert!(take_untold(&conn, d, "p2", &live, 4).unwrap().is_empty());
    assert_eq!(take_untold(&conn, d, "p1", &live, 4).unwrap().len(), 1);
    assert!(take_untold(&conn, d, "p1", &live, 5).unwrap().is_empty());
}

/// An answer to a panel that has gone goes to the next panel that asks, so a
/// decision is not lost with its panel; the mod's dialog is never retold.
#[test]
fn an_answer_outlives_its_panel_and_a_dialog_is_not_retold() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let h = |via: &str| Ask {
        kind: "try".into(),
        text: "Try it on 7871".into(),
        via: via.into(),
        pane: "gone".into(),
        ..Ask::default()
    };
    let Asked::Turn(a) = ask(&mut conn, d, &h("ask"), 1).unwrap() else {
        panic!()
    };
    let Asked::Turn(b) = ask(&mut conn, d, &h("dialog"), 1).unwrap() else {
        panic!()
    };
    answer(&conn, d, a.id, "Looks good", "snyvi", 2).unwrap();
    answer(&conn, d, b.id, "Looks good", "snyvi", 2).unwrap();
    let told = take_untold(&conn, d, "p2", &["p2".into()], 3).unwrap();
    assert_eq!(told.iter().map(|t| t.id).collect::<Vec<_>>(), [a.id]);
}

/// A dozen threads move on a desk at once, counted by the panels still on
/// it: the threads of a panel that closed rest, and leave room (#102).
#[test]
fn threads_are_capped_by_the_panels_still_open() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    // This desk's panels are this test's own, not `desk`'s p1-p3.
    conn.execute("DELETE FROM panes WHERE desk_id = ?1", params![d])
        .unwrap();
    conn.execute(
        "INSERT INTO panes(id, desk_id, slot, cwd, created_at) VALUES ('live', ?1, 1, '/w', 0)",
        params![d],
    )
    .unwrap();
    // Gone panels' threads, as many as the cap, and none of them counts.
    for i in 0..THREADS_PER_DESK {
        assert!(matches!(
            start_as(&mut conn, d, &format!("gone {i}"), "closed", &[]),
            Started::New(_)
        ));
    }
    // Nor do the ones a panel moved on from: it holds one, its latest.
    for i in 0..THREADS_PER_DESK + 2 {
        assert!(matches!(
            start_as(&mut conn, d, &format!("live {i}"), "live", &[]),
            Started::New(_)
        ));
    }
    // Threads from outside a panel are what the cap keeps in bounds: with
    // the live panel's one, one fewer of them fits.
    for i in 0..THREADS_PER_DESK - 1 {
        assert!(matches!(
            start_as(&mut conn, d, &format!("loose {i}"), "", &[]),
            Started::New(_)
        ));
    }
    assert!(matches!(
        start_as(&mut conn, d, "one more", "", &[]),
        Started::Full
    ));
    // A resting thread picked up again by its name is the same thread, full or not.
    assert!(matches!(
        start_as(&mut conn, d, "gone 0", "live", &[]),
        Started::Again(_)
    ));
}

/// Six turns wait on a desk at most, and a turn joins the pane's thread.
#[test]
fn turns_are_capped_and_join_the_panes_thread() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let Started::New(th) = start_as(&mut conn, d, "A", "p1", &[]) else {
        panic!()
    };
    let h = Ask {
        kind: "merge".into(),
        text: "Merge PR 57".into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    for i in 0..TURNS_PER_DESK {
        let Asked::Turn(t) = ask(&mut conn, d, &h, i).unwrap() else {
            panic!()
        };
        assert_eq!(t.thread_id, th.id);
    }
    assert_eq!(ask(&mut conn, d, &h, 9).unwrap(), Asked::Full);
    assert_eq!(waiting(&conn, 9).unwrap().len() as i64, TURNS_PER_DESK);
}

/// A `run` turn carries its command exactly, one line typed on a click; one
/// that could not be typed safely is refused, never cut, and the other kinds
/// keep no command.
#[test]
fn a_run_turn_carries_one_line_it_can_type() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let run = |cmd: &str| Ask {
        kind: "run".into(),
        text: "Upload the reel and its cover".into(),
        cmd: cmd.into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let cmd = r#"cd ~/Studio/reel && curl -s -F "file=@$f" https://tmpfiles.org/api/v1/upload"#;
    let Asked::Turn(t) = ask(&mut conn, d, &run(&format!("  {cmd}\t ")), 1).unwrap() else {
        panic!()
    };
    assert_eq!((t.kind.as_str(), t.cmd.as_str()), ("run", cmd));
    assert_eq!(turn(&conn, d, t.id).unwrap().unwrap().cmd, cmd);
    for bad in [
        "",
        "   ",
        "echo one\necho two",
        "echo hi\rmore",
        "echo \u{1b}[201~ typed as keys",
        "echo \u{9b}",
        &"x".repeat(CMD_BYTES + 1),
    ] {
        assert_eq!(
            ask(&mut conn, d, &run(bad), 2).unwrap(),
            Asked::BadCmd,
            "{bad:?}"
        );
    }
    assert!(matches!(
        ask(&mut conn, d, &run(&"x".repeat(CMD_BYTES)), 3).unwrap(),
        Asked::Turn(_)
    ));
    let merge = Ask {
        kind: "merge".into(),
        cmd: "rm -rf ~".into(),
        ..run("")
    };
    let Asked::Turn(m) = ask(&mut conn, d, &merge, 4).unwrap() else {
        panic!()
    };
    assert_eq!(m.cmd, "");
    // What only the reader can do elsewhere is a `do`: a top-up filed as a
    // `try` asked whether adding credits Looks good. Any other word is refused.
    let top_up = Ask {
        kind: "do".into(),
        text: "Add OpenRouter credits".into(),
        link: "https://openrouter.ai/settings/credits".into(),
        ..run("")
    };
    assert!(matches!(
        ask(&mut conn, d, &top_up, 5).unwrap(),
        Asked::Turn(_)
    ));
    let pay = Ask {
        kind: "pay".into(),
        ..run("")
    };
    assert_eq!(ask(&mut conn, d, &pay, 6).unwrap(), Asked::BadKind);
}

/// A suggested desk for a folder that has one points at it instead; three
/// cards wait at most; ✕ has an Undo and Open does not; an opened panel is
/// told to the pane that suggested it, once.
#[test]
fn suggestions_wait_settle_and_are_told_once() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let desk_card = Suggest {
        kind: "desk".into(),
        folder: "/w/".into(),
        why: "its own project".into(),
        ..Suggest::default()
    };
    assert_eq!(
        suggest(&mut conn, d, &desk_card, 1).unwrap(),
        Suggested::HasDesk(d)
    );
    let panel = Suggest {
        kind: "panel".into(),
        name: "test window".into(),
        cmd: "snyvi serve --port 7871".into(),
        why: "to try it".into(),
        pane: "p1".into(),
        ..Suggest::default()
    };
    let mut ids = vec![];
    for _ in 0..SUGGESTIONS_PER_DESK {
        let Suggested::Card(c) = suggest(&mut conn, d, &panel, 1).unwrap() else {
            panic!()
        };
        ids.push(c.id);
    }
    assert_eq!(suggest(&mut conn, d, &panel, 1).unwrap(), Suggested::Full);
    settle(&conn, d, ids[0], "dismissed", 2).unwrap().unwrap();
    assert!(unsettle(&conn, d, ids[0]).unwrap());
    settle(&conn, d, ids[1], "opened", 3).unwrap().unwrap();
    assert!(!unsettle(&conn, d, ids[1]).unwrap());
    assert!(settle(&conn, d, ids[1], "dismissed", 4).unwrap().is_none());
    assert_eq!(take_opened(&conn, d, "p1", &[], 5).unwrap().len(), 1);
    assert!(take_opened(&conn, d, "p1", &[], 6).unwrap().is_empty());
}

/// 1.49: a panel card can be for the back; a widget's word for how long
/// is not one a panel keeps, nor `back` one a widget does.
#[test]
fn a_panel_card_can_be_for_the_back() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let card = |kind: &str, lasts: &str| Suggest {
        kind: kind.into(),
        name: "dev".into(),
        cmd: "npm run dev".into(),
        folder: "/w/.proposed/dev".into(),
        why: "the site".into(),
        lasts: lasts.into(),
        ..Suggest::default()
    };
    let lasts = |conn: &mut Connection, kind: &str, l: &str| {
        let Suggested::Card(c) = suggest(conn, d, &card(kind, l), 1).unwrap() else {
            panic!("a card")
        };
        c.lasts
    };
    assert_eq!(lasts(&mut conn, "panel", "back"), "back");
    assert_eq!(lasts(&mut conn, "panel", "week"), "");
    assert_eq!(lasts(&mut conn, "widget", "back"), "");
}

#[test]
fn a_pr_is_a_number() {
    assert_eq!(pr_number("#57").as_deref(), Some("57"));
    assert_eq!(
        pr_number("https://github.com/o/r/pull/57/").as_deref(),
        Some("57")
    );
    assert_eq!(pr_number("57; rm -rf"), None);
    assert!(branch_ok("claude/threads"));
    assert!(!branch_ok("a..b"));
    assert!(!branch_ok("-x"));
}

/// A panel holds one thread, the one it last took up; the rest rest, each
/// marked with why, and are on no list (#109). A reader's click on an old
/// one does not take the panel's thread from it.
#[test]
fn a_panel_holds_one_thread_and_the_rest_rest() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    // This desk's panels are this test's own, not `desk`'s p1-p3.
    conn.execute("DELETE FROM panes WHERE desk_id = ?1", params![d])
        .unwrap();
    conn.execute(
        "INSERT INTO panes(id, desk_id, slot, cwd, created_at) VALUES ('p1', ?1, 1, '/w', 0)",
        params![d],
    )
    .unwrap();
    start_as(&mut conn, d, "A", "p1", &[]);
    start_as(&mut conn, d, "B", "p1", &[]);
    start_as(&mut conn, d, "C", "gone", &[]);
    start_as(&mut conn, d, "D", "gone2", &[]);
    let park = Move {
        stage: "parked".into(),
        next: "rebase first".into(),
        pane: "gone".into(),
        ..Move::default()
    };
    move_thread(&mut conn, d, None, &park, 10).unwrap();
    // Every thread, marked as the lists mark them, and what the lists keep.
    let all = |conn: &Connection| -> Vec<(String, String, String)> {
        let mut st = conn
            .prepare(&format!(
                "SELECT {THREAD_COLS} FROM threads WHERE desk_id = ?1 AND removed_at = 0"
            ))
            .unwrap();
        let mut v: Vec<Thread> = st
            .query_map(params![d], row_to_thread)
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        mark_rest(conn, &mut v).unwrap();
        let mut v: Vec<_> = v.into_iter().map(|t| (t.name, t.stage, t.rest)).collect();
        v.sort();
        v
    };
    let rest = |conn: &Connection| -> Vec<(String, String, String)> {
        let mut v: Vec<_> = for_desk(conn, d)
            .unwrap()
            .into_iter()
            .map(|t| (t.name, t.stage, t.rest))
            .collect();
        v.sort();
        v
    };
    let row = |n: &str, s: &str, r: &str| (n.to_string(), s.to_string(), r.to_string());
    assert_eq!(
        all(&conn),
        [
            row("A", "planned", "moved on"),
            row("B", "planned", ""),
            row("C", "parked", "parked"),
            row("D", "planned", "panel closed"),
        ]
    );
    // Only the one a panel holds is listed.
    assert_eq!(rest(&conn), [row("B", "planned", "")]);
    // Done on the rail, for work that shipped somewhere the panel did not see.
    let done = Move {
        stage: "shipped".into(),
        reader: true,
        ..Move::default()
    };
    let a = conn
        .query_row(
            "SELECT id FROM threads WHERE desk_id = ?1 AND name = 'A'",
            params![d],
            |r| r.get::<_, i64>(0),
        )
        .unwrap();
    move_thread(&mut conn, d, Some(a), &done, 30).unwrap();
    assert_eq!(of_pane(&conn, d, "p1").unwrap().unwrap().name, "B");
    // Shipped, it is listed again, as shipped ones are.
    assert_eq!(
        rest(&conn),
        [row("A", "shipped", "moved on"), row("B", "planned", "")]
    );
    // Kept off the lists: started again by its name, it is back.
    assert!(matches!(
        start_as(&mut conn, d, "D", "p1", &[]),
        Started::Again(_)
    ));
    assert_eq!(of_pane(&conn, d, "p1").unwrap().unwrap().name, "D");
}

#[test]
fn a_box_is_one_card_and_its_answer_is_told() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let b = Suggest {
        kind: "box".into(),
        name: "deploy".into(),
        cmd: "**3/5**".into(),
        why: "panel 1 wants a box on this desk".into(),
        pane: "p1".into(),
        lasts: "panel".into(),
        ..Suggest::default()
    };
    let Suggested::Card(c) = suggest(&mut conn, d, &b, 1).unwrap() else {
        panic!()
    };
    assert_eq!((c.kind.as_str(), c.lasts.as_str()), ("box", "panel"));
    assert!(box_waiting(&conn, d, "deploy").unwrap());
    // Not now is told to the panel, as an opened card is.
    settle(&conn, d, c.id, "dismissed", 2).unwrap();
    assert!(!box_waiting(&conn, d, "deploy").unwrap());
    let told = take_opened(&conn, d, "p1", &[], 3).unwrap();
    assert_eq!((told.len(), told[0].outcome.as_str()), (1, "dismissed"));
    // Anything else the agent suggests lasts until the reader says.
    assert_eq!(lasts("forever"), "");
}

#[test]
fn a_stopped_widget_is_told_to_the_agent_that_proposed_it() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let w = Suggest {
        kind: "widget".into(),
        name: "arena".into(),
        cmd: "arena-status.sh".into(),
        folder: "/cfg/widgets/.proposed/1-arena".into(),
        why: "the queue at a glance".into(),
        pane: "p1".into(),
        detail: r#"{"where":"here","every":120}"#.into(),
        ..Suggest::default()
    };
    let Suggested::Card(c) = suggest(&mut conn, d, &w, 1).unwrap() else {
        panic!()
    };
    assert_eq!(c.detail["every"], 120);
    settle(&conn, d, c.id, "opened", 2).unwrap();
    assert!(take_opened(&conn, d, "p1", &[], 3).unwrap()[0]
        .note
        .is_empty());
    // Another desk's own arena is not this one.
    assert!(!tell_widget(&conn, d + 1, "arena", "not this one").unwrap());
    assert!(tell_widget(&conn, d, "arena", "Your widget arena stopped").unwrap());
    let again = take_opened(&conn, d, "p1", &[], 4).unwrap();
    assert_eq!(again[0].note, "Your widget arena stopped");
    assert!(take_opened(&conn, d, "p1", &[], 5).unwrap().is_empty());
}

#[test]
fn a_widget_proposed_again_by_its_panel_replaces_its_card() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let w = |pane: &str, folder: &str| Suggest {
        kind: "widget".into(),
        name: "ci".into(),
        cmd: "run.sh".into(),
        folder: folder.into(),
        why: "CI at a glance".into(),
        pane: pane.into(),
        ..Suggest::default()
    };
    let Suggested::Card(first) = suggest(&mut conn, d, &w("p1", "/w/.proposed/1-ci"), 1).unwrap()
    else {
        panic!()
    };
    let Suggested::Card(second) = suggest(&mut conn, d, &w("p1", "/w/.proposed/2-ci"), 2).unwrap()
    else {
        panic!()
    };
    let waiting = suggestions(&conn, d).unwrap();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].id, second.id);
    assert_eq!(
        suggestion(&conn, d, first.id).unwrap().unwrap().outcome,
        "replaced"
    );
    // Not something the agent is told of on its next prompt.
    assert!(take_opened(&conn, d, "p1", &[], 3).unwrap().is_empty());
    // Another panel's proposal of the same name replaces the card too (1.46):
    // one card per name on a desk, and the panel replaced is told whose.
    suggest(&mut conn, d, &w("p2", "/w/.proposed/3-ci"), 4).unwrap();
    assert_eq!(suggestions(&conn, d).unwrap().len(), 1);
    let told = take_opened(&conn, d, "p1", &["p1".into(), "p2".into()], 5).unwrap();
    assert_eq!(told.len(), 1);
    assert!(told[0].note.contains("replaced yours"), "{}", told[0].note);
    // The cap is by kind: three panel cards never block a widget's.
    let panel = Suggest {
        kind: "panel".into(),
        name: "x".into(),
        cmd: "true".into(),
        why: "to try".into(),
        ..Suggest::default()
    };
    for _ in 0..SUGGESTIONS_PER_DESK {
        suggest(&mut conn, d, &panel, 6).unwrap();
    }
    assert!(matches!(
        suggest(
            &mut conn,
            d,
            &Suggest {
                name: "deploy".into(),
                ..w("p3", "/w/.proposed/5-deploy")
            },
            7,
        )
        .unwrap(),
        Suggested::Card(_)
    ));
}

/// A word for a panel that has closed -- the stop of its widget, the
/// reader's Tell the agent, a card gone stale -- reaches the next panel on
/// the desk, as answers do; a widget's Not now is told as a box's is.
#[test]
fn a_widgets_word_reaches_the_next_panel_when_its_own_has_closed() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let w = Suggest {
        kind: "widget".into(),
        name: "ci".into(),
        cmd: "run.sh".into(),
        folder: "/w/.proposed/1-ci".into(),
        why: "CI at a glance".into(),
        pane: "p1".into(),
        ..Suggest::default()
    };
    let Suggested::Card(c) = suggest(&mut conn, d, &w, 1).unwrap() else {
        panic!()
    };
    settle(&conn, d, c.id, "opened", 2).unwrap();
    take_opened(&conn, d, "p1", &["p1".into()], 3).unwrap();
    tell_widget(&conn, d, "ci", "Your widget ci stopped").unwrap();
    // p1 still open: p2 does not hear p1's word.
    assert!(take_opened(&conn, d, "p2", &["p1".into(), "p2".into()], 4)
        .unwrap()
        .is_empty());
    assert!(widget_heard(&conn, d, "ci", &["p1".into()]).unwrap());
    // p1 closed: p2 hears it, once.
    let heard = take_opened(&conn, d, "p2", &["p2".into()], 5).unwrap();
    assert_eq!(
        (heard.len(), heard[0].note.as_str()),
        (1, "Your widget ci stopped")
    );
    assert!(take_opened(&conn, d, "p2", &["p2".into()], 6)
        .unwrap()
        .is_empty());
    assert!(
        !widget_heard(&conn, d, "ci", &[]).unwrap(),
        "no panel at all"
    );
    // Not now on a widget's card is told, and a stale card with its reason.
    let Suggested::Card(c2) = suggest(
        &mut conn,
        d,
        &Suggest {
            name: "deploy".into(),
            ..w.clone()
        },
        7,
    )
    .unwrap() else {
        panic!()
    };
    settle(&conn, d, c2.id, "dismissed", 8).unwrap();
    let told = take_opened(&conn, d, "p1", &["p1".into()], 9).unwrap();
    assert_eq!(
        (told[0].kind.as_str(), told[0].outcome.as_str()),
        ("widget", "dismissed")
    );
    let Suggested::Card(c3) = suggest(
        &mut conn,
        d,
        &Suggest {
            name: "queue".into(),
            ..w.clone()
        },
        10,
    )
    .unwrap() else {
        panic!()
    };
    settle_with(&conn, d, c3.id, "stale", "its folder changed", 11).unwrap();
    let told = take_opened(&conn, d, "p1", &["p1".into()], 12).unwrap();
    assert_eq!(
        (told[0].outcome.as_str(), told[0].note.as_str()),
        ("stale", "its folder changed")
    );
}

/// Send now types the answer into the panel: that is how the agent hears it,
/// so the changes the typed prompt brings do not tell it again.
#[test]
fn an_answer_sent_now_is_not_told_again() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let Asked::Turn(t) = ask(
        &mut conn,
        d,
        &Ask {
            kind: "decide".into(),
            text: "Ship it?".into(),
            options: vec!["Yes".into(), "No".into()],
            pane: "p1".into(),
            ..Ask::default()
        },
        1,
    )
    .unwrap() else {
        panic!()
    };
    assert!(!sent_turn(&conn, d, t.id, 2).unwrap(), "not answered yet");
    answer(&conn, d, t.id, "Yes", "snyvi", 3).unwrap().unwrap();
    assert!(sent_turn(&conn, d, t.id, 4).unwrap());
    let live = vec!["p1".to_string()];
    assert!(take_untold(&conn, d, "p1", &live, 5).unwrap().is_empty());
    assert!(!sent_turn(&conn, d, t.id, 6).unwrap(), "once");
}

/// What is fresh is the daemon's to say (audit e0a854b732, B2/B3): a turn
/// from a panel since gone, one past the half hour, and one quieted by its
/// panel's next prompt are stale, and only the fresh hold a place.
#[test]
fn only_fresh_turns_hold_a_place() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let try_ = |pane: &str| Ask {
        kind: "try".into(),
        text: "Try it".into(),
        pane: pane.into(),
        ..Ask::default()
    };
    ask(&mut conn, d, &try_("gone"), 10_000).unwrap();
    for _ in 0..TURNS_PER_DESK - 1 {
        ask(&mut conn, d, &try_("p1"), 10_000).unwrap();
    }
    let w = waiting_on(&conn, d, false, 10_001).unwrap();
    assert_eq!(
        w.iter().filter(|t| t.stale).count(),
        1,
        "the one from a closed panel"
    );
    // Six waiting, one of them stale: room for one more.
    assert!(matches!(
        ask(&mut conn, d, &try_("p1"), 10_002).unwrap(),
        Asked::Turn(_)
    ));
    assert_eq!(ask(&mut conn, d, &try_("p1"), 10_003).unwrap(), Asked::Full);
    // Half an hour on, every one of them is older, and the desk has room.
    let later = 10_003 + OLDER_S;
    assert!(waiting_on(&conn, d, false, later)
        .unwrap()
        .iter()
        .all(|t| t.stale));
    assert!(matches!(
        ask(&mut conn, d, &try_("p1"), later).unwrap(),
        Asked::Turn(_)
    ));
    // Claude's own dialog never holds a place.
    let dialog = Ask {
        via: "dialog".into(),
        kind: "decide".into(),
        options: vec!["a".into(), "b".into()],
        ..try_("p1")
    };
    for i in 0..TURNS_PER_DESK {
        assert!(matches!(
            ask(&mut conn, d, &dialog, later + i).unwrap(),
            Asked::Turn(_)
        ));
    }
    // Three days on, what still waits is put away by itself, and can come back.
    let gone = retire(&conn, 10_003 + RETIRE_S).unwrap();
    assert_eq!(
        gone,
        TURNS_PER_DESK as usize + 1,
        "the first seven; the later ones are not three days old"
    );
    let first = turns(&conn, d, 0, 10_003 + RETIRE_S).unwrap();
    assert!(first.iter().all(|t| t.created_at >= later));
}

/// A question the reader answered in the conversation (B1): the panel's next
/// prompt quiets it, a hand-over stays as it was, and `settle_asks` answers
/// it there, told, so it never comes back to the agent.
#[test]
fn a_question_answered_in_the_conversation_settles() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let q = Ask {
        kind: "decide".into(),
        text: "Lit ink?".into(),
        options: vec!["Yes".into(), "No".into()],
        pane: "p1".into(),
        ..Ask::default()
    };
    let key = Ask {
        kind: "key".into(),
        text: "Add the R2 key".into(),
        key_name: "R2_KEY".into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let Asked::Turn(qt) = ask(&mut conn, d, &q, 1).unwrap() else {
        panic!()
    };
    ask(&mut conn, d, &key, 1).unwrap();
    ask(
        &mut conn,
        d,
        &Ask {
            pane: "p2".into(),
            ..q.clone()
        },
        1,
    )
    .unwrap();
    // Panel 1's prompt quiets its question, not its key, nor panel 2's.
    let quiet = quiet_asks(&conn, d, "p1", 2).unwrap();
    assert_eq!(quiet.iter().map(|t| t.id).collect::<Vec<_>>(), [qt.id]);
    assert!(quiet_asks(&conn, d, "p1", 3).unwrap().is_empty(), "once");
    let w = waiting_on(&conn, d, false, 3).unwrap();
    assert_eq!(
        w.iter()
            .filter(|t| t.stale)
            .map(|t| t.id)
            .collect::<Vec<_>>(),
        [qt.id]
    );
    // A question asked after the prompt is not the prompt's to quiet.
    let Asked::Turn(after) = ask(&mut conn, d, &q, 5).unwrap() else {
        panic!()
    };
    assert!(quiet_asks(&conn, d, "p1", 5).unwrap().is_empty());
    // settle_asks answers panel 1's questions, and only those.
    assert_eq!(settle_asks(&conn, d, "p1", 6).unwrap(), 2);
    let t = turn(&conn, d, after.id).unwrap().unwrap();
    assert_eq!(
        (t.answer.as_str(), t.answered_in.as_str(), t.told_at),
        ("in the conversation", "panel", 6)
    );
    assert!(take_untold(&conn, d, "p1", &["p1".into()], 7)
        .unwrap()
        .is_empty());
    assert_eq!(
        waiting_on(&conn, d, false, 7).unwrap().len(),
        2,
        "the key, and panel 2's question"
    );
}

/// What snyvi sees settles a turn by itself (B5): a key of that name added
/// on the desk, or on every desk; and the merge of the thread a merge turn
/// is on. Either is told to the agent at its next prompt.
#[test]
fn a_key_added_or_a_merge_seen_settles_its_turn() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let Started::New(th) = start_as(&mut conn, d, "A", "p1", &[]) else {
        panic!()
    };
    let key = |name: &str| Ask {
        kind: "key".into(),
        text: "Add the key".into(),
        key_name: name.into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let Asked::Turn(k1) = ask(&mut conn, d, &key("R2_KEY"), 1).unwrap() else {
        panic!()
    };
    let Asked::Turn(k2) = ask(&mut conn, d, &key("not a name!"), 1).unwrap() else {
        panic!()
    };
    assert_eq!((k1.key_name.as_str(), k2.key_name.as_str()), ("R2_KEY", ""));
    assert_eq!(settle_key(&conn, d, "OTHER", 2).unwrap(), 0);
    assert_eq!(
        settle_key(&conn, crate::desk::EVERY_DESK, "R2_KEY", 2).unwrap(),
        1
    );
    let t = turn(&conn, d, k1.id).unwrap().unwrap();
    assert_eq!((t.answer.as_str(), t.told_at), ("Added", 0));
    let merge = Ask {
        kind: "merge".into(),
        text: "Merge PR 57".into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let Asked::Turn(m) = ask(&mut conn, d, &merge, 3).unwrap() else {
        panic!()
    };
    assert_eq!(m.thread_id, th.id);
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let s = Seen {
        merged: sha.into(),
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &s, 4).unwrap();
    let t = turn(&conn, d, m.id).unwrap().unwrap();
    assert_eq!(t.answer, "Merged (0123456, seen by snyvi)");
    assert_eq!(t.told_at, 0, "the agent hears it at its next prompt");
}

/// A `run` can be a walk-through (#164): commands the reader runs one click
/// at a time, the lines over them, and steps done by hand, which they tick.
/// Every step is checked as one command is, all of them or the turn is
/// refused, and the first command is the turn's own for a page that knows
/// no steps.
#[test]
fn a_run_turn_carries_steps_each_checked_like_one_command() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let run = |steps: &[&str]| Ask {
        kind: "run".into(),
        text: "Pull the Starlink app off the phone".into(),
        options: steps.iter().map(|s| s.to_string()).collect(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let walk = [
        "$ sudo apt install -y android-tools-adb",
        "On the phone: Settings → About phone → tap Build number seven times",
        "# Is the phone seen?",
        "$ adb devices",
        "$ adb shell pm list packages | grep -i -E 'starlink|spacex'",
    ];
    let Asked::Turn(t) = ask(&mut conn, d, &run(&walk), 1).unwrap() else {
        panic!()
    };
    assert_eq!(t.cmd, "sudo apt install -y android-tools-adb");
    assert_eq!(turn(&conn, d, t.id).unwrap().unwrap().options, walk);
    for bad in [
        vec!["$ echo one\necho two"],
        vec!["$ echo \u{1b}[201~ typed as keys"],
        vec!["$ "],
        vec!["Only by hand, nothing to run"],
        vec!["$ ls", "# "],
        vec!["$ ls", "# Is it seen?"],
        vec!["# Plug it in", "Plug the phone in", "$ adb devices"],
        vec!["# One", "# Two", "$ ls"],
        vec!["$ ls"; STEPS_MAX + 1],
    ] {
        assert_eq!(
            ask(&mut conn, d, &run(&bad), 2).unwrap(),
            Asked::BadCmd,
            "{bad:?}"
        );
    }
    assert!(matches!(
        ask(&mut conn, d, &run(&["$ ls"; STEPS_MAX]), 3).unwrap(),
        Asked::Turn(_)
    ));
    // Steps are a run's alone: the other hand-overs still take none.
    let Ask { options, .. } = run(&walk);
    let try_it = Ask {
        kind: "try".into(),
        options,
        ..run(&[])
    };
    assert_eq!(ask(&mut conn, d, &try_it, 4).unwrap(), Asked::BadOptions);
}

/// The same command handed over twice is one card (#174): the newer one
/// stands, the older is put away -- spaced differently, or a step of a
/// walk-through -- recoverable as a ✕ is. A different command is not a
/// repeat, and a non-run never puts anything away.
#[test]
fn a_command_handed_over_again_puts_the_older_card_away() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let run = |cmd: &str, steps: &[&str]| Ask {
        kind: "run".into(),
        text: "Add the Cloudflare account ID".into(),
        cmd: cmd.into(),
        options: steps.iter().map(|s| s.to_string()).collect(),
        pane: "p2".into(),
        ..Ask::default()
    };
    let id = |a: Asked| match a {
        Asked::Turn(t) => t.id,
        other => panic!("{other:?}"),
    };
    let first = id(ask(&mut conn, d, &run("gh secret set ID --repo a/b", &[]), 1).unwrap());
    let other = id(ask(&mut conn, d, &run("gh run rerun 7", &[]), 2).unwrap());
    let again = id(ask(&mut conn, d, &run("gh  secret set ID   --repo a/b", &[]), 3).unwrap());
    let open = |c: &Connection| -> Vec<i64> {
        waiting_on(c, d, false, 4)
            .unwrap()
            .iter()
            .map(|t| t.id)
            .collect()
    };
    assert_eq!(open(&conn), vec![other, again]);
    // A walk-through whose step types it puts the single card away too.
    let steps = id(ask(
        &mut conn,
        d,
        &run(
            "",
            &["$ gh secret set ID --repo a/b", "Wait for the deploy"],
        ),
        5,
    )
    .unwrap());
    assert_eq!(open(&conn), vec![other, steps]);
    // Recoverable, as a ✕ is, and never a reason said for it.
    assert!(restore_turn(&conn, d, first).unwrap());
    assert!(put_away_lately(&conn, d, 6).unwrap().is_empty());
    let decide = Ask {
        kind: "decide".into(),
        text: "Which?".into(),
        options: vec!["a".into(), "b".into()],
        pane: "p2".into(),
        ..Ask::default()
    };
    id(ask(&mut conn, d, &decide, 7).unwrap());
    assert!(open(&conn).contains(&other));
}

/// An agent on the desk puts any waiting card away with why (#174), and only
/// with why: the tray says it for a day with Bring back, which clears it.
/// One already answered, or on another desk, is not its to put away.
#[test]
fn an_agent_puts_a_card_away_with_why_and_the_reader_brings_it_back() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let rel = Ask {
        kind: "run".into(),
        text: "Release v1.43.0".into(),
        cmd: "gh workflow run release.yml -f version=1.43.0".into(),
        pane: "gone".into(),
        ..Ask::default()
    };
    let Asked::Turn(t) = ask(&mut conn, d, &rel, 10).unwrap() else {
        panic!()
    };
    assert_eq!(put_away(&conn, d, t.id, "panel 1", "  ", 20).unwrap(), None);
    assert_eq!(
        put_away(&conn, d + 1, t.id, "panel 1", "done", 20).unwrap(),
        None
    );
    let away = put_away(&conn, d, t.id, "panel 1", "v1.43.0 is released", 20)
        .unwrap()
        .unwrap();
    assert_eq!(away.away, "panel 1: v1.43.0 is released");
    assert_eq!(away.removed_at, 20);
    assert!(waiting_on(&conn, d, false, 21).unwrap().is_empty());
    assert_eq!(put_away_lately(&conn, d, 21).unwrap()[0].id, t.id);
    // Said for a day, then only kept.
    assert!(put_away_lately(&conn, d, 20 + AWAY_SHOWN_S + 1)
        .unwrap()
        .is_empty());
    // Twice is nothing: it is no longer waiting.
    assert_eq!(
        put_away(&conn, d, t.id, "panel 2", "again", 22).unwrap(),
        None
    );
    assert!(restore_turn(&conn, d, t.id).unwrap());
    let back = turn(&conn, d, t.id).unwrap().unwrap();
    assert_eq!((back.removed_at, back.away.as_str()), (0, ""));
    assert!(put_away_lately(&conn, d, 23).unwrap().is_empty());
}

/// The reader's merge ticks the thread's notes, but not one that landed
/// already: that one waits for their check (audit 8fbe274f4e).
#[test]
fn a_merge_leaves_a_landed_note_for_the_readers_check() {
    let mut conn = db();
    let (d, n) = desk(&mut conn);
    start_as(&mut conn, d, "A", "p1", &n[..2]);
    assert_eq!(
        crate::desk::land_notes(&conn, d, &[(n[0], "aaaaaaa".to_string(), 2)]).unwrap(),
        1
    );
    let m = Seen {
        pr: "https://github.com/o/r/pull/67".into(),
        merged: "b6e235b".into(),
        mine: true,
        ..Seen::default()
    };
    seen(&mut conn, d, "p1", &m, 3).unwrap();
    let notes = crate::desk::notes(&conn, d).unwrap();
    let of = |id: i64| notes.iter().find(|x| x.id == id).unwrap();
    assert_eq!(
        (of(n[0]).done, of(n[0]).landed_commit.as_str()),
        (false, "aaaaaaa")
    );
    assert_eq!((of(n[1]).done, of(n[1]).done_by.as_str()), (true, "merged"));
}

fn removed_by(conn: &Connection, id: i64) -> String {
    conn.query_row("SELECT removed_by FROM turns WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

/// Who put each card away (audit 8fbe274f4e: 81 of 98 said nothing): the
/// reader's ✕, an agent with why, a newer card, its panel's dialog, age;
/// and Bring back clears it.
#[test]
fn a_card_put_away_says_who_put_it_away() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let card = |kind: &str, text: &str, via: &str| Ask {
        kind: kind.into(),
        text: text.into(),
        options: if kind == "decide" {
            vec!["a".into(), "b".into()]
        } else {
            Vec::new()
        },
        via: via.into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let id = |a: Asked| match a {
        Asked::Turn(t) => t.id,
        other => panic!("{other:?}"),
    };
    let x = id(ask(&mut conn, d, &card("do", "Pay", ""), 10).unwrap());
    let agent = id(ask(&mut conn, d, &card("do", "Sign in", ""), 11).unwrap());
    let dialog = id(ask(&mut conn, d, &card("decide", "Which?", "dialog"), 12).unwrap());
    assert!(remove_turn(&conn, d, x, "you", 20).unwrap());
    put_away(&conn, d, agent, "panel 1", "signed in", 21).unwrap();
    assert!(drop_dialog(&conn, d, dialog, 22).unwrap());
    let run = Ask {
        kind: "run".into(),
        text: "Deploy".into(),
        cmd: "npx wrangler deploy".into(),
        pane: "p1".into(),
        ..Ask::default()
    };
    let first = id(ask(&mut conn, d, &run, 23).unwrap());
    id(ask(&mut conn, d, &run, 24).unwrap());
    let old = id(ask(&mut conn, d, &card("try", "Look", ""), 25).unwrap());
    retire(&conn, 25 + RETIRE_S + 1).unwrap();
    let got: Vec<String> = [x, agent, dialog, first, old]
        .iter()
        .map(|&t| removed_by(&conn, t))
        .collect();
    assert_eq!(got, ["you", "agent", "panel", "replaced", "aged"]);
    assert!(restore_turn(&conn, d, x).unwrap());
    assert_eq!(removed_by(&conn, x), "");
}

/// A card said again in other words goes with `replaces`: the old one is
/// put away as replaced by the new, said so in the tray, and comes back with
/// Bring back. One already answered, or on another desk, stays as it is.
#[test]
fn a_card_said_again_replaces_the_old_one() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let run = |cmd: &str, replaces: i64| Ask {
        kind: "run".into(),
        text: "Build for iOS".into(),
        cmd: cmd.into(),
        by: "panel 1".into(),
        pane: "p1".into(),
        replaces,
        ..Ask::default()
    };
    let id = |a: Asked| match a {
        Asked::Turn(t) => t.id,
        other => panic!("{other:?}"),
    };
    let first = id(ask(&mut conn, d, &run("eas build -p ios", 0), 10).unwrap());
    let second = id(ask(
        &mut conn,
        d,
        &run("npx eas-cli@latest build -p ios", first),
        11,
    )
    .unwrap());
    let open: Vec<i64> = waiting_on(&conn, d, false, 12)
        .unwrap()
        .iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(open, vec![second]);
    let away = &put_away_lately(&conn, d, 12).unwrap()[0];
    assert_eq!(
        (away.id, away.away.as_str()),
        (first, format!("panel 1: replaced by #{second}").as_str())
    );
    assert_eq!(removed_by(&conn, first), "replaced");
    // Another desk's card is not this desk's to replace.
    let other = crate::desk::create(&conn, "/x", None, 0).unwrap().id;
    let theirs = id(ask(&mut conn, other, &run("gh run rerun 7", 0), 13).unwrap());
    id(ask(&mut conn, d, &run("gh run rerun 8", theirs), 14).unwrap());
    assert_eq!(removed_by(&conn, theirs), "");
    assert!(restore_turn(&conn, d, first).unwrap());
    assert_eq!(turn(&conn, d, first).unwrap().unwrap().away, "");
}

/// A panel is told its own hand-overs still open, newest first and at most
/// `CHORES_TOLD`: never its questions, never another panel's.
#[test]
fn a_panel_hears_its_own_open_hand_overs() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
    let h = |kind: &str, text: &str, pane: &str| Ask {
        kind: kind.into(),
        text: text.into(),
        options: if kind == "decide" {
            vec!["a".into(), "b".into()]
        } else {
            Vec::new()
        },
        cmd: if kind == "run" {
            format!("echo {text}")
        } else {
            String::new()
        },
        pane: pane.into(),
        ..Ask::default()
    };
    for (i, (kind, text, pane)) in [
        ("do", "pay", "p1"),
        ("decide", "which", "p1"),
        ("key", "token", "p1"),
        ("try", "look", "p2"),
        ("run", "deploy", "p1"),
        ("try", "phone", "p1"),
    ]
    .iter()
    .enumerate()
    {
        ask(&mut conn, d, &h(kind, text, pane), 10 + i as i64).unwrap();
    }
    let got: Vec<String> = open_chores(&conn, d, "p1")
        .unwrap()
        .iter()
        .map(|t| t.text.clone())
        .collect();
    assert_eq!(got, ["phone", "deploy", "token"]);
    let lines = crate::brief::answer_lines(&open_chores(&conn, d, "p1").unwrap());
    assert_eq!(lines.len(), 1);
    assert!(lines[0].starts_with("Your hand-overs still open on the user's On you list: #"));
    assert!(lines[0].contains("remove_card"));
}
