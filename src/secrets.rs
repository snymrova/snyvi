//! Where a desk's key values live. The names are rows in the store
//! (`desk_keys`, see `crate::desk`); the values are in the OS keychain --
//! Keychain on macOS, Credential Manager on Windows -- under the service
//! `snyvi` and the account `<desk id>/<NAME>`, desk 0 for every desk. On
//! Linux, and anywhere the keychain does not answer (a test harness, a box
//! with no credential store), the value goes to a file only its owner can
//! read, beside snyvi's own token, the way `gh` and `aws` keep theirs; the
//! window is told which happened.
//!
//! Linux has no keychain client on purpose. The Secret Service's pure-Rust
//! client is 1.8 MB of D-Bus (measured: 16.6 -> 18.4 MB, over the budget in
//! `crate::bench`), and what it buys is encryption at rest: once the user is
//! logged in, GNOME Keyring and KWallet answer any process of theirs, as the
//! 0600 file does. macOS's Keychain asks per application, so there it earns
//! its bytes. A `secret-tool` subprocess can bring Linux in later at no cost
//! in size, for boxes that have it.
//!
//! A value goes one way: from the reader's paste into the keychain or the
//! file, and from there into a panel's environment at its start, or to
//! `snyvi key NAME` run in a panel of its desk (`/api/panes/{id}/keys/{name}`,
//! behind the token and a running pane), whose output a command expands with
//! `$(...)` so the shell carries it and the conversation never does. That is
//! the one response a value is in; it is never in a row, an event, a log line
//! or a tool result. Whoever holds the token and a live pane's id can ask --
//! the same boundary as the rest of the daemon, and on macOS it means the
//! Keychain's per-application prompt is the daemon's, not the asker's. snyvi
//! never uses one itself -- it keeps, it hands over, it calls nothing.
//!
//! The keychain's client blocks: every call here is made from a blocking
//! thread (`tokio::task::spawn_blocking`), never from the async ones.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::desk::DeskKey;

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "snyvi";

/// Where a value went, for the window's one line under the form.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kept {
    Keychain,
    File,
}

#[derive(Clone, Debug)]
pub struct Secrets {
    /// The 0600 file, for when the keychain does not answer.
    file: PathBuf,
    /// Off in tests: they never touch the machine's keychain.
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    keychain: bool,
}

/// What `entry` returns where there is no keychain client: a type with the
/// three calls `keep`, `value` and `forget` make, each of which declines, so
/// those read the same on every platform.
#[cfg(not(any(target_os = "macos", windows)))]
struct NoKeychain;

#[cfg(not(any(target_os = "macos", windows)))]
impl NoKeychain {
    fn set_password(&self, _value: &str) -> std::result::Result<(), ()> {
        Err(())
    }
    fn get_password(&self) -> std::result::Result<String, ()> {
        Err(())
    }
    fn delete_credential(&self) -> std::result::Result<(), ()> {
        Err(())
    }
}

impl Secrets {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            keychain: true,
        }
    }

    #[cfg(test)]
    pub fn file_only(file: PathBuf) -> Self {
        Self {
            file,
            keychain: false,
        }
    }

    fn account(desk: i64, name: &str) -> String {
        format!("{desk}/{name}")
    }

    #[cfg(any(target_os = "macos", windows))]
    fn entry(&self, account: &str) -> Option<keyring::Entry> {
        if !self.keychain {
            return None;
        }
        keyring::Entry::new(SERVICE, account).ok()
    }

    /// Linux: no keychain, so never an entry (see the module doc).
    #[cfg(not(any(target_os = "macos", windows)))]
    fn entry(&self, _account: &str) -> Option<NoKeychain> {
        None
    }

    /// Keep a value: the keychain if there is one and it answers, the file
    /// otherwise.
    pub fn keep(&self, desk: i64, name: &str, value: &str) -> Result<Kept> {
        let account = Self::account(desk, name);
        if let Some(e) = self.entry(&account) {
            if e.set_password(value).is_ok() {
                // A copy the file held from a day the keychain was away is a
                // secret in a file for no reason now.
                self.edit(|m| {
                    m.remove(&account);
                })?;
                return Ok(Kept::Keychain);
            }
        }
        self.edit(|m| {
            m.insert(account, value.to_string());
        })?;
        Ok(Kept::File)
    }

    /// The value, from wherever it was kept; `None` when it is nowhere.
    pub fn value(&self, desk: i64, name: &str) -> Option<String> {
        let account = Self::account(desk, name);
        if let Some(e) = self.entry(&account) {
            if let Ok(v) = e.get_password() {
                return Some(v);
            }
        }
        self.read().remove(&account)
    }

    /// Forget a value, wherever it was. Nothing to say when there was none.
    pub fn forget(&self, desk: i64, name: &str) {
        let account = Self::account(desk, name);
        if let Some(e) = self.entry(&account) {
            let _ = e.delete_credential();
        }
        let _ = self.edit(|m| {
            m.remove(&account);
        });
    }

    /// `NAME=value` for each key that has a value, for a panel's environment.
    /// A name whose value is nowhere is left out, not set empty: an empty
    /// `GH_TOKEN` would stop `gh` asking.
    pub fn values(&self, keys: &[DeskKey]) -> Vec<(String, String)> {
        keys.iter()
            .filter_map(|k| self.value(k.desk_id, &k.name).map(|v| (k.name.clone(), v)))
            .collect()
    }

    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn edit(&self, f: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<()> {
        let mut m = self.read();
        let was = m.clone();
        f(&mut m);
        if m == was {
            return Ok(());
        }
        if m.is_empty() {
            let _ = std::fs::remove_file(&self.file);
            return Ok(());
        }
        write_private(&self.file, &serde_json::to_vec_pretty(&m)?)
    }
}

