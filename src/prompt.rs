//! snyvi's own prompt.
//!
//! A pane runs the reader's own shell, so until now the prompt was whatever
//! their dotfiles drew: a Powerlevel10k rainbow on one machine, a bare `$` on
//! the next, and a blue nobody chose on both. A desk should look like snyvi
//! wherever it runs, so snyvi brings its own prompt: the folder in the
//! window's accent, the branch beside it in a muted tone, and a chevron that
//! turns red when the last command failed.
//!
//! It is a dressing, not a replacement. The reader's own rc files are sourced
//! first -- `PATH`, aliases, completions, everything a pane would be useless
//! without -- and only then is the prompt set, last, so it wins over whatever
//! they set. A shell snyvi has no dressing for starts exactly as it did.
//!
//! **Nothing here runs a process.** The branch is read out of `.git/HEAD`, the
//! way `crate::project::branch` reads it, by walking up from the folder in the
//! shell's own builtins: a prompt that forks is a prompt that stutters in a
//! large repository, and no shell has a portable way to draw one late. What
//! costs -- whether the tree is modified -- snyvi works out for itself, off
//! the prompt's path, and shows in the pane's header (`crate::pane`). That is
//! also how a pane running a shell snyvi cannot dress, or `cmd.exe`, still
//! says which branch it is on.
//!
//! The rc files are written fresh on every start, into the data dir, and hold
//! the accent the window was wearing then. A running shell cannot be told a
//! new one, so it is not asked to be: the page knows which colour each pane
//! was dressed in and paints that colour as the accent, which re-tints a
//! prompt already on the screen the moment the swatch changes -- scrollback
//! and all. See `born` in `ui/desk.js`.

use anyhow::{Context, Result};
use std::path::Path;

/// The chevron: U+F054 from the symbols font snyvi serves, not `❯`, which
/// neither bundled font has and which would be a box on a machine whose system
/// fonts have no dingbats either.
const MARK: char = '\u{f054}';

/// The accent to fall back on when the window did not say which it wears:
/// snyvi's own, the dark-theme red, since a pane is dark either way.
const FALLBACK: &str = "#f04a63";

/// What starting a dressed shell needs: arguments after the shell's own, and
/// the environment that points it at the rc snyvi wrote.
pub struct Dress {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Dress the shell, if snyvi knows how to dress that one.
///
/// `accent` is `#rrggbb` as the window's CSS resolved it; anything else is not
/// trusted into a file the shell will run, and the fallback is used instead.
/// `None` means snyvi has no dressing for this shell, or that the rc could not
/// be written -- a read-only data dir, say -- and then the shell starts
/// undressed rather than not at all.
pub fn dress(shell: &Path, accent: &str) -> Option<Dress> {
    // Split on both separators rather than asking Path: a Windows COMSPEC read
    // on any machine still names `cmd.exe`, and tests say so on Linux.
    let whole = shell.to_str()?;
    let name = whole
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(whole)
        .to_ascii_lowercase();
    let acc = hex(accent).unwrap_or_else(|| FALLBACK.to_string());
    let dir = crate::config::paths().data_dir.join("shell");
    // Windows names a program with its extension; everywhere else it does not.
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "zsh" => zsh(&dir, &acc).ok(),
        "bash" => bash(&dir, &acc).ok(),
        "fish" => fish(&dir, &acc).ok(),
        "pwsh" | "powershell" => powershell(&dir, &acc).ok(),
        "cmd" => Some(cmd(&acc)),
        _ => None,
    }
}

/// The colour the prompt is really drawn in: what the window asked for when
/// that is a colour, snyvi's own when it is not. The page is told, so that it
/// knows which colour on a pane's screen is the accent's and can paint it as
/// the accent -- which is how a new swatch re-tints a prompt already drawn.
pub fn effective(accent: &str) -> String {
    hex(accent).unwrap_or_else(|| FALLBACK.to_string())
}

