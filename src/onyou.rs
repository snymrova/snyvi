//! On you, widened (1.54, plan 50294dbc39): everything that is the reader's,
//! from the tables that exist, as one ranked list -- the corner's tray on
//! every page, Home's box, and the sentence over them.
//!
//! The record said why (brainstorm 53de9a0c3c, read against the live store
//! on 29 Oct): agents hand the reader the last mile of every project, and
//! that mile was spread over thirteen desks in four shapes with three rules
//! of when. A card was in the corner at once; a left-off that needed the
//! reader sat on its desk's head for two days before Home said so, a
//! routine's line with it though the run was for this morning; a dated line
//! rang at its hour, with words and without the document it was about. What
//! the reader could do with one press inside snyvi got done in minutes;
//! what needed a hand elsewhere waited a day and was removed, 46 times in 64
//! with no reason said.
//!
//! So: no fifth shape, no new table, no new route. `gather` reads the four
//! that exist and ranks them; the list comes to the reader when they arrive
//! (`arrive`), not at an hour; a row carries its document; ✕ is an answer
//! (`later`, `not`), which the brief carries to the agent; and Go ahead
//! makes fewer things theirs at all (`routine_run::go_ahead`,
//! `waiting::approve_left_off`).
//!
//! The rank is here and never on the page: a card an agent is blocked on,
//! a dated line due today, a routine's line, a plan or a suggested line,
//! a session's left-off that has needed the reader a day.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

/// 1.54's columns, version 34 of `store::MIGRATIONS`, never in a `SCHEMA`.
/// A line's document; Tomorrow and Next week on a card and on a left-off,
/// and Not this with its word on a left-off (a card's is `removed_by =
/// 'not'` with the word in `answer`, empty on an unanswered card); when the
/// tray last opened itself, how many rows it held then, and the box's ⋯.
pub const NOTE_COLUMN_1_54: &str = "ALTER TABLE desk_notes ADD COLUMN doc TEXT NOT NULL DEFAULT ''";
pub const TURN_COLUMN_1_54: &str = "ALTER TABLE turns ADD COLUMN until INTEGER NOT NULL DEFAULT 0";
pub const DESK_COLUMNS_1_54: &str =
    "ALTER TABLE desks ADD COLUMN left_off_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desks ADD COLUMN left_off_not TEXT NOT NULL DEFAULT '';";
pub const HOME_COLUMNS_1_54: &str =
    "ALTER TABLE home_state ADD COLUMN arrived_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE home_state ADD COLUMN arrived_left INTEGER NOT NULL DEFAULT 0;
ALTER TABLE home_state ADD COLUMN arrive_off INTEGER NOT NULL DEFAULT 0;";

/// The tray shows this many rows, then *and N more, on K desks*: today's
/// list was nine rows, and at twenty routines it is a page.
pub const TRAY_ROWS: usize = 7;
/// The tray opens itself again, the window back in front, when things
/// became the reader's since it last did -- and not within this long of
/// the last time, so a day of coming and going is not a day of trays.
pub const ARRIVE_AGAIN_S: i64 = 3600;
/// How long a Not this on a card is said in the brief.
pub const NOT_SAID_S: i64 = 7 * 86_400;
/// A thread two weeks still is the older pile: one grey line, never rows.
pub const OLDER_S: i64 = 14 * 86_400;

/// One row of the list. `kind` is `card` (a turn, which rides inside so
/// the corner's `turnRow` keeps drawing it), `due` (a dated line), `routine`
/// (a routine's last line for the reader), `plan`, `suggested` (a line
/// waiting on Accept) or `left` (a session's left-off).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Row {
    pub kind: &'static str,
    pub rank: u8,
    pub desk: i64,
    pub desk_name: String,
    pub text: String,
    /// When it became the reader's: the card's time, the line's hour, the
    /// left-off's time, the plan's.
    pub at: i64,
    /// The thing the row is about, when it has one: a document by id, and
    /// its title for the row.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<crate::thread::Turn>,
    #[serde(skip_serializing_if = "is_zero")]
    pub note: i64,
    /// The routine whose line it is, by name and id.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub routine: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub routine_id: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<i64>,
    /// Go ahead is a button: a routine's line resumes its session, a
    /// session's left-off is approved.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub go: bool,
    /// An agent's line for the reader that named no document: said in grey,
    /// which is the nudge.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_doc: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// The list, its sentence and its counts, for `/api/lately` and `/api/home`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OnYou {
    pub sentence: String,
    pub rows: Vec<Row>,
    /// How many rows there are: the pill's number.
    pub left: usize,
    /// Past the tray's `TRAY_ROWS`: how many more, on how many desks.
    pub more: usize,
    pub more_desks: usize,
    /// Routines that ran today and wrote nothing for the reader.
    pub ran_quiet: usize,
    /// Threads two weeks still, and their desks: the pile, one grey line.
    pub older: usize,
    pub older_desks: usize,
    /// Days since the tray last opened itself, for the sentence.
    pub days_away: i64,
    /// The box's ⋯: the tray does not open itself.
    pub arrive_off: bool,
}

