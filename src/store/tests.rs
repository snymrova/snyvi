use super::*;

fn temp_store() -> (Store, tempdir::Dir) {
    let dir = tempdir::Dir::new("snyvi-store");
    let paths = Paths {
        data_dir: dir.path.clone(),
        config_dir: dir.path.clone(),
        docs_dir: dir.path.join("docs"),
        db_path: dir.path.join("t.db"),
        token_path: dir.path.join("token"),
    };
    (Store::open(&paths).unwrap(), dir)
}

/// A document of its own, which is what most of these tests mean when they
/// set up two: the file behind it is its identity now, and a second send of
/// the same file is a version rather than a row. The body doubles as the
/// path because it is the thing that differs between them here; tests that
/// mean versions say so with `version_of`.
fn new_doc<'a>(title: &'a str, src: &'a str, wf: &'a str) -> NewDoc<'a> {
    version_of(src, title, src, wf)
}

/// The same file, sent again: a version of the document at `path`.
fn version_of<'a>(path: &'a str, title: &'a str, src: &'a str, wf: &'a str) -> NewDoc<'a> {
    NewDoc {
        project_root: "/p",
        project_name: "p",
        workflow_key: wf,
        workflow_title: wf,
        title,
        kind: Kind::Markdown,
        lang: None,
        source_path: Some(path),
        branch: None,
        origin: "cli",
        sender: "",
        desk: None,
        source: src.as_bytes(),
        staged: None,
        search_body: src,
        html: "<p>x</p>",
    }
}

