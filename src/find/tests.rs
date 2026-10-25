use super::*;
use crate::store::tempdir::Dir;
use std::fs;

fn touch(root: &Path, rel: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, b"x").unwrap();
}

/// Past `RACY`, so the directories just made are trusted by their times.
fn settle() {
    std::thread::sleep(Duration::from_millis(150));
}

fn want(p: &Path, label: &str, key: Key) -> Want {
    Want {
        path: p.to_path_buf(),
        label: label.into(),
        key,
    }
}

fn rels(h: &[Hit]) -> Vec<&str> {
    h.iter().map(|h| h.rel.as_str()).collect()
}

const PATHS: [&str; 12] = [
    "README.md",
    "site/README.md",
    "ui/desk/06-rail.js",
    "ui/app.css",
    "node_modules/caniuse-lite/data/features/css-appearance.js",
    "app/globals.css",
    "docs/DIAGRAMS.md",
    "docs/architecture-diagrams.md",
    "src/main.rs",
    "src/mcp/main_loop.rs",
    "bench/seed/plan.md",
    "ui/mmd.js",
];

#[test]
fn ranks_names_before_paths_and_junk_last() {
    let f = Finder::from_paths("snyvi", PATHS);
    let first = |q: &str| f.search(q, None, 6).unwrap().first().map(|h| h.rel.clone());
    assert_eq!(first("readme").as_deref(), Some("README.md"));
    assert_eq!(first("diagrams").as_deref(), Some("docs/DIAGRAMS.md"));
    assert_eq!(first("src main").as_deref(), Some("src/main.rs"));
    assert_eq!(first("mmd").as_deref(), Some("ui/mmd.js"));
    // The letters in order, when nothing holds the word as written.
    assert_eq!(first("dskrail").as_deref(), Some("ui/desk/06-rail.js"));
    let css = f.search("app css", None, 6).unwrap();
    assert_eq!(css[0].rel, "ui/app.css");
    assert_eq!(
        rels(&css),
        [
            "ui/app.css",
            "app/globals.css",
            "node_modules/caniuse-lite/data/features/css-appearance.js"
        ],
        "a committed node_modules ranks under the rest"
    );
    assert!(f.search("zzqx", None, 6).unwrap().is_empty());
    let h = &f.search("06-rail", None, 6).unwrap()[0];
    assert_eq!(
        (h.name.as_str(), h.dir.as_str(), h.under.as_str()),
        ("06-rail.js", "ui/desk", "snyvi")
    );
    assert_eq!(h.root.as_deref(), Some("snyvi"));
}

#[test]
fn nothing_before_the_first_walk() {
    assert!(Finder::new().search("readme", None, 6).is_none());
}

#[test]
fn typing_narrows_to_the_same_list_a_whole_search_gives() {
    let mut paths: Vec<String> = PATHS.iter().map(|p| p.to_string()).collect();
    for i in 0..3000 {
        paths.push(format!("pkg{}/src/mod_{i}/diag_{}.rs", i % 40, i % 7));
        paths.push(format!("pkg{}/docs/main-{i}.md", i % 13));
    }
    let typed = Finder::from_paths("x", paths.iter().map(String::as_str));
    for word in ["diagrams", "src main", "dskrail"] {
        for i in 1..=word.len() {
            let q = &word[..i];
            let narrowed = typed.search(q, None, 6).unwrap();
            let whole = Finder::from_paths("x", paths.iter().map(String::as_str))
                .search(q, None, 6)
                .unwrap();
            assert_eq!(narrowed, whole, "{q:?}");
        }
    }
}

