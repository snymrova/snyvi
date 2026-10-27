//! What GitHub's own CLI says about a thread's PR: open, merged or closed,
//! the merge and who made it, the branch it came from, and its checks.
//!
//! A merge used to be guessed from git -- the first merge on main that took
//! a branch's tip -- and the branch a thread had was whatever the panel last
//! committed on, so a thread was credited with another PR's merge (plan
//! 1.43, #167). The PR is the fact; `gh` is how the reader already talks to
//! it, signed in as them. snyvi holds no token and asks nothing it could not
//! ask with the reader's own `gh pr view`.
//!
//! Blocking, through `git::run_for`'s care (no prompt, no window, a wait it
//! gives up after). No gh, or gh signed out: every call is None, and the
//! thread falls back to git's guess (`thread::landed`), as before 1.43.

use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// gh goes to the network: longer than a local git command may take.
const WAIT: Duration = Duration::from_secs(12);

/// A PR as `gh pr view` says it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pr {
    /// `open`, `merged` or `closed`.
    pub state: String,
    /// The merge commit, once merged.
    pub merge: String,
    /// Who merged it, by GitHub login.
    pub merged_by: String,
    pub merged_at: i64,
    /// The branch it is from.
    pub head: String,
    /// The checks as one word, as the mod says them: `9/13`, `passing`, `failing`.
    pub ci: String,
    /// The PR's page.
    pub url: String,
    /// The desk notes its commits name (`git::named_in`): what its merge
    /// closes. None when gh did not list the commits.
    pub named: Option<Vec<i64>>,
}

fn gh(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::git::run_for("gh", dir, args, WAIT);
    if out.is_none() {
        said_once();
    }
    out
}

/// The daemon's log says once why no PR is read, rather than once a sweep.
fn said_once() {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
        eprintln!("snyvi: gh gave no answer (not installed, signed out, or offline); merges are read from git");
    }
}

/// PR `n` (digits), asked in `dir`, a folder of its repository.
pub fn view(dir: &Path, n: &str) -> Option<Pr> {
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let out = gh(
        dir,
        &[
            "pr",
            "view",
            n,
            "--json",
            "state,mergeCommit,mergedBy,mergedAt,headRefName,statusCheckRollup,url,commits",
        ],
    )?;
    parse_view(&out)
}

/// The newest PR from `branch`, in any state: a thread whose PR was opened
/// on GitHub's page, or whose branch was set right only now. Its number.
pub fn by_head(dir: &Path, branch: &str) -> Option<String> {
    if !crate::thread::branch_ok(branch) {
        return None;
    }
    let out = gh(
        dir,
        &[
            "pr", "list", "--state", "all", "--head", branch, "--json", "number", "--limit", "1",
        ],
    )?;
    let v: Value = serde_json::from_str(&out).ok()?;
    v.get(0)?.get("number")?.as_u64().map(|n| n.to_string())
}