#[test]
fn insert_get_previous_search() {
    let (s, _d) = temp_store();
    let a = s
        .insert(
            &new_id("a"),
            version_of("/p/PLAN.md", "Plan", "# Plan\n\nalpha bravo", "w"),
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let b = s
        .insert(
            &new_id("b"),
            version_of("/p/PLAN.md", "Plan", "# Plan\n\nalpha charlie", "w"),
        )
        .unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(s.get(&b.id).unwrap().unwrap().title, "Plan");
    assert_eq!(s.previous(&b).unwrap().unwrap().id, a.id);
    assert!(s.previous(&a).unwrap().is_none());
    let hits = s.search("charlie", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, b.id);
    assert!(
        s.search("\"unbalanced", 10).is_ok(),
        "punctuation must not break FTS"
    );
    assert_eq!(
        s.latest_for_path("/p", "/p/PLAN.md").unwrap().unwrap().id,
        b.id
    );
    // Two sends of one plan are one document with two versions: the lists
    // count what a reader can see, and history counts what was sent.
    let p = &s.projects().unwrap()[0];
    assert_eq!((p.docs, p.workflows), (1, 1));
    assert_eq!(s.project_tree(p.id, 10, 10).unwrap()[0].docs.len(), 1);
    assert_eq!(s.history(p.id, "/p/PLAN.md").unwrap().len(), 2);
}

#[test]
fn a_chosen_project_name_outranks_the_derived_one() {
    let (s, _d) = temp_store();
    let a = s.insert(&new_id("a"), new_doc("Plan", "one", "w")).unwrap();
    assert_eq!(a.project, "p");

    // The derived name follows the directory, so a send still refreshes it...
    let mut d = new_doc("Plan", "two", "w");
    d.project_name = "p-moved";
    let b = s.insert(&new_id("b"), d).unwrap();
    assert_eq!(b.project, "p-moved");

    // ...until it is named by hand, after which no send may reclaim the label.
    assert!(s.rename_project(b.project_id, "Auth work").unwrap());
    let mut d = new_doc("Plan", "three", "w");
    d.project_name = "p-moved-again";
    let c = s.insert(&new_id("c"), d).unwrap();
    assert_eq!(c.project_id, a.project_id, "the root is still the identity");
    assert_eq!(c.project, "Auth work");
    assert_eq!(s.projects().unwrap()[0].name, "Auth work");
    assert!(!s.rename_project(9999, "nobody").unwrap());
}

#[test]
fn a_renamed_workflow_keeps_the_key_that_sends_find_it_by() {
    let (s, _d) = temp_store();
    let a = s
        .insert(&new_id("a"), new_doc("Plan", "one", "sess-1"))
        .unwrap();
    assert_eq!(a.workflow_title, "sess-1");
    assert!(s.rename_workflow(a.workflow_id, "Auth refactor").unwrap());

    let b = s
        .insert(&new_id("b"), new_doc("Plan 2", "two", "sess-1"))
        .unwrap();
    assert_eq!(b.workflow_id, a.workflow_id, "same session, same workflow");
    assert_eq!(b.workflow_title, "Auth refactor");
    let t = s.project_tree(b.project_id, 10, 10).unwrap();
    assert_eq!(t[0].title, "Auth refactor");
    assert_eq!(t[0].key, "sess-1");
    assert!(!s.rename_workflow(9999, "nobody").unwrap());
}

#[test]
fn same_second_documents_keep_their_order() {
    // received_at counts whole seconds, so insertion order is the tiebreaker.
    let (s, _d) = temp_store();
    let a = s.insert(&new_id("a"), new_doc("A", "first", "w")).unwrap();
    let b = s.insert(&new_id("b"), new_doc("B", "second", "w")).unwrap();
    let c = s.insert(&new_id("c"), new_doc("C", "third", "w")).unwrap();
    // Three inserts land in one second on most machines and, on a slow
    // one, straddle a boundary -- so this asserted its own timing and
    // failed for it on a Windows runner. Put them in one second on
    // purpose: a clock that has to cooperate is not a precondition, and
    // the second they share is not what is being tested. What is, is that
    // rowid breaks the tie once received_at cannot.
    let t = a.received_at;
    s.conn
        .lock()
        .unwrap()
        .execute("UPDATE docs SET received_at = ?1", params![t])
        .unwrap();
    let (a, b, c) = (
        Doc {
            received_at: t,
            ..a
        },
        Doc {
            received_at: t,
            ..b
        },
        Doc {
            received_at: t,
            ..c
        },
    );
    let order: Vec<String> = s.inbox(9).unwrap().into_iter().map(|d| d.title).collect();
    assert_eq!(
        order,
        vec!["C", "B", "A"],
        "newest first even within a second"
    );
    assert_eq!(
        s.project_tree(c.project_id, 10, 10).unwrap()[0].docs[0].title,
        "C"
    );
    // Three files, so three documents, each the whole history of its own
    // and none of them the version before another.
    assert_eq!(s.history(a.project_id, "first").unwrap().len(), 1);
    assert!(
        s.previous(&b).unwrap().is_none() && s.previous(&c).unwrap().is_none(),
        "a different file is not a version of the one before it"
    );

    // A fourth send, of A's file, inside the same second: the tie `previous`
    // cannot break on received_at it breaks on rowid, which is the whole
    // point of the second these four share.
    let a2 = s
        .insert(&new_id("a2"), version_of("first", "A2", "first again", "w"))
        .unwrap();
    s.conn
        .lock()
        .unwrap()
        .execute("UPDATE docs SET received_at = ?1", params![t])
        .unwrap();
    let a2 = Doc {
        received_at: t,
        ..a2
    };
    assert_eq!(s.previous(&a2).unwrap().unwrap().id, a.id);
    assert!(
        s.previous(&a).unwrap().is_none(),
        "the first send of a file"
    );
    let order: Vec<String> = s.inbox(9).unwrap().into_iter().map(|d| d.title).collect();
    assert_eq!(order, vec!["A2", "C", "B"], "and A is behind A2 now");
}

#[test]
fn workflow_keys_ignore_case() {
    let (s, _d) = temp_store();
    let a = s
        .insert(&new_id("a"), new_doc("A", "one", "ksi pivot"))
        .unwrap();
    let b = s
        .insert(&new_id("b"), new_doc("B", "two", "ksi pivot"))
        .unwrap();
    assert_eq!(a.workflow_id, b.workflow_id, "same key is one workflow");
    assert_eq!(s.projects().unwrap()[0].workflows, 1);
}

#[test]
fn pin_and_prune() {
    let (s, _d) = temp_store();
    let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
    let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
    assert!(s.set_pinned(&a.id, true).unwrap());
    let dry = s.prune(now() + 10, true).unwrap();
    assert_eq!(dry.len(), 1);
    assert_eq!(s.count().unwrap(), 2, "dry run deletes nothing");
    let gone = s.prune(now() + 10, false).unwrap();
    assert_eq!(gone[0].0, b.id);
    assert_eq!(s.count().unwrap(), 1);
    assert!(s.get(&b.id).unwrap().is_none());
    assert!(s.html(&b.id).is_err(), "files removed");
    assert!(s.get(&a.id).unwrap().unwrap().pinned);
}

/// The census is what the reset sentence says and the reader types back:
/// a deleted document is not in it, a pinned one is counted twice over.
/// After the reset the store answers as a new one does, and the files are
/// gone with the rows.
#[test]
fn census_and_reset() {
    let (s, d) = temp_store();
    let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
    let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
    let c = s
        .insert(&new_id("c"), new_doc("C", "ccc", "other"))
        .unwrap();
    assert!(s.set_pinned(&a.id, true).unwrap());
    assert!(s.delete(&c.id).unwrap());
    assert_eq!(
        s.census().unwrap(),
        Census {
            documents: 2,
            projects: 1,
            pinned: 1,
            desks: 0,
        }
    );
    assert_eq!(std::fs::read_dir(d.path.join("docs")).unwrap().count(), 6);
    s.reset().unwrap();
    assert_eq!(s.census().unwrap(), Census::default());
    assert_eq!(s.count().unwrap(), 0);
    assert!(s.get(&a.id).unwrap().is_none());
    assert!(!s.undelete(&c.id).unwrap(), "the deleted one went too");
    assert!(
        s.search("aaa", 10).unwrap().is_empty(),
        "and the index with it"
    );
    assert_eq!(std::fs::read_dir(d.path.join("docs")).unwrap().count(), 0);
    // And it is a store again: the next document is the first.
    let again = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
    assert_eq!(s.count().unwrap(), 1);
    assert!(s.previous(&again).unwrap().is_none());
    let _ = b;
}

/// A desk is not a document, which is a sentence about what the library
/// reads: the tree, the inbox, the queue, the counts and the search index
/// are all documents' and a desk is in none of them. What it does share is
/// the ending -- a reset promises a store as `open` makes it on a machine
/// that has never seen snyvi, and a workspace left standing would make
/// that false.
#[test]
fn a_desk_is_not_a_document_and_a_reset_still_takes_it() {
    let (s, _d) = temp_store();
    s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
    let desk = s.create_desk("/home/p/snyvi", None).unwrap();
    assert!(matches!(
        s.open_pane(desk.id, "/home/p/snyvi", "").unwrap(),
        Opened::Pane(_)
    ));

    // Nothing that reads the library can see it -- and the reset that
    // would take it says so.
    assert_eq!(s.count().unwrap(), 1);
    assert_eq!(s.census().unwrap().documents, 1);
    assert_eq!(s.census().unwrap().desks, 1);
    assert!(s.search("snyvi", 10).unwrap().is_empty());
    assert_eq!(s.projects().unwrap().len(), 1, "the desk made no project");
    assert_eq!(s.inbox(10).unwrap().len(), 1);
    assert!(s.get(&desk.id.to_string()).unwrap().is_none());

    // And it survives a restart, because that is what a desk is for.
    assert_eq!(s.desks().unwrap().len(), 1);
    assert_eq!(s.panes_open().unwrap(), 1);

    s.reset().unwrap();
    assert_eq!(s.census().unwrap(), Census::default());
    assert!(s.desks().unwrap().is_empty());
    assert_eq!(s.panes_open().unwrap(), 0);
    // A store again: the next desk is the first.
    let again = s.create_desk("/home/p/snyvi", None).unwrap();
    assert_eq!(again.name, "snyvi");
}

/// A moved pane takes what it sent with it: the document pane 1 sent says
/// "[2]" once pane 1 is in position 2, and the other pane's the reverse.
#[test]
fn a_moved_pane_takes_its_documents_slot_with_it() {
    let (s, _d) = temp_store();
    let desk = s.create_desk("/home/p/snyvi", None).unwrap();
    for _ in 0..2 {
        assert!(matches!(
            s.open_pane(desk.id, "/home/p/snyvi", "").unwrap(),
            Opened::Pane(_)
        ));
    }
    let at = |slot| Origin {
        id: desk.id,
        name: "snyvi".into(),
        slot,
    };
    let (one, two) = (at(1), at(2));
    let mut d = new_doc("From one", "aaa", "w");
    d.desk = Some(&one);
    s.insert(&new_id("a"), d).unwrap();
    let mut d = new_doc("From two", "bbb", "w");
    d.desk = Some(&two);
    s.insert(&new_id("b"), d).unwrap();

    assert!(s.move_pane(desk.id, 1, 2).unwrap());
    let slot_of = |title: &str| {
        s.desk_docs(desk.id, 40, false)
            .unwrap()
            .into_iter()
            .find(|d| d.title == title)
            .unwrap()
            .slot
    };
    assert_eq!(slot_of("From one"), 2);
    assert_eq!(slot_of("From two"), 1);
    assert!(!s.move_pane(desk.id, 3, 1).unwrap(), "no pane at 3");
    assert_eq!(slot_of("From one"), 2, "a refused move changes nothing");
}

/// The rail's Documents list: what a pane on this desk sent, newest
/// first, and nothing another desk sent or the CLI did. A delete takes a
/// row off it, and an open clears its mark.
#[test]
fn a_desk_lists_what_its_panes_sent_newest_first() {
    let (s, _d) = temp_store();
    let here = Origin {
        id: 7,
        name: "snyvi".into(),
        slot: 2,
    };
    let elsewhere = Origin {
        id: 8,
        name: "other".into(),
        slot: 1,
    };
    fn from<'a>(o: &'a Origin, mut d: NewDoc<'a>) -> NewDoc<'a> {
        d.desk = Some(o);
        d
    }
    s.insert(&new_id("a"), from(&here, new_doc("First", "aaa", "w")))
        .unwrap();
    s.insert(
        &new_id("b"),
        from(&elsewhere, new_doc("Theirs", "bbb", "w")),
    )
    .unwrap();
    s.insert(&new_id("c"), new_doc("From the CLI", "ccc", "w"))
        .unwrap();
    let last = s
        .insert(&new_id("d"), from(&here, new_doc("Second", "ddd", "w")))
        .unwrap();

    let docs = s.desk_docs(7, 40, false).unwrap();
    assert_eq!(
        docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
        ["Second", "First"]
    );
    assert_eq!(docs[0].slot, 2);
    assert!(docs[0].unread);
    assert_eq!(docs[0].project, "p");
    assert_eq!(s.desk_docs(8, 40, false).unwrap().len(), 1);
    assert!(s.desk_docs(9, 40, false).unwrap().is_empty());

    s.mark_read(&last.id).unwrap();
    assert!(!s.desk_docs(7, 40, false).unwrap()[0].unread);
    s.delete(&last.id).unwrap();
    assert_eq!(s.desk_docs(7, 40, false).unwrap().len(), 1);

    // The same file again is the same row, not another: a pane rewriting
    // what it sent leaves the desk holding one of it.
    let again = s
        .insert(
            &new_id("e"),
            from(&here, version_of("aaa", "First, again", "eee", "w")),
        )
        .unwrap();
    assert_eq!(
        s.desk_docs(7, 40, false)
            .unwrap()
            .iter()
            .map(|d| d.title.as_str())
            .collect::<Vec<_>>(),
        ["First, again"]
    );
    // ...and a version of it sent from anywhere else leaves that row alone,
    // because what a desk shows is what its own panes sent.
    s.insert(
        &new_id("f"),
        version_of("aaa", "First, elsewhere", "fff", "w"),
    )
    .unwrap();
    let listed = s.desk_docs(7, 40, false).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, again.id);

    // Removed from the desk's list: gone from it, on the other half, and
    // no older version comes up in its place. Undo puts it back.
    assert!(s.set_desk_doc_off(7, &again.id, true).unwrap());
    assert!(s.desk_docs(7, 40, false).unwrap().is_empty());
    let off = s.desk_docs(7, 40, true).unwrap();
    assert_eq!(off.len(), 1);
    assert_eq!(off[0].id, again.id);
    // Another desk's document is not this desk's to remove.
    assert!(!s.set_desk_doc_off(8, &again.id, true).unwrap());
    assert!(s.set_desk_doc_off(7, &again.id, false).unwrap());
    assert_eq!(s.desk_docs(7, 40, false).unwrap()[0].id, again.id);
    assert!(s.desk_docs(7, 40, true).unwrap().is_empty());
}

