//! Everything between the reader and one friend, both ways, newest first:
//! what the page for a friend lists (`/friend/{id}`, `ui/friend.js`,
//! audit 6f451571c6 cut C). Nothing is stored for it; it is read from the
//! tables the rest already keeps -- their documents (`docs`, by the key
//! they were signed with), what went to them (`peer_outbox`), their lines
//! and promises (`peer_notes`), and the replies under documents both ways
//! (`peer_replies`) -- and merged by time.

use super::*;

/// One thing that passed between the reader and the friend.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Item {
    /// A stable key for the page: `d:` a document, `o:` an outbox row,
    /// `n:` a line of theirs, `r:` a reply.
    pub key: String,
    /// doc, line, promise or reply.
    pub kind: &'static str,
    /// `in` from them, `out` from the reader.
    pub dir: &'static str,
    pub at: i64,
    /// The document's title, or the line or reply's words.
    pub text: String,
    /// The document it is, or the one a reply is about.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc_id: String,
    /// A line of theirs, by its id (`peer_notes`), for Keep and ✕.
    #[serde(skip_serializing_if = "is_zero")]
    pub note_id: i64,
    /// What went: when, and what came back about it.
    #[serde(skip_serializing_if = "is_zero")]
    pub sent_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub held_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub arrived_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub read_at: i64,
    /// A line ticked (theirs told back, or the reader's told them), or a
    /// promise kept.
    #[serde(skip_serializing_if = "is_zero")]
    pub done_at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub commit: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub due_at: i64,
    /// A line of theirs kept on a desk, or put away.
    #[serde(skip_serializing_if = "is_zero")]
    pub taken_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub removed_at: i64,
    /// What has not gone says why it waits.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub waiting: String,
}

