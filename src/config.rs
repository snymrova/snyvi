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
    if let Ok(t) = fs::read_to_string(&paths.token_path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    fs::create_dir_all(&paths.config_dir).context("creating config dir")?;
    let token = random_token()?;
    fs::write(&paths.token_path, &token).context("writing token")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&paths.token_path, fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// Client side: read the token if the daemon has created one.
pub fn read_token(paths: &Paths) -> Option<String> {
    fs::read_to_string(&paths.token_path)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
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
