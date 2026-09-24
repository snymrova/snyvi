# The film — visual direction

The README's film. A hundred and nine seconds, 1920×1080, narrated, cut in
HyperFrames from stills of the real release. `film/index.html` is the
composition; everything below is why it looks the way it does.

## The argument

The agent works where you can see it, and what it writes lands where you
can read it. The film makes that argument twice — once in what it shows,
once in how it is set.

It is told as a problem and its answer, in four parts. The cut before this
one introduced the product and then listed features; the user wanted the
reason first -- the era of building many passion projects at once, with an
agent on each, and the work scattering between them:

1. **The problem.** More passion projects than hours in the day, and with
   agents you can build them all at once (the four staged projects arrive,
   each with an agent at work). But the work scatters: plans lost in
   scrollback, to-dos in your head, focus gone every time you switch.
2. **The answer.** snyvi keeps it in order: one desk for each project, and
   everything the agents write kept where you can read it.
3. **How**, each scene answering a part of the problem: a desk for each
   project; nothing scrolls away; filed and kept (inbox and versions); out of
   your head (desk notes); just as you left it (switching desks, search); any
   agent; private and fast. Every one is a photograph of the real window.
4. **What that adds up to.** All your passion projects, one calm place.
   Free, open source, MIT, on GitHub.

Then a tag.

- **All of it is dark.** The film's ground is near-black and cool, and the
  window is shot in snyvi's dark theme to match (`film/shoot.mjs` runs its
  window under a dark GTK theme; `--light` for the paper version). The
  earlier cuts put a bone-paper window on the dark ground, and every change
  of picture was a bright slab arriving and leaving.
- **The frames are the window, not the page.** They are photographed off the
  running desktop application — its own header, its own controls, real Claude
  Code sessions in the panes — because the claim is that this is a program on
  your machine, and a screenshot of a page in a headless browser is the one
  thing that cannot show it. The shutter is 1280 across, which is where the
  window opens, so nothing is ever drawn wider than that.
- **One voice in the type.** Everything the film says is set in Archivo:
  titles semibold at 112% width, sentences regular at normal width. Inter
  appears only in the wordmark, because that is how snyvi draws its own name;
  JetBrains Mono only where something is really typed -- a key, a command.

## Palette

| Token     | Value     | Role                                                 |
| --------- | --------- | ---------------------------------------------------- |
| `ground`  | `#0a0c11` | the desktop; every scene's floor                     |
| `panel`   | `#141821` | terminal body, stat blocks, raised surfaces          |
| `rule`    | `#272d3a` | hairlines, borders, keycap edges                     |
| `ink`     | `#ece9e3` | display text on the dark                             |
| `mute`    | `#8b93a3` | labels, eyebrows, secondary mono                     |
| `flame`   | `#f04a63` | the accent: keys pressed, numbers, the mark's light  |
| `ember`   | `#d9203b` | the mascot's own red; deep accent, glows             |
| `bone`    | `#faf9f6` | the product's paper, in the light version only       |

One accent hue, warm, on a cool ground: the red is the only warm thing in
the dark, and it is the same red as the mark.

The accent is **Passion**, which is what snyvi wears out of the box —
`--accent-d` in `ui/app.css`, the value the product shows on a dark page,
and `--mascot` for the deeper one. Both are read from the product rather
than chosen here.

This was orange until 1.3: `#e0763e` and `#c2410c`, against a mark that was
a rounded square with three white lines in it. The mark is a face now and
the accent is red, and for a while the film was the only thing still wearing
the old one — which is the argument for copying `icons/icon.svg` into the
lockups verbatim rather than redrawing it here.

## Type

| Role     | Face            | Setting                                        |
| -------- | --------------- | ---------------------------------------------- |
| Title    | Archivo         | 600, 112% width, 92px, tracking −0.028em       |
| Sentence | Archivo         | 400, 34px/1.38, `soft` on the ground           |
| Key      | JetBrains Mono  | 500, inline in the sentence, pressed on the word |
| Command  | JetBrains Mono  | 500, 27px, on a `raise` chip                   |
| Wordmark | Inter           | 600, lockups only                              |

An earlier cut set its statements in Source Serif 4 at 900, its asides in
the italic, and its labels in letter-spaced uppercase mono with a red tick
and a section number ("01 / 08 · DESKS"). Every one of those is a stock move
of generated design, and together they read as one. So: no eyebrows, no
section numbers, no italic asides, no monospace for anything that is not
typed, no stat cards, no keycap badges, no glows and no grain. A scene is a
title, one sentence, and the window.

## Motion

