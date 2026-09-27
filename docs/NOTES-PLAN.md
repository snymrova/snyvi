# Desk notes: implementation plans

Plans for the open notes on the snyvi desk, one section each. The context
menu (notes #10 and #18) has its own plan in `docs/CONTEXT-MENU.md`, and
several sections here link into it. Nothing here is built. Branch point:
`claude/desk-paint` @ 6619993 (1.5.0).

## Suggested order

1. **#17 remove and undo**, because #13 reuses its timed Undo.
2. **#15 document header ✕**
3. **#13 close the aside**
4. **#12 Open folder**
5. Desk notes #16, #11, #9, #14 (below)
6. Context menu (`CONTEXT-MENU.md`), which then collects the actions above
   into its registry.

## #17: the ✕ on an inbox document

> "When cross on inbox doc it should not say deleted and fade away quicky
> snappingly, undo should have a timer attached."

**Today**
- The ✕ is on the sidebar's document rows: Waiting (`queueRow`, `app.js:275`)
  and project rows (`docRow`, `app.js:240`). Both are
  `button.row-x[data-deldoc]` with the title "Delete". The main Inbox page
  rows have no ✕.
- It acts on the first click (`app.js:788-796`) and calls `deleteDoc`
  (1323-1336):
  - POST `/api/docs/:id/delete`, then refetch the tree;
  - then `offerUndo` shows a **toast "Deleted"** (1386), with Undo for 8 s
    (`UNDO_MS`, 1308) and ⌘Z.
- The toast lands in the **corner**. `liveAct()` anchors it to the button, but
  the refetch has already replaced the button. That breaks *undo where the
  click was*.
- The row exit is uneven:
  - Waiting rows play a 140 ms `leave` collapse (`app.css:665`).
  - Project rows just vanish when the refetch re-renders, after a network
    round-trip. That is the "snap".
- The daemon only soft-deletes: `deleted_at` is set on the lineage
  (`store.rs:564`), and `/undelete` works until someone runs `snyvi prune`.
  After the undo runs out, the UI has no way back, and that stays so
  (decided 2026-09-26: no removed list).
- A comment at `app.js:221-225` still says the document ✕ "asks twice". It
  doesn't.

**Target behaviour**
1. The click takes effect **at once**. The row's text fades in about 120 ms,
   and the row is **replaced in place** by a ghost of the same height:
   `report.md removed · Undo`. Nothing below it moves.
2. Along the ghost's bottom edge, a **thin accent bar drains over 4 s**. That
   is the timer. Hovering or focusing the ghost pauses it, and leaving resumes.
   When it runs out, the ghost collapses in 140 ms (the existing `leave`).
3. The word is **"removed"**, never "deleted". The button's title becomes
   "Remove from inbox · Undo for 4 s".
4. Undo restores the row in place with the existing 700 ms `wash`. ⌘Z still
   works.
5. **One ghost at a time**, the same as `putAway`: a second ✕ settles the
   first ghost straight away.

**Implementation**
- **State:** `removedJust = {id, d, where: "queue"|"proj", pid, wf, idx, at}`,
  captured **at click time** so it survives the refetch (the refetched data no
  longer has the document).
- **Draw:** `queueRow`, `docRow` and `renderQueue` draw the ghost at `where`.
  If the same id is in both Waiting and the project, the ghost goes only where
  the click was.
- **Timer (as built):** the CSS drain on the ghost's `::after` *is* the clock.
  Its `animationend` ends the offer, and `:hover`/`:focus-within` pause it, so
  the bar and the offer can't disagree. A redraw reads the bar's progress
  (`getAnimations`) and restarts it there with a negative delay (`--t`). A
  plain 4 s timer is used only with reduced motion, or when there is no row to
  stand in (then the offer goes in a "Removed" toast). `UNDO_MS` (8 s) stays
  for the other toasts that offer Undo.
- **Order of work:** draw the ghost first, from local state, then POST. If the
  POST fails, put the row back and say so in the row.
- **Toast:** stop calling `toast("Deleted", …)` for row clicks.
- **The meta button and Del:** they have no row. The meta button itself
  becomes the ghost ("Removed · Undo" with the same drain), and the page goes
  back to the previous screen, which is #15's behaviour.
- **SSE `deleted` handler (2736):** don't remove this page's own ghost, and do
  refresh the main Inbox page. Today it leaves the row there until the next
  load.
- **Clean-ups:** fix the stale comment at 221-225, and the ✕ title and
  aria-label.

**Tests** (in `bench/ui.mjs`, on a spare port):
- ✕ shows a ghost at the same height and y position;
- no toast appears;
- the drain runs out at 4 s and the row goes;
- Undo within 4 s brings the row back;
- hovering pauses the drain.

**Size:** medium. About 120 lines of JS/CSS, and no Rust.

## #15: every open document gets a header with a ✕ that goes back

> "Any document open in inbox should have header and then cross button which
> will open the previous screen, if no previous then main inbox."

**Today**
- `#chrome` (`index.html:57-67`, `app.css:255-287`) is a sticky 52 px bar
  above every document. Its `.over` part (the title and a ✕) shows **only when
  the document is read over a desk** (`overBar()`, `app.js:2538`), and there
  the ✕ goes back to the desk.
- `.over-t`, the title, is hidden until the page scrolls, so it doesn't repeat
  the `<h1>`.
- There is no record of where a document was opened from. Every open calls
  `showDoc(id, true)` and pushes history, and `j`/`k`, links and repeated
  clicks all push more `/d/` entries.
  - So `history.back()` often lands on *another document*, not the screen the
    reader came from.
- `history.length > 1` can't be trusted either. A `snyvi://` deep link loads a
  fresh page in the window, and in a tab the entry before might be another
  site.
- Esc on a document does nothing for navigation (`app.js:3403`).

**Target behaviour**
- Every document, whether opened from the Inbox, Waiting, a project, the
  palette, `n` or a link, shows the bar: its title (still fading in on scroll)
  and a ✕ at the right, before the window's buttons.
- ✕ goes back to **the screen the document was opened from**:
  - the Inbox page, a browsed folder, the agents page, or a desk (as today);
  - several documents read in a row, with `j`/`k` or links, count as *one*
    visit: ✕ goes back past all of them;
  - with no earlier screen (a deep link, a first load, or a new window), it
    goes to the main Inbox.
- The ✕ shows the hint **Esc** in its title. Esc does it too, but only when no
  other layer is open (the palette, find, help, the menu) and the focus isn't
  in a field or a panel.

**Implementation**
1. **Record where from.** Each `pushState` gets a `back` field:
   - leaving a non-document screen: `back = {view, …ids}` for that screen,
     e.g. `{view: "inbox"}`, `{view: "browse", root, path}`,
     `{view: "desk", id}`;
   - going from one document to another: `back = history.state.back`, which
     carries the original screen forward;
   - boot (`replaceState`, 3490-3500): `back = null`.
2. **`goBack()`**:
   - if `state.deskBehind` is set, use the existing desk path;
   - otherwise, if `history.state.back`, navigate there with `push=true` (not
     `history.back()`, which would walk through every document in between);
   - otherwise `showInbox(true)`.
3. **`overBar()`** shows `.over` whenever `state.view === "doc"`, not only over
   a desk. Call it once at boot. The ✕ handler (2543) calls `goBack()`. The ✕'s
   title reads "Back to Inbox", "Back to *folder*" or "Back to the panels ⌃`",
   so the reader knows where it leads.
4. **Compare view:** ✕ leaves the comparison first, the same as `c`.
5. **Browsed files** (`showBrowse`) get the same bar and ✕, which goes back to
   the folder's contents.
6. **Layout:** the bar stays `--head-h` tall, because the preview sizing at
   `app.css:788` depends on it. The ✕ stays clear of the window buttons'
   112 px (`frame.js:33`). On narrow widths, `#btn-side` and the ✕ must both
   fit, so check at 360 px.

**Tests:**
- Inbox → doc → `j` → `j` → ✕ lands on the Inbox;
- folder → file → ✕ lands on the folder;
- a deep link `/d/<id>` → ✕ lands on the Inbox;
- desk → rail doc → ✕ lands on the desk (no regression);
- Esc with the palette open closes the palette and nothing else.

**Size:** medium. About 80 lines of JS and 10 of CSS.

**Question:** should a *second* document opened from a link inside the first
also go back past both, to the Inbox? That is the plan above. The
alternative is for ✕ to go back to the first document.

## #12: "Open the folder"

**Confirmed:** open the folder in the system file manager (Files, Finder,
Explorer). snyvi can't do this anywhere today.

**Today**
- `platform::open_url` (`src/platform.rs:59-106`) runs `xdg-open`, `open` or
  `cmd /C start`. Given a directory, each of these opens the file manager.
- `terminal()` (`src/server.rs:2846-2902`) is exactly the right shape to copy:
  - it takes only ids snyvi already holds (`{root, path}` through
    `app.browse.resolve`, or `{doc}` through `doc_folder`) and never a raw path;
  - a file resolves to its parent folder;
  - it is guarded by `from_this_page || authorized` and checks `has_display()`.
- The desk's **Folder** row in its meta (`ui/desk.js:1103`) is a plain span
  and does nothing when clicked. A project's `p.root` has no folder action
  at all.

**Plan**
1. **Route.** Add `POST /api/reveal` next to `/api/terminal`
   (`server.rs:395`). It takes `{root, path}`, `{doc}`, `{desk}` or
   `{project}`, reuses `terminal()`'s resolving and guard, and calls
   `platform::open_url(dir)`. It returns 204, or 409 with "No display" when
   there is none.
   - Refactor the resolving out of `terminal()` into `fn folder_of(req) ->
     Result<PathBuf>` so the two routes can't drift apart.
2. **UI entry points.** Wherever *Open terminal here* appears, *Open folder*
   goes beside it:
   - the document meta (`app.js:2131-2141`);
   - the browse meta (`app.js:2151-2166`);
   - the folder context menu (`menu.js:91-100`).
   The wording is **"Open folder"**: short, and it reads as the user's own
   note.
3. **Desk Folder row.** Make its value a button that opens the desk's folder
   in the file manager, the same as everywhere else. Projects get it through
   the context menu (`p.root`).
4. **Context menu.** When the plan in `CONTEXT-MENU.md` lands, this becomes one
   more registry action (`folder.reveal`) and not three separate buttons.
5. **Tab vs window.** A browser tab calling from the same page is fine,
   because `terminal()` already allows it. The file manager opens on the
   daemon's display, which is also where the tab's user is.

**Tests**
- A Rust unit test for `folder_of`: a file resolves to its parent, an unknown
  root returns 404, and `..` is rejected.
- A UI test in `bench/ui.mjs`: the button is drawn in the doc and browse meta.
  The test stubs the route so it never opens a real file manager.

**Size:** small. About 40 lines of Rust and 15 of JS.

## #13: "Close the agent note"

**Confirmed:** the aside card at the foot of the sidebar, the line an agent
leaves with `send_aside` (it was `send_note` when the note was written),
can't be closed.

**Today**
- `<section id="note">` (`index.html:32`) and `renderNote()`
  (`app.js:1455-1488`) show the newest aside, with older ones in a trail that
  appears on hover.
- Resting on it marks it seen (`POST /api/notes/seen`), and a seen card shrinks
  to one grey line. A click opens its `about` document.
- **There is no ✕, no Esc and no timeout.** The daemon keeps 5 asides in
  memory (`src/aside.rs`, `KEEP = 5`) and has no remove operation. The card
  stays until the daemon restarts, taking height from the trees above it.

**Plan**
1. **Daemon.** In `Asides`, add `dismissed: bool` to each aside and
   `dismiss(id)` / `restore(id)`. `list()` keeps returning dismissed asides,
   flagged, so Undo has something to restore. Routes:
   `POST /api/notes/{id}/dismiss` and `/restore`. Each broadcasts the existing
   `"notes"` SSE event, so closing it in one window closes it in all of them.
   - Dismissing only flags the aside and never deletes it, per *snyvi never
     deletes*. The 5-item ring still evicts old ones as before.
2. **UI.**
   - Put a ✕ on `.note-now`. It shows on hover, like the other row tools, and
     stays visible while the card has focus.
   - Esc while the card has focus does the same.
   - After a close, the card shows the next undismissed aside from the trail.
     If there isn't one, the section hides.
3. **Undo where the click was.** The card turns into a one-line ghost:
   *"Aside closed · Undo"*. It uses the same ghost and timer as note #17, so
   build #17's timed undo first and reuse it here.
4. **Close all.** Only when the trail has more than one aside: the ✕ takes the
   current one, and the trail gets a quiet "Close all".
5. **No auto-fade.** Leave that out for now. A reader who looked away should
   still find the aside when they look back.

**Tests**
- Rust: dismiss and restore round-trip; a dismissed aside is still listed and
  flagged; a new aside after a dismiss shows.
- UI: ✕ hides the card and shows the next one; Undo brings it back; a second
  page receives the change over SSE.

**Size:** small. About 60 lines of Rust and 50 of JS/CSS.

## #16: a link in a panel should be clickable

**Today**
- Nothing in a panel can be clicked.
- The live screen is a canvas (`.pn-cv`, `pointer-events: none`). Over it is
  a transparent text layer (`.pn-scr`) that catches up once a second.
  Scrollback is DOM spans.
- A mouseup copies the selection, if there is one. A plain click does
  nothing, and programs get only wheel events.
- OSC 8 hyperlinks are swallowed by `osc_dispatch` (`src/screen.rs:1165`), so
  the text shows without its link. Claude Code prints plain URLs anyway, so
  **detecting URLs in the text** is what counts.
- The window already opens external links safely:
  - `window.open(url, "_blank")` reaches `on_new_window`
    (`src/bin/app.rs:267`), which calls `hand_to_desktop` (`xdg-open`);
  - documents use the same path (`app.js:2280`);
  - no daemon route is needed.

**Target behaviour**
- Hovering a URL with **Ctrl held** underlines it and shows a pointer.
  **Ctrl-click opens it** in the system browser. This is what GNOME Terminal
  and VS Code do, and it can't clash with starting a selection.
- **Ctrl-click only** (confirmed). A plain click never opens a link: it
  focuses the panel or starts a selection, as it does now. A drag, or a click
  that leaves a selection, never opens anything.
- Only `http:` and `https:` open. Terminal output is untrusted, so `file:`,
  `javascript:` and custom schemes are refused.

**Implementation**
1. **Finding the URL under the pointer.** `linkAt(v, e)` maps the event to a
   row and column:
   - for the live grid, it uses `LINE_PX` and `cellW` as `wheel()` does
     (`desk.js:618`), reads the row from `v.cells[y]` (never stale), and
     allows for wide cells;
   - for scrollback, it uses the clicked `.pn-sb` / `.pn-old` row's
     `textContent`.
   It runs a URL regex around that column and trims trailing `.,;:)]'"`, the
   usual terminal rule.
2. **Wrapped URLs.** When a URL runs to the last column, join it with the next
   row:
   - on the live grid when the URL reaches the right edge;
   - in scrollback using the `w` (soft-wrap) flag the daemon already sends and
     the page currently drops (`desk.js:177`).
   That covers `claude`'s long OAuth and PR links.
3. **Hover.** On `mousemove` with Ctrl held (and on `keydown` Control), put an
   absolutely positioned underline `div` over the URL's cells. It isn't drawn
   into the canvas, so the paint budget is untouched.
4. **Click.** In the mouseup handler, if the selection is collapsed, the
   pointer moved less than 4 px, and Ctrl is held, then `window.open(url, "_blank", "noopener")`. It runs *before*
   `copy()`, which stays a no-op on an empty selection.
5. **Later (optional): real OSC 8.**
   - a link table per `Screen` and a link id in `Attr`;
   - a fifth field in the wire runs;
   - `screen.rs` replica tests.
   Only worth doing if a program you use emits OSC 8.

**Tests**
- A unit test of `linkAt` against fixture rows: a trailing period, a URL in
  brackets, wide characters before it, and a URL wrapped across two rows.
- `bench/desk-window.sh`: echo a URL in a panel, Ctrl-click it, and assert
  `on_new_window` was hit (stub `hand_to_desktop` with an env flag).
- The desk-paint bench stays under 15%.

**Size:** small to medium. About 120 lines of JS, and no Rust unless OSC 8 is
added.

## #11: change the order of the panes

**Today**
- A pane's place is its `slot`, 1–4, with `UNIQUE(desk_id, slot)`
  (`src/desk.rs:63,68`). A new pane takes the lowest free slot.
- `layout()` (`desk.js:848`) places the panes in slot order: 1 at top left,
  2 at top right, 3 at bottom left (spanning the row if it is the last), and
  4 at bottom right.
- **There is no way to reorder:** no drag, no key, no route.
- The slot is also an **identity**:
  - documents store `desk_slot`, not the pane id (`receive.rs:111`), for
    "From desk [n] ▸", the rail's `[n]` badges and "+ Point for panel N";
  - ⌃⌥1-4 focuses by slot;
  - `SNYVI_SLOT` is set in the child's environment (nothing reads it).

**Decision: swapping moves the slot numbers.** Pane *n* is always the one in
position *n*, which matches ⌃⌥*n*. The documents' `desk_slot` is rewritten
**in the same transaction**, so "From desk [2]" still points at the panel
that sent it.

**Implementation**
1. **`desk.rs`:**
   - `swap(conn, desk, a_slot, b_slot)` in one transaction, going through a
     temporary slot (`-1`), because `UNIQUE` is checked row by row;
   - `UPDATE docs SET desk_slot = CASE desk_slot WHEN a THEN b WHEN b THEN a
     END WHERE desk_id = ? AND desk_slot IN (a, b)`;
   - moving a pane to an *empty* slot is the same call with one side empty.
2. **Route:** `POST /api/desks/{id}/swap {a, b}` behind `refuse_desk`, then
   `desks_moved(&app)` so every window redraws. Add it to the route-list test.
3. **Drag a panel's head** onto another panel to swap them:
   - pointer events, the same pattern as the dividers (`desk.js:940-973`), not
     HTML5 drag and drop, which Tauri's drop handler intercepts;
   - while dragging, the target panel shows an accent outline and the
     dragged panel is a translucent ghost.
   `layout()` already only re-parents when the order changes, and a moved
   canvas keeps its bitmap, so nothing repaints from scratch.
4. **Keys:** **⌃⌥⇧←/→/↑/↓** swap the focused panel with its neighbour in that
   direction, and focus follows the panel.
5. **Context menu:** a "Move to position n" item on panels (`CONTEXT-MENU.md`,
   phase 3).
6. **Rewrite `SNYVI_SLOT`?** No. A running process's environment can't change;
   note it in `DESK.md`.

**Tests**
- Rust: swap two panes, and check a document's `desk_slot` follows its pane;
  swap into an empty slot; a swap across desks is refused; the `UNIQUE`
  constraint holds throughout.
- UI: dragging head 1 onto head 3 swaps their grid positions; ⌃⌥⇧→ from
  position 1 swaps with 2; the "From desk [n]" link lands on the panel that
  sent the document.

**Size:** medium. About 70 lines of Rust and 90 of JS.

## #9: a zoom function, for a panel in full view

> Answer: zoom is for a pane, to make it full view.

**Today**
- **⌃⌥Z** already "zooms" (`zoom()`, `desk.js:1545`): the focused panel fills
  the **grid**, and the others become `[n]` tabs. The desk's width button
  (`w`, `app.js:3120`) does the same.
- But:
  - **nothing on a panel shows it exists**: no button on the head, and no
    double-click;
  - it fills only the grid, so the **sidebar, the rail and the desk header
    stay**, which on a laptop screen leaves the panel far from full;
  - it's forgotten when you switch desks (`desk.js:1594`), and the only sign
    of it is a ⤢ on the active tab.
- The sidebar and rail can each be folded (`fold("side")`, `fold("rail")`,
  `app.js:3309`), but that's a saved preference, not a mode.

**Target behaviour**
- Each panel's head gets a **⤢ button**, shown on hover and always while the
  panel is focused. **Double-clicking the head** does the same.
- **Full view** means the panel fills **the whole window**:
  - the sidebar, rail and desk header slide away (150 ms, off with
    `prefers-reduced-motion`);
  - a slim bar stays at the top with the panel's head (`[2] claude · main* ·
    ● working`), the `[n]` tabs for the other panels, and a **⤡** to come back;
  - the window's own buttons keep their 112 px (`frame.js`).
- **Other panels:** clicking a tab or pressing ⌃⌥*n* shows that panel in full
  view instead, as the zoom already does.
- **Coming back:** ⤡, double-clicking the head again, or ⌃⌥Z. **Not Esc**,
  because Esc belongs to the program running in the panel.
- **Remembered per desk:** leaving and returning to a desk keeps it in full
  view, until the window reloads.
- **Keys:** ⌃⌥Z does full view. The grid-only zoom goes away; two zoom levels
  is one too many to remember. The width button on a desk becomes the same
  toggle.
- **A blocked panel.** When a *hidden* panel needs you, its tab turns amber
  with `!`, the same mark the rail uses, so full view never hides a panel
  that is waiting.

**Implementation**
1. `desk.js`:
   - rename the state `zoomed` → `full`, kept in a `Map(deskId → paneId)` so
     it survives a desk switch;
   - `layout()` already handles the one-panel case (`n = zoomed ? 1 : room()`);
   - toggling adds `data-full` to the root element.
2. **CSS** (in `desk.js`'s own stylesheet):
   - `:root[data-full] #side, :root[data-full] #rail, :root[data-full] .dk-head`
     collapse, with `grid-template-columns` animated;
   - the fold preferences aren't touched, so coming back restores exactly
     what was there.
3. **Head button and double-click:**
   - in the pane markup (`desk.js:634`) and `header()`;
   - double-click on `.pn-head` only, because a double-click in the body
     selects a word.
4. **Resize:** `fit()` runs from the existing `ResizeObserver`, so the program
   gets one resize when full view starts and one when it ends. The canvas
   keeps its bitmap and repaints only what the resize changes.
5. **Rail:** while hidden, a blocked panel's state goes to its tab (`tabs()`,
   `desk.js:877`).
