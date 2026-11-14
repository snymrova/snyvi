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

/// A question an agent is stuck on, from its panel.
fn ask(c: &Connection, desk: i64, text: &str, at: i64, pane: &str) -> i64 {
    c.execute(
        "INSERT INTO turns(desk_id, by, kind, via, text, created_at, pane) VALUES(?1, 'claude-code', 'decide', 'agent', ?2, ?3, ?4)",
        params![desk, text, at, pane],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn kinds(oy: &OnYou) -> Vec<&'static str> {
    oy.rows.iter().map(|r| r.kind).collect()
}

const LEFT: i64 = crate::waiting::LEFT_WAIT_S;

/// Each row on its shelf (1.66): Waiting is the agents stuck on the reader,
/// newest first; To do is what only the reader can do, in rank. A
/// session's left-off is the desk's head, never a row; and the count is
/// Waiting's agents, never the To do.
#[test]
fn every_kind_is_on_its_shelf() {
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
    ask(&c, a, "Which port?", NOW - 40, "p-a");

    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["card", "routine", "card", "due", "suggested"]);
    let shelves: Vec<&str> = oy.rows.iter().map(|r| r.shelf).collect();
    assert_eq!(shelves, ["waiting", "waiting", "todo", "todo", "todo"]);
    assert_eq!((oy.left, oy.todo), (2, 3));
    let routine_row = &oy.rows[1];
    assert_eq!(
        (
            routine_row.routine.as_str(),
            routine_row.go,
            routine_row.no_doc
        ),
        ("blog-next", true, true)
    );
}

/// A routine's line is the reader's the moment it is said; a session's
/// left-off is never On you's, however long it waits (1.66).
#[test]
fn a_routines_line_waits_and_a_sessions_left_off_is_not_a_row() {
    let (c, _d) = db();
    let r = desk(&c, "routines");
    let s = desk(&c, "session");
    routine(&c, r, "news", "p-routine");
    left_off(&c, r, "Read the digest", NOW - 60, "p-routine");
    left_off(&c, s, "Approve the plan", NOW - 60, "p-session");
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["routine"]);
    assert_eq!(kinds(&gather(&c, NOW - 60 + LEFT).unwrap()), ["routine"]);
}

/// A routine whose panel has a question open on the reader is one row, the
/// question: its line said the same ask again, and On you counted it twice
/// (#202). Answered, the line is the row again.
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
    let t = ask(&c, r, "2 · Explainer: leash pulling", NOW - 120, "p-eva");
    assert_eq!(kinds(&gather(&c, NOW + LEFT).unwrap()), ["card"]);

    // Another panel's card on the same desk leaves the line alone.
    c.execute(
        "UPDATE turns SET pane = 'p-other' WHERE id = ?1",
        params![t],
    )
    .unwrap();
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["routine", "card"]);

    c.execute(
        "UPDATE turns SET pane = 'p-eva', answered_at = ?2 WHERE id = ?1",
        params![t, NOW - 10],
    )
    .unwrap();
    assert_eq!(kinds(&gather(&c, NOW).unwrap()), ["routine"]);
}

/// The count is agents, not questions (1.66): nine questions from three
/// panels are three agents waiting; the To do beside them is not counted.
#[test]
fn the_count_is_agents_not_questions() {
    let (c, _d) = db();
    let ds: Vec<i64> = ["a", "b", "c"].iter().map(|n| desk(&c, n)).collect();
    for i in 0..9 {
        let pane = format!("p{}", i % 3);
        ask(
            &c,
            ds[i % 3],
            &format!("question {i}"),
            NOW - 100 + i as i64,
            &pane,
        );
    }
    card(&c, ds[0], "Pay the invoice", NOW - 500);
    card(&c, ds[1], "Add the key", NOW - 400);
    let oy = gather(&c, NOW).unwrap();
    assert_eq!((oy.left, oy.todo), (3, 2));
    assert_eq!(oy.rows[0].text, "question 8", "the newest first");
    assert_eq!(oy.sentence, "Three agents are waiting on you, on c, b, a.");
}

