use super::*;
use crate::store::tempdir::Dir;

/// A store as the daemon has it, opened again as a plain connection, as
/// `onyou`'s tests do: a decision reads turns, threads and the library.
fn db() -> (Connection, Dir) {
    let dir = Dir::new("snyvi-ledger");
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
const DOC: &str = "0942b4acbe";

fn desk(c: &Connection, name: &str) -> i64 {
    crate::desk::create(c, &format!("/w/{name}"), Some(name), 0)
        .unwrap()
        .id
}

/// A question as `ask` leaves it, asked at `at` under `doc`.
fn asked(c: &Connection, desk: i64, text: &str, doc: &str, at: i64) -> i64 {
    c.execute(
        "INSERT INTO turns(desk_id, pane, by, kind, via, text, options, recommended, link, created_at)
         VALUES(?1, 'p1', 'claude-code', 'decide', 'ask', ?2, 'Yes\nNo', 0, ?3, ?4)",
        params![desk, text, doc, at],
    )
    .unwrap();
    c.last_insert_rowid()
}

fn put_away(c: &Connection, id: i64, by: &str, at: i64) {
    c.execute(
        "UPDATE turns SET removed_at = ?2, removed_by = ?3 WHERE id = ?1",
        params![id, at, by],
    )
    .unwrap();
}

fn states(all: &[Decision]) -> Vec<(i64, &'static str)> {
    all.iter().map(|d| (d.id, d.state)).collect()
}

fn one(c: &Connection, desk: i64, id: i64) -> Decision {
    for_desk(c, desk, NOW)
        .unwrap()
        .into_iter()
        .find(|d| d.id == id)
        .unwrap()
}

/// The four states, and what is on no shelf: the reader's ✕, an agent's
/// put-away, a card a newer one replaced, a dialog that closed.
#[test]
fn a_decision_is_open_later_answered_or_dropped_and_what_was_taken_back_is_not_listed() {
    let (c, _dir) = db();
    let d = desk(&c, "snyvi");
    let fresh = asked(&c, d, "Fresh?", "", NOW - 60);
    let aged = asked(&c, d, "Aged?", "", NOW - 9 * DAY);
    put_away(&c, aged, "aged", NOW - 8 * DAY);
    let later = asked(&c, d, "Later?", "", NOW - 2 * DAY);
    c.execute(
        "UPDATE turns SET until = ?2 WHERE id = ?1",
        params![later, NOW + DAY],
    )
    .unwrap();
    let answered = asked(&c, d, "Answered?", "", NOW - 3 * DAY);
    crate::thread::answer(&c, d, answered, "Yes", "snyvi", NOW - DAY)
        .unwrap()
        .unwrap();
    let dropped = asked(&c, d, "Dropped?", "", NOW - 4 * DAY);
    assert!(crate::thread::not_turn(&c, d, dropped, "not this year", NOW - DAY).unwrap());
    for (text, by) in [
        ("Mine?", "you"),
        ("Agent's?", "agent"),
        ("Old words?", "replaced"),
        ("Dialog?", "panel"),
    ] {
        let id = asked(&c, d, text, "", NOW - DAY);
        put_away(&c, id, by, NOW - 60);
    }
    // An errand is not a decision, however long it waits.
    c.execute(
        "INSERT INTO turns(desk_id, by, kind, via, text, created_at) VALUES(?1, 'claude-code', 'do', 'ask', 'Pay', ?2)",
        params![d, NOW - 60],
    )
    .unwrap();

    let all = for_desk(&c, d, NOW).unwrap();
    assert_eq!(
        states(&all),
        [
            (aged, "open"),
            (fresh, "open"),
            (later, "later"),
            (answered, "answered"),
            (dropped, "dropped"),
        ],
        "open oldest first, then later, answered, dropped"
    );
    assert!(one(&c, d, aged).aged && !one(&c, d, fresh).aged);
    assert_eq!(one(&c, d, later).until, NOW + DAY);
    assert_eq!(one(&c, d, fresh).options, ["Yes", "No"]);
    let a = one(&c, d, answered);
    assert_eq!(
        (a.answer.as_str(), a.answered_in.as_str()),
        ("Yes", "snyvi")
    );
    assert_eq!(one(&c, d, dropped).answer, "not this year");
    assert_eq!(
        counts(&all),
        Counts {
            open: 2,
            later: 1,
            answered: 1,
            dropped: 1,
            oldest_open_at: NOW - 9 * DAY,
        }
    );
}

/// One desk's, never another's: the read an agent is given is its desk's.
#[test]
fn another_desks_decisions_are_never_read() {
    let (c, _dir) = db();
    let (mine, theirs) = (desk(&c, "snyvi"), desk(&c, "ledger"));
    asked(&c, mine, "Mine?", "", NOW);
    let other = asked(&c, theirs, "Theirs?", "", NOW);
    let all = for_desk(&c, mine, NOW).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].text, "Mine?");
    // And a press on this desk's shelf does not reach it.
    assert!(!answer(&c, mine, other, "Yes", NOW).unwrap());
    assert!(!later(&c, mine, other, NOW + DAY).unwrap());
    assert!(!drop_it(&c, mine, other, "no", NOW).unwrap());
    assert_eq!(one(&c, theirs, other).state, "open");
}

