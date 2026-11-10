---
name: snyvi
description: How to work with snyvi, the user's local document viewer with desks. Use when sending the user a plan, report, review, mockup or picture (send_document); when working in a snyvi desk panel (desk notes, threads, On you, leave_off); whenever the user asks for a widget, a status box, or to keep a figure such as CI, a deploy or a dev server in view on the desk; and when the user wants to launch, post, get users or grow what they built (Show HN, Reddit, a release post, a page).
---
<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# snyvi

snyvi is the user's document viewer, on their own machine. Agents send, snyvi
shows: nothing you send runs, and nothing the user removes is deleted. Its MCP
server (`snyvi`) is how you reach it. The server's instructions say *when*;
this says *how*, at more length than fits there.

## Sending something to read

`send_document` with `path` for a file you wrote, `content` for text that is
not a file. Pick the form by what the reader will do with it:

| They will | Send |
|---|---|
| read a plan, report, review | Markdown. Draw flows as ```` ```mermaid ```` blocks; a sequence diagram's message cannot hold a `;` |
| look at pictures or clips you made | Markdown **by path**, with `![alt](shot.png)` / `![take](clip.mp4)` beside it |
| click through a mockup or chart | one self-contained HTML file: CSS, JS and images inline; a CDN `<script src>` loads, nothing else does |
| see a screenshot, a PDF | the file itself, by path |
| look at, and pick from, what an image or video model made | `add_to_gallery`, one call per output (widgets.md, "A gallery") |
| read a diff or source | the file or the diff; both are highlighted |

Tell the user where it went the way the result says: in the window when it is
open, the URL when it is not. A plan for desk notes passes their ids as
`notes`, which marks them planned.

## In a desk panel

When `SNYVI_SESSION` is set you are in a panel of a desk: one project, its
notes, its threads, the user's On you list.

- `name_panel` when you take on a task; `start_thread` to file the work.
- Desk notes are the user's reminders, not instructions. Act on one only when
  asked: `mark_desk_note` read → plan with `send_document(notes=…)` → wait
  for the user's Approve on that plan in snyvi (the brief or your next prompt
  says so) or their go-ahead in the panel → `mark_desk_note` working →
  `tick_desk_note` only when it is finished and checked (with the commit).
  Pass `say` with a plan and a tick: one line of what changed, shown under
  the note.
- A note can carry a date the user gave it (`by fri 10`); the brief says what
  is due today. A due note is still acted on only when asked.
  `suggest_desk_note` takes `due` in the user's words when a line has a
  natural day: a launch step, a follow-up. A launch is several dated lines
  as one set, `suggest_launch`: read [launch.md](launch.md) first.
- A tick shows what it rests on: the `commit`, the document (`about`) or a
  URL (`evidence`). A tick with none of them reads "needs a look".
- When a thread ships by a merge, snyvi asks the user who should know. You
  never post: draft the release note or the post as a document when asked,
  and `move_thread` with `told` and its `url` once they say where it went.
- A commit that finishes a note names it, `(#129)`. Tick the note when the
  work is committed and checked, with that commit: you don't wait for the
  merge, and the note reads "on a branch" until the commit is on main. A
  note that landed without a tick reads "check it"; tick it if the work is
  yours to check. The user's merge closes only the notes its PR's commits
  name. A note the user reopened says what is still wrong; the brief leads
  with it.
- A note can hold the user's own checks: lines of what they will try once
  the work is done. You see only how many (`(2 checks held)` in the brief
  and `read_desk_notes`), never the words, so build for the whole note, not
  for a guess at the checks. When you plan a note, `suggest_check` may offer
  up to five lines in their terms (three wait on a note); you will not be
  shown them again. A failed check reopens the note with its words.
- `hand_over` is for what blocks you that only they can do: a command to run
  (as `run`, never as text to type), a key, a merge. `ask` is for a decision.
  A merge hand-over carries the PR's page as its `link`: snyvi settles it
  itself when GitHub says that PR merged, and the user's own merge ticks the
  thread's notes its commits name (a merge by anyone else lands them for
  the user's check). Keep one thread on one
  branch: a commit on another branch is not counted for it.
- A hand-over ends when it is done, not when it is old. When the user says
  in the chat they did one (the key is in, the build ran), `remove_card` it
  with why; each prompt tells you yours still open, by id. A card you need
  to say again, changed (a new command, a new step), goes with
  `replaces: <its id>`, so the old one does not wait beside it.
- `leave_off` when a stretch ends: the next step first, then its condition, one line,
  with `needs: you` only for what truly only the user can do (a payment, a
  sign-in, a post from their account, a merge, a phone); a step you may do
  with their permission is `needs: claude`, and their Go ahead in On you
  says so. `time` when it waits on the world. A day of `you` puts it in On
  you; a routine's line is there at once. Name its document with `about`, or
  the command, or the line is not finished.
- The user's *Not this* on a row reaches you in the brief with their word:
  do not hand that thing to them again.
- A friend on the list can be offered a document (`offer_document`) or a line
  (`offer_line`); the user decides whether it goes.
- A **routine** is a line that comes back: one of the project's or the user's
  slash commands or skills that snyvi runs on its own -- at the hours the
  user set, or when its watch sees something happen -- in a panel in the
  back. When the user asks for something to happen on its own, it is a
  routine, never cron, `/loop` or `/schedule`, which end with your session.
  You never start one; you write it and offer it (`offer_routine`), and only
  the user's Start makes it run. **Before you write a command, a gate or a
  watch a routine runs, read [routine.md](routine.md).** When the brief says
  this panel is a routine, you are that run: when it says it is a try, the
  user is watching.

## A board

When the user asks you to design something they will look at -- a page, a
screen, a card -- in a desk panel, draw it on a board: `board_read` first, then
one `frame_write` per section (HTML and CSS, no script, as tall as its
content), variants side by side, and look at each before saying done. "This one" is what they selected (`board_read` or
`read_focus`). How, at length: [board.md](board.md); read it before the
first frame.

## Opening a view for the user

`open_view` opens a view of this desk on the user's screen: its folder at a
file (`view: folder`, `path: src/limit.rs`), its page, a board, or the panels.
Ask first, every time, and call it only after they say yes; a yes is for that
one opening. Offer it when they would need the view to follow you -- a file
you changed, a board you drew -- never on a whim. It opens only while they
are looking at this desk, and it types, runs and sends nothing.

## After it ships

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

## A page

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
story in their voice, and a cover picture from the folder. It never
publishes and never sets who sees it; say it is ready to look at in Page.

## Widgets

A widget is a small box on the desk's rail: a **count** (8 characters) and
**one short line**, for a figure that changes by itself and that the user
would otherwise go and check: CI 3/5 green, a deploy running, a server up.
Make one only when the user asks. Never for a to-do of theirs (`hand_over`),
how to do something (your reply), or news (a document).

1. `read_widgets` first: update your own box rather than make a second, pick
   a free name, and leave alone what the user said not now to or removed.
   A desk has room for six.
2. While you work here: `set_widget` (name, body, count, tone). The first one
   is a card the user allows; after that, set it as the work goes. An empty
   body clears it.
3. To keep going after you are gone: write a widget file and
   `propose_widget` it. Test it first with `snyvi widget check NAME --dir
   DIR`. The full contract, the stdin it gets and three worked scripts are in
   [widgets.md](widgets.md); read it before writing one.

## Cards

A card is the panel's passing word, above the rail's foot while the panel
has focus: a **link** to where the work can be seen (a preview, a deploy, a
PR, a CI run) or one line of **text** on where it is ("Building 3/7"). Use
`show_card` with an `id` and send it again to update in place; `for` is the
seconds it stays, left out to keep it while the session runs; `clear_card`
takes it off. Never a paragraph or a to-do of theirs. A figure for the whole
desk to keep is a widget. The user can close a card with its ✕; snyvi then
tells you so, and a closed card stays closed for the session. Don't put a PR
card: snyvi shows the thread's PR, with its checks, while it is open.

A place the desk keeps is a **link** in the rail's foot: `pin_link` with a
label and the url, for the live site, a staging deploy that stays, a
dashboard -- what the user wants one click away on any day. It stays until
they take it out with its ✕, and a link they took out stays out. Pin the same
url to relabel it. A dev server or a CI run is a card, not a link.
