//! Desks: a named workspace rooted at a folder, holding up to four panes in a
//! fixed two-column grid.
//!
//! A desk is not a document, and this is the file that makes that true. It has
//! its own tables and its own id space, so it is absent from the tree, the
//! inbox, the queue and search by construction rather than by a condition some
//! later query could forget. Give a desk a document id and "the library is
//! everything an agent sent you" stops being a sentence anyone can say.
//!
//! Two things are persisted and one is not. The workspace -- which folder,
//! which slots, what to re-run -- is here, because that is what a restore needs
//! and a restore is the point. The process is not: a pane comes back stopped,
//! with `Start` offered, and nothing on this machine ever spawns a shell
//! because a daemon woke up. The screen and the PTY that Phase 3 adds are
//! in-memory beside these rows and die with the daemon, which is why a pane row
//! carries no state column at all.
//!
//! The two caps are the budget, not a preference. `docs/BRAINSTORM.md:31` sets
//! 60 MB resident and `:549` records 40 MB today, so there are 20 MB to spend.
//! A truecolor cell is about 11 bytes, so a 2 MB scrollback is roughly 900 rows
//! at 200 columns, and eight of those is a 16 MB ceiling that fits. Four panes
//! per desk bounds nothing once desks are unbounded -- the global cap is the
//! line that holds, and it is the one worth writing a test about.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How many panes one desk holds. Two columns, two rows, and the third pane
/// spans the bottom rather than leaving a hole beside it.
pub const PER_DESK: i64 = 4;

/// How many panes exist at once, across every desk. This is the number the
/// memory budget is written against.
pub const EVERYWHERE: i64 = 8;

/// A divider never goes so far that the pane beside it is a sliver. The
/// fraction is of the axis it splits, so these are the two ends of the drag.
const MIN_FRACTION: f64 = 0.15;
const MAX_FRACTION: f64 = 0.85;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS desks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  col REAL NOT NULL DEFAULT 0.5,
  row REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  cmd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(desk_id, slot)
);
CREATE INDEX IF NOT EXISTS panes_desk ON panes(desk_id, slot);
"#;

/// A desk as the sidebar lists it and the view draws it: a name, the folder it
/// is rooted at, the two divider fractions that are the whole of its geometry,
/// and what is in its slots.
#[derive(Clone, Debug, Serialize)]
pub struct Desk {
    pub id: i64,
    pub name: String,
    pub root: String,
    /// Where the vertical divider sits, as a fraction of the width.
    pub col: f64,
    /// Where the horizontal divider sits, as a fraction of the height.
    pub row: f64,
    pub created_at: i64,
    pub panes: Vec<Pane>,
}

/// A pane, which in this phase is a workspace row and no process.
///
/// The id is 16 bytes of hex because it is the value `SNYVI_SESSION` will carry
/// into the child's environment in Phase 3: it leaves the daemon, so it is
/// unguessable rather than sequential. A desk's id never leaves this machine's
/// own UI, so it is an integer, like a project's.
#[derive(Clone, Debug, Serialize)]
pub struct Pane {
    pub id: String,
    /// 1 to `PER_DESK`. Slots, not splits: the grid is fixed.
    pub slot: i64,
    pub cwd: String,
    /// What to re-run when the reader asks for it. Empty means the shell.
    pub cmd: String,
    pub created_at: i64,
}

/// Where a document came from, when it came from a pane: the desk and the
/// slot, which is what the reader sees -- `snyvi [1]` -- and what the link in
/// the document's meta opens. Copied onto the document when it arrives rather
/// than looked up when it is read, so a document keeps saying where it came
/// from after the pane or the desk is gone.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Origin {
    pub id: i64,
    pub name: String,
    pub slot: i64,
}

/// A pane with the desk it is on, for the things that need both: starting it,
/// which needs the folder and the name, and naming a document it sent.
#[derive(Clone, Debug)]
pub struct Placed {
    pub pane: Pane,
    pub desk_id: i64,
    pub desk_name: String,
    pub root: String,
}

/// What came of asking for a pane.
///
/// The two refusals are separate because the sentence a reader gets is
/// different: one says this desk is full and a second desk would take the next
/// pane, the other says snyvi is full and something has to be closed first.
/// Collapsing them would make the first look like the second.
#[derive(Debug)]
pub enum Opened {
    Pane(Pane),
    DeskFull,
    NoRoomLeft,
    NoSuchDesk,
}

