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
| Code outline in the rail | For a code document, list functions, types and headings from the highlighter's scopes so the rail is as useful for code as the TOC is for prose. Worth more now that browse mode shows code all day. | M | next |
| Watch a browsed folder | Refresh the open file when it changes on disk, instead of on manual reload. | S | later |
| Math (KaTeX) | Rare in engineering docs. Same lazy-load pattern as Mermaid once that exists. | S | later |
| Structured views for JSON, YAML, CSV | CSV and TSV render as a table (**done 0.3**). JSON folding and YAML remain. | M | later |
| Preview a page or a PDF | An `.html` file showed as source only and a `.pdf` as "a binary file". Both now show as themselves with `v`: a page in an iframe with an opaque origin, a PDF in the browser's viewer. | M | **done 0.3** |
| Images and binaries in the library | `send_document` of a PNG stored mojibake. Images are kept as bytes and displayed; anything else undecodable is described. | S | **done 0.3** |
| Line wrap toggle, jump to line, line permalinks | `#L120` links from agents; wrap for long log lines. | S | later |
| Focus mode | `f` hides both panes and centres the text. One keystroke, but most of it exists via `\` and `t`. | XS | maybe |

## B. Library and organisation

| Feature | Why | Cost | Status |
|---|---|---|---|
| File history | Every snapshot of the same path across workflows, newest first, with diff between any two. Today versions are only visible inside one workflow. | M | **done 0.2** |
| One workflow per Claude Code session | Hook sends and MCP sends from the same session land in two workflows because the MCP server cannot see Claude's session id. A `SessionStart` hook can record `cwd → session` in the config dir; the MCP server reads it. Result: one workflow per session, titled from its first document. | S | **done 0.2** |
| Search filters | Scope search to a project, a kind, or a date range with prefixes (`p:snyvi kind:diff`). | S | **done 0.2** |
| Delete a document from the UI | With confirmation. Prune covers bulk; users still want to remove one. | S | **done 0.2** |
| Rename workflow and project | Session-derived titles are guesses; let the user fix them inline. | S | later |
| Tags from the sender | `send_document(tags: ["review"])`, filter chips in the sidebar. | S | later |
| Unread state persisted | Badges survive restarts. | XS | later |
| Archive a project | Hide finished projects from the tree without deleting. | S | later |
| Export | Copy as Markdown, print stylesheet polish, save as PDF via print. | S | maybe |

## C. Agent integration

| Feature | Why | Cost | Status |
|---|---|---|---|
| Desktop notification on arrival | When the window is not focused, a system notification with the title; click to open. `notify-send` on Linux. | S | **done 0.2** |
| `snyvi watch FILE` | Re-send a file whenever it changes on disk, for editors and agents that have no hooks. Uses the same coalescing as the hook. | S | later |
| Other agents | Config snippets for Codex CLI, Gemini CLI and Cursor: all speak MCP, so it is docs plus an `init` subcommand per tool. | S | later |
| Claude Code skill file | A `/snyvi` skill that teaches the model when to send and how to phrase the link, installed by `init-claude`. | XS | later |
| Per-project opt-out | `.snyvi.toml` in a repo with `collect = false` so the hook never sends from that project. | XS | later |

## D. Desktop

| Feature | Why | Cost | Status |
|---|---|---|---|
| Remember window size and position | Basic expectation of a native app. | XS | **done 0.2** |
| Tray icon and global shortcut | Summon the window from anywhere; the daemon is resident anyway. | M | later |
| Packages | `.deb`, AppImage and an AUR package from the release workflow; Homebrew tap for the macOS build. | M | later |
| macOS build | Tauri and the plain build both work on macOS; add it to the release matrix. | S | later |

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

## Other candidates for 0.3

Code outline in the rail, `snyvi watch`, rename workflow and project,
tags from the sender, macOS build, packages (.deb, AppImage), tray icon.

Two pieces of release hygiene are worth folding in before 0.3 ships: no
release has ever been cut, so the install instructions point at an empty
releases page, and CI never builds `--features desktop`, so the Tauri
window is unverified code.

## Still no purpose-built view

JSON and YAML (highlighted source only) and Jupyter notebooks (raw JSON
rather than cells). Notebooks are the most work and the least common in
this context.
