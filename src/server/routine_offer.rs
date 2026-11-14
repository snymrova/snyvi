//! `offer_routine` (1.66, plan e7fda1ca90): an agent makes or updates a
//! routine in one call, and the reader presses once. What the use said
//! (rethink e36434e663): `pro-forum` was offered thirteen times, three jobs
//! of nine became one routine per hour, and all four offers still waiting
//! asked the reader to open Routines, press Try once now, read a sheet and
//! press Start -- none was started.
//!
//! What it holds to:
//!
//! - **One routine per command on a desk.** The same command updates the
//!   routine that runs it (`routine::by_cmd`); it never makes a second.
//! - **The reader approves what it may run**, and only that: what waits for
//!   them, its watch, its gate, its shape -- and the scripts and frontmatter,
//!   which `routine::file_state` reads. A change to any of those on a live
//!   routine waits as `pending` for their Allow; anything else is written at
//!   once and said in News, with Undo (`news_undo`).
//! - **Files by where they are, never a line of shell from the agent.** The
//!   watch is `.claude/routines/<name>/watch.sh` and the gate `gate.sh` there,
//!   when they exist; `when` says `on watch` to use the watch.
//! - **Checked, never run.** The command file is there and one, the scripts
//!   are executable, `when` reads, the shape is one snyvi takes, and the
//!   agent says what its own try did. Each refusal says what to fix.
//! - **The result says what happens next**, so the agent stops and waits for
//!   the reader's press, which it hears as a message.
//! - A token never starts a routine: only the reader's Start or Allow does.

use super::*;
use crate::routine::{self, places, times, Made, Routine};
use std::path::Path as FsPath;

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct OfferBody {
    pub command: String,
    pub when: String,
    pub asked: String,
    pub tried: String,
    pub waits: Vec<String>,
    pub shape: String,
    pub model: String,
    pub effort: String,
    pub by: String,
}

fn said(code: StatusCode, error: impl Into<String>) -> Response {
    (code, Json(json!({ "error": error.into() }))).into_response()
}

/// The scripts a routine has by where they are: its watch and its gate,
/// as the lines that run them (the folder is first on their PATH), or why
/// one cannot be used.
fn scripts_of(p: &places::Place, cmd: &str, watch: bool) -> Result<(String, String), String> {
    let dir = places::scripts(p, cmd);
    let at = places::scripts_said(p, cmd);
    let file = |name: &str| dir.as_ref().map(|d| d.join(name)).filter(|f| f.is_file());
    let runnable = |f: &FsPath, name: &str| -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(f).map(|m| m.permissions().mode()).unwrap_or(0);
            if mode & 0o111 == 0 {
                return Err(format!("{at}{name} is not executable: chmod +x it"));
            }
        }
        let _ = (f, name);
        Ok(())
    };
    let watch_line = match file("watch.sh") {
        Some(f) if watch => {
            runnable(&f, "watch.sh")?;
            "watch.sh".to_string()
        }
        None if watch => {
            return Err(format!(
                "`on watch` needs a watch: write {at}watch.sh, a script that stays running and prints one line when something happens"
            ))
        }
        _ => String::new(),
    };
    let gate_line = match file("gate.sh") {
        Some(f) => {
            runnable(&f, "gate.sh")?;
            "gate.sh".to_string()
        }
        None => String::new(),
    };
    Ok((watch_line, gate_line))
}

/// Two script lines are one when both run the same script by name: a
/// routine allowed with `sh .claude/routines/x/gate.sh` keeps it.
fn same_script(was: &str, now: &str) -> bool {
    let name = |l: &str| {
        l.split_whitespace()
            .last()
            .map(|w| w.rsplit('/').next().unwrap_or(w).to_string())
            .unwrap_or_default()
    };
    was.trim() == now.trim() || (!was.trim().is_empty() && name(was) == name(now))
}

/// What the agent is told when it is a new routine, or an offer again.
const START_NEXT: &str = "The user sees one row in Waiting: Start, with what they asked and what you tried. Stop here: their press comes to you as your next message. Do not offer it again meanwhile; a second offer of the same command only updates this one.";

