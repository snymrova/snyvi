//! Studio desks: a studio folder drawn as a viewer, its folders in the
//! rail, with one Claude panel docked under it.
//!
//! One sentence holds the design: the folder is files the agent writes, and
//! snyvi reads them. snyvi calls no model and runs no script -- what makes
//! an image is the agent's own tools in its panel, and the scripts it keeps
//! in `.scripts/` for the calls it repeats. Into the folder snyvi writes
//! only the reader's ★ (`folder::pick`); a hide is snyvi's own word, in its
//! own table, never in the reader's files.
//!
//! The folder is the reader's, picked when the desk is made (`~/Studio` is
//! offered), anywhere on disk. snyvi never looks through the home folder
//! for one. There is one studio desk.

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub mod brief;
pub mod folder;

/// A studio desk's rows. Each names the desk it belongs to and goes with it
/// (`ON DELETE CASCADE`); a closed desk's rows wait for `prune` with the
/// desk, as its notes do.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS board_hidden (
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  rel TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (desk_id, rel)
);
"#;

/// The command a studio desk's panel starts: Claude, in the studio folder,
/// so its trust prompt names that folder and it needs no `--add-dir`.
pub const AGENT_CMD: &str = "claude";

/// The folder New studio desk offers: `~/Studio`, made only when the reader
/// makes the desk on it.
pub fn offered(home: &Path) -> PathBuf {
    home.join("Studio")
}

/// A folder the reader named as a studio folder: absolute, there, and a
/// folder. Symlinks are followed once, here, so what is stored is where the
/// files really are -- the containment checks on every read compare against
/// this.
pub fn folder_ok(path: &str) -> Result<PathBuf> {
    let p = Path::new(path.trim());
    if !p.is_absolute() {
        bail!("a studio folder is an absolute path");
    }
    let real = p
        .canonicalize()
        .with_context(|| format!("{} is not there", p.display()))?;
    if !real.is_dir() {
        bail!("{} is not a folder", p.display());
    }
    Ok(real)
}

/// The studio folder for a new desk: `path` as it is, or made when only its
/// last part is missing -- the folder the reader named, never a chain of
/// them, so a typo cannot plant folders across the disk.
pub fn make_folder(path: &str) -> Result<PathBuf> {
    let p = Path::new(path.trim());
    if !p.is_absolute() {
        bail!("a studio folder is an absolute path");
    }
    if !p.exists() {
        let parent = p
            .parent()
            .filter(|q| q.is_dir())
            .with_context(|| format!("{} is not there", p.parent().unwrap_or(p).display()))?;
        let name = p.file_name().map(|n| n.to_string_lossy().to_string());
        if name.as_deref().is_none_or(|n| n.starts_with('.')) {
            bail!("{} is not a folder name", p.display());
        }
        std::fs::create_dir(parent.join(name.unwrap_or_default()))
            .with_context(|| format!("making {}", p.display()))?;
    }
    folder_ok(path)
}

/// Whether a studio panel's kept command is one snyvi gave it, from an
/// older build that named the folders with `--add-dir`: it starts as
/// `AGENT_CMD` now.
pub fn stale_cmd(cmd: &str) -> bool {
    let c = cmd.trim();
    c.is_empty() || c == AGENT_CMD || c.starts_with("claude --add-dir ")
}

/// What the reader hid on a studio desk: studio-relative names.
/// Hidden, never deleted -- the file is the reader's and stays where it is;
/// a hide is snyvi's word on what to draw, and Undo takes it back.
pub fn hidden(conn: &Connection, desk_id: i64) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT rel FROM board_hidden WHERE desk_id = ?1")?;
    let out = stmt
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(out)
}

/// Hide `rel` on a studio desk, or show it again.
pub fn set_hidden(conn: &Connection, desk_id: i64, rel: &str, hide: bool, now: i64) -> Result<()> {
    if hide {
        conn.execute(
            "INSERT OR REPLACE INTO board_hidden(desk_id, rel, hidden_at) VALUES(?1, ?2, ?3)",
            params![desk_id, rel, now],
        )?;
    } else {
        conn.execute(
            "DELETE FROM board_hidden WHERE desk_id = ?1 AND rel = ?2",
            params![desk_id, rel],
        )?;
    }
    Ok(())
}

/// Point studio desk `desk_id` at `folder`, and let go of what was hidden
/// in the old one: hides are names inside a folder, and the same name in
/// the new one is another file. False when the desk is no studio desk.
pub fn move_folder(conn: &mut Connection, desk_id: i64, folder: &str) -> Result<bool> {
    let tx = conn.transaction()?;
    if !crate::desk::set_boards(&tx, desk_id, folder)? {
        return Ok(false);
    }
    tx.execute(
        "DELETE FROM board_hidden WHERE desk_id = ?1",
        params![desk_id],
    )?;
    tx.commit()?;
    Ok(true)
}

#[cfg(test)]
mod tests;
