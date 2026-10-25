use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::thread::SCHEMA).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO desks(id, name, root, created_at) VALUES(1, 'news', '/tmp/news', 1)",
        [],
    )
    .unwrap();
    conn
}

fn line(text: &str) -> Line {
    from_line(text).unwrap_or_else(|| panic!("{text}"))
}

#[test]
fn a_line_with_a_cadence_is_a_routine_and_its_first_word_the_command() {
    let l = line("newsroom · every day 07:30");
    assert_eq!((l.name.as_str(), l.cmd.as_str()), ("newsroom", "newsroom"));
    let l = line("/bench main, every weekday 9");
    assert_eq!((l.name.as_str(), l.cmd.as_str()), ("bench main", "bench"));
    assert_eq!(l.every.words(), "every weekday 09:00");
    // Not a command's name, or not a cadence: a plain note.
    assert_eq!(from_line("$(rm -rf) · every day 07:30"), None);
    assert_eq!(from_line("../x · every day"), None);
    assert_eq!(from_line("rerun every time the build fails"), None);
    assert_eq!(from_line("post the note by fri 10"), None);
}

#[test]
fn the_desks_own_commands_are_found_and_hashed() {
    let dir = crate::store::tempdir::Dir::new("snyvi-routine-cmds");
    let cmds = dir.path.join(".claude").join("commands");
    std::fs::create_dir_all(&cmds).unwrap();
    std::fs::write(cmds.join("newsroom.md"), "Fetch the news.").unwrap();
    std::fs::write(cmds.join("tick.md"), "Say the date.").unwrap();
    std::fs::write(cmds.join("not a command.md"), "x").unwrap();
    std::fs::write(cmds.join("notes.txt"), "x").unwrap();
    assert_eq!(commands(&dir.path), vec!["newsroom", "tick"]);
    assert!(commands(&dir.path.join("nowhere")).is_empty());
    let h = hash_of(&dir.path, "newsroom").unwrap();
    let mut r = Routine {
        cmd: "newsroom".into(),
        ..Routine::default()
    };
    assert_eq!(file_state(&dir.path, &r), "new");
    r.cmd_hash = h;
    assert_eq!(file_state(&dir.path, &r), "ok");
    std::fs::write(cmds.join("newsroom.md"), "Fetch the news, then publish it.").unwrap();
    assert_eq!(file_state(&dir.path, &r), "changed");
    std::fs::remove_file(cmds.join("newsroom.md")).unwrap();
    assert_eq!(file_state(&dir.path, &r), "gone");
}

#[test]
fn what_waits_for_the_reader_is_denied_in_the_runs_settings() {
    let waits =
        waits_ok("python3 -I newsroom/publish.py *\n\n  Bash(python3 newsroom/render.py *)  \n")
            .unwrap();
    let s = settings(&["Bash(git push *)"], &waits);
    let deny: Vec<&str> = s["permissions"]["deny"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        deny,
        vec![
            "Bash(git push *)",
            "Bash(python3 -I newsroom/publish.py *)",
            "Bash(python3 newsroom/render.py *)",
        ]
    );
    assert_eq!(
        s.as_object().unwrap().len(),
        1,
        "deny rules and nothing else"
    );
    assert_eq!(waits_ok("a\u{7}b"), None);
    assert_eq!(waits_ok(&"x\n".repeat(13)), None);
}

#[test]
fn the_clock_finds_whats_due_and_rearms_it_once() {
    let mut c = db();
    let now = 1_800_000_000;
    let Added::Routine(r) = add(
        &mut c,
        1,
        &line("tick · every day 07:30"),
        &[],
        "h",
        &Offer::default(),
        now,
    )
    .unwrap() else {
        panic!("added");
    };
    assert!(r.due_at > now && r.due_at <= now + 86_400);
    assert!(due(&c, r.due_at - 1).unwrap().is_empty());
    let found = due(&c, r.due_at + 5).unwrap();
    assert_eq!(found.len(), 1);
    // Rearmed before the start: the same tick never finds it twice.
    let late = rearm(&c, &found[0], r.due_at + 5).unwrap();
    assert_eq!(late, 0);
    assert!(due(&c, r.due_at + 6).unwrap().is_empty());
    // A daemon that slept through the hour says how late it ran.
    let r = get(&c, r.id).unwrap().unwrap();
    let late = rearm(&c, &r, r.due_at + 13 * 3600).unwrap();
    assert_eq!(late, 13 * 3600);
}

