# snyvi — a fast, beautiful viewer for the documents your agents produce

Brainstorm, 2026-09-10 (revision 2). Nothing here is final; it is a
map of the option space with a recommended path marked.

## 0. What it is, in one paragraph

Every Claude Code session writes documents: plans, reviews, summaries,
migration notes, READMEs. Today they land in the repo, or in the
terminal, or nowhere. snyvi is where they all go. Claude Code sends a
document, snyvi receives it, files it under the right project, and
shows it beautifully and instantly. Documents are immutable once
received; the viewer is a library, not an editor and not a live
scratchpad.

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
  Claude Code ──(MCP tool: send_document)──┐
  Claude Code hook on Write *.md ──────────┤
  snyvi send file.md ────────────────────┐ │
                                         ▼ ▼
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

Every transport calls the same `receive`. Layer them so the simplest
works with zero configuration.

### Transport A: CLI (zero config)

```
snyvi send plan.md
snyvi send --title "Review notes" --workflow "auth refactor" < notes.md
snyvi send --project ~/code/foo report.md
```

Claude Code can do this today through its Bash tool.

### Transport B: Claude Code hook (zero agent cooperation)

This is the one that delivers "all the documents we generate in Claude
Code for any project" without asking the agent to remember anything.
A `PostToolUse` hook on `Write` (and `Edit`) checks whether the file
is `*.md` and, if so, runs `snyvi send` with the session's cwd and
session id. Roughly:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{ "type": "command", "command": "snyvi hook" }]
    }]
  }
}
```

`snyvi hook` reads the hook JSON on stdin, filters to Markdown paths,
and calls `receive`. Installed once in `~/.claude/settings.json`, it
covers every project forever. `snyvi init-claude` can write that
config for the user.

Open question here: which files count? Every `.md` write is the
obvious default. Some users will want only files outside the repo
(e.g. `/tmp/plan.md`) or only files matching a glob. Make it a filter
in snyvi's config, default "all Markdown".

### Transport C: MCP tool (explicit, richer metadata)

`snyvi mcp` runs a stdio MCP server exposing a deliberately tiny
surface:

| Tool             | Purpose                                              |
|------------------|------------------------------------------------------|
| `send_document`  | title, content, kind/lang, optional workflow and tags |
| `list_documents` | what snyvi has for this project (optional, see 8.4)   |

That is the whole tool list. Registering with Claude Code:

```
claude mcp add snyvi -- snyvi mcp
```

Use the MCP tool when the agent produces a document that is *not* a
file: a review it would otherwise print to the terminal, a summary at
the end of a task, a diff it wants the user to look at.

### Transport D (hosted mode only): streamable-HTTP MCP

If snyvi ever runs on a server and is opened from a browser anywhere,
the MCP transport becomes streamable HTTP with a per-user token. Same
tool, different transport. Not in the first three milestones.

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
- Live: when a document arrives, the tree updates via SSE and a quiet
  toast appears. Clicking it opens the doc. No auto-navigation; the
  user is reading.

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
2. **Which hook-written files count?** All `.md`, or a filter.
3. **Is hosted mode ever a goal?** Changes auth and MCP transport.
   Recommendation: not before the local tool is loved.
4. **Should agents read back?** A `list_documents` tool lets Claude
   Code say "you already have a plan for this from yesterday, here it
   is". Powerful, but it means the agent can see documents from other
   sessions and other projects unless scoped. Recommendation: include
   it, scoped to the current project, off by default.
5. **Retention.** Keep everything forever, or prune ephemeral
   session-scoped docs after N days unless pinned?
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
5. `snyvi hook` and `snyvi init-claude` to install it.
6. `snyvi mcp` with `send_document`.
7. SSE so open tabs update as documents arrive.
8. "Compare with previous" in a workflow.

**Milestone 3: desktop.**
9. Tauri 2 shell (`snyvi --app`). Same UI, same server, native window.

**Milestone 4 (only if wanted): hosted.**
10. Streamable-HTTP MCP, per-user tokens, isolation.
