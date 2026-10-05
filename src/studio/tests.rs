use super::*;

/// A scratch folder for one test, gone when it ends.
pub(super) struct Scratch(pub PathBuf);
impl Scratch {
    pub(super) fn new(tag: &str) -> Scratch {
        let mut buf = [0u8; 6];
        getrandom::fill(&mut buf).unwrap();
        let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        let p = std::env::temp_dir().join(format!("snyvi-studio-{tag}-{hex}"));
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p.canonicalize().unwrap())
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(p: &Path, body: &[u8]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// A studio folder is a real, absolute folder. New studio desk makes the
/// one it names when only its last part is missing, and never a chain.
#[test]
fn a_studio_folder_is_absolute_and_made_one_level_at_most() {
    let t = Scratch::new("folder");
    assert!(folder_ok("relative/path").is_err());
    assert!(folder_ok(&t.0.join("missing").to_string_lossy()).is_err());
    write(&t.0.join("file"), b"x");
    assert!(folder_ok(&t.0.join("file").to_string_lossy()).is_err());
    assert_eq!(folder_ok(&t.0.to_string_lossy()).unwrap(), t.0);

    assert_eq!(
        make_folder(&t.0.join("Studio").to_string_lossy()).unwrap(),
        t.0.join("Studio")
    );
    assert!(t.0.join("Studio").is_dir());
    // There already: as it is.
    assert!(make_folder(&t.0.join("Studio").to_string_lossy()).is_ok());
    assert!(make_folder(&t.0.join("a/b/c").to_string_lossy()).is_err());
    assert!(!t.0.join("a").exists(), "no chain of folders");
    assert!(make_folder(&t.0.join(".hid").to_string_lossy()).is_err());
    assert!(make_folder("rel/Studio").is_err());
    assert_eq!(offered(Path::new("/home/u")), Path::new("/home/u/Studio"));
}

/// The panel starts as plain `claude` in the folder; the `--add-dir`
/// command an older build kept is taken for snyvi's own and replaced, and a
/// command the reader typed is theirs.
#[test]
fn the_agent_starts_as_plain_claude() {
    assert!(stale_cmd(""));
    assert!(stale_cmd("claude"));
    assert!(stale_cmd("claude --add-dir /a --add-dir /b"));
    assert!(!stale_cmd("claude --model opus"));
    assert!(!stale_cmd("bash"));
}

/// A launch folder as an agent might leave it: two folders in an order,
/// pictures with the JSON beside them, a document and a script the viewer
/// does not show.
fn launch(root: &Path) {
    write(
        &root.join("launch/folder.json"),
        br#"{"title":"Launch teaser","order":["stills","motion"],"picks":["cover.png"]}"#,
    );
    write(&root.join("launch/cover.png"), b"p");
    write(
        &root.join("launch/cover.png.json"),
        br#"{"prompt":"a cover","model":"m/x","cost_usd":0.04}"#,
    );
    write(&root.join("launch/brief.md"), b"# not in the viewer");
    write(
        &root.join("launch/stills/folder.json"),
        br#"{"title":"Stills","note":"16:9, warm dusk","order":["s02.png"]}"#,
    );
    write(&root.join("launch/stills/s01.png"), b"1");
    write(&root.join("launch/stills/s02.png"), b"2");
    write(
        &root.join("launch/stills/s02.png.json"),
        br#"{"seed":7,"cost_usd":0.5}"#,
    );
    write(&root.join("launch/motion/m.mp4"), b"v");
    write(&root.join("launch/motion/theme.mp3"), b"a");
    write(&root.join("logo/l.webp"), b"l");
    write(&root.join(".scripts/gen-image.sh"), b"#!/bin/sh");
    write(&root.join(".scripts/README.md"), b"gen-image");
    write(&root.join("loose.png"), b"top");
}

/// The tree follows folder.json: titles, a parent's order, counts of what
/// the viewer shows. Dot-folders are not in it.
#[test]
fn the_tree_reads_titles_order_and_counts() {
    let t = Scratch::new("tree");
    launch(&t.0);
    let tree = folder::tree(&t.0, &HashSet::new());
    let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, ["launch", "logo"], ".scripts is not a folder here");
    let l = &tree[0];
    assert_eq!(l.title, "Launch teaser");
    assert_eq!(l.n, 1, "cover.png; not brief.md, not the JSON");
    let inner: Vec<(&str, &str, usize)> = l
        .folders
        .iter()
        .map(|n| (n.rel.as_str(), n.title.as_str(), n.n))
        .collect();
    assert_eq!(
        inner,
        [("launch/stills", "Stills", 2), ("launch/motion", "", 2)]
    );
    assert_eq!(folder::loose(&t.0, &HashSet::new()), 1);

    let hid: HashSet<String> = ["logo".to_string(), "launch/stills/s01.png".to_string()].into();
    let tree = folder::tree(&t.0, &hid);
    assert_eq!(tree.len(), 1);
    assert_eq!(tree[0].folders[0].n, 1, "a hidden file is not counted");
}

/// One folder: its pictures, videos and sounds with their JSON, in its
/// order and then newest first; what it says about itself; hides left out
/// or shown marked.
#[test]
fn a_folder_reads_its_files_in_order_and_hides() {
    let t = Scratch::new("one");
    launch(&t.0);
    let none = HashSet::new();
    let f = folder::folder(&t.0, "launch/stills", &none, false).unwrap();
    assert_eq!(f.title, "Stills");
    assert_eq!(f.note, "16:9, warm dusk");
    let names: Vec<&str> = f.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["s02.png", "s01.png"], "order first");
    assert_eq!(f.items[0].info["seed"], 7);
    assert!(f.items[1].info.is_null());

