use super::*;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

#[test]
fn the_channel_is_read_off_the_path_and_the_receipt() {
    let d = |s: &str| Channel::detect(&p(s), None, false);
    assert_eq!(d("/home/a/.local/bin/snyvi"), Channel::Tar);
    assert_eq!(d("/opt/snyvi/snyvi"), Channel::Tar);
    assert_eq!(d("/usr/local/bin/snyvi"), Channel::Tar);
    assert_eq!(d("/usr/bin/snyvi"), Channel::Deb);
    assert_eq!(d("/usr/lib/snyvi/snyvi"), Channel::Deb);
    assert_eq!(d("/home/a/.cargo/bin/snyvi"), Channel::Cargo);
    assert_eq!(
        d("/Applications/snyvi.app/Contents/MacOS/snyvi"),
        Channel::Mac
    );
    assert_eq!(
        d("/Users/a/Applications/snyvi.app/Contents/MacOS/snyvi"),
        Channel::Mac
    );
    assert_eq!(
        d(r"C:\Users\a\AppData\Local\Programs\snyvi\snyvi.exe"),
        Channel::Win
    );
    assert_eq!(
        d(r"C:\Users\a\scoop\apps\snyvi\current\snyvi.exe"),
        Channel::Win
    );
    assert_eq!(
        d(r"\\?\C:\Users\a\AppData\Local\Programs\snyvi\snyvi.exe"),
        Channel::Win,
        "canonicalised"
    );
    assert_eq!(
        d("/home/a/Projects/snyvi/target/release/snyvi"),
        Channel::Dev
    );
    assert_eq!(
        Channel::detect(&p("/home/a/.local/bin/snyvi"), None, true),
        Channel::Dev
    );
    // The receipt wins over the path, except for a dev build.
    assert_eq!(
        Channel::detect(&p("/opt/snyvi/snyvi"), Some("deb"), false),
        Channel::Deb
    );
    assert_eq!(
        Channel::detect(&p("/home/a/snyvi/target/debug/snyvi"), Some("tar"), false),
        Channel::Dev
    );
    assert_eq!(
        Channel::detect(&p("/opt/snyvi/snyvi"), Some("nonsense"), false),
        Channel::Tar
    );
    assert!(Channel::Tar.silent() && Channel::Mac.silent() && Channel::Win.silent());
    assert!(!Channel::Deb.silent() && !Channel::Cargo.silent() && !Channel::Dev.silent());
}

#[test]
fn a_told_reader_is_given_lines_that_work_where_they_are() {
    // Both debs in one apt transaction when the window's is installed:
    // snyvi-app depends on `snyvi (= version)`, so dpkg -i of either
    // alone leaves the pair broken.
    let deb = Channel::Deb.how("x64", true);
    assert_eq!(deb.len(), 3);
    assert_eq!(
        deb[2],
        "sudo apt install ./snyvi-linux-x64.deb ./snyvi-app-linux-x64.deb"
    );
    assert_eq!(
        Channel::Deb.how("arm64", false).last().unwrap(),
        "sudo apt install ./snyvi-linux-arm64.deb"
    );

    let linux = Platform {
        os: "linux",
        arch: "x64",
    };
    let l = locked_how(&linux, &p("/usr/local/bin/snyvi"), true);
    assert_eq!(l.len(), 4, "{l:?}");
    assert!(l[1].contains("-C '/usr/local/bin'") && l[1].ends_with("'*/snyvi'"));
    assert!(l[2].ends_with("snyvi-app-linux-x64.tar.gz") && l[3].ends_with("'*/snyvi-app'"));

    // No --wildcards for bsdtar, and the bundle goes in whole.
    let mac = Platform {
        os: "macos",
        arch: "arm64",
    };
    let m = locked_how(
        &mac,
        &p("/Applications/snyvi.app/Contents/MacOS/snyvi"),
        false,
    );
    assert!(m.iter().all(|s| !s.contains("--wildcards")), "{m:?}");
    assert_eq!(
        m[2],
        "sudo rm -rf '/Applications/snyvi.app' && sudo mv snyvi-*/snyvi.app '/Applications/'"
    );

    // There is no Windows tarball; the installer is what there is.
    let win = Platform {
        os: "windows",
        arch: "x64",
    };
    let w = locked_how(&win, &p(r"C:\Program Files\snyvi\snyvi.exe"), true);
    assert!(w[0].starts_with("curl.exe ") && w[0].ends_with("/snyvi-windows-x64-setup.exe"));
    assert!(w.iter().all(|s| !s.contains(".tar.gz")), "{w:?}");
}

