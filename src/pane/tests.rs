use super::*;

#[test]
fn a_context_count_moves_when_its_figure_would() {
    let f = |n: u64| ctx_figure(Some(n));
    assert_eq!(f(412_000), f(412_999), "412k either way");
    assert_ne!(f(412_999), f(413_000));
    assert_eq!(f(1_200_000), f(1_299_999), "1.2M either way");
    assert_ne!(f(1_299_999), f(1_300_000));
    assert_ne!(f(999_999), f(1_000_000), "999k is not 1.0M");
    assert_ne!(f(10_000), f(1_000_000), "10k is not 1.0M");
    assert_eq!(ctx_figure(None), None);
}

/// A folder is asked about its tree once, and then only when a pane in
/// it printed, a page began watching, or a watched folder has been quiet
/// a minute -- never sooner than the floor however much is printed.
#[test]
fn a_folder_is_asked_about_its_tree_only_when_something_could_have_changed_it() {
    let t0 = Instant::now();
    assert!(status_due(t0, None, None, 1), "never asked: asked");
    let asked = Asked {
        at: t0,
        cost: Duration::from_millis(20),
        watchers: 1,
    };
    let later = t0 + GIT_FLOOR * 2;
    assert!(
        !status_due(later, Some(asked), Some(t0 - Duration::from_secs(1)), 1),
        "a prompt that printed nothing since is not asked, however long ago"
    );
    assert!(
        !status_due(later, Some(asked), None, 1),
        "nor one that never printed"
    );
    assert!(
        status_due(later, Some(asked), Some(t0 + Duration::from_secs(1)), 1),
        "a pane printed since: asked"
    );
    assert!(
        !status_due(
            t0 + GIT_FLOOR / 2,
            Some(asked),
            Some(t0 + Duration::from_secs(1)),
            1
        ),
        "but not before the floor"
    );
    assert!(
        status_due(later, Some(asked), None, 2),
        "a page began watching: asked, printed or not"
    );
    assert!(
        !status_due(later, Some(asked), None, 0),
        "one stopped watching: nothing new to say"
    );
    assert!(
        status_due(t0 + GIT_QUIET, Some(asked), None, 1),
        "a watched folder is asked after a quiet minute: a commit from outside shows"
    );
    assert!(
        !status_due(t0 + GIT_QUIET * 5, Some(asked), None, 0),
        "an unwatched one is not"
    );
    let slow = Asked {
        cost: Duration::from_secs(3),
        ..asked
    };
    assert!(
        !status_due(
            t0 + Duration::from_secs(29),
            Some(slow),
            Some(t0 + Duration::from_secs(1)),
            1
        ),
        "a slow repository backs off past the floor"
    );
    assert!(status_due(
        t0 + Duration::from_secs(31),
        Some(slow),
        Some(t0 + Duration::from_secs(1)),
        1
    ));
    let glacial = Asked {
        cost: Duration::from_secs(30),
        ..asked
    };
    assert!(
        status_due(
            t0 + GIT_AT_MOST + Duration::from_secs(1),
            Some(glacial),
            Some(t0 + Duration::from_secs(1)),
            1
        ),
        "and never further than the most"
    );
}

#[test]
fn kept_text_is_cut_from_the_front_to_the_cap() {
    let old: Vec<String> = (0..10).map(|i| format!("old {i}")).collect();
    let big = "z".repeat(1024);
    let now: Vec<String> = (0..3000).map(|_| big.clone()).collect();
    let kept = keep_text(&old, now);
    let bytes: usize = kept.iter().map(|l| l.len() + 1).sum();
    assert!(bytes <= screen::SCROLLBACK_BYTES);
    assert_eq!(kept.last().unwrap(), &big, "the newest line is kept");
    assert!(
        !kept.iter().any(|l| l.starts_with("old")),
        "the oldest go first"
    );
    // Under the cap, nothing is lost and the order holds.
    let kept = keep_text(&old, vec!["new".into()]);
    assert_eq!(kept.len(), 11);
    assert_eq!(kept[0], "old 0");
    assert_eq!(kept[10], "new");
}

