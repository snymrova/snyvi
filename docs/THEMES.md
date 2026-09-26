# Themes, and a window that is yours

A plan for going from one light and one dark palette to a small set of
designed ones, and for the other ways a snyvi window can come to feel like
its owner's. Written 2026-09-24 from an audit of the tree on
`claude/desk-notes`.

## Where we are

The appearance of the window is five buttons at the foot of the sidebar:
theme, accent, Aa, width, wrap. Every one of them is a value on `<html>`
(`data-theme`, `data-accent`, `data-font`, `data-wide`, `data-wrap`), set
by `ui/boot.js` before first paint and by `ui/app.js` on a click, kept in
`localStorage` under `snyvi.*`, and read by CSS alone. That shape is right
and this plan keeps it.

The colours are a token system on `:root` in `ui/app.css:13-122`: surfaces,
ink, rules, the accent pair, code, mark, diff, shadow, and ten syntax
tokens. Everything that draws reads those tokens live -- the Mermaid
palette (`ui/mmd.js:302`), the game's sky (`ui/game.js:431`), the favicon
(`ui/app.js:3119`), the terminal's sixteen colours (`ui/desk.js:1426`).
So a new palette is, almost entirely, a new set of values for the same
names. Almost.

What is not right:

1. **The dark palette is written twice.** Once under
   `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
   for "follow the system", once under `:root[data-theme="dark"]` for "you
   chose dark". Twenty-five lines kept in step by hand, and the terminal
   palette in `desk.js` repeats the pattern.
2. **"Is it dark?" is worked out twice** -- `app.js:3031` and
   `mmd.js:287` -- each from the media query and the attribute. A third
   theme breaks both. `game.js:136` does not decide; it subscribes to the
   media query only to know when to repaint, beside an attribute observer
   that already covers a theme set by hand. Once the theme is always an
   attribute, that listener goes.
3. **Changing the accent leaves diagrams in the old accent -- all of
   them.** `setAccent` calls `mmd.retheme()`, but the diagram cache is
   keyed on `light|dark` and the source (`mmd.js:73`), so every diagram
   already drawn comes back from the cache in the accent it was drawn in.
   And `mermaid.initialize` is handed the palette only inside `mmdInit`,
   which returns early when `light|dark` has not moved (`mmd.js:377`), so
   a diagram never drawn before is rendered with the stale accent too.
   The focus node, the notes and the gantt bars are all accent. Nothing
   puts it right until the theme flips.
4. **A chosen theme does not reach the native controls.**
   `<meta name="color-scheme" content="light dark">` follows the OS, and no
   rule sets `color-scheme` on `[data-theme]`, so dark chosen on a light
   system gets light scrollbars, inputs and selects, and the reverse.
5. **Status colours are fixed values, and they fail on both palettes.**
   `#dc2626` (an armed ✕), `#b45309` (blocked), `#16a34a` (running), the
   GitHub alert colours at `app.css:868-872`, and the same three again in
   `desk.js:1480-1535`. Measured (2026-09-24, WCAG ratio against `--bg`;
   `--bg-side` and `--bg-raise` are worse in every row):

   | Colour | On Paper | On Ink |
   |---|---|---|
   | amber `#b45309`, blocked, 11 px bold | 4.77 | **3.54** |
   | red `#dc2626`, armed ✕ | 4.59 | **3.68** |
   | green `#16a34a`, tip title | **3.13** | 5.39 |
   | warning title `#d97706` | **3.03** | 5.58 |
   | note title `#3b82f6` | **3.49** | 4.83 |
   | important title `#9333ea` | 5.11 | **3.30** |

   Eleven-pixel bold is small text under WCAG, so 4.5:1 is the bar, and
   three fail on Ink and three on Paper. So the fix is not a dark set
   beside a light one that was fine; it is both sets, designed. The
   contrast pass in `bench/page.mjs` only looks at diagrams, which is why
   none of this had a number before.
6. Small: the heart `#f0607e` appears in four places with no token; the
   scrim `rgba(20,16,10,.28)` is a warm paper tint used unchanged on dark;
   `app.css:384` raises the note mascot's opacity only for an *explicit*
   light theme, so "light by system" is fainter; `src/prompt.rs:40` says a
   pane is dark either way, and it is not.

