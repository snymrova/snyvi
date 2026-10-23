//! The runner: a pipeline's stages, one after another in its panel
//! (`crate::pipeline`, plan 2a0edf418f).
//!
//! What it holds to:
//!
//! - **Started by the reader, and only by them.** A pipeline runs because
//!   the window's Start set it running (`api_pipeline`); nothing a token or
//!   an agent says starts one. What the hooks tell the daemon -- a turn
//!   ended, why it failed -- moves a running stage along, as the reader's
//!   own pipeline asked.
//! - **A step is an argument, never keystrokes.** Each stage is a fresh
//!   `claude` in the panel with the step as one argv entry
//!   (`pane::Start::args`). The one other way a word reaches Claude is a Stop
//!   hook's reason, and only the handoff below says one -- snyvi's own words.
//! - **Its own folder.** Every stage runs in a worktree of the desk's folder
//!   on `pipeline/<name>`, cut at the first Start and never removed, with
//!   deny rules for what no stage may do (`DENY`): push, merge, release,
//!   snyvi's own daemon.
//! - **A stage is over when its turn is.** A Stop the hook passed on, with no
//!   `/goal` still active in the transcript and the transcript quiet for a
//!   moment: Claude Code's goal judge runs beside our hook and writes its
//!   verdict after it (spike S3), so the end is read on the next look, not
//!   in the hook's own request.
//! - **Context.** A goal stage past the pipeline's limit is asked, by the
//!   Stop hook's reason, to commit and `leave_off`; its next Stop hands the
//!   step to a fresh session. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` a little
//!   above the limit is the net under that. snyvi never types `/compact`.
//! - **It stops.** The reader's caps (stages, cycles, minutes, the five-hour
//!   window, a stage's diff), the planner's `done`, two empty loops, a turn
//!   that failed, the reader speaking in the panel: each pauses or ends it,
//!   says why in the strip, and an end writes the report.

use super::*;
use crate::pipeline::{self, transcript, Pipeline, Step};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// How often running pipelines are looked at.
const TICK: Duration = Duration::from_secs(3);
/// How long a stage's transcript stays untouched after its Stop before the
/// stage counts as over: the goal judge's verdict lands in it after the hook.
const QUIET: Duration = Duration::from_secs(4);
/// A stage's process gone this soon after its start is still starting.
const GRACE_S: i64 = 15;
/// How long a panel's last process is given to go before a stage starts.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// What no stage may run, whatever the planner wrote: the pipeline's
/// settings, which snyvi writes and no step can touch. A deny rule matches
/// the command as Claude writes it (permissions.md, "what a Bash rule
/// doesn't match"); the worktree and the branch are what keep the rest of
/// the reader's work out of reach.
pub(crate) const DENY: [&str; 16] = [
    "Bash(git push *)",
    "Bash(git push)",
    "Bash(gh pr merge *)",
    "Bash(gh release *)",
    "Bash(gh workflow run *)",
    "Bash(git worktree remove *)",
    "Bash(git branch -D *)",
    "Bash(git checkout main *)",
    "Bash(git switch main *)",
    "Bash(snyvi restart *)",
    "Bash(snyvi stop *)",
    "Bash(snyvi update *)",
    "Bash(snyvi reset *)",
    "Bash(*install.sh*)",
    "Bash(*7777*)",
    "Bash(sudo *)",
];

/// What the runner keeps between looks, by pane and step: how far each
/// stage's transcript has been read, and the pipelines a planner call or a
/// start is under way for. A daemon's own; a restart pauses every pipeline
/// that was running (`pipeline::pause_all`), so nothing here needs keeping.
#[derive(Default)]
struct Runs {
    read: HashMap<(String, i64), (String, transcript::Seen)>,
    busy: HashSet<i64>,
}

static RUNS: LazyLock<Mutex<Runs>> = LazyLock::new(Default::default);

fn runs() -> std::sync::MutexGuard<'static, Runs> {
    RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the hook says at a turn's end (`client::agent_stop`).
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub(crate) struct StopBody {
    pub(crate) transcript: String,
    pub(crate) reply: String,
    /// A Stop hook already kept this turn going.
    pub(crate) active: bool,
}

/// The runner, on its own task, from the daemon's start.
pub(crate) fn spawn(app: Arc<App>) {
    let _ = app.store.clocked(|c, _| pipeline::pause_all(c));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app).await;
        }
    });
}

