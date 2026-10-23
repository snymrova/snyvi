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
pub(crate) const NAV_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/nav.js"));

/// Copy all (#165), fetched once the page is idle, as nav.js is: by the
/// first click on it, it is here.
pub(crate) const COPY_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/copy.js"));

/// The aside card at the sidebar's foot, fetched when there is an aside to
/// show: a reader no agent has spoken to never pays for it.
pub(crate) const CORNER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/corner.js"));

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

/// /sidebars: arranging the sidebars and the widgets, fetched when it opens.
pub(crate) const SIDEBARS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/sidebars.js"));
pub(crate) const GALLERY_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/gallery.js"));

/// A song's own controls (audit 3c6958c2a8), fetched on the first press of
/// one: a document with no song in it never pays for them.
pub(crate) const PLAYER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/player.js"));

/// Approve on a plan's head (1.47), fetched on its first press.
pub(crate) const PLAN_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/plan.js"));

/// A friend's page (`/friend/{id}`, 1.49), fetched when it opens.
pub(crate) const FRIEND_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/friend.js"));

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
/// object URL. Only the page itself can mint one. `media-src` adds one host,
/// snyvi.com, for the Welcome tour's clips (ui/about.js `TOUR_CLIPS`): a
/// `<video>` may play from there and nowhere else, and nothing may be sent
/// there, `connect-src` staying the daemon's own.
pub(crate) const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' https://snyvi.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

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

/// The Welcome tour's pictures (ui/about.js `TOUR`), one per step in each
/// side, light and dark. Real screens, cropped to the one thing the step
/// says, and for two steps the frame after the press. Each step plays a clip
/// from snyvi.com; these are what it is wherever the clip can't play, so
/// they are compiled in: a first run offline, or a window that can't play
/// H.264, still has the whole tour. About 500 KB, the reason the binary's
/// budget went to 19 MB (src/bench.rs).
macro_rules! tour {
    ($($n:literal),* $(,)?) => {
        &[$(
            (concat!("tour-", $n, "-light.webp"), include_bytes!(concat!("../../ui/tour/tour-", $n, "-light.webp"))),
            (concat!("tour-", $n, "-dark.webp"), include_bytes!(concat!("../../ui/tour/tour-", $n, "-dark.webp"))),
        )*]
    };
}
pub(crate) const TOUR: &[(&str, &[u8])] = tour!(
    "promise", "desk", "connect", "ready", "plan", "waiting", "turn", "notes", "home", "focus",
    "friend", "agents", "search",
);

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
        // The newest asides, and whether the corner has anything to say:
        // Lately's dot and how much waits on the reader across desks, fresh,
        // so the first paint knows whether to fetch it (`ui/corner.js`). A
        // count only: the rows are behind the desk gate (`lately`), and a
        // tab, which has no desks, does not show it.
        o.insert("notes".into(), json!(aside_list(app)));
        let (unseen, on_you) = app
            .store
            .clocked(|c, now| {
                Ok((
                    crate::lately::unseen(c, now)?,
                    crate::thread::waiting(c, now)?
                        .iter()
                        .filter(|t| !t.stale && t.via != "dialog")
                        .count(),
                ))
            })
            .unwrap_or_default();
        o.insert("lately_unseen".into(), json!(unseen));
        o.insert("on_you".into(), json!(on_you));
        // Whether there is a friend, so a menu offers Send to a friend… only
        // then; the menu asks again as it opens (`ui/menu.js`).
        o.insert("friends".into(), json!(friend_count(app)));
        // The sidebars' order, so the first paint draws them in it.
        o.insert("layout".into(), layout_json(app));
        // And the global widgets in it, drawn: no widget waits on a request.
        o.insert("widgets".into(), global_seats_json(app));
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

/// What a friend said back about a document, and who it can be answered
/// to: the head's replies and its Reply… (pairing's second cut).
#[derive(Default)]
pub(crate) struct Talk {
    pub(crate) replies: Vec<crate::peer::Reply>,
    /// A friend's document from 1.23 on: their name, for Reply to Trapti….
    pub(crate) reply_to: Option<String>,
    /// A friend's document: their name as it is now, not as it was when it
    /// came (one name everywhere). None falls back to the sender it names.
    pub(crate) from: Option<String>,
    /// The reader's own document that is open lines' plan: Approve in its head.
    pub(crate) plan: Option<crate::waiting::PlanFor>,
    /// The reader's own document: where it went, each friend's newest send
    /// and what became of it (1.49, F2), said in Send to…'s place.
    pub(crate) sent: Vec<SentTo>,
}