/// Everything that is the reader's now, ranked, with its counts.
pub fn gather(conn: &Connection, now: i64) -> Result<OnYou> {
    let desks: HashMap<i64, String> = conn
        .prepare_cached("SELECT id, name FROM desks WHERE closed_at = 0")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rows: Vec<Row> = Vec::new();
    card_rows(conn, now, &desks, &mut rows)?;
    due_rows(conn, now, &desks, &mut rows)?;
    let routine_desks = routine_rows(conn, now, &desks, &mut rows)?;
    waiting_rows(conn, now, &desks, &routine_desks, &mut rows)?;
    rows.sort_by_key(|r| (r.rank, r.at, r.desk));
    let left = rows.len();
    let more = left.saturating_sub(TRAY_ROWS);
    let more_desks = {
        let mut ds: Vec<i64> = rows.iter().skip(TRAY_ROWS).map(|r| r.desk).collect();
        ds.sort_unstable();
        ds.dedup();
        ds.len()
    };

    // Routines that ran today and left nothing for the reader: one grey
    // line, so twenty quiet runs are not twenty rows and not nothing.
    let day = crate::due::end_of_day(now) - 86_399;
    let ran_quiet: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT r.routine_id) FROM routine_runs r
         JOIN routines x ON x.id = r.routine_id JOIN desks d ON d.id = x.desk_id
         WHERE r.started_at >= ?1 AND r.state = 'done' AND x.removed_at = 0 AND d.closed_at = 0
           AND NOT (d.left_off_pane = x.pane AND d.left_off_needs = 'you' AND d.left_off_ok_at < d.left_off_at
                    AND d.left_off_until <= ?2 AND d.left_off_not = '')",
        params![day, now],
        |r| r.get(0),
    )?;
    let (older, older_desks): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COUNT(DISTINCT t.desk_id) FROM threads t JOIN desks d ON d.id = t.desk_id
         WHERE t.removed_at = 0 AND t.shipped_at = 0 AND t.moved_at < ?1 AND d.closed_at = 0",
        params![now - OLDER_S],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (arrived_at, _, arrive_off) = home(conn)?;
    let days_away = if arrived_at > 0 {
        (now - arrived_at) / 86_400
    } else {
        0
    };
    let mut oy = OnYou {
        sentence: String::new(),
        rows,
        left,
        more,
        more_desks,
        ran_quiet: ran_quiet as usize,
        older: older as usize,
        older_desks: older_desks as usize,
        days_away,
        arrive_off,
    };
    oy.sentence = sentence(&oy, now);
    Ok(oy)
}

/// Rank 1: the cards.
fn card_rows(
    conn: &Connection,
    now: i64,
    desks: &HashMap<i64, String>,
    rows: &mut Vec<Row>,
) -> Result<()> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    // 1. A card an agent is blocked on, not Claude's own dialog. An older
    // one too: the corner kept those apart as Older after half an hour,
    // which is exactly the card the reader arriving in the evening needs
    // to see first. `stale` rides in the turn for the row to grey.
    for t in crate::thread::waiting(conn, now)? {
        if t.via == "dialog" {
            continue;
        }
        let (doc, doc_title) = doc_titled(conn, &t.link);
        rows.push(Row {
            kind: "card",
            rank: 1,
            desk: t.desk_id,
            desk_name: name(t.desk_id),
            text: t.text.clone(),
            at: t.created_at,
            doc,
            doc_title,
            by: t.by.clone(),
            turn: Some(t),
            ..Row::default()
        });
    }

    Ok(())
}

