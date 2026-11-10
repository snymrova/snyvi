use super::*;
use crate::store::tempdir::Dir;

fn size(w: u32, h: u32) -> Size {
    Size {
        w: Some(w),
        h: Some(h),
        ..Default::default()
    }
}

#[test]
fn names_are_checked() {
    for ok in ["home", "a", "hero-2", "0", &"a".repeat(64)] {
        assert!(valid_name(ok), "{ok}");
    }
    for bad in [
        "",
        "-a",
        "Home",
        "a_b",
        "a.b",
        "..",
        "a/b",
        "a b",
        &"a".repeat(65),
    ] {
        assert!(!valid_name(bad), "{bad}");
    }
}

#[test]
fn a_write_makes_the_board_and_round_trips() {
    let d = Dir::new("snyvi-board");
    let p = write(&d.path, "home", "hero", "<h1>Hi</h1>", size(1200, 600)).unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "<h1>Hi</h1>");
    let cards = write(&d.path, "home", "cards", "<p>c</p>", Size::default()).unwrap();
    assert!(cards.ends_with("design/home/cards.html"));

    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    let b = read(&bd);
    assert_eq!(b.frames.len(), 2);
    assert_eq!(
        (b.frames[0].id.as_str(), b.frames[0].w, b.frames[0].h),
        ("hero", 1200, 600)
    );
    assert_eq!(
        b.frames[1].x,
        1200 + GAP,
        "the next frame goes to the right"
    );
    assert_eq!(b.frames[1].order, 1);

    // Rewritten whole, its place kept, its size changed only when given.
    write(
        &d.path,
        "home",
        "hero",
        "<h1>Hello</h1>",
        Size {
            h: Some(700),
            ..Default::default()
        },
    )
    .unwrap();
    let b2 = read(&bd);
    assert_eq!(
        (b2.frames[0].w, b2.frames[0].h, b2.frames[0].x),
        (1200, 700, 0)
    );
    assert_eq!(frame_html(&bd, "hero").unwrap(), b"<h1>Hello</h1>");

    let json = std::fs::read_to_string(bd.join("board.json")).unwrap();
    let back: Board = serde_json::from_str(&json).unwrap();
    assert_eq!(back, b2, "board.json is the board");
    assert!(
        json.find("\"id\"").unwrap() < json.find("\"w\"").unwrap(),
        "keys in order"
    );

    assert_eq!(
        boards(&d.path),
        vec![BoardHead {
            id: "home".into(),
            name: "home".into(),
            frames: 2
        }]
    );
    assert_eq!(
        views(&d.path),
        vec!["folder".to_string(), "board:home".to_string()]
    );
}

#[test]
fn bad_names_and_escapes_are_refused_before_anything_is_made() {
    let d = Dir::new("snyvi-board");
    assert!(write(&d.path, "home", "../x", "x", Size::default()).is_err());
    assert!(write(&d.path, "home", "Hero", "x", Size::default()).is_err());
    assert!(!d.path.join(DIR).exists(), "a bad id leaves no folder");
    assert!(write(&d.path, "..", "x", "x", Size::default()).is_err());
    assert!(write(&d.path, "a/b", "x", "x", Size::default()).is_err());
    assert!(!d.path.join(DIR).exists(), "nor does a bad board name");
    assert!(write(
        &d.path,
        "home",
        "big",
        &"x".repeat(MAX_FRAME_BYTES + 1),
        Size::default()
    )
    .is_err());
    assert!(write(&d.path, "home", "wide", "x", size(MAX_SIDE + 1, 10)).is_err());
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_folder_is_refused() {
    let d = Dir::new("snyvi-board");
    let outside = Dir::new("snyvi-board-out");
    std::fs::create_dir(d.path.join(DIR)).unwrap();
    std::os::unix::fs::symlink(&outside.path, d.path.join(DIR).join("home")).unwrap();
    assert!(write(&d.path, "home", "x", "x", Size::default()).is_err());
    assert!(
        !outside.path.join("x.html").exists(),
        "nothing written outside"
    );

    // A frame file that is a link to a file outside is not read, and a write
    // replaces the link, not what it points at.
    write(&d.path, "real", "a", "<p>a</p>", Size::default()).unwrap();
    let secret = outside.path.join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();
    let bd = dir(&d.path, "real", false).unwrap().unwrap();
    std::os::unix::fs::symlink(&secret, bd.join("leak.html")).unwrap();
    assert!(frame_html(&bd, "leak").is_none());
    write(&d.path, "real", "leak", "<p>mine</p>", Size::default()).unwrap();
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "secret");
}