/// A desk's pipelines moved: its windows read them again. The `desknotes`
/// event the rail already reads, so first paint needs no new listener.
pub(crate) fn changed(app: &App, desk: i64) {
    emit(app, "desknotes", json!({ "desk": desk, "pipelines": true }));
}

async fn tick(app: &Arc<App>) {
    let Ok(ps) = app.store.clocked(|c, _| pipeline::live(c)) else {
        return;
    };
    let now = crate::store::now();
    for p in ps {
        if runs().busy.contains(&p.id) {
            continue;
        }
        if p.state == "paused" {
            if p.resume_at > 0 && now >= p.resume_at {
                let _ = app
                    .store
                    .clocked(|c, now| pipeline::set_state(c, p.id, "running", "", now));
                changed(app, p.desk_id);
            }
            continue;
        }
        match p.running().cloned() {
            Some(s) => watch(app, &p, &s, now).await,
            None => advance(app, p).await,
        }
    }
}

/// Where the goal of a stage's session stands, read on from the last look.
fn goal_of(pane: &str, s: &Step) -> transcript::Goal {
    if s.transcript.is_empty() {
        return transcript::Goal::None;
    }
    let key = (pane.to_string(), s.id);
    let mut r = runs();
    let was = match r.read.get(&key) {
        Some((path, seen)) if *path == s.transcript => seen.clone(),
        _ => transcript::Seen::default(),
    };
    let seen = transcript::scan(Path::new(&s.transcript), &was).unwrap_or(was);
    let goal = seen.goal.clone();
    r.read.insert(key, (s.transcript.clone(), seen));
    goal
}

/// Whether the stage's last turn has been over long enough to believe it.
fn quiet(s: &Step, now: i64) -> bool {
    let since_stop = now - s.stopped_at >= QUIET.as_secs() as i64;
    let file_quiet = std::fs::metadata(&s.transcript)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|e| e >= QUIET);
    since_stop && file_quiet
}

/// A stage under way: is it over, handed on, or gone?
async fn watch(app: &Arc<App>, p: &Pipeline, s: &Step, now: i64) {
    let status = app.panes.status(&p.pane);
    if let Some(pct) = status.ctx_pct {
        let _ = app
            .store
            .clocked(|c, _| pipeline::step_peak(c, s.id, i64::from(pct)));
    }
    if !status.running {
        if now - s.started_at < GRACE_S {
            return;
        }
        if s.stopped_at > 0 {
            finish(app, p, s, "done").await;
        } else {
            pause(app, p, "the panel's program ended before its turn did", 0);
            let _ = app.store.clocked(|c, now| {
                pipeline::step_ended(
                    c,
                    s.id,
                    &pipeline::End {
                        state: "failed",
                        result: &s.last_reply,
                        commits: "",
                        diff_lines: 0,
                    },
                    now,
                )
            });
        }
        return;
    }
    if s.stopped_at == 0 || status.agent == "working" || !quiet(s, now) {
        return;
    }
    match goal_of(&p.pane, s) {
        transcript::Goal::Cleared(why) => {
            let _ = app.store.clocked(|c, _| pipeline::requeue_step(c, s.id));
            pause(app, p, &format!("Claude Code cleared the goal: {why}"), 0);
        }
        transcript::Goal::Active if s.handoff < 0 => {
            let left = app
                .store
                .desk(p.desk_id)
                .ok()
                .flatten()
                .and_then(|d| d.left_off)
                .map(|l| l.text);
            let _ = app
                .store
                .clocked(|c, _| pipeline::step_handoff(c, s.id, false));
            start_stage(app, p, s, left.as_deref()).await;
        }
        transcript::Goal::Active => {}
        _ => finish(app, p, s, "done").await,
    }
}

/// A stage is over: what it did, and whether the pipeline goes on.
async fn finish(app: &Arc<App>, p: &Pipeline, s: &Step, state: &str) {
    let folder = PathBuf::from(&p.folder);
    let base = s.base.clone();
    let (commits, lines) = tokio::task::spawn_blocking(move || {
        let range = format!("{base}..HEAD");
        let commits =
            git(&folder, &["log", "--reverse", "--format=%h %s", &range]).unwrap_or_default();
        let lines = git(&folder, &["diff", "--shortstat", &base])
            .map(|s| changed_lines(&s))
            .unwrap_or(0);
        (commits, lines)
    })
    .await
    .unwrap_or_default();
    let ended = pipeline::End {
        state,
        result: &s.last_reply,
        commits: commits.trim(),
        diff_lines: lines,
    };
    let _ = app
        .store
        .clocked(|c, now| pipeline::step_ended(c, s.id, &ended, now));
    runs().read.remove(&(p.pane.clone(), s.id));
    let status = app.panes.status(&p.pane);
    if status.entered_at >= s.started_at && s.started_at > 0 {
        pause(
            app,
            p,
            "you spoke in the panel; Resume goes on with the next step",
            0,
        );
    } else if lines > i64::from(p.caps.diff_lines) {
        end(
            app,
            p,
            "stopped",
            &format!(
                "stage {} changed {lines} lines, over the cap of {}",
                s.n, p.caps.diff_lines
            ),
        )
        .await;
    } else {
        changed(app, p.desk_id);
    }
}

