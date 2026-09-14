# snyvi roadmap

Two rules decide priority: does it make reading more beautiful, and does it
keep everything instant. A feature that serves neither waits.

Status key: **done 0.2**, **next**, **later**, **maybe**, **no**.

## A. Reading experience

| Feature | Why | Cost | Status |
|---|---|---|---|
| Mermaid diagrams | Agents put flowcharts and sequence diagrams in almost every plan. Today they show as code. Vendor the library in the binary, load it only when a page has a `mermaid` block, render after first paint so text never waits. | M | **done 0.2** |
| A big diagram you can read | A 20000-unit flowchart fitted into the reading column drew 30 px tall: the one diagram worth drawing was the one nobody could read. Each is a viewport now — ⌘/ctrl + scroll zooms toward the cursor, drag pans, `f` fills the screen, `0` fits — driving the SVG's own `viewBox`, so strokes stay crisp and nothing is scaled twice. `docs/DIAGRAMS.md` phase 3. | M | **done 0.9** |
| What moves, moves once | The sidebar is rebuilt from state whenever the library moves, so an arrival's row appeared from nowhere, a read's row was just gone, and the bar over the document re-ran its rise for every arrival after the first. The page keeps the moment a row arrived or left and a rebuilt row resumes its animation at a negative delay, so an arrival washes once, a read closes its row where it was, an undo washes it back, and the count settles into a bar that stays. Reduced motion means none. | S | **done 0.15** |
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
| Contents on a narrow window | Below 1100 px the rail is gone and `t` does nothing; below 760 px the sidebar is an overlay with no backdrop, no tap-outside and no Escape. Each becomes a sheet over the document, opened by its key or a button in the header, closed by Escape or a tap outside, and the contents open on the current section. | S | **done 0.12** |
| Panes that resize | The sidebar was 264 px and every title in it was cut at 26 characters, three plans with the same first words among them. Both panes' edges drag, between a floor and a ceiling, by keyboard too, and the width is kept. | S | **done 0.13** |
| A diagram fills the screen from inside the page | In the Linux window's engine a figure of its own in the top layer drew every glyph as nothing, and came back the size of its placeholder until the next scroll. The figure is laid over the page and the document asks for fullscreen: the same in every engine, and the labels are drawn in that one. | S | **done 0.13** |
| Back returns to where the reader was | A document opened again through Back opened at the top. The place is in the history entry now, written as the reader leaves and after each scroll, the way a refresh keeps it; and alt+← is Back in the window, which had no way back at all. | XS | **done 0.14** |
| An arrival never takes the page away | An arrival opened itself whenever the page had gone 2.5 s without a scroll or a key -- which is what reading a paragraph looks like -- and with several agents sending, the document changed under the reader many times an hour, with no way back in the window and no trace of the new one once its toast was gone. Arrivals join a queue: a row in the sidebar, a mark in the tree, a bar above the document that counts, `n` to read down the line. The one place an arrival opens itself is an inbox with nothing waiting. | S | **done 0.14** |
| A link into a folder lands | `#L120` and a section link opened a document where they pointed and a browsed file at the top: the browse path rendered, scrolled to 0 and never looked at the fragment, so one agent's link into another's checkout landed nowhere. Both land now, the same way, past blocks that are still placeholders. | XS | **done 0.15** |
| Focus mode | `f` hides both panes and centres the text. One keystroke, but most of it exists via `\` and `t`. | XS | maybe |

## B. Library and organisation

| Feature | Why | Cost | Status |
|---|---|---|---|
| File history | Every snapshot of the same path across workflows, newest first, with diff between any two. Today versions are only visible inside one workflow. | M | **done 0.2** |
| One workflow per Claude Code session | Hook sends and MCP sends from the same session land in two workflows because the MCP server cannot see Claude's session id. A `SessionStart` hook can record `cwd → session` in the config dir; the MCP server reads it. Result: one workflow per session, titled from its first document. | S | **done 0.2** |
| Search filters | Scope search to a project, a kind, or a date range with prefixes (`p:snyvi kind:diff`). | S | **done 0.2** |
| Delete a document from the UI | With confirmation. Prune covers bulk; users still want to remove one. | S | **done 0.2** |
| Delete with undo instead of a dialog | The confirmation was `window.confirm`, which the native window draws as the toolkit's own dialog in the toolkit's theme, over a page it has nothing to do with, and which had to be answered before anything else could happen. `Del` now deletes at once and the toast offers "Undo" for eight seconds, or ⌘/ctrl Z; underneath it is a `deleted_at` column that every read of the library goes past through one view, and `prune` makes it final. | M | **done 0.15** |
| Arrivals that come in a burst | Each arrival was a toast and nothing capped them: an agent that writes twelve files stacked twelve. They are rows on the queue now, and the bar above the document says "12 waiting"; there is no arrival toast at all. | XS | **done 0.14** |
| Rename workflow and project | Session-derived titles are guesses; let the user fix them inline. | S | **done 0.4** |
| Tags from the sender | `send_document(tags: ["review"])`, filter chips in the sidebar. | S | later |
| Unread state persisted | The badge was a count per project in one tab's memory: a sibling document from the project being read left no mark, and a restart forgot the rest. Unread is a column now and the queue is a query on it, so it is the same in every tab and the window and survives a restart. | XS | **done 0.14** |
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
| A sound on arrival | Asked for, and declined by default: a sound is the one signal a reader cannot ignore by not looking. `SNYVI_SOUND=1` puts a sound hint on the desktop notification -- the channel that already knows the volume and do-not-disturb -- and a burst sounds once. Nothing in the page plays anything. | XS | **done 0.15** |
| Global shortcut | The other half of the tray item: summon the window without finding the tray first. ⌘⇧Space on a Mac, Ctrl+Shift+Space elsewhere -- a chord no desktop's own shell holds, which was the part that was not obvious -- shows the window, or hides the one in front. `SNYVI_SHORTCUT` names another key or none, since a global shortcut wins over any program's own. X11 only on Linux: on Wayland the window says so and the desktop's settings bind a key to `snyvi app` instead, which reaches the running window the same way. | S | **done 0.16** |
| The window is where a link opens | `send_document` answered with `http://127.0.0.1:7777/d/…` whatever was running, so a click opened a second viewer in a browser beside the window, and the desktop notification opened nothing at all. The window's page now says it is one when it opens its event stream, so the daemon knows for exactly as long as there is a window; `snyvi open`, `send --open`, `browse` and a click on the notification hand the URL to it and raise it, and the tool answers that the document is waiting in snyvi, with no link, when there is a window to wait in. | S | **done 0.15** |
| Packages | `.deb` for Debian and Ubuntu, built for both architectures by the release workflow: the CLI, an application menu entry and a systemd user service, depending on nothing because the binary is static. AppImage, AUR and a Homebrew tap remain. | M | **done 0.4** |
| Ship the native window | The Tauri window existed but no release contained it: the release builds are static musl, and WebKitGTK cannot be linked into those. A second `snyvi-desktop` package carries it, with its dependencies read out of the binary. | M | **done 0.5** |
| Desktop package for arm64 | Was amd64 only: the arm64 runners were 24.04, so the package would have recorded a glibc baseline excluding everything older. There is a 22.04 arm runner now, and the desktop job is a matrix over both, so `snyvi-app_<version>_arm64.deb` records the same baseline as amd64's. Only the 4 MB window carries it; snyvi itself was static on both architectures already. | S | **done 0.16** |
| Split the window into its own binary | The desktop package was one binary, so `snyvi serve` carried the linked engine with no window open: 66 MB against the static build's 34 MB. `snyvi-app` is now the window alone, and an add-on that depends on snyvi rather than replacing it. Daemon back to 35 MB, and the install stops being a choice. | M | **done 0.6** |
| Windows | One zip with both executables, because there is no static/dynamic fork to make: snyvi.exe links no engine and the window uses WebView2, which ships with the OS. The daemon, CLI, MCP server and hook all needed a platform layer first -- opening a URL, raising a notification, ending a process, starting detached. | M | **done 0.7** |
| macOS build | Two release legs, Apple silicon and Intel, each shipping `snyvi.app` with both executables inside: the window, which a double-click opens, and snyvi, which the command line is a symlink to. `snyvi-app` run with no URL hands over to the snyvi beside it, so the icon alone starts the daemon. Ad-hoc signed -- the signature Apple silicon requires, not the identity Gatekeeper wants, which takes a developer account -- so the README says how the first open goes. `packaging/app.sh`. | S | **done 0.16** |
| AppImage | Measured before choosing: bundling WebKitGTK and its closure is 196 MB raw, 73 MB compressed, so the AppImage is ~80 MB against a 15 MB budget — 13x the `.deb` that does the same job by asking the distribution for webkit. It also puts nothing on `PATH`, which is where `snyvi send` has to be for the hook and the MCP server to call it. Not worth it for this shape of program. | M | **no** |

