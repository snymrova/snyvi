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
| A click that lands at once | A 6,000-line code file froze the tab for 2.3 s on open, and no bench measured the gesture a reader makes most. A code block over 400 lines is served cut into 200-line chunks so containment can skip what is off screen, its outline is worked out on arrival and kept beside it rather than derived per open, and the sidebar is rebuilt after the first paint instead of before it. `bench/open.mjs` holds all three. And the click is answered before any of it: the title the row already knew, and bars where the text will be, in the same frame as the click. | M | **done 1.2** |
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
| A link out of a document lands too | comrak writes a bare `<a href>`, and the viewer is a page in a window with no address bar and no Back button of its own, so a click on a link to a repository left the reader there with nothing to come home by but the tray -- and `[notes](./notes.md)` in a sent document resolved against `/d/<id>` and landed on a bare "Not found". Every link is sorted at receive time: the web gets `target="_blank"` and a `↗`, a scheme the desktop answers for is marked without one, a fragment or a relative path is left alone. The window keeps its own origin and hands the rest to the desktop; a same-origin path the viewer has is turned to, and one it has not says so, with the browser offered. | S | **done 1.0.2** |
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
| Reset to a fresh install | `snyvi reset` removes every document, the index, the token and the page's preferences, and leaves the agents registered, so the next `send_document` lands in an empty library; `--agents` takes the registrations out too. It is the one action that cannot be undone, so the friction is real on both surfaces: the sentence says what goes and what stays, and the confirmation is the number of documents typed back, not "yes". `--yes` for scripts, `--dry-run` to read the sentence and stop, and a refusal while anything is pinned unless `--pinned` is given. | S | **done 0.18** |
| Export | Copy as Markdown, print stylesheet polish, save as PDF via print. | S | maybe |

## C. Agent integration

| Feature | Why | Cost | Status |
|---|---|---|---|
| Desktop notification on arrival | When the window is not focused, a system notification with the title; click to open. `notify-send` on Linux, a PowerShell toast on Windows, osascript on macOS. | S | **done 0.2** |
| `snyvi watch FILE` | Re-send a file whenever it changes on disk, for editors and agents that have no hooks. Uses the same coalescing as the hook. | S | **done 0.4** |
| Connect an agent, from the page | `snyvi mcp` is a plain stdio MCP server and already works with every client that speaks MCP, and nothing says so: the only setup path is `init-claude`, and the viewer never mentions an agent at all. The empty library becomes a page with one row per agent -- connected, not set up, or pointing at a binary that is gone, read from the agent's own config file -- with the command or the copyable snippet that fixes it, the line for its instructions file, and when it last sent something. `snyvi init <agent>` writes every agent's file -- two writers, JSON and TOML, cover all eight -- and `uninstall <agent>` takes the entry back out leaving the rest of the file; a file snyvi cannot parse is left alone with the snippet printed. | M | **done 0.18** |
| A note beside the work | Two entries under "Explicitly not planned" refused a channel from the agent to the reader, and were right about what they feared. `send_note` answers each fear by being small: 280 characters, the last five, in memory only, one lighting up every ten minutes, never in the queue and never unread. It is a line at the foot of the sidebar and snyvi's own mark is its voice. The 1.2 notes say which half of the refusal did not survive. Renamed `send_aside` after 1.4.0, once desks had notes of the reader's own and the two shared a word; `send_note` is still answered. | S | **done 1.2** |
| An about box | Nothing in the viewer says what it is, which version is running, where its data lives or under what license; a reader who arrived from an agent's link has no way to find out. One panel inside `?`, naming the same version `snyvi --version` prints. | XS | **done 0.18** |
| Who is here now | The daemon heard of an agent only when one sent, so the connect page could say "sent 12 minutes ago" of a session closed for eleven, and nothing on any page said whether an agent was connected at all. The MCP server holds an event stream on the daemon under its client's name from `initialize` until its process ends, counted the way the window's is; a count beside the brand mark says how many are here, its title which, and the connect page's row says *online*. Nothing times out: the count is the streams. | S | **done 0.19** |
| Claude Code skill file | A `/snyvi` skill that teaches the model when to send and how to phrase the link, installed by `init-claude`. | XS | later |
| Per-project opt-out | `.snyvi.toml` in a repo with `collect = false` so the hook never sends from that project. | XS | later |
| The front page | The README was the manual: 860 lines, no picture, `## Install` on the first screen. It is now a landing page -- the film, the hero in both themes, install in four lines per desktop, six pictures each saying one thing, the keys, the numbers -- and the manual is `docs/GUIDE.md`, verbatim. Every picture and the film come from `bench/media.mjs`, a camera over a seeded library, so a release re-takes them and CI proves the views it points at still exist. | S | **done 0.21** |
| A film worth watching | The first film was a screen recording: two windows on a desktop, a voice reading captions, one long take. It showed the product and sold nothing, partly because a headless Chromium paints only when something changes, so a recording of a document being read came back at three frames a second. The film is cut now, not recorded -- `film/`: stills at 2880x1800 from the same seeded library, twelve scenes on one GSAP timeline, panned and punched into at sixty, a narration whose every word lands on a measured pause in the voice track rather than a guess, and music under it. Set in the two faces snyvi renders documents with, because the argument the film makes -- a stream of tokens becomes a document a person reads -- is the same one the letterforms make. | M | **done 1.1** |
| The first ten minutes | `init-claude` reads what Claude Code has before touching it, is safe to run again, follows a binary that moved, and ends with what to try; `--claude-md` writes the CLAUDE.md line; `uninstall-claude` takes all of it back out and nothing else; `install-cli` puts the command on PATH where the README's `ln -s` could not; a taken port, a missing browser and a fallback rung each say what happened. `bench/onboarding.sh` types it all in CI. | S | **done 0.17** |

## D. Desktop

