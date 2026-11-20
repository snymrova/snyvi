//! The outbox: what waits to go to a friend, one row per frame -- a
//! document, a line, or a kind that answers a frame -- and what each row
//! says about its way there. Moved out of `peer.rs` in 1.67, which was at
//! its 2,500 lines; nothing in it changed in the move.

use super::*;

/// A document queued for a friend; the same document for the same friend is
/// the same row, queued again. What came back about the last time it went
/// goes with it: a resend has not arrived, been read or been held yet, and
/// the row must not say it has (audit 6f451571c6, F3).
#[cfg(test)]
pub fn queue(conn: &Connection, peer: &Peer, doc_id: &str, now: i64) -> Result<String> {
    queue_doc(conn, peer, doc_id, false, now)
}

/// `extra` on a document's row: the reader asked the friend to review it
/// (1.67). The frame says `review`; a snyvi before 1.67 reads past it and
/// keeps a plain document.
pub const REVIEW: &str = "review";

/// `queue`, saying whether the friend is asked to review it. A resend says
/// it again, so a resend without the ask takes it back.
pub fn queue_doc(
    conn: &Connection,
    peer: &Peer,
    doc_id: &str,
    review: bool,
    now: i64,
) -> Result<String> {
    let id = frame_id(doc_id, &peer.sign_key);
    let extra = if review { REVIEW } else { "" };
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, extra, queued_at) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET queued_at = excluded.queued_at, extra = excluded.extra, sent_at = 0, tries = 0,
           later = 0, next_at = 0, error = '', arrived_at = 0, read_at = 0, held_at = 0",
        params![id, peer.id, doc_id, extra, now],
    )?;
    // The reader believes they are there: whatever else waits for them goes too.
    due_now(conn, peer.id)?;
    Ok(id)
}

/// When this very document already arrived at that friend, if it did: a
/// document is immutable, so the same id is the same bytes, and sending it
/// again would put nothing new in front of them (F14). A new version has
/// an id of its own and is never "already" there.
pub fn already(conn: &Connection, peer: &Peer, doc_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT arrived_at FROM peer_outbox WHERE id = ?1 AND arrived_at != 0",
            params![frame_id(doc_id, &peer.sign_key)],
            |r| r.get(0),
        )
        .optional()?)
}

/// The line kept a frame for a friend who is away (`LineSaid::Held`): sent,
/// as far as the reader can do anything, but not with them yet. Said once.
pub fn held_mark(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET held_at = ?2 WHERE id = ?1 AND held_at = 0 AND arrived_at = 0",
        params![id, now],
    )?;
    Ok(())
}

/// A line queued for a friend, as a document is: said once, so each is its
/// own row under a fresh id, and it goes when the relay can be reached.
#[cfg(test)]
pub fn queue_note(conn: &Connection, peer: &Peer, text: &str, now: i64) -> Result<String> {
    queue_line(conn, peer, text, "", now)
}

/// The outbox's columns from 1.67: the folder a line was written about
/// (`root`), and on a document that arrived, whether its sender asked for a
/// review (`docs.peer_review`: 1 asked, 2 answered).
pub const COLUMNS_1_67: &str = "ALTER TABLE peer_outbox ADD COLUMN root TEXT NOT NULL DEFAULT '';
ALTER TABLE docs ADD COLUMN peer_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE peer_offers ADD COLUMN review INTEGER NOT NULL DEFAULT 0;";

/// `queue_note`, with the folder of the desk the line was written on
/// (1.67): the frame carries that folder's fingerprint when it goes
/// (`api_peer::folder_of_root`), so it lands on the friend's desk for the
/// same repository. The path never leaves; only the fingerprint does.
pub fn queue_line(
    conn: &Connection,
    peer: &Peer,
    text: &str,
    root: &str,
    now: i64,
) -> Result<String> {
    let text: String = text.trim().chars().take(NOTE_CHARS).collect();
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|e| anyhow!("reading random bytes for a line's id: {e}"))?;
    let id = blake3::hash(&nonce).to_hex().to_string();
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, text, root, queued_at) VALUES(?1, ?2, '', ?3, ?4, ?5)",
        params![id, peer.id, text, root, now],
    )?;
    due_now(conn, peer.id)?;
    Ok(id)
}

/// One of the kinds that answer a frame (`Content::Receipt`, `Reply`,
/// `Done`), queued: `re` is what it answers, `extra` a done line's commit.
/// A receipt's id is the frame and the state it says, so the same receipt
/// twice is one row; a reply or a done is said once, and is its own.
pub fn queue_kind(
    conn: &Connection,
    peer: &Peer,
    kind: &str,
    re: &str,
    text: &str,
    extra: &str,
    now: i64,
) -> Result<String> {
    let id = if kind == "receipt" {
        blake3::hash(format!("receipt {re} {text} {}", peer.sign_key).as_bytes())
            .to_hex()
            .to_string()
    } else {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce)
            .map_err(|e| anyhow!("reading random bytes for a frame's id: {e}"))?;
        blake3::hash(&nonce).to_hex().to_string()
    };
    let text: String = text.trim().chars().take(REPLY_CHARS).collect();
    conn.execute(
        "INSERT INTO peer_outbox(id, peer_id, doc_id, text, kind, re, extra, queued_at) VALUES(?1, ?2, '', ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO NOTHING",
        params![id, peer.id, text, kind, re, extra, now],
    )?;
    Ok(id)
}

/// A frame waiting in the outbox: a document (`doc_id`), a line (`text`),
/// or one that answers a frame (`kind`, with `re` and `extra`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unsent {
    pub id: String,
    pub peer_id: i64,
    pub doc_id: String,
    pub text: String,
    pub tries: i64,
    pub kind: String,
    pub re: String,
    pub extra: String,
    /// How many times running the relay said "not now" (`waiting`).
    pub later: i64,
    /// A line's folder, on this machine (`queue_line`); empty for the rest.
    pub root: String,
}