/// One friend a document went to, and how far it got.
pub(crate) struct SentTo {
    pub(crate) name: String,
    /// waiting, away, sent, arrived or read.
    pub(crate) state: &'static str,
    /// When it got there; 0 for what has not gone.
    pub(crate) at: i64,
}

/// How far a send got, in one word, and when: read, arrived, held for a
/// friend who is away, sent, or not gone yet -- waiting, or away when the
/// line says they are.
fn sent_to(name: String, s: &crate::peer::Sent, away: bool) -> SentTo {
    let (state, at) = if s.read_at > 0 {
        ("read", s.read_at)
    } else if s.arrived_at > 0 {
        ("arrived", s.arrived_at)
    } else if s.held_at > 0 || (s.sent_at == 0 && away) {
        ("away", s.held_at)
    } else if s.sent_at > 0 {
        ("sent", s.sent_at)
    } else {
        ("waiting", 0)
    };
    SentTo { name, state, at }
}

/// The talk for `doc`, from the store.
pub(crate) fn talk(app: &App, doc: &Doc) -> Talk {
    let frame = (doc.origin == "peer")
        .then(|| app.store.peer_frame(&doc.id).ok())
        .flatten();
    let friend = frame
        .as_ref()
        .and_then(|(key, _, _)| app.store.peer_by_key(key).ok().flatten());
    let reply_to = friend
        .as_ref()
        .filter(|p| p.removed_at == 0)
        .filter(|_| frame.as_ref().is_some_and(|(_, _, re)| !re.is_empty()))
        .map(|p| p.name.clone());
    // One thread both ways (1.49): theirs and the reader's own, under
    // either side's copy.
    let replies = app.store.peer_replies(&doc.id).unwrap_or_default();
    let sent = if doc.origin == "peer" {
        Vec::new()
    } else {
        let away = app.peers.away.lock().unwrap().clone();
        app.store
            .peer_sent_of_doc(&doc.id)
            .unwrap_or_default()
            .into_iter()
            .map(|(name, s)| {
                let gone = away.contains_key(&s.peer_id);
                sent_to(name, &s, gone)
            })
            .collect()
    };
    Talk {
        replies,
        reply_to,
        from: friend.map(|p| p.name),
        plan: None,
        sent,
    }
}

/// The talk a document is drawn with: a friend's side only once there is a
/// friend, and the plan it is for whether or not -- the reader's own plan
/// for open lines on a desk grows Approve (`crate::waiting`).
pub(crate) fn talk_for(app: &App, doc: &Doc, friends: usize) -> Talk {
    let mut t = if friends > 0 {
        talk(app, doc)
    } else {
        Talk::default()
    };
    if doc.origin != "peer" {
        t.plan = app
            .store
            .clocked(|c, _| crate::waiting::plan_for(c, &doc.id))
            .ok()
            .flatten();
    }
    t
}

