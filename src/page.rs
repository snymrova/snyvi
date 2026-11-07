//! A desk's page (1.59, plan 48ca2d5b9e; docs/WALL.md): a landing page
//! drafted from the desk, in snyvi's look, and its **moments** -- a chapter
//! accepted, a release, a clip -- that the builder puts on the wall for
//! everyone, or sends to friends only, on a press.
//!
//! What it holds to:
//!
//! - **Nothing leaves before Publish.** This module only keeps the page;
//!   the press that sends it is the reader's, through the window's
//!   capability (`server::api_page`), and the outbox row it makes is the one
//!   way anything reaches the wall (`crate::wall`). An agent's `offer_post`
//!   makes a card (`offer`), never a page.
//! - **Drafted, then the builder's.** A new page starts from `draft`, every
//!   field with where it came from (`provenance`); an edit makes a field the
//!   builder's own and drops its chip, and the chip puts the draft back.
//! - **Files are copied in** (`files`), so what is up is what the builder
//!   chose, whatever the folder does after.
//! - **The slug is the builder's until it is up** (D2): editable until the
//!   first publish succeeds (`published_at`), then fixed. On the wall a slug
//!   belongs to the key that first published it (D4).
//! - **Nothing is deleted.** Taking a page down is a stamp; a moment taken
//!   off is hidden; an offer answered Not now stays, so the same ship is
//!   never asked about twice.
//!
//! The store's side only, as `crate::desk` is for notes: no HTTP, no panes.

pub mod accent;
pub mod draft;
pub mod files;

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use draft::Draft;

/// Its own tables, run at open beside the others (`store.rs`), so a page
/// costs the store two lines and no migration. A database built by hand in
/// a test that builds `desk::SCHEMA` and wants pages runs this too.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL UNIQUE REFERENCES desks(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  lede TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'software',
  stage TEXT NOT NULL DEFAULT '',
  looking_for TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  hero TEXT NOT NULL DEFAULT 'mark',
  facts TEXT NOT NULL DEFAULT 'stage,kind,last,looking',
  github TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  accent TEXT NOT NULL DEFAULT 'passion',
  wash TEXT NOT NULL DEFAULT '',
  count_shown INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'off',
  published_at INTEGER NOT NULL DEFAULT 0,
  up_at INTEGER NOT NULL DEFAULT 0,
  down_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL DEFAULT '{}',
  hearts INTEGER NOT NULL DEFAULT 0,
  heart_names TEXT NOT NULL DEFAULT '[]',
  hearts_since INTEGER NOT NULL DEFAULT 0,
  hearts_at INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  about TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  doc_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL DEFAULT 0,
  hidden_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS moments_of ON moments(page_id, hidden_at, published_at);
