//! What a pane's next start should be, written for the daemon that comes up
//! (`panes.resume_next`). Out of `desk.rs` in 1.58, which was at its limit.
//!
//! | value | meaning |
//! |---|---|
//! | 0 | nothing |
//! | 1 | a planned restart: come back as the conversation (`mark_resume`) |
//! | 2 | an offer after a clean stop (`mark_offer`), or a 1 nobody came back to |
//! | 3 | an agent is in this panel now (`set_live`) |
//! | 4 | an offer after a crash: a 3 the last daemon never rewrote |
//! | 5 | an offer a window has seen (`age_offers`); it lapses at the next start |
//!
//! A 3 is what tells a crash apart, without a pid file. Every exit the
//! daemon gets to run rewrites its 3s (`mark_resume`, `mark_offer`), so a 3
//! still there at the next start is a daemon that died with an agent in the
//! panel -- the OOM killer, a SIGKILL, power. `settle_marks` turns it into a
//! 4, and the window offers it back as one that closed unexpectedly.
//!
//! An offer ages only once a window has shown it: an update's restart in
//! the night, or two crashes before anyone opened the window, keep it. Once
//! seen, it survives the start after and goes at the one after that, so a
//! restore nobody wanted does not ask forever (rev 2 of plan 3ec9c9273b).

use super::*;

/// The marks the last daemon left, as the one coming up reads them.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ResumeMarks {
    /// A planned restart's panes (1).
    pub planned: Vec<String>,
    /// The ones to offer back with a click: 2, 4, and a 3 with a session.
    pub offered: Vec<String>,
    /// Of those, the ones the last daemon died with an agent in: 4, and 3.
    pub crashed: Vec<String>,
}

/// Mark the panes a planned restart should bring back as `claude --resume`:
/// the ones given, and of those only the ones whose conversation is known,
/// since a mark on a pane with nothing to resume would start `claude
/// --resume ` with no id. The last restart's marks are cleared in the same
/// call, so the 1s only ever describe the one restart in progress; offers
/// stay as they are, with their age, and a live 3 not given becomes an offer.
pub fn mark_resume(conn: &Connection, ids: &[String]) -> Result<usize> {
    conn.execute("UPDATE panes SET resume_next = 0 WHERE resume_next = 1", [])?;
    let mut n = 0;
    for id in ids {
        n += conn.execute(
            "UPDATE panes SET resume_next = 1 WHERE id = ?1 AND agent_session <> ''",
            params![id],
        )?;
    }
    lives_out(conn)?;
    Ok(n)
}

/// Mark the panes that had Claude open when the daemon stopped without
/// planning to -- `snyvi stop`, a signal, a reboot -- as ones to *offer* back
/// (`resume_next = 2`), where a planned restart's mark (1) starts them as the
/// conversation. A pane already marked either way keeps its mark, and an
/// offer keeps its age. Every live mark left is rewritten too, so the next
/// start reads none of them as a crash. How many panes are offered now.
pub fn mark_offer(conn: &Connection, ids: &[String]) -> Result<usize> {
    let mut n = 0;
    for id in ids {
        n += conn.execute(
            "UPDATE panes SET resume_next = 2
             WHERE id = ?1 AND resume_next IN (0, 3) AND agent_session <> ''",
            params![id],
        )?;
    }
    Ok(n + lives_out(conn)?)
}

/// The daemon is going on its own terms: each live mark becomes an offer
/// where there is a conversation to offer, and nothing where there is not.
fn lives_out(conn: &Connection) -> Result<usize> {
    let offered = conn.execute(
        "UPDATE panes SET resume_next = 2 WHERE resume_next = 3 AND agent_session <> ''",
        [],
    )?;
    conn.execute("UPDATE panes SET resume_next = 0 WHERE resume_next = 3", [])?;
    Ok(offered)
}

/// The marks the last daemon left. Read once by the daemon that comes up,
/// which keeps them in the runtime from there (`pane::Panes::mark_resume`,
/// `mark_offer`) and settles them here (`settle_marks`) only once it holds
/// the port: a successor that dies before then is started again, and must
/// find them again. A 5 is not read: it was seen, and this start lapses it.
pub fn read_resume(conn: &Connection) -> Result<ResumeMarks> {
    let mut stmt = conn.prepare(
        "SELECT id, resume_next, agent_session <> '' FROM panes
         WHERE resume_next <> 0 ORDER BY id",
    )?;
    let rows: Vec<(String, i64, bool)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut m = ResumeMarks::default();
    for (id, mark, session) in rows {
        match (mark, session) {
            (1, _) => m.planned.push(id),
            (2, _) => m.offered.push(id),
            (4, _) | (3, true) => {
                m.offered.push(id.clone());
                m.crashed.push(id);
            }
            _ => {}
        }
    }
    Ok(m)
}

/// The marks as this daemon holds them, once it has the port: a planned
/// restart's 1s are in its runtime now and stay here as offers, so a crash
/// before anyone comes back still offers them; a live 3 becomes the crash's
/// offer (4), or nothing without a session; a seen offer (5) lapses; a 2 or
/// a 4 nobody has seen stays as it is.
pub fn settle_marks(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE panes SET resume_next = CASE
           WHEN resume_next = 1 THEN 2
           WHEN resume_next = 3 AND agent_session <> '' THEN 4
           WHEN resume_next IN (2, 4) THEN resume_next
           ELSE 0 END
         WHERE resume_next <> 0",
        [],
    )?;
    Ok(())
}

/// A window has shown this start's offers: from here they survive one more
/// start, and lapse at the one after. How many aged.
pub fn age_offers(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE panes SET resume_next = 5 WHERE resume_next IN (2, 4)",
        [],
    )?)
}

/// An agent came into a running panel (`on`), or went (`off`). On, it is
/// written over an offer, which the agent's being there has answered, but
/// never over a planned restart's 1, which that restart still reads. It
/// does not ask for a session: the agent's first report can come before its
/// session is known, and the session is asked for when the mark is read.
/// Off, only a live mark goes. True when the row changed.
pub fn set_live(conn: &Connection, id: &str, on: bool) -> Result<bool> {
    let sql = if on {
        "UPDATE panes SET resume_next = 3 WHERE id = ?1 AND resume_next NOT IN (1, 3)"
    } else {
        "UPDATE panes SET resume_next = 0 WHERE id = ?1 AND resume_next = 3"
    };
    Ok(conn.execute(sql, params![id])? > 0)
}

/// The panel started, as the conversation or as its shell: whatever it was
/// marked to be, it has been. A live mark is not one of those.
pub fn spend(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE panes SET resume_next = 0 WHERE id = ?1 AND resume_next IN (1, 2, 4, 5)",
        params![id],
    )? > 0)
}

/// A daemon that ran longer than a mark may be held (`pane::MARKS_AT_MOST`)
/// lets its offers go here as it does in its runtime. How many went.
pub fn lapse_offers(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE panes SET resume_next = 0 WHERE resume_next IN (2, 4, 5)",
        [],
    )?)
}

/// The value itself, for the tests.
#[cfg(test)]
pub(crate) fn mark_of(conn: &Connection, id: &str) -> i64 {
    conn.query_row(
        "SELECT resume_next FROM panes WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .unwrap()
}

/// What a start reads, then settles: as one step, for the tests.
#[cfg(test)]
pub(crate) fn take_resume(conn: &Connection) -> Result<ResumeMarks> {
    let marks = read_resume(conn)?;
    settle_marks(conn)?;
    Ok(marks)
}
