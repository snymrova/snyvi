# UI 1.7.1: the rail, panels, the first ten minutes

Implementation plan for the audit of 2026-09-26 (snyvi doc 66af7fd2f8). The
audit says what is wrong and what to change; this says in what order, in which
file, with which tests, and where the audit's proposal does not survive contact
with the code. Line numbers are against `claude/desk-paint` @ 90f09d6 (1.6.0);
1.7.0 (PR #40) moved some of them, so read them as pointers, not positions.

1.7.1, not 1.7.0: 1.7.0 is the auto-update release, already in CI. This is the
first release after it, so it is also the first one a 1.7.0 install updates
itself to. §4.1 is how that gets checked.

Three pieces, one branch, one push, the version bump in the work PR. Order by
value to the reader: rail → panels → onboarding. P3 items ride along as single
commits. Nothing is built until you say to review; the review happens in the
separate test window on its own port, never on 7777.

---

## 0. Before any code

1. **Branch point.** PR #40 (`claude/updates`, 1.7.0) carries #39's 1.6.0
   commits and the updater. Start 1.7.1 from main once #40 is merged and
   v1.7.0 is tagged, in its own worktree the way `claude/updates` has one.
   The main checkout still carries an uncommitted early copy of the updater's
   Phase 0 (`ci.yml`, `release.yml`, `Cargo.toml` `app_min`, `homebrew.sh`,
   `screen.rs`, `packaging/manifest.py`, `minisign.pub`); #40 has the real
   one, so that copy is dropped, never carried into this PR.
2. **Headroom.** Measured on 1.6.0 as served (stripped, gzip): first paint is
   52.0 KB of the 53 KB budget, app.js 34.4 KB and app.css 14.7 KB of it.
   1.7.0's update pill brought it to 52.7 KB, so re-measure on the branch
   point before §1.0; the moves below have ~0.7 KB less slack. The
   budget goes *down* to 52 KB in this PR (bytes.mjs:60, BRAINSTORM.md:35),
   and the rail is ~4.5 KB of first-paint code, so ~5 KB has to leave first
   paint before the rail lands. §1.0 says what, with the number each move is
   worth; it is the first commit on the branch, so every later `bytes.mjs
   --check` is against 52.
3. **Baseline.** `node bench/ui.mjs --check` green on the branch point, so a
   red row later is this work's.
4. **Three audit claims to verify, not assume.**
   - desk.rs:10-16 "nothing spawns a shell on wake, which `resume()` now does":
     settled on 2026-09-27. `resume()` is the page's (desk.js:775), not the
     daemon's, and it does start the shell again after a restart. §2.9
     corrects the comment.
   - "A drag cannot land on an empty slot" (P1): with slots compacted (below)
     `layout()` spans an odd last panel across the row (desk.js:890), so a
     1-, 2- or 3-panel desk has no empty cell to draw. The item goes away.
   - THEMES.md:10 and :308 say the foot has five buttons; index.html:35-52 has
     seven. Housekeeping, but check nothing else counts them.

---

## 1. The rail (audit §3)

Two states: open (264 px) and rail (44 px). `data-side="0"` becomes rail at
every width. The popover re-parents the section's existing element; nothing
is rendered twice.

### 1.0 Make room first — `ui/app.js`, `ui/app.css`, new chunks

What first paint carries that nothing on screen needs until an action, with
what each move saves as served (the number is the gzip difference of app.js
or app.css with the block removed, not the block's own size). The rule the
1.6 raise set still holds: anything that answers a click in the same frame —
toasts, a row's Undo, the queue, the tree, the SSE stream — stays.

| Move | To | Loaded when | Saves |
|---|---|---|---|
| Theme stepping, `THEMES`, `previewTheme`, `loadThemes`, the accent and font pickers, `FONTS`, `ACCENTS`, `sayTermSize` (app.js 3258-3464) | new `look.js` | the foot column is hovered or focused, or the palette types `theme` | ~2.0 KB |
| `.foot-rail`/`.foot-set` styles (app.css 531-590) | `look.js` carries them the way about.js carries the connect page's | same | 0.3 KB |
| The letter-key `switch` (app.js 3704-3750) | `keys.js`, which `⌃B` already loads before any letter can fire | `⌃B` | ~0.9 KB |
| The aside card: `renderNote`, the trail, ghost and Undo (app.js 1535-1703) and `#note`/`.note*` styles | new `note.js` | `state.notes` is non-empty at boot, or the first `note` event | ~2.8 KB |
| `.mmd*` styles (25 rules) | `mmd.js` | the first diagram | 0.5 KB |
| `.help-box`, `#help`, `.about-box`, `.hk`, reset styles (36 rules) | `about.js`, which fills all three boxes | `?`, About, Reset | 0.5 KB |
| `.game*` styles | `game.js` | the rocket | 0.1 KB |
| The narrow-window sidebar sheet (app.js 3536-3581 half, app.css 244-246) | retired by the rail (§1.3) | — | ~0.6 KB |

About 7.7 KB out, 4.5 KB in for the rail: first paint lands near 49 KB, 3 KB
under the new budget. The five asides of §3.3 go in `note.js`, so onboarding
costs first paint nothing.

What stays, and why it was looked at: `deleteDoc`/`undoGone`/`putAway`
(app.js 1320-1500) answer a click; `renderDesks`, `showDesk`, the back stack
and the SSE `connect` (2581-3069) are the sidebar and the stream; the mascot
faces and `toast` (3070-3220) are what a click is answered with;
`showCompare`/`applySplit` and the connect-page glue are under 1 KB together
and not worth a chunk each.

Rules for the two new chunks: same `import()` shape as the nine existing ones
(app.js:1238 is the model), `?v=` cache key from `boot.v`, a `<style>` block
appended once as about.js:174 does, a row each in bytes.mjs `CHUNKS`, and a
`parses` check comes free. `keys.js` gains the switch as an exported
`letter(e, ctx)`; `?` and Esc stay in app.js because §3.1 wants `?` before the
letters are on. `note.js` exports `render`, `close`, `undo`; app.js keeps only
the dot's `data-note` attribute and the import trigger, so the rail badge
(§1.3) works with the chunk unloaded.

Then `BUDGET = 52 * KB` in bytes.mjs and "< 52 KB" in BRAINSTORM.md:35, with
a line under the 1.6 comment saying 1.7.1 took it back down and how.

### 1.1 Markup — `ui/index.html`

- Inside `#side`, after `.side-head`: `<nav id="rail-nav" hidden
  aria-label="Sidebar">` with six buttons, `data-pop="inbox|tree|desks|browse"`
  on the four sections, `data-nav="connect"` on the agents pill, `data-pop="note"`
  on the aside dot. Each button: `icon(k)` from the `ICONS` map (app.js:165,
  which has inbox, project, desk, folder), `data-label` for the hover label,
  an empty `<b class="badge">` for the number.
- After `#trees`: `<div id="pop" hidden>`; empty until opened.
- The foot column stays where it is; in rail mode it is the rail's bottom.
  `#btn-search` moves from `.side-head` into the rail's lower group (it is
  ⌘K either way). The expand button is `#btn-side-hide` with its icon flipped
  by CSS under `data-side="0"`.

### 1.2 Styles — `ui/app.css`

- `:root[data-side="0"] #app { grid-template-columns: 44px minmax(0,1fr) var(--rail-w) }`
  replacing the `0` at app.css:207, and the three combined rules at 211-213.
- `:root[data-side="0"] #side { display:flex }` replacing `display:none` at
  208, with `#trees`, `.brand-name`, `#live` (it is in the rail list), `.gutter`
  and `#note` hidden, `#rail-nav` shown, `.side-head` reduced to the brand mark.
- `#rail-nav` buttons: 28 px, the foot-rail's `::after` label rule
  (app.css:565-571) generalised to `.side-label::after` and applied to both.
- Badges: `<b>` absolutely placed top-right of the icon, 10 px, `--accent` on
  `--accent-bg`; the desk button's amber `!n` reuses the rail row's `blk`
  colour.
- `#pop`: `position:fixed; z-index:20; width: var(--side-w); max-height:
  calc(100vh - 16px); overflow:auto; background: var(--bg-raise);
  border-radius: var(--radius); box-shadow: var(--shadow)`, the toast's tail
  on its left edge, `sheet-l`'s 160 ms slide reused. Under 760 px:
  `inset: 0 auto 0 44px; width: min(88vw, var(--side-w)); max-height: none`
  and `#scrim` shown by `:root[data-pop]`.
- `transition: grid-template-columns 160ms` on `#app`, inside the existing
  `prefers-reduced-motion` guard at 313.
- macOS: `:root[data-frame="mac"][data-side="0"] #rail-nav { padding-top:
  28px }` (frame.js:35 today pads the head 84 px left). Check `#chrome` too:
  with the sidebar 44 px the traffic lights reach ~34 px into `#main`, and
  `#chrome #btn-side` is hidden, so whatever is first in `#chrome` needs
  `padding-left` under that rule.
- Delete the `@media (max-width:760px)` special case at 244-246 that sets the
  sidebar to a fixed sheet; the popover is the sheet at that width.

### 1.3 Behaviour — `ui/app.js`

- `openPop(sec, btn)` / `closePop()` next to the sheet code (3546-3564).
  Open: `root.dataset.pop = sec`; move `#queue`+`#inbox-row` / `#tree` /
  `#desk-nav` / `#browse-nav` / `#note` into `#pop` (`append`, which
  re-parents), place `#pop` with the same `getBoundingClientRect()` maths
  `placeToasts` uses for "a control in the left rail answers to its right"
  (3122-3135), clamped like `#ctx`; focus the first row. Close: move the
  element back into `#trees` in document order (keep a static array of the
  five ids so order is not lost), `delete root.dataset.pop`, focus the icon.
- One popover at a time: `openPop` on another section closes the first.
- Closers: Esc (the chain at 3673 gains `closePop()` first), click outside
  (`#scrim` at narrow widths, a `pointerdown` listener on `document` at wide
  ones), following a link inside it (`#trees` already delegates clicks; a
  navigation closes), and `\`.
- `\` and `#btn-side` / `#btn-side-hide`: `fold("side")` at every width;
  delete the `sideNarrow.matches ? toggleSheet(...)` branches at 3573, 3577,
  3742. `sideNarrow` survives only for `#pop`'s full-height rule, which is
  CSS, so the media query object can go if nothing else reads it.
- Badges: `renderQueue` writes `state.waiting` into the inbox badge;
  `renderDesks` writes the blocked count into the desk badge and toggles a
  running dot; `renderLive` writes the agents count into the pill (it already
  writes `#live`; let the rail hold the same element by moving `#live` into
  `#rail-nav` in rail mode, or give the renderer two targets).
- Aside dot: `renderNote` sets `root.dataset.note` already (1575); the dot
  styles off that attribute. Opening the note popover moves `#note` in.
- Keyboard: `#rail-nav` is a toolbar; ↑↓ move focus between buttons, Enter
  or Space opens, Tab leaves. The `keyboardRows` bench already walks Tab.
- Game: `game.open($("#side"))` at 3518 draws over the whole sidebar; in rail
  mode it is 44 px wide. Disable `#btn-game` under `data-side="0"` with a
  label saying so.
- `openSheet("side")` and everything that references `data-sheet="side"`
  goes; `"rail"` (the contents rail) stays untouched.

### 1.4 Tests

- `bench/ui.mjs`: a new `sideRailRows` (the existing `railRows` is the
  contents rail): `\` makes `#side` 44 px wide; each of the five icons opens
  `#pop` with that section's element inside it; Esc closes and focus is on
  the icon; after expand the five are back in `#trees` in order; the inbox
  badge equals `state.waiting` after an arrival; Tab reaches every icon;
  under 760 px `#pop` is full height and `#scrim` is shown.
- `narrowRows` (536) tests the sheet that this retires. Rewrite the sidebar
  half of it to the popover; the contents-rail half stays.
- `bench/bytes.mjs --check`.

### 1.5 Risks

- Re-parenting while an SSE handler is mid-render: every renderer writes by
  id, so it lands wherever the element is; the one thing to check is code
  that assumes `#trees` contains them (`openSheet`'s `#trees a[aria-current]`
  at 3553, and `renderTree`'s `roomIn` width measure — the popover is
  `--side-w` wide, so the measure is the same).
- `position:fixed` inside an animated ancestor: while `#side` runs a
  transform animation, a fixed child positions against it. `#pop` is only
  opened after the width transition, and the width transition is on
  `grid-template-columns`, not a transform, so this should not bite; if it
  does, `#pop` moves to `<body>`.

Effort ~1 day.

### 1.6 The waiting list keeps one row per file — `ui/app.js`, `bench/ui.mjs`

Seen 2026-09-27: this plan, sent four times as it grew, showed two rows under
Waiting while the badge said 1. The store was right. All four sends are
versions of `docs/UI-PLAN.md`; `head_docs` (store.rs:268) lists only the
newest; a new version marks the older ones read (store.rs:349); the daemon's
`waiting` counts one. The page was wrong: the `doc` handler (app.js:2918)
pushes the arrival into `state.queue` (2950) and never takes out the version
it replaces, although the event names it (`supersedes`, server.rs:1678). The
old row stays until something refetches the queue, such as a reload.

- **Fix.** In the `doc` handler, before the push, drop every queued row with
  the arrival's `project_id` and `source_path` (a document with no file
  behind it has no lineage and is left alone, as in `head_docs`). By file,
  not by `j.supersedes`: `supersedes` names only the version just before,
  and a page that missed one event would keep the one before that. The drop
  goes through `dropFromQueue` (app.js:469), so the leaving row animates out
  and the tree's unread marks follow. A row the reader is reading is not in
  the queue, so the "A newer version arrived" offer (2963) is untouched.