/// The agent's `offer_routine`: `POST /api/panes/{id}/routine` (token).
pub(crate) async fn pane_offer_routine(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<OfferBody>,
) -> Response {
    let placed = match agent_pane(&app, &headers, &id) {
        Ok(p) => p,
        Err(no) => return *no,
    };
    let text = b.command.trim().trim_start_matches('/').to_string();
    let Some(line) = routine::from_line(&format!("/{text}")).filter(|l| l.every.is_none() && !l.cmd.is_empty()) else {
        return said(StatusCode::BAD_REQUEST, format!("\"{text}\" is not a command: `command` is the name of a slash command or skill of this project, and its words, like `pro-forum` or `bench main`"));
    };
    let root = std::path::PathBuf::from(&placed.root);
    let place = match routine::resolve(&root, &line) {
        Made::File(p, _) => p,
        Made::Two(a, c) => return said(StatusCode::CONFLICT, format!("/{} is both {a} and {c}, and Claude Code's docs don't say which runs: rename one", line.cmd)),
        _ => return said(StatusCode::BAD_REQUEST, format!("there is no /{0} here: write .claude/commands/{0}.md (or .claude/skills/{0}/SKILL.md) first, then try it once in your panel", line.cmd)),
    };
    let when = match times::when(&b.when) {
        Ok(w) => w,
        Err(why) => return said(StatusCode::BAD_REQUEST, why),
    };
    if b.tried.trim().is_empty() {
        return said(StatusCode::BAD_REQUEST, format!("`tried` is empty: run /{} once in your panel first (and `timeout 70 watch.sh` or `gate.sh; echo $?` if it has them), then say in one line what it did", line.name));
    }
    let (watch, gate) = match scripts_of(&place, &line.cmd, when.watch) {
        Ok(w) => w,
        Err(why) => return said(StatusCode::BAD_REQUEST, why),
    };
    let t = match super::api_routine::triggers_ok(&gate, &watch, &b.shape, &b.model, &b.effort) {
        Ok(t) => t,
        Err(why) => return said(StatusCode::BAD_REQUEST, why),
    };
    let Some(waits) = routine::waits_ok(&b.waits.join("\n")) else {
        return said(StatusCode::BAD_REQUEST, "`waits` takes up to 12 Bash patterns of 200 characters, like `git push *` or `python3 publish.py *`");
    };
    let by = if b.by.is_empty() { "an agent".to_string() } else { b.by.clone() };
    let change = routine::Change {
        name: line.name.clone(),
        lines: when.lines.clone(),
        model: t.model.clone(),
        effort: t.effort.clone(),
        fast: when.fast,
        asked: b.asked.trim().to_string(),
        tried: b.tried.trim().to_string(),
    };
    let found = app
        .store
        .clocked(|c, _| routine::by_cmd(c, placed.desk_id, &line.cmd))
        .ok()
        .flatten();
    let out = match found {
        None => create(&app, &placed, &id, &line, &place.file, &waits, &t, &change, &by),
        Some(r) if r.started_at == 0 => offer_again(&app, &r, &id, &waits, &t, &change, &by),
        Some(r) => update_live(&app, &r, &root, &waits, &t, &change, &by).await,
    };
    match out {
        Ok((code, told, r)) => {
            super::routine_run::changed(&app, placed.desk_id);
            super::api_thread::threads_moved(&app, placed.desk_id);
            (code, Json(json!({ "said": told, "routine": r, "desk": placed.desk_name }))).into_response()
        }
        Err(resp) => resp,
    }
}

type Done = Result<(StatusCode, String, Option<Routine>), Response>;

#[allow(clippy::too_many_arguments)]
fn create(
    app: &App,
    placed: &crate::desk::Placed,
    pane: &str,
    line: &routine::Line,
    file: &str,
    waits: &[String],
    t: &routine::Triggers,
    c: &routine::Change,
    by: &str,
) -> Done {
    let offer = routine::Offer { by, pane };
    let added = app.store.clocked(|conn, now| {
        let added = routine::add(conn, placed.desk_id, line, waits, file, &offer, now)?;
        if let routine::Added::Routine(r) = &added {
            routine::offered(conn, r.id, &c.lines, t, now)?;
            routine::change(conn, r.id, c, now)?;
        }
        Ok(added)
    });
    match added {
        Ok(routine::Added::Routine(r)) => {
            let r = app.store.clocked(|conn, _| routine::get(conn, r.id)).ok().flatten();
            Ok((StatusCode::CREATED, format!("Offered /{}. {START_NEXT}", line.name), r))
        }
        Ok(routine::Added::Full) => Err(said(StatusCode::CONFLICT, format!("this desk keeps {} routines: one of them can take this as a time of its own (`; sun 20:00 news`), or the user removes one", routine::PER_DESK))),
        Ok(routine::Added::NoSuchDesk) => Err(StatusCode::NOT_FOUND.into_response()),
        Err(e) => Err(err(e)),
    }
}

