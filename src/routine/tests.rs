use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::checks::COLUMNS_1_58)
        .unwrap();
    conn.execute_batch(crate::thread::SCHEMA).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(DRAFT_COLUMNS_1_53).unwrap();
    conn.execute_batch(LATE_COLUMNS_1_54).unwrap();
    conn.execute_batch(TRIGGER_COLUMNS_1_63).unwrap();
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

/// The clock's look at `at` for one routine: its earliest set of words
/// taken and re-armed; how late it is.
fn fire(c: &Connection, r: &Routine, at: i64) -> i64 {
    let f = times::fired(c, r.id, at).unwrap().expect("a time past due");
    rearm(c, r, &f, at).unwrap()
}

#[test]
fn a_line_with_a_cadence_is_a_routine_and_its_first_word_the_command() {
    let l = line("newsroom · every day 07:30");
    assert_eq!((l.name.as_str(), l.cmd.as_str()), ("newsroom", "newsroom"));
    let l = line("/bench main, every weekday 9");
    assert_eq!((l.name.as_str(), l.cmd.as_str()), ("bench main", "bench"));
    assert_eq!(l.every.as_ref().unwrap().words(), "every weekday 09:00");
    assert!(l.slash && !line("bench · every day").slash);
    // A first word no command could be: the reader's words, as they are,
    // one argument to Claude and never a shell's.
    let l = line("open PRs, summarise · every weekday 9");
    assert_eq!(
        (l.name.as_str(), l.cmd.as_str()),
        ("open PRs, summarise", "open")
    );
    let l = line("$(rm -rf) · every day 07:30");
    assert_eq!((l.name.as_str(), l.cmd.as_str()), ("$(rm -rf)", ""));
    // Typed with `/`, it must be a command's name.
    assert_eq!(from_line("/../x · every day"), None);
    // 1.63: no when is a draft's line, the whole of it the reader's words.
    let l = line("rerun every time the build fails");
    assert_eq!(
        (l.name.as_str(), l.every),
        ("rerun every time the build fails", None)
    );
    assert_eq!(line("/bench main").every, None);
    assert_eq!(from_line(""), None);
}

/// A name no one's `~/.claude` has, so the reader's own never answer.
const NEWS: &str = "zz-snyvi-test-news";

#[test]
fn a_routines_file_is_resolved_hashed_and_watched() {
    let dir = crate::store::tempdir::Dir::new("snyvi-routine-cmds");
    let cmds = dir.path.join(".claude").join("commands");
    std::fs::create_dir_all(&cmds).unwrap();
    let f = cmds.join(format!("{NEWS}.md"));
    std::fs::write(&f, "Fetch the news.").unwrap();
    let Made::File(p, h) = resolve(&dir.path, &line(&format!("{NEWS} · every day"))) else {
        panic!("a file");
    };
    assert_eq!(p.file, format!(".claude/commands/{NEWS}.md"));
    let mut r = Routine {
        name: NEWS.into(),
        cmd: NEWS.into(),
        ..Routine::default()
    };
    assert_eq!(file_state(&dir.path, &r), "new");
    r.cmd_hash = h;
    r.file = p.file;
    assert_eq!(file_state(&dir.path, &r), "ok");
    std::fs::write(&f, "Fetch the news, then publish it.").unwrap();
    assert_eq!(file_state(&dir.path, &r), "changed");
    std::fs::remove_file(&f).unwrap();
    assert_eq!(file_state(&dir.path, &r), "gone");
    // Typed with `/` and not there: said, never taken as words.
    assert_eq!(
        resolve(&dir.path, &line(&format!("/{NEWS} · every day"))),
        Made::NoFile(NEWS.into())
    );
    assert_eq!(
        resolve(&dir.path, &line(&format!("{NEWS} please · every day"))),
        Made::Words
    );
    let w = Routine::default();
    assert_eq!(file_state(&dir.path, &w), "words");
}

