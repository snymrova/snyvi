# snyvi

A fast, beautiful viewer for the documents your agents produce.

You ask Claude Code for a plan. It writes one. With snyvi, Claude sends
the document and replies with a link; by the time you read the reply, the
document is already open in the viewer, rendered, and filed under the
project. Markdown and every kind of source file. One direction only:
agents send, snyvi shows.

## Install

```
cargo install --path .
```

One binary, no runtime, no network access ever. It embeds its own UI,
fonts, and syntax grammars.

## Use

```
snyvi send PLAN.md                 # send a file, print its link
cat notes.md | snyvi send -t Notes # send stdin
snyvi open                         # open the viewer in the browser
snyvi init-claude                  # register with Claude Code (user scope)
snyvi status                       # daemon health
snyvi bench                        # render speed on synthetic documents
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

### Keys

| Key   | Action                                     |
|-------|--------------------------------------------|
| ⌘K    | search everything                           |
| j / k | next / previous document                    |
| [ / ] | older / newer version in the same workflow  |
| c     | compare with the previous version           |
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
again; the workflow shows both, and `c` diffs them.

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

Release build on a 4-core container, headless Chromium, warm daemon.

| Case                                        | Result      |
|---------------------------------------------|-------------|
| Binary size                                 | 8.7 MB      |
| Daemon resident memory, 8 documents         | ~25 MB      |
| `snyvi send` round trip (render + store)    | ~50 ms      |
| Document page, time to first byte           | 3 to 5 ms   |
| Document page, first contentful paint       | 65 to 170 ms (cold fonts) |
| New document visible after send (SSE)       | ~50 ms      |
| Render Markdown, 100 KB                     | 23 ms       |
| Render Markdown, 1 MB                       | 265 ms      |
| Highlight Rust, 10k lines                   | 296 ms      |

`snyvi bench` reproduces the render rows. The Markdown fast path skips the
HTML sanitizer whenever a document contains no raw HTML, which is nearly
always for agent output.
