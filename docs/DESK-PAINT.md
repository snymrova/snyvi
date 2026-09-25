# Desk paint cost: implementation plan

*2026-09-25. For new sessions to pick up one phase at a time.*

## Why this exists

The desk view makes the Linux window burn about **120% CPU** while agents work in its panels. Leaving the desk drops the window to about 15%. A perf profile of the live window's `WebKitWebProcess` (WebKitGTK 2.52.6, 8 s at 499 Hz, with debug symbols) shows:

| Main-thread time | Share |
|---|---|
| Painting the panes' layer | ~100% of the paint work |
| └ `RenderBox::paintMaskImages → SVGImage::draw` | **~40%** |
| └ `applyAncestorClippingForBorderRadius` / `clipRoundedRect` | ~10% |
| JavaScript: JIT code plus the DOM work of `paint()`'s handler | ~23–37% (the 2% first read here left out the JIT code; see Phase 0 results) |

- **What the masks are.** Every box-drawing, block and powerline cell is a span whose `::before` is masked by an SVG data URI: `ui/desk.js`, `drawn()` and `.pn-body .g::before { mask: var(--g) }`.
- **Why they're slow.** WebKitGTK does not cache these as pictures. For **each masked cell, on each paint**, it builds that glyph's SVG as a small document, runs `setFrameRect` and `performLayout` on it, then draws it. 496 of 582 layout samples were inside it.
- **What triggers the repaints.** The agents' spinners and timers produce about 25 frames a second. Each frame rewrites a row (`innerHTML` in `paint()`), which repaints the layer, which redraws every masked cell in it.
- **Ruled out by measurement:** the unread-note animations, the blinking caret (`pn-blink`), scrolling, and a `ResizeObserver` → `fit()` loop.

Others solve this the same way. xterm.js and VS Code draw box drawing themselves into a glyph atlas (`customGlyphs`) and paint on a canvas; their DOM renderer is the slow fallback. `mask-image` is the slowest SVG icon technique measured (Cloud Four: ~150 ms against ~70 ms for `<img>` per 1,000 icons). WebGL on WebKitGTK has known traps: a silent software fallback, and frames shown one frame late without the DMABUF renderer (Voltius, ~630 ms echo lag). Plain 2D canvas avoids both.

## Target

With **4 panes of working agents** on screen, the window's web process stays **under 15% CPU**, down from ~120%. That's measured the same way before and after (see Measuring). Nothing visible changes: box drawing still joins across rows and cells in every theme, at every terminal size and zoom.

## Ground rules for every session

- **Never touch the daily window or daemon on 7777.** Work in a test window on a spare port with `SNYVI_UI_DIR=<repo>/ui` (hot reload, no build needed for ui/) and scratch `SNYVI_DATA_DIR`, `SNYVI_CONFIG_DIR` and `HOME`. The recipe (private D-Bus session, `film/stage.mjs`) is in memory under *dev-loop-review*.
- **Batch changes.** Don't restart or rebuild after every edit; hand over for review when a phase is done.
- **Branch.** `ui/desk.js` has uncommitted theme work on `claude/desk-notes`. Check `git status` first and ask the user whether to branch from there or from `main` once that work has landed. Put the version bump in the work PR, with no extra release PR.
- **Keep the model.** `paint()` follows the same steps, in the same order, as the replica in `src/screen.rs`'s tests. Change **how** cells reach the screen, never **what** the cell grid holds.

## Measuring (do this first, every phase)