/// `#rrggbb`, and only that: the accent is pasted into a file a shell runs, so
/// a stray quote or `$(` in it would be a command, not a colour.
fn hex(s: &str) -> Option<String> {
    let s = s.trim();
    let body = s.strip_prefix('#')?;
    if body.len() == 6 && body.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(format!("#{}", body.to_ascii_lowercase()))
    } else {
        None
    }
}

/// A path as a shell will read it back: inside single quotes, which end only
/// where this says they end.
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The three parts of the accent, for the shells that want an escape sequence
/// rather than a colour name.
fn rgb(acc: &str) -> (u8, u8, u8) {
    let b = acc.as_bytes();
    let p = |i: usize| u8::from_str_radix(std::str::from_utf8(&b[i..i + 2]).unwrap_or("0"), 16);
    (
        p(1).unwrap_or(0xd9),
        p(3).unwrap_or(0x53),
        p(5).unwrap_or(0x1e),
    )
}

/// Written beside and renamed over, never truncated in place: two panes can
/// start at once, and a shell must not source half a file.
fn write(path: &Path, body: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, body).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

// ---------- zsh ----------

/// zsh reads its rc files from `ZDOTDIR`, so snyvi points that at a directory
/// of its own whose files source the reader's. The last thing the `.zshrc`
/// does is put `ZDOTDIR` back, so a zsh started inside the pane is the reader's
/// again, undressed.
fn zsh(dir: &Path, acc: &str) -> Result<Dress> {
    let home = dir.join("zsh");
    let ours = sq(&home.display().to_string());
    // .zshenv is read by every zsh, .zprofile and .zlogin only by login ones;
    // each stands in for the reader's file of the same name. .zshenv does one
    // thing more: a reader who keeps zsh out of $HOME sets ZDOTDIR in it, and
    // zsh reads the parameter again before each of the files that follow, so
    // it has to be noted and taken back or the rest of these are never read.
    write(
        &home.join(".zshenv"),
        &format!(
            r#"{HEAD}: ${{SNYVI_ZDOTDIR:=$HOME}}
[[ -f $SNYVI_ZDOTDIR/.zshenv ]] && source $SNYVI_ZDOTDIR/.zshenv
[[ $ZDOTDIR != {ours} ]] && SNYVI_ZDOTDIR=$ZDOTDIR
ZDOTDIR={ours}
export SNYVI_ZDOTDIR
"#
        ),
    )?;
    for f in [".zprofile", ".zlogin"] {
        write(
            &home.join(f),
            &format!(
                "{HEAD}[[ -f ${{SNYVI_ZDOTDIR:-$HOME}}/{f} ]] && source ${{SNYVI_ZDOTDIR:-$HOME}}/{f}\n"
            ),
        )?;
    }
    write(&home.join(".zshrc"), &zshrc(acc))?;
    let mut env = vec![
        ("ZDOTDIR".into(), home.display().to_string()),
        // Powerlevel10k's instant prompt paints before the reader's .zshrc has
        // finished, which would be a rainbow flashing over snyvi's prompt on
        // every pane that starts -- and it warns, loudly, about the output
        // anything else writes while it is up.
        ("POWERLEVEL9K_INSTANT_PROMPT".into(), "off".into()),
    ];
    // Only when the daemon itself was started with one: otherwise the files
    // fall back to $HOME on their own, and a literal "$HOME" put here would be
    // a folder name, not the folder.
    if let Some(z) = std::env::var("ZDOTDIR").ok().filter(|z| !z.is_empty()) {
        env.push(("SNYVI_ZDOTDIR".into(), z));
    }
    Ok(Dress {
        args: vec!["-l".into()],
        env,
    })
}

