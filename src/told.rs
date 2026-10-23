//! Told (1.48): a thread's end moves one step out. Shipped is merged on
//! main; told is the world hearing of it -- a release note, a post, a
//! friend -- with where, as a URL. Without it the loop ended at the merge
//! and the work sat unknown (usage audit 63cc69c8c1, P2).
//!
//! Told is not a stage of its own: a told thread is a shipped one with
//! `told_at`, so everything that reads `shipped` as done -- the rail, Home,
//! the brief, the cap -- reads a told thread as done too. `move_thread`
//! takes `told` as a move, with its URL.
//!
//! Once per thread, when it reaches shipped by a merge, snyvi raises one
//! card on the reader's On you: "Shipped: <name>. Who should know?" Its
//! answers write a dated line on the thread (`crate::due`), never a post:
//! snyvi and Claude draft, the reader tells.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use time::{Duration, OffsetDateTime, PrimitiveDateTime, Time, Weekday};

/// 1.48's columns on a thread: when it was told, where, how (`release`,
/// `post`, `friend`, `none`), and when its card rose. The threads shipped
/// before 1.48 are stamped as asked, so the old ones stay quiet. Version 29
/// of `store::MIGRATIONS`, never in `thread::SCHEMA`.
pub const COLUMNS_1_48: &str = "ALTER TABLE threads ADD COLUMN told_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN told_url TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN told_how TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN ask_told_at INTEGER NOT NULL DEFAULT 0;
UPDATE threads SET ask_told_at = 1 WHERE stage = 'shipped' OR merged_at != 0;";

/// The card's kind. snyvi's own, as `due` is, so not in `thread::KINDS`:
/// no agent asks with it.
pub const KIND: &str = "tell";

pub const RELEASE: &str = "Release note";
pub const POST: &str = "A post";
pub const NO_ONE: &str = "No one";
/// "Tell Trapti": the friend's name follows.
const TELL: &str = "Tell ";

/// The longest URL a thread keeps.
const URL_CHARS: usize = 500;

/// The card's rows: a release note, a post, the first friend paired, no one.
pub fn options(conn: &Connection) -> Result<Vec<String>> {
    let mut o = vec![RELEASE.to_string(), POST.to_string()];
    if let Some(f) = friend(conn)? {
        o.push(format!("{TELL}{f}"));
    }
    o.push(NO_ONE.to_string());
    Ok(o)
}

/// The friend a "Tell" row names: the first paired and not removed.
fn friend(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT name FROM peers WHERE removed_at = 0 ORDER BY paired_at, id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// Whether a line reads as a fix: its first word is one.
fn a_fix(text: &str) -> bool {
    let w = text
        .split_whitespace()
        .find(|w| !w.starts_with('#'))
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    matches!(
        w.as_str(),
        "fix" | "fixes" | "fixed" | "bug" | "typo" | "hotfix" | "revert"
    )
}

/// The row the card recommends: no one when every line of the thread reads
/// as a fix (or, with no lines, its name does), a release note otherwise.
/// A guess the reader can always overrule: it only picks the ★.
pub fn told_default(name: &str, notes: &[String]) -> &'static str {
    let fixes = if notes.is_empty() {
        a_fix(name)
    } else {
        notes.iter().all(|n| a_fix(n))
    };
    if fixes {
        NO_ONE
    } else {
        RELEASE
    }
}

