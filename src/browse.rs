//! Browse mode: read a folder straight from disk. Nothing is stored, nothing
//! reaches the library or the inbox. Files render on demand and are cached in
//! memory keyed by their modification time, so revisiting one is instant and
//! editing it on disk shows the new content.

use crate::render::{self, Renderer};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

/// Files larger than this are described rather than rendered.
const MAX_RENDER_BYTES: u64 = 8 * 1024 * 1024;
/// Rendered pages held in memory across the whole browser.
const CACHE_ENTRIES: usize = 48;
/// Entries scanned for quick-open, and how long that scan is reused.
const FIND_CAP: usize = 40_000;
const FIND_TTL: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize)]
pub struct Root {
    pub id: String,
    pub name: String,
    pub path: String,
    pub opened_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub name: String,
    /// Path relative to the root, `/` separated. Empty for the root itself.
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct FileView {
    pub path: String,
    pub name: String,
    /// markdown | code | diff | text | image | binary | large
    pub kind: String,
    pub lang: Option<String>,
    pub size: u64,
    pub modified: i64,
    pub html: String,
    /// "html" or "pdf" when this file can also be shown as a page, else None.
    pub preview: Option<String>,
    /// Where to point the preview frame. Path-shaped, so the page's own relative
    /// stylesheets and images resolve next to it.
    pub preview_url: Option<String>,
}

pub struct Browser {
    roots: RwLock<HashMap<String, Root>>,
    cache: Mutex<Vec<(String, String)>>,
    index: Mutex<HashMap<String, (Instant, Vec<String>)>>,
}

impl Browser {
    pub fn new() -> Browser {
        Browser {
            roots: RwLock::new(HashMap::new()),
            cache: Mutex::new(Vec::new()),
            index: Mutex::new(HashMap::new()),
        }
    }

    pub fn open(&self, path: &Path) -> Result<Root> {
        let path = path
            .canonicalize()
            .with_context(|| format!("no such directory: {}", path.display()))?;
        if !path.is_dir() {
            bail!("{} is not a directory", path.display());
        }
        let key = path.to_string_lossy().to_string();
        // Re-opening the same folder returns the root already on screen.
        if let Some(existing) = self.roots.read().unwrap().values().find(|r| r.path == key) {
            return Ok(existing.clone());
        }
        let root = Root {
            id: blake3::hash(key.as_bytes()).to_hex()[..8].to_string(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| key.clone()),
            path: key,
            opened_at: crate::store::now(),
        };
        self.roots
            .write()
            .unwrap()
            .insert(root.id.clone(), root.clone());
        Ok(root)
    }

    pub fn close(&self, id: &str) -> bool {
        self.index.lock().unwrap().remove(id);
        self.cache
            .lock()
            .unwrap()
            .retain(|(k, _)| !k.starts_with(id));
        self.roots.write().unwrap().remove(id).is_some()
    }

    pub fn list(&self) -> Vec<Root> {
        let mut v: Vec<Root> = self.roots.read().unwrap().values().cloned().collect();
        v.sort_by_key(|r| r.opened_at);
        v
    }

    pub fn get(&self, id: &str) -> Option<Root> {
        self.roots.read().unwrap().get(id).cloned()
    }

