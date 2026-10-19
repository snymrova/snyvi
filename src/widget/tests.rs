use super::*;

/// A database as 1.31 left it, before a widget had an owner.
fn db_1_31() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in PREFS_COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(TITLE_COLUMN_1_31).unwrap();
    conn
}

fn db() -> Connection {
    let conn = db_1_31();
    for c in OWNER_1_32 {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(PROPOSED_BY_1_46).unwrap();
    conn
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn body(md: &str) -> Body {
    match Body::parse(md).unwrap() {
        Sent::Body(b) => b,
        Sent::Clear => panic!("cleared"),
    }
}

const PUSH: Writer<'static> = Writer {
    source: Source::Push,
    writer: "panel 2",
    pane: "p2",
    title: "",
    owner: 0,
};
const FILE: Writer<'static> = Writer {
    source: Source::File,
    writer: "every 2 min",
    pane: "",
    title: "Git",
    owner: 0,
};

#[test]
fn the_default_is_todays_order() {
    let l = Layout::default().normalize();
    assert_eq!(l.left, ids(&LEFT));
    assert_eq!(l.right, ids(&RIGHT));
    assert!(l.hidden.is_empty());
}

#[test]
fn normalize_keeps_the_readers_order_and_mends_the_rest() {
    let l = Layout {
        left: ids(&["folders", "nope", "inbox", "inbox"]),
        right: ids(&["notes", "turn", "docs"]),
        hidden: ids(&[
            "folders",
            "turn",
            "widgets",
            "left:widgets",
            "bogus",
            "folders",
        ]),
    }
    .normalize();
    // Unknown and repeated ids go; the missing ones come back after the
    // section they follow by default (widgets after folders, desks after
    // inbox).
    assert_eq!(l.left, ids(&["folders", "widgets", "inbox", "desks"]));
    // Your turn left the rail in 1.32: a stored `turn` is dropped wherever
    // it was; notes stays before docs as the reader had it, and the missing
    // ones come back after the section they follow by default.
    assert_eq!(
        l.right,
        ids(&["panels", "points", "notes", "widgets", "docs"])
    );
    // A hidden `turn` goes with it; a bare `widgets` names no side.
    assert_eq!(l.hidden, ids(&["folders", "left:widgets"]));
}

#[test]
fn a_section_from_a_later_version_lands_in_its_place() {
    // A layout saved before `points` existed, naming `rest`, which went in
    // 1.30 (#109), and `turn`, which left the rail in 1.32: the one arrives
    // in its place, the others are dropped.
    let l = Layout {
        left: ids(&LEFT),
        right: ids(&["turn", "docs", "panels", "rest", "notes", "widgets"]),
        hidden: vec![],
    }
    .normalize();
    assert_eq!(
        l.right,
        ids(&["docs", "panels", "points", "notes", "widgets"])
    );
}

#[test]
fn layout_round_trips_and_a_bad_row_reads_as_the_default() {
    let c = db();
    assert_eq!(layout(&c).unwrap(), Layout::default());
    let l = Layout {
        left: ids(&["desks", "inbox", "folders", "widgets"]),
        hidden: ids(&["folders"]),
        ..Layout::default()
    };
    let kept = set_layout(&c, &l, 1).unwrap();
    assert_eq!(layout(&c).unwrap(), kept);
    assert_eq!(kept.left[0], "desks");
    c.execute("UPDATE ui_layout SET json = 'not json'", [])
        .unwrap();
    assert_eq!(layout(&c).unwrap(), Layout::default());
}

#[test]
fn names() {
    let (n32, n33) = ("x".repeat(32), "x".repeat(33));
    for ok in ["git", "ci-2", "a", n32.as_str()] {
        assert!(name_ok(ok), "{ok}");
    }
    for bad in [
        "",
        "-git",
        "Git",
        "git_x",
        "git/x",
        "../x",
        "g it",
        n33.as_str(),
    ] {
        assert!(!name_ok(bad), "{bad}");
    }
}

