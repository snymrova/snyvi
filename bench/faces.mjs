/* The expression sheet: snyvi's six faces, drawn from `FACES` in ui/app.js
 * and nowhere else, at the peek's 72 px on the light ground and the dark,
 * each with its name under it. docs/DESIGN.md §2.2 closes the list of faces
 * and says never to redraw one by hand; this is how a picture of them is
 * made without doing that.
 *
 *   node bench/faces.mjs [--out docs/media/faces.svg]
 *
 * Nothing is measured. It reads the page's source, takes the block that
 * defines the faces and the two builders, runs it, and writes one SVG. The
 * colours are the page's tokens on the default accent, written out, since a
 * file on its own has no stylesheet: the body, the nub (the brand), the ink,
 * the blush and the light in the eyes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(flag("--out") || join(HERE, "..", "docs", "media", "faces.svg"));

const src = readFileSync(join(HERE, "..", "ui", "app.js"), "utf8");
const from = src.indexOf("  const EYE = ");
const to = src.indexOf('.join("") + "</svg>");', from);
if (from < 0 || to < 0) throw new Error("faces: FACES, mascotHead or mascotPeek moved in ui/app.js");
const block = src.slice(from, to + '.join("") + "</svg>");'.length);
const { FACES, mascotPeek } = new Function(`${block}\nreturn { FACES, mascotHead, mascotPeek };`)();

// The tokens, as ui/app.css sets them on the default accent (--brand is
// --accent-l, the same in every theme; --mascot-ink is 40% of it on black).
const INK = { "mk-body": "#d9203b", "mk-nub": "#8c0f26", "mk-ink": "#38060f", "mk-cheek": "#f0607e", "mk-love": "#f0607e", "mk-puff": "#f0607e", "mk-shine": "#fff" };
const GROUNDS = [["light", "#faf9f6", "#6b6660"], ["dark", "#15181f", "#8a8f99"]];
const CELL = 112, PAD = 24, FACE = 72, LABEL = 22, ROW = PAD + FACE + LABEL + PAD;
const names = Object.keys(FACES);
const W = PAD * 2 + CELL * names.length, H = ROW * GROUNDS.length;

/** One face at 72 px, its classes turned into fills so the file stands alone. */
function face(name) {
  return mascotPeek(name)
    .replace(/<svg class="mk" viewBox="0 0 32 32" aria-hidden="true">/, `<g transform="scale(${FACE / 32})">`)
    .replace(/<\/svg>$/, "</g>")
    .replace(/class="mk-line"/g, `fill="none" stroke="${INK["mk-ink"]}" stroke-width="2.2" stroke-linecap="round"`)
    .replace(/class="(mk-[a-z]+)"/g, (_, c) => `fill="${INK[c] || "none"}"`);
}

let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="snyvi's six faces: ${names.join(", ")}">\n` +
  `<!-- Drawn by bench/faces.mjs from FACES in ui/app.js. Edit the faces there, not here. -->\n` +
  `<style>text{font:500 12px/1 system-ui,sans-serif;text-anchor:middle}</style>\n`;
GROUNDS.forEach(([which, bg, fg], r) => {
  const y = r * ROW;
  out += `<rect x="0" y="${y}" width="${W}" height="${ROW}" fill="${bg}"/>\n`;
  names.forEach((name, i) => {
    const x = PAD + i * CELL + (CELL - FACE) / 2;
    out += `<g transform="translate(${x} ${y + PAD})">${face(name)}</g>\n` +
      `<text x="${x + FACE / 2}" y="${y + PAD + FACE + LABEL - 4}" fill="${fg}">${name}</text>\n`;
  });
  out += `<!-- ${which} -->\n`;
});
out += "</svg>\n";
writeFileSync(OUT, out);
console.log(`faces: ${names.length} faces on ${GROUNDS.length} grounds → ${OUT} (${out.length} bytes)`);
