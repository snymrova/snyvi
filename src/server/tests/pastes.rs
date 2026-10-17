//! Pasted pictures: kept as files for the agent, cleared after a week.

use crate::server::api_desk;

/// The sweep takes pictures past their week and leaves the rest: a new
/// picture, an old file that is not a picture, and -- once it has looked --
/// nothing more until a day has gone by.
#[test]
fn pasted_pictures_go_after_a_week_and_nothing_else_does() {
    let tmp = crate::store::tempdir::Dir::new("snyvi-pastes");
    let dir = tmp.path.join("pastes");
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now();
    let day = std::time::Duration::from_secs(24 * 3600);
    let put = |name: &str, age: std::time::Duration| {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(now - age)
            .unwrap();
        p
    };
    let old = put("aaaa.png", day * 8);
    let new = put("bbbb.jpg", day * 2);
    let other = put("notes.txt", day * 30);

    assert_eq!(api_desk::sweep_pastes(&dir, now), 1);
    assert!(!old.exists() && new.exists() && other.exists());

    // Within the day the folder is not read again, however old a picture is.
    let later = put("cccc.webp", day * 9);
    assert_eq!(api_desk::sweep_pastes(&dir, now), 0);
    assert!(later.exists());
    assert_eq!(api_desk::sweep_pastes(&dir, now + day * 2), 1);
    assert!(!later.exists());
}