| Feature | Why | Cost | Status |
|---|---|---|---|
| Remember window size and position | Basic expectation of a native app. | XS | **done 0.2** |
| Tray icon | Summon the window from anywhere; the daemon is resident anyway. Closing the window hides it instead of quitting, so reopening costs nothing. | M | **done 0.7** |
| Open a terminal here | A document that says what to do next means leaving snyvi and re-finding the directory. A button opens the machine's own terminal with its working directory set to the document's, or the browsed root's. It passes no command, so nothing a document contains ever reaches a command line. `docs/TERMINAL.md`. | XS | **done 0.8** |
| A sound on arrival | Asked for, and declined by default: a sound is the one signal a reader cannot ignore by not looking. `SNYVI_SOUND=1` puts a sound hint on the desktop notification -- the channel that already knows the volume and do-not-disturb -- and a burst sounds once. Nothing in the page plays anything. | XS | **done 0.15** |
| Global shortcut | The other half of the tray item: summon the window without finding the tray first. ⌘⇧Space on a Mac, Ctrl+Shift+Space elsewhere -- a chord no desktop's own shell holds, which was the part that was not obvious -- shows the window, or hides the one in front. `SNYVI_SHORTCUT` names another key or none, since a global shortcut wins over any program's own. X11 only on Linux: on Wayland the window says so and the desktop's settings bind a key to `snyvi app` instead, which reaches the running window the same way. | S | **done 0.16** |
| The window is where a link opens | `send_document` answered with `http://127.0.0.1:7777/d/…` whatever was running, so a click opened a second viewer in a browser beside the window, and the desktop notification opened nothing at all. The window's page now says it is one when it opens its event stream, so the daemon knows for exactly as long as there is a window; `snyvi open`, `send --open`, `browse` and a click on the notification hand the URL to it and raise it, and the tool answers that the document is waiting in snyvi, with no link, when there is a window to wait in. | S | **done 0.15** |
| A link that opens in the window | 0.15 gave the agent no link while a window was up. Without one the link was still `http://…/d/…`, and a click on it opened a browser beside the window it would have started. Where `snyvi-app` is installed the tool now answers `snyvi://d/<id>` as well, with the `http://` one beside it for a terminal that does not know the scheme; the desktop hands the link to the window that is up, or starts one, or starts the daemon and then one. The scheme is registered three ways -- the `.deb`'s desktop entry, `snyvi.app`'s Info.plist, and the window itself on first run for a tarball or zip -- and `snyvi app <link\|id\|url>` does from a terminal what a click does. | S | **done 0.20** |
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
| The page pays for what it uses | The UI budget is < 60 KB gzipped and had been over since before anyone measured it: 63.5 KB at 1.0, found by hand, twice, at two different numbers. `bench/bytes.mjs` made it a row a push can break, with a ceiling above the budget to hold the ratchet while the debt was real. The debt is paid rather than ratcheted: the diagram driver -- 820 lines that queue, cache, theme, zoom and reserve, for a library lazy since 0.2 -- was 11.6 KB gzipped on every page load, and most documents hold no diagram. It is `ui/mmd.js` now, imported when a document with `pre.mermaid` arrives. First paint 67.0 KB to 55.1 KB, inside the budget, and the ceiling is retired because the budget is enforceable again. | S | **done 1.1** |
| What the browser does not read, it does not fetch | The work above put first paint at 72.7 KB of a 60 KB budget, and deferring every feature that could honestly be deferred came to 7.8 KB -- not enough, for seven features put behind a fetch. What the page was carrying was its own prose: 26 KB of comments and indentation that no browser reads. `build.rs` strips them on the way into the binary (`src/strip.rs`), the source keeps every word and `SNYVI_UI_DIR` still serves it as written, and `bench/bytes.mjs` asks a daemon rather than the folder because the folder is no longer what anyone fetches. First paint 48.9 KB, and the budget is 50. | M | **done 1.2** |
| Desks: real shells in the window | A desk is a folder and up to four panes, made from a folder's context menu, the + beside a folder, or the palette. The terminal lives in the daemon (PTY, parser, and a screen model of its own), and the page paints row diffs from a chunk that loads when a desk opens. The panes are behind a per-window capability, so a browser tab gets 403. The caps are eight panes and 2 MB of scrollback each. The layout persists and processes do not. `docs/DESK.md`. | L | **built 1.1** |
| The UI's behaviour in CI | Every fault in 0.11 was found by driving Chromium against a daemon and measuring: where the marker was, what a wheel moved, what Back did. Those probes are `bench/ui.mjs` now, beside the browser bench and on every push, so the rail cannot quietly stop following again. | S | **done 0.12** |
| Keyboard and screen-reader pass | The palette and the help box trap no focus and return it nowhere; the find count is not announced; hover-only controls (copy, rename, the `#`) have no equivalent under a finger. One pass, with the checks kept in `bench/ui.mjs`. | S | **done 0.12** |

## Explicitly not planned

- Editing. snyvi is a viewer; "open in editor" is the whole editing story.
- Streaming or in-place document updates. Immutability is what keeps it fast and simple.
- Reading documents back into the agent. The channel is one-way by design.
- Hosted multi-user mode, until the local tool has real users asking for it.
- A command runner inside snyvi: "run this block", fan-out to several panes, or anything else that turns what a document says into input. That is a one-click path from content an agent wrote to a side effect on the reader's machine. Desks are real shells the reader types into, and nothing received is ever typed into them. `docs/TERMINAL.md` section 9 draws the line and `docs/DESK.md` says where it is enforced.
- Messages from the agent to the reader, and a pet in the chrome. Both were refused here at length, and both were built in 1.2; the entry below says what the refusals feared, what the design does about each fear, and what would make them right again. The half that still stands is written there rather than here.

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
| a jump of 5000 px, smooth | stopped 1658 px short | instant instead, and corrected two frames later |
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
| by keyboard | Tab from the top reaches every control (66 stops the day it was counted; the row holds the controls, not the count); the palette and the help box keep focus in and give it back; the find count is a live region; copy, rename and the `#` are visible with no pointer to hover with |

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
| a link into a folder | a browsed Markdown file opened at a section link lands with the heading 8 px below the document's head, 11,176 px down the file; `code.rs#L300` marks one line, the one that reads `line_300`, and it is on the screen |
| the socket a page holds | eight page loads in a row all load, and the daemon is holding one event stream at the end of them -- two while the page before is still in the back/forward cache -- not eight |
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

CI presses it. The Linux desktop job reads the line that says the key
registered, then sends the chord with `xdotool` and watches the main
window's map state: hidden, then shown again, somewhere in four presses.
Under a window manager, which took a round to learn: a bare Xvfb has
none, and without one the focus the toggle reads belongs to nobody -- on
the amd64 runner the second press hid the window, on arm64 none of three
did, and setting the focus by hand from outside changed which. Openbox
under Xvfb is a desktop as far as focus is concerned, and there the key
hides and shows on every press, the way it does on a reader's.

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
evidence: on the second run, `ps` said 13 MB and the footprint 7, for a
daemon with one document in it. Under the footprint the two resident
rows on the arm64 runner read 11 MB and 26 MB, against 40 and 82 on
Linux, which is the difference between a libc with arenas and one
without.

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
CI at the two desktops it had never opened a window on; 0.17 typed the
install as a newcomer does and found ten stalls before the first
document; and 0.18 is for the newcomer who never read the README, and
for getting back to being one. So the rule for
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
a code block's language where no copy button has its corner -- is
present under `(hover: none)`, as the diagram tools already are. Probe: Tab from the top of the page reaches
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

**0.17: the first ten minutes** (shipped; the notes above). The install
walked as a newcomer walks it: `init-claude` safe to run again and
following a binary that moved, `uninstall-claude`, `install-cli`, and a
ladder, a port and a first send that say what happened. Probe:
`bench/onboarding.sh`, on every push. Cost S.

**0.18: connect an agent** (shipped; the notes below). 0.17 fixed the
minute between the download and the first document for a person with
Claude Code who read the README. 0.18 is for the person who did not,
or has a different agent: the empty library is a page that says which
agents are connected and how to connect the rest, with `snyvi init
<agent>` behind the ones snyvi can write for; an about box inside `?`;
and `snyvi reset`, which puts an install back to that page, with the
friction an action that cannot be undone deserves. Probe:
`bench/onboarding.sh` types `init`, `init` again, `init` after the
binary moved and `uninstall` byte-equal for every agent snyvi writes
for, reads the page's state at each step, and resets between; the page
rows in `bench/ui.mjs`. Cost M.

**The gate.** `bench/ui.mjs`, which runs beside `bench/browser.mjs` on
every push since 0.12, holds every row of the 0.11 table above and what
0.12 added, plus what 0.13, 0.14 and 0.15 add; the README's tables carry no number the bench does not read; the
tables in this file have no row marked **next**; and `docs/BRAINSTORM.md`
is read once more against what shipped, so that the budgets it set and
the ones the bench enforces are the same budgets. Then the three
commands under "Release hygiene", from a person, and the tag says 1.0.0.

