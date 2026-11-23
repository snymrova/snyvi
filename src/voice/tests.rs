use super::*;

#[test]
fn a_helper_speaks_this_daemons_frames_by_the_first_two_parts_of_its_version() {
    assert!(speaks("0.1"));
    assert!(speaks("0.1.0"));
    assert!(speaks("0.1.12"));
    assert!(!speaks("0.2.0"));
    assert!(!speaks("0.10.0"), "0.10 is not 0.1 with a nought");
    assert!(!speaks(""));
}

#[test]
fn nothing_fetched_is_not_installed_and_not_on() {
    let d = scratch("empty");
    let v = Voice::new(&d);
    assert!(!v.installed() && !v.on());
    assert_eq!(v.receipt(), Receipt::default());
    let s = v.status();
    assert_eq!(
        (&s["installed"], &s["on"], &s["bytes"]),
        (&json!(false), &json!(false), &json!(0))
    );
    assert!(v.wake().is_err(), "nothing to start");
    assert!(v.remove().is_ok(), "removing nothing is not an error");
}

// The rest start a process, and the stand-in for the helper is a shell
// script: what is under test is this module's side of the pipe, and the
// helper's own side is ears/tests/takes.rs, against the real model.
#[cfg(unix)]
mod with_a_stand_in {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A take of two samples is 27 bytes of frames: S and a rate (9), A and
    /// eight bytes (13), E (5). The stand-in answers each 27 it reads.
    const SOUND: [u8; 8] = [0; 8];

    fn stand_in(version: &str, then: &str) -> String {
        format!(
            "#!/bin/sh\necho '{{\"ready\":true,\"version\":\"{version}\",\"load_ms\":1}}'\n{then}\n"
        )
    }

    const ANSWERS: &str = r#"while n=$(head -c 27 | wc -c) && [ $((n)) -eq 27 ]; do
  echo '{"level":0.5,"quiet":false,"speech_ms":900,"heard":"Opening box","ms":3}'
done"#;