/// A chore never ages off (1.66): a do card a month old is still To do,
/// while a question a day old is retired.
#[test]
fn a_chore_never_ages_and_a_question_does() {
    let (c, _d) = db();
    let a = desk(&c, "a");
    card(&c, a, "Renew the domain", NOW - 30 * DAY);
    ask(&c, a, "Tabs or spaces?", NOW - 2 * DAY, "p");
    crate::thread::retire(&c, NOW).unwrap();
    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["card"]);
    assert_eq!(oy.rows[0].shelf, "todo");
    assert_eq!(oy.left, 0);
}

/// Tomorrow keeps a card off the list until then; Not this keeps it off for
/// good, and the brief hears the word.
#[test]
fn tomorrow_and_not_this_take_rows_off() {
    let (c, _d) = db();
    let a = desk(&c, "a");
    let s = desk(&c, "s");
    let t = ask(&c, a, "Sign in to Cloudflare?", NOW - 60, "p");
    left_off(&c, s, "Pay the invoice", NOW - LEFT - 60, "p");
    assert_eq!(gather(&c, NOW).unwrap().left, 1);

    assert!(crate::thread::later_turn(&c, a, t, NOW + DAY).unwrap());
    assert!(later_left_off(&c, s, NOW + DAY).unwrap());
    assert_eq!(gather(&c, NOW).unwrap().left, 0);
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 1, "back the next day");

    assert!(crate::thread::not_turn(&c, a, t, "done by hand", NOW).unwrap());
    assert!(not_left_off(&c, s, Some("not mine")).unwrap());
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 0);
    let said = nots(&c, a, NOW + 1).unwrap();
    assert_eq!(
        said,
        [(
            "Sign in to Cloudflare?".to_string(),
            "done by hand".to_string(),
            NOW
        )]
    );
    assert!(
        nots(&c, a, NOW + NOT_SAID_S + 1).unwrap().is_empty(),
        "a week, then quiet"
    );
    assert_eq!(nots(&c, s, NOW).unwrap()[0].1, "not mine");

    // Undo: the card back with its word gone.
    assert!(crate::thread::restore_turn(&c, a, t).unwrap());
    assert!(not_left_off(&c, s, None).unwrap());
    assert_eq!(gather(&c, NOW + DAY).unwrap().left, 1);
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
    assert_eq!(oy.sentence, "Nothing is waiting on you.");
}

/// The sentence for one agent says what it waits on and where.
#[test]
fn the_sentence_says_one_thing() {
    let (c, _d) = db();
    let a = desk(&c, "bos_dog");
    ask(&c, a, "Pay?", NOW, "p");
    let oy = gather(&c, NOW).unwrap();
    assert_eq!(
        oy.sentence,
        "One agent is waiting on you: a question on bos_dog."
    );
}

