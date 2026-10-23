//! A desk's panes, the store's side (`crate::desk` holds the SQL): placing,
//! moving and closing them, and what a restart brings back. Beside the store
//! rather than in it, as `keys` is, so `store.rs` stays under its limit.

use super::*;

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
        self.open_pane_on(desk_id, cwd, cmd, held, false)
    }

    /// A pane in the grid, or in the back when `back` (`desk::open_pane`).
    pub fn open_pane_on(
        &self,
        desk_id: i64,
        cwd: &str,
        cmd: &str,
        held: bool,
        back: bool,
    ) -> Result<Opened> {
        desk::open_pane(
            &mut self.conn.lock().unwrap(),
            desk_id,
            cwd,
            cmd,
            held,
            back,
            now(),
        )
    }

    /// Move a pane to another slot on its desk (`desk::move_pane`), and what
    /// each of the two panes sent with it: "From desk [2]" is the panel now in
    /// position 2, so a document's slot is rewritten in the same transaction.
    pub fn move_pane(&self, desk_id: i64, from: i64, to: i64) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !desk::move_pane(&tx, desk_id, from, to)? {
            return Ok(false);
        }
        tx.execute(
            "UPDATE docs SET desk_slot = CASE desk_slot WHEN ?2 THEN ?3 ELSE ?2 END
             WHERE desk_id = ?1 AND desk_slot IN (?2, ?3)",
            params![desk_id, from, to],
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
        let Some((desk_id, slot)) = desk::close_pane(&tx, id, now())? else {
            return Ok(false);
        };
        let end = *desk::side(desk::in_back(slot)).end();
        tx.execute(
            "UPDATE docs SET desk_slot = CASE WHEN desk_slot = ?2 THEN 0 ELSE desk_slot - 1 END
             WHERE desk_id = ?1 AND desk_slot >= ?2 AND desk_slot <= ?3",
            params![desk_id, slot, end],
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
        if let desk::Sent::Moved { desk_id, from, to } = sent {
            let end = *desk::side(desk::in_back(from)).end();
            tx.execute(
                "UPDATE docs SET desk_slot = CASE WHEN desk_slot = ?2 THEN ?4 ELSE desk_slot - 1 END
                 WHERE desk_id = ?1 AND desk_slot >= ?2 AND desk_slot <= ?3",
                params![desk_id, from, end, to],
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
}
