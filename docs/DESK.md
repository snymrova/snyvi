# Desks: real shells in the window, and what keeps them there

A **desk** is a named workspace rooted at a folder, holding up to four panes
in a fixed two-column grid. Several desks can exist, and two can share a
root. A desk takes the whole of `#main`: it is a view, not a band under a
document, and it is not a document. It has its own tables and its own id
space, and it never appears in search, the inbox or the queue.

`docs/TERMINAL.md` declined this feature in 2026-09 and section 9 there says
what changed. This file is the feature as built: the model, the security
premises and where each one is enforced, the wire protocol, and answers to
the questions the design left open.

## 1. The model

| Thing | Where it lives | Survives a restart |
|---|---|---|
| A desk: name, root, two divider fractions | `desks` table, `src/desk.rs` | yes |
| A pane: slot 1–4, cwd, the command it last ran | `panes` table, `src/desk.rs` | yes |
| A pane's last screen, as plain text | `panes/<id>.txt` beside the store | yes, shown greyed |
| The PTY, the process, the live screen | memory, `src/pane.rs` | **no** |

**The daemon never respawns a process; the window does.** A daemon that starts
finds every pane stopped and leaves them so. A daemon that respawned eight
shells across three desks at login would be a daemon nobody left running. But
a pane the reader is *looking at* is a pane they want a shell in, so the page
starts it: on its first real size, a pane with no process and no exit code
sends `POST /api/panes/{id}/start` with what it last ran. The old screen stays
above it, greyed, as scrollback.

The distinction the page draws is the exit code. No exit code means nothing
ended — the daemon went away underneath a running shell — and there is nothing
to tell the reader about that. An exit code means the process ended, or the
reader stopped it, and what to do next is theirs to say: that pane keeps the
greyed screen and the `▶ Start` bar with the last command filled in. Panes
behind a tab have no size and start nothing until they are shown, so opening a
desk costs the shells you can see and no more.

**Asking for a pane is asking for a shell.** A new desk opens with one pane
and its shell running, and `+ new pane` starts one too: both send the same
start with an empty command, which is the shell. The first build made every
new pane wait for a Start click, and a new desk opened as a grid of empty
boxes with nothing in them to type into. What runs is still only ever the
reader's shell, or a command the reader typed.

**A desk needs no folder.** `POST /api/desks` with no `root` makes a desk in
the home directory, named `desk` (then `desk 2`, ...), and the Desks page and
the palette offer it as `New desk`. The home directory is the daemon's to
name, so no path from the page reaches the filesystem on that route. A folder
under Folders still gives one on that folder, from its `+` or its menu.

**Two caps, and the global one is the one that matters.** Four panes per desk
keeps each pane readable. Eight panes in total, with 2 MB of scrollback each,
is what the memory budget allows: 16 MB against the 20 MB of headroom
`BRAINSTORM.md` records. Four per desk bounds nothing once the number of desks
is unbounded, so the global cap is the one with a test
(`desk::tests::eight_panes_is_the_whole_of_it_however_many_desks_there_are`).
Both caps are checked inside the transaction that inserts the pane.

**Slots, not splits.** There are two columns and four slots. An odd pane out
spans its row, and the whole layout is two fractions. Below 1100 px a desk
shows two panes, and below 700 px it shows one. The others stay one key away.

## 2. The premises, and the line that enforces each

1. **Panes run only in the desktop window, behind a capability.** A browser
   tab gets 403 on every desk route and on the socket.
   `desk_refusal` (`src/server.rs`) makes three refusals, in order: the
   capability in a query string, a request not from this page (`Origin` /
   `Sec-Fetch-Site`), and a missing or wrong capability. The test
   `every_desk_route_is_behind_the_gate` reads the source and fails if any
   desk handler reaches the store before it reaches the gate.
2. **The capability is never the write token.** It is stripped from the URL
   before anything renders, and it never reaches a page as the token would.
   `src/capability.rs` mints 32 bytes for each window launch and keeps the
   last sixteen in `capabilities` beside the token, mode 0600, so a window
   that was open across a daemon restart or an upgrade keeps its panes. They
   were once held in memory only, and every restart left the open window
   answering "no capability" until it was reopened. What the capability keeps
   out is a browser tab, which cannot read a file; a process running as the
   reader can read the token, and mint with it, already. The page reads the capability from the URL fragment, keeps it
   in `sessionStorage`, and `replaceState`s it out of the address bar. HTTP
   requests carry it in the `x-snyvi-capability` header. The socket carries it
   in its first frame, because a browser `WebSocket` cannot set headers.