/// A delete is gone from everywhere that reads the library and still on
/// disk, so Undo is one column -- and `prune` is what makes it final.
#[test]
fn a_file_sent_again_is_one_row_with_its_versions_behind_it() {
    let (s, _d) = temp_store();
    let first = s
        .insert(&new_id("1"), version_of("/p/S.md", "Script", "one", "w"))
        .unwrap();
    let second = s
        .insert(&new_id("2"), version_of("/p/S.md", "Script v2", "two", "w"))
        .unwrap();
    let third = s
        .insert(
            &new_id("3"),
            version_of("/p/S.md", "Script v3", "three", "w"),
        )
        .unwrap();
    let other = s
        .insert(&new_id("o"), new_doc("Notes", "elsewhere", "w"))
        .unwrap();

    // Every list shows the newest send and the other document. This is the
    // pile the sidebar used to be: one script, sent three times, three rows.
    let titles = |v: Vec<Doc>| v.into_iter().map(|d| d.title).collect::<Vec<_>>();
    assert_eq!(titles(s.inbox(10).unwrap()), vec!["Notes", "Script v3"]);
    let wfs = s.project_tree(first.project_id, 0, 0).unwrap();
    assert_eq!(titles(s.queue(10).unwrap()), vec!["Script v3", "Notes"]);
    assert_eq!(
        wfs[0]
            .docs
            .iter()
            .map(|d| d.title.as_str())
            .collect::<Vec<_>>(),
        ["Notes", "Script v3"]
    );
    assert_eq!(wfs[0].total, 2, "and it says two, not four");
    assert_eq!(s.projects().unwrap()[0].docs, 2);

    // Nothing was thrown away: the versions are where a reader goes for them.
    let hist = s.history(first.project_id, "/p/S.md").unwrap();
    assert_eq!(titles(hist), vec!["Script v3", "Script v2", "Script"]);
    assert_eq!(s.get(&first.id).unwrap().unwrap().title, "Script");
    assert_eq!(
        s.latest_for_path("/p", "/p/S.md").unwrap().unwrap().id,
        third.id
    );

    // And two things are waiting, not four: a version that replaced an
    // unread one took its place on the queue rather than queueing beside
    // it, so the badge counts rows a reader can actually reach.
    assert_eq!(s.waiting().unwrap(), 2);
    assert!(!s.mark_read(&second.id).unwrap(), "already off the queue");
    assert!(s.mark_read(&third.id).unwrap());
    assert_eq!(s.waiting().unwrap(), 1);
    let _ = other;
}

