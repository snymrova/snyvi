//! The window's capability: 32 bytes minted per window launch, which is how a
//! page proves it is the desktop window and not a browser tab.
//!
//! It is deliberately not the write token. The token exists so that a random
//! local process cannot inject a document, and it lives on disk at
//! `paths.token_path` for the CLI and the MCP server to read. A capability that
//! reached the page would put that file's contents into HTML any local process
//! can `GET`, which would be the end of it. So this is a second secret with a
//! different shape: minted by the daemon on a request that carries the token,
//! handed to exactly one window, and kept beside the token in a file only its
//! owner can read.
//!
//! It used to be kept in memory only, and die with the daemon. But the window
//! outlives the daemon -- it reconnects to the next one, for documents, without
//! a word -- so every restart and every upgrade left an open window whose `+`
//! answered "no capability" until it was closed and opened again. What the
//! capability keeps out is a browser tab, and a tab cannot read a file; a
//! local process running as the reader can read the token already, and with
//! it mint as many capabilities as it likes. So the file costs nothing the
//! token had not already spent.
//!
//! It never travels in a query string. A query string lands in the request path
//! and so in anything that logs one; the URL fragment is never sent to the
//! server at all, which is why the mint rides there and the page presents it
//! afterwards in a message body it composes itself.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

/// How many live at once. One per window launch, and a launch is a person
/// starting the viewer, so this is a generous ceiling rather than a budget --
/// but it is a ceiling, because nothing here is ever removed by the window
/// quitting. The window cannot tell the daemon it is gone: a process that is
/// killed says nothing, and a capability that outlived its window would keep a
/// slot forever. So the oldest falls out when the sixteenth is minted.
const MAX: usize = 16;

/// The capabilities this daemon, or one before it, has minted and it will
/// still honour; and the file they are kept in, when there is one.
#[derive(Default)]
pub struct Capabilities(Mutex<VecDeque<String>>, Option<PathBuf>);

impl Capabilities {
    /// The capabilities in `path`, which a mint rewrites. A file that is not
    /// there or cannot be read is no capabilities, not an error: the worst it
    /// costs is a window that has to be opened again.
    pub fn load(path: PathBuf) -> Self {
        let live: VecDeque<String> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))
            .map(str::to_string)
            .collect();
        let skip = live.len().saturating_sub(MAX);
        Self(
            Mutex::new(live.into_iter().skip(skip).collect()),
            Some(path),
        )
    }

    /// A new capability, remembered, and returned to the caller that proved it
    /// holds the token.
    pub fn mint(&self) -> anyhow::Result<String> {
        let cap = random_hex()?;
        let mut live = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if live.len() >= MAX {
            live.pop_front();
        }
        live.push_back(cap.clone());
        if let Some(path) = &self.1 {
            save(path, &live)?;
        }
        Ok(cap)
    }

    /// Is this one of ours? Compared in constant time, and against every live
    /// capability, because the answer must not depend on which one matched or
    /// on how far down the list it was.
    pub fn verify(&self, given: &str) -> bool {
        let live = self.0.lock().unwrap_or_else(|e| e.into_inner());
        live.iter()
            .fold(false, |found, cap| constant_eq(given, cap) | found)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

/// The list, whole, through a file made private before a byte is in it and put
/// in place by a rename, so a reader never sees half of one.
fn save(path: &std::path::Path, live: &VecDeque<String>) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(&tmp)?;
    for cap in live {
        writeln!(f, "{cap}")?;
    }
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 32 bytes from the OS, hex encoded -- the same shape and the same source as
/// the token in `config::random_token`, for the same reason: a secret derived
/// from the clock and a process id is one a neighbouring program can search
/// for.
fn random_hex() -> anyhow::Result<String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf)
        .map_err(|e| anyhow::anyhow!("reading random bytes for the capability: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_capability_verifies_and_a_made_up_one_does_not() {
        let caps = Capabilities::default();
        let cap = caps.mint().unwrap();
        assert!(caps.verify(&cap));
        assert!(!caps.verify(&"0".repeat(64)));
        assert!(!caps.verify(""));
    }

    #[test]
    fn a_capability_is_thirty_two_bytes_of_hex_and_never_repeats() {
        let caps = Capabilities::default();
        let a = caps.mint().unwrap();
        let b = caps.mint().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn a_capability_outlives_the_daemon_that_minted_it() {
        let dir = std::env::temp_dir().join(format!("snyvi-caps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("capabilities");
        let cap = Capabilities::load(path.clone()).mint().unwrap();
        // The next daemon, reading what the last one left.
        let next = Capabilities::load(path.clone());
        assert!(next.verify(&cap));
        assert!(!next.verify(&"0".repeat(64)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "only its owner reads it");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn several_windows_are_live_at_once_and_the_oldest_falls_out_past_the_cap() {
        let caps = Capabilities::default();
        let first = caps.mint().unwrap();
        let rest: Vec<_> = (0..MAX).map(|_| caps.mint().unwrap()).collect();
        assert_eq!(caps.len(), MAX);
        assert!(!caps.verify(&first), "the oldest was evicted");
        assert!(rest.iter().all(|c| caps.verify(c)), "the rest still hold");
    }
}
