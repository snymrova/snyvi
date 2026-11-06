//! Documents a desk sent that were filed a folder too high: before 1.36.2 a
//! desk with no `.git` of its own was filed under the nearest repository
//! above it (`crate::project::resolve_on_desk` is the floor now), so a stray
//! `.git` in the folder that holds every project took the desk's documents
//! as a project named after that folder. Read here; moved by
//! `crate::receive::refile_desks`, through `move_lineage`, which keeps every
//! version.

use super::*;

/// A document on a desk, and the project folder it is filed under.
pub struct OnDesk {
    pub id: String,
    pub desk: Origin,
    pub desk_root: String,
    pub project_root: String,
    /// When it was taken off the desk's list, or 0: `move_lineage` puts a
    /// document on the list, and a refile must not undo the reader's ✕.
    pub off: i64,
}

impl Store {
    /// Every live document that names a desk, with the desk's folder and the
    /// project's. Which of them sit above their desk is the caller's to say:
    /// it is a question about folders, not rows.
    pub fn docs_on_desks(&self) -> Result<Vec<OnDesk>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT d.id, k.id, k.name, COALESCE(d.desk_slot, 0), k.root, p.root, d.desk_off, d.desk_grp
                 FROM live_docs d JOIN desks k ON k.id = d.desk_id JOIN projects p ON p.id = d.project_id
                 WHERE p.root NOT LIKE 'peer:%'",
            )?
            .query_map([], |r| {
                Ok(OnDesk {
                    id: r.get(0)?,
                    desk: Origin {
                        id: r.get(1)?,
                        name: r.get(2)?,
                        slot: r.get(3)?,
                        grp: r.get(7)?,
                    },
                    desk_root: r.get(4)?,
                    project_root: r.get(5)?,
                    off: r.get(6)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Put back when a document was taken off its desk's list.
    pub fn keep_desk_off(&self, id: &str, off: i64) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE docs SET desk_off = ?2 WHERE id = ?1",
            params![id, off],
        )?;
        Ok(())
    }
}
