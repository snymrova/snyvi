//! A date on a line (1.47): `post the 1.47 note by fri 10`. The tail of a
//! note's text, when it reads as a day and a time, comes off the text and is
//! kept as the note's `due_at`; the rail shows it as one word under the line,
//! Home leads with what is due, and at the hour one card rises on the
//! reader's On you, once (`ring`).
//!
//! Parsed here, in the daemon, once, so the desk's field, Home's note bar, an
//! edit and an agent's `suggest_desk_note` all agree on what a line said. The
//! page draws what the daemon answered; it never parses a date of its own.
//!
//! Only the tail counts. `#182 is due to the md to pdf` is a note, and so is
//! `notes from fri`: a weekday alone, `weekend` and `next week` need a word
//! before them that makes them a date (`by fri`, `on sat`, `post it, fri`),
//! and an hour alone needs `at` or `by`. A tail that would be in the past is
//! left as words: no line is quietly due yesterday.
//!
//! Nothing here starts anything. A due line is shown; snyvi never types it
//! into a panel.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::OnceLock;
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset, Weekday};

/// 1.47's columns for a date on a line: when it is due, and when its card
/// rose (0 until it has; a new date clears it, so a line rings once per
/// date). Version 28 of `store::MIGRATIONS`, never in a `SCHEMA`.
pub const COLUMNS_1_47: &str =
    "ALTER TABLE desk_notes ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE desk_notes ADD COLUMN due_rang_at INTEGER NOT NULL DEFAULT 0;";
/// And the note a `due` card is about, on the turns, which `crate::thread`
/// keeps apart from the desks' tables.
pub const TURN_COLUMN_1_47: &str =
    "ALTER TABLE turns ADD COLUMN note_id INTEGER NOT NULL DEFAULT 0";

/// The kind of On you card a due line raises. snyvi's own, not one an agent
/// can ask for, so it is not in `thread::KINDS`: its buttons are Done, Later…
/// and Open desk, and its `by` is `snyvi`, its `via` the `clock`.
pub const KIND: &str = "due";

/// The most words a tail is read over: `by 28 oct 7:30 pm` is the longest.
const TAIL_MAX: usize = 4;

/// The reader's offset from UTC, read once in `cli::serve` before the
/// runtime starts: the `time` crate refuses to read it once there is a
/// second thread, and a reminder read in UTC rings at the wrong hour.
static OFFSET: OnceLock<UtcOffset> = OnceLock::new();

/// Read the local offset, on the one thread the daemon has yet. Said in the
/// log when it cannot be read, since dates then fall on UTC's hours.
pub fn read_offset() {
    match UtcOffset::current_local_offset() {
        Ok(o) => {
            let _ = OFFSET.set(o);
        }
        Err(_) => eprintln!(
            "snyvi: the local time zone could not be read; dates on notes are read in UTC"
        ),
    }
}

/// The offset dates are read and said in.
pub fn offset() -> UtcOffset {
    OFFSET.get().copied().unwrap_or(UtcOffset::UTC)
}

/// What a tail needs before it to be a date.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Needs {
    /// Nothing: `tomorrow 9`, `fri 10`, `in 3 days`, `28 oct`.
    Nothing,
    /// A connector or a separator: a weekday alone, `weekend`, `next week`.
    Joined,
    /// `at` or `by`: an hour alone.
    At,
}

/// A note's text with its date taken off the end: the text left, and when.
/// `None` when the tail is not a date, is in the past, or is all there is.
pub fn split(text: &str, now: i64) -> Option<(String, i64)> {
    split_at(text, now, offset())
}

