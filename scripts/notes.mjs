/* A release's notes, from features.toml (#191): what the version lets a
 * reader do, in the words the What's new page uses, above GitHub's list of
 * pull requests (the release workflow passes this as --notes-file beside
 * --generate-notes). The same entries the app shows, so the release page and
 * snyvi.com's changelog, which links to it, say the same thing as the app.
 *
 * The file is read as the subset features.toml keeps to -- [[feature]]
 * blocks of `key = "string"` lines -- so no TOML library is needed here;
 * src/features.rs reads it with a real one, and its test fails the build
 * on anything this would misread.
 *
 *   node scripts/notes.mjs 1.52.0          Markdown on stdout; nothing for
 *                                          a version with no entries
 *   node scripts/notes.mjs 1.52.0 1.50.0   every version after the second
 *                                          too: the release before this one
 *                                          was 1.50.0, and 1.51.0 was never
 *                                          cut on its own
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [version, after] = process.argv.slice(2, 4).map(a => (a || "").replace(/^v/, ""));
const semver = /^\d+\.\d+\.\d+$/;
if (!semver.test(version) || (after && !semver.test(after))) {
  console.error("usage: node scripts/notes.mjs <version> [<the release before>]");
  process.exit(2);
}
const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "features.toml"), "utf8");

const entries = [];
let cur = null;
for (const raw of text.split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  if (line === "[[feature]]") { entries.push(cur = {}); continue; }
  const m = line.match(/^([a-z]+)\s*=\s*"((?:[^"\\]|\\.)*)"$/);
  if (m && cur) cur[m[1]] = m[2].replace(/\\(.)/g, "$1");
}

const mine = entries.filter(e => e.since && (after ? cmp(e.since, after) > 0 && cmp(e.since, version) <= 0 : e.since === version));
const big = mine.filter(e => e.small !== "yes"), small = mine.filter(e => e.small === "yes");
const out = [];
if (big.length) {
  out.push("## What's new", "");
  for (const e of big) out.push(`**${e.title}.** ${e.line}`, "");
}
if (small.length) out.push(`**Smaller things:** ${small.map(e => e.title).join(" · ")}.`, "");
process.stdout.write(out.join("\n"));
