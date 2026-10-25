//! A line that comes back (1.50, routines): `newsroom · every day 07:30`.
//! The tail is read here, beside the dates it borrows its words from, and
//! only by the routines' own door (`crate::routine::from_line`): a note's
//! date never reads `every`, and a routine's hour is changed in its sheet,
//! never by the chip's menu.
//!
//! The forms, each with an hour or 09:00 without one: `every day`, `daily`,
//! `every weekday`, `weekdays`, `every mon`, `every 1st` (to the 28th, so
//! every month has one). `at` before the hour is allowed and dropped.

use super::{clock, weekday};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset, Weekday};

/// Which days a routine runs on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cadence {
    Daily,
    Weekdays,
    Weekly(Weekday),
    /// The day of the month, 1 to 28.
    Monthly(u8),
}

/// The days and the hour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Every {
    pub cadence: Cadence,
    pub at: (u8, u8),
}

/// The most words a tail is read over: `every day at 7:30 pm`.
const TAIL_MAX: usize = 5;

/// The words alone, `every day 07:30`: what the sheet's When field holds.
pub fn every(words: &str) -> Option<Every> {
    let t: Vec<String> = words
        .split_whitespace()
        .map(|w| w.to_lowercase().trim_end_matches(['.', '!']).to_string())
        .collect();
    let t: Vec<&str> = t.iter().map(String::as_str).collect();
    let (cadence, rest) = match t.as_slice() {
        ["daily", rest @ ..] => (Cadence::Daily, rest),
        ["weekdays", rest @ ..] => (Cadence::Weekdays, rest),
        ["every", "day", rest @ ..] => (Cadence::Daily, rest),
        ["every", "weekday", rest @ ..] => (Cadence::Weekdays, rest),
        ["every", w, rest @ ..] => match weekday(w) {
            Some(wd) => (Cadence::Weekly(wd), rest),
            None => (Cadence::Monthly(ordinal(w)?), rest),
        },
        _ => return None,
    };
    let rest = match rest {
        ["at", rest @ ..] => rest,
        rest => rest,
    };
    let at = if rest.is_empty() {
        (9, 0)
    } else {
        clock(rest)?
    };
    Some(Every { cadence, at })
}

/// `1st`, `2nd`, `3rd`, `4th` … `28th`.
fn ordinal(w: &str) -> Option<u8> {
    let cut = w.find(|c: char| !c.is_ascii_digit())?;
    let (n, suffix) = w.split_at(cut);
    let d: u8 = n.parse().ok()?;
    ((1..=28).contains(&d) && suffix == suffix_of(d)).then_some(d)
}

fn suffix_of(d: u8) -> &'static str {
    match d {
        1 | 21 => "st",
        2 | 22 => "nd",
        3 | 23 => "rd",
        _ => "th",
    }
}

/// A line with a cadence at its end: the words before it, and the cadence.
/// `None` when the tail is not one or is all there is.
pub fn every_tail(text: &str) -> Option<(String, Every)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let n = words.len();
    let first = n.saturating_sub(TAIL_MAX);
    let start = (first..n).find(|&i| {
        matches!(
            words[i].to_lowercase().as_str(),
            "every" | "daily" | "weekdays"
        )
    })?;
    let e = every(&words[start..].join(" "))?;
    let mut head = &words[..start];
    if head
        .last()
        .is_some_and(|w| matches!(*w, "·" | "," | "-" | "—" | "|"))
    {
        head = &head[..head.len() - 1];
    }
    let rest = head
        .join(" ")
        .trim_end_matches([',', '·', ';', '-', '—', '|', ' '])
        .to_string();
    (!rest.is_empty()).then_some((rest, e))
}

impl Every {
    /// The next hour after `now` on one of its days.
    pub fn next_after(&self, now: i64, off: UtcOffset) -> i64 {
        let Ok(local) = OffsetDateTime::from_unix_timestamp(now) else {
            return now + 86_400;
        };
        let today = local.to_offset(off).date();
        let Ok(hm) = Time::from_hms(self.at.0, self.at.1, 0) else {
            return now + 86_400;
        };
        let mut d: Date = today;
        for _ in 0..62 {
            if self.on(d) {
                let t = PrimitiveDateTime::new(d, hm)
                    .assume_offset(off)
                    .unix_timestamp();
                if t > now {
                    return t;
                }
            }
            match d.next_day() {
                Some(n) => d = n,
                None => break,
            }
        }
        now + 86_400
    }

    fn on(&self, d: Date) -> bool {
        match self.cadence {
            Cadence::Daily => true,
            Cadence::Weekdays => !matches!(d.weekday(), Weekday::Saturday | Weekday::Sunday),
            Cadence::Weekly(wd) => d.weekday() == wd,
            Cadence::Monthly(n) => d.day() == n,
        }
    }

