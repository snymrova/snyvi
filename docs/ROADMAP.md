# snyvi roadmap

Two rules decide priority: does it make reading more beautiful, and does it
keep everything instant. A feature that serves neither waits.

Status key: **done 0.2**, **next**, **later**, **maybe**, **no**.

## A. Reading experience

| Feature | Why | Cost | Status |
|---|---|---|---|
| Mermaid diagrams | Agents put flowcharts and sequence diagrams in almost every plan. Today they show as code. Vendor the library in the binary, load it only when a page has a `mermaid` block, render after first paint so text never waits. | M | **done 0.2** |
| Side-by-side diff with word-level highlights | "Compare with previous" and sent patches are inline only. Reviews read far better in two columns with changed words emphasised. Toggle with `s`. | M | **done 0.2** |
| Find in document | `/` opens an in-page find with match highlighting and a count, like a code editor. Browser find works but ignores collapsed sections and looks foreign. | S | **done 0.2** |
| Images and relative links | A plan that embeds `./docs/arch.png` shows a broken image. Serve files from the source document's directory only, image types only, so nothing else on disk becomes reachable. | S | **done 0.2** |
| Code outline in the rail | For a code document, list functions, types and headings from the highlighter's scopes so the rail is as useful for code as the TOC is for prose. Worth more now that browse mode shows code all day. | M | **done 0.3** |
| Watch a browsed folder | Refresh the open file when it changes on disk, instead of on manual reload. Listed folders follow too. | S | **done 0.4** |
| Math (KaTeX) | Rare in engineering docs. Same lazy-load pattern as Mermaid once that exists. | S | later |
| Structured views for JSON, YAML, CSV | CSV and TSV render as a table (**done 0.3**). JSON folding and YAML remain. | M | later |
| Preview a page or a PDF | An `.html` file showed as source only and a `.pdf` as "a binary file". Both now show as themselves with `v`: a page in an iframe with an opaque origin, a PDF in the browser's viewer. | M | **done 0.3** |
| Images and binaries in the library | `send_document` of a PNG stored mojibake. Images are kept as bytes and displayed; anything else undecodable is described. | S | **done 0.3** |
| Line wrap toggle, jump to line, line permalinks | `#L120` and `#L120-L140` open a code document at a line and mark it; clicking a line number writes that link; `z` wraps long lines with the continuations hanging past the numbers. | S | **done 0.4** |
| Focus mode | `f` hides both panes and centres the text. One keystroke, but most of it exists via `\` and `t`. | XS | maybe |

## B. Library and organisation

| Feature | Why | Cost | Status |
|---|---|---|---|
| File history | Every snapshot of the same path across workflows, newest first, with diff between any two. Today versions are only visible inside one workflow. | M | **done 0.2** |
| One workflow per Claude Code session | Hook sends and MCP sends from the same session land in two workflows because the MCP server cannot see Claude's session id. A `SessionStart` hook can record `cwd → session` in the config dir; the MCP server reads it. Result: one workflow per session, titled from its first document. | S | **done 0.2** |
| Search filters | Scope search to a project, a kind, or a date range with prefixes (`p:snyvi kind:diff`). | S | **done 0.2** |
| Delete a document from the UI | With confirmation. Prune covers bulk; users still want to remove one. | S | **done 0.2** |
| Rename workflow and project | Session-derived titles are guesses; let the user fix them inline. | S | **done 0.4** |
| Tags from the sender | `send_document(tags: ["review"])`, filter chips in the sidebar. | S | later |
| Unread state persisted | Badges survive restarts. | XS | later |
| Archive a project | Hide finished projects from the tree without deleting. | S | later |
| Export | Copy as Markdown, print stylesheet polish, save as PDF via print. | S | maybe |

## C. Agent integration

| Feature | Why | Cost | Status |
|---|---|---|---|
| Desktop notification on arrival | When the window is not focused, a system notification with the title; click to open. `notify-send` on Linux, a PowerShell toast on Windows, osascript on macOS. | S | **done 0.2** |
| `snyvi watch FILE` | Re-send a file whenever it changes on disk, for editors and agents that have no hooks. Uses the same coalescing as the hook. | S | **done 0.4** |
| Other agents | Config snippets for Codex CLI, Gemini CLI and Cursor: all speak MCP, so it is docs plus an `init` subcommand per tool. | S | later |
| Claude Code skill file | A `/snyvi` skill that teaches the model when to send and how to phrase the link, installed by `init-claude`. | XS | later |
| Per-project opt-out | `.snyvi.toml` in a repo with `collect = false` so the hook never sends from that project. | XS | later |

## D. Desktop

| Feature | Why | Cost | Status |
|---|---|---|---|
| Remember window size and position | Basic expectation of a native app. | XS | **done 0.2** |
| Tray icon | Summon the window from anywhere; the daemon is resident anyway. Closing the window hides it instead of quitting, so reopening costs nothing. | M | **done 0.7** |
| Global shortcut | The other half of the tray item: summon the window without finding the tray first. Wants a key that is free on every desktop, which is the part that is not obvious. | S | later |
| Packages | `.deb` for Debian and Ubuntu, built for both architectures by the release workflow: the CLI, an application menu entry and a systemd user service, depending on nothing because the binary is static. AppImage, AUR and a Homebrew tap remain. | M | **done 0.4** |
| Ship the native window | The Tauri window existed but no release contained it: the release builds are static musl, and WebKitGTK cannot be linked into those. A second `snyvi-desktop` package carries it, with its dependencies read out of the binary. | M | **done 0.5** |
| Desktop package for arm64 | amd64 only so far. The arm64 runners are 24.04, so the package would record a glibc baseline excluding everything older; it wants its own oldest-host runner. Cheaper since 0.6: only the 4 MB window carries that baseline, and snyvi itself is static on both architectures already. | S | next |
| Split the window into its own binary | The desktop package was one binary, so `snyvi serve` carried the linked engine with no window open: 66 MB against the static build's 34 MB. `snyvi-app` is now the window alone, and an add-on that depends on snyvi rather than replacing it. Daemon back to 35 MB, and the install stops being a choice. | M | **done 0.6** |
| Windows | One zip with both executables, because there is no static/dynamic fork to make: snyvi.exe links no engine and the window uses WebView2, which ships with the OS. The daemon, CLI, MCP server and hook all needed a platform layer first -- opening a URL, raising a notification, ending a process, starting detached. | M | **done 0.7** |
| macOS build | Tauri and the plain build both work on macOS; add it to the release matrix. Cheaper since 0.7: the platform layer already has the macOS path for notifications and for opening a URL, so what is left is the matrix leg and a .app bundle. | S | later |
| AppImage | Measured before choosing: bundling WebKitGTK and its closure is 196 MB raw, 73 MB compressed, so the AppImage is ~80 MB against a 15 MB budget — 13x the `.deb` that does the same job by asking the distribution for webkit. It also puts nothing on `PATH`, which is where `snyvi send` has to be for the hook and the MCP server to call it. Not worth it for this shape of program. | M | **no** |

## E. Speed and hardening

| Feature | Why | Cost | Status |
|---|---|---|---|
| Content-Security-Policy header | The UI page has no CSP yet. Scripts and styles come only from the daemon; say so. | XS | **done 0.2** |
| Virtualised rendering above ~200k lines | Chromium copes up to about 100k lines with `content-visibility`; beyond that, page the lines from the server on scroll. | M | later |
| Token rotation | `snyvi token --rotate` for when a token leaks into a log. | XS | later |
| CI on a 2-core runner profile | Budgets are scaled by a factor today; a fixed small-machine profile would make numbers comparable release to release. | S | later |

## Explicitly not planned

- Editing. snyvi is a viewer; "open in editor" is the whole editing story.
- Streaming or in-place document updates. Immutability is what keeps it fast and simple.
- Reading documents back into the agent. The channel is one-way by design.
- Hosted multi-user mode, until the local tool has real users asking for it.

## 0.2 (built)

Mermaid, side-by-side diff, find in document, images, file history, one
workflow per session, search filters, delete from UI, desktop
notifications, remembered window geometry, CSP header.

## 0.3 (released)

The rail now carries a code outline, taken from the highlighter's own
parse so it follows the grammar rather than guessing. Ordering also
learned a tiebreaker: `received_at` counts whole seconds, so two
documents arriving together used to sort arbitrarily and "compare with
previous" could skip one.


`snyvi stop` and `snyvi restart`, plus a warning when the running daemon
is older than the binary you just invoked, so upgrading is one command.

`snyvi browse <dir>`: read a folder straight from disk, rendered on
demand, nothing persisted and nothing in the inbox. Chosen over bulk
import into the library, which would have flooded the inbox, the one
screen that answers "what did my agents produce".

Browsing a repository all day turned up three gaps that browse mode made
obvious, all now closed: the library mangled any file that was not text,
`.html` and `.pdf` could only be read as source, and a `.csv` was a wall
of commas.

## 0.3.2: layout after real use

Screens from a real repository showed the seams where new view types met
layout rules written for prose:

- Previews and tables were held to the reading measure, so a dashboard
  built for 1400px rendered in 660px. Everything that is not prose now
  takes the pane.
- Every embed brought its own scroll region inside a page that also
  scrolled. One scroll region per screen now.
- Table cells never wrapped, so descriptions were cut mid-word. Columns
  wider than 44 characters are treated as prose and wrap; identifier and
  numeric columns stay rigid.
- The rail clipped long folder names and heading titles.
- A leading H1 was only dropped when it matched the title, so a document
  whose own heading differed showed two headings.
- Workflow keys were case-sensitive, so "KSI pivot" and "ksi pivot" were
  two workflows. Keys now fold case, and existing duplicates merge on
  first run.
- Hiding the sidebar collapsed the document pane: the grid named its
  areas but never assigned the panes to them, so a hidden sidebar left
  the grid and everything shifted into the zero-width column.

New: `w` maximises width, overriding the reading measure for prose.

## 0.4 (never cut; folded into 0.5)

Watching, both ways. In browse mode the file on screen refreshes when it
is saved and the tree follows files being added or removed, with the
scroll position, find and preview kept. `snyvi watch FILE` sends a file
on every save for editors and agents without hooks, and its sends
coalesce with the hook's.

One mechanism serves both: the daemon stats what a reader has on screen
a few times a second, only while a tab is connected, and acts once a
change has held for a tick. Chosen over inotify because the set is tiny,
no debounce is needed on top, it costs the same on a repository of any
size, and it needs no dependency in the static build.

An overwritten document (a coalesced hook or watch send) now refreshes
in place if it is open rather than being treated as a new arrival, so a
file being saved every few seconds no longer steals the reader's
position or raises a toast each time.

Also in this cut: a `.deb`. `dpkg -i` installs `snyvi` on the path, an
application menu entry that opens the viewer in its own window, and a
systemd user service for people who would rather the daemon were resident
from login than started by their first send. It declares no dependencies, which a static binary has earned, and
on an upgrade it says the one thing that is easy to miss: the daemon
keeps running the old binary until it is restarted.

`packaging/deb.sh` builds it from an already-built binary using nothing
but `dpkg-deb`, so packaging adds no crate to the build and can be run by
hand. CI builds and installs the package on every push, because a script
that only runs at release time is broken exactly when it matters.

Lines became addressable. A code or text document opens at `#L120`, or at
`#L120-L140` for a range, with the lines marked while they are read rather
than flashed once, so a link from an agent lands on something visible. A
click on a line number writes that link and copies it, shift-click extends
it to a range, and ⌘K takes `:120` for the same jump from the keyboard.

