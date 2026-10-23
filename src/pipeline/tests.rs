use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn.execute_batch(crate::desk::SCHEMA).unwrap();
    conn.execute_batch(crate::desk::POS_COLUMN).unwrap();
    conn.execute_batch(crate::desk::HELD_COLUMN).unwrap();
    conn.execute_batch(crate::desk::SENT_BY_COLUMN).unwrap();
    conn.execute_batch(crate::desk::LOOP_COLUMNS_1_37).unwrap();
    conn.execute_batch(crate::due::COLUMNS_1_47).unwrap();
    conn.execute_batch(crate::waiting::COLUMNS_1_47).unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

fn list(steps: &[&str]) -> New {
    New {
        name: "Trim first paint".into(),
        kind: "list".into(),
        steps: steps
            .iter()
            .map(|t| NewStep {
                text: t.to_string(),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    }
}

fn made(m: Made) -> Pipeline {
    match m {
        Made::New(p) => *p,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_name_makes_a_branch_a_shell_and_git_both_take() {
    assert_eq!(slug("Trim first paint"), "trim-first-paint");
    assert_eq!(slug("  $(rm -rf ~) ; `x`  "), "rm-rf-x");
    assert_eq!(slug("../../main"), "main");
    assert_eq!(slug("Été 2026!"), "t-2026");
    assert_eq!(slug("…"), "");
    assert!(slug(&"a".repeat(100)).len() <= 40);
}

#[test]
fn a_pipeline_is_made_as_a_draft_with_the_readers_steps_queued() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let p = made(create(&mut c, d, "pane1", &list(&["measure", " ", "trim"]), 10).unwrap());
    assert_eq!(p.state, "draft");
    assert_eq!(p.caps, Caps::default());
    assert_eq!(p.ctx_limit, 70);
    assert_eq!(p.planner_model, "sonnet");
    let texts: Vec<_> = p
        .steps
        .iter()
        .map(|s| (s.n, s.text.as_str(), s.author.as_str(), s.state.as_str()))
        .collect();
    assert_eq!(
        texts,
        vec![
            (1, "measure", "reader", "queued"),
            (2, "trim", "reader", "queued")
        ]
    );
    // What is refused, and why, in the editor's words.
    // `check` refuses before anything is read, so any database does.
    let bad = |n: New| match create(&mut db(), d, "pane9", &n, 0).unwrap() {
        Made::Bad(w) => w,
        other => panic!("{other:?}"),
    };
    assert!(bad(list(&[])).contains("needs a step"));
    assert!(bad(New {
        kind: "goal".into(),
        ..list(&["x"])
    })
    .contains("needs its goal"));
    assert!(bad(New {
        kind: "shift".into(),
        ..list(&["x"])
    })
    .contains("list, a loop or a goal"));
    assert!(bad(New {
        name: "!!!".into(),
        ..list(&["x"])
    })
    .contains("name"));
    assert!(bad(New {
        ctx_limit: Some(99),
        ..list(&["x"])
    })
    .contains("context limit"));
    assert!(bad(list(&["x".repeat(STEP_BYTES + 1).as_str()])).contains("8,000"));
    // One active pipeline to a panel.
    set_state(&c, p.id, "running", "", 11).unwrap();
    assert_eq!(
        create(&mut c, d, "pane1", &list(&["again"]), 12).unwrap(),
        Made::Busy
    );
    assert_eq!(of_pane(&c, "pane1").unwrap().unwrap().id, p.id);
    assert_eq!(
        create(&mut c, 999, "pane2", &list(&["x"]), 12).unwrap(),
        Made::NoSuchDesk
    );
}

#[test]
fn an_edit_skips_what_it_left_out_and_never_touches_a_step_that_ran() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let p = made(create(&mut c, d, "p", &list(&["one", "two", "three"]), 0).unwrap());
    step_began(&c, p.steps[0].id, "abc", 1).unwrap();
    step_ended(
        &c,
        p.steps[0].id,
        &End {
            state: "done",
            result: "ok",
            commits: "",
            diff_lines: 3,
        },
        2,
    )
    .unwrap();
    set_state(&c, p.id, "paused", "you spoke", 3).unwrap();
    let mut n = list(&[]);
    n.steps = vec![
        NewStep {
            id: Some(p.steps[0].id),
            kind: "prompt".into(),
            text: "ONE rewritten".into(),
        },
        NewStep {
            id: Some(p.steps[2].id),
            kind: "goal".into(),
            text: "three, as a goal".into(),
        },
        NewStep {
            id: None,
            kind: "prompt".into(),
            text: "four".into(),
        },
    ];
    let Edited::Saved(e) = edit(&mut c, d, p.id, &n, 4).unwrap() else {
        panic!()
    };
    let s: Vec<_> = e
        .steps
        .iter()
        .map(|s| (s.text.as_str(), s.kind.as_str(), s.state.as_str()))
        .collect();
    assert_eq!(
        s,
        vec![
            ("one", "prompt", "done"),
            ("two", "prompt", "skipped"),
            ("three, as a goal", "goal", "queued"),
            ("four", "prompt", "queued"),
        ]
    );
    set_state(&c, p.id, "running", "", 5).unwrap();
    assert_eq!(edit(&mut c, d, p.id, &n, 6).unwrap(), Edited::Running);
    assert_eq!(edit(&mut c, 77, p.id, &n, 6).unwrap(), Edited::NotFound);
}

#[test]
fn a_stage_keeps_its_turns_its_peak_and_its_handoffs() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let p = made(create(&mut c, d, "p", &list(&["go"]), 0).unwrap());
    let s = p.steps[0].id;
    step_began(&c, s, "base1", 10).unwrap();
    step_stopped(&c, s, "sess", "/t.jsonl", "half way", 11).unwrap();
    step_peak(&c, s, 40).unwrap();
    step_peak(&c, s, 20).unwrap();
    step_handoff(&c, s, true).unwrap();
    let st = &by_id(&c, p.id).unwrap().unwrap().steps[0];
    // Asked: the stage's next Stop is the one that hands it on.
    assert_eq!((st.handoff, st.ctx_peak, st.stopped_at), (-1, 40, 0));
    // Asked twice is asked once.
    step_handoff(&c, s, true).unwrap();
    step_handoff(&c, s, false).unwrap();
    let st = &by_id(&c, p.id).unwrap().unwrap().steps[0];
    assert_eq!((st.handoff, st.stopped_at), (1, 0));
    // A second session keeps the first base: its commits are the stage's.
    step_began(&c, s, "base2", 12).unwrap();
    step_handoff(&c, s, true).unwrap();
    step_ended(
        &c,
        s,
        &End {
            state: "done",
            result: "all done",
            commits: "abc x",
            diff_lines: 9,
        },
        13,
    )
    .unwrap();
    let st = &by_id(&c, p.id).unwrap().unwrap().steps[0];
    assert_eq!(
        (
            st.base.as_str(),
            st.started_at,
            st.handoff,
            st.state.as_str()
        ),
        ("base1", 10, 1, "done")
    );
    // A failed turn puts a running stage back in line, its start kept.
    let s2 = add_step(&c, p.id, "reader", "prompt", "again", "", "queued", 14).unwrap();
    step_began(&c, s2, "b2", 15).unwrap();
    step_stopped(&c, s2, "sess", "/t.jsonl", "", 16).unwrap();
    requeue_step(&c, s2).unwrap();
    let st = by_id(&c, p.id)
        .unwrap()
        .unwrap()
        .steps
        .into_iter()
        .find(|x| x.id == s2)
        .unwrap();
    assert_eq!(
        (
            st.state.as_str(),
            st.stopped_at,
            st.base.as_str(),
            st.started_at
        ),
        ("queued", 0, "b2", 15)
    );
}

#[test]
fn nothing_is_deleted_a_cross_puts_away_and_a_skip_stays_in_the_list() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let p = made(create(&mut c, d, "p", &list(&["a"]), 0).unwrap());
    let s = add_step(
        &c, p.id, "planner", "prompt", "next", "because", "proposed", 1,
    )
    .unwrap();
    assert!(settle_step(&c, d, p.id, s, false, 2).unwrap());
    assert!(
        !settle_step(&c, d, p.id, s, true, 3).unwrap(),
        "a skipped step stays skipped"
    );
    assert!(
        !settle_step(&c, 99, p.id, p.steps[0].id, false, 3).unwrap(),
        "only on its own desk"
    );
    set_state(&c, p.id, "running", "", 4).unwrap();
    assert!(!hide(&c, d, p.id, 5).unwrap(), "not while it runs");
    set_state(&c, p.id, "stopped", "you stopped it", 6).unwrap();
    assert!(hide(&c, d, p.id, 7).unwrap());
    assert_eq!(for_desk(&c, d, 8).unwrap().len(), 1, "a day of Undo");
    assert!(for_desk(&c, d, 7 + 86_401).unwrap().is_empty());
    assert!(unhide(&c, d, p.id).unwrap());
    let back = get(&c, d, p.id).unwrap().unwrap();
    assert_eq!(back.steps.len(), 2);
    assert_eq!(back.steps[1].state, "skipped");
    assert_eq!(back.ended_at, 6);
}