#[test]
fn paused_closed_offered_or_removed_never_ring() {
    let mut c = db();
    let now = 1_800_000_000;
    let add1 = |c: &mut Connection, text: &str, by: &str| match add(
        c,
        1,
        &line(text),
        &[],
        "h",
        &Offer { by, pane: "p1" },
        now,
    )
    .unwrap()
    {
        Added::Routine(r) => r,
        other => panic!("{other:?}"),
    };
    let a = add1(&mut c, "a · every day 07:30", "");
    let b = add1(&mut c, "b · every day 07:30", "panel 2");
    assert_eq!(b.suggested_by, "panel 2");
    assert!(b.cmd_hash.is_empty(), "an offer is not allowed until saved");
    let later = now + 2 * 86_400;
    let ids = |c: &Connection| {
        due(c, later)
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&c), vec![a.id]);
    assert!(act(&c, a.id, Act::Pause, now).unwrap());
    assert!(ids(&c).is_empty());
    assert!(act(&c, a.id, Act::Resume, now).unwrap());
    assert_eq!(ids(&c), vec![a.id]);
    // A parked desk's hour is found, to be passed by and said (`routine_run`).
    c.execute("UPDATE desks SET parked_at = 5 WHERE id = 1", [])
        .unwrap();
    assert_eq!(ids(&c), vec![a.id]);
    c.execute("UPDATE desks SET closed_at = 5 WHERE id = 1", [])
        .unwrap();
    assert!(ids(&c).is_empty());
    // Its hours move on quietly, so reopening never starts a stale run.
    assert_eq!(pass_closed(&c, later).unwrap(), 2);
    assert!(get(&c, a.id).unwrap().unwrap().due_at > later);
    c.execute(
        "UPDATE desks SET parked_at = 0, closed_at = 0 WHERE id = 1",
        [],
    )
    .unwrap();
    assert!(act(&c, a.id, Act::Remove, now).unwrap());
    assert!(ids(&c).is_empty());
    assert!(
        get(&c, a.id).unwrap().is_some(),
        "removed from view, not deleted"
    );
    assert!(act(&c, a.id, Act::Restore, now).unwrap());
    // The offer, saved, is the reader's and rings.
    let e = crate::due::every::every("every day 07:30").unwrap();
    let s = Save {
        name: "b".into(),
        every: e,
        waits: vec![],
        minutes: 25,
        five_hour: 80,
        hash: "h2".into(),
    };
    assert!(save(&c, b.id, &s, now).unwrap());
    assert_eq!(ids(&c), vec![a.id, b.id]);
}

#[test]
fn a_desk_keeps_a_handful() {
    let mut c = db();
    for i in 0..PER_DESK {
        let l = line(&format!("r{i} · every day 07:30"));
        assert!(matches!(
            add(&mut c, 1, &l, &[], "h", &Offer::default(), 1).unwrap(),
            Added::Routine(_)
        ));
    }
    let l = line("one-more · every day 07:30");
    assert_eq!(
        add(&mut c, 1, &l, &[], "h", &Offer::default(), 1).unwrap(),
        Added::Full
    );
    assert_eq!(
        add(&mut c, 9, &l, &[], "h", &Offer::default(), 1).unwrap(),
        Added::NoSuchDesk
    );
}

#[test]
fn a_run_begins_ends_and_is_kept() {
    let mut c = db();
    let Added::Routine(r) = add(
        &mut c,
        1,
        &line("tick · every day 07:30"),
        &[],
        "h",
        &Offer::default(),
        1,
    )
    .unwrap() else {
        panic!("added");
    };
    set_pane(&c, r.id, "p9").unwrap();
    assert_eq!(of_pane(&c, "p9").unwrap().unwrap().id, r.id);
    assert_eq!(panes(&c, 1).unwrap(), vec!["p9"]);
    began(&c, r.id, "clock", "/tick", SESSION, 100).unwrap();
    assert_eq!(get(&c, r.id).unwrap().unwrap().running_since, 100);
    assert!(ended(&c, r.id, "done", "Fetched 3 items; 2 wait for you.", 760).unwrap());
    assert!(
        !ended(&c, r.id, "done", "twice", 761).unwrap(),
        "a run ends once"
    );
    // A run card's command is not a session: it is kept, not counted.
    began(
        &c,
        r.id,
        "card",
        "python3 publish.py",
        "python3 publish.py",
        800,
    )
    .unwrap();
    ended(&c, r.id, "ran · exit 0", "", 830).unwrap();
    skipped(&c, r.id, "desk parked", 900).unwrap();
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!(r.runs, 1);
    assert_eq!(r.last_line, "Fetched 3 items; 2 wait for you.");
    assert_eq!(r.last_state, "skipped: desk parked");
    let runs = runs_of(&c, r.id, 10).unwrap();
    let states: Vec<&str> = runs.iter().map(|x| x.state.as_str()).collect();
    assert_eq!(states, vec!["skipped: desk parked", "ran · exit 0", "done"]);
    assert_eq!(week(&c, 0).unwrap(), (1, 0));
    began(&c, r.id, "clock", "/tick", SESSION, 1000).unwrap();
    assert_eq!(end_all(&c, 1001).unwrap(), 1);
    assert_eq!(
        get(&c, r.id).unwrap().unwrap().last_state,
        "ended: snyvi restarted"
    );
}
