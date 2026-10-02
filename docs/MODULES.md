# Modules

The longer map behind `CLAUDE.md`: what each file is for, what it talks to,
and the sizes the ratchet in `bench/size.mjs` holds. Line counts are from
1.13.0; `node bench/size.mjs` prints today's.

## Daemon

| File | Lines | What |
|---|---|---|
| `src/main.rs` | 623 | the CLI: one match arm per subcommand, then `server::run` |
| `src/server.rs` | 7019 | **over the ceiling.** Router, all handlers, SSE, WS, assets, lifecycle, auth helpers, gate tests. Being split into `src/server/{mod,assets,lifecycle,api_docs,api_desk,api_agent,ws,auth}.rs` |
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
| `src/strip.rs` | 450 | comments and indentation out of `ui/` on the way into the binary |
| `src/bin/app.rs` | 866 | the native window; nothing else |
| `build.rs` | 105 | runs the strip; records commit and target |

## Page

| File | Lines | Loaded | What |
|---|---|---|---|
| `ui/index.html`, `ui/boot.js`, `ui/app.css`, `ui/themes.css` | — | first paint | shell, theme before paint, styles |
| `ui/app.js` | 3955 | first paint | **over.** sidebar tree, document view, SSE, navigation, the desk context. Splitting into `ui/app/{shell,tree,doc,events,nav}.js` concatenated by `build.rs` |
| `ui/desk.js` | 3889 | lazy | **over.** the desk: canvas panes, rail, notes, protocol. Splitting into `ui/desk/{view,rail,notes,index}.js` |
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
