//! The tests of `crate::peer`: keys, codes, frames, the outbox, the line.

use super::*;

fn two() -> (Identity, Identity) {
    let mut a = [7u8; 64];
    a[0] = 1;
    let mut b = [9u8; 64];
    b[0] = 2;
    (Identity::from_seed(&a), Identity::from_seed(&b))
}

fn as_peer(id: &Identity, name: &str) -> Peer {
    Peer {
        id: 1,
        sign_key: id.address(),
        box_key: b64(&id.box_public()),
        name: name.into(),
        paired_at: 0,
        muted: false,
        removed_at: 0,
        last_from: 0,
        last_to: 0,
        desk_id: 0,
        v: 0,
        read_receipts: false,
    }
}

#[test]
fn base64url_round_trips_and_is_what_the_relay_spells() {
    for n in 0..70 {
        let v: Vec<u8> = (0..n).map(|i| (i * 37 % 256) as u8).collect();
        let s = b64(&v);
        assert!(!s.contains('='), "{s}");
        assert_eq!(unb64(&s).unwrap(), v, "{n}");
    }
    assert_eq!(b64(b"hello"), "aGVsbG8");
    assert_eq!(unb64("aGVsbG8=").unwrap(), b"hello");
    assert!(unb64("a").is_none());
    assert!(unb64("a+b/").is_none());
    assert_eq!(b64(&[0u8; 32]).len(), 43, "an address is 43 characters");
}

#[test]
fn a_frame_opens_for_its_recipient_and_for_nobody_else() {
    let (sunny, trapti) = two();
    let content = Content::Document {
        title: "Plan for the garden".into(),
        lang: Some("md".into()),
        file: None,
        name: "Sunny".into(),
        id: "abc123".into(),
        at: Folder::default(),
    };
    let frame = seal(
        &sunny,
        &as_peer(&trapti, "Trapti"),
        &content,
        b"# the plan\n",
    )
    .unwrap();
    assert_eq!(frame[0], VERSION);
    assert_eq!(sender_of(&frame).as_deref(), Some(sunny.address().as_str()));

    let (got, body) = open(&trapti, &as_peer(&sunny, "Sunny"), &frame).unwrap();
    assert_eq!(got, content);
    assert_eq!(body, b"# the plan\n");

    // A flipped byte in the box: the signature fails first.
    let mut bad = frame.clone();
    bad[60] ^= 1;
    let e = open(&trapti, &as_peer(&sunny, "Sunny"), &bad)
        .unwrap_err()
        .to_string();
    assert!(e.contains("signature"), "{e}");
    // A flipped byte in the signature.
    let mut bad = frame.clone();
    let n = bad.len() - 1;
    bad[n] ^= 1;
    assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &bad).is_err());
    // Pinned keys of someone else: the frame names another sender.
    let stranger = Identity::from_seed(&[3u8; 64]);
    let e = open(&trapti, &as_peer(&stranger, "X"), &frame)
        .unwrap_err()
        .to_string();
    assert!(e.contains("another sender"), "{e}");
    // The wrong recipient has the right pinned sender and still cannot open it.
    assert!(open(&stranger, &as_peer(&sunny, "Sunny"), &frame).is_err());
    // Too short, wrong version.
    assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &frame[..100]).is_err());
    let mut v = frame.clone();
    v[0] = 2;
    assert!(sender_of(&v).is_none());
    assert!(open(&trapti, &as_peer(&sunny, "Sunny"), &v).is_err());
}

#[test]
fn a_note_travels_too_and_the_id_is_one_per_document_and_friend() {
    let (sunny, trapti) = two();
    let frame = seal(
        &sunny,
        &as_peer(&trapti, "Trapti"),
        &Content::Note {
            text: "water the beans".into(),
            name: "Sunny".into(),
            at: Folder::default(),
        },
        b"",
    )
    .unwrap();
    let (got, body) = open(&trapti, &as_peer(&sunny, "Sunny"), &frame).unwrap();
    assert!(matches!(got, Content::Note { ref text, .. } if text == "water the beans"));
    assert!(body.is_empty());
    assert_eq!(
        frame_id("d1", &trapti.address()),
        frame_id("d1", &trapti.address())
    );
    assert_ne!(
        frame_id("d1", &trapti.address()),
        frame_id("d1", &sunny.address())
    );
    assert_eq!(frame_id("d1", "k").len(), 64);
}