#[test]
fn a_words_routine_is_its_words_and_a_commands_its_slash() {
    let mut r = Routine {
        name: "bench main".into(),
        cmd: "bench".into(),
        ..Routine::default()
    };
    assert_eq!(r.prompt(), "/bench main");
    r.cmd.clear();
    r.name = "open PRs, summarise".into();
    assert_eq!(r.prompt(), "open PRs, summarise");
    r.name = "/sneaky".into();
    assert_eq!(r.prompt(), "sneaky", "words never start a command");
}

#[test]
fn a_file_that_reads_continue_is_continued_and_any_other_resumed() {
    assert!(continues(
        "# News\n\nWith `continue: <answers>`, go on from the first step not done."
    ));
    assert!(continues("## Continue\nRead the answers."));
    assert!(!continues(
        "# News\n\nContinue reading the feeds until noon."
    ));
    let a = [
        (1, "approve 1, 3".to_string()),
        (2, "skip\nthe rest".to_string()),
    ];
    let r = Routine {
        name: "newsroom".into(),
        cmd: "newsroom".into(),
        ..Routine::default()
    };
    assert_eq!(
        continue_prompt(&r, &a[..1]),
        "/newsroom continue: approve 1, 3"
    );
    assert_eq!(said(&a), "1. approve 1, 3; 2. skip the rest");
}

#[test]
fn a_routine_from_before_1_53_stays_live_with_its_file() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::checks::COLUMNS_1_58)
        .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute_batch(
        "INSERT INTO desks(id, name, root, created_at) VALUES(1, 'news', '/tmp/news', 1);
         INSERT INTO routines(desk_id, name, cmd, every, due_at, created_at) VALUES(1, 'newsroom', 'newsroom', 'every day 07:30', 9, 5);
         INSERT INTO routines(desk_id, name, cmd, every, due_at, suggested_by, created_at) VALUES(1, 'bench', 'bench', 'every day 07:30', 9, 'panel 2', 6);",
    )
    .unwrap();
    conn.execute_batch(DRAFT_COLUMNS_1_53).unwrap();
    conn.execute_batch(LATE_COLUMNS_1_54).unwrap();
    conn.execute_batch(TRIGGER_COLUMNS_1_63).unwrap();
    let a = get(&conn, 1).unwrap().unwrap();
    assert_eq!(
        (a.state(), a.started_at, a.file.as_str()),
        ("live", 5, ".claude/commands/newsroom.md")
    );
    assert_eq!(get(&conn, 2).unwrap().unwrap().state(), "offer");
}

