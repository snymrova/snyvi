use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(POS_COLUMN).unwrap();
    conn.execute_batch(SENT_BY_COLUMN).unwrap();
    conn.execute_batch(crate::thread::THREAD_COLUMN).unwrap();
    conn
}

/// The list is read from the top down, so it is written that way: what is
/// open in the order it was written, what is done in the order it was
/// ticked, and the done half at the bottom.
#[test]
fn a_list_reads_open_first_then_done_in_the_order_it_was_ticked() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    for (i, text) in ["first", "second", "third"].iter().enumerate() {
        add_note(&mut conn, d, text, i as i64).unwrap().unwrap();
    }
    let ids: Vec<i64> = notes(&conn, d).unwrap().iter().map(|n| n.id).collect();
    // The first written is ticked last, so it is last in the done half --
    // the tick's order, not the writing's.
    set_note(&conn, d, ids[1], None, Some(true), 10).unwrap();
    set_note(&conn, d, ids[0], None, Some(true), 20).unwrap();
    let after = notes(&conn, d).unwrap();
    assert_eq!(
        after
            .iter()
            .map(|n| (n.text.as_str(), n.done))
            .collect::<Vec<_>>(),
        [("third", false), ("second", true), ("first", true)]
    );
    // Unticking puts it back among the open, in the order it was written.
    set_note(&conn, d, ids[0], None, Some(false), 30).unwrap();
    assert_eq!(notes(&conn, d).unwrap()[0].text, "first");
}

/// Taking a line off the list is not deleting it: the row stays, so Undo
/// has something to put back. Nothing on this path destroys what someone
/// wrote.
#[test]
fn a_line_taken_off_is_kept_and_can_come_back() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let n = add_note(&mut conn, d, "wire up the route", 0)
        .unwrap()
        .unwrap();
    assert!(remove_note(&conn, d, n.id, 1).unwrap());
    assert!(notes(&conn, d).unwrap().is_empty());
    let kept: i64 = conn
        .query_row("SELECT COUNT(*) FROM desk_notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(kept, 1, "the row is kept, not deleted");
    assert!(restore_note(&conn, d, n.id).unwrap());
    assert_eq!(notes(&conn, d).unwrap()[0].text, "wire up the route");
    // Twice is not an error the second time, and not a second row either.
    assert!(remove_note(&conn, d, n.id, 2).unwrap());
    assert!(!remove_note(&conn, d, n.id, 3).unwrap());
}

/// A note id from the page reaches only the desk the page asked about.
/// Without the desk in the `WHERE`, one window could rewrite another
/// desk's list by guessing an integer.
#[test]
fn a_note_is_reachable_only_through_its_own_desk() {
    let mut conn = db();
    let mine = create(&conn, "/mine", None, 0).unwrap().id;
    let yours = create(&conn, "/yours", None, 0).unwrap().id;
    let n = add_note(&mut conn, mine, "mine", 0).unwrap().unwrap();
    assert!(!set_note(&conn, yours, n.id, Some("yours"), None, 1).unwrap());
    assert!(!remove_note(&conn, yours, n.id, 1).unwrap());
    assert_eq!(notes(&conn, mine).unwrap()[0].text, "mine");
    assert!(notes(&conn, yours).unwrap().is_empty());
}

/// A line's pictures: by name only, a name that is a picture's, each once,
/// up to the cap, on its own desk's lines; taking one off and Undo are
/// both the list set whole.
#[test]
fn a_line_holds_its_pictures_by_name_and_gives_them_back() {
    let mut conn = db();
    let mine = create(&conn, "/mine", None, 0).unwrap().id;
    let yours = create(&conn, "/yours", None, 0).unwrap().id;
    let n = add_note(&mut conn, mine, "this spacing", 0)
        .unwrap()
        .unwrap();
    let a = "0123456789abcdef.png".to_string();
    let b = "fedcba9876543210.webp".to_string();
    assert_eq!(
        add_note_image(&conn, mine, n.id, &a).unwrap(),
        Some(vec![a.clone()])
    );
    // The same picture twice is on the line once.
    assert_eq!(
        add_note_image(&conn, mine, n.id, &a).unwrap(),
        Some(vec![a.clone()])
    );
    assert_eq!(
        add_note_image(&conn, mine, n.id, &b).unwrap(),
        Some(vec![a.clone(), b.clone()])
    );
    assert_eq!(
        notes(&conn, mine).unwrap()[0].images,
        [a.clone(), b.clone()]
    );
    // Not across desks, and nothing that could be a path.
    assert_eq!(add_note_image(&conn, yours, n.id, &a).unwrap(), None);
    for bad in [
        "../../etc/passwd",
        "0123456789abcdef.svg",
        "0123456789ABCDEF.png",
        "abc.png",
        "0123456789abcdef",
    ] {
        assert!(!image_name_ok(bad), "{bad}");
        assert!(!set_note_images(&conn, mine, n.id, &[bad.to_string()]).unwrap());
    }
    // One off, and Undo puts the list back as it was.
    assert!(set_note_images(&conn, mine, n.id, std::slice::from_ref(&b)).unwrap());
    assert_eq!(
        notes(&conn, mine).unwrap()[0].images,
        std::slice::from_ref(&b)
    );
    assert!(set_note_images(&conn, mine, n.id, &[a.clone(), b.clone()]).unwrap());
    assert_eq!(notes(&conn, mine).unwrap()[0].images, [a.clone(), b]);
    // The cap.
    let many: Vec<String> = (0..=IMAGES_PER_NOTE)
        .map(|i| format!("{i:016x}.png"))
        .collect();
    assert!(!set_note_images(&conn, mine, n.id, &many).unwrap());
    assert!(set_note_images(&conn, mine, n.id, &many[..IMAGES_PER_NOTE]).unwrap());
    assert_eq!(
        add_note_image(&conn, mine, n.id, &a).unwrap(),
        None,
        "a full line takes no more"
    );
}