`z` wraps long lines. Continuations hang past the line numbers so the code
still lines up, which needed the gutter width to exist in one place; the
rule that was meant to remove the inset on code documents had been losing on
specificity since it was written, so the numbers now line up with the title
above them as intended.

Names can be corrected. A project is named after the directory it was
detected in and a workflow after the first document its session sent,
which are guesses that are often wrong and, until now, permanent. Hover
either in the sidebar and a pencil appears; the label becomes a field in
place, Enter keeps what was typed and Escape abandons it.

What is underneath is untouched: a project is still identified by its
root and a workflow by its key, so what arrives next lands where it did.
That left one thing to settle. The derived project name refreshes on
every send, so a rename would have been undone by the next document; a
project named by hand now says so, and the derived name stops reclaiming
it. A workflow needed none of this — its title was only ever written
once.

The rename reaches the open document too, not just the tree: its header
and the rail name its project and workflow, and both follow without
moving the reader off the line they were on.

This cut goes out without the JSON and YAML views it had been holding a
place for. They were never started, and a cut that waits for everything
named in it stops being a cut, so they move to the next one.

## 0.5 (released 2026-09-12): the window ships

The native window has existed since 0.2 and no release has ever contained
it. The release builds are static musl binaries, and a WebKitGTK window
cannot be linked into one, so `snyvi app` from a package has only ever
opened a browser.

