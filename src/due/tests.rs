use super::*;

/// India, where the maker is: half an hour off the hour, which a parser
/// that rounds to whole hours gets wrong.
fn ist() -> UtcOffset {
    UtcOffset::from_hms(5, 30, 0).unwrap()
}

/// A wall-clock time in IST, as a unix time.
fn at(d: u8, m: u8, h: u8, min: u8) -> i64 {
    let y = if m >= 10 { 2026 } else { 2027 };
    PrimitiveDateTime::new(
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).unwrap(),
        Time::from_hms(h, min, 0).unwrap(),
    )
    .assume_offset(ist())
    .unix_timestamp()
}

/// Thursday 22 October 2026, 15:00 in IST.
fn now() -> i64 {
    at(22, 10, 15, 0)
}

/// Thirty lines a reader might write, and what each says.
#[test]
fn a_tail_that_reads_as_a_date_comes_off_the_line() {
    let n = now();
    let cases: Vec<(&str, Option<(&str, i64)>)> = vec![
        (
            "post the note by fri 10",
            Some(("post the note", at(23, 10, 10, 0))),
        ),
        (
            "post the note by fri",
            Some(("post the note", at(23, 10, 9, 0))),
        ),
        // A weekday alone needs a word that makes it a date.
        ("post the note fri", None),
        ("post it, fri", Some(("post it", at(23, 10, 9, 0)))),
        ("post it · fri", Some(("post it", at(23, 10, 9, 0)))),
        ("notes from fri", None),
        (
            "call the bank tomorrow",
            Some(("call the bank", at(23, 10, 9, 0))),
        ),
        (
            "call the bank tomorrow 4pm",
            Some(("call the bank", at(23, 10, 16, 0))),
        ),
        ("ship it today", Some(("ship it", at(22, 10, 17, 0)))),
        // Past: kept as words, never due yesterday.
        ("ship it today 10", None),
        ("call mom tonight", Some(("call mom", at(22, 10, 19, 0)))),
        ("call mom tonight 9", Some(("call mom", at(22, 10, 21, 0)))),
        // Thursday today and 10:00 gone: next Thursday.
        ("release thu 10", Some(("release", at(29, 10, 10, 0)))),
        ("release thu 18:30", Some(("release", at(22, 10, 18, 30)))),
        (
            "check stats in 3 days",
            Some(("check stats", n + 3 * 86_400)),
        ),
        ("check the build in 2h", Some(("check the build", n + 7200))),
        ("look again in 90 min", Some(("look again", n + 5400))),
        (
            "send the invoice by 28 oct",
            Some(("send the invoice", at(28, 10, 9, 0))),
        ),
        (
            "send the invoice oct 28 10:30",
            Some(("send the invoice", at(28, 10, 10, 30))),
        ),
        (
            "renew the domain by 2026-11-01",
            Some(("renew the domain", at(1, 11, 9, 0))),
        ),
        ("plan the launch next week", None),
        (
            "plan the launch by next week",
            Some(("plan the launch", at(26, 10, 9, 0))),
        ),
        ("mow the lawn by the weekend", None),
        (
            "mow the lawn by weekend",
            Some(("mow the lawn", at(24, 10, 10, 0))),
        ),
        // An hour alone: today while it is ahead, else tomorrow.
        ("standup at 10", Some(("standup", at(23, 10, 10, 0)))),
        ("standup at 16", Some(("standup", at(22, 10, 16, 0)))),
        ("call at 7:30 pm", Some(("call", at(22, 10, 19, 30)))),
        ("fix bug 42", None),
        ("upgrade on 10", None),
        ("#182 is due to the md to pdf", None),
        // A date is not a line.
        ("tomorrow", None),
        // This year's 1 October has gone.
        (
            "pay the rent by 1 oct",
            Some(("pay the rent", at(1, 10, 9, 0) + 365 * 86_400)),
        ),
        ("post on fri 7 pm", Some(("post", at(23, 10, 19, 0)))),
        (
            "Post The Note BY FRI.",
            Some(("Post The Note", at(23, 10, 9, 0))),
        ),
        ("rest in 0 days", None),
        ("v2 at 25", None),
    ];
    for (text, want) in cases {
        let got = split_at(text, n, ist());
        let want = want.map(|(t, at)| (t.to_string(), at));
        assert_eq!(got, want, "{text}");
    }
}

#[test]
fn a_date_said_alone_takes_every_form() {
    let n = now();
    assert_eq!(parse_at("mon 9", n, ist()), Some(at(26, 10, 9, 0)));
    assert_eq!(parse_at("by fri", n, ist()), Some(at(23, 10, 9, 0)));
    assert_eq!(parse_at("next week", n, ist()), Some(at(26, 10, 9, 0)));
    assert_eq!(parse_at("in 2 h", n, ist()), Some(n + 7200));
    assert_eq!(parse_at("", n, ist()), None);
    assert_eq!(parse_at("yesterday", n, ist()), None);
    assert_eq!(parse_at("today 10", n, ist()), None);
}