/// An agent ticks only: an open line on its own desk, once, with its name
/// kept -- and the reader's untick or re-tick makes the line theirs again.
#[test]
fn an_agent_ticks_an_open_line_on_its_own_desk_and_nothing_else() {
    let mut conn = db();
    let mine = create(&conn, "/mine", None, 0).unwrap().id;
    let yours = create(&conn, "/yours", None, 0).unwrap().id;
    let n = add_note(&mut conn, mine, "wire the route", 0)
        .unwrap()
        .unwrap();
    assert!(
        !tick_note(&conn, yours, n.id, &by("claude-code"), 1).unwrap(),
        "not across desks"
    );
    assert!(tick_note(&conn, mine, n.id, &by("claude-code"), 1).unwrap());
    let got = &notes(&conn, mine).unwrap()[0];
    assert!(got.done);
    assert_eq!(got.done_by, "claude-code");
    assert!(
        !tick_note(&conn, mine, n.id, &by("claude-code"), 2).unwrap(),
        "a done line stays as it is"
    );

    // The reader unticks it: open again, and no one's but theirs.
    assert!(set_note(&conn, mine, n.id, None, Some(false), 3).unwrap());
    let got = &notes(&conn, mine).unwrap()[0];
    assert!(!got.done);
    assert_eq!(got.done_by, "");
    // A tick from nobody in particular still says an agent did it.
    assert!(tick_note(&conn, mine, n.id, &by("  "), 4).unwrap());
    assert_eq!(notes(&conn, mine).unwrap()[0].done_by, "an agent");
    // A line taken off the list cannot be ticked.
    assert!(set_note(&conn, mine, n.id, None, Some(false), 5).unwrap());
    assert!(remove_note(&conn, mine, n.id, 6).unwrap());
    assert!(!tick_note(&conn, mine, n.id, &by("claude-code"), 7).unwrap());
}

fn by(name: &str) -> Tick {
    Tick {
        by: name.into(),
        ..Tick::default()
    }
}

fn mark(stage: &str, doc: &str) -> Mark {
    Mark {
        stage: stage.into(),
        by: "claude-code".into(),
        doc: doc.into(),
        pane: "p1".into(),
        session: "s1".into(),
    }
}

/// An agent says how far it has got: read, planned with the plan's id,
/// working from its pane. Any stage from any other, on an open line of
/// its own desk that the reader has kept; never on a done one.
#[test]
fn a_stage_is_read_planned_or_working_and_only_on_an_open_line() {
    let mut conn = db();
    let mine = create(&conn, "/mine", None, 0).unwrap().id;
    let yours = create(&conn, "/yours", None, 0).unwrap().id;
    let n = add_note(&mut conn, mine, "wire the route", 0)
        .unwrap()
        .unwrap();
    let get = |conn: &Connection| notes(conn, mine).unwrap()[0].clone();

    assert!(
        !mark_note(&conn, yours, n.id, &mark("read", ""), 1).unwrap(),
        "not across desks"
    );
    assert!(
        !mark_note(&conn, mine, n.id, &mark("done", ""), 1).unwrap(),
        "done is the tick"
    );
    assert!(
        !mark_note(&conn, mine, n.id, &mark("planned", ""), 1).unwrap(),
        "a plan needs its document"
    );
    assert!(!mark_note(&conn, mine, n.id, &mark("planned", "not-an-id"), 1).unwrap());
    assert_eq!(get(&conn).stage, "");

    assert!(mark_note(&conn, mine, n.id, &mark("read", ""), 2).unwrap());
    let got = get(&conn);
    assert_eq!(
        (got.stage.as_str(), got.stage_by.as_str(), got.stage_at),
        ("read", "claude-code", 2)
    );
    assert_eq!(got.stage_pane, "", "only working keeps the pane");

    assert!(mark_note(&conn, mine, n.id, &mark("planned", "58155BA5FC"), 3).unwrap());
    assert_eq!(get(&conn).stage_doc, "58155ba5fc");
    // Working keeps the plan, and says where it is happening.
    assert!(mark_note(&conn, mine, n.id, &mark("working", ""), 4).unwrap());
    let got = get(&conn);
    assert_eq!(
        (got.stage.as_str(), got.stage_doc.as_str()),
        ("working", "58155ba5fc")
    );
    assert_eq!(
        (got.stage_pane.as_str(), got.stage_session.as_str()),
        ("p1", "s1")
    );
    // The conversation ends: back to planned. With no plan: read.
    let mut ended = got.clone();
    settle_stage(&mut ended, false);
    assert_eq!(ended.stage, "planned");
    let mut still = got.clone();
    settle_stage(&mut still, true);
    assert_eq!(still.stage, "working");
    ended.stage = "working".into();
    ended.stage_doc.clear();
    settle_stage(&mut ended, false);
    assert_eq!(ended.stage, "read");
    // And back a step, by the agent itself.
    assert!(mark_note(&conn, mine, n.id, &mark("planned", "58155ba5fc"), 5).unwrap());
    assert_eq!(get(&conn).stage_pane, "");

    // A done line is done: no stage over it. A suggestion is not the
    // reader's list yet.
    assert!(tick_note(&conn, mine, n.id, &by("claude-code"), 6).unwrap());
    assert!(!mark_note(&conn, mine, n.id, &mark("working", ""), 7).unwrap());
    let Suggested::Note(s) = suggest_note(&mut conn, mine, "an idea", "claude-code", 8).unwrap()
    else {
        panic!("suggested")
    };
    assert!(!mark_note(&conn, mine, s.id, &mark("read", ""), 9).unwrap());
}

