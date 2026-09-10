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
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeDoc {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub received_at: i64,
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
    pub source: &'a str,
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
  created_at INTEGER NOT NULL
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
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_recv ON docs(received_at DESC);
CREATE INDEX IF NOT EXISTS docs_wf ON docs(workflow_id, received_at);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61');
"#;

impl Store {
    pub fn open(paths: &Paths) -> Result<Store> {
        fs::create_dir_all(&paths.data_dir).context("creating data dir")?;
        fs::create_dir_all(&paths.docs_dir).context("creating docs dir")?;
        let conn = Connection::open(&paths.db_path).context("opening database")?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { conn: Mutex::new(conn), docs_dir: paths.docs_dir.clone() })
    }

    pub fn insert(&self, d: NewDoc) -> Result<Doc> {
        let now = now();
        let hash = blake3::hash(d.source.as_bytes()).to_hex().to_string();
        let id = short_id(&hash, now);
        // Files first, so a crash never leaves a row without a body.
        fs::write(self.docs_dir.join(format!("{id}.src")), d.source)?;
        fs::write(self.docs_dir.join(format!("{id}.html")), d.html)?;

        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO projects(root, name, created_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(root) DO UPDATE SET name = excluded.name",
            params![d.project_root, d.project_name, now],
        )?;
        let project_id: i64 = tx.query_row("SELECT id FROM projects WHERE root = ?1", params![d.project_root], |r| r.get(0))?;
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
            "INSERT INTO docs(id, project_id, workflow_id, title, kind, lang, size, received_at, source_path, branch, content_hash)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![id, project_id, workflow_id, d.title, d.kind.as_str(), d.lang, d.source.len() as i64, now, d.source_path, d.branch, hash],
        )?;
        tx.execute("INSERT INTO docs_fts(id, title, body) VALUES(?1, ?2, ?3)", params![id, d.title, d.source])?;
        tx.commit()?;
        Ok(Doc {
            id,
            project_id,
            project: d.project_name.to_string(),
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
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch
             FROM docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id
             WHERE d.id = ?1",
            params![id],
            row_to_doc,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn html(&self, id: &str) -> Result<String> {
        Ok(fs::read_to_string(self.docs_dir.join(format!("{id}.html")))?)
    }

    pub fn source(&self, id: &str) -> Result<String> {
        Ok(fs::read_to_string(self.docs_dir.join(format!("{id}.src")))?)
    }

    /// The document received just before this one in the same workflow.
    pub fn previous(&self, doc: &Doc) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch
             FROM docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id
             WHERE d.workflow_id = ?1 AND d.received_at < ?2 ORDER BY d.received_at DESC LIMIT 1",
            params![doc.workflow_id, doc.received_at],
            row_to_doc,
        )
        .optional()
        .map_err(Into::into)
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
        let mut doc_stmt = conn.prepare("SELECT id, title, kind, received_at FROM docs WHERE workflow_id = ?1 ORDER BY received_at DESC")?;
        for p in &mut projects {
            let wfs = wf_stmt
                .query_map(params![p.id], |r| Ok(TreeWorkflow { id: r.get(0)?, key: r.get(1)?, title: r.get(2)?, docs: vec![] }))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            for mut w in wfs {
                w.docs = doc_stmt
                    .query_map(params![w.id], |r| {
                        Ok(TreeDoc {
                            id: r.get(0)?,
                            title: r.get(1)?,
                            kind: Kind::parse(&r.get::<_, String>(2)?).unwrap_or(Kind::Text),
                            received_at: r.get(3)?,
                        })
                    })?
                    .collect::<std::result::Result<_, _>>()?;
                p.workflows.push(w);
            }
        }
        Ok(projects)
    }

    pub fn inbox(&self, limit: usize) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch
                 FROM docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id
                 ORDER BY d.received_at DESC LIMIT ?1",
            )?
            .query_map(params![limit as i64], row_to_doc)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn search(&self, q: &str, limit: usize) -> Result<Vec<Hit>> {
        let q = q.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        // Quote each term so punctuation in user input cannot break FTS syntax.
        let query: String = q
            .split_whitespace()
            .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT d.id, d.title, p.name, w.title, d.kind, d.received_at,
                        snippet(docs_fts, 2, '<mark>', '</mark>', '…', 14)
                 FROM docs_fts f JOIN docs d ON d.id = f.id
                 JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id
                 WHERE docs_fts MATCH ?1 ORDER BY bm25(docs_fts, 4.0, 1.0) LIMIT ?2",
            )?
            .query_map(params![query, limit as i64], |r| {
                Ok(Hit {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    project: r.get(2)?,
                    workflow_title: r.get(3)?,
                    kind: Kind::parse(&r.get::<_, String>(4)?).unwrap_or(Kind::Text),
                    received_at: r.get(5)?,
                    snippet: r.get(6)?,
                })
            })?
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
    })
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 10 hex chars: content hash mixed with time, so re-sending identical content still gets a new id.
fn short_id(hash: &str, now: i64) -> String {
    let mixed = blake3::hash(format!("{hash}:{now}:{}", std::process::id()).as_bytes());
    mixed.to_hex()[..10].to_string()
}