    /// Absolute path for a root-relative path, refusing anything that escapes the root.
    pub fn resolve(&self, id: &str, rel: &str) -> Result<PathBuf> {
        let root = self.get(id).context("no such browse root")?;
        let root_path = PathBuf::from(&root.path);
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            return Ok(root_path);
        }
        let relp = Path::new(rel);
        if relp
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            bail!("path escapes the browse root");
        }
        let joined = root_path.join(relp);
        // Symlinks could still point outside, so compare canonical paths.
        let canon = joined
            .canonicalize()
            .with_context(|| format!("no such path: {rel}"))?;
        if !canon.starts_with(&root_path) {
            bail!("path escapes the browse root");
        }
        Ok(canon)
    }

    /// One directory level, folders first, honouring .gitignore and skipping hidden files.
    pub fn entries(&self, id: &str, rel: &str) -> Result<Vec<Entry>> {
        let dir = self.resolve(id, rel)?;
        let prefix = rel.trim_matches('/');
        let mut out = vec![];
        let walker = ignore::WalkBuilder::new(&dir)
            .max_depth(Some(1))
            .parents(true)
            .git_ignore(true)
            .git_global(true)
            .require_git(false)
            .hidden(true)
            .follow_links(false)
            .build();
        for entry in walker.flatten() {
            if entry.depth() == 0 {
                continue;
            }
            let meta = entry.metadata().ok();
            let name = entry.file_name().to_string_lossy().to_string();
            out.push(Entry {
                path: if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                },
                dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                name,
            });
        }
        out.sort_by(|a, b| {
            b.dir
                .cmp(&a.dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    /// Render a file. Cached by path plus modification time, so an edit invalidates it.
    pub fn file(&self, id: &str, rel: &str, renderer: &Renderer) -> Result<FileView> {
        let path = self.resolve(id, rel)?;
        let meta = std::fs::metadata(&path)?;
        if meta.is_dir() {
            bail!("{rel} is a directory");
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        // A page or a PDF can also be shown as itself, framed at its own raw URL so
        // its relative assets resolve. The source view stays the default for pages.
        let preview = render::preview_kind(&ext);
        let view = |kind: &str, lang: Option<String>, html: String| FileView {
            kind: kind.to_string(),
            lang,
            html,
            path: rel.to_string(),
            name: name.clone(),
            size: meta.len(),
            modified,
            preview: preview.map(str::to_string),
            preview_url: preview.map(|_| raw_url(id, rel)),
        };

        if render::is_image_ext(&ext) {
            return Ok(view(
                "image",
                None,
                format!(
                    "<p class=\"browse-image\"><img src=\"{}\" alt=\"{}\" loading=\"lazy\"></p>",
                    raw_url(id, rel),
                    html_escape::encode_double_quoted_attribute(&name)
                ),
            ));
        }
        if meta.len() > MAX_RENDER_BYTES {
            return Ok(view(
                "large",
                None,
                render::placeholder(&format!(
                    "{} is {} MB, too large to display.",
                    name,
                    meta.len() / 1_048_576
                )),
            ));
        }

        let key = format!("{id}\u{0}{rel}\u{0}{modified}\u{0}{}", meta.len());
        if let Some(hit) = self.cache.lock().unwrap().iter().find(|(k, _)| *k == key) {
            let (kind, lang) = renderer.detect(Some(&path.to_string_lossy()), None, "");
            return Ok(view(kind.as_str(), lang, hit.1.clone()));
        }

        let bytes = std::fs::read(&path)?;
        // A PDF is for its viewer, not for reading as text, whether or not the first
        // block happens to hold a null byte.
        if preview == Some("pdf") || render::looks_binary(&bytes) {
            return Ok(view(
                "binary",
                None,
                render::placeholder(&render::describe_bytes(&name, meta.len())),
            ));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (kind, lang) = renderer.detect(Some(&path.to_string_lossy()), None, &text);
        // A browsed file keeps its own H1; there is no separate title to duplicate.
        let html = renderer.render(kind, lang.as_deref(), &text);

        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_ENTRIES {
            cache.remove(0);
        }
        cache.push((key, html.clone()));
        drop(cache);

        Ok(view(kind.as_str(), lang, html))
    }

    /// The file a root opens on: a README if there is one, else nothing.
    pub fn landing(&self, id: &str) -> Option<String> {
        let entries = self.entries(id, "").ok()?;
        entries
            .iter()
            .find(|e| !e.dir && e.name.to_lowercase().starts_with("readme."))
            .map(|e| e.path.clone())
    }

    /// Quick-open: every path under the root, capped, cached briefly.
    pub fn find(&self, id: &str, q: &str, limit: usize) -> Result<Vec<String>> {
        let all = self.paths(id)?;
        let q = q.trim().to_lowercase();
        if q.is_empty() {
            let mut v = all;
            v.truncate(limit);
            return Ok(v);
        }
        let mut hits: Vec<(u8, usize, String)> = all
            .into_iter()
            .filter_map(|p| {
                let lower = p.to_lowercase();
                let base = lower.rsplit('/').next().unwrap_or(&lower).to_string();
                let rank = if base.starts_with(&q) {
                    0
                } else if base.contains(&q) {
                    1
                } else if lower.contains(&q) {
                    2
                } else {
                    return None;
                };
                Some((rank, p.len(), p))
            })
            .collect();
        hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        hits.truncate(limit);
        Ok(hits.into_iter().map(|(_, _, p)| p).collect())
    }

    fn paths(&self, id: &str) -> Result<Vec<String>> {
        if let Some((at, list)) = self.index.lock().unwrap().get(id) {
            if at.elapsed() < FIND_TTL {
                return Ok(list.clone());
            }
        }
        let root = self.get(id).context("no such browse root")?;
        let root_path = PathBuf::from(&root.path);
        let mut out = vec![];
        for entry in ignore::WalkBuilder::new(&root_path)
            .parents(true)
            .git_ignore(true)
            .git_global(true)
            .require_git(false)
            .hidden(true)
            .follow_links(false)
            .build()
            .flatten()
        {
            if entry.depth() == 0 || entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&root_path) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if out.len() >= FIND_CAP {
                break;
            }
        }
        out.sort();
        self.index
            .lock()
            .unwrap()
            .insert(id.to_string(), (Instant::now(), out.clone()));
        Ok(out)
    }
}

/// The path-shaped raw URL for a file in a browsed root. Path-shaped rather than
/// `?path=`, so a framed page resolves `./style.css` to the file beside it.
fn raw_url(id: &str, rel: &str) -> String {
    format!("/api/browse/{id}/raw/{}", urlencode(rel))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tempdir::Dir;

    fn fixture() -> (Browser, Dir) {
        let d = Dir::new("snyvi-browse");
        std::fs::create_dir_all(d.path.join("src")).unwrap();
        std::fs::create_dir_all(d.path.join("node_modules/junk")).unwrap();
        std::fs::create_dir_all(d.path.join(".hidden")).unwrap();
        std::fs::write(d.path.join("README.md"), "# Title\n\nhello browse\n").unwrap();
        std::fs::write(d.path.join(".gitignore"), "node_modules/\nbuild.log\n").unwrap();
        std::fs::write(d.path.join("build.log"), "noise").unwrap();
        std::fs::write(d.path.join("src/main.rs"), "fn main() { let x = 1; }\n").unwrap();
        std::fs::write(d.path.join("node_modules/junk/x.js"), "junk").unwrap();
        std::fs::write(d.path.join(".hidden/secret"), "shh").unwrap();
        std::fs::write(d.path.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        std::fs::write(d.path.join("page.html"), "<h1>hi</h1>").unwrap();
        // No null byte in the header, so only the extension marks it as a PDF.
        std::fs::write(d.path.join("paper.pdf"), b"%PDF-1.4\n1 0 obj\n").unwrap();
        (Browser::new(), d)
    }

    #[test]
    fn lists_one_level_and_respects_ignores() {
        let (b, d) = fixture();
        let r = b.open(&d.path).unwrap();
        let names: Vec<String> = b
            .entries(&r.id, "")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(
            names.first().map(String::as_str),
            Some("src"),
            "directories sort first: {names:?}"
        );
        assert!(names.contains(&"README.md".to_string()));
        assert!(
            !names.contains(&"node_modules".to_string()),
            "gitignored: {names:?}"
        );
        assert!(
            !names.contains(&"build.log".to_string()),
            "gitignored: {names:?}"
        );
        assert!(!names.contains(&".hidden".to_string()), "hidden: {names:?}");
        let sub: Vec<String> = b
            .entries(&r.id, "src")
            .unwrap()
            .into_iter()
            .map(|e| e.path)
            .collect();
        assert_eq!(sub, vec!["src/main.rs"]);
    }

    #[test]
    fn renders_files_and_classifies_special_ones() {
        let (b, d) = fixture();
        let rn = Renderer::new();
        let r = b.open(&d.path).unwrap();
        let md = b.file(&r.id, "README.md", &rn).unwrap();
        assert_eq!(md.kind, "markdown");
        assert!(
            md.html.contains("<h1"),
            "browsed markdown keeps its own H1: {}",
            md.html
        );
        assert!(md.html.contains("hello browse"));
        let rs = b.file(&r.id, "src/main.rs", &rn).unwrap();
        assert_eq!(rs.kind, "code");
        assert!(rs.html.contains("class=\"k\""));
        let bin = b.file(&r.id, "blob.bin", &rn).unwrap();
        assert_eq!(bin.kind, "binary");
        assert!(bin.html.contains("binary file"));
        assert_eq!(b.landing(&r.id).as_deref(), Some("README.md"));

        // A page keeps its markup as the default view, and offers itself as a preview
        // at a path-shaped URL so its relative assets resolve beside it.
        let page = b.file(&r.id, "page.html", &rn).unwrap();
        assert_eq!(page.kind, "code");
        assert_eq!(page.preview.as_deref(), Some("html"));
        assert_eq!(
            page.preview_url.as_deref(),
            Some(format!("/api/browse/{}/raw/page.html", r.id).as_str())
        );

        // A PDF is for its viewer, not for reading as text, null byte or not.
        let pdf = b.file(&r.id, "paper.pdf", &rn).unwrap();
        assert_eq!(pdf.kind, "binary");
        assert_eq!(pdf.preview.as_deref(), Some("pdf"));
        assert!(pdf.html.contains("binary file"));

        // Everything else offers no preview at all.
        assert!(md.preview.is_none());
        assert!(bin.preview.is_none());
    }

    #[test]
    fn refuses_paths_outside_the_root() {
        let (b, d) = fixture();
        let r = b.open(&d.path).unwrap();
        for bad in ["../etc/passwd", "src/../../x", "/etc/passwd"] {
            assert!(b.resolve(&r.id, bad).is_err(), "{bad} should be refused");
        }
        assert!(b.resolve(&r.id, "src/main.rs").is_ok());
        assert!(b.resolve("nope", "README.md").is_err());
    }

    #[test]
    fn find_ranks_basename_matches_first_and_close_drops_the_root() {
        let (b, d) = fixture();
        let r = b.open(&d.path).unwrap();
        let hits = b.find(&r.id, "main", 10).unwrap();
        assert_eq!(hits, vec!["src/main.rs"]);
        assert!(b
            .find(&r.id, "", 10)
            .unwrap()
            .contains(&"README.md".to_string()));
        assert!(
            b.find(&r.id, "junk", 10).unwrap().is_empty(),
            "ignored files stay out of quick-open"
        );
        // Opening the same folder twice is the same root.
        assert_eq!(b.open(&d.path).unwrap().id, r.id);
        assert!(b.close(&r.id));
        assert!(!b.close(&r.id));
        assert!(b.list().is_empty());
    }
}
