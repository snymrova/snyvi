//! What's new, after an update (#191).
//!
//! An update used to say "Updated to 1.51" and point at GitHub's list of pull
//! requests, which tells a maker nothing about what they can now do. Now the
//! daemon that comes up on a newer version than this library was last told
//! about writes one page -- every entry in `features.toml` since that
//! version, newest first, each with its picture and Show me → -- and files
//! it like any document, in a project of its own named snyvi. The next
//! update's page is a new version of the same document, so the sidebar keeps
//! one row and its versions are the releases.
//!
//! What it knows is kept in `whats-new/state.json` in the data folder: the
//! newest version told, and the last page (when, which document, how many
//! entries, their titles) for the toast, the dots and a panel's brief.
//!
//!   - A library with nothing in it is a fresh install: Welcome tells it
//!     everything, so the version is noted and no page is written.
//!   - A version at or below the one told -- a restart, or a step back with
//!     `snyvi update --back` -- writes nothing, and never lowers the count.
//!   - A library from before this count began is told from the version its
//!     last in-app update landed (the updater's `applied`, read before this
//!     start's apply replaces it), or else the newest few releases.

use crate::features::{self, Feature};
use anyhow::{Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long the toast, the brief and the dots go on about a page: the brief
/// for a week, the dots for two (`DOTS_SECS`, which the page reads).
pub const BRIEF_SECS: i64 = 7 * 86400;
pub const DOTS_SECS: i64 = 14 * 86400;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Said {
    /// The newest version this library has been told about.
    pub seen: String,
    /// The version the last page was written from, when it was known.
    #[serde(default)]
    pub from: Option<String>,
    /// When the last page was filed; 0 when none has been.
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub doc: Option<String>,
    #[serde(default)]
    pub count: usize,
    /// The headed entries' titles, for a panel's brief.
    #[serde(default)]
    pub titles: Vec<String>,
    /// Every entry's id, for the page's dots: a control shown on this page
    /// is marked new, and one from an older page is not.
    #[serde(default)]
    pub ids: Vec<String>,
}

/// What this start has to tell, if anything.
#[derive(Debug, PartialEq)]
pub enum Due {
    /// Nothing new since the version told.
    Nothing,
    /// A version to note and nothing to show: a fresh install, or a release
    /// with no entries.
    Note,
    /// A page, from `from` (unknown for a library older than the count).
    Page {
        from: Option<Version>,
        entries: Vec<&'static Feature>,
    },
}

pub fn due(
    said: Option<&Said>,
    running: &Version,
    empty_library: bool,
    applied_before: Option<&str>,
) -> Due {
    let seen = said.and_then(|s| Version::parse(&s.seen).ok());
    if seen.as_ref().is_some_and(|s| s >= running) {
        return Due::Nothing;
    }
    if seen.is_none() && empty_library {
        return Due::Note;
    }
    let from = seen.or_else(|| {
        applied_before
            .and_then(|a| Version::parse(a).ok())
            .filter(|a| a < running)
    });
    let entries = features::between(from.as_ref(), running);
    if entries.is_empty() {
        return Due::Note;
    }
    Due::Page { from, entries }
}

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("whats-new")
}

/// The page's folder. Its name is the project the page is filed under.
pub fn page_dir(data_dir: &Path) -> PathBuf {
    dir(data_dir).join("snyvi")
}

