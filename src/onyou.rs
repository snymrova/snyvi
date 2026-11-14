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

//!
//! 1.66 (rethink e36434e663, plan e7fda1ca90): three shelves, one count.
//! One list held four things with four lifetimes -- Claude's own dialog,
//! answered in seconds in the terminal; an agent's question, an agent stuck;
//! a chore only the reader can do, which takes days; and a notice with
//! nothing to answer -- and the reader sorted them in their head each time
//! they looked. Every row now has a `shelf`:
//!
//! - **Waiting**: an agent is stuck on the reader -- a question, a plan to
//!   approve, a routine's run waiting for Go ahead, a routine to Start or
//!   Allow, one that cannot run. The only count, and it counts agents.
//! - **To do**: what only the reader can do -- a hand-over, a dated line, a
//!   line to keep. No count, and it never ages out.
//! - **News**: what happened (`crate::news`, and a merge's tick). No count.
//!
//! The tray's cap and its order of cards first are gone with it, and so is
//! the tray opening itself on arrival: the count is the one signal.

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
    /// 1.66: `waiting`, `todo` or `news`.
    pub shelf: &'static str,
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
    /// A card of several questions is one row (1.64, C1): each of them,
    /// still open, in the order they were asked; `turn` is the first. A
    /// card of four counted as four things and was four rows (U3).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub turns: Vec<crate::thread::Turn>,
    /// Gone quiet (C3): its panel was prompted since, so it may be done or
    /// answered there. Last in the list, under its own head, and not in the
    /// count, the sentence or the amber.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub quiet: bool,
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
    /// 1.66, a routine to Start or Allow: what the reader asked for, what
    /// the agent's try did, when it runs and what it may run.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub asked: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tried: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub when: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub may: Vec<String>,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// The list, its sentence and its counts, for `/api/lately` and `/api/home`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OnYou {
    pub sentence: String,
    /// The sentence after its count, for a head that says the count (C2).
    pub clauses: String,
    /// Waiting first, newest first; then To do, in rank and time; then the
    /// News rows (a merge's tick); then Waiting's quiet questions.
    pub rows: Vec<Row>,
    /// 1.66: the agents stuck on the reader, quiet ones aside: the pill's
    /// number, and the only count. A card of four questions is one agent.
    pub left: usize,
    /// How many of the rows are quiet (C3), at the end of `rows`.
    pub quiet: usize,
    /// 1.66: rows on To do, and News lines not seen: said, never a badge.
    pub todo: usize,
    pub news_unseen: i64,
    /// 1.66: News, newest first (`crate::news`).
    pub news: Vec<crate::news::Item>,
    /// Routines that ran today and wrote nothing for the reader.
    pub ran_quiet: usize,
    /// Threads two weeks still, and their desks: the pile, one grey line.
    pub older: usize,
    pub older_desks: usize,
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
    routine_rows(conn, now, &desks, &mut rows)?;
    routine_waiting(conn, &desks, &mut rows)?;
    waiting_rows(conn, now, &desks, &mut rows)?;
    let rows = ordered(rows);
    let quiet = rows.iter().filter(|r| r.quiet).count();
    let left = agents(&rows);
    let todo = rows.iter().filter(|r| r.shelf == "todo").count();

    // Routines that ran today and left nothing for the reader: one grey
    // line, so twenty quiet runs are not twenty rows and not nothing.
    let day = crate::due::end_of_day(now) - 86_399;
    let ran_quiet: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT r.routine_id) FROM routine_runs r
         JOIN routines x ON x.id = r.routine_id JOIN desks d ON d.id = x.desk_id
         WHERE r.started_at >= ?1 AND r.state IN ('done', 'quiet') AND x.removed_at = 0 AND d.closed_at = 0
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
    let mut oy = OnYou {
        sentence: String::new(),
        clauses: String::new(),
        rows,
        left,
        quiet,
        todo,
        news_unseen: crate::news::unseen(conn, None, now)?,
        news: crate::news::list(conn, None, now)?,
        ran_quiet: ran_quiet as usize,
        older: older as usize,
        older_desks: older_desks as usize,
    };
    oy.sentence = sentence(&oy, now);
    oy.clauses = clauses(&oy, now);
    Ok(oy)
}