#[test]
fn hide_keeps_the_file_and_a_write_shows_it_again() {
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "hero", "<p>h</p>", Size::default()).unwrap();
    assert!(hide(&d.path, "home", "hero", true).unwrap());
    assert!(!hide(&d.path, "home", "nope", true).unwrap());
    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    assert!(read(&bd).frames[0].hidden);
    assert!(bd.join("hero.html").is_file(), "hidden, not deleted");
    assert_eq!(boards(&d.path)[0].frames, 0);
    assert!(
        !export(&bd, "home").contains("<p>h</p>"),
        "a hidden frame is not exported"
    );
    write(&d.path, "home", "hero", "<p>h2</p>", Size::default()).unwrap();
    assert!(!read(&bd).frames[0].hidden);
}

#[test]
fn a_broken_board_json_is_read_leniently_and_never_overwritten() {
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "hero", "<p>h</p>", Size::default()).unwrap();
    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    let broken = r#"{"frames":[{"id":"hero","w":900},{"id":"BAD"},{"w":"x"}],"#;
    std::fs::write(bd.join("board.json"), broken).unwrap();
    assert_eq!(
        read(&bd).frames.len(),
        1,
        "what can be read of it, plus the files"
    );
    assert!(write(&d.path, "home", "hero", "<p>x</p>", Size::default()).is_err());
    assert!(hide(&d.path, "home", "hero", true).is_err());
    assert_eq!(
        std::fs::read_to_string(bd.join("board.json")).unwrap(),
        broken
    );
}

#[test]
fn a_frame_written_another_way_is_on_the_board() {
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "hero", "<p>h</p>", size(500, 300)).unwrap();
    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    std::fs::write(bd.join("by-hand.html"), "<p>x</p>").unwrap();
    std::fs::write(bd.join("Not A Frame.html"), "<p>x</p>").unwrap();
    let b = read(&bd);
    assert_eq!(
        b.frames.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
        ["hero", "by-hand"]
    );
    assert_eq!(b.frames[1].x, 500 + GAP);
    let (_, fr, h1) = frames(&bd);
    assert!(fr.iter().all(|f| !f.missing && f.hash.len() == 16));
    std::fs::write(bd.join("by-hand.html"), "<p>y</p>").unwrap();
    assert_ne!(
        frames(&bd).2,
        h1,
        "a rewritten file changes the board's hash"
    );
}

#[test]
fn arrange_moves_names_and_refuses_an_unknown_frame() {
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "a", "a", Size::default()).unwrap();
    write(&d.path, "home", "b", "b", Size::default()).unwrap();
    let places = [Place {
        id: "b".into(),
        x: Some(0),
        y: Some(900),
        order: Some(-1),
        name: Some("Bee".into()),
        source: Some("threads".into()),
    }];
    let b = arrange(&d.path, "home", &places, Some("Home page")).unwrap();
    assert_eq!(b.name, "Home page");
    assert_eq!(
        (
            b.frames[0].id.as_str(),
            b.frames[0].y,
            b.frames[0].name.as_str()
        ),
        ("b", 900, "Bee")
    );
    let bad = [Place {
        id: "c".into(),
        x: None,
        y: None,
        order: None,
        name: None,
        source: None,
    }];
    assert!(arrange(&d.path, "home", &bad, None).is_err());
    // A live frame's source (C7): a known one is kept, another refused,
    // and an empty one takes it off.
    assert_eq!(b.frames[0].source, "threads");
    let wrong = [Place {
        id: "b".into(),
        x: None,
        y: None,
        order: None,
        name: None,
        source: Some("stars".into()),
    }];
    assert!(arrange(&d.path, "home", &wrong, None).is_err());
    let off = [Place {
        id: "b".into(),
        x: None,
        y: None,
        order: None,
        name: None,
        source: Some(String::new()),
    }];
    assert_eq!(
        arrange(&d.path, "home", &off, None).unwrap().frames[0].source,
        ""
    );
    assert!(arrange(&d.path, "nope", &[], None).is_err());
}

#[test]
fn tokens_and_the_design_head() {
    let d = Dir::new("snyvi-board");
    assert!(tokens(&d.path).vars.is_empty());
    std::fs::create_dir(d.path.join(DIR)).unwrap();
    std::fs::write(
        d.path.join(DIR).join("tokens.css"),
        ":root{ /* brand */ --ink: #222; --accent:oklch(60% .1 30);\n--ink: #000; color: red }",
    )
    .unwrap();
    std::fs::write(
        d.path.join(DIR).join("DESIGN.md"),
        "# Look\n\nCalm and\nwarm.\n\nMore.",
    )
    .unwrap();
    let t = tokens(&d.path);
    assert_eq!(
        t.vars,
        vec![
            ("--ink".into(), "#222".into()),
            ("--accent".into(), "oklch(60% .1 30)".into())
        ]
    );
    assert_eq!(t.design.as_deref(), Some("Calm and warm."));
}

