//! The single entry point every transport ends up calling.

use crate::project;
use crate::render::{self, Kind, Renderer, HIGHLIGHT_CAP};
use crate::store::{Doc, NewDoc, Staged, Store};
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
    /// Who sent it: "mcp", "cli", "hook" or "watch". Hook and watch sends of the same
    /// file are coalesced.
    pub origin: Option<String>,
    /// The MCP client's name from its `initialize`, so the connect page can
    /// say when an agent last sent something.
    #[serde(default)]
    pub sender: Option<String>,
    /// The pane it was sent from: `SNYVI_SESSION`, which a pane puts in its
    /// child's environment and the sending client reads out of its own. The
    /// daemon cannot read it -- it sees its own environment, not the
    /// sender's -- so it travels here. Sixteen random bytes: a process that
    /// was not started in the pane cannot name it.
    #[serde(default)]
    pub pane: Option<String>,
    /// A friend's document, opened by `crate::peer` from a frame their key
    /// signed. Never on the wire: a send cannot claim to be from a friend.
    #[serde(skip)]
    pub peer: Option<FromPeer>,
}

/// What a frame from a friend carries into `receive`: who, and the bytes.
#[derive(Clone, Debug, Default)]
pub struct FromPeer {
    pub name: String,
    pub sign_key: String,
    pub bytes: Vec<u8>,
    /// The sender's file name, if the document was a file there: only its
    /// extension is used, to tell a picture from a page.
    pub file: Option<String>,
    /// The desk the reader gave this friend, and its folder: the document
    /// lands in that desk's project and on its list, not on their own row.
    pub desk: Option<(crate::desk::Origin, String)>,
}

pub struct Received {
    pub doc: Doc,
    /// A code document larger than the highlight cap: the stored HTML is partly plain
    /// and a full highlight should run in the background.
    pub needs_full_highlight: bool,
    /// True when an existing document was returned or overwritten instead of a new one.
    pub existing: bool,
    /// The document this one is a new version of: the id that was the newest
    /// snapshot of this file until now. Set only when a row was inserted, so it
    /// names a document that is still in the library and is no longer the one
    /// its lists show. A reader with that id open is reading a version.
    pub supersedes: Option<String>,
}

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// Video and audio sent by path. They are copied and served a range at a
/// time, never held, so the cap is about the disk rather than memory.
pub const MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024;
/// Automatic sends of the same file within this window overwrite the latest snapshot.
const COALESCE_SECS: i64 = 180;
/// How much of a document's text goes into the search index: the first half
/// megabyte, like the outline's cap. A 32 MB log is searched by the thing
/// it is about, which is at the top; indexing all of it is what made a save
/// of it cost a re-tokenise of all of it.
pub const SEARCH_CAP: usize = 512 * 1024;

