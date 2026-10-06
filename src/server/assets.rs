//! What the browser loads: the shell pages, the embedded UI assets (the
//! `ASSETS` table drives the routes and the hashes), the fonts, the Mermaid
//! bundle, and a document's own files.

use super::*;

pub(crate) const INDEX_HTML: &str = include_str!("../../ui/index.html");

/// An address snyvi has nothing at: its own miss, so the page wears `oops`
/// (docs/DESIGN.md §2.3) and offers Home. Static, with no word of the path
/// asked for, so nothing a link carried reaches the page.
pub(crate) const NOT_FOUND_HTML: &str = include_str!("../../ui/404.html");

pub(crate) const APP_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/app.css"));

pub(crate) const APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/app.js"));

pub(crate) const BOOT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/boot.js"));

/// The diagram driver, imported by app.js with the first diagram and never on a
/// page without one. A module, so it is fetched rather than linked.
pub(crate) const MMD_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/mmd.js"));

/// The desk view: the pane grid, the painter, the keys. Loaded when a desk is
/// opened and not before, like the diagram driver -- a reader who never opens a
/// desk pays nothing for it.
pub(crate) const DESK_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/desk.js"));

/// The window's frame -- the bar's three buttons and what drags -- fetched
/// only inside the native window, since a tab has no window to frame.
pub(crate) const FRAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/frame.js"));

/// The game behind the rocket at the foot of the sidebar, fetched when the
/// rocket is pressed and never before: a reader who never presses it pays
/// nothing for it.
pub(crate) const GAME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));

/// The about panel and the reset dialog, fetched when one of them is opened:
/// neither is on the way to reading a document, and both ask the daemon
/// something the moment they open, so the module rides with that request.
pub(crate) const ABOUT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/about.js"));

/// Find in the document -- the bar `/` opens and the marks it lays down --
/// fetched the first time it is asked for. A reader who never searches inside
/// a document never fetches it, and the page's calls into it are no-ops until
/// it is there, because until then nothing is marked.
pub(crate) const FIND_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/find.js"));

/// The key mode's pill -- whether the single letters are awake -- fetched on
/// the first ⌃B, or the first letter pressed while they sleep. The gate itself
/// is in `app.js`; only what shows it is here.
pub(crate) const KEYS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/keys.js"));

/// What a folder and a desk can be asked to do -- the right-click menu, making
/// a desk, closing one, opening a folder -- fetched on the first such click. A
/// reader who only reads never fetches it; the sidebar draws its desks without
/// it, because drawing them is in `app.js` and only doing something is here.
pub(crate) const MENU_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/menu.js"));

/// ⌘K, fetched the first time it is pressed: the one box a reader summons
/// rather than meets, so first paint does not carry it.
pub(crate) const PALETTE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/palette.js"));

/// The theme, accent and font steppers, fetched once the page is idle or the
/// foot column is reached: nothing on screen needs them until a click there.
pub(crate) const LOOK_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/look.js"));

/// The aside card at the sidebar's foot, fetched when there is an aside to
/// show: a reader no agent has spoken to never pays for it.
pub(crate) const NOTE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/note.js"));

/// The tip every control names itself with (docs/DESIGN.md §8.1), fetched on
/// the first pointer resting on one, or the first Tab.
pub(crate) const TIP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/tip.js"));

/// Home, the page the mark opens: fetched when it is first shown, so a
/// reader who goes straight to a document never pays for it.
pub(crate) const HOME_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/home.js"));
/// A friend's snyvi: the pairing, Send to…, a line, an agent's offer (`ui/peer.js`).
pub(crate) const PEER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/peer.js"));

/// The toast, fetched the first time snyvi has something to say.
pub(crate) const TOAST_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/toast.js"));

/// A comparison and a split diff, fetched the first time either is asked for.
pub(crate) const DIFF_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/diff.js"));

/// A folder's page and a file read from disk, fetched when one is opened.
pub(crate) const BROWSE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/browse.js"));

pub(crate) const PATHS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/paths.js"));

/// Every theme but Paper and Ink, fetched once the page is idle: first paint
/// carries only the two defaults, and boot.js paints a returning reader's
/// own theme from a copy it kept, so the window opens as fast as it can.
pub(crate) const THEMES_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/themes.css"));

