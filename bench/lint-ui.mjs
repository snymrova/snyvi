/* The design system's debt, counted.
 *
 * docs/DESIGN.md is the page every UI change is checked against, and §9.3
 * says how it is kept: not by a reviewer's eye, which drifts, but by counts a
 * machine takes the same way every time. This is that machine. It reads
 * `ui/` the way the rules do -- the stylesheets, the CSS strings and the
 * markup the scripts write, and index.html -- and counts each thing DESIGN.md
 * says should not be there: a raw colour, a font size off the scale, a raw
 * duration, a z-index nobody named, a focus outline taken away with nothing in
 * its place, a `title` the OS will draw its own box for, a raw error in front
 * of the maker, a banned word, a button nested in a link.
 *
 * The code had all of these before the rules did, so a lint that failed on
 * any of them would be red on every push and teach a reader to ignore it.
 * It runs in report mode instead: each count is held against
 * bench/lint-ui.baseline.json, and a push fails only when a count goes *up*.
 * A change that pays debt lowers the baseline in the same commit
 * (`--write`), so the file is the running score of the 1.8 refactor.
 *
 * It is a count, not a parser. A rule that matches too much or too little
 * matches it the same way on every run, which is all a ratchet needs; the
 * allow-list below is DESIGN.md §9.3's, and a new entry names its reason.
 *
 *   node bench/lint-ui.mjs            report, per check and per file
 *   node bench/lint-ui.mjs --check    and exit non-zero if any count went up
 *   node bench/lint-ui.mjs --write    take the current counts as the baseline
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = resolve(HERE, "..", "ui");
const BASELINE = join(HERE, "lint-ui.baseline.json");
const CHECK = process.argv.includes("--check");
const WRITE = process.argv.includes("--write");

/* The type scale (DESIGN §6.2), and the reading sizes that sit outside it. */
const SCALE = new Set([11, 12, 13, 14, 15, 17, 18, 20, 26, 34]);

/* themes.css is where colours live; everything else reads them. */
/* app.js and desk.js are kept as parts (ui/app/, ui/desk/; src/strip.rs
 * joins them), so each part is read on its own and named by its path. */
const FILES = [
  ...readdirSync(UI).filter(f => /\.(css|js)$/.test(f) && f !== "themes.css"),
  ...["app", "desk", "studio"].flatMap(d => readdirSync(join(UI, d)).filter(f => f.endsWith(".js")).map(f => `${d}/${f}`)),
  "index.html",
].sort();

/** Comments out, so a rule written about in prose is not a rule broken. */
function uncomment(text, css) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return css ? text : text.replace(/^\s*\/\/.*$/gm, "");
}

/** The colour blocks: `:root`, a `[data-theme]`, the derivation. A colour
 *  there is a token being defined, not one being used. */
function untheme(text) {
  return text.replace(/(?<=^|[{}])[^{}]*(?::root|\[data-theme[^\]]*\]|\[data-accent[^\]]*\])[^{}]*\{[^{}]*\}/g, "");
}

/** Every `selector { body }` in the text, near enough: CSS strings in a
 *  script are found the same way, since a rule is a rule wherever it is
 *  written. Nested blocks (@media) give their inner rules. */
function rules(text) {
  const out = [];
  for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) out.push({ sel: m[1].trim(), body: m[2] });
  return out;
}

const count = (text, re) => (text.match(re) || []).length;

/* The allow-list (DESIGN §9.3), as patterns a hit's own line is tested
 * against. `white-space` is never a colour; the #fff behind a previewed
 * HTML page is the page's, not ours; the #000 in a mask is an alpha channel;
 * the serialisers write colours out rather than draw with them. */
const ALLOW_COLOUR = [/mask(-image)?:/, /\.html-frame|iframe|srcdoc/, /xterm|cube|ansi256|256/i];
const ALLOW_COLOUR_FILES = new Set(["boot.js", "mmd.js"]);

