/* How big the pieces are, counted.
 *
 * An agent works in a file the way a reader does: it opens it, finds the
 * place, edits an anchor that must be unique, and verifies. A 7,000-line
 * module and a 370-line function defeat all four steps, and they got that way
 * one reasonable commit at a time. This is the ratchet that stops the next
 * one: it counts lines per file under src/ and ui/, and lines per function,
 * and holds both against bench/size.baseline.json.
 *
 * Two ceilings, from the plan that introduced this (docs/MODULES.md):
 *
 *   FILE_MAX   2,500 lines   a module one session can hold in its head
 *   FN_MAX       120 lines   a function one screen can show
 *
 * Below a ceiling nothing is counted, so a file may grow until it reaches
 * one. At or over a ceiling a file or function may only shrink: a push fails
 * when one that is over grew, or when a new one appears over. A change that
 * splits a module lowers the baseline in the same commit (`--write`).
 *
 * It is a count, not a parser. A Rust `fn` runs from its signature to the
 * first `}` at the same indent; a JavaScript function the same from a
 * `function name(` or `const name = (...) =>` line. rustfmt and the house
 * style both indent that way, and a count that is wrong the same way every
 * run is all a ratchet needs.
 *
 *   node bench/size.mjs            report: every file and function over a ceiling
 *   node bench/size.mjs --check    and exit non-zero if one grew or appeared
 *   node bench/size.mjs --write    take the current counts as the baseline
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BASELINE = join(HERE, "size.baseline.json");
const CHECK = process.argv.includes("--check");
const WRITE = process.argv.includes("--write");

export const FILE_MAX = 2500;
export const FN_MAX = 120;

/** Every .rs under src/ and every .js under ui/ (not the vendored Mermaid). */
function sources() {
  const out = [];
  const walk = (dir, re) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, re);
      else if (re.test(name)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "src"), /\.rs$/);
  walk(join(ROOT, "ui"), /^(?!mermaid).*\.js$/);
  return out.sort();
}

const RUST_FN = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/;
const JS_FN = /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
const JS_ARROW = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*$/;

/** `name -> lines` for every function in the text that is over FN_MAX. */
function functions(text, rust) {
  const lines = text.split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = rust ? RUST_FN.exec(lines[i]) : JS_FN.exec(lines[i]) || JS_ARROW.exec(lines[i]);
    if (!m) continue;
    const indent = m[1], name = m[2];
    // A one-line body, or a trait signature ending in `;`, has no block.
    if (/;\s*$/.test(lines[i]) && !/\{/.test(lines[i])) continue;
    let end = i;
    const close = rust ? new RegExp(`^${indent}\\}\\s*$`) : new RegExp(`^${indent}\\}[;,)]?\\s*$`);
    for (let j = i + 1; j < lines.length; j++) {
      if (close.test(lines[j])) { end = j; break; }
      // Another item at the same indent means this one had no block of its own.
      if (lines[j].length > indent.length && !lines[j].startsWith(indent + " ") && !lines[j].startsWith(indent + "\t") && /\S/.test(lines[j]) && j > i) break;
    }
    const n = end - i + 1;
    if (n > FN_MAX) out[`${name}:${i + 1}`] = n;
  }
  return out;
}

/** Strip the position from a key, so a function that moved is still itself. */
const nameOf = key => key.replace(/:\d+$/, "");

function measure() {
  const out = { files: {}, functions: {} };
  for (const file of sources()) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (n > FILE_MAX) out.files[file] = n;
    const fns = functions(text, file.endsWith(".rs"));
    for (const [key, k] of Object.entries(fns)) out.functions[`${file}::${nameOf(key)}`] = Math.max(out.functions[`${file}::${nameOf(key)}`] ?? 0, k);
  }
  return out;
}

const now = measure();
const was = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const bad = [];

const judge = (kind, ceiling) => {
  const entries = Object.entries(now[kind]).sort((a, b) => b[1] - a[1]);
  console.log(`\n  ${kind} over ${ceiling} lines: ${entries.length}`);
  for (const [name, n] of entries) {
    const b = was?.[kind]?.[name];
    const mark = b === undefined ? (was ? "NEW" : "") : n > b ? `UP from ${b}` : n < b ? `down from ${b}` : "";
    if (was && (b === undefined || n > b)) bad.push(`${name} ${n}${b === undefined ? "" : ` (was ${b})`}`);
    if (!CHECK || mark) console.log(`    ${name.padEnd(48)} ${String(n).padStart(6)}   ${mark}`);
  }
};

console.log(`size${was ? "" : "   (no baseline yet: node bench/size.mjs --write)"}`);
judge("files", FILE_MAX);
judge("functions", FN_MAX);

if (WRITE) {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
  console.log(`\nbaseline written: ${BASELINE}`);
} else if (bad.length) {
  console.error(`\nsize: over a ceiling and grew, or new over a ceiling:\n    ${bad.join("\n    ")}\n  Split it in this change, or say why in the commit and --write.`);
  if (CHECK) process.exit(1);
} else if (was) {
  console.log("\n  nothing over a ceiling grew");
}
