/* The film's sound: the narration, one line per beat, and a music bed,
 * each asked of OpenRouter once and kept under ~/.cache/snyvi-media by
 * the hash of what was asked for. A changed word costs one line; the same
 * words cost nothing.
 *
 *   OPENROUTER_API_KEY=... node film/audio.mjs [--out film/audio]
 *
 * Writes film/audio/<beat>.mp3 for each line, film/audio/music.mp3, and
 * film/audio/lines.json with how long each line runs, which index.html
 * reads to place its scenes.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = resolve(flag("--out") || "film/audio");
const ONLY = flag("--only");

// The name is written the way it is said -- sny as in sky, then vee --
// since spelt as it is, a voice says it three ways in one film. "snyvee"
// was not enough: the same voice read it /snaivi/ in the reveal and
// /sniivii/ in the outro, from the same spelling, in the same take. "igh"
// is the spelling English never reads any other way -- high, sigh, nigh --
// and it held in both places. Changing it means re-recording every line
// below that carries the name, and checking what came back: see
// film/README.md, "Saying the name".
const NAME = "snigh-vee";
export const LINES = {
  hook:    "Your agents write all day. Plans. Reviews. Reports. And you read them... as raw text, in a terminal.",
  reveal:  `Meet ${NAME}. A fast, beautiful viewer for everything your agents produce.`,
  ask:     "Ask Claude Code for a plan. It writes one. And sends it. One real MCP call: send document.",
  arrive:  "By the time you read the reply, it's already open. Rendered. Filed under the project.",
  queue:   "A new document never steals the page. It waits at the top. N opens it.",
  diff:    "C shows exactly what changed since the last version.",
  diagram: "Diagrams draw themselves, in the page's own colours.",
  search:  "Command K searches everything every agent has ever sent. Code included.",
  source:  "Source files, highlighted, with an outline. Ten thousand lines of Rust, in a hundred and forty-three milliseconds.",
  numbers: "One static binary. Twelve megabytes. Cold start in eleven milliseconds. And nothing phones home.",
  agents:  "Claude Code, Codex, Cursor, Gemini, Zed. Any agent that speaks MCP. One command each.",
  outro:   `Agents send. ${NAME} shows. Get it on GitHub.`,
};

const TTS_MODEL = process.env.SNYVI_TTS_MODEL || "minimax/speech-2.8-hd";
const TTS_VOICE = process.env.SNYVI_TTS_VOICE || "English_expressive_narrator";
const TTS_STYLE = process.env.SNYVI_TTS_STYLE || "Energetic, confident product-launch narrator. Punchy and fast-paced, warm, with a smile. Land each short sentence.";
/* Every line that says the name is listened back to, because this has been
 * wrong twice and both times silently: a spelling read correctly in one
 * sentence was read another way three sentences later, in the same take. A
 * model that takes audio says what it heard, which is the only check that
 * does not need a person with headphones. SNYVI_HEAR=0 turns it off. */
const HEAR_MODEL = process.env.SNYVI_HEAR_MODEL || "google/gemini-3.8-flash";
const SAID = "SKY";   // what the first syllable of the name must rhyme with

const MUSIC_MODEL = process.env.SNYVI_MUSIC_MODEL || "google/lyria-3-pro-preview";
const MUSIC = process.env.SNYVI_MUSIC || "Instrumental only, absolutely no vocals. An upbeat, driving, modern electronic track for a software product launch video: crisp punchy drums at 118 bpm, a warm analog synth bass pulse, bright plucked arpeggios, rising energy with a clear lift about a third of the way in, confident and optimistic, polished and cinematic. Starts on the beat from the first second, steady throughout, no long intro, no drops to silence. About ninety seconds.";

