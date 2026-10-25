//! The page's side of Claude accounts (`crate::accounts`): the list, adding
//! one with its token, renaming, renewing and taking one away, and which one
//! a desk or a panel starts as. Every route is behind `refuse_desk`, as the
//! keys are. A token goes in once, to the keychain or the 0600 file, and no
//! answer, event or log line here ever has one in it.

use super::*;

use crate::accounts::{self, Account};

/// An account as the sheet lists it: the row, and when to renew its token.
pub(crate) fn shown(a: &Account) -> serde_json::Value {
    json!({
        "id": a.id,
        "label": a.label,
        "created_at": a.created_at,
        "used_at": a.used_at,
        "renew_at": a.created_at + accounts::TOKEN_LIFE_SECS,
    })
}

/// The accounts as the desks are sent them: each with how many running
/// panels run as it, for the remove row's "still run as" line.
pub(crate) fn listed(app: &App) -> Vec<serde_json::Value> {
    app.store
        .claude_accounts()
        .unwrap_or_default()
        .iter()
        .map(|a| {
            let mut v = shown(a);
            v["running"] = json!(app.panes.running_as(a.id));
            v
        })
        .collect()
}

/// What the daemon last heard about each Claude account, by id (0 for your
/// login): the rate-limit windows a panel's status line said, which are the
/// account's and not the panel's, and a turn that ended because its sign-in
/// no longer works (`accounts::AUTH_REASONS`). Not kept on disk: the next
/// status line says it again.
#[derive(Default)]
pub(crate) struct Usage {
    quotas: std::sync::Mutex<std::collections::BTreeMap<i64, Quota>>,
    broken: std::sync::Mutex<std::collections::BTreeMap<i64, &'static str>>,
}

#[derive(Clone, Copy, PartialEq)]
struct Quota {
    five_hour: Option<crate::statusline::Limit>,
    seven_day: Option<crate::statusline::Limit>,
    at: i64,
}

/// A window as a reader sees it: its whole percent and when it resets.
fn seen(l: Option<crate::statusline::Limit>) -> Option<(i64, i64)> {
    l.map(|l| (l.used.round() as i64, l.resets_at))
}

/// What is left of a window now: all of it once it has reset.
fn left(l: Option<crate::statusline::Limit>, now: i64) -> f64 {
    match l {
        Some(l) if l.resets_at > now => (100.0 - l.used).clamp(0.0, 100.0),
        _ => 100.0,
    }
}

impl Usage {
    /// An account's windows, from a status line; whether what a reader sees
    /// of them moved.
    pub(crate) fn heard(
        &self,
        account: i64,
        five_hour: Option<crate::statusline::Limit>,
        seven_day: Option<crate::statusline::Limit>,
        now: i64,
    ) -> bool {
        let q = Quota {
            five_hour,
            seven_day,
            at: now,
        };
        let mut all = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        let was = all.insert(account, q);
        was.is_none_or(|w| {
            (seen(w.five_hour), seen(w.seven_day)) != (seen(five_hour), seen(seven_day))
        })
    }

    /// Every account heard from, as Home and the desks are sent them.
    pub(crate) fn quotas(&self) -> serde_json::Value {
        let all = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        all.iter()
            .map(|(id, q)| (id.to_string(), quota_json(q)))
            .collect::<serde_json::Map<_, _>>()
            .into()
    }

    /// The account with the least left in either window: the one figure a
    /// page that knows one account shows (Home's older `quota`).
    pub(crate) fn least(&self, now: i64) -> Option<(i64, serde_json::Value)> {
        let all = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        all.iter()
            .map(|(id, q)| (*id, q, left(q.five_hour, now).min(left(q.seven_day, now))))
            .min_by(|a, b| a.2.total_cmp(&b.2))
            .map(|(id, q, _)| (id, quota_json(q)))
    }

    /// A turn ended for one of `accounts::AUTH_REASONS`; whether that is new.
    pub(crate) fn broke(&self, account: i64, why: &'static str) -> bool {
        let mut all = self.broken.lock().unwrap_or_else(|e| e.into_inner());
        all.insert(account, why) != Some(why)
    }

    /// The account works again: renewed, or a status line came from it.
    pub(crate) fn mended(&self, account: i64) -> bool {
        let mut all = self.broken.lock().unwrap_or_else(|e| e.into_inner());
        all.remove(&account).is_some()
    }

    /// Whether an account's sign-in no longer works, as last heard: a
    /// routine does not start into a login screen.
    pub(crate) fn is_broken(&self, account: i64) -> bool {
        let all = self.broken.lock().unwrap_or_else(|e| e.into_inner());
        all.contains_key(&account)
    }

    /// An account's five-hour window, as last heard.
    pub(crate) fn five_hour(&self, account: i64) -> Option<crate::statusline::Limit> {
        let all = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        all.get(&account).and_then(|q| q.five_hour)
    }

