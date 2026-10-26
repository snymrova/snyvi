//! What waits for the reader (1.53, plan f30461f2c1 §3.5): the Waits list
//! suggested from a command's own lines, what each pattern catches there,
//! and whether a run card's command is on the list.
//!
//! A pattern is a Bash permission rule as Claude Code writes it: the
//! command, up to a `*` that takes the rest (`python3 -I news/publish.py
//! *`). A command made of several (`cd x && …`) is matched part by part,
//! as Claude Code checks each one. What this cannot know it does not
//! pretend to: a pattern that catches the real publish catches its dry run
//! too, and the sheet says the lines, so the reader sees which.

use serde::Serialize;

/// Words a line goes out or spends with.
const GOES_OUT: &[&str] = &[
    "git push",
    "gh pr merge",
    "gh release",
    "npm publish",
    "cargo publish",
    "wrangler deploy",
    "docker push",
    "publish",
    "deploy",
    "release",
];
/// How many suggestions a sheet shows at most.
const SUGGEST_MAX: usize = 8;

/// A pattern the sheet offers, unticked, with the lines it catches.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Suggested {
    pub pattern: String,
    pub lines: Vec<u32>,
    /// `goes out` or `spends OPENROUTER_API_KEY`.
    pub why: String,
}

/// The commands a line of Markdown holds: its `code` spans, or the whole
/// line inside a fence or when it reads as a shell line (`$ cmd`).
fn commands_in(line: &str, fenced: bool) -> Vec<String> {
    let t = line.trim();
    if fenced {
        return vec![t.trim_start_matches("$ ").to_string()];
    }
    let mut v: Vec<String> = t
        .split('`')
        .skip(1)
        .step_by(2)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if v.is_empty() {
        if let Some(rest) = t.strip_prefix("$ ").or_else(|| t.strip_prefix("! ")) {
            v.push(rest.to_string());
        }
    }
    v
}

/// Each line's number and the commands on it.
fn each(text: &str) -> Vec<(u32, Vec<String>)> {
    let mut fenced = false;
    let mut v = Vec::new();
    for (i, l) in text.lines().enumerate() {
        if l.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        let c = commands_in(l, fenced);
        if !c.is_empty() {
            v.push((i as u32 + 1, c));
        }
    }
    v
}

