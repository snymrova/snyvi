use super::accent::{accent_of, parse_hex, png_pixels};
use super::draft::{draft, readme_parts};
use super::*;
use crate::store::tempdir::Dir;
use std::io::Write;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::peer::SCHEMA).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO desks(id, name, root, created_at) VALUES(1, 'Breeds of Dogs', '/tmp/dogs', 1)",
        [],
    )
    .unwrap();
    conn
}

/// A PNG of `w` × `h`, RGBA, each pixel from `at`. The CRCs are left zero:
/// the reader does not check them, and a browser is not reading these.
fn png(w: u32, h: u32, at: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..h {
        // Alternate the filters, so each one is undone at least once.
        let f = (y % 5) as u8;
        raw.push(f);
        let row: Vec<u8> = (0..w).flat_map(|x| at(x, y)).collect();
        let prev: Vec<u8> = if y == 0 {
            vec![0; row.len()]
        } else {
            (0..w).flat_map(|x| at(x, y - 1)).collect()
        };
        for i in 0..row.len() {
            let a = if i >= 4 { row[i - 4] } else { 0 };
            let b = prev[i];
            let c = if i >= 4 { prev[i - 4] } else { 0 };
            let pred = match f {
                0 => 0,
                1 => a,
                2 => b,
                3 => ((a as u16 + b as u16) / 2) as u8,
                _ => {
                    let p = a as i16 + b as i16 - c as i16;
                    let (pa, pb, pc) = (
                        (p - a as i16).abs(),
                        (p - b as i16).abs(),
                        (p - c as i16).abs(),
                    );
                    if pa <= pb && pa <= pc {
                        a
                    } else if pb <= pc {
                        b
                    } else {
                        c
                    }
                }
            };
            raw.push(row[i].wrapping_sub(pred));
        }
    }
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    z.write_all(&raw).unwrap();
    let idat = z.finish().unwrap();
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let chunk = |out: &mut Vec<u8>, kind: &[u8], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]);
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn solid(hex: &str) -> Vec<u8> {
    let c = parse_hex(hex).unwrap();
    png(24, 24, |_, _| [c[0], c[1], c[2], 255])
}

/// A mark on white, with a transparent margin: the white and the margin say
/// nothing, the mark is the colour.
fn mark_on_white(hex: &str) -> Vec<u8> {
    let c = parse_hex(hex).unwrap();
    png(40, 40, |x, y| {
        if x < 4 || y < 4 {
            [0, 0, 0, 0]
        } else if (10..30).contains(&x) && (10..30).contains(&y) {
            [c[0], c[1], c[2], 255]
        } else {
            [255, 255, 255, 255]
        }
    })
}

#[test]
fn a_png_reads_back_through_every_filter() {
    let b = png(7, 6, |x, y| [x as u8 * 30, y as u8 * 40, 200, 255]);
    let px = png_pixels(&b).unwrap();
    assert_eq!(px.len(), 42);
    assert_eq!(px[0], [0, 0, 200]);
    assert_eq!(px[6 * 7 - 1], [180, 200, 200]);
    // Transparent pixels are not the mark's.
    let b = png(4, 4, |x, _| [9, 9, 9, if x < 2 { 0 } else { 255 }]);
    assert_eq!(png_pixels(&b).unwrap().len(), 8);
    // Not a PNG, or one cut short, is no pixels, never a panic.
    assert!(png_pixels(b"GIF89a").is_none());
    assert!(png_pixels(&b[..b.len() / 2]).is_none());
}

