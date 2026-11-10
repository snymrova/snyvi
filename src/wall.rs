//! The way to the wall (1.59, plan 48ca2d5b9e step 4; docs/WALL.md).
//!
//! The wall is a service snyvi runs (`wall/`, beside `relay/`): every Home's
//! "What people are building", and `snyvi.page/<slug>`. This daemon speaks
//! to it only on the reader's press, and only through the outbox here:
//!
//! - **Signed.** Every write carries `x-snyvi-from` (this daemon's address)
//!   and `x-snyvi-auth`, a signature over the method, the path, the time and
//!   the blake3 of the body (`auth_message`), the relay's scheme with the
//!   body in it. A slug belongs to the key that first published it (D4).
//! - **Held, not lost.** The press queues rows (`queue_publish`): the files
//!   first, then the page, its moments, and the check. A row not sent yet
//!   shows in the Page view as *not up yet* and goes out on the next tick.
//! - **What the wall holds is what the builder signed** (`public_page`):
//!   no desk id, no folder, no provenance, no draft.
//! - **What comes back** is one line a day from the wall's own key
//!   (`WALL_KEY`), sealed to this daemon like a friend's frame and deposited
//!   at the relay. It is the one frame from a key that is not a friend's
//!   that is opened, and only its `Content::Wall` is kept
//!   (`server::api_wall::take`). It is shown on the page and on Home, never
//!   handed to a pane.

use crate::page::{Moment, Page};
use crate::peer::{Peer, CONTENT_V};
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// Where the wall is. `SNYVI_WALL` overrides it, as `SNYVI_RELAY` does the
/// relay's: for `wrangler dev` beside a test window, and self-hosters.
pub const WALL_URL: &str = "https://wall.snyvi.com";

pub fn base() -> String {
    std::env::var("SNYVI_WALL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| WALL_URL.to_string())
}

/// The wall's own keys' public halves, as the relay spells a key: minted
/// once by `wall/scripts/mint.mjs` (2026-11-09), whose secret half is the
/// Worker's `WALL_SEED` and nowhere else. A new mint means a release with
/// the new pair before the daily line opens again. `SNYVI_WALL_KEY` and
/// `SNYVI_WALL_BOX` override them, for a wall in a test.
pub const WALL_KEY: &str = "qDxoxRIm84H9m26B8tm3yOyXWgJj7J5Afq8OCXqSf7w";
pub const WALL_BOX: &str = "_lwgrTlTgy0XdlWcvB4ZlGmnInXXsyHov8gw13jUbBk";

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub fn wall_key() -> String {
    env_or("SNYVI_WALL_KEY", WALL_KEY)
}

/// Whether a frame's sender is the wall.
pub fn is_wall(sender: &str) -> bool {
    let k = wall_key();
    !k.is_empty() && sender == k
}

/// The wall as a peer `peer::open` can check a frame against: its pinned
/// keys, never a row in `peers`, so it is no one's friend and is never sent
/// anything through the relay.
pub fn wall_peer() -> Peer {
    Peer {
        id: 0,
        sign_key: wall_key(),
        box_key: env_or("SNYVI_WALL_BOX", WALL_BOX),
        name: "the wall".into(),
        v: CONTENT_V,
        ..Default::default()
    }
}

/// What a write's signature covers: the relay's scheme, and the body's
/// blake3, so the wall can tell a body swapped on the way.
pub fn auth_message(method: &str, path: &str, secs: i64, body: &[u8]) -> String {
    format!(
        "snyvi-wall-v1\n{method}\n{path}\n{secs}\n{}",
        blake3::hash(body).to_hex()
    )
}

/// The page as the wall keeps it: what the builder chose to show, signed.
/// `repo` is the page's GitHub link, which the wall reads `.snyvi/owner`
/// from before the page is on Everyone's wall.
pub fn public_page(p: &Page) -> Value {
    json!({
        "slug": p.slug,
        "title": p.title,
        "lede": p.lede,
        "kind": p.kind,
        "tone": p.tone,
        "stage": p.stage,
        "looking_for": p.looking_for,
        "logo": p.logo,
        "cover": p.cover,
        "hero": p.hero,
        "facts": p.facts,
        "github": p.github,
        "links": p.links,
        "accent": p.accent,
        "wash": p.wash,
        "count_shown": p.count_shown,
        // 1.62's template A: a wall from before ignores them.
        "cta": p.cta,
        "points": p.points,
        "story": p.story,
        "v": 1,
    })
}

/// A moment as the wall keeps it. `at` is when it goes up: the press.
pub fn public_moment(m: &Moment, at: i64) -> Value {
    json!({
        "id": m.id,
        "title": m.title,
        "body_md": m.body_md,
        "files": m.files,
        "at": if m.published_at > 0 { m.published_at } else { at },
    })
}

/// One row of the outbox.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: i64,
    pub page_id: i64,
    /// `file:<name>`, `page`, `moment:<id>`, `check`, `down`.
    pub what: String,
    pub body: String,
    pub tries: i64,
    pub error: String,
}

