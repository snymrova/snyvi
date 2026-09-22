//! `snyvi bench`: the budget is a test.
//!
//! Two halves. The render rows call the renderer in process on synthetic
//! documents, and are the cost of the work. The process rows start a daemon
//! of their own -- its own data directory, its own port, gone when the bench
//! is -- and measure what a reader meets before anything is rendered: how big
//! the binary is, how long a cold daemon takes to answer, what a send costs
//! end to end, when a page's first byte arrives, and what the daemon holds
//! resident once there are documents in it. Until 0.10 those rows were
//! measured by hand for the README and enforced by nothing, so they drifted.
//!
//! `SNYVI_BENCH_FACTOR` scales the budgets that are clocks, for a hosted
//! runner that is slower than a dev box. A size or a resident set is not a
//! clock: the same binary weighs the same on any machine, so those budgets
//! are never scaled. `SNYVI_BENCH_SHARED` says the machine is one whose
//! speed is not snyvi's to promise, as `bench/browser.mjs` uses it: the one
//! row that is mostly the operating system's -- creating a process, which a
//! hosted Windows runner does in 400 ms and a dev box in 10 -- is then
//! printed and not enforced, and every other row still is. It scales the
//! ceilings the bench waits under as well as the budgets it prints: those
//! are not measurements but the line past which an exchange is a hang, and
//! a line that does not move with the machine is a red build on the slowest
//! one. See `Daemon::patience`.

use crate::render;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A megabyte as the README counts them: a 12,329,208-byte binary is 12.3 MB.
const MB: f64 = 1e6;

pub fn run(check: bool) -> Result<()> {
    // A multiplier, and only ever a sane one. It now scales the ceilings the
    // bench waits under as well as the budgets it prints, and
    // `Duration::from_secs_f64` panics on a negative, an infinity or a NaN --
    // all three of which parse cleanly out of the environment. A factor under
    // 1.0 is refused for the same reason from the other end: zero would turn
    // every ceiling into an instant timeout and every budget into an OVER.
    // Anything outside the range falls back to 1.0, which is the strict end,
    // so a typo tightens the bench rather than loosening it.
    let factor: f64 = std::env::var("SNYVI_BENCH_FACTOR")
        .ok()
        .and_then(|f| f.parse::<f64>().ok())
        .filter(|f| f.is_finite() && (1.0..=10.0).contains(f))
        .unwrap_or(1.0);
    let shared = std::env::var_os("SNYVI_BENCH_SHARED").is_some();
    let fixtures = Fixtures::new();
    let mut failed = render_rows(&fixtures, factor);
    failed |= process_rows(&fixtures, factor, shared)?;
    if check && failed {
        bail!("bench: at least one case exceeded its budget");
    }
    Ok(())
}

struct Fixtures {
    md_2k: &'static str,
    md_100k: String,
    md_1m: String,
    code_10k: String,
    code_100k: String,
}

impl Fixtures {
    fn new() -> Self {
        // A realistic document: prose, headings, lists, a table, and a code block every ~2 KB.
        let section = "## Section heading\n\nA paragraph of ordinary prose with *emphasis*, **strong text**, `inline code`, and a [link](https://example.com). \
It runs on for a few sentences so the parser sees realistic line lengths and inline markup density.\n\n\
- one item\n- another item with `code`\n- a third\n\n\
| col a | col b | col c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\n\
> A quote that says something worth remembering.\n\n\
Another paragraph. Then more prose, because most documents are mostly prose, and the renderer should be judged on that.\n\n\
```rust\nfn main() {\n    let x = 42;\n    println!(\"{x}\");\n}\n```\n\n";
        let repeat = |bytes: usize| -> String {
            (0..bytes / section.len() + 1)
                .map(|i| section.replacen("Section heading", &format!("Section {i}"), 1))
                .collect()
        };
        let code = |lines: usize| -> String {
            (0..lines)
                .map(|i| format!("fn f{i}(x: u32) -> u32 {{ x + {i} }} // line\n"))
                .collect()
        };
        Fixtures {
            md_2k: section,
            md_100k: repeat(100 * 1024),
            md_1m: repeat(1024 * 1024),
            code_10k: code(10_000),
            code_100k: code(100_000),
        }
    }
}

