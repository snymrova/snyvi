# The film — visual direction

The README's film. Ninety-four seconds, 1920×1080, narrated, cut in
HyperFrames from stills of the real release. `film/index.html` is the
composition; everything below is why it looks the way it does.

## The argument

snyvi turns a stream of tokens into a document a person reads. The film
makes that argument twice — once in what it shows, once in how it is set.

- **The dark is the terminal.** The film's ground is the desktop the agent
  runs on: near-black, cool, unlit.
- **The light is the document.** Every product frame is bone paper, warm,
  and it is the only light in the film. It arrives; it is not there at the
  start.
- **The type is the same argument.** The machine speaks in JetBrains Mono —
  keys, commands, numbers, the terminal. The document speaks in Source Serif
  4 at its display cut. Fixed pitch against optical sizing: that is the
  before and after of the product, in the letterforms.

Both faces are the ones snyvi itself ships in `ui/fonts`, so the film is set
in the same type it renders documents with.

## Palette

| Token     | Value     | Role                                                 |
| --------- | --------- | ---------------------------------------------------- |
| `ground`  | `#0a0c11` | the desktop; every scene's floor                     |
| `panel`   | `#141821` | terminal body, stat blocks, raised surfaces          |
| `rule`    | `#272d3a` | hairlines, borders, keycap edges                     |
| `ink`     | `#ece9e3` | display text on the dark                             |
| `mute`    | `#8b93a3` | labels, eyebrows, secondary mono                     |
| `flame`   | `#e0763e` | the accent: keys pressed, numbers, the mark's light  |
| `ember`   | `#c2410c` | the mark's own orange; deep accent, glows            |
| `bone`    | `#f3f1ec` | the product's paper — carried in by the screenshots  |

One accent hue, warm, on a cool ground: the orange is the only warm thing in
the dark, and it is the same orange as the mark.

## Type

| Register              | Face                        | Weight / size                     |
| --------------------- | --------------------------- | --------------------------------- |
| Statements            | Source Serif 4, `opsz 60`   | 900, 92–150px, tracking −0.03em   |
| Asides, taglines      | Source Serif 4 italic       | 300, 40–54px                      |
| Keys, commands, code  | JetBrains Mono              | 400–700, 22–40px                  |
| Eyebrows, labels      | JetBrains Mono              | 500, 20–22px, tracking .18em, caps |
| Numbers               | JetBrains Mono              | 700, 96–120px, `tabular-nums`     |
| The wordmark          | Inter 600                   | lockup only                       |

Inter appears only inside the lockup, because that is how snyvi draws its own
name. It is not used for a headline anywhere in the film.

## Motion

- Every scene is built at its hero frame, then animated into.
- Entrances only. The transition is the exit; the last scene alone fades out.
- Eases carry meaning: `expo.out` for things that arrive (the document, the
  window), `power4.out` for things that are struck (keycaps, stat numbers),
  `sine.inOut` for ambient drift, `power2.inOut` for pushes between scenes.
- The narration leads. Every entrance is pinned to a measured pause in the
  voice track, not to a guess — `film/beats.js` carries the seconds.

### Transitions

One primary, three accents, each in its narrative place.

| Cut       | Transition        | Why                                            |
| --------- | ----------------- | ---------------------------------------------- |
| 1 → 2     | light leak, 0.6s  | the dark blown open; the film's one big opening |
| 2 → 3     | push left, 0.45s  | the primary: next point                        |
| 3 → 4     | zoom through, 0.5s| the climax — the document arriving             |
| 4 → 9     | push left, 0.4s   | the primary, held through the features         |
| 9 → 10    | push up, 0.5s     | a section change: features become numbers      |
| 10 → 11   | push left, 0.4s   | back to the primary                            |
| 11 → 12   | blur crossfade, 0.8s | the wind-down                               |

## The first frame is the poster

GitHub shows frame 0 under the play button, so it is the only frame most
people will ever see. It has to say something. The opening scene's kicker —
the tick, `YOUR AGENTS WRITE ALL DAY`, the rule — is therefore up from the
first frame rather than faded in, which is the one place in the film where
an element does not animate in. What moves at t=0 is the wall behind it.

Keep that true of any re-cut: whatever scene runs first, frame 0 must read.

## What not to do

- No gradient text, no neon, no purple-to-blue, no cyan. The accent is the
  mark's orange and nothing else.
- No pure `#000` or `#fff`: the dark is tinted blue, the paper is bone.
- No stock UI mock-ups. Every product pixel in the film comes from
  `film/capture.mjs` running against the release binary.
- No claim the bench cannot support. The numbers on screen are the ones in
  the README's table.
