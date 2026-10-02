//! A path the reader Ctrl-clicked, in a panel or in something being read.
//!
//! The page sends the word under the pointer and where it was; the server
//! turns "where" into the folders a relative path could mean, in order, and
//! this turns the word into a file or a folder that is there. Nothing here
//! opens, runs or reads anything: it asks the filesystem whether a path
//! exists, and a word that names nothing is no path at all.

use std::path::{Path, PathBuf};

/// The longest word worth asking about. A path longer than this is not one a
/// person reads in a terminal line and clicks.
const LONGEST: usize = 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub path: PathBuf,
    pub dir: bool,
    /// The line a `:120` after the word pointed at, from 1.
    pub line: Option<u32>,
}

/// The path in a word and the line after it: `src/app.js:120:5` is
/// `src/app.js` at line 120. The column is dropped: the reader goes to lines.
fn split_line(word: &str) -> (&str, Option<u32>) {
    let num = |s: &str| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit());
    let mut path = word;
    let mut line = None;
    // `path:line:col`, then `path:line`.
    if let Some((head, col)) = path.rsplit_once(':') {
        if num(col) {
            if let Some((p, l)) = head.rsplit_once(':') {
                if num(l) {
                    path = p;
                    line = l.parse().ok();
                }
            }
            if line.is_none() {
                path = head;
                line = col.parse().ok();
            }
        }
    }
    (path, line.filter(|l| *l > 0))
}

/// The file or folder `word` names, tried against each base in turn. A path
/// that is absolute or starts at `~` needs no base. `None` when the word
/// names nothing that exists.
pub fn find(word: &str, bases: &[PathBuf], home: Option<&Path>) -> Option<Found> {
    let word = word.trim();
    if word.is_empty() || word.len() > LONGEST || word.chars().any(char::is_control) {
        return None;
    }
    // A path that has a colon in its name is still itself: the word as it is
    // is tried after the one with its line taken off.
    let (path, line) = split_line(word);
    for (p, line) in [(path, line), (word, None)] {
        if p.is_empty() {
            continue;
        }
        for at in candidates(p, bases, home) {
            if let Ok(canon) = at.canonicalize() {
                let dir = canon.is_dir();
                return Some(Found {
                    path: canon,
                    dir,
                    line: if dir { None } else { line },
                });
            }
        }
        if line.is_none() {
            break;
        }
    }
    None
}

/// Where a path might be, most likely first.
fn candidates(p: &str, bases: &[PathBuf], home: Option<&Path>) -> Vec<PathBuf> {
    if p == "~" {
        return home.map(Path::to_path_buf).into_iter().collect();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home.map(|h| h.join(rest)).into_iter().collect();
    }
    let path = Path::new(p);
    if path.is_absolute() {
        return vec![path.to_path_buf()];
    }
    bases.iter().map(|b| b.join(path)).collect()
}

