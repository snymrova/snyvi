# snyvi — a fast, beautiful viewer for Markdown and code

Brainstorm, 2026-09-10. Nothing here is decided; it is a map of the
option space with a recommended path marked.

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

What these budgets rule out:

- Electron. 150 MB RAM and ~1 s cold start before we write a line.
- A React/Vue/Svelte SPA with a bundler. Not impossible, but the
  framework is doing nothing a viewer needs. Vanilla JS in the
  30 to 60 KB range is enough for tabs, TOC, search, theme.
- Client-side Markdown parsing and syntax highlighting as the default.
  highlight.js with all languages is ~1 MB; parsing 1 MB of Markdown in
  JS on a weak CPU is visibly slow. Do the heavy work once, natively,
  and ship pre-rendered HTML to the client.
- Webfonts. System font stack. It is faster and looks native.

## 2. Architecture: one binary, three faces

The key idea is that web and desktop are not two products. They are the
same rendering core behind a tiny local server, with three ways to look
at it.

```
                 ┌───────────────────────────────┐
  snyvi show x.md│  snyvi (single Rust binary)   │
  stdin / files ─►  ┌─────────┐   ┌───────────┐  │
                 │  │ md/code │──►│ HTTP+SSE  │──┼──► browser tab   (web face)
  snyvi mcp ─────►  │ render  │   │ 127.0.0.1 │  │
  (stdio MCP)    │  │ core    │   └───────────┘  ├──► Tauri window  (desktop face)
                 │  └─────────┘         ▲        │
  file watcher ──►                      │        ├──► TUI later?    (optional)
                 └──────────────────────┼────────┘
                                        │
                        remote agents ──┘ (streamable-HTTP MCP, hosted mode)
```

Pieces:

- **Render core (Rust lib).** Markdown via `pulldown-cmark` (fastest)
  or `comrak` (most GitHub-compatible; footnotes, tables, task lists,
  admonitions). Syntax highlighting via `syntect` (Sublime grammars,
  broad language coverage, fast enough) or `tree-sitter-highlight`
  (more accurate, more build weight). Output is plain HTML with class
  names. Cached by content hash.
- **Local server.** `axum` or `tiny_http`. Binds 127.0.0.1 only.
  Serves the UI, a small JSON API, and a Server-Sent Events stream for
  live updates. SSE beats WebSocket here: one direction, auto-reconnect,
  trivially proxied.
- **UI.** One HTML file, one CSS file, one JS file, inlined into the
  binary. No build step, or a single `esbuild` minify. Dark/light via
  `prefers-color-scheme`. Readable measure (~70ch), generous line
  height, sticky TOC, cmd-K search over open docs.
- **Desktop face.** Tauri 2 window pointing at the local server. On
  Linux this is WebKitGTK, roughly 30 to 40 MB RAM and ~100 ms start.
  Fallback face: `snyvi show --open` just calls `xdg-open` on the URL,
  which needs no Tauri at all and is the fastest possible "desktop app".
- **MCP face.** `snyvi mcp` runs a stdio MCP server that talks to the
  running viewer over a unix socket (or spawns one if none is running).

Why Rust over Go: Go is a perfectly good second choice (`goldmark` +
`chroma`, single binary, fast start). Rust wins on peak RAM and on
Tauri integration. Node/Bun lose on baseline RAM (~40 MB before doing
anything) and are the wrong tool for a "small machine" pitch.

## 3. The agent feature: how docs get in

Layer it so the simplest path works with zero configuration and the
richer paths build on it.

### Layer 0: CLI and stdin (zero config)

```
snyvi show README.md
snyvi show src/            # opens a file tree
cat report.md | snyvi show --title "Plan"
snyvi show --replace plan-1 < plan.md   # update a doc in place
```

Claude Code can already do this today through its Bash tool. No MCP
setup, no protocol, and it works from any agent or script.

### Layer 1: HTTP API (what everything else wraps)

```
POST /api/docs           { title, content, lang?, id? }  -> { id, url }
PUT  /api/docs/:id       replace content (viewer re-renders in place)
PATCH /api/docs/:id      append chunk (streaming, see §4)
GET  /api/docs/:id       raw source
GET  /api/events         SSE: doc-added, doc-updated, focus
```

Bearer token stored in `~/.config/snyvi/token`, required for writes.
Local only by default.

### Layer 2: MCP server (what the user asked for)

`snyvi mcp` exposes tools that map 1:1 onto the API:

| Tool             | Purpose                                           |
|------------------|---------------------------------------------------|
| `show_document`  | Push Markdown/code with a title; returns id + url  |
| `update_document`| Replace a doc by id (agent revises its plan)       |
| `append_document`| Stream a chunk onto a doc                          |
| `show_file`      | Point at a path on disk; viewer watches it         |
| `show_diff`      | Push a unified diff; rendered side-by-side         |
| `list_documents` | What is currently open                             |
| `focus_document` | Bring a doc to front                               |

Registering with Claude Code is one line:

```
claude mcp add snyvi -- snyvi mcp
```

"Web MCP": for a **hosted** viewer (snyvi running on a server, user
opens it in a browser from anywhere), the MCP transport becomes
streamable HTTP instead of stdio. Each browser session gets a token;
the agent registers with

```
claude mcp add --transport http snyvi https://viewer.example/mcp \
  --header "Authorization: Bearer <session-token>"
```

