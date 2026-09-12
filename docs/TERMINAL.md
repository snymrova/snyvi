# A terminal from snyvi: what is wanted, and what is safe to give

Written 2026-09-12, after a question about giving the desktop app a
terminal to run commands from.

**Status.** Section 5 has landed. A button in the document header and the
browse header opens the *system* terminal in the right directory. The
embedded terminal of section 3 is declined, and section 3 exists so it does
not have to be re-argued from scratch the next time it is asked. Section 7
is where the plan turned out to be wrong, and says how.

Unlike `DIAGRAMS.md`, nothing here is measured, because nothing here is
about time. The argument is structural, so section 2 is read out of the
source with line numbers rather than taken from a harness. The one number
that would need measuring is called out as unmeasured in section 3.

## 1. Four products are hiding in the question

"A terminal in the desktop app" is four different features wearing one
name, and separating them is most of the work:

| | What it is | Cost | Call |
|---|---|---|---|
| A | An embedded emulator: a PTY in the daemon, a terminal in the page | M–L | **no** |
| B | "Run this block" on a fenced shell command | S | **no**, see section 6 |
| C | "Open a terminal here" — spawn the system terminal, cwd set | XS | **this** |
| D | "Start the agent here" — C with one program named | XS | later, if asked for |

A and C sound like the same feature at different fidelities. They are not
related: one adds an execution surface to snyvi, and the other adds a
directory path to a program the machine already has.

## 2. The invariant that would be spent

Three things are true of the daemon today, and they are why the security
story fits in a paragraph.

**The token gates reach, not access.** `authorized` (`src/server.rs:961`,
a constant-time compare) is called by exactly three handlers: `shutdown`
(`:513`), `receive_doc` (`:668`) and `browse_open` (`:752`). Everything
else — the tree, search, `doc_raw`, `browse_raw`, `compare`, the SSE
stream, pin, delete, both renames — is ungated. That is deliberate and it
holds: the listener is loopback-only (`:137`), so the caller is already on
the machine; CORS keeps a foreign page from *reading* a response it can
fire; and the three operations that extend snyvi's reach — write a
document, open a new path on disk, stop the daemon — are the three that
carry the token.

**No HTTP handler spawns a process.** `platform.rs` spawns plenty:
`open_url` (`:37`), `shim` (`:127`), `notify` (`:141`), `terminate`
(`:199`), the detached daemon (`:247`). Every one is reached from the CLI
or the receive path. Nothing that arrives over HTTP reaches a command
line. The invariant is currently total, which is the kind of invariant
worth knowing you are about to spend.

**Nothing checks where a request came from.** There is no `Origin`,
`Referer` or `Sec-Fetch-Site` check anywhere in `server.rs`. It has never
been needed, for the reason above: the ungated endpoints leak nothing a
foreign page can read, and the gated ones need a 32-byte secret
(`src/config.rs:80`, `getrandom`, hex, `0o600` at `:67`).

The CSP (`src/server.rs:37`) is tight, and it is worth being clear that
it protects snyvi's own page from its own content. It says nothing about
what some other page in the same browser may send to `127.0.0.1`.

## 3. Why the embedded terminal is the wrong trade

Not because it is hard. A PTY crate plus a terminal emulator in the page
is a solved problem — perhaps 500 to 700 lines, two dependencies, and a
few days to something that works. It is the cheapest expensive feature
available.

**It deletes the one-way rule rather than weakening it.** The rule is
that agents send and snyvi shows, *so the viewer can never leak one
project's documents into another session's context*. An executor gives
the channel a return path through the reader's click. And a document is
attacker-influenced content in the general case: an agent that summarised
a hostile page, or read a poisoned README, can put `curl … | sh` in a
fenced block — and a page with an executor renders that with a button
next to it. The gate is one click by a reader whose model of snyvi is
"this is a viewer, nothing here runs". That last clause is the dangerous
part, and it is a thing snyvi has spent seven releases earning.

**A leaked token inverts from nuisance to code execution.** Today the
worst of it is: someone writes junk into your inbox, opens a directory
for browsing, kills your daemon. Bounded. With an exec endpoint the same
secret is arbitrary code as you. Worse, the reasoning that makes the
ungated read surface safe — "CORS hides the response" — is worth nothing
for an endpoint whose *effect* is the payload. A no-preflight POST from
any page in the user's browser can fire a request it cannot read, and for
an executor, firing is the whole attack; DNS rebinding against loopback
services is a practised class, not a hypothetical one. So this needs the
`Origin` check section 2 says does not exist, a CSRF secret distinct from
the write token, and probably a per-tab nonce — and it is the category of
work where 95% correct is worth zero.