/// Server-side document markup. `friends` is how many friends there are:
/// Send to… shows on the reader's own documents from one, and on a friend's
/// from two, since the one there is is who sent it.
pub(crate) fn doc_html(doc: &Doc, body: &str, friends: usize, talk: &Talk) -> String {
    // A document stored before 1.34 opens with its players as buttons too.
    let body = render::lazy_players(body);
    let body: &str = &body;
    let e = html_escape::encode_text;
    // What goes inside a quoted attribute: a friend names themselves and
    // their documents, and a `"` there must stay a character.
    let q = html_escape::encode_double_quoted_attribute;
    // A friend's document says who, and that the signature checked: the
    // only way a document gets `peer` as its origin is through a frame that
    // opened under a pinned key (`crate::peer::open`).
    let theirs = doc.origin == "peer" && !doc.sender.is_empty();
    // Who, by the one name they have now; the name it came under if the
    // friend is gone.
    let who = talk.from.as_ref().unwrap_or(&doc.sender);
    let mut sub = if theirs {
        // In one of the reader's folders -- filed there because both have
        // the repository, or kept there -- it says which; on a desk, which
        // desk. The workflow is theirs either way, and left out when it only
        // says again who sent it.
        let filed = if doc.filed {
            format!(" · in {}", e(&doc.project))
        } else {
            String::new()
        };
        let on = doc
            .desk
            .as_ref()
            .filter(|d| !doc.filed || d.name != doc.project)
            .map(|d| format!(" · on {}", e(&d.name)))
            .unwrap_or_default();
        let flow = if doc.workflow_title == format!("Sent by {}", doc.sender) {
            String::new()
        } else {
            format!(" · {}", e(&doc.workflow_title))
        };
        format!(
            "{}from {} · <span data-tip=\"Signed with the key you paired with\">verified</span>{filed}{on}{flow}",
            friend_mark(who),
            e(who)
        )
    } else {
        format!("{} · {}", e(&doc.project), e(&doc.workflow_title))
    };
    if let Some(b) = &doc.branch {
        sub.push_str(&format!(" · <span class=\"branch\">{}</span>", e(b)));
    }
    // The page says it again in the reader's own format (`fmt`, app.js), so
    // the head and the rail's Received read alike; this is what shows first.
    sub.push_str(&format!(
        " · <time data-ts=\"{}\">{}</time>",
        doc.received_at,
        fmt_time(doc.received_at)
    ));
    // The reader's own document: Send to…, once there is a friend to send
    // to, in the sub line, so the head is the same height with it and
    // without. The page wires the click (`ui/peer.js`).
    if !theirs {
        if friends > 0 || !talk.sent.is_empty() {
            sub.push_str(&send_button(doc, talk, " · "));
        }
        sub.push_str(&approve_button(doc, talk));
        return head(doc, body, &sub, "", talk);
    }
    // A friend's document: what can be done with it, in a row of its own
    // under who sent it. The row is there whichever buttons it holds, so
    // the head never changes height as one comes or goes; its look is
    // inline, so the first paint's stylesheet carries nothing for it.
    let mut acts = String::new();
    // Keep on a desk…, and once it is on one, Save into the folder. The
    // page wires both (`ui/peer.js`), and the daemon asks for the window's
    // capability, since both name a desk.
    let (act, label) = if doc.desk.is_some() {
        ("save", "Save into the folder")
    } else {
        ("keep", "Keep on a desk…")
    };
    acts.push_str(&format!(
        "<button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-act=\"{act}\" data-send=\"{}\" data-send-title=\"{}\">{label}</button>",
        q(&doc.id),
        q(&doc.title)
    ));
    // And the way back to the friend's own row, every version with it.
    if doc.filed {
        let row = crate::peer::from_name(who);
        acts.push_str(&format!(
            "<button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-act=\"unfile\" data-send=\"{}\" data-send-title=\"{}\" data-tip=\"Off the desk, back under {}\" data-tip-sub=\"with every version; nothing on disk moves\">Back to {}</button>",
            q(&doc.id),
            q(&doc.title),
            q(&row),
            e(&row)
        ));
    }
    // One line back to them, in a box the page opens (`ui/peer.js`).
    if let Some(to) = &talk.reply_to {
        acts.push_str(&format!(
            "<button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-act=\"reply\" data-send=\"{}\" data-send-title=\"{}\" data-to=\"{}\">Reply to {}…</button>",
            q(&doc.id),
            q(&doc.title),
            q(to),
            e(to)
        ));
    }
    if friends >= 2 {
        acts.push_str(&send_button(doc, &Talk::default(), ""));
    }
    let acts = format!(
        "<div class=\"doc-acts\" style=\"display:flex;flex-wrap:wrap;gap:2px 18px;margin:6px 0 0;font-size:var(--fs-ui);color:var(--fg-3)\">{acts}</div>"
    );
    head(doc, body, &sub, &acts, talk)
}

/// Send to…, in a head. Once the reader's own document went somewhere it
/// says where, and how far it got -- "→ Trapti · arrived 21:28" -- in the
/// same place, on one line that never wraps, so the head keeps its height as
/// the word changes (F2). Pressed, it is Send to… still.
fn send_button(doc: &Doc, talk: &Talk, sep: &str) -> String {
    let q = html_escape::encode_double_quoted_attribute;
    if talk.sent.is_empty() {
        return format!(
            "{sep}<button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-send=\"{}\" data-send-title=\"{}\">Send to…</button>",
            q(&doc.id),
            q(&doc.title)
        );
    }
    format!(
        "{sep}<button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-sent=\"1\" data-send=\"{}\" data-send-title=\"{}\" data-tip=\"Send to…\" data-tip-sub=\"{}\" style=\"max-width:24em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom\">{}</button>",
        q(&doc.id),
        q(&doc.title),
        q(&sent_tip(&talk.sent)),
        sent_label(&talk.sent)
    )
}