**The gate, walked (2026-09-17).** Every row in the tables above has a
row in `bench/ui.mjs` behind it, and three of those rows were looser
than the words here: the sheet was held under 400 px where the table
says 320, the heading's flash on landing was never read, and the stream
count was allowed two without saying why. The first two are pinned now
and the third says why. Two numbers the tables quoted are not held and
never will be, since they move with the fixture -- 66 Tab stops, 11,208
px down a file -- and the rows say so. The README's own table was clean;
the guide's longer one held one budget the bench does not (200 ms for
the drawing row, which is 250) and five numbers no probe reads (the
window's binary, the two `.deb`s, the window's start and its resident
set, an arrival's latency), which are now a sentence under the table
rather than rows in it. `docs/BRAINSTORM.md` was read against what
shipped and got a closing section that puts each target beside the
budget the bench holds and each claim beside the shape that stands:
the 1 MB render budget is 400 where it asked 200, and stays; the UI is
63.5 KB gzipped where it asked 60, and nothing reads the sum; the
160 ms animation cap became 700; and the store, the ids, the tool's
reply, the hook and the file count of the page are all other than
drawn. Nothing in that read is a fault in what shipped. What is left is
the three commands.

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
gh pr list --state open
git fetch origin main
git show origin/main:Cargo.toml | awk '/^\[/{t=$0} t=="[package]" && /^version/'
git tag -a v0.7.0 -m "snyvi 0.7.0" origin/main && git push origin v0.7.0
```

The first line has to print nothing. v0.20.0 was tagged on the branch
tip with its pull request still open; the tag was right about the
commit and the commit was not on `main`, and the fix was a merge and a
moved tag. Nothing below catches it: the manifest on the branch already
said 0.20.0.

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

## 0.17: the first ten minutes

0.16 put the window on three desktops; 0.17 is the install walked as a
newcomer walks it, in a clean home with no browser and no `claude` on
PATH, reading the README from the top. Ten places stalled. None was a
bug in the viewer; every one was in the minute between the download and
the first document, which is the minute no probe had been pointed at.

**`init-claude` the second time.** The first run registered. Any later
run -- after an update, after the binary moved, from notes on a second
machine -- got "already exists" from Claude Code, and snyvi answered
"Could not run `claude`", then installed its hooks again anyway. Two
things were conflated: a `claude` that cannot be started, and one that
ran and declined. And nothing was read before writing. Now the
registration is read from where user scope lives (`~/.claude.json`,
which needs no `claude` to answer), and there are three outcomes said
in three sentences: already registered, registered now, or registered
under a path that is not this binary and so re-registered.

**The hook that followed nothing.** The hook line was the binary's
absolute path at the moment `init-claude` ran. A tarball tidied into
`~/.local/bin`, a zip moved out of Downloads: the path is gone, the hook
fails on every tool call, and a hook is required to be silent. The line
is `snyvi hook` now when the `snyvi` a shell would run is this file,
and the absolute path only when it is not -- said so at the time, with
"run this again if it moves" -- and a run of `init-claude` rewrites
every hook of ours to the current binary, `--auto` or not. `snyvi
status` ends with a line naming the registration and the hooks, and
says when either points at a path that no longer exists.

**Undo.** There was no way out but editing two JSON files by hand.
`uninstall-claude` removes the MCP entry, every hook of ours, and the
CLAUDE.md line, and leaves everything else exactly as found: an entry
that also carried someone else's hook keeps it, an event emptied is
dropped, and a file that had only ours goes back to having no `hooks`
key at all. Tested on the parsed file, then in CI against a settings
file that starts with another program's hook in it.

**The ladder was silent.** `snyvi app` on a machine with no window
package and no browser printed `open http://127.0.0.1:7777` and exit 0,
which reads as either a message or a mistake. Each rung now says which
it is and how to get the one above it, and a URL nobody could open is
labelled as the reader's to open.

**A taken port was "did not come up".** With another program on the
port, the daemon died on bind with nothing to say and the client
reported a timeout. The client now asks the port first: an answer that
is not a snyvi daemon names the port and `SNYVI_PORT`.

**The first send printed a URL.** A daemon started, a token was
written, a data directory appeared, and stdout carried a link and
nothing else -- as it should, for a script. The command that starts the
daemon says so once on stderr, and only when stderr is a terminal, so a
hook hears nothing.

**The macOS symlink.** The README said `ln -s ... /usr/local/bin/snyvi`.
On a fresh Mac that directory is root's; on Apple silicon it does not
exist until Homebrew makes it. `install-cli` tries `/usr/local/bin`,
falls to `~/.local/bin`, creates that one, and says when the one used
is not on PATH. On Windows, where there is nothing to link, it puts the
binary's folder on the user PATH, once, through the environment call
rather than `setx`, which truncates at 1024 characters.

**The README.** Windows now names a folder and the SmartScreen sheet;
macOS runs `install-cli` from the bundle; there is an uninstall section
naming the three directories; and every install path ends in
`snyvi status`.

CI types the whole thing (`bench/onboarding.sh`): init-claude in a home
that has never seen snyvi, again, again after the binary moved onto
PATH, `status`, `--claude-md` twice, `uninstall-claude` against a
settings file that must come out byte-equal to how it went in, no
`claude` at all, a port held by another program, no browser, and
`install-cli` into a directory. The macOS job links the bundle's
command line the way the README says to; the Windows job checks the
user PATH after `install-cli` and that a second run says so.

What is still argued for, not watched: the SmartScreen sheet itself, a
real `claude mcp add` (the fake keeps its file the way the real one
does, and refuses a second add the way it does), and a Mac whose
`/usr/local/bin` is root's, which the runner's is not.

## 0.18: connect an agent

0.17 walked the install as a newcomer walks it, with the README open
and Claude Code on the machine. 0.18 is for the newcomer who has
neither: who opened the window from an icon, is looking at "Nothing to
read yet" and two commands meant for a person, and has Codex or Cursor
in the other window. `snyvi mcp` is a plain stdio MCP server and has
worked with every client that speaks MCP since 0.2. Nothing has ever
said so, in the README or on the page. That, an about box, and the way
back to the beginning, and then the 1.0 gate.

**The page.** When the library is empty the document pane is a page
called "Connect an agent", and it is reachable at any time from the foot
of the `?` box and at `/connect`, because the second agent arrives after
the first document did. One row per agent, and one more for any sender
that is none of them, because a client snyvi has never heard of that
has sent is connected by definition. Each row says three things.

*What state it is in*, read by the daemon from the agent's own config
file and nothing else -- `~/.claude.json` for Claude Code, `~/.codex/config.toml`,
`~/.cursor/mcp.json`, the desktop app's `claude_desktop_config.json`,
and the files Gemini CLI, Windsurf, VS Code and Zed keep. Read-only, so
it is cheap and cannot be wrong about anything it did not do. Three
states, the 0.17 distinction carried to every agent: connected, not set
up, or registered under a path that no longer exists. A file that is
not there is "not set up", not an error; the agent may simply not be
installed, and the row says so without guessing which.

*What fixes it*: a one-line command where snyvi has one, or a config
snippet where it does not, with a copy button, since the whole page is
"put this somewhere". Beside it, the line for the agent's instructions
file -- `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md` -- with
the same button, because a registration only lets the model send; the
line is what makes it want to. The snippet names the binary the daemon
is running from, absolute when `snyvi` on PATH is not this file, the
way `init-claude` decides its hook line.

*Whether it has worked*: once a document has arrived from that agent
the row says when, because a registration that has never been used is
the exact state the newcomer is stuck in, and "connected" alone would
tell them it is fine. The `initialize` request every MCP client opens
with carries its `clientInfo.name`; the server keeps it and sends it
with every document, the store keeps it beside the document, and the
row matches it by the pieces each agent's name is known to contain. The
page asks the daemon again every few seconds while it is on screen, so
`snyvi init codex` in the terminal beside it turns the row without a
reload.

**`snyvi init <agent>`.** `init-claude` generalised to the files snyvi
can safely own, with `init-claude` kept as the name it has had and
Claude Code kept on `claude mcp add`, since that file is Claude Code's.
The rest turned out to be two writers, not eight: every other agent
keeps a JSON object of servers under one key or another, and Codex
keeps TOML, so all of them are written, and a ninth would be a row in
the table. Everything 0.17 established holds for each: read before
writing, the three outcomes said in three sentences, following a binary
that moved, and `snyvi uninstall <agent>` that leaves whatever else was
in the file. TOML goes through `toml_edit` and comes back byte-equal,
comments and all; JSON is parsed and printed back in the two-space form
the agents write themselves, keys in the order they were, and a JSON
file with comments in it -- Zed's and VS Code's allow them -- is the
honest fallback: the file has something snyvi does not understand, the
snippet is printed, and nothing is edited.

**About.** One panel inside `?`: what snyvi is in a sentence, the
version and the build -- the commit and the target, which `build.rs`
reads from the checkout, so two builds between the same two tags can be
told apart -- the binary, the data directory, the config directory, the
registration line `status` ends with, the license, the repository.
Every line is read from the daemon when the panel opens (`/api/about`),
not baked into the page's bundle, so the panel cannot say a number
`snyvi --version` would not.

**Reset.** `snyvi reset` puts the install back to the page above. What
goes: every document and version, the index, the token -- regenerated
on the next start, so the old one is dead -- and the page's own
preferences, which the daemon tells every open page to drop. What
stays, and this is the part to get right: the agents. Un-registering
them is `uninstall`'s job and touches files that are not snyvi's, and a
reset that quietly did it would mean the next `send_document` fails
against a tool that no longer exists. The default leaves them
connected, so the very next send lands in an empty library, which is
the connect page working. `--agents` takes them out too, for the person
who wants snyvi gone.

It is the one action in snyvi that cannot be undone, where 0.15 made
sure a delete could be, so the friction is real and it is the same on
both surfaces. The command prints one sentence: how many documents in
how many projects, the index, the token, the preferences, and that the
agents stay; then asks for the number of documents typed back. Not
"yes" -- the number means the sentence was read. `--yes` for scripts
and for the bench, refused without a terminal unless given; `--dry-run`
prints the sentence and stops, like `prune`'s; and while anything is
pinned the command refuses unless `--pinned` is also given, because a
pin is the reader's explicit "keep this". In the viewer it is one line
at the foot of the `?` box, with no key, opening a dialog with the same
sentence and the same typed number, the button dead until it matches.
The number is sent with the request and the daemon refuses if it is no
longer true -- a document that arrived while the dialog was open makes
the answer stale, and the dialog says the new number and asks again --
so a library other than the one described is never reset. Then the
daemon empties its store in place and stays up, the token is replaced,
every open page hears it, drops its `snyvi.*` keys and lands on the
connect page with every agent row still saying connected -- which is
the proof the reset did what the sentence said. With no daemon running,
the command removes what snyvi put on disk by name, never a directory
it was merely pointed at.

**Probe.** `bench/onboarding.sh` grew one block for the writers: Codex
`init` into a file that began with a comment and another program's
entry, again with `--instructions`, again after the entry was pointed
at a path that is gone, then `uninstall` and the file byte-equal to
before; Cursor the same in JSON, JSON-equal after; a Gemini file with a
comment in it left alone with the snippet printed; one document through
`snyvi mcp` under Codex's name and the row saying when; and the page's
state read from the daemon at every step. `bench/ui.mjs`, five rows:
`?` reaches it with one row per agent in a home that has seen none; the
sender it never heard of has a row; a Cursor file naming a gone path
turns its row to "needs fixing" and `snyvi init cursor` in a terminal
turns it to connected, neither with a reload; Copy says it copied; and
Back leaves it. Then, shipped with the reset: three
documents sent, `reset --dry-run` says three, `reset` with no terminal
refuses, with a pin refuses, with `--pinned --yes` empties the library,
replaces the token and leaves the agent's file byte-equal to before;
with no daemon and `--agents`, the database and the token are gone and
so is the registration. `bench/ui.mjs`, the five rows shipped with it:
`?` offers it and nothing else does; the dialog says what goes with the
cursor in the field and the button dead; the button waits for the
number; a stale number is refused and the sentence brought up to date;
and a reset lands on the empty library with a preference forgotten and
no `snyvi.*` key left in storage. The about box, three rows: `?` opens
it in the help box's place; every fact on it is what `/api/about` says,
the version with the commit; Escape closes it and the page is live
again. The reset lands on the connect page with the Cursor row still
connected, which is the proof the reset did what the sentence said.

What this is not: a tour, coach marks, a checklist that persists. They
are chrome, and the reader with three plans waiting has already learnt
the program. The page appears once, to exactly the person who needs it,
and is gone when the first document lands.

## 0.19: who is here

The window's brand mark, since 0.18, says whether the page hears the
daemon. Nothing said whether anyone was on the other end of it. The
daemon learnt of an agent only when one sent: `snyvi mcp` spoke to it
at send time and never otherwise, so with ten Claude Code sessions open
the daemon could name none of them, and the connect page's "sent 12
minutes ago" was as true of a session closed for eleven as of one about
to send again.

**The stream.** On `initialize`, the MCP server takes the client's name
and a thread holds `GET /api/events?agent=<name>` on the daemon for as
long as the process lives -- the same stream the window's page holds
with `?window=1`, counted by the same mark, so an agent is here for
exactly as long as its stream is and nothing has to time out. No daemon:
the thread asks again every three seconds, which is a refused connection
each time and nothing more; the first send starts one and the next ask
finds it. A daemon that stops ends every stream, since 0.18, and the
thread finds the one that took the port the way the page does.

**What it shows.** `/api/health` carries `agents`, the names and how
many of each; the boot payload and `/api/agents` carry the same map, and
an `agents` event says when it changes, so the page never polls for it.
Beside the brand mark, a count: dim at zero -- "no agent is connected"
is the answer it is asked for most -- and the accent once one is here,
with the names in its title, and it opens the connect page, whose rows
say *online*, and *online ×3*, in place of *connected*. `snyvi init`
with no agent prints the same. The mark keeps its one meaning; the
count is the other question.

**The probe.** `bench/ui.mjs`, four rows: the count says none; a real
`snyvi mcp` initializes and the count turns, with health agreeing; the
count opens the connect page and the row says online; the process ends
and the count falls. And the arm64 runner's "shortcut reaches the
window" step, which had failed three pushes on three unrelated commits:
every failure was four `IsViewable` in a row, which is the toggle's
*show* branch four times -- the manager had not given the window focus,
so the probe was pressing a key at nobody. The step now asks for focus
and checks the active window before every press.

## 0.20: a link that opens in the window

0.15 settled the case with a window up: the tool says the document is
waiting in snyvi and gives no link, because the only link it had was
`http://127.0.0.1:7777/d/…`, and a click on that opens a browser. It
left the other case as it was. With the window closed -- put away to the
tray, or never opened this morning -- the agent still handed out the
`http://` link, and a click on it opened a second viewer in a browser
beside the one the window would have been, one `snyvi app` away. The
link was the wrong kind, not the wrong address.

**The link.** `snyvi://d/<id>` is the same document, for the desktop
rather than a browser. `send_document` answers with it as `app_url`
beside `url`, and the tool tells the model to give it and to put the
`http://` one after it in brackets -- but only where the machine has a
window executable for the desktop to hand it to, read the way the daemon
has always looked for one: beside its own binary, then on `PATH`, then in
the places a Mac drags an application to. Anywhere else the link would
open nothing, and the answer is the `http://` link as before. With a
window up, still no link at all: that answer was right and stays.

**Where it goes.** Three ways for the desktop to know that `snyvi://` is
snyvi's. The `.deb`'s desktop entry now says `MimeType=x-scheme-handler/snyvi`
and runs `snyvi app %u`; `snyvi.app`'s Info.plist declares the scheme in
`CFBundleURLTypes`, which Launch Services reads the first time it sees
the bundle; and for a tarball or a zip, where nothing installs an entry,
the window claims the scheme for itself the first time it runs, on Linux
and Windows, through `tauri-plugin-deep-link` -- unless something else
already answers for it, which is a choice and is left alone. The plugin
does registration only. Delivery is what the window had already: on
Linux and Windows a link arrives on `argv`, and the single-instance
plugin passes it to the window that is up or lets this process become
one; on macOS it is the run loop's `Opened` event, since a link there
never comes as an argument.

`snyvi app` takes an argument now -- a `snyvi://` link, a document id, or
a URL on the daemon -- and does from a terminal what a click does: hands
it to a window that is up, which comes forward on it, or starts the
daemon if it must and becomes the window. A window handed a link reads
it against the origin it is already showing, so no environment travels
with the click. The mark that says a page is a window joins whatever
query a URL already carries, where before it was appended as a path.

**One thing to know.** A terminal decides for itself which links are
clickable, and several -- kitty, Ghostty, the VTE family -- know a fixed
list of schemes. `snyvi://` can usually be added (kitty's `url_prefixes`,
for one), and the `http://` link is always given beside it. And a
machine that ran the window from a tarball and then installed the `.deb`
keeps the tarball's handler as its default until any window runs again,
which rewrites it to wherever the window now is.

**The probe.** Six rows in `bench/ui.mjs`, deciding for themselves
whether a window executable is installed: the daemon runs from a copy in
a directory of the probe's own, with no `snyvi-app` beside it and none on
its `PATH`, and the rows write a stub there and take it out. No stub: the
send and the agent get the `http://` link alone. Stub: `app_url` is the
scheme and the id, and the agent is told to give it with the `http://`
one beside. The stub writes down what it was handed, which is how `snyvi
app <link>` is read on a machine with no display: the address the link
stands for, marked as a window when it starts one, with the mark joined
to a query that was already there, and bare when it is handed to a window
that is up -- and with one up, the agent is given no link at all. Watched
by hand on this desktop too, all four paths: no window, a window up, no
daemon, and `xdg-open` with nothing in its environment.

## 0.21: the front page

The README was the manual. It said everything -- the install on each
desktop, every command, every agent, the window, the keys, where things
live, what the bench reads -- in 860 lines, and the first screen of it
on GitHub was a paragraph and `## Install`. Nobody saw the product before
being asked to `dpkg -i` it, and nothing on the page was a picture; the
repository had never held a screenshot. The voice is the project's asset,
so the page is not replaced but given a front door: the manual moves to
`docs/GUIDE.md` word for word, its anchors intact, and the README is what
a reader sees first.

**The page.** The mark, one line, four badges, the film, the hero in
whichever theme the reader's browser is in (`<picture>` with
`prefers-color-scheme`, which GitHub honours), and the pitch. Install in
four lines per desktop, with the guide for the rest. Six pictures in two
columns, each with one sentence saying the one thing it shows: an
arrival that never takes the page away, `c` against the version before,
a diagram drawn in the page's colours, a source file with its outline,
`⌘K` across the library, and the connect page. Then how it works in a
paragraph and six commands, ten keys, the seven numbers that matter, and
the links out.