/// The quiet predicate, over what a restart and an update look at: an
/// agent waiting on its reader, one mid-turn, or a program still
/// printing is busy; a stopped pane, one that finished a turn, and one
/// at its prompt for a while are not -- and neither is an agent silent
/// past `WORKING_SILENT`, nor a program that has printed without a
/// break for `PRINTING_AT_MOST`.
#[test]
fn a_restart_waits_for_agents_and_recent_output_but_not_forever() {
    let s = |running: bool, agent: &'static str| Status {
        running,
        agent,
        ..Status::default()
    };
    let long_ago = BUSY_OUTPUT + Duration::from_secs(1);
    let just_now = Duration::from_secs(1);
    let a_while = Duration::from_secs(60);
    let silent = WORKING_SILENT + Duration::from_secs(1);
    let for_ever = PRINTING_AT_MOST + Duration::from_secs(1);
    assert!(is_busy(&s(true, "working"), long_ago, a_while));
    assert!(is_busy(&s(true, ""), just_now, a_while));
    assert!(is_busy(&s(true, "done"), just_now, a_while));
    assert!(!is_busy(&s(true, ""), long_ago, a_while));
    assert!(!is_busy(&s(true, "done"), long_ago, a_while));
    // An approval waiting is never cut off, however long it waits.
    assert!(is_busy(&s(true, "needs_you"), long_ago, a_while));
    assert!(is_busy(&s(true, "needs_you"), silent, for_ever));
    // A turn stopped with Esc says `working` and nothing more.
    assert!(!is_busy(&s(true, "working"), silent, a_while));
    // A log tail is busy for two hours, and then it is not.
    assert!(is_busy(&s(true, ""), just_now, PRINTING_AT_MOST - a_while));
    assert!(!is_busy(&s(true, ""), just_now, for_ever));
    assert!(!is_busy(&s(true, "done"), just_now, for_ever));
    assert!(!is_busy(&s(false, "working"), just_now, a_while));
    assert!(!is_busy(&s(false, "needs_you"), just_now, a_while));
    assert!(!is_busy(&s(false, ""), just_now, a_while));
}

/// The marks wait for someone to look: ten minutes with nobody here
/// spends nothing. The first look starts `RESUME_FOR`; past it, an
/// unspent resume is an offer; past the cap, nothing is either.
#[test]
fn a_mark_waits_for_a_look_then_lapses_into_an_offer() {
    let t0 = Instant::now();
    let m = |until: Option<Instant>| Marks {
        resume: ["r".to_string()].into(),
        offer: ["o".to_string()].into(),
        resume_until: until,
        cap: t0 + MARKS_AT_MOST,
    };
    let later = t0 + Duration::from_secs(10 * 60);
    // Nobody has looked: a resume holds, however long.
    assert!(m(None).resume("r", later));
    assert!(!m(None).offer("r", later));
    assert!(m(None).offer("o", later));
    // Looked at ten minutes: it holds five more, then is an offer.
    let armed = m(Some(later + RESUME_FOR));
    assert!(armed.resume("r", later + Duration::from_secs(60)));
    assert!(!armed.resume("r", later + RESUME_FOR));
    assert!(armed.offer("r", later + RESUME_FOR));
    assert!(!armed.resume("o", later), "an offer is never a resume");
    // A day on, nothing is anything.
    let day = t0 + MARKS_AT_MOST;
    assert!(!m(None).resume("r", day));
    assert!(!armed.offer("r", day));
    assert!(!armed.offer("o", day));
}

