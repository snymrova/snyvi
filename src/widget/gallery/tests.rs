use super::*;
use crate::store::tempdir::Dir;

/// The widgets' tables, and the desks and turns a pick writes to, as
/// `thread`'s tests build them.
fn db() -> Connection {
    use crate::{desk, thread};
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(super::super::SCHEMA).unwrap();
    conn.execute_batch(desk::SCHEMA).unwrap();
    for c in [
        desk::POS_COLUMN,
        desk::HELD_COLUMN,
        desk::SENT_BY_COLUMN,
        desk::LOOP_COLUMNS_1_37,
        thread::THREAD_COLUMN,
        thread::SCHEMA,
        thread::CMD_COLUMN,
        thread::TAKEN_COLUMN,
        thread::GROUP_COLUMN,
        thread::PR_STATE_1_43,
        thread::AWAY_COLUMN_1_44,
        crate::due::COLUMNS_1_47,
        crate::due::TURN_COLUMN_1_47,
        crate::waiting::COLUMNS_1_47,
    ]
    .into_iter()
    .chain(thread::SUGGEST_COLUMNS_1_30)
    .chain(thread::ON_YOU_1_36)
    {
        conn.execute_batch(c).unwrap();
    }
    for d in [3, 8] {
        conn.execute(
            "INSERT INTO desks (id, name, root, created_at) VALUES (?1, 'd', '/w', 0)",
            [d],
        )
        .unwrap();
    }
    conn
}

/// A PNG's header and nothing else: all `copy_in` reads of it.
fn png(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    v
}

fn out(i: i64, file: &str) -> Add {
    Add {
        stored: Some(Stored {
            file: file.into(),
            kind: "image",
            width: 4,
            height: 3,
        }),
        source: format!("/w/out/{i}.png"),
        caption: format!("take {i}"),
        pane: "p2".into(),
        writer: "panel 2".into(),
        ..Default::default()
    }
}

/// A file is copied in by its hash: twice is one file, and what is not a
/// picture or a clip, or is not what its name says, is refused in words.
#[test]
fn an_output_is_copied_in_by_its_content() {
    let tmp = Dir::new("snyvi-gallery");
    let (src, dir) = (tmp.path.join("src"), tmp.path.join("gallery"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("a.png"), png(640, 480)).unwrap();
    std::fs::write(src.join("b.PNG"), png(640, 480)).unwrap();
    let a = copy_in(&dir, &src.join("a.png")).unwrap();
    assert_eq!((a.kind, a.width, a.height), ("image", 640, 480));
    assert!(file_name_ok(&a.file), "{}", a.file);
    assert!(dir.join(&a.file).exists());
    let b = copy_in(&dir, &src.join("b.PNG")).unwrap();
    assert_eq!(a.file, b.file, "the same bytes are one file");
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        1,
        "and no copy left over"
    );

    std::fs::write(src.join("notes.txt"), "hi").unwrap();
    let e = copy_in(&dir, &src.join("notes.txt"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("not .txt"), "{e}");
    std::fs::write(src.join("fake.png"), "not a picture at all").unwrap();
    let e = copy_in(&dir, &src.join("fake.png"))
        .unwrap_err()
        .to_string();
    assert!(e.contains("does not read as a .png"), "{e}");
    std::fs::write(src.join("empty.mp4"), "").unwrap();
    assert!(copy_in(&dir, &src.join("empty.mp4")).is_err());
    assert!(
        copy_in(&dir, Path::new("out/a.png")).is_err(),
        "a relative path"
    );
    assert!(copy_in(&dir, &src.join("gone.png")).is_err());
    std::fs::write(src.join("clip.mp4"), b"\0\0\0\x18ftypmp42").unwrap();
    let c = copy_in(&dir, &src.join("clip.mp4")).unwrap();
    assert_eq!(c.kind, "video");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "{:?}", c);
}

#[test]
fn only_a_gallery_files_name_is_served() {
    assert!(file_name_ok("0123456789abcdef.png"));
    assert!(file_name_ok("0123456789abcdef.mp4"));
    for bad in [
        "0123456789ABCDEF.png",
        "0123456789abcdef.txt",
        "0123456789abcde.png",
        "../0123456789abcd.png",
        "0123456789abcdef.png.png",
        ".copy-1-0",
        "snyvi.db",
    ] {
        assert!(!file_name_ok(bad), "{bad}");
    }
}