    pub(crate) fn broken(&self) -> serde_json::Value {
        let all = self.broken.lock().unwrap_or_else(|e| e.into_inner());
        all.iter()
            .map(|(id, why)| (id.to_string(), json!(why)))
            .collect::<serde_json::Map<_, _>>()
            .into()
    }

    /// An account taken away: nothing heard about it is anyone's now.
    pub(crate) fn forget(&self, account: i64) {
        self.quotas
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&account);
        self.broken
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&account);
    }
}

fn quota_json(q: &Quota) -> serde_json::Value {
    json!({ "five_hour": q.five_hour, "seven_day": q.seven_day, "at": q.at })
}

/// The keys sheet hears "accounts"; the desks carry the names too, for a
/// panel's menu and tip, so they hear it as well.
pub(crate) fn accounts_moved(app: &App) {
    emit(app, "accounts", json!({}));
    desks_moved(app);
}

/// "Account N" for an account added without a name (`accounts::next_label`).
fn free_label(app: &App) -> String {
    accounts::next_label(&app.store.claude_accounts().unwrap_or_default())
}

fn unprocessable(why: &str) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "error": why })),
    )
        .into_response()
}

/// Keep a token for an account, off the async threads.
async fn keep_token(app: &App, id: i64, token: String) -> anyhow::Result<crate::secrets::Kept> {
    let secrets = app.secrets.clone();
    tokio::task::spawn_blocking(move || secrets.keep_claude(id, &token))
        .await
        .map_err(|e| anyhow::anyhow!("keeping the token: {e}"))?
}

