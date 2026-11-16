//! Pipelines, 1.40 to 1.66: only their tables are left (plan f586a9fe09,
//! stage 5).
//!
//! A pipeline was a panel that worked through a list of steps, one step
//! looped, or a goal a planner wrote, each stage a fresh Claude started by
//! the daemon. The window stopped offering it in 1.43, and 1.67 took the
//! code out: its one good idea, "work the list until it is done", is the
//! line (`crate::desk::line`), where the reader presses Start next and no
//! daemon starts an agent on its own.
//!
//! Nothing is deleted, so the rows a reader made stay in the database, and
//! a new database still gets the two tables: one schema for every install,
//! and a 1.66 binary run again finds what it left. Nothing reads them.

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pipelines (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  pane TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  autopilot INTEGER NOT NULL DEFAULT 0,
  planner_model TEXT NOT NULL DEFAULT 'sonnet',
  ctx_limit INTEGER NOT NULL DEFAULT 70,
  caps TEXT NOT NULL DEFAULT '{}',
  branch TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft',
  why TEXT NOT NULL DEFAULT '',
  resume_at INTEGER NOT NULL DEFAULT 0,
  report TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pipelines_desk ON pipelines(desk_id, hidden_at, created_at);
CREATE INDEX IF NOT EXISTS pipelines_state ON pipelines(state);
CREATE TABLE IF NOT EXISTS pipeline_steps (
  id INTEGER PRIMARY KEY,
  pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'prompt',
  text TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  session TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL DEFAULT '',
  last_reply TEXT NOT NULL DEFAULT '',
  stopped_at INTEGER NOT NULL DEFAULT 0,
  handoff INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',
  ctx_peak INTEGER NOT NULL DEFAULT 0,
  commits TEXT NOT NULL DEFAULT '',
  diff_lines INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pipeline_steps_of ON pipeline_steps(pipeline_id, n);
"#;