/// A mark is carried on the pane's status until its first start, whether
/// the pane was woken before or after the marks were read, and past its
/// time it is an offer.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resume_mark_rides_the_status_until_the_pane_starts_or_it_lapses() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-mark");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let early = "0000000000000000000000000000000a";
    let late = "0000000000000000000000000000000b";
    let never = "0000000000000000000000000000000c";
    let woken = panes.get(early);
    assert!(!woken.attach().0[0].contains("\"resume\":true"));
    panes.mark_resume(vec![early.into(), late.into()]);
    // Woken before the marks: told. Woken after: told. Not woken: the
    // desks' list still says so. Unmarked: nothing.
    assert!(panes.status(early).resume);
    assert!(panes.get(late).attach().0[0].contains("\"resume\":true"));
    assert!(panes.status(late).resume);
    assert!(!panes.status(never).resume);
    assert!(panes.busy().is_empty(), "a stopped pane is never busy");
    // A start of any kind spends the mark; the status it sends says so.
    #[cfg(unix)]
    {
        let cwd = dir.path.to_string_lossy().to_string();
        let s = Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "sleep 30",
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        };
        let status = panes.get(late).start(s, &panes).unwrap();
        assert!(!status.resume);
        assert!(!panes.status(late).resume);
        // And a pane that just started is busy until it has been quiet
        // for a while -- the start itself counts as output.
        assert_eq!(panes.busy(), vec![late.to_string()]);
        panes.get(late).stop();
    }
    assert!(panes.status(early).resume, "the other mark is untouched");
    // What an exit writes back: the mark nobody has spent.
    assert!(panes.unspent().0.contains(&early.to_string()));
    #[cfg(unix)]
    assert!(
        !panes.unspent().0.contains(&late.to_string()),
        "spent by its start"
    );
    // Past its time, a mark is an offer: the woken pane says so too.
    panes.arm_marks();
    panes.marks.lock().unwrap().resume_until = Some(Instant::now());
    panes.refresh_marks();
    assert!(!panes.status(early).resume);
    assert!(panes.status(early).offer);
    assert!(!panes.marked(early), "the page's own resume is refused now");
    assert!(panes.unspent().0.is_empty());
    assert!(
        panes.unspent().1.contains(&early.to_string()),
        "and written back as an offer"
    );
    assert!(!panes.get(never).attach().0[0].contains("\"resume\":true"));
}

#[test]
fn only_a_pane_id_is_a_file_name() {
    assert!(valid_id("0123456789abcdef0123456789abcdef"));
    assert!(!valid_id("../../etc/passwd"));
    assert!(!valid_id("0123456789abcdef0123456789abcde/"));
    assert!(!valid_id(""));
}

/// A real process on a real PTY, end to end: the child sees its pane's
/// id in `SNYVI_SESSION` and its desk's folder as its cwd, what it prints
/// arrives as a frame, and its exit is a status.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_runs_a_process_and_its_output_arrives_as_frames() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let id = "00112233445566778899aabbccddeeff";
    let live = panes.get(id);
    let (first, mut rx) = live.attach();
    assert!(first[0].contains("\"running\":false"));
    let cwd = dir.path.to_string_lossy().to_string();
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "printf 'pane=%s key=%s\\n' \"$SNYVI_SESSION\" \"$SNYVI_T\"; pwd; exit 3",
            desk: "d",
            slot: 1,
            // Wide enough for a macOS temp dir, which is long enough to
            // wrap at 80 and split the name this looks for across rows.
            cols: 400,
            rows: 10,
            accent: "",
            offer: false,
            env: &[("SNYVI_T".to_string(), "x".to_string())],
        },
        &panes,
    )
    .unwrap();
    let mut seen = String::new();
    let mut exit = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while exit.is_none() && tokio::time::Instant::now() < deadline {
        let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await else {
            break;
        };
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        if v["t"] == "frame" {
            seen.push_str(&msg);
        }
        if v["t"] == "status" && v["s"]["running"] == false {
            exit = v["s"]["exit"].as_i64();
        }
    }
    // The last frame follows the status by at most a frame.
    while let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
        seen.push_str(&msg);
    }
    assert!(seen.contains(&format!("pane={id}")), "{seen}");
    // The desk's keys reach the child's environment and nothing else does.
    assert!(seen.contains(&format!("pane={id} key=x")), "{seen}");
    assert!(seen.contains(cwd.split('/').next_back().unwrap()), "{seen}");
    assert_eq!(exit, Some(3));
    // And what it left is on disk, for a restart to grey out.
    let text = panes.read_text(id).join("\n");
    assert!(text.contains(&format!("pane={id}")), "{text}");
}

