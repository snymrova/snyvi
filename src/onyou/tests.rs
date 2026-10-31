use super::*;
use crate::store::tempdir::Dir;

/// A store as the daemon has it, every table and migration 34, opened again
/// as a plain connection: the list reads across desks, notes, turns,
/// routines and Home's row, so a hand-built schema would be most of it.
fn db() -> (Connection, Dir) {
    let dir = Dir::new("snyvi-onyou");
    let paths = crate::config::Paths {
        data_dir: dir.path.clone(),
        config_dir: dir.path.clone(),
        docs_dir: dir.path.join("docs"),
        db_path: dir.path.join("t.db"),
        token_path: dir.path.join("token"),
    };
    drop(crate::store::Store::open(&paths).unwrap());
    let conn = Connection::open(&paths.db_path).unwrap();
    (conn, dir)
}

const NOW: i64 = 1_793_400_000;
const DAY: i64 = 86_400;

fn desk(c: &Connection, name: &str) -> i64 {
    crate::desk::create(c, &format!("/w/{name}"), Some(name), 0)
        .unwrap()
        .id
}

fn card(c: &Connection, desk: i64, text: &str, at: i64) -> i64 {
    c.execute(
        "INSERT INTO turns(desk_id, by, kind, via, text, created_at) VALUES(?1, 'claude-code', 'do', 'agent', ?2, ?3)",
        params![desk, text, at],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn left_off(c: &Connection, desk: i64, text: &str, at: i64, pane: &str) {
    c.execute(
        "UPDATE desks SET left_off = ?2, left_off_at = ?3, left_off_needs = 'you', left_off_pane = ?4,
           left_off_by = 'claude-code' WHERE id = ?1",
        params![desk, text, at, pane],
    )
    .unwrap();
}

fn routine(c: &Connection, desk: i64, name: &str, pane: &str) -> i64 {
    c.execute(
        "INSERT INTO routines(desk_id, name, cmd, every, due_at, pane, created_at, started_at)
         VALUES(?1, ?2, '', 'every day 07:30', ?3, ?4, 0, 1)",
        params![desk, name, NOW + DAY, pane],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn kinds(oy: &OnYou) -> Vec<&'static str> {
    oy.rows.iter().map(|r| r.kind).collect()
}

/// One of each, in the one order: a card an agent is blocked on, a dated
/// line due, a routine's line, a line to Accept, a session's left-off.
#[test]
fn every_kind_is_a_row_in_rank_order() {
    let (c, _d) = db();
    let a = desk(&c, "alpha");
    let b = desk(&c, "beta");
    let r = desk(&c, "routines");
    let s = desk(&c, "gamma");
    left_off(
        &c,
        s,
        "If you merge PR 7, ship it",
        NOW - LEFT - 10,
        "p-session",
    );
    c.execute(
        "INSERT INTO desk_notes(desk_id, text, created_at, suggested_by) VALUES(?1, 'keep this', ?2, 'claude-code')",
        params![b, NOW - 50],
    )
    .unwrap();
    routine(&c, r, "blog-next", "p-routine");
    left_off(&c, r, "Two drafts wait for you", NOW - 100, "p-routine");
    c.execute(
        "INSERT INTO desk_notes(desk_id, text, created_at, due_at) VALUES(?1, 'post 1.54', 0, ?2)",
        params![b, NOW - 30],
    )
    .unwrap();
    card(&c, a, "Add OpenRouter credits", NOW - 60);

    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["card", "due", "routine", "suggested", "left"]);
    assert_eq!(oy.left, 5);
    assert_eq!((oy.more, oy.more_desks), (0, 0));
    let routine_row = &oy.rows[2];
    assert_eq!(
        (
            routine_row.routine.as_str(),
            routine_row.go,
            routine_row.no_doc
        ),
        ("blog-next", true, true)
    );
    assert!(oy.rows[4].go, "a session's left-off has Go ahead (Approve)");
}

const LEFT: i64 = crate::waiting::LEFT_WAIT_S;

/// A routine's line is the reader's the moment it is said; a session's
/// waits a day, as Home's did.
#[test]
fn a_routines_line_does_not_wait_and_a_sessions_waits_a_day() {
    let (c, _d) = db();
    let r = desk(&c, "routines");
    let s = desk(&c, "session");
    routine(&c, r, "news", "p-routine");
    left_off(&c, r, "Read the digest", NOW - 60, "p-routine");
    left_off(&c, s, "Approve the plan", NOW - 60, "p-session");
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["routine"]);
    assert_eq!(
        kinds(&gather(&c, NOW - 60 + LEFT).unwrap()),
        ["routine", "left"]
    );
}

/// A routine whose panel has a card open on the reader is one row, the
/// card: its line said the same ask again, and On you counted it twice
/// (#202). Answered, the line is the row again; and the desk's left-off
/// never comes back as a session's.
#[test]
fn a_routines_line_with_its_card_open_is_one_row() {
    let (c, _d) = db();
    let r = desk(&c, "everything.dog");
    routine(&c, r, "eva-pack", "p-eva");
    left_off(
        &c,
        r,
        "The explainer still waits for your answer",
        NOW - 60,
        "p-eva",
    );
    let t = card(&c, r, "2 · Explainer: leash pulling", NOW - 120);
    c.execute("UPDATE turns SET pane = 'p-eva' WHERE id = ?1", params![t])
        .unwrap();
    assert_eq!(kinds(&gather(&c, NOW + LEFT).unwrap()), ["card"]);

    // Another panel's card on the same desk leaves the line alone.
    c.execute(
        "UPDATE turns SET pane = 'p-other' WHERE id = ?1",
        params![t],
    )
    .unwrap();
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["card", "routine"]);

    c.execute(
        "UPDATE turns SET pane = 'p-eva', answered_at = ?2 WHERE id = ?1",
        params![t, NOW - 10],
    )
    .unwrap();
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["routine"]);
}

