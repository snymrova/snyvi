//! Map a working directory to a project (git root or the directory itself).

use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
}

pub fn resolve(start: &Path) -> ProjectInfo {
    let start = if start.is_file() {
        start.parent().map(Path::to_path_buf).unwrap_or_else(|| start.to_path_buf())
    } else {
        start.to_path_buf()
    };
    let start = start.canonicalize().unwrap_or(start);
    let mut cur: Option<&Path> = Some(&start);
    while let Some(dir) = cur {
        if dir.join(".git").exists() {
            return ProjectInfo { root: dir.to_path_buf(), name: dir_name(dir) };
        }
        cur = dir.parent();
    }
    ProjectInfo { name: dir_name(&start), root: start }
}

fn dir_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "root".to_string())
}

/// Current branch name, if the project is a git repo. Cheap: reads .git/HEAD.
pub fn branch(root: &Path) -> Option<String> {
    let head = std::fs::read_to_string(root.join(".git/HEAD")).ok()?;
    let head = head.trim();
    head.strip_prefix("ref: refs/heads/").map(str::to_string)
        .or_else(|| Some(head.chars().take(8).collect()))
}
