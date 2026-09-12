/* The document the browser budget is measured on.
 *
 * Generated rather than committed, for the same reason `snyvi bench` builds its
 * Markdown in code: a 30 KB blob of `n0-->n1` in the tree is noise nobody can
 * read or check, and the shape of the graph is the thing that matters. Every
 * number here is deliberate -- see the comments -- so changing one changes what
 * the budget measures, which is a decision, not a tidy-up.
 */

/** A flowchart with `n` nodes, wired as a binary tree so the layout is wide as
 *  well as deep. Width is what costs: dagre's ordering pass is where the seconds
 *  in section 1 of docs/DIAGRAMS.md went. */
export function flowchart(n, label = "Step") {
  const lines = ["flowchart TD"];
  for (let i = 0; i < n; i++) {
    const a = 2 * i + 1, b = 2 * i + 2;
    if (a < n) lines.push(`  n${i}["${label} ${i}"] --> n${a}["${label} ${a}"]`);
    if (b < n) lines.push(`  n${i} --> n${b}["${label} ${b}"]`);
    // A leaf with no edge at all would be dropped; give the last row a terminal.
    if (a >= n) lines.push(`  n${i}["${label} ${i}"] --> done${i}((fin))`);
  }
  return lines.join("\n");
}

const SEQUENCE = `sequenceDiagram
    participant Agent
    participant snyvi
    participant Reader
    Agent->>snyvi: send_document(PLAN.md)
    snyvi-->>Agent: /d/abc123
    Agent->>Reader: here is the plan
    Reader->>snyvi: GET /d/abc123
    snyvi-->>Reader: rendered HTML`;

/** Prose, so the diagrams below it are genuinely below the fold. Deterministic:
 *  the same bytes every run, or the FCP number moves for reasons of its own. */
function prose(paragraphs) {
  const out = [];
  for (let i = 0; i < paragraphs; i++) {
    out.push(`### Section ${i}\n`);
    out.push(
      `A paragraph of ordinary prose with *emphasis*, **strong text**, \`inline code\`, ` +
      `and a [link](https://example.com). It runs on for a few sentences so the parser ` +
      `sees realistic line lengths and the page has a realistic amount to lay out ` +
      `between one diagram and the next. Section ${i} says nothing in particular.\n`
    );
  }
  return out.join("\n");
}

/* The four diagrams, and what each one is in the document to prove.
 *
 * Ids are carried in the fence's first line as a comment, because that is the
 * only thing that survives into the DOM: Mermaid ignores `%%` lines, and the
 * harness reads them off the source to tell one placeholder from another
 * without depending on document order. */
export const DIAGRAMS = [
  // Above the fold: must be drawn, and is what "first diagram drawn" is measured
  // against. Its labels are also what the find check searches for.
  { id: "small-flow", above: true, expect: "drawn", src: flowchart(3, "Node") },
  // Also above the fold: proves the queue drains more than one, and that the
  // second diagram does not wait on a second copy of the library.
  { id: "sequence", above: true, expect: "drawn", src: SEQUENCE },
  // Above the fold and unparseable. Mermaid answers this with its own error
  // graphic, which replaces the source; the source must survive.
  { id: "broken", above: true, expect: "error", src: "flowchart TD\n  A --> ((( B\n  --> ->" },
  // Below the fold and under the cap: must NOT be drawn while it is off screen.
  // This is the whole of "it is eager" in section 2 of docs/DIAGRAMS.md.
  { id: "offscreen-flow", above: false, expect: "idle", src: flowchart(40, "Later") },
  // Below the fold and over the cap: held behind a button even when scrolled to.
  // 220 nodes is the diagram that measured 2433 ms.
  { id: "huge-flow", above: false, expect: "held", src: flowchart(220, "Task") },
];

const fence = d => "```mermaid\n%% id:" + d.id + "\n" + d.src + "\n```\n";

/* One small diagram of each family Mermaid draws differently, for the pass that
 * reads colours back rather than the clock.
 *
 * Section 9 of docs/DIAGRAMS.md asks for this shape of check rather than one
 * assertion per theme token, and it asks because of what the token mapping did:
 * `stateBkg` silently decides the state-diagram label colour, so setting it to
 * the box's own fill painted every state label the colour of the thing behind
 * it -- present in the DOM, correctly positioned, invisible. Every check that
 * existed passed. Tokens leak across families, so the families are what get
 * checked.
 *
 * They are small on purpose: this document is not measured, and six diagrams
 * that each take a moment would only make a legibility failure slower to find.
 */
export const FAMILIES = [
  // Carries the two class hooks as well, since `:::focus` and `:::muted` are the
  // one place the accent is spent and the only rules in themeCSS that repaint a
  // node wholesale.
  { id: "fam-flowchart", src: 'flowchart LR\n  A["Plan"] --> B["Review"]:::focus\n  B --> C["Ship"]:::muted' },
  { id: "fam-sequence", src: SEQUENCE },
  { id: "fam-class", src: "classDiagram\n  class Document {\n    +String title\n    +render()\n  }\n  Document <|-- Markdown" },
  { id: "fam-state", src: "stateDiagram-v2\n  [*] --> Pending\n  Pending --> Drawing\n  Drawing --> Done\n  Done --> [*]" },
  { id: "fam-er", src: "erDiagram\n  PROJECT ||--o{ WORKFLOW : holds\n  WORKFLOW ||--o{ DOCUMENT : holds" },
  { id: "fam-gantt", src: "gantt\n  title Phases\n  dateFormat YYYY-MM-DD\n  section Diagrams\n  Scheduler :done, p1, 2026-09-01, 3d\n  Cache :active, p2, after p1, 2d" },
];

export function families() {
  return (
    "# Diagram families\n\n" +
    "Generated by `bench/fixture.mjs`. One of each, so the harness can read the\n" +
    "colours back in both themes.\n\n" +
    FAMILIES.map(fence).join("\n")
  );
}

export function fixture() {
  const above = DIAGRAMS.filter(d => d.above).map(fence).join("\n");
  const below = DIAGRAMS.filter(d => !d.above).map(d => fence(d) + "\n" + prose(6)).join("\n");
  return (
    "# Diagram budget fixture\n\n" +
    "Generated by `bench/fixture.mjs`. Three diagrams above the fold, two below.\n\n" +
    // The find check searches for `Node 1`, which is a label in the first
    // flowchart. It has to appear in the prose as well, or "find still finds
    // the prose matches" would pass on a find that had stopped finding
    // anything at all.
    "The first flowchart draws a Node 1, and this sentence mentions Node 1 too.\n\n" +
    above +
    "\n" +
    // Enough prose to put the rest well outside any plausible rootMargin at
    // the 1280x900 the harness uses.
    prose(40) +
    "\n" +
    below
  );
}
