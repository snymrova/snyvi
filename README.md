# snyvi

A fast, beautiful viewer for the documents your agents produce.

You ask Claude Code for a plan. It writes one. With snyvi, Claude sends
the document and replies with a link; by the time you read the reply, the
document is already open in the viewer, rendered, and filed under the
project. Markdown and every kind of source file. One direction only:
agents send, snyvi shows.

## Install

Download the static binary for your architecture from the
[releases page](https://github.com/snymrova/snyvi/releases), then:

```
tar xzf snyvi-*-x86_64-unknown-linux-musl.tar.gz
install -m 755 snyvi-*/snyvi ~/.local/bin/snyvi   # or /usr/local/bin
snyvi send README.md                              # starts the daemon, prints a link
snyvi init-claude                                 # register with Claude Code
```

It is fully static (musl), so it runs on any x86_64 or aarch64 Linux
without extra packages. To build from source instead:

```
cargo install --path .
```

One binary, no runtime, no network access ever. It embeds its own UI,
fonts, and syntax grammars.

To start the daemon at login, a user service is enough:

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
snyvi open                         # open the viewer in the browser
snyvi app                          # native window (see Desktop below)
snyvi init-claude [--auto]         # register with Claude Code (user scope)
snyvi prune --days 30 [--dry-run]  # delete unpinned documents older than N days
snyvi status                       # daemon health
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
| /     | find in document                            |
| p     | pin (kept by `prune`)                       |
| ⌫     | delete document                             |
| i     | inbox                                       |
| t     | toggle contents                             |
| \     | toggle sidebar                              |
| o     | open source                                 |
| ?     | show keys                                   |

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
