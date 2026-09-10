# snyvi — a fast, beautiful viewer for the documents your agents produce

Brainstorm, 2026-09-10 (revision 4). Nothing here is final; it is a
map of the option space with a recommended path marked.

## 0. What it is, in one paragraph

You ask Claude Code for a plan. It writes one. Today you read it in
the terminal or open the file by hand. With snyvi, Claude sends the
document (a path, or the content itself) and replies with a link; the
document is already open in snyvi, rendered, filed under the project.
Markdown and every kind of code file. One direction only: agents send,
snyvi shows. Documents are immutable once received; snyvi is a viewer
and a library, not an editor and not a live scratchpad.

The channel is push-only by design. The agent never reads back from
snyvi, so the viewer can never leak one project's documents into
another session's context.

## 1. The one constraint that drives everything

"Opens super fast on a small machine" is the design constraint. Every
other choice falls out of it.

Concrete budgets (targets, not measurements yet):

| Metric                              | Target                |
|-------------------------------------|-----------------------|
| Cold start to first paint (desktop) | < 150 ms              |
| Cold start to first paint (web tab) | < 100 ms after load   |
| Resident memory, one doc open       | < 60 MB desktop, < 20 MB tab |
| Render a 1 MB Markdown file         | < 200 ms              |
| Render a 50k-line code file         | scrolls at 60 fps (virtualized) |
| Binary size                         | < 15 MB single file   |
| Network on first load (web)         | < 60 KB gzipped UI, all from localhost |
| Open an already-received document   | < 30 ms request to first paint |
| Any interaction                     | < 100 ms, or it is a bug |
| Library of 10,000 docs              | sidebar and search stay instant |

What these budgets rule out:

- Electron. 150 MB RAM and ~1 s cold start before we write a line.
- A React/Vue/Svelte SPA with a bundler. The framework does nothing a
  viewer needs. Vanilla JS in the 30 to 60 KB range covers sidebar,
  TOC, search, theme.
- Client-side Markdown parsing and syntax highlighting. Do the heavy
  work once, natively, at receive time, and ship pre-rendered HTML.
- Remote webfonts. Fonts are either the system stack or embedded in
  the binary and served from localhost (section 7.2). Nothing is ever
  fetched from the network.

Immutability helps here too: a document is rendered exactly once, when
it arrives, and the HTML is cached forever. Opening any doc is a
single file read.

## 2. Architecture: one binary, two faces

Web and desktop are not two products. They are the same rendering core
behind a tiny local server, with two ways to look at it.

```
  Claude Code ──(MCP: send_document path|content)──┐
  snyvi send file.md  (CLI) ──────────────────────┤
  optional hook on Write/Edit ─────────────────┐  │
                                               ▼  ▼
                 ┌───────────────────────────────────┐
                 │  snyvi (single Rust binary)       │
                 │  ┌─────────┐  ┌───────┐  ┌──────┐ │
                 │  │ receive │─►│ render│─►│ store│ │
                 │  │ + file  │  │ once  │  │ disk │ │
                 │  └─────────┘  └───────┘  └──┬───┘ │
                 │                             ▼     │
                 │           ┌────────────────────┐  │
                 │           │ HTTP + SSE         │──┼──► browser tab   (web face)
                 │           │ 127.0.0.1 only     │──┼──► Tauri window  (desktop face)
                 │           └────────────────────┘  │
                 └───────────────────────────────────┘
```

Pieces:

- **Receive.** One entry point, three transports (section 4). Every
  transport ends up calling the same `receive(document)` function.
- **Render core (Rust lib).** Markdown via `comrak` (GitHub-compatible:
  tables, task lists, footnotes, alerts). Syntax highlighting via
  `syntect`. Output is plain HTML with class names, sanitized with
  `ammonia`, written to disk next to the source.
- **Store.** Plain files on disk, one directory per project, one per
  workflow, one file per document plus its rendered HTML and a small
  JSON sidecar. A SQLite index (with FTS5) for listing and full-text
  search. Files stay greppable and backup-friendly; SQLite keeps the
  sidebar instant at 10,000 docs.
- **Local server.** `axum`. Binds 127.0.0.1 only. Serves the UI, a
  small JSON API, and a Server-Sent Events stream that tells open tabs
  "a new document arrived in project X".
- **UI.** One HTML, one CSS, one JS file, inlined into the binary. No
  build step. Dark/light via `prefers-color-scheme`.