/// A pane's text goes to disk in pieces -- the lines since the last
/// write onto the end of one file, the screen into another -- and reads
/// back as the whole, the same bytes the old whole write would have
/// made; past the cap it is cut from the front once, as before; and the
/// lock is held for the handles, not for the text.
#[tokio::test]
async fn what_a_pane_writes_down_in_pieces_reads_back_whole() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-persist");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let id = "0f0e0d0c0b0a09080706050403020101";
    let live = panes.get(id);
    let feed = |text: String| {
        let mut i = live.inner.lock().unwrap();
        let Inner {
            screen,
            parser,
            unsaved,
            unsaved_lines,
            ..
        } = &mut *i;
        screen.feed(parser, text.as_bytes());
        *unsaved = true;
        *unsaved_lines = true;
    };
    let whole = || {
        let i = live.inner.lock().unwrap();
        keep_text(&i.old, i.screen.text())
    };
    feed((0..10_000).map(|k| format!("line {k}\r\n")).collect());
    let want = whole();
    assert!(want.len() > 9_000, "the scrollback holds the lines");
    panes.persist_all(false);
    assert_eq!(
        panes.read_text(id),
        want,
        "the first write is the whole text"
    );
    assert!(dir.path.join("panes").join(format!("{id}.scr")).exists());

    // Five hundred more, and a prompt left on the screen: the lines go
    // on the end, the screen is written afresh, and the lock is held
    // for as long as the handles take to clone.
    feed(
        (10_000..10_500)
            .map(|k| format!("line {k}\r\n"))
            .collect::<String>()
            + "$ ",
    );
    let want = whole();
    let text = {
        let mut i = live.inner.lock().unwrap();
        let t0 = Instant::now();
        let text = i.take_text();
        let held = t0.elapsed();
        assert!(
            held < Duration::from_millis(10),
            "the lock was held {held:?}"
        );
        text
    };
    match &text {
        Text::More { lines, screen, .. } => {
            assert_eq!(lines.len(), 500, "the lines that left the screen since");
            assert_eq!(
                screen.last().map(String::as_str),
                Some("$"),
                "the screen, trailing blanks trimmed"
            );
        }
        Text::Whole { .. } => panic!("the second write is the lines since, not the whole"),
    }
    panes.write(id, text);
    assert_eq!(
        panes.read_text(id),
        want,
        "in pieces reads back as the whole"
    );

    // The screen alone changing is the screen file alone, rewritten.
    feed("\x1b[2K\r$ ls".to_string());
    let want = whole();
    let text = live.inner.lock().unwrap().take_text();
    assert!(matches!(&text, Text::More { lines, .. } if lines.is_empty()));
    panes.write(id, text);
    assert_eq!(panes.read_text(id), want);

    // Past the cap: cut from the front once, as `keep_text` cuts, and
    // then in pieces again.
    let big = "z".repeat(1000);
    feed((0..2_500).map(|_| format!("{big}\r\n")).collect());
    let want = whole();
    assert!(bytes(want.iter().map(String::len)) <= screen::SCROLLBACK_BYTES);
    let text = live.inner.lock().unwrap().take_text();
    assert!(
        matches!(text, Text::Whole { .. }),
        "over the cap: whole again"
    );
    panes.write(id, text);
    assert_eq!(panes.read_text(id), want);
    feed("one more\r\n".to_string());
    let want = whole();
    let text = live.inner.lock().unwrap().take_text();
    assert!(matches!(&text, Text::More { lines, .. } if lines.len() == 1));
    panes.write(id, text);
    assert_eq!(panes.read_text(id), want);

    // `clear`, with no page open to frame it: what is on disk is what
    // the reader cleared, and the next write is the whole text again --
    // not the lines since, appended to the cleared ones.
    feed("\x1b[3J\x1b[H\x1b[2Jafter\r\n".to_string());
    let want = whole();
    assert!(!want.iter().any(|l| l.contains("line 10")), "cleared");
    let text = live.inner.lock().unwrap().take_text();
    assert!(matches!(text, Text::Whole { .. }), "after a clear: whole");
    panes.write(id, text);
    assert_eq!(panes.read_text(id), want);
    assert!(!panes.read_text(id).iter().any(|l| l.contains("zzz")));
}