/// Mermaid, gzip-compressed at build time; served with Content-Encoding: gzip.
pub(crate) const MERMAID_JS_GZ: &[u8] = include_bytes!("../../ui/mermaid.min.js.gz");

/// Content-Security-Policy for the UI. Everything comes from the daemon itself; Mermaid
/// needs inline styles for the SVG it produces, and images may be data URIs.
/// `blob:` is for a note's pictures: they come behind the desk's capability,
/// which an `<img>` cannot send, so the page fetches them and shows its own
/// object URL. Only the page itself can mint one.
pub(crate) const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

pub(crate) const FONTS: &[(&str, &[u8])] = &[
    ("inter.woff2", include_bytes!("../../ui/fonts/inter.woff2")),
    (
        "inter-italic.woff2",
        include_bytes!("../../ui/fonts/inter-italic.woff2"),
    ),
    (
        "jetbrains-mono.woff2",
        include_bytes!("../../ui/fonts/jetbrains-mono.woff2"),
    ),
    (
        "source-serif.woff2",
        include_bytes!("../../ui/fonts/source-serif.woff2"),
    ),
    (
        "source-serif-italic.woff2",
        include_bytes!("../../ui/fonts/source-serif-italic.woff2"),
    ),
    // Literata and Atkinson Hyperlegible Next (both OFL), latin cuts: two
    // more reading faces for the Aa button. Fetched only when chosen.
    (
        "literata.woff2",
        include_bytes!("../../ui/fonts/literata.woff2"),
    ),
    (
        "literata-italic.woff2",
        include_bytes!("../../ui/fonts/literata-italic.woff2"),
    ),
    (
        "atkinson.woff2",
        include_bytes!("../../ui/fonts/atkinson.woff2"),
    ),
    (
        "atkinson-italic.woff2",
        include_bytes!("../../ui/fonts/atkinson-italic.woff2"),
    ),
    // Nerd Fonts' symbols (MIT, `symbols-nerd.LICENSE`), cut to the private
    // use area: the icons a prompt draws in a pane. Fetched only when a pane
    // shows one -- the face's `unicode-range` in ui/desk.js.
    (
        "symbols-nerd.woff2",
        include_bytes!("../../ui/fonts/symbols-nerd.woff2"),
    ),
];

/// Where the UI is read from.
///
/// The shipped daemon serves the five text assets `include_str!` compiled into
/// it, which is why a stylesheet change costs a rebuild: the bytes are in the
/// binary. They are the files in `ui/` with their comments and indentation
/// taken out -- `build.rs` runs each through `crate::strip` on the way in, so
/// the wire carries what a browser reads and the source keeps its prose.
/// `SNYVI_UI_DIR` points at a working tree's `ui/` instead, and every request
/// reads the file off disk, as written, comments and all: the dev loop is
/// where a person reads them. That is the whole dev loop -- a saved stylesheet
/// becomes a reload, and with the watcher below, not even that.
///
/// Dev only, and it says so: the variable has to be set deliberately, an unset
/// or unreadable one falls back to the compiled-in copy rather than failing,
/// and nothing about the response changes except its cache header. The names
/// are the `ASSETS` table's, never anything a request carries, so there is no
/// path for a URL to reach a file that is not one of them.
pub struct Ui {
    pub(crate) dir: Option<PathBuf>,
}

impl Ui {
    pub(crate) fn from_env() -> Ui {
        let dir = std::env::var_os("SNYVI_UI_DIR")
            .map(PathBuf::from)
            .filter(|d| d.join("app.css").is_file());
        Ui { dir }
    }

    /// True while assets come off disk.
    pub fn live(&self) -> bool {
        self.dir.is_some()
    }