/// An offer, or the reader's draft, offered again: it is updated whole and
/// stays the one Start row.
fn offer_again(
    app: &App,
    r: &Routine,
    pane: &str,
    waits: &[String],
    t: &routine::Triggers,
    c: &routine::Change,
    by: &str,
) -> Done {
    let done = app.store.clocked(|conn, now| {
        conn.execute(
            "UPDATE routines SET waits = ?2, suggested_by = CASE WHEN suggested_by = '' THEN suggested_by ELSE ?3 END,
               suggested_pane = CASE WHEN suggested_by = '' THEN suggested_pane ELSE ?4 END,
               gate = ?5, watch = ?6, shape = ?7
             WHERE id = ?1",
            rusqlite::params![r.id, waits.join("\n"), crate::thread::line(by, 60), pane, t.gate, t.watch, t.shape],
        )?;
        routine::change(conn, r.id, c, now)
    });
    match done {
        Ok(true) => {
            let r = app.store.clocked(|conn, _| routine::get(conn, r.id)).ok().flatten();
            Ok((StatusCode::OK, format!("Updated the offer of /{}; it is still one row. {START_NEXT}", c.name), r))
        }
        Ok(false) => Err(said(StatusCode::CONFLICT, "it is not on view any more")),
        Err(e) => Err(err(e)),
    }
}

/// A live routine offered again: what it may run waits for Allow, the rest
/// is written now and said in News, with Undo.
async fn update_live(
    app: &App,
    r: &Routine,
    root: &FsPath,
    waits: &[String],
    t: &routine::Triggers,
    c: &routine::Change,
    by: &str,
) -> Done {
    let mut pending = routine::Pending { by: by.to_string(), ..Default::default() };
    if waits != r.waits.as_slice() {
        pending.waits = Some(waits.to_vec());
    }
    if !same_script(&r.watch, &t.watch) {
        pending.watch = Some(t.watch.clone());
    }
    if !same_script(&r.gate, &t.gate) {
        pending.gate = Some(t.gate.clone());
    }
    if r.shape.trim() != t.shape.trim() {
        pending.shape = Some(t.shape.clone());
    }
    let (root2, rr) = (root.to_path_buf(), r.clone());
    let file = tokio::task::spawn_blocking(move || routine::file_state(&root2, &rr))
        .await
        .unwrap_or("gone");
    let was_times = app
        .store
        .clocked(|conn, _| times::times_of(conn, r.id))
        .unwrap_or_default();
    let said_change = routine::change_said(r, &was_times, c);
    let undo = json!({
        "routine": r.id,
        "name": r.name,
        "model": r.model,
        "effort": r.effort,
        "fast": r.fast,
        "times": was_times.iter().map(|t| json!({ "every": t.every, "words": t.words, "gated": t.gated })).collect::<Vec<_>>(),
    })
    .to_string();
    let done = app.store.clocked(|conn, now| {
        if !routine::change(conn, r.id, c, now)? {
            return Ok(false);
        }
        routine::set_pending(conn, r.id, &pending)?;
        if !said_change.is_empty() {
            let text = format!("{} changed {}: {said_change}", by, r.name);
            crate::news::add(
                conn,
                r.desk_id,
                &crate::news::New { kind: "changed", text: &text, undo: &undo, by, routine_id: r.id, ..Default::default() },
                now,
            )?;
        }
        Ok(true)
    });
    match done {
        Ok(true) => {}
        Ok(false) => return Err(said(StatusCode::CONFLICT, "it is not on view any more")),
        Err(e) => return Err(err(e)),
    }
    let mut told = format!("Updated /{}, the one routine for it on this desk.", c.name);
    if !said_change.is_empty() {
        told.push_str(&format!(" Live now: {said_change}. The user sees it in News, with Undo."));
    }
    let may = !pending.is_empty() || matches!(file, "changed");
    if may {
        told.push_str(" What it may run changed (its scripts, frontmatter, waits, watch, gate or shape): it keeps running as it was allowed, and the user sees one row in Waiting to Allow the change. Stop here: their press comes to you as your next message.");
    } else if said_change.is_empty() && file != "reworded" {
        told.push_str(" Nothing in it changed.");
    }
    if file == "reworded" {
        told.push_str(" Its command's words changed: it runs on with them, and News shows the user the diff.");
    }
    let r = app.store.clocked(|conn, _| routine::get(conn, r.id)).ok().flatten();
    Ok((StatusCode::OK, told, r))
}