/// A desk whose folder was stored as `canonicalize` spells it on Windows,
/// `\\?\D:\…`, starts its panel in that folder -- not in C:\Windows,
/// where cmd.exe goes for a path it takes as UNC, and where Claude Code
/// then asked to be trusted.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_verbatim_folder_starts_the_panel_in_that_folder() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-unc");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let id = "00112233445566778899aabbccddeef0";
    let live = panes.get(id);
    let (_, mut rx) = live.attach();
    let cwd = std::fs::canonicalize(&dir.path)
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert!(cwd.starts_with(r"\\?\"), "the case this is about: {cwd}");
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "cd",
            desk: "d",
            slot: 1,
            cols: 400,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    let mut seen = String::new();
    let mut done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !done && tokio::time::Instant::now() < deadline {
        let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await else {
            break;
        };
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        if v["t"] == "frame" {
            seen.push_str(&msg);
        }
        done = v["t"] == "status" && v["s"]["running"] == false;
    }
    while let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
        seen.push_str(&msg);
    }
    assert!(!seen.contains("UNC paths are not supported"), "{seen}");
    let name = dir.path.file_name().unwrap().to_string_lossy().to_string();
    assert!(seen.contains(&name), "the panel is not in {name}: {seen}");
}

/// A daemon started inside a Claude Code session gives its panels none of
/// that session: Claude in a panel is not its child, and is in color. A
/// reader's own `NO_COLOR` stays when the daemon was not started there.
#[test]
fn a_panel_starts_outside_the_session_that_started_the_daemon() {
    let made = || {
        let mut c = CommandBuilder::new("x");
        for k in ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "NO_COLOR", "PATH_KEPT"] {
            c.env(k, "1");
        }
        c
    };
    let mut c = made();
    fresh_env(&mut c, true);
    assert!(c.get_env("CLAUDECODE").is_none());
    assert!(c.get_env("CLAUDE_CODE_CHILD_SESSION").is_none());
    assert!(c.get_env("NO_COLOR").is_none());
    assert!(c.get_env("PATH_KEPT").is_some());
    let mut c = made();
    fresh_env(&mut c, false);
    assert!(c.get_env("CLAUDE_CODE_CHILD_SESSION").is_none());
    assert!(c.get_env("NO_COLOR").is_some());
}

/// A key buys one fast frame for the output that follows it, and only
/// one: output before the key, or long after it, or a second burst after
/// the echo, is paced as before.
#[tokio::test]
async fn a_key_buys_one_fast_frame_for_its_echo() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-echo");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let live = panes.get("0f0e0d0c0b0a09080706050403020100");
    let mut i = live.inner.lock().unwrap();
    assert!(!i.echo_due(), "nothing typed");
    let key = Instant::now();
    i.wrote = key - Duration::from_millis(1);
    i.typed = Some(key);
    assert!(!i.echo_due(), "output from before the key is not its echo");
    i.wrote = key + Duration::from_millis(1);
    assert!(i.echo_due(), "the echo");
    assert!(!i.echo_due(), "spent: the next output is paced");
    i.typed = Some(key - ECHO_WINDOW * 2);
    i.wrote = Instant::now();
    assert!(!i.echo_due(), "too long after the key to be its echo");
    assert_eq!(i.typed, None);
}

/// A pane nobody watches makes a frame a second, not sixty -- and a page
/// that attaches between two of them still gets the screen as it is.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unwatched_pane_is_caught_up_when_a_page_attaches() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-idle");
    let (events, _) = broadcast::channel(16);
    let panes = Panes::new(&dir.path, events);
    let live = panes.get("ffeeddccbbaa99887766554433221100");
    let cwd = dir.path.to_string_lossy().to_string();
    // The shell leaves a file once "late" is out, and the page attaches
    // the moment it is there: a shell slow to start on a busy machine
    // moves both together, where a fixed wait once caught neither line.
    let said = dir.path.join("late-said");
    let cmd = format!(
        "printf 'early\\n'; sleep 0.3; printf 'late\\n'; : > '{}'; sleep 2",
        said.display()
    );
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: &cmd,
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    // "late" is printed 0.3 s after "early"; the next unwatched frame is
    // a second after the first, so without a catch-up the snapshot taken
    // now would miss it.
    for _ in 0..100 {
        if said.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(said.exists(), "the shell never printed its second line");
    let (first, _rx) = live.attach();
    let snap = first.last().unwrap();
    assert!(snap.contains("late"), "{snap}");
}