// ---------- the renderer, in process ----------

/// Returns whether any row was over budget.
fn render_rows(f: &Fixtures, factor: f64) -> bool {
    // Budgets in ms on a warm 4-core dev box. The 1 MB Markdown target in docs/BRAINSTORM.md
    // was 200 ms; the budget was set at 400 when comrak with all extensions landed at ~265,
    // and stays there now the sanitizer fast path has it at ~108: it is the line a change
    // must not cross, not the number (section 14 of that document has the rest).
    let t0 = Instant::now();
    let r = render::Renderer::new();
    let init_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let cases: Vec<(&str, render::Kind, Option<&str>, &str, f64)> = vec![
        ("markdown 2 KB", render::Kind::Markdown, None, f.md_2k, 2.0),
        (
            "markdown 100 KB",
            render::Kind::Markdown,
            None,
            &f.md_100k,
            50.0,
        ),
        (
            "markdown 1 MB",
            render::Kind::Markdown,
            None,
            &f.md_1m,
            400.0,
        ),
        (
            "rust 10k lines (highlighted)",
            render::Kind::Code,
            Some("rs"),
            &f.code_10k,
            500.0,
        ),
        (
            "rust 100k lines (highlight capped at 256 KB)",
            render::Kind::Code,
            Some("rs"),
            &f.code_100k,
            500.0,
        ),
    ];
    println!("renderer init: {init_ms:.1} ms   (budget factor {factor})\n");
    println!(
        "{:<48} {:>9} {:>9}   {:>9}   {:>9}",
        "case", "ms", "MB/s", "html KB", "budget"
    );
    let mut failed = false;
    for (name, kind, lang, src, budget) in cases {
        // Warm once so lazy regex compilation is not charged to the measurement.
        let _ = r.render(kind, lang, &src[..src.len().min(2048)]);
        // Best of three: the number we care about is the cost of the work, not scheduler noise.
        let mut best = f64::MAX;
        let mut out_len = 0;
        for _ in 0..3 {
            let t = Instant::now();
            let out = r.render(kind, lang, src);
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            out_len = out.len();
        }
        let budget = budget * factor;
        let ok = best <= budget;
        failed |= !ok;
        let mbs = src.len() as f64 / 1e6 / (best / 1000.0);
        println!(
            "{name:<48} {best:>9.1} {mbs:>9.1}   {:>9}   {budget:>7.0}{}",
            out_len / 1024,
            if ok { " ok" } else { " OVER" }
        );
    }
    failed
}

// ---------- the daemon, as a process ----------