#[test]
fn a_section_is_as_tall_as_its_content_unless_given_a_height() {
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "auto", "<p>a</p>", Size::default()).unwrap();
    write(&d.path, "home", "cut", "<p>c</p>", size(400, 300)).unwrap();
    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    let b = read(&bd);
    assert_eq!(
        (b.frames[0].w, b.frames[0].h),
        (DEFAULT_W, 0),
        "0 is the content's"
    );
    assert_eq!((b.frames[1].w, b.frames[1].h), (400, 300));
    // A file nobody named is a section too, as tall as it is.
    std::fs::write(bd.join("loose.html"), "<p>l</p>").unwrap();
    assert_eq!(read(&bd).frames[2].h, 0);
    let wide = Size {
        w: Some(0),
        ..Default::default()
    };
    assert!(write(&d.path, "home", "auto", "x", wide).is_err());
    let tall = Size {
        h: Some(MAX_SIDE + 1),
        ..Default::default()
    };
    assert!(write(&d.path, "home", "auto", "x", tall).is_err());
}

#[test]
fn a_script_makes_an_island_and_the_read_says_so() {
    assert!(is_island("<div></div><SCRIPT>x()</SCRIPT>"));
    assert!(!is_island("<p>a script tag, in words</p>"));
    let d = Dir::new("snyvi-board");
    write(&d.path, "home", "plain", "<p>p</p>", Size::default()).unwrap();
    write(
        &d.path,
        "home",
        "live",
        "<script>1</script>",
        Size::default(),
    )
    .unwrap();
    let bd = dir(&d.path, "home", false).unwrap().unwrap();
    let (_, fr, _) = frames(&bd);
    assert_eq!(
        fr.iter().map(|f| f.island).collect::<Vec<_>>(),
        [false, true]
    );
    let x = export(&bd, "home");
    assert!(
        x.contains("shadowrootmode=\"open\""),
        "a section is a shadow root"
    );
    assert!(x.contains("srcdoc"), "an island keeps a page of its own");
    assert!(
        x.contains(&format!("height:{ISLAND_H}px"))
            || x.contains(&format!("height=\"{ISLAND_H}\""))
    );
}

#[test]
fn a_sections_page_selectors_mean_the_section() {
    let h = host_selectors(
        "<style>body{margin:0} html, :root{--a:1} .body-x{} .body{} @media (max-width:1px){body p{x:y}}</style><body>b</body>",
    );
    assert!(h.contains(":host{margin:0}"), "{h}");
    assert!(
        h.contains(":host, :host{--a:1}") || h.contains(":host,:host{--a:1}"),
        "{h}"
    );
    assert!(
        h.contains(".body-x{}"),
        "a word that only starts with body stays: {h}"
    );
    assert!(h.contains(" .body{}"), "a class named body stays: {h}");
    assert!(h.contains("@media (max-width:1px){:host p{x:y}}"), "{h}");
    assert!(h.ends_with("<body>b</body>"), "only CSS changes: {h}");
}

#[test]
fn a_new_board_is_named_and_its_folder_never_taken_twice() {
    assert_eq!(slug("Pricing page!"), "pricing-page");
    assert_eq!(slug("  "), "board");
    assert_eq!(slug("Été 2026"), "t-2026");
    let d = Dir::new("snyvi-board");
    assert_eq!(create(&d.path, "Pricing page").unwrap(), "pricing-page");
    assert_eq!(create(&d.path, "Pricing page").unwrap(), "pricing-page-2");
    assert!(create(&d.path, " ").is_err());
    let hs = boards(&d.path);
    assert_eq!(
        hs.iter()
            .map(|b| (b.id.as_str(), b.name.as_str(), b.frames))
            .collect::<Vec<_>>(),
        [
            ("pricing-page", "Pricing page", 0),
            ("pricing-page-2", "Pricing page", 0)
        ]
    );
    // An empty board is a view, before anything is drawn on it.
    assert!(views(&d.path).contains(&"board:pricing-page".to_string()));
    let renamed = arrange(&d.path, "pricing-page-2", &[], Some("Pricing, take two")).unwrap();
    assert_eq!(renamed.name, "Pricing, take two");
}
