---
name: snyvi
description: How to work in snyvi, where the user builds, releases and grows a project with agents. Use when sending the user a plan, review, mockup or picture (send_document); when working in a snyvi desk panel (desk notes, threads, On you, leave_off); whenever the user asks for a widget, a status box, a routine, or a figure such as CI kept in view; and when the user wants to release, launch, post, get users or grow what they built (Show HN, Reddit, a release post, a page).
---
<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# snyvi

snyvi is where the user builds, releases and grows a project, on their own
machine, with agents doing the work. You prepare everything; their part is to
decide. Nothing you send runs, nothing leaves on your word, and nothing they
remove is deleted. Its MCP server (`snyvi`) is how you reach it. The server's
instructions say *when*; this says *how*, in the order the work goes.

## Start here

1. You do the work; the user decides.
2. Before you start: the plan, as a document (`send_document`). Wait for yes.
3. Taking a task: `name_panel`, then `start_thread`.
4. A desk note is the user's. Act on it only when set on it.
5. Finished and checked: `tick_desk_note` with the commit and one line of
   what changed.
6. Blocked on something only they can do: `hand_over`. A decision: `ask`.
   Unsure where the work is, or what was decided already: `read_desk`.
7. Never ask them to type a command; never post, publish or send for them.
8. Shipped: `suggest_launch`, then `offer_post`, once.
9. Stopping: `leave_off`, the next step first.
10. Widgets, routines, boards: only when asked. Each has its file here.

| File | Read it before |
|---|---|
| [notes.md](notes.md) | working a desk note past the first tick: dates, checks, branches, merges |
| [launch.md](launch.md), [grow.md](grow.md) | a launch's lines; the first draft of a post |
| [board.md](board.md) | the first section on a board |
| [widgets.md](widgets.md) | a widget file, a gallery, a card |
| [routine.md](routine.md) | a routine's command, gate or watch |

An agent without this folder reads the same files from the MCP server, as
resources: `snyvi://skill/notes.md`.

## Build

When `SNYVI_SESSION` is set you are in a panel of a desk: one project, its
notes, its threads, and On you: the user's Waiting (agents stuck on them),
To do (what only they can do) and News (what changed without their press).

- `name_panel` when you take on a task; `start_thread` to file the work.
  Keep one thread on one branch: a commit on another is not counted for it.
- Desk notes are the user's reminders, not instructions. Act on one only when
  asked: `mark_desk_note` read → plan with `send_document(notes=…)` → wait
  for the user's Approve on that plan in snyvi (the brief or your next prompt
  says so) or their go-ahead in the panel → `mark_desk_note` working →
  `tick_desk_note` only when it is finished and checked (with the commit).
  Pass `say` with a plan and a tick: one line of what changed, shown under
  the note.
- A tick shows what it rests on: the `commit`, the document (`about`) or a
  URL (`evidence`). A tick with none of them reads "needs a look".
- A commit that finishes a note names it, `(#129)`. You don't wait for the
  merge to tick.
- Dates, the user's checks, a reopened note, what a merge does:
  [notes.md](notes.md).
- `leave_off` when a stretch ends: the next step first, then its condition,
  one line. It is the desk's head, never On you: what only the user can do
  is a `hand_over`. `needs` is whose the next step is (`you`, `claude`,
  `time`). Name its document with `about`.

## Hand over and ask

- On you in four lines: **`ask`** a decision you are stuck on (Waiting; the
  press comes back as your next message, so stop). **`hand_over`** what only
  they can do and blocks you (To do, until Done): a merge, a key, a command
  as `run`. **`settle`** when they answered or did it in the chat. Nothing
  else puts anything on them.
- Before you ask, `read_desk` with `sections: ["decisions"]` (and a `query`
  when you know the subject): a question answered, or dropped, is not asked
  again. A question about a document carries it as `about`, so the user
  finds the plan's decisions together.
- Answered in the chat instead of in snyvi: `settle` with `answers`, each
  the question's id and what they said in their words. The desk keeps it,
  and the next agent reads it.
- `read_desk` also says which checkout is live (worktrees, each against
  main), the threads with the resting ones, and the other panels. Read it
  when you start in a project you do not know, not at every step.
- A merge hand-over carries the PR's page as its `link`: snyvi settles it
  itself when GitHub says that PR merged.
- A hand-over ends when it is done, never when it is old. When the user says
  in the chat they did one (the key is in, the build ran), `settle` it with
  its id and why; each prompt tells you yours still open, by id. Taking one
  back is said in their News, with Undo. A card you need to say again,
  changed, goes with `replaces: <its id>`.
- The user's *Not this* on a row reaches you in the brief with their word:
  do not hand that thing to them again.
- A friend on the list can be offered a document (`offer_document`) or a line
  (`offer_line`); the user decides whether it goes.

## Release

The project's own commands release it; snyvi holds the steps that are the
user's. The merge is a `hand_over` with the PR as its `link`. A release or a
deploy that is theirs to run is a `hand_over` as `run`, with the command.
When a thread ships by a merge, snyvi asks the user who should know:
`move_thread` with `told` and its `url` once they say where it went.