and pushes land in that session's tab via SSE. Same tools, same API,
different transport. This is why the API layer must exist under MCP
rather than MCP being bolted directly onto the renderer.

### Layer 3: watch a folder (zero protocol)

`snyvi watch ~/.snyvi/inbox` or `snyvi watch ./docs`. Any agent that
can write a file can "send" a doc. Cheap to build on top of the file
watcher we need anyway for live reload.

## 4. Streaming is the differentiator

Agents produce documents incrementally. A viewer that only shows a
finished file is a worse experience than the terminal, because the
terminal at least streams. So:

- `append_document` / `PATCH` pushes chunks.
- The renderer re-parses from the last stable block boundary, not from
  the top, so a 1 MB doc being appended to stays cheap.
- The client applies a DOM patch (morphdom-style, ~5 KB) rather than
  replacing `innerHTML`, so scroll position and selection survive.
- Visual affordance: a subtle "live" indicator on the tab while an
  agent is still writing.

This also gives free "watch this file while Claude edits it" for
Layer 0 and Layer 3.

## 5. What it renders

Tier 1 (MVP):
- GitHub-flavoured Markdown: tables, task lists, footnotes, strikethrough,
  autolinks, heading anchors, fenced code with highlighting.
- Code files, any language syntect knows, with line numbers and
  virtualized scrolling for large files.
- Unified diffs / patches, side-by-side or inline. Agents emit these
  constantly; almost no viewer renders them well.

Tier 2:
- Mermaid diagrams (lazy-load the library only when a block appears).
- Math via KaTeX (same lazy strategy).
- JSON / YAML / TOML pretty-printed and foldable. CSV as a table.
- Images, SVG. Relative links resolved against the doc's origin path.
- Directory tree view, quick-open by filename.

Explicitly out of scope: editing. Being a viewer is what keeps it fast
and simple. If a user wants to edit, offer "open in $EDITOR".

## 6. Document model

A **session** is the set of docs currently open, shown as a sidebar
list or tabs. Each doc has:

```
id        stable string, chosen by the sender or generated
title     shown in the tab
kind      markdown | code | diff | file
source    inline content, or a path being watched
pinned    survives restart if true; ephemeral docs vanish on close
history   last N versions, so "what did the agent change" is a diff away
```

Docs pushed by agents are ephemeral by default. The user can pin.
The version history plus the diff renderer means "show me what changed
since the last update" costs nothing extra.

## 7. "Beautiful" in concrete terms

- Typography first: system UI font for chrome, a good system serif or
  sans for body (user choice), monospace with ligatures off by default.
- Reading width capped, headings with clear rhythm, tight but airy code
  blocks. GitHub's rendering is the floor, Typora reading view is the
  bar.
- Two themes only, both excellent, both following the OS setting.
- Almost no chrome: title, TOC on wide screens, search. Everything else
  behind a keyboard shortcut.
- Instant feedback: never show a spinner for a local render; if
  something takes longer than 100 ms it is a bug.

## 8. Security notes (short, because they matter)

- Bind 127.0.0.1 only. Never 0.0.0.0 by default.
- Token on every write. Agents are semi-trusted; a random local
  process must not be able to inject docs.
- Sanitize rendered HTML (`ammonia` in Rust). Markdown from an agent can
  contain raw HTML and scripts.
- Strict CSP on the UI page; no inline scripts except our own hashed
  ones; no remote loads except the lazy Mermaid/KaTeX from a pinned CDN.
- Hosted mode adds real auth and per-session isolation; that is a
  separate milestone, not a checkbox.

## 9. Prior art to steal from

- `glow` (TUI Markdown, great style presets), `bat` (code paging),
  `grip` (GitHub-faithful local preview), `mdbook serve` (live reload),
  Typora (reading typography), Obsidian reading view, VS Code's
  Markdown preview (scroll sync), `delta` (diff rendering).
- None of them accept pushes from an agent, stream, or render diffs
  and Markdown in one place. That gap is the product.

## 10. Recommended path

**MVP (a weekend of focused work):**
1. Rust binary, `pulldown-cmark` + `syntect`, `axum`, inlined UI.
2. `snyvi show <file|dir|stdin>` opens the browser at 127.0.0.1.
3. Live reload on file change via SSE.
4. Markdown + code + diff rendering, dark/light.

**Milestone 2: agents.**
5. HTTP API with token, `update` and `append`.
6. `snyvi mcp` stdio server; document the one-line Claude Code setup.
7. Streaming render with block-boundary reparse and DOM patching.

**Milestone 3: desktop.**
8. Tauri 2 shell (`snyvi --app`). Same UI, same server, native window.

**Milestone 4 (only if wanted): hosted.**
9. Streamable-HTTP MCP, sessions, auth.

## 11. Open questions

1. Web-first or desktop-first for the *first* users? Recommendation:
   web-first via `xdg-open`; it is the desktop app for free.
2. Is hosted/multi-user ever a goal, or is this a local tool? It changes
   the auth story and the MCP transport.
3. `comrak` (GitHub-exact, slightly slower) or `pulldown-cmark`
   (fastest, fewer extensions)? Recommendation: `comrak`; GitHub
   fidelity matters more to users than 20 ms.
4. Should agents be able to *read* what the user has open (context for
   the agent), or is the channel push-only? Read access is powerful but
   needs a privacy line.
5. Name and identity: is `snyvi` the product name?