const MANIFEST: &str = r#"{
  "version": "1.7.0", "channel": "daily", "notes": "https://x/v1.7.0", "app_min": "1.6.0", "hotfix_below": null,
  "assets": {
    "linux-x64": { "snyvi": ["snyvi-linux-x64.tar.gz", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], "app": ["snyvi-app-linux-x64.tar.gz", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] },
    "macos-arm64": { "bundle": ["snyvi-macos-arm64.tar.gz", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"] },
    "windows-x64": { "zip": ["snyvi-windows-x64.zip", "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"], "setup": ["snyvi-windows-x64-setup.exe", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"] },
    "deb-x64": { "snyvi": ["snyvi-linux-x64.deb", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] }
  }
}"#;

#[test]
fn the_manifest_names_each_channels_downloads() {
    let m = Manifest::parse(MANIFEST.as_bytes()).unwrap();
    let linux = Platform {
        os: "linux",
        arch: "x64",
    };
    let names = |w: Vec<Asset>| w.into_iter().map(|a| a.name).collect::<Vec<_>>();
    assert_eq!(
        names(m.wanted(Channel::Tar, &linux, false).unwrap()),
        ["snyvi-linux-x64.tar.gz"]
    );
    assert_eq!(
        names(m.wanted(Channel::Tar, &linux, true).unwrap()),
        ["snyvi-linux-x64.tar.gz", "snyvi-app-linux-x64.tar.gz"]
    );
    assert_eq!(
        names(
            m.wanted(
                Channel::Mac,
                &Platform {
                    os: "macos",
                    arch: "arm64"
                },
                false
            )
            .unwrap()
        ),
        ["snyvi-macos-arm64.tar.gz"]
    );
    assert_eq!(
        names(
            m.wanted(
                Channel::Win,
                &Platform {
                    os: "windows",
                    arch: "x64"
                },
                true
            )
            .unwrap()
        ),
        ["snyvi-windows-x64.zip"]
    );
    // Told channels take nothing; a platform the release does not build
    // for is an error, not an empty list, so the check says so.
    assert!(m.wanted(Channel::Deb, &linux, false).unwrap().is_empty());
    assert!(m.wanted(Channel::Cargo, &linux, false).unwrap().is_empty());
    assert!(m
        .wanted(
            Channel::Tar,
            &Platform {
                os: "linux",
                arch: "riscv"
            },
            false
        )
        .is_err());
    assert!(m
        .wanted(
            Channel::Mac,
            &Platform {
                os: "macos",
                arch: "x64"
            },
            false
        )
        .is_err());
    assert!(Manifest::parse(br#"{"version": "one"}"#).is_err());
}

#[test]
fn the_doors_open_for_nobody_and_for_a_window_left_behind() {
    let d = |windows, pages, mins: u64, busy| {
        door(&Doors {
            windows,
            pages,
            focus_age: Duration::from_secs(mins * 60),
            busy,
        })
    };
    assert_eq!(d(0, 0, 0, false), Some(Reason::NobodyHere));
    assert_eq!(d(0, 0, 0, true), None, "busy panes hold every door");
    assert_eq!(
        d(1, 1, 0, false),
        None,
        "a window in front is the pill, not a door"
    );
    assert_eq!(d(1, 1, 9, false), None);
    assert_eq!(d(1, 1, 10, false), Some(Reason::InBackground));
    assert_eq!(
        d(0, 1, 0, false),
        None,
        "a browser tab in front counts as someone here"
    );
    assert_eq!(d(0, 1, 30, false), Some(Reason::InBackground));
    assert_eq!(d(1, 1, 30, true), None);
}

#[test]
fn a_hotfix_above_what_runs_opens_the_floor() {
    let v = semver::Version::parse("1.6.2").unwrap();
    assert!(hotfix_wanted(Some("1.6.3"), &v));
    assert!(!hotfix_wanted(Some("1.6.2"), &v));
    assert!(!hotfix_wanted(Some("1.6.0"), &v));
    assert!(!hotfix_wanted(None, &v));
    assert!(!hotfix_wanted(Some("soon"), &v));
}

// ----- the stager and the swap, against a fake network -----

/// A `Fetch` over a map of URLs, counting what was asked for. A download
/// may be cut short, to see that nothing is marked ready from it.
struct Fake {
    files: StdMutex<BTreeMap<String, Vec<u8>>>,
    truncate: StdMutex<Option<String>>,
    asked: StdMutex<Vec<String>>,
}

impl Fake {
    fn new() -> Fake {
        Fake {
            files: Default::default(),
            truncate: Default::default(),
            asked: Default::default(),
        }
    }
    fn put(&self, name: &str, bytes: Vec<u8>) {
        self.files.lock().unwrap().insert(name.to_string(), bytes);
    }
}

impl Fetch for Fake {
    fn get(&self, url: &str, etag: Option<&str>) -> Result<Got> {
        self.asked.lock().unwrap().push(url.to_string());
        let name = url.rsplit('/').next().unwrap();
        match self.files.lock().unwrap().get(name) {
            Some(b) if etag == Some(format!("\"{}\"", b.len()).as_str()) => Ok(Got::NotModified),
            Some(b) => Ok(Got::Body {
                bytes: b.clone(),
                etag: Some(format!("\"{}\"", b.len())),
            }),
            None => bail!("GET {url}: HTTP 404"),
        }
    }
    fn download(&self, url: &str, to: &Path) -> Result<u64> {
        self.asked.lock().unwrap().push(url.to_string());
        let name = url.rsplit('/').next().unwrap();
        let files = self.files.lock().unwrap();
        let Some(b) = files.get(name) else {
            bail!("GET {url}: HTTP 404")
        };
        let cut = self.truncate.lock().unwrap().as_deref() == Some(name);
        let bytes = if cut { &b[..b.len() / 2] } else { &b[..] };
        fs::write(to, bytes)?;
        Ok(bytes.len() as u64)
    }
}

/// The test key pair's public half, and a manifest it signed; see
/// `tests/fixtures/update/README`. The release key is not used here.
const TEST_PUB: &str = include_str!("../../tests/fixtures/update/test.pub");
const SIGNED: &[u8] = include_bytes!("../../tests/fixtures/update/latest.json");
const SIGNATURE: &[u8] = include_bytes!("../../tests/fixtures/update/latest.json.minisig");
/// What that manifest's `linux-x64` daemon download is: a tarball whose
/// `snyvi` is a line of text.
const TARBALL: &[u8] = include_bytes!("../../tests/fixtures/update/snyvi-linux-x64.tar.gz");

#[test]
fn a_manifest_is_taken_from_the_key_and_from_nobody_else() {
    let key = minisign_verify::PublicKey::decode(TEST_PUB).unwrap();
    verify(&key, SIGNED, SIGNATURE).unwrap();
    let mut tampered = SIGNED.to_vec();
    let at = tampered
        .windows(5)
        .position(|w| w == b"1.9.9")
        .expect("the fixture names 1.9.9");
    tampered[at + 4] = b'8';
    assert!(
        verify(&key, &tampered, SIGNATURE).is_err(),
        "a changed byte fails"
    );
    let release = release_key().expect("the release key reads, on every platform");
    assert!(
        verify(&release, SIGNED, SIGNATURE).is_err(),
        "the release key does not vouch for the test key's manifest"
    );
    assert!(verify(&key, SIGNED, b"untrusted comment: nothing\n").is_err());
}

fn sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// A gzipped tarball holding `<top>/<name>` with the given bytes.
fn tarball(top: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let gz = flate2::write::GzEncoder::new(&mut out, flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        let mut h = tar::Header::new_gnu();
        h.set_size(bytes.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        tar.append_data(&mut h, format!("{top}/{name}"), bytes)
            .unwrap();
        tar.into_inner().unwrap().finish().unwrap();
    }
    out
}

/// A zip holding `<top>/<name>` stored, and `<top>/<other>` deflated.
fn zip(top: &str, entries: &[(&str, &[u8], bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut cd = Vec::new();
    let crc = |b: &[u8]| {
        // CRC-32, the plain table-less way: it is a test.
        let mut c = 0xffff_ffffu32;
        for &x in b {
            c ^= x as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    (c >> 1) ^ 0xedb8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    };
    for &(name, bytes, deflate) in entries {
        let name = format!("{top}/{name}");
        let data = if deflate {
            let mut e =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(bytes).unwrap();
            e.finish().unwrap()
        } else {
            bytes.to_vec()
        };
        let off = out.len() as u32;
        let method: u16 = if deflate { 8 } else { 0 };
        let mut lh = Vec::new();
        lh.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
        lh.extend_from_slice(&method.to_le_bytes());
        lh.extend_from_slice(&[0; 4]);
        lh.extend_from_slice(&crc(bytes).to_le_bytes());
        lh.extend_from_slice(&(data.len() as u32).to_le_bytes());
        lh.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        lh.extend_from_slice(&(name.len() as u16).to_le_bytes());
        lh.extend_from_slice(&[0, 0]);
        lh.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&lh);
        out.extend_from_slice(&data);
        cd.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0]);
        cd.extend_from_slice(&method.to_le_bytes());
        cd.extend_from_slice(&[0; 4]);
        cd.extend_from_slice(&crc(bytes).to_le_bytes());
        cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0; 12]);
        cd.extend_from_slice(&off.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
    }
    let cd_off = out.len() as u32;
    out.extend_from_slice(&cd);
    out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}

/// A signed manifest is fixed by the fixture, so the stager is tested
/// below the signature: `stage` and `apply` take the parsed manifest.
fn paths(dir: &Path) -> crate::config::Paths {
    crate::config::Paths {
        data_dir: dir.join("data"),
        config_dir: dir.join("config"),
        docs_dir: dir.join("data/docs"),
        db_path: dir.join("data/snyvi.db"),
        token_path: dir.join("config/token"),
    }
}

impl Fetch for Arc<Fake> {
    fn get(&self, url: &str, etag: Option<&str>) -> Result<Got> {
        self.as_ref().get(url, etag)
    }
    fn download(&self, url: &str, to: &Path) -> Result<u64> {
        self.as_ref().download(url, to)
    }
}

fn updater(dir: &Path, exe: &Path, fetch: impl Fetch + 'static) -> Updater {
    let mut u = Updater::new(&paths(dir), exe, Box::new(fetch));
    u.source = Source::Flat("http://fake/".into());
    u.channel = Channel::Tar;
    u.platform = Platform {
        os: "linux",
        arch: "x64",
    };
    u
}

fn manifest_for(version: &str, tar_sha: &str) -> Manifest {
    Manifest::parse(
        format!(
            r#"{{ "version": "{version}", "app_min": "1.0.0", "assets": {{ "linux-x64": {{ "snyvi": ["snyvi-linux-x64.tar.gz", "{tar_sha}"] }} }} }}"#
        )
        .as_bytes(),
    )
    .unwrap()
}

/// "Later" puts off the version on offer until the time given, in every
/// window, and no longer than two days; a newer version is offered at
/// once, and a failure to start is never put off.
#[test]
fn later_puts_off_this_version_and_not_the_next() {
    let tmp = tempdir();
    let exe = tmp.join("snyvi");
    fs::write(&exe, b"x").unwrap();
    let u = updater(&tmp, &exe, Fake::new());
    u.edit(|s| {
        s.ready = Some("9.9.9".into());
        s.asked = true;
    });
    let now = 1_000_000;
    assert_eq!(u.json(now, false)["show"], true);
    u.snooze(Some(now + 3600), now).unwrap();
    let j = u.json(now, false);
    assert_eq!(
        (j["show"].clone(), j["snoozed_until"].clone()),
        (serde_json::json!(false), serde_json::json!(now + 3600))
    );
    assert_eq!(u.json(now + 3601, false)["show"], true, "only until then");
    u.edit(|s| s.ready = Some("9.9.10".into()));
    assert_eq!(u.json(now, false)["show"], true, "a newer version is news");
    u.snooze(Some(now + 10 * 86400), now).unwrap();
    assert_eq!(u.state().snoozed_until, Some(now + SNOOZE_MAX));
    u.snooze(None, now).unwrap();
    assert_eq!(u.json(now, false)["show"], true);
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn a_prev_set_aside_is_found_and_nothing_else() {
    let tmp = tempdir();
    let prev = prev_of(&tmp.join("snyvi-app.exe"));
    for n in [
        "snyvi-app.exe.prev",
        "snyvi-app.exe.prev.123.old",
        "snyvi-app.exe.prevx.old",
        "snyvi.exe.prev.1.old",
    ] {
        fs::write(tmp.join(n), b"x").unwrap();
    }
    assert_eq!(
        set_aside(&prev),
        vec![tmp.join("snyvi-app.exe.prev.123.old")]
    );
    clear_prev(&prev);
    assert!(!prev.exists(), "a .prev nothing holds is simply removed");
    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn a_tarball_is_staged_verified_swapped_in_and_rolled_back() {
    let tmp = tempdir();
    let bin = tmp.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("snyvi");
    fs::write(&exe, b"old daemon").unwrap();
    let new = b"new daemon".to_vec();
    let tgz = tarball("snyvi-9.9.9-x86_64-unknown-linux-musl", "snyvi", &new);
    let fake = Fake::new();
    fake.put("snyvi-linux-x64.tar.gz", tgz.clone());
    let u = updater(&tmp, &exe, fake);
    let m = manifest_for("9.9.9", &sha(&tgz));

    u.stage(&m).unwrap();
    u.edit(|s| s.ready = Some("9.9.9".into()));
    let staged = u.staged().expect("staged.json is written");
    assert_eq!(staged.files.len(), 1);
    assert_eq!(
        staged.files[0].sha256,
        sha(&new),
        "the unpacked binary is hashed, not the tarball"
    );
    assert!(staged.files[0]
        .path
        .starts_with(tmp.join("data/updates/9.9.9")));

    assert_eq!(u.apply().unwrap(), "9.9.9");
    assert_eq!(fs::read(&exe).unwrap(), new, "the new file is at the path");
    assert_eq!(
        fs::read(bin.join("snyvi.prev")).unwrap(),
        b"old daemon",
        "the old one is beside it"
    );
    let s = u.state();
    assert_eq!(s.applying.as_deref(), Some("9.9.9"));
    assert_eq!(s.applying_sha.as_deref(), Some(sha(&new).as_str()));
    assert!(u.can_go_back());

    // The daemon that comes up on the new file: the swap held.
    assert_eq!(
        u.note_started(true, 1_000_000),
        Some(Started::Applied("9.9.9".into()))
    );
    let s = u.state();
    assert_eq!(s.last_applied, Some(1_000_000));
    assert!(
        s.slot.unwrap() >= 1_000_000 + SLOT && s.slot.unwrap() <= 1_000_000 + SLOT + SLOT_JITTER
    );
    assert!(s.ready.is_none() && s.applying.is_none() && !s.asked);
    assert!(
        !tmp.join("data/updates/9.9.9").exists(),
        "the staged copy is gone"
    );
    assert!(u.floor_holds(1_000_000 + 3600), "the next day's slot holds");
    assert!(!u.floor_holds(1_000_000 + SLOT + SLOT_JITTER + 1));

    // Back, asked for: the old file returns, and the version that was
    // applied is remembered so it is not staged again on its own --
    // skipped, not failed, since nothing went wrong with it.
    assert!(u.rollback(true).unwrap());
    assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
    assert!(!bin.join("snyvi.prev").exists());
    let s = u.state();
    assert_eq!(s.skipped.as_deref(), Some("9.9.9"));
    assert!(s.failed.is_none());
    assert_eq!(s.slot, None, "the slot from before the apply is back");
    assert_eq!(s.last_applied, None);
    assert!(!u.rollback(true).unwrap(), "nothing to go back to twice");
}

#[test]
fn the_version_at_the_path_is_the_one_placed_while_the_file_is_that_file() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"placed").unwrap();
    let u = updater(&tmp, &exe, Fake::new());
    let compiled = u.running.clone();
    let higher = format!(
        "{}.{}.{}",
        compiled.major,
        compiled.minor,
        compiled.patch + 5
    );
    u.edit(|s| {
        s.applied = Some(higher.clone());
        s.applied_sha = Some(sha(b"placed"));
    });
    assert_eq!(
        u.current().to_string(),
        higher,
        "the file placed is still there"
    );
    fs::write(&exe, b"something else").unwrap();
    u.forget_current();
    assert_eq!(
        u.current(),
        compiled,
        "a file the updater did not place is only what it says it is"
    );
    // A hotfix is measured against the version at the path.
    u.edit(|s| {
        s.slot = Some(i64::MAX);
        s.hotfix_below = Some(higher.clone());
    });
    assert!(!u.floor_holds(0), "below the hotfix: the floor opens");
}

#[test]
fn a_cut_download_stages_nothing_and_leaves_no_file() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"old daemon").unwrap();
    let tgz = tarball("top", "snyvi", b"new daemon");
    let fake = Fake::new();
    fake.put("snyvi-linux-x64.tar.gz", tgz.clone());
    *fake.truncate.lock().unwrap() = Some("snyvi-linux-x64.tar.gz".into());
    let u = updater(&tmp, &exe, fake);
    let err = u.stage(&manifest_for("9.9.9", &sha(&tgz))).unwrap_err();
    assert!(err.to_string().contains("does not match"), "{err}");
    assert!(
        !tmp.join("data/updates/9.9.9/snyvi-linux-x64.tar.gz")
            .exists(),
        "the partial file is removed"
    );
    assert!(u.staged().is_none());
    assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
}

#[test]
fn a_swap_whose_file_is_not_the_one_verified_leaves_the_old_one() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"old daemon").unwrap();
    let staged = tmp.join("staged");
    fs::write(&staged, b"something else").unwrap();
    let err = swap_file(&staged, &exe, &sha(b"new daemon")).unwrap_err();
    assert!(
        err.to_string().contains("not the file that was verified"),
        "{err}"
    );
    assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
    assert!(!tmp.join("bin/snyvi.prev").exists() && !tmp.join("bin/snyvi.new").exists());
}

#[test]
fn a_crash_restart_does_not_count_as_an_apply() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"new daemon").unwrap();
    let u = updater(&tmp, &exe, Fake::new());
    assert_eq!(u.note_started(false, 5), None, "nothing was being applied");
    u.edit(|s| {
        s.applying = Some("9.9.9".into());
        s.applying_sha = Some(sha(b"new daemon"));
    });
    // The file is right, but the exit was not planned: whatever put it
    // there, this daemon cannot say an update landed, and it says failed
    // rather than opening a slot it did not earn.
    assert_eq!(
        u.note_started(false, 5),
        Some(Started::Failed("9.9.9".into()))
    );
    assert_eq!(u.state().last_applied, None);
    assert_eq!(u.state().failed.as_deref(), Some("9.9.9"));
}

