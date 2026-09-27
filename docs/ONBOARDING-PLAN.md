# Onboarding: a desk for each passion project

*Plan, 2026-09-27. Built from two research passes, an outside survey of how other tools onboard and a code walk of 1.7.1's first run, plus this morning's audit (4e31f7f47d).*

## The test

> The first ten minutes end with two of their projects, each on its own desk, with Claude running in it, and one document from Claude that stayed.

Today that does not happen. A fresh window opens on **Connect an agent**: eight agents, three instructions each, and grey "not set up" dots that read as failures. The sidebar offers three more starts (`snyvi send README.md`, "read a folder", "Put a project on a desk"), and an aside describes a desk that does not exist yet. Nothing says what snyvi is for.

The story is already written in the README and the film: *more passion projects than hours; the work scatters; one desk for each project, nothing scrolls away, out of your head, just as you left it.* Onboarding should tell that story by doing it, on the user's own projects.

**The rule for every screen:** is this about their project, or about our plumbing?

## What the research says

| Finding | Evidence | What we take from it |
|---|---|---|
| Developer tools open on a project picker | VS Code *Open Folder*, JetBrains, Obsidian vaults, Zed launchpad, Conductor *Add Repository* (which makes the workspace) | The first screen is *What are you working on?*, with one action. |
| One goal question lifts starts, even with no personalization behind it | Headspace: 31% → 63% course starts from a short quiz; Canva +10% activation from goal routing; keep it to two questions or fewer (Chameleon) | Ask one question. Its answer is the folder. |
| Gates before value cost users | Duolingo moved sign-up later: +20% DAU. Warp dropped its login after complaints. Arc was criticized for forcing an account. | Connecting Claude comes *after* the first desk exists, inside it. |
| An integration is confirmed by waiting for the first real event | Sentry "waiting for your first event", PostHog's live check, Segment's debugger; Claude Code: "Added" ≠ "Connected" | snyvi sees both halves: hooks fire, then `send_document` arrives. Show both, live. |
| Tours fail; teach in context, at the moment it matters | NN/g on push vs pull help; tours of 7+ steps finish 16%, time-triggered ones 31%; half of modals dismissed | No tour, no coach marks. This matches ROADMAP's rule: "not a tour, coach marks, a checklist that persists". |
| Empty states are where teaching belongs | NN/g: say the status, give a cue, give one direct action | Every empty surface gets one sentence and one button. |
| Onboarding can be skipped and reopened | Raycast *Show Onboarding*, Zed's persistent Welcome, Things' *Create Tutorial Project* | *Welcome* stays in Help and the palette. |
| Real data over fake data | Sample data confuses unless it is walled off (GitHub Desktop's tutorial repo, Obsidian's sandbox) | No demo desks. The user's own folder from the first click. |

No published data covers the second-project moment. Our reasoning: snyvi's value across projects (which desk is working, which is waiting on you) exists only once two desks do. So the plan asks for the second project on purpose rather than waiting for the user to find it.

## The arc

```
 install ─▶ window opens ─▶ ① What are you working on? ─▶ ② its desk ─▶ ③ Claude in it
                                                                           │
            ⑥ everything else, when it matters ◀─ ⑤ another project ◀─ ④ first document
```

### ① Welcome: one question

This replaces Connect as the empty landing page. It shows in the window while there are no desks, and it can be reopened from Help → *Welcome* and from `⌘K > Welcome`.

```
                          (mascot)

        All your passion projects, in one calm place.

   More projects than hours? Give each one a desk: its folder,
   its agents side by side, and everything they write kept.

   What are you working on?

   [  Choose its folder…  ]

   Or one snyvi already knows:          ← only if there are any
     ◻ tin-can-radio   ~/Projects/tin-can-radio
     ◻ garden-planner  ~/code/garden-planner

   Just reading? How snyvi works →
```

- **Choose its folder…** opens the native picker (`pick(ctx, true)` already exists). snyvi never looks through folders.
- The *knows* list is `deskPlaces()`: Inbox projects and open Folders. It is empty on a true first run, and the heading goes with it.
- In a browser tab there are no desks, so the page says one line, "Desks live in the window: `snyvi app`", and keeps the reading path.
- Nothing about agents is on this page.

