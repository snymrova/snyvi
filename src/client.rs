//! Talk to the running daemon from the CLI and the MCP server; start it if needed.

use crate::config::{self, Paths};
use crate::receive::Payload;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::process::{Command, Stdio};
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

/// Make sure a daemon is listening; spawn one detached if not.
pub fn ensure_daemon() -> Result<()> {
    if health().is_some() {
        return Ok(());
    }
    let exe = std::env::current_exe().context("locating snyvi binary")?;
    let mut cmd = Command::new(exe);
    cmd.arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().context("starting snyvi daemon")?;
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
    for opener in ["xdg-open", "open"] {
        if Command::new(opener)
            .arg(url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return;
        }
    }
    eprintln!("open {url}");
}
