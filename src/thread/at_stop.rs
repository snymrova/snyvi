//! Pressing is sending (1.66): what a panel's Stop takes back to its agent.

use super::*;

/// 1.66, pressing is sending: the answers to this panel's own questions not
/// yet told, taken as its turn stops, so the Stop hook carries them back.
pub fn take_untold_here(
    conn: &Connection,
    desk_id: i64,
    pane: &str,
    now: i64,
) -> Result<Vec<Turn>> {
    let mut st = conn.prepare(&format!(
        "SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND pane = ?2 AND removed_at = 0
         AND answered_at != 0 AND told_at = 0 AND via != 'dialog' ORDER BY answered_at, id LIMIT 8"
    ))?;
    let v: Vec<Turn> = st
        .query_map(params![desk_id, pane], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    for t in &v {
        conn.execute(
            "UPDATE turns SET told_at = ?2 WHERE id = ?1",
            params![t.id, now],
        )?;
    }
    Ok(v)
}
