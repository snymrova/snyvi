//! A desk's panes, the store's side (`crate::desk` holds the SQL): placing,
//! moving and closing them, and what a restart brings back. Beside the store
//! rather than in it, as `keys` is, so `store.rs` stays under its limit.

use super::*;
use crate::desk::groups;

impl Store {
    pub fn pane(&self, id: &str) -> Result<Option<Placed>> {
        desk::pane(&self.conn.lock().unwrap(), id)
    }

    pub fn set_pane_cmd(&self, id: &str, cmd: &str) -> Result<bool> {
        desk::set_cmd(&self.conn.lock().unwrap(), id, cmd)
    }

    /// The reader pressed Start on a panel that was waiting for it (`desk::unhold`).
    pub fn unhold_pane(&self, id: &str) -> Result<bool> {
        desk::unhold(&self.conn.lock().unwrap(), id)
    }

    pub fn set_pane_session(&self, id: &str, session: &str) -> Result<bool> {
        desk::set_agent_session(&self.conn.lock().unwrap(), id, session)
    }

    /// The panes a planned restart brings back as `claude --resume`
    /// (`desk::mark_resume`); how many were marked.
    pub fn mark_panes_resume(&self, ids: &[String]) -> Result<usize> {
        desk::mark_resume(&self.conn.lock().unwrap(), ids)
    }

    /// Those marks, as the daemon that comes up reads them
    /// (`desk::read_resume`): the planned restart's panes, then the ones to
    /// offer.
    pub fn panes_resume(&self) -> Result<(Vec<String>, Vec<String>)> {
        desk::read_resume(&self.conn.lock().unwrap())
    }

    /// And cleared, once that daemon holds the port (`desk::clear_resume`).
    pub fn clear_panes_resume(&self) -> Result<()> {
        desk::clear_resume(&self.conn.lock().unwrap())
    }

    /// Mark the panes that had Claude open, on an unplanned way out
    /// (`desk::mark_offer`).
    pub fn offer_panes_resume(&self, ids: &[String]) -> Result<usize> {
        desk::mark_offer(&self.conn.lock().unwrap(), ids)
    }

    /// Where a pane's shell has moved to (`desk::set_cwd`).
    pub fn set_pane_cwd(&self, id: &str, cwd: &str) -> Result<bool> {
        desk::set_cwd(&self.conn.lock().unwrap(), id, cwd)
    }

    /// A pane in the grid, as the tests open them.
    #[cfg(test)]
    pub fn open_pane(&self, desk_id: i64, cwd: &str, cmd: &str, held: bool) -> Result<Opened> {
        self.open_pane_on(desk_id, cwd, cmd, held, (0, false))
    }

    /// A pane in the grid, or in the back when `back` (`desk::open_pane`),
    /// in tab `grp`, or with 0 the one the reader is on.
    pub fn open_pane_on(
        &self,
        desk_id: i64,
        cwd: &str,
        cmd: &str,
        held: bool,
        at: (i64, bool),
    ) -> Result<Opened> {
        desk::open_pane(
            &mut self.conn.lock().unwrap(),
            desk_id,
            cwd,
            cmd,
            held,
            at,
            now(),
        )
    }