    /// The named asset: off disk when live, the compiled-in copy otherwise.
    /// A file that has gone missing mid-edit -- an editor writing by rename --
    /// falls back rather than serving an empty page.
    pub(crate) fn text(&self, name: &str, built_in: &'static str) -> Cow<'static, str> {
        self.dir
            .as_ref()
            .and_then(|d| crate::strip::source(d, name).ok())
            .map_or(Cow::Borrowed(built_in), Cow::Owned)
    }

    /// What the UI assets hash to right now. The page carries this as
    /// `?v=`, `/api/health` reports it, and a page whose copy no longer
    /// matches the daemon's reloads -- so recomputing it per request is what
    /// makes an edit on disk a new bundle, with no restart in it.
    pub(crate) fn version(&self, built_in: &str) -> String {
        let Some(_) = self.dir.as_ref() else {
            return built_in.to_string();
        };
        let mut h = blake3::Hasher::new();
        for (name, fallback) in std::iter::once(("index.html", INDEX_HTML))
            .chain(ASSETS.iter().map(|(n, b, _)| (*n, *b)))
        {
            h.update(self.text(name, fallback).as_bytes());
        }
        h.finalize().to_hex()[..8].to_string()
    }
}

/// How much of a project the sidebar is given when it is expanded: enough to
/// read, never a year of sessions. Everything past this is one click away and
/// arrives whole, so nothing is hidden -- only unasked for.
pub(crate) const TREE_WORKFLOWS: usize = 10;

pub(crate) const TREE_DOCS: usize = 10;

/// One project's rows: its sessions, newest first, each holding its newest
/// documents.
///
/// `whole` is the workflow the reader is reading in, which comes back complete
/// rather than capped: `[` and `]` step through the versions of a document, and
/// a cap there would stop them somewhere arbitrary. The page a reader opens and
/// the fetch their tab makes later both come through here, so an arrival cannot
/// quietly hand back a shorter list than the page did.
pub(crate) fn project_rows(
    app: &App,
    project_id: i64,
    workflows: usize,
    docs: usize,
    whole: Option<i64>,
) -> Vec<crate::store::TreeWorkflow> {
    let mut wfs = app
        .store
        .project_tree(project_id, workflows, docs)
        .unwrap_or_default();
    if let Some(id) = whole {
        if let Ok(Some(full)) = app.store.workflow_tree(id) {
            match wfs.iter().position(|w| w.id == full.id) {
                Some(at) => wfs[at] = full,
                // The document being read is in a session too old to be among
                // the most recent few. It goes in anyway: the reader is in it.
                None => wfs.insert(0, full),
            }
        }
    }
    wfs
}

/// The same rows, keyed by project id, which is the shape the boot payload
/// carries them in.
pub(crate) fn subtree(app: &App, project_id: i64, whole: Option<i64>) -> serde_json::Value {
    let wfs = project_rows(app, project_id, TREE_WORKFLOWS, TREE_DOCS, whole);
    let mut m = serde_json::Map::new();
    m.insert(
        project_id.to_string(),
        serde_json::to_value(wfs).unwrap_or_default(),
    );
    serde_json::Value::Object(m)
}

pub(crate) fn escape_json_for_script(s: &str) -> String {
    s.replace("</", "<\\/")
}

/// Nothing at this address. The API answers with the status alone, as it
/// did before there was a page; anything a browser would show gets the page.
pub(crate) async fn not_found(State(app): S, uri: axum::http::Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    not_found_page(&app)
}

/// The page, off disk under `SNYVI_UI_DIR` as every other file of the UI is.
pub(crate) fn not_found_page(app: &App) -> Response {
    (
        StatusCode::NOT_FOUND,
        [
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        Html(app.ui.text("404.html", NOT_FOUND_HTML).into_owned()),
    )
        .into_response()
}

pub(crate) fn shell(
    app: &App,
    mut boot: serde_json::Value,
    initial_html: &str,
    title: &str,
) -> Response {
    // The build hash, for the one asset the client asks for itself rather than
    // through the markup: the Mermaid bundle.
    if let Some(o) = boot.as_object_mut() {
        o.insert("v".into(), serde_json::Value::String(app.asset_v()));
        // What is waiting to be read, on every page: the bar above the
        // document and the section at the top of the sidebar draw from it
        // before the first paint, so a reload never loses count.
        o.insert(
            "queue".into(),
            serde_json::to_value(app.store.queue(QUEUE_BOOT).unwrap_or_default())
                .unwrap_or_default(),
        );
        o.insert("waiting".into(), json!(waiting(app)));
        // Who is here, for the count beside the brand mark on the first paint.
        o.insert("online".into(), app.online());
        // The aside showing at the foot of the sidebar, and the trail under it.
        o.insert("notes".into(), json!(app.asides.list()));
        // Whether there is a friend, so a menu offers Send to a friend… only
        // then; the menu asks again as it opens (`ui/menu.js`).
        o.insert("friends".into(), json!(has_friends(app)));
    }
    let page = app
        .ui
        .text("index.html", INDEX_HTML)
        .replace("{{V}}", &app.asset_v())
        .replace("{{TITLE}}", &html_escape::encode_text(title))
        .replace("{{INITIAL_HTML}}", initial_html)
        .replace("{{BOOT_JSON}}", &escape_json_for_script(&boot.to_string()));
    (
        [
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
        ],
        Html(page),
    )
        .into_response()
}

pub fn fmt_time(ts: i64) -> String {
    use time::{format_description::FormatItem, macros::format_description, OffsetDateTime};
    const F: &[FormatItem] =
        format_description!("[month repr:short] [day padding:none], [hour]:[minute]");
    let local = OffsetDateTime::from_unix_timestamp(ts)
        .map(|t| {
            t.to_offset(time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC))
        })
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    local.format(F).unwrap_or_default()
}

/// Server-side document markup, mirrored by `renderDoc` in app.js.
pub(crate) fn doc_html(doc: &Doc, body: &str, friends: bool) -> String {
    let e = html_escape::encode_text;
    // A friend's document says who, and that the signature checked: the
    // only way a document gets `peer` as its origin is through a frame that
    // opened under a pinned key (`crate::peer::open`).
    let theirs = doc.origin == "peer" && !doc.sender.is_empty();
    let mut sub = if theirs {
        // Kept on a desk, it says which; the workflow is theirs either way.
        let on = doc
            .desk
            .as_ref()
            .map(|d| format!(" · on {}", e(&d.name)))
            .unwrap_or_default();
        format!(
            "from {} · verified{on} · {}",
            e(&doc.sender),
            e(&doc.workflow_title)
        )
    } else {
        format!("{} · {}", e(&doc.project), e(&doc.workflow_title))
    };
    if let Some(b) = &doc.branch {
        sub.push_str(&format!(" · <span class=\"branch\">{}</span>", e(b)));
    }
    sub.push_str(&format!(" · {}", fmt_time(doc.received_at)));
    // A friend's document: Keep on a desk…, and once it is on one, Save into
    // the folder. The page wires both (`ui/peer.js`), and the daemon asks
    // for the window's capability, since both name a desk.
    if theirs {
        let (act, label) = if doc.desk.is_some() {
            ("save", "Save into the folder")
        } else {
            ("keep", "Keep on a desk…")
        };
        sub.push_str(&format!(
            " · <button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-act=\"{act}\" data-send=\"{}\" data-send-title=\"{}\">{label}</button>",
            e(&doc.id),
            e(&doc.title)
        ));
    }
    // Send to…, only once there is a friend to send to: the page wires the
    // click (`ui/peer.js`). In the sub line, so the head is the same height
    // with it and without.
    if friends {
        sub.push_str(&format!(
            " · <button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-send=\"{}\" data-send-title=\"{}\">Send to…</button>",
            e(&doc.id),
            e(&doc.title)
        ));
    }
    format!(
        "<header class=\"doc-head\"><h1 class=\"doc-title\">{}</h1><p class=\"doc-sub\">{}</p></header><article class=\"prose kind-{}\">{}</article>",
        e(&doc.title),
        sub,
        doc.kind.as_str(),
        render::chunk_code(body)
    )
}

/// Is there a friend to send a document to? What decides whether a head
/// grows Send to….
pub(crate) fn has_friends(app: &App) -> bool {
    app.store
        .peers()
        .map(|ps| ps.iter().any(|p| p.removed_at == 0))
        .unwrap_or(false)
}

/// `/`: Home, the page the mark opens -- what needs the reader, the desks,
/// what is waiting, the update. An empty library is still Welcome, which the
/// Inbox's view draws, so it keeps that view.
pub(crate) async fn shell_home(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let empty = app.store.inbox(1).map(|i| i.is_empty()).unwrap_or(true);
    if empty {
        return shell_inbox(State(app)).await;
    }
    let boot = json!({ "view": "home", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "snyvi")
}

/// The Inbox, at `/inbox` since `/` became Home: every document, newest
/// first, with what is waiting at the top.
pub(crate) async fn shell_inbox(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let inbox = app.store.inbox(50).unwrap_or_default();
    // A single project is shown expanded, so its rows are wanted on this page
    // and are worth the bytes rather than a second round trip. Any more than
    // one and the reader's own choice of what is open decides, which is in
    // their browser and not here.
    let sub = match tree.as_slice() {
        [only] => subtree(&app, only.id, None),
        _ => serde_json::Value::Object(Default::default()),
    };
    let mut boot = json!({ "view": "inbox", "tree": tree, "sub": sub, "inbox": inbox, "browse": app.browse.list(), "version": VERSION });
    // An empty library opens on the connect page, and the page is on screen
    // with the sidebar rather than a round trip after it.
    if inbox.is_empty() {
        boot["agents"] = agents_json(&app);
    }
    shell(&app, boot, "", "snyvi")
}

/// The connect page, asked for: from `?`, or by its address.
pub(crate) async fn shell_connect(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "connect", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION, "agents": agents_json(&app) });
    shell(&app, boot, "", "Agents · snyvi")
}

