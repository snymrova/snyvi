//! 1.57: a desk's tabs, which the code calls *groups* (#217).
//!
//! A tab is a group of panels inside one desk: its own name, its own folder
//! and its own four in the grid and four in the back, its own dividers, full
//! view and focused panel. Everything else stays the desk's: one name, one
//! list of notes, one thread list, one left-off, one set of keys, one account.
//! The page says *tab*; the code says *group*, because the `[n]` panel tabs
//! already own `tabs()` and `.dk-tabs`, and two things called tabs in one
//! scope is how a part blanks the page.
//!
//! `grp = 0` is a desk with no tabs, and every path for such a desk is the
//! one it was before 1.57. The first tab a reader makes makes two groups --
//! one for the panels already there, named after the desk's folder, and the
//! new one -- and every row that held 0 on that desk is re-stamped to the
//! first in the same transaction (`create`), so from then on no row of that
//! desk holds 0: its panes, its closed panes and, in the store's half of the
//! same transaction, its documents. A desk never goes back to none: the last
//! open group cannot be closed (`close`).
//!
//! The shown tab is the page's. `desks.grp_shown` is only where the desk
//! reopens (`show`), since two windows on one desk would otherwise switch
//! each other; `default_grp` reads it for a panel opened without one.

use super::*;

/// How long a tab's name is, at most: a word or two in the head.
pub const GROUP_NAME_CHARS: usize = 40;

/// Version 35 of `store::MIGRATIONS`, the desk's half: `panes` rebuilt,
/// since its `UNIQUE(desk_id, slot)` is inline and SQLite cannot change it
/// in place (an added column would leave it standing, and the second tab's
/// panel 1 would fail on insert); a closed pane's group; the groups
/// themselves; and the desk's reopen default. The documents' half is
/// `DOCS_COLUMN_1_57`, apart because a desk's tests have no `docs` table.
pub const COLUMNS_1_57: &str = "
CREATE TABLE panes_2 (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  grp INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  cmd TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  agent_session TEXT NOT NULL DEFAULT '',
  resume_next INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  account INTEGER,
  held INTEGER NOT NULL DEFAULT 0,
  name_by TEXT NOT NULL DEFAULT '',
  UNIQUE(desk_id, grp, slot)
);
INSERT INTO panes_2(id, desk_id, slot, cwd, cmd, created_at, agent_session, resume_next, name, account, held, name_by)
  SELECT id, desk_id, slot, cwd, cmd, created_at, agent_session, resume_next, name, account, held, name_by FROM panes;
DROP TABLE panes;
ALTER TABLE panes_2 RENAME TO panes;
CREATE INDEX panes_desk ON panes(desk_id, grp, slot);
ALTER TABLE panes_closed ADD COLUMN grp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desks ADD COLUMN grp_shown INTEGER NOT NULL DEFAULT 0;
CREATE TABLE desk_groups (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  col REAL NOT NULL DEFAULT 0.5,
  row REAL NOT NULL DEFAULT 0.5,
  full_slot INTEGER NOT NULL DEFAULT 0,
  focused TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX desk_groups_desk ON desk_groups(desk_id, closed_at, pos);";

/// The documents' half of version 35: which group the sending pane was in,
/// beside `desk_slot`, so a close in one tab renumbers that tab's documents
/// and no other's.
pub const DOCS_COLUMN_1_57: &str =
    "ALTER TABLE docs ADD COLUMN desk_grp INTEGER NOT NULL DEFAULT 0";

/// A tab, as the head draws it and a switch restores it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Group {
    pub id: i64,
    pub name: String,
    /// Where its new panels start, and what the head's path shows.
    pub root: String,
    /// The reader's order, left to right.
    pub pos: i64,
    pub col: f64,
    pub row: f64,
    pub full_slot: i64,
    /// The pane that had the keys when the reader left it, or empty.
    pub focused: String,
}

const GROUP_COLS: &str = "id, name, root, pos, col, row, full_slot, focused";