#[test]
fn what_waits_for_the_reader_is_denied_in_the_runs_settings() {
    let waits =
        waits_ok("python3 -I newsroom/publish.py *\n\n  Bash(python3 newsroom/render.py *)  \n")
            .unwrap();
    let s = settings(&["Bash(git push *)"], &waits, None);
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
        ".claude/commands/tick.md",
        &Offer::default(),
        now,
    )
    .unwrap() else {
        panic!("added");
    };
    // A draft: the clock never takes it, whatever its hour.
    assert_eq!(r.state(), "draft");
    assert!(due(&c, now + 3 * 86_400).unwrap().is_empty());
    assert!(start(&c, r.id, "h", ".claude/commands/tick.md", now).unwrap());
    assert!(!start(&c, r.id, "h2", "", now).unwrap(), "started once");
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!(
        (r.state(), r.started_at, r.allowed_at, r.cmd_hash.as_str()),
        ("live", now, now, "h")
    );
    assert!(r.due_at > now && r.due_at <= now + 86_400);
    assert!(due(&c, r.due_at - 1).unwrap().is_empty());
    let found = due(&c, r.due_at + 5).unwrap();
    assert_eq!(found.len(), 1);
    // Rearmed before the start: the same tick never finds it twice.
    let late = fire(&c, &found[0], r.due_at + 5);
    assert_eq!(late, 0);
    assert!(due(&c, r.due_at + 6).unwrap().is_empty());
    // A daemon that slept through the hour says how late it ran.
    let r = get(&c, r.id).unwrap().unwrap();
    let late = fire(&c, &r, r.due_at + 13 * 3600);
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
        "",
        &Offer { by, pane: "p1" },
        now,
    )
    .unwrap()
    {
        Added::Routine(r) => r,
        other => panic!("{other:?}"),
    };
    let a = add1(&mut c, "a · every day 07:30", "");
    assert!(start(&c, a.id, "h", "", now).unwrap());
    let b = add1(&mut c, "b · every day 07:30", "panel 2");
    assert_eq!((b.suggested_by.as_str(), b.state()), ("panel 2", "offer"));
    assert!(
        b.cmd_hash.is_empty(),
        "an offer is not allowed until started"
    );
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
    // A draft or an offer has no hour to pass.
    assert_eq!(pass_closed(&c, later).unwrap(), 1);
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
    // The offer, saved, is the reader's draft: still silent until Start.
    let e = crate::due::every::every_times("every day 07:30").unwrap();
    let s = Save {
        name: "b".into(),
        times: Some(vec![times::Line {
            times: e,
            words: String::new(),
            gated: true,
        }]),
        waits: vec![],
        minutes: 25,
        five_hour: 80,
        hash: "h2".into(),
        file: "f".into(),
        ..Save::default()
    };
    assert!(save(&mut c, b.id, &s, now).unwrap());
    let saved = get(&c, b.id).unwrap().unwrap();
    assert_eq!((saved.state(), saved.cmd_hash.as_str()), ("draft", ""));
    assert_eq!(ids(&c), vec![a.id]);
    assert!(start(&c, b.id, "h2", "f", now).unwrap());
    assert_eq!(ids(&c), vec![a.id, b.id]);
    // A live routine's Save allows its file as it is.
    assert!(save(
        &mut c,
        b.id,
        &Save {
            hash: "h3".into(),
            ..s
        },
        now
    )
    .unwrap());
    assert_eq!(get(&c, b.id).unwrap().unwrap().cmd_hash, "h3");
}

