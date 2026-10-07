//! Talk to the running daemon from the CLI and the MCP server; start it if needed.

use crate::config::{self, Paths};
use crate::receive::Payload;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

/// The one HTTP agent this process talks to the daemon with.
///
/// `ureq::get` and `ureq::post` build an agent per call, and an agent's
/// resolver, asked with a timeout set -- which every call here sets --
/// spawns a thread to do the lookup it can abort. The daemon is only ever
/// at `127.0.0.1`, which is not a lookup at all; `Loopback` says so and the
/// thread is never started. One agent is also one connection pool, so the
/// two requests a hook makes in a row share a socket. Each call still sets
/// its own timeout, on the request (`.config()`), as it always did.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::with_parts(
        ureq::config::Config::builder().build(),
        ureq::unversioned::transport::DefaultConnector::default(),
        Loopback,
    )
});

fn agent() -> &'static ureq::Agent {
    &AGENT
}

/// A resolver that answers an IP literal from the string, and leaves every
/// other host to ureq's own. ureq's default resolves `127.0.0.1` through
/// `getaddrinfo` on a thread of its own whenever a timeout is set, which was
/// one `clone3` per hook call, on every prompt and tool call of a session.
#[derive(Debug)]
struct Loopback;

impl ureq::unversioned::resolver::Resolver for Loopback {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: ureq::unversioned::transport::NextTimeout,
    ) -> std::result::Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let literal = uri.host().and_then(|h| {
            h.trim_matches(|c| c == '[' || c == ']')
                .parse::<std::net::IpAddr>()
                .ok()
        });
        let port = uri.port_u16().or_else(|| match uri.scheme_str() {
            Some("http") => Some(80),
            Some("https") => Some(443),
            _ => None,
        });
        if let (Some(ip), Some(port)) = (literal, port) {
            let mut out = self.empty();
            out.push(std::net::SocketAddr::new(ip, port));
            return Ok(out);
        }
        ureq::unversioned::resolver::DefaultResolver::default().resolve(uri, config, timeout)
    }
}

pub fn health() -> Option<Value> {
    agent()
        .get(&format!("{}/api/health", config::base_url()))
        .config()
        .timeout_global(Some(Duration::from_millis(400)))
        .build()
        .call()
        .ok()?
        .body_mut()
        .read_json::<Value>()
        .ok()
}

/// The header the window secret rides in, and its value: the daemon's own
/// file, or nothing when there is none to read. Sent beside the token on
/// what stops, restarts, updates or mints -- a daemon from 1.13 on answers
/// to this one and no longer to the token there; an older daemon reads the
/// token and ignores this. `config::load_or_create_window_secret` says why.
const WINDOW_HEADER: &str = "x-snyvi-window";
fn window_secret(paths: &Paths) -> String {
    config::read_window_secret(paths).unwrap_or_default()
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
        let _ = agent()
            .post(&format!("{}/api/shutdown", config::base_url()))
            .header("Authorization", &format!("Bearer {token}"))
            .header(WINDOW_HEADER, &window_secret(paths))
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
    if !running.is_empty() && running != crate::version::VERSION {
        eprintln!(
            "note: snyvi {running} is still running but this binary is {}. Run `snyvi restart` to pick up the new version.",
            crate::version::VERSION
        );
    } else if h.get("stale").and_then(Value::as_bool) == Some(true) {
        // Same version, different file: the daemon re-stats what it was
        // started from. An `apt upgrade` to the same number, a rebuild, a
        // copy by hand -- whichever, the process is not the file any more.
        eprintln!(
            "note: the snyvi binary on disk has changed since the daemon started. Run `snyvi restart` to pick it up."
        );
    }
}