#[test]
fn the_version_applied_running_without_a_marker_has_started() {
    // The window brought the daemon up, so no marker: 1.65.0 called
    // itself failed while it ran ("did not start · kept 1.65.0").
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"new daemon").unwrap();
    let u = updater(&tmp, &exe, Fake::new());
    let v = u.running.to_string();
    u.edit(|s| s.applying = Some(v.clone()));
    assert_eq!(u.note_started(false, 5), Some(Started::Applied(v.clone())));
    assert_eq!(u.state().failed, None);
    assert_eq!(u.state().last_applied, Some(5));
}

#[test]
fn a_failure_naming_what_runs_or_dismissed_is_not_shown() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    let u = updater(&tmp, &exe, Fake::new());
    let v = u.running.to_string();
    // A state written by the old note_started: the running version, failed.
    u.edit(|s| {
        s.failed = Some(v.clone());
        s.failed_at = Some(100);
    });
    assert_eq!(u.json(200, false)["failed_recent"], false);
    assert_eq!(u.json(200, false)["show"], false);
    // A real failure is news, until the reader dismisses it.
    u.edit(|s| s.failed = Some("9.9.9".into()));
    assert_eq!(u.json(200, false)["failed_recent"], true);
    u.dismiss_failed();
    assert_eq!(u.json(200, false)["failed_recent"], false);
    assert_eq!(u.json(200, false)["failed"], "9.9.9", "About still says it");
    // Another failure after it is news again.
    u.edit(|s| s.failed = Some("9.9.10".into()));
    assert_eq!(u.json(200, false)["failed_recent"], true);
}

