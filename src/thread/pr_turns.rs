//! A merge hand-over on a PR no thread follows (1.66, C4). A thread's own PR
//! is read from GitHub each sweep and its merge settles the hand-overs that
//! name it (`settle_merge`); one that names a PR of no thread -- "Merge PR
//! 133", asked from a panel with no thread on that branch -- waited for the
//! reader's Done though GitHub had said merged for hours. These are asked of
//! GitHub too, and settle the same way.

use super::*;

/// The open merge hand-overs on a desk whose link is a PR page no thread on
/// the desk follows: id, the PR's number, the link.
pub fn unfollowed(conn: &Connection, desk_id: i64) -> Result<Vec<(i64, String, String)>> {
    let rows: Vec<(i64, String)> = conn
        .prepare_cached(
            "SELECT id, link FROM turns WHERE desk_id = ?1 AND kind = 'merge' AND answered_at = 0
             AND removed_at = 0 AND link LIKE '%/pull/%' ORDER BY id LIMIT 6",
        )?
        .query_map(params![desk_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let followed: Vec<String> = conn
        .prepare_cached(
            "SELECT pr FROM threads WHERE desk_id = ?1 AND pr != '' AND removed_at = 0",
        )?
        .query_map(params![desk_id], |r| r.get::<_, String>(0))?
        .filter_map(|p| p.ok().and_then(|p| pr_number(&p)))
        .collect();
    Ok(rows
        .into_iter()
        .filter_map(|(id, link)| pr_number(&link).map(|n| (id, n, link)))
        .filter(|(_, n, _)| !followed.contains(n))
        .collect())
}

/// Whether GitHub's PR is the one the link names: the same repository and
/// number (a link to its Files tab too), or no page to compare. A link to
/// another repository's PR is not this folder's to answer.
pub fn same_pr(link: &str, url: &str) -> bool {
    let repo = |s: &str| {
        s.trim()
            .split_once("/pull/")
            .map(|(r, _)| r.to_ascii_lowercase())
    };
    let num = |s: &str| {
        s.split_once("/pull/")
            .and_then(|(_, n)| n.split('/').next().map(str::to_string))
    };
    url.is_empty() || (repo(link) == repo(url) && num(link) == num(url))
}

/// GitHub says the hand-over's PR merged: it is answered so, as a thread's
/// merge answers it, and told at the next prompt.
pub fn merged(conn: &Connection, id: i64, merge: &str, now: i64) -> Result<bool> {
    let short: String = merge.chars().take(7).collect();
    Ok(conn.execute(
        "UPDATE turns SET answer = ?2, answered_in = 'snyvi', answered_at = ?3
         WHERE id = ?1 AND kind = 'merge' AND answered_at = 0",
        params![id, format!("Merged ({short}, seen by snyvi)"), now],
    )? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_names_its_repository_and_number() {
        let u = "https://github.com/snymrova/snyvi/pull/133";
        assert!(same_pr(
            "https://github.com/snymrova/snyvi/pull/133/files",
            u
        ));
        assert!(same_pr(u, ""));
        assert!(!same_pr("https://github.com/other/snyvi/pull/133", u));
        assert!(!same_pr("https://github.com/snymrova/snyvi/pull/13", u));
    }
}
