# The window's parts, by name

One name per part of the window, so "the by-line in `rail.docs.row` is too
loud" is a place on the screen and a line in the code at once.

**To see them:** the palette (`Ctrl K`), then `> Show section names`. Every
named part is outlined, with its name at its top right, until the same
command hides them again.

**In the code:** a part wears its name as `data-part="…"`. Grep for it; style
by class as before. The names are stable, and a class may change under them.
The rows inside a part are named here but not tagged: a list of forty rows
each wearing a label would be noise.

## The window

| Name | What it is | Where |
|---|---|---|
| `side` | the sidebar, left | `#side` · `ui/index.html` |
| `side.head` | the mark, live dot, update, search, hide | `.side-head` |
| `side.tree` | Inbox, desks, projects, folders | `#trees` · `renderTree()` in `app.js` |
| `side.foot` | theme, accent, font, width, wrap, keys, game | `.side-foot` |
| `main` | the page | `#main` |
| `main.head` | the page's bar: back, title, its tools | `#chrome` |
| `main.page` | what the page shows: a document, Home, a desk's panels | `#doc` |
| `rail` | the right-hand column | `#rail` |
| `rail.list` | the rail's scrolling part: a document's contents, or a desk's lists | `#toc` |
| `rail.foot` | the rail's foot, under a rule: a document's facts and actions, or the focused panel's line | `#meta` · `meta()` in `desk.js` |

## The rail on a desk

`rail.list` holds these, one under the other, 16 px apart (`.dk-rail > * + *`).

| Name | What it is | Where |
|---|---|---|
| `rail.panels` | Panels: a row each, then `+ New panel` / `Start all` | `rail()` · `paneRow` |
| `rail.points` | Points kept from documents, per panel (only while there are some) | `pointSec()` |
| `rail.docs` | Documents the desk's panels sent, newest first | `rail()` · `docRow()` |
| `rail.docs.row` | one document: icon, `.title` (one line; two on the open one), `.by` (panel · age), `.dk-tools` (copy path, back, ✕) | `.dk-doc` |
| `rail.docs.more` | "N more" past thirty | `.dk-more` |
| `rail.docs.removed` | "N removed · Show", and the list it opens with an Undo each | `.dk-offs-line`, `.dk-offs` |
| `rail.notes` | Notes: the reader's own list for the desk | `noteSec()` |
| `rail.notes.head` | "Notes · N open", and beside it Remove done notes and `+` | `summary` + `.dk-sec-acts` |
| `rail.notes.row` | one line: circle, text, ✕, who ticked it (`.dk-by`), its pictures (`.dk-imgs`) | `noteRow()` · `.dk-note` |
| `rail.notes.field` | the new line's field, at the end of the list, and its waiting pictures (`.dk-pend`) | `.dk-note.new` |
| `rail.notes.picture` | a picture whole, over the page | `openLightbox()` · `.dk-lb` |

The Documents list is a box of its own height (`min(360px, 45vh)`) and
scrolls inside the rail, so a long day of sends never pushes Notes out of
reach.

## A studio desk

`main.page` on a studio desk is its viewer over its one panel, and its rail
opens on its Claude and its Assets.

| Name | What it is | Where |
|---|---|---|
| `studio` | the viewer, between the desk's head and its panel | `.st-host` · `studioFrame()` in `desk.js` |
| `studio.viewer` | the open folder's pictures, videos and sounds as a grid; one of them large in the same space, with its thin bar (★ Keep, Tell Claude…, Info) | `drawGallery()` · `04-gallery.js`, `openView()` · `05-view.js` |
| `studio.agent` | the one panel, docked under the line that is dragged (`.st-div`) | `.dk-grid` |
| `rail.claude` | in place of `rail.panels`: one row for Claude (what it is doing, stop, start), and what it all cost | `studioTop()` · `desk/06-rail.js`, `railRows()` · `studio/03-rail.js` |
| `rail.assets` | Assets: the studio folder's folders, three deep, titled and ordered by their `folder.json`; a click opens one in the viewer | `railRows()` · `studio/03-rail.js` |

`rail.docs`, `rail.notes` and `rail.points` are a desk's, as on any desk.

## Home

| Name | What it is | Where |
|---|---|---|
| `home.head` | "Home" and the date | `.hm-head` · `draw()` in `home.js` |
| `home.status` | the one line: what needs you, what is waiting, Claude, the window | `status()` |
| `home.pick` | Pick up: the desk to go back to, where it was left, its open notes, git, panels, Open desk | `pick()` |
| `home.desks` | Desks: every other desk, where it was left, its first open notes, `+ New note` | `desksList()` |
| `home.desks.desk` | one desk in it | `.hm-dk` |
| `home.notes` | a desk's open notes on Home, each tickable where it stands (in `home.pick` and `home.desks.desk`) | `notesOf()` · `.hm-next` |
| `home.week` | This week, folded: the log by day and desk, and Send this week as a doc | `week()` · `yourDays()` |
| `home.projects` | Projects: eight weeks a desk, Park it?, the shelf | `projects()` |
| `home.claude` | Claude: what is left of the windows, what the panels are doing | `claude()` |
| `home.snyvi` | snyvi: the version and updates | `draw()` |

A hidden widget is `home.<name>` too; the foot says "N widgets hidden · Show".