#[test]
fn a_zip_is_read_through_its_directory() {
    let tmp = tempdir();
    let z = zip(
        "snyvi-1.0.0-x86_64-pc-windows-msvc",
        &[
            ("snyvi.exe", &b"daemon bytes"[..], false),
            (
                "snyvi-app.exe",
                &b"window bytes, deflated, longer than the rest"[..],
                true,
            ),
            ("README.md", &b"# hi"[..], true),
        ],
    );
    let path = tmp.join("a.zip");
    fs::write(&path, &z).unwrap();
    let into = tmp.join("out");
    unzip(&path, &into).unwrap();
    assert_eq!(
        fs::read(into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi.exe")).unwrap(),
        b"daemon bytes"
    );
    assert_eq!(
        fs::read(into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi-app.exe")).unwrap(),
        b"window bytes, deflated, longer than the rest"
    );
    assert_eq!(
        find(&into, "snyvi.exe", false).unwrap(),
        into.join("snyvi-1.0.0-x86_64-pc-windows-msvc/snyvi.exe")
    );
    let bad = zip("..", &[("snyvi.exe", &b"x"[..], false)]);
    fs::write(&path, &bad).unwrap();
    assert!(
        unzip(&path, &into).is_err(),
        "a path that climbs out is refused"
    );
}

#[test]
fn the_check_stages_a_newer_version_and_drops_a_staged_one_that_is_not_newer() {
    // The fixture manifest says 1.9.9 and names linux-x64 assets whose
    // hashes are of the bytes below, so a whole check runs against the
    // fake: signature, parse, compare, stage.
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"old daemon").unwrap();
    let fake = Fake::new();
    fake.put("latest.json", SIGNED.to_vec());
    fake.put("latest.json.minisig", SIGNATURE.to_vec());
    fake.put("snyvi-linux-x64.tar.gz", TARBALL.to_vec());
    let mut u = updater(&tmp, &exe, fake);
    u.key = Some(minisign_verify::PublicKey::decode(TEST_PUB).unwrap());
    // On 1.0.0 whatever this build's own version is, so a bump past the
    // fixture's 1.9.9 does not turn the check into "nothing newer".
    u.running = semver::Version::parse("1.0.0").unwrap();
    u.forget_current();
    let c = u.check(Ask::TIMER, None).unwrap();
    assert!(c.newer());
    assert_eq!(c.ready.as_deref(), Some("1.9.9"));
    let s = u.state();
    assert_eq!(s.available.as_deref(), Some("1.9.9"));
    assert_eq!(s.ready.as_deref(), Some("1.9.9"));
    assert!(s.since.is_some() && !s.asked && s.error.is_none());
    assert_eq!(s.latest_app_min.as_deref(), Some("1.6.0"));
    // Asked, with nothing newer: what was staged goes, and the floor
    // stays -- lifting it for a release not out yet let that release
    // past the day's slot whenever it came.
    u.running = semver::Version::parse("1.9.9").unwrap();
    u.forget_current();
    let c = u.check(Ask::PERSON, None).unwrap();
    assert!(!c.newer() && c.ready.is_none());
    let s = u.state();
    assert!(!s.asked && s.ready.is_none() && s.available.is_none());
    assert!(!tmp.join("data/updates/1.9.9").exists());
    // A dev build never checks.
    u.channel = Channel::Dev;
    assert!(u.check(Ask::PERSON, None).is_err());
}

/// A daemon on 1.0.0 whose manifest names 1.9.9, signed by the test
/// key, and the fake it reads, to change under it.
fn checker(tmp: &Path) -> (Updater, Arc<Fake>) {
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"old daemon").unwrap();
    let fake = Arc::new(Fake::new());
    fake.put("latest.json", SIGNED.to_vec());
    fake.put("latest.json.minisig", SIGNATURE.to_vec());
    let mut u = updater(tmp, &exe, fake.clone());
    u.key = Some(minisign_verify::PublicKey::decode(TEST_PUB).unwrap());
    u.running = semver::Version::parse("1.0.0").unwrap();
    u.forget_current();
    (u, fake)
}