#[test]
fn a_code_is_three_words_a_check_and_ten_minutes_of_room() {
    let code = mint_code().unwrap();
    let parts: Vec<&str> = code.split('-').collect();
    assert_eq!(parts.len(), 4, "{code}");
    assert_eq!(parts[3].len(), 3);
    assert_eq!(normalize_code(&code).unwrap(), code);
    assert_eq!(
        normalize_code(&format!("  {} ", code.to_uppercase().replace('-', " "))).unwrap(),
        code
    );
    assert!(normalize_code("ocean ladder").is_err());
    assert!(
        normalize_code("ocean-ladder-xyzzy-abc").is_err(),
        "not a word"
    );
    let mut wrong = parts[..3].join("-");
    wrong.push_str(if parts[3] == "bbb" { "-ccc" } else { "-bbb" });
    assert!(normalize_code(&wrong).unwrap_err().contains("heard wrong"));
    assert_eq!(room_of(&code).len(), 64);
    assert_ne!(room_of(&code), room_of("acid-acorn-acre-bbb"));
    assert_eq!(words().len(), 1296);
}

#[test]
fn yo_yo_is_never_minted_and_joins_however_it_is_typed() {
    for _ in 0..20_000 {
        assert!(!mint_code().unwrap().contains("yo-yo"));
    }
    // A code a 1.28 maker could still print, with yo-yo first and in the middle.
    for w in ["yo-yo-ocean-acorn", "ocean-yo-yo-acorn"] {
        let code = format!("{w}-{}", check(w));
        assert_eq!(normalize_code(&code).unwrap(), code);
        assert_eq!(normalize_code(&code.replace('-', " ")).unwrap(), code);
        assert_eq!(
            normalize_code(&code.replace('-', " ").to_uppercase()).unwrap(),
            code
        );
    }
}

#[test]
fn the_emoji_are_four_and_the_same_from_either_side() {
    let (a, b) = two();
    let x = emoji(
        a.sign.verifying_key().as_bytes(),
        b.sign.verifying_key().as_bytes(),
    );
    let y = emoji(
        b.sign.verifying_key().as_bytes(),
        a.sign.verifying_key().as_bytes(),
    );
    assert_eq!(x, y);
    assert_eq!(x.split(' ').count(), 4, "{x}");
    let c = Identity::from_seed(&[5u8; 64]);
    assert_ne!(
        x,
        emoji(
            a.sign.verifying_key().as_bytes(),
            c.sign.verifying_key().as_bytes()
        )
    );
}

#[test]
fn the_identity_is_kept_once_and_read_back_the_same() {
    let dir = crate::store::tempdir::Dir::new("snyvi-peer-id");
    let s = crate::secrets::Secrets::file_only(dir.path.join("keys.json"));
    assert!(
        Identity::load(&s).is_none(),
        "nothing minted before anyone pairs"
    );
    let a = Identity::load_or_mint(&s).unwrap();
    let b = Identity::load_or_mint(&s).unwrap();
    assert_eq!(a.address(), b.address());
    assert_eq!(a.box_public(), b.box_public());
    assert_eq!(Identity::load(&s).unwrap().address(), a.address());
    let auth = a.relay_auth("GET", "/inbox/x");
    let (secs, sig) = auth.split_once('.').unwrap();
    assert!(secs.parse::<i64>().is_ok());
    assert_eq!(unb64(sig).unwrap().len(), 64);
}