#[test]
fn a_restart_pauses_what_was_running_and_a_limit_pause_comes_back_by_itself() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let a = made(create(&mut c, d, "pa", &list(&["a"]), 0).unwrap());
    let b = made(create(&mut c, d, "pb", &list(&["b"]), 0).unwrap());
    set_state(&c, a.id, "running", "", 1).unwrap();
    pause_until(&c, b.id, "the five-hour window is 85% used", 500).unwrap();
    assert_eq!(live(&c).unwrap().len(), 2);
    assert_eq!(pause_all(&c).unwrap(), 1);
    let a = by_id(&c, a.id).unwrap().unwrap();
    assert_eq!(
        (a.state.as_str(), a.why.as_str()),
        ("paused", "snyvi restarted")
    );
    assert_eq!(
        live(&c).unwrap().len(),
        1,
        "the limit's pause still comes back"
    );
}

#[test]
fn a_stage_is_told_its_step_its_branch_and_to_commit() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let mut n = list(&[]);
    n.kind = "loop".into();
    n.goal = "Find one thing to fix".into();
    n.rules = "Run node bench/size.mjs --check".into();
    let mut p = made(create(&mut c, d, "p", &n, 0).unwrap());
    p.branch = "pipeline/trim-first-paint".into();
    let id = add_step(&c, p.id, "reader", "prompt", &p.goal, "", "queued", 1).unwrap();
    let s = by_id(&c, p.id)
        .unwrap()
        .unwrap()
        .steps
        .into_iter()
        .find(|s| s.id == id)
        .unwrap();
    let text = stage_prompt(&p, &s, Some("tests pass; bench left"));
    assert!(text.starts_with("Find one thing to fix\n"));
    assert!(text.contains("pipeline/trim-first-paint"));
    assert!(text.contains("\"pipeline trim-first-paint #1: \""));
    assert!(text.contains(NOTHING_LEFT));
    assert!(text.contains("Rules: Run node bench/size.mjs --check"));
    assert!(text.contains("Where it left off: tests pass; bench left"));
    let goal = Step {
        kind: "goal".into(),
        text: "all benches green. Stop after 8 turns.".into(),
        ..s.clone()
    };
    assert_eq!(
        stage_prompt(&p, &goal, None),
        "/goal all benches green. Stop after 8 turns."
    );
}