/// A tick can say where the work went: a commit hash, and a document the
/// agent sent. Anything that is not one is dropped, not stored, and the
/// reader's untick takes both off with the name.
#[test]
fn a_tick_carries_its_commit_and_document_and_an_untick_clears_them() {
    let mut conn = db();
    let mine = create(&conn, "/mine", None, 0).unwrap().id;
    let n = add_note(&mut conn, mine, "fix the hover", 0)
        .unwrap()
        .unwrap();
    let tick = Tick {
        by: "claude-code".into(),
        commit: "90F09D6".into(),
        doc: "82cc8f2d3c".into(),
        evidence: "https://github.com/o/r/pull/40".into(),
        pane: "p1".into(),
    };
    assert!(tick_note(&conn, mine, n.id, &tick, 1).unwrap());
    let got = &notes(&conn, mine).unwrap()[0];
    assert_eq!(
        (
            got.done_commit.as_str(),
            got.done_doc.as_str(),
            got.done_evidence.as_str(),
            got.done_pane.as_str(),
            got.done_at
        ),
        (
            "90f09d6",
            "82cc8f2d3c",
            "https://github.com/o/r/pull/40",
            "p1",
            1
        )
    );
    assert!(set_note(&conn, mine, n.id, None, Some(false), 2).unwrap());
    let got = &notes(&conn, mine).unwrap()[0];
    assert_eq!(
        (
            got.done_by.as_str(),
            got.done_commit.as_str(),
            got.done_doc.as_str()
        ),
        ("", "", "")
    );
    let junk = Tick {
        by: "claude-code".into(),
        commit: "main; rm -rf".into(),
        doc: "../etc".into(),
        evidence: "javascript:alert(1)".into(),
        pane: String::new(),
    };
    assert!(tick_note(&conn, mine, n.id, &junk, 3).unwrap());
    let got = &notes(&conn, mine).unwrap()[0];
    assert_eq!(
        (
            got.done_commit.as_str(),
            got.done_doc.as_str(),
            got.done_evidence.as_str()
        ),
        ("", "", "")
    );
    assert!(
        evidence_ok("https://apps.apple.com/app/id1") && evidence_ok("http://localhost:3000/x")
    );
    for bad in [
        "file:///etc/passwd",
        "https://",
        "https:///x",
        "https://a b",
        "ftp://x",
        "https://x\n",
    ] {
        assert!(!evidence_ok(bad), "{bad}");
    }
    assert!(!evidence_ok(&format!("https://x/{}", "a".repeat(500))));
    assert!(commit_ok("90f09d6") && commit_ok(&"a".repeat(40)));
    assert!(!commit_ok("90f09d") && !commit_ok(&"a".repeat(41)) && !commit_ok("main"));
    assert!(doc_ok("82cc8f2d3c") && !doc_ok("82cc8f2d3") && !doc_ok("82cc8f2d3z"));
}

/// An emptied line is not a blank row: rewriting a note to nothing takes
/// it off the list, which is what a reader who selected all and pressed
/// delete meant. It is still recoverable, as any other removal is.
#[test]
fn a_line_rewritten_to_nothing_comes_off_the_list() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let n = add_note(&mut conn, d, "something", 0).unwrap().unwrap();
    assert!(set_note(&conn, d, n.id, Some("   "), None, 1).unwrap());
    assert!(notes(&conn, d).unwrap().is_empty());
    assert!(restore_note(&conn, d, n.id).unwrap());
    assert_eq!(notes(&conn, d).unwrap()[0].text, "something");
}

/// The cap is a cap, an empty line is not a line, and a desk that is not
/// a desk takes nothing. All three are the one `None`.
#[test]
fn a_list_is_bounded_and_takes_no_empty_line() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    assert!(add_note(&mut conn, d, "   ", 0).unwrap().is_none());
    assert!(add_note(&mut conn, d + 99, "nowhere", 0).unwrap().is_none());
    for i in 0..NOTES_PER_DESK {
        assert!(add_note(&mut conn, d, &format!("line {i}"), i)
            .unwrap()
            .is_some());
    }
    assert!(add_note(&mut conn, d, "one too many", 0).unwrap().is_none());
    // A line taken off makes room again: the cap is on the list, not on
    // everything the desk has ever held.
    let first = notes(&conn, d).unwrap()[0].id;
    remove_note(&conn, d, first, 1).unwrap();
    assert!(add_note(&mut conn, d, "room now", 0).unwrap().is_some());
}

/// Cut on a character, not a byte: a list written in any other language
/// than English must not come back invalid.
#[test]
fn a_long_line_is_cut_where_a_character_ends() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let long = "日".repeat(NOTE_CHARS + 50);
    let n = add_note(&mut conn, d, &long, 0).unwrap().unwrap();
    assert_eq!(n.text.chars().count(), NOTE_CHARS);
    assert_eq!(notes(&conn, d).unwrap()[0].text, n.text);
}

/// Closing a desk deletes nothing: it leaves every list, its notes stay
/// on it with their ticks, and reopening it brings both back -- with the
/// panes that closed with it, in their order, and not one closed before.
/// Only a prune past its close ends it, notes and all.
#[test]
fn closing_a_desk_keeps_its_list_and_reopening_brings_it_back() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let kept = add_note(&mut conn, d, "stays with it", 0).unwrap().unwrap();
    add_note(&mut conn, d, "and this", 0).unwrap().unwrap();
    assert!(set_note(&conn, d, kept.id, None, Some(true), 5).unwrap());
    let (Opened::Pane(a), Opened::Pane(b), Opened::Pane(c)) =
        (pane(&mut conn, d), pane(&mut conn, d), pane(&mut conn, d))
    else {
        panic!()
    };
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &a.id, 10).unwrap();
    tx.commit().unwrap();

    assert_eq!(
        close(&mut conn, d, 20).unwrap(),
        Some(vec![b.id.clone(), c.id.clone()])
    );
    assert_eq!(close(&mut conn, d, 21).unwrap(), None, "already closed");
    assert!(list(&conn).unwrap().is_empty());
    assert!(get(&conn, d).unwrap().is_none());
    assert!(add_note(&mut conn, d, "not on a closed desk", 0)
        .unwrap()
        .is_none());
    assert!(matches!(pane(&mut conn, d), Opened::NoSuchDesk));
    assert_eq!(closed_desks(&conn, 10).unwrap().len(), 1);
    assert!(
        closed_panes(&conn, 10).unwrap().is_empty(),
        "the desk's row stands for them"
    );
    assert_eq!(
        create(&conn, "/w", None, 0).unwrap().name,
        "w",
        "its name is free while it is closed"
    );

    assert!(reopen(&mut conn, d).unwrap());
    assert!(!reopen(&mut conn, d).unwrap(), "already open");
    let back = get(&conn, d).unwrap().unwrap();
    assert_eq!(
        back.panes
            .iter()
            .map(|p| (p.id.clone(), p.slot))
            .collect::<Vec<_>>(),
        vec![(b.id.clone(), 1), (c.id.clone(), 2)]
    );
    assert_eq!(
        closed_on(&conn, d).unwrap(),
        vec![a.id.clone()],
        "closed before it, still closed"
    );
    let ns = notes(&conn, d).unwrap();
    assert_eq!(ns.len(), 2);
    assert!(ns.iter().find(|n| n.id == kept.id).unwrap().done);

    close(&mut conn, d, 30).unwrap();
    assert!(
        prune_desks(&conn, 30, false).unwrap().is_empty(),
        "not before its close"
    );
    assert_eq!(prune_desks(&conn, 31, true).unwrap().len(), 1);
    assert_eq!(
        prune_desks(&conn, 31, false).unwrap(),
        vec![(d, "w".to_string())]
    );
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM desk_notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "a pruned desk takes its list by the cascade");
}

