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
//! be, so the friction is real: the sentence says what goes and what stays --
//! the documents and the desks both -- and the confirmation is the number of
//! documents typed back. Not "yes"; the number means the sentence was read.
//! The daemon then checks both numbers against what it holds, so a document or
//! a desk that appeared in between stops the reset rather than going unseen.

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
            for a in registered_agents() {
                println!();
                if a.id == "claude" {
                    crate::setup::uninstall_claude()?;
                } else {
                    crate::agents::uninstall(&a)?;
                }
            }
        }
        return Ok(());
    }

    let registered = registered_agents();
    println!("{}", sentence(&census, o.agents, &registered));
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
        "Reset. {}{} gone, and the token; snyvi is as it was installed.",
        count(census.documents, "document", "documents"),
        if census.desks > 0 {
            format!(" and {}", count(census.desks, "desk", "desks"))
        } else {
            String::new()
        }
    );
    if o.agents {
        for a in &registered {
            println!();
            if a.id == "claude" {
                crate::setup::uninstall_claude_keeping(false)?;
            } else {
                crate::agents::uninstall_keeping(a, false)?;
            }
        }
    } else if !registered.is_empty() {
        println!(
            "{} still registered: the next document an agent sends lands in an empty library.",
            names(&registered, "is", "are")
        );
    } else {
        println!(
            "No agent is registered; the page at {} says how to connect one.",
            config::base_url()
        );
    }
    Ok(())
}

/// Every agent whose own file names snyvi, stale or not: what a reset
/// leaves alone, and what `--agents` takes out.
fn registered_agents() -> Vec<crate::agents::Agent> {
    crate::agents::all()
        .into_iter()
        .filter(|a| {
            matches!(
                crate::agents::state(a),
                crate::agents::State::Connected { .. } | crate::agents::State::Stale { .. }
            )
        })
        .collect()
}

/// "Claude Code is", "Claude Code and Codex CLI are".
fn names(agents: &[crate::agents::Agent], one: &str, many: &str) -> String {
    let n: Vec<&str> = agents.iter().map(|a| a.name).collect();
    let list = match n.len() {
        0 => String::new(),
        1 => n[0].to_string(),
        k => format!("{} and {}", n[..k - 1].join(", "), n[k - 1]),
    };
    format!("{list} {}", if n.len() == 1 { one } else { many })
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

fn sentence(c: &Census, agents: bool, registered: &[crate::agents::Agent]) -> String {
    let list: Vec<&str> = registered.iter().map(|a| a.name).collect();
    let list = match list.len() {
        0 => String::new(),
        1 => list[0].to_string(),
        k => format!("{} and {}", list[..k - 1].join(", "), list[k - 1]),
    };
    format!(
        "This removes {} in {}, {}the index, the token and the page's preferences, and {}. Nothing can be undone.",
        count(c.documents, "document", "documents"),
        count(c.projects, "project", "projects"),
        if c.desks > 0 {
            format!("{} and their panes, ", count(c.desks, "desk", "desks"))
        } else {
            String::new()
        },
        if registered.is_empty() {
            "no agent is registered".to_string()
        } else if agents {
            format!("takes snyvi out of {list}")
        } else {
            format!("leaves {list} registered (add --agents to take that out too)")
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
        .send_json(json!({ "documents": census.documents, "desks": census.desks, "pinned": true }))
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
            desks: 0,
        };
        let both: Vec<_> = crate::agents::all()
            .into_iter()
            .filter(|a| a.id == "claude" || a.id == "codex")
            .collect();
        let s = sentence(&c, false, &both[..1]);
        assert!(s.contains("214 documents in 9 projects, the index"), "{s}");
        assert!(!s.contains("desk"), "no desks, so no word about them: {s}");
        assert!(s.contains("leaves Claude Code registered"), "{s}");
        assert!(s.contains("--agents"), "{s}");
        let one = Census {
            documents: 1,
            projects: 1,
            pinned: 1,
            desks: 1,
        };
        let s = sentence(&one, true, &both);
        assert!(
            s.contains("1 document in 1 project, 1 desk and their panes, the index"),
            "{s}"
        );
        assert!(
            s.contains("takes snyvi out of Claude Code and Codex CLI"),
            "{s}"
        );
        let s = sentence(&one, true, &[]);
        assert!(s.contains("and no agent is registered"), "{s}");
        let two = Census { desks: 2, ..c };
        let s = sentence(&two, false, &[]);
        assert!(
            s.contains("9 projects, 2 desks and their panes, the index"),
            "{s}"
        );
        assert_eq!(names(&both, "is", "are"), "Claude Code and Codex CLI are");
        assert_eq!(names(&both[..1], "is", "are"), "Claude Code is");
    }
}