- **Desktop face.** Tauri 2 window pointing at the local server
  (WebKitGTK on Linux, roughly 30 to 40 MB RAM, ~100 ms start). The
  zero-cost fallback is `snyvi open`, which just `xdg-open`s the URL.

Why Rust over Go: Go is a good second choice (`goldmark` + `chroma`).
Rust wins on peak RAM and on Tauri integration. Node/Bun lose on
baseline RAM (~40 MB before doing anything).

## 3. The organizing model: projects, workflows, documents

```
Project                     one per repo / working directory
└── Workflow                a named unit of work inside the project
    └── Document            immutable, timestamped, rendered once
```

**Project** is detected, not configured. The sender passes its working
directory; snyvi maps it to a project by git root (or the directory
itself when there is no git). Display name is the directory name,
overridable. The same repo checked out in two places is one project.

**Workflow** is the interesting middle layer and the least settled.
Candidate meanings, not mutually exclusive:

1. One Claude Code *session*. Free, automatic, and always correct, but
   session ids are meaningless to a human. Would need a title, which
   the first document's title can supply.
2. A *named task* the user or agent declares: "auth refactor",
   "release 2.3". Meaningful, but requires someone to pick the name.
3. A *branch*. Meaningful in git-centric work, free to detect, and
   often coincides with 2.

Recommendation: default to the session, auto-titled, and let the
sender override with an explicit workflow name. Show the branch as
metadata. Revisit once there are real documents to look at.

**Document** fields:

```
id          content hash + timestamp, generated by snyvi
project     resolved from sender's cwd
workflow    session id, or explicit name
title       from sender, else first H1, else filename
kind        markdown | code | diff | text
lang        for code
received_at timestamp
source      { path?, session_id?, tool?, model? }   provenance, optional
tags        free-form, optional
```

No update. No append. If the agent revises its plan, it sends a new
document; the workflow view shows both in order, and a "compare with
previous" button diffs them. Versioning falls out of immutability for
free.

## 4. How documents get in

Agents are the only senders. Every path ends in the same `receive`.

### The primary path: the MCP tool

`snyvi mcp` runs a stdio MCP server with exactly one tool:

```
send_document
  path      absolute path to a file on disk           (either path
  content   inline text                                 or content)
  title     optional; else first H1, else filename
  workflow  optional name; else the session
  lang      optional; else inferred from extension
  -> { url: "http://127.0.0.1:7777/d/8f3a2c" }
```

Sending by `path` is the common case: Claude writes `PLAN.md`, then
calls `send_document(path)`. snyvi reads the file, snapshots it, and
renders it. Later edits to the file on disk do not change the
snapshot; Claude sends again and the workflow shows both versions.

Sending by `content` covers documents that are not files: a review
Claude would otherwise print to the terminal, a summary at the end of
a task, a diff.

The tool returns a URL. Claude's reply to the user becomes "Plan is
ready: http://127.0.0.1:7777/d/8f3a2c". Clicking it lands on the
document; if the snyvi window is already open, the document is
already showing (section 6, "focus on arrival").

Registering with Claude Code, once, globally:

```
claude mcp add --scope user snyvi -- snyvi mcp
```

The tool description should tell the model *when* to use it, so it
does so without being asked: "Call this whenever you finish writing a
plan, report, review, summary, or any document the user will want to
read. Prefer sending the file path."

A CLAUDE.md line in the user's global config reinforces it: "When you
produce a document for me to read, send it to snyvi and give me the
link."

### The fallback path: CLI

```
snyvi send PLAN.md
snyvi send --title "Review" --lang diff < changes.patch
```

Same arguments, same result. Lets Claude use it through Bash before
MCP is configured, and lets scripts and other agents send.

### Optional: automatic send via Claude Code hook

For users who want *everything* Claude writes to appear without the
model having to decide, a `PostToolUse` hook on `Write` and `Edit`
can call `snyvi send` for matching files. Off by default; enabled by
`snyvi init-claude --auto`. The filter (which extensions, which
directories) lives in snyvi's config. Explicit `send_document` calls
still work alongside it; duplicates are collapsed by content hash.

### Not now: hosted mode

If snyvi ever runs on a server and is opened from a browser anywhere,
the MCP transport becomes streamable HTTP with a per-user token. Same
single tool, different transport. Not in the first three milestones.

