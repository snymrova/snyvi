//! A desk's keys through `snyvi key`: its own, the every-desk ones, and no
//! other desk's.

use super::*;

/// `snyvi key NAME` answers with the value of a key the pane's desk has --
/// its own, or the every-desk one, its own first -- marks it used, and
/// refuses another desk's, a name that is not one, and a key whose value is
/// gone, saying so by name only.
#[test]
fn a_panel_reads_its_own_desks_keys_and_no_other_desks() {
    let tmp = crate::store::tempdir::Dir::new("snyvi-pane-key");
    let paths = Paths {
        data_dir: tmp.path.join("data"),
        config_dir: tmp.path.join("config"),
        docs_dir: tmp.path.join("data").join("docs"),
        db_path: tmp.path.join("data").join("snyvi.db"),
        token_path: tmp.path.join("config").join("token"),
    };
    let store = Store::open(&paths).unwrap();
    let secrets = crate::secrets::Secrets::file_only(tmp.path.join("keys.json"));
    let a = store.create_desk("/tmp/a", Some("a")).unwrap().id;
    let b = store.create_desk("/tmp/b", Some("b")).unwrap().id;
    let every = crate::desk::EVERY_DESK;
    for (desk, name, value) in [
        (a, "ELEVENLABS_API_KEY", "a-eleven"),
        (b, "OTHER_KEY", "b-other"),
        (every, "GH_TOKEN", "every-gh"),
        (a, "GH_TOKEN", "a-gh"),
        (every, "OPENAI_API_KEY", "every-openai"),
    ] {
        store.add_desk_key(desk, name, "").unwrap();
        secrets.keep(desk, name, value).unwrap();
    }

    assert_eq!(
        desk_key(&store, &secrets, a, "ELEVENLABS_API_KEY").unwrap(),
        "a-eleven"
    );
    assert_eq!(
        desk_key(&store, &secrets, a, "GH_TOKEN").unwrap(),
        "a-gh",
        "its own first"
    );
    assert_eq!(
        desk_key(&store, &secrets, b, "GH_TOKEN").unwrap(),
        "every-gh"
    );
    assert_eq!(
        desk_key(&store, &secrets, a, "OPENAI_API_KEY").unwrap(),
        "every-openai"
    );
    assert!(
        store
            .desk_keys(a)
            .unwrap()
            .iter()
            .any(|k| k.name == "ELEVENLABS_API_KEY" && k.used_at > 0),
        "a read marks the key used"
    );

    let (s, why) = desk_key(&store, &secrets, a, "OTHER_KEY").unwrap_err();
    assert_eq!(s, StatusCode::NOT_FOUND, "another desk's key");
    assert!(
        why.contains("OTHER_KEY") && !why.contains("b-other"),
        "{why}"
    );
    let (s, _) = desk_key(&store, &secrets, a, "lower; rm").unwrap_err();
    assert_eq!(s, StatusCode::BAD_REQUEST, "not a name");
    secrets.forget(a, "ELEVENLABS_API_KEY");
    let (s, why) = desk_key(&store, &secrets, a, "ELEVENLABS_API_KEY").unwrap_err();
    assert_eq!(s, StatusCode::NOT_FOUND, "a name whose value is gone");
    assert!(why.contains("add it again"), "{why}");
}
