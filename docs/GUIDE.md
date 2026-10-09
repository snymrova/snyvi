# snyvi, in full

Everything the [README](../README.md) shows, at the length it takes to say
how it works: the install on each desktop, updating and uninstalling,
every command, connecting each agent, the window, the desks, the keys, and
what each part of the page does and why. The numbers at the end are the
ones `snyvi bench` reads.

snyvi is for the person with more passion projects than hours in the day,
building several of them at once with coding agents. It keeps each project
in order: a [desk](DESK.md) per project — its folder, and up to four real
panels rooted at it, each running an agent or a shell — and everything those
agents write, kept where you can read it.

You ask Claude Code for a plan. It writes one. With snyvi, Claude sends
the document and replies with a link; by the time you read the reply, the
document is already open in the viewer, rendered, filed under the project,
and listed on the desk beside the panel that wrote it. Markdown and every
kind of source file. Each desk keeps its own notes, and each is exactly as
you left it when you come back.

One direction only: agents send, snyvi shows. The rule is about the channel,
not the window: no document in snyvi can be read back by an agent, and
nothing a document says is ever typed into a panel. The one thing that goes
the other way is a desk's own notes, to the agent working in that desk's
panel, and only to read ([Asides](#asides) says where the line is).

## Install

### One line

On Linux and macOS, [`install.sh`](../install.sh) does what the sections
below say to do by hand, choosing the path for the machine it is on:

```
curl -fsSL https://raw.githubusercontent.com/snymrova/snyvi/main/install.sh | sh
```

With Homebrew it installs the cask; on a Mac without it, `snyvi.app` goes
into Applications and `snyvi` onto your `PATH`. On every Linux it installs
into your home, with no root: `snyvi` into `~/.local/bin`, the window
beside it when the machine has a display and WebKitGTK 4.1, and what a
package would put under `/usr/share` — a menu entry, the icon, `snyvi://`
links, and a systemd user unit, written but not enabled. A machine that
already has snyvi as a `.deb` keeps it as one, upgraded in a single apt
run, and the script says how to move. Every download is checked against
the `.sha256` published beside it, and Claude Code is connected if it is
installed. Each download also carries a build attestation:
`gh attestation verify <file> --repo snymrova/snyvi` proves it came out of
the release workflow in this repository, on the commit the tag names.

From then on snyvi [updates itself](#updating). Running the script again
does the same by hand: a daemon that was running is restarted on the new
version once its desks are quiet, Claude Code's registration is pointed at
the new binary without anything added, and nothing you sent is touched.
The last lines say what is true — which `snyvi` a new terminal will run,
and whether it updates itself.

```
sh install.sh --deb              the two .debs instead (Debian, Ubuntu; needs root)
sh install.sh --tar              the per-user install, even over a .deb
sh install.sh --no-app           without the window
sh install.sh --no-init          without registering with Claude Code
sh install.sh --version 1.3.0    a particular release
sh install.sh --bin-dir DIR      where the per-user install goes
```

The same flags after `sh -s --` when piping from `curl`. Windows has no
shell to pipe into; it has [Scoop](#windows) and the installer.

### Cargo

With a Rust toolchain on any platform:

```
cargo install snyvi
snyvi init-claude --auto
```

That builds snyvi from [crates.io](https://crates.io/crates/snyvi): the
daemon, the CLI, the MCP server and the hook, which is everything but the
window. The window links a browser engine — WebKitGTK on Linux, WebView2
on Windows, WebKit on macOS — so it is not in the crate; on Debian it is
the `snyvi-app` package below, and elsewhere it is built from source as
[Desktop](#desktop) describes. `cargo install snyvi` again updates it.

### Debian and Ubuntu, as a package instead

The one-liner's per-user install works on Debian and Ubuntu as on any
Linux, and updates itself. As packages instead — owned by root, upgraded
by apt, and so only told of a new version, never updated in place — run
`sh install.sh --deb`, or download `snyvi_<version>_amd64.deb` (or
`_arm64.deb`) from the [releases page](https://github.com/snymrova/snyvi/releases):

```
sudo dpkg -i snyvi_*.deb
snyvi send README.md                              # starts the daemon, prints a link
snyvi init-claude                                 # register with Claude Code
snyvi status                                      # what is running, what is registered
```

The package depends on nothing at all — the binary is static — so it
installs on any Debian or Ubuntu of that architecture without pulling in
a library. Besides the command it gives you an application menu entry and
a systemd user service, neither of them started by default.

That is the whole install. If you later want the viewer in a native
window rather than a browser one, add a second small package — it is an
addition, not a different snyvi:

```
sudo apt install ./snyvi-app_*.deb   # apt, so webkit resolves
snyvi app                            # now a window of its own
```

`snyvi-app` is one executable, about 4 MB, and it is the only piece that
links a browser engine. Everything else — the daemon, `send`, the MCP
server, the hook — stays the static binary above. Nothing changes about
snyvi until you install it, and removing it just puts you back in a
browser. See [Desktop](#desktop) for what the window costs.

### Windows

With [Scoop](https://scoop.sh):

```
scoop bucket add snyvi https://github.com/snymrova/scoop-snyvi
scoop install snyvi
snyvi init-claude --auto
```

That is the zip below, unpacked into Scoop's own folder and shimmed onto
your `PATH`, with both executables in it, so `snyvi app` opens the window
as it does from the installer. `scoop update snyvi` updates it, stopping
the daemon and the window first; `scoop uninstall snyvi` removes it and
leaves your documents. The bucket is written by the same release run that
publishes the zip, so it cannot say a version that has not shipped.

Without Scoop, download `snyvi-<version>-x86_64-pc-windows-msvc-setup.exe`
from the same page and double-click it. That is the install:

- snyvi goes into `%LOCALAPPDATA%\Programs\snyvi`, for you alone, so there
  is no administrator prompt;
- *snyvi* appears in the Start menu (and on the desktop, if you tick it);
- the folder is added to your `PATH`, so `snyvi` runs in any terminal you
  open afterwards;
- `snyvi init-claude --auto` is run for you, if the box is left ticked and
  Claude Code is installed: snyvi is registered with Claude Code, and every
  Markdown file Claude writes is sent to the viewer;
- *Open snyvi* at the end starts the daemon and the window.

Nothing more to type. From a terminal, the same commands as everywhere:

```
snyvi send README.md                              # prints a link
snyvi init codex                                  # any other agent
snyvi status                                      # what is running, what is registered
```

Upgrading is running the newer installer: it stops the daemon and the window
first, replaces both, and keeps everything else. Uninstalling is *snyvi* in
Settings → Apps: it stops snyvi, takes it back out of Claude Code and off
`PATH`, and leaves your documents in `%LOCALAPPDATA%\snyvi`. `snyvi reset`,
before uninstalling, removes those too.

The installer and the executables are not signed, so the first time the
installer runs Windows shows a SmartScreen sheet saying it protected your
PC. *More info*, then *Run anyway*, once.

Both executables are in the one download. `snyvi.exe` is everything —
daemon, CLI, MCP server, hook — and `snyvi-app.exe` is the native window.
There is no separate package for the window the way there is on Linux,
because it uses WebView2, which is part of Windows 10 and 11 rather than
a library to go and install.

**Without the installer.** The release also has
`snyvi-<version>-x86_64-pc-windows-msvc.zip`, for a folder you manage
yourself. Unzip it somewhere of its own, keep the two executables together
(`snyvi app` looks for the window beside itself), and from a terminal in
that folder:

```
.\snyvi install-cli                               # puts this folder on your PATH
snyvi init-claude                                 # in a new terminal
```

### macOS

Download `snyvi-<version>-aarch64-apple-darwin.tar.gz` on Apple silicon
or `-x86_64-apple-darwin` on Intel from the same page, unpack it, and
drag `snyvi.app` into Applications. Both executables are inside the
bundle: the window, which is what a double-click on the icon opens, and
`snyvi` itself. The command line is a link to that one, which the
bundle writes for you:

```
/Applications/snyvi.app/Contents/MacOS/snyvi install-cli
snyvi send README.md                              # starts the daemon, prints a link
snyvi init-claude                                 # register with Claude Code
snyvi app                                         # the window, from the terminal
```

`install-cli` links into `/usr/local/bin` when that can be written and
into `~/.local/bin` otherwise, and says so when the one it used is not
on your `PATH` yet. (A fresh Mac has no writable `/usr/local/bin`, and
an Apple silicon one has none at all until Homebrew makes it; that is
why this is a command and not an `ln -s` to type.)

Opening the app with nothing running does what `snyvi app` does: starts
the daemon, then the window. The window uses the WebKit that is part of
macOS, so as on Windows there is nothing to install for it.

The bundle is signed with Mrova's Developer ID and notarized by Apple
(from 1.23.0), so the first open asks only whether to open something
downloaded from the internet. A release before 1.23.0 was signed ad hoc,
and Gatekeeper calls it an unidentified developer's: take the quarantine
off it,

```
xattr -dr com.apple.quarantine /Applications/snyvi.app
```

or open it once from System Settings → Privacy & Security → Open Anyway.

With Homebrew, `brew install --cask snymrova/snyvi/snyvi` does all of the
above in one command: it puts `snyvi.app` in Applications, links `snyvi`
onto your `PATH`, and takes the quarantine off the app it installed.
`brew upgrade` stops the daemon before it swaps the binary; `brew zap`,
and only `brew zap`, deletes the library.

### By hand, on any Linux

What the one-liner does, from the tarball for your architecture on the
same page:

```
tar xzf snyvi-linux-x64.tar.gz
install -m 755 snyvi-*/snyvi ~/.local/bin/snyvi   # anywhere you own
snyvi install-desktop    # menu entry, icon, snyvi:// links, a user unit
snyvi send README.md
snyvi init-claude
```

`install-desktop` writes into your home only, names the binary by its
path, and is safe to run again after moving it; `uninstall-desktop` takes
out exactly what it wrote. A binary in a folder you own updates itself;
one under `/usr` is left for its package manager.

If `~/.local/bin` is not on your `PATH`, `snyvi init-claude` writes the
binary's full path into Claude Code's settings and says so; run it again
after moving the binary, and the registration follows.

### Updating

snyvi updates itself. The daemon reads one small file off the newest
GitHub release a few times a day — `latest.json`, signed, fetched with a
`snyvi/<version>` user agent and nothing else sent — and when it names a
newer version, downloads that version's files for your kind of install,
checks every sha256, and keeps them staged. Once a day, at a quiet moment,
it swaps them in and restarts onto them. Quiet means no panel with an
agent mid-turn and none with a program still printing; a moment means the
window is closed, or has been in the background for ten minutes, or the
machine is unattended. Nothing is shown to you for any of that.

Which installs are swapped, and which are only told:

| Install | What happens |
|---|---|
| the per-user install, or the tarball in any folder you own | swapped |
| the tarball in a folder you cannot write (`/usr/local/bin` with `sudo`) | told: About shows the two lines to run |
| macOS, `snyvi.app` in Applications, the cask too | swapped (the cask says `auto_updates`, so `brew upgrade` leaves it alone unless `--greedy`) |
| Windows, the installer's folder or Scoop's | swapped (`scoop update` later reinstalls over it harmlessly) |
| the `.deb` | told: root owns `/usr/bin/snyvi`, so About and `snyvi status` show the lines to run — with `snyvi-app` installed, both packages in one `apt install`, since the window's package wants the daemon's exact version |
| `cargo install` | told: `cargo install snyvi` |
| a build under `target/` | never checked |

Once the day's slot has opened with a version staged — at once, when
`Check for updates` (⌘K, the mark's menu, Home, About) or `snyvi update`
found it — a small dot appears on the mascot, and a card at the foot of the
sidebar says `snyvi 1.6.3 is ready`, with *Update when quiet*, *Now* and
*Later*. Nothing on the page moves for either. *Update when quiet* applies
it as soon as the panels are quiet, and the card then names who it is
waiting on: `ledger · panel 1 · Claude working 4 m`. *Now* with a panel busy
says in the card whose work it would end before it does. *Later* puts this
version off until tomorrow morning, in every window; a newer one is offered
at once. Left alone, the dot turns amber after a day. A browser tab reads
the card and presses nothing. An install snyvi only tells shows the lines
to run, with a Copy button.

Busy, for a restart: an agent mid-turn, or one waiting on you for an
answer or a permission — an update never cuts off an approval. An agent
that says it is working but has printed nothing for ten minutes (Claude
stopped with Esc) is taken as quiet, and so is a panel that has only been
printing for two hours straight, a log tail or a dev server.

After the restart, every shell comes back with its old screen greyed
above, and every Claude panel comes back with its conversation
(`claude --resume`) the first time you look at its desk — not while
nobody is there to see it. A panel you have not opened within five
minutes of that first look shows the ↻ offer instead, for a day. While
snyvi restarts, a strip across the top of the page says so, and the page
reloads onto the new version when it is back; then `Updated to 1.6.3`
shows once, with *What's new*.

Sooner than the daily slot, when you want it:

```
snyvi update            check, stage, restart when the panels are quiet
snyvi update --now      the same, without the wait
snyvi update check      say whether a newer one is out; exit 10 when it is
snyvi update --to 1.7.0 one release by number, even an older one
snyvi update --back     the version the last update replaced (kept as .prev)
snyvi update off | on   the automatic path; `snyvi update` still works when off
```

About has the same, on a card at its top: `1.6.3 is ready · applies
tomorrow, when the desks are quiet`, or `You're on the latest · checked 40
min ago`, after a dot for where it stands, with `Check now`, `Restart to
update` when one is ready, and the *Automatic updates* switch.
A download that failed says so there, and the next check tries it again.
`snyvi update check` only says; `Check now` and `snyvi update` also let
what they find past the daily slot. A release marked as a hotfix (`hotfix_below` in the
manifest, set by hand in the release job) is applied at the next quiet
moment rather than the next day.

`SNYVI_UPDATES=off` in the daemon's environment turns the whole thing off,
for CI, packagers and the dev loop, and wins over the switch. What is
trusted: the manifest's minisign signature, against the key compiled in
(`packaging/minisign.pub`); the sha256 of every download, at staging and
again on the file just placed; a new daemon that does not answer within
thirty seconds is rolled back to `.prev` and health says `failed`. Under
systemd the unit does the restart (the daemon exits 75 and
`Restart=on-failure` starts the new file), and a new file that has
started twice without taking the port is put back by its own third
start. `.prev` stays for a day, and for `--back`; a version gone back
from, with `--back` or `--to` a lower one, is not taken again on its own.

A daemon snyvi started itself writes what it says to `daemon.log` beside
the documents (`snyvi status` prints the path), kept to about a
megabyte; under systemd it is in `journalctl --user -u snyvi`.

Installed by hand over the old one — the one-liner again, `brew upgrade`,
`sudo dpkg -i` — the daemon notices the file changed under it and any
snyvi command says so:

```
note: snyvi 0.2.0 is still running but this binary is 0.3.0.
Run `snyvi restart` to pick up the new version.
```

A restart waits for the desks to be quiet the same way, says which panels
it is waiting on, and `--now` skips the wait; Ctrl-C while it waits, or
`snyvi restart --cancel` from anywhere, calls it off. Your documents, database and token are kept across every
kind of update, and the schema migrates itself. `snyvi status` shows both
versions and one line about updates; `snyvi stop` shuts the daemon down.

### Uninstalling

```
snyvi uninstall-claude        # the MCP server, the hooks, the CLAUDE.md line
snyvi uninstall-desktop       # Linux: the menu entry, icons and unit it wrote
snyvi stop                    # the daemon
rm ~/.local/bin/snyvi ~/.local/bin/snyvi-app ~/.local/bin/*.prev   # or: sudo apt remove snyvi-app snyvi
```

That leaves your documents and index in `~/.local/share/snyvi` and the
token in `~/.config/snyvi` (the Windows and macOS places are under
[Where things live](#where-things-live)); delete those two directories
if you want nothing left. `uninstall-claude` takes out exactly what
`init-claude` put in and nothing else in Claude Code's settings.

To start over rather than leave, `snyvi reset` puts the install back to
the way it was: every document and version, the index, the token and
the page's preferences go, and the agents stay registered, so the next
document an agent sends lands in an empty library. `--agents` takes the
registration out as well. It is the one thing snyvi does that cannot be
undone, so it asks for the number of documents to be typed back rather
than a "yes" -- `--dry-run` prints the sentence and stops, `--yes` is
for scripts, and a pinned document refuses it until `--pinned` says so.
The same dialog is at the foot of the `?` box in the viewer.

It is fully static (musl), so it runs on any x86_64 or aarch64 Linux
without extra packages. To build from source instead:

```
cargo install --path .
```

One binary, no runtime. It embeds its own UI, fonts, and syntax
grammars, and the only thing it reads off the network is the small signed
file that says whether a newer version is out; `snyvi update off` stops
that.

To keep the daemon resident from login rather than letting the first
send start it, enable the user service. The one-liner and
`snyvi install-desktop` write one for the binary in your home, and the
`.deb` ships one; either way:

```
systemctl --user enable --now snyvi
```

## Use

```
snyvi send PLAN.md                 # send a file, print its link
cat notes.md | snyvi send -t Notes # send stdin
snyvi watch PLAN.md                # send now, and again on every save
snyvi browse [dir]                 # read a folder from disk, nothing imported
snyvi open                         # open the viewer, in the window if one is up
snyvi app                          # native window (see Desktop below)
snyvi init <agent> [--instructions]  # register with claude, codex, cursor, claude-desktop, gemini, windsurf, vscode or zed
snyvi init                         # every agent, and what each has of snyvi
snyvi uninstall <agent>            # take that registration back out
snyvi init-claude [--auto] [--claude-md]  # the same as `init claude`, with its hook
snyvi install-cli [dir]            # put `snyvi` on PATH
snyvi prune --days 30 [--dry-run]  # delete what you deleted, and unpinned documents older than N days
snyvi reset [--dry-run] [--agents]  # back to a fresh install; asks for the number of documents
snyvi status                       # daemon health and version
snyvi restart                      # after installing a new binary
snyvi stop                         # shut the daemon down
snyvi bench [--check]              # render speed on synthetic documents
```

The first `send` starts the daemon in the background; it stays resident
(about 25 MB) so every later send and every page open is instant. It
listens on `127.0.0.1:7777` only. Set `SNYVI_PORT` to change the port.

A new window opens on *Welcome* (`/welcome`, also in the `?` box and ⌘K
`>`): what snyvi is, and one question -- *What are you working on?* The
answer is a folder, chosen in the desktop's own dialog or from the
projects snyvi already knows; snyvi never looks through your folders on
its own. That folder becomes a desk, named after it, whose first panel
holds `claude` in its Start field for your Enter. If Claude Code is not
set up for snyvi yet, the panel offers to connect it first, and says what
that writes before it writes anything. The desk's rail then waits for the
first document, with the sentence to ask Claude for one, and once an
agent has worked there the sidebar asks for a second project.

*How snyvi works* (`/start`, from the `?` box, Agents, or ⌘K `>`) is six
short sections, in the order the story goes -- a desk for each project,
notes, documents arriving, what waits, versions, keys -- each with a
*Show me* that lights the real thing in the window.

### Connecting an agent

`snyvi mcp` is a plain stdio MCP server, so any agent that speaks MCP can
send documents here. `snyvi init <agent>` puts the entry in the agent's
own file -- `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
Claude Desktop's, Gemini CLI's, Windsurf's, VS Code's or Zed's -- after
reading what is there: it says "already registered" when there is
nothing to do, re-registers when the entry names a binary that has
moved, and leaves everything else in the file as it found it (Codex's
TOML keeps its comments; a JSON file with comments in it, which snyvi
cannot parse, is left alone and the snippet printed instead).
`--instructions` adds one line to the agent's instructions file, where
it has one, asking it to send what it writes; `snyvi uninstall <agent>`
takes the entry and the line back out.

Codex can work in a desk's panel the way Claude Code does. `snyvi init
codex` writes its entry with `env_vars = ["SNYVI_SESSION"]`, since Codex
starts a server with a short environment of its own and the panel's id
is how `snyvi mcp` knows which desk it is in; and it writes snyvi's
hooks to `~/.codex/hooks.json`, the same events as Claude Code's, so the
panel shows what Codex is doing and Codex is handed the desk brief and
the desk's changes at each prompt. Codex runs no hook it has not been
shown: open `/hooks` in Codex once and trust them. Plans and auto-send
stay Claude Code's; Codex has neither an ExitPlanMode nor a file path in
its edit hook.

The viewer says the same thing, on *Agents* (`/connect`): one row per agent, read by the daemon from the
agent's own file, saying whether it is set up, not set up, or
registered under a path that no longer exists, with the command or the
snippet that fixes it and, once a document has come from it, when. An
agent whose session is open this moment says *running now* instead -- the
MCP server holds a connection to the daemon from the agent's first
message until its process ends, so the row is as live as the session
-- and the count beside the mark in the sidebar says how many are, on
every page. Claude Code is always listed first, with a *Connect Claude
Code* button in the window; the other agents wait under *Using a different
agent?* until one is set up. It is reachable at any time from the foot of
the `?` box and from that count, and `snyvi init` with no agent prints
the same rows.

### Claude Code

`snyvi init-claude` (or `snyvi init claude`) runs `claude mcp add --scope user snyvi -- snyvi mcp`.
That exposes two MCP tools, and more inside a desk. `send_document` is
the one that matters: it takes a file path or inline content and returns a
URL, and its description tells Claude what snyvi can show and when to pick
each -- Markdown with Mermaid for a plan, one self-contained HTML file for a
mockup or a chart, an image or a recording, a PDF. `send_aside` is the small
one, and [Asides](#asides) below says what it is for. Offered only to a
Claude running in a desk's panel: `read_desk_notes` reads that desk's
notes, `tick_desk_note` ticks one done (with the commit, the document and a
link to where the work can be seen), `suggest_desk_note` offers a line you
can keep or not, `leave_off` says in a sentence where the work stands,
`name_panel` names the panel it runs in, and six more file the work itself
([Threads and Your turn](#threads-and-your-turn) below): `start_thread` and
`move_thread`, `ask` and `hand_over`, `suggest_panel` and `suggest_desk`.
The tool descriptions tell Claude
when to use each; a line in your global `CLAUDE.md` helps it remember:

> When you produce a document for me to read (plan, review, summary),
> send it to snyvi with send_document and give me the link.

`snyvi init-claude --claude-md` writes that line for you, once. The
command is safe to run as often as you like: it reads what Claude Code
already has before touching anything, says "already registered" when
there is nothing to do, and when the binary has moved -- an update, a
tarball tidied into `~/.local/bin` -- it re-registers and points the
hooks at the new place rather than leaving them failing quietly on
every tool call. `snyvi status` ends with a line saying what is
registered and whether it still points at a binary that exists, and
`snyvi uninstall-claude` takes all of it back out.

Inside a desk, three more things happen on their own. A Claude starting in
a panel -- a new session, a resume, a `/clear`, a compaction, a fork -- is
handed the *desk brief* before its first reply: which desk and panel it is
in, the open notes, what was done lately and in which commit, the last
document, and where the work was left. It is small (1.5 KB at most), it
is context and not a request, and About has a switch for it. A resume or a
fork also gets snyvi's current rules for panels ahead of the brief: Claude
Code replays the rules a conversation began with, so a panel resumed after
an update would otherwise have the new tools and not a word on when to use
them. The session is
named after its panel (`ledger · panel 2`) in `/resume`, unless you named it
yourself. And a plan Claude asks you to approve lands in snyvi as it asks,
rendered, with its diagrams drawn, while the approval waits in the panel;
a revised plan is a new version of the same document. Outside a desk,
plans land only with `--auto`.

And at each prompt, Claude is handed what changed on the desk since its
last turn, if anything did: a note you added while it worked, a line you
ticked or put away, a document the panel beside it sent, a new left-off,
a line another panel has taken up. Its own doings are not read back to
it, and most prompts get nothing. It rides on your own message -- snyvi
never starts a turn -- and the same switch in About turns it off with the
brief.

A desk can hold keys for its panels: an API key, a token. The key icon
in the desk's head, beside *Left off* (dim with none, the count beside it
with some), opens a small sheet. Paste the
value once, name the variable it goes in (`OPENROUTER_API_KEY`,
`GH_TOKEN`), say whether it is for this desk or for every desk, and keep
it. The value goes to your keychain -- Keychain on macOS, Credential
Manager on Windows -- or, on Linux and wherever no keychain answers, to a
file only you can read beside snyvi's own token, the way `gh` and `aws`
keep theirs; it is never shown again, and snyvi keeps only the name. A
panel on the desk can use it at once, open ones included: `snyvi key
NAME` in a panel prints the value, so a command says `curl -H
"xi-api-key: $(snyvi key ELEVENLABS_API_KEY)" ...` and the shell, not
the conversation, carries it. It works only inside a panel, and only for
that desk's keys and the every-desk ones. Panels started after the key
was added also have it in their environment. The brief tells Claude the
names and the `$(snyvi key NAME)` way to use them, never the values, and
the next prompt after you add one says it is there. A desk's own key shadows an
every-desk one of the same name. ✕ on a row offers Undo for a few
seconds, then the value is gone -- the one removal in snyvi that is not
kept, because a kept secret is still a secret. Closing
a desk keeps its keys; `snyvi prune` ends them with the desk. Home's right
column lists every key by name, with the desks it is on and when a panel
last started with it. snyvi never uses a key itself, and no MCP tool
hands one over: a tool's answer would land in the conversation. A key is
the panel's to use, though: the shell, the agent in it and every program
that agent runs can ask `snyvi key` or see the variable the way they see
`PATH`. A key on a desk is a key
you would hand to anything you run on that desk. On Linux the file it
rests in is readable by your user alone, as snyvi's own token is.

The same sheet holds your Claude accounts, so one desk can run on your work
plan and another on your own without a `/logout` between them. Under *Add a
Claude account*, *Sign in…* opens Claude's sign-in page in your browser:
approve as the other account, paste the code if the page shows one, and the
account is added. snyvi runs `claude setup-token` out of sight for this and
keeps the token it prints the way a key's value is; the page never sees it.
A token from running `claude setup-token` yourself can be pasted in the same
place instead. Your `/login` account is always there as
*your login*, and the one picked is what the desk's panels start as. A
panel can have its own: right-click it for *Run as…*, or *Continue as…* to
restart it as the other account, back into the same conversation. Panels
already running keep the account they started as, and changing the desk's
offers to switch the ones with Claude open. Everything else under
`~/.claude` -- settings, hooks, MCP servers, memory, the conversations
`--resume` finds -- is shared by every account. A token lasts a year: the
row says until when, in bold in its last month, and *Renew* signs in again
for a new one. A desk key named `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` wins over any account,
so the sheet says so when a desk has one. A token can't use claude.ai's
connectors or Remote Control, which want the `/login` account. snyvi never
switches an account on its own, and ✕ on an account puts its desks and
panels back on your login and forgets the token, with Undo first.

The server also offers four prompts, the loop's own commands, listed in the
`/` menu as `/snyvi:wrap-up (MCP)` and so on: `wrap-up` ticks what is
finished and checked and says where the work was left, `plan` writes the
plan as a document and waits, `catch-up` says where the desk stands in five
lines, and `explain-back` says what was just done and why. Nothing is
written into your `CLAUDE.md` for them.

It also sets Claude Code's status line to `snyvi statusline`, which prints
nothing and tells a desk panel which model it runs and how full its context
window is. A status line you already had is kept and still shows -- snyvi
runs it for you -- and `uninstall-claude` puts it back. Restart any Claude
Code session that was already open: one started before this does not see
snyvi.

`snyvi init-claude --auto` additionally installs a `PostToolUse` hook in
`~/.claude/settings.json`, so every Markdown file Claude writes or edits
is sent without the model having to decide. Rapid edits to the same file
within three minutes overwrite the latest snapshot instead of piling up;
an explicit `send_document` of the same file always creates a new
version, and sending unchanged bytes returns the existing document.
Set `SNYVI_HOOK_EXT=md,txt,rst` to widen the filter.

### Watching a file

For editors and agents that have no hooks, `snyvi watch` does what the
hook does from the outside:

```
snyvi watch PLAN.md            # prints the link, then sends on every save
snyvi watch notes.md draft.md  # several files, one process
```

It sends the file at once, prints the link, and sends it again whenever
the file changes on disk, until you stop it. A file caught halfway
through a write is left alone until it has held still. Saves coalesce
exactly like the hook's edits do, with each other and with the hook: a
tab that has the document open swaps the new version in where it is,
keeping your place, and a save within three minutes of the last
overwrites that snapshot rather than adding one. A file that goes away
is noted and watched for its return.

### Desktop

`snyvi app` opens the viewer in a window of its own, and takes the best
window it can find:

1. a native window, if the `snyvi-app` executable is installed beside
   snyvi or on `PATH` — WebKitGTK on Linux, WebView2 on Windows;
2. failing that, a Chromium-family browser in app mode — no tabs, no
   address bar, its own entry in the task switcher;
3. failing that, your default browser.

Nothing needs configuring to move between them. Install `snyvi-app` and
the first rung appears; remove it and you are back on the second.

The native window is worth having if you would rather not keep a browser
on the machine, or you want the window to remember where you left it:
size and position are restored on the next run.

It also puts snyvi in the tray. Closing the window hides it rather than
quitting — showing it again is instant, where starting a browser engine
is the ~150 ms below — and the tray icon brings it back. Its menu has
two items, show and quit, because everything about the library and the
daemon belongs to `snyvi` itself. On Windows a left click on the tray
toggles the window and a right click opens the menu; Linux's tray
protocol sends no clicks, so there the menu answers both. Running
`snyvi app` again also just shows the window you already have.

And from anywhere, without finding the tray: ⌘⇧Space on a Mac,
Ctrl+Shift+Space on Windows and Linux, shows the window — or hides it,
when it is the one in front. The key is a default and not a decision,
because a global shortcut wins over any program's own use of the same
chord, and some have one (a spreadsheet selects its sheet with it):
`SNYVI_SHORTCUT=Alt+F9` names another, in the usual spelling, and
`SNYVI_SHORTCUT=0` registers none. A key another program already holds
is reported on the terminal and left with it. On a Wayland session
there is no shortcut, since the interface it needs is X11's; the
desktop's own keyboard settings do the same job there — bind a key to
`snyvi app`, which shows the window that is already up rather than
opening another.

The window has no title bar of the system's. The page is the frame: the
sidebar's brand row, the rail's top, and a desk's header row drag the
window and maximise it on a double-click, and the three buttons a bar
had sit in the top right corner, whatever the panes are doing. The
edges still resize it. On a Mac the traffic lights are the system's,
over the brand row. `SNYVI_FRAME=1` keeps the system's frame, for a
desktop whose title bars should all look alike or a window manager that
draws its own. And if the window ever shows a page older than itself —
a daemon upgraded on disk and not yet restarted — the frame comes back
on its own, since that page has nothing to drag by.

On a Linux desktop with no `libayatana-appindicator3`, there is no tray —
snyvi says so, and closing the window goes back to meaning close.

GNOME is the case where the library is there and the tray still is not:
it has no tray of its own, so the indicator is published and nothing
draws it. What draws it is a shell extension, which the `snyvi-app`
package recommends and Ubuntu normally has enabled already. If the tray
is missing on a GNOME desktop and `snyvi app` reported no error, that is
what to look for:

```
gnome-extensions list --enabled | grep -i appindicator   # nothing? then:
sudo apt install gnome-shell-extension-appindicator
gnome-extensions enable ubuntu-appindicators@ubuntu.com
```

Log out and back in afterwards; under Wayland the shell cannot reload
extensions in place.

What the window costs is what a browser engine costs, and it costs it
**only in the window's own process**:

| | snyvi | snyvi-app |
|---|---|---|
| what it is | daemon, CLI, MCP server, hook | the window, nothing else |
| binary | 12.3 MB, static | 4.3 MB, links webkit |
| download | 5.5 MB | 1.2 MB |
| dependencies | **none** | webkit2gtk-4.1, gtk3, glibc 2.34+ |
| runs on | any Linux, both architectures | Ubuntu 22.04+, Debian 12+, both architectures |
| resident | 35 MB | ~380 MB while a window is open |

Those are the Linux numbers, where the two are packaged separately. On
Windows both are in the one zip and the window costs whatever WebView2
already costs the machine; on macOS both are in the one bundle and the
window costs whatever the system's WebKit does.

That separation is the point. Before 0.6 the window was compiled into
snyvi itself, so a machine that wanted one got an engine linked into the
daemon too, and `snyvi serve` sat at 66 MB having never opened a window.
Now it is 35 MB whether or not you have the window installed, and the
engine is paid for only while you are looking at something.

From source, `cargo build --release` gives you snyvi alone; add
`--features desktop` to get `snyvi-app` beside it.

### Keys

The single-letter keys start asleep, so a `j` or a `Del` meant for a
terminal beside snyvi can't move the page or delete a document. Press
**⌃B** to turn them on. A pill at the bottom of the window reads
*Keys on · esc* while they're on, and blinks each time a key acts. They go
back to sleep on Esc, on ⌃B again, on a click, when a text field or a
panel takes the focus, or after ten seconds with no key pressed. The pill
dims just before that happens. Inside a panel, ⌃B belongs to the program
running there (tmux, the shell), and snyvi leaves it alone. Keys with a
modifier, like ⌘K, ⌃\` and alt ←/→, always work.

| Key   | Action                                     |
|-------|--------------------------------------------|
| ⌃B    | turn the letter keys on / off               |
| ⌘K    | search everything                           |
| j / k | next / previous document                    |
| [ / ] | older / newer version in the same workflow  |
| c     | compare with the previous version           |
| s     | split / inline view for diffs               |
| v     | preview a page or PDF / back to source      |
| /     | find in document                            |
| w     | maximise width                              |
| z     | wrap long lines                             |
| p     | pin (kept by `prune`)                       |
| n     | open the next document waiting              |
| Del   | remove document (⌘/ctrl Z undoes it)        |
| h     | home                                        |
| i     | inbox                                       |
| a     | add a note, on Home                         |
| f     | fill the screen with the diagram            |
| 0     | fit the diagram                             |
| t     | toggle contents                             |
| \     | fold the sidebar to its rail / open it      |
| o     | open source                                 |
| ?     | show keys                                   |
| Esc   | back to where the document was opened from  |
| alt ← / → | back / forward                          |
| ☰ / ⇧F10 | the menu for what has the focus           |
| F2    | rename the project, desk or panel row you are on |
| alt ↑ / ↓ | move the desk row you are on up / down     |
| ⌘K `>` | what snyvi can do: a theme, a desk, a folder, an agent, the keys |

`?` works with the letters asleep: it is how you find out they sleep.

**The rail.** `\` or the button at the top of the sidebar folds it to a
44 px column of icons -- the inbox, projects, desks, folders, agents, an
aside when there is one, and search -- and each opens its section beside
the rail; Esc, a click outside, or following a link closes it. The inbox
icon counts what waits, the desks icon the panels waiting on you. A window
narrower than 760 px always shows the sidebar this way.

**On a desk**, with any key going to the panel otherwise: `⌃⌥1`–`⌃⌥4` a
panel, `⌃⌥]` / `⌃⌥[` the next and the previous, `⌃⌥N` a new panel, `⌃⌥W`
close it (its row keeps Undo for 8 s), `⌃⌥R` stop or start it, `⌃⌥Z` it
alone, and `⌃⌥⇧` with an arrow moves it. The ✎ in a panel's head, F2 on its
row or Rename… in its menu names it; the ⋯ at the end of the desk's head
is the desk's own menu. A panel running Claude shows its model and how full
its context window is, amber from 85%. Under it, the foot of the rail links
the repository the desk's folder lives in (`owner/repo ↗`, read from its
`origin` remote, never fetched), and Home's Pick up has the same link.

**Desks keep your order.** Drag a desk's row in the sidebar to put it
where you want it, or use Move to top, Move up and Move down in its menu,
or alt ↑ / ↓ on the row. The sidebar, Home's cards, Home's # list and ⌘K
all show that order; a new desk goes at the bottom, and a reopened one goes
back where it was. Only Pick up follows the desk you touched last.

**A Claude session is named after its panel.** In `/resume` it reads
*snyvi · panel 1* until the panel has a name, by `name_panel` or by you,
and *snyvi · fix the login* from the next prompt on. A name you gave the
session yourself, with `/rename` or `-n`, is left alone.

**Right-click** anything in the sidebar, the rail or a desk for what it can
do: a folder, a file, a project, a document, a desk, a panel's head or its
terminal, a document in a desk's rail, a note, a point. The top line names
what the menu is for; what removes or closes comes last, in red, and Close
desk asks a second time, since it ends its panels' programs (Close panel does not: it keeps Undo).
A closed desk keeps its notes, and Undo, or its row under "Removed · Show" in the Inbox, brings it
back with them and with its panels, stopped, until `snyvi prune` ends it. Each entry does what the row's own
button does -- Remove from inbox leaves the same Undo in the row as its ✕.
The menu key or ⇧F10 opens it from the keyboard for whatever has the focus
(inside a panel, only the menu key: ⇧F10 is the program's), arrow keys and
the first letter move through it, and Esc closes it and puts you back. In
the window, right-clicking anywhere else shows nothing rather than the web
view's Back and Reload; a text field and a selection in a document keep
their usual menu for Copy and Paste.

In a panel, hold **Ctrl** over a link a program printed and it is
underlined; **Ctrl-click** opens it in your browser. A plain click never
does, and only http and https links count.

A path works the same way, in a panel and in what you are reading: hold
**Ctrl** over `src/app.js:120`, `~/.claude/settings.json` or `../notes/`
and it is underlined only if it is there. Ctrl-click opens a file in
snyvi's reader, at the line when one follows it, and a folder on snyvi's
folder page, under Folders: under the desk's own row when the folder is
inside the desk, so `src/` opens as the desk's `src`, not as a new row.
**▸** goes into a folder there, **▴ ..** back up, and **Open in file
manager** beside it opens it in Files, Finder or Explorer. A relative path is looked for where it was printed: in a panel,
the folder its program is in, then the desk's; in a document, the folder of
the file it was sent from, then its desk's, then its project's; in the
folder reader, the file's own folder. Nothing is ever run. This needs the
window: a browser tab cannot ask.

Everything the keys do, a finger can do too: on a screen with no
pointer the controls that appear on hover -- copy, rename, the `#`
beside a heading, a code block's language -- are simply there, and
the `?` button at the top of the window opens the same box. Tab reaches
every control in the order they are on the page; the search palette and
the keys box keep focus inside them while open and give it back to
where it was on Escape, and the find count is read out as it changes.

The foot of the keys box has two lines. *About snyvi* says what this
is, the version and the commit the daemon is running -- read from the
daemon, so it is the number `snyvi --version` prints -- where the
documents and the settings live, what Claude Code has of it, the
license and the repository. *Reset snyvi…* is described under
[Uninstalling](#uninstalling).

## Appearance

Five buttons sit at the foot of the sidebar -- theme, accent, Aa, width,
wrap -- and what each one does is kept for next time.

There are eight themes, four light and four dark, each designed rather
than derived from another. The light ones: **Paper**, the warm
near-white the window opens in; **Snow**, a cool near-white;
**Sage**, a soft green-grey that is easy on the eyes over a long day;
and **Parchment**, a sepia page with brown ink for long reads and a
bright room in the evening. The dark ones: **Ink**, the deep grey-blue
for night; **Midnight**, a deep navy; **Espresso**, a warm brown-black,
the dark side of Parchment; and **Contrast**, white on black at 7:1
everywhere, with rules at full weight and no faint washes. Each has its own syntax colours and its own
terminal palette, so code and the shells on a desk look like part of the
page, and every colour a theme draws text in is measured on every
surface it sits on -- 4.5:1 or better, 7:1 for Contrast -- with each
of the eight accents, on every build.

snyvi's face answers you here and there -- it perks up when something
arrives, and shows a heart when the last thing waiting is read. If you
would rather it kept still, **Quiet mascot** in ⌘K (type `>quiet`), or
on the mark's own right-click menu, keeps every face at rest and nothing
of it moving; the same place turns it back. It is kept with the rest of
the look.

Paper and Ink come with the window itself, so it opens at full speed;
the other six load in the background a moment later. Whichever you
choose, the window opens in it with no flash of another theme first.

The **theme** button steps through the eight, the way the accent button
steps through its colours: the four light ones, then the four dark, and
round again. Its icon shows whether a click lands on a light or a dark
one, and its tooltip names the one showing and the one a click brings.
To jump straight to one, press `⌘K` and type `theme`: the eight appear as
rows, each drawn in its own colours, and moving the highlight puts that
theme on the window behind the box, so the page is the preview. Enter
keeps it; Esc puts the window back.

Either way, the theme you land on is remembered as your light or your
dark one, so when your system switches between light and dark the
window moves between those two. A system asking for more contrast gets
Contrast as its dark theme until you choose one, and Paper with heavier ink in the light.

![The same plan in Parchment](media/plan-parchment.webp)

![The same plan in Midnight](media/plan-midnight.webp)

**Aa** steps through the reading faces: Inter, Source Serif, Literata,
Atkinson Hyperlegible, JetBrains Mono. The first three are a matter of
taste; the last two are not. Atkinson Hyperlegible was drawn by the
Braille Institute to keep letters that blur into one another apart --
`1` and `l`, `O` and `0`, `rn` and `m` -- and JetBrains Mono sets prose
the way it sets code, which some readers prefer for a specification. It
sets prose only: code is always mono and diffs and tables are left
alone.

The **swatch** steps through eight accent colours -- passion, crimson,
rose, violet, blue, teal, green, graphite -- one per click, the whole
window repainted as you go. The accent is what links, the
marker in the contents, a landing wash and snyvi's own mark are drawn
in, and each has a pair for light and dark rather than one colour dimmed
for both. The tab's icon is repainted to match, so two snyvi windows
side by side are told apart at the tab strip.

The **width** and **wrap** buttons are `w` and `z` above.

A control that means nothing in the view you are in is faded rather
than hidden, and its tooltip says why -- `Wrap · no code on this page`,
`Font · code is always monospace`. Clicking it, or pressing its key,
gives the same answer instead of silently doing nothing. On a desk they
mean the desk's own things: **width** shows the focused panel
in full view, as `⌃⌥Z` does, and **Aa** sets the terminal's text size --
Small, Normal, Large, Larger -- for every panel on every desk. Inside a
panel, `⌃=` and `⌃-` step it and `⌃0` puts it back to Normal, as in
most terminals; readline's undo, which `⌃-` used to send, is still
`⌃_`. Wrap is faded there: a terminal always wraps.

The **rocket**, at the top of that column, is a game: snyvi in a helmet,
in a small ship, and rocks coming down. It covers the sidebar and only
the sidebar, so a document arriving while you play opens beside it as
usual. The arrows or WASD steer -- forward as far as the top third of
the sky, which is the rocks' own -- space fires, and `esc` leaves; the
mouse has no part in it. On a touch screen a finger flies it instead: the
ship follows the finger and fires while it is down. The rocks come faster
every twenty seconds, and your best is kept with the other settings, as
soon as it is beaten. Nothing about it loads until the rocket is pressed,
and nothing about it runs while it is paused, or waiting for you to fly.

## Lines

A code or text document addresses its lines. `#L120` opens it at line 120
with the line marked; `#L120-L140` marks the range. Click a line number to
get that link, copied to the clipboard; shift-click a second one for a
range. ⌘K then `:120` jumps without leaving the keyboard.

`z` wraps long lines, for logs and generated code that run off the pane.
Continuations hang past the line numbers, so the code still lines up. The
setting is remembered.

## Tables

A `.csv` or `.tsv` file is laid out as a table rather than shown as
text: quoted fields keep their commas and newlines, numbers are aligned
as numbers, and the head stays put while the body scrolls. Very large
files show their first 2000 rows with a note; `o` opens the whole file.

## Diagrams

A ```` ```mermaid ```` block is drawn as a diagram — flowcharts, sequence,
class, state, ER and gantt — in snyvi's own palette, so it belongs to the
page rather than arriving from somewhere else. All four themes are
checked on every build: every label has to stay legible against whatever
is behind it.

Drawing happens after the text is on screen and only for diagrams the
reader is near, one at a time, so a page with eight of them opens as fast
as a page with none. A diagram is drawn once per tab and kept, so coming
back to a document costs nothing and a watched file does not redraw on
every save. One over about 150 nodes is offered rather than drawn: it
costs seconds, and that should be the reader's call.

A drawn diagram is a viewport, which is what makes a big one worth
having. It opens fitted, so the shape is visible at a glance:

- **⌘/ctrl + scroll** zooms toward the cursor, and so does a trackpad
  pinch. A plain scroll is still the page's, so a cursor crossing a
  diagram never traps it.
- **Drag** pans, once there is something to pan to.
- **Double-click** zooms in.
- **Fit / 100%** is one button: the shape, or the labels.
- **`f`** fills the screen with it, which is where a diagram of a few
  hundred nodes is finally readable. **`0`** fits it again.

Zooming drives the SVG's own `viewBox` rather than scaling a picture, so
strokes stay crisp at any depth.

A source Mermaid cannot parse is never swallowed: the error is shown with
the source underneath it, exactly as the agent wrote it.

## Pages and PDFs

An `.html` file you browse in Folders opens as source, because in a
repository the markup is usually what you want; `v` shows the page itself.
A page an agent *sent* opens as the page, since that is what it was made to
be seen as -- by `path`, or inline with `lang: "html"` -- and `v` shows its
source. A `.pdf` opens in the browser's own viewer, and `v` goes the other
way.

A previewed page runs in an iframe sandboxed **without**
`allow-same-origin`, so it has an opaque origin: its scripts run and the
preview is faithful, but they cannot read snyvi's page, its storage, or
any answer from its API. The page is served with
`connect-src 'none'`, so it cannot send anywhere what it can see either.
In browse mode the page is loaded from a path-shaped URL, so its own
relative stylesheets and images resolve; a page in the library is a
snapshot of one file, so it has none of those to load.

A PDF is framed without a sandbox, because the browser's viewer refuses
to run inside one. That is safe for a different reason: the bytes are
served as `application/pdf` with `nosniff`, so they can only ever reach
the PDF viewer and can never be parsed as a page.

## Width

Prose is capped at a comfortable measure, because long lines are hard to
read. Anything that is not prose ignores that cap and takes the pane:
code, diffs, tables, images, and previewed pages and PDFs.

`w` overrides the cap for prose too. Combined with `\` and `t`, which
hide the sidebar and the rail, it gives the document the whole window.

## Threads and Your turn

What wears a maker down is rarely the work; it is the bookkeeping around it.
Which notes are one piece of work, which folder and branch it lives in, what
was decided in a chat last Tuesday, and what is waiting on *you*. A Claude in
a desk's panel files that for you, and the rail shows it only when there is
something to show: a thread on its panel's row, Your turn and Suggested at
the top.

- **A thread** is one arc of work: a name, the notes it answers, the folder
  it lives in, and a stage -- idea, planned, building, review, waiting,
  shipped, or parked with the next step to pick it up by. Claude starts one
  with `start_thread` when it takes the work on and moves it with
  `move_thread`. A panel holds one thread, the one it last took up, shown as
  a small chip on the panel's row with its stage. Its tip has the name, the
  PR, the checks or the merge as they come, the folder, the branch and its
  commits, and *Decided*: the questions you answered on it. A
  shipped thread shows ✓ until its panel takes up another, or for 12 hours.
  When a panel starts a new thread, or closes, the one it had **rests**:
  folded under the panels as *Resting*, saying why -- *moved on*, *panel
  closed*, *parked*. Nothing needs tidying: a resting thread leaves the rail
  after a day, a parked one after a week, and both are kept; a panel that
  starts one again by its name brings it back. Right-click a thread -- its
  chip, a resting one's row or ⋯, or the panel's row, where the same four
  are named as the thread's -- for **Done** (work that shipped where the panel did not see it),
  **Park…** with a next step, **Rename…** or **Remove**; the panel hears a
  Done or a Park at its next prompt, and ✕ leaves its Undo in the row, as
  everywhere. A note's tip says which thread it is in and who has it; the
  note itself keeps its row for its own two lines, and under them one quiet
  line: its number, then its small marks -- the stage in a word, the
  pictures.
- **Your turn** is what only you can do: a decision (`ask`, with two to four
  options and the one Claude recommends), or a hand-over (`hand_over`): try
  it, merge it, add a key, or **run** a command Claude was blocked from
  running. A run card shows the whole command; **Run in panel N** types it
  into the panel that asked as a `!` command, so its output lands in that
  conversation and Claude carries on (mid-turn, Claude Code holds it until
  the turn ends). **New panel** runs it in a shell of its own, and **Copy**
  copies it. A command with a newline or an escape in it is refused, so what
  Run types is exactly what the card shows. Answer on the rail or on Home. Your answer goes
  with your next message to the panel that asked; while that panel is idle,
  **Send now** types it in and presses Enter for you. snyvi never starts a
  turn by itself.
- **Suggested** is a panel or a desk Claude thinks the work wants, with the
  exact command it would run. **Open panel** opens it on this desk and runs
  that command; **Open desk** makes a desk for the folder. Nothing opens
  until you click, and three wait at most.

Home lists **Your turn · across desks**, answerable in place, and
**Threads**: what is moving, what rests (parked with its next step, or left
by its panel), and what shipped this week. The desk brief names the threads
panels are moving and the parked ones, and
what is on you, and each prompt's changes carry your answers and the moves
you made.

### The snyvi mod in panels

With Claude Code 2.1.287 or later, a panel's Claude also loads the *snyvi
mod*: a small plugin that runs inside Claude Code, built into snyvi and
written to snyvi's data folder. The daemon names it in
`CLAUDE_CODE_PLUGIN_DIRS` for the panels it starts, so nothing is installed
into `~/.claude`, a `claude` in a plain terminal has no mod, and it is
always the version of the snyvi that started the panel. In a panel with it:

- One dim line above the prompt says the panel's thread and what is on you:
  `▸ Home + friends · building · claude/asides · 3 commits · your turn: try it`.
- Claude's own questions (its multiple-choice dialog) appear under Your turn
  too. Answer in the terminal or in snyvi; the first answer is the one
  Claude gets, and the other side closes.
- The branch, the commits and the PR are *seen* from what git and gh did in
  the panel, and the checks on a PR are read once a minute until it merges.
- `/note …` puts a line on the desk's notes while Claude works, with no turn
  spent; `/turn`, `/park …` and `/thread` say or do the rest.

It only talks to the local daemon, with the panel's own token, about the
panel it runs in. It never starts a turn and never approves or blocks a
tool. About has the switch, *Claude Code mod*, under *In panels*; a panel started
before you flip it picks the change up at its next start.

## The rail

Prose gets a table of contents. Code gets an outline of what it declares:
functions, types, implementations and modules, nested by indentation and
marked by kind. Clicking one jumps to that line and highlights it.

The outline comes from the same grammar the highlighter uses, so it
follows the language rather than guessing with patterns, and call sites
and builtins stay out of it. It is fetched after the page has painted,
so it never delays reading.

The rail follows you. The entry for the section you are in is marked and
kept in view, however long the contents are; the actions under them --
pin, compare, delete, open source -- stay where they are. A wheel over
either pane scrolls the pane until it has nothing left, then the
document. Clicking an entry jumps to the heading without adding to the
browser's history, so Back still means the previous document. The `#`
beside a heading copies a link to that section, the way a line number
copies a link to a line, and the contents write the same links. `t`
hides the rail, and so does the button in its top corner; the sidebar
has the same button at the end of its brand row, and `\`. A pane put
away stays away until you bring it back, with the same button, which
moves to the edge of the page where the pane was.

On a window under 1100 px wide the rail no longer fits beside the
document, and under 760 px neither does the sidebar. Each becomes a
sheet over the document instead: `t` and `\` open it, so do the two
buttons at the top of the page, and Escape, a tap outside, or the
button on the sheet closes it. The contents open on the section you are
in, and a tap on an entry goes there and puts the sheet away. Widen the
window and the panes are panes again, as you left them.

Both panes resize. Drag the seam between a pane and the document -- the
sidebar's right edge, the rail's left -- and the pane follows, between a
width where its rows are still readable and one past which the document
would be the pane that does not fit: 200 to 440 px for the sidebar, 180
to 400 for the rail. Double-click the seam for the default. The seam is
a Tab stop too, and the arrow keys move it. The width is kept.

## Home

The mark opens Home, at `/`: the way back into an evening's work.

Under the title, one line says what needs you (a panel that rang, or a
Claude asking), what is waiting to be read, whether a Claude is working,
and how much of the account's five-hour window is left.

**The note bar** is at the top of the left column, and stays there as the
page scrolls: one field for a line on any desk's list. The chip at its left
says which desk, and starts on Pick up's; click it for the list of desks, or
type `#` and the start of a desk's name in the note and press Tab. A `#`
that names no desk -- "#77" -- stays in the note as written. Enter adds the
line and leaves the bar empty for the next, as the desk's own field does. A
screenshot pasted or dropped on the bar goes on the line with it. The bar
says where the line went, "Added to snyvi · Undo", for a few seconds; Undo
takes it off again and puts the words back in the bar. `a` puts you in the
bar, with the letter keys on.

**Pick up** is one desk, large: the one you touched last, or the one you
keep there with *Keep here*. It says when you last touched it, where the
work was left -- or, when no one said, the last thing that happened on it,
marked *Last* -- the open notes, what git says in its folder (the branch,
what is changed, what is not pushed, the last commit), and each panel in
words. Enter opens it. The other desks sit beside it with their age.

**Your days** is what happened, day by day and desk by desk: notes ticked
(with the commit and the link the agent gave), documents sent, commits in
the desk's folder, and where the work was left, each with its time. It
shows the last three days with anything in them and a desk's first four
lines; the rest are a click away. *Send this week as a doc*, on its
heading, files the last seven days as a document in each desk's own
project.

**Projects** is every other desk, a card each, as many across as the
window fits: its age, where it was left, its first open notes (tick one
where it stands), a **+** that puts the desk on the note bar's chip, and
its last eight weeks, a bar a week as tall as the days with work in them.
A desk quiet for ten days offers *Park it?*: it asks for the next step,
takes the desk out of Pick up, and keeps it on a Parked shelf under the
cards with that step until you take it down. Nothing on a parked desk is
closed.

The date is beside the title.

**Arrived** heads the right-hand column: what came, in one place. An
agent's offer to send a document to a friend comes first, since it asks
you something -- Send or Not now in its row, and Not now has an Undo.
Then a friend's lines, with **Keep on…**, which puts one on a desk in a
click with their name on it, and ✕. Then the newest documents you have
not read; a click opens one, and it leaves the list. Five rows at most,
and "Everything in the Inbox →" when more are waiting. Arrived cannot be
hidden, so nothing that arrives is put out of sight.

**Claude** has what is left of the five-hour and weekly windows, when that
was read, and the fullest context window; a window past its reset is shown
full again. When an update is ready, its card heads the column.

**Friends** shows once you have paired with someone: a line each, with
where their things land (**→ own row**, or a desk you pick: their
documents go to its project and their lines become its suggestions),
**Note…** for a line on their Home and **⋯** for Mute and Remove. A
friend's document says *Keep on a desk…* in its head; once it is on one,
*Save into the folder* writes it into that desk's folder under
`from-<their name>/`, next to nothing it would overwrite. **Keys**
is folded until you open it, and stays as you left it.

The foot says which snyvi this is, with *Check for updates* and *Pair with
a friend…*.

Git is read only in a desk's own folder, never in your home directory,
read-only and with a two-second limit, and nothing leaves the machine.
Home is one read of the daemon, and it follows what changes while it is
open. A side widget can be hidden; "2 hidden · Show" at the foot brings
them back. The Inbox is at `/inbox`, and `i` still opens it. An empty
library still opens on Welcome.

A document opens where you left it, however you open it -- the tree, the
queue, `n`, Home, ⌘K, after a restart -- and at the top once you have read
to its end. The place is kept in this browser, for the last 200 documents.

## Arrivals

A document that arrives while you are reading never takes the page
away. It joins a queue: a row at the top of the sidebar under
"Waiting", a mark on its row in the tree, and a bar above the document
that counts -- "3 waiting" and the title of the oldest, with snyvi's own
face at the front of it, holding what came: wide-eyed for a moment when
one more arrives, glad when one is read, and smiling in between. `n`
opens the oldest and takes it off, so the next `n` is the one after; a reader
drains the queue with one key, in the order things came. Opening a
document any other way -- the sidebar, the inbox, an agent's link --
takes it off the same way, since read is read wherever you got to it.
The queue lives in the daemon, so it is the same in every tab and the
window, and it survives a restart.

The inbox lists what is waiting first, oldest first, then everything
else. "Mark all read" empties the queue without opening anything, for
the day an agent sent thirty; it answers "Marked 30 read · Undo" where
the bar was, and ⌘/ctrl Z puts them back. Twelve arrivals in two seconds are twelve
rows and one bar that says twelve.

The one place an arrival opens by itself is the inbox with nothing
waiting: the empty state exists to be filled. Before 0.14 an arrival
opened itself whenever the page had gone 2.5 seconds without a scroll
or a key, which is what reading a paragraph looks like.

Every document and every file has a ✕ at the right of the bar across
its top, and it goes back to the screen you opened it from: the Inbox, a
folder, the agents page, a desk. Documents read one after another, with
`j`, a link or the search, are one visit, so the ✕ goes back past all of
them, not to the one before. A document with nothing behind it, opened
from a link or when the window starts, goes back to the Inbox. Its
tooltip names where it leads. Esc does the same once there's nothing
else to close: the first Esc shuts the search, the find bar or the keys,
and the next one goes back.

Back opens a document where you left it, not at the top: the place is
written into the history entry as you leave and after each scroll, as
a block and an offset into it, the way a save already keeps it. In the
desktop window, which has no toolbar, alt+← and alt+→ are Back and
Forward; in a browser they are the same one step, not two.

Removing is one keystroke and no question. `Del`, or the ✕ on a
document's row in the sidebar, takes it out of the inbox at once. Its
row stays where it was, saying "removed", with an "Undo" in it and a
thin bar along its foot that drains over six seconds; resting the
pointer or the keyboard's focus on the row stops the bar. Removed with
a key, the focus lands on the Undo, so Enter takes it back. ⌘/ctrl Z
does the same, which is where your hand goes anyway. A file that was
sent several times goes with all its versions, and the row says how
many ("removed · 3 versions"); Undo brings every one back.

Every Undo in snyvi -- a document, a project taken out of the
sidebar, a folder, an aside, Mark all read, a desk's note or panel --
stands for the same six seconds, and only the newest stands: removing
something else settles the last offer, and ⌘/ctrl Z always means the
most recent thing you did.

After the six seconds it is still not gone. The foot of the Inbox says
"3 removed · Show" while there is anything to bring back, and Show
lists it -- documents and asides, newest first -- with an Undo on each
row, until `prune` deletes them for good.
Nothing is destroyed in the meantime: the daemon marks the document
deleted and keeps it until `prune` runs, which is what makes the offer
real. It disappears from the tree, the inbox, search and the queue in
every tab at once, and comes back to the same place.

When snyvi says no, nothing you did is lost. An Undo that is refused
keeps its row, which says "Could not bring it back" with a Retry; a
note or a name that is refused is back in its field with the reason
under it; a tick or a close that is refused is put back, and its own
row says so. An error stays until its ✕, and news that arrives
meanwhile waits behind it. A list that could not be loaded says "Could
not reach snyvi · Retry" in its own place, and never looks empty.

What moves in the sidebar says so once, and briefly. An arrival's row
is lit for a moment, the way a heading is where a link landed -- the
same wash, so there is one sign to learn; a row you have read or
deleted closes where it was before the list moves up, and one an undo
put back is lit again. The bar over the document rises when it appears
and stays put after that: a count that changes settles in, in place,
and the face on the bar reacts once and is still again.
Every motion on the page is under 200 ms except that wash, none of it
runs while you read, and `prefers-reduced-motion` turns all of it off
rather than slowing it down. The `#` beside a heading confirms a copy
on the mark itself, not at the corner of the screen.

## Asides

An arrival is work: a document an agent finished and you asked for.
Now and then there is a sentence that is not work -- what it noticed on
the way, what it would do next, what it is unsure of -- and until this
existed the only way to say it was to make it a document, which put it
in your library and your unread count as though it were one.

Sometimes the sentence is about you rather than the work: that the
migration held after four evenings on it, that it is past one and the
tests are green and the rest keeps. An agent may say that, a few times
in a long session at most, and only about something that happened here
-- a note it ticked, a commit, a test, where the desk left off. It never
guesses at how you feel, and an aside that gives no reason in the record
is one it was told not to send.

`send_aside` is for that sentence, and it is deliberately small. An
aside is at most 280 characters; past that it is a document and
`send_document` is the tool for it. Asides are kept in memory, the last
five of them, so a daemon restart forgets them -- an aside is about now,
and one that outlived a restart would be about some other now. They
never enter the queue, never mark anything unread, and never take the
page away from what you are reading.

One sits at the foot of the sidebar, under the trail of the few before
it. A new one lights up and snyvi's own mark beside it hops once; rest
on the aside and it is read, and the mark settles. Only one aside lights
up every ten minutes: an agent that leaves one per edit costs you a
single glance, and the rest join the trail quietly. An aside may name a
document it is about, and then clicking it opens that document. One an
agent left from a desk's panel, about no document, says which in its
byline -- "via claude-code on ledger [2]" -- and clicking it opens that
desk with the panel focused, which is where you answer it, if you do.

An aside can be closed: the ✕ in its corner, or Esc while it has the
focus. Its card stays where it was as one line, "Aside closed", with an
"Undo" and the same draining six-second bar a removed document's row
has; ⌘/ctrl Z works too. The Undo asks the daemon first, and a refusal
keeps the line, saying so, with a Retry. When the bar runs out, the next aside you
haven't closed takes the card, or the card goes. With a trail behind it,
"Close all" at the foot of the trail closes every one at once. Closing
is not muting: the next aside an agent sends shows as usual. A closed
aside is closed in every window, and the daemon only marks it closed,
which is why the Undo is real.

It is a channel from the agent to you and nothing comes back: an aside is
not an instruction to anything. A reply is a line you type in the panel,
like any other.

If you would rather no agent left you a line at all, About has an
**Asides** switch: turn it off, and the daemon refuses every aside, saying
"asides are off in About" to the agent that sent it, which is told not to
send another. The ✕ on each aside stays the way to say no to one; this is
the way to say no to all of them. snyvi's own first lines, which point you
at what is new, are not an agent's and still show. Turning it on puts it back.

An aside is not a desk's notes. Those are your own list, kept with the
desk and written only by you; an agent's asides never land on it.

An agent can *read* that list, and tick a line done, and nothing else of
snyvi's. A Claude running in one of a desk's panels is offered
`read_desk_notes`, which returns that desk's notes, open and done, each
with its number, and `tick_desk_note`, which marks one open line done when
the work it names is finished. A line an agent ticked carries the agent's
name at its end, and, when the agent passed them, the commit the work went
into (click it to copy the hash) and a ↗ that opens the document it sent
about the work; untick it and it is yours again, with none of those. The
same Claude can name its panel with `name_panel`, a few words for what it
is doing there, which you can rename like any other. There is no way for an
agent to add, untick, change or remove a line. It is found by the pane: the panel puts its id in
the shell's environment as `SNYVI_SESSION`, and the daemon answers only
while that panel is running, and only with its own desk's list -- never
another desk's, and never a document. A Claude started anywhere else is
not offered the tool at all. If a list is for your eyes only, keep it on
a desk you do not run agents in.

The tool was called `send_note` through 1.4.0. The old name still
works, so a session that was already running when you upgraded keeps
its asides.

## Where a link opens

With `snyvi app` running, a link opens in that window rather than in a
browser beside it. The window's page says it is one when it connects to
the daemon's event stream, so the daemon knows a window is up for
exactly as long as there is one -- quit it and the next link opens in a
browser again, within a few milliseconds. `snyvi open`, `snyvi send
--open`, `snyvi browse` and a click on a notification all hand the URL
to the window and raise it.

It changes what an agent is told, too. `send_document` used to answer
with `http://127.0.0.1:7777/d/…` whatever was running, so a click on the
agent's link opened a second copy of the viewer in a browser next to the
window you were using. With a window up, the tool now answers that the
document is waiting in snyvi and gives no link at all; without one, it
gives a link.

Which link depends on what is installed. Where `snyvi-app` is, the link
is `snyvi://d/…`: the desktop hands it to the app, which shows the
document in the window that is up, or starts the daemon and opens one.
Where it is not, the link is the `http://` one, and opens in a browser.
The `snyvi://` scheme is registered by the `.deb`'s desktop entry, by
`snyvi.app`'s Info.plist, and — for a tarball or zip, where nothing
installs an entry — by the window itself the first time it runs, on Linux
and Windows. `snyvi app snyvi://d/…`, `snyvi app <id>` and `snyvi app
<url>` do from the terminal what a click does.

One thing to know: a terminal decides for itself which links are
clickable, and several — kitty, Ghostty, VTE-based ones — only recognise
a fixed list of schemes. `snyvi://` can usually be added to that list
(kitty's `url_prefixes`, for one), and the `http://` link is always given
alongside for a terminal that does not know it.

A link inside a document goes the other way. One to the web opens in a
browser: a tab beside the viewer, or, from the window, whatever your
desktop opens links with — the window has no address bar and no Back
button to come home by, so the web belongs outside it. A small ↗ beside
the link says so before you follow it. `mailto:` and anything else your
desktop answers for go out the same way, without a blank tab. A link to
another document, or to a file in the folder you are browsing, turns the
page here without leaving — which is what makes a relative link between
two browsed files work. And a relative link that points at nothing snyvi
has says so in a line at the corner, offering the browser if that is
what you meant, rather than replacing what you were reading with "Not
found".

## Browsing a folder

`snyvi browse` opens the folder you are in as a file tree and renders
files as you click them. Nothing of it is stored, nothing joins the
library, and nothing appears in the inbox. It is a reader for code and
notes you already have, not an import.

The folder itself stays open. It is in the sidebar until you close it,
across restarts and upgrades of the daemon, so the repositories you read
in are there each morning without being opened again. A folder that has
gone from disk in the meantime is dropped quietly. Closing one (its ✕,
or Close folder in its menu) leaves its row as "closed · Undo" for a
few seconds, and the Undo opens it again in its place.

```
snyvi browse            # the current folder
snyvi browse ~/code/foo
```

Or from the window: **Folders** is always in the sidebar, and the `+`
beside it (or "Open folder…" in ⌘K) shows your desktop's own folder
dialog — zenity or kdialog on Linux, the Finder's on macOS, Explorer's on
Windows — and opens what you choose. The dialog is the desktop's, asked
for by the daemon, so the page never names a path; it sits behind the
same window-only gate as the desks, and a browser tab is told to use the
window or `snyvi browse` instead.

It honours `.gitignore` and skips hidden files, so `node_modules` and
`target` stay out of the way. Files render on first open and are cached
by modification time, so revisiting one is instant. ⌘K finds a file by
name inside the folder, `j` and `k` step through files, and the folder
closes from the sidebar or the rail. Images display, binaries and very
large files are described rather than dumped.

The folder is live. Save the file you are reading and the page updates
where it is, scroll position, find and preview included; add or remove
files and the tree follows. The daemon looks at the files and folders
you have on screen a few times a second, only while a tab is connected,
and only once a change has held still, so a file caught mid-write is
never shown half-way. That is a handful of `stat` calls, not a
recursive watch, so a repository of any size costs the same.

A link into a folder lands where it points: `#L120` on a file opens it
at that line, marked, and a section link opens it at that heading -- the
same two the library's own documents answer to, and worth having because
a link into a browsed file is how one agent tells you where to look.

**Open in file manager**, under the file or folder you are reading, shows
it in Files, Finder or Explorer; a file opens the folder it sits in. It
is in a folder's right-click menu too, and a desk's **Folder** line in
its rail does the same for the desk's folder. The page sends only the id
of what you are reading and the daemon works out the folder itself. For a
shell in a folder, open a desk on it.

Opening a folder requires the daemon token, because it exposes those
files to the browser. Reading inside a folder you already opened does
not, and paths that escape the folder are refused.

## How it is organised

```
Project      detected from the sender's working directory (git root)
└── Workflow   one Claude Code session, or a name the sender gives
    └── Document   immutable, rendered once on receipt
```

Both names are guesses — a project takes the directory's name, a
workflow the title of the first document its session sent — so either
can be corrected: hover the name in the sidebar and click the pencil,
then Enter to keep it or Escape to abandon it. What is underneath does
not move, so sends keep landing where they did, and a project you have
named yourself is no longer renamed by the directory it came from.

Documents are never updated. If the agent revises a plan, it sends it
again; the workflow shows both, and `c` diffs them. Every snapshot of
the same file, across sessions, is listed under "Versions" in the rail.
Large code files are shown at once with the first 256 KB highlighted;
the rest is highlighted in the background and swapped in when ready. A
code block over 400 lines is served cut into chunks of 200, so the page
lays out only the ones near the screen, and its outline for the rail is
worked out once, on arrival, and kept beside it. A click is answered
before any of that: the title appears at once, with the shape of the
text under it, and the document fills it in when it arrives.

Mermaid blocks render as diagrams; the library is embedded and loaded
only on pages that have one, after the text has painted. Relative
images in a document sent by path are served from the file's directory,
confined to the project root and to pictures, video and sound. An image
whose path is a video or a song, `![take 2](take2.mp4)`, plays in place:
a player with controls, seeking as it goes, in a box that holds its size
before the video arrives. So several takes go in one document, to be
watched and chosen from.

Search understands `p:project` and `kind:md|code|diff|text` prefixes.
Documents from one Claude Code session share a workflow whether they
came from the hook or from `send_document`; a SessionStart hook,
installed by `init-claude`, records the session for the MCP server.
When no snyvi tab has focus, a new document raises a desktop
notification — `notify-send` on Linux, a toast on Windows, Notification
Center on macOS (set `SNYVI_NOTIFY=0` to disable). On the free desktops
the notification opens the document when you click it: in the window if
one is running, raised, and in the browser otherwise. Windows wants a
registered application id to be clickable at all and macOS's
`display notification` carries no action, so there both are notices and
not buttons. In the page a new document joins the queue, under
"Arrivals" above.

A notification is silent unless you ask: `SNYVI_SOUND=1` asks the
desktop for its message sound with it, and a burst of arrivals -- an
agent writing twelve files -- sounds once, not twelve times. It is a
hint on the notification, so your volume, focus mode and do-not-disturb
still decide, and nothing in the page ever plays anything. Windows
toasts sound by default; `SNYVI_SOUND=0` silences them.

## Languages

Everything syntect ships (Rust, Python, JavaScript, Go, C, C++, Java,
C#, Ruby, PHP, Shell, SQL, YAML, JSON, HTML, CSS, Markdown, and about
fifty more) plus grammars vendored in `syntaxes/`: TypeScript, TOML,
Dockerfile, Swift, Zig, GraphQL, Nix, Nim, Fish, Sass, SystemVerilog.
`cargo test --release build_syntax_pack -- --ignored` regenerates the
pack after adding a `.sublime-syntax` file there.

## Where things live

| What      | Where                                   |
|-----------|-----------------------------------------|
| documents | `~/.local/share/snyvi/docs/<id>.{src,html}` |
| index     | `~/.local/share/snyvi/snyvi.db` (SQLite, FTS5) |
| token     | `~/.config/snyvi/token` (required for every write) |
| folders   | `~/.config/snyvi/folders.json` (the open folders, by path) |
| log       | `~/.local/share/snyvi/daemon.log` (a daemon snyvi started; not on Windows) |
| updates   | `~/.local/share/snyvi/updates/` (what is staged, and `state.json`) |

On Windows, `%LOCALAPPDATA%\snyvi` and `%APPDATA%\snyvi\token`.

Override either with `SNYVI_DATA_DIR` and `SNYVI_CONFIG_DIR`.

## Design notes

See [BRAINSTORM.md](BRAINSTORM.md) for the reasoning behind the
architecture, the performance budgets, and the milestones.

## Measured so far

Release build on a 4-core container, headless Chromium, best of three
for the render and daemon rows (`snyvi bench`); the page rows come from
`bench/browser.mjs`. What the page does, as opposed to how fast, is
read by `bench/ui.mjs`: where the contents' marker is after a read to
the end, what a wheel over the rail moves, what Back does, whether a
save keeps the place, what `t` opens at 1000 px, whether Tab reaches
every control, what a drag on a pane's edge does, what `f` fills and
what Escape gives back, what an arrival does to a reader in the middle
of a page, whether a delete can be taken back, where a link into a
folder lands, whether a page gives its connection back when it leaves,
whether the daemon knows a window is up, and whether what moves in the
sidebar moves once and briefly. Counts and
positions, no clocks, so every one
of its rows is enforced on every machine, CI's included. The desktop
window's engine is not Chromium: `bench/webkit.py` drives the same page
in WebKitGTK under Xvfb, by hand for now, and reads the two things only
that engine got wrong. `bench/echo.py`, also by hand, types into a panel
over the desk socket and times each key to its echo: p99 6 ms with a busy
panel beside it, held to 20 ms (it was 42 before the socket set
`TCP_NODELAY` and a key's echo stopped waiting out the frame pacing).

Every row here is one the bench reads, with the budget the bench holds
it to; a number no probe reads is in the short list after the table,
not in it.

| Case                                        | Result      | Budget |
|---------------------------------------------|-------------|--------|
| Binary size, `snyvi`                        | 17.4 MB     | 18 MB  |
| Daemon cold start, to first health          | 11 to 14 ms | 100 ms |
| Daemon resident, three documents in, settled | 40 MB      | 60 MB  |
| Daemon resident, after a 1 MB document and a 100k-line file, settled | 57 to 72 MB | 100 MB |
| Renderer init (86 grammars from the pack)   | 6 ms        |        |
| Send, 100 KB Markdown, round trip           | 12 to 14 ms | 100 ms |
| Document page, time to first byte           | 1 to 2 ms   | 30 ms  |
| Document page, first contentful paint       | 65 to 170 ms (cold fonts) | 250 ms |
| Longest task booting a page with a 220-node diagram | 66 ms (was 3193) | 200 ms |
| Longest task drawing a diagram              | 70 to 80 ms | 250 ms |
| First diagram drawn, library parse included | ~550 ms     | 2 s    |
| Render Markdown, 100 KB                     | 10 ms       | 50 ms  |
| Render Markdown, 1 MB                       | 108 ms      | 400 ms |
| Highlight Rust, 10k lines                   | 143 ms      | 500 ms |

Read by hand, once, and not held to anything: the window's own binary,
`snyvi-app`, is 4.3 MB; the two `.deb` downloads are 5.5 MB and
1.2 MB; the native window has its web process up in about 150 ms and
sits at about 380 MB resident, which is the engine (see below); and a
document sent is on the page about 50 ms later, over the event stream.

`snyvi bench --check` fails when a case exceeds its budget; CI runs it
with `SNYVI_BENCH_FACTOR=3` to allow for slower hosted runners. The
factor scales the budgets that are clocks and not the size or the
resident rows: a binary weighs the same on any machine. The Windows and
macOS jobs add `SNYVI_BENCH_SHARED=1`, which prints the cold-start row
without enforcing it, and it alone: the Windows runner takes 400 ms to
create a process where a dev box takes 11, and how much of that is
Windows and how much the runner is not yet known. The send, first-byte
and render clocks are held on every desktop. The binary size is held
only where the build has the fat LTO that ships: the desktop, Windows and
Intel Mac jobs turn it off to save build time, so there the row is
printed with its budget in brackets.

The same bench, on the three desktops CI builds for. These are the
hosted runners' numbers, from one run each, and a runner is a slow and
noisy machine; a reading from a real Mac or a real Windows desktop
replaces its column when there is one, and sets the Windows budget the
`SHARED` rows are waiting on.

| Case                                    | Linux, this container | macOS (arm64) runner | macOS (x86_64) runner | Windows runner |
|-----------------------------------------|---------------|---------------|----------------|---------|
| Binary size, `snyvi`                    | 12.4 MB       | 10.0 MB | 10.9 MB | 10.8 MB |
| Daemon cold start, to first health      | 11 to 14 ms   | 20 to 35 ms | 32 ms | 408 ms |
| Daemon resident, three documents in     | 40 MB         | 11 MB   | 8 MB  | 22 MB |
| Daemon resident, after the two fixtures | 57 to 72 MB   | 26 MB   | 30 MB | 33 MB |
| Send, 100 KB Markdown, round trip       | 12 to 14 ms   | 25 to 41 ms | 37 ms | 31 ms |
| Render Markdown, 1 MB                   | 108 ms        | 127 to 182 ms | 298 ms | 173 ms |
| Highlight Rust, 10k lines               | 143 ms        | 166 to 282 ms | 431 ms | 263 ms |

The Linux resident row after the two fixtures used to swing between
about 80 and 105 MB on the same binary: glibc kept or returned the
memory a large render freed depending on which threads ran it and when
they retired. The daemon now returns it after any render over 512 KB,
off the sender's round trip, and the row settles at 57 to 72 MB. The
static release is built on musl, which returns large frees at once.

The binary is smaller on the two desktops that ship no static libc. The
resident rows on macOS are the process's physical footprint, which is
what Activity Monitor shows: the plain resident count there keeps pages
the allocator has given back and the kernel has not yet taken, and read
181 MB for a daemon whose Linux twin settled at 82. `snyvi bench` reads
the footprint through `vmmap`, which comes with the command line tools,
and says so on the row when it cannot. Two runs of the same job gave the
ranges: a hosted Mac is not the same machine twice.

The Markdown
fast path skips the HTML sanitizer whenever a document contains no raw
HTML, which is nearly always for agent output.

The render rows are the renderer in process. The daemon rows are a
daemon the bench starts for itself — its own data directory, its own
port, gone when the bench is — so `snyvi bench` never touches the
library on 7777. It weighs the binary it is running as, starts that
daemon three times and keeps the fastest, sends three 100 KB documents
by path the way the hook does, asks for a page the way a browser does,
and reads the daemon's resident set twice: once with those three
documents in and once after the 1 MB and the 100k-line fixtures have
gone through it, the second only after the daemon has said the
background highlight is done. Both readings are taken settled: a render
runs on a thread that retires a second after its last task, and its
freed memory goes back to the system only then, so the number a second
after a send is the one a reader lives with and the number during it is
not.

`node bench/browser.mjs --check` is the other half, and covers the part
the reader actually waits on. It sends a fixture document through the
CLI, opens it in headless Chromium, and budgets first paint and the
longest task the page blocks for — separately for booting, for compiling
Mermaid, and for drawing with it, because three different things are
slow in those windows. It also checks what no timing can: that a diagram
below the fold is not drawn, that one too large to draw politely is
offered rather than spent, and that leaving a document mid-render
strands nothing. In CI it runs with `SNYVI_BENCH_SHARED=1`, which prints
the rows that measure the runner rather than snyvi instead of enforcing
them; the behaviour checks and the one timing that survives a slow
machine are enforced there too. It needs Node 22 and a Chromium, and
installs neither.
See [DIAGRAMS.md](DIAGRAMS.md), which is where the 3193 ms in
the table above came from and what removing it took.

Only the window's resident number is over what
[BRAINSTORM.md](BRAINSTORM.md) asked for, and it is the one fact that
will not change: WebKitGTK is 90 MB of shared library before snyvi's
first instruction. The budgets there — 15 MB, 60 MB resident, 150 ms
to first paint — were written for one static binary, and snyvi still
meets every one of them whether or not you have a window installed.
Which of the rest of that document's targets became the bench's
budgets, and which did not, is its last section.

That was not true in 0.5. The window was compiled into snyvi, so the
daemon carried the engine too and sat at 66 MB. Moving the window into
its own executable put the daemon back to 35 MB and left the engine
where it belongs: in the process that is showing you something, for as
long as it is on screen.

Until 0.10 the size, start-up and resident rows were hand-measured and
enforced by nothing, and they had drifted: the table said 35 MB for a
daemon with one document in it, and the first run of the bench read
62 MB. Most of that was not the daemon's. See the 0.10 notes in
[ROADMAP.md](ROADMAP.md) for what it was.
