# snyvi roadmap

Two rules decide priority: does it make reading more beautiful, and does it
keep everything instant. A feature that serves neither waits.

Status key: **done 0.2**, **next**, **later**, **maybe**, **no**.

## A. Reading experience

| Feature | Why | Cost | Status |
|---|---|---|---|
| Mermaid diagrams | Agents put flowcharts and sequence diagrams in almost every plan. Today they show as code. Vendor the library in the binary, load it only when a page has a `mermaid` block, render after first paint so text never waits. | M | **done 0.2** |
| A big diagram you can read | A 20000-unit flowchart fitted into the reading column drew 30 px tall: the one diagram worth drawing was the one nobody could read. Each is a viewport now — ⌘/ctrl + scroll zooms toward the cursor, drag pans, `f` fills the screen, `0` fits — driving the SVG's own `viewBox`, so strokes stay crisp and nothing is scaled twice. `docs/DIAGRAMS.md` phase 3. | M | **done 0.9** |
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
| The rail follows the reader | The contents were marked and never moved: on a plan with 46 headings the marker left the visible rail at section 4 and stayed gone, the actions under the contents were a scroll away, a wheel over either pane reached nothing, and a click on an entry added a history entry that Back turned into a rebuild at the top. Contents and actions scroll apart, the marker is kept in view, a wheel the pane cannot use goes to the document, a jump is instant and lands. | S | **done 0.11** |
| A refresh keeps the place | A watched file saved while it is being read swapped the body and restored a pixel offset into blocks that were still 60 px placeholders: the reader landed 57 paragraphs from where they were. The place is a block and an offset into it now. | S | **done 0.11** |
| Section links | The `#` beside a heading was rendered `inert` and drawn outside a box that paint containment clips to, so it existed in the markup and nowhere else. It is a link now: a click writes the section into the URL and the clipboard, the way a line number does, and the contents write the same slugs. | XS | **done 0.11** |
| Contents on a narrow window | Below 1100 px the rail is gone and `t` does nothing; below 760 px the sidebar is an overlay with no backdrop, no tap-outside and no Escape. Each becomes a sheet over the document, opened by its key. | S | next |
| Back returns to where the reader was | A document opened again through Back opens at the top. Keep the place in the history entry, the way a refresh now keeps it. | XS | next |
| Focus mode | `f` hides both panes and centres the text. One keystroke, but most of it exists via `\` and `t`. | XS | maybe |

## B. Library and organisation

| Feature | Why | Cost | Status |
|---|---|---|---|
| File history | Every snapshot of the same path across workflows, newest first, with diff between any two. Today versions are only visible inside one workflow. | M | **done 0.2** |
| One workflow per Claude Code session | Hook sends and MCP sends from the same session land in two workflows because the MCP server cannot see Claude's session id. A `SessionStart` hook can record `cwd → session` in the config dir; the MCP server reads it. Result: one workflow per session, titled from its first document. | S | **done 0.2** |
| Search filters | Scope search to a project, a kind, or a date range with prefixes (`p:snyvi kind:diff`). | S | **done 0.2** |
| Delete a document from the UI | With confirmation. Prune covers bulk; users still want to remove one. | S | **done 0.2** |
| Delete with undo instead of a dialog | The confirmation is `window.confirm`, which the native window draws as the toolkit's dialog in the toolkit's theme. Delete at once and offer "Undo" in the toast for eight seconds, over a soft delete that prune makes final. | M | next |
| Arrivals that come in a burst | Each arrival is a toast and nothing caps them: an agent that writes twelve files stacks twelve. Past three in a few seconds, one toast that counts. | XS | next |
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
| Open a terminal here | A document that says what to do next means leaving snyvi and re-finding the directory. A button opens the machine's own terminal with its working directory set to the document's, or the browsed root's. It passes no command, so nothing a document contains ever reaches a command line. `docs/TERMINAL.md`. | XS | **done 0.8** |
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
| A sidebar that does not carry the library | `Store::tree()` returned every document there was, and the shell embeds what it returns in every page it serves: 383 KB and 13,213 rows at 3000 documents, with one 362-718 ms task building them before the reader could do anything, and the same cost again on every arrival. A project row is two numbers now and what is behind it is fetched when it is expanded. | M | **done 0.9** |
| Virtualised rendering above ~200k lines | Chromium copes up to about 100k lines with `content-visibility`; beyond that, page the lines from the server on scroll. | M | later |
| Token rotation | `snyvi token --rotate` for when a token leaks into a log. | XS | later |
| Size, start-up and memory in the bench | The README's binary size, cold start and resident rows were hand-measured and enforced by nothing, and had drifted. `snyvi bench` starts a daemon of its own and budgets all three, with sends and a page's first byte beside them. | S | **done 0.10** |
| CI on a 2-core runner profile | Budgets are scaled by a factor today; a fixed small-machine profile would make numbers comparable release to release. | S | later |
| The UI's behaviour in CI | Every fault in 0.11 was found by driving Chromium against a daemon and measuring: where the marker was, what a wheel moved, what Back did. Those probes belong beside the browser bench, run on every push, so the rail cannot quietly stop following again. | S | next |
| Keyboard and screen-reader pass | The palette and the help box trap no focus and return it nowhere; the find count is not announced; hover-only controls (copy, rename, the `#`) have no equivalent under a finger. One pass, with the checks kept. | S | next |