## What snyvi believes

Before deciding what to build, what the brainstorm already decided
(`docs/BRAINSTORM.md` §7):

> "Beautiful" is not a theme picked from a list. It is a hundred small
> decisions made on purpose.

> Two palettes, both designed, neither an inversion of the other. [...] One
> light theme, one dark theme, both ours.

And from the accent's own comment in `app.js`: a popover of swatches "is a
menu to read for a setting with no wrong answer", so the button became the
setting. That is the constraint this plan works inside. Themes in snyvi
are not a store. They are a handful, each designed with the same care as
the two we have, each with its own syntax colours and terminal palette so
code and shells look like part of the page. "*n* themes" means four, made
to be right, and a way to add your own if you must -- not a gallery.

## What personalisation is, here

snyvi is for someone with several projects going at once. The window is
open all day. Two things follow.

**The window should be comfortable for the hours it is open.** That is
palette, type, and light. Readers on every device land on the same few
choices -- a warm page for daytime, a dark one for night, a face they
like, a size their eyes want -- and the settings that get used are the ones
that take one gesture. (Kindle's four page colours and the sepia most
readers pick; VS Code's preferred-light and preferred-dark themes, chosen
once and switched by the OS.)

**Projects should be told apart at a glance.** That is the accent, and it
is where snyvi already has something nobody else does: the accent travels
into the shell prompt (`src/prompt.rs`), so a desk's panels are dressed in
the window's colour. Today that colour is the window's. It could be the
desk's.

So the angles, in the order they earn their place:

| Angle | What it is | Cost | Phase |
|---|---|---|---|
| Palette | four designed themes, two light, two dark | medium | 2 |
| Light/dark slots | *your* light and *your* dark, switched by the system or the button | small | 2 |
| Accent | as now, orthogonal to the palette | done | -- |
| Type size | three steps for prose; code keeps its size | small | 3 |
| A desk's colour | a desk wears an accent; its rows, its panels' prompts, its landing wash | medium | 4 |
| Your own palette | a file of tokens in `~/.config/snyvi/themes/` | medium | 5 |
| Time of day | none: the OS switches, and the slots follow it | -- | -- |

Not on the list, on purpose: a theme marketplace, arbitrary CSS injection
into the page, per-document themes, and a settings page. Every setting
stays a button or a palette entry that changes the window under your hand.

## The token contract

A theme is a complete assignment of these names. Nothing draws with any
other colour. The list is what `app.css` has today plus the tokens the
audit found missing.

```
color-scheme                         light | dark   (the one the browser reads)
--bg --bg-side --bg-raise            surfaces
--fg --fg-2 --fg-3                   ink, three weights
--rule --rule-2                      hairlines
--accent                             light-dark(var(--accent-l), var(--accent-d)): the half this theme wears, by its color-scheme
--accent-bg                          the accent's wash on this surface
--code-bg --mark                     code ground, highlighter
--add --add-fg --del --del-fg        diff
--shadow --scrim                     depth, and the dim behind a dialog
--ok --warn --danger --info          running, blocked, armed, note   (new)
--important                          the fifth alert, GitHub's purple  (new)
--heart                              the mascot's blush                (new)
--mascot-peek                        how far the note mascot comes forward, hovered (a number, not a colour)
--s-comment … --s-attr               ten syntax tokens
--t0 … --t15                         the terminal's sixteen
```

Paper is the base: its values sit on `:root` itself, and every other
theme is a block of overrides on it. That is also the fallback -- boot.js
sets `data-theme` before the sheet applies, but a page whose storage
cannot be read still has a theme, and it is Paper.

Two decisions inside that list:

- **The accent stays a separate axis.** A theme does not say which half
  of the pair it wears; its `color-scheme` does. `--accent` is declared
  once as `light-dark(var(--accent-l), var(--accent-d))` and each theme's
  `color-scheme` picks the half, so the `--accent: var(--accent-d)` line
  leaves every dark block. Four themes × eight accents is thirty-two
  windows, all designed, because each accent already carries a light and
  a dark variant tuned to sit on paper or on ink. A theme that wants its
  own default accent (a sepia page reads better with a warmer red) sets
  `--accent-l`/`--accent-d` as defaults that a chosen accent overrides --
  the cascade does this for free if the theme block comes before the
  accent blocks.
