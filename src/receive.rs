//! The single entry point every transport ends up calling.

use crate::project;
use crate::render::{self, Renderer};
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
}

pub const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn receive(store: &Store, renderer: &Renderer, p: Payload) -> Result<Doc> {
    let (content, path) = match (&p.content, &p.path) {
        (Some(c), _) => (c.clone(), p.path.clone()),
        (None, Some(path)) => {
            let path = absolutize(path, p.cwd.as_deref());
            let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            if bytes.len() > MAX_BYTES {
                bail!("file is larger than {} MB", MAX_BYTES / 1024 / 1024);
            }
            (String::from_utf8_lossy(&bytes).into_owned(), Some(path.to_string_lossy().to_string()))
        }
        (None, None) => bail!("send_document needs either `path` or `content`"),
    };
    if content.len() > MAX_BYTES {
        bail!("content is larger than {} MB", MAX_BYTES / 1024 / 1024);
    }

    // Project: from the sender's cwd, else from the file's location.
    let anchor: PathBuf = p
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| path.as_deref().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
    let proj = project::resolve(&anchor);
    let branch = project::branch(&proj.root);

    let (kind, lang) = renderer.detect(path.as_deref(), p.lang.as_deref(), &content);
    let title = render::title_for(p.title.as_deref(), kind, path.as_deref(), &content);
    // The viewer shows the title as the page heading, so a leading H1 that *is* the title
    // would appear twice. Drop it from the rendered body only; the stored source is untouched.
    let body_src = if kind == render::Kind::Markdown { render::strip_leading_h1(&content, &title) } else { None };
    let html = renderer.render(kind, lang.as_deref(), body_src.as_deref().unwrap_or(&content));

    let (wf_key, wf_title) = match (&p.workflow, &p.session) {
        (Some(w), _) if !w.trim().is_empty() => (w.trim().to_string(), w.trim().to_string()),
        (_, Some(s)) if !s.trim().is_empty() => (s.trim().to_string(), title.clone()),
        _ => ("manual".to_string(), "Sent manually".to_string()),
    };

    store.insert(NewDoc {
        project_root: &proj.root.to_string_lossy(),
        project_name: &proj.name,
        workflow_key: &wf_key,
        workflow_title: &wf_title,
        title: &title,
        kind,
        lang: lang.as_deref(),
        source_path: path.as_deref(),
        branch: branch.as_deref(),
        source: &content,
        html: &html,
    })
}

fn absolutize(path: &str, cwd: Option<&str>) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd {
        Some(c) => Path::new(c).join(p),
        None => std::env::current_dir().map(|d| d.join(p)).unwrap_or_else(|_| p.to_path_buf()),
    }
}