## 5. What it renders

Tier 1 (MVP):
- GitHub-flavoured Markdown: tables, task lists, footnotes, alerts,
  heading anchors, fenced code with highlighting.
- Code files, any language syntect knows, line numbers, virtualized
  scrolling for large files.
- Unified diffs, side-by-side or inline. Agents emit these constantly
  and almost nobody renders them well.

Tier 2:
- Mermaid and KaTeX, each lazy-loaded only when a block needs it.
- JSON / YAML / TOML pretty-printed and foldable. CSV as a table.
- Images and SVG embedded in a doc; relative paths resolved against the
  document's original location if it had one.

Out of scope: editing. Offer "open in $EDITOR" and "copy path".

## 6. The UI, concretely

Three panes, the outer two collapsible:

```
┌────────────┬──────────────────────────────────┬────────┐
│ Projects   │                                  │  TOC   │
│  ▸ snyvi   │  Document, rendered              │        │
│  ▾ foo     │  reading width ~72ch             │        │
│    ▾ auth  │                                  │        │
│      plan  │                                  │        │
│      review│                                  │        │
│    ▸ rel.. │                                  │        │
│  ▸ bar     │                                  │        │
├────────────┤                                  │        │
│ Inbox (3)  │                                  │        │
└────────────┴──────────────────────────────────┴────────┘
```

- **Projects tree** on the left: project, workflow, documents, newest
  first. A badge on projects with unread documents.
- **Inbox** view: the last N documents across all projects, newest at
  top. This is the "what did my agents produce today" screen and
  probably the default landing page.
- **Search** (Cmd/Ctrl-K): full-text across everything via FTS5,
  scoped to a project with a prefix.
- **Document pane**: typography first, system fonts, capped measure,
  clear heading rhythm, tight but airy code blocks. GitHub rendering is
  the floor; Typora's reading view is the bar.
- **Right rail**: table of contents, provenance (session, branch,
  time), "compare with previous in workflow", "open source file".
- **Focus on arrival.** The core flow is "I asked for a plan, I want
  to read it now", so a newly received document opens immediately in
  the document pane. If the user is mid-read in another doc (scrolled,
  text selected, active in the last few seconds), the new doc is
  queued behind a toast instead. Both behaviours are one setting.
- When a document arrives for a project that is not the current one,
  the project badge increments and the inbox updates via SSE.

## 7. Beautiful, concretely

"Beautiful" is not a theme picked from a list. It is a hundred small
decisions made on purpose. The bar: someone opens a plan in snyvi and
prefers reading it there to anywhere else, and cannot quite say why.

### 7.1 The document is the hero, the chrome recedes

- The document pane gets the light; sidebar and rail are a tone
  quieter than the page, with no borders, only a faint change of
  background.
- Chrome auto-hides: on narrow windows both side panes collapse; on
  wide windows the TOC rail shows only for documents that have three
  or more headings.
- No toolbar. Actions live in a Cmd-K palette and on hover: heading
  anchors, copy-code buttons, language labels appear when the cursor
  is near and vanish when it is not.

### 7.2 Typography

- Body 17 px, line-height 1.6, measure 68 to 72 characters, centred.
- Headings on a modular scale (1.25) with tightened letter-spacing at
  large sizes and generous space above, less below, so each heading
  belongs to what follows it.
- Fonts: the system stack is the fallback, but Linux system fonts are
  often the reason Linux apps look worse than they are. So snyvi
  embeds a small set of excellent open fonts in the binary, subsetted
  to Latin and served from localhost, roughly 30 to 60 KB each as
  WOFF2: one sans (Inter or IBM Plex Sans), one serif (Source Serif 4
  or Literata) for users who prefer it, one mono (JetBrains Mono or
  Berkeley-style alternative, ligatures off). Localhost latency is
  nothing; this costs no perceptible time and buys most of the
  "beautiful".
- Real typographic details: hanging punctuation on blockquotes,
  tabular figures in tables, proper en and em dashes left as written,
  `text-wrap: pretty` for paragraphs and `balance` for headings.

### 7.3 Colour

- Two palettes, both designed, neither an inversion of the other.
  Light is warm paper, near-white not pure white, ink not pure black.
  Dark is deep grey-blue, never pure black, with text at ~85% white
  to avoid glare.
- One accent colour, used sparingly: links, the active sidebar item,
  focus rings, the arrival toast.
