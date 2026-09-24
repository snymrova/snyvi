# The film

The README's demo. A hundred and nine seconds, 1920×1080, narrated, with music.
Every product pixel in it is the current release, photographed by a script
against the real binary — nothing here is a mock-up or a memory of a build.

```
node film/stage.mjs                   # a library, three desks, held-back sends
node film/shoot.mjs                   # the frames, off the real window, on its own display
node film/stage.mjs --stop            # and take the library down
OPENROUTER_API_KEY=… node film/audio.mjs   # the narration and the music
node film/mix.mjs                     # one soundtrack, voice over a ducked bed
cd film && npx hyperframes check      # lint, layout, contrast
cd film && npx hyperframes render --fps 30 --workers 1 --output renders/demo.mp4

# and the copy the README carries, which has to be small enough to upload
ffmpeg -i film/renders/demo.mp4 -c:v libx264 -crf 30 -preset slow \
  -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k docs/media/demo.mp4
```

`--workers 1` on purpose: each worker is a Chrome, and on a machine with a
modest GPU four of them went away mid-render without saying why. One worker
takes about fifteen minutes for the 2,829 frames.

A render can still die part-way with no error at all — the process simply
goes, at frame 213 one time and 539 another. It is memory: a render holds a
headless Chrome, an encoder and 2,829 frames of 1920x1080 going past, and
both times something else on the machine was doing the same thing beside it.
Nothing says so in the log, because the process that would have printed it
is the one that went. On a machine with the memory to itself it finished
three times out of three. So if a render vanishes mid-way, look at free
memory before looking at the composition, and run it again — the retry costs
fifteen minutes and usually is the fix.

The render is about 32 MB, which is the master; CRF 30 puts the same 1920×1080
into 5.7 MB, under GitHub's ceiling for an upload, and a frame of the
source scene — the finest text in the film — is indistinguishable from the
master at 1:1. Anything below CRF 32 was, so the ceiling chose the number.

## The parts

| Path | What it is |
|---|---|
| `DESIGN.md` | the visual direction, and why it is that and not something else |
| `beats.js` | the clock: every scene, when it starts, and the second each line lands on |
| `stage.mjs` | a library worth filming: five projects, three desks, documents sent from inside panels, desk notes |
| `shoot.mjs` | the camera: an Xvfb, a private session bus and the stage's own window, real Claude Code in the panels, writes `frames/` |
| `xdo.py` | keys, pointer and tooltips for the camera, straight at the X server |
| `audio.mjs` | the voice and the music, through OpenRouter, cached by what was asked for |
| `mix.mjs` | lays the lines against `beats.js` and ducks the music under them |
| `index.html` | the composition: twelve scenes, one GSAP timeline: problem, answer, how, summary, tag |
| `frames/` | the stills, at the width the film magnifies them to |
| `audio/` | a line per beat, the bed, and `mix.mp3` — what the film carries |
| `fonts/` | the page's own two faces, copied out of `ui/fonts` by the camera |
| `vendor/` | GSAP, so a render reaches the network for nothing |

`audio/` is committed; `frames/` and `fonts/` are not. The narration cost a
model call and no two calls say a sentence the same way, so it is kept. The
frames are `stage.mjs` and `shoot.mjs` against the release binary -- a few
minutes, most of it real Claude Code sessions answering in the panels -- and
are the release either way. The fonts are the page's own, copied out of
`ui/fonts` by `capture.mjs`, so a film set in a stale copy of them is not a
thing that can happen. Run both in a fresh checkout, or the
composition opens with its pictures and its type missing.

## The clock

`beats.js` is the single source of truth for timing, read by both the
composition and the mixer. Each beat carries `cues`: moments inside a
spoken line, in seconds, taken from the pauses the voice actually leaves —
measured with `silencedetect`, not guessed. That is why the words land on
the words.

Changing a line means re-running `audio.mjs` (which fetches only what
changed), updating that beat's `line` and `cues` in `beats.js`, and
re-running `mix.mjs`.

Nothing is allowed to drift from the clock quietly. `mix.mjs` refuses to
run if an mp3 is more than 60 ms from the length its beat claims, or if a
line would run past its scene, or if the scene windows written in
`index.html` disagree with the ones `beats.js` derives. The composition
sets those windows from `beats.js` itself at load; they are in the markup
as well so `lint` can read them without running anything, and the root's
own `data-duration` has to be there, since it is read before any script
runs. That is three copies of the same seconds, and the mixer is what
keeps them one.

