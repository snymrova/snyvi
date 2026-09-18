//! The window's capability: 32 bytes minted per window launch, which is how a
//! page proves it is the desktop window and not a browser tab.
//!
//! It is deliberately not the write token. The token exists so that a random
//! local process cannot inject a document, and it lives on disk at
//! `paths.token_path` for the CLI and the MCP server to read. A capability that
//! reached the page would put that file's contents into HTML any local process
//! can `GET`, which would be the end of it. So this is a second secret with a
//! different shape: minted by the daemon on a request that carries the token,
//! handed to exactly one window, never written to disk, and gone when the
//! daemon exits.
//!
//! It never travels in a query string. A query string lands in the request path
//! and so in anything that logs one; the URL fragment is never sent to the
//! server at all, which is why the mint rides there and the page presents it
//! afterwards in a message body it composes itself.

use std::collections::VecDeque;
use std::sync::Mutex;

/// How many live at once. One per window launch, and a launch is a person
/// starting the viewer, so this is a generous ceiling rather than a budget --
/// but it is a ceiling, because nothing here is ever removed by the window
/// quitting. The window cannot tell the daemon it is gone: a process that is
/// killed says nothing, and a capability that outlived its window would keep a
/// slot forever. So the oldest falls out when the sixteenth is minted.
const MAX: usize = 16;

/// The capabilities this daemon has minted and will still honour.
#[derive(Default)]
pub struct Capabilities(Mutex<VecDeque<String>>);

impl Capabilities {
    /// A new capability, remembered, and returned to the caller that proved it
    /// holds the token.
    pub fn mint(&self) -> anyhow::Result<String> {
        let cap = random_hex()?;
        let mut live = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if live.len() >= MAX {
            live.pop_front();
        }
        live.push_back(cap.clone());
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
    fn several_windows_are_live_at_once_and_the_oldest_falls_out_past_the_cap() {
        let caps = Capabilities::default();
        let first = caps.mint().unwrap();
        let rest: Vec<_> = (0..MAX).map(|_| caps.mint().unwrap()).collect();
        assert_eq!(caps.len(), MAX);
        assert!(!caps.verify(&first), "the oldest was evicted");
        assert!(rest.iter().all(|c| caps.verify(c)), "the rest still hold");
    }
}
