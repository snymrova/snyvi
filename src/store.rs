//! On-disk store: one source and one rendered HTML file per document,
//! plus a SQLite index with full-text search.

use crate::config::Paths;
use crate::render::Kind;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
pub struct Doc {
    pub id: String,
    pub project_id: i64,
    pub project: String,
    pub workflow_id: i64,
    pub workflow: String,
    pub workflow_title: String,
    pub title: String,
    pub kind: Kind,
    pub lang: Option<String>,
    pub size: i64,
    pub received_at: i64,
    pub source_path: Option<String>,
    pub branch: Option<String>,
    pub pinned: bool,
    pub origin: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeDoc {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub received_at: i64,
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeWorkflow {
    pub id: i64,
    pub key: String,
    pub title: String,
    pub docs: Vec<TreeDoc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeProject {
    pub id: i64,
    pub name: String,
    pub root: String,
    pub workflows: Vec<TreeWorkflow>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub id: String,
    pub title: String,
    pub project: String,
    pub workflow_title: String,
    pub kind: Kind,
    pub received_at: i64,
    pub snippet: String,
}

pub struct NewDoc<'a> {
    pub project_root: &'a str,
    pub project_name: &'a str,
    pub workflow_key: &'a str,
    pub workflow_title: &'a str,
    pub title: &'a str,
    pub kind: Kind,
    pub lang: Option<&'a str>,
    pub source_path: Option<&'a str>,
    pub branch: Option<&'a str>,
    pub origin: &'a str,
    /// The document body as stored. Bytes, not text, so an image or any other
    /// binary keeps exactly what arrived instead of a lossy decode.
    pub source: &'a [u8],
    /// What search indexes. Empty for a body with no text in it.
    pub search_body: &'a str,
    pub html: &'a str,
}

pub struct Store {
    conn: Mutex<Connection>,
    docs_dir: PathBuf,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  renamed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, key)
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  lang TEXT,
  size INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source_path TEXT,
  branch TEXT,
  content_hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX IF NOT EXISTS docs_recv ON docs(received_at DESC);
CREATE INDEX IF NOT EXISTS docs_wf ON docs(workflow_id, received_at);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61');
"#;

const DOC_COLS: &str = "d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch, d.pinned, d.origin, d.content_hash";
const DOC_FROM: &str =
    "FROM docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id";

impl Store {
    pub fn open(paths: &Paths) -> Result<Store> {
        fs::create_dir_all(&paths.data_dir).context("creating data dir")?;
        fs::create_dir_all(&paths.docs_dir).context("creating docs dir")?;
        let conn = Connection::open(&paths.db_path).context("opening database")?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        conn.execute_batch(SCHEMA)?;
        // Migrations for databases created before these columns existed.
        // Keys used to be case-sensitive, so the same workflow could exist twice.
        // Fold the duplicates into the oldest row; harmless once there are none.
        conn.execute_batch(
            "UPDATE docs SET workflow_id = (
                 SELECT MIN(w2.id) FROM workflows w2
                 JOIN workflows w1 ON w1.id = docs.workflow_id
                 WHERE w2.project_id = w1.project_id AND LOWER(w2.key) = LOWER(w1.key)
             );
             DELETE FROM workflows WHERE id NOT IN (SELECT DISTINCT workflow_id FROM docs);
             UPDATE workflows SET key = LOWER(key) WHERE key <> LOWER(key);",
        )
        .ok();
        for stmt in [
            "ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE docs ADD COLUMN origin TEXT NOT NULL DEFAULT 'cli'",
            "ALTER TABLE projects ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = conn.execute_batch(stmt);
        }
        Ok(Store {
            conn: Mutex::new(conn),
            docs_dir: paths.docs_dir.clone(),
        })
    }

    fn src_path(&self, id: &str) -> PathBuf {
        self.docs_dir.join(format!("{id}.src"))
    }
    fn html_path(&self, id: &str) -> PathBuf {
        self.docs_dir.join(format!("{id}.html"))
    }

    pub fn insert(&self, id: &str, d: NewDoc) -> Result<Doc> {
        let now = now();
        let hash = blake3::hash(d.source).to_hex().to_string();
        let id = id.to_string();
        // Files first, so a crash never leaves a row without a body.
        fs::write(self.src_path(&id), d.source)?;
        fs::write(self.html_path(&id), d.html)?;

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        // The derived name follows the directory, so it refreshes on every send —
        // unless the user has named this project themselves, which outranks it.
        tx.execute(
            "INSERT INTO projects(root, name, created_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(root) DO UPDATE SET name = excluded.name WHERE projects.renamed = 0",
            params![d.project_root, d.project_name, now],
        )?;
        let (project_id, project_name): (i64, String) = tx.query_row(
            "SELECT id, name FROM projects WHERE root = ?1",
            params![d.project_root],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "INSERT INTO workflows(project_id, key, title, created_at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, key) DO NOTHING",
            params![project_id, d.workflow_key, d.workflow_title, now],
        )?;
        let (workflow_id, workflow_title): (i64, String) = tx.query_row(
            "SELECT id, title FROM workflows WHERE project_id = ?1 AND key = ?2",
            params![project_id, d.workflow_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "INSERT INTO docs(id, project_id, workflow_id, title, kind, lang, size, received_at, source_path, branch, content_hash, pinned, origin)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)",
            params![id, project_id, workflow_id, d.title, d.kind.as_str(), d.lang, d.source.len() as i64, now, d.source_path, d.branch, hash, d.origin],
        )?;
        tx.execute(
            "INSERT INTO docs_fts(id, title, body) VALUES(?1, ?2, ?3)",
            params![id, d.title, d.search_body],
        )?;
        tx.commit()?;
        Ok(Doc {
            id,
            project_id,
            project: project_name,
            workflow_id,
            workflow: d.workflow_key.to_string(),
            workflow_title,
            title: d.title.to_string(),
            kind: d.kind,
            lang: d.lang.map(str::to_string),
            size: d.source.len() as i64,
            received_at: now,
            source_path: d.source_path.map(str::to_string),
            branch: d.branch.map(str::to_string),
            pinned: false,
            origin: d.origin.to_string(),
            content_hash: hash,
        })
    }

    /// Overwrite an existing document's content in place (used to coalesce rapid
    /// hook-driven edits of the same file into one snapshot).
    pub fn replace(&self, id: &str, d: NewDoc) -> Result<Doc> {
        let now = now();
        let hash = blake3::hash(d.source).to_hex().to_string();
        fs::write(self.src_path(id), d.source)?;
        fs::write(self.html_path(id), d.html)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE docs SET title = ?2, kind = ?3, lang = ?4, size = ?5, received_at = ?6, branch = ?7, content_hash = ?8 WHERE id = ?1",
            params![id, d.title, d.kind.as_str(), d.lang, d.source.len() as i64, now, d.branch, hash],
        )?;
        conn.execute("DELETE FROM docs_fts WHERE id = ?1", params![id])?;
        conn.execute(
            "INSERT INTO docs_fts(id, title, body) VALUES(?1, ?2, ?3)",
            params![id, d.title, d.search_body],
        )?;
        drop(conn);
        self.get(id)?.context("replaced document vanished")
    }

    pub fn replace_html(&self, id: &str, html: &str) -> Result<()> {
        Ok(fs::write(self.html_path(id), html)?)
    }

    pub fn get(&self, id: &str) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {DOC_COLS} {DOC_FROM} WHERE d.id = ?1"),
            params![id],
            row_to_doc,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn html(&self, id: &str) -> Result<String> {
        Ok(fs::read_to_string(self.html_path(id))?)
    }

    pub fn source(&self, id: &str) -> Result<String> {
        Ok(fs::read_to_string(self.src_path(id))?)
    }

    /// The stored body exactly as it arrived, for images and anything else binary.
    pub fn source_bytes(&self, id: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.src_path(id))?)
    }

    /// The document received just before this one in the same workflow.
    pub fn previous(&self, doc: &Doc) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {DOC_COLS} {DOC_FROM} WHERE d.workflow_id = ?1 AND d.id != ?3 \
                 AND (d.received_at < ?2 OR (d.received_at = ?2 AND d.rowid < (SELECT rowid FROM docs WHERE id = ?3))) \
                 ORDER BY d.received_at DESC, d.rowid DESC LIMIT 1"),
            params![doc.workflow_id, doc.received_at, doc.id],
            row_to_doc,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Most recent document in a project for a given source path.
    pub fn latest_for_path(&self, project_root: &str, source_path: &str) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {DOC_COLS} {DOC_FROM} WHERE p.root = ?1 AND d.source_path = ?2 ORDER BY d.received_at DESC, d.rowid DESC LIMIT 1"),
            params![project_root, source_path],
            row_to_doc,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn delete(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM docs_fts WHERE id = ?1", params![id])?;
        let n = tx.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
        tx.execute(
            "DELETE FROM workflows WHERE id NOT IN (SELECT DISTINCT workflow_id FROM docs)",
            [],
        )?;
        tx.execute(
            "DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM docs)",
            [],
        )?;
        tx.commit()?;
        drop(conn);
        let _ = fs::remove_file(self.src_path(id));
        let _ = fs::remove_file(self.html_path(id));
        Ok(n > 0)
    }

    /// Every snapshot of one file in a project, newest first.
    pub fn history(&self, project_id: i64, source_path: &str) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&format!("SELECT {DOC_COLS} {DOC_FROM} WHERE d.project_id = ?1 AND d.source_path = ?2 ORDER BY d.received_at DESC, d.rowid DESC"))?
            .query_map(params![project_id, source_path], row_to_doc)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE docs SET pinned = ?2 WHERE id = ?1",
            params![id, pinned as i64],
        )? > 0)
    }

    /// Name a project yourself. The directory it was derived from is its identity and
    /// does not move, so sends keep landing here; `renamed` stops the derived name
    /// from reclaiming the label on the next one.
    pub fn rename_project(&self, id: i64, name: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE projects SET name = ?2, renamed = 1 WHERE id = ?1",
            params![id, name],
        )? > 0)
    }

    /// Title a workflow yourself, replacing the guess taken from its first document.
    /// The key stays as it was, so the session that owns it still lands here.
    pub fn rename_workflow(&self, id: i64, title: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE workflows SET title = ?2 WHERE id = ?1",
            params![id, title],
        )? > 0)
    }

    /// Delete unpinned documents received before `before`. Returns what was (or would be) removed.
    pub fn prune(&self, before: i64, dry_run: bool) -> Result<Vec<(String, String)>> {
        let mut conn = self.conn.lock().unwrap();
        let victims: Vec<(String, String)> = conn
            .prepare("SELECT id, title FROM docs WHERE pinned = 0 AND received_at < ?1 ORDER BY received_at")?
            .query_map(params![before], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<_, _>>()?;
        if dry_run || victims.is_empty() {
            return Ok(victims);
        }
        let tx = conn.transaction()?;
        for (id, _) in &victims {
            tx.execute("DELETE FROM docs_fts WHERE id = ?1", params![id])?;
            tx.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
        }
        tx.execute(
            "DELETE FROM workflows WHERE id NOT IN (SELECT DISTINCT workflow_id FROM docs)",
            [],
        )?;
        tx.execute(
            "DELETE FROM projects WHERE id NOT IN (SELECT DISTINCT project_id FROM docs)",
            [],
        )?;
        tx.commit()?;
        drop(conn);
        for (id, _) in &victims {
            let _ = fs::remove_file(self.src_path(id));
            let _ = fs::remove_file(self.html_path(id));
        }
        Ok(victims)
    }

    pub fn tree(&self) -> Result<Vec<TreeProject>> {
        let conn = self.conn.lock().unwrap();
        let mut projects: Vec<TreeProject> = conn
            .prepare("SELECT id, name, root FROM projects ORDER BY (SELECT MAX(received_at) FROM docs WHERE project_id = projects.id) DESC")?
            .query_map([], |r| Ok(TreeProject { id: r.get(0)?, name: r.get(1)?, root: r.get(2)?, workflows: vec![] }))?
            .collect::<std::result::Result<_, _>>()?;
        let mut wf_stmt = conn.prepare(
            "SELECT id, key, title FROM workflows WHERE project_id = ?1
             ORDER BY (SELECT MAX(received_at) FROM docs WHERE workflow_id = workflows.id) DESC",
        )?;
        let mut doc_stmt = conn.prepare("SELECT id, title, kind, received_at, pinned FROM docs WHERE workflow_id = ?1 ORDER BY received_at DESC, rowid DESC")?;
        for p in &mut projects {
            let wfs = wf_stmt
                .query_map(params![p.id], |r| {
                    Ok(TreeWorkflow {
                        id: r.get(0)?,
                        key: r.get(1)?,
                        title: r.get(2)?,
                        docs: vec![],
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for mut w in wfs {
                w.docs = doc_stmt
                    .query_map(params![w.id], |r| {
                        Ok(TreeDoc {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            kind: Kind::parse(&r.get::<_, String>(2)?).unwrap_or(Kind::Text),
                            received_at: r.get(3)?,
                            pinned: r.get::<_, i64>(4)? != 0,
                        })
                    })?
                    .collect::<std::result::Result<_, _>>()?;
                if !w.docs.is_empty() {
                    p.workflows.push(w);
                }
            }
        }
        projects.retain(|p| !p.workflows.is_empty());
        Ok(projects)
    }

    pub fn inbox(&self, limit: usize) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&format!(
                "SELECT {DOC_COLS} {DOC_FROM} ORDER BY d.received_at DESC, d.rowid DESC LIMIT ?1"
            ))?
            .query_map(params![limit as i64], row_to_doc)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Full-text search. `p:name` and `kind:x` prefixes in the query filter by project and kind.
    pub fn search(&self, q: &str, limit: usize) -> Result<Vec<Hit>> {
        let mut project: Option<String> = None;
        let mut kind: Option<String> = None;
        let mut terms: Vec<String> = vec![];
        for t in q.split_whitespace() {
            if let Some(v) = t.strip_prefix("p:").or_else(|| t.strip_prefix("project:")) {
                project = Some(v.to_string());
            } else if let Some(v) = t.strip_prefix("kind:").or_else(|| t.strip_prefix("k:")) {
                kind = Some(match v {
                    "md" => "markdown".to_string(),
                    "txt" => "text".to_string(),
                    other => other.to_string(),
                });
            } else {
                // Quote each term so punctuation in user input cannot break FTS syntax.
                terms.push(format!("\"{}\"*", t.replace('"', "\"\"")));
            }
        }
        if terms.is_empty() && project.is_none() && kind.is_none() {
            return Ok(vec![]);
        }
        let mut sql =
            String::from("SELECT d.id, d.title, p.name, w.title, d.kind, d.received_at, ");
        let filtered_only = terms.is_empty();
        if filtered_only {
            sql.push_str("'' FROM docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id WHERE 1=1");
        } else {
            sql.push_str(
                "snippet(docs_fts, 2, '<mark>', '</mark>', '…', 14) FROM docs_fts f JOIN docs d ON d.id = f.id \
                 JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id WHERE docs_fts MATCH ?1",
            );
        }
        let query = terms.join(" ");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        if !filtered_only {
            args.push(Box::new(query));
        }
        if let Some(p) = &project {
            sql.push_str(&format!(" AND p.name LIKE ?{}", args.len() + 1));
            args.push(Box::new(format!("{p}%")));
        }
        if let Some(k) = &kind {
            sql.push_str(&format!(" AND d.kind = ?{}", args.len() + 1));
            args.push(Box::new(k.clone()));
        }
        sql.push_str(if filtered_only {
            " ORDER BY d.received_at DESC, d.rowid DESC"
        } else {
            " ORDER BY bm25(docs_fts, 4.0, 1.0)"
        });
        sql.push_str(&format!(" LIMIT ?{}", args.len() + 1));
        args.push(Box::new(limit as i64));
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&sql)?
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())),
                |r| {
                    Ok(Hit {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        project: r.get(2)?,
                        workflow_title: r.get(3)?,
                        kind: Kind::parse(&r.get::<_, String>(4)?).unwrap_or(Kind::Text),
                        received_at: r.get(5)?,
                        snippet: r.get(6)?,
                    })
                },
            )?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn count(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))?)
    }
}