/// The six marks the design round pinned: each snaps to the one of the
/// eight a reader would call it, and the seed's own hex is the wash.
#[test]
fn six_marks_snap_to_the_eight() {
    let cases: [(&[u8], &str, &str); 6] = [
        (&solid("#ff0000"), "png", "crimson"),
        (&mark_on_white("#e11d48"), "png", "passion"),
        (&solid("#ec4899"), "png", "rose"),
        (
            br##"<svg><rect fill="#a855f7"/><circle style="fill:#a855f7"/><path fill="none"/></svg>"##,
            "svg",
            "violet",
        ),
        (
            br##"<svg><linearGradient><stop stop-color="#2563eb"/></linearGradient><path fill='rgb(37, 99, 235)'/></svg>"##,
            "svg",
            "blue",
        ),
        (&mark_on_white("#22c55e"), "png", "green"),
    ];
    for (bytes, ext, want) in cases {
        let a = accent_of(bytes, ext);
        assert_eq!(a.name, want, "{ext} mark wanted {want}, wash {}", a.wash);
        assert!(a.wash.starts_with('#') && a.wash.len() == 7, "{}", a.wash);
    }
    // Cyan is teal's: the nearest hue, not the nearest name.
    assert_eq!(accent_of(&solid("#06b6d4"), "png").name, "teal");
}

#[test]
fn a_grey_mark_is_graphite_and_a_speck_of_colour_does_not_change_it() {
    let a = accent_of(&solid("#9ca3af"), "png");
    assert_eq!(a.name, "graphite");
    // Two red pixels in 1,600 grey ones are under the 1% that is noise.
    let b = png(40, 40, |x, y| {
        if x == 0 && y < 2 {
            [255, 0, 0, 255]
        } else {
            [120, 120, 120, 255]
        }
    });
    assert_eq!(accent_of(&b, "png").name, "graphite");
    // Something that is not PNG or SVG has no colour to read.
    assert_eq!(accent_of(b"\xff\xd8\xff", "jpg").name, "graphite");
    assert_eq!(accent_of(b"\xff\xd8\xff", "jpg").wash, "");
    assert_eq!(accent_of(b"<svg/>", "svg").name, "graphite");
}

#[test]
fn a_readme_gives_its_heading_and_its_first_plain_paragraph() {
    let (t, l) = readme_parts(
        "<p align=center><img src=x></p>\n\n# **Breeds** of dogs\n\n[![ci](b.svg)](x)\n\n\
         A field guide to *every* breed, written with [my dog](https://x).\nOne line more.\n\n\
         ## Install\n",
    )
    .unwrap();
    assert_eq!(t, "Breeds of dogs");
    assert_eq!(
        l,
        "A field guide to every breed, written with my dog. One line more."
    );
    // A heading straight into a section has no lede, not the section's.
    let (_, l) = readme_parts("# snyvi\n\n## Install\n\nrun it\n").unwrap();
    assert_eq!(l, "");
    assert!(readme_parts("no heading here\n").is_none());
    let long = format!("# t\n\n{}\n", "word ".repeat(200));
    let (_, l) = readme_parts(&long).unwrap();
    assert!(l.chars().count() <= draft::LEDE_CHARS && l.ends_with('…'));
}

#[test]
fn a_draft_says_where_each_field_came_from() {
    let d = Dir::new("snyvi-page");
    let root = &d.path;
    std::fs::write(root.join("README.md"), "# Breeds of dogs\n\nEvery breed.\n").unwrap();
    std::fs::create_dir_all(root.join("manuscript")).unwrap();
    std::fs::create_dir_all(root.join("icons")).unwrap();
    std::fs::write(root.join("icons/icon.svg"), r##"<svg fill="#22c55e"/>"##).unwrap();
    let dr = draft(root, "dogs", &["building".into(), "idea".into()]);
    assert_eq!(dr.title, "Breeds of dogs");
    assert_eq!(dr.lede, "Every breed.");
    assert_eq!((dr.tone.as_str(), dr.kind.as_str()), ("book", "Book"));
    assert_eq!(dr.stage, "Writing");
    assert_eq!(dr.accent, "green");
    assert!(dr.logo.as_ref().unwrap().ends_with("icons/icon.svg"));
    let from = |f: &str| dr.from.get(f).map(String::as_str);
    assert_eq!(from("title"), Some("readme"));
    assert_eq!(from("tone"), Some("views"));
    assert_eq!(from("stage"), Some("thread"));
    assert_eq!(from("logo"), Some("icon"));
    // No remote, no GitHub, and no chip that says there was one.
    assert_eq!(from("github"), None);
    for src in dr.from.values() {
        assert!(draft::FROM.contains(&src.as_str()), "{src}");
    }

    // A bare folder: the desk's name, software, no stage, passion.
    let bare = Dir::new("snyvi-page-bare");
    let dr = draft(&bare.path, "My Thing", &[]);
    assert_eq!(dr.title, "My Thing");
    assert_eq!(dr.from.get("title").map(String::as_str), Some("desk"));
    assert_eq!((dr.tone.as_str(), dr.stage.as_str()), ("software", ""));
    assert_eq!(dr.accent, "passion");
    assert!(dr.logo.is_none());
}

#[test]
fn a_logo_linked_from_outside_the_folder_is_not_the_desks() {
    let d = Dir::new("snyvi-page-link");
    let out = Dir::new("snyvi-page-out");
    std::fs::write(out.path.join("logo.svg"), "<svg/>").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(out.path.join("logo.svg"), d.path.join("logo.svg")).unwrap();
        assert!(draft(&d.path, "x", &[]).logo.is_none());
    }
}

