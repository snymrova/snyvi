//! Decisions (1.65, plan 2d186a80c1): every question an agent put to the
//! reader on a desk, read as one list -- the desk's shelf in the rail, and
//! the `decisions` section of an agent's `read_desk`.
//!
//! No table of its own: a decision is a `decide` turn (`crate::thread`). What
//! was missing was a place that lists them past the half hour they are fresh
//! and the day they wait. A question nobody answered was put away by age
//! (`thread::retire`) and from then on was in no list at all: it lived on in
//! the document it was asked under and in the asking agent's own memory, and
//! the next agent, which has neither, asked it again. An answer given by
//! talking was kept as the words "in the conversation".
//!
//! Four states, worked out at each read and never stored:
//!
//! - `open`: not answered. On On you while it is fresh, here always --
//!   `aged` says it was put away by age and is on no other list.
//! - `later`: the reader's Tomorrow or Next week, until then.
//! - `answered`: what was said, when, and where (`snyvi` or `panel`).
//! - `dropped`: the reader's Not this, with their word.
//!
//! Left out: a question the reader's ✕ removed, one an agent put away with
//! its reason, one a newer asking replaced, and Claude's own dialog that
//! closed unanswered. Those were taken back, not decided.
//!
//! The shelf never rings, rises or counts: it is the pile, on request. Its
//! three presses are here because the turn's own (`thread::answer`,
//! `later_turn`, `not_turn`) refuse a turn that was put away, and a question
//! put away by age is exactly what the shelf is for.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

/// How many turns one read looks at, newest first. A desk asks a few
/// questions a day; this is months of them.
const READ: usize = 400;
/// How many of each state a list carries: what is open is never cut short
/// of this, and the answered are the newest.
pub const OPEN_SHOWN: usize = 60;
pub const ANSWERED_SHOWN: usize = 40;
pub const DROPPED_SHOWN: usize = 20;

/// One question and where it stands.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Decision {
    pub id: i64,
    /// `open`, `later`, `answered` or `dropped`.
    pub state: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    /// The option the agent recommended, by index, or -1.
    pub recommended: i64,
    /// The answer, or the word of a Not this.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub answer: String,
    /// `snyvi`, or `panel` for one given by talking: as the agent heard it.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub answered_in: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub answered_at: i64,
    pub asked_at: i64,
    /// A `later` one: when it comes back.
    #[serde(skip_serializing_if = "is_zero")]
    pub until: i64,
    /// The document it was asked under, when it is one in the library.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc_title: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub thread_id: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thread: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    /// An open one that was put away by age: on the shelf and nowhere else.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub aged: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// How many of each, and how old the oldest open one is: the rail's line
/// and the head of what an agent reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Counts {
    pub open: usize,
    pub later: usize,
    pub answered: usize,
    pub dropped: usize,
    /// When the oldest open one was asked, or 0.
    pub oldest_open_at: i64,
}

