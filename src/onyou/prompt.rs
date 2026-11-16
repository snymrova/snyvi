//! Claude's own prompt, open in a panel (1.67, plan f586a9fe09): a permission
//! to give, a dialog to answer. Its agent is as stuck on the reader as one
//! that asked through snyvi, and On you never said so: with three of them
//! open on three desks it read "Nothing is waiting on you."
//!
//! It is answered only in its panel -- snyvi types nothing into a prompt it
//! did not draw (`pane::Live::press` refuses one) -- so the row has one
//! thing on it, Go to panel. Nothing is stored: the row is there while the
//! panel says `needs_you` and gone with it.

use super::Row;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// One Waiting row per panel with a prompt open, on a desk that is open.
/// Its words are the dialog's question when the mod holds one for that
/// panel, and snyvi's own otherwise: a permission's text never reaches it.
pub(super) fn rows(
    conn: &Connection,
    desks: &HashMap<i64, String>,
    prompts: &[(String, i64)],
    rows: &mut Vec<Row>,
) -> Result<()> {
    for (pane, since) in prompts {
        let at: Option<(i64, String, i64)> = conn
            .prepare_cached("SELECT desk_id, name, slot FROM panes WHERE id = ?1")?
            .query_row(params![pane], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        let Some((desk, name, slot)) = at else {
            continue;
        };
        let Some(desk_name) = desks.get(&desk) else {
            continue;
        };
        let asked: Option<String> = conn
            .prepare_cached(
                "SELECT text FROM turns WHERE desk_id = ?1 AND pane = ?2 AND via = 'dialog'
                   AND answered_at = 0 AND removed_at = 0 ORDER BY id DESC LIMIT 1",
            )?
            .query_row(params![desk, pane], |r| r.get(0))
            .optional()?;
        rows.push(Row {
            kind: "prompt",
            shelf: "waiting",
            rank: 1,
            desk,
            desk_name: desk_name.clone(),
            text: asked.unwrap_or_else(|| "Claude has a prompt open".into()),
            at: *since,
            pane: pane.clone(),
            slot,
            panel: if name.is_empty() {
                format!("panel {slot}")
            } else {
                name
            },
            ..Row::default()
        });
    }
    Ok(())
}