## E. Speed and hardening

| Feature | Why | Cost | Status |
|---|---|---|---|
| Content-Security-Policy header | The UI page has no CSP yet. Scripts and styles come only from the daemon; say so. | XS | **done 0.2** |
| A sidebar that does not carry the library | `Store::tree()` returned every document there was, and the shell embeds what it returns in every page it serves: 383 KB and 13,213 rows at 3000 documents, with one 362-718 ms task building them before the reader could do anything, and the same cost again on every arrival. A project row is two numbers now and what is behind it is fetched when it is expanded. | M | **done 0.9** |
| A page gives its socket back | Every page holds one connection open for its event stream, and a browser allows six to a host over HTTP/1.1. A page on its way out kept its own until it was destroyed, so eight page loads in a row left eight streams behind, the pool ran out at six, and the next page did not load for 25 seconds. The stream is closed on the way out now and opened again by a page that comes back from the back/forward cache. Six *live* tabs still spend all six, which is a real limit and its own fix. | XS | **done 0.15** |
| Six tabs, six sockets | With the leak above fixed, six pages that are genuinely open still hold all six connections a browser allows to one host, and the seventh request from any of them waits. HTTP/2 would multiplex them and is not available to a plain `http://` origin, so the fix is one stream shared between tabs (a SharedWorker) or a poll that frees the socket between turns. Not felt yet: it takes six snyvi tabs at once. | M | later |
| Virtualised rendering above ~200k lines | Chromium copes up to about 100k lines with `content-visibility`; beyond that, page the lines from the server on scroll. | M | later |
| Token rotation | `snyvi token --rotate` for when a token leaks into a log. | XS | later |
| Size, start-up and memory in the bench | The README's binary size, cold start and resident rows were hand-measured and enforced by nothing, and had drifted. `snyvi bench` starts a daemon of its own and budgets all three, with sends and a page's first byte beside them. | S | **done 0.10** |
| CI on a 2-core runner profile | Budgets are scaled by a factor today; a fixed small-machine profile would make numbers comparable release to release. | S | later |
| The UI's behaviour in CI | Every fault in 0.11 was found by driving Chromium against a daemon and measuring: where the marker was, what a wheel moved, what Back did. Those probes are `bench/ui.mjs` now, beside the browser bench and on every push, so the rail cannot quietly stop following again. | S | **done 0.12** |
| Keyboard and screen-reader pass | The palette and the help box trap no focus and return it nowhere; the find count is not announced; hover-only controls (copy, rename, the `#`) have no equivalent under a finger. One pass, with the checks kept in `bench/ui.mjs`. | S | **done 0.12** |

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
"Not yet watched on Windows or macOS" below.

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

