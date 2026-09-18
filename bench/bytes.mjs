/* What the page weighs on the wire.
 *
 * The daemon serves `ui/`'s text assets gzipped, and until this existed nothing
 * measured them. The budget in docs/BRAINSTORM.md is "< 60 KB desktop", it had
 * been over for some time, and the overage was found by hand -- twice, at two
 * different numbers, because a hand count is easy to take over three files
 * instead of four. A number nothing checks is a number that drifts.
 *
 * It shipped with two lines rather than one: the 60 KB budget, printed with its
 * gap but never enforced, and a 68 KB ceiling that was. A red row on every push
 * for a debt taken before the probe existed teaches a reader to ignore the
 * probe, so the ceiling held the ratchet while the budget was out of reach, and
 * was written to come down as the gap closed.
 *
 * The gap is closed, so it has. First paint was 67.0 KB with 1.0 KB of room in
 * it; the diagram driver -- 820 lines that ran the lazily-loaded library and
 * were themselves carried by every page load -- moved to ui/mmd.js, and first
 * paint is 55.1 KB. The per-file table below is what found that, and it is the
 * other half of the point: the deferred rows price what the page does not pay
 * for until someone wants it, which is the shape any new chunk cites.
 *
 * So there is one line again, and it is the budget as written.
 *
 *   node bench/bytes.mjs            report
 *   node bench/bytes.mjs --check    and exit non-zero if the budget is over
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
const BUDGET = 60 * KB;   // docs/BRAINSTORM.md:31

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

/* Not paid until a diagram is on screen: the library, and since this split the
 * code that drives it. The precedent any new chunk cites. Mermaid ships
 * gzipped, so its file size is already what crosses the wire; mmd.js is
 * measured the way the four above are. */
const deferred = [
  ["mermaid.min.js.gz", statSync(join(UI, "mermaid.min.js.gz")).size],
  ["mmd.js", gz("mmd.js")],
];
console.log("deferred, and not on the wire until the first diagram:");
for (const [f, n] of deferred) console.log(`  ${f.padEnd(20)}${kb(n).padStart(12)}`);
console.log("");

/* One test and one reading. The test is the budget, and it is the only line
 * here a push can break. The reading is the question the probe was built to
 * answer and has no budget of its own to fail against -- a reading printed as
 * FAIL on every push is a reading nobody reads. */
const over = total - BUDGET;
const failed = over > 0;
console.log(`  ${"first paint against its budget".padEnd(38)}${failed ? " FAIL" : " ok  "} ${
  failed ? `${kb(total)}, ${kb(over)} over ${kb(BUDGET)}` : `${kb(total)} of ${kb(BUDGET)}, ${kb(-over)} spare`}`);
console.log(`  ${"a panes chunk at first paint".padEnd(38)}      ${
  total + 15 * KB <= BUDGET ? `15 KB more would still fit under ${kb(BUDGET)}` : `15 KB more is ${kb(total + 15 * KB - BUDGET)} over ${kb(BUDGET)}, so panes load when a desk is opened, as diagrams do`}`);
console.log("");

if (failed && CHECK) {
  console.error("bytes: the page is heavier than its budget");
  process.exitCode = 1;
}