#[test]
fn a_desk_keeps_a_handful() {
    let mut c = db();
    for i in 0..PER_DESK {
        let l = line(&format!("r{i} · every day 07:30"));
        assert!(matches!(
            add(&mut c, 1, &l, &[], "", &Offer::default(), 1).unwrap(),
            Added::Routine(_)
        ));
    }
    let l = line("one-more · every day 07:30");
    assert_eq!(
        add(&mut c, 1, &l, &[], "", &Offer::default(), 1).unwrap(),
        Added::Full
    );
    assert_eq!(
        add(&mut c, 9, &l, &[], "", &Offer::default(), 1).unwrap(),
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
        "",
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
    skipped(&c, r.id, "clock", "desk parked", 900).unwrap();
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!(r.runs, 1);
    assert_eq!(r.last_line, "Fetched 3 items; 2 wait for you.");
    assert_eq!(r.last_state, "skipped: desk parked");
    let runs = runs_of(&c, r.id, 10).unwrap();
    let states: Vec<&str> = runs.iter().map(|x| x.state.as_str()).collect();
    assert_eq!(states, vec!["skipped: desk parked", "ran · exit 0", "done"]);
    assert_eq!(last_why(&c, r.id).unwrap(), "clock");
    assert_eq!(week(&c, 0).unwrap(), (1, 0));
    began(&c, r.id, "clock", "/tick", SESSION, 1000).unwrap();
    assert_eq!(end_all(&c, 1001).unwrap(), 1);
    assert_eq!(
        get(&c, r.id).unwrap().unwrap().last_state,
        "ended: snyvi restarted"
    );
}

#[test]
fn a_clock_catch_up_says_how_late_and_its_sleep_on_its_line() {
    let mut c = db();
    let now = 1_800_000_000;
    let Added::Routine(r) = add(
        &mut c,
        1,
        &line("tick · every day 07:30"),
        &[],
        "",
        &Offer::default(),
        now,
    )
    .unwrap() else {
        panic!("added");
    };
    assert!(start(&c, r.id, "", "", now).unwrap());
    // A daemon that slept through the hour: the clock's run is late, on
    // the row and on its line in History.
    let r = get(&c, r.id).unwrap().unwrap();
    let at = r.due_at + 2 * 3600 + 600;
    assert_eq!(fire(&c, &r, at), 2 * 3600 + 600);
    began(&c, r.id, "clock", "/tick", SESSION, at).unwrap();
    // The machine slept forty minutes through it; nothing else is running.
    assert_eq!(slept(&c, 40 * 60).unwrap(), 1);
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!((r.late_s, r.slept_s), (2 * 3600 + 600, 40 * 60));
    ended(&c, r.id, "done", "", at + 50 * 60).unwrap();
    let run = &runs_of(&c, r.id, 1).unwrap()[0];
    assert_eq!((run.late_s, run.slept_s), (2 * 3600 + 600, 40 * 60));
    // An hour that could not run leaves the row on the last run's lateness.
    let r = get(&c, r.id).unwrap().unwrap();
    fire(&c, &r, r.due_at + 5 * 3600);
    skipped(&c, r.id, "clock", "desk parked", at + 2 * 86_400).unwrap();
    assert_eq!(get(&c, r.id).unwrap().unwrap().late_s, 2 * 3600 + 600);
    // Run now is on time, and its sleep starts at nothing.
    began(&c, r.id, "you", "/tick", SESSION, at + 3 * 86_400).unwrap();
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!((r.late_s, r.slept_s), (0, 0));
    assert_eq!(runs_of(&c, r.id, 1).unwrap()[0].late_s, 0);
    // Not running: a sleep counts against nothing.
    ended(&c, r.id, "done", "", at + 3 * 86_400 + 60).unwrap();
    assert_eq!(slept(&c, 600).unwrap(), 0);
    assert_eq!(runs_of(&c, r.id, 1).unwrap()[0].slept_s, 0);
}

fn draft(c: &mut Connection, text: &str, now: i64) -> Routine {
    match add(c, 1, &line(text), &[], "", &Offer::default(), now).unwrap() {
        Added::Routine(r) => *r,
        other => panic!("{other:?}"),
    }
}

fn when(text: &str, words: &str, gated: bool) -> times::Line {
    times::Line {
        times: crate::due::every::every_times(text).unwrap(),
        words: words.into(),
        gated,
    }
}

/// 1.63 (R4): a draft may have no when, and is never due; the routine's
/// `due_at` is the soonest of its times after every write, 0 with none.
#[test]
fn a_routines_soonest_is_its_times_and_a_draft_with_none_never_rings() {
    let mut c = db();
    let now = 1_800_000_000;
    let r = draft(&mut c, "/tick", now);
    assert_eq!((r.due_at, r.every.as_str()), (0, ""));
    assert!(!has_when(&c, &r).unwrap(), "Start needs a when (C3)");
    assert!(start(&c, r.id, "", "", now).unwrap());
    assert!(
        due(&c, now + 30 * 86_400).unwrap().is_empty(),
        "no time, never due"
    );
    let lines = [
        when("every day 09:30 13:00", "", true),
        when("every mon 09:30", "case", false),
    ];
    assert!(times::set(&c, r.id, &lines, now).unwrap().is_some());
    let t = times::times_of(&c, r.id).unwrap();
    assert_eq!(t.len(), 3, "one row an hour");
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!(r.due_at, t.iter().map(|t| t.due_at).min().unwrap());
    assert_eq!(r.every, "every day 09:30 13:00 +1");
    let said = times::lines(&t);
    assert_eq!(said.len(), 2, "the sheet's two lines again");
    assert_eq!(
        (
            said[1].every.as_str(),
            said[1].words.as_str(),
            said[1].gated
        ),
        ("every mon 09:30", "case", false)
    );
    assert!(
        times::set(
            &c,
            r.id,
            &[
                when("every day 1 2 3 4", "", true),
                when("every day 5 6 7", "", true)
            ],
            now
        )
        .unwrap()
        .is_none(),
        "six at most"
    );
    times::set(&c, r.id, &[], now).unwrap();
    assert_eq!(get(&c, r.id).unwrap().unwrap().due_at, 0);
    // A watch is a when of its own.
    c.execute(
        "UPDATE routines SET watch = 'watch.sh' WHERE id = ?1",
        [r.id],
    )
    .unwrap();
    assert!(has_when(&c, &get(&c, r.id).unwrap().unwrap()).unwrap());
}

/// 1.63 (R3): a Monday slept through runs `case` once and the plain run
/// once, in two looks; nothing queues, and each set re-arms only itself.
#[test]
fn times_past_due_ring_one_set_of_words_a_look() {
    let mut c = db();
    let now = 1_800_000_000;
    let r = draft(&mut c, "/tick", now);
    let lines = [
        when("every day 09:30", "", true),
        when("every mon 09:30", "case", false),
    ];
    times::set(&c, r.id, &lines, now).unwrap();
    assert!(start(&c, r.id, "", "", now).unwrap());
    // Both hours came while the machine slept.
    let past = now + 100;
    c.execute("UPDATE routine_times SET due_at = ?1", [past])
        .unwrap();
    times::sync(&c, r.id).unwrap();
    let at = past + 3 * 3600;
    let r = due(&c, at).unwrap().remove(0);
    let f = times::fired(&c, r.id, at).unwrap().unwrap();
    assert_eq!((f.words.as_str(), f.gated, f.ids.len()), ("", true, 1));
    assert_eq!(rearm(&c, &r, &f, at).unwrap(), 3 * 3600, "late, said");
    // The second look takes the other.
    let r = due(&c, at + 30).unwrap().remove(0);
    let f = times::fired(&c, r.id, at + 30).unwrap().unwrap();
    assert_eq!((f.words.as_str(), f.gated), ("case", false));
    rearm(&c, &r, &f, at + 30).unwrap();
    assert!(due(&c, at + 60).unwrap().is_empty());
    assert!(get(&c, r.id).unwrap().unwrap().due_at > at + 60);
    // A run under way is passed over, not re-armed: its hour waits for it.
    c.execute("UPDATE routine_times SET due_at = ?1", [past])
        .unwrap();
    times::sync(&c, r.id).unwrap();
    began(&c, r.id, "clock", "/tick", SESSION, at).unwrap();
    assert!(due(&c, at + 90).unwrap().is_empty());
    ended(&c, r.id, "done", "", at + 120).unwrap();
    assert_eq!(due(&c, at + 150).unwrap().len(), 1);
}

#[test]
fn a_prompt_gets_a_times_words_and_its_ids_and_nothing_else() {
    let r = Routine {
        name: "pro-forum".into(),
        cmd: "pro-forum".into(),
        ..Routine::default()
    };
    assert_eq!(r.prompt_with("", &[]), "/pro-forum");
    assert_eq!(r.prompt_with("case", &[]), "/pro-forum case");
    assert_eq!(
        r.prompt_with("", &["tag 5304".into(), "tag 5311".into()]),
        "/pro-forum tag 5304 ; tag 5311"
    );
}

/// 1.63: a watch's lines are kept in its shape, once each, two hundred at
/// most, batched a minute, six event runs an hour, taken whole at a start.
#[test]
fn a_watchs_lines_wait_batch_and_are_taken_once() {
    let mut c = db();
    let now = 1_800_000_000;
    let r = draft(&mut c, "/tick", now);
    let shape = "tag <number>";
    assert_eq!(
        events::push(&c, r.id, shape, "tag 1", now).unwrap(),
        events::Pushed::Kept
    );
    assert_eq!(
        events::push(&c, r.id, shape, " tag   1 ", now).unwrap(),
        events::Pushed::Same
    );
    assert_eq!(
        events::push(&c, r.id, shape, "tag 2; rm -rf ~", now).unwrap(),
        events::Pushed::Dropped
    );
    assert_eq!(
        events::push(&c, r.id, shape, "tag 2", now + 10).unwrap(),
        events::Pushed::Kept
    );
    assert_eq!(
        get(&c, r.id).unwrap().unwrap().dropped,
        1,
        "dropped, counted, never trimmed"
    );
    assert!(
        !events::ready(&c, r.id, now + 59).unwrap(),
        "the batch waits a minute"
    );
    assert!(events::ready(&c, r.id, now + 60).unwrap());
    assert_eq!(events::take(&c, r.id).unwrap(), ["tag 1", "tag 2"]);
    let run = began(&c, r.id, "event", "/tick tag 1 ; tag 2", SESSION, now + 61).unwrap();
    events::bind(&c, r.id, run).unwrap();
    assert_eq!(events::waiting(&c, r.id).unwrap(), 0);
    assert!(
        events::take(&c, r.id).unwrap().is_empty(),
        "used, not put back"
    );
    ended(&c, r.id, "done", "", now + 70).unwrap();
    // Six event runs an hour, then the lines wait for the next.
    for i in 0..5 {
        began(&c, r.id, "event", "x", SESSION, now + 100 + i).unwrap();
        ended(&c, r.id, "done", "", now + 100 + i).unwrap();
    }
    events::push(&c, r.id, shape, "tag 3", now + 200).unwrap();
    assert!(
        !events::ready(&c, r.id, now + 300).unwrap(),
        "six this hour"
    );
    assert!(events::ready(&c, r.id, now + 3700).unwrap());
    // Two hundred wait at most.
    for i in 0..events::CAP {
        events::push(&c, r.id, shape, &format!("tag {}", 1000 + i), now).unwrap();
    }
    assert_eq!(events::waiting(&c, r.id).unwrap(), events::CAP);
    assert_eq!(
        events::last(&c, r.id).unwrap(),
        format!("tag {}", 1000 + events::CAP - 2)
    );
}

/// 1.63 (R10): a quiet run is no session -- not counted in the week, not
/// the row's lateness, not the last why -- and a day's quiet runs are one
/// line in History.
#[test]
fn quiet_runs_are_one_line_a_day_and_count_as_no_session() {
    let mut c = db();
    let now = 1_800_000_000;
    let r = draft(&mut c, "/tick", now);
    began(&c, r.id, "clock", "/tick", SESSION, now).unwrap();
    ended(&c, r.id, "done", "", now + 60).unwrap();
    for i in 1..=4 {
        quiet(&c, r.id, "at its hour (13:00)", now + i * 600).unwrap();
    }
    gate_failed(&c, r.id, "exit 2", "", now + 3000).unwrap();
    let runs = runs_of(&c, r.id, 30).unwrap();
    let states: Vec<(&str, i64)> = runs.iter().map(|r| (r.state.as_str(), r.more)).collect();
    assert_eq!(
        states,
        [("gate failed: exit 2", 0), ("quiet", 3), ("done", 0)]
    );
    assert_eq!(runs[1].woke, "at its hour (13:00)");
    assert_eq!(week(&c, 0).unwrap().0, 1, "one session ran");
    assert_eq!(last_why(&c, r.id).unwrap(), "clock");
    assert_eq!(
        last_states(&c, r.id, 2).unwrap(),
        ["gate failed: exit 2", "quiet"]
    );
    let r = get(&c, r.id).unwrap().unwrap();
    assert_eq!(r.last_state, "gate failed: exit 2");
}

/// 1.63 (R6): a routine's scripts folder is allowed with its command; a
/// changed `watch.sh` reads as changed, and one with no folder keeps the
/// hash it always had.
#[test]
fn a_changed_script_in_the_routines_folder_reads_as_changed() {
    let dir = crate::store::tempdir::Dir::new("snyvi-routine-scripts");
    let cmds = dir.path.join(".claude").join("commands");
    std::fs::create_dir_all(&cmds).unwrap();
    std::fs::write(cmds.join(format!("{NEWS}.md")), "Answer the tags.").unwrap();
    let Made::File(p, before) = resolve(&dir.path, &line(&format!("/{NEWS}"))) else {
        panic!("a file");
    };
    assert_eq!(
        Some(before.clone()),
        places::hash(&p),
        "no folder: the old hash"
    );
    let scripts = dir.path.join(".claude").join("routines").join(NEWS);
    std::fs::create_dir_all(&scripts).unwrap();
    std::fs::write(scripts.join("watch.sh"), "omdbot watch\n").unwrap();
    let Made::File(_, with) = resolve(&dir.path, &line(&format!("/{NEWS}"))) else {
        panic!("a file");
    };
    assert_ne!(with, before);
    let r = Routine {
        name: NEWS.into(),
        cmd: NEWS.into(),
        cmd_hash: with,
        file: p.file.clone(),
        ..Routine::default()
    };
    assert_eq!(file_state(&dir.path, &r), "ok");
    // What a script remembers is not what the reader allowed: a gate that
    // notes its day in `state/` does not stop its own routine.
    let state = scripts.join(places::STATE);
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("last"), "tag 5304").unwrap();
    assert_eq!(
        file_state(&dir.path, &r),
        "ok",
        "state/ is not allowed text"
    );
    assert!(!places::scripts_text(&p, NEWS).contains("tag 5304"));
    std::fs::write(scripts.join("watch.sh"), "omdbot watch --all\n").unwrap();
    assert_eq!(file_state(&dir.path, &r), "changed");
    assert_eq!(
        places::scripts_said(&p, NEWS),
        format!(".claude/routines/{NEWS}/")
    );
    assert!(places::scripts_text(&p, NEWS).contains("omdbot watch --all"));
}