/// `snyvi restart`: ask the daemon to restart itself and wait for it to come
/// back. The daemon waits for its panes to be quiet unless `now`; while it
/// waits, this says which panels it is waiting on, and Ctrl-C calls the
/// restart off. A daemon too old to have the route is stopped and started
/// the old way, and no daemon at all is simply started.
pub fn restart(paths: &Paths, now: bool) -> Result<()> {
    let Some(h) = health() else {
        ensure_daemon()?;
        return print_running();
    };
    let was = h.get("pid").and_then(Value::as_u64);
    let Some(token) = config::read_token(paths) else {
        bail!(
            "no token in {}; is this the same user the daemon runs as?",
            paths.config_dir.display()
        );
    };
    let asked = agent()
        .post(&format!("{}/api/restart", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .header(WINDOW_HEADER, &window_secret(paths))
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .send_json(serde_json::json!({ "when": if now { "now" } else { "idle" } }));
    match asked {
        Ok(r) if r.status() == 404 || r.status() == 405 => {
            // Before 1.7.0 there was no restart route: the old stop, then
            // a start from this binary.
            stop(paths)?;
            ensure_daemon()?;
            return print_running();
        }
        Ok(r) if r.status().is_success() => {}
        Ok(mut r) => bail!(
            "the daemon refused the restart: {} {}",
            r.status(),
            r.body_mut().read_to_string().unwrap_or_default().trim()
        ),
        Err(e) => bail!("asking the daemon to restart: {e}"),
    }
    wait_for_another(paths, was)
}

/// `snyvi restart --cancel`, and Ctrl-C while a restart waits: the restart
/// the daemon is holding for quiet panels is called off. True when there
/// was one.
fn send_cancel(paths: &Paths) -> Result<bool> {
    let Some(token) = config::read_token(paths) else {
        bail!(
            "no token in {}; is this the same user the daemon runs as?",
            paths.config_dir.display()
        );
    };
    let r = ureq::delete(&format!("{}/api/restart", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .header(WINDOW_HEADER, &window_secret(paths))
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .call();
    match r {
        Ok(mut r) if r.status().is_success() => Ok(r
            .body_mut()
            .read_json::<Value>()
            .ok()
            .and_then(|j| j["cancelled"].as_bool())
            .unwrap_or(false)),
        Ok(r) if r.status() == 404 || r.status() == 405 => bail!(
            "this daemon is too old to call a restart off; it restarts when the panels are quiet"
        ),
        Ok(mut r) => bail!(
            "the daemon refused: {} {}",
            r.status(),
            r.body_mut().read_to_string().unwrap_or_default().trim()
        ),
        Err(e) => bail!("asking the daemon: {e}"),
    }
}

pub fn cancel_restart(paths: &Paths) -> Result<()> {
    if health().is_none() {
        println!("not running");
        return Ok(());
    }
    if send_cancel(paths)? {
        println!("the restart is called off");
    } else {
        println!("no restart was waiting");
    }
    Ok(())
}

/// While this waits on a restart, Ctrl-C calls it off rather than leaving
/// it to happen behind the reader's back. Once the old daemon has gone
/// there is nothing to call off, and Ctrl-C only stops the waiting.
fn cancel_on_ctrl_c(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        if rt.block_on(tokio::signal::ctrl_c()).is_err() {
            return;
        }
        eprintln!();
        match send_cancel(&paths) {
            Ok(true) => eprintln!("the restart is called off"),
            Ok(false) => eprintln!("the restart is already under way"),
            Err(e) => eprintln!("{e:#}"),
        }
        std::process::exit(130);
    });
}

/// Watch health until a process other than `was` answers, saying which
/// panels are holding it up while it waits. By pid rather than version: the
/// point of a restart may be a file that says the same number.
fn wait_for_another(paths: &Paths, was: Option<u64>) -> Result<()> {
    cancel_on_ctrl_c(paths);
    let mut said: Option<usize> = None;
    let mut gone_since: Option<Instant> = None;
    let mut given_up = 0;
    loop {
        match health() {
            Some(h) if h.get("pid").and_then(Value::as_u64) != was => {
                if said.is_some() {
                    eprintln!();
                }
                return print_running();
            }
            Some(h) => {
                gone_since = None;
                // Nothing pending and not on its way out, and still the same
                // process: the daemon took the restart and gave it up -- an
                // update that would not go in, nothing to go back to. Twice,
                // a quarter of a second apart, so a look between the two
                // flags is not taken for it. Only a daemon that says
                // `restarting` at all (1.7.1 on) can be read this way.
                let restarting = h["update"].get("restarting").and_then(Value::as_bool);
                given_up = if h["restart"].is_null() && restarting == Some(false) {
                    given_up + 1
                } else {
                    0
                };
                if given_up >= 2 {
                    if said.is_some() {
                        eprintln!();
                    }
                    match h["update"]["error"].as_str().filter(|e| !e.is_empty()) {
                        Some(e) => bail!("the daemon did not restart: {e}"),
                        None => bail!("the daemon did not restart; its log says why"),
                    }
                }
                let waiting = h["restart"]["waiting_on"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0);
                if waiting > 0 && said != Some(waiting) {
                    eprintln!(
                        "waiting on {waiting} panel{} still busy (an agent mid-turn or waiting on you, or a program printing)… --now skips the wait; Ctrl-C calls the restart off",
                        if waiting == 1 { "" } else { "s" }
                    );
                    said = Some(waiting);
                }
            }
            None => {
                // The old one has gone; the new one is on its way. Under
                // systemd that is two seconds; by hand, about 25 ms.
                let since = *gone_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(15) {
                    bail!(
                        "the daemon went down for the restart but nothing came back on {} in 15 s. Run `snyvi serve` in a terminal to see why",
                        config::base_url()
                    );
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

// ---------- snyvi update ----------

pub struct UpdateOpts {
    pub now: bool,
    pub to: Option<String>,
    pub back: bool,
}

/// A POST with the token, the status left to the caller.
fn post(paths: &Paths, path: &str, body: Value, within: Duration) -> Result<(u16, Value)> {
    let Some(token) = config::read_token(paths) else {
        bail!(
            "no token in {}; is this the same user the daemon runs as?",
            paths.config_dir.display()
        );
    };
    let mut r = agent()
        .post(&format!("{}{path}", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .header(WINDOW_HEADER, &window_secret(paths))
        .config()
        .timeout_global(Some(within))
        .http_status_as_error(false)
        .build()
        .send_json(body)
        .with_context(|| format!("asking the daemon ({path})"))?;
    let status = r.status().as_u16();
    let json = r.body_mut().read_json::<Value>().unwrap_or(Value::Null);
    Ok((status, json))
}

/// `snyvi update`: the daemon checks, stages, and restarts onto what it
/// staged when the panels are quiet. Each step is printed. A told-only
/// install (a `.deb`, a cargo build) is told the command instead.
pub fn update(paths: &Paths, o: UpdateOpts) -> Result<()> {
    ensure_daemon()?;
    let was = health().and_then(|h| h.get("pid").and_then(Value::as_u64));
    if o.back {
        let (status, j) = post(
            paths,
            "/api/restart",
            serde_json::json!({ "when": if o.now { "now" } else { "idle" }, "back": true }),
            Duration::from_secs(5),
        )?;
        match status {
            200..=299 => {
                eprintln!(
                    "putting the previous version back, and restarting onto it{}",
                    if o.now {
                        " now"
                    } else {
                        " when the panels are quiet"
                    }
                );
                return wait_for_another(paths, was);
            }
            404 | 405 => bail!("the daemon is too old to go back; `snyvi restart` first"),
            _ => bail!("{}", j["error"].as_str().unwrap_or("the daemon refused")),
        }
    }
    eprintln!("checking…");
    let (status, j) = post(
        paths,
        "/api/update/check",
        serde_json::json!({ "to": o.to }),
        Duration::from_secs(600),
    )?;
    match status {
        200..=299 => {}
        404 | 405 => bail!("the daemon is {} and has no updater; install a newer snyvi by hand and run `snyvi restart`", health().and_then(|h| h["version"].as_str().map(str::to_string)).unwrap_or_default()),
        _ => bail!("{}", j["error"].as_str().unwrap_or("the check failed")),
    }
    let running = j["running"].as_str().unwrap_or("?");
    let latest = j["latest"].as_str().unwrap_or("?");
    let newer = j["newer"].as_bool().unwrap_or(false);
    if !newer && o.to.is_none() {
        println!("snyvi {running} is the latest");
        return Ok(());
    }
    if j["told"].as_bool().unwrap_or(false) {
        println!("{latest} is out; you are on {running}. This install is updated by hand:");
        for line in j["update"]["how"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            println!("  {line}");
        }
        return Ok(());
    }
    let Some(ready) = j["ready"].as_str() else {
        if j["update"]["failed"].as_str() == Some(latest) {
            bail!("{latest} is out, but it was applied here before and did not start, so it is not staged again on its own; `snyvi update --to {latest}` tries it again");
        }
        if j["update"]["skipped"].as_str() == Some(latest) {
            bail!("{latest} is out, but you went back from it, so it is not staged again on its own; `snyvi update --to {latest}` takes it again");
        }
        bail!(
            "{latest} is out but nothing was staged: {}",
            j["update"]["error"].as_str().unwrap_or("no reason given")
        );
    };
    if let (Some(to), Some(skipped)) = (&o.to, j["update"]["skipped"].as_str()) {
        if semver::Version::parse(to).ok() < semver::Version::parse(running).ok() {
            eprintln!("{skipped} will not come back on its own; `snyvi update` takes it, or whatever is newest, again");
        }
    }
    eprintln!(
        "{ready} is staged and verified; restarting onto it{}",
        if o.now {
            " now"
        } else {
            " when the panels are quiet"
        }
    );
    let (status, j) = post(
        paths,
        "/api/restart",
        serde_json::json!({ "when": if o.now { "now" } else { "idle" }, "apply": true }),
        Duration::from_secs(5),
    )?;
    if !(200..=299).contains(&status) {
        bail!(
            "{}",
            j["error"]
                .as_str()
                .unwrap_or("the daemon refused the restart")
        );
    }
    wait_for_another(paths, was)
}

/// `snyvi update check`: true when a newer version is out, and nothing is
/// restarted. The daemon stages what it finds, as it would on its own timer.
pub fn update_check(paths: &Paths) -> Result<bool> {
    ensure_daemon()?;
    // Read fresh, and found without lifting the daily floor: a script
    // asking every hour must not turn a day's pace into an hour's.
    let (status, j) = post(
        paths,
        "/api/update/check",
        serde_json::json!({ "lift": false }),
        Duration::from_secs(600),
    )?;
    match status {
        200..=299 => {}
        404 | 405 => bail!("the daemon is too old to check"),
        _ => bail!("{}", j["error"].as_str().unwrap_or("the check failed")),
    }
    let running = j["running"].as_str().unwrap_or("?");
    let latest = j["latest"].as_str().unwrap_or("?");
    let newer = j["newer"].as_bool().unwrap_or(false);
    if newer {
        println!(
            "{latest} is out; this is {running}{}",
            if j["ready"].is_string() {
                ", and it is staged"
            } else {
                ""
            }
        );
    } else {
        println!("{running} is the latest");
    }
    Ok(newer)
}

/// `snyvi update on|off`: through the daemon when one is up, so About
/// changes with it; else the file it reads at its next start.
pub fn update_auto(paths: &Paths, on: bool) -> Result<()> {
    if health().is_some() {
        let (status, j) = post(
            paths,
            "/api/update/auto",
            serde_json::json!({ "on": on }),
            Duration::from_secs(5),
        )?;
        if !(200..=299).contains(&status) {
            bail!("{}", j["error"].as_str().unwrap_or("the daemon refused"));
        }
        if j["update"]["env_off"].as_bool() == Some(true) && on {
            println!(
                "automatic updates stay off: SNYVI_UPDATES=off is set in the daemon's environment"
            );
            return Ok(());
        }
    } else {
        std::fs::create_dir_all(&paths.config_dir)?;
        std::fs::write(
            paths.config_dir.join("updates.json"),
            format!("{{ \"auto\": {on} }}\n"),
        )?;
    }
    println!(
        "automatic updates are {}",
        if on {
            "on: checked a few times a day, applied once a day at a quiet moment"
        } else {
            "off; `snyvi update` still works when you ask"
        }
    );
    Ok(())
}

/// The one line `snyvi status` adds, from health's `update` block.
pub fn update_line(u: &Value) -> Option<String> {
    let s = |k: &str| u[k].as_str().map(str::to_string);
    Some(if let Some(v) = s("failed") {
        format!("update: {v} was applied and did not start; the previous version was kept. `snyvi update --to {v}` tries again")
    } else if let Some(v) = s("ready") {
        if u["slot_open"].as_bool() == Some(true) {
            format!(
                "update: {v} is ready; it applies at the next quiet moment, or now: snyvi update"
            )
        } else {
            format!("update: {v} is ready; it applies in the next day when the desks are quiet, or now: snyvi update")
        }
    } else if let Some(v) = s("skipped").filter(|v| s("available").is_none_or(|a| a == *v)) {
        format!("update: you went back from {v}; it is not taken again on its own. `snyvi update --to {v}` takes it")
    } else if let Some(v) = s("available") {
        let how = u["how"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" && ");
        format!("update: {v} is out; this install is updated by hand: {how}")
    } else if let Some(e) = s("error") {
        format!("update: the last check failed: {e}")
    } else if u["checked"].is_i64() {
        format!(
            "update: on the latest as of the last check{}",
            if u["auto"].as_bool() == Some(false) {
                " (automatic updates off)"
            } else {
                ""
            }
        )
    } else if u["channel"].as_str() == Some("dev") {
        return None;
    } else {
        "update: not checked yet".to_string()
    })
}

fn print_running() -> Result<()> {
    let v = health()
        .and_then(|h| h.get("version").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    println!("snyvi {v} running on {}", config::base_url());
    Ok(())
}

/// Make sure a daemon is listening; spawn one detached if not.
/// A planned restart's marker, written moments ago: the daemon went on
/// purpose and its successor has not taken the port yet (it drops the
/// marker once it has). See `server::leave_for_restart`.
fn restart_under_way() -> bool {
    let Ok(text) = std::fs::read_to_string(config::paths().data_dir.join("restart.json")) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["at"].as_i64())
        .is_some_and(|at| (crate::store::now() - at).abs() < 30)
}

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
    // A planned restart is under way: the successor is on its way, and a
    // second `snyvi serve` started now would race it for the port -- and
    // count as one of its tries to come up (`update::first_start`).
    if restart_under_way() {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if health().is_some() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let exe = std::env::current_exe().context("locating snyvi binary")?;
    // A file an update renamed over, under a process still running from it,
    // reads as `… (deleted)` on Linux; the name holds the new file now.
    let exe = match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(live) if !exe.exists() => std::path::PathBuf::from(live),
        _ => exe,
    };
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
    send_within(paths, payload, Duration::from_secs(30))
}

/// A send from a hook that must not start a daemon or wait long: a plan
/// (`crate::hook::send_plan`). Nothing is sent when no daemon is up.
pub fn send_quick(paths: &Paths, payload: &Payload, within: Duration) -> Result<Value> {
    send_within(paths, payload, within)
}

fn send_within(paths: &Paths, payload: &Payload, within: Duration) -> Result<Value> {
    // Inside a snyvi pane, what is sent says so. Every transport -- `send`,
    // `watch`, the hook, the MCP server -- comes through here, and each one
    // started in a pane inherited the variable from it.
    let mut payload = payload.clone();
    if payload.pane.is_none() {
        payload.pane = std::env::var("SNYVI_SESSION")
            .ok()
            .filter(|v| crate::pane::valid_id(v));
    }
    let payload = &payload;
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    let mut resp = agent()
        .post(&format!("{}/api/docs", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(within))
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

/// Tell the daemon what the agent in a pane is doing, and which conversation
/// it is, when the event says. Quiet, and quick: this
/// runs inside a Claude Code hook, on every prompt and tool call, so it never
/// starts a daemon, never waits more than half a second, and a daemon that is
/// not there means no status, and nothing more.
pub fn agent_state(paths: &Paths, pane: &str, state: Option<&str>, session: Option<&str>) {
    let Some(token) = config::read_token(paths) else {
        return;
    };
    let _ = agent()
        .post(&format!("{}/api/panes/{pane}/agent", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_millis(500)))
        .http_status_as_error(false)
        .build()
        .send_json(serde_json::json!({ "state": state, "session": session }));
}

/// What Claude's status line said, for the panel it runs in: the model, how
/// full the context window is, and the conversation, which keeps the pane's
/// saved id current after a `/resume` inside one Claude. The same route and
/// the same short wait as `agent_state`: it runs after every reply.
pub fn agent_context(paths: &Paths, pane: &str, seen: &crate::statusline::Seen) {
    let Some(token) = config::read_token(paths) else {
        return;
    };
    let _ = agent()
        .post(&format!("{}/api/panes/{pane}/agent", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_millis(500)))
        .http_status_as_error(false)
        .build()
        .send_json(serde_json::json!({
            "session": seen.session,
            "model": seen.model,
            "ctx": {
                "pct": seen.pct,
                "size": seen.size,
                "input": seen.input,
                "used": seen.used,
            },
            "limits": { "five_hour": seen.five_hour, "seven_day": seen.seven_day },
        }));
}

/// The notes of the desk `pane` is on, read and never written. It never starts
/// a daemon: a pane only runs while one does, so none answering means the
/// shell this came from is already gone.
pub fn desk_notes(paths: &Paths, pane: &str) -> Result<Value> {
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    let mut resp = agent()
        .get(&format!("{}/api/panes/{pane}/notes", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .call()
        .context("asking snyvi")?;
    match resp.status().as_u16() {
        200 => Ok(resp.body_mut().read_json()?),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// Tick a line on the list of the desk this pane is on, as `by`, with the
/// commit the work went into and a document about it when there are those.
pub fn tick_desk_note(
    paths: &Paths,
    pane: &str,
    note: i64,
    by: &str,
    commit: &str,
    about: &str,
    evidence: &str,
) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/notes/{note}/tick"),
        serde_json::json!({ "by": by, "commit": commit, "about": about, "evidence": evidence }),
    )?;
    match resp.status().as_u16() {
        200 => Ok(resp.body_mut().read_json()?),
        409 => bail!("there is no open note with id {note} on this desk -- read_desk_notes lists them, and a note already done stays done"),
        400 => bail!("{}", said(&mut resp)),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// Say how far this agent has got with a note on its pane's desk:
/// `mark_desk_note`. `about` is the plan's document id, needed with `planned`.
pub fn mark_desk_note(
    paths: &Paths,
    pane: &str,
    note: i64,
    stage: &str,
    by: &str,
    about: &str,
) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/notes/{note}/mark"),
        serde_json::json!({ "stage": stage, "by": by, "about": about }),
    )?;
    match resp.status().as_u16() {
        200 => Ok(resp.body_mut().read_json()?),
        409 => bail!("there is no open note with id {note} on this desk -- read_desk_notes lists them, and a done note has no stage"),
        400 => bail!("{}", said(&mut resp)),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// Name the panel this pane is: what the reader sees in its head and on the
/// desk's rail. Empty gives it back to its program's title.
pub fn name_panel(paths: &Paths, pane: &str, name: &str) -> Result<()> {
    let resp = pane_post(
        paths,
        &format!("{pane}/name"),
        serde_json::json!({ "name": name }),
    )?;
    match resp.status().as_u16() {
        200 => Ok(()),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// What the daemon says to a Claude in a pane, for a hook to hand on: the
/// context, the title its session takes (`crate::brief::title`) and the
/// desk's name, which every title snyvi gives starts with. Any of them empty
/// when there is nothing to say.
pub struct Said {
    pub context: String,
    pub title: String,
    pub desk: String,
    /// Whether the daemon took the agent's state and session from the same
    /// request (1.17 on). One from before read the question alone, and the
    /// hook tells it the state the old way, in a request of its own.
    pub applied: bool,
}

fn said_by(v: &Value) -> Said {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Said {
        context: s("context"),
        title: s("title"),
        desk: s("desk"),
        applied: v.get("state").is_some(),
    }
}

/// The query that carries what the hook says about its agent along with
/// what it asks: `pane_agent`'s two fields, so the asking is one request.
fn agent_query(state: Option<&str>, session: Option<&str>) -> String {
    let mut q = String::new();
    for (k, v) in [("state", state), ("session", session)] {
        if let Some(v) = v {
            q.push(if q.is_empty() { '?' } else { '&' });
            q.push_str(k);
            q.push('=');
            q.push_str(&crate::browse::urlencode(v));
        }
    }
    q
}

/// The desk brief for a Claude starting in this pane (`crate::brief`), and
/// the session the hook names, told in the same request.
/// Asked from the SessionStart hook, which Claude's first reply waits on, so
/// on `agent_state`'s terms: never starts a daemon, half a second at most,
/// and nothing at all on any failure.
pub fn brief(paths: &Paths, pane: &str, session: Option<&str>) -> Option<Said> {
    let token = config::read_token(paths)?;
    let mut resp = agent()
        .get(&format!(
            "{}/api/panes/{pane}/brief{}",
            config::base_url(),
            agent_query(None, session)
        ))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_millis(500)))
        .http_status_as_error(false)
        .build()
        .call()
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let v: Value = resp.body_mut().read_json().ok()?;
    Some(said_by(&v))
}

/// What changed on this pane's desk since snyvi last spoke to its agent
/// (`crate::brief::changes`), for the UserPromptSubmit hook to hand Claude
/// with the prompt, and the session's title as the panel's name now has it;
/// what the prompt says about the agent -- `working`, and its session --
/// goes in the same request.
/// The context is empty when nothing changed, and `None` when there is no
/// daemon, no token, or no answer in half a second: the prompt never waits.
pub fn changes(
    paths: &Paths,
    pane: &str,
    state: Option<&str>,
    session: Option<&str>,
) -> Option<Said> {
    let token = config::read_token(paths)?;
    let mut resp = agent()
        .get(&format!(
            "{}/api/panes/{pane}/changes{}",
            config::base_url(),
            agent_query(state, session)
        ))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_millis(500)))
        .http_status_as_error(false)
        .build()
        .call()
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let v: Value = resp.body_mut().read_json().ok()?;
    v.get("context")?.as_str()?;
    Some(said_by(&v))
}

/// Say where the work on this pane's desk was left: `leave_off`.
pub fn leave_off(paths: &Paths, pane: &str, text: &str, about: &str, by: &str) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/leftoff"),
        serde_json::json!({ "text": text, "about": about, "by": by }),
    )?;
    match resp.status().as_u16() {
        200 => Ok(resp.body_mut().read_json()?),
        400 => bail!("{}", said(&mut resp)),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// Suggest a line for this pane's desk's list: `suggest_desk_note`.
pub fn suggest_desk_note(paths: &Paths, pane: &str, text: &str, by: &str) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/suggest"),
        serde_json::json!({ "text": text, "by": by }),
    )?;
    match resp.status().as_u16() {
        201 => Ok(resp.body_mut().read_json()?),
        400 | 409 => bail!("{}", said(&mut resp)),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// A thread, a turn or a suggestion from this pane (`crate::thread`): the
/// six #90 tools share one shape of answer, so they share one call.
/// `path` is the pane route after the id: `thread`, `ask`, `suggest-panel`.
pub fn pane_thread(paths: &Paths, pane: &str, path: &str, body: Value) -> Result<Value> {
    let mut resp = pane_post(paths, &format!("{pane}/{path}"), body)?;
    match resp.status().as_u16() {
        200 | 201 => Ok(resp.body_mut().read_json()?),
        400 | 409 => bail!("{}", said(&mut resp)),
        404 => {
            bail!("snyvi has no running pane by this id (or the daemon is older than this tool)")
        }
        s => bail!("snyvi answered {s}"),
    }
}

/// Whether the reader has a friend on the list, for `tools/list`: `None`
/// when the daemon did not answer in time, which lists `offer_document` as
/// before rather than hiding it on a slow start.
pub fn has_friends() -> Option<bool> {
    let v: Value = agent()
        .get(&format!("{}/api/peers", config::base_url()))
        .config()
        .timeout_global(Some(Duration::from_millis(400)))
        .build()
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()?;
    Some(
        v.get("friends")?
            .as_array()?
            .iter()
            .any(|f| f.get("removed_at").is_none()),
    )
}

/// Offer a document to a friend, from this pane: `offer_document`. The
/// daemon writes the question for the reader and sends nothing.
pub fn offer_document(paths: &Paths, pane: &str, to: &str, id: &str, by: &str) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/offer"),
        serde_json::json!({ "to": to, "doc": id, "by": by }),
    )?;
    match resp.status().as_u16() {
        201 => Ok(resp.body_mut().read_json()?),
        400 | 404 | 409 => bail!("{}", said(&mut resp)),
        s => bail!("snyvi answered {s}"),
    }
}

/// Offer a line to a friend, from this pane: `offer_line`. As with a
/// document, the reader decides whether it goes.
pub fn offer_line(paths: &Paths, pane: &str, to: &str, text: &str, by: &str) -> Result<Value> {
    let mut resp = pane_post(
        paths,
        &format!("{pane}/offer"),
        serde_json::json!({ "to": to, "text": text, "by": by }),
    )?;
    match resp.status().as_u16() {
        201 => Ok(resp.body_mut().read_json()?),
        400 | 404 | 409 => bail!("{}", said(&mut resp)),
        s => bail!("snyvi answered {s}"),
    }
}

/// The value of one of this panel's desk's keys, for `snyvi key NAME`: the
/// panel is `SNYVI_SESSION`, which only a snyvi panel has, so the command
/// works there and nowhere else.
pub fn key(paths: &Paths, name: &str) -> Result<String> {
    let pane = std::env::var("SNYVI_SESSION")
        .ok()
        .filter(|p| crate::pane::valid_id(p))
        .ok_or_else(|| anyhow!("snyvi key works inside a snyvi panel; this shell is not one"))?;
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    let mut resp = agent()
        .get(&format!(
            "{}/api/panes/{pane}/keys/{name}",
            config::base_url()
        ))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .call()
        .context("asking snyvi")?;
    match resp.status().as_u16() {
        200 => Ok(resp.body_mut().read_to_string()?),
        400 => bail!("{}", said(&mut resp)),
        // A 404 with no word of its own is the pane, not the key.
        404 => match said(&mut resp) {
            s if s == "snyvi refused it" => bail!(
                "snyvi has no running panel by this id (or the daemon is older than this command)"
            ),
            s => bail!("{s}"),
        },
        s => bail!("snyvi answered {s}"),
    }
}

/// A write an agent makes on its own pane, `/api/panes/{path}`, with the token.
fn pane_post(paths: &Paths, path: &str, body: Value) -> Result<ureq::http::Response<ureq::Body>> {
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    agent()
        .post(&format!("{}/api/panes/{path}", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .send_json(body)
        .context("asking snyvi")
}

/// The `error` a refusal carries, or a word for one that carries none.
fn said(resp: &mut ureq::http::Response<ureq::Body>) -> String {
    resp.body_mut()
        .read_json::<Value>()
        .ok()
        .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "snyvi refused it".to_string())
}

/// Leave an aside at the foot of the sidebar.
pub fn aside(paths: &Paths, aside: &crate::aside::NewAside) -> Result<Value> {
    ensure_daemon()?;
    let token = config::read_token(paths).ok_or_else(|| {
        anyhow!(
            "no token at {}; is the daemon running as this user?",
            paths.token_path.display()
        )
    })?;
    // The route keeps the name it had before the tool was `send_aside`, so an
    // MCP server from either side of the rename reaches a daemon from the other.
    let mut resp = agent()
        .post(&format!("{}/api/notes", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .send_json(aside)
        .context("sending to snyvi")?;
    let status = resp.status().as_u16();
    let body: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
    if status >= 300 {
        bail!(
            "{}",
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
    let mut resp = agent()
        .post(&format!("{}/api/browse", config::base_url()))
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
            let held = agent()
                .get(&url)
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
    let mut resp = agent()
        .post(&format!("{}/api/capability", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .header(WINDOW_HEADER, &window_secret(paths))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The state and session ride on the brief's and the changes' own
    /// request, encoded, and nothing is sent for a field the event lacks.
    #[test]
    fn the_agent_rides_on_the_question() {
        assert_eq!(agent_query(None, None), "");
        assert_eq!(agent_query(Some("working"), None), "?state=working");
        assert_eq!(
            agent_query(
                Some("needs_you"),
                Some("11111111-2222-4333-8444-555555555555")
            ),
            "?state=needs_you&session=11111111-2222-4333-8444-555555555555"
        );
        assert_eq!(agent_query(Some(""), None), "?state=");
    }

    /// A daemon that took the state says so; one from before 1.17 does not,
    /// and the hook then tells it the old way.
    #[test]
    fn an_answer_says_whether_the_state_was_taken() {
        let new = said_by(&serde_json::json!({ "context": "", "title": "t", "state": "" }));
        assert!(new.applied);
        let old = said_by(&serde_json::json!({ "context": "", "title": "t" }));
        assert!(!old.applied);
        assert_eq!(old.title, "t");
    }

    /// `127.0.0.1` is answered from the string, with no lookup and no thread.
    #[test]
    fn the_loopback_resolver_reads_the_literal() {
        use ureq::unversioned::resolver::Resolver;
        let uri: ureq::http::Uri = "http://127.0.0.1:7777/api/health".parse().unwrap();
        let got = Loopback
            .resolve(
                &uri,
                &ureq::config::Config::builder().build(),
                ureq::unversioned::transport::NextTimeout {
                    after: ureq::unversioned::transport::time::Duration::NotHappening,
                    reason: ureq::Timeout::Global,
                },
            )
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0], "127.0.0.1:7777".parse().unwrap());
    }
}