/// A pane started in a folder reached through a link has not moved when
/// the kernel names the folder resolved: macOS's /var is /private/var.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_through_a_link_is_not_a_move() {
    let dir = crate::store::tempdir::Dir::new("snyvi-link");
    std::fs::create_dir_all(dir.path.join("real")).unwrap();
    std::os::unix::fs::symlink(dir.path.join("real"), dir.path.join("link")).unwrap();
    let (events, _ev) = broadcast::channel(64);
    let panes = Panes::new(&dir.path, events);
    let id = "00112233445566778899aabbccddeeff";
    let live = panes.get(id);
    let link = dir.path.join("link").to_string_lossy().to_string();
    live.start(
        Start {
            cwd: &link,
            root: &link,
            cmd: "sleep 30",
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    // Until the child is in it: between the fork and its chdir, the
    // kernel names the parent's folder.
    for _ in 0..100 {
        if live.shell_cwd().is_some_and(|c| c.ends_with("/real")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        live.shell_cwd().is_some_and(|c| c.ends_with("/real")),
        "the kernel names it resolved"
    );
    panes.follow_folders();
    assert_eq!(live.inner.lock().unwrap().cwd, link, "not a move");
    assert!(
        live.running_in().is_some_and(|(_, home)| home),
        "and still inside the desk's folder"
    );
    live.stop();
}

/// The agent's word reaches only a pane that is running, is sent once per
/// change, and goes with the process.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_state_is_set_on_a_running_pane_once_per_change() {
    let dir = crate::store::tempdir::Dir::new("snyvi-agent");
    let (events, mut ev) = broadcast::channel(64);
    let panes = Panes::new(&dir.path, events);
    let id = "ffeeddccbbaa99887766554433221100";
    assert!(!panes.set_agent(id, "working"), "a pane nobody opened");
    let live = panes.get(id);
    assert!(!panes.set_agent(id, "working"), "a stopped pane");
    let (_, mut rx) = live.attach();
    let cwd = dir.path.to_string_lossy().to_string();
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "read x",
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    assert!(panes.set_agent(id, "needs_you"));
    assert!(
        panes.status(id).blocked,
        "needs_you is blocked, for the sidebar"
    );
    assert!(panes.set_agent(id, "needs_you"));
    assert!(panes.set_agent(id, "nonsense"), "an unknown word clears it");
    let st = panes.status(id);
    assert_eq!(st.agent, "");
    assert!(!st.blocked, "leaving needs_you unblocks");
    assert!(panes.set_agent(id, "done"));
    let mut said = Vec::new();
    while let Ok(Ok(m)) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
        let v: serde_json::Value = serde_json::from_str(&m).unwrap();
        if v["t"] == "status" && v["s"]["running"] == true {
            said.push(v["s"]["agent"].as_str().unwrap().to_string());
        }
    }
    assert_eq!(said, ["", "needs_you", "", "done"], "one frame per change");
    let mut dots = Vec::new();
    while let Ok(m) = ev.try_recv() {
        dots.push(m);
    }
    assert!(
        dots.iter().any(|d| d.contains("\"agent\":\"needs_you\"")),
        "{dots:?}"
    );
    live.stop();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while panes.status(id).running && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        panes.status(id).agent,
        "",
        "the agent goes with its process"
    );
}

