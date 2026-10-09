use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in PREFS_COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(TITLE_COLUMN_1_31).unwrap();
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
};
const FILE: Writer<'static> = Writer {
    source: Source::File,
    writer: "every 2 min",
    pane: "",
    title: "Git",
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
    // Your turn is first whatever was sent.
    assert_eq!(
        l.right,
        ids(&["turn", "notes", "widgets", "panels", "points", "docs"])
    );
    // Your turn can't be hidden, a bare `widgets` names no side.
    assert_eq!(l.hidden, ids(&["folders", "left:widgets"]));
}

#[test]
fn a_section_from_a_later_version_lands_in_its_place() {
    // A layout saved before `points` existed, naming `rest`, which went in
    // 1.30 (#109): the one arrives in its place, the other is dropped.
    let l = Layout {
        left: ids(&LEFT),
        right: ids(&["turn", "docs", "panels", "rest", "notes", "widgets"]),
        hidden: vec![],
    }
    .normalize();
    assert_eq!(
        l.right,
        ids(&["turn", "docs", "panels", "points", "notes", "widgets"])
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
    fail(&c, 3, "git", "exit 1: not a git repository", &FILE, 2).unwrap();
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
    fail(&c, 3, "deploy", "nope", &FILE, 2).unwrap();
    assert_eq!(seat_of(&c, 3, "deploy").unwrap().unwrap().error, "");
}

#[test]
fn a_file_seat_has_its_title_and_how_often_it_runs() {
    let c = db();
    fail(&c, 3, "git", "exit 1", &FILE, 1).unwrap();
    let s = seat_of(&c, 3, "git").unwrap().unwrap();
    assert_eq!(
        (s.title.as_str(), s.writer.as_str()),
        ("Git", "every 2 min")
    );
    // A seat failed before this release said its command's first word: the
    // next line says how often instead.
    c.execute("UPDATE widget_bodies SET writer = 'sh', title = ''", [])
        .unwrap();
    fail(&c, 3, "git", "exit 2", &FILE, 2).unwrap();
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
    fail(&c, 3, "git", &long, &FILE, 1).unwrap();
    let e = seat_of(&c, 3, "git").unwrap().unwrap().error;
    assert_eq!(e.chars().count(), ERROR_MAX);
    assert!(e.ends_with('…'));
    let short = "y".repeat(ERROR_MAX);
    fail(&c, 3, "git", &short, &FILE, 2).unwrap();
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
    assert_eq!(prefs(&c, "git").unwrap().settings, "{}");
    let first = Change {
        hidden: Some(true),
        trusted_hash: Some("abc"),
        ..Change::default()
    };
    set_prefs(&c, "git", &first, 1).unwrap();
    let then = Change {
        settings: Some(r#"{"base":"dev"}"#),
        rerun_edits: Some(true),
        ..Change::default()
    };
    let p = set_prefs(&c, "git", &then, 2).unwrap();
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
    let p = prefs(&c, "ci").unwrap();
    assert!(p.on_desk(1) && p.on_desk(2), "no desks is every desk");
    let ch = Change {
        desks: Some(&[2]),
        until: Some(100),
        ..Change::default()
    };
    let p = set_prefs(&c, "ci", &ch, 1).unwrap();
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
    let p = set_prefs(&c, "ci", &ch, 2).unwrap();
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
        &FILE,
        1,
    )
    .unwrap();
    fail(&c, 4, "ci", "exit 2", &FILE, 1).unwrap();
    assert_eq!(unstop(&c, "ci", None).unwrap(), vec![3]);
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
    // One there before boxes were asked for is taken as allowed.
    put(&c, 1, "tests", &body("ok"), "", &PUSH, 1).unwrap();
    assert!(ask_grandfather(&c, 1, "tests", 3).unwrap());
    assert_eq!(ask_of(&c, 1, "tests").unwrap().unwrap().answer, "yes");
    assert!(!ask_grandfather(&c, 1, "nothing", 3).unwrap());
}