fn pane(conn: &mut Connection, desk: i64) -> Opened {
    open_pane(conn, desk, "/p", "", 0).unwrap()
}

fn slots(conn: &Connection, desk: i64) -> Vec<i64> {
    get(conn, desk)
        .unwrap()
        .unwrap()
        .panes
        .iter()
        .map(|p| p.slot)
        .collect()
}

/// A pane keeps the last conversation its hook named, only a UUID, and a
/// hook saying the same id again changes nothing and tells no one.
#[test]
fn a_pane_keeps_the_last_conversation_and_only_a_uuid() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap();
    let Opened::Pane(p) = pane(&mut conn, d.id) else {
        panic!("no pane")
    };
    assert_eq!(p.agent_session, "");
    let a = "0f6c1c2e-8a41-4b7e-9d3a-5e2f1b7c9a10";
    let b = "a1b2c3d4-0000-4000-8000-123456789abc";
    assert!(set_agent_session(&conn, &p.id, a).unwrap());
    assert!(
        !set_agent_session(&conn, &p.id, a).unwrap(),
        "same id again"
    );
    assert_eq!(
        super::pane(&conn, &p.id)
            .unwrap()
            .unwrap()
            .pane
            .agent_session,
        a
    );
    assert!(set_agent_session(&conn, &p.id, b).unwrap());
    assert_eq!(get(&conn, d.id).unwrap().unwrap().panes[0].agent_session, b);
    for bad in [
        "",
        "; rm -rf ~",
        "A1B2C3D4-0000-4000-8000-123456789ABC",
        "a1b2c3d4-0000-4000-8000-123456789abc ",
        "a1b2c3d4-0000-4000-8000-123456789ab$",
        "a1b2c3d400004000800-0123456789abcde",
    ] {
        assert!(!valid_session(bad), "{bad:?}");
        assert!(!set_agent_session(&conn, &p.id, bad).unwrap());
    }
    assert!(!set_agent_session(&conn, "nope", a).unwrap());
    // A closed pane is no longer a pane; its conversation waits with it
    // in `panes_closed`, for Undo.
    let tx = conn.transaction().unwrap();
    assert!(close_pane(&tx, &p.id, 1).unwrap().is_some());
    tx.commit().unwrap();
    assert!(super::pane(&conn, &p.id).unwrap().is_none());
}

/// A planned restart marks the panes it should bring back, and only the
/// ones with a conversation to bring; the next daemon takes the marks
/// once, and a third daemon finds none.
#[test]
fn resume_marks_are_set_for_known_conversations_and_taken_once() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap();
    let Opened::Pane(talked) = pane(&mut conn, d.id) else {
        panic!("no pane")
    };
    let Opened::Pane(silent) = pane(&mut conn, d.id) else {
        panic!("no pane")
    };
    let Opened::Pane(other) = pane(&mut conn, d.id) else {
        panic!("no pane")
    };
    let a = "0f6c1c2e-8a41-4b7e-9d3a-5e2f1b7c9a10";
    assert!(set_agent_session(&conn, &talked.id, a).unwrap());
    assert!(set_agent_session(&conn, &other.id, a).unwrap());
    let none = (Vec::<String>::new(), Vec::<String>::new());
    assert_eq!(take_resume(&conn).unwrap(), none);
    // Two asked for, one with a conversation: one mark. The third pane
    // knows a conversation but was not asked for, and stays unmarked.
    assert_eq!(
        mark_resume(&conn, &[talked.id.clone(), silent.id.clone()]).unwrap(),
        1
    );
    assert_eq!(take_resume(&conn).unwrap().0, vec![talked.id.clone()]);
    assert_eq!(take_resume(&conn).unwrap(), none, "taken once");
    // A new set replaces the old, so a mark cannot outlive the restart
    // that made it.
    mark_resume(&conn, std::slice::from_ref(&talked.id)).unwrap();
    mark_resume(&conn, std::slice::from_ref(&other.id)).unwrap();
    assert_eq!(take_resume(&conn).unwrap().0, vec![other.id.clone()]);

    // 1.7.1: an unplanned stop offers instead, only where a conversation
    // is known, and never over a planned mark.
    mark_resume(&conn, std::slice::from_ref(&talked.id)).unwrap();
    assert_eq!(
        mark_offer(
            &conn,
            &[talked.id.clone(), other.id.clone(), silent.id.clone()]
        )
        .unwrap(),
        1
    );
    assert_eq!(
        take_resume(&conn).unwrap(),
        (vec![talked.id.clone()], vec![other.id.clone()])
    );
}

/// Where the shell went is where it starts next, and saying the same
/// folder twice is no change.
#[test]
fn a_pane_keeps_the_folder_its_shell_moved_to() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap();
    let Opened::Pane(p) = pane(&mut conn, d.id) else {
        panic!()
    };
    assert!(set_cwd(&conn, &p.id, "/p/sub").unwrap());
    assert!(!set_cwd(&conn, &p.id, "/p/sub").unwrap());
    assert_eq!(
        super::pane(&conn, &p.id).unwrap().unwrap().pane.cwd,
        "/p/sub"
    );
    assert!(!set_cwd(&conn, "nope", "/x").unwrap());
}

/// The gesture is a right-click on a folder, so the folder's name is the
/// one the reader is expecting -- and two desks on one folder is the
/// workflow `Show desk` exists for, not a mistake to refuse.
#[test]
fn a_desk_is_named_after_its_folder_and_the_second_one_is_numbered() {
    let mut conn = db();
    let a = create(&conn, "/home/p/snyvi", None, 0).unwrap();
    let b = create(&conn, "/home/p/snyvi", None, 0).unwrap();
    let c = create(&conn, "/home/p/snyvi", None, 0).unwrap();
    assert_eq!(
        (a.name.as_str(), b.name.as_str(), c.name.as_str()),
        ("snyvi", "snyvi 2", "snyvi 3")
    );
    assert_ne!(a.id, b.id);
    assert_eq!(b.root, "/home/p/snyvi", "same folder, separate instance");
    // A name the reader typed is theirs, numbered only if it collides.
    let d = create(&conn, "/home/p/snyvi", Some("chores"), 0).unwrap();
    assert_eq!(d.name, "chores");
    // And the count follows the desks that exist, not the ones that did:
    // closing the second gives its name back.
    assert!(close(&mut conn, b.id, 1).unwrap().is_some());
    assert_eq!(
        create(&conn, "/home/p/snyvi", None, 0).unwrap().name,
        "snyvi 2"
    );
}