- **The derived tokens live in one shared rule.** `--accent`,
  `--accent-bg`, `--mascot-ink` and `--s-keyword` are derived from the
  pair with `var()`, and a `var()` in a custom property resolves on the
  element that declares it. Today they are declared on `:root`, so the
  resolved colour is what inherits, and re-declaring `--accent-l` lower
  down changes nothing beneath it. They move to one rule that matches
  every element allowed to wear an accent -- `:root` today, a desk and
  its sidebar row in phase 4 -- so that scoping an accent is scoping the
  pair. This is the one structural change the contract asks of `app.css`.
- **Status colours become tokens.** `--ok`, `--warn`, `--danger`, `--info`
  and the five alert colours are set per theme, and both of the sets we
  have today are redesigned, since neither passes (item 5). That is also
  what makes a theme a theme: a dark palette gets a blocked-amber that is
  legible at 11 px on its own ground.

Each theme is one CSS block, `:root[data-theme="name"] { … }`, about 60
lines once the status and terminal tokens are in it. Measured on the
current dark block, which has neither: 856 B raw, 385 B gzipped. Four
themes cost under 2 KB gzipped against the 60 KB budget in the
brainstorm; `bench/bytes.mjs` will say the real number.

### The themes

Eight, to match the eight accents: four light, four dark. Every one
designed, not derived. (Four until round 2, 2026-09-25; see Decided.)

| Name | Ground | For |
|---|---|---|
| **Paper** | the warm near-white we have | daytime; the default light |
| **Snow** | a cool near-white, blue-grey ink | a bright screen that should not look warm |
| **Sage** | a soft green-grey, pale enough for every accent | a long day |
| **Parchment** | a sepia page, ink slightly brown, accents warmed | long reads, a bright room in the evening |
| **Ink** | the deep grey-blue we have | night; the default dark |
| **Midnight** | deep navy | a dark theme with a colour to it |
| **Espresso** | warm brown-black | the dark side of Parchment |
| **Contrast** | white on black, 7:1 everywhere, rules at full weight, no faint washes | `prefers-contrast: more`, a dark room, and anyone who wants it |

Contrast keeps `--accent-bg`. The wash is the on-state of tabs, panes,
desk rows and dividers (`desk.js:1451,1472,1524,1567`), and taking it
away would mean giving each of those a treatment of its own in the
components, which is no longer a theme. So "no washes" means no faint
ones: Contrast's wash is the accent mixed strongly enough to read as a
block, with its ink still 7:1 on it, and the theme stays one CSS block.

Contrast is a dark theme. A light one at 7:1 is Paper with its ink
darkened, which is a change to Paper's `--fg-2`/`--fg-3` under
`prefers-contrast: more` rather than a fifth theme; it goes in the same
phase as a media rule, not a name.

Each needs its own syntax ten and terminal sixteen. That is the work: four
palettes × 26 colours, measured for contrast on their own grounds. The
`bench/page.mjs` diagram pass already computes ratios; it grows a table.

Considered and left out: a cooler grey paper (Bone) and a near-black
OLED dark (Pitch). Both are a temperature shift of a theme we have, and a
temperature shift is what the accent and Parchment already give.

Not in the four, and why: Solarized, Gruvbox, Catppuccin, Rosé Pine.
They are good and people love them, but they are someone else's hundred
decisions. They belong in phase 5, as files you drop in, and the terminal
sixteen can be imported from the iTerm2 scheme collection Ghostty draws
from.

## Architecture

### 1. Resolve the theme in one place, before paint

`boot.js` already runs before first paint. It grows from one key to three:

```
snyvi.theme.light   "paper" | "parchment"                 default paper
snyvi.theme.dark    "ink" | "contrast"                     default ink
snyvi.theme.follow  "" (the system) | "light" | "dark"     default ""
```