#[test]
fn a_stage_that_failed_is_tried_again_by_the_next_timer_check() {
    let tmp = tempdir();
    let (u, fake) = checker(&tmp);
    // The download is not there yet: the check fails, and keeps no ETag
    // for a manifest it has not finished with.
    assert!(u.check(Ask::TIMER, None).is_err());
    let s = u.state();
    assert_eq!(s.available.as_deref(), Some("1.9.9"));
    assert!(s.ready.is_none() && s.etag.is_none() && s.error.is_some());
    // The next timer check reads the manifest whole and stages.
    fake.put("snyvi-linux-x64.tar.gz", TARBALL.to_vec());
    let c = u.check(Ask::TIMER, None).unwrap();
    assert_eq!(c.ready.as_deref(), Some("1.9.9"));
    let s = u.state();
    assert!(s.etag.is_some() && s.error.is_none());
    // An apply that failed dropped what was staged; the ETag would say
    // 304 until the next release, so it is not sent.
    u.drop_staged();
    let c = u.check(Ask::TIMER, None).unwrap();
    assert_eq!(c.ready.as_deref(), Some("1.9.9"));
    // Staged: the ETag is sent, the answer is 304, and an error from
    // elsewhere is left for About to show.
    u.fail("could not apply: no room".into());
    fake.asked.lock().unwrap().clear();
    let c = u.check(Ask::TIMER, None).unwrap();
    assert_eq!(c.ready.as_deref(), Some("1.9.9"));
    assert_eq!(
        *fake.asked.lock().unwrap(),
        vec!["http://fake/latest.json".to_string()],
        "a 304, and nothing else fetched"
    );
    assert_eq!(u.state().error.as_deref(), Some("could not apply: no room"));
}

