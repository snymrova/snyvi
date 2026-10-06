//! On-disk store: one source and one rendered HTML file per document,
//! plus a SQLite index with full-text search.

use crate::config::Paths;
use crate::desk::{self, Desk, Opened, Origin, Placed};
use crate::peer;
use crate::thread;
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
    /// Who sent it: the MCP client's name, or a friend's (`origin` is
    /// `peer`), so the head can say "from Trapti". Empty otherwise.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sender: String,
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
    /// Its size in bytes, so the page can decide what a hover is allowed to
    /// fetch ahead of a click without asking.
    pub size: i64,
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
    /// When its newest document arrived: what the Inbox's "more" row says the
    /// projects past the cut have been quiet since.
    pub latest: i64,
    /// A friend's own row (`peer::Peer::project_root`). Its root is no
    /// folder, so it is sent empty: what the page does with a root -- the
    /// desk glyph, New desk here, Copy path, the file manager -- has nothing
    /// to work on there, and the page offers none of it on an empty one.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub friend: bool,
}

/// A project's row from `projects`' columns: id, name, root, docs,
/// workflows, latest.
fn row_project(r: &rusqlite::Row) -> rusqlite::Result<TreeProject> {
    let root: String = r.get(2)?;
    let friend = root.starts_with("peer:");
    Ok(TreeProject {
        id: r.get(0)?,
        name: r.get(1)?,
        root: if friend { String::new() } else { root },
        docs: r.get(3)?,
        workflows: r.get(4)?,
        latest: r.get(5)?,
        friend,
    })
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
    /// A body too big to hold, already copied into the docs dir. When set it
    /// is the body and `source` is empty.
    pub staged: Option<&'a Staged>,
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

/// The search index's row for a document sits at the document's rowid in
/// `docs`, so taking it out on a save is one lookup: `id` is UNINDEXED, and
/// a delete by it read the whole index -- 18.7 MB at 541 documents, on every
/// save of anything. `docs` has an implicit rowid that nothing renumbers:
/// `VACUUM` runs only in `reset`, after every table is emptied. The body
/// indexed is the first `SEARCH_CAP` bytes of the text (receive.rs); what
/// anyone searches for is in the first half-megabyte of a 32 MB file.
const FTS_INSERT: &str =
    "INSERT INTO docs_fts(rowid, id, title, body) SELECT rowid, ?1, ?2, ?3 FROM docs WHERE id = ?1";
const FTS_DELETE: &str =
    "DELETE FROM docs_fts WHERE rowid = (SELECT rowid FROM docs WHERE id = ?1)";

const DOC_COLS: &str = "d.id, d.project_id, p.name, d.workflow_id, w.key, w.title, d.title, d.kind, d.lang, d.size, d.received_at, d.source_path, d.branch, d.pinned, d.origin, d.content_hash, d.desk_id, d.desk_name, d.desk_slot, d.sender";
const DOC_FROM: &str =
    "FROM live_docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id";
/// The same join over `head_docs`: what every list of documents reads, so one
/// file sent seven times is one row. Reaching a version that is not the head is
/// deliberate -- `history`, `previous` and `get` go through `DOC_FROM`.
const HEAD_FROM: &str =
    "FROM head_docs d JOIN projects p ON p.id = d.project_id JOIN workflows w ON w.id = d.workflow_id";

/// What the schema has gained since the tables were first made, each step an
/// `ALTER TABLE … ADD COLUMN`, grouped by the version `PRAGMA user_version`
/// records once they have run.
///
/// Version 1 is every column added through 1.13. Those used to run on every
/// start with their errors dropped, so a database from before the version
/// was counted says 0 and may already hold any prefix of them: version 1
/// alone takes "duplicate column" as done, and `migrate` says 1 after it.
/// From 2 on, a step runs once, in a transaction with the rest of its
/// version, and an error is an error -- a daemon that cannot bring its
/// database forward says so and stops, rather than running on a schema it
/// half has.
const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE docs ADD COLUMN origin TEXT NOT NULL DEFAULT 'cli'",
    ),
    (
        1,
        "ALTER TABLE projects ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0",
    ),
    // Read, for everything that was here before there was a queue: a
    // library's worth of old documents is not a backlog.
    (
        1,
        "ALTER TABLE docs ADD COLUMN unread INTEGER NOT NULL DEFAULT 0",
    ),
    // Deleted, and still here until `prune` says otherwise -- which is
    // what makes "Undo" in the toast something the daemon can honour.
    (
        1,
        "ALTER TABLE docs ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0",
    ),
    // Who sent it, by the name the MCP client gave in `initialize`,
    // so the connect page can say when an agent last worked.
    (
        1,
        "ALTER TABLE docs ADD COLUMN sender TEXT NOT NULL DEFAULT ''",
    ),
    // Which desk and slot it came from, when it came from a pane.
    // Copied, not joined: a desk that is closed later does not take
    // the document's provenance with it.
    (
        1,
        "ALTER TABLE docs ADD COLUMN desk_id INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE docs ADD COLUMN desk_name TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE docs ADD COLUMN desk_slot INTEGER NOT NULL DEFAULT 0",
    ),
    // The Claude conversation a pane last had, to offer it back.
    (
        1,
        "ALTER TABLE panes ADD COLUMN agent_session TEXT NOT NULL DEFAULT ''",
    ),
    // Who ticked a desk's line, when an agent did.
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN done_by TEXT NOT NULL DEFAULT ''",
    ),
    // Marked by a planned restart: bring this pane back as
    // `claude --resume`. Taken by the daemon that comes up next.
    (
        1,
        "ALTER TABLE panes ADD COLUMN resume_next INTEGER NOT NULL DEFAULT 0",
    ),
    // 1.7.1: what the reader called a panel, and a desk's full view.
    (
        1,
        "ALTER TABLE panes ADD COLUMN name TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN full_slot INTEGER NOT NULL DEFAULT 0",
    ),
    // 1.7.1: where an agent's tick says the work went.
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN done_commit TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN done_doc TEXT NOT NULL DEFAULT ''",
    ),
    // 1.8: a closed desk is kept, with its notes, until prune.
    (
        1,
        "ALTER TABLE desks ADD COLUMN closed_at INTEGER NOT NULL DEFAULT 0",
    ),
    // 1.8: where the work was left, and a tick's evidence and an
    // agent's suggested line.
    (
        1,
        "ALTER TABLE desks ADD COLUMN left_off TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN left_off_at INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN left_off_by TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN left_off_about TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN done_evidence TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN suggested_by TEXT NOT NULL DEFAULT ''",
    ),
    // 1.9: when a desk was last opened, and a desk on the shelf.
    (
        1,
        "ALTER TABLE desks ADD COLUMN visited_at INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN parked_at INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN parked_next TEXT NOT NULL DEFAULT ''",
    ),
    // 1.10: when the reader took a document off its desk's list. The
    // desk's list only: the library, the Inbox and search still have it.
    (
        1,
        "ALTER TABLE docs ADD COLUMN desk_off INTEGER NOT NULL DEFAULT 0",
    ),
    // 1.10: pictures on a desk's line.
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN images TEXT NOT NULL DEFAULT ''",
    ),
    // 1.10: how far an agent has got with a line, short of done.
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage_by TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage_doc TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage_at INTEGER NOT NULL DEFAULT 0",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage_pane TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN stage_session TEXT NOT NULL DEFAULT ''",
    ),
    // 1.13: the pane a tick or a left-off came from, so a panel is not
    // told its own doings as news at its next prompt.
    (
        1,
        "ALTER TABLE desk_notes ADD COLUMN done_pane TEXT NOT NULL DEFAULT ''",
    ),
    (
        1,
        "ALTER TABLE desks ADD COLUMN left_off_pane TEXT NOT NULL DEFAULT ''",
    ),
    // 1.14: the reader's order for the desks, starting as the order they
    // were made in, so nothing moves on the upgrade.
    (2, desk::POS_COLUMN),
    (2, "UPDATE desks SET pos = id"),
    // 1.15: a desk's kind, and a studio desk's folder.
    (3, desk::KIND_COLUMNS[0]),
    (3, desk::KIND_COLUMNS[1]),
    // 1.16: the studio retired; its desk is a terminal desk.
    (4, desk::RETIRE_STUDIO),
    // 1.17: what used to run on every start with its errors dropped. Keys
    // used to be case-sensitive, so the same workflow could exist twice;
    // the duplicates fold into the oldest row.
    (
        5,
        "UPDATE docs SET workflow_id = (
             SELECT MIN(w2.id) FROM workflows w2
             JOIN workflows w1 ON w1.id = docs.workflow_id
             WHERE w2.project_id = w1.project_id AND LOWER(w2.key) = LOWER(w1.key)
         );
         DELETE FROM workflows WHERE id NOT IN (SELECT DISTINCT workflow_id FROM docs);
         UPDATE workflows SET key = LOWER(key) WHERE key <> LOWER(key);",
    ),
    // 1.17: the search index realigned so each row sits at its document's
    // rowid (see `FTS_DELETE`), bodies cut to what is indexed from now on.
    // One pass over the index, once. A document that somehow had two index
    // rows keeps the newer.
    (
        5,
        "CREATE TEMP TABLE fts_at AS
             SELECT d.rowid AS r, MAX(f.rowid) AS fr FROM docs_fts f JOIN docs d ON d.id = f.id GROUP BY d.rowid;
         CREATE TEMP TABLE fts_rows AS
             SELECT t.r AS r, f.id AS id, f.title AS title, substr(f.body, 1, 524288) AS body
             FROM fts_at t JOIN docs_fts f ON f.rowid = t.fr;
         DELETE FROM docs_fts;
         INSERT INTO docs_fts(rowid, id, title, body) SELECT r, id, title, body FROM fts_rows;
         DROP TABLE fts_rows;
         DROP TABLE fts_at;",
    ),
    // 1.17: whether a row is the newest live version of its file, kept by
    // every write that can change it (`rehead`), so the lists read a column
    // where they used to run a subquery per row.
    (
        6,
        "ALTER TABLE docs ADD COLUMN is_head INTEGER NOT NULL DEFAULT 1",
    ),
    (
        6,
        "UPDATE docs SET is_head = CASE
             WHEN rowid = (SELECT d2.rowid FROM docs d2
                           WHERE d2.project_id = docs.project_id AND d2.source_path = docs.source_path
                             AND d2.deleted_at = 0
                           ORDER BY d2.received_at DESC, d2.rowid DESC LIMIT 1) THEN 1
             ELSE 0 END
         WHERE source_path IS NOT NULL",
    ),
    // 1.19: where a friend's things land (`peers.desk_id`, 0 for their own
    // row), a line waiting in the outbox as a document does (`text`, with
    // no document), and who sent a desk's line when it came from a friend
    // (`sent_by`, which keeping a suggestion does not clear).
    (7, peer::COLUMNS_1_19[0]),
    (7, peer::COLUMNS_1_19[1]),
    (7, desk::SENT_BY_COLUMN),
    // 1.20: the thread a desk's line is in (`crate::thread`).
    (8, thread::THREAD_COLUMN),
];

