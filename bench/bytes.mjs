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
 * ---------- and it asks the daemon now, not the folder ----------
 *
 * This read `ui/` off disk, which was the same bytes the daemon served until
 * the daemon stopped serving the source: `build.rs` takes the comments and the
 * indentation out on the way into the binary (`src/strip.rs`), because a
 * browser reads none of it and a reader paid 26 KB per first paint for prose
 * nothing renders. A probe that measures the folder would now be measuring
 * something no reader ever fetches -- so it starts a daemon and asks it,
 * exactly as a page does. That also means a strip that broke an asset cannot
 * pass this bench quietly: what comes back has to parse.
 *
 *   node bench/bytes.mjs            report
 *   node bench/bytes.mjs --check    and exit non-zero if the budget is over
 *
 * Bytes only, no clocks, so every row is enforced on every machine.
 */

import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const CHECK = args.includes("--check");
const BIN = flag("--bin") || "./target/release/snyvi";
const PORT = flag("--port") || "7797";   // 7791, 7794-7796 and 7812-7814 are taken
const UI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

const KB = 1024;
const BUDGET = 50 * KB;   // docs/BRAINSTORM.md:31

/* The four the page cannot start without: the document it is served, the
 * script that boots it, and the two the boot pulls in. Fonts are woff2 and
 * already compressed; mermaid ships gzipped and is counted apart. */
const FIRST = [["index.html", "/"], ["boot.js", "/assets/boot.js"], ["app.css", "/assets/app.css"], ["app.js", "/assets/app.js"]];

/* Not paid until a diagram is on screen: the library, and since this split the
 * code that drives it. The precedent any new chunk cites. Mermaid ships
 * gzipped, so its file size is already what crosses the wire; mmd.js is
 * measured the way the four above are. desk.js is the second chunk, and the
 * one the measurement below was taken to make the case for: the pane view,
 * paid when a desk is opened in the window and never in a tab. */
const CHUNKS = [["mmd.js", "/assets/mmd.js", "the first diagram"], ["desk.js", "/assets/desk.js", "a desk is opened"], ["frame.js", "/assets/frame.js", "the native window"], ["game.js", "/assets/game.js", "the rocket is pressed"], ["about.js", "/assets/about.js", "about, reset or connect is opened"], ["find.js", "/assets/find.js", "`/` searches a document"], ["keys.js", "/assets/keys.js", "⌃B wakes the letter keys"], ["menu.js", "/assets/menu.js", "a folder or a desk is right-clicked"], ["palette.js", "/assets/palette.js", "⌘K is pressed"]];

const kb = n => (n / KB).toFixed(1) + " KB";

/** What the daemon sends for a path, as bytes, asked for without compression
 *  so the gzip below is this bench's own and comparable with every run before
 *  the daemon was asked at all. */
async function served(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { "accept-encoding": "identity" } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** An asset that does not parse is worth more than an asset that is small.
 *  Node is the parser here because it is already the thing running this.
 *  A chunk is parsed as the module the page imports it as: as a plain
 *  script, two functions of one name are legal, and a desk.js that declared
 *  `put` twice passed here while the page refused to load it. */
function parses(name, text, module = false) {
  const f = join(tmp, `check-${name}${module ? ".mjs" : ""}`);
  writeFileSync(f, text);
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); return true; }
  catch { return false; }
}

let tmp = "";