fn row_to_doc(r: &rusqlite::Row) -> rusqlite::Result<Doc> {
    Ok(Doc {
        id: r.get(0)?,
        project_id: r.get(1)?,
        project: r.get(2)?,
        workflow_id: r.get(3)?,
        workflow: r.get(4)?,
        workflow_title: r.get(5)?,
        title: r.get(6)?,
        kind: Kind::parse(&r.get::<_, String>(7)?).unwrap_or(Kind::Text),
        lang: r.get(8)?,
        size: r.get(9)?,
        received_at: r.get(10)?,
        source_path: r.get(11)?,
        branch: r.get(12)?,
        pinned: r.get::<_, i64>(13)? != 0,
        origin: r.get(14)?,
        content_hash: r.get(15)?,
    })
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 10 hex chars: content hash mixed with time and a counter, so re-sending identical
/// content still gets a new id and two sends in the same second never collide.
pub fn new_id(hash: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let mixed = blake3::hash(format!("{hash}:{}:{}:{n}", now(), std::process::id()).as_bytes());
    mixed.to_hex()[..10].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Store, tempdir::Dir) {
        let dir = tempdir::Dir::new("snyvi-store");
        let paths = Paths {
            data_dir: dir.path.clone(),
            config_dir: dir.path.clone(),
            docs_dir: dir.path.join("docs"),
            db_path: dir.path.join("t.db"),
            token_path: dir.path.join("token"),
        };
        (Store::open(&paths).unwrap(), dir)
    }

    fn new_doc<'a>(title: &'a str, src: &'a str, wf: &'a str) -> NewDoc<'a> {
        NewDoc {
            project_root: "/p",
            project_name: "p",
            workflow_key: wf,
            workflow_title: wf,
            title,
            kind: Kind::Markdown,
            lang: None,
            source_path: Some("/p/PLAN.md"),
            branch: None,
            origin: "cli",
            source: src.as_bytes(),
            search_body: src,
            html: "<p>x</p>",
        }
    }

    #[test]
    fn insert_get_previous_search() {
        let (s, _d) = temp_store();
        let a = s
            .insert(&new_id("a"), new_doc("Plan", "# Plan\n\nalpha bravo", "w"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = s
            .insert(
                &new_id("b"),
                new_doc("Plan", "# Plan\n\nalpha charlie", "w"),
            )
            .unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(s.get(&b.id).unwrap().unwrap().title, "Plan");
        assert_eq!(s.previous(&b).unwrap().unwrap().id, a.id);
        assert!(s.previous(&a).unwrap().is_none());
        let hits = s.search("charlie", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, b.id);
        assert!(
            s.search("\"unbalanced", 10).is_ok(),
            "punctuation must not break FTS"
        );
        assert_eq!(
            s.latest_for_path("/p", "/p/PLAN.md").unwrap().unwrap().id,
            b.id
        );
        assert_eq!(s.tree().unwrap()[0].workflows[0].docs.len(), 2);
    }

    #[test]
    fn a_chosen_project_name_outranks_the_derived_one() {
        let (s, _d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("Plan", "one", "w")).unwrap();
        assert_eq!(a.project, "p");

        // The derived name follows the directory, so a send still refreshes it...
        let mut d = new_doc("Plan", "two", "w");
        d.project_name = "p-moved";
        let b = s.insert(&new_id("b"), d).unwrap();
        assert_eq!(b.project, "p-moved");

        // ...until it is named by hand, after which no send may reclaim the label.
        assert!(s.rename_project(b.project_id, "Auth work").unwrap());
        let mut d = new_doc("Plan", "three", "w");
        d.project_name = "p-moved-again";
        let c = s.insert(&new_id("c"), d).unwrap();
        assert_eq!(c.project_id, a.project_id, "the root is still the identity");
        assert_eq!(c.project, "Auth work");
        assert_eq!(s.tree().unwrap()[0].name, "Auth work");
        assert!(!s.rename_project(9999, "nobody").unwrap());
    }

    #[test]
    fn a_renamed_workflow_keeps_the_key_that_sends_find_it_by() {
        let (s, _d) = temp_store();
        let a = s
            .insert(&new_id("a"), new_doc("Plan", "one", "sess-1"))
            .unwrap();
        assert_eq!(a.workflow_title, "sess-1");
        assert!(s.rename_workflow(a.workflow_id, "Auth refactor").unwrap());

        let b = s
            .insert(&new_id("b"), new_doc("Plan 2", "two", "sess-1"))
            .unwrap();
        assert_eq!(b.workflow_id, a.workflow_id, "same session, same workflow");
        assert_eq!(b.workflow_title, "Auth refactor");
        let t = s.tree().unwrap();
        assert_eq!(t[0].workflows[0].title, "Auth refactor");
        assert_eq!(t[0].workflows[0].key, "sess-1");
        assert!(!s.rename_workflow(9999, "nobody").unwrap());
    }

    #[test]
    fn same_second_documents_keep_their_order() {
        // received_at counts whole seconds, so insertion order is the tiebreaker.
        let (s, _d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("A", "first", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "second", "w")).unwrap();
        let c = s.insert(&new_id("c"), new_doc("C", "third", "w")).unwrap();
        assert_eq!(
            a.received_at, c.received_at,
            "this test needs them in one second"
        );
        let order: Vec<String> = s.inbox(9).unwrap().into_iter().map(|d| d.title).collect();
        assert_eq!(
            order,
            vec!["C", "B", "A"],
            "newest first even within a second"
        );
        assert_eq!(s.previous(&c).unwrap().unwrap().id, b.id);
        assert_eq!(s.previous(&b).unwrap().unwrap().id, a.id);
        assert!(s.previous(&a).unwrap().is_none());
        assert_eq!(s.tree().unwrap()[0].workflows[0].docs[0].title, "C");
        let hist: Vec<String> = s
            .history(a.project_id, "/p/PLAN.md")
            .unwrap()
            .into_iter()
            .map(|d| d.title)
            .collect();
        assert_eq!(hist, vec!["C", "B", "A"]);
        assert_eq!(
            s.latest_for_path("/p", "/p/PLAN.md")
                .unwrap()
                .unwrap()
                .title,
            "C"
        );
    }

    #[test]
    fn workflow_keys_ignore_case() {
        let (s, _d) = temp_store();
        let a = s
            .insert(&new_id("a"), new_doc("A", "one", "ksi pivot"))
            .unwrap();
        let b = s
            .insert(&new_id("b"), new_doc("B", "two", "ksi pivot"))
            .unwrap();
        assert_eq!(a.workflow_id, b.workflow_id, "same key is one workflow");
        assert_eq!(s.tree().unwrap()[0].workflows.len(), 1);
    }

    #[test]
    fn pin_and_prune() {
        let (s, _d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
        assert!(s.set_pinned(&a.id, true).unwrap());
        let dry = s.prune(now() + 10, true).unwrap();
        assert_eq!(dry.len(), 1);
        assert_eq!(s.count().unwrap(), 2, "dry run deletes nothing");
        let gone = s.prune(now() + 10, false).unwrap();
        assert_eq!(gone[0].0, b.id);
        assert_eq!(s.count().unwrap(), 1);
        assert!(s.get(&b.id).unwrap().is_none());
        assert!(s.html(&b.id).is_err(), "files removed");
        assert!(s.get(&a.id).unwrap().unwrap().pinned);
    }

    #[test]
    fn replace_keeps_id_and_updates_index() {
        let (s, _d) = temp_store();
        let a = s
            .insert(&new_id("a"), new_doc("A", "first draft", "w"))
            .unwrap();
        let r = s
            .replace(&a.id, new_doc("A2", "second draft", "w"))
            .unwrap();
        assert_eq!(r.id, a.id);
        assert_eq!(r.title, "A2");
        assert_eq!(s.source(&a.id).unwrap(), "second draft");
        assert!(s.search("first", 5).unwrap().is_empty());
        assert_eq!(s.search("second", 5).unwrap().len(), 1);
    }
}

#[cfg(test)]
pub mod tempdir {
    pub struct Dir {
        pub path: std::path::PathBuf,
    }
    impl Dir {
        pub fn new(prefix: &str) -> Dir {
            // The counter is what makes this unique, not the clock. The name
            // used to be the pid and the time in nanoseconds, which is unique
            // on Linux because the clock really does tick every nanosecond.
            // Windows ticks every 100, so two tests starting together got the
            // same name, shared one directory, and the first one to finish
            // deleted it from under the other.
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("{prefix}-{}-{n}-{seq}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Dir { path }
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
