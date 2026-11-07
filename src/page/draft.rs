//! A page drafted from its desk (design round 40303cb7e4): every field
//! arrives filled and says where it came from, so the builder starts from
//! their own words, not a form. The chip on a field is its `from`; pressing
//! it puts this draft's value back.
//!
//! Read only from the desk's folder and the store, never the network: the
//! README's first heading and paragraph, a logo by its usual names, the git
//! remote from the config, the tone from the desk's views, the stage from
//! its threads.

use super::accent::{accent_of, Accent};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Where a drafted field came from: what its chip says.
#[cfg(test)]
pub const FROM: [&str; 6] = ["readme", "icon", "git", "views", "thread", "desk"];

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Draft {
    pub title: String,
    pub lede: String,
    pub kind: String,
    pub tone: String,
    pub stage: String,
    /// The logo's file in the desk's folder, absolute; copied in only when
    /// the page is made (`page::start`).
    pub logo: Option<PathBuf>,
    pub github: String,
    pub accent: String,
    pub wash: String,
    /// Field name to one of `FROM`.
    pub from: BTreeMap<String, String>,
}

pub const TITLE_CHARS: usize = 80;
pub const LEDE_CHARS: usize = 400;

/// Draft a page for the desk named `name` at `root`, whose threads are at
/// `stages`.
pub fn draft(root: &Path, name: &str, stages: &[String]) -> Draft {
    let mut d = Draft::default();
    let from = |d: &mut Draft, field: &str, src: &str| {
        d.from.insert(field.into(), src.into());
    };
    match readme(root) {
        Some((title, lede)) => {
            d.title = title;
            from(&mut d, "title", "readme");
            if !lede.is_empty() {
                d.lede = lede;
                from(&mut d, "lede", "readme");
            }
        }
        None => {
            d.title = clip(name.trim(), TITLE_CHARS);
            from(&mut d, "title", "desk");
        }
    }
    d.tone = tone(root).into();
    from(&mut d, "tone", "views");
    d.kind = match d.tone.as_str() {
        "book" => "Book",
        "design" => "Design",
        _ => "Software",
    }
    .into();
    from(&mut d, "kind", "views");
    if let Some(s) = stage(stages, &d.tone) {
        d.stage = s.into();
        from(&mut d, "stage", "thread");
    }
    if let Some(web) = crate::git::remote_web(root) {
        d.github = web;
        from(&mut d, "github", "git");
    }
    let Accent { name, wash } = match logo(root) {
        Some(p) => {
            let ext = crate::render::ext_of(&p.to_string_lossy());
            let a = std::fs::read(&p)
                .ok()
                .filter(|b| b.len() as u64 <= super::files::LOGO_MAX)
                .map(|b| accent_of(&b, &ext));
            from(&mut d, "logo", "icon");
            d.logo = Some(p);
            a.unwrap_or(Accent {
                name: "passion",
                wash: String::new(),
            })
        }
        None => Accent {
            name: "passion",
            wash: String::new(),
        },
    };
    d.accent = name.into();
    d.wash = wash;
    if d.logo.is_some() {
        from(&mut d, "accent", "icon");
    }
    d
}

/// The tone from the desk's views: a `manuscript/` is a book, a board's
/// `design/` is design, anything else is software.
fn tone(root: &Path) -> &'static str {
    if root.join("manuscript").is_dir() {
        "book"
    } else if root.join(crate::board::DIR).is_dir() {
        "design"
    } else {
        "software"
    }
}

/// How far along, in the builder's words until they say otherwise: out
/// once anything has shipped, writing or building while a thread is under
/// way, early before that. No threads, no stage.
fn stage(stages: &[String], tone: &str) -> Option<&'static str> {
    let has = |s: &[&str]| stages.iter().any(|t| s.contains(&t.as_str()));
    if has(&["shipped", "told"]) {
        Some("Out")
    } else if has(&["building", "review", "waiting"]) {
        Some(if tone == "book" {
            "Writing"
        } else {
            "Building"
        })
    } else if has(&["idea", "planned", "parked"]) {
        Some("Early")
    } else {
        None
    }
}

/// The logo by the names a project keeps one under, in that order.
fn logo(root: &Path) -> Option<PathBuf> {
    let exts = ["svg", "png", "jpg", "webp"];
    let mut tries: Vec<PathBuf> = Vec::new();
    for base in ["logo", "assets/logo"] {
        for e in exts {
            tries.push(root.join(format!("{base}.{e}")));
        }
    }
    tries.insert(exts.len(), root.join("icons/icon.svg"));
    tries.push(root.join("icons/icon.png"));
    // A link out of the folder is not the desk's logo.
    let canon = dunce::canonicalize(root).ok()?;
    tries.into_iter().find(|p| {
        p.is_file()
            && dunce::canonicalize(p)
                .map(|c| c.starts_with(&canon))
                .unwrap_or(false)
    })
}

/// The README's first heading and first paragraph of prose under it.
fn readme(root: &Path) -> Option<(String, String)> {
    let file = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let n = p
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            n == "readme.md" || n == "readme"
        })
        .min()?;
    let text = std::fs::read_to_string(file).ok()?;
    readme_parts(&text)
}

/// `(title, lede)` out of a README's text. Badges, pictures, HTML and
/// quotes are not a lede; the first plain paragraph is.
pub fn readme_parts(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines();
    let title = lines
        .by_ref()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| clip(&plain(t), TITLE_CHARS))
        .filter(|t| !t.is_empty())?;
    let mut para: Vec<&str> = Vec::new();
    for l in lines {
        let t = l.trim();
        if t.is_empty() {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        let not_prose = t.starts_with('#')
            || t.starts_with('<')
            || t.starts_with("![")
            || t.starts_with("[![")
            || t.starts_with('>')
            || t.starts_with("```")
            || t.starts_with('|')
            || t.starts_with("- ")
            || t.starts_with("* ");
        if not_prose {
            if !para.is_empty() {
                break;
            }
            if t.starts_with("```") || t.starts_with('#') {
                // A code block or a section before any prose: no lede.
                break;
            }
            continue;
        }
        para.push(t);
    }
    Some((title, clip(&plain(&para.join(" ")), LEDE_CHARS)))
}

/// Markdown's marks off a line: links keep their words, emphasis and code
/// lose their marks.
fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' | '_' | '`' => {}
            '[' => {
                let mut words = String::new();
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                    words.push(c);
                }
                if chars.peek() == Some(&'(') {
                    for c in chars.by_ref() {
                        if c == ')' {
                            break;
                        }
                    }
                }
                out.push_str(&words);
            }
            _ => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `n` characters, cut at a word with an ellipsis when cut.
pub fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let head: String = s.chars().take(n.saturating_sub(1)).collect();
    let cut = head.rfind(' ').filter(|i| *i > n / 2).unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end())
}
