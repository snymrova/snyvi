//! Clusters: a character and what joins it -- a vowel sign, an accent, an
//! emoji's skin tone, the rest of a family joined by ZWJ -- kept in one cell,
//! the way the program that wrote them counts them.
//!
//! Claude Code moves its cursor by relative steps and trusts that the
//! terminal agrees on where each character ended. It counts a cluster as its
//! first character's width. A Devanagari spacing vowel sign (ि ा ी) is a
//! column of its own to `unicode-width`, and 👍🏽 is four. Every such sign put
//! the screen a column ahead of Claude Code, a table row with Hindi in it
//! wrapped where Claude Code's did not, and its next redraw landed a row off:
//! lines twice, rules between words.
//!
//! The rule is the one Claude Code was measured to follow, not the newest
//! Unicode one: what joins the cell before it is a mark of any kind, a joiner
//! or a variation selector, an emoji modifier, and a pictograph after a ZWJ.
//! A consonant after a virama does not (ज़्यादा is three clusters), which is
//! what Unicode 15.1 changed and Claude Code has not.
//!
//! A `Cell` holds one `char`, and stays sixteen-odd bytes for the plain text
//! that is nearly all of a screen. A cluster's cell holds a handle instead: a
//! character from Supplementary Private Use Area-B that names the cluster's
//! text in a table shared by every pane. A program that prints one of those
//! characters itself gets it back as a cluster of one, so none is mistaken.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use unicode_width::UnicodeWidthChar;

/// U+100000 to U+10FFFD.
const FIRST: u32 = 0x10_0000;
const ROOM: usize = 0xfffe;
/// A cell past this many bytes takes nothing more: a run of fifty accents on
/// one letter is a stunt, and each would be a new entry in the table.
const MOST_BYTES: usize = 32;

#[derive(Default)]
struct Table {
    by_text: HashMap<Box<str>, char>,
    text: Vec<Box<str>>,
}

fn table() -> &'static Mutex<Table> {
    static T: OnceLock<Mutex<Table>> = OnceLock::new();
    T.get_or_init(Mutex::default)
}

pub fn is_handle(c: char) -> bool {
    (FIRST..FIRST + ROOM as u32).contains(&u32::from(c))
}

/// The handle for a cluster's text, or nothing once the table is full -- a
/// daemon that has seen sixty-five thousand different clusters drops marks
/// from then on, as it did before there were clusters.
pub fn intern(s: &str) -> Option<char> {
    let mut t = table().lock().unwrap();
    if let Some(&c) = t.by_text.get(s) {
        return Some(c);
    }
    if t.text.len() >= ROOM {
        return None;
    }
    let c = char::from_u32(FIRST + t.text.len() as u32)?;
    t.text.push(s.into());
    t.by_text.insert(s.into(), c);
    Some(c)
}

/// A cell's character as text: itself, or the cluster its handle names.
pub fn push(out: &mut String, c: char) {
    if is_handle(c) {
        let t = table().lock().unwrap();
        if let Some(s) = t.text.get((u32::from(c) - FIRST) as usize) {
            out.push_str(s);
            return;
        }
    }
    out.push(c);
}

pub fn text(c: char) -> String {
    let mut s = String::new();
    push(&mut s, c);
    s
}

/// `c` is printed straight after the cell holding `prev`: the cell's
/// character with `c` joined on, or nothing when `c` starts a cell of its
/// own. `Some(None)`: it joins, but there is no room for it, so it is
/// dropped, as every mark was before.
pub fn join(prev: char, c: char) -> Option<Option<char>> {
    let mut s = text(prev);
    let last = s.chars().next_back()?;
    let joins = c.width() == Some(0)
        || spacing_mark(c)
        || ('\u{1f3fb}'..='\u{1f3ff}').contains(&c)
        || (last == '\u{200d}' && pictograph(c) && s.chars().next().is_some_and(pictograph));
    if !joins {
        return None;
    }
    if s.len() + c.len_utf8() > MOST_BYTES {
        return Some(None);
    }
    s.push(c);
    Some(intern(&s))
}

/// A character a program printed, as a cell holds it: a handle a program
/// sent itself becomes a cluster of one.
pub fn own(c: char) -> char {
    if is_handle(c) {
        intern(c.encode_utf8(&mut [0; 4])).unwrap_or('\u{fffd}')
    } else {
        c
    }
}

/// Close enough to Extended_Pictographic for a ZWJ sequence: the emoji blocks.
fn pictograph(c: char) -> bool {
    matches!(c, '\u{2600}'..='\u{27bf}' | '\u{2b00}'..='\u{2bff}' | '\u{1f000}'..='\u{1faff}')
}

