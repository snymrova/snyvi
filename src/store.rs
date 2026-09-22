//! On-disk store: one source and one rendered HTML file per document,
//! plus a SQLite index with full-text search.

use crate::config::Paths;
use crate::desk::{self, Desk, Opened, Origin, Placed};
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
    /// The desk and slot it was sent from, when it was sent from a pane.
    pub desk: Option<Origin>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeDoc {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub received_at: i64,
    pub pinned: bool,
    /// On the queue: arrived and not yet opened. The row carries its own mark,
    /// so a project expanded later marks its rows without the page holding
    /// the whole queue.
    pub unread: bool,
}

/// A document as the desk's rail lists it: what a pane on this desk sent,
/// and which pane. Less than a `Doc`, because the rail draws a row and not a
/// page, and more than a `TreeDoc`, because the tree never says which desk.
#[derive(Clone, Debug, Serialize)]
pub struct DeskDoc {
    pub id: String,
    pub title: String,
    pub kind: Kind,
    pub received_at: i64,
    pub unread: bool,
    pub pinned: bool,
    pub slot: i64,
    pub project: String,
    /// The file it was sent from, when it was one: the rail offers it to copy.
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeWorkflow {
    pub id: i64,
    pub key: String,
    pub title: String,
    /// The newest documents in it, which is usually all of them.
    pub docs: Vec<TreeDoc>,
    /// How many it actually holds, so the tree can offer the rest rather than
    /// pretend the cap is the whole of it.
    pub total: i64,
}

/// A project as the sidebar first shows it: a row, and how much is behind it.
///
/// Without its documents, on purpose. The tree used to arrive whole -- every
/// workflow and every document in the library -- and the shell embeds it on
/// every page open: at 3000 documents that was a 383 KB page and a 718 ms task
/// building 13,000 rows nobody had asked to see. What a project holds is
/// fetched when it is expanded, the way a browsed folder already was.
#[derive(Clone, Debug, Serialize)]
pub struct TreeProject {
    pub id: i64,
    pub name: String,
    pub root: String,
    /// Documents in the project. The inbox count is the sum of these.
    pub docs: i64,
    /// Workflows in it, for the same reason `TreeWorkflow::total` exists.
    pub workflows: i64,
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
    /// The MCP client's name, "" when it came another way.
    pub sender: &'a str,
    /// The pane it was sent from, if it was.
    pub desk: Option<&'a Origin>,
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
  origin TEXT NOT NULL DEFAULT 'cli',
  unread INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_recv ON docs(received_at DESC);
CREATE INDEX IF NOT EXISTS docs_wf ON docs(workflow_id, received_at);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61');
"#;

const DOC_COLS: &str = "d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch, d.pinned, d.origin, d.content_hash, d.desk_id, d.desk_name, d.desk_slot";
const DOC_FROM: &str =
    "FROM live_docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id";
/// The same join over `head_docs`: what every list of documents reads, so one
/// file sent seven times is one row. Reaching a version that is not the head is
/// deliberate -- `history`, `previous` and `get` go through `DOC_FROM`.
const HEAD_FROM: &str =
    "FROM head_docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id";

impl Store {
    pub fn open(paths: &Paths) -> Result<Store> {
        fs::create_dir_all(&paths.data_dir).context("creating data dir")?;
        fs::create_dir_all(&paths.docs_dir).context("creating docs dir")?;
        let conn = Connection::open(&paths.db_path).context("opening database")?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        conn.execute_batch(SCHEMA)?;
        // Desks live in the same database and in tables of their own; see
        // `crate::desk` for why that separation is the whole of the boundary.
        conn.execute_batch(desk::SCHEMA)?;
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
            // Read, for everything that was here before there was a queue: a
            // library's worth of old documents is not a backlog.
            "ALTER TABLE docs ADD COLUMN unread INTEGER NOT NULL DEFAULT 0",
            // Deleted, and still here until `prune` says otherwise -- which is
            // what makes "Undo" in the toast something the daemon can honour.
            "ALTER TABLE docs ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0",
            // Who sent it, by the name the MCP client gave in `initialize`,
            // so the connect page can say when an agent last worked.
            "ALTER TABLE docs ADD COLUMN sender TEXT NOT NULL DEFAULT ''",
            // Which desk and slot it came from, when it came from a pane.
            // Copied, not joined: a desk that is closed later does not take
            // the document's provenance with it.
            "ALTER TABLE docs ADD COLUMN desk_id INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE docs ADD COLUMN desk_name TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE docs ADD COLUMN desk_slot INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = conn.execute_batch(stmt);
        }
        // After the columns are there on every database, old or new.
        //
        // `head_docs` is the second of the two, and the one every *list* reads:
        // a file sent seven times is seven rows in `docs` and one row in here,
        // the newest. The other six are not hidden -- they are the Versions
        // panel, `[` and `]`, and the comparison -- but a list of documents is
        // a list of documents, and the sidebar used to show the same script
        // seven times because the row and the send were the same thing. A
        // document with no file behind it has no lineage to be the head of, so
        // it is always its own.
        //
        // Every read of the library goes through this view, so a document that
        // has been deleted is gone from the tree, the inbox, search, the queue,
        // history and the counts by construction -- rather than by a condition
        // that a query written later could forget. `rowid` is named because the
        // ordering everywhere breaks ties with it, and a view has none of its
        // own. It is rebuilt at every start, so a column added by a migration
        // is in it on the run that adds the column.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS docs_unread ON docs(unread, received_at);
             CREATE INDEX IF NOT EXISTS docs_path ON docs(project_id, source_path, received_at);
             DROP VIEW IF EXISTS live_docs;
             CREATE VIEW live_docs AS SELECT rowid AS rowid, * FROM docs WHERE deleted_at = 0;
             DROP VIEW IF EXISTS head_docs;
             CREATE VIEW head_docs AS SELECT * FROM live_docs d
               WHERE d.source_path IS NULL
                  OR d.rowid = (SELECT d2.rowid FROM live_docs d2
                                WHERE d2.project_id = d.project_id AND d2.source_path = d.source_path
                                ORDER BY d2.received_at DESC, d2.rowid DESC LIMIT 1);",
        )?;
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
    fn outline_path(&self, id: &str) -> PathBuf {
        self.docs_dir.join(format!("{id}.outline"))
    }