/// Returns whether any row was over budget.
///
/// Every timing is the best of three, like the render rows, and for the same
/// reason. The cold start is three daemons in turn; the third one stays up
/// for the rows that need documents in it. Documents go in by path, the way
/// `snyvi send FILE` and the hook send them: the daemon reads the file
/// itself, which is also the only way a 4.5 MB file goes in at all, since a
/// request body is capped at 2 MB.
fn process_rows(f: &Fixtures, factor: f64, shared: bool) -> Result<bool> {
    let exe = std::env::current_exe().context("locating snyvi binary")?;
    let dir = std::env::temp_dir().join(format!("snyvi-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).context("creating the bench's data directory")?;
    let port = free_port()?;

    println!(
        "\n{:<48} {:>9}   {:>9}{}",
        "process",
        "value",
        "budget",
        if shared { "   (shared machine)" } else { "" }
    );
    let mut rows = Rows { failed: false };

    let size = std::fs::metadata(&exe)?.len() as f64 / MB;
    rows.size("binary size, snyvi", size, 15.0);

    // Three cold starts: the first also creates the database and the token,
    // and the two after it open what the first left, which is every start
    // but a machine's first. The best of the three is the daemon's cost.
    let mut daemon = None;
    let mut start = f64::MAX;
    for _ in 0..3 {
        if let Some(d) = daemon.take() {
            stop(d);
        }
        let (d, ms) = Daemon::start(&exe, &dir, port, factor)?;
        start = start.min(ms);
        daemon = Some(d);
    }
    // Mostly the operating system's: create a process, map a 10 MB image,
    // and on a hosted Windows runner have the antivirus read it first. That
    // runner reads 405 ms where a Linux one reads 13 and a dev box 11, so on
    // a shared machine this row is printed and not enforced. The rows below
    // it are the daemon's own work and are enforced everywhere.
    rows.time_unless(
        "daemon cold start, to first health",
        start,
        100.0,
        factor,
        shared,
    );
    let daemon = daemon.expect("three starts leave one running");

    let result = (|| -> Result<()> {
        // A send is the round trip an agent's hook pays: the daemon reads,
        // renders and stores, and only then answers. Three files that differ,
        // because the same content sent twice is answered from the store.
        let mut send = f64::MAX;
        let mut id = String::new();
        for i in 0..3 {
            let path = dir.join(format!("bench-{i}.md"));
            std::fs::write(&path, format!("# Bench {i}\n\n{}", f.md_100k))?;
            let (doc, ms) = daemon.send(&path)?;
            send = send.min(ms);
            id = doc;
        }
        rows.time("send 100 KB markdown, round trip", send, 100.0, factor);

        // Read before the page fetches below rather than after: a page asked
        // for while the render thread is still alive leaves a dozen MB with
        // the worker that served it, and that is a different fact from what
        // three documents cost (docs/ROADMAP.md, 0.10).
        rows.memory(
            "daemon resident, three documents in, settled",
            daemon.settled_mb(None)?,
            60.0,
        );

        // The page, as the browser asks for it: the shell with the sidebar
        // in it, which is what a reader waits on before the document draws.
        let mut ttfb = f64::MAX;
        for _ in 0..3 {
            ttfb = ttfb.min(daemon.first_byte(&format!("/d/{id}"))?);
        }
        rows.time("document page, time to first byte", ttfb, 30.0, factor);

        // Loaded: the two largest render cases go through it, so the number
        // is what the daemon keeps after the biggest work it is asked to do.
        // The code file is stored partly plain and highlighted in full off the
        // request path, and that is the work that leaves the most behind, so
        // the reading waits for the daemon to say it is done.
        let big_md = dir.join("bench-1mb.md");
        let big_rs = dir.join("bench-100k.rs");
        std::fs::write(&big_md, &f.md_1m)?;
        std::fs::write(&big_rs, &f.code_100k)?;
        let events = daemon.events()?;
        // Timed, not only awaited. These two were the only sends in this file
        // with no clock on them, which left the transport ceiling as the one
        // thing that would notice them getting slower -- and a ceiling that
        // scales with the machine is a poor detector, because it is meant to
        // catch a hang and not a regression. A row catches the regression.
        let (_, md_ms) = daemon.send(&big_md)?;
        let (_, rs_ms) = daemon.send(&big_rs)?;
        // Roomy on purpose. This one swings with the machine more than any
        // other row -- half a second on a quiet box and over a second and a
        // half on a busy one -- and a row that goes red on a loaded runner is
        // the thing this file was just fixed for. It is here to catch a
        // regression of the kind a ceiling would have slept through, not to
        // hold the daemon to a tenth of a second.
        rows.time("send 1 MB markdown, round trip", md_ms, 2000.0, factor);
        // The code file is the slowest exchange the daemon has: it is stored
        // partly plain, and 100k lines of it is 1.8 s on a dev box where the
        // megabyte of markdown is half a second. The budget is that, with the
        // same room to move the other rows are given.
        rows.time("send 100k lines of code, round trip", rs_ms, 3500.0, factor);
        rows.memory(
            "daemon resident, after 1 MB and 100k lines, settled",
            daemon.settled_mb(Some((events, "rendered")))?,
            100.0,
        );
        Ok(())
    })();

    stop(daemon);
    let _ = std::fs::remove_dir_all(&dir);
    result?;
    if shared {
        println!("\na budget in brackets is measured and not enforced: this machine's speed is not snyvi's to promise");
    }
    Ok(rows.failed)
}

struct Rows {
    failed: bool,
}

impl Rows {
    fn time(&mut self, name: &str, ms: f64, budget: f64, factor: f64) {
        self.time_unless(name, ms, budget, factor, false);
    }

    /// A timing that is printed against its budget but, when `unenforced`,
    /// does not fail the check: the budget goes in brackets, as the browser
    /// bench writes it, so the log says which rows a red would have come from.
    fn time_unless(&mut self, name: &str, ms: f64, budget: f64, factor: f64, unenforced: bool) {
        let budget = budget * factor;
        let ok = ms <= budget;
        self.failed |= !ok && !unenforced;
        let budget = if unenforced {
            format!("({budget:.0} ms)")
        } else {
            format!("{budget:.0} ms")
        };
        println!(
            "{name:<48} {:>9}   {budget:>9}{}",
            format!("{ms:.1} ms"),
            match (ok, unenforced) {
                (true, _) => " ok",
                (false, true) => " over, not enforced here",
                (false, false) => " OVER",
            }
        );
    }

    fn size(&mut self, name: &str, mb: f64, budget: f64) {
        let ok = mb <= budget;
        self.failed |= !ok;
        println!(
            "{name:<48} {:>9}   {:>9}{}",
            format!("{mb:.1} MB"),
            format!("{budget:.0} MB"),
            if ok { " ok" } else { " OVER" }
        );
    }

    /// A platform this cannot be read on prints the row and enforces nothing,
    /// so a check there is not a silent pass dressed as a measurement. So
    /// does one where the only number to be had is not the one the budget
    /// means (see `resident_bytes` for macOS), which says so on the row.
    fn memory(&mut self, name: &str, mb: Option<(f64, bool)>, budget: f64) {
        match mb {
            Some((mb, true)) => self.size(name, mb, budget),
            Some((mb, false)) => println!(
                "{name:<48} {:>9}   {:>9} counts pages given back but not yet taken; not enforced",
                format!("{mb:.1} MB"),
                format!("({budget:.0} MB)")
            ),
            None => println!(
                "{name:<48} {:>9}   {:>9} not measured here",
                "-",
                format!("{budget:.0} MB")
            ),
        }
    }
}

struct Daemon {
    child: Child,
    port: u16,
    token: String,
    /// How long one exchange with this daemon may take before the bench
    /// calls it a hang rather than slow.
    ///
    /// Not a budget: the budgets are the rows, and they are what a
    /// regression fails. This is only the line past which the bench stops
    /// waiting, so that a daemon that never answers ends the run instead of
    /// holding a runner for six hours. It scales with the factor for the
    /// same reason the clocks do -- the hosted Windows runner creates a
    /// process in 405 ms where a dev box takes 11 -- and it did not, which
    /// is how a fixed 30 s ceiling took main's build down on the one send
    /// in this file that no row holds a clock to: `timeout: global`, no row
    /// over budget, and nothing in the log to say which document it was.
    patience: Duration,
}

impl Daemon {
    /// Start a daemon on its own port and directory, and time it to the first
    /// health answer: the moment a `snyvi send` or `snyvi app` can proceed.
    fn start(exe: &Path, dir: &Path, port: u16, factor: f64) -> Result<(Daemon, f64)> {
        let t0 = Instant::now();
        let child = Command::new(exe)
            .arg("serve")
            .env("SNYVI_DATA_DIR", dir.join("data"))
            .env("SNYVI_CONFIG_DIR", dir.join("config"))
            .env("SNYVI_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("starting a daemon for the bench")?;
        let patience = Duration::from_secs_f64(30.0 * factor);
        let mut daemon = Daemon {
            child,
            port,
            token: String::new(),
            patience,
        };
        // Asked every two milliseconds: a daemon answers in about 25, and the
        // number being measured is the daemon's, not the poll's. Which is why
        // the poll's own ceiling scales too: a 400 ms cut-off on a machine
        // that answers in 405 measures the cut-off and not the daemon.
        let poll = Duration::from_secs_f64(0.4 * factor);
        let deadline = t0 + Duration::from_secs_f64(10.0 * factor);
        let ms = loop {
            if daemon.health(poll).is_some() {
                break t0.elapsed().as_secs_f64() * 1000.0;
            }
            if let Some(status) = daemon.child.try_wait()? {
                bail!("the bench's daemon exited before answering ({status})");
            }
            if Instant::now() > deadline {
                bail!(
                    "the bench's daemon did not answer on port {port} within {:.0} s",
                    (deadline - t0).as_secs_f64()
                );
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        daemon.token = std::fs::read_to_string(dir.join("config").join("token"))
            .map(|t| t.trim().to_string())
            .context("reading the bench daemon's token")?;
        Ok((daemon, ms))
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn health(&self, within: Duration) -> Option<Value> {
        ureq::get(&self.url("/api/health"))
            .config()
            .timeout_global(Some(within))
            .build()
            .call()
            .ok()?
            .body_mut()
            .read_json::<Value>()
            .ok()
    }

    /// Send a file the way the CLI does and time the whole exchange. Returns
    /// the new document's id.
    fn send(&self, path: &Path) -> Result<(String, f64)> {
        let payload = serde_json::json!({
            "path": path,
            "cwd": path.parent(),
            "origin": "cli",
        });
        let t = Instant::now();
        let mut resp = ureq::post(&self.url("/api/docs"))
            .header("Authorization", &format!("Bearer {}", self.token))
            .config()
            .timeout_global(Some(self.patience))
            .http_status_as_error(false)
            .build()
            .send_json(&payload)
            .with_context(|| {
                // Only a wait that reached the ceiling is a wait worth naming:
                // a refused connection comes back in four milliseconds, and
                // "gave up after 0 s" reads as though the daemon answered.
                if t.elapsed() >= self.patience {
                    format!(
                        "sending {} to the bench's daemon, which gave up after {:.0} s",
                        path.display(),
                        t.elapsed().as_secs_f64()
                    )
                } else {
                    format!("sending {} to the bench's daemon", path.display())
                }
            })?;
        let status = resp.status().as_u16();
        let body: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if status >= 300 {
            bail!("the bench's daemon refused a document ({status}): {body}");
        }
        let id = body
            .pointer("/doc/id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("the send answered without a document id: {body}"))?
            .to_string();
        Ok((id, ms))
    }

    /// Time to the response headers: the first byte, near enough, and the
    /// moment a browser starts parsing.
    fn first_byte(&self, path: &str) -> Result<f64> {
        let t = Instant::now();
        let resp = ureq::get(&self.url(path))
            .config()
            // A third of the patience, which is the 10 s this waited before
            // the factor existed: a GET that is only a fetch has no send's
            // work behind it, and scaling is all this change is meant to do.
            .timeout_global(Some(self.patience / 3))
            .build()
            .call()
            .with_context(|| format!("fetching {path} from the bench's daemon"))?;
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        if resp.status().as_u16() != 200 {
            bail!("{path} answered {}", resp.status());
        }
        Ok(ms)
    }

    /// The daemon's event stream, opened before the work whose end it is
    /// going to announce, so the announcement cannot come before the listener.
    fn events(&self) -> Result<Events> {
        let resp = ureq::get(&self.url("/api/events"))
            .config()
            // The whole stream, not one read: this is how long the bench will
            // wait for the daemon to finish a highlight before giving up. Four
            // exchanges' worth, because it outlasts the two largest sends and
            // the work they leave running behind them.
            .timeout_global(Some(self.patience * 4))
            .build()
            .call()
            .context("opening the bench daemon's event stream")?;
        Ok(Events(BufReader::new(resp.into_body().into_reader())))
    }

    /// The daemon's resident set once it has finished, in MB. None where
    /// there is no way to read it.
    ///
    /// Two things make the number right after a send the wrong one. The
    /// daemon may still be working: a large code file is answered before its
    /// full highlight, so the caller says which event ends the work. And a
    /// render's freed memory goes back to the system only when the blocking
    /// thread that ran it retires, a second after its last task (see the
    /// runtime in main.rs). So this waits for the event, then three seconds,
    /// then reads: what the daemon holds while nobody is sending, which is
    /// the number a reader lives with.
    fn settled_mb(&self, done: Option<(Events, &str)>) -> Result<Option<(f64, bool)>> {
        if let Some((events, name)) = done {
            events.wait_for(name)?;
        }
        std::thread::sleep(Duration::from_secs(3));
        Ok(self.resident_mb())
    }

    /// The daemon's resident set, in MB, and whether that number is one a
    /// budget can be held to. None where there is no way to read it.
    fn resident_mb(&self) -> Option<(f64, bool)> {
        resident_bytes(&self.child).map(|(b, exact)| (b as f64 / MB, exact))
    }
}

/// A daemon that outlived the bench would sit on a port and a temporary
/// directory nobody is coming back for, so one that is still running when
/// its handle goes -- a start that never answered, a panic in a row -- is
/// ended here. `stop` asks politely first and reaches this with it gone.
impl Drop for Daemon {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// A subscription to `/api/events`, read a line at a time.
struct Events(BufReader<ureq::BodyReader<'static>>);

impl Events {
    /// Block until the daemon announces `name`. Keep-alive comments and other
    /// events go by; a closed stream, or the stream's own timeout, is an error.
    fn wait_for(mut self, name: &str) -> Result<()> {
        let want = format!("event: {name}");
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .0
                .read_line(&mut line)
                .with_context(|| format!("waiting for the daemon's `{name}` event"))?;
            if n == 0 {
                bail!("the daemon's event stream ended before `{name}`");
            }
            if line.trim_end() == want {
                return Ok(());
            }
        }
    }
}

/// Ask the daemon to exit, and make sure it did. The bench started it, so the
/// bench holds the process and can end it without guessing which snyvi it is.
fn stop(mut d: Daemon) {
    let _ = ureq::post(&d.url("/api/shutdown"))
        .header("Authorization", &format!("Bearer {}", d.token))
        .config()
        .timeout_global(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .send_empty();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(d.child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = d.child.kill();
    let _ = d.child.wait();
}

/// A port nobody is listening on, so the bench never meets a real daemon --
/// CI's or the reader's own library on 7777.
fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").context("finding a free port")?;
    Ok(l.local_addr()?.port())
}

/// What the daemon holds, in bytes, and whether the number is the one the
/// budget means: memory the process is actually keeping. On Linux and
/// Windows it is. On macOS the plain resident count is not, so the footprint
/// is read instead, and the plain count is returned marked inexact only when
/// the footprint cannot be.
#[cfg(target_os = "linux")]
fn resident_bytes(child: &Child) -> Option<(u64, bool)> {
    let status = std::fs::read_to_string(format!("/proc/{}/status", child.id())).ok()?;
    let kb: u64 = status
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()?;
    Some((kb * 1024, true))
}

/// On macOS the allocator gives freed pages back with MADV_FREE, and the
/// kernel leaves them counted in the resident set until it needs them: `ps`
/// read 181 MB for a daemon whose Linux twin settled at 82, most of it pages
/// nobody was using. The physical footprint is the count without those --
/// what Activity Monitor shows -- and `vmmap`, which ships with the command
/// line tools, prints it for any process of one's own. Without `vmmap` the
/// plain count is all there is, and it is returned marked as such.
#[cfg(target_os = "macos")]
fn resident_bytes(child: &Child) -> Option<(u64, bool)> {
    let pid = child.id().to_string();
    let footprint = Command::new("vmmap")
        .args(["--summary", &pid])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            let value = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("Physical footprint:"))?
                .trim()
                .to_string();
            parse_size(&value)
        });
    if let Some(b) = footprint {
        return Some((b, true));
    }
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .ok()?;
    let kb: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some((kb * 1024, false))
}

/// A size as `vmmap` prints one: a number and a unit letter, `38.9M`.
#[cfg(target_os = "macos")]
fn parse_size(s: &str) -> Option<u64> {
    let (num, unit) = s.split_at(s.len().checked_sub(1)?);
    let n: f64 = num.parse().ok()?;
    let mul = match unit {
        "K" => 1024.0,
        "M" => 1024.0 * 1024.0,
        "G" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((n * mul) as u64)
}

#[cfg(windows)]
fn resident_bytes(child: &Child) -> Option<(u64, bool)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: the handle is the child's, held open by the Child for as long
    // as it exists, and the structure is the size the call is told it is.
    let ok =
        unsafe { GetProcessMemoryInfo(child.as_raw_handle() as _, &mut counters, counters.cb) };
    (ok != 0).then_some((counters.WorkingSetSize as u64, true))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn resident_bytes(_: &Child) -> Option<(u64, bool)> {
    None
}