- **Same rule on a refetch.** `refetchQueue` (1381) already reads the
  daemon's list, which is right by construction; nothing to change there.
- **Test.** `queueRows` in `bench/ui.mjs` (828): send a file, send it again
  with a changed body and a different title, without reading either; the
  sidebar's `#queue` shows one row with the second title, the inbox's
  waiting list shows one, and the badge says 1. Then a third send from a
  second workflow name (the case here: the hook's session workflow and an
  MCP send named "ui audit" land in two workflows): still one row.

Effort ~1 hour, first-paint cost a few bytes.

---

## 2. Panels (audit §1)

### 2.1 Close with Undo, and slots that compact — `src/desk.rs`, `src/pane.rs`, `src/server.rs`, `ui/desk.js`

Both change what a `panes` row means, so they go in one commit.

**Schema.** The audit's "one nullable column" does not work: `UNIQUE(desk_id,
slot)` (desk.rs:65) is a table constraint, so a closed row that keeps its slot
blocks the compaction that reuses it, and a closed row at slot 0 collides with
the next closed row. Dropping the constraint means a table rebuild. Instead a
second table, made with the `CREATE TABLE IF NOT EXISTS` the schema already
uses and no `ALTER`:

```sql
CREATE TABLE IF NOT EXISTS panes_closed (
  id TEXT PRIMARY KEY,
  desk_id INTEGER NOT NULL REFERENCES desks(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL, cmd TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
  agent_session TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL
);
```

`panes` stays the live set: `list()`, `panes_open`, `open_pane`, the cascade on
desk delete, all untouched.

**`close_pane(conn, id, now)`**, one transaction: read the row; insert it into
`panes_closed`; delete it from `panes`; for `s` in `slot+1..=PER_DESK`
ascending, `UPDATE panes SET slot = s-1 WHERE desk_id AND slot = s` (each
target was just vacated, so the constraint is satisfied row by row, the same
reasoning `move_pane` gives at desk.rs:334); renumber `docs.desk_slot` for the
shifted panes the way `Store::move_pane` does; on `desks.full_slot` (2.3): equal
→ 0, greater → minus one. Returns the desk id and the closed slot.

**`restore_pane(conn, id, now)`**: row back from `panes_closed` into `panes` at
the lowest free slot, as `open_pane` picks one; `Opened::DeskFull` → 409
`{"full":"desk"}` (the desk filled in the eight seconds). The process is not
started: it comes back the way a daemon restart brings it, greyed text and
Start offered.

**Kept until `prune`**, like a deleted document (your call, 2026-09-26): no
sweep, no window. `Store::prune` (store.rs:735) gains a clause that deletes
`panes_closed` rows older than `before` and returns their ids, so `main.rs:350`
removes the text files with the documents'. A closed panel is therefore
restorable for as long as a deleted document is, and `snyvi prune --dry-run`
lists both. Reset (`desk::clear`) drops the table with the rest.

**`pane.rs`**: split `close()` (353) into `forget(id)` — stop the process, drop
it from `live` and `told`, keep the file — and `discard(id)`, which is today's
close. `delete_desk` (server.rs:2523) lists `panes_closed` for the desk before
the cascade, so their files go too.

**Routes**: `/api/panes/{id}/delete` now calls `close_pane` + `panes.forget`;
new `POST /api/panes/{id}/restore` → `restore_pane`; both `desks_moved`. The
route-list test at server.rs:3760 gains the line.

**Client** (desk.js): the ✕ loses `sure` (click-twice, 1629); `close` calls
delete, then keeps the rail row for `BACK_MS` with the note pattern at
1687-1700 (`x.gone`, only the newest offer stands): greyed name, "Closed",
Undo. Undo posts restore; on 409 the row says "the desk filled up" and stays
its 8 s. Since the rail is rebuilt from `ctx.desks` after `desks_moved`, the
closed row is a client-side ghost keyed by pane id, like `noteList`'s.
`SNYVI_SLOT` in a running process goes stale on a close as it already does on
a move (DESK.md:329); `[n]` tabs and `⌃⌥n` are now truthful by construction.

**Tests** (desk.rs `#[cfg(test)]`): close slot 2 of {1,2,3} → {1,2}, and docs
renumbered; restore → slot 3; restore into a full desk → `DeskFull`; prune
removes only rows older than `before` and names their files; desk delete
cascades `panes_closed`.
`bench/ui.mjs` `panelRows`: ✕ once closes; Undo brings the row back with Start
offered; after 8 s no Undo; `⌃⌥3` after closing 1 of {1,2,3} focuses the
former 3.

### 2.2 A name — `src/desk.rs`, `src/server.rs`, `ui/desk.js`

- `ALTER TABLE panes ADD COLUMN name TEXT NOT NULL DEFAULT ''` in the
  store.rs:218 list; `Pane.name`, `row_to_pane`, the `SELECT`s in `list`/`get`;
  carried through `panes_closed`.
- `POST /api/panes/{id}/rename {name}`, 80 chars clipped like desk names
  (`rename` at desk.rs:246 is the model), `desks_moved`.
- `what(v)` (desk.js:823) becomes `v.pane.name || v.status.title || ...`; the
  head shows the name and carries the OSC title as `title=`. `short()` follows.
- Three doors, all the ones a desk has: ✎ in the panel head's hover tools, F2
  on the focused rail row, "Rename…" in the panel menu (menu.js registry).
  Reuse `renameDesk`'s inline field.
- `name_panel` MCP tool: not now; noted in DESK.md as the next cheap addition.

### 2.3 Full view that survives — `src/desk.rs`, `src/server.rs`, `ui/desk.js`, `ui/app.js`

- `ALTER TABLE desks ADD COLUMN full_slot INTEGER NOT NULL DEFAULT 0`;
  `Desk.full_slot`; `/api/desks/{id}/layout` body gains optional `full`
  (0..=4) beside `col`/`row`, one save path.
- `zoom()` (desk.js:1765) posts it; `open()` (1825) reads `d.full_slot`
  instead of the `fullAt` Map, which goes with its line 36. Compaction adjusts
  it (2.1); a restore never sets it.
- `w` on a desk calls the desk's zoom; the refusal at app.js:3357 goes. Full
  view with one panel is "hide the chrome", which `layout()` already does
  through `data-full`.
- Rename `zoomed` → `full` throughout desk.js while here (audit's P3).

### 2.4 `room()` measures the grid — `ui/desk.js`

- `room()` (860) takes the grid's width; a `ResizeObserver` on `.dk-grid`
  set up in `draw()` after the grid exists (the per-pane one at 713 is the
  pattern), calling `layout()` with the same thresholds shifted for the
  chrome: `> 1000 → 4, > 600 → 2`. `onResize` (1806) keeps the window case.

### 2.5 Keys for the lifecycle — `ui/desk.js`, `ui/frame.js`, `docs/DESK.md`

In `keys()` (1775), which the pane body already passes ⌃⌥ through (671):

| Key | Does | Guard |
|---|---|---|
| `⌃⌥N` | `act("new")` | `noNew(d)` → toast with the reason |
| `⌃⌥W` | close the focused panel, with 2.1's Undo | none |
| `⌃⌥]` / `⌃⌥[` | focus next / previous in `shown` order, then the rest | wraps |
| `⌃⌥R` | `stop` if running, else `run(v, last cmd)` | none |

Four `.hk` rows in frame.js `HELP` (51-58); the keys table in DESK.md.

### 2.6 One place for the desk's actions — `ui/desk.js`, `ui/menu.js`

- A `⋯` at the right end of `.dk-head` opening the desk row's menu from the
  registry (CONTEXT-MENU.md §"Desk row"), minus Show. "Start all" is the
  `a === "all"` action that exists at desk.js:1646 and never got a menu entry.
- ⤢ stays hover-only on the panel; the ⋯ menu lists "Full view ⌃⌥Z" so it is
  findable. Head-drag and `⌃⌥⇧+Arrow` get their help rows with 2.5.

### 2.7 Housekeeping, one commit, no behaviour

desk.rs:275-286 (the removed global cap in `open_pane`'s doc), desk.rs:10-16
(after 0.4's check), NOTES-PLAN.md:5 ("Nothing here is built" → built in
1.6.0, PR #39), THEMES.md:10 and :308 (seven), and the scrollback warning
from NOTES-PLAN #14 item 2 is struck from the plan there (your call,
2026-09-26).

### 2.8 What the agent knows: model and context window — `src/statusline.rs`, `src/setup.rs`, `src/pane.rs`, `ui/desk.js`, `ui/app.js`

Asked 2026-09-26: the meta pane's Panel row should say which agent is in the
panel and how full its context window is.

**Where the number comes from.** Hooks carry no token counts (hook.rs reads
`hook_event_name`, `session_id`, `cwd` and nothing about usage). Claude Code's
status line does: the `statusLine` command in `~/.claude/settings.json`
receives the full JSON on stdin at session start and after every assistant
message, debounced at 300 ms (docs: code.claude.com/docs/en/statusline).
Confirmed fields, Claude Code 2.1.283:

| Field | Use |
|---|---|
| `session_id` | the pane's `agent_session`, already matched by hook.rs:46 |
| `model.display_name` | "Fable 5.1", the name on the row |
| `context_window.used_percentage`, `context_window_size`, `total_input_tokens` | the number, its ceiling, and the raw count for the tooltip |
| `cost.total_cost_usd` | not read: no cost anywhere (your call, 2026-09-27) |
| `agent.name` | present only with `--agent`; shown instead of "claude" when it is |
| `cwd` | keeps `session::record` fresh, as hooks do |

**`snyvi statusline`**, a `Cmd` beside `Cmd::Hook` (main.rs:314). Reads the
JSON; in a desk panel (`SNYVI_SESSION`, the test hook.rs:41 makes) posts it to
the daemon through the client path `agent_state` uses, with the new fields.
It prints nothing (your call, 2026-09-27): the status line exists only to feed
snyvi, and Claude Code's bottom line stays empty as it is today. It always
exits 0 and never waits long on the daemon (the same short timeout the hook's
client call has), since Claude Code runs it after every reply. One exception
keeps a reader's own line: if `init-claude` finds a `statusLine` already set,
it is kept as `snyvi statusline -- <old command>`, stdin copied through and
the old command's output printed unchanged; `uninstall-claude` puts the old
entry back. `init-claude` writes and `uninstall-claude` removes the entry
under the same rule the hooks follow (plain `snyvi statusline`, never another
binary's path). `snyvi status` reports it.

**Daemon.** `Status` (pane.rs:63) gains `model: String`, `ctx_pct: Option<u8>`,
`ctx_size: Option<u32>`, `ctx_in: Option<u64>`, `ctx_at: Option<i64>`;
`SessionEnd` clears them with `agent`. They travel
in the `panes` status JSON (`with_status`, server.rs:2245). A session that is
not in a panel still reaches the daemon keyed by `session_id`: phase 2, not
in this PR, shows those on the connect page and in the agents pill's popover
("claude · Fable 5.1 · ~/Projects/snyvi · 43%").

**Page.** The meta pane's Panel row (desk.js:1314) becomes
`[2] · Fable 5.1 · 43% of 200k · working 2m`; the panel head's `.pn-state`
(837) appends ` · 43%`; the rail's panel row shows the percentage after the
name; the sidebar desk row's `k` column (app.js:2651) shows the fullest
panel's. Quiet in `--fg-3` below 70 %, the row's amber above 85 %, which is
where Claude Code itself starts warning. No number, no glyph: a shell or a
non-Claude agent shows nothing new.

**Tests.** Capture one real payload first, on a throwaway HOME and never the
daily settings (`"command": "cat >> $HOME/sl.json"` for one turn), and keep
it as a fixture; `statusline.rs` parses it in a unit test; the server test
for the route; a `panelRows` row that posts a payload through the API and
reads the head. DESK.md §1 and the wire protocol; setup.rs's output line
names the status line beside the hooks.

Effort ~0.5 day, on top of the panels' 1.5.

### 2.9 A restart puts you back where you were — `src/pane.rs`, `src/desk.rs`, `src/server.rs`, `src/project.rs`, `ui/desk.js`

Seen 2026-09-27 on the "Bos.Dog" desk (rooted at `~`): the reader `cd`'d to
`~/Projects/bos_dog` and ran `claude`; the daemon restarted; Claude was hung
up on ("Resume this session with: claude --resume f94bace6…"); the page's
automatic restart (`resume()`, desk.js:775) started a bare shell in `~`. The
panel's saved text shows it happened more than once that morning. Two faults.

**What 1.7.0 already does, so re-scope this before building it.** The
updater's planned restart (`leave_for_restart`) marks every pane with an
`agent_session` (`desk::mark_resume`); the new daemon carries that as
`status.resume` for 5 minutes, and `resume()` in desk.js starts the panel
as `claude --resume` with no click (`/api/panes/{id}/start {resume:true}`,
the daemon builds the command, so premise 3 holds). That covers Fault 2 for
every restart snyvi asks for itself, updates included. What it leaves:
Fault 1 whole (the resumed conversation starts in `panes.cwd`, so a shell
that `cd`'d comes back in the wrong folder and `--resume` finds nothing), a
stale `agent_session` (below), and restarts snyvi did not plan (a crash, a
kill, a reboot), which are not marked. Fault 2's `agent_open` column and
strip shrink to that last case, and should reuse 1.7.0's mark rather than
add a second one.

**Fault 1: the panel forgets the folder the shell moved to.** `panes.cwd` is
written once, at creation, and `Inner.cwd` (pane.rs:547) once per start. A
`cd` is never seen, so a restart lands in the desk root, and the head's
branch (the git tick at pane.rs:262, which asks `i.cwd`) describes the folder
the shell started in rather than the one it is in.

- **Ask the kernel, not the output.** On the git tick (every 3 s, pane.rs:54),
  read the shell's own working folder: `/proc/<pid>/cwd` on Linux,
  `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS (one `libc` call; `libc`
  comes in behind `cfg(target_os = "macos")` if it is not already a
  dependency). The pid is the shell's, which `Status.pid` already has; a
  child such as Claude does not change it, and a `cd` does. Windows has no
  cheap answer: the folder stays the start folder there, as today, and
  DESK.md says so.
- **Not OSC 7.** The terminal folder report is text any program in the panel
  can print (`cat` of a file is enough), and this folder decides where the
  daemon runs `git status`. A folder the kernel reports is one the reader's
  own shell is in, which their prompt already runs git in. `screen.rs`'s
  `osc_dispatch` (1169) keeps ignoring 7.
- **Belt for the git run:** `project::modified` (project.rs:85) gains
  `-c core.fsmonitor=false`, so no repository's config can make the daemon's
  tick run a command. Worth doing whatever the folder source.
- **Where it goes.** A changed folder sets `Inner.cwd` (so the next git tick
  and the head's branch follow), goes out in the pane's status as `cwd`, and
  is written to `panes.cwd` through a new `desk::set_cwd(conn, id, cwd)` (the
  shape of `set_cmd`, desk.rs:392), at most once per change. `Panes::shutdown`
  (pane.rs:373) reads each shell's folder one last time before it stops them,
  and returns `(id, cwd)` pairs for the caller (server.rs:495) to write, since
  `pane.rs` has no store. The folder must still exist and be a directory at
  the next start, as `start()` already checks (pane.rs:529); if it is gone,
  the start falls back to the desk root rather than failing.
- **Page.** The meta pane's Folder row and the rail's panel row show the
  live folder (`status.cwd || pane.cwd`). The desk's own Folder row stays the
  desk root.

**Fault 2: a restart ends Claude and comes back as a bare shell.** The
process is not persisted, by design (DESK.md §1), so a restart will always
end what runs in a panel. What is missing is the way back. The Resume button
lives on the Start bar (desk.js:639), and the automatic restart skips the
Start bar. The panel also keeps `agent_session` (157a536a… here) while the
conversation that was open was f94bace6…: the hook writes the session at
SessionStart and on state changes (hook.rs:41-53), and a `/resume` or a new
conversation inside one Claude process is caught only by the next state
change, so the saved id can be a conversation behind.

- **Remember that Claude was open.** At shutdown a pane whose `status.agent`
  is not empty had Claude in it (`SessionEnd` clears it, hook.rs:95). Write
  that as `panes.agent_open INTEGER NOT NULL DEFAULT 0` in the same shutdown
  write as the folder, and clear it on the next start of that pane.
- **Keep the id current.** `hook.rs` passes `session_id` on every state event,
  not only SessionStart, and `set_agent_session` (desk.rs:403) already makes a
  repeat a no-op. The status line of §2.8 carries `session_id` after every
  reply, which closes the rest of the gap.
- **Offer, do not type.** DESK.md premise 3: bytes reach a PTY only from
  `input()`, called from a key or paste event. So after the automatic restart
  of a pane with `agent_open`, the panel shows a strip above its first prompt,
  in the rail row's `blk` style: "Claude was open here when snyvi restarted ·
  ↻ Resume conversation · ✕". The button is the existing `again(v)`
  (desk.js:1600), which types `claude --resume <id>` into the prompt as a
  bracketed paste, without Enter, once the shell is at its prompt (`v.mode[1]`).
  ✕ or any key typed into the panel puts the strip away. The rail row's
  existing resume icon (desk.js:1258) stays.
- **Why fault 1 comes first.** Claude files a conversation under the folder
  it was started in, so `claude --resume <id>` typed in `~` does not find a
  conversation started in `~/Projects/bos_dog`. Only a shell that comes back
  in the right folder can take the offer.

**Housekeeping that follows.** desk.rs:10-16 says nothing spawns a shell
because a daemon woke; the page does (desk.js:766-781, "The shell, back,
without being asked twice"). The comment is corrected to say the daemon
does not and the page does, and why. This settles the audit claim §0.4
could not find (`resume()` is in the page, not the daemon).

**Tests.** `pane.rs`: a shell started in a temp folder that runs `cd sub`
reports `sub` within one tick, and `shutdown` returns it (Linux CI; macOS
row where the runner has one). `desk.rs`: `set_cwd` and `agent_open`
round-trip. `bench/ui.mjs` `panelRows`: a panel that `cd`s, then a daemon
restart on the bench's spare port, comes back in the new folder; a panel
whose status had an agent at shutdown shows the strip, and a click types
the resume line with no Enter. Every restart in these rows uses a throwaway
data dir and port, never 7777.

**Separately, not a code change.** The daemon on 7777 reported 1.5.0 from
`/usr/bin` on 2026-09-27 and had restarted twice that morning. Whatever
restarts it (the auto-update work in `~/Projects/snyvi-updates` is the likely
source) ends every Claude session in every panel. Until this section ships,
restarts of the daily daemon are worth avoiding while panels are working.

Effort ~1 day.

Effort for §2 ~3 days; three `ALTER`s and one new table.

---

## 3. The first ten minutes (audit §2)

Within the house rule (ROADMAP.md:1517): no tour, nothing persists as a
checklist. A page, five asides, three sentences, one question.

### 3.1 Three one-liners — first, because they are the stall

- `setup.rs` after the "Try it" line (191), and the equivalent in
  `snyvi init <agent>`: "Restart any Claude Code session that is already
  open: one that was running before this does not see snyvi." `install.sh`
  prints it after `init-claude --auto`.
- `about.js:333`: the "Nothing has arrived from it yet." row gains the same
  sentence.
- `?` before the letters gate: at app.js:3702 the `!keysOn` check runs before
  the switch; hoist `case "?"` (3749) above it, keeping `inField`. The help
  box (about.js:70) then tells the truth.
- Palette: `commandItems(q)` in palette.js when `q` starts with `>` — Theme…,
  New desk, Open folder…, Connect an agent, The first ten minutes, Keys. If
  menu.js's registry (CONTEXT-MENU.md phase 1) exposes a list, read it (that
  is phase 5); otherwise a static list and phase 5 stays open.
- `bench/ui.mjs` `connectRows` reads the sentence; `bench/onboarding.sh` reads
  install.sh's; `keyboardRows` presses `?` with the letters off and finds the
  help box.

### 3.2 `/start` — `ui/about.js`, `ui/app.js`, `src/server.rs`

- Prose first, in this file's next revision or a scratch doc: six sections,
  one paragraph and one key list each — a document arrives · the waiting
  queue and `n` · versions and compare · a desk and `⌃\`` · notes, points and
  asides · keys, `⌃B`, the palette. Section ids for the asides to link to.
- `start()` beside `connect()` in about.js (321), the same `.connect`
  typography; a `data-nav="start"` route in app.js next to `connect`'s; the
  server serves the page for `/start` as it does `/connect`.
- Links: the `?` box footer beside Connect; the Connect page's footer ("Once
  something arrives: the first ten minutes"); the palette row.
- **No screenshots** (your call, 2026-09-27): they would go into the binary
  (the page is `include_bytes!`, ~2–3 MB for six in two themes), show Paper
  to a reader on Sage, and be stale on the day the rail ships. The page shows
  the real thing instead, two ways.
- **Show me.** A `Show me` link at the end of a section's paragraph,
  `data-show="<target>"`, lights the real element in the window with the
  wash an arrival's row gets. It points; it never opens, navigates or
  changes anything. The resolver is in about.js and reaches the page through
  the `d` seam (`$`, `root`), so first paint gains only the class:
  `.t-doc.wash` (app.css:682) becomes a plain `.wash` on `@keyframes land`
  (908), with `outline: 2px solid var(--accent)` for 1 s in its place under
  `prefers-reduced-motion`. The element is scrolled into view (`block:
  "nearest"`) first.

  | Section | Target | When it is not there, the link reads |
  |---|---|---|
  | `#arrives` | the newest document's row in the tree; the tree icon when the sidebar is folded | "Nothing has arrived yet" + the Connect link |
  | `#waiting` | `#inbox-row`; the inbox icon and its badge when folded | "Nothing is waiting right now" |
  | `#versions` | none: versions live beside an open document, and `/start` is one | (sample only) |
  | `#desks` | the Desks heading and its `+`; the desk icon when folded | in a browser: "Desks live in the window: `snyvi app`" |
  | `#notes` | the aside card at the sidebar's foot | "No aside right now" |
  | `#keys` | the `?` button | always there |

- **Three live samples**, inert (`inert` attribute, `aria-hidden`), drawn with
  the page's own classes so they wear the reader's theme, accent and font:
  - *Versions*: a four-line `.diff` hunk (`.hunk`, two `.del`, two `.add`,
    app.css:1144-1146), which first paint already styles.
  - *Keys*: the pill, `Keys on · esc`. Its rules live in keys.js's `CSS`
    (19), so keys.js exports `sheet()`, which appends that `<style>` once and
    is what `mount()` (35) calls; `start()` imports keys.js and calls
    `sheet()`. The sample is a `<div class="keymode-sample show on">`, not
    `#keymode`, and sits in the flow instead of fixed at the bottom.
  - *Points*: one point row and its `Put it in panel 2` button. Its rules are
    desk.js's (2252, 2292-2294), and desk.js is 41 KB gzip that a browser
    without the window never loads, so the four rules are copied into about.js's
    `CSS`, scoped to `.start-sample`. That copy is the one place a sample can
    drift; the bench guards it (below).
- Cost: about.js grows ~1.5 KB gzip (the samples, the resolver, the copied
  rules); first paint grows by the `.wash` rename, a few bytes.
- `aboutRows` in the bench: `/start` renders six sections; each link lands.
- `startRows` in the bench, new:
  - each `Show me` whose target exists puts `.wash` on exactly that element,
    and with the sidebar folded on the rail icon instead;
  - each whose target is missing (fresh profile, no queue, no desk, no aside)
    shows its fallback line and lights nothing;
  - nothing in the page changes: the URL, `state.queue` and the focus are the
    same after a `Show me` as before;
  - drift guard: on a bench desk with a point, the sample's point row and the
    real one have the same computed `border-left`, `padding-left`, `color` of
    `.dk-put` and line clamp; the sample hunk's `.add`/`.del` backgrounds equal
    a real diff document's; the sample pill's border and background equal
    `#keymode`'s once ⌃B has drawn it.

### 3.2a The copy (draft, 2026-09-27, for you to edit)

Written for someone who has just installed snyvi and has one document in
front of them. Each section opens with the one thing worth knowing, then
what to do, then its keys. The keys are the ones the `?` box lists, plus the
1.7.1 ones this plan adds (`⌃⌥N`, `⌃⌥W`, `>` in the palette, `?` while the
letters sleep). `⌘` reads `ctrl` off a Mac, by the same `data-mod` the `?`
box uses. The five asides of §3.3 link to `#arrives`, `#waiting` (two
waiting), `#desks` (first desk, and a blocked panel) and `#versions`.

> **The first ten minutes**
>
> Six things, a paragraph each. Every key is in `?`.
>
> **A document arrives** `#arrives`
>
> When an agent writes something worth reading, it sends it here and
> replies with a link, and by the time you read the reply the document is
> already open. It is filed under its project, the folder the agent was
> working in, and under its workflow, one per Claude Code session. There is
> nothing to import or save: what arrives stays until you delete it, and a
> delete can be undone. *Show me*
>
> `⌘K` search everything · `j` `k` next / previous document · `/` find in
> this one
>
> **What is waiting** `#waiting`
>
> A document that arrives while you read never takes the page away. It
> waits, as a row under Waiting in the sidebar and a count in the bar above
> what you are reading (or a number on the inbox icon, when the sidebar is
> folded). `n` opens the oldest and takes it off, so the next `n` is the one
> after: one key, in the order they came. Opening one any other way counts
> as read too, and Mark all read clears the list without opening anything.
> *Show me*
>
> `n` the next one waiting · `i` the inbox · `Del` remove, `⌘Z` put it back
>
> **Versions** `#versions`
>
> A document is never changed. When an agent revises its plan it sends it
> again, and you keep both: the newest waits for you, the older ones are one
> key away. `c` shows what changed since the one before, in green and red,
> and `s` turns that between side by side and inline. Every version of the
> same file, from any session, is listed under Versions in the contents.
>
> [sample: a four-line hunk, one heading changed and a line added, in the
> reader's own green and red]
>
> `[` `]` older / newer · `c` compare · `s` side by side / inline · `t`
> contents
>
> **A desk** `#desks`
>
> A desk is one project's workbench: its folder, and up to four real
> terminal panels beside what you read, each running a shell or an agent.
> Make one with `+` beside Desks, or with the desk button on a folder to
> start it there. Everything the desk's agents send is listed on its rail,
> next to the panel that sent it. When an agent in a panel is waiting on
> you, for an answer or a permission, its row turns amber and Desks counts
> it. Restarting snyvi stops what runs in the panels; each comes back in its
> folder, and offers the conversation back with one click. *Show me*
>
> `` ⌃` `` desk / reading · `⌃⌥1`–`4` a panel · `⌃⌥N` new panel · `⌃⌥W` close
> it (with Undo) · `⌃⌥Z` that panel alone. Every other key goes to the
> panel.
>
> **Notes, points and asides** `#notes`
>
> Three small things, each going one way. *Notes* are yours: a list kept
> with each desk (`+ New note`), ticked off as things get done. An agent in
> that desk's panels can read it and tick a line, and nothing more.
> *Points* go from you to a panel: select a passage in a document you read
> over a desk and press `+ Point for panel 2`. They gather under the panel
> until `Put it in panel 2` types them into its input, quoted. Nothing is sent
> until you press Enter there.
>
> [sample: one point, "From PLAN.md: the cache is per project, not per
> desk", and under it `Put it in panel 2`]
>
> *Asides* come from an agent to you: a line about what it noticed, never a
> document and never counted as waiting. They sit at the foot of the
> sidebar. *Show me*
>
> Right-click anything for what it can do · `☰` or `⇧F10` the same menu from
> the keyboard
>
> **Keys** `#keys`
>
> The letter keys start asleep, so a `j` meant for a terminal cannot move the
> page. `⌃B` wakes them; a pill at the bottom says *Keys on*, and they sleep
> again on Esc, a click, or ten quiet seconds.
>
> [sample: the pill, `Keys on · esc`]
>
> Keys with a modifier always work. `⌘K` searches everything, and a search that starts with `>` lists
> what snyvi can do: a theme, a new desk, a folder, an agent to connect.
> *Show me* (the `?` button)
>
> `⌃B` letter keys · `⌘K` search · `⌘K` `>` commands · `?` every key · `\`
> sidebar · `Esc` back to where you were
>
> Nothing here yet? [Connect an agent](/connect).

Checks before this is final: the `+ Point for panel n` and `Put it in panel n`
labels are desk.js:1521 and 1558 as they are today; "Mark all read" is the
inbox's button; the Desks count is the `!n` at app.js:2646; the restart
sentence is true only once §2.9 lands, so it goes in with it or not at all.
*Show me* is the link §3.2's table describes; its fallback line replaces it
when there is nothing to point at. The `[sample: …]` lines are the three
live samples, placed where they are drawn.

### 3.3 Five asides from snyvi — `ui/app.js`

- A local source merged into `liveNotes()`: `{ id: "snyvi:first-doc", sender:
  "snyvi", text, href: "/start#…", at }`. `renderNote` draws it as it draws
  an agent's; the ✕ and Undo paths branch on the `snyvi:` prefix and never
  post to `/api/notes/…`.
- Triggers, each once: `doc` with `opens` (2943); `doc` while
  `state.waiting > 1`; `desks` count 0 → 1; `panes` with `blocked`; `doc`
  with `supersedes` (2947). Lines as the audit's table.
- Rules: not shown while an agent's note is unseen (it waits for the next
  trigger); at most one per 600 s, matching `QUIET_SECS` (aside.rs:20);
  seen-flags `snyvi.seen.<key>` and `snyvi.seen.at` in `localStorage` through
  `store` (app.js:104); Reset clears `snyvi.*`, check `resetRows` covers the
  new keys.
- `asideRows` in the bench: a first arrival on a fresh profile shows the
  first-doc line; a second arrival does not; an agent aside on screen holds
  it back.

### 3.4 install.sh's last line

- After the three `say` lines: if `snyvi app` can run (`DISPLAY` or
  `WAYLAND_DISPLAY` set, and the window binary is installed) and `/dev/tty`
  opens — `curl | sh` has no stdin to ask on, so the answer is read from
  `/dev/tty`, and no tty means no question — ask "Open the window now?
  [Y/n]" and run `"$snyvi" app` on yes. Mention `--claude-md` in the
  `init-claude` line above it.
- `bench/onboarding.sh` runs with no tty and must still end; it does.

Effort ~1.5 days: the prose, then half a day for Show me and the samples.

---

## 4. Docs, version, PR

- DESK.md §1 table (closed panes, name, full view, the live folder, `agent_open`), the Windows folder caveat, the keys table, the wire
  protocol (`restore`, `rename`, `layout.full`), §"what is not persisted".
- GUIDE.md: the rail, the four keys, `/start`.
- THEMES.md foot count; BRAINSTORM.md:35 if the budget moves; CONTEXT-MENU.md
  phase 5 ticked if the palette reads the registry.
- `Cargo.toml` 1.7.0 → 1.7.1 in this PR. `app_min` stays 1.7.0: nothing
  here touches the window binary, so an update to 1.7.1 swaps the daemon
  and leaves the window running (§4.1 checks exactly that).
- Commits, in order: make room (§1.0, budget to 52) · rail · one waiting row per file (§1.6) · panels
  close+compact · rename · full view, room, keys · desk ⋯ menu and help rows ·
  status line and context (§2.8) · folder and resume after a restart (§2.9) · housekeeping · one-liners · `/start` · Show me and the three samples ·
  asides · install.sh · docs · 1.7.1. One push when all of it is green
  locally (`cargo test`, `node bench/ui.mjs --check`, `node bench/bytes.mjs
  --check`).

Total ~6 days of code, half a day of docs and bench.

### 4.1 1.7.1 is the updater's first real run

Nothing in this PR changes the updater; the release is its test. Before
tagging v1.7.1, one machine runs 1.7.0 from the per-user install (`sh
install.sh --tar`: this machine has the .deb, which is told-only, and the
7777 daemon from `target/release` counts as a dev build and never updates),
with a desk open and Claude working in a panel.

After v1.7.1's release publishes:

- `latest.json` on the release names 1.7.1, carries `app_min` 1.7.0, and its
  minisign signature verifies against `packaging/minisign.pub`.
- `snyvi update check` on the 1.7.0 install finds 1.7.1 (the 24 h floor does
  not hold back a check asked for by hand).
- With the window in front, the pill offers it and nothing restarts; with
  the window in the background and the panels quiet, it applies on its own.
- After the swap: `snyvi status` and `/api/health` say 1.7.1 from the same
  path, `.prev` holds 1.7.0, and the window was not relaunched (`app_min`
  did not move).
- The panel that had Claude comes back as the conversation, in the folder
  its shell was in (§2.9 is what makes that true for a shell that `cd`'d).
- `snyvi update --back` returns to 1.7.0 and is recorded as skipped, not
  failed; then `snyvi update --to 1.7.1` puts it back.

Anything that fails here is a 1.7.2 fix to the updater, its own PR.

---

## 5. Decisions, and where this departs from the audit

Decided 2026-09-26: slots compact on close; a closed panel and its text stay
until `prune`; the scrollback warning is struck; the byte budget goes down to
52 KB and the rail pays for itself by moving first-paint code into chunks
(§1.0). Decided 2026-09-27: `snyvi statusline` prints nothing and only feeds
snyvi (§2.8); a restart brings a panel back in the folder its shell was in,
and offers the Claude conversation back with one click (§2.9); the waiting
list drops an older version of a file when a newer one arrives (§1.6); no
cost is shown anywhere, the status line's `cost` is not read (§2.8);
`/start` has no screenshots, and shows the real window through Show me and
three live samples (§3.2).

Departures from the audit:

1. **`panes_closed` table, not a `closed_at` column** — the `UNIQUE(desk_id,
   slot)` constraint (§2.1).
2. **Drop targets on empty cells: not built** — compaction plus the odd-panel
   span leave no empty cell.
3. **`room()` thresholds** shifted by the chrome's width, since they measure
   the grid now.
4. **The desk ⋯ menu lists Full view** rather than making ⤢ permanent; the
   hover tool stays quiet.
5. **install.sh asks on `/dev/tty`**, and stays silent when there is none.
6. **`name_panel` MCP tool** deferred, as the audit allowed.
7. **Two new chunks, `look.js` and `note.js`**, and the letter keys move into
   `keys.js`, so the rail is paid for and the budget falls (§1.0).

## 6. Questions for you

1. `/start` copy: drafted in §3.2a; edit it there before it is coded.