/// Who the reader is on GitHub, as gh is signed in: whose merge ticks a
/// thread's notes. Asked once a run; a failed ask is asked again after a
/// while, since gh may be signed in by then.
pub fn viewer(dir: &Path) -> Option<String> {
    static KNOWN: Mutex<(Option<String>, Option<Instant>)> = Mutex::new((None, None));
    {
        let k = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
        if k.0.is_some() {
            return k.0.clone();
        }
        if k.1
            .is_some_and(|at| at.elapsed() < Duration::from_secs(600))
        {
            return None;
        }
    }
    let login = gh(dir, &["api", "user", "--jq", ".login"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= 64 && !s.contains(char::is_whitespace));
    let mut k = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
    *k = (login.clone(), Some(Instant::now()));
    login
}

pub fn parse_view(out: &str) -> Option<Pr> {
    let v: Value = serde_json::from_str(out).ok()?;
    let s = |p: &[&str]| {
        p.iter()
            .try_fold(&v, |v, k| v.get(*k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let state = match s(&["state"]).as_str() {
        "OPEN" => "open",
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ => return None,
    };
    let rollup = v
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(Pr {
        state: state.into(),
        merge: s(&["mergeCommit", "oid"]).to_ascii_lowercase(),
        merged_by: s(&["mergedBy", "login"]),
        merged_at: iso_secs(&s(&["mergedAt"])).unwrap_or(0),
        head: s(&["headRefName"]),
        ci: ci_of(&rollup),
        url: s(&["url"]),
        named: v
            .get("commits")
            .and_then(Value::as_array)
            .map(|cs| named_by(cs)),
    })
}

/// The notes a PR's commits name, each once, in the order first named.
/// GitHub cuts a long subject with "…" and goes on with "…" in the body: the
/// two halves are one line again, or a "(#194-#195)" across the cut is lost.
fn named_by(commits: &[Value]) -> Vec<i64> {
    let s = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut ids: Vec<i64> = Vec::new();
    for c in commits {
        let (head, body) = (s(c, "messageHeadline"), s(c, "messageBody"));
        let msg = match (head.strip_suffix('…'), body.strip_prefix('…')) {
            (Some(h), Some(b)) => format!("{h}{b}"),
            _ => format!("{head}\n{body}"),
        };
        for n in crate::git::named_in(&msg) {
            if !ids.contains(&n) {
                ids.push(n);
            }
        }
    }
    ids
}

/// The checks as one word, the mod's `ciOf` in Rust: `9/13` while running,
/// `failing` when one failed, `passing` when all are done and none failed.
pub fn ci_of(rollup: &[Value]) -> String {
    if rollup.is_empty() {
        return String::new();
    }
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let bad = rollup.iter().any(|r| {
        let c = s(r, "conclusion");
        let c = if c.is_empty() { s(r, "state") } else { c };
        ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].contains(&c.as_str())
    });
    if bad {
        return "failing".into();
    }
    let done = rollup
        .iter()
        .filter(|r| {
            let st = s(r, "status");
            st.is_empty() || st == "COMPLETED" || !s(r, "state").is_empty()
        })
        .count();
    if done < rollup.len() {
        format!("{done}/{}", rollup.len())
    } else {
        "passing".into()
    }
}

/// `2026-10-15T19:20:56Z` as seconds since the epoch: the one shape GitHub
/// gives a time in.
pub fn iso_secs(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[10] != b'T' || !t.ends_with('Z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What its merge closes: the notes its commits name, each once; not a
    /// PR's own number. None when gh listed no commits.
    #[test]
    fn a_pr_says_which_notes_its_commits_name() {
        let p = parse_view(r#"{"state":"MERGED","commits":[{"messageHeadline":"Fold the rail (#129-#131)","messageBody":"Fixes PR #79 too"},{"messageHeadline":"Icons (#131, #153)","messageBody":""}]}"#).unwrap();
        assert_eq!(p.named, Some(vec![129, 130, 131, 153]));
        let p = parse_view(r#"{"state":"OPEN"}"#).unwrap();
        assert_eq!(p.named, None);
        let cut = parse_view(r#"{"state":"MERGED","commits":[{"messageHeadline":"A copy keeps its Markdown (#19…","messageBody":"…4-#195)\n\nCo-Authored-By: x"}]}"#).unwrap();
        assert_eq!(cut.named, Some(vec![194, 195]));
    }

    #[test]
    fn a_merged_pr_says_who_and_when() {
        let p = parse_view(r#"{"headRefName":"claude/foot-cards","mergeCommit":{"oid":"5294D9E8EC86AF8C7631F23F3098D54A612DB5CD"},"mergedAt":"2026-10-15T19:20:56Z","mergedBy":{"login":"snymrova"},"state":"MERGED","statusCheckRollup":[]}"#).unwrap();
        assert_eq!(p.state, "merged");
        assert_eq!(p.merge, "5294d9e8ec86af8c7631f23f3098d54a612db5cd");
        assert_eq!(p.merged_by, "snymrova");
        assert_eq!(p.merged_at, 1792092056);
        assert_eq!(p.head, "claude/foot-cards");
        assert_eq!(p.ci, "");
    }

    #[test]
    fn an_open_pr_has_its_checks() {
        let p = parse_view(r#"{"state":"OPEN","mergeCommit":null,"mergedBy":null,"mergedAt":null,"headRefName":"b","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":""}]}"#).unwrap();
        assert_eq!(
            (p.state.as_str(), p.ci.as_str(), p.merge.as_str()),
            ("open", "1/2", "")
        );
        assert!(parse_view(r#"{"state":"DRAFTY"}"#).is_none());
        assert!(parse_view("not json").is_none());
    }

    #[test]
    fn checks_in_one_word() {
        let v: Vec<Value> = serde_json::from_str(
            r#"[{"status":"COMPLETED","conclusion":"FAILURE"},{"status":"QUEUED"}]"#,
        )
        .unwrap();
        assert_eq!(ci_of(&v), "failing");
        let v: Vec<Value> = serde_json::from_str(
            r#"[{"status":"COMPLETED","conclusion":"SUCCESS"},{"state":"SUCCESS"}]"#,
        )
        .unwrap();
        assert_eq!(ci_of(&v), "passing");
    }

    #[test]
    fn times_from_github() {
        assert_eq!(iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_secs("2000-03-01T00:00:00Z"), Some(951868800));
        assert_eq!(iso_secs("2026-10-15T19:20:56Z"), Some(1792092056));
        assert_eq!(iso_secs("yesterday"), None);
    }
}