/// Every desk, oldest first, each with its panes in slot order.
///
/// Two queries rather than a join with a row per pane: a desk with no panes is
/// a real and common state -- it is what every desk is for the moment after it
/// is made -- and it should not need a left join to survive the trip.
pub fn list(conn: &Connection) -> Result<Vec<Desk>> {
    let mut stmt =
        conn.prepare("SELECT id, name, root, col, row, created_at FROM desks ORDER BY id")?;
    let mut desks: Vec<Desk> = stmt
        .query_map([], row_to_desk)?
        .collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT desk_id, id, slot, cwd, cmd, created_at FROM panes ORDER BY desk_id, slot",
    )?;
    let panes: Vec<(i64, Pane)> = stmt
        .query_map([], |r| Ok((r.get(0)?, row_to_pane(r, 1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (desk_id, pane) in panes {
        if let Some(d) = desks.iter_mut().find(|d| d.id == desk_id) {
            d.panes.push(pane);
        }
    }
    Ok(desks)
}

/// One desk, with its panes, or nothing if that id is not a desk's.
pub fn get(conn: &Connection, id: i64) -> Result<Option<Desk>> {
    let Some(mut desk) = conn
        .query_row(
            "SELECT id, name, root, col, row, created_at FROM desks WHERE id = ?1",
            params![id],
            row_to_desk,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT id, slot, cwd, cmd, created_at FROM panes WHERE desk_id = ?1 ORDER BY slot",
    )?;
    desk.panes = stmt
        .query_map(params![id], |r| row_to_pane(r, 0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(desk))
}

/// A new desk on a folder.
///
/// Two desks on one folder is a workflow and not a mistake -- the first holds
/// the agent and its tests, the second holds the chores -- so the root is not
/// unique and nothing here refuses the second. The name is, because a list of
/// three rows all reading `snyvi` is a list that cannot be used: the folder's
/// own name is taken when it is free, and numbered when it is not.
pub fn create(conn: &Connection, root: &str, name: Option<&str>, now: i64) -> Result<Desk> {
    let wanted = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| derive_name(root));
    let name = free_name(conn, &wanted)?;
    conn.execute(
        "INSERT INTO desks(name, root, col, row, created_at) VALUES(?1, ?2, 0.5, 0.5, ?3)",
        params![name, root, now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Desk {
        id,
        name,
        root: root.to_string(),
        col: 0.5,
        row: 0.5,
        created_at: now,
        panes: Vec::new(),
    })
}

/// Rename a desk. The name a reader typed is theirs: it is not numbered, and a
/// second desk called `chores` is allowed if that is what they asked for.
pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<bool> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        "UPDATE desks SET name = ?2 WHERE id = ?1",
        params![id, name],
    )? > 0)
}

/// Where the two dividers sit. Clamped, because a fraction that came from a
/// drag can arrive as anything and a pane no one can see is not a pane.
pub fn layout(conn: &Connection, id: i64, col: f64, row: f64) -> Result<bool> {
    let clamp = |f: f64| {
        if f.is_finite() {
            f.clamp(MIN_FRACTION, MAX_FRACTION)
        } else {
            0.5
        }
    };
    Ok(conn.execute(
        "UPDATE desks SET col = ?2, row = ?3 WHERE id = ?1",
        params![id, clamp(col), clamp(row)],
    )? > 0)
}

/// Close a desk, and its panes with it.
///
/// `ON DELETE CASCADE` does the second half, which is why `PRAGMA foreign_keys`
/// is on for this connection: without it the panes would stay, hold their share
/// of the global cap, and belong to nothing.
pub fn delete(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM desks WHERE id = ?1", params![id])? > 0)
}

/// Open a pane on a desk, in the lowest free slot.
///
/// Both caps are read inside the same transaction that writes the row, so two
/// requests that arrive together cannot each see seven panes and both make an
/// eighth.
pub fn open_pane(
    conn: &mut Connection,
    desk_id: i64,
    cwd: &str,
    cmd: &str,
    now: i64,
) -> Result<Opened> {
    let tx = conn.transaction()?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM desks WHERE id = ?1",
            params![desk_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(Opened::NoSuchDesk);
    }
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM panes", [], |r| r.get(0))?;
    if total >= EVERYWHERE {
        return Ok(Opened::NoRoomLeft);
    }
    let taken: Vec<i64> = tx
        .prepare("SELECT slot FROM panes WHERE desk_id = ?1")?
        .query_map(params![desk_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Some(slot) = (1..=PER_DESK).find(|s| !taken.contains(s)) else {
        return Ok(Opened::DeskFull);
    };
    let id = pane_id()?;
    tx.execute(
        "INSERT INTO panes(id, desk_id, slot, cwd, cmd, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, desk_id, slot, cwd, cmd, now],
    )?;
    tx.commit()?;
    Ok(Opened::Pane(Pane {
        id,
        slot,
        cwd: cwd.to_string(),
        cmd: cmd.to_string(),
        created_at: now,
    }))
}

/// Close one pane. Its slot is free immediately, and so is its share of the
/// global cap.
pub fn close_pane(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute("DELETE FROM panes WHERE id = ?1", params![id])? > 0)
}

/// One pane and where it is, or nothing if that id is not a pane's.
pub fn pane(conn: &Connection, id: &str) -> Result<Option<Placed>> {
    Ok(conn
        .query_row(
            "SELECT p.id, p.slot, p.cwd, p.cmd, p.created_at, d.id, d.name, d.root
             FROM panes p JOIN desks d ON d.id = p.desk_id WHERE p.id = ?1",
            params![id],
            |r| {
                Ok(Placed {
                    pane: row_to_pane(r, 0)?,
                    desk_id: r.get(5)?,
                    desk_name: r.get(6)?,
                    root: r.get(7)?,
                })
            },
        )
        .optional()?)
}

/// What a pane re-runs, as the reader last typed it into `Start`. Kept, so the
/// field is pre-filled with it after a restart.
pub fn set_cmd(conn: &Connection, id: &str, cmd: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE panes SET cmd = ?2 WHERE id = ?1",
        params![id, cmd.trim()],
    )? > 0)
}