## 0.12: the chrome at every width, and by keyboard

The rule 1.0 set below: nothing goes in that a probe cannot check, and
nothing is checked off without one. So this release is two things, the
chrome and the probe of it, and the probe is `bench/ui.mjs`: the 0.11
measurements kept, beside `bench/browser.mjs` and run by CI on every
push, plus the rows for what 0.12 adds. Twenty-three rows, counts and
positions only, so every one is enforced on every machine:

| | reads |
|---|---|
| the rail, 1280 px | contents scroll on their own; marker in view at 60% and at the end; 5600 px of wheel over the rail moves the document; a wheel over the sidebar does; a click on an entry adds no history and lands 28 px in; Back moves to the previous section without a rebuild; a save keeps block and offset; `j` puts the contents back at the top; `t` survives a reload; a link to a section lands with the marker in view; the `#` writes the URL and moves nothing |
| narrow windows | at 1000 px `t` opens a 320 px sheet on the current section with focus inside, and Escape closes it; the button opens it and a tap outside closes it; an entry in the sheet goes to its section and closes; at 700 px `\` opens the sidebar the same way; a row in it opens the document and closes, and at 1280 px again both panes are back; `? / ⌘K w z t \ i j` do what the help box says at both widths |
| by keyboard | Tab from the top reaches every control, 66 stops; the palette and the help box keep focus in and give it back; the find count is a live region; copy, rename and the `#` are visible with no pointer to hover with |