- The syntax highlighting theme is designed alongside the UI palette
  so code blocks look like part of the page, not an iframe from
  another product. One light theme, one dark theme, both ours.
- Diff colours are muted versions of red and green that sit inside
  the palette; word-level changes get the stronger tint, line-level
  the lighter.

### 7.4 Elements

- Code blocks: subtle background, no border, 4 px radius, horizontal
  scroll rather than wrap by default (toggleable), line numbers in a
  muted colour that do not get selected with the code, language label
  top-right on hover.
- Tables: thin horizontal rules only, header in small caps or medium
  weight, numeric columns right-aligned automatically.
- Blockquotes: a thin accent rule on the left, text one shade
  quieter, no italics.
- Task lists: real checkbox glyphs, done items dimmed, never
  interactive (this is a viewer).
- Footnotes: inline popover on hover, full list at the end.
- Images: constrained to the measure, click to view full width,
  captions from alt text.
- Headings: anchor link on hover; the current section is marked in
  the TOC as you scroll.
- Empty states, error states, and the arrival toast are designed with
  the same care as the document. An empty inbox says something kind
  and shows the one command to run.

### 7.5 Motion

- Only two things animate: pane collapse and the arrival toast.
  120 to 160 ms, ease-out, opacity and transform only. Everything else
  is instant. Respect `prefers-reduced-motion`.

### 7.6 Keyboard

