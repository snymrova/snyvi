//! A thread's stage, read from what happened (1.67, plan f586a9fe09).
//!
//! Until 1.67 a stage was the agent's word: `move_thread building`, `review`,
//! `shipped`. Only a merge moved a thread by itself. So a thread said
//! "building" a week after its PR merged elsewhere, or "idea" with nine
//! commits on its branch, and 127 of them had not moved in a week. Now the
//! first commit seen on its branch is `building`, a PR open is `review`, and
//! the merge is `shipped` as before (`pr_facts`). Where git has been seen on
//! a thread, an agent's word for those three is refused: it keeps `parked`,
//! `waiting`, the plan stages and `told`. A thread git never saw -- a
//! chapter, a clip, work with no branch -- has no facts, and there the
//! agent's word is all there is, so it stands.

use super::*;

/// The stages that git and the PR decide once they have been seen.
const FROM_FACTS: [&str; 3] = ["building", "review", "shipped"];

/// Move thread `id` forward to where its facts put it. Never backward: a
/// thread the reader parked or set waiting stays there, and a shipped one
/// is `pr_facts`'s. Whether it moved.
pub fn stage(conn: &Connection, desk_id: i64, id: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE threads SET stage = CASE
             WHEN pr != '' AND pr_state IN ('', 'open') THEN 'review'
             ELSE 'building' END
         WHERE desk_id = ?1 AND id = ?2 AND removed_at = 0 AND merged = '' AND (
             (pr != '' AND pr_state IN ('', 'open') AND stage IN ('idea', 'planned', 'building'))
             OR (pr = '' AND commits > 0 AND stage IN ('idea', 'planned')))",
        params![desk_id, id],
    )? > 0)
}

/// Why the agent in `pane` may not move its thread to `stage` by its own
/// word, or `None` when it may.
pub fn not_yours(
    conn: &Connection,
    desk_id: i64,
    pane: &str,
    stage: &str,
) -> Result<Option<&'static str>> {
    if !FROM_FACTS.contains(&stage) {
        return Ok(None);
    }
    let Some(t) = of_pane(conn, desk_id, pane)? else {
        return Ok(None);
    };
    if !t.seen && t.pr.is_empty() {
        return Ok(None);
    }
    Ok(Some(match stage {
        "building" => "snyvi reads building from the first commit on the thread's branch; commit, and it moves",
        "review" => "snyvi reads review from the thread's open PR; open one, or pass pr with its number",
        _ => "snyvi reads shipped from the PR's merge; hand the merge over with hand_over, and it moves when GitHub says merged",
    }))
}