`snyvi-desktop` is that build, packaged: the same snyvi with the window
compiled in, dynamically linked against the distribution's webkit and gtk.
Its dependencies are read out of the binary by `dpkg-shlibdeps` rather
than written by hand, so the package cannot claim a glibc baseline the
build did not have — and it is built on the oldest release it supports so
that baseline is as low as it goes. It conflicts with and replaces the
static package, since both own `/usr/bin/snyvi`; dpkg swaps one for the
other in a single `apt install`, in both directions.

CI builds the package, installs it with apt so the declared dependencies
have to resolve, and opens the window from the *installed* copy under
Xvfb — because the thing that was wrong for four releases was never the
window, it was that nothing shipped it.

The cost is now measured rather than assumed, and it is in the README
beside the static build's: 15.6 MB against 12.3 MB, ~380 MB resident with
the window open, ~150 ms before the web process exists. Three of the
budgets in BRAINSTORM section 1 do not survive a browser engine and never
will. They were written for one static binary; that binary still meets all
of them, and the desktop build is a second artifact with a second budget.

AppImage was considered for the same job and measured first: ~80 MB, a
FUSE dependency, and nothing on `PATH` for the hook to call. The `.deb`
does the same work in 6 MB by asking the distribution for the engine.

## 0.6: the window becomes an add-on

