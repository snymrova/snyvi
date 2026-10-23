//! The friends' side of the store (`crate::peer`), moved out of `store.rs`
//! when it reached its 2,500 lines: thin, like the desk's -- the SQL is in
//! `peer`, the lock and the clock are here, so `api_peer` and the link never
//! see a connection.

use super::*;

impl Store {
    /// Every friend, removed ones included (`peer::list`).
    pub fn peers(&self) -> Result<Vec<peer::Peer>> {
        peer::list(&self.conn.lock().unwrap())
    }

    pub fn peer(&self, id: i64) -> Result<Option<peer::Peer>> {
        peer::get(&self.conn.lock().unwrap(), id)
    }

    /// By address: the sender a frame names, looked up before it is opened.
    pub fn peer_by_key(&self, key: &str) -> Result<Option<peer::Peer>> {
        peer::by_sign_key(&self.conn.lock().unwrap(), key)
    }

    /// By the name the reader gave them, as an agent's offer says it.
    pub fn peer_by_name(&self, name: &str) -> Result<Option<peer::Peer>> {
        peer::by_name(&self.conn.lock().unwrap(), name)
    }

    /// Pin a friend's keys at pairing (`peer::pin`): the row as it stands,
    /// its name kept if the reader renamed them before.
    pub fn pin_peer(&self, p: &peer::Peer) -> Result<peer::Peer> {
        peer::pin(&self.conn.lock().unwrap(), p, now())
    }

    pub fn rename_peer(&self, id: i64, name: &str) -> Result<bool> {
        peer::rename(&self.conn.lock().unwrap(), id, name)
    }

    /// Where a friend's things land (`peer::set_desk`).
    pub fn set_peer_desk(&self, id: i64, desk_id: i64) -> Result<bool> {
        peer::set_desk(&self.conn.lock().unwrap(), id, desk_id)
    }

    pub fn mute_peer(&self, id: i64, muted: bool) -> Result<bool> {
        peer::mute(&self.conn.lock().unwrap(), id, muted)
    }

    /// Off the list, keys kept (`peer::remove`).
    pub fn remove_peer(&self, id: i64) -> Result<bool> {
        peer::remove(&self.conn.lock().unwrap(), id, now())
    }

    pub fn restore_peer(&self, id: i64) -> Result<bool> {
        peer::restore(&self.conn.lock().unwrap(), id)
    }

    /// Something came from them (`from`) or went to them: the dates Home shows.
    pub fn touch_peer(&self, id: i64, from: bool) -> Result<()> {
        peer::touch(&self.conn.lock().unwrap(), id, from, now())
    }

    /// Queue a document for a friend (`peer::queue`): the frame's id, one per
    /// document and friend, so a resend replaces at the relay.
    pub fn peer_queue(&self, p: &peer::Peer, doc_id: &str) -> Result<String> {
        peer::queue(&self.conn.lock().unwrap(), p, doc_id, now())
    }

    /// What has not gone yet and is due at `now` (`peer::unsent`).
    pub fn peer_unsent(&self, now: i64) -> Result<Vec<peer::Unsent>> {
        peer::unsent(&self.conn.lock().unwrap(), now)
    }

    /// Queue a line for a friend (`peer::queue_note`): the frame's id.
    pub fn peer_queue_note(&self, p: &peer::Peer, text: &str) -> Result<String> {
        peer::queue_note(&self.conn.lock().unwrap(), p, text, now())
    }

    pub fn peer_sent(&self, id: &str) -> Result<()> {
        peer::sent(&self.conn.lock().unwrap(), id, now())
    }

    pub fn peer_failed(&self, id: &str, why: &str) -> Result<()> {
        peer::failed(&self.conn.lock().unwrap(), id, why)
    }

    /// Not now (`peer::waiting`): `until` when the relay named the moment.
    pub fn peer_waiting(&self, id: &str, why: &str, until: Option<i64>) -> Result<()> {
        peer::waiting(&self.conn.lock().unwrap(), id, why, now(), until)
    }

    /// A friend's lines waiting on Home (`peer::notes_waiting`).
    pub fn peer_notes(&self) -> Result<Vec<peer::PeerNote>> {
        peer::notes_waiting(&self.conn.lock().unwrap())
    }

    /// A friend's line, its date and whether it is their promise
    /// (`peer::note_arrived`).
    pub fn peer_note_arrived(
        &self,
        peer_id: i64,
        text: &str,
        frame: &str,
        due_at: i64,
        promise: bool,
    ) -> Result<i64> {
        peer::note_arrived(&self.conn.lock().unwrap(), peer_id, text, frame, due_at, promise, now())
    }

    /// `what`: taken, remove, restore (`peer::settle_note`).
    pub fn settle_peer_note(&self, id: i64, what: &str) -> Result<bool> {
        peer::settle_note(&self.conn.lock().unwrap(), id, what, now())
    }