#[test]
fn the_report_says_each_stage_who_wrote_it_and_what_came_of_it() {
    let mut c = db();
    let d = crate::desk::create(&c, "/w", None, 0).unwrap().id;
    let p = made(create(&mut c, d, "p", &list(&["measure | twice"]), 0).unwrap());
    let s = p.steps[0].id;
    step_began(&c, s, "b", 1).unwrap();
    step_stopped(
        &c,
        s,
        "9743f452-1df5-43f1-9661-fcbfcf1a7638",
        "/t",
        "61.2 KB",
        2,
    )
    .unwrap();
    step_ended(
        &c,
        s,
        &End {
            state: "done",
            result: "61.2 KB\nunder budget",
            commits: "abc1234 pipeline trim #1: measure",
            diff_lines: 0,
        },
        3,
    )
    .unwrap();
    add_step(
        &c,
        p.id,
        "planner",
        "prompt",
        "trim mmd.js",
        "2.1 KB unused",
        "skipped",
        4,
    )
    .unwrap();
    set_state(&c, p.id, "done", "all steps ran", 5).unwrap();
    let md = report(&by_id(&c, p.id).unwrap().unwrap());
    assert!(md.starts_with("# Pipeline: Trim first paint"));
    assert!(md.contains("**Why it ended:** all steps ran"));
    assert!(md.contains("| 1 | reader | measure / twice | done |"));
    assert!(md.contains("| 2 | planner | trim mmd.js | skipped |"));
    assert!(md.contains("claude --resume 9743f452-1df5-43f1-9661-fcbfcf1a7638"));
    assert!(md.contains("> under budget"));
    assert!(md.contains("*The planner:* 2.1 KB unused"));
}

#[test]
fn text_is_cut_on_a_character() {
    assert_eq!(cut("héllo", 2), "h");
    assert_eq!(cut("abc", 10), "abc");
    assert_eq!(tail("abcdef", 3), "…def");
}