/// How many panes are open across every desk, which is the number the budget
/// cares about and the rail shows as `7 of 8 total`.
pub fn panes_open(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM panes", [], |r| r.get(0))?)
}

/// Every desk and every pane, gone. Called by a reset, which says the store is
/// what a machine that has never seen snyvi would have.
pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM panes; DELETE FROM desks;")?;
    Ok(())
}

/// The folder's own name, which is what the reader right-clicked and so what
/// they expect to see in the list. A root at `/` has no last component; it is
/// the only path that needs a word of its own.
fn derive_name(root: &str) -> String {
    std::path::Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "desk".to_string())
}

/// `snyvi`, then `snyvi 2`, then `snyvi 3`. The suffix counts desks and not
/// attempts, so closing `snyvi 2` and making another gives `snyvi 2` back
/// rather than climbing forever.
fn free_name(conn: &Connection, wanted: &str) -> Result<String> {
    let taken = |name: &str| -> Result<bool> {
        Ok(conn
            .query_row("SELECT 1 FROM desks WHERE name = ?1", params![name], |_| {
                Ok(())
            })
            .optional()?
            .is_some())
    };
    if !taken(wanted)? {
        return Ok(wanted.to_string());
    }
    for n in 2.. {
        let candidate = format!("{wanted} {n}");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!("the range is unbounded")
}

/// 16 bytes from the OS, hex encoded. The same source as the capability's 32
/// for the same reason -- a secret derived from the clock is one a neighbouring
/// program can search for -- and half the length because this one identifies a
/// pane to its own child rather than proving anything.
fn pane_id() -> Result<String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf)
        .map_err(|e| anyhow::anyhow!("reading random bytes for a pane id: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn row_to_desk(r: &rusqlite::Row) -> rusqlite::Result<Desk> {
    Ok(Desk {
        id: r.get(0)?,
        name: r.get(1)?,
        root: r.get(2)?,
        col: r.get(3)?,
        row: r.get(4)?,
        created_at: r.get(5)?,
        panes: Vec::new(),
    })
}

fn row_to_pane(r: &rusqlite::Row, at: usize) -> rusqlite::Result<Pane> {
    Ok(Pane {
        id: r.get(at)?,
        slot: r.get(at + 1)?,
        cwd: r.get(at + 2)?,
        cmd: r.get(at + 3)?,
        created_at: r.get(at + 4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn pane(conn: &mut Connection, desk: i64) -> Opened {
        open_pane(conn, desk, "/p", "", 0).unwrap()
    }

    fn slots(conn: &Connection, desk: i64) -> Vec<i64> {
        get(conn, desk)
            .unwrap()
            .unwrap()
            .panes
            .iter()
            .map(|p| p.slot)
            .collect()
    }

    /// The gesture is a right-click on a folder, so the folder's name is the
    /// one the reader is expecting -- and two desks on one folder is the
    /// workflow `Show desk` exists for, not a mistake to refuse.
    #[test]
    fn a_desk_is_named_after_its_folder_and_the_second_one_is_numbered() {
        let conn = db();
        let a = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        let b = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        let c = create(&conn, "/home/p/snyvi", None, 0).unwrap();
        assert_eq!(
            (a.name.as_str(), b.name.as_str(), c.name.as_str()),
            ("snyvi", "snyvi 2", "snyvi 3")
        );
        assert_ne!(a.id, b.id);
        assert_eq!(b.root, "/home/p/snyvi", "same folder, separate instance");
        // A name the reader typed is theirs, numbered only if it collides.
        let d = create(&conn, "/home/p/snyvi", Some("chores"), 0).unwrap();
        assert_eq!(d.name, "chores");
        // And the count follows the desks that exist, not the ones that did:
        // closing the second gives its name back.
        assert!(delete(&conn, b.id).unwrap());
        assert_eq!(
            create(&conn, "/home/p/snyvi", None, 0).unwrap().name,
            "snyvi 2"
        );
    }

    /// Slots, not splits. The lowest free one is taken, so closing pane 1 of
    /// four and opening another puts it back in slot 1 rather than leaving a
    /// hole and growing the grid.
    #[test]
    fn panes_fill_the_lowest_free_slot_and_the_fifth_is_refused() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        for _ in 0..PER_DESK {
            assert!(matches!(pane(&mut conn, d), Opened::Pane(_)));
        }
        assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
        assert!(matches!(pane(&mut conn, d), Opened::DeskFull));

        let first = get(&conn, d).unwrap().unwrap().panes[0].id.clone();
        assert!(close_pane(&conn, &first).unwrap());
        assert!(matches!(pane(&mut conn, d), Opened::Pane(p) if p.slot == 1));
        assert_eq!(slots(&conn, d), vec![1, 2, 3, 4]);
    }

    /// The cap that protects the budget. Four per desk bounds nothing once
    /// desks are unbounded; this is the line that holds, and it answers
    /// differently from the desk's own cap because the reader has to do
    /// something different about it.
    #[test]
    fn eight_panes_is_the_whole_of_it_however_many_desks_there_are() {
        let mut conn = db();
        let desks: Vec<i64> = (0..4)
            .map(|_| create(&conn, "/p", None, 0).unwrap().id)
            .collect();
        for d in &desks[..2] {
            for _ in 0..PER_DESK {
                assert!(matches!(pane(&mut conn, *d), Opened::Pane(_)));
            }
        }
        assert_eq!(panes_open(&conn).unwrap(), EVERYWHERE);
        // A desk with three slots free is still refused, and not as "full".
        assert!(matches!(pane(&mut conn, desks[2]), Opened::NoRoomLeft));

        // Closing a whole desk gives its four back, panes and all.
        assert!(delete(&conn, desks[0]).unwrap());
        assert_eq!(panes_open(&conn).unwrap(), 4, "the cascade took its panes");
        assert!(matches!(pane(&mut conn, desks[2]), Opened::Pane(_)));
    }

    /// A pane id leaves the daemon -- Phase 3 puts it in a child's environment
    /// as `SNYVI_SESSION` -- so it is 16 bytes from the OS and not a counter.
    #[test]
    fn a_pane_id_is_random_hex_and_a_desk_id_is_not() {
        let mut conn = db();
        let d = create(&conn, "/p", None, 0).unwrap();
        assert_eq!(d.id, 1, "a desk is an integer, like a project");
        let Opened::Pane(a) = pane(&mut conn, d.id) else {
            panic!("a pane on an empty desk")
        };
        let Opened::Pane(b) = pane(&mut conn, d.id) else {
            panic!("a second pane")
        };
        assert_eq!(a.id.len(), 32);
        assert!(a.id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a.id, b.id);
    }

    /// Four integers of geometry, and a drag can send anything.
    #[test]
    fn divider_fractions_are_clamped_and_a_missing_desk_says_so() {
        let conn = db();
        let d = create(&conn, "/p", None, 0).unwrap().id;
        assert!(layout(&conn, d, 0.0, 2.5).unwrap());
        let after = get(&conn, d).unwrap().unwrap();
        assert_eq!((after.col, after.row), (MIN_FRACTION, MAX_FRACTION));
        assert!(layout(&conn, d, f64::NAN, 0.4).unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().col, 0.5);
        assert!(!layout(&conn, d + 99, 0.5, 0.5).unwrap());
        assert!(!rename(&conn, d, "  ").unwrap(), "a name is not whitespace");
        assert!(rename(&conn, d, "chores").unwrap());
        assert_eq!(get(&conn, d).unwrap().unwrap().name, "chores");
    }

    /// A desk that is not there is not a desk that is full.
    #[test]
    fn a_pane_on_no_desk_is_refused_without_inventing_one() {
        let mut conn = db();
        assert!(matches!(pane(&mut conn, 7), Opened::NoSuchDesk));
        assert_eq!(panes_open(&conn).unwrap(), 0);
        assert!(list(&conn).unwrap().is_empty());
    }

    /// The list is what the sidebar draws, and a desk with no panes is what
    /// every desk is for the moment after it is made.
    #[test]
    fn the_list_carries_empty_desks_and_their_panes_in_slot_order() {
        let mut conn = db();
        let a = create(&conn, "/p/one", None, 0).unwrap().id;
        let b = create(&conn, "/p/two", None, 0).unwrap().id;
        let _ = pane(&mut conn, b);
        let _ = pane(&mut conn, b);
        let listed = list(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, a);
        assert!(listed[0].panes.is_empty());
        assert_eq!(
            listed[1].panes.iter().map(|p| p.slot).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(listed[1].panes[0].cwd, "/p");
    }
}
