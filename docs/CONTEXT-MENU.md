# Context menus, from the ground up

Desk notes #10 and #18 ("rethink context menu"). Status: plan, nothing built.
Branch point: `claude/desk-paint` @ 6619993 (1.5.0).

## Where it stands

snyvi has **one** context menu. It opens on a folder row under Folders
(`ui/app.js:2569` listens, `ui/menu.js:open` draws) and offers:

- New desk here
- Show desk *name*, once for each desk already on that folder
- Copy path
- Open terminal here

Every other surface does its actions in one of two ways: small tools on the
row that show on hover, or the action list in the meta pane under the rail.
A right-click anywhere else falls through to whatever WebKit or the browser
does, and that has not been checked yet (phase 0).

What each object can do today, and where that action lives:

| Object | Hover tools on the row | Elsewhere |
|---|---|---|
| Folder (root) | desk glyph (new desk), ✕ close | context menu; meta: Copy path, Open terminal, Close folder |
| Folder (subdir) | desk glyph | context menu |
| File under a folder | none | meta: Preview, Open source, Copy path, Open terminal, Folder contents |
| Project | ✎ rename, ✕ remove from sidebar | none |
| Document row (tree, queue, inbox) | ✕ delete | meta: Compare, Pin, Split, Preview, Delete, Open source, Copy path, Open terminal |
| Desk row | ✎ rename, ✕ close (two clicks) | palette: Desk · name |
| Desk (in its rail) | ✎ rename, ✕ close (two clicks) | + New panel, Start all |
| Panel row (rail) | stop/start, resume, ✕ close (two clicks) | panel head: click to focus |
| Panel body (terminal) | none | keys: ⌃⇧C, ⌃⇧V, ⌃= ⌃- ⌃0; copies whatever is selected |
| Rail document | copy path, back to panels | none |
| Desk note | tick, edit, ✕ take off the list | none |
| Point | let go, type into panel | none |
| Document body: link, selection, code line | none | none |

So what an object can do is spread across three or four places, and which
places depends on the object. The rethink gives each kind of object **one
list of what it can do**, and every place a reader might look for an action
reads from that list.

## Principles

These come from rules already in the codebase and in earlier decisions:

1. **Nothing in snyvi deletes.** A ✕ removes the thing from view and it can be
   brought back. The menu names actions that way too: *Remove from inbox*,
   not *Delete*. This matches note #17.
2. **Undo shows up where the click was.** When a menu action removes a row,
   the row itself turns into the ghost that holds Undo. It never goes to a
   toast in the corner.
3. **Anything a right-click can do, a keyboard can do.** Every menu can be
   opened with the ContextMenu key and ⇧F10, and from key mode. The palette
   can do the same actions.
4. **The menu is a chunk.** `menu.js` loads on the first right-click. First
   paint pays for one listener and one selector string and nothing more, so
   check it with `bench/bytes.mjs`.
5. **Hide what the reader can't use; don't grey it out.** A browser tab has
   no capability, so its menus leave out desk and terminal actions entirely,
   as the folder menu already does.
