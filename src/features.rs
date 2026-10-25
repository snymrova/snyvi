//! What a reader can do now that they couldn't before (#191): `features.toml`,
//! compiled in and read once, and the pictures its entries name.
//!
//! One list feeds every place a new thing is told: the What's new page an
//! update files (`crate::whats_new`), the dot on a new control and Show me →
//! (ui/guide.js, through `/api/guide`), the line a panel's Claude hears
//! (`crate::brief`), and the release's notes (scripts/notes.mjs reads the
//! same file). A feature told in four places by four hands drifts; told once
//! here, it cannot.
//!
//! The file is checked by a test, not at a reader's start: an entry with a
//! key nobody reads, a picture that is not compiled in, or a version newer
//! than this build fails `cargo test`, so a broken list never ships. A list
//! that somehow fails to read is no list -- nothing is told, nothing breaks.

use semver::Version;
use std::sync::OnceLock;

#[derive(Debug, PartialEq)]
pub struct Feature {
    pub id: String,
    pub since: Version,
    pub title: String,
    pub line: String,
    /// A picture in docs/features/, one of `STILLS`.
    pub still: Option<String>,
    /// Where it is: a view ("desk", "doc", "home") and a selector in it.
    pub show: Option<String>,
    /// One line under "Smaller things", with no heading of its own.
    pub small: bool,
}

const SOURCE: &str = include_str!("../features.toml");

/// The pictures the entries name, compiled in: an update's page is written
/// from the binary, with no network. Tens of kilobytes each, at the reading
/// column's width. When this list holds more than the last ten releases'
/// worth, the oldest go: their entries keep their words.
pub const STILLS: &[(&str, &[u8])] = &[
    ("dates.png", include_bytes!("../docs/features/dates.png")),
    ("inback.png", include_bytes!("../docs/features/inback.png")),
    (
        "routines.png",
        include_bytes!("../docs/features/routines.png"),
    ),
];

const KEYS: [&str; 7] = ["id", "since", "title", "line", "still", "show", "small"];
const VIEWS: [&str; 3] = ["desk", "doc", "home"];

/// Every entry, newest first.
pub fn all() -> &'static [Feature] {
    static ALL: OnceLock<Vec<Feature>> = OnceLock::new();
    ALL.get_or_init(|| parse(SOURCE).unwrap_or_default())
}

pub fn still(name: &str) -> Option<&'static [u8]> {
    STILLS.iter().find(|(n, _)| *n == name).map(|(_, b)| *b)
}

/// The entries a reader on `from` has not been told, up to `to`: newer than
/// `from`, no newer than `to`. With no `from` -- a library from before snyvi
/// kept count -- the newest `FALLBACK` releases' worth.
pub fn between(from: Option<&Version>, to: &Version) -> Vec<&'static Feature> {
    let upto = all().iter().filter(|f| f.since <= *to);
    match from {
        Some(from) => upto.filter(|f| f.since > *from).collect(),
        None => {
            let mut versions: Vec<&Version> = Vec::new();
            upto.filter(|f| {
                if !versions.contains(&&f.since) {
                    versions.push(&f.since);
                }
                versions.len() <= FALLBACK
            })
            .collect()
        }
    }
}

/// How many releases a reader with no count is told about.
pub const FALLBACK: usize = 4;

/// The entries the page can point at, for `/api/guide`: what ui/guide.js
/// needs for Show me → and the dot, and nothing else.
pub fn shown_json() -> serde_json::Value {
    all()
        .iter()
        .filter_map(|f| {
            let show = f.show.as_deref()?;
            let (view, sel) = show.split_once(' ')?;
            Some(serde_json::json!({
                "id": f.id,
                "since": f.since.to_string(),
                "title": f.title,
                "view": view,
                "sel": sel,
            }))
        })
        .collect()
}

/// A version as a reader says it: 1.50, not 1.50.0; 1.46.2 as it is.
pub fn short(v: &Version) -> String {
    if v.patch == 0 {
        format!("{}.{}", v.major, v.minor)
    } else {
        v.to_string()
    }
}