/// An agent is in a pane from its SessionStart, before any state, and
/// leaves with its SessionEnd or its process.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_is_in_from_its_start_to_its_end() {
    let dir = crate::store::tempdir::Dir::new("snyvi-agent-in");
    let (events, _ev) = broadcast::channel(64);
    let panes = Panes::new(&dir.path, events);
    let id = "00112233445566778899aabbccddeeff";
    assert!(!panes.agent_in(id), "a pane nobody opened");
    let live = panes.get(id);
    let cwd = dir.path.to_string_lossy().to_string();
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "read x",
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    assert!(!panes.status(id).agent_in);
    assert!(panes.agent_in(id));
    let st = panes.status(id);
    assert!(st.agent_in && st.agent.is_empty(), "in, before any prompt");
    assert!(panes.set_agent(id, ""), "SessionEnd");
    assert!(!panes.status(id).agent_in, "out, though it never prompted");
    assert!(panes.agent_in(id));
    assert!(panes.set_agent(id, "working"));
    assert!(panes.status(id).agent_in);
    live.stop();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while panes.status(id).running && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!panes.status(id).agent_in, "out with its process");
}

/// A title is the pane header's business and goes down the desk socket;
/// the page-wide stream hears only what the sidebar draws, once per
/// change. An agent retitles its pane about once a second while it works.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_title_reaches_the_desk_and_not_the_sidebar() {
    let dir = crate::store::tempdir::Dir::new("snyvi-title");
    let (events, mut ev) = broadcast::channel(64);
    let panes = Panes::new(&dir.path, events);
    let id = "00112233445566778899aabbccddeeff";
    let live = panes.get(id);
    let (_, mut rx) = live.attach();
    let cwd = dir.path.to_string_lossy().to_string();
    live.start(
        Start {
            cwd: &cwd,
            root: &cwd,
            cmd: "for t in a b c d e; do printf '\\033]0;%s\\007' $t; sleep 0.05; done; printf '\\a'; read x",
            desk: "d",
            slot: 1,
            cols: 80,
            rows: 10,
            accent: "",
            offer: false,
            env: &[],
        },
        &panes,
    )
    .unwrap();
    let mut titles = Vec::new();
    // Generous: a shell under a full `cargo test` has been seen to take
    // past five seconds to its first prompt. Alone it is under one.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !panes.status(id).blocked && tokio::time::Instant::now() < deadline {
        while let Ok(m) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&m).unwrap();
            if v["t"] == "status" {
                titles.push(v["s"]["title"].as_str().unwrap_or("").to_string());
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(panes.status(id).blocked, "the bell rang");
    assert!(
        titles.iter().any(|t| t == "c"),
        "the header hears titles: {titles:?}"
    );
    // The bell's word on the page-wide stream goes out just after the
    // status says blocked -- `changed`, once the pane's lock is let go --
    // so it is waited for, not taken to be there already.
    let mut dots: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !dots.iter().any(|m| m.contains("\"blocked\":true"))
        && tokio::time::Instant::now() < deadline
    {
        while let Ok(m) = ev.try_recv() {
            dots.push(m);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // A repeat of what was said is not said again.
    let s = panes.status(id);
    panes.changed(id, &s);
    while let Ok(m) = ev.try_recv() {
        dots.push(m);
    }
    assert_eq!(
        dots.len(),
        2,
        "the start and the bell, nothing per title: {dots:?}"
    );
    assert!(dots[1].contains("\"blocked\":true"), "{dots:?}");
    live.stop();
}

/// 1.7.1: a shell that `cd`s is found where it went, by asking the
/// kernel -- which is what brings a panel back in that folder.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn a_shell_that_moved_is_found_where_it_went() {
    let dir = crate::store::tempdir::Dir::new("snyvi-pane-cwd");
    std::fs::create_dir(dir.path.join("sub")).unwrap();
    let mut child = std::process::Command::new("sh")
        .args(["-c", "cd sub && exec sleep 5"])
        .current_dir(&dir.path)
        .spawn()
        .unwrap();
    let want = std::fs::canonicalize(dir.path.join("sub")).unwrap();
    let mut seen = None;
    for _ in 0..50 {
        seen = folder_of(child.id()).map(std::path::PathBuf::from);
        if seen.as_deref() == Some(want.as_path()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(seen.as_deref(), Some(want.as_path()));
    assert_eq!(folder_of(u32::MAX), None, "no such process, no folder");
}