- Every scene is built at its hero frame, then animated into.
- Entrances only. The transition is the exit; the last scene alone fades out.
- Eases carry meaning: `expo.out` for things that arrive (the document, the
  window), `power4.out` for things that are struck (keycaps, stat numbers),
  `sine.inOut` for ambient drift, `power2.inOut` for pushes between scenes.
- The narration leads. Every entrance is pinned to a measured pause in the
  voice track, not to a guess — `film/beats.js` carries the seconds.

### Transitions

| Cut        | Transition         | Why                                               |
| ---------- | ------------------ | ------------------------------------------------- |
| 1 → 2      | push left, 0.45s   | from the projects to what happens to their work   |
| 2 → 3      | dissolve, 0.6s     | from the problem into the answer                  |
| 3 → 9      | hold, 0.5s         | the window stays; the next photograph fades in it |
| 9 → 10     | push up, 0.5s      | a section change: from what it does to what it is |
| 10 → 11    | push left, 0.4s    | into the summary                                  |
| 11 → 12    | hard cut           | the film has ended; the tag is not part of it     |

**No frame of a change is darker than either end of it.** Scenes paint no
ground of their own -- the root does -- because when each carried one, the
incoming scene blanked the outgoing the instant it began and faded up from
nothing: a dip to dark on every cut, which read as a flicker. From the
answer to the agents the window never moves: the next photograph crossfades
into it over the one before, which stays fully up until it is covered, and
only the words beside it change.

**The camera** moves inside the window, not the window: when the line points
at part of the shot, the shot eases towards it, never past 1.15 -- the
frames are 1280 across and shown at 1098, so beyond that it would be
magnifying past their own pixels.

Where a line names a part of the frame -- the folder, the new document, the
terminals, the notes -- a ring in the accent is drawn over that part of the
photograph, struck on the word. It is the only thing the film draws on top
of the product, placed in fractions of the 1280x860 shot so it stays on its
target at whatever width the window is shown.

## The voice

A man's voice, MiniMax `English_ManWithDeepVoice`, read *courteous, warm
and quietly authoritative, like a trusted senior engineer introducing
something he is proud of*. Nine male voices were read the same
line and rated by a model that takes audio; this one and
`English_Steadymentor` rated highest for authority, and Steadymentor was
slower. A woman's voice read the cut before this one, and was the wrong
register for it. The tag has its own read -- *dry and deadpan, the mask
slipping for a moment* -- set per line in `film/audio.mjs`.

## snyvi, in the film

The mascot peeks over the bottom-left edge and watches the film with the
faces the app gives it (`ui/app.js`, FACES; the hop is `bm-hop`): it looks
up at the opening statement, is taken aback when the projects pile up,
sorry when the work scatters, and ducks out for the answer, where its face
is the logo's -- glad at its own name. From the desk on it reacts the way it
does in the app: wide-eyed when a document arrives, a wink on the key, glad
on "not in your head", eyes following the switch. It leaves the summary to
the logo, which gets the rare face, the hearts. It never speaks and never
covers the product.

## One more thing

After the summary, so the film's real ending -- the address -- lands first,
the music leaves and the voice says there is a rocket. There is: snyvi in a
helmet, over the sidebar, the game the rocket button at the foot of the
sidebar opens. The joke is only worth making because it is true of the
product: the game covers the sidebar and nothing else, so the terminals keep
working beside it and a document that arrives while you play still arrives.
The scene is twenty-four stills of that, played as a flip-book, then a hard
cut to black and the address, quietly.

## The first frame is the poster

GitHub shows frame 0 under the play button, so it is the only frame most
people will ever see. It has to say something. The opening scene's
statement -- "More passion projects than hours in the day." -- is up from the
first frame rather than faded in, the one place in the film where an element
does not animate in; the projects arrive beside it with the voice.

Keep that true of any re-cut: whatever scene runs first, frame 0 must read.

## What not to do

- No gradient text, no neon, no purple-to-blue, no cyan. The accent is the
  mark's red and nothing else — and when the mark changes, this changes.
- No pure `#000` or `#fff`: the dark is tinted blue, the paper is bone.
- No stock UI mock-ups, and no illustration of the product either. Every
  product pixel comes from `film/shoot.mjs` photographing the real window
  that `film/stage.mjs` put a library into. The scene that used to draw a
  terminal in HTML is the reason for the second half of that rule: it was
  honest when it was written and quietly false a release later, because
  nothing re-took it.
- No window chrome of the film's own. The frames carry the application's,
  and drawing a second bar above them gave every scene two.
- No claim the bench cannot support. The numbers on screen are the ones the
  README states: the 11 ms cold start, one binary, 127.0.0.1 only. The old
  cut said twelve megabytes; the binary is past fourteen, and the README
  never said twelve.