    let top = folder::folder(&t.0, "launch", &none, false).unwrap();
    assert_eq!(top.picks, ["cover.png"]);
    let kinds: Vec<&str> = top.items.iter().map(|i| i.kind).collect();
    assert_eq!(kinds, ["image"], "no documents in the viewer");
    let motion = folder::folder(&t.0, "launch/motion", &none, false).unwrap();
    let mut kinds: Vec<&str> = motion.items.iter().map(|i| i.kind).collect();
    kinds.sort_unstable();
    assert_eq!(kinds, ["audio", "video"]);

    let hid: HashSet<String> = ["launch/stills/s01.png".to_string()].into();
    let f = folder::folder(&t.0, "launch/stills", &hid, false).unwrap();
    assert_eq!((f.items.len(), f.hidden), (1, 1));
    let f = folder::folder(&t.0, "launch/stills", &hid, true).unwrap();
    assert_eq!(f.items.len(), 2);
    assert!(f.items.iter().any(|i| i.hidden && i.name == "s01.png"));

    let root = folder::folder(&t.0, "", &none, false).unwrap();
    assert_eq!(root.items.len(), 1, "loose.png at the top");
    assert!(folder::folder(&t.0, "launch/cover.png", &none, false).is_err());
}

/// The spend adds every cost under the folder; the budget is the top
/// folder.json's.
#[test]
fn the_spend_adds_up_and_the_budget_is_the_tops() {
    let t = Scratch::new("spend");
    launch(&t.0);
    let s = folder::spend(&t.0, &t.0, 0);
    assert!((s - 0.54).abs() < 1e-9, "{s}");
    assert_eq!(folder::budget(&t.0), None);
    write(&t.0.join("folder.json"), br#"{"budget":2.5}"#);
    assert_eq!(folder::budget(&t.0), Some(2.5));
    write(&t.0.join("folder.json"), br#"{"budget":-1}"#);
    assert_eq!(folder::budget(&t.0), None);
}

/// ★ writes the file's name into its folder's folder.json picks, keeping
/// every other field and its order; again takes it off; a folder.json the
/// agent broke is never written over.
#[test]
fn a_star_lands_in_folder_json_and_keeps_the_rest() {
    let t = Scratch::new("pick");
    launch(&t.0);
    assert!(folder::pick(&t.0, "launch/stills/s01.png").unwrap());
    let text = std::fs::read_to_string(t.0.join("launch/stills/folder.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["picks"], serde_json::json!(["s01.png"]));
    assert_eq!(v["note"], "16:9, warm dusk");
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["title", "note", "order", "picks"]);
    assert!(!folder::pick(&t.0, "launch/stills/s01.png").unwrap());
    let v = folder::read_json(&t.0.join("launch/stills/folder.json")).unwrap();
    assert_eq!(v["picks"], serde_json::json!([]));

    // None there: made, with picks alone.
    assert!(folder::pick(&t.0, "logo/l.webp").unwrap());
    let v = folder::read_json(&t.0.join("logo/folder.json")).unwrap();
    assert_eq!(v, serde_json::json!({ "picks": ["l.webp"] }));

    write(&t.0.join("launch/motion/folder.json"), b"{ torn");
    assert!(folder::pick(&t.0, "launch/motion/m.mp4").is_err());
    assert_eq!(
        std::fs::read(t.0.join("launch/motion/folder.json")).unwrap(),
        b"{ torn"
    );
    assert!(
        folder::pick(&t.0, "launch/brief.md").is_err(),
        "not a picture"
    );
    assert!(folder::pick(&t.0, "launch").is_err());
    assert!(
        std::fs::read_dir(t.0.join("launch/stills"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".snyvi")),
        "no temporary file left"
    );
}

/// The stamp moves when a file lands, deep in a folder, or a folder.json is
/// rewritten; not otherwise.
#[test]
fn the_stamp_moves_when_the_folder_does() {
    let t = Scratch::new("stamp");
    launch(&t.0);
    let a = folder::stamp(&t.0);
    assert_eq!(a, folder::stamp(&t.0));
    write(&t.0.join("launch/stills/s03.png"), b"3");
    let b = folder::stamp(&t.0);
    assert_ne!(a, b);
    folder::pick(&t.0, "launch/stills/s03.png").unwrap();
    // A rewrite inside the same second may keep the mtime; the size moves.
    assert_ne!(b, folder::stamp(&t.0));
}

#[test]
fn nothing_is_read_outside_the_studio_folder() {
    let t = Scratch::new("escape");
    let root = t.0.join("studio");
    write(&root.join("a/in.png"), b"in");
    write(&t.0.join("secret/out.png"), b"out");
    write(&root.join("a/.hidden/x.png"), b"x");
    let root = root.canonicalize().unwrap();
    for bad in [
        "../secret/out.png",
        "/etc/passwd",
        "a/../../secret/out.png",
        "a/.hidden/x.png",
        ".scripts/gen.sh",
    ] {
        assert!(folder::resolve(&root, bad).is_err(), "{bad}");
    }
    assert!(folder::resolve(&root, "a/in.png").is_ok());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(t.0.join("secret"), root.join("a/link")).unwrap();
        std::os::unix::fs::symlink(root.join("a/in.png"), root.join("a/inside.png")).unwrap();
        assert!(folder::resolve(&root, "a/link/out.png").is_err());
        let tree = folder::tree(&root, &HashSet::new());
        assert!(
            tree[0].folders.iter().all(|n| n.name != "link"),
            "a link out is not there"
        );
        let f = folder::folder(&root, "a", &HashSet::new(), false).unwrap();
        assert!(
            f.items.iter().any(|i| i.name == "inside.png"),
            "a link that stays in is"
        );
    }
}

#[test]
fn the_tree_stops_three_deep_and_json_past_64_kb_is_missing() {
    let t = Scratch::new("deep");
    let mut p = t.0.clone();
    for i in 0..6 {
        p = p.join(format!("d{i}"));
    }
    std::fs::create_dir_all(&p).unwrap();
    let tree = folder::tree(&t.0, &HashSet::new());
    let mut depth = 0;
    let mut at = &tree;
    while let Some(n) = at.first() {
        depth += 1;
        at = &n.folders;
    }
    assert_eq!(depth, folder::TREE_DEPTH);

    let big = t.0.join("big.json");
    let mut body = b"{\"a\":\"".to_vec();
    body.extend(std::iter::repeat_n(b'x', folder::JSON_BYTES as usize));
    body.extend(b"\"}");
    std::fs::write(&big, body).unwrap();
    assert!(folder::read_json(&big).is_none());
}

#[test]
fn hides_are_kept_per_desk_and_taken_back() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE desks (id INTEGER PRIMARY KEY);")
        .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute("INSERT INTO desks(id) VALUES (1), (2)", [])
        .unwrap();
    set_hidden(&conn, 1, "a/b.png", true, 5).unwrap();
    assert!(hidden(&conn, 1).unwrap().contains("a/b.png"));
    assert!(hidden(&conn, 2).unwrap().is_empty());
    set_hidden(&conn, 1, "a/b.png", false, 6).unwrap();
    assert!(hidden(&conn, 1).unwrap().is_empty());
}

/// A studio desk pointed at another folder moves whole, and lets go of the
/// hides it had: a name in the old folder is another file in the new one.
/// Another desk's hides stay.
#[test]
fn a_new_folder_lets_go_of_the_old_ones_hides() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE desks (id INTEGER PRIMARY KEY, kind TEXT, root TEXT, boards TEXT, closed_at INTEGER DEFAULT 0);",
    )
    .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO desks(id, kind, root, boards) VALUES (1, 'studio', '/S', '/S'), (2, 'terminal', '/w', '')",
        [],
    )
    .unwrap();
    set_hidden(&conn, 1, "launch", true, 5).unwrap();
    set_hidden(&conn, 2, "x.png", true, 5).unwrap();
    assert!(move_folder(&mut conn, 1, "/T").unwrap());
    assert!(hidden(&conn, 1).unwrap().is_empty());
    assert_eq!(hidden(&conn, 2).unwrap().len(), 1);
    let (root, boards): (String, String) = conn
        .query_row("SELECT root, boards FROM desks WHERE id = 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((root.as_str(), boards.as_str()), ("/T", "/T"));
    // A terminal desk has no studio folder to move, and keeps its hides.
    assert!(!move_folder(&mut conn, 2, "/T").unwrap());
    assert_eq!(hidden(&conn, 2).unwrap().len(), 1);
}