pub fn split_at(text: &str, now: i64, off: UtcOffset) -> Option<(String, i64)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let n = words.len();
    for len in (1..=TAIL_MAX.min(n)).rev() {
        let Some((at, needs)) = when(&words[n - len..], now, off) else {
            continue;
        };
        let mut head = &words[..n - len];
        let before = head.last().map(|w| w.to_lowercase()).unwrap_or_default();
        let connector = matches!(
            before.as_str(),
            "at" | "by" | "on" | "due" | "until" | "before"
        );
        // `every mon 9` is a routine's (`every`), never a date on Monday.
        if before == "every" {
            return None;
        }
        let separator = matches!(before.as_str(), "·" | "," | "-" | "—" | "|");
        let ok = match needs {
            Needs::Nothing => true,
            Needs::Joined => connector || separator || before.ends_with([',', '·', ';']),
            Needs::At => before == "at" || before == "by",
        };
        if !ok {
            return None;
        }
        if connector || separator {
            head = &head[..head.len() - 1];
        }
        let rest = head
            .join(" ")
            .trim_end_matches([',', '·', ';', '-', '—', '|', ' '])
            .to_string();
        if rest.is_empty() || at <= now {
            return None;
        }
        return Some((rest, at));
    }
    None
}

/// A date said on its own -- the chip's menu, Later…, `suggest_desk_note`'s
/// `due`: `mon 9`, `by fri`, `in 2 h`. Every form counts here, with or
/// without a `by`; `None` when it is not one or is past.
pub fn parse(words: &str, now: i64) -> Option<i64> {
    parse_at(words, now, offset())
}

pub fn parse_at(words: &str, now: i64, off: UtcOffset) -> Option<i64> {
    let mut w: Vec<&str> = words.split_whitespace().collect();
    if w.first()
        .is_some_and(|f| matches!(f.to_lowercase().as_str(), "by" | "on" | "at" | "due"))
    {
        w.remove(0);
    }
    if w.is_empty() || w.len() > TAIL_MAX {
        return None;
    }
    when(&w, now, off).map(|(at, _)| at).filter(|&at| at > now)
}

/// When a tail of words says, and what it needs before it.
fn when(tail: &[&str], now: i64, off: UtcOffset) -> Option<(i64, Needs)> {
    let t: Vec<String> = tail
        .iter()
        .map(|w| w.to_lowercase().trim_end_matches(['.', '!']).to_string())
        .collect();
    let t: Vec<&str> = t.iter().map(String::as_str).collect();
    let local = OffsetDateTime::from_unix_timestamp(now)
        .ok()?
        .to_offset(off);
    let today = local.date();
    let at = |d: Date, (h, m): (u8, u8)| -> Option<i64> {
        Some(
            PrimitiveDateTime::new(d, Time::from_hms(h, m, 0).ok()?)
                .assume_offset(off)
                .unix_timestamp(),
        )
    };
    // The next such weekday at that hour: today while the hour is ahead.
    let next = |wd: Weekday, hm: (u8, u8)| -> Option<i64> {
        let ahead = (7 + wd.number_days_from_monday() as i64
            - today.weekday().number_days_from_monday() as i64)
            % 7;
        let first = at(today.checked_add(time::Duration::days(ahead))?, hm)?;
        if first > now {
            Some(first)
        } else {
            at(today.checked_add(time::Duration::days(ahead + 7))?, hm)
        }
    };
    let day = |d: &str| -> Option<Day> {
        Some(match d {
            "today" => Day::Today,
            "tonight" => Day::Tonight,
            "tomorrow" | "tmrw" => Day::Tomorrow,
            "weekend" => Day::Week(Weekday::Saturday),
            w => Day::Week(weekday(w)?),
        })
    };
    match t.as_slice() {
        ["next", "week"] => {
            let ahead = 7 - today.weekday().number_days_from_monday() as i64;
            Some((
                at(today.checked_add(time::Duration::days(ahead))?, (9, 0))?,
                Needs::Joined,
            ))
        }
        ["in", n, unit] => Some((now + span(n, Some(*unit))?, Needs::Nothing)),
        ["in", nu] => Some((now + span(nu, None)?, Needs::Nothing)),
        [d] if day(d).is_some() => {
            let d = day(d)?;
            let needs = match d {
                Day::Week(_) => Needs::Joined,
                _ => Needs::Nothing,
            };
            let at = match d {
                Day::Today => at(today, (17, 0))?,
                Day::Tonight => at(today, (19, 0))?,
                Day::Tomorrow => at(today.next_day()?, (9, 0))?,
                Day::Week(Weekday::Saturday) if *t.first()? == "weekend" => {
                    next(Weekday::Saturday, (10, 0))?
                }
                Day::Week(wd) => next(wd, (9, 0))?,
            };
            Some((at, needs))
        }
        [d, rest @ ..] if day(d).is_some() && *d != "weekend" => {
            let mut hm = clock(rest)?;
            let at = match day(d)? {
                Day::Today => at(today, hm)?,
                Day::Tonight => {
                    if hm.0 < 12 {
                        hm.0 += 12;
                    }
                    at(today, hm)?
                }
                Day::Tomorrow => at(today.next_day()?, hm)?,
                Day::Week(wd) => next(wd, hm)?,
            };
            Some((at, Needs::Nothing))
        }
        [a, b, rest @ ..] if dated(a, b, today).is_some() => {
            let d = dated(a, b, today)?;
            let hm = if rest.is_empty() {
                (9, 0)
            } else {
                clock(rest)?
            };
            Some((at(d, hm)?, Needs::Nothing))
        }
        [iso, rest @ ..] if iso_date(iso).is_some() => {
            let hm = if rest.is_empty() {
                (9, 0)
            } else {
                clock(rest)?
            };
            Some((at(iso_date(iso)?, hm)?, Needs::Nothing))
        }
        hour => {
            let hm = clock(hour)?;
            let first = at(today, hm)?;
            let at = if first > now {
                first
            } else {
                at(today.next_day()?, hm)?
            };
            Some((at, Needs::At))
        }
    }
}

