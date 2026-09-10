//! The single entry point every transport ends up calling.

use crate::project;
use crate::render::{self, Kind, Renderer, HIGHLIGHT_CAP};
use crate::store::{Doc, NewDoc, Store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Payload {
    /// Absolute path to a file on disk; snyvi snapshots it.
    pub path: Option<String>,
    /// Inline content, when the document is not a file.
    pub content: Option<String>,
    pub title: Option<String>,
    /// Workflow name; defaults to the sender's session key.
    pub workflow: Option<String>,
    /// Language or format hint (md, rs, diff, ...).
    pub lang: Option<String>,
    /// The sender's working directory, used to find the project.
    pub cwd: Option<String>,
    /// Opaque session key from the sender, used as the default workflow.
    pub session: Option<String>,
    /// Who sent it: "mcp", "cli", or "hook". Hook sends of the same file are coalesced.
    pub origin: Option<String>,
}

pub struct Received {
    pub doc: Doc,
    /// A code document larger than the highlight cap: the stored HTML is partly plain
    /// and a full highlight should run in the background.
    pub needs_full_highlight: bool,
    /// True when an existing document was returned or overwritten instead of a new one.
    pub existing: bool,
}

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// Hook-driven edits to the same file within this window overwrite the latest snapshot.
const COALESCE_SECS: i64 = 180;

pub fn receive(store: &Store, renderer: &Renderer, p: Payload) -> Result<Received> {
    let (content, path) = match (&p.content, &p.path) {
        (Some(c), _) => (c.clone(), p.path.clone()),
        (None, Some(path)) => {
            let path = absolutize(path, p.cwd.as_deref());
            let bytes =
                std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            if bytes.len() > MAX_BYTES {
                bail!("file is larger than {} MB", MAX_BYTES / 1024 / 1024);
            }
            (
                String::from_utf8_lossy(&bytes).into_owned(),
                Some(path.to_string_lossy().to_string()),
            )
        }
        (None, None) => bail!("send_document needs either `path` or `content`"),
    };
    if content.len() > MAX_BYTES {
        bail!("content is larger than {} MB", MAX_BYTES / 1024 / 1024);
    }
    let origin = p.origin.as_deref().unwrap_or("cli");

    // Project: from the sender's cwd, else from the file's location.
    let anchor: PathBuf = p
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| path.as_deref().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
    let proj = project::resolve(&anchor);
    let root = proj.root.to_string_lossy().to_string();
    let branch = project::branch(&proj.root);

    // Same file, same bytes as the latest snapshot: hand back that document rather
    // than storing a duplicate (an explicit send after a hook send, or vice versa).
    let hash = blake3::hash(content.as_bytes()).to_hex().to_string();
    let latest_same_path = match &path {
        Some(sp) => store.latest_for_path(&root, sp)?,
        None => None,
    };
    if let Some(existing) = &latest_same_path {
        if existing.content_hash == hash {
            return Ok(Received {
                doc: existing.clone(),
                needs_full_highlight: false,
                existing: true,
            });
        }
    }

    let (kind, lang) = renderer.detect(path.as_deref(), p.lang.as_deref(), &content);
    let title = render::title_for(p.title.as_deref(), kind, path.as_deref(), &content);
    // The viewer shows the title as the page heading, so a leading H1 that *is* the title
    // would appear twice. Drop it from the rendered body only; the stored source is untouched.
    let body_src = if kind == Kind::Markdown {
        render::strip_leading_h1(&content, &title)
    } else {
        None
    };
    let html = renderer.render(
        kind,
        lang.as_deref(),
        body_src.as_deref().unwrap_or(&content),
    );
    let needs_full_highlight = kind == Kind::Code && content.len() > HIGHLIGHT_CAP;

    let (wf_key, wf_title) = match (&p.workflow, &p.session) {
        (Some(w), _) if !w.trim().is_empty() => (w.trim().to_string(), w.trim().to_string()),
        (_, Some(s)) if !s.trim().is_empty() => (s.trim().to_string(), title.clone()),
        _ => ("manual".to_string(), "Sent manually".to_string()),
    };

    let new_doc = NewDoc {
        project_root: &root,
        project_name: &proj.name,
        workflow_key: &wf_key,
        workflow_title: &wf_title,
        title: &title,
        kind,
        lang: lang.as_deref(),
        source_path: path.as_deref(),
        branch: branch.as_deref(),
        origin,
        source: &content,
        html: &html,
    };

    // A hook firing on every edit would otherwise fill a workflow with near-identical
    // snapshots; within a short window, overwrite the last one instead.
    if origin == "hook" {
        if let Some(prev) = &latest_same_path {
            let same_workflow = prev.workflow == wf_key;
            if prev.origin == "hook"
                && same_workflow
                && crate::store::now() - prev.received_at < COALESCE_SECS
            {
                let doc = store.replace(&prev.id, new_doc)?;
                return Ok(Received {
                    doc,
                    needs_full_highlight,
                    existing: true,
                });
            }
        }
    }

    let doc = store.insert(new_doc)?;
    Ok(Received {
        doc,
        needs_full_highlight,
        existing: false,
    })
}

fn absolutize(path: &str, cwd: Option<&str>) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd {
        Some(c) => Path::new(c).join(p),
        None => std::env::current_dir()
            .map(|d| d.join(p))
            .unwrap_or_else(|_| p.to_path_buf()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;
    use crate::store::tempdir::Dir;

    fn setup() -> (Store, Renderer, Dir) {
        let dir = Dir::new("snyvi-recv");
        let paths = Paths {
            data_dir: dir.path.clone(),
            config_dir: dir.path.clone(),
            docs_dir: dir.path.join("docs"),
            db_path: dir.path.join("t.db"),
            token_path: dir.path.join("token"),
        };
        (Store::open(&paths).unwrap(), Renderer::new(), dir)
    }

    #[test]
    fn inline_markdown_gets_title_from_h1_and_session_workflow() {
        let (s, r, _d) = setup();
        let p = Payload {
            content: Some("# My Plan\n\nbody".into()),
            session: Some("sess-1".into()),
            cwd: Some("/tmp".into()),
            ..Default::default()
        };
        let got = receive(&s, &r, p).unwrap();
        assert_eq!(got.doc.title, "My Plan");
        assert_eq!(got.doc.workflow, "sess-1");
        assert_eq!(got.doc.workflow_title, "My Plan");
        assert!(!got.existing);
        let html = s.html(&got.doc.id).unwrap();
        assert!(
            !html.contains("<h1"),
            "leading H1 stripped from body: {html}"
        );
        assert!(html.contains("<p>body</p>"));
    }

    #[test]
    fn path_send_dedups_identical_content_and_coalesces_hook_edits() {
        let (s, r, d) = setup();
        let file = d.path.join("NOTES.md");
        std::fs::write(&file, "# Notes\n\nv1").unwrap();
        let path = file.to_string_lossy().to_string();
        let cwd = d.path.to_string_lossy().to_string();
        let mk = |origin: &str| Payload {
            path: Some(path.clone()),
            cwd: Some(cwd.clone()),
            session: Some("s".into()),
            origin: Some(origin.into()),
            ..Default::default()
        };

        let first = receive(&s, &r, mk("hook")).unwrap();
        let again = receive(&s, &r, mk("mcp")).unwrap();
        assert!(again.existing);
        assert_eq!(
            again.doc.id, first.doc.id,
            "identical bytes are not stored twice"
        );

        std::fs::write(&file, "# Notes\n\nv2").unwrap();
        let edited = receive(&s, &r, mk("hook")).unwrap();
        assert!(edited.existing, "hook edit within the window overwrites");
        assert_eq!(edited.doc.id, first.doc.id);
        assert_eq!(s.source(&first.doc.id).unwrap(), "# Notes\n\nv2");

        std::fs::write(&file, "# Notes\n\nv3").unwrap();
        let explicit = receive(&s, &r, mk("mcp")).unwrap();
        assert!(
            !explicit.existing,
            "an explicit send is always a new version"
        );
        assert_ne!(explicit.doc.id, first.doc.id);
        assert_eq!(s.count().unwrap(), 2);
    }

    #[test]
    fn missing_input_is_an_error() {
        let (s, r, _d) = setup();
        assert!(receive(&s, &r, Payload::default()).is_err());
    }
}
