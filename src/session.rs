//! Claude Code session bookkeeping shared by the hook and the MCP server.
//!
//! The hook sees Claude's session id; the MCP server does not. The hook records
//! `cwd -> session` here and the MCP server looks it up per call, so documents
//! from both paths land in the same workflow.
//!
//! Inside a desk's panel both also know the pane (`SNYVI_SESSION`), and the
//! pane is recorded first: four panels on one folder are four conversations,
//! and a map by folder alone handed every one of them the session of
//! whichever prompted last.

use crate::config::Paths;
use serde_json::{json, Value};
use std::path::Path;

const KEEP: usize = 200;

pub fn workflow_key(session_id: &str) -> String {
    format!("claude {}", &session_id[..session_id.len().min(8)])
}

/// The key a pane is recorded under, beside the folder's.
fn pane_key(pane: &str) -> String {
    format!("pane:{pane}")
}

pub fn record(paths: &Paths, cwd: &str, session_id: &str, pane: Option<&str>) {
    let file = paths.config_dir.join("sessions.json");
    let mut map: serde_json::Map<String, Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let now = crate::store::now();
    let mut keys = vec![canon(cwd)];
    keys.extend(pane.map(pane_key));
    // The same session, recorded within the hour: nothing to write. `at` is
    // only what the oldest are dropped by, and an hour does not change that.
    let fresh = |key: &String| {
        map.get(key).is_some_and(|v| {
            v.get("id").and_then(Value::as_str) == Some(session_id)
                && v.get("at")
                    .and_then(Value::as_i64)
                    .is_some_and(|at| now - at < 3600)
        })
    };
    if keys.iter().all(fresh) {
        return;
    }
    for key in keys {
        map.insert(key, json!({ "id": session_id, "at": now }));
    }
    if map.len() > KEEP {
        let mut entries: Vec<(String, i64)> = map
            .iter()
            .map(|(k, v)| (k.clone(), v.get("at").and_then(Value::as_i64).unwrap_or(0)))
            .collect();
        entries.sort_by_key(|(_, at)| *at);
        for (k, _) in entries.into_iter().take(map.len() - KEEP) {
            map.remove(&k);
        }
    }
    // Through a file of this process's own and a rename: every session's
    // hook writes here, and one that read the map half-written parsed it as
    // empty and wrote that back, taking every other session's entry with it.
    let _ = std::fs::create_dir_all(&paths.config_dir);
    let tmp = paths
        .config_dir
        .join(format!("sessions.json.{}.tmp", std::process::id()));
    if std::fs::write(&tmp, Value::Object(map).to_string()).is_ok()
        && std::fs::rename(&tmp, &file).is_err()
    {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// The session recorded for this pane, or else the most recent one for this
/// directory or one of its parents.
pub fn lookup(paths: &Paths, cwd: &str, pane: Option<&str>) -> Option<String> {
    let file = paths.config_dir.join("sessions.json");
    let map: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let map = map.as_object()?;
    if let Some(v) = pane.and_then(|p| map.get(&pane_key(p))) {
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    let mut dir = Some(Path::new(&canon(cwd)).to_path_buf());
    while let Some(d) = dir {
        if let Some(v) = map.get(&d.to_string_lossy().to_string()) {
            return v.get("id").and_then(Value::as_str).map(str::to_string);
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

fn canon(p: &str) -> String {
    Path::new(p)
        .canonicalize()
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tempdir::Dir;

    #[test]
    fn record_and_lookup_walks_parents() {
        let d = Dir::new("snyvi-sess");
        let paths = Paths {
            data_dir: d.path.clone(),
            config_dir: d.path.clone(),
            docs_dir: d.path.join("docs"),
            db_path: d.path.join("t.db"),
            token_path: d.path.join("token"),
        };
        let proj = d.path.join("proj");
        std::fs::create_dir_all(proj.join("sub")).unwrap();
        record(&paths, proj.to_str().unwrap(), "abcdef12-3456-7890", None);
        assert_eq!(
            lookup(&paths, proj.join("sub").to_str().unwrap(), None).as_deref(),
            Some("abcdef12-3456-7890")
        );
        assert!(lookup(&paths, d.path.to_str().unwrap(), None).is_none());
        assert_eq!(workflow_key("abcdef12-3456-7890"), "claude abcdef12");
        // The same session again leaves the file as it is; a new one in the
        // same folder takes its place, and no file of the write is left over.
        let file = d.path.join("sessions.json");
        // (Spaced out by hand, as a rewrite would not leave it.)
        let spaced = std::fs::read_to_string(&file)
            .unwrap()
            .replacen('{', "{ ", 1);
        std::fs::write(&file, &spaced).unwrap();
        record(&paths, proj.to_str().unwrap(), "abcdef12-3456-7890", None);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), spaced);
        record(&paths, proj.to_str().unwrap(), "99999999-3456-7890", None);
        assert_eq!(
            lookup(&paths, proj.to_str().unwrap(), None).as_deref(),
            Some("99999999-3456-7890")
        );
        assert!(!std::fs::read_dir(&d.path).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    /// Four panels on one folder: each keeps its own conversation, and a
    /// panel that has none falls back to the folder's.
    #[test]
    fn a_pane_keeps_its_own_session_over_the_folders() {
        let d = Dir::new("snyvi-sess-pane");
        let paths = Paths {
            data_dir: d.path.clone(),
            config_dir: d.path.clone(),
            docs_dir: d.path.join("docs"),
            db_path: d.path.join("t.db"),
            token_path: d.path.join("token"),
        };
        let root = d.path.to_str().unwrap();
        record(&paths, root, "aaaaaaaa-1", Some("p1"));
        record(&paths, root, "bbbbbbbb-2", Some("p2"));
        assert_eq!(lookup(&paths, root, Some("p1")).as_deref(), Some("aaaaaaaa-1"));
        assert_eq!(lookup(&paths, root, Some("p2")).as_deref(), Some("bbbbbbbb-2"));
        // No pane, or one that never prompted: the folder's latest.
        assert_eq!(lookup(&paths, root, None).as_deref(), Some("bbbbbbbb-2"));
        assert_eq!(lookup(&paths, root, Some("p3")).as_deref(), Some("bbbbbbbb-2"));
    }
}