/// A routine an agent made waits for Start, one changed in what it may run
/// waits for Allow, and one that cannot run says why: each a Waiting row,
/// each one agent (1.66).
#[test]
fn a_routine_to_start_allow_or_mend_waits() {
    let (c, _d) = db();
    let a = desk(&c, "a");
    c.execute(
        "INSERT INTO routines(desk_id, name, cmd, every, due_at, pane, created_at, started_at, suggested_by, asked, tried)
         VALUES(?1, 'digest', 'digest', 'every day 07:30', 0, '', ?2, 0, 'claude-code', 'a digest each morning', 'ran once, 3 lines')",
        params![a, NOW - 30],
    )
    .unwrap();
    let start = c.last_insert_rowid();
    c.execute(
        "INSERT INTO routine_times(routine_id, every, due_at) VALUES(?1, 'every day 07:30', 0)",
        params![start],
    )
    .unwrap();
    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["routine_start"]);
    let row = &oy.rows[0];
    assert_eq!(
        (
            row.routine_id,
            row.asked.as_str(),
            row.tried.as_str(),
            row.when.as_str()
        ),
        (
            start,
            "a digest each morning",
            "ran once, 3 lines",
            "every day 07:30"
        )
    );
    assert_eq!(
        oy.sentence,
        "One agent is waiting on you: start digest on a."
    );

    c.execute(
        "UPDATE routines SET started_at = ?2 WHERE id = ?1",
        params![start, NOW - 20],
    )
    .unwrap();
    assert!(
        gather(&c, NOW).unwrap().rows.is_empty(),
        "started, nothing waits"
    );
    assert!(crate::routine::stuck(&c, start, "its command is gone", NOW - 10).unwrap());
    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["routine_stuck"]);
    assert_eq!(oy.rows[0].text, "digest can't run: its command is gone");
    crate::routine::unstuck(&c, start).unwrap();
    c.execute(
        "UPDATE routines SET pending = '{\"watch\":\"watch.sh\"}' WHERE id = ?1",
        params![start],
    )
    .unwrap();
    let oy = gather(&c, NOW).unwrap();
    assert_eq!(kinds(&oy), ["routine_allow"]);
    assert_eq!(oy.rows[0].may, ["watch: watch.sh"]);
}

/// A card of questions asked together is one row and one agent (U3), its
/// questions in it; one answered in snyvi and not yet told stays in it,
/// folded (C7); all answered, the card is gone.
#[test]
fn a_card_of_questions_is_one_row() {
    let (c, _d) = db();
    let a = desk(&c, "alpha");
    for (i, q) in ["Types?", "Names?", "Tests?"].iter().enumerate() {
        c.execute(
            "INSERT INTO turns(desk_id, by, kind, via, text, created_at, ask_group) VALUES(?1, 'claude-code', 'decide', 'agent', ?2, ?3, 9)",
            params![a, q, NOW - 60 + i as i64],
        )
        .unwrap();
    }
    let oy = gather(&c, NOW).unwrap();
    assert_eq!((kinds(&oy), oy.left), (vec!["card"], 1));
    assert_eq!(oy.rows[0].turns.len(), 3);
    assert_eq!(
        oy.sentence,
        "One agent is waiting on you: three questions on alpha."
    );

    let first = oy.rows[0].turns[0].id;
    c.execute(
        "UPDATE turns SET answer = 'Integers', answered_at = ?2, answered_in = 'snyvi' WHERE id = ?1",
        params![first, NOW - 5],
    )
    .unwrap();
    let oy = gather(&c, NOW).unwrap();
    let ms = &oy.rows[0].turns;
    assert_eq!(ms.len(), 3, "the answered question keeps its place");
    assert_eq!((ms[0].id, ms[0].answer.as_str()), (first, "Integers"));

    c.execute(
        "UPDATE turns SET answer = 'x', answered_at = ?1, answered_in = 'snyvi' WHERE answered_at = 0",
        params![NOW - 1],
    )
    .unwrap();
    assert!(gather(&c, NOW).unwrap().rows.is_empty());
}

/// A question whose panel was prompted since is quiet (C3): last, apart,
/// and not one of the agents waiting.
#[test]
fn a_quiet_card_is_last_and_not_counted() {
    let (c, _d) = db();
    let a = desk(&c, "alpha");
    let q = ask(&c, a, "Run the migration?", NOW - 30, "p1");
    ask(&c, a, "Add the key?", NOW - 600, "p2");
    c.execute(
        "UPDATE turns SET quiet_at = ?2 WHERE id = ?1",
        params![q, NOW - 10],
    )
    .unwrap();
    let oy = gather(&c, NOW).unwrap();
    let texts: Vec<&str> = oy.rows.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(texts, ["Add the key?", "Run the migration?"]);
    assert_eq!((oy.left, oy.quiet), (1, 1));
    assert!(oy.rows[1].quiet);
    assert_eq!(oy.clauses, "a question on alpha");
}