/// A plan for desk notes: Approve, the go-ahead its panel reads at its
/// next prompt (`crate::waiting`), in the sub line so the head keeps its
/// height; the page wires the click (`ui/plan.js`). Nothing for any other
/// document.
fn approve_button(doc: &Doc, talk: &Talk) -> String {
    let Some(p) = &talk.plan else {
        return String::new();
    };
    let ok = p.ok_at > 0;
    format!(
        " · <button type=\"button\" class=\"doc-send uc-link\" data-w=\"plan\" data-desk=\"{}\" data-doc=\"{}\" data-ok=\"{}\" data-tip=\"{}\">{}</button>",
        p.desk,
        html_escape::encode_double_quoted_attribute(&doc.id),
        u8::from(ok),
        if ok { "Approved by you: its panel goes ahead. Click to take it back" } else { "The go-ahead for this plan: its panel hears it at its next prompt" },
        if ok { "Approved ✓" } else { "Approve" }
    )
}

/// A friend's initial in their own colour, before their name in the head of
/// what they sent (#123): the sidebar, Waiting, Home and a desk's notes wear
/// the same one (`ui/app/02-tree.js` `whoIco`), so a friend's reads as theirs
/// wherever it is. Inline, as the rest of the head's look is.
fn friend_mark(name: &str) -> String {
    let initial: String = name
        .trim()
        .chars()
        .next()
        .map_or("?".into(), |c| c.to_uppercase().collect());
    format!(
        "<span class=\"r-who\" style=\"--h:{};display:inline-grid;vertical-align:-3px;margin-right:6px\" \
         aria-hidden=\"true\">{}</span>",
        friend_hue(name),
        html_escape::encode_text(&initial)
    )
}

/// The friend's colour, as a hue from their name: `whoIco`'s `hueOf`, the
/// same sum over the same code points, so the page and the daemon agree.
pub(crate) fn friend_hue(name: &str) -> u32 {
    name.chars().fold(7, |h, c| (h * 31 + c as u32) % 360)
}

/// The head and the article around it: the title, the sub line, a friend's
/// document's actions, and the replies.
fn head(doc: &Doc, body: &str, sub: &str, acts: &str, talk: &Talk) -> String {
    let e = html_escape::encode_text;
    // What friends said back, under the head, oldest first: part of the
    // page as it is drawn, so nothing arrives under the reader's eyes.
    // Both ways (1.49): the reader's own say You, and under their own
    // document, to whom. Their links are links (F10).
    let theirs = doc.origin == "peer";
    let replies: String = talk
        .replies
        .iter()
        .map(|r| {
            let who = match (r.mine, theirs) {
                (false, _) => format!("<b>{}</b>", e(&r.from)),
                (true, true) => "<b>You</b>".to_string(),
                (true, false) => format!("<b>You</b> → {}", e(&r.from)),
            };
            format!(
                "<li>{who} {} <time data-ts=\"{}\">{}</time></li>",
                link_line(&r.text),
                r.at,
                fmt_time(r.at)
            )
        })
        .collect();
    // Under the reader's own document, the last friend who replied can be
    // answered there (`Reply::own`); under theirs, Reply to … is in the row
    // above.
    let answer = (!theirs)
        .then(|| talk.replies.iter().rev().find(|r| !r.mine))
        .flatten()
        .map(|r| {
            format!(
                "<li><button type=\"button\" class=\"doc-send uc-link\" data-w=\"send\" data-act=\"reply\" data-send=\"{}\" data-send-title=\"{}\" data-to=\"{}\" data-peer=\"{}\">Reply to {}…</button></li>",
                html_escape::encode_double_quoted_attribute(&doc.id),
                html_escape::encode_double_quoted_attribute(&doc.title),
                html_escape::encode_double_quoted_attribute(&r.from),
                r.peer_id,
                e(&r.from)
            )
        })
        .unwrap_or_default();
    let replies = if replies.is_empty() {
        replies
    } else {
        format!("<ul class=\"doc-replies\">{replies}{answer}</ul>")
    };
    format!(
        "<header class=\"doc-head\"><h1 class=\"doc-title\">{}</h1><p class=\"doc-sub\">{}</p>{acts}{}</header><article class=\"prose kind-{}\">{}</article>",
        e(&doc.title),
        sub,
        replies,
        doc.kind.as_str(),
        render::chunk_code(body)
    )
}

