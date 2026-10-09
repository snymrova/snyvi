//! Signing an account in without the reader ever holding its token.
//!
//! `claude setup-token` is the browser sign-in `/login` is, and at its end it
//! prints a year's token for the account that approved. snyvi runs it in a
//! terminal no one sees, reads that terminal with the panels' own emulator
//! (`crate::screen`), and keeps the token the moment it is whole -- so the
//! reader clicks *Sign in…*, approves in the browser, and the account is
//! there. What the page is told is only what the reader needs: the sign-in
//! page's address, in case the browser did not open, and how it ended. The
//! token is in no answer, event or log line; it goes from the screen to
//! `keep` and nowhere else.
//!
//! Claude Code does not document what `setup-token` prints, so nothing here
//! leans on more than the token's own shape and the line Claude Code writes
//! after it ("Store this token securely"): a token is taken only once that
//! line is on the screen, never half-drawn. If the screen says something
//! else -- a question snyvi cannot answer, a policy that refuses -- the
//! sign-in ends with what it said, and the sheet's paste is still there.
//!
//! One at a time: a second *Sign in…* ends the first.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use portable_pty::{ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;

use crate::screen::Screen;

/// Wide enough that the sign-in address, a few hundred characters, is one
/// line and not cut where the screen wraps it.
const COLS: u16 = 1000;
const ROWS: u16 = 60;

/// No address by then and `setup-token` is asking something else.
const WAIT_FOR_URL: Duration = Duration::from_secs(45);
/// The reader has gone, or the browser was closed: the sign-in ends.
const WAIT_ALL: Duration = Duration::from_secs(10 * 60);

/// Claude Code writes this after the token, so the token above it is whole.
const AFTER_TOKEN: &str = "Store this token";
const TOKEN_START: &str = "sk-ant-oat";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// `setup-token` is starting; nothing to show yet.
    Starting,
    /// The sign-in page is open, or its address is here to open.
    Waiting,
    Done,
    Failed,
    Cancelled,
}

/// A sign-in as the page sees it. No token, ever.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Shown {
    pub id: u64,
    pub phase: Phase,
    /// The account being renewed, or `None` for a new one.
    pub renew: Option<i64>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The account it added or renewed, once done.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the screen has said so far.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Said {
    pub url: Option<String>,
    pub token: Option<String>,
}

/// The hidden terminal's screen, fed as the bytes come.
pub struct Reader {
    screen: Screen,
    parser: vte::Parser,
}

