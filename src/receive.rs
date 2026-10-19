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
    /// The desk it lands on, and that desk's folder: the one open on the
    /// reader's folder it was filed into, or the one the reader gave this
    /// friend. The document joins that desk's project and its list, not the
    /// friend's own row.
    pub desk: Option<(crate::desk::Origin, String)>,
    /// The reader's own folder for the repository the frame is about
    /// (`api_peer::file_into`): the project it lands in, desk or no desk.
    pub root: Option<String>,
    /// What it is a version of, in that project: its path in the repository,
    /// a key for a file outside one, or the name (`api_peer::lineage`).
    /// Stored as the document's `source_path`, which is what versions are
    /// told apart by; never read as a path on this machine.
    pub lineage: Option<String>,
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
    /// A draft the hook saved: listed on its desk and in its project, and
    /// nothing more -- no notification, no place on the queue, no wash. Only
    /// a send someone meant asks for the reader (`quiet`).
    pub quiet: bool,
    /// The hook's draft of these same bytes, taken over by this send: an
    /// arrival, though no row was inserted (`Store::promote`).
    pub promoted: bool,
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

/// Saved by the hook as Claude wrote it, not sent: a draft, until the agent
/// sends it (audit bf13a1859b, decision R3). `snyvi watch` is automatic too,
/// but the reader started it for the file, and it stays loud.
fn quiet(origin: &str) -> bool {
    origin == "hook"
}