and always sets a concrete `data-theme`. The media query is consulted in
JS, once, and again on `change`. That removes both doubled dark blocks
(app.css and desk.js), the `:not([data-theme="light"])` selectors, and
audit item 6's opacity split. Migration: an old `snyvi.theme` of `"dark"`
or `"light"` becomes `snyvi.theme.follow` and is deleted; a page that
never chose keeps following the system.

Contrast is a theme in the dark slot rather than a fourth key, because
`prefers-contrast: more` is a system signal like `prefers-color-scheme`,
and boot.js can honour it the same way: if the user has not chosen the
dark slot, and the system asks for contrast, the slot's default is
Contrast. VS Code keeps four preferred themes for the same four signals;
two slots plus the contrast signal covers it without a fourth button.

### 2. One answer to "is it dark?"

```js
const isDark = () => getComputedStyle(root).colorScheme === "dark";
```

Each theme block sets `color-scheme`, which is the fix for audit item 4
and also the fact the three call sites need. `app.js`, `mmd.js` and
`game.js` call the one exported function. Mermaid still needs `darkMode`
for its own defaults; it gets it from here.

### 3. The diagram cache learns the whole look

`mmdKey` becomes `${theme}|${accent}\n${source}` and `mmdInit` compares
the same string, so a swatch click re-initialises Mermaid as well as
missing the cache -- both halves of audit item 3. Toggling back to a look
already drawn stays free, as the comment at `mmd.js:178` promises. The
byte bound already keeps holding several looks from mattering.

### 4. The terminal palette moves into the theme

`desk.js:1426-1433` stops carrying colours. Each theme block sets
`--t0…--t15`; `desk.js` keeps `--pn-bg`/`--pn-fg` as aliases of `--bg-raise`
and `--fg`. `src/prompt.rs` keeps its fallback but the comment is fixed:
a pane wears the window's theme.

### 5. The button, and the palette

The sun/moon keeps flipping between your light and your dark; one click,
one visible change, as now. Choosing *which* light and *which* dark is a
choice with no wrong answer and only four answers, and the rule is that
you have to see it on the page. So:

- `⌘K`, type `theme` (or `th`): the four appear as rows, the current one
  marked, each row's name set in its own ground and ink so the list is
  its own swatch. Moving the highlight applies the theme to the window
  behind the palette. Enter keeps it and stores it in the slot that
  matches its `color-scheme`; Esc puts the window back. This is the accent
  button's "see it on the page" without a menu to read, because the page
  *is* the preview. For that to be true the scrim has to go: the palette
  dims the page behind it (`app.css:1279`), and a theme seen through a
  dim is not the theme. While the rows are theme rows the palette drops
  its scrim and keeps its box.
- The theme button's tooltip names both slots: `Paper · Ink (system)`.
- The about panel, which already lists what is kept, lists the three keys.

No new button. The foot of the sidebar stays at five.

### 6. A desk's colour (phase 4) -- dropped

**Dropped 2026-09-25**: the theme and accent buttons already do this job.
Kept below as it was written, for the reasoning.