/// A job is a tile before its file: the same job with the file fills it
/// where it stood; sent again once filled, it is a second output, and the
/// first is kept.
#[test]
fn a_job_is_made_then_filled_and_nothing_is_lost() {
    let c = db();
    let making = Add {
        job: "r2-b".into(),
        model: "kling".into(),
        pane: "p2".into(),
        ..Default::default()
    };
    let id = add(&c, 3, "gallery", &making, 10).unwrap();
    let shown = items(&c, 3, "gallery", false, 10).unwrap();
    assert_eq!(
        (shown[0].file.as_str(), shown[0].model.as_str()),
        ("", "kling")
    );
    assert!(strip_html(&shown, 4).contains("making"));
    let mut done = out(1, "0123456789abcdef.png");
    done.job = "r2-b".into();
    done.cost_micros = Some(40_000);
    assert_eq!(
        add(&c, 3, "gallery", &done, 20).unwrap(),
        id,
        "filled in place"
    );
    let shown = items(&c, 3, "gallery", false, 10).unwrap();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].model, "kling", "what the first add said is kept");
    assert_eq!(shown[0].file, "0123456789abcdef.png");
    let again = add(&c, 3, "gallery", &done, 30).unwrap();
    assert_ne!(again, id);
    assert_eq!(totals(&c, 3, "gallery").unwrap(), (2, 80_000));
    let failed = Add {
        job: "r2-c".into(),
        failed: "the model timed out".into(),
        ..Default::default()
    };
    add(&c, 3, "gallery", &failed, 40).unwrap();
    let shown = items(&c, 3, "gallery", false, 10).unwrap();
    assert!(strip_html(&shown, 4).contains("gal-x"));
    let (b, _) = body_now(
        &c,
        3,
        "gallery",
        &Body {
            md: MARK.into(),
            tone: Tone::None,
            count: String::new(),
            lines: 4,
            stale_after: 1800,
        },
    )
    .unwrap();
    assert_eq!(
        b.tone,
        Tone::None,
        "a failure is its tile's, not the count's"
    );
    assert_eq!(b.count, "$0.08");
    assert_eq!(b.stale_after, 0, "a gallery never dims");
    assert!(
        is_gallery(&b.md) && b.md.contains("failed: the model timed out"),
        "{}",
        b.md
    );
}

/// A desk's box shows its own; All desks shows every desk's, newest first.
#[test]
fn all_desks_lists_every_gallery() {
    let c = db();
    add(&c, 3, "gallery", &out(1, "1111111111111111.png"), 10).unwrap();
    add(&c, 8, "gallery", &out(2, "2222222222222222.png"), 20).unwrap();
    add(&c, 3, "renders", &out(3, "3333333333333333.png"), 30).unwrap();
    let mine = items(&c, 3, "gallery", false, 10).unwrap();
    assert_eq!(mine.iter().map(|i| i.desk_id).collect::<Vec<_>>(), [3]);
    let all = items(&c, 3, "gallery", true, 10).unwrap();
    assert_eq!(
        all.iter()
            .map(|i| (i.desk_id, i.name.as_str()))
            .collect::<Vec<_>>(),
        [(3, "renders"), (8, "gallery"), (3, "gallery")]
    );
}

#[test]
fn the_count_is_what_it_cost_or_how_many() {
    assert_eq!(count_label(0, 0), "0");
    assert_eq!(count_label(12, 0), "12");
    assert_eq!(count_label(3, 5_000), "<$0.01");
    assert_eq!(count_label(3, 840_000), "$0.84");
    assert_eq!(count_label(3, 1_234_000_000), "$1234");
    for (n, m) in [(1, 99_999_000_000), (100_000, 0), (1, 999_999_999_999)] {
        assert!(
            count_label(n, m).chars().count() <= super::super::COUNT_MAX,
            "{n} {m}"
        );
    }
    assert_eq!(micros(0.04), Some(40_000));
    assert_eq!(micros(-1.0), None);
    assert_eq!(micros(f64::NAN), None);
}

/// What an agent writes is text in the tiles, never markup.
#[test]
fn a_caption_is_never_markup() {
    let c = db();
    let mut a = out(1, "0123456789abcdef.png");
    a.caption = "\"><script>alert(1)</script>".into();
    a.model = "<b>m</b>".into();
    add(&c, 3, "gallery", &a, 10).unwrap();
    let h = strip_html(&items(&c, 3, "gallery", false, 10).unwrap(), 4);
    assert!(!h.contains("<script") && !h.contains("<b>"), "{h}");
    assert!(h.contains("--gal:76px"), "{h}");
    let mut v = out(2, "1111111111111111.mp4");
    v.stored.as_mut().unwrap().kind = "video";
    add(&c, 3, "gallery", &v, 20).unwrap();
    let h = strip_html(&items(&c, 3, "gallery", false, 10).unwrap(), 4);
    assert!(
        h.contains("gal-v") && !h.contains("/gallery/1111111111111111.mp4"),
        "a clip with no poster is a mark: {h}"
    );
}

/// Pick is an answered turn for the panel that added the output, which its
/// next prompt takes, with the reader's words before the path.
#[test]
fn a_pick_reaches_the_panel_that_made_it() {
    let c = db();
    let id = add(&c, 3, "gallery", &out(1, "0123456789abcdef.png"), 10).unwrap();
    assert_eq!(pick(&c, id, "warmer, closer", 20).unwrap(), Some(3));
    assert_eq!(pick(&c, 999, "", 20).unwrap(), None);
    let told = crate::thread::take_untold(&c, 3, "p2", &["p2".into()], 30).unwrap();
    assert_eq!(told.len(), 1);
    assert_eq!(
        told[0].answer,
        "#1 \"take 1\": warmer, closer (/w/out/1.png)"
    );
    let lines = crate::brief::answer_lines(&told);
    assert!(
        lines[0].contains("Which one in the gallery?\""),
        "{lines:?}"
    );
    assert!(crate::thread::take_untold(&c, 3, "p2", &["p2".into()], 40)
        .unwrap()
        .is_empty());
}
