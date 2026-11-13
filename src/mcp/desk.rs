//! read_desk (1.65, plan 2d186a80c1): the one read an agent has of its own
//! desk past its notes -- the threads, the resting ones too, the other
//! panels, the folder's checkouts against the main line, and what the user
//! decided (`server::api_agent::pane_desk`, `crate::ledger`).
//!
//! One tool with sections, not four tools: every tool's description is in
//! every panel session's list, and the list is held to a size (the test in
//! `mcp.rs`). The text is short on purpose and the whole answer rides in
//! `structuredContent`; a decision is found by its words with `query`.

use super::{arg, said, Session};
use crate::client;
use crate::text::ago;
use serde_json::{json, Value};

const READ: &str = "Read this snyvi desk before asking the user where things stand: its threads (stage, folder, \
branch, PR; the resting ones too), the other panels and what each is doing, the folder's checkouts against \
main, and what the user decided (open, answered, dropped). Call it when you start, when unsure which \
checkout is live, and before asking what may be answered already. Pass sections to read less, query to \
find a decision by its words.";

const SECTIONS: [&str; 4] = ["threads", "panels", "folder", "decisions"];

pub(super) fn specs() -> Vec<Value> {
    vec![json!({
        "name": "read_desk", "title": "Read this desk", "description": READ,
        "inputSchema": { "type": "object", "properties": {
            "sections": { "type": "array", "items": { "type": "string", "enum": SECTIONS },
                "description": "Which to read. Default all four, said short." },
            "query": { "type": "string", "description": "Words to find among the decisions: in a question, its answer, its document or its thread." }
        }, "additionalProperties": false },
        "annotations": { "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
    })]
}

impl Session {
    pub(super) fn read_desk(&self, args: &Value) -> Value {
        let Some(p) = self.pane.as_deref() else {
            return said(
                "This session is not running in a snyvi desk, so there is no desk to read.",
                true,
            );
        };
        let sections: Vec<&str> = args
            .get("sections")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| SECTIONS.iter().any(|k| k == s))
                    .collect()
            })
            .unwrap_or_default();
        let query = arg(args, "query");
        // Words to find are words about decisions: with a query and no
        // sections named, that is the section read.
        let sections = if sections.is_empty() && !query.is_empty() {
            "decisions".to_string()
        } else {
            sections.join(",")
        };
        match client::pane_desk(&self.paths, p, &sections, &query) {
            Ok(v) => json!({
                "content": [{ "type": "text", "text": say_desk(&v) }],
                "structuredContent": v,
                "isError": false
            }),
            Err(e) => said(format!("snyvi could not read the desk: {e}"), true),
        }
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn n(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

fn rows<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// The answer in words, a line a thing: what `read_desk` says. Only the
/// sections the answer carries.
pub(super) fn say_desk(v: &Value) -> String {
    let now = n(v, "now");
    let mut out = vec![format!("Desk \"{}\".", s(v, "desk"))];
    if let Some(f) = v.get("folder") {
        out.extend(say_folder(f, now));
    }
    if v.get("threads").is_some() {
        out.extend(say_threads(rows(v, "threads"), now));
    }
    if v.get("panels").is_some() {
        out.extend(say_panels(rows(v, "panels"), now));
    }
    if let Some(d) = v.get("decisions") {
        out.extend(say_decisions(d, now));
    }
    out.join("\n")
}

fn say_folder(f: &Value, now: i64) -> Vec<String> {
    let trees = rows(f, "worktrees");
    if trees.is_empty() {
        return vec![format!(
            "Folder {}: not a git repository, or git did not answer.",
            s(f, "root")
        )];
    }
    let main = s(f, "main");
    let total = n(f, "total");
    let mut out = vec![format!(
        "Folder {}: {}{}, newest work first{}:",
        s(f, "root"),
        crate::plural(total as usize, "checkout"),
        if (trees.len() as i64) < total {
            format!(" (the newest {})", trees.len())
        } else {
            String::new()
        },
        if main.is_empty() {
            String::new()
        } else {
            format!(", counted against {main}")
        },
    )];
    for t in trees {
        let mut parts = vec![format!(
            "{}{}",
            s(t, "path"),
            if t.get("here") == Some(&Value::Bool(true)) {
                " (this desk's folder)"
            } else {
                ""
            }
        )];
        let branch = s(t, "branch");
        parts.push(if branch.is_empty() {
            "detached".to_string()
        } else {
            branch.to_string()
        });
        let count = |k: &str| t.get(k).and_then(Value::as_i64);
        match (count("behind"), count("ahead")) {
            (Some(0), Some(0)) => parts.push(format!("level with {main}")),
            (Some(b), Some(a)) => {
                let mut c = Vec::new();
                if b > 0 {
                    c.push(format!("{b} behind"));
                }
                if a > 0 {
                    c.push(format!("{a} ahead"));
                }
                parts.push(c.join(", "));
            }
            _ => {}
        }
        if let Some(l) = t.get("last") {
            parts.push(format!(
                "\"{}\", {}",
                s(l, "subject"),
                ago(now - n(l, "at"))
            ));
        }
        out.push(format!("- {}", parts.join(" · ")));
    }
    out
}

fn say_threads(threads: &[Value], now: i64) -> Vec<String> {
    if threads.is_empty() {
        return vec!["Threads: none filed on this desk.".to_string()];
    }
    let mut out = vec!["Threads, the last moved first:".to_string()];
    for t in threads {
        let mut parts = vec![s(t, "name").to_string(), s(t, "stage").to_string()];
        for k in ["folder", "branch"] {
            if !s(t, k).is_empty() {
                parts.push(s(t, k).to_string());
            }
        }
        if !s(t, "pr").is_empty() {
            let state = s(t, "pr_state");
            parts.push(format!(
                "PR {}{}{}",
                s(t, "pr"),
                if state.is_empty() { "" } else { " " },
                state
            ));
        }
        if !s(t, "ci").is_empty() {
            parts.push(format!("CI {}", s(t, "ci")));
        }
        parts.push(if t.get("this_panel") == Some(&Value::Bool(true)) {
            "this panel's".to_string()
        } else if n(t, "panel") > 0 {
            format!("panel {}", n(t, "panel"))
        } else {
            format!("resting: {}", s(t, "rest"))
        });
        if !s(t, "next").is_empty() {
            parts.push(format!("next: {}", s(t, "next")));
        }
        let notes: Vec<String> = rows(t, "notes")
            .iter()
            .filter_map(Value::as_i64)
            .map(|i| format!("#{i}"))
            .collect();
        if !notes.is_empty() {
            parts.push(format!("notes {}", notes.join(" ")));
        }
        parts.push(format!("moved {}", ago(now - n(t, "moved_at"))));
        out.push(format!("- {}", parts.join(" · ")));
    }
    out
}

fn say_panels(panels: &[Value], now: i64) -> Vec<String> {
    let mut out = vec!["Panels:".to_string()];
    for p in panels {
        let mut parts = vec![format!(
            "{}{}{}",
            n(p, "slot"),
            if s(p, "tab").is_empty() {
                String::new()
            } else {
                format!(" in \"{}\"", s(p, "tab"))
            },
            if p.get("this_panel") == Some(&Value::Bool(true)) {
                " (this panel)"
            } else {
                ""
            }
        )];
        if !s(p, "name").is_empty() {
            parts.push(format!("\"{}\"", s(p, "name")));
        }
        parts.push(s(p, "program").to_string());
        let since = n(p, "agent_since");
        let when = if since > 0 {
            format!(", {}", ago(now - since))
        } else {
            String::new()
        };
        parts.push(
            match (p.get("running") == Some(&Value::Bool(true)), s(p, "agent")) {
                (false, _) => "not running".to_string(),
                (true, "working") => format!("working{when}"),
                (true, "needs_you") => format!("waiting on the user{when}"),
                (true, "done") if !s(p, "stopped").is_empty() => {
                    format!("stopped ({}){when}", s(p, "stopped"))
                }
                (true, "done") => format!("turn ended{when}"),
                (true, _) => "running".to_string(),
            },
        );
        if !s(p, "thread").is_empty() {
            parts.push(format!("thread: {}", s(p, "thread")));
        }
        let branch = s(p, "branch");
        parts.push(format!(
            "{}{}{}",
            s(p, "folder"),
            if branch.is_empty() {
                String::new()
            } else {
                format!(" on {branch}")
            },
            if p.get("dirty") == Some(&Value::Bool(true)) {
                ", changed"
            } else {
                ""
            }
        ));
        out.push(format!("- {}", parts.join(" · ")));
    }
    out
}

fn say_decisions(d: &Value, now: i64) -> Vec<String> {
    let c = d.get("counts").cloned().unwrap_or(Value::Null);
    let list = rows(d, "list");
    let query = s(d, "query");
    let oldest = n(&c, "oldest_open_at");
    let mut head = format!(
        "Decisions: {} open{}, {} later, {} answered, {} dropped.",
        n(&c, "open"),
        if oldest > 0 {
            format!(" (the oldest asked {})", ago(now - oldest))
        } else {
            String::new()
        },
        n(&c, "later"),
        n(&c, "answered"),
        n(&c, "dropped"),
    );
    if query.is_empty() {
        if n(&c, "answered") + n(&c, "dropped") > 0 {
            head.push_str(" The open ones and the last settled; pass query to find an older one.");
        }
    } else {
        head.push_str(&format!(" Saying \"{query}\": {}.", list.len()));
    }
    let mut out = vec![head];
    for q in list {
        let under = match (s(q, "doc_title"), s(q, "thread")) {
            ("", "") => String::new(),
            (doc, "") => format!("; under \"{doc}\" ({})", s(q, "doc")),
            ("", thread) => format!("; thread {thread}"),
            (doc, thread) => format!("; under \"{doc}\" ({}), thread {thread}", s(q, "doc")),
        };
        let text = s(q, "text");
        let id = n(q, "id");
        out.push(match s(q, "state") {
            "answered" => format!(
                "- answered #{id} ({}, {}{under}): {text} → \"{}\"",
                if s(q, "answered_in") == "panel" {
                    "in a panel, as the agent heard it"
                } else {
                    "in snyvi"
                },
                ago(now - n(q, "answered_at")),
                s(q, "answer"),
            ),
            "dropped" => format!(
                "- dropped #{id} (the user's Not this{under}): {text}{}",
                if s(q, "answer").is_empty() {
                    String::new()
                } else {
                    format!(" → \"{}\"", s(q, "answer"))
                },
            ),
            state => {
                let options: Vec<&str> = rows(q, "options")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                let pick = usize::try_from(n(q, "recommended"))
                    .ok()
                    .and_then(|i| options.get(i))
                    .map(|o| format!("; recommended: {o}"))
                    .unwrap_or_default();
                format!(
                    "- {state} #{id} (asked {}{under}): {text} [{}{pick}]",
                    ago(now - n(q, "asked_at")),
                    options.join(" | "),
                )
            }
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What an agent reads: a line a thing, the resting thread saying why,
    /// the folder asked about marked, an answer heard in a panel said so.
    #[test]
    fn a_desk_is_said_a_line_a_thing() {
        let now = 1_000_000;
        let v = json!({
            "desk": "snyvi", "now": now,
            "folder": { "root": "~/Projects/snyvi", "main": "origin/main", "total": 41, "worktrees": [
                { "path": "~/Projects/snyvi-1-64", "branch": "claude/release-1-64", "behind": 0, "ahead": 4,
                  "last": { "at": now - 3600, "hash": "c015541", "subject": "1.64.0" } },
                { "path": "~/Projects/snyvi", "branch": "claude/sidebar-polish", "behind": 224, "ahead": 0, "here": true,
                  "last": { "at": now - 30 * 86_400, "hash": "9d8b6e5", "subject": "1.37.0" } }
            ] },
            "threads": [
                { "name": "Release 1.64", "stage": "review", "folder": "~/Projects/snyvi-1-64",
                  "branch": "claude/release-1-64", "rest": "panel closed", "notes": [231], "moved_at": now - 7200 },
                { "name": "read_desk 1.65", "stage": "building", "pr": "133", "pr_state": "open", "ci": "passing",
                  "rest": "", "panel": 2, "this_panel": true, "notes": [], "moved_at": now - 60 }
            ],
            "panels": [
                { "slot": 1, "tab": "Code", "name": "release", "program": "claude", "running": true,
                  "agent": "working", "agent_since": now - 300, "stopped": "", "thread": "",
                  "folder": "~/Projects/snyvi-1-64", "branch": "claude/release-1-64", "dirty": true, "this_panel": false },
                { "slot": 2, "tab": "Code", "name": "", "program": "shell", "running": false, "agent": "",
                  "stopped": "", "thread": "read_desk 1.65", "folder": "~/Projects/snyvi", "branch": "", "dirty": false,
                  "this_panel": true }
            ],
            "decisions": { "query": "", "counts": { "open": 1, "later": 0, "answered": 1, "dropped": 1,
                  "oldest_open_at": now - 2 * 86_400 }, "list": [
                { "id": 911, "state": "open", "text": "Shelf on Home too?", "options": ["Desk only", "Home too"],
                  "recommended": 0, "asked_at": now - 2 * 86_400, "doc": "2d186a80c1", "doc_title": "Plan: read_desk" },
                { "id": 900, "state": "answered", "text": "1.64 first?", "answer": "1.64 first, then 1.65",
                  "answered_in": "panel", "answered_at": now - 3600, "asked_at": now - 7200, "recommended": 0,
                  "thread": "read_desk 1.65" },
                { "id": 890, "state": "dropped", "text": "Telegram bell?", "answer": "not this year",
                  "asked_at": now - 9 * 86_400, "recommended": -1 }
            ] }
        });
        let said = say_desk(&v);
        for line in [
            "Desk \"snyvi\".",
            "Folder ~/Projects/snyvi: 41 checkouts (the newest 2), newest work first, counted against origin/main:",
            "- ~/Projects/snyvi-1-64 · claude/release-1-64 · 4 ahead · \"1.64.0\", 1 h ago",
            "- ~/Projects/snyvi (this desk's folder) · claude/sidebar-polish · 224 behind · \"1.37.0\", 30 days ago",
            "- Release 1.64 · review · ~/Projects/snyvi-1-64 · claude/release-1-64 · resting: panel closed · notes #231 · moved 2 h ago",
            "- read_desk 1.65 · building · PR 133 open · CI passing · this panel's · moved 1 min ago",
            "- 1 in \"Code\" · \"release\" · claude · working, 5 min ago · ~/Projects/snyvi-1-64 on claude/release-1-64, changed",
            "- 2 in \"Code\" (this panel) · shell · not running · thread: read_desk 1.65 · ~/Projects/snyvi",
            "Decisions: 1 open (the oldest asked 2 days ago), 0 later, 1 answered, 1 dropped. The open ones and the last settled; pass query to find an older one.",
            "- open #911 (asked 2 days ago; under \"Plan: read_desk\" (2d186a80c1)): Shelf on Home too? [Desk only | Home too; recommended: Desk only]",
            "- answered #900 (in a panel, as the agent heard it, 1 h ago; thread read_desk 1.65): 1.64 first? → \"1.64 first, then 1.65\"",
            "- dropped #890 (the user's Not this): Telegram bell? → \"not this year\"",
        ] {
            assert!(said.lines().any(|l| l == line), "missing: {line}\n---\n{said}");
        }
        // Only the sections the answer carries.
        let only = say_desk(&json!({ "desk": "snyvi", "now": now, "threads": [] }));
        assert_eq!(only, "Desk \"snyvi\".\nThreads: none filed on this desk.");
        let none = say_desk(&json!({ "desk": "x", "now": now, "folder": { "root": "~/x" } }));
        assert!(none.contains("not a git repository"), "{none}");
    }

    /// The description is in every panel session's list: held short, and it
    /// says the three moments to call it.
    #[test]
    fn the_tool_says_when_to_read_and_takes_only_its_sections() {
        let spec = &specs()[0];
        let d = spec["description"].as_str().unwrap();
        assert!(d.chars().count() <= 500, "{}", d.chars().count());
        for phrase in [
            "when you start",
            "which checkout is live",
            "answered already",
        ] {
            assert!(d.contains(phrase), "{phrase}");
        }
        assert_eq!(
            spec["inputSchema"]["properties"]["sections"]["items"]["enum"],
            json!(["threads", "panels", "folder", "decisions"])
        );
    }
}