**The bytes land in the worst place.** `snyvi` is 12.3 MB against a
stated 15 MB budget, and the UI budget is 60 KB gzipped, which only
Mermaid breaks and only lazily. The Rust half of an embedded terminal is
small. The page half is a terminal emulator, and its size is
**unmeasured** — the honest range from memory is a couple of hundred
kilobytes minified, which would need measuring before anyone quoted it.
What is not in doubt is the shape of the bill, because it was just paid
once: a single lazily-loaded 975 KB blob costs 523 ms of parse on the
critical path and took a four-phase plan to make civil, and phases 2a, 3
and 4 of that plan are unstarted. Adding the second such blob before
finishing the first is how a program whose pitch is "instant" stops being
believed.

**It changes who snyvi is compared to.** Today the comparison is reading
the file in your terminal. With an emulator in it the comparison is VS
Code, Zed and Warp, who have more people on the terminal alone than this
project has files — and 12 MB stops reading as the point and starts
reading as a deficiency.

**"Not an editor" loses its last principle.** Once there is a shell,
"why can't I edit this file" has no answer left except that we would
rather not, having already done the harder and riskier thing.

## 4. And there is nowhere comfortable to put it

This is the argument that would settle it even if the ones above were
answered.

Put the executor in the daemon and it is reachable from any browser tab,
which is the worst available position for it. Put it in the window only
and it violates `BRAINSTORM.md` section 2 — *web and desktop are not two
products, they are the same rendering core behind a tiny local server
with two ways to look at it* — and it means giving `snyvi-app` an IPC
surface it deliberately does not have. That window needs nothing from the
crate; it is handed a URL on argv. That dumbness is exactly what took the
daemon from 66 MB back to 35 in 0.6, and it is what makes the window an
add-on rather than a fork in the road.

Two placements, both bad, in different directions. That is usually the
signal that a feature does not belong in the architecture rather than
that it needs a better design.

## 5. What lands: open a terminal here

A button in the document header and in the browse-root header that opens
the machine's own terminal, with its working directory set to the
directory the reader is looking at. snyvi spawns it and forgets it.

**snyvi passes no command.** That is the whole of why this is a different
feature and not a smaller version of section 3:

- The only input is a directory path snyvi already holds. There is no
  arbitrary-string execution surface, so no document's content ever
  reaches a command line, and section 3's first argument does not apply.
- Nothing comes back. Output goes to the terminal, which snyvi neither
  reads nor renders, so the one-way rule is untouched.
- The worst case of a stolen token becomes a terminal window opening in a
  directory. It still needs the token and it still wants the `Origin`
  check, because it is a side effect that arrives over HTTP — but the
  blast radius is a window, not the machine.
- No new dependency, no UI bytes, no build step, nothing the budgets in
  `BRAINSTORM.md` section 1 can see.

### The shape already exists

`app_mode_browsers` (`src/platform.rs:86`) is this function with a
different list: candidates tried in order, per platform, best effort,
never blocking, absolute paths on Windows because nothing there is on
`PATH`. The terminal lookup is the same function with the same failure
mode, and it belongs beside it.

- **Linux**: `$TERMINAL` if set, then `gnome-terminal`, `konsole`,
  `xfce4-terminal`, `alacritty`, `kitty`, `wezterm`,
  `x-terminal-emulator`. The working-directory flag is not uniform
  (`--working-directory`, `--workdir`, `-d`), so the candidate list
  carries the flag with the name rather than assuming one.
- **macOS**: `open -a Terminal <dir>`.
- **Windows**: `wt.exe -d <dir>`, falling back to `cmd /c start`, which
  is the path `open_url` (`:37`) already takes and `shim` (`:127`)
  already explains.

Guard it with `has_display` (`:29`), which exists for precisely this
question: a daemon reached over ssh should decline rather than fail, the
same way it prints a URL instead of opening a window.

**One thing found while reading for this.** The daemon's environment is
usually thin — it is started by the reader's first `snyvi send`, or by
`systemd --user` at login, which carries almost nothing. So `$TERMINAL`
will often be unset even on a machine that has three terminals
installed. The candidate list is not a fallback here; it is the path that
actually runs, exactly as it already is for browsers.

### Which directory

In order, first hit wins:

1. A browsed root: `Root.path` (`src/browse.rs`), which is absolute as
   opened. For a file inside the root, that file's parent.
2. A received document: the parent of `source_path`.
3. That document's project root: `projects.root` (`src/store.rs:94`,
   unique per project).

Step 3 is what makes the button appear on the documents that need it
most. `source_path` is an `Option` (`src/store.rs:26`) and a document
sent as content rather than as a path has none, so without the project
root the button would be missing from exactly the sends that come
straight out of an agent. The root is in the database and is not on
`Doc`; reaching it wants `p.root` added to `DOC_COLS` (`:129`) or one
small query beside it.

Where none of the three resolves to a directory that exists, there is no
button. A disabled control that cannot say why is worse than no control.

