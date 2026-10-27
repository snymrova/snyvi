use super::*;
use crate::store::tempdir::Dir;

fn put(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A home and a project, each with its `.claude`.
fn two_homes(tag: &str) -> (Dir, Dir) {
    (
        Dir::new(&format!("snyvi-places-home-{tag}")),
        Dir::new(&format!("snyvi-places-proj-{tag}")),
    )
}

fn at<'a>(home: &Dir, proj: &'a Dir) -> Roots<'a> {
    Roots {
        home: Some(home.path.clone()),
        root: &proj.path,
    }
}

fn one(r: Resolved) -> Place {
    match r {
        Resolved::One(p) => p,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_name_resolves_in_claude_codes_documented_order() {
    let (h, p) = two_homes("order");
    let (hc, pc) = (h.path.join(".claude"), p.path.join(".claude"));
    put(&pc.join("commands/news.md"), "# Project command");
    assert_eq!(
        one(resolve_at(&at(&h, &p), "news")).file,
        ".claude/commands/news.md"
    );
    // A skill beats a command file.
    put(
        &pc.join("skills/news/SKILL.md"),
        "---\ndescription: Project skill\n---\nbody",
    );
    let s = one(resolve_at(&at(&h, &p), "news"));
    assert_eq!(
        (s.file.as_str(), s.kind, s.who),
        (".claude/skills/news/SKILL.md", Kind::Skill, Who::Project)
    );
    assert_eq!(s.about, "Project skill");
    assert_eq!(s.tag(), "project · skill");
    // The reader's skill beats both.
    put(&hc.join("skills/news/SKILL.md"), "# Mine");
    assert_eq!(
        one(resolve_at(&at(&h, &p), "news")).file,
        "~/.claude/skills/news/SKILL.md"
    );
    // Nothing anywhere: the reader's words.
    assert_eq!(resolve_at(&at(&h, &p), "open"), Resolved::Words);
    assert_eq!(resolve_at(&at(&h, &p), "a:b"), Resolved::Words);
}

#[test]
fn the_one_pair_the_docs_leave_open_is_two() {
    let (h, p) = two_homes("two");
    put(&h.path.join(".claude/commands/bench.md"), "# Mine");
    put(&p.path.join(".claude/skills/bench/SKILL.md"), "# Theirs");
    match resolve_at(&at(&h, &p), "bench") {
        Resolved::Two(a, b) => {
            assert_eq!(a.file, "~/.claude/commands/bench.md");
            assert_eq!(b.file, ".claude/skills/bench/SKILL.md");
        }
        other => panic!("{other:?}"),
    }
    // The reader's command over the project's command is documented.
    put(&p.path.join(".claude/commands/tick.md"), "# Theirs");
    put(&h.path.join(".claude/commands/tick.md"), "# Mine");
    assert_eq!(one(resolve_at(&at(&h, &p), "tick")).who, Who::You);
}

#[test]
fn a_skill_answers_to_its_name_and_its_folder_and_a_hidden_one_to_none() {
    let (h, p) = two_homes("names");
    let sk = p.path.join(".claude/skills");
    put(
        &sk.join("x/SKILL.md"),
        "---\nname: yname\ndescription: says a fruit\n---\nReply.",
    );
    put(
        &sk.join("quiet/SKILL.md"),
        "---\nuser-invocable: false\n---\nBackground.",
    );
    put(&p.path.join(".claude/commands/sub/deep.md"), "# Nested");
    put(&p.path.join(".claude/commands/notes.txt"), "not a command");
    let r = at(&h, &p);
    assert_eq!(one(resolve_at(&r, "yname")).name, "yname");
    assert_eq!(one(resolve_at(&r, "x")).name, "yname");
    assert_eq!(resolve_at(&r, "quiet"), Resolved::Words);
    let names: Vec<String> = list_at(&r).into_iter().map(|p| p.name).collect();
    assert_eq!(
        names,
        ["yname"],
        "one entry a skill, no hidden one, no subfolder"
    );
}

#[test]
fn the_list_puts_the_project_first_and_each_name_once() {
    let (h, p) = two_homes("list");
    put(&h.path.join(".claude/skills/alpha/SKILL.md"), "# Mine");
    put(&h.path.join(".claude/commands/zed.md"), "# Mine too");
    put(&p.path.join(".claude/commands/zed.md"), "# Theirs");
    put(&p.path.join(".claude/commands/news.md"), "# The newsroom");
    let v = list_at(&at(&h, &p));
    let got: Vec<(String, Who)> = v.iter().map(|p| (p.name.clone(), p.who)).collect();
    assert_eq!(
        got,
        [
            ("news".to_string(), Who::Project),
            ("alpha".to_string(), Who::You),
            ("zed".to_string(), Who::You)
        ]
    );
    assert_eq!(v[0].about, "The newsroom");
}

#[test]
fn the_list_is_read_again_when_a_folder_moves() {
    let (h, p) = two_homes("cache");
    let cmds = p.path.join(".claude/commands");
    put(&cmds.join("a.md"), "# A");
    assert_eq!(list_at(&at(&h, &p)).len(), 1);
    // A folder's time is kept to the second on some filesystems.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    put(&cmds.join("b.md"), "# B");
    assert_eq!(list_at(&at(&h, &p)).len(), 2);
}

#[test]
fn a_skill_folder_is_hashed_whole_and_a_large_one_by_its_skill_md() {
    let (h, p) = two_homes("hash");
    let dir = p.path.join(".claude/skills/pub");
    put(&dir.join("SKILL.md"), "# Publish");
    put(&dir.join("scripts/publish.py"), "print(1)");
    let place = one(resolve_at(&at(&h, &p), "pub"));
    let first = hash(&place).unwrap();
    put(&dir.join("scripts/publish.py"), "print(2)");
    assert_ne!(
        hash(&place).unwrap(),
        first,
        "a script changed is a skill changed"
    );
    assert!(!large(&place));
    for i in 0..=FOLDER_FILES {
        put(&dir.join(format!("data/{i}.txt")), "x");
    }
    assert!(large(&place));
    assert_eq!(
        hash(&place).unwrap(),
        blake3::hash(b"# Publish").to_hex().to_string()
    );
    // Read again from what a routine keeps.
    let again = from_file(&p.path, ".claude/skills/pub/SKILL.md").unwrap();
    assert_eq!((again.kind, again.who), (Kind::Skill, Who::Project));
    assert!(from_file(&p.path, ".claude/commands/gone.md").is_none());
}

/// An entry that comes and goes within one tick of the folder's clock
/// leaves its time where it was (Windows' is about 15 ms): the list is read
/// again all the same, because the names moved.
#[cfg(unix)]
#[test]
fn a_command_gone_within_one_tick_is_gone_from_the_list() {
    let (h, p) = two_homes("tick");
    let cmds = p.path.join(".claude/commands");
    put(&cmds.join("news.md"), "# News");
    let at_ = at(&h, &p);
    assert_eq!(one(resolve_at(&at_, "news")).name, "news");
    let then = std::fs::metadata(&cmds).unwrap().modified().unwrap();
    std::fs::remove_file(cmds.join("news.md")).unwrap();
    // The folder's time put back, as one tick of a coarse clock would leave it.
    std::fs::File::open(&cmds)
        .unwrap()
        .set_modified(then)
        .unwrap();
    assert_eq!(std::fs::metadata(&cmds).unwrap().modified().unwrap(), then);
    assert_eq!(resolve_at(&at_, "news"), Resolved::Words);
}