/// Write a file only its owner can read: a temporary beside it with mode
/// 0600 from the first byte, then a rename, so no reader ever sees it half
/// written or world-readable (the way `capability.rs` keeps its file).
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o
        .open(&tmp)
        .with_context(|| format!("writing {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Whether a name is one an environment can carry and snyvi will hand over:
/// capitals, digits and underscores, starting with a capital, at most 64,
/// and not one of snyvi's own.
pub fn valid_name(name: &str) -> std::result::Result<(), &'static str> {
    if name.is_empty() || name.len() > 64 {
        return Err("a name is 1 to 64 characters");
    }
    let shape = name.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    if !shape {
        return Err(
            "a name is capitals, digits and underscores, starting with a capital, like OPENROUTER_API_KEY",
        );
    }
    if name.starts_with("SNYVI_") {
        return Err("SNYVI_ names are snyvi's own");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(desk: i64, name: &str) -> DeskKey {
        DeskKey {
            desk_id: desk,
            name: name.into(),
            provider: String::new(),
            created_at: 0,
            used_at: 0,
        }
    }

    #[test]
    fn values_go_to_a_file_only_the_owner_reads_when_no_keychain_answers() {
        let dir = crate::store::tempdir::Dir::new("snyvi-keys");
        let file = dir.path.join("keys.json");
        let s = Secrets::file_only(file.clone());
        assert_eq!(s.value(1, "GH_TOKEN"), None);
        assert_eq!(s.keep(1, "GH_TOKEN", "ghp_one").unwrap(), Kept::File);
        assert_eq!(s.keep(0, "GH_TOKEN", "ghp_all").unwrap(), Kept::File);
        // Per desk: desk 2 has no value of its own, and is handed none here;
        // which every-desk row it gets is the store's call (`desk::keys`).
        assert_eq!(s.value(1, "GH_TOKEN").as_deref(), Some("ghp_one"));
        assert_eq!(s.value(2, "GH_TOKEN"), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "only its owner reads it");
        }
        // The environment gets what has a value, and nothing for what has none.
        assert_eq!(
            s.values(&[key(1, "GH_TOKEN"), key(0, "OPENROUTER_API_KEY")]),
            vec![("GH_TOKEN".to_string(), "ghp_one".to_string())]
        );
        s.forget(1, "GH_TOKEN");
        assert_eq!(s.value(1, "GH_TOKEN"), None);
        assert_eq!(s.value(0, "GH_TOKEN").as_deref(), Some("ghp_all"));
        // The last one out takes the file with it.
        s.forget(0, "GH_TOKEN");
        assert!(!file.exists());
        s.forget(0, "GH_TOKEN");
    }

    #[test]
    fn a_name_is_an_environment_variable_and_not_one_of_snyvis() {
        assert_eq!(valid_name("OPENROUTER_API_KEY"), Ok(()));
        assert_eq!(valid_name("GH_TOKEN"), Ok(()));
        assert_eq!(valid_name("AWS_ACCESS_KEY_ID"), Ok(()));
        assert!(valid_name("").is_err());
        assert!(valid_name("gh_token").is_err());
        assert!(valid_name("1KEY").is_err());
        assert!(valid_name("GH-TOKEN").is_err());
        assert!(valid_name("GH TOKEN").is_err());
        assert!(valid_name("SNYVI_SESSION").is_err());
        assert!(valid_name(&"A".repeat(65)).is_err());
    }
}