- `j` / `k` next and previous document, `[` / `]` previous and next
  version in a workflow, `/` search within document, Cmd-K palette,
  `t` toggle TOC, `\` toggle sidebar, `o` open source in editor.
- A reader who never touches the mouse should feel the product was
  made for them.

### 7.7 Reference points

- Steal from: iA Writer (measure, calm), Typora reading view, Bear,
  Linear's docs, Stripe's docs (code blocks), `delta` (diffs).
- Avoid: GitHub's heavy chrome, Obsidian's density, anything with a
  toolbar.

## 8. Fast, concretely

"Super fast" means the user never waits, and never *notices* the
program between them and the document. Every wait under 100 ms reads
as instant; that is the line for every interaction.

### 8.1 A resident daemon, so there is no cold start

The single biggest lever. `snyvi` runs as a small background process
(target under 20 MB resident, zero CPU when idle), started at login
by a systemd user unit or on first `send`. Receive, render, and serve
all happen in a process that is already warm. "Open snyvi" then means
focus an existing window or open a tab, never boot a server.

The Tauri window (or the browser tab) is what the user perceives as
the app, and that is the only cold-start cost left: ~100 ms on
WebKitGTK. The desktop face can also stay open and hidden, making
"open" a window focus, ~0 ms.

### 8.2 Render once, at receive time, never on open

A document is parsed, highlighted, sanitized, and written to disk as
HTML the moment it arrives, while the user is not yet looking.
Opening any document later is one file read and one HTTP response
from localhost. Target: request to first paint under 30 ms.

The document page is server-rendered HTML that is complete and
readable with JavaScript disabled. JS attaches afterwards for TOC
highlighting, search, and keyboard shortcuts. First paint never
waits for a script.

### 8.3 Big files

- Markdown: `comrak` parses on the order of 50 to 100 MB/s. A 1 MB
  document renders in tens of milliseconds. Not a concern.
- Code: syntax highlighting is the slow part. `syntect` runs at
  roughly 1 to 5 MB/s depending on grammar. Policy: highlight up to
  the first 256 KB synchronously on receive; beyond that, serve the
  plain text immediately and highlight the remainder in a background
  thread, swapping in chunks as they finish. A 20 MB log file is
  readable instantly and fully coloured a few seconds later.
- Long documents in the browser: `content-visibility: auto` on every
  top-level section and `contain: content` on every code block so
  the browser lays out only what is on screen. This alone makes a
  50k-line file scroll at 60 fps on a weak GPU. For files beyond a
  few MB, the server pages lines and the client requests them on
  scroll.

### 8.4 Navigation

- Switching documents fetches an HTML fragment and swaps the pane; no
  full page load, no flash. Prefetch on sidebar hover.
- The sidebar tree is one small JSON payload held in memory, updated
  by SSE events, never re-fetched.
- Search hits SQLite FTS5 with a 50 ms debounce; results under 10 ms
  for a library of 10,000 documents.
- Sidebar and search lists are virtualized past 200 rows.

### 8.5 Page weight

- UI assets embedded with `include_bytes!`, served with immutable
  cache headers keyed by build hash. After the first open, the
  browser fetches nothing but the document.
- Budget: HTML + CSS + JS under 60 KB gzipped. Fonts on top, lazily.
- Mermaid and KaTeX are vendored and loaded only when a document
  contains a block that needs them, and only after first paint.

### 8.6 Nothing waits on the network, ever

- No CDN, no analytics, no update check on start, no font fetch. The
  binary has everything. Air-gapped machines work identically.

### 8.7 Keeping it fast: the budget is a test

- A `snyvi bench` command measures cold daemon start, receive-to-
  rendered for fixture documents (1 KB, 100 KB, 1 MB Markdown; 10k,
  100k line code), request-to-response for a document, and total page
  weight.
- CI runs the bench in a container limited to 2 vCPU and 2 GB and
  fails the build if any budget from section 1 is exceeded. Speed
  regressions are bugs and are caught the same way.
- Every animation is capped at 160 ms; a lint rule enforces it.

## 9. Security notes

- Bind 127.0.0.1 only. Never 0.0.0.0 by default.
- Token on every write, stored in `~/.config/snyvi/token`. The hook
  and MCP server read it; a random local process cannot inject docs.
- Sanitize rendered HTML with `ammonia`. Agent-produced Markdown can
  contain raw HTML and scripts.
- Strict CSP on the UI page. No remote loads except the lazy
  Mermaid/KaTeX bundles, which should be vendored into the binary
  rather than fetched.
- Documents may contain secrets the agent saw. The store lives under
  `~/.local/share/snyvi`, user-readable only. Offer a per-project
  "do not collect" setting.

## 10. Open questions

1. **What is a workflow?** Session, named task, or branch (section 3).
   Recommendation: session by default, name overridable.
2. **Hook filter** (only if the optional auto-send is used): all
   `.md`, or a configured filter.
3. **Is hosted mode ever a goal?** Changes auth and MCP transport.
   Recommendation: not before the local tool is loved.
4. **Retention.** Keep everything forever, or prune session-scoped
   docs after N days unless pinned?
5. **Which code files are documents?** A plan is obviously one. Is
   every source file Claude sends one too, or should code files sent
   by path be shown but not kept in the library? Recommendation: keep
   everything; disk is cheap and the inbox is time-ordered anyway.
6. **Name.** Is `snyvi` the product name?

## 11. Prior art

- `glow`, `bat`, `grip`, `mdbook serve`, Typora, Obsidian reading
  view, VS Code Markdown preview, `delta` for diffs.
- None of them receive from an agent or organize by project and
  session. That gap is the product.

## 12. Status (2026-09-10)

Milestones 1 to 3 are built and measured; see README.md for numbers.
Built: daemon, renderer with sanitizer fast path and compact highlight
classes, store with FTS5, projects/workflows/documents, inbox, search,
compare, focus-on-arrival, pin and prune, background highlighting past
the cap, the `send_document` MCP tool, the optional PostToolUse hook
with coalescing, the Tauri desktop window, a perf budget in CI, and an
extra grammar pack (TypeScript, TOML, Dockerfile, ...).
Not built: hosted mode (milestone 4), Mermaid/KaTeX, image embedding.

## 13. Recommended path

**Milestone 1: the viewer (MVP).**
1. Rust binary, `comrak` + `syntect` + `ammonia`, `axum`, inlined UI,
   resident daemon with render-on-receive.
2. Store on disk plus SQLite index. `snyvi send` CLI.
3. Projects tree, inbox, document pane, both palettes, embedded
   fonts, search.
4. Markdown, code, and diff rendering.
5. `snyvi bench` and the CI perf budget from day one, so speed is
   never something to win back later.

**Milestone 2: Claude Code integration.**
6. `snyvi mcp` with the single `send_document` tool, returning a URL.
7. `snyvi init-claude` to register the MCP server (and optionally the
   hook).
8. SSE plus focus-on-arrival so the document is showing by the time
   Claude replies with the link.
9. "Compare with previous" in a workflow.

**Milestone 3: desktop.**
10. Tauri 2 shell (`snyvi --app`). Same UI, same server, native window.

**Milestone 4 (only if wanted): hosted.**
11. Streamable-HTTP MCP, per-user tokens, isolation.