#[test]
fn removed_lists_what_can_come_back_newest_first_one_row_per_removal() {
    let (s, _d) = temp_store();
    s.insert(&new_id("1"), version_of("/p/S.md", "Script", "one", "w"))
        .unwrap();
    let newest = s
        .insert(&new_id("2"), version_of("/p/S.md", "Script v2", "two", "w"))
        .unwrap();
    let other = s
        .insert(&new_id("o"), new_doc("Notes", "elsewhere", "w"))
        .unwrap();
    s.insert(&new_id("k"), new_doc("Kept", "stays", "w"))
        .unwrap();
    assert!(
        s.removed(10, true).unwrap().is_empty(),
        "nothing removed, nothing listed"
    );

    assert_eq!(s.delete_versions(&newest.id).unwrap(), 2);
    s.delete(&other.id).unwrap();
    let desk = s.create_desk("/home/p/snyvi", None).unwrap();
    let note = s.add_desk_note(desk.id, "ship it").unwrap().unwrap();
    assert!(s.remove_desk_note(desk.id, note.id).unwrap());

    let docs: Vec<_> = s.removed(10, false).unwrap();
    assert!(
        docs.iter().all(|r| r.kind == "doc"),
        "no desk rows without the desk's gate"
    );
    assert_eq!(
        docs.len(),
        2,
        "one row for the lineage, one for the other: {docs:?}"
    );
    let script = docs
        .iter()
        .find(|r| r.versions == 2)
        .expect("the lineage says how many went");
    assert_eq!(script.title, "Script v2", "named by its newest version");
    assert_eq!(script.restore, format!("/api/docs/{}/undelete", script.id));

    let all = s.removed(10, true).unwrap();
    let n = all
        .iter()
        .find(|r| r.kind == "note")
        .expect("the removed note is listed");
    assert_eq!((n.title.as_str(), n.desk), ("ship it", Some(desk.id)));
    assert_eq!(
        n.restore,
        format!("/api/desks/{}/notes/{}/restore", desk.id, note.id)
    );
    assert!(all.windows(2).all(|w| w[0].at >= w[1].at), "newest first");

    // Brought back, it leaves the list.
    assert!(s.undelete(&script.id).unwrap());
    assert!(s.restore_desk_note(desk.id, note.id).unwrap());
    let left = s.removed(10, true).unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].title, "Notes");
}