**The camera.** `bench/media.mjs`. A daemon of its own on 7798, from a
copy of the binary first on `PATH` so agents register it by name and no
temporary path is in the pictures; a home of its own with three agents
registered and one of them a real `snyvi mcp` under Claude Code's name,
held open, so the count beside the mark reads 1 and the connect page says
*online*. The library is seeded from `bench/seed`: one project, `ledger`,
on a branch, with a plan for rate limiting the public API, a review of
the PR, the plan again as revised, the reviewed source file from another
agent, and a summary that arrives while the plan is being read; and a
second project so the sidebar has a shape. Written to look like what an
agent sends, because the pictures are only as good as what is on the
screen, and the fixture prose the probes read is noise on purpose.

Chromium at 1440x900 and 2x, both themes, WebP at quality 92: sixteen
pictures in 3 MB, crisp at the width GitHub draws them. Two things the
camera had to be told that the probe never did. Headless Chromium says
it has no pointer that hovers, so everything the page shows on hover --
the `#` on a heading, Copy on a code block, a diagram's zoom -- showed
everywhere, and `Emulation.setEmulatedMedia` cannot say otherwise; a
`--blink-settings` flag can, and `launch()` in `bench/chrome.mjs` takes
extra arguments now for a caller that is not measuring anything. And
`c` compares with the document before it in the workflow, not the
version before it of the same file, so the two plans are sent last and
adjacent.