#[test]
fn only_a_person_who_found_something_newer_lifts_the_floor() {
    let tmp = tempdir();
    let (u, fake) = checker(&tmp);
    fake.put("snyvi-linux-x64.tar.gz", TARBALL.to_vec());
    u.check(Ask::TIMER, None).unwrap();
    assert!(!u.state().asked, "the timer never lifts it");
    u.check(
        Ask {
            fresh: true,
            lift: false,
        },
        None,
    )
    .unwrap();
    assert!(!u.state().asked, "nor does `snyvi update check`");
    u.check(Ask::PERSON, None).unwrap();
    assert!(u.state().asked, "Check now, with 1.9.9 out, does");
}

#[test]
fn going_below_skips_the_version_gone_below() {
    let tmp = tempdir();
    let (mut u, fake) = checker(&tmp);
    fake.put("snyvi-linux-x64.tar.gz", TARBALL.to_vec());
    u.running = semver::Version::parse("2.0.0").unwrap();
    u.forget_current();
    let c = u.check(Ask::PERSON, Some("1.9.9")).unwrap();
    assert_eq!(c.ready.as_deref(), Some("1.9.9"));
    let s = u.state();
    assert_eq!(s.skipped.as_deref(), Some("2.0.0"));
    assert!(s.etag.is_none(), "another release's manifest, not latest's");
}