/// Rank 2: the dated lines due by tonight.
fn due_rows(
    conn: &Connection,
    now: i64,
    desks: &HashMap<i64, String>,
    rows: &mut Vec<Row>,
) -> Result<()> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    // 2. A dated line due today or overdue, its card not yet risen (once it
    // has, the card is the row).
    let end = crate::due::end_of_day(now);
    let due: Vec<(i64, i64, String, i64, String)> = conn
        .prepare_cached(
            "SELECT n.desk_id, n.id, n.text, n.due_at, n.doc FROM desk_notes n JOIN desks d ON d.id = n.desk_id
             WHERE n.due_at > 0 AND n.due_at <= ?1 AND n.due_rang_at = 0 AND n.done_at = 0
               AND n.removed_at = 0 AND n.suggested_by = '' AND d.closed_at = 0 AND d.parked_at = 0
             ORDER BY n.due_at, n.id LIMIT 12",
        )?
        .query_map(params![end], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (desk, note, text, at, doc) in due {
        let (doc, doc_title) = doc_titled(conn, &doc);
        rows.push(Row {
            kind: "due",
            rank: 2,
            desk,
            desk_name: name(desk),
            text,
            at,
            doc,
            doc_title,
            note,
            ..Row::default()
        });
    }

    Ok(())
}

/// Rank 3: a routine's line; the desks it is on, so a session's rank 5
/// does not say it twice.
fn routine_rows(
    conn: &Connection,
    now: i64,
    desks: &HashMap<i64, String>,
    rows: &mut Vec<Row>,
) -> Result<Vec<i64>> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    let mut routine_desks: Vec<i64> = Vec::new();
    // 3. A routine's last line for the reader, from whatever run: no wait,
    // since the run was for this morning, and Go ahead beside it.
    let lines: Vec<(i64, String, i64, String, String, i64)> = conn
        .prepare_cached(
            "SELECT d.id, d.left_off, d.left_off_at, d.left_off_about, r.name, r.id FROM desks d
             JOIN routines r ON r.pane != '' AND r.pane = d.left_off_pane AND r.removed_at = 0
             WHERE d.closed_at = 0 AND d.parked_at = 0 AND d.left_off != '' AND d.left_off_needs = 'you'
               AND d.left_off_ok_at < d.left_off_at AND d.left_off_until <= ?1 AND d.left_off_not = ''
             ORDER BY d.left_off_at DESC",
        )?
        .query_map(params![now], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (desk, text, at, about, routine, routine_id) in lines {
        routine_desks.push(desk);
        let (doc, doc_title) = doc_titled(conn, &about);
        rows.push(Row {
            kind: "routine",
            rank: 3,
            desk,
            desk_name: name(desk),
            text,
            at,
            no_doc: doc.is_empty(),
            doc,
            doc_title,
            routine,
            routine_id,
            go: true,
            ..Row::default()
        });
    }

    Ok(routine_desks)
}

/// Ranks 4 and 5: plans, lines to keep, a session's left-off.
fn waiting_rows(
    conn: &Connection,
    now: i64,
    desks: &HashMap<i64, String>,
    routine_desks: &[i64],
    rows: &mut Vec<Row>,
) -> Result<()> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    // 4. A plan waiting for Approve, a line waiting for Accept; 5. a
    // session's left-off that has needed the reader a day.
    for w in crate::waiting::rows(conn, now)? {
        if w.kind == "plan" {
            rows.push(Row {
                kind: "plan",
                rank: 4,
                desk: w.desk,
                desk_name: name(w.desk),
                text: w.text,
                at: w.at,
                doc_title: title_of(conn, &w.doc),
                doc: w.doc,
                notes: w.notes,
                by: w.by,
                ..Row::default()
            });
        } else if !routine_desks.contains(&w.desk) {
            let (doc, doc_title) = doc_titled(conn, &w.doc);
            rows.push(Row {
                kind: "left",
                rank: 5,
                desk: w.desk,
                desk_name: name(w.desk),
                text: w.text,
                at: w.at,
                no_doc: doc.is_empty(),
                doc,
                doc_title,
                by: w.by,
                go: true,
                ..Row::default()
            });
        }
    }
    let suggested: Vec<(i64, i64, String, i64, String, String)> = conn
        .prepare_cached(
            "SELECT n.desk_id, n.id, n.text, n.created_at, n.suggested_by, n.doc FROM desk_notes n
             JOIN desks d ON d.id = n.desk_id
             WHERE n.suggested_by != '' AND n.done_at = 0 AND n.removed_at = 0
               AND d.closed_at = 0 AND d.parked_at = 0 ORDER BY n.id LIMIT 12",
        )?
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (desk, note, text, at, by, doc) in suggested {
        let (doc, doc_title) = doc_titled(conn, &doc);
        rows.push(Row {
            kind: "suggested",
            rank: 4,
            desk,
            desk_name: name(desk),
            text,
            at,
            doc,
            doc_title,
            note,
            by,
            ..Row::default()
        });
    }

    Ok(())
}