    /// An agent's offers still open (`peer::offers_open`).
    pub fn peer_offers(&self) -> Result<Vec<peer::Offer>> {
        peer::offers_open(&self.conn.lock().unwrap())
    }

    pub fn peer_offer(
        &self,
        peer_id: i64,
        doc_id: &str,
        text: &str,
        pane: &str,
        by: &str,
    ) -> Result<i64> {
        peer::offer(
            &self.conn.lock().unwrap(),
            peer_id,
            doc_id,
            text,
            pane,
            by,
            now(),
        )
    }

    pub fn peer_offer_get(&self, id: i64) -> Result<Option<peer::Offer>> {
        peer::offer_get(&self.conn.lock().unwrap(), id)
    }

    pub fn answer_peer_offer(&self, id: i64, sent: bool) -> Result<bool> {
        peer::answer_offer(&self.conn.lock().unwrap(), id, sent, now())
    }

    pub fn reopen_peer_offer(&self, id: i64) -> Result<bool> {
        peer::reopen_offer(&self.conn.lock().unwrap(), id)
    }

    pub fn drop_peer_offers_of(&self, pane: &str) -> Result<usize> {
        peer::drop_offers_of(&self.conn.lock().unwrap(), pane, now())
    }

    /// Whether a frame from the relay was already brought in (`peer::taken`):
    /// the link may be handed one twice when its ack was lost.
    pub fn peer_taken(&self, id: &str) -> Result<bool> {
        peer::taken(&self.conn.lock().unwrap(), id)
    }

    pub fn peer_take(&self, id: &str) -> Result<()> {
        peer::take(&self.conn.lock().unwrap(), id, now())
    }

    /// Forget what was taken more than eight days ago: the relay itself
    /// keeps nothing past seven, so nothing older can come again.
    pub fn prune_peer_taken(&self) -> Result<usize> {
        peer::prune_taken(&self.conn.lock().unwrap(), now() - peer::TAKEN_KEPT)
    }

    /// What waits in the outbox, per frame (`peer::outgoing`).
    pub fn peer_outgoing(&self) -> Result<Vec<peer::Outgoing>> {
        peer::outgoing(&self.conn.lock().unwrap())
    }

    pub fn peer_retry(&self, id: &str) -> Result<bool> {
        peer::retry(&self.conn.lock().unwrap(), id)
    }

    /// Hold a frame of a kind this snyvi does not read (`peer::hold`).
    pub fn peer_hold(&self, id: &str, peer_id: i64, bytes: &[u8]) -> Result<()> {
        peer::hold(&self.conn.lock().unwrap(), id, peer_id, bytes, now())
    }

    pub fn peer_held(&self) -> Result<Vec<(String, i64, Vec<u8>)>> {
        peer::held(&self.conn.lock().unwrap())
    }

    pub fn peer_unhold(&self, id: &str) -> Result<()> {
        peer::unhold(&self.conn.lock().unwrap(), id)
    }

    /// Let go of held frames older than `peer::HELD_KEPT`.
    pub fn prune_peer_held(&self) -> Result<usize> {
        peer::prune_held(&self.conn.lock().unwrap(), now() - peer::HELD_KEPT)
    }

    // 1.49: friends, one build (audit 6f451571c6).

    /// When this very document already arrived at that friend (`peer::already`).
    pub fn peer_already(&self, p: &peer::Peer, doc_id: &str) -> Result<Option<i64>> {
        peer::already(&self.conn.lock().unwrap(), p, doc_id)
    }

    /// The line kept a frame for an away friend (`peer::held_mark`).
    pub fn peer_held_mark(&self, id: &str) -> Result<()> {
        peer::held_mark(&self.conn.lock().unwrap(), id, now())
    }

    /// Where a document went, every version of it (`peer::sent_of_doc`):
    /// each friend's name and their newest send.
    pub fn peer_sent_of_doc(&self, id: &str) -> Result<Vec<(String, peer::Sent)>> {
        let ids = self.version_ids(id)?;
        peer::sent_of_doc(&self.conn.lock().unwrap(), &ids)
    }

    /// Everything between the reader and one friend (`peer::timeline::timeline`).
    pub fn peer_timeline(
        &self,
        p: &peer::Peer,
        before: i64,
        limit: usize,
    ) -> Result<Vec<peer::timeline::Item>> {
        peer::timeline::timeline(&self.conn.lock().unwrap(), p, before, limit)
    }

    /// Every version's id of the document `id` is one of, itself when it
    /// has no file to be versions of: one conversation, one set of sends.
    pub fn version_ids(&self, id: &str) -> Result<Vec<String>> {
        Ok(match self.get(id)? {
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
        })
    }
}