A desk gains an optional `accent` in `src/desk.rs`, one of the eight
names, a column on the desks table, sent in the desk's JSON. It is set
from the swatch and nowhere else: while a desk is open, the swatch's
click steps that desk's colour, and the toast says so (`Accent · Teal,
for this desk`); off a desk it steps the window's, as now. The swatch
itself shows the colour in force where you are, so on a desk it is the
desk's. A desk with no colour of its own shows the window's, and a desk
stepped all the way round lands back on "the window's" rather than on
passion, so there is a way home. It scopes, it does not repaint: the
desk view and the desk's sidebar row carry `data-accent`, the accent
blocks match `[data-accent="teal"]` on any of them rather than on `:root`
alone, and the shared derivation rule from the contract (`--accent`,
`--accent-bg`, `--mascot-ink`, `--s-keyword`) matches them too, so the
pair set on a desk resolves *on the desk*. Setting the pair alone would
not do it: `--accent` as declared on `:root` today is already a colour by
the time it inherits. The desk's row wears a dot of it, and a panel
started under it is dressed in it: the prompt already takes the accent at
start (`pane.rs:511`), but the window reads it off `documentElement`
(`desk.js:518`), and that read moves to the desk element. Documents filed
to the desk carry its colour on their landing wash. The window's own
accent is unchanged elsewhere, so switching desks is not a flash.

This is the angle worth the most and it is the one that is snyvi's alone.
It is last of the built-in phases only because it stands on the shared
derivation rule from phase 2.

### 7. Your own palette (phase 5) -- dropped

**Dropped 2026-09-25**, with phase 4, for the same reason.

A file at `~/.config/snyvi/themes/<name>.css` holding one
`:root[data-theme="<name>"]` block. The daemon lists the directory at
start and on `snyvi restart` (there is no reload; a watcher can come
later if anyone edits a theme often enough to want one), serves each as
`/assets/themes/<name>.css`, and the page links them after `app.css`.
Validation is a token check on names *and values*: a block missing any
name from the contract is served with the missing names filled from
Paper or Ink by its `color-scheme`, and the about panel says which were
filled; a value that does not parse as a colour (or `light` | `dark` for
`color-scheme`) is dropped and filled the same way, because a custom
property can hold `url(…)` and `background: var(--bg)` would fetch it.
Nothing but custom properties on `:root` is honoured -- the file is
read, the declarations copied out, the rest dropped -- so this is a
palette, not a stylesheet. A `snyvi theme import
<scheme>` for iTerm2/Ghostty files can build the terminal sixteen and
derive the UI tokens from the scheme's background and foreground with
OKLCH relative colours (`oklch(from var(--bg) calc(l + .04) c h)`),
which every browser snyvi runs in now supports. That gets Solarized and
friends in a command, at the quality of a derivation, which is the right
tier for a palette we did not design.

## Phases

Each phase is one PR, each lands on its own, and every one leaves the
window working. Sizes are in working days for one person with an agent.

**Phase 0 -- the four fixes.** ½ day. Independent of everything else.
- `color-scheme` set on `[data-theme]`; `--danger --warn --ok --info
  --heart --scrim` tokens, with a light set and a dark set both brought
  to 4.5:1 on every surface they sit on; the diagram cache and
  `mmdInit` keyed on accent; the note mascot's opacity keyed on the
  computed scheme. The contrast pass in `bench/page.mjs` extends to the
  sidebar's status glyphs and the alert titles, and fails the build
  under 4.5:1, so item 5 stays fixed.

**Phase 1 -- one dark block.** ½ day.
- `boot.js` resolves the theme and always sets `data-theme`; the media
  block and the `:not([data-theme="light"])` selectors go; `isDark()`
  exported once; terminal palette moves into the theme block; migration
  of the old key. No visible change. The `server.rs` test that checks
  boot.js and app.js agree on keys grows the three new names, spelled
  out in full: it is a substring check, and `snyvi.theme` would go on
  passing on the strength of `snyvi.theme.light` without them.

**Phase 2 -- the four themes and the palette entry.** 2 days, most of it
colour.
- Token contract finished (`light-dark()` accent, the shared derivation
  rule, alerts). Parchment and Contrast
  designed and measured; Paper's `prefers-contrast` rule. `⌘K theme`
  with live preview. Tooltip,
  about panel, GUIDE §Appearance rewritten. `bench/page.mjs` runs its
  diagram contrast pass per theme; `bench/bytes.mjs` records the cost.
  The README's light/dark screenshots stay as they are; a Parchment shot
  goes in the GUIDE.

**Phase 3 -- type size.** ½ day.
- `snyvi.size` in `{s, "", l}` → `data-size`; a step is a scale on the
  face's own size, not a fixed pixel ladder, because the faces already
  differ (prose 17 px, serif 18, mono 15 at `app.css:779-781`) and a flat
  15/17/19 would shrink serif and grow mono at the same step. Line-height
  follows; code unchanged. Shares the Aa button by a modifier, or a `⌘K
  size` entry -- try both, keep one.

**Phase 4 -- a desk's colour.** Dropped 2026-09-25.
- `desk.rs` column, JSON, the swatch's desk mode and its toast, the
  accent blocks widened to the desk and its row, the sidebar dot, the
  panel's prompt read off the desk, the landing wash.
  DESK.md's accent section updated. A bench row: switching desks does not
  repaint the chrome.

**Phase 5 -- your own palette.** Dropped 2026-09-25.
- Directory served, name and value validation with fill, about panel
  listing, the import command. Docs: a page in the GUIDE with the contract as a table
  and Paper's block as the example to copy.

Phases 3, 4 and 5 are each optional and independent once 2 is in.

## Measured, or it did not happen

- Every theme: every syntax token, status token and terminal colour ≥ 4.5:1
  on every surface it is drawn on (`--bg`, `--bg-side`, `--bg-raise`,
  `--code-bg`); Contrast ≥ 7:1. Printed by `bench/page.mjs` as a table,
  one row per theme, and the build fails on a miss.
- Theme change: no diagram re-rendered that was drawn before in the same
  theme and accent (the cache pass in `bench/page.mjs` already counts).
  Accent change: the next diagram drawn is in the new accent, which is
  the half of item 3 the cache count cannot see.
- Desk colour: a desk with an accent starts its panels with that accent in
  the start request, not the window's, and switching desks does not
  repaint the chrome.
- First paint: no flash of the wrong theme -- boot.js sets `data-theme`
  before the stylesheet applies, as today; the bench's cold-start row is
  unchanged.
- Bytes: first paint carries Paper and Ink only and stays under its
  50 KB budget; the other six are `themes.css`, with a limit of its own
  in `bench/bytes.mjs`.
- First frame: reloaded on each of the eight, with its saved copy and
  without, the first frame is that theme (or, without a copy, Paper or
  Ink by side) and never another.
- Keys: `server.rs` test that every `snyvi.*` key app.js writes, boot.js
  reads, each of the three theme keys named in full.

## Decided

- Four themes: Paper, Parchment, Ink, Contrast. (2026-09-24)
- The accent's half is chosen by `light-dark()` and `color-scheme`, not
  by a token a theme sets; the derived accent tokens live in one rule
  shared by everything that can wear an accent. (2026-09-24, audit)
- Contrast keeps a wash, a strong one; the on-states stay tokens.
  (2026-09-24, audit)
- A desk's colour is set from the swatch only, no palette entry, no
  modifier: on a desk the swatch is the desk's. (2026-09-24)
- Phases 0 and 1 built together, since a `color-scheme` per theme block
  and one dark block are the same edit. The themes are named now --
  `data-theme` is `paper` or `ink` -- and the button's tooltip and toast
  say the name. The status set on each palette, measured: Paper
  `#177a3a #9a4505 #b3261e #1e5fd0 #7c3aed`, Ink `#5bd984 #e6a23c #f87171
  #7aa2f7 #c084fc`, every one ≥ 4.5:1 on all four surfaces, printed by
  `bench/browser.mjs` as a row per theme. The `light-dark()` accent came
  forward from phase 2: the desktop's WebKitGTK is 2.52 and every browser
  snyvi runs in has it. (2026-09-24, build)