/// Seven rows in the tray, the rest counted with their desks.
#[test]
fn past_seven_the_rest_is_counted_with_its_desks() {
    let (c, _d) = db();
    let ds: Vec<i64> = ["a", "b", "c"].iter().map(|n| desk(&c, n)).collect();
    for i in 0..9 {
        card(&c, ds[i % 3], &format!("card {i}"), NOW - 100 + i as i64);
    }
    let oy = gather(&c, NOW).unwrap();
    assert_eq!((oy.left, oy.more), (9, 2));
    assert_eq!(oy.more_desks, 2, "cards 7 and 8 are on desks b and c");
    assert!(
        oy.sentence.starts_with("Nine things are on you."),
        "{}",
        oy.sentence
    );
}

/// Tomorrow keeps a card and a left-off off the list until then; Not this
/// keeps a left-off off for good, and the brief hears the word.
#[test]
fn tomorrow_and_not_this_take_rows_off() {
    let (c, _d) = db();
    let a = desk(&c, "a");
    let s = desk(&c, "s");
    let t = card(&c, a, "Sign in to Cloudflare", NOW - 60);
    left_off(&c, s, "Pay the invoice", NOW - LEFT - 60, "p");
    assert_eq!(gather(&c, NOW).unwrap().left, 2);

    assert!(crate::thread::later_turn(&c, a, t, NOW + DAY).unwrap());
    assert!(later_left_off(&c, s, NOW + DAY).unwrap());
    assert_eq!(gather(&c, NOW).unwrap().left, 0);
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 2, "back the next day");

    assert!(crate::thread::not_turn(&c, a, t, "done by hand", NOW).unwrap());
    assert!(not_left_off(&c, s, Some("not mine")).unwrap());
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 0);
    let said = nots(&c, a, NOW + 1).unwrap();
    assert_eq!(
        said,
        [(
            "Sign in to Cloudflare".to_string(),
            "done by hand".to_string(),
            NOW
        )]
    );
    assert!(
        nots(&c, a, NOW + NOT_SAID_S + 1).unwrap().is_empty(),
        "a week, then quiet"
    );
    assert_eq!(nots(&c, s, NOW).unwrap()[0].1, "not mine");

    // Undo: the card back with its word gone, the left-off the reader's again.
    assert!(crate::thread::restore_turn(&c, a, t).unwrap());
    assert!(not_left_off(&c, s, None).unwrap());
    assert!(later_left_off(&c, s, 0).unwrap());
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 2);
    assert!(nots(&c, a, NOW + 1).unwrap().is_empty());
}

/// A routine that ran and left nothing for the reader is one grey count.
#[test]
fn a_quiet_routine_is_counted_not_listed() {
    let (c, _d) = db();
    let r = desk(&c, "r");
    let id = routine(&c, r, "tidy", "p-tidy");
    c.execute(
        "INSERT INTO routine_runs(routine_id, why, what, started_at, ended_at, state) VALUES(?1, 'clock', '', ?2, ?2, 'done')",
        params![id, NOW - 60],
    )
    .unwrap();
    let oy = gather(&c, NOW).unwrap();
    assert_eq!((oy.left, oy.ran_quiet), (0, 1));
    assert_eq!(oy.sentence, "Nothing is on you.");
}

/// The tray opens itself once a day with something in it, again an hour
/// on when more became the reader's, never with the box's ⋯ off.
#[test]
fn the_tray_opens_on_arrival_once_a_day_and_when_more_came() {
    let (c, _d) = db();
    let a = desk(&c, "a");
    assert!(arrive(&c, NOW).unwrap().is_none(), "nothing to show");
    card(&c, a, "one", NOW);
    let later = NOW + DAY;
    assert_eq!(arrive(&c, later).unwrap().map(|o| o.left), Some(1));
    assert!(
        arrive(&c, later + 60).unwrap().is_none(),
        "not twice in the hour"
    );
    assert!(
        arrive(&c, later + ARRIVE_AGAIN_S + 1).unwrap().is_none(),
        "nothing new"
    );
    card(&c, a, "two", later + ARRIVE_AGAIN_S + 2);
    assert!(
        arrive(&c, later + ARRIVE_AGAIN_S + 10).unwrap().is_none(),
        "the hour runs from the last look"
    );
    assert!(arrive(&c, later + 2 * ARRIVE_AGAIN_S + 20)
        .unwrap()
        .is_some());
    set_arrive_off(&c, true).unwrap();
    assert!(arrive(&c, later + 3 * DAY).unwrap().is_none());
}

/// The sentence for one row names it, and days away lead.
#[test]
fn the_sentence_says_one_thing_and_days_away() {
    let (c, _d) = db();
    let a = desk(&c, "bos_dog");
    card(&c, a, "Pay", NOW);
    let mut oy = gather(&c, NOW).unwrap();
    assert_eq!(oy.sentence, "One thing is on you: a do card on bos_dog.");
    oy.days_away = 4;
    assert!(sentence(&oy, NOW).starts_with("Four days away. One thing"));
}