/// The text that is indexed: the whole of it up to `SEARCH_CAP`, cut on a
/// character boundary.
pub fn search_text(text: &str) -> &str {
    if text.len() <= SEARCH_CAP {
        return text;
    }
    let mut end = SEARCH_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Sends nobody asked for one at a time: the Claude Code hook fires on every edit,
/// `snyvi watch` on every save. They coalesce with each other.
fn automatic(origin: &str) -> bool {
    matches!(origin, "hook" | "watch")
}

/// What arrived, read: `bytes` is what gets stored; `text` is the decoded
/// view of it, empty when there is no text to decode. Reading a file as UTF-8
/// unconditionally is how a PNG used to become a document full of mojibake.
///
/// A video or a song is `staged` instead: copied into the store as it is
/// hashed, with `bytes` left empty.
struct Body {
    bytes: Vec<u8>,
    text: String,
    path: Option<String>,
    staged: Option<Staged>,
}

fn read(store: &Store, p: &Payload) -> Result<Body> {
    let body = match (&p.content, &p.path) {
        // A friend's bytes, as they came: a picture stays bytes, a page is
        // text. No path is read -- the file name is a hint and nothing more.
        _ if p.peer.is_some() => {
            let fp = p.peer.as_ref().unwrap();
            let name = fp.file.as_deref().unwrap_or("");
            let ext = render::ext_of(name);
            let opaque = render::is_image_ext(&ext)
                || render::preview_kind(&ext) == Some("pdf")
                || render::looks_binary(&fp.bytes);
            Body {
                text: if opaque {
                    String::new()
                } else {
                    String::from_utf8_lossy(&fp.bytes).into_owned()
                },
                bytes: fp.bytes.clone(),
                // The name alone, as the path: it tells a picture from a page,
                // and a second send of the same file lands as a version.
                path: fp.file.clone().filter(|f| !f.trim().is_empty()),
                staged: None,
            }
        }
        (Some(c), _) => Body {
            bytes: c.clone().into_bytes(),
            text: c.clone(),
            path: p.path.clone(),
            staged: None,
        },
        (None, Some(path)) => {
            let path = absolutize(path, p.cwd.as_deref());
            let sp = path.to_string_lossy().to_string();
            if render::media_kind(&render::ext_of(&sp)).is_some() {
                Body {
                    bytes: Vec::new(),
                    text: String::new(),
                    path: Some(sp),
                    staged: Some(store.stage(&path, MAX_MEDIA_BYTES)?),
                }
            } else {
                let bytes =
                    std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
                if bytes.len() > MAX_BYTES {
                    bail!("file is larger than {} MB", MAX_BYTES / 1024 / 1024);
                }
                let ext = render::ext_of(&sp);
                // Images, PDFs and anything that will not decode are kept as bytes.
                let opaque = render::is_image_ext(&ext)
                    || render::preview_kind(&ext) == Some("pdf")
                    || render::looks_binary(&bytes);
                let text = if opaque {
                    String::new()
                } else {
                    String::from_utf8_lossy(&bytes).into_owned()
                };
                Body {
                    bytes,
                    text,
                    path: Some(sp),
                    staged: None,
                }
            }
        }
        (None, None) => bail!("send_document needs either `path` or `content`"),
    };
    if body.bytes.len() > MAX_BYTES {
        bail!("content is larger than {} MB", MAX_BYTES / 1024 / 1024);
    }
    Ok(body)
}

/// What kind of document it is. An image is known by its extension; anything
/// else undecodable is just binary.
fn classify(renderer: &Renderer, b: &Body, lang: Option<&str>) -> (Kind, Option<String>) {
    match renderer.detect(b.path.as_deref(), lang, &b.text) {
        // Played only from a copy that was streamed in, whatever language it
        // was labelled. Inline text that names a video file is still text.
        _ if b.staged.is_some() => {
            let ext = render::ext_of(b.path.as_deref().unwrap_or_default());
            match render::media_kind(&ext) {
                Some("video") => (Kind::Video, Some(ext)),
                _ => (Kind::Audio, Some(ext)),
            }
        }
        (Kind::Video | Kind::Audio, _) => (Kind::Text, None),
        (_, lang) if !b.text.is_empty() && render::looks_binary(&b.bytes) => (Kind::Binary, lang),
        (Kind::Image, lang) => (Kind::Image, lang),
        _ if b.text.is_empty() && !b.bytes.is_empty() => (Kind::Binary, None),
        other => other,
    }
}

/// The page for document `id`: rendered, or a frame around the bytes served
/// back.
fn page(
    renderer: &Renderer,
    b: &Body,
    id: &str,
    kind: Kind,
    lang: Option<&str>,
    title: &str,
) -> String {
    // The viewer shows the title as the page heading, so a leading H1 that *is* the title
    // would appear twice. Drop it from the rendered body only; the stored source is untouched.
    let body_src = if kind == Kind::Markdown {
        render::strip_leading_h1(&b.text, title)
    } else {
        None
    };
    let file_base = b.path.as_ref().map(|_| format!("/files/{id}/"));
    match kind {
        // The bytes are the document; serve them back rather than rendering them.
        Kind::Image => render::image_body(&format!("/api/docs/{id}/blob"), title),
        Kind::Video | Kind::Audio => render::media_body(
            &format!("/api/docs/{id}/blob"),
            &render::ext_of(b.path.as_deref().unwrap_or_default()),
        ),
        Kind::Binary => render::placeholder(&render::describe_bytes(title, b.bytes.len() as u64)),
        _ => renderer.render_with_base(
            kind,
            lang,
            body_src.as_deref().unwrap_or(&b.text),
            file_base.as_deref(),
        ),
    }
}

/// The workflow a document joins, and that workflow's title.
///
/// Keys are matched case-insensitively: "KSI pivot" and "ksi pivot" are one
/// workflow, not two. The title keeps whatever casing arrived first.
/// A plan the hook sent as Claude asked for approval (`crate::hook`) is
/// filed under the desk it was made on, or its project: a plan is looked
/// for by where the work is, not by which conversation wrote it.
fn workflow(
    p: &Payload,
    origin: &str,
    from: Option<&crate::desk::Origin>,
    project: &str,
    title: &str,
) -> (String, String) {
    let plan_home = (origin == "plan" && p.workflow.is_none()).then(|| {
        from.map(|o| o.name.clone())
            .unwrap_or_else(|| project.to_string())
    });
    if let Some(fp) = &p.peer {
        return ("sent".to_string(), format!("Sent by {}", fp.name));
    }
    match (plan_home.as_ref().or(p.workflow.as_ref()), &p.session) {
        (Some(w), _) if !w.trim().is_empty() => (w.trim().to_string(), w.trim().to_string()),
        (_, Some(s)) if !s.trim().is_empty() => (s.trim().to_string(), title.to_string()),
        _ => ("manual".to_string(), "Sent manually".to_string()),
    }
}

/// The project a document goes to, as (root, name, branch): from the
/// sender's cwd, else from the file's location. A friend's document goes to
/// the friend's own project, whose root is no folder on this machine
/// (`peer::Peer::project_root`), so the sidebar gains one row per friend and
/// nothing else -- or, when the reader gave them a desk, to that desk's.
fn place(p: &Payload, b: &Body) -> (String, String, Option<String>) {
    if let Some((_, root)) = p.peer.as_ref().and_then(|fp| fp.desk.as_ref()) {
        return desk_project(root);
    }
    if let Some(fp) = &p.peer {
        return (
            format!("peer:{}", fp.sign_key),
            format!("From {}", fp.name),
            None,
        );
    }
    let anchor: PathBuf = p
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| b.path.as_deref().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
    let proj = project::resolve(&anchor);
    let branch = project::branch(&proj.root);
    (proj.root.to_string_lossy().to_string(), proj.name, branch)
}

/// The project a desk's folder is, as `place` gives it: what a friend's
/// document kept on that desk joins.
pub fn desk_project(root: &str) -> (String, String, Option<String>) {
    let proj = project::resolve(Path::new(root));
    let branch = project::branch(&proj.root);
    (proj.root.to_string_lossy().to_string(), proj.name, branch)
}

/// The desk and slot a sender's pane is on, when it names one snyvi knows. A
/// pane it does not know is no reason to refuse what was sent.
pub fn pane_origin(store: &Store, pane: Option<&str>) -> Option<crate::desk::Origin> {
    pane.filter(|id| crate::pane::valid_id(id))
        .and_then(|id| store.pane(id).ok().flatten())
        .map(|placed| crate::desk::Origin {
            id: placed.desk_id,
            name: placed.desk_name,
            slot: placed.pane.slot,
        })
}

pub fn receive(store: &Store, renderer: &Renderer, p: Payload) -> Result<Received> {
    let b = read(store, &p)?;
    let origin = p.origin.as_deref().unwrap_or("cli");
    // Attribution only. Which workflow a document joins is still the
    // session's, as it always was; the pane says where it was sent from.
    let from = pane_origin(store, p.pane.as_deref()).or_else(|| {
        p.peer
            .as_ref()
            .and_then(|fp| fp.desk.as_ref().map(|(o, _)| o.clone()))
    });

    let (root, proj_name, branch) = place(&p, &b);

    // Same file, same bytes as the latest snapshot: hand back that document rather
    // than storing a duplicate (an explicit send after a hook send, or vice versa).
    let hash = match &b.staged {
        Some(st) => st.hash.clone(),
        None => blake3::hash(&b.bytes).to_hex().to_string(),
    };
    let latest_same_path = match &b.path {
        Some(sp) => store.latest_for_path(&root, sp)?,
        None => None,
    };
    if let Some(existing) = &latest_same_path {
        if existing.content_hash == hash {
            return Ok(Received {
                doc: existing.clone(),
                needs_full_highlight: false,
                existing: true,
                supersedes: None,
            });
        }
    }

    let (kind, lang) = classify(renderer, &b, p.lang.as_deref());
    let title = render::title_for(p.title.as_deref(), kind, b.path.as_deref(), &b.text);

    let (wf_name, wf_title) = workflow(&p, origin, from.as_ref(), &proj_name, &title);

    // A hook firing on every edit would otherwise fill a workflow with near-identical
    // snapshots; within a short window, overwrite the last one instead.
    let wf_key = wf_name.to_lowercase();

    let coalesce_into = match (origin, &latest_same_path) {
        (o, Some(prev))
            if automatic(o)
                && automatic(&prev.origin)
                && prev.workflow == wf_key
                && crate::store::now() - prev.received_at < COALESCE_SECS =>
        {
            Some(prev.id.clone())
        }
        _ => None,
    };
    // The id is fixed before rendering so relative image URLs can point at /files/<id>/.
    let id = coalesce_into
        .clone()
        .unwrap_or_else(|| crate::store::new_id(&hash));
    let html = page(renderer, &b, &id, kind, lang.as_deref(), &title);
    let needs_full_highlight = kind == Kind::Code && b.text.len() > HIGHLIGHT_CAP;

    let new_doc = NewDoc {
        project_root: &root,
        project_name: &proj_name,
        workflow_key: &wf_key,
        workflow_title: &wf_title,
        title: &title,
        kind,
        lang: lang.as_deref(),
        source_path: b.path.as_deref(),
        branch: branch.as_deref(),
        origin,
        sender: p.sender.as_deref().unwrap_or(""),
        desk: from.as_ref(),
        source: &b.bytes,
        staged: b.staged.as_ref(),
        search_body: search_text(&b.text),
        html: &html,
    };

    if coalesce_into.is_some() {
        let doc = store.replace(&id, new_doc)?;
        return Ok(Received {
            doc,
            needs_full_highlight,
            existing: true,
            supersedes: None,
        });
    }
    // What this one is a version of, before it becomes the newest itself.
    let supersedes = latest_same_path.as_ref().map(|prev| prev.id.clone());
    let doc = store.insert(&id, new_doc)?;
    Ok(Received {
        doc,
        needs_full_highlight,
        existing: false,
        supersedes,
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

    /// What goes into the search index stops at the cap, on a character,
    /// so a 32 MB log costs a save half a megabyte of tokenising and not
    /// all of it.
    #[test]
    fn the_indexed_text_is_capped_on_a_character() {
        let short = "a plan";
        assert_eq!(search_text(short), short);
        let long = "é".repeat(SEARCH_CAP);
        let cut = search_text(&long);
        assert!(cut.len() <= SEARCH_CAP);
        assert!(cut.len() >= SEARCH_CAP - 1);
        assert!(cut.chars().all(|c| c == 'é'));
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
        // ...and it says what it is a new version of, so a reader sitting on
        // the old one is offered the new rather than moved to it.
        assert_eq!(explicit.supersedes.as_deref(), Some(first.doc.id.as_str()));
        assert!(
            again.supersedes.is_none(),
            "the same bytes supersede nothing"
        );
        assert!(
            edited.supersedes.is_none(),
            "nor does an overwrite in place"
        );

        // `snyvi watch` is automatic too: its saves overwrite, and it overwrites the
        // hook's snapshot as readily as its own.
        std::fs::write(&file, "# Notes\n\nv4").unwrap();
        let watched = receive(&s, &r, mk("watch")).unwrap();
        assert!(!watched.existing, "a watch send after an mcp send is new");
        assert_eq!(
            watched.supersedes.as_deref(),
            Some(explicit.doc.id.as_str())
        );
        std::fs::write(&file, "# Notes\n\nv5").unwrap();
        let again = receive(&s, &r, mk("watch")).unwrap();
        assert!(again.existing);
        assert_eq!(again.doc.id, watched.doc.id);
        std::fs::write(&file, "# Notes\n\nv6").unwrap();
        let hooked = receive(&s, &r, mk("hook")).unwrap();
        assert!(hooked.existing, "hook and watch coalesce with each other");
        assert_eq!(hooked.doc.id, watched.doc.id);
        assert_eq!(s.source(&watched.doc.id).unwrap(), "# Notes\n\nv6");
        assert_eq!(s.count().unwrap(), 3);
    }

    #[test]
    fn images_keep_their_bytes_and_binaries_are_described() {
        let (s, r, d) = setup();
        let cwd = d.path.to_string_lossy().to_string();
        // A 1x1 PNG: a real signature, and a null byte early enough to be seen.
        let png: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01";
        let img = d.path.join("shot.png");
        std::fs::write(&img, png).unwrap();
        let got = receive(
            &s,
            &r,
            Payload {
                path: Some(img.to_string_lossy().to_string()),
                cwd: Some(cwd.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(got.doc.kind, Kind::Image);
        assert_eq!(
            std::fs::read(s.src_path(&got.doc.id)).unwrap(),
            png,
            "the stored bytes are the file, not a lossy decode"
        );
        let html = s.html(&got.doc.id).unwrap();
        assert!(html.contains("<img"), "an image document displays: {html}");
        assert!(html.contains(&format!("/api/docs/{}/blob", got.doc.id)));

        // Anything else undecodable is described rather than rendered as mojibake.
        let blob = d.path.join("sheet.xlsx");
        std::fs::write(&blob, b"PK\x03\x04\x00\x00rest of a zip").unwrap();
        let got = receive(
            &s,
            &r,
            Payload {
                path: Some(blob.to_string_lossy().to_string()),
                cwd: Some(cwd),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(got.doc.kind, Kind::Binary);
        let html = s.html(&got.doc.id).unwrap();
        assert!(
            html.contains("binary file"),
            "described, not decoded: {html}"
        );
        assert!(
            !html.contains("PK"),
            "the bytes never reach the page: {html}"
        );
    }

    /// A video sent by path is copied in by streaming, not read whole, and
    /// shows as a player. Sending the same bytes again leaves no stray copy.
    #[test]
    fn media_is_staged_into_the_store_and_played() {
        let (s, r, d) = setup();
        let cwd = d.path.to_string_lossy().to_string();
        let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let clip = d.path.join("clip.mp4");
        std::fs::write(&clip, &bytes).unwrap();
        let send = |p: &std::path::Path| Payload {
            path: Some(p.to_string_lossy().to_string()),
            cwd: Some(cwd.clone()),
            lang: Some("rust".into()),
            ..Default::default()
        };
        let got = receive(&s, &r, send(&clip)).unwrap();
        assert_eq!(
            got.doc.kind,
            Kind::Video,
            "a language hint does not unmake a video"
        );
        assert_eq!(got.doc.size, bytes.len() as i64);
        assert_eq!(
            got.doc.content_hash,
            blake3::hash(&bytes).to_hex().to_string()
        );
        assert_eq!(std::fs::read(s.src_path(&got.doc.id)).unwrap(), bytes);
        let html = s.html(&got.doc.id).unwrap();
        assert!(
            html.contains("<video") && html.contains(&format!("/api/docs/{}/blob", got.doc.id)),
            "{html}"
        );

        let again = receive(&s, &r, send(&clip)).unwrap();
        assert!(again.existing);
        let stray = std::fs::read_dir(d.path.join("docs"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
            .count();
        assert_eq!(stray, 0, "an unused copy is removed");

        let song = d.path.join("take.ogg");
        std::fs::write(&song, b"OggS\x00\x02").unwrap();
        let got = receive(&s, &r, send(&song)).unwrap();
        assert_eq!(got.doc.kind, Kind::Audio);
        assert!(s.html(&got.doc.id).unwrap().contains("<audio"));

        // Past the cap it is refused by name, and nothing is left behind.
        let err = s.stage(&clip, 1000).unwrap_err().to_string();
        assert!(
            err.contains("clip.mp4") && err.contains("snyvi browse"),
            "{err}"
        );

        // Text that only names a video file is still text.
        let got = receive(
            &s,
            &r,
            Payload {
                content: Some("notes about the cut".into()),
                path: Some(clip.to_string_lossy().to_string()),
                cwd: Some(cwd.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(got.doc.kind, Kind::Text);
    }

    /// A friend's document goes to the friend's own project, under their
    /// name, from the bytes the frame carried and no file on this machine.
    #[test]
    fn a_friends_document_lands_in_their_project() {
        let (s, r, _d) = setup();
        let from = FromPeer {
            name: "Trapti".into(),
            sign_key: "KEY".into(),
            bytes: b"# Garden\n\nbeans".to_vec(),
            file: Some("garden.md".into()),
            desk: None,
        };
        let got = receive(
            &s,
            &r,
            Payload {
                title: Some("Garden".into()),
                origin: Some("peer".into()),
                sender: Some("Trapti".into()),
                peer: Some(from.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(got.doc.project, "From Trapti");
        assert_eq!(got.doc.workflow_title, "Sent by Trapti");
        assert_eq!(got.doc.origin, "peer");
        assert_eq!(got.doc.sender, "Trapti");
        assert_eq!(got.doc.kind, Kind::Markdown);
        assert_eq!(
            s.project_root(got.doc.project_id).as_deref(),
            Some("peer:KEY")
        );
        assert!(s.html(&got.doc.id).unwrap().contains("beans"));
        // The sidebar is told it is a friend's row, and given no root: the
        // page offers nothing that would act on a folder.
        let row = &s.projects().unwrap()[0];
        assert!(row.friend);
        assert_eq!(row.root, "");
        let json = serde_json::to_value(row).unwrap();
        assert_eq!(json["friend"], true);
        // The same bytes again: the same row. New bytes: a new version of it.
        let again = receive(
            &s,
            &r,
            Payload {
                origin: Some("peer".into()),
                peer: Some(from.clone()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(again.existing);
        let mut v2 = from.clone();
        v2.bytes = b"# Garden\n\npeas".to_vec();
        let newer = receive(
            &s,
            &r,
            Payload {
                origin: Some("peer".into()),
                peer: Some(v2),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(newer.supersedes.as_deref(), Some(got.doc.id.as_str()));
        // A picture stays a picture.
        let png = FromPeer {
            bytes: b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec(),
            file: Some("shot.png".into()),
            ..from
        };
        let pic = receive(
            &s,
            &r,
            Payload {
                origin: Some("peer".into()),
                peer: Some(png),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(pic.doc.kind, Kind::Image);
    }

    /// A friend the reader gave a desk: their document joins that desk's
    /// project and its list, and still says who sent it.
    #[test]
    fn a_friends_document_lands_on_their_desk_when_they_have_one() {
        let (s, r, _d) = setup();
        let garden = Dir::new("snyvi-recv-garden");
        std::fs::create_dir_all(garden.path.join(".git")).unwrap();
        let at = crate::desk::Origin {
            id: 3,
            name: "Garden".into(),
            slot: 0,
        };
        let got = receive(
            &s,
            &r,
            Payload {
                origin: Some("peer".into()),
                sender: Some("Trapti".into()),
                peer: Some(FromPeer {
                    name: "Trapti".into(),
                    sign_key: "KEY".into(),
                    bytes: b"# Seeds\n\nbeans".to_vec(),
                    file: Some("seeds.md".into()),
                    desk: Some((at.clone(), garden.path.to_string_lossy().to_string())),
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let (root, _, _) = desk_project(&garden.path.to_string_lossy());
        assert_eq!(s.project_root(got.doc.project_id).as_deref(), Some(root.as_str()));
        assert_eq!(got.doc.desk, Some(at));
        assert_eq!(got.doc.origin, "peer");
        assert_eq!(got.doc.sender, "Trapti");
        assert!(!s.projects().unwrap()[0].friend, "the desk's own row");
    }

    #[test]
    fn missing_input_is_an_error() {
        let (s, r, _d) = setup();
        assert!(receive(&s, &r, Payload::default()).is_err());
    }
}