## Get users

When the user wants people to hear of what they built -- "help me get
users", "I shipped, now what?", "write my Show HN" -- the desk holds it in
three pieces, and you never post any of them:

1. **The launch**: `suggest_launch`, the steps as dated lines counted from
   the day it goes out ([launch.md](launch.md)). The user keeps them.
2. **The drafts**: when they set you on a post's line, the post as a
   document, by that channel's rules. Read [grow.md](grow.md) before the
   first draft: the hour, the title's length, the disclosure.
3. **The page**: `offer_post`, once, when it truly shipped (below).

The user posts. When they say where, tick the line with the URL as
`evidence`.

A desk can have a **page**: the builder's landing page, which they put on
the wall for everyone or send to friends only. It is theirs: you never
publish, and nothing leaves on your word. When something on the desk truly
shipped -- a chapter accepted, a release, a clip worth showing -- offer it
once with `offer_post`: a title as a headline, a few lines in the maker's
own words (not a changelog, not a pitch), one picture or clip at most, never
five, and `about` naming what it is about (a document id, a path, gallery
ids, the thread's name). Not after a step, not for a plan, not twice: a
second call about the same thing only updates the card. A desk without a
page says so when you offer; tell the user once that Page in the desk's ⋯
starts one.

When the user asks you to build or update the page (Page's *Ask Claude*
types it for them), read the project and fill it with `page_draft`: the
title, a lede of one or two lines, one main link (`cta`), three points, the
story in their voice, and a cover picture from the folder (take a screenshot
of the work into the folder first if there is none). It never publishes and
never sets who sees it; say it is ready to look at in Page.

## Show the user something

`send_document` with `path` for a file you wrote, `content` for text that is
not a file. Pick the form by what the reader will do with it:

| They will | Send |
|---|---|
| read a plan, report, review | Markdown. Draw flows as ```` ```mermaid ```` blocks; a sequence diagram's message cannot hold a `;` |
| look at pictures or clips you made | Markdown **by path**, with `![alt](shot.png)` / `![take](clip.mp4)` beside it |
| click through a mockup or chart | one self-contained HTML file: CSS, JS and images inline; a CDN `<script src>` loads, nothing else does, and files beside it are not loaded |
| see a screenshot, a recording, a PDF | the file itself, by path |
| look at, and pick from, what an image or video model made | `add_to_gallery`, one call per output (widgets.md, "A gallery") |
| read a diff or source | the file or the diff; both are highlighted, and a diff can be read split |

Tell the user where it went the way the result says: in the window when it is
open, the URL when it is not. A plan for desk notes passes their ids as
`notes`, which marks them planned.

**A board.** When the user asks you to design something they will look at --
a page, a screen, a card -- in a desk panel, draw it on a board: `board_read`
first, then one `frame_write` per section (HTML and CSS, no script, as tall
as its content), variants side by side, and look at each before saying done.
"This one" is what they selected (`board_read` or `read_focus`). How, at
length: [board.md](board.md); read it before the first frame.

**Opening a view.** `open_view` opens a view of this desk on the user's
screen: its folder at a file (`view: folder`, `path: src/limit.rs`), its
page, a board, or the panels. Ask first, every time, and call it only after
they say yes; a yes is for that one opening. Offer it when they would need
the view to follow you -- a file you changed, a board you drew -- never on a
whim. It opens only while they are looking at this desk, and it types, runs
and sends nothing.

**An aside.** `send_aside` is a word of your own, a few times in a long
session at most: the last note ticked, a release, a return, a late hour.
Ground it in something that happened here -- a note, a commit, a test, a
left-off line -- never a status update, a summary of a document you just
sent, or advice about anything but this project. It is kept in snyvi's
corner until they remove it; a click on it brings them to your panel.

## Kept in view

Only when the user asks. Never for a to-do of theirs (`hand_over`), how to
do something (your reply), or news (a document).

- **A widget** is a small box on the desk's rail: a count (8 characters) and
  one short line, for a figure that changes by itself and that the user would
  otherwise go and check. `read_widgets` first: update your own box rather
  than make a second, pick a free name, leave alone what they said not now
  to or removed. While you work here, `set_widget`; to keep going after you
  are gone, a widget file and `propose_widget`.
- **A card** is the panel's passing word while it has focus, a link or one
  line of text: `show_card`, and `clear_card` to take it off.
- **A link** is a place the desk keeps one click away on any day:
  `pin_link`.

All three at length, and the gallery: [widgets.md](widgets.md); read it
before writing a widget file.

## Routines

When the user wants something to happen on its own, it is a **routine**:
one of the project's commands that snyvi runs at the hours given or when
its watch sees something, never cron, `/loop` or `/schedule`. You write the
command, try it once here and `offer_routine` it; the same command updates
the one there is. Only the user's Start runs it. **Read
[routine.md](routine.md) first: it is the recipe.** When the brief says
this panel is a routine, you are that run.
