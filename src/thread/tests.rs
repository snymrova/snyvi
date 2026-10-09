use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(crate::desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(THREAD_COLUMN).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(CMD_COLUMN).unwrap();
    conn.execute_batch(TAKEN_COLUMN).unwrap();
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

/// What the mod sees lands on the pane's thread and is marked seen; a new
/// branch starts the commit count again, and a merge is dated once.
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
    let (t, _) = seen(&mut conn, d, "p1", &s("claude/b", 1), 5)
        .unwrap()
        .unwrap();
    assert_eq!(t.commits, 1);
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
    assert_eq!((t.branch.as_str(), changed), ("claude/b", false));
}

/// The first sight of the merge ticks the thread's open notes, by "merged",
/// with the merge and the PR; a note outside the thread stays open, and one
/// the reader unticks is not ticked again by the same merge seen again.
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
    let band = waiting_on(&conn, d, false).unwrap();
    assert_eq!(
        band.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        ["mine"]
    );
    let brief = waiting_on(&conn, d, true).unwrap();
    assert_eq!(
        brief.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
        ["mine", "on screen"]
    );
    assert_eq!(waiting(&conn).unwrap().len(), 30, "Home's cap, as before");
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
    assert_eq!(waiting(&conn).unwrap().len() as i64, TURNS_PER_DESK);
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
    assert_eq!(take_opened(&conn, d, "p1", 5).unwrap().len(), 1);
    assert!(take_opened(&conn, d, "p1", 6).unwrap().is_empty());
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
/// saying why, and leave the lists when their time is up. A reader's click
/// on an old one does not take the panel's thread from it.
#[test]
fn a_panel_holds_one_thread_and_the_rest_rest() {
    let mut conn = db();
    let (d, _) = desk(&mut conn);
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
    let rest = |conn: &Connection, now: i64| -> Vec<(String, String, String)> {
        let mut v: Vec<_> = for_desk(conn, d, now)
            .unwrap()
            .into_iter()
            .map(|t| (t.name, t.stage, t.rest))
            .collect();
        v.sort();
        v
    };
    let row = |n: &str, s: &str, r: &str| (n.to_string(), s.to_string(), r.to_string());
    assert_eq!(
        rest(&conn, 20),
        [
            row("A", "planned", "moved on"),
            row("B", "planned", ""),
            row("C", "parked", "parked"),
            row("D", "planned", "panel closed"),
        ]
    );
    // Done on the rail, for work that shipped somewhere the panel did not see.
    let done = Move {
        stage: "shipped".into(),
        reader: true,
        ..Move::default()
    };
    let a = for_desk(&conn, d, 20)
        .unwrap()
        .into_iter()
        .find(|t| t.name == "A")
        .unwrap();
    move_thread(&mut conn, d, Some(a.id), &done, 30).unwrap();
    assert_eq!(of_pane(&conn, d, "p1").unwrap().unwrap().name, "B");
    assert_eq!(rest(&conn, 40)[0], row("A", "shipped", "moved on"));
    // A day on, the resting one has left the list; parked and shipped stay.
    assert_eq!(
        rest(&conn, 30 + RESTING_SHOWN),
        [
            row("A", "shipped", "moved on"),
            row("B", "planned", ""),
            row("C", "parked", "parked"),
        ]
    );
    // A week on, the parked one has too. Kept: started again, it is back.
    assert_eq!(rest(&conn, 10 + PARKED_SHOWN).len(), 2);
    assert!(matches!(
        start_as(&mut conn, d, "D", "p1", &[]),
        Started::Again(_)
    ));
    assert_eq!(of_pane(&conn, d, "p1").unwrap().unwrap().name, "D");
}