/// Where a document went, on Send to…'s button: one friend and how far it
/// got, with its time, or the friends' names when several.
fn sent_label(sent: &[SentTo]) -> String {
    let e = html_escape::encode_text;
    match sent {
        [one] => {
            let when = if one.at > 0 {
                format!(" <time data-ts=\"{}\">{}</time>", one.at, fmt_time(one.at))
            } else {
                String::new()
            };
            format!("→ {} · {}{when}", e(&one.name), state_word(one.state))
        }
        many => format!(
            "→ {}",
            many.iter()
                .map(|s| e(&s.name).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Each friend's word, for the button's tip.
fn sent_tip(sent: &[SentTo]) -> String {
    sent.iter()
        .map(|s| format!("{}: {}", s.name, state_word(s.state)))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// The name is said beside it, in the head and in the tip, so the word
/// never says it again.
fn state_word(state: &str) -> &str {
    match state {
        "away" => "held, they’re away",
        "waiting" => "waiting to go",
        s => s,
    }
}

/// A reply's words, escaped, with each web link a link out: http or https,
/// never this machine, bidi controls gone -- the page's `linkedLine`
/// (ui/home.js), said here because the head is drawn here.
pub(crate) fn link_line(text: &str) -> String {
    let e = html_escape::encode_text;
    let q = html_escape::encode_double_quoted_attribute;
    let text: String = text.chars().filter(|c| !crate::desk::is_bidi(*c)).collect();
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("http") {
        let (before, from) = rest.split_at(at);
        let end = from
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`'))
            .unwrap_or(from.len());
        let url = from[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')', '"', '\'']);
        let host = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .map(|r| r.split(['/', '?', '#']).next().unwrap_or(""))
            .unwrap_or("");
        let local = host.is_empty()
            || host.starts_with("localhost")
            || host.starts_with("127.")
            || host.starts_with("0.0.0.0")
            || host.starts_with("[::1]");
        out.push_str(&e(before));
        if local {
            out.push_str(&e(&from[..url.len().max(4)]));
            rest = &from[url.len().max(4)..];
            continue;
        }
        let shown = url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.");
        let shown: String = if shown.chars().count() > 40 {
            shown.chars().take(40).chain(std::iter::once('…')).collect()
        } else {
            shown.to_string()
        };
        out.push_str(&format!(
            "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\">{}</a>",
            q(url),
            e(&shown)
        ));
        rest = &from[url.len()..];
    }
    out.push_str(&e(rest));
    out
}

/// How many friends there are, removed ones left out: what decides whether
/// a head grows Send to… (`doc_html`), and `boot.friends` for the menus.
pub(crate) fn friend_count(app: &App) -> usize {
    app.store
        .peers()
        .map(|ps| ps.iter().filter(|p| p.removed_at == 0).count())
        .unwrap_or(0)
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

/// Arranging the sidebars and the widgets, drawn by `ui/sidebars.js`.
pub(crate) async fn shell_sidebars(State(app): S) -> Response {
    let tree = app.store.projects().unwrap_or_default();
    let boot = json!({ "view": "sidebars", "tree": tree, "sub": {}, "browse": app.browse.list(), "version": VERSION });
    shell(&app, boot, "", "Sidebars · snyvi")
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
        &{
            let friends = friend_count(&app);
            doc_html(&doc, &body, friends, &talk_for(&app, &doc, friends))
        },
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
    ("nav.js", NAV_JS, JS),
    ("copy.js", COPY_JS, JS),
    ("corner.js", CORNER_JS, JS),
    ("tip.js", TIP_JS, JS),
    ("home.js", HOME_JS, JS),
    ("peer.js", PEER_JS, JS),
    ("toast.js", TOAST_JS, JS),
    ("diff.js", DIFF_JS, JS),
    ("browse.js", BROWSE_JS, JS),
    ("paths.js", PATHS_JS, JS),
    ("sidebars.js", SIDEBARS_JS, JS),
    ("gallery.js", GALLERY_JS, JS),
    ("player.js", PLAYER_JS, JS),
    ("plan.js", PLAN_JS, JS),
    ("friend.js", FRIEND_JS, JS),
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

/// `/assets/tour/{name}`: one of `TOUR`, or nothing.
pub(crate) async fn asset_tour(Path(name): Path<String>) -> Response {
    match TOUR.iter().find(|(n, _)| *n == name) {
        Some((_, bytes)) => immutable("image/webp", *bytes),
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
