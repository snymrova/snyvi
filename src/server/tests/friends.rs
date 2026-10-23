//! A friend's things in a document's head (1.49, audit 6f451571c6): where
//! the reader's own document went, the replies both ways, their links.

use crate::server::assets::{doc_html, link_line, SentTo, Talk};

fn own() -> crate::store::Doc {
    crate::store::Doc {
        id: "d1".into(),
        project_id: 1,
        project: "garden".into(),
        workflow_id: 1,
        workflow: "manual".into(),
        workflow_title: "Sent manually".into(),
        title: "Spring garden plan".into(),
        kind: crate::render::Kind::Markdown,
        lang: None,
        size: 1,
        received_at: 0,
        source_path: Some("plan.md".into()),
        branch: None,
        pinned: false,
        origin: String::new(),
        content_hash: String::new(),
        desk: None,
        sender: String::new(),
        filed: false,
        local_path: None,
    }
}

/// Once the reader's document went to a friend, Send to… says where and
/// how far, in its place and on one line; with no send yet it is Send to….
#[test]
fn send_to_says_where_it_went() {
    let d = own();
    let html = doc_html(&d, "", 1, &Talk::default());
    assert!(html.contains(">Send to…</button>"), "{html}");
    let talk = Talk {
        sent: vec![SentTo {
            name: "Trapti".into(),
            peer_id: 1,
            state: "arrived",
            at: 1_792_771_354,
        }],
        ..Talk::default()
    };
    let html = doc_html(&d, "", 1, &talk);
    assert!(!html.contains(">Send to…</button>"), "{html}");
    assert!(html.contains("data-sent=\"1\""), "{html}");
    assert!(html.contains("→ Trapti · arrived <time data-ts=\"1792771354\">"), "{html}");
    assert!(html.contains("white-space:nowrap"), "the head keeps its height");
    let away = Talk {
        sent: vec![SentTo {
            name: "Trapti".into(),
            peer_id: 1,
            state: "away",
            at: 0,
        }],
        ..Talk::default()
    };
    assert!(doc_html(&d, "", 1, &away).contains("→ Trapti · waiting, Trapti is away"));
}

/// The replies under the reader's own document read both ways, and the
/// last friend who replied can be answered there.
#[test]
fn replies_read_both_ways() {
    let d = own();
    let r = |text: &str, at: i64, mine: bool| crate::peer::Reply {
        from: "Trapti".into(),
        text: text.into(),
        at,
        mine,
        peer_id: 7,
    };
    let talk = Talk {
        replies: vec![r("can bed 3 take squash?", 10, false), r("yes, from May", 20, true)],
        ..Talk::default()
    };
    let html = doc_html(&d, "", 1, &talk);
    assert!(html.contains("<b>Trapti</b> can bed 3 take squash?"), "{html}");
    assert!(html.contains("<b>You</b> → Trapti yes, from May"), "{html}");
    assert!(html.contains("data-act=\"reply\""), "{html}");
    assert!(html.contains("data-peer=\"7\""), "{html}");
}

/// A link in a reply is a link out, never to this machine, and the words
/// around it stay escaped.
#[test]
fn a_replys_link_is_a_link() {
    let html = link_line("see https://www.rhs.org.uk/veg/squash. <b>ok</b>");
    assert!(html.starts_with("see <a href=\"https://www.rhs.org.uk/veg/squash\""), "{html}");
    assert!(html.contains(">rhs.org.uk/veg/squash</a>. &lt;b&gt;ok&lt;/b&gt;"), "{html}");
    let local = link_line("open http://127.0.0.1:7777/d/x now");
    assert!(!local.contains("<a "), "{local}");
    assert_eq!(link_line("httpd is a server"), "httpd is a server");
    assert!(!link_line("a\u{202e}b").contains('\u{202e}'));
}