6. **Undoable actions go straight through. Actions that end a process ask
   twice.** Close desk and Close panel arm inside the menu ("Close? · click
   again"), the same way `sure()` works in `desk.js`.
7. **One ordering everywhere.** Open or show comes first, then change it, then
   copy or reveal, then remove or close last in the danger colour, with a rule
   above it.

## Design

### One listener, many targets

`app.js` replaces the listener on `treesEl` with **one** `contextmenu`
listener on `document`. It needs just enough to decide synchronously whether
to call `preventDefault()`:

```js
const MENU_AT = ".b-root > summary, .b-dir > details > summary, .b-file a, " +
  ".t-proj > summary, a[data-id], .t-desk a, .dk-pane, .pn-head, .pn-body, " +
  ".dk-doc, .dk-note, .dk-point, #doc a[href], #doc pre";
document.addEventListener("contextmenu", e => {
  if (e.target.closest("input, textarea, [contenteditable]")) return; // native menu keeps paste and spelling
  const at = e.target.closest(MENU_AT);
  if (!at) { if (capability) e.preventDefault(); return; }             // the window never shows WebKit's Back/Reload
  e.preventDefault();
  act("open", at, { x: e.clientX, y: e.clientY });
});
```

After that, everything happens in the chunk.

### Targets

`menu.js` turns an element into a **target**, a small plain object built from
data attributes the rows already carry:

| kind | from | carries |
|---|---|---|
| `folder` | `.b-root`, `.b-dir` | `folderOf(el)` (already exists) |
| `file` | `.b-file a[data-browse]` | root, path |
| `project` | `.t-proj[data-pid]` | project id, root |
| `doc` | `a[data-id]`, `.dk-doc a[data-read]` | doc id, and where the row sits (tree, queue, inbox, rail) |
| `desk` | `a[data-desk]` | desk id |
| `panel` | `.dk-pane [data-focus]`, `.pn-head`, `.pn-body` | pane id, and whether it came from the body |
| `note` | `.dk-note [data-n]` | note id |
| `point` | `.dk-point [data-p][data-n]` | pane, point |
| `link` | `#doc a[href]` | href |
| `code` | `#doc pre` (line under the pointer) | doc id, line |

### Actions: one registry, three consumers

An action is a plain record:

```js
{ id: "doc.pin", kind: "doc", group: "change",
  label: t => t.doc.pinned ? "Unpin" : "Pin", key: "p",
  when: (t, ctx) => true,            // hidden when false; never greyed
  run: (t, ctx) => ctx.pin(t.doc.id),
  danger: false, sure: false }       // sure: arm in place, click again
```

Three things read from the registry:

1. **The context menu.** Every action whose `when` passes, in group order.
2. **The palette.** Typing `>` (or the object's name) lists the actions for
   *the object on the page*: the open document, the focused panel, or the desk.
   This is how the keyboard gets the whole menu without a new mode to learn.
3. **The meta pane's action list.** Longer term it can draw from the same
   records, so an action added once shows up in both places. That is phase 5;
   it isn't needed for the menu to ship.

The `run` functions stay with the code that owns the state:

- `menu.js` keeps its folder and desk code (`pick`, `make`, `drop`) and gets
  the engine.
- Document actions reach `app.js` through `actsCtx`, which grows
  `pin`, `remove`, `compare`, `copy`, `source`, `rename`, `away`, `markRead`.
- Panel, desk-rail, note and point actions belong to `desk.js`, which owns that
  state. It exports `actions(target)` and the engine asks it, but only when the
  desk module is already loaded. A panel can't exist otherwise, so the engine
  never fetches the desk chunk just to draw a menu.

### What each menu says

Lines in *italics* are new actions that don't exist anywhere today.
Everything else already exists somewhere and moves here.

**Folder**: New desk here · Show desk *name*… · ─ · Open terminal here ·
*Open in file manager* · Copy path · ─ · Close folder *(root only)*

**File**: Open · Preview/Source *(when previewable)* · Open source · ─ ·
Open terminal here · *Open in file manager* · Copy path

**Project**: *Mark all read* · New desk here *(p.root)* · Open terminal here ·
Copy path · ─ · Rename… · Remove from sidebar

**Document** (sidebar, queue, inbox, rail): Open · Compare with previous
*(when there is one)* · Pin/Unpin · *Mark unread* · ─ · Open source · Copy
path · Open terminal here · *Show in desk* *(when sent from a panel)* · ─ ·
Remove from inbox

**Desk row**: Show · New panel · Start all *(when >1 stopped)* · ─ · Open
terminal here · Copy path · ─ · Rename… · Close desk *(armed)*

**Panel** (rail row or head): Focus · Stop/Start · Resume conversation · ─ ·
Copy path of its folder · ─ · Close panel *(armed)*

**Panel body** (inside the terminal): Copy *(when text is selected)* · Paste ·
─ · Text size + · Text size − · Reset size · ─ · then the panel's own actions,
as above. A pane only ever sends programs its wheel events, never clicks
(`desk.js:596`), so a right-click there is free for the menu. ⇧+right-click
stays reserved in case mouse reporting ever grows to include clicks.

**Desk note**: Edit · Tick/Untick · ─ · Take off the list

**Point**: Type into panel · ─ · Let go

**Link in a document**: Open · Copy link · *Open in browser*
*(window only; this ties into note #16 "links in panel should be clickable")*

**Code line**: *Copy link to line* (`/d/<id>#L<n>`) · Copy line

### Keyboard

- The **ContextMenu key** or **⇧F10** opens the menu for the focused element,
  at its rect. That covers rows, panels and links.
- In key mode (⌃B), **`m`** opens it for the row the selection is on.
- Inside the menu: ↑↓, Home/End, the first letter to jump, Enter to act, Esc
  to close and **return focus to the element it came from**. Today `close()`
  drops focus on `body`.
- Global Esc already calls `shut`, and that stays.

### How it looks

- It keeps `#ctx` and grows three things:
  - a muted **head line** naming the target (*"report.md"*, *"Panel 2 ·
    claude"*), so a right-click in a busy grid says what it acts on;
  - **key hints** right-aligned in `kbd`, the same as the meta pane's buttons;
  - **danger** items in `--danger` below their own rule.
- No icons. The meta pane's actions have none either, so the menu matches it.
- It never overflows the screen: it opens above the pointer when there is no
  room below, and scrolls if taller than the window (the doc menu has about 10
  rows, so this is only a safety net).
- It opens in 80 ms and closes in 60 ms with a fade and a 4 px scale, and
  `prefers-reduced-motion` turns both off.
- Themes: only tokens are used, so all eight themes get it without extra work.
  Check it in one light theme and one dark theme.

### Hover tools after this

Rows are crowded: a project row holds ✎ and ✕, a folder row holds the desk
glyph and ✕. Once everything is in the menu, the proposal is:

- keep **✕** on every row, because it is the most-used action and it is where
  Undo lands;
- keep the **desk glyph** on folders, because it is the one-click way to make a
  desk and appears in the Desks empty state;
- move **✎ rename** into the menu, with **F2** on a focused row as the
  keyboard way in.

This is a choice for you (see Questions).

## Phases

Each phase is a commit that stands on its own. The version bump goes in the
work PR, following the 1.4.0 and 1.5.0 pattern.

### 0. Look before changing (no code)

- In the test window on a spare port (7831, never 7777), right-click each row
  in the table above and write down what happens: WebKit's menu, nothing, or
  something else. Do the same in a browser tab.
- Record the first-paint bytes with `bench/bytes.mjs` so phase 1 can be held
  to them.

### 1. Engine: nothing changes for the reader

- `menu.js`: split `open` into the engine (draw, place, keys, focus return,
  arming) and a `folder` entry in the registry. The folder menu should draw
  exactly as it does now, plus **Close folder** and the head line.
- `app.js`: the document-level listener above replaces `treesEl`'s. ContextMenu
  key and ⇧F10 are handled in the same place.
- `app.css`: `#ctx .head`, `#ctx kbd`, `#ctx .danger`, placement and motion.
- Test (`bench/ui.mjs`): right-click on a folder opens 4+ items; Esc returns
  focus to the summary; ⇧F10 on a focused row opens the same menu; a click
  outside closes it; WebKit's menu never shows in the window.

### 2. Sidebar objects

- Document (tree, queue, inbox list), project, file under a folder, desk row.
- `actsCtx` gets the document functions. Removing a row goes through the
  same code the ✕ already uses, so the ghost row and Undo come for free.
  Note #17 changes that code, and the menu inherits the change.
- New actions: **Mark unread**, **Mark all read** on a project, and **Open in
  file manager**. The daemon only has `POST /api/docs/:id/read` and the
  queue's clear-all today. Mark unread needs `POST /api/docs/:id/unread`, and
  the per-project version needs a project scope on the clear route. Both are
  small changes in `server.rs` and `store.rs`, and either can be cut if you
  would rather keep the first PR UI-only.
- **Open in file manager** is note #12 (confirmed). It uses the one route
  `POST /api/reveal` from `NOTES-PLAN.md` #12, which is shaped like
  `/api/terminal` and calls `platform::open_url` on the folder.
- Tests: each kind opens its menu; Remove from inbox leaves a ghost row with
  Undo; a tab never shows desk or terminal items.

### 3. Desk surfaces

- `desk.js` exports `actions(target)` for panel, rail doc, note and point, and
  reuses its own `run` paths (the `data-a` switch). Close panel and Close desk
  arm in the menu.
- Panel body: Copy uses the existing `copy(v, true)`; Paste reads through
  `navigator.clipboard.readText()`, with ⌃⇧V as the fallback when WebKit
  refuses. Text size uses the existing `textSize()`. Add a **Full view** item
  too (note #9, `NOTES-PLAN.md`).
- Watch the desk-paint budget: opening a menu over the grid must not
  invalidate the canvas. Measure with `bench/webkit.py --desk` under Xvfb; the
  target is still under 15%.
- Tests: right-click a pane body with a selection and Copy lands on the
  clipboard; Close panel needs two clicks; the menu closes when the desk is
  swapped away (⌃`).

### 4. Document body

- Links: Open, Copy link, Open in browser. Code lines: Copy link to line, Copy
  line, using the `#L` anchors the page already understands.
- Selected text in a document is left alone: with a selection inside `#doc`,
  the listener does nothing, so the native Copy stays.

### 5. Palette and meta pane read from the registry

- A `>` query in the palette lists the actions for the object on the page.
- Optional: the meta pane draws its `.actions` from the same records, so there
  is one list and not two copies of it.

### 6. Docs

- `docs/GUIDE.md`: a short "Right-click, or ⇧F10" section listing the menus.
- `docs/ROADMAP.md`: one row. `DESK.md` line 50 already mentions the folder
  menu; add the panel menu there.

## Risks

- **WebKitGTK and the clipboard.** `navigator.clipboard.readText()` may be
  refused without a user gesture, or blocked outright in the window. Phase 3
  checks this first; if it fails, the Paste item says "⌃⇧V to paste" and does
  nothing, rather than failing without a word.
- **Rows that redraw under the menu.** The desk list and the tree redraw on
  events (see the tree-render race note). The menu holds a *target* object,
  not an element, so a row redrawn while the menu is open still gets the
  action. When the target is gone (a desk closed elsewhere), the action says so
  in a toast.
- **The other session in this checkout.** `app.js` and `desk.js` are edited
  there too. Stage by hunk, and use spare bench ports.
- **Bytes.** The registry for documents and desks lives in the chunk, not in
  `app.js`. Only the selector string and the listener are added to first paint.

## Questions for you

1. **Hover tools.** Should ✎ rename move into the menu (and F2), keeping ✕
   and the desk glyph on the row? Or should every hover tool stay as it is?
2. **The native menu.** In the window, suppress WebKit's Back/Forward/Reload
   menu everywhere except text fields? (Recommended.)
3. ~~Note #12~~: confirmed as *Open in file manager*, and it lands in phase 2.
   See `NOTES-PLAN.md` #12 for the route.
4. **Scope of the first PR.** Phases 1–3 as one PR (the menus people will
   actually use), with 4–5 after? Or all of it at once?
