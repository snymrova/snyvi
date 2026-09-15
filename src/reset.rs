//! `snyvi reset`: back to a fresh install.
//!
//! What goes: every document and version, the index, the token, and the
//! preferences every open page keeps. What stays: the agents, unless
//! `--agents` says otherwise -- un-registering them is `uninstall-claude`'s
//! job and touches files that are not snyvi's, and a reset that quietly did
//! it would leave the next `send_document` failing against a tool that no
//! longer exists. Left registered, the next send lands in an empty library,
//! which is the fresh install working.
//!
//! It is the one thing snyvi does that cannot be undone, where a delete can
//! be, so the friction is real: the sentence says what goes and what stays,
//! and the confirmation is the number of documents typed back. Not "yes";
//! the number means the sentence was read.

use crate::config::{self, Paths};
use crate::store::{Census, Store};
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::io::{IsTerminal, Write};
use std::time::Duration;

pub struct Opts {
    pub yes: bool,
    pub dry_run: bool,
    pub agents: bool,
    pub pinned: bool,
}

pub fn run(paths: &Paths, o: Opts) -> Result<()> {
    let running = crate::client::health().is_some();
    let census = census(paths, running)?;
    let installed = paths.data_dir.exists() || paths.token_path.exists();

    if !installed && census == Census::default() {
        println!("Nothing to reset: snyvi is as it was installed.");
        if o.agents {
            println!();
            crate::setup::uninstall_claude()?;
        }
        return Ok(());
    }

    println!("{}", sentence(&census, o.agents));
    if o.dry_run {
        return Ok(());
    }
    if census.pinned > 0 && !o.pinned {
        bail!(
            "{} pinned document(s) would go with it, and a pin means keep. Add --pinned to reset them too; nothing was done",
            census.pinned
        );
    }
    if !o.yes {
        if !std::io::stdin().is_terminal() {
            bail!(
                "not a terminal, so nothing can be typed back; add --yes to reset without asking"
            );
        }
        print!("Type the number of documents to continue: ");
        std::io::stdout().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        if line.trim() != census.documents.to_string() {
            bail!("that is not {}; nothing was done", census.documents);
        }
    }

    if running {
        reset_through_daemon(paths, &census)?;
    } else {
        reset_on_disk(paths)?;
    }
    println!(
        "Reset. {} gone, and the token; snyvi is as it was installed.",
        count(census.documents, "document", "documents")
    );
    if o.agents {
        println!();
        crate::setup::uninstall_claude_keeping(false)?;
    } else if crate::setup::registered().is_some() {
        println!("Claude Code is still registered: the next document an agent sends lands in an empty library.");
    } else {
        println!("No agent is registered; `snyvi init-claude` connects Claude Code.");
    }
    Ok(())
}

/// The numbers, from whoever holds the store: the daemon when it is up, the
/// database itself when it is not, and zero when there is none -- without
/// making one, which `Store::open` would.
fn census(paths: &Paths, running: bool) -> Result<Census> {
    if running {
        return ureq::get(&format!("{}/api/reset", config::base_url()))
            .config()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .call()
            .context("asking the daemon what there is")?
            .body_mut()
            .read_json::<Census>()
            .context("reading the daemon's answer");
    }
    if !paths.db_path.exists() {
        return Ok(Census::default());
    }
    Store::open(paths)?.census()
}

fn count(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn sentence(c: &Census, agents: bool) -> String {
    format!(
        "This removes {} in {}, the index, the token and the page's preferences, and {}. Nothing can be undone.",
        count(c.documents, "document", "documents"),
        count(c.projects, "project", "projects"),
        if agents {
            "takes snyvi out of Claude Code".to_string()
        } else {
            "leaves Claude Code registered (add --agents to take that out too)".to_string()
        }
    )
}

/// The daemon does it in place and stays up, so every open page hears the
/// event and comes back to the empty library; the number it is sent is the
/// one that was typed, so a document that arrived in between is refused
/// rather than reset unseen.
fn reset_through_daemon(paths: &Paths, census: &Census) -> Result<()> {
    let token = config::read_token(paths).context("no token, so the daemon cannot be asked")?;
    let mut resp = ureq::post(&format!("{}/api/reset", config::base_url()))
        .header("Authorization", &format!("Bearer {token}"))
        .config()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .send_json(json!({ "documents": census.documents, "pinned": true }))
        .context("asking the daemon to reset")?;
    if resp.status() != 200 {
        let body: serde_json::Value = resp.body_mut().read_json().unwrap_or_default();
        bail!(
            "{}",
            body.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("the daemon refused")
        );
    }
    Ok(())
}

/// No daemon: what snyvi put on disk, by name, and then each directory if
/// that left it empty -- not the directories whole, because `SNYVI_DATA_DIR`
/// and `SNYVI_CONFIG_DIR` can point anywhere, and a reset that took a
/// directory it was merely pointed at would be taking what is not its own.
fn reset_on_disk(paths: &Paths) -> Result<()> {
    let gone = |p: &std::path::Path| -> Result<()> {
        if p.is_dir() {
            std::fs::remove_dir_all(p).with_context(|| format!("removing {}", p.display()))
        } else if p.exists() {
            std::fs::remove_file(p).with_context(|| format!("removing {}", p.display()))
        } else {
            Ok(())
        }
    };
    gone(&paths.docs_dir)?;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut db = paths.db_path.as_os_str().to_owned();
        db.push(suffix);
        gone(std::path::Path::new(&db))?;
    }
    gone(&paths.token_path)?;
    gone(&paths.config_dir.join("sessions.json"))?;
    for dir in [&paths.data_dir, &paths.config_dir] {
        let _ = std::fs::remove_dir(dir); // only if empty, which is the point
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sentence_says_what_goes_and_what_stays() {
        let c = Census {
            documents: 214,
            projects: 9,
            pinned: 0,
        };
        let s = sentence(&c, false);
        assert!(s.contains("214 documents in 9 projects"), "{s}");
        assert!(s.contains("leaves Claude Code registered"), "{s}");
        assert!(s.contains("--agents"), "{s}");
        let s = sentence(
            &Census {
                documents: 1,
                projects: 1,
                pinned: 1,
            },
            true,
        );
        assert!(s.contains("1 document in 1 project"), "{s}");
        assert!(s.contains("takes snyvi out of Claude Code"), "{s}");
    }
}