impl Reader {
    pub fn new() -> Self {
        Self {
            screen: Screen::new(usize::from(COLS), usize::from(ROWS)),
            parser: vte::Parser::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Said {
        self.screen.feed(&mut self.parser, bytes);
        said(&self.screen.text())
    }
}

/// The sign-in address and the token, from the screen's lines.
pub fn said(lines: &[String]) -> Said {
    let url = lines
        .iter()
        .filter_map(|l| l.find("https://").map(|i| &l[i..]))
        .map(|u| u.split_whitespace().next().unwrap_or(""))
        .find(|u| u.contains("oauth") || u.contains("authorize"))
        .map(str::to_string);
    let token = lines
        .iter()
        .position(|l| l.contains(AFTER_TOKEN))
        .and_then(|end| {
            lines[..end].iter().rev().find_map(|l| {
                let at = l.find(TOKEN_START)?;
                let t: String = l[at..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                super::valid_token(&t).ok().map(|()| t)
            })
        });
    Said { url, token }
}

/// A code the sign-in page shows, typed back: one line of what a page can
/// show, and nothing a terminal would take as a key.
pub fn valid_code(code: &str) -> std::result::Result<&str, &'static str> {
    let code = code.trim();
    if code.is_empty() || code.len() > 512 || !code.chars().all(|c| c.is_ascii_graphic()) {
        return Err("that is not a code the sign-in page shows");
    }
    Ok(code)
}

struct Live {
    shown: Shown,
    input: Option<Box<dyn Write + Send>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// The one sign-in, if there is one.
#[derive(Default)]
pub struct SignIns {
    now: Mutex<Option<Live>>,
    next: AtomicU64,
}

impl SignIns {
    pub fn current(&self) -> Option<Shown> {
        self.now.lock().unwrap().as_ref().map(|l| l.shown.clone())
    }

    /// Start `claude setup-token` for an account: `keep` is handed the token
    /// once it is whole, on a blocking thread, and answers with the account
    /// it went to. A sign-in already open ends first.
    pub fn start<K>(self: &Arc<Self>, label: String, renew: Option<i64>, keep: K) -> Result<Shown>
    where
        K: FnOnce(String) -> Result<i64> + Send + 'static,
    {
        self.cancel();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let pty = portable_pty::native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: ROWS,
                cols: COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening a terminal")?;
        let mut child = pair
            .slave
            .spawn_command(command())
            .context("starting claude setup-token")?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .context("reading the terminal")?;
        let input = pair.master.take_writer().context("writing the terminal")?;
        let shown = Shown {
            id,
            phase: Phase::Starting,
            renew,
            label,
            url: None,
            account: None,
            error: None,
        };
        *self.now.lock().unwrap() = Some(Live {
            shown: shown.clone(),
            input: Some(input),
            killer: child.clone_killer(),
        });

        // The screen, until the token or the end.
        let me = self.clone();
        std::thread::spawn(move || {
            // Held so the terminal stays open while the child runs.
            let _master = pair.master;
            let mut screen = Reader::new();
            let mut buf = [0u8; 8192];
            let mut keep = Some(keep);
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let said = screen.feed(&buf[..n]);
                if let Some(url) = said.url {
                    me.update(id, |s| {
                        if s.url.is_none() {
                            s.url = Some(url);
                            s.phase = Phase::Waiting;
                        }
                    });
                }
                if let Some(token) = said.token {
                    me.kill(id);
                    let ended = match keep.take().map(|k| k(token)) {
                        Some(Ok(account)) => (Phase::Done, Some(account), None),
                        Some(Err(e)) => (Phase::Failed, None, Some(format!("{e:#}"))),
                        None => break,
                    };
                    me.end(id, ended.0, ended.1, ended.2);
                    let _ = child.wait();
                    return;
                }
            }
            let _ = child.wait();
            // Ended with no token: say what the screen said last, which is
            // Claude Code's own word for why.
            let last = screen
                .screen
                .text()
                .into_iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.trim().chars().take(200).collect::<String>())
                .filter(|l| !l.contains(TOKEN_START));
            me.end(
                id,
                Phase::Failed,
                None,
                Some(match last {
                    Some(l) => format!("claude setup-token ended without a token: {l}"),
                    None => "claude setup-token ended without a token".into(),
                }),
            );
        });

        // And the clock: no address soon, or no approval at all.
        let me = self.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let Some(s) = me.current().filter(|s| s.id == id) else {
                    return;
                };
                let why = match s.phase {
                    Phase::Starting if started.elapsed() > WAIT_FOR_URL => {
                        "claude setup-token did not offer a sign-in page: paste a token instead"
                    }
                    Phase::Starting | Phase::Waiting if started.elapsed() > WAIT_ALL => {
                        "the sign-in was not approved in time"
                    }
                    Phase::Starting | Phase::Waiting => continue,
                    _ => return,
                };
                me.kill(id);
                me.end(id, Phase::Failed, None, Some(why.into()));
                return;
            }
        });
        Ok(shown)
    }

    /// The code the sign-in page shows when the browser is on another
    /// machine, typed into the hidden terminal.
    pub fn code(&self, code: &str) -> Result<()> {
        let code = valid_code(code).map_err(|e| anyhow::anyhow!(e))?;
        let mut now = self.now.lock().unwrap();
        let Some(live) = now.as_mut().filter(|l| l.shown.phase == Phase::Waiting) else {
            bail!("no sign-in is waiting for a code");
        };
        let Some(input) = live.input.as_mut() else {
            bail!("no sign-in is waiting for a code");
        };
        input.write_all(code.as_bytes())?;
        input.write_all(b"\r")?;
        input.flush()?;
        Ok(())
    }

    /// End the sign-in that is open, if there is one; whether there was.
    pub fn cancel(&self) -> bool {
        let id = match self.current() {
            Some(s) if matches!(s.phase, Phase::Starting | Phase::Waiting) => s.id,
            _ => return false,
        };
        self.kill(id);
        self.end(id, Phase::Cancelled, None, None);
        true
    }

    fn update(&self, id: u64, f: impl FnOnce(&mut Shown)) {
        if let Some(live) = self.now.lock().unwrap().as_mut() {
            if live.shown.id == id && matches!(live.shown.phase, Phase::Starting | Phase::Waiting) {
                f(&mut live.shown);
            }
        }
    }

    fn kill(&self, id: u64) {
        if let Some(live) = self.now.lock().unwrap().as_mut() {
            if live.shown.id == id {
                let _ = live.killer.kill();
                live.input = None;
            }
        }
    }

    /// The first ending is the one that stands: a cancel is not undone by
    /// the reader thread hearing the terminal close.
    fn end(&self, id: u64, phase: Phase, account: Option<i64>, error: Option<String>) {
        self.update(id, |s| {
            s.phase = phase;
            s.account = account;
            s.error = error;
        });
    }
}