**The film.** Thirty-five seconds in two panes. Above, a Claude Code
session: the reader asks for the plan to be revised against the review
and sent, and the model's `send_document` call is made for real -- the
script makes it through the `snyvi mcp` it holds open, and what the
terminal prints under the call is the reply that came back, the one a
reader with the window open gets: *waiting in snyvi, at the top of the
queue, tell the user rather than giving a link*. Below, the viewer, as
the window: the plan being read, the bar saying one is waiting at the
moment the reply lands, `n`, `c`, the diagram drawn on the way down,
`⌘K`. The words in the terminal are a re-enactment; the call and the
reply are not. Each pane is its own headless Chromium's screencast --
one paints only the tab in front, so two tabs in one give one screencast
and a blank -- every frame with the time it was painted, on one clock,
and ffmpeg stacks the two into one constant-rate mp4 of 1.8 MB. `f` is
not in it: it goes fullscreen, and a headless screen is 800x600 whatever
the window, which leaves the viewport another size for the rest. No gif:
half a minute of a full page does not go under 7 MB with the text
readable. GitHub plays a video inline from a `user-attachments` URL and
nothing else, so the film is added to the README by hand once -- dropped
into a comment box, and the link it gives pasted on a line of its own --
which an agent's token cannot do, and the README says so in a comment
where the line goes.

**The probe.** CI takes the stills into a folder it throws away, so a
view the camera points at that has moved fails the push rather than the
release. The film is left to the release, since it needs ffmpeg and a
minute.

## After 0.21: the film is a hero

The film was two panes and no words: a terminal set flush over the
viewer, which read as one program with a terminal in it, for thirty-five
seconds, ending on a palette with a word typed in. A reader who did not
already know what the queue was had to infer it from a bar that said
"1 waiting", and nothing said what the thing was called or where to get
it.

**A stage.** The two are windows now, on a desktop, apart, each under a
title bar of its own: *Claude Code — ~/ledger* above, dark, and *snyvi*
below, light, with the mark. Two cards open the film and one closes it,
in the order a product film runs: the problem, the name, the take, and
where to get it. The first card has no mark and says what the trouble
is -- your agents write all day, and what they write is read as raw text
in a terminal or dug out of a folder by hand and gone by the next
session. The second is the mark, the name and the line the README opens
with. The last has the link, and the line the README's install section
ends on, since it is the thing a reader of a film about agents wants to
know: it runs on your machine, one static binary, nothing phones home.
The bars and the cards are HTML, drawn by the same Chromium in the
page's own Inter, so nothing is set in a font ffmpeg found; ffmpeg stacks
each window under its bar, lays both on the desktop, crossfades the cards
in and out and fades to black. 1488x1036, seventy-six seconds, 3.7 MB.