/// A document by id, when it is one in the library: the id and its title;
/// nothing for a web link or a missing one.
fn doc_titled(conn: &Connection, doc: &str) -> (String, String) {
    if !crate::desk::doc_ok(doc) {
        return (String::new(), String::new());
    }
    let title = title_of(conn, doc);
    if title.is_empty() {
        (String::new(), String::new())
    } else {
        (doc.to_string(), title)
    }
}

/// A document's title, or nothing: a store without the library (a test's)
/// has none to give.
fn title_of(conn: &Connection, doc: &str) -> String {
    if doc.is_empty() {
        return String::new();
    }
    conn.prepare_cached("SELECT title FROM docs WHERE id = ?1 AND deleted_at = 0")
        .ok()
        .and_then(|mut st| st.query_row(params![doc], |r| r.get(0)).optional().ok())
        .flatten()
        .unwrap_or_default()
}

/// The sentence over the list, from its counts: *Nine things are on you.
/// Two from routines this morning, one at 10:00.* · *One thing is on you:
/// a run card on bos_dog.* · *Four days away. Three things are on you.* ·
/// *Nothing is on you.*
pub fn sentence(oy: &OnYou, now: i64) -> String {
    let away = match oy.days_away {
        0 => String::new(),
        1 => "A day away. ".to_string(),
        n => format!("{} days away. ", cap(&count(n as usize))),
    };
    let n = oy.left;
    if n == 0 {
        return format!("{away}Nothing is on you.");
    }
    if n == 1 {
        let r = &oy.rows[0];
        let what = match r.kind {
            "card" => format!(
                "a {} card on {}",
                r.turn.as_ref().map_or("", |t| t.kind.as_str()),
                r.desk_name
            ),
            "routine" => format!(
                "{} on {}, from {}",
                crate::thread::line(&r.text, 60),
                r.desk_name,
                r.routine
            ),
            "due" => format!(
                "{} at {} on {}",
                crate::thread::line(&r.text, 60),
                hm(r.at),
                r.desk_name
            ),
            "plan" => format!("a plan to approve on {}", r.desk_name),
            "suggested" => format!("a line to keep on {}", r.desk_name),
            _ => format!("{} on {}", crate::thread::line(&r.text, 60), r.desk_name),
        };
        return format!("{away}One thing is on you: {what}.");
    }
    let mut clauses: Vec<String> = Vec::new();
    let routines = oy.rows.iter().filter(|r| r.kind == "routine").count();
    if routines > 0 {
        let when = if hour(now) < 12 {
            "this morning"
        } else {
            "today"
        };
        clauses.push(format!("{} from routines {when}", count(routines)));
    }
    if let Some(due) = oy.rows.iter().find(|r| r.kind == "due") {
        clauses.push(if due.at < now {
            format!("one overdue since {}", hm(due.at))
        } else {
            format!("one at {}", hm(due.at))
        });
    }
    let tail = if clauses.is_empty() {
        String::new()
    } else {
        format!(" {}.", cap(&clauses.join(", ")))
    };
    format!("{away}{} things are on you.{tail}", cap(&count(n)))
}