/// Lines added and removed, from `git diff --shortstat`.
fn changed_lines(stat: &str) -> i64 {
    stat.split(',')
        .filter(|part| part.contains("insertion") || part.contains("deletion"))
        .filter_map(|part| part.split_whitespace().next()?.parse::<i64>().ok())
        .sum()
}

/// No stage is running: start the next, ask the planner for one, or end.
async fn advance(app: &Arc<App>, p: Pipeline) {
    let now = crate::store::now();
    if p.ran() >= p.caps.stages as usize {
        return end(app, &p, "done", &format!("ran {} stages, the cap", p.ran())).await;
    }
    if p.started_at > 0 && now - p.started_at > i64::from(p.caps.minutes) * 60 {
        return end(
            app,
            &p,
            "done",
            &format!("{} minutes, the cap", p.caps.minutes),
        )
        .await;
    }
    if let Some(l) = app.panes.status(&p.pane).five_hour {
        if l.used >= f64::from(p.caps.five_hour) {
            let why = format!(
                "the five-hour window is {}% used, past the cap of {}%",
                l.used.round(),
                p.caps.five_hour
            );
            let _ = app
                .store
                .clocked(|c, _| pipeline::pause_until(c, p.id, &why, l.resets_at.max(0)));
            changed(app, p.desk_id);
            return;
        }
    }
    if let Some(s) = p.queued().cloned() {
        return start_stage(app, &p, &s, None).await;
    }
    if p.proposed().is_some() {
        if p.state != "waiting" {
            let _ = app
                .store
                .clocked(|c, now| pipeline::set_state(c, p.id, "waiting", "", now));
            changed(app, p.desk_id);
        }
        return;
    }
    match p.kind.as_str() {
        "list" => end(app, &p, "done", "every step ran").await,
        "loop" => {
            let done: Vec<&Step> = p.steps.iter().filter(|s| s.state == "done").collect();
            if done.len() >= p.caps.cycles as usize {
                return end(app, &p, "done", &format!("{} cycles, the cap", done.len())).await;
            }
            let empty = |s: &&Step| s.result.lines().any(|l| l.trim() == pipeline::NOTHING_LEFT);
            if done.len() >= 2 && done.iter().rev().take(2).all(empty) {
                return end(app, &p, "done", "nothing left to do, twice in a row").await;
            }
            let _ = app.store.clocked(|c, now| {
                pipeline::add_step(c, p.id, "reader", "prompt", &p.goal, "", "queued", now)
            });
            changed(app, p.desk_id);
        }
        _ => plan(app, p),
    }
}

/// The planner, on a thread of its own; the pipeline is busy until it
/// answers. Its step is queued with autopilot on, and waits for Go without.
fn plan(app: &Arc<App>, p: Pipeline) {
    runs().busy.insert(p.id);
    let app = app.clone();
    tokio::spawn(async move {
        let root = app
            .store
            .desk(p.desk_id)
            .ok()
            .flatten()
            .map(|d| d.root)
            .unwrap_or_default();
        let p = match ready(&app, &p, &root).await {
            Ok(p) => p,
            Err(e) => {
                runs().busy.remove(&p.id);
                return pause(&app, &p, &format!("{e:#}"), 0);
            }
        };
        let token = account_token(&app, &p).await;
        let folder = PathBuf::from(&p.folder);
        let path = super::widget_run::path_now();
        let pp = p.clone();
        let asked = tokio::task::spawn_blocking(move || {
            let range = format!("{}..HEAD", pp.base);
            let g = pipeline::planner::Git {
                log: git(&folder, &["log", "--oneline", "-40", &range]).unwrap_or_default(),
                stat: git(&folder, &["diff", "--stat", &pp.base]).unwrap_or_default(),
                status: git(&folder, &["status", "--short"]).unwrap_or_default(),
            };
            let prompt = pipeline::planner::prompt(&pp, &g);
            pipeline::planner::ask(
                &pipeline::planner::Run {
                    program: "claude",
                    path: &path,
                    cwd: &folder,
                    model: &pp.planner_model,
                    token: token.as_deref(),
                },
                &prompt,
            )
        })
        .await;
        runs().busy.remove(&p.id);
        match asked {
            Ok(Ok(n)) if n.done => {
                let why = if n.why.is_empty() {
                    "the goal holds".to_string()
                } else {
                    n.why
                };
                end(&app, &p, "done", &format!("the planner: {why}")).await;
            }
            Ok(Ok(n)) => {
                let state = if p.autopilot { "queued" } else { "proposed" };
                let _ = app.store.clocked(|c, now| {
                    pipeline::add_step(c, p.id, "planner", &n.kind, &n.text, &n.why, state, now)?;
                    if !p.autopilot {
                        pipeline::set_state(c, p.id, "waiting", "", now)?;
                    }
                    Ok(())
                });
                changed(&app, p.desk_id);
            }
            Ok(Err(e)) => pause(&app, &p, &format!("the planner: {e:#}"), 0),
            Err(e) => pause(&app, &p, &format!("the planner: {e}"), 0),
        }
    });
}

