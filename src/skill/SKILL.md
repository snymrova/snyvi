---
name: snyvi
description: How to work with snyvi, the user's local document viewer with desks. Use when sending the user a plan, report, review, mockup or picture (send_document); when working in a snyvi desk panel (desk notes, threads, On you, leave_off); and whenever the user asks for a widget, a status box, or to keep a figure such as CI, a deploy or a dev server in view on the desk.
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
  as one set (`lines`): read [launch.md](launch.md) first.
- A tick shows what it rests on: the `commit`, the document (`about`) or a
  URL (`evidence`). A tick with none of them reads "needs a look".
- When a thread ships by a merge, snyvi asks the user who should know. You
  never post: draft the release note or the post as a document when asked,
  and `move_thread` with `told` and its `url` once they say where it went.
- A commit that finishes a note names it, `(#129)`: once it is on main the
  note reads "check it" for the user, whatever branch carried it. A note the
  user reopened says what is still wrong; the brief leads with it.
- `hand_over` is for what blocks you that only they can do: a command to run
  (as `run`, never as text to type), a key, a merge. `ask` is for a decision.
  A merge hand-over carries the PR's page as its `link`: snyvi settles it
  itself when GitHub says that PR merged, and the user's own merge ticks the
  thread's notes (a merge by anyone else lands them for the user's check).
  Don't tick a thread's notes for a merge yourself. Keep one thread on one
  branch: a commit on another branch is not counted for it.
- `leave_off` when a stretch ends: the next step and its condition, one line,
  with `needs: you` when the next step is the user's (approve, commit, a key,
  try it), `claude` when it is an agent's, `time` when it waits on the world.
  Two days of `you` puts it on their Home's Waiting on you.
- A friend on the list can be offered a document (`offer_document`) or a line
  (`offer_line`); the user decides whether it goes.

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