/// How many agents are stuck on the reader (1.66): Waiting's rows, quiet
/// ones aside, one per panel that asked, per routine, per plan.
pub fn agents(rows: &[Row]) -> usize {
    let mut who: Vec<String> = rows
        .iter()
        .filter(|r| r.shelf == "waiting" && !r.quiet)
        .map(|r| match (&r.turn, r.routine_id) {
            (Some(t), _) if !t.pane.is_empty() => format!("p{}", t.pane),
            (Some(t), _) => format!("t{}", t.id),
            (None, id) if id != 0 => format!("r{id}"),
            _ => format!("{}{}{}", r.kind, r.desk, r.doc),
        })
        .collect();
    who.sort();
    who.dedup();
    who.len()
}

/// The shelves in order (1.66): Waiting, newest first; To do in rank and
/// time; News's rows, newest first; and Waiting's quiet questions last.
fn ordered(rows: Vec<Row>) -> Vec<Row> {
    let (mut quiet, rest): (Vec<Row>, Vec<Row>) = rows.into_iter().partition(|r| r.quiet);
    let shelf = |s: &str| -> Vec<Row> { rest.iter().filter(|r| r.shelf == s).cloned().collect() };
    let mut waiting = shelf("waiting");
    let mut todo = shelf("todo");
    let mut news = shelf("news");
    waiting.sort_by_key(|r| (std::cmp::Reverse(r.at), r.desk));
    todo.sort_by_key(|r| (r.rank, r.at, r.desk));
    news.sort_by_key(|r| (std::cmp::Reverse(r.at), r.desk));
    quiet.sort_by_key(|r| (std::cmp::Reverse(r.at), r.desk));
    waiting.extend(todo);
    waiting.extend(news);
    waiting.extend(quiet);
    waiting
}

/// The shelf a card is on (1.66): a question is an agent stuck, a merge's
/// tick is News, and every other card is a chore only the reader can do.
pub fn shelf_of(kind: &str) -> &'static str {
    match kind {
        "decide" => "waiting",
        "tell" => "news",
        _ => "todo",
    }
}

/// 1.66: a routine an agent made, waiting for Start; one an agent changed in
/// what it may run, waiting for Allow; and one that cannot run. Each is an
/// agent stuck on the reader, and each is one press.
fn routine_waiting(
    conn: &Connection,
    desks: &HashMap<i64, String>,
    rows: &mut Vec<Row>,
) -> Result<()> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    let all: Vec<i64> = conn
        .prepare_cached(
            "SELECT r.id FROM routines r JOIN desks d ON d.id = r.desk_id
             WHERE r.removed_at = 0 AND d.closed_at = 0
               AND ((r.suggested_by != '' AND r.started_at = 0)
                    OR (r.started_at != 0 AND (r.pending != '' OR r.stuck != '')))
             ORDER BY r.id",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in all {
        let Some(r) = crate::routine::get(conn, id)? else {
            continue;
        };
        rows.push(routine_row(conn, &r, name(r.desk_id))?);
    }
    Ok(())
}