    /// `<name>.tar.gz` in `dir`, holding `top/<file>` for each file.
    fn tarball(dir: &Path, name: &str, top: &str, files: &[(&str, &str, u32)]) -> PathBuf {
        let path = dir.join(name);
        let gz = flate2::write::GzEncoder::new(
            fs::File::create(&path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        for (file, body, mode) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(body.len() as u64);
            h.set_mode(*mode);
            h.set_cksum();
            tar.append_data(&mut h, format!("{top}/{file}"), body.as_bytes())
                .unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
        path
    }

    fn model_tar(dir: &Path, tokens: &str) -> PathBuf {
        tarball(
            dir,
            "model.tar.gz",
            "snyvi-ears-model-en",
            &[
                ("encoder_model.ort", "e", 0o644),
                ("decoder_model_merged.ort", "d", 0o644),
                ("tokens.txt", tokens, 0o644),
            ],
        )
    }

    /// A voice with a stand-in helper and a model of three small files, put
    /// in place by `place` as a fetch would.
    fn placed(name: &str, script: &str) -> Voice {
        let d = scratch(name);
        let v = Voice::new(&d);
        let tmp = d.join("voice/fetching");
        fs::create_dir_all(&tmp).unwrap();
        let ears = tarball(
            &tmp,
            "ears.tar.gz",
            "snyvi-ears-linux-x64",
            &[(HELPER, script, 0o755)],
        );
        let model = model_tar(&tmp, "one");
        let receipt = Receipt {
            version: "1.70.0".into(),
            ears: "a".repeat(64),
            model: "b".repeat(64),
        };
        v.place(&ears, Some(&model), &receipt).unwrap();
        assert_eq!(v.receipt(), receipt);
        v
    }

    #[test]
    fn what_is_placed_is_installed_on_and_runnable() {
        let v = placed("placed", &stand_in("0.1.0", ANSWERS));
        assert!(v.installed() && v.on());
        let mode = fs::metadata(v.helper()).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "the helper kept its right to run");
        assert!(v.status()["bytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn a_take_comes_back_as_the_helpers_own_line_and_the_helper_stays_warm() {
        let v = placed("take", &stand_in("0.1.0", ANSWERS));
        assert_eq!(
            v.status()["warm"],
            false,
            "nothing runs until a key is held"
        );
        let heard = v.hear(48_000, &SOUND).unwrap();
        assert_eq!(heard["heard"], "Opening box");
        assert_eq!(heard["quiet"], false);
        assert_eq!(v.status()["warm"], true);
        // The same process answers the next key.
        assert_eq!(v.hear(48_000, &SOUND).unwrap()["heard"], "Opening box");
        // Just spoken to: the idle check leaves it.
        v.stop_if_idle();
        assert_eq!(v.status()["warm"], true);
        v.stop();
        assert_eq!(v.status()["warm"], false);
    }

    #[test]
    fn off_stops_the_helper_keeps_the_downloads_and_refuses_a_take() {
        let v = placed("off", &stand_in("0.1.0", ANSWERS));
        v.wake().unwrap();
        v.set_on(false).unwrap();
        assert!(v.installed() && !v.on());
        assert_eq!(v.status()["warm"], false);
        assert!(v
            .hear(48_000, &SOUND)
            .unwrap_err()
            .to_string()
            .contains("off"));
        v.set_on(true).unwrap();
        assert!(v.hear(48_000, &SOUND).is_ok());
    }

    #[test]
    fn a_helper_that_speaks_other_frames_is_not_spoken_to() {
        let v = placed("other", &stand_in("0.2.0", ANSWERS));
        let why = v.wake().unwrap_err().to_string();
        assert!(
            why.contains("0.2.0") && why.contains("fetch voice again"),
            "{why}"
        );
        assert!(v.status()["error"].as_str().unwrap().contains("0.2.0"));
        assert_eq!(v.status()["warm"], false);
    }

    #[test]
    fn a_helper_that_cannot_start_says_so_and_is_not_kept() {
        let v = placed("dead", "#!/bin/sh\nexit 1\n");
        let why = format!("{:#}", v.wake().unwrap_err());
        assert!(why.contains("before it was ready"), "{why}");
        assert_eq!(v.status()["warm"], false);
    }

    #[test]
    fn a_helper_that_dies_mid_take_is_dropped_and_the_next_key_starts_another() {
        // Ready, then gone at the first take.
        let v = placed("dies", &stand_in("0.1.0", "head -c 27 >/dev/null"));
        assert!(v.hear(48_000, &SOUND).is_err());
        assert_eq!(v.status()["warm"], false);
        // The next key is a fresh process, which says ready again.
        assert!(v.wake().is_ok());
    }

    #[test]
    fn a_fetch_with_no_model_archive_keeps_the_model_that_is_here() {
        let v = placed("kept", &stand_in("0.1.0", ANSWERS));
        let tmp = v.dir.join("fetching");
        let ears = tarball(
            &tmp,
            "ears2.tar.gz",
            "snyvi-ears-linux-x64",
            &[(HELPER, "#!/bin/sh\n", 0o755)],
        );
        let _ = fs::remove_dir_all(tmp.join("ears"));
        let receipt = Receipt {
            version: "1.70.1".into(),
            ..v.receipt()
        };
        v.place(&ears, None, &receipt).unwrap();
        assert_eq!(
            fs::read_to_string(v.model().join("tokens.txt")).unwrap(),
            "one"
        );
        assert_eq!(fs::read_to_string(v.helper()).unwrap(), "#!/bin/sh\n");
        assert_eq!(v.receipt().version, "1.70.1");
    }

    #[test]
    fn an_archive_without_a_helper_in_it_installs_nothing() {
        let d = scratch("nohelper");
        let v = Voice::new(&d);
        let tmp = d.join("voice/fetching");
        fs::create_dir_all(&tmp).unwrap();
        let ears = tarball(&tmp, "ears.tar.gz", "x", &[("README", "no", 0o644)]);
        let model = model_tar(&tmp, "one");
        assert!(v.place(&ears, Some(&model), &Receipt::default()).is_err());
        assert!(!v.installed());
        assert_eq!(v.receipt(), Receipt::default());
    }

    #[test]
    fn removing_takes_the_downloads_and_the_helper_with_them() {
        let v = placed("remove", &stand_in("0.1.0", ANSWERS));
        v.wake().unwrap();
        v.remove().unwrap();
        assert!(!v.installed() && !v.dir.exists());
        assert_eq!(v.status()["warm"], false);
    }
}

/// A folder of this test's own, empty.
fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("snyvi-voice-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}