**A voice.** Eleven lines say what is on the screen as it happens: one
for each card, and one for what the plan is, what is asked above and where,
that the call is real, what the reply means, and `n`, `c`, the diagram
and ⌘K. The voice of the README, not a pitch. They are spoken by a
text-to-speech model through OpenRouter's speech endpoint, which takes
the OpenAI shape and answers with the bytes, so it is one `fetch` and no
dependency. Each line is fetched once and kept under
`~/.cache/snyvi-media` by the hash of the model, the voice and the words,
so a re-take costs nothing and a changed word costs one line.
`SNYVI_TTS_MODEL` and `SNYVI_TTS_VOICE` pick another voice; the default is
Microsoft's MAI Voice 2, which is what OpenRouter's own example uses.
Without `OPENROUTER_API_KEY` the film is silent and says so: CI has no
key and takes only the stills.

The timing runs the other way from what a voice-over usually is. The
lines are fetched and measured before the first frame, and each beat of
the take is a cue: it stamps the moment on the clock the screencast's
frames already carry, and it does not begin until the line before it has
ended -- so the picture holds for the voice, and the voice is never cut
by the picture. The cards are held for their lines the same way. The
take grew from 34 to 47 seconds, all of it beats waiting for a sentence
to finish; ffmpeg lays each clip at its stamp, moved by where the take
begins in the film, and mixes them under the picture.

**Music.** An instrumental bed under all of it, from a music model
through the same endpoint -- asked for as a chat completion with audio
among its modalities, which answers only as a stream, the mp3 arriving
in base64 pieces on the deltas -- and kept the same way as a line, so it
is bought once. Ninety seconds, asked to be calm, steady from the first
bar and without a melody that competes with a voice. It sits about six
decibels under the lines, fades in over the first two seconds and out
over the last three, and is compressed against the voice, so it steps
back while a line is being said and returns between them.

## After 1.0: the film is cut, not recorded

The 0.21 film was honest and dull. Everything above it is true and none
of it made anyone want the thing. Three reasons, and only the first was
a matter of taste.

**It was one long take of a page being read.** A headless Chromium paints
only when something changes, so `Page.startScreencast` over a document
came back at about three frames a second: a scroll that stutters, and
seventy-six seconds of it. Measured on the same beats the new camera
takes: twelve frames for 4.2 seconds, twenty-seven for 7.9. Nothing in
the grade could fix a source that had no frames in it.

**So the camera takes stills.** `film/capture.mjs` drives the same seeded
daemon and photographs each beat at 2880x1800 instead of recording it.
The composition pans those, punches into them and cuts between them at
sixty frames a second, which is both sharper than the recording and more
motion than the recording ever had. Each frame is then kept at the width
the film actually magnifies it to -- 1800 across for a window held at
1144, 2200 for the one held nearly full frame -- because the full 2880
cost three hundred megabytes of decoded bitmap and six seconds of load
for pixels nothing ever shows.

**It was ffmpeg stacking rectangles.** The stage was two screencasts, two
title bars and three cards, composed by a filter graph. That is a cut
list, not a design: there was no way to put a word on the screen, hold a
number, or show a key being pressed. The film is a HyperFrames
composition now -- `film/index.html`, twelve scenes on one paused GSAP
timeline, rendered frame by frame from the DOM -- so the things the
README says in prose can be said in pictures: the three words the first
line names, struck one at a time; the keycap for `n`, `c` and ⌘K, pressed
on the beat; the four measured numbers counting up against their budgets;
the eight agents landing as their names are read.

**The words land on the words.** The old film's timing was a queue: a beat
waited for the line before it to finish. That keeps the voice from being
cut, and it also means the picture is always a little behind. Each line's
mp3 is now measured with `silencedetect` for the pauses the voice actually
leaves, and those seconds are written into `film/beats.js` as the beat's
cues -- `plans` at 1.92, `reviews` at 2.76, `reports` at 3.62. The
composition reads the same file the mixer does, so a word and the thing it
names arrive together, and the two cannot quietly disagree: `film/mix.mjs`
refuses to run if an mp3 has drifted more than sixty milliseconds from
what the clock claims.

**And it is set in the product's own two faces.** Source Serif 4 at its
display cut for the statements, JetBrains Mono for every key, command and
number -- the two snyvi renders documents with. The argument the film
makes is that a stream of tokens becomes a document a person reads, and
fixed pitch against optical sizing is that argument in letterforms.
`film/DESIGN.md` has the palette and the rest of the reasoning.

**The name, twice.** 0.21 found that a voice given `snyvi` says it three
ways in one film, and spelled it `snyvee`. That was not enough either: the
new voice read the same spelling as `/ˈsnaɪvi/` in the reveal and
`/ˈsniːviː/` in the outro — one take, one voice, two pronunciations, three
sentences apart. It is spelled `snigh-vee` now, on the grounds that `igh` is
the one English spelling never read any other way. The lesson is not the
spelling, it is the checking: a model that takes audio will say what it
heard, so every line carrying the name is listened back to after it is
recorded, and six candidates were put through both sentences before one was
chosen. `film/README.md` has the method.

**And CI watches this camera too.** The stills camera has had a step since
0.21 that takes the README's pictures into a folder it throws away, so a
view that has moved fails the push rather than the release. `film/`'s camera
points at views of its own — the arrival bar, the diff, the palette, the
outline — and now has the same step beside it. Cutting the film is still a
release-day job; proving its frames can still be taken is not.

Ninety-four seconds, 1920x1080. `film/README.md` is how to cut it again.

## After 1.0: a way in that is not a download

1.0 shipped with every row of this file closed and a repository with no
stars and no topics. Its install story was the releases page: pick the
right one of twenty-two assets, unpack it, and on a Mac, get past a
refusal. Nothing that follows makes reading better or faster, and it is
here anyway, because none of that matters to a reader who never gets to
the first document.

**`cargo install snyvi`.** The crate was already shaped for it, since the
window has been behind the `desktop` feature since 0.6: default features
build the static daemon and CLI and never link WebKitGTK. What stopped
it was size. `cargo package` swept in the film's narration and the
README's pictures and came to 18.2 MB, against a cap of 10. An `exclude`
list brings it to 2.2 MB compressed, and `cargo package` builds from the
packaged tarball with the checkout out of reach, so a missing file fails
here, not on someone else's machine. The name was unclaimed.

**`brew install --cask snymrova/snyvi/snyvi`.** A cask, not a formula,
because the macOS download already is an app with the CLI inside it.
`packaging/homebrew.sh` writes it from the `.sha256` files the release
uploaded, so the cask can only claim hashes the release published. It
was checked against 1.0.0: the arm64 hash it read is the hash of the
tarball downloaded, and the `app` and `binary` paths are the paths in it.
The cask takes the quarantine off what it installs, which is a decision
and not a detail: the bundle is signed ad-hoc, Homebrew quarantines like
a browser, and without it the first open is the refusal the guide spends
a paragraph on. Notarisation is the real fix and needs a paid account.