/// A desk's list, read through `docs_desk` (desk, on or off the list, when):
/// the one index a four-column `WHERE` on a desk's documents needs, and
/// `?1` the desk, `?2` the limit.
fn desk_docs_sql(off: bool) -> String {
    format!(
        "SELECT d.id, d.title, d.kind, d.received_at, d.unread, d.pinned, d.desk_slot, p.name, d.source_path
         FROM live_docs d JOIN projects p ON p.id = d.project_id
         WHERE d.desk_id = ?1 AND d.desk_off {}
           AND (d.source_path IS NULL
                OR d.rowid = (SELECT d2.rowid FROM live_docs d2
                              WHERE d2.desk_id = ?1 AND d2.project_id = d.project_id
                                AND d2.source_path = d.source_path
                              ORDER BY d2.received_at DESC, d2.rowid DESC LIMIT 1))
         ORDER BY {} d.received_at DESC, d.rowid DESC LIMIT ?2",
        if off { "> 0" } else { "= 0" },
        if off { "d.desk_off DESC," } else { "" },
    )
}

/// Keep `is_head` true on exactly the newest live version of one file, after
/// a write that could have moved it: a version arriving, going, coming back,
/// or being pruned. Every row of the file is set, so a row that stops being
/// the head says so too. The subquery is constant for the statement, so
/// SQLite runs it once and the rest is one pass over the file's versions.
fn rehead(conn: &Connection, project_id: i64, source_path: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE docs SET is_head = CASE
             WHEN rowid = (SELECT d2.rowid FROM docs d2
                           WHERE d2.project_id = ?1 AND d2.source_path = ?2 AND d2.deleted_at = 0
                           ORDER BY d2.received_at DESC, d2.rowid DESC LIMIT 1) THEN 1
             ELSE 0 END
         WHERE project_id = ?1 AND source_path = ?2",
        params![project_id, source_path],
    )
}