## Explicitly not planned

- Editing. snyvi is a viewer; "open in editor" is the whole editing story.
- Streaming or in-place document updates. Immutability is what keeps it fast and simple.
- Reading documents back into the agent. The channel is one-way by design.
- Hosted multi-user mode, until the local tool has real users asking for it.
- A terminal or a command runner inside snyvi. A viewer that runs what a document told it to run is a one-click path from agent-written content to a side effect on the reader's machine, and it turns a leaked write token from a nuisance into code execution. `docs/TERMINAL.md` has the argument and what is built instead.

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

## 0.8: diagrams that read, and a way out of the viewer

Two documents had been written and neither had any code behind it. This
cut is both of them.

**Diagrams are drawn once per tab.** `docs/DIAGRAMS.md` phase 2a: a
diagram is a pure function of its source and the theme and a stored
document never changes, so the 2426 ms the 220-node flowchart cost on
every revisit was being spent re-computing an answer the tab already had.
A whole document now comes back in 34 ms with no call into the renderer
at all, and `snyvi watch` stops redrawing on every save. Three things it
wanted beyond the twenty lines the plan estimated: a source that will not
parse is remembered too, so no source is handed to Mermaid twice; the id
is not part of the drawing, so what is cached carries a token where the
id was; and a bound in bytes rather than entries, since one diagram's SVG
is two orders of magnitude larger than another's.

**And they are drawn in snyvi's own palette.** Section 9 of the same
document, which is the other question this roadmap asks of everything:
not whether it is instant but whether it is beautiful. Until now a
diagram arrived with `#eeeeee` nodes and `#999999` strokes on paper that
is `#faf9f6`, and in dark mode every edge label sat on a grey swatch
matching nothing else on the page. The values are read off `:root` rather
than written out again, so a token changed in `app.css` moves the
diagrams with it. The theme toggle no longer leaves drawn diagrams
behind, which the cache above made a three-line fix rather than a
project.

The check is the part worth keeping. The harness reads the colours back
off real renders of every diagram family in both themes, finds what is
actually behind each label, composites alpha, and holds the worst
contrast in each diagram to 3:1. It found two faults in dark that would
have shipped: a focus node whose label measured 1.0:1 — the same colour
twice — and a gantt chart drawing "Scheduler" at 1.4:1 on its own bar.

**A terminal, the reader's own.** `docs/TERMINAL.md`, which is mostly an
argument for what is *not* being built: an embedded emulator and a "run
this block" button are both declined, and the reasons are written down so
the question arrives answered. What landed passes no command at all. A
button opens the machine's terminal in the folder the reader is looking
at — the document's own, or its project's root when it was sent as
content rather than as a path, or a browsed folder's. The page sends an
id and never a path; the daemon resolves the directory itself.

