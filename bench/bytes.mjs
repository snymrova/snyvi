/* What the page weighs on the wire.
 *
 * The daemon serves `ui/`'s four text assets gzipped, and until now nothing
 * measured them. The budget in docs/BRAINSTORM.md is "< 60 KB desktop", it
 * has been over for some time, and the overage was found by hand -- twice,
 * at two different numbers, because a hand count is easy to take over three
 * files instead of four. A number nothing checks is a number that drifts.
 *
 * Two lines, and they are not the same line:
 *
 *   TARGET  the budget as written, 60 KB. Printed with the gap, never
 *           enforced while the gap is real -- a red row on every push for a
 *           debt taken before the probe existed teaches a reader to ignore
 *           the probe.
 *   LIMIT   the ceiling, 68 KB. Enforced. It exists so the page cannot get
 *           quietly heavier while the target is out of reach, and it comes
 *           down as the gap closes. It is not permission to spend to it.
 *
 * The per-file table is the other half of the point. The panes work wants
 * 15-25 KB of new page, which does not fit under either line, so it has to
 * arrive as a chunk loaded when a bench is opened -- the way mermaid already
 * does. The mermaid row is here to price that precedent: it is what the page
 * does not pay for until a diagram is on screen.
 *
 *   node bench/bytes.mjs            report
 *   node bench/bytes.mjs --check    and exit non-zero if the ceiling is over
 *
 * Bytes only, no clocks, so every row is enforced on every machine.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const CHECK = process.argv.includes("--check");
const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const KB = 1024;
const TARGET = 60 * KB;   // docs/BRAINSTORM.md:31
const LIMIT = 68 * KB;

/* The four the page cannot start without: the document it is served, the
 * script that boots it, and the two the boot pulls in. Fonts are woff2 and
 * already compressed; mermaid ships gzipped and is counted apart. */
const FIRST = ["index.html", "boot.js", "app.css", "app.js"];

const gz = f => gzipSync(readFileSync(join(UI, f)), { level: 9 }).length;
const kb = n => (n / KB).toFixed(1) + " KB";

const rows = FIRST.map(f => [f, statSync(join(UI, f)).size, gz(f)]);
const raw = rows.reduce((t, r) => t + r[1], 0);
const total = rows.reduce((t, r) => t + r[2], 0);

console.log("bytes: what the page weighs on the wire\n");
console.log(`${"file".padEnd(16)}${"raw".padStart(10)}${"gzip".padStart(10)}${"share".padStart(8)}`);
for (const [f, r, g] of rows) {
  console.log(`${f.padEnd(16)}${String(r).padStart(10)}${String(g).padStart(10)}${(Math.round((g / total) * 100) + "%").padStart(8)}`);
}
console.log(`${"first paint".padEnd(16)}${String(raw).padStart(10)}${String(total).padStart(10)}${"".padStart(8)}\n`);

/* Not paid until a diagram is on screen. The precedent any new chunk cites. */
const mermaid = statSync(join(UI, "mermaid.min.js.gz")).size;
console.log(`deferred: mermaid.min.js.gz ${kb(mermaid)}, loaded on the first diagram and not before\n`);

/* One test, and two readings. The test is the ceiling: it is the only line
 * here a push can break. The readings are what the probe was built to
 * answer, and neither has a budget of its own to fail against -- a reading
 * printed as FAIL on every push is a reading nobody reads. */
const over = total - TARGET;
const failed = total > LIMIT;
console.log(`  ${"first paint under the ceiling".padEnd(38)}${failed ? " FAIL" : " ok  "} ${
  failed ? `${kb(total)}, ${kb(total - LIMIT)} over ${kb(LIMIT)}` : `${kb(total)} of ${kb(LIMIT)}, ${kb(LIMIT - total)} spare`}`);
console.log(`  ${"against the 60 KB budget".padEnd(38)}      ${
  over > 0 ? `${kb(over)} over, a debt docs/BRAINSTORM.md:31 is still owed` : `inside it, ${kb(-over)} spare`}`);
console.log(`  ${"a panes chunk at first paint".padEnd(38)}      ${
  total + 15 * KB <= LIMIT ? `15 KB more would still fit under ${kb(LIMIT)}` : `15 KB more is ${kb(total + 15 * KB - LIMIT)} over ${kb(LIMIT)}, so panes load on open, as mermaid does`}`);
console.log("");

if (failed && CHECK) {
  console.error("bytes: the page is heavier than its ceiling");
  process.exitCode = 1;
}