## 6. What is not being built, and why it is written down

**The embedded terminal (A).** Declined, per sections 3 and 4. This goes
into `ROADMAP.md`'s "Explicitly not planned" beside AppImage, which is
the precedent for the form: measured or argued, declined, recorded, so
the question arrives already answered.

**"Run this block" (B).** Also declined, and worth separating from A
because it sounds much smaller and carries the same first argument at
full strength: it is a one-click path from content an agent wrote to a
side effect on the reader's machine. If it is ever wanted, the only
honest shape is *hand the command to a terminal* rather than run it —
opened in the right directory with the command typed but not entered, or
on the clipboard — so that the history, the environment, the audit trail
and the responsibility stay in the shell where they already live. Section
5 plus the existing copy button (`ui/app.js:1003`) is most of that
already.

**"Open in editor".** Considered alongside and not wanted. `ROADMAP.md`
says *"snyvi is a viewer; 'open in editor' is the whole editing story"*,
and describes something that does not exist — the UI offers "Copy path"
(`ui/app.js:941`) and nothing further. The line does not need changing,
because section 5 makes it true by a shorter route: a shell in the right
directory is how a reader reaches their editor, and snyvi does not have
to learn the names of editors to get them there.

**A "run the agent here" button (D).** Not now. It is section 5 with one
program named, so it costs almost nothing once section 5 exists, and it
is worth waiting to see whether anyone opens a terminal only to type the
same word every time.

## 7. What it needed before it landed

**The `Origin` check, and the token where there is one.** This is the
line above that was wrong, and it was wrong in a way worth writing down:
it said *the token **and** an `Origin` check*, in the class of
`browse_open`. But `browse_open` is reached from the CLI, and this button
is reached from the page — **and the page has no token at all.** Nothing
in `ui/` has ever sent one, because the token exists so that a random
local process cannot inject a document, and putting it into HTML that any
local process can `GET` would be the end of that.

So the gate is `Origin`, with the token accepted beside it for the CLI
and for the tests. That is not the weaker half of what was planned. The
thing the token would defend against here is a local process, which does
not need this endpoint: it can spawn a terminal itself, and a stolen
token is already worth more elsewhere. The thing that actually threatens
a loopback side effect is a page on another origin firing a POST at it,
and `Origin` is exactly the header that says so.

`Origin` rather than `Sec-Fetch-Site`: a browser sets `Origin` on every
POST, same-origin included, and has done for far longer, so a window
whose engine predates fetch metadata still gets a working button. Where
the newer header is there it is read too, and anything but `same-origin`
is refused outright.

**A CI check that it spawns nothing on a headless runner.** It asserts
four responses — no headers at all, a foreign origin, and our own origin
with `Sec-Fetch-Site: cross-site`, all 403; then our own origin, which is
let through and still answers 503, because there is no screen — and then
that no terminal is running. That last one is checked on the process
*name*: the first version used `pgrep -f`, which matched the list of
terminal names where it appears in the checking script's own arguments,
and went red for the wrong reason.

Two unit tests hold the shape of the candidate list: that no candidate
ever passes anything but a flag and the directory, and that a candidate
carrying a flag carries the directory with it. The first is the whole
feature written as an assertion — a candidate that grew an `-e` would be
the executor section 3 declines.

**No new dependency.** None was wanted. The candidate list is the same
shape as `app_mode_browsers`.

## 7a. What it does, as built and measured

The directory is never sent by the page. What the page sends is an id —
a document's, or a browsed root's and a path inside it — and the daemon
resolves the directory itself, so nothing a document contains can reach
one. A path inside a browsed root goes through `Browser::resolve`, the
same guard `browse_file` reads bytes through, so `../../../etc/passwd`
resolves to nothing and the answer is "no folder to open".

Checked against a running daemon, with a stand-in terminal that records
what it was asked:

| | Opens in |
|---|---|
| A document sent by path | the file's own folder |
| A document sent as content, no `source_path` at all | the project's root |
| A browsed root | the root |
| A file inside a browsed root | the folder it is in |
| `../../../etc/passwd` inside a root | nothing: "no folder to open" |

And in every case the recorded argv is **empty**. The directory arrives
as the child's working directory, which is what a terminal with no flag
of its own uses, alongside the flag where one is known.

The page learns whether to draw the button from a `folder` field on the
document, because it cannot work the answer out for itself: it would have
to take the parent of a path on a machine whose separator it does not
know. Where nothing resolves, there is no button.

## 8. Adjacent, and left open

If the underlying want is "act on what this document tells me", the thing
snyvi is uniquely placed to do is not running commands — it is sending a
document *back* to an agent: "continue this plan". That is the one-way
rule as well, but it is the rule's actual subject rather than a side door
into it, and it deserves its own argument rather than a paragraph at the
end of this one. It is not part of this cut.
