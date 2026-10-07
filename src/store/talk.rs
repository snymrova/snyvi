//! What a friend's snyvi says back, and where a friend's document is a file
//! here: pairing's second cut (`crate::peer`, 1.23) and #99, kept beside
//! the store rather than in it, which is long enough.

use super::*;

/// Where a document is a file on this machine, if it is one: where Save
/// wrote a friend's document (`docs.saved_path`); a friend's document filed
/// into a folder both have, at its place in it, when that file is there;
/// else the file it was sent from, unless a friend sent it -- their path
/// names nothing here, and an agent handed it finds nothing (#99).
pub(super) fn local_path(
    source: Option<&str>,
    saved: Option<String>,
    origin: &str,
    filed: bool,
    root: &str,
) -> Option<String> {
    if saved.is_some() {
        return saved;
    }
    let source = source?;
    if origin != "peer" {
        return Some(source.to_string());
    }
    // Only a place that stays inside the folder: relative, no `..`, no
    // drive (`peer::safe_path`), with this system's separators.
    let rel = crate::peer::safe_path(source).filter(|_| filed)?;
    let at = rel
        .split('/')
        .fold(std::path::PathBuf::from(root), |p, c| p.join(c));
    at.is_file().then(|| at.to_string_lossy().to_string())
}

impl Store {
    /// Where Save wrote a friend's document: the file Copy path copies from
    /// then on (`local_path`). `unfile` leaves it, since the file stays.
    pub fn set_saved_path(&self, id: &str, path: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE docs SET saved_path = ?2 WHERE id = ?1",
            params![id, path],
        )?;
        Ok(())
    }

    pub fn peer_set_v(&self, id: i64, v: u32) -> Result<()> {
        peer::set_v(&self.conn.lock().unwrap(), id, v)
    }

    pub fn peer_read_receipts(&self, id: i64, on: bool) -> Result<bool> {
        peer::set_read_receipts(&self.conn.lock().unwrap(), id, on)
    }

    pub fn peer_queue_kind(
        &self,
        p: &peer::Peer,
        kind: &str,
        re: &str,
        text: &str,
        extra: &str,
    ) -> Result<String> {
        peer::queue_kind(&self.conn.lock().unwrap(), p, kind, re, text, extra, now())
    }

    pub fn peer_sent_recent(&self, limit: i64) -> Result<Vec<peer::Sent>> {
        peer::sent_recent(&self.conn.lock().unwrap(), limit)
    }

    pub fn peer_receipt(&self, peer_id: i64, of: &str, state: &str) -> Result<bool> {
        peer::receipt(&self.conn.lock().unwrap(), peer_id, of, state, now())
    }

    pub fn peer_done(&self, peer_id: i64, of: &str, commit: &str) -> Result<Option<String>> {
        peer::done(&self.conn.lock().unwrap(), peer_id, of, commit, now())
    }

    pub fn peer_sent_doc(&self, peer_id: i64, doc_id: &str) -> Result<bool> {
        peer::sent_doc(&self.conn.lock().unwrap(), peer_id, doc_id)
    }

    pub fn peer_add_reply(&self, peer_id: i64, doc_id: &str, text: &str) -> Result<Option<String>> {
        peer::add_reply(&self.conn.lock().unwrap(), peer_id, doc_id, text, now())
    }

    /// The replies to a document, over every version of it.
    pub fn peer_replies(&self, id: &str) -> Result<Vec<peer::Reply>> {
        let ids: Vec<String> = match self.get(id)? {
            Some(Doc {
                project_id,
                source_path: Some(sp),
                ..
            }) => self
                .history(project_id, &sp)?
                .into_iter()
                .map(|d| d.id)
                .collect(),
            _ => vec![id.to_string()],
        };
        peer::replies(&self.conn.lock().unwrap(), &ids)
    }

    /// The frame a friend's document came in, and the sender's id for it:
    /// what a read receipt and a reply answer.
    pub fn set_peer_frame(&self, id: &str, frame: &str, sender_id: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE docs SET peer_frame = ?2, peer_ref = ?3 WHERE id = ?1",
            params![id, frame, sender_id],
        )?;
        Ok(())
    }

    /// A friend's document's sender key, frame and the sender's id for it,
    /// when it is one: empty strings otherwise.
    pub fn peer_frame(&self, id: &str) -> Result<(String, String, String)> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT peer_key, peer_frame, peer_ref FROM docs WHERE id = ?1 AND origin = 'peer'",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .unwrap_or_default())
    }

    /// A desk's line that came from a friend: which friend, and the frame,
    /// so ticking it can be told back (`desk::tell_of`).
    pub fn link_note_frame(&self, note_id: i64, peer_id: i64, frame: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE desk_notes SET sent_peer = ?2, sent_frame = ?3 WHERE id = ?1",
            params![note_id, peer_id, frame],
        )?;
        Ok(())
    }

    /// What Tell X ✓ sends for a ticked line: the friend, the frame, the
    /// line and its commit. `None` for a line no friend sent, one not done,
    /// or one told already.
    pub fn note_to_tell(
        &self,
        desk_id: i64,
        id: i64,
    ) -> Result<Option<(i64, String, String, String)>> {
        Ok(self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT sent_peer, sent_frame, text, done_commit FROM desk_notes
                 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND done_at != 0
                   AND sent_peer != 0 AND sent_frame != '' AND told_at = 0",
                params![desk_id, id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?)
    }

    pub fn note_told(&self, desk_id: i64, id: i64) -> Result<bool> {
        Ok(self.conn.lock().unwrap().execute(
            "UPDATE desk_notes SET told_at = ?3 WHERE desk_id = ?1 AND id = ?2 AND told_at = 0",
            params![desk_id, id, now()],
        )? > 0)
    }
}