const CHECKS = {
  colour: {
    what: "raw colours outside :root and themes.css",
    run(text, file) {
      if (ALLOW_COLOUR_FILES.has(file)) return 0;
      let n = 0;
      for (const line of untheme(text).split("\n")) {
        if (ALLOW_COLOUR.some(re => re.test(line))) continue;
        n += count(line.replace(/var\([^)]*\)/g, ""), /(?:^|[\s:,(])(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()(?=[\s\d.,%)#a-f]|$)/gi);
      }
      return n;
    },
  },
  "font-size": {
    what: "px font sizes not on the type scale",
    run(text) {
      let n = 0;
      for (const m of text.matchAll(/font(?:-size)?\s*:\s*([^;"`}]*)/g))
        for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) if (!SCALE.has(Number(px[1]))) { n++; break; }
      return n;
    },
  },
  duration: {
    what: "raw ms/s in transitions and animations",
    run(text) {
      let n = 0;
      for (const m of text.matchAll(/(?:transition|animation)(?:-duration|-delay)?\s*:\s*([^;"`}]*)/g))
        n += count(m[1].replace(/var\([^)]*\)/g, ""), /(?:^|[\s,])\d*\.?\d+m?s\b/g);
      return n;
    },
  },
  "z-index": {
    what: "z-index numbers (a local 0-5 is allowed)",
    run(text) {
      let n = 0;
      for (const m of text.matchAll(/z-index\s*:\s*(-?\d+)/g)) if (Math.abs(Number(m[1])) > 5) n++;
      return n;
    },
  },
  outline: {
    what: "outline: none with nothing in its place",
    run(text) {
      let n = 0;
      for (const { sel, body } of rules(text))
        if (/outline\s*:\s*(none|0)\b/.test(body) && !/box-shadow|border(-color)?\s*:|:focus-visible/.test(body + sel)) n++;
      return n;
    },
  },
  title: {
    what: "title= and .title = (the tip replaces them)",
    run(text) {
      // An iframe's title names the frame to a screen reader; no tip replaces it.
      text = text.replace(/i?frame\.setAttribute\(\s*["']title["']/gi, "");
      return count(text, /\stitle="|\stitle=\$\{|\stitle=\\?"|setAttribute\(\s*["']title["']/g)
        + count(text.replace(/document\.title/g, ""), /\.title\s*=[^=]/g);
    },
  },
  "raw-error": {
    what: "String(e) / e.message where the maker reads it",
    run(text) {
      // sayErr itself, a test on the text, and the raw kept for a tip or a
      // <details> are the places the raw text is meant to be.
      const outside = text.replace(/function sayErr[\s\S]*?\n  \}\n/, "")
        .replace(/\.test\(String\((?:e|err)\)\)|raw: e\.message|e && e\.message \? e\.message : (?:String\()?e\)?/g, "");
      return count(outside, /String\((?:e|err|error)\)|\b(?:e|err|error)\.message\b/g);
    },
  },
  words: {
    what: "banned words (DESIGN §3.3, §3.4)",
    run(text, file) {
      // A line that asks which platform it is on is writing the key for it.
      text = text.split("\n").filter(l => !/\bMac\b|\bMAC\b/.test(l)).join("\n");
      const strings = [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).join("\n");
      let n = count(strings, /\b(?:Let go|Take off|Put away|Clear done|Kill)\b|Undo for \d|\(Esc\)|\S {2,}(?:⌘|⌃|Ctrl|Esc)\b/g);
      if (!file.startsWith("app/")) n += count(strings, /⌘/g);
      return n;
    },
  },
  nesting: {
    what: "<button> inside <a> or <summary>",
    run(text) {
      return count(text, /<a\b[^>]*>(?:(?!<\/a>)[\s\S]){0,400}?<button\b/g) + count(text, /<summary\b[^>]*>(?:(?!<\/summary>)[\s\S]){0,400}?<button\b/g);
    },
  },
  "toast-title": {
    what: "toast titles with ! or Title Case",
    run(text) {
      let n = 0;
      for (const m of text.matchAll(/toast\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g))
        if (/!/.test(m[2]) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(m[2].replace(/^\S+ /, ""))) n++;
      return n;
    },
  },
};

function measure() {
  const out = {};
  for (const name of Object.keys(CHECKS)) out[name] = { total: 0, files: {} };
  for (const file of FILES) {
    const path = join(UI, file);
    if (!existsSync(path)) continue;
    const text = uncomment(readFileSync(path, "utf8"), file.endsWith(".css"));
    for (const [name, c] of Object.entries(CHECKS)) {
      const n = c.run(text, file);
      if (n) { out[name].files[file] = n; out[name].total += n; }
    }
  }
  return out;
}

const now = measure();
const was = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
let up = false;

console.log(`ui lint${was ? "" : "   (no baseline yet: node bench/lint-ui.mjs --write)"}\n`);
for (const [name, c] of Object.entries(CHECKS)) {
  const n = now[name].total, b = was?.[name]?.total;
  const mark = b === undefined ? "" : n > b ? `UP from ${b}` : n < b ? `down from ${b}` : "ok";
  if (b !== undefined && n > b) up = true;
  console.log(`  ${c.what.padEnd(46)} ${String(n).padStart(4)}   ${mark}`);
  if (!CHECK || n !== b) {
    const files = Object.entries(now[name].files).map(([f, k]) => {
      const d = k - (was?.[name]?.files?.[f] ?? 0);
      return `${f} ${k}${was && d ? ` (${d > 0 ? "+" : ""}${d})` : ""}`;
    });
    if (files.length && (n !== b || !CHECK)) console.log(`      ${files.join(" · ")}`);
  }
}

if (WRITE) {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
  console.log(`\nbaseline written: ${BASELINE}`);
} else if (up) {
  console.error("\nui lint: a count went up. Pay it in this change, or say why in the commit and --write.");
  if (CHECK) process.exit(1);
}