#[derive(Clone, Copy)]
enum Day {
    Today,
    Tonight,
    Tomorrow,
    Week(Weekday),
}

fn weekday(w: &str) -> Option<Weekday> {
    Some(match w {
        "mon" | "monday" => Weekday::Monday,
        "tue" | "tues" | "tuesday" => Weekday::Tuesday,
        "wed" | "wednesday" => Weekday::Wednesday,
        "thu" | "thur" | "thurs" | "thursday" => Weekday::Thursday,
        "fri" | "friday" => Weekday::Friday,
        "sat" | "saturday" => Weekday::Saturday,
        "sun" | "sunday" => Weekday::Sunday,
        _ => return None,
    })
}

fn month(w: &str) -> Option<Month> {
    const NAMES: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    const FULL: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    let i = NAMES
        .iter()
        .position(|n| *n == w)
        .or_else(|| FULL.iter().position(|n| *n == w))
        .or_else(|| (w == "sept").then_some(8))?;
    Month::try_from(i as u8 + 1).ok()
}

/// `28 oct` or `oct 28`, this year, or next once this year's has gone.
fn dated(a: &str, b: &str, today: Date) -> Option<Date> {
    let (d, m) = match (a.parse::<u8>(), b.parse::<u8>()) {
        (Ok(d), Err(_)) => (d, month(b)?),
        (Err(_), Ok(d)) => (d, month(a)?),
        _ => return None,
    };
    let this = Date::from_calendar_date(today.year(), m, d).ok()?;
    if this >= today {
        Some(this)
    } else {
        Date::from_calendar_date(today.year() + 1, m, d).ok()
    }
}

/// `2026-11-01`.
fn iso_date(w: &str) -> Option<Date> {
    let mut p = w.splitn(3, '-');
    let y: i32 = p.next()?.parse().ok()?;
    let m: u8 = p.next()?.parse().ok()?;
    let d: u8 = p.next()?.parse().ok()?;
    if !(2000..=2100).contains(&y) {
        return None;
    }
    Date::from_calendar_date(y, Month::try_from(m).ok()?, d).ok()
}

/// An hour of the day: `10`, `10:30`, `7pm`, `7:30 pm`. A plain hour is the
/// 24-hour clock's; with `am` or `pm` it is 1 to 12.
fn clock(w: &[&str]) -> Option<(u8, u8)> {
    let (num, half) = match w {
        [one] => {
            let cut = one.find(['a', 'p']).unwrap_or(one.len());
            (&one[..cut], &one[cut..])
        }
        [num, half] => (*num, *half),
        _ => return None,
    };
    let (h, m) = match num.split_once(':') {
        Some((h, m)) if m.len() == 2 => (h.parse::<u8>().ok()?, m.parse::<u8>().ok()?),
        Some(_) => return None,
        None => (num.parse::<u8>().ok()?, 0),
    };
    if m > 59 || num.is_empty() || num.len() > 5 {
        return None;
    }
    let h = match half {
        "" if h <= 23 => h,
        "am" | "a" if (1..=12).contains(&h) => h % 12,
        "pm" | "p" if (1..=12).contains(&h) => h % 12 + 12,
        _ => return None,
    };
    Some((h, m))
}

