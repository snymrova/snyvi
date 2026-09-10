//! Paths, port, and the local write token.

use anyhow::{Context, Result};
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
    let token = random_token();
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

fn random_token() -> String {
    // 32 bytes from the OS, hex encoded. No extra crate needed.
    let mut buf = [0u8; 32];
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let seed = blake3::hash(&(nanos ^ (pid << 64)).to_le_bytes());
    buf.copy_from_slice(seed.as_bytes());
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