/// The desk's Claude account's token for the planner, as the panel's own
/// start would set it; none for the `/login` account.
async fn account_token(app: &Arc<App>, p: &Pipeline) -> Option<String> {
    let placed = app.store.pane(&p.pane).ok().flatten()?;
    let env = super::api_desk::pane_env(app, &placed).await.env;
    env.into_iter()
        .find(|(k, _)| k == crate::accounts::TOKEN_VAR)
        .map(|(_, v)| v)
}

/// Start a stage: the worktree, the settings, the panel's last process
/// stopped, and `claude` with the step as one argument.
async fn start_stage(app: &Arc<App>, p: &Pipeline, s: &Step, left_off: Option<&str>) {
    runs().busy.insert(p.id);
    let r = start_stage_now(app, p, s, left_off).await;
    runs().busy.remove(&p.id);
    if let Err(e) = r {
        pause(app, p, &format!("{e:#}"), 0);
    } else {
        changed(app, p.desk_id);
    }
}

async fn start_stage_now(
    app: &Arc<App>,
    p: &Pipeline,
    s: &Step,
    left_off: Option<&str>,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let placed = app
        .store
        .pane(&p.pane)?
        .context("the pipeline's panel is closed")?;
    let p = ready(app, p, &placed.root).await?;
    let settings = settings_file(&app.paths.data_dir, p.id)?;
    let mut env = super::api_desk::pane_env(app, &placed).await.env;
    env.push((
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(),
        (p.ctx_limit + 15).min(95).to_string(),
    ));
    let prompt = pipeline::stage_prompt(&p, s, left_off);
    let args: Vec<String> = vec![
        "--permission-mode".into(),
        "auto".into(),
        "--settings".into(),
        settings.to_string_lossy().into_owned(),
        "--".into(),
        prompt,
    ];
    let live = app.panes.get(&p.pane);
    if app.panes.is_running(&p.pane) {
        live.stop();
        let until = Instant::now() + STOP_WAIT;
        while app.panes.is_running(&p.pane) {
            if Instant::now() > until {
                anyhow::bail!("the panel's program did not stop for the next stage");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let folder = p.folder.clone();
    let head = tokio::task::spawn_blocking(move || git(Path::new(&folder), &["rev-parse", "HEAD"]))
        .await??;
    let (cols, rows) = live.size();
    live.start(
        crate::pane::Start {
            cwd: &p.folder,
            root: &p.folder,
            cmd: "claude",
            args: &args,
            desk: &placed.desk_name,
            slot: placed.pane.slot,
            cols,
            rows,
            accent: "",
            offer: false,
            env: &env,
            account: placed.account(),
            back: crate::desk::in_back(placed.pane.slot),
        },
        &app.panes,
    )?;
    app.store
        .clocked(|c, now| pipeline::step_began(c, s.id, head.trim(), now))?;
    Ok(())
}

/// The pipeline with its worktree made, or found, and its start written
/// down: what a stage and the planner both run in.
async fn ready(app: &Arc<App>, p: &Pipeline, root: &str) -> anyhow::Result<Pipeline> {
    let mut p = p.clone();
    if p.folder.is_empty() || !Path::new(&p.folder).is_dir() {
        let (root, slug) = (root.to_string(), pipeline::slug(&p.name));
        let (folder, branch, base) =
            tokio::task::spawn_blocking(move || worktree(Path::new(&root), &slug)).await??;
        app.store
            .clocked(|c, now| pipeline::started(c, p.id, &folder, &branch, &base, now))?;
        if p.base.is_empty() {
            p.base = base;
        }
        p.folder = folder;
        p.branch = branch;
    } else {
        app.store
            .clocked(|c, now| pipeline::started(c, p.id, &p.folder, &p.branch, "", now))?;
    }
    Ok(p)
}

/// The pipeline's worktree beside the desk's folder, on its own branch:
/// made at the first Start from the folder's HEAD, found again after. Never
/// removed by snyvi. Its folder, its branch, and the commit it was cut at.
fn worktree(root: &Path, slug: &str) -> anyhow::Result<(String, String, String)> {
    use anyhow::Context;
    let top = git(root, &["rev-parse", "--show-toplevel"]).context(
        "the desk's folder is not a git repository: a pipeline works on a branch of one",
    )?;
    let top = PathBuf::from(top.trim());
    let name = top
        .file_name()
        .and_then(|n| n.to_str())
        .context("the desk's folder has no name")?;
    let folder = top
        .parent()
        .context("the desk's folder has no parent")?
        .join(format!("{name}-pipeline-{slug}"));
    let branch = format!("pipeline/{slug}");
    if !folder.is_dir() {
        let has_branch = git(
            &top,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok();
        let f = folder.to_string_lossy().into_owned();
        if has_branch {
            git(&top, &["worktree", "add", &f, &branch])?;
        } else {
            git(&top, &["worktree", "add", "-b", &branch, &f, "HEAD"])?;
        }
    }
    let on = git(&folder, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if on.trim() != branch {
        anyhow::bail!("{} is on {}, not {branch}", folder.display(), on.trim());
    }
    let base = git(&folder, &["rev-parse", "HEAD"])?;
    Ok((
        folder.to_string_lossy().into_owned(),
        branch,
        base.trim().to_string(),
    ))
}

/// `git -C dir …`, each argument as it is; what it printed, or its error.
fn git(dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("PATH", super::widget_run::path_now())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output()?;
    if !out.status.success() {
        anyhow::bail!(
            "git {}: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The pipeline's settings: deny rules and nothing else, written by snyvi
/// beside its store, where no step's worktree reaches.
fn settings_file(data_dir: &Path, id: i64) -> anyhow::Result<PathBuf> {
    let dir = data_dir.join("pipelines").join(id.to_string());
    std::fs::create_dir_all(&dir)?;
    let f = dir.join("settings.json");
    std::fs::write(&f, json!({ "permissions": { "deny": DENY } }).to_string())?;
    Ok(f)
}

/// Paused, saying why, with one line on the reader's On you list.
fn pause(app: &App, p: &Pipeline, why: &str, until: i64) {
    let _ = app.store.clocked(|c, now| {
        if until > now {
            pipeline::pause_until(c, p.id, why, until)
        } else {
            pipeline::set_state(c, p.id, "paused", why, now)
        }
    });
    let ask = crate::thread::Ask {
        kind: "do".into(),
        text: pipeline::cut(
            &format!(
                "Pipeline \"{}\" paused: {why}. Resume it from the panel's pipeline.",
                p.name
            ),
            400,
        ),
        by: "snyvi".into(),
        pane: p.pane.clone(),
        ..Default::default()
    };
    if let Ok(crate::thread::Asked::Turn(t)) = app
        .store
        .clocked(|c, now| crate::thread::ask(c, p.desk_id, &ask, now))
    {
        super::api_thread::threads_moved(app, p.desk_id);
        notify_turn(app, &t, 0);
    }
    changed(app, p.desk_id);
}

/// Ended: done or stopped, and the report sent to the desk.
pub(crate) async fn end(app: &Arc<App>, p: &Pipeline, state: &str, why: &str) {
    let _ = app
        .store
        .clocked(|c, now| pipeline::set_state(c, p.id, state, why, now));
    changed(app, p.desk_id);
    let Ok(Some(done)) = app.store.clocked(|c, _| pipeline::by_id(c, p.id)) else {
        return;
    };
    let root = app.store.desk(p.desk_id).ok().flatten().map(|d| d.root);
    let payload = Payload {
        content: Some(pipeline::report(&done)),
        title: Some(format!("Pipeline: {}", done.name)),
        workflow: Some("Pipelines".into()),
        lang: Some("md".into()),
        cwd: root,
        origin: Some("pipeline".into()),
        sender: Some("snyvi".into()),
        pane: Some(done.pane.clone()),
        ..Default::default()
    };
    if let Ok(r) = receive_and_emit(app, payload).await {
        let _ = app
            .store
            .clocked(|c, _| pipeline::set_report(c, p.id, &r.doc.id));
        changed(app, p.desk_id);
    }
}

/// What the hook said at a turn's end, or of a turn that failed, for a
/// panel whose pipeline is running. Its answer, when the stage is past the
/// pipeline's context limit with its goal still open, is the handoff.
pub(crate) fn heard(
    app: &App,
    pane: &str,
    session: Option<&str>,
    stopped: Option<&str>,
    stop: Option<&StopBody>,
) -> Option<serde_json::Value> {
    let failed = stopped.filter(|w| !w.is_empty());
    if stop.is_none() && failed.is_none() {
        return None;
    }
    let p = app
        .store
        .clocked(|c, _| pipeline::of_pane(c, pane))
        .ok()
        .flatten()?;
    if p.state != "running" {
        return None;
    }
    let s = p.running()?.clone();
    if let Some(why) = failed {
        let until = (why == "rate_limit")
            .then(|| app.panes.status(pane).five_hour.map(|l| l.resets_at))
            .flatten()
            .unwrap_or(0);
        let _ = app.store.clocked(|c, _| pipeline::requeue_step(c, s.id));
        pause(app, &p, &format!("the turn ended on {why}"), until);
        return None;
    }
    let stop = stop?;
    let session = session.unwrap_or("");
    let path = if transcript::ours(&stop.transcript, session) {
        stop.transcript.as_str()
    } else {
        ""
    };
    let _ = app
        .store
        .clocked(|c, now| pipeline::step_stopped(c, s.id, session, path, &stop.reply, now));
    if s.kind != "goal" || stop.active || s.handoff < 0 || path.is_empty() {
        return None;
    }
    let pct = i64::from(app.panes.status(pane).ctx_pct?);
    if pct < p.ctx_limit {
        return None;
    }
    let s = Step {
        transcript: path.to_string(),
        ..s
    };
    if !goal_of(pane, &s).active() {
        return None;
    }
    let _ = app
        .store
        .clocked(|c, _| pipeline::step_handoff(c, s.id, true));
    changed(app, p.desk_id);
    Some(json!({ "handoff": format!(
        "This pipeline stage's context is {pct}% full, past the pipeline's limit of {}%. \
         Commit what is done on this branch, call leave_off with where this step stands and \
         what is left of it, then end your turn: a fresh session goes on from there.",
        p.ctx_limit
    ) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stages_lines_are_read_from_git() {
        assert_eq!(
            changed_lines(" 3 files changed, 40 insertions(+), 7 deletions(-)\n"),
            47
        );
        assert_eq!(changed_lines(" 1 file changed, 1 insertion(+)\n"), 1);
        assert_eq!(changed_lines(" 1 file changed, 2 deletions(-)\n"), 2);
        assert_eq!(changed_lines(""), 0);
    }

    #[test]
    fn the_deny_rules_are_a_settings_file_claude_code_reads() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pipe-settings");
        let f = settings_file(&dir.path, 7).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let deny = v["permissions"]["deny"].as_array().unwrap();
        assert!(deny.iter().any(|r| r == "Bash(git push *)"));
        assert_eq!(
            v.as_object().unwrap().len(),
            1,
            "deny rules and nothing else"
        );
    }

    /// The worktree is cut once, beside the desk's folder, on its branch,
    /// and found again; the desk's own checkout stays where it was.
    #[cfg(unix)]
    #[test]
    fn a_pipeline_works_in_a_worktree_of_its_own() {
        let dir = crate::store::tempdir::Dir::new("snyvi-pipe-wt");
        let repo = dir.path.join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        let g = |args: &[&str]| git(&repo, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "one",
        ]);
        let (folder, branch, base) = worktree(&repo, "trim").unwrap();
        assert!(folder.ends_with("proj-pipeline-trim"), "{folder}");
        assert_eq!(branch, "pipeline/trim");
        assert_eq!(base, g(&["rev-parse", "HEAD"]).trim());
        assert_eq!(g(&["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
        let again = worktree(&repo, "trim").unwrap();
        assert_eq!(again.0, folder);
        let plain = dir.path.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(worktree(&plain, "x")
            .unwrap_err()
            .to_string()
            .contains("not a git repository"));
    }
}