/// Of the folders already open for reading, the one `path` sits deepest in,
/// and the path inside it -- so a file opens under the folder the reader is
/// already browsing, and not under a new row. `roots` is `(id, folder)`.
pub fn under<'a>(path: &Path, roots: &'a [(String, PathBuf)]) -> Option<(&'a str, String)> {
    roots
        .iter()
        .filter_map(|(id, root)| {
            let rest = path.strip_prefix(root).ok()?;
            Some((id.as_str(), root, rest))
        })
        .max_by_key(|(_, root, _)| root.components().count())
        .map(|(id, _, rest)| (id, rest.to_string_lossy().replace('\\', "/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::store::tempdir::Dir;

    struct T(Dir);
    impl T {
        fn path(&self) -> &Path {
            &self.0.path
        }
    }

    fn tree() -> T {
        let t = T(Dir::new("snyvi-resolve"));
        std::fs::create_dir_all(t.path().join("desk/src")).unwrap();
        std::fs::create_dir_all(t.path().join("desk/sub")).unwrap();
        std::fs::create_dir_all(t.path().join("home/.claude")).unwrap();
        std::fs::write(t.path().join("desk/src/app.js"), "x").unwrap();
        std::fs::write(t.path().join("desk/README.md"), "x").unwrap();
        std::fs::write(t.path().join("desk/sub/README.md"), "x").unwrap();
        std::fs::write(t.path().join("home/.claude/settings.json"), "{}").unwrap();
        t
    }

    #[test]
    fn a_line_after_the_path_is_the_line_and_a_column_is_dropped() {
        assert_eq!(split_line("src/app.js:120"), ("src/app.js", Some(120)));
        assert_eq!(split_line("src/app.js:120:5"), ("src/app.js", Some(120)));
        assert_eq!(split_line("src/app.js"), ("src/app.js", None));
        assert_eq!(split_line("src/app.js:"), ("src/app.js:", None));
        assert_eq!(split_line("src/app.js:0"), ("src/app.js", None));
        assert_eq!(split_line("C:/x"), ("C:/x", None));
    }

    #[test]
    fn the_bases_are_tried_in_order_and_only_what_exists_is_a_path() {
        let t = tree();
        let desk = t.path().join("desk").canonicalize().unwrap();
        let sub = desk.join("sub");
        let bases = [sub.clone(), desk.clone()];
        // The panel's folder first: its README, not the desk's.
        let f = find("README.md", &bases, None).unwrap();
        assert_eq!(f.path, sub.join("README.md"));
        // Not in the panel's folder, so the desk's.
        let f = find("src/app.js:12:3", &bases, None).unwrap();
        assert_eq!(
            (f.path, f.dir, f.line),
            (desk.join("src/app.js"), false, Some(12))
        );
        assert_eq!(find("src/nope.js", &bases, None), None);
        assert_eq!(find("", &bases, None), None);
        assert_eq!(find("a\nb", &bases, None), None);
    }

    #[test]
    fn a_folder_has_no_line_and_a_name_with_a_colon_is_still_found() {
        let t = tree();
        let desk = t.path().join("desk").canonicalize().unwrap();
        let f = find("src", &[desk.clone()], None).unwrap();
        assert!(f.dir && f.line.is_none());
        let f = find("./src/", &[desk.clone()], None).unwrap();
        assert_eq!(f.path, desk.join("src"));
        // Not a name Windows allows.
        #[cfg(unix)]
        {
            std::fs::write(desk.join("a:12"), "x").unwrap();
            let f = find("a:12", &[desk.clone()], None).unwrap();
            assert_eq!((f.path, f.line), (desk.join("a:12"), None));
        }
    }

    #[test]
    fn home_and_absolute_paths_need_no_base() {
        let t = tree();
        let home = t.path().join("home").canonicalize().unwrap();
        let f = find("~/.claude/settings.json", &[], Some(&home)).unwrap();
        assert_eq!(f.path, home.join(".claude/settings.json"));
        assert!(find("~", &[], Some(&home)).unwrap().dir);
        assert_eq!(find("~/.claude/x", &[], Some(&home)), None);
        let abs = home.join(".claude/settings.json");
        assert_eq!(find(abs.to_str().unwrap(), &[], None).unwrap().path, abs);
        // A base is not needed, and not used: an absolute path is itself.
        assert_eq!(find("/no/such/snyvi/path", &[home.clone()], None), None);
    }

    #[test]
    fn a_file_opens_under_the_deepest_folder_already_open() {
        let roots = vec![
            ("a".to_string(), PathBuf::from("/w")),
            ("b".to_string(), PathBuf::from("/w/snyvi")),
            ("c".to_string(), PathBuf::from("/other")),
        ];
        assert_eq!(
            under(Path::new("/w/snyvi/src/app.js"), &roots),
            Some(("b", "src/app.js".to_string()))
        );
        assert_eq!(
            under(Path::new("/w/x.md"), &roots),
            Some(("a", "x.md".to_string()))
        );
        assert_eq!(under(Path::new("/elsewhere/x.md"), &roots), None);
    }
}
