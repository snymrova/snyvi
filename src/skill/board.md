<!-- snyvi init-claude wrote this; snyvi uninstall-claude takes it out, and an update rewrites it. -->

# Drawing on a board

A board is a desk's design surface: frames you draw, one HTML file each, in
`design/<board>/` in the desk's folder. The reader has it open with your
panel docked below it (or beside) and watches each frame arrive. They select frames, pan and zoom; they
never edit. You draw, snyvi shows.

The tools are `board_read`, `frame_write`, `board_arrange`, `frame_look` and
`board_export`, plus `read_focus` for what the reader is on in any view.

## Before the first frame

1. `board_read` (board `home` unless the reader named another). It returns
   the frames with their size, place and version, the reader's selection,
   and the design's tokens and first paragraph.
2. Read `design/DESIGN.md` and `design/tokens.css` whole, if they exist.
   They are the look. If they do not exist and the work needs a look, write
   them first, as files, and say so.

## A frame

- One frame per `frame_write`: an id (`hero`, `cards-2`: lowercase letters,
  digits, hyphens), its HTML, and its width and height in CSS pixels.
- Self-contained. CSS inline in a `<style>` in the frame; the tokens as
  `var(--…)` with the `:root` block from tokens.css copied in, since a frame
  cannot load files beside it. No network: no CDN, no fonts from the web, no
  fetch. Scripts run, but keep them for what a static frame cannot show.
- Small: 300 to 3,000 bytes. A page is several frames (header, hero, cards,
  footer), not one long one.
- A change rewrites one frame whole. Not the board, and never a frame you
  were not asked about.
- A write within 20 s of the last one to the same frame is the same version:
  fix what you just wrote without filling the history.

## Variants

Show options as a row of frames, not a sentence: `hero-a`, `hero-b`,
`hero-c` side by side (`board_arrange` lines them up). The reader clicks
the one they want, and `board_read` then names it in the selection.

## Look before you say done

`frame_look` will show you the frame as the window draws it. Until it does
(it answers with what to do instead), render the file yourself at the
frame's width, with the Playwright MCP if you have it, or

    chromium --headless --screenshot=/tmp/f.png --window-size=1200,800 file://…/design/home/hero.html

and read the picture. Fix what is wrong, then say done, and say which version.

## "This one"

When the reader says "this", "these" or "the left one", read the selection
first: `board_read` carries it, and `read_focus` does from any view (the
Folder view's file and lines too). Act on what is selected, and name it back:
"Rewrote cards (v3)."

## Never delete

`frame_write` with `html: null` hides a frame: it leaves the board, its file
and every version stay, and the reader can bring it back. Say that you hid
it. To hand a frame over to be read as a document, `send_document` its file.

## When it is done

`board_export` makes one HTML page of every shown frame in order, a file to
keep or pass on. PNG, SVG and PDF come later.