/// The newest `limit` items before `before` (0: from now), newest first.
pub fn timeline(conn: &Connection, peer: &Peer, before: i64, limit: usize) -> Result<Vec<Item>> {
    let before = if before > 0 { before } else { i64::MAX };
    let n = limit as i64;
    let mut out = Vec::new();
    // Their documents, every version, by the key that signed them.
    let mut st = conn.prepare(
        "SELECT id, title, received_at FROM docs
         WHERE origin = 'peer' AND peer_key = ?1 AND deleted_at = 0 AND received_at < ?2
         ORDER BY received_at DESC LIMIT ?3",
    )?;
    for r in st.query_map(params![peer.sign_key, before, n], |r| {
        Ok(Item {
            key: format!("d:{}", r.get::<_, String>(0)?),
            kind: "doc",
            dir: "in",
            doc_id: r.get(0)?,
            text: r.get(1)?,
            at: r.get(2)?,
            ..Default::default()
        })
    })? {
        out.push(r?);
    }
    // What went to them: documents, lines and promises (`kind` ''), with
    // what came back about each. A reply of the reader's is read from the
    // replies, below, where it is kept with the document it is about.
    let mut st = conn.prepare(
        "SELECT o.id, o.doc_id, COALESCE(d.title, o.text), o.queued_at, o.sent_at, o.held_at, o.arrived_at,
                o.read_at, o.done_at, o.done_commit, o.re LIKE 'note:%', o.extra, o.error
         FROM peer_outbox o LEFT JOIN docs d ON d.id = o.doc_id AND o.doc_id != ''
         WHERE o.peer_id = ?1 AND o.kind = '' AND o.queued_at < ?2
         ORDER BY o.queued_at DESC LIMIT ?3",
    )?;
    for r in st.query_map(params![peer.id, before, n], |r| {
        let doc_id: String = r.get(1)?;
        let promise: bool = r.get(10)?;
        let extra: String = r.get(11)?;
        let sent_at: i64 = r.get(4)?;
        Ok(Item {
            key: format!("o:{}", r.get::<_, String>(0)?),
            kind: if !doc_id.is_empty() {
                "doc"
            } else if promise {
                "promise"
            } else {
                "line"
            },
            dir: "out",
            text: r.get(2)?,
            at: r.get(3)?,
            sent_at,
            held_at: r.get(5)?,
            arrived_at: r.get(6)?,
            read_at: r.get(7)?,
            done_at: r.get(8)?,
            commit: r.get(9)?,
            due_at: if promise { extra.parse().unwrap_or(0) } else { 0 },
            waiting: if sent_at == 0 { r.get(12)? } else { String::new() },
            doc_id,
            ..Default::default()
        })
    })? {
        out.push(r?);
    }
    // Their lines and promises, kept or not. A line of theirs the reader
    // ticked and told is said by the desk's line (`sent_frame`, `told_at`).
    let mut st = conn.prepare(
        "SELECT n.id, n.text, n.arrived_at, n.due_at, n.promise, n.kept_at, n.kept_commit, n.taken_at, n.removed_at,
                COALESCE((SELECT dn.told_at FROM desk_notes dn WHERE dn.sent_peer = n.peer_id AND dn.sent_frame = n.frame
                          AND n.frame != '' LIMIT 1), 0)
         FROM peer_notes n WHERE n.peer_id = ?1 AND n.arrived_at < ?2
         ORDER BY n.arrived_at DESC LIMIT ?3",
    )?;
    for r in st.query_map(params![peer.id, before, n], |r| {
        let promise: bool = r.get(4)?;
        let kept: i64 = r.get(5)?;
        let told: i64 = r.get(9)?;
        Ok(Item {
            key: format!("n:{}", r.get::<_, i64>(0)?),
            kind: if promise { "promise" } else { "line" },
            dir: "in",
            note_id: r.get(0)?,
            text: r.get(1)?,
            at: r.get(2)?,
            due_at: r.get(3)?,
            done_at: if promise { kept } else { told },
            commit: r.get(6)?,
            taken_at: r.get(7)?,
            removed_at: r.get(8)?,
            ..Default::default()
        })
    })? {
        out.push(r?);
    }
    // Replies, both ways, each with the document it is about.
    let mut st = conn.prepare(
        "SELECT r.id, r.doc_id, r.text, r.at, r.mine FROM peer_replies r
         WHERE r.peer_id = ?1 AND r.at < ?2 ORDER BY r.at DESC LIMIT ?3",
    )?;
    for r in st.query_map(params![peer.id, before, n], |r| {
        let mine: bool = r.get(4)?;
        Ok(Item {
            key: format!("r:{}", r.get::<_, i64>(0)?),
            kind: "reply",
            dir: if mine { "out" } else { "in" },
            doc_id: r.get(1)?,
            text: r.get(2)?,
            at: r.get(3)?,
            ..Default::default()
        })
    })? {
        out.push(r?);
    }
    out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.key.cmp(&b.key)));
    out.truncate(limit);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tables the timeline reads, with only the columns it reads, and
    /// one friend.
    fn db() -> (Connection, Peer) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '',
               peer_key TEXT NOT NULL DEFAULT '', received_at INTEGER NOT NULL DEFAULT 0,
               deleted_at INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE desk_notes (id INTEGER PRIMARY KEY, sent_peer INTEGER NOT NULL DEFAULT 0,
               sent_frame TEXT NOT NULL DEFAULT '', told_at INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for c in COLUMNS_1_19 {
            conn.execute_batch(c).unwrap();
        }
        for c in COLUMNS_1_23.iter().filter(|c| c.starts_with("ALTER TABLE peer")) {
            conn.execute_batch(c).unwrap();
        }
        for c in COLUMNS_1_25.iter().filter(|c| c.contains("peer_outbox")) {
            conn.execute_batch(c).unwrap();
        }
        conn.execute_batch(COLUMNS_1_49).unwrap();
        conn.execute(
            "INSERT INTO peers(sign_key, box_key, name, paired_at) VALUES('tkey', 'tbox', 'Trapti', 1)",
            [],
        )
        .unwrap();
        let t = list(&conn).unwrap().remove(0);
        (conn, t)
    }

    /// Each source lands once, in time order, newest first, both ways; the
    /// page asks again with `before` for the next stretch.
    #[test]
    fn a_friends_timeline_merges_both_ways_newest_first() {
        let (conn, t) = db();
        conn.execute(
            "INSERT INTO docs(id, title, origin, peer_key, received_at, deleted_at) VALUES('in1', 'Their plan', 'peer', ?1, 10, 0)",
            params![t.sign_key],
        )
        .unwrap();
        let doc = queue(&conn, &t, "d1", 20).unwrap();
        sent(&conn, &doc, 21).unwrap();
        held_mark(&conn, &doc, 22).unwrap();
        note_arrived(&conn, t.id, "water the beans by Friday", "f1", 500, false, 30).unwrap();
        note_arrived(&conn, t.id, "post the seeds", "f2", 600, true, 40).unwrap();
        add_reply(&conn, t.id, "d1", "can bed 3 take squash?", false, 50).unwrap();
        add_reply(&conn, t.id, "d1", "yes, from May", true, 60).unwrap();
        let all = timeline(&conn, &t, 0, 50).unwrap();
        let said: Vec<_> = all.iter().map(|i| (i.kind, i.dir, i.at)).collect();
        assert_eq!(
            said,
            vec![
                ("reply", "out", 60),
                ("reply", "in", 50),
                ("promise", "in", 40),
                ("line", "in", 30),
                ("doc", "out", 20),
                ("doc", "in", 10),
            ]
        );
        assert_eq!((all[4].held_at, all[4].arrived_at), (22, 0));
        assert_eq!(all[2].due_at, 600);
        assert_eq!(all[3].text, "water the beans by Friday", "their words, as they wrote them");
        let older = timeline(&conn, &t, 30, 2).unwrap();
        assert_eq!(older.iter().map(|i| i.at).collect::<Vec<_>>(), vec![20, 10]);
    }
}