**Neither is bumped by hand.** Two jobs at the end of `release.yml`,
after every binary is on the release: `crate` publishes, `homebrew`
writes the cask and pushes it to the tap. Each is skipped with a warning
rather than failed when its token is missing, so a release is never held
up by a channel. A version in a package manager that someone has to
remember to change is a number enforced by nothing, and this file has
named that failure enough times.

**Windows is a `setup.exe`.** The zip was five steps before anything
opened: pick a folder, unzip, open a terminal there, `install-cli`, open
another terminal. `packaging/windows.iss` is an Inno Setup installer that
does the same things and asks only whether to go on. It installs for the
reader alone into `%LOCALAPPDATA%\Programs\snyvi`, so there is no
administrator prompt. It adds a Start menu entry, puts the folder on the
user's `PATH`, runs `init-claude --auto`, and opens the window at the end. An
upgrade stops the daemon and the window before replacing them, and the
uninstall takes snyvi out of Claude Code and off `PATH` but leaves the
library alone. Building it turned up a bug: `snyvi-app.exe` was built as
a console program, so opening it from anywhere but a terminal would have
put a console window beside the viewer. The same would happen when it
started `snyvi.exe`. Both are fixed. CI now reads the subsystem out of the
PE header and runs the installer silently: install, open the Start menu
entry's target, check that a daemon and a window came up, uninstall, and
check that they went. SmartScreen still asks once, because neither the
installer nor the executables are signed. The zip stays on the release for
a folder managed by hand.

What is a person's: claiming the crate name with the first `cargo
publish`, creating `snymrova/homebrew-snyvi`, and setting
`CARGO_REGISTRY_TOKEN` and `HOMEBREW_TAP_TOKEN` on this repository.
Unwatched: the cask installed on a real Mac. `brew audit` and a first
open after the postflight are the check.

## 1.0.2: a link that leaves

0.20 settled which link an agent hands out, and where a click on one
goes. It said nothing about the links already inside a document, which
are the ones a reader actually clicks: every plan an agent writes
carries them, to a repository, to an issue, to a file beside it.

**What it was.** comrak writes a bare `<a href="...">`, and the viewer
is a page. In a browser tab that is merely rude: the viewer is replaced
and Back comes home. In the window it is a dead end, because there is no
address bar and no Back button -- Back is the page's own key handler,
and a page from somewhere else does not have it. A click on a link to a
repository left the reader on that repository with nothing to come home
by but the tray. The other direction was worse in both:
`[notes](./notes.md)` in a sent document resolves against `/d/<id>`,
which is not a page the viewer has, so it landed on a bare "Not found"
-- in the window, with no way back at all.

**Sorted where the document is made.** The renderer stamps every link
once, at receive time, the way everything else here is done once per
document and never again: `target="_blank" rel="noopener noreferrer"`
and `data-ext` for `http` and `https`, `data-ext` alone for a scheme the
desktop answers for -- `mailto:`, `file:` -- and nothing at all for a
fragment or anything relative, which stay inside snyvi and are the
client's to resolve. A pass over the rendered string rather than the
AST, because comrak's `Link` node carries a URL and a title and no way
to add an attribute. The one thing that had to be told twice is
ammonia: `target` and `data-ext` are on neither of its lists, so a
document with raw HTML in it would otherwise have been the one kind
whose outbound links still opened in the viewer. `data-ext` is also
what the `↗` hangs on, so a link says it leaves before it is
followed -- never on a link wrapped around an image, where the mark
would land in the middle of the picture.

**The window keeps its origin.** `on_navigation` measures every
navigation against the origin the window was opened on and hands
anything else to the desktop, and `on_new_window` does the same for
`window.open` and `target="_blank"`, which the engine treats as a
request for a second window rather than a navigation. snyvi has one
window, so those go out too -- including the viewer's own "Open
source", whose raw text is a thing to read beside snyvi rather than
inside it. `about:` stays: it is the engine's own, a frame with nothing
in it yet, and not a place a reader can be stranded. The opener is
written again in that binary rather than borrowed, because it links
none of the library -- which is the point of it being separate -- and a
URL that would not open is a line on stderr and never a window taken
down.

**And the page for what is left.** Same-origin and unmarked falls in
three parts. A document or a browsed file is a place in snyvi, so it is
navigated to without a reload, which is how a relative link between two
files in a browsed folder comes to work at all. The inbox and the
connect page are pages too. Anything else same-origin is not a page
this viewer has, and says so in a toast that names the path and offers
the browser for the reader who meant it, rather than replacing the
document with "Not found". A document rendered before any of this
existed keeps the HTML it was given, so the page sends an unmarked
cross-origin link away itself.

**The probe.** Five rows in `bench/ui.mjs`. The web is read as an
attribute rather than clicked -- a click on it is a second tab, and
what the native window does with one is `stays_home`'s to say, under
test beside it in `src/bin/app.rs`. Everything same-origin is clicked
for real: the relative path raises the toast and the document is still
open behind it, and a link to another document turns the page without a
load. Both render paths are covered in the renderer's own tests, since
the sanitized one is the path that forgot.

What remains a person's: the click itself, in the window, on each
desktop. `on_navigation` and `on_new_window` are the toolkit's callbacks
and no harness here drives them -- what is checked is the decision they
hand a URL to, which is `stays_home` and is a unit test. That a browser
comes forward with the page, and that the window stays where it was, is
watched by hand.

## 1.2: the click, a line beside the work, and the page's own weight

**What it was.** A 6,000-line Rust file, opened from the sidebar, froze
the tab for 2.3 s. Every bench in the tree measured a half of that
gesture and none measured the whole: `snyvi bench` times the renderer
and the daemon, which is over before the browser has anything;
`bench/browser.mjs` times a cold page load, which a reader pays once a
session; `bench/ui.mjs` never looks at a clock. The click -- a row in
the sidebar, a document on screen -- is what a reader does most, and it
was the one thing nothing watched.

**A long code block arrives cut up.** `chunk_code` splits a `pre.code`
over 400 lines into 200-line spans, each carrying the line number it
starts at, so `content-visibility` can skip the ones off screen and the
page lays out the two or three that are not. It happens where every
other per-document cost here happens -- once, at receive time, and at
browse-cache time so the files already in a folder get it too. The
layout tree for that Rust file is 13,985 objects against 234,385 with
containment off, and the open is 439 ms of an 800 ms budget -- of which
the reader waits 6 ms before the page says anything at all.

**And its outline is worked out once.** The rail's outline for a code
document was derived on every open, from the highlighter's scopes,
which is a pass over the whole file to fill a list nobody had asked to
change. It is computed on arrival and kept in an `.outline` beside the
document, invalidated when the document is and swept when it is
evicted; a browsed folder keeps its own in an LRU, because a file on
disk has no arrival to hang it on.

**The sidebar waits its turn.** The tree, the history and the workflow
were rebuilt in the same turn that put the document on the screen, so a
reader waiting for a document waited for a list beside it as well. They
happen after the first paint now, and `bench/open.mjs` holds the order:
zero sidebar rows rebuilt before the reader sees the page, and the row
that was clicked marked at once, in four attribute writes, without
touching the rest.

**And the click is answered before any of that.** All of the above makes
the wait shorter and none of it makes the wait visible: `showDoc` put
nothing on the page until the whole document had been fetched and
parsed, which for the Rust file is 1.5 MB of HTML, so the gesture had no
answer at all for as long as that took and a long file read as a frozen
window. It does not wait to say something now. The title comes from the
row that was clicked -- the sidebar knew it already, and every list that
names a document records what it knows -- and under it are bars where
the text will be. The bars are invisible for their first 200 ms, so an
open that lands at once shows no skeleton and one that does not says so
before a reader can wonder whether the click landed; a document already
in hand skips the shell and goes up whole, as it always did. A second
click while the first is still coming wins, and the first is dropped
rather than painted over what the reader asked for next.

**The probe had to move again, in the same way as the last one.** The
shell is a `.prose` too, and `bench/open.mjs` anchored its clock on the
first `.prose` under `#doc` -- so the moment it existed the bench began
timing the answer to the click and calling it the document: 10 ms for a
file that takes 439. It waits for `.prose:not(.sk-body)` now, and the
shell is a column of its own beside it, with a budget of one frame. Both
halves are the truth and neither is the whole of it: `shell` is what the
reader gets at once, `total` is when they can read.

