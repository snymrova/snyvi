//! The screen a pane's process draws on, and the frames the page paints it from.
//!
//! A PTY's output is a byte stream of text and escape sequences; `vte` cuts it
//! into calls -- print this character, run this CSI -- and everything those
//! calls mean is here: the cursor, the scroll region, the alternate screen, SGR,
//! deferred wrap, tab stops, wide characters, and the line editing ops a TUI
//! leans on. The page never sees a byte of the stream. It is sent frames: the
//! rows that changed since the last frame, as runs of text that share an
//! attribute, and it paints those into the DOM.
//!
//! Three rules came out of the Phase 0 spike, which measured all of this
//! against `top`, `tmux`, `less`, `vi`, `cargo test` and a live `claude`:
//!
//! 1. **`shown` holds exactly what the page holds, always.** A diff skips any
//!    cell that matches it, so the day the two disagree is the day stale text
//!    survives forever in cells nobody repaints. A resize is therefore
//!    resize-and-clear on both sides: `shown` is blanked here and the frame
//!    carries `sz`, which tells the page to blank its own. The spike found 564
//!    desyncs before this rule and none after.
//! 2. **No scroll op.** Detecting a shifted region and sending it as a move
//!    earned 0.1% on the firehose and nothing anywhere else -- fast output
//!    turns the screen over between frames, and slow output was already cheap.
//! 3. **The frame is the governor.** A pane is diffed at most once a frame, so
//!    what goes on the wire is bounded by the screen's size and not by how fast
//!    a process writes: 369 KB/s in became 26 KB/s out.
//!
//! What is deliberately absent: reflow on resize, combining marks, charset
//! designation, DCS, mouse reporting past the wheel, and OSC 52 clipboard
//! writes, which snyvi declines -- a process in a pane does not get to write
//! the reader's clipboard. `docs/DESK.md` has the list and why.

use std::collections::VecDeque;
use unicode_width::UnicodeWidthChar;

/// The most scrollback a pane keeps, in bytes, because bytes are the unit the
/// memory budget is written in. Eight panes of this is the 16 MB ceiling
/// `crate::desk` is capped against.
pub const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;

/// How many scrollback lines one frame carries. Past this a firehose is
/// scrolling faster than anyone reads, and the frame says how many it skipped
/// rather than sending a megabyte a reader will never look at. The daemon's
/// own scrollback keeps them all, up to its cap.
const LINES_PER_FRAME: usize = 400;

pub const BOLD: u16 = 1;
pub const DIM: u16 = 2;
pub const ITALIC: u16 = 4;
pub const UNDERLINE: u16 = 8;
pub const BLINK: u16 = 16;
pub const INVERSE: u16 = 32;
pub const HIDDEN: u16 = 64;
pub const STRIKE: u16 = 128;
/// Not an SGR: set on a run of double-width characters, so the page can give
/// each of them two columns rather than trusting a font to.
pub const WIDE: u16 = 256;

/// A colour: 0 is the default, 1..=256 is a palette index plus one, and
/// anything with bit 24 set is `0xRRGGBB` truecolor. One number, so a run on
/// the wire is `[text, fg, bg, flags]` and the default drops off the end.
pub type Color = u32;
const RGB: u32 = 1 << 24;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Attr {
    pub fg: Color,
    pub bg: Color,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub attr: Attr,
    /// 1, or 2 for the first half of a wide character, or 0 for its second
    /// half -- which draws nothing and exists so every row is `cols` long.
    pub width: u8,
}

impl Cell {
    const BLANK: Cell = Cell {
        ch: ' ',
        attr: Attr {
            fg: 0,
            bg: 0,
            flags: 0,
        },
        width: 1,
    };
    fn blank(attr: Attr) -> Cell {
        // Erasing takes the background and nothing else: an erased cell under
        // a bold red pen is not bold, and is not red either.
        Cell {
            ch: ' ',
            attr: Attr {
                fg: 0,
                bg: attr.bg,
                flags: 0,
            },
            width: 1,
        }
    }
}

type Row = Vec<Cell>;

/// A line that has left the top of the screen, kept as runs rather than cells:
/// a cell is sixteen bytes and most of a line is one attribute, so this is
/// what makes 2 MB mean roughly 900 rows at 200 columns rather than 650.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub runs: Vec<(String, Attr)>,
    /// The line went on into the next one, rather than ending: what a copy
    /// joins back together.
    pub wrapped: bool,
}

impl Line {
    fn bytes(&self) -> usize {
        24 + self.runs.iter().map(|(t, _)| t.len() + 16).sum::<usize>()
    }
    /// The line's text, for the file a pane's last screen is kept in.
    pub fn text(&self) -> String {
        self.runs.iter().map(|(t, _)| t.as_str()).collect()
    }
}

/// What the page holds: the grid as it was last sent, and where the cursor
/// was. `Screen::frame` diffs against this and brings it up to date in the
/// same step, which is the only way it is allowed to change.
#[derive(Clone, Debug)]
pub struct Shown {
    cols: usize,
    rows: Vec<Row>,
    cursor: (usize, usize, bool),
    /// The modes as last sent, so a program that only flipped one -- asked for
    /// the mouse, went to the alternate screen -- still gets a frame out.
    modes: [u8; 4],
    /// Set by a resize: the next frame tells the page to resize and clear.
    resized: bool,
}