#[test]
fn removing_a_document_takes_its_versions_and_undo_brings_them_back() {
    let (s, _d) = temp_store();
    let first = s
        .insert(&new_id("1"), version_of("/p/S.md", "Script", "one", "w"))
        .unwrap();
    let newest = s
        .insert(&new_id("2"), version_of("/p/S.md", "Script v2", "two", "w"))
        .unwrap();
    let keep = s
        .insert(&new_id("k"), new_doc("Notes", "elsewhere", "w"))
        .unwrap();

    // One ✕ on one row removes one document, versions and all -- otherwise
    // the version behind it takes its place and the delete reads as undone.
    // It says how many went, which is what the page's Undo names.
    assert_eq!(s.delete_versions(&newest.id).unwrap(), 2);
    assert!(s.get(&first.id).unwrap().is_none());
    assert_eq!(s.inbox(10).unwrap().len(), 1);
    assert!(s.history(first.project_id, "/p/S.md").unwrap().is_empty());
    assert_eq!(s.get(&keep.id).unwrap().unwrap().title, "Notes");

    assert!(s.undelete(&newest.id).unwrap());
    assert_eq!(
        s.history(first.project_id, "/p/S.md").unwrap().len(),
        2,
        "both versions came back, not just the one that was clicked"
    );
    assert_eq!(s.inbox(10).unwrap().len(), 2);

    // Reading an old version and pressing Delete removes the same thing: the
    // document it is a version of. Which snapshot is on screen is not a
    // different document to delete.
    assert!(s.delete(&first.id).unwrap());
    assert!(s.history(first.project_id, "/p/S.md").unwrap().is_empty());
    assert!(s.undelete(&first.id).unwrap());
    assert_eq!(s.history(first.project_id, "/p/S.md").unwrap().len(), 2);
}

