//! A desk's keys and the Claude accounts (`crate::desk`, `crate::accounts`):
//! names and labels here, values in `crate::secrets`, which is why a reset
//! hands back what it took. Beside the store rather than in it, as `talk` is.

use super::*;

impl Store {
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

    /// Claude accounts, by label (`crate::accounts`). Thin, like the keys.
    pub fn claude_accounts(&self) -> Result<Vec<accounts::Account>> {
        accounts::list(&self.conn.lock().unwrap())
    }

    pub fn claude_account(&self, id: i64) -> Result<Option<accounts::Account>> {
        accounts::get(&self.conn.lock().unwrap(), id)
    }

    pub fn claude_account_exists(&self, id: i64) -> Result<bool> {
        accounts::exists(&self.conn.lock().unwrap(), id)
    }

    pub fn add_claude_account(&self, label: &str) -> Result<accounts::Account> {
        accounts::add(&self.conn.lock().unwrap(), label, now())
    }

    pub fn rename_claude_account(&self, id: i64, label: &str) -> Result<bool> {
        accounts::rename(&self.conn.lock().unwrap(), id, label)
    }

    pub fn renewed_claude_account(&self, id: i64) -> Result<bool> {
        accounts::renewed(&self.conn.lock().unwrap(), id, now())
    }

    pub fn remove_claude_account(&self, id: i64) -> Result<bool> {
        accounts::remove(&mut self.conn.lock().unwrap(), id)
    }

    pub fn set_desk_account(&self, desk: i64, account: i64) -> Result<bool> {
        accounts::set_desk(&self.conn.lock().unwrap(), desk, account)
    }

    pub fn set_pane_account(&self, pane: &str, account: Option<i64>) -> Result<bool> {
        accounts::set_pane(&self.conn.lock().unwrap(), pane, account)
    }

    pub fn panes_following_desk(&self, desk: i64) -> Result<Vec<String>> {
        accounts::following(&self.conn.lock().unwrap(), desk)
    }

    pub fn touch_claude_account(&self, id: i64) -> Result<()> {
        accounts::touch(&self.conn.lock().unwrap(), id, now())
    }

    /// The keys of desks `prune_desks` is about to end, taken off unless
    /// `dry_run`; the caller forgets their values.
    pub fn prune_desk_keys(&self, before: i64, dry_run: bool) -> Result<Vec<(i64, String)>> {
        desk::prune_keys(&self.conn.lock().unwrap(), before, dry_run)
    }
}

/// What a reset took whose values live outside the database: the keys,
/// (desk, name), and the Claude accounts' ids.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Held {
    pub keys: Vec<(i64, String)>,
    pub accounts: Vec<i64>,
}

impl Held {
    /// What the database holds of them now.
    pub(super) fn of(conn: &Connection) -> Result<Held> {
        let keys = conn
            .prepare("SELECT desk_id, name FROM desk_keys")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let accounts = accounts::list(conn)?.into_iter().map(|a| a.id).collect();
        Ok(Held { keys, accounts })
    }

    /// Each value, gone from wherever it was kept. Blocking, as every
    /// `Secrets` call is.
    pub fn forget(&self, secrets: &crate::secrets::Secrets) {
        for (desk, name) in &self.keys {
            secrets.forget(*desk, name);
        }
        for id in &self.accounts {
            secrets.forget_claude(*id);
        }
    }
}
