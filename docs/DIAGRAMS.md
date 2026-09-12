# Diagrams: where the time goes, and the plan

Written 2026-09-12, after a report that a page with a big Mermaid diagram
takes seconds to open. Everything in section 1 is measured on this
machine under headless Chromium, not estimated.

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

### Phase 1 — never block the reader

Replace the single `mermaid.run` with a scheduler.

- **Reserve the space first.** Each `pre.mermaid` becomes a placeholder
  box of an estimated height, so the page does not jump when the SVG
  lands. `render.rs` already emits the `<pre class="mermaid">`; have it
  emit a size hint (bytes, lines) alongside `data-lang` so the client can
  size the box and judge the cost without parsing the source itself.
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

### Phase 2a — render each diagram once per tab

A diagram is a pure function of its source and the theme, and documents
are immutable. Keep a `Map` from `hash(source) + theme` to the SVG
string. A revisit, a `snyvi watch` refresh, or a back-button becomes a
string assignment. Perhaps twenty lines; it removes the 2426 ms revisit
and the re-render-on-every-save outright.

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
- **Keep find out of diagrams.** Reject anything inside an `svg` in the
  tree walker, so find stops hiding labels and stops counting matches
  that cannot be seen. Counting them *and* zooming the diagram to them is
  better, and belongs after phase 3.
- **Keep the source on a parse error.** Show Mermaid's error graphic
  beside a collapsed, copyable copy of what the agent wrote.

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

| | Phase | Cost | Payoff |
|---|---|---|---|
| 1 | Scheduler, viewport-gated, placeholders, cap | M | 3123 ms freeze → responsive |
| 2 | In-tab SVG cache | XS | revisit 2426 ms → nothing |
| 3 | Pan, zoom, fullscreen | M | a big diagram becomes readable |
| 4 | Idle prefetch | XS | −523 ms on the first diagram |
| 5 | Find, theme, error-source fixes | S | correctness |
| 6 | Trimmed bundle | M | measure before committing |
| 7 | Daemon-side SVG cache | M | instant everywhere; needs the call above |

## 6. How we will know

A browser budget in CI, beside the daemon's: load a fixture document
carrying a 220-node flowchart under headless Chromium and assert first
contentful paint under 200 ms, longest frame under 200 ms, and the
diagram present within a stated bound. The numbers in section 1 were
taken with exactly that harness, so it is a fixture away from existing.