To find the cues for a new line:

```
ffmpeg -i film/audio/<beat>.mp3 -af silencedetect=n=-32dB:d=0.16 -f null -
```

## Saying the name

snyvi is **SNY-vee** — first syllable as in *sky*, second as in *vee*,
`/ˈsnaɪ.viː/`. No text-to-speech model has yet read that off the real
spelling, so `film/audio.mjs` spells it phonetically in the two lines that
say it out loud, and `NAME` is the only place that spelling lives.

It has now been wrong twice, and the second time is the instructive one.
`snyvee` was not enough: the *same voice, in the same take,* said
`/ˈsnaɪvi/` in the reveal and `/ˈsniːviː/` in the outro — a spelling can be
read one way in one sentence and another way three sentences later. So a
spelling that sounds right where you first tried it is not evidence. Check
every line that carries the name, every time one is re-recorded.

Checking does not need ears. A model that takes audio will tell you what it
heard:

```
curl https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H 'Content-Type: application/json' -d '{"model":"google/gemini-3.8-flash","messages":[{"role":"user",
  "content":[{"type":"text","text":"IPA for the made-up name spoken here. Does its first syllable rhyme with SKY, SEE or SIT?"},
  {"type":"input_audio","input_audio":{"data":"<base64 mp3>","format":"mp3"}}]}]}'
```

That is how `snigh-vee` was chosen: six spellings were spoken into both
sentences and listened back to. `sny-vee` gave *SEE*, `Snyvi` gave *SIT*;
`snigh-vee`, `snye-vee`, `sneye-vee` and `snai-vee` all gave *SKY* in both.
`snigh-vee` won because `igh` is the one spelling English never reads any
other way — *high*, *sigh*, *nigh* — so it is the likeliest to survive a
change of model or voice.

## Why stills and not a screen recording

A headless Chromium paints only when something changes, so a screencast of
a document being read comes back at about three frames a second — measured,
on these very beats: twelve frames for 4.2 seconds, twenty-seven for 7.9.
No grade fixes a source with no frames in it.

A still comes back as sharp as it is asked for, and the composition pans
it, punches into it and cuts between them at the full rate. Each is taken
at the width the film actually magnifies it to — 1800 across for a window
held at 1144, 2200 for the one held nearly full frame — because the 2880 a
2x shot gives costs three hundred megabytes of decoded bitmap and six
seconds of load, for pixels nothing ever shows.

The scale is asked of the browser, not cut down afterwards. The first
version shot at 2x and had ffmpeg scale the file, which gave the camera a
dependency the runner that takes these frames on every push does not have —
so the step failed the build the day it was added. Asking Blink to
rasterise at 1.25 instead is one CDP call, needs nothing installed, and
comes out sharper than downsampling a 2x raster, since the glyphs are hinted
at the size they are drawn.

The earlier film was a recording; this one is a cut.

## What `check` says

Lint, runtime, layout, motion and contrast all pass — 28 of 28 text checks
at WCAG AA, 0 layout errors. Two things it says that are answered rather
than fixed:

**Two lint warnings**, both asking for the scenes to be split into
sub-compositions: the file is ~560 lines with twelve timed elements on one
track. It is one file on purpose. The cut between two scenes animates both
of them at once, and a sub-composition's timeline cannot reach outside
itself, so splitting would mean hoisting every transition back into the
parent — the same code, in two places instead of one.

**A handful of layout notes**, and every one of them is a punch-in or a cut:
an image scaled inside the window that clips it, a scrim bleeding off-frame
on purpose, and wherever a sample lands mid-transition, the outgoing scene's
text sitting under the incoming one — which is what a cut looks like to a
static audit. How many there are depends on where the sweep happens to
sample, so the number moves. The things that were real when the audit first
ran — a title-bar label at 3.56:1 and a terminal label at 4.12:1 — were
fixed, not marked.

The elements that are genuinely decorative say so in the markup:
`data-layout-ignore` on the wall of raw text in the opening, which is
texture and is meant to be unreadable, and `data-layout-allow-overlap` on
the three struck words, whose boxes overlap for the 400 ms each is
arriving.