#[test]
fn a_delete_can_be_taken_back_until_prune() {
    let (s, _d) = temp_store();
    let a = s.insert(&new_id("a"), new_doc("A", "alpha", "w")).unwrap();
    let b = s.insert(&new_id("b"), new_doc("B", "bravo", "w")).unwrap();
    assert!(s.delete(&b.id).unwrap());
    assert!(
        !s.delete(&b.id).unwrap(),
        "deleting it again changes nothing"
    );

    // Gone from every way the library is read.
    assert!(s.get(&b.id).unwrap().is_none());
    assert_eq!(s.count().unwrap(), 1);
    assert_eq!(s.inbox(10).unwrap().len(), 1);
    assert_eq!(s.waiting().unwrap(), 1, "and off the queue");
    assert!(s.search("bravo", 10).unwrap().is_empty());
    let wfs = s.project_tree(a.project_id, 0, 0).unwrap();
    assert_eq!(wfs[0].total, 1);
    assert_eq!(wfs[0].docs.len(), 1);
    assert_eq!(s.projects().unwrap()[0].docs, 1, "the sidebar's count too");
    assert!(s.html(&b.id).is_ok(), "still on disk");

    // And back, queue place and all.
    assert!(s.undelete(&b.id).unwrap());
    assert!(!s.undelete(&b.id).unwrap(), "undoing twice changes nothing");
    assert_eq!(s.get(&b.id).unwrap().unwrap().title, "B");
    assert_eq!(s.waiting().unwrap(), 2);
    assert_eq!(s.search("bravo", 10).unwrap().len(), 1);

    // Pruned, and now it is gone for good -- pinned or not, old or not.
    assert!(s.set_pinned(&b.id, true).unwrap());
    assert!(s.delete(&b.id).unwrap());
    let gone = s.prune(0, false).unwrap();
    assert_eq!(gone.len(), 1, "nothing here is old enough but this one");
    assert_eq!(gone[0].0, b.id);
    assert!(!s.undelete(&b.id).unwrap(), "nothing left to put back");
    assert!(s.html(&b.id).is_err(), "files removed");
    assert_eq!(s.get(&a.id).unwrap().unwrap().title, "A");
}