/// The studio's news reaches the agent once: what happened after its last
/// prompt, and the selection only when it moved since.
#[test]
fn the_agent_hears_the_studio_once() {
    let live = brief::Live::default();
    live.say(1, 10, "The reader starred /S/a.png.".into());
    live.look(1, 12, "b/c.png".into());
    live.say(2, 11, "other desk".into());
    assert_eq!(
        live.since(1, 9, "/S"),
        vec![
            "The reader starred /S/a.png.".to_string(),
            "The reader is looking at /S/b/c.png.".to_string()
        ]
    );
    assert_eq!(
        live.since(1, 11, "/S"),
        vec!["The reader is looking at /S/b/c.png.".to_string()]
    );
    assert!(live.since(1, 12, "/S").is_empty());
    live.forget(1);
    assert!(live.since(1, 0, "/S").is_empty());
}

/// The block names the folder and the two sets of rules -- how to arrange
/// it, how to keep a script -- and fits its budget. Nothing of the boards
/// and pipelines it replaced is left in it.
#[test]
fn the_studio_block_says_how_to_arrange_and_when_to_script() {
    let b = brief::block("/home/u/Studio");
    assert!(b.len() <= brief::STUDIO_BYTES, "{}", b.len());
    for want in [
        "/home/u/Studio",
        "$SNYVI_STUDIO",
        "folder.json",
        "picks",
        "budget",
        ".scripts/",
        "prints only the path",
        ".scripts/README.md",
        "send_document",
        "Keys…",
        "Resume keeps",
    ] {
        assert!(b.contains(want), "{want}");
    }
    for gone in ["pipeline", "board", "awaiting_you", "approval", "stages/"] {
        assert!(!b.to_lowercase().contains(gone), "{gone}");
    }
}