pub fn read(data_dir: &Path) -> Option<Said> {
    let text = std::fs::read_to_string(dir(data_dir).join("state.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Written beside and renamed over, so a power cut leaves the old count or
/// the new one, never half a file.
pub fn write(data_dir: &Path, said: &Said) -> Result<()> {
    let d = dir(data_dir);
    std::fs::create_dir_all(&d)?;
    let tmp = d.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(said)?)?;
    std::fs::rename(&tmp, d.join("state.json"))?;
    Ok(())
}

/// The page, as Markdown, with its pictures written beside it. Returns the
/// path to send.
pub fn write_page(
    data_dir: &Path,
    from: Option<&Version>,
    entries: &[&Feature],
) -> Result<PathBuf> {
    let d = page_dir(data_dir);
    std::fs::create_dir_all(&d).with_context(|| format!("making {}", d.display()))?;
    for f in entries {
        if let Some((name, bytes)) = f
            .still
            .as_deref()
            .and_then(|s| Some((s, features::still(s)?)))
        {
            std::fs::write(d.join(name), bytes)?;
        }
    }
    let path = d.join("WHATS-NEW.md");
    std::fs::write(&path, markdown(from, entries))?;
    Ok(path)
}

pub fn markdown(from: Option<&Version>, entries: &[&Feature]) -> String {
    let mut md = String::from("# What's new in snyvi\n\n");
    md.push_str(&match from {
        Some(v) => format!(
            "*You were on {}. Here is everything since, newest first.*\n\n",
            features::short(v)
        ),
        None => "*The newest things in snyvi, newest first.*\n\n".to_string(),
    });
    for f in entries.iter().filter(|f| !f.small) {
        md.push_str(&format!(
            "## {} · {}\n\n",
            features::short(&f.since),
            f.title
        ));
        if let Some(s) = &f.still {
            md.push_str(&format!("![{}]({s})\n\n", f.title));
        }
        md.push_str(&format!("{}\n\n", f.line));
        if f.show.is_some() {
            md.push_str(&format!("[Show me →](/show?f={})\n\n", f.id));
        }
    }
    let small: Vec<&str> = entries
        .iter()
        .filter(|f| f.small)
        .map(|f| f.title.as_str())
        .collect();
    if !small.is_empty() {
        md.push_str(&format!(
            "---\n\n**Smaller things:** {}.\n",
            small.join(" · ")
        ));
    }
    md
}

/// What the page told, kept: the version, and for a page, what it was.
pub fn told(
    running: &Version,
    from: Option<&Version>,
    entries: &[&Feature],
    doc: Option<String>,
    now: i64,
) -> Said {
    Said {
        seen: running.to_string(),
        from: from.map(features::short),
        at: if doc.is_some() { now } else { 0 },
        doc,
        count: entries.len(),
        titles: entries
            .iter()
            .filter(|f| !f.small)
            .map(|f| f.title.clone())
            .collect(),
        ids: entries.iter().map(|f| f.id.clone()).collect(),
    }
}

/// The page's part of the update block (`update_json`): for two weeks after
/// it was filed, what the toast and the dots need.
pub fn fresh_json(said: &Said, now: i64) -> Option<serde_json::Value> {
    let doc = said.doc.as_ref()?;
    (said.at > 0 && now - said.at < DOTS_SECS).then(|| {
        serde_json::json!({ "doc": doc, "count": said.count, "from": said.from, "at": said.at, "seen": said.seen, "ids": said.ids })
    })
}

/// The line a panel's brief carries for a week after a page.
pub fn brief_line(said: &Said, now: i64) -> Option<String> {
    if said.at == 0 || now - said.at >= BRIEF_SECS || said.titles.is_empty() {
        return None;
    }
    let since = said
        .from
        .as_deref()
        .map(|f| format!("{f} → "))
        .unwrap_or_default();
    let seen = Version::parse(&said.seen).map_or(said.seen.clone(), |v| features::short(&v));
    Some(format!(
        "snyvi was updated ({since}{seen}). New for the user: {}. The \"What's new in snyvi\" page has them; mention one only where it helps the work.",
        said.titles.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    fn said(seen: &str) -> Said {
        Said {
            seen: seen.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_fresh_library_is_noted_not_told() {
        assert_eq!(due(None, &v("1.50.0"), true, None), Due::Note);
    }

    #[test]
    fn a_restart_or_a_step_back_tells_nothing() {
        assert_eq!(
            due(Some(&said("1.50.0")), &v("1.50.0"), false, None),
            Due::Nothing
        );
        assert_eq!(
            due(Some(&said("1.50.0")), &v("1.49.0"), false, None),
            Due::Nothing
        );
    }

    #[test]
    fn an_update_tells_every_version_skipped() {
        let Due::Page { from, entries } = due(Some(&said("1.47.0")), &v("1.50.0"), false, None)
        else {
            panic!("a page is due");
        };
        assert_eq!(from, Some(v("1.47.0")));
        assert!(entries.iter().any(|f| f.id == "routines"));
        assert!(entries.iter().any(|f| f.id == "pdf"));
        assert!(entries
            .iter()
            .all(|f| f.since > v("1.47.0") && f.since <= v("1.50.0")));
    }

    #[test]
    fn a_library_older_than_the_count_starts_from_its_last_update() {
        let Due::Page { from, .. } = due(None, &v("1.50.0"), false, Some("1.48.0")) else {
            panic!("a page is due");
        };
        assert_eq!(from, Some(v("1.48.0")));
        // `applied` that is this very version is no "from".
        let Due::Page { from, .. } = due(None, &v("1.50.0"), false, Some("1.50.0")) else {
            panic!("a page is due");
        };
        assert_eq!(from, None);
    }

    #[test]
    fn the_page_heads_each_entry_and_folds_the_small_ones() {
        let entries = features::between(Some(&v("1.48.0")), &v("1.50.0"));
        let md = markdown(Some(&v("1.48.0")), &entries);
        assert!(md.starts_with("# What's new in snyvi\n\n*You were on 1.48."));
        assert!(md.contains("## 1.50 · Routines\n\n![Routines](routines.png)"));
        assert!(md.contains("[Show me →](/show?f=routines)"));
        assert!(md.contains("**Smaller things:** An Undo waits"));
        assert!(!md.contains("## 1.50 · An Undo"));
    }

    #[test]
    fn the_page_and_its_pictures_land_in_the_snyvi_folder() {
        let tmp = std::env::temp_dir().join(format!("snyvi-whats-new-{}", std::process::id()));
        let entries = features::between(Some(&v("1.48.0")), &v("1.50.0"));
        let path = write_page(&tmp, Some(&v("1.48.0")), &entries).unwrap();
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "snyvi");
        assert!(path.with_file_name("routines.png").exists());
        let s = told(
            &v("1.50.0"),
            Some(&v("1.48.0")),
            &entries,
            Some("abc".into()),
            100,
        );
        write(&tmp, &s).unwrap();
        assert_eq!(read(&tmp), Some(s));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_toast_and_the_brief_fade() {
        let entries = features::between(Some(&v("1.49.0")), &v("1.50.0"));
        let s = told(
            &v("1.50.0"),
            Some(&v("1.49.0")),
            &entries,
            Some("abc".into()),
            1000,
        );
        assert!(fresh_json(&s, 1000 + DOTS_SECS - 1).is_some());
        assert!(fresh_json(&s, 1000 + DOTS_SECS).is_none());
        let line = brief_line(&s, 1000).unwrap();
        assert!(
            line.contains("(1.49 → 1.50)") && line.contains("Routines"),
            "{line}"
        );
        assert!(brief_line(&s, 1000 + BRIEF_SECS).is_none());
        // A version noted with no page says nothing at all.
        let quiet = told(&v("1.50.0"), None, &[], None, 1000);
        assert!(fresh_json(&quiet, 1000).is_none() && brief_line(&quiet, 1000).is_none());
    }
}