/// A decision carries its document's title and its thread's name, and the
/// query finds it by either, by its question or by its answer.
#[test]
fn a_decision_names_its_document_and_thread_and_a_query_finds_it_by_them() {
    let (c, _dir) = db();
    let d = desk(&c, "snyvi");
    c.execute_batch(
        "INSERT INTO projects(id, root, name, created_at) VALUES(1, '/w/snyvi', 'snyvi', 0);
         INSERT INTO workflows(id, project_id, key, title, created_at) VALUES(1, 1, 'p', 'Plans', 0);",
    )
    .unwrap();
    c.execute(
        "INSERT INTO docs(id, project_id, workflow_id, title, kind, size, received_at, content_hash)
         VALUES(?1, 1, 1, 'Primitives for agents', 'markdown', 1, 0, 'h')",
        params![DOC],
    )
    .unwrap();
    c.execute(
        "INSERT INTO threads(desk_id, name, created_at, moved_at) VALUES(?1, 'read_desk 1.65', 0, 0)",
        params![d],
    )
    .unwrap();
    let thread = c.last_insert_rowid();
    let q = asked(&c, d, "Shelf on Home too?", DOC, NOW);
    c.execute(
        "UPDATE turns SET thread_id = ?2 WHERE id = ?1",
        params![q, thread],
    )
    .unwrap();
    let web = asked(&c, d, "Deploy the relay?", "https://example.com/x", NOW);
    crate::thread::answer(&c, d, web, "After the audit", "snyvi", NOW)
        .unwrap()
        .unwrap();

    let got = one(&c, d, q);
    assert_eq!(
        (
            got.doc.as_str(),
            got.doc_title.as_str(),
            got.thread.as_str()
        ),
        (DOC, "Primitives for agents", "read_desk 1.65")
    );
    assert_eq!(one(&c, d, web).doc, "", "a web link is not a document");

    let find = |words: &str| -> Vec<i64> {
        matching(for_desk(&c, d, NOW).unwrap(), words)
            .iter()
            .map(|d| d.id)
            .collect()
    };
    assert_eq!(find("primitives"), [q], "by its document");
    assert_eq!(find("READ_DESK"), [q], "by its thread, whatever the case");
    assert_eq!(find("shelf home"), [q], "every word, in any order");
    assert_eq!(find("audit"), [web], "by its answer");
    assert_eq!(find("shelf audit"), Vec::<i64>::new());
    assert_eq!(find("  ").len(), 2, "no words, all of them");
}