/// `3 days`, `2 h`, `90 min`, `2h`: seconds, a year at most.
fn span(n: &str, unit: Option<&str>) -> Option<i64> {
    let (num, unit) = match unit {
        Some(u) => (n, u),
        None => n.split_at(n.find(|c: char| !c.is_ascii_digit())?),
    };
    let n: i64 = num.parse().ok()?;
    let each = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86_400,
        "w" | "week" | "weeks" => 7 * 86_400,
        _ => return None,
    };
    (n > 0 && n * each <= 366 * 86_400).then_some(n * each)
}

/// When a line is due, in the reader's words, as the brief says it:
/// `today 10:00`, `tomorrow 9:00`, `Fri 10:00`, `28 Oct 9:00`, or
/// `overdue 2 d` once it has passed. The page has its own, from the same
/// `due_at`.
pub fn label(due_at: i64, now: i64) -> String {
    label_at(due_at, now, offset())
}

pub fn label_at(due_at: i64, now: i64, off: UtcOffset) -> String {
    if due_at <= now {
        let late = now - due_at;
        return match late {
            ..=3599 => "due now".into(),
            3600..=86_399 => format!("overdue {} h", late / 3600),
            _ => format!("overdue {} d", late / 86_400),
        };
    }
    let (Ok(d), Ok(n)) = (
        OffsetDateTime::from_unix_timestamp(due_at),
        OffsetDateTime::from_unix_timestamp(now),
    ) else {
        return String::new();
    };
    let (d, n) = (d.to_offset(off), n.to_offset(off));
    let hm = format!("{}:{:02}", d.hour(), d.minute());
    let days = (d.date() - n.date()).whole_days();
    match days {
        0 => format!("today {hm}"),
        1 => format!("tomorrow {hm}"),
        2..=6 => format!("{} {hm}", &format!("{:?}", d.weekday())[..3]),
        _ => format!("{} {} {hm}", d.day(), &format!("{:?}", d.month())[..3]),
    }
}

/// A line's date, set on its own -- the chip's menu, Later… -- or cleared
/// with 0. A new date clears `due_rang_at`, so the line rings once at it,
/// and a card still up for the old one is put away: the reader moved it.
pub fn set(conn: &Connection, desk_id: i64, id: i64, due_at: i64, now: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE desk_notes SET due_at = ?3, due_rang_at = 0 WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0",
        params![desk_id, id, due_at.max(0)],
    )?;
    if n > 0 {
        put_away(conn, desk_id, id, now)?;
    }
    Ok(n > 0)
}

/// Put away the card still up for a line, as a ✕ would: recoverable.
fn put_away(conn: &Connection, desk_id: i64, id: i64, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE turns SET removed_at = ?3, removed_by = 'moved' WHERE desk_id = ?1 AND note_id = ?2 AND kind = 'due'
         AND answered_at = 0 AND removed_at = 0",
        params![desk_id, id, now],
    )?)
}