What the chrome does now: under 1100 px the rail is a sheet over the
document, under 760 px so is the sidebar; `t` and `\` open the sheet
instead of changing the setting the wide layout keeps, two buttons at
the top of the page do the same for a finger, Escape or a tap on the
scrim closes it, and the contents inside open on the current section,
which the hidden pane could never scroll to. The palette and the help
box are dialogs: the page behind them is inert, Tab stays inside, and
whatever had focus gets it back. The help box has a close button and
the "? for keys" in the footer opens it, because a phone has neither a
`?` nor a pointer. Under `(hover: none)` the controls that appear on
hover are simply there. The find count is a polite live region.

What the probe found on the way, none of it visible from the code:

- The sheet's rules sat above the rule that gives both panes
  `display: flex`, at equal specificity, and lost. The first run read
  the rail still beside the document at 1000 px.
- The marker was an IntersectionObserver firing when a heading crossed
  a band 100 to 320 px below the top edge. A jump of a page or more can
  land with no heading in that band, and then nothing fires and the
  marker stays on the section the reader left -- or, on a fresh page,
  never appears: the sheet opened at 50% of the document with no
  current entry at all. Both rails now read every heading's position on
  the frame after a scroll, which headings can afford because they opt
  out of `content-visibility`. At the very end the last section is
  current even when it is shorter than the fold, which the plan for the
  next release had listed.
- Tab reached the copy button of a code block below the fold and the
  next Tab landed on the body, so the rail's entries were never reached
  by keyboard. The browser focuses an element inside a placeholder
  without bringing it on screen; the scroll that does, aimed through
  placeholders, overshoots by a screen; and a focused element that ends
  up inside a skipped block is blurred. A block with focus in it is
  never a placeholder again, and the scroll is applied twice, as
  `jumpTo` does.
- A table below the fold was a Tab stop, because as a placeholder it
  counts as a scroller, and stopped being one the moment it was laid
  out and fit, at which point the browser dropped the focus it had just
  given it. Tables opt out of `content-visibility` with the headings.
- Navigating from the sidebar overlay at 700 px used to set the wide
  layout's `data-side` to hidden, so a window widened afterwards had no
  sidebar. The sheet closes instead, and the row that widens the
  window back holds it.
- Headless Chromium has no pointing device and answers `(hover: none)`
  already, and the DevTools media emulation does not change that; the
  row asks for a touch screen instead, which is the case the rule is
  for.
- A wheel that takes the contents to their end is spent there, as it
  would be on any pane the browser chained itself; the next one moves
  the document. The row allows one wheel's worth.

## 0.13: the panes fit the reader

A screenshot of the library in use, in the window: a 264 px sidebar
with every title in it cut at 26 characters -- "Generation model
comparison: Op…" three times over, three plans with the same first
words -- and a report that a diagram filled to the screen showed its
boxes and none of its words, and came back blank until the page was
scrolled. The first was a width nobody had meant as a limit; the second
was two faults, and neither showed in Chromium.

Each pane's edge drags now, the sidebar's right and the rail's left,
between a width where the rows are still readable and one past which
the document would be the pane that does not fit -- 200 to 440 px and
180 to 400 -- with double-click for the default, the arrow keys for a
keyboard, and the width kept, applied by boot.js before first paint so
nothing jumps. The width is the custom property the grid already read,
so the sheet at 760 px, the wide layout's rules and the rail's own
scroll follow without a change.

The diagram was WebKitGTK, the engine of the Linux window. Driven under
Xvfb, a plain page with a bold word, a button, an SVG `<text>` and a
`foreignObject` went fullscreen as an element and drew none of them: the
rects stayed, every glyph went, and the button shrank to its padding,
so the glyphs had no width either. The same page with the document as
the fullscreen element drew everything; so did the element with the
DMA-BUF renderer off, or compositing off. The fault is the engine's
element fullscreen on its default path, and nothing in a page mends it
there; what a page can do is keep the figure out of the top layer. `f`
and the button lay the figure over the page from where it is, as a
fixed box, and the document asks the browser for fullscreen as a
courtesy that hides the browser's chrome where it is granted. The same
result in every engine, and the labels are drawn in this one.

The blank on the way back was `content-visibility: auto`. Leaving the
top layer put the figure back in the flow as a placeholder, and WebKit
did not read again whether it was near the viewport until the next
scroll, so the frame measured 0 × 0 and the fit that runs after
fullscreen returned early with the fullscreen's zoom still on it.
Chromium got this right for a click on the button only because 0.12's
focus handler had marked the block visible, and would have got it wrong
for `f`. A figure that has filled the screen is marked visible for
good: it is the one the reader is looking at.

The rows, in `bench/ui.mjs` beside the 0.11 and 0.12 ones, 32 in all:

| | reads |
|---|---|
| the panes' edges | a 120 px drag makes a 384 px sidebar and the document starts at 384; 600 more stops at 440; 440 after a reload; ArrowLeft makes 424 and announces it; double-click gives 264 and a reload keeps it; the rail goes from 232 to 332 and back |
| a diagram, filled | `f` makes the frame the window, the figure not in the top layer, the labels laid out; Escape gives back a fitted figure at column width with no scroll, the document where it was; the button does both |

`bench/webkit.py` reads the same two rows in WebKitGTK, off the pixels
for the first -- the label's box has ink in it -- since layout was what
said the labels were there when the screen said they were not. By hand
for now: the only runners with the engine are the ones that build the
window.

## 0.14: a read that is never interrupted

A report from use, with several agents sending: "I was reading a doc,
then another doc came and everything changed. It just showed the doc,
and I was not able to go to the previous one, and it did not ask."
Three faults, and all three were in the design rather than in the code.

The page opened an arrival by itself whenever the reader had gone 2.5
seconds without a scroll, a key, a click or a wheel and had nothing
selected. That is what reading a paragraph looks like. The rule was
written for a tab left open on another monitor, and it cannot tell
reading from absence; with three agents finishing at once it guessed
wrong many times an hour. There was no way back in the window, which
has no toolbar and had no key for it. And once the arrival's toast had
gone, eight seconds later, nothing said it had come: the badge was a
count per project, kept in one tab's memory, skipped for the project on
screen, and forgotten on restart.

The reader's proposal was a queue, and it is a better design than the
"open or dismiss" strip it replaced in the plan: a strip asks a question
and the question expires; a queue makes no demand. What arrives and is
not opened is on it, in arrival order. It is the unread set with an
order and nothing more -- an `unread` column, one query -- so it lives
in the daemon, is the same in every tab and the window, and survives a
restart. It shows in three places from one state: a "Waiting" section
at the top of the sidebar with the oldest six and "N more"; the same
mark on each row in the tree; and a bar above the document, in the
document's measure, that counts and names the oldest, with Open, Show
all and Mark all read. The bar has no height, so a bar that appears
mid-read lays over the page's top margin rather than pushing the text
down under the reader. `n` opens the oldest and takes it off, so the
next `n` is the one after. Opening a document any other way takes it
off the same way, and every tab hears through a `read` event. The
inbox lists what is waiting first, then everything else. The one place
an arrival still opens itself is an inbox with nothing waiting, which
is the empty state that exists to be filled; an inbox with a queue on it
is the queue, and the arrival is a row. There is no arrival toast any
more: the row and the bar are the notice, and twelve in two seconds are
twelve rows and a bar that says twelve.

Back opens a document where the reader left it. The place -- a block
and an offset into it, the shape a save already keeps -- is written into
the history entry as they leave and 400 ms after each scroll, the second
for the departures the page never sees: the browser's own Back and
Forward. It is read only on a move through history, so a preview
toggled or a split view still starts at the top. alt+← and alt+→ are
Back and Forward in the page, for the window; a browser with the same
shortcut yields it to the page's preventDefault, so there it is one step
and not two.

And Backspace no longer deletes: a key a reader leans on while thinking
is not a key to lose a document to, least of all once delete loses its
dialog in 0.15. Delete is on Del, and on the button.

The rows, in `bench/ui.mjs`, eight more for 40 in all:

| | reads |
|---|---|
| arrivals, while reading | an arrival at block 30 of the plan leaves the page at block 30, the bar reading "1 waiting" with its title, one row in the sidebar, one mark in the tree; `n` opens it and every mark is gone; alt+← lands on the plan at the same block and offset; alt+→ is the arrival again; twelve at once read "12 waiting", six rows and "6 more" in the daemon's order; a reload still says twelve; `i` lists the twelve first; an arrival on that inbox is a 13th row and not a page, and Mark all read empties it through a reload; an arrival on an empty inbox opens itself, read |

## 0.15: the library in use

Three things a reader does with a document that the viewer answered
badly, all of them at the edge where snyvi meets the rest of the
desktop.

**A link belongs in the window.** With `snyvi app` running, an agent's
`send_document` still answered with `http://127.0.0.1:7777/d/…`, so a
click on the agent's link opened the default browser next to the window
the reader was using: a second copy of the viewer, with the same library
in it, and no way for either to know about the other. The daemon had no
idea a window existed.

