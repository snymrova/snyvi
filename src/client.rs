//! Talk to the running daemon from the CLI and the MCP server; start it if needed.

use crate::config::{self, Paths};
use crate::receive::Payload;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::time::{Duration, Instant};

pub fn health() -> Option<Value> {
    ureq::get(&format!("{}/api/health", config::base_url()))
        .config()
        .timeout_global(Some(Duration::from_millis(400)))
        .build()
        .call()
        .ok()?
        .body_mut()
        .read_json::<Value>()
        .ok()
}

/// Ask a running daemon to exit. Returns false when none was running.
///
/// Versions before 0.3 have no shutdown endpoint, and an upgrade is exactly when
/// that matters, so fall back to signalling the process.
pub fn stop(paths: &Paths) -> Result<bool> {
    let Some(h) = health() else { return Ok(false) };
    let running = h
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();
    if let Some(token) = config::read_token(paths) {
        let _ = ureq::post(&format!("{}/api/shutdown", config::base_url()))
            .header("Authorization", &format!("Bearer {token}"))
            .config()
            .timeout_global(Some(Duration::from_secs(5)))
            .http_status_as_error(false)
            .build()
            .send_empty();
    }
    if wait_gone(Duration::from_millis(1200)) {
        eprintln!("stopped snyvi {running}");
        return Ok(true);
    }
    for force in [false, true] {
        let pids = daemon_pids(&h);
        if pids.is_empty() {
            break;
        }
        for pid in pids {
            crate::platform::terminate(pid, force);
        }
        if wait_gone(Duration::from_secs(3)) {
            eprintln!("stopped snyvi {running}");
            return Ok(true);
        }
    }
    bail!(
        "could not stop the daemon on {}; stop it by hand and try again",
        config::base_url()
    )
}

fn wait_gone(within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if health().is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    health().is_none()
}

/// The daemon's own process id, for when asking it to exit did not work.
///
/// It reports it on /api/health, which is the only answer that is certainly
/// about the daemon on our port rather than some other snyvi. Daemons before
/// 0.7 do not report one; on Linux they can still be found by their command
/// line, and there were no Windows daemons before 0.7 to find.
fn daemon_pids(health: &Value) -> Vec<u32> {
    if let Some(pid) = health.get("pid").and_then(Value::as_u64) {
        if pid > 0 && pid != u64::from(std::process::id()) {
            return vec![pid as u32];
        }
    }
    legacy_pids()
}

/// Processes that look like `snyvi serve` on the port we are talking to.
#[cfg(target_os = "linux")]
fn legacy_pids() -> Vec<u32> {
    let want_port = config::port().to_string();
    let me = std::process::id();
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        if pid == me {
            continue;
        }
        let Ok(cmdline) = std::fs::read(e.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<String> = cmdline
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        let is_snyvi = args
            .first()
            .map(|a| a.rsplit('/').next().unwrap_or(a) == "snyvi")
            .unwrap_or(false);
        if !is_snyvi || !args.iter().any(|a| a == "serve") {
            continue;
        }
        // Only the daemon on our port; another may be serving a different library.
        let env = std::fs::read(e.path().join("environ")).unwrap_or_default();
        let their_port = env
            .split(|b| *b == 0)
            .filter_map(|s| std::str::from_utf8(s).ok())
            .find_map(|kv| kv.strip_prefix("SNYVI_PORT=").map(str::to_string))
            .unwrap_or_else(|| config::DEFAULT_PORT.to_string());
        if their_port == want_port {
            out.push(pid);
        }
    }
    out
}

#[cfg(not(target_os = "linux"))]
fn legacy_pids() -> Vec<u32> {
    vec![]
}

/// Warn when the running daemon is not the binary the user just invoked, which is
/// what happens after an upgrade: the old process keeps serving the old code.
fn warn_if_stale(h: &Value) {
    let running = h.get("version").and_then(Value::as_str).unwrap_or("");
    if !running.is_empty() && running != crate::server::VERSION {
        eprintln!(
            "note: snyvi {running} is still running but this binary is {}. Run `snyvi restart` to pick up the new version.",
            crate::server::VERSION
        );
    }
}

/// Make sure a daemon is listening; spawn one detached if not.
pub fn ensure_daemon() -> Result<()> {
    if let Some(h) = health() {
        warn_if_stale(&h);
        return Ok(());
    }
    if port_answers() {
        bail!(
            "something is listening on {} and it is not a snyvi daemon. Another program holds port {}; set SNYVI_PORT to a free one (for every snyvi command, or in the service) and try again",
            config::base_url(),
            config::port()
        );
    }
    let exe = std::env::current_exe().context("locating snyvi binary")?;
    crate::platform::spawn_daemon(&exe).context("starting snyvi daemon")?;
    // A daemon is listening about 25 ms after it is started -- it reads a
    // 438 KB grammar dump and opens the database first -- and this used to ask
    // every 40 ms, so the first answer came at 40 and a cold `snyvi app` waited
    // about twice as long as it needed to. Ask sooner, then back off, so a
    // machine slow enough to need the four seconds is not asked 800 times for
    // them.
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut wait = Duration::from_millis(5);
    while Instant::now() < deadline {
        if health().is_some() {
            announce_start();
            return Ok(());
        }
        std::thread::sleep(wait);
        wait = (wait * 2).min(Duration::from_millis(80));
    }
    if port_answers() {
        bail!(
            "the daemon started but something else answers on {}; another program took port {}. Set SNYVI_PORT to a free one",
            config::base_url(),
            config::port()
        );
    }
    bail!(
        "the snyvi daemon did not come up on {} within 4 s. Run `snyvi serve` in a terminal to see why",
        config::base_url()
    )
}