/// Slots, not splits. The lowest free one is taken, so closing pane 1 of
/// four and opening another puts it back in slot 1 rather than leaving a
/// hole and growing the grid.
#[test]
fn panes_fill_the_lowest_free_slot_and_the_fifth_is_refused() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    for _ in 0..PER_DESK {
        assert!(matches!(pane(&mut conn, d), Opened::Pane(_)));
    }
    assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
    assert!(matches!(pane(&mut conn, d), Opened::DeskFull));

    let first = get(&conn, d).unwrap().unwrap().panes[0].id.clone();
    let tx = conn.transaction().unwrap();
    assert_eq!(close_pane(&tx, &first, 1).unwrap(), Some((d, 1)));
    tx.commit().unwrap();
    // The rest closed up; the next one takes the end.
    assert_eq!(slots(&conn, d), vec![1, 2, 3]);
    assert!(matches!(pane(&mut conn, d), Opened::Pane(p) if p.slot == 4));
    assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
}

/// A move renumbers: the pane at 1 is at 3 and the one at 3 at 1, an
/// empty slot takes a pane without a partner, and nothing leaves its desk.
#[test]
fn a_pane_moves_to_another_slot_and_the_one_there_takes_its_place() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    let other = create(&conn, "/q", None, 0).unwrap().id;
    for _ in 0..3 {
        pane(&mut conn, d);
    }
    pane(&mut conn, other);
    let ids = |conn: &Connection, d| -> Vec<String> {
        get(conn, d)
            .unwrap()
            .unwrap()
            .panes
            .iter()
            .map(|p| p.id.clone())
            .collect()
    };
    let before = ids(&conn, d);
    assert!(layout(&conn, d, 0.5, 0.5, Some(1)).unwrap());
    assert!(layout(&conn, other, 0.5, 0.5, Some(1)).unwrap());
    let tx = conn.transaction().unwrap();
    assert!(move_pane(&tx, d, 1, 3).unwrap());
    tx.commit().unwrap();
    assert_eq!(
        ids(&conn, d),
        [before[2].clone(), before[1].clone(), before[0].clone()]
    );
    assert_eq!(
        get(&conn, d).unwrap().unwrap().full_slot,
        3,
        "full view went with its pane"
    );
    assert_eq!(get(&conn, other).unwrap().unwrap().full_slot, 1);

    // Into the empty slot 4: nothing comes back the other way.
    let tx = conn.transaction().unwrap();
    assert!(move_pane(&tx, d, 2, 4).unwrap());
    tx.commit().unwrap();
    assert_eq!(slots(&conn, d), vec![1, 3, 4]);

    // No pane at the slot, a slot out of range: refused, nothing moved.
    let tx = conn.transaction().unwrap();
    assert!(!move_pane(&tx, d, 2, 1).unwrap());
    assert!(!move_pane(&tx, d, 1, 5).unwrap());
    assert!(!move_pane(&tx, d, 0, 1).unwrap());
    tx.commit().unwrap();
    assert_eq!(slots(&conn, d), vec![1, 3, 4]);
    assert_eq!(slots(&conn, other), vec![1], "the other desk is untouched");
}

/// No cap across desks: twelve panes on three desks all open, and each
/// desk still stops at its own four.
#[test]
fn twelve_panes_on_three_desks_all_open() {
    let mut conn = db();
    let desks: Vec<i64> = (0..3)
        .map(|_| create(&conn, "/p", None, 0).unwrap().id)
        .collect();
    for d in &desks {
        for _ in 0..PER_DESK {
            assert!(matches!(pane(&mut conn, *d), Opened::Pane(_)));
        }
        assert!(matches!(pane(&mut conn, *d), Opened::DeskFull));
    }
    assert_eq!(panes_open(&conn).unwrap(), 3 * PER_DESK);

    // Closing a whole desk closes its panes with it.
    assert_eq!(
        close(&mut conn, desks[0], 1).unwrap().unwrap().len(),
        PER_DESK as usize
    );
    assert_eq!(
        panes_open(&conn).unwrap(),
        2 * PER_DESK,
        "its panes closed with it"
    );
}

/// A pane id leaves the daemon -- Phase 3 puts it in a child's environment
/// as `SNYVI_SESSION` -- so it is 16 bytes from the OS and not a counter.
#[test]
fn a_pane_id_is_random_hex_and_a_desk_id_is_not() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap();
    assert_eq!(d.id, 1, "a desk is an integer, like a project");
    let Opened::Pane(a) = pane(&mut conn, d.id) else {
        panic!("a pane on an empty desk")
    };
    let Opened::Pane(b) = pane(&mut conn, d.id) else {
        panic!("a second pane")
    };
    assert_eq!(a.id.len(), 32);
    assert!(a.id.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a.id, b.id);
}

/// Four integers of geometry, and a drag can send anything.
#[test]
fn divider_fractions_are_clamped_and_a_missing_desk_says_so() {
    let conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    assert!(layout(&conn, d, 0.0, 2.5, None).unwrap());
    let after = get(&conn, d).unwrap().unwrap();
    assert_eq!((after.col, after.row), (MIN_FRACTION, MAX_FRACTION));
    assert!(layout(&conn, d, f64::NAN, 0.4, None).unwrap());
    assert_eq!(get(&conn, d).unwrap().unwrap().col, 0.5);
    assert!(!layout(&conn, d + 99, 0.5, 0.5, None).unwrap());
    // Full view is kept, left alone when not sent, and a slot out of
    // range is the grid.
    assert!(layout(&conn, d, 0.5, 0.5, Some(3)).unwrap());
    assert!(layout(&conn, d, 0.5, 0.5, None).unwrap());
    assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 3);
    assert!(layout(&conn, d, 0.5, 0.5, Some(9)).unwrap());
    assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 0);
    assert!(!rename(&conn, d, "  ").unwrap(), "a name is not whitespace");
    assert!(rename(&conn, d, "chores").unwrap());
    assert_eq!(get(&conn, d).unwrap().unwrap().name, "chores");
}