CREATE TABLE IF NOT EXISTS pageoffers (
  id INTEGER PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  about TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  pane TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(desk_id, about)
);
CREATE TABLE IF NOT EXISTS pages_from (
  id INTEGER PRIMARY KEY,
  peer_id INTEGER NOT NULL REFERENCES peers(id),
  slug TEXT NOT NULL,
  page TEXT NOT NULL,
  moment TEXT NOT NULL DEFAULT '',
  arrived_at INTEGER NOT NULL,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pages_from_at ON pages_from(removed_at, arrived_at);
CREATE TABLE IF NOT EXISTS page_outbox (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  what TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  queued_at INTEGER NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_outbox_held ON page_outbox(sent_at, queued_at);
"#;

pub const TONES: [&str; 3] = ["software", "book", "design"];
pub const HEROES: [&str; 4] = ["picture", "clip", "mark", "none"];
pub const VISIBILITY: [&str; 3] = ["off", "friends", "everyone"];
/// The four facts a page may show, in the strip's order.
pub const FACTS: [&str; 4] = ["stage", "kind", "last", "looking"];

pub const KIND_CHARS: usize = 40;
pub const STAGE_CHARS: usize = 40;
pub const LOOKING_CHARS: usize = 120;
pub const LINKS_MAX: usize = 6;
pub const LINK_LABEL_CHARS: usize = 40;
pub const URL_CHARS: usize = 300;
pub const MOMENT_TITLE_CHARS: usize = 80;
pub const MOMENT_BODY_CHARS: usize = 4000;
/// One picture or clip is the voice; a few more is the most.
pub const MOMENT_FILES_MAX: usize = 4;
/// An offer's words, as `offer_post` takes them.
pub const OFFER_TITLE_CHARS: usize = 60;
pub const OFFER_TEXT_CHARS: usize = 2000;
pub const ABOUT_CHARS: usize = 200;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Link {
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Page {
    pub id: i64,
    pub desk_id: i64,
    pub slug: String,
    pub title: String,
    pub lede: String,
    pub kind: String,
    pub tone: String,
    pub stage: String,
    pub looking_for: String,
    /// A file in `data/pages/`, or empty.
    pub logo: String,
    pub cover: String,
    pub hero: String,
    pub facts: Vec<String>,
    pub github: String,
    pub links: Vec<Link>,
    pub accent: String,
    pub wash: String,
    pub count_shown: bool,
    pub visibility: String,
    /// The first publish that went through, which fixes the slug; 0 before.
    pub published_at: i64,
    /// When it last went up, and when it was last taken down.
    pub up_at: i64,
    pub down_at: i64,
    /// When the wall last found the repository's `.snyvi/owner` naming this
    /// daemon's key; 0 for not checked.
    pub checked_at: i64,
    /// A drafted field's name to where it came from (`draft::FROM`).
    pub provenance: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Page {
    /// The slug can still change: nothing has gone up under it.
    pub fn slug_open(&self) -> bool {
        self.published_at == 0
    }
    /// It is up somewhere now.
    pub fn is_up(&self) -> bool {
        self.up_at > 0 && self.up_at >= self.down_at
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Moment {
    pub id: i64,
    pub page_id: i64,
    /// What it is about: a document's id, gallery ids, a path, a thread's
    /// name. A second offer about the same thing updates the moment.
    pub about: String,
    pub title: String,
    pub body_md: String,
    pub files: Vec<String>,
    pub doc_id: String,
    pub created_at: i64,
    pub published_at: i64,
    pub hidden_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Offer {
    pub id: i64,
    pub desk_id: i64,
    pub about: String,
    pub title: String,
    pub text: String,
    /// `snyvi` for its own card on a shipped thread, else the agent's name.
    pub by: String,
    pub pane: String,
    /// `open`, `looked` or `notnow`.
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A slug: lowercase letters, digits and hyphens, 2 to 40, starting with a
/// letter or a digit. The same rule on the wall.
pub fn valid_slug(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=40).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A slug from a desk's name: `Breeds of Dogs!` is `breeds-of-dogs`. A
/// name with nothing to keep is `page-<desk id>`.
pub fn slug_of(name: &str, desk_id: i64) -> String {
    let mut s = String::new();
    for c in name.chars().flat_map(|c| c.to_lowercase()) {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.chars().take(40).collect();
    let s = s.trim_end_matches('-').to_string();
    if valid_slug(&s) {
        s
    } else {
        format!("page-{desk_id}")
    }
}

const COLS: &str =
    "id, desk_id, slug, title, lede, kind, tone, stage, looking_for, logo, cover, hero, \
    facts, github, links, accent, wash, count_shown, visibility, published_at, up_at, down_at, \
    checked_at, provenance, created_at, updated_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Page> {
    let facts: String = r.get(12)?;
    let links: String = r.get(14)?;
    let prov: String = r.get(23)?;
    Ok(Page {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        slug: r.get(2)?,
        title: r.get(3)?,
        lede: r.get(4)?,
        kind: r.get(5)?,
        tone: r.get(6)?,
        stage: r.get(7)?,
        looking_for: r.get(8)?,
        logo: r.get(9)?,
        cover: r.get(10)?,
        hero: r.get(11)?,
        facts: facts
            .split(',')
            .filter(|f| !f.is_empty())
            .map(String::from)
            .collect(),
        github: r.get(13)?,
        links: serde_json::from_str(&links).unwrap_or_default(),
        accent: r.get(15)?,
        wash: r.get(16)?,
        count_shown: r.get::<_, i64>(17)? != 0,
        visibility: r.get(18)?,
        published_at: r.get(19)?,
        up_at: r.get(20)?,
        down_at: r.get(21)?,
        checked_at: r.get(22)?,
        provenance: serde_json::from_str(&prov).unwrap_or_default(),
        created_at: r.get(24)?,
        updated_at: r.get(25)?,
    })
}

/// The desk's page, if it has one.
pub fn get(conn: &Connection, desk_id: i64) -> Result<Option<Page>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM pages WHERE desk_id = ?1"),
            [desk_id],
            row,
        )
        .optional()?)
}

pub fn by_id(conn: &Connection, id: i64) -> Result<Option<Page>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM pages WHERE id = ?1"),
            [id],
            row,
        )
        .optional()?)
}

/// Make the desk's page from a draft, or give back the one it has. `logo`
/// is the draft's logo once copied in (`files::copy_in`), or empty.
pub fn start(
    conn: &Connection,
    desk_id: i64,
    desk_name: &str,
    d: &Draft,
    logo: &str,
    now: i64,
) -> Result<Page> {
    if let Some(p) = get(conn, desk_id)? {
        return Ok(p);
    }
    let mut prov = d.from.clone();
    if logo.is_empty() {
        prov.remove("logo");
    }
    conn.execute(
        "INSERT INTO pages(desk_id, slug, title, lede, kind, tone, stage, logo, github, accent, \
         wash, provenance, created_at, updated_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            desk_id,
            slug_of(desk_name, desk_id),
            d.title,
            d.lede,
            d.kind,
            d.tone,
            d.stage,
            logo,
            d.github,
            d.accent,
            d.wash,
            serde_json::to_string(&prov)?,
            now
        ],
    )?;
    get(conn, desk_id)?.ok_or_else(|| anyhow::anyhow!("the page was not kept"))
}

/// What the reader changed on the page: each field present is set, and a
/// drafted field set this way is the builder's own from then on.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Edit {
    pub slug: Option<String>,
    pub title: Option<String>,
    pub lede: Option<String>,
    pub kind: Option<String>,
    pub tone: Option<String>,
    pub stage: Option<String>,
    pub looking_for: Option<String>,
    pub hero: Option<String>,
    pub facts: Option<Vec<String>>,
    pub github: Option<String>,
    pub links: Option<Vec<Link>>,
    pub accent: Option<String>,
    pub count_shown: Option<bool>,
    pub visibility: Option<String>,
}