### ② The first desk opens at once

The choice makes the desk: `POST /api/desks {root}` → a desk named after the folder, then the desk itself. It needs no second click and no menu.

The rail's **Notes** opens with its field focused and a new placeholder: *"What's the status of this project?"* This is the optional second question, and it is the *out of your head* beat in minute one. Esc or leaving the field skips it. An empty field writes nothing.

### ③ Claude, ready in the first panel (P4)

The first panel is created but **not started**. Its start form is filled in:

```
┌ Panel 1 ─────────────────────────────── ○ ready ┐
│                                                 │
│   ▸ claude                        [Enter] Start │
│     or blank for the shell                      │
└─────────────────────────────────────────────────┘
```

- This keeps DESK.md premise 3: nothing is typed into a shell without the reader's key. Enter starts it.
- `claude` is prefilled only when it is on PATH. Otherwise the form is blank and a small line reads *"Claude Code isn't installed: claude.com/code"*.
- `menu.js make()` stops calling `start {cmd:""}` for the first panel of a desk made from Welcome. Later panels keep today's behaviour.

**Connecting happens here, only if it is needed.** If the Claude Code registration (`agents.rs`) is missing, the panel shows one strip above the form:

```
  snyvi isn't connected to Claude Code yet.  [ Connect ]
```

- **Connect** runs the daemon's own `init-claude --auto` for `current_exe`, after bind, the same rule as the other auto-writes (see never-write-hooks-for-another-binary). The strip turns into *"Connected. Start Claude to try it."* and fades.
- It needs a new route, `POST /api/agents/claude/connect`, behind the capability. It reuses `setup.rs` and returns the same status the Connect page reads.
- The **Claude is live** proof comes from a hook: the first hook event from a panel on this desk flips the panel's state to `● working`. That already exists. The first time it happens on any desk, the panel head says once, in place, *"Claude is connected here."*

### ④ The first document is the proof

While the desk has no documents, its Documents rail is a live waiting state instead of "Nothing yet":

```
  Documents
  ◌ Waiting for the first one…
    Ask Claude:  "Plan what's next here and send it to snyvi"  [Copy]
```

- **Copy** puts the sentence on the clipboard and says *copied* in place (feedback goes where the click was).
- When a document arrives from this desk, the waiting line becomes its row. The document opens over the desk, as a desk's documents do now. The aside rewritten from `first-doc` reads: *"Your first document from tin-can-radio. It stays with this desk: nothing scrolls away."*
- If nothing arrives five minutes after a hook event, the line adds: *"Nothing yet? A Claude session started before snyvi was connected can't see it. Start a new one."* This is the stale-session case the research flags.

### ⑤ The second project, on purpose

Once the first desk has had a document, or Claude has run in it:

- The Desks section's empty space holds one row: **+ Another project**. It goes straight to Welcome's picker, and the *knows* list now has whatever the first agent's work taught snyvi.
- A new aside, `second-desk`: *"Got another one? Give it a desk too. ⌘K and its name goes between them."*
- After the second desk, `two-desks`: *"Two desks. Each keeps its panels, notes and documents just as you left it. An amber row is one waiting on you."*

That is the end of onboarding. No checklist, no progress bar, and nothing that persists.

### ⑥ Everything else waits until it matters

| Today | Becomes |
|---|---|
| Connect an agent as the landing page, with 8 agents | **Agents**, in Help and the palette only. Claude Code first. The others fold under *"Using a different agent?"*. "connected" and "online" become **Set up** and **Running now**, so a new user never sees *connected* next to *0 · No agent is connected*. The CLAUDE.md nudge is hidden when the `--auto` hooks are there, since they already send what Claude writes. |
| Inbox empty: "Send something: `snyvi send README.md`…" | "What your agents write lands here, filed by project." The CLI line moves to Agents → *By hand*. |
| Desks empty: "Put a project on a desk" (a menu with only *Another folder…* on day one) | **Give a project a desk**, which opens the picker directly when snyvi knows no projects. |
| Folders: "Read a folder as it is on disk" | "Open a folder to read" |
| `first-desk` aside: "up to four terminals… ⌃\` goes between…" | Removed. Welcome and ③ say it by doing it. |
| `/start`, "The first ten minutes": documents first, desks 4th (P5) | **How snyvi works**, in the story's order: A desk for each project → Out of your head (notes) → Nothing scrolls away (documents, waiting, versions) → Just as you left it (restarts, switching) → Keys. |
| Project row desk glyph: shown on hover only | Always shown, dim, while the project has no desk. |