/// A desk's decisions: open ones oldest first (the oldest has waited
/// longest), then later, then answered and dropped, each newest first.
pub fn for_desk(conn: &Connection, desk_id: i64, now: i64) -> Result<Vec<Decision>> {
    let mut st = conn.prepare(
        "SELECT t.id, t.text, t.options, t.recommended, t.link, t.answer, t.answered_in, t.answered_at,
                t.created_at, t.removed_by, t.until, t.thread_id, t.by,
                COALESCE((SELECT h.name FROM threads h WHERE h.id = t.thread_id), '')
         FROM turns t
         WHERE t.desk_id = ?1 AND t.kind = 'decide'
           AND (t.removed_at = 0 OR t.removed_by IN ('aged', 'not'))
         ORDER BY t.id DESC LIMIT ?2",
    )?;
    let rows: Vec<(Decision, String, String)> = st
        .query_map(params![desk_id, READ as i64], |r| {
            let options: String = r.get(2)?;
            Ok((
                Decision {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    options: if options.is_empty() {
                        Vec::new()
                    } else {
                        options.split('\n').map(String::from).collect()
                    },
                    recommended: r.get(3)?,
                    answer: r.get(5)?,
                    answered_in: r.get(6)?,
                    answered_at: r.get(7)?,
                    asked_at: r.get(8)?,
                    until: r.get(10)?,
                    thread_id: r.get(11)?,
                    by: r.get(12)?,
                    thread: r.get(13)?,
                    ..Decision::default()
                },
                r.get::<_, String>(4)?,
                r.get::<_, String>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut all = Vec::with_capacity(rows.len());
    for (mut d, link, removed_by) in rows {
        d.state = if removed_by == "not" {
            "dropped"
        } else if d.answered_at != 0 {
            "answered"
        } else if d.until > now {
            "later"
        } else {
            "open"
        };
        d.aged = d.state == "open" && removed_by == "aged";
        if d.state != "later" {
            d.until = 0;
        }
        (d.doc, d.doc_title) = crate::onyou::doc_titled(conn, &link);
        all.push(d);
    }
    Ok(ordered(all))
}

/// Open oldest first, then later by when it comes back, then answered and
/// dropped newest first; each cut to what a list carries.
fn ordered(all: Vec<Decision>) -> Vec<Decision> {
    let of = |s: &str| -> Vec<Decision> { all.iter().filter(|d| d.state == s).cloned().collect() };
    let mut open = of("open");
    open.sort_by_key(|d| (d.asked_at, d.id));
    open.truncate(OPEN_SHOWN);
    let mut later = of("later");
    later.sort_by_key(|d| (d.until, d.id));
    later.truncate(OPEN_SHOWN);
    let mut answered = of("answered");
    answered.sort_by_key(|d| (-d.answered_at, -d.id));
    answered.truncate(ANSWERED_SHOWN);
    // A Not this keeps no time of its own in what is read here: newest asked.
    let mut dropped = of("dropped");
    dropped.sort_by_key(|d| -d.id);
    dropped.truncate(DROPPED_SHOWN);
    open.into_iter()
        .chain(later)
        .chain(answered)
        .chain(dropped)
        .collect()
}

/// The ones that say every word of `query`, in the question, its options,
/// its answer, its document's title or its thread's name; all of them for
/// an empty query. Case is not looked at.
pub fn matching(all: Vec<Decision>, query: &str) -> Vec<Decision> {
    let words: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
    if words.is_empty() {
        return all;
    }
    all.into_iter()
        .filter(|d| {
            let hay = format!(
                "{} {} {} {} {}",
                d.text,
                d.options.join(" "),
                d.answer,
                d.doc_title,
                d.thread
            )
            .to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()))
        })
        .collect()
}

pub fn counts(all: &[Decision]) -> Counts {
    let n = |s: &str| all.iter().filter(|d| d.state == s).count();
    Counts {
        open: n("open"),
        later: n("later"),
        answered: n("answered"),
        dropped: n("dropped"),
        oldest_open_at: all
            .iter()
            .filter(|d| d.state == "open")
            .map(|d| d.asked_at)
            .min()
            .unwrap_or(0),
    }
}

/// What the shelf's presses may touch: a question on view, or one put away
/// by age. Never one the reader, an agent or a newer asking took back.
const ON_SHELF: &str = "kind = 'decide' AND (removed_at = 0 OR removed_by = 'aged')";

/// Answer on the shelf, or change an answer there. The question is back
/// among the living as it is answered, so the panel that asked is told at
/// its next prompt (`thread::take_untold`) -- or, its panel gone, whichever
/// panel on the desk asks next. An answer the agent heard in the panel and
/// the reader corrects here is told the same way, which is the point of
/// correcting it. Whether there was such a question.
pub fn answer(conn: &Connection, desk_id: i64, id: i64, answer: &str, now: i64) -> Result<bool> {
    let answer = crate::thread::line(answer, 300);
    if answer.is_empty() {
        return Ok(false);
    }
    Ok(conn.execute(
        &format!(
            "UPDATE turns SET answer = ?3, answered_in = 'snyvi', answered_at = ?4, told_at = 0,
                    removed_at = 0, removed_by = '', until = 0
             WHERE desk_id = ?1 AND id = ?2 AND {ON_SHELF}"
        ),
        params![desk_id, id, answer, now],
    )? > 0)
}

/// Not now: off the shelf's open list until `until`, and back on On you
/// then, fresh, as a card moved to Tomorrow is (`thread::mark_stale`). One
/// put away by age is brought back to wait. An answered one is left alone.
pub fn later(conn: &Connection, desk_id: i64, id: i64, until: i64) -> Result<bool> {
    Ok(conn.execute(
        &format!(
            "UPDATE turns SET until = ?3, removed_at = 0, removed_by = ''
             WHERE desk_id = ?1 AND id = ?2 AND answered_at = 0 AND {ON_SHELF}"
        ),
        params![desk_id, id, until],
    )? > 0)
}

/// Drop: the reader's Not this, with their word, on a question however old.
/// Said in the desk's brief for a week, as a card's is (`onyou::nots`), and
/// `thread::restore_turn` takes it back.
pub fn drop_it(conn: &Connection, desk_id: i64, id: i64, word: &str, now: i64) -> Result<bool> {
    Ok(conn.execute(
        &format!(
            "UPDATE turns SET removed_at = ?3, removed_by = 'not', answer = ?4, until = 0
             WHERE desk_id = ?1 AND id = ?2 AND answered_at = 0 AND {ON_SHELF}"
        ),
        params![desk_id, id, now, crate::thread::line(word, 120)],
    )? > 0)
}

#[cfg(test)]
mod tests;