    /// The rail's outline of a code document, as JSON, if it has been worked out.
    pub fn outline(&self, id: &str) -> Option<String> {
        fs::read_to_string(self.outline_path(id)).ok()
    }

    pub fn set_outline(&self, id: &str, json: &str) -> Result<()> {
        Ok(fs::write(self.outline_path(id), json)?)
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
            "INSERT INTO docs(id, project_id, workflow_id, title, kind, lang, size, received_at, source_path, branch, content_hash, pinned, origin, unread, sender, desk_id, desk_name, desk_slot)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, 1, ?13, ?14, ?15, ?16)",
            params![id, project_id, workflow_id, d.title, d.kind.as_str(), d.lang, d.source.len() as i64, now, d.source_path, d.branch, hash, d.origin, d.sender,
                d.desk.map_or(0, |o| o.id), d.desk.map_or("", |o| o.name.as_str()), d.desk.map_or(0, |o| o.slot)],
        )?;
        tx.execute(
            "INSERT INTO docs_fts(id, title, body) VALUES(?1, ?2, ?3)",
            params![id, d.title, d.search_body],
        )?;
        // A newer version of a file takes the older one's place on the queue
        // rather than queueing beside it. The older row is in no list any more
        // (see `head_docs`), and a count of rows nobody can reach is a badge
        // that never comes down -- seven sends of one script used to read as
        // seven things waiting.
        if let Some(sp) = d.source_path {
            tx.execute(
                "UPDATE docs SET unread = 0 WHERE project_id = ?1 AND source_path = ?2 AND id != ?3 AND unread = 1",
                params![project_id, sp, id],
            )?;
        }
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
            desk: d.desk.cloned(),
        })
    }

    /// Overwrite an existing document's content in place (used to coalesce rapid
    /// hook-driven edits of the same file into one snapshot).
    pub fn replace(&self, id: &str, d: NewDoc) -> Result<Doc> {
        let now = now();
        let hash = blake3::hash(d.source).to_hex().to_string();
        fs::write(self.src_path(id), d.source)?;
        fs::write(self.html_path(id), d.html)?;
        // The source changed under it, so the outline is worked out again.
        let _ = fs::remove_file(self.outline_path(id));
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

    /// The version before this one: the same file's previous snapshot, or, for
    /// a document with no file behind it, whatever arrived just before it in
    /// the same workflow.
    ///
    /// What "Compare with previous" compares against, which is why it follows
    /// the file. A workflow holds one row per document now, so the row before
    /// this one in it is usually a different document altogether -- and a
    /// reader pressing `c` on the seventh send of a script means the sixth.
    /// The first send of a file has nothing to compare with, and says so
    /// rather than reaching for the nearest unrelated thing.
    pub fn previous(&self, doc: &Doc) -> Result<Option<Doc>> {
        let conn = self.conn.lock().unwrap();
        // Ties are broken on rowid because received_at counts whole seconds,
        // and a file sent twice inside one is exactly what this is for.
        let earlier = "AND d.id != ?3 \
             AND (d.received_at < ?2 OR (d.received_at = ?2 AND d.rowid < (SELECT rowid FROM docs WHERE id = ?3))) \
             ORDER BY d.received_at DESC, d.rowid DESC LIMIT 1";
        if let Some(path) = &doc.source_path {
            return conn
                .query_row(
                    &format!(
                        "SELECT {DOC_COLS} {DOC_FROM} WHERE d.project_id = ?1 AND d.source_path = ?4 {earlier}"
                    ),
                    params![doc.project_id, doc.received_at, doc.id, path],
                    row_to_doc,
                )
                .optional()
                .map_err(Into::into);
        }
        conn.query_row(
            &format!("SELECT {DOC_COLS} {DOC_FROM} WHERE d.workflow_id = ?1 {earlier}"),
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

    /// Delete a document: gone from everything that reads the library, and
    /// still on disk until `prune` runs.
    ///
    /// Nothing is asked first and nothing is destroyed, which is the trade the
    /// confirmation used to make the other way round: a dialog before every
    /// delete, and no way back after one. The row keeps its workflow, its
    /// project and its place in the queue, so putting it back is one column.
    ///
    /// The document, not the row: one row per document in the sidebar means one
    /// ✕ per document, so a file that was sent seven times goes with its seven
    /// versions. Removing only the newest would put the sixth in its place, and
    /// a delete that leaves a nearly identical row behind reads as one that did
    /// not happen. Undo puts the same seven back.
    pub fn delete(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let at = now();
        let found: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT project_id, source_path FROM docs WHERE id = ?1 AND deleted_at = 0",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((project_id, source_path)) = found else {
            return Ok(false);
        };
        let n = match source_path {
            Some(sp) => tx.execute(
                "UPDATE docs SET deleted_at = ?3 WHERE project_id = ?1 AND source_path = ?2 AND deleted_at = 0",
                params![project_id, sp, at],
            )?,
            None => tx.execute(
                "UPDATE docs SET deleted_at = ?2 WHERE id = ?1 AND deleted_at = 0",
                params![id, at],
            )?,
        };
        tx.commit()?;
        Ok(n > 0)
    }

    /// Put back a document that was deleted. False when there is nothing to put
    /// back, which is what an Undo pressed twice, or after a prune, is.
    pub fn undelete(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let found: Option<(i64, Option<String>, i64)> = tx
            .query_row(
                "SELECT project_id, source_path, deleted_at FROM docs WHERE id = ?1 AND deleted_at != 0",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((project_id, source_path, at)) = found else {
            return Ok(false);
        };
        // Exactly the versions that went with it, matched on the instant they
        // went: a version deleted on its own, earlier, stays deleted.
        let n = match source_path {
            Some(sp) => tx.execute(
                "UPDATE docs SET deleted_at = 0 WHERE project_id = ?1 AND source_path = ?2 AND deleted_at = ?3",
                params![project_id, sp, at],
            )?,
            None => tx.execute(
                "UPDATE docs SET deleted_at = 0 WHERE id = ?1 AND deleted_at != 0",
                params![id],
            )?,
        };
        tx.commit()?;
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

    /// What arrived and has not been opened, oldest first: the order things
    /// came in is the order to read them in. Every insert joins it and every
    /// open leaves it, so it is the unread set with an order and nothing more.
    pub fn queue(&self, limit: usize) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&format!(
                "SELECT {DOC_COLS} {HEAD_FROM} WHERE d.unread = 1 ORDER BY d.received_at, d.rowid LIMIT ?1"
            ))?
            .query_map(params![limit as i64], row_to_doc)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// How many are on the queue: what the bar says, however many rows the
    /// page was sent.
    pub fn waiting(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        Ok(
            conn.query_row("SELECT COUNT(*) FROM head_docs WHERE unread = 1", [], |r| {
                r.get(0)
            })?,
        )
    }

    /// A document was opened. True when this is what took it off the queue.
    pub fn mark_read(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE docs SET unread = 0 WHERE id = ?1 AND unread = 1",
            params![id],
        )? > 0)
    }

    /// Everything waiting, marked read without being opened. Returns what
    /// left the queue, so every open tab can take the same rows off.
    pub fn mark_all_read(&self) -> Result<Vec<String>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let ids: Vec<String> = tx
            .prepare("SELECT id FROM head_docs WHERE unread = 1")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        tx.execute("UPDATE docs SET unread = 0 WHERE unread = 1", [])?;
        tx.commit()?;
        Ok(ids)
    }

    /// Name a project yourself. The directory it was derived from is its identity and
    /// does not move, so sends keep landing here; `renamed` stops the derived name
    /// from reclaiming the label on the next one.
    /// Where a project was detected, which is the last directory a document can
    /// fall back to.
    ///
    /// A query of its own rather than a column on `Doc`: the root is wanted by
    /// one caller in one place, and `DOC_COLS` is read by every list, search and
    /// tree in the server.
    pub fn project_root(&self, project_id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT root FROM projects WHERE id = ?1",
            params![project_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

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
    /// Delete for good: what is old enough, and what the reader deleted.
    ///
    /// A deleted document goes whatever its age and whether or not it is
    /// pinned -- the reader has already said so, and the undo it could have
    /// come back through belongs to the minute it was deleted in, not to the
    /// next month.
    pub fn prune(&self, before: i64, dry_run: bool) -> Result<Vec<(String, String)>> {
        let mut conn = self.conn.lock().unwrap();
        let victims: Vec<(String, String)> = conn
            .prepare(
                "SELECT id, title FROM docs WHERE deleted_at != 0 OR (pinned = 0 AND received_at < ?1) \
                 ORDER BY deleted_at, received_at",
            )?
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
            let _ = fs::remove_file(self.outline_path(id));
        }
        Ok(victims)
    }

    /// One row per project, most recent activity first.
    ///
    /// One query rather than the walk this replaced, and it answers the whole
    /// sidebar until a reader expands something: a project's name, where it was
    /// detected, and the two counts the tree needs to say how much is behind a
    /// row it has not drawn.
    ///
    /// A project with no documents is not a row. One only exists because
    /// something was sent to it, and prune deletes the empties, but a rename
    /// can briefly outlive the last document it named.
    pub fn projects(&self) -> Result<Vec<TreeProject>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT p.id, p.name, p.root, COUNT(d.id), COUNT(DISTINCT d.workflow_id)
                 FROM projects p JOIN head_docs d ON d.project_id = p.id
                 GROUP BY p.id ORDER BY MAX(d.received_at) DESC, p.id DESC",
            )?
            .query_map([], |r| {
                Ok(TreeProject {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    root: r.get(2)?,
                    docs: r.get(3)?,
                    workflows: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// What one project holds: its `workflows` most recent sessions, each
    /// carrying its `docs` newest documents and saying how many it has.
    ///
    /// Zero means every one of them, which is what a reader asking to see past
    /// a cap gets. The caps are what keep an expanded project a screenful of
    /// rows instead of a year of them; nothing is hidden, only unasked for.
    pub fn project_tree(
        &self,
        project_id: i64,
        workflows: usize,
        docs: usize,
    ) -> Result<Vec<TreeWorkflow>> {
        // SQLite reads a negative LIMIT as no limit, which is the one case
        // callers spell as 0 -- so the two are translated here rather than by
        // building two versions of each statement.
        let wf_limit = if workflows == 0 { -1 } else { workflows as i64 };
        let doc_limit = if docs == 0 { -1 } else { docs as i64 };
        let conn = self.conn.lock().unwrap();
        let mut wfs: Vec<TreeWorkflow> = conn
            .prepare(
                "SELECT w.id, w.key, w.title, COUNT(d.id)
                 FROM workflows w JOIN head_docs d ON d.workflow_id = w.id
                 WHERE w.project_id = ?1
                 GROUP BY w.id ORDER BY MAX(d.received_at) DESC, w.id DESC LIMIT ?2",
            )?
            .query_map(params![project_id, wf_limit], |r| {
                Ok(TreeWorkflow {
                    id: r.get(0)?,
                    key: r.get(1)?,
                    title: r.get(2)?,
                    docs: vec![],
                    total: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut doc_stmt = conn.prepare(
            "SELECT id, title, kind, received_at, pinned, unread FROM head_docs
             WHERE workflow_id = ?1 ORDER BY received_at DESC, rowid DESC LIMIT ?2",
        )?;
        for w in &mut wfs {
            w.docs = doc_stmt
                .query_map(params![w.id, doc_limit], row_to_tree_doc)?
                .collect::<std::result::Result<_, _>>()?;
        }
        Ok(wfs)
    }

    /// One workflow with every document in it.
    ///
    /// What `[` and `]` walk, so it is never a capped list: a reader stepping
    /// through the versions of a plan must reach the oldest one. Also what the
    /// tree fetches when a reader asks to see past a workflow's cap.
    pub fn workflow_tree(&self, workflow_id: i64) -> Result<Option<TreeWorkflow>> {
        let conn = self.conn.lock().unwrap();
        let found = conn
            .query_row(
                "SELECT id, key, title FROM workflows WHERE id = ?1",
                params![workflow_id],
                |r| {
                    Ok(TreeWorkflow {
                        id: r.get(0)?,
                        key: r.get(1)?,
                        title: r.get(2)?,
                        docs: vec![],
                        total: 0,
                    })
                },
            )
            .optional()?;
        let Some(mut w) = found else {
            return Ok(None);
        };
        w.docs = conn
            .prepare(
                "SELECT id, title, kind, received_at, pinned, unread FROM head_docs
                 WHERE workflow_id = ?1 ORDER BY received_at DESC, rowid DESC",
            )?
            .query_map(params![workflow_id], row_to_tree_doc)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        w.total = w.docs.len() as i64;
        // A workflow with nothing in it is not one the tree can show.
        Ok((!w.docs.is_empty()).then_some(w))
    }

    pub fn inbox(&self, limit: usize) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&format!(
                "SELECT {DOC_COLS} {HEAD_FROM} ORDER BY d.received_at DESC, d.rowid DESC LIMIT ?1"
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
            sql.push_str("'' FROM live_docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id WHERE 1=1");
        } else {
            sql.push_str(
                "snippet(docs_fts, 2, '<mark>', '</mark>', '…', 14) FROM docs_fts f JOIN live_docs d ON d.id = f.id \
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
        Ok(conn.query_row("SELECT COUNT(*) FROM live_docs", [], |r| r.get(0))?)
    }

    /// Every MCP client that has sent something, and when it last did.
    /// Over `docs`, not `live_docs`: a document the reader deleted still
    /// proves the agent's registration worked.
    pub fn senders(&self) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT sender, MAX(received_at) FROM docs WHERE sender <> '' GROUP BY sender",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    // -- Desks.
    //
    // Thin, because the SQL is `crate::desk`'s and the lock is this file's.
    // Every read of the library goes through `live_docs` and none of these
    // touch it, which is what "a desk is not a document" means in practice.

    pub fn desks(&self) -> Result<Vec<Desk>> {
        desk::list(&self.conn.lock().unwrap())
    }

    pub fn desk(&self, id: i64) -> Result<Option<Desk>> {
        desk::get(&self.conn.lock().unwrap(), id)
    }

    /// What the panes on a desk have sent, newest first. The desk is named
    /// on the document when it arrives, so this outlives the pane that sent
    /// it, and a desk closed and remade under the same id does not inherit
    /// the old one's -- ids are never reused.
    ///
    /// One entry per file, like every other list: an agent rewriting a script
    /// in a pane sends it seven times and the rail shows the seventh. The head
    /// is this desk's own newest rather than the library's, because what a
    /// desk shows is what its panes sent -- a later version sent from the CLI
    /// does not belong to it, and must not take a row here away.
    pub fn desk_docs(&self, desk_id: i64, limit: usize) -> Result<Vec<DeskDoc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT d.id, d.title, d.kind, d.received_at, d.unread, d.pinned, d.desk_slot, p.name, d.source_path
                 FROM live_docs d JOIN projects p ON p.id = d.project_id
                 WHERE d.desk_id = ?1
                   AND (d.source_path IS NULL
                        OR d.rowid = (SELECT d2.rowid FROM live_docs d2
                                      WHERE d2.desk_id = ?1 AND d2.project_id = d.project_id
                                        AND d2.source_path = d.source_path
                                      ORDER BY d2.received_at DESC, d2.rowid DESC LIMIT 1))
                 ORDER BY d.received_at DESC, d.rowid DESC LIMIT ?2",
            )?
            .query_map(params![desk_id, limit as i64], |r| {
                Ok(DeskDoc {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind: Kind::parse(&r.get::<_, String>(2)?).unwrap_or(Kind::Text),
                    received_at: r.get(3)?,
                    unread: r.get::<_, i64>(4)? != 0,
                    pinned: r.get::<_, i64>(5)? != 0,
                    slot: r.get(6)?,
                    project: r.get(7)?,
                    source_path: r.get(8)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn create_desk(&self, root: &str, name: Option<&str>) -> Result<Desk> {
        desk::create(&self.conn.lock().unwrap(), root, name, now())
    }

    pub fn rename_desk(&self, id: i64, name: &str) -> Result<bool> {
        desk::rename(&self.conn.lock().unwrap(), id, name)
    }

    pub fn set_desk_layout(&self, id: i64, col: f64, row: f64) -> Result<bool> {
        desk::layout(&self.conn.lock().unwrap(), id, col, row)
    }

    pub fn delete_desk(&self, id: i64) -> Result<bool> {
        desk::delete(&self.conn.lock().unwrap(), id)
    }

    pub fn pane(&self, id: &str) -> Result<Option<Placed>> {
        desk::pane(&self.conn.lock().unwrap(), id)
    }

    pub fn set_pane_cmd(&self, id: &str, cmd: &str) -> Result<bool> {
        desk::set_cmd(&self.conn.lock().unwrap(), id, cmd)
    }

    pub fn open_pane(&self, desk_id: i64, cwd: &str, cmd: &str) -> Result<Opened> {
        desk::open_pane(&mut self.conn.lock().unwrap(), desk_id, cwd, cmd, now())
    }

    pub fn close_pane(&self, id: &str) -> Result<bool> {
        desk::close_pane(&self.conn.lock().unwrap(), id)
    }

    pub fn panes_open(&self) -> Result<i64> {
        desk::panes_open(&self.conn.lock().unwrap())
    }

    /// A desk's own list. Thin, for the reason the desk calls above are: the
    /// SQL is `crate::desk`'s and the lock is this file's.
    pub fn desk_notes(&self, desk_id: i64) -> Result<Vec<desk::DeskNote>> {
        desk::notes(&self.conn.lock().unwrap(), desk_id)
    }

    pub fn add_desk_note(&self, desk_id: i64, text: &str) -> Result<Option<desk::DeskNote>> {
        desk::add_note(&mut self.conn.lock().unwrap(), desk_id, text, now())
    }

    pub fn set_desk_note(
        &self,
        desk_id: i64,
        id: i64,
        text: Option<&str>,
        done: Option<bool>,
    ) -> Result<bool> {
        desk::set_note(&self.conn.lock().unwrap(), desk_id, id, text, done, now())
    }

    pub fn remove_desk_note(&self, desk_id: i64, id: i64) -> Result<bool> {
        desk::remove_note(&self.conn.lock().unwrap(), desk_id, id, now())
    }

    pub fn restore_desk_note(&self, desk_id: i64, id: i64) -> Result<bool> {
        desk::restore_note(&self.conn.lock().unwrap(), desk_id, id)
    }

    /// What a reset would take, in the numbers the sentence says and the
    /// reader types back: the documents that can be seen, the projects they
    /// are in, how many of them are pinned, and the desks that go with them. A document already deleted is
    /// not counted -- the reader has said goodbye to it once -- but it goes
    /// with the rest.
    pub fn census(&self) -> Result<Census> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT project_id), COALESCE(SUM(pinned), 0),
                    (SELECT COUNT(*) FROM desks) FROM live_docs",
            [],
            |r| {
                Ok(Census {
                    documents: r.get(0)?,
                    projects: r.get(1)?,
                    pinned: r.get(2)?,
                    desks: r.get(3)?,
                })
            },
        )?)
    }

    /// Every row and every file, gone; the schema stays, so the store is what
    /// `open` makes on a machine that has never seen snyvi. `VACUUM` gives the
    /// space back and folds the write-ahead log in, so the database file is
    /// as small as a new one and not a record of what it used to hold.
    pub fn reset(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM docs_fts; DELETE FROM docs; DELETE FROM workflows; DELETE FROM projects;",
        )?;
        // Desks are not documents, and a reset still takes them: what it
        // promises is a store as `open` makes it on a machine that has never
        // seen snyvi. So the census counts them, the sentence names them, and
        // the daemon checks their number as it checks the documents'.
        desk::clear(&conn)?;
        conn.execute_batch("VACUUM;")?;
        drop(conn);
        if let Ok(entries) = fs::read_dir(&self.docs_dir) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        Ok(())
    }
}

/// The numbers a reset is asked to confirm with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Census {
    pub documents: i64,
    pub projects: i64,
    pub pinned: i64,
    /// Default, so a census from a daemon that predates desks still reads --
    /// as none, which is what that daemon has.
    #[serde(default)]
    pub desks: i64,
}

/// A tree row, which is the five columns of a document the sidebar draws and
/// none of the rest. Shared by the two queries that return them.
fn row_to_tree_doc(r: &rusqlite::Row) -> rusqlite::Result<TreeDoc> {
    Ok(TreeDoc {
        id: r.get(0)?,
        title: r.get(1)?,
        kind: Kind::parse(&r.get::<_, String>(2)?).unwrap_or(Kind::Text),
        received_at: r.get(3)?,
        pinned: r.get::<_, i64>(4)? != 0,
        unread: r.get::<_, i64>(5)? != 0,
    })
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
        desk: match r.get::<_, i64>(16)? {
            0 => None,
            id => Some(Origin {
                id,
                name: r.get(17)?,
                slot: r.get(18)?,
            }),
        },
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

    /// A document of its own, which is what most of these tests mean when they
    /// set up two: the file behind it is its identity now, and a second send of
    /// the same file is a version rather than a row. The body doubles as the
    /// path because it is the thing that differs between them here; tests that
    /// mean versions say so with `version_of`.
    fn new_doc<'a>(title: &'a str, src: &'a str, wf: &'a str) -> NewDoc<'a> {
        version_of(src, title, src, wf)
    }

    /// The same file, sent again: a version of the document at `path`.
    fn version_of<'a>(path: &'a str, title: &'a str, src: &'a str, wf: &'a str) -> NewDoc<'a> {
        NewDoc {
            project_root: "/p",
            project_name: "p",
            workflow_key: wf,
            workflow_title: wf,
            title,
            kind: Kind::Markdown,
            lang: None,
            source_path: Some(path),
            branch: None,
            origin: "cli",
            sender: "",
            desk: None,
            source: src.as_bytes(),
            search_body: src,
            html: "<p>x</p>",
        }
    }

    #[test]
    fn insert_get_previous_search() {
        let (s, _d) = temp_store();
        let a = s
            .insert(
                &new_id("a"),
                version_of("/p/PLAN.md", "Plan", "# Plan\n\nalpha bravo", "w"),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let b = s
            .insert(
                &new_id("b"),
                version_of("/p/PLAN.md", "Plan", "# Plan\n\nalpha charlie", "w"),
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
        // Two sends of one plan are one document with two versions: the lists
        // count what a reader can see, and history counts what was sent.
        let p = &s.projects().unwrap()[0];
        assert_eq!((p.docs, p.workflows), (1, 1));
        assert_eq!(s.project_tree(p.id, 10, 10).unwrap()[0].docs.len(), 1);
        assert_eq!(s.history(p.id, "/p/PLAN.md").unwrap().len(), 2);
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
        assert_eq!(s.projects().unwrap()[0].name, "Auth work");
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
        let t = s.project_tree(b.project_id, 10, 10).unwrap();
        assert_eq!(t[0].title, "Auth refactor");
        assert_eq!(t[0].key, "sess-1");
        assert!(!s.rename_workflow(9999, "nobody").unwrap());
    }

    #[test]
    fn same_second_documents_keep_their_order() {
        // received_at counts whole seconds, so insertion order is the tiebreaker.
        let (s, _d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("A", "first", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "second", "w")).unwrap();
        let c = s.insert(&new_id("c"), new_doc("C", "third", "w")).unwrap();
        // Three inserts land in one second on most machines and, on a slow
        // one, straddle a boundary -- so this asserted its own timing and
        // failed for it on a Windows runner. Put them in one second on
        // purpose: a clock that has to cooperate is not a precondition, and
        // the second they share is not what is being tested. What is, is that
        // rowid breaks the tie once received_at cannot.
        let t = a.received_at;
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE docs SET received_at = ?1", params![t])
            .unwrap();
        let (a, b, c) = (
            Doc {
                received_at: t,
                ..a
            },
            Doc {
                received_at: t,
                ..b
            },
            Doc {
                received_at: t,
                ..c
            },
        );
        let order: Vec<String> = s.inbox(9).unwrap().into_iter().map(|d| d.title).collect();
        assert_eq!(
            order,
            vec!["C", "B", "A"],
            "newest first even within a second"
        );
        assert_eq!(
            s.project_tree(c.project_id, 10, 10).unwrap()[0].docs[0].title,
            "C"
        );
        // Three files, so three documents, each the whole history of its own
        // and none of them the version before another.
        assert_eq!(s.history(a.project_id, "first").unwrap().len(), 1);
        assert!(
            s.previous(&b).unwrap().is_none() && s.previous(&c).unwrap().is_none(),
            "a different file is not a version of the one before it"
        );

        // A fourth send, of A's file, inside the same second: the tie `previous`
        // cannot break on received_at it breaks on rowid, which is the whole
        // point of the second these four share.
        let a2 = s
            .insert(&new_id("a2"), version_of("first", "A2", "first again", "w"))
            .unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE docs SET received_at = ?1", params![t])
            .unwrap();
        let a2 = Doc {
            received_at: t,
            ..a2
        };
        assert_eq!(s.previous(&a2).unwrap().unwrap().id, a.id);
        assert!(
            s.previous(&a).unwrap().is_none(),
            "the first send of a file"
        );
        let order: Vec<String> = s.inbox(9).unwrap().into_iter().map(|d| d.title).collect();
        assert_eq!(order, vec!["A2", "C", "B"], "and A is behind A2 now");
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
        assert_eq!(s.projects().unwrap()[0].workflows, 1);
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

    /// The census is what the reset sentence says and the reader types back:
    /// a deleted document is not in it, a pinned one is counted twice over.
    /// After the reset the store answers as a new one does, and the files are
    /// gone with the rows.
    #[test]
    fn census_and_reset() {
        let (s, d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
        let c = s
            .insert(&new_id("c"), new_doc("C", "ccc", "other"))
            .unwrap();
        assert!(s.set_pinned(&a.id, true).unwrap());
        assert!(s.delete(&c.id).unwrap());
        assert_eq!(
            s.census().unwrap(),
            Census {
                documents: 2,
                projects: 1,
                pinned: 1,
                desks: 0,
            }
        );
        assert_eq!(std::fs::read_dir(d.path.join("docs")).unwrap().count(), 6);
        s.reset().unwrap();
        assert_eq!(s.census().unwrap(), Census::default());
        assert_eq!(s.count().unwrap(), 0);
        assert!(s.get(&a.id).unwrap().is_none());
        assert!(!s.undelete(&c.id).unwrap(), "the deleted one went too");
        assert!(
            s.search("aaa", 10).unwrap().is_empty(),
            "and the index with it"
        );
        assert_eq!(std::fs::read_dir(d.path.join("docs")).unwrap().count(), 0);
        // And it is a store again: the next document is the first.
        let again = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
        assert_eq!(s.count().unwrap(), 1);
        assert!(s.previous(&again).unwrap().is_none());
        let _ = b;
    }

    /// A desk is not a document, which is a sentence about what the library
    /// reads: the tree, the inbox, the queue, the counts and the search index
    /// are all documents' and a desk is in none of them. What it does share is
    /// the ending -- a reset promises a store as `open` makes it on a machine
    /// that has never seen snyvi, and a workspace left standing would make
    /// that false.
    #[test]
    fn a_desk_is_not_a_document_and_a_reset_still_takes_it() {
        let (s, _d) = temp_store();
        s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
        let desk = s.create_desk("/home/p/snyvi", None).unwrap();
        assert!(matches!(
            s.open_pane(desk.id, "/home/p/snyvi", "").unwrap(),
            Opened::Pane(_)
        ));

        // Nothing that reads the library can see it -- and the reset that
        // would take it says so.
        assert_eq!(s.count().unwrap(), 1);
        assert_eq!(s.census().unwrap().documents, 1);
        assert_eq!(s.census().unwrap().desks, 1);
        assert!(s.search("snyvi", 10).unwrap().is_empty());
        assert_eq!(s.projects().unwrap().len(), 1, "the desk made no project");
        assert_eq!(s.inbox(10).unwrap().len(), 1);
        assert!(s.get(&desk.id.to_string()).unwrap().is_none());

        // And it survives a restart, because that is what a desk is for.
        assert_eq!(s.desks().unwrap().len(), 1);
        assert_eq!(s.panes_open().unwrap(), 1);

        s.reset().unwrap();
        assert_eq!(s.census().unwrap(), Census::default());
        assert!(s.desks().unwrap().is_empty());
        assert_eq!(s.panes_open().unwrap(), 0);
        // A store again: the next desk is the first.
        let again = s.create_desk("/home/p/snyvi", None).unwrap();
        assert_eq!(again.name, "snyvi");
    }

    /// The rail's Documents list: what a pane on this desk sent, newest
    /// first, and nothing another desk sent or the CLI did. A delete takes a
    /// row off it, and an open clears its mark.
    #[test]
    fn a_desk_lists_what_its_panes_sent_newest_first() {
        let (s, _d) = temp_store();
        let here = Origin {
            id: 7,
            name: "snyvi".into(),
            slot: 2,
        };
        let elsewhere = Origin {
            id: 8,
            name: "other".into(),
            slot: 1,
        };
        fn from<'a>(o: &'a Origin, mut d: NewDoc<'a>) -> NewDoc<'a> {
            d.desk = Some(o);
            d
        }
        s.insert(&new_id("a"), from(&here, new_doc("First", "aaa", "w")))
            .unwrap();
        s.insert(
            &new_id("b"),
            from(&elsewhere, new_doc("Theirs", "bbb", "w")),
        )
        .unwrap();
        s.insert(&new_id("c"), new_doc("From the CLI", "ccc", "w"))
            .unwrap();
        let last = s
            .insert(&new_id("d"), from(&here, new_doc("Second", "ddd", "w")))
            .unwrap();

        let docs = s.desk_docs(7, 40).unwrap();
        assert_eq!(
            docs.iter().map(|d| d.title.as_str()).collect::<Vec<_>>(),
            ["Second", "First"]
        );
        assert_eq!(docs[0].slot, 2);
        assert!(docs[0].unread);
        assert_eq!(docs[0].project, "p");
        assert_eq!(s.desk_docs(8, 40).unwrap().len(), 1);
        assert!(s.desk_docs(9, 40).unwrap().is_empty());

        s.mark_read(&last.id).unwrap();
        assert!(!s.desk_docs(7, 40).unwrap()[0].unread);
        s.delete(&last.id).unwrap();
        assert_eq!(s.desk_docs(7, 40).unwrap().len(), 1);

        // The same file again is the same row, not another: a pane rewriting
        // what it sent leaves the desk holding one of it.
        let again = s
            .insert(
                &new_id("e"),
                from(&here, version_of("aaa", "First, again", "eee", "w")),
            )
            .unwrap();
        assert_eq!(
            s.desk_docs(7, 40)
                .unwrap()
                .iter()
                .map(|d| d.title.as_str())
                .collect::<Vec<_>>(),
            ["First, again"]
        );
        // ...and a version of it sent from anywhere else leaves that row alone,
        // because what a desk shows is what its own panes sent.
        s.insert(
            &new_id("f"),
            version_of("aaa", "First, elsewhere", "fff", "w"),
        )
        .unwrap();
        let listed = s.desk_docs(7, 40).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, again.id);
    }

    /// A delete is gone from everywhere that reads the library and still on
    /// disk, so Undo is one column -- and `prune` is what makes it final.
    #[test]
    fn a_file_sent_again_is_one_row_with_its_versions_behind_it() {
        let (s, _d) = temp_store();
        let first = s
            .insert(&new_id("1"), version_of("/p/S.md", "Script", "one", "w"))
            .unwrap();
        let second = s
            .insert(&new_id("2"), version_of("/p/S.md", "Script v2", "two", "w"))
            .unwrap();
        let third = s
            .insert(
                &new_id("3"),
                version_of("/p/S.md", "Script v3", "three", "w"),
            )
            .unwrap();
        let other = s
            .insert(&new_id("o"), new_doc("Notes", "elsewhere", "w"))
            .unwrap();

        // Every list shows the newest send and the other document. This is the
        // pile the sidebar used to be: one script, sent three times, three rows.
        let titles = |v: Vec<Doc>| v.into_iter().map(|d| d.title).collect::<Vec<_>>();
        assert_eq!(titles(s.inbox(10).unwrap()), vec!["Notes", "Script v3"]);
        let wfs = s.project_tree(first.project_id, 0, 0).unwrap();
        assert_eq!(titles(s.queue(10).unwrap()), vec!["Script v3", "Notes"]);
        assert_eq!(
            wfs[0]
                .docs
                .iter()
                .map(|d| d.title.as_str())
                .collect::<Vec<_>>(),
            ["Notes", "Script v3"]
        );
        assert_eq!(wfs[0].total, 2, "and it says two, not four");
        assert_eq!(s.projects().unwrap()[0].docs, 2);

        // Nothing was thrown away: the versions are where a reader goes for them.
        let hist = s.history(first.project_id, "/p/S.md").unwrap();
        assert_eq!(titles(hist), vec!["Script v3", "Script v2", "Script"]);
        assert_eq!(s.get(&first.id).unwrap().unwrap().title, "Script");
        assert_eq!(
            s.latest_for_path("/p", "/p/S.md").unwrap().unwrap().id,
            third.id
        );

        // And two things are waiting, not four: a version that replaced an
        // unread one took its place on the queue rather than queueing beside
        // it, so the badge counts rows a reader can actually reach.
        assert_eq!(s.waiting().unwrap(), 2);
        assert!(!s.mark_read(&second.id).unwrap(), "already off the queue");
        assert!(s.mark_read(&third.id).unwrap());
        assert_eq!(s.waiting().unwrap(), 1);
        let _ = other;
    }

    #[test]
    fn removing_a_document_takes_its_versions_and_undo_brings_them_back() {
        let (s, _d) = temp_store();
        let first = s
            .insert(&new_id("1"), version_of("/p/S.md", "Script", "one", "w"))
            .unwrap();
        let newest = s
            .insert(&new_id("2"), version_of("/p/S.md", "Script v2", "two", "w"))
            .unwrap();
        let keep = s
            .insert(&new_id("k"), new_doc("Notes", "elsewhere", "w"))
            .unwrap();

        // One ✕ on one row removes one document, versions and all -- otherwise
        // the version behind it takes its place and the delete reads as undone.
        assert!(s.delete(&newest.id).unwrap());
        assert!(s.get(&first.id).unwrap().is_none());
        assert_eq!(s.inbox(10).unwrap().len(), 1);
        assert!(s.history(first.project_id, "/p/S.md").unwrap().is_empty());
        assert_eq!(s.get(&keep.id).unwrap().unwrap().title, "Notes");

        assert!(s.undelete(&newest.id).unwrap());
        assert_eq!(
            s.history(first.project_id, "/p/S.md").unwrap().len(),
            2,
            "both versions came back, not just the one that was clicked"
        );
        assert_eq!(s.inbox(10).unwrap().len(), 2);

        // Reading an old version and pressing Delete removes the same thing: the
        // document it is a version of. Which snapshot is on screen is not a
        // different document to delete.
        assert!(s.delete(&first.id).unwrap());
        assert!(s.history(first.project_id, "/p/S.md").unwrap().is_empty());
        assert!(s.undelete(&first.id).unwrap());
        assert_eq!(s.history(first.project_id, "/p/S.md").unwrap().len(), 2);
    }

    #[test]
    fn a_delete_can_be_taken_back_until_prune() {
        let (s, _d) = temp_store();
        let a = s.insert(&new_id("a"), new_doc("A", "alpha", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "bravo", "w")).unwrap();
        assert!(s.delete(&b.id).unwrap());
        assert!(
            !s.delete(&b.id).unwrap(),
            "deleting it again changes nothing"
        );

        // Gone from every way the library is read.
        assert!(s.get(&b.id).unwrap().is_none());
        assert_eq!(s.count().unwrap(), 1);
        assert_eq!(s.inbox(10).unwrap().len(), 1);
        assert_eq!(s.waiting().unwrap(), 1, "and off the queue");
        assert!(s.search("bravo", 10).unwrap().is_empty());
        let wfs = s.project_tree(a.project_id, 0, 0).unwrap();
        assert_eq!(wfs[0].total, 1);
        assert_eq!(wfs[0].docs.len(), 1);
        assert_eq!(s.projects().unwrap()[0].docs, 1, "the sidebar's count too");
        assert!(s.html(&b.id).is_ok(), "still on disk");

        // And back, queue place and all.
        assert!(s.undelete(&b.id).unwrap());
        assert!(!s.undelete(&b.id).unwrap(), "undoing twice changes nothing");
        assert_eq!(s.get(&b.id).unwrap().unwrap().title, "B");
        assert_eq!(s.waiting().unwrap(), 2);
        assert_eq!(s.search("bravo", 10).unwrap().len(), 1);

        // Pruned, and now it is gone for good -- pinned or not, old or not.
        assert!(s.set_pinned(&b.id, true).unwrap());
        assert!(s.delete(&b.id).unwrap());
        let gone = s.prune(0, false).unwrap();
        assert_eq!(gone.len(), 1, "nothing here is old enough but this one");
        assert_eq!(gone[0].0, b.id);
        assert!(!s.undelete(&b.id).unwrap(), "nothing left to put back");
        assert!(s.html(&b.id).is_err(), "files removed");
        assert_eq!(s.get(&a.id).unwrap().unwrap().title, "A");
    }

    /// The queue is the unread set in arrival order: every insert joins it,
    /// an open leaves it once, an overwrite changes nothing about it, and a
    /// clear empties it and says what left.
    #[test]
    fn the_queue_is_what_arrived_and_was_not_opened() {
        let (s, _d) = temp_store();
        assert!(s.queue(10).unwrap().is_empty());
        let a = s.insert(&new_id("a"), new_doc("A", "aaa", "w")).unwrap();
        let b = s.insert(&new_id("b"), new_doc("B", "bbb", "w")).unwrap();
        let ids = |q: Vec<Doc>| q.into_iter().map(|d| d.id).collect::<Vec<_>>();
        assert_eq!(
            ids(s.queue(10).unwrap()),
            vec![a.id.clone(), b.id.clone()],
            "oldest first"
        );
        assert_eq!(s.waiting().unwrap(), 2);
        assert!(s.mark_read(&a.id).unwrap());
        assert!(!s.mark_read(&a.id).unwrap(), "already read");
        assert_eq!(s.waiting().unwrap(), 1);
        assert_eq!(ids(s.queue(10).unwrap()), vec![b.id.clone()]);
        s.replace(&b.id, new_doc("B2", "bbb2", "w")).unwrap();
        assert_eq!(
            ids(s.queue(10).unwrap()),
            vec![b.id.clone()],
            "an overwrite is not an arrival"
        );
        let c = s.insert(&new_id("c"), new_doc("C", "ccc", "w")).unwrap();
        let cleared = s.mark_all_read().unwrap();
        assert_eq!(cleared, vec![b.id, c.id]);
        assert!(s.queue(10).unwrap().is_empty());
        assert!(s.mark_all_read().unwrap().is_empty());
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

    /// The sidebar is bounded, which is the whole point of these three queries:
    /// a project row costs the same whatever is behind it, an expanded project
    /// is a screenful, and everything past the caps is still reachable -- whole,
    /// and only when asked for.
    #[test]
    fn an_expanded_project_is_a_screenful_not_a_year() {
        let (s, _d) = temp_store();
        // Twelve sessions of twelve documents: past both caps, in both
        // directions, so a cap that only held in one would show here.
        for w in 0..12 {
            for i in 0..12 {
                let body = format!("session {w}, document {i}");
                s.insert(
                    &new_id(&format!("d{w}-{i}")),
                    new_doc("Plan", &body, &format!("sess-{w}")),
                )
                .unwrap();
            }
        }

        let p = s.projects().unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(
            (p[0].docs, p[0].workflows),
            (144, 12),
            "a row carries what is behind it as two numbers, not as rows"
        );

        let capped = s.project_tree(p[0].id, 10, 10).unwrap();
        assert_eq!(capped.len(), 10, "ten of the twelve sessions");
        assert!(
            capped.iter().all(|w| w.docs.len() == 10 && w.total == 12),
            "ten documents each, and each says it holds twelve"
        );

        let all = s.project_tree(p[0].id, 0, 0).unwrap();
        assert_eq!(all.len(), 12, "a zero cap is a reader asking for the rest");
        assert!(all.iter().all(|w| w.docs.len() == 12));

        // What `[` and `]` walk. Never capped: a reader stepping back through
        // the versions of a plan has to reach the first one.
        let w = s.workflow_tree(capped[0].id).unwrap().unwrap();
        assert_eq!((w.docs.len(), w.total), (12, 12));
        assert!(s.workflow_tree(9999).unwrap().is_none());
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