/// `claude setup-token` as the reader's own login shell finds it, with
/// nothing that would make it a different sign-in: no credential Claude
/// Code ranks above a login, and no panel's marks, so its hooks are not a
/// panel's.
fn command() -> CommandBuilder {
    #[cfg(test)]
    if let Some(script) = TEST_SCRIPT.lock().unwrap().clone() {
        let mut c = CommandBuilder::new("/bin/sh");
        c.args(["-c", &script]);
        return c;
    }
    #[cfg(unix)]
    let mut c = {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut c = CommandBuilder::new(shell);
        c.args(["-l", "-c", "exec claude setup-token"]);
        c
    };
    #[cfg(windows)]
    let mut c = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/C", "claude", "setup-token"]);
        c
    };
    for k in super::OUTRANKS
        .iter()
        .chain(&[
            super::TOKEN_VAR,
            "SNYVI_SESSION",
            "SNYVI_DESK",
            "SNYVI_SLOT",
        ])
        .chain(&[
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SESSION_ID",
        ])
    {
        c.env_remove(k);
    }
    c.env("TERM", "xterm-256color");
    if let Some(home) = dirs_home() {
        c.cwd(home);
    }
    c
}

/// A route test's stand-in for `claude setup-token`: a script that draws
/// what it draws.
#[cfg(test)]
pub static TEST_SCRIPT: Mutex<Option<String>> = Mutex::new(None);

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> String {
        format!("sk-ant-oat01-{}", "a1B2_c-".repeat(14))
    }

    #[test]
    fn the_address_is_read_but_the_token_waits_for_the_line_after_it() {
        let t = token();
        let mut r = Reader::new();
        let s = r.feed(b"\x1b[2J\x1b[1;1H\x1b[1mBrowser didn't open? Use the url below to sign in\x1b[0m\r\n\r\n  https://claude.ai/oauth/authorize?code=true&client_id=x&state=y\r\n\r\nPaste code here if prompted > ");
        assert_eq!(
            s.url.as_deref(),
            Some("https://claude.ai/oauth/authorize?code=true&client_id=x&state=y")
        );
        assert_eq!(s.token, None);
        // Half a token, as a read can cut one: nothing yet.
        let s = r.feed(
            format!(
                "\x1b[2J\x1b[1;1H\x1b[32mYour OAuth token (valid for 1 year):\x1b[0m\r\n\r\n{}",
                &t[..40]
            )
            .as_bytes(),
        );
        assert_eq!(s.token, None);
        let s = r.feed(
            format!(
                "{}\r\n\r\nStore this token securely. You won't be able to see it again.\r\n",
                &t[40..]
            )
            .as_bytes(),
        );
        assert_eq!(s.token.as_deref(), Some(t.as_str()));
    }

    #[test]
    fn a_token_drawn_with_the_cursor_moving_still_reads_whole() {
        let t = token();
        let (a, b) = t.split_at(30);
        let mut r = Reader::new();
        // The second half drawn first, at its column; then the first.
        let s = r.feed(
            format!(
                "\x1b[3;{}H{b}\x1b[3;1H{a}\x1b[5;1HStore this token securely.\r\n",
                a.len() + 1
            )
            .as_bytes(),
        );
        assert_eq!(s.token.as_deref(), Some(t.as_str()));
    }

    #[test]
    fn nothing_that_is_not_a_whole_token_is_taken() {
        let lines = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            said(&lines(&[
                "sk-ant-oat01-short",
                "Store this token securely."
            ]))
            .token,
            None
        );
        assert_eq!(
            said(&lines(&[
                "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"
            ])),
            Said::default()
        );
        assert_eq!(said(&lines(&["see https://example.com/help"])).url, None);
    }

    #[test]
    fn a_code_is_one_line_of_printable_text() {
        assert_eq!(valid_code("  abc#DEF-123 "), Ok("abc#DEF-123"));
        assert!(valid_code("").is_err());
        assert!(valid_code("abc\x1b[A").is_err());
        assert!(valid_code("two words").is_err());
    }
}