#[test]
fn slugs_from_names_and_the_rule() {
    assert_eq!(slug_of("Breeds of Dogs!", 3), "breeds-of-dogs");
    assert_eq!(slug_of("  snyvi  ", 3), "snyvi");
    assert_eq!(slug_of("काम", 7), "page-7");
    assert_eq!(slug_of("x", 9), "page-9");
    assert!(slug_of(&"a".repeat(90), 1).len() <= 40);
    for ok in ["ab", "breeds-of-dogs", "0x", &"a".repeat(40)] {
        assert!(valid_slug(ok), "{ok}");
    }
    for bad in ["", "a", "-ab", "Ab", "a_b", "a.b", "a/b", &"a".repeat(41)] {
        assert!(!valid_slug(bad), "{bad}");
    }
}

fn started(conn: &Connection) -> Page {
    let mut d = Draft {
        title: "Breeds of dogs".into(),
        lede: "Every breed.".into(),
        tone: "book".into(),
        kind: "Book".into(),
        accent: "green".into(),
        wash: "#22c55e".into(),
        ..Default::default()
    };
    for f in ["title", "lede", "tone", "kind", "accent", "logo"] {
        d.from.insert(f.into(), "readme".into());
    }
    start(conn, 1, "Breeds of Dogs", &d, "", 10).unwrap()
}

#[test]
fn a_page_starts_from_its_draft_once_and_an_edit_drops_the_chip() {
    let conn = db();
    let p = started(&conn);
    assert_eq!(p.slug, "breeds-of-dogs");
    assert_eq!(p.visibility, "off");
    assert_eq!(p.facts, ["stage", "kind", "last", "looking"]);
    // No logo was copied in, so no chip says one came from anywhere.
    assert!(!p.provenance.contains_key("logo"));
    // A second start is the same page.
    assert_eq!(started(&conn).id, p.id);

    let e = Edit {
        title: Some("  Breeds   of dogs,\n a guide ".into()),
        facts: Some(vec!["looking".into(), "stage".into(), "nope".into()]),
        ..Default::default()
    };
    let p = save(&conn, 1, &e, 20).unwrap();
    assert_eq!(p.title, "Breeds of dogs, a guide");
    assert_eq!(p.facts, ["stage", "looking"]);
    assert!(!p.provenance.contains_key("title"));
    assert!(p.provenance.contains_key("lede"));

    // The chip puts the draft back, and its chip with it.
    let d = Draft {
        title: "Breeds of dogs".into(),
        from: [("title".to_string(), "readme".to_string())].into(),
        ..Default::default()
    };
    let p = redraft(&conn, 1, "title", &d, "", 30).unwrap();
    assert_eq!(p.title, "Breeds of dogs");
    assert_eq!(
        p.provenance.get("title").map(String::as_str),
        Some("readme")
    );
    assert!(redraft(&conn, 1, "slug; DROP TABLE pages", &d, "", 30).is_err());
}