impl Shown {
    pub fn new(cols: usize, rows: usize) -> Shown {
        Shown {
            cols,
            rows: vec![vec![Cell::BLANK; cols]; rows],
            cursor: (0, 0, true),
            modes: [0; 4],
            resized: true,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Saved {
    x: usize,
    y: usize,
    attr: Attr,
    origin: bool,
    pending: bool,
}

pub struct Screen {
    cols: usize,
    rows: usize,
    grid: Vec<Row>,
    /// Per row: did it wrap into the next one.
    wraps: Vec<bool>,
    /// The main screen, put away while the alternate one is up. `None` means
    /// the main screen is the one on show.
    stash: Option<(Vec<Row>, Vec<bool>)>,
    x: usize,
    y: usize,
    /// A character was printed in the last column and the next one wraps.
    /// Deferred, as every terminal since the VT100 does it: `printf` of exactly
    /// 80 characters on an 80-column line must not leave an empty line after.
    pending: bool,
    attr: Attr,
    top: usize,
    bottom: usize,
    tabs: Vec<bool>,
    saved: Saved,
    saved_alt: Saved,
    origin: bool,
    autowrap: bool,
    insert: bool,
    cursor_visible: bool,
    /// DECCKM: arrows send `ESC O A` rather than `ESC [ A`. The page encodes
    /// keys, so it is told.
    pub app_cursor: bool,
    /// Mode 2004: a paste is wrapped so the program knows it was not typed.
    pub bracketed_paste: bool,
    /// Modes 1000, 1002, 1003: the program asked for the mouse. Only the wheel
    /// is reported -- clicks stay the browser's, for selection -- and it is the
    /// page that encodes the report, so it is told the encoding too.
    pub mouse: bool,
    /// Mode 1006: mouse reports in SGR form, which has no 223-column limit.
    pub mouse_sgr: bool,
    /// The window title a program set with OSC 0 or 2.
    pub title: String,
    /// A BEL or an OSC 9 / 777 notification since this was last taken: a
    /// program asking for the reader. It is how a pane comes to show as
    /// blocked, and the only signal used for it -- a guess from silence would
    /// call every idle shell blocked.
    pub bell: bool,
    /// What the terminal answers back to the program -- cursor position, the
    /// device attributes -- written to the PTY by the caller. A program that
    /// asks and hears nothing can wait forever.
    pub replies: Vec<u8>,
    scrollback: VecDeque<Line>,
    scrollback_bytes: usize,
    /// Lines that have scrolled off since the last frame, not yet sent.
    pushed: Vec<Line>,
    /// The page's copy of the scrollback is to be emptied: `ESC [ 3 J`.
    sb_cleared: bool,
    dropped: usize,
}

impl Screen {
    pub fn new(cols: usize, rows: usize) -> Screen {
        let cols = cols.clamp(2, 1000);
        let rows = rows.clamp(1, 500);
        Screen {
            cols,
            rows,
            grid: vec![vec![Cell::BLANK; cols]; rows],
            wraps: vec![false; rows],
            stash: None,
            x: 0,
            y: 0,
            pending: false,
            attr: Attr::default(),
            top: 0,
            bottom: rows - 1,
            tabs: (0..cols).map(|c| c % 8 == 0).collect(),
            saved: Saved::default(),
            saved_alt: Saved::default(),
            origin: false,
            autowrap: true,
            insert: false,
            cursor_visible: true,
            app_cursor: false,
            bracketed_paste: false,
            mouse: false,
            mouse_sgr: false,
            title: String::new(),
            bell: false,
            replies: Vec::new(),
            scrollback: VecDeque::new(),
            scrollback_bytes: 0,
            pushed: Vec::new(),
            sb_cleared: false,
            dropped: 0,
        }
    }

    pub fn size(&self) -> (usize, usize) {
        (self.cols, self.rows)
    }

    /// Feed bytes from the PTY through a parser the caller keeps, since a
    /// sequence can be cut in half by a read.
    pub fn feed(&mut self, parser: &mut vte::Parser, bytes: &[u8]) {
        parser.advance(self, bytes);
    }

    /// Resize, keeping what fits.
    ///
    /// Rows lost from the bottom that the cursor was below go to scrollback
    /// from the top instead, so a shell's prompt stays on screen the way it
    /// does in any terminal. No reflow: a line cut short stays cut short. And
    /// `shown` is cleared with it, which is rule 1 in the module comment.
    pub fn resize(&mut self, cols: usize, rows: usize, shown: &mut Shown) {
        let cols = cols.clamp(2, 1000);
        let rows = rows.clamp(1, 500);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        let alt = self.stash.is_some();
        // The rows above the cursor that no longer fit leave through the top.
        if rows < self.rows {
            let excess = (self.y + 1).saturating_sub(rows);
            for _ in 0..excess {
                let row = self.grid.remove(0);
                let w = self.wraps.remove(0);
                if !alt {
                    self.push_line(&row, w);
                }
            }
            self.y -= excess;
            self.grid.truncate(rows);
            self.wraps.truncate(rows);
        }
        let fit = |grid: &mut Vec<Row>, wraps: &mut Vec<bool>| {
            for r in grid.iter_mut() {
                r.resize(cols, Cell::BLANK);
                // A wide character cut in half by the new edge is a blank.
                if let Some(last) = r.last_mut() {
                    if last.width == 2 {
                        *last = Cell::BLANK;
                    }
                }
            }
            grid.resize(rows, vec![Cell::BLANK; cols]);
            wraps.resize(rows, false);
        };
        fit(&mut self.grid, &mut self.wraps);
        if let Some((g, w)) = self.stash.as_mut() {
            if g.len() > rows {
                g.drain(..g.len() - rows);
                w.drain(..w.len() - rows);
            }
            fit(g, w);
        }
        self.cols = cols;
        self.rows = rows;
        self.top = 0;
        self.bottom = rows - 1;
        self.x = self.x.min(cols - 1);
        self.y = self.y.min(rows - 1);
        self.pending = false;
        self.tabs = (0..cols).map(|c| c % 8 == 0).collect();
        *shown = Shown::new(cols, rows);
    }

    // ---------- frames ----------

    /// Whether the program asked for the scrollback to go (`ESC [ 3 J`)
    /// since the last frame. The frame carries that to the pages; the pane
    /// asks first, because what an earlier run left above the screen goes
    /// with it.
    pub fn scrollback_cleared(&self) -> bool {
        self.sb_cleared
    }

    /// The rows that changed since `shown`, and whatever scrolled off in
    /// between, as one JSON frame -- or `None` if the page already holds this.
    /// `shown` is brought up to date in the same step.
    pub fn frame(&mut self, pane: &str, shown: &mut Shown) -> Option<String> {
        let mut out = String::with_capacity(256);
        let mut any = false;
        out.push_str("{\"t\":\"frame\",\"p\":");
        push_json_str(&mut out, pane);
        if shown.resized {
            shown.resized = false;
            out.push_str(&format!(",\"sz\":[{},{}]", self.cols, self.rows));
            any = true;
        }
        if self.sb_cleared {
            self.sb_cleared = false;
            out.push_str(",\"sbclear\":1");
            any = true;
        }
        if !self.pushed.is_empty() || self.dropped > 0 {
            let lines = std::mem::take(&mut self.pushed);
            let skip = lines.len().saturating_sub(LINES_PER_FRAME) + self.dropped;
            self.dropped = 0;
            if skip > 0 {
                out.push_str(&format!(",\"gap\":{skip}"));
            }
            out.push_str(",\"sb\":[");
            let from = lines.len().saturating_sub(LINES_PER_FRAME);
            for (i, l) in lines[from..].iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_line(&mut out, l);
            }
            out.push(']');
            for l in lines {
                self.keep_line(l);
            }
            any = true;
        }
        let mut rows = String::new();
        for (y, row) in self.grid.iter().enumerate() {
            let was = &mut shown.rows[y];
            let Some(x0) = (0..self.cols).find(|&x| row[x] != was[x]) else {
                continue;
            };
            let x1 = (0..self.cols)
                .rev()
                .find(|&x| row[x] != was[x])
                .unwrap_or(x0);
            // A span that starts or ends on half of a wide character takes the
            // whole of it, so the page is never asked to draw half a glyph.
            let x0 = if row[x0].width == 0 && x0 > 0 {
                x0 - 1
            } else {
                x0
            };
            let x1 = if row[x1].width == 2 {
                (x1 + 1).min(self.cols - 1)
            } else {
                x1
            };
            if !rows.is_empty() {
                rows.push(',');
            }
            rows.push_str(&format!("[{y},{x0},"));
            push_runs(&mut rows, &row[x0..=x1]);
            rows.push(']');
            was[x0..=x1].copy_from_slice(&row[x0..=x1]);
        }
        if !rows.is_empty() {
            out.push_str(",\"r\":[");
            out.push_str(&rows);
            out.push(']');
            any = true;
        }
        let cursor = (self.x, self.y, self.cursor_visible);
        if cursor != shown.cursor || any {
            shown.cursor = cursor;
            out.push_str(&format!(
                ",\"c\":[{},{},{}]",
                cursor.0,
                cursor.1,
                u8::from(cursor.2)
            ));
            any = true;
        }
        let modes = self.modes();
        if modes != shown.modes {
            shown.modes = modes;
            any = true;
        }
        let [a, b, m, alt] = modes;
        out.push_str(&format!(",\"m\":[{a},{b},{m},{alt}]}}"));
        any.then_some(out)
    }

    /// Everything a page that has just arrived needs: the scrollback as sent
    /// so far and the grid as `shown` has it -- not as the screen has it, since
    /// the frames already on their way to other pages start from `shown`.
    pub fn snapshot(&self, pane: &str, shown: &Shown) -> String {
        let mut out = String::with_capacity(4096);
        out.push_str("{\"t\":\"frame\",\"p\":");
        push_json_str(&mut out, pane);
        out.push_str(&format!(
            ",\"sz\":[{},{}],\"sb\":[",
            shown.cols,
            shown.rows.len()
        ));
        for (i, l) in self.scrollback.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_line(&mut out, l);
        }
        out.push_str("],\"r\":[");
        let mut first = true;
        for (y, row) in shown.rows.iter().enumerate() {
            if row.iter().all(|c| *c == Cell::BLANK) {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&format!("[{y},0,"));
            push_runs(&mut out, row);
            out.push(']');
        }
        let (x, y, v) = shown.cursor;
        let [a, b, m, alt] = self.modes();
        out.push_str(&format!(
            "],\"c\":[{x},{y},{}],\"m\":[{a},{b},{m},{alt}]}}",
            u8::from(v)
        ));
        out
    }

    /// The `m` of a frame: DECCKM, bracketed paste, the mouse (0 off, 1 X10
    /// reports, 2 SGR reports), and whether the alternate screen is up -- what
    /// the page needs to encode a key, a paste, and a turn of the wheel.
    fn modes(&self) -> [u8; 4] {
        [
            u8::from(self.app_cursor),
            u8::from(self.bracketed_paste),
            match (self.mouse, self.mouse_sgr) {
                (false, _) => 0,
                (true, false) => 1,
                (true, true) => 2,
            },
            u8::from(self.stash.is_some()),
        ]
    }

    /// The scrollback and the screen as plain lines, oldest first, trailing
    /// blank lines dropped: what a pane leaves behind when its process ends or
    /// the daemon stops, and what comes back greyed after a restart.
    pub fn text(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.scrollback.iter().map(Line::text).collect();
        lines.extend(self.pushed.iter().map(Line::text));
        let main = self.stash.as_ref().map(|(g, _)| g).unwrap_or(&self.grid);
        for row in main {
            let s: String = row.iter().filter(|c| c.width > 0).map(|c| c.ch).collect();
            lines.push(s.trim_end().to_string());
        }
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines
    }

    // ---------- scrollback ----------

    fn push_line(&mut self, row: &[Cell], wrapped: bool) {
        let mut end = row.len();
        while end > 0 && row[end - 1] == Cell::BLANK {
            end -= 1;
        }
        self.pushed.push(Line {
            runs: runs(&row[..end]),
            wrapped,
        });
        // A firehose between two frames is not held in full twice over: past
        // what a frame sends, lines go straight to the kept scrollback.
        if self.pushed.len() > LINES_PER_FRAME * 2 {
            let over: Vec<Line> = self.pushed.drain(..LINES_PER_FRAME).collect();
            self.dropped += over.len();
            for l in over {
                self.keep_line(l);
            }
        }
    }

    /// Keep a line, and drop whole lines from the front until the total is
    /// under the cap. Whole lines: a line cut in the middle is a lie about
    /// what was on screen, and one missing from the top is what scrollback
    /// running out has always looked like. A single line bigger than the cap
    /// on its own is cut at the cap, since the alternative is keeping nothing.
    fn keep_line(&mut self, mut l: Line) {
        if l.bytes() > SCROLLBACK_BYTES {
            let attr = l.runs.first().map(|r| r.1).unwrap_or_default();
            let mut t = l.text();
            let mut cut = SCROLLBACK_BYTES / 2;
            while !t.is_char_boundary(cut) {
                cut -= 1;
            }
            t.truncate(cut);
            l.runs = vec![(t, attr)];
        }
        self.scrollback_bytes += l.bytes();
        self.scrollback.push_back(l);
        while self.scrollback_bytes > SCROLLBACK_BYTES {
            match self.scrollback.pop_front() {
                Some(old) => self.scrollback_bytes -= old.bytes(),
                None => break,
            }
        }
    }

    #[cfg(test)]
    pub fn scrollback_bytes(&self) -> usize {
        self.scrollback_bytes
    }

    // ---------- the operations ----------

    fn blank(&self) -> Cell {
        Cell::blank(self.attr)
    }

    /// Up one line inside the scroll region: the top line leaves, a blank one
    /// arrives at the bottom. Only a line leaving the top of the whole main
    /// screen is scrollback; a TUI scrolling its own region is not history.
    fn scroll_up(&mut self, n: usize, history: bool) {
        let blank = self.blank();
        for _ in 0..n.min(self.bottom - self.top + 1) {
            let row = self.grid.remove(self.top);
            let w = self.wraps.remove(self.top);
            if history && self.top == 0 && self.stash.is_none() {
                self.push_line(&row, w);
            }
            self.grid.insert(self.bottom, vec![blank; self.cols]);
            self.wraps.insert(self.bottom, false);
        }
    }

    fn scroll_down(&mut self, n: usize) {
        let blank = self.blank();
        for _ in 0..n.min(self.bottom - self.top + 1) {
            self.grid.remove(self.bottom);
            self.wraps.remove(self.bottom);
            self.grid.insert(self.top, vec![blank; self.cols]);
            self.wraps.insert(self.top, false);
        }
    }

    fn linefeed(&mut self) {
        self.pending = false;
        if self.y == self.bottom {
            self.scroll_up(1, true);
        } else if self.y + 1 < self.rows {
            self.y += 1;
        }
    }

    fn print_char(&mut self, c: char) {
        let w = c.width().unwrap_or(0);
        if w == 0 {
            // A combining mark or a control that reached print: dropped, which
            // is the documented gap. Nothing is lost from a cell that exists.
            return;
        }
        if self.pending {
            if self.autowrap {
                self.wraps[self.y] = true;
                self.x = 0;
                self.linefeed();
            }
            self.pending = false;
        }
        // A wide character with one column left wraps first rather than
        // being split across the edge.
        if w == 2 && self.x + 1 >= self.cols {
            if self.autowrap {
                self.grid[self.y][self.x] = self.blank();
                self.wraps[self.y] = true;
                self.x = 0;
                self.linefeed();
            } else {
                return;
            }
        }
        if self.insert {
            self.clear_half(self.x);
            let cols = self.cols;
            let row = &mut self.grid[self.y];
            for _ in 0..w {
                row.pop();
                row.insert(self.x, Cell::BLANK);
            }
            if row[cols - 1].width == 2 {
                row[cols - 1] = Cell::BLANK;
            }
        }
        self.clear_half(self.x);
        if w == 2 {
            self.clear_half(self.x + 1);
        }
        let attr = self.attr;
        let row = &mut self.grid[self.y];
        row[self.x] = Cell {
            ch: c,
            attr,
            width: w as u8,
        };
        if w == 2 {
            row[self.x + 1] = Cell {
                ch: ' ',
                attr,
                width: 0,
            };
        }
        if self.x + w >= self.cols {
            self.x = self.cols - 1;
            self.pending = true;
        } else {
            self.x += w;
        }
    }

    /// Overwriting either half of a wide character blanks the other half.
    fn clear_half(&mut self, x: usize) {
        if x >= self.cols {
            return;
        }
        let row = &mut self.grid[self.y];
        match row[x].width {
            0 if x > 0 => {
                row[x - 1] = Cell::BLANK;
                row[x] = Cell::BLANK;
            }
            2 if x + 1 < self.cols => {
                row[x + 1] = Cell::BLANK;
                row[x] = Cell::BLANK;
            }
            _ => {}
        }
    }

    fn erase(&mut self, y: usize, from: usize, to: usize) {
        let blank = self.blank();
        let to = to.min(self.cols);
        if from >= to {
            return;
        }
        let row = &mut self.grid[y];
        if from > 0 && row[from].width == 0 {
            row[from - 1] = blank;
        }
        if to < self.cols && row[to].width == 0 {
            row[to] = blank;
        }
        for c in &mut row[from..to] {
            *c = blank;
        }
    }

    fn goto(&mut self, x: usize, y: usize) {
        self.pending = false;
        let (lo, hi) = if self.origin {
            (self.top, self.bottom)
        } else {
            (0, self.rows - 1)
        };
        self.x = x.min(self.cols - 1);
        self.y = (y + if self.origin { self.top } else { 0 }).clamp(lo, hi);
    }

    fn save(&mut self) {
        let s = Saved {
            x: self.x,
            y: self.y,
            attr: self.attr,
            origin: self.origin,
            pending: self.pending,
        };
        if self.stash.is_some() {
            self.saved_alt = s;
        } else {
            self.saved = s;
        }
    }

    fn restore(&mut self) {
        let s = if self.stash.is_some() {
            self.saved_alt
        } else {
            self.saved
        };
        self.x = s.x.min(self.cols - 1);
        self.y = s.y.min(self.rows - 1);
        self.attr = s.attr;
        self.origin = s.origin;
        self.pending = s.pending;
    }

    fn alt_screen(&mut self, on: bool) {
        match (on, self.stash.is_some()) {
            (true, false) => {
                let blank = vec![vec![Cell::BLANK; self.cols]; self.rows];
                let main = std::mem::replace(&mut self.grid, blank);
                let wraps = std::mem::replace(&mut self.wraps, vec![false; self.rows]);
                self.stash = Some((main, wraps));
            }
            (false, true) => {
                if let Some((g, w)) = self.stash.take() {
                    self.grid = g;
                    self.wraps = w;
                }
            }
            _ => {}
        }
        self.top = 0;
        self.bottom = self.rows - 1;
    }

    fn reset(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        let scrollback = std::mem::take(&mut self.scrollback);
        let bytes = self.scrollback_bytes;
        let pushed = std::mem::take(&mut self.pushed);
        *self = Screen::new(cols, rows);
        self.scrollback = scrollback;
        self.scrollback_bytes = bytes;
        self.pushed = pushed;
    }

    fn sgr(&mut self, params: &vte::Params) {
        let flat: Vec<Vec<u16>> = params.iter().map(<[u16]>::to_vec).collect();
        if flat.is_empty() {
            self.attr = Attr::default();
            return;
        }
        let mut i = 0;
        while i < flat.len() {
            let p = &flat[i];
            let n = p.first().copied().unwrap_or(0);
            match n {
                0 => self.attr = Attr::default(),
                1 => self.attr.flags |= BOLD,
                2 => self.attr.flags |= DIM,
                3 => self.attr.flags |= ITALIC,
                4 => {
                    // `4:0` is underline off, in the colon form kitty and
                    // friends send.
                    if p.get(1) == Some(&0) {
                        self.attr.flags &= !UNDERLINE;
                    } else {
                        self.attr.flags |= UNDERLINE;
                    }
                }
                5 | 6 => self.attr.flags |= BLINK,
                7 => self.attr.flags |= INVERSE,
                8 => self.attr.flags |= HIDDEN,
                9 => self.attr.flags |= STRIKE,
                21 | 22 => self.attr.flags &= !(BOLD | DIM),
                23 => self.attr.flags &= !ITALIC,
                24 => self.attr.flags &= !UNDERLINE,
                25 => self.attr.flags &= !BLINK,
                27 => self.attr.flags &= !INVERSE,
                28 => self.attr.flags &= !HIDDEN,
                29 => self.attr.flags &= !STRIKE,
                30..=37 => self.attr.fg = u32::from(n - 30) + 1,
                39 => self.attr.fg = 0,
                40..=47 => self.attr.bg = u32::from(n - 40) + 1,
                49 => self.attr.bg = 0,
                90..=97 => self.attr.fg = u32::from(n - 90 + 8) + 1,
                100..=107 => self.attr.bg = u32::from(n - 100 + 8) + 1,
                38 | 48 => {
                    // Both spellings: `38;5;n` / `38;2;r;g;b` as separate
                    // params, and `38:5:n` / `38:2::r:g:b` as subparams.
                    let (color, used) = if p.len() > 1 {
                        (extended(&p[1..]), 0)
                    } else {
                        let rest: Vec<u16> = flat[i + 1..]
                            .iter()
                            .filter_map(|q| q.first().copied())
                            .collect();
                        let c = extended(&rest);
                        let used = match rest.first() {
                            Some(5) => 2,
                            Some(2) => 4,
                            _ => 0,
                        };
                        (c, used)
                    };
                    if let Some(c) = color {
                        if n == 38 {
                            self.attr.fg = c;
                        } else {
                            self.attr.bg = c;
                        }
                    }
                    i += used;
                }
                _ => {}
            }
            i += 1;
        }
    }

    fn mode(&mut self, private: bool, params: &vte::Params, on: bool) {
        for p in params.iter() {
            let n = p.first().copied().unwrap_or(0);
            match (private, n) {
                (false, 4) => self.insert = on,
                (true, 1) => self.app_cursor = on,
                (true, 6) => {
                    self.origin = on;
                    self.goto(0, 0);
                }
                (true, 7) => self.autowrap = on,
                (true, 25) => self.cursor_visible = on,
                (true, 47) | (true, 1047) => self.alt_screen(on),
                (true, 1048) => {
                    if on {
                        self.save()
                    } else {
                        self.restore()
                    }
                }
                (true, 1049) => {
                    if on {
                        self.save();
                        self.alt_screen(true);
                    } else {
                        self.alt_screen(false);
                        self.restore();
                    }
                }
                (true, 1000) | (true, 1002) | (true, 1003) => self.mouse = on,
                (true, 1006) => self.mouse_sgr = on,
                (true, 2004) => self.bracketed_paste = on,
                _ => {}
            }
        }
    }
}

fn extended(p: &[u16]) -> Option<Color> {
    match p {
        [5, n, ..] => Some(u32::from(*n).min(255) + 1),
        // `2::r:g:b` carries an empty colour-space id; `2;r;g;b` does not.
        [2, _, r, g, b] | [2, r, g, b, ..] => Some(
            RGB | (u32::from(*r & 255) << 16) | (u32::from(*g & 255) << 8) | u32::from(*b & 255),
        ),
        _ => None,
    }
}

impl vte::Perform for Screen {
    fn print(&mut self, c: char) {
        self.print_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => self.bell = true,
            0x08 => {
                self.pending = false;
                self.x = self.x.saturating_sub(1);
            }
            0x09 => {
                self.pending = false;
                let next = (self.x + 1..self.cols).find(|&c| self.tabs[c]);
                self.x = next.unwrap_or(self.cols - 1);
            }
            0x0a..=0x0c => self.linefeed(),
            0x0d => {
                self.pending = false;
                self.x = 0;
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &vte::Params, inter: &[u8], _ignore: bool, action: char) {
        let arg = |i: usize, d: usize| -> usize {
            params
                .iter()
                .nth(i)
                .and_then(|p| p.first().copied())
                .map(usize::from)
                .filter(|&v| v != 0)
                .unwrap_or(d)
        };
        let private = inter.first() == Some(&b'?');
        match (action, inter) {
            ('h', _) => return self.mode(private, params, true),
            ('l', _) => return self.mode(private, params, false),
            ('m', []) => return self.sgr(params),
            ('c', []) => {
                // Primary device attributes: a VT220 with nothing exotic.
                self.replies.extend_from_slice(b"\x1b[?62;22c");
                return;
            }
            ('c', [b'>']) => {
                self.replies.extend_from_slice(b"\x1b[>0;0;0c");
                return;
            }
            ('n', []) => {
                match arg(0, 0) {
                    5 => self.replies.extend_from_slice(b"\x1b[0n"),
                    6 => {
                        let y = if self.origin {
                            self.y - self.top
                        } else {
                            self.y
                        };
                        self.replies.extend_from_slice(
                            format!("\x1b[{};{}R", y + 1, self.x + 1).as_bytes(),
                        );
                    }
                    _ => {}
                }
                return;
            }
            // Anything else with an intermediate is something this does not
            // speak: DECSCUSR (`CSI q` with a space), kitty keyboard queries.
            // Ignored, rather than misread as the plain sequence.
            (_, [_, ..]) => return,
            _ => {}
        }
        match action {
            'A' => {
                self.pending = false;
                let lo = if self.y >= self.top { self.top } else { 0 };
                self.y = self.y.saturating_sub(arg(0, 1)).max(lo);
            }
            'B' | 'e' => {
                self.pending = false;
                let hi = if self.y <= self.bottom {
                    self.bottom
                } else {
                    self.rows - 1
                };
                self.y = (self.y + arg(0, 1)).min(hi);
            }
            'C' | 'a' => {
                self.pending = false;
                self.x = (self.x + arg(0, 1)).min(self.cols - 1);
            }
            'D' => {
                self.pending = false;
                self.x = self.x.saturating_sub(arg(0, 1));
            }
            'E' => {
                self.pending = false;
                self.x = 0;
                let hi = if self.y <= self.bottom {
                    self.bottom
                } else {
                    self.rows - 1
                };
                self.y = (self.y + arg(0, 1)).min(hi);
            }
            'F' => {
                self.pending = false;
                self.x = 0;
                self.y = self.y.saturating_sub(arg(0, 1)).max(self.top);
            }
            'G' | '`' => {
                self.pending = false;
                self.x = (arg(0, 1) - 1).min(self.cols - 1);
            }
            'd' => {
                let x = self.x;
                self.goto(x, arg(0, 1) - 1);
            }
            'H' | 'f' => self.goto(arg(1, 1) - 1, arg(0, 1) - 1),
            'J' => {
                let (x, y) = (self.x, self.y);
                match arg(0, 0) {
                    0 => {
                        self.erase(y, x, self.cols);
                        for r in y + 1..self.rows {
                            self.erase(r, 0, self.cols);
                        }
                    }
                    1 => {
                        for r in 0..y {
                            self.erase(r, 0, self.cols);
                        }
                        self.erase(y, 0, x + 1);
                    }
                    2 => {
                        for r in 0..self.rows {
                            self.erase(r, 0, self.cols);
                        }
                    }
                    3 => {
                        self.scrollback.clear();
                        self.scrollback_bytes = 0;
                        self.pushed.clear();
                        self.sb_cleared = true;
                    }
                    _ => {}
                }
            }
            'K' => {
                let (x, y) = (self.x, self.y);
                match arg(0, 0) {
                    0 => self.erase(y, x, self.cols),
                    1 => self.erase(y, 0, x + 1),
                    2 => self.erase(y, 0, self.cols),
                    _ => {}
                }
            }
            'L' | 'M' if (self.top..=self.bottom).contains(&self.y) => {
                // Insert or delete lines at the cursor: a scroll of the region
                // that starts at the cursor's row.
                let top = self.top;
                self.top = self.y;
                if action == 'L' {
                    self.scroll_down(arg(0, 1));
                } else {
                    // Deleted lines are not history, even at the top.
                    self.scroll_up(arg(0, 1), false);
                }
                self.top = top;
                self.x = 0;
                self.pending = false;
            }
            '@' => {
                let n = arg(0, 1).min(self.cols - self.x);
                let blank = self.blank();
                let x = self.x;
                // Only a character the cursor splits is lost; one that starts
                // at the cursor moves right with the rest, whole.
                if self.grid[self.y][x].width == 0 {
                    self.clear_half(x);
                }
                let row = &mut self.grid[self.y];
                for _ in 0..n {
                    row.pop();
                    row.insert(x, blank);
                }
                if row[self.cols - 1].width == 2 {
                    row[self.cols - 1] = blank;
                }
            }
            'P' => {
                let n = arg(0, 1).min(self.cols - self.x);
                let blank = self.blank();
                let x = self.x;
                self.clear_half(x);
                let row = &mut self.grid[self.y];
                row.drain(x..x + n);
                row.resize(self.cols, blank);
                if row[x].width == 0 {
                    row[x] = blank;
                }
            }
            'X' => {
                let (x, y) = (self.x, self.y);
                self.erase(y, x, x + arg(0, 1));
            }
            'S' => self.scroll_up(arg(0, 1), false),
            'T' => self.scroll_down(arg(0, 1)),
            'b' => {
                // Repeat the last character: rare, and cheap to get right as
                // "print the one to the left again".
                if self.x > 0 {
                    let c = self.grid[self.y][self.x - 1].ch;
                    for _ in 0..arg(0, 1).min(self.cols) {
                        self.print_char(c);
                    }
                }
            }
            'g' => match arg(0, 0) {
                0 => self.tabs[self.x] = false,
                3 => self.tabs.iter_mut().for_each(|t| *t = false),
                _ => {}
            },
            'r' => {
                let top = arg(0, 1) - 1;
                let bottom = arg(1, self.rows).min(self.rows) - 1;
                if top < bottom {
                    self.top = top;
                    self.bottom = bottom;
                    self.goto(0, 0);
                }
            }
            's' => self.save(),
            'u' => self.restore(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, inter: &[u8], _ignore: bool, byte: u8) {
        match (inter, byte) {
            ([], b'7') => self.save(),
            ([], b'8') => self.restore(),
            ([], b'D') => self.linefeed(),
            ([], b'E') => {
                self.x = 0;
                self.linefeed();
            }
            ([], b'H') => self.tabs[self.x] = true,
            ([], b'M') => {
                self.pending = false;
                if self.y == self.top {
                    self.scroll_down(1);
                } else {
                    self.y = self.y.saturating_sub(1);
                }
            }
            ([], b'c') => self.reset(),
            // DECALN, the screen-alignment test: every cell an E.
            ([b'#'], b'8') => {
                for row in &mut self.grid {
                    for c in row.iter_mut() {
                        *c = Cell {
                            ch: 'E',
                            ..Cell::BLANK
                        };
                    }
                }
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        match params.first().copied() {
            Some(b"0") | Some(b"2") => {
                if let Some(t) = params.get(1) {
                    self.title = String::from_utf8_lossy(t).chars().take(120).collect();
                }
            }
            // A desktop notification, the way iTerm2 (9) and urxvt (777) take
            // one: a program asking for its reader. Counted as a bell.
            Some(b"9") | Some(b"777") => self.bell = true,
            // 52 is a clipboard write from the program. Declined, and not
            // silently: `docs/DESK.md` says so. Nothing else here is acted on.
            _ => {}
        }
    }
}

// ---------- the wire ----------

/// Cells as runs that share an attribute, and double-width characters as runs
/// of their own marked `WIDE`.
fn runs(cells: &[Cell]) -> Vec<(String, Attr)> {
    let mut out: Vec<(String, Attr)> = Vec::new();
    for c in cells {
        if c.width == 0 {
            continue;
        }
        let mut attr = c.attr;
        if c.width == 2 {
            attr.flags |= WIDE;
        }
        match out.last_mut() {
            Some((t, a)) if *a == attr => t.push(c.ch),
            _ => out.push((c.ch.to_string(), attr)),
        }
    }
    out
}

fn push_runs(out: &mut String, cells: &[Cell]) {
    push_run_list(out, &runs(cells));
}

fn push_run_list(out: &mut String, runs: &[(String, Attr)]) {
    out.push('[');
    for (i, (t, a)) in runs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        push_json_str(out, t);
        // The default attribute drops off the end, so a plain run is one string.
        match (a.fg, a.bg, a.flags) {
            (0, 0, 0) => {}
            (fg, 0, 0) => out.push_str(&format!(",{fg}")),
            (fg, bg, 0) => out.push_str(&format!(",{fg},{bg}")),
            (fg, bg, f) => out.push_str(&format!(",{fg},{bg},{f}")),
        }
        out.push(']');
    }
    out.push(']');
}

fn push_line(out: &mut String, l: &Line) {
    if l.wrapped {
        out.push_str("{\"w\":1,\"r\":");
        push_run_list(out, &l.runs);
        out.push('}');
    } else {
        push_run_list(out, &l.runs);
    }
}

pub fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn screen(cols: usize, rows: usize) -> (Screen, vte::Parser) {
        (Screen::new(cols, rows), vte::Parser::new())
    }

    fn feed(s: &mut Screen, p: &mut vte::Parser, bytes: &str) {
        s.feed(p, bytes.as_bytes());
    }

    fn row(s: &Screen, y: usize) -> String {
        s.grid[y]
            .iter()
            .filter(|c| c.width > 0)
            .map(|c| c.ch)
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    /// The page's side of the protocol, in Rust: starts blank, sees only
    /// frames, and applies them. What the spike called the replica. If it
    /// ever disagrees with the screen after a frame, that is a desync.
    struct Replica {
        cols: usize,
        rows: Vec<Vec<(char, Attr)>>,
        sb: Vec<String>,
    }

    impl Replica {
        fn new() -> Replica {
            Replica {
                cols: 0,
                rows: Vec::new(),
                sb: Vec::new(),
            }
        }
        fn apply(&mut self, frame: &str) {
            let f: Value = serde_json::from_str(frame).expect("a frame is JSON");
            if let Some(sz) = f.get("sz") {
                let c = sz[0].as_u64().unwrap() as usize;
                let r = sz[1].as_u64().unwrap() as usize;
                self.cols = c;
                self.rows = vec![vec![(' ', Attr::default()); c]; r];
            }
            if f.get("sbclear").is_some() {
                self.sb.clear();
            }
            for l in f.get("sb").and_then(Value::as_array).into_iter().flatten() {
                let runs = if l.is_object() { &l["r"] } else { l };
                let text: String = runs
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r[0].as_str().unwrap().to_string())
                    .collect();
                self.sb.push(text);
            }
            for r in f.get("r").and_then(Value::as_array).into_iter().flatten() {
                let y = r[0].as_u64().unwrap() as usize;
                let mut x = r[1].as_u64().unwrap() as usize;
                for run in r[2].as_array().unwrap() {
                    let a = run.as_array().unwrap();
                    let n = |i: usize| a.get(i).and_then(Value::as_u64).unwrap_or(0);
                    let attr = Attr {
                        fg: n(1) as u32,
                        bg: n(2) as u32,
                        flags: n(3) as u16 & !WIDE,
                    };
                    let wide = n(3) as u16 & WIDE != 0;
                    for ch in a[0].as_str().unwrap().chars() {
                        self.rows[y][x] = (ch, attr);
                        x += 1;
                        if wide {
                            self.rows[y][x] = (' ', attr);
                            x += 1;
                        }
                    }
                }
            }
        }
        fn agrees(&self, s: &Screen) -> Result<(), String> {
            if self.rows.len() != s.rows || self.cols != s.cols {
                return Err(format!(
                    "size {}x{} against {}x{}",
                    self.cols,
                    self.rows.len(),
                    s.cols,
                    s.rows
                ));
            }
            for y in 0..s.rows {
                for x in 0..s.cols {
                    let c = s.grid[y][x];
                    let want = if c.width == 0 { ' ' } else { c.ch };
                    let got = self.rows[y][x].0;
                    if got != want || (c.width != 0 && self.rows[y][x].1 != c.attr) {
                        return Err(format!("row {y} col {x}: page {got:?}, screen {want:?}"));
                    }
                }
            }
            Ok(())
        }
    }

    fn pump(s: &mut Screen, shown: &mut Shown, rep: &mut Replica) {
        if let Some(f) = s.frame("p", shown) {
            rep.apply(&f);
        }
        rep.agrees(s).unwrap();
    }

    #[test]
    fn clearing_the_scrollback_is_said_once_and_asked_first() {
        let (mut s, mut p) = screen(10, 2);
        let mut shown = Shown::new(10, 2);
        feed(&mut s, &mut p, "one\r\ntwo\r\nthree");
        s.frame("p", &mut shown);
        assert!(!s.scrollback_cleared());
        feed(&mut s, &mut p, "\x1b[3J");
        assert!(s.scrollback_cleared(), "up until a frame carries it");
        let f = s.frame("p", &mut shown).expect("the clear goes out");
        assert!(f.contains("\"sbclear\":1"));
        assert!(!s.scrollback_cleared(), "and down once it has");
    }

    #[test]
    fn text_lands_where_the_cursor_is_and_wraps_late() {
        let (mut s, mut p) = screen(10, 3);
        feed(&mut s, &mut p, "0123456789");
        // Exactly ten characters on a ten-column line: the cursor waits at the
        // edge rather than dropping to an empty line.
        assert_eq!((s.x, s.y, s.pending), (9, 0, true));
        feed(&mut s, &mut p, "ab");
        assert_eq!(row(&s, 0), "0123456789");
        assert_eq!(row(&s, 1), "ab");
        assert!(s.wraps[0]);
        feed(&mut s, &mut p, "\r\n\x1b[2;4Hx");
        assert_eq!(row(&s, 1), "ab x");
    }

    #[test]
    fn lines_leaving_the_top_are_scrollback_and_a_region_scroll_is_not() {
        let (mut s, mut p) = screen(8, 3);
        feed(&mut s, &mut p, "one\r\ntwo\r\nthree\r\nfour");
        assert_eq!(s.pushed.len(), 1);
        assert_eq!(s.pushed[0].text(), "one");
        // A TUI scrolling rows 2-3 of its own region: not history.
        feed(&mut s, &mut p, "\x1b[2;3r\x1b[3;1H\n\n");
        assert_eq!(s.pushed.len(), 1);
        // The region scrolled "four" away and left row 0 alone.
        let before: Vec<String> = (0..3).map(|y| row(&s, y)).collect();
        assert_eq!(before, ["two", "", ""]);
        // And the alternate screen keeps none at all.
        feed(&mut s, &mut p, "\x1b[r\x1b[?1049h\x1b[3;1H\n\n\n");
        assert_eq!(s.pushed.len(), 1);
        feed(&mut s, &mut p, "\x1b[?1049l");
        let after: Vec<String> = (0..3).map(|y| row(&s, y)).collect();
        assert_eq!(after, before, "the main screen is back as it was");
    }

    #[test]
    fn sgr_reads_both_spellings_of_truecolor_and_erase_keeps_only_the_background() {
        let (mut s, mut p) = screen(10, 2);
        feed(
            &mut s,
            &mut p,
            "\x1b[1;38;2;255;0;10;48;5;4mA\x1b[38:2::1:2:3mB\x1b[0m",
        );
        let a = s.grid[0][0].attr;
        assert_eq!(a.flags, BOLD);
        assert_eq!(a.fg, RGB | 0xff000a);
        assert_eq!(a.bg, 5);
        assert_eq!(s.grid[0][1].attr.fg, RGB | 0x010203);
        feed(&mut s, &mut p, "\x1b[1;31;42m\x1b[K");
        assert_eq!(
            s.grid[0][5].attr,
            Attr {
                fg: 0,
                bg: 3,
                flags: 0
            }
        );
    }

    #[test]
    fn a_wide_character_takes_two_cells_and_wraps_rather_than_splitting() {
        let (mut s, mut p) = screen(5, 2);
        feed(&mut s, &mut p, "abcd漢");
        assert_eq!(row(&s, 0), "abcd");
        assert_eq!(s.grid[1][0].ch, '漢');
        assert_eq!((s.grid[1][0].width, s.grid[1][1].width), (2, 0));
        // Overwriting the second half blanks the first.
        feed(&mut s, &mut p, "\x1b[2;2Hx");
        assert_eq!(s.grid[1][0], Cell::BLANK);
    }

    #[test]
    fn the_terminal_answers_what_a_program_asks() {
        let (mut s, mut p) = screen(10, 5);
        feed(&mut s, &mut p, "\x1b[3;4H\x1b[6n\x1b[c");
        assert_eq!(s.replies, b"\x1b[3;4R\x1b[?62;22c");
    }

    #[test]
    fn a_bell_and_a_notification_are_both_a_call_for_the_reader() {
        let (mut s, mut p) = screen(10, 2);
        feed(&mut s, &mut p, "x\x07");
        assert!(std::mem::take(&mut s.bell));
        feed(&mut s, &mut p, "\x1b]9;waiting\x07");
        assert!(s.bell);
        // A clipboard write is not acted on, and is not a bell either.
        let (mut s, mut p) = screen(10, 2);
        feed(&mut s, &mut p, "\x1b]52;c;aGVsbG8=\x07");
        assert!(!s.bell);
    }

    /// A program that asks for the mouse, or goes to the alternate screen,
    /// draws nothing by doing so -- and the page still has to hear, since it
    /// is what decides where a turn of the wheel goes.
    #[test]
    fn asking_for_the_mouse_is_a_frame_of_its_own() {
        let (mut s, mut p) = screen(10, 3);
        let mut shown = Shown::new(10, 3);
        feed(&mut s, &mut p, "x");
        s.frame("p", &mut shown).unwrap();
        assert!(s.frame("p", &mut shown).is_none(), "nothing changed");
        let modes = |f: String| serde_json::from_str::<Value>(&f).unwrap()["m"].clone();
        feed(&mut s, &mut p, "\x1b[?1049h\x1b[?1000h\x1b[?1006h");
        assert_eq!(
            modes(s.frame("p", &mut shown).unwrap()),
            serde_json::json!([0, 0, 2, 1])
        );
        feed(&mut s, &mut p, "\x1b[?1006l");
        assert_eq!(
            modes(s.frame("p", &mut shown).unwrap()),
            serde_json::json!([0, 0, 1, 1])
        );
        feed(&mut s, &mut p, "\x1b[?1000l\x1b[?1049l");
        assert_eq!(
            modes(s.frame("p", &mut shown).unwrap()),
            serde_json::json!([0, 0, 0, 0])
        );
        assert!(s.frame("p", &mut shown).is_none());
    }

    /// Rule 1, as the spike found it: a resize must clear both sides or the
    /// page keeps text in cells the next diff thinks are already blank.
    #[test]
    fn a_resize_clears_both_sides_so_nothing_stale_survives() {
        let (mut s, mut p) = screen(20, 5);
        let mut shown = Shown::new(20, 5);
        let mut rep = Replica::new();
        feed(&mut s, &mut p, "1111111111111111\r\n22222\r\n333");
        pump(&mut s, &mut shown, &mut rep);
        s.resize(12, 4, &mut shown);
        feed(&mut s, &mut p, "\x1b[2J\x1b[Hfresh");
        pump(&mut s, &mut shown, &mut rep);
        s.resize(30, 6, &mut shown);
        pump(&mut s, &mut shown, &mut rep);
    }

    /// The spike's soak, in miniature: hostile bytes, frames after every
    /// chunk, resizes in between, and the replica compared cell for cell
    /// every time. A fixed seed so a failure is a failure that comes back.
    #[test]
    fn the_page_never_disagrees_with_the_screen_whatever_arrives() {
        let (mut s, mut p) = screen(40, 12);
        let mut shown = Shown::new(40, 12);
        let mut rep = Replica::new();
        let mut seed: u64 = 0x5eed_cafe;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let pieces: &[&str] = &[
            "hello ",
            "漢字",
            "\r\n",
            "\x1b[H",
            "\x1b[2J",
            "\x1b[K",
            "\x1b[1;31m",
            "\x1b[0m",
            "\x1b[38;2;1;2;3m",
            "\x1b[5;10H",
            "\x1b[3L",
            "\x1b[2M",
            "\x1b[4@",
            "\x1b[3P",
            "\x1b[5X",
            "\x1b[2;8r",
            "\x1b[r",
            "\x1bM",
            "\x1bD",
            "\x1b[?1049h",
            "\x1b[?1049l",
            "\x1b[2S",
            "\x1b[3T",
            "\t",
            "\x08",
            "\x1b7",
            "\x1b8",
            "\x1b[?7l",
            "\x1b[?7h",
            "\x1b[4h",
            "\x1b[4l",
            "0123456789abcdefghijklmnopqrstuvwxyz",
            "\x1b[J",
            "\x1b[1J",
            "\x1b[3J",
            "é",
            "\x1b#8",
            "\x1bc",
            "\x1b[?6h",
            "\x1b[?6l",
            "\x1b[99;99H",
        ];
        for step in 0..4000 {
            let n = (next() % 6) as usize + 1;
            let mut chunk = String::new();
            for _ in 0..n {
                chunk.push_str(pieces[(next() % pieces.len() as u64) as usize]);
            }
            // A sequence cut in half by a read, now and then.
            let bytes = chunk.as_bytes();
            let cut = (next() as usize) % (bytes.len() + 1);
            s.feed(&mut p, &bytes[..cut]);
            s.feed(&mut p, &bytes[cut..]);
            if step % 97 == 0 {
                let c = 5 + (next() % 60) as usize;
                let r = 2 + (next() % 20) as usize;
                s.resize(c, r, &mut shown);
            }
            if let Some(f) = s.frame("p", &mut shown) {
                rep.apply(&f);
            }
            if let Err(e) = rep.agrees(&s) {
                panic!("desync at step {step} after {chunk:?}: {e}");
            }
        }
    }

    /// A page arriving late starts from `shown`, not from the live screen, so
    /// it and a page that has been here all along hold the same thing after
    /// the next frame.
    #[test]
    fn a_page_that_arrives_late_agrees_with_one_that_was_here() {
        let (mut s, mut p) = screen(20, 4);
        let mut shown = Shown::new(20, 4);
        let mut early = Replica::new();
        feed(&mut s, &mut p, "a\r\nb\r\nc\r\nd\r\ne\r\nf");
        pump(&mut s, &mut shown, &mut early);
        feed(&mut s, &mut p, "\x1b[1;1Hchanged but not yet sent");
        let mut late = Replica::new();
        late.apply(&s.snapshot("p", &shown));
        assert_eq!(late.sb, early.sb);
        // One frame, sent to every page: the late one joined at `shown`, so
        // the frame that moves `shown` on is the one it needs.
        let f = s.frame("p", &mut shown).expect("the change goes out");
        early.apply(&f);
        late.apply(&f);
        early.agrees(&s).unwrap();
        late.agrees(&s).unwrap();
    }

    /// The cap is bytes and it holds, and what goes is whole lines from the
    /// front -- which is the answer to "what happens mid-line".
    #[test]
    fn scrollback_is_capped_in_bytes_by_dropping_whole_lines_from_the_front() {
        let (mut s, mut p) = screen(200, 5);
        let mut shown = Shown::new(200, 5);
        let line = "x".repeat(190);
        for i in 0..20_000 {
            feed(&mut s, &mut p, &format!("{i:06} {line}\r\n"));
            if i % 50 == 0 {
                s.frame("p", &mut shown);
            }
        }
        s.frame("p", &mut shown);
        assert!(s.scrollback_bytes() <= SCROLLBACK_BYTES);
        assert!(s.scrollback_bytes() > SCROLLBACK_BYTES - 1024);
        let first = s.scrollback.front().unwrap().text();
        assert!(first.len() == 197, "whole lines only: {first:?}");
        // One line bigger than the whole cap is cut, not refused.
        let (mut s, _) = screen(10, 2);
        s.keep_line(Line {
            runs: vec![("y".repeat(3 * 1024 * 1024), Attr::default())],
            wrapped: false,
        });
        assert_eq!(s.scrollback.len(), 1);
        assert!(s.scrollback_bytes() <= SCROLLBACK_BYTES);
    }

    /// The frame is the governor: a firehose between two frames is one frame,
    /// and the lines past what a frame carries are counted, not sent.
    #[test]
    fn a_firehose_between_frames_is_one_frame_with_a_gap() {
        let (mut s, mut p) = screen(40, 10);
        let mut shown = Shown::new(40, 10);
        let mut rep = Replica::new();
        pump(&mut s, &mut shown, &mut rep);
        for i in 0..5000 {
            feed(&mut s, &mut p, &format!("line {i}\r\n"));
        }
        let f = s.frame("p", &mut shown).unwrap();
        let v: Value = serde_json::from_str(&f).unwrap();
        let sent = v["sb"].as_array().unwrap().len();
        let gap = v["gap"].as_u64().unwrap() as usize;
        assert_eq!(sent, LINES_PER_FRAME);
        assert_eq!(sent + gap, 5000 - 9);
        rep.apply(&f);
        rep.agrees(&s).unwrap();
        assert!(f.len() < 64 * 1024, "one frame, bounded: {}", f.len());
    }

    /// An insert at the start of a wide character moves it right, whole: it
    /// is only lost when the cursor is in the middle of one.
    #[test]
    fn an_insert_keeps_the_wide_character_it_starts_on() {
        let (mut s, mut p) = screen(20, 2);
        feed(&mut s, &mut p, "ab中文\x1b[5G\x1b[2@");
        assert_eq!(s.text()[0], "ab中  文");
        feed(&mut s, &mut p, "\r\n中文\x1b[2G\x1b[1@");
        assert_eq!(s.text()[1], "   文");
    }
}