async function main() {
  tmp = mkdtempSync(join(tmpdir(), "snyvi-bytes-bench-"));
  const env = { ...process.env, SNYVI_DATA_DIR: join(tmp, "data"), SNYVI_CONFIG_DIR: join(tmp, "config"), SNYVI_PORT: PORT };
  let failed = false;
  try {
    // The daemon starts the way anything starts it: a send.
    const md = join(tmp, "one.md");
    writeFileSync(md, "# one\n\nA document, so there is a daemon.\n");
    execFileSync(BIN, ["send", md], { env, encoding: "utf8" });

    const rows = [];
    for (const [name, path] of FIRST) {
      const body = await served(path);
      rows.push([name, body.length, gzipSync(body, { level: 9 }).length]);
      if (name.endsWith(".js") && !parses(name, body.toString())) {
        console.error(`bytes: ${name} is not valid JavaScript as served`);
        failed = true;
      }
    }
    const raw = rows.reduce((t, r) => t + r[1], 0);
    const total = rows.reduce((t, r) => t + r[2], 0);

    console.log("bytes: what the page weighs on the wire\n");
    console.log(`${"file".padEnd(16)}${"raw".padStart(10)}${"gzip".padStart(10)}${"share".padStart(8)}`);
    for (const [f, r, g] of rows) {
      console.log(`${f.padEnd(16)}${String(r).padStart(10)}${String(g).padStart(10)}${(Math.round((g / total) * 100) + "%").padStart(8)}`);
    }
    console.log(`${"first paint".padEnd(16)}${String(raw).padStart(10)}${String(total).padStart(10)}${"".padStart(8)}\n`);

    const deferred = [["mermaid.min.js.gz", statSync(join(UI, "mermaid.min.js.gz")).size, "the first diagram"]];
    let desk = 0;
    for (const [name, path, until] of CHUNKS) {
      const body = await served(path);
      const g = gzipSync(body, { level: 9 }).length;
      if (name === "desk.js") desk = g;
      if (!parses(name, body.toString(), true)) {
        console.error(`bytes: ${name} is not valid JavaScript as served`);
        failed = true;
      }
      deferred.push([name, g, until]);
    }
    console.log("deferred, and not on the wire until:");
    for (const [f, n, until] of deferred) console.log(`  ${f.padEnd(20)}${kb(n).padStart(12)}   ${until}`);
    console.log("");

    /* The themes. First paint carries Paper, on :root, and Ink, the dark
     * default, and no other: the window opens as fast as it can, and every
     * other theme is themes.css, fetched once the page is idle. So app.css
     * holds exactly one `[data-theme]` block -- Paper's own block under
     * prefers-contrast is Paper's, not a theme's -- and themes.css holds
     * the six, under a budget of their own (docs/THEMES.md). */
    const css = (await served("/assets/app.css")).toString();
    const firstThemes = [...css.matchAll(/\[data-theme="([a-z]+)"\]\s*\{/g)].map(m => m[1]).filter(n => n !== "paper");
    const themesCss = await served("/assets/themes.css");
    const later = [...themesCss.toString().matchAll(/\[data-theme="([a-z]+)"\]\s*\{/g)].map(m => m[1]);
    const themesCost = gzipSync(themesCss, { level: 9 }).length;
    const THEMES_BUDGET = 2 * KB;
    console.log(`  ${"themes.css".padEnd(20)}${kb(themesCost).padStart(12)}   the page is idle\n`);

    /* Two tests and one reading. The tests are the budget and the parse, and
     * they are the only lines here a push can break. The reading is the
     * question the probe was built to answer and has no budget of its own to
     * fail against -- a reading printed as FAIL on every push is a reading
     * nobody reads. */
    const over = total - BUDGET;
    if (over > 0) failed = true;
    console.log(`  ${"first paint against its budget".padEnd(38)}${over > 0 ? " FAIL" : " ok  "} ${
      over > 0 ? `${kb(total)}, ${kb(over)} over ${kb(BUDGET)}` : `${kb(total)} of ${kb(BUDGET)}, ${kb(-over)} spare`}`);
    console.log(`  ${"every asset parses as served".padEnd(38)}${failed && over <= 0 ? " FAIL" : " ok  "} the strip in build.rs did not eat one`);
    const onlyTwo = firstThemes.join() === "ink";
    if (!onlyTwo) failed = true;
    console.log(`  ${"first paint has Paper and Ink only".padEnd(38)}${onlyTwo ? " ok  " : " FAIL"} ${
      onlyTwo ? "every other theme waits for the page to be idle" : `app.css carries ${firstThemes.join(", ") || "no Ink"}`}`);
    const sixLater = later.length === 6 && !later.includes("paper") && !later.includes("ink");
    if (themesCost > THEMES_BUDGET || !sixLater) failed = true;
    console.log(`  ${"themes.css against its budget".padEnd(38)}${themesCost > THEMES_BUDGET || !sixLater ? " FAIL" : " ok  "} ${
      !sixLater ? `${later.length} theme blocks served (${later.join(", ")}), the six expected` : `${themesCost} B gzipped for ${later.length} themes, under ${kb(THEMES_BUDGET)}`}`);
    console.log(`  ${"the desk chunk at first paint".padEnd(38)}      ${
      total + desk <= BUDGET ? `${kb(desk)} more would still fit under ${kb(BUDGET)}` : `${kb(desk)} more is ${kb(total + desk - BUDGET)} over ${kb(BUDGET)}, which is why it is a chunk`}`);
    console.log("");

    if (failed && CHECK) {
      console.error("bytes: the page is heavier than its budget, the themes than theirs, or an asset did not survive the strip");
      process.exitCode = 1;
    }
  } finally {
    try { execFileSync(BIN, ["stop"], { env, stdio: "ignore" }); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