#[test]
fn a_refresh_lists_again_only_what_changed() {
    let d = Dir::new("snyvi-find");
    let root = d.path.canonicalize().unwrap();
    touch(&root, "docs/plan-x.md");
    touch(&root, "src/a.rs");
    touch(&root, "build/plan-x.md");
    touch(&root, ".hidden/plan-x.md");
    fs::write(root.join(".gitignore"), "build/\n").unwrap();
    settle();
    let f = Finder::new();
    let wants = || vec![want(&root, "proj", Key::Desk(1))];
    assert_eq!(
        f.refresh(wants(), vec![]),
        Refreshed {
            walked: 1,
            relisted: 0
        }
    );
    let hits = f.search("plan-x", None, 6).unwrap();
    assert_eq!(
        rels(&hits),
        ["docs/plan-x.md"],
        "ignored and hidden files stay out"
    );
    assert_eq!((hits[0].desk, hits[0].under.as_str()), (Some(1), "proj"));

    // Nothing moved: nothing listed.
    assert_eq!(f.refresh(wants(), vec![]), Refreshed::default());

    touch(&root, "docs/new-file.md");
    assert_eq!(f.refresh(wants(), vec![]).relisted, 1);
    assert_eq!(
        rels(&f.search("new-file", None, 6).unwrap()),
        ["docs/new-file.md"]
    );

    fs::remove_file(root.join("docs/plan-x.md")).unwrap();
    f.refresh(wants(), vec![]);
    assert!(f.search("plan-x", None, 6).unwrap().is_empty());

    // A new directory is walked; a directory gone takes its files with it.
    touch(&root, "notes/deep/plan-y.md");
    fs::remove_dir_all(root.join("src")).unwrap();
    let r = f.refresh(wants(), vec![]);
    assert_eq!(r.walked, 0);
    assert_eq!(
        rels(&f.search("plan-y", None, 6).unwrap()),
        ["notes/deep/plan-y.md"]
    );
    assert!(f.search("a.rs", None, 6).unwrap().is_empty());

    // An ignore file that changed walks the folder again.
    settle();
    fs::write(root.join(".gitignore"), "build/\nnotes/\n").unwrap();
    assert_eq!(f.refresh(wants(), vec![]).walked, 1);
    assert!(f.search("plan-y", None, 6).unwrap().is_empty());

    // A folder no longer wanted is dropped.
    f.refresh(vec![], vec![]);
    assert!(f.search("new-file", None, 6).unwrap().is_empty());
}

#[test]
fn each_folder_once_this_desk_first_and_never_home() {
    let d = Dir::new("snyvi-find");
    let root = d.path.canonicalize().unwrap();
    touch(&root, "a/notes.md");
    touch(&root, "sub/notes.md");
    let sub = root.join("sub");
    let home = dirs::home_dir().unwrap();
    let got = folders(vec![
        want(&root, "desk", Key::Desk(1)),
        want(&sub, "open", Key::Root("r1".into())),
        want(&root, "open too", Key::Root("r2".into())),
        want(&home, "home", Key::Desk(9)),
    ]);
    assert_eq!(
        got.len(),
        1,
        "a folder inside another, and the home folder, are not searched apart"
    );
    assert_eq!(
        got[0].key,
        Key::Root("r2".into()),
        "an open folder wins over a desk on the same one"
    );

    let f = Finder::new();
    f.refresh(
        vec![
            want(&root, "desk", Key::Desk(1)),
            want(&sub, "open", Key::Root("r1".into())),
        ],
        vec![(1, root.clone()), (3, sub.clone())],
    );
    let all = f.search("notes", None, 6).unwrap();
    assert_eq!(rels(&all), ["a/notes.md", "sub/notes.md"], "each file once");
    assert_eq!(
        f.search("notes", Some(3), 6).unwrap()[0].rel,
        "sub/notes.md"
    );
}

#[test]
fn opening_stays_inside_the_desks_folder() {
    let d = Dir::new("snyvi-find");
    let root = d.path.canonicalize().unwrap();
    touch(&root, "docs/plan.md");
    touch(&root, "../snyvi-find-outside.md");
    let (base, file) = inside(&root, "docs/plan.md").unwrap();
    assert_eq!((base, file), (root.clone(), root.join("docs/plan.md")));
    for bad in [
        "../snyvi-find-outside.md",
        "/etc/passwd",
        "docs/../../x",
        "",
        "docs",
        "docs/nope.md",
    ] {
        assert!(inside(&root, bad).is_none(), "{bad:?}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/hostname", root.join("out")).unwrap();
        assert!(inside(&root, "out").is_none(), "a link that points out");
    }
    assert!(
        inside(&dirs::home_dir().unwrap(), "x").is_none(),
        "never the home folder"
    );
    let _ = fs::remove_file(root.parent().unwrap().join("snyvi-find-outside.md"));
}
