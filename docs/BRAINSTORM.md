# snyvi — a fast, beautiful viewer for the documents your agents produce

Brainstorm, 2026-09-10 (revision 3). Nothing here is final; it is a
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
| Network on first load (web)         | < 100 KB, zero webfonts |
| Library of 10,000 docs              | sidebar and search stay instant |

What these budgets rule out:

- Electron. 150 MB RAM and ~1 s cold start before we write a line.
- A React/Vue/Svelte SPA with a bundler. The framework does nothing a
  viewer needs. Vanilla JS in the 30 to 60 KB range covers sidebar,
  TOC, search, theme.
- Client-side Markdown parsing and syntax highlighting. Do the heavy
  work once, natively, at receive time, and ship pre-rendered HTML.
- Webfonts. System font stack. Faster and looks native.

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

## 7. Security notes

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

## 8. Open questions

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

## 9. Prior art

- `glow`, `bat`, `grip`, `mdbook serve`, Typora, Obsidian reading
  view, VS Code Markdown preview, `delta` for diffs.
- None of them receive from an agent or organize by project and
  session. That gap is the product.

## 10. Recommended path

**Milestone 1: the viewer (MVP).**
1. Rust binary, `comrak` + `syntect` + `ammonia`, `axum`, inlined UI.
2. Store on disk plus SQLite index. `snyvi send` CLI.
3. Projects tree, inbox, document pane, dark/light, search.
4. Markdown, code, and diff rendering.

**Milestone 2: Claude Code integration.**
5. `snyvi mcp` with the single `send_document` tool, returning a URL.
6. `snyvi init-claude` to register the MCP server (and optionally the
   hook).
7. SSE plus focus-on-arrival so the document is showing by the time
   Claude replies with the link.
8. "Compare with previous" in a workflow.

**Milestone 3: desktop.**
9. Tauri 2 shell (`snyvi --app`). Same UI, same server, native window.

**Milestone 4 (only if wanted): hosted.**
10. Streamable-HTTP MCP, per-user tokens, isolation.