fn zshrc(acc: &str) -> String {
    let (r, g, b) = rgb(acc);
    format!(
        r#"{HEAD}[[ -f ${{SNYVI_ZDOTDIR:-$HOME}}/.zshrc ]] && source ${{SNYVI_ZDOTDIR:-$HOME}}/.zshrc
# From here on the shell is the reader's own again: a zsh started inside the
# pane reads their files, not these.
ZDOTDIR=${{SNYVI_ZDOTDIR:-$HOME}}

# snyvi draws the prompt in a pane, so a prompt the reader installed comes back
# off. Powerlevel10k has a teardown of its own -- it has widgets and a worker
# to stop, not just a hook -- and the rest are hooks, which come out of the
# arrays they were put in.
(( ${{+functions[prompt_powerlevel9k_teardown]}} )) && prompt_powerlevel9k_teardown
precmd_functions=(${{precmd_functions:#(_p9k_*|*starship*|_omp_*|*spaceship*|*powerline*)}})
preexec_functions=(${{preexec_functions:#(_p9k_*|*starship*|_omp_*|*spaceship*|*powerline*)}})

# The branch, out of .git/HEAD and nothing else: builtins only, no process.
_snyvi_branch() {{
  REPLY=""
  local d=$PWD g head
  while [[ -n $d && $d != / ]]; do
    [[ -e $d/.git ]] && break
    d=${{d:h}}
  done
  [[ -e $d/.git ]] || return
  g=$d/.git
  # A worktree or a submodule keeps .git as a file naming the real one.
  if [[ -f $g ]]; then
    local line
    read -r line < $g || return
    g=${{line#gitdir: }}
    [[ $g == /* ]] || g=$d/$g
  fi
  read -r head < $g/HEAD 2>/dev/null || return
  if [[ $head == ref:\ refs/heads/* ]]; then
    REPLY=${{head#ref: refs/heads/}}
  else
    REPLY=${{head[1,8]}}
  fi
}}

_snyvi_prompt() {{
  # Whatever was installed after this hook -- a framework that adds its own on
  # the first prompt -- would otherwise set PROMPT last and win. Staying at the
  # end of the array is how this one stays the prompt the reader sees.
  [[ ${{precmd_functions[-1]}} == _snyvi_prompt ]] ||
    precmd_functions=(${{precmd_functions:#_snyvi_prompt}} _snyvi_prompt)
  local REPLY branch=""
  _snyvi_branch
  # A branch name is data. `%` is prompt syntax, and with PROMPT_SUBST set --
  # oh-my-zsh sets it -- `$` and a backtick in one would be run, so a hostile
  # repository could name a branch after a command. They do not reach PROMPT.
  if [[ -n $REPLY ]]; then
    branch=${{REPLY//\%/%%}}
    branch=" $_snyvi_dim${{branch//[\$\`]/}}$_snyvi_off"
  fi
  PROMPT="$_snyvi_acc%~$_snyvi_off$branch %(?.$_snyvi_acc.$_snyvi_red){MARK}$_snyvi_off "
  RPROMPT=""
}}
# Escapes rather than %F{{#rrggbb}}, which wants zsh 5.7; %{{ %}} so that the
# line editor counts the width in what the reader can see.
_snyvi_acc=$'%{{\e[38;2;{r};{g};{b}m%}}'
_snyvi_dim=$'%{{\e[38;5;244m%}}'
_snyvi_red=$'%{{\e[31m%}}'
_snyvi_off=$'%{{\e[39m%}}'
autoload -Uz add-zsh-hook
add-zsh-hook precmd _snyvi_prompt
"#
    )
}

// ---------- bash ----------

/// bash ignores `--rcfile` in a login shell, so snyvi starts an interactive
/// one instead and has the rc do what a login shell would have done: the
/// profile first, exactly the one bash would have picked, then the prompt.
fn bash(dir: &Path, acc: &str) -> Result<Dress> {
    let rc = dir.join("bashrc");
    write(&rc, &bashrc(acc))?;
    Ok(Dress {
        args: vec!["--rcfile".into(), rc.display().to_string(), "-i".into()],
        env: vec![],
    })
}

fn bashrc(acc: &str) -> String {
    let (r, g, b) = rgb(acc);
    format!(
        r#"{HEAD}[ -f /etc/profile ] && . /etc/profile
# What a login bash reads, in the order it reads it: the first of these three
# and no more. Most of them source ~/.bashrc themselves, so sourcing it here
# too would double every PATH the reader appends.
_snyvi_profile=""
for _snyvi_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$_snyvi_f" ]; then . "$_snyvi_f"; _snyvi_profile=1; break; fi
done
[ -z "$_snyvi_profile" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
unset _snyvi_f _snyvi_profile

# A folder or a branch named `$(...)` would be run when the prompt expands,
# because bash expands PS1 by default. Nothing in this prompt needs that.
shopt -u promptvars

# The branch, out of .git/HEAD and nothing else: builtins only, no process.
_snyvi_branch() {{
  _snyvi_head=""
  local d="$PWD" g head line
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    [ -e "$d/.git" ] && break
    d="${{d%/*}}"
  done
  [ -e "$d/.git" ] || return
  g="$d/.git"
  # A worktree or a submodule keeps .git as a file naming the real one.
  if [ -f "$g" ]; then
    read -r line < "$g" || return
    g="${{line#gitdir: }}"
    case "$g" in /*) ;; *) g="$d/$g" ;; esac
  fi
  read -r head < "$g/HEAD" 2>/dev/null || return
  case "$head" in
    "ref: refs/heads/"*) _snyvi_head="${{head#ref: refs/heads/}}" ;;
    *) _snyvi_head="${{head:0:8}}" ;;
  esac
}}

# snyvi's prompt. The escapes sit inside \[ \] so that readline counts the
# line's width in characters the reader can see, and wraps where it should.
_snyvi_prompt() {{
  local ok=$?
  local acc='\[\e[38;2;{r};{g};{b}m\]' dim='\[\e[38;5;244m\]' red='\[\e[31m\]' off='\[\e[0m\]'
  local branch=""
  _snyvi_branch
  [ -n "$_snyvi_head" ] && branch=" $dim$_snyvi_head$off"
  # Whatever the reader hung on PROMPT_COMMAND -- a history write, a window
  # title -- still runs; only the prompt itself is snyvi's.
  [ -n "$_snyvi_inner" ] && eval "$_snyvi_inner"
  PS1="$acc\w$off$branch "
  if [ "$ok" -eq 0 ]; then PS1="$PS1$acc{MARK}$off "; else PS1="$PS1$red{MARK}$off "; fi
}}
_snyvi_inner=$PROMPT_COMMAND
PROMPT_COMMAND=_snyvi_prompt
"#
    )
}

// ---------- fish ----------

/// fish has a flag for this: `-C` runs a command once the reader's own config
/// has been read, which is exactly when the prompt should be replaced.
fn fish(dir: &Path, acc: &str) -> Result<Dress> {
    let rc = dir.join("prompt.fish");
    write(&rc, &fishrc(acc))?;
    Ok(Dress {
        args: vec![
            "-l".into(),
            "-C".into(),
            format!("source {}", sq(&rc.display().to_string())),
        ],
        env: vec![],
    })
}

fn fishrc(acc: &str) -> String {
    let bare = acc.trim_start_matches('#');
    format!(
        r#"{HEAD}# The branch, out of .git/HEAD and nothing else: builtins only, no process.
function _snyvi_branch
  set -l d $PWD
  while test -n "$d" -a "$d" != "/"
    test -e "$d/.git"; and break
    set d (string replace -r '/[^/]*$' '' -- $d)
    test -z "$d"; and set d /
  end
  test -e "$d/.git"; or return
  set -l g "$d/.git"
  # A worktree or a submodule keeps .git as a file naming the real one.
  if test -f "$g"
    read -l line < "$g"; or return
    set g (string replace 'gitdir: ' '' -- $line)
    string match -q '/*' -- $g; or set g "$d/$g"
  end
  read -l head < "$g/HEAD"; or return
  if string match -q 'ref: refs/heads/*' -- $head
    echo (string replace 'ref: refs/heads/' '' -- $head)
  else
    echo (string sub -l 8 -- $head)
  end
end

function fish_prompt
  set -l ok $status
  set -l branch (_snyvi_branch)
  set_color {bare}
  echo -n (string replace -- $HOME '~' $PWD)
  set_color normal
  if test -n "$branch"
    set_color 949494
    echo -n " $branch"
    set_color normal
  end
  if test $ok -eq 0
    set_color {bare}
  else
    set_color red
  end
  echo -n " {MARK} "
  set_color normal
end
function fish_right_prompt
end
"#
    )
}

// ---------- PowerShell ----------

/// PowerShell has no rc to point at, but `-NoExit -Command` runs one thing
/// after the reader's own profiles have loaded, which is when the prompt
/// should be replaced. `-NoLogo` so the pane does not open on a banner.
fn powershell(dir: &Path, acc: &str) -> Result<Dress> {
    let rc = dir.join("prompt.ps1");
    write(&rc, &ps1(acc))?;
    // Single quotes are PowerShell's literal string, and a doubled quote is
    // how one inside is written.
    let quoted = format!("'{}'", rc.display().to_string().replace('\'', "''"));
    Ok(Dress {
        args: vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            format!(". {quoted}"),
        ],
        env: vec![],
    })
}

fn ps1(acc: &str) -> String {
    let (r, g, b) = rgb(acc);
    format!(
        r#"{HEAD}# The branch, out of .git/HEAD and nothing else: no process.
function global:_SnyviBranch {{
  $d = (Get-Location).Path
  while ($d -and -not (Test-Path (Join-Path $d '.git'))) {{
    $p = Split-Path $d -Parent
    if ($p -eq $d -or -not $p) {{ return '' }}
    $d = $p
  }}
  if (-not $d) {{ return '' }}
  $g = Join-Path $d '.git'
  # A worktree or a submodule keeps .git as a file naming the real one.
  if (Test-Path $g -PathType Leaf) {{
    $line = (Get-Content -LiteralPath $g -TotalCount 1 -ErrorAction SilentlyContinue)
    if (-not $line) {{ return '' }}
    $g = $line -replace '^gitdir: ', ''
    if (-not [System.IO.Path]::IsPathRooted($g)) {{ $g = Join-Path $d $g }}
  }}
  $head = (Get-Content -LiteralPath (Join-Path $g 'HEAD') -TotalCount 1 -ErrorAction SilentlyContinue)
  if (-not $head) {{ return '' }}
  if ($head.StartsWith('ref: refs/heads/')) {{ return $head.Substring(16) }}
  return $head.Substring(0, [Math]::Min(8, $head.Length))
}}

function global:prompt {{
  $ok = $?
  $e = [char]27
  $acc = "$e[38;2;{r};{g};{b}m"
  $dim = "$e[38;5;244m"
  $off = "$e[39m"
  $mark = if ($ok) {{ $acc }} else {{ "$e[31m" }}
  $here = (Get-Location).Path.Replace($HOME, '~')
  $branch = global:_SnyviBranch
  $git = if ($branch) {{ " $dim$branch$off" }} else {{ '' }}
  "$acc$here$off$git $mark{MARK}$off "
}}
"#
    )
}

// ---------- cmd.exe ----------

/// `cmd.exe` has no rc and no scripting in its prompt, but it does read
/// `PROMPT` from the environment, and `$E` in it is an escape -- which is all
/// the accent needs. No branch: the header carries that for this one.
fn cmd(acc: &str) -> Dress {
    let (r, g, b) = rgb(acc);
    Dress {
        args: vec![],
        env: vec![(
            "PROMPT".into(),
            format!("$E[38;2;{r};{g};{b}m$P$E[39m {MARK} "),
        )],
    }
}

/// The first line of every file snyvi writes here, so a reader who finds one
/// knows what wrote it and that their own edits will not last.
const HEAD: &str =
    "# Written by snyvi when a pane starts. Edits here are lost on the next start.\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_colour_reaches_the_file() {
        assert_eq!(hex("#2DD4BF").as_deref(), Some("#2dd4bf"));
        assert_eq!(hex(" #2dd4bf ").as_deref(), Some("#2dd4bf"));
        assert_eq!(hex("#2dd4bf; rm -rf ~"), None);
        assert_eq!(hex("$(id)"), None);
        assert_eq!(hex("red"), None);
        assert_eq!(hex(""), None);
    }

    #[test]
    fn the_accent_is_what_the_prompt_is_drawn_in() {
        assert!(zshrc("#2dd4bf").contains("38;2;45;212;191"));
        assert!(bashrc("#2dd4bf").contains("38;2;45;212;191"));
        assert!(fishrc("#2dd4bf").contains("set_color 2dd4bf"));
        assert!(ps1("#2dd4bf").contains("38;2;45;212;191"));
        assert!(cmd("#2dd4bf").env[0].1.contains("38;2;45;212;191"));
    }

    #[test]
    fn a_branch_named_after_a_command_is_not_one() {
        // A hostile repository can name a branch `$(whoami)100%`; it reaches
        // the prompt as text or not at all.
        let z = zshrc("#2dd4bf");
        assert!(z.contains(r"branch=${REPLY//\%/%%}"));
        assert!(z.contains(r"${branch//[\$\`]/}"));
        assert!(bashrc("#2dd4bf").contains("shopt -u promptvars"));
    }

    #[test]
    fn no_prompt_runs_a_process() {
        // The whole point of reading .git/HEAD: a prompt that forks is a
        // prompt that stutters in a large repository.
        for rc in [
            zshrc("#2dd4bf"),
            bashrc("#2dd4bf"),
            fishrc("#2dd4bf"),
            ps1("#2dd4bf"),
        ] {
            assert!(!rc.contains("git status"), "a prompt runs git status");
            assert!(!rc.contains("rev-parse"), "a prompt runs git rev-parse");
            assert!(rc.contains("HEAD"), "a prompt reads no HEAD");
        }
    }

    #[test]
    fn a_shell_snyvi_cannot_dress_is_left_alone() {
        assert!(dress(Path::new("/bin/ksh"), "#2dd4bf").is_none());
        assert!(dress(Path::new("/bin/sh"), "#2dd4bf").is_none());
    }

    #[test]
    fn windows_names_a_shell_with_its_extension() {
        // The same dressing, whether the reader's COMSPEC says `cmd.exe` or a
        // path to `pwsh.exe`, and whatever it capitalised.
        assert!(dress(Path::new(r"C:\WINDOWS\system32\CMD.EXE"), "#2dd4bf").is_some());
        assert!(dress(Path::new("/usr/bin/pwsh"), "#2dd4bf").is_some());
    }

    #[test]
    fn the_readers_own_files_are_sourced_before_the_prompt_is_set() {
        let z = zshrc("#2dd4bf");
        let sourced = z.find("source ${SNYVI_ZDOTDIR:-$HOME}/.zshrc").unwrap();
        assert!(sourced < z.find("add-zsh-hook precmd").unwrap());
        let b = bashrc("#2dd4bf");
        assert!(b.find(".bash_profile").unwrap() < b.find("PROMPT_COMMAND").unwrap());
    }
}

#[cfg(test)]
mod dump {
    /// Not a test of snyvi: a way to put the files somewhere a real zsh and a
    /// real bash can be asked whether they parse. Run with
    /// `SNYVI_DATA_DIR=<dir> cargo test -- --ignored dump`.
    #[test]
    #[ignore]
    fn write_the_rc_files() {
        super::dress(std::path::Path::new("/bin/zsh"), "#2dd4bf").unwrap();
        super::dress(std::path::Path::new("/bin/bash"), "#2dd4bf").unwrap();
        super::dress(std::path::Path::new("/bin/fish"), "#2dd4bf").unwrap();
        super::dress(std::path::Path::new("/usr/bin/pwsh"), "#2dd4bf").unwrap();
    }
}