/// A field's words: trimmed, one line, at most `n` characters, or refused.
fn words(field: &str, s: &str, n: usize) -> Result<String> {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n {
        bail!("{field} is at most {n} characters");
    }
    Ok(t)
}

/// An `https://` link, or empty. Anything else is refused: a page links out
/// only to the web.
fn url(field: &str, s: &str) -> Result<String> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(String::new());
    }
    if !t.starts_with("https://")
        || t.chars().count() > URL_CHARS
        || t.contains(char::is_whitespace)
    {
        bail!("{field} is an https:// link of at most {URL_CHARS} characters");
    }
    Ok(t.to_string())
}

fn one_of(field: &str, s: &str, set: &[&str]) -> Result<String> {
    if !set.contains(&s) {
        bail!("{field} is one of {}", set.join(", "));
    }
    Ok(s.to_string())
}

/// Every field the edit sets, checked, as `(column, value)`.
fn edit_cols(p: &Page, e: &Edit) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    use rusqlite::types::Value::{Integer, Text};
    let mut set: Vec<(&'static str, rusqlite::types::Value)> = Vec::new();
    if let Some(s) = &e.slug {
        let s = s.trim();
        if s != p.slug {
            if !p.slug_open() {
                bail!("the page is up as {}; its name stays", p.slug);
            }
            if !valid_slug(s) {
                bail!("a page's name is 2 to 40 lowercase letters, digits and hyphens");
            }
            set.push(("slug", Text(s.into())));
        }
    }
    let texts: [(&str, &Option<String>, usize); 5] = [
        ("title", &e.title, draft::TITLE_CHARS),
        ("lede", &e.lede, draft::LEDE_CHARS),
        ("kind", &e.kind, KIND_CHARS),
        ("stage", &e.stage, STAGE_CHARS),
        ("looking_for", &e.looking_for, LOOKING_CHARS),
    ];
    for (col, v, n) in texts {
        if let Some(v) = v {
            set.push((col, Text(words(col, v, n)?)));
        }
    }
    if let Some(v) = &e.tone {
        set.push(("tone", Text(one_of("tone", v, &TONES)?)));
    }
    if let Some(v) = &e.hero {
        set.push(("hero", Text(one_of("hero", v, &HEROES)?)));
    }
    if let Some(v) = &e.visibility {
        set.push(("visibility", Text(one_of("who sees it", v, &VISIBILITY)?)));
    }
    if let Some(v) = &e.accent {
        if !accent::is_accent(v) {
            bail!("the accent is one of snyvi's eight");
        }
        set.push(("accent", Text(v.clone())));
    }
    if let Some(f) = &e.facts {
        let kept: Vec<&str> = FACTS
            .iter()
            .copied()
            .filter(|x| f.iter().any(|y| y == x))
            .collect();
        set.push(("facts", Text(kept.join(","))));
    }
    if let Some(v) = &e.github {
        set.push(("github", Text(url("the GitHub link", v)?)));
    }
    if let Some(links) = &e.links {
        set.push(("links", Text(serde_json::to_string(&check_links(links)?)?)));
    }
    if let Some(v) = e.count_shown {
        set.push(("count_shown", Integer(v as i64)));
    }
    Ok(set)
}