/// A desk that is not there is not a desk that is full.
#[test]
fn a_pane_on_no_desk_is_refused_without_inventing_one() {
    let mut conn = db();
    assert!(matches!(pane(&mut conn, 7), Opened::NoSuchDesk));
    assert_eq!(panes_open(&conn).unwrap(), 0);
    assert!(list(&conn).unwrap().is_empty());
}

/// The list is what the sidebar draws, and a desk with no panes is what
/// every desk is for the moment after it is made.
#[test]
fn the_list_carries_empty_desks_and_their_panes_in_slot_order() {
    let mut conn = db();
    let a = create(&conn, "/p/one", None, 0).unwrap().id;
    let b = create(&conn, "/p/two", None, 0).unwrap().id;
    let _ = pane(&mut conn, b);
    let _ = pane(&mut conn, b);
    let listed = list(&conn).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, a);
    assert!(listed[0].panes.is_empty());
    assert_eq!(
        listed[1].panes.iter().map(|p| p.slot).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(listed[1].panes[0].cwd, "/p");
}

/// 1.7.1: a close keeps the pane for Undo and closes the gap it leaves,
/// so the slots are always 1 to n; full view follows its slot.
#[test]
fn a_closed_pane_leaves_no_gap_and_comes_back_at_the_end() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    for _ in 0..3 {
        pane(&mut conn, d);
    }
    let ids: Vec<String> = get(&conn, d)
        .unwrap()
        .unwrap()
        .panes
        .iter()
        .map(|p| p.id.clone())
        .collect();
    assert!(rename_pane(&conn, &ids[1], "  the   tests \n").unwrap());
    assert!(layout(&conn, d, 0.5, 0.5, Some(3)).unwrap());
    let tx = conn.transaction().unwrap();
    assert_eq!(close_pane(&tx, &ids[1], 5).unwrap(), Some((d, 2)));
    assert_eq!(close_pane(&tx, "nope", 5).unwrap(), None);
    tx.commit().unwrap();
    let after = get(&conn, d).unwrap().unwrap();
    assert_eq!(
        after
            .panes
            .iter()
            .map(|p| (p.id.clone(), p.slot))
            .collect::<Vec<_>>(),
        [(ids[0].clone(), 1), (ids[2].clone(), 2)]
    );
    assert_eq!(after.full_slot, 2, "full view follows the pane it was on");

    // Back, stopped, at the lowest free slot, with its name.
    let Restored::Pane(p) = restore_pane(&mut conn, &ids[1]).unwrap() else {
        panic!("not restored")
    };
    assert_eq!((p.slot, p.name.as_str()), (3, "the tests"));
    assert!(
        matches!(restore_pane(&mut conn, &ids[1]).unwrap(), Restored::Gone),
        "twice is not twice"
    );

    // Closing the one in full view puts the grid back.
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &ids[2], 6).unwrap();
    tx.commit().unwrap();
    assert_eq!(get(&conn, d).unwrap().unwrap().full_slot, 0);
}

/// The desk filled while the pane was closed: it says so and stays closed.
#[test]
fn a_closed_pane_does_not_come_back_to_a_full_desk() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    let Opened::Pane(first) = pane(&mut conn, d) else {
        panic!()
    };
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &first.id, 1).unwrap();
    tx.commit().unwrap();
    for _ in 0..PER_DESK {
        pane(&mut conn, d);
    }
    assert!(matches!(
        restore_pane(&mut conn, &first.id).unwrap(),
        Restored::DeskFull
    ));
    assert_eq!(closed_on(&conn, d).unwrap(), vec![first.id.clone()]);
}

/// Kept until `prune`, like a deleted document: only what was closed
/// before the cut goes, and a desk's prune takes the rest.
#[test]
fn closed_panes_last_until_prune_or_their_desk() {
    let mut conn = db();
    let d = create(&conn, "/p", None, 0).unwrap().id;
    let (Opened::Pane(a), Opened::Pane(b)) = (pane(&mut conn, d), pane(&mut conn, d)) else {
        panic!()
    };
    let tx = conn.transaction().unwrap();
    close_pane(&tx, &a.id, 10).unwrap();
    close_pane(&tx, &b.id, 20).unwrap();
    tx.commit().unwrap();
    let would = prune_closed(&conn, 15, true).unwrap();
    assert_eq!(
        would.iter().map(|g| g.0.clone()).collect::<Vec<_>>(),
        vec![a.id.clone()]
    );
    assert_eq!(
        closed_on(&conn, d).unwrap().len(),
        2,
        "a dry run removes nothing"
    );
    assert_eq!(prune_closed(&conn, 15, false).unwrap().len(), 1);
    assert_eq!(closed_on(&conn, d).unwrap(), vec![b.id.clone()]);
    close(&mut conn, d, 30).unwrap();
    prune_desks(&conn, 31, false).unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM panes_closed", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "the desk's prune cascades");
}

/// A friend's line lands as a suggestion with their name, and keeping it
/// clears the question, not the name; one kept from Home has it too.
#[test]
fn a_friends_line_keeps_its_sender() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let Suggested::Note(s) =
        suggest_note_from(&mut conn, d, "water the beans", "Trapti", "Trapti", 1).unwrap()
    else {
        panic!()
    };
    assert_eq!(s.sent_by, "Trapti");
    assert!(keep_note(&conn, d, s.id).unwrap());
    let kept = notes(&conn, d)
        .unwrap()
        .into_iter()
        .find(|n| n.id == s.id)
        .unwrap();
    assert_eq!(
        (kept.suggested_by.as_str(), kept.sent_by.as_str()),
        ("", "Trapti")
    );
    let home = add_note_from(&mut conn, d, "seed list", "Trapti", 2)
        .unwrap()
        .unwrap();
    assert_eq!(home.sent_by, "Trapti");
    assert_eq!(notes(&conn, d).unwrap().last().unwrap().sent_by, "Trapti");
    let mine = add_note(&mut conn, d, "mine", 3).unwrap().unwrap();
    assert_eq!(mine.sent_by, "");
}

