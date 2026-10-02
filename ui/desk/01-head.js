/* The desk view: a folder, up to four panes in a fixed two-column grid, and
 * the rail that names them.
 *
 * Not on the wire until a desk is opened -- the same bargain as ui/mmd.js --
 * and nothing in it runs in a tab: app.js only imports this once the page
 * holds a capability. Everything it needs from the page comes in `open`'s one
 * argument, so the seam is three calls wide: `open`, `update` when the list of
 * desks moves, and `close` on the way out.
 *
 * A pane is painted, not emulated. The daemon owns the terminal -- the PTY,
 * the parser, the screen -- and sends frames: rows that changed, as runs of
 * text sharing an attribute. This keeps a copy of the grid exactly as the
 * frames describe it and paints rows into the DOM, which is why selection is
 * the browser's own and copy is `mouseup`. The protocol and its one hard rule
 * -- a resize is resize-and-clear on both sides -- are in docs/DESK.md.
 */

const WIDE = 256;
/** The terminal's text sizes, which Aa steps through on a desk: the font
 *  size and the row's height, in px. Normal is what a pane always was. One
 *  size for every desk, kept in `snyvi.term-size`. */
const SIZES = [["Small", 11.5, 15], ["Normal", 12.5, 16], ["Large", 14, 18], ["Larger", 15.5, 20]];
let sizeAt = (() => { try { const i = SIZES.findIndex(([n]) => n === localStorage.getItem("snyvi.term-size")); return i < 0 ? 1 : i; } catch { return 1; } })();
let LINE_PX = SIZES[sizeAt][2];   // a row's height, which the pane's CSS follows through --pn-line
const KEEP_LINES = 6000;       // scrollback rows kept in the page; the daemon keeps 2 MB
const CHUNK = 64;              // scrollback rows to a chunk, the unit it is put away and dropped in
let ctx = null;                // what app.js handed `open`
let sock = null, sockP = null, retry = 0;
let deskId = null, focused = null, cellW = 7.5;
/** Full view: the focused pane alone, filling the window -- the sidebar and
 *  the rail folded away, the rest of the panes as tabs in the desk's head.
 *  A state of the view rather than of a pane, so focusing another pane in
 *  full view shows that one, and the key that went in comes back out.
 *  Kept per desk by the daemon, as the slot it shows (`desks.full_slot`), so
 *  a desk comes back as it was left, after a reload or a restart too; a
 *  close renumbers it with the slots. */
let full = false;
/** The documents this desk's panes have sent, for the rail, and which desk
 *  they belong to -- so a desk swapped for another never shows the last
 *  one's list while its own is on the way. */
let docList = [], docsAt = null;
/** The desk whose documents, or whose notes, the daemon did not send: its
 *  section says so, with a Retry, rather than looking empty. */
let docsOff = null, notesOff = null;
const noReach = w => `<p class="no-reach" role="alert">Could not reach snyvi<button type="button" data-a="reload" data-w="${w}">Retry</button></p>`;
/** The rail shows the latest six of those and names the rest; a click on
 *  the rest opens the whole list, and again folds it back. No box that
 *  scrolls inside the rail: six rows is what a glance takes in, and the
 *  notes under them stay in reach. */
const DOCS_SHOWN = 6;
let docsAll = false;
/** The ones the reader removed from this desk's list (the daemon's
 *  `removed`), whether "N removed · Show" is open, and the row just removed
 *  -- { at: desk id, x, i } -- which keeps its place, with its Undo, for
 *  BACK_MS. Its own timer: a document's Undo and a note's are different rows. */
let docOff = [], offShown = false, docGone = null, docTimer = 0;
/** The document the list last scrolled into view, so the list is scrolled
 *  to a document when it is opened and not at every redraw after. */
let docSeen = null;
/** The reader's own list for this desk, and which desk it belongs to. Not
 *  asides (`crate::aside`): those are an agent's sentences and the daemon
 *  forgets them. These are written here, ticked here, and kept in the database. */
let noteList = [], notesAt = null, notesGet = null;
/** The field that is open on the list, while one is: a new line at the end, or
 *  a line being rewritten in place. Held here rather than in the DOM because
 *  the rail is redrawn whole -- by a pane's status, by the clock every 30s --
 *  and a field that lived only in the page would be swept away mid-word. */
let noteField = null, noteDraft = "", noteCaret = 0, noteErr = "";
/** The notes show six lines and name the rest, as the documents do. A line
 *  the reader is working on shows whatever its place: one being rewritten,
 *  one just taken off (its Undo), and one just added, so a new line never
 *  lands out of sight. */
const NOTES_SHOWN = 6;
let notesAll = false;
const notesKept = new Set();
/** True only while the rail's HTML is being replaced. An element losing the
 *  focus that way is not a reader clicking away from it, and must not be read
 *  as one: without this, every redraw committed whatever was half-typed. */
let drawing = false;
/** How long the offer to put a line back stands, matching the page's own undo. */
/** How long an Undo stands: six seconds, everywhere (docs/DESIGN.md Q2; app.js UNDO_MS). */
const BACK_MS = 6000;
let backTimer = 0;
/** The done lines "Remove done notes" just took off -- { at: desk id, xs: [note] } --
 *  while their Undo stands. It shares backTimer with a single line's ✕: only
 *  the newest offer stands. */
let cleared = null;
/** Pictures on the notes: an object URL by file name -- a name is its
 *  content's hash, so one fetch serves every draw after it -- or the fetch
 *  on its way. The pictures pasted into the new-line field, waiting for Enter
 *  to make the line they go on. And the picture just taken off a line --
 *  { n: note id, was: its list before } -- with its Undo, for BACK_MS. */
const imgUrls = new Map();
let pending = [], imgGone = null, imgTimer = 0;
/** The picture open whole over the page, while one is. */
let lightbox = null;
/** A panel just closed: its row stays in the rail for BACK_MS, greyed, with
 *  Undo -- { id, desk, name, said }. The daemon keeps the closed panel until
 *  `prune`; the row is only the offer. Only the newest close is offered. */
let closedRow = null, closedTimer = 0;
/** A panel brought back by Undo comes back stopped, with Start offered, and
 *  not started again as a panel the daemon lost would be. */
const keepStopped = new Set();
/** Points: passages the reader picked out of a document read over this desk,
 *  gathered for the panel that sent it -- pane id -> [{ text, from }] -- until
 *  the reader puts them in that panel's input. Held in the page and nowhere
 *  else: they are a draft of what the reader is about to say, and a draft
 *  that outlived the desk would turn up in a conversation it was not for. */
let points = new Map();
/** The floating control by a selection, while there is one; the word said
 *  under a panel's points, in that row's place; and their timers. */
let pickEl = null, pointSaid = null, saidTimer = 0, pointTimer = 0;
/** How long after a key in a panel its points wait to go in: text arriving
 *  mid-word would be spliced into whatever the reader was typing. */
const TYPED_MS = 2000;
/** A word said under one pane's row, when a click on it could not be done. */
let rowSaid = null, rowTimer = 0;
/** The one refusal the rail is saying: in the row that asked (`k`), naming
 *  the verb, with a Retry that is the same action again (`again`, the
 *  button's data). It stands until the Retry or the next thing done here. */
let rowErr = null;
const views = new Map();       // pane id -> its view
let clock = 0;