async function main() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  mkdirSync(OUT, { recursive: true });
  const cache = join(homedir(), ".cache", "snyvi-media");
  mkdirSync(cache, { recursive: true });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const seconds = file => parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
  const kept = async (what, id, fetchIt) => {
    const file = join(cache, `${createHash("sha256").update(JSON.stringify(id)).digest("hex").slice(0, 16)}.mp3`);
    if (!existsSync(file)) {
      process.stdout.write(`  ${what} ...`);
      const res = await fetchIt();
      if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
      writeFileSync(file, await fetchIt.read(res));
      console.log(` ${seconds(file).toFixed(1)} s`);
    }
    return file;
  };

  const lines = {};
  for (const [name, input] of Object.entries(LINES)) {
    if (ONLY && ONLY !== name && ONLY !== "lines") continue;
    const body = { model: TTS_MODEL, voice: TTS_VOICE, input, response_format: "mp3" };
    if (TTS_STYLE) body.instructions = TTS_STYLE;
    const speak = () => fetch("https://openrouter.ai/api/v1/audio/speech", { method: "POST", headers, body: JSON.stringify(body) });
    speak.read = async res => Buffer.from(await res.arrayBuffer());
    const file = await kept(`"${name}"`, ["tts", TTS_MODEL, TTS_VOICE, TTS_STYLE, input], speak);
    // Trimmed of the silence a model leaves at either end, so a line's
    // length is the words' length and the cut lands on them.
    const out = join(OUT, `${name}.mp3`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file,
      "-af", "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.12,areverse,loudnorm=I=-16:TP=-1.5:LRA=9",
      "-c:a", "libmp3lame", "-q:a", "2", out]);
    lines[name] = { text: input, seconds: +seconds(out).toFixed(3) };
    if (input.includes(NAME)) await heard(name, out, headers);
  }

  if (!ONLY || ONLY === "music") {
    const play = () => fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: MUSIC_MODEL, modalities: ["audio", "text"], audio: { format: "mp3" }, stream: true, messages: [{ role: "user", content: MUSIC }] }) });
    play.read = async res => {
      let b64 = "";
      for (const line of (await res.text()).split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const j = JSON.parse(line.slice(6));
        if (j.error) throw new Error(`music: ${JSON.stringify(j.error).slice(0, 300)}`);
        b64 += j.choices?.[0]?.delta?.audio?.data || "";
      }
      if (!b64) throw new Error("music: the stream carried no audio");
      return Buffer.from(b64, "base64");
    };
    const music = await kept("music", ["music", MUSIC_MODEL, MUSIC], play);
    copyFileSync(music, join(OUT, "music.mp3"));
    lines.music = { seconds: +seconds(music).toFixed(3) };
  }

  const prev = existsSync(join(OUT, "lines.json")) ? JSON.parse(readFileSync(join(OUT, "lines.json"), "utf8")) : {};
  writeFileSync(join(OUT, "lines.json"), JSON.stringify({ ...prev, ...lines }, null, 2) + "\n");
  const spoken = Object.entries(lines).filter(([k]) => k !== "music");
  console.log(`  ${spoken.length} lines, ${spoken.reduce((s, [, l]) => s + l.seconds, 0).toFixed(1)} s spoken, ${TTS_MODEL} as ${TTS_VOICE}${lines.music ? `; music ${lines.music.seconds.toFixed(0)} s` : ""}`);
}

/** What a listener makes of the name in a line that says it. Throws when it
 *  hears the wrong vowel; says so and carries on when it cannot tell, since
 *  a reachability problem is not a mispronunciation. */
async function heard(beat, file, headers) {
  if (process.env.SNYVI_HEAR === "0") return;
  const ask = [
    { type: "text", text: "A made-up product name is spoken in this clip. Answer in two lines and nothing else:\n1) IPA for the name as actually spoken\n2) Does its FIRST syllable rhyme with SKY, or SEE, or SIT? Answer with one of those three words." },
    { type: "input_audio", input_audio: { data: readFileSync(file).toString("base64"), format: "mp3" } },
  ];
  let said;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model: HEAR_MODEL, messages: [{ role: "user", content: ask }] }) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(JSON.stringify(j.error ?? j).slice(0, 200));
    said = j.choices[0].message.content.trim();
  } catch (e) {
    console.log(`  ! "${beat}" says the name and could not be listened back to (${e.message}); check it by ear`);
    return;
  }
  const rhyme = (said.match(/\b(SKY|SEE|SIT)\b/i) || [])[1]?.toUpperCase();
  const ipa = (said.match(/\/[^/]+\//) || [])[0] ?? "?";
  if (rhyme && rhyme !== SAID) {
    throw new Error(`"${beat}" says the name as ${ipa} -- its first syllable rhymes with ${rhyme}, not ${SAID}.\n`
      + `  The spelling in NAME is what the model reads, and the same spelling can be read\n`
      + `  two ways in two sentences. Try another one and run this again; film/README.md,\n`
      + `  "Saying the name", has the ones already tried.`);
  }
  console.log(`  "${beat}" says the name ${ipa}${rhyme ? ` (${rhyme})` : ""}`);
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