/// An agent's suggestion is a ghost row until the reader keeps it: it
/// sits after what is open, cannot be ticked by an agent, a desk holds
/// only a few waiting, and keeping one makes it an ordinary line.
#[test]
fn a_suggestion_waits_for_the_reader_and_is_theirs_once_kept() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let mine = add_note(&mut conn, d, "mine", 0).unwrap().unwrap();
    let Suggested::Note(s1) =
        suggest_note(&mut conn, d, "  write the migration  ", "claude-code", 1).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        (s1.text.as_str(), s1.suggested_by.as_str()),
        ("write the migration", "claude-code")
    );
    assert_eq!(
        suggest_note(&mut conn, d, " ", "x", 1).unwrap(),
        Suggested::Empty
    );
    let later = add_note(&mut conn, d, "written after", 2).unwrap().unwrap();
    let order: Vec<i64> = notes(&conn, d).unwrap().iter().map(|n| n.id).collect();
    assert_eq!(
        order,
        vec![mine.id, later.id, s1.id],
        "suggestions after what is open"
    );
    assert!(
        !tick_note(&conn, d, s1.id, &by("claude-code"), 3).unwrap(),
        "not the agent's to tick"
    );
    for i in 0..SUGGESTIONS_PER_DESK - 1 {
        assert!(matches!(
            suggest_note(&mut conn, d, &format!("idea {i}"), "a", 4).unwrap(),
            Suggested::Note(_)
        ));
    }
    assert_eq!(
        suggest_note(&mut conn, d, "one too many", "a", 5).unwrap(),
        Suggested::Full
    );
    assert!(keep_note(&conn, d, s1.id).unwrap());
    assert!(!keep_note(&conn, d, s1.id).unwrap(), "kept once");
    assert!(
        !keep_note(&conn, d, mine.id).unwrap(),
        "a line of the reader's is not a suggestion"
    );
    let kept = notes(&conn, d)
        .unwrap()
        .into_iter()
        .find(|n| n.id == s1.id)
        .unwrap();
    assert!(kept.suggested_by.is_empty());
    assert!(tick_note(&conn, d, s1.id, &by("claude-code"), 6).unwrap());
    assert!(matches!(
        suggest_note(&mut conn, d, "room again", "a", 7).unwrap(),
        Suggested::Note(_)
    ));
    assert_eq!(
        suggest_note(&mut conn, 99, "no desk", "a", 7).unwrap(),
        Suggested::NoSuchDesk
    );
}

/// Left off is one line per desk: set, replaced, cleared -- each hands
/// back the one before, for an Undo -- and carried on the desk.
#[test]
fn keys_are_names_per_desk_or_for_every_desk_and_go_with_prune() {
    let mut conn = db();
    let a = create(&conn, "/w/a", None, 0).unwrap().id;
    let b = create(&conn, "/w/b", None, 0).unwrap().id;
    add_key(&conn, a, "GH_TOKEN", "github", 10).unwrap();
    add_key(&conn, EVERY_DESK, "OPENROUTER_API_KEY", "openrouter", 20).unwrap();
    add_key(&conn, EVERY_DESK, "GH_TOKEN", "github", 30).unwrap();
    let named = |v: Vec<DeskKey>| {
        v.into_iter()
            .map(|k| (k.desk_id, k.name, k.used_at))
            .collect::<Vec<_>>()
    };
    // Desk a's own GH_TOKEN shadows the one for every desk; b gets both
    // every-desk rows.
    let ka = keys(&conn, a).unwrap();
    assert_eq!(
        named(ka.clone()),
        vec![
            (a, "GH_TOKEN".to_string(), 0),
            (0, "OPENROUTER_API_KEY".to_string(), 0)
        ]
    );
    assert_eq!(
        named(keys(&conn, b).unwrap()),
        vec![
            (0, "GH_TOKEN".to_string(), 0),
            (0, "OPENROUTER_API_KEY".to_string(), 0)
        ]
    );
    assert_eq!(get(&conn, a).unwrap().unwrap().keys, ka);
    // A panel started on a: its two are stamped, b's own view of GH_TOKEN is not.
    touch_keys(&conn, &ka, 40).unwrap();
    assert_eq!(
        named(keys(&conn, b).unwrap()),
        vec![
            (0, "GH_TOKEN".to_string(), 0),
            (0, "OPENROUTER_API_KEY".to_string(), 40)
        ]
    );
    assert!(remove_key(&conn, a, "GH_TOKEN").unwrap());
    assert!(!remove_key(&conn, a, "GH_TOKEN").unwrap());
    assert_eq!(keys(&conn, a).unwrap()[0].desk_id, EVERY_DESK);
    // Closing keeps them; prune takes the desk's own rows and no other.
    add_key(&conn, a, "ELEVENLABS_API_KEY", "elevenlabs", 50).unwrap();
    close(&mut conn, a, 60).unwrap();
    assert_eq!(keys(&conn, a).unwrap().len(), 3);
    assert_eq!(
        prune_keys(&conn, 61, true).unwrap(),
        vec![(a, "ELEVENLABS_API_KEY".to_string())]
    );
    assert_eq!(keys(&conn, a).unwrap().len(), 3);
    assert_eq!(prune_keys(&conn, 61, false).unwrap().len(), 1);
    prune_desks(&conn, 61, false).unwrap();
    assert_eq!(keys(&conn, a).unwrap().len(), 2);
    assert_eq!(keys(&conn, b).unwrap().len(), 2);
}

#[test]
fn left_off_is_one_line_and_hands_back_the_one_before() {
    let conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    assert_eq!(get(&conn, d).unwrap().unwrap().left_off, None);
    let first = LeftOff {
        text: "If the tests pass,\n  ship the migration".into(),
        at: 10,
        by: "claude-code".into(),
        about: "82CC8F2D3C".into(),
        pane: "p1".into(),
    };
    assert_eq!(set_left_off(&conn, d, &first).unwrap(), Some(None));
    let got = get(&conn, d).unwrap().unwrap().left_off.unwrap();
    assert_eq!(got.text, "If the tests pass, ship the migration");
    assert_eq!(
        (
            got.at,
            got.by.as_str(),
            got.about.as_str(),
            got.pane.as_str()
        ),
        (10, "claude-code", "82cc8f2d3c", "p1")
    );
    let long = LeftOff {
        text: "x".repeat(300),
        at: 11,
        about: "../etc".into(),
        ..LeftOff::default()
    };
    assert_eq!(
        set_left_off(&conn, d, &long).unwrap(),
        Some(Some(got.clone()))
    );
    let now = get(&conn, d).unwrap().unwrap().left_off.unwrap();
    assert_eq!(
        (
            now.text.chars().count(),
            now.about.as_str(),
            now.by.as_str()
        ),
        (LEFT_OFF_CHARS, "", "")
    );
    let cleared = set_left_off(&conn, d, &LeftOff::default()).unwrap();
    assert_eq!(cleared, Some(Some(now)));
    assert_eq!(get(&conn, d).unwrap().unwrap().left_off, None);
    assert_eq!(
        set_left_off(&conn, d, &got).unwrap(),
        Some(None),
        "the Undo puts it back"
    );
    assert_eq!(get(&conn, d).unwrap().unwrap().left_off, Some(got));
    assert_eq!(set_left_off(&conn, 99, &first).unwrap(), None);
}