/// The file, read and checked. Every refusal names the entry and the key.
pub fn parse(text: &str) -> Result<Vec<Feature>, String> {
    let doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| e.to_string())?;
    let tables = doc
        .get("feature")
        .and_then(|f| f.as_array_of_tables())
        .ok_or("no [[feature]] entries")?;
    let mut out: Vec<Feature> = Vec::new();
    for (i, t) in tables.iter().enumerate() {
        let at = |k: &str| format!("entry {} ({k})", i + 1);
        if let Some((k, _)) = t.iter().find(|(k, _)| !KEYS.contains(k)) {
            return Err(format!("{}: not a key features.toml has", at(k)));
        }
        let get = |k: &str| -> Result<Option<String>, String> {
            match t.get(k) {
                None => Ok(None),
                Some(v) => v
                    .as_str()
                    .map(|s| Some(s.trim().to_string()))
                    .ok_or_else(|| format!("{}: not a string", at(k))),
            }
        };
        let need = |k: &str| -> Result<String, String> {
            get(k)?
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{}: missing", at(k)))
        };
        let id = need("id")?;
        let since = Version::parse(&need("since")?).map_err(|e| format!("{}: {e}", at("since")))?;
        let show = get("show")?;
        if let Some(s) = &show {
            match s.split_once(' ') {
                Some((view, sel)) if VIEWS.contains(&view) && !sel.trim().is_empty() => {}
                _ => return Err(format!("{}: \"desk|doc|home selector\"", at("show"))),
            }
        }
        let small = match get("small")?.as_deref() {
            None => false,
            Some("yes") => true,
            Some(_) => return Err(format!("{}: \"yes\" or left out", at("small"))),
        };
        if out.iter().any(|f| f.id == id) {
            return Err(format!("{}: {id} twice", at("id")));
        }
        if out.last().is_some_and(|f| f.since < since) {
            return Err(format!("{}: newest first", at("since")));
        }
        out.push(Feature {
            id,
            since,
            title: need("title")?,
            line: need("line")?,
            still: get("still")?,
            show,
            small,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_reads_and_its_pictures_are_compiled_in() {
        let list = parse(SOURCE).expect("features.toml");
        assert_eq!(list.len(), all().len());
        let running = Version::parse(crate::version::VERSION).unwrap();
        for f in &list {
            assert!(f.since <= running, "{} is newer than this build", f.id);
            if let Some(s) = &f.still {
                assert!(still(s).is_some(), "{} names {s}, which STILLS lacks", f.id);
            }
        }
        for (name, _) in STILLS {
            assert!(
                list.iter().any(|f| f.still.as_deref() == Some(*name)),
                "{name} is compiled in and no entry shows it"
            );
        }
    }

    #[test]
    fn a_bad_entry_is_refused_by_name() {
        let one = |extra: &str| {
            format!("[[feature]]\nid = \"a\"\nsince = \"1.2.0\"\ntitle = \"A\"\nline = \"It does a.\"\n{extra}")
        };
        assert!(parse(&one("")).is_ok());
        assert!(parse(&one("colour = \"red\"\n"))
            .unwrap_err()
            .contains("colour"));
        assert!(parse(&one("show = \"window .x\"\n"))
            .unwrap_err()
            .contains("show"));
        assert!(parse(&one("small = \"true\"\n"))
            .unwrap_err()
            .contains("small"));
        let twice = format!("{}{}", one(""), one(""));
        assert!(parse(&twice).unwrap_err().contains("twice"));
        let older_first = "[[feature]]\nid = \"a\"\nsince = \"1.1.0\"\ntitle = \"A\"\nline = \"a\"\n\
                           [[feature]]\nid = \"b\"\nsince = \"1.2.0\"\ntitle = \"B\"\nline = \"b\"\n";
        assert!(parse(older_first).unwrap_err().contains("newest first"));
    }

    #[test]
    fn between_takes_what_is_newer_than_the_reader_had() {
        let v = |s| Version::parse(s).unwrap();
        let to = v("1.50.0");
        let got: Vec<&str> = between(Some(&v("1.48.0")), &to)
            .iter()
            .map(|f| f.id.as_str())
            .collect();
        assert!(got.contains(&"routines") && got.contains(&"in-back"));
        assert!(!got.contains(&"pdf") && !got.contains(&"whats-new"));
        assert!(between(Some(&to), &to).is_empty());
        // No count kept: the newest few releases, never one past `to`.
        let fall = between(None, &to);
        let mut versions: Vec<&Version> = fall.iter().map(|f| &f.since).collect();
        versions.dedup();
        assert!(versions.len() <= FALLBACK && versions[0] == &to);
    }

    #[test]
    fn short_drops_a_zero_patch() {
        assert_eq!(short(&Version::parse("1.50.0").unwrap()), "1.50");
        assert_eq!(short(&Version::parse("1.46.2").unwrap()), "1.46.2");
    }
}