/// The first ten minutes: a page the client draws (`ui/about.js`), asked for
/// from `?`, the connect page, ⌘K `>`, or an aside's link.
pub(crate) async fn shell_start(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "start", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "How snyvi works · snyvi")
}

/// Welcome: what snyvi is, and one question -- which project first. The page
/// an empty window opens on, drawn by `ui/about.js`; reopened from Help.
pub(crate) async fn shell_welcome(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "welcome", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Welcome · snyvi")
}

pub(crate) async fn shell_doc(State(app): S, Path(id): Path<String>) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return not_found_page(&app);
    };
    let body = app.store.html(&id).unwrap_or_default();
    let tree = app.store.projects().unwrap_or_default();
    let previous = app.store.previous(&doc).ok().flatten().map(|p| p.id);
    let title = doc.title.clone();
    let folder = doc_folder(&app, &doc);
    // The project this document is in is the one the sidebar opens on, so it
    // arrives with the page rather than a moment after it.
    let sub = subtree(&app, doc.project_id, Some(doc.workflow_id));
    // A page or a PDF is framed on a cold load as on an open from the
    // sidebar (`doc_json`): the page needs to know it is one.
    let preview = render::preview_kind(&doc_ext(&doc));
    let boot = json!({ "view": "doc", "tree": tree, "sub": sub, "doc": doc, "previous": previous, "folder": folder, "browse": app.browse.list(), "version": VERSION,
        "preview": preview, "preview_url": preview.map(|_| format!("/api/docs/{id}/blob")) });
    shell(
        &app,
        boot,
        &doc_html(&doc, &body, has_friends(&app)),
        &title,
    )
}