**Live-window recipe** (for the user's own window, read-only):
```
sudo sysctl kernel.perf_event_paranoid=1          # resets on reboot
P=/usr/lib/linux-tools-6.8.0-47/perf              # works on 6.8.0-139; the matching package is blocked by apt
$P record -F 499 -g -p <WebKitWebProcess pid> -o wk.data -- sleep 8
# symbols: curl -o webkit.debug https://debuginfod.ubuntu.com/buildid/<build-id>/debuginfo   (GET only; HEAD gives 400)
#   readelf -n /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.* | grep "Build ID"
#   mkdir -p sym/usr/lib/debug/.build-id/<xx>; ln -s $PWD/webkit.debug sym/usr/lib/debug/.build-id/<xx>/<rest>.debug
$P report -i wk.data --symfs=$PWD/sym --children --comm WebKitWebProces --sort sym --stdio -g none
```
CPU over time: sample `/proc/<pid>/stat` fields 14+15 once a second. Ticks per second equal % of one core.

## Phase 0: a repeatable measurement (one session)

Without a fixed load, every later number is guesswork. Build one.

1. **A load that looks like the real thing.** Write a small script (e.g. `bench/tui-load.sh` or a node script) to run in a panel. It draws a Claude-Code-like screen: a full-width `╭─…─╮ │ … │ ╰─…─╯` input box, `─` rules, block characters and a powerline prompt. It updates one spinner or timer line about 10 times a second and never scrolls. No real agent is needed, so the load is the same every run.
2. **A WebKitGTK row.** Add a desk row to `bench/webkit.py`, which already drives the page in a real WebKitGTK view under Xvfb, port 7798. It opens a desk with **4 panes** running that load and waits 3 s. Then it samples the web process's CPU for 10 s and reports the mean and p95. Find the web process as the child of the harness whose comm is `WebKitWebProces`. Xvfb draws with llvmpipe, so absolute numbers will differ from the real window. The **before/after ratio** is what counts.
3. **Record the baseline** on the current code, both in the harness and in the real test window: 4 panes, the perf recipe above. Write both numbers in the PR description.

**Done when** the harness prints a stable number (runs within ±10% of each other) and it's high on the current code.

### Phase 0 results (2026-09-25)

**The tools:**
- `bench/tui-load.mjs` is the load. `--hz` sets the spinner rate; the default is 10.
- `bench/desk-window.sh up | measure | profile | down` runs the **real window**. It starts a daemon on 7841 serving `ui/` from disk, one desk with 4 load panes, and `snyvi app` on a private bus, maximized.
  - `DESK_UI=<dir>` serves a copy of `ui/`, for a control.
  - `profile` runs perf and reads the result with `bench/perf-webkit.py`.
- `bench/perf-webkit.py wk.data webkit.debug` reads a perf recording. This perf segfaults in `perf report` whenever `--symfs` is given, so the script resolves `perf script` stacks against `nm` of the debug file.
  - **Use its main-thread sample count as the number.** perf samples only while the thread runs, so the count is main-thread CPU time and a busy machine distorts it far less than a percentage. At `-F 499` for 8 s, 1,996 samples is a full core.
- `xvfb-run -a -s "-screen 0 1920x1080x24" /usr/bin/python3 bench/webkit.py --desk --ui ui` is the headless row. Use `/usr/bin/python3`: the default `python3` here is miniconda, which has no GObject bindings.

**Baseline, real window** (1920×1080, 4 load panes, current code):

| Measure | Result |
|---|---|
| whole web process | 91–115% |
| main thread (perf samples) | 1,776–2,203, i.e. ~45–55% of a core |
| `SVGImage::draw` share of the main thread | 18–33% |
| `paintMaskImages` share of the main thread | ~22% |
| JS event handling (`JSEventListener::handleEvent`, including JIT code and the DOM work it causes) | 23–37% |

The doc's earlier "JavaScript 2%" missed the JIT code, which shows up under `perf-<pid>.map`, not `JSC::`.

**Controls, real window** (main-thread samples, 3 runs each):

| Variant | Runs | Change |
|---|---|---|
| current SVG masks | 2020, 2203, 1776 | |
| **one PNG as every glyph's mask** | 1116, 1433, 1317 | **about −35%** |
| masks removed (`content: none`) | 1358, 2326, 1223 | too noisy to use |

**So Phase 1 is worth doing.** The PNG control is roughly what Phase 1 produces, and it cut main-thread time by about a third. After that, JavaScript is about half of what's left, so `paint()`'s `innerHTML` row rewrites are the next thing to look at, before Phase 3.

**The Xvfb row is not a guide to Phase 1.** Its whole-process number is stable (118–130% over 5 runs), and its profile shows the same mask costs. But about half of that CPU is `SkiaGPUWorker`, llvmpipe rasterising in software, and there the PNG control made no difference (131% → 134%). Use the real window for before/after, and the Xvfb row as a smoke test and a rough ratio.

**Other notes:**
- The machine was loaded during all of this: 4 cores, load average 11–16, a `bun` process near 100%, and the daily window on a desk. Run before and after in the same sitting.
- Profile after the window has settled. The first real-window profile, taken soon after maximizing, showed 36% in `computeCompositingRequirements` and 60% in `updateLayout`. Six later profiles never showed that again.
- The harness's "find reaches its match" row fails, independent of this work: the committed harness fails it too, against both the committed and the working `ui/`.

## Phase 1: pre-render glyph masks (fix A, one session)

Stop WebKit rendering an SVG per cell. Keep the mask approach so colours, themes and `currentColor` still work, but make every mask a **bitmap**.

1. In `drawn(W, H)` (`ui/desk.js`, called when a cell is measured, around line 1397), draw each glyph once onto an `OffscreenCanvas`/`<canvas>` sized `W×H × devicePixelRatio`, instead of emitting `data:image/svg+xml` into `--g`. Use the same geometry: `LINES`, `BLOCKS`, the arcs `╭╮╯╰`, and the powerline paths, via `fillRect`, `arc` and `Path2D` with the existing path strings. Turn the result into a blob URL (`canvas.toBlob → URL.createObjectURL`) and set that as `--g`. Revoke the old URLs when `drawn()` runs again (size, zoom or DPR change).
2. `drawn()` is currently synchronous. Either keep the canvas drawing synchronous and produce data-URL PNGs with `toDataURL`, or produce blob URLs asynchronously and write the stylesheet once they are ready. If you go async, keep the SVG CSS until the swap so nothing flashes.
3. Re-run `drawn()` when `devicePixelRatio` changes (`matchMedia('(resolution: …)')`), so masks stay sharp after moving between monitors or zooming.
4. **Check the rendering by eye** in the test window, in every theme (`ui/themes.css`) and at each terminal size step. Checks: joins between rows, heavy vs light lines, rounded corners, shades `░▒▓`, partial blocks `▁…▇ ▏…▉`, and powerline separators against coloured backgrounds. Take before/after screenshots.
5. **Measure** with the Phase 0 harness and the perf recipe. `SVGImage::draw` should disappear from the profile.

**Done when** `SVGImage::draw` is gone, the harness number drops by a large margin, and the screenshots match.

## Phase 2: isolate each pane's paint (fix B, same session as 1 or the next)

1. Put each pane's live screen on its own compositing layer, so a frame in one pane stops repainting the others and the rounded-corner clip of `.pn` stops applying to every paint. Try, in order, measuring each:
   - `.pn-live { will-change: transform; }`, which puts the live grid alone on its own layer
   - `.pn-body { contain: paint; }` (or `contain: strict` if sizes allow), which isolates the scroller
   - if `applyAncestorClippingForBorderRadius` is still hot: move the clip off `.pn` (e.g. `clip-path: inset(0 round 6px)` on the pane, or radius on an outer wrapper with the scroller square inside)
2. Watch memory: one extra layer per pane, up to 4 visible. Run `bench/bytes.mjs` and check the resident row stays within budget. Memory notes *resident-row-over-budget* and *ui-panels-in-flight* explain why that row is sensitive.
3. **Measure** again.

**Done when** clipping has dropped out of the top of the profile and memory is within budget.

## Decision gate (after phases 1 and 2)

Measure with 4 working panes in the real test window.
- **Under 15%:** stop. Ship phases 1 and 2 as one PR with the before/after numbers, and update the *desk-svg-mask-cpu* memory.
- **Still over:** go on to Phase 3, and put the numbers in the handover so the next session knows what's left.

### Phases 1 and 2 results (2026-09-25)

In the tree, not committed. Real test window (`bench/desk-window.sh`), 4 panes of `tui-load.mjs`, runs alternated in one sitting, a run kept only when the window was painting:

| Variant | Whole process | Main thread | Main-thread samples / 8 s |
|---|---|---|---|
| Before (SVG masks) | 119, 123, 126% | 67–72% | 2015, 2322, 2163 |
| Phase 1 alone (PNG masks) | 89–148% | 40–55% | 2031–2474 |
| Phase 1 + layer CSS | 52, 69, 59% | 35–45% | 1395, 1819, 1551 |
| Phase 1 + layer CSS + no forced layout | 52, 67, 72% | 35–51% | 1362, 1567, 2149 |

- **Phase 1** (`drawn()` draws each glyph on a canvas at device pixels and hands CSS a PNG data URL, redrawn when `devicePixelRatio` changes): `SVGImage::draw` is gone. But alone it moved the work instead of removing it. The main thread fell ~20%, and `SkiaGPUWorker` rose from ~49% to ~65% to raster every masked cell on each repaint, so the whole process stayed flat.
- **Phase 2**: of three variants, the winner is `.pn-live { will-change: transform }` plus `.pn-scr > div { contain: strict }`. The live grid gets its own layer and each row is contained, so a spinner frame re-rasters its own row. Moving the rounded clip off `.pn` did worse, and it isn't in.
- **Forced layout in `paint()`**: every frame read `scrollTop`/`clientHeight`/`scrollHeight` and then wrote `scrollTop`. That forced a synchronous layout per frame per pane, and was 24–29% of the main thread. Now "pinned" is read on the body's `scroll` event, and `paint()` scrolls only when a frame can change the content's height (`sz`, `sb`, `gap`, `sbclear`). JS fell to ~6%, but the layout still happens once per display frame, so the main-thread total barely moved. The follow-at-bottom / hold-when-scrolled-up behaviour was checked in the WebKit harness.
- **The gate: ~60%, not under 15%.** What's left is `computeCompositingRequirements`, 35–43% of the main thread. Each masked `::before` is its own `RenderLayer`, and the compositor walks all of them on every update. The next step is either a glyph that isn't a mask, and so isn't a layer (a PNG per glyph and colour as a `background-image`, colours resolved from the theme), or Phase 3.
- **Not-painting state**: now and then the test window stops rendering updates (~13% CPU, no `RenderLayer::paint` in the profile). The runs above retried until it painted.

## Phase 3: 2D canvas for the live screen only (fix C, 2–3 sessions, only if the gate says so)

Draw only the **live grid** (the rows that change 25 times a second) on a `<canvas>`, the way xterm.js does. Scrollback (`.pn-sb`, `.pn-old`) stays DOM text, so selection, copy-on-select, find and the old-run greying keep working. Not WebGL, for the reasons above.

Design outline:
1. **Canvas and sizing.** Put a `<canvas>` in `.pn-live`, sized `cols × cellW` by `rows × LINE_PX`, times `devicePixelRatio`, and resized where `paint()` handles `f.sz`.
2. **Glyph atlas.** Draw each `(char, bold/italic, wide)` once into an offscreen atlas, as white on transparent, and colour it at draw time. For box, block and powerline characters, draw the shapes from the same geometry as Phase 1 (xterm.js's `customGlyphs` approach), so they tile exactly. Clear and rebuild the atlas on a font, size, DPR or theme change.
3. **Redraw only dirty rows.** `paint()` already knows which rows changed (`f.r`). For each one, fill its background runs, draw its glyphs from the atlas, and draw underline and strikethrough. Keep the `v.cells` model exactly as it is.
4. **Colours** come from the same resolution as `span()` and `color()`: theme variables read once per theme change, plus the accent for the prompt colour (`born`).
5. **Selection on the live screen.** Keep a transparent DOM text layer over the canvas: rows written as plain text, with no colour spans and no glyph spans. The browser's selection and copy-on-select (`copy()`) still work, and it stays cheap because there are no masks or styles. Or draw the selection on the canvas; that's harder, so keep the text layer unless measuring says otherwise.
6. **Cursor.** Keep the existing `.pn-caret` element on top.
7. **Rows leaving the live screen** go to `.pn-sb` as they do now (`runsHtml`). Those use the Phase 1 bitmap masks.
8. **Accessibility.** The text layer carries the content, and `role="region"` / `aria-label` stay on `.pn-body`.
9. **Tests.** The `src/screen.rs` replica tests still cover the cell model. Add Chromium (`bench/ui.mjs`) and WebKitGTK (`bench/webkit.py`) rows that compare canvas pixels against a known frame, e.g. the Phase 0 box. Add a row for wide and emoji characters, and one for selecting and copying across the live screen and the scrollback.

**Done when** the target is met in the real test window, nothing looks different, and selection, copy and find work across the live screen and the scrollback.

### Phase 3 results (2026-09-25)

In the tree, not committed. **The measure is the headless harness**, `xvfb-run -a -s "-screen 0 1400x1000x24" python3 bench/webkit.py --desk --ui ui`: 4 panes of `tui-load.mjs`, 40 frames a second reaching the page in every run. The user chose it as the north star; the real test window stalls whenever it is minimized or covered, and its readings were void more often than not. Runs alternated in one sitting:

| Variant | Whole process | Main thread per frame |
|---|---|---|
| Before (`/dev/shm/ui-before`, SVG masks) | 138, 139, 139, 140% | 16.2–16.7 ms |
| Phase 3 as in the tree | 14, 14, 14, 14% | 1.86–1.91 ms |

What is in `ui/desk.js`:
- **The live grid is a canvas** (`.pn-cv`, 2D, on the GPU), sized to the grid in device pixels. `drawRow` draws a row's grounds as one rectangle per run, then its text: runs of ordinary characters with `fillText` at the run's first cell, a character of its own (wide, or at or past U+2000) centred in its cells, and box, block and powerline characters from Phase 1's bitmaps, tinted per colour and cached (`MASK`, `TINT`). Colours come from `palette()`, the theme's tokens resolved on the pane, re-read when `data-theme` or `data-accent` changes.
- **Only what a frame changed is drawn.** A frame's `[y, x0, runs]` gives the cells; they are cleared a cell wider on each side and drawn from two cells further out, so a glyph reaching into its neighbour is whole. The bench checks this against the whole row drawn in the same task: 0 bytes differ.
- **The text over it** (`.pn-scr`, transparent) is the same rows with no colours and no drawn glyphs, for selection, copy and the caret's place. It catches up once a second (`TEXT_MS`), at once on `mousedown`, and never while a button is held. Rewriting it on every frame was a layout per frame.
- **The baseline** is CSS's: ascent and descent rounded, the room left over split with the odd pixel below. Snapshots of the old DOM and the canvas differ by 0.02–0.05 grey levels on average at all four sizes and in all eight themes, which is the ticking spinner.
- **The cell is measured again when the pane's font arrives** (`document.fonts.ready`, and `loadingdone`). Measured in the stand-in font, every cell was a pixel too wide at Large, in the old DOM renderer as well.
- **Smaller savings, each measured:** `.pn-body { contain: strict }`, so the text catching up lays out the pane and not the desk's grid; `textRendering = "optimizeSpeed"` and no kerning on the canvas; the caret written only when it moves.

Tried and dropped: a CPU canvas (`willReadFrequently`: 15–18%, raster moved to `SkiaGPUWorker`), and drawing every pane's changes together at most every 33 ms (20%, steadier but higher).

What is left, per frame: the GPU canvas's flush and its GL fence (~25% of the main thread), the JS of `paint()` with `fillText` (~18%), layout of the text catching up (~10%), and the compositor thread (~4% of a core). Now and then a run settles lower (9–10%), which is WebKit's, not the page's.

Tests: `bench/webkit.py` has seven canvas rows (placement, colours and drawn cells, a wide character, new frames and the text catching up, changed cells against a whole row, selection, every theme); `bench/ui.mjs` passes, the caret row included. The desk row now counts frames as the page parses them, since a canvas writes no rows into the page to count.

## Out of scope

- xterm.js itself: it parses a raw byte stream, and snyvi's daemon sends grid diffs (`src/screen.rs`). Switching would be a re-architecture, not a renderer swap.
- WebGL / WebGPU on WebKitGTK, until the silent software fallback and the late frames are solved upstream.
- Upgrading WebKitGTK to 2.54 (its masks are cheaper). It's worth knowing about, but it's the distribution's package, and it wouldn't remove the per-cell SVG cost anyway.

## Separate machine issues found in the same investigation (not for these sessions)

- The new 1 TB SSD (`sdb`) is an unused, out-of-date clone of the old hard drive (`sda`), with the same UUIDs. `/` still runs from the hard drive, which is why the disk sat at 94% busy.
- apt is blocked: `snyvi-app` 1.2.0 requires `snyvi` 1.2.0, but 1.4.0 is installed. Don't run `apt --fix-broken`.

## Sources

- [xterm.js WebGL renderer PR #1790](https://github.com/xtermjs/xterm.js/pull/1790)
- [xterm.js issue #3271](https://github.com/xtermjs/xterm.js/issues/3271)
- [xterm.js 4.19.0, custom glyphs](https://github.com/xtermjs/xterm.js/releases/tag/4.19.0)
- [VS Code terminal appearance](https://code.visualstudio.com/docs/terminal/appearance)
- [agentrq PR #611](https://github.com/agentrq/agentrq/pull/611)
- [agent-dashboard PR #131](https://github.com/dustinblack/agent-dashboard/pull/131)
- [Cloud Four SVG icon stress test](https://cloudfour.com/thinks/svg-icon-stress-test/)
- [WebKitGTK 2.54 highlights](https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html)
- [Voltius PR #313](https://github.com/VoltiusApp/voltius/pull/313)
- [Tauri Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)