/// Opening a desk is written once a minute at most, and never on a
/// closed one.
#[test]
fn a_visit_is_written_at_most_once_a_minute() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    assert!(visit(&conn, d, 1_000).unwrap());
    assert!(
        !visit(&conn, d, 1_030).unwrap(),
        "30 s later is the same visit"
    );
    assert_eq!(get(&conn, d).unwrap().unwrap().visited_at, 1_000);
    assert!(visit(&conn, d, 1_061).unwrap());
    assert_eq!(get(&conn, d).unwrap().unwrap().visited_at, 1_061);
    close(&mut conn, d, 2_000).unwrap();
    assert!(!visit(&conn, d, 5_000).unwrap());
}

/// A desk parks with its next step and comes down again, each handing
/// back what it was, for the Undo in the row.
#[test]
fn a_desk_parks_with_its_next_step_and_comes_down() {
    let conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    assert_eq!(get(&conn, d).unwrap().unwrap().parked, None);
    let to = Parked {
        at: 50,
        next: "Retry-After in\n whole seconds".into(),
    };
    assert_eq!(park(&conn, d, Some(&to)).unwrap(), Some(None));
    let got = get(&conn, d).unwrap().unwrap().parked.unwrap();
    assert_eq!(
        (got.at, got.next.as_str()),
        (50, "Retry-After in whole seconds")
    );
    assert_eq!(park(&conn, d, None).unwrap(), Some(Some(got)));
    assert_eq!(get(&conn, d).unwrap().unwrap().parked, None);
    assert_eq!(park(&conn, 99, None).unwrap(), None);
}

/// The log's ticks: since a time, oldest first, with what the agent said,
/// and never a line put away or a closed desk's.
#[test]
fn ticks_since_leave_out_what_was_put_away_and_closed_desks() {
    let mut conn = db();
    let d = create(&conn, "/w", None, 0).unwrap().id;
    let gone = create(&conn, "/x", None, 0).unwrap().id;
    let ids: Vec<i64> = ["old", "b", "a", "put away"]
        .iter()
        .map(|t| add_note(&mut conn, d, t, 0).unwrap().unwrap().id)
        .collect();
    set_note(&conn, d, ids[0], None, Some(true), 5).unwrap();
    set_note(&conn, d, ids[1], None, Some(true), 30).unwrap();
    let tick = Tick {
        by: "claude-code".into(),
        commit: "a41c2e9".into(),
        ..Tick::default()
    };
    tick_note(&conn, d, ids[2], &tick, 20).unwrap();
    set_note(&conn, d, ids[3], None, Some(true), 25).unwrap();
    remove_note(&conn, d, ids[3], 26).unwrap();
    let other = add_note(&mut conn, gone, "closed", 0).unwrap().unwrap().id;
    set_note(&conn, gone, other, None, Some(true), 25).unwrap();
    close(&mut conn, gone, 40).unwrap();
    let got = done_since(&conn, 10).unwrap();
    let texts: Vec<&str> = got.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(texts, ["a", "b"]);
    assert_eq!(
        (got[0].by.as_str(), got[0].commit.as_str(), got[0].at),
        ("claude-code", "a41c2e9", 20)
    );
}

fn order(conn: &Connection) -> Vec<String> {
    list(conn).unwrap().into_iter().map(|d| d.name).collect()
}

/// The reader's order: the order desks were made in until one is moved, a
/// new desk last, and a closed desk back in its place when it is reopened.
#[test]
fn desks_keep_the_readers_order_and_a_new_one_goes_last() {
    let mut conn = db();
    let ids: Vec<i64> = ["a", "b", "c"]
        .iter()
        .map(|n| create(&conn, "/w", Some(n), 0).unwrap().id)
        .collect();
    assert_eq!(order(&conn), ["a", "b", "c"]);
    assert!(reorder(&mut conn, &[ids[2], ids[0], ids[1]]).unwrap());
    assert_eq!(order(&conn), ["c", "a", "b"]);
    create(&conn, "/w", Some("d"), 0).unwrap();
    assert_eq!(order(&conn), ["c", "a", "b", "d"]);
    // `a` closes and comes back where it was, not at the end.
    close(&mut conn, ids[0], 1).unwrap();
    assert_eq!(order(&conn), ["c", "b", "d"]);
    assert!(reopen(&mut conn, ids[0]).unwrap());
    assert_eq!(order(&conn), ["c", "a", "b", "d"]);
}

/// Only the whole list of open desks is an order: two windows that each saw
/// a different one cannot leave half of each.
#[test]
fn an_order_is_the_whole_list_of_open_desks_or_nothing() {
    let mut conn = db();
    let a = create(&conn, "/w", Some("a"), 0).unwrap().id;
    let b = create(&conn, "/w", Some("b"), 0).unwrap().id;
    let c = create(&conn, "/w", Some("c"), 0).unwrap().id;
    for bad in [
        vec![b, a],
        vec![c, b, a, 99],
        vec![c, b, b],
        vec![c, b, a, a],
        vec![],
    ] {
        assert!(!reorder(&mut conn, &bad).unwrap(), "{bad:?}");
    }
    assert_eq!(order(&conn), ["a", "b", "c"], "nothing moved");
    close(&mut conn, c, 1).unwrap();
    assert!(!reorder(&mut conn, &[c, b, a]).unwrap(), "a closed desk");
    assert!(reorder(&mut conn, &[b, a]).unwrap());
    assert_eq!(order(&conn), ["b", "a"]);
}
