# Modules

The longer map behind `CLAUDE.md`: what each file is for, what it talks to,
and the sizes the ratchet in `bench/size.mjs` holds. Line counts are from
1.13.0; `node bench/size.mjs` prints today's.

## Daemon

| File | Lines | What |
|---|---|---|
| `src/main.rs` | 623 | the CLI: one match arm per subcommand, then `server::run` |
| `src/server/mod.rs` | 653 | the `App`, `new_app`, the router (one layer in front: the host gate), `run`, the one `doc` event every arrival ends in |
| `src/server/auth.rs` | 259 | the three leaves (token, capability, window secret), the host gate, `refuse_desk`, `refuse_reader` |
| `src/server/assets.rs` | 648 | the shell pages, the `ASSETS` table (routes, hashes and the live read all come from it), fonts, Mermaid, a document's files |
| `src/server/api_docs.rs` | 815 | the library over HTTP, the receive endpoint, asides, terminal and reveal |
| `src/server/api_desk.rs` | 1535 | Home, desks, panels, notes, keys, pastes, Ctrl-clicked paths; every route behind `refuse_desk` |
| `src/server/api_agent.rs` | 638 | `/api/agents`, connect, and what an agent in a panel says (`/api/panes/{id}/*`, token + running pane) |
| `src/server/api_browse.rs` | 378 | browse mode over HTTP, ranged file serving |
| `src/server/events.rs` | 249 | SSE: the stream, the window/agent mark, `resync`, focus |
| `src/server/ws.rs` | 291 | the desk socket |
| `src/server/lifecycle.rs` | 912 | health, about, restart and the planned exit, the update watcher, relaunch, reset |
| `src/server/tests.rs` | 830 | the route table every route must be in, and the rest of the server's tests |
| `src/store.rs` | 2396 | documents on disk, SQLite index, FTS5, versions, projects, workflows, inbox |
| `src/receive.rs` | 525 | the one entry every transport calls: locate, read, render, file |
| `src/render.rs` | 1760 | Markdown → HTML once, at receive time; outline; code; Mermaid left to the page |
| `src/browse.rs` | 818 | a folder read from disk, nothing stored |
| `src/watch.rs` | 357 | mtime change detection for browse and `snyvi watch` |
| `src/aside.rs` | 217 | a line beside the work |
| `src/project.rs` | 168 | cwd → project (git root) |
| `src/git.rs` | 251 | branch, dirt, unpushed, recent commits for Home |
| `src/resolve.rs` | 211 | a Ctrl-clicked word → a path |

## Desks

| File | Lines | What |
|---|---|---|
| `src/desk.rs` | 2935 | **over.** desks, panes rows, panes_closed, desk_notes, desk_keys names, the brief's data; shared ops the UI and the agent path both call |
| `src/pane.rs` | 2175 | a PTY and the process on it; `SNYVI_SESSION` and key values into the env |
| `src/screen.rs` | 1995 | vte → cells → frames the page paints |
| `src/prompt.rs` | 571 | snyvi's own shell prompt |
| `src/secrets.rs` | 282 | desk key values: keychain on macOS/Windows, 0600 file on Linux |
| `src/capability.rs` | 184 | the window's 32-byte capability, minted per launch, saved 0600 |
| `src/config.rs` | 101 | paths, port, the write token |

## Agents

| File | Lines | What |
|---|---|---|
| `src/hook.rs` | 1190 | Claude Code hooks: SessionStart brief, prompt/tool/stop status, Markdown writes sent |
| `src/brief.rs` | 627 | the desk brief text |
| `src/session.rs` | 128 | session id ↔ cwd/pane bookkeeping shared by hook and MCP |
| `src/statusline.rs` | 394 | Claude Code status line |
| `src/mcp.rs` | 910 | the stdio MCP server, eight tools |
| `src/agents.rs` | 1157 | the registry: claude, codex, cursor, gemini; what each has |
| `src/client.rs` | 1153 | CLI/MCP → daemon over HTTP with the token; starts the daemon if needed |
| `src/setup.rs` | 901 | `init-claude`, undo, PATH |

## Lifecycle

| File | Lines | What |
|---|---|---|
| `src/update.rs` | 2920 | **over.** check, stage, verify (minisign), apply, roll back |
| `src/platform.rs` | 962 | open URL, notify, kill, autostart, per OS |
| `src/desktop.rs` | 284 | which face opens the viewer |
| `src/reset.rs` | 301 | back to a fresh install |
| `src/bench.rs` | 1044 | `snyvi bench`: the budgets as tests |
| `src/strip.rs` | 500 | comments and indentation out of `ui/` on the way into the binary; `source` joins a script kept as parts |
| `src/bin/app.rs` | 866 | the native window; nothing else |
| `build.rs` | 105 | runs the strip; records commit and target |

## Page

| File | Lines | Loaded | What |
|---|---|---|---|
| `ui/index.html`, `ui/boot.js`, `ui/app.css`, `ui/themes.css` | — | first paint | shell, theme before paint, styles |
| `ui/app/01-shell.js` … `10-boot.js` | 119–871 each | first paint | `app.js`, as ten parts in one function scope: shell and helpers, tree, queue and what moved, documents and connect, notes and live refresh, the rail, navigation, desks, what snyvi says back, boot. `build.rs` joins them in name order |
| `ui/desk/01-head.js` … `08-style.js` | 123–882 each | lazy | `desk.js`, as eight parts of one module: head, socket, screen, keys and a pane, the desk, the rail, actions and the seam, style |
| `ui/home.js` | 1221 | lazy | Home |
| `ui/about.js` | 1025 | lazy | About, updates that ask |
| `ui/mmd.js` | 987 | lazy | Mermaid driver |
| `ui/game.js` | 701 | lazy | the rocket |
| `ui/menu.js` | 571 | lazy | context menus |
| `ui/look.js` | 358 | lazy | theme, accent, Aa |
| `ui/note.js` | 330 | lazy | the aside card |
| `ui/palette.js` | 304 | lazy | ⌘K |
| `ui/toast.js`, `ui/tip.js`, `ui/keys.js`, `ui/paths.js`, `ui/frame.js`, `ui/find.js`, `ui/browse.js`, `ui/diff.js` | < 200 each | lazy | one thing each |

## Benches (`bench/`)

`bytes.mjs` first-paint budget · `lint-ui.mjs` design-system debt ratchet ·
`size.mjs` file/function size ratchet · `ui.mjs` page behaviour ·
`restart.mjs`, `update.mjs` lifecycle on a spare port · `webkit.py --desk`
paint cost under Xvfb (target < 15 %) · `open.mjs` the window's first request ·
`media.mjs`, `film/` the README's camera.