/// General category Mc, Unicode 15.1: the spacing vowel signs of Indic
/// scripts, mostly. `unicode-width` gives them a column; a cluster does not.
fn spacing_mark(c: char) -> bool {
    if c < '\u{0900}' {
        return false;
    }
    SPACING_MARKS
        .binary_search_by(|&(a, b)| {
            if c < a {
                std::cmp::Ordering::Greater
            } else if c > b {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

#[rustfmt::skip]
const SPACING_MARKS: &[(char, char)] = &[
    ('\u{0903}', '\u{0903}'), ('\u{093b}', '\u{093b}'), ('\u{093e}', '\u{0940}'),
    ('\u{0949}', '\u{094c}'), ('\u{094e}', '\u{094f}'), ('\u{0982}', '\u{0983}'),
    ('\u{09be}', '\u{09c0}'), ('\u{09c7}', '\u{09c8}'), ('\u{09cb}', '\u{09cc}'),
    ('\u{09d7}', '\u{09d7}'), ('\u{0a03}', '\u{0a03}'), ('\u{0a3e}', '\u{0a40}'),
    ('\u{0a83}', '\u{0a83}'), ('\u{0abe}', '\u{0ac0}'), ('\u{0ac9}', '\u{0ac9}'),
    ('\u{0acb}', '\u{0acc}'), ('\u{0b02}', '\u{0b03}'), ('\u{0b3e}', '\u{0b3e}'),
    ('\u{0b40}', '\u{0b40}'), ('\u{0b47}', '\u{0b48}'), ('\u{0b4b}', '\u{0b4c}'),
    ('\u{0b57}', '\u{0b57}'), ('\u{0bbe}', '\u{0bbf}'), ('\u{0bc1}', '\u{0bc2}'),
    ('\u{0bc6}', '\u{0bc8}'), ('\u{0bca}', '\u{0bcc}'), ('\u{0bd7}', '\u{0bd7}'),
    ('\u{0c01}', '\u{0c03}'), ('\u{0c41}', '\u{0c44}'), ('\u{0c82}', '\u{0c83}'),
    ('\u{0cbe}', '\u{0cbe}'), ('\u{0cc0}', '\u{0cc4}'), ('\u{0cc7}', '\u{0cc8}'),
    ('\u{0cca}', '\u{0ccb}'), ('\u{0cd5}', '\u{0cd6}'), ('\u{0cf3}', '\u{0cf3}'),
    ('\u{0d02}', '\u{0d03}'), ('\u{0d3e}', '\u{0d40}'), ('\u{0d46}', '\u{0d48}'),
    ('\u{0d4a}', '\u{0d4c}'), ('\u{0d57}', '\u{0d57}'), ('\u{0d82}', '\u{0d83}'),
    ('\u{0dcf}', '\u{0dd1}'), ('\u{0dd8}', '\u{0ddf}'), ('\u{0df2}', '\u{0df3}'),
    ('\u{0f3e}', '\u{0f3f}'), ('\u{0f7f}', '\u{0f7f}'), ('\u{102b}', '\u{102c}'),
    ('\u{1031}', '\u{1031}'), ('\u{1038}', '\u{1038}'), ('\u{103b}', '\u{103c}'),
    ('\u{1056}', '\u{1057}'), ('\u{1062}', '\u{1064}'), ('\u{1067}', '\u{106d}'),
    ('\u{1083}', '\u{1084}'), ('\u{1087}', '\u{108c}'), ('\u{108f}', '\u{108f}'),
    ('\u{109a}', '\u{109c}'), ('\u{1715}', '\u{1715}'), ('\u{1734}', '\u{1734}'),
    ('\u{17b6}', '\u{17b6}'), ('\u{17be}', '\u{17c5}'), ('\u{17c7}', '\u{17c8}'),
    ('\u{1923}', '\u{1926}'), ('\u{1929}', '\u{192b}'), ('\u{1930}', '\u{1931}'),
    ('\u{1933}', '\u{1938}'), ('\u{1a19}', '\u{1a1a}'), ('\u{1a55}', '\u{1a55}'),
    ('\u{1a57}', '\u{1a57}'), ('\u{1a61}', '\u{1a61}'), ('\u{1a63}', '\u{1a64}'),
    ('\u{1a6d}', '\u{1a72}'), ('\u{1b04}', '\u{1b04}'), ('\u{1b35}', '\u{1b35}'),
    ('\u{1b3b}', '\u{1b3b}'), ('\u{1b3d}', '\u{1b41}'), ('\u{1b43}', '\u{1b44}'),
    ('\u{1b82}', '\u{1b82}'), ('\u{1ba1}', '\u{1ba1}'), ('\u{1ba6}', '\u{1ba7}'),
    ('\u{1baa}', '\u{1baa}'), ('\u{1be7}', '\u{1be7}'), ('\u{1bea}', '\u{1bec}'),
    ('\u{1bee}', '\u{1bee}'), ('\u{1bf2}', '\u{1bf3}'), ('\u{1c24}', '\u{1c2b}'),
    ('\u{1c34}', '\u{1c35}'), ('\u{1ce1}', '\u{1ce1}'), ('\u{1cf7}', '\u{1cf7}'),
    ('\u{302e}', '\u{302f}'), ('\u{a823}', '\u{a824}'), ('\u{a827}', '\u{a827}'),
    ('\u{a880}', '\u{a881}'), ('\u{a8b4}', '\u{a8c3}'), ('\u{a952}', '\u{a953}'),
    ('\u{a983}', '\u{a983}'), ('\u{a9b4}', '\u{a9b5}'), ('\u{a9ba}', '\u{a9bb}'),
    ('\u{a9be}', '\u{a9c0}'), ('\u{aa2f}', '\u{aa30}'), ('\u{aa33}', '\u{aa34}'),
    ('\u{aa4d}', '\u{aa4d}'), ('\u{aa7b}', '\u{aa7b}'), ('\u{aa7d}', '\u{aa7d}'),
    ('\u{aaeb}', '\u{aaeb}'), ('\u{aaee}', '\u{aaef}'), ('\u{aaf5}', '\u{aaf5}'),
    ('\u{abe3}', '\u{abe4}'), ('\u{abe6}', '\u{abe7}'), ('\u{abe9}', '\u{abea}'),
    ('\u{abec}', '\u{abec}'), ('\u{11000}', '\u{11000}'), ('\u{11002}', '\u{11002}'),
    ('\u{11082}', '\u{11082}'), ('\u{110b0}', '\u{110b2}'), ('\u{110b7}', '\u{110b8}'),
    ('\u{1112c}', '\u{1112c}'), ('\u{11145}', '\u{11146}'), ('\u{11182}', '\u{11182}'),
    ('\u{111b3}', '\u{111b5}'), ('\u{111bf}', '\u{111c0}'), ('\u{111ce}', '\u{111ce}'),
    ('\u{1122c}', '\u{1122e}'), ('\u{11232}', '\u{11233}'), ('\u{11235}', '\u{11235}'),
    ('\u{112e0}', '\u{112e2}'), ('\u{11302}', '\u{11303}'), ('\u{1133e}', '\u{1133f}'),
    ('\u{11341}', '\u{11344}'), ('\u{11347}', '\u{11348}'), ('\u{1134b}', '\u{1134d}'),
    ('\u{11357}', '\u{11357}'), ('\u{11362}', '\u{11363}'), ('\u{11435}', '\u{11437}'),
    ('\u{11440}', '\u{11441}'), ('\u{11445}', '\u{11445}'), ('\u{114b0}', '\u{114b2}'),
    ('\u{114b9}', '\u{114b9}'), ('\u{114bb}', '\u{114be}'), ('\u{114c1}', '\u{114c1}'),
    ('\u{115af}', '\u{115b1}'), ('\u{115b8}', '\u{115bb}'), ('\u{115be}', '\u{115be}'),
    ('\u{11630}', '\u{11632}'), ('\u{1163b}', '\u{1163c}'), ('\u{1163e}', '\u{1163e}'),
    ('\u{116ac}', '\u{116ac}'), ('\u{116ae}', '\u{116af}'), ('\u{116b6}', '\u{116b6}'),
    ('\u{11720}', '\u{11721}'), ('\u{11726}', '\u{11726}'), ('\u{1182c}', '\u{1182e}'),
    ('\u{11838}', '\u{11838}'), ('\u{11930}', '\u{11935}'), ('\u{11937}', '\u{11938}'),
    ('\u{1193d}', '\u{1193d}'), ('\u{11940}', '\u{11940}'), ('\u{11942}', '\u{11942}'),
    ('\u{119d1}', '\u{119d3}'), ('\u{119dc}', '\u{119df}'), ('\u{119e4}', '\u{119e4}'),
    ('\u{11a39}', '\u{11a39}'), ('\u{11a57}', '\u{11a58}'), ('\u{11a97}', '\u{11a97}'),
    ('\u{11c2f}', '\u{11c2f}'), ('\u{11c3e}', '\u{11c3e}'), ('\u{11ca9}', '\u{11ca9}'),
    ('\u{11cb1}', '\u{11cb1}'), ('\u{11cb4}', '\u{11cb4}'), ('\u{11d8a}', '\u{11d8e}'),
    ('\u{11d93}', '\u{11d94}'), ('\u{11d96}', '\u{11d96}'), ('\u{11ef5}', '\u{11ef6}'),
    ('\u{11f03}', '\u{11f03}'), ('\u{11f34}', '\u{11f35}'), ('\u{11f3e}', '\u{11f3f}'),
    ('\u{11f41}', '\u{11f41}'), ('\u{16f51}', '\u{16f87}'), ('\u{16ff0}', '\u{16ff1}'),
    ('\u{1d165}', '\u{1d166}'), ('\u{1d16d}', '\u{1d172}'),
];
