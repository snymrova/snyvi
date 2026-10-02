//! Two words snyvi says in several places, said one way.

use std::path::Path;

/// "just now", "5 min ago", "3 h ago", "2 days ago": how long ago, for a
/// line a person reads.
pub fn ago(secs: i64) -> String {
    let s = secs.max(0);
    match s {
        ..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86399 => format!("{} h ago", s / 3600),
        _ => {
            let d = s / 86400;
            format!("{d} day{} ago", if d == 1 { "" } else { "s" })
        }
    }
}

/// A path with the home directory as `~`, the way the reader writes it.
pub fn tilde(p: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = p.strip_prefix(&home) {
            if rest.as_os_str().is_empty() {
                return "~".into();
            }
            return format!("~/{}", rest.display()).replace('\\', "/");
        }
    }
    p.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ago_reads_as_a_person_says_it() {
        assert_eq!(ago(5), "just now");
        assert_eq!(ago(300), "5 min ago");
        assert_eq!(ago(7200), "2 h ago");
        assert_eq!(ago(86400), "1 day ago");
        assert_eq!(ago(3 * 86400), "3 days ago");
        assert_eq!(ago(-4), "just now");
    }

    #[test]
    fn tilde_folds_home_and_leaves_the_rest() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(tilde(&home), "~");
        assert_eq!(tilde(&home.join("w").join("ledger")), "~/w/ledger");
        assert_eq!(tilde(Path::new("/srv/x")), "/srv/x");
    }
}