/// The queue is the unread set in arrival order: every insert joins it,
/// an open leaves it once, an overwrite changes nothing about it, and a
/// clear empties it and says what left.
#[test]
fn the_queue_is_what_arrived_and_was_not_opened() {
    let (s, _d) = temp_store();
    assert!(s.queue(10).unwrap().is_empty());
    let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
    let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
    let ids = |q: Vec<Doc>| q.into_iter().map(|d| d.id).collect::<Vec<_>>();
    assert_eq!(
        ids(s.queue(10).unwrap()),
        vec![a.id.clone(), b.id.clone()],
        "oldest first"
    );
    assert_eq!(s.waiting().unwrap(), 2);
    assert!(s.mark_read(&a.id).unwrap());
    assert!(!s.mark_read(&a.id).unwrap(), "already read");
    assert_eq!(s.waiting().unwrap(), 1);
    assert_eq!(ids(s.queue(10).unwrap()), vec![b.id.clone()]);
    s.replace(&b.id, new_doc("B2", "bbb2", "w")).unwrap();
    assert_eq!(
        ids(s.queue(10).unwrap()),
        vec![b.id.clone()],
        "an overwrite is not an arrival"
    );
    let c = s.insert(&new_id("c"), new_doc("C", "ccc", "w")).unwrap();
    let cleared = s.mark_all_read().unwrap();
    assert_eq!(cleared, vec![b.id, c.id]);
    assert!(s.queue(10).unwrap().is_empty());
    assert!(s.mark_all_read().unwrap().is_empty());
    // And taken back: both wait again, in the order they came, and one
    // removed in between stays gone.
    s.delete(&cleared[1]).unwrap();
    let back = s.mark_unread(&cleared).unwrap();
    assert_eq!(back, vec![cleared[0].clone()]);
    assert_eq!(ids(s.queue(10).unwrap()), vec![cleared[0].clone()]);
    assert!(
        s.mark_unread(&cleared).unwrap().is_empty(),
        "already waiting"
    );
}

#[test]
fn replace_keeps_id_and_updates_index() {
    let (s, _d) = temp_store();
    let a = s
        .insert(&new_id("a"), new_doc("A", "first draft", "w"))
        .unwrap();
    let r = s
        .replace(&a.id, new_doc("A2", "second draft", "w"))
        .unwrap();
    assert_eq!(r.id, a.id);
    assert_eq!(r.title, "A2");
    assert_eq!(s.source(&a.id).unwrap(), "second draft");
    assert!(s.search("first", 5).unwrap().is_empty());
    assert_eq!(s.search("second", 5).unwrap().len(), 1);
}

/// The sidebar is bounded, which is the whole point of these three queries:
/// a project row costs the same whatever is behind it, an expanded project
/// is a screenful, and everything past the caps is still reachable -- whole,
/// and only when asked for.
#[test]
fn an_expanded_project_is_a_screenful_not_a_year() {
    let (s, _d) = temp_store();
    // Twelve sessions of twelve documents: past both caps, in both
    // directions, so a cap that only held in one would show here.
    for w in 0..12 {
        for i in 0..12 {
            let body = format!("session {w}, document {i}");
            s.insert(
                &new_id(&format!("d{w}-{i}")),
                new_doc("Plan", &body, &format!("sess-{w}")),
            )
            .unwrap();
        }
    }

    let p = s.projects().unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!(
        (p[0].docs, p[0].workflows),
        (144, 12),
        "a row carries what is behind it as two numbers, not as rows"
    );

    let capped = s.project_tree(p[0].id, 10, 10).unwrap();
    assert_eq!(capped.len(), 10, "ten of the twelve sessions");
    assert!(
        capped.iter().all(|w| w.docs.len() == 10 && w.total == 12),
        "ten documents each, and each says it holds twelve"
    );

    let all = s.project_tree(p[0].id, 0, 0).unwrap();
    assert_eq!(all.len(), 12, "a zero cap is a reader asking for the rest");
    assert!(all.iter().all(|w| w.docs.len() == 12));

    // What `[` and `]` walk. Never capped: a reader stepping back through
    // the versions of a plan has to reach the first one.
    let w = s.workflow_tree(capped[0].id).unwrap().unwrap();
    assert_eq!((w.docs.len(), w.total), (12, 12));
    assert!(s.workflow_tree(9999).unwrap().is_none());
}
