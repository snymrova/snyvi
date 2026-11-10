<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# Drawing on a board

A board is a desk's design surface: an empty canvas of **sections** you
draw, one HTML file each, in `design/<board>/` in the desk's folder, in git
with the work. A desk can have many boards (the reader makes them by name,
or the first `frame_write` to a new one does). The reader has one open with
your panel docked below it (or beside) and watches each section arrive.
They select sections, pan and zoom; they never edit. You draw, snyvi shows.

(The tool is still called `frame_write`: a frame and a section are the same
thing.)

The tools are `board_read`, `frame_write`, `board_arrange`, `frame_look` and
`board_export`, plus `read_focus` for what the reader is on in any view.

## Before the first frame

1. `board_read`. Without `board` it lists the desk's boards; with one board
   it reads that one. It returns the sections with their size, place and
   version, the reader's selection, and the design's tokens and first
   paragraph. Draw on the board the reader has open (`read_focus`), or the
   one they named; ask before starting a new one.
2. Read `design/DESIGN.md` and `design/tokens.css` whole, if they exist.
   They are the look. If they do not exist and the work needs a look, write
   them first, as files, and say so.

## A section

- One section per `frame_write`: an id (`hero`, `cards-2`: lowercase
  letters, digits, hyphens), its HTML, and its width in CSS pixels. Leave
  the height out: a section is as tall as its content. Give one only to cut
  it to a size (a phone screen, 390×844).
- All of a board's sections are drawn in one document, each in a shadow
  root, so one section's CSS never reaches another's. Write it as a page of
  its own: `body`, `html` and `:root` in your CSS mean the section itself.
  The tokens from `design/tokens.css` are already there as `var(--…)`.
- Self-contained: CSS in a `<style>` in the section. Pictures as `data:` or
  `https:` URLs. No fetch, no forms that submit.
- **No script.** A section is HTML and CSS. A section that has a
  `<script>` becomes an *island*: drawn as a page of its own, 600 px tall
  unless you give a height, at the cost of a document per island. Use one
  only for what CSS cannot show; for numbers snyvi holds, see *A live
  section* below, which needs no script.
- Small: 300 to 3,000 bytes. A page is several sections (header, hero,
  cards, footer), not one long one.
- A change rewrites one frame whole. Not the board, and never a frame you
  were not asked about.
- A write within 20 s of the last one to the same frame is the same version:
  fix what you just wrote without filling the history.

## Variants

Show options as a row of sections, not a sentence: `hero-a`, `hero-b`,
`hero-c` side by side (`board_arrange` lines them up). The reader clicks
the one they want, and `board_read` then names it in the selection.

## Look before you say done

`frame_look` will show you the section as the window draws it. Until it
does (it answers with what to do instead), render the file yourself at the
section's width, with the Playwright MCP if you have it, or

    chromium --headless --screenshot=/tmp/f.png --window-size=1200,800 file://…/design/home/hero.html

and read the picture. Fix what is wrong, then say done, and say which version.

## "This one"

When the reader says "this", "these" or "the left one", read the selection
first: `board_read` carries it, and `read_focus` does from any view (the
Folder view's file and lines too). Act on what is selected, and name it back:
"Rewrote cards (v3)."

## A live section

A section can show numbers snyvi already holds, kept current without a
redraw. Give it a source with `board_arrange` (`{"id": "numbers", "source":
"threads"}`); today there is one, `threads`: how many shipped threads this
desk has, how many were told, the share told, the median hours from merge
to told, and the last eight with both stamps. snyvi fills them in whenever
they move, and `board_read` says them too.

Draw the section with placeholders, each naming its number; no script:

    <b data-live="shipped">–</b> shipped · <b data-live="share">–</b>% told

A dotted name reaches inside (`data-live="last.0.name"`). Keep what it shows
before the numbers come the same size as after, so nothing moves.

## Never delete

`frame_write` with `html: null` hides a section: it leaves the board, its
file and every version stay, and the reader can bring it back. Say that you
hid it. To hand one over to be read as a document, `send_document` its file.

## When it is done

`board_export` makes one HTML page of every shown section in order, a file
to keep or pass on. PNG, SVG and PDF come later.
