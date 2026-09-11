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

`snyvi app` opens the viewer in a native window. Built with
`cargo build --release --features desktop` it is a WebKitGTK window
(Tauri 2) on top of the daemon; the plain build opens a Chromium-family
browser in app mode when one is installed, else the default browser.

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
notification via `notify-send` (set `SNYVI_NOTIFY=0` to disable).

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

Override with `SNYVI_DATA_DIR` and `SNYVI_CONFIG_DIR`.

## Design notes

See [docs/BRAINSTORM.md](docs/BRAINSTORM.md) for the reasoning behind the
architecture, the performance budgets, and the milestones.

## Measured so far

Release build on a 4-core container, headless Chromium, warm daemon,
best of three for render rows (`snyvi bench`).

| Case                                        | Result      | Budget |
|---------------------------------------------|-------------|--------|
| Binary size (plain / desktop)               | 8.8 MB / 12.1 MB | 15 MB |
| Daemon resident memory                      | ~25 MB      | 60 MB  |
| Renderer init (86 grammars from the pack)   | 7 ms        |        |
| `snyvi send` round trip (render + store)    | ~50 ms      |        |
| Document page, time to first byte           | 3 to 5 ms   | 30 ms  |
| Document page, first contentful paint       | 65 to 170 ms (cold fonts) | |
| New document visible after send (SSE)       | ~50 ms      | 100 ms |
| Render Markdown, 100 KB                     | 14 ms       | 50 ms  |
| Render Markdown, 1 MB                       | 159 ms      | 200 ms |
| Highlight Rust, 10k lines                   | 193 ms      | 500 ms |

`snyvi bench --check` fails when a case exceeds its budget; CI runs it
with `SNYVI_BENCH_FACTOR=3` to allow for slower hosted runners. The
Markdown fast path skips the HTML sanitizer whenever a document contains
no raw HTML, which is nearly always for agent output.