/// One routine's Waiting row: Start, Allow, or why it cannot run.
fn routine_row(conn: &Connection, r: &crate::routine::Routine, desk_name: String) -> Result<Row> {
    let times = crate::routine::times::times_of(conn, r.id)?;
    let mut when: Vec<String> = crate::routine::times::lines(&times)
        .iter()
        .map(|l| {
            if l.words.is_empty() {
                l.every.clone()
            } else {
                format!("{} {}", l.every, l.words)
            }
        })
        .collect();
    if !r.watch.is_empty() {
        when.push(if r.fast { "on watch, fast" } else { "on watch" }.into());
    }
    let mut may: Vec<String> = r.waits.iter().map(|w| format!("waits for you: {w}")).collect();
    for (what, line) in [("watch", &r.watch), ("gate", &r.gate)] {
        if !line.is_empty() {
            may.push(format!("{what}: {line}"));
        }
    }
    let (kind, text, at) = if r.started_at == 0 {
        ("routine_start", format!("Start {}?", r.name), r.created_at)
    } else if !r.stuck.is_empty() {
        (
            "routine_stuck",
            format!("{} can't run: {}", r.name, r.stuck),
            r.stuck_at,
        )
    } else {
        let p: crate::routine::Pending = serde_json::from_str(&r.pending).unwrap_or_default();
        let mut what: Vec<String> = Vec::new();
        if let Some(w) = &p.waits {
            what.push(format!(
                "waits for you: {}",
                if w.is_empty() { "nothing".into() } else { w.join(", ") }
            ));
        }
        for (k, v) in [("watch", &p.watch), ("gate", &p.gate), ("shape", &p.shape)] {
            if let Some(v) = v {
                what.push(format!("{k}: {}", if v.is_empty() { "none" } else { v }));
            }
        }
        may = what;
        (
            "routine_allow",
            format!("{} wants to run more. Allow it?", r.name),
            r.allowed_at.max(r.created_at),
        )
    };
    Ok(Row {
        kind,
        shelf: "waiting",
        rank: 3,
        desk: r.desk_id,
        desk_name,
        text,
        at,
        routine: r.name.clone(),
        routine_id: r.id,
        by: r.suggested_by.clone(),
        asked: r.asked.clone(),
        tried: r.tried.clone(),
        when: when.join("; "),
        may,
        ..Row::default()
    })
}