/// So nothing about a desk is in this answer: the page asks for it with the
/// capability, or cannot.
pub(crate) async fn shell_desk(State(app): S, Path(id): Path<i64>) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "desk", "desk": id, "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Desk · snyvi")
}

/// Every desk, which is where the sidebar's `Desks` row goes.
pub(crate) async fn shell_desk_list(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "desk", "desk": null, "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Desks · snyvi")
}

pub(crate) fn immutable(content_type: &'static str, body: impl Into<Body>) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        body.into(),
    )
        .into_response()
}

pub(crate) const JS: &str = "application/javascript; charset=utf-8";
pub(crate) const CSS: &str = "text/css; charset=utf-8";

/// Every text asset the page can ask for, by the name in its URL: the
/// compiled-in copy and its content type. One table drives the routes
/// (`asset_named`), the startup hash (`new_app`) and the live hash
/// (`Ui::version`), so an asset added here is served, hashed, and read off
/// disk under `SNYVI_UI_DIR` -- and nothing a URL names is ever a path: the
/// name is looked up here or it is a 404.
pub(crate) const ASSETS: &[(&str, &str, &str)] = &[
    ("app.css", APP_CSS, CSS),
    ("app.js", APP_JS, JS),
    ("boot.js", BOOT_JS, JS),
    // The diagram driver: the same UI, split at the one seam where most
    // page loads do not need what is on the other side.
    ("mmd.js", MMD_JS, JS),
    // The desk view, on the same terms as the diagram driver.
    ("desk.js", DESK_JS, JS),
    ("frame.js", FRAME_JS, JS),
    ("game.js", GAME_JS, JS),
    ("about.js", ABOUT_JS, JS),
    ("find.js", FIND_JS, JS),
    ("keys.js", KEYS_JS, JS),
    ("menu.js", MENU_JS, JS),
    ("themes.css", THEMES_CSS, CSS),
    ("palette.js", PALETTE_JS, JS),
    ("look.js", LOOK_JS, JS),
    ("note.js", NOTE_JS, JS),
    ("tip.js", TIP_JS, JS),
    ("home.js", HOME_JS, JS),
    ("peer.js", PEER_JS, JS),
    ("toast.js", TOAST_JS, JS),
    ("diff.js", DIFF_JS, JS),
    ("browse.js", BROWSE_JS, JS),
    ("paths.js", PATHS_JS, JS),
];

