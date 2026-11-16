//! Recently closed (1.67, plan f586a9fe09): what a desk's ✕ took from view,
//! there to reopen after its Undo is over.
//!
//! Nothing is deleted: a closed panel is a row of `panes_closed` and a closed
//! tab a `desk_groups` row with `closed_at` set, both kept until `prune`.
//! But the only way back was the six-second Undo in the rail; after it the
//! panel was on disk and nowhere on the page. This is that list, newest
//! first: a panel alone, or a tab with the panels that closed with it (they
//! carry the tab's own instant, which is how `groups::restore` finds them).
//! Read only; the reopening is `restore_pane` and `groups::restore`.

use super::*;

/// One row of the list.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClosedRow {
    /// `panel` or `tab`.
    pub kind: &'static str,
    /// The panel's id, or the tab's as a string.
    pub id: String,
    pub name: String,
    /// What the panel ran, as typed; empty for a tab.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cmd: String,
    /// The panel held a Claude Code session, which can resume.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub session: bool,
    /// How many panels closed with the tab.
    #[serde(skip_serializing_if = "is_zero")]
    pub panes: i64,
    pub closed_at: i64,
}

/// What was closed on `desk_id`, newest first, `limit` rows at most. A panel
/// that closed with its tab is counted on the tab's row, not listed alone.
pub fn recent(conn: &Connection, desk_id: i64, limit: usize) -> Result<Vec<ClosedRow>> {
    let mut rows: Vec<ClosedRow> = conn
        .prepare(
            "SELECT g.id, g.name, g.closed_at,
                    (SELECT COUNT(*) FROM panes_closed c
                     WHERE c.desk_id = g.desk_id AND c.grp = g.id AND c.closed_at = g.closed_at)
             FROM desk_groups g WHERE g.desk_id = ?1 AND g.closed_at != 0",
        )?
        .query_map(params![desk_id], |r| {
            Ok(ClosedRow {
                kind: "tab",
                id: r.get::<_, i64>(0)?.to_string(),
                name: r.get(1)?,
                cmd: String::new(),
                session: false,
                panes: r.get(3)?,
                closed_at: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let panels: Vec<ClosedRow> = conn
        .prepare(
            "SELECT c.id, c.name, c.cmd, c.agent_session != '', c.closed_at
             FROM panes_closed c
             WHERE c.desk_id = ?1
               AND NOT EXISTS (SELECT 1 FROM desk_groups g
                               WHERE g.id = c.grp AND g.desk_id = c.desk_id
                                 AND g.closed_at != 0 AND g.closed_at = c.closed_at)",
        )?
        .query_map(params![desk_id], |r| {
            Ok(ClosedRow {
                kind: "panel",
                id: r.get(0)?,
                name: r.get(1)?,
                cmd: r.get(2)?,
                session: r.get(3)?,
                panes: 0,
                closed_at: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.extend(panels);
    rows.sort_by(|a, b| b.closed_at.cmp(&a.closed_at).then(a.id.cmp(&b.id)));
    rows.truncate(limit);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desk::tests::db;

    #[test]
    fn a_closed_panel_is_listed_and_a_tabs_panels_are_on_its_row() {
        let mut conn = db();
        let d = create(&conn, "/p", Some("a"), 1).unwrap();
        let open = |conn: &mut Connection, grp: i64| match open_pane(
            conn,
            d.id,
            "/p",
            "",
            false,
            (grp, false),
            1,
        )
        .unwrap()
        {
            Opened::Pane(p) => p,
            _ => panic!("not opened"),
        };
        // Two tabs: every panel there was goes into the first.
        let tx = conn.transaction().unwrap();
        let made = groups::create(&tx, d.id, "Notes", 1).unwrap().unwrap();
        tx.commit().unwrap();
        let alone = open(&mut conn, made.first.unwrap());
        open(&mut conn, made.id);
        open(&mut conn, made.id);
        assert!(recent(&conn, d.id, 20).unwrap().is_empty());

        let tx = conn.transaction().unwrap();
        close_pane(&tx, &alone.id, 100).unwrap();
        tx.commit().unwrap();
        groups::close(&mut conn, d.id, made.id, 200).unwrap();

        let rows = recent(&conn, d.id, 20).unwrap();
        let said: Vec<(&str, i64, i64)> = rows
            .iter()
            .map(|r| (r.kind, r.panes, r.closed_at))
            .collect();
        assert_eq!(said, [("tab", 2, 200), ("panel", 0, 100)]);
        assert_eq!(rows[1].id, alone.id);
        assert_eq!(recent(&conn, d.id, 1).unwrap().len(), 1);

        // Reopened, it leaves the list.
        assert!(groups::restore(&mut conn, d.id, made.id).unwrap());
        assert_eq!(recent(&conn, d.id, 20).unwrap().len(), 1);
    }
}