/// Rank 1: the cards, a card of several questions as one row; rank 6, one
/// gone quiet.
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
    let at = rows.len();
    for t in crate::thread::waiting(conn, now)? {
        if t.via == "dialog" {
            continue;
        }
        // The rest of a card's questions go into its row.
        if t.ask_group != 0 {
            if let Some(r) = rows[at..]
                .iter_mut()
                .find(|r| r.turn.as_ref().is_some_and(|f| f.ask_group == t.ask_group))
            {
                r.at = r.at.max(t.created_at);
                r.quiet &= t.quiet_at > 0;
                r.turns.push(t);
                continue;
            }
        }
        let (doc, doc_title) = doc_titled(conn, &t.link);
        rows.push(Row {
            kind: "card",
            shelf: shelf_of(&t.kind),
            rank: 1,
            desk: t.desk_id,
            desk_name: name(t.desk_id),
            text: t.text.clone(),
            at: t.created_at,
            doc,
            doc_title,
            by: t.by.clone(),
            quiet: t.quiet_at > 0,
            turns: if t.ask_group != 0 {
                vec![t.clone()]
            } else {
                Vec::new()
            },
            turn: Some(t),
            ..Row::default()
        });
    }
    for r in &mut rows[at..] {
        if r.quiet {
            r.rank = 6;
        }
        // A card's questions answered here and not yet told stay on it,
        // folded where they were asked, so an answer keeps its place and
        // can be changed until it is sent (C7).
        let g = r.turn.as_ref().map_or(0, |t| t.ask_group);
        if g != 0 {
            r.turns.extend(crate::thread::group_said(conn, g)?);
            r.turns.sort_by_key(|t| t.id);
        }
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
            shelf: "todo",
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
    // since the run was for this morning, and Go ahead beside it. Not while
    // its panel has a card open on the reader (#202): the card is the thing
    // to answer and the line says it again ("the leash-pulling explainer
    // still waits for your answer"), so On you counted one ask twice. The
    // desk is still the routine's, so a session's rank 5 does not say it.
    let lines: Vec<(i64, String, i64, String, String, i64, bool)> = conn
        .prepare_cached(
            "SELECT d.id, d.left_off, d.left_off_at, d.left_off_about, r.name, r.id,
                    EXISTS(SELECT 1 FROM turns t WHERE t.desk_id = d.id AND t.pane = d.left_off_pane
                           AND t.answered_at = 0 AND t.removed_at = 0 AND t.until <= ?1 AND t.via != 'dialog')
             FROM desks d
             JOIN routines r ON r.pane != '' AND r.pane = d.left_off_pane AND r.removed_at = 0
             WHERE d.closed_at = 0 AND d.parked_at = 0 AND d.left_off != '' AND d.left_off_needs = 'you'
               AND d.left_off_ok_at < d.left_off_at AND d.left_off_until <= ?1 AND d.left_off_not = ''
             ORDER BY d.left_off_at DESC",
        )?
        .query_map(params![now], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (desk, text, at, about, routine, routine_id, carded) in lines {
        routine_desks.push(desk);
        if carded {
            continue;
        }
        let (doc, doc_title) = doc_titled(conn, &about);
        rows.push(Row {
            kind: "routine",
            shelf: "waiting",
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
    rows: &mut Vec<Row>,
) -> Result<()> {
    let name = |id: i64| desks.get(&id).cloned().unwrap_or_default();
    // 4. A plan waiting for Approve, a line waiting for Accept; 5. a
    // session's left-off that has needed the reader a day.
    for w in crate::waiting::rows(conn, now)? {
        if w.kind == "plan" {
            rows.push(Row {
                kind: "plan",
                shelf: "waiting",
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
        }
        // 1.66: a session's left-off is the desk's head, not On you: what
        // only the reader can do is a hand-over, one door (plan e7fda1ca90).
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
            shelf: "todo",
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
pub(crate) fn doc_titled(conn: &Connection, doc: &str) -> (String, String) {
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
    let n = oy.left;
    let what = clauses(oy, now);
    match n {
        0 => "Nothing is waiting on you.".to_string(),
        1 if what.is_empty() => "One agent is waiting on you.".to_string(),
        1 => format!("One agent is waiting on you: {what}."),
        _ if what.is_empty() => format!("{} agents are waiting on you.", cap(&count(n))),
        _ => format!("{} agents are waiting on you, {what}.", cap(&count(n))),
    }
}

/// What the sentence says after its count: for one thing, what it is and
/// where; for more, the routines' share and the first dated line. Home's
/// box has the count in its head and says only this beside it (C2), so
/// the number is said once.
pub fn clauses(oy: &OnYou, _now: i64) -> String {
    let waiting: Vec<&Row> = oy.rows.iter().filter(|r| r.shelf == "waiting" && !r.quiet).collect();
    if oy.left == 1 {
        let Some(r) = waiting.first() else { return String::new() };
        return match r.kind {
            "card" if r.turns.len() > 1 => format!("{} questions on {}", count(r.turns.len()), r.desk_name),
            "card" => format!("a question on {}", r.desk_name),
            "routine" => format!("{} on {}, from {}", crate::thread::line(&r.text, 60), r.desk_name, r.routine),
            "plan" => format!("a plan to approve on {}", r.desk_name),
            "routine_start" => format!("start {} on {}", r.routine, r.desk_name),
            "routine_allow" => format!("allow {}'s change on {}", r.routine, r.desk_name),
            "routine_stuck" => format!("{} can't run, on {}", r.routine, r.desk_name),
            _ => format!("{} on {}", crate::thread::line(&r.text, 60), r.desk_name),
        };
    }
    // More than one: where, by desk, the first three.
    let mut names: Vec<&str> = Vec::new();
    for r in &waiting {
        if !names.contains(&r.desk_name.as_str()) {
            names.push(&r.desk_name);
        }
    }
    match names.len() {
        0 => String::new(),
        1..=3 => format!("on {}", names.join(", ")),
        n => format!("on {} and {} more desks", names[..2].join(", "), n - 2),
    }
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