fn check_links(links: &[Link]) -> Result<Vec<Link>> {
    if links.len() > LINKS_MAX {
        bail!("a page has at most {LINKS_MAX} links");
    }
    links
        .iter()
        .map(|l| {
            Ok(Link {
                label: words("a link's label", &l.label, LINK_LABEL_CHARS)?,
                url: url("a link", &l.url)?,
            })
        })
        .filter(|l| !matches!(l, Ok(Link { url, .. }) if url.is_empty()))
        .collect()
}

/// Apply an edit to the desk's page. Every field it sets drops its
/// provenance chip. The page as it is now.
pub fn save(conn: &Connection, desk_id: i64, e: &Edit, now: i64) -> Result<Page> {
    let Some(p) = get(conn, desk_id)? else {
        bail!("this desk has no page yet");
    };
    let set = edit_cols(&p, e)?;
    if set.is_empty() {
        return Ok(p);
    }
    let mut prov = p.provenance.clone();
    for (col, _) in &set {
        prov.remove(*col);
    }
    let mut sql = String::from("UPDATE pages SET ");
    let mut vals: Vec<rusqlite::types::Value> = Vec::new();
    for (i, (col, v)) in set.into_iter().enumerate() {
        sql.push_str(&format!("{col} = ?{}, ", i + 1));
        vals.push(v);
    }
    let n = vals.len();
    sql.push_str(&format!(
        "provenance = ?{}, updated_at = ?{} WHERE id = ?{}",
        n + 1,
        n + 2,
        n + 3
    ));
    vals.push(serde_json::to_string(&prov)?.into());
    vals.push(now.into());
    vals.push(p.id.into());
    conn.execute(&sql, rusqlite::params_from_iter(vals))?;
    get(conn, desk_id)?.ok_or_else(|| anyhow::anyhow!("the page went away"))
}

/// The chip pressed: `field` goes back to the draft's value, and says where
/// that came from again. `logo` is the draft's copied-in logo for that field.
pub fn redraft(
    conn: &Connection,
    desk_id: i64,
    field: &str,
    d: &Draft,
    logo: &str,
    now: i64,
) -> Result<Page> {
    let Some(p) = get(conn, desk_id)? else {
        bail!("this desk has no page yet");
    };
    let value = match field {
        "title" => d.title.clone(),
        "lede" => d.lede.clone(),
        "kind" => d.kind.clone(),
        "tone" => d.tone.clone(),
        "stage" => d.stage.clone(),
        "github" => d.github.clone(),
        "accent" => d.accent.clone(),
        "logo" => logo.to_string(),
        _ => bail!("{field} is not a field the draft fills"),
    };
    let mut prov = p.provenance.clone();
    match d.from.get(field) {
        Some(src) if !(field == "logo" && logo.is_empty()) => {
            prov.insert(field.into(), src.clone());
        }
        _ => {
            prov.remove(field);
        }
    }
    // `field` is one of the names matched above: never the reader's text.
    conn.execute(
        &format!("UPDATE pages SET {field} = ?1, provenance = ?2, updated_at = ?3 WHERE id = ?4"),
        params![value, serde_json::to_string(&prov)?, now, p.id],
    )?;
    if field == "accent" {
        conn.execute(
            "UPDATE pages SET wash = ?1 WHERE id = ?2",
            params![d.wash, p.id],
        )?;
    }
    get(conn, desk_id)?.ok_or_else(|| anyhow::anyhow!("the page went away"))
}