/// What has not gone yet and is due at `now`, oldest first. A frame the
/// relay said "not now" to waits until its `next_at` (`waiting`); a new one
/// has none and goes first. Every flush -- the ten-minute tick, a wake, a
/// link opening -- reads this, so a wake sends only what is due.
pub fn unsent(conn: &Connection, now: i64) -> Result<Vec<Unsent>> {
    let mut st = conn.prepare(&format!(
        "{UNSENT_SQL} WHERE o.sent_at = 0 AND p.removed_at = 0 AND o.next_at <= ?1 ORDER BY o.queued_at, o.id"
    ))?;
    let rows = st
        .query_map(params![now], row_unsent)?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// One frame by id, due or not: the reader pressing Send loads one row, not
/// every unsent one.
pub fn unsent_one(conn: &Connection, id: &str) -> Result<Option<Unsent>> {
    let mut st = conn.prepare(&format!(
        "{UNSENT_SQL} WHERE o.id = ?1 AND o.sent_at = 0 AND p.removed_at = 0"
    ))?;
    let row = st.query_row(params![id], row_unsent).optional()?;
    Ok(row)
}

const UNSENT_SQL: &str =
    "SELECT o.id, o.peer_id, o.doc_id, o.text, o.tries, o.kind, o.re, o.extra, o.later, o.root
    FROM peer_outbox o JOIN peers p ON p.id = o.peer_id";

fn row_unsent(r: &rusqlite::Row) -> rusqlite::Result<Unsent> {
    Ok(Unsent {
        id: r.get(0)?,
        peer_id: r.get(1)?,
        doc_id: r.get(2)?,
        text: r.get(3)?,
        tries: r.get(4)?,
        kind: r.get(5)?,
        re: r.get(6)?,
        extra: r.get(7)?,
        later: r.get(8)?,
        root: r.get(9)?,
    })
}

pub fn sent(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET sent_at = ?2, error = '' WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn failed(conn: &Connection, id: &str, why: &str) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET tries = tries + 1, error = ?2 WHERE id = ?1",
        params![id, why.chars().take(200).collect::<String>()],
    )?;
    Ok(())
}

/// Not sent, and nothing wrong (`Deposit::Later`): the row says why it
/// waits, and keeps its tries, so a friend away for a week does not leave
/// it stranded at `TRIES_MAX`. When the relay named the moment (`until`:
/// a Retry-After, or a busy relay's minute) the row waits exactly that
/// long and the wait is the relay's, not the friend's, so `later` stays.
/// Otherwise the friend is away: `later` counts the run of "not now"s and
/// the wait doubles from ten minutes, 20, 40, 80, 160, 320, to six hours
/// (`LATER_MAX` of them, thirty days at six hours, and the frame stops,
/// with Retry). The power is capped, so no run of misses overflows.
pub fn waiting(conn: &Connection, id: &str, why: &str, now: i64, until: Option<i64>) -> Result<()> {
    let why: String = why.chars().take(200).collect();
    match until {
        Some(at) => conn.execute(
            "UPDATE peer_outbox SET error = ?2, next_at = ?3 WHERE id = ?1",
            params![id, why, at.max(now)],
        )?,
        None => conn.execute(
            "UPDATE peer_outbox SET error = ?2, later = later + 1,
                next_at = ?3 + min(600 * (1 << min(later, 6)), 21600) WHERE id = ?1",
            params![id, why, now],
        )?,
    };
    Ok(())
}

/// Sent down the line, waiting for the friend's ack: tried again in ten
/// minutes if none comes, and a try is spent, so a line that never acks
/// ends at `TRIES_MAX` like a relay that never answers.
pub fn pending(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE peer_outbox SET tries = tries + 1, error = '', next_at = ?2 + 600 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// A friend is here -- something came from them, their snyvi updated, their
/// line opened, the reader sent them something new -- so what waits for
/// them is due now, and its run of "not now"s starts over.
pub fn due_now(conn: &Connection, peer_id: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE peer_outbox SET next_at = 0, later = 0 WHERE peer_id = ?1 AND sent_at = 0 AND (next_at != 0 OR later != 0)",
        params![peer_id],
    )?)
}

/// "Not now" answers in a row after which a frame stops: thirty days at
/// the six-hour wait.
pub const LATER_MAX: i64 = 124;

/// What waits in the outbox, for the friends list to show: each frame not
/// gone, what it is, how often it failed and why. A frame at `stopped` tries
/// is not tried again until the reader says Retry.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Outgoing {
    pub id: String,
    pub peer_id: i64,
    /// The document's title, or the line.
    pub what: String,
    pub queued_at: i64,
    pub tries: i64,
    pub error: String,
    /// The run of "not now" answers (`waiting`): the Friends card says
    /// stopped at `LATER_MAX` of them.
    pub later: i64,
}

pub fn outgoing(conn: &Connection) -> Result<Vec<Outgoing>> {
    let rows = conn
        .prepare(
            "SELECT o.id, o.peer_id, COALESCE(d.title, o.text), o.queued_at, o.tries, o.error, o.later
             FROM peer_outbox o JOIN peers p ON p.id = o.peer_id LEFT JOIN docs d ON d.id = o.doc_id AND o.doc_id != ''
             WHERE o.sent_at = 0 AND p.removed_at = 0 AND o.kind != 'receipt' ORDER BY o.queued_at, o.id",
        )?
        .query_map([], |r| {
            Ok(Outgoing {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                what: r.get(2)?,
                queued_at: r.get(3)?,
                tries: r.get(4)?,
                error: r.get(5)?,
                later: r.get(6)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}