**Going somewhere, in the engine the window uses.** WebKitGTK refuses
`scrollIntoView` outright when the target is inside a subtree it has
skipped -- which, after the change above, is most of a long file. An
outline entry for line 2531 and an agent's `#L2531` both left the
document at scroll 0 with the line 52,525 px away, and a find match
8,879 px down was marked and never reached; all three worked in
Chromium, which is why none of it had been seen. The page moves the
scroller itself now and corrects until the target settles.
`bench/webkit.py` has the rows.

### A note beside the work

Two entries under "Explicitly not planned" refused this, and they were
right about what they feared. What they were wrong about was that the
fears had no answer.

*"Every arrival is work."* Still true, because a note is not an
arrival. It never enters the queue, marks nothing unread, and takes no
page away; it is a line at the foot of the sidebar, where the reader
looks when they choose to.

*"Something inferred about the reader reads as surveillance."* Nothing
is inferred. A note is a sentence an agent chose to write about the
work it is doing, the way a friend at the next desk would -- not a
reading of the person.

*"There is no test for 'the message was welcome'."* There is no test,
so the design makes the question small: 280 characters, the last five
kept, nothing on disk, and at most one lighting up every ten minutes.
An agent that sends one per edit costs a single glance, and a restart
forgets them, because a note is about now.

*"The softest target a document can aim an agent at."* This is the one
that stays sharp. A note is free text an agent was persuaded to send,
and a document it read can do the persuading. The mitigations are that
it is text and only text -- escaped, capped, and carrying nothing but an
optional document id, which opens a document the reader already has or
nothing at all -- and that it cannot ask for anything: there is no
channel back, and nothing a note says
reaches a desk. The remaining exposure is a sentence the reader did not
want, which is the cost of the feature and is bounded by its size.

*"The warmth belongs to the product's own voice."* This is the half
that did not survive, and it is worth naming plainly rather than
pretending the entry was honoured.

**The mark answers.** snyvi's own icon is the one mascot on screen and
the note is its voice: a waiting note perks it up, it hops once when
one arrives, resting on the note gets a smile, and a page with no
daemon to hear puts it to sleep. "One frame, not a life" was the rule,
and the rule was nearly broken by an accident: `data-note` was written
as `""` when there was nothing to say, and an attribute selector
matches an empty value, so the blink ran on every page from boot for
the life of the tab. `bench/ui.mjs` has said "nothing runs long" since
0.14 and it is what caught it. The attribute is removed rather than
emptied, and the mark blinks while a note waits and stops when the
reader rests on it.

### The mark, the colours, and two more faces

The three-lines mark was drawn for a tray at 16 px and had never been
anything else. `packaging/icons.py` draws a face now, in two cuts -- the
full one above 48 px, a simpler one below, where the detail turned to
mud -- and the same face is the mascot in the chrome.

Eight accents come with it: maroon, crimson, rose, violet, blue, teal,
green, graphite, each a pair rather than one colour dimmed for both
themes, chosen from a swatch in the sidebar's foot and painted into the
tab's icon so two windows are told apart at the tab strip.

And two reading faces, which are not a matter of taste: Atkinson
Hyperlegible, drawn by the Braille Institute to hold apart the letters
that collapse into one another, and Literata. Both are OFL, and the
licences ship with them -- `ui/fonts/OFL.txt` and the Debian copyright
file, which declared `Files: *` MIT while the binary had carried
embedded OFL faces since the first commit.

### A folder, from the desktop's own dialog

`snyvi browse` was the only way to open one, which meant a reader in the
window had to find a terminal. **Folders** is always in the sidebar now,
and the `+` beside it asks the daemon to ask the desktop -- zenity,
kdialog or yad on Linux, the Finder's panel on macOS, Explorer's on
Windows. The page never names a path and never sees one it did not
choose; it sits behind the same window-only capability as the desks,
and a browser tab is told to use the window or the command instead.

### A pane that comes back

A desk survived a daemon restart as a layout and not as a shell: the
panes came back empty and stayed empty. They ask for themselves now,
once, and a pane that was mid-start when the daemon went says so rather
than looking finished.

### The page pays for what it uses, again

1.1 moved the diagram driver out of first paint and bought 12 KB of the
60 KB budget. 1.1 through 1.1.2 spent all but 1.3 KB of it, and the work
above put first paint at 72.7 KB -- 12.7 over, with `bench/bytes.mjs`
red on every push.

Chunking was the obvious answer and it did not reach: measured on true
spans rather than between section headers, every feature that could
honestly be deferred -- the connect page, the folder menu, the accent
picker, reset, the palette, find, about -- came to 7.8 KB of JavaScript.
Not enough, and it would have put seven features behind a fetch to buy
less than half the debt.

What the page was actually carrying was its own prose. This codebase
writes long comments on purpose and a browser reads none of them: 19.2
KB of `app.js`'s 50.3 and 6.9 KB of `app.css`'s 18.7 were comments and
indentation, on the wire, on every first paint. So `build.rs` runs each
asset through `src/strip.rs` on the way into the binary and the daemon
embeds the result. The source keeps every word, and `SNYVI_UI_DIR`
still serves it as written, because the dev loop is where a person
reads it. First paint is 48.9 KB and the budget is 50 -- 45.2 KB when
this landed, and the shell above it spent most of what was left.

It is a scanner and not a pass of replacements, because `"https://"`
holds a `//`, a regex may hold a `/*`, and a template literal's own
newlines and indentation are text the page shows. It removes comments,
indentation and blank lines and nothing else: no name is shortened and
no two lines are joined, so automatic semicolon insertion sees the
program it saw before. A minifier would have taken another 6.9 KB and
wanted either a Node toolchain inside a Rust build -- which
`bench/browser.mjs` argues against for the harness and the binary argues
against harder -- or a dependency tree bigger than the win; the option
is still there if the budget is ever tight again.

**And the probe had to move with it.** `bench/bytes.mjs` read `ui/` off
disk, which stopped being the bytes anyone fetches the moment this
landed. It starts a daemon and asks it now, exactly as a page does, and
it checks one more thing while it has them: that every asset parses. A
strip that ate a brace cannot pass quietly.

**One thing the benches were not measuring.** A page with no stored
theme follows the system, and headless Chrome answers with the
desktop's -- dark on a developer's box, light on a hosted runner. So the
legibility pass labelled "light" had been measuring whatever the machine
preferred, and the theme toggle went dark, light, dark and landed on the
colours it started in, which reads exactly like a diagram that was never
redrawn. The harness pins `prefers-color-scheme` to light now. Neither
row was ever about snyvi, and both had been saying something for months.

## Not yet watched on Windows or macOS

The build, the tests, the daemon and the window are all exercised by CI
on a Windows runner and, since 0.16, on two macOS runners. What no
runner shows is a desktop in use. On Windows: the installer clicked
through by hand, the toast, the tray's
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