/// A picture the reader chose for the logo or the cover, already copied in.
/// Choosing it makes the field theirs.
pub fn set_file(conn: &Connection, desk_id: i64, field: &str, file: &str, now: i64) -> Result<()> {
    if !matches!(field, "logo" | "cover") || !(file.is_empty() || files::file_name_ok(file)) {
        bail!("not a page's picture");
    }
    let Some(p) = get(conn, desk_id)? else {
        bail!("this desk has no page yet");
    };
    let mut prov = p.provenance.clone();
    prov.remove(field);
    conn.execute(
        &format!("UPDATE pages SET {field} = ?1, provenance = ?2, updated_at = ?3 WHERE id = ?4"),
        params![file, serde_json::to_string(&prov)?, now, p.id],
    )?;
    Ok(())
}

/// The press went through: up now, and the slug fixed from the first time.
pub fn mark_up(conn: &Connection, id: i64, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE pages SET up_at = ?2, published_at = CASE WHEN published_at = 0 THEN ?2 \
         ELSE published_at END WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// Taken down: off for everyone, kept here as it was.
pub fn mark_down(conn: &Connection, id: i64, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE pages SET down_at = ?2, visibility = 'off' WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// The wall found `.snyvi/owner` naming this key, or did not (`0`).
pub fn mark_checked(conn: &Connection, id: i64, at: i64) -> Result<()> {
    conn.execute(
        "UPDATE pages SET checked_at = ?2 WHERE id = ?1",
        params![id, at],
    )?;
    Ok(())
}

/// The wall's daily line about a page of this daemon's (`api_wall::take`):
/// the hearts since `since`, the names of those from checked pages, and
/// the reports counted. Kept on the page, to show; the desk it is on, or
/// `None` when no page of this daemon's has that slug.
#[allow(clippy::too_many_arguments)]
pub fn hearts_said(
    conn: &Connection,
    slug: &str,
    hearts: i64,
    names: &[String],
    since: i64,
    reported: i64,
    now: i64,
) -> Result<Option<i64>> {
    let names: Vec<String> = names
        .iter()
        .map(|n| draft::clip(&n.split_whitespace().collect::<Vec<_>>().join(" "), 40))
        .filter(|n| !n.is_empty())
        .take(20)
        .collect();
    let desk: Option<i64> = conn
        .query_row("SELECT desk_id FROM pages WHERE slug = ?1", [slug], |r| {
            r.get(0)
        })
        .optional()?;
    if desk.is_some() {
        conn.execute(
            "UPDATE pages SET hearts = ?2, heart_names = ?3, hearts_since = ?4, hearts_at = ?5, \
             reports = ?6 WHERE slug = ?1",
            params![
                slug,
                hearts.max(0),
                serde_json::to_string(&names)?,
                since,
                now,
                reported.max(0)
            ],
        )?;
    }
    Ok(desk)
}

/// The last line's hearts, names and since, for the view and Home's row.
pub fn hearts_of(conn: &Connection, page_id: i64) -> Result<(i64, Vec<String>, i64)> {
    let (n, names, since): (i64, String, i64) = conn.query_row(
        "SELECT hearts, heart_names, hearts_since FROM pages WHERE id = ?1",
        [page_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    Ok((n, serde_json::from_str(&names).unwrap_or_default(), since))
}

/// A friend's page arrived (Friends only): kept, a resend a new row.
pub fn friend_page(
    conn: &Connection,
    peer_id: i64,
    slug: &str,
    page: &str,
    moment: &str,
    now: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO pages_from(peer_id, slug, page, moment, arrived_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![peer_id, slug, page, moment, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Friends' pages for Home's Friends segment: the newest of each friend's
/// slug, newest first, with the friend's name.
pub fn friend_pages(conn: &Connection, n: usize) -> Result<Vec<serde_json::Value>> {
    let mut st = conn.prepare(
        "SELECT f.slug, f.page, f.moment, f.arrived_at, p.name FROM pages_from f \
         JOIN peers p ON p.id = f.peer_id \
         WHERE f.removed_at = 0 AND p.removed_at = 0 AND f.id IN \
           (SELECT MAX(id) FROM pages_from GROUP BY peer_id, slug) \
         ORDER BY f.arrived_at DESC LIMIT ?1",
    )?;
    let rows = st.query_map([n as i64], |r| {
        let page: String = r.get(1)?;
        let moment: String = r.get(2)?;
        Ok(serde_json::json!({
            "slug": r.get::<_, String>(0)?,
            "page": serde_json::from_str::<serde_json::Value>(&page).unwrap_or_default(),
            "moment": serde_json::from_str::<serde_json::Value>(&moment).unwrap_or_default(),
            "at": r.get::<_, i64>(3)?,
            "from": r.get::<_, String>(4)?,
        }))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every file the page holds: its own and its moments', each once.
pub fn file_names(conn: &Connection, p: &Page) -> Result<Vec<String>> {
    let mut names = vec![p.logo.clone(), p.cover.clone()];
    for m in moments(conn, p.id, true)? {
        names.extend(m.files);
    }
    names.retain(|n| !n.is_empty());
    names.sort();
    names.dedup();
    Ok(names)
}

fn moment_row(r: &rusqlite::Row) -> rusqlite::Result<Moment> {
    let files: String = r.get(5)?;
    Ok(Moment {
        id: r.get(0)?,
        page_id: r.get(1)?,
        about: r.get(2)?,
        title: r.get(3)?,
        body_md: r.get(4)?,
        files: serde_json::from_str(&files).unwrap_or_default(),
        doc_id: r.get(6)?,
        created_at: r.get(7)?,
        published_at: r.get(8)?,
        hidden_at: r.get(9)?,
    })
}

const MOMENT_COLS: &str =
    "id, page_id, about, title, body_md, files, doc_id, created_at, published_at, hidden_at";

/// A page's moments, newest first; the hidden ones only with `all`.
pub fn moments(conn: &Connection, page_id: i64, all: bool) -> Result<Vec<Moment>> {
    let mut st = conn.prepare(&format!(
        "SELECT {MOMENT_COLS} FROM moments WHERE page_id = ?1 AND (?2 OR hidden_at = 0) \
         ORDER BY CASE WHEN published_at = 0 THEN created_at ELSE published_at END DESC, id DESC"
    ))?;
    let rows = st.query_map(params![page_id, all], moment_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn moment(conn: &Connection, id: i64) -> Result<Option<Moment>> {
    Ok(conn
        .query_row(
            &format!("SELECT {MOMENT_COLS} FROM moments WHERE id = ?1"),
            [id],
            moment_row,
        )
        .optional()?)
}

/// A moment, as the reader writes it (or Have a look drafts it).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MomentIn {
    pub about: String,
    pub title: String,
    pub body_md: String,
    /// Names in `data/pages/`, already copied in.
    pub files: Vec<String>,
    pub doc_id: String,
}

/// Keep a moment on the page. One with the same `about` that is not up yet
/// is updated in place; once up, a new one is a new moment. Its id.
pub fn put_moment(conn: &Connection, page_id: i64, m: &MomentIn, now: i64) -> Result<i64> {
    let title = words("a moment's title", &m.title, MOMENT_TITLE_CHARS)?;
    if title.is_empty() {
        bail!("a moment needs a title");
    }
    if m.body_md.chars().count() > MOMENT_BODY_CHARS {
        bail!("a moment is at most {MOMENT_BODY_CHARS} characters");
    }
    if m.files.len() > MOMENT_FILES_MAX {
        bail!("a moment shows one picture or clip, and at most {MOMENT_FILES_MAX}");
    }
    if let Some(f) = m.files.iter().find(|f| !files::file_name_ok(f)) {
        bail!("{f} is not a page's file");
    }
    let about = words("about", &m.about, ABOUT_CHARS)?;
    let files = serde_json::to_string(&m.files)?;
    let same: Option<i64> = if about.is_empty() {
        None
    } else {
        conn.query_row(
            "SELECT id FROM moments WHERE page_id = ?1 AND about = ?2 AND published_at = 0 \
             AND hidden_at = 0 ORDER BY id DESC LIMIT 1",
            params![page_id, about],
            |r| r.get(0),
        )
        .optional()?
    };
    if let Some(id) = same {
        conn.execute(
            "UPDATE moments SET title = ?2, body_md = ?3, files = ?4, doc_id = ?5 WHERE id = ?1",
            params![id, title, m.body_md, files, m.doc_id],
        )?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO moments(page_id, about, title, body_md, files, doc_id, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![page_id, about, title, m.body_md, files, m.doc_id, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The moment went up with its page.
pub fn moment_up(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE moments SET published_at = ?2 WHERE id = ?1 AND published_at = 0",
        params![id, now],
    )? > 0)
}

/// Off the page, kept: Undo is `hide_moment(.., false)`.
pub fn hide_moment(conn: &Connection, id: i64, hidden: bool, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE moments SET hidden_at = ?2 WHERE id = ?1",
        params![id, if hidden { now } else { 0 }],
    )? > 0)
}

/// What an offer made of the card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offered {
    /// A new card, in the corner.
    New(i64),
    /// The open card about this, with new words.
    Updated(i64),
    /// Answered already: Not now is final for that `about`, and a card
    /// looked at does not come back.
    Answered,
}

/// One card for all three doors: snyvi's own on a shipped thread, the
/// agent's `offer_post`, and the Page button's draft. `about` is the key.
#[allow(clippy::too_many_arguments)]
pub fn offer(
    conn: &Connection,
    desk_id: i64,
    about: &str,
    title: &str,
    text: &str,
    by: &str,
    pane: &str,
    now: i64,
) -> Result<Offered> {
    let about = words("about", about, ABOUT_CHARS)?;
    if about.is_empty() {
        bail!("an offer says what it is about: a document, a path or a thread");
    }
    let title = draft::clip(&words("title", title, usize::MAX)?, OFFER_TITLE_CHARS);
    let text: String = text.trim().chars().take(OFFER_TEXT_CHARS).collect();
    let had: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, state FROM pageoffers WHERE desk_id = ?1 AND about = ?2",
            params![desk_id, about],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match had {
        Some((id, state)) if state == "open" => {
            conn.execute(
                "UPDATE pageoffers SET title = ?2, text = ?3, by = ?4, pane = ?5, updated_at = ?6 \
                 WHERE id = ?1",
                params![id, title, text, by, pane, now],
            )?;
            Ok(Offered::Updated(id))
        }
        Some(_) => Ok(Offered::Answered),
        None => {
            conn.execute(
                "INSERT INTO pageoffers(desk_id, about, title, text, by, pane, created_at, updated_at) \
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![desk_id, about, title, text, by, pane, now],
            )?;
            Ok(Offered::New(conn.last_insert_rowid()))
        }
    }
}

fn offer_row(r: &rusqlite::Row) -> rusqlite::Result<Offer> {
    Ok(Offer {
        id: r.get(0)?,
        desk_id: r.get(1)?,
        about: r.get(2)?,
        title: r.get(3)?,
        text: r.get(4)?,
        by: r.get(5)?,
        pane: r.get(6)?,
        state: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}

const OFFER_COLS: &str = "id, desk_id, about, title, text, by, pane, state, created_at, updated_at";

/// Whether a card about `about` was ever made on this desk, answered or not.
pub fn offered(conn: &Connection, desk_id: i64, about: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM pageoffers WHERE desk_id = ?1 AND about = ?2",
            params![desk_id, about.trim()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The cards waiting on a desk, newest first.
pub fn open_offers(conn: &Connection, desk_id: i64) -> Result<Vec<Offer>> {
    let mut st = conn.prepare(&format!(
        "SELECT {OFFER_COLS} FROM pageoffers WHERE desk_id = ?1 AND state = 'open' \
         ORDER BY updated_at DESC, id DESC"
    ))?;
    let rows = st.query_map([desk_id], offer_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn offer_by_id(conn: &Connection, id: i64) -> Result<Option<Offer>> {
    Ok(conn
        .query_row(
            &format!("SELECT {OFFER_COLS} FROM pageoffers WHERE id = ?1"),
            [id],
            offer_row,
        )
        .optional()?)
}

/// Have a look (`looked`) or Not now (`notnow`); only an open card answers.
pub fn answer_offer(conn: &Connection, id: i64, state: &str, now: i64) -> Result<bool> {
    if !matches!(state, "looked" | "notnow") {
        bail!("a card is answered Have a look or Not now");
    }
    Ok(conn.execute(
        "UPDATE pageoffers SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state = 'open'",
        params![id, state, now],
    )? > 0)
}

#[cfg(test)]
mod tests;
