//! Claude accounts: more than the one `/login` signed in, each a long-lived
//! token from `claude setup-token`, picked per desk or per panel.
//!
//! An account here is a label and a token. The label is a row
//! (`claude_accounts`); the token is in the keychain or snyvi's 0600 file
//! under `claude/<id>` (`crate::secrets`), the way a desk key's value is, and
//! goes one way: into a panel's environment as `CLAUDE_CODE_OAUTH_TOKEN` when
//! it starts. Nothing else moves -- `~/.claude` is the same for every panel,
//! so hooks, the snyvi MCP, memory, transcripts and `--resume` see one
//! machine whichever account a panel runs as. Account 0 is the `/login` one:
//! snyvi sets nothing for it, and a reader with one account sees no change.
//!
//! A desk has an account (0 by default) and a panel may have its own, which
//! wins; a panel's `NULL` follows its desk (`effective`). Taking an account
//! away puts what used it back on 0 in the same transaction, so no row ever
//! names one that is gone.
//!
//! The token outranks the `/login` credentials and is outranked by
//! `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and an `apiKeyHelper`
//! (Claude Code's authentication precedence), which is why the keys sheet
//! warns when a desk has one of those as a key.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS claude_accounts (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL DEFAULT 0
);
"#;

/// 1.30: the account a desk's panels start as (0 for `/login`), a panel's
/// own (`NULL` follows its desk), and a closed panel's, so a restored one
/// comes back as it was. Version 14 of `store::MIGRATIONS`.
pub const COLUMNS_1_30: [&str; 3] = [
    "ALTER TABLE desks ADD COLUMN account INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE panes ADD COLUMN account INTEGER",
    "ALTER TABLE panes_closed ADD COLUMN account INTEGER",
];

/// The `/login` account: no token, nothing set.
pub const DEFAULT: i64 = 0;

/// How long a label is, at most: a radio row's worth.
pub const LABEL_CHARS: usize = 40;

/// The environment variable a panel's token goes in.
pub const TOKEN_VAR: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// What Claude Code takes over a token, in its order: a desk key of one of
/// these names means the account picked is not the one that runs.
pub const OUTRANKS: [&str; 2] = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

/// How long a `setup-token` token lasts: a year, by Claude Code's docs. The
/// sheet says when to renew from `created_at`.
pub const TOKEN_LIFE_SECS: i64 = 365 * 24 * 3600;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Account {
    pub id: i64,
    pub label: String,
    pub created_at: i64,
    /// When a panel last started as it; 0 for never.
    pub used_at: i64,
}

/// The account a panel runs as: its own if it has one, its desk's if not.
pub fn effective(desk: i64, pane: Option<i64>) -> i64 {
    pane.unwrap_or(desk)
}

/// A label as kept: trimmed, one line, at most `LABEL_CHARS`; `None` when
/// nothing is left.
pub fn clean_label(label: &str) -> Option<String> {
    let one: String = label
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(LABEL_CHARS)
        .collect();
    let one = one.trim().to_string();
    (!one.is_empty()).then_some(one)
}

/// Whether a pasted value is a `setup-token` token, and if not, what to say.
/// An API key is the likely mistake, and it has a home already: a desk key.
pub fn valid_token(token: &str) -> std::result::Result<(), &'static str> {
    if token.starts_with("sk-ant-api") {
        return Err("that is an API key: add it in Keys as ANTHROPIC_API_KEY instead");
    }
    if !token.starts_with("sk-ant-oat") {
        return Err("a token from claude setup-token starts with sk-ant-oat");
    }
    let shape = token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !shape || !(60..=300).contains(&token.len()) {
        return Err("that does not look like a whole token: copy it again from claude setup-token");
    }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt =
        conn.prepare("SELECT id, label, created_at, used_at FROM claude_accounts ORDER BY id")?;
    let rows = stmt
        .query_map([], row_to_account)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Account>> {
    Ok(conn
        .query_row(
            "SELECT id, label, created_at, used_at FROM claude_accounts WHERE id = ?1",
            params![id],
            row_to_account,
        )
        .optional()?)
}

fn row_to_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        label: r.get(1)?,
        created_at: r.get(2)?,
        used_at: r.get(3)?,
    })
}

/// Whether `id` is one a desk or a panel can be set to: 0, or a row.
pub fn exists(conn: &Connection, id: i64) -> Result<bool> {
    Ok(id == DEFAULT || get(conn, id)?.is_some())
}

/// A new account's row, by an already clean label. The token is the caller's
/// to keep (`Secrets::keep_claude`), after this, under the id it returns.
pub fn add(conn: &Connection, label: &str, now: i64) -> Result<Account> {
    conn.execute(
        "INSERT INTO claude_accounts(label, created_at) VALUES (?1, ?2)",
        params![label, now],
    )?;
    Ok(Account {
        id: conn.last_insert_rowid(),
        label: label.to_string(),
        created_at: now,
        used_at: 0,
    })
}

pub fn rename(conn: &Connection, id: i64, label: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE claude_accounts SET label = ?2 WHERE id = ?1",
        params![id, label],
    )? > 0)
}

/// A token taken again for an account that has one: `created_at` moves, so
/// the renewal date does.
pub fn renewed(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE claude_accounts SET created_at = ?2 WHERE id = ?1",
        params![id, now],
    )? > 0)
}

/// Take an account away, and every desk and panel on it back to `/login`, in
/// one transaction; whether there was one. The token is the caller's to
/// forget.
pub fn remove(conn: &mut Connection, id: i64) -> Result<bool> {
    if id == DEFAULT {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    let gone = tx.execute("DELETE FROM claude_accounts WHERE id = ?1", params![id])? > 0;
    if gone {
        tx.execute(
            "UPDATE desks SET account = 0 WHERE account = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE panes SET account = NULL WHERE account = ?1",
            params![id],
        )?;
        tx.execute(
            "UPDATE panes_closed SET account = NULL WHERE account = ?1",
            params![id],
        )?;
    }
    tx.commit()?;
    Ok(gone)
}

/// The account a desk's panels start as; false when there is no such desk.
/// The caller checks `exists` first.
pub fn set_desk(conn: &Connection, desk: i64, account: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET account = ?2 WHERE id = ?1 AND closed_at = 0",
        params![desk, account],
    )? > 0)
}

/// A panel's own account, or `None` to follow its desk; false when there is
/// no such panel.
pub fn set_pane(conn: &Connection, pane: &str, account: Option<i64>) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE panes SET account = ?2 WHERE id = ?1",
        params![pane, account],
    )? > 0)
}

/// The running panels on a desk that follow it, for "Switch the N running
/// panels too?" after the desk's account changes.
pub fn following(conn: &Connection, desk: i64) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM panes WHERE desk_id = ?1 AND account IS NULL ORDER BY slot")?;
    let rows = stmt
        .query_map(params![desk], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A panel started as this account: say when.
pub fn touch(conn: &Connection, id: i64, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE claude_accounts SET used_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub mod signin;

#[cfg(test)]
mod tests;
