//! Paths, port, and the local write token.

use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 7777;

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub docs_dir: PathBuf,
    pub db_path: PathBuf,
    pub token_path: PathBuf,
}

pub fn paths() -> Paths {
    let data_dir = std::env::var_os("SNYVI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("snyvi")
        });
    let config_dir = std::env::var_os("SNYVI_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("snyvi")
        });
    Paths {
        docs_dir: data_dir.join("docs"),
        db_path: data_dir.join("snyvi.db"),
        token_path: config_dir.join("token"),
        data_dir,
        config_dir,
    }
}

pub fn port() -> u16 {
    std::env::var("SNYVI_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// Daemon side: create the token on first run.
pub fn load_or_create_token(paths: &Paths) -> Result<String> {
    load_or_create_secret(&paths.token_path, &paths.config_dir)
}

/// Where the window secret lives: beside the token, in a file only its owner
/// reads, made by the daemon on first run like the token is.
pub fn window_secret_path(paths: &Paths) -> PathBuf {
    paths.config_dir.join("window")
}

/// Daemon side: the window secret.
///
/// A second secret with a different job. The token is what an agent holds:
/// it sends documents and asides and speaks for its own panel. This is what
/// the window and the CLI hold: it stops, restarts and updates the daemon
/// and mints a window's capability -- the things that start or end a
/// process. The two sit in the same directory with the same mode, so a local
/// program that reads one can read the other; what the split buys is that a
/// token handed somewhere else (a container the agent runs in, a config
/// file) carries no leave to run anything. See `server::windowed`.
pub fn load_or_create_window_secret(paths: &Paths) -> Result<String> {
    load_or_create_secret(&window_secret_path(paths), &paths.config_dir)
}

/// Client side: the window secret, if the daemon has made one.
pub fn read_window_secret(paths: &Paths) -> Option<String> {
    read_secret(&window_secret_path(paths))
}

fn load_or_create_secret(path: &std::path::Path, dir: &std::path::Path) -> Result<String> {
    if let Some(s) = read_secret(path) {
        return Ok(s);
    }
    fs::create_dir_all(dir).context("creating config dir")?;
    let secret = random_token()?;
    fs::write(path, &secret).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(secret)
}

fn read_secret(path: &std::path::Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// A new token in place of the old one, which is dead from here on. What a
/// reset does, and what a leaked token asks for.
pub fn rotate_token(paths: &Paths) -> Result<String> {
    if paths.token_path.exists() {
        fs::remove_file(&paths.token_path).context("removing the old token")?;
    }
    load_or_create_token(paths)
}

/// Client side: read the token if the daemon has created one.
pub fn read_token(paths: &Paths) -> Option<String> {
    read_secret(&paths.token_path)
}

fn random_token() -> Result<String> {
    // 32 bytes from the OS, hex encoded.
    //
    // This used to read /dev/urandom and fall back to hashing the clock and
    // the pid when it could not be opened. On Windows that file does not
    // exist, so the fallback would have been the only path -- and a token
    // derived from the time and a process id is one an unprivileged program
    // on the same machine can search for. getrandom asks each platform for
    // its own generator and fails rather than returning something weaker.
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| anyhow!("reading random bytes for the token: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}