0.5 shipped the window, and shipped it as a fork in the road: two
packages, `snyvi` and `snyvi-desktop`, that conflicted with and replaced
each other. Someone arriving at the releases page had to understand a
trade between a static binary and WebKitGTK before they could install
anything, and picking wrong meant starting over. On arm64 the window was
not offered at all.

It is one product again. `snyvi` is the static binary, every
architecture, no dependencies — that is what you install. `snyvi-app` is
the window executable alone, 4.3 MB, and it *depends on* snyvi instead of
replacing it. Install it whenever, or never; `snyvi app` takes the best
window it can find and says what would give it a better one.

The engine moved with it. Before, linking WebKitGTK into snyvi linked it
into the daemon, the MCP server and the hook as well, and `snyvi serve`
sat at 66 MB having never opened a window. It is 35 MB now in every
configuration, and the engine is resident only while a window is.

The window binary needs nothing from the crate — it is handed a URL on
argv — so this cost no lib target and no shared state: two `[[bin]]`
targets, one of them behind `required-features`. `desktop.rs` lost its
`#[cfg]` fork entirely, because a build without the window and a machine
without it installed are now the same case.

CI checks the thing that would undo it: `ldd` must show no webkit in
snyvi and webkit in snyvi-app. It then installs them the way a person
does — snyvi alone first, confirming the browser fallback says what to
add, then the add-on, confirming snyvi survives it and the native window
opens.

## 0.7: Windows, and a tray

snyvi ran on Linux and nowhere else, though almost none of it was about
Linux. Six places asked the operating system directly -- opening a URL,
raising a notification, ending a process, starting the daemon detached,
knowing whether there is a screen, and what an executable is called --
and those are now one module that asks whichever machine it is on,
through a program that machine already ships. Nothing new is depended
on to do it.

Windows is one job and one zip. The split that Linux needs -- a static
binary that cannot link WebKitGTK, and a window package that can -- has
no counterpart there: `snyvi.exe` links no engine, and `snyvi-app.exe`
uses WebView2, which is part of Windows 10 and 11. So both are built
together, both ship together, and installing the window is not a second
decision. CI builds it, runs the tests, holds the daemon to the same
perf budget, and opens the window through `snyvi app` -- because the
piece that is new is the lookup, which now has to find a name ending in
.exe.

Two things were found on the way rather than ported. The write token
came from /dev/urandom with a fallback that hashed the clock and the
pid; on Windows that fallback would have been the only path, and a
token derived from the time and a process id is one a program on the
same machine can search for. And `init-claude` spawned `claude` by
name, which on Windows is a .cmd shim that CreateProcess will never
find.

The window gained a tray, on both platforms. Closing it hides it: a
viewer for what your agents are producing is a thing you close and
reopen all day, and paying ~150 ms for a browser engine each time was
the wrong trade. The menu is two items, show and quit, because the
library and the daemon belong to `snyvi` itself. Hiding also made
`snyvi app` a likely thing to type twice, so the window is
single-instance now: the second one hands its URL to the first.

