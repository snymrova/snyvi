<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# A launch, as dated lines

Read `SKILL.md` first. Use this when the user says *launch* (a release
people should hear of, a post, a Show HN) or starts a thread with launch
in its name.

A launch is not a document. It is a handful of dated lines on the desk,
suggested as one set, that the user keeps with **Keep all** and ticks as
they go. The desk's head counts them (`3/6`), and each rings once on its
day.

## The set

One `suggest_desk_note` call with `lines`, each `{ "text", "due" }`, `due`
in the user's words. Count back from the day they name (T0); leave out a
line that does not fit this launch, and add one that does:

| When | The line |
|---|---|
| T-7 | pictures and copy for the post |
| T-2 | site live at the new version |
| T-1 | schedule the post |
| T0 | post it · reply for six hours |
| T+2 | Show HN |
| T+7 | write what happened: numbers, not feelings |

Say the dates as dates, `28 oct 10`, not `in 5 days`, so they read the same
tomorrow. Twelve lines at most.

## Then

- You never post. Draft the copy, the release note or the post as a
  document (`send_document`) when asked, and leave the line to the user.
- When the user says where it went out, `move_thread` with `told` and its
  `url`.
- A tick on the T+7 line carries the numbers as its `say`, and where they
  came from as its `evidence`.
