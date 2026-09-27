//! Map a working directory to a project (git root or the directory itself).

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
}

pub fn resolve(start: &Path) -> ProjectInfo {
    let start = if start.is_file() {
        start
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| start.to_path_buf())
    } else {
        start.to_path_buf()
    };
    let start = start.canonicalize().unwrap_or(start);
    let mut cur: Option<&Path> = Some(&start);
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return ProjectInfo {
                root: dir.to_path_buf(),
                name: dir_name(dir),
            };
        }
        cur = dir.parent();
    }
    ProjectInfo {
        name: dir_name(&start),
        root: start,
    }
}

fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string())
}

/// The branch a folder is on, found by walking up to the repository it is in.
///
/// The same read a pane's prompt does in the shell's own builtins (see
/// `crate::prompt`), for the callers that are not a shell: the pane header,
/// which is how a pane running `cmd.exe`, or a shell snyvi has no dressing
/// for, still says which branch it is on. No process.
pub fn head_of(dir: &Path) -> Option<String> {
    let mut cur: Option<&Path> = Some(dir);
    let root = loop {
        let d = cur?;
        if d.join(".git").exists() {
            break d;
        }
        cur = d.parent();
    };
    let dot = root.join(".git");
    // A worktree or a submodule keeps .git as a file naming the real one.
    let git = if dot.is_file() {
        let line = std::fs::read_to_string(&dot).ok()?;
        let named = Path::new(line.trim().strip_prefix("gitdir: ")?).to_path_buf();
        if named.is_absolute() {
            named
        } else {
            root.join(named)
        }
    } else {
        dot
    };
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    Some(
        head.strip_prefix("ref: refs/heads/")
            .map(str::to_string)
            .unwrap_or_else(|| head.chars().take(8).collect()),
    )
}

/// Whether the tree has changes -- the one part of this that git alone can
/// answer, and the reason it is here rather than in a prompt: it runs a
/// process, so the daemon does it on its own tick and a prompt never waits
/// for it. Untracked files do not count; they are not changes to a branch.
pub fn modified(dir: &Path) -> Option<bool> {
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--untracked-files=no",
    ])
    .current_dir(dir)
    .stderr(std::process::Stdio::null());
    // The daemon has no console on Windows, so a console program it runs is
    // given one of its own: a window flashed up on every tick, for every
    // folder a panel works in.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::platform::CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    out.status.success().then_some(!out.stdout.is_empty())
}

/// Current branch name, if the project is a git repo. Cheap: reads .git/HEAD.
pub fn branch(root: &Path) -> Option<String> {
    let head = std::fs::read_to_string(root.join(".git/HEAD")).ok()?;
    let head = head.trim();
    head.strip_prefix("ref: refs/heads/")
        .map(str::to_string)
        .or_else(|| Some(head.chars().take(8).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_branch_is_read_from_a_folder_inside_the_repository() {
        let dir = crate::store::tempdir::Dir::new("snyvi-head");
        let deep = dir.path.join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(dir.path.join(".git")).unwrap();
        std::fs::write(
            dir.path.join(".git/HEAD"),
            "ref: refs/heads/claude/snappy-reading\n",
        )
        .unwrap();
        assert_eq!(head_of(&deep).as_deref(), Some("claude/snappy-reading"));
    }

    #[test]
    fn a_detached_head_is_the_commit_it_is_on() {
        let dir = crate::store::tempdir::Dir::new("snyvi-head");
        std::fs::create_dir_all(dir.path.join(".git")).unwrap();
        std::fs::write(
            dir.path.join(".git/HEAD"),
            "9adceca1234567890abcdef1234567890abcdef1\n",
        )
        .unwrap();
        assert_eq!(head_of(&dir.path).as_deref(), Some("9adceca1"));
    }

    #[test]
    fn a_worktree_keeps_git_as_a_file_naming_the_real_one() {
        let dir = crate::store::tempdir::Dir::new("snyvi-head");
        let real = dir.path.join("store/worktrees/one");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/side\n").unwrap();
        let tree = dir.path.join("tree");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();
        assert_eq!(head_of(&tree).as_deref(), Some("side"));
    }

    #[test]
    fn a_folder_outside_any_repository_is_on_no_branch() {
        let dir = crate::store::tempdir::Dir::new("snyvi-head");
        // /tmp is not a repository; neither is a fresh folder under it.
        assert_eq!(head_of(&dir.path), None);
    }
}