/// Bring a database to the newest version in `MIGRATIONS`.
fn migrate(conn: &Connection) -> Result<()> {
    let have: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .context("reading the schema version")?;
    let latest = MIGRATIONS.last().map(|(v, _)| *v).unwrap_or(0);
    if have >= latest {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for (version, stmt) in MIGRATIONS.iter().filter(|(v, _)| *v > have) {
        match tx.execute_batch(stmt) {
            Ok(()) => {}
            Err(e) if *version == 1 && e.to_string().contains("duplicate column name") => {}
            Err(e) => return Err(e).with_context(|| format!("schema step {version}: {stmt}")),
        }
    }
    tx.execute_batch(&format!("PRAGMA user_version = {latest}"))?;
    tx.commit()?;
    Ok(())
}

impl Store {
    pub fn open(paths: &Paths) -> Result<Store> {
        fs::create_dir_all(&paths.data_dir).context("creating data dir")?;
        fs::create_dir_all(&paths.docs_dir).context("creating docs dir")?;
        // A copy cut short by a crash. Nothing points at it.
        if let Ok(dir) = fs::read_dir(&paths.docs_dir) {
            for e in dir.flatten() {
                if e.file_name().to_string_lossy().starts_with(".stage-") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        let conn = Connection::open(&paths.db_path).context("opening database")?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        conn.execute_batch(SCHEMA)?;
        // Desks live in the same database and in tables of their own; see
        // `crate::desk` for why that separation is the whole of the boundary.
        conn.execute_batch(desk::SCHEMA)?;
        // Friends, and what is on its way to or from one (`crate::peer`).
        conn.execute_batch(peer::SCHEMA)?;
        // Threads, turns and suggested panels (`crate::thread`).
        conn.execute_batch(thread::SCHEMA)?;
        migrate(&conn)?;
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
        //
        // Which row is the head is a column, `is_head`, kept by `rehead` on
        // every write that can move it. It used to be a subquery in the view,
        // run once per row of every list: forty steps a document, on each
        // redraw of the sidebar.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS docs_unread ON docs(unread, received_at);
             CREATE INDEX IF NOT EXISTS docs_path ON docs(project_id, source_path, received_at);
             CREATE INDEX IF NOT EXISTS docs_desk ON docs(desk_id, desk_off, received_at);
             CREATE INDEX IF NOT EXISTS docs_head ON docs(project_id, is_head, deleted_at, received_at);
             DROP VIEW IF EXISTS live_docs;
             CREATE VIEW live_docs AS SELECT rowid AS rowid, * FROM docs WHERE deleted_at = 0;
             DROP VIEW IF EXISTS head_docs;
             CREATE VIEW head_docs AS SELECT * FROM live_docs d WHERE d.is_head = 1;",
        )?;
        Ok(Store {
            conn: Mutex::new(conn),
            docs_dir: paths.docs_dir.clone(),
        })
    }

    /// Where a document's body is kept. Handed out so a large one can be
    /// streamed from disk instead of read whole.
    pub fn src_path(&self, id: &str) -> PathBuf {
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
        let id = id.to_string();
        // Files first, so a crash never leaves a row without a body.
        let (hash, size) = self.put_source(&id, &d)?;
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
            "INSERT INTO docs(id, project_id, workflow_id, title, kind, lang, size, received_at, source_path, branch, content_hash, pinned, origin, unread, sender, desk_id, desk_name, desk_slot, is_head)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, 1, ?13, ?14, ?15, ?16, 1)",
            params![id, project_id, workflow_id, d.title, d.kind.as_str(), d.lang, size, now, d.source_path, d.branch, hash, d.origin, d.sender,
                d.desk.map_or(0, |o| o.id), d.desk.map_or("", |o| o.name.as_str()), d.desk.map_or(0, |o| o.slot)],
        )?;
        tx.execute(FTS_INSERT, params![id, d.title, d.search_body])?;
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
            rehead(&tx, project_id, sp)?;
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
            size,
            received_at: now,
            source_path: d.source_path.map(str::to_string),
            branch: d.branch.map(str::to_string),
            pinned: false,
            origin: d.origin.to_string(),
            content_hash: hash,
            desk: d.desk.cloned(),
            sender: d.sender.to_string(),
        })
    }

    /// Overwrite an existing document's content in place (used to coalesce rapid
    /// hook-driven edits of the same file into one snapshot).
    ///
    /// The HTML is always written: a renderer or a theme can change what the
    /// same source looks like. The search index is rewritten only when the
    /// source did change -- the row's `content_hash` says -- since
    /// re-tokenising a body that is the same body is the one cost of a save
    /// that buys nothing.
    pub fn replace(&self, id: &str, d: NewDoc) -> Result<Doc> {
        let now = now();
        let (hash, size) = self.put_source(id, &d)?;
        // The source changed under it, so the outline is worked out again.
        let _ = fs::remove_file(self.outline_path(id));
        let mut conn = self.conn.lock().unwrap();
        // The page is written under the lock, with the hash that says which
        // source it is of: a background highlight checks that hash under the
        // same lock before it writes (`replace_html_if`), so it can never put
        // an older render over this one.
        fs::write(self.html_path(id), d.html)?;
        let tx = conn.transaction()?;
        let before: Option<(String, i64, Option<String>)> = tx
            .query_row(
                "SELECT content_hash, project_id, source_path FROM docs WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((old_hash, project_id, source_path)) = before else {
            anyhow::bail!("replaced document vanished");
        };
        tx.execute(
            "UPDATE docs SET title = ?2, kind = ?3, lang = ?4, size = ?5, received_at = ?6, branch = ?7, content_hash = ?8 WHERE id = ?1",
            params![id, d.title, d.kind.as_str(), d.lang, size, now, d.branch, hash],
        )?;
        if old_hash != hash {
            tx.execute(FTS_DELETE, params![id])?;
            tx.execute(FTS_INSERT, params![id, d.title, d.search_body])?;
        }
        // It moved to now, which can only confirm it as the head; set all the
        // same, so the column is a fact and not an argument.
        if let Some(sp) = &source_path {
            rehead(&tx, project_id, sp)?;
        }
        tx.commit()?;
        drop(conn);
        self.get(id)?.context("replaced document vanished")
    }

    /// The page, written only if the document is still the source `hash`
    /// names. False when a newer save got there first; its render stands.
    pub fn replace_html_if(&self, id: &str, html: &str, hash: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM docs WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if now.as_deref() != Some(hash) {
            return Ok(false);
        }
        fs::write(self.html_path(id), html)?;
        Ok(true)
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

    /// A document's body as text. A body over the send cap is a video or a
    /// song, and reading it whole to find that out would be a gigabyte in
    /// memory, so the size is asked first.
    pub fn source(&self, id: &str) -> Result<String> {
        self.small(id)?;
        Ok(fs::read_to_string(self.src_path(id))?)
    }

    fn small(&self, id: &str) -> Result<()> {
        let len = fs::metadata(self.src_path(id))?.len();
        if len > crate::receive::MAX_BYTES as u64 {
            anyhow::bail!("{id} is {} MB, too large to read into memory", len >> 20);
        }
        Ok(())
    }

    /// Write a new body, from memory or from the stage, and say what it
    /// hashes to and how long it is.
    fn put_source(&self, id: &str, d: &NewDoc) -> Result<(String, i64)> {
        match d.staged {
            Some(st) => {
                fs::rename(&st.path, self.src_path(id))?;
                Ok((st.hash.clone(), st.len as i64))
            }
            None => {
                fs::write(self.src_path(id), d.source)?;
                Ok((
                    blake3::hash(d.source).to_hex().to_string(),
                    d.source.len() as i64,
                ))
            }
        }
    }

    /// Copy a file into the docs dir without ever holding it: a buffer at a
    /// time, hashed on the way through. What a video sent by path goes
    /// through, so the daemon's memory does not grow with what it is sent.
    ///
    /// The copy is taken, not a link to the original, so the document stays
    /// readable when the file moves or goes. `cap` is checked against the
    /// bytes actually read as well as the size up front, for a file still
    /// being written to.
    pub fn stage(&self, from: &std::path::Path, cap: u64) -> Result<Staged> {
        use std::io::{Read, Write};
        let mut src =
            fs::File::open(from).with_context(|| format!("reading {}", from.display()))?;
        let gb = |n: u64| format!("{:.1} GB", n as f64 / (1u64 << 30) as f64);
        let too_big = |n: u64| {
            anyhow::anyhow!(
                "{} is {}; snyvi keeps media up to {}. `snyvi browse` on its folder plays it where it is.",
                from.display(),
                gb(n),
                gb(cap).replace(".0 ", " ")
            )
        };
        let len = src.metadata()?.len();
        if len > cap {
            return Err(too_big(len));
        }
        let mut st = Staged {
            path: self
                .docs_dir
                .join(format!(".stage-{}", new_id(&from.to_string_lossy()))),
            hash: String::new(),
            len: 0,
        };
        let mut out = fs::File::create(&st.path)?;
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = match src.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            };
            st.len += n as u64;
            if st.len > cap {
                return Err(too_big(st.len));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
        }
        st.hash = hasher.finalize().to_hex().to_string();
        Ok(st)
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
    /// not happen. Undo puts the same seven back. The page's ✕ goes through
    /// `delete_versions`, which says how many went.
    #[cfg(test)]
    pub fn delete(&self, id: &str) -> Result<bool> {
        Ok(self.delete_versions(id)? > 0)
    }

    /// The same, saying how many versions went: the page's Undo names them
    /// ("Removed · 3 versions"), so a ✕ that took seven says it took seven.
    pub fn delete_versions(&self, id: &str) -> Result<usize> {
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
            return Ok(0);
        };
        let n = match &source_path {
            Some(sp) => tx.execute(
                "UPDATE docs SET deleted_at = ?3 WHERE project_id = ?1 AND source_path = ?2 AND deleted_at = 0",
                params![project_id, sp, at],
            )?,
            None => tx.execute(
                "UPDATE docs SET deleted_at = ?2 WHERE id = ?1 AND deleted_at = 0",
                params![id, at],
            )?,
        };
        if let Some(sp) = &source_path {
            rehead(&tx, project_id, sp)?;
        }
        tx.commit()?;
        Ok(n)
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
        let n = match &source_path {
            Some(sp) => tx.execute(
                "UPDATE docs SET deleted_at = 0 WHERE project_id = ?1 AND source_path = ?2 AND deleted_at = ?3",
                params![project_id, sp, at],
            )?,
            None => tx.execute(
                "UPDATE docs SET deleted_at = 0 WHERE id = ?1 AND deleted_at != 0",
                params![id],
            )?,
        };
        if let Some(sp) = &source_path {
            rehead(&tx, project_id, sp)?;
        }
        tx.commit()?;
        Ok(n > 0)
    }

    /// What removals took that can still come back, newest first until
    /// prune takes it (`GET /api/removed`, the page's "Removed · Show"): the
    /// documents, one row per removal -- which is one row per lineage, named
    /// by its newest version, with how many went -- and, with `desks`, the
    /// notes taken off a desk's list, the panels closed on one and the desks closed. Each row
    /// carries the route that puts it back; the asides the daemon holds in
    /// memory are the server's to add.
    pub fn removed(&self, limit: usize, desks: bool) -> Result<Vec<Removed>> {
        let conn = self.conn.lock().unwrap();
        let mut out: Vec<Removed> = conn
            .prepare(
                // Named by its newest version: received_at counts whole
                // seconds, so versions sent together tie on it, and
                // insertion order breaks the tie, as `history` does.
                "SELECT id, title, name, deleted_at, n FROM (
                   SELECT d.id, d.title, p.name, d.deleted_at, COUNT(*) OVER w AS n,
                          ROW_NUMBER() OVER (w ORDER BY d.received_at DESC, d.rowid DESC) AS k
                   FROM docs d JOIN projects p ON p.id = d.project_id WHERE d.deleted_at != 0
                   WINDOW w AS (PARTITION BY d.project_id, COALESCE(d.source_path, d.id), d.deleted_at))
                 WHERE k = 1 ORDER BY deleted_at DESC LIMIT ?1",
            )?
            .query_map(params![limit as i64], |r| {
                let id: String = r.get(0)?;
                Ok(Removed {
                    kind: "doc",
                    restore: format!("/api/docs/{id}/undelete"),
                    id,
                    title: r.get(1)?,
                    from: r.get(2)?,
                    desk: None,
                    at: r.get(3)?,
                    versions: r.get::<_, i64>(4)? as usize,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        if desks {
            for (desk, id, name, text, at) in desk::removed_notes(&conn, limit)? {
                out.push(Removed {
                    kind: "note",
                    id: id.to_string(),
                    title: text,
                    from: name,
                    desk: Some(desk),
                    at,
                    versions: 1,
                    restore: format!("/api/desks/{desk}/notes/{id}/restore"),
                });
            }
            for (id, name, root, at) in desk::closed_desks(&conn, limit)? {
                out.push(Removed {
                    kind: "desk",
                    id: id.to_string(),
                    title: name,
                    from: root,
                    desk: Some(id),
                    at,
                    versions: 1,
                    restore: format!("/api/desks/{id}/reopen"),
                });
            }
            for (id, desk, name, label, at) in desk::closed_panes(&conn, limit)? {
                out.push(Removed {
                    kind: "panel",
                    restore: format!("/api/panes/{id}/restore"),
                    id,
                    title: label,
                    from: name,
                    desk: Some(desk),
                    at,
                    versions: 1,
                });
            }
        }
        out.sort_by_key(|a| std::cmp::Reverse(a.at));
        out.truncate(limit);
        Ok(out)
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

    /// The newest documents still unread, newest first: Home's Arrived,
    /// which reads what came last, where the queue reads oldest first.
    pub fn newest_unread(&self, limit: usize) -> Result<Vec<Doc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&format!(
                "SELECT {DOC_COLS} {HEAD_FROM} WHERE d.unread = 1 ORDER BY d.received_at DESC, d.rowid DESC LIMIT ?1"
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

    /// Mark all read, taken back: the ids it returned go back on the queue,
    /// except one removed since, which has no row to wait in. Returns the
    /// ones that went back.
    pub fn mark_unread(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut back = Vec::new();
        for id in ids {
            if tx.execute(
                "UPDATE docs SET unread = 1 WHERE id = ?1 AND unread = 0 AND deleted_at = 0",
                params![id],
            )? > 0
            {
                back.push(id.clone());
            }
        }
        tx.commit()?;
        Ok(back)
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
    /// A project's derived name follows what it is named for -- a friend's
    /// project follows the friend -- unless the reader named it themselves.
    /// Move a document, and every version of its file, into another project
    /// and onto a desk's list: a friend's document kept on a desk. The
    /// workflow goes with it by key, made in the new project if it is not
    /// there; who sent it, when, and its bytes stay as they were. `None`
    /// when there is no such document.
    pub fn move_lineage(
        &self,
        id: &str,
        root: &str,
        name: &str,
        desk: &Origin,
    ) -> Result<Option<Doc>> {
        let now = now();
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction()?;
            let Some((from, path, wf_key, wf_title)): Option<(
                i64,
                Option<String>,
                String,
                String,
            )> = tx
                .query_row(
                    "SELECT d.project_id, d.source_path, w.key, w.title FROM live_docs d
                     JOIN workflows w ON w.id = d.workflow_id WHERE d.id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?
            else {
                return Ok(None);
            };
            tx.execute(
                "INSERT INTO projects(root, name, created_at) VALUES(?1, ?2, ?3)
                 ON CONFLICT(root) DO NOTHING",
                params![root, name, now],
            )?;
            let to: i64 = tx.query_row(
                "SELECT id FROM projects WHERE root = ?1",
                params![root],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO workflows(project_id, key, title, created_at) VALUES(?1, ?2, ?3, ?4)
                 ON CONFLICT(project_id, key) DO NOTHING",
                params![to, wf_key, wf_title, now],
            )?;
            let wf: i64 = tx.query_row(
                "SELECT id FROM workflows WHERE project_id = ?1 AND key = ?2",
                params![to, wf_key],
                |r| r.get(0),
            )?;
            // The deleted versions too: an Undo of one brings it back where
            // its lineage now is.
            tx.execute(
                "UPDATE docs SET project_id = ?2, workflow_id = ?3, desk_id = ?4, desk_name = ?5, desk_slot = ?6, desk_off = 0
                 WHERE id = ?1 OR (?7 IS NOT NULL AND project_id = ?8 AND source_path = ?7)",
                params![id, to, wf, desk.id, desk.name, desk.slot, path, from],
            )?;
            if let Some(sp) = &path {
                rehead(&tx, to, sp)?;
            }
            tx.commit()?;
        }
        self.get(id)
    }

    pub fn rename_project_by_root(&self, root: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        Ok(conn.execute(
            "UPDATE projects SET name = ?2 WHERE root = ?1 AND renamed = 0",
            params![root, name],
        )? > 0)
    }

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
        // The files whose newest version may be among the victims: a pruned
        // head hands the row to the version before it.
        let mut files: std::collections::BTreeSet<(i64, String)> = Default::default();
        for (id, _) in &victims {
            let file: Option<(i64, Option<String>)> = tx
                .query_row(
                    "SELECT project_id, source_path FROM docs WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((pid, Some(sp))) = file {
                files.insert((pid, sp));
            }
            // The index row first: it is found through the document's row.
            tx.execute(FTS_DELETE, params![id])?;
            tx.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
        }
        for (pid, sp) in &files {
            rehead(&tx, *pid, sp)?;
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
                "SELECT p.id, p.name, p.root, COUNT(d.id), COUNT(DISTINCT d.workflow_id), MAX(d.received_at)
                 FROM projects p JOIN head_docs d ON d.project_id = p.id
                 GROUP BY p.id ORDER BY MAX(d.received_at) DESC, p.id DESC",
            )?
            .query_map([], row_project)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// One project's row, as `projects` would list it: what a `doc` event
    /// carries so a page can patch the one project that moved instead of
    /// fetching the tree again. None for a project with no documents.
    pub fn project_row(&self, project_id: i64) -> Result<Option<TreeProject>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT p.id, p.name, p.root, COUNT(d.id), COUNT(DISTINCT d.workflow_id), MAX(d.received_at)
             FROM projects p JOIN head_docs d ON d.project_id = p.id
             WHERE p.id = ?1 GROUP BY p.id",
            params![project_id],
            row_project,
        )
        .optional()
        .map_err(Into::into)
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
            "SELECT id, title, kind, received_at, pinned, unread, size FROM head_docs
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
                "SELECT id, title, kind, received_at, pinned, unread, size FROM head_docs
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
    ///
    /// `off` is the other half: the ones the reader removed from the list,
    /// newest removal first, for "N removed · Show". The head is found before
    /// the removal is looked at, so removing a file's newest version does not
    /// bring an older one up in its place; a new send is a new row, and shows.
    pub fn desk_docs(&self, desk_id: i64, limit: usize, off: bool) -> Result<Vec<DeskDoc>> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .prepare(&desk_docs_sql(off))?
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

    /// Take a document off its desk's list (`off`), or put it back. False when
    /// the document is not one this desk's panels sent.
    pub fn set_desk_doc_off(&self, desk_id: i64, doc: &str, off: bool) -> Result<bool> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE docs SET desk_off = ?3 WHERE id = ?2 AND desk_id = ?1 AND deleted_at = 0",
            params![desk_id, doc, if off { now() } else { 0 }],
        )?;
        Ok(n > 0)
    }

    pub fn create_desk(&self, root: &str, name: Option<&str>) -> Result<Desk> {
        desk::create(&self.conn.lock().unwrap(), root, name, now())
    }

    pub fn reorder_desks(&self, ids: &[i64]) -> Result<bool> {
        desk::reorder(&mut self.conn.lock().unwrap(), ids)
    }

    pub fn rename_desk(&self, id: i64, name: &str) -> Result<bool> {
        desk::rename(&self.conn.lock().unwrap(), id, name)
    }

    pub fn set_desk_layout(&self, id: i64, col: f64, row: f64, full: Option<i64>) -> Result<bool> {
        desk::layout(&self.conn.lock().unwrap(), id, col, row, full)
    }

    /// Close a desk (`desk::close`): the ids of the panes it closed.
    pub fn close_desk(&self, id: i64) -> Result<Option<Vec<String>>> {
        desk::close(&mut self.conn.lock().unwrap(), id, now())
    }

    pub fn reopen_desk(&self, id: i64) -> Result<bool> {
        desk::reopen(&mut self.conn.lock().unwrap(), id)
    }

    /// Closed desks older than `before` (`desk::prune_desks`), after their
    /// panes (`prune_panes`), which is what removes the panes' text.
    pub fn prune_desks(&self, before: i64, dry_run: bool) -> Result<Vec<(i64, String)>> {
        desk::prune_desks(&self.conn.lock().unwrap(), before, dry_run)
    }

    pub fn pane(&self, id: &str) -> Result<Option<Placed>> {
        desk::pane(&self.conn.lock().unwrap(), id)
    }

    pub fn set_pane_cmd(&self, id: &str, cmd: &str) -> Result<bool> {
        desk::set_cmd(&self.conn.lock().unwrap(), id, cmd)
    }

    pub fn set_pane_session(&self, id: &str, session: &str) -> Result<bool> {
        desk::set_agent_session(&self.conn.lock().unwrap(), id, session)
    }

    /// The panes a planned restart brings back as `claude --resume`
    /// (`desk::mark_resume`); how many were marked.
    pub fn mark_panes_resume(&self, ids: &[String]) -> Result<usize> {
        desk::mark_resume(&self.conn.lock().unwrap(), ids)
    }

    /// Those marks, as the daemon that comes up reads them
    /// (`desk::read_resume`): the planned restart's panes, then the ones to
    /// offer.
    pub fn panes_resume(&self) -> Result<(Vec<String>, Vec<String>)> {
        desk::read_resume(&self.conn.lock().unwrap())
    }

    /// And cleared, once that daemon holds the port (`desk::clear_resume`).
    pub fn clear_panes_resume(&self) -> Result<()> {
        desk::clear_resume(&self.conn.lock().unwrap())
    }

    /// Mark the panes that had Claude open, on an unplanned way out
    /// (`desk::mark_offer`).
    pub fn offer_panes_resume(&self, ids: &[String]) -> Result<usize> {
        desk::mark_offer(&self.conn.lock().unwrap(), ids)
    }

    // ---- friends (`crate::peer`) ------------------------------------------------
    //
    // Thin, like the desk's: the SQL is in `peer`, the lock and the clock are
    // here, so `api_peer` and the link never see a connection.

    /// Every friend, removed ones included (`peer::list`).
    pub fn peers(&self) -> Result<Vec<peer::Peer>> {
        peer::list(&self.conn.lock().unwrap())
    }

    pub fn peer(&self, id: i64) -> Result<Option<peer::Peer>> {
        peer::get(&self.conn.lock().unwrap(), id)
    }

    /// By address: the sender a frame names, looked up before it is opened.
    pub fn peer_by_key(&self, key: &str) -> Result<Option<peer::Peer>> {
        peer::by_sign_key(&self.conn.lock().unwrap(), key)
    }

    /// By the name the reader gave them, as an agent's offer says it.
    pub fn peer_by_name(&self, name: &str) -> Result<Option<peer::Peer>> {
        peer::by_name(&self.conn.lock().unwrap(), name)
    }

    /// Pin a friend's keys at pairing (`peer::pin`): the row as it stands,
    /// its name kept if the reader renamed them before.
    pub fn pin_peer(&self, p: &peer::Peer) -> Result<peer::Peer> {
        peer::pin(&self.conn.lock().unwrap(), p, now())
    }

    pub fn rename_peer(&self, id: i64, name: &str) -> Result<bool> {
        peer::rename(&self.conn.lock().unwrap(), id, name)
    }

    /// Where a friend's things land (`peer::set_desk`).
    pub fn set_peer_desk(&self, id: i64, desk_id: i64) -> Result<bool> {
        peer::set_desk(&self.conn.lock().unwrap(), id, desk_id)
    }

    pub fn mute_peer(&self, id: i64, muted: bool) -> Result<bool> {
        peer::mute(&self.conn.lock().unwrap(), id, muted)
    }

    /// Off the list, keys kept (`peer::remove`).
    pub fn remove_peer(&self, id: i64) -> Result<bool> {
        peer::remove(&self.conn.lock().unwrap(), id, now())
    }

    pub fn restore_peer(&self, id: i64) -> Result<bool> {
        peer::restore(&self.conn.lock().unwrap(), id)
    }

    /// Something came from them (`from`) or went to them: the dates Home shows.
    pub fn touch_peer(&self, id: i64, from: bool) -> Result<()> {
        peer::touch(&self.conn.lock().unwrap(), id, from, now())
    }

    /// Queue a document for a friend (`peer::queue`): the frame's id, one per
    /// document and friend, so a resend replaces at the relay.
    pub fn peer_queue(&self, p: &peer::Peer, doc_id: &str) -> Result<String> {
        peer::queue(&self.conn.lock().unwrap(), p, doc_id, now())
    }

    /// What has not gone yet: (frame id, friend, document, tries).
    pub fn peer_unsent(&self) -> Result<Vec<peer::Unsent>> {
        peer::unsent(&self.conn.lock().unwrap())
    }

    /// Queue a line for a friend (`peer::queue_note`): the frame's id.
    pub fn peer_queue_note(&self, p: &peer::Peer, text: &str) -> Result<String> {
        peer::queue_note(&self.conn.lock().unwrap(), p, text, now())
    }

    pub fn peer_sent(&self, id: &str) -> Result<()> {
        peer::sent(&self.conn.lock().unwrap(), id, now())
    }

    pub fn peer_failed(&self, id: &str, why: &str) -> Result<()> {
        peer::failed(&self.conn.lock().unwrap(), id, why)
    }

    pub fn peer_waiting(&self, id: &str, why: &str) -> Result<()> {
        peer::waiting(&self.conn.lock().unwrap(), id, why)
    }

    /// A friend's lines waiting on Home (`peer::notes_waiting`).
    pub fn peer_notes(&self) -> Result<Vec<peer::PeerNote>> {
        peer::notes_waiting(&self.conn.lock().unwrap())
    }

    pub fn peer_note_arrived(&self, peer_id: i64, text: &str) -> Result<i64> {
        peer::note_arrived(&self.conn.lock().unwrap(), peer_id, text, now())
    }

    /// `what`: taken, remove, restore (`peer::settle_note`).
    pub fn settle_peer_note(&self, id: i64, what: &str) -> Result<bool> {
        peer::settle_note(&self.conn.lock().unwrap(), id, what, now())
    }

    /// An agent's offers still open (`peer::offers_open`).
    pub fn peer_offers(&self) -> Result<Vec<peer::Offer>> {
        peer::offers_open(&self.conn.lock().unwrap())
    }

    pub fn peer_offer(&self, peer_id: i64, doc_id: &str, pane: &str, by: &str) -> Result<i64> {
        peer::offer(&self.conn.lock().unwrap(), peer_id, doc_id, pane, by, now())
    }

    pub fn peer_offer_get(&self, id: i64) -> Result<Option<peer::Offer>> {
        peer::offer_get(&self.conn.lock().unwrap(), id)
    }

    pub fn answer_peer_offer(&self, id: i64, sent: bool) -> Result<bool> {
        peer::answer_offer(&self.conn.lock().unwrap(), id, sent, now())
    }

    pub fn reopen_peer_offer(&self, id: i64) -> Result<bool> {
        peer::reopen_offer(&self.conn.lock().unwrap(), id)
    }

    pub fn drop_peer_offers_of(&self, pane: &str) -> Result<usize> {
        peer::drop_offers_of(&self.conn.lock().unwrap(), pane, now())
    }

    /// Whether a frame from the relay was already brought in (`peer::taken`):
    /// the link may be handed one twice when its ack was lost.
    pub fn peer_taken(&self, id: &str) -> Result<bool> {
        peer::taken(&self.conn.lock().unwrap(), id)
    }

    pub fn peer_take(&self, id: &str) -> Result<()> {
        peer::take(&self.conn.lock().unwrap(), id, now())
    }

    /// Forget what was taken more than eight days ago: the relay itself
    /// keeps nothing past seven, so nothing older can come again.
    pub fn prune_peer_taken(&self) -> Result<usize> {
        peer::prune_taken(&self.conn.lock().unwrap(), now() - peer::TAKEN_KEPT)
    }

    /// Where a pane's shell has moved to (`desk::set_cwd`).
    pub fn set_pane_cwd(&self, id: &str, cwd: &str) -> Result<bool> {
        desk::set_cwd(&self.conn.lock().unwrap(), id, cwd)
    }

    pub fn open_pane(&self, desk_id: i64, cwd: &str, cmd: &str) -> Result<Opened> {
        desk::open_pane(&mut self.conn.lock().unwrap(), desk_id, cwd, cmd, now())
    }

    /// Move a pane to another slot on its desk (`desk::move_pane`), and what
    /// each of the two panes sent with it: "From desk [2]" is the panel now in
    /// position 2, so a document's slot is rewritten in the same transaction.
    pub fn move_pane(&self, desk_id: i64, from: i64, to: i64) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        if !desk::move_pane(&tx, desk_id, from, to)? {
            return Ok(false);
        }
        tx.execute(
            "UPDATE docs SET desk_slot = CASE desk_slot WHEN ?2 THEN ?3 ELSE ?2 END
             WHERE desk_id = ?1 AND desk_slot IN (?2, ?3)",
            params![desk_id, from, to],
        )?;
        tx.commit()?;
        Ok(true)
    }

    /// Close a pane (`desk::close_pane`), and renumber what the panes after it
    /// sent in the same transaction, as `move_pane` does: "From desk [3]" is
    /// the panel now in position 3. What the closed one sent keeps its desk
    /// and loses its slot, since no panel on screen is that one any more.
    pub fn close_pane(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let Some((desk_id, slot)) = desk::close_pane(&tx, id, now())? else {
            return Ok(false);
        };
        tx.execute(
            "UPDATE docs SET desk_slot = CASE WHEN desk_slot = ?2 THEN 0 ELSE desk_slot - 1 END
             WHERE desk_id = ?1 AND desk_slot >= ?2",
            params![desk_id, slot],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn restore_pane(&self, id: &str) -> Result<desk::Restored> {
        desk::restore_pane(&mut self.conn.lock().unwrap(), id)
    }

    pub fn rename_pane(&self, id: &str, name: &str) -> Result<bool> {
        desk::rename_pane(&self.conn.lock().unwrap(), id, name)
    }

    /// Closed panes older than `before` (`desk::prune_closed`); what `prune`
    /// ends beside the documents.
    pub fn prune_panes(&self, before: i64, dry_run: bool) -> Result<Vec<(String, String)>> {
        desk::prune_closed(&self.conn.lock().unwrap(), before, dry_run)
    }

    pub fn panes_open(&self) -> Result<i64> {
        desk::panes_open(&self.conn.lock().unwrap())
    }

    /// A desk's own list. Thin, for the reason the desk calls above are: the
    /// SQL is `crate::desk`'s and the lock is this file's.
    pub fn desk_notes(&self, desk_id: i64) -> Result<Vec<desk::DeskNote>> {
        desk::notes(&self.conn.lock().unwrap(), desk_id)
    }

    /// A desk's keys by name: its own and the every-desk ones (`desk::keys`).
    pub fn desk_keys(&self, desk_id: i64) -> Result<Vec<desk::DeskKey>> {
        desk::keys(&self.conn.lock().unwrap(), desk_id)
    }

    pub fn add_desk_key(&self, desk_id: i64, name: &str, provider: &str) -> Result<()> {
        desk::add_key(&self.conn.lock().unwrap(), desk_id, name, provider, now())
    }

    pub fn remove_desk_key(&self, desk_id: i64, name: &str) -> Result<bool> {
        desk::remove_key(&self.conn.lock().unwrap(), desk_id, name)
    }

    pub fn touch_desk_keys(&self, keys: &[desk::DeskKey]) -> Result<()> {
        desk::touch_keys(&self.conn.lock().unwrap(), keys, now())
    }

    /// The keys of desks `prune_desks` is about to end, taken off unless
    /// `dry_run`; the caller forgets their values.
    pub fn prune_desk_keys(&self, before: i64, dry_run: bool) -> Result<Vec<(i64, String)>> {
        desk::prune_keys(&self.conn.lock().unwrap(), before, dry_run)
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

    pub fn tick_desk_note(&self, desk_id: i64, id: i64, tick: &desk::Tick) -> Result<bool> {
        desk::tick_note(&self.conn.lock().unwrap(), desk_id, id, tick, now())
    }

    /// The lines taken off a desk's list since `since`, for the panel's
    /// changes (`crate::brief::changes`).
    pub fn removed_desk_notes_since(&self, desk_id: i64, since: i64) -> Result<Vec<(i64, String)>> {
        desk::removed_since(&self.conn.lock().unwrap(), desk_id, since)
    }

    pub fn mark_desk_note(&self, desk_id: i64, id: i64, mark: &desk::Mark) -> Result<bool> {
        desk::mark_note(&self.conn.lock().unwrap(), desk_id, id, mark, now())
    }

    pub fn add_note_image(&self, desk_id: i64, id: i64, name: &str) -> Result<Option<Vec<String>>> {
        desk::add_note_image(&self.conn.lock().unwrap(), desk_id, id, name)
    }

    pub fn set_note_images(&self, desk_id: i64, id: i64, images: &[String]) -> Result<bool> {
        desk::set_note_images(&self.conn.lock().unwrap(), desk_id, id, images)
    }

    pub fn remove_desk_note(&self, desk_id: i64, id: i64) -> Result<bool> {
        desk::remove_note(&self.conn.lock().unwrap(), desk_id, id, now())
    }

    pub fn restore_desk_note(&self, desk_id: i64, id: i64) -> Result<bool> {
        desk::restore_note(&self.conn.lock().unwrap(), desk_id, id)
    }

    pub fn suggest_desk_note(&self, desk_id: i64, text: &str, by: &str) -> Result<desk::Suggested> {
        desk::suggest_note(&mut self.conn.lock().unwrap(), desk_id, text, by, now())
    }

    /// A friend's line as a suggestion on their desk (`desk::suggest_note_from`).
    pub fn suggest_desk_note_from(
        &self,
        desk_id: i64,
        text: &str,
        name: &str,
    ) -> Result<desk::Suggested> {
        desk::suggest_note_from(
            &mut self.conn.lock().unwrap(),
            desk_id,
            text,
            name,
            name,
            now(),
        )
    }

    /// A friend's line kept on a desk from Home (`desk::add_note_from`).
    pub fn add_desk_note_from(
        &self,
        desk_id: i64,
        text: &str,
        name: &str,
    ) -> Result<Option<desk::DeskNote>> {
        desk::add_note_from(&mut self.conn.lock().unwrap(), desk_id, text, name, now())
    }

    pub fn keep_desk_note(&self, desk_id: i64, id: i64) -> Result<bool> {
        desk::keep_note(&self.conn.lock().unwrap(), desk_id, id)
    }

    /// Threads, turns and suggested panels (`crate::thread`), with the clock:
    /// the SQL is that file's and the lock is this one's, as for the desk
    /// calls, through one door rather than a wrapper for each of twenty.
    pub fn threads<T>(&self, f: impl FnOnce(&mut Connection, i64) -> Result<T>) -> Result<T> {
        f(&mut self.conn.lock().unwrap(), now())
    }

    /// The reader opened a desk (`desk::visit`).
    pub fn visit_desk(&self, id: i64) -> Result<bool> {
        desk::visit(&self.conn.lock().unwrap(), id, now())
    }

    /// Park a desk with its next step, or take it down with `None`; what it
    /// was, for an Undo. `None` when there is no desk.
    pub fn park_desk(&self, id: i64, next: Option<&str>) -> Result<Option<Option<desk::Parked>>> {
        let to = next.map(|n| desk::Parked {
            at: now(),
            next: n.to_string(),
        });
        desk::park(&self.conn.lock().unwrap(), id, to.as_ref())
    }

    /// Lines ticked on any open desk since `since` (`desk::done_since`).
    pub fn desks_done_since(&self, since: i64) -> Result<Vec<desk::Done>> {
        desk::done_since(&self.conn.lock().unwrap(), since)
    }

    /// What panes sent since `since`, every send and oldest first, as
    /// `(desk, id, title, at)`: Home's log and the rhythm of each desk. Over
    /// `live_docs`, so a version counts as the day's work it was.
    pub fn desks_sent_since(&self, since: i64) -> Result<Vec<(i64, String, String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut st = conn.prepare(
            "SELECT desk_id, id, title, received_at FROM live_docs
             WHERE desk_id != 0 AND received_at >= ?1 ORDER BY received_at, rowid",
        )?;
        let rows = st.query_map(params![since], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Where the work on a desk was left (`desk::set_left_off`); `at` of 0 is
    /// now. The one it replaced, for an Undo; `None` when there is no desk.
    pub fn set_left_off(
        &self,
        desk_id: i64,
        to: &desk::LeftOff,
    ) -> Result<Option<Option<desk::LeftOff>>> {
        let mut to = to.clone();
        if to.at == 0 {
            to.at = now();
        }
        desk::set_left_off(&self.conn.lock().unwrap(), desk_id, &to)
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
                    (SELECT COUNT(*) FROM desks WHERE closed_at = 0) FROM live_docs",
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
        peer::clear(&conn)?;
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

/// A tree row, which is the six columns of a document the sidebar draws and
/// none of the rest. Shared by the two queries that return them.
fn row_to_tree_doc(r: &rusqlite::Row) -> rusqlite::Result<TreeDoc> {
    Ok(TreeDoc {
        id: r.get(0)?,
        title: r.get(1)?,
        kind: Kind::parse(&r.get::<_, String>(2)?).unwrap_or(Kind::Text),
        received_at: r.get(3)?,
        pinned: r.get::<_, i64>(4)? != 0,
        unread: r.get::<_, i64>(5)? != 0,
        size: r.get(6)?,
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
        sender: r.get(19)?,
    })
}

/// One thing a removal took that can still come back (`Store::removed`).
#[derive(Debug, Serialize)]
pub struct Removed {
    /// "doc", "note", "panel" or "aside".
    pub kind: &'static str,
    pub id: String,
    /// What the row says: a document's title, a note's text, a panel's name.
    pub title: String,
    /// Where it was: the project, or the desk.
    pub from: String,
    pub desk: Option<i64>,
    /// When it was removed (seconds).
    pub at: i64,
    /// How many versions of a document went with it; 1 for everything else.
    pub versions: usize,
    /// The POST that puts it back.
    pub restore: String,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A body copied into the docs dir under a temporary name, waiting for its id.
/// Renamed into place by `insert`/`replace`; dropped unused, it is removed.
#[derive(Debug)]
pub struct Staged {
    path: PathBuf,
    pub hash: String,
    pub len: u64,
}

impl Drop for Staged {
    fn drop(&mut self) {
        // Gone already when it was renamed into place.
        let _ = fs::remove_file(&self.path);
    }
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
mod tests;

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