3. **snyvi never makes input from content it received.** There is no fan-out
   and no run-this-block, and nothing derived from a document is ever typed.
   Bytes reach a PTY from exactly one place: `input()` in `ui/desk.js`, which
   is called only from a key event or a paste event. The daemon accepts `in`
   only for a pane that socket is watching (`desk_session`).
4. **The query string is refused as a transport for the capability.** A
   request path lands in logs. The fragment never leaves the browser, but it
   is not unlogged either: it arrives as `snyvi-app` argv, where `ps` can see
   it.

One consequence to know about: **a capability dies with the daemon that
minted it.** After a restart or an upgrade, an open window's socket is
refused, and the desk says so and asks for the window to be reopened.

## 3. The protocol

The socket is `GET /api/desk`. It is inert until its first frame, and it has
two seconds to send it:

```
→ {"capability":"<64 hex>"}
← {"ok":true}                        or {"error":"no capability"} and a close
```

Then the page sends:

| Frame | Meaning |
|---|---|
| `{"t":"watch","panes":[id…]}` | The panes this page shows. The list replaces the previous one. |
| `{"t":"in","p":id,"d":"…"}` | Keys or a paste for a pane this socket watches |
| `{"t":"size","p":id,"c":cols,"r":rows}` | The size this page draws the pane at |

For each pane it starts to watch, the daemon sends a `status`, then an `old`
if the pane has text from a previous run, then a full `frame`. After that it
sends frames as the screen changes, at most one per frame:

| Field of `frame` | Meaning |
|---|---|
| `sz: [cols, rows]` | **Resize and clear.** Blank the grid at this size before anything else. |
| `sbclear` | Empty the scrollback (`ESC [ 3 J`) |
| `gap: n` | This many lines scrolled by without being sent |
| `sb: [line…]` | Lines that left the top of the screen, oldest first; `{"w":1,"r":runs}` marks one that wrapped |
| `r: [[y, x0, runs]…]` | Row `y` from column `x0`, as runs |
| `c: [x, y, visible]` | The cursor |
| `m: [appCursor, bracketedPaste]` | The two modes the page needs to encode keys and pastes |

A run is `[text, fg, bg, flags]`, and trailing defaults are dropped, so plain
text is `["text"]`. A colour is 0 for the default, 1–256 for a palette index
plus one, or `0x1000000 | rgb`. Flag 256 marks a run of double-width
characters.

### Three rules from the Phase 0 spike

1. **`shown` holds exactly what the page holds.** A diff skips any cell that
   matches the last frame. So a resize must clear both sides, and `sz` is how
   the page learns to clear. Before this rule the spike found 564 desyncs,
   and after it none. `screen::tests` runs the same check on every frame: a
   replica starts blank, applies the frames, and is compared cell for cell
   across 4,000 steps of hostile input with resizes in between.
2. **No scroll op.** It saved 0.1% on the firehose test and nothing on the
   others.
3. **The frame is the governor.** A pane is diffed at most every 16 ms, or
   every 33 ms after a frame over 32 KB, so the bytes sent are bounded by
   the screen size, not by how fast a process writes. A page that falls
   behind the broadcast gets a fresh snapshot instead of a backlog.

`permessage-deflate` would have saved 2–3× on real workloads, but it is **not
used**, because the WebSocket library under axum does not implement it. On
loopback this costs nothing that matters.

## 4. Provenance

A pane's child process gets `SNYVI_SESSION=<pane id>`, along with
`SNYVI_DESK` and `SNYVI_SLOT`. The daemon cannot read the sender's
environment, so the client reads the variable instead: `client::send`, which
every transport goes through, puts it on `Payload.pane`. On arrival the
daemon copies the desk id, desk name and slot onto the document, so the
document's meta reads **From snyvi [1] ▸**. It is a link to the desk with
that pane focused, and it still names the desk after the desk is closed.

`SNYVI_SESSION` decides which pane a document is attributed to. The hook's
`cwd → session` map (`src/session.rs`) still decides which workflow a
document joins. A pane id is 16 random bytes, so a process that was not
started in the pane cannot claim to be it.

## 5. The prompt

A pane runs the reader's own login shell, so the prompt used to be whatever
their dotfiles drew: a Powerlevel10k rainbow on one machine, a bare `$` on
the next, and on both a blue nobody chose -- ANSI 4, out of a theme's default
config. A desk should look like snyvi wherever it runs, so snyvi brings its
own prompt (`src/prompt.rs`): the folder in the window's accent, the branch
and a `*` beside it in a muted tone, and a chevron that turns red when the
last command failed.