- Phase 2 built 2026-09-24. Parchment `#f3e9d2` on brown ink `#3b2f1e`
  with a warmer default red `#93301a`; Contrast on `#000` with its
  surfaces at `#070707 #0f0f0f #0c0c0c`, rules `#4a4a4a #6e6e6e`, and the
  default red lifted to `#f97e92` for 7:1 -- the seven chosen accents
  already clear it on every surface. Contrast's one wash is 22% of the
  accent and holds 4.5:1 with the accent as its ink: an accent at 7:1 on
  black cannot also be 7:1 on a wash of itself, and the on-state's ink is
  the accent, so that pair is AA and every text colour is AAA. The
  measured set grew from the five status tokens to every colour a theme
  draws text in -- status, the accent, the syntax ten, the terminal
  sixteen less black and white -- on all four surfaces, which sent
  Paper's comment `#8a8378` to `#736c61`, Ink's to 55% white, both
  themes' bright terminal colours darker, and Ink's bright black to
  `#8b93a3`: the invisible dark grey a `git status` is printed in. The
  theme blocks match `[data-theme]` rather than `:root[data-theme]`, so
  a ⌘K row wears the theme it names by carrying the attribute, and the
  derivation rule is `:root, [data-theme]`; phase 4 adds its selector
  there. Room for it: the shortcuts card's rows and the connect page's
  rules moved to the about chunk, since neither is on the way to reading
  a document, and first paint stayed under 50 KB. (2026-09-24, build)