/// The clock, on the restart watcher's tick: every thread that reached
/// shipped by a merge and has had no card raises one, once, by snyvi, on
/// no panel. The desks that changed.
pub fn ask(conn: &Connection, now: i64) -> Result<Vec<i64>> {
    let due: Vec<(i64, i64, String)> = conn
        .prepare(
            "SELECT t.id, t.desk_id, t.name FROM threads t JOIN desks d ON d.id = t.desk_id
             WHERE t.stage = 'shipped' AND t.merged_at != 0 AND t.ask_told_at = 0 AND t.told_at = 0
               AND t.removed_at = 0 AND d.closed_at = 0
             ORDER BY t.merged_at, t.id LIMIT 12",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if due.is_empty() {
        return Ok(Vec::new());
    }
    let options = options(conn)?;
    let mut desks = Vec::new();
    for (id, desk, name) in due {
        let notes: Vec<String> = conn
            .prepare_cached(
                "SELECT text FROM desk_notes WHERE thread_id = ?1 AND removed_at = 0 ORDER BY id",
            )?
            .query_map(params![id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let pick = told_default(&name, &notes);
        let rec = options.iter().position(|o| o == pick).map_or(-1, |i| i as i64);
        conn.execute(
            "INSERT INTO turns(desk_id, thread_id, by, kind, via, text, options, recommended, created_at)
             VALUES(?1, ?2, 'snyvi', ?3, 'merge', ?4, ?5, ?6, ?7)",
            params![
                desk,
                id,
                KIND,
                format!("Shipped: {name}. Who should know?"),
                options.join("\n"),
                rec,
                now
            ],
        )?;
        conn.execute(
            "UPDATE threads SET ask_told_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        desks.push(desk);
    }
    desks.sort_unstable();
    desks.dedup();
    Ok(desks)
}

/// The next weekday at `hour`, in the reader's time: a post goes out on a
/// working day.
fn next_weekday(now: i64, hour: u8) -> i64 {
    let off = crate::due::offset();
    let Ok(t) = OffsetDateTime::from_unix_timestamp(now) else {
        return now + 86_400;
    };
    let mut d = t.to_offset(off).date();
    loop {
        d += Duration::days(1);
        if !matches!(d.weekday(), Weekday::Saturday | Weekday::Sunday) {
            break;
        }
    }
    let at = Time::from_hms(hour, 0, 0).unwrap_or(Time::MIDNIGHT);
    PrimitiveDateTime::new(d, at).assume_offset(off).unix_timestamp()
}

/// What a row of the card puts on the desk: the line and when it is due.
/// `None` for No one, which writes nothing.
pub fn line_for(answer: &str, name: &str, now: i64) -> Option<(String, i64)> {
    let tomorrow_9 = crate::due::parse("tomorrow 9", now).unwrap_or(now + 86_400);
    match answer {
        RELEASE => Some((format!("write the release note for {name}"), tomorrow_9)),
        POST => Some((
            format!("post {name} (X · HN · the blog)"),
            next_weekday(now, 10),
        )),
        a if a.starts_with(TELL) => Some((
            format!("tell {} {name} is out", &a[TELL.len()..]),
            crate::due::parse("tomorrow 10", now).unwrap_or(now + 86_400),
        )),
        _ => None,
    }
}

/// The reader answers a tell card. A release note, a post or a friend
/// becomes a dated line in the thread; No one marks it told, with nothing
/// to say where. `None` when it is no tell card or was answered; the line
/// written, when one was.
pub fn answer(
    conn: &Connection,
    desk_id: i64,
    turn: &crate::thread::Turn,
    answer: &str,
    now: i64,
) -> Result<Option<(crate::thread::Turn, i64)>> {
    if turn.kind != KIND || turn.answered_at != 0 || turn.removed_at != 0 {
        return Ok(None);
    }
    let name: String = conn
        .query_row(
            "SELECT name FROM threads WHERE desk_id = ?1 AND id = ?2",
            params![desk_id, turn.thread_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let mut note = 0;
    match line_for(answer, &name, now) {
        Some((text, due_at)) => {
            let held: i64 = conn.query_row(
                "SELECT COUNT(*) FROM desk_notes WHERE desk_id = ?1 AND removed_at = 0",
                params![desk_id],
                |r| r.get(0),
            )?;
            if held < crate::desk::NOTES_PER_DESK {
                conn.execute(
                    "INSERT INTO desk_notes(desk_id, text, created_at, due_at, thread_id)
                     VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![desk_id, text, now, due_at, turn.thread_id],
                )?;
                note = conn.last_insert_rowid();
            }
        }
        None if answer == NO_ONE => {}
        None => return Ok(None),
    }
    let said = crate::thread::answer(conn, desk_id, turn.id, answer, "snyvi", now)?;
    // Told to no one is told: after the answer, which `mark` would put away.
    if said.is_some() && answer == NO_ONE {
        mark(conn, desk_id, turn.thread_id, "", "none", now)?;
    }
    Ok(said.map(|t| (t, note)))
}

/// A URL a thread was told at: http or https, one line, kept short.
pub fn url_ok(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() {
        return Some(String::new());
    }
    let ok = (u.starts_with("https://") || u.starts_with("http://"))
        && u.len() <= URL_CHARS
        && !u.chars().any(char::is_whitespace);
    ok.then(|| u.to_string())
}

/// Mark a thread told: where (a URL, or empty) and how. A thread told
/// before it shipped is shipped by it, and a tell card still up for it is
/// put away, answered by the move.
pub fn mark(
    conn: &Connection,
    desk_id: i64,
    thread_id: i64,
    url: &str,
    how: &str,
    now: i64,
) -> Result<bool> {
    let how = match how {
        "release" | "post" | "friend" | "none" => how,
        _ if url.contains("/releases") => "release",
        _ => "post",
    };
    let n = conn.execute(
        "UPDATE threads SET told_at = ?3, told_url = ?4, told_how = ?5,
           ask_told_at = CASE WHEN ask_told_at = 0 THEN ?3 ELSE ask_told_at END,
           shipped_at = CASE WHEN stage = 'shipped' AND shipped_at != 0 THEN shipped_at ELSE ?3 END,
           stage = 'shipped', moved_at = ?3
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, thread_id, now, url, how],
    )?;
    if n > 0 {
        conn.execute(
            "UPDATE turns SET removed_at = ?3 WHERE desk_id = ?1 AND thread_id = ?2 AND kind = 'tell'
             AND answered_at = 0 AND removed_at = 0",
            params![desk_id, thread_id, now],
        )?;
    }
    Ok(n > 0)
}

/// The threads shipped by a merge and not told, for the brief: since 1.48
/// only (the older ones were stamped), within two weeks, the oldest first.
pub fn untold(conn: &Connection, desk_id: i64, now: i64) -> Result<Vec<(String, i64)>> {
    Ok(conn
        .prepare_cached(
            "SELECT name, shipped_at FROM threads WHERE desk_id = ?1 AND removed_at = 0
               AND stage = 'shipped' AND merged_at != 0 AND told_at = 0 AND ask_told_at > 1
               AND shipped_at >= ?2
             ORDER BY shipped_at, id LIMIT 4",
        )?
        .query_map(params![desk_id, now - 14 * 86_400], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