#[test]
fn a_body_is_markdown_or_one_json_object() {
    let b = body("**main** · 2 ahead");
    assert_eq!(b.md, "**main** · 2 ahead");
    assert_eq!(
        (b.tone, b.lines, b.stale_after),
        (Tone::None, LINES_DEFAULT, STALE_DEFAULT)
    );

    let b = body(r#"{"body":"3/5 green","tone":"warn","count":3,"lines":9,"stale_after":-4}"#);
    assert_eq!(b.md, "3/5 green");
    assert_eq!(b.tone, Tone::Warn);
    assert_eq!(b.count, "3");
    assert_eq!(b.lines, LINES_MAX);
    assert_eq!(b.stale_after, 0);

    // Braces that are not the contract are Markdown.
    assert_eq!(body("{not json} and more").md, "{not json} and more");
}

#[test]
fn nothing_clears() {
    assert_eq!(Body::parse("  \n").unwrap(), Sent::Clear);
    assert_eq!(Body::parse(r#"{"body":"  "}"#).unwrap(), Sent::Clear);
    assert_eq!(Body::parse(r#"{"tone":"ok"}"#).unwrap(), Sent::Clear);
    // Not a widget's JSON: said, not cleared, not drawn as braces.
    assert!(Body::parse(r#"{"status":"ok"}"#)
        .unwrap_err()
        .contains("no \"body\""));
    assert!(Body::parse(r#"{"body":5}"#)
        .unwrap_err()
        .contains("Markdown text"));
}

#[test]
fn refusals_say_why() {
    assert!(Body::parse(&"x".repeat(BODY_MAX + 1))
        .unwrap_err()
        .contains("longer than"));
    assert!(Body::parse(r#"{"body":"x","tone":"purple"}"#)
        .unwrap_err()
        .contains("tone"));
    assert!(Body::parse(r#"{"body":"x","count":"123456789"}"#)
        .unwrap_err()
        .contains("count"));
    assert!(Body::parse(r#"{"body":"x","count":[1]}"#)
        .unwrap_err()
        .contains("count"));
}

#[test]
fn put_keeps_the_place_and_the_caps() {
    let c = db();
    for i in 0..DESK_MAX {
        assert_eq!(
            put(&c, 3, &format!("w{i}"), &body("x"), "<p>x</p>", &PUSH, 1).unwrap(),
            Put::Done
        );
    }
    assert_eq!(
        put(&c, 3, "one-more", &body("x"), "", &PUSH, 1).unwrap(),
        Put::Full
    );
    // Rewriting one that is there is not a new one, and keeps its place.
    assert_eq!(
        put(&c, 3, "w0", &body("y"), "<p>y</p>", &PUSH, 2).unwrap(),
        Put::Done
    );
    let s = seats(&c, 3).unwrap();
    assert_eq!(s.len(), DESK_MAX);
    assert_eq!((s[0].name.as_str(), s[0].html.as_str()), ("w0", "<p>y</p>"));
    // Global widgets have their own cap.
    for i in 0..GLOBAL_MAX {
        assert_eq!(
            put(&c, 0, &format!("g{i}"), &body("x"), "", &FILE, 1).unwrap(),
            Put::Done
        );
    }
    assert_eq!(
        put(&c, 0, "g-more", &body("x"), "", &FILE, 1).unwrap(),
        Put::Full
    );
}

#[test]
fn a_widget_files_name_is_its_own() {
    let c = db();
    assert_eq!(
        put(&c, 3, "git", &body("x"), "", &FILE, 1).unwrap(),
        Put::Done
    );
    assert_eq!(
        put(&c, 3, "git", &body("y"), "", &PUSH, 2).unwrap(),
        Put::Owned
    );
    assert!(!clear(&c, 3, "git", Source::Push).unwrap());
    assert!(clear(&c, 3, "git", Source::File).unwrap());
}

#[test]
fn a_failed_run_keeps_the_last_good_body() {
    let c = db();
    put(&c, 3, "git", &body("ok"), "<p>ok</p>", &FILE, 1).unwrap();
    fail(&c, 3, "git", "exit 1: not a git repository", 3, &FILE, 2).unwrap();
    let s = seat_of(&c, 3, "git").unwrap().unwrap();
    assert_eq!(
        (s.html.as_str(), s.error.as_str()),
        ("<p>ok</p>", "exit 1: not a git repository")
    );
    // The next good run clears the line.
    put(&c, 3, "git", &body("ok"), "<p>ok</p>", &FILE, 3).unwrap();
    assert_eq!(seat_of(&c, 3, "git").unwrap().unwrap().error, "");
    // A pushed seat is not a file's to fail.
    put(&c, 3, "deploy", &body("x"), "", &PUSH, 1).unwrap();
    assert!(!fail(&c, 3, "deploy", "nope", 3, &FILE, 2).unwrap());
    assert_eq!(seat_of(&c, 3, "deploy").unwrap().unwrap().error, "");
    // A line before any body takes the file's own room, so the first body
    // moves nothing (1.46); and no seat past the desk's cap.
    assert!(fail(&c, 3, "six", "allow: Six wants to run", 6, &FILE, 2).unwrap());
    assert_eq!(seat_of(&c, 3, "six").unwrap().unwrap().lines, 6);
    for n in 0..DESK_MAX {
        let _ = put(&c, 9, &format!("w{n}"), &body("x"), "", &PUSH, 1).unwrap();
    }
    assert!(!fail(&c, 9, "late", "allow: Late wants to run", 3, &FILE, 2).unwrap());
    assert!(seat_of(&c, 9, "late").unwrap().is_none());
}

#[test]
fn a_file_seat_has_its_title_and_how_often_it_runs() {
    let c = db();
    fail(&c, 3, "git", "exit 1", 3, &FILE, 1).unwrap();
    let s = seat_of(&c, 3, "git").unwrap().unwrap();
    assert_eq!(
        (s.title.as_str(), s.writer.as_str()),
        ("Git", "every 2 min")
    );
    // A seat failed before this release said its command's first word: the
    // next line says how often instead.
    c.execute("UPDATE widget_bodies SET writer = 'sh', title = ''", [])
        .unwrap();
    fail(&c, 3, "git", "exit 2", 3, &FILE, 2).unwrap();
    let s = seat_of(&c, 3, "git").unwrap().unwrap();
    assert_eq!(
        (s.title.as_str(), s.writer.as_str()),
        ("Git", "every 2 min")
    );
    put(&c, 3, "deploy", &body("x"), "", &PUSH, 1).unwrap();
    assert_eq!(seat_of(&c, 3, "deploy").unwrap().unwrap().title, "");
}

#[test]
fn a_long_reason_is_cut_where_it_says_so() {
    let c = db();
    let long = "x".repeat(ERROR_MAX + 50);
    fail(&c, 3, "git", &long, 3, &FILE, 1).unwrap();
    let e = seat_of(&c, 3, "git").unwrap().unwrap().error;
    assert_eq!(e.chars().count(), ERROR_MAX);
    assert!(e.ends_with('…'));
    let short = "y".repeat(ERROR_MAX);
    fail(&c, 3, "git", &short, 3, &FILE, 2).unwrap();
    assert_eq!(seat_of(&c, 3, "git").unwrap().unwrap().error, short);
}

#[test]
fn how_often_reads_as_a_person_says_it() {
    assert_eq!(every_words(30), "every 30 s");
    assert_eq!(every_words(120), "every 2 min");
    assert_eq!(every_words(90), "every 1 min 30 s");
    assert_eq!(every_words(3600), "every hour");
    assert_eq!(every_words(7200), "every 2 h");
    assert_eq!(every_words(5400), "every 90 min");
}

#[test]
fn a_panes_seats_dim_when_it_ends() {
    let c = db();
    put(&c, 3, "deploy", &body("3/5"), "", &PUSH, 1).unwrap();
    assert_eq!(of_pane(&c, "p2").unwrap(), vec![(3, "deploy".to_string())]);
    assert_eq!(pane_ended(&c, "p2", "panel 2 ended").unwrap(), 1);
    let s = seat_of(&c, 3, "deploy").unwrap().unwrap();
    assert_eq!(
        (s.writer.as_str(), s.stale_after, s.pane.as_str()),
        ("panel 2 ended", 1, "")
    );
}

#[test]
fn prefs_change_only_what_is_given() {
    let c = db();
    assert_eq!(prefs(&c, 0, "git").unwrap().settings, "{}");
    let first = Change {
        hidden: Some(true),
        trusted_hash: Some("abc"),
        ..Change::default()
    };
    set_prefs(&c, 0, "git", &first, 1).unwrap();
    let then = Change {
        settings: Some(r#"{"base":"dev"}"#),
        rerun_edits: Some(true),
        ..Change::default()
    };
    let p = set_prefs(&c, 0, "git", &then, 2).unwrap();
    assert!(p.hidden && p.rerun_edits);
    assert_eq!(
        (p.trusted_hash.as_str(), p.settings.as_str()),
        ("abc", r#"{"base":"dev"}"#)
    );
    // Hidden reaches the seat.
    put(&c, 0, "git", &body("x"), "", &FILE, 1).unwrap();
    assert!(seats(&c, 0).unwrap()[0].hidden);
}

#[test]
fn a_widget_lives_on_the_desks_and_for_the_time_the_reader_chose() {
    let c = db();
    let p = prefs(&c, 0, "ci").unwrap();
    assert!(p.on_desk(1) && p.on_desk(2), "no desks is every desk");
    let ch = Change {
        desks: Some(&[2]),
        until: Some(100),
        ..Change::default()
    };
    let p = set_prefs(&c, 0, "ci", &ch, 1).unwrap();
    assert!(!p.on_desk(1) && p.on_desk(2));
    assert!(!p.ended(99, |_| true) && p.ended(100, |_| true));
    // What its runs printed on a desk it left goes; the desk it is on keeps it.
    put(&c, 1, "ci", &body("x"), "", &FILE, 1).unwrap();
    put(&c, 2, "ci", &body("y"), "", &FILE, 1).unwrap();
    assert_eq!(off_desks(&c, "ci", &p.desks).unwrap(), vec![1]);
    assert!(seat_of(&c, 1, "ci").unwrap().is_none() && seat_of(&c, 2, "ci").unwrap().is_some());
    // A panel's life.
    let ch = Change {
        until: Some(0),
        until_pane: Some("p1"),
        ..Change::default()
    };
    let p = set_prefs(&c, 0, "ci", &ch, 2).unwrap();
    assert!(!p.ended(5, |x| x == "p1") && p.ended(5, |_| false));
}

#[test]
fn a_stopped_widget_runs_again_on_try_again() {
    let c = db();
    fail(
        &c,
        3,
        "ci",
        &format!("{STOPPED}after 3 failures, exit 2"),
        3,
        &FILE,
        1,
    )
    .unwrap();
    fail(&c, 4, "ci", "exit 2", 3, &FILE, 1).unwrap();
    assert_eq!(unstop(&c, 0, "ci", None).unwrap(), vec![3]);
    assert_eq!(seat_of(&c, 3, "ci").unwrap().unwrap().error, "");
    assert_eq!(seat_of(&c, 4, "ci").unwrap().unwrap().error, "exit 2");
}

#[test]
fn a_box_waits_for_yes_and_ends_with_its_time() {
    let c = db();
    assert!(ask_of(&c, 1, "deploy").unwrap().is_none());
    ask_wait(&c, 1, "deploy", "p1", "panel 1", "**3/5**", 1).unwrap();
    let a = ask_of(&c, 1, "deploy").unwrap().unwrap();
    assert_eq!((a.answer.as_str(), a.body.as_str()), ("", "**3/5**"));
    ask_answer(&c, 1, "deploy", "yes", 50, "", 2).unwrap();
    assert!(asks_ending(&c, 49, |_| true).unwrap().is_empty());
    assert_eq!(
        asks_ending(&c, 50, |_| true).unwrap(),
        vec![(1, "deploy".to_string())]
    );
    assert_eq!(ask_of(&c, 1, "deploy").unwrap().unwrap().answer, "ended");
    // A box a script pushed is the reader's: no panel is handed it (1.46),
    // and whoever would take the name is told who holds it.
    let script = Writer {
        pane: "",
        writer: "a script",
        ..PUSH
    };
    put(&c, 1, "tests", &body("ok"), "", &script, 1).unwrap();
    assert!(ask_of(&c, 1, "tests").unwrap().is_none());
    assert_eq!(name_held(&c, 1, "tests").unwrap(), Some(Held::Box));
    assert_eq!(
        name_held(&c, 1, "deploy").unwrap(),
        Some(Held::Asked("ended".into()))
    );
    assert_eq!(name_held(&c, 1, "nothing").unwrap(), None);
    // A widget file does not take a box's seat over it.
    assert_eq!(
        put(&c, 1, "tests", &body("x"), "", &FILE, 2).unwrap(),
        Put::Box
    );
    // A box the reader removed stays removed to a new panel's push: the
    // body waits behind its card, the no holds.
    ask_wait(&c, 1, "gone", "p1", "panel 1", "old", 1).unwrap();
    ask_answer(&c, 1, "gone", "removed", 0, "", 2).unwrap();
    ask_wait(&c, 1, "gone", "p9", "panel 9", "new", 3).unwrap();
    let a = ask_of(&c, 1, "gone").unwrap().unwrap();
    assert_eq!(
        (a.answer.as_str(), a.pane.as_str(), a.body.as_str()),
        ("removed", "p1", "new")
    );
}

const OWN: Writer<'static> = Writer {
    source: Source::File,
    writer: "every 2 min",
    pane: "",
    title: "Arena",
    owner: 7,
};

#[test]
fn a_desks_own_widget_is_on_its_desk_alone() {
    let c = db();
    // Two desks may each own a widget of one name; each has its own say.
    let off = Change {
        hidden: Some(true),
        ..Change::default()
    };
    set_prefs(&c, 7, "arena", &off, 1).unwrap();
    let p = prefs(&c, 8, "arena").unwrap();
    assert!(!p.hidden && p.owner == 8);
    let p = prefs(&c, 7, "arena").unwrap();
    assert!(p.hidden);
    // Its desks are not its own to widen: none is still its desk alone.
    assert!(p.on_desk(7) && !p.on_desk(8));
    // Its seat says whose it is, and is hidden by its owner's say only.
    put(&c, 7, "arena", &body("2 runs"), "", &OWN, 1).unwrap();
    let s = seat_of(&c, 7, "arena").unwrap().unwrap();
    assert!(s.owner == 7 && s.hidden);
    assert_eq!(desks_of(&c, 7, "arena").unwrap(), vec![7]);
    assert!(desks_of(&c, 0, "arena").unwrap().is_empty());
    // Try again on it touches no other desk's seat of the name.
    fail(
        &c,
        7,
        "arena",
        &format!("{STOPPED}after 3 failures, exit 1"),
        3,
        &OWN,
        2,
    )
    .unwrap();
    assert!(unstop(&c, 0, "arena", None).unwrap().is_empty());
    assert_eq!(unstop(&c, 7, "arena", None).unwrap(), vec![7]);
}

#[test]
fn sharing_keeps_the_readers_say_and_runs_nowhere_new() {
    let c = db();
    let allowed = Change {
        trusted_hash: Some("h1"),
        settings: Some(r#"{"x":1}"#),
        until: Some(500),
        ..Change::default()
    };
    set_prefs(&c, 7, "arena", &allowed, 1).unwrap();
    put(&c, 7, "arena", &body("ok"), "", &OWN, 1).unwrap();
    // Shared: on the desk it came from, and no other, until ticked.
    assert_eq!(rehome(&c, "arena", 7, 0, 2).unwrap(), vec![7]);
    let p = prefs(&c, 0, "arena").unwrap();
    assert_eq!(
        (
            p.trusted_hash.as_str(),
            p.settings.as_str(),
            p.until,
            p.desks.clone()
        ),
        ("h1", r#"{"x":1}"#, 500, vec![7])
    );
    assert!(p.on_desk(7) && !p.on_desk(8));
    assert_eq!(
        prefs(&c, 7, "arena").unwrap().trusted_hash,
        "",
        "the old row is gone"
    );
    assert_eq!(seat_of(&c, 7, "arena").unwrap().unwrap().owner, 0);
    // Kept to desk 8: its seats on other desks go, its say goes with it.
    put(&c, 8, "arena", &body("ok"), "", &FILE, 3).unwrap();
    let mut was = rehome(&c, "arena", 0, 8, 4).unwrap();
    was.sort_unstable();
    assert_eq!(was, vec![7, 8]);
    assert!(seat_of(&c, 7, "arena").unwrap().is_none());
    assert_eq!(seat_of(&c, 8, "arena").unwrap().unwrap().owner, 8);
    let p = prefs(&c, 8, "arena").unwrap();
    assert!(p.trusted_hash == "h1" && p.desks.is_empty() && p.on_desk(8) && !p.on_desk(7));
}

#[test]
fn a_widget_on_one_desk_is_marked_to_be_that_desks() {
    let c = db_1_31();
    for (name, desks) in [("arena", "7"), ("git", ""), ("ci", "3,4"), ("odd", "x")] {
        c.execute(
            "INSERT INTO widget_prefs (name, trusted_hash, desks, updated_at) VALUES (?1, 'h', ?2, 1)",
            params![name, desks],
        )
        .unwrap();
    }
    for s in OWNER_1_32 {
        c.execute_batch(s).unwrap();
    }
    c.execute_batch(PROPOSED_BY_1_46).unwrap();
    // What it printed as a shared widget, on its one desk.
    put(
        &c,
        7,
        "arena",
        &body("ok"),
        "",
        &Writer { owner: 0, ..OWN },
        1,
    )
    .unwrap();
    assert_eq!(to_adopt(&c).unwrap(), vec![("arena".to_string(), 7)]);
    for name in ["git", "ci", "odd"] {
        assert_eq!(
            prefs(&c, 0, name).unwrap().trusted_hash,
            "h",
            "{name} stays shared"
        );
    }
    // Moved: its desk's own, allowed as it was.
    adopted(&c, "arena", 7).unwrap();
    assert!(to_adopt(&c).unwrap().is_empty());
    let p = prefs(&c, 7, "arena").unwrap();
    assert!(p.trusted_hash == "h" && p.desks.is_empty());
    assert_eq!(seat_of(&c, 7, "arena").unwrap().unwrap().owner, 7);
    // Or it could not move, and is shared as before, on its one desk.
    c.execute("UPDATE widget_prefs SET owner = -3 WHERE name = 'git'", [])
        .unwrap();
    stays_shared(&c, "git", 3).unwrap();
    assert_eq!(prefs(&c, 0, "git").unwrap().trusted_hash, "h");
}

#[test]
fn only_an_agents_widget_says_it_is_one() {
    let c = db();
    put(&c, 7, "deploy", &body("3/5"), "", &PUSH, 1).unwrap();
    put(&c, 7, "arena", &body("ok"), "", &OWN, 1).unwrap();
    put(&c, 7, "git", &body("main"), "", &FILE, 1).unwrap();
    let script = Writer {
        pane: "",
        writer: "a script",
        ..PUSH
    };
    put(&c, 7, "backup", &body("done"), "", &script, 1).unwrap();
    let agent = |n: &str| seat_of(&c, 7, n).unwrap().unwrap().agent;
    assert!(agent("deploy") && agent("arena"));
    assert!(
        !agent("git") && !agent("backup"),
        "a shared file and a script's box are the reader's"
    );
    // Its panel closed, a box it asked for is still an agent's.
    ask_wait(&c, 7, "deploy", "p2", "panel 2", "", 2).unwrap();
    ask_answer(&c, 7, "deploy", "yes", 0, "", 2).unwrap();
    pane_ended(&c, "p2", "panel 2 closed").unwrap();
    assert!(agent("deploy"));
}

#[test]
fn a_removed_box_keeps_its_body_for_undo() {
    let c = db();
    put(
        &c,
        7,
        "deploy",
        &body(r#"{"body":"**3/5**","tone":"warn","count":"3/5","lines":2}"#),
        "",
        &PUSH,
        1,
    )
    .unwrap();
    ask_wait(&c, 7, "deploy", "p2", "panel 2", "", 1).unwrap();
    ask_answer(&c, 7, "deploy", "yes", 50, "", 1).unwrap();
    assert!(remove_box(&c, 7, "deploy", 5).unwrap());
    assert!(seat_of(&c, 7, "deploy").unwrap().is_none());
    let a = ask_of(&c, 7, "deploy").unwrap().unwrap();
    assert_eq!((a.answer.as_str(), a.pane.as_str()), ("removed", "p2"));
    let b = body(&a.body);
    assert_eq!(
        (b.md.as_str(), b.tone, b.count.as_str(), b.lines),
        ("**3/5**", Tone::Warn, "3/5", 2)
    );
    // Undo: allowed again, with what it showed, for as long as it was.
    let back = restore_box(&c, 7, "deploy", 6).unwrap().unwrap();
    assert_eq!(back.body, a.body);
    let a = ask_of(&c, 7, "deploy").unwrap().unwrap();
    assert_eq!((a.answer.as_str(), a.until), ("yes", 50));
    assert!(restore_box(&c, 7, "deploy", 7).unwrap().is_none(), "once");
    // A script's box is not an agent's to remove; nor is nothing.
    let script = Writer {
        pane: "",
        writer: "a script",
        ..PUSH
    };
    put(&c, 7, "backup", &body("done"), "", &script, 1).unwrap();
    assert!(!remove_box(&c, 7, "backup", 8).unwrap());
    assert!(seat_of(&c, 7, "backup").unwrap().is_some());
    assert!(!remove_box(&c, 7, "nothing", 8).unwrap());
}

#[test]
fn a_pushed_boxs_switch_is_its_desks() {
    let c = db();
    put(&c, 3, "deploy", &body("a"), "", &PUSH, 1).unwrap();
    put(&c, 8, "deploy", &body("b"), "", &PUSH, 1).unwrap();
    // Off on desk 3, keyed by its desk (1.36): desk 8's stays on.
    let off = Change {
        hidden: Some(true),
        ..Default::default()
    };
    set_prefs(&c, 3, "deploy", &off, 2).unwrap();
    assert!(seat_of(&c, 3, "deploy").unwrap().unwrap().hidden);
    assert!(!seat_of(&c, 8, "deploy").unwrap().unwrap().hidden);
    // One switched off before 1.36, under the name alone, stays off.
    set_prefs(&c, 0, "deploy", &off, 3).unwrap();
    assert!(seat_of(&c, 8, "deploy").unwrap().unwrap().hidden);
    let on = Change {
        hidden: Some(false),
        ..Default::default()
    };
    set_prefs(&c, 8, "deploy", &on, 4).unwrap();
    assert!(!seat_of(&c, 8, "deploy").unwrap().unwrap().hidden);
}

#[test]
fn a_no_is_the_readers_to_take_back() {
    let c = db();
    ask_wait(&c, 1, "deploy", "p1", "panel 1", "x", 1).unwrap();
    ask_answer(&c, 1, "deploy", "no", 0, "", 2).unwrap();
    ask_wait(&c, 2, "ci", "p2", "panel 2", "y", 1).unwrap();
    ask_answer(&c, 2, "ci", "yes", 0, "", 2).unwrap();
    let refused: Vec<_> = asks_refused(&c)
        .unwrap()
        .into_iter()
        .map(|a| (a.desk_id, a.name))
        .collect();
    assert_eq!(refused, vec![(1, "deploy".to_string())]);
    assert!(ask_again(&c, 1, "deploy", 3).unwrap());
    assert_eq!(ask_of(&c, 1, "deploy").unwrap().unwrap().answer, "again");
    assert!(asks_refused(&c).unwrap().is_empty());
    assert!(!ask_again(&c, 2, "ci", 3).unwrap(), "a yes is not a no");
}

#[test]
fn an_agent_brings_a_widget_only_to_a_desk_with_room() {
    let c = db();
    for i in 0..DESK_MAX {
        assert!(desk_has_room(&c, 4).unwrap());
        put(&c, 4, &format!("w{i}"), &body("x"), "", &PUSH, 1).unwrap();
    }
    assert!(!desk_has_room(&c, 4).unwrap());
    assert!(desk_has_room(&c, 5).unwrap());
}

/// A widget file's seat goes with its folder (1.46): every file seat not
/// among the folders found is cleared, and a box's is not a file's to clear.
#[test]
fn a_file_seat_goes_with_its_folder() {
    let c = db();
    fail(&c, 3, "git", "allow: Git wants to run", 2, &FILE, 1).unwrap();
    fail(&c, 7, "arena", "exit 1", 2, &OWN, 1).unwrap();
    put(&c, 3, "deploy", &body("x"), "", &PUSH, 1).unwrap();
    let keep = [(0, "git".to_string())];
    assert_eq!(
        clear_files_except(&c, &keep).unwrap(),
        vec![(7, "arena".to_string())]
    );
    assert!(seat_of(&c, 3, "git").unwrap().is_some());
    assert!(seat_of(&c, 7, "arena").unwrap().is_none());
    assert!(seat_of(&c, 3, "deploy").unwrap().is_some(), "a box stays");
    assert!(clear_files_except(&c, &[])
        .unwrap()
        .contains(&(3, "git".to_string())));
}
