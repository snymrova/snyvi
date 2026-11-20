//! What a turn's end carries, and what no run snyvi starts may do.
//!
//! Both were the pipelines' (`pipeline_run`, 1.40 to 1.66) and outlived
//! them: the Stop hook still says how a turn ended, for a routine's run
//! (`routine_run::heard`) and for answers pressed in snyvi while the agent
//! worked (`api_agent`); and a routine's settings still deny these.

use super::*;

/// What no run snyvi starts may do, whatever its words say: a deny rule
/// matches the command as Claude writes it (permissions.md, "what a Bash
/// rule doesn't match").
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

/// What the hook says at a turn's end (`client::agent_stop`). It sends the
/// transcript's path too, which only a pipeline's runner read.
#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub(crate) struct StopBody {
    pub(crate) reply: String,
    /// A Stop hook already kept this turn going.
    pub(crate) active: bool,
}