6. **Context menu:** "Full view" / "Back to the grid" on panels
   (`CONTEXT-MENU.md`, phase 3).
7. **Docs:** `DESK.md:311` and the GUIDE keys table.

**Tests**
- Clicking ⤢ hides the sidebar and rail, and the panel's `clientWidth` is
  about the window's width;
- the program sees a resize (check `stty size` in the panel);
- a tab switches panels while staying in full view;
- ⤡ restores the exact fold state;
- leaving the desk and returning keeps full view;
- a blocked hidden panel shows `!` on its tab.
- Paint: `bench/webkit.py --desk` with one panel in full view stays under
  15%. One large canvas should cost less than four small ones, so measure it.

**Size:** small to medium. About 90 lines of JS/CSS.

**Also, separately:** the terminal *text size* (⌃= ⌃- ⌃0 in a panel) stays as
it is. If full view makes you want bigger text, adding 17 and 19 px steps is
a one-line change (`desk.js:22`).

## #14: no limit on panels overall, 4 per desk

> Answer: every desk has at most 4 panels, and there's no limit on the total.
> Today the total is capped at 8, however many desks there are.

**Today**
- The limits are constants in `src/desk.rs`: `PER_DESK = 4` (stays) and
  `EVERYWHERE = 8` (goes).
  - The check is in `open_pane`'s transaction: the total count first
    (`desk.rs:308-310`, giving `NoRoomLeft`), then a free slot 1–4 (`:316`,
    giving `DeskFull`).
  - The server answers 409 with `"full": "everywhere"` or `"desk"`
    (`server.rs:2522-2531`).