#[test]
fn an_apply_that_cannot_place_every_file_places_none() {
    let tmp = tempdir();
    let bin = tmp.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("snyvi");
    fs::write(&exe, b"old daemon").unwrap();
    // Named as the updater looks for it beside the daemon: .exe on Windows.
    let app = bin.join(crate::platform::exe("snyvi-app"));
    fs::write(&app, b"old window").unwrap();
    let u = updater(&tmp, &exe, Fake::new());
    let vdir = tmp.join("data/updates/9.9.9");
    fs::create_dir_all(&vdir).unwrap();
    fs::write(vdir.join("snyvi"), b"new daemon").unwrap();
    fs::write(vdir.join("snyvi-app"), b"new window").unwrap();
    let staged = Staged {
        version: "9.9.9".into(),
        app_min: None,
        files: vec![
            StagedFile {
                role: "snyvi".into(),
                path: vdir.join("snyvi"),
                sha256: sha(b"new daemon"),
            },
            // Not what is on disk: the second swap refuses it.
            StagedFile {
                role: "app".into(),
                path: vdir.join("snyvi-app"),
                sha256: sha(b"another window"),
            },
        ],
    };
    fs::write(
        vdir.join("staged.json"),
        serde_json::to_string(&staged).unwrap(),
    )
    .unwrap();
    u.edit(|s| s.ready = Some("9.9.9".into()));
    assert!(u.apply().is_err());
    assert_eq!(
        fs::read(&exe).unwrap(),
        b"old daemon",
        "the daemon went back"
    );
    assert_eq!(fs::read(&app).unwrap(), b"old window");
    assert!(!bin.join("snyvi.prev").exists() && !prev_of(&app).exists());
    assert!(u.state().applying.is_none());
}