/// News's Undo for an agent's change to a routine (1.66): its line, model,
/// effort, pace and times put back as they were.
pub(crate) fn undo_change(app: &App, undo: &serde_json::Value) -> anyhow::Result<bool> {
    let id = undo["routine"].as_i64().unwrap_or(0);
    let s = |k: &str| undo[k].as_str().unwrap_or_default().to_string();
    let lines: Vec<times::Line> = undo["times"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let e = crate::due::every::every(t["every"].as_str()?)?;
                    Some(times::Line {
                        times: crate::due::every::Times { cadence: e.cadence, at: vec![e.at] },
                        words: t["words"].as_str().unwrap_or_default().to_string(),
                        gated: t["gated"].as_bool().unwrap_or(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let c = routine::Change {
        name: s("name"),
        lines,
        model: s("model"),
        effort: s("effort"),
        fast: undo["fast"].as_bool().unwrap_or(false),
        ..Default::default()
    };
    app.store.clocked(|conn, now| routine::change(conn, id, &c, now))
}

#[cfg(test)]
mod tests {
    use super::same_script;

    #[test]
    fn a_script_named_the_same_is_the_same_script() {
        assert!(same_script("sh .claude/routines/omd-brief/gate.sh", "gate.sh"));
        assert!(same_script("watch.sh", "watch.sh"));
        assert!(!same_script("", "gate.sh"));
        assert!(!same_script("watch.sh", ""));
        assert!(same_script("", ""));
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct WakeBody {
    pub name: String,
    pub line: String,
    pub desk: Option<i64>,
    pub cwd: String,
}

/// `snyvi routine wake <name> "<line>"` (1.66): `POST /api/routines/wake`
/// (token). A line from a script or a local service, kept as an event the
/// way a watch's line is -- through the routine's shape, in its batch --
/// so a service that already knows when something happened need not be a
/// watch. A token wakes only a live routine, and only with a line in the
/// shape the reader allowed: it starts nothing else.
pub(crate) async fn routine_wake(
    State(app): S,
    headers: HeaderMap,
    Json(b): Json<WakeBody>,
) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let desks = app.store.desks().unwrap_or_default();
    let desk = match b.desk {
        Some(id) => desks.into_iter().find(|d| d.id == id),
        None => desks
            .into_iter()
            .filter(|d| !d.root.is_empty() && FsPath::new(&b.cwd).starts_with(&d.root))
            .max_by_key(|d| d.root.len()),
    };
    let Some(desk) = desk else {
        return said(StatusCode::NOT_FOUND, "no desk here: run it in the desk's folder, or pass --desk");
    };
    let cmd = b.name.trim().trim_start_matches('/');
    let Ok(Some(r)) = app.store.clocked(|c, _| routine::by_cmd(c, desk.id, cmd)) else {
        return said(StatusCode::NOT_FOUND, format!("no routine /{cmd} on {}", desk.name));
    };
    if r.state() != "live" {
        return said(StatusCode::CONFLICT, format!("/{cmd} is {}: only a live routine wakes", r.state()));
    }
    let pushed = app
        .store
        .clocked(|c, now| routine::events::push(c, r.id, &r.shape, b.line.trim(), now));
    match pushed {
        Ok(routine::events::Pushed::Kept) => {
            super::routine_run::changed(&app, desk.id);
            let (batch, _) = routine::events::pace(r.fast);
            Json(json!({ "said": format!("/{cmd} woken: it runs within {batch} s with what else came") })).into_response()
        }
        Ok(routine::events::Pushed::Same) => Json(json!({ "said": format!("/{cmd} already has that line waiting") })).into_response(),
        Ok(routine::events::Pushed::Dropped) => said(
            StatusCode::BAD_REQUEST,
            format!("not in /{cmd}'s shape ({}), or too many lines wait", if r.shape.is_empty() { "up to four short words" } else { r.shape.as_str() }),
        ),
        Err(e) => err(e),
    }
}
