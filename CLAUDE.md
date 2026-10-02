# snyvi, for an agent working in this tree

snyvi is a local document viewer with desks: a Rust daemon on 127.0.0.1:7777
(axum, SQLite, PTYs) embedding a vanilla-JS page, a separate `snyvi-app`
window that opens it, an MCP server and Claude Code hooks that feed it.
Read this, then `docs/MODULES.md` when you need the longer map.

## Where things live

| Owns | Module | Must not |
|---|---|---|
| the `App`, the router, `run`, the one `doc` event | `src/server/mod.rs` | hold handlers; each concern has its file below |
| who may call what: token, capability, window secret, host gate | `src/server/auth.rs` | be copied into a handler |
| what the browser loads: shell pages, the `ASSETS` table, fonts | `src/server/assets.rs` | serve a path a URL names |
| the library API, the receive endpoint, asides, folders | `src/server/api_docs.rs` | — |
| the page's side of a desk: Home, desks, panels, notes, keys | `src/server/api_desk.rs` | skip `refuse_desk` |
| the agent's side: `/api/panes/{id}/*`, agents | `src/server/api_agent.rs` | reach the store before `agent_pane` |
| the desk socket · SSE · browse mode · restart, update, reset | `src/server/{ws,events,api_browse,lifecycle}.rs` | — |
| the route table test | `src/server/tests.rs` | lag the router: the count must match |
| documents on disk + SQLite index + FTS | `src/store.rs` | know about HTTP or panes |
| desks, panes rows, notes, keys (names) | `src/desk.rs` | run processes; `pane.rs` does |
| a PTY, its process, its screen | `src/pane.rs`, `src/screen.rs` | touch the store |
| every transport's way in | `src/receive.rs` → `render.rs` | be bypassed; hook, MCP, CLI, watch all call it |
| who may call what | `src/capability.rs`, `src/config.rs` (token), `src/secrets.rs` (desk key values) | be duplicated in `server.rs` |
| Claude Code side | `src/hook.rs`, `src/brief.rs`, `src/session.rs`, `src/statusline.rs`, `src/setup.rs` | write hooks for another binary |
| MCP tools | `src/mcp.rs`, `src/agents.rs` (which agent has what) | reach the store directly; they go through `client.rs` |
| CLI → daemon | `src/client.rs`, `src/main.rs` | be the only path a test knows |
| self-update, restart | `src/update.rs`, `src/platform.rs`, `src/desktop.rs` | — |
| the window | `src/bin/app.rs` | hold daemon logic |
| first paint | `ui/index.html`, `ui/boot.js`, `ui/app/*.js` (joined into `app.js`), `ui/app.css`, `ui/themes.css` | grow past the budget (`bench/bytes.mjs`) |
| lazy chunks | `ui/desk/*.js` (joined into `desk.js`), `ui/home.js`, `ui/about.js`, `ui/mmd.js`, `ui/menu.js`, … | be imported by first paint |
| the strip, the join, the embed | `build.rs`, `src/strip.rs` (`source` joins `ui/app/*.js` and `ui/desk/*.js` in name order; `SNYVI_UI_DIR` serves the same join) | serve a part on its own |

## The three flows

1. **Document**: hook / MCP / CLI → `POST /api/send` (token) → `receive::receive` → `render` → `store` → broadcast → SSE `/api/events` → `app.js` redraws.
2. **Panel**: `app.js`/`desk.js` → `WS /api/desk` (capability) → `pane` PTY → `screen` frames → canvas paint. Keystrokes go PTY-ward only from the reader.
3. **Agent in a panel**: `SNYVI_SESSION` in the pane env → MCP `read/tick/mark/suggest_desk_note`, `leave_off`, `name_panel` → `client.rs` → `/api/panes/{id}/*` (token) → `desk` → SSE.

## Invariants (do not move them)

- Local only. Bind 127.0.0.1; every route checks `Host`/`Origin`; no accounts, no telemetry, nothing leaves the machine.
- **Capability ≠ token.** The capability is the window's (desk routes, reader actions). The token is the agent's (`send`, `aside`, `panes/{id}/*`). A token never mints a capability and never starts a command.
- snyvi never makes input from content it received. Agents send, snyvi shows. No command runner.
- Nothing is deleted. A ✕ removes from view and stays recoverable. Documents are immutable; a resend is a new version.
- No layout shift: nothing that comes and goes may move the page.
- First paint ≤ the budget in `bench/bytes.mjs`. Files ≤ 2,500 lines, functions ≤ 120 (`bench/size.mjs`); what is over may only shrink.
- One `Mutex<Connection>` for SQLite; migrations run once by `user_version`.

## Verify

```
cargo test
cargo +<CI stable> clippy --all-targets -- -D warnings    # CI's Rust is newer than local
node bench/bytes.mjs --check && node bench/lint-ui.mjs --check && node bench/size.mjs --check
snyvi bench --check
```

Review in a test window on a spare port (`SNYVI_PORT=78xx`, `SNYVI_UI_DIR=ui` hot-reloads `ui/`), never the daemon on 7777.

## Working here

- Another session may be editing this checkout or a sibling worktree. Stage by hunk; never touch files you did not change.
- One PR, one push at the end: builds are costly. The version bump (`Cargo.toml` + `Cargo.lock`) goes in the work PR.
- Prose in `ui/` is free: `build.rs` strips it. Write the why above the code.
- `app.js` and `desk.js` are parts: add code to the part it belongs to, or a new numbered part; never recreate the whole file.
- A new route goes in its `api_*.rs`, the router, and the table in `tests.rs`, or the count test fails.
- Plans and docs for the maker go to snyvi (`send_document`), with Mermaid flows and a before/after.