/// A send someone meant, which takes over the hook's draft of the same bytes.
fn explicit(origin: &str) -> bool {
    matches!(origin, "mcp" | "cli" | "plan")
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
                // Where it is in the repository, or the name alone, as the
                // path: a second send of the same file lands as a version.
                path: fp
                    .lineage
                    .clone()
                    .or_else(|| fp.file.clone())
                    .filter(|f| !f.trim().is_empty()),
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
    text: &str,
    id: &str,
    kind: Kind,
    lang: Option<&str>,
    title: &str,
) -> String {
    // The viewer shows the title as the page heading, so a leading H1 that *is* the title
    // would appear twice. Drop it from the rendered body only; the stored source is untouched.
    let body_src = if kind == Kind::Markdown {
        render::strip_leading_h1(text, title)
    } else {
        None
    };
    let file_base = b.path.as_ref().map(|_| format!("/files/{id}/"));
    match kind {
        // The bytes are the document; serve them back rather than rendering them.
        Kind::Image => render::image_body(&format!("/api/docs/{id}/blob"), title),
        Kind::Video | Kind::Audio => {
            let ext = render::ext_of(b.path.as_deref().unwrap_or_default());
            let size = render::media_size(&ext, std::io::Cursor::new(&b.bytes));
            render::media_body(&format!("/api/docs/{id}/blob"), &ext, size)
        }
        Kind::Binary => render::placeholder(&render::describe_bytes(title, b.bytes.len() as u64)),
        _ => renderer.render_with_files(
            kind,
            lang,
            body_src.as_deref().unwrap_or(text),
            file_base.as_deref(),
            b.path.as_deref().and_then(|p| Path::new(p).parent()),
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
/// A desk's folder is the floor of the walk up (`project::resolve_on_desk`):
/// the sending pane's desk, else the deepest desk the folder is in.
fn place(store: &Store, p: &Payload, b: &Body) -> (String, String, Option<String>) {
    if let Some(root) = p.peer.as_ref().and_then(|fp| fp.root.as_ref()) {
        return desk_project(root);
    }
    if let Some((_, root)) = p.peer.as_ref().and_then(|fp| fp.desk.as_ref()) {
        return desk_project(root);
    }
    if let Some(fp) = &p.peer {
        return (
            format!("peer:{}", fp.sign_key),
            crate::peer::from_name(&fp.name),
            None,
        );
    }
    let anchor: PathBuf = p
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| b.path.as_deref().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
    let proj = match desk_floor(store, p.pane.as_deref(), &anchor) {
        Some(desk) => project::resolve_on_desk(&anchor, &desk),
        None => project::resolve(&anchor),
    };
    let branch = project::branch(&proj.root);
    (proj.root.to_string_lossy().to_string(), proj.name, branch)
}

/// The desk folder a sender's walk up stops at: its pane's desk when it was
/// sent from one, else the deepest desk whose folder holds `anchor` -- Claude
/// in the reader's own terminal, in a desk's folder, files where the desk's
/// panes would.
fn desk_floor(store: &Store, pane: Option<&str>, anchor: &Path) -> Option<PathBuf> {
    if let Some(placed) = pane
        .filter(|id| crate::pane::valid_id(id))
        .and_then(|id| store.pane(id).ok().flatten())
    {
        return Some(PathBuf::from(placed.root));
    }
    let anchor = anchor
        .canonicalize()
        .unwrap_or_else(|_| anchor.to_path_buf());
    store
        .desks()
        .ok()?
        .into_iter()
        .filter_map(|d| PathBuf::from(&d.root).canonicalize().ok())
        .filter(|r| anchor.starts_with(r))
        .max_by_key(|r| r.components().count())
}

/// The project a desk's folder is, as `place` gives it: what a friend's
/// document kept on that desk joins.
pub fn desk_project(root: &str) -> (String, String, Option<String>) {
    let proj = project::resolve_on_desk(Path::new(root), Path::new(root));
    let branch = project::branch(&proj.root);
    (proj.root.to_string_lossy().to_string(), proj.name, branch)
}

/// The store as the daemon opens it, with what a desk sent before its folder
/// bounded the walk up moved out of the folder above it. Once it has run
/// there is nothing left for it to find.
pub fn refiled(store: Store) -> Store {
    match refile_desks(&store) {
        Ok(0) => {}
        Ok(n) => eprintln!("snyvi: {n} document(s) moved to the desk they came from"),
        Err(e) => eprintln!("snyvi: refiling documents onto their desks: {e:#}"),
    }
    store
}

/// Move what a desk sent out of a project above the desk's folder and into
/// the desk's own (`store::refile`): what `place` files there now, done once
/// for what came before it. Nothing is deleted or re-dated; each document
/// keeps its versions, workflow and desk. A project left with nothing in it
/// leaves the sidebar, as an emptied one always has. How many moved.
pub fn refile_desks(store: &Store) -> Result<usize> {
    let mut moved = 0;
    for d in store.docs_on_desks()? {
        let (root, name, _) = desk_project(&d.desk_root);
        let (to, from) = (Path::new(&root), Path::new(&d.project_root));
        if to != from
            && to.starts_with(from)
            && store.move_lineage(&d.id, &root, &name, &d.desk)?.is_some()
        {
            if d.off != 0 {
                store.keep_desk_off(&d.id, d.off)?;
            }
            moved += 1;
        }
    }
    Ok(moved)
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

/// The desk a document sent from outside any panel belongs on: the first
/// desk, in the reader's order, whose folder is the document's project --
/// Claude in the reader's own terminal, `snyvi send` from the folder. Placed
/// with slot 0, which the rail reads as "this desk's folder" (R4). A friend's
/// document keeps its own placement, and a pane's desk always wins: this is
/// asked only when neither said.
fn outside(store: &Store, root: &str) -> Option<crate::desk::Origin> {
    store
        .desks()
        .ok()?
        .into_iter()
        .find(|d| desk_project(&d.root).0 == root)
        .map(|d| crate::desk::Origin {
            id: d.id,
            name: d.name,
            slot: 0,
        })
}

pub fn receive(store: &Store, renderer: &Renderer, p: Payload) -> Result<Received> {
    let b = read(store, &p)?;
    let origin = p.origin.as_deref().unwrap_or("cli");
    // Attribution only. Which workflow a document joins is still the
    // session's, as it always was; the pane says where it was sent from.
    let (root, proj_name, branch) = place(store, &p, &b);
    let from = pane_origin(store, p.pane.as_deref())
        .or_else(|| {
            p.peer
                .as_ref()
                .and_then(|fp| fp.desk.as_ref().map(|(o, _)| o.clone()))
        })
        .or_else(|| p.peer.is_none().then(|| outside(store, &root)).flatten());

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
    if let Some(same) = latest_same_path.as_ref().filter(|d| d.content_hash == hash) {
        return unchanged(store, &p, origin, from.as_ref(), &proj_name, same);
    }

    let (kind, lang) = classify(renderer, &b, p.lang.as_deref());
    let title = render::title_for(p.title.as_deref(), kind, b.path.as_deref(), &b.text);

    // A draft with no workflow of its own joins the one its conversation
    // named, when the agent has sent under a name here (decision R10).
    let named = match (quiet(origin), &p.workflow, &p.session) {
        (true, None, Some(s)) => store.named_workflow(&root, s.trim())?,
        _ => None,
    };
    let (wf_name, wf_title) =
        named.unwrap_or_else(|| workflow(&p, origin, from.as_ref(), &proj_name, &title));

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
    // A friend's pictures are in the document or stayed with them: one that
    // names a file on their machine says so, rather than breaking.
    let shown = match &p.peer {
        Some(fp) if kind == Kind::Markdown => Some(render::stayed_with(&b.text, &fp.name)),
        _ => None,
    };
    let html = page(
        renderer,
        &b,
        shown.as_deref().unwrap_or(&b.text),
        &id,
        kind,
        lang.as_deref(),
        &title,
    );
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
        quiet: quiet(origin),
        session: p.session.as_deref().unwrap_or("").trim(),
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
            quiet: quiet(origin),
            promoted: false,
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
        quiet: quiet(origin),
        promoted: false,
    })
}

/// The same bytes as the newest snapshot of the file: that document, rather
/// than a duplicate -- or, when an explicit send meets the hook's draft of
/// them, the draft taken over (`promote`).
fn unchanged(
    store: &Store,
    p: &Payload,
    origin: &str,
    from: Option<&crate::desk::Origin>,
    project: &str,
    same: &Doc,
) -> Result<Received> {
    if explicit(origin) && quiet(&same.origin) {
        return promote(store, p, origin, from, project, same);
    }
    Ok(Received {
        doc: same.clone(),
        needs_full_highlight: false,
        existing: true,
        supersedes: None,
        quiet: quiet(origin),
        promoted: false,
    })
}

/// The agent's send of bytes the hook already saved: the draft becomes the
/// send, with the agent's title when it gave one and its workflow, and
/// arrives. Nothing is rendered: the page is the same bytes', and its H1 was
/// taken off whatever the title (`render::strip_leading_h1`).
fn promote(
    store: &Store,
    p: &Payload,
    origin: &str,
    from: Option<&crate::desk::Origin>,
    project: &str,
    draft: &Doc,
) -> Result<Received> {
    let title = p
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&draft.title);
    // Named by this send, or a plan's home: that. Otherwise the draft's own,
    // which may be the one the conversation named (`named_workflow`) and
    // is never worse than the session's key a nameless send would give.
    let named = p.workflow.as_deref().is_some_and(|w| !w.trim().is_empty());
    let (wf_name, wf_title) = if named || origin == "plan" {
        workflow(p, origin, from, project, title)
    } else {
        (draft.workflow.clone(), draft.workflow_title.clone())
    };
    let by = crate::store::Promotion {
        origin,
        sender: p.sender.as_deref().unwrap_or(""),
        session: p.session.as_deref().unwrap_or("").trim(),
        title,
        workflow_key: &wf_name.to_lowercase(),
        workflow_title: &wf_title,
    };
    // What this send is a version of: the last one sent of the file, past
    // the hook's drafts between. A plan edited and sent again went to
    // Lately as a new document each time, five rows for one plan (1.43, G1).
    let mut supersedes = None;
    let mut at = store.previous(draft)?;
    for _ in 0..64 {
        let Some(prev) = at else { break };
        if !quiet(&prev.origin) {
            supersedes = Some(prev.id);
            break;
        }
        at = store.previous(&prev)?;
    }
    Ok(Received {
        doc: store.promote(&draft.id, &by)?,
        needs_full_highlight: false,
        existing: false,
        supersedes,
        quiet: false,
        promoted: true,
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
        let again = receive(&s, &r, mk("hook")).unwrap();
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

    /// The hook's draft is listed and does not wait; the agent's send of the
    /// same bytes takes it over -- one row, waiting now, with the agent's
    /// title and workflow -- and later drafts follow that workflow.
    #[test]
    fn a_draft_is_quiet_until_the_agent_sends_it() {
        let (s, r, d) = setup();
        let file = d.path.join("PLAN.md");
        std::fs::write(&file, "# From the H1\n\nv1").unwrap();
        let cwd = d.path.to_string_lossy().to_string();
        let mk = |origin: &str, title: Option<&str>, workflow: Option<&str>| Payload {
            path: Some(file.to_string_lossy().to_string()),
            cwd: Some(cwd.clone()),
            session: Some("claude 1234abcd".into()),
            origin: Some(origin.into()),
            title: title.map(str::to_string),
            workflow: workflow.map(str::to_string),
            ..Default::default()
        };
        let draft = receive(&s, &r, mk("hook", None, None)).unwrap();
        assert!(draft.quiet && !draft.existing && !draft.promoted);
        assert_eq!(s.waiting().unwrap(), 0, "a draft does not wait");
        assert_eq!(draft.doc.workflow, "claude 1234abcd");

        let sent = receive(&s, &r, mk("mcp", Some("The plan"), Some("Send paths"))).unwrap();
        assert!(sent.promoted && !sent.existing && !sent.quiet);
        assert_eq!(sent.supersedes, None, "the first send of the file");
        assert_eq!(sent.doc.id, draft.doc.id, "one row");
        assert_eq!(sent.doc.title, "The plan");
        assert_eq!(sent.doc.origin, "mcp");
        assert_eq!(sent.doc.workflow, "send paths");
        assert_eq!(s.waiting().unwrap(), 1);
        assert_eq!(s.count().unwrap(), 1);
        // Sent again, unchanged: nothing arrives.
        let again = receive(&s, &r, mk("mcp", Some("The plan"), None)).unwrap();
        assert!(again.existing && !again.promoted);
        // A draft that followed the named workflow, sent with no name: it
        // stays in the named one.
        let other = d.path.join("NOTES.md");
        std::fs::write(&other, "# Notes").unwrap();
        let note = |origin: &str| Payload {
            path: Some(other.to_string_lossy().to_string()),
            ..mk(origin, None, None)
        };
        assert_eq!(
            receive(&s, &r, note("hook")).unwrap().doc.workflow,
            "send paths"
        );
        let noted = receive(&s, &r, note("mcp")).unwrap();
        assert!(noted.promoted);
        assert_eq!(noted.doc.workflow, "send paths");

        // The next draft joins the workflow the conversation named, and,
        // since the send it follows is still unread, keeps it waiting.
        std::fs::write(&file, "# From the H1\n\nv2").unwrap();
        let next = receive(&s, &r, mk("hook", None, None)).unwrap();
        assert!(next.quiet && !next.existing);
        assert_eq!(next.supersedes.as_deref(), Some(draft.doc.id.as_str()));
        assert_eq!(next.doc.workflow, "send paths");
        assert_eq!(s.waiting().unwrap(), 2, "the mark moved to the new version");
        assert!(s.queue(5).unwrap().iter().any(|q| q.id == next.doc.id));

        // Read, then drafted again: the draft does not wait.
        s.mark_read(&next.doc.id).unwrap();
        std::fs::write(&file, "# From the H1\n\nv3").unwrap();
        let read_then = receive(&s, &r, mk("hook", None, Some("other"))).unwrap();
        assert!(!read_then.existing);
        assert_eq!(s.waiting().unwrap(), 1, "only the notes wait");

        // Different bytes from the agent: a new version, loud.
        std::fs::write(&file, "# From the H1\n\nv4").unwrap();
        let v4 = receive(&s, &r, mk("mcp", None, None)).unwrap();
        assert!(!v4.quiet && !v4.promoted && !v4.existing);
        assert_eq!(v4.supersedes.as_deref(), Some(read_then.doc.id.as_str()));
        assert_eq!(s.waiting().unwrap(), 2);

        // Drafted, then sent: a version of the last send, past the drafts
        // between, so Lately says "2 versions" and not two documents (G1).
        std::fs::write(&file, "# From the H1\n\nv5").unwrap();
        receive(&s, &r, mk("hook", None, None)).unwrap();
        let v5 = receive(&s, &r, mk("mcp", None, None)).unwrap();
        assert!(v5.promoted);
        assert_eq!(v5.supersedes.as_deref(), Some(v4.doc.id.as_str()));
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
            root: None,
            lineage: None,
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
                    root: None,
                    lineage: None,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        let (root, _, _) = desk_project(&garden.path.to_string_lossy());
        assert_eq!(
            s.project_root(got.doc.project_id).as_deref(),
            Some(root.as_str())
        );
        assert_eq!(got.doc.desk, Some(at));
        assert_eq!(got.doc.origin, "peer");
        assert_eq!(got.doc.sender, "Trapti");
        assert!(!s.projects().unwrap()[0].friend, "the desk's own row");
    }

    /// A document sent from a desk's folder outside its panels -- Claude in
    /// the reader's own terminal -- lands on that desk, slot 0 (R4); a
    /// pane on another desk keeps its own desk, and a friend's document is
    /// not placed by folder.
    #[test]
    fn a_document_from_a_desks_folder_lands_on_that_desk() {
        let (s, r, _d) = setup();
        let garden = Dir::new("snyvi-recv-outside");
        std::fs::create_dir_all(garden.path.join(".git")).unwrap();
        std::fs::create_dir_all(garden.path.join("sub")).unwrap();
        let g = garden.path.to_string_lossy().to_string();
        let desk = s.create_desk(&g, Some("garden")).unwrap();
        let other = s.create_desk("/tmp", Some("other")).unwrap();
        let send = |text: &str, pane: Option<String>| {
            receive(
                &s,
                &r,
                Payload {
                    content: Some(text.into()),
                    cwd: Some(garden.path.join("sub").to_string_lossy().to_string()),
                    origin: Some("cli".into()),
                    pane,
                    ..Default::default()
                },
            )
            .unwrap()
            .doc
        };
        let got = send("# Where it stands\n\none", None);
        assert_eq!(
            got.desk,
            Some(crate::desk::Origin {
                id: desk.id,
                name: "garden".into(),
                slot: 0
            })
        );

        let crate::desk::Opened::Pane(p) = s.open_pane(other.id, "/tmp", "", false).unwrap() else {
            panic!("a pane")
        };
        let got = send("# From the other desk\n\ntwo", Some(p.id));
        assert_eq!(
            got.desk.map(|o| o.id),
            Some(other.id),
            "the pane's desk wins"
        );
    }

    /// A `.git` made a folder too high -- D:\workspaces\.git, around the
    /// reader's every project -- does not take a desk's documents: a desk on
    /// a folder with no repository of its own is its own project, from its
    /// panels and from a terminal in its folder. What an older snyvi filed
    /// above the desk is moved there once, ✕ and all, and the project above
    /// is left with nothing.
    #[test]
    fn a_repository_above_a_desk_does_not_take_its_documents() {
        let (s, r, _d) = setup();
        let ws = Dir::new("snyvi-recv-ws");
        let flow = ws.path.join("taskflow");
        std::fs::create_dir_all(ws.path.join(".git")).unwrap();
        // A folder of projects: another repository beside the desk's.
        std::fs::create_dir_all(ws.path.join("snyvi/.git")).unwrap();
        std::fs::create_dir_all(flow.join("supabase")).unwrap();
        let desk = s
            .create_desk(&flow.to_string_lossy(), Some("taskflow"))
            .unwrap();
        let crate::desk::Opened::Pane(p) = s
            .open_pane(desk.id, &flow.to_string_lossy(), "", false)
            .unwrap()
        else {
            panic!("a pane")
        };
        let send = |text: &str, cwd: &std::path::Path, pane: Option<String>| {
            receive(
                &s,
                &r,
                Payload {
                    content: Some(text.into()),
                    cwd: Some(cwd.to_string_lossy().to_string()),
                    origin: Some("cli".into()),
                    pane,
                    ..Default::default()
                },
            )
            .unwrap()
            .doc
        };
        assert_eq!(desk_project(&flow.to_string_lossy()).1, "taskflow");
        let pasted = send(
            "# Pasted

one",
            &flow,
            Some(p.id.clone()),
        );
        assert_eq!(pasted.project, "taskflow");
        let setup_md = send(
            "# Supabase Setup

two",
            &flow.join("supabase"),
            None,
        );
        assert_eq!(
            setup_md.project_id, pasted.project_id,
            "a terminal in the desk's folder files there too"
        );
        assert_eq!(setup_md.desk.as_ref().map(|o| o.id), Some(desk.id));

        // As 1.36.1 filed them: under the folder above, still on the desk.
        let above = crate::project::resolve(&flow)
            .root
            .to_string_lossy()
            .to_string();
        let on = crate::desk::Origin {
            id: desk.id,
            name: "taskflow".into(),
            slot: 0,
        };
        for d in [&pasted, &setup_md] {
            s.move_lineage(&d.id, &above, "workspaces", &on).unwrap();
        }
        assert!(s.set_desk_doc_off(desk.id, &setup_md.id, true).unwrap());
        assert_eq!(refile_desks(&s).unwrap(), 2);
        for d in [&pasted, &setup_md] {
            assert_eq!(s.get(&d.id).unwrap().unwrap().project, "taskflow");
        }
        assert!(
            s.projects().unwrap().iter().all(|p| p.name != "workspaces"),
            "nothing left above"
        );
        assert_eq!(
            s.desk_docs(desk.id, 10, true).unwrap().len(),
            1,
            "the ✕ stays"
        );
        assert_eq!(refile_desks(&s).unwrap(), 0, "once");
    }

    /// A friend's document about a repository the reader has: into the
    /// reader's own folder for it, ahead of the friend's desk, versioned by
    /// its place in the repository -- so two files of one name are two rows.
    #[test]
    fn a_friends_document_lands_in_the_folder_both_have() {
        let (s, r, _d) = setup();
        let mine = Dir::new("snyvi-recv-mine");
        let theirs = Dir::new("snyvi-recv-theirs");
        for d in [&mine, &theirs] {
            std::fs::create_dir_all(d.path.join(".git")).unwrap();
        }
        let (root, _, _) = desk_project(&mine.path.to_string_lossy());
        let send = |bytes: &[u8], lineage: &str| {
            receive(
                &s,
                &r,
                Payload {
                    title: Some("Plan".into()),
                    origin: Some("peer".into()),
                    sender: Some("Trapti".into()),
                    peer: Some(FromPeer {
                        name: "Trapti".into(),
                        sign_key: "KEY".into(),
                        bytes: bytes.to_vec(),
                        file: Some("PLAN.md".into()),
                        // The desk the reader gave Trapti, elsewhere: the
                        // folder both have wins.
                        desk: Some((
                            crate::desk::Origin {
                                id: 9,
                                name: "Theirs".into(),
                                slot: 0,
                            },
                            theirs.path.to_string_lossy().to_string(),
                        )),
                        root: Some(root.clone()),
                        lineage: Some(lineage.into()),
                    }),
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let one = send(b"# Plan\n\none", "docs/PLAN.md");
        assert_eq!(
            s.project_root(one.doc.project_id).as_deref(),
            Some(root.as_str())
        );
        assert_eq!(one.doc.source_path.as_deref(), Some("docs/PLAN.md"));
        assert_eq!(one.doc.kind, Kind::Markdown);
        let two = send(b"# Plan\n\ntwo", "docs/PLAN.md");
        assert_eq!(
            two.supersedes.as_deref(),
            Some(one.doc.id.as_str()),
            "a version"
        );
        let other = send(b"# Plan\n\nelse", "web/PLAN.md");
        assert_eq!(
            other.supersedes, None,
            "the same name elsewhere is its own row"
        );
        let scratch = send(b"# Plan\n\nscratch", "0123456789abcdef/PLAN.md");
        assert_eq!(scratch.supersedes, None);
        assert_eq!(
            send(b"# Plan\n\nscratch 2", "0123456789abcdef/PLAN.md")
                .supersedes
                .as_deref(),
            Some(scratch.doc.id.as_str()),
            "a file outside the repository is versioned by its key"
        );
    }

    #[test]
    fn missing_input_is_an_error() {
        let (s, r, _d) = setup();
        assert!(receive(&s, &r, Payload::default()).is_err());
    }
}