- The theme button steps through all four, as the accent swatch steps
  through its colours, instead of flipping between the two slots. In
  review the flip read as "there are only two themes": the palette rows
  were the only way to Parchment and Contrast, and nothing on the button
  said so. Each click keeps its theme exactly as a palette pick does, in
  the slot of its side, so the system switching light and dark still
  moves between your two. The icon is the side a click lands on; the
  tooltip is `Theme: Paper · click for Parchment`. (2026-09-25, review)

- Round 2, 2026-09-25. Phases 4 and 5 are dropped: the theme and
  accent buttons do their job. Eight themes to match the eight accents:
  Snow, Sage, Midnight and Espresso join the four. Snow is the "cooler
  grey paper" left out above; with eight accents to match it earns its
  place. First paint was 10 B under its budget, so it now carries only
  Paper and Ink and the shared rule; the other six are `themes.css`,
  fetched when the page is idle. A returning reader's theme is painted
  from a copy of its block the app keeps per slot
  (`snyvi.theme.css.light`, `.dark`), written as `:root[data-theme=…]`
  so it outranks Paper's `:root` from boot.js, before app.css is linked.
  The copy is checked by arriving, not by a hash: when `themes.css`
  lands the copy steps aside and a fresh one is written, so a copy
  lasts exactly as long as its theme's colours, and a changed theme is
  one quiet step from its old colours to its new ones rather than a
  flash of Paper. (2026-09-25)
- Every accent on every theme, not the default alone, is measured. That
  found Paper's green at 4.44:1 on the sidebar and Parchment's violet,
  teal and green under 4.5:1 -- there all along, since the bench only
  read the default. Green's light half is `#137639` (was `#15803d`), and
  a theme can pull every accent towards black (`--deepen`) or white
  (`--lift`) to hold the bar on its own ground: Parchment deepens 8%,
  Contrast lifts 4% for crimson's 7:1. (2026-09-25)
- Aa on a desk is the terminal's text size -- Small 11.5/15, Normal
  12.5/16, Large 14/18, Larger 15.5/20 -- one size for every desk, in
  `snyvi.term-size`. `⌃=` `⌃-` `⌃0` in a panel, as GNOME Terminal does
  it; `⌃-` had sent `^_`, readline's undo, which stays on `⌃_`.
  (2026-09-25)
- Every control either works in a view or is faded with a reason; one
  table in app.js (`why`) answers for the column and for `w` and `z`.
  (2026-09-25)
- First paint came out 685 B over its budget with this round in it: the
  two themes it gave back were worth less than the controls table and the
  theme loader it gained. ⌘K moved to a chunk, `ui/palette.js`, fetched on
  the first ⌘K like find on the first `/`; the page puts the box up at once
  and the chunk searches whatever was typed while it came. First paint is
  49.2 KB of 50. (2026-09-25, build)
- A panel keeps its scrollbar's room (`scrollbar-gutter: stable`). Found by
  the text-size rows: a panel whose output first overflowed grew a
  scrollbar, lost a column, was resized and cleared, and a busy program
  kept that going every frame. (2026-09-25, build)

## Open questions

None open.

## Sources

- [VS Code: themes, `autoDetectColorScheme` and preferred light/dark themes](https://code.visualstudio.com/docs/configure/themes)
- [web.dev: colour themes with Baseline CSS features (`color-scheme`, `light-dark()`)](https://web.dev/articles/baseline-in-action-color-theme)
- [CSS relative colours and OKLCH ramps](https://ishadeed.com/article/css-relative-colors/)
- [Zed: user themes as a JSON file in `~/.config`](https://zed.dev/docs/themes)
- [Ghostty: theme files anywhere on disk, sourced from iTerm2 schemes](https://ghostty.org/docs/features/theme)
- [Kindle's page colours and what readers change](https://www.xda-developers.com/these-kindle-settings-transform-how-the-device-actually-feels-to-use/)