/// The parts of a command Claude Code checks one by one.
fn parts(cmd: &str) -> Vec<&str> {
    cmd.split(['&', '|', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// A key the part uses: `$(snyvi key X)`, `$X_KEY`, `${X_TOKEN}`.
fn key_in(part: &str) -> Option<String> {
    if let Some(i) = part.find("snyvi key ") {
        let name: String = part[i + 10..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty() {
            return Some(name);
        }
    }
    part.split('$').skip(1).find_map(|s| {
        let name: String = s
            .trim_start_matches('{')
            .chars()
            .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
            .collect();
        ["_KEY", "_TOKEN", "_SECRET"]
            .iter()
            .any(|e| name.ends_with(e))
            .then_some(name)
    })
}

/// A part without the `NAME=value` words before its command, a value as
/// the shell reads it: `$(…)` to its `)`, a quote to its close.
fn strip_env(part: &str) -> &str {
    let mut rest = part.trim_start();
    loop {
        let name = rest.find('=').filter(|&i| {
            i > 0
                && rest[..i]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        let Some(i) = name else {
            return rest;
        };
        let v = &rest[i + 1..];
        let end = if let Some(inner) = v.strip_prefix("$(") {
            inner.find(')').map(|j| j + 3)
        } else if let Some(q) = v.chars().next().filter(|c| *c == '"' || *c == '\'') {
            v[1..].find(q).map(|j| j + 2)
        } else {
            Some(v.find(char::is_whitespace).unwrap_or(v.len()))
        };
        let Some(end) = end else {
            return rest;
        };
        rest = v[end..].trim_start();
    }
}

/// How a skill names its own folder in its lines.
const SKILL_DIR: &[&str] = &["${CLAUDE_SKILL_DIR}/", "$CLAUDE_SKILL_DIR/"];

/// A part as a prefix pattern: its words up to the one that does the work
/// -- a script's path, or the word that matched -- then `*`.
///
/// A skill's script runs under its folder's whole path, and a deny on the
/// path as the skill wrote it lets it through (spike S6, 26 Oct: `Bash(python3
/// -I scripts/hello.py *)` did not stop `python3 -I /…/skills/pub/scripts/
/// hello.py`; `Bash(python3 -I *scripts/hello.py *)` did). So for a skill
/// the script's path starts with `*`, and `${CLAUDE_SKILL_DIR}/` is one.
fn pattern_of(part: &str, word: Option<&str>, skill: bool) -> Option<String> {
    let part = SKILL_DIR
        .iter()
        .fold(strip_env(part).to_string(), |p, d| p.replace(d, "*"));
    let toks: Vec<&str> = part.split_whitespace().collect();
    let first = *toks.first()?;
    if first.contains('=') || first.starts_with('$') {
        return None;
    }
    let script = |t: &&str| {
        t.contains('/')
            || [".py", ".sh", ".js", ".mjs", ".ts", ".rb"]
                .iter()
                .any(|e| t.ends_with(e))
    };
    let upto = match word {
        Some(w) => {
            let last = w.split_whitespace().last().unwrap_or(w);
            toks.iter().position(|t| t.contains(last))
        }
        None => None,
    }
    .or_else(|| toks.iter().position(script))
    .unwrap_or(0);
    let mut head: Vec<String> = toks[..=upto].iter().map(|t| t.to_string()).collect();
    if head
        .iter()
        .any(|t| t.contains(['$', '"', '\'', '`', '(', ')']))
    {
        return None;
    }
    if skill {
        for t in head.iter_mut().filter(|t| script(&t.as_str())) {
            if !t.starts_with(['/', '~', '*']) {
                t.insert(0, '*');
            }
        }
    }
    Some(format!("{} *", head.join(" ")))
}

/// The patterns a command's file suggests: lines that go out or spend.
/// `skill` when the text is a skill's `SKILL.md` (`pattern_of`).
pub fn suggest(text: &str, skill: bool) -> Vec<Suggested> {
    let mut v: Vec<Suggested> = Vec::new();
    for (n, cmds) in each(text) {
        for cmd in &cmds {
            for part in parts(cmd) {
                let low = part.to_ascii_lowercase();
                let word = GOES_OUT.iter().find(|w| low.contains(*w)).copied();
                let key = key_in(part);
                let why = match (&key, word) {
                    (Some(k), _) => format!("spends {k}"),
                    (None, Some(_)) => "goes out".to_string(),
                    (None, None) => continue,
                };
                let Some(pattern) = pattern_of(part, word, skill) else {
                    continue;
                };
                match v.iter_mut().find(|s| s.pattern == pattern) {
                    Some(s) => {
                        if !s.lines.contains(&n) {
                            s.lines.push(n);
                        }
                    }
                    None => v.push(Suggested {
                        pattern,
                        lines: vec![n],
                        why,
                    }),
                }
            }
        }
    }
    v.truncate(SUGGEST_MAX);
    v
}

/// One part against one pattern: `*` takes any run of characters, and
/// `x *` takes `x` alone too, as a deny list should.
fn glob(pattern: &str, part: &str) -> bool {
    let p = pattern
        .strip_suffix(":*")
        .map_or(pattern.to_string(), |p| format!("{p} *"));
    if let Some(bare) = p.strip_suffix(" *") {
        if part == bare {
            return true;
        }
    }
    let pieces: Vec<&str> = p.split('*').collect();
    let mut at = 0;
    for (i, piece) in pieces.iter().enumerate() {
        if i == 0 {
            if !part.starts_with(piece) {
                return false;
            }
            at = piece.len();
        } else if i == pieces.len() - 1 && !piece.is_empty() {
            return part.len() >= at + piece.len() && part[at..].ends_with(piece);
        } else {
            match part[at..].find(piece) {
                Some(j) => at += j + piece.len(),
                None => return false,
            }
        }
    }
    pieces.len() > 1 || at == part.len()
}

/// Whether a command is one a pattern catches: any of its parts.
pub fn matches(pattern: &str, cmd: &str) -> bool {
    let p = pattern.trim();
    let p = p
        .strip_prefix("Bash(")
        .and_then(|x| x.strip_suffix(')'))
        .unwrap_or(p);
    !p.is_empty() && parts(cmd).iter().any(|part| glob(p, part))
}

/// The lines of a command's file a pattern catches.
pub fn catches(pattern: &str, text: &str) -> Vec<u32> {
    each(text)
        .into_iter()
        .filter(|(_, cmds)| cmds.iter().any(|c| matches(pattern, c)))
        .map(|(n, _)| n)
        .collect()
}

/// Whether a command is on a Waits list: a run card's Run takes one click.
pub fn on_list(waits: &[String], cmd: &str) -> bool {
    waits.iter().any(|w| matches(w, cmd))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEWS: &str = "# The newsroom

Fetch with `python3 -I newsroom/fetch.py` and draft.

```sh
OPENROUTER_API_KEY=$(snyvi key OPENROUTER_API_KEY) python3 -I newsroom/draft.py
```

When the user approves:

```
cd ~/site && python3 -I newsroom/publish.py --dry-run
python3 -I newsroom/publish.py --post 3
git push origin main
```
";

    #[test]
    fn a_files_lines_that_go_out_or_spend_are_suggested_with_their_lines() {
        let s = suggest(NEWS, false);
        let got: Vec<(&str, &[u32], &str)> = s
            .iter()
            .map(|x| (x.pattern.as_str(), x.lines.as_slice(), x.why.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (
                    "python3 -I newsroom/draft.py *",
                    &[6][..],
                    "spends OPENROUTER_API_KEY"
                ),
                (
                    "python3 -I newsroom/publish.py *",
                    &[12, 13][..],
                    "goes out"
                ),
                ("git push *", &[14][..], "goes out"),
            ]
        );
        assert!(suggest("# Just words, no commands", false).is_empty());
    }

    #[test]
    fn a_pattern_catches_what_claude_codes_rule_would() {
        let p = "python3 -I newsroom/publish.py *";
        assert_eq!(catches(p, NEWS), [12, 13]);
        assert!(matches(
            p,
            "cd ~/site && python3 -I newsroom/publish.py --post 1"
        ));
        assert!(matches(
            &format!("Bash({p})"),
            "python3 -I newsroom/publish.py"
        ));
        assert!(!matches(p, "python3 -I newsroom/fetch.py"));
        assert!(matches("git push *", "git push"));
        assert!(!matches("git push *", "git pushy"));
        assert!(matches("npm run test:*", "npm run test --watch"));
        assert!(matches("gh * merge *", "gh pr merge 12 --squash"));
        assert!(!matches("", "anything"));
        assert!(on_list(&["git push *".into()], "git push origin main"));
        assert!(!on_list(&["git push *".into()], "rm -rf /"));
    }

    #[test]
    fn a_skills_script_is_caught_wherever_its_folder_is() {
        let text = "Publish with `python3 -I ${CLAUDE_SKILL_DIR}/scripts/publish.py --post`,\nor `python3 -I scripts/publish.py --dry-run`.";
        let s = suggest(text, true);
        assert_eq!(s.len(), 1, "{s:?}");
        assert_eq!(s[0].pattern, "python3 -I *scripts/publish.py *");
        assert_eq!(s[0].lines, [1, 2]);
        assert!(matches(
            &s[0].pattern,
            "python3 -I /home/me/.claude/skills/pub/scripts/publish.py --post"
        ));
        assert_eq!(catches(&s[0].pattern, text), [1, 2]);
    }

    #[test]
    fn the_words_before_a_command_that_set_its_env_are_not_the_command() {
        assert_eq!(
            strip_env("A=1 B=\"x y\" C=$(snyvi key C) run.sh --x"),
            "run.sh --x"
        );
        assert_eq!(strip_env("python3 x.py"), "python3 x.py");
        assert_eq!(strip_env("A=$(unclosed run"), "A=$(unclosed run");
    }
}