- **Why there were 8:** a memory budget, in `desk.rs:18-23` and
  `BRAINSTORM.md:39`. 8 × 2 MB of scrollback is a 16 MB ceiling, within the
  daemon's 40 MB resident target. Removing the total limit removes that
  ceiling, so the cost has to be handled another way (below).
- **A hidden width limit** in the UI only. `room()` (`desk.js:835`) allows 4
  panels above 1100 px of width, 2 above 700 px, and 1 below that, and
  `noNew()` **refuses** a new panel past that number. A narrow window can't
  add a third panel to a desk, even though the desk allows 4. Panels that
  don't fit already become `[n]` tabs, so the refusal isn't needed.
- **What a panel costs while nobody looks at it:**
  - a 16 ms frame-diff task runs even with no watcher (`pane.rs:686-730`);
  - up to 2 MB of scrollback, saved to disk every 15 s;
  - git status every 3 s for each distinct folder.
  Painting costs only for the open desk.

**Target behaviour**
- Open as many desks as you like, each with up to 4 panels. There's no total.
- A narrow window can still add up to 4 panels to a desk, and the extra ones
  show as tabs.
- The rail says `Panels 3/4`, and "of 8 everywhere" is gone.

**Implementation**
1. **First, make panels nobody is watching cheap.**
   - The `frames` task in `pane.rs` sleeps while the pane has no watchers, and
     wakes on subscribe with one full frame.
   - Output still reaches the `Screen`; only the 16 ms diff and broadcast stop.
   - Measure with `snyvi bench`: idle CPU with 12 running panels on 3 desks,
     none watched, should be about 0.
