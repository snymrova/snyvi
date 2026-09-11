//! Claude Code session bookkeeping shared by the hook and the MCP server.
//!
//! The hook sees Claude's session id; the MCP server does not. The hook records
//! `cwd -> session` here and the MCP server looks it up per call, so documents
//! from both paths land in the same workflow.

use crate::config::Paths;
use serde_json::{json, Value};
use std::path::Path;

const KEEP: usize = 200;

pub fn workflow_key(session_id: &str) -> String {
    format!("claude {}", &session_id[..session_id.len().min(8)])
}

pub fn record(paths: &Paths, cwd: &str, session_id: &str) {
    let file = paths.config_dir.join("sessions.json");
    let mut map: serde_json::Map<String, Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let now = crate::store::now();
    map.insert(canon(cwd), json!({ "id": session_id, "at": now }));
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
    let _ = std::fs::create_dir_all(&paths.config_dir);
    let _ = std::fs::write(&file, Value::Object(map).to_string());
}

/// The most recent session recorded for this directory or one of its parents.
pub fn lookup(paths: &Paths, cwd: &str) -> Option<String> {
    let file = paths.config_dir.join("sessions.json");
    let map: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let map = map.as_object()?;
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
        record(&paths, proj.to_str().unwrap(), "abcdef12-3456-7890");
        assert_eq!(
            lookup(&paths, proj.join("sub").to_str().unwrap()).as_deref(),
            Some("abcdef12-3456-7890")
        );
        assert!(lookup(&paths, d.path.to_str().unwrap()).is_none());
        assert_eq!(workflow_key("abcdef12-3456-7890"), "claude abcdef12");
    }
}
