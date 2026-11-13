<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# A desk note, at length

Read `SKILL.md` first: a note is the user's, and you act on one only when
set on it. This is the bookkeeping past the first tick.

## What you read

`read_desk_notes` gives the desk's list, open first, each with its id.
You cannot add, edit or remove a note, and nothing you do puts one there:
if something belongs on the list, `suggest_desk_note` offers it and the
user keeps it or not. A desk holds only a few suggestions waiting at once.
A line can carry pictures, listed under it as files you can open and look
at. A line another panel's agent is working on says so; leave it to that
panel.

## Stages

| Stage | When |
|---|---|
| `read` | the user set you on it and you have read and understood it |
| `planned` | the plan is sent: pass the notes to `send_document` as `notes`, or the plan's id to `mark_desk_note` as `about`. Pass `say`, one line of what you will do |
| `working` | as you start, once the user approved the plan in snyvi or said go; it shows as being worked on in this panel until the session ends |

Mark a note only when the user set you on it, never to claim one you chose.
You can move a note back a stage, from working to planned when you stop
partway. Done is not a stage: that is the tick. Several notes go in one
call, by `ids`.

## Dates

A note can carry a date the user gave it (`by fri 10`); the brief says what
is due today. A due note is still acted on only when asked.
`suggest_desk_note` takes `due` in the user's words when a line has a
natural day: a launch step, a follow-up; at that hour snyvi raises one card
on their On you list. A launch is several dated lines as one set,
`suggest_launch`: read [launch.md](launch.md) first.

## The tick

- Tick when the work is committed and checked, with that commit, as git log
  prints it: you don't wait for the merge, and the note reads "on a branch"
  until the commit is on main.
- Never for work that is partly done, only planned, or done by someone
  else, and not to tidy the list. You cannot untick; the user can.
- `say` is one line under 160 characters the user can check against: "The
  hook now catches xdg-open inside prose", not "done".
- If the finished work can be seen somewhere -- a pull request, a deploy, a
  store page -- pass that URL as `evidence`. A tick with no commit, document
  or URL reads "needs a look".
- A commit that finishes a note names it, `(#129)`, so snyvi finds the work
  on main when it ships by another branch. A note that landed without a
  tick reads "check it"; tick it if the work is yours to check.
- After ticking, say in your reply which notes you ticked.

## Reopened

A note the user reopened says what is still wrong, and the brief leads with
it: fix that, not the note as first written.

## The user's checks

A note can hold the user's own checks: lines of what they will try once
the work is done. You see only how many (`(2 checks held)` in the brief
and `read_desk_notes`), never the words, so build for the whole note, not
for a guess at the checks. When you plan a note, `suggest_check` may offer
up to five lines in their terms (three wait on a note), from what the note
implies about how they work; you will not be shown them again. A failed
check reopens the note with its words.

## Merges

The user's merge closes only the notes its PR's commits name, and ticks the
thread's notes those commits name; a merge by anyone else lands them for
the user's check. When a thread ships by a merge, snyvi asks the user who
should know. You never post: draft the release note or the post as a
document when asked, and `move_thread` with `told` and its `url` once they
say where it went.