It does now, and the way it learns is the cheapest one available: the
window's own page says so. `snyvi app` opens the first URL with
`?window=1` on it; the page latches that into session storage, takes it
out of the address so nothing copied from the bar carries it, and puts
it on the query of its event stream. The daemon counts window streams,
and the count falls when the stream ends. So the answer is live by
construction rather than by a timeout: a window that is quit, crashes or
is closed to the tray-less taskbar takes its connection with it, and
`/api/health` said so 32 ms later when it was measured. A window closed
to the tray keeps its webview, and its connection, which is right --
that window is still the place to open things.

With that, `snyvi open`, `snyvi send --open`, `snyvi browse` and a click
on a desktop notification all hand the URL to `snyvi-app`, whose own
single-instance handling navigates the window and raises it. That was
already there for a second `snyvi app`; it just had nobody calling it.
And the notification, which opened nothing at all before, opens the
document: `notify-send -A` waits for the click and prints the action
back, so one waiting process at a time carries it and a new arrival
replaces it. Windows needs a registered application id to be clicked at
all and macOS's `display notification` has no action, so on those two it
is the notice it always was.

The last piece is what the agent is told, which is the part the reader
noticed: with a window up, the tool now answers "Waiting in snyvi" and
no URL, because a URL is an invitation to open the wrong thing. Without
one it answers with the link, as before. The reply also stopped saying
the document is *open*, which stopped being true in 0.14: it waits.

**A delete asks nothing and can be undone.** The confirmation was a
`window.confirm`, which in the native window is the toolkit's own dialog
in the toolkit's theme, drawn over a page it has nothing to do with, and
which has to be answered before anything else can happen -- and which,
answered, destroyed the document. Now `Del` deletes at once and the line
at the corner offers "Undo" for eight seconds, or ⌘/ctrl Z, which is
where the hand goes first.