It is a dressing, not a replacement. The shell still starts the reader's way
and their own rc files are sourced first -- `PATH`, aliases, completions --
and only then is the prompt set, last, so it wins. zsh is pointed at a
`ZDOTDIR` of snyvi's whose files source theirs and hand `ZDOTDIR` back, so a
zsh started *inside* the pane is undressed; bash gets an `--rcfile` that does
what a login bash would have done first; fish gets `-C`. A shell snyvi has no
dressing for starts exactly as it did, with its own prompt.

A prompt framework already installed is taken back off rather than raced:
Powerlevel10k has a teardown of its own, and the others are hooks, removed
from the arrays they were put in. The hook snyvi adds keeps itself last, so a
framework that installs on the first prompt still does not get the last word.

The accent travels with the request that starts the pane -- the page sends
`#rrggbb` as its CSS resolved it -- and is written into the rc files then.
Only `#rrggbb` is accepted, because it is pasted into a file a shell runs.

A running shell cannot be told a new accent, so it is not asked to be. The
pane's status carries the colour it was dressed in, and the page paints that
exact colour as `var(--accent)` rather than as itself, so changing the swatch
re-tints every prompt already on the screen, scrollback included, without a
shell drawing anything again. Anything else that sends that exact colour
re-tints with it, which is the price of the trick.

The chevron is U+F054 from the symbols font snyvi serves, not `❯`: neither
bundled font has `❯`, and the machine's own fonts may not either.

**Nothing in the prompt runs a process.** The branch is read out of
`.git/HEAD` by walking up from the folder in the shell's own builtins, the
way `project::branch` reads it -- a prompt that forks is a prompt that
stutters in a large repository, and only zsh and fish can draw one late
(bash's readline cannot repaint), so async would have meant a fast prompt on
one shell and a slow one on another. What costs -- whether the tree is
modified -- snyvi works out for itself, off the prompt's path, and shows in
the pane's header. That is also how a pane running `cmd.exe`, or a shell
snyvi has no dressing for, still says which branch it is on.

On Windows the shell is whatever `ComSpec` names. PowerShell is dressed with
`-NoExit -Command` sourcing a generated profile; `cmd.exe` has no rc and no
scripting in its prompt, but it reads `PROMPT` from the environment and `$E`
there is an escape, which is all the accent needs.

## 6. The questions the design left open, answered

**Blocked.** A pane is blocked when its program rings for the reader: a BEL,
or an OSC 9 or OSC 777 notification. The block is cleared by the next input
to that pane. Silence is not a signal, because every idle shell would read as
blocked. The page shows a count beside `Desks`, a `!` on the desk and one
amber rule under the pane. There is no modal, and focus is not moved.

**Scrollback at the 2 MB cap mid-line.** Whole lines are dropped from the
front. Nothing is cut in the middle, because a half line misrepresents what
was on screen. One line larger than the whole cap is truncated to half the
cap rather than dropped. The daemon keeps up to the cap. The page keeps 6,000
rows and marks lines that went by unsent with `⋯ n lines went by`.

**Image paste.** A PTY cannot take a bitmap, so a pasted image is stored as a
document, with the pane's provenance. The page then types the image's
**path** as the reader's paste. That path is `pastes/<hash>.<ext>` beside the
store. The plan said to send a URL, but an agent opens a file with its own
tools and has no reason to be able to fetch from this daemon, so a path is
what it can use. **Still open:** an agent in a sandbox may not be allowed to
read that folder.

**Mouse reporting.** Not supported. In a pane, the mouse is for selection,
and selection is the browser's own, because the screen is DOM text. The wheel
scrolls the page's scrollback.

**Screen readers.** Each pane body is a labelled region, not a live region.
A region that repaints sixty times a second would be noise if announced.
Scrollback is plain text and can be read on demand.

**OSC 52 clipboard writes are declined.** A process in a pane does not get
to write to the reader's clipboard. Copy is the reader's: releasing a
selection copies it, and so does Ctrl+Shift+C.

**Reserved keys.** `⌃\`` swaps between the desk and the reading view.
`⌃⌥1`–`⌃⌥4` focus a pane by slot. `⌘` combinations go to the platform.
Ctrl+Shift+C and Ctrl+Shift+V are copy and paste, as in a Linux terminal.
Every other key goes to the pane, including the single-letter keys the
reading view uses.

## 7. Gaps, stated

- **No reflow on resize.** A line cut short by a narrower pane stays cut.
- **No combining marks, charset designation or DCS.** The spike saw 0–4
  unhandled sequences per run. A combining mark is dropped rather than drawn
  in the wrong cell.
- **No IME composition.** Keys arrive as `keydown`, so dead keys and input
  methods that compose do not work yet.
- **A pane is sized by the last window to ask**, as in tmux. Two windows on
  one pane at different sizes take turns.
