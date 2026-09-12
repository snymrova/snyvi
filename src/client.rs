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
    let exe = std::env::current_exe().context("locating snyvi binary")?;
    crate::platform::spawn_daemon(&exe).context("starting snyvi daemon")?;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if health().is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    bail!("snyvi daemon did not come up on {}", config::base_url())
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
        eprintln!("open {url}");
    }
}