## Fixes found on the way

1. **Asides are lost for good** when throttled. `snyviSays` returns before it sets `seen`, and `first-desk` and `first-doc` fire only at one moment each. Queue them instead: a held aside waits for the 600 s gap and the unread-agent-aside rule, then shows once (`app.js:1671`).
2. **`first-doc` never fires in the desk-first flow.** It needs `opens` and the inbox view. Key it on the library's first document, whichever view is showing.
3. **B3:** the arrival toast covers the page title (`app.js:3003`). Offset it below the title bar.
4. **Desk-to-project matching is by exact string** (`x.root === p.root`). Compare canonical paths so a desk made on the same folder lights the project's glyph.
5. **macOS never gets "Open the window now?"** (`install.sh:410`). Detect the app bundle.

## Command line (P7)

- **install.sh's last lines** lead with the window and the story:
  ```
  snyvi 1.x is in ~/.local/bin, and updates itself from now on.
    snyvi app        open the window, and give your first project a desk
    snyvi status     what is running, what is registered
  ```
  `snyvi send` moves to the guide.
- **init-claude's *Try it*** now says: *"Open the window (`snyvi app`), give a project a desk, and run claude there. What it writes lands beside it."* The restart line stays, since it is the stale-session truth.

## How we know it worked

- A new `bench/ui.mjs` section, `firstRunRows`, on a fresh profile with a stub `claude` on PATH and a stub folder picker:
  - the empty window shows Welcome, not Connect;
  - it takes **3 clicks** from Welcome to a project desk with `claude` running (choose folder, pick it, Enter). The audit measured about 5, and targeted 3;
  - Connect in the panel registers the stub and flips to *Connected*;
  - a document sent from the panel replaces the waiting line;
  - + Another project to a second desk takes 3 more clicks, and the `second-desk` and `two-desks` asides show, once each, never both at once;
  - a held aside shows later instead of vanishing (fix 1).
- Update the existing `connectRows`, `startRows` and `asideRows` to the new copy and order.
- First paint stays under **52 KB**. Welcome lives in `about.js`, a chunk, and the landing view is chosen by a flag in the boot data.

## Where it lands in the code

| Part | Files |
|---|---|
| Welcome, Agents, How snyvi works | `ui/about.js` (Welcome view, Connect → Agents, `/start` reorder), `src/server.rs` `shell_home` (boot `view: "welcome"` when the window has no desks) |
| Landing, sidebar copy, asides | `ui/app.js` (empty states, `snyviSays` queue, new aside ids, first-doc trigger), `ui/index.html` (Help: Welcome, Agents) |
| First desk, first panel, rail | `ui/menu.js` (`make` with a prefilled, unstarted first panel), `ui/desk.js` (start form prefill, Connect strip, waiting rail, notes placeholder, *connected here*) |
| Connect from the window | `src/server.rs` (`POST /api/agents/claude/connect`), `src/setup.rs` (init as a function returning status), `src/agents.rs` (`claude` on PATH) |
| CLI | `install.sh`, `src/setup.rs` |
| Proof | `bench/ui.mjs`, `bench/onboarding.sh`, `docs/GUIDE.md`, `docs/DESK.md`, `docs/ROADMAP.md` |

## Order of work

1. **The arc, ①–⑤**, including fixes 1 and 2, since the asides depend on them.
2. **⑥ the tidy-up:** Agents, empty states, How snyvi works.
3. **CLI lines** and fixes 3–5.
4. **Bench rows and docs**, then one full pass in `~/Projects/snyvi-check`.

## Decided (2026-09-27)

1. **Release:** it all goes out in 1.7.1, one push with everything else.
2. **Connect from the window** asks first. A confirm step says what it writes (the MCP entry and hooks in `~/.claude`, for this binary) before anything is written.
3. **The notes question** is *"What's the status of this project?"*.
4. **Other agents:** minimal. They appear only on the Agents page, under *Using a different agent?*, with no link on Welcome.