Underneath is a `deleted_at` column and one SQL view. Every read of the
library -- the tree, the inbox, search, history, the queue, the counts --
goes through `live_docs` rather than `docs`, so a deleted document is
gone from all of them by construction, and not by a condition that the
next query written could forget. The view names `rowid`, which a view
does not have of its own and which every ordering here breaks ties with.
Undo is one column back. `prune` is what makes a delete final, and it
takes deleted documents whatever their age and whether or not they are
pinned: the reader has already said so, and the eight seconds they could
have taken it back in belong to that minute, not to next month.

**A link into a folder lands.** `#L120` and a section link opened a
document where they pointed, and a browsed file at the top: the browse
path rendered, scrolled to zero, and never looked at the fragment.
Between two agents working in one checkout, a link into a browsed file
is exactly how one says where to look. Both paths land the same way
now, and neither leaves it to the browser's own fragment scroll, which
aims at blocks that are still `content-visibility` placeholders and
stops short.

**And one the probes found on the way.** The browse rows load a page,
then another, then another, and on the third pass the harness reported
that a document was being held open: no load event in 20 seconds. The
daemon answered the same URL in 4 ms throughout, so it was not the
daemon; what was pinned was the browser's connection pool. Every snyvi
page holds one connection open for its event stream, a browser allows
six to a host over HTTP/1.1, and a page on its way out keeps its own
until it is destroyed -- so eight loads in a row left eight streams
behind, the count sat at six, and the next page waited for the pool to
time one out. The page closes its stream on the way out now, and a page
restored from the back/forward cache opens one again and catches up on
what it missed. The count sits at one or two through eight loads, and a
row reads it off the daemon.

That leaves the honest half of the same limit: six tabs that are really
open do spend all six connections, and the seventh request waits. It
wants one stream shared between tabs or a poll that frees the socket,
and it is in the E table as its own piece of work. Nobody has six snyvi
tabs open yet.

**What moves, moves once.** The page had a motion system already --
one curve, 140 to 180 ms, enters only, off under reduced motion -- and
the question was not what to add but which changes were still a cut a
reader could miss. Three were, and one was noise. The sidebar is
rebuilt from state whenever the library moves, so a row had no past to
animate from: an arrival's row simply appeared, a read's row was simply
gone, and the bar over the document, rebuilt with the rest, ran its
rise again for every arrival after the first -- twelve arrivals rose
twelve times. Now the page keeps the moment a row arrived or left, for
as long as its motion lasts, and a row rebuilt mid-motion starts its
animation at a negative delay, where the last one was. So an arrival
washes its row once, the way a heading is lit where a jump landed,
whatever the tree does under it; a row that was read or deleted is
drawn closing, 140 ms, in the place it had; an undo washes it back;
and the bar rises when it appears and stays, the count settling in
when it changes. The `#` beside a heading confirms a copy on the mark
itself rather than by a toast at the corner, which for a click at the
heading is the wrong distance away.

What was not added is the longer list: nothing runs while the page is
read, nothing bounces, nothing waits for a spinner that would outlast
the work, and reduced motion means none rather than slower. The rows
read the page's own animation list, so a wash that plays twice, a bar
that rises twice, a row that is just gone, anything past 700 ms or
running forever, and anything at all under reduced motion, all fail.

And a sound, since it was asked for: not in the page, and not by
default. A sound is the one signal a reader cannot decline by not
looking, which is the opposite of what 0.14 built, and a page cannot
play one in a browser tab without a gesture anyway. The desktop's own
notification is the channel that already knows the volume, the focus
mode and do-not-disturb, so `SNYVI_SOUND=1` puts the freedesktop
`sound-name` hint on it (a named sound on macOS; Windows toasts sound
unless told not to, and `SNYVI_SOUND=0` tells them), and a burst is one
sound: at most one every two seconds, which a test holds.

The rows, in `bench/ui.mjs`, twenty-one more for 61 in all:

| | reads |
|---|---|
| a delete, and the way back | `Del` on an open document leaves nothing asked -- a `confirm` would hang the probe, which is the check -- the row is out of the inbox and the toast carries an Undo; the button puts the document back where it was deleted from; ⌘Z does the same without the toast; and a delete the reader does not undo is still gone after a reload, from the inbox and from search, because the daemon did it |
| a link into a folder | a browsed Markdown file opened at a section link lands with the heading 24 px into the pane, 11,208 px down the file; `code.rs#L300` marks one line, the one that reads `line_300`, and it is on the screen |
| the socket a page holds | eight page loads in a row all load, and the daemon is holding one event stream at the end of them, not eight |
| a window to hand a link to | a browser tab is not a window, and the MCP reply carries a link; the page opened with the mark is one, and the mark is out of the address; it is still one after it navigates to a document; the MCP reply then says it is waiting in snyvi and carries no URL at all; and the moment the page goes, the daemon says there is no window again |
| what moves, and for how long | an arrival's row carries one wash, and 250 ms later, rebuilt under a tree refetch, the same wash is 250 ms in rather than starting over; a second arrival leaves the bar element in place with no rise running and the count ticking; nothing running is over 700 ms or endless; `n` draws the row it read closing, and it is gone 400 ms later; the `#` reads Copied and raises no toast; and under reduced motion the page has no animation at all |

