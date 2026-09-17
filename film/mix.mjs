/* The film's soundtrack as one file: each line laid at the second
 * film/beats.js says, the music under all of it, faded in and out and
 * pushed down while a line is being said.
 *
 *   node film/mix.mjs [--out film/audio/mix.mp3]
 *
 * The composition carries one <audio>, so what is heard is decided here and
 * not by a renderer's mixer. Run it after film/audio.mjs, and again after
 * any change to the clock.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(HERE, "audio");
const OUT = resolve(flag("--out") || join(AUDIO, "mix.mp3"));

new Function(readFileSync(join(HERE, "beats.js"), "utf8"))();
const { beats, total } = globalThis.FILM;

const seconds = file => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));

const music = join(AUDIO, "music.mp3");
for (const f of [music, ...beats.map(b => join(AUDIO, `${b.name}.mp3`))]) {
  if (!existsSync(f)) throw new Error(`missing ${f} -- run film/audio.mjs first`);
}

// A line whose mp3 has drifted from what the clock says would put the
// picture out of step with the voice, so say so rather than cut it short.
for (const b of beats) {
  const real = seconds(join(AUDIO, `${b.name}.mp3`));
  if (Math.abs(real - b.line) > 0.06) {
    throw new Error(`"${b.name}" runs ${real.toFixed(3)} s, the clock says ${b.line} -- update film/beats.js`);
  }
  if (b.lead + b.line > b.dur + (b.out ? b.out[1] : 0)) {
    throw new Error(`"${b.name}": the line runs past the scene`);
  }
}

// The composition sets its own scene windows from beats.js at load, but the
// same numbers are in the markup for `lint` to read without running anything,
// and the root's length cannot be set from a script at all -- it is read
// before any of them run. So the two are checked against each other here,
// where the clock is already open.
{
  const html = readFileSync(join(HERE, "index.html"), "utf8");
  const drift = [];
  for (const b of beats) {
    const m = html.match(new RegExp(`id="s-${b.name}"[^>]*data-start="([0-9.]+)" data-duration="([0-9.]+)"`));
    const want = +(b.dur + (b.out ? b.out[1] : 0)).toFixed(3);
    if (!m) drift.push(`index.html has no scene "s-${b.name}"`);
    else if (+m[1] !== b.at || +m[2] !== want) drift.push(`"${b.name}" is ${m[1]}+${m[2]} in index.html, ${b.at}+${want} on the clock`);
  }
  const root = html.match(/data-height="1080" data-duration="([0-9.]+)"/);
  if (!root) drift.push("index.html has no root data-duration");
  else if (+root[1] !== total) drift.push(`the film is ${root[1]} s in index.html, ${total} s on the clock`);
  if (drift.length) throw new Error("index.html and beats.js disagree:\n  " + drift.join("\n  "));
}

const end = total.toFixed(3);
const inputs = [...beats.flatMap(b => ["-i", join(AUDIO, `${b.name}.mp3`)]), "-i", music];
const voice = beats.map((b, i) => `[${i}:a]adelay=${Math.round(b.say * 1000)}:all=1[v${i}]`);
const filter = [
  ...voice,
  `${beats.map((_, i) => `[v${i}]`).join("")}amix=inputs=${beats.length}:normalize=0,`
    + `aresample=44100,apad,atrim=0:${end},asplit[voice][key]`,
  // The bed: quiet, up over two seconds, out over the last three, and cut to
  // the film. The music is shorter than the film by a breath, so it is
  // padded rather than looped -- the tail is under the outro's silence.
  `[${beats.length}:a]aresample=44100,apad,atrim=0:${end},volume=0.26,`
    + `afade=t=in:d=2,afade=t=out:st=${(total - 4).toFixed(3)}:d=3.6[bed]`,
  // Under a line the bed steps back, and returns between them.
  `[bed][key]sidechaincompress=threshold=0.035:ratio=4:attack=40:release=600:level_sc=1[duck]`,
  `[voice][duck]amix=inputs=2:normalize=0,alimiter=limit=0.95,`
    + `afade=t=out:st=${(total - 1).toFixed(3)}:d=1[a]`,
].join(";");

execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs,
  "-filter_complex", filter, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "2", OUT],
  { stdio: ["ignore", "ignore", "inherit"] });

console.log(`${OUT}  ${seconds(OUT).toFixed(2)} s, ${beats.length} lines under ${seconds(music).toFixed(0)} s of music`);
for (const b of beats) console.log(`  ${b.say.toFixed(2).padStart(6)}  ${b.name}`);
