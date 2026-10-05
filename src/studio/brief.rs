//! What a Claude in a studio desk's panel is told about the studio: how to
//! arrange the folder so the viewer can show it, how to keep a script for a
//! call it repeats, and how to work with the reader here.
//! After the desk's own brief (`crate::brief`), with a budget of its own:
//! the desk's is a glance at the list, this is the studio's contract, and
//! one must not crowd the other out.
//!
//! And the studio's news (`Live`): what the reader did in the viewer since
//! the agent's last prompt -- what they are looking at, a ★ -- handed over
//! with the next prompt beside the desk's changes. Never a request: snyvi
//! still never starts a turn.

use std::collections::HashMap;
use std::sync::Mutex;

/// The studio block, at most.
pub const STUDIO_BYTES: usize = 2400;
/// How many lines of news a desk keeps for its agent; older ones go.
const NEWS_KEPT: usize = 40;

/// The studio block, for a desk on `folder`.
pub fn block(folder: &str) -> String {
    let lines: Vec<String> = vec![
        format!(
            "This is a studio desk. You are in its folder, {folder} (also $SNYVI_STUDIO): the reader sees its pictures, videos and sounds in a viewer over this panel, and its folders in the rail. Make them with your own tools -- a provider's API with a key from your environment (read_studio names the keys), or a CLI. With no key for what you need, ask the reader to add it with this desk's ⋯ menu, Keys…: it reaches you when this panel starts again, and Resume keeps this conversation. Never ask them to paste a key here or to export one."
        ),
        "Arrange it: put work in folders, at most 3 deep (launch/stills). A folder may have a folder.json: title, order (names of files and folders, first to last), note, picks; the top one may set budget in USD. Next to each file write <file>.json: prompt, model, provider, seed, params, cost_usd, duration_seconds, resolution, source, parent, license, made_at, note. Never delete or rename files; hide is the reader's.".into(),
        "Scripts save tokens: the second time you make the same kind of call (text-to-image on one service, say), write .scripts/<name>.sh or .py instead of calling again. It takes a prompt and options, saves the file and its .json, and prints only the path -- never the service's raw response. Keys come from the environment, never written in a script. Keep .scripts/README.md, one line per script; read it first and reuse what is there.".into(),
        "Documents (briefs, plans, scripts for a voice) go to the reader with send_document, not into the folder. The reader ★s a file to keep it (its name lands in that folder's folder.json picks, and you are told), hides what they do not want, and may put a line about a file into this panel. Before a paid generation, say the tool, model, rough cost and why; ask before switching provider or model, or going over the budget. If something fails, say what you tried, what failed, the options, and your pick.".into(),
    ];
    let mut out = String::new();
    for l in lines {
        if out.len() + l.len() + 1 > STUDIO_BYTES {
            break;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&l);
    }
    out
}

/// The studio's news per desk, in memory: a daemon that restarts has told
/// its agents nothing yet, and the brief a new session gets says it all.
#[derive(Default)]
pub struct Live {
    news: Mutex<HashMap<i64, Vec<(i64, String)>>>,
    /// What the reader has selected on each desk, and when: only the latest
    /// matters, so it is one line, not a history.
    looking: Mutex<HashMap<i64, (i64, String)>>,
}

impl Live {
    /// A line of news for the desk's agent, as of `at`.
    pub fn say(&self, desk: i64, at: i64, text: String) {
        let mut m = self.news.lock().unwrap_or_else(|e| e.into_inner());
        let v = m.entry(desk).or_default();
        v.push((at, text));
        if v.len() > NEWS_KEPT {
            let drop = v.len() - NEWS_KEPT;
            v.drain(..drop);
        }
    }

    /// The reader selected `rel` in the desk's viewer (empty: nothing).
    pub fn look(&self, desk: i64, at: i64, rel: String) {
        self.looking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(desk, (at, rel));
    }

    /// What the reader has selected, if anything.
    pub fn looking_at(&self, desk: i64) -> Option<String> {
        self.looking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&desk)
            .map(|(_, r)| r.clone())
            .filter(|r| !r.is_empty())
    }

    /// The lines since `since`, oldest first, and the selection if it moved.
    pub fn since(&self, desk: i64, since: i64, folder: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .news
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&desk)
            .map(|v| {
                v.iter()
                    .filter(|(at, _)| *at > since)
                    .map(|(_, t)| t.clone())
                    .collect()
            })
            .unwrap_or_default();
        if let Some((at, rel)) = self
            .looking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&desk)
        {
            if *at > since && !rel.is_empty() {
                out.push(format!("The reader is looking at {folder}/{rel}."));
            }
        }
        out
    }

    /// Forget a desk: closed.
    pub fn forget(&self, desk: i64) {
        self.news
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&desk);
        self.looking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&desk);
    }
}