#[test]
fn a_date_is_said_the_way_the_reader_says_it() {
    let n = now();
    assert_eq!(label_at(at(22, 10, 17, 0), n, ist()), "today 17:00");
    assert_eq!(label_at(at(23, 10, 10, 0), n, ist()), "tomorrow 10:00");
    assert_eq!(label_at(at(26, 10, 9, 0), n, ist()), "Mon 9:00");
    assert_eq!(label_at(at(1, 11, 9, 0), n, ist()), "1 Nov 9:00");
    assert_eq!(label_at(n - 600, n, ist()), "due now");
    assert_eq!(label_at(n - 2 * 86_400 - 60, n, ist()), "overdue 2 d");
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(crate::desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(crate::desk::LOOP_COLUMNS_1_37).unwrap();
    conn.execute_batch(crate::thread::THREAD_COLUMN).unwrap();
    conn.execute_batch(crate::links::COLUMN_1_43).unwrap();
    conn.execute_batch(crate::accounts::SCHEMA).unwrap();
    for c in crate::accounts::COLUMNS_1_30 {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(crate::thread::SCHEMA).unwrap();
    conn.execute_batch(crate::thread::CMD_COLUMN).unwrap();
    conn.execute_batch(crate::thread::GROUP_COLUMN).unwrap();
    conn.execute_batch(crate::thread::AWAY_COLUMN_1_44).unwrap();
    for c in crate::thread::ON_YOU_1_36 {
        conn.execute_batch(c).unwrap();
    }
    for c in crate::peer::COLUMNS_1_23
        .iter()
        .filter(|c| c.starts_with("ALTER TABLE desk_notes"))
    {
        conn.execute_batch(c).unwrap();
    }
    conn.execute_batch(COLUMNS_1_47).unwrap();
    conn.execute_batch(TURN_COLUMN_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn
}

/// At the hour one card rises, once; a new date rings once more; a ticked
/// line's card goes by itself.
#[test]
fn a_due_line_rings_once_and_its_card_answers_for_it() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let note = crate::desk::add_note(&mut conn, d, "post it by fri", 0)
        .unwrap()
        .unwrap();
    // Written at 0, so the Friday is the first one after the epoch's Thursday.
    assert_eq!(note.text, "post it");
    assert!(note.due_at > 0);
    let due = note.due_at;
    assert!(ring(&conn, due - 1).unwrap().is_empty());
    assert_eq!(ring(&conn, due).unwrap(), vec![d]);
    assert!(ring(&conn, due + 30).unwrap().is_empty(), "once");
    let cards = crate::thread::waiting(&conn, due + 31).unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].kind, KIND);
    assert_eq!(cards[0].by, "snyvi");

    // Later: the line moves and the card is answered, for the next panel.
    let later = answer(&conn, d, &cards[0], Some("in 2 days"), due + 60)
        .unwrap()
        .unwrap();
    assert!(later.answer.starts_with("Later: "), "{}", later.answer);
    let n = &crate::desk::notes(&conn, d).unwrap()[0];
    assert_eq!(n.due_at, due + 60 + 2 * 86_400);
    assert_eq!(
        ring(&conn, n.due_at).unwrap(),
        vec![d],
        "a new date rings again"
    );

    // Ticked on the rail instead: the card goes at the next tick.
    crate::desk::set_note(&conn, d, n.id, None, Some(true), n.due_at + 5).unwrap();
    assert_eq!(ring(&conn, n.due_at + 30).unwrap(), vec![d]);
    assert!(crate::thread::waiting(&conn, n.due_at + 31)
        .unwrap()
        .is_empty());
}

#[test]
fn done_on_a_due_card_ticks_its_line_and_set_moves_it() {
    let mut conn = db();
    let d = crate::desk::create(&conn, "/w", None, 0).unwrap().id;
    let note = crate::desk::add_note(&mut conn, d, "ship it tomorrow", 0)
        .unwrap()
        .unwrap();
    ring(&conn, note.due_at).unwrap();
    let card = crate::thread::waiting(&conn, note.due_at)
        .unwrap()
        .remove(0);
    let done = answer(&conn, d, &card, None, note.due_at + 1)
        .unwrap()
        .unwrap();
    assert_eq!(done.answer, "Done");
    assert!(crate::desk::notes(&conn, d).unwrap()[0].done);

    let other = crate::desk::add_note(&mut conn, d, "write it up tomorrow", 0)
        .unwrap()
        .unwrap();
    ring(&conn, other.due_at).unwrap();
    assert!(set(&conn, d, other.id, 0, other.due_at + 1).unwrap());
    assert!(
        crate::thread::waiting(&conn, other.due_at + 2)
            .unwrap()
            .is_empty(),
        "moved, so its card went"
    );
    assert_eq!(crate::desk::notes(&conn, d).unwrap()[0].due_at, 0);
}