/// The shelf's three presses reach a question put away by age, which the
/// turn's own refuse; and an answer given there is told to its panel.
#[test]
fn the_shelf_answers_puts_off_and_drops_a_question_put_away_by_age() {
    let (c, _dir) = db();
    let d = desk(&c, "snyvi");
    let ask_aged = |text: &str| {
        let id = asked(&c, d, text, "", NOW - 5 * DAY);
        put_away(&c, id, "aged", NOW - 4 * DAY);
        id
    };
    let (a, l, x) = (
        ask_aged("Answer me"),
        ask_aged("Later"),
        ask_aged("Drop me"),
    );
    assert!(
        crate::thread::answer(&c, d, a, "Yes", "snyvi", NOW)
            .unwrap()
            .is_none(),
        "the turn's own answer refuses one put away"
    );

    assert!(answer(&c, d, a, "  Yes,  go  ", NOW).unwrap());
    let got = one(&c, d, a);
    assert_eq!(
        (got.state, got.answer.as_str(), got.answered_in.as_str()),
        ("answered", "Yes, go", "snyvi")
    );
    let live = vec!["p1".to_string()];
    let told = crate::thread::take_untold(&c, d, "p1", &live, NOW + 1).unwrap();
    assert_eq!(told.len(), 1, "its panel hears it at its next prompt");
    assert_eq!(told[0].id, a);
    assert!(!answer(&c, d, a, "", NOW).unwrap(), "no words, no answer");

    assert!(later(&c, d, l, NOW + 7 * DAY).unwrap());
    assert_eq!(one(&c, d, l).state, "later");
    // Back among the living, and not put away again before its day.
    assert_eq!(crate::thread::retire(&c, NOW + DAY).unwrap(), 0);
    assert_eq!(
        for_desk(&c, d, NOW + 7 * DAY + 1)
            .unwrap()
            .iter()
            .find(|d| d.id == l)
            .unwrap()
            .state,
        "open"
    );

    assert!(drop_it(&c, d, x, "superseded by 1.65", NOW).unwrap());
    let got = one(&c, d, x);
    assert_eq!(
        (got.state, got.answer.as_str()),
        ("dropped", "superseded by 1.65")
    );
    // The brief says a Not this for a week (`onyou::nots`).
    let nots = crate::onyou::nots(&c, d, NOW + 1).unwrap();
    assert_eq!(nots.len(), 1);
    assert_eq!(nots[0].1, "superseded by 1.65");
    // And Undo is the turn's own: open again.
    assert!(crate::thread::restore_turn(&c, d, x).unwrap());
    assert_eq!(one(&c, d, x).state, "open");

    // Neither puts off nor drops what is answered.
    assert!(!later(&c, d, a, NOW + DAY).unwrap());
    assert!(!drop_it(&c, d, a, "no", NOW).unwrap());
}

/// An answer the agent heard in the panel is the reader's to change on the
/// shelf, and the change is told; one the reader removed is not the
/// shelf's to touch.
#[test]
fn an_answer_heard_in_the_panel_can_be_changed_and_a_removed_question_cannot() {
    let (c, _dir) = db();
    let d = desk(&c, "snyvi");
    let heard = asked(&c, d, "Shelf where?", "", NOW - 60);
    assert_eq!(
        crate::thread::settle_asks(&c, d, "p1", &[(heard, "Each desk's rail".into())], NOW - 30)
            .unwrap(),
        1
    );
    let got = one(&c, d, heard);
    assert_eq!(
        (got.answer.as_str(), got.answered_in.as_str()),
        ("Each desk's rail", "panel")
    );
    let live = vec!["p1".to_string()];
    assert!(
        crate::thread::take_untold(&c, d, "p1", &live, NOW - 20)
            .unwrap()
            .is_empty(),
        "said in the panel: nothing to tell"
    );
    assert!(answer(&c, d, heard, "Home too", NOW).unwrap());
    let got = one(&c, d, heard);
    assert_eq!(
        (got.answer.as_str(), got.answered_in.as_str()),
        ("Home too", "snyvi")
    );
    assert_eq!(
        crate::thread::take_untold(&c, d, "p1", &live, NOW + 1)
            .unwrap()
            .len(),
        1,
        "the correction is told"
    );

    let gone = asked(&c, d, "Removed?", "", NOW - 60);
    put_away(&c, gone, "you", NOW - 30);
    assert!(!answer(&c, d, gone, "Yes", NOW).unwrap());
    assert!(!later(&c, d, gone, NOW + DAY).unwrap());
    assert!(!drop_it(&c, d, gone, "no", NOW).unwrap());
}
