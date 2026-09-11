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
| Desktop notification on arrival | When the window is not focused, a system notification with the title; click to open. `notify-send` on Linux. | S | **done 0.2** |
| `snyvi watch FILE` | Re-send a file whenever it changes on disk, for editors and agents that have no hooks. Uses the same coalescing as the hook. | S | **done 0.4** |
| Other agents | Config snippets for Codex CLI, Gemini CLI and Cursor: all speak MCP, so it is docs plus an `init` subcommand per tool. | S | later |
| Claude Code skill file | A `/snyvi` skill that teaches the model when to send and how to phrase the link, installed by `init-claude`. | XS | later |
| Per-project opt-out | `.snyvi.toml` in a repo with `collect = false` so the hook never sends from that project. | XS | later |

## D. Desktop

| Feature | Why | Cost | Status |
|---|---|---|---|
| Remember window size and position | Basic expectation of a native app. | XS | **done 0.2** |
| Tray icon and global shortcut | Summon the window from anywhere; the daemon is resident anyway. | M | later |
| Packages | `.deb` for Debian and Ubuntu, built for both architectures by the release workflow: the CLI, an application menu entry and a systemd user service, depending on nothing because the binary is static. AppImage, AUR and a Homebrew tap remain. | M | **done 0.4** |
| Ship the native window | The Tauri window existed but no release contained it: the release builds are static musl, and WebKitGTK cannot be linked into those. A second `snyvi-desktop` package carries it, with its dependencies read out of the binary. | M | **done 0.5** |
| Desktop package for arm64 | amd64 only so far. The arm64 runners are 24.04, so the package would record a glibc baseline excluding everything older; it wants its own oldest-host runner. | S | next |
| Split the window into its own binary | The desktop package is one binary, so `snyvi serve` carries the linked engine even with no window open: 66 MB resident against the static build's 34 MB. A separate executable for the window would give the desktop package a lean daemon again. | M | next |
| macOS build | Tauri and the plain build both work on macOS; add it to the release matrix. | S | later |
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

## 0.5: the window ships

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

## Candidates after 0.4

JSON and YAML views, tags from the sender, macOS build, AppImage and
AUR, tray icon with a global shortcut.

Release hygiene: CI now builds `--features desktop` and opens the window
under Xvfb, so the Tauri path is no longer unverified. Still open, and
now with the reason pinned down: no release has ever been cut, so the
install instructions point at an empty releases page. The release
workflow is the one path proven only by proxy — CI builds and installs
the `.deb` on every push, but nothing has ever exercised tagging, the
two-architecture matrix, or the upload.

Both ways of starting it need a credential an agent session does not
have. `workflow_dispatch` returns 403 (`Resource not accessible by
integration`), and pushing `v0.4.0` returns 403 from GitHub while a
push of ordinary commits to the same branch succeeds — the token can
write commits but not tags or workflow runs. So it is still one
command, and it still has to come from a machine with tag permission:

```
git tag -a v0.5.0 -m "snyvi 0.5.0" && git push origin v0.5.0
```

The version in `Cargo.toml` is already `0.5.0`, so the tag is the only
step. 0.4 was never tagged, so 0.5 is the first release either way, and
it is the one worth cutting: it is the first that contains the window.

## Still no purpose-built view

JSON and YAML (highlighted source only) and Jupyter notebooks (raw JSON
rather than cells). Notebooks are the most work and the least common in
this context.