/// The clock, on the restart watcher's half-minute tick: every open line on
/// an open desk whose time has come and that has not rung raises one card,
/// by snyvi, on no panel. A daemon that was off at the hour rings at its
/// next tick, and the card says when it was due. Cards whose line has since
/// been ticked or put away go too. The desks that changed.
pub fn ring(conn: &Connection, now: i64) -> Result<Vec<i64>> {
    let mut desks: Vec<i64> = Vec::new();
    let mut st = conn.prepare(
        "SELECT n.id, n.desk_id, n.text, n.doc FROM desk_notes n JOIN desks d ON d.id = n.desk_id
         WHERE n.due_at > 0 AND n.due_at <= ?1 AND n.due_rang_at = 0 AND n.done_at = 0
           AND n.removed_at = 0 AND n.suggested_by = '' AND d.closed_at = 0
         ORDER BY n.due_at, n.id LIMIT 24",
    )?;
    let due: Vec<(i64, i64, String, String)> = st
        .query_map(params![now], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    // The card carries the line's document as its link (1.54): the corner
    // draws Open and Copy from it.
    for (id, desk, text, doc) in due {
        conn.execute(
            "INSERT INTO turns(desk_id, by, kind, via, text, created_at, note_id, link)
             VALUES(?1, 'snyvi', ?2, 'clock', ?3, ?4, ?5, ?6)",
            params![desk, KIND, text, now, id, doc],
        )?;
        conn.execute(
            "UPDATE desk_notes SET due_rang_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        desks.push(desk);
    }
    let settled: Vec<i64> = conn
        .prepare(
            "SELECT DISTINCT t.desk_id FROM turns t JOIN desk_notes n ON n.id = t.note_id
             WHERE t.kind = 'due' AND t.answered_at = 0 AND t.removed_at = 0
               AND (n.done_at != 0 OR n.removed_at != 0)",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !settled.is_empty() {
        conn.execute(
            "UPDATE turns SET removed_at = ?1, removed_by = 'settled' WHERE kind = 'due' AND answered_at = 0 AND removed_at = 0
             AND note_id IN (SELECT id FROM desk_notes WHERE done_at != 0 OR removed_at != 0)",
            params![now],
        )?;
    }
    desks.extend(settled);
    desks.sort_unstable();
    desks.dedup();
    Ok(desks)
}

/// The reader answers a due card: Done ticks its line, theirs; a date moves
/// it there (`Later: Mon 9:00`, said to the next panel that prompts). Either
/// way the card is answered. `None` when it is no due card, was answered,
/// or the date is not one.
pub fn answer(
    conn: &Connection,
    desk_id: i64,
    turn: &crate::thread::Turn,
    later: Option<&str>,
    now: i64,
) -> Result<Option<crate::thread::Turn>> {
    let note: i64 = conn
        .query_row(
            "SELECT note_id FROM turns WHERE desk_id = ?1 AND id = ?2",
            params![desk_id, turn.id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if turn.kind != KIND || note == 0 {
        return Ok(None);
    }
    let said = match later {
        Some(words) => {
            let Some(at) = parse(words, now) else {
                return Ok(None);
            };
            conn.execute(
                "UPDATE desk_notes SET due_at = ?3, due_rang_at = 0 WHERE desk_id = ?1 AND id = ?2",
                params![desk_id, note, at],
            )?;
            format!("Later: {}", label(at, now))
        }
        None => {
            crate::desk::set_note(conn, desk_id, note, None, Some(true), now)?;
            "Done".to_string()
        }
    };
    crate::thread::answer(conn, desk_id, turn.id, &said, "snyvi", now)
}

/// A line that is due, for Home: across desks, the overdue and today's.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DueLine {
    pub desk: i64,
    pub id: i64,
    pub text: String,
    pub due_at: i64,
}

/// The open lines due by `until` (the end of the reader's day), on open
/// desks not parked, the soonest first: Home's Due list and its count.
pub fn due_by(conn: &Connection, until: i64) -> Result<Vec<DueLine>> {
    let mut st = conn.prepare(
        "SELECT n.desk_id, n.id, n.text, n.due_at FROM desk_notes n JOIN desks d ON d.id = n.desk_id
         WHERE n.due_at > 0 AND n.due_at <= ?1 AND n.done_at = 0 AND n.removed_at = 0
           AND n.suggested_by = '' AND d.closed_at = 0 AND d.parked_at = 0
         ORDER BY n.due_at, n.id LIMIT 12",
    )?;
    let rows = st
        .query_map(params![until], |r| {
            Ok(DueLine {
                desk: r.get(0)?,
                id: r.get(1)?,
                text: r.get(2)?,
                due_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The end of the reader's day that `now` is in: what "due today" counts to.
pub fn end_of_day(now: i64) -> i64 {
    let off = offset();
    OffsetDateTime::from_unix_timestamp(now)
        .ok()
        .and_then(|t| {
            let d = t.to_offset(off).date().next_day()?;
            Some(
                PrimitiveDateTime::new(d, Time::MIDNIGHT)
                    .assume_offset(off)
                    .unix_timestamp()
                    - 1,
            )
        })
        .unwrap_or(now)
}

pub mod every;

#[cfg(test)]
mod tests;