2. **Memory, with a warning and no limit.**
   - Scrollback stays at 2 MB per panel.
   - When the total scrollback held passes about 64 MB, the Desks section says
     so once ("Panels are holding 70 MB of scrollback"). It never refuses.
   - The resident row in the bench gets a panel count, so growth shows up
     there (see the `malloc_trim` note).
3. **`desk.rs`:**
   - delete `EVERYWHERE`, the count check at `:308-310`, and
     `Opened::NoRoomLeft`;
   - `PER_DESK = 4` and `DeskFull` stay as they are.
4. **`server.rs`:**
   - drop the `"everywhere"` 409 arm and the `cap` field in `GET /api/desks`
     (`:2213`);
   - the watch socket's `.take(EVERYWHERE)` (`:2027`) becomes
     `.take(PER_DESK)`, since a socket watches one desk at a time. Check this
     while building.
5. **UI (`desk.js`):**
   - `noNew()` refuses only at 4 on this desk, with no width check. `room()`
     still decides how many panels *show* at once;
   - the rail label and tooltip (`:1029`, `:1058`) lose "of 8 everywhere";
   - the `4/4` badge beside + stays.
6. **Words:** remove "eight panels" and "of 8 everywhere" from `DESK.md:52-61`,
   `BRAINSTORM.md:39-45` (keep the budget reasoning, updated) and the ROADMAP
   row at line 104. The "four panels" wording in the README and GUIDE stays,
   because it is still true.

**Tests**
- Rust: replace `eight_panes_is_the_whole_of_it_however_many_desks_there_are`
  (`desk.rs:866`) with "twelve panels across three desks all open". Keep
  `panes_fill_the_lowest_free_slot_and_the_fifth_is_refused`.
- Rust (`pane.rs`): a pane with no watcher produces no frames, and one frame
  arrives on subscribe.
- Bench: idle CPU and resident memory with 12 panels.
- UI: at 600 px wide, a desk can go from 2 to 3 panels, and the third shows as
  a tab.

**Size:** medium. About 60 lines of Rust (most of it the frame sleep), 20 of
JS, and the docs.

## Still open

1. **#15:** when document B is opened from a link in document A, should ✕ on
   B go back to A, or to the screen A came from? The plan says the latter.
2. **#9:** can full view replace the grid-only zoom as the one meaning of
   ⌃⌥Z? The plan says yes.

Answered on 2026-09-26:
- **#13:** it is the aside card; build it as planned.
- **#16:** Ctrl-click only, no plain-click opening.
- **#17:** Undo lasts 4 s, and there is no removed list.
- **#12:** open in the file manager.
- **#9:** zoom means a panel in full view.
- **#14:** at most 4 panels per desk, and no limit overall.
