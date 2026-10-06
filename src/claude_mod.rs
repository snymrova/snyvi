//! The snyvi mod for Claude Code (#90), and how a panel gets it.
//!
//! The mod's files are in `mod/` and built into this binary. The daemon
//! writes them to `<data>/claude-mod/<version>/` when it starts, with a
//! `snyvi.json` beside them saying where the daemon is and where its token
//! is kept, and a panel it starts is given that folder in
//! `CLAUDE_CODE_PLUGIN_DIRS`: Claude Code loads a folder named there as it
//! would a `--plugin-dir`. So nothing is installed into `~/.claude`, there is
//! no marketplace and nothing to uninstall, a `claude` started in a terminal
//! outside snyvi has no mod, and the mod is always the version of the snyvi
//! that started the panel. Nothing is written for another binary.
//!
//! It is on when the Claude Code on this machine has mods (`SINCE`) and the
//! reader has not turned it off in About ("Claude Code mod in panels"). A
//! panel started before a change picks it up at its next start.

use crate::config::Paths;
use std::path::PathBuf;
use std::sync::OnceLock;

/// The mod, as the binary carries it: its path under the folder, its text.
const FILES: [(&str, &str); 4] = [
    (
        ".claude-plugin/plugin.json",
        include_str!("../mod/.claude-plugin/plugin.json"),
    ),
    ("hooks/hooks.json", include_str!("../mod/hooks/hooks.json")),
    ("hooks/register.tsx", include_str!("../mod/hooks/register.tsx")),
    ("types/index.d.ts", include_str!("../mod/types/index.d.ts")),
];

/// The first Claude Code with mods.
pub const SINCE: (u32, u32, u32) = (2, 1, 287);

/// Where this version's mod is written.
pub fn dir(paths: &Paths) -> PathBuf {
    paths
        .data_dir
        .join("claude-mod")
        .join(crate::version::VERSION)
}

/// Write the mod and its `snyvi.json`, leaving a file that already says the
/// same alone. The folder of an older version is left too: a panel an older
/// daemon started may still be reading it.
pub fn write(paths: &Paths, url: &str) -> std::io::Result<PathBuf> {
    let root = dir(paths);
    let link = serde_json::json!({
        "url": url,
        "token_file": paths.token_path.to_string_lossy(),
    })
    .to_string();
    let mut all: Vec<(&str, &str)> = FILES.to_vec();
    all.push(("snyvi.json", &link));
    for (rel, text) in all {
        let at = root.join(rel);
        if std::fs::read_to_string(&at).ok().as_deref() == Some(text) {
            continue;
        }
        if let Some(parent) = at.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&at, text)?;
    }
    Ok(root)
}

/// `2.1.291 (Claude Code)` as three numbers.
pub fn parse_version(out: &str) -> Option<(u32, u32, u32)> {
    let v = out.split_whitespace().next()?;
    let mut n = v.split('.').map(|p| p.parse::<u32>().ok());
    Some((n.next()??, n.next()??, n.next()??))
}

static HAS_MODS: OnceLock<bool> = OnceLock::new();

/// Whether the `claude` on the daemon's PATH has mods, asked once: on a
/// thread of its own at start (`warm`), so a panel's start never waits on it.
/// Until it has answered, it is no.
pub fn claude_has_mods() -> bool {
    HAS_MODS.get().copied().unwrap_or(false)
}

pub fn warm() {
    std::thread::spawn(|| {
        let ok = crate::platform::find_on_path("claude")
            .and_then(|exe| {
                std::process::Command::new(exe)
                    .arg("--version")
                    .stdin(std::process::Stdio::null())
                    .output()
                    .ok()
            })
            .and_then(|o| parse_version(&String::from_utf8_lossy(&o.stdout)))
            .is_some_and(|v| v >= SINCE);
        let _ = HAS_MODS.set(ok);
    });
}

/// `CLAUDE_CODE_PLUGIN_DIRS` for a panel: the mod's folder, after whatever
/// the daemon's own environment already names.
pub fn plugin_dirs(root: &std::path::Path) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    match std::env::var("CLAUDE_CODE_PLUGIN_DIRS") {
        Ok(had) if !had.trim().is_empty() => format!("{had}{sep}{}", root.display()),
        _ => root.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_three_numbers_and_mods_came_in_2_1_287() {
        assert_eq!(parse_version("2.1.291 (Claude Code)\n"), Some((2, 1, 291)));
        assert_eq!(parse_version("garbage"), None);
        assert!(parse_version("2.1.291").unwrap() >= SINCE);
        assert!(parse_version("2.1.286").unwrap() < SINCE);
        assert!(parse_version("2.2.0").unwrap() >= SINCE);
    }

    /// The mod is written whole beside its `snyvi.json`, and the version it
    /// says is this binary's.
    #[test]
    fn the_mod_is_written_whole_and_is_this_versions() {
        let tmp = std::env::temp_dir().join(format!("snyvi-mod-{}", std::process::id()));
        let paths = Paths {
            data_dir: tmp.join("data"),
            config_dir: tmp.join("config"),
            docs_dir: tmp.join("docs"),
            db_path: tmp.join("db"),
            token_path: tmp.join("token"),
        };
        let root = write(&paths, "http://127.0.0.1:7999").unwrap();
        for (rel, _) in FILES {
            assert!(root.join(rel).is_file(), "{rel}");
        }
        let link: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("snyvi.json")).unwrap()).unwrap();
        assert_eq!(link["url"], "http://127.0.0.1:7999");
        let manifest: serde_json::Value = serde_json::from_str(FILES[0].1).unwrap();
        assert_eq!(manifest["version"], crate::version::VERSION);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
