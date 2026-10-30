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
| `src/server/api_docs.rs` | 1105 | the library over HTTP, the receive endpoint, asides, Lately's routes and `lately_log` (what every writer calls beside its event), terminal and reveal |
| `src/server/api_desk.rs` | 1535 | Home, desks, panels, notes, keys, pastes, Ctrl-clicked paths; every route behind `refuse_desk` |
| `src/server/api_agent.rs` | 638 | `/api/agents`, connect, and what an agent in a panel says (`/api/panes/{id}/*`, token + running pane) |
| `src/server/api_peer.rs` | 820 | a friend's snyvi: pairing, the friends list, Send to…, a line, an agent's offer, what is done with a frame (`docs/PEER.md`) |
| `src/server/api_friend.rs` | 90 | a friend as one place: `/friend/{id}`, `/api/peers/{id}/talk`, and a new version landing with its earlier ones (1.49) |
| `src/server/peer_link.rs` | 260 | the link: one WebSocket to the relay for as long as there is a friend; frames pushed, acked, swept over HTTP when the socket will not open |
| `src/server/api_browse.rs` | 378 | browse mode over HTTP, ranged file serving |
| `src/server/events.rs` | 249 | SSE: the stream, the window/agent mark, `resync`, focus |
| `src/server/ws.rs` | 291 | the desk socket |
| `src/server/lifecycle.rs` | 912 | health, about, restart and the planned exit, the update watcher, relaunch, reset |
| `src/server/tests.rs` | 830 | the route table every route must be in, and the rest of the server's tests |
| `src/store.rs` | 2320 | documents on disk, SQLite index, FTS5, versions, projects, workflows, inbox |
| `src/store/friends.rs` | 270 | the store's side of friends, thin over `peer`: moved out of `store.rs` at its 2,500 lines (1.49) |
| `src/receive.rs` | 525 | the one entry every transport calls: locate, read, render, file; a friend's bytes come in here too |
| `src/peer.rs` | 1460 | the daemon's identity, the word code, SPAKE2 pairing, the sealed frame, the relay client, the link's address, messages and backoff, the peers tables |
| `src/peer/timeline.rs` | 220 | everything between the reader and one friend, merged by time, for their page (1.49) |
| `src/render.rs` | 1760 | Markdown → HTML once, at receive time; outline; code; Mermaid left to the page |
| `src/browse.rs` | 818 | a folder read from disk, nothing stored |
| `src/watch.rs` | 357 | mtime change detection for browse and `snyvi watch` |
| `src/aside.rs` | 264 | a line beside the work: its checks and its quiet, kept as Lately rows |
| `src/lately.rs` | 438 | Lately: everything that came from outside, kept (documents, versions, asides, a friend's line, reply, tick, answers), one seen watermark, news pruned after 14 days (`docs/DESIGN.md` §4.5) |
| `src/thread.rs` | 1151 | threads, turns (Your turn) and suggested panels: the tables, the stages, who is told what (#90) |
| `src/server/api_thread.rs` | 734 | threads over HTTP: the agent's and the mod's on `/api/panes/{id}/…`, the page's on `/api/desks/{id}/…`, the held question's long-poll |
| `src/claude_mod.rs` | 144 | the snyvi mod (`mod/`) built in, written to the data folder, named in a panel's `CLAUDE_CODE_PLUGIN_DIRS` |
| `src/mcp/threads.rs` | 247 | the eight #90 MCP tools: start_thread, move_thread, ask, hand_over, settle_asks, remove_card, suggest_panel, suggest_desk |
| `src/project.rs` | 168 | cwd → project (git root) |
| `src/git.rs` | 251 | branch, dirt, unpushed, recent commits for Home |
| `src/gh.rs` | 200 | a thread's PR as `gh pr view` says it: open, merged, closed, the merge and who made it, the checks; who gh is signed in as (1.43) |
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
| `src/statusline.rs` | 514 | Claude Code status line: feeds the panel, prints its line in a desk panel |
| `src/links.rs` | 252 | a desk's links in the rail's foot (`pin_link`) |
| `src/due.rs` | 530 | a date on a line (1.47): the tail grammar (`by fri 10`), the local offset read once, the clock that raises one `due` card at the hour, its Done and Later |
| `src/onyou.rs` | 558 | On you, widened (1.54): every row that is the reader's -- cards, dated lines, a routine's line, plans, lines to keep, left-offs -- ranked into one list with its sentence; when the tray opens itself (`arrive`); Tomorrow and Not this on a left-off; what the brief says was Not this |
| `src/waiting.rs` | 198 | what waits on the reader (1.47): `needs` on a left-off, Approve on a plan and on a left-off, Home's Waiting on you rows |
| `src/mcp.rs` | 1040 | the stdio MCP server, nine tools |
| `src/agents.rs` | 1157 | the registry: claude, codex, cursor, gemini; what each has |
| `src/client.rs` | 1153 | CLI/MCP → daemon over HTTP with the token; starts the daemon if needed |
| `src/setup.rs` | 1,049 | `init-claude`, undo, PATH, the skill in `src/skill/` |

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
| `ui/home.js` | 1330 | lazy | Home, with Friends |
| `ui/peer.js` | 237 | lazy | pairing, Send to…, a line for a friend, an agent's offer |
| `ui/friend.js` | 250 | lazy | a friend's page: everything between you, both ways, and a foot that sends (1.49) |
| `ui/about.js` | 1025 | lazy | About, updates that ask |
| `ui/mmd.js` | 987 | lazy | Mermaid driver |
| `ui/game.js` | 701 | lazy | the rocket |
| `ui/menu.js` | 571 | lazy | context menus |
| `ui/look.js` | 358 | lazy | theme, accent, Aa |
| `ui/corner.js` | 743 | lazy | the corner on every page: the card that rises, the pill, the tray (On you and Lately), snyvi's own lines, the chime; a desk's corner draws its parts (`docs/DESIGN.md` §4.5) |
| `ui/palette.js` | 304 | lazy | ⌘K |
| `ui/player.js` | 114 | lazy | a song's own controls, and one player sounding at a time; fetched on the first press |
| `ui/plan.js` | 34 | lazy | Approve on a plan's head (1.47); fetched on the first press |
| `ui/toast.js`, `ui/tip.js`, `ui/keys.js`, `ui/paths.js`, `ui/frame.js`, `ui/find.js`, `ui/browse.js`, `ui/diff.js` | < 200 each | lazy | one thing each |

## Benches (`bench/`)

`bytes.mjs` first-paint budget · `lint-ui.mjs` design-system debt ratchet ·
`size.mjs` file/function size ratchet · `ui.mjs` page behaviour ·
`restart.mjs`, `update.mjs` lifecycle on a spare port · `webkit.py --desk`
paint cost under Xvfb (target < 15 %) · `open.mjs` the window's first request ·
`media.mjs`, `film/` the README's camera.

## The relay (`relay/`)

One Cloudflare Worker, `relay/src/index.ts`, two Durable Object classes
(`Room` for the minute of pairing, `Mailbox` per address, which holds each
daemon's WebSocket through hibernation and pushes a frame as it lands),
tested by `relay/test/relay.test.mjs` against `wrangler dev` in CI, the
link included, deployed by hand. See `relay/README.md` and `docs/PEER.md`.