#[test]
fn friends_are_pinned_listed_renamed_muted_removed_and_restored() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);")
        .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in COLUMNS_1_19 {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE peer"))
    {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_25.iter().filter(|c| c.contains("peer_outbox")) {
        conn.execute_batch(c).unwrap();
    }
    let (sunny, trapti) = two();
    let t = pin(&conn, &as_peer(&trapti, "Trapti"), 100).unwrap();
    assert_eq!(t.name, "Trapti");
    assert_eq!(t.paired_at, 100);
    assert_eq!(list(&conn).unwrap().len(), 1);
    assert!(by_name(&conn, " trapti ").unwrap().is_some());
    assert!(rename(&conn, t.id, "T").unwrap());
    assert!(
        !rename(&conn, t.id, "   ").unwrap(),
        "a name is not nothing"
    );
    assert!(mute(&conn, t.id, true).unwrap());
    assert!(set_desk(&conn, t.id, 4).unwrap());
    assert_eq!(get(&conn, t.id).unwrap().unwrap().desk_id, 4);
    assert!(set_desk(&conn, t.id, 0).unwrap());
    assert!(get(&conn, t.id).unwrap().unwrap().muted);
    assert!(remove(&conn, t.id, 200).unwrap());
    assert!(
        by_name(&conn, "T").unwrap().is_none(),
        "removed is off the list"
    );
    assert!(restore(&conn, t.id).unwrap());
    assert!(by_name(&conn, "T").unwrap().is_some());
    // Pairing again with the same friend who got new keys keeps the row.
    let mut again = as_peer(&trapti, "Trapti");
    again.box_key = b64(&sunny.box_public());
    let t2 = pin(&conn, &again, 300).unwrap();
    assert_eq!(t2.id, t.id);
    assert_eq!(t2.name, "T", "the reader's name for them stands");
    assert_eq!(t2.box_key, b64(&sunny.box_public()));

    // The outbox: one row per document and friend, queued again on a resend.
    let fid = queue(&conn, &t2, "doc1", 400).unwrap();
    assert_eq!(queue(&conn, &t2, "doc1", 401).unwrap(), fid);
    assert_eq!(unsent(&conn, i64::MAX).unwrap().len(), 1);
    failed(&conn, &fid, "offline").unwrap();
    assert_eq!(unsent(&conn, i64::MAX).unwrap()[0].tries, 1);
    // A full mailbox is a wait, not a failure: the tries stay where they were.
    waiting(&conn, &fid, "their mailbox is full", 0, None).unwrap();
    waiting(&conn, &fid, "their mailbox is full", 0, None).unwrap();
    assert_eq!(unsent(&conn, i64::MAX).unwrap()[0].tries, 1);
    sent(&conn, &fid, 402).unwrap();
    assert!(unsent(&conn, i64::MAX).unwrap().is_empty());
    // A line waits there too, each its own row: said twice is two lines.
    let l1 = queue_note(&conn, &t2, "  water the beans  ", 410).unwrap();
    let l2 = queue_note(&conn, &t2, "water the beans", 411).unwrap();
    assert_ne!(l1, l2);
    let waiting = unsent(&conn, i64::MAX).unwrap();
    assert_eq!(waiting.len(), 2);
    assert_eq!(waiting[0].text, "water the beans");
    assert_eq!(waiting[0].doc_id, "");
    sent(&conn, &l1, 412).unwrap();
    sent(&conn, &l2, 412).unwrap();

    // Notes wait, are taken, put away, brought back.
    let n = note_arrived(&conn, t2.id, "  water the beans  ", "f1", 500).unwrap();
    assert_eq!(notes_waiting(&conn).unwrap()[0].text, "water the beans");
    assert!(settle_note(&conn, n, "taken", 501).unwrap());
    assert!(notes_waiting(&conn).unwrap().is_empty());
    assert!(settle_note(&conn, n, "restore", 502).unwrap());
    assert!(settle_note(&conn, n, "remove", 503).unwrap());
    assert!(!settle_note(&conn, n, "eat", 503).unwrap());

    // Offers: open until answered, dropped with their pane.
    conn.execute("INSERT INTO docs VALUES('doc1', 'Plan')", [])
        .unwrap();
    let o = offer(&conn, t2.id, "doc1", "", "pane-a", "Claude", 600).unwrap();
    let open = offers_open(&conn).unwrap();
    assert_eq!(open[0].title, "Plan");
    assert_eq!(open[0].to, "T");
    assert!(answer_offer(&conn, o, true, 601).unwrap());
    assert!(!answer_offer(&conn, o, true, 601).unwrap(), "answered once");
    assert!(!reopen_offer(&conn, o).unwrap(), "a sent offer stays sent");
    let no = offer(&conn, t2.id, "doc1", "", "pane-b", "Claude", 601).unwrap();
    assert!(answer_offer(&conn, no, false, 601).unwrap());
    assert!(reopen_offer(&conn, no).unwrap(), "Not now has an Undo");
    assert_eq!(offers_open(&conn).unwrap().len(), 1);
    assert!(answer_offer(&conn, no, false, 601).unwrap());
    offer(&conn, t2.id, "doc1", "", "pane-a", "Claude", 602).unwrap();
    assert_eq!(drop_offers_of(&conn, "pane-a", 603).unwrap(), 1);
    assert!(offers_open(&conn).unwrap().is_empty());

    // What was brought in is remembered, until it is too old to recur.
    assert!(!taken(&conn, "f1").unwrap());
    take(&conn, "f1", 700).unwrap();
    take(&conn, "f1", 701).unwrap();
    take(&conn, "f2", 800).unwrap();
    assert!(taken(&conn, "f1").unwrap());
    assert_eq!(prune_taken(&conn, 750).unwrap(), 1);
    assert!(!taken(&conn, "f1").unwrap());
    assert!(taken(&conn, "f2").unwrap());
    clear(&conn).unwrap();
    assert!(list(&conn).unwrap().is_empty());
    assert!(!taken(&conn, "f2").unwrap());
}

#[test]
fn the_link_knows_its_address_and_its_messages() {
    let (a, _) = two();
    assert_eq!(
        ws_of("http://127.0.0.1:8799", &a.address()),
        format!("ws://127.0.0.1:8799/inbox/{}", a.address())
    );
    assert_eq!(
        ws_of(RELAY, &a.address()),
        format!("wss://relay.snyvi.com/inbox/{}", a.address())
    );
    assert!(relay_ws(&a.address()).starts_with("ws"));

    let pushed: Pushed =
        serde_json::from_str(r#"{"frame":{"id":"ab","sender":"k","size":12,"at":1700000000000}}"#)
            .unwrap();
    let Pushed::Frame(w) = pushed;
    assert_eq!((w.id.as_str(), w.sender.as_str(), w.size), ("ab", "k", 12));
    assert!(
        serde_json::from_str::<Pushed>(r#"{"hello":{}}"#).is_err(),
        "a message this daemon does not know is not a frame"
    );
    assert!(serde_json::from_str::<Pushed>("pong").is_err());
    assert_eq!(ack_message("ab"), r#"{"ack":"ab"}"#);
}

#[test]
fn a_deposit_that_cannot_go_now_waits_and_says_why() {
    assert_eq!(
        later(429, "the relay is busy; try again in a minute"),
        Some(BUSY)
    );
    assert_eq!(
        later(429, "the mailbox is full; try later"),
        Some("their mailbox is full")
    );
    assert!(
        later(404, "no such mailbox").is_some(),
        "an idle friend's cleared mailbox"
    );
    assert_eq!(
        later(401, "not the key's signature"),
        None,
        "a real failure"
    );
    assert_eq!(later(413, "a frame is at most 8 MB"), None);
}

#[test]
fn the_doorbell_and_the_pairing_speak_plainly() {
    assert_eq!(ws_base("https://relay.snyvi.com"), "wss://relay.snyvi.com");
    assert_eq!(ws_base("http://127.0.0.1:8799"), "ws://127.0.0.1:8799");
    assert_eq!(rings_for(r#"{"ready":"spake"}"#), Some("spake"));
    assert_eq!(rings_for(r#"{"ready":"hello"}"#), Some("hello"));
    assert_eq!(rings_for(r#"{"ready":"other"}"#), None);
    assert_eq!(rings_for("pong"), None);
    assert_eq!(
        pair_refused(429).to_string(),
        "the relay is busy; try again in a minute"
    );
    assert_eq!(pair_refused(410).to_string(), "this code was already used");
    // No runtime about, as in a plain test: the bell is not there, and
    // the pairing falls back to asking.
    assert_eq!(
        ring_wait("http://127.0.0.1:9", &"a".repeat(64), "spake", "ab", 1),
        Bell::Absent
    );
}

#[test]
fn the_backoff_climbs_and_stops() {
    let mut last = Duration::ZERO;
    for attempt in 0..12 {
        let b = backoff(attempt);
        let base = Duration::from_secs(1 << attempt).min(BACKOFF_MAX);
        assert!(
            b >= base && b <= base.mul_f64(1.3),
            "attempt {attempt}: {b:?}"
        );
        // Monotone in its base, jitter aside.
        assert!(base >= last);
        last = base;
    }
    assert!(
        backoff(40) <= BACKOFF_MAX.mul_f64(1.3),
        "capped, not overflowed"
    );
}

#[test]
fn a_frame_says_its_folder_and_older_and_newer_frames_still_open() {
    let doc = Content::Document {
        title: "Plan".into(),
        lang: None,
        file: Some("PLAN.md".into()),
        name: "Trapti".into(),
        id: "d1".into(),
        at: Folder {
            repo: Some("r".repeat(32)),
            remote: None,
            path: Some("docs/PLAN.md".into()),
            key: None,
            branch: Some("main".into()),
            v: CONTENT_V,
        },
    };
    let (got, body) = unpack(&pack(&doc, b"x")).unwrap();
    assert_eq!(got, doc);
    assert_eq!(body, b"x");
    // What 1.21 sends: no folder at all.
    let old = br#"{"kind":"document","title":"T","name":"S","id":"i","file":"a.md"}"#;
    let got: Content = serde_json::from_slice(old).unwrap();
    assert!(matches!(got, Content::Document { ref at, .. } if *at == Folder::default()));
    // What 1.21 reads of a 1.22 frame: the same fields it knew, the rest ignored.
    #[derive(Deserialize)]
    #[serde(rename_all = "lowercase", tag = "kind")]
    #[allow(dead_code)]
    enum Was {
        Document {
            title: String,
            file: Option<String>,
            name: String,
            id: String,
        },
        Note {
            text: String,
            name: String,
        },
    }
    let json = serde_json::to_vec(&doc).unwrap();
    let was: Was = serde_json::from_slice(&json).unwrap();
    assert!(
        matches!(was, Was::Document { ref title, ref file, .. } if title == "Plan" && file.as_deref() == Some("PLAN.md"))
    );
    let note = Content::Note {
        text: "hi".into(),
        name: "S".into(),
        at: Folder {
            repo: Some("r".into()),
            v: CONTENT_V,
            ..Default::default()
        },
    };
    let was: Was = serde_json::from_slice(&serde_json::to_vec(&note).unwrap()).unwrap();
    assert!(matches!(was, Was::Note { ref text, .. } if text == "hi"));
    // A kind from a snyvi newer than this one opens, as Other.
    let newer = br#"{"kind":"follow","of":"d1","v":3}"#;
    assert_eq!(
        serde_json::from_slice::<Content>(newer).unwrap(),
        Content::Other
    );
}

/// 1.23: the kinds that answer a frame travel as the others do, say the
/// `v` that reads them, and open as Other on a 1.22 that cannot.
#[test]
fn a_receipt_a_reply_and_a_done_travel_and_say_their_v() {
    let (sunny, trapti) = two();
    let kinds = [
        Content::Receipt {
            of: "f1".into(),
            state: "arrived".into(),
            v: CONTENT_V,
        },
        Content::Reply {
            re: "d1".into(),
            text: "looks good".into(),
            name: "Trapti".into(),
            v: CONTENT_V,
        },
        Content::Done {
            of: "f2".into(),
            text: "water the beans".into(),
            commit: Some("abc1234".into()),
            name: "Trapti".into(),
            v: CONTENT_V,
        },
    ];
    for k in kinds {
        let frame = seal(&trapti, &as_peer(&sunny, "Sunny"), &k, b"").unwrap();
        let (got, _) = open(&sunny, &as_peer(&trapti, "Trapti"), &frame).unwrap();
        assert_eq!(got, k);
        assert_eq!(got.v(), CONTENT_V);
        assert!(got.v() >= REPLIES_V);
        // What 1.22 makes of it: a kind it does not know, kept for later.
        #[derive(Deserialize, Debug)]
        #[serde(rename_all = "lowercase", tag = "kind")]
        enum Old {
            Document {},
            Note {},
            #[serde(other)]
            Other,
        }
        let old: Old = serde_json::from_slice(&serde_json::to_vec(&k).unwrap()).unwrap();
        assert!(matches!(old, Old::Other), "{old:?}");
    }
    assert_eq!(
        Content::Note {
            text: "x".into(),
            name: "S".into(),
            at: Folder::default()
        }
        .v(),
        0,
        "a frame before 1.22 says none"
    );
}

/// What comes back lands only on what went to that friend: a receipt for
/// another frame, or from another friend, is nothing; a read implies the
/// arrival; a done is for a line, and once.
#[test]
fn receipts_and_dones_land_only_on_what_went_to_that_friend() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);")
        .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in COLUMNS_1_19 {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE peer"))
    {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_25.iter().filter(|c| c.contains("peer_outbox")) {
        conn.execute_batch(c).unwrap();
    }
    conn.execute("INSERT INTO docs(id, title) VALUES('d1', 'Plan')", [])
        .unwrap();
    let (sunny, trapti) = two();
    let t = pin(&conn, &as_peer(&trapti, "Trapti"), 1).unwrap();
    let s = pin(&conn, &as_peer(&sunny, "Sunny"), 1).unwrap();
    let doc = queue(&conn, &t, "d1", 10).unwrap();
    let line = queue_note(&conn, &t, "water the beans", 11).unwrap();
    sent(&conn, &doc, 12).unwrap();
    sent(&conn, &line, 13).unwrap();

    assert!(!receipt(&conn, t.id, "nope", "arrived", 20).unwrap());
    assert!(
        !receipt(&conn, s.id, &doc, "arrived", 20).unwrap(),
        "not theirs"
    );
    assert!(!receipt(&conn, t.id, &doc, "lost", 20).unwrap());
    assert!(receipt(&conn, t.id, &doc, "read", 21).unwrap());
    assert!(
        !receipt(&conn, t.id, &doc, "arrived", 22).unwrap(),
        "read says it already"
    );
    let got = sent_recent(&conn, 5).unwrap();
    let d = got.iter().find(|x| x.id == doc).unwrap();
    assert_eq!((d.what.as_str(), d.arrived_at, d.read_at), ("Plan", 21, 21));

    assert_eq!(
        done(&conn, t.id, &doc, "", 30).unwrap(),
        None,
        "a document is not a line"
    );
    assert_eq!(
        done(&conn, t.id, &line, "abc1234 (fix the flaky row)", 31)
            .unwrap()
            .as_deref(),
        Some("water the beans")
    );
    assert_eq!(done(&conn, t.id, &line, "", 32).unwrap(), None, "once");
    let l = sent_recent(&conn, 5)
        .unwrap()
        .into_iter()
        .find(|x| x.id == line)
        .unwrap();
    assert_eq!((l.done_at, l.done_commit.as_str()), (31, "abc1234"));

    // Answers queue as frames of their own, and a receipt twice is one.
    let r1 = queue_kind(&conn, &t, "receipt", "their-frame", "arrived", "", 40).unwrap();
    let r2 = queue_kind(&conn, &t, "receipt", "their-frame", "arrived", "", 41).unwrap();
    assert_eq!(r1, r2);
    let rp = queue_kind(&conn, &t, "reply", "d9", " ok ", "", 42).unwrap();
    let un = unsent(&conn, i64::MAX).unwrap();
    assert_eq!(un.len(), 2);
    let reply = un.iter().find(|u| u.id == rp).unwrap();
    assert_eq!(
        (reply.kind.as_str(), reply.re.as_str(), reply.text.as_str()),
        ("reply", "d9", "ok")
    );
    assert!(
        outgoing(&conn).unwrap().iter().all(|o| o.id != r1),
        "a receipt is not the reader's to see waiting"
    );
    assert!(sent_doc(&conn, t.id, "d1").unwrap());
    assert!(!sent_doc(&conn, s.id, "d1").unwrap());
}

#[test]
fn a_path_from_a_friend_stays_inside_the_folder() {
    assert_eq!(safe_path("docs/PLAN.md").as_deref(), Some("docs/PLAN.md"));
    assert_eq!(safe_path("docs\\PLAN.md").as_deref(), Some("docs/PLAN.md"));
    assert_eq!(safe_path("PLAN.md").as_deref(), Some("PLAN.md"));
    for bad in [
        "",
        "/etc/passwd",
        "../x.md",
        "docs/../../x",
        "C:/x.md",
        "c:x.md",
        "a//b",
        "./a",
        "a/\u{1b}[2J",
    ] {
        assert_eq!(safe_path(bad), None, "{bad:?}");
    }
    assert_eq!(safe_path(&"a/".repeat(201)), None);
}

/// The outbox for 1.25: a frame with `COLUMNS_1_25` on it.
fn outbox() -> (Connection, Peer) {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT NOT NULL);")
        .unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    for c in COLUMNS_1_19 {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE peer"))
    {
        conn.execute_batch(c).unwrap();
    }
    for c in COLUMNS_1_25.iter().filter(|c| c.contains("peer_outbox")) {
        conn.execute_batch(c).unwrap();
    }
    conn.execute("INSERT INTO docs(id, title) VALUES('d1', 'Plan')", [])
        .unwrap();
    let (_, trapti) = two();
    let t = pin(&conn, &as_peer(&trapti, "Trapti"), 1).unwrap();
    (conn, t)
}

fn due(conn: &Connection, now: i64) -> Vec<String> {
    unsent(conn, now)
        .unwrap()
        .into_iter()
        .map(|u| u.id)
        .collect()
}

fn row(conn: &Connection, id: &str) -> (i64, i64, i64) {
    conn.query_row(
        "SELECT tries, later, next_at FROM peer_outbox WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

/// A frame the relay says "not now" to waits 10, 20, 40 … minutes and
/// then six hours, keeps its tries, is skipped until due, and is due
/// at once when the friend comes back, when Retry is pressed, or when
/// the reader sends them something new.
#[test]
fn a_waiting_frame_is_due_backs_off_and_comes_back() {
    let (conn, t) = outbox();
    let id = queue(&conn, &t, "d1", 10).unwrap();
    assert_eq!(
        due(&conn, 10),
        std::slice::from_ref(&id),
        "new: due at once"
    );

    waiting(&conn, &id, "away", 100, None).unwrap();
    assert_eq!(row(&conn, &id), (0, 1, 700), "ten minutes, tries kept");
    assert!(due(&conn, 699).is_empty(), "not due yet");
    assert_eq!(due(&conn, 700), std::slice::from_ref(&id));
    waiting(&conn, &id, "away", 700, None).unwrap();
    assert_eq!(row(&conn, &id), (0, 2, 700 + 1200), "twenty");
    for _ in 0..98 {
        waiting(&conn, &id, "away", 0, None).unwrap();
    }
    assert_eq!(
        row(&conn, &id),
        (0, 100, 6 * 3600),
        "capped at six hours, not 0"
    );

    // The relay named the moment: that long, and the run is untouched.
    waiting(&conn, &id, BUSY, 5000, Some(5060)).unwrap();
    assert_eq!(row(&conn, &id), (0, 100, 5060));
    waiting(&conn, &id, BUSY, 5000, Some(10)).unwrap();
    assert_eq!(row(&conn, &id).2, 5000, "never in the past");

    assert_eq!(due_now(&conn, t.id).unwrap(), 1);
    assert_eq!(row(&conn, &id), (0, 0, 0), "they are back: due, run over");
    assert_eq!(due_now(&conn, t.id).unwrap(), 0, "nothing to do twice");

    waiting(&conn, &id, "away", 100, None).unwrap();
    let other = queue_note(&conn, &t, "hi", 200).unwrap();
    assert_eq!(
        row(&conn, &id),
        (0, 0, 0),
        "a new send to them makes the rest due"
    );
    assert_eq!(due(&conn, 200), [id.clone(), other.clone()]);

    for _ in 0..LATER_MAX {
        waiting(&conn, &id, "away", 0, None).unwrap();
    }
    assert_eq!(
        row(&conn, &id).1,
        LATER_MAX,
        "stopped by count, not by clock"
    );
    assert!(retry(&conn, &id).unwrap());
    assert_eq!(row(&conn, &id), (0, 0, 0), "Retry starts over");

    pending(&conn, &id, 1000).unwrap();
    assert_eq!(
        row(&conn, &id),
        (1, 0, 1600),
        "down the line: a try spent, back in ten minutes"
    );
    assert_eq!(
        unsent_one(&conn, &id).unwrap().map(|u| u.id),
        Some(id.clone()),
        "Send loads it due or not"
    );
    assert!(unsent_one(&conn, "nope").unwrap().is_none());
    sent(&conn, &other, 300).unwrap();
    assert!(unsent_one(&conn, &other).unwrap().is_none(), "gone is gone");
}

/// A frame cut for the line comes back whole from its pieces, in any
/// order, and a piece that is not one is refused.
#[test]
fn a_frame_goes_down_the_line_in_pieces_and_comes_back_whole() {
    let id = "ab".repeat(32);
    let frame: Vec<u8> = (0..LINE_CHUNK * 2 + 5).map(|i| (i % 251) as u8).collect();
    let cut = chunks(&id, &frame);
    assert_eq!(cut.len(), 3);
    assert_eq!(cut[0].len(), CHUNK_HEADER + LINE_CHUNK);
    assert_eq!(cut[2].len(), CHUNK_HEADER + 5);
    let mut a = Assembly::default();
    for m in [&cut[2], &cut[0]] {
        assert!(a.take(&Chunk::parse(m).unwrap()).is_none());
    }
    let (got_id, got) = a.take(&Chunk::parse(&cut[1]).unwrap()).unwrap();
    assert_eq!(got_id, id);
    assert_eq!(got, frame);
    assert_eq!(chunks(&id, b"x")[0].len(), CHUNK_HEADER + 1);
    assert!(Chunk::parse(&cut[0][..39]).is_none(), "too short");
    let mut bad = cut[0].clone();
    bad[36..40].copy_from_slice(&0u32.to_le_bytes());
    assert!(Chunk::parse(&bad).is_none(), "a count of none");
    assert_eq!(
        serde_json::from_str::<LineSaid>(r#"{"arrived":"x"}"#).unwrap(),
        LineSaid::Arrived("x".into())
    );
    assert_eq!(
        serde_json::from_str::<LineSaid>(r#"{"friend":{"on":true}}"#).unwrap(),
        LineSaid::Friend { on: true }
    );
    assert_eq!(
        serde_json::from_str::<LineSaid>(r#"{"quiet":{"until":5}}"#).unwrap(),
        LineSaid::Quiet { until: 5 }
    );
    assert!(serde_json::from_str::<LineSaid>("pong").is_err());
    let now = crate::store::now();
    let until = until_of(&format!("until:{}", (now + 100) * 1000));
    assert_eq!(until, now + 100);
    assert!(
        until_of("whatever") > now && until_of("whatever") <= now + 86_400,
        "midnight when it names none"
    );
}

#[test]
fn the_hello_is_waited_for_ninety_seconds_never_past_the_code() {
    // Plenty of the code left: ninety seconds, and a late hello means they left.
    assert_eq!(hello_by(1000, 1000 + CODE_TTL), (1000 + HELLO_WAIT, true));
    // Less than that left: the code's own end, and it simply ran out.
    assert_eq!(hello_by(1000, 1030), (1030, false));
}

#[test]
fn a_rows_from_is_the_rows_and_the_rest_is_their_name() {
    assert_eq!(name_from_project("From Trapti"), "Trapti");
    assert_eq!(name_from_project("from  Trapti "), "Trapti");
    assert_eq!(name_from_project("Trapti"), "Trapti");
    assert_eq!(name_from_project("Fromage"), "Fromage");
    assert_eq!(name_from_project("From From"), "From", "only one");
    assert_eq!(from_name("Trapti"), "From Trapti");
}