A tray is an addition rather than a precondition. On Linux it is
dlopened, not linked, so a desktop without libayatana-appindicator has
none -- and there the window must still open, with closing back to
meaning close, or snyvi would be running with no way back to it. That
dlopen is also the one dependency in the add-on package not read out of
the binary by dpkg-shlibdeps, which cannot see a library nobody links;
CI checks the hand-written name against the string the binary loads.

And the mark is finally drawn rather than scaled. It existed as an SVG
favicon and one 256px PNG, and everything smaller came from something
downsampling that -- a 7.5% stroke is 1.2px at 16px, which is grey
mush exactly where the icon is seen most. Every size is now drawn for
itself, with the small ones snapped to the pixel grid and deliberately
bolder, out of one generator so the tab, the taskbar and the tray
cannot drift apart. Windows gets a real .ico of bitmaps, since a PNG
entry is only documented to work at 256.

## 0.7.1: the icon nobody could see

0.7 drew the mark at every size and installed all of them, and on Ubuntu
the window still came up generic. The icon was never the problem: the
shell finds an icon by first matching a window to a desktop entry, and
it matches on the window's class. Tauri leaves the GTK application id
unset unless `enableGTKAppId` is on, so GTK falls back to the program
name and the window announces itself as `snyvi-app` — which matches no
file called `snyvi.desktop`. `StartupWMClass=snyvi-app` in the entry is
the line that connects them.

Nothing could have caught it. `desktop-file-validate` saw a valid file,
the window opened, CI proved the package installed and held the
foreground, and the two ends of the match live in different files that
were each correct alone. So CI now reads `WM_CLASS` off a real window
under Xvfb and checks it against the entry, rather than trusting either.

The tray was a second, unrelated miss in the same report. The package
depends on `libayatana-appindicator3-1`, which is the library, and on
GNOME the library is not sufficient: GNOME has no tray, so the indicator
is published on the bus and nothing draws it. The extension that draws
it is now a `Recommends` — not a `Depends`, because KDE, Xfce and
Cinnamon have a real tray and should not be made to install a GNOME
extension for nothing.

Both were found by installing the release and looking at it, which is
what "argued for, not yet watched" below was about. It was written for
Windows and turned out to be true of Ubuntu.

## Candidates after 0.7

JSON and YAML views, tags from the sender, macOS build, AUR, the global
shortcut the tray item was half of, arm64 for the Linux window add-on.

Release hygiene: v0.5.0 is the first release ever cut, and its
first run exercised everything that had only been proven by proxy: the
tag trigger, both architectures of the static matrix, the upload of two
jobs onto one release, and the desktop job appending to it. Twelve
assets, every one of them checksummed. The shipped desktop `.deb`,
built on 22.04, was then downloaded, verified against its checksum,
installed on a 24.04 host and opened its window from `/usr/bin/snyvi`.

One thing the first run showed that CI could not: both static legs asked
for release notes, so each appended a copy and the body carried the
changelog line twice. Only the amd64 leg authors notes now.

What still has to come from a machine with tag permission is the tag
itself. `workflow_dispatch` and tag pushes both return 403 for an agent
session's token, which writes commits and nothing else. So a release
is one command, from a person:

```
git tag -a v0.7.0 -m "snyvi 0.7.0" && git push origin v0.7.0
```

with `Cargo.toml` bumped first, since the workflow reads the version
from the tag and Tauri reads it from `Cargo.toml`.

That last line is there because v0.6.0 was first pushed without it. The
tag went onto a commit from a clone that had not fetched the work the
tag was naming, whose `Cargo.toml` still said 0.5.0, and the run
rebuilt the previous release under the new name. Nothing downstream
could catch it: the workflow was right about the tag, the crate was
right about its manifest, and they disagreed. Since 0.7 the release
refuses to build when they do -- the first step of the first job, so a
mismatch costs seconds rather than twelve assets.

## Not yet proven on Windows

The build, the tests, the daemon and the window are all exercised by CI
on a Windows runner. What no runner shows is a desktop in use: the
toast, the tray's click behaviour, and how the window looks at the
display scalings Windows actually ships with. Those are argued for, not
yet watched.

## Still no purpose-built view

JSON and YAML (highlighted source only) and Jupyter notebooks (raw JSON
rather than cells). Notebooks are the most work and the least common in
this context.