It also brought snyvi its first `Origin` check, and the plan was wrong
about why. It had said "the token and an Origin check" — but the page has
no token, and should not have one, so the gate is the origin with the
token accepted beside it for the CLI. That is the header that matters
here anyway: the threat to a loopback side effect is a page on another
origin firing a POST at it, not a local process, which could open a
terminal without asking snyvi.

## 0.9: the library gets big

Everything measured until now was measured on a library with two
documents in it. A reader with months of agent sends reported that snyvi
took a moment to open, and that is where it was: not the daemon, which
answers a page in a millisecond, and not the renderer, but the sidebar.

`Store::tree()` returned every document in the library and `shell_doc`
embedded it in every page. At 3000 documents that is a 383 KB page,
13,213 rows in the sidebar and a 362-718 ms task building them before the
reader can scroll or type — on a fast machine, headless. An arrival paid
it again, because the `doc` event refetched the whole tree and rebuilt the
sidebar, so a file being saved every few seconds cost that every few
seconds.

A project row now carries two numbers instead of its contents. Same
library, same page:

|  | before | after |
|---|---|---|
| shell page | 383 KB | 24 KB (18 KB of it the inbox's 50) |
| `/api/tree` | 360 KB | 920 B |
| sidebar nodes | 13,213 | 461 |
| longest boot task | 362-718 ms | 0 ms |
| load event | 446-815 ms | 52-88 ms |
| an arrival | 360 KB and a rebuild | 13 KB, no long task |

An expanded project shows its ten most recent sessions with their ten
newest documents and says how many more there are; clicking that asks for
the rest, whole. Two things stay exact: the workflow a reader is in always
arrives complete, because `[` and `]` step through the versions of a
document and a cap there would stop them somewhere arbitrary; and a cap a
reader has lifted is put back after a refetch rather than closing under
them.

**Mermaid is fetched before the reader reaches a diagram.**
`docs/DIAGRAMS.md` phase 4's first item. The first diagram on a page cost
1170 ms, and 490 of those were one unbreakable task compiling 3.57 MB of
JavaScript that nothing asked for until a diagram came near the viewport
— the worst moment to begin, since the reader has arrived and is waiting.
A page that holds a diagram now asks for the library in idle time: 783 ms
to the first diagram, and the compile is spent while the first screen is
being read. Beside it, the bundle's URL finally carries a version: it was
being served immutable for a year, so a browser would have kept the first
Mermaid it ever saw across every upgrade — and the trimmed bundle that
phase 4 wants next could never have replaced it.

Two faults found on the way, both worth writing down:

- **A `<details>` created with `open` fires `toggle` in Chrome.** The
  first lazy sidebar rebuilt the tree from that event, which created the
  element that fired it, and the two rendered each other for as long as
  the tab was open. The page never fired its load event at all — and
  `bench/browser.mjs`, which waits for one, hung rather than failed.
  Opening a project now writes that project's own list and nothing else.
- **The browser harness had no floor under that wait.** It has one now,
  and the message names what to look for. A benchmark that hangs is worse
  than one that fails: the failure is what tells you the thing is broken.

`bench/browser.mjs` also seeds a library of its own now — four projects,
more sessions than a project shows, and a session with more documents
than it shows — and budgets what the sidebar puts in the page: rows on a
first visit, rows with one project open, the shell's size, and renders
after it has settled. Counts rather than clocks, because what a row costs
the page is a fact about snyvi on any machine.

**And a big diagram is worth drawing.** `docs/DIAGRAMS.md` phase 3, the
last thing that document had measured and not fixed: the 220-node
flowchart is 20023 units wide and was drawn 30 px tall, because
`max-width: 100%` fitted its width into the reading column and
`height: auto` took the height down with it.

A drawn diagram is a viewport now. ⌘/ctrl + scroll zooms toward the
cursor and a trackpad pinch arrives as the same event; a plain scroll is
still the page's, so a cursor crossing a diagram never traps it. Drag
pans, double-click zooms in, `0` fits, `f` fills the screen, and the
figure carries its own controls, shown when it is under the cursor. It
drives the SVG's `viewBox` rather than scaling a picture: the browser
draws the same vectors into a different box, so strokes stay crisp at any
depth and a frame costs nothing per gesture.

Two things the plan did not know, both found by measuring:

- **A fit can be too small to be a diagram.** That flowchart fits the
  column at 3.8% of itself, which draws a band of grey noise. Under about
  15% a diagram opens at its own size instead, at the corner the graph
  starts in, and the button offers `Fit` rather than `100%`.
- **The live `viewBox` is not the diagram's bounds.** Panning writes it,
  so re-fitting after a resize or a fullscreen read the reader's own view
  as the whole graph and could never find its way back out. The bounds
  are kept on the element; the attribute is only ever the view.

`bench/browser.mjs` drives the gestures rather than the functions — a
check that called them directly would pass with nothing listening — and
clicks fullscreen through the protocol, because the browser grants that
to a real click and to nothing else.

Also: `ensure_daemon` asked a starting daemon for its health every 40 ms
while a daemon comes up in about 25, so a cold `snyvi app` waited about
twice as long as it needed to. 51 ms to 25-28 ms for a cold start and
send.

## 0.10: the numbers nobody was checking

The README's table had three rows that no test stood behind: the size of
the binary, how long a daemon takes to come up, and what it holds
resident. They were measured by hand when they were written and never
again, and `snyvi bench --check` — the thing that is supposed to make a
budget a test — measured the renderer in process and nothing about the
process a reader actually runs.

It does now. The bench starts a daemon of its own, on a free port with a
temporary directory, so it can be run on a machine with a library in use
and touch nothing; weighs the binary it is running as; starts that daemon
three times and keeps the best; sends three documents by path, the way
the hook does; fetches a page; and reads the daemon's resident set twice.
The clocks scale with `SNYVI_BENCH_FACTOR` like the render rows; a size
and a resident set do not, because they are not clocks.

|  | table said | bench reads | budget |
|---|---|---|---|
| binary size | 12.3 MB | 12.4 MB | 15 MB |
| cold start to first health | 25-28 ms | 11-14 ms | 100 ms |
| send, 100 KB, round trip | ~50 ms | 12-14 ms | 100 ms |
| document page, first byte | 3-5 ms | 1-2 ms | 30 ms |
| resident, documents in | 35 MB | 40 MB | 60 MB |
| resident, after the big fixtures | 50 MB | 82 MB | 100 MB |

The first run of the resident row read 62 MB, over the 60 MB budget that
`docs/BRAINSTORM.md` set for one document. Finding out why was most of
the work, and the answer changed the daemon:

- **Freed memory was handed back ten seconds late.** A render runs on one
  of tokio's blocking threads. mimalloc gives a thread's freed pages back
  to the system the next time that thread touches the allocator, and an
  idle thread never does — and tokio kept an idle blocking thread for ten
  seconds. So a 1 MB document left the daemon at 84 MB for ten seconds
  after it had answered, and 42 MB the moment the thread retired. The
  runtime now retires a blocking thread after one second. The next render
  starts a thread, which costs microseconds beside a render; a burst of
  sends inside a second shares one.
- **A request body is capped at 2 MB.** `snyvi send FILE` is unaffected,
  since the daemon reads a path itself, but `snyvi send < FILE` carries
  the bytes and is refused above that with a 413. The bench sends by
  path. The cap is not changed here; it is written down.
- **A page fetched while the render thread is still alive keeps a dozen
  MB with the worker that served it**, and a further fetch a few more,
  and neither comes back on its own: 40 MB with three documents in and
  the thread retired, 52-56 MB when the pages were asked for in the same
  second, which is what a tab does on arrival. The bench reads the
  documents row before it fetches a page, so that it measures what
  documents cost; what a page leaves behind is the next thing here to
  find.
- **The 82 MB is mostly the full highlight of 100,000 lines of Rust**, not
  the 1 MB of Markdown: the code file alone settles at 75 MB, the
  Markdown alone at 38. What a full highlight leaves live — the grammar's
  regexes compiled on first use are the likely answer, since the syntax
  set is shared and keeps them — has not been measured, and the 100 MB
  budget holds the line at the measured number until it is.

The bench also found that the table was generous in the other direction:
a cold start is 11 ms, not 25, since `ensure_daemon` stopped over-waiting
in 0.9, and a send is 12 ms, not 50.

And its first run on the Windows runner went red on the cold start: 405 ms,
three times in a row, against the 300 ms the factor allows, with every
other row passing with room -- 22 ms for a send, 0.9 ms to a page's first
byte, and 20 MB and 31 MB by working set for the two resident rows, which
is a different accounting from Linux's resident set and not a smaller
daemon. Creating a process is the one row that is mostly the operating
system's, and on a hosted Windows VM it is the VM's, so that job runs the
bench with `SNYVI_BENCH_SHARED=1`, the switch `bench/browser.mjs` already
had for rows that measure the runner: the cold start is printed there and
not enforced, and the rest still is. What a cold start costs on a Windows
machine a person uses is not known, and belongs with the other things
"Not yet proven on Windows" below.

## 0.11: the rail follows the reader

A screenshot of a real plan in use -- 33 KB, numbered sections, three
levels of heading -- showed the rail scrolled by hand to reach "Pin" and
"Compare with previous" under a contents list that ran past the bottom of
the window, and the contents themselves cut off at the top. Driving
Chromium against a daemon with a 66 KB fixture of the same shape found
what a reader of that plan gets, and none of it was a style problem:

|  | before | after |
|---|---|---|
| contents, 46 entries, in a 1043 px pane | 1868 px, the actions under it at 1956 | scroll on their own; actions stay put |
| marker after reading to section 7 | off the visible rail, and from section 4 on | in view, kept there |
| 5600 px of wheel over the rail | document moved 0 px | document moved 5600 px |
| a wheel over the sidebar | nothing moved at all | the document |
| a click on an entry | +1 history entry; Back rebuilt the document at the top | 0 entries; Back moves within the document |
| the entry's heading, on landing | flush with the pane's edge | 28 px in, lit for a moment |
| a jump of 5000 px, smooth | stopped 1658 px short | lands, and is corrected two frames later |
| a watched file saved at 12,000 px in | reader moved from block 68 to block 125 | same block, same offset |
| the contents after `j` to the next document | still scrolled 400 px into the last one | at the top |
| `t` after a reload | rail back | rail as left |
| the `#` beside a heading | `inert`, and clipped out of existence | a link; click copies the section's URL |

Three of those have the same cause, and it is worth writing down because
it will come back. Every block of prose is `content-visibility: auto`
with a guessed height of 60 px until it comes near the screen, which is
what makes a 100k-line document scroll at all. But it means a pixel
position in the document is only true near where the reader is: a smooth
scroll aims at where its target was when it started and the blocks it
passes grow under it; a scrollTop restored into a freshly swapped body
counts placeholders, not paragraphs; and the browser's own scroll to a
fragment on load does the same. Anything that jumps now jumps
instantly, to an element rather than to a number, and puts itself right
two frames later; a refresh remembers the block under the top edge and
the offset into it. The `#` was a fourth victim: paint containment,
which comes with `content-visibility`, clips to the box, and the anchor
was drawn 1.2em outside it. Headings opt out.

Two more were one line each. A bare assignment to `scrollTop` honours
the pane's `scroll-behavior: smooth`, so every save of a watched file
glided the reader from the top back to their place; it is
`scrollTo({ behavior: "instant" })` now. And the wheel: the document pane
is a sibling of the two side panes rather than their ancestor, so a
wheel over a pane that had nothing to scroll had nowhere to chain to.
It chains to the document now, once the pane under it is at its end,
which is what the browser would do if the layout let it.

What moves: a document arrives with a 180 ms rise rather than a snap --
on a navigation, never on a refresh in place, which would blink on every
save. Rows in both trees and entries in the contents transition their
colour. A jump lights its heading for 700 ms. All of it is under the
same `prefers-reduced-motion` rule as before.

Also: the inbox row is a link rather than a div with a click handler, so
Tab reaches it; the active row and the current entry carry
`aria-current`; the panes' scrollbars are thin.

## 1.0: what done looks like

1.0 is not a feature. It is the point where a person can install snyvi on
the three desktops, a reader who has never seen it is not surprised by
anything it does, and every number the README quotes is a test that
would fail if it stopped being true. The bench already does the last of
these for the daemon and the renderer; 0.11 is the first time the
behaviour of the page was measured the same way, and it found eleven
faults in an afternoon. So the rule for what is left: nothing goes into
the 1.0 list that cannot be checked by a probe or a test, and nothing is
checked off without one.

Each phase is a release, in this order, because each one's probes are
what the next one is measured with.

**0.12: the chrome at every width, and by keyboard.** Below 1100 px the
rail is removed and `t` is dead; below 760 px the sidebar is an overlay
with no backdrop and no way out but its key. Each becomes a sheet over
the document, opened by its key or a button in the header, closed by
Escape or a tap outside, with the marker inside it. The palette and the
help box become dialogs that trap focus and give it back. The find count
is announced. Everything that appears on hover -- copy, rename, the `#`,
a code block's language -- is present under `(hover: none)`, as the
diagram tools already are. Probe: Tab from the top of the page reaches
every control; at 700 and 1000 px every key still does what the help box
says. Cost M.

**0.13: a read that never loses its place.** Back to a document opens it
where the reader left it, the way a refresh now does; the last heading
of a document becomes current when its section is shorter than the fold,
instead of the one before it; the browse path lands a fragment the way
the document path now does. Probe: read to the end, `j`, Back, same
block. Cost S.

**0.14: the library, in use.** Delete without a dialog: the document goes
at once and the toast offers "Undo" for eight seconds, over a soft
delete that `prune` makes final. Arrivals that come in a burst become
one toast that counts. Unread badges survive a restart. Probe: delete,
undo, the row is back; twelve sends in two seconds, one toast. Cost M.

**0.15: the three desktops.** macOS in the release matrix with a `.app`;
the Linux window on arm64; the global shortcut the tray item was half
of; and the Windows list under "Not yet proven on Windows" watched by a
person on a real machine, with the cold start measured there and the
bench's Windows budget set from it. Cost M.

**The gate.** `bench/ui.mjs` runs beside `bench/browser.mjs` on every
push and holds every row of the 0.11 table above, plus what 0.12-0.14
add; the README's tables carry no number the bench does not read; the
tables in this file have no row marked **next**; and `docs/BRAINSTORM.md`
is read once more against what shipped, so that the budgets it set and
the ones the bench enforces are the same budgets. Then the three
commands under "Release hygiene", from a person, and the tag says 1.0.0.

What 1.0 is not, so it is not waited for: editing, streaming, a hosted
or shared library, more than one reader. See "Explicitly not planned".

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
is three commands, from a person:

```
git fetch origin main
git show origin/main:Cargo.toml | awk '/^\[/{t=$0} t=="[package]" && /^version/'
git tag -a v0.7.0 -m "snyvi 0.7.0" origin/main && git push origin v0.7.0
```

The fetch is not ceremony and neither is naming `origin/main` on the tag.
A tag is a pointer to a commit, and the only commit worth naming is the
one the remote has; a local `main` that is behind — or a clone sitting on
another branch entirely — will happily take the tag and release the wrong
tree. Tagging the fetched ref by name means the tag cannot land anywhere
but where the work is, whatever the working copy is doing.

The middle line prints one number, and it has to be the one being tagged:
`Cargo.toml` must be bumped and merged before the tag, and that is the one
mismatch nothing can catch in advance — by the time the workflow compares
them, the tag exists and a run has been spent. It reads the `[package]`
table rather than grepping the file, because Tauri and its two plugins are
declared in long form — `[dependencies.tauri]` with `version = "2"` under
it — so a plain `grep '^version'` answers with four numbers, three of them
not the crate's.

All of that is there because v0.6.0 was first pushed without it. The
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
