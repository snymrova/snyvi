//! A promise a friend can see (1.48): a dated line on the reader's desk,
//! sent to a friend with Promise to…, lands on the friend's Home as "Sunny
//! said: post the release note · Fri 10:00". When the reader ticks the line
//! here, the existing Done frame goes across and the friend's row reads
//! kept ✓. The relay is unchanged; the Note frame only gains `due_at` and
//! `promise`, which a snyvi before 1.48 reads past as a plain line (usage
//! audit 63cc69c8c1, P6).
//!
//! Nothing new is stored. The outbox row of a promise names its line in
//! `re` (`note:<id>`) and carries its date in `extra`, two columns a line
//! sent to a friend never used; on the friend's side the date is said in
//! the row's own words.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};

/// What `re` says on a promise's outbox row, before the line's id.
pub const RE: &str = "note:";

/// Queue a promise: the line's words and date, to that friend, under a
/// fresh id as any line is. The frame id.
pub fn queue(
    conn: &Connection,
    peer: &crate::peer::Peer,
    note_id: i64,
    text: &str,
    due_at: i64,
    now: i64,
) -> Result<String> {
    let text: String = text.trim().chars().take(crate::peer::NOTE_CHARS).collect();
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|e| anyhow!("reading random bytes for a promise's id: {e}"))?;
    let id = blake3::hash(&nonce).to_hex().to_string();
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, text, re, extra, queued_at) VALUES(?1, ?2, '', ?3, ?4, ?5, ?6)",
        params![id, peer.id, text, format!("{RE}{note_id}"), due_at.max(0).to_string(), now],
    )?;
    Ok(id)
}

/// The date and the promise mark a line's outbox row carries, for its
/// frame: `(due_at, promise)`.
pub fn of_row(re: &str, extra: &str) -> (i64, bool) {
    if re.starts_with(RE) {
        (extra.parse().unwrap_or(0), true)
    } else {
        (0, false)
    }
}

/// A promise as the friend's Home row says it: the words, and by when in
/// the friend's own time.
pub fn said(text: &str, due_at: i64, now: i64) -> String {
    if due_at > 0 {
        format!("{text} · by {}", crate::due::label(due_at, now))
    } else {
        text.to_string()
    }
}

/// Who each of a desk's lines was promised to, by line id: the `→ Trapti`
/// mark on the rail, and whether it was kept.
pub fn promised(conn: &Connection, desk_id: i64) -> Result<Vec<(i64, String, bool)>> {
    Ok(conn
        .prepare(
            "SELECT CAST(substr(o.re, 6) AS INTEGER), p.name, o.done_at != 0 FROM peer_outbox o
             JOIN peers p ON p.id = o.peer_id
             JOIN desk_notes n ON n.id = CAST(substr(o.re, 6) AS INTEGER)
             WHERE o.re LIKE 'note:%' AND o.kind = '' AND n.desk_id = ?1",
        )?
        .query_map(params![desk_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The clock: every promise whose line was ticked here and not yet told
/// queues one Done frame to its friend, once. The friends to flush to.
pub fn keep(conn: &Connection, now: i64) -> Result<Vec<i64>> {
    let kept: Vec<(String, i64, String, String)> = conn
        .prepare(
            "SELECT o.id, o.peer_id, o.text, n.done_commit FROM peer_outbox o
             JOIN desk_notes n ON n.id = CAST(substr(o.re, 6) AS INTEGER)
             JOIN peers p ON p.id = o.peer_id
             WHERE o.re LIKE 'note:%' AND o.kind = '' AND o.done_at = 0 AND o.sent_at != 0
               AND n.done_at != 0 AND p.removed_at = 0",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut peers = Vec::new();
    for (frame, peer_id, text, commit) in kept {
        let Some(p) = crate::peer::list(conn)?
            .into_iter()
            .find(|p| p.id == peer_id)
        else {
            continue;
        };
        crate::peer::queue_kind(conn, &p, "done", &frame, &text, &commit, now)?;
        conn.execute(
            "UPDATE peer_outbox SET done_at = ?2, done_commit = ?3 WHERE id = ?1",
            params![frame, now, commit],
        )?;
        peers.push(peer_id);
    }
    peers.sort_unstable();
    peers.dedup();
    Ok(peers)
}

/// The friend kept a promise they made to the reader: their Done names the
/// promise's frame, which arrived here as a Home row. The row says kept ✓.
/// The line's words, when it was one.
pub fn kept(conn: &Connection, peer_id: i64, frame: &str) -> Result<Option<String>> {
    let n = conn.execute(
        "UPDATE peer_notes SET text = text || ' · kept ✓' WHERE peer_id = ?1 AND frame = ?2 AND frame != ''
           AND text NOT LIKE '% · kept ✓'",
        params![peer_id, frame],
    )?;
    if n == 0 {
        return Ok(None);
    }
    Ok(conn
        .query_row(
            "SELECT text FROM peer_notes WHERE peer_id = ?1 AND frame = ?2",
            params![peer_id, frame],
            |r| r.get(0),
        )
        .ok())
}

#[cfg(test)]
mod tests;