#[test]
fn a_successor_that_never_binds_is_taken_back_out_on_its_third_start() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"new daemon").unwrap();
    fs::write(tmp.join("bin/snyvi.prev"), b"old daemon").unwrap();
    let p = paths(&tmp);
    let dir = p.data_dir.join("updates");
    let u = updater(&tmp, &exe, Fake::new());
    u.edit(|s| {
        s.applying = Some("9.9.9".into());
        s.applying_sha = Some(sha(b"new daemon"));
        s.slot = Some(7);
        s.prev_slot = Some(3);
    });
    assert_eq!(first_start(&p, &exe), FirstStart::Go);
    assert_eq!(first_start(&p, &exe), FirstStart::Go);
    assert_eq!(read_state(&dir).boot_tries, 2);
    assert_eq!(
        first_start(&p, &exe),
        FirstStart::RolledBack("9.9.9".into())
    );
    assert_eq!(fs::read(&exe).unwrap(), b"old daemon");
    let s = read_state(&dir);
    assert_eq!(s.failed.as_deref(), Some("9.9.9"));
    assert!(s.applying.is_none() && s.boot_tries == 0);
    assert_eq!(s.slot, Some(3), "the slot from before the apply is back");
    // Nothing being applied: a start is only a start.
    assert_eq!(first_start(&p, &exe), FirstStart::Go);
    assert_eq!(read_state(&dir).boot_tries, 0);
}

#[test]
fn a_successor_that_binds_stops_being_counted() {
    let tmp = tempdir();
    let exe = tmp.join("bin/snyvi");
    fs::create_dir_all(exe.parent().unwrap()).unwrap();
    fs::write(&exe, b"new daemon").unwrap();
    let p = paths(&tmp);
    updater(&tmp, &exe, Fake::new()).edit(|s| {
        s.applying = Some("9.9.9".into());
        s.applying_sha = Some(sha(b"new daemon"));
    });
    assert_eq!(first_start(&p, &exe), FirstStart::Go);
    // Bound: the daemon reads the state the guard wrote.
    let u = updater(&tmp, &exe, Fake::new());
    assert_eq!(
        u.note_started(true, 1_000),
        Some(Started::Applied("9.9.9".into()))
    );
    assert_eq!(read_state(&p.data_dir.join("updates")).boot_tries, 0);
}

fn tempdir() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "snyvi-update-{}-{}",
        std::process::id(),
        jitter(1 << 30)
    ));
    fs::create_dir_all(&d).unwrap();
    d
}
