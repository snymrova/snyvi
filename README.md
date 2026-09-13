# snyvi

A fast, beautiful viewer for the documents your agents produce.

You ask Claude Code for a plan. It writes one. With snyvi, Claude sends
the document and replies with a link; by the time you read the reply, the
document is already open in the viewer, rendered, and filed under the
project. Markdown and every kind of source file. One direction only:
agents send, snyvi shows.

## Install

### Debian and Ubuntu

Download `snyvi_<version>_amd64.deb` (or `_arm64.deb`) from the
[releases page](https://github.com/snymrova/snyvi/releases):

```
sudo dpkg -i snyvi_*.deb
snyvi send README.md                              # starts the daemon, prints a link
snyvi init-claude                                 # register with Claude Code
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

Download `snyvi-<version>-x86_64-pc-windows-msvc.zip` from the same page
and unzip it somewhere on your `PATH`:

```
snyvi send README.md                              # starts the daemon, prints a link
snyvi init-claude                                 # register with Claude Code
snyvi app                                         # a window of its own
```

One download, both executables, nothing to choose. `snyvi.exe` is
everything — daemon, CLI, MCP server, hook — and `snyvi-app.exe` is the
native window; keep them in the same folder and `snyvi app` finds it.
There is no separate package for the window the way there is on Linux,
because it uses WebView2, which is part of Windows 10 and 11 rather than
a library to go and install.

### Any other Linux

Download the tarball for your architecture from the same page:

```
tar xzf snyvi-*-linux.tar.gz
install -m 755 snyvi-*/snyvi ~/.local/bin/snyvi   # or /usr/local/bin
snyvi send README.md
snyvi init-claude
```

### Updating

snyvi runs as a background daemon, so a new binary on disk does not take
effect until the old process exits. Install over the old one
(`sudo dpkg -i snyvi_*.deb`, which says the same thing), then:

```
snyvi restart
```

That is the whole update. Your documents, database and token are kept,
and the schema migrates itself. If you forget, any snyvi command tells
you:

```
note: snyvi 0.2.0 is still running but this binary is 0.3.0.
Run `snyvi restart` to pick up the new version.
```

`snyvi status` shows both versions, `snyvi stop` shuts the daemon down,
and both work against daemons old enough to predate the stop command.
Under systemd use `systemctl --user restart snyvi` instead.

It is fully static (musl), so it runs on any x86_64 or aarch64 Linux
without extra packages. To build from source instead:

```
cargo install --path .
```

One binary, no runtime, no network access ever. It embeds its own UI,
fonts, and syntax grammars.

To keep the daemon resident from login rather than letting the first
send start it, enable the user service. The `.deb` already ships one:

```
systemctl --user enable --now snyvi
```

From the tarball, write it first:

```
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/snyvi.service <<'UNIT'
[Unit]
Description=snyvi document viewer
[Service]
ExecStart=%h/.local/bin/snyvi serve
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
systemctl --user enable --now snyvi
```

## Use

```
snyvi send PLAN.md                 # send a file, print its link
cat notes.md | snyvi send -t Notes # send stdin
snyvi watch PLAN.md                # send now, and again on every save
snyvi browse [dir]                 # read a folder from disk, nothing stored
snyvi open                         # open the viewer in the browser
snyvi app                          # native window (see Desktop below)
snyvi init-claude [--auto]         # register with Claude Code (user scope)
snyvi prune --days 30 [--dry-run]  # delete unpinned documents older than N days
snyvi status                       # daemon health and version
snyvi restart                      # after installing a new binary
snyvi stop                         # shut the daemon down
snyvi bench [--check]              # render speed on synthetic documents
```

The first `send` starts the daemon in the background; it stays resident
(about 25 MB) so every later send and every page open is instant. It
listens on `127.0.0.1:7777` only. Set `SNYVI_PORT` to change the port.

### Claude Code

`snyvi init-claude` runs `claude mcp add --scope user snyvi -- snyvi mcp`.
That exposes a single MCP tool, `send_document`, which takes a file path
or inline content and returns a URL. The tool description tells Claude
when to use it; a line in your global `CLAUDE.md` helps it remember:

> When you produce a document for me to read (plan, review, summary),
> send it to snyvi with send_document and give me the link.

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
| runs on | any Linux, both architectures | Ubuntu 22.04+, Debian 12+, amd64 |
| resident | 35 MB | ~380 MB while a window is open |

Those are the Linux numbers, where the two are packaged separately. On
Windows both are in the one zip and the window costs whatever WebView2
already costs the machine.

That separation is the point. Before 0.6 the window was compiled into
snyvi itself, so a machine that wanted one got an engine linked into the
daemon too, and `snyvi serve` sat at 66 MB having never opened a window.
Now it is 35 MB whether or not you have the window installed, and the
engine is paid for only while you are looking at something.

From source, `cargo build --release` gives you snyvi alone; add
`--features desktop` to get `snyvi-app` beside it.

### Keys

| Key   | Action                                     |
|-------|--------------------------------------------|
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
| ⌫     | delete document                             |
| i     | inbox                                       |
| f     | fullscreen the diagram                      |
| 0     | fit the diagram                             |
| t     | toggle contents                             |
| \     | toggle sidebar                              |
| o     | open source                                 |
| ?     | show keys                                   |

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
page rather than arriving from somewhere else. Both themes are checked on
every build: every label has to stay legible against whatever is behind
it.

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

An `.html` file opens as source, because in a repository the markup is
usually what you want; `v` shows the page itself. A `.pdf` opens in the
browser's own viewer, and `v` goes the other way.

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

## The rail

Prose gets a table of contents. Code gets an outline of what it declares:
functions, types, implementations and modules, nested by indentation and
marked by kind. Clicking one jumps to that line and highlights it.

The outline comes from the same grammar the highlighter uses, so it
follows the language rather than guessing with patterns, and call sites
and builtins stay out of it. It is fetched after the page has painted,
so it never delays reading.

## Browsing a folder

`snyvi browse` opens the folder you are in as a file tree and renders
files as you click them. Nothing is stored, nothing joins the library,
and nothing appears in the inbox. It is a reader for code and notes you
already have, not an import.

```
snyvi browse            # the current folder
snyvi browse ~/code/foo
```

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
the rest is highlighted in the background and swapped in when ready.

Mermaid blocks render as diagrams; the library is embedded and loaded
only on pages that have one, after the text has painted. Relative
images in a document sent by path are served from the file's directory,
confined to the project root and to image types.

Search understands `p:project` and `kind:md|code|diff|text` prefixes.
Documents from one Claude Code session share a workflow whether they
came from the hook or from `send_document`; a SessionStart hook,
installed by `init-claude`, records the session for the MCP server.
When no snyvi tab has focus, a new document raises a desktop
notification — `notify-send` on Linux, a toast on Windows, Notification
Center on macOS (set `SNYVI_NOTIFY=0` to disable).

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

On Windows, `%LOCALAPPDATA%\snyvi` and `%APPDATA%\snyvi\token`.

Override either with `SNYVI_DATA_DIR` and `SNYVI_CONFIG_DIR`.

## Design notes

See [docs/BRAINSTORM.md](docs/BRAINSTORM.md) for the reasoning behind the
architecture, the performance budgets, and the milestones.

## Measured so far

Release build on a 4-core container, headless Chromium, warm daemon,
best of three for render rows (`snyvi bench`); the page rows come from
`bench/browser.mjs`.

| Case                                        | Result      | Budget |
|---------------------------------------------|-------------|--------|
| Binary size, `snyvi`                        | 12.3 MB     | 15 MB  |
| Binary size, `snyvi-app` (the window)       | 4.3 MB      |        |
| Download, `.deb` (snyvi / snyvi-app)        | 5.5 MB / 1.2 MB | |
| Daemon resident (1 doc / loaded)            | 35 MB / 50 MB | 60 MB |
| Native window, to the web process           | ~150 ms     | 150 ms to first paint |
| Native window process, resident             | ~380 MB     | see below |
| Renderer init (86 grammars from the pack)   | 19 ms       |        |
| `snyvi send` round trip (render + store)    | ~50 ms      |        |
| Document page, time to first byte           | 3 to 5 ms   | 30 ms  |
| Document page, first contentful paint       | 65 to 170 ms (cold fonts) | |
| Longest frozen frame, page with a 220-node diagram | 66 ms (was 3193) | 200 ms |
| New document visible after send (SSE)       | ~50 ms      | 100 ms |
| Render Markdown, 100 KB                     | 10 ms       | 50 ms  |
| Render Markdown, 1 MB                       | 108 ms      | 400 ms |
| Highlight Rust, 10k lines                   | 143 ms      | 500 ms |

`snyvi bench --check` fails when a case exceeds its budget; CI runs it
with `SNYVI_BENCH_FACTOR=3` to allow for slower hosted runners. The
Markdown fast path skips the HTML sanitizer whenever a document contains
no raw HTML, which is nearly always for agent output.

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
See [docs/DIAGRAMS.md](docs/DIAGRAMS.md), which is where the 3193 ms in
the table above came from and what removing it took.

Only the window row is over, and it is the one fact that will not
change: WebKitGTK is 90 MB of shared library before snyvi's first
instruction. The budgets in [docs/BRAINSTORM.md](docs/BRAINSTORM.md) —
15 MB, 60 MB resident, 150 ms to first paint — were written for one
static binary, and snyvi still meets every one of them whether or not
you have a window installed.

That was not true in 0.5. The window was compiled into snyvi, so the
daemon carried the engine too and sat at 66 MB. Moving the window into
its own executable put the daemon back to 35 MB and left the engine
where it belongs: in the process that is showing you something, for as
long as it is on screen.

What `bench --check` measures is the renderer, in process, and
`bench/browser.mjs` measures the page. Neither measures binary size,
start-up or resident memory, so those rows are enforced by nothing —
they are hand-measured, and they drift. That is the next gap to close.