## 0.16: the three desktops

The half of 0.15 that was machines rather than code, as its own release.
What changed is what CI builds, on what, and what it checks after
building; the page changed by one stylesheet rule, at the end.

**macOS.** Two legs in the release matrix, Apple silicon on `macos-14`
and Intel on `macos-15-intel`, and each ships one thing: `snyvi.app`.
Both executables are inside it. The window is what the bundle runs, and
when it is run with no URL -- which is what a double-click is -- it
hands over to the `snyvi` beside it, which starts the daemon if it must
and runs the window again with the URL. On unix that hand-over is an
exec, so the process Finder launched is the process showing the window.
The command line is a symlink to that inner `snyvi`, and `snyvi app`
from it finds the window beside the real file: the launcher now resolves
its own path before looking for a sibling, and on a Mac also looks in
`/Applications` and `~/Applications`. The Chromium-family fallback learnt
where a Mac keeps a browser, which is inside an application bundle and
not on PATH.

The bundle is laid out by `packaging/app.sh`, the way `deb.sh` lays out
the packages, and the two things only a Mac can do to it -- compile the
icon with `iconutil`, sign it with `codesign` -- are done when there is
one and skipped when there is not, so the script runs on every Linux
push too and a mistake in it is found before release day. The signature
is ad-hoc: Apple silicon will not run an executable without one, and an
identity Gatekeeper would accept takes a developer account. So the first
open is refused as from an unidentified developer, and the README says
what to do about it. That is the honest state of an open-source Mac app
without an Apple account, and it is written down rather than worked
around.

CI's macOS job runs the tests, both builds, the daemon smoke test, the
bench with `SNYVI_BENCH_SHARED`, packages the bundle, checks the plist,
the icon and the signature, and then opens the window *from the bundle
with no URL*: the daemon has to be answering on the port, the window has
to be up, and the daemon has to say it has a window. That last one is
0.15's window mark, read on a third desktop.

**arm64.** The desktop job is a matrix over `ubuntu-22.04` and
`ubuntu-22.04-arm`, in CI and in the release, so the arm64 window
package records the same `libc6 (>= 2.34)` baseline as amd64's. The only
thing that had kept it out was the runner.

**The shortcut.** ⌘⇧Space on a Mac and Ctrl+Shift+Space elsewhere shows
the window from anywhere, or hides it when it is the one in front. The
key is the part that was "not obvious", and the answer is a chord that
no desktop's *shell* holds: ⌘Space is Spotlight and ⌃Space changes the
input source, Super+Space changes the layout on GNOME and Windows both,
⌃⌥Space is the next input source on a Mac, and Ctrl+Alt+letter is AltGr
on half of Europe's keyboards. Programs are another matter -- Excel
selects the sheet with Ctrl+Shift+Space, Word types a non-breaking
space -- and a global shortcut wins over a program's own, so it is a
default and not a decision: `SNYVI_SHORTCUT` names another key, or `0`
for none, and a key another program already holds is reported and left
with it.

Two things the plugin's source settled. Its hotkey interface on Linux is
X11's, so on Wayland the shortcut would fire only while an X11 program
had the focus, which is worse than none; the window registers it only on
an X11 session and otherwise says that the desktop's own settings are the
place, where a key bound to `snyvi app` reaches the running window
through the single-instance hand-off 0.7 built. And the plugin opens
that interface as it loads, and a failure there fails the whole window,
which a shortcut is never worth -- so the plugin is added only when a
key is wanted, and the key itself is registered from the window's own
setup, where a failure is one line.

CI presses it. Under Xvfb the Linux desktop job reads the line that says
the key registered, then sends the chord with `xdotool` and watches the
main window's map state, which has to change within three presses --
three, because Xvfb runs no window manager, so nothing has the focus at
first and the first press can only give it.

**And one thing seen, not measured.** The search palette's result titles
came up in cyan -- the colour of a type name in highlighted code, on a
page whose own ink is warm grey and whose one accent is orange. The
palette's title and subtitle spans are `.t` and `.s`, and so are the
highlighter's classes for a type and a string, and the highlighter's
rules were global. They are scoped to `pre.code` now, the only place the
renderer writes them, and the toast's title, which had the same two
spans, is quiet again too. One row in `bench/ui.mjs` reads the palette's
computed colours against the page's: 62 rows in all.