/// Whether anything at all accepts a connection on our port. Health has
/// already said no when this is asked, so a yes is another program, and the
/// daemon about to be started would die on bind with nothing to say.
fn port_answers() -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], config::port()));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Said once, by the command that started the daemon, and only to a person:
/// the first `send` prints a link and nothing else, and a newcomer has no way
/// to know a process was left behind, where it listens, or how to end it. A
/// hook or a script has no terminal on stderr and hears nothing.
fn announce_start() {
    use std::io::IsTerminal;
    if std::io::stderr().is_terminal() {
        eprintln!(
            "snyvi started at {} and stays running in the background; `snyvi stop` ends it",
            config::base_url()
        );
    }
}

pub fn send(paths: &Paths, payload: &Payload) -> Result<Value> {
    ensure_daemon()?;
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    let mut resp = ureq::post(&format!("{}/api/docs", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .send_json(payload)
        .context("sending to snyvi")?;
    let status = resp.status().as_u16();
    let body: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
    if status >= 300 {
        bail!(
            "snyvi refused the document ({status}): {}",
            body.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown error")
        );
    }
    Ok(body)
}

/// Register a folder with the daemon and return the page that shows it.
pub fn browse(paths: &Paths, dir: &str) -> Result<String> {
    ensure_daemon()?;
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    let mut resp = ureq::post(&format!("{}/api/browse", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .send_json(serde_json::json!({ "path": dir }))
        .context("opening the folder in snyvi")?;
    let status = resp.status().as_u16();
    let body: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
    if status >= 300 {
        bail!(
            "snyvi could not browse that folder ({status}): {}",
            body.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown error")
        );
    }
    Ok(body
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

pub fn open_in_browser(url: &str) {
    if !crate::platform::open_url(url) {
        eprintln!("snyvi: no browser could be opened from here; open this yourself:\n  {url}");
    }
}

/// Open a link where the reader is: the native window if one is up, and the
/// browser otherwise.
///
/// A window that is running is the whole viewer, so a second copy of the page
/// in a browser beside it is not another view of the library, it is the reader
/// losing the one they were using. The daemon says on /api/health whether a
/// window's page is connected; the window's own single-instance handling does
/// the rest -- it navigates and comes forward.
pub fn open_where_the_reader_is(url: &str) {
    if window_is_up() && crate::desktop::hand_to_window(url) {
        return;
    }
    open_in_browser(url);
}

/// Tell the daemon this agent is here, for as long as it is.
///
/// A thread holds an event stream on the daemon under the agent's name, the
/// way the window's page holds one with a mark on it, and the daemon counts
/// it for exactly as long as the stream lasts. The MCP server otherwise
/// speaks to the daemon only when it sends, so before this the daemon could
/// say of an agent that it had sent twelve minutes ago and nothing about
/// whether its session was still open. The thread dies with the process --
/// the agent closing its end of stdin ends the process, and the stream with
/// it -- so it is never a count that outlives what it counts.
///
/// No daemon: try again every few seconds. A connection refused is cheap,
/// even from ten of these at once, and the first send starts a daemon, which
/// the next try finds. A daemon that stops ends the stream, so the one that
/// takes the port next is found the same way.
pub fn hold_presence(name: String) {
    let url = format!(
        "{}/api/events?agent={}",
        config::base_url(),
        crate::browse::urlencode(&name)
    );
    let _ = std::thread::Builder::new()
        .name("presence".into())
        .spawn(move || loop {
            let held = ureq::get(&url)
                .config()
                .timeout_connect(Some(Duration::from_secs(2)))
                .build()
                .call();
            if let Ok(mut resp) = held {
                // Read until the daemon ends the stream. What is read is the
                // library's events, which this process has no use for.
                let _ = std::io::copy(&mut resp.body_mut().as_reader(), &mut std::io::sink());
            }
            std::thread::sleep(Duration::from_secs(3));
        });
}

/// Mint a capability for a window that is about to open: 32 bytes the daemon
/// remembers, which the page will present to be allowed panes.
///
/// It lives here rather than in the window's own executable because minting
/// takes the write token, and `snyvi-app` links none of this crate and reads
/// none of snyvi's files -- which is the point of it being separate. So the
/// one process that holds both the token and the launch is this one.
///
/// `None` is not a failure to handle: no token, no daemon, or a daemon too old
/// to know the endpoint all mean a window that opens and reads exactly as it
/// always has, without panes.
pub fn mint_capability(paths: &Paths) -> Option<String> {
    let token = config::read_token(paths)?;
    let mut resp = ureq::post(&format!("{}/api/capability", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .send_empty()
        .ok()?;
    if resp.status().as_u16() >= 300 {
        return None;
    }
    resp.body_mut()
        .read_json::<Value>()
        .ok()?
        .get("capability")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Whether the daemon has a window's page connected. False when there is no
/// daemon to ask, or when it is old enough not to answer -- both of which mean
/// a browser, which is what the caller then does.
pub fn window_is_up() -> bool {
    health()
        .and_then(|h| h.get("window").and_then(Value::as_bool))
        .unwrap_or(false)
}