    /// Said back the one way, whatever was typed: `every day 07:30`.
    pub fn words(&self) -> String {
        let hm = format!("{:02}:{:02}", self.at.0, self.at.1);
        match self.cadence {
            Cadence::Daily => format!("every day {hm}"),
            Cadence::Weekdays => format!("every weekday {hm}"),
            Cadence::Weekly(wd) => {
                format!("every {} {hm}", format!("{wd:?}")[..3].to_lowercase())
            }
            Cadence::Monthly(n) => format!("every {n}{} {hm}", suffix_of(n)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Month;

    fn ist() -> UtcOffset {
        UtcOffset::from_hms(5, 30, 0).unwrap()
    }

    fn at(y: i32, m: u8, d: u8, h: u8, min: u8) -> i64 {
        PrimitiveDateTime::new(
            Date::from_calendar_date(y, Month::try_from(m).unwrap(), d).unwrap(),
            Time::from_hms(h, min, 0).unwrap(),
        )
        .assume_offset(ist())
        .unix_timestamp()
    }

    #[test]
    fn the_forms_read_and_say_themselves_back_one_way() {
        let cases = [
            ("every day 07:30", "every day 07:30"),
            ("daily 7:30", "every day 07:30"),
            ("every day at 7pm", "every day 19:00"),
            ("every weekday 9", "every weekday 09:00"),
            ("weekdays", "every weekday 09:00"),
            ("every mon 09:00", "every mon 09:00"),
            ("every Friday 18:30", "every fri 18:30"),
            ("every 1st", "every 1st 09:00"),
            ("every 22nd 10", "every 22nd 10:00"),
            ("every 3rd at 8:15 am", "every 3rd 08:15"),
        ];
        for (typed, said) in cases {
            let e = every(typed).unwrap_or_else(|| panic!("{typed}"));
            assert_eq!(e.words(), said, "{typed}");
        }
        for not in [
            "every",
            "every time the build fails",
            "every 31st",
            "every 2st",
            "every day 25:00",
            "each day",
            "every other mon",
        ] {
            assert_eq!(every(not), None, "{not}");
        }
    }

    #[test]
    fn the_tail_comes_off_a_line_and_the_rest_is_its_name() {
        let (name, e) = every_tail("newsroom · every day 07:30").unwrap();
        assert_eq!(
            (name.as_str(), e.words().as_str()),
            ("newsroom", "every day 07:30")
        );
        let (name, e) = every_tail("/bench main, every weekday at 9").unwrap();
        assert_eq!(
            (name.as_str(), e.words().as_str()),
            ("/bench main", "every weekday 09:00")
        );
        assert_eq!(
            every_tail("every day 07:30"),
            None,
            "a tail and nothing else"
        );
        assert_eq!(every_tail("rerun every time the build fails"), None);
        assert_eq!(every_tail("post the note by fri 10"), None);
    }

    #[test]
    fn the_next_hour_is_before_at_or_after_todays() {
        // Saturday 24 October 2026.
        let e = every("every day 07:30").unwrap();
        assert_eq!(
            e.next_after(at(2026, 10, 24, 6, 0), ist()),
            at(2026, 10, 24, 7, 30)
        );
        assert_eq!(
            e.next_after(at(2026, 10, 24, 7, 30), ist()),
            at(2026, 10, 25, 7, 30)
        );
        assert_eq!(
            e.next_after(at(2026, 10, 24, 21, 0), ist()),
            at(2026, 10, 25, 7, 30)
        );
        // A weekend is stepped over.
        let w = every("every weekday 9").unwrap();
        assert_eq!(
            w.next_after(at(2026, 10, 24, 6, 0), ist()),
            at(2026, 10, 26, 9, 0)
        );
        assert_eq!(
            w.next_after(at(2026, 10, 26, 8, 0), ist()),
            at(2026, 10, 26, 9, 0)
        );
        let m = every("every mon 09:00").unwrap();
        assert_eq!(
            m.next_after(at(2026, 10, 26, 9, 0), ist()),
            at(2026, 11, 2, 9, 0)
        );
        // The month's end, and the year's.
        let f = every("every 1st").unwrap();
        assert_eq!(
            f.next_after(at(2026, 10, 24, 6, 0), ist()),
            at(2026, 11, 1, 9, 0)
        );
        assert_eq!(
            f.next_after(at(2026, 12, 1, 9, 0), ist()),
            at(2027, 1, 1, 9, 0)
        );
        let late = every("every 28th 23:59").unwrap();
        assert_eq!(
            late.next_after(at(2027, 2, 28, 23, 59), ist()),
            at(2027, 3, 28, 23, 59)
        );
    }
}