/// A small count in words, as a sentence says it.
fn count(n: usize) -> String {
    match n {
        1 => "one",
        2 => "two",
        3 => "three",
        4 => "four",
        5 => "five",
        6 => "six",
        7 => "seven",
        8 => "eight",
        9 => "nine",
        _ => return n.to_string(),
    }
    .to_string()
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// `10:00`, in the reader's time.
fn hm(at: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp(at)
        .map(|t| {
            let t = t.to_offset(crate::due::offset());
            format!("{:02}:{:02}", t.hour(), t.minute())
        })
        .unwrap_or_default()
}

fn hour(at: i64) -> u8 {
    time::OffsetDateTime::from_unix_timestamp(at)
        .map(|t| t.to_offset(crate::due::offset()).hour())
        .unwrap_or(12)
}

/// The reader's date for a time, in their offset.
fn local_date(at: i64) -> Option<time::Date> {
    time::OffsetDateTime::from_unix_timestamp(at)
        .ok()
        .map(|t| t.to_offset(crate::due::offset()).date())
}

/// `(arrived_at, arrived_left, arrive_off)` from Home's one row.
fn home(conn: &Connection) -> Result<(i64, usize, bool)> {
    Ok(conn
        .query_row(
            "SELECT arrived_at, arrived_left, arrive_off FROM home_state WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get::<_, i64>(1)? as usize,
                    r.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()?
        .unwrap_or((0, 0, false)))
}

/// A window came to the front (`events::focus`): does the tray open itself?
/// Yes the first time in a day, and again when things became the reader's
/// since it last did, an hour or more later -- with something to show. Never
/// with the box's ⋯ off. The gather runs only once the date or the hour says
/// it might, so the beacon stays cheap; the stamp moves on every such look,
/// so at most one gather an hour comes of it.
pub fn arrive(conn: &Connection, now: i64) -> Result<Option<OnYou>> {
    let (at, left_was, off) = home(conn)?;
    if off {
        return Ok(None);
    }
    let fresh_day = at == 0 || local_date(now) != local_date(at);
    if !fresh_day && now - at < ARRIVE_AGAIN_S {
        return Ok(None);
    }
    let oy = gather(conn, now)?;
    conn.execute(
        "UPDATE home_state SET arrived_at = ?1, arrived_left = ?2 WHERE id = 1",
        params![now, oy.left as i64],
    )?;
    let open = oy.left > 0 && (fresh_day || oy.left > left_was);
    Ok(open.then_some(oy))
}

/// The box's ⋯: *Open On you when I arrive*, off or on.
pub fn set_arrive_off(conn: &Connection, off: bool) -> Result<()> {
    conn.execute(
        "UPDATE home_state SET arrive_off = ?1 WHERE id = 1",
        params![off as i64],
    )?;
    Ok(())
}

/// Tomorrow or Next week on a left-off's row: it is off the list until
/// then, the sentence as it was. 0 brings it back (Undo).
pub fn later_left_off(conn: &Connection, desk_id: i64, until: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE desks SET left_off_until = ?2 WHERE id = ?1 AND left_off != ''",
        params![desk_id, until],
    )? > 0)
}

/// Not this on a left-off's row, with the reader's word: no longer theirs,
/// and the brief says so (`nots`). `None` takes it back.
pub fn not_left_off(conn: &Connection, desk_id: i64, word: Option<&str>) -> Result<bool> {
    let n = match word {
        Some(w) => conn.execute(
            "UPDATE desks SET left_off_not = ?2, left_off_needs = '' WHERE id = ?1 AND left_off != ''",
            params![desk_id, crate::thread::line(w, 120)],
        )?,
        None => conn.execute(
            "UPDATE desks SET left_off_not = '', left_off_needs = 'you' WHERE id = ?1 AND left_off != ''",
            params![desk_id],
        )?,
    };
    Ok(n > 0)
}

/// What the reader said Not this to on a desk, for its brief: each card put
/// away so in the last week, and the left-off, with the word and when.
pub fn nots(conn: &Connection, desk_id: i64, now: i64) -> Result<Vec<(String, String, i64)>> {
    let mut out: Vec<(String, String, i64)> = conn
        .prepare_cached(
            "SELECT text, answer, removed_at FROM turns WHERE desk_id = ?1 AND removed_by = 'not'
               AND removed_at >= ?2 ORDER BY removed_at DESC LIMIT 6",
        )?
        .query_map(params![desk_id, now - NOT_SAID_S], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(l) = conn
        .query_row(
            "SELECT left_off, left_off_not, left_off_at FROM desks WHERE id = ?1 AND left_off_not != ''",
            params![desk_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
    {
        out.push(l);
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