    /// Move a pane to another slot on its desk (`desk::move_pane`), and what
    /// each of the two panes sent with it: "From desk [2]" is the panel now in
    /// position 2, so a document's slot is rewritten in the same transaction.
    /// 1.57: within tab `grp`, and only that tab's documents.
    pub fn move_pane(&self, desk_id: i64, grp: i64, from: i64, to: i64) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !desk::move_pane(&tx, desk_id, grp, (from, to))? {
            return Ok(false);
        }
        tx.execute(
            "UPDATE docs SET desk_slot = CASE desk_slot WHEN ?2 THEN ?3 ELSE ?2 END
             WHERE desk_id = ?1 AND desk_grp = ?4 AND desk_slot IN (?2, ?3)",
            params![desk_id, from, to, grp],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Close a pane (`desk::close_pane`), and renumber what the panes after it
    /// on its side sent in the same transaction, as `move_pane` does: "From
    /// desk [3]" is the panel now in position 3. What the closed one sent
    /// keeps its desk and loses its slot, since no panel on screen is that one
    /// any more.
    pub fn close_pane(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some(desk::Freed { desk_id, grp, slot }) = desk::close_pane(&tx, id, now())? else {
            return Ok(false);
        };
        let end = *desk::side(desk::in_back(slot)).end();
        tx.execute(
            "UPDATE docs SET desk_slot = CASE WHEN desk_slot = ?2 THEN 0 ELSE desk_slot - 1 END
             WHERE desk_id = ?1 AND desk_grp = ?4 AND desk_slot >= ?2 AND desk_slot <= ?3",
            params![desk_id, slot, end, grp],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// A pane to the back or forward (`desk::send_back`), and what the panes
    /// sent with it, in one transaction: the moving one's documents follow it
    /// to its new slot, and the side it left closes up as a close does.
    pub fn send_back(&self, id: &str, back: bool) -> Result<desk::Sent> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let sent = desk::send_back(&tx, id, back)?;
        if let desk::Sent::Moved {
            desk_id,
            grp,
            from,
            to,
        } = sent
        {
            let end = *desk::side(desk::in_back(from)).end();
            tx.execute(
                "UPDATE docs SET desk_slot = CASE WHEN desk_slot = ?2 THEN ?4 ELSE desk_slot - 1 END
                 WHERE desk_id = ?1 AND desk_grp = ?5 AND desk_slot >= ?2 AND desk_slot <= ?3",
                params![desk_id, from, end, to, grp],
            )?;
            tx.commit()?;
        }
        Ok(sent)
    }

    pub fn restore_pane(&self, id: &str) -> Result<desk::Restored> {
        desk::restore_pane(&mut self.conn.lock().unwrap(), id)
    }

    pub fn rename_pane(&self, id: &str, name: &str, by: &str) -> Result<bool> {
        desk::rename_pane(&self.conn.lock().unwrap(), id, name, by)
    }

    /// Closed panes older than `before` (`desk::prune_closed`); what `prune`
    /// ends beside the documents.
    pub fn prune_panes(&self, before: i64, dry_run: bool) -> Result<Vec<(String, String)>> {
        desk::prune_closed(&self.conn.lock().unwrap(), before, dry_run)
    }

    pub fn panes_open(&self) -> Result<i64> {
        desk::panes_open(&self.conn.lock().unwrap())
    }

    /// 1.57: a new tab on a desk (`groups::create`). On its first, the
    /// desk's documents go to the group its panels went to, in the same
    /// transaction, so no row of the desk is left at 0.
    pub fn create_group(&self, desk_id: i64, name: &str) -> Result<Option<i64>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some(made) = groups::create(&tx, desk_id, name, now())? else {
            return Ok(None);
        };
        if let Some(first) = made.first {
            tx.execute(
                "UPDATE docs SET desk_grp = ?2 WHERE desk_id = ?1 AND desk_grp = 0",
                params![desk_id, first],
            )?;
        }
        tx.commit()?;
        Ok(Some(made.id))
    }

    pub fn rename_group(&self, desk_id: i64, grp: i64, name: &str) -> Result<bool> {
        groups::rename(&self.conn.lock().unwrap(), desk_id, grp, name)
    }

    pub fn move_group(&self, desk_id: i64, grp: i64, to: usize) -> Result<bool> {
        groups::move_to(&mut self.conn.lock().unwrap(), desk_id, grp, to)
    }

    pub fn show_group(&self, desk_id: i64, grp: i64) -> Result<bool> {
        groups::show(&self.conn.lock().unwrap(), desk_id, grp)
    }

    pub fn focus_group(&self, desk_id: i64, grp: i64, pane: &str) -> Result<bool> {
        groups::focus(&self.conn.lock().unwrap(), desk_id, grp, pane)
    }

    pub fn close_group(&self, desk_id: i64, grp: i64) -> Result<groups::Closed> {
        groups::close(&mut self.conn.lock().unwrap(), desk_id, grp, now())
    }

    pub fn restore_group(&self, desk_id: i64, grp: i64) -> Result<bool> {
        groups::restore(&mut self.conn.lock().unwrap(), desk_id, grp)
    }

    /// A panel to another tab (`groups::regroup`), and its documents with it:
    /// they take its new tab and slot, and the tab it left renumbers its own
    /// the way a close does, in one transaction.
    pub fn regroup_pane(&self, id: &str, to_grp: i64) -> Result<groups::Regrouped> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let moved = groups::regroup(&tx, id, to_grp)?;
        if let groups::Regrouped::Moved {
            desk_id,
            from_grp,
            from,
            to_grp,
            to,
        } = moved
        {
            tx.execute(
                "UPDATE docs SET desk_grp = ?4, desk_slot = ?5
                 WHERE desk_id = ?1 AND desk_grp = ?2 AND desk_slot = ?3",
                params![desk_id, from_grp, from, to_grp, to],
            )?;
            let end = *desk::side(desk::in_back(from)).end();
            tx.execute(
                "UPDATE docs SET desk_slot = desk_slot - 1
                 WHERE desk_id = ?1 AND desk_grp = ?2 AND desk_slot > ?3 AND desk_slot <= ?4",
                params![desk_id, from_grp, from, end],
            )?;
            tx.commit()?;
        }
        Ok(moved)
    }
}
