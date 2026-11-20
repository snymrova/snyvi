//! What a press types back for an `ask` card (1.67, `server::press`). A part of
//! `thread`, kept apart for its size.

use super::*;

/// Every question of one `ask` card still on the list, in the order asked:
/// what a press types back once the card's last one is answered (1.67,
/// `server::press`).
pub fn group_turns(conn: &Connection, desk_id: i64, group: i64) -> Result<Vec<Turn>> {
    let mut st = conn.prepare(&format!(
        "SELECT {TURN_COLS} FROM turns WHERE desk_id = ?1 AND ask_group = ?2 AND removed_at = 0
         ORDER BY id"
    ))?;
    let v = st
        .query_map(params![desk_id, group], row_to_turn)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(v)
}