#[test]
fn an_edit_is_checked_field_by_field() {
    let conn = db();
    started(&conn);
    let bad = [
        Edit {
            tone: Some("poem".into()),
            ..Default::default()
        },
        Edit {
            accent: Some("#ff0000".into()),
            ..Default::default()
        },
        Edit {
            visibility: Some("public".into()),
            ..Default::default()
        },
        Edit {
            github: Some("javascript:alert(1)".into()),
            ..Default::default()
        },
        Edit {
            links: Some(vec![Link {
                label: "x".into(),
                url: "http://plain".into(),
            }]),
            ..Default::default()
        },
        Edit {
            lede: Some("x".repeat(draft::LEDE_CHARS + 1)),
            ..Default::default()
        },
        Edit {
            slug: Some("Not A Slug".into()),
            ..Default::default()
        },
    ];
    for e in bad {
        assert!(save(&conn, 1, &e, 20).is_err(), "{e:?}");
    }
    // Nothing a refused edit carried was kept.
    let p = get(&conn, 1).unwrap().unwrap();
    assert_eq!((p.tone.as_str(), p.accent.as_str()), ("book", "green"));
    // A link with no URL is dropped, not kept empty.
    let p = save(
        &conn,
        1,
        &Edit {
            links: Some(vec![
                Link {
                    label: "Site".into(),
                    url: "https://dogs.example".into(),
                },
                Link {
                    label: "empty".into(),
                    url: " ".into(),
                },
            ]),
            ..Default::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(p.links.len(), 1);
}

#[test]
fn the_slug_is_the_builders_until_the_page_is_up() {
    let conn = db();
    let p = started(&conn);
    let e = Edit {
        slug: Some("dogs".into()),
        ..Default::default()
    };
    assert_eq!(save(&conn, 1, &e, 20).unwrap().slug, "dogs");
    mark_up(&conn, p.id, 30).unwrap();
    let p = get(&conn, 1).unwrap().unwrap();
    assert!(p.is_up() && !p.slug_open());
    assert_eq!(p.published_at, 30);
    let e = Edit {
        slug: Some("hounds".into()),
        ..Default::default()
    };
    let err = save(&conn, 1, &e, 40).unwrap_err().to_string();
    assert!(err.contains("stays"), "{err}");
    // The same name again is not a change.
    let e = Edit {
        slug: Some("dogs".into()),
        ..Default::default()
    };
    assert!(save(&conn, 1, &e, 40).is_ok());
    // Down is a stamp: off for everyone, the first publish kept.
    mark_down(&conn, p.id, 50).unwrap();
    let p = get(&conn, 1).unwrap().unwrap();
    assert!(!p.is_up());
    assert_eq!((p.visibility.as_str(), p.published_at), ("off", 30));
    mark_up(&conn, p.id, 60).unwrap();
    assert_eq!(get(&conn, 1).unwrap().unwrap().published_at, 30);
}

#[test]
fn a_moment_about_the_same_thing_updates_until_it_is_up() {
    let conn = db();
    let p = started(&conn);
    let m = MomentIn {
        about: "chapter 4".into(),
        title: "Chapter 4 accepted".into(),
        files: vec!["0123456789abcdef.png".into()],
        ..Default::default()
    };
    let a = put_moment(&conn, p.id, &m, 10).unwrap();
    let m2 = MomentIn {
        title: "Chapter 4 is in".into(),
        ..m.clone()
    };
    assert_eq!(put_moment(&conn, p.id, &m2, 11).unwrap(), a);
    assert_eq!(moment(&conn, a).unwrap().unwrap().title, "Chapter 4 is in");
    assert!(moment_up(&conn, a, 12).unwrap());
    assert!(!moment_up(&conn, a, 13).unwrap(), "up once");
    let b = put_moment(&conn, p.id, &m2, 14).unwrap();
    assert_ne!(a, b, "once up, the next is a new moment");
    assert_eq!(moments(&conn, p.id, false).unwrap()[0].id, b);
    hide_moment(&conn, b, true, 15).unwrap();
    assert_eq!(moments(&conn, p.id, false).unwrap().len(), 1);
    assert_eq!(moments(&conn, p.id, true).unwrap().len(), 2, "hidden, kept");
    assert_eq!(
        file_names(&conn, &p).unwrap(),
        ["0123456789abcdef.png".to_string()]
    );
    let bad = [
        MomentIn {
            title: " ".into(),
            ..Default::default()
        },
        MomentIn {
            title: "x".into(),
            files: vec!["../../etc/passwd".into()],
            ..Default::default()
        },
        MomentIn {
            title: "x".into(),
            files: vec!["0123456789abcdef.png".into(); MOMENT_FILES_MAX + 1],
            ..Default::default()
        },
    ];
    for m in bad {
        assert!(put_moment(&conn, p.id, &m, 20).is_err(), "{m:?}");
    }
}

#[test]
fn one_card_per_thing_and_not_now_is_final() {
    let conn = db();
    let o = offer(&conn, 1, "Breeds of dogs", "Shipped", "v1", "snyvi", "", 10).unwrap();
    let Offered::New(id) = o else { panic!("{o:?}") };
    // The agent's words on the same ship update the one card.
    assert_eq!(
        offer(
            &conn,
            1,
            "Breeds of dogs",
            "Chapter 4",
            "words",
            "claude-code",
            "p1",
            11
        )
        .unwrap(),
        Offered::Updated(id)
    );
    let open = open_offers(&conn, 1).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(
        (open[0].by.as_str(), open[0].text.as_str()),
        ("claude-code", "words")
    );
    assert!(answer_offer(&conn, id, "notnow", 12).unwrap());
    assert!(
        !answer_offer(&conn, id, "looked", 13).unwrap(),
        "answered once"
    );
    assert_eq!(
        offer(&conn, 1, "Breeds of dogs", "Again", "", "snyvi", "", 14).unwrap(),
        Offered::Answered
    );
    assert!(open_offers(&conn, 1).unwrap().is_empty());
    assert!(offer(&conn, 1, " ", "t", "", "snyvi", "", 15).is_err());
    assert!(answer_offer(&conn, id, "publish", 16).is_err());
    let long = "x".repeat(200);
    let Offered::New(id) = offer(&conn, 1, "other", &long, "", "snyvi", "", 17).unwrap() else {
        panic!()
    };
    let t = offer_by_id(&conn, id).unwrap().unwrap().title;
    assert!(t.chars().count() <= OFFER_TITLE_CHARS);
}

#[test]
fn files_are_copied_by_their_content_and_held_to_their_caps() {
    let d = Dir::new("snyvi-page-files");
    let dir = d.path.join(files::DIR);
    let src = d.path.join("logo.svg");
    std::fs::write(&src, "<svg/>").unwrap();
    let a = files::copy_in(&dir, &src, files::Role::Logo, 0).unwrap();
    assert!(files::file_name_ok(&a), "{a}");
    assert!(a.ends_with(".svg"));
    // The same bytes are the same name, one file.
    assert_eq!(files::copy_in(&dir, &src, files::Role::Logo, 0).unwrap(), a);
    assert_eq!(files::held(&dir, &[&a, &a, ""]), 6);

    let big = d.path.join("big.png");
    std::fs::write(&big, vec![0u8; files::LOGO_MAX as usize + 1]).unwrap();
    let err = files::copy_in(&dir, &big, files::Role::Logo, 0)
        .unwrap_err()
        .to_string();
    assert!(err.contains("400 KB"), "{err}");
    let err = files::copy_in(&dir, &src, files::Role::Clip, 0)
        .unwrap_err()
        .to_string();
    assert!(err.contains("mp4"), "{err}");
    let err = files::copy_in(&dir, &src, files::Role::Logo, files::PAGE_MAX)
        .unwrap_err()
        .to_string();
    assert!(err.contains("50.0 MB"), "{err}");
    for bad in [
        "x.png",
        "0123456789ABCDEF.png",
        "0123456789abcdef.exe",
        "../a.png",
    ] {
        assert!(!files::file_name_ok(bad), "{bad}");
    }
}