/// 1.63 (step 5): an agent's offer carries its times, gate, watch, shape,
/// model and effort onto the offer row, and nothing of it rings; the same
/// call on a draft or a live routine changes nothing, so a token can never
/// set what the reader allowed.
#[test]
fn an_offer_carries_its_triggers_and_only_an_offer_takes_them() {
    let mut c = db();
    let now = 1_800_000_000;
    let t = Triggers {
        gate: "gate.sh".into(),
        watch: "watch.sh".into(),
        shape: "tag <number>".into(),
        model: "sonnet".into(),
        effort: "low".into(),
    };
    let offer = match add(
        &mut c,
        1,
        &line("pro-forum"),
        &[],
        "",
        &Offer {
            by: "panel 2",
            pane: "p1",
        },
        now,
    )
    .unwrap()
    {
        Added::Routine(r) => *r,
        other => panic!("{other:?}"),
    };
    let lines = [
        when("every day 09:30", "", true),
        when("every mon 09:30", "case", false),
    ];
    assert!(offered(&mut c, offer.id, &lines, &t, now).unwrap());
    let o = get(&c, offer.id).unwrap().unwrap();
    assert_eq!(
        (
            o.state(),
            o.gate.as_str(),
            o.watch.as_str(),
            o.shape.as_str(),
            o.model.as_str(),
            o.effort.as_str()
        ),
        (
            "offer",
            "gate.sh",
            "watch.sh",
            "tag <number>",
            "sonnet",
            "low"
        )
    );
    assert_eq!(times::times_of(&c, o.id).unwrap().len(), 2);
    assert!(
        due(&c, now + 30 * 86_400)
            .unwrap()
            .iter()
            .all(|r| r.id != o.id),
        "an offer never rings"
    );
    let d = draft(&mut c, "standup", now);
    assert!(!offered(&mut c, d.id, &lines, &t, now).unwrap());
    let live = draft(&mut c, "news · every day 07:30", now);
    assert!(start(&c, live.id, "h", "", now).unwrap());
    assert!(!offered(&mut c, live.id, &lines, &t, now).unwrap());
    for id in [d.id, live.id] {
        let r = get(&c, id).unwrap().unwrap();
        assert!(
            r.gate.is_empty() && r.watch.is_empty() && r.shape.is_empty() && r.model.is_empty(),
            "{}",
            r.name
        );
    }
    assert_eq!(
        times::times_of(&c, live.id).unwrap().len(),
        1,
        "a live routine keeps its time"
    );
}