**What the first macOS run measured, and what it meant.** The bench's
last row read 181 MB on the arm64 runner, against a budget of 100 and a
Linux reading of 82. Not a leak: on macOS the allocator gives freed pages
back with `MADV_FREE`, and the kernel leaves them in the resident count
until it wants them, so `ps` reports what the process once touched, not
what it holds. The number the budget means is the physical footprint --
Activity Monitor's column -- and `vmmap --summary` prints it for any
process of one's own. The bench reads that on a Mac and holds it to the
budget; where `vmmap` is missing it prints the plain count in brackets
and says what it is, so a machine without the command line tools gets a
row that is honest rather than one that is red for the wrong reason. The
CI job prints both numbers side by side for the same daemon, as the
evidence.

**What is still a person's.** The numbers. The README's per-desktop
table carries the hosted runners' readings, marked as such, and a
`snyvi bench --check` from a real Mac and a real Windows desktop
replaces those columns and sets the Windows cold-start budget that the
`SHARED` rows have been waiting on since 0.7. And the two lists under
"Not yet watched" below: a desktop in use is the one thing no runner
shows.

## 1.0: what done looks like

1.0 is not a feature. It is the point where a person can install snyvi on
the three desktops, a reader who has never seen it is not surprised by
anything it does, and every number the README quotes is a test that
would fail if it stopped being true. The bench already does the last of
these for the daemon and the renderer; 0.11 was the first time the
behaviour of the page was measured the same way, and it found eleven
faults in an afternoon; 0.12 made the measuring a check in CI, and the
check found six more before it passed; 0.13's two faults were in an
engine the check does not run, and got a harness of their own; 0.14's
three came from a reader with several agents, and were the design's; and
0.15's three were at the edge where snyvi meets the rest of the desktop,
which is the part no probe had ever been pointed at; and 0.16 pointed
CI at the two desktops it had never opened a window on. So the rule for
what is left: nothing goes into
the 1.0 list that cannot be checked by a probe or a test, and nothing is
checked off without one.

Each phase is a release, in this order, because each one's probes are
what the next one is measured with.

**0.12: the chrome at every width, and by keyboard** (shipped; the notes
above). Below 1100 px the
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

**0.13: the panes fit the reader** (shipped; the notes above). The
sidebar and the rail resize by drag and by key, within limits, and
remember it; a diagram fills the screen from inside the page, since the
Linux window's engine draws no text in an element of its own in the top
layer. Probe: the nine rows above. Cost S.

**0.14: a read that is never interrupted** (shipped; the notes above).
An arrival joins a queue and never takes the page away; `n` reads down
the line; Back opens a document where the reader left it and works in
the window; unread is the daemon's and survives a restart. (The last
heading becoming current at the end of a short final section, listed
here before, came with 0.12's marker; the browse path landing a
fragment moves to 0.15 with the rest of the library work.) Probe: the
eight rows above. Cost M.

**0.15: the library in use** (shipped; the notes above). The window as
the place an agent's link opens when it is running, rather than a
browser beside it, and as what the agent is told; delete without a
dialog, undone from the toast or by ⌘Z, over a soft delete that `prune`
makes final; a link into a browsed folder that lands where it points;
and what moves in the sidebar moving once, with a sound on the
notification for whoever asks. Probe: the four rows above. Cost M.

This was half of one phase with the platform work below, on the
argument that the dialog is the toolkit's in the window. The half that
is code is checkable here and shipped; the half that is machines is
not, so it is its own release rather than a release held open waiting
for a laptop.

**0.16: the three desktops** (shipped; the notes above). macOS in the
release matrix with a `.app` that starts the daemon from a double-click;
the Linux window on arm64 from its own 22.04 runner; the global shortcut
the tray item was half of, configurable and honest about Wayland. Probe:
CI opens the window on all three, and presses the key on the one that
can be pressed from a script. What remains a person's: a `snyvi bench
--check` from a real Mac and a real Windows machine, written into the
README's per-desktop table, the Windows cold-start budget set from it,
and the lists under "Not yet watched". Cost M.

**The gate.** `bench/ui.mjs`, which runs beside `bench/browser.mjs` on
every push since 0.12, holds every row of the 0.11 table above and what
0.12 added, plus what 0.13, 0.14 and 0.15 add; the README's tables carry no number the bench does not read; the
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

## Not yet watched on Windows or macOS

The build, the tests, the daemon and the window are all exercised by CI
on a Windows runner and, since 0.16, on two macOS runners. What no
runner shows is a desktop in use. On Windows: the toast, the tray's
click behaviour, the global shortcut pressed by a hand, and how the
window looks at the display scalings Windows actually ships with. On
macOS: Gatekeeper's refusal of the ad-hoc signature and the two ways
past it the README gives, the Dock icon from the compiled `icns`, ⌘⇧Space
against whatever the reader's other programs hold, the notification with
its sound, and the window on a Retina display. Those are argued for, not
yet watched.

## Still no purpose-built view

JSON and YAML (highlighted source only) and Jupyter notebooks (raw JSON
rather than cells). Notebooks are the most work and the least common in
this context.