/// `/assets/{name}`: one of `ASSETS`, or nothing.
pub(crate) async fn asset_named(State(app): S, Path(name): Path<String>) -> Response {
    match ASSETS.iter().find(|(n, _, _)| *n == name) {
        Some((n, built_in, content_type)) => asset(&app, content_type, n, built_in),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// An asset that is immutable for a shipped build -- its URL carries the
/// build hash, so a year is the right answer -- and uncached while the UI is
/// live, where the whole point is that the next request sees the edit.
pub(crate) fn asset(
    app: &App,
    content_type: &'static str,
    name: &str,
    built_in: &'static str,
) -> Response {
    let body = app.ui.text(name, built_in).into_owned();
    if !app.ui.live() {
        return immutable(content_type, body);
    }
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        body,
    )
        .into_response()
}

pub(crate) async fn asset_mermaid() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/javascript; charset=utf-8"),
            ),
            (header::CONTENT_ENCODING, HeaderValue::from_static("gzip")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            ),
        ],
        MERMAID_JS_GZ,
    )
        .into_response()
}

/// Images referenced relatively from a document, resolved against the source file's
/// directory and confined to the project root. Image types only.
pub(crate) async fn doc_file(
    State(app): S,
    Path((id, rel)): Path<(String, String)>,
    req: HeaderMap,
) -> Response {
    let Ok(Some(doc)) = app.store.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(src) = doc.source_path.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(dir) = std::path::Path::new(src).parent() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = dir.join(&rel);
    let ext = target
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // A picture, or a video or song the document plays in place; nothing
    // else beside a document is the page's to fetch.
    let media = render::media_kind(&ext).is_some();
    if !render::is_image_ext(&ext) && !media {
        return StatusCode::FORBIDDEN.into_response();
    }
    let (Ok(canon), Ok(root)) = (
        target.canonicalize(),
        crate::project::resolve(dir).root.canonicalize(),
    ) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !canon.starts_with(&root) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if media {
        // Streamed, a range at a time, so a player can seek and a long take
        // is never whole in the daemon.
        let mut headers = HeaderMap::new();
        if let Ok(v) =
            HeaderValue::from_str(mime_guess::from_ext(&ext).first_or_octet_stream().as_ref())
        {
            headers.insert(header::CONTENT_TYPE, v);
        }
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=300"),
        );
        return serve_file(&canon, headers, &req).await;
    }
    match tokio::fs::read(&canon).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&canon)
                .first_or_octet_stream()
                .to_string();
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "private, max-age=300".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn asset_font(Path(name): Path<String>) -> Response {
    match FONTS.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => immutable("font/woff2", *bytes),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn shell_browse(State(app): S, Path(id): Path<String>) -> Response {
    browse_shell(app, id, String::new()).await
}

pub(crate) async fn shell_browse_file(
    State(app): S,
    Path((id, path)): Path<(String, String)>,
) -> Response {
    browse_shell(app, id, path).await
}

pub(crate) async fn browse_shell(app: Arc<App>, id: String, path: String) -> Response {
    let Some(root) = app.browse.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Html("<h1>That folder is no longer open</h1>"),
        )
            .into_response();
    };
    // Land on the README when no file was asked for. A path ending in `/` is
    // a folder inside the root, and the page lists it (ui/browse.js `show`).
    let path = if path.is_empty() {
        app.browse.landing(&id).unwrap_or_default()
    } else {
        path
    };
    let title = match path.trim_end_matches('/') {
        "" => root.name.clone(),
        p => p.to_string(),
    };
    let boot = json!({
        "view": "browse",
        "tree": app.store.projects().unwrap_or_default(),
        "browse": app.browse.list(),
        "browseRoot": root,
        "browsePath": path,
        "version": VERSION,
    });
    shell(&app, boot, "", &title)
}