pub fn queue(conn: &Connection, page_id: i64, what: &str, body: &str, now: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO page_outbox(page_id, what, body, queued_at) VALUES(?1, ?2, ?3, ?4)",
        params![page_id, what, body, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The press for Everyone: every file the page shows, the page, each moment
/// shown and not up yet, then the check. What an earlier press left held is
/// replaced, so the newest press is what goes.
pub fn queue_publish(conn: &Connection, p: &Page, moments: &[Moment], now: i64) -> Result<()> {
    conn.execute(
        "UPDATE page_outbox SET sent_at = -1, error = 'replaced by a newer press' \
         WHERE page_id = ?1 AND sent_at = 0",
        [p.id],
    )?;
    let mut files: Vec<&str> = vec![p.logo.as_str(), p.cover.as_str()];
    let shown: Vec<&Moment> = moments.iter().filter(|m| m.hidden_at == 0).collect();
    for m in &shown {
        files.extend(m.files.iter().map(String::as_str));
    }
    files.retain(|f| !f.is_empty());
    files.sort_unstable();
    files.dedup();
    for f in files {
        queue(conn, p.id, &format!("file:{f}"), "", now)?;
    }
    queue(conn, p.id, "page", &public_page(p).to_string(), now)?;
    for m in shown.iter().filter(|m| m.published_at == 0) {
        let body = public_moment(m, now).to_string();
        queue(conn, p.id, &format!("moment:{}", m.id), &body, now)?;
    }
    queue(
        conn,
        p.id,
        "check",
        &json!({ "repo": p.github }).to_string(),
        now,
    )?;
    Ok(())
}

/// What waits to go, oldest first: one page's, or every page's.
pub fn held(conn: &Connection, page_id: Option<i64>) -> Result<Vec<Row>> {
    let mut st = conn.prepare(
        "SELECT id, page_id, what, body, tries, error FROM page_outbox \
         WHERE sent_at = 0 AND (?1 IS NULL OR page_id = ?1) ORDER BY id",
    )?;
    let rows = st.query_map([page_id], |r| {
        Ok(Row {
            id: r.get(0)?,
            page_id: r.get(1)?,
            what: r.get(2)?,
            body: r.get(3)?,
            tries: r.get(4)?,
            error: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn sent(conn: &Connection, id: i64, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE page_outbox SET sent_at = ?2, error = '' WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

pub fn failed(conn: &Connection, id: i64, why: &str) -> Result<()> {
    conn.execute(
        "UPDATE page_outbox SET tries = tries + 1, error = ?2 WHERE id = ?1",
        params![id, why],
    )?;
    Ok(())
}

/// A row the wall refused for good (a name taken, a file over its cap): it
/// stops, with why, and what came after it for that page stops with it.
pub fn refused(conn: &Connection, page_id: i64, why: &str) -> Result<()> {
    conn.execute(
        "UPDATE page_outbox SET sent_at = -1, error = ?2 WHERE page_id = ?1 AND sent_at = 0",
        params![page_id, why],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
