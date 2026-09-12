# Diagrams: where the time goes, how they look, and the plan

Written 2026-09-12, after a report that a page with a big Mermaid diagram
takes seconds to open. Everything in section 1 is measured on this
machine under headless Chromium, not estimated.

**Status.** Phases 1, 2a and 8 (section 9's theming) have landed, along with
the find fix and the parse-error fix from the small list. The harness that took
section 1's numbers is now `bench/browser.mjs`, runs in CI, and section 7
records what it measures. Phases 3, 4 and 2b are still ahead.

Sections 1 to 8 are about time. Section 9 is about the other half of the
roadmap's test — whether a diagram looks like it belongs in the document
around it — and was measured the same way.

## 1. What is actually slow

| What | Measured |
|---|---|
| Server TTFB, 1.25 MB Markdown document | 2–29 ms |
| First contentful paint, document with two diagrams | 144 ms |
| First contentful paint, 1.25 MB Markdown, no diagrams | 116 ms |
| Longest frozen frame, 1.25 MB Markdown, no diagrams | 128 ms |
| `mermaid.js` transfer (975 KB gzip, localhost) | 79 ms |
| `mermaid.js` parse and compile (3.57 MB of JS) | 523 ms |
| `mermaid.initialize` | 5 ms |
| One 3-node flowchart, first render / later renders | 73 / 37 ms |
| One 220-node flowchart | 2433 ms |
| **Longest frozen frame on that page** | **3123 ms** |
| The same document, revisited in the same tab | 2426 ms again |
| That diagram's natural width, and the width it is shown at | 4738 px shown at 630 px — 13% |

The server is not the problem. Markdown is not the problem. The network
is not the problem. One synchronous JavaScript task is: for 3.1 seconds
the page does not scroll, does not answer a key, does not repaint, and
shows the reader a wall of grey `flowchart TD n0[...]` source while it
works.

## 2. The five faults behind that number

1. **It blocks.** `mermaid.run({ nodes })` renders every diagram on the
   page in one unyielding task. Nothing else can happen until it ends.
2. **It is eager.** Every diagram renders, on screen or not. A plan with
   eight diagrams pays for eight before the reader sees the first.
3. **It is uncached.** 2426 ms again on a revisit in the same tab. The
   document is immutable and the answer was already computed; it is
   thrown away.
4. **It is unreadable.** A 4738 px graph is squeezed into the 630 px
   reading column with no zoom, no pan and no fullscreen. The one
   diagram big enough to be worth drawing is the one you cannot read.
5. **It is silent.** No placeholder, no progress, no reserved space —
   just raw source, then a jump.

Five smaller faults found on the way:

- **The theme toggle leaves diagrams behind.** `initialize` runs per
  render call, so an already-drawn SVG keeps the theme it was drawn in.
  Switch to dark and the diagrams stay light.
- **Find hides what it finds.** `runFind` walks every text node under
  `#doc`, including the SVG's. In a sequence diagram all 11 matches
  landed inside `<text>`, where an HTML `<mark>` renders at 0×0 — so the
  matched label *disappears from the diagram*, and the counter counts
  matches nobody can see. Flowchart labels survive (they are
  `foreignObject` HTML) but at 13% scale a match is a 2.6 px smudge that
  `gotoFind` dutifully scrolls to.
- **A parse error eats the source.** The `<pre>` is replaced by Mermaid's
  error graphic, so a reader cannot see or copy what the agent got
  wrong — which is exactly the moment they want to.
- **`snyvi watch` re-renders everything on every save.** `refreshDoc`
  replaces the body, so a file saved every few seconds pays the full
  diagram cost every few seconds.
- **The first diagram in a tab pays the 523 ms parse on the critical
  path.** Nothing prefetches the library.

## 3. The plan

Four phases, cheapest first. Phase 1 is the one the reader feels.

### Phase 1 — never block the reader — **done**

Replace the single `mermaid.run` with a scheduler.

- **Reserve the space first.** Each `pre.mermaid` becomes a placeholder
  box of an estimated height, so the page does not jump when the SVG
  lands. *Built without the server-side size hint this asked for: the
  client already holds the source as text, and counting its lines is
  microseconds, so a hint in `render.rs` would have bought a change to the
  renderer and its tests and nothing measurable. The estimate is weak
  either way — the source says how much there is to draw, never how tall
  the drawing will be. Phase 3 is what makes it exact.*
- **Render only what is near the viewport.** An `IntersectionObserver`
  with a generous `rootMargin` queues a diagram as it approaches. Eight
  diagrams become one.
- **One diagram per task, yielding between.** `scheduler.yield()` where
  it exists, a `setTimeout` turn otherwise. A 2433 ms diagram is still
  2433 ms of CPU — but it is one diagram's worth, and every slot boundary
  gives the browser a frame.
- **Cancel on navigation.** A render token per document; queued diagrams
  belonging to a document the reader has left are dropped rather than
  drawn into detached nodes.
- **Say what is happening.** A quiet label in the placeholder, and a
  spinner once a render passes ~150 ms. Never a flash of source.
- **A cap with an escape hatch.** Past a threshold — measure it, roughly
  150 nodes or 20 KB of source — do not render automatically. Show
  "Render diagram" and let the reader ask. For a diagram that genuinely
  costs seconds this is the only honest answer.

Target: first paint unchanged at ~144 ms, longest frame from 3123 ms down
to one diagram's slice, the page scrollable and navigable throughout.

### Phase 2a — render each diagram once per tab — **done**

A diagram is a pure function of its source and the theme, and documents
are immutable. A `Map` from the theme and the source to the SVG string
turns a revisit, a `snyvi watch` refresh and a back-button into a string
assignment: measured at **34 ms for the whole document**, against a
budget row that no longer has anything to report.

Three things it turned out to want beyond the twenty lines:

- **A source that will not parse is remembered too**, so the rule is the
  whole of it: no source is handed to Mermaid twice in one tab. The
  failure is a fact about the source in the way the drawing is, and the
  document holding one is the document a reader re-opens to see what the
  agent actually wrote. Without this the harness counted one render call
  per revisit, which is how the rule got stated properly.
- **The id is not part of the drawing.** Mermaid writes the id it is
  given into the root element, into an id-scoped `<style>` block, and
  into the ids of the markers the edges point at. Cached verbatim and
  painted twice, a document carrying the same diagram twice would hold
  two of each, with the second one's arrowheads resolving to the first.
  So what is cached carries a token where the id was, and the figure
  being painted supplies one.
- **A bound, in bytes rather than entries**, because one diagram's SVG is
  two orders of magnitude larger than another's and the tab left open all
  day reading documents is the one this project promises will stay small.
  4 MB, least-recently-used first, and never the entry just asked for.

It also made the cap honest. A diagram over the 150-line threshold is
offered rather than drawn because drawing it costs seconds — and one
already in the cache costs a string assignment, so a reader who asked for
the 220-node flowchart once is not asked again on the way back.

### Phase 3 — make a big diagram readable

Not a custom renderer. Mermaid hands us an SVG with a `viewBox`;
everything needed is a viewport around it.

- Wrap each SVG in a frame with a bounded height, fitted at first.
- **Pan and zoom the `viewBox`** — wheel or pinch zooms toward the
  cursor, drag pans, double-click zooms in, `0` refits. Driving the
  `viewBox` rather than a CSS transform keeps strokes crisp at any zoom
  and costs nothing per frame.
- **Fullscreen**, on a button and a key: the one place a 4738 px graph is
  legible.
- **Fit / 100%** as one toggle, so "show me the shape" and "let me read
  that label" are each one click.
- **Let a diagram escape the reading measure.** 0.3.2 gave the pane to
  everything that is not prose and missed diagrams.
- **Leave plain scrolling alone.** Zoom on ⌘/ctrl + wheel, the web's own
  convention, so a cursor crossing a diagram never traps the page.

About 150 lines of vanilla JavaScript and no new dependency.

### Phase 4 — the 523 ms, and the small faults

- **Prefetch Mermaid when idle**, once a tab has a document open and the
  library is known to contain a diagram anywhere. Takes ~523 ms off the
  first diagram and costs nothing when none ever appears.
- **Trim the bundle.** 3.57 MB is the parse cost. The full build carries
  every diagram type — gantt, gitgraph, mindmap, quadrant, sankey,
  xychart, C4, journey, timeline, block, packet, architecture, radar,
  kanban, treemap. Agents emit flowchart, sequence, class, state, ER and
  gantt. Build a trimmed bundle with the types we choose and measure it;
  if it halves the parse it earns its build step. It needs a documented
  regeneration command and a CI size check either way — a vendored blob
  nobody can rebuild is a liability.
- **Re-theme on toggle.** Cheap once 2a exists: drop the other theme's
  cached SVGs and re-queue what is visible.
- ~~**Keep find out of diagrams.**~~ **Done, in phase 1.** A one-line
  rejection in the tree walker, and it was hiding content rather than
  merely mis-counting it, so it did not earn a wait. Counting diagram
  matches *and* zooming to them is still better, and still belongs after
  phase 3. The placeholder label is skipped along with the SVG: it is
  chrome, and would otherwise put a match in every diagram on the page
  for anyone searching "diagram".
- ~~**Keep the source on a parse error.**~~ **Done, in phase 1**, because
  the placeholder made it compulsory rather than optional: a diagram that
  throws now has a box of its own to fill, and leaving it empty would
  have been worse than what Mermaid did. The error message sits above the
  source, which is shown with ligatures off — JetBrains Mono draws `-->`
  as a single arrow, and a reader looking at a parse error needs the
  characters the agent actually typed.

### Phase 2b — cache SVGs in the daemon (a decision, not a default)

The tab posts a rendered SVG back, keyed by the source hash and theme;
the daemon stores it and serves it inside the document HTML. A new tab, a
new window and a restart all become instant, and it matches what snyvi
already does everywhere else: do the heavy work once and cache it
forever.

It needs a call first. The roadmap's one-way rule says agents send and
snyvi shows, so that nothing can leak a project's documents back into a
session's context. A render cache is not that channel — it is the
viewer's memo of its own work, written and read only by the viewer, never
reachable from MCP or the CLI. That argument should be made explicitly in
the code and the docs, or not made at all. Phase 2a alone removes most of
the pain, so this can wait for a considered answer.

## 4. What is not worth doing

- **A custom Mermaid renderer.** Reimplementing flowchart layout, sequence
  layout and the rest is months, and buys nothing the phases above do not:
  zoom is a `viewBox`, responsiveness is a scheduler, repeat cost is a
  cache, bundle size is a build flag. Revisit only if a trimmed bundle
  still cannot get a common diagram under ~200 ms.
- **Server-side Mermaid.** It wants a JavaScript engine inside a binary
  whose whole pitch is 12 MB and static.
- **Streaming the document HTML.** Measured: the daemon answers a 1.25 MB
  document in 2–29 ms and the browser paints at 116 ms. There is nothing
  to stream, and the roadmap already rules it out for a different and
  still-good reason. The progressive treatment belongs to diagrams, which
  is where the delay actually is.

## 5. Order and cost

| | Phase | Cost | Payoff | |
|---|---|---|---|---|
| 1 | Scheduler, viewport-gated, placeholders, cap | M | 3123 ms freeze → responsive | **done** |
| 2 | In-tab SVG cache | XS | revisit 2426 ms → 34 ms | **done** |
| 3 | Pan, zoom, fullscreen | M | a big diagram becomes readable | next |
| 4 | Idle prefetch | XS | −523 ms on the first diagram | |
| 5 | Find, theme, error-source fixes | S | correctness | find and error done |
| 6 | Trimmed bundle | M | measure before committing | |
| 7 | Daemon-side SVG cache | M | instant everywhere; needs the call above | |
| 8 | Theme the diagrams (section 9) | S | they stop looking borrowed | **done** |

## 6. How we know

`bench/browser.mjs`, beside `snyvi bench`, and in CI on every push. It
builds a fixture document, sends it through the CLI so the whole path is
covered, drives headless Chromium over the DevTools protocol, and checks
both the clock and the behaviour. No dependencies: Node 22's own
WebSocket and fetch. A `npm install` in a project whose pitch is one
static binary would be a poor trade for a wrapper.

    node bench/browser.mjs            report the numbers
    node bench/browser.mjs --check    and fail if one is over budget

The fixture carries five diagrams, each in the document to settle one
question: two small ones above the fold that must be drawn, an
unparseable one that must keep its source, a 40-node one below the fold
that must be left alone, and the 220-node flowchart that must be offered
rather than spent. `SNYVI_BENCH_FACTOR` scales the budgets (CI uses 3);
`SNYVI_BENCH_CPU` throttles the CPU, which is the honest way to see what
a slower machine would report.

**A shared machine's speed is not snyvi's to promise.** Two hosted
runners eighteen minutes apart reported 444 ms and 1404 ms of first paint
for the same commit, and 221 ms and 783 ms of boot task. A budget loose
enough to admit the slow one catches nothing; one that is not fails the
build for whoever drew it. So `SNYVI_BENCH_SHARED=1`, which CI sets,
prints those rows and does not enforce them — they are a fact about the
runner.

One timing row is enforced everywhere, because it is not a fact about the
runner: **longest task, drawing**. It asks whether the work is cut into
slices, not how fast the machine cutting them is. It reads 0 ms on a fast
runner, 0 ms on one three times slower, 369 ms under an eightfold CPU
throttle — and 1455 ms the moment the scheduler is taken out. That is the
number phase 1 is about, and the margin is two orders of magnitude rather
than a factor of three. Everything in section 6's behaviour list is
enforced everywhere too, because none of it depends on the clock.

Run it without `SNYVI_BENCH_SHARED` on a machine you control and every
row is enforced, which is where first paint's 250 ms budget means
something.

**Three windows, not one longest frame.** The single number the plan
asked for would have been dominated by Mermaid's own 523 ms of parsing,
which no scheduler can touch — a budget that phase 1 could not pass and
phase 4 alone could move. So long tasks are attributed to the window they
fall in: before the library is fetched, while it compiles, and after it
is ready. Only the third is phase 1's, and it is the one held tight.
app.js emits `snyvi:mermaid-load` and `snyvi:mermaid-ready` to draw those
lines, and a `snyvi:diagram` measure per render.

## 7. What it measures now

Taken with the harness on the machine section 1 was measured on, before
and after phase 1. "Before" is the same fixture against the `mermaid.run`
the scheduler replaced.

| | Before | After | Budget |
|---|---|---|---|
| First contentful paint | 160 ms | 76–128 ms | 200 |
| Longest task, boot | **3193 ms** | 0–66 ms | 200 |
| Longest task, drawing | — | 0 ms | 250 |
| First diagram drawn | never (all four at once) | ~550 ms | 2000 |
| Longest task, Mermaid parse | *(inside the 3193)* | ~310 ms | reported |
| The 220-node diagram, asked for | 2426 ms, unasked | ~1530 ms, on a click | reported |

The 3193 ms is section 1's 3123 ms reproduced independently, which is the
only reason to trust either.

Section 9 adds a pass of its own on a second document, which is not
timed at all: the theme toggle must actually re-draw what is on screen,
and every diagram family must come back legible in both themes. It is
reported as thirteen lines rather than folded into one, because the
useful thing about "gantt, dark, 1.4:1" is all three parts of it.

Phase 2a adds a row of its own, and it is a count rather than a clock:
**diagrams drawn again on a revisit**, which must be zero. Counting calls
into the renderer is the only honest way to ask — a machine fast enough
makes a real re-render look like a cache — and it names the diagrams it
caught, because "one diagram was drawn again" is not something anyone can
act on. With the cache taken out it reads `small-flow, sequence, broken`.
It also checks that a restored SVG carries the id of the figure it is in
rather than the one it was first drawn under, which is the fault that
stays invisible until a document holds the same diagram twice.

Four behaviours are checked as well, and they do not depend on the clock:
a diagram below the fold is not drawn, one over the cap is offered rather
than spent, find marks nothing inside an SVG while still finding the
prose, and a reader who leaves a document mid-render strands nothing —
neither diagrams drawn into the page they left nor diagrams never drawn
on the page they arrived at.

That last one earned its place. The first scheduler restarted its queue
only under the token it had captured, so navigating away while the
library was still loading left the *next* document's diagrams queued
forever. Every other check passed while it did. The harness holds the
request for `mermaid.js` open over the DevTools protocol rather than
racing a `sleep` against it, so the window is the same width every run.

## 8. What phase 1 left for later

Measured on the way, and not fixed here:

- **A big diagram is still unreadable, and now demonstrably so.** The
  220-node flowchart renders 30 px tall: it is 4738 px wide, `max-width:
  100%` fits the width into the 630 px column, and `height: auto` takes
  the height down with it. Phase 3.
- **The placeholder height is a guess.** A small flowchart lands at
  258 px and a nine-line sequence diagram at 383, from sources that look
  alike. The reserve sits between them. Phase 3's bounded frame is what
  turns the guess into a number.
- ~~**The theme toggle still leaves drawn diagrams behind.**~~ **Fixed**
  with section 9, which is where it belonged: 2a made it cheap, and a
  toggle is only worth re-drawing for once the colours are the viewer's
  own. The harness checks it by reading the fills back before and after.
- ~~**`snyvi watch` still redraws on every save**~~, though it no longer
  blocked while doing it. **Fixed by 2a**, which removed the work rather
  than rescheduling it: the file's diagrams are unchanged across a save,
  so every one of them is a cache hit.

## 9. How they look

The roadmap asks two questions of every feature: does it make reading
more beautiful, and does it keep everything instant. Sections 1 to 8
answered the second one for diagrams. This section is the first, and it
was measured the same way — rendered under headless Chromium against the
bundle we actually ship, `ui/mermaid.min.js.gz`, Mermaid 11.17.2.

Today `app.js` asks for `theme: "neutral"` on a light page and
`theme: "dark"` on a dark one, and that is the whole of it. The result is
a diagram that is recognisably Mermaid's rather than snyvi's, in a viewer
whose entire pitch is that the document is the hero:

- **Grey boxes on warm paper.** `neutral` fills nodes `#eeeeee` and
  strokes them `#999999`, on a page whose paper is `#faf9f6` and whose
  rules are `#e6e2da`. Nothing else in the viewer is that colour.
- **Edge labels get a highlight box in dark mode.** `yes`, `no`,
  `near viewport` and `parse error` each render on `#585858`, which
  matches neither `--bg` (`#15181f`) nor `--code-bg` (`#1b1f28`). It
  reads as a selection highlight nobody asked for.
- **Nothing is emphasised.** Every node in a plan is drawn with equal
  weight, so a seven-node flowchart has no subject.
- **The title is Inter at 18px**, where every other heading in the viewer
  is Source Serif.

### What the reference actually is

`cathrynlavery/diagram-design` was the prompt for this. It is worth being
precise about what it is, because the obvious reading is wrong: **it is
not a Mermaid theme.** It is an agent skill — 39 hand-authored SVG
templates, a `style-guide.md` of semantic tokens (`paper`, `ink`,
`accent`, `muted`), three typefaces, and a hard rule that coordinates are
divisible by 4. Its `mermaid_extract.py` is an *importer*: it reads
Mermaid source and redraws it as bespoke SVG.

So adopting it wholesale means putting a model in the render path, which
section 4 already rules out for server-side Mermaid and for the same
reason. What ports is its vocabulary, not its machinery — and snyvi
already has the vocabulary, in `:root`. `paper` is `--bg`, `ink` is
`--fg`, `muted` is `--fg-3`, `accent` is `--accent`. The work is joining
two things that already exist.

### The lever

Mermaid 11 takes `theme: "base"` plus a `themeVariables` map, and a
`themeCSS` string that it appends to each diagram's own `<style>` block,
scoped to that diagram's id. That scoping is why this is the right lever
and `app.css` is not: Mermaid's own rules are `#id`-scoped, so a rule in
`app.css` written as `.mmd svg .node rect` loses on specificity and a
rule written to win needs `!important` on every line. `themeCSS` is
emitted *inside* the same block, after them, and wins by order.

`themeVariables` carries the colours:

| Mermaid | snyvi |
|---|---|
| `background`, `edgeLabelBackground` | `--bg` |
| `mainBkg`, `primaryColor`, `actorBkg`, `stateBkg` | `--bg-raise` |
| `secondaryColor`, `clusterBkg`, `labelBoxBkgColor` | `--bg-side` |
| `primaryTextColor`, `textColor`, `nodeTextColor` | `--fg` |
| `signalColor`, `signalTextColor`, `titleColor` | `--fg-2` |
| `lineColor` | `--fg-3` |
| `clusterBorder` | `--rule` |
| `nodeBorder`, `primaryBorderColor`, `actorBorder` | `--rule-2` |
| `noteBkgColor`, `activationBkgColor` | `--accent-bg` |
| `noteBorderColor`, `activationBorderColor` | `--accent` |

`themeCSS` carries everything a colour cannot say: 1px node strokes and
1.25px edges instead of Mermaid's heavier defaults, `rx: 8px` on
clusters to match `--radius`, the small positive letter-spacing the rest
of the UI uses, and the diagram's own title in Source Serif so it reads
as a heading rather than a caption.

### The accent, spent once

The reference's strongest rule is one accent per diagram and one or two
focal elements. Mermaid cannot infer a focus, but it does not have to:
an author writes `B:::focus`, and two rules in `themeCSS` —
`.node.focus rect` and `.node.focus .nodeLabel` — draw that node in
`--accent-bg` on `--accent`. A `:::muted` does the reverse for the
branch that is context rather than subject.

Measured, because the syntax is not obvious: **`B:::focus` needs no
`classDef` at all.** Mermaid puts the class on the node regardless and
`themeCSS` styles it. A bare `classDef focus` with no declarations is a
parse error, and a `classDef focus fill:...` emits an inline `style`
attribute that beats `themeCSS` on exactly the properties it names — so
the class must be applied without one. `class B focus` behaves
identically to `:::`.

### What it costs

Nothing the budget can see. Same two diagrams, same tab:

| | Flowchart | Sequence |
|---|---|---|
| Today (`neutral`) | 88 / 45 ms | 34 / 20 ms |
| `base` + tokens | 45 ms | 20 ms |
| + `themeCSS` | 40 ms | 19 ms |

The 88 is the first render in the tab warming up; the honest reading of
that table is that theming is free, which is what one would expect from
changing the values a renderer already substitutes.

It does add bytes. `themeCSS` is emitted into *every* diagram's `<style>`
block, so a page with eight diagrams carries eight copies: **+651 bytes
per diagram** for the block described above. That is worth knowing before
2b caches SVGs in the daemon, and it is not worth acting on.

`look: "neo"`, Mermaid 11's roomier shape set, was measured alongside and
is **not** recommended. At reading size it is nearly indistinguishable
from the tokens alone, and it hardcodes
`drop-shadow(rgba(185,185,185,1))`, which is a light-grey shadow drawn on
a dark page.

### Three things found on the way

- **`stateBkg` silently sets the state-diagram label colour.** Mermaid
  computes `stateLabelColor = stateLabelColor || stateBkg ||
  primaryTextColor`. Mapping `stateBkg` to `--bg-raise`, which is right
  for the box, therefore made every state label `#ffffff` on `#ffffff`.
  The labels were in the DOM the whole time, correctly positioned, and
  invisible. An explicit `stateLabelColor` fixes it — measured:
  `rgb(255,255,255)` before, `rgb(31,29,26)` after. The lesson is not the
  token, it is that tokens leak across diagram families, so this wants a
  render check per family rather than per token.
- **A `>` combinator in `themeCSS` survives, but only just.** Mermaid
  HTML-escapes it, so the SVG *string* contains `&gt;` and anything
  reading that string as text sees a broken selector. It round-trips
  correctly through `frame.innerHTML = svg`, which is what `mmdRender`
  does, because inside foreign content a `<style>` element decodes
  character references — verified end to end: the rule parses and
  applies. Descendant selectors avoid the question entirely and cost
  nothing here.
- **An author's `classDef` beats `themeCSS`**, per the accent note above.
  This is ordinary inline-style precedence, and it is the right way
  round: a diagram that asks for a specific colour should get it.

### What it needed before it landed, and what happened

Both conditions were met, and the first one paid for itself twice.

**A render check per diagram family.** `bench/browser.mjs` now sends a
second document — one small flowchart, sequence, class, state, ER and
gantt — scrolls to each, and reads the colours back off the real render
in *both* themes. For every label it finds what is actually behind it
with `elementFromPoint` (text made click-through for the duration, so the
point lands on the fill rather than on the glyph) and reports the worst
contrast ratio in the diagram. Alpha is composited rather than ignored:
half of snyvi's dark tokens are `rgba(255,255,255,…)`, and a ratio taken
before blending is a number about nothing. The floor is 3:1, WCAG's for
large text, because what this is here to catch is not a design opinion
but a label drawn in the colour of the thing behind it — which lands at
1.0 and which nothing else in the harness can see.

It caught two, both in dark, both of which would have shipped:

- **The focus node's label measured 1.0:1** — the same colour, twice.
  `--accent-bg` is a pale wash of the accent on paper and reads well
  there, but in the dark palette it is that same orange at 14% alpha, so
  the label composited onto the accent fill behind it *is* the accent
  fill. The label is `--bg` now, which is the one token guaranteed to
  oppose the accent in both palettes, since the accent is chosen to sit
  on it.
- **A gantt drew "Scheduler" at 1.4:1 on its own bar.** A gantt derives
  none of its colours from the table above — it has its own dozen and a
  half for bars, section bands, the grid, and text placed inside a bar or
  beside it depending on room. They are mapped now, all the text to
  `--fg`, because every bar fill is within a shade of the page.

The check was harder to write than to run, and the fault was the app's:
`#main` sets `scroll-behavior: smooth`, which a plain `scrollIntoView`
inherits, so the first version measured while the page was still gliding
and reported "no label could be read" for whichever families were
furthest from where it started. It asks for an instant scroll.

**2a first, or at least beside it.** 2a landed first, and made the theme
toggle a fix rather than a project: the theme is half of the cache key,
so a toggle is put-every-figure-back-to-a-placeholder and re-queue
what is near the viewport, and anything this tab has already drawn in
the theme being returned to costs a string assignment. Nothing is
dropped, which the plan assumed would be necessary — toggling back is
free as well, and the byte bound is what keeps holding both from
mattering. The same fault arrives by a second route, so the page also
follows the system theme moving under it when no choice is stored.

Cost was as estimated: about sixty lines in `app.js`, no new dependency,
no build step, and nothing touched in `render.rs` or the vendored bundle.
The timing rows did not move, which is what the measurements above
predicted.
