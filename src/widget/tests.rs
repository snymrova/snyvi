use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
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
};
const FILE: Writer<'static> = Writer {
    source: Source::File,
    writer: "run.sh",
    pane: "",
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
        ids(&["turn", "notes", "widgets", "panels", "rest", "points", "docs"])
    );
    // Your turn can't be hidden, a bare `widgets` names no side.
    assert_eq!(l.hidden, ids(&["folders", "left:widgets"]));
}

#[test]
fn a_section_from_a_later_version_lands_in_its_place() {
    // A layout saved before `points` existed.
    let l = Layout {
        left: ids(&LEFT),
        right: ids(&["turn", "docs", "panels", "rest", "notes", "widgets"]),
        hidden: vec![],
    }
    .normalize();
    assert_eq!(
        l.right,
        ids(&["turn", "docs", "panels", "rest", "points", "notes", "widgets"])
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
    fail(&c, 3, "git", "exit 1: not a git repository", "run.sh", 2).unwrap();
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
    fail(&c, 3, "deploy", "nope", "run.sh", 2).unwrap();
    assert_eq!(seat_of(&c, 3, "deploy").unwrap().unwrap().error, "");
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
    set_prefs(&c, "git", Some(true), None, Some("abc"), None, 1).unwrap();
    let p = set_prefs(
        &c,
        "git",
        None,
        Some(r#"{"base":"dev"}"#),
        None,
        Some(true),
        2,
    )
    .unwrap();
    assert!(p.hidden && p.rerun_edits);
    assert_eq!(
        (p.trusted_hash.as_str(), p.settings.as_str()),
        ("abc", r#"{"base":"dev"}"#)
    );
    // Hidden reaches the seat.
    put(&c, 0, "git", &body("x"), "", &FILE, 1).unwrap();
    assert!(seats(&c, 0).unwrap()[0].hidden);
}