/// Every account but `/login`, which is always there and has no row.
pub(crate) async fn list_accounts(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.claude_accounts() {
        Ok(all) => {
            Json(json!({ "accounts": all.iter().map(shown).collect::<Vec<_>>() })).into_response()
        }
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct AddAccount {
    #[serde(default)]
    pub(crate) label: String,
    pub(crate) token: String,
}

/// A new account from a pasted token. The row first, for its id; the token
/// under that id; the row taken back if the token could not be kept, so no
/// account is ever listed without one.
pub(crate) async fn add_account(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<AddAccount>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let token = b.token.trim().to_string();
    if let Err(why) = accounts::valid_token(&token) {
        return unprocessable(why);
    }
    let label = accounts::clean_label(&b.label).unwrap_or_else(|| free_label(&app));
    let account = match app.store.add_claude_account(&label) {
        Ok(a) => a,
        Err(e) => return err(e),
    };
    let kept = match keep_token(&app, account.id, token).await {
        Ok(kept) => kept,
        Err(e) => {
            let _ = app.store.remove_claude_account(account.id);
            return err(e);
        }
    };
    accounts_moved(&app);
    Json(json!({ "ok": true, "account": shown(&account), "kept": kept })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct SignInBody {
    #[serde(default)]
    pub(crate) label: String,
    /// The account to give a new token, or none for a new account.
    #[serde(default)]
    pub(crate) renew: Option<i64>,
}

/// Sign an account in: `claude setup-token` in a terminal no one sees, its
/// token kept the moment it is whole (`accounts::signin`). The page asks
/// `signin_now` how it is going; the token is in none of these answers.
pub(crate) async fn signin_start(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<SignInBody>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let label = match b.renew {
        Some(id) => match app.store.claude_account(id) {
            Ok(Some(a)) => a.label,
            Ok(None) => return StatusCode::NOT_FOUND.into_response(),
            Err(e) => return err(e),
        },
        None => accounts::clean_label(&b.label).unwrap_or_else(|| free_label(&app)),
    };
    let app2 = app.clone();
    let (renew, name) = (b.renew, label.clone());
    let keep = move |token: String| -> anyhow::Result<i64> {
        let id = match renew {
            Some(id) => {
                app2.secrets.keep_claude(id, &token)?;
                let _ = app2.store.renewed_claude_account(id);
                app2.usage.mended(id);
                id
            }
            None => {
                let a = app2.store.add_claude_account(&name)?;
                if let Err(e) = app2.secrets.keep_claude(a.id, &token) {
                    let _ = app2.store.remove_claude_account(a.id);
                    return Err(e);
                }
                a.id
            }
        };
        accounts_moved(&app2);
        Ok(id)
    };
    match app.signins.start(label, b.renew, keep) {
        Ok(shown) => Json(json!({ "ok": true, "signin": shown })).into_response(),
        Err(e) => err(e),
    }
}

pub(crate) async fn signin_now(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(json!({ "signin": app.signins.current() })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct SignInCode {
    pub(crate) code: String,
}

/// The code the sign-in page shows when it cannot hand the approval back
/// on its own, typed into the hidden terminal.
pub(crate) async fn signin_code(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<SignInCode>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.signins.code(&b.code) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => unprocessable(&format!("{e:#}")),
    }
}

pub(crate) async fn signin_cancel(
    State(app): S,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    Json(json!({ "ok": true, "cancelled": app.signins.cancel() })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct RenameAccount {
    pub(crate) label: String,
}

pub(crate) async fn rename_account(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenameAccount>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Some(label) = accounts::clean_label(&b.label) else {
        return unprocessable("an account needs a name");
    };
    match app.store.rename_claude_account(id, &label) {
        Ok(true) => {
            accounts_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct RenewAccount {
    pub(crate) token: String,
}

/// A new token for an account that has one: the old one goes, the renewal
/// date moves. Panels already running keep the token they started with.
pub(crate) async fn renew_account(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<RenewAccount>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let token = b.token.trim().to_string();
    if let Err(why) = accounts::valid_token(&token) {
        return unprocessable(why);
    }
    if !matches!(app.store.claude_account(id), Ok(Some(_))) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let kept = match keep_token(&app, id, token).await {
        Ok(kept) => kept,
        Err(e) => return err(e),
    };
    let _ = app.store.renewed_claude_account(id);
    app.usage.mended(id);
    accounts_moved(&app);
    Json(json!({ "ok": true, "kept": kept })).into_response()
}

/// Take an account away: the row, every desk and panel on it back to
/// `/login`, and its token. The window held the row for its Undo, which
/// adds the account again from a fresh token -- a token once forgotten is
/// not snyvi's to bring back, so the Undo is the sheet's, before this call.
pub(crate) async fn remove_account(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.remove_claude_account(id) {
        Ok(true) => {
            let secrets = app.secrets.clone();
            let _ = tokio::task::spawn_blocking(move || secrets.forget_claude(id)).await;
            app.usage.forget(id);
            accounts_moved(&app);
            Json(json!({ "ok": true })).into_response()
        }
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub(crate) struct DeskAccount {
    pub(crate) account: i64,
}

/// The account a desk's new panels start as. The running ones keep theirs;
/// `running` is the ones that follow the desk, for the page's "Switch the N
/// running panels too?".
pub(crate) async fn set_desk_account(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<DeskAccount>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    match app.store.claude_account_exists(b.account) {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    }
    match app.store.set_desk_account(id, b.account) {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return err(e),
    }
    let running: Vec<String> = app
        .store
        .panes_following_desk(id)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            let s = app.panes.status(p);
            s.running && s.account != b.account
        })
        .collect();
    desks_moved(&app);
    Json(json!({ "ok": true, "running": running })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct PaneAccount {
    /// The panel's own account, or null to follow its desk.
    #[serde(default)]
    pub(crate) account: Option<i64>,
    /// Restart a running panel as it, back into its conversation. The page
    /// does the restart -- stop, then `start` with `resume`, the way a
    /// planned restart comes back -- since it has the panel's size; this
    /// says whether it should, and refuses while Claude is mid-answer.
    #[serde(default)]
    pub(crate) switch: bool,
    /// The account's token was just renewed: a switch restarts the panel
    /// even as the account it already runs as, since its environment still
    /// holds the token that stopped working.
    #[serde(default)]
    pub(crate) renewed: bool,
}

pub(crate) async fn set_pane_account(
    State(app): S,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    Json(b): Json<PaneAccount>,
) -> Response {
    if let Some(no) = refuse_desk(&app, &headers, &q) {
        return no;
    }
    let Ok(Some(placed)) = app.store.pane(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if let Some(a) = b.account {
        match app.store.claude_account_exists(a) {
            Ok(true) => {}
            Ok(false) => return StatusCode::NOT_FOUND.into_response(),
            Err(e) => return err(e),
        }
    }
    let status = app.panes.status(&id);
    // Mid-answer is `working` and printing: a turn whose end was never heard
    // -- a limit's `StopFailure` to a hook from before it -- must not hold
    // the switch that is the way out of the limit (note #127).
    if b.switch && app.panes.answering(&id) {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Claude is answering in this panel: switch when it is done" })),
        )
            .into_response();
    }
    if let Err(e) = app.store.set_pane_account(&id, b.account) {
        return err(e);
    }
    // A running panel is what it started as, which the desk may have moved
    // on from since; a stopped one is what it would start as.
    let was = if status.running {
        status.account
    } else {
        placed.account()
    };
    let now = accounts::effective(placed.desk_account, b.account);
    let restart = b.switch && status.running && (was != now || b.renewed);
    desks_moved(&app);
    Json(json!({
        "ok": true,
        "account": now,
        "restart": restart,
        "resume": restart && !placed.pane.resume.is_empty(),
    }))
    .into_response()
}