fn row_to_group(r: &rusqlite::Row) -> rusqlite::Result<Group> {
    Ok(Group {
        id: r.get(0)?,
        name: r.get(1)?,
        root: r.get(2)?,
        pos: r.get(3)?,
        col: r.get(4)?,
        row: r.get(5)?,
        full_slot: r.get(6)?,
        focused: r.get(7)?,
    })
}

/// One desk's open groups, in the reader's order; empty for a desk with no tabs.
pub fn of(conn: &Connection, desk_id: i64) -> Result<Vec<Group>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {GROUP_COLS} FROM desk_groups WHERE desk_id = ?1 AND closed_at = 0 ORDER BY pos, id"
    ))?;
    let rows = stmt
        .query_map(params![desk_id], row_to_group)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Every open group, with its desk, for `list`: one query for all desks.
pub fn all(conn: &Connection) -> Result<Vec<(i64, Group)>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT desk_id, {GROUP_COLS} FROM desk_groups WHERE closed_at = 0 ORDER BY desk_id, pos, id"
    ))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                Group {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    root: r.get(3)?,
                    pos: r.get(4)?,
                    col: r.get(5)?,
                    row: r.get(6)?,
                    full_slot: r.get(7)?,
                    focused: r.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The group a panel goes in when the caller named none: the desk's reopen
/// default while it is open, else its first, else 0 for a desk with no tabs.
/// So every path that opened a panel before 1.57 -- a routine's run, an
/// agent's `suggest_panel` -- lands it in a real group without knowing any.
pub fn default_grp(conn: &Connection, desk_id: i64) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT g.id FROM desk_groups g JOIN desks d ON d.id = g.desk_id
             WHERE g.desk_id = ?1 AND g.closed_at = 0
             ORDER BY g.id = d.grp_shown DESC, g.pos, g.id LIMIT 1",
            params![desk_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// `grp` when it is one of this desk's open groups, else `default_grp`: a
/// closed tab's panel restored on its own, or a caller that said 0 on a
/// desk that has tabs, goes where the reader is.
pub fn live_grp(conn: &Connection, desk_id: i64, grp: i64) -> Result<i64> {
    let open = grp != 0
        && conn
            .query_row(
                "SELECT 1 FROM desk_groups WHERE id = ?1 AND desk_id = ?2 AND closed_at = 0",
                params![grp, desk_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
    if open {
        Ok(grp)
    } else {
        default_grp(conn, desk_id)
    }
}

/// Each open panel of a desk with tabs, by id, to its tab's name: what a
/// note's row is marked with when it came from another tab. Empty for a
/// desk with no tabs, whose panels are all at 0.
pub fn pane_tabs(
    conn: &Connection,
    desk_id: i64,
) -> Result<std::collections::HashMap<String, String>> {
    let rows = conn
        .prepare(
            "SELECT p.id, g.name FROM panes p JOIN desk_groups g ON g.id = p.grp
             WHERE p.desk_id = ?1 AND g.closed_at = 0",
        )?
        .query_map(params![desk_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The row that holds a group's layout: the group's own, or the desk's for
/// a desk with no tabs. Both are keyed by `id = ?1`, so one statement serves.
pub(super) fn layout_row(desk_id: i64, grp: i64) -> (&'static str, i64) {
    if grp == 0 {
        ("desks", desk_id)
    } else {
        ("desk_groups", grp)
    }
}

/// The slots taken on one side's group.
pub(super) fn taken(tx: &Connection, desk_id: i64, grp: i64) -> Result<Vec<i64>> {
    let rows = tx
        .prepare("SELECT slot FROM panes WHERE desk_id = ?1 AND grp = ?2")?
        .query_map(params![desk_id, grp], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A name for a tab: the reader's, trimmed and cut, or the folder's last part.
fn group_name(name: &str, root: &str) -> String {
    let n = clip_to(name.trim(), GROUP_NAME_CHARS);
    if n.is_empty() {
        clip_to(&derive_name(root), GROUP_NAME_CHARS)
    } else {
        n
    }
}

/// What making a tab made.
#[derive(Debug, PartialEq)]
pub struct Created {
    /// The new group.
    pub id: i64,
    /// The group the desk's panels went into, when this was the desk's first
    /// tab: the store re-stamps the desk's documents to it in the same
    /// transaction (`Store::create_group`).
    pub first: Option<i64>,
}

/// A new tab on a desk, shown, last in the order. On a desk with no tabs it
/// first makes the group the panels already there go into, named after the
/// desk's folder and holding its dividers and full view, and re-stamps every
/// pane and closed pane at 0 to it. Runs in the caller's transaction, which
/// re-stamps the documents too. `None` when the id is not an open desk's.
pub fn create(
    tx: &rusqlite::Transaction,
    desk_id: i64,
    name: &str,
    root: &str,
    now: i64,
) -> Result<Option<Created>> {
    let Some((desk_root, col, row, full)) = tx
        .query_row(
            "SELECT root, col, row, full_slot FROM desks WHERE id = ?1 AND closed_at = 0",
            params![desk_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let had: i64 = tx.query_row(
        "SELECT COUNT(*) FROM desk_groups WHERE desk_id = ?1 AND closed_at = 0",
        params![desk_id],
        |r| r.get(0),
    )?;
    let insert = "INSERT INTO desk_groups(desk_id, name, root, pos, col, row, full_slot, created_at)
         VALUES(?1, ?2, ?3, (SELECT COALESCE(MAX(pos), 0) + 1 FROM desk_groups WHERE desk_id = ?1), ?4, ?5, ?6, ?7)";
    let first = if had == 0 {
        tx.execute(
            insert,
            params![
                desk_id,
                group_name("", &desk_root),
                desk_root,
                col,
                row,
                full,
                now
            ],
        )?;
        let first = tx.last_insert_rowid();
        tx.execute(
            "UPDATE panes SET grp = ?2 WHERE desk_id = ?1 AND grp = 0",
            params![desk_id, first],
        )?;
        tx.execute(
            "UPDATE panes_closed SET grp = ?2 WHERE desk_id = ?1 AND grp = 0",
            params![desk_id, first],
        )?;
        Some(first)
    } else {
        None
    };
    tx.execute(
        insert,
        params![desk_id, group_name(name, root), root, 0.5, 0.5, 0, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE desks SET grp_shown = ?2 WHERE id = ?1",
        params![desk_id, id],
    )?;
    Ok(Some(Created { id, first }))
}

/// Rename a tab. Empty is refused: a tab with no name is a tab no one can find.
pub fn rename(conn: &Connection, desk_id: i64, grp: i64, name: &str) -> Result<bool> {
    let name = clip_to(name.trim(), GROUP_NAME_CHARS);
    if name.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        "UPDATE desk_groups SET name = ?3 WHERE id = ?2 AND desk_id = ?1 AND closed_at = 0",
        params![desk_id, grp, name],
    )? > 0)
}

/// Move a tab to place `to` (0 the leftmost) among the desk's open tabs,
/// the others keeping their order. False when it is not an open tab here.
pub fn move_to(conn: &mut Connection, desk_id: i64, grp: i64, to: usize) -> Result<bool> {
    let tx = conn.transaction()?;
    let mut ids: Vec<i64> = of(&tx, desk_id)?.into_iter().map(|g| g.id).collect();
    let Some(at) = ids.iter().position(|&g| g == grp) else {
        return Ok(false);
    };
    let g = ids.remove(at);
    ids.insert(to.min(ids.len()), g);
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE desk_groups SET pos = ?2 WHERE id = ?1",
            params![id, i as i64 + 1],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

/// Where the desk reopens: this tab. The page's own shown tab is the page's.
pub fn show(conn: &Connection, desk_id: i64, grp: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET grp_shown = ?2 WHERE id = ?1 AND closed_at = 0
           AND EXISTS (SELECT 1 FROM desk_groups WHERE id = ?2 AND desk_id = ?1 AND closed_at = 0)",
        params![desk_id, grp],
    )? > 0)
}

/// The panel that had the keys in a tab, kept so a switch and a reopen come
/// back to it. Only a pane that is in that tab.
pub fn focus(conn: &Connection, desk_id: i64, grp: i64, pane: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desk_groups SET focused = ?3 WHERE id = ?2 AND desk_id = ?1
           AND EXISTS (SELECT 1 FROM panes WHERE id = ?3 AND desk_id = ?1 AND grp = ?2)",
        params![desk_id, grp, pane],
    )? > 0)
}

/// What came of closing a tab.
#[derive(Debug, PartialEq)]
pub enum Closed {
    /// Closed; the panes it closed, for the caller to stop and keep the text of.
    Panes(Vec<String>),
    /// The desk's last open tab, which stays.
    Last,
    /// Not an open tab on this desk.
    Gone,
}

/// Close a tab the way ✕ closes a panel, for every panel in it at once: each
/// goes to `panes_closed` on the tab's own instant, which is how `restore`
/// knows which came with it, and nothing is deleted. The desk's reopen
/// default moves to the first tab left when it was this one.
pub fn close(conn: &mut Connection, desk_id: i64, grp: i64, now: i64) -> Result<Closed> {
    let tx = conn.transaction()?;
    let open = of(&tx, desk_id)?;
    if !open.iter().any(|g| g.id == grp) {
        return Ok(Closed::Gone);
    }
    if open.len() < 2 {
        return Ok(Closed::Last);
    }
    tx.execute(
        "UPDATE desk_groups SET closed_at = ?2 WHERE id = ?1",
        params![grp, now],
    )?;
    let ids: Vec<String> = tx
        .prepare("SELECT id FROM panes WHERE desk_id = ?1 AND grp = ?2 ORDER BY slot")?
        .query_map(params![desk_id, grp], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for p in &ids {
        stash(&tx, p, now)?;
    }
    tx.execute(
        "DELETE FROM panes WHERE desk_id = ?1 AND grp = ?2",
        params![desk_id, grp],
    )?;
    let next = open.iter().find(|g| g.id != grp).map_or(0, |g| g.id);
    tx.execute(
        "UPDATE desks SET grp_shown = ?3 WHERE id = ?1 AND grp_shown = ?2",
        params![desk_id, grp, next],
    )?;
    tx.commit()?;
    Ok(Closed::Panes(ids))
}

/// A pane's row into `panes_closed`, with its side and its group, as every
/// close writes it: one panel's ✕, a tab's, a desk's.
pub(super) fn stash(tx: &rusqlite::Transaction, id: &str, now: i64) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO panes_closed(id, desk_id, grp, cwd, cmd, name, name_by, agent_session, account, created_at, closed_at, back)
         SELECT id, desk_id, grp, cwd, cmd, name, name_by, agent_session, account, created_at, ?2, slot > ?3 FROM panes WHERE id = ?1",
        params![id, now, GRID],
    )?;
    Ok(())
}

/// Closed panes back into their group, each in the lowest free slot of the
/// side it was on, in the order given (the order they closed in, which is
/// slot order). Past a side's cap one stays in the Removed list. Shared by a
/// tab's restore and a desk's reopen.
pub(super) fn bring_back(
    tx: &rusqlite::Transaction,
    desk_id: i64,
    closed: &[(String, i64, bool)],
) -> Result<()> {
    for (p, grp, back) in closed {
        let grp = live_grp(tx, desk_id, *grp)?;
        let have = taken(tx, desk_id, grp)?;
        let Some(slot) = side(*back).find(|s| !have.contains(s)) else {
            continue;
        };
        tx.execute(
            "INSERT INTO panes(id, desk_id, grp, slot, cwd, cmd, name, name_by, agent_session, account, created_at)
             SELECT id, desk_id, ?3, ?2, cwd, cmd, name, name_by, agent_session, account, created_at FROM panes_closed WHERE id = ?1",
            params![p, slot, grp],
        )?;
        tx.execute("DELETE FROM panes_closed WHERE id = ?1", params![p])?;
    }
    Ok(())
}

/// A closed tab back, after its Undo or from the Removed list, with the
/// panels that closed with it, stopped, as a restart brings a panel back.
/// False when it is not a closed tab on this open desk.
pub fn restore(conn: &mut Connection, desk_id: i64, grp: i64) -> Result<bool> {
    let tx = conn.transaction()?;
    let Some(at) = tx
        .query_row(
            "SELECT g.closed_at FROM desk_groups g JOIN desks d ON d.id = g.desk_id
             WHERE g.id = ?1 AND g.desk_id = ?2 AND g.closed_at != 0 AND d.closed_at = 0",
            params![grp, desk_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE desk_groups SET closed_at = 0 WHERE id = ?1",
        params![grp],
    )?;
    let closed: Vec<(String, i64, bool)> = tx
        .prepare(
            "SELECT id, grp, back FROM panes_closed WHERE desk_id = ?1 AND grp = ?2 AND closed_at = ?3
             ORDER BY rowid",
        )?
        .query_map(params![desk_id, grp, at], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    bring_back(&tx, desk_id, &closed)?;
    tx.commit()?;
    Ok(true)
}

/// What came of moving a panel to another tab.
#[derive(Debug, PartialEq)]
pub enum Regrouped {
    /// From one group's slot to the other's lowest free one on the same side.
    Moved {
        desk_id: i64,
        from_grp: i64,
        from: i64,
        to_grp: i64,
        to: i64,
    },
    /// Already in that tab.
    Stays,
    /// That side of that tab is full.
    Full,
    /// Not a pane, or not an open tab on its desk.
    Gone,
}

/// A panel to another tab of its desk, on the side it is on, into the lowest
/// free slot there; the tab it left closes up as a close does, and its full
/// view follows as a close's does. Runs in the caller's transaction, which
/// moves the panel's documents with it and renumbers the ones it left
/// behind (`Store::regroup_pane`). Through slot 0, the reasoning
/// `move_pane` gives.
pub fn regroup(tx: &rusqlite::Transaction, id: &str, to_grp: i64) -> Result<Regrouped> {
    let Some((desk_id, from_grp, from)) = tx
        .query_row(
            "SELECT desk_id, grp, slot FROM panes WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(Regrouped::Gone);
    };
    if to_grp == from_grp {
        return Ok(Regrouped::Stays);
    }
    if to_grp == 0 || live_grp(tx, desk_id, to_grp)? != to_grp {
        return Ok(Regrouped::Gone);
    }
    let have = taken(tx, desk_id, to_grp)?;
    let Some(to) = side(in_back(from)).find(|s| !have.contains(s)) else {
        return Ok(Regrouped::Full);
    };
    tx.execute("UPDATE panes SET slot = 0 WHERE id = ?1", params![id])?;
    close_up(tx, desk_id, from_grp, from)?;
    tx.execute(
        "UPDATE panes SET grp = ?2, slot = ?3 WHERE id = ?1",
        params![id, to_grp, to],
    )?;
    if !in_back(from) {
        let (table, row) = layout_row(desk_id, from_grp);
        tx.execute(
            &format!("UPDATE {table} SET full_slot = CASE WHEN full_slot = ?2 THEN 0 WHEN full_slot > ?2 THEN full_slot - 1 ELSE full_slot END WHERE id = ?1"),
            params![row, from],
        )?;
    }
    Ok(Regrouped::Moved {
        desk_id,
        from_grp,
        from,
        to_grp,
        to,
    })
}

/// For a module's tests that build a desk's schema by hand: the panes'
/// columns the 1.57 step copies, added where that schema has none, then
/// the step itself.
#[cfg(test)]
pub fn for_tests(conn: &Connection) {
    let has = |table: &str, col: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, col],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    };
    for (table, col, ty) in [
        ("panes", "account", "INTEGER"),
        ("panes", "held", "INTEGER NOT NULL DEFAULT 0"),
        ("panes", "name_by", "TEXT NOT NULL DEFAULT ''"),
        ("panes_closed", "name_by", "TEXT NOT NULL DEFAULT ''"),
        ("panes_closed", "account", "INTEGER"),
        ("panes_closed", "back", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !has(table, col) {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {ty}"))
                .unwrap();
        }
    }
    conn.execute_batch(COLUMNS_1_57).unwrap();
}

#[cfg(test)]
mod tests;
